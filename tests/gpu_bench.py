"""Per-pass GPU timings for the tube path, on the real GPU, from the shell.

    python3 tests/gpu_bench.py 4UG0.cif
    python3 tests/gpu_bench.py 3J3Q.cif --frames 16 --png out.png

Why it exists: a WebGL draw call returns when it is QUEUED, so timing
`renderer.render()` with performance.now() measures the submit and nothing
else - it reported 0.28 ms for a frame the GPU spent 13.6 ms on. The numbers
here come from EXT_disjoint_timer_query_webgl2, which the renderer emits when
`window.__gpuTimers` is set (see the timer block in viewer-cartoon-gpu.js).

Two traps this works around, both of which cost a whole session's numbers once:

  - HEADLESS CHROME WITH --virtual-time-budget FREEZES performance.now(), and
    without it --dump-dom will not wait for async work. So the page POSTs its
    result back to the same server instead, and the run takes as long as it
    takes. Real clock, real GPU (ANGLE Metal on this machine, which the result
    reports - a software rasteriser has the opposite vertex/fragment balance
    and its timings mean nothing here).
  - A ?v= ON THE PAGE URL DOES NOT REFETCH ITS SCRIPTS. Every local script src
    is stamped, per run, or you measure the previous build.
"""
import argparse, base64, http.server, json, os, re, shutil, socketserver
import subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_gpu_bench.html")

PAGE_JS = """
<script>
window.addEventListener('load', () => {
  const P = new URLSearchParams(location.search);
  const go = async () => {
    const R = {};
    try {
      const gc = document.createElement('canvas').getContext('webgl2');
      const dbg = gc && gc.getExtension('WEBGL_debug_renderer_info');
      R.renderer = dbg ? gc.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?';
      const cif = P.get('cif');
      const txt = await (await fetch('/' + cif)).text();
      await window.processFiles([{name: cif, readAsync: () => Promise.resolve(txt)}], false);
      window.__gpuTimers = true;
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.setStyle('tube');
      r.useGPU = true;
      r.render('warm');
      await new Promise((s) => setTimeout(s, 300));
      R.segments = r.segmentIndices ? r.segmentIndices.length : -1;
      R.canvas = r.canvas.width;
      R.gpuError = String(window.__gpuLastError || '');
      const spin = (deg) => {
        const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
        const Y = [[c,0,s],[0,1,0],[-s,0,c]], A = r.viewerState.rotation;
        const O = [[0,0,0],[0,0,0],[0,0,0]];
        for (let i=0;i<3;i++) for (let j=0;j<3;j++) for (let k=0;k<3;k++)
          O[i][j] += Y[i][k] * A[k][j];
        r.viewerState.rotation = O;
      };
      for (let k = 0; k < Number(P.get('frames') || 20); k++) { spin(2); r.render('bench'); }
      for (let k = 0; k < 6; k++) { r.render('drain'); await new Promise((s) => setTimeout(s, 60)); }
      R.gpuMs = window.__gpuTimes || null;
      if (P.get('png') === '1') R.png = r.canvas.toDataURL('image/png');
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""


def build_probe():
    src = open(os.path.join(ROOT, "index.html")).read()
    stamp = str(int(time.time() * 1000))
    src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
                 lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
    open(PROBE, "w").write(src.replace("</body>", PAGE_JS + "</body>"))


def serve(port, box):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=ROOT, **k)
        def log_message(self, *a):
            pass
        def do_POST(self):
            box.append(json.loads(self.rfile.read(
                int(self.headers.get("Content-Length", 0)))))
            self.send_response(200); self.send_header("Content-Length", "2")
            self.end_headers(); self.wfile.write(b"ok")
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cif", help="a .cif in the repo root, e.g. 4UG0.cif")
    ap.add_argument("--frames", type=int, default=20)
    ap.add_argument("--port", type=int, default=8931)
    ap.add_argument("--png", help="also save the last frame here")
    ap.add_argument("--timeout", type=int, default=300)
    a = ap.parse_args()
    if not os.path.exists(CHROME):
        sys.exit("Google Chrome not found at " + CHROME)
    build_probe()
    box = []
    httpd = serve(a.port, box)
    url = (f"http://127.0.0.1:{a.port}/_gpu_bench.html?cif={a.cif}"
           f"&frames={a.frames}" + ("&png=1" if a.png else ""))
    proc = subprocess.Popen(
        [CHROME, "--headless=new", f"--user-data-dir=/tmp/py2dmol-bench-{os.getpid()}",
         "--no-first-run", "--disable-extensions", "--window-size=1200,1200", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + a.timeout
    while not box and time.time() < deadline:
        time.sleep(0.5)
    proc.kill(); httpd.shutdown()
    shutil.rmtree(f"/tmp/py2dmol-bench-{os.getpid()}", ignore_errors=True)
    try:
        os.remove(PROBE)
    except OSError:
        pass
    if not box:
        sys.exit("no result posted within %ds" % a.timeout)
    R = box[0]
    if R.get("error"):
        sys.exit("page error: " + R["error"])
    png = R.pop("png", None)
    if png and a.png:
        open(a.png, "wb").write(base64.b64decode(png.split(",", 1)[1]))
    print(f"{a.cif}: {R.get('segments')} segments, {R.get('canvas')} px, "
          f"{R.get('renderer')}")
    if R.get("gpuError"):
        print("  GPU PATH DECLINED:", R["gpuError"])
    total = 0.0
    for name in sorted((R.get("gpuMs") or {})):
        acc = R["gpuMs"][name]
        total += acc["mean"]
        print(f"  {name:<12} {acc['mean']:7.3f} ms   (last {acc['last']:.3f}, n={acc['n']})")
    print(f"  {'TOTAL':<12} {total:7.3f} ms")


if __name__ == "__main__":
    main()
