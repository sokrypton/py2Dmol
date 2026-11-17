"""A DUPLEX STREAMED IN FRAME BY FRAME PAIRS LIKE THE SAME DUPLEX LOADED WHOLE.

    python3 tests/pair_append.py

Which base pairs with which is predicted once and cached - keyed on what is
drawn and how long the array is, deliberately NOT on the frame, so a finished
trajectory keeps one pairing and its steps stay on the station fast path
(src/cartoon/geom.js, "WHICH BASE PAIRS WITH WHICH BELONGS TO THE MOLECULE").

A trajectory that is still ARRIVING broke that. LocalFold builds the viewer on
a diffusion's first frame - noise, where nothing is near its partner - and
appends the rest with addFrame. The cache was filled from the noise and the
key never moved, so a protein + DNA fold drew its duplex with no base pairs,
while the same file reloaded in py2Dmol (which opens on the last frame) drew
them. The key carries each drawn object's FRAME COUNT now: an appended frame is
new data and is asked again; stepping through frames that are already there is
not.

Three legs, on 1BNA (a B-DNA dodecamer):
  * control - the duplex loaded on its own: how many pairs it has;
  * the report - the same duplex with its atoms scattered as frame 0, the real
    one appended and shown: the same count, not zero;
  * playback - stepping back to the noise and forward again does not move the
    pairing (the fast-path half of the rule).
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_pairappend.html")
FIXTURE = os.path.join(ROOT, "1BNA.cif")
PORT = 9971
DEBUG_PORT = 9972

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="a" style="width:400px;height:300px"></div>
<div id="b" style="width:400px;height:300px"></div>
<script src="py2Dmol/resources/bundles/py2Dmol.full.min.js"></script>
<script>
window.__ready = false;
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('load', () => {
  //HELPERS
  const pairs = (v) => {
    const p = v._cartoonPair;
    if (!p) return -1;
    let k = 0;
    for (let i = 0; i < p.length; i++) if (p[i] > i) k += 1;
    return k;
  };
  // Scatter every atom by up to 30 A: a diffusion's first frame, where no
  // base sits near its partner. Same atoms, same names, same count.
  const scatter = (text) => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const f = py2Dmol.frameFromText(text);
    f.coords = f.coords.map((c) => [c[0] + 60 * (rnd() - 0.5),
                                    c[1] + 60 * (rnd() - 0.5),
                                    c[2] + 60 * (rnd() - 0.5)]);
    return f;
  };
  window.__go = async (text) => {
    try {
      const out = {};
      // CONTROL: the duplex on its own.
      const c = py2Dmol.show(document.getElementById('a'), text, { style: 'cartoon' });
      await until(() => c.coords && c.coords.length, 20000);
      c.render('probe'); await settle(3);
      out.control = pairs(c);

      // THE REPORT: built on noise, the real duplex appended - LocalFold's order.
      const v = py2Dmol.show(document.getElementById('b'), text, { style: 'cartoon' });
      await until(() => v.coords && v.coords.length, 20000);
      const obj = v.currentObjectName;
      v.replaceFrame(scatter(text), obj);          // frame 0 is noise
      v.setFrame(0); v.render('probe'); await settle(3);
      out.noise = pairs(v);
      v.addFrame(py2Dmol.frameFromText(text), obj);
      v.setFrame(1); v.render('probe'); await settle(3);
      out.appended = pairs(v);
      out.frames = v.objectsData[obj].frames.length;

      // PLAYBACK: the frames are all there now; stepping must not re-predict.
      const before = v._cartoonPair;
      v.setFrame(0); v.render('probe'); await settle(3);
      out.backAtNoise = pairs(v);
      out.sameArrayAtNoise = v._cartoonPair === before;
      v.setFrame(1); v.render('probe'); await settle(3);
      out.forwardAgain = pairs(v);
      out.errors = window.__errors;
      return out;
    } catch (e) { return { error: String((e && e.stack) || e) }; }
  };
  window.__ready = true;
});
</script></body></html>"""

if not os.path.exists(FIXTURE):
    print("FAIL: needs 1BNA.cif in the repo root (a local fixture, like 1UBQ.cif)")
    sys.exit(1)
TEXT = open(FIXTURE).read()

with open(PROBE, "w") as fh:
    fh.write(PAGE.replace("//HELPERS", HELPERS))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-pairappend-prof"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
bad = []
try:
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_pairappend.html")
    cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
    res = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(TEXT)}).then(JSON.stringify)"))
finally:
    chrome.kill()
    httpd.shutdown()
    try:
        os.remove(PROBE)
    except OSError:
        pass
    shutil.rmtree(profile_dir, ignore_errors=True)

print(json.dumps(res))
if res.get("error"):
    bad.append("the page threw: " + res["error"])
else:
    if res["control"] < 8:
        bad.append("control: 1BNA alone gave %d pairs - the fixture is not measuring"
                   % res["control"])
    if res["noise"] >= res["control"]:
        bad.append("the scattered frame still pairs (%d) - it is not noise" % res["noise"])
    if res["appended"] != res["control"]:
        bad.append("appended after noise: %d pairs against %d loaded whole - the"
                   " pairing was kept from the frame it was first asked on"
                   % (res["appended"], res["control"]))
    if not res["sameArrayAtNoise"] or res["forwardAgain"] != res["appended"]:
        bad.append("stepping through frames that were already there re-predicted"
                   " the pairing (%s) - playback would leave the fast path" % res)
    if res.get("errors"):
        bad.append("page errors: %s" % res["errors"])

if bad:
    for b in bad:
        print("FAIL " + b)
    sys.exit(1)
print("ok")
