/* Score the NUCLEIC RAIL FRAME the renderer ends up with.
 *
 *   python tests/na_table.py --build   # once, writes tests/out/na_truth.json
 *   node tests/na_frame.js             # report
 *   node tests/na_frame.js py2Dmol/resources/bundles/py2Dmol.notebook.min.js
 *
 * The second form is the point of the argument: the bundle is what the
 * packaged Python path loads, and a bundle that was committed without being
 * rebuilt scores exactly like the code it was supposed to replace. That has
 * happened.
 *
 * Reads _naFrame (per residue: s, t, position, partner) after a render and
 * measures three things:
 *   aim    - angle between the rail face AXIS (t x s) and the direction to the
 *            pairing partner, folded to 0-90. 0 = the ribbon face lies square
 *            on its partner. Folded because the frame's sign is settled per
 *            run, not per residue - the slab is symmetric under s -> -s and
 *            the plate picks its face geometrically - so which of the two
 *            faces it is carries no information.
 *   twist  - signed rotation of s about t between consecutive residues.
 *            A duplex really turns ~36 deg/bp, so the number to read is the
 *            SPREAD, and how often it reverses sign (a reversal is the frame
 *            jumping back, which is the visible waviness).
 *   partner- angle between the two rails' s vectors for a pair. 0 = the two
 *            halves of a plate leave on the same width axis.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TRUTH = path.resolve(__dirname, 'out/na_truth.json');
const SRC = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../src/cartoon/geom.js');

function loadCartoon() {
    const sandbox = {
        window: { addEventListener() {}, dispatchEvent() {} },
        document: { createElement: () => ({ getContext: () => null }) },
        console, performance: { now: () => Date.now() },
        Event: function Event() {},
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
    return sandbox.window.py2dmolCartoon;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const m = Math.hypot(a[0], a[1], a[2]); return m > 1e-9 ? [a[0] / m, a[1] / m, a[2] / m] : null; };
const ang = (u, v) => Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) * 180 / Math.PI;
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

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
    const chains = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
    const ctx = mkCtx();
    const aim = []; const twist = []; const partner = []; const RUNG = [];
    let reversals = 0; let steps = 0; let nRes = 0; let nChains = 0;
    for (const ch of chains) {
        const n = ch.c4.length;
        if (n < 6) continue;
        const coords = ch.c4.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
        const names = [];
        for (let i = 0; i < n; i++) {
            names.push((ch.kinds[i] === 'D' ? 'D' : '') + (ch.pur[i] === 1 ? 'G' : 'C'));
        }
        const { r, segs } = mkRenderer(coords, names);
        try { cartoon.render(r, ctx, 400, 400, segs.map(() => ({ r: 1, g: 1, b: 1 }))); }
        catch (e) { continue; }
        if (r._naTwist) for (const v of r._naTwist) RUNG.push(v);
        const F = r._naFrame;
        if (!F) continue;
        nChains++;
        const keys = Object.keys(F).map(Number).sort((a, b) => a - b);
        for (const i of keys) {
            const f = F[i];
            nRes++;
            if (f.j >= 0 && F[f.j]) {
                let d = [coords[f.j].x - f.p[0], coords[f.j].y - f.p[1], coords[f.j].z - f.p[2]];
                const dd = dot(d, f.t);
                d = unit([d[0] - f.t[0] * dd, d[1] - f.t[1] * dd, d[2] - f.t[2] * dd]);
                if (d) { const a2 = ang(unit(cross(f.t, f.s)), d); aim.push(Math.min(a2, 180 - a2)); }
                // partner width-axis agreement, up to a 180 flip
                const g = F[f.j];
                const a = ang(f.s, g.s);
                partner.push(Math.min(a, 180 - a));
            }
            const g = F[i + 1];
            if (!g) continue;
            // signed rotation of s about the mean tangent
            const t = unit([f.t[0] + g.t[0], f.t[1] + g.t[1], f.t[2] + g.t[2]]);
            if (!t) continue;
            const a0 = unit([f.s[0] - t[0] * dot(f.s, t), f.s[1] - t[1] * dot(f.s, t), f.s[2] - t[2] * dot(f.s, t)]);
            const a1 = unit([g.s[0] - t[0] * dot(g.s, t), g.s[1] - t[1] * dot(g.s, t), g.s[2] - t[2] * dot(g.s, t)]);
            if (!a0 || !a1) continue;
            const c = Math.max(-1, Math.min(1, dot(a0, a1)));
            const sgn = dot(cross(a0, a1), t) >= 0 ? 1 : -1;
            const w = sgn * Math.acos(c) * 180 / Math.PI;
            // only inside a stem: both residues paired in register
            if (f.j >= 0 && g.j >= 0 && Math.abs(f.j - g.j) === 1) {
                twist.push(w);
                steps++;
                if (w < 0) reversals++;
            }
        }
    }
    const stats = (label, a) => {
        if (!a.length) { console.log('  ' + label + ': none'); return; }
        const s = a.slice().sort((x, y) => x - y);
        const mean = a.reduce((x, y) => x + y, 0) / a.length;
        const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
        console.log(`  ${label.padEnd(10)} n=${String(a.length).padStart(6)}  med ${q(s, .5).toFixed(1).padStart(7)}`
            + `  p90 ${q(s, .9).toFixed(1).padStart(7)}  mean ${mean.toFixed(1).padStart(7)}  sd ${sd.toFixed(1).padStart(6)}`
            + `  min ${s[0].toFixed(1).padStart(7)}  max ${s[s.length - 1].toFixed(1).padStart(7)}`);
    };
    console.log(SRC);
    console.log(`${nChains} chains, ${nRes} framed residues`);
    stats('aim', aim);
    stats('partner', partner);
    stats('twist', twist);
    stats('rungturn', RUNG);
    console.log(`  twist reversals (frame steps backward inside a stem): ${reversals}/${steps}`
        + ` = ${(100 * reversals / Math.max(1, steps)).toFixed(1)}%`);
})();
