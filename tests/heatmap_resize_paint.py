"""A RESIZED CANVAS IS NEVER LEFT CLEARED, BECAUSE AN OPAQUE ONE CLEARS TO
BLACK.

    python3 tests/heatmap_resize_paint.py

`panels/heatmap.js` takes its 2D context with `{ alpha: false }` - honest for a
canvas that paints every pixel - and `updateSize` resizes by assigning
`canvas.width`, which RESETS the backing store. What an opaque context resets
to is not transparent, it is BLACK. The repaint was `scheduleRender()`, a
requestAnimationFrame away, so between the two the panel composited as a black
rectangle.

Reported as the big viewer going black for a brief second when the layout
switches from one slot to two. Every one of those resizes this canvas: the
reveal at the start of a fold, a slot switch, a drag of the divider, a window
resize. Caught on a real headed Chrome by screencasting a live AlphaFold 3 fold
at 30 frames a second - one frame of 592, the big slot 100% black, exactly as
the trunk's contact map took the slot; and 0 of 600 with the paint made
synchronous.

🔴 AND THE GAP IS ONE FRAME ONLY WHEN THE PAGE IS IDLE. During a fold the main
thread is running inference, so the frame the repaint waits for can be hundreds
of milliseconds away. That is why it reads as a second rather than a flicker,
and why a quiet page never shows it.

WHAT THIS ASKS. The resize and the paint have to be ONE act, so the test reads
the canvas at the first moment a browser could composite it: a frame callback
registered BEFORE the resize is triggered. With the paint scheduled, that
callback runs first and sees the cleared canvas; with the paint synchronous, it
cannot - the pixels are already there.

🔴 IT READS THE CANVAS, NOT THE CODE. A check that the source says `render()`
passes against any future path that resizes somewhere else, which is exactly
how this arrived: three call sites resize, and the fault belonged to none of
them - it belonged to the resize itself.
"""
import json, os, sys, shutil, http.server, socketserver, threading, functools

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DEBUG_PORT = 9939, 9940
PROBE = os.path.join(ROOT, "_heatresize.html")

JS = """(async () => {
  //HELPERS
  const t = await (await fetch('/6MRR.cif')).text();
  await window.processFiles([{name: '6MRR.cif', readAsync: () => Promise.resolve(t)}], false);
  await until(loaded, 60000);
  const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
  await until(() => r.coords && r.coords.length > 0, 30000);
  await settle(8);
  // A map, so the panel is on screen with something to draw - the reported
  // case is a contact map taking the big slot during a fold.
  const n = Math.min(r.coords.length, 64);
  const data = new Uint8Array(n * n);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 255;
  const obj = r.objectsData[r.currentObjectName];
  obj.frames[0].maps = { contact: { data, n, vmin: 0, vmax: 1 } };
  if (window.Heatmap && window.Heatmap.updateFrame) window.Heatmap.updateFrame(r, obj, 0);
  r.render('map'); await settle(10);
  const hm = r.heatmapRenderer;
  const box = r.heatmapContainer;
  if (!hm || !box) return JSON.stringify({error: 'no heatmap panel'});
  const cv = hm.canvas;
  const read = () => {
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    c.getContext('2d').drawImage(cv, 0, 0);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let black = 0, n2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      n2++;
      if (d[i] < 16 && d[i + 1] < 16 && d[i + 2] < 16) black++;
    }
    return {black: black / Math.max(1, n2), px: n2, w: c.width};
  };
  const before = read();
  // THE FIRST MOMENT A BROWSER COULD COMPOSITE THE RESIZED CANVAS. Registered
  // BEFORE the resize, so a repaint that waits for its own frame has not run.
  let atFirstFrame = null;
  const seen = new Promise((done) => {
    requestAnimationFrame(() => { atFirstFrame = read(); done(); });
  });
  // ...and the resize itself: the map moves into the BIG slot, which is the
  // reported transition and the thing that resizes this canvas. Styling the
  // box does nothing - the slot owns the size, `!important` (parts/slots.js).
  r.setSlots({big: 'contact', small: 'structure'});
  void box.clientWidth;               // flush the layout so the observer fires
  await seen;
  await settle(6);
  const after = read();
  return JSON.stringify({before, atFirstFrame, after});
})()"""
JS = JS.replace("//HELPERS", HELPERS)

open(PROBE, "w").write(open(os.path.join(ROOT, "dev.html")).read())
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT),
                               functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome = None
try:
    chrome, ws = cdp.launch(DEBUG_PORT, "/tmp/py2dmol-heatresize")
    ws.call("Page.enable"); ws.call("Runtime.enable")
    ws.call("Emulation.setDeviceMetricsOverride", width=1400, height=1000,
            deviceScaleFactor=1, mobile=False)
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_heatresize.html")
    cdp.wait_for(ws, "typeof window.processFiles === 'function'", timeout=120, what="dev.html")
    out = json.loads(cdp.evaluate(ws, JS))
finally:
    if chrome: chrome.kill()
    httpd.shutdown()
    shutil.rmtree("/tmp/py2dmol-heatresize", ignore_errors=True)
    try: os.remove(PROBE)
    except OSError: pass

bad = []
if out.get("error"):
    bad.append(out["error"])
else:
    b, f, a = out["before"], out["atFirstFrame"], out["after"]
    print(f"  before the resize: {b['black']*100:.1f}% black over {b['px']} px ({b['w']}px wide)")
    print(f"  at the first frame after it: {f['black']*100:.1f}% black ({f['w']}px wide)")
    print(f"  once settled: {a['black']*100:.1f}% black ({a['w']}px wide)")
    if b["black"] > 0.5:
        bad.append("the panel was already black BEFORE the resize - this measured nothing")
    if f["w"] == b["w"] and a["w"] == b["w"]:
        bad.append("the canvas was never resized, so the moment this exists for never happened")
    if f["black"] > 0.5:
        bad.append(f"{f['black']*100:.0f}% of the canvas is black at the first frame after a"
                   " resize - an opaque canvas clears to black, and the paint is waiting for"
                   " a frame that a busy page may be hundreds of milliseconds from giving")
    if a["black"] > 0.5:
        bad.append("the panel is still black once settled - it never repainted at all")

for x in bad:
    print("FAIL: " + x)
print("heatmap resize paint: " + ("FAILED" if bad else "a resized panel is painted in the same act"))
sys.exit(1 if bad else 0)
