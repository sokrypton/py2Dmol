"""THE HALO MUST LAND WHERE IT LANDED, HOWEVER IT WAS PROJECTED.

    python3 tests/halo_partial.py [1UBQ.cif ...]

The selection halo needs screen positions for what is MARKED - a few residues
and the side chains they own - and used to get them by rotating and projecting
the WHOLE structure, on every frame a selection was on screen. On a capsid that
is a 560x slowdown to draw a ring around five things:

    1M4X, 2,081,520 positions, rotating
      nothing selected      0.13 ms a frame
      five selected        70.87 ms a frame   (31.6 rotating, 34.0 projecting)
      five selected, now    5.52 ms a frame

`_projectMarks` does the same arithmetic for the marks alone - literally the
same, through the shared `_rotateAt` and `_projectAt`, so there is no second
copy to drift.

🔴 THIS FILE IS WHY THAT MAY SHIP. A halo one pixel off is a wrong picture, not
a slow one, and nothing else in the suite would notice: the mark is drawn over
a frame that is otherwise identical. So the same view is captured twice - once
with the partial projection and once with `_haloFullProjection` forcing the old
path - and the two must be IDENTICAL, pixel for pixel.

🔴 AND THE HALO HAS TO BE VISIBLE IN BOTH, or two blank canvases agree
perfectly. The inked difference between "selection on" and "selection off" is
measured and required to be real.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_halopartial.html")
PORT = 9821
DEBUG_PORT = 9822
FILES = sys.argv[1:] or ["1UBQ.cif", "1EHZ.cif", "3PTB.cif"]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
   try {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    // 🔴 TUBE, AND THAT IS THE WHOLE POINT. The GPU TUBE path leaves an IOU
    // rather than a projection - "rotatedCoords may be a view out of date and
    // screenX and friends may be unwritten" - and the halo is one of the two
    // readers that settle it. The cartoon path projects inside paintgl as part
    // of drawing, so there is no pending frame there and _projectMarks
    // correctly declines. A version of this file in cartoon style reported
    // "mark projections 0" on every structure, which is the gate working.
    if (r.setStyle) r.setStyle('tube'); else r.style = 'tube';
    await settle(12);

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

    // ...with side chains showing too, so the mark has to reach them - that is
    // the case the marks set exists for
    const o = r.objectsData[r.currentObjectName];
    o.sidechains = new Set([5, 6, 7, 8]);
    r.reloadDrawn(true); r.render('halo:sc'); await settle(6);

    r.residueSelection = new Set();
    r.render('halo:none'); await settle(6);
    const bare = shot();

    r.residueSelection = new Set([5, 6, 7, 8, 20, 21]);
    r._haloFullProjection = false;
    r._haloMarksProjection = true;
    r.render('halo:partial'); await settle(6);
    const partial = shot();
    const marksUsed = window.__markProjections || 0;

    r._haloMarksProjection = false;
    r._haloFullProjection = true;
    r.render('halo:full'); await settle(6);
    const full = shot();

    // ...and the same view twice on the full path, for the floor
    r.render('halo:full2'); await settle(6);
    const full2 = shot();
    r._haloFullProjection = false;
    r._haloMarksProjection = false;
    r.residueSelection = new Set();

    return {file, n: r.coords.length,
            visible: diff(bare, full), agree: diff(partial, full),
            floor: diff(full, full2), marksUsed};
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
profile_dir = "/tmp/py2dmol-halopartial"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_halopartial.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")

bad = []
for f in FILES:
    out = json.loads(cdp.evaluate(
        ws, f"window.__go({json.dumps(f)}).then(JSON.stringify)"))
    if out.get("error"):
        bad.append(f"{f}: page error: {out['error'][:200]}")
        continue
    v = out["visible"]; a = out["agree"]; fl = out["floor"]
    print(f"{f}: {out['n']} positions")
    print(f"  the halo inks       {100 * v['moved']:.4f}% of the frame"
          f" (worst {v['worst']})")
    print(f"  partial vs full     {100 * a['moved']:.4f}% (worst {a['worst']})"
          f"   floor {100 * fl['moved']:.4f}%")
    print(f"  mark projections    {out['marksUsed']}")
    if a["moved"] > fl["moved"] or a["worst"] > fl["worst"]:
        bad.append(f"{f}: the halo drawn from the partial projection differs"
                   f" from the full one over {100 * a['moved']:.4f}% of the"
                   f" frame at a worst of {a['worst']}, against a same-path"
                   f" floor of {100 * fl['moved']:.4f}% - it is landing"
                   " somewhere the old path did not")
    if v["moved"] < 0.0005:
        bad.append(f"{f}: selecting six residues changed"
                   f" {100 * v['moved']:.4f}% of the frame - there is no halo"
                   " to compare, so the agreement above means nothing")
    if not out["marksUsed"]:
        bad.append(f"{f}: the partial path was never taken, so the comparison"
                   " is the full path against itself")

chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

print()
for b in bad:
    print("FAIL: " + b)
print("halo partial: " + ("FAILED" if bad else "the marks land where the structure did"))
sys.exit(1 if bad else 0)
