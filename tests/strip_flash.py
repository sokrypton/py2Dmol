"""A RESIDUE WHOSE LETTER CHANGED FLASHES ON THE SEQUENCE STRIP.

    python3 tests/strip_flash.py

A two-frame trajectory of one chain, the second frame with two residues
mutated. Stepping to it must light exactly those two cells and leave every
other cell's pixels as they were; the light must be gone after the fade; and
the first build after SEQ.clear() - a different structure, as far as the strip
knows - must flash nothing.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stripflash.html")
PORT = 9963
DEBUG_PORT = 9964
MUTATED = [5, 10]   # residue numbers that are GLY in the second frame

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host" style="width:480px;height:320px"></div>
<div id="sequence-viewer-container">
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
      // one pixel inside each cell's corner, away from the letter
      const pixels = () => {
        const canvas = document.querySelector('#sequenceView canvas');
        const scale = 200 / 96;   // seq.js draws at a fixed 200 dpi over a 96 dpi layout
        const ctx = canvas.getContext('2d');
        return window.SEQ.layout().residuePositions.map((p) => {
          const d = ctx.getImageData(Math.round((p.x + 1) * scale), Math.round((p.y - window.SEQ.layout().scrollTop + 1) * scale), 1, 1).data;
          return { resSeq: p.residueData.resSeq, letter: p.residueData.letter, rgb: [d[0], d[1], d[2]] };
        });
      };
      const differing = (a, b) => a.filter((c, i) => c.rgb.join() !== b[i].rgb.join()).map((c) => c.resSeq);
      v.setFrame(0); window.SEQ.buildView(); await settle(3);
      await new Promise((r) => setTimeout(r, 1800));
      const plain0 = pixels();
      v.setFrame(1); window.SEQ.buildView(); await settle(2);
      const lit = pixels();
      out.letters = lit.filter((c) => c.letter === 'G').map((c) => c.resSeq);
      await new Promise((r) => setTimeout(r, 1800));
      const faded = pixels();
      out.lit = differing(lit, faded);
      out.litColour = lit.find((c) => c.resSeq === 5)?.rgb;
      out.fadedColour = faded.find((c) => c.resSeq === 5)?.rgb;
      // back again flashes the same two
      v.setFrame(0); window.SEQ.buildView(); await settle(2);
      out.back = differing(pixels(), plain0);
      // after clear() the next build is a new structure: nothing flashes
      await new Promise((r) => setTimeout(r, 1800));
      window.SEQ.clear(); v.setFrame(1); window.SEQ.buildView(); await settle(2);
      const cleared = pixels();
      await new Promise((r) => setTimeout(r, 1800));
      out.afterClear = differing(cleared, pixels());
      out.errors = window.__errors;
      return out;
    } catch (e) { return { error: String((e && e.stack) || e) }; }
  };
  window.__ready = true;
});
</script></body></html>"""
open(PROBE, "w").write(PAGE.replace("//HELPERS", HELPERS))
def helix(n=24, chain="A", shift=0.0, first=1, gly=()):
    """An ideal alpha-helix backbone of n alanines, written here so the probe needs no fixture."""
    import math
    lines = []
    for i in range(n):
        for k, (name, r, dz, dphi) in enumerate([("N", 1.55, -0.85, -28), ("CA", 2.3, 0.0, 0),
                                                  ("C", 1.65, 0.85, 28), ("O", 1.9, 1.95, 30)]):
            a = math.radians(100 * i + dphi)
            x, y, z = r * math.cos(a) + shift, r * math.sin(a), 1.5 * i + dz
            lines.append(f"ATOM  {first + 4 * i + k:5d}  {name:<3s} {'GLY' if i + 1 in gly else 'ALA'} {chain}{i + 1:4d}    "
                         f"{x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00           {name[0]}")
    return lines



TEXT = "\n".join(["MODEL        1"] + helix() + ["ENDMDL", "MODEL        2"] + helix(gly=MUTATED)
                 + ["ENDMDL", "END"]) + "\n"


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile_dir = "/tmp/py2dmol-stripflash"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stripflash.html")
cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
res = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(TEXT)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])
print(f"  frame 2's G at {res['letters']}; lit {res['lit']} ({res['litColour']} -> {res['fadedColour']}),"
      f" back to frame 1 lit {res['back']}, after clear() lit {res['afterClear']}")
bad = []
if res["letters"] != MUTATED:
    bad.append(f"the second frame's strip shows G at {res['letters']}, not {MUTATED}")
if res["lit"] != MUTATED:
    bad.append(f"stepping to the mutated frame lit {res['lit']}, not {MUTATED}")
if res["back"] != MUTATED:
    bad.append(f"stepping back lit {res['back']}, not {MUTATED}")
if res["afterClear"]:
    bad.append(f"the first build after clear() lit {res['afterClear']} - a new structure is not a change")
if res["errors"]:
    bad.append("page errors: " + "; ".join(res["errors"])[:300])
print()
for b in bad:
    print("FAIL: " + b)
print("strip flash: " + ("FAILED" if bad else "a changed residue flashes and only it"))
sys.exit(1 if bad else 0)
