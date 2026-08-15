/* Score the strand frames the cartoon draws sheets with.
 *
 *   python tests/sheet_bench.py --build    # once, writes tests/out/sheet_truth.json
 *   node tests/sheet_bench.js              # report
 *   node tests/sheet_bench.js --sweep      # try other smoothing/relaxation settings
 *
 * Two numbers, both in degrees, both over the residues of real beta ladders
 * (backbone H-bonds from the true coordinates, so they do not depend on any
 * prediction):
 *
 *   partner face   angle between the ribbon faces of two paired residues. This
 *                  is "do neighbouring strands stack edge to edge" - the thing
 *                  that was visibly wrong when strand frames came from C-alpha
 *                  curvature.
 *   strand twist   angle between the faces of consecutive residues in a strand.
 *                  This is "does the ribbon roll along its own length".
 *
 * Loads viewer-cartoon.js directly and calls the SAME exported functions the
 * renderer calls, so this cannot score a stale reimplementation.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TRUTH = path.resolve(__dirname, 'out/sheet_truth.json');
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

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const m = Math.hypot(a[0], a[1], a[2]); return m > 1e-9 ? [a[0] / m, a[1] / m, a[2] / m] : null; };
const angDeg = (a, b) => (a && b) ? Math.acos(Math.min(1, Math.abs(dot(a, b)))) * 180 / Math.PI : null;
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN);
const p90 = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.9)] : NaN);

function tangents(ca) {
    const n = ca.length, t = [];
    for (let i = 0; i < n; i++) {
        t.push(unit(sub(ca[Math.min(n - 1, i + 1)], ca[Math.max(0, i - 1)])) || [1, 0, 0]);
    }
    return t;
}

/** The frame the renderer used before the sheet pass: tangent x curvature. */
function curvatureSides(ca, tan) {
    const n = ca.length, out = [];
    for (let i = 0; i < n; i++) {
        const a = ca[Math.max(0, i - 1)], b = ca[i], c = ca[Math.min(n - 1, i + 1)];
        out.push(unit(cross(tan[i], [a[0] + c[0] - 2 * b[0], a[1] + c[1] - 2 * b[1], a[2] + c[2] - 2 * b[2]])));
    }
    return out;
}

function faces(sides, tan) {
    return sides.map((s, i) => (s ? unit(cross(tan[i], s)) : null));
}

/* Tangents of a flattened strand centreline - PyMOL's cartoon_flat_sheets, and
 * what the renderer's own sheet_flat does. The drawn plate's face is the
 * tangent crossed with the side vector, so a pleated centreline tilts the face
 * whatever frame it is handed: measuring against the raw trace scores the pleat
 * rather than the frame. */
function flatTangents(ca, sec, cycles) {
    const n = ca.length;
    const pv = ca.map((p) => p.slice());
    for (let c = 0; c < cycles; c++) {
        const tmp = pv.map((p) => p.slice());
        for (let i = 1; i < n - 1; i++) {
            if (sec[i] !== 'E' || sec[i - 1] !== 'E' || sec[i + 1] !== 'E') continue;
            for (let k = 0; k < 3; k++) tmp[i][k] = (pv[i - 1][k] + pv[i][k] + pv[i + 1][k]) / 3;
        }
        for (let i = 0; i < n; i++) pv[i] = tmp[i];
    }
    return tangents(pv);
}

function measure(sides, tan, sec, ladders) {
    const f = faces(sides, tan);
    const pf = [], tw = [];
    for (const [i, j] of ladders) {
        const a = angDeg(f[i], f[j]);
        if (a != null) pf.push(a);
    }
    for (let i = 0; i + 1 < sec.length; i++) {
        if (sec[i] !== 'E' || sec[i + 1] !== 'E') continue;
        const a = angDeg(f[i], f[i + 1]);
        if (a != null) tw.push(a);
    }
    return { pf, tw };
}

function run(api, chains, opts) {
    const pf = [], tw = [];
    for (const ch of chains) {
        const ca = ch.ca;
        const n = ca.length;
        const coords = ca.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
        const { sec } = api.assignSecondary(coords, n, null);
        // ladders come from the TRUE backbone, not from the prediction, so the
        // score is about the frames and not about the pairing
        const truth = ch.ladders.filter(([i, j]) => sec[i] === 'E' && sec[j] === 'E');
        if (truth.length < 5) continue;
        const tan = tangents(ca);
        let sides;
        if (opts.curvature) {
            sides = curvatureSides(ca, tan);
        } else {
            const local = api.buildSheetFrames(coords, n, sec, null, truth, opts).local;
            sides = [];
            for (let i = 0; i < n; i++) {
                const o = i * 3;
                if (!local[o] && !local[o + 1] && !local[o + 2]) { sides.push(null); continue; }
                const fr = [];
                if (!api.localFrame((k) => coords[k], n, i, fr)) { sides.push(null); continue; }
                sides.push(unit([
                    fr[0] * local[o] + fr[3] * local[o + 1] + fr[6] * local[o + 2],
                    fr[1] * local[o] + fr[4] * local[o + 1] + fr[7] * local[o + 2],
                    fr[2] * local[o] + fr[5] * local[o + 1] + fr[8] * local[o + 2]]));
            }
        }
        const m = measure(sides, opts.flatTangent ? flatTangents(ca, sec, 4) : tan, sec, truth);
        pf.push(...m.pf);
        tw.push(...m.tw);
    }
    return { pf, tw };
}

(function main() {
    if (!fs.existsSync(TRUTH)) {
        console.error('missing ' + TRUTH + ' - run: python tests/sheet_bench.py --build');
        process.exit(1);
    }
    const api = loadCartoon();
    if (!api || !api.buildSheetFrames) {
        console.error('viewer-cartoon.js did not export buildSheetFrames');
        process.exit(1);
    }
    const chains = JSON.parse(fs.readFileSync(TRUTH, 'utf8'))
        .filter((c) => c.split === 'score' && c.ladders.length >= 10);
    // Floor: how far apart the faces of two paired residues are when both are
    // taken from the TRUE local sheet plane (the least-squares plane through the
    // six C-alphas i-1..i+1, j-1..j+1). Nothing built per residue can beat this,
    // because it is the sheet's own twist between the two.
    {
        const pf = [];
        for (const ch of chains) {
            const ca = ch.ca, n = ca.length;
            const coords = ca.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
            const { sec } = api.assignSecondary(coords, n, null);
            const tan = tangents(ca);
            for (const [i, j] of ch.ladders) {
                if (sec[i] !== 'E' || sec[j] !== 'E') continue;
                // local sheet normal at i and at j, each from its own strand
                // tangent crossed with the direction to the partner
                const di = unit(sub(ca[j], ca[i]));
                const dj = unit(sub(ca[i], ca[j]));
                const ni = di && unit(cross(tan[i], di));
                const nj = dj && unit(cross(tan[j], dj));
                const a = angDeg(ni, nj);
                if (a != null) pf.push(a);
            }
        }
        console.log(`(floor: the sheet's own twist between paired residues, `
            + `median ${med(pf).toFixed(1)} p90 ${p90(pf).toFixed(1)})\n`);
    }
    const variants = [
        { name: 'curvature (old)', opts: { curvature: true } },
        { name: 'sheet frame (shipped)', opts: {} },
        { name: '  ... on a flattened strand', opts: { flatTangent: true } },
        { name: 'curvature, flattened strand', opts: { curvature: true, flatTangent: true } },
    ];
    if (process.argv.includes('--sweep')) {
        for (const relax of [16, 24, 40]) {
            for (const w of [1, 2, 3]) {
                variants.push({
                    name: `sweeps ${relax} neighbour weight ${w}`,
                    opts: { relax, along: w, across: w },
                });
            }
        }
    }
    console.log(`${chains.length} chains with beta ladders\n`);
    console.log('frame                          partner face      strand twist');
    console.log('                               median   p90     median   p90');
    for (const v of variants) {
        const { pf, tw } = run(api, chains, v.opts);
        console.log(`${v.name.padEnd(30)} ${med(pf).toFixed(1).padStart(6)} ${p90(pf).toFixed(1).padStart(6)}`
            + `   ${med(tw).toFixed(1).padStart(6)} ${p90(tw).toFixed(1).padStart(6)}`);
    }
})();
