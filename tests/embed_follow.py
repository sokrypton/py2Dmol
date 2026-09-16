"""A BARE EMBED FOLLOWS ITS HOST ELEMENT.

    python3 tests/embed_follow.py

py2Dmol.show on a plain element, with no width or height asked for, sizes the
canvas from the element - and used to do so once. A host whose box is fluid
(a game filling the window, a panel the user drags) was left with a canvas of
the old size until it rebuilt the viewer itself, which is a jump: the page
at the new size, the drawing at the old, then a flash. Now the viewport
watches the host element (config.display.follow, parts/viewport.js) as it
watches #canvasContainer in the shell. What has to hold:

  * the host's box changes, and the canvas follows within a few frames,
    backing store and CSS size both, without a mesh rebuild;
  * an embed given a width and height keeps it when its element changes;
  * the drawing is still there after the change.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_embedfollow.html")
PORT = 9959
DEBUG_PORT = 9960

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="fluid" style="width:320px;height:240px"></div>
<div id="fixed" style="width:320px;height:240px"></div>
<script src="py2Dmol/resources/bundles/py2Dmol.embed.min.js"></script>
<script>
window.__ready = false;
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('load', () => {
  //HELPERS
  // offsetWidth: the canvas carries a 1px border inside its box
  const dims = (v) => ({ css: [v.canvas.offsetWidth, v.canvas.offsetHeight], px: [v.canvas.width, v.canvas.height], display: [v.displayWidth, v.displayHeight] });
  const ink = (v) => {
    const c = v.canvas, L = c.nextElementSibling && c.nextElementSibling.tagName === 'CANVAS' ? c.nextElementSibling : null;
    const s = document.createElement('canvas'); s.width = c.width; s.height = c.height; const x = s.getContext('2d');
    if (L) x.drawImage(L, 0, 0); x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, s.width, s.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] && !(d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240)) n++;
    return n;
  };
  window.__go = async (text) => {
    try {
      const out = {};
      const a = py2Dmol.show(document.getElementById('fluid'), text, {});
      const b = py2Dmol.show(document.getElementById('fixed'), text, { width: 320, height: 240 });
      await until(() => a.coords && a.coords.length && b.coords && b.coords.length, 20000);
      a.render('warm'); b.render('warm'); await settle(6);
      out.before = { a: dims(a), b: dims(b), builds: window.__ribbonBuilds || 0 };
      document.getElementById('fluid').style.width = '480px'; document.getElementById('fluid').style.height = '200px';
      document.getElementById('fixed').style.width = '480px'; document.getElementById('fixed').style.height = '200px';
      const t0 = performance.now();
      const followed = await until(() => a.canvas.offsetWidth === 480 && a.canvas.offsetHeight === 200, 3000);
      out.followMs = Math.round(performance.now() - t0);
      await settle(4);
      out.after = { a: dims(a), b: dims(b), builds: window.__ribbonBuilds || 0, followed, aInk: ink(a), bInk: ink(b) };
      // 🔴 AND THE HOST'S BOX CONTAINS THE CANVAS. A host holding anything else -
      // a caption, a toolbar - used to add that thing's height to the canvas on
      // every pass, and the host grew by as much again: a 60px block took the
      // canvas from 152 to 2,312px, with Chrome logging "ResizeObserver loop
      // completed with undelivered notifications". The canvas may have the room
      // that is LEFT, so the measurement is a fixed point.
      // ...on a host with no height of its OWN, which is where it bit: there the
      // host's height IS its contents, so the canvas was measuring itself.
      {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const c = py2Dmol.show(host, text, {});
        await until(() => c.coords && c.coords.length, 20000);
        c.render('warm'); await settle(6);
        const start = [c.canvas.offsetWidth, c.canvas.offsetHeight];
        const note = document.createElement('div');
        note.style.height = '60px'; note.textContent = 'caption';
        host.insertBefore(note, host.firstChild);
        await settle(6);
        const first = [c.canvas.offsetWidth, c.canvas.offsetHeight];
        await settle(25);
        out.withNote = { start, first, settled: [c.canvas.offsetWidth, c.canvas.offsetHeight],
                         host: Math.round(host.getBoundingClientRect().height) };
      }
      out.errors = window.__errors;
      return out;
    } catch (e) { return { error: String((e && e.stack) || e) }; }
  };
  window.__ready = true;
});
</script></body></html>"""
open(PROBE, "w").write(PAGE.replace("//HELPERS", HELPERS))
TEXT = open(os.path.join(ROOT, "GABARAP_P3.pdb")).read()


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-embedfollow"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_embedfollow.html")
cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
res = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(TEXT)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])
B, A = res["before"], res["after"]
print(f"  before: fluid {B['a']['css']} fixed {B['b']['css']}")
print(f"  after:  fluid {A['a']['css']} px {A['a']['px']} display {A['a']['display']} in {res['followMs']} ms; fixed {A['b']['css']}; builds {B['builds']} -> {A['builds']}; ink fluid {A['aInk']} fixed {A['bInk']}")
bad = []
if not A["followed"] or A["a"]["css"] != [480, 200]:
    bad.append(f"the bare embed did not follow its element: canvas {A['a']['css']} against a 480x200 box")
if A["a"]["display"] != [480, 200] or A["a"]["px"][0] < 480:
    bad.append(f"the canvas followed in CSS only: backing {A['a']['px']}, renderer {A['a']['display']}")
if A["b"]["css"] != [320, 240]:
    bad.append(f"the embed given a size followed its element anyway: {A['b']['css']}")
if A["builds"] != B["builds"]:
    bad.append(f"the follow rebuilt the mesh ({B['builds']} -> {A['builds']}); a resize redraws the mesh it has")
if A["aInk"] < 200 or A["bInk"] < 200:
    bad.append("a drawing was lost in the change")
W = res.get("withNote") or {}
print(f"  a 60px caption inside an unsized host: canvas {W.get('start')} ->"
      f" {W.get('first')} -> {W.get('settled')}, host {W.get('host')}px high")
if W.get("first") != W.get("settled"):
    bad.append(f"the canvas was still growing after a caption went into an unsized"
               f" host: {W.get('first')} then {W.get('settled')} - that host's height IS"
               " its contents, so a canvas measured against it reads its own answer back")
if W.get("settled") and W.get("start") and W["settled"][1] > W["start"][1] + 2:
    bad.append(f"the canvas grew when a 60px caption joined it in an unsized host:"
               f" {W['start']} -> {W['settled']}; it may have the room that is LEFT,"
               " never its own height plus the caption's")
if res["errors"]:
    bad.append("page errors: " + "; ".join(res["errors"])[:300])
print()
for b in bad:
    print("FAIL: " + b)
print("embed follow: " + ("FAILED" if bad else "a bare embed follows its element, a sized one keeps its size"))
sys.exit(1 if bad else 0)
