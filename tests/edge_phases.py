"""WHERE A RIBBON BUILD'S TIME GOES, phase by phase, medians over rounds.

    python3 tests/edge_phases.py [1AOI.cif _traj_1tim.pdb ...]

The edges phase is 78-81% of a ribbon build, and until this file it was one
number. It is three: the interior WELD (does another face claim these four
corners), the TABLE (which faces share an edge, and what each contributes), and
the EMIT (turning the table into instances). Measured on this machine:

    1AOI, 17,552 ribbon faces      weld 3.10   table 5.60   emit 0.90
    _traj_1tim.pdb, 6,927          weld 1.40   table 2.30   emit 0.40

against `normals` 1.80/0.90, `rails` 0.80/0.10 and `pieceFrames` 0.10 - the
last of which used to be a pass of its own and is now skipped where the station
table covers the part.

🔴 SO THE COST IS THE TABLE, NOT THE KEY. Stage 2 of the edge plan cheapened
the corner key - eight position hashes a face became a lookup into a table of
every corner the ribbon has - and it measured at 1.00x, 1.08x, 0.99x, 0.90x and
1.14x over five interleaved runs, which is this machine's noise and nothing
else. It was reverted. What is left in the phase is Map operations and chain
walks, about four an edge, and those are what stage 4 removes.

🔴 AND THE ROUNDS ARE INTERLEAVED WITH NOTHING, WHICH IS THE POINT OF THE
MEDIAN. A build is a few milliseconds and this machine drifts by up to 3.2x
between runs, so one build tells you nothing. Fifteen and a median tell you
where the time is.
"""
import json, os, sys, shutil, statistics, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_edgephases.html")
PORT = 9919
DEBUG_PORT = 9920
FILES = sys.argv[1:] or ["1AOI.cif", "_traj_1tim.pdb"]
ROUNDS = 15
# in the order buildMeshPart marks them
KEYS = ["unprojectFrames", "rails", "pieceFrames", "normals", "facesAndEmit",
        "weld", "table", "edges", "buffers", "end"]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (files, rounds) => {
   try {
    const out = [];
    const G = window.py2dmolCartoonGPU;
    for (const f of files) {
      const t = await (await fetch('/' + f)).text();
      await window.processFiles([{name: f, readAsync: () => Promise.resolve(t)}], true);
      await until(loaded, 300000);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      await until(() => r.coords && r.coords.length > 0, 300000);
      await settle(8);
      await until(() => !r._quietStyle && !r._switchQuiet, 60000);
      if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
      await settle(10);
      // the ribbon is the only part with a station table, and __mrPhase is
      // overwritten by the parts after it - __mrRibbon is the ribbon's own
      if (G.setStationDraw) G.setStationDraw(true);
      r.outlineMode = 'on'; r.relativeOutlineWidth = 3;
      if (G.invalidate) G.invalidate();
      await settle(6);

      const one = async (tag) => {
        window.__mrRibbon = null;
        if (G.invalidate) G.invalidate();
        r.render(tag);
        await settle(2);
        const P = window.__mrRibbon;
        if (P) P.stats = window.__edgeStatsRibbon || null;
        return P;
      };
      await one('warm');
      const runs = [];
      for (let i = 0; i < rounds; i += 1) {
        const P = await one('phase' + i);
        if (P) runs.push(P);
      }
      out.push({file: f, faces: runs.length ? runs[0].faces : 0, runs});
    }
    return {out};
   } catch (e) { return {error: String((e && e.stack) || e)}; }
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
profile_dir = "/tmp/py2dmol-edgephases"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_edgephases.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILES)}, {ROUNDS}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])

bad = []
for row in res["out"]:
    runs = row["runs"]
    if not runs:
        bad.append(f"{row['file']}: no ribbon build was captured, so nothing"
                   " was profiled. It needs a cartoon with the outline on")
        continue
    print(f"  {row['file']:<16} {row['faces']} ribbon faces,"
          f" {len(runs)} builds")
    # ...each phase is the gap since the mark before it, and the medians are
    # taken PER PHASE rather than of one build, so a slow round does not
    # decide where the time is.
    prev = None
    total = 0.0
    for k in KEYS:
        if k not in runs[0]:
            continue
        vals = [(p[k] - (p[prev] if prev else 0)) for p in runs if k in p]
        m = statistics.median(vals)
        total += m
        print(f"    {k:<16} {m:>7.2f} ms   (min {min(vals):.2f},"
              f" max {max(vals):.2f})")
        prev = k
    print(f"    {'total':<16} {total:>7.2f} ms")
    st = runs[-1].get("stats")
    if st:
        print(f"    table        {st['tableEdges']} edges in"
              f" {st['groups']} groups")
        print(f"    faces        {st['ribs']} rib, {st['caps']} cap;"
              f" {st['interiorDropped']} welded away")
        print(f"    emitted      {st['edges']} rows -"
              f" {st['boundary']} boundary, {st['crease']} crease;"
              f" {st['ghostOnly']} edges held nothing but ghosts,"
              f" {st['nonManifoldDropped']} were non-manifold")
    ends = [p["end"] for p in runs]
    print(f"    {'whole part':<16} {statistics.median(ends):>7.2f} ms")
print()
for b in bad:
    print("FAIL: " + b)
print("edge phases: " + ("FAILED" if bad else "measured"))
sys.exit(1 if bad else 0)
