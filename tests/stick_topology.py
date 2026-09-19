"""WHAT IS DRAWN IS THE GRAPH'S TO DECIDE, SO A TRAJECTORY STEPS WITHOUT A
BUILD.

    python3 tests/stick_topology.py [_traj_3ptb.pdb]

The station fast path keeps the mesh and rewrites station geometry, and it can
only do that while the station, piece and face counts hold. Two rules in
cartoon/geom.js used to ask the DRAWN FRAME questions whose answers are
topology, so every step moved the counts and every step rebuilt:

  * how many pieces a stick is cut into - it was cut until no piece twisted
    more than 18 degrees, and twist is measured per frame;
  * whether a junction is mitred - "no leg is cut back more than 0.35 of its
    length", also measured per frame, and a mitred junction emits two shared
    end polygons where an abandoned one emits none.

Measured on a 25-frame AlphaFold 3 fold with every side chain shown, before:
20 of 24 steps rebuilt with "the station mapping moved", the stations swinging
942 to 976 while the RIBBON held at 930 faces on every frame. The number of
mitred junctions swung 38 to 56, and the stations were exactly 904 plus that.

Now the cut is CLAMPED rather than abandoned and the twist term is gone, so the
counts follow the bond graph, which no frame can move.

🔴 IT IS THE GENERAL GUARD, NOT A CHECK PER RULE. Everything that decides how
many faces, stations or pieces the mesh has belongs to the STRUCTURE; anything
that decides where they are belongs to the FRAME (docs/DRAW_GRAPH.md). This
walks four tracked trajectories - a protein with a ligand and disulfides, an
RNA, a DNA duplex, a ligand-heavy protein - with side chains hidden and shown,
and asks the property directly. A rule added later that asks the drawn frame a
counting question fails here whatever subsystem it is in.

🔴 AND TWO MORE RULES CAME OUT THE SAME WAY, NEITHER OBSERVABLE HERE. A
mitred leg welded one of its four cut corners to each neighbour's, chosen by a
NEAREST-OF-FOUR search between points about 0.03 A apart; and two bonds of a
run shared a section only while `reach > 0.30 * min(lenL, lenR)` was false.
Both are angles, so both move with the frame. Measured on an AlphaFold 3 fold
whose 43-atom ligand is still diffusing: the same 70 junctions and 140 pairings
on every frame with about eight pairings flipping per step, and of the ten
stations that reach the reach test between 0 and 10 firing per frame - the
ratio swinging 0.75 to 34. The ligand's 444 faces then carried anywhere from
443 to 692 outline edges, `refreshSticksFrom` refused the part, and 9 of 9
steps rebuilt the whole mesh. With the pairing fixed by the junction's own
handedness and the section NARROWED rather than skipped: 0 of 9.

🔴 ONE OF THE TWO IS GATED NOW, BY A FIXTURE BUILT FOR IT.
`_traj_patho_3chy.pdb` (`emit_pathological` in tests/make_traj.py) is a
breathing protein with a seven-atom ligand welded on whose BOND GRAPH IS
PINNED BY `CONECT` - `core/mol.js` skips the distance pass for a ligand every
atom of which a file bond touches, so the geometry can be as unphysical as the
question needs without a bond appearing. Half of it is a V whose apex angle
sweeps 40 to 90 degrees, crossing the 58 degrees at which a run station's
shared section would have been skipped: **1 then 2 of 11 steps rebuild with
the skip restored, 0 with the section always emitted.**

🔴 THE OTHER HALF OF THAT LIGAND CATCHES NOTHING, AND THAT IS A FINDING. It is
a three-leg junction with one leg swinging, and the point was the mitre's
corner pairing - which the nearest-of-four search chose per frame. Three
geometries were built and measured (evenly spaced in a plane; uneven azimuths
off the plane; legs of three different lengths so the 0.35 cut clamps
differently on each), and in every one the search picks the SAME pair the
handedness rule does, on every frame: the pairings read `1:0` and `2:3`
throughout. A stick's section is square (`STICK_HW` 0.25 against a half
thickness of 0.25), so with equal legs the nearest corner is decided by the
side the neighbour is on and there is no tie to lose. The flips measured on
the reported fold - about eight of 140 pairings a step - come out of junctions
`mergeBondRuns` builds along real runs, with mitre planes and rolls carried
from bond to bond, and nothing assembled atom by atom here reproduces that.
The junction stays in the fixture because its count is asserted below (83
mitred junctions on every frame) and because the four-leg planarity gate in
`docs/OPEN_WORK.md` 11 would show up here if it ever fires.

🔴 NO TRACKED FIXTURE MOVES THE PAIRING, AND FOUR MORE WERE TRIED. `emit`'s breathing
preserves bond angles by construction, which is the whole point of it, so: a
per-atom jitter of 1HVR at +/-0.25 A fires neither rule, and at +/-0.6 A the
BOND GRAPH moves (9 shapes over 10 frames) with or without the fix, which is a
different fault; jittering 3PTB's benzamidine alone up to +/-0.5 A never fires
them either, because a planar ring's mitres are not close-run; a synthetic
hinge ligand welded onto a protein trajectory declined for a reason of its own
at the time - "the tail is not just sticks", which turned out to be a REAL
fault in refreshSticksFrom and is fixed (see tests/station_ligand.py); and the
fixtures carry a real ligand now, which is what exposed that one, and BOTH
mutations still pass against them. So this file asks the general property, the
numbers above are the evidence, and the session they came from is not in the
repo.

🔴 WHAT IS NOT IN THE LIST, AND WHY: `_traj_unfold.pdb`. Its frames genuinely
differ in POSITION COUNT (597 -> 587, and the segments with them), so they are
different structures and rebuilding them is right. Check the position count
before filing a rebuild as a bug.

WHAT THIS ASKS, with side chains shown on a real trajectory:

  1. THE COUNTS HOLD. Every frame builds to the same stations, pieces and
     faces. This is the property; the rebuild count below is what it buys.
  2. NO STEP REBUILDS, over two passes - the second because a rule that
     merely CONVERGES (a memo that grows) passes one pass and not two. Both
     memo-based fixes were written, measured at 17-18 rebuilds a pass, and
     removed in favour of the rules above.
  3. AND HOW MANY JUNCTIONS ARE MITRED, which is the second rule's own answer.
     🔴 IT IS ASKED SEPARATELY BECAUSE THE TRACKED FIXTURES CANNOT SEE IT ANY
     OTHER WAY: restoring the abandon (mutation B) leaves _traj_3ptb.pdb at one
     shape and 0 rebuilds - none of its junctions crosses the 0.35 test - and
     on _traj_unfold.pdb the counts move with or without it, because there the
     RIBBON's own letters are changing. The session that reported this is not
     in the repo; its numbers are in the header above.
  4. AND THE PICTURE IS A REBUILD'S, which is asserted with the side chains
     HIDDEN and only REPORTED with them shown.
     🔴 THAT SPLIT IS A KNOWN FAULT THIS FIX EXPOSED, NOT A CONVENIENCE. Until
     the rules above, a side chain meant a rebuild on every step, so the fast
     path's own drawing of side-chain sticks was never reached. Now it is, and
     on _traj_1ehz.pdb the last step differs from a rebuild of the same frame
     by about 1% of the canvas - all of it side-chain sticks: hide them and the
     difference is EXACTLY 0. `refreshSticksFrom` is not refusing, so the rows
     are being rewritten and still do not match. On _traj_3ptb.pdb the same
     comparison is 33 px. Unfixed; see docs/FASTPATH_ARTIFACTS.md.
"""
import json, os, subprocess, sys, shutil, http.server, socketserver, threading, functools

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DEBUG_PORT = 9993, 9994
PROBE = os.path.join(ROOT, "_sticktopo.html")
FILES = sys.argv[1:] or ["_traj_3ptb.pdb", "_traj_1ehz.pdb",
                         "_traj_1bna.pdb", "_traj_1hvr.pdb",
                         "_traj_patho_3chy.pdb"]

# ...and the recipes, because one of them is not `make_traj.py SOURCE.cif`.
# `_traj_patho_3chy.pdb` is a breathing protein with a LIGAND built to break
# these rules: see emit_pathological there and the note below.
_RECIPE = {"_traj_patho_3chy.pdb": ["--pathological", "--models=24", "3CHY.cif"]}
for _f in FILES:
    if not os.path.exists(os.path.join(ROOT, _f)):
        subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py"),
                        *_RECIPE.get(_f, [_f.replace("_traj_", "").replace(".pdb", "").upper()
                                          + ".cif"])],
                       cwd=ROOT, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

JS = """(async () => {
  //HELPERS
  const G = window.py2dmolCartoonGPU;
  const out = [];
  for (const FILE of %FILES%) {
  if (window.clearAllObjects) window.clearAllObjects();
  await settle(3);
  const t = await (await fetch('/' + FILE)).text();
  await window.processFiles([{name: FILE, readAsync: () => Promise.resolve(t)}], true);
  await until(loaded, 120000);
  const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
  await until(() => r.coords && r.coords.length > 0, 60000);
  await settle(8);
  r.autoRotate = false; r.cartoonPencil = 0;
  if (r.setStyle) r.setStyle('cartoon');
  await settle(6);
  // ...tolerated, because a C-alpha trace HAS no side chains and its topology
  // is still worth asking about. What must not be tolerated is measuring
  // nothing, which is why the count of positions is reported beside it.
  try { r.showSidechains(); } catch (e) { /* a trace carries none */ }
  await settle(10);
  if (G.setStationDraw) G.setStationDraw(true);
  const nF = Math.min(12, r.objectsData[r.currentObjectName].frames.length);
  // 1. the counts a fresh build of each frame produces
  const shapes = []; const joints = []; const pairSigs = [];
  for (let f = 0; f < nF; f++) {
    r._jointProbe = [];
    r.setFrame(f); if (G.invalidate) G.invalidate(); r.render('fresh'); await settle(4);
    const s = G.stationsResident();
    shapes.push(s ? [s.stations, s.pieces, s.count] : null);
    // ...and WHICH junctions were mitred, which is the second rule's own
    // answer rather than a count it happens to move. Distinct atoms, not
    // entries: geom runs more than once per frame (the capture, then the
    // build), so the probe collects each junction as many times as it ran.
    joints.push(new Set(r._jointProbe.map((e) => e.at)).size);
    r._jointProbe = null;
    // ...and the nucleic pair graph, which decides how many base plates there
    // are and so belongs to the same question. See the docstring.
    {
      const pr = r._cartoonPair; let c = 0, sig = 0;
      if (pr) for (let i = 0; i < pr.length; i++) if (pr[i] >= 0) { c++; sig = (sig * 31 + i * 7 + pr[i]) >>> 0; }
      pairSigs.push(c + ':' + sig);
    }
  }
  // 2. and what stepping costs, twice over
  const px = () => { const c = r.canvas; return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
  r.setFrame(0); if (G.invalidate) G.invalidate(); r.render('base'); await settle(5);
  const pass = async () => {
    const b0 = window.__faceBuilds || 0;
    for (let f = 1; f < nF; f++) { r.setFrame(f); r.render('step'); await settle(3); }
    return (window.__faceBuilds || 0) - b0;
  };
  const one = await pass(), two = await pass();
  // 3. ...and the picture the last step drew, against a rebuild of it - with
  // the side chains SHOWN (reported) and HIDDEN (asserted). See the docstring.
  const compare = async () => {
    r.setFrame(0); if (G.invalidate) G.invalidate(); r.render('base'); await settle(4);
    for (let f = 1; f < nF; f++) { r.setFrame(f); r.render('step'); await settle(3); }
    const fast = px();
    if (G.invalidate) G.invalidate(); r.render('fresh'); await settle(4);
    const fresh = px();
    let d = 0, k = 0;
    for (let i = 0; i < fast.length; i += 4) {
      if (Math.max(Math.abs(fast[i]-fresh[i]), Math.abs(fast[i+1]-fresh[i+1]),
                   Math.abs(fast[i+2]-fresh[i+2])) > 40) d++;
      if (fresh[i] + fresh[i+1] + fresh[i+2] < 600) k++;
    }
    return [d, k];
  };
  const [diff, ink] = await compare();
  try { r.hideSidechains(); } catch (e) {}
  await settle(8);
  const [diffBare, inkBare] = await compare();
  out.push({file: FILE, shapes, joints, pairSigs, pass1: one, pass2: two, frames: nF,
            diff, ink, diffBare, inkBare, total: px().length / 4, sidechains: r.coords.length,
            pairs: (() => { const pr = r._cartoonPair; if (!pr) return null;
              let c = 0, sig = 0;
              for (let i = 0; i < pr.length; i++) if (pr[i] >= 0) { c++; sig = (sig * 31 + i * 7 + pr[i]) >>> 0; }
              return c + ':' + sig; })()});
  }
  return JSON.stringify(out);
})()"""
JS = JS.replace("//HELPERS", HELPERS).replace("%FILES%", json.dumps(FILES))

open(PROBE, "w").write(open(os.path.join(ROOT, "dev.html")).read())
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT),
                               functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome = None
try:
    chrome, ws = cdp.launch(DEBUG_PORT, "/tmp/py2dmol-sticktopo")
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Emulation.setDeviceMetricsOverride", width=1200, height=1000,
            deviceScaleFactor=1, mobile=False)
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_sticktopo.html")
    cdp.wait_for(ws, "typeof window.processFiles === 'function'", timeout=120, what="dev.html")
    out = json.loads(cdp.evaluate(ws, JS))
finally:
    if chrome: chrome.kill()
    httpd.shutdown()
    shutil.rmtree("/tmp/py2dmol-sticktopo", ignore_errors=True)
    try: os.remove(PROBE)
    except OSError: pass

bad = []
for row in out:
    shapes = [tuple(x) if x else None for x in row["shapes"]]
    distinct = sorted(set(shapes))
    joints = sorted(set(row["joints"]))
    pairs = sorted(set(row["pairSigs"]))
    name = row["file"]
    print(f"  {name}: {row['frames']} frames, {row['sidechains']} positions with side chains")
    print(f"    (stations, pieces, faces): {len(distinct)} distinct - {distinct[:3]}")
    print(f"    mitred junctions: {joints}    base pairs: {[p.split(':')[0] for p in pairs]}")
    print(f"    steps that rebuilt: {row['pass1']} then {row['pass2']}")
    print(f"    last step against a rebuild of it: {row['diffBare']} of {row['total']} px"
          f" (ink {row['inkBare']}), and {row['diff']} with side chains shown")

    if not shapes or shapes[0] is None:
        bad.append(f"{name}: no station table was installed - this measured nothing")
    elif len(distinct) > 1:
        bad.append(f"{name}: the mesh has {len(distinct)} shapes over {row['frames']}"
                   f" frames ({distinct}) - something in the geometry is deciding"
                   " topology, so every step that moves it must rebuild")
    if len(joints) > 1:
        bad.append(f"{name}: the number of mitred junctions moves between frames"
                   f" ({joints}) - a junction is mitred or not by a test on the drawn"
                   " frame, and a mitred one emits two end polygons the other does not")
    if len(pairs) > 1:
        bad.append(f"{name}: the base pairing moves between frames ({pairs}) - which"
                   " bases pair is predicted from the drawn frame, and a base plate"
                   " is emitted per pair")
    if row["pass1"] or row["pass2"]:
        bad.append(f"{name}: {row['pass1']} then {row['pass2']} of {row['frames'] - 1}"
                   " steps rebuilt with side chains shown")
    if row["inkBare"] < 2000:
        bad.append(f"{name}: only {row['inkBare']} px of ink - the comparison ran on"
                   " an empty picture")
    elif row["diffBare"] > row["total"] * 0.01:
        bad.append(f"{name}: the fast step draws {row['diffBare']} of {row['total']} px"
                   " differently from a rebuild of the same frame")

for b in bad:
    print("FAIL: " + b)
print("stick topology: " + ("FAILED" if bad else "the graph decides it, and a step costs no build"))
sys.exit(1 if bad else 0)
