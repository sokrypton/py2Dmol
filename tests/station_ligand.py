"""A ligand does not cost the trajectory fast path.

    python3 tests/station_ligand.py

🔴 THE MESH IS RIBBON, THEN SIDE CHAINS, THEN `other` - ligands, base plates,
contacts - AND THE STATION TABLE DESCRIBES A PREFIX OF IT. A ligand's sticks
are four-sided like a side chain's, so cartoon/geom.js stationed them and the
table counted them; they build into `other`, which is not in that prefix, so
installStations refused the table outright:

    the station table describes 4298 faces and the mesh holds 4150

The cost was the whole trajectory fast path for ANY structure with a ligand in
it - every frame a full rebuild, for good, because the auto-enable then gives
up. Measured on a real 41-model diffusion trajectory with a bound peptide: 40
of 41 steps rebuilt, seven of them over 25 ms, against 2 with this fixed. The
limitation was known and written into paintgl.js as a note; the fix is to
station only what the prefix can hold, which is the side chains' own sticks and
the junction plates welded to them.

WHAT THIS ASKS:

  1. THE TABLE INSTALLS on structures with a ligand - 3PTB's benzamidine,
     4HHB's four hemes - with and without side chains shown. 1UBQ is the
     control: no ligand, and it installed before this existed.
  2. A TRAJECTORY OF ONE STEPS WITHOUT REBUILDING. _traj_3ptb.pdb is the
     breathing fixture, so its topology holds and every step should be
     stations-only.
  3. 🔴 AND THE PICTURE IS THE SAME AS A REBUILD'S. The path now runs where it
     never ran before, so "it is faster" is worth nothing on its own: one frame
     is drawn both ways and compared pixel for pixel.
  4. AND AT A ZOOM THE MESH WAS NOT BUILT AT, because the tail is rebuilt by
     UNPROJECTING this frame's capture and the scale that projected it is the
     one to divide by. Given the BUILD's instead, every tail coordinate came
     out multiplied by live/built - invisible at zoom 1, where the two are
     equal, and 3,563 px of this fixture at zoom 3.
  5. AND WITH SIDE CHAINS AND THE LIGAND BOTH UP, which is the other part
     ORDER: ribbon, side chains, other. Read as the first order the station
     coverage is measured against the wrong parts and every step refuses -
     12 of 12 here, and on the fold it was reported from the auto-enable then
     gave the object up and the whole trajectory ran on rebuilds.
  6. AND AFTER A HIDE AND A SHOW, which RESTORES a cached mesh rather than
     building one: the order travels with the mesh or the restore is read with
     the last build's. Exactly one rebuild when it does not, so this leg asks
     for zero.

🔴 THE FIXTURE ONLY HAS A LIGAND BECAUSE `tests/make_traj.py` LEARNED TO WRITE
`HETATM`. It wrote `ATOM` for every row, so 3PTB's benzamidine came back as
nine protein residues and the mesh's third part - the tail this whole file is
about - was EMPTY: parts `[3554, 0, 0]`. Legs 4, 5 and 6 all measure nothing
without it, which is why each of them asserts its own part spans first.
"""
import json, os, shutil, subprocess, sys, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationligand.html")
PORT, DEBUG_PORT = 9807, 9808
TRAJ = "_traj_3ptb.pdb"

if not os.path.exists(os.path.join(ROOT, TRAJ)):
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py"),
                    "3PTB.cif"], cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

JS = """
  //HELPERS
  const G = window.py2dmolCartoonGPU;
  const R = () => window.py2dmol_viewers['standalone-viewer-1'].renderer;
  const load = async (name) => {
    const txt = await (await fetch('/' + name)).text();
    await window.processFiles([{name, readAsync: () => Promise.resolve(txt)}], false);
    await until(loaded, 15000);
    await settle(6);
  };
  // A STATION TABLE IS INSTALLED OR IT IS NOT, and the refusal says why.
  const tableState = () => ({
    stations: G.stationsResident() ? G.stationsResident().stations : null,
    parts: G.partSpans(),
    refusal: String(G.stationRefusal() || '').slice(0, 130),
  });
  const rebuildTable = async () => {
    G.clearResident(); G.clearResidentStations();
    if (G.setStationDraw) G.setStationDraw(true);
    R().render('probe'); await settle(2);
    R().render('probe'); await settle(3);
    return tableState();
  };
  const ink = () => {
    const c = R().canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return d;
  };
  const out = { errors: [] };

  // ---- 1. the table installs where a ligand is ----
  out.statics = {};
  for (const f of ['3PTB.cif', '4HHB.cif', '1UBQ.cif']) {
    await load(f);
    out.statics[f] = await rebuildTable();
    // ...and again with the side chains out, which is the case where the
    // table has to cover TWO parts rather than one.
    try { R().showSidechains(); } catch (e) { out.errors.push(f + ': ' + e.message); }
    await settle(4);
    out.statics[f + ' +sidechains'] = await rebuildTable();
    if (window.clearAllObjects) window.clearAllObjects();
    await settle(2);
  }

  // ---- 2. a trajectory of one does not rebuild ----
  await load('%TRAJ%');
  const r = R();
  await rebuildTable();
  const nF = Math.min(12, r.objectsData[r.currentObjectName].frames.length);
  const before = window.__faceBuilds || 0;
  for (let k = 0; k < nF; k++) { r.setFrame(k); r.render('step'); await settle(2); }
  out.traj = { frames: nF, builds: (window.__faceBuilds || 0) - before,
               table: tableState() };

  // ---- 3. and it draws what a rebuild draws ----
  // ...at a size worth comparing: index.html/dev.html keep the viewer hidden
  // until something loads, and the canvas is measured while it is.
  const box = document.querySelector('.py2dmol-slot--1 > .py2dmol-slot-body')
    || document.getElementById('canvasContainer');
  if (box) { box.style.width = '600px'; box.style.height = '600px'; }
  await settle(8);
  r.setFrame(3); r.render('step'); await settle(3);
  const fast = ink();
  if (r.invalidate) r.invalidate();
  G.clearResident(); G.clearResidentStations();
  r.render('forced rebuild'); await settle(4);
  const slow = ink();
  let diff = 0, worst = 0;
  for (let i = 0; i < fast.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(fast[i + k] - slow[i + k]);
      if (d > worst) worst = d;
      if (d > 8) { diff++; break; }
    }
  }
  // 🔴 AND HOW BIG THE PICTURE WAS. A comparison on a 100x100 canvas is two
  // blank frames agreeing; dev.html opens its viewer hidden, so the size has
  // to be asserted rather than assumed.
  out.pixels = { diff, total: fast.length / 4, worst,
                 canvas: [R().canvas.width, R().canvas.height] };

  // ---- 4. ...AND AT A ZOOM THE MESH WAS NOT BUILT AT ----
  // 🔴 THE TAIL IS REBUILT BY UNPROJECTING THIS FRAME'S CAPTURE, and unproject
  // divides by the scale that projected it. Handed the scale of the BUILD
  // instead of the capture's own, every tail coordinate came out multiplied by
  // live/built - so the ligand was thrown that many times further from the
  // centre the moment a frame was stepped at any zoom but the one the mesh was
  // built at. Reported as distortion after zooming in, playing, and zooming
  // out. Invisible at zoom 1, where the two scales are equal, which is why
  // every check above passed against it: 11,218 of 498,436 pixels at zoom 3 on
  // the fold it was reported from.
  await rebuildTable();
  r.setFrame(2); r.render('at build zoom'); await settle(3);
  const zBase = window.__faceBuilds || 0;
  r.viewerState.zoom = 3.0;
  r.setFrame(5); r.render('stepped while zoomed'); await settle(3);
  const zFast = ink();
  // ...and whether that step was a BUILD, which would compare a rebuild with
  // a rebuild and could not fail. The zoom is not in the mesh's signature, so
  // it should be 0; the stick LOD's own term can legitimately make it 1.
  const zBuilt = (window.__faceBuilds || 0) - zBase;
  if (r.invalidate) r.invalidate();
  G.clearResident(); G.clearResidentStations();
  r.render('forced rebuild'); await settle(4);
  const zSlow = ink();
  let zDiff = 0, zWorst = 0;
  for (let i = 0; i < zFast.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(zFast[i + k] - zSlow[i + k]);
      if (d > zWorst) zWorst = d;
      if (d > 8) { zDiff++; break; }
    }
  }
  // ...and that the zoomed frame was taken on the FAST path, or this compares
  // a rebuild with a rebuild and cannot fail.
  out.zoomed = { diff: zDiff, total: zFast.length / 4, worst: zWorst,
                 builtWhileZoomed: zBuilt,
                 zoom: r.viewerState.zoom, table: tableState() };

  // ---- 5. A LIGAND *AND* SIDE CHAINS, which is a different mesh ORDER ----
  // 🔴 The parts are ribbon, SIDE CHAINS, other when the side chains are
  // stationed, and ribbon, other, side chains when they are not - so a span
  // index means two different parts. refreshSticksFrom read span 0 as the
  // whole station-covered prefix and spans 1 and 2 as the sticks to rebuild,
  // which is only the second order: with both a ligand and side chains it
  // refused every frame ("stations cover 2702 faces and the ribbon part holds
  // 930"), and after twelve of those the auto-enable gave the object up and
  // the trajectory ran on rebuilds for good. 25 of 25 steps, measured on the
  // fold it was reported from.
  r.viewerState.zoom = 1;
  try { r.showSidechains(); } catch (e) { /* a trace carries none */ }
  await settle(10);
  await rebuildTable();
  const scBefore = window.__faceBuilds || 0;
  for (let k = 0; k < nF; k++) { r.setFrame(k); r.render('sc step'); await settle(2); }
  out.sidechains = { frames: nF, builds: (window.__faceBuilds || 0) - scBefore,
                     positions: r.coords.length, table: tableState(),
                     spans: G.partSpans ? G.partSpans() : null };

  // ---- 6. AND THE ORDER TRAVELS WITH A CACHED MESH ----
  // 🔴 A MESH IS CACHED AND RESTORED WHOLE (restoreMesh, by signature) and the
  // layout is a MODULE flag, so a restore leaves whichever order the last
  // BUILD had. Show the side chains, hide them, show them again: the third
  // step restores the first mesh - stationed side chains, ligand in the tail -
  // while the flag still says what the second build set. The spans are then
  // read as the other order and every step refuses. Same shape as the `edSrc`
  // note in captureMesh: a restored mesh must not be read with the previous
  // mesh's provenance.
  try { r.hideSidechains(); } catch (e) {}
  await settle(8);
  r.setFrame(1); r.render('no side chains'); await settle(4);
  try { r.showSidechains(); } catch (e) {}
  await settle(8);
  r.setFrame(2); r.render('side chains again'); await settle(4);
  const reBefore = window.__faceBuilds || 0;
  for (let k = 3; k < nF; k++) { r.setFrame(k); r.render('after restore'); await settle(2); }
  out.restored = { frames: nF - 3, builds: (window.__faceBuilds || 0) - reBefore,
                   spans: G.partSpans ? G.partSpans() : null,
                   table: tableState() };
"""
JS = JS.replace('//HELPERS', HELPERS).replace('%TRAJ%', TRAJ)

src = open(os.path.join(ROOT, 'dev.html')).read()
open(PROBE, 'w').write(src)


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()

proc = ws = None
R = {}
try:
    proc, ws = cdp.launch(DEBUG_PORT, '/tmp/py2dmol-station-ligand')
    ws.call('Page.enable'); ws.call('Runtime.enable')
    ws.call('Emulation.setDeviceMetricsOverride', width=1200, height=1000,
            deviceScaleFactor=1, mobile=False)
    ws.call('Page.navigate', url='http://127.0.0.1:%d/_stationligand.html' % PORT)
    cdp.wait_for(ws, "typeof window.processFiles === 'function'",
                 what="dev.html to load")
    R = cdp.evaluate(ws, '(async () => {\n' + JS + '\nreturn out; })()') or {}
finally:
    if proc: proc.kill()
    httpd.shutdown()
    if os.path.exists(PROBE): os.remove(PROBE)
    shutil.rmtree('/tmp/py2dmol-station-ligand', ignore_errors=True)

bad = list(R.get('errors') or [])
for name, st in (R.get('statics') or {}).items():
    print(f"  {name:24s} stations={st['stations']} parts={st['parts']}"
          f" {st['refusal']}")
    if not st['stations']:
        bad.append(f"{name}: no station table - {st['refusal'] or 'no reason given'}")

tr = R.get('traj') or {}
print(f"  {TRAJ}: {tr.get('builds')} rebuilds over {tr.get('frames')} steps,"
      f" table {(tr.get('table') or {}).get('stations')}")
if not tr.get('frames'):
    bad.append("the trajectory leg measured nothing")
elif (tr.get('builds') or 0) > 1:
    bad.append(f"{tr.get('builds')} of {tr.get('frames')} steps rebuilt a"
               " structure whose topology holds - a ligand is not a reason to"
               " rebuild the ribbon")

px = R.get('pixels') or {}
print(f"  fast path against a forced rebuild: {px.get('diff')} of"
      f" {px.get('total')} pixels differ, worst channel {px.get('worst')}")
zm = R.get('zoomed') or {}
print(f"  stepped at zoom {zm.get('zoom')}: {zm.get('diff')} of"
      f" {zm.get('total')} pixels differ, worst channel {zm.get('worst')},"
      f" builds {zm.get('builtWhileZoomed')}")
if (zm.get('builtWhileZoomed') or 0) > 1:
    bad.append(f"the zoomed step rebuilt {zm.get('builtWhileZoomed')} times, so"
               " it compared a rebuild with a rebuild and could not fail")
if not (zm.get('table') or {}).get('stations'):
    bad.append("the zoomed leg had no station table, so it compared a rebuild"
               f" with a rebuild: {(zm.get('table') or {}).get('refusal')}")
if (zm.get('diff') or 0) > 400:
    bad.append(f"a frame stepped at zoom {zm.get('zoom')} differs from a"
               f" rebuild of itself by {zm.get('diff')} pixels - the tail is"
               " unprojected at the scale of the BUILD rather than at the"
               " capture's own")
print(f"  canvas {px.get('canvas')}")
if not px.get('total'):
    bad.append("the picture was never compared")
elif min(px.get('canvas') or [0, 0]) < 250:
    bad.append(f"the comparison ran on a {px.get('canvas')} canvas - too small"
               " to say two drawings agree")
elif (px.get('diff') or 0) > px.get('total', 1) * 0.01:
    bad.append(f"the station path draws {px['diff']} of {px['total']} pixels"
               " differently from a rebuild of the same frame - the steps are"
               " cheap and the picture is wrong, which is worse than rebuilding")


rs = R.get('restored') or {}
print(f"  after hide/show (a cached mesh): {rs.get('builds')} rebuilds over"
      f" {rs.get('frames')} steps, parts {rs.get('spans')}")
spans_r = rs.get('spans') or []
if len(spans_r) < 3 or not spans_r[1] or not spans_r[2]:
    bad.append(f"the restore leg measured nothing: parts {spans_r}")
elif (rs.get('builds') or 0) > 0:
    # 🔴 ZERO, NOT "AT MOST ONE". The stale flag costs exactly ONE rebuild -
    # the refusal rebuilds, and that build sets the flag correctly - so a
    # tolerance of one is a tolerance of the whole fault.

    bad.append(f"{rs.get('builds')} of {rs.get('frames')} steps rebuilt after"
               " the side chains came back - a restored mesh is being read"
               " with the last BUILD's part order")

sc = R.get('sidechains') or {}
print(f"  with side chains out: {sc.get('builds')} rebuilds over"
      f" {sc.get('frames')} steps, {sc.get('positions')} positions,"
      f" parts {sc.get('spans')}")
spans = sc.get('spans') or []
if len(spans) < 3 or not spans[1] or not spans[2]:
    bad.append(f"the side-chain leg measured nothing: parts {spans} - it needs"
               " a stationed side-chain part AND a ligand tail to be the case"
               " it exists for")
elif (sc.get('builds') or 0) > 1:
    bad.append(f"{sc.get('builds')} of {sc.get('frames')} steps rebuilt with a"
               " ligand and side chains both on screen - the station-covered"
               " prefix is two parts in that order, not one")

if bad:
    for b in bad: print('FAIL:', b)
    sys.exit(1)
print('station ligand: ok')
