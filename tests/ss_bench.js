/* Score the renderer's CA-only secondary structure against pydssp.
 *
 *   python tests/ss_bench.py --build     # once, writes tests/out/ss_truth.json
 *   node tests/ss_bench.js               # report
 *   node tests/ss_bench.js --per-chain   # worst chains too
 *
 * Loads cartoon/geom.js directly (window shim) and calls the SAME exported
 * functions the renderer calls, so this can never score a stale
 * reimplementation of the algorithm.
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

function assign(api, ca, opts) {
    const n = ca.length;
    const flat = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
        flat[i * 3] = ca[i][0]; flat[i * 3 + 1] = ca[i][1]; flat[i * 3 + 2] = ca[i][2];
    }
    if (opts && opts.dssp) {
        // real DSSP rules on the backbone rebuilt from the C-alphas
        const coords = [];
        for (let i = 0; i < n; i++) coords.push({ x: ca[i][0], y: ca[i][1], z: ca[i][2] });
        let s2 = api.assignSecondary(coords, n, null, opts).sec;
        if (opts.smooth) s2 = api.smoothSec(s2);
        if (opts.extend) s2 = api.extendSec(flat, n, s2);
        return Array.isArray(s2) ? s2.join('') : s2;
    }
    let s = api.makeSec(flat, n);
    if (!opts || opts.smooth !== false) s = api.smoothSec(s);
    if ((!opts || opts.extend !== false) && api.extendSec) s = api.extendSec(flat, n, s);
    return Array.isArray(s) ? s.join('') : s;
}

function score(pred, truth) {
    // confusion over the three DSSP c3 classes
    const cls = ['H', 'E', '-'];
    const idx = { H: 0, E: 1, C: 2, '-': 2 };
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < truth.length; i++) {
        const t = idx[truth[i]];
        const p = idx[pred[i]] === undefined ? 2 : idx[pred[i]];
        m[t][p]++;
    }
    return { cls, m };
}

function report(name, conf) {
    const { cls, m } = conf;
    let total = 0; let correct = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { total += m[i][j]; if (i === j) correct += m[i][j]; }
    const lines = [];
    lines.push(`${name}: Q3 = ${(100 * correct / total).toFixed(2)}%  (${total} residues)`);
    lines.push('            pred H    pred E    pred C   |  recall');
    for (let i = 0; i < 3; i++) {
        const row = m[i];
        const sum = row[0] + row[1] + row[2];
        lines.push(`  true ${cls[i]}   ` + row.map((v) => String(v).padStart(8)).join('  ')
            + `   |  ${sum ? (100 * row[i] / sum).toFixed(1) : '  - '}%`);
    }
    const prec = [];
    for (let j = 0; j < 3; j++) {
        const col = m[0][j] + m[1][j] + m[2][j];
        prec.push(col ? (100 * m[j][j] / col).toFixed(1) + '%' : '-');
    }
    lines.push('  precision ' + prec.map((v) => v.padStart(8)).join('  '));
    return lines.join('\n');
}

(function main() {
    if (!fs.existsSync(TRUTH)) {
        console.error('missing ' + TRUTH + ' - run: python tests/ss_bench.py --build');
        process.exit(1);
    }
    const api = loadCartoon();
    if (!api || !api.makeSec) { console.error('cartoon/geom.js did not export makeSec'); process.exit(1); }
    const data = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));

    const variants = [
        { name: 'raw makeSec', opts: { smooth: false, extend: false } },
        { name: '+ smoothSec', opts: { extend: false } },
        { name: '+ extendSec (old CA-only pipeline)', opts: {} },
        { name: 'DSSP on rebuilt backbone (shipped)', opts: { dssp: true } },
        // ablations of the shipped pipeline
        { name: '  without ladder extension', opts: { dssp: true, extendLadder: 0 } },
        { name: "  stricter extension gate", opts: { dssp: true, extendGate: 'support' } },
        { name: "  with DSSP's own -0.5 cutoff", opts: { dssp: true, hbCutoff: -0.5 } },
        { name: '  + smoothSec (worse)', opts: { dssp: true, smooth: true } },
        { name: '  + extendSec (worse)', opts: { dssp: true, extend: true } },
    ];
    const perChain = process.argv.includes('--per-chain');

    for (const v of variants) {
        const conf = { cls: ['H', 'E', '-'], m: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] };
        const chains = [];
        for (const rec of data) {
            const pred = assign(api, rec.ca, v.opts);
            const c = score(pred, rec.dssp);
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) conf.m[i][j] += c.m[i][j];
            if (perChain) {
                let tot = 0; let ok = 0;
                for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { tot += c.m[i][j]; if (i === j) ok += c.m[i][j]; }
                chains.push({ id: rec.name + rec.chain, q3: 100 * ok / tot, n: tot });
            }
        }
        console.log(report(v.name, conf));
        if (perChain) {
            chains.sort((a, b) => a.q3 - b.q3);
            console.log('  worst: ' + chains.slice(0, 8)
                .map((c) => `${c.id} ${c.q3.toFixed(0)}%`).join('  '));
        }
        console.log();
    }
})();
