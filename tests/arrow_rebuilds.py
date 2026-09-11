"""ARROWS NO LONGER MAKE A TRAJECTORY REBUILD, and this is the gate on that.

    python3 tests/arrow_rebuilds.py [_traj_1tim.pdb]

A secondary-structure letter chooses a PROFILE - a half-width and a thickness -
and the station table carries both, rewritten from the prims every frame. So a
letter that changes costs nothing: since the ribbon got one construction for
every letter, an H <-> C flip moves +0 stations, +0 pieces and +0 faces, mapping
included (tests/ss_axis.py).

🔴 THE ARROWHEAD USED TO BE THE EXCEPTION, and this file used to assert that it
was: with arrows on, 10 of 29 steps rebuilt, and the gate REQUIRED that, because
otherwise the zero in the other arm was not attributable to the head. Two things
made the head free, and both are in geom.js:

  * the seam's second sample is paid for out of the interval's own sampling
    rather than added to it, so an arrow interval has the same station count as
    any other (10 rebuilds -> 8);
  * the strand's blunt start is a width RAMP over a quarter of a residue
    (RICH_START_RAMP) instead of a step with a cap face across it, and a cap is
    a face, and a face a letter creates is a rebuild (8 -> 1).

Nothing rebuilds now, in either arm. What the file asserts is the sharper
statement rather than the bare zero: the two arms must rebuild the SAME number
of times, so the arrowhead is proved to cost nothing whether or not something
else in the frame costs something. Put the seam's extra station or the blunt
end's cap face back and the arms stop agreeing.

🔴 AND A ZERO ON ITS OWN WOULD MEAN NOTHING, because a station path that had
quietly given up would read the same. The witness is the station PAD: the two
arms must hold the same number of station floats - if they do not, the head is
still topology - with different values in them, which is the head being drawn.

🔴 WHAT IS LEFT STALE, AND IT IS NOT A REBUILD. `fullOutline: rich && p.ss ===
'E'` decides how many EDGES a face contributes, and the edge table is built once
with the mesh, so a residue that stops being a strand keeps the strand's creases
until something else rebuilds. Measured on _traj_unfold.pdb as 0.1991% of the
frame at a worst channel of 146; tests/station_unpinned.py is the gate on it and
its bar is a fraction of what a step itself moves. See paintgl.js beside
`fullOutline` for what removing it would cost.

🔴 AND IT REACHES A PROTEIN WITH NO SHEET IN IT. The assignment finds a
transient strand as a structure breathes - two frames in twenty on a four-helix
bundle - so this is not a sheet-protein problem a helix viewer can ignore.

🔴 AND THE DECISION HAS TO BE READ BETWEEN setFrame AND ANYTHING ELSE. setFrame
renders, so a probe that renders again and then asks gets the state the SECOND
render left: stationDecline() reads null and the gate flags read "sigSame" for
every step, which is the decision after it was made. Two earlier versions of
this measurement reported exactly that and were wrong.
"""
import json, os, sys, shutil, http.server, socketserver, threading
sys.path.insert(0, "/Users/mini/Documents/GitHub/py2Dmol/tests")
import cdp
from probe_js import HELPERS
ROOT = "/Users/mini/Documents/GitHub/py2Dmol"
PROBE = os.path.join(ROOT, "_arrowreb.html")
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILE = ARGS[0] if ARGS else "_traj_1tim.pdb"
SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
   try {
    window.__gateProbe = true;
    const G = window.py2dmolCartoonGPU;
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 300000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 300000);
    await settle(8);
    if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
    await settle(12);
    if (typeof window.__detailAt === 'number') r.cartoonDetail = window.__detailAt;
    // 🔴 THROUGH THE REAL CONTROL, not the renderer field. The question is
    // whether the checkbox a reader can actually click delivers this, which is
    // a different claim from "the flag does".
    if (typeof window.__noArrows === 'boolean' && window.__noArrows) {
      const cb = document.querySelector('#arrowsCheckbox');
      if (!cb) return {error: 'no #arrowsCheckbox in the page'};
      cb.checked = false;
      cb.dispatchEvent(new Event('change', {bubbles: true}));
      await settle(8);
      if (r.cartoonArrows !== false) return {error: 'the checkbox did not reach cartoonArrows'};
    }
    if (G.setStationDraw) G.setStationDraw(true);
    const obj = r.objectsData[r.currentObjectName];
    const frames = (obj && obj.frames) ? obj.frames.length : 1;
    r.setFrame(0); r.render('warm'); await settle(6);
    const secOf = () => {
      const f = window.py2dmolCartoon && window.py2dmolCartoon.secForColor;
      let a = f ? f(r) : null;
      if (!a) a = r._cartoonSec;
      if (!a) return '';
      return typeof a === 'string' ? a : (Array.isArray(a) ? a.join('') : '');
    };
    const walk = async (tag) => {
      const out = [];
      let prevSec = secOf();
      let prevSegs = (r.segmentIndices && r.segmentIndices.length) || 0;
      r.setFrame(0); r.render(tag + 'warm'); await settle(6);
      for (let i = 1; i < Math.min(frames, 30); i += 1) {
        const b0 = window.__faceBuilds || 0;
        window.__gateWhy = null;
        r.setFrame(i);
        const whyNow = G.stationDecline ? G.stationDecline() : null;
        await settle(3);
        const built = (window.__faceBuilds || 0) - b0;
        const sec = secOf();
        const segs = (r.segmentIndices && r.segmentIndices.length) || 0;
        let letters = 0;
        const kinds = {};
        const n2 = Math.min(sec.length, prevSec.length);
        for (let k = 0; k < n2; k += 1) {
          if (sec[k] !== prevSec[k]) {
            letters += 1;
            const key = prevSec[k] + '->' + sec[k];
            kinds[key] = (kinds[key] || 0) + 1;
          }
        }
        out.push({frame: i, built, lettersChanged: letters, kinds,
                  segsChanged: segs !== prevSegs,
                  why: built ? (whyNow || 'no reason recorded') : null});
        prevSec = sec; prevSegs = segs;
      }
      return out;
    };
    // 🔴 AND THE HEAD HAS TO BE IN THE GEOMETRY, or two arms of nothing agree
    // perfectly. Now that the arrowhead costs no station, no piece and no face,
    // the only thing that says it is drawn at all is the station PAD - the
    // per-station half-widths, where the barbs and the taper live. Same frame,
    // both arms: they must differ.
    const padHash = () => {
      const d = G.stationDump ? G.stationDump() : null;
      const p = d ? d.stationPad : null;
      if (!p || !p.length) return null;
      let h = 0;
      for (let k = 0; k < p.length; k += 1) h += p[k] * (k % 97 + 1);
      return {n: p.length, h: +h.toFixed(3)};
    };
    const withArrows = await walk('on');
    r.setFrame(0); r.render('padon'); await settle(4);
    const padOn = padHash();
    const cb = document.querySelector('#arrowsCheckbox');
    if (!cb) return {error: 'no #arrowsCheckbox in the page'};
    cb.checked = false;
    cb.dispatchEvent(new Event('change', {bubbles: true}));
    await settle(8);
    if (r.cartoonArrows !== false) {
      return {error: 'the checkbox did not reach renderer.cartoonArrows'};
    }
    const withoutArrows = await walk('off');
    r.setFrame(0); r.render('padoff'); await settle(4);
    const padOff = padHash();
    const sh = G.stationsResident ? G.stationsResident() : null;
    return {withArrows, withoutArrows, frames, padOn, padOff,
            shape: sh ? {stations: sh.stations, pieces: sh.pieces, faces: sh.count} : null};
   } catch (e) { return {error: String((e && e.stack) || e)}; }
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
httpd = socketserver.TCPServer(("127.0.0.1", 9967), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome, ws = cdp.launch(9968, "/tmp/py2dmol-arrowreb")
ws.call("Page.enable"); ws.call("Runtime.enable")
ws.call("Page.navigate", url="http://127.0.0.1:9967/_arrowreb.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page")
NOARROW = "true" if "--no-arrows" in sys.argv else "false"
cdp.evaluate(ws, f'(window.__noArrows = {NOARROW}, "ok")')
DET = next((a.split("=",1)[1] for a in sys.argv if a.startswith("--detail=")), None)
if DET:
    cdp.evaluate(ws, f'(window.__detailAt = {DET}, "ok")')
res = json.loads(cdp.evaluate(ws, f'window.__go("{FILE}").then(JSON.stringify)'))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-arrowreb", ignore_errors=True)
if res.get("error"):
    sys.exit("page error: " + res["error"][:400])

bad = []
on = res["withArrows"]
off = res["withoutArrows"]
def summarise(tag, rows):
    b = [r for r in rows if r["built"]]
    ch = [r for r in rows if r["lettersChanged"]]
    kinds = sorted({k for r in ch for k in (r.get("kinds") or {})})
    print(f"  arrows {tag:<3} {len(rows)} steps, {len(b)} rebuilt;"
          f" {len(ch)} steps changed the assignment ({', '.join(kinds) or 'none'})")
    for r in b[:3]:
        print(f"      {(r['why'] or '')[:88]}")
    return b, ch
bOn, chOn = summarise("on", on)
bOff, chOff = summarise("off", off)

# 🔴 NEITHER ARM MAY REBUILD NOW, and the first step is the one exception -
# it has no previous topological key to compare against, so its rebuild is the
# walk starting rather than anything about a letter.
def offending(rows):
    return [r for r in rows if r["built"] and r["frame"] > 1]


if not chOn or not chOff:
    bad.append("the assignment never changed in one of the arms, so nothing"
               " here was measured - this needs a trajectory whose fold moves")
# 🔴 THE TWO ARMS MUST REBUILD THE SAME NUMBER OF TIMES, which is the claim:
# the arrowhead is geometry the station table carries, not topology it cannot.
# Whatever else forces a rebuild - today the strand set, for the outline's sake
# - forces it identically with the head drawn and without it.
nOn, nOff = len(offending(on)), len(offending(off))
if nOn != nOff:
    why = ((offending(on) + offending(off))[0]["why"] or "")[:90]
    bad.append(f"arrows ON rebuilt {nOn} times past the first and arrows OFF"
               f" {nOff}: the arrowhead is costing the difference."
               f" First reason: {why}")
else:
    print(f"  both arms rebuilt {nOn} time(s) past the first - the arrowhead"
          " changes nothing")
# ...and two zeroes would satisfy that equality while saying nothing about the
# head, so the pad check below is what carries the file in that case.
if nOn == 0:
    print("  (nothing rebuilt in either arm - the pad check is what makes this"
          " mean anything)")

# 🔴 AND THE ARROWHEAD HAS TO BE DRAWN, or both zeroes are about nothing. It
# costs no station, no piece and no face any more, so the counts cannot say it
# is there; the station pad can, and the two arms must disagree on it.
pOn, pOff = res.get("padOn"), res.get("padOff")
if not pOn or not pOff:
    bad.append("no station pad in one of the arms, so nothing says the"
               " arrowhead reached the geometry")
elif pOn["n"] != pOff["n"]:
    bad.append(f"the arms hold different numbers of station floats -"
               f" {pOn['n']} against {pOff['n']} - so the arrowhead is still"
               " topology, which is the thing this file exists to deny")
elif pOn["h"] == pOff["h"]:
    bad.append("the station pad is identical with arrows on and off, so the"
               " head is not being drawn at all and both zeroes are about"
               " nothing")
else:
    print(f"  the head is in the widths: {pOn['n']} station floats either way,"
          f" different values ({pOn['h']} against {pOff['h']})")

print()
for b in bad:
    print("FAIL: " + b)
print("arrow rebuilds: " + ("FAILED" if bad
                            else "the arrowhead costs no rebuild, and is drawn"))
sys.exit(1 if bad else 0)
