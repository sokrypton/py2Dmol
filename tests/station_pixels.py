"""The station path draws the same picture.

    python3 tests/station_pixels.py [1UBQ.cif]

tests/station_corners.py proves the numbers a station implies are the numbers
the mesh was built from. This draws with them: the shipped path renders a frame,
the station path renders the same frame from two textures and an 18-float row,
and the two images are compared pixel for pixel.

🔴 THE CONTROL IS A ROTATION, NOT A SECOND RUN. Two draws of the identical
scene agreeing proves the comparison works and nothing else - a probe that
compared a frame with itself would pass with the station path drawing nothing at
all. So the same comparison is run against a frame drawn a few degrees away,
which must disagree loudly.

🔴 AND A BLANK FRAME IS A FAILURE, NOT A MATCH. The commonest way for a new
draw path to "agree" is to draw nothing over a cleared canvas while the other
also happens to be mostly paper. The ink coverage of both frames is counted and
they have to be within a few percent of each other and well above zero.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationpixels.html")
PORT = 9799
DEBUG_PORT = 9800
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"

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
    if (!G || !G.installStations) return {error: 'no installStations'};
    if (!G.stationProgram().linked) return {error: 'the station program did not link'};

    const shot = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    // HOW MUCH OF THE FRAME IS NOT PAPER. A blank draw is the failure this
    // catches; without it "the images agree" can mean "both are empty".
    const inked = (d) => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n += 1;
      }
      return n / (d.length / 4);
    };
    const diff = (a, b) => {
      let moved = 0; let worst = 0; let sum = 0;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
        if (d > 2) moved += 1;
        if (d > worst) worst = d;
        sum += d;
      }
      const px = a.length / 4;
      return {moved: moved / px, worst, mean: sum / px};
    };

    // 1. THE SHIPPED PATH, and the mesh it built.
    window.__gpuDiag = true;
    window.__fill = null;
    G.setStationDraw(false);
    if (G.invalidate) G.invalidate();
    r.render('pixelsA'); await settle(4);
    const fill = window.__fill;
    if (!fill) return {error: 'no __fill'};
    const A = shot();

    // 2. THE STATION TABLE, from the same view and frame.
    // 🔴 THE CAPTURE paintgl ITSELF USES. A hand-rolled one skips the GPU
    // thickness floors and the view-cull and clip settings captureFrom
    // applies; a table built one way and updated the other drew 8.6% of
    // the pixels differently at worst 224.
    const mesh = G.stationMeshNow(r, r.displayWidth, r.displayHeight, null);
    if (!mesh) return {error: 'stationMeshOf built nothing'};
    if (!G.installStations(mesh, fill)) {
      // A REFUSAL IS A RESULT, NOT AN ERROR. The station table covers the rib
      // prims; a structure with base plates or ligands has faces it cannot
      // describe, and saying so is the correct behaviour to assert.
      return {refused: G.stationRefusal ? G.stationRefusal() : 'no reason given',
              faces: mesh.faceCount, fillRows: Math.floor(fill.length / 48),
              stations: mesh.stationCount, pieces: mesh.pieceCount};
    }

    // 3. THE SAME FRAME, DRAWN FROM THE STATIONS. No invalidate: the resident
    //    mesh is untouched and only the feed changes, which is the point.
    G.setStationDraw(true);
    r.render('pixelsB'); await settle(4);
    const B = shot();
    const same = diff(A, B);
    // 🔴 WHERE the pixels differ, not only how many. A shading fault spread
    // over every broad face and one confined to the rims at piece ends are the
    // same number and completely different bugs. An 8x8 map of the mean
    // difference tells them apart at a glance, and the per-face count below
    // says whether it is a few faces or all of them.
    const map = (() => {
      const w = r.canvas.width; const h = r.canvas.height;
      const N = 8; const cells = new Array(N * N).fill(0);
      const counts = new Array(N * N).fill(0);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          let d = 0;
          for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A[i + k] - B[i + k]));
          const c = Math.floor(y * N / h) * N + Math.floor(x * N / w);
          cells[c] += d; counts[c] += 1;
        }
      }
      return cells.map((v, i) => +(v / Math.max(counts[i], 1)).toFixed(2));
    })();
    // ...and how the differences are distributed by size, which separates a
    // uniform rounding drift from a handful of badly wrong faces.
    const bands = (() => {
      const b = {d3: 0, d8: 0, d16: 0, d32: 0, d64: 0};
      for (let i = 0; i < A.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A[i + k] - B[i + k]));
        if (d > 64) b.d64 += 1; else if (d > 32) b.d32 += 1;
        else if (d > 16) b.d16 += 1; else if (d > 8) b.d8 += 1;
        else if (d > 3) b.d3 += 1;
      }
      return b;
    })();

    // 4. THE CONTROL. A few degrees of rotation, drawn the station way, has to
    //    disagree with A - otherwise this compares nothing.
    const rot0 = r.viewerState.rotation.map((row) => row.slice());
    if (r.rotateView) r.rotateView(0.12, 0.07);
    else {
      const c = Math.cos(0.12); const s2 = Math.sin(0.12);
      r.viewerState.rotation = [[c, 0, s2], [0, 1, 0], [-s2, 0, c]];
    }
    r.render('pixelsC'); await settle(4);
    const C = shot();
    const turned = diff(A, C);
    r.viewerState.rotation = rot0;

    G.setStationDraw(false);
    G.clearResidentStations();
    window.__gpuDiag = false;
    r.render('pixelsRestore'); await settle(2);

    return {
      faces: mesh.faceCount, stations: mesh.stationCount, pieces: mesh.pieceCount,
      fillRows: Math.floor(fill.length / 48),
      inkedA: inked(A), inkedB: inked(B),
      same, turned, map, bands,
      resident: G.stationsResident ? G.stationsResident() : null,
      bytesFaces: Math.floor(fill.length / 48) * 48 * 4,
      bytesStations: mesh.stationCount * 16 * 4 + mesh.pieceCount * 8 * 4,
    };
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
profile_dir = "/tmp/py2dmol-stationpixels"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationpixels.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the page to load")
out = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

if out.get("refused"):
    # 🔴 REFUSING IS A PASS, and saying which faces it could not describe is the
    # point: a path that drew 15,216 of 17,558 instances would have lost the
    # nucleosome's base plates and still looked like a protein.
    print(f"{FILE}: declined - {out['refused']}")
    print(f"  {out['stations']} stations over {out['pieces']} pieces described"
          f" {out['faces']} of {out['fillRows']} faces")
    print("station pixels: declined, with a reason")
    sys.exit(0)

if "same" not in out:
    sys.exit("unexpected result: " + json.dumps(out)[:400])
bad = []
s = out["same"]
t = out["turned"]
print(f"{FILE}: {out['faces']} faces / {out['fillRows']} rows,"
      f" {out['stations']} stations, {out['pieces']} pieces")
print(f"  ink: shipped {100 * out['inkedA']:.1f}%   stations {100 * out['inkedB']:.1f}%")
print(f"  same view : {100 * s['moved']:.4f}% of pixels moved,"
      f" worst {s['worst']}, mean {s['mean']:.4f}")
print(f"  control   : {100 * t['moved']:.4f}% moved, worst {t['worst']} (a turned view)")
b = out["bands"]
px = 1
print(f"  by size   : >3 {b['d3']}  >8 {b['d8']}  >16 {b['d16']}"
      f"  >32 {b['d32']}  >64 {b['d64']}")
print("  mean difference, 8x8 over the frame:")
m = out["map"]
for row in range(8):
    print("    " + " ".join(f"{m[row * 8 + c]:6.2f}" for c in range(8)))
print(f"  per frame : {out['bytesFaces'] / 1024:.0f} KB -> "
      f"{out['bytesStations'] / 1024:.0f} KB"
      f"  ({out['bytesFaces'] / max(out['bytesStations'], 1):.1f}x)")

if out["inkedB"] < 0.01:
    bad.append(f"the station path inked {100 * out['inkedB']:.2f}% of the frame -"
               " it drew nothing, and an empty frame over paper can agree with"
               " anything")
elif abs(out["inkedA"] - out["inkedB"]) > 0.02:
    bad.append(f"the two paths ink {100 * out['inkedA']:.1f}% and"
               f" {100 * out['inkedB']:.1f}% of the frame - one is drawing"
               " substantially more than the other")
if s["moved"] > 0.02:
    bad.append(f"{100 * s['moved']:.2f}% of pixels differ between the two paths"
               f" (worst channel {s['worst']}) - past what a different route to"
               " the same geometry should produce")
if t["moved"] < 0.05:
    bad.append(f"a turned view differs from the first by only"
               f" {100 * t['moved']:.2f}% of pixels, so this comparison cannot"
               " see a picture change and proves nothing about the one above")

print()
for b in bad:
    print("FAIL: " + b)
print("station pixels: " + ("FAILED" if bad else "the same picture"))
sys.exit(1 if bad else 0)
