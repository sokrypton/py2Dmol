"""A WELD ACROSS A COLLAPSED STATION MUST NOT OUTLIVE THE COLLAPSE.

    python3 tests/weld_open.py

The edge table is keyed by corner POSITION, so where the ribbon has no
thickness at a station the top face's corner and the bottom face's coincide
and the build files them as ONE edge with two faces. The station fast path
keeps the edge table across frames. When a later frame gives that station its
thickness back, the row still names both faces, and the silhouette test draws
it as a stroke across the strand, at the place the sheet was broken when the
mesh was built. Reported from an AlphaFold 3 fold played in LocalFold: "a line
at the E|EE interface as we go frame to frame", absent after a rebuild or a
reloaded session.

tests/sheet_merge.py did not see it and passes on the bug: it forces a gap in
the MIDDLE of a straight run, and compares only rows flagged always-draw. This
row is a two-face row that the per-frame silhouette test draws.

WHAT THIS ASKS: build at the frame where the strands are broken, step to the
frame where they are whole ON THE FAST PATH, and compare against a fresh build
of the same frame. And that the step did not rebuild - the repair is a row
switched off for the frame (clipOpenWelds in cartoon/paintgl.js), not a
declined step, because the fast path exists so that a letter moving costs no
build.

THE FIXTURE IS INLINE: two frames (1 and 19) of that fold's 25, alpha carbons
only, and the saved rotation. The session it came from is not in the repo.

Measured at 2.5x zoom, counting only pixels the fast frame DARKENS: 153 with
the repair's call removed, 27 with it (tie-break noise at the arrow ends; the
stroke is gone), and 0 rebuilds either way. The bound is 70.
"""
import json, os, sys, shutil, http.server, socketserver, threading, functools

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DEBUG_PORT = 9991, 9992
PROBE = os.path.join(ROOT, "_weldopen.html")
FIX = json.loads('''{"names":["PRO","ILE","ALA","GLN","ILE","HIS","ILE","LEU","GLU","GLY","ARG","SER","ASP","GLU","GLN","LYS","GLU","THR","LEU","ILE","ARG","GLU","VAL","SER","GLU","ALA","ILE","SER","ARG","SER","LEU","ASP","ALA","PRO","LEU","THR","SER","VAL","ARG","VAL","ILE","ILE","THR","GLU","MET","ALA","LYS","GLY","HIS","PHE","GLY","ILE","GLY","GLY","GLU","LEU","ALA","SER","LYS"],"nums":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59],"a":[[5.75,-3.99,8.49],[2.48,-3.96,5.97],[-0.1,-1.73,6.25],[-3.37,-2.56,4.79],[-5.68,0.05,4.18],[-9.27,-0.05,2.88],[-10.34,3.31,1.31],[-13.39,4.5,-0.94],[-12.82,4.99,-4.36],[-12.34,8.38,-5.68],[-9.11,9.47,-4.66],[-6.92,10.84,-6.65],[-3.36,9.41,-7.23],[-1.16,12.16,-5.28],[-3.76,12.13,-2.27],[-2.93,7.88,-1.95],[0.89,8.64,-2.78],[0.55,11.55,-0.32],[-1.43,8.89,2.2],[1.34,5.97,1.58],[4.28,8.69,1.96],[2.81,9.51,5.54],[1.52,6,6.87],[5.2,4.7,5.9],[7.19,7.45,7.72],[4.35,7.2,10.75],[4.92,3.66,10.57],[9.06,3.53,10.59],[9.35,6.59,13.39],[6.5,4.77,15.37],[8.32,1.07,14.98],[11.85,2.39,14.38],[11.65,0.54,11.26],[13.52,1.4,7.93],[11.18,3.58,5.56],[12.24,0.93,3.19],[10.91,-2.16,4.82],[7.42,-0.49,5],[4.6,-1.93,2.81],[1.55,-0.09,2.23],[-1.99,-1.54,0.31],[-4.41,0.37,-0.59],[-7.71,-1.39,-1.52],[-10.16,0.7,-2.74],[-13.92,-0.31,-2.52],[-16.58,0.89,-4.47],[-19.22,3.02,-3.06],[-21.61,-0.26,-3.32],[-19.45,-2.76,-1.73],[-19.18,-1.23,1.03],[-22.19,-1.04,3.78],[-22.57,0.68,7.2],[-25.19,-0.41,9.42],[-26.93,-2.52,7],[-26.84,0.16,3.75],[-24.94,0.66,1.17],[-22.78,3.02,2.06],[-23.99,4.42,-0.67],[-26.39,5.61,0.44]],"b":[[6.21,-3.88,8.45],[3.02,-4.08,6.19],[0.18,-1.68,6.42],[-3.37,-2.59,4.8],[-5.61,0.34,4.14],[-9.29,0.11,2.9],[-10.47,3.34,1.28],[-13.77,4.28,-0.72],[-13.07,4.86,-4.5],[-12.64,8.52,-5.92],[-9.45,9.52,-4.33],[-6.72,10.88,-6.69],[-3.42,9.21,-7.04],[-1.64,12.17,-5.46],[-3.88,11.63,-2.27],[-3.03,7.88,-2.29],[0.71,8.61,-2.74],[0.42,11.16,0.24],[-1.31,8.63,2.34],[1.39,5.9,1.42],[4.17,8.22,2.41],[2.6,9.71,5.53],[1.58,6.09,6.88],[5.16,4.77,5.87],[6.9,7.55,7.76],[4.52,7.17,10.92],[5.37,3.4,10.89],[9.02,3.94,10.46],[9.2,6.48,13.31],[6.79,4.49,15.67],[8.8,1.1,15.12],[12.32,2.39,14.67],[12.27,0.6,11.19],[13.94,1.55,7.98],[11.41,3.26,5.43],[12.46,0.79,2.8],[11.19,-2.04,4.91],[7.8,-0.52,5.11],[4.97,-1.74,2.72],[1.59,0.05,2.22],[-1.36,-1.7,0.51],[-4.43,0.44,-0.58],[-7.48,-1.3,-1.42],[-10.37,0.8,-3.05],[-13.89,-0.15,-2.35],[-16.9,0.81,-4.65],[-19.37,2.64,-2.85],[-22.06,-0.11,-3.83],[-19.57,-2.74,-2.16],[-19.53,-0.92,1.25],[-22.39,-1.04,3.86],[-22.8,0.55,7.35],[-25.51,-0.53,9.74],[-27.35,-2.68,7.01],[-27.28,0.17,4.28],[-25.08,0.69,1.28],[-22.63,3.55,1.64],[-23.76,4.79,-1.88],[-27.21,5.97,-0.35]],"rot":[[0.9685,0.0441,0.2449],[0.1638,0.628,-0.7608],[-0.1873,0.777,0.601]]}''')


def pdb():
    out = []
    for m, key in enumerate(("a", "b")):
        out.append("MODEL     %4d" % (m + 1))
        for i, (x, y, z) in enumerate(FIX[key]):
            out.append("ATOM  %5d  CA  %3s A%4d    %8.3f%8.3f%8.3f  1.00 90.00           C"
                       % (i + 1, FIX["names"][i], FIX["nums"][i], x, y, z))
        out.append("ENDMDL")
    return "\n".join(out + ["END", ""])


JS = """(async () => {
  //HELPERS
  const G = window.py2dmolCartoonGPU;
  await window.processFiles([{name: 'weld.pdb', readAsync: () => Promise.resolve(%PDB%)}], true);
  await until(loaded, 60000);
  const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
  await until(() => r.coords && r.coords.length > 0, 30000);
  await settle(8);
  r.autoRotate = false; r.cartoonPencil = 0; r.cartoonDetail = 4;
  if (r.setPreset) r.setPreset('richardson');
  r.viewerState.rotation = %ROT%;
  r.viewerState.zoom = 2.5;
  if (G.setStationDraw) G.setStationDraw(true);
  const px = () => { const c = r.canvas; return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
  r.setFrame(1); if (G.invalidate) G.invalidate(); r.render('fresh'); await settle(6);
  const fresh = px();
  r.setFrame(0); if (G.invalidate) G.invalidate(); r.render('base'); await settle(6);
  const b0 = window.__faceBuilds || 0;
  r.setFrame(1); r.render('step'); await settle(6);
  const fast = px();
  // 🔴 DARKER ONLY. The stroke is ink, so it can only darken a pixel; the
  // tie-break noise at the arrow ends goes both ways. Counting any difference
  // put the bug at 92 against 62 for the repair - a margin, not a test.
  let diff = 0, ink = 0;
  for (let i = 0; i < fast.length; i += 4) {
    if ((fresh[i] + fresh[i+1] + fresh[i+2]) - (fast[i] + fast[i+1] + fast[i+2]) > 120) diff++;
    if (fresh[i] + fresh[i+1] + fresh[i+2] < 600) ink++;
  }
  return JSON.stringify({diff, ink, total: fast.length / 4, rebuilt: (window.__faceBuilds || 0) - b0,
    clipped: G.edgeRefreshInfo ? G.edgeRefreshInfo().openWelds : null});
})()"""
JS = (JS.replace("//HELPERS", HELPERS).replace("%PDB%", json.dumps(pdb()))
      .replace("%ROT%", json.dumps(FIX["rot"])))

open(PROBE, "w").write(open(os.path.join(ROOT, "dev.html")).read())
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT),
                               functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome = None
try:
    chrome, ws = cdp.launch(DEBUG_PORT, "/tmp/py2dmol-weldopen")
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Emulation.setDeviceMetricsOverride", width=1400, height=1100,
            deviceScaleFactor=1, mobile=False)
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_weldopen.html")
    cdp.wait_for(ws, "typeof window.processFiles === 'function'", timeout=120, what="dev.html")
    out = json.loads(cdp.evaluate(ws, JS))
finally:
    if chrome: chrome.kill()
    httpd.shutdown()
    shutil.rmtree("/tmp/py2dmol-weldopen", ignore_errors=True)
    try: os.remove(PROBE)
    except OSError: pass

print(f"  fast step against a fresh build: {out['diff']} of {out['total']} px darker,"
      f" rebuilt {out['rebuilt']}, ink {out['ink']}")
bad = []
if out["ink"] < 2000:
    bad.append(f"only {out['ink']} px of ink - the comparison ran on an empty picture")
if out["rebuilt"]:
    bad.append("the step REBUILT, so this measured a build, not the fast path")
elif out["diff"] > 70:
    bad.append(f"{out['diff']} px are darker than in a fresh build of the same frame - a weld"
               " the build made across a collapsed station is drawn after the"
               " station has opened: a line across the strand")
for b in bad:
    print("FAIL: " + b)
print("weld open: " + ("FAILED" if bad else "an opened weld draws nothing"))
sys.exit(1 if bad else 0)
