"""EVERY UNIFORM AND EVERY DRAW CALL, fast frame against rebuilt frame.

    python3 tests/draw_diff.py [1YNE.cif] [frame]

tests/outline_sync.py established that a frame the app did not rebuild can draw
differently from a rebuild of the same frame - 0.018% of the picture at a worst
channel of 201 on 1YNE - and then eliminated, one at a time, every piece of
state the card holds: the station floats, the piece floats, the face mapping,
the instance rows bar one lane the shader substitutes, the draw scale, the
depth range and the texture padding are all bit-identical between the two arms,
and two renders of one frame on one path differ by nothing at all.

So the difference is not in the DATA. This compares what the draw is
parameterised BY: every uniform* call and every draw call the GL context
receives, in order, wrapped at the prototype so nothing in src/ has to know.

🔴 THE ORDER MATTERS AND SO DOES THE COUNT. A uniform set twice with different
values, a draw call issued with a different instance count, a program bound in
a different order - any of those is a difference this catches and a state dump
cannot. The two sequences are diffed element by element, like every other
comparison in this suite.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_drawdiff.html")
PORT = 9937
DEBUG_PORT = 9938
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILE = ARGS[0] if ARGS else "1YNE.cif"
FRAME = int(ARGS[1]) if len(ARGS) > 1 else 8

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, frame) => {
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
    r.outlineMode = 'on'; r.relativeOutlineWidth = 3;
    await settle(4);

    // ---- the recorder, at the prototype ------------------------------
    const proto = window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype;
    if (!proto) return {error: 'no WebGL2RenderingContext to wrap'};
    let log = null;
    let idN = 0;
    const names = [];
    for (const k of Object.getOwnPropertyNames(proto)) {
      // 🔴 UNIFORMS AND DRAWS ONLY. A rebuild also CREATES textures, so its
      // bindTexture calls outnumber the fast frame's and every later call is
      // offset - which reports the two sequences as differing from call zero
      // and says nothing. What parameterises the draw is the uniforms and the
      // draw calls themselves; the binds are reported as a count instead.
      // 🔴 AND useProgram AND bindTexture BACK IN, because the first version
      // printed every GL object as "<obj>" and so could not tell two
      // PROGRAMS apart. Identical uniform names and values set on two
      // different programs is exactly what "the draws are identical" would
      // look like while the shaders differ. They are given identities below.
      if (/^uniform/.test(k) || /^drawArrays|^drawElements/.test(k)
          || k === 'useProgram') {
        names.push(k);
      }
    }
    const saved = {};
    for (const k of names) {
      const fn = proto[k];
      if (typeof fn !== 'function') continue;
      saved[k] = fn;
      proto[k] = function (...args) {
        if (log) {
          // a uniform location is an opaque object; its identity is stable
          // within a program, so it is indexed rather than printed
          const a = args.map((v) => {
            if (v && typeof v === 'object' && !ArrayBuffer.isView(v)
                && !Array.isArray(v)) {
              // a stable identity per GL object, so two different programs
              // stop looking like one
              if (!v.__id) { v.__id = '#' + (++idN); }
              return v.__id;
            }
            if (ArrayBuffer.isView(v) || Array.isArray(v)) {
              return Array.from(v).map((x) => +(+x).toFixed(6)).join(',');
            }
            return typeof v === 'number' ? +v.toFixed(6) : String(v);
          });
          log.push(k + '(' + a.join(' ') + ')');
        }
        return saved[k].apply(this, args);
      };
    }

    const capture = (fn) => { log = []; fn(); const out = log; log = null; return out; };

    // 🔴 ARM A HAS TO ARRIVE THE WAY THE REPORT DOES: from frame 0, one step
    // at a time, with no rebuild forced anywhere. Stepping straight from the
    // frame before it showed NO difference at all - the fault needs a run of
    // consecutive station updates behind it, which is the same thing the
    // playback trace said when it found 24 frames and not one rebuild.
    // ...and MORE THAN ONE LAP. Nine consecutive updates was not enough;
    // tests/outline_sync.py walks every frame twice before the pass that
    // finds the difference, so the run behind it is about forty steps.
    const nF = 20;
    for (let lap = 0; lap < 2; lap += 1) {
      for (let i = 0; i < nF; i += 1) {
        r.setFrame(i); r.render('walk' + lap + '-' + i); await settle(2);
      }
    }
    // ...and stop ONE SHORT, so the captured render below is the FIRST render
    // of this frame and not a second one. A second render of an unchanged
    // frame takes the sig early-out and redraws whatever is resident, so if
    // the first render of a frame is the wrong one, arriving a frame early is
    // the only way to catch it.
    for (let i = 0; i < frame; i += 1) {
      r.setFrame(i); r.render('walk2-' + i); await settle(2);
    }
    r.setFrame(frame);
    const fast = capture(() => r.render('fast'));
    await settle(2);
    // ARM B: the same frame, rebuilt.
    if (G.invalidate) G.invalidate();
    const fresh = capture(() => r.render('fresh'));
    await settle(2);

    for (const k of names) if (saved[k]) proto[k] = saved[k];

    // ---- AND THE PALETTE, WHICH A BUILD RE-RESOLVES AND A FAST FRAME DOES
    // NOT. makeResident calls setPalette(paletteSource()) on every rebuild;
    // updateStations does not, so a colour the ribbon resolves per frame - the
    // ss palette, and the per-residue overrides - is whatever the last build
    // worked out. Every uniform and every draw call above is identical between
    // the two arms, so what is left is the CONTENT of a texture, and this is
    // the one nothing refreshes.
    const shot = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const pxDiff = (a, b) => {
      let moved = 0; let worst = 0;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k += 1) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
        if (d > 2) moved += 1;
        if (d > worst) worst = d;
      }
      return {moved: +(100 * moved / (a.length / 4)).toFixed(4), worst};
    };
    // the rebuilt frame is still on screen; keep it as the reference
    const ref = shot();
    // back to the fast route for this frame...
    for (let lap = 0; lap < 2; lap += 1) {
      for (let i = 0; i < nF; i += 1) {
        r.setFrame(i); r.render('againL' + lap + '-' + i); await settle(2);
      }
    }
    for (let i = 0; i < frame; i += 1) {
      r.setFrame(i); r.render('again' + i); await settle(2);
    }
    r.setFrame(frame); r.render('againFast'); await settle(3);
    const fastPx = shot();
    // ...and now repaint the palette without rebuilding anything else
    if (G.recolour) G.recolour();
    r.render('repaint'); await settle(3);
    const afterPal = shot();
    // 🔴 AND THE REFERENCE ITSELF, BUILT THE WAY outline_sync BUILDS IT.
    // That file rebuilds every frame in sequence and compares frame 8 of that
    // walk; this rebuilds frame 8 alone. If the two references differ, what it
    // reports is drift on the REFERENCE side and not on the fast path - and
    // the comparison has been accusing the wrong arm.
    for (let i = 0; i <= frame; i += 1) {
      if (G.invalidate) G.invalidate();
      r.setFrame(i); r.render('refwalk' + i); await settle(2);
    }
    const refWalk = shot();
    const palette = {fastVsRef: pxDiff(fastPx, ref),
                     afterPaletteVsRef: pxDiff(afterPal, ref),
                     refWalkVsRef: pxDiff(refWalk, ref),
                     fastVsRefWalk: pxDiff(fastPx, refWalk)};

    let firstAt = -1;
    const n = Math.min(fast.length, fresh.length);
    for (let i = 0; i < n; i += 1) {
      if (fast[i] !== fresh[i]) { firstAt = i; break; }
    }
    const diffs = [];
    for (let i = 0; i < n && diffs.length < 24; i += 1) {
      if (fast[i] !== fresh[i]) diffs.push({at: i, fast: fast[i], fresh: fresh[i]});
    }
    return {file, frame, palette, nFast: fast.length, nFresh: fresh.length,
            firstAt, diffs,
            tailFast: fast.slice(n, n + 6), tailFresh: fresh.slice(n, n + 6)};
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
profile_dir = "/tmp/py2dmol-drawdiff"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_drawdiff.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {FRAME}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])

print(f"  {res['file']} frame {res['frame']}:"
      f" {res['nFast']} GL calls on the fast frame,"
      f" {res['nFresh']} on the rebuilt one")
if res["firstAt"] < 0 and res["nFast"] == res["nFresh"]:
    print("  the two draws are identical, call for call")
else:
    print(f"  first difference at call {res['firstAt']}")
    for d in res["diffs"]:
        print(f"    {d['at']:>5}  fast  {d['fast']}")
        print(f"    {'':>5}  fresh {d['fresh']}")
    if res["nFast"] != res["nFresh"]:
        print(f"  and the sequences are different lengths:"
              f" {res['tailFast']} against {res['tailFresh']}")
pal = res.get("palette")
if pal:
    print(f"  the fast frame differs from the rebuilt one by"
          f" {pal['fastVsRef']['moved']}% (worst {pal['fastVsRef']['worst']})")
    print(f"  ...and after G.recolour() alone, by"
          f" {pal['afterPaletteVsRef']['moved']}%"
          f" (worst {pal['afterPaletteVsRef']['worst']})")
    print(f"  a reference REBUILT IN SEQUENCE differs from one rebuilt alone"
          f" by {pal['refWalkVsRef']['moved']}%"
          f" (worst {pal['refWalkVsRef']['worst']})")
    print(f"  ...and the fast frame differs from THAT one by"
          f" {pal['fastVsRefWalk']['moved']}%"
          f" (worst {pal['fastVsRefWalk']['worst']})")
print()
print("draw diff: " + ("identical" if res["firstAt"] < 0
                       and res["nFast"] == res["nFresh"] else "they differ"))
