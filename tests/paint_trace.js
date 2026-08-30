// WHAT THE PAINTER ACTUALLY DREW, as a hash you can diff.
//
//     node tests/paint_trace.js           # compare against the saved digests
//     node tests/paint_trace.js --save    # record the current answer
//     node tests/paint_trace.js --show H  # print one fixture's op stream
//
// THE INVARIANT FOR MOVING CODE. cartoon/geom.js is one 9,600-line render()
// that is about to be cut into a geometry half and a painting half, and
// core/mol.js is about to lose several thousand lines to sibling files. The
// only claim worth making about a move that size is "the drawing did not
// change", and the only way to make it is to record the drawing before and
// compare after.
//
// WHY THE OP STREAM AND NOT PIXELS. A canvas hash changes with the device pixel
// ratio, with font rasterisation and with the GPU driver, needs a browser, and
// when it breaks it says "something changed" and stops. The op stream - every
// call the painter makes, in order, with its arguments - is deterministic, runs
// in node in milliseconds, and diffs to the line that moved. tests/smoke.js
// already counts gradients and distinct fills through a mock context and
// tests/paint_order_audit.js already records calls through a Proxy; this is the
// same idea taken to the whole stream.
//
// WHAT IT CANNOT SEE, measured rather than guessed:
//
//   * Anything the painter does not express as a canvas call - the pixels a
//     gradient interpolates between two identical stops, for instance.
//   * The GPU path, at all. That one draws with WebGL and blits a raster; its
//     own probes (tests/gpu_*.py) compare it against the 2D path in a browser.
//   * THE HALF-WIDTH TABLES. `SS_HALF_A` and `RICH_HALF_A` (cartoon/geom.js
//     299 and 330) can be changed TENFOLD and every fixture below still draws
//     byte-identically. They are read at 5333 through a `halfW` closure on the
//     continuous-profile path, and none of these fixtures reach it: the stub
//     produces exactly 50 `rib` prims for a 24-residue helix whatever
//     cartoonDetail, cartoonSmooth, cartoonThickness or cartoonRichardson say.
//     Something else gates that branch. This is a gap in the FIXTURES, not in
//     the mechanism - but it is a real gap, and anyone relying on this file to
//     bless a change to ribbon widths should close it first.
//
// So: a check on the 2D painter's behaviour under refactoring - very good at
// catching a move that dropped a call, reordered a phase or lost a piece of
// state - and not a substitute for looking at the picture.
//
// Verified by breaking it: reversing the depth sort (`prims.sort`) changes
// three fixtures; adding a comment changes none.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ...and the view scale, which cartoon/geom.js asks the renderer for rather
// than computing itself (it used to keep a third copy of the formula, and that
// copy was the one that ignored extentAspect). LIFTED from the source, so this
// harness scores the shipped arithmetic instead of a paraphrase of it.
const L__ = require('./lift.js');
const viewportScale = new Function(
    'return function ' + L__.method('_viewportScale'))();
// ...and the sibling it asks for the framing through. Lifted for the same
// reason: one answer, and this harness must score the shipped one.
const framingHalfSpan = new Function(
    'return function ' + L__.method('_viewHalfSpan'))();
// ...and the module-scope helper BOTH of those reach for. Third time this
// harness has had to learn about a new callee: the shipped code is lifted, so
// anything it calls has to be lifted too, and reimplementing it here would be
// the second convention setViewSpan exists to prevent.
global.halfSpanOf = new Function(
    'return ' + L__.topFunction('halfSpanOf'))();

const ROOT = path.dirname(__dirname);
const BASELINE = path.join(__dirname, 'paint_trace.json');

// ---- load the painter, the way smoke.js does -------------------------------
// A FIXED CLOCK. render() times itself and decides how much ink to lay down
// from what the last frames cost, so a real clock makes the op stream depend on
// how fast the machine is. Pinned here, the same fixture draws the same calls
// every time - which is the whole point of a digest.
let _t = 0;
global.performance = { now: () => (_t += 1) };
global.window = { addEventListener() {}, dispatchEvent() {}, devicePixelRatio: 1 };
global.document = { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) };
global.Event = function Event() {};
// THE GEOMETRY AND THE PAINTER ARE TWO FILES NOW, and the painter reads the
// shading vocabulary from the geometry file at load time - so the order here is
// the order the page uses. Loading only the first leaves render() with no
// painter, which it reports rather than drawing nothing; the trace then sees
// every fixture produce the same empty stream, which the duplicate-digest guard
// below catches.
for (const rel of ['src/cartoon/geom.js',
    'src/cartoon/paint2d.js']) {
    eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
const cartoon = global.window.py2dmolCartoon;
if (!cartoon || !cartoon.render) throw new Error('the cartoon plugin did not load');

// ---- the recorder ----------------------------------------------------------
// Numbers are rounded before they enter the stream. Sub-thousandth differences
// are below anything a reader could see and would otherwise make the digest
// depend on the last bit of a cosine.
const r3 = (v) => (typeof v === 'number'
    ? (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : String(v)) : v);

function recorder() {
    const ops = [];
    const noop = () => {};
    const push = (name, args) => ops.push(name + '(' + args.map(r3).join(',') + ')');
    const target = {};
    const ctx = new Proxy(target, {
        get(t, k) {
            if (k === 'canvas') return { width: 600, height: 600 };
            if (k === 'measureText') return () => ({ width: 10 });
            if (k === 'createLinearGradient' || k === 'createRadialGradient') {
                return (...a) => {
                    push('gradient', a);
                    return { addColorStop: (o, c) => push('  stop', [o, c]) };
                };
            }
            if (k === 'getImageData') {
                return (x, y, w, h) => ({ data: new Uint8ClampedArray(
                    4 * Math.max(1, w | 0) * Math.max(1, h | 0)) });
            }
            if (k === 'setLineDash') return (a) => push('setLineDash', a || []);
            if (k in t) return t[k];
            // every other member is a drawing call that records itself
            return (...a) => { push(k, a); return undefined; };
        },
        set(t, k, v) {
            // ...and every style assignment, because a fill colour is as much
            // of the drawing as a lineTo
            ops.push(k + '=' + (typeof v === 'number' ? r3(v) : String(v)));
            t[k] = v;
            return true;
        },
    });
    return { ctx, ops };
}

// ---- fixtures --------------------------------------------------------------
// Small, synthetic and analytic, so the trace is about the painter rather than
// about a PDB file. Each one is chosen to reach a different phase of render():
// the ribbon, the sheet frames, the loop tube, the nucleic slab and the stick
// pipeline are separate bodies of code and a digest over only a helix would
// leave most of them unwatched.
function helix(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const th = i * 100 * Math.PI / 180;
        out.push([2.3 * Math.cos(th), 2.3 * Math.sin(th), 1.5 * i]);
    }
    return out;
}
function strand(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push([3.3 * i, (i % 2) * 0.9, 0]);
    return out;
}
function hairpin(n) {
    // two strands and a turn: the sheet-frame and ladder code
    const out = [];
    for (let i = 0; i < n; i++) out.push([3.3 * i, (i % 2) * 0.9, 0]);
    for (let i = 0; i < n; i++) out.push([3.3 * (n - 1 - i), (i % 2) * 0.9 + 4.8, 1.0]);
    return out;
}
// A REAL B-DNA DUPLEX, because none of the fixtures above is nucleic and the
// comment at the top of this block has always claimed otherwise. The rails, the
// pairing and the base plates are five hundred lines of render() that a helix,
// a strand and a hairpin never reach - and a refactor of exactly that region
// reported "9 fixtures unchanged" while nothing touched it.
//
// THE COORDINATES ARE REAL, WHICH THE OTHERS ARE NOT. An ideal duplex was tried
// first, over four radii and seven groove offsets, and NONE of them produced a
// single plate: pairing needs more than a plausible double helix. These are
// 1BNA's twenty-four C4' atoms, rounded to two decimals - small enough to read,
// and the only thing here that is guaranteed to pair.
const BNA_C4 = [
    [19.96, 32.67, 24.10],
    [23.49, 27.71, 22.28],
    [23.52, 22.23, 20.25],
    [21.39, 16.96, 18.50],
    [16.67, 14.09, 16.96],
    [11.11, 14.60, 14.44],
    [8.16, 17.63, 10.60],
    [7.00, 21.23, 6.44],
    [8.90, 24.85, 2.46],
    [11.97, 26.09, -2.80],
    [16.22, 25.95, -5.51],
    [19.75, 22.17, -9.30],
    [9.71, 11.14, -9.51],
    [15.11, 10.99, -6.66],
    [18.94, 13.96, -3.54],
    [21.74, 18.29, -1.02],
    [20.10, 23.79, 0.48],
    [16.04, 26.96, 3.39],
    [11.81, 27.22, 7.30],
    [8.65, 25.06, 11.68],
    [8.10, 21.60, 16.46],
    [9.42, 19.56, 21.98],
    [13.12, 17.57, 25.59],
    [18.21, 18.46, 28.76]];
// ...and its segments, which run WITHIN each strand and never across: the two
// rails are separate chains, and a bond between them would be read as one.
function duplexSegs() {
    const s = [];
    for (const base of [0, 12]) {
        for (let i = 0; i + 1 < 12; i++) {
            s.push({ type: 'D', idx1: base + i, idx2: base + i + 1, origIndex: base + i });
        }
    }
    return s;
}
// THE BASE NAMES ARE LOAD-BEARING. Without positionNames the same coordinates
// draw 46 prims and no plates at all; with them, 88 and twenty-two pickable
// rungs. Whatever identifies a base, it is not the geometry alone.
const DUPLEX_OPTS = {
    positionTypes: new Array(24).fill('D'),
    chains: [...new Array(12).fill('A'), ...new Array(12).fill('B')],
    positionNames: [...new Array(12).fill('DC'), ...new Array(12).fill('DG')],
};

function segsOf(coords) {
    const s = [];
    for (let i = 0; i + 1 < coords.length; i++) {
        s.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
    }
    return s;
}
function mkRenderer(coords, segments, opts) {
    const n = coords.length;
    const r = {
        coords,
        // ...AS Vec3, NOT AS ARRAYS. render() reads `rotated[i].x`, so a plain
        // [x, y, z] gives undefined, every projection comes out NaN and the
        // painter draws a full frame of moveTo(NaN, NaN). It draws the same
        // number of them whatever the coordinates were, which is exactly how a
        // trace over arrays produced one digest for four different fixtures.
        rotatedCoords: coords.map(([x, y, z]) => ({ x, y, z })),
        segmentIndices: segments,
        positionTypes: new Array(n).fill('P'),
        positionNames: new Array(n).fill('ALA'),
        residueNumbers: Array.from({ length: n }, (_, i) => i + 1),
        chains: new Array(n).fill('A'),
        _viewportScale: viewportScale,
        _viewHalfSpan: framingHalfSpan,
        viewerState: { extent: 30, zoom: 1, ortho: 1, focalLength: 100,
            rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
        objectsData: { obj: { maxExtent: 30 } },
        currentObjectName: 'obj',
        currentFrame: 0,
        lineWidth: 3.0,
        visibilityMask: null,
        visiblePositions: null,
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

const COL = { r: 100, g: 140, b: 220 };

const FIXTURES = {
    // a plain helix, Richardson defaults
    H: () => { const c = helix(24); return [c, segsOf(c), {}]; },
    // ...and as a flat ribbon, which takes the other preset's numbers
    'H-ribbon': () => { const c = helix(24);
        return [c, segsOf(c), { cartoonRichardson: false, cartoonThickness: 0 }]; },
    // an extended strand: the sheet path rather than the coil path
    E: () => { const c = strand(20); return [c, segsOf(c), {}]; },
    // two strands and a turn: sheet frames and the ladder pairing
    hairpin: () => { const c = hairpin(12); return [c, segsOf(c), {}]; },
    // no outline: the ink pass is the larger half of the paint, and skipping it
    // must not disturb the fills
    'H-noink': () => { const c = helix(24);
        return [c, segsOf(c), { outlineMode: 'off', relativeOutlineWidth: 0 }]; },
    // a thicker ribbon: the slab pipeline rather than the stroked one, and the
    // one option here that is a GEOMETRY change rather than a colour change.
    // `shadowEnabled: false` sat in this slot and drew byte-identically to H -
    // correctly, because shading is resolved in core/mol.js and reaches the
    // painter as a colour. A fixture whose digest equals its neighbour's is
    // watching nothing.
    'H-thick': () => { const c = helix(24);
        return [c, segsOf(c), { cartoonThickness: 1.6 }]; },
    // a wider stroke: every width in the drawing is derived from this one
    'H-wide': () => { const c = helix(24);
        return [c, segsOf(c), { lineWidth: 6.0 }]; },
    // the RICHARDSON preset, which is the app's default and takes a different
    // half-width table (RICH_HALF_A) and a different profile from the plain
    // ribbon above. Without this the default preset was the one thing the
    // trace did not watch.
    'H-rich': () => { const c = helix(24);
        return [c, segsOf(c), { cartoonRichardson: true, cartoonThickness: 1.2 }]; },
    // ...and a sheet under Richardson, which is where the arrow is built
    'E-rich': () => { const c = strand(20);
        return [c, segsOf(c), { cartoonRichardson: true, cartoonThickness: 1.2,
            cartoonArrows: true }]; },
    // A DUPLEX, which is the only fixture that reaches the nucleic half of
    // render(): the smoothed rails, the pair finding, and the base plates.
    duplex: () => [BNA_C4, duplexSegs(), Object.assign({}, DUPLEX_OPTS)],
    // ...and with the plates switched off, so the rails alone are watched and
    // the plate geometry is provably what the difference between these two is.
    'duplex-noplates': () => [BNA_C4, duplexSegs(),
        Object.assign({}, DUPLEX_OPTS, { cartoonBasePlates: false })],
};

function traceOf(name) {
    const [coords, segs, opts] = FIXTURES[name]();
    const { ctx, ops } = recorder();
    _t = 0;
    const r = mkRenderer(coords, segs, opts);
    cartoon.render(r, ctx, 600, 600, segs.map(() => COL));
    return ops;
}

// THE GPU HARVEST, WHICH AN OP STREAM CANNOT WATCH.
//
// `_frameProbe` makes render() emit each station's frame in model space and tag
// every prim with a palette slot - the form cartoon/paintgl.js reads. None of
// it reaches a 2D canvas, so every fixture above draws identically with the flag
// on and the duplicate-digest guard correctly refuses a fixture for it.
//
// It still has to be watched. Extracting the base plates left a reference to
// `hasColorOverrides` behind in exactly that branch: every nucleic example on
// embed.html went blank, the GPU logged "cartoon GPU path unavailable:
// ReferenceError", and this file reported eleven fixtures unchanged. So the
// check here is on the PRIMS rather than the painting - it runs the branch, and
// a name that has gone out of scope throws where the digest saw nothing.
function checkFrameProbe() {
    const segs = duplexSegs();
    const r = mkRenderer(BNA_C4, segs,
        Object.assign({}, DUPLEX_OPTS, { _frameProbe: true, _probeOnly: true }));
    r._primProbe = null;
    const { ctx } = recorder();
    try {
        cartoon.render(r, ctx, 600, 600, segs.map(() => COL));
    } catch (e) {
        console.log('FAIL: the _frameProbe path threw: ' + e.message);
        return 1;
    }
    const prims = r._primProbe || [];
    const tagged = prims.filter((p) => p.ci !== undefined).length;
    if (!prims.length) {
        console.log('FAIL: the _frameProbe path produced no prims at all');
        return 1;
    }
    if (!tagged) {
        console.log(`FAIL: none of ${prims.length} prims carries a palette slot`
            + ' - _frameProbe is not reaching the emit, so this watches nothing');
        return 1;
    }
    console.log(`frame probe: ${prims.length} prims, ${tagged} with a palette slot`);
    return 0;
}

const digest = (ops) => crypto.createHash('sha1')
    .update(ops.join('\n')).digest('hex').slice(0, 12);

// ---- run -------------------------------------------------------------------
const arg = process.argv[2];

if (arg === '--show') {
    const name = process.argv[3] || 'H';
    traceOf(name).forEach((o) => console.log(o));
    process.exit(0);
}

const now = {};
for (const name of Object.keys(FIXTURES)) {
    const ops = traceOf(name);
    now[name] = { ops: ops.length, digest: digest(ops) };
}

// DETERMINISM IS PART OF THE CHECK. A digest that changes between two runs in
// the same process would make every later comparison meaningless, so the whole
// set is traced twice and compared with itself before anything else.
for (const name of Object.keys(FIXTURES)) {
    const again = digest(traceOf(name));
    if (again !== now[name].digest) {
        console.log(`FAIL: ${name} does not draw the same thing twice in one run`
            + ` (${now[name].digest} then ${again}) - something in the painter is`
            + ' reading a clock, a random number, or state left by the last frame');
        process.exit(1);
    }
}

// ...AND NO TWO FIXTURES MAY DRAW THE SAME THING. A fixture whose digest equals
// another's is watching nothing: it was `shadowEnabled: false`, which the
// cartoon painter cannot see because shading reaches it as a colour, and it sat
// there drawing byte-identically to the plain helix.
{
    const seen = new Map();
    for (const [name, v] of Object.entries(now)) {
        if (seen.has(v.digest)) {
            console.log(`FAIL: ${name} draws exactly what ${seen.get(v.digest)} draws`
                + ' - it varies something the painter cannot see, so it watches nothing');
            process.exit(1);
        }
        seen.set(v.digest, name);
    }
}

if (arg === '--save') {
    fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n');
    console.log(`saved ${Object.keys(now).length} fixtures to tests/paint_trace.json`);
    for (const [k, v] of Object.entries(now)) console.log(`  ${k.padEnd(12)} ${v.ops} ops  ${v.digest}`);
    process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
    console.log('FAIL: no tests/paint_trace.json - run: node tests/paint_trace.js --save');
    process.exit(1);
}
const was = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
let bad = 0;
for (const name of Object.keys(FIXTURES)) {
    const a = was[name]; const b = now[name];
    if (!a) { console.log(`FAIL: ${name} is not in the baseline - re-save it`); bad++; continue; }
    if (a.digest !== b.digest) {
        console.log(`FAIL: ${name} draws differently: ${a.ops} ops ${a.digest}`
            + ` -> ${b.ops} ops ${b.digest}`);
        console.log(`      see the difference with: node tests/paint_trace.js --show ${name}`);
        bad++;
    }
}
for (const name of Object.keys(was)) {
    if (!FIXTURES[name]) { console.log(`FAIL: fixture ${name} was removed from the trace`); bad++; }
}
if (!bad) {
    bad += checkFrameProbe();
    console.log(`paint trace: ${Object.keys(FIXTURES).length} fixtures unchanged`
        + ` (${Object.values(now).reduce((s, v) => s + v.ops, 0)} ops)`);
}
process.exit(bad ? 1 : 0);
