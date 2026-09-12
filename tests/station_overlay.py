"""What is drawn ON TOP of the canvas follows the station fast path.

    python3 tests/station_overlay.py [_traj_1tim.pdb]

The selection halo, the sequence hover, click-picking and Orient's framing of a
selection all read renderer.screenX/screenY. Those are written by
projectPositions from a captured set of drawn positions - and the full rebuild
filled that set while the station fast path did not. Under the station table the picture
was then this frame's and the overlay was the frame the mesh was built at, drifting
further apart every step. Reported as "selection and orient seem broken with
the station table", which is exactly what it looks like: the halo sits off the ribbon,
a click answers the wrong residue, and Orient frames where the selection WAS.

🔴 THE COMPARISON IS AGAINST THE SAME STATE REBUILT, NOT AGAINST THE PLAIN PATH.
the station table pins the secondary structure, and a residue held as helix is smoothed
onto a different centre line from the same residue redrawn as coil - so the
drawn positions genuinely differ between the two modes and always will. Against
the plain path this reads 1-9 px whether the bug is present or not, which is a
measurement of the feature. Against a rebuild with the station table still on, everything
is pinned identically in both arms and the only thing left is the staleness.

🔴 AND NO GATE THAT COMPARES PICTURES COULD HAVE CAUGHT IT. The mesh, the fills
and the outline were all correct - tests/station_integrated.py reads 0.0018%
against a rebuild while this is happening. Nothing about a stale overlay reaches
a pixel of the canvas the GPU draws; it is in the arrays the app draws on top.
"""
import json, os, sys, shutil, subprocess, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationoverlay.html")
PORT = 9809
DEBUG_PORT = 9810
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILE = ARGS[0] if ARGS else "_traj_1tim.pdb"
TOL = 0.5      # display pixels

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, stations) => {
    if (window.__loadedFile !== file) {
      const t = await (await fetch('/' + file)).text();
      await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
      window.__loadedFile = file;
    }
    await until(loaded, 180000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 180000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const G = window.py2dmolCartoonGPU;
    const G0 = window.py2dmolCartoonGPU;
    if (!G0 || !G0.setStationDraw) return {error: 'no station switch on this page'};
    // THE STATION TABLE, which the station table used to switch on beside its pin.
    // The pin is gone; the table is the thing these arms were reaching for.
    if (G0 && G0.setStationDraw) G0.setStationDraw(!!stations);
    if (!stations && G0 && G0.clearResidentStations) G0.clearResidentStations();
    await settle(8);

    r.setFrame(0); r.render('build'); await settle(4);
    window.__stationFastPath = 0; window.__stationSlowPath = 0;
    // 🔴 STEP, so the fast path is the path in use. From a standing start the
    // mesh has just been rebuilt and the overlay is trivially current.
    const obj = r.objectsData[r.currentObjectName];
    const N = Math.min((obj && obj.frames) ? obj.frames.length : 1, 6);
    for (let i = 1; i < N; i++) { r.setFrame(i); r.render('step' + i); }
    await settle(4);
    const took = window.__stationFastPath || 0;
    const missed = window.__stationSlowPath || 0;

    const n = r.coords.length;
    const step = Math.max(1, Math.floor(n / 60));
    const read = () => {
      if (r._ensurePickProjection) r._ensurePickProjection();
      const x = []; const y = [];
      for (let i = 0; i < n; i += step) {
        x.push(r.screenX[i] || 0); y.push(r.screenY[i] || 0);
      }
      return [x, y];
    };
    const [fx, fy] = read();
    const pick = (xs, ys) => {
      const out = [];
      for (let i = 0; i < xs.length; i++) {
        out.push(r.pickResidueAt ? r.pickResidueAt(xs[i], ys[i]) : -2);
      }
      return out;
    };
    const fastPick = pick(fx, fy);
    if (G.invalidate) G.invalidate();
    r.render('rebuildSame');
    const [rx, ry] = read();
    const rebuiltPick = pick(fx, fy);   // the SAME points, asked again

    let dx = 0; let dy = 0;
    for (let i = 0; i < fx.length; i++) {
      dx = Math.max(dx, Math.abs(fx[i] - rx[i]));
      dy = Math.max(dy, Math.abs(fy[i] - ry[i]));
    }
    let disagree = 0;
    for (let i = 0; i < fastPick.length; i++) {
      if (fastPick[i] !== rebuiltPick[i]) disagree += 1;
    }
    if (G0 && G0.setStationDraw) { G0.setStationDraw(false); await settle(4); }
    return {stations, took, missed, samples: fx.length,
            dx: +dx.toFixed(3), dy: +dy.toFixed(3), disagree,
            posCount: window.__gpuPosCount || 0};
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
profile_dir = "/tmp/py2dmol-stationoverlay"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationoverlay.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
runs = {}
for tag, keep in (("the station table", True), ("plain", False)):
    runs[tag] = json.loads(cdp.evaluate(
        ws, f"window.__go({json.dumps(FILE)}, {'true' if keep else 'false'})"
            ".then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

bad = []
for tag, o in runs.items():
    if o.get("error"):
        sys.exit("page error: " + o["error"])
    print(f"{tag}: fast path {o['took']}, rebuilt {o['missed']},"
          f" {o['samples']} positions, {o['posCount']} drawn")
    print(f"    overlay against the same state rebuilt:"
          f" {o['dx']:.3f} px in x, {o['dy']:.3f} px in y")
    print(f"    pickResidueAt disagreed at {o['disagree']} of {o['samples']}"
          " of its own points")
    if max(o["dx"], o["dy"]) > TOL:
        bad.append(f"{tag}: the overlay is {max(o['dx'], o['dy']):.2f} px from"
                   " where the same state rebuilt puts it - the halo, picking"
                   " and Orient are all reading it")
    if o["disagree"]:
        bad.append(f"{tag}: the picker answered differently at {o['disagree']}"
                   " of its own points after a rebuild")
    if o["posCount"] <= 0:
        bad.append(f"{tag}: no drawn positions at all, so the overlay has"
                   " nothing to project and this measured nothing")

# 🔴 AND THE FAST PATH HAS TO HAVE RUN, or the the station table arm is just a rebuild
# wearing the mode's name and would pass with the bug fully present.
if runs["the station table"]["took"] <= 0:
    bad.append("the fast path never ran under the station table, so nothing here"
               " exercised the path this file is about")

print()
for b in bad:
    print("FAIL: " + b)
print("station overlay: " + ("FAILED" if bad else "the halo and the picker follow the picture"))
sys.exit(1 if bad else 0)
