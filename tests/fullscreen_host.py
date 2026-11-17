"""A HOST CAN NAME WHAT GOES FULL SCREEN.

    python3 tests/fullscreen_host.py

The full-screen button takes the viewer (or the viewer and the strip beside it)
and hides everything else. A host whose controls belong beside the picture -
LocalFold's design page, whose steps are the left column - marks an ancestor
`data-py2dmol-fullscreen`, and then that element goes full screen with nothing
hidden and none of py2Dmol's full-screen layout applied. Both pages are driven
with a real click, because a browser grants full screen only to a gesture.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_fshost.html")
PORT = 9965
DEBUG_PORT = 9966

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="layout" style="display:flex;gap:8px">
  <div id="side" style="width:200px">the host's options</div>
  <div id="host" style="width:480px;height:320px"></div>
</div>
<script src="py2Dmol/resources/bundles/py2Dmol.full.min.js"></script>
<script>
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__show = async (text, named) => {
    if (named) document.getElementById('layout').setAttribute('data-py2dmol-fullscreen', '');
    const v = py2Dmol.show(document.getElementById('host'), text, { play: true });   // as LocalFold asks
    await until(() => v.coords && v.coords.length, 20000);
    await settle(3);
    const b = [...document.querySelectorAll('.py2dmol-fs-btn')].find((x) => x.offsetParent);
    if (!b) throw new Error('no full-screen button: enabled ' + document.fullscreenEnabled + ', buttons ' + document.querySelectorAll('.py2dmol-fs-btn').length);
    const r = b.getBoundingClientRect();
    return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
  };
  window.__state = () => JSON.stringify({
    full: document.fullscreenElement ? (document.fullscreenElement.id || document.fullscreenElement.className) : null,
    side: getComputedStyle(document.getElementById('side')).display,
    fsClass: document.querySelectorAll('.py2dmol-fs').length,
  });
  window.__ready = true;
});
</script></body></html>"""
open(PROBE, "w").write(PAGE.replace("//HELPERS", HELPERS))
def helix(n=24, chain="A", shift=0.0, first=1):
    """An ideal alpha-helix backbone of n alanines, written here so the probe needs no fixture."""
    import math
    lines = []
    for i in range(n):
        for k, (name, r, dz, dphi) in enumerate([("N", 1.55, -0.85, -28), ("CA", 2.3, 0.0, 0),
                                                  ("C", 1.65, 0.85, 28), ("O", 1.9, 1.95, 30)]):
            a = math.radians(100 * i + dphi)
            x, y, z = r * math.cos(a) + shift, r * math.sin(a), 1.5 * i + dz
            lines.append(f"ATOM  {first + 4 * i + k:5d}  {name:<3s} ALA {chain}{i + 1:4d}    "
                         f"{x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00           {name[0]}")
    return lines



TEXT = "\n".join(helix() + ["END"]) + "\n"


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-fshost"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_fshost.html")
cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")


def press(named):
    ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_fshost.html")
    cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
    x, y = json.loads(cdp.evaluate(ws, f"window.__show({json.dumps(TEXT)}, {json.dumps(named)})"))
    for kind in ("mousePressed", "mouseReleased"):
        ws.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", clickCount=1)
    cdp.wait_for(ws, "document.fullscreenElement !== null", timeout=20, what="full screen")
    return json.loads(cdp.evaluate(ws, "window.__state()"))


try:
    plain = press(False)
    named = press(True)
finally:
    chrome.kill(); httpd.shutdown()
    try: os.remove(PROBE)
    except OSError: pass
    shutil.rmtree(profile_dir, ignore_errors=True)

print(f"  unnamed: {plain}")
print(f"  named:   {named}")
bad = []
if named["full"] != "layout":
    bad.append(f"with an ancestor named, {named['full']!r} went full screen, not the layout")
if named["side"] == "none":
    bad.append("the host's options were hidden in its own full screen")
if named["fsClass"]:
    bad.append("py2Dmol's full-screen layout was applied to a host that lays itself out")
if plain["full"] == "layout" or not plain["fsClass"]:
    bad.append(f"with nothing named the full screen changed too ({plain})")
print()
for b in bad:
    print("FAIL: " + b)
print("fullscreen host: " + ("FAILED" if bad else "a host's named element goes full screen, whole"))
sys.exit(1 if bad else 0)
