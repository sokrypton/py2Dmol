"""The confidence trace as a slot view: the tab, the picture, and the drag.

    python3 tests/plddt_panel.py

src/panels/plddt.js draws the DRAWN FRAME's pLDDT, one column per residue, and
a drag on it selects those residues. Four things are the design rather than the
look, and each is measured on the page:

  1. A FLAT ARRAY IS NOT A MEASUREMENT. setCoords pads a missing confidence to
     50.0 for every position, so "there are numbers" is true of every structure
     ever loaded. A crystal structure with no B-factor spread must get NO tab,
     or every viewer in the world grows one that says the model was unsure
     everywhere - a claim nobody made.
  2. A STRUCTURE THAT HAS ONE GETS THE TAB, and the plot draws ink.
  3. 🔴 THE DRAG IS IN RESIDUES AND THE PICTURE IS IN PIXELS. A residue owns
     W/N pixels, which is under one on anything large - so the hit test and the
     drawing have to agree about which. This drags a known fraction of the plot
     and asks which residues came back: the panel's own crossing, read through
     the selection it produced.
  4. 🔴 IT FOLLOWS THE FRAME. The array is per frame, so stepping the play bar
     must repaint - the signature that stops a still structure repainting at
     60 Hz is exactly what could freeze it.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, '_plddt.html')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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
      const N = r._baseCount ? r._baseCount() : r.plddts.length;
      out.n = N;

      // 1UBQ carries real B-factors, so the trace has something to say.
      out.variedHasData = !!(window.Plddt && window.Plddt.hasData(r));
      // ...and OFF until asked: the data is there and the panel is not.
      out.mountedUnasked = !!r.plddtRenderer;

      // ...and the same structure with a FLAT array has not. This is what
      // setCoords leaves when a file names no confidence at all.
      // ...flattened where `hasData` now LOOKS, which is the object's frames:
      // the drawn array is padded by setCoords and says nothing about whether
      // the structure ever carried a measurement.
      const fr0 = r.objectsData[r.currentObjectName].frames[0];
      const keep = fr0.plddts;
      fr0.plddts = (keep || []).map(() => 50);
      out.flatHasData = !!(window.Plddt && window.Plddt.hasData(r));
      fr0.plddts = keep;

      out.hasBox = !!document.getElementById('plddtContainer');
      // 🔴 THE HOST ASKS FOR IT. Nothing on this page switches the trace on -
      // a B-factor column is not a confidence one, and only whoever loaded
      // the data knows which it is - so a host that DOES know says so in one
      // line. This is the door LocalFold uses, driven here the same way.
      window.Plddt.initialize(r);
      await settle(2);
      r.setSlots(['structure', 'plddt']);
      await settle(6);
      const p = r.plddtRenderer;
      out.mounted = !!p;
      if (!p) { await fetch('/_result', {method:'POST', body: JSON.stringify(out)}); return; }
      out.canvas = [p.w, p.h];
      // The tab has to be REACHABLE, not merely available: read the strip a
      // reader clicks, not an internal list.
      out.tabs = Array.from(document.querySelectorAll('.py2dmol-slot-tab'))
        .map((b) => b.textContent);

      // 🔴 READ AS A GRAPH, NOT AS AN IMAGE. The marks are ELEMENTS, so what
      // the plot says is in the DOM - a pixel digest would be measuring the
      // browser's rasteriser, which is what made the old canvas version
      // report three different pictures for one unchanged frame.
      const poly = () => p.svg.querySelector('polyline').getAttribute('points') || '';
      const nPts = () => poly().trim() ? poly().trim().split(/[ ]+/).length : 0;
      out.drew = nPts();

      // THE DRAG, IN RESIDUES. The middle third of the PLOT box - inset by
      // the axis gutter, which is the crossing under test.
      const rect = p.svg.getBoundingClientRect();
      const s = p.w / rect.width;
      const plot = p.box();
      const xAt = (f) => rect.left + (plot.x + plot.w * f) / s + 0.5;
      const y = rect.top + rect.height / 2;
      const send = (t, x) => p.svg.dispatchEvent(
        new MouseEvent(t, {clientX: x, clientY: y, bubbles: true, button: 0}));
      send('mousedown', xAt(1/3));
      send('mousemove', xAt(2/3));
      send('mouseup', xAt(2/3));
      await settle(2);
      const sel = r.residueSelection ? Array.from(r.residueSelection).sort((a,b)=>a-b) : [];
      out.selLo = sel.length ? sel[0] : -1;
      out.selHi = sel.length ? sel[sel.length-1] : -1;
      out.selN = sel.length;
      out.wantLo = Math.floor(N/3);
      out.wantHi = Math.floor(2*N/3);
      r.clearResidueSelection();
      await settle(2);

      // 🔴 A VIEW NO SLOT SHOWS GOES TO THE PARK. Drop to one box and the
      // graph has to LEAVE its slot - a box left out of the park sweep just
      // stays where it was put, so the slot goes on showing the trace while
      // the tabs say Structure and picking another view does nothing a reader
      // can see. Reported as the second slot getting stuck on pLDDT.
      const boxEl = document.getElementById('plddtContainer');
      const parkOf = (el) => (el.parentNode && el.parentNode.className) || '';
      r.setSlots({views: ['structure'], count: 1});
      await settle(6);
      out.parkedParent = parkOf(boxEl);
      out.parkedVisible = boxEl.getClientRects().length > 0;
      // ...and it comes back when asked for again. The COUNT has to come back
      // with it: `count` is a standing answer about how many boxes there are,
      // not a consequence of naming views, so a bare list after `count: 1`
      // leaves one box and the trace correctly stays parked.
      r.setSlots({views: ['structure', 'plddt'], count: 2});
      await settle(6);
      out.backParent = parkOf(boxEl);
      out.backPoints = nPts();

      // 🔴 AND CLEAR ALL TAKES THE TAB WITH IT. `clearAllObjects` empties
      // objectsData and nulls the current name, but leaves `renderer.plddts`
      // holding the last structure's numbers - so anything that answers from
      // the DRAWN array keeps a tab over a structure that is gone.
      const keptObjects = r.objectsData;
      const keptName = r.currentObjectName;
      r.objectsData = {}; r.currentObjectName = null;
      out.dataAfterClear = !!(window.Plddt && window.Plddt.hasData(r));
      out.plddtsSurviveClear = !!(r.plddts && r.plddts.length);
      r.objectsData = keptObjects; r.currentObjectName = keptName;

      // IT FOLLOWS THE FRAME. A second frame whose confidence is the mirror
      // of the first: the picture must change, and change back.
      const obj = r.objectsData[r.currentObjectName];
      const f0 = obj.frames[0];
      const mirrored = Object.assign({}, f0,
        {plddts: (f0.plddts || []).map((v) => 100 - v)});
      r.addFrame(mirrored, r.currentObjectName);
      await settle(3);
      const snap = () => [poly().slice(0, 60), p.n, r.currentFrame];
      r.setFrame(0); await settle(3); const s0 = snap();
      r.setFrame(1); await settle(3); const s1 = snap();
      r.setFrame(0); await settle(3); const s2 = snap();
      out.frameLines = [s0[0], s1[0], s2[0]];
      out.snaps = [s0, s1, s2];

      // 🔴 AND THE TAB DOES NOT BLINK. A frame that names no confidence is
      // padded to a flat 50.0 by setCoords, so asking the DRAWN array made
      // the tab come and go as the play bar moved while the PAE beside it
      // stayed - the maps resolve backwards per key and scatter walks the
      // frames, so this has to ask the object too.
      const f0b = r.objectsData[r.currentObjectName].frames[0];
      r.addFrame(Object.assign({}, f0b, {plddts: undefined}), r.currentObjectName);
      await settle(3);
      r.setFrame(r.objectsData[r.currentObjectName].frames.length - 1);
      await settle(3);
      out.tabOnPaddedFrame = !!(window.Plddt && window.Plddt.hasData(r));
      out.paddedFlat = (() => {
        const a = r.plddts || []; const n = r._baseCount ? r._baseCount() : a.length;
        for (let i = 1; i < n; i++) if (a[i] !== a[0]) return false;
        return true;
      })();
      r.setFrame(0); await settle(2);

    } catch (e) { out.errors.push(String((e && e.stack) || e)); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
  };
  go();
});
</script>
"""

JS = JS.replace('//HELPERS', HELPERS)
check_js(JS)


def serve_and_read(page_html, port, profile):
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
                             'http://127.0.0.1:%d/_plddt.html' % port],
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
R = serve_and_read(src.replace('</body>', JS + '</body>'), 9797, '/tmp/py2dmol-plddt')

# --- THE NOTEBOOK SHELL -----------------------------------------------------
# 🔴 THE PAGE `_display_viewer` WRITES, not dev.html. The website does not ask
# for the trace, so everything above goes through the host door; the notebook
# asks through `view(plddt=True)`, which crosses `_nest_config` (a call with
# explicit keywords - a parameter it does not name is thrown away),
# `normalizeConfig`, and `parts/ui.js`'s mount gate, and lands in viewer.html's
# own box. Checked statically that each exists is not the same as it drawing.
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
    await until(() => {
      const v = Object.values(window.py2dmol_viewers || {})[0];
      return v && v.renderer.coords.length && v.renderer._slots;
    }, 8000);
    const r = Object.values(window.py2dmol_viewers)[0].renderer;
    await settle(4);
    out.mounted = !!r.plddtRenderer;
    if (r.plddtRenderer) {
      r.setSlots({views: ['structure', 'plddt'], count: 2});
      await settle(6);
      out.tabs = [...document.querySelectorAll('.py2dmol-slot-tab')].map((b) => b.textContent);
      const pl = document.querySelector('#plddtContainer polyline');
      const pts = pl ? (pl.getAttribute('points') || '').trim() : '';
      out.points = pts ? pts.split(/ +/).length : 0;
    }
  } catch (e) { out.errors.push(String(e && e.stack || e)); }
  await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
});
</script>""".replace('//HELPERS', HELPERS)
check_js(NB_JS)

NB_N = 50
ii = np.arange(NB_N)
NB_CO = np.stack([8 * np.cos(ii * 0.6), 8 * np.sin(ii * 0.6), ii * 1.5], 1)
NB_PL = 40 + 50 * (0.5 + 0.5 * np.sin(ii / 6))


def nb_page(**kw):
    # 🔴 EACH PAGE AS A FRESH KERNEL WOULD WRITE IT. viewer.py lends the
    # library ONCE per kernel and every later cell BORROWS it from the page -
    # so the second page built in this process carried no library at all and
    # had no viewer, which reads exactly like `view()` crashing. Forgetting the
    # lend makes every page self-contained, which is what a standalone file is.
    py2Dmol.viewer._LENT_BUNDLE = None
    py2Dmol.viewer._LENT_WHERE = None
    v = py2Dmol.view(size=(360, 360), **kw)
    v.add(NB_CO, name='m', plddts=NB_PL)
    return ('<!doctype html><html><head><meta charset="utf-8"></head><body>'
            + v._display_viewer(static_data=v.objects) + NB_JS + '</body></html>')


NB_ON = serve_and_read(nb_page(plddt=True), 9798, '/tmp/py2dmol-plddt-nb1')
NB_OFF = serve_and_read(nb_page(), 9799, '/tmp/py2dmol-plddt-nb2')
print(f"  notebook on   {NB_ON}")
print(f"  notebook off  {NB_OFF}")

bad = list(R.get('errors') or [])
bad += ['notebook: ' + e for e in (NB_ON.get('errors') or []) + (NB_OFF.get('errors') or [])]
if not NB_ON.get('mounted'):
    bad.append("view(plddt=True) did not mount the trace in the notebook shell")
elif 'pLDDT' not in (NB_ON.get('tabs') or []):
    bad.append(f"the notebook shell has no pLDDT tab: {NB_ON.get('tabs')}")
elif NB_ON.get('points') != NB_N:
    bad.append(f"the notebook trace has {NB_ON.get('points')} points for {NB_N} residues")
if NB_OFF.get('mounted'):
    bad.append("a notebook viewer that did not ask for the trace mounted it anyway")
for k in ('flatHasData', 'variedHasData', 'mountedUnasked', 'hasBox', 'mounted', 'tabs', 'drew',
          'canvas', 'selLo', 'selHi', 'selN', 'tabOnPaddedFrame', 'paddedFlat', 'dataAfterClear', 'plddtsSurviveClear', 'parkedParent',
          'parkedVisible', 'backParent', 'backPoints', 'frameLines'):
    print(f"  {k:14s} {R.get(k)}")

if R.get('flatHasData') is not False:
    bad.append("a padded, FLAT confidence array earned a tab: setCoords pads a"
               " missing score to 50.0 everywhere, so this would put a dead"
               " plot on every structure that never had one")
if not R.get('variedHasData'):
    bad.append("a real confidence array did not register as data")
if R.get('mountedUnasked'):
    bad.append("the trace mounted without anyone asking - a B-factor column is"
               " not a confidence one, so the page must not offer the plot"
               " until a caller that knows says so")
if not R.get('hasBox'):
    bad.append("dev.html has no #plddtContainer - the panel mounts on markup")
if not R.get('mounted'):
    bad.append("the panel did not mount")
tabs = R.get('tabs')
if not isinstance(tabs, list) or not tabs:
    bad.append("no tab strip was built at all")
elif 'pLDDT' not in tabs:
    bad.append(f"the trace has no tab a reader can press: {tabs}")
if not R.get('drew') or R.get('drew') < 50:
    bad.append(f"the line has {R.get('drew')} points - it is empty")

lo, hi, want_lo, want_hi = (R.get('selLo'), R.get('selHi'),
                            R.get('wantLo'), R.get('wantHi'))
if lo is None or lo < 0:
    bad.append("the drag selected nothing")
elif abs(lo - want_lo) > 2 or abs(hi - want_hi) > 2:
    # 🔴 A TOLERANCE OF TWO RESIDUES IS NOT SLOP. What this catches is a
    # crossing that stopped converting - reading canvas pixels as plot
    # pixels, or forgetting the axis gutter - and that misses by the width
    # of the gutter, which is many residues. One residue either side is the
    # band a click lands in.
    bad.append(f"the drag covered residues {lo}..{hi} where the middle third"
               f" of the plot is {want_lo}..{want_hi} - the residue/pixel"
               f" crossing is off")

if 'park' not in str(R.get('parkedParent')):
    bad.append(f"dropping to one slot left the trace in {R.get('parkedParent')!r}"
               f" instead of the park - the slot stays stuck on it")
if R.get('parkedVisible'):
    bad.append("the parked trace is still on screen")
if 'park' in str(R.get('backParent')):
    bad.append("asking for the trace again left it parked")
if not R.get('backPoints'):
    bad.append("the trace came back out of the park empty - it was parked with"
               " a box of no size, so its measurement is stale by construction")

if R.get('tabOnPaddedFrame') is not True:
    bad.append("a frame that names no confidence lost the tab - setCoords pads"
               " it to a flat 50, and asking the DRAWN array makes the tab"
               " blink as the play bar moves while the PAE beside it stays")

if R.get('dataAfterClear'):
    bad.append("the trace still claims data after every object was cleared -"
               " clearAllObjects does not clear renderer.plddts, so anything"
               " answering from the drawn array leaves a tab over a structure"
               " that is gone")
if not R.get('plddtsSurviveClear'):
    bad.append("the control failed: renderer.plddts did NOT survive the clear,"
               " so this leg proves nothing about the fallback")

d = R.get('frameLines')
if not isinstance(d, list) or len(d) != 3:
    bad.append("no frame lines")
elif d[0] == d[1]:
    bad.append("stepping to a frame with different confidence drew the SAME"
               " line - the graph is not following the play bar")
elif d[0] != d[2]:
    bad.append(f"going back to frame 0 drew a third line: {d}")

if bad:
    for b in bad: print("FAIL: " + b)
    sys.exit(1)
print("ok")
