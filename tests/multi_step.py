"""A FRAME STEP WITH SEVERAL OBJECTS DRAWN MUST NOT REBUILD THE MESH.

    python3 tests/multi_step.py

🔴 THE DRAWN EXTENT WAS MEASURED FROM THE FRAME SHOWING, AND maxExtent IS IN
THE MESH'S TOPOLOGICAL SIGNATURE. `_recomputeObjectStats` walks every frame of
an object, so one object's centre, extent and spread do not depend on which
frame is drawn; the merge measured the merged coordinate array instead - the
current frame's - so the extent moved a little on every step (119.85 -> 120.05
-> 120.71 on a 20-frame ensemble beside a nucleosome). The station fast path
compares that signature, read the drift as "different geometry", and rebuilt
the WHOLE mesh every step: 20,406 ribbon faces of a structure that had not
moved. Measured 42-59 ms a step against 21-25 after.

Reported as "we are rebuilding for multi-object frame advancements".

WHAT IT ASKS, and the first two are one question from two sides:

  * the trajectory ALONE takes the station path - the control, because if it
    does not then this fixture says nothing about the merge;
  * the same trajectory WITH a second object still takes it;
  * the drawn extent does not move as the frames step, which is the cause and
    is also a picture bug on its own (the camera breathed);
  * and the fast path DRAWS WHAT A REBUILD DRAWS, forced with invalidate() -
    because "no rebuild" is worth nothing if the picture is wrong.

The pixel leg compares the station path against a rebuild NOW rather than
against a stored image: the extent changed meaning, so the framing legitimately
differs from before the change. GPU pixels are also not comparable across page
loads (see the notes in CLAUDE.md), and both arms here are one load.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_multistep.html")
TRAJ = "1YNE.cif"     # 20 models
STATIC = "1AOI.cif"   # a nucleosome: the ballast that makes a rebuild visible

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {legs: []};
    try {
      await load('%s'); await until(loaded); await settle(4);
      await load('%s'); await until(loaded); await settle(4);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      const G = window.py2dmolCartoonGPU;
      if (!r.useGPU || !G) { R.skip = 'no WebGL2'; throw new Error('skip'); }
      const named = Object.keys(r.objectsData).map(
        (n) => [n, r.objectsData[n].frames.length]);
      const traj = named.filter((o) => o[1] > 1).map((o) => o[0])[0];
      const stat = named.filter((o) => o[1] === 1).map((o) => o[0])[0];
      R.objects = named;
      if (!traj || !stat) throw new Error('fixture: need one trajectory and one static object');

      const run = async (label, names) => {
        r._switchToObject(traj);
        r.setShownObjects(names, false, {reframe: true});
        await settle(6);
        r.setFrame(0); await settle(4);
        const rows = [];
        for (let t = 1; t < 6; t++) {
          window.__faceBuilds = 0; window.__stationFastPath = 0;
          const t0 = performance.now();
          r.setFrame(t);
          const ms = +(performance.now() - t0).toFixed(1);
          await settle(3);
          rows.push({t, ms, builds: window.__faceBuilds,
                     fast: window.__stationFastPath,
                     // the cause, read straight off the renderer
                     extent: +(r.drawnStats().maxExtent).toFixed(4),
                     why: (G.stationDecline && G.stationDecline()) || null});
        }
        R.legs.push({label, n: r.coords.length, rows});
      };

      await run('alone', [traj]);
      await run('merged', [traj, stat]);

      // ...AND THE FAST PATH DRAWS WHAT A REBUILD DRAWS.
      const shot = () => {
        const c2 = document.createElement('canvas');
        c2.width = r.canvas.width; c2.height = r.canvas.height;
        c2.getContext('2d').drawImage(r.canvas, 0, 0);
        return c2.getContext('2d').getImageData(0, 0, c2.width, c2.height);
      };
      r.setFrame(0); await settle(4);
      r.setFrame(4); await settle(4);
      const viaStation = shot();
      G.invalidate();
      r.render('forced rebuild'); await settle(4);
      const viaRebuild = shot();
      let diff = 0; let worst = 0; let ink = 0;
      for (let i = 0; i < viaStation.data.length; i += 4) {
        const a = viaStation.data;
        if (a[i] < 245 || a[i + 1] < 245 || a[i + 2] < 245) ink++;
        let d = 0;
        for (let k = 0; k < 3; k++) {
          d = Math.max(d, Math.abs(a[i + k] - viaRebuild.data[i + k]));
        }
        if (d > worst) worst = d;
        if (d > 8) diff++;
      }
      R.pixels = {diff, worst, ink, total: viaStation.data.length / 4};
    } catch (e) {
      if (!R.skip) R.error = String((e && e.stack) || e);
    }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
""" % (TRAJ, STATIC)
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS)
src = open(os.path.join(ROOT, "dev.html")).read()
stamp = str(int(time.time() * 1000))
src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
             lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
open(PROBE, "w").write(src.replace("</body>", JS + "</body>"))
box = []


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9793), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-multistep",
                      "--no-first-run", "--window-size=900,700",
                      "http://127.0.0.1:9793/_multistep.html"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-multistep", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("skip"):
    print("  skipped:", R["skip"])
    sys.exit(0)
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
print(f"  {R.get('objects')}")
legs = {leg["label"]: leg for leg in R.get("legs") or []}
for label in ("alone", "merged"):
    leg = legs.get(label)
    if not leg:
        bad.append(f"the {label} leg did not run")
        continue
    rows = leg["rows"]
    builds = sum(row["builds"] for row in rows)
    fast = sum(row["fast"] for row in rows)
    ms = [row["ms"] for row in rows]
    extents = sorted({row["extent"] for row in rows})
    print(f"  {label:<7} n={leg['n']:<5} builds={builds} fast={fast}"
          f" ms={ms} extent={extents if len(extents) < 4 else str(extents[0]) + '..' + str(extents[-1])}")
    why = [row["why"] for row in rows if row["why"]]
    if why:
        print(f"          declined: {why[0]}")
    if builds:
        bad.append(f"{label}: {builds} of {len(rows)} frame steps rebuilt the"
                   f" mesh - {why[0] if why else 'no reason recorded'}")
    if fast != len(rows):
        bad.append(f"{label}: only {fast} of {len(rows)} steps took the station"
                   " fast path")
    # 🔴 THE CAUSE, ASKED DIRECTLY. Without this the probe passes as soon as
    # the extent happens to be in or out of a signature, and says nothing about
    # the camera breathing - which is the same fault seen from the picture.
    if len(extents) != 1:
        bad.append(f"{label}: the drawn extent moved across the frames"
                   f" ({extents[0]} .. {extents[-1]}) - it is measured over"
                   " every frame, so which one is showing must not change it")

px = R.get("pixels") or {}
print(f"  station path vs a forced rebuild: {px.get('diff')} of {px.get('total')}"
      f" pixels differ, worst channel {px.get('worst')}, ink {px.get('ink')}")
if not px.get("ink"):
    bad.append("the canvas is blank, so the pixel comparison proves nothing")
elif (px.get("diff") or 0) > px["total"] // 1000:
    bad.append(f"the station path drew {px['diff']} pixels differently from a"
               f" rebuild (worst channel {px['worst']}) - the steps are cheap"
               " and the picture is wrong, which is worse than rebuilding")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
