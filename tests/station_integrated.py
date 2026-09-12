"""THE STATION PATH END TO END - AN INSTRUMENT NOW, NOT A GATE.

    python3 tests/station_integrated.py

🔴 ITS PREMISE WAS KEEP SSE, WHICH HAS BEEN REMOVED. This compared the station
fast path against a rebuild of the same frame and asserted three things: that
the path is taken on nearly every step, that it is faster, and that it draws
what a rebuild draws. All three held with the assignment PINNED. They do not
hold without it, and the pin is gone - so this is out of the gate lanes rather
than watered down to pass.

Measured on this tip, the table on and nothing pinned:

    _traj_1tim.pdb    22/33 steps, 1.05x / 0.93x     noise, either direction
    _traj_unfold.pdb  22/33 steps, 1.47x / 0.92x     and 0.083% of pixels
    _traj_1ehz.pdb    16/33 steps, 0.89x / 0.52x     6 rebuilds

🔴 AND THE PIXEL LINE IS AN OPEN BUG, NOT A CONSEQUENCE OF THE REMOVAL. On
_traj_unfold.pdb the fast path draws a frame 0.083% different from a rebuild of
it, worst channel 222 - and the same numbers appear on the commit BEFORE Keep
SSE was removed, with the pin taken away by hand. The station table auto-enables
for any multi-frame object (see paintgl.js, the stationAuto block), so that
configuration ships today and nothing checked it: this probe only ever ran the
table beside the pin. Whatever the revisit does about keeping an assignment, it
should start here - see docs/FRAME_STABILITY.md.

What it still does, faithfully: runs both arms over the same frames in one
process, compares the picture pixel for pixel against a rebuild, and reports how
often the path was taken. Read it; do not trust the exit code.
"""
import json, os, sys, shutil, subprocess, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationintegrated.html")
PORT = 9805
DEBUG_PORT = 9806
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
# 🔴 TWO TRAJECTORIES, AND THE SECOND ONE IS WHY THIS FILE MISSED A REAL BUG.
# _traj_1tim.pdb BREATHES: it moves every atom a little and its concavities
# barely change, so a fast path that holds a stale per-piece DECISION - which of
# a helix's two broad faces takes the pale inner tint - agrees with a rebuild to
# four decimal places and this gate passes. _traj_unfold.pdb comes apart, the
# decisions genuinely change, and the same gate reads 5.56% of pixels.
#
# That is exactly what shipped: the two-tone colour was baked into the instance
# row, the station path never rewrites that row, so the pale
# face stayed on whichever side frame 0 put it - visibly on the OUTSIDE of a
# helix by the second frame. The mechanism was in range of this gate the whole
# time and the trajectory was too gentle to show it.
#
# ...AND THE THIRD IS NUCLEIC. A base plate is a rib prim, but it is built by
# the rung emitter rather than by evalSlab, so it never carried the frame a
# station table needs: 84 of 237 prims on a tRNA, skipped, left in the tail the
# fast path draws from the BUILD frame. The backbone animated and the base pairs
# stood still. Nothing protein-only can see that.
FILES = ARGS or [f for f in ("_traj_1tim.pdb", "_traj_unfold.pdb", "_traj_1ehz.pdb")
                 if os.path.exists(os.path.join(ROOT, f))]
FILE = FILES[0] if FILES else "_traj_1tim.pdb"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  // 🔴 BOTH CASES, IN ONE PAGE. With the outline on the fast path must DECLINE
  // and the picture must still be exact; with it off the path must be TAKEN and
  // faster. Asserting only the second would ship a path that draws a stale
  // outline the moment anyone leaves outlines on, which is the default.
  window.__go = async (file, outline) => {
    if (window.__loadedFile !== file) {
      const t = await (await fetch('/' + file)).text();
      await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
      window.__loadedFile = file;
    }
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    // 🔴 NOT 30. A B-DNA duplex is 24 nucleotides, so a guard of 30 waits for
    // ever on exactly the structures the nucleic arm exists to cover, and the
    // probe times out rather than failing.
    await until(() => r.coords && r.coords.length > 10, 60000);
    await settle(6);
    await until(() => !r._quietStyle && !r._switchQuiet, 20000);
    const G = window.py2dmolCartoonGPU;
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    const N = Math.min(frames, 12);

    const shot = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => {
      let moved = 0; let worst = 0;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
        if (d > 2) moved += 1;
        if (d > worst) worst = d;
      }
      return {moved: moved / (a.length / 4), worst};
    };
    const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];

    // ARM 1: the same trajectory, same drawing settings, ordinary path.
    //
    // 🔴 THE SETTINGS HAVE TO MATCH OR THIS COMPARES TWO PICTURES. The
    // pins the assignment and CHANGES the drawing - a residue held as strand is
    // wider than the same residue redrawn as coil, which tests/cartoon_station.js
    // measures at 17 A - and the fold cuts change how pieces are divided. Run
    // against an arm without them, the fast path looked 20.9% different when
    // the only thing being tested is whether the mesh was rebuilt.
    // 🔴 THE AUTOMATIC TABLE OUT OF THE WAY, or there is no reference arm.
    // renderApp switches the station table on for any object with more than
    // one frame now, pinned or not - so `setStationDraw(false)` below is undone
    // on the very next frame and the "rebuild" arm this file compares against
    // becomes the station path measured against itself. It reported the fast
    // path as "not faster" on three trajectories, which is the file working.
    r._autoStationTable = false;
    G.setStationDraw(false);
    if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.setStationDraw(true);
    r._noFoldCuts = true;
    r.outlineMode = outline ? 'on' : 'none';
    r.relativeOutlineWidth = outline ? 3 : 0;
    if (r._invalidateSegmentCache) r._invalidateSegmentCache();
    if (G.invalidate) G.invalidate();
    r.setFrame(0); r.render('warm'); await settle(4);
    const plain = [];
    const want = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i < N; i++) {
        const t0 = performance.now();
        r.setFrame(i); r.render('plain');
        plain.push(performance.now() - t0);
        if (round === 0) want.push(shot());
      }
    }

    // ARM 2: the same loop with the path switched on. The station table pins
    // assignment and the fold cuts come off - both are what make the topology
    // hold still; see tests/station_frames.py for what each is worth.
    if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.setStationDraw(true);
    r._noFoldCuts = true;
    if (r._invalidateSegmentCache) r._invalidateSegmentCache();
    if (G.invalidate) G.invalidate();
    G.setStationDraw(true);
    r.setFrame(0); r.render('warmFast'); await settle(4);
    // 🔴 NOTHING IS INSTALLED BY HAND. The rebuild that draws frame 0 builds
    // the station table with the mesh, which is what makes this a path the app
    // has rather than a capability a probe can demonstrate. If that ever stops
    // happening, `installed` below is false and every number is a rebuild.
    const installed = !!(G.stationsResident && G.stationsResident());
    window.__stationFastPath = 0; window.__stationSlowPath = 0;
    const fast = [];
    let worst = 0; let moved = 0;
    let selfWorst = 0; let selfMoved = 0;
    let lagMoved = 1; let lagWorst = 255;
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i < N; i++) {
        const t0 = performance.now();
        r.setFrame(i); r.render('fast');
        fast.push(performance.now() - t0);
        if (round === 0) {
          const got = shot();
          const d = diff(want[i - 1], got);
          worst = Math.max(worst, d.worst);
          moved = Math.max(moved, d.moved);
          // 🔴 AND AGAINST A REBUILD OF THIS SAME FRAME, which separates "the
          // fast path drew it wrong" from "the two arms are not the same
          // picture for some other reason". Only the first is this file's
          // business, and only the second can be fixed in the probe.
          G.setStationDraw(false);
          if (G.invalidate) G.invalidate();
          r.render('checkRebuild');
          const d2 = diff(got, shot());
          selfWorst = Math.max(selfWorst, d2.worst);
          selfMoved = Math.max(selfMoved, d2.moved);
          // 🔴 IS IT SIMPLY LATE? A path that captures before the coordinates
          // are updated draws the previous frame, and against the right one
          // that is a large, stable difference indistinguishable from a wrong
          // transform. Comparing with the frame BEFORE says which.
          if (i >= 2) {
            const dl = diff(want[i - 2], got);
            if (dl.moved < lagMoved) { lagMoved = dl.moved; lagWorst = dl.worst; }
          }
          G.setStationDraw(true);
        }
      }
    }
    const took = window.__stationFastPath || 0;
    const missed = window.__stationSlowPath || 0;

    G.setStationDraw(false); G.clearResidentStations();
    r._noFoldCuts = false;
    r._autoStationTable = true;
    if (r._invalidateSegmentCache) r._invalidateSegmentCache();
    if (G.invalidate) G.invalidate();
    r.render('restore');
    return {outline, frames, steps: 3 * (N - 1), installed,
            plainMs: med(plain), fastMs: med(fast),
            took, missed, worst, moved, selfWorst, selfMoved,
            lagMoved, lagWorst,
            positions: r.coords.length};
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


if not os.path.exists(os.path.join(ROOT, FILE)):
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py")],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-stationintegrated"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationintegrated.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the page to load")
runs = {}
for f in FILES:
    for tag, outline in ((f + " / outline on", True), (f + " / outline off", False)):
        runs[tag] = json.loads(cdp.evaluate(
            ws, f"window.__go({json.dumps(f)}, {'true' if outline else 'false'})"
                ".then(JSON.stringify)"))
out = next(iter(runs.values()))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

bad = []
for tag, o in runs.items():
    print(f"{tag}: {o['plainMs']:.2f} ms a step, fast path on {o['fastMs']:.2f}"
          f" ({o['plainMs'] / max(o['fastMs'], 1e-9):.2f}x),"
          f" taken {o['took']}/{o['steps']}, rebuilt {o['missed']}")
    print(f"    picture vs the same frame rebuilt: {100 * o['selfMoved']:.4f}%"
          f" moved, worst {o['selfWorst']}")
    print(f"    vs the previous frame:             {100 * o['lagMoved']:.4f}%"
          f" moved   (the probe's own sensitivity)")
    if not o["installed"]:
        bad.append(f"{tag}: the station table was never installed")
    if o["selfMoved"] > 0.0001:
        bad.append(f"{tag}: the frame differs from the same frame rebuilt by"
                   f" {100 * o['selfMoved']:.3f}% of pixels (worst"
                   f" {o['selfWorst']})")
    if o["lagMoved"] < 0.01:
        bad.append(f"{tag}: consecutive frames differ by only"
                   f" {100 * o['lagMoved']:.3f}%, so this comparison could not"
                   " see a stale draw and proves nothing")

# 🔴 BOTH WAYS, INCLUDING WITH THE OUTLINE ON, WHICH IS THE DEFAULT. The edge
# instances are rewritten from the same stations now - endpoints, both face
# normals, and the crease classification - so there is no longer a setting where
# this path has to decline. If a change ever makes it decline again, this is
# where that shows up rather than in a slower animation nobody attributes.
for tag, o in runs.items():
    if o["took"] == 0:
        bad.append(f"{tag}: the fast path was never taken, so nothing here"
                   " measured it")
    elif o["took"] < o["steps"] * 0.5:
        bad.append(f"{tag}: the fast path ran {o['took']} of {o['steps']} steps"
                   " - too rarely to be the path a trajectory runs")
    if o["fastMs"] >= o["plainMs"]:
        bad.append(f"{tag}: the fast path costs {o['fastMs']:.2f} ms against"
                   f" {o['plainMs']:.2f} - it is not faster")

print()
for b in bad:
    print("FAIL: " + b)
print("station integrated: " + ("FAILED" if bad else "the loop takes it, outline and all"))
sys.exit(1 if bad else 0)
