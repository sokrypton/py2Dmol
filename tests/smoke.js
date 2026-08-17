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
        viewerState: { extent: 30, zoom: 1, ortho: 1, focalLength: 100 },
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


// 9. A LIGAND BOND IS A BOX, AND NO LINE CROSSES ITS FACE.
// The rule is that an edge is inked only where one of the two faces meeting
// along it faces the viewer and the other does not. An interior crease - both
// faces visible - fails that by construction, and a cap ring is dropped at any
// atom that carries another bond. Both were drawn by the previous attempt, as
// a line ruled across every stick.
//
// Checked per box and locally: an edge whose two ends both land INSIDE that
// box's own outline is a line across its face. This cannot be seen from the
// finished canvas, where a stick legitimately draws over whatever is behind it,
// which is why the renderer exposes _stickProbe.
test('ligand sticks: no edge crosses its own face', () => {
    const hull = (P) => {
        const pts = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1])
            - (a[1] - o[1]) * (b[0] - o[0]);
        const half = (s) => {
            const h = [];
            for (const p of s) {
                while (h.length >= 2 && cr(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
                h.push(p);
            }
            h.pop();
            return h;
        };
        return half(pts).concat(half(pts.slice().reverse()));
    };
    const insideBy = (p, poly) => {
        let inside = false;
        let best = Infinity;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i];
            const b = poly[j];
            if (((a[1] > p[1]) !== (b[1] > p[1]))
                && (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])) {
                inside = !inside;
            }
            const vx = b[0] - a[0];
            const vy = b[1] - a[1];
            const L = vx * vx + vy * vy;
            let s = L > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
            s = Math.max(0, Math.min(1, s));
            best = Math.min(best, Math.hypot(p[0] - (a[0] + s * vx),
                p[1] - (a[1] + s * vy)));
        }
        return inside ? best : 0;
    };
    // a ring (every atom two-legged), a planar three-way centre, and a
    // tetrahedral one: the first two are mitred, the last overlaps
    const ring6 = [];
    const ringBonds = [];
    for (let i = 0; i < 6; i++) {
        ring6.push([1.39 * Math.cos((i * Math.PI) / 3),
            1.39 * Math.sin((i * Math.PI) / 3), 0]);
        ringBonds.push([i, (i + 1) % 6]);
    }
    const scenes = [
        [ring6, ringBonds],
        [[[0, 0, 0], [1.4, 0, 0], [-0.7, 1.21, 0], [-0.7, -1.21, 0]],
            [[0, 1], [0, 2], [0, 3]]],
        [[[0, 0, 0], [0.89, 0.89, 0.89], [0.89, -0.89, -0.89],
            [-0.89, 0.89, -0.89], [-0.89, -0.89, 0.89]],
            [[0, 1], [0, 2], [0, 3], [0, 4]]],
    ];
    let boxes = 0;
    let edges = 0;
    for (const [xyz, bonds] of scenes) {
        for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) {
                const ra = (i * Math.PI) / 5;
                const rb = (j * Math.PI) / 5;
                const coords = xyz.map(([x, y, z]) => {
                    const y2 = y * Math.cos(ra) - z * Math.sin(ra);
                    const z2 = y * Math.sin(ra) + z * Math.cos(ra);
                    return { x: x * Math.cos(rb) - z2 * Math.sin(rb),
                        y: y2,
                        z: x * Math.sin(rb) + z2 * Math.cos(rb) };
                });
                const segs = bonds.map(([a, b]) => ({ type: 'L', idx1: a, idx2: b }));
                const r = mkRenderer(coords, segs, { overlayState: { enabled: false } });
                r.positionTypes = new Array(coords.length).fill('L');
                r.positionNames = new Array(coords.length).fill('LIG');
                r.viewerState.extent = 4;
                r.objectsData.obj.maxExtent = 4;
                r._stickProbe = [];
                const { ctx, bad } = mkCtx();
                cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
                if (bad.length) throw new Error('bad styles: ' + bad[0]);
                if (!r._stickProbe.length) throw new Error('no sticks were built');
                for (const bx of r._stickProbe) {
                    boxes++;
                    const H = hull(bx.V);
                    // A box with no width is what a junction produces when its
                    // two corners land on top of each other - the ring case,
                    // where the sticks vanished entirely.
                    let wide = 0;
                    for (const p of bx.V) {
                        for (const q of bx.V) {
                            wide = Math.max(wide, Math.hypot(p[0] - q[0], p[1] - q[1]));
                        }
                    }
                    let thin = Infinity;
                    for (let e = 0; e < 8; e += 4) {
                        const quad = bx.V.slice(e, e + 4);
                        let d = 0;
                        for (const p of quad) {
                            for (const q of quad) {
                                d = Math.max(d, Math.hypot(p[0] - q[0], p[1] - q[1]));
                            }
                        }
                        thin = Math.min(thin, d);
                    }
                    if (wide > 4 && thin < 0.5) {
                        throw new Error('a stick collapsed to no width');
                    }
                    for (const [ea, eb] of bx.edges) {
                        edges++;
                        const d = Math.min(insideBy(bx.V[ea], H), insideBy(bx.V[eb], H));
                        if (d > 1.0) {
                            throw new Error(`an inked edge lies ${d.toFixed(1)}px `
                                + 'inside its own box - a line across the face');
                        }
                    }
                }
            }
        }
    }
    if (edges < 100) throw new Error(`only ${edges} edges inked over ${boxes} boxes`);
});

// 10. THE BOX ITSELF IS CLOSED. A pure table check: the six faces must use
// each of the twelve edges exactly twice and each of the eight vertices exactly
// three times. The previous attempt indexed corners in the ribbon's bit order,
// where opposite corners are adjacent, and its end faces came out as bow-ties.
test('ligand sticks: the box is a closed solid', () => {
    const r = mkRenderer([{ x: -0.75, y: 0, z: 0 }, { x: 0.75, y: 0, z: 0 }],
        [{ type: 'L', idx1: 0, idx2: 1 }], { overlayState: { enabled: false } });
    r.positionTypes = ['L', 'L'];
    r.positionNames = ['LIG', 'LIG'];
    r.viewerState.extent = 3;
    r.objectsData.obj.maxExtent = 3;
    r._stickProbe = [];
    const { ctx } = mkCtx();
    cartoon.render(r, ctx, 400, 400, [COL]);
    const bx = r._stickProbe[0];
    if (!bx || bx.V.length !== 8) throw new Error('a box must have 8 vertices');
    // an isolated bond seen from the side shows four silhouette edges, or six
    // once it is turned; never more, and never fewer than four
    if (bx.edges.length < 4 || bx.edges.length > 6) {
        throw new Error(`${bx.edges.length} silhouette edges - expected 4 to 6`);
    }
});

// 11. THE BOX KEEPS ALL ITS SIDES UNDER PERSPECTIVE. A convex box's visible
// faces tile its own outline exactly, so any pixel inside that outline with no
// painted face on it is a side that has gone missing. Culling asks whether a
// face turns toward the EYE, and under perspective the eye ray has to be built
// in view space, where the normals are: feeding the PROJECTED point in instead
// mixes screen pixels with Angstroms and the canvas-centre offset swamps it,
// which culled a quarter of the heme's faces. Tests 9 and 10 stayed green
// throughout - they check geometry, and they only ever ran orthographic.
test('ligand sticks: no side goes missing under perspective', () => {
    const inTri = (x, y, a, b, c) => {
        const d = (p, q, r2) => (p[0] - r2[0]) * (q[1] - r2[1])
            - (q[0] - r2[0]) * (p[1] - r2[1]);
        const d1 = d([x, y], a, b), d2 = d([x, y], b, c), d3 = d([x, y], c, a);
        return !(((d1 < 0) || (d2 < 0) || (d3 < 0))
            && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
    };
    const covers = (f, x, y) => inTri(x, y, f[0], f[1], f[2])
        || inTri(x, y, f[0], f[2], f[3]);
    // a 3-way planar centre and a tetrahedral one: junction boxes are mitred,
    // so their end faces are oblique and are the ones culling gets wrong
    const D = 0.866;
    const scenes = [
        [[{ x: 0, y: 0, z: 0 }, { x: 1.5, y: 0, z: 0 },
            { x: -0.75, y: 1.299, z: 0 }, { x: -0.75, y: -1.299, z: 0 }],
        [[0, 1], [0, 2], [0, 3]]],
        [[{ x: 0, y: 0, z: 0 }, { x: D, y: D, z: D }, { x: D, y: -D, z: -D },
            { x: -D, y: D, z: -D }, { x: -D, y: -D, z: D }],
        [[0, 1], [0, 2], [0, 3], [0, 4]]],
    ];
    let checked = 0, holes = 0, total = 0;
    for (const [atoms, bonds] of scenes) {
        for (let k = 0; k < 8; k++) {
            const a1 = 0.7 * Math.sin(k * 1.7), a2 = k * Math.PI / 4;
            const rot = ({ x, y, z }) => {
                let Y = y * Math.cos(a1) - z * Math.sin(a1);
                let Z = y * Math.sin(a1) + z * Math.cos(a1);
                const X = x * Math.cos(a2) - Z * Math.sin(a2);
                Z = x * Math.sin(a2) + Z * Math.cos(a2);
                return { x: X, y: Y, z: Z };
            };
            const C = atoms.map(rot);
            const r = mkRenderer(C, bonds.map(([i, j]) => ({ type: 'L', idx1: i, idx2: j })),
                { overlayState: { enabled: false } });
            r.positionTypes = C.map(() => 'L');
            r.positionNames = C.map(() => 'LIG');
            r.viewerState.extent = 3;
            r.viewerState.ortho = 0;              // PERSPECTIVE - the whole point
            r.objectsData.obj.maxExtent = 3;
            r._stickProbe = [];
            const { ctx } = mkCtx();
            cartoon.render(r, ctx, 400, 400, bonds.map(() => COL));
            for (const bx of r._stickProbe) {
                if (!bx.faces) throw new Error('probe carries no faces');
                checked++;
                // Ground truth is the union of ALL SIX faces, drawn or not -
                // not the convex hull of the eight corners. A box whose ends
                // are rolled onto two different junction planes twists, and a
                // twisted prism is not convex, so its hull is strictly larger
                // than its silhouette and would score the difference as holes.
                const all = bx.faces.map((f) => f.q);
                const painted = bx.faces.filter((f) => f.drawn).map((f) => f.q);
                for (let x = 0; x < 400; x += 2) {
                    for (let y = 0; y < 400; y += 2) {
                        if (!all.some((f) => covers(f, x + 0.5, y + 0.5))) continue;
                        total++;
                        if (!painted.some((f) => covers(f, x + 0.5, y + 0.5))) holes++;
                    }
                }
            }
        }
    }
    if (checked < 20) throw new Error(`only ${checked} boxes checked`);
    if (holes / total > 0.005) {
        throw new Error(`${(100 * holes / total).toFixed(1)}% of the box outlines `
            + 'have no face painted on them - sides are missing');
    }
});

// 12. A LINEAR RUN IS ONE SWEPT SOLID. A chain of atoms each carrying exactly
// two sticks is merged rather than mitred bond by bond, because an exact mitre
// of square sections only closes when a section axis is perpendicular to both
// legs - so every bend would pin the roll to its own local plane, and along a
// zig-zag the box twists to follow (measured on a heme: 38 degrees over one
// bond, down to 18 once merged). The merge works by handing BOTH bonds at a
// station the very same polygon, so the seam is a shared face. If the two ever
// stop being the same points, the join opens.
test('ligand sticks: a merged run shares its seams exactly', () => {
    // A REAL PROPIONATE, lifted off a heme (its C3D-CAD-CBD-CGD arm): 4 atoms,
    // 3 bonds, 2 interior stations. Its consecutive bends lie in very different
    // planes, which is exactly the case that made per-bend mitring twist the
    // box 38 degrees over a single bond. An invented gentle zig-zag does not
    // twist enough to tell the two constructions apart.
    const C = [
        { x: 1.357, y: -3.134, z: 0.597 },
        { x: 2.333, y: -3.861, z: 1.476 },
        { x: 1.786, y: -4.205, z: 2.855 },
        { x: 2.873, y: -4.968, z: 3.579 },
    ];
    const bonds = [[0, 1], [1, 2], [2, 3]];
    const r = mkRenderer(C, bonds.map(([i, j]) => ({ type: 'L', idx1: i, idx2: j })),
        { overlayState: { enabled: false } });
    r.positionTypes = C.map(() => 'L');
    r.positionNames = C.map(() => 'LIG');
    r.viewerState.extent = 5;
    r.viewerState.ortho = 0;
    r.objectsData.obj.maxExtent = 5;
    r._stickProbe = [];
    const { ctx } = mkCtx();
    cartoon.render(r, ctx, 400, 400, bonds.map(() => COL));
    const boxes = r._stickProbe;
    if (boxes.length !== 3) throw new Error(`${boxes.length} boxes, expected 3`);
    // the four corners a box puts at a given atom
    const faceAt = (bx, atom) => {
        if (bx.a === atom) return bx.W.slice(0, 4);
        if (bx.b === atom) return bx.W.slice(4, 8);
        return null;
    };
    let seams = 0;
    for (const atom of [1, 2]) {                  // the interior stations
        const touching = boxes.filter((bx) => bx.a === atom || bx.b === atom);
        if (touching.length !== 2) throw new Error(`atom ${atom}: ${touching.length} boxes`);
        const f0 = faceAt(touching[0], atom), f1 = faceAt(touching[1], atom);
        let worst = 0;
        for (const p of f0) {
            let near = Infinity;
            for (const q of f1) {
                near = Math.min(near, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
            }
            worst = Math.max(worst, near);
        }
        if (worst > 1e-9) {
            throw new Error(`atom ${atom}: the two boxes' end faces differ by `
                + `${worst.toFixed(3)} A - the seam is open, not shared`);
        }
        seams++;
    }
    if (seams !== 2) throw new Error('expected 2 merged seams');
    // NOT asserted here: that the run twists less than mitring it would. The
    // twist only appears when a run is pinned at BOTH ends by 3-way junctions,
    // which no small synthetic case reproduces - on an isolated propionate the
    // two constructions differ by 2 degrees. It is measured on a real heme
    // instead (38 degrees down to 18); see tests/README.md.
});

// 13. THE SECTION IS FIXED TO THE MOLECULE, NOT THE VIEW. A square has only
// four-fold symmetry, so where a bond's roll comes from matters: anything taken
// off a screen axis stays put while the structure turns under it, and the stick
// visibly refuses to rotate. Two cases reached that:
//   * an ISOLATED bond has no neighbours to read, and if it is centred it has
//     no offset from the middle either, so it fell through to a view axis;
//   * a TETRAHEDRAL centre has its remaining neighbours arranged symmetrically
//     about the bond, and averaging those planes by sign-aligning each term let
//     rounding decide a sign that was genuinely 50/50 - the roll jumped between
//     two answers 60 degrees apart.
// Both are measured the same way: render at many angles, undo the rotation, and
// require the roll to land back in the same place every time.
test('ligand sticks: the roll follows the molecule, not the view', () => {
    const MOLS = {
        'isolated bond': { at: [[-0.75, 0, 0], [0.75, 0, 0]], bo: [[0, 1]] },
        'tetrahedral': {
            at: [[0, 0, 0], [0.866, 0.866, 0.866], [0.866, -0.866, -0.866],
                [-0.866, 0.866, -0.866], [-0.866, -0.866, 0.866]],
            bo: [[0, 1], [0, 2], [0, 3], [0, 4]],
        },
    };
    const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) =>
        r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)],
        [0, Math.sin(a), Math.cos(a)]];
    const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0],
        [-Math.sin(a), 0, Math.cos(a)]];
    const apply = (R, p) => ({
        x: R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2],
        y: R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2],
        z: R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2],
    });
    const unrot = (R, v) => [                       // R is a rotation, so R^T
        R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
        R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
        R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]];
    for (const name of Object.keys(MOLS)) {
        const mol = MOLS[name];
        const ref = {}; let worst = 0;
        for (let i = 0; i < 8; i++) {
            const R = mul(Ry(i * Math.PI / 4), Rx(0.6 * Math.sin(i * 1.3)));
            const model = mol.at.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
            const view = mol.at.map((p) => apply(R, p));
            const r = mkRenderer(model,
                mol.bo.map(([a, b]) => ({ type: 'L', idx1: a, idx2: b })),
                { overlayState: { enabled: false } });
            r.rotatedCoords = view;                 // model and view differ, as
            r.viewerState.rotation = R;             // they do in the app
            r.viewerState.ortho = 0;
            r.viewerState.extent = 4;
            r.objectsData.obj.maxExtent = 4;
            r.positionTypes = model.map(() => 'L');
            r.positionNames = model.map(() => 'LIG');
            r._stickProbe = [];
            const { ctx } = mkCtx();
            cartoon.render(r, ctx, 400, 400, mol.bo.map(() => COL));
            for (const bx of r._stickProbe) {
                if (!bx.W) throw new Error('probe carries no 3D vertices');
                const mid = (o) => [0, 1, 2].map((k) => (bx.W[o][k] + bx.W[o + 1][k]
                    + bx.W[o + 2][k] + bx.W[o + 3][k]) / 4);
                const c0 = mid(0), c1 = mid(4);
                const ax = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
                const am = Math.hypot(ax[0], ax[1], ax[2]) || 1;
                const t = [ax[0] / am, ax[1] / am, ax[2] / am];
                const v = [bx.W[0][0] - c0[0], bx.W[0][1] - c0[1], bx.W[0][2] - c0[2]];
                const d = v[0] * t[0] + v[1] * t[1] + v[2] * t[2];
                const w = [v[0] - t[0] * d, v[1] - t[1] * d, v[2] - t[2] * d];
                const wm = Math.hypot(w[0], w[1], w[2]) || 1;
                const u = unrot(R, [w[0] / wm, w[1] / wm, w[2] / wm]);
                const key = bx.a + '-' + bx.b;
                if (!ref[key]) { ref[key] = u; continue; }
                const p = ref[key];
                let deg = Math.acos(Math.max(-1, Math.min(1,
                    Math.abs(u[0] * p[0] + u[1] * p[1] + u[2] * p[2])))) * 180 / Math.PI;
                while (deg > 45) deg = Math.abs(deg - 90);   // a square repeats
                if (deg > worst) worst = deg;
            }
        }
        if (worst > 1) {
            throw new Error(`${name}: the section rolls ${worst.toFixed(0)} deg `
                + 'as the view turns - it is keyed to the screen, not the molecule');
        }
    }
});

// 14. A STICK DOES NOT WRING ALONG ITS LENGTH. The section is carried from one
// end of a bond to the other, and how far it rotates on the way is visible: the
// four faces of the box carry different normals, so a section turned even a
// quarter of the way round is lit differently all along the bond and reads as a
// twist, however little the silhouette moved. That is why this measures the RAW
// rotation and folds nothing into the square's symmetry - an earlier version of
// the spreading code folded the residual to 45 degrees on exactly that mistaken
// reasoning, and left up to a quarter turn per run sitting in the geometry.
//
// The side chains are the case set - CA outward, with the backbone dropped -
// because between them they cover the shapes the junction code handles on real
// coordinates: the branched carbons of VAL/LEU/ILE/THR, the rings of
// PHE/TYR/HIS/TRP, and ARG's guanidinium. Sixteen junctions over nineteen side
// chains; GLY has none, being one atom once the backbone goes.
//
// WHAT THIS DOES NOT COVER, stated because the number looks reassuring: no
// residue exercises the case that produced the 94 degrees. Restoring the
// quarter-turn fold leaves this test passing, because the worst residue twists
// 14 degrees and the fault needs a bond running from a merged seam to a mitred
// junction with a large residual. Cofactors do that; side chains do not. TPP
// (3D2G) still turns 81 degrees and T6A (1YFG) 71, and neither is asserted here
// - they are open, not covered. Treat this as a floor on a broad set of real
// geometry, not as a guard on the twist logic.
const SIDECHAIN = {
    ALA: [[[0.57,-0.41,-0.31],[-0.57,0.41,0.31]],[[0,1]]],
    SER: [[[-0.55,-0.72,-0.88],[0.53,-0.15,0.03],[0.01,0.87,0.85]],[[0,1],[1,2]]],
    CYS: [[[0.33,0.86,-0.97],[0.32,0.31,0.44],[-0.65,-1.17,0.53]],[[0,1],[1,2]]],
    THR: [[[-0.80,-0.79,0.92],[0.24,0.13,0.26],[-0.41,1.27,-0.31],[0.97,-0.60,-0.86]],[[0,1],[1,2],[1,3]]],
    VAL: [[[-1.11,-0.21,-0.94],[-0.20,0.16,0.27],[0.45,-1.08,0.86],[0.86,1.13,-0.19]],[[0,1],[1,2],[1,3]]],
    PRO: [[[-0.08,-0.70,-1.19],[-0.16,-0.99,0.31],[0.38,0.29,0.91],[-0.14,1.41,-0.03]],[[0,1],[1,2],[2,3]]],
    LEU: [[[1.11,-1.23,1.25],[1.02,-0.12,0.19],[-0.30,0.06,-0.58],[-1.47,-0.16,0.34],[-0.36,1.45,-1.20]],[[0,1],[1,2],[2,3],[2,4]]],
    ILE: [[[1.57,-1.11,-0.01],[0.41,-0.15,-0.40],[-0.08,0.57,0.86],[-0.75,-0.88,-1.04],[-1.14,1.56,0.59]],[[0,1],[1,2],[1,3],[2,4]]],
    ASN: [[[-1.60,-0.33,1.11],[-0.59,-0.88,0.11],[0.45,0.14,-0.27],[0.78,1.01,0.54],[0.96,0.06,-1.49]],[[0,1],[1,2],[2,3],[2,4]]],
    ASP: [[[0.02,-1.95,0.30],[-0.64,-0.75,-0.38],[0.04,0.56,-0.06],[0.37,0.77,1.13],[0.21,1.37,-0.99]],[[0,1],[1,2],[2,3],[2,4]]],
    MET: [[[-1.72,0.76,1.62],[-0.88,-0.15,0.74],[0.56,0.28,0.57],[1.34,-0.81,-0.65],[0.71,-0.09,-2.27]],[[0,1],[1,2],[2,3],[3,4]]],
    GLN: [[[2.06,-1.79,0.50],[1.19,-0.83,-0.31],[0.33,0.03,0.60],[-0.85,0.69,-0.11],[-0.82,0.88,-1.33],[-1.90,1.01,0.65]],[[0,1],[1,2],[2,3],[3,4],[3,5]]],
    GLU: [[[-0.58,-1.27,-2.40],[-0.73,-0.63,-1.03],[0.53,-0.04,-0.48],[0.32,0.50,0.93],[-0.17,-0.24,1.82],[0.63,1.68,1.17]],[[0,1],[1,2],[2,3],[3,4],[3,5]]],
    LYS: [[[-1.34,-2.10,2.04],[-0.17,-1.40,1.33],[-0.59,-0.41,0.26],[0.61,0.34,-0.33],[0.18,1.37,-1.39],[1.30,2.21,-1.92]],[[0,1],[1,2],[2,3],[3,4],[4,5]]],
    ARG: [[[1.42,-1.03,-3.34],[1.19,0.13,-2.35],[0.49,-0.25,-1.08],[0.19,0.97,-0.27],[-0.91,0.75,0.65],[-0.82,0.04,1.76],[0.32,-0.53,2.10],[-1.88,-0.07,2.55]],[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[5,7]]],
    HIS: [[[0.87,2.00,1.58],[1.40,0.77,0.87],[0.37,0.06,0.06],[-0.42,-0.94,0.57],[-0.00,0.21,-1.24],[-1.23,-1.39,-0.37],[-0.99,-0.71,-1.48]],[[0,1],[1,2],[2,3],[2,4],[3,5],[4,6],[5,6]]],
    PHE: [[[2.01,0.99,1.90],[1.93,0.71,0.40],[0.60,0.20,-0.04],[-0.43,1.08,-0.30],[0.36,-1.17,-0.13],[-1.68,0.60,-0.64],[-0.89,-1.65,-0.47],[-1.92,-0.76,-0.72]],[[0,1],[1,2],[2,3],[2,4],[3,5],[4,6],[5,7],[6,7]]],
    TYR: [[[-1.51,2.54,1.72],[-1.55,1.00,1.74],[-0.64,0.32,0.73],[-0.91,0.38,-0.64],[0.50,-0.41,1.14],[-0.09,-0.26,-1.58],[1.34,-1.05,0.20],[1.03,-0.97,-1.17],[1.83,-1.55,-2.14]],[[0,1],[1,2],[2,3],[2,4],[3,5],[4,6],[5,7],[6,7],[7,8]]],
    TRP: [[[3.38,0.58,-0.82],[2.64,-0.38,0.13],[1.21,-0.61,-0.24],[0.74,-1.45,-1.22],[0.07,0.06,0.30],[-0.62,-1.32,-1.33],[-1.06,-0.41,-0.41],[-0.12,1.02,1.30],[-2.35,0.05,-0.14],[-1.40,1.47,1.57],[-2.50,0.99,0.85]],[[0,1],[1,2],[2,3],[2,4],[3,5],[4,6],[4,7],[5,6],[6,8],[7,9],[8,10],[9,10]]],
};

test('ligand sticks: no bond wrings along its length', () => {
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const crs = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2],
        p[0] * q[1] - p[1] * q[0]];
    const un = (v) => {
        const m = Math.hypot(v[0], v[1], v[2]);
        return m > 1e-12 ? [v[0] / m, v[1] / m, v[2] / m] : null;
    };
    const rej = (v, t) => un(sub(v, [t[0] * dot(v, t), t[1] * dot(v, t), t[2] * dot(v, t)]));
    let worst = 0; let worstAt = ''; let bonds = 0;
    for (const name of Object.keys(SIDECHAIN)) {
        const [xyz, bo] = SIDECHAIN[name];
        const C = xyz.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
        const r = mkRenderer(C, bo.map(([i, j]) => ({ type: 'L', idx1: i, idx2: j })),
            { overlayState: { enabled: false } });
        r.positionTypes = C.map(() => 'L');
        r.positionNames = C.map(() => 'LIG');
        r.viewerState.extent = 8;
        r.viewerState.ortho = 0;
        r.objectsData.obj.maxExtent = 8;
        r._stickProbe = [];
        const { ctx } = mkCtx();
        cartoon.render(r, ctx, 400, 400, bo.map(() => COL));
        for (const bx of r._stickProbe) {
            if (!bx.W) throw new Error('probe carries no 3D vertices');
            // A MITRED END IS OBLIQUE, and its corners therefore sit turned from
            // a perpendicular section's without the bond having twisted at all -
            // that is the shear every mitre has, not a wrung stick. Measuring it
            // as twist made this fail the moment three-way centres started
            // mitring regardless of tilt. The faults this test exists for are
            // all in the SWEEP's residual, which lands on seam and plain ends,
            // so those are what it measures.
            if (bx.mitre0 || bx.mitre1) continue;
            const mid = (o) => [0, 1, 2].map((k) => (bx.W[o][k] + bx.W[o + 1][k]
                + bx.W[o + 2][k] + bx.W[o + 3][k]) / 4);
            const c0 = mid(0); const c1 = mid(4);
            const t = un(sub(c1, c0));
            if (!t) continue;
            const a = rej(sub(bx.W[0], c0), t);
            const b = rej(sub(bx.W[4], c1), t);
            if (!a || !b) continue;
            const deg = Math.abs(Math.atan2(dot(crs(a, b), t),
                Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI);
            bonds++;
            if (deg > worst) { worst = deg; worstAt = `${name} ${bx.a}-${bx.b}`; }
        }
    }
    if (bonds < 40) throw new Error(`only ${bonds} bonds measured`);
    // 20, with the side chains measuring 13. A bond between two MITRED junctions
    // does have to interpolate between two planes each junction fixes on its
    // own, and that twist is unavoidable - but no side chain contains one, so
    // this set can be held tight. It is the faults it was written against that
    // set the bar: a residual folded into a quarter turn (94 deg), and a residual
    // spread at all when the run started at a free end and could simply be
    // turned to meet its pin (51 on HIS CB-CG). Reintroduce either and this
    // fails.
    //
    // It does NOT cover the third: spreading a residual over the stations
    // instead of the bonds. That path now only runs when BOTH ends of a run are
    // pinned, and no side chain has one - they all start free at CA. A cofactor
    // is needed for it, and none is asserted here.
    if (worst > 20) {
        throw new Error(`a bond's section turns ${worst.toFixed(0)} deg along its `
            + `length (${worstAt}) - the stick visibly wrings`);
    }
});

// 15. THICKNESS MEANS ANGSTROM, AND ZERO MEANS ONE FACE. The control is the
// same one the ribbon uses and carries the same unit - the value is the TOTAL
// thickness - so Thickness 1 must produce a stick 1 A thick, not the 0.71 A it
// gave when it was measured against the value the sticks happened to be square
// at. And at zero the box has no interior: its two wide faces land on each
// other and the other four have no area, so it must collapse to a single
// double-sided quad rather than six faces, four of them degenerate. That
// reduction is the whole reason a preset takes thickness to zero.
test('ligand sticks: thickness is in Angstrom, and zero draws one face', () => {
    const mkBond = (th, userSet) => {
        const r = mkRenderer([{ x: -0.75, y: 0, z: 0 }, { x: 0.75, y: 0, z: 0 }],
            [{ type: 'L', idx1: 0, idx2: 1 }], { overlayState: { enabled: false } });
        r.positionTypes = ['L', 'L'];
        r.positionNames = ['LIG', 'LIG'];
        r.viewerState.extent = 3;
        r.objectsData.obj.maxExtent = 3;
        if (th !== null) r.cartoonThickness = th;
        if (userSet) r._thicknessUserSet = true;
        r._stickProbe = [];
        const { ctx } = mkCtx();
        cartoon.render(r, ctx, 400, 400, [COL]);
        return r._stickProbe[0];
    };
    // half-thickness read off the box: corners 0 and 3 differ only in u
    const halfT = (bx) => 0.5 * Math.hypot(bx.W[0][0] - bx.W[3][0],
        bx.W[0][1] - bx.W[3][1], bx.W[0][2] - bx.W[3][2]);
    // the control, once the USER has moved it, is a thickness in Angstrom
    for (const th of [0.5, 1.0, 1.5]) {
        const got = 2 * halfT(mkBond(th, true));
        if (Math.abs(got - th) > 1e-6) {
            throw new Error(`thickness ${th} drew ${got.toFixed(3)} A`);
        }
    }
    // A LIGAND KEEPS ITS OWN SECTION AND A PRESET DOES NOT RESHAPE IT just
    // because it reshaped the ribbon: richardson's 0.7 and 3d's 0.5 both leave
    // the stick at its own square 0.5 x 0.5.
    for (const th of [null, 0.7, 1.5]) {
        const d = mkBond(th);           // preset, not user - must be ignored
        const hw = 0.5 * Math.hypot(d.W[0][0] - d.W[1][0],
            d.W[0][1] - d.W[1][1], d.W[0][2] - d.W[1][2]);
        if (Math.abs(2 * halfT(d) - 0.5) > 1e-6 || Math.abs(2 * hw - 0.5) > 1e-6) {
            throw new Error(`preset thickness ${th} gave a section `
                + `${(2 * hw).toFixed(3)} wide x ${(2 * halfT(d)).toFixed(3)} deep`
                + ' - expected a square 0.500 x 0.500');
        }
    }
    // ...with ONE exception: the ribbon preset asks for 0 because flatness IS
    // the look it means, and a solid stick among flat ribbons reads wrong. So a
    // preset 0 - and only 0 - does reach the ligand.
    const ribbonPreset = mkBond(0);
    if (ribbonPreset.faces.length !== 1) {
        throw new Error(`the ribbon preset (thickness 0) drew a ligand with `
            + `${ribbonPreset.faces.length} faces - expected 1, a flat sheet`);
    }
    // ...but a 0 the USER asked for is still a sheet: one face, drawn, and
    // inked all the way round
    const flat = mkBond(0, true);
    if (flat.faces.length !== 1) {
        throw new Error(`${flat.faces.length} faces at thickness 0 - expected 1`);
    }
    if (!flat.faces[0].drawn) throw new Error('the sheet was culled');
    if (flat.edges.length !== 4) {
        throw new Error(`${flat.edges.length} silhouette edges - a sheet has 4`);
    }
    // and it must be a real quad, not a slit. Measured in ANGSTROM, not on
    // screen: an isolated bond's roll is arbitrary, so the sheet may legitimately
    // be edge-on to the camera and cover no pixels - which is what a sheet does,
    // not a fault. Its area in space is the view-independent quantity.
    const fq = [0, 1, 5, 4].map((vi) => flat.W[vi]);
    const cross = (u2, v2) => [u2[1] * v2[2] - u2[2] * v2[1],
        u2[2] * v2[0] - u2[0] * v2[2], u2[0] * v2[1] - u2[1] * v2[0]];
    const sub = (u2, v2) => [u2[0] - v2[0], u2[1] - v2[1], u2[2] - v2[2]];
    const area = 0.5 * (Math.hypot(...cross(sub(fq[2], fq[0]), sub(fq[1], fq[0])))
        + Math.hypot(...cross(sub(fq[3], fq[0]), sub(fq[2], fq[0]))));
    // 1.5 A bond x 0.5 A wide
    if (Math.abs(area - 0.75) > 0.02) {
        throw new Error(`the sheet is ${area.toFixed(3)} A^2 - expected 0.75`);
    }
});

// 16. A SHEET'S JUNCTION FILL MUST FACE THE VIEWER. The polygon closing a
// mitred junction takes its normal from ax, whose sign comes from sign-aligned
// cross products of the legs - a property of the leg ORDER, not of the view. A
// solid gets away with that because it emits the polygon twice and the
// wrong-facing copy is buried inside the solid. At zero thickness there is only
// one copy and nothing to bury it in, so an arbitrary sign decides whether the
// junction is lit or sits at bare ambient: reported as dark triangles and
// squares at the junctions of a flat ligand, and measured at 10 of 23 joints on
// a haem before the fix.
test('ligand sticks: a flat junction fill faces the viewer', () => {
    // three legs at 120 degrees, in a plane tilted out of the screen so ax is
    // neither along the view axis nor perpendicular to it
    const D = 1.5; const r3 = Math.sqrt(3) / 2;
    const tilt = 40 * Math.PI / 180;
    const C = Math.cos(tilt); const S = Math.sin(tilt);
    const put = (x, y) => ({ x, y: y * C, z: y * S });
    for (const order of [[1, 2, 3], [3, 2, 1]]) {   // leg order must not matter
        const coords = [put(0, 0), put(D, 0),
            put(-D / 2, D * r3), put(-D / 2, -D * r3)];
        const r = mkRenderer(coords,
            order.map((j) => ({ type: 'L', idx1: 0, idx2: j })),
            { overlayState: { enabled: false } });
        r.positionTypes = ['L', 'L', 'L', 'L'];
        r.positionNames = ['LIG', 'LIG', 'LIG', 'LIG'];
        r.viewerState.extent = 4;
        r.objectsData.obj.maxExtent = 4;
        r.cartoonThickness = 0;
        r._thicknessUserSet = true;      // a user-asked 0 is the flat path
        r._jointProbe = [];
        const { ctx } = mkCtx();
        cartoon.render(r, ctx, 400, 400, order.map(() => COL));
        if (!r._jointProbe.length) throw new Error('the junction was not filled');
        for (const j of r._jointProbe) {
            // ortho here, so the eye ray is +z
            if (j.n[2] < 0) {
                throw new Error(`joint faces away from the eye (nz=${j.n[2].toFixed(2)})`
                    + ` with legs in order ${order.join('')} - it renders dark`);
            }
        }
    }
});

// 17. A TETRAHEDRAL CENTRE IS JOINED, NOT OVERLAPPED. Four sp3 directions sum
// to zero, so the sum of any three is exactly minus the fourth: the leg left
// out of a triple points back down that triple's mitre axis, straight through
// the bottom triangle. So three legs mitre exactly and a collar carries the
// fourth, instead of four boxes running into the atom and interpenetrating -
// which no depth sort can fix, there being no z-buffer. Expect one polygon at
// the top and a seven-triangle collar at the bottom, and every leg cut.
test('ligand sticks: a tetrahedral centre is joined', () => {
    const D = 0.866;                       // 1.5 A bonds
    const coords = [{ x: 0, y: 0, z: 0 },
        { x: D, y: D, z: D }, { x: D, y: -D, z: -D },
        { x: -D, y: D, z: -D }, { x: -D, y: -D, z: D }];
    const segs = [1, 2, 3, 4].map((j) => ({ type: 'L', idx1: 0, idx2: j }));
    const r = mkRenderer(coords, segs, { overlayState: { enabled: false } });
    r.positionTypes = ['L', 'L', 'L', 'L', 'L'];
    r.positionNames = ['LIG', 'LIG', 'LIG', 'LIG', 'LIG'];
    r.viewerState.extent = 4;
    r.objectsData.obj.maxExtent = 4;
    r._stickProbe = [];
    r._jointProbe = [];
    const { ctx } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    // 1 polygon closing the top + 7 collar triangles at the bottom
    if (r._jointProbe.length !== 8) {
        throw new Error(`${r._jointProbe.length} junction polygons - expected 8`
            + ' (1 top + 7 collar); the centre fell back to overlapping boxes');
    }
    // and every one of the four legs is cut back, none running raw to the atom
    const cut = r._stickProbe.filter((b) => b.mitre0 || b.mitre1).length;
    if (cut !== 4) {
        throw new Error(`${cut} of 4 legs were cut back at the junction`);
    }
});

// 18. A PLANAR FOUR-WAY IS MITRED, NOT COLLARED. A haem's iron carries four
// legs in one plane, and the mitre already solves that exactly - top polygon,
// bottom polygon, done. But such a centre also passes the COLLAR's own test
// with full marks: in a planar cross the three remaining legs sum to the
// opposite of the one left out, so the omitted leg reads as leaving straight
// down the axis (dot = 1). Gating the collar on "four legs" alone therefore
// stole every planar centre, and the iron came out visibly distorted. The
// collar is only for centres with NO plane.
test('ligand sticks: a planar four-way is mitred, not collared', () => {
    const R = 1.5;
    const coords = [{ x: 0, y: 0, z: 0 },
        { x: R, y: 0, z: 0 }, { x: 0, y: R, z: 0 },
        { x: -R, y: 0, z: 0 }, { x: 0, y: -R, z: 0 }];
    const segs = [1, 2, 3, 4].map((j) => ({ type: 'L', idx1: 0, idx2: j }));
    const r = mkRenderer(coords, segs, { overlayState: { enabled: false } });
    r.positionTypes = ['L', 'L', 'L', 'L', 'L'];
    r.positionNames = ['LIG', 'LIG', 'LIG', 'LIG', 'LIG'];
    r.viewerState.extent = 4;
    r.objectsData.obj.maxExtent = 4;
    r._jointProbe = [];
    const { ctx } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    // two polygons - one each end. Eight would mean a collar took it over.
    if (r._jointProbe.length !== 2) {
        throw new Error(`${r._jointProbe.length} junction polygons at a PLANAR`
            + ' four-way - expected 2 (top + bottom); 8 means the collar stole it');
    }
    // both polygons face along the plane normal, +z here, not off at an angle
    for (const j of r._jointProbe) {
        if (Math.abs(Math.abs(j.n[2]) - 1) > 1e-6) {
            throw new Error('a planar four-way\'s fill is not square to its own'
                + ` plane (nz=${j.n[2].toFixed(3)}) - the centre is distorted`);
        }
    }
});

// 19. A JUNCTION MUST NOT COME APART AT THICKNESS 0. The collar needs a solid
// to run to - at zero thickness the fourth leg's section is a LINE, not a
// square, and the band would be degenerate - but the THREE mitred legs are
// unaffected and must keep their joint. Gating the choice of triple on
// flatness, rather than only the collar, left the four-way to fall through to
// the old tilt bail: on GDP the two phosphates went from joined to overlapping
// boxes the moment the Thickness control reached 0.
test('ligand sticks: an sp3 junction survives thickness 0', () => {
    const D = 0.866;
    const coords = [{ x: 0, y: 0, z: 0 },
        { x: D, y: D, z: D }, { x: D, y: -D, z: -D },
        { x: -D, y: D, z: -D }, { x: -D, y: -D, z: D }];
    const segs = [1, 2, 3, 4].map((j) => ({ type: 'L', idx1: 0, idx2: j }));
    const run = (th) => {
        const r = mkRenderer(coords, segs, { overlayState: { enabled: false } });
        r.positionTypes = ['L', 'L', 'L', 'L', 'L'];
        r.positionNames = ['LIG', 'LIG', 'LIG', 'LIG', 'LIG'];
        r.viewerState.extent = 4;
        r.objectsData.obj.maxExtent = 4;
        r.cartoonThickness = th;
        r._thicknessUserSet = true;
        r._jointProbe = [];
        r._stickProbe = [];
        const { ctx } = mkCtx();
        cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
        return { joints: r._jointProbe.length,
            cut: r._stickProbe.filter((b) => b.mitre0 || b.mitre1).length };
    };
    const solid = run(0.5);
    const flat = run(0);
    if (solid.joints !== 8) {
        throw new Error(`solid: ${solid.joints} junction polygons - expected 8`);
    }
    // flat keeps the three-leg mitre: one polygon, and its three legs cut back
    if (flat.joints < 1) {
        throw new Error('at thickness 0 the sp3 junction lost its joint entirely'
            + ' - it fell back to overlapping boxes');
    }
    if (flat.cut < 3) {
        throw new Error(`at thickness 0 only ${flat.cut} legs were cut back`
            + ' - expected at least the three that mitre');
    }
});

// A flat slab is ONE quad but TWO possible faces, and they are not
// interchangeable: in the Richardson style a helix's inner face is tinted pale
// and its outer face is not. Picking the wrong one paints the inside of a helix
// in the outside's colour, which is what "if (showTop) showBot = false" did -
// on a curved piece oB straddles zero, both flags are set, and top won whichever
// way the piece actually faced. The face turned toward the viewer is the one to
// draw, so the choice goes by the mean facing.
test('flat helix keeps its pale inner face', () => {
    const coords = helix(22);
    const n = coords.length;
    const segs = bbSegs([[0, n - 1]]);
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        cartoonRichardson: true,
        cartoonThickness: 0.7,
        _getEffectiveColorMode: () => 'ss',
    });
    // record what actually gets painted
    const fills = [];
    const { ctx } = mkCtx();
    let poly = [];
    ctx.beginPath = () => { poly = []; };
    ctx.moveTo = (x, y) => poly.push([x, y]);
    ctx.lineTo = (x, y) => poly.push([x, y]);
    ctx.fill = () => {
        if (poly.length >= 3) {
            let A = 0;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                A += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
            }
            if (Math.abs(A / 2) > 0.01) fills.push(String(ctx.fillStyle));
        }
        poly = [];
    };
    cartoon.render(r, ctx, 600, 600, segs.map(() => COL));
    // the inner tint is a heavy 0.68 toward white, so an inner face is much
    // paler than the helix colour it came from - no need to know the palette
    let pale = 0;
    for (const c of fills) {
        const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c);
        if (!m) continue;
        if (Math.min(+m[1], +m[2], +m[3]) > 150) pale++;
    }
    console.log('   pale inner faces painted:', pale, '/', fills.length);
    // measured: 37 with the mean-facing rule, 3 with the top-wins one
    if (pale < 15) {
        throw new Error(`only ${pale} pale inner faces of ${fills.length} fills`
            + ' - the inner side of the helix is being painted in the outer'
            + " side's colour");
    }
});

// The gesture degrade decides on a measured frame cost. What it measures has to
// be a frame the gesture will actually draw - not the one that BUILT the
// structure, and not a single warm-up sample.
test('gesture budget ignores the cache-building frame', () => {
    const coords = helix(30);
    const segs = bbSegs([[0, coords.length - 1]]);
    const r = mkRenderer(coords, segs, { overlayState: { enabled: false } });
    const { ctx } = mkCtx();
    const draw = () => cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    draw();                       // first frame: builds sec/pairing/sheets
    const afterBuild = r._inkedMs ? r._inkedMs.length : 0;
    draw();                       // second frame: caches hot
    const afterWarm = r._inkedMs ? r._inkedMs.length : 0;
    console.log('   samples after build frame:', afterBuild,
        ' after warm frame:', afterWarm);
    if (afterBuild !== 0) {
        throw new Error('the cache-building frame was timed as a gesture frame'
            + ' - its cost is a one-off the drag never pays again');
    }
    if (afterWarm !== 1) {
        throw new Error(`warm frame recorded ${afterWarm} samples, expected 1`);
    }
});

test('gesture budget needs more than one sample to degrade', () => {
    const coords = helix(30);
    const segs = bbSegs([[0, coords.length - 1]]);
    const r = mkRenderer(coords, segs, { overlayState: { enabled: false } });
    const { ctx } = mkCtx();
    const draw = () => cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    draw();
    r.isDragging = true;
    // one hugely expensive sample, as a warm-up frame looks
    r._inkedMs = [9999];
    r._lastInkedMs = 9999;
    draw();
    if (r._inkSkipped) {
        throw new Error('degraded on a single sample - a drag\'s first inked'
            + ' frame is its most expensive, and once the ink is off nothing'
            + ' re-measures it');
    }
    // with a full history it must degrade
    r._inkedMs = [9999, 9999, 9999, 9999, 9999];
    r._lastInkedMs = 9999;
    draw();
    if (!r._inkSkipped) {
        throw new Error('did not degrade on five expensive samples');
    }
    // ... and while degraded it must keep measuring, so it can come back
    const bare = r._bareMs ? r._bareMs.length : 0;
    if (bare < 1) {
        throw new Error('nothing was measured while the outline was off - the'
            + ' estimate can never recover');
    }
});

process.exit(failures ? 1 : 0);
