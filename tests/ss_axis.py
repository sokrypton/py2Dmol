"""DOES A SECONDARY-STRUCTURE CHANGE MOVE THE TOPOLOGY?

    python3 tests/ss_axis.py [1UBQ.cif 3CHY.cif ...]

The station table carries a ribbon's shape as two floats a station - `hw`, the
half-width, and `ht`, the half-thickness - and it is rewritten from the prims on
every frame. Secondary structure sets exactly those two:

    SS_HALF_A   = { H: 1.3, E: 1.1, C: 0.42 }
    RICH_TH_REL = { H: 0,   E: 1.0, C: 1.0  }

So the SHAPE half of an SS change is already a per-frame quantity. If the
TOPOLOGY - the station, piece and face counts - held still across a change of
letter, then a residue could hold any value between helix and loop and the
renderer would need no new concept: it would be interpolating two floats it
already reads every frame. And a trajectory whose assignment drifts would stop
rebuilding, which is what nine of eleven declines on _traj_9fog.pdb are.

This file measures whether it holds still. It forces letters through the `sse`
override - the same override the SSE editor writes - and reads the counts back
off the installed table.

🔴 IT IS A GATE NOW, AND IT WAS A MEASUREMENT THAT COULD NOT FAIL BEFORE. The
assertion used to be behind `--require-invariance`, because at the constants of
the day the counts really did move. They do not any more - the ribbon is built
one way for every letter - so the flag is inverted: the invariance is checked by
default and `--measure-only` is the way to look without asserting. Left as it
was, this file printed the right numbers and exited 0 with a second sampling
rate deliberately put back, which is the whole of what a gate is for.

🔴 IT HOLDS AT THE FLOOR TOO NOW, AND `--detail=2` IS A GATE IN run.sh. An
interval has nsub + 1 stations to spend, and the duplicates that keep the barb
step and the blunt end square come out of that budget. At Detail 4 (nsub 4,
five stations) there is room for both. At Detail 2 there are three: enough for
the blunt end, which needs one sub-interval either side of nothing, and NOT
enough for a head that wants a shaft, a duplicated seam and a barb. It used to
lay out five stations of its own there, so a strand appearing moved the topology
- measured on 1UBQ as +12 stations and +2 pieces - and every frame of an
animation that gained or lost a strand end rebuilt: 60 of 79 replayed fight
steps at Detail 2, against 0 at Detail 3 and 0 with arrowheads off.

The head fills the interval instead and DUPLICATES the station at u = 0, one
copy at the shaft's width and one at the barbs', so the count is nsub + 1
whatever the letter says and the replay rebuilds 0 of 79. It costs nothing:
the zero-length band between the two copies IS the square back edge.

🔴 IT COST THE BARBS FOR A WHILE, AND THAT IS NO LONGER TRUE. The seam MOVED
onto a station the interval already had at first - which keeps the count right
and leaves no duplicate to stand the barbs up, so the width ramped and a
Detail 2 arrowhead tapered to a spearpoint. It was taken deliberately and
reported as a short sheet's arrow missing its sides; the duplicate is where the
third station came from. What this file measures either way is the COUNT, so it
passed against both - `tests/ss_arrow_shape.py` is the gate on the shape.

🔴 AND THE OVERRIDE HAS TO REACH THE MESH, or silence reads as invariance. It
cannot be shown by the counts any more - holding them still is the property
under test - so every arm has to move the STATION PAD instead: the per-station
half-width and half-thickness, which is exactly what a letter is allowed to
change. An arm that moves neither the counts nor the pad changed nothing at all,
and `sseKey` is in the rebuild signature precisely so that cannot happen
quietly.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_ssaxis.html")
PORT = 9953
DEBUG_PORT = 9954
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FILES = ARGS or ["1UBQ.cif", "3CHY.cif"]
REQUIRE = "--measure-only" not in sys.argv

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (files) => {
   try {
    const G = window.py2dmolCartoonGPU;
    const out = [];
    for (const file of files) {
      const t = await (await fetch('/' + file)).text();
      await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
      await until(loaded, 300000);
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      await until(() => r.coords && r.coords.length > 0, 300000);
      await settle(8);
      await until(() => !r._quietStyle && !r._switchQuiet, 60000);
      if (r.setStyle) r.setStyle('cartoon'); else r.style = 'cartoon';
      await settle(10);
      // ...and the arrowhead, which is the one thing in the ribbon a letter
      // can still CREATE. Turning it off isolates what the head costs from
      // what the letter costs: --no-arrows is how "-> E moved a face" gets
      // attributed to the head rather than to the strand.
      if (NO_ARROWS) { r.cartoonArrows = false; await settle(4); }
      // ...and the subdivision, because invariance is TIGHTEST at the floor.
      // An interval has nsub + 1 stations to spend and the duplicates that make
      // the barb step and the blunt end square come out of that budget, so the
      // question "is there enough" has a different answer at Detail 2 than at
      // 4. --detail=2 is how that gets asked rather than assumed.
      if (DETAIL_AT) { r.cartoonDetail = DETAIL_AT; await settle(6); }
      if (G.setStationDraw) G.setStationDraw(true);
      if (G.invalidate) G.invalidate();
      r.render('warm'); await settle(6);
      const obj = r.objectsData[r.currentObjectName];

      // 🔴 THE COUNTS ARE NOT WHAT stationsMatch COMPARES. It walks
      // faceStation and facePiece ELEMENT BY ELEMENT, so a mapping that keeps
      // its totals and renumbers underneath still refuses - and that is what a
      // trajectory hits: ten of ten rebuilds on _traj_1tim.pdb were
      // assignment-only with the segment list unchanged, while every count
      // arm below reads +0.
      // ...and the STATION PAD, which is the half-width and half-thickness
      // the letter actually sets. It is the only witness left that an override
      // reached the mesh once the counts are required to hold still, and it is
      // compared HERE rather than shipped: it is four floats a station and
      // there are a thousand of them.
      const shape = () => {
        const s = G.stationsResident ? G.stationsResident() : null;
        const d = G.stationDump ? G.stationDump() : null;
        return s ? {stations: s.stations, pieces: s.pieces, faces: s.count,
                    faceStation: d ? d.faceStation : null,
                    facePiece: d ? d.facePiece : null,
                    pad: d ? d.stationPad : null} : null;
      };
      const padMoved = (x, y) => {
        if (!x || !y) return -1;
        if (x.length !== y.length) return -2;
        let n = 0;
        for (let k = 0; k < x.length; k += 1) if (x[k] !== y[k]) n += 1;
        return n;
      };
      const secOf = () => {
        const f = window.py2dmolCartoon && window.py2dmolCartoon.secForColor;
        let a = f ? f(r) : null;
        if (!a) a = r._cartoonSec;
        if (!a) return '';
        if (typeof a === 'string') return a;
        if (Array.isArray(a)) return a.join('');
        return a.sec ? (Array.isArray(a.sec) ? a.sec.join('') : String(a.sec)) : '';
      };
      const base = shape();
      const basePadLen = base && base.pad ? base.pad.length : -1;
      const sec = secOf();
      // the runs, so a flip lands in the MIDDLE of one rather than on a
      // boundary where the assignment would have moved anyway
      const runs = [];
      let i0 = 0;
      for (let i = 1; i <= sec.length; i += 1) {
        if (i === sec.length || sec[i] !== sec[i0]) {
          runs.push({ss: sec[i0], a: i0, b: i - 1}); i0 = i;
        }
      }
      const pick = (ss, minLen) => runs.filter(
        (x) => x.ss === ss && x.b - x.a >= minLen)[0] || null;
      const helix = pick('H', 6);
      const loop = pick('C', 6);
      const withSse = async (map, tag) => {
        obj.sse = map;
        if (G.invalidate) G.invalidate();
        r.render(tag); await settle(6);
        const sh = shape();
        if (sh) { sh.padMoved = padMoved(base.pad, sh.pad); sh.pad = null; }
        obj.sse = null;
        if (G.invalidate) G.invalidate();
        r.render(tag + 'back'); await settle(6);
        return sh;
      };
      const arms = [];
      if (helix) {
        const mid = ((helix.a + helix.b) / 2) | 0;
        arms.push({name: 'one helix residue -> C',
                   shape: await withSse({[mid]: 'C'}, 'h2c')});
        const all = {};
        for (let i = helix.a; i <= helix.b; i += 1) all[i] = 'C';
        arms.push({name: 'a whole helix run -> C',
                   shape: await withSse(all, 'run2c')});
        arms.push({name: 'one helix residue -> E',
                   shape: await withSse({[mid]: 'E'}, 'h2e')});
        // 🔴 AND A STRAND LONG ENOUGH TO CARRY AN ARROWHEAD, which one residue
        // is not: isArrowInterval wants sec[j] and sec[j+1] both 'E', so a
        // single flipped residue makes a strand with no head at all and this
        // file measured the arrow by never creating one. Three residues give a
        // head, a shaft, a blunt start and a tip - every piece of geometry the
        // letter 'E' can add.
        const three = {};
        for (let k = mid - 1; k <= mid + 1; k += 1) three[k] = 'E';
        arms.push({name: 'three helix residues -> E',
                   shape: await withSse(three, 'h3e')});
      }
      if (loop) {
        const mid = ((loop.a + loop.b) / 2) | 0;
        arms.push({name: 'one loop residue -> H',
                   shape: await withSse({[mid]: 'H'}, 'c2h')});
      }
      // 🔴 AND THE FLIP A TRAJECTORY ACTUALLY MAKES, which is not a residue in
      // the middle of a run. An assignment drifts at the ENDS: a helix gains or
      // loses its last residue, so the run BOUNDARY moves. Everything that is
      // decided per run - where the two-tone cut falls, where an arrowhead
      // sits, which interval is the one before a strand - moves with it, and a
      // mid-run flip touches none of that. Measured on _traj_1tim.pdb: all ten
      // of the rebuilds in twenty-nine steps were assignment-only, with the
      // segment list unchanged, so this is the case that matters.
      if (helix) {
        arms.push({name: 'helix run grown by one',
                   shape: await withSse({[helix.a - 1]: 'H'}, 'grow')});
        arms.push({name: 'helix run shrunk by one',
                   shape: await withSse({[helix.a]: 'C'}, 'shrink')});
      }
      const restored = shape();
      if (restored) { restored.padMoved = padMoved(base.pad, restored.pad); restored.pad = null; }
      base.pad = null;
      out.push({file, padLen: basePadLen, base, arms, restored,
                runs: runs.length, positions: r.coords.length,
                haveHelix: !!helix, haveLoop: !!loop});
    }
    return {out};
   } catch (e) { return {error: String((e && e.stack) || e)}; }
  };
  window.__ready = true;
});
"""
SETUP = SETUP.replace("DETAIL_AT", next(
    (a.split("=", 1)[1] for a in sys.argv if a.startswith("--detail=")), "0")
).replace("NO_ARROWS",
    "true" if "--no-arrows" in sys.argv else "false").replace("//HELPERS", HELPERS)
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
profile_dir = "/tmp/py2dmol-ssaxis"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://{'127.0.0.1'}:{PORT}/_ssaxis.html")
cdp.wait_for(ws, "window.__ready === true", timeout=300, what="the page to load")
res = json.loads(cdp.evaluate(
    ws, f"window.__go({json.dumps(FILES)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if res.get("error"):
    sys.exit("page error: " + res["error"][:600])

bad = []
moved_any = False
for row in res["out"]:
    b = row["base"]
    if not b:
        bad.append(f"{row['file']}: no station table, so nothing was measured")
        continue
    print(f"  {row['file']}  {row['positions']} positions, {row['runs']} runs, pad {row.get('padLen')}")
    print(f"    {'as assigned':<26} stations {b['stations']:>6}"
          f"  pieces {b['pieces']:>6}  faces {b['faces']:>6}")
    for arm in row["arms"]:
        s = arm["shape"]
        if not s:
            bad.append(f"{row['file']}: {arm['name']} produced no table")
            continue
        # ...and the mapping, which is the thing that actually decides
        # 🔴 THE TWO SENTINELS ARE NOT COUNTS, and printing them as one read
        # as "-2 faces changed station", which is not a thing that can happen.
        # -1 is an absent mapping and -2 a mapping of a different LENGTH, and
        # the second is the ordinary way this fails: a letter that moves the
        # station count moves the face list with it.
        def mism(x, y):
            if not x or not y:
                return -1
            if len(x) != len(y):
                return -2
            return sum(1 for p, q in zip(x, y) if p != q)

        def sayMism(v):
            return ("absent" if v == -1
                    else "a different length" if v == -2 else f"{v} changed")
        arm["padMoved"] = s.get("padMoved")
        arm["dFaceStation"] = mism(b.get("faceStation"), s.get("faceStation"))
        arm["dFacePiece"] = mism(b.get("facePiece"), s.get("facePiece"))
        ds = s["stations"] - b["stations"]
        dp = s["pieces"] - b["pieces"]
        df = s["faces"] - b["faces"]
        if ds or dp or df:
            moved_any = True
        print(f"    {arm['name']:<26} stations {ds:+6d}"
              f"  pieces {dp:+6d}  faces {df:+6d}"
              f"   mapping: faces->station {sayMism(arm['dFaceStation'])},"
              f" faces->piece {sayMism(arm['dFacePiece'])}"
              f"   pad: {arm.get('padMoved')} floats moved")
        # 🔴 AND -> E IS HELD TO THE SAME BAR NOW. It used to be exempt: a
        # strand grew an arrowhead, and the head added a station at its seam and
        # a cap face at the strand's blunt start, both of which a letter CREATES
        # rather than resizes. The seam's second sample is paid for out of the
        # interval's own sampling now, and the blunt end is a width ramp instead
        # of a step with a cap across it, so every letter costs the same
        # nothing. An exemption that outlives its reason is a hole in a gate.
        hc = True
        if REQUIRE and hc and (ds or dp or df):
            bad.append(f"{row['file']}: {arm['name']} moved the topology by"
                       f" {ds:+d} stations, {dp:+d} pieces, {df:+d} faces."
                       " With the sampling uniform this has to be zero, or the"
                       " letter cannot be an axis - every value between H and C"
                       " would be a rebuild")
        # ...AND THE MAPPING, WHICH IS WHAT stationsMatch ACTUALLY WALKS. The
        # counts can hold while faceStation and facePiece renumber underneath,
        # and the fast path refuses on that, so a gate reading only the totals
        # would pass a mesh a trajectory still rebuilds.
        if REQUIRE and hc and (arm["dFaceStation"] or arm["dFacePiece"]):
            bad.append(f"{row['file']}: {arm['name']} moved the mapping -"
                       f" faces->station {sayMism(arm['dFaceStation'])},"
                       f" faces->piece {sayMism(arm['dFacePiece'])}."
                       " stationsMatch compares those element by element, so"
                       " this is a rebuild whatever the totals say")
        # ...and it has to have DONE something, or invariance is just silence.
        # The pad is the half-width and half-thickness: the two quantities a
        # letter is allowed to move, and the only witness left once the counts
        # are held.
        if REQUIRE and not (ds or dp or df) and not arm.get("padMoved"):
            bad.append(f"{row['file']}: {arm['name']} moved nothing at all -"
                       " not a count, not the mapping, not one float of the"
                       " station pad. The sse override never reached the mesh,"
                       " so the invariance above is about nothing")
    r2 = row["restored"]
    if r2 and (r2["stations"] != b["stations"] or r2["faces"] != b["faces"]):
        bad.append(f"{row['file']}: clearing the override did not restore the"
                   f" table - {r2['stations']} stations against {b['stations']}."
                   " Something the override set is sticky")
    if not row["haveHelix"]:
        bad.append(f"{row['file']}: no helix run of seven residues, so the"
                   " helix arms never ran")

# 🔴 THE COUNTS HOLDING STILL IS THE POINT, so `moved_any` is no longer
# evidence of anything: under --measure-only it is the one line worth printing,
# and under the gate the per-arm pad check above is what proves the override
# arrived. Falsified by putting a second sampling rate back into geom.js, where
# every arm moves and this file fails; without the pad check it exited 0.
if not moved_any:
    print("  (no arm moved a count, which is the property - see the pad column)")

print()
for b2 in bad:
    print("FAIL: " + b2)
print("ss axis: " + ("FAILED" if bad
                     else ("the topology holds still across a letter"
                           if REQUIRE else "measured")))
sys.exit(1 if bad else 0)
