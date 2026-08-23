"""Side chains survive the eyes: toggling one object must not strip another's.

    python3 tests/sidechain_toggle.py

A shown side chain is a set of ATOMS APPENDED to the coordinate array, past
everything the merge itself holds. The merged visibility mask was built by
walking each object's stored record - which lists residues, and knows nothing
about the atoms hanging off them - so the mask came out naming every residue
and none of their atoms. Every side chain in the picture went out the moment a
merge was rebuilt: click any object's eye and the side chains of the object
you did not touch disappeared with it.

Checks the atoms into the mask and onto the canvas, per object, through a
round of toggling: both on, one hidden, back, the other hidden, back.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_sctog.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const ink = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++;
    }
    return n;
  };
  const state = (r, tag) => {
    const per = {};
    for (const n of Object.keys(r.objectsData)) {
      const s = r.objectsData[n].sidechains;
      per[n] = s ? Array.from(s).sort((a, b) => a - b) : null;
    }
    // the ATOMS in the array, and how many of them the mask lets through
    const map = r.sidechainMap;
    const mask = r.visiblePositions;
    const atoms = {}; const vis = {};
    if (map) for (const [idx, e] of map) {
      const owner = r.ownerOf ? r.ownerOf(e.owner) : null;
      const nm = owner ? owner.name : (r.currentObjectName || '?');
      atoms[nm] = (atoms[nm] || 0) + 1;
      if (!mask || mask.has(idx)) vis[nm] = (vis[nm] || 0) + 1;
    }
    return {tag, per, atoms, vis, drawn: r.drawnObjects(),
            coords: r.coords.length, ink: ink(r.canvas)};
  };
  // FRAMES AND ANSWERS, NOT MILLISECONDS. Each step here is a call and a
  // render, and what has to happen before the next line reads the result is
  // that the browser has painted: three animation frames say that in 50 ms
  // where a flat 1,500 said it in 1,500. Where the work is ASYNCHRONOUS - a
  // file parsed, a session restored - the probe waits for the answer instead,
  // which is both faster and steadier than guessing a duration.
  const settle = async (n = 3) => {
    for (let k = 0; k < n; k++) {
      await new Promise((s) => requestAnimationFrame(() => s()));
    }
  };
  const until = async (cond, ms = 4000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (cond()) return true;
      await settle();
    }
    return false;
  };
  const loaded = () => {
    const v = window.py2dmol_viewers && window.py2dmol_viewers['standalone-viewer-1'];
    return !!(v && v.renderer && v.renderer.coords && v.renderer.coords.length);
  };
  const go = async () => {
    const R = {steps: []};
    try {
      await load('1UBQ.cif'); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      await load('3CHY.cif'); await until(loaded); await settle();
      const [A, B] = Object.keys(r.objectsData);
      R.names = [A, B];
      r.setShownObjects([A, B]); await settle();
      R.inkBare = ink(r.canvas);

      // SIDE CHAINS ON RESIDUES OF BOTH, written the way the panel writes
      // them: per owning object, in that object's own numbering.
      const offB = r.sourceOffsetOf(B);
      const pick = [2, 3, 4, 5, 6, offB + 2, offB + 3, offB + 4];
      for (const g of r.writeGroups(pick)) {
        const cur = g.object.sidechains instanceof Set
          ? new Set(g.object.sidechains) : new Set();
        for (const i of g.positions) cur.add(i);
        g.object.sidechains = cur;
      }
      r.reloadDrawn(); await settle();
      R.steps.push(state(r, 'both on'));
      for (const [tag, want] of [['B hidden', [A]], ['B back', [A, B]],
                                 ['A hidden', [B]], ['A back', [A, B]]]) {
        r.setShownObjects(want); await settle();
        R.steps.push(state(r, tag));
      }
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
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9667),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-sctog","--no-first-run",
  "--window-size=1000,900","http://127.0.0.1:9667/_sctog.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end=time.time()+180
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-sctog",ignore_errors=True)
R=box[0] if box else {"error":"no result posted"}
if R.get("error"): sys.exit("page error: " + R["error"])

A, B = R["names"]
bad=[]
first = R["steps"][0]
for s in R["steps"]:
    print(f"  {s['tag']:9s} drawn={s['drawn']} atoms={s['atoms']} in the mask={s['vis']}"
          f" ink={s['ink']}")
    # the stored sets never move: hiding an object is not an edit
    if s['per'] != first['per']:
        bad.append(f"{s['tag']}: the stored side chains changed: {s['per']}")
    for name in s['drawn']:
        want = s['atoms'].get(name, 0)
        if not want:
            bad.append(f"{s['tag']}: {name} is drawn with no side-chain atoms"
                       " in the array at all")
        elif s['vis'].get(name, 0) != want:
            bad.append(f"{s['tag']}: {s['vis'].get(name, 0)} of {name}'s {want}"
                       " side-chain atoms are in the mask - the rest are not"
                       " drawn")
    for name in s['drawn']:
        if s['atoms'].get(name, 0) and not s['ink']:
            bad.append(f"{s['tag']}: nothing on the canvas")
# ...and the side chains are really ink, not just set membership
if not (first['ink'] > R['inkBare']):
    bad.append(f"the side chains added no ink: {R['inkBare']} bare against"
               f" {first['ink']} with them")
print(f"  ink: {R['inkBare']} with no side chains, {first['ink']} with them")
for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
