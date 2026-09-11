"""THE PICK INDEX MUST ANSWER WHAT THE SCAN ANSWERS, POINT BY POINT.

    python3 tests/pick_index.py [1UBQ.cif ...]

pickResidueAt walked every segment and every position on every call, and the
mousemove handler calls it on every move to keep the sequence panel's hover
readout current. On a capsid that is 44 ms a pick and 3.9 seconds per hundred
mouse moves - the page freezes while the pointer is over the structure, to
update a readout it throws away unchanged most of the time.

`_pickIndex` is a uniform grid over the canvas with each item inserted into
every cell its own pick radius reaches, so a query is one cell lookup. This
file is the reason that is allowed to ship: picking is not a performance
feature, it is what a click MEANS, and an index that is 300x faster and
occasionally right is worse than the scan.

So: a dense grid of screen points, every one picked twice - once with the index
and once with `_pickIndexOff` - and the two answers must be identical. Not
close, identical, including which contact was hit.

🔴 AND THE POINTS HAVE TO LAND ON THE STRUCTURE. A grid of points over empty
canvas agrees perfectly and proves nothing, so the file counts how many of them
picked something and fails if too few did.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_pickindex.html")
PORT = 9819
DEBUG_PORT = 9820
FILES = sys.argv[1:] or ["1UBQ.cif", "1EHZ.cif", "3PTB.cif"]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
   try {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(12);
    const rect = r.canvas.getBoundingClientRect();

    // 🔴 FEWER POINTS ON A HUGE STRUCTURE, because the arm this is compared
    // against is the thing being replaced: 3,600 points x 44 ms of scan is
    // three minutes of the slow path alone. The grid still has to be dense
    // enough to land on the structure, which the hit count below checks.
    const N = r.coords.length > 100000 ? 14 : 60;
    const pick = (x, y, off) => {
      r._pickIndexOff = off;
      const i = r.pickResidueAt(x, y);
      const c = r._pickedContact;
      return i + '|' + (c ? c.join(',') : '');
    };
    let hits = 0; let diff = 0; const examples = [];
    let tIdx = 0; let tScan = 0;
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const x = rect.left + rect.width * ((gx + 0.5) / N);
        const y = rect.top + rect.height * ((gy + 0.5) / N);
        const t0 = performance.now();
        const a = pick(x, y, false);
        const t1 = performance.now();
        const b = pick(x, y, true);
        const t2 = performance.now();
        tIdx += t1 - t0; tScan += t2 - t1;
        if (a.charAt(0) !== '-') hits += 1;
        if (a !== b) {
          diff += 1;
          if (examples.length < 5) {
            examples.push({gx, gy, indexed: a, scan: b});
          }
        }
      }
    }
    r._pickIndexOff = false;

    // 🔴 A MOVING VIEW MUST NOT BUILD THE INDEX AT ALL. Building it walks the
    // whole structure - 146 ms on a capsid against 44 ms for the scan - so one
    // pick per projection has to take the scan or this is three times slower
    // than what it replaced. Hovering while the view turns is exactly that: a
    // new projection between every mouse move. Rendering between picks is how
    // that looks from here.
    const cx0 = rect.left + rect.width * 0.5;
    const cy0 = rect.top + rect.height * 0.5;
    window.__pickIndexBuilds = 0;
    for (let i = 0; i < 8; i++) {
      r.render('pickMoving');
      r.pickResidueAt(cx0, cy0);
    }
    const movingBuilds = window.__pickIndexBuilds;
    // ...and a still view must, on the second pick and once only
    window.__pickIndexBuilds = 0;
    for (let i = 0; i < 8; i++) r.pickResidueAt(cx0, cy0);
    const stillBuilds = window.__pickIndexBuilds;

    return {file, n: r.coords.length, points: N * N, hits, diff, examples,
            movingBuilds, stillBuilds,
            msIndexed: +(tIdx / (N * N)).toFixed(4),
            msScan: +(tScan / (N * N)).toFixed(4),
            builds: window.__pickIndexBuilds || 0};
   } catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
open(PROBE, "w").write(
    open(os.path.join(ROOT, "dev.html")).read()
    .replace("</body>", "<script>" + SETUP + "</script></body>"))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-pickindex"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_pickindex.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")

bad = []
for f in FILES:
    out = json.loads(cdp.evaluate(
        ws, f"window.__go({json.dumps(f)}).then(JSON.stringify)"))
    if out.get("error"):
        bad.append(f"{f}: page error: {out['error'][:200]}")
        continue
    speed = out["msScan"] / max(out["msIndexed"], 1e-9)
    print(f"{f}: {out['n']} positions, {out['points']} points,"
          f" {out['hits']} of them on the structure")
    print(f"  indexed {out['msIndexed']:.4f} ms a pick,"
          f" scan {out['msScan']:.4f} ms  ({speed:.1f}x),"
          f" index built {out['builds']} time(s)")
    if out["diff"]:
        print(f"  DISAGREED at {out['diff']} points: {out['examples']}")
    # 🔴 IDENTICAL, NOT CLOSE. A pick is what a click means.
    if out["diff"]:
        bad.append(f"{f}: the index and the scan disagreed at {out['diff']} of"
                   f" {out['points']} points - examples {out['examples']}")
    # ...and the points have to have hit something, or agreement is vacuous
    print(f"  index builds: {out['movingBuilds']} while the view moves"
          f" (must be 0), {out['stillBuilds']} while it is still (must be 1)")
    if out["movingBuilds"]:
        bad.append(f"{f}: hovering a MOVING view built the index"
                   f" {out['movingBuilds']} time(s) - the build walks the whole"
                   " structure and is three times the scan it replaces, so one"
                   " pick per projection has to take the scan")
    if out["stillBuilds"] != 1:
        bad.append(f"{f}: hovering a still view built the index"
                   f" {out['stillBuilds']} time(s), not once - it is keyed on"
                   " the projection and should be built on the second pick and"
                   " then reused")
    if out["hits"] < out["points"] * 0.02:
        bad.append(f"{f}: only {out['hits']} of {out['points']} points picked"
                   " anything, so the two paths agreed about empty canvas")

chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

print()
for b in bad:
    print("FAIL: " + b)
print("pick index: " + ("FAILED" if bad else "the index answers what the scan answers"))
sys.exit(1 if bad else 0)
