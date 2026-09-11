"""THE SEGMENT COLOURS DO NOT READ A COORDINATE, SO A FRAME STEP NEED NOT
RECOMPUTE THEM.

    python3 tests/colour_cache.py [_traj_9fog.pdb]

Every colour mode resolves from chains, names, types, elements, pLDDTs, entropy
or the palette - none of them from a position - so stepping a trajectory built
an array identical to the one it replaced. Measured on _traj_9fog.pdb, 3,348
positions: 11 of 12 steps produced byte-identical colours, at 1.1 ms a step.

    a tube step, alternated, three runs each
    1.79, 1.80, 1.79 ms   against   2.15, 1.87, 2.02

setCoords keeps them when `_segmentColourKey` says every input they DO read is
the one they were computed from, and the key answers null - "compute them" -
whenever it cannot be sure.

🔴 THE POLARITY IS WHAT MAKES THIS SAFE. setCoords reads `colorsNeedUpdate`
BEFORE it sets it, so a flag raised by the colourblind toggle, an element edit,
a mode switch or a reset is honoured exactly as before, and a new site that
raises it is hard by default. The key only ever suppresses the invalidation
setCoords itself just made.

🔴 AND THE `ss` MODE MUST BAIL, because it is the one colour that IS derived
from the coordinates - cartoon/geom.js registers it as a custom mode and it
reads the secondary-structure assignment. The first version of the key tested
"are there any custom modes?", which geom.js makes true on every page for every
structure, so the key never matched once and the whole thing did nothing.

This file checks the answer, not the saving: on every step it compares the
colours the renderer kept against a fresh computation, over a plain step, a
colourblind toggle, a mode switch to `ss` and back, and an object-level colour.

🔴 AND WHAT IT CANNOT FALSIFY: the key also mixes in `colorblindMode`, and
removing that term leaves this file passing. That is not a hole - the checkbox
handler raises `colorsNeedUpdate`, which the polarity above honours whatever the
key says, so the term is belt and braces for a caller that sets the field
directly. It is kept because it costs one integer, not because anything here
proves it is needed.

🔴 THE `ss` ARM IS WHAT FOUND A REAL FAULT, and it is now compared like the
rest. It reported the kept colours disagreeing with a fresh computation on 6 of
6 steps - true with this cache stashed too, so not the cache's doing. The cause
was secForColor passing assignSecondary different options from the draw stage,
so the colours and the ribbon were reading two different assignments; see
tests/ss_agree.py. The arm is still ALSO required to keep nothing, because `ss`
is the one colour a coordinate moves.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_colourcache.html")
PORT = 9897
DEBUG_PORT = 9898
FILE = sys.argv[1] if len(sys.argv) > 1 else "_traj_9fog.pdb"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
   try {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);

    const fresh = r._calculateSegmentColors.bind(r);
    const cmp = (a, b) => {
      if (!a || !b) return 'one side is missing';
      if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length;
      for (let i = 0; i < a.length; i++) {
        const x = a[i] || {}, y = b[i] || {};
        if (x.r !== y.r || x.g !== y.g || x.b !== y.b) {
          return 'segment ' + i + ' is ' + JSON.stringify(x)
            + ' where a fresh computation says ' + JSON.stringify(y);
        }
      }
      return null;
    };
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    const out = [];
    const arm = async (name, steps, before) => {
      if (before) { await before(); await settle(6); }
      window.__colourKept = 0; window.__colourBuilds = 0;
      let wrong = 0; let first = null;
      for (let i = 1; i <= steps; i++) {
        r.setFrame(i % frames);
        await settle(1);
        const d = cmp(r.colors, fresh(null));
        if (d && !first) { first = d; }
        if (d) wrong += 1;
      }
      out.push({name, steps, wrong, first,
                kept: window.__colourKept || 0, built: window.__colourBuilds || 0,
                mode: r.colorMode, style: r.style});
    };

    await arm('tube, chain colours', 8, async () => {
      if (r.setStyle) r.setStyle('tube'); else r.style = 'tube';
    });
    await arm('cartoon, chain colours', 6, async () => {
      if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    });
    // 🔴 THE ONE MODE THAT IS DERIVED FROM THE COORDINATES. Nothing may be
    // kept here, and it is compared like the rest - see the header for what
    // that arm found.
    await arm('cartoon, ss colours', 6, async () => { r.colorMode = 'ss'; });
    await arm('back to rainbow', 6, async () => { r.colorMode = 'rainbow'; });
    // ...the way the checkbox does it, which is the only way the page does:
    // the handler raises colorsNeedUpdate, and the polarity above honours it.
    await arm('colourblind', 6, async () => {
      r.colorblindMode = true; r.colorsNeedUpdate = true;
    });
    await arm('an object colour', 6, async () => {
      r.colorblindMode = false;
      r.objectsData[r.currentObjectName].color = {type: 'literal', value: '#ff0000'};
    });
    await arm('and off again', 6, async () => {
      delete r.objectsData[r.currentObjectName].color;
    });
    // 🔴 AND THE PALETTE SURVIVES KEEP SSE, which is the arm a real bug walked
    // through. setCoords used to clear chainIndexMap and ligandOnlyChains
    // ABOVE the test that refills them, so a frame that kept its chain tables
    // - which is exactly what Keep SSE makes - left the map empty, every
    // lookup missed, and getAtomColor fell through to colorArray[0]. Ten
    // chains of a nucleosome all came out the same green, on the fast path and
    // on a rebuild alike. Counting DISTINCT colours is what catches it: the
    // arrays still compare equal to a fresh computation, because the fresh one
    // is wrong in the same way.
    const distinct = () => {
      const seen = new Set();
      for (const c of (r.colors || [])) if (c) seen.add((c.r|0)+','+(c.g|0)+','+(c.b|0));
      return seen.size;
    };
    r.stableTopology = false;
    if (r.setColorMode) r.setColorMode('chain'); else r.colorMode = 'chain';
    r.colorsNeedUpdate = true; r.setFrame(0); r.render('sse-arm'); await settle(4);
    const keepBefore = distinct();
    r.stableTopology = true;
    if (r._invalidateSegmentCache) r._invalidateSegmentCache();
    for (let i = 1; i < Math.min(frames, 8); i++) { r.setFrame(i); r.render('sse-step'); await settle(2); }
    const keepAfter = distinct();
    r.stableTopology = false;
    return {file, frames, n: r.coords.length, out,
            keepSse: {before: keepBefore, after: keepAfter,
                      chains: new Set(r.chains || []).size,
                      mapSize: r.chainIndexMap ? r.chainIndexMap.size : -1}};
   } catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
open(PROBE, "w").write(
    open(os.path.join(ROOT, "dev.html")).read()
    .replace("</body>", "<script>" + SETUP + "</script></body>"))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-colourcache"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_colourcache.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:400])

print(f"{res['file']}: {res['frames']} frames of {res['n']} positions")
bad = []
K = res.get("keepSse") or {}
print(f"  Keep SSE, colour by chain: {K.get('chains')} chains ->"
      f" {K.get('before')} distinct colours before a playback,"
      f" {K.get('after')} after   (chainIndexMap holds {K.get('mapSize')})")
# 🔴 THE MAP IS THE PRIMARY SIGNAL, NOT THE COLOUR COUNT. By the time this arm
# runs the earlier arms have already stepped the trajectory, so with the bug
# present the map is empty ALREADY and `before` is 1 - which reads as "this
# structure has one chain" unless the chain count is asked separately. It is.
_collapse = ("setCoords clears the chain tables outside the test that refills"
             " them, so a frame that keeps its tables loses them and every"
             " colour falls through to the palette's first entry")
if not K:
    bad.append("the Keep SSE arm did not run")
elif (K.get('chains') or 0) < 2:
    bad.append(f"the Keep SSE arm is vacuous: the structure has"
               f" {K.get('chains')} chain(s), so a collapse could not be seen."
               " It needs a multi-chain trajectory")
elif (K.get('mapSize') or 0) < 2:
    bad.append(f"chainIndexMap holds {K.get('mapSize')} entries for"
               f" {K.get('chains')} chains. " + _collapse)
elif (K.get('before') or 0) < 2:
    bad.append(f"only {K.get('before')} distinct colour(s) for"
               f" {K.get('chains')} chains before the arm even starts. "
               + _collapse)
elif K.get('after') != K.get('before'):
    bad.append(f"Keep SSE collapsed the chain colours from {K.get('before')} to"
               f" {K.get('after')}. " + _collapse)

kept_total = 0
for row in res["out"]:
    kept_total += row["kept"]
    print(f"  {row['name']:<24} {row['steps']} steps"
          f"   kept {row['kept']:>2}, rebuilt {row['built']:>2}"
          f"   [{row['style']}/{row['mode']}]"
          f"   {row['wrong']} wrong")
    # 🔴 THE ss ARM CARRIES AN EXTRA RULE: nothing may be kept there, whatever
    # the comparison says, because it is the one colour a coordinate moves.
    if row["mode"] == "ss" and row["kept"]:
        bad.append(f"{row['name']}: {row['kept']} colour array(s) were kept"
                   " in a mode whose colours are derived from the"
                   " coordinates. cartoon/geom.js registers `ss` as a custom"
                   " mode and it reads the secondary-structure assignment,"
                   " so a frame step DOES move it - _segmentColourKey must"
                   " answer null for the mode in use")
    if row["wrong"]:
        bad.append(f"{row['name']}: the colours the renderer kept differ from a"
                   f" fresh computation on {row['wrong']} of {row['steps']}"
                   f" steps - {row['first']}."
                   " _segmentColourKey is missing an input that this arm moves")

# 🔴 A GATE THAT CANNOT FAIL IS NOT A GATE. If nothing was ever kept, every
# comparison above is a fresh array against a fresh array and this file has
# checked nothing at all.
if kept_total == 0:
    bad.append("no colour array was kept on any step, so every comparison above"
               " was a fresh computation against a fresh computation and this"
               " file checked nothing. Either the key is bailing out always -"
               " it did, on `any custom mode exists`, which geom.js makes true"
               " on every page - or setCoords is not consulting it")

print()
for b in bad:
    print("FAIL: " + b)
print("colour cache: " + ("FAILED" if bad else "kept only what a fresh computation agrees with"))
sys.exit(1 if bad else 0)
