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
  const box = document.querySelector('.py2dmol-slot--big > .py2dmol-slot-body')
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

if bad:
    for b in bad: print('FAIL:', b)
    sys.exit(1)
print('station ligand: ok')
