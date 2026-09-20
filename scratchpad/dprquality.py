"""What the resolution buys, in pixels a reader can look at and in milliseconds.

The canvas is UNCAPPED device pixels (parts/viewport.js: a 1.5x cap was removed
when the GPU took the drawing over) AND the GL context asks for
`antialias: true`. On a retina display that is four device pixels per CSS pixel,
each of them multisampled - so the question this answers is whether the second
of those is buying anything on top of the first.

Each arm is its own page load with one thing changed, and each writes the SAME
picture twice: at its own device resolution, and downsampled to the CSS box,
which is what a reader actually sees. The comparison is on the second.

  python3 scratchpad/dprquality.py 4HHB.cif --size=500
"""
import base64, http.server, json, os, re, shutil, socketserver, subprocess, sys
import threading, time, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests"))
from cdp import WS, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "scratchpad", "dpr")
PROBE = os.path.join(ROOT, "_dprq.html")
PORT = int(os.environ.get("PORT", "9789"))
CDP = int(os.environ.get("CDPPORT", "9489"))
args = sys.argv[1:]
opt = {a.split("=")[0].lstrip("-"): a.split("=", 1)[1] for a in args if a.startswith("--") and "=" in a}
FILE = next((a for a in args if not a.startswith("--")), "4HHB.cif")
SIZE = opt.get("size", "500")
# 🔴 THE CONTROL IS AN ARM. GPU pixels are not comparable across page loads -
# this project has measured 110,800 of 357,604 differing between two runs of
# the SAME code - so a second identical arm is what says how much of a diff is
# the change and how much is the machine.
ARMS = [("dpr2_aa", 2, True), ("dpr2_aa_control", 2, True), ("dpr2_noaa", 2, False),
        ("dpr1.5_aa", 1.5, True), ("dpr1_aa", 1, True)]
if os.environ.get("ARMS") == "aa1":
    # THE CASE WHERE MSAA COULD SHOW: one device pixel per CSS pixel, so there
    # is no supersampling underneath it doing the same job.
    ARMS = [("aa1_on", 1, True), ("aa1_on_control", 1, True), ("aa1_off", 1, False)]


def serve(port):
    socketserver.ThreadingTCPServer.allow_reuse_address = True

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=ROOT, **k)

        def log_message(self, *a):
            pass

    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


PRE = """
window.__aa = %(aa)s; window.canvasDPR = %(dpr)s;
(() => { const g0 = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (!window.__aa && type === 'webgl2' && attrs) attrs = Object.assign({}, attrs, {antialias: false});
    return g0.call(this, type, attrs); }; })();
"""

JS = """(() => { window.__done = null; (async () => {
  const raf = () => new Promise((s) => requestAnimationFrame(s));
  const txt = await (await fetch('/%(file)s')).text();
  await window.processFiles([{name: '%(file)s', readAsync: () => Promise.resolve(txt)}], false);
  const v = window.py2dmol_viewers[Object.keys(window.py2dmol_viewers)[0]];
  const r = v.renderer; window.__r = r;
  for (let k = 0; k < 3000 && !(r.coords && r.coords.length); k++) await raf();
  // the picture is on the layer by default; ask for the blit, the way every
  // probe that reads the canvas does (tests/probe_js.py)
  window.py2dmolCartoonGPU.setDirectPresent(false);
  const el = document.getElementById('canvasContainer');
  el.style.width = '%(size)spx'; el.style.height = '%(size)spx';
  for (let k = 0; k < 120; k++) await raf();
  // the camera is whatever the opening orient chose, which is the same in
  // every arm - the structure and the box are the same.
  r.render('settled'); for (let k = 0; k < 10; k++) await raf();

  const compose = (w, h) => { const c = document.createElement('canvas');
    c.width = w; c.height = h; const g = c.getContext('2d');
    g.drawImage(r.canvas, 0, 0, w, h);
    return c; };
  const dev = compose(r.canvas.width, r.canvas.height);
  const css = compose(Math.round(r.displayWidth), Math.round(r.displayHeight));

  // the cost, on the same camera: a spin is what a reader is looking at when
  // they notice a frame rate
  const gap = []; let last = performance.now();
  for (let i = 0; i < 90; i++) { r.viewerState.zoom *= (i < 45 ? 1.01 : 1 / 1.01);
      r.render(); await raf(); const now = performance.now(); gap.push(now - last); last = now; }
  const s = gap.slice(10).sort((a, b) => a - b);
  window.__done = {n: r.coords.length, style: r.style,
      px: r.canvas.width + 'x' + r.canvas.height,
      cssPx: Math.round(r.displayWidth) + 'x' + Math.round(r.displayHeight),
      frame: +s[s.length >> 1].toFixed(2),
      dev: dev.toDataURL('image/png'), css: css.toDataURL('image/png')};
})().catch((e) => { window.__done = {err: String(e) + (e && e.stack || '')}; }); })()"""


def run(tag, dpr, aa):
    src = open(os.path.join(ROOT, "dev.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    src = src.replace("<head>", "<head><script>"
                      + PRE % {"aa": "true" if aa else "false", "dpr": dpr} + "</script>", 1)
    open(PROBE, "w").write(src)
    prof = "/tmp/py2dmol-dprq-%d" % os.getpid()
    subprocess.run(["pkill", "-9", "-f", "user-data-dir=" + prof],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(prof, ignore_errors=True)
    p = subprocess.Popen(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--user-data-dir=" + prof, "--no-first-run", "--no-default-browser-check",
        "--window-size=1400,1100", "--window-position=20,20",
        "--remote-debugging-port=%d" % CDP, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws = None
    end = time.time() + 30
    while time.time() < end and ws is None:
        try:
            js = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % CDP))
            for t in js:
                if t.get("type") == "page":
                    ws = WS(t["webSocketDebuggerUrl"])
        except Exception:
            time.sleep(0.3)
    try:
        ws.call("Page.enable")
        ws.call("Runtime.enable")
        ws.call("Page.navigate", url="http://127.0.0.1:%d/_dprq.html" % PORT)
        wait_for(ws, "typeof window.processFiles === 'function'", 60, "app")
        evaluate(ws, JS % {"file": FILE, "size": SIZE}, False)
        wait_for(ws, "!!window.__done", 1800, "the run")
        out = evaluate(ws, "window.__done")
        if out.get("err"):
            raise RuntimeError(out["err"])
        for which in ("dev", "css"):
            b = base64.b64decode(out.pop(which).split(",", 1)[1])
            open(os.path.join(OUT, "%s_%s.png" % (tag, which)), "wb").write(b)
        return out
    finally:
        p.kill()


def main():
    os.makedirs(OUT, exist_ok=True)
    httpd = serve(PORT)
    rows = {}
    try:
        for tag, dpr, aa in ARMS:
            rows[tag] = run(tag, dpr, aa)
            print(tag, json.dumps(rows[tag]))
    finally:
        httpd.shutdown()
        if os.path.exists(PROBE):
            os.remove(PROBE)

    import numpy as np
    from PIL import Image
    first = ARMS[0][0]
    base = np.asarray(Image.open(os.path.join(OUT, first + "_css.png")).convert("RGB"), float)
    print("\\nagainst %s, at the size a reader sees (%s):" % (first, rows[first]["cssPx"]))
    for tag, _, _ in ARMS[1:]:
        a = np.asarray(Image.open(os.path.join(OUT, "%s_css.png" % tag)).convert("RGB"), float)
        if a.shape != base.shape:
            print("  %-12s different size %s" % (tag, a.shape))
            continue
        d = np.abs(a - base).max(axis=2)
        print("  %-12s mean |d| %5.2f, %5.2f%% of pixels over 8, worst %3.0f, frame %.1f ms"
              % (tag, d.mean(), 100.0 * (d > 8).mean(), d.max(), rows[tag]["frame"]))


main()
