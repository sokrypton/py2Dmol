"""HOW BIG A PARTIAL REBUILD'S WINDOW WOULD ACTUALLY BE.

    python3 tests/splice_window.py [_traj_1tim.pdb] [steps]

A declining step is one where the station mapping moved, and the idea behind a
partial rebuild is that it moved only a little: the new face list should be the
old one with a WINDOW replaced and every index after it shifted by a constant.
tests/PERF_NOTES.md recorded that decomposition as validated, from one frame of
_traj_1tim.pdb - head 6686, window 9, tail 249 of 6944 rows.

🔴 OVER A WHOLE TRAJECTORY IT DOES NOT HOLD, AND THAT ONE FRAME WAS LUCKY.

    _traj_1tim.pdb, 15 declining steps, window as a share of 6,930 faces
    0, 0, 0.1%, 0.1%, 0.2%, 0.2%, 6.4%, 7.9%, 9.5%, 16%, 29%, 61%, 65%, 82%

    _traj_9fog.pdb, 10 declining steps, of 46,463 faces
    64%, 74%, 74%, 74%, 87%, 88%, 93%, 96%, 96%, 96%

The cause is that a step moves SEVERAL runs at once - a median 16 of ~579 on
9FOG - scattered along the chain. Each changed run shifts the indices after it
by its own amount, so a single head/window/tail decomposition collapses
everything between the FIRST and LAST change into one window, however little
actually moved in between.

So the partial rebuild needs a PIECEWISE decomposition, one window per changed
run, driven by diffing the secondary-structure assignment rather than the face
mapping - which is what PERF_NOTES already said the window rule had to be, and
is a larger thing than splicing one window.

This file is the instrument that says so. It asserts the ARITHMETIC of the plan
- that replaying head, window and shifted tail reproduces the new mapping
exactly - and reports the sizes without judging them, because what counts as
small enough is a decision the piecewise version will make, not this one.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_splicewindow.html")
PORT = 9913
DEBUG_PORT = 9914
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILE = ARGS[0] if ARGS else "_traj_1tim.pdb"
STEPS = int(ARGS[1]) if len(ARGS) > 1 else 30

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, steps) => {
   try {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    // CARTOON, because the station table describes ribbon pieces and above
    // LARGE_MOLECULE_CUTOFF the page would pick tube on its own.
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    const G = window.py2dmolCartoonGPU;
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    const rows = [];
    r.setFrame(0); await settle(2);
    for (let i = 1; i <= steps; i++) {
      const face0 = window.__faceBuilds || 0;
      r.setFrame(i % frames); await settle(1);
      const rebuilt = (window.__faceBuilds || 0) !== face0;
      const st = G.stationsResident ? G.stationsResident() : null;
      rows.push({rebuilt, plan: G.stationSplice ? G.stationSplice() : null,
                 faces: st ? st.count : -1,
                 why: G.stationDecline ? G.stationDecline() : null});
    }
    return {frames, steps, rows};
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
profile_dir = "/tmp/py2dmol-splicewindow"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_splicewindow.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {STEPS}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"][:300])

bad = []
shares = []
declines = 0
planned = 0
print(f"{FILE}: {out['steps']} steps")
# 🔴 THE FIRST STEP IS NOT A DECLINE. It rebuilds because there is no previous
# topological key to compare against - the walk starting, not a mapping that
# moved - and counting it made this file report "1 step declined and not one
# produced a splice plan", which is a plan that could not exist rather than one
# that failed to be found.
# 🔴 AND A KEY MOVE IS NOT A MAPPING MOVE. The topological key carries things
# the station table cannot answer for even when the mapping is untouched - the
# strand SET is one, because the outline's edge count is baked per strand face -
# and a decline of that kind has no splice to find: the face-to-station mapping
# is identical, so there is no window to decompose. Counting those as candidates
# made this file report "11 steps declined and not one produced a splice plan",
# which is a plan that cannot exist rather than one that was not found.
first_only = 0
key_only = 0
for i, row in enumerate(out["rows"]):
    if not row["rebuilt"]:
        continue
    why = str(row.get("why") or "")
    if 'no previous topological key' in why:
        first_only += 1
        continue
    if 'the topological key moved' in why:
        key_only += 1
        continue
    declines += 1
    p = row.get("plan")
    if not p:
        print(f"  step {i + 1:>3}  no plan   {str(row['why'])[:74]}")
        continue
    planned += 1
    total = max(p["prevCount"], p["nextCount"], 1)
    win = max(p["prevTo"] - p["head"], p["nextTo"] - p["head"])
    shares.append(win / total)
    print(f"  step {i + 1:>3}  head {p['head']:>6}"
          f"  window {p['prevTo'] - p['head']:>6} -> {p['nextTo'] - p['head']:<6}"
          f"  tail {p['prevCount'] - p['prevTo']:>6}"
          f"  dStation {p['dStation']:>4}  ({100 * win / total:5.1f}% of {total})")

if shares:
    shares.sort()
    med = shares[len(shares) // 2]
    print(f"  windows: median {100 * med:.1f}%, smallest {100 * shares[0]:.1f}%,"
          f" largest {100 * shares[-1]:.1f}% of the face list")

# 🔴 THE ARITHMETIC IS THE ASSERTION, NOT THE SIZE. stationSplicePlan returns
# null rather than a plan whose replay does not reproduce the new mapping, so a
# plan that comes back at all has already been checked against both arrays.
# What this file must not do is pass while producing no plans - then it is
# reporting on nothing.
if declines and not planned:
    bad.append(f"{declines} step(s) declined and not one produced a splice"
               " plan. Either the decomposition never exists on this"
               " trajectory - which is itself the finding - or"
               " stationSplicePlan is returning null for a reason that has"
               " nothing to do with the mapping: it needs faceStation,"
               " faceSurf and facePiece kept on the resident table, and"
               " faceSurf was the one that was not")
# 🔴 AND NOTHING DECLINING IS NOW THE ORDINARY CASE, NOT A BROKEN FIXTURE.
# This used to fail there, on the grounds that a secondary structure that moves
# makes the mapping move. It does not any more: the ribbon is built one way for
# every letter and the arrowhead costs no station, so an assignment can drift
# through a whole trajectory without the face list changing at all
# (tests/ss_axis.py, tests/arrow_rebuilds.py). What still declines is a change
# of TOPOLOGY proper - a segment splitting when a CA-CA distance crosses the
# connectivity threshold, which tests/demo_keep_sse.py describes on 9FOG at an
# amplitude of 0.45 - so that is what this file wants pointed at it.
if key_only:
    print(f"  {key_only} step(s) declined on the topological KEY with the"
          " mapping untouched - the strand set, for the outline's baked edge"
          " count. Those have no window to decompose; they are the case a"
          " cheaper repair would take, rebuilding the edge table alone.")
if not declines:
    print(f"  not exercised: no step of {FILE} declined on the MAPPING"
          + (f" ({first_only} first-step rebuild(s), which is the walk"
             " starting)" if first_only else "")
          + ". A drifting assignment no longer moves the mapping; what does is"
          " a segment appearing or splitting, so this wants a trajectory whose"
          " CONNECTIVITY flickers rather than one whose letters do.")

print()
for b in bad:
    print("FAIL: " + b)
print("splice window: " + ("FAILED" if bad else "sized"))
sys.exit(1 if bad else 0)
