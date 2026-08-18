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

// pleated beta strand: the zig-zag is what cartoon_flat_sheets exists to
// smooth out, so this is a chain flattening demonstrably MOVES
function strand(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({ x: 3.3 * i, y: (i % 2 ? 1.0 : -1.0), z: 0.4 * Math.sin(i * 0.6) });
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
    // The control, once the USER has moved it, is a thickness in Angstrom -
    // up to a CEILING. A stick is 0.3 A wide, so past about half an Angstrom it
    // stops reading as a stick and becomes a square rod as deep as it is wide,
    // while the ribbon is still thickening usefully. The ribbon has no such
    // limit; this is only about what a stick can carry.
    for (const th of [0.2, 0.35, 0.5]) {
        const got = 2 * halfT(mkBond(th, true));
        if (Math.abs(got - th) > 1e-6) {
            throw new Error(`thickness ${th} drew ${got.toFixed(3)} A`);
        }
    }
    for (const th of [0.6, 1.0, 1.5]) {
        const got = 2 * halfT(mkBond(th, true));
        if (Math.abs(got - 0.5) > 1e-6) {
            throw new Error(`thickness ${th} drew ${got.toFixed(3)} A - it should`
                + ` cap at 0.5 and leave the rest to the backbone`);
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

// ---- SIDE CHAINS ------------------------------------------------------------
// By the time the cartoon sees them, side-chain atoms are ordinary 'L'
// positions with ordinary bonds - _materialiseSidechains (viewer-mol.js) put
// them there, against the FILE's backbone. What the cartoon owns is the one
// thing that cannot be done earlier: it moves the backbone after that point,
// so it has to move them with it. That is what these pin down.

// two extra 'L' positions hanging off residue `pos`, in that residue's frame
function withSidechain(coords, pos) {
    const n = coords.length;
    const fr = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (!cartoon.localFrame((i) => coords[i], n, pos, fr, null)) {
        throw new Error('no frame at ' + pos);
    }
    const o = coords[pos];
    const map = new Map();
    const out = coords.slice();
    // CB, then CG further out
    for (const c of [[0.6, 1.2, 0.5], [1.1, 2.3, 1.0]]) {
        map.set(out.length, { anchor: pos, cx: c[0], cy: c[1], cz: c[2], owner: pos });
        out.push({
            x: o.x + fr[0] * c[0] + fr[3] * c[1] + fr[6] * c[2],
            y: o.y + fr[1] * c[0] + fr[4] * c[1] + fr[7] * c[2],
            z: o.z + fr[2] * c[0] + fr[5] * c[1] + fr[8] * c[2],
        });
    }
    return { coords: out, map };
}


test('a coloured residue paints the ribbon around it, not after it', () => {
    // colors[segIdx] is getAtomColor(idx1) - a segment takes its FIRST
    // residue's colour - so colouring residue 10 used to paint 10 to 11 and
    // leave 9 to 10 alone: a band the right width but half a residue late,
    // sitting between residues instead of around the one that was picked.
    // The interval is cut at its midpoint now, so each half takes its own
    // end's colour.
    const N = 20; const TARGET = 10;
    const RED = { r: 255, g: 0, b: 0 };
    const coords = strand(N);
    const segs = [];
    for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        _forceSec: 'E'.repeat(N),
        cartoonSheetFlat: 0,
        // hasColorOverrides reads this, and without it the split never runs
        objectsData: { obj: { maxExtent: 30,
            color: { type: 'advanced', value: { position: { [TARGET]: '#ff0000' } } } } },
        currentObjectName: 'obj',
        getColorOverride: (k) => (k === TARGET ? RED : null),
        getAtomColor: (k) => (k === TARGET ? RED : COL),
        _primProbe: null,
    });
    const { ctx } = mkCtx();
    // colors[] as viewer-mol builds it: the segment takes idx1's colour
    cartoon.render(r, ctx, 400, 400, segs.map((g) => (g.origIndex === TARGET ? RED : COL)));
    const prims = r._primProbe || [];
    let lo = Infinity; let hi = -Infinity;
    for (const p of prims) {
        if (p.kind !== 'rib' || !p.c || p.gs0 === undefined) continue;
        if (p.c.r !== 255 || p.c.g !== 0) continue;
        const len = (p.Lp ? p.Lp.length : 1) - 1;
        lo = Math.min(lo, p.gs0);
        hi = Math.max(hi, p.gs0 + (p.gsStep || 0) * len);
    }
    if (!isFinite(lo)) throw new Error('the coloured residue painted nothing');
    const width = hi - lo;
    const centre = (lo + hi) / 2;
    if (Math.abs(width - 1) > 0.2) {
        throw new Error('coloured band is ' + width.toFixed(2)
            + ' residues wide, expected 1');
    }
    // the whole point: centred ON the residue. Stations are integers, so an
    // odd subdivision count has none exactly at the midpoint and the boundary
    // lands on the nearest - within half a station. Half a RESIDUE out is the
    // old behaviour and is what this rejects.
    if (Math.abs(centre - TARGET) > 0.25) {
        throw new Error('coloured band is centred at ' + centre.toFixed(2)
            + ', residue ' + TARGET + ' was the one picked');
    }
});







test('the Line Width control does not reach contacts', () => {
    // It sets how heavy the BACKBONE is drawn. A contact is an annotation over
    // the structure rather than part of it, and one that grew and shrank with
    // the backbone stopped reading as a separate mark - the same reason a
    // ligand keeps its own width. What DOES size it is its own stored weight.
    const N = 12;
    const coords = strand(N);
    const segs = [];
    for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
    const contact = { type: 'C', idx1: 1, idx2: 9, origIndex: 1,
        contactIdx1: 1, contactIdx2: 9, contactWeight: 1.0, len: 26 };
    segs.push(contact);
    const widthOf = (lineWidth, weight) => {
        contact.contactWeight = weight;
        const r = mkRenderer(coords, segs, {
            overlayState: { enabled: false },
            lineWidth,
            residueNumbers: coords.map((_, i) => i + 1),
            _primProbe: null,
        });
        const { ctx } = mkCtx();
        cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
        const flats = (r._primProbe || []).filter((p) => p.kind === 'line' && p.flat);
        if (!flats.length) throw new Error('no contact was drawn');
        return flats[0].w;
    };
    // ...AND IT IS IN ANGSTROM, so it grows and shrinks with the structure. The
    // widths here are all `something * scale`, scale being pixels per Angstrom;
    // substituting a bare constant for baseLineWidthPixels drops that
    // conversion, and the contact comes out a couple of RAW pixels wide at any
    // zoom - which is what "too thin even at maximum" looked like.
    const atZoom = (zoom) => {
        contact.contactWeight = 1.0;
        const r = mkRenderer(coords, segs, {
            overlayState: { enabled: false },
            residueNumbers: coords.map((_, i) => i + 1),
            _primProbe: null,
        });
        r.viewerState.zoom = zoom;
        const { ctx } = mkCtx();
        cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
        const f2 = (r._primProbe || []).filter((p) => p.kind === 'line' && p.flat);
        if (!f2.length) throw new Error('no contact at zoom ' + zoom);
        return f2[0].w;
    };
    const z1 = atZoom(1); const z2 = atZoom(2);
    if (!(z2 > z1 * 1.8)) {
        throw new Error('the contact is ' + z1.toFixed(1) + ' px at zoom 1 and '
            + z2.toFixed(1) + ' at zoom 2 - its width is not in Angstrom, so it'
            + ' stays a few raw pixels however far you zoom in');
    }

    const thin = widthOf(2.0, 1.0);
    const fat = widthOf(6.0, 1.0);
    if (Math.abs(thin - fat) > 1e-6) {
        throw new Error('the contact went from ' + thin.toFixed(2) + ' to '
            + fat.toFixed(2) + ' with the Line Width control - it should keep'
            + ' its own width');
    }
    // its own weight DOES size it, or there would be no per-contact control
    const heavy = widthOf(2.0, 2.0);
    if (!(heavy > thin * 1.5)) {
        throw new Error('doubling the contact\'s own weight took it from '
            + thin.toFixed(2) + ' to ' + heavy.toFixed(2));
    }
});

test('a contact is cut into pieces so it sorts along its length', () => {
    // A contact joins two residues anywhere in the structure, so as ONE prim it
    // carries a single depth key across the whole span and sorts as though it
    // were all at its midpoint - passing in front of what it should go behind
    // and behind what it should cross in front of. Same reason a base plate is
    // cut: "as one quad a rung carries a single sort key across ~7 A".
    //
    // The fixture runs the contact THROUGH the backbone in depth, one end well
    // in front and the other well behind, which is the case a single key cannot
    // represent at all.
    const N = 20;
    const coords = strand(N);
    coords[2] = { x: coords[2].x, y: coords[2].y, z: 14 };
    coords[17] = { x: coords[17].x, y: coords[17].y, z: -14 };
    const segs = [];
    for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
    segs.push({ type: 'C', idx1: 2, idx2: 17, origIndex: 2,
        contactIdx1: 2, contactIdx2: 17, contactWeight: 1.0,
        contactColor: { r: 255, g: 255, b: 0 }, len: 50 });
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        residueNumbers: coords.map((_, i) => i + 1),
        _primProbe: null, _posProbe: null,
    });
    const { ctx, bad } = mkCtx();
    // this also covers the ink pass over a contact at all - no fixture here had
    // one before, and the first version of the cut crashed it
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    if (bad.length) throw new Error('bad styles: ' + bad[0]);
    const flats = (r._primProbe || []).filter((p) => p.kind === 'line' && p.flat);
    if (flats.length < 2) {
        throw new Error('the contact was drawn as ' + flats.length + ' prim(s) -'
            + ' one key for its whole span, so it sorts as if it were all at its'
            + ' midpoint');
    }
    // the pieces must sort where they really are: their keys have to span the
    // contact's actual depth range, not sit together at the middle
    const zs = flats.map((p) => p.z);
    const span = Math.max(...zs) - Math.min(...zs);
    if (span < 20) {
        throw new Error('the pieces span only ' + span.toFixed(1) + ' in depth,'
            + ' but the contact runs from +14 to -14 - they are not sorting'
            + ' along its length');
    }
    // A contact is drawn as a line but stands for something with thickness, so
    // its NEAR SURFACE sorts rather than its centre line. Joining two parts at
    // the same depth - two strands of a flat sheet above all - the centre lines
    // coincide and the order would be a coin toss.
    //
    // MEASURED AGAINST THE RESIDUE'S OWN DRAWN DEPTH, not against the piece's
    // own points. The bias lives IN the depth channel of those points, because
    // that channel is what the painter sorts on AND what the ink pass registers
    // as an occluder - biasing only the sort key left the two modelling
    // different solids. So differencing the key against its own pts now reads
    // zero by construction and would test nothing.
    // MEASURED ON A LIGAND-TO-LIGAND CONTACT. A contact between two RESIDUES is
    // also anchored onto their ribbon surfaces, and that displacement has a
    // depth component of its own which would be counted as bias. A ligand has
    // no ribbon, so its end stays exactly on its position and the only
    // difference left is the bias itself.
    const biasAt = (th) => {
        const cs = strand(6);
        cs.push({ x: 0, y: 8, z: 4 });          // two loose atoms, well apart
        cs.push({ x: 12, y: 8, z: -4 });
        const ty = new Array(6).fill('P'); ty.push('L'); ty.push('L');
        const sg = [];
        for (let i = 0; i + 1 < 6; i++) sg.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        sg.push({ type: 'C', idx1: 6, idx2: 7, origIndex: 6,
            contactIdx1: 6, contactIdx2: 7, contactWeight: 1.0, len: 50 });
        const rr = mkRenderer(cs, sg, {
            overlayState: { enabled: false }, positionTypes: ty,
            residueNumbers: cs.map((_, i) => i + 1),
            cartoonThickness: th, _primProbe: null, _posProbe: null,
        });
        const mm = mkCtx();
        cartoon.render(rr, mm.ctx, 400, 400, sg.map(() => COL));
        const ff = (rr._primProbe || []).filter((q) => q.kind === 'line' && q.flat);
        if (!ff.length) throw new Error('no ligand-ligand contact at ' + th);
        const hd = ff.find((q) => q.joints && q.joints[0]) || ff[0];
        return hd.pts[0][2] - (rr._posProbe[6] || cs[6]).z;
    };
    const b0 = biasAt(0.9);
    if (!(b0 > 0)) {
        throw new Error('the contact is keyed at its centre line (' + b0.toFixed(3)
            + ' from the residue it starts at) - joining two parts at the same'
            + ' depth it is then a coin toss whether it is drawn over them');
    }
    // ...by the SAME amount all along it, or the pieces reorder against each
    // other. Compared piece to piece against their own interpolated depth.
    const step = flats.map((p) => p.z - (p.pts[0][2] + p.pts[1][2]) / 2);
    for (const q of step) {
        if (Math.abs(q) > 1e-6) {
            throw new Error('a piece is keyed ' + q.toFixed(3) + ' off its own'
                + ' geometry - the bias belongs in the shared depth channel, not'
                + ' on individual keys, or the ink pass sees a different solid');
        }
    }
    // ...AND THE RIBBON WINS WHEN IT IS THICKER. A slab has a near surface too;
    // once it stands proud of the contact's, it genuinely is in front and
    // should cover it, which is what a thickness control is for.
    const thin = biasAt(0.4); const fat = biasAt(2.0);
    if (!(thin > 0)) throw new Error('a thin ribbon does not let the contact through');
    // exactly zero, not merely non-positive: a NEGATIVE bias would push the
    // contact behind where it actually is, which is worse than not biasing it
    if (Math.abs(fat) > 1e-9) {
        throw new Error('a ribbon thicker than the contact tube gives a bias of '
            + fat.toFixed(3) + ' - it should be exactly 0 there: positive lets'
            + ' the contact sort in front of a surface that is genuinely nearer,'
            + ' negative pushes it behind where it actually is');
    }
    if (!(thin > fat)) throw new Error('thickness does not reduce the bias');
    // ONLY THE TWO REAL ENDS CAP. A cap fills the gap an angled joint leaves,
    // and a contact is a straight line - a cap at an internal cut is a dark
    // tick across it. The slots are POSITIONAL, [0] the start point and [1] the
    // end, so a piece that caps one end has to say which; getting that wrong
    // capped the last piece at its start, which is an internal cut.
    let capKeys = 0;
    for (const p of flats) {
        if (!p.joints || p.joints.length !== 2) {
            throw new Error('a contact piece carries ' + (p.joints || []).length
                + ' joint slots - the ink pass reads both by position');
        }
        for (const k of p.joints) if (k) capKeys++;
    }
    if (capKeys !== 2) {
        throw new Error(capKeys + ' of the contact\'s ends ask for a cap -'
            + ' exactly the two real ends should, and the internal cuts none');
    }
    const withStart = flats.filter((p) => p.joints[0]);
    const withEnd = flats.filter((p) => p.joints[1]);
    if (withStart.length !== 1 || withEnd.length !== 1) {
        throw new Error('the cap is on ' + withStart.length + ' start(s) and '
            + withEnd.length + ' end(s) - it belongs on one of each');
    }
    // NOT ASSERTED: that no stray cap is drawn. `joints` slots are left EMPTY
    // at internal cuts and the registration loop skips them, because an empty
    // slot must not become a Map key - `undefined` and `null` are perfectly
    // good ones, so every prim's empty slots would collide on a single key and
    // whichever landed lowest would draw a cap. That guard is right, but at
    // most one stray cap could result and no fixture here reproduces it, so
    // nothing below would fail if it were removed. Said rather than dressed up
    // as coverage.
});

test('a side chain\'s end square lies flat on the backbone', () => {
    // A stick's end section is perpendicular to the STICK, which where it meets
    // the ribbon is the wrong plane: unless the side chain leaves exactly along
    // the face normal, that cap cuts down through the surface on one side and
    // lifts off it on the other. No amount of placing or rolling the box makes
    // that edge sit flat - what lies flat is a section in the RIBBON's plane,
    // so the corners are slid along the bond until they reach it.
    //
    // TWO PASSES. The first exists only to read the ribbon's frame, because a
    // side chain aimed at a guessed normal is the whole trap here: aimed wrong
    // it leaves nearly ALONG the surface, the cut declines as unsolvable (the
    // corners would travel arbitrarily far), and the test passes having
    // measured nothing. Real side chains leave at |axis.normal| ~ 0.6; only
    // about a tenth fall below the 0.35 floor.
    const N = 14; const OWNER = 6;
    const base = strand(N);
    const build = (extra) => {
        const coords = base.concat(extra);
        const n = coords.length;
        const segs = [];
        for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        const types = new Array(n).fill('P');
        const map = new Map();
        // one segment per atom handed in: ONE makes a lone bond, two or more
        // make a run, and a run shares one section across the whole path
        for (let k = 0; k < extra.length; k++) {
            segs.push({ type: 'L', idx1: k === 0 ? OWNER : N + k - 1,
                idx2: N + k, origIndex: k === 0 ? OWNER : N + k - 1 });
            types[N + k] = 'L';
            map.set(N + k, { owner: OWNER });
        }
        return mkRenderer(coords, segs, {
            overlayState: { enabled: false },
            positionTypes: types,
            _forceSec: 'E'.repeat(N) + 'C'.repeat(extra.length),
            cartoonThickness: 0.9,
            sidechainMap: extra.length ? map : null,
            _sideProbe: null, _posProbe: null, _stickProbe: [],
        });
    };
    const draw = (r) => {
        const { ctx, bad } = mkCtx();
        cartoon.render(r, ctx, 400, 400, r.segmentIndices.map(() => COL));
        if (bad.length) throw new Error('bad styles: ' + bad[0]);
        return r;
    };
    const p1 = draw(build([]));
    const side = p1._sideProbe[OWNER]; const pos = p1._posProbe;
    if (!side || !pos) throw new Error('no frame recorded for the owning residue');
    const pA = pos[OWNER - 1]; const pB = pos[OWNER + 1];
    let t = [pB.x - pA.x, pB.y - pA.y, pB.z - pA.z];
    const tl = Math.hypot(t[0], t[1], t[2]);
    t = [t[0] / tl, t[1] / tl, t[2] / tl];
    let nr = [t[1] * side[2] - t[2] * side[1], t[2] * side[0] - t[0] * side[2],
        t[0] * side[1] - t[1] * side[0]];
    const nl = Math.hypot(nr[0], nr[1], nr[2]);
    nr = [nr[0] / nl, nr[1] / nl, nr[2] / nl];
    const o = pos[OWNER];
    const atom = (k) => ({
        x: o.x + nr[0] * 1.5 * k + t[0] * 1.2 * k,
        y: o.y + nr[1] * 1.5 * k + t[1] * 1.2 * k,
        z: o.z + nr[2] * 1.5 * k + t[2] * 1.2 * k,
    });
    // THE BOND KEEPS ITS OWN AXIS AND THE BACKBONE CUTS IT. The stick runs all
    // the way to the CA; the slab's surface takes a slice off the end. So the
    // cut has to do two things: land in the ribbon's plane, and land FURTHER
    // ALONG THE BOND as the ribbon thickens - a thicker ribbon swallows more of
    // it. Moving the end point out to the surface instead, as an earlier
    // version did, is a shift along the face normal - sideways to the bond - so
    // the stick leans off the axis it is supposed to represent.
    let lastAlong = -Infinity;
    for (const th of [0.3, 0.6, 0.9, 1.2]) {
        const r2 = build([atom(1), atom(2)]);
        r2.cartoonThickness = th;
        draw(r2);
        const bx = (r2._stickProbe || []).find((b) => b);
        if (!bx) throw new Error('no stick box was built at thickness ' + th);
        // in the ribbon's plane: the four corners must not spread along its normal
        const d = bx.W.slice(0, 4).map((c) => c[0] * nr[0] + c[1] * nr[1] + c[2] * nr[2]);
        const spread = Math.max(...d) - Math.min(...d);
        if (spread > 1e-6) {
            throw new Error('at thickness ' + th + ' the end square departs from'
                + ' the ribbon surface by ' + spread.toFixed(3) + ' A - it is cut'
                + ' perpendicular to the stick instead of into the ribbon plane,'
                + ' so one edge digs in and the opposite one lifts off');
        }
        // ...and further along the bond each time
        const ca = pos[OWNER]; const cb = atom(1);
        let ax = [cb.x - ca.x, cb.y - ca.y, cb.z - ca.z];
        const al = Math.hypot(ax[0], ax[1], ax[2]);
        ax = [ax[0] / al, ax[1] / al, ax[2] / al];
        const ctr = [0, 1, 2].map((k) => bx.W.slice(0, 4)
            .reduce((acc, c) => acc + c[k], 0) / 4);
        const along = (ctr[0] - ca.x) * ax[0] + (ctr[1] - ca.y) * ax[1]
            + (ctr[2] - ca.z) * ax[2];
        if (!(along > lastAlong)) {
            throw new Error('at thickness ' + th + ' the cut fell '
                + along.toFixed(3) + ' A along the bond, no further than the'
                + ' thinner ribbon before it - the backbone is not cutting the'
                + ' stick, the stick is being moved');
        }
        lastAlong = along;
    }
});

test('the end square is drawn, at every angle it leaves at', () => {
    // The cap is the square lying on the backbone, so drawing it is what closes
    // the box - drop it and you see in through the end. But that is only true
    // once it has been cut INTO the ribbon's plane. Where the bond runs too
    // nearly along the surface to solve, the cap reverts to perpendicular - a
    // lid at the wrong angle over the join - and is suppressed instead.
    //
    // Both cases are built from the same fixture, aimed differently: along the
    // ribbon's own face normal (solvable) and along its surface (not). The
    // first pass exists only to read that frame.
    const N = 14; const OWNER = 6;
    const base = strand(N);
    const build = (extra) => {
        const coords = base.concat(extra);
        const n = coords.length;
        const segs = [];
        for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        const types = new Array(n).fill('P');
        const map = new Map();
        if (extra.length) {
            segs.push({ type: 'L', idx1: OWNER, idx2: N, origIndex: OWNER });
            segs.push({ type: 'L', idx1: N, idx2: N + 1, origIndex: N });
            types[N] = 'L'; types[N + 1] = 'L';
            map.set(N, { owner: OWNER }); map.set(N + 1, { owner: OWNER });
        }
        return mkRenderer(coords, segs, {
            overlayState: { enabled: false },
            positionTypes: types,
            _forceSec: 'E'.repeat(N) + (extra.length ? 'CC' : ''),
            cartoonThickness: 0.9,
            sidechainMap: extra.length ? map : null,
            _sideProbe: null, _posProbe: null, _primProbe: null,
        });
    };
    const draw = (r) => {
        const { ctx, bad } = mkCtx();
        cartoon.render(r, ctx, 400, 400, r.segmentIndices.map(() => COL));
        if (bad.length) throw new Error('bad styles: ' + bad[0]);
        return r;
    };
    const p1 = draw(build([]));
    const side = p1._sideProbe[OWNER]; const pos = p1._posProbe;
    const pA = pos[OWNER - 1]; const pB = pos[OWNER + 1];
    let t = [pB.x - pA.x, pB.y - pA.y, pB.z - pA.z];
    const tl = Math.hypot(t[0], t[1], t[2]);
    t = [t[0] / tl, t[1] / tl, t[2] / tl];
    let nr = [t[1] * side[2] - t[2] * side[1], t[2] * side[0] - t[0] * side[2],
        t[0] * side[1] - t[1] * side[0]];
    const nl = Math.hypot(nr[0], nr[1], nr[2]);
    nr = [nr[0] / nl, nr[1] / nl, nr[2] / nl];
    const o = pos[OWNER];
    // `k` weights the face normal against the surface direction: 1.5 leaves
    // steeply (as a real side chain does), 0.05 almost flat.
    const caps = (steep) => {
        const atom = (m) => ({
            x: o.x + nr[0] * steep * m + t[0] * 1.2 * m,
            y: o.y + nr[1] * steep * m + t[1] * 1.2 * m,
            z: o.z + nr[2] * steep * m + t[2] * 1.2 * m,
        });
        const r = draw(build([atom(1), atom(2)]));
        const faces = (r._primProbe || []).filter((p) => p.kind === 'stickFace');
        if (!faces.length) throw new Error('no side-chain sticks were drawn');
        // the cap at the ribbon end: the face whose corners are all nearest the
        // backbone along the normal
        let capDrawn = null; let best = Infinity;
        for (const p of faces) {
            let d = 0;
            for (const q of p.q) d += q[0] * nr[0] + q[1] * nr[1] + q[2] * nr[2];
            d /= p.q.length;
            const off = d - (o.x * nr[0] + o.y * nr[1] + o.z * nr[2]);
            if (off < best) { best = off; capDrawn = p.draw; }
        }
        return capDrawn;
    };
    // BOTH ORIENTATIONS. A cap facing away from the viewer is backface-culled
    // whatever else is true, so testing one direction alone cannot tell culling
    // apart from suppression: what is asserted is that the cap is drawn from
    // the side it faces.
    //
    // At EVERY angle, steep or shallow. There is no longer a floor below which
    // the cut is skipped - a shallow side chain gets the same treatment as a
    // steep one, which is the point of removing it.
    for (const steep of [1.5, 0.35, 0.05]) {
        if (!(caps(steep) || caps(-steep))) {
            throw new Error('at ' + steep + ' the end square is drawn from'
                + ' neither side - the box is left open and you see in through'
                + ' the end');
        }
    }
    // AND IT MUST NOT RUN AWAY. With no angle floor left, a bond running very
    // nearly along the surface meets its plane only very far off, so the corner
    // slide is bounded. Unbounded, those corners go to infinity and take the
    // box, its silhouette and the depth sort with them - not a shallower joint
    // but a broken frame. 0.002 is far past anything real; the median side
    // chain leaves at 0.6.
    // Every angle a side chain could leave at, down to far past anything real:
    // the median is 0.6 and the shallowest tenth sit near 0.3.
    for (const SHALLOW of [0.3, 0.15, 0.05, 0.02, 0.002]) {
        const atom = (m) => ({
            x: o.x + nr[0] * SHALLOW * m + t[0] * 1.5 * m,
            y: o.y + nr[1] * SHALLOW * m + t[1] * 1.5 * m,
            z: o.z + nr[2] * SHALLOW * m + t[2] * 1.5 * m,
        });
        // WORLD space, from the stick probe. A prim's own corners are
        // PROJECTED - screen pixels - and comparing those to an Angstrom
        // position reads ~379 at every angle, normal ones included, which is
        // the canvas rather than the geometry. That mistake looked exactly like
        // a blow-up.
        const r = draw(build([atom(1), atom(2)]));
        let far = 0;
        for (const bx2 of (r._stickProbe || [])) {
            if (!bx2) continue;
            for (const c of bx2.W) {
                if (!isFinite(c[0]) || !isFinite(c[1]) || !isFinite(c[2])) {
                    throw new Error('a shallow side chain produced a non-finite'
                        + ' corner at ' + SHALLOW);
                }
                far = Math.max(far, Math.hypot(c[0] - o.x, c[1] - o.y, c[2] - o.z));
            }
        }
        // the side chain reaches ~3 A; anything far past that is the cut
        // stretching the section instead of ending it
        if (far > 8) {
            throw new Error('at ' + SHALLOW + ' a corner landed ' + far.toFixed(1)
                + ' A from the residue - the slide to the ribbon plane is'
                + ' running away');
        }
    }
});

// NO TEST FOR THE SECTION ROLL. There was one, and it stopped being able to
// fail: the roll hint (bd.rollN, taken as the section's thickness axis) is
// overridden by the SWEEP for any side chain of two bonds or more - "one
// section per station, shared by both bonds, frees the roll" - and for a lone
// bond it lands on the same answer as the fallback it replaces. Since the end
// square is now cut into the ribbon's plane, the joint is flush whatever the
// roll does, so the hint no longer carries the property it was added for. It is
// left in place because it costs nothing and may still help a lone bond, but
// nothing here verifies it, and a test that cannot fail is worse than none.

test('a side chain leaves through the ribbon face it is on', () => {
    // A side chain used to start at the CA, which is the CENTRE of the slab, so
    // the two solids interpenetrated and no paint order was right for both -
    // seen along a sheet the side chains printed over the backbone. It now
    // leaves from the ribbon's surface, the way a base plate does. Which of the
    // two faces is decided by where the side chain actually is: a fixed sign
    // would send half of them out through the back.
    const N = 14; const OWNER = 6;
    const run = (sign) => {
        const coords = strand(N);
        coords.push({ x: coords[OWNER].x, y: coords[OWNER].y, z: sign * 1.5 });
        coords.push({ x: coords[OWNER].x, y: coords[OWNER].y, z: sign * 3.0 });
        const n = coords.length;
        const segs = [];
        for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        segs.push({ type: 'L', idx1: OWNER, idx2: N, origIndex: OWNER });
        segs.push({ type: 'L', idx1: N, idx2: N + 1, origIndex: N });
        const types = new Array(n).fill('P'); types[N] = 'L'; types[N + 1] = 'L';
        const r = mkRenderer(coords, segs, {
            overlayState: { enabled: false },
            positionTypes: types,
            _forceSec: 'E'.repeat(N) + 'CC',
            // a REAL thickness: at 0 the ribbon is a plane, there is no surface
            // to start from, and this would pass without testing anything
            cartoonThickness: 0.9,
            sidechainMap: new Map([[N, { owner: OWNER }], [N + 1, { owner: OWNER }]]),
            _primProbe: null, _posProbe: null,
        });
        const { ctx, bad } = mkCtx();
        cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
        if (bad.length) throw new Error('bad styles: ' + bad[0]);
        const faces = (r._primProbe || []).filter((p) => p.kind === 'stickFace');
        if (!faces.length) throw new Error('no side-chain sticks were drawn');
        // HOW FAR THE STICK REACHES BACK PAST THE BACKBONE. Averaging over the
        // corners tells you nothing here - it is dominated by the atom
        // positions, which the fixture chose - so what is measured is the
        // extreme corner on the far side. A stick that starts at the ribbon's
        // SURFACE barely crosses the centre line; one that starts at the CA
        // reaches a whole half-width past it, which is the interpenetration
        // that had no correct paint order.
        const o = r._posProbe[OWNER];
        let lo2 = Infinity; let hi2 = -Infinity;
        for (const p of faces) {
            for (const q of p.q) {
                lo2 = Math.min(lo2, q[2] - o.z);
                hi2 = Math.max(hi2, q[2] - o.z);
            }
        }
        return { lo: lo2, hi: hi2 };
    };
    const up = run(1); const down = run(-1);
    // it must REACH its atoms, so the far extreme is well out
    if (!(up.hi > 1)) throw new Error('the +z side chain does not reach its atoms');
    if (!(down.lo < -1)) throw new Error('the -z side chain does not reach its atoms');
    // ...and stay on that side: a stick drawn from the +z face down to a -z
    // atom would span the whole slab
    if (!(up.lo > -1)) throw new Error('the +z side chain spans the backbone');
    if (!(down.hi < 1)) throw new Error('the -z side chain spans the backbone');
    // What is NOT asserted: how far back the box reaches. The stick starts on
    // the ribbon's surface and its box straddles that surface, deliberately -
    // overlapping the slab is what makes the joint look attached, and the
    // hidden-line pass removes whatever ends up inside. So the extreme corner
    // sits a hair either side of the centre line whether the offset is applied
    // or not (-0.064 against 0.000 on this fixture), and asserting on it would
    // be asserting on noise. The side the stick is on is the part that carries
    // meaning, and it is the part checked above.
});

test('side chains keep the original CA through sheet flattening', () => {
    // Flattening takes the pleat out of a strand so the ribbon reads cleanly.
    // The pleat is real chemistry - it decides which FACE of the sheet each
    // side chain points at, and consecutive residues alternate - so rebuilding
    // a side chain in the flattened frame turns it away from where the molecule
    // puts it. Measured on 1TIM that error runs to a median of 73 deg and a
    // maximum of 154: side chains on the wrong face of the sheet. The atoms
    // stay put instead, and the ribbon is the thing that has been idealised.
    const base = strand(14);
    const { coords, map } = withSidechain(base, 6);
    const segs = bbSegs([[0, 13]]);
    segs.push({ type: 'L', idx1: 6, idx2: 14 });
    segs.push({ type: 'L', idx1: 14, idx2: 15 });
    const types = new Array(coords.length).fill('P');
    types[14] = 'L'; types[15] = 'L';
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        positionTypes: types,
        sidechainMap: map,
        cartoonSheetFlat: 1.0,
        _forceSec: 'E'.repeat(14) + 'CC',
        _posProbe: null,
    });
    const { ctx, bad } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    if (bad.length) throw new Error('bad styles: ' + bad[0]);
    const pos = r._posProbe;
    if (!pos) throw new Error('no posProbe');
    const moved = Math.hypot(pos[6].x - base[6].x, pos[6].y - base[6].y,
        pos[6].z - base[6].z);
    if (moved < 0.05) {
        throw new Error('flattening did not move the residue, so this proves'
            + ' nothing (moved ' + moved.toFixed(3) + ' A)');
    }
    // the side-chain atoms must be exactly where they were placed
    for (const idx of [14, 15]) {
        const d = Math.hypot(pos[idx].x - coords[idx].x,
            pos[idx].y - coords[idx].y, pos[idx].z - coords[idx].z);
        if (d > 1e-9) {
            throw new Error('side-chain atom ' + idx + ' was moved ' + d.toFixed(3)
                + ' A by flattening - its direction is measured geometry, not'
                + ' something the ribbon gets to idealise');
        }
    }
    // ...which necessarily means it no longer sits on the drawn ribbon, by
    // exactly the flattening distance. That offset is the deliberate cost.
    const offset = Math.hypot(pos[14].x - pos[6].x, pos[14].y - pos[6].y,
        pos[14].z - pos[6].z);
    const trueBond = Math.hypot(coords[14].x - base[6].x,
        coords[14].y - base[6].y, coords[14].z - base[6].z);
    if (Math.abs(offset - trueBond) > moved + 1e-6) {
        throw new Error('offset from the drawn CA is larger than the flattening'
            + ' distance can explain');
    }
});

test('side chains cost nothing when no residue asks for them', () => {
    // no sidechainMap: the pass must not run, and posArr must not be copied
    const coords = strand(14);
    const segs = bbSegs([[0, 13]]);
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        _forceSec: 'E'.repeat(14),
        _posProbe: null,
    });
    const { ctx, bad } = mkCtx();
    cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
    if (bad.length) throw new Error('bad styles: ' + bad[0]);
    if (!r._posProbe) throw new Error('no posProbe');
});

test('the cut uses the surface the side chain leaves through', () => {
    // A slab has two FACES at the half-thickness and two SIDES at the
    // half-width, and a side chain leaves through whichever one it points at.
    //
    // Cutting every stick against the FACE is very nearly right - side chains
    // do come out of the faces wherever the ribbon's roll means something - and
    // wrong where it does not. Measured over 21,274 CA-CB bonds: no helix
    // residue and 2 strand residues leave edge-on, against 9.5% of LOOP
    // residues, whose roll is a free choice made for smoothness. Edge-on the
    // corner slide (offset)/(d.n) runs away - 0.37/|d.n| Angstrom, which at the
    // observed minimum of 0.0004 is 1009 A. Those were the long lines across
    // the screen.
    //
    // THE ASSERTION IS THE OFFSET, not the cut plane's direction. A square cut
    // into the side plane and a square the code DECLINED to cut both end up
    // with their normal along the bond, so a direction test cannot tell the fix
    // from the bug - a first draft of this test passed under every mutation
    // below for exactly that reason. Where the square sits separates all three:
    // at the half-thickness (face), at the half-width (side), or on the CA
    // itself (declined, and drawn perpendicular).
    const N = 14; const OWNER = 6; const TH = 0.9;
    // Read the ribbon's own frame first: a side chain aimed at a guessed normal
    // is the trap this area keeps falling into, since aimed wrong it lands
    // edge-on by accident and the test measures something else entirely.
    const F = (() => {
        const coords = strand(N);
        const segs = [];
        for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        const r = mkRenderer(coords, segs, {
            overlayState: { enabled: false },
            _forceSec: 'E'.repeat(N), cartoonThickness: TH,
            _sideProbe: null, _posProbe: null,
        });
        cartoon.render(r, mkCtx().ctx, 400, 400, segs.map(() => COL));
        const sv = r._sideProbe[OWNER]; const pos = r._posProbe;
        if (!sv || !pos) throw new Error('no ribbon frame recorded');
        const pA = pos[OWNER - 1]; const pB = pos[OWNER + 1];
        let t = [pB.x - pA.x, pB.y - pA.y, pB.z - pA.z];
        const tl = Math.hypot(t[0], t[1], t[2]); t = t.map((q) => q / tl);
        let nr = [t[1] * sv[2] - t[2] * sv[1], t[2] * sv[0] - t[0] * sv[2],
            t[0] * sv[1] - t[1] * sv[0]];
        const nl = Math.hypot(nr[0], nr[1], nr[2]); nr = nr.map((q) => q / nl);
        const svl = Math.hypot(sv[0], sv[1], sv[2]);
        return { t, n: nr, s: sv.map((q) => q / svl), o: pos[OWNER] };
    })();

    const L = 1.53;                              // a real CA-CB bond
    // one side chain, leaving at `deg` from the face normal toward the side
    // vector, plus an optional lean ALONG the chain
    const run = (deg, alongT) => {
        const th = deg * Math.PI / 180;
        const c = Math.cos(th); const s = Math.sin(th); const g = alongT || 0;
        let dir = [0, 1, 2].map((k) => F.n[k] * c + F.s[k] * s + F.t[k] * g);
        const dl = Math.hypot(dir[0], dir[1], dir[2]); dir = dir.map((q) => q / dl);
        const coords = strand(N);
        coords.push({ x: F.o.x + dir[0] * L, y: F.o.y + dir[1] * L, z: F.o.z + dir[2] * L });
        const n = coords.length;
        const segs = [];
        for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        segs.push({ type: 'L', idx1: OWNER, idx2: N, origIndex: OWNER });
        const types = new Array(n).fill('P'); types[N] = 'L';
        const r = mkRenderer(coords, segs, {
            overlayState: { enabled: false }, positionTypes: types,
            _forceSec: 'E'.repeat(N) + 'C', cartoonThickness: TH,
            sidechainMap: new Map([[N, { owner: OWNER }]]),
            _stickProbe: [], _posProbe: null,
        });
        const { ctx, bad } = mkCtx();
        cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
        if (bad.length) throw new Error('bad styles: ' + bad[0]);
        const bx = (r._stickProbe || [])[0];
        if (!bx) throw new Error('no stick box was built at ' + deg + ' deg');
        const ca = r._posProbe[OWNER]; const tip = coords[N];
        const q = bx.W.slice(0, 4);          // the CA-end square
        // ...and does any corner run away from the bond it is cutting?
        let travel = 0;
        for (const w of bx.W) {
            travel = Math.max(travel, Math.min(
                Math.hypot(w[0] - ca.x, w[1] - ca.y, w[2] - ca.z),
                Math.hypot(w[0] - tip.x, w[1] - tip.y, w[2] - tip.z)));
        }
        // the square's own plane, to say which surface it lies in
        const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]];
        const e2 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
        let nq = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0]];
        const nql = Math.hypot(nq[0], nq[1], nq[2]);
        nq = nql > 1e-9 ? nq.map((x) => x / nql) : [0, 0, 0];
        const onFace = Math.abs(nq[0] * F.n[0] + nq[1] * F.n[1] + nq[2] * F.n[2]);
        // HOW FAR OUT THE SQUARE'S PLANE SITS, perpendicular - which is the
        // surface's own half-extent and nothing else. Not the mean distance to
        // its corners: an oblique cut stretches the square along the bond, so
        // that number grows with the angle and says nothing about which surface
        // was used.
        const off = Math.abs((q[0][0] - ca.x) * nq[0] + (q[0][1] - ca.y) * nq[1]
            + (q[0][2] - ca.z) * nq[2]);
        return { off, travel, onFace };
    };

    // The half-thickness comes from the test's OWN input, not from the code
    // under test: cartoonThickness is a total, so the face sits at half of it.
    const halfT = TH / 2;
    const isFaceCut = (x) => Math.abs(x.off - halfT) < 0.05 && x.onFace > 0.9;

    // 1. STRAIGHT OUT THROUGH THE FACE. The common case, and the one that has
    //    to stay flush.
    const face = run(0, 0);
    if (!isFaceCut(face)) {
        throw new Error('a side chain leaving straight through the face was not'
            + ' cut into the face plane (square sits ' + face.off.toFixed(2)
            + ' A from the CA, normal . face = ' + face.onFace.toFixed(2)
            + '; the face is at ' + halfT + ' A)');
    }

    // 2. A HELIX-LIKE 55 DEGREES, which is where the two candidate rules
    //    DISAGREE. This ribbon is 1.1 A half-wide and 0.45 A half-thick, so a
    //    bond at 55 deg leans more toward the side vector (|d.s| = 0.82 against
    //    |d.n| = 0.57) while still exiting through the FACE, which is 2.4x
    //    nearer. Picking the plane the bond meets most squarely - the obvious
    //    fix, and the one that shipped for an afternoon - cuts this against the
    //    side, moving the joint out to the ribbon's edge. Helix side chains
    //    leave at a median 50 deg, so that is most of a helix.
    const lean = run(55, 0);
    if (!isFaceCut(lean)) {
        throw new Error('a side chain at 55 deg was cut against the ribbon\'s'
            + ' SIDE (square sits ' + lean.off.toFixed(2) + ' A from the CA,'
            + ' normal . face = ' + lean.onFace.toFixed(2) + ') - it leans that'
            + ' way but exits through the face, which is far nearer. This is'
            + ' what stopped helix side chains sitting flush');
    }

    // 3. EDGE-ON. 88 rather than 90 degrees: at exactly 90 the face cut divides
    //    by ~0 and declines on its own, so the bug never fired.
    const edge = run(88, 0);
    if (!(edge.off > halfT + 0.4)) {
        throw new Error('a side chain leaving through the ribbon\'s EDGE was not'
            + ' cut into the side plane - its square sits ' + edge.off.toFixed(2)
            + ' A from the CA, which is the face at ' + halfT + ' A, or the CA'
            + ' itself if the cut was declined');
    }
    if (!(edge.travel <= L)) {
        throw new Error('an edge-on side chain slid a box corner '
            + edge.travel.toFixed(1) + ' A from its own atoms, past the ' + L
            + ' A bond it is cutting - the runaway that drew long lines');
    }

    // 4. ALONG THE CHAIN, where NEITHER surface is met squarely and no choice
    //    of plane helps. The cut has to be declined rather than made badly, and
    //    that is the travel guard's job - without it the corners slide 4.5 A.
    const skew = run(6, 8);
    if (!(skew.travel <= L)) {
        throw new Error('a side chain running along the chain slid a corner '
            + skew.travel.toFixed(1) + ' A from its atoms - it meets no surface'
            + ' squarely, so the cut must be declined, not made anyway');
    }
});

test('a contact runs CA to CA and the ribbon crops it', () => {
    // A contact was drawn CA to CA with nothing removed, and a CA is the CENTRE
    // of the slab, so both ends began buried in the ribbon they point at - line
    // and slab interpenetrate, no paint order is right for both, and the
    // contact reads as passing THROUGH the backbone.
    //
    // The line keeps its full CA-to-CA axis and each end is cut back to where
    // it leaves the slab, the same thing the backbone does to a side chain.
    // Cropping along its own direction cannot tilt it off the two residues it
    // names, which is the property an ANCHOR at the surface point would lose -
    // that was tried, and displaced each end by up to the ribbon's half-extent,
    // about 23 degrees of bearing over a 6 A contact.
    const N = 20; const OWN = 6; const LEN = 8;
    // TILTED OUT OF THE SCREEN PLANE. A flat strand's side vector points very
    // nearly along the view axis, so a sideways displacement of the end - which
    // is exactly what distinguishes an anchor from a crop - projects to under
    // a third of a pixel and hides inside any sane tolerance.
    const tilt = (q) => {
        const c = Math.cos(0.9); const sn = Math.sin(0.9);
        return { x: q.x, y: q.y * c - q.z * sn, z: q.y * sn + q.z * c };
    };
    const bent = () => strand(N).map(tilt);
    const F = (() => {
        const coords = bent();
        const segs = [];
        for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        const r = mkRenderer(coords, segs, {
            overlayState: { enabled: false }, _forceSec: 'E'.repeat(N),
            cartoonThickness: 0.9, _sideProbe: null, _posProbe: null,
        });
        cartoon.render(r, mkCtx().ctx, 400, 400, segs.map(() => COL));
        const sv = r._sideProbe[OWN]; const pos = r._posProbe;
        if (!sv || !pos) throw new Error('no ribbon frame recorded');
        let t = [pos[OWN + 1].x - pos[OWN - 1].x, pos[OWN + 1].y - pos[OWN - 1].y,
            pos[OWN + 1].z - pos[OWN - 1].z];
        const tl = Math.hypot(t[0], t[1], t[2]); t = t.map((q) => q / tl);
        let n = [t[1] * sv[2] - t[2] * sv[1], t[2] * sv[0] - t[0] * sv[2],
            t[0] * sv[1] - t[1] * sv[0]];
        const nl = Math.hypot(n[0], n[1], n[2]); n = n.map((q) => q / nl);
        const svl = Math.hypot(sv[0], sv[1], sv[2]);
        return { n, s: sv.map((q) => q / svl), o: pos[OWN] };
    })();

    // `deg` is measured off the face normal toward the side vector, so 0 leaves
    // through the FACE and 90 through the EDGE - and the crop has to come from
    // whichever of the two the line actually reaches.
    const aim = (deg, thickness, ss) => {
        const th = deg * Math.PI / 180;
        const dir = [0, 1, 2].map((k) => F.n[k] * Math.cos(th) + F.s[k] * Math.sin(th));
        const coords = bent();
        coords.push({ x: F.o.x + dir[0] * LEN, y: F.o.y + dir[1] * LEN,
            z: F.o.z + dir[2] * LEN });
        const types = new Array(N).fill('P'); types.push('L');
        const segs = [];
        for (let i = 0; i + 1 < N; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
        segs.push({ type: 'C', idx1: OWN, idx2: N, origIndex: OWN,
            contactIdx1: OWN, contactIdx2: N, contactWeight: 1.0, len: 50 });
        const r = mkRenderer(coords, segs, {
            overlayState: { enabled: false }, positionTypes: types,
            residueNumbers: coords.map((_, i) => i + 1),
            _forceSec: (ss || 'E').repeat(N) + 'C', cartoonThickness: thickness,
            _primProbe: null,
        });
        const { ctx, bad } = mkCtx();
        cartoon.render(r, ctx, 400, 400, segs.map(() => COL));
        if (bad.length) throw new Error('bad styles: ' + bad[0]);
        const flats = (r._primProbe || []).filter((p) => p.kind === 'line' && p.flat);
        const head = flats.find((p) => p.joints && p.joints[0]);
        const tail = flats.find((p) => p.joints && p.joints[1]);
        if (!head || !tail) throw new Error('the contact drew no end pieces');
        // Projected pixels throughout, compared only against projected pixels.
        const p0 = [r.screenX[OWN], r.screenY[OWN]];
        const p1 = [r.screenX[N], r.screenY[N]];
        const vx = p1[0] - p0[0]; const vy = p1[1] - p0[1];
        const vv = vx * vx + vy * vy;
        const st = head.pts[0]; const en = tail.pts[tail.pts.length - 1];
        // how far along the CA->partner line the drawn end sits, as a fraction,
        // and how far OFF that line it strays
        const along = (q) => ((q[0] - p0[0]) * vx + (q[1] - p0[1]) * vy) / vv;
        const off = (q) => Math.abs((q[0] - p0[0]) * vy - (q[1] - p0[1]) * vx)
            / Math.sqrt(vv);
        return { crop: along(st) * LEN, ligand: 1 - along(en),
            off: Math.max(off(st), off(en)) };
    };

    const face = aim(0, 0.9);
    // 1. THE END LEAVES THE CA.
    if (!(face.crop > 0.05)) {
        throw new Error('the contact still starts on the CA (' + face.crop.toFixed(2)
            + ' A along its length) - it begins at the centre of the slab');
    }
    // 2. AND STAYS ON THE CA-TO-CA LINE. This is what separates a crop from an
    //    anchor: an anchor moves the end sideways onto the surface point and
    //    the line stops pointing at the partner.
    //
    //    CHECKED OBLIQUELY, not just square on. Aimed straight at the face the
    //    anchor point lies ON the line already - the partner is in the normal's
    //    own direction - so the two designs coincide there and the check passes
    //    either way. It has to be asked where they differ.
    for (const deg of [0, 45, 60, 120]) {
        const q = aim(deg, 0.9);
        if (!(q.off < 0.05)) {
            throw new Error('at ' + deg + ' deg the drawn end sits '
                + q.off.toFixed(2) + ' px off the line between its two residues'
                + ' - it was moved sideways onto the surface rather than'
                + ' cropped along its own axis');
        }
    }
    // 3. THICKNESS FEEDS THE CROP. Leaving square through the FACE, the crop
    //    is the half-thickness. Checked exactly at 0.9 and only there: below
    //    that the ribbon's thickness FADES with projected size (see thickZoom),
    //    so a thin ribbon really is drawn thinner than the control says and
    //    crop == thickness/2 stops holding. A first draft asserted it at 0.4
    //    too and failed on the fade, not on the crop.
    if (Math.abs(face.crop - 0.45) > 0.06) {
        throw new Error('leaving square through the face at thickness 0.9 the'
            + ' contact was cropped ' + face.crop.toFixed(2) + ' A, not the'
            + ' 0.45 A half-thickness');
    }
    //    ...and it has to keep tracking the control upward, where no fade
    //    applies.
    const thickCrop = aim(0, 1.6).crop;
    if (!(thickCrop > face.crop + 0.1)) {
        throw new Error('a ribbon at thickness 1.6 cropped the contact '
            + thickCrop.toFixed(2) + ' A against ' + face.crop.toFixed(2)
            + ' A at 0.9 - the crop is not coming from the slab');
    }
    // 4. ...AND SO DOES WIDTH. Leaving through the EDGE the crop is the
    //    half-WIDTH instead, which is a property of the secondary structure:
    //    a strand is 1.1 A half-wide against a loop's 0.42, so the same bearing
    //    on the two must not give the same crop.
    const edgeE = aim(88, 0.9, 'E').crop;
    const edgeC = aim(88, 0.9, 'C').crop;
    if (!(edgeE > edgeC * 1.8)) {
        throw new Error('a strand cropped the edge-on contact ' + edgeE.toFixed(2)
            + ' A and a loop ' + edgeC.toFixed(2) + ' A - nearly the same, so'
            + ' the crop is not reading the ribbon\'s WIDTH');
    }
    // 5. NOTHING RUNS AWAY. Every bearing right round the ribbon, including the
    //    grazing ones that made the old face-only rule diverge.
    for (const deg of [0, 30, 60, 80, 88, 90, 120, 150, 180]) {
        const q = aim(deg, 0.9);
        if (!(q.crop >= 0 && q.crop < 2.5)) {
            throw new Error('at ' + deg + ' deg off the face normal the contact'
                + ' was cropped ' + q.crop.toFixed(2) + ' A - the slab is at most'
                + ' 1.1 A across, so nothing here may reach that');
        }
    }
    // 6. AN END WITH NO RIBBON IS NOT CROPPED.
    if (!(Math.abs(face.ligand) < 0.01)) {
        throw new Error('the ligand end was cropped by ' + face.ligand.toFixed(3)
            + ' of the line, but a ligand has no ribbon to be cropped by');
    }
});


// A BOND BETWEEN TWO ELEMENTS IS CUT AT ITS MIDPOINT, each half its own atom's
// colour - PyMOL's colour-by-element.
//
// IT REUSES THE CUT THAT WAS ALREADY THERE. A stick box is built as K pieces
// that SHARE their sections - that is how twist along a bond is handled - so
// colouring the pieces either side of the middle cuts the bond in two without
// cutting the solid: one box, no second record, no abutting caps, no seam to
// ink, and nothing added to any graph. K is forced even so a boundary lands
// exactly at the middle.
//
// Three earlier shapes are pinned here by what they broke:
//   * two bond records naming the SAME pair of atoms lied to the incidence map,
//     and bonds went missing;
//   * a real midpoint POSITION drew correctly but put a drawing artefact into
//     the data, where the distance-bonding rule webbed the midpoints together;
//   * a synthetic midpoint NODE worked, but carried its own junction, cap and
//     seam bookkeeping for something the box already knew how to do.
test('a two-element bond is cut into two coloured halves', () => {
    const GOLD = { r: 229, g: 198, b: 64 };
    const GREY = { r: 120, g: 140, b: 175 };
    const coords = [{ x: 0, y: 0, z: 0 }, { x: 1.8, y: 0, z: 0 }];
    const segs = [{ type: 'L', idx1: 0, idx2: 1, origIndex: 0 }];
    const run = (halves) => {
        const r = mkRenderer(coords, segs, {
            overlayState: { enabled: false }, positionTypes: ['L', 'L'],
            viewerState: { extent: 5, zoom: 1, ortho: 1, focalLength: 100 },
            objectsData: { obj: { maxExtent: 5 } },
            cartoonThickness: 0.5, _thicknessUserSet: true,
            _primProbe: null, _stickProbe: [],
        });
        const { ctx, bad } = mkCtx();
        // the half-colours ride ON the colour array, so they cannot be served
        // beside a stale segment list
        const cols = [GREY]; cols.halves = halves;
        cartoon.render(r, ctx, 600, 500, cols);
        if (bad.length) throw new Error('bad styles: ' + bad[0]);
        return {
            faces: (r._primProbe || []).filter((p) => p.kind === 'stickFace'),
            boxes: (r._stickProbe || []).length,
            inked: (r._stickProbe || []).reduce((n, b) => n + ((b.edges || []).length), 0),
        };
    };
    const plain = run([null]);
    const split = run([{ a: GREY, b: GOLD }]);

    if (plain.boxes !== 1) throw new Error('the control bond is not one piece');
    if (split.boxes !== 2) {
        throw new Error('a two-element bond made ' + split.boxes + ' pieces, not'
            + ' two - K must be even so a boundary lands at the middle');
    }
    const cols = new Set(split.faces.map((f) => f.c.r + ',' + f.c.g + ',' + f.c.b));
    if (cols.size !== 2) throw new Error('the halves share one colour');

    // each half covers HALF the bond, or one is drawn over the other
    const span = (red) => {
        const xs = split.faces.filter((f) => f.c.r === red).flatMap((f) => f.q.map((p) => p[0]));
        return [Math.min(...xs), Math.max(...xs)];
    };
    const g = span(GOLD.r); const y = span(GREY.r);
    const whole = g[1] - y[0];
    if (!(g[1] - g[0] < whole * 0.65) || !(y[1] - y[0] < whole * 0.65)) {
        throw new Error('a half spans ' + (g[1] - g[0]).toFixed(0) + '/'
            + (y[1] - y[0]).toFixed(0) + ' px of a ' + whole.toFixed(0) + ' px bond');
    }
    if (Math.abs(g[0] - y[1]) > 2) {
        throw new Error('the halves do not meet: grey ends at ' + y[1].toFixed(0)
            + ', gold starts at ' + g[0].toFixed(0));
    }
    // ...AND BOTH HALVES KEEP THE SAME SECTION. The square section's roll is
    // seeded in MODEL space off the bond's own direction, and a half-bond's
    // graph endpoint is a midpoint with NO coordinate - so the seed is taken
    // from `seedA`/`seedB`, the real atoms, or the halves roll independently and
    // their corners do not line up at the seam.
    //
    // WHAT THIS DOES NOT COVER, honestly: deleting seedA/seedB does not fail
    // here. Both endpoints of a half are partly synthetic, so without the seed
    // both halves fall back TOGETHER - they stay aligned with each other while
    // drifting away from what the same bond drawn whole would do. Catching that
    // needs a measure of the section's ORIENTATION; y-extent is not one, since
    // for any bond not along x it is dominated by the bond's own travel. That
    // mistake passed here for a while precisely because this fixture's bond
    // runs along x.
    {
        const rot = [[0.8, -0.6, 0], [0.6, 0.8, 0], [0, 0, 1]];
        const r2 = mkRenderer(coords, segs, {
            overlayState: { enabled: false }, positionTypes: ['L', 'L'],
            viewerState: { extent: 5, zoom: 1, ortho: 1, focalLength: 100, rotation: rot },
            objectsData: { obj: { maxExtent: 5 } },
            cartoonThickness: 0.5, _thicknessUserSet: true,
            _primProbe: null,
        });
        const c2 = [GREY]; c2.halves = [{ a: GREY, b: GOLD }];
        cartoon.render(r2, mkCtx().ctx, 600, 500, c2);
        const fs2 = (r2._primProbe || []).filter((p) => p.kind === 'stickFace');
        const spread = (red) => {
            const ys = fs2.filter((f) => f.c.r === red).flatMap((f) => f.q.map((p) => p[1]));
            return Math.max(...ys) - Math.min(...ys);
        };
        const a2 = spread(GOLD.r); const b2 = spread(GREY.r);
        if (!(a2 > 0) || !(b2 > 0) || Math.abs(a2 - b2) > 0.75) {
            throw new Error('the halves have sections ' + a2.toFixed(2) + ' and '
                + b2.toFixed(2) + ' px across - they were rolled independently,'
                + ' so their corners do not meet at the seam');
        }
    }

    // THE SEAM IS NOT A FREE END. A midpoint has two legs, so the junction rules
    // treat it as a straight joint - no cap, and no outline ruled across the
    // middle of the stick. Two halves ink one outer end each.
    if (split.inked !== plain.inked + 2) {
        throw new Error('the cut bond inks ' + split.inked + ' edges against '
            + plain.inked + ' whole; the extra two are the second box\'s long'
            + ' sides, and anything more is a seam drawn across it');
    }
});

// ---- the ink pass's occluder grid -----------------------------------------
// The grid is a pure accelerator: it decides which occluders a visibility
// query bothers to test, never what the answer is. The test below says exactly
// that and nothing about how the grid is built, so it holds for any
// implementation of it.

// One render of a dense fixture at a given cell pitch. Ribbon (quad
// occluders), a ligand in front of it (capsules and stick faces), and a chain
// break. Kept well inside the canvas, because an off-canvas query point is
// genuinely pitch-dependent - the grid covers ceil(W / CELL) * CELL pixels, so
// the strip past the right edge belongs to the grid at one pitch and not at
// another.
function inkTraceAt(cell) {
    const coords = helix(24).concat(coil(10, 26));
    const nP = coords.length;
    const segs = bbSegs([[0, 23], [24, 33]]);
    // a four-atom ligand across the front of the helix, at +z (toward the
    // eye), so it really does occlude something
    const lig = [[-6, 2, 14], [-2, 3, 14], [2, 2, 14], [6, 3, 14]];
    for (const [x, y, z] of lig) coords.push({ x, y, z });
    for (let i = 0; i + 1 < lig.length; i++) {
        segs.push({ type: 'L', idx1: nP + i, idx2: nP + i + 1 });
    }
    const types = new Array(coords.length).fill('P');
    for (let i = nP; i < coords.length; i++) types[i] = 'L';
    const r = mkRenderer(coords, segs, {
        overlayState: { enabled: false },
        outlineMode: 'full',
        positionTypes: types,
        _inkCell: cell,
        _inkTrace: [],
        _phase: {},
    });
    cartoon.render(r, mkCtx().ctx, 400, 400, segs.map(() => COL));
    return r;
}

test('the ink pass decides the same lines at every cell pitch', () => {
    // 3 and 24 are the ends of the adaptive pitch's own clamp, and 7 is a
    // pitch that divides neither dimension - so occluders span different
    // numbers of cells in all three, and every one of them has to reach every
    // query that could see it. A cell list left unsorted fails here too: the
    // query walks far-to-near and stops at the first occluder that is not
    // nearer than its own point, which skips real occluders the moment the
    // order is wrong, and changing the pitch changes which occluders share a
    // cell.
    const runs = [3, 7, 24].map((c) => inkTraceAt(c));
    const ref = runs[0]._inkTrace;
    if (!ref.length) throw new Error('no ink segments - the fixture drew nothing');
    if (!ref.some((b) => b === 0) || !ref.some((b) => b === 1)) {
        throw new Error('every ink segment came out the same way, so the '
            + 'occlusion test never actually fired on this fixture');
    }
    for (let k = 1; k < runs.length; k++) {
        const t = runs[k]._inkTrace;
        if (t.length !== ref.length) {
            throw new Error('pitch changed the number of ink segments: '
                + ref.length + ' vs ' + t.length);
        }
        for (let i = 0; i < ref.length; i++) {
            if (ref[i] !== t[i]) {
                throw new Error('ink segment ' + i + ' is '
                    + (ref[i] ? 'drawn' : 'hidden') + ' at pitch '
                    + runs[0]._phase.inkCell + ' and '
                    + (t[i] ? 'drawn' : 'hidden') + ' at pitch '
                    + runs[k]._phase.inkCell + ' - the grid changed an answer '
                    + 'instead of just how fast it was reached');
            }
        }
    }
});

process.exit(failures ? 1 : 0);
