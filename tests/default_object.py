"""Which object a viewer opens on when several arrive together.

    python3 tests/default_object.py

TWO SHELLS, TWO RULES, AND BOTH ARE DELIBERATE:

  * the NOTEBOOK opens on the FIRST object added. That is the order the author
    of the page chose, and it is the only thing about the set of objects they
    did choose;
  * the PAGE opens on the file just DROPPED. A drop is a request to look at
    what was dropped, whatever is already loaded.

🔴 AND CHOOSING BY FRAME COUNT WAS BUILT, MEASURED AND DECLINED. A static
backdrop added before an animated object opens on the backdrop, whose frame
strip reads 1 / 1 and which has no play controls at all - reported as "the
player doesn't have the protein visible". Opening on whichever object has the
most frames fixes that case and was turned down: a viewer that reorders your
objects behind your back is a surprise of its own. The remedy for that report
is to add the animated object first, or to use the Object menu.

This gate exists BECAUSE of that attempt. Neither rule was gated anywhere
before it, which is why moving them was easy and the consequences were not.

WHAT IS MEASURED, in the notebook shell, on the payload viewer.py writes: four
arrangements of a static object and an animated one, all of which must open on
the first. Then the page's own loader: a trajectory, then a static file dropped
on top, which must show the file that was dropped.

🔴 AND THE FRAME STRIP IS READ, NOT INFERRED. "It opened on the right object"
is a field on the renderer; what a reader sees is the counter. Both, because
they can disagree.

🔴 AND "TWO FILES DROPPED TOGETHER" IS NOT A MULTI-OBJECT CASE HERE, which cost
an arm to find out: the page COMBINES a batch into one object, so 1UBQ.cif
dropped with a 30-model trajectory is a single `1UBQ` of 31 frames. Several
objects on a page come from SUCCESSIVE drops.
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

# Every arrangement opens on the first, INCLUDING the two where the animated
# object is second - which are the ones a frames-based rule would move, and so
# the ones that say this rule is the one running.
ARMS = [
    ('moving then still', ['moving', 'still'], 'moving'),
    ('still then moving', ['still', 'moving'], 'still'),
    ('two static', ['still', 'still2'], 'still'),
    ('two trajectories', ['moving', 'moving2'], 'moving'),
]


# THE PAGE'S OWN LOADER, which is a different rule in a different file from
# the notebook's - see the header. A trajectory, then a static file dropped on
# top: the dropped one is what the reader asked to see.
#
# 🔴 THIS IS THE ARM THE DECLINED RULE BROKE. Choosing by frame count read a
# list that carries objects already in the renderer as well as new ones, so the
# trajectory already on the page beat the file being dropped and the new one
# was never shown at all. Nothing covered this shell until then.
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
        # ...and the strip agrees with the object that was opened. A static
        # object reading 1 / 1 is CORRECT here and is the whole of what the
        # declined rule was trying to avoid; what must never happen is the two
        # disagreeing.
        want_strip = f"1 / {R['frames']}"
        if R['counter'] and R['counter'].replace(' ', '') != want_strip.replace(' ', ''):
            bad.append(f"{label}: opened on a {R['frames']}-frame object and the"
                       f" strip reads {R['counter']!r}, not {want_strip!r}")
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
