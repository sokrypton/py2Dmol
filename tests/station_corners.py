"""The corners a station table implies are the corners the mesh was built from.

    python3 tests/station_corners.py

This is the gate the station path stands or falls on. stationMeshOf walks the
rib prims into two arrays - four texels a station in MODEL space, and two floats
a face saying which station and which surface - and the shader forms the corners
from them. Here the same arithmetic is done in JS and checked against
window.__fill, the instance rows buildMeshPart actually uploaded.

🔴 IT IS A TOLERANCE, NOT AN EQUALITY, AND THAT IS NOT A CONCESSION. The shipped
path takes corners geom.js has already PROJECTED and unprojects them again in
buildMeshPart; the station path never leaves model space. The two therefore
agree to the accuracy of that round trip - which is what the number below
measures, and which is itself worth knowing: if it is not tiny, the round trip
is losing precision the drawing depends on.

🔴 AND THE ORDER IS THE ASSERTION AS MUCH AS THE VALUES. Row i of the station
table has to describe the same face as row i of the fill, because everything
else in that row - the flags, the colour, the palette slot - stays where facesOf
put it. A table that is right but shuffled would show up here as garbage, which
is the point; a comparison that sorted first would hide exactly the bug that
matters.

🔴 A CONTROL RUNS TOO. Off-by-one on the station index has to fail, or the
tolerance is doing the work rather than the rule.
"""
import json, os, sys, shutil, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402
from probe_js import HELPERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_stationcorners.html")
PORT = 9797
DEBUG_PORT = 9798
FILE = sys.argv[1] if len(sys.argv) > 1 else "1UBQ.cif"

SETUP = """
window.__ready = false;
window.addEventListener('load', () => {
  //HELPERS
  window.__go = async (file) => {
    const t = await (await fetch('/' + file)).text();
    await window.processFiles([{name: file, readAsync: () => Promise.resolve(t)}], true);
    await until(loaded, 60000);
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    await until(() => r.coords && r.coords.length > 0, 60000);
    await settle(6);
    await until(() => !r._quietStyle && !r._switchQuiet, 20000);
    const G = window.py2dmolCartoonGPU;
    if (!G || !G.stationMeshOf) return {error: 'no stationMeshOf on the GPU API'};
    // 🔴 AND THE SIDE CHAINS ARE OUT, because sticks have stations now and this
    // gate had never seen one: 1,202 of 1,202 faces on 1UBQ were the ribbon's.
    // A stationed stick is the half of the table with the most ways to be
    // wrong - four sides, two caps and a flat case, against the ribbon's four
    // surfaces - and until this line none of them was compared against the
    // mesh the builder uploaded.
    if (r.showSidechains) r.showSidechains();
    await settle(8);

    // 1. THE SHIPPED MESH. __gpuDiag keeps the instance rows; the render after
    //    it has to actually rebuild, or __fill is from before the flag was set.
    window.__gpuDiag = true;
    window.__fill = null;
    if (G.invalidate) G.invalidate();
    r.render('stationCorners');
    await settle(4);
    const fill = window.__fill;
    if (!fill) return {error: 'no __fill after a forced rebuild'};

    // 2. THE PRIMS, at the same view and the same frame. _probeOnly stops the
    //    paint so this costs a capture and not a frame.
    // 🔴 THE GPU HAS TO STAND DOWN FOR THIS ONE RENDER. _renderToContext asks
    //    the card first and it says yes, so geom.js - which is what fills
    //    _primProbe - never runs at all, and the first version of this probe
    //    reported `prims: 0` from a render that had drawn a perfectly good
    //    frame. useGPU off makes the 2D path take it, and _probeOnly stops that
    //    path painting, so the capture costs neither a picture nor a frame.
    const keep = {po: r._probeOnly, pp: r._primProbe, fp: r._frameProbe,
                  tp: r._traceProbe, gpu: r.useGPU, nfc: r._noFoldCuts};
    r.useGPU = false;
    r._probeOnly = true; r._primProbe = null; r._frameProbe = true; r._traceProbe = null;
    // 🔴 AND NO FOLD CUTS, BECAUSE captureFrom DROPS THEM. This capture is a
    // hand-rolled copy of that function's hook setup, and it drifted the moment
    // captureFrom gained a hook: the mesh below was built from 201 pieces while
    // the instance rows it is compared against came from a render of 196. The
    // corners still agreed to 1.7e-06 - a cut divides a piece, it does not move
    // geometry - and the one quantity that depends on WHERE the division falls,
    // the piece mean the flat shading reads, came out 0.234 apart on piece 123.
    // A hand-copied list of options is a list that goes stale; this one is
    // pinned to the same rule captureFrom applies.
    r._noFoldCuts = r._keepFoldCuts !== true;
    r.render('stationCornersCapture');
    const prims = (r._primProbe || []).filter((p) => p && p.kind === 'rib' && p.Lp);
    // 🔴 _ribbonTrace, NOT _traceProbe. geom writes the raw centres into
    // _traceProbe in ROTATED space, and mol.js's _storeRibbonTrace consumes
    // that array, un-rotates it, adds the view centre back and leaves the
    // result on _ribbonTrace. Reading _traceProbe after a render therefore
    // finds it empty - which is what "traceLen: 0" meant on the first run - and
    // reading it before the un-rotation would have been rotated points quietly
    // treated as model space.
    const trace = r._ribbonTrace || [];
    r._noFoldCuts = keep.nfc;
    r._probeOnly = keep.po; r._primProbe = keep.pp;
    r._frameProbe = keep.fp; r._traceProbe = keep.tp; r.useGPU = keep.gpu;
    window.__gpuDiag = false;

    const centre = r._computeViewCentre
      ? r._computeViewCentre(r.objectsData[r.currentObjectName]) : null;
    const mesh = G.stationMeshOf(prims, trace, r.viewerState.rotation, centre);
    if (!mesh) {
      // WHY, not just that. Every prim being skipped has four possible causes
      // and "built nothing" names none of them.
      const p0 = prims[0] || {};
      return {error: 'stationMeshOf built nothing', prims: prims.length,
        traceLen: trace.length,
        withUb: prims.filter((p) => p.ub).length,
        withWa: prims.filter((p) => p.wa).length,
        withTv: prims.filter((p) => p.tv).length,
        withHalf: prims.filter((p) => p.half).length,
        firstKeys: Object.keys(p0).join(','),
        firstGs: [p0.gs0, p0.gsStep]};
    }

    // 3. THE SAME ARITHMETIC THE SHADER DOES, in JS.
    const SIGN = [
      [[ 1, 1], [-1, 1]],   // 0  +b : Lp, Rp
      [[ 1,-1], [-1,-1]],   // 1  -b : Lm, Rm
      [[ 1, 1], [ 1,-1]],   // 2  +w : Lp, Lm
      [[-1, 1], [-1,-1]],   // 3  -w : Rp, Rm
    ];
    const st = mesh.stations;
    const at = (i, slot) => {
      const o = i * 16 + slot * 4;
      return [st[o], st[o + 1], st[o + 2], st[o + 3]];
    };
    const corner = (i, sw, stg) => {
      const m = at(i, 0); const u = at(i, 1); const w = at(i, 2);
      const hw = m[3]; const ht = u[3];
      return [m[0] + w[0] * hw * sw + u[0] * ht * stg,
              m[1] + w[1] * hw * sw + u[1] * ht * stg,
              m[2] + w[2] * hw * sw + u[2] * ht * stg];
    };
    // 🔴 AND THE STICK VOCABULARY, WHICH THIS FILE NEVER SAW. It checked
    // surfaces 0-3 and treated everything at 4 or above as a ribbon CAP - true
    // while the table described rib prims alone. Sticks have stations now, and
    // theirs are 4 and 5 (the two caps), 6 (a flat stick, whose four corners
    // are stored in the texels themselves) and 7-10 (the four sides). Read as
    // caps, a side face reports an enormous disagreement that is the PROBE's
    // and not the mesh's - so the surfaces are spelled out, once, in the order
    // the shader writes them.
    const STICK = {
      4:  [[ 1, 1], [ 1,-1], [-1,-1], [-1, 1]],   // cap at this station
      5:  [[ 1, 1], [-1, 1], [-1,-1], [ 1,-1]],   // cap at the far one (k+1)
      7:  [[ 1, 1], [-1, 1]],                     // +u side, A then B
      8:  [[-1, 1], [-1,-1]],                     // -w side
      9:  [[-1,-1], [ 1,-1]],                     // -u side
      10: [[ 1,-1], [ 1, 1]],                     // +w side
    };
    // 🔴 AND 4 AND 5 MEAN TWO DIFFERENT THINGS, which the table does not say.
    // A ribbon cap has been surface 4 or 5 since the table existed; a stick cap
    // took the same two numbers, with a different corner ORDER for 5. Nothing
    // in the row distinguishes them, so this reads the one thing that does:
    // makeResident concatenates ribbon faces FIRST, so a face index below the
    // ribbon count is a rib and everything after it is a stick. That the probe
    // has to know this is the finding - a self-describing table would give the
    // stick caps their own numbers.
    const nRib = (window.__rebuild && window.__rebuild.nRibbon) || 0;
    const quadOf = (surf, k, f) => {
      const stick = f >= nRib;
      // a flat stick keeps its corners in the four texels, not a frame
      if (surf === 6) return [at(k, 0).slice(0, 3), at(k, 1).slice(0, 3),
                              at(k, 2).slice(0, 3), at(k, 3).slice(0, 3)];
      const t = stick ? STICK[surf] : null;
      if (t && (surf === 4 || surf === 5)) {
        return t.map(([a, b]) => corner(k, a, b));
      }
      if (t) {
        const [sA, sB] = t;
        return [corner(k, sA[0], sA[1]), corner(k, sB[0], sB[1]),
                corner(k + 1, sB[0], sB[1]), corner(k + 1, sA[0], sA[1])];
      }
      // ...the ribbon's own four, unchanged
      if (surf >= 4) {
        return [corner(k, 1, 1), corner(k, 1, -1), corner(k, -1, -1), corner(k, -1, 1)];
      }
      const [sA, sB] = SIGN[surf];
      return [corner(k, sA[0], sA[1]), corner(k, sB[0], sB[1]),
              corner(k + 1, sB[0], sB[1]), corner(k + 1, sA[0], sA[1])];
    };
    // 🔴 A CONSTANT OFFSET IS A DIFFERENT FAULT FROM A WRONG CORNER, and the
    // worst-case number cannot tell them apart. _storeRibbonTrace adds the view
    // CENTRE back when it un-rotates, and buildMeshPart's unprojected corners
    // may not carry it - so the mean difference is reported beside the worst,
    // and the worst is reported again with that mean removed. If the residual
    // collapses, the two are the same geometry in two origins.
    const compare = (shift, off) => {
      const o = off || [0, 0, 0];
      let worst = 0; let worstAt = -1; let scale = 0; let n = 0;
      const sum = [0, 0, 0];
      const rows = Math.min(mesh.faceCount, Math.floor(fill.length / 48));
      for (let f = 0; f < rows; f++) {
        const surf = mesh.faceSurf[f];
        const k = mesh.faceStation[f] + shift;
        const q = quadOf(surf, k, f);
        for (let c = 0; c < 4; c++) {
          for (let a = 0; a < 3; a++) {
            const got = q[c][a] - o[a];
            const want = fill[f * 48 + c * 3 + a];
            sum[a] += got - want;
            const d = Math.abs(got - want);
            if (d > worst) { worst = d; worstAt = f; }
            scale = Math.max(scale, Math.abs(want));
            n += 1;
          }
        }
      }
      return {worst, worstAt, scale, n, rows,
        mean: [sum[0] / (n / 3), sum[1] / (n / 3), sum[2] / (n / 3)]};
    };
    const first = compare(0);
    // ...and with the mean removed, which must now change nothing: the builder
    // subtracts the view centre itself, so a non-zero mean here is a table
    // built about the wrong origin.
    const centred = compare(0, first.mean);
    // 🔴 AND A SCALE, BECAUSE buildMeshPart TAKES ONE. The mesh is built at a
    // `scale` the resident carries, so the two spaces may differ by more than
    // an origin. Fitted per axis by least squares over every corner - want =
    // s*got + t - rather than assumed: if one shared s makes the residual
    // collapse, the station table is the same geometry in a scaled frame, and
    // if it does not, the difference is real geometry and no fit will hide it.
    const fit = (() => {
      const rows = Math.min(mesh.faceCount, Math.floor(fill.length / 48));
      const S = [];
      for (let a = 0; a < 3; a++) {
        let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let n = 0;
        for (let f = 0; f < rows; f++) {
          const surf = mesh.faceSurf[f]; const k = mesh.faceStation[f];
          const q = quadOf(surf, k, f);
          for (let c = 0; c < 4; c++) {
            const x = q[c][a]; const y = fill[f * 48 + c * 3 + a];
            sx += x; sy += y; sxx += x * x; sxy += x * y; n += 1;
          }
        }
        const det = n * sxx - sx * sx;
        const sc = Math.abs(det) > 1e-9 ? (n * sxy - sx * sy) / det : 1;
        S.push({scale: sc, offset: (sy - sc * sx) / n});
      }
      return S;
    })();
    const fitted = (() => {
      const rows = Math.min(mesh.faceCount, Math.floor(fill.length / 48));
      let worst = 0; let worstAt = -1;
      for (let f = 0; f < rows; f++) {
        const surf = mesh.faceSurf[f]; const k = mesh.faceStation[f];
        const q = quadOf(surf, k, f);
        for (let c = 0; c < 4; c++) {
          for (let a = 0; a < 3; a++) {
            const got = q[c][a] * fit[a].scale + fit[a].offset;
            const d = Math.abs(got - fill[f * 48 + c * 3 + a]);
            if (d > worst) { worst = d; worstAt = f; }
          }
        }
      }
      return {worst, worstAt};
    })();
    return {
      prims: prims.length, stations: mesh.stationCount, faces: mesh.faceCount,
      missing: mesh.missing, fillRows: Math.floor(fill.length / 48),
      real: first, centred, fit, fitted, control: compare(1, first.mean),
      // 🔴 THE SHADING VECTORS TOO, which are the other half of the row and
      // the half a corner check cannot see. Row layout, from the emit pass:
      //   0..11 corners   12..14 nA   15..17 nB   18..20 tA   21..23 tB
      //   24..26 outward normal   27..29 flat-shading normal   30..32 dots
      // A broad face shades from ub and a width band from wa; the outward
      // normal is the same vector flipped by `top`; the flat one is the PIECE
      // mean. Each is derived here exactly as the shader would.
      vectors: (() => {
        const rows = Math.min(mesh.faceCount, Math.floor(fill.length / 48));
        const named = {nA: 12, nB: 15, tA: 18, tB: 21, outward: 24, flat: 27};
        const worst = {};
        for (const k in named) worst[k] = 0;
        for (let f = 0; f < rows; f++) {
          const surf = mesh.faceSurf[f];
          if (surf >= 4) continue;                 // caps take their own rule
          const k = mesh.faceStation[f];
          const pid = mesh.facePiece[f];
          const broad = surf < 2;
          // 🔴 ONE SIGN, USED TWO WAYS, AND THEY ARE NOT THE SAME WAY.
          // buildMeshPart's sideSign is -1 on surface 2, and the frame's w is
          // stored NEGATED (it is -wa, because R - L runs along -wa). So the
          // shading normal is sideSign * w = -sideSign * wa, while the flat
          // normal is sideSign * wMean with wMean already in the w convention.
          // Deriving both from one "sideN" got the second flipped: a unit
          // vector 2.0 away from the right one, which is the whole vector
          // pointing into the ribbon instead of out of it.
          const sideSign = (surf === 2) ? -1 : 1;
          const ubA = at(k, 1); const waA = at(k, 2); const tvA = at(k, 3);
          const ubB = at(k + 1, 1); const waB = at(k + 1, 2); const tvB = at(k + 1, 3);
          const nAv = broad ? ubA : waA.map((v) => -v * sideSign);
          const nBv = broad ? ubB : waB.map((v) => -v * sideSign);
          // `top` decides which way the face looks; it is aFlags0.y, float 37.
          const top = fill[f * 48 + 37];
          const outV = broad
            ? (top < 0.5 ? nAv.map((v) => -v) : nAv)
            : nAv;
          const pm = mesh.pieces;
          const nMean = [pm[pid * 8], pm[pid * 8 + 1], pm[pid * 8 + 2]];
          const wMean = [pm[pid * 8 + 4], pm[pid * 8 + 5], pm[pid * 8 + 6]];
          const flatV = broad ? nMean : wMean.map((v) => v * sideSign);
          const got = {nA: nAv, nB: nBv, tA: tvA, tB: tvB, outward: outV, flat: flatV};
          for (const key in named) {
            const o = f * 48 + named[key];
            for (let a = 0; a < 3; a++) {
              worst[key] = Math.max(worst[key], Math.abs(got[key][a] - fill[o + a]));
            }
          }
        }
        return worst;
      })(),
      // 🔴 WHERE the disagreement is, not just how big. A near-identity fit
      // with a 3 A residual means most faces agree and some do not, and the
      // worst-case number cannot say which - so this counts them by surface and
      // by how far out they are. A fault concentrated in one surface is a sign
      // error; one spread evenly is the wrong space.
      spread: (() => {
        const rows = Math.min(mesh.faceCount, Math.floor(fill.length / 48));
        const o = first.mean;
        const bySurf = {};
        let over = 0;
        const worstFaces = [];
        for (let f = 0; f < rows; f++) {
          const surf = mesh.faceSurf[f]; const k = mesh.faceStation[f];
          const q = quadOf(surf, k, f);
          let d = 0;
          for (let c = 0; c < 4; c++) {
            for (let a = 0; a < 3; a++) {
              d = Math.max(d, Math.abs(q[c][a] - o[a] - fill[f * 48 + c * 3 + a]));
            }
          }
          const key = 's' + surf;
          if (!bySurf[key]) bySurf[key] = {n: 0, bad: 0, worst: 0};
          bySurf[key].n += 1;
          bySurf[key].worst = Math.max(bySurf[key].worst, d);
          if (d > 1e-3) { bySurf[key].bad += 1; over += 1;
            if (worstFaces.length < 6) worstFaces.push({f, surf, k, d: +d.toFixed(3)}); }
        }
        return {rows, over, bySurf, worstFaces};
      })(),
      bytesFaces: Math.floor(fill.length / 48) * 48 * 4,
      bytesStations: mesh.stationCount * 16 * 4,
    };
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
profile_dir = "/tmp/py2dmol-stationcorners"
chrome, ws = cdp.launch(DEBUG_PORT, profile_dir)
ws.call("Page.enable")
ws.call("Runtime.enable")
ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/_stationcorners.html")
cdp.wait_for(ws, "window.__ready === true", timeout=90, what="the page to load")
out = json.loads(cdp.evaluate(ws, f"window.__go({json.dumps(FILE)}).then(JSON.stringify)"))
chrome.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree(profile_dir, ignore_errors=True)

if out.get("error"):
    sys.exit("page error: " + out["error"] + "  " + json.dumps(
        {k: v for k, v in out.items() if k != "error"}))

bad = []
print(f"{FILE}: {out['prims']} rib pieces, {out['stations']} stations,"
      f" {out['faces']} faces built against {out['fillRows']} instance rows"
      f" ({out['missing']} pieces skipped)")
r = out["real"]
cen = out["centred"]
c = out["control"]
rel = r["worst"] / max(r["scale"], 1e-9)
print(f"  worst {r['worst']:.3e} A over {r['n']} values"
      f"  ({100 * rel:.6f}% of the largest coordinate)")
print(f"  mean offset [{r['mean'][0]:.3e}, {r['mean'][1]:.3e},"
      f" {r['mean'][2]:.3e}] - must be zero, the builder owns it")
print(f"  control, station index +1 (same offset): {c['worst']:.3e} A")
f = out["fit"]
print("  fitted per axis: " + ", ".join(
    f"s={a['scale']:.6f} t={a['offset']:.3f}" for a in f))
print(f"  after the fit: worst {out['fitted']['worst']:.3e} A"
      f" (face {out['fitted']['worstAt']})")
v = out["vectors"]
print("  shading vectors, worst per slot:")
print("    " + "  ".join(f"{k} {v[k]:.2e}" for k in ["nA", "nB", "tA", "tB"]))
print("    " + "  ".join(f"{k} {v[k]:.2e}" for k in ["outward", "flat"]))
for k, w in v.items():
    if w > 1e-4:
        bad.append(f"the {k} vector a station implies differs from the mesh's by"
                   f" {w:.2e} - the corners can be right and the lighting wrong,"
                   " and this is the half a corner check cannot see")
sp = out["spread"]
print(f"  faces over 1e-3 A: {sp['over']} of {sp['rows']}")
for k in sorted(sp["bySurf"]):
    v = sp["bySurf"][k]
    print(f"    {k}: {v['bad']}/{v['n']} bad, worst {v['worst']:.3e}")
# 🔴 AND WHETHER A STICK WAS IN IT AT ALL, said out loud. The side chains are
# shown above so that the stationed stick surfaces - 7 to 10, and the caps -
# reach this comparison; if the table comes back holding only rib rows they
# did not, and every number above is the ribbon's. A gap that is printed is a
# gap somebody can close; one that is implied by an absent line is not.
_stick = sum(v["n"] for k, v in sp["bySurf"].items()
             if k.startswith("s") and k[1:].isdigit() and int(k[1:]) >= 7)
if _stick:
    print(f"  stationed stick faces compared: {_stick}")
else:
    print("  NOTE: no stationed stick face reached this comparison - the table"
          " came back with rib rows only, so the stick vocabulary (surfaces 7-10"
          " and the caps) is still unchecked here")
print(f"    first few: {sp['worstFaces']}")
print(f"  per frame: {out['bytesFaces'] / 1024:.0f} KB of faces"
      f" -> {out['bytesStations'] / 1024:.0f} KB of stations"
      f"  ({out['bytesFaces'] / max(out['bytesStations'], 1):.1f}x)")

if out["faces"] > out["fillRows"]:
    bad.append(f"the station table describes {out['faces']} faces and the mesh"
               f" holds {out['fillRows']} - the two are not in step, so every"
               " comparison below is between different faces")
if out["missing"]:
    bad.append(f"{out['missing']} rib pieces had no frame or no trace and were"
               " skipped; the table is a prefix of the mesh, not the mesh")
if not (rel < 1e-4):
    bad.append(f"the corners a station implies differ from the corners the mesh"
               f" was built from by {r['worst']:.3e} A (worst at face"
               f" {r['worstAt']}) - past what the project/unproject round trip"
               " can account for")
if max(abs(v) for v in r["mean"]) > 1e-3:
    bad.append(f"the table sits {r['mean']} from the mesh on average - a"
               " constant offset, so it is the right geometry about the wrong"
               " origin, and every check that looks at shape would pass")
if c["worst"] <= r["worst"] * 10:
    bad.append("shifting the station index by one changed almost nothing"
               f" ({c['worst']:.3e} A against {r['worst']:.3e}), so this probe"
               " is not sensitive to which station a face reads")

print()
for b in bad:
    print("FAIL: " + b)
print("station corners: " + ("FAILED" if bad else "the table implies the mesh"))
sys.exit(1 if bad else 0)
