"""A PANEL WITH NOTHING NEW TO SHOW DOES NOTHING PER FRAME.

    python3 tests/panel_idle.py [_traj_1tim.pdb]

Most structures have no PAE and no contact map, and the heatmap panel is hidden
on all of them. It was still doing a full round of work on every trajectory
step: `setMaps` guards on the map ENTRY being the one it already holds, and an
empty set has no entry, so the guard could never fire on a structure with no
maps at all. Each step ran `_selectMap`, `_loadMatrix(null)` and a relayout -
which reads `clientWidth` (a forced layout) and assigns `canvas.width` (a
reallocation, and a clear).

Measured on `_traj_1tim.pdb`, 30 steps, before the guard: 60 relayouts, 60
selects, 60 loads, 0.23 ms a step - 1.7% of the step in a sampling profile,
which is where it was found. After: 0, 0, 0.

🔴 SIXTY OVER THIRTY STEPS, NOT THIRTY. `setFrame` asks the panel twice - once
from `_loadFrameData` and once at its own end - and both arrive with the same
answer. The duplicate is left standing because the guard makes it free; if this
file ever reports an odd multiple, that second call is where to look.

🔴 AND THE PANEL THAT HAS SOMETHING TO SHOW IS NOT THIS FILE'S SUBJECT. It is
allowed to work, and tests/heatmap_maps.py is what holds it to drawing the right
thing. The claim here is only about the empty case.

THE SEQUENCE STRIP, for the same reason and with a different cause. Its
"is this the same strip?" early-out had been dead since it was written: the four
lines that clear the cache ran ABOVE the test, and one of them nulls the very
field the test asks about. So the strip was rebuilt from nothing on every call -
a new canvas, a new layout, every cell re-measured, and the scroll position lost.
And the key it compared included the FRAME NUMBER, so even alive it would have
rebuilt on every step of a trajectory, to draw letter for letter the strip it
replaced. Keyed on the content instead, hashed over exactly what the build
reads.

Measured on _traj_1tim.pdb, 494 residues, 30 steps: 1.29 ms a step and 30
rebuilds, against 0.27 ms and 0. The 0.27 that is left is the sections being
built to be hashed - 494 entry objects a step - which is a smaller thing and is
recorded here rather than fixed.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_panelidle.html")
PORT = 9871
DEBUG_PORT = 9872
FILE = sys.argv[1] if len(sys.argv) > 1 else "_traj_1tim.pdb"
STEPS = 30

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, steps) => {
   try {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 120000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const hm = r.heatmapRenderer;
    if (!hm) return {error: 'no heatmapRenderer on this page'};
    window.__seqBuilds = 0; window.__seqRebuilds = 0; window.__seqMs = 0;
    let relayouts = 0, selects = 0, loads = 0, ms = 0;
    const realRelayout = hm._relayout;
    if (realRelayout) hm._relayout = function () {
      relayouts += 1; const t0 = performance.now();
      const v = realRelayout.apply(this, arguments); ms += performance.now() - t0;
      return v;
    };
    const realSelect = hm._selectMap.bind(hm);
    hm._selectMap = (...a) => { selects += 1; return realSelect(...a); };
    const realLoad = hm._loadMatrix.bind(hm);
    hm._loadMatrix = (...a) => { loads += 1; return realLoad(...a); };
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    for (let i = 0; i < steps; i++) {
      r.setFrame(i % frames);
      await settle(1);
    }
    // 🔴 AND THE PANEL HAS TO BE EMPTY FOR ANY OF THIS TO BE THE CLAIM. A
    // structure that turned out to carry a map would pass this file by doing
    // legitimate work zero times, which it would not be doing.
    return {frames, steps, relayouts, selects, loads,
            relayoutMs: +ms.toFixed(2),
            seqBuilds: window.__seqBuilds || 0,
            seqRebuilds: window.__seqRebuilds || 0,
            seqMs: +(window.__seqMs || 0).toFixed(2),
            shown: !!(r.heatmapContainer
                      && r.heatmapContainer.style.display !== 'none'),
            hasMaps: !!hm.maps};
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
profile_dir = "/tmp/py2dmol-panelidle"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_panelidle.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {STEPS}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

print(f"{FILE}: {out['steps']} steps over {out['frames']} frames,"
      f" heatmap {'shown' if out['shown'] else 'hidden'},"
      f" maps {'present' if out['hasMaps'] else 'none'}")
print(f"  heatmap : relayouts {out['relayouts']}, selects {out['selects']},"
      f" matrix loads {out['loads']}, {out['relayoutMs']:.2f} ms in relayout")
print(f"  strip   : {out['seqBuilds']} calls, {out['seqRebuilds']} rebuilds,"
      f" {out['seqMs']:.2f} ms"
      f"  ({out['seqMs'] / max(out['steps'], 1):.2f} ms a step)")

bad = []
if out["hasMaps"] or out["shown"]:
    bad.append("this structure's panel has maps or is on screen, so it is not"
               " the idle case and nothing below was measured - pick a file"
               " with no PAE and no contact map")
for name, n in (("relayouts", out["relayouts"]), ("_selectMap calls",
                out["selects"]), ("_loadMatrix calls", out["loads"])):
    if n:
        bad.append(f"an empty heatmap panel did {n} {name} over"
                   f" {out['steps']} frame steps. setMaps() returns early on a"
                   " set it already holds, but only when there IS an entry to"
                   " compare - the empty set needs its own guard, and that is"
                   " what regressed")

# 🔴 THE STRIP IS ASKED ON EVERY STEP AND MUST ANSWER WITHOUT REBUILDING.
# The calls are not the fault - checkFrameChange asks, correctly, whether the
# strip has changed - so the count that matters is how many of them rebuilt it.
if out["seqRebuilds"]:
    bad.append(f"the sequence strip was rebuilt {out['seqRebuilds']} times over"
               f" {out['steps']} frame steps of one molecule. Its letters do not"
               " move between frames of a trajectory: either the content hash"
               " picked up something per-frame, or the early-out is dead again"
               " - it dies whenever the cache is cleared ABOVE the test rather"
               " than after it")

print()
for b in bad:
    print("FAIL: " + b)
print("panel idle: " + ("FAILED" if bad else "an empty panel costs nothing a frame"))
sys.exit(1 if bad else 0)
