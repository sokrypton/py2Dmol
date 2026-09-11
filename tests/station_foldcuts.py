"""What dropping the orientation-fold cuts costs, and what it buys.

    python3 tests/station_foldcuts.py [1UBQ.cif]

geom.js cuts a ribbon piece at every ORIENTATION FOLD - where the face or width
normal crosses zero. The cuts exist so the 2D painter can sort pieces by depth:
a piece spanning a fold carries its near half's key and the painter hoists the
whole footprint, folded-away part included. A GPU frame resolves that per
fragment and needs none of it.

They are also what stops a trajectory step reusing its face list. oB and oN
follow the geometry, so a cut MOVES when the structure does, and the
face-to-station mapping moves with it - a third of steps on 1TIM
(tests/station_frames.py).

🔴 BUT A CUT IS ALSO A PIECE BOUNDARY, AND PIECE BOUNDARIES ARE WHERE THE
OUTLINE IS DRAWN. So this is not a free switch, and this file exists to say what
it actually costs in pixels rather than to argue that it should be free. Two
frames of the same structure at the same view, one with the cuts and one
without, compared like any other pair - plus the piece count, which is what the
change buys.

🔴 AND IT IS NOT ZERO, WHICH ONE STRUCTURE WILL TELL YOU IT IS. Measured with
the outline on, at 706x706:

    structure   pieces        pixels moved   worst   what it is
    1UBQ        201 -> 196    0.0000%          1     nothing
    1EHZ        240 -> 234    0.0000%          1     nothing
    1AOI       3855 -> 3784   0.0068%         49     34 isolated pixels
    3CHY        384 -> 376    0.0327%          7     one 12x20 spot

1UBQ alone says 0.0000% at a worst of 1 and invites the conclusion that the
change is free. It is not: 1AOI moves 34 pixels by up to 49 levels of 255, and
3CHY moves 164 in a single 12x20 patch. Both were looked at rather than
summarised - the 1AOI pixels are isolated singles and the 3CHY patch is a faint
shading-band difference across one loop's interior, with the outline intact and
the geometry unmoved. Imperceptible, and REAL, and those are not the same word.

🔴 SO THE SAME-BUILD FLOOR IS MEASURED HERE TOO, because a difference means
nothing without one. Two builds of the identical arm, compared the same way:
0.0000% at a worst of 0 on all four. This frame is bit-reproducible in this
configuration, so every number in the table above is signal.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_foldcuts.html")
PORT = 9803
DEBUG_PORT = 9804
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  // 🔴 A REJECTION HERE HANGS THE CALLER, NOT THE PAGE. cdp.evaluate awaits
  // this promise, and an exception inside it rejects rather than resolving -
  // so the socket sits there until it times out and the failure is reported as
  // "timed out" with no idea where. 1BNA cost an investigation that way, twice.
  // Catch it and return it, which is what the caller already checks for.
  window.__go = async (file) => {
    try { return await window.__run(file); }
    catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__run = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(6);
    await until(() => !r._quietStyle && !r._switchQuiet, 20000);
    const G = window.py2dmolCartoonGPU;

    const shot = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
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
      return {moved: moved / (a.length / 4), worst, mean: sum / (a.length / 4)};
    };
    const pieces = () => {
      const keep = {po: r._probeOnly, pp: r._primProbe, gpu: r.useGPU};
      const kf = r._keepFoldCuts;
      r.useGPU = false; r._probeOnly = true; r._primProbe = null;
      r._keepFoldCuts = false;
      r.render('foldCount');
      const n = (r._primProbe || []).filter((p) => p && p.kind === 'rib' && p.Lp).length;
      r._probeOnly = keep.po; r._primProbe = keep.pp; r.useGPU = keep.gpu;
      r._keepFoldCuts = kf;
      return n;
    };
    const scans = () => ({scans: window.__foldCutScans || 0,
                         found: window.__foldCutsFound || 0});
    const frame = (noFold) => {
      window.__foldCutScans = 0; window.__foldCutsFound = 0;
      // 🔴 _keepFoldCuts, NOT _noFoldCuts. The mesh path drops the cuts on
      // every build now (see captureFrom), so setting _noFoldCuts here is
      // overruled in BOTH arms and this file compares a picture with itself.
      // This is the switch that actually reaches the mesh.
      r._keepFoldCuts = !noFold;
      r._noFoldCuts = noFold;
      if (G && G.invalidate) G.invalidate();
      r.render('fold' + (noFold ? 'Off' : 'On'));
      const st = (G && G.stationsResident) ? G.stationsResident() : null;
      return {px: shot(), faces: st ? st.pieces : -1, scan: scans()};
    };

    // The station table is what the piece count below is read from, and it is
    // only built while the station path is on.
    if (G && G.setStationDraw) G.setStationDraw(true);
    r.outlineMode = 'on'; r.relativeOutlineWidth = 3;
    if (G && G.invalidate) G.invalidate();
    await settle(6);
    const a = frame(false);
    const nWith = pieces();
    // 🔴 THE SAME-BUILD FLOOR, FIRST. This frame is not bit-reproducible - a
    // rebuild at identical settings does not give identical pixels - so a
    // difference between the two arms means nothing until it is put beside a
    // difference between two builds of the SAME arm. Without this the file
    // reports whatever it finds as the cost of the change.
    const a2 = frame(false);
    const b = frame(true);
    const nWithout = pieces();
    const withCuts = a.px; const without = b.px;
    r._noFoldCuts = false;
    r._keepFoldCuts = false;
    if (G && G.invalidate) G.invalidate();
    r.render('foldRestore');

    return {
      piecesWith: nWith, piecesWithout: nWithout,
      scanWith: a.scan, scanWithout: b.scan,
      facesWith: a.faces, facesWithout: b.faces,
      inkedWith: inked(withCuts), inkedWithout: inked(without),
      diff: diff(withCuts, without),
      floor: diff(a.px, a2.px),
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
profile_dir = "/tmp/py2dmol-foldcuts"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_foldcuts.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the page to load")
out = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

bad = []
d = out["diff"]
drop = 1 - out["piecesWithout"] / max(out["piecesWith"], 1)
print(f"{FILE}")
print(f"  pieces : {out['piecesWith']} with the fold cuts,"
      f" {out['piecesWithout']} without  ({100 * drop:.1f}% fewer)")
print(f"  mesh   : {out['facesWith']} mesh pieces with the cuts,"
      f" {out['facesWithout']} without")
print(f"  ink    : {100 * out['inkedWith']:.2f}% -> {100 * out['inkedWithout']:.2f}%")
fl = out["floor"]
print(f"  picture: {100 * d['moved']:.4f}% of pixels moved,"
      f" worst {d['worst']}, mean {d['mean']:.4f}")
print(f"  floor  : {100 * fl['moved']:.4f}% of pixels moved,"
      f" worst {fl['worst']}, mean {fl['mean']:.4f}"
      "   (two builds of the SAME arm)")

# 🔴 THE FLAG HAS TO DO SOMETHING, or every number here is about one picture
# compared with itself.
# 🔴 AND THE MESH IS WHAT THIS COMPARES, so the flag has to have reached the
# MESH and not only the 2D prim list the piece count is taken from. Without
# this the file passed while captureFrom overruled both arms.
# 🔴 THE FLAG HAS TO REACH THE LOOP, WHICH IS NOT THE SAME AS CHANGING THE
# PIECE COUNT. It used to be checked as "with the cuts there are more pieces",
# and at the sampling this file was written for that was true. It is not any
# more - the cuts are nearly inert, one on 1AOI's 4,933 pieces and none on
# 1UBQ or 3CHY - so the old check could not tell "the flag never arrived" from
# "it arrived and found nothing to cut", which are opposite conclusions about
# opposite faults. The scan counter separates them.
sw = out.get("scanWith") or {}
so = out.get("scanWithout") or {}
print(f"  cut scan: {sw.get('scans', 0)} intervals scanned with the cuts on,"
      f" {sw.get('found', 0)} cuts found;"
      f" {so.get('scans', 0)} scanned with them off")
if not sw.get("scans"):
    bad.append("the fold-cut loop never ran with the cuts ON, so the flag did"
               " not reach captureFrom and the two frames below are one frame"
               " compared with itself")
if so.get("scans"):
    bad.append(f"the fold-cut loop ran {so['scans']} time(s) with the cuts OFF,"
               " so _noFoldCuts is not reaching the loop and the arms are the"
               " same arm")
if not sw.get("found") and out["piecesWith"] == out["piecesWithout"]:
    print("  (the cuts found nothing on this structure, so the pixel"
          " comparison below is of one picture with itself - which is the"
          " honest answer at this sampling, not a failure)")
# ...and the cost is reported rather than asserted small: this file exists to
# say what it is, and the decision of whether it is acceptable is not a
# threshold's to make. What IS asserted is that the drawing is still the same
# drawing - the same solid, inked to within a fraction of a percent.
# ...and the floor has to be BELOW what is being reported, or the difference
# between the arms is the same noise the identical arms produce and this file is
# describing its own measurement rather than the change.
if fl["moved"] > 0.5 * d["moved"] and d["moved"] > 0:
    bad.append(f"two builds of the same arm differ over {100 * fl['moved']:.4f}%"
               f" of the frame against {100 * d['moved']:.4f}% between the arms"
               " - the floor is not below the signal, so nothing here is"
               " attributable to the cuts")
if abs(out["inkedWith"] - out["inkedWithout"]) > 0.01:
    bad.append(f"the two ink {100 * out['inkedWith']:.2f}% and"
               f" {100 * out['inkedWithout']:.2f}% of the frame - dropping the"
               " cuts changed what is drawn, not just how it is divided")

print()
for b in bad:
    print("FAIL: " + b)
print("station fold cuts: " + ("FAILED" if bad else "measured"))
sys.exit(1 if bad else 0)
