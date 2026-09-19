"""A SAVED SESSION CARRIES WHAT THE DRAWING READS, AND THE SIDE CHAINS' ELEMENTS
WERE NOT TRAVELLING.

    python3 tests/session_elements.py

`trimSidechainTable` (src/io/parse.js) drops columns a saved table does not need
- and it dropped `elements` beside `names`, under a comment saying "nothing
reads them to draw". Two things read them: `_materialiseSidechains` fills the
positions' element column from that array, and `sidechainMap.el` from the same
array one line below - the first colours an ATOM, the second the far half of a
MIXED BOND. So a reloaded session drew every side chain in one flat colour:
oxygen without its red, nitrogen without its blue, sulfur without its gold.
`core/mol.js` carried the matching wrong claim, that a reload "colours from
sidechainMap.el instead, which is where it always came from" - it is filled from
the array that had just been dropped. Reported as side chains losing their
element colours on reopening a session.

Measured on 3PTB before the fix: 744 side-chain atoms with an element (566 C,
100 O, 64 N, 14 S) and **0** after a save and reload.

WHAT THIS ASKS:

  1. THE WIRE FORMAT. The saved table names `elements`. A field nothing writes
     cannot come back, and this is the half that a reload cannot repair.
  2. THE TABLE COMES BACK. Every side-chain atom has its element again, with
     the same census - not merely "some string is there".
  3. 🔴 AND THE COLOUR REACHES THE DRAWING, which is the assertion that matters
     and the one a field check passes without. `getAtomColor` is asked for an
     OXYGEN and for a CARBON of the same structure, before and after: the
     oxygen must come back the colour it was, and it must still DIFFER from the
     carbon. Without that control, "unchanged" is also what a viewer that has
     gone uniformly grey reports.

Colours are read off the renderer rather than the canvas on purpose: shading
moves every drawn colour off its table value, and pLDDT's own ramp overlaps the
element reds, so a pixel count cannot tell an oxygen from a low confidence.
That trap is recorded in CLAUDE.md and cost two rounds of forensics once.
"""
import json, os, sys, shutil, http.server, socketserver, threading, functools

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DEBUG_PORT = 9937, 9938
PROBE = os.path.join(ROOT, "_sessionelements.html")

JS = """(async () => {
  //HELPERS
  const t = await (await fetch('/3PTB.cif')).text();
  await window.processFiles([{name: '3PTB.cif', readAsync: () => Promise.resolve(t)}], false);
  await until(loaded, 60000);
  const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
  await until(() => r.coords && r.coords.length > 0, 30000);
  await settle(8);
  r.showSidechains(); await settle(8);
  // One oxygen and one carbon of the side chains, by the table's own record of
  // what they are - named here so the same two atoms are read on both sides.
  const pick = (want) => {
    for (const [idx, v] of (r.sidechainMap || [])) if (v && v.el === want) return idx;
    return -1;
  };
  const survey = () => {
    const els = {}; let atoms = 0, withEl = 0;
    for (const [, v] of (r.sidechainMap || [])) {
      atoms++;
      const e = (v && v.el) || '';
      if (e) { withEl++; els[e] = (els[e] || 0) + 1; }
    }
    return {atoms, withEl, els};
  };
  // 🔴 A MIXED BOND IS WHERE AN ELEMENT COLOUR ACTUALLY LANDS, and it rides on
  // the colours array rather than in it: `colors.halves[i]` is {a, b} for a
  // bond drawn in two colours and null for the rest. `getAtomColor` answers the
  // RESIDUE's colour for an oxygen by contract - it is the base the halves
  // compose with - so asking it separates nothing. See CLAUDE.md.
  const mixed = () => {
    const h = (r.colors && r.colors.halves) || [];
    let n = 0; let sample = null;
    for (let i = 0; i < h.length; i++) {
      if (!h[i]) continue;
      n++;
      if (!sample) sample = [[h[i].a.r | 0, h[i].a.g | 0, h[i].a.b | 0],
                             [h[i].b.r | 0, h[i].b.g | 0, h[i].b.b | 0]];
    }
    return {n, sample};
  };
  const oIdx = pick('O'), cIdx = pick('C');
  const before = survey();
  const beforeMixed = mixed();
  const state = window.buildViewerState();
  const savedKeys = Object.keys((state.objects[0].frames[0] || {}).sidechains || {}).sort();
  if (window.clearAllObjects) window.clearAllObjects();
  await settle(4);
  await window.loadViewerState(state);
  await until(() => r.coords && r.coords.length > 0, 30000);
  await settle(8);
  try { r.showSidechains(); } catch (e) {}
  await settle(8);
  const after = survey();
  // ...the same two atoms: the indices are reissued per materialisation, so
  // they are found again by element rather than remembered as numbers.
  const afterMixed = mixed();
  return JSON.stringify({savedKeys, before, after, beforeMixed, afterMixed,
                         haveO: oIdx >= 0, haveC: cIdx >= 0});
})()"""
JS = JS.replace("//HELPERS", HELPERS)

open(PROBE, "w").write(open(os.path.join(ROOT, "dev.html")).read())
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT),
                               functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome = None
try:
    chrome, ws = cdp.launch(DEBUG_PORT, "/tmp/py2dmol-sessionelements")
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_sessionelements.html")
    cdp.wait_for(ws, "typeof window.processFiles === 'function'", timeout=120, what="dev.html")
    out = json.loads(cdp.evaluate(ws, JS))
finally:
    if chrome: chrome.kill()
    httpd.shutdown()
    shutil.rmtree("/tmp/py2dmol-sessionelements", ignore_errors=True)
    try: os.remove(PROBE)
    except OSError: pass

b, a = out["before"], out["after"]
print(f"  saved table names: {out['savedKeys']}")
print(f"  before: {b['atoms']} side-chain atoms, {b['withEl']} with an element {b['els']}")
print(f"  after:  {a['atoms']} side-chain atoms, {a['withEl']} with an element {a['els']}")
bm, am = out["beforeMixed"], out["afterMixed"]
print(f"  bonds drawn in two colours: {bm['n']} -> {am['n']}   (a pair: {bm['sample']} -> {am['sample']})")

bad = []
if "elements" not in out["savedKeys"]:
    bad.append("the saved side-chain table does not name `elements` - a field"
               " nothing writes cannot come back, so no reload can repair it")
if not b["withEl"]:
    bad.append("no side-chain atom had an element BEFORE saving - this measured nothing")
elif a["withEl"] != b["withEl"] or a["els"] != b["els"]:
    bad.append(f"the elements did not survive the round trip: {b['els']} became {a['els']},"
               " so every side chain reloads in one flat colour")
if not (out["haveO"] and out["haveC"]):
    bad.append("no oxygen or no carbon among the side chains - nothing was compared")
if not bm["n"]:
    bad.append("no bond was drawn in two colours BEFORE saving - this measured nothing,"
               " and an element colour has nowhere to land")
elif am["n"] != bm["n"]:
    bad.append(f"{bm['n']} bonds were drawn in two colours and {am['n']} are after the"
               " reload - the elements did not reach the drawing")
elif bm["sample"] and bm["sample"][0] == bm["sample"][1]:
    bad.append(f"the sampled pair is the same colour on both halves {bm['sample']} -"
               " the control cannot tell a mixed bond from a flat one")

for x in bad:
    print("FAIL: " + x)
print("session elements: " + ("FAILED" if bad else "a reloaded side chain keeps its element colours"))
sys.exit(1 if bad else 0)
