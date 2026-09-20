"""Two levers on a GPU-bound zoom, measured against an unchanged control.

The zoom frame costs the MAIN THREAD 0.6 ms on 3J3Y (271,425 positions) and
still lands at 30 fps in a 1996x1996 canvas, so the cost is the card's: the
question is only what to stop asking it for. Two candidates, each switched on
from outside the source so the arms differ in one thing:

  --aa=0    the GL context without `antialias: true` (MSAA on the default
            framebuffer, at four million pixels)
  --dpr=1   the backing store at one device pixel per CSS pixel instead of two

The instrument is rAF DELTAS, not a timer around render(): the main thread is
idle here, so what a stall looks like is the browser holding the next frame
back. Headed Chrome, because the compositor is the thing being measured.

  python3 scratchpad/zoomlevers.py 3J3Y.cif --size=1000 [--aa=0] [--dpr=1]
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys
import threading, time, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests"))
from cdp import WS, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_zoomlevers.html")
PORT = int(os.environ.get("PORT", "9795"))
CDP = int(os.environ.get("CDPPORT", "9495"))
args = sys.argv[1:]
opt = {a.split("=")[0].lstrip("-"): a.split("=", 1)[1] for a in args if a.startswith("--") and "=" in a}
FILE = next((a for a in args if not a.startswith("--")), "1AOI.cif")
SIZE = opt.get("size", "1000")
AA = opt.get("aa", "1") != "0"
DPR = opt.get("dpr")


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


def launch_headed(port, profile):
    subprocess.run(["pkill", "-9", "-f", "user-data-dir=" + profile],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(profile, ignore_errors=True)
    p = subprocess.Popen(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
        "--window-size=1600,1300", "--window-position=20,20",
        "--remote-debugging-port=%d" % port, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + 30
    while time.time() < end:
        try:
            js = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port))
            for t in js:
                if t.get("type") == "page":
                    return p, WS(t["webSocketDebuggerUrl"])
        except Exception:
            time.sleep(0.3)
    p.kill()
    raise RuntimeError("no CDP target")


# Installed BEFORE the page's scripts: the GL context is made once, on the
# first cartoon frame, and cannot be re-made afterwards.
PRE = """
window.__aa = %(aa)s; window.__dprCap = %(dpr)s;
window.__noShadow = %(nosh)s; window.__noOutline = %(noout)s;
(() => {
  const g0 = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (!window.__aa && type === 'webgl2' && attrs) attrs = Object.assign({}, attrs, {antialias: false});
      return g0.call(this, type, attrs);
  };
  if (window.__dprCap) {
      Object.defineProperty(window, 'devicePixelRatio',
          {get: () => window.__dprCap, configurable: true});
  }
})();
"""

JS = """(() => { window.__done = null; (async () => {
  const raf = () => new Promise((s) => requestAnimationFrame(s));
  const txt = await (await fetch('/%(file)s')).text();
  await window.processFiles([{name: '%(file)s', readAsync: () => Promise.resolve(txt)}], false);
  const v = window.py2dmol_viewers[Object.keys(window.py2dmol_viewers)[0]];
  const r = v.renderer; window.__r = r;
  for (let k = 0; k < 3000 && !(r.coords && r.coords.length); k++) await raf();
  const el = document.getElementById('canvasContainer');
  el.style.width = '%(size)spx'; el.style.height = '%(size)spx';
  for (let k = 0; k < 120; k++) await raf();

  if (window.__noShadow) { r.shadowEnabled = false; }
  if (window.__noOutline) { r.relativeOutlineWidth = 0; }
  for (let k = 0; k < 30; k++) { r.render(); await raf(); }
  const builds0 = window.__faceBuilds || 0; const tb0 = window.__tubeBuilds || 0;
  const cpu = [], gap = [];
  let last = performance.now();
  for (let i = 0; i < 150; i++) {
      r.isZooming = true;
      r.viewerState.zoom *= (i < 75 ? 1.01 : 1 / 1.01);
      const t0 = performance.now();
      r.render();
      cpu.push(performance.now() - t0);
      await raf();
      const now = performance.now();
      gap.push(now - last); last = now;
  }
  const G = window.py2dmolCartoonGPU;
  const probe = document.createElement('canvas').getContext('webgl2');
  const info = {ext: !!(probe && probe.getExtension('EXT_disjoint_timer_query_webgl2')),
                gpuMs: G.gpuFrameMs ? G.gpuFrameMs() : 'absent',
                latch: r._gestureScaleLatch || 0, zooming: !!r.isZooming,
                has: typeof r._gestureScale,
                direct: G.directPresent ? String(G.directPresent()) : '?',
                call: typeof r._gestureScale === 'function' ? r._gestureScale() : 'none'};
  const st = (a) => { const s = a.slice(15).sort((x, y) => x - y);
      return {median: +s[s.length >> 1].toFixed(2), p90: +s[Math.floor(s.length * 0.9)].toFixed(2),
              worst: +s[s.length - 1].toFixed(2), over20: s.filter((v) => v > 20).length,
              over33: s.filter((v) => v > 33).length, n: s.length}; };
  const gl = r.canvas.parentNode && r.canvas.parentNode.querySelector('canvas[data-py2dmol-layer]');
  window.__done = {n: r.coords.length, style: r.style, dpr: window.devicePixelRatio,
      px: r.canvas.width + 'x' + r.canvas.height,
      glPx: gl ? gl.width + 'x' + gl.height : null,
      tubeBuilds: (window.__tubeBuilds||0) - tb0, aa: window.__aa, shadow: r.shadowEnabled !== false, outline: r.relativeOutlineWidth, builds: (window.__faceBuilds || 0) - builds0,
      cpu: st(cpu), frame: st(gap), info: info};
})().catch((e) => { window.__done = {err: String(e) + (e && e.stack || '')}; }); })()"""


def main():
    src = open(os.path.join(ROOT, "dev.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    pre = PRE % {"aa": "true" if AA else "false", "dpr": DPR or "0",
                 "nosh": "true" if opt.get("shadow") == "0" else "false",
                 "noout": "true" if opt.get("outline") == "0" else "false"}
    src = src.replace("<head>", "<head><script>" + pre + "</script>", 1)
    open(PROBE, "w").write(src)
    httpd = serve(PORT)
    proc, ws = launch_headed(CDP, "/tmp/py2dmol-zoomlev-%d" % os.getpid())
    try:
        ws.call("Page.enable")
        ws.call("Runtime.enable")
        ws.call("Page.navigate", url="http://127.0.0.1:%d/_zoomlevers.html" % PORT)
        wait_for(ws, "typeof window.processFiles === 'function'", 60, "app")
        evaluate(ws, JS % {"file": FILE, "size": SIZE}, False)
        wait_for(ws, "!!window.__done", 1800, "the run")
        print(json.dumps(evaluate(ws, "window.__done")))
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        httpd.shutdown()
        if os.path.exists(PROBE):
            os.remove(PROBE)


main()
