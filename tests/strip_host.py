"""THE SEQUENCE STRIP'S BUTTONS WORK ON A HOST'S PAGE, NOT ONLY ON THE WEBSITE.

    python3 tests/strip_host.py

A host that mounts the strip itself - its markup (#sequence-viewer-container,
#sequenceView and the header's Select all / Unselect / Invert) beside its own
`py2Dmol.show` viewer, the renderer handed over through `SEQ.setCallbacks` -
used to get three buttons that greyed and un-greyed correctly and did nothing
when pressed: their listeners were in src/app/main.js's initializeApp, which a
host page does not run. They are panels/seq.js's now (wireStripTools). What has
to hold, on such a page with the full bundle:

  * the strip draws the host's structure;
  * Select all selects every position, Invert of that selects none, Invert of
    none is everything, and Unselect clears - through the renderer's setters,
    so `residueSelection` is what changes;
  * the header row that holds them is shown, and each button is wired once,
    however many times the strip is built;
  * a chain the host's `listsChain` leaves out is not in the strip, and Select
    all and Invert do not reach it - and setting the callback back to null puts
    it back.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_striphost.html")
PORT = 9961
DEBUG_PORT = 9962

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host" style="width:480px;height:320px"></div>
<div id="sequence-viewer-container">
  <div class="sequence-header"><div class="sequence-actions">
    <button id="selectAllResidues">Select all</button>
    <button id="clearAllResidues">Unselect</button>
    <button id="invertSelection">Invert</button>
  </div></div>
  <div id="sequenceView"></div>
</div>
<script src="py2Dmol/resources/bundles/py2Dmol.full.min.js"></script>
<script>
window.__ready = false;
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (text) => {
    try {
      const out = {};
      const v = py2Dmol.show(document.getElementById('host'), text, {});
      await until(() => v.coords && v.coords.length, 20000);
      window.SEQ.setCallbacks({ getRenderer: () => v, getObjectSelect: () => null, applySelection: () => {} });
      window.SEQ.buildView();
      window.SEQ.buildView();   // a second build must not wire a second listener
      await settle(4);
      const n = v.coords.length;
      const size = () => (v.residueSelection ? v.residueSelection.size : 0);
      const press = async (id) => { document.getElementById(id).click(); await settle(2); return size(); };
      out.n = n;
      out.drawn = !!document.querySelector('#sequenceView canvas');
      out.actions = document.querySelector('.sequence-actions').style.display;
      let changes = 0;
      document.addEventListener('py2dmol-residue-selection-change', () => { changes += 1; });
      out.all = await press('selectAllResidues');
      out.changesForOnePress = changes;
      out.invertAll = await press('invertSelection');
      out.invertNone = await press('invertSelection');
      v.setResidueSelection(new Set([0, 1, 2]));
      out.cleared = await press('clearAllResidues');
      // ...AND A CHAIN THE HOST LEAVES OUT: gone from the strip, and from what
      // its buttons select, which act on what the strip lists
      const cells = () => (window.SEQ.layout()?.residuePositions || []).length;
      out.cellsAll = cells();
      window.SEQ.setCallbacks({ listsChain: (name, chain) => chain !== 'B' });
      window.SEQ.buildView();
      await settle(2);
      out.cellsListed = cells();
      out.allListed = await press('selectAllResidues');
      out.allListedChains = [...new Set([...v.residueSelection].map((i) => v.chains[i]))];
      await press('clearAllResidues');
      out.invertListed = await press('invertSelection');
      await press('clearAllResidues');
      window.SEQ.setCallbacks({ listsChain: null });
      window.SEQ.buildView();
      await settle(2);
      out.cellsBack = cells();
      out.errors = window.__errors;
      return out;
    } catch (e) { return { error: String((e && e.stack) || e) }; }
  };
  window.__ready = true;
});
</script></body></html>"""
open(PROBE, "w").write(PAGE.replace("//HELPERS", HELPERS))
def helix(n=24, chain="A", shift=0.0, first=1):
    """An ideal alpha-helix backbone of n alanines, written here so the probe needs no fixture."""
    import math
    lines = []
    for i in range(n):
        for k, (name, r, dz, dphi) in enumerate([("N", 1.55, -0.85, -28), ("CA", 2.3, 0.0, 0),
                                                  ("C", 1.65, 0.85, 28), ("O", 1.9, 1.95, 30)]):
            a = math.radians(100 * i + dphi)
            x, y, z = r * math.cos(a) + shift, r * math.sin(a), 1.5 * i + dz
            lines.append(f"ATOM  {first + 4 * i + k:5d}  {name:<3s} ALA {chain}{i + 1:4d}    "
                         f"{x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00           {name[0]}")
    return lines


# two chains, so one can be left out of the strip and the other kept
TEXT = "\n".join(helix() + ["TER"] + helix(12, "B", 12.0, 97) + ["END"]) + "\n"
LISTED = 24


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-striphost"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_striphost.html")
cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
res = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(TEXT)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])
n = res["n"]
print(f"  {n} positions; strip drawn {res['drawn']}, actions display {res['actions']!r}")
print(f"  select all {res['all']}, invert {res['invertAll']}, invert again {res['invertNone']},"
      f" unselect {res['cleared']}; {res['changesForOnePress']} change event(s) for one press")
bad = []
if not res["drawn"]:
    bad.append("the strip did not draw the host's structure")
if res["actions"] != "flex":
    bad.append(f"the strip's button row is not shown ({res['actions']!r})")
if res["all"] != n:
    bad.append(f"Select all selected {res['all']} of {n} positions")
if res["invertAll"] != 0 or res["invertNone"] != n:
    bad.append(f"Invert gave {res['invertAll']} from all and {res['invertNone']} from none")
if res["cleared"] != 0:
    bad.append(f"Unselect left {res['cleared']} selected")
if res["changesForOnePress"] != 1:
    bad.append(f"one press of Select all changed the selection {res['changesForOnePress']} times,"
               " not once - unwired at 0, wired twice at 2")
print(f"  chain B left out: strip {res['cellsAll']} -> {res['cellsListed']} cells (back to"
      f" {res['cellsBack']}); select all {res['allListed']} of chains {res['allListedChains']},"
      f" invert of none {res['invertListed']}")
if res["cellsListed"] != LISTED or res["cellsAll"] != n or res["cellsBack"] != n:
    bad.append(f"leaving chain B out showed {res['cellsListed']} of {LISTED} cells"
               f" ({res['cellsAll']} before, {res['cellsBack']} after)")
if res["allListed"] != LISTED or res["allListedChains"] != ["A"] or res["invertListed"] != LISTED:
    bad.append(f"with chain B left out, Select all took {res['allListed']} of chains"
               f" {res['allListedChains']} and Invert {res['invertListed']} - the buttons"
               " act beyond what the strip lists")
if res["errors"]:
    bad.append("page errors: " + "; ".join(res["errors"])[:300])
print()
for b in bad:
    print("FAIL: " + b)
print("strip host: " + ("FAILED" if bad else "the strip's buttons act on a host's viewer"))
sys.exit(1 if bad else 0)
