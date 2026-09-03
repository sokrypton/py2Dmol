"""A PAE box is a selection like any other, and survives like one.

    python3 tests/heatmap_visibility.py

There were two schemes deciding what is drawn, and they disagreed.

  * The LIVE MODEL (renderer.visibilityModel) knows three contributors -
    residues picked in the strip, whole chains, and boxes drawn on the PAE
    matrix - unions them, and reads its mode to decide what an empty answer
    means.
  * The PER-OBJECT RECORDS, added when several objects could be drawn at once,
    knew about positions and chains and nothing else. Every rebuild of the
    coordinate array composed the mask from them and pushed the result back
    through setVisibility with `heatmapBoxes: []` - so a box drawn on a prediction
    survived exactly until the next eye click, side chain or frame step.
    Measured before the fix: 7 residues visible, then all 144 the moment a
    second object was switched on, with the record rewritten to
    positions=76 boxes=0 mode=default.

Now there is one composer (_visibleForObject / _composeAndApplyMask): the
records hold all three contributors, in each object's own numbering, and the
rule for combining them is written once. Rebuilds COMPOSE; only an edit WRITES.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_paevis.html")

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
      await load('6MRR.cif'); await until(loaded); await settle();
      await load('1UBQ.cif'); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      const [other, withPae] = Object.keys(r.objectsData);
      R.names = [other, withPae];
      // A SYNTHETIC PREDICTION: one row per residue of THAT object.
      const o = r.objectsData[withPae];
      const n = o.frames[0].coords.length;
      const m = new Uint8Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        m[i * n + j] = Math.min(255, Math.abs(i - j) * 4);
      }
      o.frames[0].pae = m; o._lastPaeFrame = 0;
      window.Heatmap.syncToDrawn(r); await settle();
      const mask = () => {
        const v = r.visiblePositions;
        if (!v) return {all: true, n: r.coords.length};
        const a = Array.from(v).sort((x, y) => x - y);
        return {all: false, n: a.length, lo: a[0], hi: a[a.length - 1]};
      };
      const record = (nm) => {
        const st = r.objectsData[nm].visibilityState;
        return st ? {positions: st.positions ? st.positions.size : 0,
                     boxes: (st.heatmapBoxes || []).length,
                     mode: st.visibilityMode} : null;
      };
      // DRAW A BOX on rows 2..8 of the matrix
      const pc = r.heatmapRenderer.canvas;
      const pr = pc.getBoundingClientRect();
      const cell = (k) => (k + 0.5) * pr.width / r.heatmapRenderer.n;
      const at = (k) => ({clientX: pr.left + cell(k), clientY: pr.top + cell(k),
                          bubbles: true, button: 0});
      pc.dispatchEvent(new MouseEvent('mousedown', at(2)));
      window.dispatchEvent(new MouseEvent('mousemove', at(8)));
      window.dispatchEvent(new MouseEvent('mouseup', at(8)));
      await settle();
      R.afterBox = mask();
      R.recordAfterBox = record(withPae);

      // ...A FRAME RELOAD rebuilds the array
      r.reloadDrawn(); await settle();
      R.afterReload = mask();

      // ...AN EYE, which rebuilds it as a merge. The other object has no
      // record, so it shows entire; the prediction still shows its box.
      r.setShownObjects([other, withPae]); await settle();
      R.merged = mask();
      R.recordMerged = record(withPae);
      R.offset = r.sourceOffsetOf(withPae);
      R.otherN = r.objectsData[other].frames[0].coords.length;

      // ...AND BACK to the prediction alone
      r.setShownObjects([withPae]); await settle();
      R.aloneAgain = mask();
      R.boxesStill = (r.visibilityModel.heatmapBoxes || []).length;

      // ...AND THE PANEL AGREES WITH THE PICTURE. A residue outside the box
      // is not drawn, so Main chain must read Hide - it used to read Show,
      // because it asked only whether anything had switched that residue's
      // backbone off and a PAE box does not.
      {
        // READ OFF THE PANEL ITSELF, not off a copy of its rule: which of the
        // two buttons is lit is the thing that was wrong.
        const pairState = () => {
          const pair = document.getElementById('mainchainPair');
          const btns = pair ? pair.querySelectorAll('.selection-switch-btn') : [];
          if (btns.length < 2) return null;
          return {show: btns[0].classList.contains('is-on'),
                  hide: btns[1].classList.contains('is-on')};
        };
        // ...selected the way the app hears about it: the renderer's own
        // event, which is what the panel listens for.
        const select = async (i) => {
          r.residueSelection = new Set([i]);
          document.dispatchEvent(new CustomEvent('py2dmol-residue-selection-change',
            {detail: {positions: [i]}}));
          await settle();
          return pairState();
        };
        const hidBB = r.backboneHiddenSet ? r.backboneHiddenSet() : null;
        R.panel = {inside: await select(4), outside: await select(40),
                   switchSaysHiddenInside: !!(hidBB && hidBB.has(4)),
                   switchSaysHiddenOutside: !!(hidBB && hidBB.has(40))};
      }
      // ...and clearing it shows everything again
      r.setVisibility({heatmapBoxes: [], positions: new Set(), chains: new Set(),
                       visibilityMode: 'default'});
      await settle();
      R.cleared = mask();
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9791), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-paevis",
                      "--no-first-run", "--window-size=1200,1000",
                      "http://127.0.0.1:9791/_paevis.html"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-paevis", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"{R.get('names')}: a box on rows 2..8 of the prediction")
for k in ("afterBox", "afterReload", "merged", "aloneAgain", "cleared"):
    print(f"  {k:<12} {R.get(k)}")
pn = R.get("panel") or {}
print(f"  the Main chain pair, on a residue inside the box: {pn.get('inside')};"
      f" on one outside it: {pn.get('outside')}"
      f" (the backbone switch hides neither:"
      f" {pn.get('switchSaysHiddenInside')}/{pn.get('switchSaysHiddenOutside')})")
print(f"  record: after the box {R.get('recordAfterBox')}, merged {R.get('recordMerged')}")

bad = []
box7 = {"all": False, "n": 7, "lo": 2, "hi": 8}
if R.get("afterBox") != box7:
    bad.append(f"the box did not restrict the picture to its own rows: {R.get('afterBox')}")
if R.get("afterReload") != box7:
    bad.append(f"a frame reload lost the box: {R.get('afterReload')}")
rec = R.get("recordAfterBox") or {}
if rec.get("boxes") != 1 or rec.get("mode") != "explicit":
    bad.append(f"the box was not filed under its object: {rec}")
# merged: the other object entire, plus the box's rows at the prediction's offset
off, otherN = R.get("offset"), R.get("otherN")
mg = R.get("merged") or {}
if mg.get("all") or mg.get("n") != otherN + 7:
    bad.append(f"in the merge the box no longer restricts its own object, or"
               f" restricts the other one too: {mg} (offset {off}, other {otherN})")
elif mg.get("lo") != 0 or mg.get("hi") != off + 8:
    bad.append(f"the box landed at the wrong offset in the merge: {mg}"
               f" (expected 0..{off + 8})")
if (R.get("recordMerged") or {}).get("boxes") != 1:
    bad.append(f"the merge erased the box from the record: {R.get('recordMerged')}")
if R.get("aloneAgain") != box7:
    bad.append(f"coming back to the prediction alone lost the box: {R.get('aloneAgain')}")
if not R.get("boxesStill"):
    bad.append("the live model no longer holds the box the panel is drawing")
ins, outs = pn.get("inside") or {}, pn.get("outside") or {}
if not ins.get("show") or ins.get("hide"):
    bad.append(f"a residue INSIDE the box does not read as shown: {ins}")
if not outs.get("hide") or outs.get("show"):
    bad.append("a residue outside the box - which is not drawn at all - reads"
               f" as shown in the selection panel: {outs}")
if not (R.get("cleared") or {}).get("all"):
    bad.append(f"clearing the selection did not show everything: {R.get('cleared')}")
for b in bad:
    print("FAIL: " + b)
sys.exit(1 if bad else 0)
