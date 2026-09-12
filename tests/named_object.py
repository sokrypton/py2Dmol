"""A request that NAMES an object must reach that object, drawn or not.

    python3 tests/named_object.py

🔴 IT LANDED ON WHICHEVER OBJECT WAS ON SCREEN. Measured before the fix, with
1UBQ and 6MRR loaded and 6MRR drawn:

    r.showSidechains({object: '1UBQ', positions: [10, 11, 12]})
        -> 6MRR.sidechains = [10, 11, 12]
           1UBQ.sidechains = null

No error, no warning, and the wrong residues of the wrong structure drawn.
`localRangeOf(name)` returned `{off: 0, end: Infinity}` for ANY name while
nothing was merged - so positionsFor resolved the selector against the drawn
array whatever it named, and writeGroups then attributed the result to the
current object. src/app/objects.js had asked the question correctly for its own
purposes for as long as it existed; nothing else did.

WHY NOBODY HIT IT: the page always opened on the first object, and a script
that loads one structure and asks about it by name is asking about the drawn
one. It surfaced when the default object changed (see mostFramesOf) and a
notebook's `show_sidechains(name='ubq', ...)` stopped arriving - which is a
second bug, in the guard, and is checked here too.

WHAT IS MEASURED, with two structures loaded and the SECOND one drawn:

  * a named request lands on the object it names, in that object's own
    numbering, and the drawn object is untouched. Both halves: a write that
    reaches the right object AND spills into the wrong one is still wrong;
  * naming an object with no side-chain atoms is refused - the guard has to
    ask the NAMED object, not the drawn one, or it refuses valid requests and
    accepts invalid ones in equal measure;
  * a selector with no object name still means the drawn object, which is what
    every existing caller relies on;
  * `near` is refused for an object that is not drawn, rather than answered
    wrongly: it is a search over the drawn coordinates and there is no honest
    answer for a structure that is not among them.
"""
import http.server, json, os, shutil, socketserver, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, '_namedobj.html')
PORT, DBG = 9675, 9242

JS = """
<script>
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async () => {
   try {
    const load = async (f) => {
      const t = await (await fetch('/' + f)).text();
      await window.processFiles([{name: f, readAsync: () => Promise.resolve(t)}], true);
      await until(loaded, 120000);
      await settle(8);
    };
    await load('1UBQ.cif');
    await load('6MRR.cif');
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    const R = {drawn: r.currentObjectName, names: Object.keys(r.objectsData)};
    const other = R.names.find((n) => n !== r.currentObjectName);
    R.other = other;
    const sset = (n) => {
      const s = (r.objectsData[n] || {}).sidechains;
      return s ? [...s].sort((a, b) => a - b) : null;
    };
    // 1. NAMED, and not the drawn one
    r.showSidechains({object: other, positions: [10, 11, 12]});
    R.named = {onNamed: sset(other), onDrawn: sset(r.currentObjectName)};
    // 2. ...and taking it off again reaches the same place
    r.hideSidechains({object: other, positions: [11]});
    R.afterHide = sset(other);
    // 3. UNNAMED still means the drawn object
    r.showSidechains({positions: [4, 5]});
    R.unnamed = {onDrawn: sset(r.currentObjectName), onNamed: sset(other)};
    // 4. an object with no side-chain atoms is refused, BY NAME
    r.addObject('bare');
    r.addFrame({coords: [[0, 0, 0], [3.8, 0, 0], [7.6, 0, 0]]}, 'bare');
    try {
      r.showSidechains({object: 'bare', positions: [0]});
      R.bare = 'accepted';
    } catch (e) { R.bare = String(e.message || e); }
    // 5. ...and a spatial key on an object that is not drawn says so
    try {
      r.showSidechains({object: other, near: {positions: [0]}});
      R.near = 'accepted';
    } catch (e) { R.near = String(e.message || e); }
    // 6. EVERY WAY OF NARROWING, on the object that is not drawn.
    //
    // 🔴 A FRAME IS SNAKE_CASE. The first version of objectPositions read
    // `residueNumbers` and `positionTypes` - the RENDERER's spelling, which is
    // what positionsFor reads - where a stored frame carries `residue_numbers`
    // and `position_types`. Both threw "carries no residue numbers" at an
    // object that carries them: a wrong answer wearing an error message, and
    // invisible to an arm that only ever passed `positions`.
    R.narrows = {};
    const tries = {
      chain: {object: other, chain: 'A'},
      residues: {object: other, residues: [10, 11]},
      type: {object: other, type: 'P'},
      range: {object: other, range: [3, 6]},
      // 🔴 AND THE SAME TWO KEYS AGAINST A VALUE THE OBJECT HAS NOT. 1UBQ is
      // one chain of protein, so `chain: 'A'` and `type: 'P'` both select all
      // 76 - which a resolver that ignored the key entirely would also do.
      // These are the halves that tell the two apart.
      chainMiss: {object: other, chain: 'Z'},
      typeMiss: {object: other, type: 'N'},
      whole: {object: other},
      typo: {object: other, chian: 'A'},
    };
    for (const [k, sel] of Object.entries(tries)) {
      try {
        const got = [...r.objectPositions(other, sel)];
        R.narrows[k] = {n: got.length, head: got.slice(0, 4)};
      } catch (e) { R.narrows[k] = {threw: String(e.message || e)}; }
    }
    R.wholeCount = ((r.objectsData[other].frames[0] || {}).coords || []).length;
    return R;
   } catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__ready = true;
});
</script>
"""
open(PROBE, 'w').write(open(os.path.join(ROOT, 'dev.html')).read()
                       .replace('</body>', JS.replace('//HELPERS', HELPERS) + '</body>'))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome, ws = launch(DBG, "/tmp/py2dmol-namedobj")
try:
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_namedobj.html")
    wait_for(ws, "window.__ready === true", timeout=90, what="the page")
    R = json.loads(evaluate(ws, "window.__go().then(JSON.stringify)"))
finally:
    chrome.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree("/tmp/py2dmol-namedobj", ignore_errors=True)

if R.get('error'):
    sys.exit("page error: " + R['error'])

bad = []
print(f"  loaded {R['names']}, drawn {R['drawn']!r}, naming {R['other']!r}")
print(f"  named request  -> named {R['named']['onNamed']},"
      f" drawn {R['named']['onDrawn']}")
print(f"  after hide     -> named {R['afterHide']}")
print(f"  unnamed        -> drawn {R['unnamed']['onDrawn']},"
      f" named {R['unnamed']['onNamed']}")
print(f"  no atoms       -> {R['bare'][:70]!r}")
print(f"  near, not drawn-> {R['near'][:70]!r}")

if R['named']['onNamed'] != [10, 11, 12]:
    bad.append(f"a request naming {R['other']!r} left it {R['named']['onNamed']}"
               ' - it never reached the object it named')
if R['named']['onDrawn'] is not None:
    bad.append(f"a request naming {R['other']!r} also wrote"
               f" {R['named']['onDrawn']} onto the DRAWN object")
if R['afterHide'] != [10, 12]:
    bad.append(f"hiding one of them left {R['afterHide']} - the relative verb"
               ' does not reach the named object')
if R['unnamed']['onDrawn'] != [4, 5]:
    bad.append(f"an UNNAMED request left the drawn object"
               f" {R['unnamed']['onDrawn']} - it must still mean what is drawn")
if R['unnamed']['onNamed'] != [10, 12]:
    bad.append(f"an unnamed request changed the other object to"
               f" {R['unnamed']['onNamed']}")
if 'no side-chain atoms' not in str(R['bare']):
    bad.append(f"naming an object with no side-chain atoms gave {R['bare']!r}"
               ' - the guard must ask the object the request names')
if 'not drawn' not in str(R['near']):
    bad.append(f"a spatial selector on an object that is not drawn gave"
               f" {R['near']!r} - there is no honest answer, so it must say so")

nr = R.get('narrows') or {}
print('  narrows: ' + ', '.join(
    f"{k}={v.get('threw', '')[:28] if 'threw' in v else v['n']}"
    for k, v in nr.items()))
# EVERY NARROW MUST LAND SOMETHING, and each is a different array to look up.
for key, want in (('chain', None), ('residues', 2), ('type', None),
                  ('range', 3), ('chainMiss', 0), ('typeMiss', 0)):
    got = nr.get(key) or {}
    if 'threw' in got:
        bad.append(f"narrowing a non-drawn object by {key!r} threw"
                   f" {got['threw'][:80]!r} - it carries the field, under the"
                   ' name a stored frame uses')
    elif want is None and not got.get('n'):
        bad.append(f"narrowing by {key!r} selected nothing")
    elif want is not None and got.get('n') != want:
        bad.append(f"narrowing by {key!r} selected {got.get('n')}, wanted {want}")
# ...AND THE WHOLE OBJECT WHEN NOTHING NARROWS IT, which is the control: a
# resolver that answered "everything" to every key above would pass them all.
whole = nr.get('whole') or {}
if whole.get('n') != R.get('wholeCount'):
    bad.append(f"an object-only selector gave {whole.get('n')} of"
               f" {R.get('wholeCount')} positions")
for key in ('residues', 'range', 'chainMiss', 'typeMiss'):
    got = nr.get(key) or {}
    if got.get('n') == R.get('wholeCount'):
        bad.append(f"narrowing by {key!r} returned the WHOLE object"
                   f" ({got['n']}) - it narrowed nothing")
if 'threw' not in (nr.get('typo') or {}):
    bad.append("a typo'd selector key was accepted - it matches no key,"
               ' narrows nothing, and would quietly mean the whole object')

print()
for b in bad:
    print("FAIL: " + b)
print("named_object: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
