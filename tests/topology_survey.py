"""WHICH CONTROLS ACTUALLY CHANGE THE MESH'S TOPOLOGY, and which only move it.

    python3 tests/topology_survey.py [1UBQ.cif]

A control that changes the station, piece and face counts is TOPOLOGY: no table
can be updated across it and a rebuild is the only answer. A control that leaves
all three alone at every value is a COORDINATE change - the stations move, the
mapping does not - and the station table exists to update exactly that. The
second kind has no business in the topological signature, and every one that
sits there is a rebuild nobody needs.

This is the question `tests/PERF_NOTES.md` answered by hand once, in prose, for
the style panel. Prose goes stale: thickness and sheet flat are listed there as
controls that "have to" rebuild, and both are station updates now. This file
asks the renderer instead, so the answer is re-derivable rather than remembered.

🔴 IT IS A RATCHET, NOT A REPORT. Anything that comes back invariant and is
still in the topological key is named as a finding and FAILS, because that is a
rebuild the station path could have absorbed. Add a control here when you add
one to the panel.

🔴 AND THE COUNTS ARE NECESSARY, NOT SUFFICIENT. Equal counts mean the mapping
COULD hold; they do not prove the station update writes the right numbers. That
is what tests/station_foldcuts.py and tests/station_integrated.py compare
pixels for. Pass this file first, then those.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_toposurvey.html")
PORT = 9807
DEBUG_PORT = 9808
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"

# name, renderer property, values to sweep, and whether the topological
# signature currently carries it (which is what makes an invariant row a bug).
# 🔴 CONTROLS THAT LOOK LIKE COORDINATE CHANGES ON THE COUNTS AND ARE NOT.
# Equal counts say the mapping COULD hold; they say nothing about whether the
# station table carries everything the control changes. Anything named here has
# been taken out of the topological key, MEASURED with
# tests/station_controls.py, and put back - so it is exempt from the finding
# below, and the reason is recorded rather than remembered.
PROVEN_EXCEPTIONS = {
    # 1.4975% of the frame wrong at a worst of 171, against an 8.7303% effect:
    # richardson moves the shading knee, a helix's pale inner face and the
    # arrow tips, and those are baked per face.
    "richardson": "station_controls: 17% of its own change drawn wrongly",
    # 0.0325% wrong at a worst of 138 against a 1.2078% effect - 2.7% of its own
    # change. The arrowhead's GEOMETRY is per-frame now (its seam costs no
    # station and its blunt start no cap face, so a letter changing costs no
    # rebuild at all - tests/arrow_rebuilds.py), but the INK flags that go with
    # it are not: seam0/seam1/seamA say "do not draw a line across the shaft
    # here", and they are baked per face with the edge table. Toggling the
    # checkbox without a rebuild leaves the inner arrow line.
    "arrows": "station_controls: 2.7% of its own change drawn wrongly",
}

CONTROLS = [
    ("thickness",   "cartoonThickness",     [0, 0.3, 0.6, 1.2],   False),
    ("sheet flat",  "cartoonSheetFlat",     [0, 0.4, 0.8, 1.0],   False),
    ("line width",  "lineWidth",            [1.5, 3, 4.5, 6],     False),
    ("detail",      "cartoonDetail",        [2, 4, 8],            True),
    ("arrows",      "cartoonArrows",        [True, False],        True),
    ("richardson",  "cartoonRichardson",    [False, True],        True),
    ("base plates", "cartoonBasePlates",    [True, False],        True),
    ("na smooth",   "naSmooth",             [True, False],        False),
]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, controls) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 120000);
    await settle(6);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const G = window.py2dmolCartoonGPU;
    if (!G || !G.setStationDraw) return {error: 'no station API'};
    // The table is what the counts are read from, so it has to be on.
    G.setStationDraw(true);
    if (G.invalidate) G.invalidate();
    r.render('toposurveyWarm'); await settle(4);

    // 🔴 DID THE CONTROL DO ANYTHING HERE AT ALL? Base plates and na smooth
    // are nucleic-only, so on a protein they leave the counts alone for the
    // dullest possible reason - there is no geometry for them to act on - and
    // an invariant row would be reported as a finding about the signature when
    // it is really a finding about the structure. A control whose picture does
    // not move on this structure is INERT here and proves nothing either way.
    const digest = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4) {
        h ^= d[i] + 3 * d[i + 1] + 7 * d[i + 2];
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    const shape = () => {
      const s = G.stationsResident && G.stationsResident();
      return s ? [s.pieces, s.stations, s.count] : null;
    };
    const out = [];
    for (const c of controls) {
      const keep = r[c.prop];
      const seen = [];
      for (const v of c.values) {
        r[c.prop] = v;
        if (r._invalidateSegmentCache) r._invalidateSegmentCache();
        if (G.invalidate) G.invalidate();
        r.render('toposurvey');
        await settle(3);
        seen.push({v: String(v), shape: shape(), px: digest()});
      }
      r[c.prop] = keep;
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      if (G.invalidate) G.invalidate();
      r.render('toposurveyRestore'); await settle(3);
      out.push({name: c.name, prop: c.prop, seen});
    }
    return {out};
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
profile_dir = "/tmp/py2dmol-toposurvey"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_toposurvey.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
payload = json.dumps([{"name": n, "prop": p, "values": v} for n, p, v, _ in CONTROLS])
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {payload}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

inKey = {n: k for n, _, _, k in CONTROLS}
bad = []
print(f"{FILE}   pieces / stations / faces, per value")
for row in out["out"]:
    shapes = [s["shape"] for s in row["seen"]]
    vals = [s["v"] for s in row["seen"]]
    if any(s is None for s in shapes):
        bad.append(f"{row['name']}: no station table at some value, so nothing"
                   " was measured")
        continue
    pix = [s["px"] for s in row["seen"]]
    inert = all(p == pix[0] for p in pix)
    invariant = all(s == shapes[0] for s in shapes)
    shown = "  ".join(f"{v}:{s[0]}/{s[1]}/{s[2]}" for v, s in zip(vals, shapes))
    verdict = ("inert here" if inert
               else ("MOVES ONLY" if invariant else "topology"))
    print(f"  {row['name']:<12} {verdict:<11} {shown}")
    # 🔴 THE FINDING. Invariant counts and still in the topological key means
    # every change of this control rebuilds a mesh the station table could have
    # updated in place.
    if inert:
        continue
    if invariant and row["name"] in PROVEN_EXCEPTIONS:
        print(f"       (in the key on purpose - {PROVEN_EXCEPTIONS[row['name']]})")
        continue
    if invariant and inKey[row["name"]]:
        bad.append(f"{row['name']} ({row['prop']}) leaves the piece, station"
                   f" and face counts alone at every value of {vals} and is"
                   " still in the topological signature - that is a rebuild"
                   " the station table could absorb")
    if not invariant and not inKey[row["name"]]:
        bad.append(f"{row['name']} ({row['prop']}) CHANGES the counts"
                   f" {shapes} but has been taken out of the topological"
                   " signature - the station path will reuse a mapping that no"
                   " longer holds")

print()
for b in bad:
    print("FAIL: " + b)
print("topology survey: " + ("FAILED" if bad else "the key carries what moves the mapping"))
sys.exit(1 if bad else 0)
