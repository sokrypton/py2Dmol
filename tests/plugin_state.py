"""Plugin payloads through the Python side: add, save_state, load_state, the page.

    python3 tests/plugin_state.py
    python3 tests/plugin_state.py --write-golden DIR    # record what a NO-PLUGIN viewer writes
    python3 tests/plugin_state.py --golden DIR          # ...and compare (see R4 below)

WHAT IS CLAIMED (docs/PLUGINS.md, R3 and R4):

  R3  A plugin's payload is VIEWER-level state. It survives save_state ->
      load_state -> to_html untouched, including for a plugin this process has
      never heard of, which is kept verbatim and warned about ONCE. A payload
      hung on an OBJECT is dropped by the existing save_state whitelist, which
      is why it is not kept there - the last check below is that control.
  R4  A viewer with no plugin writes the SAME BYTES as before: the page from
      to_html() and the file from save_state(). Two layers: no plugin mentions
      leak into either, always; and, when a golden directory recorded from the
      PRISTINE tree is given, the bytes are identical to it. Without one the
      byte comparison prints SKIP - it is not a pass, and run.sh does not claim
      it is.

ALSO MEASURED, because each is a way for this to go wrong quietly:

  * a payload containing `</script><!--` does not end the tag it sits in;
  * register_plugin refuses a source it cannot make safe, and says why;
  * the plugin's JavaScript is inlined for a viewer that has a payload for it,
    and for no other;
  * add_plugin refuses what JSON cannot carry (NaN, a set) at the call, not in
    the page;
  * clear() forgets the plugins with the rest of the viewer.

Each guard fails a check when it is removed: dropping the `plugins` line from
save_state fails the round trip; returning early from the load_state block fails
the unknown-name check; emitting the page script unconditionally fails R4.
"""
import hashlib
import json
import os
import re
import sys
import tempfile
import types
import warnings

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
try:
    import IPython.display  # noqa: F401
except ImportError:
    _disp = types.ModuleType('IPython.display')
    for _n in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(_disp, _n, lambda *a, **k: None)
    _ip = types.ModuleType('IPython')
    _ip.display = _disp
    sys.modules['IPython'] = _ip
    sys.modules['IPython.display'] = _disp
sys.path.insert(0, ROOT)
import py2Dmol  # noqa: E402
from py2Dmol import viewer as V  # noqa: E402

assert py2Dmol.__file__.startswith(ROOT), py2Dmol.__file__
bad = 0


def ok(c, msg):
    global bad
    print(('PASS ' if c else 'FAIL ') + msg)
    if not c:
        bad += 1


def skip(msg):
    print('SKIP ' + msg)


def helix_pdb(path, n=30):
    """A CA-only helix: enough of a structure for a viewer to hold."""
    import math
    lines = []
    for i in range(n):
        th = i * 100 * math.pi / 180
        lines.append('ATOM  %5d  CA  ALA A%4d    %8.3f%8.3f%8.3f  1.00 50.00           C'
                     % (i + 1, i + 1, 2.3 * math.cos(th), 2.3 * math.sin(th), 1.5 * i))
    open(path, 'w').write('\n'.join(lines) + '\nEND\n')
    return path


def page_payload(html):
    m = re.search(r"window\.py2dmol_plugins\['[^']+'\] = (\{.*?\});</script>", html, re.S)
    return json.loads(m.group(1)) if m else None


def fresh(tmp, **kw):
    v = py2Dmol.view(style='cartoon', id='fixedid', **kw)
    with open(os.devnull, 'w') as dn:
        old, sys.stdout = sys.stdout, dn
        try:
            v.add_pdb(helix_pdb(os.path.join(tmp, 'h.pdb')), name='crn')
        finally:
            sys.stdout = old
    return v


# WHAT A NO-PLUGIN VIEWER WRITES. Kept in a function of its own that touches no plugin
# API, so `--write-golden` runs unchanged against a PRISTINE tree that has none.
def nochange_outputs(tmp_dir):
    v = fresh(tmp_dir)
    path = os.path.join(tmp_dir, 'nochange.json')
    old, sys.stdout = sys.stdout, open(os.devnull, 'w')
    try:
        v.save_state(path)
    finally:
        sys.stdout = old
    return v.to_html(bundle='bundle.js'), open(path).read()


golden = None
for i, a_ in enumerate(sys.argv):
    if a_ in ('--write-golden', '--golden') and i + 1 < len(sys.argv):
        golden = (a_, sys.argv[i + 1])

MESH = {'levels': [{'iso': -1.0, 'rgb': [30, 90, 200], 'verts': [[0.0, 1.5, 2.25], [1.0, 1.0, 1.0], [2.0, 0.5, -1.0]],
                    'faces': [[0, 1, 2]]}], 'probe': 'ethanol', 'note': 'unicode δG ≈ kcal/mol',
        'tricky': '</script><!-- x --><script>alert(1)</script>'}

tmp = tempfile.mkdtemp()
st = os.path.join(tmp, 's.json')
if golden and golden[0] == '--write-golden':
    os.makedirs(golden[1], exist_ok=True)
    _h, _j = nochange_outputs(tmp)
    open(os.path.join(golden[1], 'nochange.html'), 'w').write(_h)
    open(os.path.join(golden[1], 'nochange.json'), 'w').write(_j)
    print('wrote golden to', golden[1], '(', len(_h), 'bytes page,', len(_j), 'bytes state )')
    sys.exit(0)
quiet = open(os.devnull, 'w')


def save(v, path):
    old, sys.stdout = sys.stdout, quiet
    try:
        v.save_state(path)
    finally:
        sys.stdout = old


def load(v, path):
    old, sys.stdout = sys.stdout, quiet
    try:
        v.load_state(path)
    finally:
        sys.stdout = old


# ---- register_plugin: what it will and will not inline -------------------------
def raises(fn, exc, needle):
    try:
        fn()
    except exc as e:
        return needle in str(e)
    except Exception:
        return False
    return False


ok(raises(lambda: V.register_plugin('bad name', 'x'), ValueError, 'name'), 'register_plugin refuses a name it cannot put in an attribute')
ok(raises(lambda: V.register_plugin('volume', 'a</script>b'), ValueError, '</script'),
   'register_plugin REFUSES a source containing </script, and names it')
ok(raises(lambda: V.register_plugin('volume', 'x = 1; </SCRIPT >'), ValueError, '</script'),
   '...in any case')
ok(raises(lambda: V.register_plugin('volume', 'a <!-- b'), ValueError, '<!--'), 'register_plugin REFUSES <!--, which opens an HTML comment inside a script')
ok(raises(lambda: V.register_plugin('volume', 123), TypeError, 'str'), 'register_plugin wants text')
V.register_plugin('volume', "window.__volumeLoaded = 'ok' + '<\\/script>';", '0.1')
ok(V._PLUGIN_SOURCES['volume'][1] == '0.1', 'an acceptable source is kept (with its version)')

# ---- 1. a KNOWN plugin round-trips ------------------------------------------------
a = fresh(tmp)
ret = a.add_plugin('volume', MESH, object='crn', frame=0, options={'level:-1.0:visible': True}, version='0.1')
ok(ret is a, 'add_plugin returns the viewer (chainable)')
MESH_COPY = json.loads(json.dumps(MESH))
MESH['levels'][0]['iso'] = 99.0                              # the caller keeps using its own object
ok(a._plugins['volume']['payloads'][0]['payload']['levels'][0]['iso'] == -1.0,
   'the payload is COPIED at add time (a later edit of the caller\'s dict does not change the viewer)')
MESH['levels'][0]['iso'] = -1.0
a.set_plugin_option('volume', 'level:-1.0:visible', False)
ok(a._plugins['volume']['options'] == {'level:-1.0:visible': False}, 'set_plugin_option changes one option')
a.set_plugin_option('volume', 'level:-1.0:visible', True)
save(a, st)
raw = json.load(open(st))
ok('plugins' in raw and 'volume' in raw['plugins'], 'save_state writes a top-level "plugins" block (viewer level)')
ok(raw['plugins']['volume'] == {'version': '0.1', 'apiVersion': None, 'options': {'level:-1.0:visible': True},
                                'payloads': [{'object': 'crn', 'frame': 0, 'payload': MESH_COPY}]},
   'the block is {version, apiVersion, options, payloads: [{object, frame, payload}]}')
b = py2Dmol.view()
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter('always')
    load(b, st)
ok(not [x for x in w if 'plugin' in str(x.message)], 'a KNOWN plugin loads without a warning')
ok(json.loads(json.dumps(b._plugins)) == json.loads(json.dumps(a._plugins)),
   'the payload round-trips exactly (unicode, floats, nesting, the </script> in it)')
html = b.to_html(bundle='bundle.js')
pp = page_payload(html)
ok(pp is not None and pp['volume']['payloads'][0]['payload']['tricky'] == MESH_COPY['tricky'],
   'the payload reaches the generated page and decodes back')
ok('</script><!-- x -->' not in html and '<script>alert(1)</script>' not in html,
   'a </script> inside a payload does not end the tag: every < is escaped')
ok(html.count('data-py2dmol-plugin="volume"') == 1 and "window.__volumeLoaded = 'ok'" in html,
   'the plugin\'s JavaScript is inlined, once, for a viewer that has a payload for it')
ok(html.index('data-py2dmol-plugin="volume"') < html.index('initializePy2DmolViewer(container'),
   'the plugin script precedes the viewer bootstrap')
# ...and for no other
c2 = fresh(tmp)
c2.add_plugin('other', {'x': 1})
ok('data-py2dmol-plugin="volume"' not in c2.to_html(bundle='bundle.js'),
   'a plugin this viewer has no payload for is NOT inlined into its page')
# every bundle mode inlines it: the library inline, external, and a grid cell without one
for mode in ('inline', 'external', 'bundle.js'):
    h = b.to_html(bundle=mode)
    ok('data-py2dmol-plugin="volume"' in h, 'to_html(bundle=%r) inlines the plugin script' % mode)
ok("data-py2dmol-plugin" in b._display_viewer(static_data=b.objects, include_libs=False),
   'and so does a viewer that shares the library (include_libs=False)')

# ---- 2. an UNKNOWN plugin ---------------------------------------------------------------
raw['plugins']['futurething'] = {'version': '9.9', 'apiVersion': 7, 'options': {'k': [1, 2]},
                                 'payloads': [{'object': None, 'frame': None, 'payload': {'x': {'y': [1, {'z': None}]}}}]}
raw['plugins']['another'] = {'version': None, 'apiVersion': None, 'options': {}, 'payloads': []}
json.dump(raw, open(st, 'w'))
c = py2Dmol.view()
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter('always')
    load(c, st)
msgs = [str(x.message) for x in w if 'plugin' in str(x.message)]
ok(len(msgs) == 1 and 'futurething' in msgs[0] and 'another' in msgs[0] and 'volume' not in msgs[0],
   'unknown plugin names warn ONCE in total, naming every unknown one: ' + (msgs[0][:80] + '...' if msgs else '(none)'))
ok(c._plugins['futurething'] == raw['plugins']['futurething'] and c._plugins['another'] == raw['plugins']['another'],
   'unknown plugin payloads are kept verbatim')
st2 = os.path.join(tmp, 's2.json')
save(c, st2)
back = json.load(open(st2))['plugins']
ok(back['futurething'] == raw['plugins']['futurething'] and back['volume'] == raw['plugins']['volume'],
   'unknown plugins are written back by save_state (they survive a SECOND round)')

# ---- 3. no plugin: nothing written --------------------------------------------------------
nhtml, njson = nochange_outputs(tmp)
ok('plugins' not in json.loads(njson), 'R4: no plugin -> no "plugins" key in the state file')
ok('py2dmol_plugins' not in nhtml and 'data-py2dmol-plugin' not in nhtml,
   'R4: no plugin -> nothing about plugins in the page')
if golden and golden[0] == '--golden':
    gh = open(os.path.join(golden[1], 'nochange.html')).read()
    gj = open(os.path.join(golden[1], 'nochange.json')).read()
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest()[:12]
    ok(nhtml == gh, 'R4: to_html() of a no-plugin viewer is BYTE-IDENTICAL to the pristine one (%s == %s)' % (sha(nhtml), sha(gh)))
    ok(njson == gj, 'R4: save_state() of a no-plugin viewer is BYTE-IDENTICAL to the pristine one (%s == %s)' % (sha(njson), sha(gj)))
    # the control: a viewer WITH a plugin is not
    p = fresh(tmp)
    p.add_plugin('volume', {'a': 1})
    ok(p.to_html(bundle='bundle.js') != gh, 'control: a viewer with a plugin does NOT match the golden page')
else:
    skip('R4 byte comparison: no --golden DIR (record one from the PRISTINE tree with --write-golden)')

# ---- 4. clear(), validation, live -------------------------------------------------------------
k = fresh(tmp)
k.add_plugin('volume', {'a': 1})
k.clear()
ok(k._plugins == {}, 'clear() resets the plugins')
ok(raises(lambda: k.set_plugin_option('volume', 'x', 1), KeyError, 'volume'), 'set_plugin_option on a plugin with no payload says so')
ok(raises(lambda: k.add_plugin('volume', {'a': float('nan')}), ValueError, 'JSON'), 'add_plugin refuses NaN at the call')
ok(raises(lambda: k.add_plugin('volume', {'a': {1, 2}}), TypeError, 'JSON'), 'add_plugin refuses a payload JSON cannot carry, at the call')
ok(raises(lambda: k.add_plugin('bad name', {}), ValueError, 'name'), 'add_plugin refuses a bad name')
ok(raises(lambda: k.add_plugin('volume', {}, frame='x'), TypeError, 'frame'), 'add_plugin wants an integer frame')
ok(raises(lambda: k.add_plugin('volume', {}, frame=True), TypeError, 'frame'), 'add_plugin: a bool is not a frame')
ok(raises(lambda: k.add_plugin('volume', {}, object=5), TypeError, 'object'), 'add_plugin wants an object NAME (str) or None, not 5')
ok(raises(lambda: k.add_plugin('volume', {}, object=['a']), TypeError, 'object'), 'add_plugin: a list is not an object name')
ok(raises(lambda: k.add_plugin('volume', {}, api_version='1'), TypeError, 'api_version'), 'add_plugin wants an int api_version or None, not \'1\'')
ok(raises(lambda: k.add_plugin('volume', {}, api_version=True), TypeError, 'api_version'), 'add_plugin: a bool is not an api_version')
ok(raises(lambda: k.add_plugin('volume', {}, version=1), TypeError, 'version'), 'add_plugin wants a str version or None')
ok(k._plugins == {}, 'a refused add_plugin leaves NO half-made entry behind')
k.add_plugin('volume', {}, object='crn', frame=0, api_version=1, version='0.1')
ok(k._plugins['volume']['apiVersion'] == 1 and k._plugins['volume']['payloads'][0]['object'] == 'crn', 'the valid spelling of all of them is accepted')
k.clear()
# ---- 4b. THE LIVE PATH: a viewer already on the page is sent what changed --------------------------
# The page is written by to_html(), which records what it inlined; every later
# add_plugin / set_plugin_option on a live viewer is an incremental update, and
# what that update carries is read off the payload the viewer would be handed.
LIVE_SRC = '(function(){var P=window.py2dmolPlugins=window.py2dmolPlugins||{list:[],pending:[]};}());'
py2Dmol.register_plugin('livep', LIVE_SRC, version='1')
lv = fresh(tmp)
lv.add_plugin('volume', {'a': 1})
lv.to_html()
sent = []
def _cap(html, payload_json=None, **kw):
    if payload_json:
        sent.append(payload_json)
lv._emit_to_output = _cap
lv._is_live = True
def last_plugins():
    return (json.loads(sent[-1]).get('viewer') or {}).get('plugins') if sent else None
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter('always')
    lv.add_plugin('volume', {'b': 2})
ok(not any('show()' in str(x.message) for x in w), 'live: add_plugin no longer tells the reader to show() again')
lp = last_plugins() or {}
ok([x['payload'] for x in (lp.get('volume') or {}).get('payloads', [])] == [{'b': 2}]
   and (lp.get('volume') or {}).get('payloads_from') == 1,
   'live: add_plugin on a viewer already on the page SENDS the new payload alone, after the 1 the page has')
lv.add_plugin('volume', {'c': 3})
lp = last_plugins() or {}
ok([x['payload'] for x in (lp.get('volume') or {}).get('payloads', [])] == [{'c': 3}]
   and (lp.get('volume') or {}).get('payloads_from') == 2,
   'live: ...and the next one sends ITS payload, not every payload before it')
ok('source' not in (lp.get('volume') or {}), 'live: no source for a plugin the process never registered')
n0 = len(sent)
lv.set_plugin_option('volume', 'level', 0.5)
lp = last_plugins() or {}
ok(len(sent) == n0 + 1 and (lp.get('volume') or {}).get('options', {}).get('level') == 0.5,
   'live: set_plugin_option is sent at once')
ok('payloads' not in (lp.get('volume') or {}), 'live: an option change does NOT re-send the payloads (the mesh stays on the page)')
n0 = len(sent)
lv.set_plugin_option('volume', 'level', 0.5)
ok(len(sent) == n0, 'live: an option set to what it already is sends nothing')
lv.add_plugin('livep', {'x': '</script><b>'})
lp = last_plugins() or {}
ok((lp.get('livep') or {}).get('source') == LIVE_SRC, 'live: a plugin the page has never had travels WITH its source')
ok('</script' not in sent[-1].lower(), 'live: a payload holding </script> is escaped in the update')
lv.set_plugin_option('livep', 'k', 1)
ok('source' not in (last_plugins() or {}).get('livep', {}), 'live: ...and its source travels once')
# an edited plugin, registered again under the same name and version, travels again
_keep_src = V._PLUGIN_SOURCES['livep']
py2Dmol.register_plugin('livep', LIVE_SRC + '\n// edited', version=_keep_src[1])
lv.set_plugin_option('livep', 'k', 2)
ok((last_plugins() or {}).get('livep', {}).get('source') == LIVE_SRC + '\n// edited',
   'live: NEW code for a plugin the page already has is sent again')
V._PLUGIN_SOURCES['livep'] = _keep_src
pg = fresh(tmp)
pg.add_plugin('livep', {'x': 1})
pg.to_html()
pg._emit_to_output = _cap
pg._is_live = True
pg.add_plugin('livep', {'x': 2})
ok('source' not in (last_plugins() or {}).get('livep', {}), 'live: no source for a plugin whose script the page already carries')

# ---- 4c. the tube draws plugins now, so add_plugin has nothing to warn about there ---------------
tv = py2Dmol.view()
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter('always')
    tv.add_plugin('volume', {'a': 1})
ok(not any('tube' in str(x.message) for x in w), "add_plugin on a 'tube' viewer does not warn - the tube draws plugins")

# ---- 5. controls: the existing whitelist is why the payload is viewer-level ---------------------------
e = fresh(tmp)
e.objects[0]['plugins'] = {'volume': MESH}            # hung on the OBJECT, like every other per-object field
st4 = os.path.join(tmp, 's4.json')
save(e, st4)
ok('volume' not in json.dumps(json.load(open(st4))), 'CONTROL: a payload hung on the object dict is DROPPED by save_state (object whitelist) - hence viewer-level')
raw2 = json.load(open(st))
del raw2['plugins']
json.dump(raw2, open(st, 'w'))
d = py2Dmol.view()
load(d, st)
ok(d._plugins == {}, 'CONTROL: with the "plugins" key stripped the payload is gone (the round-trip asserts can fail)')
sys.exit(1 if bad else 0)
