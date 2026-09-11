"""A RESIZE IS A CAMERA, NOT A REBUILD - and it draws what a rebuild draws.

    python3 tests/resize_reuse.py [1UBQ.cif]

The mesh is built in model space and drawn through a scale: `drawScale` is the
resident mesh's own scale times `viewScaleMul`, the ratio between what the live
view span fits to and what the captured one did. Nothing in the mesh depends on
the size of the canvas, so dragging a viewer wider should cost a redraw and
nothing else.

It cost a full rebuild per resize step, and the reason was not the mesh:

  * the canvas size `w, h` was in the TOPOLOGICAL key - the one the station
    fast path compares - so every size declined the path outright;
  * and it had to be, because the ratio above evaluated BOTH spanFits at the
    live canvas, so the canvas cancelled out of a ratio it belongs in. A mesh
    built in one box and drawn in another came out at the wrong scale:
    measured on 1UBQ built at 706x706 and reused at 500x500, **20.09% of the
    frame differed from the same frame rebuilt, at a worst channel of 223, with
    a same-build floor of 0.0000%** - the same structure at two sizes.

`resident.capW/capH` record the canvas the capture was taken on, the ratio uses
them, and the key no longer carries the size. This file is the gate on both
halves: the path has to be TAKEN, and the picture it draws has to be the one a
rebuild draws.

🔴 THE CONTROL PUTS THE FAULT BACK. Two frames agreeing proves the comparison
works and nothing else - a probe comparing a frame with itself would pass with
the scale completely wrong. So one arm sets `window.__ignoreCapCanvas`, which
makes the draw evaluate the captured span's fit at the LIVE canvas again, and
that arm has to disagree loudly. Comparing against the frame before the resize
cannot do it: the two canvases are different sizes and there is nothing to
subtract.

🔴 AND IT DOES NOT NEED THE STATION PATH AT ALL. The first version of this
answered a resize by REBUILDING the ribbon's station table from a fresh capture,
which works for the ribbon and not for the tail - lone atoms, ligands and side
chains are rebuilt by unprojecting the capture at the MESH's scale, and on
1EHZ's nine ions that put them at the wrong size in the wrong place (1.92% of
the frame at a worst channel of 255). The simpler answer is that a size change
needs no new geometry of any kind: the key separates the canvas from the rest,
and when only the canvas moved the mesh in hand IS this frame's mesh. Nothing is
rebuilt, so nothing can go stale - tail included - and a structure with ONE
frame, which has no station path at all, gets it too. That was the case reported:
"resizing no longer rebuilds where there are more than 1 frames, but I still see
rebuilds for 1 frame".

🔴 WHAT THIS FILE DOES NOT COVER, and tests/embed.py does: coming back to a
SIGNATURE that was current before the resize. The spare mesh slot is found by
signature and holds a mesh captured on the old canvas, so restoring it draws the
wrong box - setContacts([]) in embed.py left a picture that did not match the
one before the contacts, 2 runs out of 2, until the slot was dropped on a size
change. An arm was written here to reproduce it and could not: within one size
the spare is current, and the sequence that matters needs the key to leave and
return ACROSS the resize. It is gated where it was found rather than faked here.

🔴 AND THE RESIZE GOES THROUGH THE CONTAINER. The viewport's ResizeObserver
watches #canvasContainer and sizes the canvas from it; a probe that sets the
canvas directly is fighting it, and the observer's own render lands in the
middle of the measurement.
"""
import base64, io, json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_resizereuse.html")
PORT = 9873
DEBUG_PORT = 9874
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"
SIZES = [(500, 500), (640, 420), (500, 500)]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, sizes) => {
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
    // 🔴 THE STATION PATH IS NOT SWITCHED ON, deliberately. It is only on for
    // an object with more than one frame, and the file this drives has one - so
    // forcing it here would test a path a reader of a static structure never
    // takes, which is exactly how the single-frame case stayed broken while
    // this gate was green.
    if (G.invalidate) G.invalidate();
    r.render('warm'); await settle(8);
    const cv = r.canvas;
    const box = document.querySelector('#canvasContainer');
    if (!box) return {error: 'no #canvasContainer to resize'};
    const shape = () => {
      const s = G.stationsResident ? G.stationsResident() : null;
      const d = G.stationDump ? G.stationDump() : null;
      return s ? {stations: s.stations, pieces: s.pieces, faces: s.count,
                  tail: d ? d.tail : -1, resident: d ? d.residentCount : -1} : null;
    };
    const out = [];
    const base = shape();
    for (const [w, h] of sizes) {
      const b0 = window.__faceBuilds || 0;
      box.style.width = w + 'px';
      box.style.height = h + 'px';
      await until(() => Math.abs(r.displayWidth - w) < 2, 10000);
      // ...and the OBSERVER's own frame is the one that meets the new size
      // first. Its decision is the one that matters; by the time the probe
      // renders, the mesh it declined over has already been rebuilt and the
      // next frame reports nothing at all.
      const obsWhy = G.stationDecline ? String(G.stationDecline() || '') : '';
      await settle(4);
      // 🔴 THE DECISION IS READ BEFORE ANYTHING ELSE RENDERS. A settle here
      // lets the next frame - which is at the new size and matches - overwrite
      // it, and the probe reports the state that frame left instead.
      r.render('resized');
      const why = (G.stationDecline ? String(G.stationDecline() || '') : '') || obsWhy;
      const built = (window.__faceBuilds || 0) - b0;
      await settle(4);
      const fast = cv.toDataURL('image/png');
      // ...the floor: another frame with nothing changed at all
      r.render('floor'); await settle(3);
      const floor = cv.toDataURL('image/png');
      // ...the control, BEFORE the mesh is rebuilt: with the captured canvas
      // ignored the ratio is evaluated at the live size again, which is the
      // fault. After a rebuild the captured canvas IS the live one and the
      // flag changes nothing, so this has to happen while the mesh is still
      // the one built at the old size.
      window.__ignoreCapCanvas = true;
      r.render('control'); await settle(4);
      const control = cv.toDataURL('image/png');
      window.__ignoreCapCanvas = false;
      r.render('controlOff'); await settle(3);
      if (G.invalidate) G.invalidate();
      r.render('rebuilt'); await settle(5);
      const full = cv.toDataURL('image/png');
      out.push({w, h, built, why, shape: shape(), fast, floor, full, control});
    }
    return {base, out};
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
profile_dir = "/tmp/py2dmol-resizereuse"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_resizereuse.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {json.dumps(SIZES)}).then(JSON.stringify)"))
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


bad = []
base = res["base"] or {}
print(f"{FILE}: " + (f"{base['stations']} stations, {base['pieces']} pieces,"
                     f" {base['faces']} faces at load" if base
                     else "no station table (one frame), which is the point"))
for row in res["out"]:
    # ...and there may be no station table at all: it is only installed for an
    # object with more than one frame, and this property does not need it.
    s = row["shape"] or {}
    pct, worst = diff(row["fast"], row["full"])
    fpct, fworst = diff(row["fast"], row["floor"])
    cpct, cworst = diff(row["fast"], row["control"])
    print(f"  {row['w']}x{row['h']}  builds {row['built']}"
          f"  {(str(s['stations']) + '/' + str(s['pieces']) + '/' + str(s['faces']) + ' tail ' + str(s['tail'])) if s else 'no station table'}"
          f"  reused vs rebuilt {('n/a' if pct is None else f'{pct:.4f}% worst {worst}')}"
          f"   floor {('n/a' if fpct is None else f'{fpct:.4f}%')}"
          f"   control {('n/a' if cpct is None else f'{cpct:.2f}%')}"
)
    # 🔴 NOTHING MAY REBUILD, WITH OR WITHOUT A TAIL. A size change is a
    # camera change: the key separates it from everything that describes the
    # mesh, and when only it moved the mesh in hand is this frame's mesh.
    if row["built"]:
        bad.append(f"{row['w']}x{row['h']}: the resize rebuilt the mesh"
                   f" ({row['built']} build(s)): {row['why'][:90]}."
                   " Nothing in the mesh is a function of the canvas - it is"
                   " built in model space and drawn through a scale that"
                   " carries the canvas it was captured on")
    if s and base and {k: v for k, v in s.items() if k != 'tail'} != {k: v for k, v in base.items() if k != 'tail'}:
        bad.append(f"{row['w']}x{row['h']}: the counts moved,"
                   f" {s['stations']}/{s['pieces']}/{s['faces']} against"
                   f" {base['stations']}/{base['pieces']}/{base['faces']}."
                   " Then the canvas IS topology and the key was right")
    if pct is None:
        bad.append(f"{row['w']}x{row['h']}: the two frames are different sizes,"
                   " so nothing was compared")
        continue
    if fpct:
        bad.append(f"{row['w']}x{row['h']}: two frames with nothing changed"
                   f" differ by {fpct:.4f}% - the scene is still settling and"
                   " the comparison below is about that, not about the path")
    if pct > 0.05:
        bad.append(f"{row['w']}x{row['h']}: the reused mesh drew"
                   f" {pct:.4f}% of the frame differently from the same frame"
                   f" rebuilt, at a worst channel of {worst}. The scale the"
                   " draw applies is the live view span's fit over the"
                   " CAPTURED one - if the captured one is evaluated at the"
                   " live canvas, the size cancels out of it")
    # 🔴 THE CONTROL HAS TO FIRE. With __ignoreCapCanvas the captured span's
    # fit is evaluated at the live canvas, which is the bug this file exists
    # for, and the frame must come out visibly wrong. If it does not, the
    # comparison above is not sensitive to a scale error and its zero means
    # nothing.
    if cpct is not None and cpct < 1.0 and not row["built"]:
        bad.append(f"{row['w']}x{row['h']}: putting the fault back changed only"
                   f" {cpct:.2f}% of the frame, so this comparison cannot see a"
                   " scale error and the agreement above is about nothing")

print()
for b in bad:
    print("FAIL: " + b)
print("resize reuse: " + ("FAILED" if bad
                          else "a resize redraws the mesh it already had"))
sys.exit(1 if bad else 0)
