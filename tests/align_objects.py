"""Superposing one object onto another, in the browser.

    python3 tests/align_objects.py                  # 2OMF + 2POR, two porins
    python3 tests/align_objects.py 1UBQ.cif 3CHY.cif

TM-align itself is scored in node (tests/align.js). What only a page can answer
is whether the wiring around it holds:

  * IT RUNS IN A WORKER. A 1,365-residue chain is 15.7 s of arithmetic, so the
    main thread is not an option - but the fallback that exists for the
    notebook build would also serve a broken worker perfectly quietly, and the
    only symptom would be a page that stops for several seconds. The probe asks
    which one ran.
  * THE REFERENCE DOES NOT MOVE. That is what keeps the camera valid: whatever
    you were looking at is still there and the other structures have come to
    it. Superposing the other way round scores identically and looks wrong.
  * THE FILE IS NOT REWRITTEN. The transform lives on the object and is applied
    on the way to the screen, so Undo is dropping a field - and after it the
    coordinates must be back to the last bit.
  * AND THE ANSWER IS THE RIGHT ONE. 2OMF against 2POR is two porins: TM 0.79,
    RMSD 3.2 A over 278 residues, measured in node against the same files. A
    page that reports something else is not running what was tested.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_align.html")
FILES = sys.argv[1:] or ["2OMF.cif", "2POR.cif"]

JS = """
<script>
window.addEventListener('load', () => {
  const P = new URLSearchParams(location.search);
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    // ...WITH THE BIOUNIT OFF, because this measures an ALIGNMENT and the node
    // figures it is checked against were computed on the deposited chains. The
    // page's Load Biounit box is ticked by default, and 2OMF's assembly is a
    // trimer - so with it on the page aligns three chains against three and
    // scores 0.254, which says nothing about whether TM-align works.
    const bu = document.getElementById('biounitCheckbox');
    if (bu && bu.checked) { bu.checked = false; bu.dispatchEvent(new Event('change')); }
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const el = (id) => document.getElementById(id);
  //HELPERS
  const go = async () => {
    const R = {};
    try {
      const files = P.get('files').split(',');
      for (const f of files) { await load(f); await until(loaded); await settle(); }
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      const names = Object.keys(r.objectsData);
      r.setShownObjects(names);
      await settle();
      R.names = names;
      R.drawn = r.drawnObjects();

      // THE REFERENCE IS THE SELECTION: every residue of the first object.
      const off0 = r.sourceOffsetOf(names[0]);
      const off1 = r.sourceOffsetOf(names[1]);
      const end1 = r.coords.length;
      const sel = new Set();
      for (let i = off0; i < off1; i++) if (r.positionTypes[i] === 'P') sel.add(i);
      r.residueSelection = sel;
      // ...and tell the panel, which is what a click would have done. The row's
      // state is the panel's answer, so setting the selection behind its back
      // and then asking whether the row is up tests nothing.
      window.updateSelectionToolsState();
      R.refSize = sel.size;

      // A COORDINATE IS EITHER SHAPE HERE. The merge pushes the parser's
      // [x, y, z] and the frame load hands back Vec3; reading only one of them
      // gives NaN, which compares false against every threshold and passes.
      const at = (i) => { const c = r.coords[i];
        return (c && c.length >= 3) ? [c[0], c[1], c[2]] : [c.x, c.y, c.z]; };
      const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      // DID THEY COME TOGETHER? The scores say the alignment is good; only
      // the coordinates say it was APPLIED, and applied the right way round.
      // A transform built the other way round still moves the object - a long
      // way - so "it moved" is not the check. The gap between the two
      // structures' centres closing is.
      const centre = (a, b) => { let x = 0, y = 0, z = 0, n = 0;
        for (let i = a; i < b; i++) { if (r.positionTypes[i] !== 'P') continue;
          const p = at(i); x += p[0]; y += p[1]; z += p[2]; n++; }
        return [x / n, y / n, z / n]; };
      const gap = () => dist(centre(off0, off1), centre(off1, end1));
      const refBefore = at(off0);
      const movedBefore = at(off1);
      R.gapBefore = gap();
      const fc0 = r.objectsData[names[1]].frames[0].coords[0];
      const fileBefore = (fc0.length >= 3) ? [fc0[0], fc0[1], fc0[2]] : [fc0.x, fc0.y, fc0.z];

      // ...through the control, not the API: the dropdown is a menu of actions
      const sel2 = el('alignSelect');
      R.rowShown = !!(el('alignRow') && !el('alignRow').hidden);
      sel2.value = 'all';
      sel2.dispatchEvent(new Event('change'));
      // ...and if it never comes back, SAY SO. A worker that fails to start -
      // an importScripts naming a file that is not there - leaves this
      // undefined, and reading through it turns a clear "the alignment never
      // finished" into a TypeError halfway down the probe.
      R.finished = await until(() => !!window.__alignResult, 20000);
      await settle(4);
      if (!R.finished) {
        R.lastStatus = (el('status-message') || {}).textContent || '';
        throw new Error('the alignment never came back - status: ' + R.lastStatus);
      }
      const out = window.__alignResult;
      R.inWorker = out.inWorker;
      R.ref = out.ref;
      R.results = out.results.map((x) => ({name: x.name, chain: x.chain,
        tm: x.tm, rmsd: x.rmsd, aligned: x.aligned}));
      R.snapBack = sel2.value;
      const msg = (el('status-message') || {}).textContent || '';
      R.status = {text: msg, lines: msg.split(String.fromCharCode(10)).length};
      R.refMoved = dist(refBefore, at(off0));
      R.movedBy = dist(movedBefore, at(off1));
      const fc1 = r.objectsData[names[1]].frames[0].coords[0];
      R.gapAfter = gap();
      R.fileUntouched = dist(fileBefore,
        (fc1.length >= 3) ? [fc1[0], fc1[1], fc1[2]] : [fc1.x, fc1.y, fc1.z]);

      // ...and back
      sel2.value = 'none';
      sel2.dispatchEvent(new Event('change'));
      await settle(4);
      R.afterUndo = dist(movedBefore, at(off1));
      R.stillAligned = r.anyAlignment();
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
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-align",
                      "--no-first-run", "--window-size=1000,900",
                      "http://127.0.0.1:9793/_align.html?files=" + ",".join(FILES)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-align", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"{'+'.join(FILES)}: drawn {R.get('drawn')}, reference {R.get('ref')}"
      f" ({R.get('refSize')} residues)")
for x in R.get("results", []):
    print(f"  {x['name']} chain {x['chain']}: TM {x['tm']:.3f},"
          f" RMSD {x['rmsd']:.2f} A over {x['aligned']}")
print(f"  in a worker: {R.get('inWorker')}; it moved {R.get('movedBy', 0):.1f} A,"
      f" the reference {R.get('refMoved', 0):.4f} A")
print(f"  the two centres were {R.get('gapBefore', 0):.1f} A apart,"
      f" now {R.get('gapAfter', 0):.1f} A")
print(f"  says: {R.get('status', {}).get('text')!r}")

bad = []
if not R.get("rowShown"):
    bad.append("the Align row was not offered with two objects and a selection")
res = R.get("results") or []
if len(res) != 1:
    bad.append(f"one other object should have been aligned: {res}")
else:
    x = res[0]
    # Measured in node on these same files: RMSD 3.18 over 278 residues, and
    # TM 0.705 normalised by 2OMF - which is the reference here, and is the
    # whole point of TM1. Normalised the other way it is 0.787, so a probe that
    # accepted both would be accepting the score this code deliberately does
    # not report.
    if len(FILES) == 2 and FILES[0] == "2OMF.cif":
        if not (0.68 < x["tm"] < 0.73):
            bad.append(f"two porins should score TM 0.705 against 2OMF, not"
                       f" {x['tm']:.3f} - the page is not running what node tested")
        if not (3.0 < x["rmsd"] < 3.4) or x["aligned"] != 278:
            bad.append(f"node measured RMSD 3.18 over 278 residues on these two"
                       f" files, the page got {x['rmsd']:.2f} over {x['aligned']}")
    if x["tm"] < 0.2:
        bad.append(f"the alignment found nothing: TM {x['tm']:.3f}")
if R.get("inWorker") is not True:
    bad.append("the alignment ran on the MAIN THREAD - the worker fallback is"
               " covering for a broken worker, and the only symptom would be a"
               " page that freezes")
if R.get("gapBefore", 0) < 10:
    bad.append(f"the two structures started on top of each other, so there is"
               f" nothing to prove: {R.get('gapBefore')} A apart")
if R.get("gapAfter", 999) > 4:
    bad.append(f"the two structures did not come together - they are"
               f" {R.get('gapAfter'):.1f} A apart, from {R.get('gapBefore'):.1f} A."
               " The transform was applied, but not the one that superposes them")
if R.get("movedBy", 0) < 3:
    bad.append(f"the other object barely moved: {R.get('movedBy')}")
if R.get("refMoved", 1) > 1e-6:
    bad.append(f"THE REFERENCE MOVED ({R.get('refMoved')} A) - the superposition"
               " went the wrong way and the camera no longer holds what it held")
if R.get("fileUntouched", 1) > 1e-9:
    bad.append("the alignment rewrote the coordinates on disk")
st = R.get("status") or {}
if st.get("lines", 9) > 1 or len(st.get("text", "")) > 90:
    bad.append(f"the status line is not one short line: {st.get('text')!r}")
if "TM" not in st.get("text", ""):
    bad.append(f"the status line does not say how good the fit is: {st.get('text')!r}")
if R.get("snapBack") != "":
    bad.append(f"the dropdown kept its choice instead of snapping back:"
               f" {R.get('snapBack')!r}")
if R.get("afterUndo", 1) > 1e-9:
    bad.append(f"undo did not put the object back: {R.get('afterUndo')} A out")
if R.get("stillAligned"):
    bad.append("undo left the alignment in place")
for b in bad:
    print("FAIL: " + b)
sys.exit(1 if bad else 0)
