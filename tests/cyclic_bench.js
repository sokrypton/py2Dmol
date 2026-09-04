/* Score the renderer's secondary structure on CYCLIC peptides.
 *
 *   python tests/cyclic_bench.py --build   # once, writes out/cyclic_truth.json
 *   node tests/cyclic_bench.js             # report
 *   node tests/cyclic_bench.js --per-chain # worst chains too
 *
 * The headline number is not overall Q3 - most of a cyclic peptide is nowhere
 * near its closure and scores like any other chain, which drowns the effect.
 * What matters is the SEAM: the residues on either side of the head-to-tail
 * bond, where an index-walking assigner runs out of chain and an element that
 * crosses the closure is cut in two. Overall and seam-only are both reported,
 * and the gap between them is the thing to drive to zero.
 *
 * Loads cartoon/geom.js directly and calls the same exported entry point the
 * renderer calls, so this cannot score a stale reimplementation.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TRUTH = path.resolve(__dirname, 'out/cyclic_truth.json');
const SRC = path.resolve(__dirname, '../src/cartoon/geom.js');
const SEAM = 4;   // residues each side of the closure counted as "seam"

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

// Minimal 2D context: the ribbon frame is only reachable by rendering, and the
// numbers we want out of it are geometric, so nothing has to draw.
function mkCtx() {
    return {
        canvas: { width: 400, height: 400 },
        lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over',
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
        stroke() {}, fill() {}, arc() {},
        createLinearGradient() { return { addColorStop() {} }; },
        fillStyle: '#000', strokeStyle: '#000',
    };
}

// Worst turn of the ribbon FACE between consecutive residues, closure included.
// Two consecutive sides pointing opposite ways make the strip cross itself - a
// bow-tie - pinching through zero width on the way, so this is the number that
// says whether a ring's frame is sane. Inside a run the sign pass keeps it
// small; the closure is the step that pass never sees, which is where a whole
// ring's accumulated sign used to land.
function frameTwist(api, r0) {
    const n = r0.n;
    const coords = r0.ca.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
    const segs = [];
    for (let i = 0; i < n - 1; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1 });
    segs.push({ type: 'P', idx1: 0, idx2: n - 1 });          // head-to-tail
    const r = {
        coords, rotatedCoords: coords, segmentIndices: segs,
        positionTypes: new Array(n).fill('P'),
        positionNames: new Array(n).fill('ALA'),
        viewerState: { extent: 30, zoom: 1, ortho: 1, focalLength: 100 },
        objectsData: { obj: { maxExtent: 30 } }, currentObjectName: 'obj', currentFrame: 0,
        lineWidth: 3, visibilityMask: null, outlineMode: 'on', relativeOutlineWidth: 3,
        shadowEnabled: true, cartoonShade: 1, colorMode: 'chain', screenFrameId: 0,
        screenX: new Float64Array(n), screenY: new Float64Array(n),
        screenRadius: new Float64Array(n), screenValid: new Uint8Array(n),
        _calculateSegmentWidthMultiplier: () => 1,
        overlayState: { enabled: false }, _sideProbe: null,
    };
    api.render(r, mkCtx(), 400, 400, segs.map(() => ({ r: 100, g: 140, b: 220 })));
    const S = r._sideProbe || {};
    let worst = 0; let over90 = 0; let seam = null;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = S[i]; const b = S[j];
        if (!a || !b) continue;
        const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
        const deg = (Math.acos(d) * 180) / Math.PI;
        if (i === n - 1) seam = deg;
        if (deg > 90) over90++;
        if (deg > worst) worst = deg;
    }
    return { worst, over90, seam };
}

function assign(api, ca, opts) {
    const n = ca.length;
    const coords = [];
    for (let i = 0; i < n; i++) coords.push({ x: ca[i][0], y: ca[i][1], z: ca[i][2] });
    const s = api.assignSecondary(coords, n, null, opts).sec;
    return Array.isArray(s) ? s.join('') : s;
}

// indices within SEAM residues of the closure, i.e. either end of the array
function seamIndices(n) {
    const out = [];
    for (let i = 0; i < Math.min(SEAM, n); i++) out.push(i);
    for (let i = Math.max(0, n - SEAM); i < n; i++) if (out.indexOf(i) < 0) out.push(i);
    return out;
}

function q3(pairs) {
    let hit = 0;
    for (const [p, t] of pairs) {
        const pc = p === '-' ? 'C' : p;
        const tc = t === '-' ? 'C' : t;
        if (pc === tc) hit++;
    }
    return pairs.length ? (100 * hit) / pairs.length : NaN;
}

function main() {
    if (!fs.existsSync(TRUTH)) {
        console.error('run: python tests/cyclic_bench.py --build');
        process.exit(1);
    }
    const api = loadCartoon();
    const records = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
    const perChain = process.argv.includes('--per-chain');

    // Two configurations: what the renderer does today (the chain is walked as
    // a line) and what it does when told the run is a ring.
    const MODES = [
        { key: 'linear', label: 'as a linear chain (current)', opts: () => null },
        {
            key: 'ring',
            label: 'told the run is cyclic',
            opts: (n) => ({ rings: [[0, n - 1]] }),
        },
    ];

    const rows = [];
    for (const mode of MODES) {
        const all = [];
        const seam = [];
        const chains = [];
        for (const r of records) {
            const pred = assign(api, r.ca, mode.opts(r.n));
            const truth = r.dssp;
            const p = [];
            for (let i = 0; i < r.n; i++) p.push([pred[i] || 'C', truth[i]]);
            all.push(...p);
            const sIdx = seamIndices(r.n);
            const sp = sIdx.map((i) => [pred[i] || 'C', truth[i]]);
            seam.push(...sp);
            chains.push({ name: `${r.name}_${r.chain}`, n: r.n, q3: q3(p), seam: q3(sp) });
        }
        rows.push({ mode, all: q3(all), seam: q3(seam), n: all.length,
            nSeam: seam.length, chains });
    }

    console.log(`cyclic SS benchmark: ${records.length} chains, `
        + `${records.reduce((a, r) => a + r.n, 0)} residues`);
    console.log(`(seam = ${SEAM} residues each side of the head-to-tail bond)\n`);
    const pad = (s, w) => String(s).padEnd(w);
    console.log(pad('', 30) + '  overall Q3   seam Q3');
    for (const row of rows) {
        console.log(pad(row.mode.label, 30)
            + '  ' + pad(row.all.toFixed(1) + '%', 11)
            + '  ' + row.seam.toFixed(1) + '%');
    }
    const d = rows[1].seam - rows[0].seam;
    console.log(`\nseam delta: ${d >= 0 ? '+' : ''}${d.toFixed(1)} points `
        + `(${rows[0].nSeam} seam residues scored)`);

    // 🔴 A FLOOR, BECAUSE A BENCH THAT ASSERTS NOTHING CAN ONLY FAIL BY
    // CRASHING - the rule this file already learnt as tests/na_frame.js.
    // The numbers here are 88.7% overall and 87.0% at the seam; the floors
    // are set below those with room for a real improvement to move them and
    // not so low that a regression slips under. What they guard is the
    // exception in assignSecondary that lets a rotated pass report coil when
    // the ring IS the whole structure: removing it drops the seam to 85.9%,
    // and nothing else in the suite would have noticed. Its other half - a
    // ring bound to a partner, where that same downgrade must be refused -
    // is tests/cyclic_partner.js.
    const SEAM_FLOOR = 86.0;
    const OVERALL_FLOOR = 88.0;
    // `q3()` already returns PERCENT and the field is `all`, not `q3` - the
    // first version of this check multiplied by 100 and read an undefined
    // field, so it compared 8590 against 86 and NaN against 88 and could
    // never fail. Read the same fields the table above prints.
    const cyc = rows[1];
    if (cyc.seam < SEAM_FLOOR) {
        console.log(`FAIL cyclic_bench: seam Q3 ${cyc.seam.toFixed(1)}%`
            + ` is below the ${SEAM_FLOOR}% floor`);
        process.exitCode = 1;
    }
    if (cyc.all < OVERALL_FLOOR) {
        console.log(`FAIL cyclic_bench: overall Q3 ${cyc.all.toFixed(1)}%`
            + ` is below the ${OVERALL_FLOOR}% floor`);
        process.exitCode = 1;
    }

    // CONTROL: a ring has no canonical first residue, so cutting it somewhere
    // else must give the same answer rotated. Cuts are taken in the MIDDLE of a
    // secondary-structure element, which is where a linear assigner is worst -
    // it has to rebuild an element it can only see half of. Anything less than
    // 100% here means the ring handling still depends on where the chain
    // happens to have been numbered.
    let rot = { chains: 0, ok: 0, cuts: 0, exact: 0 };
    for (const r of records) {
        const base = assign(api, r.ca, { rings: [[0, r.n - 1]] });
        // shift to the middle of each run of H or E, up to four per chain
        const cuts = [];
        for (let i = 0; i < r.n && cuts.length < 4; i++) {
            const c = base[i];
            if (c !== 'H' && c !== 'E') continue;
            let j = i;
            while (j + 1 < r.n && base[j + 1] === c) j++;
            if (j - i >= 2) cuts.push(((i + j) >> 1));
            i = j;
        }
        if (!cuts.length) continue;
        rot.chains++;
        let allOk = true;
        for (const s of cuts) {
            const ca = r.ca.slice(s).concat(r.ca.slice(0, s));
            const got = assign(api, ca, { rings: [[0, r.n - 1]] });
            const want = base.slice(s) + base.slice(0, s);
            rot.cuts++;
            if (got === want) rot.exact++; else allOk = false;
        }
        if (allOk) rot.ok++;
    }
    console.log(`\ncontrol - cut each ring mid-element and re-assign:`);
    console.log(`  ${rot.exact}/${rot.cuts} cuts reproduce the same SS, rotated`
        + ` (${rot.ok}/${rot.chains} chains exact)`);

    // RIBBON FRAME. Separate from the SS numbers above: this is about the
    // geometry the strip is built from, not the classification.
    let twWorst = 0; let twOver = 0; let twSeamWorst = 0; let twChains = 0;
    const twBad = [];
    for (const r of records) {
        let t;
        try { t = frameTwist(api, r); } catch (e) { continue; }
        twChains++;
        twOver += t.over90;
        if (t.worst > twWorst) twWorst = t.worst;
        if (t.seam !== null && t.seam > twSeamWorst) twSeamWorst = t.seam;
        if (t.over90) twBad.push(`${r.name}_${r.chain}(${t.over90})`);
    }
    console.log(`\nribbon frame over ${twChains} rings `
        + `(face turn between consecutive residues, closure included):`);
    console.log(`  worst interval anywhere ${twWorst.toFixed(0)} deg, `
        + `worst closure ${twSeamWorst.toFixed(0)} deg, `
        + `${twOver} interval(s) over 90 deg`
        + (twBad.length ? ` - ${twBad.join(' ')}` : ''));

    if (perChain) {
        console.log('\nper chain (seam Q3, linear -> ring):');
        const a = rows[0].chains, b = rows[1].chains;
        a.map((c, i) => ({ name: c.name, n: c.n, from: c.seam, to: b[i].seam }))
            .sort((x, y) => (x.to - x.from) - (y.to - y.from))
            .forEach((c) => {
                const mark = c.to > c.from ? ' +' : (c.to < c.from ? ' -' : '  ');
                console.log(`  ${pad(c.name, 10)} n=${pad(c.n, 5)}`
                    + `${c.from.toFixed(0)}% -> ${c.to.toFixed(0)}%${mark}`);
            });
    }
}

main();
