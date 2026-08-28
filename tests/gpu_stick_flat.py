"""A preset that asks for FLAT gets flat SIDE CHAINS, without touching a knob.

    python3 tests/gpu_stick_flat.py            # 6MRR on dev.html
    python3 tests/gpu_stick_flat.py 1UBQ.cif

Plain cartoon (`ribbon`) sets thickness 0 because flatness IS its look, and
geom.js reads that as "the preset wants flat sticks too" - the one preset value
that reaches a side chain, every other one leaving it at the ligand's own
section. The test is `thickness === 0`.

🔴 THE GPU FLOORS THAT VALUE BEFORE geom EVER SEES IT. paintgl raises
cartoonThickness to GPU_RIBBON_THICK (0.05 A) so every ribbon piece is a closed
solid, and restores it after the capture - so the stick rule asked its question
of 0.05, got false, and gave every side chain LIGAND_TH_DEFAULT: fat 3D side
chains standing in flat ribbons. On the GPU only, because the 2D painter has no
such floor, and only until the Thickness slider was DRAGGED, because a drag sets
_thicknessUserSet and that branch reads the value directly. Reported as "in
ribbon the side chains are not 0 thickness even though the knob says 0, and
moving the slider fixes it".

The probe asks the question the reader asked: with the knob untouched at 0, the
picture must be the one you get with the latch forced on - byte for byte. A
control run at 0.5 must differ, or the assertion would pass against a viewer
that draws no side chains at all.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_gpustickflat.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "6MRR.cif"

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const R = {};
  let posted = false;
  const post = () => { if (posted) return; posted = true;
    fetch('/result', {method: 'POST', body: JSON.stringify(R)}); };
  setTimeout(post, 90000);
  const go = async () => {
    try {
      const P = new URLSearchParams(location.search);
      await load(P.get('f'));
      await until(() => window.py2dmol_viewers
        && Object.keys(window.py2dmol_viewers).length, 30000);
      const r = window.py2dmol_viewers[Object.keys(window.py2dmol_viewers)[0]].renderer;
      await until(() => r.coords && r.coords.length > 50, 30000);
      await settle();
      r.useGPU = true;
      // ...the reader's own route: the Style dropdown, Select all, the panel's
      // side-chain button. Nothing here touches the Thickness slider.
      const styleSel = document.getElementById('styleSelect');
      styleSel.value = 'ribbon';
      styleSel.dispatchEvent(new Event('change', {bubbles: true}));
      await settle(); await settle();
      document.getElementById('selectAllResidues').click();
      await settle();
      document.getElementById('sidechainShowButton').click();
      await settle(); await settle(); await settle();
      R.knob = document.getElementById('thicknessSlider').value;
      R.field = r.cartoonThickness;
      R.preset = r.stylePreset || '';
      R.gpu = !!r.useGPU;
      const png = () => r.canvas.toDataURL('image/png');
      const rebuild = async () => {
        if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.invalidate();
        if (r._invalidateSegmentCache) r._invalidateSegmentCache();
        r.reloadDrawn(); r.render('probe');
        await settle(); await settle();
      };
      R.asDrawn = png();
      // ...and a control, so "identical" cannot mean "nothing is drawn".
      r.cartoonThickness = 0.5;
      await rebuild();
      R.thick = png();
      r.cartoonThickness = 0;
      await rebuild();
      // 🔴 AND A DRAG IN ANOTHER LOOK CANNOT FOLLOW, because there is nothing
      // to follow: switching replaces the value with the new look's own, and
      // the value IS the question. Richardson's 0.7 in ribbon would be a
      // choice - the point is that a switch never leaves it there.
      r.setStyle('3d');
      await settle(); await settle();
      R.at3d = r.cartoonThickness;
      r.setStyle('ribbon');
      await settle(); await settle();
      R.backAtRibbon = r.cartoonThickness;
      await rebuild();
      R.afterSwitch = png();
    } catch (e) { R.error = String(e && e.stack || e); }
    post();
  };
  go();
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS)
src = open(os.path.join(ROOT, "dev.html")).read()
stamp = str(int(time.time() * 1000))
src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
             lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
open(PROBE, "w").write(src.replace("</body>", JS + "</body>"))
box = []


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9773), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-gpustickflat",
                      "--no-first-run", "--window-size=1100,900",
                      "http://127.0.0.1:9773/_gpustickflat.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# ...WITH ITS OWN BUDGET. Six legs, two structures and a dozen camera flights
# to wait out: 15 s alone against the shared 30, which the parallel UI lane
# doubles often enough to fail as "no result posted" - a timeout wearing a
# crash's clothes. The legs are the point, so the budget moves.
end = time.time() + DEADLINE * 2
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-gpustickflat", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
if R.get("error"):
    sys.exit("page error: " + R["error"])
print(f"  knob {R.get('knob')!r}, cartoonThickness {R.get('field')},"
      f" preset {R.get('preset')!r}, gpu {R.get('gpu')}")
if not R.get("gpu"):
    bad.append("the GPU painter is not the one drawing, so this probe measures"
               " the path that never had the fault")
if R.get("preset") != "ribbon":
    bad.append(f"the viewer is showing {R.get('preset')!r}, not ribbon - it is"
               " ribbon's own 0 that has to reach the side chains")
if R.get("field") != 0:
    bad.append(f"cartoonThickness is {R.get('field')}, not 0 - the ribbon preset"
               " is what asks for flat and this is not it")

def npx(a, b):
    import base64, io
    try:
        from PIL import Image
        import numpy as np
    except Exception:
        return None
    def im(u):
        return np.asarray(Image.open(io.BytesIO(
            base64.b64decode(u.split(",", 1)[1]))).convert("RGB")).astype(int)
    return int((abs(im(a) - im(b)).sum(axis=2) > 8).sum())

# WHAT PIXELS CAN HONESTLY SAY. The floor is applied inside the capture and
# cleared in its `finally`, so "the same value, other branch" cannot be staged
# from out here: setting _thickAsAsked by hand is overwritten by the next
# capture, and 0 against 0.05 moves the ribbon SLAB, which is what the floor is
# for. That case is a call rather than a picture - tests/smoke.js asks
# py2dmolCartoon.thicknessIsChosen directly, the floor among its ten cases.
ctrl = npx(R.get("asDrawn", ""), R.get("thick", ""))
exact = ctrl is not None
if not exact:
    ctrl = 0 if R.get("asDrawn") == R.get("thick") else 1
unit = "px" if exact else "(differs)"
print(f"  the knob still moves the picture: {ctrl} {unit}")
if ctrl == 0:
    bad.append("thickness 0.5 draws the same picture as 0, so this probe cannot"
               " see a stick get thicker and proves nothing")

sw = npx(R.get("asDrawn", ""), R.get("afterSwitch", ""))
if sw is None:
    sw = 0 if R.get("asDrawn") == R.get("afterSwitch") else 1
print(f"  3d gave thickness {R.get('at3d')}, back in ribbon"
      f" {R.get('backAtRibbon')}, {sw} {unit} from the flat picture")
if R.get("at3d") == R.get("backAtRibbon"):
    bad.append(f"3d and ribbon both came out at {R.get('at3d')} - the two looks"
               " have to disagree about thickness or this leg tests nothing")
if R.get("backAtRibbon") != 0 or sw:
    bad.append(f"after 3d and back, ribbon is at {R.get('backAtRibbon')} and"
               f" {sw} pixels from the flat picture. A switch replaces the value"
               " with the look's own, which is what makes the leak impossible -"
               " a thickness left over from another preset reads as the reader's"
               " choice and puts solid side chains in flat ribbons")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
