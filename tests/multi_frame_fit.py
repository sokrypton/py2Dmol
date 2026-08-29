"""Focus never restores a camera that does not show what is drawn.

    python3 tests/multi_frame_fit.py

An eye toggle deliberately does NOT move the camera - things appear and
disappear where they are (parts/multi.js, and tests/multi_object.py asks for
it) - so turning Multi on with 1AOI beside 6MRR leaves the camera at the 17.8
it was framed at for a picture of 116, with the rest off the screen. That is
the intended rule and this probe does not touch it.

🔴 WHAT FOCUS ADDED WAS PUTTING IT BACK. The mode snapshots the camera on
entry and restores it on every background click and on the way out - a camera
measured on a picture that can change under it. So the reader clicked the
background and landed on one object's framing inside a merged scene, again and
again, with Orient the only way out. Reported as being stuck zoomed out.
_focusRestore widens to what is drawn when the snapshot does not cover it.

The other half is the regression that fix invites: `_applyShownObjects` also
runs for a plain RELOAD - a side chain, a base, an element - and there the
framing is the reader's. Someone focused on a residue sits at an extent of 9
inside a merged 116 on purpose, and widening it to fit would throw them out of
the pocket they are reading. `sameSources` tells the two apart.

Widen only, and only when what is drawn changed: zooming IN on a toggle is what
the `fresh` rule exists to avoid - things appear and disappear, they do not
rescale.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, "/Users/mini/Documents/GitHub/py2Dmol/tests")
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402

ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_multifit.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "4HHB.cif"

JS = """
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const R = {};
  let posted = false;
  const post = () => { if (posted) return; posted = true;
    fetch('/result', {method: 'POST', body: JSON.stringify(R)}); };
  setTimeout(post, 90000);
  const go = async () => {
    try {
      await load('1AOI.cif');
      await until(() => window.py2dmol_viewers
        && Object.keys(window.py2dmol_viewers).length, 30000);
      const r = window.py2dmol_viewers[Object.keys(window.py2dmol_viewers)[0]].renderer;
      await until(() => r.coords && r.coords.length > 30, 30000);
      await load('6MRR.cif');
      await settle(); await settle();
      const names = Object.keys(r.objectsData);
      const btn = document.getElementById('focusButton');
      const landed = async () => { await until(() => !r._focusAnim, 4000); };
      const cam = (tag) => ({tag,
        zoom: +(r.viewerState.zoom || 0).toFixed(3),
        extent: +(r.viewerState.extent || 0).toFixed(2),
        merged: !!(r.multiState && r.multiState.enabled),
        mergedExtent: r.multiState && r.multiState.stats
          ? +r.multiState.stats.maxExtent.toFixed(2) : null,
        sel: [...(r.residueSelection || [])].length,
        mode: !!r._focusMode});
      R.steps = [];
      r.setShownObjects(names.slice());
      await settle(); await settle();
      R.steps.push(cam('multi on'));
      btn.click(); await settle(); await settle();
      R.steps.push(cam('focus mode entered'));
      // a residue in the FIRST object, then one in the SECOND
      const off = r.sourceOffsetOf ? r.sourceOffsetOf(names[1]) : 0;
      for (const [tag, idx] of [['clicked in A', 12], ['clicked in B', off + 12],
                                ['clicked in A again', 30]]) {
        r.setResidueSelection(new Set([idx]));
        await settle(); await landed(); await settle();
        R.steps.push(cam(tag));
      }
      r.clearResidueSelection();
      await settle(); await landed(); await settle();
      R.steps.push(cam('background click'));
      r.setResidueSelection(new Set([40]));
      await settle(); await landed(); await settle();
      R.steps.push(cam('clicked again after background'));
      // ...A SIDE-CHAIN RELOAD WHILE FOCUSED, which runs the same code and
      // must not widen: the framing there is the reader's.
      if (r.showSidechains) { r.showSidechains({positions: [50, 51]}); }
      await settle(); await landed(); await settle();
      R.steps.push(cam('side chain shown while focused'));
      // ...and an eye toggle mid-focus, which is the other half of the report
      r.setShownObjects([names[0]]);
      await settle(); await landed(); await settle();
      R.steps.push(cam('one object again'));
      r.setResidueSelection(new Set([12]));
      await settle(); await landed(); await settle();
      R.steps.push(cam('clicked after the toggle'));
    } catch (e) { R.error = String(e && e.stack || e); }
    post();
  };
  go();
});
</script>
"""
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
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9776), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-multifit",
                      "--no-first-run", "--window-size=1100,900",
                      "http://127.0.0.1:9776/_multifit.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# ...WITH ITS OWN BUDGET. Six legs, two structures and a dozen camera flights
# to wait out: 15 s alone against the shared 30, which the parallel UI lane
# doubles often enough to fail as "no result posted" - a timeout wearing a
# crash's clothes. The legs are the point, so the budget moves.
end = time.time() + 120 * 2
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-multifit", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

if R.get("error"):
    sys.exit("page error: " + R["error"])
steps = {s["tag"]: s for s in (R.get("steps") or [])}
bad = []
for s2 in (R.get("steps") or []):
    print(f"  {s2['tag']:30s} extent {s2['extent']:>7} of a merged {s2['mergedExtent']}")

on = steps.get("multi on")
if not on or not on.get("merged"):
    bad.append("the two objects did not merge, so nothing here was tested")
elif on["extent"] >= on["mergedExtent"]:
    bad.append(f"Multi came up already fitted ({on['extent']} of"
               f" {on['mergedExtent']}) - the objects are too alike in size for"
               " this probe to see a camera that does not cover the picture")

# THE MODE GIVES BACK WHAT IT TOOK, exactly, while the picture is the same one.
# A background click is not a change of what is drawn, and the camera it found
# is the reader's however wide it was - see tests/cut_ligands.py, which asks for
# the same thing and caught a first version of this that widened here.
entered = steps.get("focus mode entered")
back = steps.get("background click")
if not entered or not back:
    bad.append("the entry/background steps did not run")
elif abs(back["extent"] - entered["extent"]) > 0.5:
    bad.append(f"a background click left the camera at {back['extent']}, not the"
               f" {entered['extent']} the mode was entered with. Nothing about"
               " the picture changed, so the snapshot is exactly what to give"
               " back")

# ...AND WIDENS ONLY WHEN THE PICTURE CHANGED UNDER IT. That is the fix: the
# snapshot was measured on objects that are no longer the ones drawn, so
# restoring it framed a scene by a camera built for a different one.
one = steps.get("one object again")
if not one:
    bad.append("the shown-set change did not run")
elif one["extent"] < one["mergedExtent"] * 0.98:
    bad.append(f"after the shown set changed the camera sits at {one['extent']}"
               f" for a picture of {one['mergedExtent']} - focus restored a"
               " camera measured on objects that are not the ones drawn, and"
               " every click on the background puts it back. Orient was the"
               " only way out")

focused = steps.get("clicked again after background")
reload_ = steps.get("side chain shown while focused")
if not focused or not reload_:
    bad.append("the focus/reload legs did not run")
elif focused["extent"] > on["mergedExtent"] * 0.5:
    bad.append(f"a focus click left the extent at {focused['extent']} in a"
               f" picture of {on['mergedExtent']} - it is meant to move IN, so"
               " the reload leg below would prove nothing")
elif abs(reload_["extent"] - focused["extent"]) > 0.5:
    bad.append(f"showing a side chain moved the framing from {focused['extent']}"
               f" to {reload_['extent']}. A reload is not a change of what is"
               " drawn, and the framing there is the reader's")

for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
