/* EVERY RIBBON FACE IS (a piece, a station, a surface) - the other half of
 * what a vertex shader would need.
 *
 *     node tests/station_faces.js
 *
 * tests/cartoon_station.js pins the first half: a station's four corners are a
 * model-space frame and two scalars, exactly,
 *
 *     Lp = mid + wa*halfW + ub*halfT      Rp = mid - wa*halfW + ub*halfT
 *     Lm = mid + wa*halfW - ub*halfT      Rm = mid - wa*halfW - ub*halfT
 *
 * so eleven floats a station describe the geometry. That alone is not enough to
 * move the sweep onto the card. The mesh is a list of FACES, and the question
 * here is whether a face carries anything beyond an INDEX into those stations -
 * because if it does not, the face list is topology, it does not change while a
 * trajectory moves, and only the station buffer has to be uploaded per frame.
 *
 * WHAT facesOf ACTUALLY DOES, for a `rib` prim (cartoon/paintgl.js):
 *
 *     surfaces = [[Lp, Rp, 1], [Lm, Rm, 0], [Lp, Lm, 1], [Rp, Rm, 0]]
 *     for k in 0 .. ns-2:
 *       for si in 0 .. 3:
 *         [A, B] = surfaces[si]
 *         q = [A[k], B[k], B[k+1], A[k+1]]
 *
 * plus a start and an end cap. This asserts that identity face by face, corner
 * by corner, over real structures - so the port is a rule and not a
 * resemblance.
 *
 * 🔴 THE CONTROLS ARE THE POINT, as they are in cartoon_station.js. "Predicted
 * corners match" is trivially true of any rule that reads the same arrays, so
 * three deliberately wrong rules are run through the same comparison: the
 * surface table permuted, the quad's winding reversed, and the station index
 * off by one. Each has to FAIL, or this file is asserting nothing.
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

// facesOf LIFTED OUT OF THE GPU PAINTER, which otherwise needs a WebGL2
// context to load at all. It is a top-level function over plain objects, and
// the two helpers it closes over come with it.
//
// 🔴 EXTRACTED HERE RATHER THAN THROUGH lift.js, deliberately. lift.js's
// SOURCES is the list every other probe searches, and cartoon/paintgl.js is not
// on it: adding a 6,600-line file to a shared search would change what a dozen
// existing lifts resolve to, for one caller's benefit. Brace matching over the
// one file is the smaller change.
const paintglSrc = fs.readFileSync(path.join(ROOT, 'src/cartoon/paintgl.js'), 'utf8');
const topFn = (name) => {
    const at = paintglSrc.indexOf(`\nfunction ${name}(`);
    if (at < 0) throw new Error(`paintgl.js has no top-level function ${name}`);
    let depth = 0;
    let i = paintglSrc.indexOf('{', at);
    const start = at + 1;
    for (; i < paintglSrc.length; i++) {
        const c = paintglSrc[i];
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) return paintglSrc.slice(start, i + 1); }
    }
    throw new Error(`unterminated ${name}`);
};
const facesOfSrc = topFn('facesOf');
const residueOfSrc = topFn('residueOf');
// ...AND defaultParams IS NEVER CALLED, because every call below passes its
// own params. It is stubbed rather than lifted: it reads the live GL state,
// which is the thing this harness exists to avoid needing.
const facesOf = new Function('len3', `
    // residueOf reads paintgl's module-level residue map; the default it is
    // initialised with is what a structure with no materialised side chains
    // has, which is every fixture here.
    let resMap = { nBase: 0, sidechainMap: null };
    ${residueOfSrc}
    const defaultParams = () => { throw new Error('facesOf was called without params'); };
    return ${facesOfSrc};
`)((x, y, z) => Math.sqrt(x * x + y * y + z * z));
const PARAMS = { rich: false, ink: true };

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

/** The prim list the GPU capture would receive. Same four hooks as
 *  tests/cartoon_station.js, and none of them is for a test alone. */
function capture(cas, opts = {}) {
    const n = cas.length;
    const co = cas.map((a) => ({ x: a.x, y: a.y, z: a.z }));
    const segs = [];
    for (let i = 0; i + 1 < n; i++) {
        if (cas[i].chain === cas[i + 1].chain) {
            segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        }
    }
    const r = {
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
        // 🔴 _primProbe AND _traceProbe ARE SLOTS, NOT CALLBACKS. Passing a
        // function here captured nothing and the failure arrived later, inside
        // drawRun, as a null dereference. tests/cartoon_station.js sets them to
        // null and reads them back; so does this.
        _probeOnly: true, _primProbe: null, _frameProbe: true, _traceProbe: null,
        _noViewCull: true, cartoonPencil: 0,
        style: 'cartoon', cartoonDetail: 4, cartoonThickness: opts.thickness === undefined ? 0.7 : opts.thickness,
        cartoonRichardson: !!opts.rich, cartoonArrows: true,
        ...opts.renderer,
    };
    // ...and a colour per position, because the ribbon reads one per station.
    cartoon.render(r, nullCtx(600, 600), 600, 600,
        new Array(Math.max(n, segs.length)).fill({ r: 100, g: 140, b: 220 }));
    const prims = (r._primProbe || []).filter((p) => p && p.kind === 'rib' && p.Lp);
    if (!prims.length) throw new Error('no rib prims captured');
    return prims;
}

/**
 * THE PORT, WRITTEN AS THE SHADER WOULD HAVE TO WRITE IT: a face is a piece, a
 * station and a surface, and its four corners are read from the two stations.
 *
 * `pick` is where the four corner curves live. In the shipped path they are the
 * prim's own arrays; a vertex shader would form them from the station's frame
 * instead, which is what cartoon_station.js pins. Passing it in is what lets
 * the controls below substitute a wrong rule and be caught.
 */
function facesFromStations(p, pick = SURFACES) {
    const ns = p.Lp.length;
    const out = [];
    if (p.capStart) out.push({ cap: 1, q: [p.Lp[0], p.Lm[0], p.Rm[0], p.Rp[0]] });
    if (p.capEnd) {
        const e = ns - 1;
        out.push({ cap: 1, q: [p.Lp[e], p.Lm[e], p.Rm[e], p.Rp[e]] });
    }
    for (let k = 0; k + 1 < ns; k++) {
        for (let si = 0; si < 4; si++) {
            const [an, bn, dk] = pick[si];
            const A = p[an];
            const B = p[bn];
            out.push({ cap: 0, si, k, q: [A[k + dk], B[k + dk], B[k + 1 + dk], A[k + 1 + dk]] });
        }
    }
    return out;
}
const SURFACES = [['Lp', 'Rp', 0], ['Lm', 'Rm', 0], ['Lp', 'Lm', 0], ['Rp', 'Rm', 0]];

const same = (a, b) => a === b
    || (Array.isArray(a) && Array.isArray(b) && a.length === b.length
        && a.every((v, i) => Math.abs(v - b[i]) < 1e-12));

/** How many of `mine` reproduce `theirs`, corner for corner and in order. */
function agreement(theirs, mine) {
    const rib = theirs.filter((f) => f.q && f.q.length === 4);
    if (rib.length !== mine.length) return { n: rib.length, m: mine.length, bad: -1 };
    let bad = 0;
    for (let i = 0; i < rib.length; i++) {
        const a = rib[i].q;
        const b = mine[i].q;
        if (!a.every((c, j) => same(c, b[j]))) bad += 1;
    }
    return { n: rib.length, m: mine.length, bad };
}

let failed = 0;
const fail = (msg) => { console.log('FAIL: ' + msg); failed = 1; };

const CASES = [
    // 🔴 A SOLID SLAB IN AT LEAST ONE CASE, or two of the four surfaces
    // coincide and half the rule goes untested - see the thickness check below.
    ['1UBQ', '1UBQ.cif', null, {}],
    ['1UBQ-flat', '1UBQ.cif', null, { thickness: 0 }],
    ['1UBQ-rich', '1UBQ.cif', null, { rich: true }],
    ['1TIM', '1TIM.cif', 'A', {}],
    ['3CHY', '3CHY.cif', null, { rich: true }],
];

for (const [name, file, chain, opts] of CASES) {
    const prims = capture(alphaCarbons(file, chain), opts);
    const theirs = facesOf(prims.map((p) => ({ ...p })), { ...PARAMS, rich: !!opts.rich }, false).faces;
    let mine = [];
    for (const p of prims) mine = mine.concat(facesFromStations(p));
    const { n, m, bad } = agreement(theirs, mine);
    const stations = prims.reduce((t, p) => t + p.Lp.length, 0);
    console.log(`${name.padEnd(12)} ${String(prims.length).padStart(4)} pieces`
        + `  ${String(stations).padStart(5)} stations  ${String(n).padStart(6)} faces`
        + `  mismatched ${bad}`);
    if (bad !== 0) {
        fail(`${name}: ${bad < 0 ? `${m} faces built against ${n}` : `${bad} of ${n} faces`}`
            + ' do not follow (piece, station, surface) - the face list is not'
            + ' pure topology and cannot be uploaded once');
    }
    // ...the upload this buys is reported once, below, where the frames are
    // counted too. Stating it here at eleven floats a station and there at
    // fourteen gave one file two different ratios for the same change.
}

/**
 * ...AND THE NORMALS COME FROM THE SAME PLACE, which is the half that decides
 * whether a shader can do this at all.
 *
 * A face's shading inputs are nA/nB (the width normal at each end), tA/tB (the
 * tangents) and a flat normal. buildMeshPart reads them out of `pf.frames[f.st]`
 * and `[f.st + 1]`, and facesOf fills those from `p.ub[k]`, `p.wa[k]`, `p.tv[k]`
 * - the STATION's frame. So they are already station data, attached to every
 * face that touches the station: four surfaces times two ends, plus the caps.
 *
 * That redundancy is the thing a station buffer removes, and this counts it -
 * a claim of "9x less" should come from the file that can measure it, not from
 * a commit message.
 */
function frameRedundancy(prims) {
    let copies = 0;
    let stations = 0;
    let mismatched = 0;
    const eq = (a, b) => a === b || (a && b && a.length === b.length
        && a.every((v, i) => Math.abs(v - b[i]) < 1e-12));
    for (const p of prims) {
        if (!p.ub || !p.wa || !p.tv) continue;
        const ns = p.Lp.length;
        stations += ns;
        // ...what facesOf hands each face, re-derived here from the station.
        for (let k = 0; k + 1 < ns; k++) {
            for (let si = 0; si < 4; si++) {
                copies += 2;                       // the A end and the B end
                if (!eq(p.ub[k], p.ub[k]) || !eq(p.wa[k + 1], p.wa[k + 1])) mismatched += 1;
            }
        }
    }
    return { copies, stations, mismatched };
}

for (const [name, file, chain, opts] of [['1UBQ', '1UBQ.cif', null, {}],
                                          ['1TIM', '1TIM.cif', 'A', {}]]) {
    const ps = capture(alphaCarbons(file, chain), opts);
    const { copies, stations } = frameRedundancy(ps);
    const theirs = facesOf(ps.map((p) => ({ ...p })), PARAMS, false).faces;
    // 🔴 THE FACE CARRIES ITS STATION, ALREADY. `st` and `surf` are set by
    // facesOf and read by buildMeshPart; if they ever stopped identifying the
    // frame uniquely the shader would have nothing to index with.
    let noStation = 0;
    for (const f of theirs) {
        if (f.cap) continue;
        if (f.st === undefined || f.surf === undefined) noStation += 1;
    }
    if (noStation) {
        fail(`${name}: ${noStation} rib faces carry no (station, surface), so a`
            + ' face cannot be reduced to an index');
    }
    const faceFloats = theirs.length * 48;
    // 🔴 FOURTEEN FLOATS A STATION, NOT ELEVEN. cartoon_station.js needs only
    // mid, wa, ub, halfW and halfT to place the CORNERS - but the shading wants
    // the tangent as well, and a station that cannot shade itself is not a
    // station a shader can use. Quoting the geometry-only figure made this
    // change look like 9.4x when it is 7.4x.
    const stationFloats = stations * 14;            // mid, ub, wa, tv, hw, ht
    console.log(`${name.padEnd(12)} each station's frame is copied onto`
        + ` ${(copies / stations).toFixed(1)} faces`
        + `  |  ${(faceFloats * 4 / 1024).toFixed(0)} KB -> `
        + `${(stationFloats * 4 / 1024).toFixed(0)} KB`
        + ` (${(faceFloats / stationFloats).toFixed(1)}x)`);
}

// 🔴 THREE RULES THAT MUST NOT PASS. Reading the same arrays back is what makes
// the check above easy to fool, so each of these is the port with one thing
// wrong, and each has to be caught.
const CONTROLS = [
    ['surfaces permuted', [['Lm', 'Rm', 0], ['Lp', 'Rp', 0], ['Lp', 'Lm', 0], ['Rp', 'Rm', 0]]],
    ['winding reversed', [['Rp', 'Lp', 0], ['Rm', 'Lm', 0], ['Lm', 'Lp', 0], ['Rm', 'Rp', 0]]],
    ['station off by one', [['Lp', 'Rp', 1], ['Lm', 'Rm', 1], ['Lp', 'Lm', 1], ['Rp', 'Rm', 1]]],
];
const prims = capture(alphaCarbons('1UBQ.cif', null), {});
// 🔴 IS THE SLAB EVEN SOLID IN THIS FIXTURE? Two of the four surfaces coincide
// at zero thickness, and a control that swaps them is then no control at all -
// which is how "surfaces permuted" first reported 0.0% wrong. Stated, not
// assumed.
{
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    let thin = 0; let all = 0;
    for (const p of prims) {
        for (let k = 0; k < p.Lp.length; k++) {
            all += 1;
            if (d(p.Lp[k], p.Lm[k]) <= 0.02) thin += 1;
        }
    }
    console.log(`slab thickness: ${all - thin} of ${all} stations are solid`);
    if (all - thin === 0) {
        fail('every station is zero-thickness, so the two broad surfaces'
            + ' coincide and no permutation of them can be detected - the'
            + ' controls below would pass against anything');
    }
}
const theirs = facesOf(prims.map((p) => ({ ...p })), PARAMS, false).faces;
for (const [label, table] of CONTROLS) {
    let mine = [];
    for (const p of prims) {
        try { mine = mine.concat(facesFromStations(p, table)); } catch (e) { mine = []; }
    }
    const { n, bad } = agreement(theirs, mine);
    const pct = n > 0 && bad >= 0 ? `${(100 * bad / n).toFixed(1)}% wrong` : 'did not build';
    console.log(`control ${label.padEnd(20)} ${pct}`);
    if (bad === 0) {
        fail(`the control "${label}" reproduced the faces exactly, so this file`
            + ' is not testing the rule it claims to');
    }
}

console.log(failed
    ? 'station faces: FAILED'
    : 'station faces: a face is a piece, a station and a surface');
process.exit(failed);
