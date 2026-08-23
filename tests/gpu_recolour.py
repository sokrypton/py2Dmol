"""A colour change repaints the GPU mesh; it does not rebuild it.

    python3 tests/gpu_recolour.py            # 1EHZ, a small RNA
    python3 tests/gpu_recolour.py 4UG0.cif   # a ribosome

The cartoon's GPU mesh carries a palette INDEX per face, so changing the colour
scheme is three texels per segment against geometry that never moves. A face
whose colour did not come from the palette has to bake it instead - and one
baked face makes the whole mesh ineligible, because there is no way to repaint
it from a new palette.

Nucleic BASE RUNGS were baked: their colour is `colors[bbSeg[i]]`, a palette
lookup like any other, but the index was not recorded. So every colour change
on any structure with a base pair in it rebuilt the entire mesh - 21,744 of
167,824 faces on 4UG0, and 950 ms against the 30 ms an upload costs.

What this checks:

  * no face is baked, so the cheap path is available at all;
  * a colour change does not rebuild the mesh, and is fast;
  * THE PICTURE IS THE SAME as the one a full rebuild draws - pixel for pixel,
    in each mode, which is what catches a rung repainted from the wrong slot;
  * and the cases that MUST rebuild still do: ss mode cuts geometry at the
    midpoint between two colours, and a per-residue override does the same.
"""
import base64, http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_recolour.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "1EHZ.cif"

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const go = async () => {
    const R = {modes: []};
    try {
      await load(new URLSearchParams(location.search).get('f'));
      await wait(2500);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = true;
      r.styleChosen = true;
      r.setStyle('cartoon');
      await wait(2500);
      R.n = r.coords.length;
      R.gpuDrew = r.gpuDrewLastFrame;
      const sel = document.getElementById('colorSelect');
      const setMode = async (m) => {
        sel.value = m; sel.dispatchEvent(new Event('change'));
        await wait(700);
      };
      const shot = () => r.canvas.toDataURL('image/png');
      const rebuiltAt = () => (window.__rebuild ? window.__rebuild.t0 : 0);

      for (const mode of ['chain', 'rainbow', 'plddt', 'auto']) {
        // ...the cheap way: whatever mesh is up, repainted
        let t0 = rebuiltAt();
        const t = performance.now();
        await setMode(mode);
        const ms = performance.now() - t;
        const rebuilt = rebuiltAt() !== t0;
        const cheap = shot();
        // ...and the same mode from a mesh built for it
        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild');
        await wait(700);
        const fresh = shot();
        R.modes.push({mode, ms: Math.round(ms), rebuilt, same: cheap === fresh,
                      pal: window.__palComplete});
      }

      // ...AND THE TWO THAT MUST REBUILD, because the colour is geometry there:
      // ss mode cuts an interval at the midpoint between two colours, and a
      // per-residue override does the same.
      let t0 = rebuiltAt();
      await setMode('ss');
      R.ssRebuilt = rebuiltAt() !== t0;
      await setMode('auto');
      t0 = rebuiltAt();
      const o = r.objectsData[r.currentObjectName];
      o.color = {type: 'advanced', value: {position: {3: '#ff0000'}}};
      r._invalidateSegmentCache();
      r.render('override');
      await wait(700);
      R.overrideRebuilt = rebuiltAt() !== t0;
      R.overrideShot = shot();
      window.py2dmolCartoonGPU.invalidate();
      r.render('forced rebuild');
      await wait(700);
      R.overrideSame = R.overrideShot === shot();
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
src = open(os.path.join(ROOT, "index.html")).read()
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9751), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-recolour",
                      "--no-first-run", "--window-size=900,900",
                      f"http://127.0.0.1:9751/_recolour.html?f={FILE}"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + 300
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-recolour", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"{FILE}: {R.get('n')} positions, drawn on the GPU: {R.get('gpuDrew')}")
bad = []
if not R.get("gpuDrew"):
    bad.append("the GPU path did not draw, so nothing here was measured")
for m in R["modes"]:
    print(f"  {m['mode']:8s} {m['ms']:>5} ms  rebuilt={m['rebuilt']}"
          f"  identical to a rebuild={m['same']}  palette complete={m['pal']}")
    if not m['pal']:
        bad.append(f"{m['mode']}: the mesh has baked faces, so no colour change"
                   " can be an upload")
    if m['rebuilt']:
        bad.append(f"{m['mode']}: the colour change rebuilt the mesh")
    if not m['same']:
        bad.append(f"{m['mode']}: the repainted picture differs from the one a"
                   " rebuild draws - a face is reading the wrong palette slot")
print(f"  ss mode rebuilt: {R.get('ssRebuilt')};"
      f" an override rebuilt: {R.get('overrideRebuilt')}"
      f" (and matches a rebuild: {R.get('overrideSame')})")
if not R.get("ssRebuilt"):
    bad.append("ss mode did not rebuild - it cuts intervals at the midpoint"
               " between two colours, so the geometry itself changes")
if not R.get("overrideRebuilt"):
    bad.append("a per-residue override did not rebuild, for the same reason")
if not R.get("overrideSame"):
    bad.append("the override's picture differs from a rebuild's")
for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
