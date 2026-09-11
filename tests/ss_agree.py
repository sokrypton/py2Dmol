"""THE ASSIGNMENT BEHIND THE COLOURS IS THE ONE BEHIND THE GEOMETRY.

    python3 tests/ss_agree.py [1UBQ.cif 2POR.cif ...]

secForColor carries a comment saying it makes "the same call the draw stage
makes, so the colours cannot disagree with the geometry: colouring from a
different pipeline used to tint the last residue of every helix as coil while
the ribbon drew it as helix". It was not making the same call. The draw stage
passes `groups` - which positions may bond to which, so an overlay does not find
hydrogen bonds between superimposed copies - and `links`, which residues the
FILE says are one polymer. The colour path passed neither, so its assignment
could bond across a chain break the geometry knew about.

    letters where the ribbon and the colour disagreed, before

    2POR    1,164 residues, 24 chains        3   (300 C/E, 601 C/E, 902 C/E)
    1AOI    1,103 residues, 16 chains        2   (474 C/H, 477 H/C)
    1UBQ, 3CHY, 4HHB, 1EHZ                   0
    _traj_1tim.pdb in OVERLAY, 14,820    2,548

Three residues on a porin drawn as coil and coloured as strand, at exactly the
chain ends where a missing `links` lets the search reach into the next chain -
and then 2,548 of 14,820 in overlay mode, which is what a missing `groups` does:
thirty superimposed copies of one molecule, a couple of Angstrom apart, bonding
enthusiastically to each other. Now zero on all seven.

🔴 THE OVERLAY ARM IS HERE BECAUSE THE STATIC ONES CANNOT GATE `groups`. A
single structure has no sourceGroups at all, so dropping that term changes
nothing on any of the six above and half of this file's claim would be
untested. Falsified both ways: without `links` the porin and the nucleosome come
back, without `groups` the overlay does.

🔴 THE COMMENT WAS RIGHT AND THE CODE HAD DRIFTED FROM IT, which is the whole
reason this file exists: a claim in a comment is not a gate. What is compared
here is the letter-for-letter assignment the two paths produce for the same
frame, with both caches cleared so neither can answer with the other's work.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_ssagree.html")
PORT = 9899
DEBUG_PORT = 9900
FILES = sys.argv[1:] or ["1UBQ.cif", "3CHY.cif", "2POR.cif", "1AOI.cif",
                         "4HHB.cif", "1EHZ.cif"]

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (files) => {
   try {
    const out = [];
    for (const f of files) {
      const t = await (await fetch('/' + f)).text();
      await window.processFiles([{name: f, readAsync: () => Promise.resolve(t)}], true);
      await until(loaded, 300000);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      await until(() => r.coords && r.coords.length > 0, 300000);
      await settle(8);
      await until(() => !r._quietStyle && !r._switchQuiet, 60000);
      // CARTOON, because the draw stage's assignment is what this compares
      // against and only the ribbon builds one.
      if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
      await settle(10);
      r.render('ssagree'); await settle(6);
      const drawn = r._cartoonSec;                    // what the ribbon used
      // 🔴 BOTH CACHES CLEARED, or the colour path answers with the draw
      // stage's array - secForColor checks _cartoonSec FIRST, by design, so
      // without this the two agree trivially and this file checks nothing.
      r._ssColorSec = null; r._ssColorKey = null;
      const holdA = r._cartoonSec; const holdB = r._cartoonSecKey;
      r._cartoonSec = null; r._cartoonSecKey = null;
      const coloured = window.py2dmolCartoon.secondaryFor(r);
      r._cartoonSec = holdA; r._cartoonSecKey = holdB;
      let diff = -1; const at = [];
      if (drawn && coloured && drawn.length === coloured.length) {
        diff = 0;
        for (let i = 0; i < drawn.length; i++) {
          if (drawn[i] !== coloured[i]) {
            diff += 1;
            if (at.length < 8) at.push(i + ' ' + drawn[i] + '/' + coloured[i]);
          }
        }
      }
      out.push({file: f, n: r.coords.length, diff, at,
                chains: new Set(r.chains || []).size,
                helix: (drawn || []).filter((c) => c === 'H').length,
                strand: (drawn || []).filter((c) => c === 'E').length});
    }

    // 🔴 AND ONE ARM WHERE `groups` IS THE TERM THAT MATTERS. Overlay mode
    // merges every frame of a trajectory into one coordinate array, so without
    // it the assignment goes looking for hydrogen bonds between superimposed
    // COPIES of the molecule - a couple of Angstrom apart, and they bond
    // enthusiastically. Nothing above reaches that: a single static structure
    // has no sourceGroups at all, so dropping the term there changes nothing
    // and this file would be gating one of its two claims.
    const r2 = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    const overlay = document.querySelector('#overlayButton');
    let overlayRow = null;
    if (overlay) {
      const tj = '_traj_1tim.pdb';
      const txt = await (await fetch('/' + tj)).text();
      await window.processFiles([{name: tj, readAsync: () => Promise.resolve(txt)}], true);
      await until(loaded, 300000);
      await until(() => r2.coords && r2.coords.length > 0, 300000);
      await settle(8);
      await until(() => !r2._quietStyle && !r2._switchQuiet, 60000);
      if (r2.setStyle) r2.setStyle('cartoon'); else r2.style = 'cartoon';
      await settle(8);
      overlay.click();
      await settle(12);
      r2.render('ssagree:overlay'); await settle(6);
      const merged = !!(r2.sourceGroups && r2.sourceGroups());
      const drawn2 = r2._cartoonSec;
      r2._ssColorSec = null; r2._ssColorKey = null;
      const hA = r2._cartoonSec; const hB = r2._cartoonSecKey;
      r2._cartoonSec = null; r2._cartoonSecKey = null;
      const col2 = window.py2dmolCartoon.secondaryFor(r2);
      r2._cartoonSec = hA; r2._cartoonSecKey = hB;
      let d2 = -1; const at2 = [];
      if (drawn2 && col2 && drawn2.length === col2.length) {
        d2 = 0;
        for (let i = 0; i < drawn2.length; i++) {
          if (drawn2[i] !== col2[i]) {
            d2 += 1;
            if (at2.length < 8) at2.push(i + ' ' + drawn2[i] + '/' + col2[i]);
          }
        }
      }
      overlayRow = {file: tj + ' (overlay)', n: r2.coords.length, diff: d2,
                    at: at2, chains: new Set(r2.chains || []).size, merged,
                    helix: (drawn2 || []).filter((c) => c === 'H').length,
                    strand: (drawn2 || []).filter((c) => c === 'E').length};
    }
    return {out, overlayRow};
   } catch (e) { return {error: String((e && e.stack) || e)}; }
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
profile_dir = "/tmp/py2dmol-ssagree"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_ssagree.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILES)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:400])

bad = []
anyStructure = False
rows = list(res["out"])
ov = res.get("overlayRow")
if ov:
    rows.append(ov)
else:
    print("  (no #overlayButton on this page, so the `groups` term is ungated)")
for r in rows:
    print(f"  {r['file']:<12} n={r['n']:<6} chains={r['chains']:<3}"
          f" H={r['helix']:<5} E={r['strand']:<5}"
          f" differing letters: {r['diff']:>4}"
          + (("   " + "  ".join(r["at"])) if r["at"] else ""))
    if r["helix"] or r["strand"]:
        anyStructure = True
    if r["diff"] < 0:
        bad.append(f"{r['file']}: one of the two assignments is missing or a"
                   " different length, so nothing was compared - the draw stage"
                   " leaves _cartoonSec and the colour path is secondaryFor")
    elif r["diff"]:
        bad.append(f"{r['file']}: {r['diff']} residue(s) are drawn as one thing"
                   f" and coloured as another ({', '.join(r['at'])})."
                   " secForColor and the draw stage must pass assignSecondary"
                   " the same options - `groups` and `links` are the two that"
                   " have been dropped before")

# 🔴 A GATE THAT CANNOT FAIL IS NOT A GATE: with no helix and no strand
# anywhere, every letter is 'C' and the two paths agree by having nothing to
# disagree about.
if ov and not ov.get("merged"):
    bad.append("overlay mode did not merge the frames, so sourceGroups() is"
               " null and the `groups` arm proved nothing - the button is"
               " there but it did not take")
if not anyStructure:
    bad.append("no structure in this set has a single helix or strand, so the"
               " two assignments agree on a string of coil and this file has"
               " checked nothing")

print()
for b in bad:
    print("FAIL: " + b)
print("ss agree: " + ("FAILED" if bad else "the colours and the ribbon read one assignment"))
sys.exit(1 if bad else 0)
