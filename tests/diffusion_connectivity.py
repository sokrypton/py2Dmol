"""A SAMPLER TRAJECTORY IS NOT A MOLECULE YET, AND THE DISTANCE TEST KNOWS IT.

    python3 tests/diffusion_connectivity.py [_traj_diffusion_3chy.pdb]

Connectivity is decided per frame from the CA-CA distance. On the x_t track of
a diffusion trajectory the early steps are noise, so every one of the 127
consecutive distances is over the 5.0 A line: the chain shatters into 128
one-residue pieces and there is no ribbon to draw at all. Not a slow ribbon - no
ribbon. Measured on 3CHY, 128 positions, 16 frames, at 706x706:

    arm                    builds  fast  ms/frame  segments        ink, frames 0-3
    distance + the station table        15     0      4.33  128             1.06 1.04 1.01 0.99
    sequence + table           0    15      3.88  127             11.48 7.90 5.33 3.52
    distance, no the station table      15     0      6.37  10 distinct     1.06 1.04 1.01 0.99
    sequence, no table         15     0      5.64  127             11.48 7.90 5.33 3.52

The ink column is the finding. One percent is the scattered sticks and nothing
else; eleven is a cartoon. The rebuild counts are the same story from the other
side: with no ribbon prims there is nothing for the station table to describe,
so it is never installed and every frame rebuilds however the flags are set.

🔴 AND ON A WELL-FORMED PROTEIN IT CHANGES ALMOST NOTHING, which is the other
half of the decision and the half a file about diffusion would otherwise leave
out. The same measurement on _traj_1tim.pdb, 494 positions, 30 frames:

    arm                    builds  fast  ms/frame  segments  ink, frames 0-3
    distance + the station table         0    29      6.60  492       18.47 18.43 18.40 18.39
    sequence + table           0    29      5.57  490       18.45 18.40 18.38 18.36

Two segments apart and two hundredths of a percent of ink. So the option is not
a trade between two drawings on ordinary structures; it is inert there and
decisive where the coordinates are not a molecule yet. Run this file on a real
trajectory to see that for yourself before changing anything.

`renderer.sequenceConnectivity` (or `config.cutoffs.chainbreak = 'sequence'`)
decides it from the residue NUMBERING instead, which is what actually says
whether two residues are bonded. See the note at the distance test in
core/mol.js: it falls back per pair, so a file with no usable numbering is
still decided by distance.

🔴 THIS FILE DOES NOT ARGUE FOR THE DEFAULT. Sequence connectivity is off by
default because it changes what is drawn, and that is a decision to be taken
deliberately rather than because a probe liked the numbers. What is ASSERTED
here is only that the option still works on the case it was written for; what
the default does is REPORTED beside it, so the choice can be made on numbers
whenever someone wants to make it.
"""
import json, os, sys, shutil, http.server, socketserver, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import cdp
from probe_js import HELPERS
PROBE = os.path.join(ROOT, "_diffusionconn.html")
PORT = 9817
DEBUG_PORT = 9818
FILE = sys.argv[1] if len(sys.argv) > 1 else "_traj_diffusion_3chy.pdb"
SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 60000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(12);
    const G = window.py2dmolCartoonGPU;
    const nFrames = (r.objectsData[r.currentObjectName].frames || []).length;

    const ink = () => { const c = document.createElement('canvas');
      c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d').drawImage(r.canvas, 0, 0);
      const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0; for (let i=0;i<d.length;i+=4)
        if (d[i]<245||d[i+1]<245||d[i+2]<245) n++;
      return n/(d.length/4); };

    const arm = async (bySeq, stations) => {
      r.sequenceConnectivity = bySeq;
      if (G && G.setStationDraw) G.setStationDraw(stations);
      if (stations === false && G && G.clearResidentStations) G.clearResidentStations();
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      if (G && G.invalidate) G.invalidate();
      r.setFrame(0); r.render('armWarm'); await settle(8);
      const segs = []; const inks = [];
      window.__faceBuilds = 0; window.__stationFastPath = 0;
      const t0 = performance.now();
      for (let f = 0; f < nFrames; f++) {
        r.setFrame(f); r.render('armFrame');
        segs.push(r.segmentIndices ? r.segmentIndices.length : -1);
        if (f < 4) inks.push(+(100 * ink()).toFixed(2));
      }
      const ms = +((performance.now() - t0) / nFrames).toFixed(2);
      const uniq = Array.from(new Set(segs));
      return {builds: window.__faceBuilds, fast: window.__stationFastPath,
              msPerFrame: ms, segsFirst: segs.slice(0, 6),
              distinctSegCounts: uniq.length, inkFirst4: inks,
              table: (G.stationsResident && G.stationsResident())
                ? G.stationsResident().count : 0};
    };
    const out = {};
    out.distance = await arm(false, true);
    out.sequence = await arm(true, true);
    out.distanceNoTable = await arm(false, false);
    out.sequenceNoTable = await arm(true, false);
    return {nFrames, n: r.coords.length, out};
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
open(PROBE,"w").write(open(os.path.join(ROOT,"dev.html")).read().replace("</body>","<script>"+SETUP+"</script></body>"))
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(self,*a): pass
# ...and build the trajectory if it is not here. It is generated rather than
# committed, like every other _traj_ file.
if not os.path.exists(os.path.join(ROOT, FILE)):
    src = "3CHY.cif"
    if not os.path.exists(os.path.join(ROOT, src)):
        sys.exit(f"{FILE} is not here and neither is {src} to build it from")
    import subprocess
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py"),
                    src, "--diffusion"], cwd=ROOT, check=True)

socketserver.TCPServer.allow_reuse_address=True
httpd=socketserver.TCPServer(("127.0.0.1",PORT),H)
threading.Thread(target=httpd.serve_forever,daemon=True).start()
pd="/tmp/py2dmol-diffusionconn"; chrome,ws=cdp.launch(DEBUG_PORT,pd)
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_diffusionconn.html")
cdp.wait_for(ws,"window.__ready === true",timeout=300,what="the page to load")
out=json.loads(cdp.evaluate(ws,f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(pd,ignore_errors=True)
print(f"{FILE}: {out['n']} positions, {out['nFrames']} frames")
for k, v in out["out"].items():
    print(f"  {k:<16} builds {v['builds']:>3}  fast {v['fast']:>3}"
          f"  {v['msPerFrame']:>6.2f} ms/frame  table {v['table']:>5}"
          f"  segs {v['segsFirst']} ({v['distinctSegCounts']} distinct)"
          f"  ink {v['inkFirst4']}")

bad = []
seq = out["out"]["sequence"]
dist = out["out"]["distance"]
if seq["builds"] or seq["fast"] < out["nFrames"] - 2:
    bad.append(f"with sequence connectivity and the station table the run rebuilt"
               f" {seq['builds']} time(s) and took the fast path {seq['fast']}"
               f" of {out['nFrames']} frames - the option no longer gives the"
               " station path a stable topology to work with")
if not seq["table"]:
    bad.append("the station table was never installed under sequence"
               " connectivity, so there were no ribbon prims to describe")
inkSeq = seq["inkFirst4"][0] if seq["inkFirst4"] else 0
inkDist = dist["inkFirst4"][0] if dist["inkFirst4"] else 0
if inkSeq < 4 * max(inkDist, 0.01):
    bad.append(f"the first frame inks {inkSeq:.2f}% under sequence"
               f" connectivity against {inkDist:.2f}% by distance - the option"
               " is no longer drawing a ribbon where the distance test cannot")
if seq["distinctSegCounts"] != 1:
    bad.append(f"the segment count took {seq['distinctSegCounts']} distinct"
               " values under sequence connectivity - it is decided from the"
               " numbering, which does not move between frames")

print()
for b in bad:
    print("FAIL: " + b)
print("diffusion connectivity: "
      + ("FAILED" if bad else "the sequence option still draws what distance cannot"))
sys.exit(1 if bad else 0)
