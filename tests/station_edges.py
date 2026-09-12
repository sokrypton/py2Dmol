"""THE EDGE ARRAYS, BUILT TWICE AND DIFFED ELEMENT BY ELEMENT.

    python3 tests/station_edges.py [1UBQ.cif 1AOI.cif ...]

This is stage 0 of the plan in tests/PERF_NOTES.md - "the edge pass from
station topology" - and it exists BEFORE any of the derivation it is there to
check. The pass finds face adjacency by hashing corner POSITIONS about four
times a face; the plan replaces that key with `station * 4 + variant`, which is
already proven to reproduce every corner to 3.7e-06 A. Nothing about that change
may move a pixel, and a pixel diff is far too coarse a way to say so: the
outline is emitted group by group in FIRST-SEEN order with the depth mask off,
so a later stroke paints over an earlier one, and a key change can reorder the
groups without changing the edge set at all. That reordering is invisible on
most structures and repaints a junction on some.

So the comparison is on the arrays, in order, element by element:

  * `ed` - 19 floats an outline instance, the two endpoints, the two normals,
    the always/stick/slot words and the colour.
  * `edSrc` - 6 integers an instance, its provenance: the two corners, the two
    faces, the incidence count and the crease cosine.

🔴 AND IT IS DIFFED IN ORDER, NOT AS A SET. A set comparison passes on exactly
the failure this is guarding against. Where the two DO differ, the file then
asks whether the rows are a permutation of each other and says so, because
"reordered" and "different" want different repairs.

🔴 AND THE FLOOR IS MEASURED FIRST. Two builds of the identical arm, compared
the same way. Without it a difference between two ROUTES cannot be attributed
to the route - and the floor is what tells you this build is deterministic at
all. Measured: 0 differing elements of either array on every structure here.

🔴 AND THE HARNESS IS FALSIFIED TWO WAYS, because three times this session a
gate compared a change against a reference the change had already disabled, and
agreed with itself perfectly. Both falsifications are build-side, not a mutation
of the captured copy - a differ that only catches a scribble on its own output
proves nothing about the pipeline:

    __edgeQuantum   moves hashAt's quantisation from 1e-3 to 1e-1, so corners
                    that were distinct coincide. Changes the edge SET - the
                    class of failure stage 2 could cause.
    __edgeFlipFirst flips `always` on the FIRST emitted row and nothing else.
                    One float, one row, same set, same order - the class a
                    length or a count comparison would sail past.

Both must be caught, and the second must be caught as EXACTLY ONE differing
float, or the diff is not element by element.

WHAT STAGE 2 DOES WITH THIS: the same probe, with arm B built under the new
corner key instead of under `__edgeQuantum`. The rule from the plan holds -
**the check flag must force the old route to still run**, or arm A is not the
old route and this file compares the new one with itself.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationedges.html")
PORT = 9917
DEBUG_PORT = 9918
FILES = sys.argv[1:] or ["1UBQ.cif", "1EHZ.cif", "1AOI.cif"]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (files) => {
   try {
    const out = [];
    const G = window.py2dmolCartoonGPU;

    // IN ORDER, element by element. Returns the first disagreement as well as
    // the count, because "3,412 floats differ" and "one float differs" are
    // different bugs and the first index says which.
    const diff = (a, b, stride) => {
      if (!a || !b) return {missing: true};
      const n = Math.min(a.length, b.length);
      let d = 0; let first = null;
      for (let i = 0; i < n; i += 1) {
        if (a[i] !== b[i]) {
          d += 1;
          if (!first) first = {at: i, row: (i / stride) | 0,
                               lane: i % stride, a: a[i], b: b[i]};
        }
      }
      return {len: a.length, lenB: b.length, diffs: d + Math.abs(a.length - b.length),
              first, sameLength: a.length === b.length};
    };
    // ...and only where they DO differ: are the rows a permutation? A key
    // change that reorders the groups leaves the set alone and the picture
    // does not, so the two want different repairs and the file says which.
    const permuted = (a, b, stride) => {
      if (a.length !== b.length) return false;
      const key = (arr, r) => {
        let s = '';
        for (let k = 0; k < stride; k += 1) s += arr[r * stride + k] + ',';
        return s;
      };
      const m = new Map();
      const rows = (a.length / stride) | 0;
      for (let r = 0; r < rows; r += 1) {
        const k = key(a, r); m.set(k, (m.get(k) || 0) + 1);
      }
      for (let r = 0; r < rows; r += 1) {
        const k = key(b, r); const c = m.get(k);
        if (!c) return false;
        m.set(k, c - 1);
      }
      return true;
    };

    for (const f of files) {
      const t = await (await fetch('/' + f)).text();
      await window.processFiles([{name: f, readAsync: () => Promise.resolve(t)}], true);
      await until(loaded, 300000);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      await until(() => r.coords && r.coords.length > 0, 300000);
      await settle(8);
      await until(() => !r._quietStyle && !r._switchQuiet, 60000);
      if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
      await settle(10);
      // edSrc is only WRITTEN while the station path is on - it is 3-5% of a
      // rebuild and a reader who never presses the station table does not pay it - so
      // without this half of what is compared here does not exist.
      if (G.setStationDraw) G.setStationDraw(true);
      r.outlineMode = 'on'; r.relativeOutlineWidth = 3;
      if (G.invalidate) G.invalidate();
      await settle(6);

      // STAGE 1's two measurements, taken on this structure's own build. See
      // edgeTopology in paintgl.js for what they are and why.
      window.__edgeTopology = true;
      window.__edgeTopologyResult = null;
      // 🔴 MORE THAN ONE ATTEMPT, because the measurement rides on a BUILD and
      // a render need not be one: invalidate marks the mesh stale, and the
      // rebuild lands on the next frame the app draws rather than inside this
      // call. One try left 1UBQ reporting nothing at all while the two
      // structures after it - which had a settled page by then - reported.
      let topo = null;
      let topoBuilds = 0;
      for (let a = 0; a < 6 && !topo; a += 1) {
        const b0 = window.__faceBuilds || 0;
        if (G.invalidate) G.invalidate();
        r.render('edgeTopo' + a); await settle(4);
        topoBuilds += (window.__faceBuilds || 0) - b0;
        topo = window.__edgeTopologyResult;
      }
      window.__edgeTopology = false;

      window.__edgeCapture = true;
      const build = (tag) => {
        window.__edgeCaptured = null;
        if (G.invalidate) G.invalidate();
        r.render(tag);
        return window.__edgeCaptured;
      };
      const A = build('edgeA');
      const A2 = build('edgeFloor');
      window.__edgeQuantum = 10;
      const Q = build('edgeQuantum');
      window.__edgeQuantum = 0;
      window.__edgeFlipFirst = true;
      const F = build('edgeFlip');
      window.__edgeFlipFirst = false;
      const A3 = build('edgeRestore');
      window.__edgeCapture = false;

      const pack = (X, Y) => (!X || !Y) ? {missing: true} : {
        ed: diff(X.ed, Y.ed, 19), src: diff(X.edSrc, Y.edSrc, 6),
        perm: (X.ed.length === Y.ed.length) ? permuted(X.ed, Y.ed, 19) : false,
      };
      out.push({
        file: f,
        topo, topoBuilds,
        built: !!A,
        rows: A ? A.ed.length / 19 : 0,
        srcRows: A ? A.edSrc.length / 6 : 0,
        floor: pack(A, A2),
        restore: pack(A, A3),
        quantum: pack(A, Q),
        flip: pack(A, F),
      });
    }
    return {out};
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
profile_dir = "/tmp/py2dmol-stationedges"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationedges.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILES)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])

bad = []
for row in res["out"]:
    f = row["file"]
    if not row["built"]:
        bad.append(f"{f}: no edge arrays were captured, so nothing here was"
                   " compared. They are kept only while the station path is on"
                   " and the outline is on - if either is off, residentEdges is"
                   " null and the capture has nothing to copy")
        print(f"  {f:<12} no capture")
        continue
    fl = row["floor"]; rs = row["restore"]
    q = row["quantum"]; fp = row["flip"]
    print(f"  {f:<12} {row['rows']:>7} outline rows, {row['srcRows']:>7} src rows")
    print(f"    floor    ed {fl['ed']['diffs']:>7} src {fl['src']['diffs']:>7}"
          "   (two builds of the SAME arm)")
    print(f"    restore  ed {rs['ed']['diffs']:>7} src {rs['src']['diffs']:>7}"
          "   (after both falsifications, flags cleared)")
    print(f"    quantum  ed {q['ed']['diffs']:>7} src {q['src']['diffs']:>7}"
          f"   rows {q['ed']['len'] // 19} -> {q['ed']['lenB'] // 19}")
    print(f"    flip     ed {fp['ed']['diffs']:>7} src {fp['src']['diffs']:>7}"
          + (f"   first at row {fp['ed']['first']['row']}"
             f" lane {fp['ed']['first']['lane']}:"
             f" {fp['ed']['first']['a']} -> {fp['ed']['first']['b']}"
             if fp["ed"]["first"] else ""))

    t = row.get("topo")
    if t:
        print(f"    table    {t['stations']} stations in {t['pieces']} pieces"
              f"  - a station-level canonicalisation is {t['stations']} hashes"
              f" against the {t['corners']} the pass runs now")
        print(f"    corners  {t['corners']:>7} over {t['faces']} faces ->"
              f" {t['classes']} position classes;"
              f" {t['coincident']} hold more than one identity"
              f" ({t['crossStation']} across stations -"
              f" {t['crossPiece']} of them across PIECES,"
              f" {t['withinPiece']} inside one - and"
              f" {t['crossVariant']} within a station)")
        print(f"    edges    {t['internal']:>7} strip-internal,"
              f" {t['other']} other, {t['boundaryEdge']} one-faced,"
              f" {t['contacts']} contacts"
              f"   ({100 * t['internal'] / max(t['rows'], 1):.1f}% internal)")

    # 🔴 THE FLOOR FIRST. Everything below is a difference attributed to a
    # deliberate change, and none of it is attributable if two identical builds
    # already disagree.
    if fl["ed"]["diffs"] or fl["src"]["diffs"]:
        bad.append(f"{f}: two builds of the SAME arm differ -"
                   f" {fl['ed']['diffs']} float(s) of ed and"
                   f" {fl['src']['diffs']} of edSrc. The build is not"
                   " deterministic here, so this file cannot attribute any"
                   " difference to a route and stage 2 cannot be checked with"
                   " it. Find that before going further")
    # ...and the flags have to be RESTORABLE, or the arms after the first one
    # in any future run are measuring the falsification.
    if rs["ed"]["diffs"] or rs["src"]["diffs"]:
        bad.append(f"{f}: clearing the falsification flags did not restore the"
                   f" build - {rs['ed']['diffs']} float(s) of ed still differ"
                   " from the first arm. Something they set is sticky, and a"
                   " later arm would be measuring it")
    # 🔴 AND BOTH FALSIFICATIONS HAVE TO FIRE. A gate that cannot fail is not a
    # gate; three of them in this session agreed perfectly because the thing
    # they compared against had been disabled by the change under test.
    if not q["ed"]["diffs"] and not q["src"]["diffs"]:
        bad.append(f"{f}: coarsening hashAt's quantum by a hundredfold changed"
                   " neither array. Corner identity is what the edge table is"
                   " keyed on, so either the flag did not reach the build or"
                   " this comparison is not looking at the arrays that pass"
                   " produced - either way it would not catch stage 2 getting"
                   " the key wrong")
    if fp["ed"]["diffs"] != 1:
        bad.append(f"{f}: flipping `always` on one row changed"
                   f" {fp['ed']['diffs']} float(s) of ed, not exactly 1. The"
                   " diff has to be element by element - one row, one lane -"
                   " or it is a length or a count comparison wearing a diff's"
                   " clothes, and a reordering would pass it")
    # the provenance is written from the same loop and carries no `always`, so
    # the flip must NOT reach it. If it does, the two arrays are not
    # independent and edSrc is not the second opinion it is here to be.
    if fp["src"]["diffs"]:
        bad.append(f"{f}: flipping `always` moved {fp['src']['diffs']} integer(s)"
                   " of edSrc, which carries no such field. The provenance is"
                   " not independent of the instance it describes")
    # 🔴 STAGE 1 IS A MEASUREMENT, AND ITS ARITHMETIC IS STILL AN ASSERTION.
    # Every edge falls in exactly one of the four buckets; if they do not sum
    # to the row count the classification has a hole and the fractions printed
    # above describe something other than the outline.
    if not t:
        bad.append(f"{f}: no topology measurement was taken. edgeTopology runs"
                   " off the station cover mesh, so it needs the station path"
                   " on and a build - if the frame was served from the resident"
                   " mesh there is no cover mesh to read")
    else:
        tot = t["internal"] + t["other"] + t["boundaryEdge"] + t["contacts"]
        if tot != t["rows"]:
            bad.append(f"{f}: the edge buckets sum to {tot} against"
                       f" {t['rows']} rows, so an edge is being counted twice"
                       " or not at all and the internal fraction is not a"
                       " fraction of anything")
        # ...and corners MUST share positions, or the whole design is wrong:
        # the edge table finds adjacency by two faces landing on one point.
        if t["classes"] >= t["corners"]:
            bad.append(f"{f}: {t['corners']} corners produced"
                       f" {t['classes']} distinct positions - no two faces"
                       " share a corner at all. Either the rule here is not"
                       " cornerOf's or the table has no adjacency to find")
    if q["perm"]:
        print(f"    note: {f}'s quantum arm is a PERMUTATION of the first -"
              " same rows, different order")

print()
for b in bad:
    print("FAIL: " + b)
print("station edges: " + ("FAILED" if bad
                           else "the harness diffs in order and both"
                                " falsifications fire"))
sys.exit(1 if bad else 0)
