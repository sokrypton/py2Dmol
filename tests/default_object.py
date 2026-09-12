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

🔴 AND THE WEB DROP PATH IS A SECOND ARM, because the first version of this
covered only the notebook and the regression landed in the other one. The
page's loader builds `newNames` from the batch, and that list ALSO carries an
object already in the renderer that the batch names again - so choosing from it
let a structure already on the page beat the file just dropped, and a static
file dropped onto a page holding a trajectory stopped being shown at all. It
was tests/station_rows.py that caught it, by measuring its own coverage: its
tail arm loads 1EHZ over a trajectory and went from 4 draws with a tail span to
0. A gate for a rule has to exercise the shell the rule runs in.

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


# THE PAGE'S OWN LOADER, which is a different rule in a different file from
# the notebook's - see the header.
#
# 🔴 AND "TWO FILES DROPPED TOGETHER" IS NOT A MULTI-OBJECT CASE HERE, which
# cost an arm to find out: the page COMBINES a batch into one object, so
# dropping 1UBQ.cif with a 30-model trajectory gives a single `1UBQ` of 31
# frames. Several objects on the page come from SUCCESSIVE drops instead - and
# that is the case the rule must not touch, because the file just dropped is
# the one the reader is asking to see whatever is already there. It is also the
# case the first version of this broke: `newNames` carries objects already in
# the renderer as well as new ones, so the trajectory already on the page beat
# the file being dropped and the new one was never shown.
DROP = """(async () => {
 try {
  const get = async (f) => ({name: f,
      readAsync: () => fetch('/' + f).then((r) => r.text())});
  await window.processFiles([await get('_traj_1tim.pdb')], true);
  await until(loaded, 300000);
  await settle(12);
  const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
  const first = r.currentObjectName;
  const firstFrames = ((r.objectsData[first] || {}).frames || []).length;
  await window.processFiles([await get('1EHZ.cif')], true);
  await until(loaded, 300000);
  await settle(12);
  return JSON.stringify({first, firstFrames, after: r.currentObjectName,
                         names: Object.keys(r.objectsData || {})});
 } catch (e) { return JSON.stringify({error: String((e && e.stack) || e)}); }
})()"""


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
    # ---- and the page's loader -------------------------------------------
    from probe_js import HELPERS  # noqa: E402
    probe = os.path.join(ROOT, '_dobj_web.html')
    open(probe, 'w').write(
        open(os.path.join(ROOT, 'dev.html')).read().replace(
            '</body>', '<script>window.__ready=false;'
            "window.addEventListener('load',()=>{" + HELPERS
            + 'window.__go=()=>' + DROP + ';window.__ready=true;});</script></body>'))
    ws.call("Page.navigate", url="about:blank"); time.sleep(0.2)
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_dobj_web.html")
    wait_for(ws, "window.__ready === true", timeout=120, what="the page")
    W = json.loads(evaluate(ws, "window.__go()"))
    os.remove(probe)
    if W.get('error'):
        bad.append('web drop: ' + W['error'])
    else:
        print(f"  {'trajectory first':<20} opened on {W['first']!r}"
              f" ({W['firstFrames']} frames)")
        print(f"  {'then a static drop':<20} opened on {W['after']!r}"
              f"  objects {W['names']}")
        if W['firstFrames'] < 2:
            bad.append(f"the trajectory loaded as {W['firstFrames']} frame(s),"
                       ' so the arm below is not the case it is named for')
        if W['after'] != '1EHZ':
            bad.append(f"a file dropped onto a page that already held a"
                       f" trajectory opened on {W['after']!r} - a newly dropped"
                       ' file must be the one shown')
finally:
    chrome.kill(); httpd.shutdown()
    shutil.rmtree("/tmp/py2dmol-dobj", ignore_errors=True)

print()
for b in bad:
    print("FAIL: " + b)
print("default_object: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
