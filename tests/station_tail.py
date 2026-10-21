"""A trajectory's contacts and plugin lines follow it on the station fast path.

    python3 tests/station_tail.py

The station path rewrites the ribbon and the side chains from the station
table and rebuilds the TAIL - the `other` part: ligands, base plates,
contacts, plugin prims - from this frame's capture with refreshSticksFrom. It
asked for that rebuild only when the tail held FILL rows (`tail > 0`), and a
contact or a plugin line is all EDGES: the outline instances, no fill. So on a
structure with no ligand the tail was never rebuilt and every contact and
every plugin line stayed where the mesh was built, while the ribbon moved on
underneath them.

🔴 A LIGAND HIDES IT. 3PTB's benzamidine puts fill rows in the tail, so the
tail is rebuilt every step anyway and the contacts ride along: on
`_traj_3ptb.pdb` the old gate measured exactly as the new one. That is why
this probe steps `_traj_1tim.pdb`, which has no HETATM at all.

WHAT THIS ASKS, each leg stepping six frames on the fast path and then
comparing the last against a forced rebuild of the same frame:

  1. BARE - nothing in the tail. Its difference is the noise floor the other
     two are measured against (tie-break speckle, see CLAUDE.md).
  2. CONTACTS - two contacts across the structure. Mutated back to the
     fill-only gate: 1,890 px against 10 bare.
  3. A PLUGIN LINE THAT FOLLOWS THE FRAME - its key names the frame, so the
     signature moves every step. Mutated back: 4,316 px. AND IT TAKES NO
     REBUILD: the plugin key is in `sig` and not in the TOPOLOGICAL key, so
     a per-frame plugin is a tail refresh, not a new mesh. With the key back
     in the topological key, 6 of 6 steps rebuilt.

Each leg also asserts it DREW something (its picture against the bare one),
or a comparison of two pictures without a contact in them would pass.
"""
import json, os, shutil, subprocess, sys, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationtail.html")
PORT, DEBUG_PORT = 9877, 9878
TRAJ = "_traj_1tim.pdb"

if not os.path.exists(os.path.join(ROOT, TRAJ)):
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py")],
                   cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

JS = """
  //HELPERS
  const G = window.py2dmolCartoonGPU;
  const R = () => window.py2dmol_viewers['standalone-viewer-1'].renderer;
  const ink = () => { const c = R().canvas;
    return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
  const cmp = (a, b) => { let d = 0;
    for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++)
      if (Math.abs(a[i + k] - b[i + k]) > 8) { d++; break; }
    return d; };
  const rebuildTable = async () => {
    G.clearResident(); G.clearResidentStations();
    if (G.setStationDraw) G.setStationDraw(true);
    R().render('probe'); await settle(2); R().render('probe'); await settle(3);
  };
  const txt = await (await fetch('/%TRAJ%')).text();
  await window.processFiles([{name: '%TRAJ%', readAsync: () => Promise.resolve(txt)}], false);
  await until(loaded, 15000); await settle(6);
  const r = R();
  // dev.html opens its viewer hidden; a comparison on a tiny canvas is two
  // blank frames agreeing
  const box = document.querySelector('.py2dmol-slot--1 > .py2dmol-slot-body')
    || document.getElementById('canvasContainer');
  if (box) { box.style.width = '600px'; box.style.height = '600px'; }
  await settle(8);
  const out = { canvas: [r.canvas.width, r.canvas.height] };
  let bare = null;
  const leg = async (label) => {
    r.setFrame(0); await rebuildTable();
    const b0 = window.__faceBuilds || 0;
    for (let k = 1; k <= 6; k++) { r.setFrame(k); r.render('step'); await settle(2); }
    const builds = (window.__faceBuilds || 0) - b0;
    const fast = ink();
    if (!bare) bare = fast;
    if (r.invalidate) r.invalidate();
    G.clearResident(); G.clearResidentStations();
    r.render('forced rebuild'); await settle(4);
    const sr = G.stickRefresh ? G.stickRefresh() : null;
    out[label] = { builds, diff: cmp(fast, ink()), drawn: cmp(fast, bare),
                   refresh: sr ? String(sr.why || 'ok') : null };
  };
  await leg('bare');
  const obj = r.objectsData[r.currentObjectName];
  const n = r.coords.length;
  obj.contacts = [[5, n - 5, 1.0], [40, n - 60, 1.0]];
  r.setFrame(0); r.render('contacts'); await settle(3);
  await leg('contacts');
  obj.contacts = null; r.setFrame(0); r.render('no contacts'); await settle(3);
  const P = window.py2dmolPlugins;
  P.register({ name: 'follow', version: '1', apiVersion: 1, options: {},
    key(ctx) { return 'f' + ctx.frame; },
    prims(ctx) {
      const o = ctx.renderer.objectsData[ctx.renderer.currentObjectName];
      const c = o.frames[ctx.frame].coords;
      // the far end travels 3 A a frame: the fixture breathes by half an
      // Angstrom, which a frozen line hides inside its own width
      const e = c[c.length - 5];
      ctx.line(c[5], [e[0] + 3 * ctx.frame, e[1], e[2]], {color: '#ff00ff', width: 1.5});
    } });
  P.setPayload(r, 'follow', {});
  r.render('plugin'); await settle(3);
  await leg('plugin');
  return out;
"""
JS = JS.replace('//HELPERS', HELPERS).replace('%TRAJ%', TRAJ)

open(PROBE, 'w').write(open(os.path.join(ROOT, 'dev.html')).read())


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
proc = ws = None
R = {}
try:
    proc, ws = cdp.launch(DEBUG_PORT, '/tmp/py2dmol-station-tail')
    ws.call('Page.enable'); ws.call('Runtime.enable')
    ws.call('Emulation.setDeviceMetricsOverride', width=1200, height=1000,
            deviceScaleFactor=1, mobile=False)
    ws.call('Page.navigate', url='http://127.0.0.1:%d/_stationtail.html' % PORT)
    cdp.wait_for(ws, "typeof window.processFiles === 'function'",
                 what="dev.html to load")
    R = cdp.evaluate(ws, '(async () => {\n' + JS + '\n})()') or {}
finally:
    if proc: proc.kill()
    httpd.shutdown()
    if os.path.exists(PROBE): os.remove(PROBE)
    shutil.rmtree('/tmp/py2dmol-station-tail', ignore_errors=True)

bad = []
print(f"  {TRAJ} on a {R.get('canvas')} canvas")
for k in ('bare', 'contacts', 'plugin'):
    row = R.get(k) or {}
    print(f"  {k:9s} builds={row.get('builds')} against a rebuild: {row.get('diff')} px"
          f"  drawn: {row.get('drawn')} px  refresh: {row.get('refresh')}")
cw, ch = R.get('canvas') or [0, 0]
if cw * ch < 300 * 300:
    bad.append(f"the canvas was {cw}x{ch}, too small for a comparison to mean anything")
floor = (R.get('bare') or {}).get('diff', 0)
for k in ('contacts', 'plugin'):
    row = R.get(k) or {}
    if (row.get('drawn') or 0) < 300:
        bad.append(f"{k}: the leg drew {row.get('drawn')} px more than the bare one,"
                   " so it compared two pictures without the thing it is about")
    elif row.get('diff', 0) > floor + 500:
        bad.append(f"{k}: the fast step draws {row.get('diff')} px differently from a"
                   f" rebuild of the same frame (bare: {floor}) - the tail stayed where"
                   " the mesh was built")
if ((R.get('plugin') or {}).get('builds') or 0) > 0:
    bad.append(f"a plugin keyed on the frame rebuilt the mesh on"
               f" {R['plugin']['builds']} of 6 steps - its key is in the topological key")

for b in bad:
    print("FAIL: " + b)
print("station tail: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
