"""A pair breathing across the chain-break distance does not cut the ribbon.

    python3 tests/chainbreak_hysteresis.py

Consecutive polymer positions are joined by DISTANCE (5.0 A between protein
alpha carbons), so a pair sitting near it crosses back and forth as a
trajectory breathes - and every crossing is a different segment count, a
broken ribbon and a full mesh rebuild (docs/FRAME_STABILITY.md). The rule
has a memory now: a pair that was joined breaks at 5.5 A, one that was not
joins at 4.5, and a fresh load takes 5.0 exactly.

`_traj_flicker.pdb` is that case and nothing else: a straight chain at 3.8 A
whose residue 30 steps 4.6 A then 5.4 A from its neighbour, both inside the
band, alternating frame by frame.

WHAT THIS ASKS:

  1. STEPPING HOLDS THE CHAIN - the same segment count on every frame.
     Without the memory it alternates 59 / 58.
  2. 🔴 AND A RECOMPUTE AT THE SAME FRAME HOLDS IT TOO. The segment cache is
     dropped by a dozen things that move no position - a side chain shown, a
     colour, Cyclic - and the memory first lived beside that cache, so
     `_invalidateSegmentCache()` at the 5.4 A frame threw it away and the
     recompute broke the pair it had just held: 59 -> 58 with no step at all.
     The memory is the object's now.
"""
import json, os, shutil, subprocess, sys, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_chainhyst.html")
PORT, DEBUG_PORT = 9879, 9880
TRAJ = "_traj_flicker.pdb"

if not os.path.exists(os.path.join(ROOT, TRAJ)):
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py")],
                   cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

JS = """
  //HELPERS
  const R = () => window.py2dmol_viewers['standalone-viewer-1'].renderer;
  const load = async () => {
    const txt = await (await fetch('/%TRAJ%')).text();
    await window.processFiles([{name: '%TRAJ%', readAsync: () => Promise.resolve(txt)}], false);
    await until(loaded, 15000); await settle(6);
  };
  const cnt = () => (R().segmentIndices || []).filter((s) => s.type === 'P').length;
  await load();
  const r = R();
  const out = { steps: [] };
  r.setFrame(0); r.render('s'); await settle(2);
  for (let f = 0; f < 6; f++) { r.setFrame(f); r.render('s'); await settle(2); out.steps.push(cnt()); }
  r.setFrame(1); r.render('s'); await settle(2);
  out.at1 = cnt();
  r._invalidateSegmentCache(); r.setFrame(1); r.render('invalidated'); await settle(2);
  out.at1Invalidated = cnt();
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
    proc, ws = cdp.launch(DEBUG_PORT, '/tmp/py2dmol-chain-hyst')
    ws.call('Page.enable'); ws.call('Runtime.enable')
    ws.call('Page.navigate', url='http://127.0.0.1:%d/_chainhyst.html' % PORT)
    cdp.wait_for(ws, "typeof window.processFiles === 'function'",
                 what="dev.html to load")
    R = cdp.evaluate(ws, '(async () => {\n' + JS + '\n})()') or {}
finally:
    if proc: proc.kill()
    httpd.shutdown()
    if os.path.exists(PROBE): os.remove(PROBE)
    shutil.rmtree('/tmp/py2dmol-chain-hyst', ignore_errors=True)

steps = R.get('steps') or []
print(f"  polymer segments while stepping 0..5: {steps}")
print(f"  at the 5.4 A frame: {R.get('at1')}, after the segment cache is dropped:"
      f" {R.get('at1Invalidated')}")
bad = []
if len(steps) < 6 or not steps[0]:
    bad.append("the stepping leg measured nothing")
elif len(set(steps)) != 1:
    bad.append(f"the chain cut and rejoined as the trajectory stepped: {steps}")
elif R.get('at1Invalidated') != steps[0]:
    bad.append(f"dropping the segment cache at the same frame broke the chain:"
               f" {R.get('at1')} -> {R.get('at1Invalidated')}")
for b in bad:
    print("FAIL: " + b)
print("chainbreak hysteresis: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
