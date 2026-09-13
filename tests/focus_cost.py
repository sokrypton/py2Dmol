"""What a focus click costs, step by step: mesh rebuilds, what was rebuilt,
and the reason the station path gave for declining."""
import json, os, sys, shutil, http.server, socketserver, threading
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp
from probe_js import HELPERS
PROBE = os.path.join(ROOT, "_focuscost.html"); PORT = 9861; DEBUG_PORT = 9862
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
    const G = window.py2dmolCartoonGPU;
    if (G.setStationDraw) { G.setStationDraw(true); await settle(8); }
    const out = [];
    const act = async (name, fn) => {
      window.__faceBuilds = 0; window.__stationFastPath = 0;
      window.__ribbonBuilds = 0; window.__sidechainBuilds = 0; window.__otherBuilds = 0;
      window.__rebuild = {}; window.__hashTrace = [];
      const t0 = performance.now();
      await fn();
      await settle(4);
      out.push({name, builds: window.__faceBuilds || 0,
                ribbonBuilds: window.__ribbonBuilds || 0,
                sidechainBuilds: window.__sidechainBuilds || 0,
                otherBuilds: window.__otherBuilds || 0,
                fast: window.__stationFastPath || 0,
                ms: +(performance.now() - t0).toFixed(1),
                rb: Object.assign({}, window.__rebuild || {}),
                why: (G.stationDecline && G.stationDecline()) || null,
                hashes: (window.__hashTrace || []).filter(h => h.g === 0)});
    };
    const n = r.coords.length;
    const pick = (frac) => Math.max(0, Math.min(n - 1, Math.floor(n * frac)));
    // ...the parts of a focus click, one at a time, before the whole thing
    await act('side chains on', async () => {
      const set = new Set(); for (let i = pick(0.10); i < pick(0.12); i++) set.add(i);
      r.showSidechains(Array.from(set)); });
    await act('side chains off', async () => { r.showSidechains([]); });
    await act('camera zoom only', async () => {
      const V = r.viewerState; V.zoom = (V.zoom || 1) * 1.6; r.render('zoom'); });
    await act('camera zoom back', async () => {
      const V = r.viewerState; V.zoom = (V.zoom || 1) / 1.6; r.render('zoom'); });
    await act('autoClip on', async () => {
      if (r.autoClip) r.autoClip(); r.render('clip'); });
    await act('clip off', async () => {
      if (r.clearClip) r.clearClip(); else { r.clipNear = null; r.clipFar = null; }
      r.render('unclip'); });
    await act('focus, no clip', async () => { r.focusOn([pick(0.35)], {clip: false}); });
    await act('clear, no clip', async () => { r.focusOn([pick(0.35)], {clip: false}); });
    await act('enter focus mode', async () => { r.enterFocusMode(); });
    await act('focus click 1', async () => { r.focusOn([pick(0.25)]); });
    await act('focus click 2', async () => { r.focusOn([pick(0.50)]); });
    await act('focus click 3', async () => { r.focusOn([pick(0.75)]); });
    await act('re-click 1', async () => { r.focusOn([pick(0.25)]); });
    await act('background click', async () => { r.clearFocus(); });
    await act('exit focus mode', async () => { r.exitFocusMode(); });
    return {file, positions: n, out};
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
prof = "/tmp/py2dmol-focuscost"
chrome, ws = cdp.launch(DEBUG_PORT, prof)
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_focuscost.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
o = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
print(f"{o['file']}: {o['positions']} positions, station path on")
for row in o["out"]:
    rb = row["rb"] or {}
    print(f"  {row['name']:<18} builds {row['builds']:<3} (rib {row.get('ribbonBuilds', 0)} sc {row.get('sidechainBuilds', 0)}) fast {row['fast']:<3}"
          f" {row['ms']:>7} ms  ribbonReused={rb.get('ribbonReused')}"
          f" otherReused={rb.get('otherReused')}"
          f" nRib={rb.get('nRibbon')} nSide={rb.get('nSide')}"
          f" capture={rb.get('capture')} total={rb.get('total')}")
    # ...the cache key's own terms, when paintgl is carrying the trace. It is
    # temporary instrumentation rather than a shipped counter, so this prints
    # whatever is there and nothing when there is nothing.
    for h in (row.get("hashes") or []):
        print("      rib: " + "  ".join(f"{k}={h[k]}" for k in
                                        ("n", "scale", "rowsUnused", "hash", "had", "pOnly")
                                        if k in h))
        row["_prm"] = h.get("prm")
prev = None
for row in o["out"]:
    cur = row.get("_prm")
    if cur is None: continue
    if prev is not None:
        moved = {k: (prev.get(k), cur.get(k)) for k in cur if prev.get(k) != cur.get(k)}
        if moved: print(f"  params that moved before '{row['name']}': {moved}")
    prev = cur
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(prof, ignore_errors=True)
