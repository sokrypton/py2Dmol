"""A focus click that reused the ribbon must draw what a forced rebuild of the
same state draws. The reuse is only legal because the positions come from the
station table; if any of them still come from the kept part, they are a camera
move out of date and this is what says so."""
import json, os, sys, shutil, http.server, socketserver, threading
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp
from probe_js import HELPERS
PROBE = os.path.join(ROOT, "_focuspix.html"); PORT = 9881; DEBUG_PORT = 9882
FILE = sys.argv[1] if len(sys.argv) > 1 else "4HHB.cif"
SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, ink) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], false);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 120000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(12);
    const G = window.py2dmolCartoonGPU;
    if (!ink) { r.outlineMode = 'none'; r.relativeOutlineWidth = 0; }
    if (G.setStationDraw) { G.setStationDraw(true); await settle(8); }
    if (G.invalidate) { G.invalidate(); r.render('reset'); await settle(6); }
    const shot = () => { const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
    const diff = (a, b) => { let m = 0, w = 0;
      for (let i = 0; i < a.length; i += 4) { let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i+k]-b[i+k]));
        if (d > 2) m += 1; if (d > w) w = d; }
      return {moved: +(100*m/(a.length/4)).toFixed(4), worst: w}; };
    const n = r.coords.length;
    const pick = (f) => Math.max(0, Math.min(n - 1, Math.floor(n * f)));
    const out = [];
    r.enterFocusMode(); await settle(6);
    for (const f of [0.25, 0.50, 0.75, 0.25]) {
      // 🔴 A JUMP, NOT A FLIGHT, AND THAT IS WHAT MAKES THIS MEASURABLE.
      // focusOn ANIMATES, so the one build a click costs is taken mid-flight
      // at a camera that is still moving - which is exactly the build whose
      // ribbon this is about, and exactly the build a settled comparison
      // cannot see: wait for the flight to land and BOTH trees reuse, because
      // consecutive builds then share a camera. With the jump the camera is
      // static when the shot is taken and has still MOVED since the previous
      // build, which is the case the key had to learn.
      r.focusOn([pick(f)], {animate: false});
      await settle(8);
      r.render('a'); await settle(2);
      const got = shot();                      // ...whatever the click left
      const reused = !!(window.__rebuild || {}).ribbonReused;
      const er = G.edgeRefresh ? G.edgeRefresh() : null;
      G.invalidate(); r.render('forced'); await settle(2);
      const want = shot();                     // ...and the same state rebuilt
      out.push({at: f, reused, er, d: diff(got, want)});
    }
    r.exitFocusMode(); await settle(6);
    return {ink, out};
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
open(PROBE, "w").write(open(os.path.join(ROOT, "dev.html")).read()
    .replace("</body>", "<script>" + SETUP + "</script></body>"))
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
prof = "/tmp/py2dmol-focuspix"
chrome, ws = cdp.launch(DEBUG_PORT, prof)
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_focuspix.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
for ink in ("true", "false"):
    o = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}, {ink}).then(JSON.stringify)"))
    print(f"  --- outline {'ON' if ink == 'true' else 'OFF'} ---")
    for row in o["out"]:
        print(f"    focus at {row['at']}: ribbonReused={row['reused']}"
              f"  vs a forced rebuild: {row['d']['moved']}% of pixels,"
              f" worst {row['d']['worst']}")
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(prof, ignore_errors=True)
