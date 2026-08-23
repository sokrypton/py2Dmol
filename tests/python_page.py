"""The PYTHON api's own page, with two objects, checked in a real browser.

    python3 tests/python_page.py

The Python path builds its page from `_display_viewer` and loads viewer-mol.js
and the cartoon plugin and nothing else - no object list, no sequence strip -
so what it covers is the RENDERER'S multi-object handling, reached through the
state that `view.set_color`, `set_sse` and `add_contacts` write:

  * one object drawn to begin with, exactly as a Python page has always been;
  * each object's per-position colour on its own residue (both objects here
    colour their residue 3, and the two must not be the same colour);
  * forced secondary structure on the object that was given it, and not on the
    other object's residue of the same number;
  * a contact of "chain A 10 to 20" in EACH object, which both objects have -
    each must resolve inside its own window, or one of them draws twice and
    the other not at all.

IPython is stubbed when it is absent: the module imports it at load time, and
nothing here displays anything.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, types, time

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, '_pypage.html')

try:
    import IPython.display  # noqa: F401
except ImportError:
    ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')
    for n in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(disp, n, lambda *a, **k: None)
    ip.display = disp
    sys.modules['IPython'] = ip; sys.modules['IPython.display'] = disp
sys.path.insert(0, ROOT)
import py2Dmol

v = py2Dmol.view()
v.add_pdb(ROOT + '/1UBQ.cif', name='ubq')
v.add_pdb(ROOT + '/6MRR.cif', name='pep')
v.set_color('red', name='ubq', position=3)      # ubq's OWN residue 3
v.set_color('blue', name='pep', position=3)     # pep's own residue 3
v.set_sse('H', name='pep', position=5)
# ...and a contact in EACH object, between residues both objects have: chain A
# 10-20 exists in ubq and in pep, so each must resolve inside its own window
v.add_contacts([['A', 10, 'A', 20, 1.0]], name='ubq')
v.add_contacts([['A', 10, 'A', 20, 1.0]], name='pep')
body = v._display_viewer(static_data=v.objects)

JS = """
<script>
window.addEventListener('load', () => {
  const go = async () => {
    const R = {};
    try {
      await new Promise((s) => setTimeout(s, 900));
      const ids = Object.keys(window.py2dmol_viewers || {});
      R.viewers = ids;
      const r = window.py2dmol_viewers[ids[0]].renderer;
      R.objects = Object.keys(r.objectsData);
      R.drawn = r.drawnObjects();
      R.current = r.currentObjectName;
      R.n = r.coords.length;
      R.merged = !!(r.multiState && r.multiState.enabled);
      const col = (i) => { const c = r.getAtomColor(i, r._getEffectiveColorMode(i));
        return [c.r, c.g, c.b].join(','); };
      R.colourOfThird = col(3);
      // ...now show BOTH, which the renderer supports even with no list UI
      r.setShownObjects(R.objects);
      await new Promise((s) => setTimeout(s, 400));
      R.bothDrawn = r.drawnObjects();
      R.bothN = r.coords.length;
      R.bothMerged = !!(r.multiState && r.multiState.enabled);
      const offs = r.multiState.sourceOffsets;
      R.offsets = offs;
      R.ubqThird = col(offs[0] + 3);
      R.pepThird = col(offs[1] + 3);
      // the forced SSE of pep's residue 5 must be pep's, not ubq's
      R.sseAt = (r.forcedSseFor ? r.forcedSseFor([offs[1] + 5]) : '?');
      R.sseOther = (r.forcedSseFor ? r.forcedSseFor([offs[0] + 5]) : '?');
      // ...and the contact of ubq resolves inside ubq
      R.contactSegs = r.segmentIndices.filter((s) => s.type === 'C')
        .map((s) => [s.idx1, s.idx2, (r.ownerOf(s.idx1) || {}).name,
          (r.ownerOf(s.idx2) || {}).name]);
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 300);
});
</script>
"""
page = ('<!doctype html><html><head><meta charset="utf-8"></head><body>'
        + body + JS + '</body></html>')
# the page references the bundles by relative path from the repo root
open(PROBE, 'w').write(page)

box = []
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))))
        self.send_response(200); self.send_header('Content-Length', '2')
        self.end_headers(); self.wfile.write(b'ok')

socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 9601), H); httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, '--headless=new', '--user-data-dir=/tmp/py2dmol-pypage',
                      '--no-first-run', '--window-size=1000,1000',
                      'http://127.0.0.1:9601/_pypage.html'],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + 90
while not box and time.time() < end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE)
shutil.rmtree('/tmp/py2dmol-pypage', ignore_errors=True)
R = box[0] if box else {'error': 'no result posted'}
if R.get('error'):
    sys.exit('page error: ' + R['error'])

print(f"objects {R['objects']}, drawn {R['drawn']} ({R['n']} positions,"
      f" merged {R['merged']})")
print(f"  both shown: {R['bothDrawn']} ({R['bothN']} positions,"
      f" offsets {R['offsets']})")
print(f"  residue 3: ubq {R['ubqThird']}, pep {R['pepThird']}")
print(f"  forced SSE: pep 5 -> {R['sseAt']!r}, ubq 5 -> {R['sseOther']!r}")
print(f"  contacts: {R['contactSegs']}")

bad = []
if R['drawn'] != ['ubq'] or R['merged']:
    bad.append(f"a Python page opened showing {R['drawn']} - one object is the"
               " resting state there as everywhere else")
if R['bothDrawn'] != ['ubq', 'pep'] or not R['bothMerged']:
    bad.append(f"showing both left {R['bothDrawn']}")
if R['bothN'] != 144 or R['offsets'] != [0, 76]:
    bad.append(f"the merge came out {R['bothN']} positions at {R['offsets']}")
if R['ubqThird'] == R['pepThird']:
    bad.append(f"both objects' residue 3 is {R['ubqThird']} - a per-position"
               " colour set from Python landed on the wrong object")
if R['sseAt'] != 'H' or R['sseOther'] != 'none':
    bad.append(f"forced SSE reads {R['sseAt']!r} on the object given it and"
               f" {R['sseOther']!r} on the other")
owners = [c[2] for c in R['contactSegs']]
if sorted(owners) != ['pep', 'ubq'] or any(c[2] != c[3] for c in R['contactSegs']):
    bad.append(f"the two contacts resolved to {R['contactSegs']} - each names"
               " chain A 10 to 20, which both objects have")
for m in bad:
    print('FAIL:', m)
sys.exit(1 if bad else 0)
