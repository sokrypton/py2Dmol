"""A STICK FACE MUST BE DRAWN THE SAME WHETHER THE STATIONS OR THE ROWS DERIVE IT.

    python3 tests/station_stick_faces.py

An object with more than one frame takes the station fast path
(`cartoon/paintgl.js`, `frames.length > 1`), and on that path the shader
rebuilds each face's corners and its OUTWARD NORMAL from the station table
instead of reading them out of the instance row. The corners were exact; the
normal was not. It was taken as the section's own frame vector - `ub` for the
+u side, `wa` for the +v one, the tangent for a cap - and that is the face
normal only while the section is PERPENDICULAR to the bond. A stick's is
routinely not: a mitred junction and the flush cut where a side chain meets the
backbone both slide the four corners along the bond, which tilts `ub` and `wa`
out of the faces they are supposed to stand on while the faces stay put.

The cull is `dot(fn, vd) < -0.02`, so a face seen near edge-on is decided by a
few hundredths - and one side face of an ILE's arm was kept by the build and
culled by the stations. Reported as: open the final structure alone and the arm
is a solid bar; open the same coordinates as a 25-frame trajectory and it is a
pale flat plate. Measured on the reader's own save at their own camera: 48,333
inked pixels against 47,278, the missing ink one contiguous blob.

WHAT THIS ASKS: over a trajectory with every side chain shown, and at three
cameras, the picture the station path draws equals a forced REBUILD of the same
frame. That is the two derivations compared directly, which is the only shape of
check that can see this - the counts, the rows and the corners all agreed while
the drawing did not (docs/STATION_SIDECHAIN_FACES.md lists twelve such).

🔴 AND WHICH PROGRAM DREW EACH ARM IS ASSERTED, not assumed. Both arms drawing
from the stations - or both from the rows - compares a thing with itself and
passes against anything.
"""
import json, os, sys, shutil, subprocess, http.server, socketserver, threading, functools

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DEBUG_PORT = 9975, 9976
PROBE = os.path.join(ROOT, "_stationstickfaces.html")
TRAJ = "_traj_3ptb.pdb"

if not os.path.exists(os.path.join(ROOT, TRAJ)):
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py"),
                    "3PTB.cif"], cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

JS = """(async () => {
  //HELPERS
  const G = window.py2dmolCartoonGPU;
  const R = () => window.py2dmol_viewers['standalone-viewer-1'].renderer;
  const txt = await (await fetch('/%TRAJ%')).text();
  await window.processFiles([{name: '%TRAJ%', readAsync: () => Promise.resolve(txt)}], false);
  await until(loaded, 20000);
  const r = R();
  await until(() => r.coords && r.coords.length > 0, 20000);
  await settle(6);
  try { r.showSidechains(); } catch (e) {}
  await settle(6);
  // A COMPARISON ON A HIDDEN VIEWER IS TWO BLANK FRAMES AGREEING, so the box is
  // sized and the size is reported.
  const box = document.querySelector('.py2dmol-slot--1 > .py2dmol-slot-body')
    || document.getElementById('canvasContainer');
  if (box) { box.style.width = '600px'; box.style.height = '600px'; }
  await settle(8);
  const ink = () => {
    const c = r.canvas;
    return {d: c.getContext('2d').getImageData(0, 0, c.width, c.height).data,
            w: c.width, h: c.height};
  };
  const inked = (im) => { let n = 0;
    for (let i = 0; i < im.d.length; i += 4)
      if (im.d[i + 3] > 8 && !(im.d[i] > 246 && im.d[i + 1] > 246 && im.d[i + 2] > 246)) n++;
    return n; };
  // 🔴 THE APP TURNS THE STATION PATH BACK ON BY ITSELF whenever the object has
  // more than one frame, which is exactly the fixture here - so the rebuild arm
  // has to say no twice: once to the auto-enable and once to the flag.
  const draw = async (stations) => {
    G.clearResident(); G.clearResidentStations();
    if (r.invalidate) r.invalidate();
    r._autoStationTable = !!stations;
    G.setStationDraw(!!stations);
    r.render('probe'); await settle(3);
    r.render('probe'); await settle(3);
    return {im: ink(), prog: window.__drawProgram};
  };
  const nF = Math.min(8, r.objectsData[r.currentObjectName].frames.length);
  const rows = [];
  for (let cam = 0; cam < 3; cam++) {
    if (cam) {
      // the drag's own rotation, applied straight to the viewer state
      const M = window.py2dmolCartoonGPU.__internals;
      r.viewerState.rotation = M.matMul(M.rotationMatrixY(0.9),
          M.matMul(M.rotationMatrixX(0.45), r.viewerState.rotation));
      await settle(4);
    }
    for (let k = 0; k < nF; k += 3) {
      r.setFrame(k); await settle(3);
      const fast = await draw(true);
      const slow = await draw(false);
      let diff = 0; let worst = 0;
      for (let i = 0; i < fast.im.d.length; i += 4) {
        let big = false;
        for (let c = 0; c < 3; c++) {
          const dd = Math.abs(fast.im.d[i + c] - slow.im.d[i + c]);
          if (dd > worst) worst = dd;
          if (dd > 8) big = true;
        }
        if (big) diff++;
      }
      rows.push({cam, frame: k, diff, worst,
                 inkFast: inked(fast.im), inkSlow: inked(slow.im),
                 progFast: fast.prog, progSlow: slow.prog});
    }
  }
  const im = ink();
  return JSON.stringify({rows, size: [im.w, im.h],
                         px: im.d.length / 4});
})()"""
JS = JS.replace("//HELPERS", HELPERS).replace("%TRAJ%", TRAJ)

from probe_js import check_js  # noqa: E402
check_js(JS, "tests/station_stick_faces.py")

open(PROBE, "w").write(open(os.path.join(ROOT, "dev.html")).read())
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT),
                               functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome = None
try:
    chrome, ws = cdp.launch(DEBUG_PORT, "/tmp/py2dmol-stationstick")
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationstickfaces.html")
    cdp.wait_for(ws, "typeof window.processFiles === 'function'", timeout=120, what="dev.html")
    out = json.loads(cdp.evaluate(ws, JS))
finally:
    if chrome: chrome.kill()
    httpd.shutdown()
    shutil.rmtree("/tmp/py2dmol-stationstick", ignore_errors=True)
    try: os.remove(PROBE)
    except OSError: pass

bad = []
px = out["px"]
print(f"  canvas {out['size']}, {px} pixels")
worst = 0
for row in out["rows"]:
    print(f"  cam {row['cam']} frame {row['frame']}: {row['diff']} of {px} px differ"
          f" (worst channel {row['worst']}), ink {row['inkFast']} / {row['inkSlow']},"
          f" drawn by {row['progFast']} / {row['progSlow']}")
    worst = max(worst, row["diff"])
    if row["progFast"] != "stations":
        bad.append(f"cam {row['cam']} frame {row['frame']}: the fast arm drew from"
                   f" {row['progFast']}, not the stations - nothing was compared")
    if row["progSlow"] != "fill":
        bad.append(f"cam {row['cam']} frame {row['frame']}: the rebuild arm drew from"
                   f" {row['progSlow']} - it is not the other derivation")
    if row["inkFast"] < 5000 or row["inkSlow"] < 5000:
        bad.append(f"cam {row['cam']} frame {row['frame']}: only {row['inkFast']} /"
                   f" {row['inkSlow']} pixels are inked - this compared two empty frames")

# 🔴 THE BOUND IS THE TIE-BREAK NOISE, NOT ZERO. The two paths concatenate the
# mesh in the same order and the depth test decides coincident surfaces, so a
# handful of pixels change hands whichever derivation drew. Measured on this
# fixture at 6-40; a lost face is 900 and up.
LIMIT = 250
if worst > LIMIT:
    bad.append(f"the station path draws {worst} pixels differently from a rebuild of the"
               f" same frame (limit {LIMIT}) - a stick face is derived two ways")

for x in bad:
    print("FAIL: " + x)
print("station stick faces: " + ("FAILED" if bad
                                 else f"both derivations draw the same stick, worst {worst} px"))
sys.exit(1 if bad else 0)
