"""THE STATION ROW'S FIFTEEN STATIC FLOATS, DERIVED BOTH WAYS.

    python3 tests/station_rows.py [1UBQ.cif _traj_1tim.pdb ...]

A station row is 18 floats: three indices - station, surface, piece - and
fifteen more that do not move when the structure does, the colour and the three
flag words. `makeResidentStations` lifts those fifteen out of the 48-float
instance row, and says why: "they are computed by facesOf and are the same
numbers either way, so taking them from the row that already exists makes this a
change of ROUTE and not of content. Building them independently would put two
suspects in the frame for every pixel that moved."

That was right while there was nothing to check the second derivation against.
This is the check. `stationRowsFromFaces` reads the same fifteen off the face,
and every float of every row has to agree.

🔴 WHY IT MATTERS BEYOND TIDINESS: the station path does not draw the 48-float
rows at all. For the ribbon they are built, uploaded, and never issued - the
draw takes its instances from the station buffer. So every geometry pass feeding
them is work only the OUTLINE still needs, and deriving these fifteen floats
without the fill is the first step of not building them. The measurement that
makes that worth doing is in tests/PERF_NOTES.md: the mesh build is 58.9 ms of a
124 ms step on a 46,463-face structure, of which the row emit and its upload are
5.1.

🔴 AND THE ROW ORDER IS PART OF THE CLAIM. The face list handed to
stationRowsFromFaces is the ribbon PART's, in emit order, and the table covers a
prefix of it. If a ribbon face were ever dropped between the two, every row
after it would be one out - which is what a whole-table comparison catches and a
spot check would not.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationrows.html")
PORT = 9915
DEBUG_PORT = 9916
FILES = sys.argv[1:] or ["1UBQ.cif", "1AOI.cif", "1EHZ.cif", "_traj_1tim.pdb"]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (files) => {
   try {
    window.__stationRowCheck = true;
    const out = [];
    const G = window.py2dmolCartoonGPU;
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
      // THE TABLE IS ONLY BUILT WHILE THE STATION PATH IS ON, and the rows
      // it lifts from are only kept then either.
      if (G.setStationDraw) G.setStationDraw(true);
      if (G.invalidate) G.invalidate();
      window.__stationRowDiff = null;
      r.render('rows'); await settle(6);
      if (!window.__stationRowDiff) {
        if (G.invalidate) G.invalidate();
        r.render('rows2'); await settle(6);
      }
      const steps = [];
      const obj = r.objectsData[r.currentObjectName];
      const frames = (obj && obj.frames) ? obj.frames.length : 1;
      // ...and over a few frames, because a rebuild is where the two
      // derivations could drift apart: the faces are new every time.
      for (let i = 1; i <= Math.min(6, frames - 1); i += 1) {
        window.__stationRowDiff = null;
        // 🔴 ASK FOR THE BUILD RATHER THAN WAIT FOR ONE. Stepping a trajectory
        // used to rebuild by itself - a letter moved, the arrowhead moved a
        // station, the mapping changed - and this loop read the diff that fell
        // out. It does not any more (tests/arrow_rebuilds.py), so on
        // _traj_1tim.pdb the loop saw six steps and zero builds and this file
        // reported "the station table was never built", which is the fast path
        // working rather than the table missing. The comparison wants a build
        // with new faces in it; invalidating is how you get one now.
        if (G.invalidate) G.invalidate();
        r.setFrame(i % frames); await settle(2);
        if (window.__stationRowDiff) steps.push(window.__stationRowDiff);
      }
      out.push({file: f, first: window.__stationRowDiff || null,
                atLoad: null, steps,
                resident: G.stationsResident ? G.stationsResident() : null});
      // the load's own check, taken before the stepping overwrote it
      out[out.length - 1].atLoad = steps.length ? steps[0] : null;
    }
    // 🔴 AND A SECOND PHASE WITH THE CHECK OFF, which is the shipped
    // behaviour: the ribbon's rows are not built at all when the station table
    // covers it, so the check above had to force them back on to have two
    // things to compare. This half asserts the skip actually happens - without
    // it the derivation above is exercised and never used.
    window.__stationRowCheck = false;
    window.__ribbonRowsSkipped = 0; window.__ribbonRowsBuilt = 0;
    window.__tailSpanDiffered = 0; window.__stationNormals = 0;
    const r2 = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    const obj2 = r2.objectsData[r2.currentObjectName];
    const frames2 = (obj2 && obj2.frames) ? obj2.frames.length : 1;
    if (G.invalidate) G.invalidate();
    r2.render('skipwarm'); await settle(6);
    for (let i = 1; i <= Math.min(8, Math.max(1, frames2 - 1)); i += 1) {
      r2.setFrame(i % frames2); await settle(2);
    }
    // ...and once more on a structure that HAS a tail, because the recorded
    // fill span only matters when the ribbon contributes no rows and something
    // else does. 1EHZ carries nine ions.
    const tj = '1EHZ.cif';
    const tt2 = await (await fetch('/' + tj)).text();
    await window.processFiles([{name: tj, readAsync: () => Promise.resolve(tt2)}], true);
    await until(loaded, 300000);
    await settle(8);
    const r3 = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    if (r3.setStyle) r3.setStyle('cartoon'); else r3.style = 'cartoon';
    await settle(8);
    if (G.setStationDraw) G.setStationDraw(true);
    if (G.invalidate) G.invalidate();
    r3.render('tailwarm'); await settle(6);
    if (G.invalidate) G.invalidate();
    r3.render('tailwarm2'); await settle(6);
    // 🔴 AND THE OUTWARD NORMALS, BOTH WAYS. With this flag on the piece
    // frames are BUILT - it is what stops the skip - and the station rule is
    // computed beside them and compared. Measuring it with the skip active
    // compares the station rule against whatever the orientation falls back to
    // with no frames at all, which reads as a worst disagreement of 1.79 on a
    // unit vector and is entirely the measurement's doing.
    window.__stationNormalCheck = true;
    window.__stationNormalDiff = null;
    if (G.invalidate) G.invalidate();
    r2.render('normcheck'); await settle(6);
    for (let i = 1; i <= Math.min(4, Math.max(1, frames2 - 1)); i += 1) {
      r2.setFrame(i % frames2); await settle(2);
    }
    const normals = window.__stationNormalDiff;
    window.__stationNormalCheck = false;

    const skip = {skipped: window.__ribbonRowsSkipped || 0,
                  normals,
                  stationNormals: window.__stationNormals || 0,
                  built: window.__ribbonRowsBuilt || 0,
                  tailSpan: window.__tailSpanDiffered || 0,
                  file: (out.length ? out[out.length - 1].file : null)};
    return {out, skip};
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
profile_dir = "/tmp/py2dmol-stationrows"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationrows.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILES)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:400])

bad = []
checked = 0
for row in res["out"]:
    seen = [d for d in ([row.get("first")] + (row.get("steps") or [])) if d]
    if not seen:
        print(f"  {row['file']:<16} no table built")
        bad.append(f"{row['file']}: the station table was never built, so"
                   " neither derivation ran. It needs the station path on and"
                   " a cartoon; stationFillFaces is only kept while that path"
                   " is on")
        continue
    worst = max(d["diffs"] for d in seen)
    checked += sum(d["rows"] for d in seen)
    print(f"  {row['file']:<16} {len(seen)} build(s), rows"
          f" {seen[0]['rows']:>6} of {seen[0]['faces']:>6} faces,"
          f" differing floats {worst}")
    for d in seen:
        if not d["built"]:
            bad.append(f"{row['file']}: stationRowsFromFaces returned nothing -"
                       f" it was handed {d['faces']} faces for {d['rows']} rows,"
                       " so the ribbon part's face list is shorter than the"
                       " table it is supposed to describe")
        elif d["diffs"]:
            bad.append(f"{row['file']}: {d['diffs']} float(s) differ between the"
                       f" row lifted from the fill and the row read off the"
                       f" face - {d['first']}. Either facesOf is not the only"
                       " source of those fifteen (patchPalette writes into the"
                       " fill, for one) or the two orders have drifted apart")

# 🔴 AND THE DERIVATION HAS TO BE THE ONE THAT SHIPS. With the check off, a
# ribbon the station table covers must build no instance rows at all - that is
# the whole point of proving the two agree.
skip = res.get("skip") or {}
print(f"  with the check off, on {skip.get('file')}:"
      f" {skip.get('skipped')} ribbon build(s) skipped their rows,"
      f" {skip.get('built')} built them;"
      f" the tail span differed from the face count on"
      f" {skip.get('tailSpan')} draw(s)")
nm = skip.get("normals") or {}
print(f"  outward normals: {skip.get('stationNormals')} faces took the station"
      f" frame; over {nm.get('faces', 0)} compared against the piece frames the"
      f" worst disagreement is {nm.get('worst', -1)}"
      + (f" at {nm.get('at')}" if nm.get("at") else ""))
if not skip.get("skipped"):
    bad.append("no ribbon build skipped its instance rows, so the derivation"
               " above is exercised and never used. makeResident skips them"
               " when stationCoverCount equals the ribbon part's face count -"
               " if the table is refusing, or covering only a prefix, that"
               " test is false and the rows are built as they always were")
# 🔴 AND THE RECORDED SPAN HAS TO BE LOAD-BEARING SOMEWHERE. drawResident
# reads the tail's offset from what installParts wrote rather than deriving it
# from the ribbon's face count, and the two differ exactly when the ribbon
# contributed no rows. If this never fires, the skip and the tail never meet in
# anything this suite runs, and the offset change is untested.
# 🔴 A RIB FACE'S OUTWARD NORMAL HAS TO BE ITS STATION'S FRAME. That is what
# lets the pieceFrames pass and its rail bookkeeping be skipped, and it is the
# same rule refreshEdgesFromStations has drawn the outline from on every fast
# frame. Measured at exactly 0 over 70,060 faces on 1TIM, 1AOI and 1EHZ; 1e-4
# is loose against that and tight against anything that would move an outline.
if not nm.get("faces"):
    bad.append("no face compared its two outward normals, so the derivation"
               " that lets the piece frames be skipped is unchecked. The flag"
               " has to be set while the piece frames are still being built -"
               " it is what stops the skip - or the comparison is against a"
               " fallback rather than against the frames")
elif nm.get("worst", 1) > 1e-4:
    bad.append(f"a rib face's outward normal from its station differs from the"
               f" one built from the piece frames by {nm['worst']}"
               f" ({nm.get('at')}). The edge pass reads it as _inkN, so this is"
               " the outline's silhouette test reading two different surfaces")
if not skip.get("stationNormals"):
    bad.append("no face took the station-derived normal, so the pieceFrames"
               " pass is still being rebuilt for a part drawn from the table")
if not skip.get("tailSpan"):
    bad.append("the tail was never drawn from a span that differed from the"
               " ribbon's face count, so the one line that makes the skip safe"
               " on a structure with ligands or side chains is not exercised."
               " It needs a structure with a tail - 1EHZ's nine ions - with the"
               " station path on and the ribbon's rows skipped")
if checked == 0:
    bad.append("no row was compared on any structure, so this file checked"
               " nothing - window.__stationRowCheck gates the comparison and"
               " it has to be set before the first build")

print()
for b in bad:
    print("FAIL: " + b)
print("station rows: " + ("FAILED" if bad else f"both derivations agree over {checked} rows"))
sys.exit(1 if bad else 0)
