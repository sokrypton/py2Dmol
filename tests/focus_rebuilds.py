"""A FOCUS SESSION MUST NOT REBUILD THE RIBBON.

    python3 tests/focus_rebuilds.py [4HHB.cif]

dev.html's #devRebuildLight shows R when a build happened and the ribbon was
NOT reused, and SC when it was. Reported from the app: R flashing when focus
mode is entered and left. This presses the real Focus button, clicks residues,
clicks the background and leaves - all through CDP Input events, because a
scripted MouseEvent does not go through the browser's own click synthesis and
so cannot see what a reader's click does.

WHAT IT COUNTS is `window.__ribbonBuilds`, which makeResident increments when
the ribbon part did NOT come from cache. That is a cumulative counter, so it
catches a rebuild that happened mid-flight and was overwritten in
`window.__rebuild` by a later one - which a post-hoc read of `ribbonReused`
misses entirely.

🔴 AND IT NEEDS A POSITIVE CONTROL, WHICH IS THE POINT OF THE THRESHOLD. A
build where the ribbon is never kept across a camera move rebuilds it on most
focus clicks, and this file was verified against exactly that (4be5c00, the
reverted tree): 4 flashes in 48 interactions, where the object-centric mesh
gives 0. Without having seen it FAIL on a tree that flashes, "0 flashes" would
only mean the counter was never wired.

🔴 AND EIGHT CYCLES, NOT ONE. A rebuild that comes from floating-point jitter
in a cache key is intermittent; a five-step walk goes straight past it, and a
reader watching the badge over a working session does not.
"""
import json, os, sys, shutil, time, collections, http.server, socketserver, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

PROBE = os.path.join(ROOT, "_focusrebuilds.html")
PORT = 9931
DEBUG_PORT = 9932
FILE = sys.argv[1] if len(sys.argv) > 1 else "4HHB.cif"
CYCLES = 8

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__boot = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], false);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 120000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(12);
    const n = r.coords.length; const sc = [];
    for (let i = Math.floor(n*0.30); i < Math.floor(n*0.42); i++) sc.push(i);
    r.showSidechains(sc); await settle(12);
    window.__r = r;
    const b = document.getElementById('focusButton').getBoundingClientRect();
    const c = r.canvas.getBoundingClientRect();
    return {btn: {x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2)},
            can: {x: Math.round(c.left+c.width/2), y: Math.round(c.top+c.height/2),
                  w: Math.round(c.width), h: Math.round(c.height)},
            counterWired: typeof window.__ribbonBuilds !== 'undefined'
                          || /__ribbonBuilds/.test(String(window.py2dmolCartoonGPU
                             && window.py2dmolCartoonGPU.residentCount))};
  };
  window.__mark = () => { window.__ribbonBuilds = 0; window.__faceBuilds = 0;
    window.__sidechainBuilds = 0; return 'ok'; };
  window.__read = async () => {
    for (let i = 0; i < 90; i++) await settle(1);
    const rb = window.__rebuild || {};
    const fb = window.__faceBuilds || 0;
    const rib = window.__ribbonBuilds || 0;
    return {faceBuilds: fb, ribbonBuilds: rib,
            badge: fb === 0 ? '-' : ((rib > 0 || rb.ribbonReused === false) ? 'R' : 'SC'),
            focus: document.getElementById('focusButton').getAttribute('aria-pressed')};
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
prof = "/tmp/py2dmol-focusrebuilds"
chrome, ws = cdp.launch(DEBUG_PORT, prof)
ws.call("Page.enable")
ws.call("Runtime.enable")
# input is in VIEWPORT coordinates and headless opens short, so the toolbar
# lands off-screen and a press hits empty page
ws.call("Emulation.setDeviceMetricsOverride", width=1500, height=1200,
        deviceScaleFactor=1, mobile=False)
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_focusrebuilds.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
geo = json.loads(cdp.evaluate(ws, f'window.__boot("{FILE}").then(JSON.stringify)'))


def click(x, y):
    for ty in ("mousePressed", "mouseReleased"):
        ws.call("Input.dispatchMouseEvent", type=ty, x=x, y=y, button="left",
                clickCount=1, buttons=1 if ty == "mousePressed" else 0)
        time.sleep(0.05)
    time.sleep(0.4)


b, c = geo["btn"], geo["can"]
STEPS = (
    ("Focus ON",   lambda: click(b["x"], b["y"])),
    ("residue A",  lambda: click(c["x"], c["y"])),
    ("residue B",  lambda: click(c["x"] + 60, c["y"] - 40)),
    ("residue C",  lambda: click(c["x"] - 50, c["y"] + 35)),
    ("background", lambda: click(c["x"] + int(c["w"] * 0.45), c["y"] - int(c["h"] * 0.45))),
    ("Focus OFF",  lambda: click(b["x"], b["y"])),
)
flashes = []
tally = collections.Counter()
rows = 0
for cycle in range(CYCLES):
    for tag, fn in STEPS:
        cdp.evaluate(ws, "window.__mark()")
        fn()
        o = json.loads(cdp.evaluate(ws, "window.__read().then(JSON.stringify)"))
        rows += 1
        tally[(tag, o["badge"])] += 1
        if o["badge"] == "R":
            flashes.append(f"cycle {cycle + 1} {tag} (ribbonBuilds {o['ribbonBuilds']})")
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(prof, ignore_errors=True)

print(f"{FILE}: {rows} interactions over {CYCLES} focus cycles")
for (tag, badge), k in sorted(tally.items()):
    print(f"    {tag:<12} {badge:<2} x{k}")
for f in flashes:
    print("  R FLASH: " + f)
print()
if flashes:
    print(f"FAIL: the ribbon was rebuilt during a focus session {len(flashes)} time(s)"
          f" of {rows} interactions - the badge flashes R and the reader sees a stutter")
print("focus rebuilds: " + ("FAILED" if flashes
                            else "no focus interaction rebuilt the ribbon"))
sys.exit(1 if flashes else 0)
