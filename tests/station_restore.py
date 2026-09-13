"""A MESH TAKEN BACK OUT OF THE CACHE, AND THE STATION TABLE IT IS DRAWN FROM.

    python3 tests/station_restore.py [1YNE.cif]

Reported from the app: open 1YNE, press Hide, then Show (or Plate), then Hide
again on the side-chain row - and the RNA hairpin comes back as two translucent
spheres and a handful of stray lines.

The third press returns to a picture the viewer has already built, so the mesh
comes back out of the cache rather than being rebuilt - which is the whole
point of the cache, and of the station path beside it: a step that is an upload
and not a build. On the station path the ribbon's geometry is not in the mesh at
all; it is in the station TABLE, which is CPU arrays plus a GL buffer and two
GL textures.

🔴 AND THE CACHE KEPT THE TABLE'S GL HANDLES. The next build deleted the objects
they named, so a restore handed back a table whose buffer and textures no longer
existed. Every check on the fast path reads the arrays, which were intact, so
every check agreed; WebGL no-ops a write to a deleted texture without a word.

WHAT THIS ASKS, and why each one:

  the third press takes the STATION PATH
      The goal is to avoid rebuilding. A fix that rebuilt on every toggle would
      make every picture correct and pass the pixel check below - which is
      exactly the patch that was written for this, measured, and removed.

  the table is LIVE on every press
      `stationsResident().live` asks the card whether the objects still exist.
      This is the fault itself; the pixels are its symptom.

  the picture equals the same state REBUILT
      ...within the station path's own known tie-break noise.

  and the check can SEE a wrong picture
      The same comparison against a DIFFERENT state (bases drawn as plates) has
      to report a large difference, or "matches" could mean "measures nothing".
"""
import json, os, sys, shutil, http.server, socketserver, threading
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp
from probe_js import HELPERS, check_js

PROBE = os.path.join(ROOT, "_station_restore.html"); PORT = 9943; DEBUG_PORT = 9944
FILE = sys.argv[1] if len(sys.argv) > 1 else "1YNE.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, seq) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], false);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 5, 120000);
    await settle(20);
    const G = window.py2dmolCartoonGPU;
    const all = []; for (let i = 0; i < r.coords.length; i++) all.push(i);
    const ID = {H: 'sidechainHideButton', S: 'sidechainShowButton',
                P: 'sidechainPlateButton'};
    const presses = [];
    for (const c of seq) {
      r.setResidueSelection(new Set(all));
      await settle(10);
      window.__rebuild = null; window.__stationFastPath = 0;
      const b = document.getElementById(ID[c]);
      if (!b) return {error: 'no button ' + ID[c]};
      b.click();
      await settle(24);
      const tb = G.stationsResident();
      presses.push({press: c, rebuilt: !!window.__rebuild,
                    station: window.__stationFastPath || 0,
                    live: tb ? tb.live : null, count: tb ? tb.count : null});
    }
    r.clearResidueSelection && r.clearResidueSelection();
    // 🔴 READ TWICE WITH A FRAME BETWEEN, and keep the second: a canvas read
    // straight after render() returns the previous frame.
    const shot = async () => {
      r.render('shot'); await settle(6); r.render('shot2'); await settle(6);
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => { let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i+k] - b[i+k]));
        if (d > 40) n++; }
      return n; };
    const live = await shot();
    G.invalidate(); r.reloadDrawn(true); r.render('forced'); await settle(20);
    const rebuilt = await shot();
    // ...and the SAME comparison against a different state, so "0 px" is
    // known to be a measurement rather than a blind instrument
    r.setResidueSelection(new Set(all)); await settle(8);
    document.getElementById(ID.P).click(); await settle(24);
    r.clearResidueSelection && r.clearResidueSelection();
    const other = await shot();
    return {presses, px: live.length / 4,
            vsRebuilt: diff(live, rebuilt), vsOther: diff(rebuilt, other)};
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
check_js(SETUP)
open(PROBE, "w").write(open(os.path.join(ROOT, "dev.html")).read()
    .replace("</body>", "<script>" + SETUP + "</script></body>"))

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
prof = "/tmp/py2dmol-station-restore"
chrome, ws = cdp.launch(DEBUG_PORT, prof)
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Emulation.setDeviceMetricsOverride", width=1200, height=1000,
        deviceScaleFactor=1, mobile=False)

bad = []
for seq in ("HPH", "HSH"):
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_station_restore.html")
    cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
    o = json.loads(cdp.evaluate(ws,
        f"window.__go({json.dumps(FILE)}, {json.dumps(seq)}).then(JSON.stringify)"))
    if o.get("error"):
        bad.append(f"{seq}: {o['error']}")
        continue
    for p in o["presses"]:
        path = "station" if p["station"] and not p["rebuilt"] else (
            "rebuild" if p["rebuilt"] else "neither")
        print(f"  {FILE} {seq}  {p['press']}  {path:<8} table live={p['live']}"
              f"  count={p['count']}")
    limit = max(1, o["px"] // 1000)          # 0.1% of the canvas
    print(f"  {FILE} {seq}  vs the same state rebuilt: {o['vsRebuilt']} px;"
          f"  rebuilt vs plates drawn: {o['vsOther']} px  (limit {limit})")
    last = o["presses"][-1]
    if not (last["station"] and not last["rebuilt"]):
        bad.append(f"{seq}: the third press did not take the station path"
                   f" (rebuilt={last['rebuilt']}, station={last['station']}) -"
                   " returning to a picture already built should be an upload,"
                   " not a build")
    dead = [p["press"] for p in o["presses"] if p["live"] is False]
    if dead:
        bad.append(f"{seq}: the station table named deleted GL objects after"
                   f" press(es) {dead} - a cached mesh was handed back holding"
                   " handles a later build had deleted")
    if o["vsRebuilt"] > limit:
        bad.append(f"{seq}: the frame differs from the same state rebuilt by"
                   f" {o['vsRebuilt']} px - drawn through the wrong table")
    if o["vsOther"] <= limit:
        bad.append(f"{seq}: a different state differs by only {o['vsOther']} px,"
                   " so this comparison cannot see a wrong picture")

print()
for b in bad:
    print("FAIL: " + b)
print("station restore: " + ("FAILED" if bad else
      "a restored mesh draws through a live table, on the station path"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(prof, ignore_errors=True)
sys.exit(1 if bad else 0)
