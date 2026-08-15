// Node smoke test for the cartoon renderer: loads viewer-cartoon.js with
// window shims and a mock 2D context, renders synthetic structures, and
// asserts the invariants fixed in Aug 2026: no crash without overlayState, no
// NaN paint styles under cel + shadow-off, sheet flattening confined to its
// own chain, the protein-only fast path, and DNA base pairing.
//
//   node tests/smoke.js                 # test the source
//   node tests/smoke.js py2Dmol/resources/viewer-cartoon.min.js
//
'use strict';
const fs = require('fs');
const path = require('path');

global.window = {
    dispatchEvent: () => {},
    py2dmol_customColors: {},
};
global.Event = function Event(name) { this.name = name; };
// no document: pencil path must stay off (it checks typeof document)

// Optional argv[2] points at an alternate build (e.g. the .min.js bundle).
const srcFile = process.argv[2]
    || path.resolve(__dirname, '../py2Dmol/resources/viewer-cartoon.js');
const src = fs.readFileSync(srcFile, 'utf8');
eval(src);
const cartoon = global.window.py2dmolCartoon;
if (!cartoon || !cartoon.render) throw new Error('plugin failed to load');

// ---- mock 2D context that records bad style assignments ----
function mkCtx() {
    const bad = [];
    const ctx = {
        canvas: { width: 400, height: 400 },
        lineWidth: 1, lineJoin: 'round', lineCap: 'butt', miterLimit: 10,
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        ops: 0,
        beginPath() { this.ops++; }, moveTo() {}, lineTo() {}, closePath() {},
        stroke() {}, fill() {}, arc() {},
        createLinearGradient() {
            return { addColorStop(t, c) { checkStyle(c); } };
        },
    };
    let _fill = '#000'; let _stroke = '#000';
    const checkStyle = (v) => {
        if (typeof v === 'string' && /NaN|undefined/.test(v)) bad.push(v);
    };
    Object.defineProperty(ctx, 'fillStyle', {
        get: () => _fill,
        set: (v) => { checkStyle(v); _fill = v; },
    });
    Object.defineProperty(ctx, 'strokeStyle', {
        get: () => _stroke,
        set: (v) => { checkStyle(v); _stroke = v; },
    });
    return { ctx, bad };
}

// ---- synthetic structures ----
// ideal alpha helix, n residues
function helix(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const th = i * 100 * Math.PI / 180;
        out.push({ x: 2.3 * Math.cos(th), y: 2.3 * Math.sin(th), z: 1.5 * i });
    }
    return out;
}
// straight-ish coil chain starting at x0
function coil(n, x0) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({ x: x0 + 3.8 * i, y: 2.0 * Math.sin(i * 1.7), z: 1.5 * Math.cos(i * 1.3) });
    }
    return out;
}

function mkRenderer(coords, segments, opts) {
    const n = coords.length;
    const r = {
        coords,
        rotatedCoords: coords,
        segmentIndices: segments,
        positionTypes: new Array(n).fill('P'),
        positionNames: new Array(n).fill('ALA'),
        viewerState: { extent: 30, zoom: 1, perspectiveEnabled: false, focalLength: 100 },
        objectsData: { obj: { maxExtent: 30 } },
        currentObjectName: 'obj',
        currentFrame: 0,
        lineWidth: 3.0,
        visibilityMask: null,
        outlineMode: 'on',
        relativeOutlineWidth: 3,
        shadowEnabled: true,
        cartoonShade: 1,
        colorMode: 'chain',
        screenFrameId: 0,
        screenX: new Float64Array(n),
        screenY: new Float64Array(n),
        screenRadius: new Float64Array(n),
        screenValid: new Uint8Array(n),
        _calculateSegmentWidthMultiplier: () => 1,
    };
    Object.assign(r, opts || {});
    return r;
}

function bbSegs(runs) { // runs: array of [lo, hi] inclusive residue ranges
    const segs = [];
    for (const [lo, hi] of runs) {
        for (let i = lo; i < hi; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1 });
    }
    return segs;
}

const COL = { r: 100, g: 140, b: 220 };

let failures = 0;
function test(name, fn) {
    try { fn(); console.log('PASS', name); }
    catch (e) { failures++; console.log('FAIL', name, '-', e.message); }
}

// 1. renderer.overlayState missing must not throw (fix 3)
test('render without overlayState', () => {
    const coords = helix(12);
    const segs = bbSegs([[0, 11]]);
    const r = mkRenderer(coords, segs);   // no overlayState at all
    const { ctx } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
});

// 2. cel + shadow off must not emit NaN styles (fix 1)
test('cel + shade off: no NaN styles', () => {
    const coords = helix(20);
    const segs = bbSegs([[0, 19]]);
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        cartoonSmooth: false,
        cartoonShade: 0,
    });
    const { ctx, bad } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    if (bad.length) throw new Error('bad styles: ' + bad.slice(0, 3).join(' | '));
});

// 3. flattening is SHEETS ONLY, as in PyMOL - loops must not be repositioned
// at any sheetFlat. (This also covers the older cross-chain-break bug: the
// facing termini of two coil chains are adjacent in index order, and smoothing
// across the break used to drag them tens of Angstroms toward each other.)
test('sheetFlat leaves loops untouched', () => {
    // two coil chains, far apart, both all-coil; sheetFlat at maximum
    const A = coil(8, 0);
    const B = coil(8, 200);          // 200 A away
    const coords = A.concat(B);
    const segs = bbSegs([[0, 7], [8, 15]]);
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        cartoonSheetFlat: 1.0,
        _posProbe: null,             // receive drawn positions
    });
    const { ctx } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    const pos = r._posProbe;
    if (!pos) throw new Error('no posProbe');
    // not "small" - loops are not a flattening target, so exactly zero
    let worst = 0;
    for (let i = 0; i < coords.length; i++) {
        const d = Math.hypot(pos[i].x - coords[i].x,
            pos[i].y - coords[i].y, pos[i].z - coords[i].z);
        if (d > worst) worst = d;
    }
    if (worst > 1e-9) throw new Error('loop residue moved ' + worst.toFixed(3) + ' A');
});

// 4. protein-only structure renders fine with base frames skipped (fix 4)
test('protein-only render (hasNA=false path)', () => {
    const coords = helix(15).concat(coil(10, 40));
    const segs = bbSegs([[0, 24]]);
    const r = mkRenderer(coords, segs, { overlayState: { enabled: false } });
    const { ctx, bad } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    if (bad.length) throw new Error('bad styles: ' + bad[0]);
    if (r._cartoonPair && r._cartoonPair.some((v) => v >= 0)) {
        throw new Error('protein got base pairs');
    }
});

// 5. nucleic structure still pairs (fix 4 must not break the NA path)
test('DNA duplex still finds base pairs', () => {
    // ideal-ish B-DNA C4' duplex: two antiparallel strands, ~14.6 A apart
    const N = 12;
    const a = []; const b = [];
    for (let i = 0; i < N; i++) {
        const th = i * 36 * Math.PI / 180;
        a.push({ x: 9.0 * Math.cos(th), y: 9.0 * Math.sin(th), z: 3.4 * i });
        const th2 = th + 154 * Math.PI / 180; // measured C4'-C4' geometry proxy
        b.push({ x: 9.0 * Math.cos(th2), y: 9.0 * Math.sin(th2), z: 3.4 * i });
    }
    b.reverse();
    const coords = a.concat(b);
    const n = coords.length;
    const segs = bbSegs([[0, N - 1], [N, 2 * N - 1]]);
    const seq = 'ATGCATGCATGC';
    const comp = { A: 'T', T: 'A', G: 'C', C: 'G' };
    const names = [];
    for (let i = 0; i < N; i++) names.push('D' + seq[i]);
    const rev = [];
    for (let i = 0; i < N; i++) rev.push('D' + comp[seq[i]]);
    rev.reverse();
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        positionTypes: new Array(n).fill('D'),
        positionNames: names.concat(rev),
    });
    const { ctx } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    let pairs = 0;
    for (let i = 0; i < n; i++) if (r._cartoonPair[i] > i) pairs++;
    console.log('   pairs found:', pairs, '/', N);
    if (pairs < 4) throw new Error('only ' + pairs + ' pairs found');
});

// 6. every SS palette must define every class colour - the GUI builds chip
// rows for ALL palettes at init, so one missing channel breaks the web app
test('SS palettes complete', () => {
    const P = cartoon.SS_PALETTES;
    if (!P || !Object.keys(P).length) throw new Error('no palettes exported');
    const rgbOk = (c) => c && Number.isFinite(c.r) && Number.isFinite(c.g)
        && Number.isFinite(c.b);
    for (const [k, pal] of Object.entries(P)) {
        for (const cls of ['C', 'H', 'E', 'N', 'L']) {
            if (!rgbOk(pal[cls])) throw new Error(`palette ${k} missing/invalid ${cls}`);
        }
        // optional two-tone undersides: present or absent, but never malformed
        // - paintFace reads these straight into shade()
        if (pal.back) {
            for (const [cls, c] of Object.entries(pal.back)) {
                if (!['C', 'H', 'E', 'N', 'L'].includes(cls)) {
                    throw new Error(`palette ${k} back has unknown class ${cls}`);
                }
                if (!rgbOk(c)) throw new Error(`palette ${k} back.${cls} invalid`);
            }
        }
    }
    // ... and STYLE_DEFAULTS must cover every style-owned control
    const D = cartoon.STYLE_DEFAULTS;
    for (const key of ['width', 'outlineWidth', 'thickness', 'outlineTint',
        'highlight', 'sheetFlat', 'pencil', 'arrows', 'detail', 'fade', 'shade', 'smooth']) {
        for (const s of ['richardson', 'cartoon', '3d']) {
            if (D[s][key] === undefined) throw new Error(`STYLE_DEFAULTS.${s} missing ${key}`);
        }
    }
});

// 7. CHIRALITY. Mirror a structure, mark every residue as a D-amino acid, and
// the secondary structure must come back identical - the D path exists to make
// the L-protein backbone table and the L phi/psi targets applicable to mirrored
// geometry, so anything else means the mirror is not a true mirror. Guards both
// halves at once: the table lookup (predictBackbone) and the dihedral gate.
test('mirrored + D-flagged matches L', () => {
    const L = helix(16).concat(coil(14, 30));
    const n = L.length;
    const mirrored = L.map((v) => ({ x: v.x, y: v.y, z: -v.z }));
    const types = new Array(n).fill('P');
    const ssL = cartoon.assignSecondary(L, n, types,
        { names: new Array(n).fill('ALA') }).sec.join('');
    const ssD = cartoon.assignSecondary(mirrored, n, types,
        { names: new Array(n).fill('DAL') }).sec.join('');
    if (ssL !== ssD) throw new Error(`L ${ssL} != mirrored-D ${ssD}`);
    if (ssL.indexOf('H') < 0) throw new Error('test structure has no helix to check');
    // ... and without the D flag the mirrored helix is lost entirely, which is
    // the bug this guards (5KX0 drew both its helices as coil)
    const ssNaive = cartoon.assignSecondary(mirrored, n, types).sec.join('');
    if (ssNaive.indexOf('H') >= 0) throw new Error('expected the unflagged mirror to lose its helix');

    // the all-L path must be untouched by the names argument
    const bare = cartoon.assignSecondary(L, n, types).sec.join('');
    if (bare !== ssL) throw new Error('L-only result changed when names were passed');
});


// 8. CYCLIC PEPTIDES. viewer-mol.js emits a head-to-tail bond joining a chain's
// first and last residue; it is not index-adjacent, so the cartoon used to
// reject it as backbone and draw it as a generic stick while the ribbon
// terminated at both ends. The run must now close and the ribbon must take one
// extra interval around the seam.
test('cyclic run closes the ribbon', () => {
    // a closed ring of C-alphas, 3.8 A apart
    const N = 24;
    const R = 3.8 / (2 * Math.sin(Math.PI / N));
    const coords = [];
    for (let i = 0; i < N; i++) {
        const t = (2 * Math.PI * i) / N;
        coords.push({ x: R * Math.cos(t), y: R * Math.sin(t), z: 0.4 * Math.sin(3 * t) });
    }
    const open = bbSegs([[0, N - 1]]);
    // ... plus the closure bond, exactly as viewer-mol.js emits it
    const closed = open.concat([{ type: 'P', idx1: 0, idx2: N - 1 }]);

    const runOne = (segs) => {
        const r = mkRenderer(coords, segs, { overlayState: { enabled: false } });
        const { ctx, bad } = mkCtx();
        cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
        if (bad.length) throw new Error('bad styles: ' + bad[0]);
        return ctx.ops;
    };
    const opsOpen = runOne(open);
    const opsClosed = runOne(closed);
    // the seam interval is real geometry, so it costs real paint operations
    if (!(opsClosed > opsOpen)) {
        throw new Error(`closure drew nothing extra (${opsClosed} vs ${opsOpen})`);
    }
    // a bond that closes nothing must NOT be swallowed - it stays an ordinary
    // drawn bond rather than silently turning the chain into a ring
    const stray = open.concat([{ type: 'P', idx1: 2, idx2: N - 4 }]);
    if (!(runOne(stray) > opsOpen)) throw new Error('a non-closure bond was dropped');
});


process.exit(failures ? 1 : 0);
