/* Score the BASE-PAIR AXIS the renderer builds its plates on.
 *
 *   python tests/na_table.py --build   # once, writes tests/out/na_truth.json
 *   node tests/na_axis.js              # report
 *
 * Every base plate hangs off one vector: the pair axis. The pair plane is
 * normal to it, so an axis that is d degrees wrong tilts the plate by d
 * degrees - it is the single number that decides whether a plate lies in the
 * plane the bases actually occupy. This scores it against the true base-plane
 * normals in na_truth.json (fitted to the real ring atoms).
 *
 * Scored per PAIR, taking the WORSE of the two partners: a plate is shared by
 * both bases of the pair, so it is only as right as the base it fits least.
 *
 * The axis is smoothed along the stem before use, which is what this exists to
 * guard - see the axSm pass in viewer-cartoon.js. Its value is concentrated at
 * the ENDS of helices, where the fitting window runs off the stem and the
 * predicted base normals stop being helical, so the report splits interior
 * pairs from end pairs.
 *
 * Renders through cartoon.render rather than reimplementing the fit, so this
 * cannot score a stale copy of it. _naDebug makes the renderer record the axes.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TRUTH = path.resolve(__dirname, 'out/na_truth.json');
const SRC = path.resolve(__dirname, '../py2Dmol/resources/viewer-cartoon.js');

function loadCartoon() {
    const sandbox = {
        window: { addEventListener() {}, dispatchEvent() {} },
        document: { createElement: () => ({ getContext: () => null }) },
        console,
        performance: { now: () => Date.now() },
        Event: function Event() {},
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
    return sandbox.window.py2dmolCartoon;
}

const unit = (a) => {
    const m = Math.hypot(a[0], a[1], a[2]);
    return m > 1e-9 ? [a[0] / m, a[1] / m, a[2] / m] : null;
};
// an axis has no sign, so the angle is taken to the nearer of the two
const acute = (u, v) => Math.acos(Math.max(0, Math.min(1,
    Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2])))) * 180 / Math.PI;
const q = (a, p) => a[Math.floor(a.length * p)];

// a throwaway 2D context: this bench reads the geometry the renderer computes,
// not the pixels, so every drawing call is a no-op
function mkCtx() {
    return {
        canvas: { width: 400, height: 400 },
        lineWidth: 1, lineJoin: 'round', lineCap: 'butt', miterLimit: 10,
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        fillStyle: '', strokeStyle: '',
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
        stroke() {}, fill() {}, arc() {},
        createLinearGradient() { return { addColorStop() {} }; },
    };
}

function mkRenderer(coords, names) {
    const n = coords.length;
    const segs = [];
    for (let i = 0; i + 1 < n; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1 });
    let ext = 1;
    for (const c of coords) ext = Math.max(ext, Math.hypot(c.x, c.y, c.z));
    ext *= 1.15;
    return {
        r: {
            coords, rotatedCoords: coords, segmentIndices: segs,
            positionTypes: new Array(n).fill('R'), positionNames: names,
            chains: new Array(n).fill('A'),
            viewerState: { extent: ext, zoom: 1, ortho: 1, focalLength: 300 },
            objectsData: { obj: { maxExtent: ext } }, currentObjectName: 'obj',
            currentFrame: 0, lineWidth: 3, visibilityMask: null,
            outlineMode: 'full', relativeOutlineWidth: 2, shadowEnabled: true,
            cartoonShade: 1, colorMode: 'chain', screenFrameId: 0,
            screenX: new Float64Array(n), screenY: new Float64Array(n),
            screenRadius: new Float64Array(n), screenValid: new Uint8Array(n),
            overlayState: { enabled: false },
            _calculateSegmentWidthMultiplier: () => 1,
            cartoonDetail: 4, cartoonThickness: 0.7,
            _naDebug: true,
        },
        segs,
    };
}

(function main() {
    if (!fs.existsSync(TRUTH)) {
        console.error('missing ' + TRUTH + ' - run: python tests/na_table.py --build');
        process.exit(1);
    }
    const cartoon = loadCartoon();
    if (!cartoon || !cartoon.render) {
        console.error('viewer-cartoon.js did not export render');
        process.exit(1);
    }
    const chains = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
    const ctx = mkCtx();
    const all = [];
    const interior = [];
    const ends = [];
    let nChains = 0;
    let nPairs = 0;
    for (const ch of chains) {
        const n = ch.c4.length;
        if (n < 6) continue;
        const coords = ch.c4.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
        // na_truth carries purine/pyrimidine and DNA/RNA, not the letter. The
        // pairing needs complementarity, so give each residue a base whose
        // partner exists: purines G, pyrimidines C. That is a real G-C pair as
        // far as the renderer is concerned, and this bench scores the AXIS, not
        // which residues got paired.
        const names = [];
        for (let i = 0; i < n; i++) {
            const pur = ch.pur[i] === 1;
            names.push((ch.kinds[i] === 'D' ? 'D' : '') + (pur ? 'G' : 'C'));
        }
        const { r, segs } = mkRenderer(coords, names);
        try {
            cartoon.render(r, ctx, 400, 400, segs.map(() => ({ r: 1, g: 1, b: 1 })));
        } catch (e) { continue; }
        const ax = r._naAxis;
        if (!ax || !ax.length) continue;
        nChains++;
        const have = new Set(ax.map((p) => p.i + ',' + p.j));
        for (const p of ax) {
            const ti = unit(ch.norms[p.i] || [0, 0, 0]);
            const tj = unit(ch.norms[p.j] || [0, 0, 0]);
            if (!ti || !tj) continue;
            const e = Math.max(acute(p.a, ti), acute(p.a, tj));
            nPairs++;
            all.push(e);
            // a pair with a register neighbour on both sides is stem-interior
            const up = have.has((p.i + 1) + ',' + (p.j - 1));
            const dn = have.has((p.i - 1) + ',' + (p.j + 1));
            (up && dn ? interior : ends).push(e);
        }
    }
    if (!all.length) {
        console.error('no pairs scored');
        process.exit(1);
    }
    const row = (label, a) => {
        a = a.slice().sort((x, y) => x - y);
        const over = 100 * a.filter((x) => x > 30).length / a.length;
        console.log(`  ${label.padEnd(16)}${String(a.length).padStart(6)}  `
            + `${q(a, .5).toFixed(1).padStart(7)}  ${q(a, .75).toFixed(1).padStart(6)}  `
            + `${q(a, .9).toFixed(1).padStart(6)}  ${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1).padStart(6)}  `
            + `${over.toFixed(1).padStart(7)}%`);
    };
    console.log(`${nChains} chains, ${nPairs} base pairs`);
    console.log('\n  angle between the pair axis and the true base-plane normal');
    console.log('  (worse of the pair\'s two bases; 0 = the plate lies in the base plane)\n');
    console.log('                   pairs   median     p75     p90    mean   >30deg');
    row('all pairs', all);
    if (interior.length) row('stem interior', interior);
    if (ends.length) row('stem ends', ends);
})();
