/* WHAT A RIBBON STATION IS, pinned as an invariant.
 *
 *     node tests/cartoon_station.js
 *
 * A cartoon station is the four corners of one slice of ribbon. This asks
 * whether those four corners carry any information BEYOND a model-space frame
 * and two scalars - and they do not:
 *
 *     Lp = mid + wa*halfW + ub*halfT
 *     Lm = mid + wa*halfW - ub*halfT
 *     Rp = mid - wa*halfW + ub*halfT
 *     Rm = mid - wa*halfW - ub*halfT
 *
 * That matters because everything expensive about building a mesh - the faces
 * and the edge table - is then TOPOLOGY, and topology does not change when a
 * trajectory moves. A frame would become a small per-station upload instead of
 * a rebuild, and the geometry could be placed by a vertex shader. This file is
 * what says the parameterisation is still exact; without it, a change to the
 * sweep could quietly make the corners something a frame cannot describe, and
 * nothing else in the suite would notice.
 *
 * Everything it needs already ships: `_traceProbe` gives the model-space centre
 * (it is what the selection halo follows) and `_frameProbe` gives ub/wa/tv (it
 * is what the GPU capture already reads).
 *
 * 🔴 THE TEST IS NOT "SOLVE FOR THE CORNERS". Two unknowns fitted against two
 * equations reproduce anything, and in 2D any two independent vectors span the
 * plane - so a planar version of this check passes against ANY offset and says
 * nothing. halfW and halfT are fitted in THREE dimensions from ONE corner, and
 * the other three corners are then PREDICTED: six numbers tested against two
 * fitted. The controls below are what prove that is not vacuous.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lift.js');

const ROOT = path.dirname(__dirname);
const viewportScale = new Function('return function ' + L.method('_viewportScale'))();
const framingHalfSpan = new Function('return function ' + L.method('_viewHalfSpan'))();
global.halfSpanOf = new Function('return ' + L.topFunction('halfSpanOf'))();

let _t = 0;
global.performance = { now: () => (_t += 1) };
global.window = { addEventListener() {}, dispatchEvent() {}, devicePixelRatio: 1 };
global.document = { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) };
global.Event = function Event() {};
eval(L.utils);
for (const rel of ['src/cartoon/geom.js', 'src/cartoon/paint2d.js']) {
    eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
const cartoon = global.window.py2dmolCartoon;
if (!cartoon || !cartoon.render) throw new Error('the cartoon plugin did not load');

function nullCtx(w, h) {
    const noop = () => {};
    return new Proxy({}, { get: (t, k) => {
        if (k === 'canvas') return { width: w, height: h };
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'createLinearGradient' || k === 'createRadialGradient') {
            return () => ({ addColorStop: noop });
        }
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return noop;
    }, set: () => true });
}

function alphaCarbons(file, chain) {
    const parsed = parseCIF(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    return parsed.models[0].filter((a) => a.atomName === 'CA' && a.record === 'ATOM'
        && (!chain || a.chain === chain));
}

// THE THREE HOOKS THE GPU CAPTURE SETS, and one more. `_probeOnly` stops the
// paint, `_primProbe` receives the primitive list, `_frameProbe` makes each
// station carry its MODEL-SPACE frame, and `_traceProbe` receives the centre
// line. All four ship; none is for this test alone.
function capture(cas, opts) {
    const n = cas.length;
    const co = cas.map((a) => ({ x: a.x, y: a.y, z: a.z }));
    const segs = [];
    for (let i = 0; i + 1 < n; i++) {
        if (cas[i].chain === cas[i + 1].chain) {
            segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        }
    }
    const r = {
        // ...AS OBJECTS, BOTH OF THEM - see the note in paint_trace.js. The
        // secondary structure is assigned from `coords`, so arrays there make
        // every fixture come back all coil.
        coords: co,
        rotatedCoords: co.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        segmentIndices: segs,
        positionTypes: new Array(n).fill('P'),
        positionNames: cas.map((a) => a.resName),
        residueNumbers: cas.map((a) => a.resSeq),
        chains: cas.map((a) => a.chain),
        _viewportScale: viewportScale,
        _viewHalfSpan: framingHalfSpan,
        viewerState: { extent: 30, zoom: 1, ortho: 1, focalLength: 100,
            rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
        objectsData: { obj: { maxExtent: 30 } },
        currentObjectName: 'obj', currentFrame: 0, lineWidth: 3.0,
        visibilityMask: null, visiblePositions: null,
        outlineMode: 'on', relativeOutlineWidth: 3,
        shadowEnabled: true, cartoonShade: 1, colorMode: 'chain',
        screenFrameId: 0,
        screenX: new Float64Array(n), screenY: new Float64Array(n),
        screenRadius: new Float64Array(n), screenValid: new Uint8Array(n),
        _calculateSegmentWidthMultiplier: () => 1,
        _probeOnly: true, _primProbe: null, _frameProbe: true, _traceProbe: null,
        _noViewCull: true, cartoonPencil: 0,
    };
    Object.assign(r, opts || {});
    cartoon.render(r, nullCtx(600, 600), 600, 600,
        new Array(Math.max(n, segs.length)).fill({ r: 100, g: 140, b: 220 }));
    const prims = (r._primProbe || []).filter((p) => p && p.kind === 'rib'
        && p.Lp && p.ub && p.wa);
    // stations per interval, which is what follows secondary structure
    const nsub = new Map();
    for (const p of prims) {
        nsub.set(Math.floor(p.gs0 + 1e-9), Math.round(1 / p.gsStep));
    }
    return {
        prims, nsub, n,
        trace: r._traceProbe || [],
        sec: Array.isArray(r._cartoonSec) ? r._cartoonSec.join('')
            : String(r._cartoonSec || ''),
    };
}

// Each station walked once, with its model-space centre and frame beside its
// four projected corners.
function eachStation(cap, fn) {
    for (const p of cap.prims) {
        const nsub = Math.round(1 / p.gsStep);
        const i = Math.floor(p.gs0 + 1e-9);
        const a0 = Math.round((p.gs0 - i) * nsub);
        const cs = cap.trace[i];
        if (!cs) continue;
        for (let k = 0; k < p.Lp.length; k++) {
            const mid = cs[a0 + k];
            if (!mid || !p.wa[k] || !p.ub[k]) continue;
            fn(mid, p.wa[k], p.ub[k], p.tv ? p.tv[k] : null,
                [p.Lp[k], p.Lm[k], p.Rp[k], p.Rm[k]]);
        }
    }
}

/* THE CAMERA, RECOVERED FROM THE GEOMETRY ITSELF.
 *
 * The corners are projected and the frame is model space, so the two have to be
 * brought into one space before they can be compared. The camera here is
 * orthographic with an identity rotation, so each axis maps independently and
 * affinely, and the map is fitted from (model centre -> mean of the four
 * corners). That is legitimate rather than circular: it fixes the CAMERA, and
 * the claim under test is about the FRAME. The fit residual is asserted, so a
 * camera that is not this shape fails here rather than mysteriously below.
 */
function cameraOf(cap) {
    const pairs = [];
    eachStation(cap, (mid, wa, ub, tv, C) => {
        pairs.push([mid, [0, 1, 2].map((d) => (C[0][d] + C[1][d] + C[2][d] + C[3][d]) / 4)]);
    });
    const A = [0, 0, 0]; const B = [0, 0, 0];
    let err = 0;
    for (let d = 0; d < 3; d++) {
        let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
        const N = pairs.length;
        for (const [m, a] of pairs) {
            sx += m[d]; sy += a[d]; sxx += m[d] * m[d]; sxy += m[d] * a[d];
        }
        const den = N * sxx - sx * sx;
        A[d] = Math.abs(den) < 1e-12 ? 0 : (N * sxy - sx * sy) / den;
        B[d] = (sy - A[d] * sx) / N;
        for (const [m, a] of pairs) err = Math.max(err, Math.abs(A[d] * m[d] + B[d] - a[d]));
    }
    return { n: pairs.length, err,
        point: (p) => [A[0] * p[0] + B[0], A[1] * p[1] + B[1], A[2] * p[2] + B[2]],
        dir: (v) => [A[0] * v[0], A[1] * v[1], A[2] * v[2]] };
}

// `bend` is the control lever: it hands the reconstruction a frame or a centre
// that is deliberately wrong, and the error must explode.
function reconstruct(cap, bend) {
    const cam = cameraOf(cap);
    let worstFit = 0; let worstPredict = 0; let tested = 0; let singular = 0;
    eachStation(cap, (mid0, wa0, ub0, tv, C) => {
        let wa = wa0; let ub = ub0; let mid = mid0;
        if (bend === 'tangent' && tv) ub = tv;
        if (bend === 'swap') { const q = wa; wa = ub; ub = q; }
        if (bend === 'centre') mid = [mid[0] + 0.5, mid[1], mid[2]];
        const m = cam.point(mid); const W = cam.dir(wa); const U = cam.dir(ub);
        const d = [C[0][0] - m[0], C[0][1] - m[1], C[0][2] - m[2]];
        const ww = W[0] * W[0] + W[1] * W[1] + W[2] * W[2];
        const uu = U[0] * U[0] + U[1] * U[1] + U[2] * U[2];
        const wu = W[0] * U[0] + W[1] * U[1] + W[2] * U[2];
        const det = ww * uu - wu * wu;
        // EDGE-ON STATIONS ARE NOT EVIDENCE EITHER WAY: when the two axes fall
        // on one line the solve is singular and any pair of scalars fits.
        if (!(Math.abs(det) > 1e-12 * ww * uu)) { singular++; return; }
        const wd = W[0] * d[0] + W[1] * d[1] + W[2] * d[2];
        const ud = U[0] * d[0] + U[1] * d[1] + U[2] * d[2];
        const hw = (wd * uu - ud * wu) / det;
        const ht = (ww * ud - wu * wd) / det;
        const sz = Math.max(Math.hypot(d[0], d[1], d[2]), 1e-9);
        const at = (a, b) => [m[0] + W[0] * a + U[0] * b, m[1] + W[1] * a + U[1] * b,
            m[2] + W[2] * a + U[2] * b];
        const off = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / sz;
        // (a) three equations, two unknowns - an offset outside the frame's
        //     span cannot come back, and this is where that shows
        worstFit = Math.max(worstFit, off(at(hw, ht), C[0]));
        // (b) ...and the other three corners, from those same two numbers
        worstPredict = Math.max(worstPredict, off(at(hw, -ht), C[1]),
            off(at(-hw, ht), C[2]), off(at(-hw, -ht), C[3]));
        tested++;
    });
    return { worstFit, worstPredict, tested, singular, camErr: cam.err };
}

let bad = 0;
const fail = (m) => { console.log('FAIL: ' + m); bad++; };

/* ---- 0. the frame is orthonormal ----------------------------------------
 *
 * Checked on its own, with no camera in the way, because the reconstruction
 * below CANNOT see this: scaling `ub` by 1.1 just rescales the halfT fitted
 * against it, and every corner still comes back exactly. A frame that is not
 * orthonormal is still a basis; it is only useless to a shader, which composes
 * it as a rotation.
 *
 * 🔴 AND THIS IS ALSO WHERE THE RECONSTRUCTION'S BLIND SPOT LIVES. The camera
 * below is fitted from (centre -> mean of corners), so shifting EVERY centre
 * by the same vector is absorbed into the fit's offset and cannot be detected -
 * correctly, because a uniform translation of every centre IS a camera
 * translation, and nothing in this data distinguishes them. A shift of SOME
 * centres, or of one axis of the frame, is caught; the `centre` control below
 * perturbs after the fit, which is why it fires.
 */
function frameCheck(cap) {
    let worstLen = 0; let worstDot = 0; let shear = 0; let n = 0;
    eachStation(cap, (mid, wa, ub, tv) => {
        const len = (v) => Math.hypot(v[0], v[1], v[2]);
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        worstLen = Math.max(worstLen, Math.abs(len(wa) - 1), Math.abs(len(ub) - 1));
        // THE PAIR THE CORNERS ARE BUILT FROM, and the only orthogonality the
        // reconstruction needs.
        worstDot = Math.max(worstDot, Math.abs(dot(wa, ub)));
        if (tv) {
            worstLen = Math.max(worstLen, Math.abs(len(tv) - 1));
            worstDot = Math.max(worstDot, Math.abs(dot(ub, tv)));
            // 🔴 ...AND wa.tv IS NOT ZERO, DELIBERATELY. The first version of
            // this asserted a full orthonormal triad and failed on unmodified
            // code at 0.864 - which is not a bug: the cross-section is NOT
            // perpendicular to the curve, so the ribbon shears along its
            // length, and `wa` is only required to lie in the plane across
            // from `ub`. Measured rather than assumed, and recorded here so
            // the next reader does not "fix" it back.
            shear = Math.max(shear, Math.abs(dot(wa, tv)));
        }
        n++;
    });
    return { worstLen, worstDot, shear, n };
}

/* ---- 1. the parameterisation, on real structures ------------------------- */
const CASES = [
    ['1UBQ', alphaCarbons('1UBQ.cif', 'A'), {}],
    ['1UBQ-rich', alphaCarbons('1UBQ.cif', 'A'),
        { cartoonRichardson: true, cartoonThickness: 1.2 }],
    ['1UBQ-flat', alphaCarbons('1UBQ.cif', 'A'),
        { cartoonRichardson: false, cartoonThickness: 0 }],
    ['1TIM', alphaCarbons('1TIM.cif', null), {}],
];
for (const [name, cas, opts] of CASES) {
    const cap = capture(cas, opts);
    // ...AND THE STRUCTURE MUST CONTAIN WHAT THIS IS ABOUT. A structure
    // assigned all coil would exercise one profile and pass everything below.
    const hasH = cap.sec.includes('H');
    const hasE = cap.sec.includes('E');
    const R = reconstruct(cap, null);
    console.log(`${name.padEnd(11)} ${String(R.tested).padStart(5)} stations`
        + `  helix=${hasH} sheet=${hasE}`
        + `  camera fit ${R.camErr.toExponential(1)}`
        + `  fit ${(R.worstFit * 100).toFixed(4)}%`
        + `  predicted ${(R.worstPredict * 100).toFixed(4)}%`
        + `  shear ${frameCheck(cap).shear.toFixed(3)}`);
    if (!hasH || !hasE) {
        fail(`${name} is assigned no ${hasH ? 'sheet' : 'helix'} - it exercises`
            + ' one profile and proves nothing about the others');
    }
    if (R.tested < 100) fail(`${name}: only ${R.tested} stations tested`);
    const F = frameCheck(cap);
    if (!(F.worstLen < 1e-9) || !(F.worstDot < 1e-9)) {
        fail(`${name}: the width/thickness pair is not orthonormal`
            + ` (length off by ${F.worstLen.toExponential(2)},`
            + ` wa.ub or ub.tv off square by ${F.worstDot.toExponential(2)})`
            + ' - the corners are built from that pair');
    }
    if (R.singular) fail(`${name}: ${R.singular} singular stations`);
    if (!(R.camErr < 1e-6)) {
        fail(`${name}: the camera is not the affine map this assumes`
            + ` (residual ${R.camErr}) - the comparison below is in the wrong space`);
    }
    if (!(R.worstFit < 1e-6)) {
        fail(`${name}: a corner is not in the span of the station's own frame`
            + ` (${(R.worstFit * 100).toFixed(3)}%) - a station carries more than`
            + ' a frame and two scalars, and cannot be placed by one');
    }
    if (!(R.worstPredict < 1e-6)) {
        fail(`${name}: three corners predicted from halfW/halfT fitted to the`
            + ` fourth are wrong by ${(R.worstPredict * 100).toFixed(3)}%`);
    }
}

/* ---- 2. the controls, or none of the above means anything ---------------- */
// Measured when this was written: tangent 756%, swap 1456%, centre 7566%.
// `swap` is the one that justifies predicting the other three corners rather
// than fitting them - it reproduces Lp exactly and is wildly wrong about the
// rest, so a check that only fitted would pass it.
{
    const cap = capture(alphaCarbons('1TIM.cif', null), {});
    for (const [bend, what] of [['tangent', 'the thickness axis replaced by the tangent'],
        ['swap', 'the width and thickness axes swapped'],
        ['centre', 'the centre moved half an Angstrom']]) {
        const R = reconstruct(cap, bend);
        const worst = Math.max(R.worstFit, R.worstPredict);
        console.log(`control ${bend.padEnd(8)} ${(worst * 100).toFixed(1)}% error`
            + `   (${what})`);
        if (!(worst > 0.1)) {
            fail(`the control '${bend}' produced only ${(worst * 100).toFixed(3)}%`
                + ' error - the reconstruction above fits anything, so it is'
                + ' not evidence of anything');
        }
    }
}

/* ---- 3. secondary structure moves the PROFILE, not the centre line ------- */
// The station count follows secondary structure, so a trajectory whose SS
// flickers is a trajectory whose topology changes - which is what a reused mesh
// cannot survive. `_forceSec` pins the assignment, and with it pinned the
// counts hold still. The unpinned run beside it is the control: if the two
// conformations agree anyway, the pinned result says nothing.
{
    const cas = alphaCarbons('1UBQ.cif', 'A');
    // a second conformation - enough to move the assignment, which is asserted
    // below rather than assumed
    const moved = cas.map((a, i) => ({ ...a,
        x: a.x + 0.8 * Math.sin(i * 0.7), y: a.y + 0.8 * Math.cos(i * 0.5),
        z: a.z + 0.6 * Math.sin(i * 0.3) }));
    const A = capture(cas, {});
    const B = capture(moved, {});
    const Bpin = capture(moved, { _forceSec: A.sec });
    let ssMoved = 0;
    for (let i = 0; i < A.sec.length; i++) if (A.sec[i] !== B.sec[i]) ssMoved++;
    const countDiff = (X) => {
        let d = 0;
        for (const [i, v] of A.nsub) if (X.nsub.has(i) && X.nsub.get(i) !== v) d++;
        return d;
    };
    const free = countDiff(B);
    const pinned = countDiff(Bpin);
    console.log(`\nsecond conformation: ${ssMoved} residues change SS,`
        + ` station counts differ ${free} unpinned / ${pinned} pinned`);
    if (!ssMoved) {
        fail('the second conformation has the same secondary structure, so the'
            + ' pinning result below is vacuous - perturb it further');
    }
    if (!free) {
        fail('the station counts agree even unpinned, so pinning them proves'
            + ' nothing');
    }
    if (pinned) {
        fail(`${pinned} station counts still differ with the assignment pinned -`
            + ' the topology cannot be held fixed across a trajectory, and a'
            + ' reused mesh cannot survive a frame change');
    }
    // ...AND THE CENTRE LINE DOES NOT MOVE WITH IT. Measured across two real
    // ensembles (2LJ5, 40 models; 5W3N, 20 models): where SS changed, the
    // ribbon centre moved 0.0000 A and the PROFILE moved up to 5.8 A. A helix
    // and a loop are one curve at two widths, which is what lets an SS change
    // be a morph instead of a rebuild.
    let worstCentre = 0; let profile = 0;
    for (let i = 0; i < B.n; i++) {
        const a = B.trace[i]; const b = Bpin.trace[i];
        if (!a || !b) continue;
        const m = Math.min(a.length, b.length);
        for (let k = 0; k < m; k++) {
            // the ends of an interval are the same two points however densely
            // it is sampled, so they are comparable even when the counts differ
            const ia = a.length === b.length ? k : (k === 0 ? 0 : a.length - 1);
            const ib = a.length === b.length ? k : (k === 0 ? 0 : b.length - 1);
            worstCentre = Math.max(worstCentre, Math.hypot(a[ia][0] - b[ib][0],
                a[ia][1] - b[ib][1], a[ia][2] - b[ib][2]));
            if (a.length !== b.length && k > 0) break;
        }
    }
    const halves = (cap) => {
        const out = new Map();
        eachStation(cap, (mid, wa, ub, tv, C) => {
            const hw = Math.hypot(C[0][0] - C[2][0], C[0][1] - C[2][1], C[0][2] - C[2][2]);
            out.set(mid.join(','), hw);
        });
        return out;
    };
    const hb = halves(B); const hp = halves(Bpin);
    for (const [k, v] of hb) if (hp.has(k)) profile = Math.max(profile, Math.abs(v - hp.get(k)));
    console.log(`pinning the assignment moved the centre line by`
        + ` ${worstCentre.toFixed(4)} A and the width by ${profile.toFixed(3)} A`);
    if (!(worstCentre < 1e-6)) {
        fail(`pinning the secondary structure moved the ribbon CENTRE by`
            + ` ${worstCentre.toFixed(4)} A. A helix and a loop are supposed to`
            + ' differ only in profile; if the centre line moves too, an SS'
            + ' change cannot be morphed and has to be rebuilt');
    }
    if (!(profile > 0.1)) {
        fail('pinning the secondary structure changed no width at all, so this'
            + ' leg compared a picture with itself');
    }
}

if (bad) process.exit(1);
console.log('\ncartoon station: a station is a frame and two scalars');
