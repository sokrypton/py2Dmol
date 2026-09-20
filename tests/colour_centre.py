"""A colour belongs to a residue, so its band is centred on that residue.

    python3 tests/colour_centre.py [1TIM.cif]

An interval spans two residues and `colors[seg]` is the FIRST one's colour, so
a ribbon interval drawn in one colour puts the band from i to i+1 - half a
residue downstream of the thing it describes. The cartoon already cut the
interval at its midpoint and gave each half its own end's colour, but only
under per-residue overrides or in ss colouring; every colour MODE (pLDDT,
hydrophobicity, chain, rainbow, entropy) fell back to `colFar = col` and drew
the whole interval in the near residue's colour.

HOW IT IS MEASURED. Rainbow colouring is monotone along the chain, so the hue
of a pixel names a residue. For every residue the probe reads the pixel at that
residue's own projected point and asks whose hue it is; the answer is an
OFFSET, and the shape of its histogram is the claim:

  * centred on the residue -> a tall spike at 0, because the residue sits in
    the middle of its own band;
  * half a residue late -> the residue sits ON a boundary, so the samples split
    between 0 and -1.

Measured on 1TIM, both painters, before and after: 0 against -1 went 154:122
and 174:123 (a ratio of 1.3 and 1.4) to 209:29 and 234:25 (7.2 and 9.4).

NOT THE ABSOLUTE MEAN, which carries an instrument bias of about +0.26: the
sample point is the alpha carbon and the ribbon is drawn through a SMOOTHED
axis, so the two are a fraction of a residue apart wherever the chain curves.
That bias is the same in both arms - what moved is the shape.

A RATIO, NOT A COUNT, for the same reason the tint probe measures against a
floor: how many residues are visible at all depends on the camera.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, check_js
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_colcentre.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "1TIM.cif"

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {};
    try {
      const P = new URLSearchParams(location.search);
      await load(P.get('f')); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.styleChosen = true;
      r.setStyle('richardson');
      const cs = document.getElementById('colorSelect');
      if (cs) { cs.value = 'rainbow'; cs.dispatchEvent(new Event('change')); }
      r.drawMode = false;
      r.viewerState.rotationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      await settle();
      const hueOf = (cr, cg, cb) => {
        const mx = Math.max(cr, cg, cb); const mn = Math.min(cr, cg, cb);
        const d = mx - mn;
        if (d < 1e-6) return -1;
        let h;
        if (mx === cr) h = ((cg - cb) / d) % 6;
        else if (mx === cg) h = (cb - cr) / d + 2;
        else h = (cr - cg) / d + 4;
        h *= 60; if (h < 0) h += 360;
        return h;
      };
      for (const gpu of [false, true]) {
        r.useGPU = gpu;
        if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.invalidate();
        r.invalidate && r.invalidate();
        r.render('lag'); await settle(); await settle(); await settle();
        const cv = r.canvas;
        const c2 = document.createElement('canvas');
        c2.width = cv.width; c2.height = cv.height;
        c2.getContext('2d').drawImage(cv, 0, 0);
        const im = c2.getContext('2d').getImageData(0, 0, cv.width, cv.height);
        r._ensurePickProjection();
        const sx = r.screenX; const sy = r.screenY;
        const dpr = cv.width / Math.max(1, cv.clientWidth);
        const n = r.coords.length;
        const pal = [];
        for (let i = 0; i < n; i++) {
          const c = r.getAtomColor ? r.getAtomColor(i) : null;
          pal.push(c ? hueOf(c.r, c.g, c.b) : -1);
        }
        // the ribbon's hue changes monotonically along a rainbow, so a
        // half-residue shift is a measurable offset in WHICH residue's hue
        // the pixel at residue i carries.
        let sum = 0; let cnt = 0; const hist = {};
        for (let i = 2; i < n - 2; i++) {
          if (!sx || !sx[i]) continue;
          const x = Math.round(sx[i] * dpr); const y = Math.round(sy[i] * dpr);
          if (x < 1 || y < 1 || x >= im.width - 1 || y >= im.height - 1) continue;
          const o = (y * im.width + x) * 4;
          if (im.data[o + 3] < 200) continue;
          if (im.data[o] + im.data[o + 1] + im.data[o + 2] > 740) continue;
          const h = hueOf(im.data[o], im.data[o + 1], im.data[o + 2]);
          if (h < 0) continue;
          // nearest palette residue WITHIN a window, so an occluded sample
          // (a different part of the chain in front) is dropped rather than
          // dragging the mean
          let best = -1; let bd = 1e9;
          for (let j = i - 6; j <= i + 6; j++) {
            if (j < 0 || j >= n || pal[j] < 0) continue;
            let d = Math.abs(pal[j] - h); if (d > 180) d = 360 - d;
            if (d < bd) { bd = d; best = j; }
          }
          if (best < 0 || bd > 12) continue;
          const off = best - i;
          sum += off; cnt++;
          hist[off] = (hist[off] || 0) + 1;
        }
        R[gpu ? 'gpu' : 'cpu'] = {n: cnt, mean: +(sum / Math.max(1, cnt)).toFixed(3), hist};
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9803), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-colcentre",
                      "--no-first-run", "--window-size=1000,1000",
                      "http://127.0.0.1:9803/_colcentre.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + 300
while not box and time.time() < end: time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-colcentre", ignore_errors=True)
R = box[0] if box else {"error": "no result"}
if R.get("error"): sys.exit("page error: " + R["error"])

bad = []
for k in ("cpu", "gpu"):
    d = R.get(k)
    if not d:
        bad.append(f"{k}: nothing measured")
        continue
    h = {int(o): c for o, c in d["hist"].items()}
    on = h.get(0, 0)
    late = h.get(-1, 0)
    print(f"  {k}: {d['n']} residues sampled, mean offset {d['mean']:+}"
          f"   on the residue {on}, one early {late}"
          f"   ({on / max(1, late):.1f}x)")
    if d["n"] < 150:
        bad.append(f"{k}: only {d['n']} residues gave a usable sample - the"
                   " structure is not where the probe looked, or rainbow"
                   " colouring did not take")
    elif on < 2.5 * max(1, late):
        bad.append(f"{k}: {on} samples land on the residue's own colour against"
                   f" {late} on the one before it ({on / max(1, late):.1f}x,"
                   " and a correct build is over 7x) - the band is not centred"
                   " on its residue, so every colour mode is drawing half a"
                   " residue downstream of the data")

if bad:
    for m in bad:
        print("FAIL: " + m)
    sys.exit(1)
print("  the colour band is centred on the residue it describes")
