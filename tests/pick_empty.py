"""Clicking the viewer with every object switched off must select nothing.

    python3 tests/pick_empty.py

Switching every object off empties the coordinate array, but the SCREEN
projection is written once per drawn frame and stamped with a frame id - and a
frame that draws nothing never runs the projection loop, so the stamps from the
last real frame stayed valid. pickResidueAt walked them and happily returned a
residue that is not on screen: clicking blank canvas selected something.

Checks a grid of clicks over the whole canvas, in both styles, and the click
handler's own answer (the selection) as well as the picker's.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_pickempty.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const sweep = (r) => {
    // a grid of clicks over the canvas, in client coordinates
    const rect = r.canvas.getBoundingClientRect();
    const hits = [];
    for (let gx = 1; gx < 12; gx++) {
      for (let gy = 1; gy < 12; gy++) {
        const x = rect.left + rect.width * gx / 12;
        const y = rect.top + rect.height * gy / 12;
        const i = r.pickResidueAt(x, y);
        if (i >= 0) hits.push([gx, gy, i]);
      }
    }
    return hits;
  };
  const clickAt = (r, fx, fy) => {
    const rect = r.canvas.getBoundingClientRect();
    const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      r.canvas.dispatchEvent(new MouseEvent(type,
        {clientX: x, clientY: y, bubbles: true, button: 0}));
    }
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
      R.drawnHits = sweep(r).length;   // ...the sweep finds things when there ARE things

      for (const style of ['tube', 'cartoon']) {
        r.setStyle(style);
        r.setShownObjects(names);
        await settle();
        const withInk = sweep(r).length;
        r.setShownObjects([]);
        await settle();
        R[style] = {
          drawn: r.drawnObjects(), coords: r.coords.length,
          withInk, hits: sweep(r),
        };
        // ...and what a real click does
        r.clearSelection && r.clearSelection();
        clickAt(r, 0.5, 0.5);
        await settle();
        R[style].selectedAfterClick =
          r.residueSelection ? r.residueSelection.size : 0;
        // a double click, which widens to a chain
        r.canvas.dispatchEvent(new MouseEvent('dblclick',
          {clientX: r.canvas.getBoundingClientRect().left + r.canvas.getBoundingClientRect().width / 2,
           clientY: r.canvas.getBoundingClientRect().top + r.canvas.getBoundingClientRect().height / 2,
           bubbles: true}));
        await settle();
        R[style].selectedAfterDouble =
          r.residueSelection ? r.residueSelection.size : 0;
        r.setShownObjects(names);
        await settle();
      }

      // ...AND THE PLATES STILL ANSWER when they really are on screen. The
      // outlines are stamped with the frame that drew them, so a stamp written
      // in the wrong place would silently make every base unclickable.
      r.setStyle('cartoon');
      r.useGPU = false;
      r.setShownObjects([names[1]]);   // the RNA, alone
      await settle();
      const plates = r._naPick || [];
      R.plates = {n: plates.length, stamped: r._naPickId === r.screenFrameId};
      if (plates.length) {
        // the centre of a plate, in client coordinates
        const e = plates[Math.floor(plates.length / 2)];
        let cx = 0, cy = 0;
        for (const q of e.poly) { cx += q[0]; cy += q[1]; }
        cx /= e.poly.length; cy /= e.poly.length;
        const rect = r.canvas.getBoundingClientRect();
        const sx = rect.width / r.displayWidth, sy = rect.height / r.displayHeight;
        R.plates.want = e.res;
        R.plates.got = r.pickResidueAt(rect.left + cx * sx, rect.top + cy * sy);
      }

      // ...and CLEAR ALL, which empties the same array by another door
      r.setShownObjects(names);
      await settle();
      R.clearedHitsBefore = sweep(r).length;
      r.clearAllObjects();
      await settle();
      R.clearedHits = sweep(r).length;
      r.clearSelection && r.clearSelection();
      clickAt(r, 0.5, 0.5);
      await settle();
      R.clearedSelected = r.residueSelection ? r.residueSelection.size : 0;
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
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9648),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-pe","--no-first-run",
  "--window-size=1000,1000","http://127.0.0.1:9648/_pickempty.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-pe",ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"): sys.exit("page error: " + R["error"])

bad=[]
if not R.get("drawnHits"):
    bad.append("the sweep found nothing even with both objects drawn - it is not"
               " clicking on the molecule at all, so its silence proves nothing")
for style in ('tube', 'cartoon'):
    s = R[style]
    print(f"{style}: drawn {s['drawn']}, {s['coords']} coords;"
          f" {s['withInk']} of 121 grid points hit while drawn,"
          f" {len(s['hits'])} with everything off;"
          f" click selected {s['selectedAfterClick']},"
          f" double click {s['selectedAfterDouble']}")
    if not s['withInk']:
        bad.append(f"{style}: nothing was pickable even while drawn")
    if s['drawn'] or s['coords']:
        bad.append(f"{style}: switching everything off still drew {s['drawn']}")
    if s['hits']:
        bad.append(f"{style}: {len(s['hits'])} clicks picked a residue with nothing"
                   f" on screen, e.g. {s['hits'][0]}")
    if s['selectedAfterClick']:
        bad.append(f"{style}: a click on the empty canvas selected"
                   f" {s['selectedAfterClick']} residues")
    if s['selectedAfterDouble']:
        bad.append(f"{style}: a double click on the empty canvas selected"
                   f" {s['selectedAfterDouble']} residues")
print(f"clear all: {R.get('clearedHitsBefore')} grid points hit while drawn,"
      f" {R.get('clearedHits')} after Clear All (click selected {R.get('clearedSelected')})")
if not R.get("clearedHitsBefore"):
    bad.append("nothing was pickable before Clear All either")
if R.get("clearedHits") or R.get("clearedSelected"):
    bad.append(f"after Clear All, {R.get('clearedHits')} clicks still picked a"
               f" residue and one selected {R.get('clearedSelected')}")

pl = R.get("plates") or {}
print(f"base plates: {pl.get('n')} outlines, stamped {pl.get('stamped')};"
      f" a click in the middle of one picked {pl.get('got')} (wanted {pl.get('want')})")
if not pl.get("n"):
    bad.append("no base plates were recorded at all - the RNA did not draw, so"
               " nothing here says whether they are still clickable")
elif not pl.get("stamped") or pl.get("got") != pl.get("want"):
    bad.append(f"a base plate that IS on screen no longer picks:"
               f" got {pl.get('got')}, wanted {pl.get('want')}")
for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
