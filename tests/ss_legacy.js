/* THE SUPERSEDED C-ALPHA-ONLY SECONDARY STRUCTURE, kept as a baseline.
 *
 * This is TMalign's make_sec and the smoothing and extension passes that grew
 * around it. Nothing the application can reach calls any of it: the renderer
 * assigns secondary structure with assignSecondary / assignSecondaryOpen in
 * src/cartoon/geom.js, which rebuilds a backbone and runs the real hydrogen-
 * bond rules. What this is FOR is the comparison - tests/ss_bench.js prints
 *
 *     make_sec            Q3
 *     + smoothSec         Q3
 *     + extendSec (worse) Q3
 *
 * against the shipped assignment, and tests/ss_tune.js tunes its parameters by
 * coordinate descent. Delete it and the evidence that the current pipeline is
 * better goes with it.
 *
 * 🔴 IT USED TO LIVE IN src/cartoon/geom.js AND SO IT SHIPPED. The bundler
 * concatenates whole files, so 226 lines of a benchmark baseline were in every
 * bundle - downloaded, parsed and held in memory by every reader of every page,
 * to answer a question nobody on that page was asking. Out here it is in no
 * bundle and no <script> tag.
 *
 * 🔴 IT IS NOT A MODULE, AND THAT IS DELIBERATE. Both benchmarks load
 * src/cartoon/geom.js into a vm context as plain source; this file is run into
 * the SAME context straight afterwards and puts its three entry points back on
 * py2dmolCartoon.
 *
 * 🔴 AND IT TAKES ITS PARAMETERS THROUGH THE EXPORT, NOT OUT OF SCOPE.
 * geom.js is wrapped in an IIFE, so its `const SS` is function-scoped and a
 * second script in the same context cannot see it - which is what a first
 * attempt assumed, and it fails with "SS is not defined" at the first call.
 * py2dmolCartoon.SS_PARAMS IS that object, so reading it here keeps exactly
 * one copy of the parameters, which is what tests/ss_tune.js needs: it sweeps
 * SS_PARAMS and expects this pipeline to see the change.
 */

(function () {

// The renderer's own parameter object, not a copy - see the header.
const SS = window.py2dmolCartoon.SS_PARAMS;

// ------------------------------------------------------------------------
// Secondary structure from C-alpha geometry (port of TMalign.cpp make_sec)
// ------------------------------------------------------------------------

function dist(x, i, j) {
    const d1 = x[i] - x[j];
    const d2 = x[i + 1] - x[j + 1];
    const d3 = x[i + 2] - x[j + 2];
    return Math.sqrt(d1 * d1 + d2 * d2 + d3 * d3);
}


function secStr(dis13, dis14, dis15, dis24, dis25, dis35, hDelta, eDelta) {
    let delta = hDelta === undefined ? SS.helixDelta : hDelta;
    if (Math.abs(dis15 - 6.37) < delta && Math.abs(dis14 - 5.18) < delta
        && Math.abs(dis25 - 5.18) < delta && Math.abs(dis13 - 5.45) < delta
        && Math.abs(dis24 - 5.45) < delta && Math.abs(dis35 - 5.45) < delta) return 'H';
    delta = eDelta === undefined ? SS.strandDelta : eDelta;
    if (Math.abs(dis15 - 13) < delta && Math.abs(dis14 - 10.4) < delta
        && Math.abs(dis25 - 10.4) < delta && Math.abs(dis13 - 6.1) < delta
        && Math.abs(dis24 - 6.1) < delta && Math.abs(dis35 - 6.1) < delta) return 'E';
    if (dis15 < 8) return 'T';
    return 'C';
}

/** make_sec (TMalign.cpp:2466). x is a flat [x,y,z,...] array of C-alpha. */
function makeSec(x, len) {
    const sec = new Array(len);
    for (let i = 0; i < len; i++) {
        sec[i] = 'C';
        const j1 = i - 2; const j5 = i + 2;
        if (j1 >= 0 && j5 < len) {
            sec[i] = secStr(
                dist(x, j1 * 3, i * 3),
                dist(x, j1 * 3, (i + 1) * 3),
                dist(x, j1 * 3, j5 * 3),
                dist(x, (i - 1) * 3, (i + 1) * 3),
                dist(x, (i - 1) * 3, j5 * 3),
                dist(x, i * 3, j5 * 3),
            );
        }
    }
    return sec.join('');
}

/** secStr for residue i of a flat CA array, at explicit tolerances. */
function secAt(x, len, i, hDelta, eDelta) {
    if (i - 2 < 0 || i + 2 >= len) return 'C';
    return secStr(
        dist(x, (i - 2) * 3, i * 3),
        dist(x, (i - 2) * 3, (i + 1) * 3),
        dist(x, (i - 2) * 3, (i + 2) * 3),
        dist(x, (i - 1) * 3, (i + 1) * 3),
        dist(x, (i - 1) * 3, (i + 2) * 3),
        dist(x, i * 3, (i + 2) * 3),
        hDelta, eDelta,
    );
}

/**
 * HYSTERESIS extension. make_sec's 5-residue window cannot classify the
 * first or last two residues of any element, so helices and strands always
 * stop short and have to be grown back out.
 *
 * The previous method grew them using hydrogen-bond PROXIES on CA geometry
 * - a different signal from the one that seeded the element - and measured
 * against pydssp on 151 natives it cost more than it bought: H and E recall
 * rose to 92% but 2930 coil residues were swallowed, and Q3 fell from 82.0%
 * (no extension at all) to 77.5%. Growth in a signal the seeding never
 * agreed with has nothing to stop it.
 *
 * Hysteresis keeps ONE signal and uses two tolerances on it: strict to
 * START an element, loose to CONTINUE one - the standard fix for a detector
 * that truncates its own boundaries. A residue joins the element beside it
 * only if TM-align's own distance set still calls it that class at the
 * relaxed tolerance, and only within maxGrow residues of the seeded end,
 * which is the width of the window that created the truncation.
 */
function extendSecHyst(x, len, sec) {
    const a = [...sec];
    const d = (i, j) => dist(x, i * 3, j * 3);
    const chainOk = (i) => i >= 0 && i + 1 < len && d(i, i + 1) < SS.chainMax;
    const maxPass = Math.max(SS.maxGrowH, SS.maxGrowE);
    for (let pass = 0; pass < maxPass; pass++) {
        const prev = a.slice();
        for (let i = 0; i < len; i++) {
            if (prev[i] === 'H' || prev[i] === 'E') continue;
            const left = i > 0 ? prev[i - 1] : null;
            const right = i + 1 < len ? prev[i + 1] : null;
            for (const t of ['H', 'E']) {
                if (t === 'H' && pass >= SS.maxGrowH) continue;
                if (t === 'E' && pass >= SS.maxGrowE) continue;
                const joinL = left === t && chainOk(i - 1);
                const joinR = right === t && chainOk(i);
                if (!joinL && !joinR) continue;
                if (t === 'H') { a[i] = 'H'; break; }   // ungated, see above
                if (secAt(x, len, i, SS.helixDelta, SS.strandDeltaExt) === 'E') {
                    a[i] = 'E';
                    break;
                }
            }
        }
    }
    return a.join('');
}

/**
 * Drop strand runs that have no cross-strand PARTNER.
 *
 * make_sec's strand test is purely local - a set of CA-CA distances over a
 * 5-residue window - so a tight turn whose geometry happens to fall inside
 * the strand tolerances is called 'E' even though nothing is paired with
 * it. Measured on 1TIM against pydssp: 12 coil residues came out as strand,
 * in runs of 2-3, all inside loops. Rendered, a 2-residue strand is a wide
 * green arrow cutting through a curved region.
 *
 * A beta strand is not a local conformation, it is a PAIRING: it only
 * exists because another strand runs alongside it. So require exactly
 * that - some residue at least minSep apart in sequence, at sheet contact
 * distance - for a sufficient fraction of the run, and delete the run
 * otherwise. This is the same geometric test the old extendSec used to GROW
 * strands, which was the wrong direction: as a filter it removes false
 * positives instead of manufacturing them.
 */
function pruneStrands(x, len, sec) {
    const a = [...sec];
    const d = (i, j) => dist(x, i * 3, j * 3);
    const paired = (i) => {
        for (let j = 0; j < len; j++) {
            if (Math.abs(j - i) < SS.pairMinSep) continue;
            const v = d(i, j);
            if (v > SS.splo && v < SS.sphi) return true;
        }
        return false;
    };
    for (let i = 0; i < len; i++) {
        if (a[i] !== 'E') continue;
        let hi = i;
        while (hi + 1 < len && a[hi + 1] === 'E') hi++;
        const runLen = hi - i + 1;
        let nPaired = 0;
        for (let k = i; k <= hi; k++) if (paired(k)) nPaired++;
        if (runLen < SS.minStrand || nPaired < runLen * SS.pairFrac) {
            for (let k = i; k <= hi; k++) a[k] = 'C';
        }
        i = hi;
    }
    return a.join('');
}

/**
 * Tidy a secondary-structure string for DISPLAY (not for alignment).
 * Bridges a one-residue gap inside an element and drops lone speckle;
 * deliberately does NOT grow element ends (that would draw structure
 * that was never assigned).
 */
function smoothSec(sec) {
    const a = [...sec];
    for (let i = 0; i + 2 < a.length; i++) {
        for (const j of ['H', 'E']) {
            if (a[i] === j && a[i + 1] !== j && a[i + 2] === j) a[i + 1] = j;
        }
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== 'H' && a[i] !== 'E') continue;
        const before = i > 0 && a[i - 1] === a[i];
        const after = i + 1 < a.length && a[i + 1] === a[i];
        if (!before && !after) a[i] = 'C';
    }
    return a.join('');
}

/**
 * Extend element ends using HYDROGEN-BOND PROXIES on C-alpha geometry.
 * make_sec's 5-residue window cannot classify the first/last two
 * residues of any element, so helices and strands always stop short.
 * A residue adjacent to a helix joins it while it stays "self-paired":
 * d(i,i+3) ~ 5.1 A and d(i,i+4) ~ 6.2 A (the i -> i+4 backbone H-bond
 * proxy), looking forward at the N-end and backward at the C-end. A
 * residue adjacent to a strand joins it while it keeps a CROSS-STRAND
 * partner: some j (|i-j| >= 4, possibly long-range) at sheet contact
 * distance (~4.8-5.2 A) whose neighbour j+-1 also pairs with the
 * adjacent strand residue (the +-1 covering parallel and antiparallel).
 */
function extendSec(x, len, sec) {
    if (SS.pruneStrands !== false) sec = pruneStrands(x, len, sec);
    if (SS.extMode === 'hyst') return extendSecHyst(x, len, sec);
    return extendSecHBond(x, len, sec);
}

function extendSecHBond(x, len, sec) {
    const a = [...sec];
    const d = (i, j) => dist(x, i * 3, j * 3);
    const chainOk = (i) => i >= 0 && i + 1 < len && d(i, i + 1) < SS.chainMax;
    const h3 = (i, j) => { const v = d(i, j); return v > SS.h3lo && v < SS.h3hi; };
    const h4 = (i, j) => { const v = d(i, j); return v > SS.h4lo && v < SS.h4hi; };
    const helixFwd = (i) => i + 4 < len && h3(i, i + 3) && h4(i, i + 4);
    const helixBwd = (i) => i - 4 >= 0 && h3(i - 3, i) && h4(i - 4, i);
    const sp = (i, j) => { const v = d(i, j); return v > SS.splo && v < SS.sphi; };
    const strandPair = (i, iPrev) => {
        for (let j = 0; j < len; j++) {
            if (Math.abs(j - i) < 4 || !sp(i, j)) continue;
            if (j + 1 < len && sp(iPrev, j + 1)) return true;
            if (j - 1 >= 0 && sp(iPrev, j - 1)) return true;
        }
        return false;
    };
    for (let pass = 0; pass < SS.extPasses; pass++) {
        let changed = false;
        for (let i = 0; i < len; i++) {
            if (a[i] === 'H' || a[i] === 'E') continue;
            const prevH = i > 0 && a[i - 1] === 'H';
            const nextH = i + 1 < len && a[i + 1] === 'H';
            if ((nextH && chainOk(i) && helixFwd(i))
                || (prevH && chainOk(i - 1) && helixBwd(i))) {
                a[i] = 'H';
                changed = true;
                continue;
            }
            const prevE = i > 0 && a[i - 1] === 'E';
            const nextE = i + 1 < len && a[i + 1] === 'E';
            if ((prevE && chainOk(i - 1) && strandPair(i, i - 1))
                || (nextE && chainOk(i) && strandPair(i, i + 1))) {
                a[i] = 'E';
                changed = true;
            }
        }
        if (!changed) break;
    }
    return a.join('');
}

// ...and back onto the object the benchmarks read, which src/cartoon/geom.js
// built a moment ago in this same context.
window.py2dmolCartoon.makeSec = makeSec;
window.py2dmolCartoon.smoothSec = smoothSec;
window.py2dmolCartoon.extendSec = extendSec;

})();
