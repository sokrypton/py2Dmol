"""A disulfide comes from the file, and lands on two cysteines.

    python3 tests/disulfides.py

mmCIF's `_struct_conn` names disulfides explicitly and the renderer used none of
them: it re-derived every one from a 2.5 A distance over each pair of SG atoms,
every time side chains were materialised. That is right on a still structure -
over the corpus bonded SG-SG runs 1.79-2.09 A and the next pair is at 3.36, so
the threshold sits in a 1.3 A gap - and it is not stable on anything that moves.
Measured on a 0.45 A breathing trajectory of 3PTB the count took FOUR DISTINCT
VALUES IN SIX FRAMES, and the segment list, the ribbon and the sticks moved with
it. On a sampler trajectory the early steps are not a molecule at all.

🔴 THE IDS ARE LABEL, NOT AUTH, AND GETTING THAT WRONG DOES NOT FAIL LOUDLY.
atomIdToIndex is keyed the way getCol reads a struct_conn row - label where the
file has it. On 3PTB its CA keys run A:1:CA to A:223:CA while the auth numbering
runs 22 to 245, so resolving against auth finds a DIFFERENT RESIDUE rather than
none: A:22:CA exists, it is simply not the residue the record meant. Five of six
"resolved" that way and every one of them was wrong.

So this file checks the pairs land on CYSTEINES. That is the assertion that
catches a resolution which silently went somewhere else, and it is the one that
caught it here.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_disulf.html")
PORT = 9813
DEBUG_PORT = 9814
FILE = sys.argv[1] if len(sys.argv) > 1 else "3PTB.cif"
# ...and the same molecule as a TRAJECTORY, which is the case the declaration
# exists for: six SSBOND records, and the count must not move as it breathes.
TRAJ = "_traj_3ptb.pdb"
WANT = 6        # 3PTB declares six, and has six

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 120000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(8);
    const obj = r.objectsData[r.currentObjectName] || {};
    const declared = (obj.disulfideResidues || []).length;
    // side chains carry the SG atoms, so nothing is bonded until they are out
    if (r.showSidechains) {
      const list = [];
      for (let i = 0; i < r.coords.length; i++) list.push(i);
      r.showSidechains(list);
    }
    await settle(10);
    r.render('draw');
    await settle(4);
    const drawn = r.disulfides || [];
    // ...and WHAT they landed on. A disulfide joins two cysteines; anything
    // else is a lookup that went somewhere else and still returned a number.
    const bad = [];
    // The drawn pair names APPENDED side-chain atoms; positionNames is per
    // BACKBONE position, so each end goes through sidechainMap to its owner
    // residue first. r.positionNames is the array core/mol.js keeps (see
    // getAtomColor's resName lookup).
    const nameOf = (i) => {
      const o = r.sidechainMap && r.sidechainMap.get(i);
      const owner = o && o.owner !== undefined ? o.owner : i;
      return (r.positionNames && r.positionNames[owner]) || null;
    };
    for (const [a, b] of drawn) {
      const na = nameOf(a); const nb = nameOf(b);
      if (na !== 'CYS' || nb !== 'CYS') bad.push([na, nb]);
    }
    // ...and across the frames, which is the property the file's declaration
    // buys. A distance rule re-derives this per frame and the count moves: four
    // distinct values in six frames before SSBOND was read.
    const obj2 = r.objectsData[r.currentObjectName] || {};
    const N = Math.min((obj2.frames || []).length, 8);
    const perFrame = [];
    for (let i = 0; i < N; i++) {
      r.setFrame(i);
      r.render('f' + i);
      await settle(2);
      perFrame.push((r.disulfides || []).length);
    }
    return {file, declared, drawn: drawn.length, bad, perFrame,
            positions: r.coords.length};
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


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-disulf"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_disulf.html")
cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
runs = {}
for f in [FILE] + ([TRAJ] if os.path.exists(os.path.join(ROOT, TRAJ)) else []):
    runs[f] = json.loads(cdp.evaluate(
        ws, f"window.__go({json.dumps(f)}).then(JSON.stringify)"))
out = runs[FILE]
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

bad = []
for f, o in runs.items():
    print(f"{o['file']}: {o['positions']} positions")
    print(f"  declared by the file : {o['declared']}")
    print(f"  drawn                : {o['drawn']}")
    print(f"  not CYS-CYS          : {len(o['bad'])} {o['bad'][:4]}")
    if len(o.get('perFrame') or []) > 1:
        pf = o['perFrame']
        print(f"  over {len(pf)} frames        : {pf}"
              f"   ({len(set(pf))} distinct)")
    if o["bad"]:
        bad.append(f"{f}: {len(o['bad'])} drawn disulfides do not join two"
                   f" cysteines - {o['bad'][:4]} - which is a lookup resolving"
                   " to the wrong residue, not a bond")
    if o["declared"] != WANT:
        bad.append(f"{f}: declares {WANT} disulfides and the object carries"
                   f" {o['declared']} - the record is not reaching the"
                   " renderer, so the distance rule is still deciding")
    if o["drawn"] != WANT:
        bad.append(f"{f}: {o['drawn']} disulfides drawn against {WANT} declared")
    # 🔴 THE STABILITY IS THE POINT, and only a trajectory can show it.
    pf = o.get('perFrame') or []
    if len(pf) > 1 and len(set(pf)) != 1:
        bad.append(f"{f}: the disulfide count moved across frames - {pf} - so"
                   " it is still being decided from the geometry")
    if len(pf) > 1 and set(pf) != {WANT}:
        bad.append(f"{f}: {sorted(set(pf))} disulfides across frames against"
                   f" {WANT} declared")

print()
for b in bad:
    print("FAIL: " + b)
print("disulfides: " + ("FAILED" if bad else "from the file, and on cysteines"))
sys.exit(1 if bad else 0)
