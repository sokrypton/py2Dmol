"""The PAE panel belongs to one object, and Multi has no panel at all.

    python3 tests/pae_objects.py

A PAE matrix is a square over one structure's residues - there is no such
thing across two - but the panel was wired to whichever object was last LOADED
and nothing re-asked when the drawn set changed. Load a structure with no PAE,
load a prediction that has one, then hide the prediction: the matrix stayed on
screen describing residues that were not, and a box drawn on it selected the
other object's.

The rule (paeObjectName in viewer-mol.js): in Multi there is no panel, because
the matrix belongs to one structure and Multi is the mode for looking at
several; outside Multi it is the object on screen, when that object has a
matrix. The probe gives the second object a synthetic matrix, so it needs no
network.
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
      window.PAE.syncToDrawn(r);
      await new Promise((s) => setTimeout(s, 200));
      R.alone = panel(r);           // the prediction, on its own: the old world

      // MULTI, with both on screen: no panel.
      r.setShownObjects([noPae, withPae]);
      await wait(400);
      R.merged = panel(r);
      R.mergedDrawn = r.drawnObjects();
      R.offset = r.sourceOffsetOf(withPae);

      // ...and Multi with ONLY the prediction on screen: still no panel. One
      // object drawn is not the same as one object loaded, and a square that
      // comes and goes with an eye is the confusion this rule removes.
      r.setShownObjects([withPae]);
      await wait(400);
      R.multiOne = panel(r);

      // EVERYTHING OFF
      r.setShownObjects([]);
      await wait(300);
      R.off = panel(r);

      // BACK OUT OF MULTI: the picker's object, and its matrix with it.
      r.setShownObjects(null);
      await wait(400);
      R.back = panel(r);
      R.backDrawn = r.drawnObjects();

      // ...AND A BOX DRAWN ON IT hides everything outside its own residues.
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
      // ownerOf answers for a MERGE; outside one every position belongs to
      // the object on screen
      const own = (sel.length && r.ownerOf) ? r.ownerOf(sel[0]) : null;
      R.box = {n: sel.length, lo: sel[0], hi: sel[sel.length - 1],
               object: own ? own.name : (sel.length ? r.currentObjectName : null)};
      r.setVisibility({paeBoxes: [], positions: new Set(), chains: new Set(),
                       visibilityMode: 'default'}, true);

      // THE OBJECT WITH NO MATRIX, picked: the panel goes away.
      r._switchToObject(noPae);
      r.setFrame(0);
      await wait(500);
      R.otherPicked = panel(r);
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
for k in ('alone', 'merged', 'multiOne', 'off', 'back', 'otherPicked'):
    print(f"  {k:12s} {R.get(k)}")
print(f"  drawn in multi {R.get('mergedDrawn')} (offset {R.get('offset')}),"
      f" back out of multi {R.get('backDrawn')}, pae object now {R.get('paeObject')}")
b = R.get("box") or {}
print(f"  a box on rows 2-8: {b.get('n')} positions, {b.get('lo')}..{b.get('hi')}"
      f" of {b.get('object')}")

bad = []
if not (R['alone']['shown'] and R['alone']['n'] == R['paeN']):
    bad.append(f"the prediction's own matrix does not show on its own: {R['alone']}")
for k, what in (('merged', 'with both objects in Multi'),
                ('multiOne', 'in Multi with only the prediction on screen'),
                ('off', 'with everything switched off')):
    if R[k]['shown'] or R[k]['has']:
        bad.append(f"the matrix is still there {what}: {R[k]}")
if not (R['back']['shown'] and R['back']['n'] == R['paeN']):
    bad.append(f"leaving Multi did not bring the matrix back: {R['back']}")
if R['otherPicked']['shown'] or R['otherPicked']['has']:
    bad.append("picking the object with no matrix left the other one's on"
               f" screen: {R['otherPicked']}")
if R.get('paeObject') is not None:
    bad.append(f"the panel thinks it belongs to {R.get('paeObject')}")
if b.get('object') != R['names'][1] or b.get('lo') != 2 or b.get('hi') != 8:
    bad.append(f"a box on rows 2-8 selected {b.get('lo')}..{b.get('hi')} of"
               f" {b.get('object')}")

for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
