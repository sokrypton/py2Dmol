"""COMING BACK TO A PICTURE ALREADY BUILT MUST NOT REBUILD IT.

    python3 tests/rebuild_returns.py

The renderer keeps one spare mesh against its signature, so hiding an object
and showing it again should hand the old mesh straight back - the picture is
identical, and it was built two steps ago. That only works while every term of
the signature answers WHAT IS IN a thing rather than WHICH OBJECT it is: the
app rebuilds its per-object sets whenever the drawn set changes, so an
identical picture arrives as a Set with a new identity.

That was found once and fixed for the visibility mask (visKeyOf) and once for
the colour array (colourKeyOf). This file exists because it can happen again to
any set the signature carries, and because there is no way to notice from the
outside: everything looks right, it is just slow.

🔴 THE CONTROL ARM IS THE POINT. A bare toggle is measured first, so the row
that matters - the same toggle with a per-object set in play - is compared with
something rather than with a threshold. If the bare one rebuilds too, the spare
mesh is simply not working and neither number means what this file says.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_rebuildreturns.html")
PORT = 9813
DEBUG_PORT = 9814
A_FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"
B_FILE = sys.argv[2] if len(sys.argv) > 2 else "3CHY.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (fa, fb) => {
    const put = async (f) => {
      const t = await (await fetch('/' + f)).text();
      await window.processFiles([{name: f, readAsync: () => Promise.resolve(t)}], true);
      await until(loaded, 120000);
    };
    await put(fa); await put(fb);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 120000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const [A, B] = Object.keys(r.objectsData);
    r.setShownObjects([A, B]); await settle(8);

    // hide B, then show it again: the second step is a picture already built
    const round = async () => {
      r.setShownObjects([A]); await settle(6);
      window.__faceBuilds = 0;
      // 🔴 AND THE TWO THINGS BEHIND THE MESH, which a mesh restore should also
      // spare. The secondary structure assignment is the expensive one - 7.4 ms
      // at 1,103 positions against 0.7-2.3 ms for the segment list beside it -
      // and it is computed inside the capture, so a frame that does not rebuild
      // does not pay it. Counted so that stays true.
      window.__ssBuilds = 0;
      r.setShownObjects([A, B]); await settle(6);
      return {mesh: window.__faceBuilds, ss: window.__ssBuilds || 0};
    };

    const bare = await round();

    // ...now with a per-object set in play. Backbone hiding is the one that
    // works on any structure; bases need a nucleic chain and elements need
    // side chains, and all three are carried the same way.
    const o = r.objectsData[A];
    o.hiddenBackbone = new Set([3, 4, 5, 6]);
    r.reloadDrawn(); await settle(8);
    const withSet = await round();

    // 🔴 AND A DIFFERENT SET MUST STILL REBUILD. A content digest that ignored
    // its input would pass every row above and quietly stop the backbone from
    // ever being hidden again. So: change the members, and require a build.
    window.__faceBuilds = 0;
    o.hiddenBackbone = new Set([20, 21, 22, 23, 24]);
    r.reloadDrawn(); await settle(8);
    const changedSet = window.__faceBuilds;

    // ...and back to the FIRST set, which is a picture built three steps ago
    // and is what the spare slot no longer holds - so this one may rebuild.
    // Recorded, not asserted: the spare is a single slot by design.
    o.hiddenBackbone = new Set([3, 4, 5, 6]);
    r.reloadDrawn(); await settle(8);

    // 🔴 ONE SET AT A TIME. Leaving the hidden backbone in place while adding
    // element colours measures the hidden backbone twice and reports it as two
    // findings - the first version of this file did exactly that, and said "0
    // owners" in the same breath as blaming them.
    o.hiddenBackbone = null;
    r.reloadDrawn(); await settle(8);

    // ...and element colouring, which needs side chains to have anything to
    // colour and needs those side chains to own a coloured element.
    o.sidechains = new Set([10, 11, 12, 13, 14, 15]);
    r.reloadDrawn(); await settle(8);
    const shown = r.shownSidechainSet ? r.shownSidechainSet() : null;
    const want = shown ? Array.from(shown) : [10, 11, 12, 13, 14, 15];
    if (r.setElementsFor) r.setElementsFor(want, true);
    r.reloadDrawn(); await settle(8);
    const nElem = (r.mergedObjectSet && r.mergedObjectSet('elements'))
      ? r.mergedObjectSet('elements').size : 0;
    const withElements = await round();

    // 🔴 NO SINGLE-OBJECT ARM HERE, AND THAT IS DELIBERATE. It was tried, and
    // it could not fail: this file loads TWO objects to have one to hide, so
    // Object.keys(objectsData).length is 2 whatever is SHOWN, and the flag it
    // was meant to test was on either way. Restoring the bug left it green.
    // The single-object case is asserted in tests/rebuild_actions.py, which
    // loads one structure and nothing else.
    return {A, B, bare, withSet, withElements, changedSet,
            hidden: 4, elements: nElem};
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
profile_dir = "/tmp/py2dmol-rebuildreturns"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_rebuildreturns.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(A_FILE)}, {json.dumps(B_FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

print(f"showing {out['B']} again, after hiding it - mesh rebuilds:")
def show(v):
    return f"{v['mesh']} mesh, {v['ss']} ss" if isinstance(v, dict) else str(v)


print(f"  bare                       {show(out['bare'])}")
print(f"  with a hidden backbone     {show(out['withSet'])}   ({out['hidden']} positions)")
print(f"  ...and element colours     {show(out['withElements'])}   ({out['elements']} owners)")

print(f"  hiding DIFFERENT residues   {out['changedSet']}"
      "   (must be at least 1)")

bad = []
if not out["changedSet"]:
    bad.append("hiding a different set of residues rebuilt nothing - the"
               " digest is not reading its input, and every 0 above is a 0"
               " because the term never changes at all")
if out["bare"]["mesh"] != 0 or out["bare"]["ss"] != 0:
    bad.append(f"coming back to the bare picture cost {show(out['bare'])}"
               " - the spare mesh is not being restored at all, so the two rows"
               " below measure nothing")
else:
    arms = [("a hidden backbone", out["withSet"], out["hidden"])]
    if out["elements"]:
        arms.append(("element colours", out["withElements"], out["elements"]))
    else:
        print("  (element colours are inert here - no side chain on this"
              " structure owns a coloured element, so that row proves nothing)")
    for tag, v, _sz in arms:
        if v["mesh"]:
            bad.append(f"with {tag} in play, coming back to a picture already"
                       f" built rebuilt {v['mesh']} time(s) where the bare one"
                       " rebuilt 0 - a per-object set is in the signature by"
                       " IDENTITY, and the app makes a new Set for the same"
                       " members whenever the drawn set changes")
        if v["ss"]:
            bad.append(f"with {tag} in play, coming back cost {v['ss']}"
                       " secondary-structure assignment(s) - the mesh was"
                       " restored, so the capture that computes it did not run,"
                       " so something else is dropping _cartoonSec")

print()
for b in bad:
    print("FAIL: " + b)
print("rebuild returns: " + ("FAILED" if bad else "a picture already built is handed back"))
sys.exit(1 if bad else 0)
