"""A SKIPPED RIBBON MUST DRAW WHAT A BUILT ONE DRAWS, whatever was changed.

    python3 tests/ribbon_bypass.py [4HHB.cif]

facesOf skips every `rib` primitive when `ribbonSigOf(renderer)` matches the
signature the resident ribbon was built under - which is 35-50 ms of a build on
4HHB, and the whole reason the focus click got cheap.

🔴 AND THAT SIGNATURE IS A LIST OF RENDERER TERMS, WHICH IS THE ONE CACHE SHAPE
THIS FILE ARGUES AGAINST. makeResident's own note says it: "a key assembled from
renderer terms is a list someone has to keep complete, and most of the entries
in this file are a term that went missing. A hash of the thing itself cannot
forget one, and it fails safe." `ribbonSigOf` cannot fail safe - a term it does
not name is a ribbon that does not rebuild, and the reader sees the LAST
ribbon under the new settings.

So this file does not check the terms that ARE in the list. It changes things
that alter the drawn ribbon and asks the only question that matters: does the
frame equal the same frame with the mesh thrown away and rebuilt? A term the
signature forgot shows up as pixels and nothing else.

🔴 AND THE BYPASS HAS TO BE ARMED, OR EVERY ROW PASSES WHILE PROVING NOTHING.
`__ribbonFacesSkipped` counts the builds that actually took the short cut; a row
that never armed it is reported as `armed 0` and asserts nothing, which is said
out loud here rather than left looking like a pass.
"""
import json, os, sys, shutil, http.server, socketserver, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

PROBE = os.path.join(ROOT, "_ribbonbypass.html")
PORT = 9891
DEBUG_PORT = 9892
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
    // ...side chains out, because that is the state the bypass was written for:
    // the side chains rebuild and the ribbon is meant to be kept.
    const n = r.coords.length;
    const list = [];
    for (let i = Math.floor(n * 0.30); i < Math.floor(n * 0.40); i++) list.push(i);
    if (r.showSidechains) r.showSidechains(list);
    await settle(10);

    const shot = () => { const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
    const diff = (a, b) => { let m = 0; let w = 0;
      for (let i = 0; i < a.length; i += 4) { let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i+k]-b[i+k]));
        if (d > 2) m += 1; if (d > w) w = d; }
      return {moved: +(100*m/(a.length/4)).toFixed(4), worst: w}; };

    const out = [];
    // 🔴 EVERY LEG ENDS IN A SIDE-CHAIN TOGGLE, WHICH IS WHAT FORCES A BUILD.
    // Setting a field and calling reloadDrawn does not necessarily rebuild the
    // MESH - the first version of this file did that and every leg reported
    // "0% of pixels, armed 0", which is not a pass, it is twelve no-ops. A
    // side-chain change always rebuilds part 2, and it is exactly the case the
    // bypass was written for: the side chains rebuild and the ribbon is kept.
    let toggle = 0;
    const forceBuild = async () => {
      toggle += 1;
      const m = [];
      for (let i = Math.floor(n * 0.30); i < Math.floor(n * (0.40 + 0.02 * (toggle % 2))); i++) m.push(i);
      if (r.showSidechains) r.showSidechains(m);
      await settle(8);
    };
    const leg = async (name, fn) => {
      await fn();
      await settle(6);
      window.__ribbonFacesSkipped = 0;
      await forceBuild();
      // 🔴 TWO RENDERS AND A SHOT AFTER THE SECOND. A canvas read taken right
      // after render() can return the PREVIOUS frame, which this file would
      // report as a missing ribbon - the same trap the station notes record.
      r.render('after'); await settle(3);
      r.render('after2'); await settle(3);
      const got = shot();
      const armed = window.__ribbonFacesSkipped || 0;
      G.invalidate(); r.render('forced'); await settle(3);
      const want = shot();
      const ink = (d) => { let k = 0;
        for (let i = 0; i < d.length; i += 4)
          if (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245) k += 1;
        return k; };
      // 🔴 AND `armed 0` IS TWO DIFFERENT ANSWERS, so it is disambiguated here
      // rather than reported as one. The bypass declining can mean the
      // signature CHANGED - which is the right answer, the term is named and
      // the ribbon rebuilt - or it can mean a precondition was not met, in
      // which case the leg exercised nothing and the term is still untested.
      // This second build changes NOTHING: if the bypass arms now, the
      // preconditions were available all along and the decline above was the
      // signature doing its job.
      window.__ribbonFacesSkipped = 0;
      await forceBuild();
      r.render('ctl'); await settle(3);
      r.render('ctl2'); await settle(3);
      const ctlGot = shot();
      const ctlArmed = window.__ribbonFacesSkipped || 0;
      G.invalidate(); r.render('ctlforced'); await settle(3);
      const ctlWant = shot();
      out.push({name, armed, inkGot: ink(got), inkWant: ink(want),
                ctlArmed, ctlD: diff(ctlGot, ctlWant),
                faces: (window.__rebuild || {}).nRibbon || 0, d: diff(got, want)});
    };

    // the control: change nothing. Must be exact, and must ARM - if it does not
    // arm, this whole file is measuring a bypass that never ran.
    await leg('nothing changed', async () => {});
    await leg('cyclic on', async () => {
      if (!r.config.rendering) r.config.rendering = {};
      r.config.rendering.cyclic = true;
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      r.cachedSegmentIndices = null;
      if (r.reloadDrawn) r.reloadDrawn(true);
    });
    await leg('cyclic off', async () => {
      r.config.rendering.cyclic = false;
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      r.cachedSegmentIndices = null;
      if (r.reloadDrawn) r.reloadDrawn(true);
    });
    await leg('ss palette jmol', async () => {
      r.ssPalette = 'jmol';
      if (r.colorMode !== undefined) r.colorMode = 'ss';
      if (r.reloadDrawn) r.reloadDrawn(true);
    });
    await leg('ss palette pymol', async () => {
      r.ssPalette = 'pymol';
      if (r.reloadDrawn) r.reloadDrawn(true);
    });
    await leg('colour by chain', async () => {
      if (r.setColorMode) r.setColorMode('chain'); else r.colorMode = 'chain';
      if (r.reloadDrawn) r.reloadDrawn(true);
    });
    await leg('smooth on', async () => { r.cartoonSmooth = true; });
    await leg('smooth off', async () => { r.cartoonSmooth = false; });
    await leg('richardson preset', async () => {
      if (r.setPreset) r.setPreset('richardson');
    });
    await leg('ribbon preset', async () => {
      if (r.setPreset) r.setPreset('ribbon');
    });
    await leg('detail 2', async () => { r.cartoonDetail = 2; if (r.reloadDrawn) r.reloadDrawn(true); });
    await leg('detail 4', async () => { r.cartoonDetail = 4; if (r.reloadDrawn) r.reloadDrawn(true); });
    return {file, out};
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
open(PROBE, "w").write(
    open(os.path.join(ROOT, "dev.html")).read()
    .replace("</body>", "<script>" + SETUP + "</script></body>"))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-ribbonbypass"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_ribbonbypass.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
o = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

bad = []
armedAny = 0
print(f"{o['file']}: a skipped ribbon against the same frame rebuilt")
for row in o["out"]:
    armedAny += row["armed"]
    if row["armed"]:
        note = "bypass took it"
    elif row.get("ctlArmed"):
        note = "declined, and it arms on the very next build - the signature named this"
    else:
        note = "declined AND would not arm after - this leg tested nothing"
    print(f"  {row['name']:<20} armed {row['armed']}"
          f"  {row['d']['moved']:>8}% of pixels, worst {row['d']['worst']}"
          f"  ink {row.get('inkGot')} vs {row.get('inkWant')}  nRib={row.get('faces')}")
    print(f"  {'':<20} -> {note}"
          f"  (control build after: armed {row.get('ctlArmed')},"
          f" {row.get('ctlD', {}).get('moved')}%)")
    if row.get("ctlArmed") and row.get("ctlD", {}).get("moved", 0) > 0.01:
        bad.append(f"{row['name']}: the build AFTER it took the bypass and drew"
                   f" {row['ctlD']['moved']}% differently from a rebuild - the ribbon"
                   " kept under this setting is not the ribbon this setting draws")
    if row["armed"] and row["d"]["moved"] > 0.01:
        why = ("the skip itself is dropping faces" if row["name"] == "nothing changed"
               else "a term ribbonSigOf does not name")
        bad.append(f"{row['name']}: the skipped ribbon differs from a rebuilt one by"
                   f" {row['d']['moved']}% of pixels (worst {row['d']['worst']},"
                   f" ink {row.get('inkGot')} against {row.get('inkWant')}) - {why}")
if not (armedAny or any(r.get("ctlArmed") for r in o["out"])):
    bad.append("the bypass never armed on any leg, so this file measured nothing")

print()
for b in bad:
    print("FAIL: " + b)
print("ribbon bypass: " + ("FAILED" if bad else "a skipped ribbon draws what a built one draws"))
sys.exit(1 if bad else 0)
