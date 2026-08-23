"""The PAE panel belongs to ONE object; several can be on screen.

    python3 tests/pae_objects.py

A PAE matrix is a square over one structure's residues - there is no such
thing across two - but the panel was wired to whichever object was last
LOADED, and nothing re-asked when the drawn set changed. Load a structure with
no PAE, load a prediction that has one, then hide the prediction and show the
first: the matrix stayed on screen, describing residues that were not, and a
box drawn on it selected the other object's.

What this checks, with a synthetic matrix on the second object:

  * the matrix shows while its object is drawn, merged or alone;
  * it goes away when its object does;
  * it comes back, and a box drawn on it selects ITS residues, at the offset
    the object sits at in the merged array;
  * a single object with PAE is still exactly what it always was.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_pae_obj.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const panel = (r) => {
    const c = r.paeContainer;
    return {
      shown: !!(c && c.style.display !== 'none'),
      n: r.paeRenderer ? r.paeRenderer.n : -1,
      has: !!(r.paeRenderer && r.paeRenderer.paeData),
    };
  };
  const go = async () => {
    const R = {};
    try {
      await load('6MRR.cif');
      await load('1UBQ.cif');
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      const [noPae, withPae] = Object.keys(r.objectsData);
      R.names = [noPae, withPae];

      // A SYNTHETIC PREDICTION. The matrix is what an AFDB model carries: one
      // row per residue of THAT object, and nothing to do with the other.
      const o = r.objectsData[withPae];
      const n = o.frames[0].coords.length;
      const m = new Uint8Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        m[i * n + j] = Math.min(255, Math.abs(i - j) * 4);
      }
      o.frames[0].pae = m;
      o._lastPaeFrame = 0;
      R.paeN = n;
      window.PAE.updateFrame(r, o, 0);
      await wait(200);
      R.alone = panel(r);           // the prediction, on its own: the old world

      // BOTH ON SCREEN
      r.setShownObjects([noPae, withPae]);
      await wait(400);
      R.merged = panel(r);
      R.mergedDrawn = r.drawnObjects();
      R.offset = r.sourceOffsetOf(withPae);

      // ...AND A BOX DRAWN ON IT hides everything outside ITS residues. The
      // rows are the prediction's, and the mask speaks merged indices - so
      // this is where an offset taken from the wrong object shows: the box
      // would hide the OTHER structure's residues instead.
      r.currentObjectName = noPae;      // the panel's object is not the edited one
      const pc = r.paeRenderer.canvas;
      const pr = pc.getBoundingClientRect();
      const cell = (k) => (k + 0.5) * pr.width / r.paeRenderer.n;
      const at = (k) => ({clientX: pr.left + cell(k), clientY: pr.top + cell(k),
                          bubbles: true, button: 0});
      pc.dispatchEvent(new MouseEvent('mousedown', at(2)));
      window.dispatchEvent(new MouseEvent('mousemove', at(8)));
      window.dispatchEvent(new MouseEvent('mouseup', at(8)));
      await wait(300);
      const sel = Array.from(r.getVisibility().positions || []).sort((a, b) => a - b);
      R.box = {n: sel.length, lo: sel[0], hi: sel[sel.length - 1],
               offset: r.sourceOffsetOf(withPae),
               objects: Array.from(new Set(sel.map((i) => r.ownerOf(i).name)))};
      r.setVisibility({paeBoxes: [], positions: new Set(), chains: new Set(),
                       visibilityMode: 'default'}, true);
      r.currentObjectName = withPae;

      // THE PREDICTION GOES AWAY, the other object stays
      r.setShownObjects([noPae]);
      await wait(400);
      R.hidden = panel(r);
      R.hiddenDrawn = r.drawnObjects();

      // ...and comes back
      r.setShownObjects([noPae, withPae]);
      await wait(400);
      R.back = panel(r);

      // EVERYTHING OFF
      r.setShownObjects([]);
      await wait(300);
      R.off = panel(r);

      // THE PREDICTION ALONE, WHILE THE OTHER IS THE ONE BEING EDITED: only
      // one candidate, so the panel is not ambiguous and shows it.
      r.setShownObjects([withPae]);
      r.currentObjectName = noPae;
      if (window.PAE.syncToDrawn) window.PAE.syncToDrawn(r);
      await wait(300);
      R.otherEdited = panel(r);
      R.paeObject = r.paeObjectName ? r.paeObjectName() : null;
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
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
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9652),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-paeobj","--no-first-run",
  "--window-size=1200,1000","http://127.0.0.1:9652/_pae_obj.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end=time.time()+150
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-paeobj",ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"): sys.exit("page error: " + R["error"])

print(f"objects {R['names']}, the second given a {R['paeN']}x{R['paeN']} matrix")
for k in ('alone','merged','hidden','back','off','otherEdited'):
    print(f"  {k:12s} {R.get(k)}")
print(f"  drawn merged {R.get('mergedDrawn')} (offset {R.get('offset')}),"
      f" hidden {R.get('hiddenDrawn')}, pae object now {R.get('paeObject')}")

bad=[]
if not (R['alone']['shown'] and R['alone']['n'] == R['paeN']):
    bad.append(f"the prediction's own matrix does not show on its own: {R['alone']}")
if not (R['merged']['shown'] and R['merged']['n'] == R['paeN']):
    bad.append(f"merged with another object, the matrix went missing: {R['merged']}")
if R['hidden']['shown'] or R['hidden']['has']:
    bad.append(f"the matrix outlived the object it describes: {R['hidden']}")
if not (R['back']['shown'] and R['back']['n'] == R['paeN']):
    bad.append(f"the matrix did not come back with its object: {R['back']}")
if R['off']['shown'] or R['off']['has']:
    bad.append(f"everything switched off still shows a matrix: {R['off']}")
if not (R['otherEdited']['shown'] and R['otherEdited']['n'] == R['paeN']):
    bad.append("the one drawn object with a matrix does not show it while"
               f" another is being edited: {R['otherEdited']}")
if R.get('paeObject') != R['names'][1]:
    bad.append(f"the panel thinks it belongs to {R.get('paeObject')}")
b = R.get("box") or {}
print(f"  a box on rows 2-8 of the matrix: {b.get('n')} positions,"
      f" {b.get('lo')}..{b.get('hi')} (the object sits at {b.get('offset')}),"
      f" belonging to {b.get('objects')}")
if b.get("objects") != [R["names"][1]]:
    bad.append(f"a box drawn on the prediction's matrix selected {b.get('objects')}")
elif b.get("lo") != b.get("offset") + 2 or b.get("hi") != b.get("offset") + 8:
    bad.append(f"the box landed on {b.get('lo')}..{b.get('hi')}, not"
               f" {b.get('offset') + 2}..{b.get('offset') + 8}")

for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
