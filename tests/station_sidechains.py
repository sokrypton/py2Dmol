"""Side chains, ligands and contacts are never drawn from a stale row.

    python3 tests/station_sidechains.py [_traj_1tim.pdb]

The station table describes RIB prims - the backbone, and since base plates were
given a frame, the base plates. Everything else is a stick: side chains,
ligands, contacts, lone atoms. Those rows sit after the ribbon in the
concatenation, and drawResident issues them from the buffer exactly as they were
built - right on the frame they were built for, wrong on every frame after it.

Measured before the fix, on _traj_1tim.pdb with 74 side chains showing: the
steps that took the fast path drew them 1.53% of the frame out of place at a
worst channel of 224, standing still while the backbone moved.

🔴 SO THE PATH DECLINES WHEN THE TABLE DOES NOT COVER THE WHOLE MESH, which is
what installStations argued for in the first place - "a path that quietly drops
a whole class of geometry is worse than one that declines" - and a stale row is
the same fault as a dropped one. This file holds that: with side chains on the
picture must be exact, and it is allowed to be exact by rebuilding.

🔴 AND IT CHECKS THE COST OF THAT RULE, because a rule this blunt is only
acceptable while the tail is usually empty. With nothing but backbone the table
covers every row (6927 of 6927 on 1TIM), so the trajectories the path exists for
are untouched; the moment a side chain is shown it is a rebuild per frame.
"""
import json, os, sys, shutil, subprocess, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationsc.html")
PORT = 9811
DEBUG_PORT = 9812
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILE = ARGS[0] if ARGS else "_traj_1tim.pdb"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, withSidechains) => {
    if (window.__loadedFile !== file) {
      const t = await (await fetch('/' + file)).text();
      await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
      window.__loadedFile = file;
    }
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 120000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const G = window.py2dmolCartoonGPU;
    const n = r.coords.length;
    if (withSidechains && r.showSidechains) {
      const list = [];
      for (let i = Math.floor(n * 0.30); i < Math.floor(n * 0.45); i++) list.push(i);
      r.showSidechains(list);
    } else if (r.showSidechains) {
      r.showSidechains([]);
    }
    await settle(10);
    const shown = r.shownSidechainSet ? (r.shownSidechainSet() || new Set()).size : -1;
    const G0 = window.py2dmolCartoonGPU;
    if (!G0 || !G0.setStationDraw) return {error: 'no station switch on this page'};
    if (G0 && G0.setStationDraw) { G0.setStationDraw(true); await settle(8); }

    const shot = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => {
      let m = 0; let w = 0;
      const samples = [];
      const cw = r.canvas.width;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
        if (d > 2) {
          m += 1;
          if (samples.length < 20 || d > samples[samples.length - 1].d) {
            const px = (i / 4) % cw;
            const py = Math.floor((i / 4) / cw);
            samples.push({ x: px, y: py, fast: [a[i], a[i+1], a[i+2]], reb: [b[i], b[i+1], b[i+2]], d });
            samples.sort((p1, p2) => p2.d - p1.d);
            if (samples.length > 20) samples.pop();
          }
        }
        if (d > w) w = d;
      }
      return {moved: m / (a.length / 4), worst: w, samples};
    };

    r.setFrame(0); r.render('warm'); await settle(4);
    const covers = G.stationsResident ? G.stationsResident() : null;
    const rows = G.residentCount ? G.residentCount() : -1;
    window.__stationFastPath = 0; window.__stationSlowPath = 0;
    let moved = 0; let worst = 0;
    const fastMs = []; const slowMs = [];
    let lastSamples = [];
    for (let i = 1; i < 6; i++) {
      r.setFrame(i);
      const t0 = performance.now();
      r.render('fast');
      fastMs.push(performance.now() - t0);
      const fast = shot();
      // ...against the same frame rebuilt, which is the only thing that can
      // tell a stale row from a row that is simply drawn differently
      if (G.invalidate) G.invalidate();
      const t1 = performance.now();
      r.render('rebuild');
      slowMs.push(performance.now() - t1);
      const d = diff(fast, shot());
      if (d.moved > moved) { moved = d.moved; worst = d.worst; lastSamples = d.samples; }
      r.setFrame(i); r.render('reinstall');
    }
    const took = window.__stationFastPath || 0;
    if (G0 && G0.setStationDraw) { G0.setStationDraw(false); await settle(4); }
    if (r.showSidechains) r.showSidechains([]);
    const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
    return {withSidechains, shown, took, rows,
            covered: covers ? covers.count : 0,
            fastMs: +med(fastMs).toFixed(2), slowMs: +med(slowMs).toFixed(2),
            moved: +(100 * moved).toFixed(4), worst, samples: lastSamples};
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


if not os.path.exists(os.path.join(ROOT, FILE)):
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py")],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-stationsc"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationsc.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
runs = {}
for tag, sc in (("backbone only", False), ("side chains shown", True)):
    runs[tag] = json.loads(cdp.evaluate(
        ws, f"window.__go({json.dumps(FILE)}, {'true' if sc else 'false'})"
            ".then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

bad = []
for tag, o in runs.items():
    if o.get("error"):
        sys.exit("page error: " + o["error"])
    tail = o["rows"] - o["covered"]
    print(f"{tag}: {o['shown']} side chains,"
          f" table covers {o['covered']} of {o['rows']} rows (tail {tail}),"
          f" fast path took {o['took']}")
    print(f"    against the same frame rebuilt: {o['moved']:.4f}% of pixels,"
          f" worst {o['worst']}")
    if o.get("samples"):
        for s in o["samples"][:5]:
            print(f"      sample ({s['x']}, {s['y']}): fast {s['fast']} vs reb {s['reb']} diff {s['d']}")
    # 🔴 NO TIMING HERE, DELIBERATELY. A single un-settled r.render() returns
    # before the frame is on the card - measured at 0.10 ms against a 19 ms
    # rebuild, which is not a 190x speedup, it is a deferred call. Cost belongs
    # in tests/station_integrated.py, which medians over three rounds after a
    # warm frame; this file's business is that the path is TAKEN and the
    # picture is right.
    # 🔴 THE PICTURE IS THE ASSERTION IN BOTH ARMS. Whether the path engaged is
    # a performance question; whether the frame is right is not.
    if o["moved"] > 0.01:
        bad.append(f"{tag}: the frame differs from the same frame rebuilt by"
                   f" {o['moved']:.3f}% of pixels (worst {o['worst']})")

sc = runs["side chains shown"]
bb = runs["backbone only"]
if sc["shown"] <= 0:
    bad.append("no side chains were shown, so that arm is the other arm")
if (sc["rows"] - sc["covered"]) != 0:
    bad.append(f"showing side chains left {sc['rows'] - sc['covered']} uncovered rows,"
               " side chains should be fully covered by stations")
# ...and the rule has to be cheap where it matters: backbone-only must still be
# fully covered, or every trajectory has just lost the fast path.
if bb["rows"] - bb["covered"] != 0:
    bad.append(f"backbone only leaves {bb['rows'] - bb['covered']} rows"
               " uncovered - the fast path is now declining on the very"
               " trajectories it exists for")
if bb["took"] <= 0:
    bad.append("the fast path never ran with backbone only")
# 🔴 AND IT MUST RUN WITH SIDE CHAINS TOO, which is the capability this pair of
# fixes bought. It used to be 0 of 5 - the ribbon's own mapping moved every
# frame because _invalidateSegmentCache dropped the pinned SS assignment, and
# _materialiseSidechains calls that on every frame. Asserting only the picture
# would pass on a path that always declines, which is what it did before.
if sc["took"] <= 0:
    bad.append("the fast path never ran with side chains shown - the station"
               " table is refusing, so refreshSticksFrom is unreachable and"
               " this is a rebuild per frame")

print()
for b in bad:
    print("FAIL: " + b)
print("station sidechains: " + ("FAILED" if bad else "nothing is drawn from a stale row"))
sys.exit(1 if bad else 0)
