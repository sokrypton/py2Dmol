"""An eye toggle in TUBE style comes back to the instance buffer it built.

    python3 tests/gpu_tube_reuse.py                  # 6MRR + 4HHB
    python3 tests/gpu_tube_reuse.py 4UG0.cif 6MRR.cif

The cartoon's mesh already works this way (tests/gpu_mesh_reuse.py). The tube
kept the same state loose - a buffer, a count, a centre, a density, four
module variables - and threw all of it away on every toggle. It is cheap to
rebuild, so this is not really about the milliseconds; it is that a build's
output should be ONE value that ONE function installs, which is what stopped
the cartoon's restore from forgetting a piece.

Two things had to change for the slot to ever hit: the shared geometry key had
to stop asking for the coordinate array by identity (the merge is rebuilt for
the same picture), and the tube's colours had to be keyed by CONTENT, since
the app rebuilds the colour array from scratch whenever the drawn set changes.

What this checks: the toggle stops rebuilding, and - the part that matters -
the restored picture is IDENTICAL to what a fresh build draws, with picking
landing on the same residues.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_tubereuse.html")
# smaller first, for the reason gpu_mesh_reuse.py gives at greater length:
# several things a build decides are sized by the structure
FILES = sys.argv[1:] or ["6MRR.cif", "4HHB.cif"]

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  // FRAMES AND ANSWERS, NOT MILLISECONDS. Each step here is a call and a
  // render, and what has to happen before the next line reads the result is
  // that the browser has painted: three animation frames say that in 50 ms
  // where a flat 1,500 said it in 1,500. Where the work is ASYNCHRONOUS - a
  // file parsed, a session restored - the probe waits for the answer instead,
  // which is both faster and steadier than guessing a duration.
  const settle = async (n = 3) => {
    for (let k = 0; k < n; k++) {
      await new Promise((s) => requestAnimationFrame(() => s()));
    }
  };
  const until = async (cond, ms = 4000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (cond()) return true;
      await settle();
    }
    return false;
  };
  const loaded = () => {
    const v = window.py2dmol_viewers && window.py2dmol_viewers['standalone-viewer-1'];
    return !!(v && v.renderer && v.renderer.coords && v.renderer.coords.length);
  };
  const go = async () => {
    const R = {toggles: []};
    try {
      const P = new URLSearchParams(location.search);
      for (const f of P.get('files').split(',')) { await load(f); await until(loaded); await settle(); }
      await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = true;
      r.styleChosen = true;
      r.setStyle('tube');
      await settle();
      R.n = r.coords.length;
      R.gpuDrew = r.gpuDrewLastFrame;
      const names = Object.keys(r.objectsData);
      const shot = () => r.canvas.toDataURL('image/png');
      const pick = () => {
        r._ensurePickProjection();
        const rect = r.canvas.getBoundingClientRect();
        const out = [];
        for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.6], [0.6, 0.45]]) {
          out.push(r.pickResidueAt(rect.left + rect.width * fx,
                                   rect.top + rect.height * fy));
        }
        return out.join(',');
      };
      const builds = () => (window.__tubeBuilds || 0);

      const both = [names[0], names[1]];
      // the SECOND object alone: hiding the first shifts every position after
      // it, so a value restored with stale positions puts clicks elsewhere
      const one = [names[1]];
      r.setShownObjects(both); await settle();
      r.setShownObjects(one); await settle();
      // the references come from FORCED builds, never from a restore - a
      // restore compared against itself agrees no matter what it dropped
      const freshShot = async (want) => {
        r.setShownObjects(want); await settle();
        window.py2dmolCartoonGPU.invalidate();
        r.render('forced rebuild'); await settle();
        return {png: shot(), pick: pick()};
      };
      const bothFresh = await freshShot(both);
      const oneFresh = await freshShot(one);

      for (let k = 0; k < 4; k++) {
        const want = k % 2 === 0 ? both : one;
        const b0 = builds();
        const t = performance.now();
        r.setShownObjects(want);
        const ms = performance.now() - t;
        await settle();
        const ref = k % 2 === 0 ? bothFresh : oneFresh;
        R.toggles.push({
          shown: want.length, ms: Math.round(ms),
          rebuilt: builds() !== b0,
          same: shot() === ref.png,
          pickSame: pick() === ref.pick,
          pick: pick(),
        });
      }
      R.spare = window.__spareTube ? window.__spareTube.bytes : null;

      // A RECOLOUR IS STILL A REBUILD - the colours are IN the instances, so a
      // buffer put back for a picture drawn in other colours would be wrong.
      {
        // ...and ask what the COLOURS did, not just the mode: with a merge up
        // the app resolves 'auto' per object and can ignore a global mode, in
        // which case there is no colour change for the buffer to notice.
        const digest = () => (r.colors || []).map(
          (c) => (c ? (c.r << 16 | c.g << 8 | c.b) : -1)).join(',');
        const b0 = builds();
        const before = shot();
        const d0 = digest();
        r.colorMode = 'rainbow'; r.colorsNeedUpdate = true;
        r.render('recolour'); await settle();
        R.recolour = {rebuilt: builds() !== b0, changed: shot() !== before,
                      coloursChanged: digest() !== d0};
      }
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
src = open(os.path.join(ROOT, "index.html")).read()
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9757), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-tubereuse",
                      "--no-first-run", "--window-size=900,900",
                      "http://127.0.0.1:9757/_tubereuse.html?files=" + ",".join(FILES)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + 400
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-tubereuse", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"{'+'.join(FILES)}: {R.get('n')} positions, GPU drew: {R.get('gpuDrew')},"
      f" spare tube {round((R.get('spare') or 0) / 1e6, 1)} MB")
bad = []
if not R.get("gpuDrew"):
    bad.append("the GPU path did not draw, so nothing here was measured")
for i, t in enumerate(R["toggles"]):
    print(f"  toggle {i + 1}: {t['shown']} object(s), {t['ms']:>5} ms,"
          f" rebuilt={t['rebuilt']}, same picture={t['same']},"
          f" same picks={t['pickSame']} ({t['pick']})")
    if not t["same"]:
        bad.append(f"toggle {i + 1}: the picture differs from a fresh build")
    if not t["pickSame"]:
        bad.append(f"toggle {i + 1}: picking moved - the buffer came back"
                   " without the positions it was built with")
# the first two builds the second picture (the forced references threw the slot
# away); every toggle after that must come out of the slot
later = R["toggles"][2:]
if any(t["rebuilt"] for t in later):
    bad.append("a toggle back to a buffer already built rebuilt it anyway: "
               + str([t["rebuilt"] for t in R["toggles"]]))
rc = R.get("recolour") or {}
print(f"  recolour: colours changed={rc.get('coloursChanged')},"
      f" rebuilt={rc.get('rebuilt')}, picture changed={rc.get('changed')}")
if rc.get("coloursChanged"):
    if not rc.get("rebuilt") or not rc.get("changed"):
        bad.append("a recolour did not rebuild the instances, which carry the"
                   " colours: " + str(rc))
else:
    print("    (the app kept the same colours here - nothing to notice)")
for b in bad:
    print("FAIL: " + b)
sys.exit(1 if bad else 0)
