"""The pale inner face belongs to the helix, and stops where the helix does.

    python3 tests/richardson_tint.py            # 6MRR, both painters

Richardson mode lightens the INSIDE of a helix spiral - a drawing convention,
not a light-transport result - and which of the ribbon's two broad faces is the
inside is decided by the sign of the piece's own concavity (`oK`, averaged).
That sign is only meaningful where the ribbon is actually curving, and there is
one place in every structure where it is not: the interval a helix WINS at each
of its ends. `ssCls` hands a transition interval to the helix so the ribbon
leaving one does not wear a stub of loop colour - right for the colour, and it
hands the two-tone rule an interval that is half loop.

Measured on 6MRR: inside the four helices |kAvg| runs 0.717 to 0.975, and on
the sixteen transition pieces 0.012 to 0.666 - with the SIGN crossing zero
inside a single interval (58 runs -0.469, -0.187, +0.22, +0.417 over its four
pieces). So the pale face swapped sheets a quarter of the way along and the
tint landed on the outside of the turn: a pale patch in the loop leaving the
helix with a hard step across the ribbon. Reported by a reader, on this file.

WHAT IS MEASURED IS THE PICTURE, at two places whose answers must differ:

  * the MIDDLE of a helix must carry pale pixels - or every check below passes
    for a build that draws no two-tone at all, which is the mutation the ramp
    makes easy;
  * the first COIL residue after a helix must not, on the ribbon around it.

Both painters, because the decision is taken twice - `paintFace` in
cartoon/paint2d.js and the fragment shader's `twoNow` - and the whole reason
the amount is computed by one shared function (`richTintAmount`, with the
constants and the measurement above it in cartoon/geom.js) is that those two
answers may not drift apart.

A FLAT COLOUR, NOT THE ss PALETTE. Under ss colouring a transition interval is
drawn helix red, so a pale red tint on it is nearly invisible against the red
either side; the fault was reported from a uniformly coloured structure, where
the same patch is a white band on green. Colour the whole thing one hue and the
two faces are the only thing that can differ.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_richtint.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "6MRR.cif"

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
      // ONE HUE over the whole structure - see the header. `chain` on a
      // single-chain structure is the flattest thing the dropdown offers.
      const cs = document.getElementById('colorSelect');
      if (cs) { cs.value = 'chain'; cs.dispatchEvent(new Event('change')); }
      // THE PENCIL OFF. Its grain is fresh noise on every page load - a
      // measured 39,767 pixels of it on this canvas - laid over exactly the
      // faces being compared.
      r.drawMode = false;
      r.viewerState.rotationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      await settle();

      const sec = r._cartoonSec || '';
      R.sec = sec.length;
      // every helix, and the coil residue just past each of its ends
      const runs = [];
      for (let i = 0; i < sec.length; i++) {
        if (sec[i] !== 'H') continue;
        let k = i; while (k < sec.length && sec[k] === 'H') k++;
        if (k - i >= 5) runs.push([i, k - 1]);
        i = k;
      }
      R.helices = runs.length;

      // THE PIECE POLYGONS, COLLECTED ONCE ON THE 2D PATH AND USED FOR
      // BOTH PAINTERS. Lp/Lm/Rp/Rm are the piece's rails already projected,
      // so its quads are in hand - and the camera does not move between the
      // two renders, so the same polygons address the same faces in both
      // pictures. It has to be done here rather than inside the loop because
      // the GPU path RESTORES `_primProbe` around its capture (paintgl.js
      // keeps and puts back every probe flag), so asking it for prims gives
      // an empty list and every count reads zero.
      r.useGPU = false;
      r._primProbe = null;
      if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.invalidate();
      r.invalidate && r.invalidate();
      r.render('probe'); await settle(); await settle();
      const prims = r._primProbe || [];
      r._primProbe = undefined;
      R.prims = prims.length;
      // core: inside a helix. weak: a transition interval the helix won whose
      // own curvature is too faint to say which face is the inside. loop: the
      // floor, because a quad can be overdrawn by a piece in front of it and
      // a class that is never tinted says how much of that there is.
      const groups = {core: [], weak: [], loop: []};
      for (const g of prims) {
        if (g.kind !== 'rib') continue;
        const i = Math.floor(g.gs0 + 1e-6);
        let k = 0; for (const v of g.oK) k += v; k /= (g.oK.length || 1);
        const both = sec[i] === 'H' && sec[i + 1] === 'H';
        let cls = null;
        if (g.ss === 'H' && both) cls = 'core';
        else if (g.ss === 'H' && Math.abs(k) < 0.3) cls = 'weak';
        else if (g.ss === 'C') cls = 'loop';
        if (!cls) continue;
        const ns = g.Lp.length;
        for (let s = 0; s + 1 < ns; s++) {
          for (const [A, B] of [[g.Lp, g.Rp], [g.Lm, g.Rm]]) {
            groups[cls].push([A[s], B[s], B[s + 1], A[s + 1]]);
          }
        }
      }
      R.quads = {core: groups.core.length, weak: groups.weak.length,
                 loop: groups.loop.length};

      for (const gpu of [false, true]) {
        r.useGPU = gpu;
        if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.invalidate();
        r.invalidate && r.invalidate();
        r.render('tint'); await settle(); await settle(); await settle();
        const cv = r.canvas;
        const c2 = document.createElement('canvas');
        c2.width = cv.width; c2.height = cv.height;
        c2.getContext('2d').drawImage(cv, 0, 0);
        const im = c2.getContext('2d').getImageData(0, 0, cv.width, cv.height);
        r._ensurePickProjection();
        const sx = r.screenX; const sy = r.screenY;
        const dpr = cv.width / Math.max(1, cv.clientWidth);

        // THE BASE HUE, read off the drawing rather than from the palette:
        // shading moves every drawn colour off its table value, so "how far
        // toward white" has to be measured against what the OUTER face of
        // this structure actually came out as. The darkest inked pixel is it.
        let dark = null;
        for (let i = 0; i < im.data.length; i += 4) {
          if (im.data[i + 3] < 200) continue;
          const s = im.data[i] + im.data[i + 1] + im.data[i + 2];
          if (s > 720) continue;               // paper
          if (!dark || s < dark.s) dark = {s, r: im.data[i], g: im.data[i + 1], b: im.data[i + 2]};
        }
        // A PIXEL IS TINTED when it has travelled most of the way from that
        // hue to white ON THE CHANNEL THE HUE IS MISSING. Green here, so the
        // red channel: the outer face is ~90 and white is 255, and the tint
        // is 0.68 of the distance. Luminance alone cannot do it - the
        // highlight lifts every channel together and reads as pale.
        const lo = dark ? dark.r : 90;
        const isTint = (o) => im.data[o + 3] > 200
          && (im.data[o] - lo) > 0.45 * (255 - lo)
          && im.data[o + 1] > im.data[o];       // still the structure's hue
        const countAt = (pos, rad) => {
          if (pos == null || !sx || !sx[pos]) return null;
          const px = sx[pos] * dpr; const py = sy[pos] * dpr;
          let ink = 0; let tint = 0;
          for (let dy = -rad; dy <= rad; dy++) {
            for (let dx = -rad; dx <= rad; dx++) {
              const x = Math.round(px + dx); const y = Math.round(py + dy);
              if (x < 0 || y < 0 || x >= im.width || y >= im.height) continue;
              const o = (y * im.width + x) * 4;
              if (im.data[o + 3] < 200) continue;
              if (im.data[o] + im.data[o + 1] + im.data[o + 2] > 740) continue;
              ink++; if (isTint(o)) tint++;
            }
          }
          return {ink, tint};
        };

        const inQuad = (px, py, q) => {
          let hit = false;
          for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
            const a = q[i]; const b = q[j];
            if ((a[1] > py) !== (b[1] > py)
                && px < (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
          }
          return hit;
        };
        const scan = (quads) => {
          let ink = 0; let tint = 0;
          for (const raw of quads) {
            const q = raw.map((v) => [v[0] * dpr, v[1] * dpr]);
            let x0 = 1e9; let x1 = -1e9; let y0 = 1e9; let y1 = -1e9;
            for (const v of q) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]);
                                 y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
            for (let y = Math.ceil(y0) + 1; y <= Math.floor(y1) - 1; y++) {
              for (let x = Math.ceil(x0) + 1; x <= Math.floor(x1) - 1; x++) {
                if (x < 0 || y < 0 || x >= im.width || y >= im.height) continue;
                if (!inQuad(x + 0.5, y + 0.5, q)) continue;
                const o = (y * im.width + x) * 4;
                if (im.data[o + 3] < 200) continue;
                if (im.data[o] + im.data[o + 1] + im.data[o + 2] > 740) continue;
                ink++; if (isTint(o)) tint++;
              }
            }
          }
          return {ink, tint};
        };
        const core = scan(groups.core);
        const past = scan(groups.weak);
        const floor = scan(groups.loop);
        R.painters.push({gpu, base: dark && dark.r, core, past, floor});
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9793), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-richtint",
                      "--no-first-run", "--window-size=1000,1000",
                      "http://127.0.0.1:9793/_richtint.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-richtint", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
if not R.get("helices"):
    bad.append("no helix of five residues or more in the fixture")
for pt in R.get("painters") or []:
    who = "GPU" if pt["gpu"] else "2D "
    core, past, flr = pt["core"], pt["past"], pt["floor"]
    pc = 100.0 * past["tint"] / max(1, past["ink"])
    fc = 100.0 * flr["tint"] / max(1, flr["ink"])
    print(f"  {who} base red={pt['base']}  inside a helix"
          f" {core['tint']}/{core['ink']} tinted;"
          f" weak transition pieces {past['tint']}/{past['ink']} = {pc:.1f}%;"
          f" loop floor {flr['tint']}/{flr['ink']} = {fc:.1f}%")
    # THE CONTROL. Without it every assertion below passes for a build that
    # draws no pale face at all.
    if core["ink"] < 200:
        bad.append(f"{who}: only {core['ink']} inked pixels at the helix"
                   " middles - the structure is not where the probe looked")
    elif core["tint"] < 0.40 * core["ink"]:
        bad.append(f"{who}: only {core['tint']} of {core['ink']} pixels"
                   " inside the helices are tinted, against 52% on a correct"
                   " build - the pale inner face is going away, which is the"
                   " whole of what richardson mode draws")
    if past["ink"] < 200:
        bad.append(f"{who}: only {past['ink']} inked pixels at the coil"
                   " residues past the helices - nothing was measured")
    elif pc > fc + 3.0:
        bad.append(f"{who}: {pc:.1f}% of the pixels on a helix's weak"
                   f" transition pieces carry the pale inner tint against a"
                   f" {fc:.1f}% floor on the loops - the two-tone is leaking"
                   " past the helix, where the concavity that picks the face"
                   " means nothing. (The floor is not zero because a quad can"
                   " be overdrawn by a piece in front of it; what it may not"
                   " do is stand out above it.)")

pair = R.get("painters") or []
if len(pair) == 2:
    a, b = pair[0]["past"], pair[1]["past"]
    if (a["tint"] > 0) != (b["tint"] > 0):
        bad.append("the two painters disagree about whether the loop past a"
                   " helix is tinted - the amount is computed twice and the"
                   " two copies have drifted")

if bad:
    for m in bad:
        print("FAIL: " + m)
    sys.exit(1)
print("  the pale face is the helix's, and stops where the helix does")
