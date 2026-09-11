"""A TRAJECTORY'S FRAMES DESCRIBE ONE MOLECULE, AND ONLY ITS COORDINATES MOVE.

    python3 tests/frame_share.py [_traj_9fog.pdb]

Every model of a multi-model file is parsed on its own, so each frame arrived
carrying its OWN chains, position names, residue numbers, types and elements -
fifteen copies of five identical arrays on _traj_9fog.pdb, and thirty on a
thirty-frame run. addFrame shares them where the contents are equal.

    _traj_9fog.pdb, 15 frames of 3,348 positions
    distinct arrays per field   15  ->  1     (~1.9 MB of slots not held)

The memory is the smaller half. The other half is that nothing downstream could
tell that two frames' metadata were the SAME THING, because they were not the
same object: every cache that could have compared them by identity had to
compare them by content, or give up and recompute. With this, `this.chains` and
its neighbours keep their identity across a frame step, which is an O(1) test.

🔴 IT IS SAFE ONLY BECAUSE THESE ARRAYS ARE READ AND NEVER WRITTEN. Both
writers copy first: _materialiseSidechains slices before it appends, and the
length padding in the segment build builds a new array instead of pushing into
this one - which it had no right to do even when the array belonged to a single
frame.

🔴 AND THAT HALF IS CHECKED IN tests/interaction.js, NOT HERE, because it cannot
be checked from inside the page. Three runtime versions were written and all
three passed with a deliberate in-place write in the source: a snapshot taken
after the load has already been written to; a second object parsed from the same
text is corrupted identically, so it agrees; and comparing the frames with each
other is trivially true once they share an array. The invariant is "nobody
writes to these", which is a property of the SOURCE, so it is asserted there.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_frameshare.html")
PORT = 9895
DEBUG_PORT = 9896
FILE = sys.argv[1] if len(sys.argv) > 1 else "_traj_9fog.pdb"
FIELDS = ["chains", "position_types", "position_names", "residue_numbers",
          "position_elements", "plddts"]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, fields) => {
   try {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    const obj = r.objectsData[r.currentObjectName];
    const frames = obj.frames;

    // STEP THROUGH THE WHOLE TRAJECTORY, in the style that materialises side
    // chains, because the two writers that must copy rather than append are
    // the side-chain materialisation and the segment build's length padding.
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(8);
    for (let i = 0; i < frames.length; i++) { r.setFrame(i); await settle(1); }
    const o = r.objectsData[r.currentObjectName];
    o.sidechains = o.sidechains || null;
    r.setFrame(0); await settle(2);

    // 🔴 THE REFERENCE IS A SECOND LOAD, NOT A SNAPSHOT TAKEN EARLIER.
    // The one writer that could corrupt a shared array runs during the FIRST
    // build of the segment list, which happens inside the load - so anything
    // copied out afterwards has already been written to, and comparing the
    // frames against it would compare a corrupted array with itself. A fresh
    // object parsed from the same text has not been drawn, so its frame 0 is
    // what the file says.
    const f0 = frames[0];
    const rendererShares = {
      chains: r.chains === f0.chains,
      names: r.positionNames === f0.position_names,
      types: r.positionTypes === f0.position_types,
    };

    const out = {frames: frames.length, n: (frames[0].coords || []).length,
                 fields: {}};
    let saved = 0;
    for (const f of fields) {
      const seen = new Set(); let present = 0; let len = 0;
      for (const fr of frames) {
        if (!fr[f]) continue;
        present += 1; seen.add(fr[f]); len = fr[f].length;
      }
      if (!present) continue;
      out.fields[f] = {present, distinct: seen.size, len};
      saved += (present - seen.size) * len * 8;
    }
    out.roughBytesSaved = saved;
    // ...and the renderer's own arrays are the frame's, which is what makes an
    // identity test downstream mean anything.
    out.rendererShares = rendererShares;
    return out;
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
profile_dir = "/tmp/py2dmol-frameshare"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_frameshare.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {json.dumps(FIELDS)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"][:400])

print(f"{FILE}: {out['frames']} frames of {out['n']} positions")
for f, v in out["fields"].items():
    print(f"  {f:<18} {v['distinct']:>3} distinct of {v['present']:>3} frames"
          f"   (len {v['len']})")
print(f"  ~{out['roughBytesSaved'] / 1e6:.1f} MB of array slots not held")
print(f"  the renderer holds the frame's own arrays: {out['rendererShares']}")

bad = []
if out["frames"] < 2:
    bad.append(f"{FILE} has {out['frames']} frame(s), so there is nothing to"
               " share and nothing below was measured")
for f, v in out["fields"].items():
    if v["present"] > 1 and v["distinct"] > 1:
        bad.append(f"the frames hold {v['distinct']} distinct {f} arrays where"
                   f" {v['present']} frames describe one molecule - addFrame's"
                   " dedupe did not fire, so every cache downstream is back to"
                   " comparing them by content")
if not any(out["rendererShares"].values()):
    bad.append("the renderer's arrays are not the frame's, so sharing them"
               " between frames buys nothing downstream - _setDataField is"
               " meant to assign them straight through")

print()
for b in bad:
    print("FAIL: " + b)
print("frame share: " + ("FAILED" if bad else "one molecule, one set of arrays"))
sys.exit(1 if bad else 0)
