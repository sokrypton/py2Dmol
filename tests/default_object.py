"""Which object a viewer opens on when several arrive together.

    python3 tests/default_object.py

🔴 A STATIC BACKDROP BESIDE AN ANIMATED OBJECT OPENED ON THE BACKDROP, and the
viewer then had no play controls at all: the trajectory was there, one switcher
click away, and every sign that it existed was behind that click. Reported as
"the player doesn't have the protein visible".

🔴 AND THE TWO SHELLS HAD DIFFERENT RULES, which is why the report was right
about one and inverted for the other. The page's drop path took the LAST object
loaded; the notebook's static path took `[0]`. Neither is a statement about
which object is worth looking at - the number of FRAMES is.

WHAT IS MEASURED, in the notebook shell, on the payload viewer.py writes:

  * animated first, static second -> opens on the animated one;
  * static first, animated second -> the same, which is the arrangement that
    reproduces the report and the one the old `[0]` rule got wrong;
  * TWO STATIC OBJECTS -> opens on the first, exactly as before. The rule fires
    only when something strictly wins, so every arrangement that worked is
    untouched, and this is the arm that says so;
  * TWO TRAJECTORIES -> likewise the first, for the same reason.

🔴 AND THE PLAY CONTROLS ARE READ, NOT INFERRED. "It opened on the right
object" is a field on the renderer; what the reporter saw was a frame counter
reading 1 / 1. Both are checked, because a viewer that names the animated
object and still shows no player is the same bug wearing the fix.
"""
import http.server, json, os, shutil, socketserver, sys, threading, time, types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DBG = 9673, 9236

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
import numpy as np  # noqa: E402
import py2Dmol  # noqa: E402


def page(order, tag):
    """A viewer with two objects, added in the order given.

    `moving` gets four frames and `still` one - the shape the report describes,
    an animated thing beside a backdrop.
    """
    py2Dmol.viewer._LENT_BUNDLE = None      # see tests/selection_shells.py
    py2Dmol.viewer._LENT_WHERE = None
    del CELLS[:]
    v = py2Dmol.view((320, 240), id='dobj-' + tag)
    v._is_live = False
    coords = np.array([[float(i) * 3.8, 0.0, 0.0] for i in range(12)])
    for name in order:
        frames = 4 if name.startswith('moving') else 1
        for f in range(frames):
            shifted = coords + np.array([f * 0.1, 0.0, 0.0])
            v.add(shifted, name=name)
    v.show()
    body = "\n".join(c for c in CELLS if isinstance(c, str))
    path = os.path.join(ROOT, f'_dobj_{tag}.html')
    open(path, 'w').write('<!doctype html><meta charset="utf-8">'
                          '<body style="margin:0">' + body + '</body>')
    return path


ASK = """(() => {
  const vs = window.py2dmol_viewers || {};
  const r = (Object.values(vs)[0] || {}).renderer;
  if (!r) return JSON.stringify({error: 'no viewer'});
  const counter = document.querySelector('#frameCounter');
  const obj = r.objectsData[r.currentObjectName] || {};
  return JSON.stringify({
    opened: r.currentObjectName,
    frames: (obj.frames || []).length,
    // WHAT THE READER SEES, not what the renderer knows: the strip reads
    // "1 / 1" on a static object and that is the whole complaint.
    counter: counter ? counter.textContent.trim() : null,
    names: Object.keys(r.objectsData || {}),
  });
})()"""

ARMS = [
    ('moving then still', ['moving', 'still'], 'moving'),
    ('still then moving', ['still', 'moving'], 'moving'),
    # ...and the two that must not move. `still` and `still2` both have one
    # frame, `moving` and `moving2` four each: nothing wins, so each keeps the
    # answer its shell always gave - the first, here.
    ('two static', ['still', 'still2'], 'still'),
    ('two trajectories', ['moving', 'moving2'], 'moving'),
]


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome, ws = launch(DBG, "/tmp/py2dmol-dobj")
bad = []
try:
    ws.call("Page.enable"); ws.call("Runtime.enable")
    for i, (label, order, want) in enumerate(ARMS):
        path = page(order, str(i))
        ws.call("Page.navigate", url="about:blank"); time.sleep(0.2)
        ws.call("Page.navigate",
                url=f"http://127.0.0.1:{PORT}/{os.path.basename(path)}")
        wait_for(ws, "!!document.querySelector('#canvasContainer')", timeout=60,
                 what="the viewer")
        time.sleep(1.2)
        R = json.loads(evaluate(ws, ASK))
        os.remove(path)
        if R.get('error'):
            bad.append(f"{label}: {R['error']}")
            continue
        print(f"  {label:<20} opened on {R['opened']!r}"
              f" ({R['frames']} frames), strip {R['counter']!r}")
        if R['opened'] != want:
            bad.append(f"{label}: opened on {R['opened']!r}, wanted {want!r}"
                       f" - the objects are {R['names']}")
        if want.startswith('moving') and R['counter'] in ('1 / 1', '1/1'):
            bad.append(f"{label}: the frame strip reads {R['counter']!r} - it"
                       ' named the animated object and still shows no player')
finally:
    chrome.kill(); httpd.shutdown()
    shutil.rmtree("/tmp/py2dmol-dobj", ignore_errors=True)

print()
for b in bad:
    print("FAIL: " + b)
print("default_object: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
