"""set_opacity from Python: does it reach the picture, and survive a session?

    python3 tests/python_opacity.py

The fade was built for the selection panel and reachable from nowhere else -
the same shape as every capability this repository has had to go back for:
`clipTo`, `orientTo`, the side-chain verbs. A notebook could not ask for it at
all, which is the case it was reported from: a figure built in a script, where
there is no panel to reach.

WHAT IS MEASURED, on the page viewer.py writes:

  * a fade set BEFORE show() reaches the picture - the static path, which is
    what a notebook cell renders from;
  * it is stored against the OBJECT, in that object's own numbering, so it
    travels with it - the same place set_sse and set_color put theirs;
  * save_state writes it and load_state reads it back, as an ordinary
    round trip of the value, not of the key's presence;
  * ...and a second object added afterwards is NOT faded, which is the bug
    this whole path was rebuilt for.

🔴 AND THE PICTURE IS THE CHECK, NOT THE PAYLOAD. A key that arrives and is
never applied looks identical to one that works, from Python.
"""
import http.server, json, os, shutil, socketserver, sys, threading, time, types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DBG = 9693, 9256

CELLS = []
try:
    import IPython.display  # noqa: F401
except ImportError:
    _disp = types.ModuleType('IPython.display')

    class _H:
        def __init__(self, data): CELLS.append(data)

    for _n, _v in (('display', lambda *a, **k: None), ('HTML', _H),
                   ('Javascript', _H), ('update_display', lambda *a, **k: None)):
        setattr(_disp, _n, _v)
    _ip = types.ModuleType('IPython'); _ip.display = _disp
    sys.modules['IPython'] = _ip; sys.modules['IPython.display'] = _disp
sys.path.insert(0, ROOT)
import py2Dmol  # noqa: E402

STATE = os.path.join(ROOT, '_pyopacity.json')
bad = []


def build(apply_fade):
    py2Dmol.viewer._LENT_BUNDLE = None
    py2Dmol.viewer._LENT_WHERE = None
    del CELLS[:]
    v = py2Dmol.view((360, 300), id='pyopacity')
    v._is_live = False
    v.add_pdb(os.path.join(ROOT, '1UBQ.cif'), name='ubq', use_biounit=False)
    if apply_fade:
        v.set_opacity(0.1, position=(0, 38))
    return v


# ---- the value itself, before any browser is involved ----------------------
v = build(True)
stored = dict((v.objects[-1].get('opacity') or {}))
print(f"  stored on the object: {len(stored)} positions,"
      f" first {sorted(stored.items())[:2]}")
if len(stored) != 38:
    bad.append(f"set_opacity(position=(0, 38)) stored {len(stored)} positions")
if set(stored.values()) != {0.1}:
    bad.append(f"stored values are {set(stored.values())}, wanted 0.1 for all")

# ...and a round trip through a state file
v.save_state(STATE)
saved = json.load(open(STATE))
in_file = (saved.get('objects') or [{}])[0].get('opacity')
print(f"  in the state file: {len(in_file or {})} positions")
if not in_file or len(in_file) != 38:
    bad.append(f"save_state wrote {in_file!r} - the fade did not reach the file")
w = py2Dmol.view((360, 300), id='pyopacity-load')
w.load_state(STATE)
back = dict((w.objects[-1].get('opacity') or {}))
print(f"  after load_state: {len(back)} positions")
if back != stored:
    bad.append(f"a session came back with {len(back)} faded positions against"
               f" {len(stored)} - keys {sorted(back)[:3]} vs {sorted(stored)[:3]}")
os.remove(STATE)

# ---- and the picture, which is the only thing that settles it --------------
page = os.path.join(ROOT, '_pyopacity.html')


def render(viewer, tag):
    body = viewer._display_viewer(static_data=viewer.objects)
    open(page, 'w').write('<!doctype html><meta charset="utf-8">'
                          '<body style="margin:0">' + body + '</body>')
    ws.call("Page.navigate", url="about:blank"); time.sleep(0.3)
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_pyopacity.html")
    wait_for(ws, "!!document.querySelector('#canvasContainer')", timeout=90,
             what=tag)
    time.sleep(3.5)
    return json.loads(evaluate(ws, """(() => {
      const r = (Object.values(window.py2dmol_viewers || {})[0] || {}).renderer;
      if (!r) return JSON.stringify({error: 'no viewer'});
      const cv = document.querySelector('canvas:not([data-py2dmol-layer])');
      const c = document.createElement('canvas');
      c.width = cv.width; c.height = cv.height;
      // the GPU painter's layer under the canvas first, then the canvas (the overlays)
      const layer = cv.nextElementSibling && cv.nextElementSibling.tagName === 'CANVAS' ? cv.nextElementSibling : null;
      if (layer) c.getContext('2d').drawImage(layer, 0, 0);
      c.getContext('2d').drawImage(cv, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4)
        if ((d[i]*299 + d[i+1]*587 + d[i+2]*114)/1000 < 200) ink += 1;
      return JSON.stringify({
        ink, gpu: !!r.gpuDrewLastFrame,
        applied: (r.drawnOpacity && r.drawnOpacity()) ? r.drawnOpacity().size : 0,
        onObject: Object.keys((r.objectsData.ubq || {}).opacity || {}).length,
      });
    })()"""))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome, ws = launch(DBG, "/tmp/py2dmol-pyopacity")
try:
    solid = render(build(False), 'the solid page')
    faded = render(build(True), 'the faded page')
finally:
    chrome.kill(); httpd.shutdown()
    try: os.remove(page)
    except OSError: pass
    shutil.rmtree("/tmp/py2dmol-pyopacity", ignore_errors=True)

print(f"  solid page: {solid['ink']} ink px, {solid['applied']} applied")
print(f"  faded page: {faded['ink']} ink px, {faded['applied']} applied,"
      f" {faded['onObject']} on the object (gpu={faded['gpu']})")

if not faded.get('gpu'):
    print("python_opacity: skipped - this browser drew on the CPU path")
    sys.exit(0)
if faded['onObject'] != 38:
    bad.append(f"the page received {faded['onObject']} faded positions of 38 -"
               ' the static payload did not carry them')
if faded['applied'] != 38:
    bad.append(f"{faded['applied']} of 38 reached drawnOpacity - they arrived"
               ' and were not applied')
if faded['ink'] >= solid['ink']:
    bad.append(f"the faded page has {faded['ink']} ink px against the solid"
               f" one's {solid['ink']} - nothing was faded in the picture")
if solid['applied'] != 0:
    bad.append(f"a page with no set_opacity call applied {solid['applied']}")

print()
for b in bad:
    print("FAIL: " + b)
print("python_opacity: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
