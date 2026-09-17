"""Two slots, every view, and nothing paid twice.

    python3 tests/slots.py

src/parts/slots.js turns the viewer's two boxes into places: a big slot where
the structure was and a small one where the heatmap was, both carrying the same
tabs - Structure, each map, Scatter. A view lives in one slot; picking it in
the other swaps them. This probe drives it on dev.html and asks for the things
that are the design rather than the look:

  1. AN OBJECT WITH NO COORDINATES PUTS ITS MAP IN THE BIG SLOT. That is the
     case the feature was asked for - a fold whose trunk has a contact map and
     no structure yet - and it is a DEFAULT, not a rule: the structure takes the
     big slot back the moment it has frames.
  2. THE TWO SLOTS MIRROR. Picking the view the other slot shows swaps them.
  3. 🔴 ONLY WHAT IS ON SCREEN HOLDS A PICTURE. Counted as panels holding a
     decoded matrix against maps on screen - a parked panel keeping its n^2
     bytes and 4n^2 image is exactly the memory this was not allowed to add.
  4. 🔴 A PARKED STRUCTURE DRAWS NOTHING, and keeps its canvas. The render
     loop is left spinning (auto-rotate) while the structure is parked and the
     draws are counted; and the canvas must come back at the size it left at,
     because the viewport used to clamp a hidden box to 1x1 and the return then
     rebuilt the mesh.
  5. A CHOICE OUTLIVES A STATE THAT CANNOT HONOUR IT. PAE picked for the big
     slot, then a blank object with only a contact map, then the PAE back: the
     reader's pick returns with it.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_slots.html')
FILE = '1UBQ.cif'

JS = """
<script>
window.addEventListener('load', () => {
  //HELPERS
  const go = async () => {
    const out = { errors: [] };
    try {
      const txt = await (await fetch('/""" + FILE + """')).text();
      await window.processFiles([{name: '""" + FILE + """',
        readAsync: () => Promise.resolve(txt)}], false);
      await until(loaded);
      await settle(4);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      const S = r._slots;
      out.bound = !!S;
      if (!S) throw new Error('no slots on the website');

      const n = 76;
      const mat = (f) => { const u = new Uint8Array(n * n);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) u[i * n + j] = f(i, j);
        return u; };
      const pae = mat((i, j) => Math.min(255, Math.abs(i - j) * 6));
      const con = mat((i, j) => Math.abs(i - j) < 4 ? 255 : 0);
      const holding = () => (r._heatmapPool || []).filter((e) => !!e.hm.bytes).length;
      const onScreen = () => [S.shown().big, S.shown().small]
        .filter((v) => v && v.startsWith('map:')).length;
      // ...and how many views are actually IN each slot's body. The names
      // above say what the slot MEANS to show; a swap that forgot to park the
      // view it replaced leaves two boxes stacked in one slot, and every name
      // still reads right.
      const inBody = (sl) => sl.body.querySelectorAll(':scope > .py2dmol-slot-view').length;
      const snap = () => ({ big: S.shown().big, small: S.shown().small,
        inBig: inBody(S.layout.big), inSmall: inBody(S.layout.small),
        holding: holding(), onScreen: onScreen(),
        pool: (r._heatmapPool || []).length });

      // ---- a structure and nothing else: one slot, no tabs ----
      out.alone = Object.assign(snap(), {
        smallHidden: S.layout.small.slot.hidden,
        bigTabsHidden: S.layout.big.tabs.hidden,
        fsOnBig: !!S.layout.big.slot.querySelector('.py2dmol-fs-btn'),
        canvas: r.canvas.width,
      });

      // ---- two maps arrive ----
      const obj = r.objectsData[r.currentObjectName];
      obj.frames[0].maps = { pae: { data: pae, n }, contact: { data: con, n } };
      window.Heatmap.updateFrame(r, obj, 0);
      await settle(3);
      out.maps = Object.assign(snap(), {
        tabs: [...S.layout.small.tabs.children].map((b) => b.dataset.view) });

      // ---- the mirror ----
      S.choose('big', 'map:pae'); await settle(3);
      out.swapped = Object.assign(snap(), { canvas: r.canvas.width });
      // ...the width it had in the SMALL slot, which is the one it is parked at
      const cw = r.canvas.width;
      S.choose('small', 'map:contact'); await settle(3);
      out.twoMaps = snap();

      // ---- the structure is parked now: spin it, count the draws ----
      let draws = 0;
      const orig = r.render.bind(r);
      r.render = (...a) => { draws++; return orig(...a); };
      r.autoRotate = true;
      await settle(12);
      out.parkedDraws = draws;
      out.parkedCanvas = [cw, r.canvas.width];
      S.choose('big', 'molecular'); await settle(6);
      out.backDraws = draws;
      r.autoRotate = false;
      r.render = orig;
      out.back = Object.assign(snap(), { canvas: r.canvas.width });

      // ---- no coordinates: a blank object with a contact map alone ----
      S.choose('big', 'map:pae'); await settle(3);
      r.addObject('blank');
      if (r.currentObjectName !== 'blank') r._switchToObject('blank');
      r.heatmapRenderer.setMaps({ contact: { data: con, n } });
      window.Heatmap.updateVisibility(r);
      await settle(3);
      out.blank = snap();
      // ...and the reader's PAE pick comes back with the PAE.
      r.heatmapRenderer.setMaps({ pae: { data: pae, n }, contact: { data: con, n } });
      await settle(3);
      out.pickBack = snap();
      // ---- the API names things the way Python and the embed do ----
      // ...on the object that HAS a structure: 'blank' has none to put there,
      // and the big slot then correctly falls back to a map.
      r._switchToObject('1UBQ'); r.setFrame(0); await settle(3);
      r.setSlots({ big: 'structure', small: 'contact' }); await settle(3);
      out.api = r.getSlots();
    } catch (e) { out.errors.push(String(e && e.stack || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
  };
  go();
});
</script>
"""
JS = JS.replace('//HELPERS', HELPERS)
check_js(JS)

def serve_and_read(page_html, port, profile):
    """Serve the repo with one extra page and read back what it posts."""
    open(PROBE, 'w').write(page_html)
    box = []

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
        def log_message(self, *a): pass
        def do_POST(self):
            box.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))
            self.send_response(200); self.send_header('Content-Length', '2')
            self.end_headers(); self.wfile.write(b'ok')

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    proc = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=' + profile,
                             '--no-first-run', '--window-size=1200,1000',
                             'http://127.0.0.1:%d/_slots.html' % port],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + DEADLINE
    while not box and time.time() < end:
        time.sleep(0.5)
    proc.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree(profile, ignore_errors=True)
    return box[0] if box else {'errors': ['no result posted']}


stamp = str(int(time.time()))
src = open(os.path.join(ROOT, 'dev.html')).read()
src = re.sub(r'(src="(?:\./)?src/[^"]+?\.js)(\?[^"]*)?(")',
             lambda m: m.group(1) + '?v=' + stamp + m.group(3), src)
R = serve_and_read(src.replace('</body>', JS + '</body>'), 9794, '/tmp/py2dmol-slots')

for k in ('alone', 'maps', 'swapped', 'twoMaps', 'back', 'blank', 'pickBack'):
    print(f"  {k:9s} {R.get(k)}")
print(f"  draws while parked {R.get('parkedDraws')}, after coming back"
      f" {R.get('backDraws')}; canvas {R.get('parkedCanvas')}")

bad = list(R.get('errors') or [])
al = R.get('alone') or {}
if al.get('big') != 'molecular' or not al.get('smallHidden') or not al.get('bigTabsHidden'):
    bad.append(f"a structure with nothing else changed the page: {al}")
if not al.get('fsOnBig'):
    bad.append("the full-screen button is not on the big slot - put on the"
               " canvas box, it leaves with the structure")
m = R.get('maps') or {}
if m.get('big') != 'molecular' or m.get('small') != 'map:pae':
    bad.append(f"two maps did not open as structure big, PAE small: {m}")
if m.get('tabs') != ['molecular', 'map:pae', 'map:contact']:
    bad.append(f"the small slot's tabs are {m.get('tabs')}")
sw = R.get('swapped') or {}
if sw.get('big') != 'map:pae' or sw.get('small') != 'molecular':
    bad.append(f"picking the small slot's view for the big one did not swap: {sw}")
tm = R.get('twoMaps') or {}
if tm.get('big') != 'map:pae' or tm.get('small') != 'map:contact':
    bad.append(f"two maps did not go one to each slot: {tm}")
for k in ('alone', 'maps', 'swapped', 'twoMaps', 'back', 'blank', 'pickBack'):
    s = R.get(k) or {}
    if s.get('inBig') != 1 or s.get('inSmall') != (1 if s.get('small') else 0):
        bad.append(f"{k}: {s.get('inBig')} views in the big slot and"
                   f" {s.get('inSmall')} in the small one - a view that was"
                   " replaced is still standing in the slot")
    if s.get('holding') != s.get('onScreen'):
        bad.append(f"{k}: {s.get('holding')} panels hold a decoded matrix for"
                   f" {s.get('onScreen')} maps on screen - a hidden map is"
                   " paying n^2 bytes and a 4n^2 image for nothing")
if (R.get('parkedDraws') or 0) > 0:
    bad.append(f"the structure drew {R.get('parkedDraws')} times while parked"
               " and spinning - the loop is meant to skip a canvas it cannot see")
if not ((R.get('backDraws') or 0) > (R.get('parkedDraws') or 0)):
    bad.append("the structure did not draw when it came back out of the park")
pc = R.get('parkedCanvas') or [0, 0]
if pc[0] != pc[1] or pc[1] <= 1:
    bad.append(f"the canvas went {pc[0]} -> {pc[1]} while parked - a hidden box"
               " is not a small one, and the trip back rebuilds the mesh")
bk = R.get('back') or {}
if (sw.get('canvas') or 0) >= (al.get('canvas') or 0):
    bad.append(f"the structure did not follow the small slot: {sw.get('canvas')}"
               f" against {al.get('canvas')} in the big one")
if bk.get('big') != 'molecular' or bk.get('canvas') != al.get('canvas'):
    bad.append(f"the structure came back wrong: {bk}")
bl = R.get('blank') or {}
if bl.get('big') != 'map:contact':
    bad.append(f"an object with no coordinates left its map small: {bl} - that"
               " is the case this was built for")
pb = R.get('pickBack') or {}
if pb.get('big') != 'map:pae':
    bad.append(f"the PAE the reader put in the big slot did not come back with"
               f" the PAE: {pb}")

api = R.get('api') or {}
if api != {'big': 'structure', 'small': 'contact'}:
    bad.append(f"setSlots({{big: 'structure', small: 'contact'}}) reads back {api}")

# ---- THE NOTEBOOK: set_slots() before show() travels in the config ----
# A standing choice made in Python, on the page _display_viewer writes, which
# is a different shell with its own markup and sizes. Measured as what the
# renderer ended up showing, not as a key that arrived.
import types  # noqa: E402
try:
    import IPython.display  # noqa: F401
except ImportError:
    ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')
    for nm in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(disp, nm, lambda *a, **k: None)
    ip.display = disp
    sys.modules['IPython'] = ip; sys.modules['IPython.display'] = disp
sys.path.insert(0, ROOT)
import numpy as np  # noqa: E402
import py2Dmol  # noqa: E402

NB_JS = """<script>
window.addEventListener('load', async () => {
  //HELPERS
  const out = { errors: [] };
  try {
    const got = await until(() => {
      const v = Object.values(window.py2dmol_viewers || {})[0];
      return v && v.renderer.coords.length && v.renderer._slots;
    }, 8000);
    const r = Object.values(window.py2dmol_viewers)[0].renderer;
    await settle(6);
    out.slots = r.getSlots();
    const box = r._slots.layout.big.body.getBoundingClientRect();
    out.bigBox = [Math.round(box.width), Math.round(box.height)];
  } catch (e) { out.errors.push(String(e && e.stack || e)); }
  await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
});
</script>""".replace('//HELPERS', HELPERS)
check_js(NB_JS)
N = 60
ii = np.arange(N)
dd = np.abs(ii[:, None] - ii[None, :])
CO = np.stack([8 * np.cos(ii * 0.6), 8 * np.sin(ii * 0.6), ii * 1.5], 1)
nbv = py2Dmol.view(pae=True, size=(420, 420))
nbv.add(CO, name='m', pae=np.minimum(30, dd * 0.3),
        maps={'contact': {'data': np.exp(-dd / 6.0), 'vmin': 0, 'vmax': 1}})
nbv.set_slots(big='contact')
page = ('<!doctype html><html><head><meta charset="utf-8"></head><body>'
        + nbv._display_viewer(static_data=nbv.objects) + NB_JS + '</body></html>')
NB = serve_and_read(page, 9793, '/tmp/py2dmol-slots-nb')
print(f"  notebook  {NB}")
bad += [f"notebook: {e}" for e in NB.get('errors') or []]
if (NB.get('slots') or {}).get('big') != 'contact':
    bad.append(f"view.set_slots(big='contact') before show() came up as"
               f" {NB.get('slots')} - the config key did not reach the slots")
if NB.get('bigBox') != [420, 420]:
    bad.append(f"the notebook's big slot is {NB.get('bigBox')}, not the 420x420"
               " the view asked for - the size token has to move to the slot")

if bad:
    for b in bad: print('FAIL:', b)
    sys.exit(1)
print('slots: ok')
