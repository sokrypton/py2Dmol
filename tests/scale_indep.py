"""Is the built mesh the SAME mesh at two zooms? The ribbon part's cache key
mixes the capture scale and the projected corners; if the CONTENT is
scale-independent, the key is the only thing standing between a focus click
and a reused ribbon."""
import json, os, sys, shutil, http.server, socketserver, threading
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp
from probe_js import HELPERS
PROBE = os.path.join(ROOT, "_scaleindep.html"); PORT = 9871; DEBUG_PORT = 9872
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
    const V = r.viewerState;
    const at = async (z) => {
      V.zoom = z; window.__meshDigest = 1; G.invalidate();
      r.render('dig'); await settle(4);
      const d = window.__meshDigest; window.__meshDigest = 0;
      return {zoom: z, fill: d.fill, fillN: d.fillN, edges: d.edges, edgeN: d.edgeN};
    };
    const z0 = V.zoom || 1;
    // 🔴 AND A PAN, WHICH IS THE OTHER HALF OF A FOCUS CLICK. unproject
    // measures from the capture viewport's middle, so if the centre moves the
    // same atom comes back at a different model coordinate - and then the mesh
    // is NOT reusable across a focus click however the key is written.
    const c0 = V.center ? Object.assign({}, V.center) : null;
    const panned = async (d) => {
      if (!c0) return null;
      V.center = {x: c0.x + d, y: c0.y, z: c0.z};
      const r2 = await at(z0);
      V.center = Object.assign({}, c0);
      return r2;
    };
    const p0 = await at(z0);
    const p1 = await panned(8);
    const p2 = await at(z0);
    console.log('PAN', JSON.stringify({p0, p1, p2}));
    window.__panResult = {p0, p1, p2, hadCentre: !!c0};
    const a = await at(z0);
    const b = await at(z0 * 1.6);
    const c = await at(z0);            // ...and back, as the control
    // ...and again with the station path OFF, so the ribbon's own 48-float
    // rows are BUILT rather than skipped: with them skipped the fill digest
    // covers only the sticks, and the ribbon is the part this is about.
    if (G.setStationDraw) { G.setStationDraw(false); await settle(8); }
    const d = await at(z0);
    const e = await at(z0 * 1.6);
    if (G.setStationDraw) { G.setStationDraw(true); await settle(8); }
    V.zoom = z0;
    return {a, b, c, d, e, pan: window.__panResult};
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
prof = "/tmp/py2dmol-scaleindep"
chrome, ws = cdp.launch(DEBUG_PORT, prof)
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_scaleindep.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
o = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
for k in ("a", "b", "c", "d", "e"):
    d = o[k]
    print(f"  zoom {d['zoom']:.4f}: fill {d['fill']} ({d['fillN']} rows)"
          f"  edges {d['edges']} ({d['edgeN']} rows)")
same = o["a"]["fill"] == o["b"]["fill"] and o["a"]["edges"] == o["b"]["edges"]
print("  mesh across a 1.6x zoom:", "IDENTICAL" if same else "DIFFERENT")
print("  and back at the first zoom:",
      "identical" if o["a"] == o["c"] else "differs (the control failed)")
same2 = o["d"]["fill"] == o["e"]["fill"] and o["d"]["edges"] == o["e"]["edges"]
print("  station path OFF, ribbon rows built, across a 1.6x zoom:",
      "IDENTICAL" if same2 else "DIFFERENT")
print("  (and the ribbon's rows really were built:",
      f"{o['d']['fillN']} fill rows against {o['a']['fillN']} with it on)")
pan = o.get("pan") or {}
if pan.get("hadCentre"):
    q0, q1, q2 = pan["p0"], pan["p1"], pan["p2"]
    same = q0["fill"] == q1["fill"] and q0["edges"] == q1["edges"]
    print("  mesh across an 8 A PAN:", "IDENTICAL" if same else "DIFFERENT")
    print(f"    at centre:  fill {q0['fill']}  edges {q0['edges']}")
    print(f"    panned 8 A: fill {q1['fill']}  edges {q1['edges']}")
    print("    control, back at the first centre:",
          "identical" if q0 == q2 else "DIFFERS - the control failed")
else:
    print("  no viewerState.center to pan")
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(prof, ignore_errors=True)
