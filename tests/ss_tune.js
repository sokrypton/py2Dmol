/* Tune the CA-only SS parameters against pydssp by coordinate descent.
 *
 *   python tests/ss_bench.py --build
 *   node tests/ss_tune.js
 *
 * Optimises Q3 over tests/out/ss_truth.json. Coordinate descent, not a grid:
 * the parameters are nearly separable (each gates a different geometric test)
 * and a full grid over 9 knobs is millions of evaluations.
 *
 * Reports the best setting found; apply it by editing the SS object in
 * cartoon/geom.js. Deliberately NOT written back automatically - a number
 * that wins on 151 chains still has to look right on screen.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TRUTH = path.resolve(__dirname, 'out/ss_truth.json');
const SRC = path.resolve(__dirname, '../src/cartoon/geom.js');

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

const api = loadCartoon();
const P = api.SS_PARAMS;
const data = JSON.parse(fs.readFileSync(TRUTH, 'utf8')).map((r) => {
    const n = r.ca.length;
    const flat = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
        flat[i * 3] = r.ca[i][0]; flat[i * 3 + 1] = r.ca[i][1]; flat[i * 3 + 2] = r.ca[i][2];
    }
    return { flat, n, dssp: r.dssp };
});

const IDX = { H: 0, E: 1, C: 2, '-': 2, T: 2 };

function q3() {
    let ok = 0; let tot = 0;
    for (const rec of data) {
        const s = api.extendSec(rec.flat, rec.n,
            api.smoothSec(api.makeSec(rec.flat, rec.n)));
        for (let i = 0; i < rec.n; i++) {
            if (IDX[s[i]] === IDX[rec.dssp[i]]) ok++;
            tot++;
        }
    }
    return 100 * ok / tot;
}

// name -> candidate values
const GRID = {
    maxGrowH: [0, 1, 2, 3],
    maxGrowE: [0, 1, 2, 3],
    helixDelta: [1.5, 1.7, 1.9, 2.1, 2.3, 2.5],
    strandDelta: [1.0, 1.2, 1.42, 1.6, 1.8, 2.0],
    strandDeltaExt: [1.2, 1.42, 1.6, 1.9, 2.2, 2.6, 3.0],
};
P.extMode = 'hyst';

const start = {};
for (const k of Object.keys(GRID)) start[k] = P[k];
let best = q3();
console.log('start Q3 =', best.toFixed(2), JSON.stringify(start));


// extPasses is swept in the OUTER loop, not by coordinate descent. Descent
// immediately sets it to 0 - which does beat the shipped setting - and once
// extension is off every other extendSec knob is dead, so the search can never
// discover a better EXTENDING configuration. Fixing it per sweep compares like
// with like.
const order = Object.keys(GRID).filter((k) => k !== 'maxGrowH');
const results = [];
for (const passes of GRID.maxGrowH) {
    for (const k of order) P[k] = start[k];
    P.maxGrowH = passes;
    best = q3();
    descend();
    const cur = { maxGrowH: passes };
    for (const k of order) cur[k] = P[k];
    results.push({ q3: best, params: cur });
    console.log(`maxGrowH=${passes}: Q3 = ${best.toFixed(2)}  ${JSON.stringify(cur)}`);
}
results.sort((a, b) => b.q3 - a.q3);
console.log('\nBEST Q3 =', results[0].q3.toFixed(2));
console.log(JSON.stringify(results[0].params, null, 2));

function descend() {
for (let round = 0; round < 4; round++) {
    let improvedAny = false;
    for (const k of order) {
        const keep = P[k];
        let bestV = keep;
        for (const v of GRID[k]) {
            if (v === keep) continue;
            P[k] = v;
            const s = q3();
            if (s > best + 1e-9) { best = s; bestV = v; improvedAny = true; }
        }
        P[k] = bestV;
    }
    if (!improvedAny) break;
}
}
