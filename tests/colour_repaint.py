"""A colour change is a texture upload, and these are the exceptions.

    python3 tests/colour_repaint.py [1UBQ.cif]

Colour lives in a palette texture - three texels a segment - so changing it
should not touch the mesh. Measured on 1UBQ, switching between chain, rainbow,
plddt, hydrophobicity and deepmind costs ZERO rebuilds. Two things break that,
and both are the same underlying fact: the colour did not come from the palette,
so `appPalComplete` is false and the only way to change a baked colour is to ask
the renderer for the prims again.

  ss mode          `colorMode === 'ss'` is a term in the MESH signature, because
                   an SS colour boundary is a cut in the ribbon. So entering
                   costs a rebuild and leaving costs another - and while you are
                   in it every further colour change rebuilds too, with the
                   signature unmoved.

  a per-residue    an advanced colour with position or chain values sets
  override         `ciPalette` false in geom.js, so the ribbon's colours are
                   baked. Setting one rebuilds, and every colour switch after it
                   rebuilds for as long as it is in place.

🔴 THE ORDER OF THE MODES IN THIS FILE IS LOAD-BEARING. Leaving ss rebuilds as
well as entering it, so a mode listed straight after ss collects that rebuild and
looks guilty. The first version of this measurement had plddt after ss and
reported plddt as a rebuilding mode, which it is not - it is 0 both before and
after. ss goes last but one, twice, alone.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_colrepaint.html")
PORT = 9819
DEBUG_PORT = 9820
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"
REPAINT = ['chain', 'rainbow', 'plddt', 'hydrophobicity', 'deepmind', 'plddt']

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file, modes) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 120000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 10, 120000);
    await settle(8);
    await until(() => !r._quietStyle && !r._switchQuiet, 30000);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(10);
    // exactly what parts/ui.js does on the colour dropdown: there is no
    // applyColors(), the two flags are the mechanism
    const setMode = (m) => {
      r.colorMode = m;
      r.colorsNeedUpdate = true;
      r.plddtColorsNeedUpdate = true;
    };
    r.render('warm'); await settle(6);
    const rows = [];
    const step = (label, fn) => {
      const before = window.__faceBuilds || 0;
      const sigBefore = window.__lastSig;
      fn();
      r.render('c:' + label);
      return settle(6).then(() => {
        const a = String(sigBefore || '').split('|');
        const b = String(window.__lastSig || '').split('|');
        const moved = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) moved.push(i + ': ' + a[i] + ' -> ' + b[i]);
        }
        rows.push({label, builds: (window.__faceBuilds || 0) - before,
                   pal: window.__palComplete, moved: moved.slice(0, 3)});
      });
    };
    for (const m of modes) await step(m, () => setMode(m));
    await step('ss', () => setMode('ss'));
    await step('ss again', () => setMode('ss'));
    await step('leaving ss', () => setMode('chain'));
    const obj = r.objectsData[r.currentObjectName];
    await step('override set', () => {
      obj.color = {type: 'advanced', value: {position: {5: '#ff0000'}}};
      if (r._invalidateSegmentCache) r._invalidateSegmentCache();
    });
    await step('switch while overridden', () => setMode('rainbow'));
    return {file, rows};
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
profile_dir = "/tmp/py2dmol-colrepaint"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_colrepaint.html")
cdp.wait_for(ws, "window.__ready === true", timeout=120, what="the page to load")
out = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILE)}, {json.dumps(REPAINT)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"])

bad = []
print(f"{out['file']}")
for r0 in out["rows"]:
    print(f"   {r0['label']:<24} rebuilds {r0['builds']}   palette complete"
          f" {str(r0['pal']):<5}  sig moved {r0['moved']}")

rows = {r0["label"]: r0 for r0 in out["rows"]}
# 🔴 THE ORDINARY MODES MUST NOT REBUILD. This is the invariant the palette
# texture exists for, and nothing else in the suite watches it: a change that
# quietly baked one face's colour would cost a full rebuild per colour switch
# and every picture would still be correct.
for m in REPAINT:
    if rows[m]["builds"] != 0:
        bad.append(f"switching to {m} rebuilt {rows[m]['builds']} time(s) -"
                   " a colour change should be a texture upload")
    if rows[m]["pal"] is not True:
        bad.append(f"{m} left the palette incomplete, so every colour change"
                   " after it will rebuild")
# 🔴 AND NOTHING MAY LEAVE THE PALETTE INCOMPLETE ANY MORE. ss mode and
# per-residue overrides used to, and then every colour change after them was a
# full rebuild. geom publishes what it resolved into renderer._cartoonPalette
# and the rib face reads its own half of it, so the lookup is right in every
# mode - which is what these two rows are.
for label in ("ss", "ss again", "override set", "switch while overridden"):
    if rows[label]["pal"] is not True:
        bad.append(f"'{label}' left the palette incomplete - the colour is baked"
                   " into the mesh again, so every colour change after it will"
                   " rebuild")
# ...and the two that are only a colour, with the cut structure already right,
# must be free. These were 1 rebuild each before the palette carried the
# resolved colours.
for label in ("ss again", "switch while overridden"):
    if rows[label]["builds"] != 0:
        bad.append(f"'{label}' rebuilt {rows[label]['builds']} time(s) - the"
                   " cuts do not move here, so this is a repaint")
    if rows[label]["moved"]:
        bad.append(f"'{label}' moved the signature {rows[label]['moved']} -"
                   " which would make the rebuild legitimate and this file's"
                   " claim wrong")
# ...and ss is free too now, in both directions. It was not: the ss colour was
# resolved INSIDE the draw pass, so a repaint had nothing to upload and the mode
# had to be in the mesh signature. resolveSegmentColors answers it from the
# assignment, the palette and each segment's two residues - no geometry - so
# entering and leaving are uploads like every other colour change.
for label in ("ss", "leaving ss"):
    if rows[label]["builds"] != 0:
        bad.append(f"'{label}' rebuilt {rows[label]['builds']} time(s) - ss adds"
                   " no cut anywhere (col === colFar for an interval), so this"
                   " is a repaint")
# 🔴 THE ONE THAT MUST STILL REBUILD. An override is per RESIDUE, so the two
# ends of an interval can differ, and that difference CUTS the ribbon at its
# midpoint - geometry, which no repaint can produce. If this ever goes free,
# either the cut rule changed or something is drawing transitions half a residue
# late, and that is worth stopping on.
if rows["override set"]["builds"] < 1:
    bad.append("setting a per-residue override did not rebuild - the cuts it"
               " causes cannot come from a repaint")

print()
for b in bad:
    print("FAIL: " + b)
print("colour repaint: " + ("FAILED" if bad else "an upload, except where it cannot be"))
sys.exit(1 if bad else 0)
