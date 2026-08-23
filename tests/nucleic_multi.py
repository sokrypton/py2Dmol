"""A nucleic object keeps its atoms when the viewer drops out of Multi.

    python3 tests/nucleic_multi.py

Reported as "1YNE lost its base pairs": load a protein, load an RNA, show
both in Multi, set the RNA's bases to full atoms rather than plates, then
press Multi off - and the RNA came back with no bases at all, neither plates
(switched off on purpose) nor atoms (dropped).

_materialiseSidechains rebuilds each side-chain atom through a local frame,
and a nucleotide's frame needs a longer step than a peptide's. Which one to
use came from `this.positionTypes` - the types of the array being REPLACED,
because setCoords has not run yet. On any load that changes the shape of the
array those describe a different structure: here they were the merged array's,
so index 3 of the RNA read as a protein residue of the object beside it, every
base was rebuilt through the peptide range, localFrame failed, and all 347
atoms were dropped in silence.

Checks the atoms into the array and onto the canvas, through the exact
sequence, and that the frame's own types are what the materialiser reads.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_namulti.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const eyes = () => Array.from(document.querySelectorAll('#objectList .object-list-eye'));
  const rows = () => Array.from(document.querySelectorAll('#objectList .object-list-row'));
  const ink = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++;
    }
    return n;
  };
  const st = (r, tag) => ({
    tag, drawn: r.drawnObjects(), editing: r.currentObjectName,
    n: r.coords.length,
    atoms: r.sidechainMap ? r.sidechainMap.size : 0,
    // one screen outline per HALF rung: the plates, when they are drawn
    plates: r._naPick ? r._naPick.length : 0,
    sidechains: Object.fromEntries(Object.keys(r.objectsData).map((k) => [k,
      r.objectsData[k].sidechains instanceof Set
        ? r.objectsData[k].sidechains.size : null])),
    ink: ink(r.canvas),
  });
  const go = async () => {
    const R = {steps: []};
    try {
      await load('6MRR.cif'); await wait(600);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      await load('1YNE.cif'); await wait(900);
      const names = Object.keys(r.objectsData);
      R.names = names;
      const na = names[1];
      R.steps.push(st(r, 'loaded'));

      document.getElementById('objectListButton').click(); await wait(400);
      for (let k = 0; k < rows().length; k++) {
        if (rows()[k].classList.contains('is-hidden')) { eyes()[k].click(); await wait(400); }
      }
      R.steps.push(st(r, 'multi both'));

      // THE RNA, DRAWN AS FULL ATOMS rather than plates - the panel's own way
      const off = r.sourceOffsetOf(na);
      const range = r.localRangeOf(na);
      const stop = Math.min(range.end === Infinity ? r.coords.length : range.end,
                            r.coords.length);
      const sel = [];
      for (let i = off; i < stop; i++) sel.push(i);
      R.selected = sel.length;
      r.residueSelection = new Set(sel);
      window.updateSelectionToolsState && window.updateSelectionToolsState();
      const plate = document.getElementById('plateShowToggle');
      R.plateControl = !!plate;
      if (plate) { plate.checked = false; plate.dispatchEvent(new Event('change', {bubbles: true})); }
      await wait(900);
      R.steps.push(st(r, 'full atoms'));

      // ...AND OUT OF MULTI
      document.getElementById('objectListButton').click(); await wait(900);
      R.steps.push(st(r, 'multi off'));

      // WHAT THE SWITCH DREW IS WHAT THE STATE SAYS. A repaint from the same
      // state must produce the same pixels: the frame used to be painted
      // before the selection had been carried across, so leaving Multi with a
      // selection dropped its highlight - 8,946 yellow pixels - until
      // something else happened to redraw.
      const grab = () => {
        const c = r.canvas;
        return c.getContext('2d').getImageData(0, 0, c.width, c.height);
      };
      const before = grab();
      r.render('probe repaint'); await wait(300);
      const after = grab();
      let diff = 0;
      for (let i = 0; i < before.data.length; i += 4) {
        if (Math.abs(before.data[i] - after.data[i])
          + Math.abs(before.data[i + 1] - after.data[i + 1])
          + Math.abs(before.data[i + 2] - after.data[i + 2]) > 12) diff++;
      }
      R.repaintDiff = diff;

      // a second load must not change anything - it is what used to "fix" it
      r.reloadDrawn(); await wait(600);
      R.steps.push(st(r, 'reloaded'));
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
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9699),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-namulti","--no-first-run",
  "--window-size=1100,950","http://127.0.0.1:9699/_namulti.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end=time.time()+180
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-namulti",ignore_errors=True)
R=box[0] if box else {"error":"no result posted"}
if R.get("error"): sys.exit("page error: " + R["error"])

for s in R["steps"]:
    print(f"  {s['tag']:11s} drawn={str(s['drawn']):20s} n={s['n']:<5} atoms={s['atoms']:<4}"
          f" plates={s['plates']:<4} ink={s['ink']:<7} sidechains={s['sidechains']}")
step = {s['tag']: s for s in R["steps"]}
na = R["names"][1]
bad = []
if not R.get("plateControl"):
    bad.append("the Plate control is not on the panel - the sequence never ran")
if not step['full atoms']['atoms']:
    bad.append("switching the bases to full atoms materialised nothing, so"
               " nothing here is being tested")
if step['full atoms']['plates']:
    bad.append(f"{step['full atoms']['plates']} plates are still drawn after"
               " switching to full atoms")
want = step['full atoms']['atoms']
for tag in ('multi off', 'reloaded'):
    got = step[tag]['atoms']
    if got != want:
        bad.append(f"{tag}: {got} of the {want} base atoms are in the array -"
                   " the frame was materialised against another structure's"
                   " position types")
    if step[tag]['drawn'] != [na]:
        bad.append(f"{tag}: drew {step[tag]['drawn']}, not the RNA alone")
    if step[tag]['sidechains'].get(na) != step['full atoms']['sidechains'].get(na):
        bad.append(f"{tag}: the RNA's own set changed")
# ...and the atoms are ink, not just entries in a map
if step['multi off']['ink'] <= step['loaded']['ink'] * 0.5:
    bad.append(f"the RNA drew {step['multi off']['ink']} ink against"
               f" {step['loaded']['ink']} as plates - the bases are missing"
               " from the picture")
print(f"  a repaint from the same state differs by {R.get('repaintDiff')} pixels")
if R.get("repaintDiff", 0) > 200:
    bad.append(f"the frame drawn on leaving Multi differs from a repaint of the"
               f" same state by {R['repaintDiff']} pixels - it was painted"
               " before the state was whole")

for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
