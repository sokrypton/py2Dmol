"""The PYTHON api's own page, with two objects, checked in a real browser.

    python3 tests/python_page.py

The Python path builds its page from `_display_viewer` and loads core/mol.js
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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

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

# ...and the state pipeline both ways, before the page: what Python saves must
# reload in Python, and what the WEB saves - which carries keys Python has
# never seen, `shown_objects` among them - must not choke it.
def _check_state_round_trip():
    import tempfile
    a = py2Dmol.view()
    a.add_pdb(ROOT + '/1UBQ.cif', name='ubq')
    a.add_pdb(ROOT + '/6MRR.cif', name='pep')
    a.set_color('red', name='ubq', position=3)
    a.add_contacts([['A', 10, 'A', 20, 1.0]], name='pep')
    # chain= AND position= TOGETHER MEANT THE UNION, and the selector on the JS
    # side reads that pair as the intersection. One word cannot mean two things
    # across two languages, and quietly changing which one Python meant would
    # recolour existing notebooks - so the combination is refused by name.
    # Either key ALONE is untouched, which is what the two calls below check.
    try:
        a.set_color('red', chain='A', position=3)
        raise AssertionError('set_color(chain=, position=) must refuse the'
                             ' combination - it used to mean the union while'
                             ' a JS selector reads it as the intersection')
    except ValueError as e:
        assert 'ambiguous' in str(e), e
    a.set_color('green', name='ubq', chain='A')
    a.set_color('blue', name='ubq', position=7)
    # ...AND THE TWO THINGS THAT BELONG TO THE VIEWER, which the round trip was
    # losing. They are stored as private fields and written into the config on
    # the way out, and _display_viewer POPS the key when the field is None - so
    # load_state restored them into the config and the next show() threw them
    # away. A saved slab came back off; a saved set of objects came back as
    # one. `multi` is not in this pair: it is read from the config and
    # re-resolved against whatever objects exist.
    a.clip(name='ubq', position=(0, 5))
    a.show_objects(['ubq', 'pep'])
    path = os.path.join(tempfile.gettempdir(), 'py2dmol_state_check.json')
    a._display_viewer(static_data=a.objects)     # ...which is what writes them
    a.save_state(path)
    st = json.load(open(path))
    b = py2Dmol.view(); b.load_state(path)
    # ...compared THROUGH JSON. A position map is keyed by an int in memory and
    # by a string once it has been through a file, because that is what JSON
    # keys are; JS reads either, so the two states mean the same thing and a
    # literal comparison would fail on the round trip it is meant to bless.
    def shape(view):
        return json.loads(json.dumps(
            [[o.get('color'), o.get('contacts')] for o in view.objects]))
    same = shape(a) == shape(b)
    b._display_viewer(static_data=b.objects)
    viewer_own = (b.config.get('clip'), b.config.get('shown_objects'))
    # ...now the web's extra keys
    st['viewer_state']['shown_objects'] = ['ubq', 'pep']
    st['objects'][0]['viewerState'] = {'style': 'tube', 'styleChosen': True}
    json.dump(st, open(path, 'w'))
    c = py2Dmol.view(); c.load_state(path)
    os.remove(path)
    # ...AND LEAVE NO MARK ON THE MODULE. _LENT_BUNDLE is process state: the
    # first viewer to reach _display_viewer writes the library and every later
    # one writes a request to borrow it. A check that builds a viewer here and
    # nowhere the page can see it would make the page's OWN first viewer a
    # borrower, with nothing on the page lending - a blank page and a dozen
    # unrelated failures.
    py2Dmol.viewer._LENT_BUNDLE = None
    return same, [len(o['frames']) for o in c.objects], viewer_own

SAME, WEB_FRAMES, VIEWER_OWN = _check_state_round_trip()

# SIDE CHAINS, WHICH PYTHON COULD NOT ASK FOR AT ALL until show_sidechains.
# The flag carries the atoms - without it there is no table and nothing to draw
# - and the two verbs are RELATIVE, so this is 10-14 minus 12.
v = py2Dmol.view(sidechains=True)
v.add_pdb(ROOT + '/1UBQ.cif', name='ubq')
v.add_pdb(ROOT + '/6MRR.cif', name='pep')
v.set_color('red', name='ubq', position=3)      # ubq's OWN residue 3
v.set_color('blue', name='pep', position=3)     # pep's own residue 3
v.set_sse('H', name='pep', position=5)
# ...and a contact in EACH object, between residues both objects have: chain A
# 10-20 exists in ubq and in pep, so each must resolve inside its own window
v.add_contacts([['A', 10, 'A', 20, 1.0]], name='ubq')
v.add_contacts([['A', 10, 'A', 20, 1.0]], name='pep')
v.show_sidechains(name='ubq', position=(10, 15))
v.hide_sidechains(name='ubq', position=12)

# ...and two more, THE SAME LENGTH, one carrying chains and one carrying none.
# The renderer's per-field caches let a frame that omits `chains` inherit the
# last array it saw, which is right within an object - a trajectory writes them
# on frame 0 and omits them after - and was guarded by nothing but
# `length === n`. Two objects of equal length therefore inherited each other's:
# switch from the two-chain one to the one-chain one and it was drawn as two
# chains, split at a break that is not in it. The lengths must MATCH for this to
# probe anything, which is why they are built rather than loaded.
import numpy as _np
_t = _np.linspace(0, 8 * _np.pi, 60)
_helix = _np.stack([_np.cos(_t) * 5, _np.sin(_t) * 5, _t * 1.5], axis=1)
v.add(_helix, align=False, name='twochain', chains=['A'] * 30 + ['B'] * 30)
v.add(_helix, align=False, name='nochain')          # no chains at all
v.add(_helix, align=False, name='nochain')          # ...and a second frame

body = v._display_viewer(static_data=v.objects)

JS = """
<script>
window.addEventListener('load', () => {
  //HELPERS
  const go = async () => {
    const R = {};
    try {
      await settle();
      const ids = Object.keys(window.py2dmol_viewers || {});
      R.viewers = ids;
      const r = window.py2dmol_viewers[ids[0]].renderer;
      // WHAT PYTHON ASKED FOR, AS THE OBJECT SEES IT. The set is the
      // object's own numbering and the requests are replayed in order, so
      // show(10..14) then hide(12) is four residues and not five.
      R.sc = {
        set: [...((r.objectsData.ubq || {}).sidechains || [])].sort((a, b) => a - b),
        map: r.sidechainMap ? r.sidechainMap.size : -1,
        table: !!(r.sidechains),
        coords: r.coords ? r.coords.length : -1,
      };
      R.objects = Object.keys(r.objectsData);
      R.drawn = r.drawnObjects();
      R.current = r.currentObjectName;
      R.n = r.coords.length;
      R.merged = !!(r.multiState && r.multiState.enabled);
      const col = (i) => { const c = r.getAtomColor(i, r._getEffectiveColorMode(i));
        return [c.r, c.g, c.b].join(','); };
      R.colourOfThird = col(3);
      // --- TWO OBJECTS OF THE SAME LENGTH, and only one of them has chains.
      // BEFORE the merge below, and never through setShownObjects: both of
      // those build a chains array of their own, so neither ever asks the
      // per-field caches anything. The route that inherits is the single
      // object one - _switchToObject then setFrame - which is what the object
      // picker calls, and it was reusing the LAST object's arrays whenever the
      // new one omitted them and the lengths happened to match.
      const pick = async (name) => { r._switchToObject(name); r.setFrame(0); await settle(); };
      await pick('twochain');
      R.twoChain = [...new Set(r.chains)].sort().join('');
      await pick('nochain');
      R.noChain = [...new Set(r.chains)].sort().join('');
      R.noChainN = r.coords.length;
      // ...and the inheritance the cache exists for: frame 1 of twochain
      // carries no chains of its own and must still be AB
      await pick('twochain');
      r.setFrame(1); await settle();
      R.inheritF0 = [...new Set(r.chains)].sort().join('');
      await pick('ubq');

      // ...now show BOTH, which the renderer supports even with no list UI.
      // Named rather than "all of them": the page carries two more objects for
      // the equal-length check below, and this measures the merge of these two.
      r.setShownObjects(['ubq', 'pep']);
      await settle();
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
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)
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
end = time.time() + DEADLINE
while not box and time.time() < end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE)
shutil.rmtree('/tmp/py2dmol-pypage', ignore_errors=True)
R = box[0] if box else {'error': 'no result posted'}
if R.get('error'):
    sys.exit('page error: ' + R['error'])

print(f"state round trip: python->python same {SAME}, web file loads {WEB_FRAMES}")
print(f"objects {R['objects']}, drawn {R['drawn']} ({R['n']} positions,"
      f" merged {R['merged']})")
print(f"  both shown: {R['bothDrawn']} ({R['bothN']} positions,"
      f" offsets {R['offsets']})")
print(f"  residue 3: ubq {R['ubqThird']}, pep {R['pepThird']}")
print(f"  forced SSE: pep 5 -> {R['sseAt']!r}, ubq 5 -> {R['sseOther']!r}")
print(f"  contacts: {R['contactSegs']}")
print(f"  equal-length objects: twochain {R.get('twoChain')!r},"
      f" nochain {R.get('noChain')!r} ({R.get('noChainN')} positions),"
      f" inherited within twochain {R.get('inheritF0')!r}")

bad = []
if not SAME:
    bad.append("a state file saved from Python did not reload with the same"
               " per-object colours and contacts")
if VIEWER_OWN != ({'object': 'ubq', 'positions': [0, 1, 2, 3, 4]}, ['ubq', 'pep']):
    bad.append(f"a reloaded state came back with clip/shown_objects"
               f" {VIEWER_OWN} - _display_viewer writes those keys from the"
               " private fields and pops them when it does not find one, so"
               " restoring them into the config alone loses them again")
if WEB_FRAMES != [1, 1]:
    bad.append(f"a state file saved by the WEB - which carries shown_objects and"
               f" a per-object viewerState - loaded as {WEB_FRAMES}")
if R['drawn'] != ['ubq'] or R['merged']:
    bad.append(f"a Python page opened showing {R['drawn']} - one object is the"
               " resting state there as everywhere else")
if R['bothDrawn'] != ['ubq', 'pep'] or not R['bothMerged']:
    bad.append(f"showing both left {R['bothDrawn']}")
sc = R.get('sc') or {}
print(f"  side chains: python asked for {sc.get('set')}, {sc.get('map')} atom"
      f" positions materialised (table: {sc.get('table')})")
if not sc.get('table'):
    bad.append('view(sidechains=True) sent no side-chain table, so this leg is'
               ' measuring nothing')
elif sc.get('set') != [10, 11, 13, 14]:
    bad.append(f"show_sidechains(position=(10, 15)) then"
               f" hide_sidechains(position=12) left {sc.get('set')}, wanted"
               " [10, 11, 13, 14] - the two verbs are relative and replayed in"
               " order, so the hide has to subtract from the show")
elif not sc.get('map'):
    bad.append('the set is right but nothing was materialised - the request'
               ' reached the object and no side chain was drawn')
# ...+ the side-chain atoms, which are APPENDED positions: 144 is the two
# objects' residues and the rest is what the request above drew.
if R['bothN'] != 144 + sc.get('map', 0) or R['offsets'] != [0, 76]:
    bad.append(f"the merge came out {R['bothN']} positions at {R['offsets']}")
if R['ubqThird'] == R['pepThird']:
    bad.append(f"both objects' residue 3 is {R['ubqThird']} - a per-position"
               " colour set from Python landed on the wrong object")
if R['sseAt'] != 'H' or R['sseOther'] != 'none':
    bad.append(f"forced SSE reads {R['sseAt']!r} on the object given it and"
               f" {R['sseOther']!r} on the other")
if R.get('twoChain') != 'AB':
    bad.append(f"the two-chain object reads {R.get('twoChain')!r}, so this pair"
               " cannot show the inheritance and the check below proves nothing")
if R.get('noChain') != 'A':
    bad.append(f"an object with no chains of its own reads {R.get('noChain')!r}"
               " after a two-chain object of the SAME LENGTH was shown - the"
               " per-field caches are the renderer's, not the object's, and"
               " `length === n` is not enough to tell two objects apart")
if R.get('inheritF0') != 'AB':
    bad.append(f"twochain reads {R.get('inheritF0')!r} - dropping the caches"
               " between objects has broken the inheritance they exist for,"
               " where a later frame omits what frame 0 carried")

owners = [c[2] for c in R['contactSegs']]
if sorted(owners) != ['pep', 'ubq'] or any(c[2] != c[3] for c in R['contactSegs']):
    bad.append(f"the two contacts resolved to {R['contactSegs']} - each names"
               " chain A 10 to 20, which both objects have")
for m in bad:
    print('FAIL:', m)
sys.exit(1 if bad else 0)
