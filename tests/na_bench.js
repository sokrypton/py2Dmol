/* Score the base-frame prediction the renderer actually ships.
 *
 *   python tests/na_table.py --build   # once, writes tests/out/na_truth.json
 *   node tests/na_bench.js             # report
 *
 * py2Dmol keeps one atom per nucleotide, the C4'. Where the base points is
 * predicted from that trace (predictBaseFrames in cartoon/geom.js, reading
 * NA_BASE_TABLE). This scores that prediction against the real ring geometry:
 *
 *   direction   angle between the predicted C4'->base-centroid direction and
 *               the true one. This is what the ribbon faces along and where
 *               the base plate is drawn.
 *   normal      angle between the predicted and true base-plane normals, taken
 *               without regard to sign.
 *   coverage    fraction of nucleotides that get a frame at all (the window
 *               needs i-1 .. i+2, padded at chain ends and breaks).
 *
 * Loads cartoon/geom.js directly and calls its exported predictBaseFrames, so
 * this cannot score a stale reimplementation - tests/na_bench.py is the older
 * benchmark and does carry a replica of the frame construction.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TRUTH = path.resolve(__dirname, 'out/na_truth.json');
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

const unit = (a) => {
    const m = Math.hypot(a[0], a[1], a[2]);
    return m > 1e-9 ? [a[0] / m, a[1] / m, a[2] / m] : null;
};
const deg = (x) => Math.acos(Math.max(-1, Math.min(1, x))) * 180 / Math.PI;
const q = (a, p) => a[Math.floor(a.length * p)];

(function main() {
    if (!fs.existsSync(TRUTH)) {
        console.error('missing ' + TRUTH + ' - run: python tests/na_table.py --build');
        process.exit(1);
    }
    const api = loadCartoon();
    if (!api || !api.predictBaseFrames) {
        console.error('cartoon/geom.js did not export predictBaseFrames');
        process.exit(1);
    }
    const chains = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
    const errDir = [], errNrm = [];
    let total = 0, covered = 0;
    // and the sign check the renderer applies after pairing: a base points at
    // its partner. Scored here against pairs taken from the true geometry.
    let signWrong = 0, signPaired = 0;
    for (const ch of chains) {
        const n = ch.c4.length;
        const coords = ch.c4.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
        const pred = api.predictBaseFrames((i) => coords[i], n, () => true,
            (i) => ch.pur[i] === 1, (i) => ch.kinds[i] === 'D');
        const centre = (i) => [ch.c4[i][0] + ch.dirs[i][0], ch.c4[i][1] + ch.dirs[i][1],
            ch.c4[i][2] + ch.dirs[i][2]];
        for (let i = 0; i < n; i++) {
            total++;
            const o = i * 6;
            const pd = unit([pred[o], pred[o + 1], pred[o + 2]]);
            if (!pd) continue;
            covered++;
            const td = unit(ch.dirs[i]);
            errDir.push(deg(pd[0] * td[0] + pd[1] * td[1] + pd[2] * td[2]));
            const pn = unit([pred[o + 3], pred[o + 4], pred[o + 5]]);
            const tn = unit(ch.norms[i]);
            if (pn && tn) errNrm.push(deg(Math.abs(pn[0] * tn[0] + pn[1] * tn[1] + pn[2] * tn[2])));
            // nearest partner by true base geometry
            for (let j = 0; j < n; j++) {
                if (Math.abs(i - j) < 3) continue;
                const ci = centre(i), cj = centre(j);
                const sep = Math.hypot(ci[0] - cj[0], ci[1] - cj[1], ci[2] - cj[2]);
                if (sep > 6.0) continue;
                const cop = Math.abs(ch.norms[i][0] * ch.norms[j][0]
                    + ch.norms[i][1] * ch.norms[j][1] + ch.norms[i][2] * ch.norms[j][2]);
                if (cop < 0.8) continue;
                signPaired++;
                const to = unit([ch.c4[j][0] - ch.c4[i][0], ch.c4[j][1] - ch.c4[i][1],
                    ch.c4[j][2] - ch.c4[i][2]]);
                if (to && pd[0] * to[0] + pd[1] * to[1] + pd[2] * to[2] < 0) signWrong++;
                break;
            }
        }
    }
    errDir.sort((a, b) => a - b);
    errNrm.sort((a, b) => a - b);
    console.log(`${chains.length} chains, ${total} nucleotides, coverage `
        + `${(100 * covered / total).toFixed(1)}%\n`);
    console.log('                median     p75     p90    >90deg');
    console.log(`  direction    ${q(errDir, .5).toFixed(1).padStart(6)}  `
        + `${q(errDir, .75).toFixed(1).padStart(6)}  ${q(errDir, .9).toFixed(1).padStart(6)}  `
        + `${(100 * errDir.filter((x) => x > 90).length / errDir.length).toFixed(1).padStart(7)}%`);
    console.log(`  normal       ${q(errNrm, .5).toFixed(1).padStart(6)}  `
        + `${q(errNrm, .75).toFixed(1).padStart(6)}  ${q(errNrm, .9).toFixed(1).padStart(6)}`);
    console.log(`\n  paired residues whose predicted base points AWAY from its partner: `
        + `${(100 * signWrong / Math.max(1, signPaired)).toFixed(1)}% `
        + `(${signWrong}/${signPaired}) - the renderer flips these after pairing`);
})();
