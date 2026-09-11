"""Does Keep SSE make PLAYBACK faster, or only the loop a benchmark runs?

    python3 tests/anim_playback.py [_traj_1tim.pdb]

WHY SEPARATELY FROM tests/stable_topology.py. That gate times
`setFrame(); render()` back to back, which is the cost of a frame and not the
rate a reader sees. Playback is driven by a timer at a speed the speed button
sets, so a structure cheap enough to draw inside that interval runs at the same
rate either way and the option buys nothing visible - the work comes off a
budget that was not full. This presses Play and counts frames.

Arms alternate, three each, because this machine drifts.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_animplay.html")
PORT = 9787
DEBUG_PORT = 9788
FILES = sys.argv[1:] or ["_traj_1tim.pdb", "_traj_1aoi.pdb"]
SECONDS = 4

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__play = async (file, seconds) => {
    const txt = await (await fetch('/' + file)).text();
    await window.processFiles(
      [{name: file, readAsync: () => Promise.resolve(txt)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(5);
    await until(() => !r._quietStyle && !r._switchQuiet, 20000);
    const play = document.querySelector('#playButton');
    const sse = document.querySelector('#keepSseButton');

    // ONE RUN OF PLAYBACK, counting the frames that actually reached the
    // screen. `currentFrame` changing is the advance; rAF is when the browser
    // painted. Both are recorded because they answer different questions.
    const run = async (keep) => {
      if (!!r.stableTopology !== keep) { sse.click(); await settle(3); }
      const seen = [];
      let last = r.currentFrame;
      let stop = false;
      const t0 = performance.now();
      let frames = 0;
      const tick = () => {
        if (stop) return;
        if (r.currentFrame !== last) { last = r.currentFrame; frames += 1;
          seen.push(performance.now() - t0); }
        requestAnimationFrame(tick);
      };
      play.click();                                   // start
      requestAnimationFrame(tick);
      await new Promise((s) => setTimeout(s, seconds * 1000));
      stop = true;
      play.click();                                   // stop
      await settle(3);
      const ms = performance.now() - t0;
      const gaps = seen.slice(1).map((v, i) => v - seen[i]).sort((a, b) => a - b);
      return {fps: (frames * 1000) / ms, frames,
              medianGapMs: gaps.length ? gaps[gaps.length >> 1] : null};
    };
    const off = []; const on = [];
    for (let k = 0; k < 3; k++) { off.push(await run(false)); on.push(await run(true)); }
    if (r.stableTopology) { sse.click(); await settle(3); }
    const med = (v, f) => [...v.map(f)].sort((a, b) => a - b)[v.length >> 1];
    return {file, positions: r.coords.length,
            off: {fps: med(off, (x) => x.fps), gap: med(off, (x) => x.medianGapMs)},
            on: {fps: med(on, (x) => x.fps), gap: med(on, (x) => x.medianGapMs)}};
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
profile_dir = "/tmp/py2dmol-animplay"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_animplay.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the page to load")

rows = []
for f in FILES:
    rows.append(json.loads(cdp.evaluate(
        ws, f"window.__play({json.dumps(f)}, {SECONDS}).then(JSON.stringify)")))

chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

print(f"{'trajectory':<20} {'pos':>5}  {'off fps':>8} {'on fps':>8} {'':>6}"
      f"  {'off gap':>8} {'on gap':>8}")
for r in rows:
    sp = r["on"]["fps"] / max(r["off"]["fps"], 1e-9)
    print(f"{r['file']:<20} {r['positions']:>5}  {r['off']['fps']:>8.1f}"
          f" {r['on']['fps']:>8.1f} {sp:>5.2f}x"
          f"  {r['off']['gap']:>7.1f}ms {r['on']['gap']:>7.1f}ms")
