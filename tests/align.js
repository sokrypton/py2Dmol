// TM-align, and the four decisions the viewer makes around it.
//
//     node tests/align.js
//
// The algorithm itself is not retested here - it is a generated copy of
// foldjs/lib/tmalign.js, whose parity against TMalign.cpp is checked upstream
// to 1.1e-16, and the FIRST thing this file does is prove the copy has not
// drifted. What is tested is everything the algorithm does not know:
//
//   * WHICH COORDINATES go in. Protein C-alpha only - the port has no RNA
//     parameter sets - and short chains dropped, because TM-align's d0 is
//     clamped below 15 residues and the score there is noise with a confident
//     face on.
//   * WHICH CHAIN of a multi-chain object is the match. Not the first and not
//     the longest: the answer is often chain D of a hetero-complex.
//   * WHICH SCORE RANKS them. TM1 is normalised by the REFERENCE and TM2 by
//     the chain being moved, so TM2 hands the win to whichever chain is
//     shortest - a 30-residue fragment that fits perfectly beats a whole
//     domain that fits well. The fixture below is built so the two disagree.
//   * WHICH DIRECTION the transform goes. TM-align moves chain 1 onto chain 2;
//     get it backwards and everything flies apart instead of coming together,
//     which is a silent 2x error - the score is identical either way.
const fs = require('fs');
const L = require('./lift.js');
// ...and a reader that knows the web app is five files. A loop over file NAMES
// cannot open 'the web app'; this maps that one name onto lift.js's
// concatenation and reads everything else from disk.
const readNamed = (f) => (f === 'the web app' ? L.app
    : require('fs').readFileSync(f, 'utf8'));

const path = require('path');

// The seam inside align/align.js: everything before it is the generated copy
// of foldjs's TM-align, everything after it is this repo's own code. Named
// here so a source-text check can look at one half without the other.
const END_MARK = '// <<< END GENERATED';

/** Eight C-alpha on an ideal helix, flat - just enough for makeSec to answer. */
function helixFlat(n) {
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
        const th = i * 100 * Math.PI / 180;
        out[i * 3] = 2.3 * Math.cos(th); out[i * 3 + 1] = 2.3 * Math.sin(th);
        out[i * 3 + 2] = 1.5 * i;
    }
    return out;
}

global.self = global;
eval(fs.readFileSync('src/align/align.js', 'utf8'));
const Align = global.Align;
// The algorithm is inside that file, so the only way at it from out here is
// what the file chooses to expose. tmAlign is exposed for exactly this: the
// fixture below is only a test of the RANKING if the two scores it ranks by
// can be read directly.
const TM = Align.tmAlign ? Align : null;
if (!TM) { console.log('FAIL: align/align.js does not expose tmAlign'); process.exit(1); }

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); fails++; } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol,
    `${msg}: ${a} is not within ${tol} of ${b}`);

// --- the copy is the upstream file, derived ---------------------------------
// Asked of the GENERATOR rather than repeated here. A paraphrase of the
// derivation would let the two drift apart and still agree with each other,
// which is the exact failure this check exists to catch: an earlier version of
// it looked for the upstream body INSIDE the vendored file, and a line appended
// to the end of that file passed it.
{
    const r = require('child_process').spawnSync(
        process.execPath, [path.join(__dirname, 'vendor_tmalign.mjs')],
        { encoding: 'utf8' });
    if (r.status === 2) {
        console.log('note: no ../foldjs checkout - the drift check did not run');
    } else {
        ok(r.status === 0, "align/align.js's TM-align is not what"
            + ' foldjs/lib/tmalign.js derives to - regenerate with:'
            + ' node tests/vendor_tmalign.mjs --write');
    }
}

// --- one file, and nothing else to load -------------------------------------
{
    // THE ALGORITHM IS INSIDE THIS FILE. It was a second script once, which
    // meant two <script> tags, two names in the worker's importScripts, and two
    // ways for a page to end up with half the feature - the aligner present and
    // its arithmetic missing, or the reverse.
    ok(typeof Align.makeSec === 'function' && Align.makeSec(helixFlat(8), 8).length === 8,
        'align/align.js does not carry TM-align - it is loading it from somewhere');
    const src = fs.readFileSync('src/align/align.js', 'utf8');
    ok(src.indexOf(END_MARK) > 0 && src.indexOf('// >>> BEGIN GENERATED') >= 0,
        'the generated region has lost its markers, so nothing can check it');
    // ...ONE file, AND THE WORKER CARRIES IT RATHER THAN A PATH TO IT.
    // This has been wrong twice. First the worker rebuilt the path as
    // base + 'align/align.js' - the filename written a second time - and a
    // rename left it asking for a file that was not there. Then it used the
    // script's own url, which cannot go stale but still has to be FETCHABLE:
    // on a page opened from file:// Chrome refuses importScripts outright,
    // and the promise rejected instead of falling back, so local pages got an
    // uncaught NetworkError and no alignment at all. A function knows its own
    // text, so the Blob is the module itself and there is no url to be wrong.
    const boot = /boot = [^;]*;/.exec(src);
    ok(boot && /py2dmolAlignModule/.test(boot[0]),
        'the worker boot is built from something other than this module\'s own'
        + ' source, so it depends on fetching a url again: ' + (boot && boot[0]));
    ok(boot && !/\.js'/.test(boot[0]) && !/importScripts/.test(boot[0]),
        'the worker boot names a file or imports one: ' + (boot && boot[0]));
    // ...and the module has to BE a named function for that to be possible.
    ok(/var py2dmolAlignModule = function \(global\) \{/.test(src),
        'the module is not a named function any more, so its source cannot be'
        + ' handed to a worker and the url is back');
    // 🔴 AND A WORKER THAT WILL NOT START IS NOT A FAILED ALIGNMENT. Every
    // way of failing to get one used to reject, so anything that stopped the
    // worker stopped the feature - when the same job runs here, just slower.
    ok(/w\.onerror = fallback;/.test(src),
        'a worker that errors no longer falls back to the main thread');
    ok(/catch \(e\) \{ fallback\(\); return; \}/.test(src),
        'a worker that cannot be constructed no longer falls back');
    // ...and nothing anywhere still points at the file that used to hold it
    for (const f of ['index.html', 'src/core/mol.js', 'the web app']) {
        ok(readNamed(f).indexOf('resources/tmalign.js') < 0,
            `${f} still loads resources/tmalign.js, which no longer exists`);
    }
    ok(!fs.existsSync('py2Dmol/resources/tmalign.js'),
        'py2Dmol/resources/tmalign.js is back - there are two copies again');
}

// --- fixtures ---------------------------------------------------------------
// AN IDEAL ALPHA HELIX, whose answer is known: aligned to a rotated copy of
// itself the score is 1 and the RMSD is 0, so any departure is the code's.
function helix(n, phase) {
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
        const th = (i + (phase || 0)) * 100 * Math.PI / 180;
        out[i * 3] = 2.3 * Math.cos(th);
        out[i * 3 + 1] = 2.3 * Math.sin(th);
        out[i * 3 + 2] = 1.5 * i;
    }
    return out;
}
function extended(n) {
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { out[i * 3] = 3.3 * i; out[i * 3 + 1] = (i % 2) * 0.9; }
    return out;
}
// a rotation nothing could reach by accident: 37 degrees about each axis
function rotmat(a, b, c) {
    const ca = Math.cos(a); const sa = Math.sin(a);
    const cb = Math.cos(b); const sb = Math.sin(b);
    const cc = Math.cos(c); const sc = Math.sin(c);
    return [
        cb * cc, -cb * sc, sb,
        sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb,
        -ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb];
}
function moved(flat, n, R, T) {
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
        const x = flat[i * 3]; const y = flat[i * 3 + 1]; const z = flat[i * 3 + 2];
        out[i * 3] = T[0] + R[0] * x + R[1] * y + R[2] * z;
        out[i * 3 + 1] = T[1] + R[3] * x + R[4] * y + R[5] * z;
        out[i * 3 + 2] = T[2] + R[6] * x + R[7] * y + R[8] * z;
    }
    return out;
}
const asCoords = (flat, n) => Array.from({ length: n },
    (_, i) => [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]);

// --- which coordinates go in ------------------------------------------------
{
    // 20 protein residues on chain A, 6 on chain B, 4 ligand atoms, 20 RNA
    const coords = []; const types = []; const ids = [];
    const push = (n, t, id) => {
        const h = helix(n);
        for (let i = 0; i < n; i++) {
            coords.push([h[i * 3], h[i * 3 + 1], h[i * 3 + 2]]); types.push(t); ids.push(id);
        }
    };
    push(20, 'P', 'A'); push(6, 'P', 'B'); push(4, 'L', 'A'); push(20, 'R', 'C');
    const got = Align.chainsOf(coords, types, ids, null);
    ok(got.length === 1, `only chain A is long enough and protein: got `
        + JSON.stringify(got.map((c) => [c.id, c.len])));
    if (got.length) {
        ok(got[0].id === 'A' && got[0].len === 20, `chain A, 20 residues: ${got[0].id} ${got[0].len}`);
        ok(got[0].index[0] === 0 && got[0].index[19] === 19,
            'the index says which position each C-alpha came from');
        // the ligand sits at positions 26-29 and must not be in it
        ok(Array.from(got[0].index).every((i) => i < 20),
            'a ligand atom got into the C-alpha trace');
    }
    // ...and a selection narrows it, keeping the positions it names
    const only = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const sub = Align.chainsOf(coords, types, ids, only);
    ok(sub.length === 1 && sub[0].len === 15,
        `a selection is the reference: ${sub.map((c) => c.len)}`);
    ok(sub.length && sub[0].index[0] === 2, 'the selection kept its own positions');
    // below MIN_CHAIN there is nothing to align
    const tiny = Align.chainsOf(coords, types, ids, new Set([0, 1, 2, 3]));
    ok(tiny.length === 0, 'a four-residue pick was accepted as a reference');
}

// --- which chain, which score, which direction ------------------------------
{
    const N = 60;
    const ref = helix(N);
    const R = rotmat(0.64, 0.64, 0.64);
    const T = [11, -23, 7];

    // Chain 'X' is a PERFECT HALF of the reference; chain 'Y' is the WHOLE of it
    // with 1.2 A of wobble. Under TM2 (normalised by the moved chain) X wins,
    // because half of it fits exactly. Under TM1 (normalised by the reference)
    // Y wins, because it accounts for the whole reference. Y is the right
    // answer: it is the same domain.
    const half = ref.slice(0, 30 * 3);
    const wobbly = new Float64Array(ref);
    for (let i = 0; i < N; i++) {
        wobbly[i * 3] += 1.2 * Math.sin(i * 1.7);
        wobbly[i * 3 + 1] += 1.2 * Math.cos(i * 2.3);
    }
    const target = {
        name: 'twochain',
        chains: [
            { id: 'X', len: 30, flat: moved(half, 30, R, T) },
            { id: 'Y', len: N, flat: moved(wobbly, N, R, T) }
        ]
    };
    const got = Align.alignOne({ flat: ref, len: N }, target, true);
    console.log(`  two chains against a 60-residue reference -> chain ${got.chain},`
        + ` TM1 ${got.tm.toFixed(3)} TM2 ${got.tmOwn.toFixed(3)},`
        + ` RMSD ${got.rmsd.toFixed(2)} over ${got.aligned}`);

    // the fixture is only a test of the ranking if the two scores DISAGREE
    const sX = TM.tmAlign(target.chains[0].flat.slice(), ref.slice(), 30, N, {});
    const sY = TM.tmAlign(target.chains[1].flat.slice(), ref.slice(), N, N, {});
    ok(sX.TM2 > sY.TM2 && sY.TM1 > sX.TM1,
        `the fixture does not separate TM1 from TM2 - X(${sX.TM1.toFixed(2)},`
        + `${sX.TM2.toFixed(2)}) Y(${sY.TM1.toFixed(2)},${sY.TM2.toFixed(2)})`);
    ok(got.chain === 'Y', `the shorter perfect fragment was preferred to the whole`
        + ` domain - that is TM2 ranking, not TM1: got chain ${got.chain}`);

    // WHICH DIRECTION. The transform must carry the MOVED chain onto the
    // reference. Applied the other way the score would be identical and the
    // picture would be wrong, so it is checked as a distance and not a score.
    const back = moved(target.chains[1].flat, N, got.u, got.t);
    let worst = 0;
    for (let i = 0; i < N; i++) {
        const dx = back[i * 3] - ref[i * 3];
        const dy = back[i * 3 + 1] - ref[i * 3 + 1];
        const dz = back[i * 3 + 2] - ref[i * 3 + 2];
        worst = Math.max(worst, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    // 1.2 A of wobble was put in by hand, so 2 A is the honest bound
    ok(worst < 2.0, `t/u did not bring the moved chain to the reference:`
        + ` worst atom ${worst.toFixed(1)} A away`);

    // ...and with no wobble it is exact
    const clean = { name: 'clean', chains: [{ id: 'A', len: N, flat: moved(ref, N, R, T) }] };
    const cg = Align.alignOne({ flat: ref, len: N }, clean, true);
    near(cg.tm, 1.0, 1e-6, 'a rotated copy of the reference does not score 1');
    near(cg.rmsd, 0.0, 1e-3, 'a rotated copy of the reference has a non-zero RMSD');
}

// --- both hosts run at the same settings ------------------------------------
{
    // WHICH SEARCH IS A DECISION, not a per-caller detail. It was one once: the
    // worker asked for the full search and the main-thread fallback for the
    // fast one, so the notebook build and the web app quietly answered
    // differently - and on the three cases in fifteen where the two searches
    // disagree, they disagreed by 0.3 TM, not by a rounding.
    ok(Align.FULL_SEARCH === false,
        'FULL_SEARCH is on - the full search is 2-4x slower for the same answer'
        + ' on 41 of 44 measured pairs; if this was deliberate, say so here');
    const src = fs.readFileSync('src/align/align.js', 'utf8')
        .split(END_MARK)[1];   // ...the hand-written half only
    ok(!/full:\s*(true|false)\b/.test(src),
        'a call site names the search settings itself instead of reading'
        + ' FULL_SEARCH - that is how the two hosts drifted apart before');
    ok((src.match(/full: FULL_SEARCH/g) || []).length === 2,
        'both hosts - the worker and the main-thread fallback - must read'
        + ' FULL_SEARCH, so a page cannot answer differently from a notebook');
}

// --- the decoy that is longer than the match --------------------------------
{
    const N = 60;
    const ref = helix(N);
    const R = rotmat(-0.9, 0.3, 1.4);
    const target = {
        name: 'decoy',
        chains: [
            { id: 'A', len: 120, flat: extended(120) },        // longest, and wrong
            { id: 'B', len: N, flat: moved(ref, N, R, [4, 4, 4]) }
        ]
    };
    const got = Align.alignOne({ flat: ref, len: N }, target, true);
    ok(got.chain === 'B', `the longest chain was taken instead of the matching one:`
        + ` got ${got.chain}`);
    near(got.tm, 1.0, 1e-6, 'the matching chain did not score 1');
}

// --- the screening pass picks the same winner as the full one ---------------
{
    const N = 60;
    const ref = helix(N);
    const target = {
        name: 'both', chains: [
            { id: 'A', len: 90, flat: extended(90) },
            { id: 'B', len: N, flat: moved(ref, N, rotmat(1, 2, 3), [0, 0, 0]) }
        ]
    };
    const fast = Align.alignOne({ flat: ref, len: N }, target, false);
    const full = Align.alignOne({ flat: ref, len: N }, target, true);
    ok(fast.chain === full.chain,
        `the screening pass and the full pass disagree about which chain matches:`
        + ` ${fast.chain} vs ${full.chain}`);
}

console.log(fails ? `${fails} failure(s)` : 'align: ok');
process.exit(fails ? 1 : 0);
