// The 3x3 linear algebra that replaced numeric.js.
//
//     node tests/math.js
//
// src/io/math.js used to load numeric.js from a CDN on every page for one routine:
// the SVD of a 3x3, needed by kabsch and by the best-view solver. Sixty lines of
// Jacobi replaced it, and a hand-written numerical routine with no library
// behind it needs its properties checked rather than assumed.
//
// WHAT IS CHECKED IS THE DEFINITION, not a table of expected numbers: for the
// SVD, that U S V^T reconstructs the input and that U and V are orthonormal;
// for kabsch, that it recovers a rotation that was applied on purpose. A table
// would only say the code still does what it did the day it was written.
//
// THE CASES THAT MATTER ARE THE DEGENERATE ONES. A structure viewer meets flat
// and linear point clouds constantly - a planar ring, a straight helix axis, two
// atoms - and that is where a rank-deficient matrix comes from. The first
// version of svd3 passed every full-rank test and produced a column of zeros for
// rank 1, because the threshold that decides "is this singular value real" was
// applied AFTER the square root: Jacobi's eps-level noise on an eigenvalue of
// 8e-15 becomes a singular value of 9e-8, which is enormous by comparison.
//
// NO 'use strict' HERE, deliberately: a function declared inside a strict-mode
// eval is scoped to that eval, so everything under test would be invisible.
const fs = require('fs');
eval(fs.readFileSync('src/io/math.js', 'utf8'));

let fails = 0;
const bad = (m) => { console.log('FAIL: ' + m); fails++; };
const flat = (M) => M[0].concat(M[1], M[2]);
const maxDiff = (A, B) => Math.max(...flat(A).map((v, i) => Math.abs(v - flat(B)[i])));

function orthonormal(M, label, tol) {
    const I = mat3Mul(mat3T(M), M);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            if (Math.abs(I[i][j] - (i === j ? 1 : 0)) > (tol || 1e-9)) {
                bad(`${label} is not orthonormal: M^T M [${i}][${j}] = ${I[i][j]}`);
                return;
            }
        }
    }
}

// ---- svd3 over every rank ---------------------------------------------------
{
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff * 4 - 2; };
    const CASES = {
        'full rank': () => [[rnd(), rnd(), rnd()], [rnd(), rnd(), rnd()], [rnd(), rnd(), rnd()]],
        'rank 2': () => { const m = [[rnd(), rnd(), rnd()], [rnd(), rnd(), rnd()], null];
            m[2] = m[0].slice(); return m; },
        'rank 1': () => { const r = [rnd(), rnd(), rnd()];
            return [r, r.map((x) => x * 2), r.map((x) => x * 3)]; },
        'zero': () => [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
        'tiny': () => [[1e-9 * rnd(), 0, 0], [0, 1e-9 * rnd(), 0], [0, 0, 1e-9 * rnd()]],
    };
    for (const [name, make] of Object.entries(CASES)) {
        for (let t = 0; t < 60; t++) {
            const H = make();
            const { U, S, V } = svd3(H);
            const rec = mat3Mul(mat3Mul(U, [[S[0], 0, 0], [0, S[1], 0], [0, 0, S[2]]]), mat3T(V));
            const scale = Math.max(1e-12, Math.max(...flat(H).map(Math.abs)));
            if (maxDiff(rec, H) > 1e-9 * scale) {
                bad(`${name}: U S V^T does not reconstruct the input`
                    + ` (off by ${maxDiff(rec, H).toExponential(2)})`);
                break;
            }
            orthonormal(U, `${name}: U`);
            orthonormal(V, `${name}: V`);
            if (!(S[0] >= S[1] - 1e-12 && S[1] >= S[2] - 1e-12)) {
                bad(`${name}: singular values are not descending: ${S}`); break;
            }
            if (S.some((x) => !Number.isFinite(x) || x < 0)) {
                bad(`${name}: a singular value is negative or not finite: ${S}`); break;
            }
        }
    }
    console.log('svd3: 5 rank classes x 60 matrices'
        + (fails ? '' : ' - reconstruct, orthonormal, descending'));
}

// ---- kabsch recovers a rotation that was applied ----------------------------
{
    const rot = (a, b, c) => {
        const ca = Math.cos(a); const sa = Math.sin(a); const cb = Math.cos(b);
        const sb = Math.sin(b); const cc = Math.cos(c); const sc = Math.sin(c);
        return [[cb * cc, -cb * sc, sb],
            [sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb],
            [-ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb]];
    };
    let worst = 0;
    for (let t = 0; t < 40; t++) {
        const R = rot(t * 0.11, t * 0.29, t * 0.53);
        const A = []; const B = [];
        for (let i = 0; i < 40; i++) {
            const p = [Math.sin(i * 1.7) * 9, Math.cos(i * 2.3) * 9, Math.sin(i * 0.9) * 9];
            A.push(p);
            B.push([p[0] * R[0][0] + p[1] * R[1][0] + p[2] * R[2][0],
                p[0] * R[0][1] + p[1] * R[1][1] + p[2] * R[2][1],
                p[0] * R[0][2] + p[1] * R[1][2] + p[2] * R[2][2]]);
        }
        const back = matNx3Mul3(A, kabsch(A, B));
        for (let i = 0; i < 40; i++) {
            worst = Math.max(worst, Math.hypot(back[i][0] - B[i][0],
                back[i][1] - B[i][1], back[i][2] - B[i][2]));
        }
    }
    if (worst > 1e-9) bad(`kabsch does not recover a known rotation: ${worst} A out`);
    console.log(`kabsch: 40 known rotations, worst atom ${worst.toExponential(2)} A out`);

    // ...AND A COLLINEAR CLOUD, which is rank 1 and which a two-atom selection
    // or a straight helix axis produces for real. It must still be a rotation:
    // finite, and a proper one rather than a reflection.
    const A = []; const B = [];
    for (let i = 0; i < 20; i++) { A.push([i, 0, 0]); B.push([0, i, 0]); }
    const r = kabsch(A, B);
    if (!flat(r).every(Number.isFinite)) bad('kabsch on a collinear cloud is not finite');
    orthonormal(r, 'kabsch on a collinear cloud');
    if (Math.abs(mat3Det(r) - 1) > 1e-9) {
        bad(`kabsch on a collinear cloud gives a reflection, det ${mat3Det(r)}`);
    }
    console.log('kabsch: a collinear cloud still gives a proper rotation');

    // --- allowReflection, which viewer.py has always offered on add() --------
    //
    // A MIRRORED CLOUD IS THE CASE THE FLAG EXISTS FOR. Fit a structure to its
    // own reflection: the least-squares answer is a mirror, det -1, and it fits
    // exactly. By default that is refused - a mirrored protein is the other
    // enantiomer - and the best PROPER rotation is returned instead, which does
    // NOT fit. Asking for the reflection gets the exact fit back.
    const P = []; const M = [];
    for (let i = 0; i < 30; i++) {
        const p = [Math.sin(i * 1.3) * 7, Math.cos(i * 0.7) * 7, Math.sin(i * 2.1) * 7];
        P.push(p);
        M.push([p[0], p[1], -p[2]]);          // reflected through z
    }
    const proper = kabsch(P, M);
    const mirror = kabsch(P, M, true);
    const dProper = mat3Det(proper);
    const dMirror = mat3Det(mirror);
    if (Math.abs(dProper - 1) > 1e-9) {
        bad(`kabsch default gives det ${dProper}, not a proper rotation`);
    }
    if (Math.abs(dMirror + 1) > 1e-9) {
        bad(`kabsch(allowReflection) gives det ${dMirror}, so the flag does`
            + ' nothing - the mirror is the exact fit here and it should say so');
    }
    // ...and the mirror really is the better fit, which is what makes the
    // default a CHOICE rather than an accident of the arithmetic.
    const rms = (R) => {
        const out = matNx3Mul3(P, R);
        let ss = 0;
        for (let i = 0; i < P.length; i++) {
            ss += (out[i][0] - M[i][0]) ** 2 + (out[i][1] - M[i][1]) ** 2
                + (out[i][2] - M[i][2]) ** 2;
        }
        return Math.sqrt(ss / P.length);
    };
    if (!(rms(mirror) < 1e-9)) {
        bad(`the reflected fit is ${rms(mirror)} A out, and it should be exact`);
    }
    if (!(rms(proper) > 1)) {
        bad('refusing the reflection cost nothing, so this cloud does not'
            + ' actually distinguish the two - the check proves nothing');
    }
    console.log(`kabsch: reflection refused by default (${rms(proper).toFixed(2)} A`
        + ` out), allowed on request (${rms(mirror).toExponential(1)} A)`);

    // ...and align_a_to_b passes the flag through rather than swallowing it.
    const viaDefault = align_a_to_b(P, P, M);
    const viaMirror = align_a_to_b(P, P, M, true);
    const off = (X) => {
        let w = 0;
        for (let i = 0; i < P.length; i++) {
            w = Math.max(w, Math.hypot(X[i][0] - M[i][0], X[i][1] - M[i][1],
                X[i][2] - M[i][2]));
        }
        return w;
    };
    if (!(off(viaMirror) < 1e-9)) {
        bad(`align_a_to_b(allowReflection) is ${off(viaMirror)} A out - the flag`
            + ' is not reaching kabsch');
    }
    if (!(off(viaDefault) > 1)) {
        bad('align_a_to_b mirrors by default');
    }
    console.log('kabsch: align_a_to_b passes allowReflection through');
}

// ---- and no library ---------------------------------------------------------
{
    const src = fs.readFileSync('src/io/math.js', 'utf8');
    const call = /\bnumeric\s*\./.exec(src.replace(/\/\/[^\n]*/g, ''));
    if (call) bad('src/io/math.js calls numeric.' + ' again, and nothing loads it');
    // ...matched in a src or href, NOT anywhere in the file. Checking the whole
    // text found the COMMENT that explains why Tailwind was removed, and
    // reported the page still loading it.
    const html = fs.readFileSync('index.html', 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        if (/tailwindcss|numeric[.\-]/.test(m[1])) {
            bad('index.html loads ' + m[1] + ', which this code replaced');
        }
    }
    console.log('no numeric.js, no tailwind CDN');
}

// ---- _struct_conn: connectivity, not coordination ---------------------------
// A metalc record says a metal is coordinated, not bonded, and drawing it as a
// stick invents rings: 7P1E has Ca 506 chelated by BOTH carboxylate oxygens of
// the ligand K99, so those two sticks plus the carboxylate's own two close a
// four-membered ring that reads as a solid triangle on the sugar.
//
// It was half-drawn as well - four of that file's seven metalc records name
// protein atoms, and a protein residue contributes only its CA, so those ends
// resolved to nothing. Only metal-to-ligand ever appeared.
{
    const src = fs.readFileSync('src/io/parse.js', 'utf8');
    const m = /conn_type_id[\s\S]{0,1600}?if \(type && \(([^)]*)\)\)/.exec(src);
    if (!m) {
        bad('cannot find the _struct_conn type filter in src/io/parse.js');
    } else {
        const kept = m[1];
        if (/metalc/.test(kept)) {
            bad('src/io/parse.js accepts metalc from _struct_conn again -'
                + ' coordination drawn as a covalent stick closes rings that'
                + ' are not there (7P1E, Ca 506 on K99)');
        }
        for (const want of ['covale', 'disulf']) {
            if (!kept.includes(want)) {
                bad(`src/io/parse.js no longer accepts ${want} from`
                    + ' _struct_conn, which is real connectivity');
            }
        }
    }
    console.log('_struct_conn: covale and disulf, not metalc');
}

console.log(fails ? `${fails} failure(s)` : 'math: ok');
process.exit(fails ? 1 : 0);
