"""Colouring a few residues by hand must not recolour the whole structure.

    python3 tests/plddt_override.py [1UBQ.cif]

🔴 A SECOND ANSWER TO "WHAT COLOUR IS THE FAR HALF", REACHED ONLY WHEN AN
OVERRIDE EXISTED. An interval spans two residues and is drawn in two halves:
`colors[segIdx]` for this end and the NEXT segment's colour for the other.
`cartoon/geom.js` said that twice - once in the general expression, and again
in an `else if (hasColorOverrides)` branch that reassigned
`colFar = renderer.getAtomColor(iN)`.

The two agree wherever a segment's colour IS its first residue's. They do NOT
agree in plddt/deepmind, where `_calculatePlddtColors` gives a backbone segment
the AVERAGE of its two ends - so the moment any residue carried a manual
colour, every OTHER interval in the picture switched from the averaged ramp to
the un-averaged one. Reported as a custom colour not taking in pLDDT mode: what
a reader sees is the whole structure shifting while the residues they picked
are a small part of it.

WHAT THIS MEASURES, and why it is pixels rather than the colour array: the
ARRAY was always right. Exactly eleven segments move to the colour asked for,
in every mode - measured. The fault is downstream of it, in what the painter
does with the rest of them, and only the canvas can see that.

  * the same eleven residues are coloured in chain mode and in plddt mode;
  * the number of pixels that CHANGE must be about the same either way -
    mutated back it is 8,763 against 834 on AF-Q5VSL9 and 3,279 either way
    here, which is why this probe writes its own pLDDT ramp (see below);
  * and most of what changed must be the colour that was asked for, so that
    "nothing moved" cannot pass.

🔴 IT WRITES ITS OWN pLDDT, because a crystal structure cannot show this.
1UBQ's B-factors sit almost entirely inside one band of the pLDDT ramp, so the
average of two residues and either residue alone are the SAME colour and the
bug is invisible: measured 3,279 changed pixels either way, mutated or not. A
ramp from 20 to 100 across the chain crosses every band and makes neighbours
differ, which is what a real AlphaFold model looks like.

🔴 AND pLDDT IS THE DISCRIMINATING MODE, NOT deepmind. The DeepMind ramp is
four broad bands, so averaging two neighbours usually lands in the same band
and the fault moves 3,279 pixels to 3,673 - inside this probe's slack. The
continuous ramp is where it shows: 3,278 against 10,937. deepmind is measured
beside it because the same branch serves both and its share of asked-for
colour still moves, not because it would fail on its own.

🔴 AND THE BASELINE HAS TO BE STABLE. Every earlier attempt at this measured a
settling picture - a mode change on a large structure is not finished when the
next frame is - and reported the settling as the effect. `stable()` waits for
two identical frames before it believes one.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_plddt_override.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"

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
      await load(window.__file); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      // The 2D painter, so this is about the geometry pass rather than about
      // a palette upload. The same branch feeds both.
      r.useGPU = false;
      // ...a pLDDT that crosses the ramp's bands, which a crystal structure
      // does not. Written onto the frame AND the renderer, because the frame
      // is what a reload would read back.
      const obj = r.objectsData[r.currentObjectName];
      const n = r.coords.length;
      const ramp = Array.from({length: n}, (_, i) => 20 + (80 * i) / Math.max(1, n - 1));
      if (obj.frames && obj.frames[0]) obj.frames[0].plddts = ramp;
      r.plddts = ramp;
      R.bands = new Set(ramp.map((v) => Math.floor(v / 10))).size;

      const sel = document.getElementById('colorSelect');
      const raw = () => { const cv = r.canvas;
        return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data.slice(0); };
      const same = (a, b) => { for (let i = 0; i < a.length; i += 4) {
        if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) return false; }
        return true; };
      const stable = async (tries = 20) => {
        let prev = raw();
        for (let k = 0; k < tries; k++) {
          await new Promise((s) => setTimeout(s, 120));
          await settle(3);
          const now = raw();
          if (same(prev, now)) return now;
          prev = now;
        }
        return null;
      };
      const setMode = async (m) => { sel.value = m;
        sel.dispatchEvent(new Event('change', {bubbles: true})); };
      const RESIDUES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
      const paint = async () => {
        r.setResidueSelection(new Set(RESIDUES));
        await settle();
        document.getElementById('selColorButton').click(); await settle();
        const cells = Array.from(document.querySelectorAll('#selColorMenu .selection-color-cell'));
        const cell = cells.find((c) => /\\(0,\\s*255,\\s*0\\)/.test(c.style.background));
        if (!cell) throw new Error('no green cell in the palette');
        cell.click(); await settle();
        // ...and the mark off, so the selection halo is not the difference.
        r.clearResidueSelection();
      };
      const clear = async () => {
        obj.color = null; r.clearResidueSelection();
        r.colorsNeedUpdate = true; r.plddtColorsNeedUpdate = true;
        r.render('probe clear');
      };
      const score = (before, after) => {
        let changed = 0, green = 0;
        for (let i = 0; i < before.length; i += 4) {
          if (before[i] === after[i] && before[i+1] === after[i+1]
              && before[i+2] === after[i+2]) continue;
          changed++;
          if (after[i] < 160 && after[i+1] > 170 && after[i+2] < 160) green++;
        }
        return {changed, green, greenShare: changed ? +(green / changed).toFixed(2) : 0};
      };
      for (const mode of ['chain', 'plddt', 'deepmind']) {
        await clear(); await setMode(mode);
        const before = await stable();
        if (before === null) { R[mode] = {error: 'the picture never settled'}; continue; }
        await paint();
        const after = await stable();
        if (after === null) { R[mode] = {error: 'never settled after the colour'}; continue; }
        R[mode] = score(before, after);
        // The colour ARRAY, as the control: it has always been right, so a
        // failure here means the fault moved rather than that this one came
        // back.
        const live = (mode === 'plddt' || mode === 'deepmind') ? r.plddtColors : r.colors;
        let asked = 0;
        for (let i = 0; i < live.length; i += 1) {
          const c = live[i];
          if (c && c.r === 0 && c.g === 255 && c.b === 0) asked++;
        }
        R[mode].segmentsAsked = asked;
      }
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 500);
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS)

src = open(os.path.join(ROOT, "dev.html")).read()
stamp = str(int(time.time() * 1000))
src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
             lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
open(PROBE, "w").write(src.replace(
    "</body>", f"<script>window.__file={json.dumps(FILE)};</script>" + JS + "</body>"))

box = []
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")

socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9663), H); httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
proc = subprocess.Popen(
    [CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-plddt-override", "--no-first-run",
     "--window-size=1200,1000", "http://127.0.0.1:9663/_plddt_override.html"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.4)
proc.kill(); httpd.shutdown(); os.remove(PROBE)
shutil.rmtree("/tmp/py2dmol-plddt-override", ignore_errors=True)

R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"a pLDDT ramp over {R['bands']} bands")
for mode in ("chain", "plddt", "deepmind"):
    row = R[mode]
    if row.get("error"):
        sys.exit(f"{mode}: {row['error']}")
    print(f"  {mode:9s} {row['changed']:6d} pixels changed,"
          f" {row['green']:5d} of them the colour asked for"
          f" ({row['greenShare']:.0%}), {row['segmentsAsked']} segments")

bad = []
control = R["chain"]["changed"]
if control == 0:
    bad.append("the control changed nothing - the colour never reached the canvas")
for mode in ("plddt", "deepmind"):
    row = R[mode]
    # Twice the control is slack for the ramp's own boundary pixels; the fault
    # is a factor of TEN.
    if row["changed"] > 2 * control:
        bad.append(f"{mode}: colouring {11} residues changed {row['changed']} pixels"
                   f" against {control} in chain mode - the whole structure was"
                   " recoloured, not the selection")
    if row["greenShare"] < 0.5:
        bad.append(f"{mode}: only {row['greenShare']:.0%} of what changed is the"
                   " colour that was asked for")
    if row["segmentsAsked"] != R["chain"]["segmentsAsked"]:
        bad.append(f"{mode}: {row['segmentsAsked']} segments carry the colour"
                   f" against {R['chain']['segmentsAsked']} in chain mode")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
