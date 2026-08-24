"""Everything switched off is a state you can come back from.

    python3 tests/hidden_reload.py

Two faults, both of them from the same wrong assumption - that the coordinate
array always holds the object being edited:

  * switching every object off empties the array, and switching one back on
    took the "one object, and it is the one being edited" path, which RETURNS
    on the grounds that the ordinary path already has that object loaded.
    Nothing was ever drawn again. The sequence strip builds from the object's
    own frames rather than the array, so it came back as a full-length row of
    grey cells describing a structure the renderer no longer had;
  * loading a file while everything was off left the shown set empty, so the
    file you had just asked for did not appear.

The probe walks exactly that: load, load, hide all, load again, then cycle one
object's eye - checking the ink on the canvas, the coordinate array, and the
colours of the sequence strip at every step.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_hidden_reload.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const ink = (c) => {
    if (!c || !c.width) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++;
    }
    return n;
  };
  // THE STRIP'S OWN COLOURS. A cell takes its colour from the renderer's
  // coordinate array; with the array empty every one of them comes back the
  // same grey, which is what the fault looked like from the outside.
  const stripColours = () => {
    const c = document.querySelector('#sequenceView canvas');
    if (!c || !c.width) return {coloured: 0};
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // SATURATION, not the number of distinct values: a strip of grey cells
    // still has hundreds of shades in it from the antialiased letters, so
    // counting colours says the picture is fine when every cell is grey.
    let coloured = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      const hi = Math.max(d[i], d[i + 1], d[i + 2]);
      const lo = Math.min(d[i], d[i + 1], d[i + 2]);
      if (hi - lo > 30) coloured++;
    }
    return {coloured};
  };
  const snap = (r, tag) => ({
    tag, drawn: r.drawnObjects(), coords: r.coords.length,
    shown: r.shownObjects ? Array.from(r.shownObjects) : null,
    current: r.currentObjectName, objects: Object.keys(r.objectsData),
    ink: ink(r.canvas), strip: stripColours(),
    note: !!document.querySelector('.sequence-empty-note'),
  });
  const rebuild = () => { if (window.SEQ && window.SEQ.buildView) window.SEQ.buildView(); };
  //HELPERS
  const go = async () => {
    const R = {steps: []};
    try {
      await load('6MRR.cif'); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      await load('4HHB.cif'); await until(loaded); await settle();
      rebuild(); await settle();
      R.steps.push(snap(r, 'two loaded'));

      r.setShownObjects([]); await settle(); rebuild(); await settle();
      R.steps.push(snap(r, 'hide all'));

      await load('4HHB.cif'); await until(loaded); await settle(); rebuild(); await settle();
      R.steps.push(snap(r, 'reload while hidden'));

      for (let k = 0; k < 3; k++) {
        r.setShownObjects([]); await settle(); rebuild(); await settle();
        R.steps.push(snap(r, 'off ' + k));
        r.setShownObjects(['4HHB']); await settle(); rebuild(); await settle();
        R.steps.push(snap(r, 'on ' + k));
      }

      // ...and the OTHER object, which is not the one being edited
      r.setShownObjects([]); await settle();
      r.setShownObjects(['6MRR']); await settle(); rebuild(); await settle();
      R.steps.push(snap(r, 'the other one'));

      // A SMALL OBJECT, THEN A BIG ONE, one at a time through the eyes. The
      // live mask describes the array it was built for; the records describe
      // their own object. Showing the 68-residue structure and then the
      // 748-residue one left the live mask still naming positions 0..67, and
      // two thirds of the second structure was not drawn - "only part of it is
      // shown, matching the length of the other one".
      r.setShownObjects([]); await settle();
      r.setShownObjects(['6MRR']); await settle();
      R.smallOn = {drawn: r.drawnObjects(), n: r.coords.length,
                   // NULL IS EVERY POSITION - that is what the renderer means
                   // by no mask, and what it composes when nothing is hidden.
                   visible: r.visiblePositions ? r.visiblePositions.size : r.coords.length};
      r.setShownObjects([]); await settle();
      r.setShownObjects(['4HHB']); await settle(); rebuild(); await settle();
      R.bigOn = {drawn: r.drawnObjects(), n: r.coords.length,
                 visible: r.visiblePositions ? r.visiblePositions.size : r.coords.length,
                 ink: ink(r.canvas)};

      // A FILE LOADED WHILE SEVERAL ARE ON SCREEN joins them, and the camera
      // widens once to take it in - which is the one time it should move. An
      // eye being switched is not: see the cameraHeld check in
      // tests/multi_object.py.
      R.extentBefore = r.viewerState.extent;
      await load('1UBQ.cif'); await until(loaded); await settle(); rebuild(); await settle();
      R.steps.push(snap(r, 'third loaded'));
      R.extentAfter = r.viewerState.extent;
      // ...and everything drawn is really inside the canvas
      const rect = r.canvas.getBoundingClientRect();
      let outside = 0;
      for (let i = 0; i < r.coords.length; i++) {
        if (r.screenValid && r.screenValid[i] !== r.screenFrameId) continue;
        const x = r.screenX[i]; const y = r.screenY[i];
        if (x < 0 || y < 0 || x > r.displayWidth || y > r.displayHeight) outside++;
      }
      R.outside = outside;
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)
src=open(os.path.join(ROOT,"dev.html")).read()
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
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9657),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-hr","--no-first-run",
  "--window-size=1200,1000","http://127.0.0.1:9657/_hidden_reload.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-hr",ignore_errors=True)
R=box[0] if box else {"error":"no result posted"}
if R.get("error"): sys.exit("page error: " + R["error"])

bad=[]
# THE SAME STRIP, DRAWN PROPERLY, is the yardstick: with no coordinates behind
# it the cells come back grey, but the chain labels and headings keep their
# colour, so an absolute threshold does not see the fault. Measured: 323,000
# coloured pixels when it is right against 18,800 when it is not.
baseline = R["steps"][0]["strip"]["coloured"]
if baseline < 1000:
    bad.append(f"the first strip is already colourless ({baseline}px) - there"
               " is no yardstick and nothing below means anything")
for s in R["steps"]:
    print(f"  {s['tag']:20s} drawn={s['drawn']} coords={s['coords']} ink={s['ink']}"
          f" strip={s['strip']['coloured']} coloured px"
          f"{' (empty note)' if s['note'] else ''}")
    off = s['tag'].startswith('off') or s['tag'] == 'hide all'
    if off:
        if s['strip']['coloured'] > baseline * 0.1:
            bad.append(f"{s['tag']}: the strip is still coloured with nothing"
                       " on screen")
        if s['coords'] or s['ink']:
            bad.append(f"{s['tag']}: {s['coords']} coordinates and {s['ink']} ink"
                       " with everything switched off")
        if not s['note']:
            bad.append(f"{s['tag']}: the strip is still listing residues")
    else:
        if not s['coords']:
            bad.append(f"{s['tag']}: {s['drawn']} is drawn out of an EMPTY"
                       " coordinate array - nothing can be painted from it")
        if s['ink'] < 1000:
            bad.append(f"{s['tag']}: only {s['ink']} ink on the canvas")
        if s['note']:
            bad.append(f"{s['tag']}: the strip says there is nothing on screen")
        # A STRIP BUILT WITH NO COORDINATES IS FLAT GREY: it takes its cell
        # colours from the renderer's array, and an empty one leaves every
        # cell the same. Measured in saturated pixels - counting distinct
        # values does not see it, since grey text is hundreds of shades.
        if s['drawn'] == R["steps"][0]['drawn'] \
                and s['strip']['coloured'] < baseline * 0.5:
            bad.append(f"{s['tag']}: {s['strip']['coloured']} coloured pixels"
                       f" in the strip against {baseline} for the same strip"
                       " drawn properly - the cells came back grey")
print(f"  one at a time: {R['smallOn']['visible']}/{R['smallOn']['n']} of the"
      f" small one visible, then {R['bigOn']['visible']}/{R['bigOn']['n']} of"
      f" the big one ({R['bigOn']['ink']} ink)")
if R['smallOn']['visible'] != R['smallOn']['n']:
    bad.append(f"the small object came up {R['smallOn']['visible']} of"
               f" {R['smallOn']['n']} visible")
if R['bigOn']['visible'] != R['bigOn']['n']:
    bad.append(f"after the small object, only {R['bigOn']['visible']} of the"
               f" big one's {R['bigOn']['n']} positions are visible - the live"
               " mask is still describing the array it was built for")

last = R["steps"][-1]
print(f"  a third file joined {last['drawn']}: extent {R.get('extentBefore')}"
      f" -> {R.get('extentAfter')}, {R.get('outside')} positions off canvas")
if len(last['drawn']) < 2:
    bad.append(f"loading a third file while two were on screen left"
               f" {last['drawn']} drawn")
if not (R.get("extentAfter") and R.get("extentBefore")
        and R["extentAfter"] > R["extentBefore"]):
    bad.append(f"the camera did not widen for the object that just arrived:"
               f" {R.get('extentBefore')} -> {R.get('extentAfter')}")
if R.get("outside"):
    bad.append(f"{R.get('outside')} positions are off the canvas after the load")

for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
