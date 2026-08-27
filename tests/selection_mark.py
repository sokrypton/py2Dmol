"""Three ways to mark a selection, and each has to do its own job.

    python3 tests/selection_mark.py                  # 4HHB, cartoon and tube

`selectionMark` is a Style-panel row - highlight, outline, none - and the three
differ in exactly one way that can be checked without looking: what happens to
the pixels AT the residue being marked.

  * HIGHLIGHT lays a translucent band over it. Those pixels change. That is
    the complaint it exists to answer for ("too intense", over a yellow chain
    it is a blot with the answer inside it) and the reason it has to be pale.
  * OUTLINE draws the same band and punches its middle out, so the geometry
    inside is untouched and only a rim reaches the canvas. Those pixels must
    NOT change - and pixels near them must, or every other check here passes
    for a mark that draws nothing.
  * NONE draws nothing at all, and must not even project: the early return is
    before `_ensurePickProjection`, which on the GPU tube path is a per-frame
    debt this method settles.

Both painters for the outline, because the mark is laid over whatever drew the
frame and a cartoon and a tube reach it by different paths. They report
identical numbers, which is a fact about the halo rather than a bug here.

Not checked: the fallbacks. An SVG export and a node harness cannot punch a
hole - `destination-out` means nothing in a vector context and compositing a
raster layer would put a bitmap in the file - so both draw the highlight whatever
the setting says. tests/interaction.js covers the node side by lifting the
paint with a mock context. docs/SELECTION_MARK.md has the rest.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_selmark.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "4HHB.cif"

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {styles: []};
    try {
      const P = new URLSearchParams(location.search);
      await load(P.get('f')); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.styleChosen = true;

      const pixels = () => {
        const cv = r.canvas;
        const c2 = document.createElement('canvas');
        c2.width = cv.width; c2.height = cv.height;
        c2.getContext('2d').drawImage(cv, 0, 0);
        return c2.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      };
      const differs = (a, b, i) => (a.data[i] !== b.data[i]
        || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]);

      // ...AND THE PATH IT STROKES, on a helix, in both styles. A cartoon
      // helix is a ribbon spiralling THROUGH its residues, so a mark that
      // joins them with straight lines chords the drawing; the tube IS those
      // straight lines, so there the two must agree exactly.
      const sec = r._cartoonSec || '';
      let hAt = -1; let hLen = 0;
      for (let i = 0; i < sec.length; i++) {
        if (sec[i] !== 'H') continue;
        let k = i; while (k < sec.length && sec[k] === 'H') k++;
        if (k - i > hLen) { hLen = k - i; hAt = i; }
        i = k;
      }
      R.helix = {at: hAt, len: hLen};
      if (hAt >= 0) {
        const run = [];
        for (let k = hAt; k < hAt + Math.min(hLen, 12); k++) run.push(k);
        for (const style of ['cartoon', 'tube']) {
          r.setStyle(style);
          // THE HIGHLIGHT, NOT THE OUTLINE, for this measurement: an outline
          // strokes its path TWICE - once to draw it and once with
          // destination-out to punch the middle - so every length here would
          // come out exactly doubled. The path is the same either way; what
          // the mark does with it is not.
          r.selectionMark = 'highlight';
          r.setResidueSelection(new Set(run));
          r.render('path'); await settle(); await settle();
          window.__haloPath = 1;
          r.render('path'); await settle();
          const P2 = window.__haloPath || {};
          R.paths = R.paths || {};
          R.paths[style] = {chord: +(P2.chord || 0).toFixed(1),
                            drawn: +(P2.drawn || 0).toFixed(1),
                            pts: P2.pts || 0, curved: P2.curved || 0};
          window.__haloPath = 0;
        }
        // ...AND IT SURVIVES A REBUILD. Toggling Cyclic invalidates the
        // segment cache, and the trace used to be dropped with it - AFTER the
        // rebuild that would have refilled it, so every helix went back to
        // chords and stayed there. Reported by a reader, not by this probe,
        // which only measured a fresh page.
        r.setStyle('cartoon');
        r.setResidueSelection(new Set(run));
        const cyc = document.getElementById('cyclicCheckbox');
        if (cyc) {
          for (const on of [true, false]) {
            cyc.checked = on; cyc.dispatchEvent(new Event('change'));
            await settle(); await settle();
            window.__haloPath = 1;
            r.render('cyclic'); await settle();
            const P3 = window.__haloPath || {};
            window.__haloPath = 0;
            R.afterRebuild = {curved: P3.curved || 0,
                              ratio: +((P3.drawn || 0) / Math.max(1e-6, P3.chord || 0)).toFixed(3)};
            if (!P3.curved) break;   // report the first failure, not the last
          }
        }
        r.clearResidueSelection();
      }

      for (const [style, mark] of [['cartoon', 'highlight'], ['cartoon', 'outline'],
                                   ['cartoon', 'none'], ['tube', 'outline']]) {
        r.setStyle(style);
        r.selectionMark = mark;
        r.clearResidueSelection();
        r.render('bare'); await settle(); await settle();
        const before = pixels();

        // A RESIDUE IN THE MIDDLE OF THE PICTURE, found by the same projection
        // the picker uses, so the point tested is where the mark actually is.
        // THE PROJECTION THE HALO ITSELF READS - screenX/screenY, in display
        // pixels - rather than the cartoon's capture probe, which is only
        // filled for a caller that asked for it before the frame.
        r._ensurePickProjection();
        const sx = r.screenX; const sy = r.screenY; const sv = r.screenValid;
        const cx = r.canvas.width / 2; const cy = r.canvas.height / 2;
        const dpr = r.canvas.width / Math.max(1, r.canvas.clientWidth);
        let best = -1; let bestD = 1e9; let bx = 0; let by = 0;
        for (let i = 0; sx && i < sx.length; i++) {
          if (sv && !sv[i]) continue;
          const px = sx[i] * dpr; const py = sy[i] * dpr;
          const d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
          if (d < bestD) { bestD = d; best = i; bx = px; by = py; }
        }
        if (best < 0) { R.styles.push({style, mark, error: 'no drawn positions'}); continue; }

        r.setResidueSelection(new Set([best]));
        r.render('marked'); await settle(); await settle();
        const after = pixels();

        // AT the residue: unchanged. A few pixels either way, because the mark
        // is round and the residue's own centre is what the punch leaves.
        let atChanged = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const x = Math.round(bx + dx); const y = Math.round(by + dy);
            if (x < 0 || y < 0 || x >= after.width || y >= after.height) continue;
            if (differs(before, after, (y * after.width + x) * 4)) atChanged++;
          }
        }
        // NEAR it: something changed, and it is nearby rather than everywhere.
        let near = 0; let far = 0; let maxR = 0;
        for (let y = 0; y < after.height; y++) {
          for (let x = 0; x < after.width; x++) {
            if (!differs(before, after, (y * after.width + x) * 4)) continue;
            const d = Math.hypot(x - bx, y - by);
            if (d > maxR) maxR = d;
            if (d <= 40 * dpr) near++; else far++;
          }
        }
        R.styles.push({style, mark, residue: best, atChanged, near, far,
                       maxR: Math.round(maxR / dpr),
                       // ...and what the renderer thinks it drew, because two
                       // styles reporting the same numbers is either a fact or
                       // a style switch that did not happen
                       drew: r.currentStyle || r.style || r.renderStyle});
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9761), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-selmark",
                      "--no-first-run", "--window-size=900,900",
                      "http://127.0.0.1:9761/_selmark.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-selmark", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
paths = R.get("paths") or {}
cart, tube = paths.get("cartoon") or {}, paths.get("tube") or {}
if not paths:
    bad.append("the path leg did not run - no helix in the fixture?")
else:
    print(f"  helix path  cartoon chord={cart.get('chord')} drawn={cart.get('drawn')}"
          f" pts={cart.get('pts')} curved={cart.get('curved')}")
    print(f"              tube    chord={tube.get('chord')} drawn={tube.get('drawn')}"
          f" pts={tube.get('pts')} curved={tube.get('curved')}")
    # A HELICAL STEP IS 3.8 A ACROSS AND ABOUT 4.2 ALONG THE SPIRAL, so the
    # traced path is some 10% longer than the chords. Asked as a range: under
    # 3% means it is drawing chords with extra points, and over 40% means it is
    # tracing something that is not the ribbon.
    ratio = (cart.get('drawn') or 0) / max(1e-6, cart.get('chord') or 0)
    if not cart.get('curved'):
        bad.append("no edge of a selected helix followed the ribbon - the mark"
                   " is chording the curve it is drawn around")
    elif ratio < 1.03 or ratio > 1.4:
        bad.append(f"the traced path is {ratio:.2f}x the chords, which is not a"
                   " helix: under 1.03 is chords with extra points, over 1.4 is"
                   " not the ribbon")
    if (cart.get('pts') or 0) <= (tube.get('pts') or 0):
        bad.append(f"the cartoon mark has {cart.get('pts')} points against the"
                   f" tube's {tube.get('pts')} - it is not following a curve")
    if tube.get('curved'):
        bad.append(f"{tube['curved']} tube edges were traced - a tube IS the"
                   " straight lines between its residues, and tracing a cartoon"
                   " curve over it would be a mark for a drawing that is not"
                   " there")
    if abs((tube.get('drawn') or 0) - (tube.get('chord') or 0)) > 0.5:
        bad.append(f"the tube's mark is {tube.get('drawn')} against chords of"
                   f" {tube.get('chord')} - it must be exactly the chords")

reb = R.get("afterRebuild")
if reb is not None:
    print(f"  after a rebuild (Cyclic toggled): curved={reb['curved']}"
          f" ratio={reb['ratio']}")
    if not reb['curved']:
        bad.append("after toggling Cyclic the mark went back to chording the"
                   " helices - the trace was dropped by an invalidation and"
                   " nothing asked for another")

for st in R.get("styles") or []:
    if st.get("error"):
        bad.append(f"{st['style']}/{st.get('mark')}: {st['error']}")
        continue
    print(f"  {st['mark']:<8} on {st['style']:<8} residue {st['residue']}:"
          f" {st['atChanged']} of 25 pixels changed ON it,"
          f" {st['near']} near, {st['far']} far, reach {st['maxR']} px")
    mark = st["mark"]
    if mark == "highlight":
        if st["atChanged"] < 20:
            bad.append(f"highlight: only {st['atChanged']} of the 25 pixels at"
                       " the residue changed - a highlight is a band laid OVER"
                       " it, and one covering nothing is not a highlight")
    elif mark == "outline":
        if st["atChanged"] > 4:
            bad.append(f"{st['style']}/outline: {st['atChanged']} of the 25"
                       " pixels at the residue changed - the outline is"
                       " painting over what it marks, which is the highlight")
        if st["near"] < 50:
            bad.append(f"{st['style']}/outline: only {st['near']} pixels changed"
                       " near the residue - there is no mark at all, and every"
                       " other check here passes for one that draws nothing")
        if st["far"] > st["near"]:
            bad.append(f"{st['style']}/outline: {st['far']} changed pixels are"
                       f" more than 40 px away against {st['near']} near - the"
                       " mark is not where the residue is")
    elif mark == "none":
        if st["atChanged"] or st["near"] or st["far"]:
            bad.append(f"none: {st['atChanged'] + st['near'] + st['far']} pixels"
                       " changed - 'none' must draw nothing")
if len(R.get("styles") or []) < 4:
    bad.append("not every mark ran")
for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
