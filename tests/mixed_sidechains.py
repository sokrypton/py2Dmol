"""SHOW, OVER A SELECTION THAT IS NOT ALL ONE KIND OF RESIDUE.

    python3 tests/mixed_sidechains.py [1AOI.cif]

Reported as github.com/sokrypton/py2Dmol#28: on 3Q0R, select chain B, press
Find interactions, then press Show on the side-chain row - and nothing happens.
On 121P the same four steps work.

The difference is what the selection CONTAINS. 3Q0R's chain B is an
8-nucleotide RNA rather than the ligand it looks like, so Find gathered 8
nucleotides and 40 protein residues; the panel asks `hasBasesFor` about the
whole SET, gets true, and picks `plate`. A protein residue has no plate - it
has one way of being drawn - so `plate` resolved to "do not draw it" and the
press turned the side chains OFF for all 48, the 40 the reader was looking for
included. 121P's chain C is a ligand and carries no nucleotide, so the same
press picks `full` and works.

🔴 SO THE FIXTURE MUST BE MIXED, AND THE CONTROLS ARE THE TWO PURE CASES.
Either pure selection passes against the bug - that is the whole shape of it -
so a probe that drove only protein, or only nucleotides, would have reported
this feature working. The nucleic control also has to check the nucleotides
still get their PLATE and not their atoms: "draw everything as atoms" would
pass the protein leg while quietly changing what a nucleotide means by Show.
"""
import json, os, sys, shutil, http.server, socketserver, threading
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cdp
from probe_js import HELPERS

PROBE = os.path.join(ROOT, "_mixedsc.html"); PORT = 9985; DEBUG_PORT = 9986
FILE = sys.argv[1] if len(sys.argv) > 1 else "1AOI.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], false);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 120000);
    await settle(12);
    const obj = () => r.objectsData[r.currentObjectName];
    const isNuc = (i) => r.positionTypes[i] === 'D' || r.positionTypes[i] === 'R';
    const prot = [], nuc = [];
    for (let i = 0; i < r.coords.length; i++) {
      if (r.positionTypes[i] === 'P') prot.push(i); else if (isNuc(i)) nuc.push(i);
    }
    // 🔴 PRESS THE REAL BUTTON. The fault is in what the panel computes from
    // the selection before it calls anything, so a probe that called
    // setSelectionSidechains itself would test around it.
    // 🔴 THE PLATE TOGGLE IS PINNED, because it is an INPUT to what Show
    // computes and the panel leaves it alone while nothing is drawn - so its
    // value carries over from whatever the previous leg did and the legs
    // silently depend on their order. Set directly rather than dispatched: the
    // Show handler reads `.checked`, and firing `change` would run the plate
    // handler instead, which is a different action.
    const press = async (ids, plateOn) => {
      r.setResidueSelection(new Set(ids));
      await settle(10);
      const plate = document.getElementById('plateShowToggle');
      if (plate) { plate.checked = plateOn; plate.indeterminate = false; }
      const btn = document.getElementById('sidechainShowButton');
      if (!btn) return {noButton: true};
      btn.click();
      await settle(16);
      const sc = obj().sidechains instanceof Set ? obj().sidechains : new Set();
      const bases = obj().bases instanceof Set ? obj().bases : null;
      return {
        shownProtein: ids.filter((i) => !isNuc(i) && sc.has(i)).length,
        askedProtein: ids.filter((i) => !isNuc(i)).length,
        shownNucAtoms: ids.filter((i) => isNuc(i) && sc.has(i)).length,
        askedNuc: ids.filter(isNuc).length,
        // the plate is the DEFAULT for a nucleotide, and `bases` is the set
        // that have one; absent means every nucleotide has one
        platedNuc: ids.filter((i) => isNuc(i) && (!bases || bases.has(i))).length,
        coords: r.coords.length,
      };
    };
    const clear = async () => {
      if (r.hideSidechains) { try { r.hideSidechains(); } catch (e) {} }
      await settle(8);
    };

    const out = {};
    // a mixed selection: some protein, some nucleotide - the reported case.
    // BOTH WAYS ROUND, because the plate toggle decides what the nucleotides
    // get and the protein residues must be drawn either way.
    const mixed = [...prot.slice(0, 30), ...nuc.slice(0, 8)];
    await clear(); out.mixedPlate = await press(mixed, true);
    await clear(); out.mixedAtoms = await press(mixed, false);
    // ...and the two pure controls, BOTH of which pass against the bug
    await clear(); out.protein = await press(prot.slice(30, 60), true);
    await clear(); out.nucleic = await press(nuc.slice(8, 20), true);
    // ...AND HIDE, WHICH IS THE OTHER HALF OF THE SAME SPLIT. `none` is an
    // answer every residue has, so it must reach all of them - and with the
    // list split by kind it is the branch that is easy to drop. Pressed on the
    // mixed selection while its side chains are out.
    await clear();
    await press(mixed, false);
    r.setResidueSelection(new Set(mixed));
    await settle(10);
    const hide = document.getElementById('sidechainHideButton');
    if (hide) { hide.click(); await settle(16); }
    {
      const sc = obj().sidechains instanceof Set ? obj().sidechains : new Set();
      const bases = obj().bases instanceof Set ? obj().bases : null;
      out.hidden = {
        hasButton: !!hide,
        stillShown: mixed.filter((i) => sc.has(i)).length,
        stillPlated: mixed.filter((i) => isNuc(i) && (!bases || bases.has(i))).length,
        asked: mixed.length,
      };
    }
    out.counts = {protein: prot.length, nucleic: nuc.length};
    return out;
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("//HELPERS", HELPERS)
open(PROBE, "w").write(open(os.path.join(ROOT, "dev.html")).read()
    .replace("</body>", "<script>" + SETUP + "</script></body>"))

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
prof = "/tmp/py2dmol-mixedsc"
chrome, ws = cdp.launch(DEBUG_PORT, prof)
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Emulation.setDeviceMetricsOverride", width=1500, height=1200,
        deviceScaleFactor=1, mobile=False)
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_mixedsc.html")
cdp.wait_for(ws, "window.__ready === true", timeout=180, what="the page to load")
o = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))

bad = []
print(f"  {FILE}: {o['counts']['protein']} protein, {o['counts']['nucleic']} nucleotides")
for tag in ("mixedPlate", "mixedAtoms", "protein", "nucleic"):
    r = o[tag]
    print(f"  {tag:<11} asked {r['askedProtein']} protein / {r['askedNuc']} nucleotide"
          f"  ->  side chains {r['shownProtein']} protein + {r['shownNucAtoms']} nucleotide"
          f" / plates {r['platedNuc']}")

if o["counts"]["nucleic"] < 8 or o["counts"]["protein"] < 60:
    bad.append(f"{FILE} has {o['counts']['protein']} protein and"
               f" {o['counts']['nucleic']} nucleotide positions - this probe needs"
               " both kinds to make a mixed selection at all")

if o["mixedPlate"].get("noButton"):
    bad.append("the side-chain Show button is not on the page")
for tag in ("mixedPlate", "mixedAtoms"):
    m = o[tag]
    if m.get("noButton"):
        continue
    if m["shownProtein"] != m["askedProtein"]:
        bad.append(f"a MIXED selection ({tag}): {m['askedProtein']} protein residues"
                   f" asked for their side chains, {m['shownProtein']} got them. Show"
                   " asks hasBasesFor about the whole set, so one nucleotide in the"
                   " selection makes the answer `plate` - which a protein residue"
                   " has no version of, so it is drawn as nothing")
# ...and the nucleotides in that same selection still answer the MENU, which is
# what says a mixed selection is served per kind rather than flattened to one
if not o["mixedPlate"].get("noButton"):
    mp, ma = o["mixedPlate"], o["mixedAtoms"]
    if mp["platedNuc"] != mp["askedNuc"] or mp["shownNucAtoms"]:
        bad.append(f"in a mixed selection with Plate on, {mp['platedNuc']} of"
                   f" {mp['askedNuc']} nucleotides got a plate and"
                   f" {mp['shownNucAtoms']} got atoms - the menu is being ignored"
                   " for the nucleotides while the protein is served")
    if ma["shownNucAtoms"] != ma["askedNuc"]:
        bad.append(f"in a mixed selection with Plate off, {ma['shownNucAtoms']} of"
                   f" {ma['askedNuc']} nucleotides got their atoms - a nucleotide"
                   " asked for atoms must get them whatever else is selected")

p = o["protein"]
if p["shownProtein"] != p["askedProtein"]:
    bad.append(f"a pure PROTEIN selection lost side chains too:"
               f" {p['shownProtein']} of {p['askedProtein']} - this is the control,"
               " so the fault is wider than the report")

n = o["nucleic"]
if n["platedNuc"] != n["askedNuc"]:
    bad.append(f"a pure NUCLEIC selection: {n['platedNuc']} of {n['askedNuc']}"
               " nucleotides came back with a plate. Show on a nucleotide means"
               " the plate unless the menu says otherwise, and drawing them all"
               " as atoms instead would pass the protein legs above")
if n["shownNucAtoms"]:
    bad.append(f"a pure NUCLEIC selection drew {n['shownNucAtoms']} nucleotides as"
               " ATOMS - Show should bring back the plate, which is how they were"
               " last drawn")

h = o.get("hidden") or {}
print(f"  {'hide':<11} asked {h.get('asked')} mixed  ->  still shown"
      f" {h.get('stillShown')} / still plated {h.get('stillPlated')}")
if not h.get("hasButton"):
    bad.append("the side-chain Hide button is not on the page")
elif h.get("stillShown"):
    bad.append(f"Hide left {h['stillShown']} of {h['asked']} residues' side chains"
               " drawn. `none` is an answer every residue has, so it must reach"
               " all of them - it is the branch the per-kind split makes easy"
               " to drop")
elif h.get("stillPlated"):
    bad.append(f"Hide left {h['stillPlated']} nucleotides wearing their plate -"
               " nothing drawn means nothing drawn")

print()
for b in bad:
    print("FAIL: " + b)
print("mixed side chains: " + ("FAILED" if bad else "Show draws every residue it can"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(prof, ignore_errors=True)
sys.exit(1 if bad else 0)
