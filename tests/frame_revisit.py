"""A FRAME DRAWN AGAIN IS THE SAME FRAME - including the outline.

    python3 tests/frame_revisit.py [_traj_3ptb.pdb]

Playing forward and scrubbing BACK is not the same path as playing forward. A
frame that has been drawn before can come back from the spare mesh slot -
`restoreMesh`, one mesh kept and exchanged - and a restore puts back buffers
rather than rebuilding them. So it is exactly where half a mesh can arrive.

🔴 WHAT IT MISSED WAS THE OUTLINE'S PROVENANCE. `activateMesh` restored the edge
BUFFER and the count, and `residentEdges` - the `{ed, edSrc}` pair that
refreshEdgesFromStations rebuilds every edge row from - stayed pointing at the
mesh that happened to be resident before. The restored frame then had its
outline rewritten from another frame's provenance: measured on _traj_3ptb.pdb
by playing to frame 5 and scrubbing back, **7,684 grey pixels where the same
frame drawn forward has 9,442** - about a fifth of the outline simply missing,
which is how it was reported ("the outline is lost when I scroll back").

The part spans travel with it now for the same reason: they are where each
group's rows landed, and refreshSticksFrom writes a rebuilt tail back over them.

🔴 THE COMPARISON IS FORWARD AGAINST BACKWARD, NOT AGAINST A REBUILD. A rebuild
is a third answer; what a reader notices is that the picture changed when they
scrubbed back to where they were. So each frame is captured on the way out and
again on the way back, and the two must be identical.

🔴 AND THE FRAMES HAVE TO DIFFER FROM EACH OTHER, or a probe comparing a still
structure with itself passes with the restore broken in any way at all.
"""
import base64, io, json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_revisit.html")
PORT = 9877
DEBUG_PORT = 9878
FILE = sys.argv[1] if len(sys.argv) > 1 else "_traj_3ptb.pdb"
N = 6

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, n) => {
   try {
    const G = window.py2dmolCartoonGPU;
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    // 🔴 THE STATION PATH IS NOT FORCED. renderApp switches it on by itself
    // for an object with more than one frame, and forcing it here would test a
    // path with a different history: the automatic switch happens DURING a
    // render, after that frame's keys were computed, and that timing is the
    // difference between one build at the start of a playback and two.
    r.setFrame(0); r.render('warm'); await settle(6);
    const shot = () => r.canvas.toDataURL('image/png');
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    const take = async (i) => {
      const b0 = window.__faceBuilds || 0;
      r.setFrame(i); await settle(4);
      return {frame: i, png: shot(), built: (window.__faceBuilds || 0) - b0,
              edges: G.getEdgeCount ? G.getEdgeCount() : -1};
    };
    const buildsAtStart = window.__faceBuilds || 0;
    const fwd = [];
    for (let i = 0; i < Math.min(frames, n); i += 1) fwd.push(await take(i));
    // ...the floor: the last frame again, with nothing changed
    const floor = await take(Math.min(frames, n) - 1);
    const back = [];
    for (let i = Math.min(frames, n) - 1; i >= 0; i -= 1) back.push(await take(i));
    return {fwd, back, floor, frames,
            builds: (window.__faceBuilds || 0) - buildsAtStart};
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
profile_dir = "/tmp/py2dmol-revisit"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_revisit.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {N}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])

try:
    import numpy as np
    from PIL import Image
except Exception:
    sys.exit("this file compares pictures and needs numpy and pillow")


def png(d):
    return np.asarray(Image.open(io.BytesIO(
        base64.b64decode(d.split(",", 1)[1]))).convert("RGB")).astype(int)


def diff(a, b):
    x, y = png(a), png(b)
    if x.shape != y.shape:
        return None, None
    d = np.abs(x - y).max(axis=2)
    return 100.0 * (d > 0).sum() / d.size, int(d.max())


def ink(d):
    x = png(d)
    sat = x.max(axis=2) - x.min(axis=2)
    val = x.max(axis=2)
    return int(((sat < 30) & (val > 80) & (val < 235)).sum())


bad = []
fwd = {row["frame"]: row for row in res["fwd"]}
fpct, fworst = diff(res["fwd"][-1]["png"], res["floor"]["png"])
print(f"{FILE}: {len(fwd)} frames out and back,"
      f" same-frame floor {('n/a' if fpct is None else f'{fpct:.4f}%')}")
if fpct:
    bad.append(f"the same frame drawn twice in a row already differs by"
               f" {fpct:.4f}% - nothing below is about scrubbing back")

moved = 0
for row in res["back"]:
    f = fwd.get(row["frame"])
    if not f:
        continue
    pct, worst = diff(f["png"], row["png"])
    print(f"  frame {row['frame']}  forward ink {ink(f['png']):>6}"
          f"  back ink {ink(row['png']):>6}"
          f"  edges {f['edges']} / {row['edges']}"
          f"  differ {('n/a' if pct is None else f'{pct:.4f}% worst {worst}')}"
          f"  builds {row['built']}")
    if pct is None:
        bad.append(f"frame {row['frame']}: the two frames are different sizes")
        continue
    if pct > 0.02:
        bad.append(f"frame {row['frame']}: drawn again it differs from the same"
                   f" frame drawn forward by {pct:.4f}% of the picture at a"
                   f" worst channel of {worst}. A frame that comes back from the"
                   " spare mesh slot has to come back whole - buffers, the"
                   " outline's provenance and the part spans together")
    if f["edges"] != row["edges"]:
        bad.append(f"frame {row['frame']}: {f['edges']} outline rows forward"
                   f" and {row['edges']} back")

# 🔴 THE FRAMES MUST DIFFER FROM ONE ANOTHER, or this compared a still
# structure with itself and would pass with the restore broken any way at all.
for i in range(1, len(res["fwd"])):
    pct, _ = diff(res["fwd"][i - 1]["png"], res["fwd"][i]["png"])
    if pct and pct > 0.5:
        moved += 1
if moved < 2:
    bad.append("the frames barely differ from each other, so drawing one again"
               " and getting the same picture says nothing")

# 🔴 AND THE WHOLE WALK COSTS ONE BUILD AT MOST. Out and back over six frames
# is twelve frame changes; the station path absorbs all of them, and the one
# build that is allowed is the first - the frame the table is installed on.
# Two was the shipped behaviour until the automatic switch learned to compute
# the topological key it had just made askable: the frame that turns the path on
# recorded a NULL key and the next frame rebuilt to record a real one.
print(f"  builds over the whole walk: {res.get('builds')}")
if (res.get("builds") or 0) > 0:
    bad.append(f"the walk cost {res['builds']} build(s) after the warm frame,"
               " and it must cost none: the station path absorbs a frame change"
               " and the table was installed before the walk began. One here is"
               " the fault that showed as 'still rebuilding when first played' -"
               " the frame that switches the path on recorded a null topological"
               " key, so the next frame rebuilt to record a real one")

print()
for b in bad:
    print("FAIL: " + b)
print("frame revisit: " + ("FAILED" if bad
                           else "a frame scrubbed back to is the frame it was"))
sys.exit(1 if bad else 0)
