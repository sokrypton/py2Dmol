"""A CPU profile of a trajectory being stepped, aggregated by function.

    python3 tests/anim_profile.py [_traj_1tim.pdb] [steps]

WHY NOT MORE INSTRUMENTATION. Two probes before this one guessed at global
names - `__mrBuild` for what is really `__rebuild`, a `glPainter` property that
does not exist - and each guess produced a confident table of zeros. A sampling
profile names what actually ran, so the question "what is a rebuilt frame made
of" is answered by the engine rather than by a hook somebody has to keep
correct.

It drives Chrome over CDP: Profiler.start, a fixed number of setFrame/render
steps in the page, Profiler.stop, then self-time summed per function. Anything
under a tenth of a percent is dropped.
"""
import json, os, subprocess, sys, shutil, time, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_animprof.html")
PORT = 9783
DEBUG_PORT = 9784
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILE = ARGS[0] if ARGS else "_traj_1tim.pdb"
STEPS = int(ARGS[1]) if len(ARGS) > 1 else 120

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  const go = async () => {
    const txt = await (await fetch('/' + FILE_NAME)).text();
    await window.processFiles(
      [{name: FILE_NAME, readAsync: () => Promise.resolve(txt)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(5);
    await until(() => !r._quietStyle && !r._switchQuiet, 20000);
    const obj = r.objectsData[r.currentObjectName];
    window.__r = r;
    // 🔴 CALLED, NOT READ. Setting a flag from outside after navigate races the
    // page's own load handler, and the first version of this profiled a rebuild
    // while reporting it as the fast path - buildMeshPart at 26% of a step that
    // is not supposed to run it at all. An entry point cannot race.
    window.__enableFast = async () => {
      // The style has to settle before anything else: above
      // LARGE_MOLECULE_CUTOFF the app switches to tube, and setStyle alone
      // reads back as 'cartoon' while the render that follows is still the
      // other painter.
      if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
      await settle(6);
      if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.setStationDraw(true);
    r._noFoldCuts = true;
      const G = window.py2dmolCartoonGPU;
      if (G && G.setStationDraw) G.setStationDraw(true);
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      if (G && G.invalidate) G.invalidate();
      r.setFrame(0); r.render('warmFast');
      await settle(6);
      // 🔴 AND AGAIN, because the first render after a style change does not
      // always rebuild the GPU mesh - and the station table is installed BY a
      // rebuild. One render leaves the path armed and never started, which
      // reads as "it is not faster" with nothing else to see.
      if (G && G.invalidate) G.invalidate();
      r.render('warmFast2');
      await settle(6);
      window.__stationFastPath = 0; window.__stationSlowPath = 0;
      return {resident: !!(G.stationsResident && G.stationsResident()),
              style: r.style, refusal: G.stationRefusal ? G.stationRefusal() : null};
    };
    window.__frames = (obj && obj.frames) ? obj.frames.length : 1;
    // ONE STEP, and the page owns it so the profiler is not timing CDP.
    window.__step = (n) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        r.setFrame(i % window.__frames);
        r.render();
      }
      return {ms: (performance.now() - t0) / n,
              gpuDrew: !!r.gpuDrewLastFrame,
              rebuild: window.__rebuild || null,
              phase: window.__mrPhase || null,
              positions: r.coords.length};
    };
    window.__ready = true;
  };
  go();
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS).replace("FILE_NAME", json.dumps(FILE))
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

profile_dir = "/tmp/py2dmol-animprof"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)

ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_animprof.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the trajectory to load")
if "--fast" in sys.argv:
    print("fast path: " + cdp.evaluate(ws, "window.__enableFast().then(JSON.stringify)"))

warm = cdp.evaluate(ws, "JSON.stringify(window.__step(10))")
warm = json.loads(warm)

ws.call("Profiler.enable")
ws.call("Profiler.setSamplingInterval", interval=100)
ws.call("Profiler.start")
run = json.loads(cdp.evaluate(ws, f"JSON.stringify(window.__step({STEPS}))"))
run["fastSteps"] = cdp.evaluate(ws, "window.__stationFastPath || 0")
prof = ws.call("Profiler.stop")["profile"]

chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

nodes = {n["id"]: n for n in prof["nodes"]}
total = sum(n.get("hitCount", 0) for n in prof["nodes"]) or 1
by = {}
for n in prof["nodes"]:
    cf = n["callFrame"]
    name = cf.get("functionName") or "(anonymous)"
    url = (cf.get("url") or "").rsplit("/", 1)[-1]
    key = f"{name}  [{url}:{cf.get('lineNumber', -1) + 1}]"
    by[key] = by.get(key, 0) + n.get("hitCount", 0)

print(f"{FILE}  {run['positions']} positions  {STEPS} steps")
print(f"a step: {run['ms']:.2f} ms   gpuDrewLastFrame={run['gpuDrew']}"
      f"   fast-path steps: {run.get('fastSteps')}")
if run.get("rebuild"):
    rb = run["rebuild"]
    print("  last rebuild: " + ", ".join(
        f"{k}={v}" for k, v in rb.items() if k in
        ("ribbonReused", "otherReused", "nRibbon", "nOther", "nSide", "stickMs")))
if run.get("phase"):
    ph = run["phase"]
    print("  last mesh build phases (cumulative ms): " + ", ".join(
        f"{k}={ph[k]}" for k in ("faces", "unprojectFrames", "rails", "pieceFrames",
                                 "normals", "facesAndEmit", "edges", "buffers", "end")
        if k in ph))
print(f"\nself time over {total} samples, functions above 0.5%:\n")
for key, hits in sorted(by.items(), key=lambda kv: -kv[1]):
    share = 100 * hits / total
    if share < 0.5:
        break
    print(f"  {share:5.1f}%  {key}")
