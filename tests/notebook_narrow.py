"""The notebook shell in a cell too narrow for canvas-plus-panel.

    python3 tests/notebook_narrow.py

A NOTEBOOK CELL IS WHATEVER WIDTH THE READER'S WINDOW LEAVES IT - a split
view, a sidebar, a phone - and viewer.html's `#mainContainer` was `display:
flex; flex-direction: row` with no `flex-wrap`. `nowrap` is the flex default,
the canvas is a fixed 600px that `flex: 0 0 auto` refuses to shrink, and the
panel column is a fixed 180px: so in any cell narrower than the two together
the panel was laid out past the right-hand edge of the cell and clipped away,
with nothing on the page to say the controls were there at all. Reported by a
user embedding the viewer, and the first thing to say about it is that
parts/embed.js's shell has wrapped since it was written - one shell had the
rule and the other never did.

WHAT IS MEASURED. The panel's right edge against the cell's, and its top
against the canvas's, at four cell widths. Wrapped means the panel sits UNDER
the canvas; spilling means its right edge is past the cell's.

🔴 AND BOTH ARMS ARE RUN, because a wrap check on its own passes on a page
where the panel is missing, zero-width, or display:none - it is never to the
right of anything. So the probe forces `flex-wrap: nowrap` back on and requires
that arm to SPILL. The gate fails if the bug cannot be reproduced, which is the
only way to know the measurement can see it.

🔴 AND THE CANVAS IS NOT ASKED TO SHRINK. viewer.py was given a size and that
size is the caller's; below about 560px the canvas itself is wider than the
cell. That is the caller asking for 600px in a 480px box, not this bug, and the
probe does not judge it - it prints it.
"""
import http.server, json, os, socketserver, sys, threading, time, types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_nbnarrow.html")
# 🔴 NOT 9306: tests/sidechain_toggle.py binds it, and run.sh puts both in
# the same parallel lane - so this failed in the suite and passed alone,
# which reads exactly like a flaky gate and is a port.
PORT, DBG = 9679, 9244
WIDTHS = [900, 760, 640, 480]

# viewer.py imports IPython at module scope and the suite's python has none -
# the same stub tests/selection_shells.py carries, and for the same reason:
# this probe wants the HTML _display_viewer writes, not a notebook.
CELLS = []
try:
    import IPython.display  # noqa: F401
except ImportError:
    _disp = types.ModuleType('IPython.display')

    class _H:                                    # noqa: D401 - IPython.HTML
        def __init__(self, data): CELLS.append(data)

    for _n, _v in (('display', lambda *a, **k: None), ('HTML', _H),
                   ('Javascript', _H), ('update_display', lambda *a, **k: None)):
        setattr(_disp, _n, _v)
    _ip = types.ModuleType('IPython'); _ip.display = _disp
    sys.modules['IPython'] = _ip; sys.modules['IPython.display'] = _disp
sys.path.insert(0, ROOT)
import py2Dmol  # noqa: E402

v = py2Dmol.view((600, 420))
v.show()
v.add_pdb(os.path.join(ROOT, "1UBQ.cif"), name="obj", use_biounit=False)
html = "\n".join(c for c in CELLS if isinstance(c, str))
if not html:
    sys.exit("the notebook produced no HTML to measure")
# THE CELL IS THE BOX, and the probe drives its width. Emulating a narrow
# DEVICE would measure the same thing through two layers of viewport
# arithmetic; what a notebook actually varies is the width of the output area.
open(PROBE, "w").write(
    "<!doctype html><html><head><meta charset='utf-8'></head>"
    "<body style='margin:0'><div id='cell' style='width:900px'>"
    + html + "</div></body></html>")

MEASURE = """(() => {
  const cell = document.querySelector('#cell');
  const m = document.querySelector('#mainContainer');
  const p = document.querySelector('#rightPanelContainer');
  const c = document.querySelector('#canvasContainer');
  if (!cell || !m || !p || !c) return JSON.stringify({error: 'missing element'});
  const rows = [];
  for (const arm of ['shipped', 'nowrap'])
    for (const w of WIDTHS_) {
      m.style.flexWrap = (arm === 'nowrap') ? 'nowrap' : '';
      cell.style.width = w + 'px';
      const pb = p.getBoundingClientRect(), cb = c.getBoundingClientRect(),
            eb = cell.getBoundingClientRect();
      rows.push({arm, w,
        wrapped: Math.round(pb.top) > Math.round(cb.top) + 4,
        spillRight: Math.round(pb.right - eb.right),
        panelW: Math.round(pb.width), canvasW: Math.round(cb.width)});
    }
  m.style.flexWrap = '';
  cell.style.width = '900px';
  return JSON.stringify(rows);
})()""".replace('WIDTHS_', json.dumps(WIDTHS))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome, ws = launch(DBG, "/tmp/py2dmol-nbnarrow")
try:
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_nbnarrow.html")
    wait_for(ws, "!!document.querySelector('#rightPanelContainer')", timeout=60,
             what="the notebook shell")
    time.sleep(1.5)
    out = json.loads(evaluate(ws, MEASURE))
finally:
    chrome.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass

bad = []
if isinstance(out, dict):
    sys.exit("page error: " + str(out.get('error')))

print(f"  {'arm':>8} {'cell':>5} {'canvas':>7} {'panel':>6} {'wrapped':>8} {'spill right':>12}")
for r in out:
    print(f"  {r['arm']:>8} {r['w']:>5} {r['canvasW']:>7} {r['panelW']:>6}"
          f" {str(r['wrapped']):>8} {r['spillRight']:>11}px")

shipped = [r for r in out if r['arm'] == 'shipped']
forced = [r for r in out if r['arm'] == 'nowrap']
for r in shipped:
    if r['panelW'] < 100:
        bad.append(f"at {r['w']}px the panel measures {r['panelW']}px wide - it is"
                   " not laid out at all, so nothing below this is a wrap test")
    if r['spillRight'] > 1:
        bad.append(f"at a cell of {r['w']}px the panel sticks"
                   f" {r['spillRight']}px out of the right-hand side")
    if r['w'] < 820 and not r['wrapped']:
        bad.append(f"at a cell of {r['w']}px the panel did not wrap under the"
                   " canvas")
# ...and the control: forced back to nowrap it must break, or this gate is
# reading something other than the rule it is here to hold.
if not any(r['spillRight'] > 1 for r in forced):
    bad.append("with flex-wrap forced to nowrap the panel still fits - the"
               " probe cannot see the fault it exists for")

print()
for b in bad:
    print("FAIL: " + b)
print("notebook_narrow: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
