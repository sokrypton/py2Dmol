// STRUCTURAL ALIGNMENT: TM-align, and what a viewer has to decide around it.
//
// tmalign.js is the algorithm and is not edited here (see
// tests/vendor_tmalign.mjs). This file is everything the algorithm does not
// know: which coordinates to hand it, which chain of a multi-chain object is
// the one that matches, which direction the transform goes, and how to run it
// without freezing the page.
//
// WHICH COORDINATES. TM-align is protein C-alpha only - the port leaves out the
// RNA C3' parameter sets, so a nucleic chain has no business being scored by
// it. Positions typed 'P' are exactly the C-alpha trace, one per residue, which
// is the input TM-align wants with no resampling.
//
// WHICH CHAIN. An object being moved may be a complex, and the chain that
// matches the reference is often not its first or its longest: the match can be
// chain D of a hetero-complex. Every protein chain is tried and the best kept.
//
// AT `fast` SETTINGS, ALL OF THEM - and this is a real trade, not a free one.
//
// TM-align's full search is the same algorithm with more restarts, so what it
// buys is a better local optimum. Measured over 44 homolog-like pairs built out
// of this repo's fixtures (a chain against itself with runs deleted and 0.5-5 A
// of jitter added): 41 of them agreed with the full search TO FOUR DECIMAL
// PLACES, on both TM and RMSD, for 2-4x less time - 63 ms against 149 ms on
// 2OMF/2POR, 1.4 s against 15.7 s on a 1,365-residue chain.
//
// THE OTHER THREE DID NOT, and they failed badly rather than slightly: 1AOI's
// 116-residue histone at 3 A of jitter scored 0.18 fast against 0.52 full, RMSD
// 3.5 against 1.5. That is not a fourth decimal place, it is the fast search
// missing the alignment altogether - small chains with little secondary
// structure to seed on are where it happens. The failure is at least a LOUD
// one: the score reported is the bad one and the structures visibly do not
// overlap, so it reads as "these do not match" rather than passing for a fit.
//
// Fast is the setting because a superposition is something you ask for and then
// look at, and eleven seconds of waiting for a case that arises one time in
// fifteen is the wrong default. FULL_SEARCH below is the whole of that choice.
// If the tail matters more than the wait, the shape to reach for is escalation
// rather than a flag: run fast, and re-run the winner at full settings when it
// comes back under about 0.5, which is exactly where the three failures sit.
//
// Fast also collapses the two passes into one. Ranking N chains needs a score
// per chain anyway, so the winner's score IS the answer and nothing is computed
// twice - which is where some of the 2-4x goes.
//
// WHICH DIRECTION. TM-align's own direction is X = t + u*x: chain 1 is moved
// onto chain 2. So the chain being MOVED is passed as chain 1 and the reference
// as chain 2, and t/u then applies to the moved object unchanged. This also
// means the REFERENCE NEVER MOVES, which is the property that keeps the camera
// valid: whatever you were looking at is still where it was, and the other
// structures have come to it.
//
// WHICH SCORE RANKS. TM1 is normalised by chain 2 - the reference - and TM2 by
// chain 1. Comparing chains of DIFFERENT lengths against one fixed reference is
// only fair under the reference's normalisation, so TM1 ranks and TM1 is
// reported. TM2 would hand the win to whichever chain is shortest.
//
// WHERE IT RUNS. In a Worker, because it is still seconds of arithmetic on a
// big structure - 1.4 s for a 1,365-residue chain - and a page that stops for
// that is broken. The worker needs a URL to import from, which a page that
// INLINES its scripts (the notebook build - viewer.py) does not have; there the
// same job runs on the main thread, which is the honest trade rather than a
// feature that silently does nothing.
(function (global) {
'use strict';

// >>> BEGIN GENERATED: foldjs/lib/tmalign.js
// TM-align in JavaScript, including the -cp (circular permutation) mode.
//
// Faithful port of tm_align/TMalign.cpp (Version 20220412) — protein only,
// Cα only. Line references below point into that file. The port keeps the
// original control flow and variable names so it can be audited against the
// C++ side by side, including the parts that look like they could be
// simplified: TM-align is a heuristic optimizer, and "tidying" the search
// order changes which local optimum it lands in.
//
// Not ported (unused by the -cp entry point):
//   -i / -I user alignments, -a / -u / -d normalizations, TMcut early exit,
//   RNA (C3') parameter sets, multi-chain handling, output formatting.
//
// Coordinates are flat Float64Array with stride 3. Rotations are t[3] and
// u[9] (row-major, u[i*3+j]), applied as X = t + u·x.

// Debug hook: set TRACE.on to collect the return value of every
// detailed_search / DP_iter call, in order, for comparison against an
// instrumented build of TMalign.cpp. See test/tmalign_trace.mjs.
const TRACE = { on: false, log: [] };

// --- primitives (TMalign.cpp:873-902) ---------------------------------------

function dist2(x, xi, y, yi) {
  const d1 = x[xi] - y[yi];
  const d2 = x[xi + 1] - y[yi + 1];
  const d3 = x[xi + 2] - y[yi + 2];
  return d1 * d1 + d2 * d2 + d3 * d3;
}

function transform(t, u, x, xi, out, oi) {
  out[oi] = t[0] + u[0] * x[xi] + u[1] * x[xi + 1] + u[2] * x[xi + 2];
  out[oi + 1] = t[1] + u[3] * x[xi] + u[4] * x[xi + 1] + u[5] * x[xi + 2];
  out[oi + 2] = t[2] + u[6] * x[xi] + u[7] * x[xi + 1] + u[8] * x[xi + 2];
}

function doRotation(x, x1, len, t, u) {
  for (let i = 0; i < len; i++) transform(t, u, x, i * 3, x1, i * 3);
}

// --- Kabsch (TMalign.cpp:983-1320) ------------------------------------------
// mode 0: rms only; 1: u, t only; 2: both. Returns rms via the `out` object.

const IP = [0, 1, 3, 1, 2, 4, 3, 4, 5];
const IP2312 = [1, 2, 0, 1];
const SQRT3 = 1.73205080756888;

// Exported for test/tmalign_wasm.mjs only. A 230-line numerical routine that everything
// else is built on deserves to be checked against its wasm twin directly, rather than
// through six layers of search that could mask a disagreement.
function kabsch(x, y, n, mode, t, u, out) {
  const tol = 0.01;
  const epsilon = 1e-8;
  let i; let j; let m; let m1; let l; let k;
  let e0 = 0; let rms1 = 0; let d; let h; let g;
  let cth; let sth; let sqrth; let p; let det; let sigma;

  const xc = [0, 0, 0]; const yc = [0, 0, 0];
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];  // a[i][j] -> a[i*3+j]
  const b = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const e = [0, 0, 0];
  const rr = [0, 0, 0, 0, 0, 0];
  const ss = [0, 0, 0, 0, 0, 0];
  const s1 = [0, 0, 0]; const s2 = [0, 0, 0];
  const sx = [0, 0, 0]; const sy = [0, 0, 0]; const sz = [0, 0, 0];

  let aFailed = 0; let bFailed = 0;
  out.rms = 0;

  for (i = 0; i < 3; i++) {
    t[i] = 0;
    for (j = 0; j < 3; j++) {
      u[i * 3 + j] = i === j ? 1 : 0;
      a[i * 3 + j] = i === j ? 1 : 0;
      r[i * 3 + j] = 0;
    }
  }
  if (n < 1) return false;

  for (i = 0; i < n; i++) {
    const c10 = x[i * 3]; const c11 = x[i * 3 + 1]; const c12 = x[i * 3 + 2];
    const c20 = y[i * 3]; const c21 = y[i * 3 + 1]; const c22 = y[i * 3 + 2];
    s1[0] += c10; s1[1] += c11; s1[2] += c12;
    s2[0] += c20; s2[1] += c21; s2[2] += c22;
    sx[0] += c10 * c20; sx[1] += c10 * c21; sx[2] += c10 * c22;
    sy[0] += c11 * c20; sy[1] += c11 * c21; sy[2] += c11 * c22;
    sz[0] += c12 * c20; sz[1] += c12 * c21; sz[2] += c12 * c22;
  }
  for (i = 0; i < 3; i++) { xc[i] = s1[i] / n; yc[i] = s2[i] / n; }

  if (mode === 2 || mode === 0) {
    for (let mm = 0; mm < n; mm++) {
      for (let nn = 0; nn < 3; nn++) {
        e0 += (x[mm * 3 + nn] - xc[nn]) * (x[mm * 3 + nn] - xc[nn])
            + (y[mm * 3 + nn] - yc[nn]) * (y[mm * 3 + nn] - yc[nn]);
      }
    }
  }
  // r[j][0] = sx[j] - ..., NOT sx[0] — the row index selects the component
  // within each of sx/sy/sz (TMalign.cpp:1064). Getting this transposed still
  // passes self-alignment, because that covariance matrix is symmetric.
  for (j = 0; j < 3; j++) {
    r[j * 3] = sx[j] - s1[0] * s2[j] / n;
    r[j * 3 + 1] = sy[j] - s1[1] * s2[j] / n;
    r[j * 3 + 2] = sz[j] - s1[2] * s2[j] / n;
  }

  det = r[0] * (r[4] * r[8] - r[5] * r[7])
      - r[1] * (r[3] * r[8] - r[5] * r[6])
      + r[2] * (r[3] * r[7] - r[4] * r[6]);
  sigma = det;

  m = 0;
  for (j = 0; j < 3; j++) {
    for (i = 0; i <= j; i++) {
      rr[m] = r[i] * r[j] + r[3 + i] * r[3 + j] + r[6 + i] * r[6 + j];
      m++;
    }
  }

  const spur = (rr[0] + rr[2] + rr[5]) / 3.0;
  const cof = (((((rr[2] * rr[5] - rr[4] * rr[4]) + rr[0] * rr[5])
    - rr[3] * rr[3]) + rr[0] * rr[2]) - rr[1] * rr[1]) / 3.0;
  det *= det;

  for (i = 0; i < 3; i++) e[i] = spur;

  if (spur > 0) {
    d = spur * spur;
    h = d - cof;
    g = (spur * cof - det) / 2.0 - spur * h;

    if (h > 0) {
      sqrth = Math.sqrt(h);
      d = h * h * h - g * g;
      if (d < 0) d = 0;
      d = Math.atan2(Math.sqrt(d), -g) / 3.0;
      cth = sqrth * Math.cos(d);
      sth = sqrth * SQRT3 * Math.sin(d);
      e[0] = (spur + cth) + cth;
      e[1] = (spur - cth) + sth;
      e[2] = (spur - cth) - sth;

      if (mode !== 0) {
        for (l = 0; l < 3; l += 2) {
          d = e[l];
          ss[0] = (d - rr[2]) * (d - rr[5]) - rr[4] * rr[4];
          ss[1] = (d - rr[5]) * rr[1] + rr[3] * rr[4];
          ss[2] = (d - rr[0]) * (d - rr[5]) - rr[3] * rr[3];
          ss[3] = (d - rr[2]) * rr[3] + rr[1] * rr[4];
          ss[4] = (d - rr[0]) * rr[4] + rr[1] * rr[3];
          ss[5] = (d - rr[0]) * (d - rr[2]) - rr[1] * rr[1];

          for (let q = 0; q < 6; q++) if (Math.abs(ss[q]) <= epsilon) ss[q] = 0;

          if (Math.abs(ss[0]) >= Math.abs(ss[2])) {
            j = 0;
            if (Math.abs(ss[0]) < Math.abs(ss[5])) j = 2;
          } else if (Math.abs(ss[2]) >= Math.abs(ss[5])) j = 1;
          else j = 2;

          d = 0;
          j = 3 * j;
          for (i = 0; i < 3; i++) {
            k = IP[i + j];
            a[i * 3 + l] = ss[k];
            d += ss[k] * ss[k];
          }
          if (d > epsilon) d = 1.0 / Math.sqrt(d); else d = 0;
          for (i = 0; i < 3; i++) a[i * 3 + l] *= d;
        }

        d = a[0] * a[2] + a[3] * a[5] + a[6] * a[8];
        if ((e[0] - e[1]) > (e[1] - e[2])) { m1 = 2; m = 0; } else { m1 = 0; m = 2; }
        p = 0;
        for (i = 0; i < 3; i++) {
          a[i * 3 + m1] -= d * a[i * 3 + m];
          p += a[i * 3 + m1] * a[i * 3 + m1];
        }
        if (p <= tol) {
          p = 1.0;
          for (i = 0; i < 3; i++) {
            if (p < Math.abs(a[i * 3 + m])) continue;
            p = Math.abs(a[i * 3 + m]);
            j = i;
          }
          k = IP2312[j];
          l = IP2312[j + 1];
          p = Math.sqrt(a[k * 3 + m] * a[k * 3 + m] + a[l * 3 + m] * a[l * 3 + m]);
          if (p > tol) {
            a[j * 3 + m1] = 0;
            a[k * 3 + m1] = -a[l * 3 + m] / p;
            a[l * 3 + m1] = a[k * 3 + m] / p;
          } else aFailed = 1;
        } else {
          p = 1.0 / Math.sqrt(p);
          for (i = 0; i < 3; i++) a[i * 3 + m1] *= p;
        }
        if (aFailed !== 1) {
          a[1] = a[5] * a[6] - a[3] * a[8];
          a[4] = a[8] * a[0] - a[6] * a[2];
          a[7] = a[2] * a[3] - a[0] * a[5];
        }
      }
    }

    if (mode !== 0 && aFailed !== 1) {
      for (l = 0; l < 2; l++) {
        d = 0;
        for (i = 0; i < 3; i++) {
          b[i * 3 + l] = r[i * 3] * a[l] + r[i * 3 + 1] * a[3 + l] + r[i * 3 + 2] * a[6 + l];
          d += b[i * 3 + l] * b[i * 3 + l];
        }
        if (d > epsilon) d = 1.0 / Math.sqrt(d); else d = 0;
        for (i = 0; i < 3; i++) b[i * 3 + l] *= d;
      }
      d = b[0] * b[1] + b[3] * b[4] + b[6] * b[7];
      p = 0;
      for (i = 0; i < 3; i++) {
        b[i * 3 + 1] -= d * b[i * 3];
        p += b[i * 3 + 1] * b[i * 3 + 1];
      }
      if (p <= tol) {
        p = 1.0;
        for (i = 0; i < 3; i++) {
          if (p < Math.abs(b[i * 3])) continue;
          p = Math.abs(b[i * 3]);
          j = i;
        }
        k = IP2312[j];
        l = IP2312[j + 1];
        p = Math.sqrt(b[k * 3] * b[k * 3] + b[l * 3] * b[l * 3]);
        if (p > tol) {
          b[j * 3 + 1] = 0;
          b[k * 3 + 1] = -b[l * 3] / p;
          b[l * 3 + 1] = b[k * 3] / p;
        } else bFailed = 1;
      } else {
        p = 1.0 / Math.sqrt(p);
        for (i = 0; i < 3; i++) b[i * 3 + 1] *= p;
      }
      if (bFailed !== 1) {
        b[2] = b[3] * b[7] - b[4] * b[6];
        b[5] = b[6] * b[1] - b[7] * b[0];
        b[8] = b[0] * b[4] - b[1] * b[3];
        for (i = 0; i < 3; i++) {
          for (j = 0; j < 3; j++) {
            u[i * 3 + j] = b[i * 3] * a[j * 3] + b[i * 3 + 1] * a[j * 3 + 1]
                         + b[i * 3 + 2] * a[j * 3 + 2];
          }
        }
      }
      for (i = 0; i < 3; i++) {
        t[i] = ((yc[i] - u[i * 3] * xc[0]) - u[i * 3 + 1] * xc[1]) - u[i * 3 + 2] * xc[2];
      }
    }
  } else {
    for (i = 0; i < 3; i++) {
      t[i] = ((yc[i] - u[i * 3] * xc[0]) - u[i * 3 + 1] * xc[1]) - u[i * 3 + 2] * xc[2];
    }
  }

  for (i = 0; i < 3; i++) { if (e[i] < 0) e[i] = 0; e[i] = Math.sqrt(e[i]); }
  d = e[2];
  if (sigma < 0) d = -d;
  d = (d + e[1]) + e[0];

  if (mode === 2 || mode === 0) {
    rms1 = (e0 - d) - d;
    if (rms1 < 0) rms1 = 0;
  }
  out.rms = rms1;
  return true;
}

// --- Needleman-Wunsch variants (TMalign.cpp:1321-1620) ----------------------
// Gap jumping is deliberately not implemented, matching the C++ (see its
// comment at :1300) — gap open equals gap extend, so it makes no difference.
// `path` is Uint8Array, `val` Float64Array, both (len1+1)*(len2+1).

// path encodes the traceback direction, not just "was this a match":
//   bit 0 set -> diagonal (i-1, j-1)
//   value 2   -> came from the left (j-1)
//   value 0   -> came from above (i-1)
// The DP already compares h against v to fill a cell; the original threw that answer
// away and the traceback recomputed it from the score matrix, which is the only reason
// the full (len1+1)x(len2+1) score matrix had to exist. Recording the direction instead
// lets `val` shrink to two rows — 2 MB to 8 KB on a 500x500 pair — and the DP's working
// set then fits in L1. Exact, not an approximation: the stored bit is the same
// comparison the traceback used to make.
const DIAG = 1;
const LEFT = 2;

function nwTraceback(path, len1, len2, j2i, w) {
  let i = len1;
  let j = len2;
  while (i > 0 && j > 0) {
    const p = path[i * w + j];
    if (p & DIAG) { j2i[j - 1] = i - 1; i--; j--; } else if (p === LEFT) j--; else i--;
  }
}

function nwInit(path, prev, len1, len2, j2i, w) {
  for (let i = 0; i <= len1; i++) path[i * w] = 0;
  for (let j = 0; j <= len2; j++) { path[j] = 0; j2i[j] = -1; prev[j] = 0; }
}

/** One cell, reading only the previous and current rows of scores. */
function nwCell(path, prev, cur, i, j, d, gapOpen, w) {
  let h = prev[j];
  if (path[(i - 1) * w + j] & DIAG) h += gapOpen;
  let v = cur[j - 1];
  if (path[i * w + (j - 1)] & DIAG) v += gapOpen;
  if (d >= h && d >= v) { path[i * w + j] = DIAG; cur[j] = d; } else {
    const left = v >= h;
    path[i * w + j] = left ? LEFT : 0;
    cur[j] = left ? v : h;
  }
}

/** NWDP_TM over a precomputed score matrix (TMalign.cpp:1321). */
function nwdpScore(score, path, val, len1, len2, gapOpen, j2i) {
  const w = len2 + 1;
  const sw = len2 + 1;
  let prev = val.subarray(0, w);
  let cur = val.subarray(w, 2 * w);
  nwInit(path, prev, len1, len2, j2i, w);
  for (let i = 1; i <= len1; i++) {
    cur[0] = 0;
    for (let j = 1; j <= len2; j++) {
      nwCell(path, prev, cur, i, j, prev[j - 1] + score[i * sw + j], gapOpen, w);
    }
    const t = prev; prev = cur; cur = t;
  }
  nwTraceback(path, len1, len2, j2i, w);
}

/** NWDP_TM with rotation applied to x (TMalign.cpp:1403). */
function nwdpRot(path, val, x, y, len1, len2, t, u, d02, gapOpen, j2i) {
  const w = len2 + 1;
  let prev = val.subarray(0, w);
  let cur = val.subarray(w, 2 * w);
  nwInit(path, prev, len1, len2, j2i, w);
  const xx = new Float64Array(3);
  for (let i = 1; i <= len1; i++) {
    transform(t, u, x, (i - 1) * 3, xx, 0);
    cur[0] = 0;
    for (let j = 1; j <= len2; j++) {
      const dij = dist2(xx, 0, y, (j - 1) * 3);
      nwCell(path, prev, cur, i, j, prev[j - 1] + 1.0 / (1 + dij / d02), gapOpen, w);
    }
    const tt = prev; prev = cur; cur = tt;
  }
  nwTraceback(path, len1, len2, j2i, w);
}

/** NWDP_TM over secondary structure identity (TMalign.cpp:1570). */
function nwdpSec(path, val, secx, secy, len1, len2, gapOpen, j2i) {
  const w = len2 + 1;
  let prev = val.subarray(0, w);
  let cur = val.subarray(w, 2 * w);
  nwInit(path, prev, len1, len2, j2i, w);
  for (let i = 1; i <= len1; i++) {
    cur[0] = 0;
    for (let j = 1; j <= len2; j++) {
      const d = prev[j - 1] + (secx[i - 1] === secy[j - 1] ? 1.0 : 0.0);
      nwCell(path, prev, cur, i, j, d, gapOpen, w);
    }
    const tt = prev; prev = cur; cur = tt;
  }
  nwTraceback(path, len1, len2, j2i, w);
}

// --- parameter sets (TMalign.cpp:1647-1717) ---------------------------------

function parameterSet4search(xlen, ylen, P) {
  P.D0_MIN = 0.5;
  P.dcu0 = 4.25;
  P.Lnorm = Math.min(xlen, ylen);
  let d0;
  if (P.Lnorm <= 19) d0 = 0.168;
  else d0 = 1.24 * Math.cbrt(P.Lnorm * 1.0 - 15) - 1.8;
  P.D0_MIN = d0 + 0.8;
  d0 = P.D0_MIN;
  P.d0 = d0;
  let d0s = d0;
  if (d0s > 8) d0s = 8;
  if (d0s < 4.5) d0s = 4.5;
  P.d0_search = d0s;
  P.score_d8 = 1.5 * (P.Lnorm ** 0.3) + 3.5;
}

function parameterSet4final(len, P) {
  P.D0_MIN = 0.5;
  P.Lnorm = len;
  let d0;
  if (P.Lnorm <= 21) d0 = 0.5;
  else d0 = 1.24 * Math.cbrt(P.Lnorm * 1.0 - 15) - 1.8;
  if (d0 < P.D0_MIN) d0 = P.D0_MIN;
  P.d0 = d0;
  let d0s = d0;
  if (d0s > 8) d0s = 8;
  if (d0s < 4.5) d0s = 4.5;
  P.d0_search = d0s;
}

// --- score_fun8 (TMalign.cpp:1719-1805) -------------------------------------

function scoreFun8(xa, ya, nAli, d, iAli, res, scoreSumMethod, Lnorm, scoreD8, d0) {
  let scoreSum = 0; let di;
  let dTmp = d * d;
  const d02 = d0 * d0;
  const scoreD8Cut = scoreD8 * scoreD8;
  let i; let nCut; let inc = 0;

  for (;;) {
    nCut = 0;
    scoreSum = 0;
    for (i = 0; i < nAli; i++) {
      di = dist2(xa, i * 3, ya, i * 3);
      if (di < dTmp) { iAli[nCut] = i; nCut++; }
      if (scoreSumMethod === 8) {
        if (di <= scoreD8Cut) scoreSum += 1 / (1 + di / d02);
      } else scoreSum += 1 / (1 + di / d02);
    }
    if (nCut < 3 && nAli > 3) {
      inc++;
      const dinc = d + inc * 0.5;
      dTmp = dinc * dinc;
    } else break;
  }
  res.score = scoreSum / Lnorm;
  return nCut;
}

/** score_fun8_standard: identical but normalized by n_ali (TMalign.cpp:1762). */
function scoreFun8Standard(xa, ya, nAli, d, iAli, res, scoreSumMethod, scoreD8, d0) {
  const n = scoreFun8(xa, ya, nAli, d, iAli, res, scoreSumMethod, 1.0, scoreD8, d0);
  res.score /= nAli;
  return n;
}

// --- TMscore8_search (TMalign.cpp:1807-2120) --------------------------------
// The two C++ variants differ only in the normalizer inside score_fun8, so
// they share one implementation here with a `standard` flag.

function tmscore8Search(W, xtm, ytm, Lali, t0, u0, simplifyStep, scoreSumMethod,
  localD0Search, Lnorm, scoreD8, d0, standard) {
  // Scratch t/u MUST be distinct from the t0/u0 output: callers pass their own
  // t/u as the output, and in the C++ TMscore8_search has its own locals
  // (TMalign.cpp:1812). Sharing them makes t0/u0 hold the last transform tried
  // rather than the best, which silently breaks DP_iter's iteration.
  const { r1, r2, xt, kAli, iAli, kres } = W;
  const t = W.ts_t; const u = W.ts_u;
  let i; let m; let k; let ka;
  let scoreMax = -1; let score;

  const nIt = 20;
  const nInitMax = 6;
  const LIni = new Int32Array(nInitMax);
  let LIniMin = 4;
  if (Lali < LIniMin) LIniMin = Lali;

  let nInit = 0;
  for (i = 0; i < nInitMax - 1; i++) {
    nInit++;
    LIni[i] = Math.floor(Lali / (2.0 ** i));
    if (LIni[i] <= LIniMin) { LIni[i] = LIniMin; break; }
  }
  // C++ relies on `i` surviving the loop here (TMalign.cpp:1837).
  if (i === nInitMax - 1) { nInit++; LIni[i] = LIniMin; }

  let nCut = 0;
  for (let iInit = 0; iInit < nInit; iInit++) {
    const LFrag = LIni[iInit];
    const iLMax = Lali - LFrag;
    i = 0;
    for (;;) {
      ka = 0;
      for (k = 0; k < LFrag; k++) {
        const kk = k + i;
        r1[k * 3] = xtm[kk * 3]; r1[k * 3 + 1] = xtm[kk * 3 + 1]; r1[k * 3 + 2] = xtm[kk * 3 + 2];
        r2[k * 3] = ytm[kk * 3]; r2[k * 3 + 1] = ytm[kk * 3 + 1]; r2[k * 3 + 2] = ytm[kk * 3 + 2];
        kAli[ka] = kk;
        ka++;
      }
      kabsch(r1, r2, LFrag, 1, t, u, kres);
      doRotation(xtm, xt, Lali, t, u);

      let d = localD0Search - 1;
      nCut = standard
        ? scoreFun8Standard(xt, ytm, Lali, d, iAli, kres, scoreSumMethod, scoreD8, d0)
        : scoreFun8(xt, ytm, Lali, d, iAli, kres, scoreSumMethod, Lnorm, scoreD8, d0);
      score = kres.score;
      if (score > scoreMax) {
        scoreMax = score;
        t0[0] = t[0]; t0[1] = t[1]; t0[2] = t[2];
        for (k = 0; k < 9; k++) u0[k] = u[k];
      }

      d = localD0Search + 1;
      for (let it = 0; it < nIt; it++) {
        ka = 0;
        for (k = 0; k < nCut; k++) {
          m = iAli[k];
          r1[k * 3] = xtm[m * 3]; r1[k * 3 + 1] = xtm[m * 3 + 1]; r1[k * 3 + 2] = xtm[m * 3 + 2];
          r2[k * 3] = ytm[m * 3]; r2[k * 3 + 1] = ytm[m * 3 + 1]; r2[k * 3 + 2] = ytm[m * 3 + 2];
          kAli[ka] = m;
          ka++;
        }
        kabsch(r1, r2, nCut, 1, t, u, kres);
        doRotation(xtm, xt, Lali, t, u);
        nCut = standard
          ? scoreFun8Standard(xt, ytm, Lali, d, iAli, kres, scoreSumMethod, scoreD8, d0)
          : scoreFun8(xt, ytm, Lali, d, iAli, kres, scoreSumMethod, Lnorm, scoreD8, d0);
        score = kres.score;
        if (score > scoreMax) {
          scoreMax = score;
          t0[0] = t[0]; t0[1] = t[1]; t0[2] = t[2];
          for (k = 0; k < 9; k++) u0[k] = u[k];
        }
        if (nCut === ka) {
          for (k = 0; k < nCut; k++) if (iAli[k] !== kAli[k]) break;
          if (k === nCut) break;
        }
      }

      if (i < iLMax) {
        i += simplifyStep;
        if (i > iLMax) i = iLMax;
      } else break;
    }
  }
  return scoreMax;
}

// --- detailed_search (TMalign.cpp:2122-2192) --------------------------------

function gatherAligned(W, x, y, ylen, invmap) {
  const { xtm, ytm } = W;
  let k = 0;
  for (let i = 0; i < ylen; i++) {
    const j = invmap[i];
    if (j >= 0) {
      xtm[k * 3] = x[j * 3]; xtm[k * 3 + 1] = x[j * 3 + 1]; xtm[k * 3 + 2] = x[j * 3 + 2];
      ytm[k * 3] = y[i * 3]; ytm[k * 3 + 1] = y[i * 3 + 1]; ytm[k * 3 + 2] = y[i * 3 + 2];
      k++;
    }
  }
  return k;
}

function detailedSearch(W, x, y, ylen, invmap0, t, u, simplifyStep,
  scoreSumMethod, localD0Search, Lnorm, scoreD8, d0) {
  const k = gatherAligned(W, x, y, ylen, invmap0);
  const r = tmscore8Search(W, W.xtm, W.ytm, k, t, u, simplifyStep, scoreSumMethod,
    localD0Search, Lnorm, scoreD8, d0, false);
  if (TRACE.on) TRACE.log.push(`DS ${r.toFixed(10)} k=${k}`);
  return r;
}

function detailedSearchStandard(W, x, y, ylen, invmap0, t, u, simplifyStep,
  scoreSumMethod, localD0Search, bNormalize, Lnorm, scoreD8, d0) {
  const k = gatherAligned(W, x, y, ylen, invmap0);
  let tmscore = tmscore8Search(W, W.xtm, W.ytm, k, t, u, simplifyStep,
    scoreSumMethod, localD0Search, Lnorm, scoreD8, d0, true);
  if (bNormalize) tmscore = tmscore * k / Lnorm;
  return tmscore;
}

// --- get_score_fast (TMalign.cpp:2194-2340) ---------------------------------

function getScoreFast(W, x, y, ylen, invmap, d0, d0Search, t, u) {
  const { r1, r2, xtm, ytm, kres } = W;
  let i; let j; let k;

  k = 0;
  for (j = 0; j < ylen; j++) {
    i = invmap[j];
    if (i >= 0) {
      r1[k * 3] = x[i * 3]; r1[k * 3 + 1] = x[i * 3 + 1]; r1[k * 3 + 2] = x[i * 3 + 2];
      r2[k * 3] = y[j * 3]; r2[k * 3 + 1] = y[j * 3 + 1]; r2[k * 3 + 2] = y[j * 3 + 2];
      xtm[k * 3] = x[i * 3]; xtm[k * 3 + 1] = x[i * 3 + 1]; xtm[k * 3 + 2] = x[i * 3 + 2];
      ytm[k * 3] = y[j * 3]; ytm[k * 3 + 1] = y[j * 3 + 1]; ytm[k * 3 + 2] = y[j * 3 + 2];
      k++;
    }
  }
  kabsch(r1, r2, k, 1, t, u, kres);

  const len = k;
  const dis = W.dis;
  const d00 = d0Search;
  const d002 = d00 * d00;
  const d02 = d0 * d0;
  const nAli = k;
  const xrot = W.xrot;
  let tmscore = 0; let tmscore1; let tmscore2; let di;

  for (k = 0; k < nAli; k++) {
    transform(t, u, xtm, k * 3, xrot, 0);
    di = dist2(xrot, 0, ytm, k * 3);
    dis[k] = di;
    tmscore += 1 / (1 + di / d02);
  }

  let d002t = d002;
  for (;;) {
    j = 0;
    for (k = 0; k < nAli; k++) {
      if (dis[k] <= d002t) {
        r1[j * 3] = xtm[k * 3]; r1[j * 3 + 1] = xtm[k * 3 + 1]; r1[j * 3 + 2] = xtm[k * 3 + 2];
        r2[j * 3] = ytm[k * 3]; r2[j * 3 + 1] = ytm[k * 3 + 1]; r2[j * 3 + 2] = ytm[k * 3 + 2];
        j++;
      }
    }
    if (j < 3 && nAli > 3) d002t += 0.5; else break;
  }

  if (nAli !== j) {
    kabsch(r1, r2, j, 1, t, u, kres);
    tmscore1 = 0;
    for (k = 0; k < nAli; k++) {
      transform(t, u, xtm, k * 3, xrot, 0);
      di = dist2(xrot, 0, ytm, k * 3);
      dis[k] = di;
      tmscore1 += 1 / (1 + di / d02);
    }

    d002t = d002 + 1;
    for (;;) {
      j = 0;
      for (k = 0; k < nAli; k++) {
        if (dis[k] <= d002t) {
          r1[j * 3] = xtm[k * 3]; r1[j * 3 + 1] = xtm[k * 3 + 1]; r1[j * 3 + 2] = xtm[k * 3 + 2];
          r2[j * 3] = ytm[k * 3]; r2[j * 3 + 1] = ytm[k * 3 + 1]; r2[j * 3 + 2] = ytm[k * 3 + 2];
          j++;
        }
      }
      if (j < 3 && nAli > 3) d002t += 0.5; else break;
    }

    kabsch(r1, r2, j, 1, t, u, kres);
    tmscore2 = 0;
    for (k = 0; k < nAli; k++) {
      transform(t, u, xtm, k * 3, xrot, 0);
      di = dist2(xrot, 0, ytm, k * 3);
      tmscore2 += 1 / (1 + di / d02);
    }
  } else { tmscore1 = tmscore; tmscore2 = tmscore; }

  if (tmscore1 >= tmscore) tmscore = tmscore1;
  if (tmscore2 >= tmscore) tmscore = tmscore2;
  return tmscore;
}

// --- get_initial: gapless threading (TMalign.cpp:2341-2390) -----------------

function getInitial(W, x, y, xlen, ylen, y2x, d0, d0Search, fastOpt, t, u) {
  const minLen = Math.min(xlen, ylen);
  if (minLen < 3) throw new Error('Sequence is too short <3');
  let minAli = Math.floor(minLen / 2);
  if (minAli <= 5) minAli = 5;
  const n1 = -ylen + minAli;
  const n2 = xlen - minAli;

  let i; let j; let k;
  let tmscore; let tmscoreMax = -1;
  let kBest = n1;

  for (k = n1; k <= n2; k += fastOpt ? 5 : 1) {
    for (j = 0; j < ylen; j++) {
      i = j + k;
      y2x[j] = (i >= 0 && i < xlen) ? i : -1;
    }
    tmscore = getScoreFast(W, x, y, ylen, y2x, d0, d0Search, t, u);
    if (tmscore >= tmscoreMax) { tmscoreMax = tmscore; kBest = k; }
  }

  k = kBest;
  for (j = 0; j < ylen; j++) {
    i = j + k;
    y2x[j] = (i >= 0 && i < xlen) ? i : -1;
  }
  return tmscoreMax;
}

// --- secondary structure (TMalign.cpp:2436-2497) ----------------------------

function secStr(dis13, dis14, dis15, dis24, dis25, dis35) {
  let delta = 2.1;
  if (Math.abs(dis15 - 6.37) < delta && Math.abs(dis14 - 5.18) < delta
    && Math.abs(dis25 - 5.18) < delta && Math.abs(dis13 - 5.45) < delta
    && Math.abs(dis24 - 5.45) < delta && Math.abs(dis35 - 5.45) < delta) return 'H';
  delta = 1.42;
  if (Math.abs(dis15 - 13) < delta && Math.abs(dis14 - 10.4) < delta
    && Math.abs(dis25 - 10.4) < delta && Math.abs(dis13 - 6.1) < delta
    && Math.abs(dis24 - 6.1) < delta && Math.abs(dis35 - 6.1) < delta) return 'E';
  if (dis15 < 8) return 'T';
  return 'C';
}

/** make_sec (TMalign.cpp:2466). Returns a string of length len. */
function makeSec(x, len) {
  const sec = new Array(len);
  for (let i = 0; i < len; i++) {
    sec[i] = 'C';
    const j1 = i - 2; const j2 = i - 1; const j3 = i; const j4 = i + 1; const j5 = i + 2;
    if (j1 >= 0 && j5 < len) {
      sec[i] = secStr(
        Math.sqrt(dist2(x, j1 * 3, x, j3 * 3)),
        Math.sqrt(dist2(x, j1 * 3, x, j4 * 3)),
        Math.sqrt(dist2(x, j1 * 3, x, j5 * 3)),
        Math.sqrt(dist2(x, j2 * 3, x, j4 * 3)),
        Math.sqrt(dist2(x, j2 * 3, x, j5 * 3)),
        Math.sqrt(dist2(x, j3 * 3, x, j5 * 3)),
      );
    }
  }
  return sec.join('');
}

/**
 * Tidy a secondary-structure string for DISPLAY.
 *
 * make_sec is deliberately conservative — it needs five consecutive Cα matching
 * an idealised geometry, so it marks element cores and leaves their ends coil.
 * Good for seeding an alignment, poor for drawing: on a PDZ domain only about a
 * quarter of residues land in a run long enough to be a ribbon, so a mostly-β
 * fold renders as mostly loop.
 *
 * TM-align's own smooth() (TMalign.cpp:2392) is NOT the fix, though it looks
 * like it. It is a pruning pass built to clean up alignment seeds: it deletes
 * isolated singles AND isolated pairs, and bridging single gaps does not recover
 * what that costs. Measured, it moves the ribbon fraction the wrong way — 30% to
 * 23% on a PDZ domain, 59% to 58% on Ras.
 *
 * So this does the two defensible things only: bridge a one-residue gap inside an
 * element, since a run interrupted by one marginal residue is one element; and
 * drop a lone residue with no element neighbours, since that is speckle. It does
 * not grow element ends. Inflating them would draw structure that was not
 * assigned, which is worse than a fold that looks loopy.
 *
 * NOT used by the aligner. tmalignMain must keep the raw assignment or the
 * SS-seeded stage stops matching the C++, which is checked to 5e-11.
 */
function smoothSec(sec) {
  const a = [...sec];
  // bridge a single-residue gap: x-x => xxx
  for (let i = 0; i + 2 < a.length; i++) {
    for (const j of ['H', 'E']) {
      if (a[i] === j && a[i + 1] !== j && a[i + 2] === j) a[i + 1] = j;
    }
  }
  // drop a lone element residue with no element neighbour on either side
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== 'H' && a[i] !== 'E') continue;
    const before = i > 0 && a[i - 1] === a[i];
    const after = i + 1 < a.length && a[i + 1] === a[i];
    if (!before && !after) a[i] = 'C';
  }
  return a.join('');
}

// --- get_initial5: local superposition (TMalign.cpp:2514-2611) --------------

function getInitial5(W, x, y, xlen, ylen, y2x, d0, d0Search, fastOpt, D0_MIN) {
  const { r1, r2, path, val, kres } = W;
  const t = W.i5_t; const u = W.i5_u; // local in C++ (TMalign.cpp:2519)
  const d01raw = d0 + 1.5;
  const d01 = d01raw < D0_MIN ? D0_MIN : d01raw;
  const d02 = d01 * d01;

  let GLmax = 0;
  const aL = Math.min(xlen, ylen);
  const invmap = new Int32Array(ylen + 1);

  let nJump1;
  if (xlen > 250) nJump1 = 45;
  else if (xlen > 200) nJump1 = 35;
  else if (xlen > 150) nJump1 = 25;
  else nJump1 = 15;
  if (nJump1 > Math.floor(xlen / 3)) nJump1 = Math.floor(xlen / 3);

  let nJump2;
  if (ylen > 250) nJump2 = 45;
  else if (ylen > 200) nJump2 = 35;
  else if (ylen > 150) nJump2 = 25;
  else nJump2 = 15;
  if (nJump2 > Math.floor(ylen / 3)) nJump2 = Math.floor(ylen / 3);

  const nFrag = [20, 100];
  if (nFrag[0] > Math.floor(aL / 3)) nFrag[0] = Math.floor(aL / 3);
  if (nFrag[1] > Math.floor(aL / 2)) nFrag[1] = Math.floor(aL / 2);

  if (fastOpt) { nJump1 *= 5; nJump2 *= 5; }
  let flag = false;

  for (let iFrag = 0; iFrag < 2; iFrag++) {
    const m1 = xlen - nFrag[iFrag] + 1;
    const m2 = ylen - nFrag[iFrag] + 1;
    for (let i = 0; i < m1; i += nJump1) {
      for (let j = 0; j < m2; j += nJump2) {
        for (let k = 0; k < nFrag[iFrag]; k++) {
          r1[k * 3] = x[(k + i) * 3];
          r1[k * 3 + 1] = x[(k + i) * 3 + 1];
          r1[k * 3 + 2] = x[(k + i) * 3 + 2];
          r2[k * 3] = y[(k + j) * 3];
          r2[k * 3 + 1] = y[(k + j) * 3 + 1];
          r2[k * 3 + 2] = y[(k + j) * 3 + 2];
        }
        kabsch(r1, r2, nFrag[iFrag], 1, t, u, kres);
        nwdpRot(path, val, x, y, xlen, ylen, t, u, d02, 0.0, invmap);
        const GL = getScoreFast(W, x, y, ylen, invmap, d0, d0Search, t, u);
        if (GL > GLmax) {
          GLmax = GL;
          for (let ii = 0; ii < ylen; ii++) y2x[ii] = invmap[ii];
          flag = true;
        }
      }
    }
  }
  return flag;
}

// --- get_initial_ssplus (TMalign.cpp:2613-2676) -----------------------------

function scoreMatrixRmsdSec(W, score, secx, secy, x, y, xlen, ylen, y2x, D0_MIN, d0) {
  const { r1, r2, kres } = W;
  const t = W.sm_t; const u = W.sm_u; // local in C++ (TMalign.cpp:2617)
  const d01raw = d0 + 1.5;
  const d01 = d01raw < D0_MIN ? D0_MIN : d01raw;
  const d02 = d01 * d01;

  let k = 0;
  for (let j = 0; j < ylen; j++) {
    const i = y2x[j];
    if (i >= 0) {
      r1[k * 3] = x[i * 3]; r1[k * 3 + 1] = x[i * 3 + 1]; r1[k * 3 + 2] = x[i * 3 + 2];
      r2[k * 3] = y[j * 3]; r2[k * 3 + 1] = y[j * 3 + 1]; r2[k * 3 + 2] = y[j * 3 + 2];
      k++;
    }
  }
  kabsch(r1, r2, k, 1, t, u, kres);

  const xx = W.xrot;
  const sw = ylen + 1;
  for (let ii = 0; ii < xlen; ii++) {
    transform(t, u, x, ii * 3, xx, 0);
    for (let jj = 0; jj < ylen; jj++) {
      const dij = dist2(xx, 0, y, jj * 3);
      score[(ii + 1) * sw + (jj + 1)] = secx[ii] === secy[jj]
        ? 1.0 / (1 + dij / d02) + 0.5
        : 1.0 / (1 + dij / d02);
    }
  }
}

function getInitialSsplus(W, score, secx, secy, x, y, xlen, ylen, y2x0, y2x, D0_MIN, d0) {
  scoreMatrixRmsdSec(W, score, secx, secy, x, y, xlen, ylen, y2x0, D0_MIN, d0);
  nwdpScore(score, W.path, W.val, xlen, ylen, -1.0, y2x);
}

// --- get_initial_fgt (TMalign.cpp:2678-2977) --------------------------------

function findMaxFrag(x, len, dcu0, fastOpt) {
  let fraMin = 4;
  if (fastOpt) fraMin = 8;
  let LfrMax = 0;
  let startMax = 0; let endMax = 0;

  let rMin = Math.floor(len * 1.0 / 3.0);
  if (rMin > fraMin) rMin = fraMin;

  let inc = 0;
  const dcu0Cut = dcu0 * dcu0;
  let dcuCut = dcu0Cut;

  while (LfrMax < rMin) {
    LfrMax = 0;
    let j = 1;
    let start = 0;
    for (let i = 1; i < len; i++) {
      if (dist2(x, (i - 1) * 3, x, i * 3) < dcuCut) {
        j++;
        if (i === len - 1) {
          if (j > LfrMax) { LfrMax = j; startMax = start; endMax = i; }
          j = 1;
        }
      } else {
        if (j > LfrMax) { LfrMax = j; startMax = start; endMax = i - 1; }
        j = 1;
        start = i;
      }
    }
    if (LfrMax < rMin) {
      inc++;
      const dinc = (1.1 ** inc) * dcu0;
      dcuCut = dinc * dinc;
    }
  }
  return { startMax, endMax };
}

function getInitialFgt(W, x, y, xlen, ylen, y2x, d0, d0Search, dcu0, fastOpt, t, u) {
  let fraMin = 4;
  if (fastOpt) fraMin = 8;
  const fraMin1 = fraMin - 1;

  const fx = findMaxFrag(x, xlen, dcu0, fastOpt);
  const fy = findMaxFrag(y, ylen, dcu0, fastOpt);
  const xstart = fx.startMax; const xend = fx.endMax;
  const ystart = fy.startMax; const yend = fy.endMax;

  const Lx = xend - xstart + 1;
  const Ly = yend - ystart + 1;
  let LFr = Math.min(Lx, Ly);
  const ifr = new Int32Array(LFr);
  const y2x_ = new Int32Array(ylen + 1);

  let i; let j; let k; let n1; let n2; let minLen; let minAli;
  let tmscore; let tmscoreMax = -1;

  if (Lx < Ly || (Lx === Ly && xlen < ylen)) {
    for (i = 0; i < LFr; i++) ifr[i] = xstart + i;
  } else if (Lx > Ly || (Lx === Ly && xlen > ylen)) {
    for (i = 0; i < LFr; i++) ifr[i] = ystart + i;
  } else {
    // L0 == xlen == ylen; LFr == Lx == Ly (TMalign.cpp:2793)
    const L0 = xlen;

    for (i = 0; i < LFr; i++) ifr[i] = xstart + i;
    if (LFr === L0) {
      n1 = Math.floor(L0 * 0.1);
      n2 = Math.floor(L0 * 0.89);
      j = 0;
      for (i = n1; i <= n2; i++) { ifr[j] = ifr[i]; j++; }
      LFr = j;
    }
    const L1 = LFr;
    minLen = Math.min(L1, ylen);
    minAli = Math.floor(minLen / 2.5);
    if (minAli <= fraMin1) minAli = fraMin1;
    n1 = -ylen + minAli;
    n2 = L1 - minAli;
    for (k = n1; k <= n2; k += fastOpt ? 3 : 1) {
      for (j = 0; j < ylen; j++) {
        i = j + k;
        y2x_[j] = (i >= 0 && i < L1) ? ifr[i] : -1;
      }
      tmscore = getScoreFast(W, x, y, ylen, y2x_, d0, d0Search, t, u);
      if (tmscore >= tmscoreMax) {
        tmscoreMax = tmscore;
        for (j = 0; j < ylen; j++) y2x[j] = y2x_[j];
      }
    }

    LFr = Ly;
    for (i = 0; i < LFr; i++) ifr[i] = ystart + i;
    if (LFr === L0) {
      n1 = Math.floor(L0 * 0.1);
      n2 = Math.floor(L0 * 0.89);
      j = 0;
      for (i = n1; i <= n2; i++) { ifr[j] = ifr[i]; j++; }
      LFr = j;
    }
    const L2 = LFr;
    minLen = Math.min(xlen, L2);
    minAli = Math.floor(minLen / 2.5);
    if (minAli <= fraMin1) minAli = fraMin1;
    n1 = -L2 + minAli;
    n2 = xlen - minAli;
    for (k = n1; k <= n2; k++) {
      for (j = 0; j < ylen; j++) y2x_[j] = -1;
      for (j = 0; j < L2; j++) {
        i = j + k;
        if (i >= 0 && i < xlen) y2x_[ifr[j]] = i;
      }
      tmscore = getScoreFast(W, x, y, ylen, y2x_, d0, d0Search, t, u);
      if (tmscore >= tmscoreMax) {
        tmscoreMax = tmscore;
        for (j = 0; j < ylen; j++) y2x[j] = y2x_[j];
      }
    }
    return tmscoreMax;
  }

  const L0 = Math.min(xlen, ylen);
  if (LFr === L0) {
    n1 = Math.floor(L0 * 0.1);
    n2 = Math.floor(L0 * 0.89);
    j = 0;
    for (i = n1; i <= n2; i++) { ifr[j] = ifr[i]; j++; }
    LFr = j;
  }

  if (Lx < Ly || (Lx === Ly && xlen <= ylen)) {
    const L1 = LFr;
    minLen = Math.min(L1, ylen);
    minAli = Math.floor(minLen / 2.5);
    if (minAli <= fraMin1) minAli = fraMin1;
    n1 = -ylen + minAli;
    n2 = L1 - minAli;
    for (k = n1; k <= n2; k += fastOpt ? 3 : 1) {
      for (j = 0; j < ylen; j++) {
        i = j + k;
        y2x_[j] = (i >= 0 && i < L1) ? ifr[i] : -1;
      }
      tmscore = getScoreFast(W, x, y, ylen, y2x_, d0, d0Search, t, u);
      if (tmscore >= tmscoreMax) {
        tmscoreMax = tmscore;
        for (j = 0; j < ylen; j++) y2x[j] = y2x_[j];
      }
    }
  } else {
    const L2 = LFr;
    minLen = Math.min(xlen, L2);
    minAli = Math.floor(minLen / 2.5);
    if (minAli <= fraMin1) minAli = fraMin1;
    n1 = -L2 + minAli;
    n2 = xlen - minAli;
    for (k = n1; k <= n2; k++) {
      for (j = 0; j < ylen; j++) y2x_[j] = -1;
      for (j = 0; j < L2; j++) {
        i = j + k;
        if (i >= 0 && i < xlen) y2x_[ifr[j]] = i;
      }
      tmscore = getScoreFast(W, x, y, ylen, y2x_, d0, d0Search, t, u);
      if (tmscore >= tmscoreMax) {
        tmscoreMax = tmscore;
        for (j = 0; j < ylen; j++) y2x[j] = y2x_[j];
      }
    }
  }
  return tmscoreMax;
}

// --- DP_iter (TMalign.cpp:2979-3045) ----------------------------------------

function dpIter(W, x, y, xlen, ylen, t, u, invmap0, g1, g2, iterationMax,
  localD0Search, D0_MIN, Lnorm, d0, scoreD8) {
  const gapOpen = [-0.6, 0];
  const invmap = W.invmapTmp;
  const { path, val, xtm, ytm } = W;
  let iteration; let i; let j; let k;
  let tmscore; let tmscoreMax = -1; let tmscoreOld = 0;
  const scoreSumMethod = 8; const simplifyStep = 40;
  const d02 = d0 * d0;

  for (let g = g1; g < g2; g++) {
    for (iteration = 0; iteration < iterationMax; iteration++) {
      nwdpRot(path, val, x, y, xlen, ylen, t, u, d02, gapOpen[g], invmap);

      k = 0;
      for (j = 0; j < ylen; j++) {
        i = invmap[j];
        if (i >= 0) {
          xtm[k * 3] = x[i * 3]; xtm[k * 3 + 1] = x[i * 3 + 1]; xtm[k * 3 + 2] = x[i * 3 + 2];
          ytm[k * 3] = y[j * 3]; ytm[k * 3 + 1] = y[j * 3 + 1]; ytm[k * 3 + 2] = y[j * 3 + 2];
          k++;
        }
      }

      tmscore = tmscore8Search(W, xtm, ytm, k, t, u, simplifyStep,
        scoreSumMethod, localD0Search, Lnorm, scoreD8, d0, false);

      if (tmscore > tmscoreMax) {
        tmscoreMax = tmscore;
        for (i = 0; i < ylen; i++) invmap0[i] = invmap[i];
      }
      if (iteration > 0 && Math.abs(tmscoreOld - tmscore) < 0.000001) break;
      tmscoreOld = tmscore;
    }
  }
  if (TRACE.on) TRACE.log.push(`DP ${tmscoreMax.toFixed(10)}`);
  return tmscoreMax;
}

// --- workspace --------------------------------------------------------------

function makeWorkspace(xlen, ylen) {
  const minlen = Math.min(xlen, ylen);
  return {
    score: new Float64Array((xlen + 1) * (ylen + 1)),
    path: new Uint8Array((xlen + 1) * (ylen + 1)),
    // two rows, not a full matrix: see nwTraceback
    val: new Float64Array(2 * (ylen + 1)),
    xtm: new Float64Array(minlen * 3),
    ytm: new Float64Array(minlen * 3),
    xt: new Float64Array(xlen * 3),
    r1: new Float64Array(minlen * 3),
    r2: new Float64Array(minlen * 3),
    dis: new Float64Array(minlen),
    kAli: new Int32Array(minlen),
    iAli: new Int32Array(minlen),
    xrot: new Float64Array(3),
    t: new Float64Array(3),
    u: new Float64Array(9),
    ts_t: new Float64Array(3),
    ts_u: new Float64Array(9),
    i5_t: new Float64Array(3),
    i5_u: new Float64Array(9),
    sm_t: new Float64Array(3),
    sm_u: new Float64Array(9),
    kres: { rms: 0, score: 0 },
    invmapTmp: new Int32Array(ylen + 1),
  };
}

// --- TMalign_main (TMalign.cpp:3923-4524) -----------------------------------

/**
 * @param {Float64Array} xa - chain 1 Cα, flat stride 3 (superimposed onto ya)
 * @param {Float64Array} ya - chain 2 Cα, flat stride 3
 * @param {string} secx, secy - secondary structure strings from makeSec
 * @returns {{TM1, TM2, t0, u0, invmap0, n_ali8, rmsd0, d0A, d0B}}
 *   TM1 normalized by ylen (chain 2), TM2 by xlen (chain 1).
 *   t0/u0 rotate chain 1 onto chain 2 — this is what TM-align's -m emits.
 */
function tmalignMain(xa, ya, secx, secy, xlen, ylen, fastOpt) {
  const W = makeWorkspace(xlen, ylen);
  const P = {
    D0_MIN: 0, Lnorm: 0, score_d8: 0, d0: 0, d0_search: 0, dcu0: 0,
  };
  parameterSet4search(xlen, ylen, P);
  let { D0_MIN, Lnorm, d0 } = P;
  const { score_d8: scoreD8, dcu0 } = P;

  let simplifyStep = 40;
  let scoreSumMethod = 8;

  const invmap0 = new Int32Array(ylen + 1).fill(-1);
  const invmap = new Int32Array(ylen + 1);
  const { t, u, score, path, val, kres } = W;
  const t0 = new Float64Array(3);
  const u0 = new Float64Array(9);

  let TM; let TMmax = -1;
  let ddcc = 0.4;
  if (Lnorm <= 40) ddcc = 0.1;
  let localD0Search = P.d0_search;

  /* gapless threading */
  getInitial(W, xa, ya, xlen, ylen, invmap0, d0, P.d0_search, fastOpt, t, u);
  TM = detailedSearch(W, xa, ya, ylen, invmap0, t, u, simplifyStep,
    scoreSumMethod, localD0Search, Lnorm, scoreD8, d0);
  if (TM > TMmax) TMmax = TM;
  TM = dpIter(W, xa, ya, xlen, ylen, t, u, invmap, 0, 2, fastOpt ? 2 : 30,
    localD0Search, D0_MIN, Lnorm, d0, scoreD8);
  if (TM > TMmax) {
    TMmax = TM;
    for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
  }

  /* secondary structure */
  nwdpSec(path, val, secx, secy, xlen, ylen, -1.0, invmap);
  TM = detailedSearch(W, xa, ya, ylen, invmap, t, u, simplifyStep,
    scoreSumMethod, localD0Search, Lnorm, scoreD8, d0);
  if (TM > TMmax) {
    TMmax = TM;
    for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
  }
  if (TM > TMmax * 0.2) {
    TM = dpIter(W, xa, ya, xlen, ylen, t, u, invmap, 0, 2, fastOpt ? 2 : 30,
      localD0Search, D0_MIN, Lnorm, d0, scoreD8);
    if (TM > TMmax) {
      TMmax = TM;
      for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
    }
  }

  /* local superposition */
  if (getInitial5(W, xa, ya, xlen, ylen, invmap, d0, P.d0_search, fastOpt, D0_MIN)) {
    TM = detailedSearch(W, xa, ya, ylen, invmap, t, u, simplifyStep,
      scoreSumMethod, localD0Search, Lnorm, scoreD8, d0);
    if (TM > TMmax) {
      TMmax = TM;
      for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
    }
    if (TM > TMmax * ddcc) {
      TM = dpIter(W, xa, ya, xlen, ylen, t, u, invmap, 0, 2, 2,
        localD0Search, D0_MIN, Lnorm, d0, scoreD8);
      if (TM > TMmax) {
        TMmax = TM;
        for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
      }
    }
  }

  /* local superposition + secondary structure */
  getInitialSsplus(W, score, secx, secy, xa, ya, xlen, ylen, invmap0, invmap, D0_MIN, d0);
  TM = detailedSearch(W, xa, ya, ylen, invmap, t, u, simplifyStep,
    scoreSumMethod, localD0Search, Lnorm, scoreD8, d0);
  if (TM > TMmax) {
    TMmax = TM;
    for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
  }
  if (TM > TMmax * ddcc) {
    TM = dpIter(W, xa, ya, xlen, ylen, t, u, invmap, 0, 2, fastOpt ? 2 : 30,
      localD0Search, D0_MIN, Lnorm, d0, scoreD8);
    if (TM > TMmax) {
      TMmax = TM;
      for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
    }
  }

  /* fragment gapless threading */
  getInitialFgt(W, xa, ya, xlen, ylen, invmap, d0, P.d0_search, dcu0, fastOpt, t, u);
  TM = detailedSearch(W, xa, ya, ylen, invmap, t, u, simplifyStep,
    scoreSumMethod, localD0Search, Lnorm, scoreD8, d0);
  if (TM > TMmax) {
    TMmax = TM;
    for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
  }
  if (TM > TMmax * ddcc) {
    TM = dpIter(W, xa, ya, xlen, ylen, t, u, invmap, 1, 2, 2,
      localD0Search, D0_MIN, Lnorm, d0, scoreD8);
    if (TM > TMmax) {
      TMmax = TM;
      for (let i = 0; i < ylen; i++) invmap0[i] = invmap[i];
    }
  }

  let flag = false;
  for (let i = 0; i < ylen; i++) if (invmap0[i] >= 0) { flag = true; break; }
  if (!flag) throw new Error('There is no alignment between the two proteins');

  /* final detailed search */
  simplifyStep = 1;
  if (fastOpt) simplifyStep = 40;
  scoreSumMethod = 8;
  detailedSearchStandard(W, xa, ya, ylen, invmap0, t, u, simplifyStep,
    scoreSumMethod, localD0Search, false, Lnorm, scoreD8, d0);

  /* select pairs with dis < d8 */
  const m1 = new Int32Array(xlen);
  const m2 = new Int32Array(ylen);
  const { xt, xtm, ytm, r1, r2 } = W;
  doRotation(xa, xt, xlen, t, u);
  let k = 0; let nAli = 0; let d;
  for (let j = 0; j < ylen; j++) {
    const i = invmap0[j];
    if (i >= 0) {
      nAli++;
      d = Math.sqrt(dist2(xt, i * 3, ya, j * 3));
      if (d <= scoreD8) {
        m1[k] = i; m2[k] = j;
        xtm[k * 3] = xa[i * 3]; xtm[k * 3 + 1] = xa[i * 3 + 1]; xtm[k * 3 + 2] = xa[i * 3 + 2];
        ytm[k * 3] = ya[j * 3]; ytm[k * 3 + 1] = ya[j * 3 + 1]; ytm[k * 3 + 2] = ya[j * 3 + 2];
        r1[k * 3] = xt[i * 3]; r1[k * 3 + 1] = xt[i * 3 + 1]; r1[k * 3 + 2] = xt[i * 3 + 2];
        r2[k * 3] = ya[j * 3]; r2[k * 3 + 1] = ya[j * 3 + 1]; r2[k * 3 + 2] = ya[j * 3 + 2];
        k++;
      }
    }
  }
  const nAli8 = k;

  kabsch(r1, r2, nAli8, 0, t, u, kres);
  const rmsd0 = Math.sqrt(kres.rms / nAli8);

  /* final TM-scores */
  simplifyStep = 1;
  scoreSumMethod = 0;

  parameterSet4final(ylen, P);
  const d0A = P.d0;
  localD0Search = P.d0_search;
  const TM1 = tmscore8Search(W, xtm, ytm, nAli8, t0, u0, simplifyStep,
    scoreSumMethod, localD0Search, P.Lnorm, scoreD8, P.d0, false);

  parameterSet4final(xlen, P);
  const d0B = P.d0;
  localD0Search = P.d0_search;
  const TM2 = tmscore8Search(W, xtm, ytm, nAli8, t, u, simplifyStep,
    scoreSumMethod, localD0Search, P.Lnorm, scoreD8, P.d0, false);

  return {
    TM1, TM2, t0, u0, invmap0, n_ali8: nAli8, n_ali: nAli, rmsd0, d0A, d0B, m1, m2,
  };
}

// --- CPalign_main (TMalign.cpp:4526-4684) -----------------------------------

/**
 * TM-align with circular permutation, equivalent to `TMalign x y -cp`.
 *
 * Chain 1 is duplicated head-to-tail and aligned to chain 2; the densest
 * window of length xlen gives the cut point. If the plain sequential
 * alignment already covers at least as many residues, the cut is discarded
 * (cp_point = 0) and the result is ordinary TM-align.
 *
 * IMPORTANT: t0/u0 apply to chain 1 *after* rotating its residue order by
 * cpPoint. Use permuteCoords(xa, xlen, cpPoint) before applying them.
 *
 * @returns {{cpPoint, TM1, TM2, t0, u0, ...}} TM1 normalized by chain 2.
 */
function cpAlign(xa, ya, xlen, ylen, opts = {}) {
  const fastOpt = opts.fast ?? false;
  // The two SEARCH passes -- the duplicated alignment and the sequential one -- default to fast because
  // that is what TMalign.cpp hardcodes: in the C++ they exist only to decide whether the permutation is
  // real, and their scores are never reported, so a coarse search is enough for a comparison of aligned
  // counts.
  //
  // Exposed because we DO report pass 2's score. A caller that shows it alongside a full-settings pass 3
  // would otherwise be putting two different search efforts side by side, which is the trap this file
  // warns about elsewhere. Passing searchFast: false makes all three passes comparable and lets the
  // caller reuse `linear` instead of running a second full alignment.
  //
  // It CAN change the answer, which is why the default is the C++ one: cpAlnBest comes from pass 1 and
  // the `lin.n_ali8 > cpAlnBest` test from pass 2, so searching harder can move the chosen cut point --
  // usually toward declining the permutation, since a better-searched sequential alignment covers more
  // residues. test/tmalign_parity.mjs exercises the default and so still pins the C++ behaviour.
  const searchFast = opts.searchFast ?? true;

  /* duplicate chain 1 head to tail */
  const xaCp = new Float64Array(xlen * 2 * 3);
  for (let r = 0; r < xlen; r++) {
    for (let c = 0; c < 3; c++) {
      xaCp[r * 3 + c] = xa[r * 3 + c];
      xaCp[(r + xlen) * 3 + c] = xa[r * 3 + c];
    }
  }
  // The duplicated secondary structure is the ORIGINAL chain's SS repeated
  // (TMalign.cpp:4560), NOT make_sec over the duplicated coordinates. They
  // differ at the junction: make_sec leaves the first and last two residues
  // 'C', and the C++ keeps those 'C's rather than assigning across the wrap.
  const secx = makeSec(xa, xlen);
  const secxCp = secx + secx;
  const secy = makeSec(ya, ylen);

  /* pass 1: align the duplicated chain (fast by default, as in the C++) */
  const dup = tmalignMain(xaCp, ya, secxCp, secy, xlen * 2, ylen, searchFast);

  // The C++ counts aligned residues in the gap-stripped alignment string
  // (TMalign.cpp:4576-4600). That string is built from m1/m2 — the n_ali8
  // pairs surviving the d <= score_d8 filter — NOT from all of invmap0.
  // Using invmap0 here over-counts and picks the wrong cut point.
  const x2y = new Int8Array(xlen * 2);
  for (let k = 0; k < dup.n_ali8; k++) x2y[dup.m1[k]] = 1;

  let cpPoint = 0;
  let cpAlnBest = 0;
  // Sliding window of length xlen over the duplicated chain.
  let cur = 0;
  for (let i = 0; i < xlen; i++) cur += x2y[i];
  if (cur > cpAlnBest) { cpAlnBest = cur; cpPoint = 0; }
  for (let r = 1; r < xlen - 1; r++) {
    cur += x2y[r + xlen - 1] - x2y[r - 1];
    if (cur > cpAlnBest) { cpAlnBest = cur; cpPoint = r; }
  }

  /* pass 2: plain sequential alignment, to decide whether the CP is real -- and, for callers that ask
     for it at full settings, to BE the sequential answer they report */
  const lin = tmalignMain(xa, ya, secx, secy, xlen, ylen, searchFast);
  if (lin.n_ali8 > cpAlnBest) cpPoint = 0;

  /* pass 3: full alignment on the permuted chain */
  const xaFinal = cpPoint !== 0 ? permuteCoords(xa, xlen, cpPoint) : xa;
  // The C++ SLICES the secondary structure out of the duplicated chain
  // (TMalign.cpp:4633-4643) rather than recomputing it on the permuted chain.
  // The two differ at the join: make_sec only assigns residues with two
  // neighbours on each side, so recomputing would mark the first and last two
  // residues 'C', whereas the duplicated chain assigns them across the wrap.
  // This holds even when cpPoint is 0.
  const secFinal = secxCp.slice(cpPoint, cpPoint + xlen);
  const res = tmalignMain(xaFinal, ya, secFinal, secy, xlen, ylen, fastOpt);

  return {
    ...res,
    cpPoint,
    cpAlnBest,
    // THE WHOLE pass-2 result, not a summary of it.
    //
    // Pass 2 is an ordinary sequential alignment with exactly the arguments tmAlign() would build --
    // makeSec on each chain, fast on -- so a caller that wants both answers has already paid for this
    // one and must not run it again. It used to return three fields, which was too little to draw with,
    // so worker.js called tmAlign separately and repeated 22-29% of the work for a bit-identical result.
    //
    // Reusable only when pass 2 ran at the same effort as pass 3 -- that is, when searchFast matches
    // fast. With the defaults (searchFast true, fast false) `linear` is the sequential answer AT FAST
    // SETTINGS whatever pass 3 did, and pairing the two would compare unlike things.
    linear: lin,
  };
}

/** Rotate a chain's residue order by k: new[i] = old[(i + k) % n]. */
function permuteCoords(xa, n, k) {
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = (i + k) % n;
    out[i * 3] = xa[s * 3];
    out[i * 3 + 1] = xa[s * 3 + 1];
    out[i * 3 + 2] = xa[s * 3 + 2];
  }
  return out;
}

/** Ordinary TM-align (no circular permutation). */
function tmAlign(xa, ya, xlen, ylen, opts = {}) {
  return tmalignMain(xa, ya, makeSec(xa, xlen), makeSec(ya, ylen),
    xlen, ylen, opts.fast ?? false);
}

/** Apply a TM-align transform to a chain, returning new coordinates. */
function applyTransform(xa, n, t, u) {
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) transform(t, u, xa, i * 3, out, i * 3);
  return out;
}

/**
 * The same superposition, run the other way: chain 2 brought into chain 1's frame.
 *
 * applyTransform maps the query onto the hit, which is TM-align's own direction and the right one
 * for scoring. It is the wrong one for a viewer that shows many hits against one query: moving the
 * query means the query is drawn in a different orientation for every hit, so nothing can be
 * compared by eye. Inverting it leaves the query alone and brings each hit to it instead.
 *
 * u is a rotation, so the inverse of `y = t + U x` is `x = U^T (y - t)` — a transpose, no matrix
 * inversion involved.
 */
function applyInverseTransform(ya, n, t, u) {
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = ya[i * 3] - t[0];
    const b = ya[i * 3 + 1] - t[1];
    const c = ya[i * 3 + 2] - t[2];
    out[i * 3] = u[0] * a + u[3] * b + u[6] * c;
    out[i * 3 + 1] = u[1] * a + u[4] * b + u[7] * c;
    out[i * 3 + 2] = u[2] * a + u[5] * b + u[8] * c;
  }
  return out;
}
// <<< END GENERATED
//
// EVERYTHING ABOVE THIS LINE IS A COPY, and it sits at column zero while the
// rest of this file is indented because it is a BYTE-FOR-BYTE copy: reindenting
// it would break the diff that proves it is one. Do not edit inside the
// markers; regenerate with `node tests/vendor_tmalign.mjs --write`, which is
// also what tests/align.js runs to check that nobody has.
//
// It is in this file rather than beside it because two scripts meant two
// <script> tags, two names in the worker's importScripts, and two ways for a
// page to end up with half of the feature loaded.

    var IN_WORKER = (typeof importScripts === 'function');
    // Where this file was loaded from, which is also where its siblings are.
    // Empty when the script was inlined - see WHERE IT RUNS above.
    var SELF_URL = '';
    if (!IN_WORKER && typeof document !== 'undefined' && document.currentScript) {
        SELF_URL = document.currentScript.src || '';
    }

    // A chain shorter than this cannot be aligned to anything meaningfully -
    // TM-align's own d0 is undefined below 15 residues and clamped there, and
    // make_sec needs four. Below it the score is noise with a confident face on.
    var MIN_CHAIN = 15;

    // TM-align's full search, or its `fast` one. See WHICH CHAIN above for the
    // measurement and what the fast search costs in the tail. One place to
    // change it, and both hosts read it.
    var FULL_SEARCH = false;

    /** x, y, z out of whatever a coordinate is here - [x,y,z] or a Vec3. */
    function xyz(c) {
        return (c && c.length >= 3) ? [c[0], c[1], c[2]] : [c.x, c.y, c.z];
    }

    /**
     * The protein C-alpha chains of one coordinate array, as TM-align input.
     *
     * @param {Array} coords    per-position [x,y,z]
     * @param {Array} types     per-position 'P' | 'D' | 'R' | 'L'
     * @param {Array} chainIds  per-position chain id
     * @param {Set}   [only]    restrict to these position indices
     * @returns {Array<{id, len, flat: Float64Array, index: Int32Array}>}
     *   `index` is the position index each C-alpha came from, so an alignment
     *   can be read back onto the structure it came out of.
     */
    function chainsOf(coords, types, chainIds, only) {
        var by = new Map();
        for (var i = 0; i < coords.length; i++) {
            if (only && !only.has(i)) continue;
            if (types && types[i] !== 'P') continue;
            if (!coords[i]) continue;
            var id = (chainIds && chainIds[i] !== undefined) ? chainIds[i] : 'A';
            var c = by.get(id);
            if (!c) { c = []; by.set(id, c); }
            c.push(i);
        }
        var out = [];
        by.forEach(function (idx, id) {
            if (idx.length < MIN_CHAIN) return;
            var flat = new Float64Array(idx.length * 3);
            for (var k = 0; k < idx.length; k++) {
                var p = xyz(coords[idx[k]]);
                flat[k * 3] = p[0]; flat[k * 3 + 1] = p[1]; flat[k * 3 + 2] = p[2];
            }
            out.push({ id: id, len: idx.length, flat: flat, index: Int32Array.from(idx) });
        });
        return out;
    }

    /**
     * ONE OBJECT AGAINST THE REFERENCE: every chain screened, the best re-run.
     *
     * Runs wherever TMalign is in scope - the worker and the main thread call
     * this same function, so there is one statement of the two-pass search
     * rather than one per host. Returns null when the object has no protein
     * chain long enough to align.
     */
    function alignOne(ref, target, full) {
        var chains = target.chains || [];
        if (!chains.length) return null;
        var best = null;
        if (chains.length === 1) {
            best = { chain: chains[0], screen: null };
        } else {
            for (var i = 0; i < chains.length; i++) {
                var c = chains[i];
                var s = tmAlign(c.flat.slice(), ref.flat.slice(), c.len, ref.len,
                    { fast: true });
                if (!best || s.TM1 > best.screen.TM1) best = { chain: c, screen: s };
            }
        }
        var c2 = best.chain;
        // THE RANKING PASS IS THE ANSWER when it ran at the settings being
        // reported - which is the normal case now. Re-running it would return
        // the same numbers for the same money.
        var r = (!full && best.screen)
            ? best.screen
            : tmAlign(c2.flat.slice(), ref.flat.slice(), c2.len, ref.len,
                { fast: !full });
        return {
            name: target.name,
            chain: c2.id,
            chainLen: c2.len,
            tm: r.TM1,
            tmOwn: r.TM2,
            rmsd: r.rmsd0,
            aligned: r.n_ali8,
            t: Array.prototype.slice.call(r.t0),
            u: Array.prototype.slice.call(r.u0)
        };
    }

    /** Every target, in order. `onOne` is called as each finishes. */
    function runJob(job, onOne) {
        var out = [];
        for (var i = 0; i < job.targets.length; i++) {
            var r = alignOne(job.ref, job.targets[i], job.full);
            if (r) out.push(r);
            if (onOne) onOne(r, i, job.targets.length);
        }
        return out;
    }

    // ---- the worker side --------------------------------------------------
    if (IN_WORKER) {
        global.onmessage = function (e) {
            var job = e.data;
            try {
                var res = runJob(job, function (r, i, n) {
                    global.postMessage({ progress: { done: i + 1, total: n, last: r } });
                });
                global.postMessage({ results: res });
            } catch (err) {
                global.postMessage({ error: String((err && err.stack) || err) });
            }
        };
        return;
    }

    // ---- the page side ----------------------------------------------------

    /**
     * Run a job, in a worker where one can be had.
     *
     * The worker is built from a Blob rather than pointed at a file of its own,
     * so the only thing it needs to know is where THIS file came from - which
     * this file is the one place that knows. A worker file would be a second
     * copy of that path, and a second thing to keep in step.
     */
    function superpose(job, onProgress) {
        var canWork = !!(SELF_URL && typeof Worker !== 'undefined' && typeof Blob !== 'undefined');
        if (!canWork) {
            // Main thread, fast settings, and the caller is told which it got.
            var res = runJob({ ref: job.ref, targets: job.targets, full: FULL_SEARCH },
                onProgress ? function (r, i, n) { onProgress(i + 1, n); } : null);
            return Promise.resolve({ results: res, inWorker: false });
        }
        // ITS OWN URL, not a name spelled out again. This used to rebuild the
        // path as base + 'align/align.js', which is this file's name written
        // twice - and when the file was renamed the worker asked for one that
        // no longer existed, failed to start, and every alignment fell back to
        // the main thread. SELF_URL is already exactly this script.
        var boot = 'importScripts(' + JSON.stringify(SELF_URL) + ');';
        var url = URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
        return new Promise(function (resolve, reject) {
            var w;
            try { w = new Worker(url); } catch (e) { URL.revokeObjectURL(url); reject(e); return; }
            var done = function (fn, arg) {
                w.terminate(); URL.revokeObjectURL(url); fn(arg);
            };
            w.onmessage = function (e) {
                if (e.data.progress) {
                    if (onProgress) onProgress(e.data.progress.done, e.data.progress.total);
                    return;
                }
                if (e.data.error) done(reject, new Error(e.data.error));
                else done(resolve, { results: e.data.results, inWorker: true });
            };
            w.onerror = function (e) { done(reject, new Error(e.message || 'align worker failed')); };
            w.postMessage({ ref: job.ref, targets: job.targets, full: FULL_SEARCH });
        });
    }

    global.Align = {
        MIN_CHAIN: MIN_CHAIN,
        FULL_SEARCH: FULL_SEARCH,
        chainsOf: chainsOf,
        alignOne: alignOne,
        runJob: runJob,
        superpose: superpose,
        // ...and the algorithm itself, which is otherwise sealed inside this
        // closure. Nothing in the app calls these - alignOne is the entry
        // point - but a test that could not read a raw score could not check
        // that the RIGHT one is being ranked by, and one that could not call
        // makeSec could not tell this file apart from a stub.
        tmAlign: tmAlign,
        cpAlign: cpAlign,
        makeSec: makeSec,
        applyTransform: applyTransform
    };
}(typeof self !== 'undefined' ? self : this));
