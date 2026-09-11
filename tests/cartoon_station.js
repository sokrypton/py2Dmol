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
                [p.Lp[k], p.Lm[k], p.Rp[k], p.Rm[k]],
                // ...and the two scalars the renderer used, when it reports
                // them. See the note at the fit below.
                p.half ? p.half[k] : null);
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
    let worstScalars = 0; let reported = 0;
    eachStation(cap, (mid0, wa0, ub0, tv, C, rep) => {
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
        // (c) 🔴 ...AND AGAINST THE RENDERER'S OWN TWO NUMBERS. Everything
        //     above solves for halfW and halfT out of the projected corners,
        //     because for a long time there was no way to ask for them. There
        //     is now - the frame probe carries them - so the fit can be checked
        //     against the value that produced the corners instead of only
        //     against itself. A fit that agrees with the geometry but not with
        //     the renderer means the two have drifted apart, which is exactly
        //     what a consumer placing corners from a station would then get
        //     wrong.
        if (rep) {
            const scale = Math.max(Math.abs(rep[0]), Math.abs(rep[1]), 1e-9);
            worstScalars = Math.max(worstScalars,
                Math.abs(Math.abs(hw) - Math.abs(rep[0])) / scale,
                Math.abs(Math.abs(ht) - Math.abs(rep[1])) / scale);
            reported++;
        }
        tested++;
    });
    return { worstFit, worstPredict, tested, singular, camErr: cam.err,
        worstScalars, reported };
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
        + `  shear ${frameCheck(cap).shear.toFixed(3)}`
        + `  scalars ${R.reported ? `${(R.worstScalars * 100).toFixed(4)}%` : 'not reported'}`);
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
    // 🔴 AND THE FIT AGREES WITH THE RENDERER'S OWN halfW/halfT. Until the frame
    // probe carried them this could only be checked against itself. A drift
    // here would not show up in `fit` or `predicted` at all - those solve for
    // the scalars and would simply find different ones - and it is exactly what
    // a consumer placing corners from a station would get wrong.
    if (!R.reported) {
        fail(`${name}: the frame probe reported no halfW/halfT, so the fitted`
            + ' scalars were checked against nothing but themselves');
    } else if (!(R.worstScalars < 1e-6)) {
        fail(`${name}: the fitted halfW/halfT differ from the renderer's own by`
            + ` ${(R.worstScalars * 100).toFixed(4)}% - the corners and the`
            + ' numbers that made them have drifted apart');
    }
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
    // 🔴 THE COUNTS AGREEING UNPINNED IS THE PROPERTY NOW, NOT A BROKEN
    // CONTROL. This used to fail when `free` was zero, on the grounds that if
    // the two conformations agreed anyway the pinned result said nothing - and
    // that was right while a letter changed how many stations a residue
    // carried. The ribbon is built one way for every letter now, and the
    // arrowhead pays for its seam out of the interval's own sampling, so the
    // counts hold across a letter WITHOUT pinning anything. That is strictly
    // stronger than what this leg was asserting, so it is asserted instead.
    if (free) {
        fail(`${free} station counts differ between two conformations with the`
            + ' assignment FREE. A letter is supposed to choose a profile and'
            + ' nothing else - see tests/ss_axis.py, which is the gate on that'
            + ' - so this is a trajectory that has to rebuild');
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
    // 🔴 THE SAME CURVE, NOT THE SAME SAMPLES. Comparing station k with station
    // k asks two questions at once - is it the same curve, and is it sampled at
    // the same places - and only the first is the invariant. An arrowhead
    // resamples its interval (the seam is sampled twice, at shaft width and at
    // barb width) so that the step across the barbs is perpendicular, and it
    // does that WITHIN the same number of stations. Station-for-station that
    // reads as 1.6654 A of centre-line movement; as a curve it is nothing.
    //
    // So: the distance from every station to the OTHER arm's polyline. Both
    // ways, because one polyline lying along a piece of the other would pass a
    // one-way test. The bar is not zero - a resampled point sits on the curve
    // and the polyline is its chords, so the sagitta is the floor - and at
    // eight samples a residue that is a thousandth of an Angstrom.
    const segDist = (p, q0, q1) => {
        const vx = q1[0] - q0[0]; const vy = q1[1] - q0[1]; const vz = q1[2] - q0[2];
        const L2 = vx * vx + vy * vy + vz * vz;
        let t = L2 > 1e-12
            ? ((p[0] - q0[0]) * vx + (p[1] - q0[1]) * vy + (p[2] - q0[2]) * vz) / L2
            : 0;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p[0] - (q0[0] + vx * t), p[1] - (q0[1] + vy * t),
            p[2] - (q0[2] + vz * t));
    };
    const toPolyline = (p, poly) => {
        let best = Infinity;
        for (let k = 0; k + 1 < poly.length; k++) {
            best = Math.min(best, segDist(p, poly[k], poly[k + 1]));
        }
        return poly.length === 1 ? Math.hypot(p[0] - poly[0][0],
            p[1] - poly[0][1], p[2] - poly[0][2]) : best;
    };
    // 🔴 AND AN INTERVAL WHOSE LETTERS MOVED IS NOT HELD TO THE SAME BAR, for
    // one reason: an arrowhead RESAMPLES its interval. The seam is sampled
    // twice - once at shaft width, once at barb width - so that the step across
    // the barbs is perpendicular rather than slanting, and the second sample is
    // paid for out of the interval's own budget rather than added to it, which
    // is what keeps the station count fixed and the frame off the rebuild path.
    // The points still lie on the same curve; they lie at different places
    // along it, and one chord of the barb replaces two.
    //
    // So: everywhere the letters agree, the curves must match to nothing. Where
    // they do not, the interval is one that gained or lost a head, its profile
    // has changed by design, and the bar is a chord error rather than zero.
    let worstCentre = 0; let profile = 0; let worstSample = 0; let worstArrow = 0;
    let armed = 0;
    for (let i = 0; i < B.n; i++) {
        const a = B.trace[i]; const b = Bpin.trace[i];
        if (!a || !b || !a.length || !b.length) continue;
        // ...against A.sec, which is what Bpin was pinned TO. `capture().sec`
        // reports the assignment the renderer worked out, and _forceSec does
        // not change that report - so Bpin.sec reads like B.sec and comparing
        // the two arms' own reports finds nothing, which is how this exemption
        // first measured zero intervals while thirty had moved.
        // ...over FOUR residues, i-1 to i+2, because that is the window an
        // interval's own sampling depends on. Forward: isArrowInterval(j) reads
        // sec[j], sec[j+1] AND sec[j+2] - the head sits on the LAST interval of
        // a strand, and whether this interval is the last one is a question
        // about the residue after the next. Backward: the blunt end sits on the
        // FIRST interval of a strand, which is a question about the residue
        // before it, and that interval duplicates its station at u = 0 to make
        // the rim square.
        //
        // Both were found by widening: a two-residue window left 0.2043 A of
        // "unexplained" curve movement that was an arrow appearing two residues
        // along, and a three-residue one left 0.0683 A that was a strand
        // starting one residue back.
        let moved = false;
        for (let w = -1; w <= 2; w++) {
            const j = i + w;
            if (j >= 0 && j < B.sec.length && B.sec[j] !== A.sec[j]) moved = true;
        }
        let worst = 0;
        for (const p of b) worst = Math.max(worst, toPolyline(p, a));
        for (const p of a) worst = Math.max(worst, toPolyline(p, b));
        if (moved) { worstArrow = Math.max(worstArrow, worst); armed++; }
        else worstCentre = Math.max(worstCentre, worst);
        if (a.length === b.length && !moved) {
            for (let k = 0; k < a.length; k++) {
                worstSample = Math.max(worstSample, Math.hypot(a[k][0] - b[k][0],
                    a[k][1] - b[k][1], a[k][2] - b[k][2]));
            }
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
    console.log(`pinning the assignment moved the centre CURVE by`
        + ` ${worstCentre.toFixed(4)} A where the letters agree (station for`
        + ` station ${worstSample.toFixed(4)} A), by ${worstArrow.toFixed(4)} A`
        + ` in the ${armed} intervals where they do not, and the width by`
        + ` ${profile.toFixed(3)} A`);
    if (!(worstCentre < 1e-6)) {
        fail(`pinning the secondary structure moved the ribbon CENTRE by`
            + ` ${worstCentre.toFixed(4)} A in an interval whose letters did not`
            + ' change. A helix and a loop are supposed to differ only in'
            + ' profile; if the centre line moves too, an SS change cannot be'
            + ' morphed and has to be rebuilt');
    }
    if (!(worstSample < 1e-6)) {
        fail(`the stations themselves moved by ${worstSample.toFixed(4)} A`
            + ' where the letters agree - same curve, different samples, which'
            + ' is the arrowhead resampling an interval it should not be in');
    }
    if (!(worstArrow < 0.3)) {
        fail(`an interval whose letters changed moved its centre curve by`
            + ` ${worstArrow.toFixed(4)} A. Redistributing an arrow interval's`
            + ' own stations should cost a chord, not a shape');
    }
    if (!armed) {
        fail('no interval changed its letters, so the exemption above was'
            + ' never exercised and the bar it carries is untested');
    }
    if (!(profile > 0.1)) {
        fail('pinning the secondary structure changed no width at all, so this'
            + ' leg compared a picture with itself');
    }
}

if (bad) process.exit(1);
console.log('\ncartoon station: a station is a frame and two scalars');
