// ============================================================================
// src/io/math.js
// -----------
// AI Context: SUPERPOSITION AND BEST VIEW
// - Kabsch alignment (align_a_to_b) and the best-view rotation solver, plus the
//   small matrix helpers they need. No DOM, no parsing, no viewer.
// - NO DEPENDENCIES. It used to need numeric.js, a CDN script pulled into every
//   page, for one thing: the SVD of a 3x3. That is sixty lines of Jacobi, and
//   it is below.
// - Nothing in src/io/parse.js calls anything here, which is what lets a
//   parse-only build drop this file.
// ============================================================================
// ============================================================================
// ALIGNMENT UTILITIES
// ============================================================================

/**
 * Calculate the mean (centroid) of a set of 3D coordinates
 * @param {Array<Array<number>>} coords - Array of [x, y, z] coordinates
 * @returns {Array<number>} - Mean [x, y, z]
 */
function calculateMean(coords) {
    let sum = [0, 0, 0];
    for (const c of coords) {
        sum[0] += c[0];
        sum[1] += c[1];
        sum[2] += c[2];
    }
    return [
        sum[0] / coords.length,
        sum[1] / coords.length,
        sum[2] / coords.length
    ];
}

// ============================================================================
// 3x3 LINEAR ALGEBRA, so this file needs no library
// ============================================================================
// These five replaced numeric.js, a CDN script loaded on every page for one
// routine: the SVD of a 3x3. Everything else it was used for here - a
// transpose, two matrix products, a determinant - is four lines each.
//
// svd3 is the only one with any depth. It eigendecomposes the symmetric matrix
// H^T H by cyclic Jacobi rotations, which is exact for 3x3 in a handful of
// sweeps, and recovers U from H V S^-1. It returns {U, S, V} with H = U S V^T
// and S descending, which is the shape numeric.svd returned, so the two call
// sites did not have to change.
//
// A degenerate singular value (a flat or linear point cloud, which a structure
// viewer meets constantly) leaves the corresponding column of U undetermined by
// that formula; it is filled by completing the orthonormal basis instead.

/** Transpose of a 3x3. */
function mat3T(m) {
    return [[m[0][0], m[1][0], m[2][0]],
        [m[0][1], m[1][1], m[2][1]],
        [m[0][2], m[1][2], m[2][2]]];
}

/** Product of two 3x3 matrices. */
function mat3Mul(a, b) {
    const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    return r;
}

/** Determinant of a 3x3. */
function mat3Det(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/** An N-by-3 array of points times a 3x3 matrix. */
function matNx3Mul3(pts, m) {
    return pts.map((p) => [
        p[0] * m[0][0] + p[1] * m[1][0] + p[2] * m[2][0],
        p[0] * m[0][1] + p[1] * m[1][1] + p[2] * m[2][1],
        p[0] * m[0][2] + p[1] * m[1][2] + p[2] * m[2][2]]);
}

/** Eigen-decomposition of a SYMMETRIC 3x3, by cyclic Jacobi. */
function sym3Eigen(a) {
    const m = [a[0].slice(), a[1].slice(), a[2].slice()];
    let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 24; sweep++) {
        const off = Math.abs(m[0][1]) + Math.abs(m[0][2]) + Math.abs(m[1][2]);
        if (off < 1e-14) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(m[p][q]) < 1e-18) continue;
            const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < 3; k++) {
                const mkp = m[k][p]; const mkq = m[k][q];
                m[k][p] = c * mkp - s * mkq;
                m[k][q] = s * mkp + c * mkq;
            }
            for (let k = 0; k < 3; k++) {
                const mpk = m[p][k]; const mqk = m[q][k];
                m[p][k] = c * mpk - s * mqk;
                m[q][k] = s * mpk + c * mqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[k][p]; const vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    // ...sorted descending, eigenvectors carried with their values
    const order = [0, 1, 2].sort((i, j) => m[j][j] - m[i][i]);
    return {
        values: order.map((i) => m[i][i]),
        vectors: [0, 1, 2].map((r) => order.map((i) => v[r][i])),
    };
}

/** SVD of a 3x3: {U, S, V} with m = U diag(S) V^T and S descending. */
function svd3(m) {
    const { values, vectors: V } = sym3Eigen(mat3Mul(mat3T(m), m));
    const S = values.map((x) => Math.sqrt(Math.max(0, x)));
    const col = (M, j) => [M[0][j], M[1][j], M[2][j]];
    const U = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const good = [];
    // WHICH SINGULAR VALUES ARE REAL, DECIDED BEFORE THE SQUARE ROOT.
    //
    // The eigenvalues are what Jacobi computed, and its noise floor there is
    // eps-relative. Taking the root halves the exponent, so an eigenvalue of
    // 8e-15 against 196 - numerical zero - comes out as a singular value of
    // 9e-8, which walked straight through a 1e-9 relative test. It was then
    // divided by: m times the null direction is exactly zero, so the column of
    // U came out all zeros and U was not orthonormal. Testing the eigenvalue
    // keeps the threshold in the space where the noise actually lives.
    const eigFloor = 1e-12 * Math.abs(values[0] || 1);
    for (let j = 0; j < 3; j++) {
        // ...and a value below the floor IS zero, not 9e-8. Leaving the noise in
        // S while filling its column of U with an arbitrary orthonormal
        // direction puts that much error into U S V^T, in a direction the input
        // never had.
        if (values[j] <= eigFloor) S[j] = 0;
        if (values[j] > eigFloor) {
            const vj = col(V, j);
            for (let i = 0; i < 3; i++) {
                U[i][j] = (m[i][0] * vj[0] + m[i][1] * vj[1] + m[i][2] * vj[2]) / S[j];
            }
            // ...and if the division did not give a unit vector, it was not a
            // real direction after all. Cheap, and it does not trust the floor.
            const uj = col(U, j);
            if (Math.abs(Math.hypot(uj[0], uj[1], uj[2]) - 1) > 1e-6) {
                U[0][j] = U[1][j] = U[2][j] = 0;
                S[j] = 0;
            } else {
                good.push(j);
            }
        }
    }
    // ...and any column the division could not give, completed orthonormally
    for (let j = 0; j < 3; j++) {
        if (good.includes(j)) continue;
        let best = null; let bestLen = -1;
        for (const seed of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
            const w = seed.slice();
            for (const k of good) {
                const uk = col(U, k);
                const d = w[0] * uk[0] + w[1] * uk[1] + w[2] * uk[2];
                for (let i = 0; i < 3; i++) w[i] -= d * uk[i];
            }
            const len = Math.hypot(w[0], w[1], w[2]);
            if (len > bestLen) { bestLen = len; best = w; }
        }
        for (let i = 0; i < 3; i++) U[i][j] = bestLen > 1e-12 ? best[i] / bestLen : (i === j ? 1 : 0);
        good.push(j);
    }
    return { U, S, V };
}

/**
 * Perform Kabsch algorithm to find optimal rotation matrix
 * @param {Array<Array<number>>} A - Source coordinates (centered)
 * @param {Array<Array<number>>} B - Target coordinates (centered)
 * @returns {Array<Array<number>>} - 3x3 rotation matrix
 */
function kabsch(A, B, allowReflection = false) {
    // H = A^T B, over N points: the 3x3 cross-covariance
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < A.length; k++) {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) H[i][j] += A[k][i] * B[k][j];
        }
    }
    const { U, V } = svd3(H);
    const Vt = mat3T(V);
    // REFLECTION IS THE BETTER FIT SURPRISINGLY OFTEN, AND ALMOST NEVER WANTED.
    //
    // The least-squares answer is U V^T, which may have determinant -1: a
    // mirror. It fits, and it is wrong - a mirrored protein is the other
    // enantiomer, so the structure would be superposed onto something that
    // cannot exist. Flipping the sign of the last singular direction gives the
    // best PROPER rotation instead, and that is the default.
    //
    // allowReflection keeps the mirror, which viewer.py has always offered on
    // add() for the cases where the chirality is not the point. Same flag, same
    // default, same meaning as the numpy version this is replacing.
    const D = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    if (!allowReflection && mat3Det(mat3Mul(U, Vt)) < 0) D[2][2] = -1;
    return mat3Mul(U, mat3Mul(D, Vt));
}

/**
 * Align structure A to structure B using Kabsch algorithm
 * @param {Array<Array<number>>} fullCoordsA - All coordinates of structure A
 * @param {Array<Array<number>>} alignCoordsA - Alignment subset of A
 * @param {Array<Array<number>>} alignCoordsB - Alignment subset of B
 * @param {boolean} [allowReflection] - keep a mirrored fit; see kabsch
 * @returns {Array<Array<number>>} - Aligned coordinates of fullCoordsA
 */
function align_a_to_b(fullCoordsA, alignCoordsA, alignCoordsB,
                      allowReflection = false) {
    const meanAlignA = calculateMean(alignCoordsA);
    const meanAlignB = calculateMean(alignCoordsB);

    const centAlignA = alignCoordsA.map(c => [
        c[0] - meanAlignA[0],
        c[1] - meanAlignA[1],
        c[2] - meanAlignA[2]
    ]);

    const centAlignB = alignCoordsB.map(c => [
        c[0] - meanAlignB[0],
        c[1] - meanAlignB[1],
        c[2] - meanAlignB[2]
    ]);

    const R = kabsch(centAlignA, centAlignB, allowReflection);

    const centFullA = fullCoordsA.map(c => [
        c[0] - meanAlignA[0],
        c[1] - meanAlignA[1],
        c[2] - meanAlignA[2]
    ]);

    const rotatedFullA = matNx3Mul3(centFullA, R);

    return rotatedFullA.map(c => [
        c[0] + meanAlignB[0],
        c[1] + meanAlignB[1],
        c[2] + meanAlignB[2]
    ]);
}

// ============================================================================
// BEST VIEW ROTATION UTILITIES
// ============================================================================

function mean3(coords) {
    const m = [0, 0, 0];
    for (const c of coords) {
        m[0] += c[0];
        m[1] += c[1];
        m[2] += c[2];
    }
    m[0] /= coords.length;
    m[1] /= coords.length;
    m[2] /= coords.length;
    return m;
}

function trace(M) {
    return M[0][0] + M[1][1] + M[2][2];
}

/**
 * Calculate best view rotation matrix (matches Python best_view)
 * Uses Kabsch algorithm with same coordinates for both inputs to get principal axes
 * Then maps largest variance to longest screen axis
 * @param {Array<Array<number>>} coords - Structure coordinates
 * @param {Array<Array<number>>} currentRotation - Current rotation matrix
 * @param {number} canvasWidth - Canvas width (optional, for axis selection)
 * @param {number} canvasHeight - Canvas height (optional, for axis selection)
 * @returns {Array<Array<number>>} - Target rotation matrix
 */
function bestViewTargetRotation_relaxed_AUTO(coords, currentRotation, canvasWidth = null, canvasHeight = null) {

    // Edge case: not enough coordinates
    if (!coords || coords.length < 2) {
        return currentRotation || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    }

    // Edge case: all coordinates are the same (degenerate case)
    // Optimize: For large structures, sample coordinates from different parts
    const firstCoord = coords[0];
    let allSame = false;
    if (coords.length < 1000) {
        // For small structures, check all
        allSame = coords.every(c =>
            Math.abs(c[0] - firstCoord[0]) < 1e-10 &&
            Math.abs(c[1] - firstCoord[1]) < 1e-10 &&
            Math.abs(c[2] - firstCoord[2]) < 1e-10
        );
    } else {
        // For large structures, sample from beginning, middle, and end
        // This is more robust than just checking the first 10
        allSame = true;
        const n = coords.length;
        const sampleSize = Math.min(100, Math.floor(n / 10)); // Sample up to 100, or 10% of coords
        const step = Math.max(1, Math.floor(n / sampleSize));

        // Check first, middle, and last portions
        for (let i = 0; i < n; i += step) {
            const c = coords[i];
            if (Math.abs(c[0] - firstCoord[0]) > 1e-10 ||
                Math.abs(c[1] - firstCoord[1]) > 1e-10 ||
                Math.abs(c[2] - firstCoord[2]) > 1e-10) {
                allSame = false;
                break;
            }
        }
        // Also check the last coordinate explicitly
        if (allSame && n > 1) {
            const lastCoord = coords[n - 1];
            if (Math.abs(lastCoord[0] - firstCoord[0]) > 1e-10 ||
                Math.abs(lastCoord[1] - firstCoord[1]) > 1e-10 ||
                Math.abs(lastCoord[2] - firstCoord[2]) > 1e-10) {
                allSame = false;
            }
        }
    }

    if (allSame) {
        return currentRotation || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    }

    // Use Kabsch algorithm like Python best_view: kabsch(a_cent, a_cent, return_v=True)
    // This computes the eigenvectors of the covariance matrix
    const mu = mean3(coords);

    // Optimize: Compute covariance directly without creating centeredCoords array
    // H[i][j] = sum_k (coords[k][i] - mu[i]) * (coords[k][j] - mu[j])
    // This avoids creating a large intermediate array
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const n = coords.length;
    for (let k = 0; k < n; k++) {
        const c = coords[k];
        const dx = c[0] - mu[0];
        const dy = c[1] - mu[1];
        const dz = c[2] - mu[2];
        // H is symmetric, so we only need to compute upper triangle
        H[0][0] += dx * dx;
        H[0][1] += dx * dy;
        H[0][2] += dx * dz;
        H[1][1] += dy * dy;
        H[1][2] += dy * dz;
        H[2][2] += dz * dz;
    }
    // Fill in lower triangle (symmetric)
    H[1][0] = H[0][1];
    H[2][0] = H[0][2];
    H[2][1] = H[1][2];

    // We still need centeredCoords for the candidate evaluation loop
    // For large structures, we can sample coordinates to speed up variance calculation
    let centeredCoords;
    let useSampling = n > 5000; // Sample for structures with >5000 atoms
    if (useSampling) {
        // Sample every Nth coordinate to speed up variance calculation
        const sampleStep = Math.ceil(n / 2000); // Sample ~2000 coordinates max
        centeredCoords = [];
        for (let i = 0; i < n; i += sampleStep) {
            const c = coords[i];
            centeredCoords.push([c[0] - mu[0], c[1] - mu[1], c[2] - mu[2]]);
        }
    } else {
        // For smaller structures, use all coordinates
        centeredCoords = coords.map(c => [c[0] - mu[0], c[1] - mu[1], c[2] - mu[2]]);
    }

    // Edge case: covariance matrix is all zeros
    const traceH = H[0][0] + H[1][1] + H[2][2];
    if (Math.abs(traceH) < 1e-10) {
        return currentRotation || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    }

    // Perform SVD: H = U @ S @ V^T
    // For symmetric H, U and V are the same (eigenvectors)
    // Python best_view uses U (left singular vectors) when return_v=True
    let svd;
    try {
        svd = svd3(H);
    } catch (e) {
        return currentRotation || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    }

    // Check if SVD returned valid structure
    if (!svd || !svd.U || !Array.isArray(svd.U) || svd.U.length < 3) {
        return currentRotation || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    }

    // Extract singular values to verify order
    let S = svd.S;
    if (!Array.isArray(S)) {
        S = [S, S, S];
    }

    // Extract eigenvectors from U (left singular vectors) - matches Python best_view
    // U columns are eigenvectors, ordered by singular values (descending)
    // U[:,0] = largest variance direction, U[:,1] = second, U[:,2] = smallest
    let U;
    if (Array.isArray(svd.U[0]) && Array.isArray(svd.U[0][0])) {
        // Nested array format
        U = [
            [svd.U[0][0][0] || svd.U[0][0], svd.U[0][1][0] || svd.U[0][1], svd.U[0][2][0] || svd.U[0][2]],
            [svd.U[1][0][0] || svd.U[1][0], svd.U[1][1][0] || svd.U[1][1], svd.U[1][2][0] || svd.U[1][2]],
            [svd.U[2][0][0] || svd.U[2][0], svd.U[2][1][0] || svd.U[2][1], svd.U[2][2][0] || svd.U[2][2]]
        ];
    } else {
        // Standard format: U is array of rows
        U = [
            [svd.U[0][0], svd.U[0][1], svd.U[0][2]],
            [svd.U[1][0], svd.U[1][1], svd.U[1][2]],
            [svd.U[2][0], svd.U[2][1], svd.U[2][2]]
        ];
    }

    // Extract eigenvectors (columns of U)
    // U[i][j] means row i, column j
    // Column indices correspond to singular value order (descending)
    const v1 = [U[0][0], U[1][0], U[2][0]];  // Column 0 - largest variance
    const v2 = [U[0][1], U[1][1], U[2][1]];  // Column 1 - second largest
    const v3 = [U[0][2], U[1][2], U[2][2]];  // Column 2 - smallest

    // Determine which screen axis is longer
    // Use a tolerance for "square" check to account for rounding/pixel differences
    const tolerance = 2; // Consider square if dimensions differ by 2 pixels or less
    const isXLonger = (canvasWidth && canvasHeight) ? canvasWidth > canvasHeight + tolerance : false;
    const isSquare = (canvasWidth && canvasHeight) ? Math.abs(canvasWidth - canvasHeight) <= tolerance : false;

    const Rcur = currentRotation || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const candidates = [];


    // Try all sign combinations for eigenvectors (flipping doesn't change variance)
    // We need to try different signs because eigenvectors can point in either direction
    const signs = [
        [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
        [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]
    ];

    // Try both mappings: e1->x/e2->y AND e1->y/e2->x
    // This ensures we explore all possible orientations
    // When square, we try both mappings and let rotation angle decide
    const mappings = isSquare
        ? [
            // For square, try both mappings equally
            { r0: 'e1', r1: 'e2', desc: 'e1->x, e2->y' },  // Largest on x, second on y
            { r0: 'e2', r1: 'e1', desc: 'e2->x, e1->y' }   // Second on x, largest on y
        ]
        : isXLonger
            ? [
                { r0: 'e1', r1: 'e2', desc: 'e1->x, e2->y' },  // Largest on x, second on y
                { r0: 'e2', r1: 'e1', desc: 'e2->x, e1->y' }   // Second on x, largest on y (try this too!)
            ]
            : [
                { r0: 'e2', r1: 'e1', desc: 'e2->x, e1->y' },  // Second on x, largest on y
                { r0: 'e1', r1: 'e2', desc: 'e1->x, e2->y' }   // Largest on x, second on y (try this too!)
            ];

    for (const mapping of mappings) {
        for (const [s1, s2, s3] of signs) {
            // Apply signs to eigenvectors
            const e1 = [v1[0] * s1, v1[1] * s1, v1[2] * s1];
            const e2 = [v2[0] * s2, v2[1] * s2, v2[2] * s2];
            const e3 = [v3[0] * s3, v3[1] * s3, v3[2] * s3];

            // Construct rotation matrix based on mapping
            let r0, r1;
            if (mapping.r0 === 'e1') {
                r0 = e1;
                r1 = e2;
            } else {
                r0 = e2;
                r1 = e1;
            }

            // Normalize (eigenvectors should already be normalized, but ensure it)
            let n0 = Math.sqrt(r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2]);
            if (n0 < 1e-10) continue;
            r0 = [r0[0] / n0, r0[1] / n0, r0[2] / n0];

            let n1 = Math.sqrt(r1[0] * r1[0] + r1[1] * r1[1] + r1[2] * r1[2]);
            if (n1 < 1e-10) continue;
            r1 = [r1[0] / n1, r1[1] / n1, r1[2] / n1];

            // Ensure r0 and r1 are orthogonal (they should be from SVD, but verify)
            // If not perfectly orthogonal, orthogonalize r1 with respect to r0
            let dot01 = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2];
            if (Math.abs(dot01) > 1e-6) {
                // Not orthogonal - orthogonalize r1
                r1 = [r1[0] - dot01 * r0[0], r1[1] - dot01 * r0[1], r1[2] - dot01 * r0[2]];
                n1 = Math.sqrt(r1[0] * r1[0] + r1[1] * r1[1] + r1[2] * r1[2]);
                if (n1 < 1e-10) continue;
                r1 = [r1[0] / n1, r1[1] / n1, r1[2] / n1];
            }

            // Third row is cross product to ensure right-handed coordinate system
            // This preserves the mapping: r0 and r1 stay exactly aligned with their eigenvectors
            let r2 = [
                r0[1] * r1[2] - r0[2] * r1[1],
                r0[2] * r1[0] - r0[0] * r1[2],
                r0[0] * r1[1] - r0[1] * r1[0]
            ];

            // Construct rotation matrix
            // Python: a_aligned = a_cent @ v, where v has eigenvectors as COLUMNS
            //        v[:,0] = largest variance, v[:,1] = second, v[:,2] = smallest
            //        result[i][j] = sum(a_cent[i][k] * v[k][j])
            //
            // Our renderer: screen_x = R[0][0]*x + R[0][1]*y + R[0][2]*z
            //               screen_y = R[1][0]*x + R[1][1]*y + R[1][2]*z
            //               So R[0] is x-axis direction, R[1] is y-axis direction
            //
            // To match Python's rotation, we need R = v^T (transpose)
            // So if v has eigenvectors as columns, R should have them as rows
            // R[0] = first row = first column of v = first eigenvector
            // R[1] = second row = second column of v = second eigenvector
            //
            // But wait - we want to map largest variance to longest screen axis
            // If isXLonger: R[0] should be largest variance eigenvector
            // If !isXLonger: R[1] should be largest variance eigenvector
            //
            // Currently we're setting:
            //   if isXLonger: r0 = e1 (largest), r1 = e2 (second)
            //   if !isXLonger: r0 = e2 (second), r1 = e1 (largest)
            //
            // Then R = [[r0[0], r1[0], r2[0]], [r0[1], r1[1], r2[1]], [r0[2], r1[2], r2[2]]]
            // So R[0] = r0, R[1] = r1
            //
            // This should be correct! But all candidates show VarX > VarY...
            // Maybe the issue is that we're not actually using the right eigenvectors?
            // Or maybe the variance calculation is wrong?

            // Construct rotation matrix
            // The renderer applies rotation as:
            //   out.x = m[0][0]*subX + m[0][1]*subY + m[0][2]*subZ
            //   out.y = m[1][0]*subX + m[1][1]*subY + m[1][2]*subZ
            // So m[0] is the x-axis direction, m[1] is the y-axis direction
            // 
            // We want:
            //   R[0] = x-axis direction = eigenvector we want on x-axis
            //   R[1] = y-axis direction = eigenvector we want on y-axis
            //   R[2] = z-axis direction = cross product
            //
            // So R should be:
            //   R = [[r0[0], r0[1], r0[2]],    // Row 0 = x-axis
            //        [r1[0], r1[1], r1[2]],    // Row 1 = y-axis
            //        [r2[0], r2[1], r2[2]]]    // Row 2 = z-axis

            const R = [
                [r0[0], r0[1], r0[2]],
                [r1[0], r1[1], r1[2]],
                [r2[0], r2[1], r2[2]]
            ];

            // Verify the mapping by calculating projected variance
            // Project coordinates to screen space using this rotation
            // This matches how the renderer applies rotation: screen = R @ coords
            // Optimize: Pre-compute R matrix row dot products
            const R00 = R[0][0], R01 = R[0][1], R02 = R[0][2];
            const R10 = R[1][0], R11 = R[1][1], R12 = R[1][2];

            let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0;
            const nCentered = centeredCoords.length;
            for (let i = 0; i < nCentered; i++) {
                const c = centeredCoords[i];
                const projX = R00 * c[0] + R01 * c[1] + R02 * c[2];
                const projY = R10 * c[0] + R11 * c[1] + R12 * c[2];
                sumX += projX;
                sumY += projY;
                sumX2 += projX * projX;
                sumY2 += projY * projY;
            }
            const meanX = sumX / nCentered;
            const meanY = sumY / nCentered;
            const varX = (sumX2 / nCentered) - (meanX * meanX);
            const varY = (sumY2 / nCentered) - (meanY * meanY);

            // Calculate rotation angle from current to target
            const angle = rotationAngleBetweenMatrices(Rcur, R);

            // Score based on:
            // 1. Correct variance mapping (largest variance on longest axis)
            // 2. Small rotation angle (prevent flips)
            // When square, prioritize rotation angle over variance mapping
            let varianceScore = 0;
            if (isXLonger) {
                // x should have larger variance than y
                varianceScore = varX - varY;
            } else {
                // y should have larger variance than x
                varianceScore = varY - varX;
            }

            // Combine variance score with rotation angle penalty
            if (isSquare) {
                // For square canvas, prioritize minimizing rotation angle
                // Both mappings are equally valid, so choose the one with smaller rotation
                // Use angle as primary factor (multiply by large negative to make smaller angles score higher)
                let score = -angle * 1000; // Smaller angle is better (multiply by 1000 to dominate)
                // Add a very small bonus for variance mapping as a tie-breaker (only if angles are very close)
                score += varianceScore * 0.1; // Very small weight for variance as tie-breaker
                if (angle > Math.PI / 2) {
                    score -= (angle - Math.PI / 2) * 10000; // Heavy penalty for large rotations
                }
                candidates.push({
                    R,
                    angle,
                    score,
                    varX,
                    varY,
                    varianceScore,
                    signs: [s1, s2, s3],
                    mapping: mapping.desc
                });
            } else {
                // For non-square canvas, prioritize correct variance mapping
                let score = varianceScore * 1000; // Weight variance heavily
                score -= angle; // Smaller angle is better
                if (angle > Math.PI / 2) {
                    score -= (angle - Math.PI / 2) * 10; // Heavy penalty for large rotations
                }
                candidates.push({
                    R,
                    angle,
                    score,
                    varX,
                    varY,
                    varianceScore,
                    signs: [s1, s2, s3],
                    mapping: mapping.desc
                });
            }
        }
    }

    // If no valid candidates, return current rotation

    if (candidates.length === 0) {
        return Rcur;
    }

    // Sort by score (higher is better - smaller angle, no flips)
    candidates.sort((a, b) => b.score - a.score);


    // Return the best candidate
    return candidates[0].R;
}

/**
 * Calculate angle between two rotation matrices
 * @param {Array<Array<number>>} M1 - First rotation matrix
 * @param {Array<Array<number>>} M2 - Second rotation matrix
 * @returns {number} - Angle in radians
 */
function rotationAngleBetweenMatrices(M1, M2) {
    const R = mat3Mul(mat3T(M1), M2);
    const tr = R[0][0] + R[1][1] + R[2][2];
    const cosTheta = (tr - 1) / 2;
    const clamped = Math.max(-1, Math.min(1, cosTheta));
    return Math.acos(clamped);
}

/**
 * Linearly interpolate between two rotation matrices with orthonormalization
 * @param {Array<Array<number>>} M1 - Start rotation matrix
 * @param {Array<Array<number>>} M2 - End rotation matrix
 * @param {number} t - Interpolation parameter (0 to 1)
 * @returns {Array<Array<number>>} - Interpolated rotation matrix
 */
function lerpRotationMatrix(M1, M2, t) {
    const result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            result[i][j] = M1[i][j] * (1 - t) + M2[i][j] * t;
        }
    }

    // Gram-Schmidt orthonormalization
    let c0 = [result[0][0], result[1][0], result[2][0]];
    let n0 = Math.hypot(c0[0], c0[1], c0[2]);
    c0 = [c0[0] / n0, c0[1] / n0, c0[2] / n0];

    let c1 = [result[0][1], result[1][1], result[2][1]];
    let dot01 = c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2];
    c1 = [c1[0] - dot01 * c0[0], c1[1] - dot01 * c0[1], c1[2] - dot01 * c0[2]];
    let n1 = Math.hypot(c1[0], c1[1], c1[2]);
    c1 = [c1[0] / n1, c1[1] / n1, c1[2] / n1];

    let c2 = [
        c0[1] * c1[2] - c0[2] * c1[1],
        c0[2] * c1[0] - c0[0] * c1[2],
        c0[0] * c1[1] - c0[1] * c1[0]
    ];

    return [
        [c0[0], c1[0], c2[0]],
        [c0[1], c1[1], c2[1]],
        [c0[2], c1[2], c2[2]]
    ];
}
