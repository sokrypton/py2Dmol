"""What a trajectory step costs when only the stations are uploaded.

    python3 tests/station_frames.py [_traj_1tim.pdb]

The question this whole exercise started from. A frame change today rebuilds the
mesh - the capture, facesOf, buildMeshPart, the edge table, 1.3 MB of instance
rows - because every cache derived from the coordinates keys on the frame. With
the geometry in a texture and the face list in a buffer that does not move, a
step is: capture the stations, write two textures, draw.

Three arms, alternating, medians - this machine drifts:

  rebuild     setFrame + render, exactly as it ships
  stations    capture + stationMeshOf + updateStations + render
  draw only   render alone, both paths' floor, to say how much of each arm is
              the draw and how much is the work being removed

🔴 AND THE PICTURE IS CHECKED, NOT ASSUMED. A fast arm that draws the previous
frame is the obvious way for this to be wrong, so each arm's canvas is compared
against the rebuild's at the same frame. Timing an arm without checking it drew
the right thing measures nothing.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationframes.html")
PORT = 9801
DEBUG_PORT = 9802
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILE = ARGS[0] if ARGS else "_traj_1tim.pdb"
# ...and whether to drop the orientation-fold cuts for this run.
NO_FOLD = "--no-fold-cuts" in sys.argv

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(6);
    await until(() => !r._quietStyle && !r._switchQuiet, 20000);
    const G = window.py2dmolCartoonGPU;
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    // 🔴 KEEP SSE ON, WITHOUT WHICH THERE IS NO CONSTANT TOPOLOGY TO UPLOAD
    // INTO. The station count follows the assignment - a residue drawn as
    // strand is a different width and a different number of stations from the
    // same residue drawn as coil - so an unpinned trajectory changes the shape
    // of the table and updateStations correctly refuses.
    // 🔴 THE AUTOMATIC TABLE OUT OF THE WAY, or there is no reference arm.
    // renderApp switches the station table on for any object with more than
    // one frame now, so setStationDraw(false) below is undone on the next
    // frame and the "rebuild" arm becomes the station path measured against
    // itself: it reported a station step at 4.80 ms against a rebuild's 4.80,
    // which is the file working. Same switch tests/station_integrated.py and
    // tests/stable_topology.py use.
    r._autoStationTable = false;
    r.stableTopology = true;
    // 🔴 AND THE FOLD CUTS OFF, WHEN ASKED. They are what moves the
    // face-to-station mapping between frames - oB and oN follow the geometry -
    // and tests/station_foldcuts.py measures the GPU picture as unchanged
    // without them. This arm is what says whether removing them is what lifts
    // the decline rate, rather than assuming it.
    r._noFoldCuts = NO_FOLD_CUTS;
    if (r._invalidateSegmentCache) r._invalidateSegmentCache();

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
    const captureStations = () => {
      // 🔴 THE CAPTURE paintgl ITSELF USES. A hand-rolled one skips the
      // GPU thickness floors and the view-cull and clip settings that
      // captureFrom applies, and a table built one way and updated the
      // other drew 8.6% of pixels differently.
      return G.stationMeshNow(r, r.displayWidth, r.displayHeight, null);
    };

    // Install once, at frame 0, from a real rebuild.
    G.setStationDraw(false);
    window.__gpuDiag = true; window.__fill = null;
    r.setFrame(0); if (G.invalidate) G.invalidate();
    r.render('install'); await settle(4);
    const fill = window.__fill;
    window.__gpuDiag = false;
    if (!fill) return {error: 'no __fill at frame 0'};
    const mesh0 = captureStations();
    if (!mesh0) return {error: 'no station mesh at frame 0'};
    if (!G.installStations(mesh0, fill)) {
      // `declined`, not `refused`: the latter is the per-step count below, and
      // one name for both made the failure a TypeError in the reporting rather
      // than the message it was trying to print.
      return {declined: G.stationRefusal ? G.stationRefusal() : '?'};
    }

    const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
    const rebuild = []; const station = []; const drawOnly = [];
    let worstPix = 0; let movedPix = 0; let refused = 0;
    const shapeAt = [];
    const perFrame = [];
    const parts = {setFrame: [], capture: [], update: [], draw: []};
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i < Math.min(frames, 12); i++) {
        // ARM 1: the shipped step.
        G.setStationDraw(false);
        let t0 = performance.now();
        r.setFrame(i); r.render('rebuild');
        rebuild.push(performance.now() - t0);
        const A = (round === 0) ? shot() : null;

        // ARM 2: the same step, stations only.
        // ...and the station arm broken into its parts, because "4 ms" does
        // not say whether the work left is the capture, the table or the
        // upload, and those are three completely different next moves.
        t0 = performance.now();
        r.setFrame(i);
        const tSet = performance.now();
        const m = captureStations();
        const tCap = performance.now();
        const tUp0 = performance.now();
        let ok = m && G.updateStations(m);
        const tUp = performance.now();
        if (!ok) {
          // 🔴 A SHAPE CHANGE IS A REBUILD, NOT A STALE FRAME. The piece
          // cutting is not purely topological: geom.js cuts at every
          // ORIENTATION FOLD, where the face or width normal crosses zero, and
          // those follow the geometry. Keep SSE pins the assignment and cannot
          // pin that. So the fast path handles the frames where the table keeps
          // its shape and hands the rest back - which is the correct behaviour
          // and has to be TIMED, not excluded, or the number is a best case
          // nobody will see.
          refused += 1;
          G.setStationDraw(false);
          window.__gpuDiag = true; window.__fill = null;
          if (G.invalidate) G.invalidate();
          r.render('rebuildFallback');
          const f2 = window.__fill;
          window.__gpuDiag = false;
          const m2 = captureStations();
          if (f2 && m2) ok = G.installStations(m2, f2);
          // 🔴 WHAT CHANGED SHAPE, not just that something did. The station
          // count following the assignment is the case Keep SSE covers; the
          // PIECE count moving is a different animal, because pieces are cut
          // by the renderer and a cut that moves with the geometry means the
          // face list is not purely topological after all.
          if (shapeAt.length < 6 && m) {
            shapeAt.push({frame: i, stations: m.stationCount, pieces: m.pieceCount,
                          faces: m.faceCount});
          }
        }
        G.setStationDraw(!!ok);
        const tDraw0 = performance.now();
        r.render('stations');
        const now = performance.now();
        station.push(now - t0);
        parts.setFrame.push(tSet - t0);
        parts.capture.push(tCap - tSet);
        parts.update.push(tUp - tUp0);
        parts.draw.push(now - tDraw0);
        if (round === 0 && A) {
          const d = diff(A, shot());
          worstPix = Math.max(worstPix, d.worst);
          movedPix = Math.max(movedPix, d.moved);
          // ...and WHICH frames, because a max over eleven says nothing about
          // whether one is wrong or all of them are.
          if (d.moved > 0.002) {
            perFrame.push({frame: i, moved: +(100 * d.moved).toFixed(3),
                           worst: d.worst, usedStations: !!ok});
          }
        }

        // ARM 3: the floor - a redraw with nothing changed.
        t0 = performance.now();
        r.render('drawOnly');
        drawOnly.push(performance.now() - t0);
        G.setStationDraw(false);
      }
    }
    G.setStationDraw(false); G.clearResidentStations();
    r.stableTopology = false;
    r._autoStationTable = true;
    r._noFoldCuts = false;
    return {
      frames, stations: mesh0.stationCount, pieces: mesh0.pieceCount,
      faces: mesh0.faceCount, positions: r.coords.length,
      rebuildMs: med(rebuild), stationMs: med(station), drawMs: med(drawOnly),
      worstPix, movedPix, refused, shapeAt, perFrame,
      parts: Object.fromEntries(Object.entries(parts)
        .map(([k, v]) => [k, med(v)])),
      installed: {stations: mesh0.stationCount, pieces: mesh0.pieceCount,
                  faces: mesh0.faceCount},
      bytesFaces: Math.floor(fill.length / 48) * 48 * 4,
      bytesStations: mesh0.stationCount * 16 * 4 + mesh0.pieceCount * 8 * 4,
    };
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
SETUP = SETUP.replace("NO_FOLD_CUTS", "true" if NO_FOLD else "false")
open(PROBE, "w").write(
    open(os.path.join(ROOT, "dev.html")).read()
    .replace("</body>", "<script>" + SETUP + "</script></body>"))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


if not os.path.exists(os.path.join(ROOT, FILE)):
    import subprocess
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py")],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-stationframes"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationframes.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the page to load")
out = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])
if out.get("declined"):
    sys.exit("the station path declined: " + out["declined"])

bad = []
print(f"{FILE}: {out['positions']} positions, {out['frames']} frames,"
      f" {out['stations']} stations, {out['faces']} faces")
print(f"  rebuild   {out['rebuildMs']:.2f} ms a step")
print(f"  stations  {out['stationMs']:.2f} ms a step"
      f"   ({out['rebuildMs'] / max(out['stationMs'], 1e-9):.2f}x)")
print(f"  draw only {out['drawMs']:.2f} ms  (the floor both share)")
pt = out["parts"]
print(f"  of which  setFrame {pt['setFrame']:.2f}  capture {pt['capture']:.2f}"
      f"  upload {pt['update']:.2f}  draw {pt['draw']:.2f} ms")
print(f"  uploaded  {out['bytesStations'] / 1024:.0f} KB against"
      f" {out['bytesFaces'] / 1024:.0f} KB rebuilt"
      f"  ({out['bytesFaces'] / max(out['bytesStations'], 1):.1f}x)")
print(f"  picture   {100 * out['movedPix']:.4f}% of pixels moved, worst"
      f" {out['worstPix']}   ({out['refused']} steps declined)")
if out.get("perFrame"):
    print("  frames whose picture moved:")
    for e in out["perFrame"]:
        print(f"    frame {e['frame']}: {e['moved']}% moved, worst {e['worst']},"
              f" drawn from stations: {e['usedStations']}")
if out.get("shapeAt"):
    print(f"  installed {out['installed']}")
    for e in out["shapeAt"]:
        print(f"    declined at frame {e['frame']}: {e}")

# 🔴 DECLINES ARE EXPECTED AND ARE PART OF THE TIME. What must not happen is
# most of them declining, which would mean the fast path almost never runs and
# the headline number is a best case.
steps = 3 * (min(out["frames"], 12) - 1)
print(f"  rebuilt   {out['refused']} of {steps} steps, because a cut moved")
if out["refused"] > steps * 0.6:
    bad.append(f"{out['refused']} of {steps} steps had to rebuild - the mapping"
               " survives too rarely for the fast path to be the path, and the"
               " headline number would be a best case nobody sees")
if out["movedPix"] > 0.001:
    bad.append(f"the station arm's picture differs from the rebuild's by"
               f" {100 * out['movedPix']:.2f}% of pixels (worst"
               f" {out['worstPix']}) - a fast frame showing the wrong geometry"
               " is not a faster frame")
if out["stationMs"] >= out["rebuildMs"]:
    bad.append(f"a station step costs {out['stationMs']:.2f} ms against the"
               f" rebuild's {out['rebuildMs']:.2f} - the point of the exercise"
               " is that it should be less")

print()
for b in bad:
    print("FAIL: " + b)
print("station frames: " + ("FAILED" if bad else "a step is stations, not a mesh"))
sys.exit(1 if bad else 0)
