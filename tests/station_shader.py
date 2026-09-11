"""The station shader compiles, links, and has not forked from VS3D.

    python3 tests/station_shader.py

VS3D_STATIONS is VS3D with its corner attributes replaced by a fetch from a
station texture - the same shader fed a different way. Two things can go wrong
with that and neither raises anything on its own:

  1. THE SUBSTITUTION MATCHES NOTHING. VS3D's attribute block is found by its
     exact text, so a reformat there leaves the replacement a no-op. The builder
     throws in that case; this checks the throw did not happen and that the
     result really carries the new attributes and not the old ones.

  2. THE PROGRAM DOES NOT LINK. Nothing draws with it yet, so paintgl keeps it
     null and carries on - which is right for a driver that cannot compile it
     and wrong as a silent state for the one machine developing it. The reason
     is reported either way.

🔴 IT DOES NOT CHECK THAT THE PICTURE IS THE SAME, because nothing is drawn with
it yet. That gate comes with the buffers, and it compares the instance rows with
a tolerance rather than by equality: the shipped path captures corners geom.js
has already projected and buildMeshPart unprojects them again, while the station
path never leaves model space, so the two agree to the accuracy of that round
trip and no further. The rows are window.__fill, under __gpuDiag.

(An earlier version of this paragraph said the comparison "cannot be
__fillHash". tests/PERF_NOTES.md says __fillHash was kept from an earlier
attempt; it was not - nothing in src/ defines it. The array is exposed instead.)
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationshader.html")
PORT = 9795
DEBUG_PORT = 9796

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async () => {
    const t = await (await fetch('/1UBQ.cif')).text();
    await window.processFiles([{name: '1UBQ.cif', readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(8);
    const G = window.py2dmolCartoonGPU;
    return {
      hasGL: !!(G && G.hasGL && G.hasGL()),
      gpuDrew: !!r.gpuDrewLastFrame,
      station: (G && G.stationProgram) ? G.stationProgram() : null,
    };
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
profile_dir = "/tmp/py2dmol-stationshader"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationshader.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the page to load")
out = json.loads(cdp.evaluate(ws, "window.__go().then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

bad = []
print(f"WebGL2: {out['hasGL']}   the GPU drew the frame: {out['gpuDrew']}")
st = out.get("station")
print(f"station program: {st}")

if not out["hasGL"]:
    bad.append("there is no WebGL2 context, so nothing here was tested - this"
               " probe cannot tell a shader that will not link from a driver"
               " that never tried")
elif st is None:
    bad.append("py2dmolCartoonGPU has no stationProgram entry: either the build"
               " is older than VS3D_STATIONS or the bundle was not rebuilt")
elif not st.get("linked"):
    bad.append(f"the station program did not link: {st.get('error')}")

print()
for b in bad:
    print("FAIL: " + b)
print("station shader: " + ("FAILED" if bad else "compiles and links"))
sys.exit(1 if bad else 0)
