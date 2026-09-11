"""A trajectory that is slow without Keep SSE and fast with it - measured, and
runnable by hand.

    python3 tests/make_traj.py 9FOG.cif --ca --models=15 --amp=0.15
    python3 tests/demo_keep_sse.py                         # measures both ways

BY HAND, which is the point of this file:

  1. `python3 tests/make_traj.py 9FOG.cif --ca --models=15 --amp=0.15`
  2. Open index.html (or dev.html) and drop `_traj_9fog.pdb` on it.
  3. Set the style to **Cartoon** - 9FOG is 3,348 residues, and above
     LARGE_MOLECULE_CUTOFF (1,000 segments) the app picks Tube on its own. Tube
     is already fast; the ribbon is what this is about.
  4. Press the speed button twice, to **4x**.
  5. Press **Play**. Count the frame counter for a few seconds.
  6. Press **SSE** in the frame strip. Play again.

🔴 AT 1x YOU WILL SEE ALMOST NOTHING, AND THAT IS NOT A BUG. Playback is driven
by a timer at 100 ms a frame, so anything that draws in under 100 ms plays at
the same rate however cheap it is. Measured on this structure at 1x: 7.5 fps
against 8.8. At 4x the timer is 25 ms and the frame cost is what is left, which
is the thing being demonstrated:

    9FOG, 3,348 residues, cartoon, 4x     7.6-7.8 fps  ->  25.2-26.0

🔴 THE AMPLITUDE IS 0.15 A AND NOT 0.45 FOR A REASON. At 0.45 this structure
has one CA-CA pair sitting on the connectivity threshold, and the breath pushes
it across: the segment count goes 3336 -> 3337 -> 3336, twice a cycle. That is a
real change of topology, so the fast path correctly stands down and the frame
rebuilds - 25 ms becomes 200, twice every fifteen frames, which is exactly the
periodic hitch it looks like.

🔴 AND THE SAME FLICKER IS A VISUAL FAULT, INDEPENDENTLY OF ANY OF THIS. A
segment appearing and disappearing between frames means the ribbon breaks and
rejoins. The connectivity test has no hysteresis, so a pair near the threshold
will do this on any trajectory, on either path, whether or not anyone is
measuring. Worth fixing where the threshold is, not here.

🔴 AND THE ARMS ARE RUN IN BOTH ORDERS. Plain first and Keep SSE second lets any
warm-up - a compiled shader, a filled cache - land on the second arm and look
like the feature. Reversed, the bias points the other way. Both are reported.
"""
import json, os, subprocess, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_demokeepsse.html")
PORT = 9851
DEBUG_PORT = 9852
FILE = sys.argv[1] if len(sys.argv) > 1 else "_traj_9fog.pdb"
SECONDS = 5

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, seconds) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 180000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 180000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    // Cartoon, explicitly: above LARGE_MOLECULE_CUTOFF the app picks Tube.
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    // ...and the fastest playback, because at 1x the timer is the limit and
    // the frame cost never shows. See the header.
    r.animationSpeed = r.speedOptions ? Math.min(...r.speedOptions) : 25;
    if (r._updateSpeedButtonLabel) r._updateSpeedButtonLabel();
    const play = document.querySelector('#playButton');
    const sse = document.querySelector('#keepSseButton');
    if (!play || !sse) return {error: 'no play or SSE button on this page'};

    const run = async () => {
      let last = r.currentFrame; let frames = 0; let stop = false;
      const t0 = performance.now();
      const tick = () => {
        if (stop) return;
        if (r.currentFrame !== last) { last = r.currentFrame; frames += 1; }
        requestAnimationFrame(tick);
      };
      play.click(); requestAnimationFrame(tick);
      await new Promise((s) => setTimeout(s, seconds * 1000));
      stop = true; play.click(); await settle(4);
      return +(frames * 1000 / (performance.now() - t0)).toFixed(2);
    };

    const plainFirst = await run();
    sse.click(); await settle(8);
    const on = !!r.stableTopology;
    const sseFirst = await run();
    const sseSecond = await run();
    sse.click(); await settle(8);
    const plainLast = await run();
    return {file, positions: r.coords.length, style: r.style, sseWasOn: on,
            speedMs: r.animationSpeed,
            plainFirst, plainLast, sseFirst, sseSecond};
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
    src = "9FOG.cif"
    if not os.path.exists(os.path.join(ROOT, src)):
        sys.exit(f"{FILE} is not here and neither is {src} to build it from")
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py"),
                    src, "--ca", "--models=15", "--amp=0.15"], cwd=ROOT, check=True)

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-demokeepsse"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_demokeepsse.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {SECONDS}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

plain = max(out["plainFirst"], out["plainLast"])
keep = max(out["sseFirst"], out["sseSecond"])
print(f"{out['file']}: {out['positions']} residues, style {out['style']},"
      f" {out['speedMs']} ms a frame")
print(f"  plain    {out['plainFirst']:>6.2f} fps first, {out['plainLast']:>6.2f} last")
print(f"  Keep SSE {out['sseFirst']:>6.2f} fps first, {out['sseSecond']:>6.2f} second")
print(f"  -> {plain:.1f} fps against {keep:.1f}   ({keep / max(plain, 1e-9):.2f}x)")

bad = []
if not out["sseWasOn"]:
    bad.append("pressing the button did not turn Keep SSE on, so both arms are"
               " the same arm")
if keep <= plain * 1.2:
    bad.append(f"Keep SSE gave {keep:.1f} fps against {plain:.1f} - this"
               " structure is not big enough for the frame cost to show over"
               " the playback timer, so it is a poor demonstration whatever"
               " else is true")

print()
for b in bad:
    print("FAIL: " + b)
print("demo: " + ("FAILED" if bad else "visibly faster with the button"))
sys.exit(1 if bad else 0)
