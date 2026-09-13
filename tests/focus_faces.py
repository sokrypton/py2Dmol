"""SIDE-CHAIN FACES THAT GO MISSING AFTER A VISIT TO FOCUS MODE.

    python3 tests/focus_faces.py [4HHB.cif]

Reported from the app: enter focus mode, leave it, show side chains, turn the
structure by hand - and faces are gone at certain angles. This turns the
structure through eight of them and compares each with the SAME angle rebuilt
from scratch. Ink the rebuild draws and the frame does not is a face the kept
mesh has lost.

🔴 TWO PASSES, AND THE FIRST NEVER REBUILDS. Forcing a rebuild at each angle
REPAIRS whatever the mesh was carrying, so a sweep that invalidates as it goes
measures the first angle and a healthy mesh for every one after it - which is
how the first version of this reported one bad angle and seven clean ones.

🔴 AND THE ROTATION IS A MATRIX ON viewerState. There is no rotateBy; the first
version called one and fell back to writing V.rotationY, which nothing reads,
so eight angles were one view eight times. Every row reading identical numbers
is what gave that away - a sweep whose rows do not differ has not swept.

🔴 AND THE STATION PATH IS NOT FORCED ON, WHICH IS THE WHOLE FINDING. An
earlier version of this file called setStationDraw(true) before the first
build and reported the deployed renderer CLEAN. It is not: renderApp turns the
path on BY ITSELF the moment focus mode is entered - `|| renderer._focusMode` -
so a single-frame structure reaches it with a mesh that was built without
stations and has the path switched on underneath. Forcing it on up front is a
different state from the one a reader reaches, and it is the one state where
this does not reproduce. A probe that arranges the conditions it wants is
measuring its own arrangement.

🔴 AND THE "NEVER FOCUSED" GROUP IS THE CONTROL. It exercises the same sweep on
the same structure with the same side chains and must come back clean; without
it, a difference could as easily be the probe as the renderer.
"""
import json, os, sys, shutil, http.server, socketserver, threading
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp
from probe_js import HELPERS
PROBE = os.path.join(ROOT, "_scfaces.html"); PORT = 9901; DEBUG_PORT = 9902
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
    // 🔴 NOT FORCED. The app turns the station path on BY ITSELF the moment
    // focus mode is entered - `|| renderer._focusMode` in renderApp - and a
    // single-frame structure would never have it on otherwise. Forcing it here
    // is a different state from the one a reader reaches, and the one a reader
    // reaches is a mesh built WITHOUT stations that the path is switched on
    // underneath.
    await settle(4);
    const shot = () => { const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
    const cmp = (a, b) => { let miss = 0, extra = 0, w = 0;
      const lit = (d, i) => (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245);
      for (let i = 0; i < a.length; i += 4) {
        const la = lit(a, i), lb = lit(b, i);
        if (!la && lb) miss += 1;          // rebuild draws it, the frame does not
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
    // 🔴 THE ROTATION IS A MATRIX ON viewerState, AND THERE IS NO rotateBy.
    // The first version of this called r.rotateBy(45, 0), which does not
    // exist, and fell back to writing V.rotationY, which nothing reads - so
    // eight "angles" were one view eight times and every row read the same
    // numbers. That identical-across-angles reading is what gave it away.
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
    // 🔴 TWO PASSES, AND THE FIRST ONE NEVER REBUILDS. Forcing a rebuild at
    // each angle REPAIRS whatever the mesh was carrying, so a sweep that
    // invalidates as it goes measures angle 1 and then a healthy mesh for
    // every angle after it - which is how the first version of this reported
    // one bad angle and seven clean ones.
    const sweep = async (tag) => {
      const drawn = [];
      const kA = [];
      for (let a = 0; a < 8; a++) { await turn(); drawn.push(shot()); kA.push(camKey()); }
      // ...back to where the first pass started, then the same angles rebuilt
      const ref = []; const kB = [];
      for (let a = 0; a < 8; a++) {
        await turn();
        G.invalidate(); r.render('forced'); await settle(4);
        r.render('forced2'); await settle(3);
        ref.push(shot()); kB.push(camKey());
      }
      const rows = [];
      for (let a = 0; a < 8; a++) {
        const c = cmp(drawn[a], ref[a]);
        rows.push({deg: (a + 1) * 45, miss: c.miss, extra: c.extra, worst: c.worst,
                   });
      }
      return {tag, rows};
    };

    const out = [];
    if (r.showSidechains) r.showSidechains(sc);
    await settle(10);
    out.push(await sweep('side chains, never focused'));

    // ...a visit to focus mode and back, which is what the report names
    r.enterFocusMode(); await camSettle();
    r.focusOn([Math.floor(n * 0.35)]); await camSettle();
    r.exitFocusMode(); await camSettle();
    if (r.showSidechains) r.showSidechains(sc);
    await settle(10);
    out.push(await sweep('after focus mode, side chains shown again'));
    return out;
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
prof = "/tmp/py2dmol-scfaces"
chrome, ws = cdp.launch(DEBUG_PORT, prof)
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_scfaces.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
o = json.loads(cdp.evaluate(ws, f'window.__go("{FILE}").then(JSON.stringify)'))
for grp in o:
    print(f"  {grp['tag']}")
    for row in grp["rows"]:
        flag = "   <-- MISSING INK" if row["miss"] > 200 else ""
        print(f"     {row['deg']:>4} deg   missing {row['miss']:>6}   extra {row['extra']:>6}"
              f"   worst {row['worst']}{flag}")
bad = []
ctl = next((g for g in o if "never focused" in g["tag"]), None)
if ctl and max(r["miss"] for r in ctl["rows"]) > 200:
    bad.append("the control sweep - side chains that never saw focus mode - is"
               " already losing ink, so this file cannot attribute anything")
if ctl and len({(r["miss"], r["extra"]) for r in ctl["rows"]}) == 1 \
        and len({r["worst"] for r in ctl["rows"]}) == 1:
    bad.append("every angle of the control reads identically - the sweep is not"
               " turning the structure, so 'at certain angles' was never tested")
for grp in o:
    worst = max(r["miss"] for r in grp["rows"])
    if worst > 200:
        n = sum(1 for r in grp["rows"] if r["miss"] > 200)
        bad.append(f"{grp['tag']}: {n} of {len(grp['rows'])} angles are missing ink"
                   f" the same angle rebuilt draws, worst {worst} pixels")
print()
for b in bad:
    print("FAIL: " + b)
print("focus faces: " + ("FAILED" if bad else "no face goes missing at any angle"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(prof, ignore_errors=True)
sys.exit(1 if bad else 0)
