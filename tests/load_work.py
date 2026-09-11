"""WHAT LOADING A STRUCTURE COSTS, IN THINGS DONE RATHER THAN MILLISECONDS.

    python3 tests/load_work.py [1UBQ.cif] [3CHY.cif]

A load builds a mesh, a segment list, a secondary-structure assignment and the
sequence view. Each of those should happen ONCE. Counting them is how the
sequence panel was caught building itself twice: `checkFrameChange` calls
buildSequenceView directly while a deferred build is already queued, and the
queued one then rebuilt the identical view. Every position is visited twice,
and each entry is an object -

    1M4X, 2,081,520 positions   4,163,040 entries -> 2,081,520
    load                        14,343 / 14,465 ms -> 12,995 / 12,730 / 12,566

- so it is allocation as much as time; the profile had 2,530 ms of garbage
  collector in it.

🔴 AND WHERE THE ONE BUILD COMES FROM IS ASSERTED TOO, not only that there is
one of it. `checkFrameChange` is an animation-frame watcher, and a direct build
inside it runs before the browser can paint - so on a big assembly the first
picture waits for the whole strip. Measured on the 1M4X capsid, first ink
against the moment the load settles:

    direct build in checkFrameChange    9157 / 9007 ms  of a 9471 / 9335 load
    deferred, so the picture goes first  7232 / 7364 ms  of a 9177 / 9311 load

Same total work, 1.9 s sooner on screen. The deferred form is still synchronous
whenever the strip would not rebuild - which is every step of a playback - so
the colour and selection pass does not fall a frame behind the canvas.

🔴 MILLISECONDS ARE NOT ASSERTED HERE. This machine drifts by up to 3.2x
between runs, and a load is a long operation with a network-shaped tail. Counts
do not drift: one build is one build on any machine, and a second one is a bug
whatever the clock says.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_loadwork.html")
PORT = 9823
DEBUG_PORT = 9824
A = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"
B = sys.argv[2] if len(sys.argv) > 2 else "3CHY.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (fa, fb) => {
   try {
    window.__seqTrace = true;
    // 🔴 AND HOW MANY TIMES THE LOAD DREW THE SETTLED FRAME. _switchToObject
    // holds its draw until the next animation frame, and a single file makes
    // TWO switches - addObject's and applyPendingObjects' - so both queued a
    // frame callback and both drew, the first into a picture nothing had seen
    // yet. On a provisional 100x100 canvas that is two full 2D paints of the
    // whole structure: 122 and 79 ms of a 520 ms load on 1AOI.
    const rr = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    window.__settleDraws = 0;
    // 🔴 AND HOW MANY TIMES THE 2D PAINTER RAN AT A SIZE NOBODY CHOSE.
    // index.html holds the viewer inside a hidden parent until a structure
    // arrives, so the canvas starts at config.display.size and is marked
    // provisional; the GPU painter has declined that canvas since it was
    // written, which left the 2D one drawing the whole structure there
    // instead - 122 ms of a 440 ms load on 1AOI, thrown away one animation
    // frame later. Hooked at the PAINTER and not at render(), because
    // render() is called either way now and simply returns.
    window.__provisionalDraws = 0;
    const C = window.py2dmolCartoon;
    if (C && C.render) {
      const realPaint = C.render;
      C.render = function (...a) {
        if (rr.canvas && rr.canvas.__viewportProvisional) {
          window.__provisionalDraws = (window.__provisionalDraws || 0) + 1;
        }
        return realPaint.apply(this, a);
      };
    }
    const realRender = rr.render.bind(rr);
    rr.render = (w) => {
      if (String(w) === 'object switch settled') window.__settleDraws += 1;
      return realRender(w);
    };
    const zero = () => {
      window.__faceBuilds = 0; window.__segmentBuilds = 0; window.__ssBuilds = 0;
      window.__captures = 0; window.__rotations = 0; window.__projections = 0;
      window.__seqBuilds = 0; window.__seqEntries = 0; window.__seqBuildFrom = [];
      window.__settleDraws = 0; window.__provisionalDraws = 0;
      window.__eGrow = 0; window.__gGrow = 0;
    };
    const snap = () => ({
      mesh: window.__faceBuilds, seg: window.__segmentBuilds,
      ss: window.__ssBuilds, cap: window.__captures,
      seqBuilds: window.__seqBuilds, seqEntries: window.__seqEntries,
      settle: window.__settleDraws, prov: window.__provisionalDraws || 0,
      grow: (window.__eGrow || 0) + (window.__gGrow || 0),
      from: (window.__seqBuildFrom || []).slice(0, 4),
    });
    const put = async (f) => {
      const t = await (await fetch('/' + f)).text();
      await window.processFiles([{name: f, readAsync: () => Promise.resolve(t)}], true);
      await until(loaded, 300000);
    };
    zero();
    await put(fa);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(10);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    await settle(10);
    const first = Object.assign({n: r.coords.length, style: r.style}, snap());

    zero();
    await put(fb);
    await settle(12);
    const second = snap();

    zero();
    r.render('idle'); await settle(6); r.render('idle2'); await settle(6);
    const idle = snap();
    return {first, second, idle};
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
profile_dir = "/tmp/py2dmol-loadwork"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_loadwork.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(A)}, {json.dumps(B)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"][:300])

bad = []
for tag, row in (("first load", out["first"]), ("second load", out["second"]),
                 ("idle after", out["idle"])):
    print(f"{tag}: mesh {row['mesh']}, segments {row['seg']}, ss {row['ss']},"
          f" captures {row['cap']}, settle draws {row.get('settle')},"
          f" draws at a provisional size {row.get('prov')},"
          f" edge array growths {row.get('grow')},"
          f" sequence {row['seqBuilds']}"
          f" ({row['seqEntries']} entries)")
    for f in row.get("from") or []:
        print(f"      built from {f}")

f1 = out["first"]
if f1["seqBuilds"] != 1:
    bad.append(f"the first load built the sequence view {f1['seqBuilds']}"
               " time(s), not once - a direct buildSequenceView and a deferred"
               " one both ran, and each visits every position")
for tag, row in (("the first load", out["first"]), ("a second load", out["second"])):
    if (row.get("settle") or 0) > 1:
        bad.append(f"{tag} drew the settled frame {row['settle']} times."
                   " _switchToObject queues one draw per switch and a load"
                   " makes two switches - addObject's and"
                   " applyPendingObjects' - so both fire in the same animation"
                   " frame and the first is overwritten before anything sees"
                   " it. One settle per batch, and the focus recall belongs to"
                   " the LAST switch")
    # 🔴 THE EDGE ARRAYS ARE SIZED FROM THE FACE COUNT, so the growth path
    # should never run. A quad has four edges and neighbours share them, so the
    # edge count lands near twice the face count - which buildMeshPart knows.
    # Starting at 1024 and doubling was 7 reallocations of four arrays a build
    # on a 46,463-face structure, the largest of them megabytes, copying about
    # as much again as the final size and leaving every intermediate behind.
    if (row.get("grow") or 0) > 0:
        bad.append(f"{tag} grew the edge or group arrays {row['grow']} time(s)."
                   " They are sized from the face count for exactly this"
                   " reason; either the estimate is now wrong for this shape or"
                   " the sizing was reverted to a constant")
    if (row.get("prov") or 0) > 0:
        bad.append(f"{tag} drew the structure {row['prov']} time(s) into a"
                   " canvas still marked __viewportProvisional - a size the"
                   " page never chose, corrected by the resize observer an"
                   " animation frame later. renderApp has declined that canvas"
                   " since it was written; render() declines it now too, and"
                   " only index.html sets the flag, so an embed and the"
                   " notebook still draw")
for tag, row in (("the first load", out["first"]), ("a second load", out["second"])):
    for f in row.get("from") or []:
        if "checkFrameChange" in f:
            bad.append(f"{tag} built the sequence view from checkFrameChange,"
                       " which is an animation-frame watcher - so the build"
                       " ran before the browser could paint and the first"
                       " picture waited for the whole strip. It must go"
                       " through buildViewDeferred, which is synchronous"
                       " anyway whenever the strip would not rebuild."
                       f" Stack: {f}")

if f1["mesh"] != 1:
    bad.append(f"the first load built the mesh {f1['mesh']} time(s), not once")
if out["second"]["seqBuilds"] != 1:
    bad.append(f"loading a second object built the sequence view"
               f" {out['second']['seqBuilds']} time(s), not once")
idle = out["idle"]
if idle["mesh"] or idle["seqBuilds"] or idle["seg"] or idle["ss"]:
    bad.append(f"two idle renders did work: {idle}")

print()
for b in bad:
    print("FAIL: " + b)
print("load work: " + ("FAILED" if bad else "each thing built once"))
sys.exit(1 if bad else 0)
