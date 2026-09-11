"""ONE 2D GEOMETRY PASS PER FRAME, rebuild or not.

    python3 tests/capture_once.py [_traj_1tim.pdb]

`captureFrom` runs the whole 2D cartoon pipeline with the painter switched off:
the secondary-structure assignment, the sheet frames, the slab evaluation, the
run walk. On a trajectory step that is the single most expensive thing the GPU
path does - a step that reuses its mesh costs 6.40 ms against a 14.00 ms
rebuild (tests/against_baseline.py), and the capture is most of the 6.40.

Two callers want it on the same frame: the station table, which needs this
frame's stations, and the rebuild, which needs this frame's prims. `heldCapture`
is what stops that being two passes - the mesh build takes the one the station
path already paid for. Nothing asserted it.

🔴 A SECOND CAPTURE WOULD NOT CHANGE A PIXEL, which is exactly why it would
survive every other gate in this suite. It would simply double the cost of
every frame that rebuilds.

🔴 AND ONE IS THE FLOOR, NOT ZERO. A fast frame still captures: the station
table describes THIS frame's geometry and there is nowhere else to get it.
What this file asserts is that no frame captures twice, and that the frames
which rebuild do not capture more than the frames which do not.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_captureonce.html")
PORT = 9941
DEBUG_PORT = 9942
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILE = ARGS[0] if ARGS else "_traj_1tim.pdb"
STEPS = 12

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, steps) => {
   try {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    // 🔴 THE FALSIFICATION: drop the held capture and the rebuild has to take
    // its own, which is the second pass this file exists to forbid.
    window.__noHeldCapture = DROP_HELD;
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    r.setFrame(0); r.render('warm'); await settle(6);
    const out = [];
    for (let i = 1; i <= steps; i += 1) {
      window.__captures2D = 0;
      window.__faceBuilds = 0;
      r.setFrame(i % frames);
      r.render('step' + i);
      await settle(3);
      out.push({frame: i % frames, captures: window.__captures2D || 0,
                builds: window.__faceBuilds || 0, forced: false});
    }
    // 🔴 AND ONE STEP THAT REBUILDS FOR CERTAIN. The case this file is about is
    // a frame that CAPTURES and BUILDS - the fast path takes a capture to find
    // out whether it can be used, and the rebuild that follows must not take a
    // second one. Stepping a trajectory used to produce that case by itself and
    // does not any more: a drifting assignment costs no rebuild. So it is asked
    // for outright rather than waited for.
    const G2 = window.py2dmolCartoonGPU;
    window.__captures2D = 0;
    window.__faceBuilds = 0;
    if (G2 && G2.invalidate) G2.invalidate();
    r.setFrame(1 % frames);
    r.render('forced');
    await settle(3);
    out.push({frame: 1 % frames, captures: window.__captures2D || 0,
              builds: window.__faceBuilds || 0, forced: true});
    return {out, frames, positions: r.coords.length};
   } catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("DROP_HELD",
    "true" if "--drop-held" in sys.argv else "false").replace("//HELPERS", HELPERS)
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
profile_dir = "/tmp/py2dmol-captureonce"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_captureonce.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {STEPS}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])

rows = res["out"]
built = [r for r in rows if r["builds"]]
reused = [r for r in rows if not r["builds"]]
print(f"  {FILE}: {res['positions']} positions, {len(rows)} steps"
      f" - {len(built)} rebuilt, {len(reused)} reused the mesh")
for r in rows:
    print(f"    frame {r['frame']:>3}  captures {r['captures']}"
          f"  builds {r['builds']}")

bad = []
twice = [r for r in rows if r["captures"] > 1]
if twice:
    bad.append(f"{len(twice)} step(s) ran the 2D geometry pass more than once -"
               f" {twice[0]['captures']} times on frame {twice[0]['frame']}."
               " heldCapture exists so the rebuild takes the capture the"
               " station path already paid for; a second one is the whole"
               " ribbon pipeline again for the same picture")
none = [r for r in rows if r["captures"] < 1]
if none:
    bad.append(f"{len(none)} step(s) captured nothing at all, so this file"
               " counted a path it was not on - it needs the GPU cartoon path"
               " with the station table available")
# 🔴 AND THE COUNTER HAS TO MOVE, or the two assertions above are about a
# number that is always zero and always one.
if not rows or not any(r["captures"] for r in rows):
    bad.append("no step captured anything, so window.__captures2D is not being"
               " written and nothing here was measured")
if not built:
    bad.append("no step rebuilt its mesh, so the case this file is about - a"
               " frame that captures AND builds - never happened. It needs a"
               " trajectory whose topology moves at least once")

print()
for b in bad:
    print("FAIL: " + b)
print("capture once: " + ("FAILED" if bad
                          else "one 2D pass a frame, rebuild or not"))
sys.exit(1 if bad else 0)
