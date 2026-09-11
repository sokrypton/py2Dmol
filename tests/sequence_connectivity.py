"""A chain break is a gap in the numbering, not a distance.

    python3 tests/sequence_connectivity.py

Residue i is bonded to i+1 because they are consecutive in a chain. The 5.0 A
test exists to catch the case where they are NOT - missing density, an
unmodelled loop - and the residue numbering already names that.

Deciding it from geometry is wrong exactly where the geometry is not a molecule
yet. On the x_t track of a sampler trajectory every consecutive CA-CA distance
at step 0 is over the line, so the chain shatters, the segment count churns, and
every step is a full rebuild.

🔴 THREE ARMS, AND THE SECOND IS WHAT MAKES THE FIRST MEAN ANYTHING. Sequence
mode must be STABLE on the diffusion fixture; distance mode must be UNSTABLE on
it, or the fixture is not exercising the problem and a passing first arm proves
nothing; and on a well-resolved structure the two must AGREE, or this is not a
better rule, it is a different drawing.
"""
import json, os, sys, shutil, subprocess, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_seqconn.html")
PORT = 9815
DEBUG_PORT = 9816
DIFF = "_traj_diffusion_3chy.pdb"
CALM = "_traj_1tim.pdb"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, bySequence) => {
    if (window.__loadedFile !== file) {
      const t = await (await fetch('/' + file)).text();
      await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
      window.__loadedFile = file;
    }
    await until(loaded, 180000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 180000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(8);
    r.sequenceConnectivity = !!bySequence;
    if (r._invalidateSegmentCache) r._invalidateSegmentCache();
    await settle(4);
    const obj = r.objectsData[r.currentObjectName] || {};
    const N = Math.min((obj.frames || []).length, 16);
    const segs = []; const ribs = [];
    for (let i = 0; i < N; i++) {
      r.setFrame(i);
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
      // the prim count, through the 2D probe, which is what a cartoon is
      const keep = {po: r._probeOnly, pp: r._primProbe, gpu: r.useGPU};
      r.useGPU = false; r._probeOnly = true; r._primProbe = null;
      r.render('probe');
      let rib = 0;
      for (const p of (r._primProbe || [])) {
        if (p && p.kind === 'rib' && p.Lp) rib += 1;
      }
      r._probeOnly = keep.po; r._primProbe = keep.pp; r.useGPU = keep.gpu;
      segs.push((r.segmentIndices || []).length);
      ribs.push(rib);
    }
    // 🔴 WHAT THE TWO RULES SHOULD DISAGREE ABOUT, counted from the data
    // rather than assumed. Sequence mode DROPS a pair that is close in space
    // but not consecutive in numbering - an unmodelled residue, which the
    // distance rule draws straight through - and ADDS one that is consecutive
    // in numbering but further apart than the threshold. The net of those two
    // is exactly how far the segment counts may differ; anything else is this
    // rule doing something it did not say it would.
    r.setFrame(0);
    const cut = ((r.config && r.config.cutoffs && r.config.cutoffs.protein_bond)
                 ?? 5.0);
    let drop = 0; let add = 0;
    for (let i = 0; i + 1 < r.coords.length; i++) {
      if (r.positionTypes && (r.positionTypes[i] !== 'P'
          || r.positionTypes[i + 1] !== 'P')) continue;
      if (!r.chains || r.chains[i] !== r.chains[i + 1]) continue;
      const n1 = r.residueNumbers ? r.residueNumbers[i] : NaN;
      const n2 = r.residueNumbers ? r.residueNumbers[i + 1] : NaN;
      if (!Number.isFinite(n1) || !Number.isFinite(n2)) continue;
      const seqOk = (n2 - n1) === 1 || n2 === n1;
      const near = r.coords[i].distanceToSq(r.coords[i + 1]) < cut * cut;
      if (near && !seqOk) drop += 1;
      if (!near && seqOk) add += 1;
    }
    r.sequenceConnectivity = false;
    if (r._invalidateSegmentCache) r._invalidateSegmentCache();
    return {file, bySequence: !!bySequence, frames: N, segs, ribs,
            drop, add, positions: r.coords.length};
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


for f, args in ((DIFF, ["3CHY.cif", "--diffusion", "--models=16"]),
                (CALM, [])):
    if not os.path.exists(os.path.join(ROOT, f)):
        subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_traj.py")]
                       + args, cwd=ROOT, check=True, stdout=subprocess.DEVNULL)

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-seqconn"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_seqconn.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
runs = {}
for f in (DIFF, CALM):
    for seq in (False, True):
        runs[(f, seq)] = json.loads(cdp.evaluate(
            ws, f"window.__go({json.dumps(f)}, {'true' if seq else 'false'})"
                ".then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

bad = []
for (f, seq), o in runs.items():
    if o.get("error"):
        sys.exit("page error: " + o["error"])
    tag = "sequence" if seq else "distance"
    print(f"{f} / {tag}: {o['frames']} frames, {o['positions']} positions")
    print(f"    segments : {min(o['segs'])}..{max(o['segs'])}"
          f"  ({len(set(o['segs']))} distinct)  {o['segs'][:6]}")
    print(f"    ribbon   : {min(o['ribs'])}..{max(o['ribs'])}"
          f"  ({len(set(o['ribs']))} distinct)  {o['ribs'][:6]}")

d_dist = runs[(DIFF, False)]
d_seq = runs[(DIFF, True)]
c_dist = runs[(CALM, False)]
c_seq = runs[(CALM, True)]

# 🔴 THE FIXTURE HAS TO HURT, or a stable sequence arm says nothing.
if len(set(d_dist["segs"])) < 2:
    bad.append("the diffusion fixture gives a CONSTANT segment count under the"
               " distance rule, so it is not exercising the fault and the"
               " sequence arm below proves nothing")
if len(set(d_seq["segs"])) != 1:
    bad.append(f"sequence mode still moves on the diffusion fixture:"
               f" {sorted(set(d_seq['segs']))}")
# ...and it has to DRAW something at step 0, which the distance rule does not.
if d_seq["ribs"][0] <= 0:
    bad.append("sequence mode draws no ribbon at step 0 - the chain is still"
               " being cut")
# 🔴 AND ON A WELL-RESOLVED STRUCTURE THE DIFFERENCE MUST BE ACCOUNTED FOR.
#
# "They must agree" was the first version of this and it was wrong: on 1TIM the
# two rules differ by 2, one per chain, and the reason is real - residue 3 is
# unmodelled in both chains and the flanking CAs are 3.83 A apart, well inside
# the 5.0 A line. The distance rule draws the ribbon straight through the gap;
# sequence mode breaks there, which is what the file says. So the assertion is
# not that they agree, it is that every position where they differ is one the
# numbering explains.
expected = c_seq["add"] - c_seq["drop"]
got = c_seq["segs"][0] - c_dist["segs"][0]
print(f"{CALM}: numbering explains {c_seq['drop']} dropped and {c_seq['add']}"
      f" added -> net {expected:+d}, measured {got:+d}")
if got != expected:
    bad.append(f"on {CALM} the rules differ by {got:+d} segments and the"
               f" numbering accounts for {expected:+d} - the rest is this rule"
               " doing something it did not say it would")

print()
for b in bad:
    print("FAIL: " + b)
print("sequence connectivity: " + ("FAILED" if bad else "a break is a gap in the numbering"))
sys.exit(1 if bad else 0)
