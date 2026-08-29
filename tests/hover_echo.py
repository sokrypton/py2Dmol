"""A rebuilt sequence strip forgets the hover; a copy does not echo.

    python3 tests/hover_echo.py            # 6MRR on index.html
    python3 tests/hover_echo.py 1UBQ.cif

The hover is a set of POSITION INDICES - `hoverAtoms` in panels/seq.js,
`renderer.highlightedAtoms` on the renderer - and the only thing that ever took
it back was a mousemove or a mouseleave on the strip's canvas.

🔴 A REBUILD DESTROYS THAT CANVAS (`innerHTML = ''`), so the mouseleave can
never arrive. Copy appends an object and switches what is drawn, so the last
hover stayed lit over residues that had come to mean something else: copy a
selection, move the pointer up to a chain label, and part of the old one is
still marked. Reported as an echo of past positions.

So: hover a cell, press Copy, and ask the renderer what it is still
highlighting. The control is the hover itself - if hovering marks nothing, the
assertion passes for the wrong reason.

The chain-label leg is a CONTROL, not a second detector: measured against the
pre-fix code it passes, because hovering the label recomputes the set from a
layout that has been rebuilt by then. What the reader saw while moving the
pointer TOWARDS the label was the stale hover still lit - the strip answers
correctly the moment it is asked again. The leg is here to say that asking
again is still right after a rebuild.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, "/Users/mini/Documents/GitHub/py2Dmol/tests")
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_hoverecho.html")
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
  setTimeout(post, 60000);
  const go = async () => {
    try {
      const P = new URLSearchParams(location.search);
      await load(P.get('f'));
      await until(() => window.py2dmol_viewers
        && Object.keys(window.py2dmol_viewers).length, 30000);
      const r = window.py2dmol_viewers[Object.keys(window.py2dmol_viewers)[0]].renderer;
      await until(() => r.coords && r.coords.length > 30, 30000);
      await until(() => document.getElementById('sequenceCanvas') && window.SEQ
        && window.SEQ.layout()
        && (window.SEQ.layout().residuePositions || []).length, 30000);
      await settle();
      const hl = () => (r.highlightedAtoms
        ? [...r.highlightedAtoms].sort((a, b) => a - b) : []);
      // a selection to copy
      const sel = new Set(); for (let i = 5; i < 15; i++) sel.add(i);
      r.setResidueSelection(sel);
      await settle();
      // ...and the pointer over a cell, which is what sets the hover
      const dpi = 200 / 96;
      const cell = window.SEQ.layout().residuePositions.find(
        (rp) => rp.residueData && rp.residueData.positionIndex === 30);
      const cv = document.getElementById('sequenceCanvas');
      const bx = cv.getBoundingClientRect();
      const lay = window.SEQ.layout();
      cv.dispatchEvent(new MouseEvent('mousemove', {bubbles: true,
        clientX: bx.left + (cell.x + 2) * bx.width / (cv.width / dpi),
        clientY: bx.top + (cell.y + 2 - (lay.scrollTop || 0)) * bx.height / (cv.height / dpi)}));
      await settle(); await settle();
      R.hovered = hl();
      R.objectsBefore = Object.keys(r.objectsData).length;
      // COPY. The strip is rebuilt and its canvas replaced under the pointer.
      const btn = document.getElementById('copySelectionButton');
      R.hasCopy = !!btn;
      if (btn) btn.click();
      await settle(); await settle(); await settle();
      R.afterCopy = hl();
      R.objectsAfter = Object.keys(r.objectsData).length;
      R.selAfter = r.residueSelection ? [...r.residueSelection].length : 0;
      // ...AND THEN THE CHAIN LABEL, which is where the reader was heading.
      // What it marks has to be that chain of that object, in the numbering
      // the structure has NOW.
      await settle();
      const lay2 = window.SEQ.layout();
      const cv2 = document.getElementById('sequenceCanvas');
      const label = (lay2.chainLabelPositions || [])[0];
      if (label && cv2) {
        const bx2 = cv2.getBoundingClientRect();
        cv2.dispatchEvent(new MouseEvent('mousemove', {bubbles: true,
          clientX: bx2.left + (label.x + 2) * bx2.width / (cv2.width / dpi),
          clientY: bx2.top + (label.y + 2 - (lay2.scrollTop || 0))
            * bx2.height / (cv2.height / dpi)}));
        await settle(); await settle();
        const marked = hl();
        const chainOf = (i) => (r.chainKeyAt ? r.chainKeyAt(i) : r.chains[i]);
        const want = r.chainKeyFor
          ? r.chainKeyFor(label.chainId, label.object) : label.chainId;
        R.chainHover = {
          n: marked.length,
          chain: label.chainId,
          outOfRange: marked.filter((i) => !(i >= 0 && i < r.coords.length)).length,
          wrongChain: marked.filter((i) => chainOf(i) !== want).length,
        };
      }
    } catch (e) { R.error = String(e && e.stack || e); }
    post();
  };
  go();
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS)
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9774), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-hoverecho",
                      "--no-first-run", "--window-size=1100,900",
                      "http://127.0.0.1:9774/_hoverecho.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# ...WITH ITS OWN BUDGET. Six legs, two structures and a dozen camera flights
# to wait out: 15 s alone against the shared 30, which the parallel UI lane
# doubles often enough to fail as "no result posted" - a timeout wearing a
# crash's clothes. The legs are the point, so the budget moves.
end = time.time() + 90 * 2
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-hoverecho", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
if R.get("error"):
    sys.exit("page error: " + R["error"])
print(f"  hovering a cell marked {R.get('hovered')} | after Copy the renderer"
      f" still highlights {R.get('afterCopy')}"
      f" | objects {R.get('objectsBefore')} -> {R.get('objectsAfter')}")
if not R.get("hasCopy"):
    bad.append("no Copy button on the page, so nothing was tested")
if not R.get("hovered"):
    bad.append("hovering a cell highlighted nothing - the control failed, so"
               " 'nothing is highlighted after the copy' would pass for the"
               " wrong reason")
if (R.get("objectsAfter") or 0) <= (R.get("objectsBefore") or 0):
    bad.append("Copy made no new object, so the structure never changed under"
               " the hover and the echo cannot appear")
if R.get("afterCopy"):
    bad.append(f"the renderer is still highlighting {R.get('afterCopy')} after"
               " the copy. Those are position indices into the structure that"
               " was there before, and the strip's canvas has been replaced -"
               " no mouseleave can arrive to take them back. See"
               " forgetPositionState in src/panels/seq.js")

ch = R.get("chainHover") or {}
if not ch:
    bad.append("the chain label was never hovered, so the half of the report"
               " about selecting a whole chain is untested")
else:
    print(f"  hovering chain {ch.get('chain')!r} marked {ch.get('n')} positions,"
          f" {ch.get('outOfRange')} out of range, {ch.get('wrongChain')} in"
          " another chain")
    if not ch.get("n"):
        bad.append("hovering the chain label marked nothing")
    if ch.get("outOfRange") or ch.get("wrongChain"):
        bad.append(f"hovering chain {ch.get('chain')!r} marked"
                   f" {ch.get('outOfRange')} positions outside the structure and"
                   f" {ch.get('wrongChain')} belonging to another chain - the"
                   " strip is answering from a layout the copy replaced")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
