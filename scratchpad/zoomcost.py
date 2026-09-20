"""Where a zoom frame's time goes, on a big structure.

No rebuilds happen during a zoom (measured), so what is left is the per-frame
path: renderApp on the GPU, and whatever the 2D overlay pass does around it.
This times the whole render() and the GPU entry inside it, at two canvas
sizes, on a structure big enough for the difference to matter.

  python3 scratchpad/zoomcost.py 3J3Y.cif --size=1000
"""
import http.server, json, os, re, socketserver, sys, threading, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests"))
from cdp import launch, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_zoomcost.html")
PORT = int(os.environ.get("PORT", "9797"))
CDP = int(os.environ.get("CDPPORT", "9497"))
args = sys.argv[1:]
opt = {a.split("=")[0].lstrip("-"): a.split("=", 1)[1] for a in args if a.startswith("--") and "=" in a}
FILE = next((a for a in args if not a.startswith("--")), "1AOI.cif")
SIZE = opt.get("size", "1000")


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


JS = """(() => { window.__done = null; (async () => {
  const raf = () => new Promise((s) => requestAnimationFrame(s));
  const txt = await (await fetch('/%(file)s')).text();
  await window.processFiles([{name: '%(file)s', readAsync: () => Promise.resolve(txt)}], false);
  const v = window.py2dmol_viewers[Object.keys(window.py2dmol_viewers)[0]];
  const r = v.renderer; window.__r = r;
  for (let k = 0; k < 3000 && !(r.coords && r.coords.length); k++) await raf();
  const el = document.getElementById('canvasContainer');
  el.style.width = '%(size)spx'; el.style.height = '%(size)spx';
  for (let k = 0; k < 90; k++) await raf();

  const G = window.py2dmolCartoonGPU;
  const T = {gpu: 0, gpuN: 0, draw: 0, drawN: 0};
  for (const k of ['render', 'renderTube', 'blit']) {
      const f0 = G[k];
      T[k] = 0; T[k + 'N'] = 0;
      G[k] = function (...a) { const t = performance.now();
          const out = f0.apply(this, a); T[k] += performance.now() - t; T[k + 'N']++; return out; };
  }
  const df0 = r._drawFrame.bind(r);
  r._drawFrame = function (...a) { const t = performance.now();
      const out = df0(...a); T.draw += performance.now() - t; T.drawN++; return out; };

  const builds0 = window.__faceBuilds || 0;
  const frames = [];
  // Zoom the way the wheel does, one render per frame, and time the render
  // ITSELF - a rAF delta would measure the browser's pacing instead.
  for (let i = 0; i < 120; i++) {
      r.viewerState.zoom *= (i < 60 ? 1.01 : 1 / 1.01);
      const t = performance.now();
      r.render();
      frames.push(performance.now() - t);
      await raf();
  }
  const s = frames.slice().sort((a, b) => a - b);
  window.__done = {
      n: r.coords.length, px: r.canvas.width + 'x' + r.canvas.height,
      builds: (window.__faceBuilds || 0) - builds0,
      render: {median: s[60], p90: s[108], worst: s[119], min: s[0]},
      style: r.style, drawStyle: r._drawStyle ? r._drawStyle() : null,
      useGPU: !!r.useGPU, direct: !!(G.directPresent && G.directPresent()),
      per: {render: T.render / 120, renderN: T.renderN,
            tube: T.renderTube / 120, tubeN: T.renderTubeN,
            blit: T.blit / 120, blitN: T.blitN},
      drawPerFrame: T.draw / Math.max(1, T.drawN), drawCalls: T.drawN,
  };
})().catch((e) => { window.__done = {err: String(e) + (e && e.stack || '')}; }); })()"""


def main():
    src = open(os.path.join(ROOT, "dev.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    open(PROBE, "w").write(src)
    httpd = serve(PORT)
    proc, ws = launch(CDP, "/tmp/py2dmol-zoomcost-%d" % os.getpid())
    try:
        ws.call("Page.enable")
        ws.call("Runtime.enable")
        ws.call("Emulation.setDeviceMetricsOverride", width=1400, height=1200,
                deviceScaleFactor=2, mobile=False)
        ws.call("Page.navigate", url="http://127.0.0.1:%d/_zoomcost.html" % PORT)
        wait_for(ws, "typeof window.processFiles === 'function'", 60, "app")
        evaluate(ws, JS % {"file": FILE, "size": SIZE}, False)
        wait_for(ws, "!!window.__done", 1800, "the run")
        out = evaluate(ws, "window.__done")
        print(json.dumps(out, indent=1))
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        httpd.shutdown()
        if os.path.exists(PROBE):
            os.remove(PROBE)


main()
