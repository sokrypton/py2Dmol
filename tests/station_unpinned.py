"""A TRAJECTORY TAKES THE STATION PATH WITHOUT BEING ASKED, AND DRAWS THE SAME.

    python3 tests/station_unpinned.py [_traj_1tim.pdb ...]

the station table does two things: it builds the station table, and it PINS the
secondary structure so the face-to-station mapping holds still between frames.
Those are not the same kind of thing. The pin is a claim about the data -
"these frames are one molecule moving" - and it is wrong on a folding
trajectory, which is why it is opt-in. The table is a claim about nothing:
where the mapping happens to hold, the frame is updated in place; where it does
not, stationsMatch says so and the frame rebuilds exactly as it would have.

So the table is switched on for any object with more than one frame, pinned or
not. Interleaved medians of four, both orders, before that change:

    _traj_1tim.pdb    17.26 ms a step -> 13.45   (14 of 29 steps take it)
    _traj_unfold.pdb   3.88 ms        ->  2.63   (23 of 29)
    _traj_1ehz.pdb     5.63 ms        ->  2.94   (7 of 7)

A nucleic trajectory never moves its assignment at all, so it gets the whole of
the station table's benefit with none of its promise.

🔴 THE PICTURE IS THE POINT, NOT THE COUNT. An unpinned fast step is only
allowed because stationsMatch is exact - it compares the whole face-to-station
and face-to-piece mapping, not just the counts - so this file checks the frame
it produces against the SAME frame rebuilt, and against a same-build floor. A
step that reuses the mesh when it should not draws a plausible ribbon made of
the wrong slices, which is the failure the mapping comparison exists to stop.

🔴 AND SOME STEPS MUST ACTUALLY TAKE IT. Nothing here means anything if the
path was never entered, so a run with no fast steps fails rather than passes.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationunpinned.html")
PORT = 9825
DEBUG_PORT = 9826
FILES = sys.argv[1:] or [f for f in ("_traj_1tim.pdb", "_traj_unfold.pdb",
                                     "_traj_1ehz.pdb")
                         if os.path.exists(os.path.join(ROOT, f))]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
   try {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(12);
    const G = window.py2dmolCartoonGPU;
    // the DEFAULT: no pin, and whatever the renderer decides about the table
    const nF = (r.objectsData[r.currentObjectName].frames || []).length;

    const shot = () => {
      const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => {
      let moved = 0; let worst = 0;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
        if (d > 2) moved += 1;
        if (d > worst) worst = d;
      }
      return {moved: moved / (a.length / 4), worst};
    };

    r.setFrame(0); await settle(6);
    window.__stationGaveUp = 0;
    let fast = 0; let steps = 0;
    let worstErr = {moved: 0, worst: 0}; let worstFloor = {moved: 0, worst: 0};
    let sensitivity = 0;
    let prev = shot();
    let capsWorst = 0;
    for (let f = 1; f < nF; f++) {
      window.__stationFastPath = 0;
      window.__captures = 0;
      r.setFrame(f); await settle(4);
      // 🔴 ONE CAPTURE A STEP, TAKEN OR DECLINED. A declining step used to
      // capture the frame three times - once for the mapping comparison, once
      // for the rebuild, once more to reinstall the table - and a capture is
      // the most expensive thing in a step. All three are the same frame.
      if (window.__captures > capsWorst) capsWorst = window.__captures;
      const took = (window.__stationFastPath || 0) > 0;
      const reused = shot();
      const moved = diff(prev, reused).moved;
      if (moved > sensitivity) sensitivity = moved;
      prev = reused;
      steps += 1;
      if (!took) continue;
      fast += 1;
      // ...the same frame, rebuilt, and then rebuilt again for the floor
      if (G.invalidate) G.invalidate();
      r.render('rebuild'); await settle(4);
      const rebuilt = shot();
      if (G.invalidate) G.invalidate();
      r.render('rebuild2'); await settle(4);
      const rebuilt2 = shot();
      const e = diff(reused, rebuilt);
      const fl = diff(rebuilt, rebuilt2);
      if (e.moved > worstErr.moved) worstErr = e;
      if (fl.moved > worstFloor.moved) worstFloor = fl;
      prev = rebuilt2;
    }
    return {file, n: r.coords.length, frames: nF, steps, fast, capsWorst,
            gaveUp: window.__stationGaveUp || 0,
            err: worstErr, floor: worstFloor, sensitivity};
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
profile_dir = "/tmp/py2dmol-stationunpinned"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationunpinned.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")

bad = []
if not FILES:
    print("no _traj_ files here - build one with tests/make_traj.py")
for f in FILES:
    out = json.loads(cdp.evaluate(
        ws, f"window.__go({json.dumps(f)}).then(JSON.stringify)"))
    if out.get("error"):
        bad.append(f"{f}: page error: {out['error'][:200]}")
        continue
    e = out["err"]; fl = out["floor"]
    print(f"{out['file']}: {out['n']} positions, {out['frames']} frames,"
          f" no pin - fast path taken {out['fast']}/{out['steps']}")
    print(f"  worst step against the same frame rebuilt:"
          f" {100 * e['moved']:.4f}% (worst {e['worst']})"
          f"   floor {100 * fl['moved']:.4f}% (worst {fl['worst']})")
    print(f"  a step moves {100 * out['sensitivity']:.2f}% of the frame"
          "   (this file's own sensitivity)")
    print(f"  captures in the busiest step: {out['capsWorst']} (must be 1)")
    if out["capsWorst"] > 1:
        bad.append(f"a step captured the frame {out['capsWorst']} times - the"
                   " mapping comparison, the rebuild and the table reinstall"
                   " are the same frame, and a capture is the most expensive"
                   " thing in a step (5.7 ms of an 11.0 ms step unpinned)")
    # 🔴 THE TABLE PAYS OR IT STOPS. It is offered to any trajectory, and on a
    # structure where the mapping never holds it is pure cost - the table is
    # built on every rebuild and declined on every frame, which measured 152 ms
    # a step against 166 on _traj_syn5000.pdb. So after eight consecutive
    # declines the automatic table gives up. The two halves are one invariant:
    # a run that never took the path must have given up, and a run that took it
    # must not have.
    print(f"  gave up: {out['gaveUp']}")
    if out["fast"] and out["gaveUp"]:
        bad.append(f"{f}: the path was taken {out['fast']} times and the table"
                   " still gave up - the strike limit is firing where the table"
                   " pays, which is the one thing it must not do")
    if not out["fast"] and not out["gaveUp"]:
        bad.append(f"{f}: the fast path was never taken and the table never"
                   " gave up, so every frame built one and declined it - that"
                   " is what the strike limit exists to stop")
    if not out["fast"]:
        bad.append(f"{f}: the fast path was never taken without the pin, so"
                   " nothing here was measured - a trajectory is meant to get"
                   " the station table whether or not the station table is on")
    # 🔴 JUDGED AGAINST WHAT THE STEP ITSELF CHANGES, not against a fixed
    # number of levels. A stale mapping draws a plausible ribbon made of the
    # WRONG SLICES - percent of the frame, not a pixel - while a correct step
    # still moves antialiased edges, and one of those can be a hundred levels
    # on its own. A fixed worst-channel bound cannot tell those apart: the
    # first version of this file failed 1TIM at worst 96 while the moved
    # fraction was 0.0044% of a frame whose step moves 10.36%, which is
    # 0.04% of the change. That is the same argument tests/station_controls.py
    # makes about a control's own effect, and the pinned gate
    # (tests/station_integrated.py) already accepts a worst of 162 on this
    # basis.
    limit = max(fl["moved"], out["sensitivity"] / 100)
    if e["moved"] > limit:
        bad.append(f"{f}: an unpinned fast step drew {100 * e['moved']:.4f}% of"
                   f" the frame differently from the same frame rebuilt, at a"
                   f" worst of {e['worst']} - that is"
                   f" {100 * e['moved'] / max(out['sensitivity'], 1e-12):.1f}%"
                   " of what the step itself changes, so the mapping was reused"
                   " when it should not have been")
    if out["sensitivity"] < 0.005:
        bad.append(f"{f}: consecutive frames differ by only"
                   f" {100 * out['sensitivity']:.2f}%, so this comparison could"
                   " not see a stale draw")

chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

print()
for b in bad:
    print("FAIL: " + b)
print("station unpinned: " + ("FAILED" if bad else "a trajectory takes it, and draws the same"))
sys.exit(1 if bad else 0)
