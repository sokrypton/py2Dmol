"""A GAP IN A SHEET CLOSING MUST NOT LEAVE A LINE ACROSS IT.

    python3 tests/sheet_merge.py [_traj_3ptb.pdb]

Two strands with a loop between them, and a later frame where the loop becomes
a strand: the sheet is continuous and nothing should be drawn across it. On the
station path it is - a thin line at the old gap, which is what this measures.

🔴 THE LETTER ALONE CANNOT DRIVE THIS, and a probe that only changes it measures
nothing. Nothing keys on `_forceSec`, so changing it re-derives no prims and the
picture does not move by a single pixel. The frame has to STEP, which is what
re-derives them - so this forces the assignment AND steps, which is exactly what
a trajectory does when its own assignment drifts.

🔴 AND IT COMPARES ROWS, NOT PIXELS. The artifact is 139 pixels of a 498,436
pixel canvas; a pixel bound that small is a thing that fails on a driver change.
The outline rows are exact: every row the fast path draws should be a row a
fresh build of the same frame draws too. Rows are matched by their ENDPOINTS,
because the edge table is keyed by a hash of positions and row ORDER changes
between builds - an index comparison here compares nothing.

🔴 THIS FAILS TODAY, ON PURPOSE, AND IS IN NO LANE OF tests/run.sh. It is the
reproduction of a bug that is not fixed yet, not a gate that passes; wiring it
into the gpu lane before the repair would leave the suite permanently red, which
is how a red suite stops being read. Move it into the lane with the fix.

WHAT IT FINDS TODAY: 8 rows, all of them a strip's cross edge with ONE incident
face. A cross edge is keyed by its corner positions, and those follow the letter
(SS_HALF_A is 1.1 for a strand and 0.42 for a loop), so a strand meeting a loop
hashes to two separate one-sided edges instead of one shared one. One-sided
means boundary, and `if (eIn[eb + 2] < 2) always = 2` draws a boundary
unconditionally - right while the ribbon really does step down, and stale the
moment the letter removes the step. The per-frame crease test cannot correct it
because that test is gated on having two faces.

🔴 AND THE TWO FACES THAT OUGHT TO MEET ARE FINDABLE. Reading them off a FRESH
build of the same frame, where the edge does have two: they are the same
SURFACE, in CONSECUTIVE PIECES, at station indices two apart - a piece boundary
carries its own copy of the station, and the two cross-sections meet at the
station between them.

    kept: face 2173 (st1086 su0 pc543)  ->  fresh: 2173 (st1086 su0 pc543)
                                                 + 2177 (st1088 su0 pc544)
    kept: face 2205 (st1102 su0 pc551)  ->  fresh: 2205 + 2209 (st1104 su0 pc552)
    kept: face 2213 (st1106 su0 pc553)  ->  fresh: 2209 + 2213

So a cross edge at a piece boundary can be keyed by (surface, boundary) instead
of by the positions of its corners, and then both faces are recorded whatever
the letters are, `nCount` is 2 in every frame, and the decision moves to the
frame - which is where the goal of building once per object needs it.

🔴 SEED THE PAPER BEFORE COMPARING TWO RUNS. geom.js builds its tooth tile from
Math.random() once per page load, so two runs of the IDENTICAL tree differ by
about 17.9% of the frame. Two candidate repairs were rejected here on
"49,759 pixels lost" and "48,057 pixels lost" and BOTH numbers were that noise -
with the paper seeded the same change moves a fresh build by ZERO. Any number in
this file comparing one run against another is worthless without first replacing
Math.random with a fixed LCG, before the page loads. The comparison of rows, below, never had this problem,
which is the second reason it is the assertion.

🔴 WHAT IS KNOWN ABOUT THE REPAIR, from five attempts that all failed the same
way. The rows a fresh build draws that a fast one does not split cleanly:

    (nCount 2, always 2, byLetter 0) x 32   pre-existing, nothing to do with this
    (nCount 1, always 2, byLetter 1) x 42   one-sided in a FRESH build too

Every rule tried - clip one-sided rows; clip when the corner at the neighbouring
station coincides; require a partner face; require the partner's piece to be a
strand; pair at station +-2 rather than +-1 - removes the 8 rows of the artifact
and clips those 42 with them, taking the frame from 139 pixels to 360. So the
flush test as written does not separate "the neighbour became a strand" from
"the neighbour is still a loop", and the next attempt should find out why before
writing another rule: for the 42, a fresh build sees ONE face where the test
says two slabs coincide, and that contradiction is the whole problem.

The pairing itself is known and is not the difficulty: the two faces that ought
to meet are the same SURFACE in CONSECUTIVE PIECES at station indices two apart,
their cross-sections meeting at the station between them.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_sheetmerge.html")
PORT, DEBUG_PORT = 9947, 9948
FILE = sys.argv[1] if len(sys.argv) > 1 else "_traj_3ptb.pdb"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
   try {
    const G = window.py2dmolCartoonGPU;
    const C = window.py2dmolCartoon;
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    r.autoRotate = false;
    if (G.setStationDraw) G.setStationDraw(true);
    r.setFrame(0); r.render('warm'); await settle(6);
    const sc = C.secForColor(r);
    const sec = Array.isArray(sc) ? sc.join('') : String(sc || '');
    // the longest strand run, so there is room to break it in the middle
    let run = null; let i0 = 0;
    for (let i = 1; i <= sec.length; i++) {
      if (i === sec.length || sec[i] !== sec[i0]) {
        if (sec[i0] === 'E' && (!run || (i - i0) > (run.b - run.a + 1))) run = {a: i0, b: i - 1};
        i0 = i;
      }
    }
    if (!run || run.b - run.a < 4) return {error: 'no strand run long enough to break'};
    const mid = ((run.a + run.b) / 2) | 0;
    const merged = sec.split('');
    for (let i = run.a; i <= run.b; i++) merged[i] = 'E';
    const broken = merged.slice(); broken[mid] = 'C';

    const ink = () => { const s = G.stationTexels(); return s && s.inkBuf; };
    // build with the gap OPEN, then step to the next frame with it CLOSED
    r._forceSec = broken.join(''); r.setFrame(0);
    if (G.invalidate) G.invalidate();
    r.render('build'); await settle(8);
    const b0 = window.__faceBuilds || 0;
    r._forceSec = merged.join(''); r.setFrame(1);
    r.render('close'); await settle(8);
    const rebuilt = (window.__faceBuilds || 0) - b0;
    const fast = ink();
    // ...and the same frame and letters built from scratch
    if (G.invalidate) G.invalidate();
    r.render('fresh'); await settle(8);
    const fresh = ink();
    r._forceSec = null;
    return {n: sec.length, run, mid, rebuiltOnClose: rebuilt,
            around: sec.slice(Math.max(0, mid - 8), mid + 9), fast, fresh};
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
profile_dir = "/tmp/py2dmol-sheetmerge"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_sheetmerge.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"][:400])

ED = 19
DRAWN = {2.0, 5.0}


def rows(buf):
    """Every outline row, keyed by its two endpoints - see the header."""
    out_ = {}
    for i in range(len(buf) // ED):
        r = buf[i * ED:(i + 1) * ED]
        a = tuple(round(v, 2) for v in r[0:3])
        b = tuple(round(v, 2) for v in r[3:6])
        out_.setdefault((a, b) if a <= b else (b, a), []).append(r)
    return out_


def drawn(lst):
    return any(r[12] in DRAWN for r in lst)


fast = rows(out["fast"])
fresh = rows(out["fresh"])
extra = [k for k, v in fast.items()
         if drawn(v) and not (k in fresh and drawn(fresh[k]))]

print(f"{FILE}: {out['n']} residues, strand run {out['run']['a']}..{out['run']['b']},"
      f" gap closed at {out['mid']}  ({out['around']})")
print(f"  closing the gap rebuilt the mesh: {bool(out['rebuiltOnClose'])}")
print(f"  outline rows: {len(fast)} without a rebuild, {len(fresh)} built fresh")
print(f"  drawn without a rebuild that a fresh build does not draw: {len(extra)}")

bad = []
if out["rebuiltOnClose"]:
    bad.append("closing the gap REBUILT the mesh, so this measured a rebuild"
               " rather than the fast path - the whole point is that a letter"
               " must not cost a build")
if extra:
    bad.append(f"{len(extra)} outline row(s) are drawn across the merged sheet"
               " that a fresh build of the same frame does not draw. That is a"
               " line across a continuous sheet, at the gap that closed.")

print()
for b in bad:
    print("FAIL: " + b)
print("sheet merge: " + ("FAILED" if bad else "a closed gap leaves no line"))
sys.exit(1 if bad else 0)
