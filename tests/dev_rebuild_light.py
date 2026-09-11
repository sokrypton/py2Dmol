"""The dev page says when the cartoon mesh was rebuilt, and only then.

    python3 tests/dev_rebuild_light.py

A cartoon frame is either REBUILT - capture, facesOf, buildMeshPart, the whole
mesh - or answered from the station table, which uploads new positions into a
mesh that already exists. Both draw the same picture and one costs several times
the other, so the difference is invisible exactly where it matters. dev.html
flashes a small R in the corner on a rebuild, and the point of it is the frames
where it does NOT flash.

🔴 IT IS INJECTED BY tools/bundle.py INTO dev.html ALONE, so it cannot ship. This
file checks that too: a debug affordance that reaches index.html is a debug
affordance in production.

🔴 AND THE FLASH LASTS 420 ms, WHICH A PROBE MUST WAIT OUT. Sampling every
animation frame reads one flash as five and cannot tell a path that rebuilds once
from one that rebuilds every step - which is the only question this light is for.
"""
import json, os, sys, shutil, subprocess, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_devlight.html")
PORT = 9817
DEBUG_PORT = 9818
FILE = sys.argv[1] if len(sys.argv) > 1 else "_traj_1tim.pdb"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, keepSse) => {
    if (window.__loadedFile !== file) {
      const t = await (await fetch('/' + file)).text();
      await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
      window.__loadedFile = file;
    }
    await until(loaded, 180000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 180000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(8);
    const sse = document.querySelector('#keepSseButton');
    if (!sse) return {error: 'no SSE button on this page'};
    if (keepSse && !r.stableTopology) { sse.click(); await settle(8); }
    if (!keepSse && r.stableTopology) { sse.click(); await settle(8); }
    const el = document.getElementById('devRebuildLight');
    if (!el) return {error: 'no #devRebuildLight - tools/bundle.py did not inject it'};
    const dark = () => new Promise((s) => setTimeout(s, 600));

    r.setFrame(0); r.render('warm');
    await dark();
    const base = window.__faceBuilds || 0;
    let lit = 0; let built = 0; let mismatch = 0;
    for (let i = 1; i < 6; i++) {
      const b0 = window.__faceBuilds || 0;
      r.setFrame(i); r.render('step');
      await settle(2);
      // 🔴 DID THIS STEP REBUILD, AND DID THE LIGHT SAY SO - per step, not per
      // run. This counted lit steps and compared them with the TOTAL number of
      // steps, which was the same thing only while every step without Keep SSE
      // rebuilt. A trajectory gets the station table now whether or not the
      // button is pressed, so some steps are updated in place and correctly
      // show no light: 4 of 5 on 1TIM. The light's contract was never "always
      // on" - it is "on exactly when the mesh was rebuilt".
      const didBuild = (window.__faceBuilds || 0) > b0;
      const isLit = el.classList.contains('on');
      if (isLit) lit += 1;
      if (didBuild) built += 1;
      if (didBuild !== isLit) mismatch += 1;
      await dark();
    }
    // 🔴 AND ONE STEP THAT CERTAINLY REBUILDS, because stepping a trajectory no
    // longer does. The light's contract has two halves and a run where nothing
    // rebuilt can only test one of them: this asks for a rebuild outright and
    // requires the light to say so.
    const fb = window.__faceBuilds || 0;
    const GG = window.py2dmolCartoonGPU;
    if (GG && GG.invalidate) GG.invalidate();
    r.setFrame(2); r.render('forced');
    await settle(2);
    const forcedBuilt = (window.__faceBuilds || 0) > fb;
    const forcedLit = el.classList.contains('on');
    await dark();
    // 🔴 READ THE LIGHT BEFORE PUTTING THE MODE BACK. Toggling Keep SSE off
    // invalidates and rebuilds, which lights it - so cleaning up first and
    // asking afterwards measures the cleanup.
    const out = {keepSse, steps: 5, lit, built, mismatch, forcedBuilt, forcedLit,
                 builds: (window.__faceBuilds || 0) - base,
                 wentDark: !el.classList.contains('on'), badge: el.textContent};
    if (r.stableTopology) { sse.click(); await settle(4); }
    return out;
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
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py")],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-devlight"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_devlight.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
runs = {}
for keep in (False, True):
    runs[keep] = json.loads(cdp.evaluate(
        ws, f"window.__go({json.dumps(FILE)}, {'true' if keep else 'false'})"
            ".then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

bad = []
for keep, o in runs.items():
    if o.get("error"):
        sys.exit("page error: " + o["error"])
    print(f"Keep SSE={str(keep):5s}: {o['builds']} rebuilds over {o['steps']} steps,"
          f" lit on {o['lit']}, built on {o['built']},"
          f" disagreed on {o['mismatch']}, badge {o['badge']!r},"
          f" went dark {o['wentDark']}")

off, on = runs[False], runs[True]
# 🔴 IT MUST LIGHT WHEN THERE IS SOMETHING TO SAY, AND STEPPING NO LONGER SAYS
# ANYTHING. Both arms rebuild nothing now - a drifting assignment costs no
# rebuild on either - so "the ordinary path rebuilds more" stopped being a
# question this file could ask, and asking it failed as though the light were
# broken. What is left is the light's actual contract, tested directly: on
# exactly when the mesh was rebuilt. A rebuild is asked for outright to get a
# lit step at all.
for tag, o in (("without Keep SSE", off), ("with Keep SSE", on)):
    if o["mismatch"]:
        bad.append(f"{tag}: the light disagreed with the mesh on"
                   f" {o['mismatch']} of {o['steps']} steps - it lit on"
                   f" {o['lit']} and the mesh was rebuilt on {o['built']}. It is"
                   " meant to be on exactly when a rebuild happened")
    if not o["forcedBuilt"]:
        bad.append(f"{tag}: invalidating did not rebuild, so the lit half of the"
                   " contract was never exercised")
    elif not o["forcedLit"]:
        bad.append(f"{tag}: a forced rebuild left the light dark")
# ...AND MUST NOT WHEN THERE IS NOT, which is the half that makes it worth having.
# ...ALLOWING THE ONE THAT INSTALLS THE TABLE. Turning the mode on, or a
# topology signature that moves once, costs a single rebuild and the light is
# right to show it. What must not happen is a rebuild PER STEP, which is the
# state the mode exists to avoid and is what this arm is really asking about.
if on["builds"] > 1:
    bad.append(f"Keep SSE rebuilt {on['builds']} times over {on['steps']} steps"
               " - the fast path is not holding")
# ...and NOT `lit == builds` over the run: `builds` counts the forced rebuild
# that happens after the stepping loop, so the two are different questions. The
# per-STEP mismatch above is the exact form of the same claim and it is the one
# worth making - a light that is on as often as the mesh rebuilds but on the
# wrong steps is not tracking anything.
# ...and the two arms are no longer compared on their build counts: both are
# zero, which is the thing every other gate in this suite is for.
if not on["wentDark"]:
    bad.append("the light never went out")

# 🔴 AND IT IS dev.html ONLY.
site = open(os.path.join(ROOT, "index.html")).read()
dev = open(os.path.join(ROOT, "dev.html")).read()
if "devRebuildLight" in site:
    bad.append("index.html carries the rebuild light - a debug affordance in"
               " production")
if "devRebuildLight" not in dev:
    bad.append("dev.html does not carry the rebuild light")

print()
for b in bad:
    print("FAIL: " + b)
print("dev rebuild light: " + ("FAILED" if bad else "on for a rebuild, dark for a fast step"))
sys.exit(1 if bad else 0)
