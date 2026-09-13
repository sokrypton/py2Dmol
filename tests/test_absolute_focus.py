"""ABSOLUTE FOCUS TEST: Compares renders before entering focus mode directly against
renders after exiting focus mode at identical camera angles.
"""
import json, os, sys, shutil, http.server, socketserver, threading
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp
from probe_js import HELPERS

PROBE = os.path.join(ROOT, "_abs_focus.html"); PORT = 9911; DEBUG_PORT = 9912
FILE = sys.argv[1] if len(sys.argv) > 1 else "4HHB.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], false);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 120000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(12);

    const shot = () => { const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };

    const cmp = (a, b) => { let miss = 0, extra = 0, w = 0;
      const lit = (d, i) => (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245);
      for (let i = 0; i < a.length; i += 4) {
        const la = lit(a, i), lb = lit(b, i);
        if (!la && lb) miss += 1;
        if (la && !lb) extra += 1;
        let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i+k]-b[i+k]));
        if (d > w) w = d; }
      return {miss, extra, worst: w}; };

    const n = r.coords.length;
    const sc = []; for (let i = Math.floor(n*0.30); i < Math.floor(n*0.42); i++) sc.push(i);

    const camKey = () => { const V = r.viewerState; const c = V.center || {x:0,y:0,z:0};
      return [V.zoom, V.extent, c.x, c.y, c.z, JSON.stringify(V.rotation)].join(','); };

    const camSettle = async () => { let last = null, steady = 0;
      for (let g = 0; g < 400 && steady < 8; g++) { await settle(1);
        const k = camKey(); steady = (k === last) ? steady + 1 : 0; last = k; } };

    const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a);
      return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
    const mul = (A, B) => A.map((row, i) => [0, 1, 2].map((j) =>
      row[0]*B[0][j] + row[1]*B[1][j] + row[2]*B[2][j]));

    const turn = async () => {
      const V = r.viewerState;
      V.rotation = mul(rotY(Math.PI / 4), V.rotation);
      if (r.invalidatePositions) r.invalidatePositions();
      r.render('turn'); await settle(4); r.render('turn2'); await settle(3);
    };

    if (r.showSidechains) r.showSidechains(sc);
    await settle(10);

    // 1. Capture pristine pre-focus control at 8 angles
    const controlShots = [];
    for (let a = 0; a < 8; a++) {
      await turn();
      controlShots.push(shot());
    }

    // 2. Enter focus mode, focus on residue, exit focus mode
    r.enterFocusMode(); await camSettle();
    r.focusOn([Math.floor(n * 0.35)]); await camSettle();
    r.exitFocusMode(); await camSettle();

    if (r.showSidechains) r.showSidechains(sc);
    await settle(10);

    // 3. Now sweep 8 angles after exiting focus mode, without any forced invalidations
    const afterShots = [];
    for (let a = 0; a < 8; a++) {
      await turn();
      afterShots.push(shot());
    }

    // 4. Compare afterShots against pristine controlShots
    const diffs = [];
    for (let a = 0; a < 8; a++) {
      const c = cmp(afterShots[a], controlShots[a]);
      diffs.push({deg: (a + 1) * 45, miss: c.miss, extra: c.extra, worst: c.worst});
    }

    return diffs;
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
prof = "/tmp/py2dmol-absfocus"
chrome, ws = cdp.launch(DEBUG_PORT, prof)
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_abs_focus.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
rows = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))

total_miss = 0
total_extra = 0
for r in rows:
    total_miss += r["miss"]
    total_extra += r["extra"]
    print(f"  {r['deg']:3d} deg: miss {r['miss']:4d}, extra {r['extra']:4d}, worst {r['worst']:3d}")

print(f"\nTotal: miss {total_miss}, extra {total_extra}")

chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(prof, ignore_errors=True)
sys.exit(1 if total_miss > 50 or total_extra > 50 else 0)
