"""HOW OFTEN A MOVING STRUCTURE PAYS FOR ITS SECONDARY STRUCTURE.

    python3 tests/ss_every.py

The assignment is cached against the coordinates (secCacheKey), so a structure that
MOVES misses the cache on every frame and is reassigned: 1.9 ms a draw on a
1,068-residue scene in protein_fighter, the largest single item left in one of its
frames. `renderer.cartoonSecEvery` is how many changed frames may share one
assignment, 1 (every frame) being what every page did before it existed.

What has to hold:

  * at the default, a moved frame reassigns - one build a frame;
  * at 3, a third of them do, and the letters drawn in between are the ones the last
    assignment gave;
  * the saving is real: the time inside the assignment falls with the count;
  * an sse override still lands on the frame it is set, interval or no: only the
    COORDINATES are allowed to go stale, and the rest of the key is compared as before.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_ssevery.html")
PORT = 9959
DEBUG_PORT = 9960

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="v" style="width:360px;height:300px"></div>
<script src="py2Dmol/resources/bundles/py2Dmol.embed.min.js"></script>
<script>
window.__ready = false;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
window.__go = async (text) => {
  try {
    // the style the assignment feeds: a cartoon, as protein_fighter draws
    const v = py2Dmol.show('v', text, { name: 'mol', style: 'richardson', controls: false, orient: false });
    await settle(1200);
    // frames the way an animation gives them: the same molecule, moved
    const template = v.objectsData.mol.frames[0];
    const base = template.coords.map((p) => [p[0], p[1], p[2]]);
    const step = (k) => v.replaceFrame({ ...template, coords: base.map((p) => [p[0] + 0.01 * k, p[1], p[2]]) }, 'mol');
    const run = async (every, n) => {
      v.cartoonSecEvery = every;
      step(0); await settle(120);
      const b0 = window.__ssBuilds || 0, t0 = window.__ssMs || 0;
      for (let k = 1; k <= n; k++) { step(k); await settle(40); }
      return { builds: (window.__ssBuilds || 0) - b0, ms: +(((window.__ssMs || 0) - t0)).toFixed(1),
               sec: (v._cartoonSec || []).join('').slice(0, 40) };
    };
    const out = { one: await run(1, 9), three: await run(3, 9) };
    // ...and a control still lands at once: an sse override inside the interval
    v.cartoonSecEvery = 3; step(100); await settle(60);
    const before = window.__ssBuilds || 0;
    v.objectsData.mol.sse = { 5: 'H', 6: 'H', 7: 'H' };   // an override lives on the object, as parts/selectpanel.js writes it
    step(101); await settle(60);
    out.overrideBuilds = (window.__ssBuilds || 0) - before;
    out.overrideTook = (v._cartoonSec || [])[6] === 'H';
    return out;
  } catch (e) { return { error: String((e && e.stack) || e) }; }
};
window.__ready = true;
</script></body></html>"""
open(PROBE, "w").write(PAGE)
TEXT = open(os.path.join(ROOT, "GABARAP_P3.pdb")).read()


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-ssevery"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_ssevery.html")
cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
res = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(TEXT)}).then(JSON.stringify)"))
chrome.kill()
httpd.shutdown()
try:
    os.remove(PROBE)
except OSError:
    pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])
for k, v in res.items():
    print(f"  {k:>16}: {json.dumps(v)}")
bad = []
if res["one"]["builds"] < 8:
    bad.append(f"at the default a moved frame did not reassign ({res['one']['builds']} builds in 9 frames)")
if res["three"]["builds"] > res["one"]["builds"] / 2:
    bad.append(f"at 3 the assignment ran {res['three']['builds']} times against {res['one']['builds']} at the default")
if res["three"]["ms"] > res["one"]["ms"] / 2:
    bad.append(f"at 3 the assignment cost {res['three']['ms']} ms against {res['one']['ms']} at the default")
if res["three"]["sec"] != res["one"]["sec"]:
    bad.append("the letters drawn at 3 are not the ones the assignment gave")
if res["overrideBuilds"] != 1 or not res["overrideTook"]:
    bad.append("an sse override did not land on the frame it was set")
print()
for b in bad:
    print("FAIL: " + b)
print("ss every: " + ("FAILED" if bad else "a moving structure reassigns as often as it is asked to, and a control still lands at once"))
sys.exit(1 if bad else 0)
