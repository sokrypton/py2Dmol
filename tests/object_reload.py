"""Loading another file must not disturb the objects already loaded.

    python3 tests/object_reload.py

`pendingObjects` accumulates across loads and is only emptied by Clear All, so
the loader rebuilt EVERY object in the viewer on every load - dropping what
each one remembered: its hidden backbone, its side chains, its bases, its
forced SSE, its colours, its contacts. Colour a residue, load a second file,
and the colour was gone. It was invisible while one object was on screen at a
time and the newly loaded one was the one you looked at.

What this checks, in a browser:

  * an object keeps its state when a THIRD file is loaded, and keeps its very
    object literal - it is not rebuilt at all;
  * a RE-FETCH of an object does still replace it, which is what the rebuild
    was there for;
  * and the merge survives both, with everything still drawn.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_replace.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f, name) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: name || f, readAsync: () => Promise.resolve(txt)}], false);
  };
  //HELPERS
  const go = async () => {
    const R = {};
    try {
      await load('1BBH.cif');
      await load('1EHZ.cif');
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      const names = Object.keys(r.objectsData);
      r.setShownObjects(names);
      await settle();
      R.before = {drawn: r.drawnObjects(), n: r.coords.length,
                  offsets: r.multiState.sourceOffsets.slice()};
      // hide part of the second object, so there is state to lose
      const o1 = r.multiState.sourceOffsets[1];
      r.setBackboneHiddenFor([o1, o1 + 1], true);
      R.hiddenBefore = Array.from(r.objectsData[names[1]].hiddenBackbone || []);

      // ...IS IT THE RE-FETCH, or does ANY load reset the other objects?
      // Load a third, untouched file and look at what survives.
      R.identityBefore = r.objectsData[names[1]] === r.objectsData[names[1]];
      const keep = r.objectsData[names[1]];
      await load('1UBQ.cif'); await until(loaded); await settle();
      R.afterThirdHidden = Array.from((r.objectsData[names[1]] || {}).hiddenBackbone || []);
      R.sameObjectLiteral = r.objectsData[names[1]] === keep;

      // ...and RE-FETCH the first object, which deletes and re-adds it
      await load('1BBH.cif'); await until(loaded); await settle();
      R.after = {drawn: r.drawnObjects(), n: r.coords.length,
                 merged: !!(r.multiState && r.multiState.enabled),
                 offsets: r.multiState.sourceOffsets ? r.multiState.sourceOffsets.slice() : null,
                 objects: Object.keys(r.objectsData)};
      R.hiddenAfter = Array.from((r.objectsData[names[1]] || {}).hiddenBackbone || []);
      R.visible = r.visiblePositions ? r.visiblePositions.size : r.coords.length;
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)
src=open(os.path.join(ROOT,"index.html")).read()
stamp=str(int(time.time()*1000))
src=re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")', lambda m: m.group(1)+"?v="+stamp+m.group(3), src)
open(PROBE,"w").write(src.replace("</body>", JS+"</body>"))
box=[]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(self,*a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length",0)))))
        self.send_response(200); self.send_header("Content-Length","2"); self.end_headers(); self.wfile.write(b"ok")
socketserver.ThreadingTCPServer.allow_reuse_address=True
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9641),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-rep","--no-first-run",
  "--window-size=1000,1000","http://127.0.0.1:9641/_replace.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-rep",ignore_errors=True)
import sys
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

print(f"two objects merged: {R['before']['drawn']} ({R['before']['n']} positions)")
print(f"  hid two residues of the second: {R['hiddenBefore']}")
print(f"  after a third file: {R['afterThirdHidden']}"
      f" (same object literal: {R['sameObjectLiteral']})")
print(f"  after re-fetching the first: {R['hiddenAfter']}")
print(f"  objects now {R['after']['objects']}, drawn {R['after']['drawn']},"
      f" {R['after']['n']} positions, merged {R['after']['merged']}")

bad = []
if R["hiddenBefore"] != [0, 1]:
    bad.append(f"the setup did not hide what it meant to: {R['hiddenBefore']}")
if R["afterThirdHidden"] != R["hiddenBefore"]:
    bad.append(f"loading a third file lost the second object's hidden residues:"
               f" {R['afterThirdHidden']}")
if not R["sameObjectLiteral"]:
    bad.append("loading a third file rebuilt an object it did not bring -"
               "everything that object remembered went with it")
if R["hiddenAfter"] != R["hiddenBefore"]:
    bad.append(f"re-fetching one object lost another's state: {R['hiddenAfter']}")
if "1BBH" not in R["after"]["objects"] or R["after"]["objects"][-1] != "1BBH":
    bad.append(f"the re-fetched object was not replaced: {R['after']['objects']}")
if not R["after"]["merged"] or len(R["after"]["drawn"]) != 3:
    bad.append(f"the merge did not survive: drawn {R['after']['drawn']}")
for m in bad:
    print("FAIL:", m)
sys.exit(1 if bad else 0)
