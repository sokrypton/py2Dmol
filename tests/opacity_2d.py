"""Ghosting a selection on the 2D PAINTER: a crossfade of two whole frames.

    python3 tests/opacity_2d.py

tests/opacity.py is the GPU half and skips here; this is the other one. The 2D
painter had no fade at all - setOpacity drew at full strength, and a 0 that
hides on the GPU drew solid - and every host that loads both painters without
asking for the GPU (the website's full bundle, LocalFold) is on this path.

core/mol.js's _renderGhosted draws the frame twice, once without the faded
positions and once with them, and lays the second over the first at the fade's
alpha. That makes the answer EXACT and checkable pixel by pixel:

    frame(a) = (1 - a) * frame(hidden) + a * frame(solid)

where frame(hidden) is the same selection at opacity 0 and frame(solid) is
everything at 1. A per-primitive alpha - the obvious implementation, and the
one cartoon/paint2d.js's "PAINT GOES DOWN OPAQUE" warns about - fails it,
because overlapping quads double up. So does a fade that reaches the fills and
not the outlines.

WHAT IS MEASURED, in cartoon and in tube:

  * a fade at 0.5 changes many pixels, and every pixel is the blend above to
    within two units (8-bit alpha rounds);
  * 0 hides: the faded half is gone, not drawn solid;
  * putting it back to 1 restores the solid frame byte for byte;
  * an SVG export carries the second frame inside one `<g opacity>`.
"""
import http.server, json, os, shutil, socketserver, sys, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, '_opacity_2d.html')
PORT, DBG = 9673, 9236

JS = """
<script>
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async () => {
   try {
    const txt = await (await fetch('/1UBQ.cif')).text();
    await window.processFiles([{name: '1UBQ.cif',
        readAsync: () => Promise.resolve(txt)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    r.useGPU = false;
    const cv = document.querySelector('#canvas');
    const shot = () => {
      const c = document.createElement('canvas');
      c.width = cv.width; c.height = cv.height;
      c.getContext('2d').drawImage(cv, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4)
        if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) n += 1;
      return n;
    };
    // the worst channel's distance from the crossfade of the two ends
    const blendError = (got, hidden, solid, a) => {
      let worst = 0, off = 0;
      for (let i = 0; i < got.length; i += 4) {
        for (let k = 0; k < 3; k++) {
          const want = (1 - a) * hidden[i + k] + a * solid[i + k];
          const e = Math.abs(got[i + k] - want);
          if (e > worst) worst = e;
          if (e > 2) { off += 1; break; }
        }
      }
      return {worst: +worst.toFixed(2), off};
    };
    const n = r.coords.length;
    const half = [];
    for (let i = 0; i < Math.floor(n / 2); i += 1) half.push(i);
    const frame = async (alpha) => {
      r.setOpacity(null, 1);
      if (alpha !== 1) r.setOpacity({positions: half}, alpha);
      r.render(); await settle(4);
      return shot();
    };
    const arm = async (style) => {
      if (r.setStyle) r.setStyle(style); else r.style = style;
      await settle(10);
      const solid = await frame(1);
      const gpu = r.gpuDrewLastFrame;
      const hidden = await frame(0);
      const half5 = await frame(0.5);
      const quarter = await frame(0.25);
      const back = await frame(1);
      return {
        style, gpu,
        hidMoved: diff(solid, hidden),
        halfMoved: diff(solid, half5),
        half: blendError(half5, hidden, solid, 0.5),
        quarter: blendError(quarter, hidden, solid, 0.25),
        restored: diff(solid, back),
      };
    };
    const arms = [await arm('cartoon'), await arm('tube')];
    // ...and the vector export, which has no second canvas to blend from
    if (r.setStyle) r.setStyle('cartoon');
    await settle(6);
    r.setOpacity({positions: half}, 0.5);
    const w = r.displayWidth || cv.width, h = r.displayHeight || cv.height;
    const svgOf = () => {
      const c = new C2S(w, h);
      r._renderToContext(c, w, h);
      return c.getSerializedSvg();
    };
    const faded = svgOf();
    r.setOpacity(null, 1);
    const plain = svgOf();
    return {arms, positions: n, faded: half.length,
      svgGroups: (faded.match(/<g opacity="0\\.500">/g) || []).length,
      svgClosed: (faded.match(/<\\/g>/g) || []).length
        - (plain.match(/<\\/g>/g) || []).length,
      svgPlainGroups: (plain.match(/<g opacity=/g) || []).length};
   } catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__ready = true;
});
</script>
"""
open(PROBE, 'w').write(open(os.path.join(ROOT, 'dev.html')).read()
                       .replace('</body>', JS.replace('//HELPERS', HELPERS) + '</body>'))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome, ws = launch(DBG, "/tmp/py2dmol-opacity-2d")
try:
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_opacity_2d.html")
    wait_for(ws, "window.__ready === true", timeout=90, what="the page")
    R = json.loads(evaluate(ws, "window.__go().then(JSON.stringify)"))
finally:
    chrome.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree("/tmp/py2dmol-opacity-2d", ignore_errors=True)

if R.get('error'):
    sys.exit("page error: " + R['error'])

bad = []
print(f"  {R['positions']} positions, {R['faded']} of them faded")
for a in R['arms']:
    print(f"  {a['style']:<8} hidden moves {a['hidMoved']:>6} px, 0.5 moves"
          f" {a['halfMoved']:>6}; off the blend: 0.5 worst {a['half']['worst']}"
          f" ({a['half']['off']} px), 0.25 worst {a['quarter']['worst']}"
          f" ({a['quarter']['off']} px); restored to {a['restored']} px")
    if a['gpu']:
        bad.append(f"{a['style']}: the GPU drew this frame, so the 2D path was"
                   " not measured")
    if a['hidMoved'] < 1000:
        bad.append(f"{a['style']}: opacity 0 moved {a['hidMoved']} px - the"
                   " faded half was drawn anyway")
    if a['halfMoved'] < 1000:
        bad.append(f"{a['style']}: opacity 0.5 moved {a['halfMoved']} px - the"
                   " fade is not reaching the picture")
    for k in ('half', 'quarter'):
        if a[k]['off']:
            bad.append(f"{a['style']}: at {k} opacity {a[k]['off']} px are off"
                       f" the crossfade by up to {a[k]['worst']} - that is not"
                       " one frame seen through another")
    if a['restored']:
        bad.append(f"{a['style']}: back at 1 the frame is {a['restored']} px"
                   " from where it started")
print(f"  svg: {R['svgGroups']} faded group(s), {R['svgClosed']} extra closing"
      f" tag(s); {R['svgPlainGroups']} with nothing faded")
if R['svgGroups'] != 1 or R['svgClosed'] != 1:
    bad.append("the SVG export does not carry the faded frame in one group")
if R['svgPlainGroups']:
    bad.append("an SVG with nothing faded grew an opacity group")

print()
for b in bad:
    print("FAIL: " + b)
print("opacity_2d: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
