"""What the gesture scale LOOKS like: the same frame at full and reduced scale.

One page load, one camera, two pictures - so this is a fair comparison in the
one way GPU pixels allow (the painter is not stable across loads).

  python3 scratchpad/scaleshot.py 4HHB.cif --size=600
"""
import base64, http.server, json, os, re, socketserver, sys, threading, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests"))
from cdp import launch, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "scratchpad", "scale")
PROBE = os.path.join(ROOT, "_scaleshot.html")
PORT = int(os.environ.get("PORT", "9787"))
CDP = int(os.environ.get("CDPPORT", "9487"))
args = sys.argv[1:]
opt = {a.split("=")[0].lstrip("-"): a.split("=", 1)[1] for a in args if a.startswith("--") and "=" in a}
FILE = next((a for a in args if not a.startswith("--")), "4HHB.cif")
SIZE = opt.get("size", "600")


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
  window.py2dmolCartoonGPU.setDirectPresent(false);   // read the blit
  const el = document.getElementById('canvasContainer');
  el.style.width = '%(size)spx'; el.style.height = '%(size)spx';
  for (let k = 0; k < 120; k++) await raf();
  const shot = () => r.canvas.toDataURL('image/png');

  r.render('full'); await raf(); await raf();
  const full = shot();
  // the state a gesture puts the viewer in, without a gesture: the latch is
  // what the rule sets, so this is the picture it produces
  r.isZooming = true; r._gestureScaleLatch = 0.5;
  r.render('half'); await raf(); await raf();
  const half = shot();
  r.isZooming = false; r._gestureScaleLatch = 0;
  r.render('full again'); await raf(); await raf();
  const back = shot();
  window.__done = {n: r.coords.length, style: r.style,
      px: r.canvas.width + 'x' + r.canvas.height,
      full: full, half: half, back: back};
})().catch((e) => { window.__done = {err: String(e) + (e && e.stack || '')}; }); })()"""


def main():
    os.makedirs(OUT, exist_ok=True)
    src = open(os.path.join(ROOT, "dev.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    open(PROBE, "w").write(src)
    httpd = serve(PORT)
    proc, ws = launch(CDP, "/tmp/py2dmol-scaleshot-%d" % os.getpid())
    try:
        ws.call("Page.enable")
        ws.call("Runtime.enable")
        ws.call("Emulation.setDeviceMetricsOverride", width=1500, height=1200,
                deviceScaleFactor=2, mobile=False)
        ws.call("Page.navigate", url="http://127.0.0.1:%d/_scaleshot.html" % PORT)
        wait_for(ws, "typeof window.processFiles === 'function'", 60, "app")
        evaluate(ws, JS % {"file": FILE, "size": SIZE}, False)
        wait_for(ws, "!!window.__done", 1800, "the run")
        out = evaluate(ws, "window.__done")
        if out.get("err"):
            raise RuntimeError(out["err"])
        tag = FILE.split(".")[0]
        for which in ("full", "half", "back"):
            b = base64.b64decode(out.pop(which).split(",", 1)[1])
            open(os.path.join(OUT, "%s_%s.png" % (tag, which)), "wb").write(b)
        print(json.dumps(out))
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        httpd.shutdown()
        if os.path.exists(PROBE):
            os.remove(PROBE)


main()
