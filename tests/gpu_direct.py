"""THE GL CANVAS ON THE PAGE, not copied into the viewer's.

    python3 tests/gpu_direct.py

By default (rendering.gpuDirect) the GPU painter puts its canvas into the page as the
sibling before the viewer's, at the same place, and skips the per-frame copy
(cartoon/paintgl.js, direct presentation). The viewer's own canvas goes
transparent and carries only the overlays. What has to hold:

  * the layer is in the page, under the viewer's canvas, the same size, and
    the first canvas in the container is still the viewer's;
  * the ink is on the layer, and the viewer's canvas is clear where it is;
  * a second viewer on the page, without the option, still paints its own
    canvas: one viewer owns the layer, the other keeps the blit;
  * an export renders into its own canvas and still carries the ink;
  * with the GPU switched off the layer hides and the 2D pass paints the
    viewer's canvas itself; switched back on, the layer returns;
  * a hold, which a recording takes, hides the layer and blits the frame
    onto the canvas until it is released;
  * a new viewer built in the old one's container takes the layer over;
  * turning the option off takes the layer out of the page.

THE DEFAULT. When it became one, seventeen probes of this suite failed, each
reading the drawing off the viewer's canvas: they now compose the layer and
the canvas (colab, embed, export_html, python_opacity, render_page) or ask for
the blit through the shared helpers (everything on probe_js.HELPERS), and a
host that reads pixels has the same two choices. The layer sits AFTER the
canvas at z-index -1, marked data-py2dmol-layer, so the first canvas in a
container is still the viewer's.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_gpudirect.html")
PORT = 9957
DEBUG_PORT = 9958

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="direct" style="width:320px;height:240px;position:relative"></div>
<div id="plain" style="width:240px;height:200px"></div>
<script src="py2Dmol/resources/bundles/py2Dmol.embed.min.js"></script>
<script>
window.__ready = false;
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('load', () => {
  //HELPERS
  const G = () => window.py2dmolCartoonGPU;
  // pixels on a canvas that are neither clear nor paper (white or black)
  const ink = (c) => {
    const s = document.createElement('canvas'); s.width = c.width; s.height = c.height;
    const x = s.getContext('2d'); x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, s.width, s.height).data;
    let n = 0, at = null;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const white = d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240, black = d[i] < 15 && d[i + 1] < 15 && d[i + 2] < 15;
      if (!white && !black) { n++; if (!at) at = [(i / 4) % s.width, Math.floor(i / 4 / s.width)]; }
    }
    return { n, at };
  };
  const alphaAt = (c, at) => c.getContext('2d').getImageData(at[0], at[1], 1, 1).data[3];
  const layer = (v) => { const p = v.canvas.nextElementSibling; return p && p.tagName === 'CANVAS' ? p : null; };
  const rect = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
  window.__go = async (text) => {
    try {
      const out = { steps: {} };
      // the shared helpers above ask for the blit, as every other probe reads pixels; this one is about the layer
      G().setDirectPresent(true);
      const a = py2Dmol.show(document.getElementById('direct'), text, { rendering: { gpuDirect: true } });
      const b = py2Dmol.show(document.getElementById('plain'), text, {});
      await until(() => a.coords && a.coords.length && b.coords && b.coords.length, 20000);
      a.render('warm'); b.render('warm'); await settle(6);
      // 1. the layer, under a's canvas, the same size; the first canvas in the
      //    container is still a's
      const L = layer(a);
      out.steps.firstCanvas = document.querySelector('#direct canvas') === a.canvas;
      out.steps.state = G().directPresent();
      // the layer covers the canvas's content box: inside its border
      const ar = a.canvas.getBoundingClientRect();
      out.steps.layer = !!L; out.steps.aRect = [ar.left + a.canvas.clientLeft, ar.top + a.canvas.clientTop, a.canvas.clientWidth, a.canvas.clientHeight].map(Math.round); out.steps.layerRect = L ? rect(L) : null;
      out.steps.layerDisplay = L ? getComputedStyle(L).display : null;
      // 2. ink on the layer, a's canvas clear there; b paints its own canvas
      const li = L ? ink(L) : { n: 0, at: null };
      out.steps.layerInk = li.n; out.steps.aInkOwn = ink(a.canvas).n;
      out.steps.aAlphaAtInk = li.at ? alphaAt(a.canvas, li.at) : null;
      out.steps.bInkOwn = ink(b.canvas).n; out.steps.bLayer = !!layer(b);
      out.steps.aCssBackground = a.canvas.style.background;
      // 3. an export renders into its own canvas, and carries the ink
      const ex = document.createElement('canvas'); ex.width = 300; ex.height = 220;
      a._renderToContext(ex.getContext('2d'), 300, 220);
      out.steps.exportInk = ink(ex).n;
      // ...and the screen is untouched by it
      out.steps.afterExport = G().directPresent();
      // 4. the GPU off: the layer hides and a paints its own canvas
      a.useGPU = false; if (G().invalidate) G().invalidate(); a.render('off'); await settle(4);
      out.steps.offState = G().directPresent(); out.steps.offDisplay = L ? getComputedStyle(L).display : null;
      out.steps.offInkOwn = ink(a.canvas).n;
      // 5. back on: the layer returns and a's canvas clears again
      a.useGPU = true; if (G().invalidate) G().invalidate(); a.render('on'); await settle(4);
      out.steps.onState = G().directPresent(); out.steps.onDisplay = L ? getComputedStyle(L).display : null;
      out.steps.onInkOwn = ink(a.canvas).n; out.steps.onLayerInk = L ? ink(L).n : 0;
      // 6. a hold, as a recording takes: the layer hides and the frame is blitted
      //    onto the canvas; released, the layer returns
      const unhold = G().holdDirect(); a.render('held'); await settle(4);
      out.steps.held = G().directPresent(); out.steps.heldDisplay = L ? getComputedStyle(L).display : null; out.steps.heldInkOwn = ink(a.canvas).n;
      unhold(); a.render('unheld'); await settle(4);
      out.steps.unheld = G().directPresent(); out.steps.unheldInkOwn = ink(a.canvas).n;
      // 7. a new viewer in the same container (show() replaces the children, so
      //    a's canvas leaves the page): the layer goes to the newcomer
      const a2 = py2Dmol.show(document.getElementById('direct'), text, { rendering: { gpuDirect: true } });
      await until(() => a2.coords && a2.coords.length, 20000); a2.render('warm'); await settle(6);
      const L2 = layer(a2);
      out.steps.handover = G().directPresent(); out.steps.handoverLayer = !!L2 && L2 !== null; out.steps.handoverInk = L2 ? ink(L2).n : 0;
      out.steps.handoverOwnInk = ink(a2.canvas).n; out.steps.oldInPage = a.canvas.isConnected;
      // 8. the option off: the layer leaves the page and the viewer paints its own canvas
      G().setDirectPresent(false); a2.render('plain'); await settle(4);
      out.steps.released = G().directPresent(); out.steps.layerInPage = !!(L && L.parentNode);
      out.steps.releasedInkOwn = ink(a2.canvas).n; out.steps.releasedCssBackground = a2.canvas.style.background;
      out.errors = window.__errors;
      return out;
    } catch (e) { return { error: String((e && e.stack) || e) }; }
  };
  window.__ready = true;
});
</script></body></html>"""
open(PROBE, "w").write(PAGE.replace("//HELPERS", HELPERS))
TEXT = open(os.path.join(ROOT, "GABARAP_P3.pdb")).read()


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-gpudirect"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_gpudirect.html")
cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
res = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(TEXT)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])
S = res["steps"]
for k, v in S.items():
    print(f"  {k:>22}: {json.dumps(v)}")
bad = []
if not (S["layer"] and S["state"]["shown"] and S["state"]["inPage"]):
    bad.append("the layer is not in the page under the viewer's canvas")
if not S["firstCanvas"]:
    bad.append("the first canvas in the container is the layer, not the viewer's")
if S["layerRect"] != S["aRect"]:
    bad.append(f"the layer is not where the viewer's canvas is: {S['layerRect']} against {S['aRect']}")
if S["layerInk"] < 200:
    bad.append(f"the layer carries no drawing ({S['layerInk']} ink pixels)")
if S["aAlphaAtInk"] != 0:
    bad.append(f"the viewer's canvas is not clear over the drawing (alpha {S['aAlphaAtInk']})")
if S["aCssBackground"] != "transparent":
    bad.append(f"the viewer's canvas keeps a CSS background over the layer: {S['aCssBackground']!r}")
if S["bInkOwn"] < 200 or S["bLayer"]:
    bad.append("the second viewer, without the option, did not paint its own canvas through the blit")
if S["exportInk"] < 200:
    bad.append(f"an export lost the drawing ({S['exportInk']} ink pixels)")
if not S["afterExport"]["shown"]:
    bad.append("an export took the layer off the screen")
if S["offDisplay"] != "none" or S["offInkOwn"] < 200:
    bad.append("with the GPU off the layer is still showing, or the 2D pass did not paint the canvas")
if S["onDisplay"] == "none" or S["onLayerInk"] < 200 or S["onInkOwn"] > 50:
    bad.append("with the GPU back on the layer did not return, or the canvas kept the 2D drawing over it")
if S["held"]["holds"] != 1 or S["heldDisplay"] != "none" or S["heldInkOwn"] < 200:
    bad.append("held, as for a recording, the layer did not hide or the frame was not blitted onto the canvas")
if S["unheld"]["holds"] != 0 or not S["unheld"]["shown"] or S["unheldInkOwn"] > 50:
    bad.append("released, the layer did not come back")
if S["oldInPage"] or not (S["handover"]["shown"] and S["handoverLayer"]) or S["handoverInk"] < 200 or S["handoverOwnInk"] > 50:
    bad.append("a new viewer in the old one's container did not take the layer over")
if S["layerInPage"] or S["released"]["on"] or S["releasedInkOwn"] < 200:
    bad.append("with the option off the layer stayed in the page, or the blit did not resume")
if res["errors"]:
    bad.append("page errors: " + "; ".join(res["errors"])[:300])
print()
for b in bad:
    print("FAIL: " + b)
print("gpu direct: " + ("FAILED" if bad else "the layer under the canvas, no copy, and every fall-back holds"))
sys.exit(1 if bad else 0)
