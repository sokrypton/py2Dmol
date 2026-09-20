"""A side chain's oxygen is red on both painters, and `halves` is shared.

    python3 tests/element_halves.py [3PTB.cif]

A bond between a carbon and a heteroatom is drawn as two halves - the carbon
end takes the residue's colour, the far end its element's - and on the GPU the
far end reads slot 2 of its segment's three palette texels. The RIBBON's colour
cut writes into the same three texels, because a ribbon interval is also cut in
two and its far half is the next residue's colour.

They never collide on their own: a backbone bond is carbon to carbon, so
nothing ever fills an element half for one. They collide the moment something
writes halves for EVERY segment in the list, which is what centring the ribbon
colours on their residues first did - `resolveSegmentColors` walked all of
them - and then every side-chain bond's element half was overwritten with the
backbone answer. Reported as the side chains losing their element colours.

WHY IT TAKES A NEW PROBE. `tests/session_elements.py` reads the segment colour
ARRAY, which core/mol.js fills and nothing here touches; it reported 202 bonds
in two colours with the fault fully present. And the 2D painter is not affected
at all - it carries each prim's own colours and never consults the palette - so
the fault is exactly the difference between the two painters, which is what
this measures. That also means it needs no absolute threshold: the 2D picture
IS the control, on the same structure, in the same page.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_elhalves.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "3PTB.cif"

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {painters: []};
    try {
      const P = new URLSearchParams(location.search);
      await load(P.get('f')); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.styleChosen = true;
      r.setStyle('richardson');
      // ONE HUE for the structure, so an element colour is the only thing on
      // the canvas that is not it. `chain` is the flattest the dropdown has.
      const cs = document.getElementById('colorSelect');
      if (cs) { cs.value = 'chain'; cs.dispatchEvent(new Event('change')); }
      r.drawMode = false;
      if (r.showSidechains) r.showSidechains();
      await settle(); await settle();
      R.sidechains = r.coords ? r.coords.length : 0;

      for (const gpu of [false, true]) {
        r.useGPU = gpu;
        if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.invalidate();
        r.invalidate && r.invalidate();
        r.render('el'); await settle(); await settle(); await settle();
        const cv = r.canvas;
        const c2 = document.createElement('canvas');
        c2.width = cv.width; c2.height = cv.height;
        c2.getContext('2d').drawImage(cv, 0, 0);
        const im = c2.getContext('2d').getImageData(0, 0, cv.width, cv.height);
        let red = 0; let blue = 0; let ink = 0;
        for (let o = 0; o < im.data.length; o += 4) {
          if (im.data[o + 3] < 200) continue;
          const cr = im.data[o]; const cg = im.data[o + 1]; const cb = im.data[o + 2];
          if (cr + cg + cb > 740) continue;              // paper
          ink++;
          // the structure is green, so oxygen's red and nitrogen's blue are
          // the two channels it cannot have
          if (cr > cg + 25 && cr > cb + 25) red++;
          if (cb > cg + 15 && cb > cr + 15) blue++;
        }
        R.painters.push({gpu, ink, red, blue});
      }
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9805), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-elhalves",
                      "--no-first-run", "--window-size=900,900",
                      "http://127.0.0.1:9805/_elhalves.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-elhalves", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
by = {p["gpu"]: p for p in R.get("painters") or []}
for gpu in (False, True):
    p = by.get(gpu)
    if not p:
        bad.append(("GPU" if gpu else "2D") + ": nothing measured")
        continue
    print(f"  {'GPU' if gpu else '2D '}: {p['ink']} inked px,"
          f" {p['red']} oxygen-red, {p['blue']} nitrogen-blue")

cpu, gpu = by.get(False), by.get(True)
if cpu and gpu:
    # THE 2D PICTURE IS THE CONTROL, and it needs its own: a structure with no
    # side chains out has no heteroatom to colour and every ratio below is 0/0.
    if cpu["red"] < 300 or cpu["blue"] < 100:
        bad.append(f"the 2D painter itself drew only {cpu['red']} red and"
                   f" {cpu['blue']} blue pixels - the side chains are not out,"
                   " or element colouring is off, so there is nothing to score")
    else:
        for ch in ("red", "blue"):
            if gpu[ch] < 0.5 * cpu[ch]:
                bad.append(f"the GPU drew {gpu[ch]} {ch} pixels against the 2D"
                           f" painter's {cpu[ch]} on the same structure - a side"
                           " chain's element halves are being overwritten in the"
                           " palette, which is the ribbon's colour cut writing"
                           " into a segment that is not a ribbon")

if bad:
    for m in bad:
        print("FAIL: " + m)
    sys.exit(1)
print("  both painters give a side chain's heteroatoms their element colours")
