"""Ghosting a selection: it must change the picture and rebuild nothing.

    python3 tests/opacity.py

WHAT IT IS FOR. A side chain inside the fold is drawn, is in the scene, and is
hidden by the cartoon in front of it from every angle - so reorienting the
camera, which is what people reach for, is not a fix. Reported against a
conference-talk build, where the caller confirmed `sidechains.size === 25` and
still could not see them. The answer is to fade the backbone over it.

🔴 AND IT IS A TEXEL, NOT A MESH, WHICH IS THE WHOLE CLAIM. cartoon/paintgl.js
already keeps one texel per residue that the vertex shader tests every face
against, and the fragment shader already fades the clip slab by DROPPING PIXELS
on an ordered 4x4 dither rather than blending. An opacity composes with the
slab through both: `min(clipCover(z), fade)`. So a fade is one texSubImage2D
per residue - no capture, no geometry, no rebuild - and a gate that only
checked the picture would pass just as well against a version that rebuilt the
mesh on every drag of the slider, which is the thing this port is built not to
do.

WHAT IS MEASURED:

  * a fade CHANGES PIXELS, by a lot, and putting it back restores the picture
    EXACTLY - byte for byte against the frame before it, which is the control
    that says the texel path leaves nothing behind;
  * across the whole sweep the mesh build stamp never moves;
  * 0 hides and 1 is solid, so the two ends still mean what every existing
    caller of that texel meant by them;
  * the OUTLINES stay - a ghosted region is a line drawing over a faded fill,
    which is the look that was chosen, so a region at opacity 0.05 still has
    ink in it. Measured as dark pixels surviving where the fill has gone.
"""
import http.server, json, os, shutil, socketserver, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, '_opacity.html')
PORT, DBG = 9671, 9234

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
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    if (!r.gpuDrewLastFrame) return {skip: 'this browser drew on the CPU path'};

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
    // how much INK is in a box - a dark pixel, whatever the fill did
    // 🔴 THE THRESHOLD IS MEASURED, NOT PICKED. The first one here was "under
    // 90 in every channel", which found ONE pixel in the whole drawing and so
    // made the outline check below pass by finding nothing. This is a paper
    // drawing in pastels: its darkest pixels sit at a luminance around 70 and
    // the bulk of the structure between 100 and 160, printed by the histogram
    // beside every row so the constant can be re-checked rather than trusted.
    const ink = (d) => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4)
        if ((d[i] * 299 + d[i+1] * 587 + d[i+2] * 114) / 1000 < 160) n += 1;
      return n;
    };
    // ...and the distribution behind that threshold, because a constant picked
    // by eye is how a check comes to pass by finding nothing
    const hist = (d) => {
      const h = new Array(8).fill(0);
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] * 299 + d[i+1] * 587 + d[i+2] * 114) / 1000;
        h[Math.min(7, Math.floor(l / 32))] += 1;
      }
      return h;
    };
    const stamp = () => {
      const R = window.__rebuild;
      return (R && R.t0 !== undefined) ? R.t0 : -1;
    };

    // HALF THE CHAIN, so there is something faded and something not - a whole
    // structure at one opacity cannot tell a per-residue texel from a global
    // uniform, and this port has no global one to confuse it with.
    const n = r.coords.length;
    const half = [];
    for (let i = 0; i < Math.floor(n / 2); i += 1) half.push(i);

    await settle(4);
    const solid = shot();
    const builds = [stamp()];
    const steps = [];
    // ...AND ONE ARM THAT FADES EVERYTHING, which is the only way to ask what
    // is left when the fills are gone. Half the chain faded leaves the other
    // half's ink in the frame, so the outline question cannot be answered from
    // it - the drawing would look the same whether or not the ghosted half
    // kept a single line.
    for (const a of [0.6, 0.3, 0.05, 0.0, 1.0, 'all0']) {
      if (a === 'all0') r.setOpacity(null, 0);
      else r.setOpacity({positions: half}, a);
      r.render();
      await settle(3);
      const d = shot();
      builds.push(stamp());
      steps.push({a, changed: diff(solid, d), ink: ink(d), hist: hist(d)});
    }
    // 🔴 AND WHETHER THOSE SURVIVING PIXELS ARE THE OUTLINES, asked rather
    // than assumed. A fraction left over after the fills go could be
    // antialiasing, a shadow, anything - so the same all-faded frame is drawn
    // AGAIN with the outline width at zero. If what remains is ink, this arm
    // is very nearly blank paper; if it is not, the two arms agree and the
    // check above was reading something else.
    const keptW = r.relativeOutlineWidth;
    r.relativeOutlineWidth = 0;
    if (r.invalidateMesh) r.invalidateMesh();
    r.render();
    await settle(4);
    const noInk = ink(shot());
    r.relativeOutlineWidth = keptW;
    r.setOpacity(null, 1);
    if (r.invalidateMesh) r.invalidateMesh();
    r.render();
    await settle(4);
    const back = shot();
    return {
      positions: n, faded: half.length,
      solidInk: ink(solid), solidHist: hist(solid),
      steps,
      restored: diff(solid, back), allZeroNoOutline: noInk,
      rebuilt: new Set(builds).size - 1,
      sawStamp: builds[0] !== -1,
    };
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
chrome, ws = launch(DBG, "/tmp/py2dmol-opacity")
try:
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_opacity.html")
    wait_for(ws, "window.__ready === true", timeout=90, what="the page")
    R = json.loads(evaluate(ws, "window.__go().then(JSON.stringify)"))
finally:
    chrome.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree("/tmp/py2dmol-opacity", ignore_errors=True)

if R.get('error'):
    sys.exit("page error: " + R['error'])
if R.get('skip'):
    print("opacity: skipped - " + R['skip'])
    sys.exit(0)

bad = []
print(f"  {R['positions']} positions, {R['faded']} of them faded,"
      f" solid ink {R['solidInk']} px")
for s in R['steps']:
    print(f"    opacity {str(s['a']):<5} {s['changed']:>7} px differ, ink {s['ink']:>6}")
print(f"  solid histogram (luminance bands of 32): {R['solidHist']}")
for s in R['steps']:
    print(f"    {str(s['a']):<5} {s['hist']}")
print(f"  all faded: {R['steps'][-1]['ink']} ink px, and"
      f" {R['allZeroNoOutline']} with the outlines off")
print(f"  restored to {R['restored']} px difference, mesh rebuilt {R['rebuilt']}x")

if not R.get('sawStamp'):
    bad.append("there is no window.__rebuild stamp on this page, so the"
               " rebuild count below means nothing")
if R['rebuilt'] != 0:
    bad.append(f"the sweep rebuilt the mesh {R['rebuilt']} time(s) - a fade is"
               " a texel write and must touch no geometry")
by = {s['a']: s for s in R['steps']}
if by[0.6]['changed'] < 1000:
    bad.append(f"opacity 0.6 moved {by[0.6]['changed']} px - it drew"
               " essentially the same picture")
if by[0.05]['changed'] <= by[0.6]['changed']:
    bad.append(f"a heavier fade moved FEWER pixels ({by[0.05]['changed']}"
               f" against {by[0.6]['changed']}) - the value is not reaching"
               " the dither")
if by[0.0]['changed'] <= by[0.05]['changed']:
    bad.append("opacity 0 did not hide more than 0.05 did, so the two ends of"
               " the range do not mean what every caller of that texel means")
# THE INK SURVIVES. The outlines were deliberately left solid; a ghosted
# region is a line drawing over a faded fill, and at 0.05 there must still be
# ink where the fill has gone.
all0 = by['all0']
if all0['ink'] < R['allZeroNoOutline'] * 2:
    bad.append(f"with EVERY residue at opacity 0 there are {all0['ink']} dark"
               f" pixels, against {R['allZeroNoOutline']} for the same frame"
               ' with the outlines turned off - the ink went with the fills,'
               ' which is not the look that was chosen')
if all0['ink'] <= R['allZeroNoOutline'] * 1.5:
    bad.append(f"every residue faded to 0 leaves {all0['ink']} dark pixels with"
               f" outlines on and {R['allZeroNoOutline']} with them off - so"
               ' what survives the fade is not the ink, and the check above is'
               ' reading something else')
if all0['ink'] > R['solidInk'] * 0.9:
    bad.append(f"with every residue at opacity 0 there are still"
               f" {all0['ink']} dark pixels of {R['solidInk']} - the fills did"
               ' not go anywhere, so this is measuring the wrong thing')
if R['restored'] != 0:
    bad.append(f"putting the opacity back to 1 left {R['restored']} px"
               " different from before the sweep - the texel path leaves"
               " something behind")

print()
for b in bad:
    print("FAIL: " + b)
print("opacity: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
