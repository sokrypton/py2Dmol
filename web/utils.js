// ============================================================================
// web/utils.js
// ------------
// AI Context: UTILITY FUNCTIONS
// - Contains pure utility functions for geometry and parsing.
// - Key features: Kabsch alignment, Best View rotation logic, PDB/CIF parsing.
// - Shared logic that doesn't depend on DOM or global state.
// ============================================================================
// UTILS.JS - Pure utility functions (parsing, alignment, best-view)
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

/**
 * Perform Kabsch algorithm to find optimal rotation matrix
 * @param {Array<Array<number>>} A - Source coordinates (centered)
 * @param {Array<Array<number>>} B - Target coordinates (centered)
 * @returns {Array<Array<number>>} - 3x3 rotation matrix
 */
function kabsch(A, B) {
    const H = numeric.dot(numeric.transpose(A), B);
    const svd = numeric.svd(H);
    const U = svd.U;
    const V = svd.V;
    const Vt = numeric.transpose(V);
    let D = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const det = numeric.det(numeric.dot(U, Vt));
    if (det < 0) D[2][2] = -1;
    return numeric.dot(U, numeric.dot(D, Vt));
}

/**
 * Align structure A to structure B using Kabsch algorithm
 * @param {Array<Array<number>>} fullCoordsA - All coordinates of structure A
 * @param {Array<Array<number>>} alignCoordsA - Alignment subset of A
 * @param {Array<Array<number>>} alignCoordsB - Alignment subset of B
 * @returns {Array<Array<number>>} - Aligned coordinates of fullCoordsA
 */
function align_a_to_b(fullCoordsA, alignCoordsA, alignCoordsB) {
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

    const R = kabsch(centAlignA, centAlignB);

    const centFullA = fullCoordsA.map(c => [
        c[0] - meanAlignA[0],
        c[1] - meanAlignA[1],
        c[2] - meanAlignA[2]
    ]);

    const rotatedFullA = numeric.dot(centFullA, R);

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

function covarianceXXT(coords) {
    const mu = mean3(coords);
    const X = coords.map(c => [
        c[0] - mu[0],
        c[1] - mu[1],
        c[2] - mu[2]
    ]);
    return numeric.dot(numeric.transpose(X), X);
}

function ensureRightHand(V) {
    const det = numeric.det(V);
    if (det < 0) {
        V = V.map(r => [r[0], r[1], -r[2]]);
    }
    return V;
}

function multCols(V, s) {
    return [
        [V[0][0] * s[0], V[0][1] * s[1], V[0][2] * s[2]],
        [V[1][0] * s[0], V[1][1] * s[1], V[1][2] * s[2]],
        [V[2][0] * s[0], V[2][1] * s[1], V[2][2] * s[2]]
    ];
}

function trace(M) {
    return M[0][0] + M[1][1] + M[2][2];
}

function polar2x2_withScore(A) {
    const svd = numeric.svd(A);
    const U = [[svd.U[0][0], svd.U[0][1]], [svd.U[1][0], svd.U[1][1]]];
    const V = [[svd.V[0][0], svd.V[0][1]], [svd.V[1][0], svd.V[1][1]]];
    let R2 = numeric.dot(V, numeric.transpose(U));
    const det = R2[0][0] * R2[1][1] - R2[0][1] * R2[1][0];
    if (det < 0) {
        V[0][1] *= -1;
        V[1][1] *= -1;
        R2 = numeric.dot(V, numeric.transpose(U));
    }
    const nuclear = (svd.S[0] || 0) + (svd.S[1] || 0);
    return { R2, nuclear };
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
        svd = numeric.svd(H);
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
    const M1T = numeric.transpose(M1);
    const R = numeric.dot(M1T, M2);
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

// ============================================================================
// PDB/CIF PARSING UTILITIES
// ============================================================================

/**
 * Parse PDB file into models and MODRES records
 * @param {string} text - PDB file content
 * @returns {object} - {models: Array<Array<object>>, modresMap: Map<string, string>}
 */
function parsePDB(text) {
    const models = [];
    let currentModelAtoms = [];
    const lines = text.split('\n');

    // Parse MODRES records: MODRES resName chainID resSeq stdResName comment
    // Columns: 12-15 (resName), 17 (chainID), 19-22 (resSeq), 25-27 (stdResName)
    const modresMap = new Map(); // resName -> stdResName

    // Parse CONECT records for explicit bonds
    const conectMap = new Map(); // atom serial -> [bonded atom serials]

    let atomCount = 0;
    let modresCount = 0;

    for (const line of lines) {
        if (line.startsWith('MODRES')) {
            // MODRES format: columns 12-15 (resName), 17 (chainID), 19-22 (resSeq), 25-27 (stdResName)
            const resName = line.substring(11, 15).trim();
            const stdResName = line.substring(24, 27).trim();
            if (resName && stdResName) {
                // Store mapping: modified residue name -> standard residue name
                modresMap.set(resName, stdResName);
                modresCount++;
            }
        }

        if (line.startsWith('CONECT')) {
            // CONECT format: serial (columns 6-11), bonded atoms (columns 12-16, 17-21, 22-26, 27-31, etc.)
            const serial = parseInt(line.substring(6, 11).trim());
            const bonded = [];
            for (let i = 0; i < 4; i++) {
                const startCol = 12 + (i * 5);
                const bondedSerial = parseInt(line.substring(startCol, startCol + 5).trim());
                if (!isNaN(bondedSerial)) {
                    bonded.push(bondedSerial);
                }
            }
            if (bonded.length > 0) {
                if (!conectMap.has(serial)) {
                    conectMap.set(serial, []);
                }
                conectMap.get(serial).push(...bonded);
            }
        }

        if (line.startsWith('MODEL')) {
            if (currentModelAtoms.length > 0) {
                models.push(currentModelAtoms);
            }
            currentModelAtoms = [];
        }

        if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
            const serial = parseInt(line.substring(6, 11).trim());
            currentModelAtoms.push({
                record: line.substring(0, 6).trim(),
                serial: serial,
                atomName: line.substring(12, 16).trim(),
                resName: line.substring(17, 20).trim(),
                chain: line.substring(21, 22).trim(),
                resSeq: parseInt(line.substring(22, 26)),
                x: parseFloat(line.substring(30, 38)),
                y: parseFloat(line.substring(38, 46)),
                z: parseFloat(line.substring(46, 54)),
                b: parseFloat(line.substring(60, 66)),
                element: line.substring(76, 78).trim(),
                res_name: line.substring(17, 20).trim(),
                res_seq: parseInt(line.substring(22, 26))
            });
            atomCount++;
        }

        if (line.startsWith('ENDMDL')) {
            if (currentModelAtoms.length > 0) {
                models.push(currentModelAtoms);
                currentModelAtoms = [];
            }
        }
    }

    if (currentModelAtoms.length > 0) {
        models.push(currentModelAtoms);
    }

    if (models.length === 0 && currentModelAtoms.length > 0) {
        models.push(currentModelAtoms);
    }

    return { models, modresMap, conectMap };
}

/**
 * Parse CIF (mmCIF) file into models
 * @param {string} text - CIF file content
 * @returns {Array<Array<object>>} - Array of models, each containing atoms
 */
function parseCIF(text) {

    // Parse chemical component table first (for modified residue detection)
    // Also parse struct_conn for explicit bonds
    const loops = parseMinimalCIF_light(text);

    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));

    // Parse _struct_conn for explicit bonds
    const structConn = [];
    const structConnL = getLoop('_struct_conn.id');
    if (structConnL) {
        const scCols = structConnL[0], scRows = structConnL[1];
        const ccol_ptnr1_label_asym_id = scCols.indexOf('_struct_conn.ptnr1_label_asym_id');
        const ccol_ptnr1_auth_asym_id = scCols.indexOf('_struct_conn.ptnr1_auth_asym_id');
        const ccol_ptnr1_label_seq_id = scCols.indexOf('_struct_conn.ptnr1_label_seq_id');
        const ccol_ptnr1_auth_seq_id = scCols.indexOf('_struct_conn.ptnr1_auth_seq_id');
        const ccol_ptnr1_label_atom_id = scCols.indexOf('_struct_conn.ptnr1_label_atom_id');

        const ccol_ptnr2_label_asym_id = scCols.indexOf('_struct_conn.ptnr2_label_asym_id');
        const ccol_ptnr2_auth_asym_id = scCols.indexOf('_struct_conn.ptnr2_auth_asym_id');
        const ccol_ptnr2_label_seq_id = scCols.indexOf('_struct_conn.ptnr2_label_seq_id');
        const ccol_ptnr2_auth_seq_id = scCols.indexOf('_struct_conn.ptnr2_auth_seq_id');
        const ccol_ptnr2_label_atom_id = scCols.indexOf('_struct_conn.ptnr2_label_atom_id');

        const ccol_conn_type_id = scCols.indexOf('_struct_conn.conn_type_id');

        // Prefer label IDs but fallback to auth IDs
        const getCol = (row, labelIdx, authIdx) => {
            if (labelIdx >= 0 && row[labelIdx] && row[labelIdx] !== '?' && row[labelIdx] !== '.') return row[labelIdx];
            if (authIdx >= 0 && row[authIdx] && row[authIdx] !== '?' && row[authIdx] !== '.') return row[authIdx];
            return null;
        };

        for (const row of scRows) {
            // Only process covalent bonds (covale) or metal coordination (metalc) or disulfide (disulf)
            // Skip hydrogen bonds (hydrog)
            const type = ccol_conn_type_id >= 0 ? row[ccol_conn_type_id] : 'covale';
            if (type && (type === 'covale' || type === 'metalc' || type === 'disulf')) {
                const chain1 = getCol(row, ccol_ptnr1_label_asym_id, ccol_ptnr1_auth_asym_id);
                const seq1 = getCol(row, ccol_ptnr1_label_seq_id, ccol_ptnr1_auth_seq_id);
                const atom1 = row[ccol_ptnr1_label_atom_id];

                const chain2 = getCol(row, ccol_ptnr2_label_asym_id, ccol_ptnr2_auth_asym_id);
                const seq2 = getCol(row, ccol_ptnr2_label_seq_id, ccol_ptnr2_auth_seq_id);
                const atom2 = row[ccol_ptnr2_label_atom_id];

                if (chain1 && atom1 && chain2 && atom2) {
                    structConn.push({
                        chain1, seq1: parseInt(seq1), atom1,
                        chain2, seq2: parseInt(seq2), atom2,
                        type
                    });
                }
            }
        }
    }

    // Parse _chem_comp_bond for component-level explicit bonds
    const chemCompBondMap = new Map(); // compId -> [{atom1, atom2, order}]
    const chemCompBondL = getLoop('_chem_comp_bond.comp_id');
    if (chemCompBondL) {
        const ccbCols = chemCompBondL[0], ccbRows = chemCompBondL[1];
        const ccol_comp_id = ccbCols.indexOf('_chem_comp_bond.comp_id');
        const ccol_atom_id_1 = ccbCols.indexOf('_chem_comp_bond.atom_id_1');
        const ccol_atom_id_2 = ccbCols.indexOf('_chem_comp_bond.atom_id_2');
        const ccol_value_order = ccbCols.indexOf('_chem_comp_bond.value_order');
        const ccol_pdbx_value_order = ccbCols.indexOf('_chem_comp_bond.pdbx_value_order');

        for (const row of ccbRows) {
            const compId = row[ccol_comp_id];
            const atom1 = row[ccol_atom_id_1];
            const atom2 = row[ccol_atom_id_2];

            // Get order, preferring pdbx_value_order if available
            let orderStr = (ccol_pdbx_value_order >= 0 && row[ccol_pdbx_value_order] && row[ccol_pdbx_value_order] !== '?')
                ? row[ccol_pdbx_value_order]
                : (ccol_value_order >= 0 ? row[ccol_value_order] : 'SING');

            if (compId && atom1 && atom2) {
                if (!chemCompBondMap.has(compId)) {
                    chemCompBondMap.set(compId, []);
                }

                // Normalize order string to integer if possible, or keep as string for renderer to handle
                // viewer-mol.js usually expects 1, 2, 3 or 'aromatic'
                let order = 1;
                const orderUpper = String(orderStr).toUpperCase();
                if (orderUpper.includes('DOUB')) order = 2;
                else if (orderUpper.includes('TRIP')) order = 3;
                else if (orderUpper.includes('AROM')) order = 1; // Treat aromatic as single for now, or handle specifically

                chemCompBondMap.get(compId).push({
                    atom1,
                    atom2,
                    order
                });
            }
        }
    }

    const chemCompMap = new Map();
    const chemCompL = getLoop('_chem_comp.id');
    if (chemCompL) {
        const chemCompCols = chemCompL[0], chemCompRows = chemCompL[1];
        const ccol_id = chemCompCols.indexOf('_chem_comp.id');
        const ccol_type = chemCompCols.indexOf('_chem_comp.type');
        const ccol_mon_nstd = chemCompCols.indexOf('_chem_comp.mon_nstd_flag');

        if (ccol_id >= 0 && ccol_type >= 0) {
            for (const row of chemCompRows) {
                const resName = row[ccol_id]?.trim();
                const type = row[ccol_type]?.trim();
                const mon_nstd = ccol_mon_nstd >= 0 ? row[ccol_mon_nstd]?.trim() : null;

                if (resName && type) {
                    // Map residue type: 'RNA linking' -> 'R', 'DNA linking' -> 'D', 'L-peptide linking' -> 'P'
                    let mappedType = null;
                    if (type.includes('RNA linking')) {
                        mappedType = 'R';
                    } else if (type.includes('DNA linking')) {
                        mappedType = 'D';
                    } else if (type.includes('peptide linking') || type.includes('L-peptide linking')) {
                        mappedType = 'P';
                    }

                    const isModified = mon_nstd === 'n' || mon_nstd === 'y' || mon_nstd === 'Y';
                    chemCompMap.set(resName, { type: mappedType, isModified, originalType: type });
                }
            }
        }
    }

    const modelMap = new Map();
    const lines = text.split('\n');

    let atomSiteLoop = false;
    const headers = [];
    const headerMap = {};
    let modelIDKey = null;
    let modelID = 1;
    let atomCount = 0;

    // Find headers
    for (const line of lines) {
        if (line.startsWith('_atom_site.')) {
            const header = line.trim();
            headerMap[header] = headers.length;
            headers.push(header);
            if (header.includes('model_no') || header.includes('pdbx_PDB_model_num')) {
                modelIDKey = header;
            }
        } else if (headers.length > 0 && (line.startsWith('loop_') || line.startsWith('#'))) {
            break;
        }
    }

    // Pre-compute header indices once to avoid repeated map lookups
    // Use label_asym_id consistently (required for biounit operations per mmCIF spec)
    const idxRecord = headerMap['_atom_site.group_PDB'];
    const idxAtomName = headerMap['_atom_site.label_atom_id'];
    const idxResName = headerMap['_atom_site.label_comp_id'];
    const idxChain = headerMap['_atom_site.label_asym_id'] >= 0
        ? headerMap['_atom_site.label_asym_id']
        : headerMap['_atom_site.auth_asym_id']; // Fallback only if label_asym_id not present
    // Prefer label_seq_id (PDB numbering) over auth_seq_id (author numbering) for SIFTS mapping
    const idxResSeq = (headerMap['_atom_site.label_seq_id'] >= 0)
        ? headerMap['_atom_site.label_seq_id']
        : headerMap['_atom_site.auth_seq_id'];
    const idxX = headerMap['_atom_site.Cartn_x'];
    const idxY = headerMap['_atom_site.Cartn_y'];
    const idxZ = headerMap['_atom_site.Cartn_z'];
    const idxB = headerMap['_atom_site.B_iso_or_equiv'];
    const idxElement = headerMap['_atom_site.type_symbol'];
    const idxModelID = modelIDKey ? headerMap[modelIDKey] : -1;

    // Parse data - optimized for performance
    // A row only has to reach the columns we actually read. Requiring the full
    // declared header width dropped every short row, and integrative-model
    // files write ragged ones: 9a9o omits pdbx_PDB_model_num and ihm_model_id
    // on ~2000 of its 16740 atoms, all of them past the last column we need.
    const minReqLen = Math.max(idxX, idxY, idxZ, idxChain, idxResSeq, idxResName, idxAtomName) + 1;
    let currentModelArray = null;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineLen = line.length;

        // Check for atom_site header
        if (line.startsWith('_atom_site.')) {
            atomSiteLoop = true;
            continue;
        }

        if (!atomSiteLoop) continue;

        // Fast check for comment or end marker
        if (lineLen > 0 && line[0] === '#') {
            atomSiteLoop = false;
            continue;
        }

        // Skip semicolon lines
        if (lineLen > 0 && line[0] === ';') continue;

        const values = tokenizeCIFLine_light(line);
        if (!values || values.length < minReqLen) continue;

        // Direct array access - much faster than function calls
        // Update modelID if needed
        if (idxModelID >= 0 && idxModelID < values.length) {
            const newModelID = +values[idxModelID] || modelID; // Unary + is faster than parseInt
            if (newModelID !== modelID) {
                modelID = newModelID;
                currentModelArray = modelMap.get(modelID);
                if (!currentModelArray) {
                    currentModelArray = [];
                    modelMap.set(modelID, currentModelArray);
                }
            }
        }

        // Ensure currentModelArray is initialized (for case when idxModelID < 0 or first atom)
        if (!currentModelArray) {
            currentModelArray = modelMap.get(modelID);
            if (!currentModelArray) {
                currentModelArray = [];
                modelMap.set(modelID, currentModelArray);
            }
        }

        // Create atom object with direct array access and optimized number parsing
        // Use unary + operator for numbers (faster than parseFloat/parseInt)
        const resNameVal = (idxResName >= 0 && idxResName < values.length) ? values[idxResName] : '';
        // Parse residue sequence number, handling missing values ("?") by falling back to auth_seq_id
        // Use label_seq_id (PDB numbering) for SIFTS mapping compatibility
        let resSeqVal = 0;
        if (idxResSeq >= 0 && idxResSeq < values.length) {
            const labelSeqStr = values[idxResSeq];
            // Check if label_seq_id is missing ("?" or empty), fall back to auth_seq_id
            if (labelSeqStr === '?' || labelSeqStr === '' || labelSeqStr === null || labelSeqStr === undefined) {
                const idxAuthSeq = headerMap['_atom_site.auth_seq_id'];
                if (idxAuthSeq >= 0 && idxAuthSeq < values.length) {
                    const authSeqStr = values[idxAuthSeq];
                    resSeqVal = (authSeqStr === '?' || authSeqStr === '' || authSeqStr === null) ? 0 : (+authSeqStr || 0);
                }
            } else {
                // Parse label_seq_id (can be a number string or "?")
                resSeqVal = (+labelSeqStr || 0);
            }
        }

        const atom = {
            record: (idxRecord >= 0 && idxRecord < values.length) ? values[idxRecord] : 'ATOM',
            atomName: (idxAtomName >= 0 && idxAtomName < values.length) ? values[idxAtomName] : '',
            resName: resNameVal,
            chain: (idxChain >= 0 && idxChain < values.length) ? values[idxChain] : '',
            resSeq: resSeqVal,
            x: (idxX >= 0 && idxX < values.length) ? (+values[idxX] || 0) : 0,
            y: (idxY >= 0 && idxY < values.length) ? (+values[idxY] || 0) : 0,
            z: (idxZ >= 0 && idxZ < values.length) ? (+values[idxZ] || 0) : 0,
            b: (idxB >= 0 && idxB < values.length) ? (+values[idxB] || 0) : 0,
            element: (idxElement >= 0 && idxElement < values.length) ? values[idxElement] : '',
            res_name: resNameVal, // Duplicate for compatibility
            res_seq: resSeqVal // Duplicate for compatibility
        };

        currentModelArray.push(atom);
        atomCount++;
    }

    const modelCount = modelMap.size;

    const models = Array.from(modelMap.keys())
        .sort((a, b) => a - b)
        .map(id => modelMap.get(id));

    return { models, loops, chemCompMap, structConn, chemCompBondMap };
}

/**
 * Standard amino acid codes (20 standard)
 */
const STANDARD_AMINO_ACIDS = new Set([
    "ALA", "ARG", "ASN", "ASP", "CYS", "GLU", "GLN", "GLY", "HIS", "ILE",
    "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL"
]);

/**
 * Standard nucleic acid codes
 * Includes standard RNA (A, C, G, U) and DNA (DA, DC, DG, DT, T) codes
 * Also includes alternative notation (RA, RC, RG, RU for RNA)
 */
const STANDARD_NUCLEIC_ACIDS = new Set([
    // RNA codes
    "A", "C", "G", "U",
    "RA", "RC", "RG", "RU",  // Alternative RNA notation
    // DNA codes
    "DA", "DC", "DG", "DT", "T",  // T is DNA-specific (thymine)
    // Additional common codes
    "I",   // Inosine (can be RNA or DNA, but more common in RNA)
    "DI"   // Deoxyinosine (DNA)
]);

// NUCLEOTIDE_LIGANDS set removed - no longer needed with simplified classification
// Ligands are now identified by not being connected to chains, not by name exclusion

/**
 * Check if a residue is connected to neighboring residues in the same chain
 * Uses the same distance cutoffs as viewer-mol.js for consistency
 * @param {object} residue - Residue object with resName, record, atoms, chain, resSeq
 * @param {Array} allResidues - Array of all residue objects (for finding neighbors)
 * @param {string} type - 'P' for protein, 'D' for DNA, 'R' for RNA
 * @returns {boolean} - True if residue is connected to at least one neighbor
 */
function isResidueConnected(residue, allResidues, type) {
    if (!residue || !residue.atoms || !allResidues) {
        return false;
    }

    // Distance cutoffs (from viewer-mol.js)
    const PROTEIN_CHAINBREAK = 5.0;  // CA-CA distance
    const NUCLEIC_CHAINBREAK = 7.5;  // C4'-C4' distance
    const cutoff = (type === 'P') ? PROTEIN_CHAINBREAK : NUCLEIC_CHAINBREAK;
    const cutoffSq = cutoff * cutoff;

    // Get backbone atom for distance calculation
    let backboneAtom = null;
    if (type === 'P') {
        backboneAtom = residue.atoms.find(a => a.atomName === 'CA');
    } else {
        backboneAtom = residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
    }

    if (!backboneAtom) {
        return false;  // No backbone atom found
    }

    const backbonePos = [backboneAtom.x, backboneAtom.y, backboneAtom.z];
    const residueNum = residue.resSeq;  // Use residue number directly
    const chain = residue.chain;

    // Check neighbors in the same chain by comparing residue numbers
    // Look for residues within ±2 residue numbers in the same chain
    for (const neighbor of allResidues) {
        if (!neighbor || neighbor.chain !== chain) continue;

        // Check if neighbor is within ±2 residue numbers
        const resSeqDiff = Math.abs(neighbor.resSeq - residueNum);
        if (resSeqDiff > 2 || resSeqDiff === 0) continue;  // Skip if too far or same residue

        // Get neighbor's backbone atom
        let neighborBackboneAtom = null;
        if (type === 'P') {
            neighborBackboneAtom = neighbor.atoms.find(a => a.atomName === 'CA');
        } else {
            neighborBackboneAtom = neighbor.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
        }

        if (!neighborBackboneAtom) continue;

        // Calculate squared distance
        const dx = neighborBackboneAtom.x - backbonePos[0];
        const dy = neighborBackboneAtom.y - backbonePos[1];
        const dz = neighborBackboneAtom.z - backbonePos[2];
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < cutoffSq) {
            return true;  // Found a connected neighbor
        }
    }

    return false;  // No connected neighbors found
}

/**
 * Check if a residue is a real amino acid (standard or modified)
 * Simplified: only canonical amino acids + common modifications (MSE, etc.) + MODRES/CIF-defined if connected
 * @param {object} residue - Residue object with resName, record, atoms
 * @param {Map} modresMap - MODRES mapping (from PDB)
 * @param {Map} chemCompMap - Chemical component map (from CIF)
 * @param {Array} allResidues - Array of all residue objects (for connectivity check)
 * @returns {boolean} - True if residue is a real amino acid
 */
function isRealAminoAcid(residue, modresMap = null, chemCompMap = null, allResidues = null) {
    const resName = residue.resName;

    // 1. Check if it's a standard amino acid (always allowed, no connectivity check needed)
    if (STANDARD_AMINO_ACIDS.has(resName)) {
        return true;
    }

    // 2. Check common modifications dictionary (e.g., MSE->MET)
    const modifiedType = getModifiedResidueType(resName);
    if (modifiedType && modifiedType.type === 'P') {
        // Common modifications require connectivity check
        if (allResidues) {
            return isResidueConnected(residue, allResidues, 'P');
        }
        // If no allResidues provided, allow it (backward compatibility, but less strict)
        return true;
    }

    // 3. Check MODRES map (from PDB) - requires connectivity
    if (modresMap && modresMap.has(resName)) {
        const stdResName = modresMap.get(resName);
        if (STANDARD_AMINO_ACIDS.has(stdResName)) {
            // MODRES-defined modifications require connectivity check
            if (allResidues) {
                return isResidueConnected(residue, allResidues, 'P');
            }
            // If no allResidues provided, allow it (backward compatibility)
            return true;
        }
    }

    // 4. Check CIF chemical component map - requires connectivity
    if (chemCompMap && chemCompMap.has(resName)) {
        const compInfo = chemCompMap.get(resName);
        if (compInfo.type === 'P') {
            // Check if it maps to a standard amino acid
            const stdResName = compInfo.stdResName || compInfo.parent;
            if (stdResName && STANDARD_AMINO_ACIDS.has(stdResName)) {
                // CIF-defined modifications require connectivity check
                if (allResidues) {
                    return isResidueConnected(residue, allResidues, 'P');
                }
                // If no allResidues provided, allow it (backward compatibility)
                return true;
            }
        }
    }

    // 5. STRUCTURAL fallback: a residue carrying an N-CA-C backbone is an amino
    // acid whatever it is called, mirroring the ribose test in
    // isRealNucleicAcid. The dictionary above cannot list every non-standard
    // residue, and anything it misses does not merely render wrong - it is
    // dropped from the chain, so the backbone breaks and the gap reads as an
    // over-length bond rather than the missing residue it is. This also matches
    // the Python path, where gemmi's is_amino_acid() already accepts them.
    // Connectivity is still required, so free amino-acid ligands are not swept
    // in - it takes a CA within 5 A of an adjacent residue number in the chain.
    if (residue.atoms
        && residue.atoms.some(a => a.atomName === 'N')
        && residue.atoms.some(a => a.atomName === 'CA')
        && residue.atoms.some(a => a.atomName === 'C')) {
        if (allResidues) {
            return isResidueConnected(residue, allResidues, 'P');
        }
        return true;
    }

    // No other cases - return false (removed all "last resort" checks)
    return false;
}

// The 2' position, which is the only thing that tells DNA from RNA. Ribose
// carries a hydroxyl there (O2', plus its proton HO2'); deoxyribose carries a
// second hydrogen instead (H2''). Old files spell the prime as * and put the
// count first, so both conventions are listed.
const RIBOSE_2OH_ATOMS = new Set(["O2'", 'O2*', "HO2'", 'HO2*', "2HO'", '2HO*']);
const DEOXY_2H_ATOMS = new Set(["H2''", "H2'*", 'H2**', "2H2'", '2H2*']);

/**
 * DNA or RNA for one STANDARD nucleotide, or null when the file does not say.
 *
 * The base name alone cannot answer this. "A", "C", "G" and "I" are used for
 * both sugars - fibre models and older files write a whole B-DNA duplex as
 * "A C G T" - and taking the name at face value split one duplex into RNA
 * (A/C/G) plus DNA (T), so the renderer fed the A-form prediction to three
 * quarters of a B-form helix and the B-form one to its thymines.
 *
 * Only POSITIVE evidence counts. Concluding deoxy from a missing O2' looks
 * equivalent and is not: 1P79 models the 2'-hydroxyl's proton but omits the
 * oxygen itself, and that one absence turned a G in the middle of an RNA
 * chain into DNA. An unmodelled atom means the file is quiet, not that the
 * atom is absent - hence null, which the caller resolves per chain.
 *
 * T and U are decided by the base: thymine is DNA and uracil is RNA whatever
 * the sugar looks like, and a D or R prefix is the author saying so outright.
 */
function nucleicSugarVote(resName, residue) {
    if (resName === 'T' || resName === 'DI' || resName.startsWith('D')) return 'D';
    if (resName === 'U' || resName.startsWith('R')) return 'R';
    // bare A, C, G, I - ask the sugar
    const atoms = residue && residue.atoms;
    if (!atoms) return null;
    for (const a of atoms) {
        if (RIBOSE_2OH_ATOMS.has(a.atomName)) return 'R';
        if (DEOXY_2H_ATOMS.has(a.atomName)) return 'D';
    }
    return null;
}

/**
 * Same, but always answering. Used where there is no chain to consult; the
 * fallback is the historical one, so a bare name with no sugar reads as RNA.
 */
function standardNucleicType(resName, residue) {
    return nucleicSugarVote(resName, residue) || 'R';
}

/**
 * ONE SUGAR PER CHAIN. A duplex is one molecule and must get one answer: the
 * renderer picks its base-direction prediction and its helix geometry from
 * this letter, so a chain split between D and R is drawn as two different
 * kinds of helix interleaved. Residues that voted decide it for the residues
 * that could not.
 *
 * @param {Array<object>} allResidues - residues, each with .chain and .atoms
 * @returns {Map<string,string>} chain -> 'D' | 'R', only for chains that voted
 */
function resolveChainNucleicTypes(allResidues) {
    const tally = new Map();
    for (const residue of allResidues) {
        if (!STANDARD_NUCLEIC_ACIDS.has(residue.resName)) continue;
        const vote = nucleicSugarVote(residue.resName, residue);
        if (!vote) continue;
        let t = tally.get(residue.chain);
        if (!t) { t = { D: 0, R: 0 }; tally.set(residue.chain, t); }
        t[vote]++;
    }
    const out = new Map();
    for (const [chain, t] of tally) out.set(chain, t.D > t.R ? 'D' : 'R');
    return out;
}

// Backbone. Everything else heavy is side chain - "CB and up". OXT is the
// terminal carboxylate oxygen, backbone by any reading.
const PROTEIN_BACKBONE_ATOMS = new Set(['N', 'CA', 'C', 'O', 'OXT']);
// WHAT IS ACTUALLY BONDED TO WHAT, per residue type.
//
// A side chain's connectivity is a property of the amino acid, not of the
// coordinates, so it does not have to be guessed from distances at all. The
// distance rule below is kept as a FALLBACK for residues not in this table -
// modified and non-standard ones - but wherever the residue is recognised its
// real bonds are used, and then a bond is right however stretched the geometry
// is. That is what the distance rule could not do: 4HHB has real bonds out at
// 2.2 A while non-bonded pairs in the same residue start at 2.41 A, so no
// single threshold separates them.
//
// Backbone bonds are omitted - only CA outwards is drawn. PRO's CD-N ring
// closure is a backbone bond and so is left out; the ring reads as open at the
// N, which is where the drawn side chain genuinely stops.
const PROTEIN_SIDECHAIN_BONDS = {
    ALA: [['CA', 'CB']],
    ARG: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'NE'], ['NE', 'CZ'],
        ['CZ', 'NH1'], ['CZ', 'NH2']],
    ASN: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'OD1'], ['CG', 'ND2']],
    ASP: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'OD1'], ['CG', 'OD2']],
    CYS: [['CA', 'CB'], ['CB', 'SG']],
    GLN: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'OE1'], ['CD', 'NE2']],
    GLU: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'OE1'], ['CD', 'OE2']],
    GLY: [],
    HIS: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'ND1'], ['CG', 'CD2'],
        ['ND1', 'CE1'], ['CD2', 'NE2'], ['CE1', 'NE2']],
    ILE: [['CA', 'CB'], ['CB', 'CG1'], ['CB', 'CG2'], ['CG1', 'CD1']],
    LEU: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CG', 'CD2']],
    LYS: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD'], ['CD', 'CE'], ['CE', 'NZ']],
    MET: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'SD'], ['SD', 'CE']],
    MSE: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'SE'], ['SE', 'CE']],
    PHE: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CG', 'CD2'],
        ['CD1', 'CE1'], ['CD2', 'CE2'], ['CE1', 'CZ'], ['CE2', 'CZ']],
    PRO: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD']],
    SER: [['CA', 'CB'], ['CB', 'OG']],
    THR: [['CA', 'CB'], ['CB', 'OG1'], ['CB', 'CG2']],
    TRP: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CG', 'CD2'],
        ['CD1', 'NE1'], ['NE1', 'CE2'], ['CD2', 'CE2'], ['CD2', 'CE3'],
        ['CE2', 'CZ2'], ['CE3', 'CZ3'], ['CZ2', 'CH2'], ['CZ3', 'CH2']],
    TYR: [['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CG', 'CD2'],
        ['CD1', 'CE1'], ['CD2', 'CE2'], ['CE1', 'CZ'], ['CE2', 'CZ'],
        ['CZ', 'OH']],
    VAL: [['CA', 'CB'], ['CB', 'CG1'], ['CB', 'CG2']],
};

// NAMES THAT MEAN THE SAME ATOM. The table is written in PDB v3 names, and
// older files use v2 for a handful of heavy atoms - isoleucine's terminal
// carbon is CD1 in v3 and CD in v2, and selenomethionine's selenium is written
// both SE and SED. Without this an ILE from a v2 file loses its CD1 bond and
// the tip comes away. Symmetric pairs that merely swap between files - ASP's
// OD1/OD2, PHE's CD1/CD2 - need nothing here: both bond to the same parent, so
// which is which does not change the connectivity.
const SIDECHAIN_ATOM_ALIASES = {
    ILE: { CD: 'CD1' },
    MSE: { SED: 'SE' },
};

// WHERE A BOND STOPS BEING A BOND.
//
// Ideal side-chain bonds run 1.43 (C-O) to 1.81 (C-S), so a 1.9 cutoff looks
// generous - and is not. Refined geometry scatters, and older structures
// scatter further: on 4HHB, 69 atoms came out with no bond at all, their
// nearest neighbour sitting at 1.90-1.94 A. CA-CB, CD-CE, CE-NZ - real bonds,
// just long. Each drew as an isolated sphere beside a gap.
//
// The ceiling is the shortest NON-bonded distance in a residue: two atoms one
// bond apart from a common neighbour. Tetrahedral that is 2*1.53*sin(54.75) =
// 2.50 A, aromatic 2*1.39*sin(60) = 2.41 A. Measured over 25,946 side-chain
// atoms, atoms with an impossible number of neighbours stay flat to 2.10 and
// then break sharply - 3 at 1.90, 6 at 2.10, 109 at 2.20, 3004 at 2.40 - so a
// single threshold cannot both catch a 2.2 A bond and avoid inventing them.
//
// So there are TWO numbers. The threshold below is deliberately tight, tight
// enough that it never bonds a 1,3 pair; what it misses is repaired afterwards
// by joining each detached fragment to the rest through its single SHORTEST
// link (see the reachability pass). One shortest link per fragment cannot
// over-coordinate anything, which is what lets the repair reach further than
// the threshold safely.
//
// The repair also makes this threshold uncritical: 1.9, 2.0 and 2.1 all give
// the identical table on 4HHB, because whatever the threshold misses the
// repair puts back. It is the repair's reach below that decides the answer,
// which is where the tests are pointed.
const SIDECHAIN_BOND_MAX = 2.0;
const SIDECHAIN_BOND_MAX_SQ = SIDECHAIN_BOND_MAX * SIDECHAIN_BOND_MAX;
// The repair's reach. Below the 2.41 A aromatic 1,3 distance, so a fragment
// separated by a genuinely UNMODELLED atom - a residue whose CG was never
// built while its CD was - stays detached and is dropped rather than joined by
// a bond that does not exist.
const SIDECHAIN_LINK_MAX_SQ = 2.35 * 2.35;

/**
 * Side chains, stored so they FOLLOW THE BACKBONE WHEREVER IT GOES.
 *
 * py2Dmol keeps one position per residue, and the cartoon renderer then moves
 * that position: it is re-centred at load, rotated to face the viewer, and -
 * in the richardson preset - projected onto its sheet plane and flattened
 * (see sheetProject / sheetFlat in viewer-cartoon.js). A side chain held as a
 * world coordinate would be right only in the raw file's frame and would tear
 * away from its own CA everywhere else.
 *
 * So nothing here is stored in world space. Each atom is three coefficients in
 * its residue's own backbone frame - the frame built from the CA trace by
 * localFrame() - which is invariant under translation and rotation alike. At
 * draw time the renderer rebuilds the same frame from the FINAL positions and
 * reads the coefficients back out, so the side chain arrives wherever the CA
 * ended up, at the right orientation, with no transform to keep in step.
 *
 * That frame is deliberately the renderer's own function rather than a copy of
 * it: capture and reconstruction have to agree exactly, and two
 * implementations of the same 20 lines is how they stop agreeing.
 *
 * Terminal residues have no frame of their own (localFrame needs a neighbour
 * on each side), so they borrow the nearest one that does and are stored in
 * that. It is a rigid frame either way; all it costs is that a terminus
 * follows its neighbour's flattening rather than its own, and flattening does
 * not move chain ends.
 *
 * THE CA IS NOT IN THE TABLE. It is already a drawn position - the backbone
 * runs through it - so carrying a copy would put two coincident positions on
 * top of each other, a fifth of the table (534 of 2618 atoms on 4HHB) spent
 * duplicating something the renderer had already placed, with the CA-CB bond
 * drawn to the copy rather than to the backbone. Instead the atoms that bond
 * to it are listed in `toBackbone`, and the renderer joins them to the owning
 * position itself, so the side chain hangs off the backbone that is really
 * there. The CA still takes part in the graph while the table is being built,
 * as the root everything must reach; it is simply not emitted.
 *
 * @param {Array<Array<number>>} coords - final position coordinates
 * @param {Array<object>} entries - {pos, residue} per emitted protein position
 * @returns {object|null} - the side-chain table, or null if there is nothing
 */
function buildSidechainTable(coords, entries) {
    const localFrame = (typeof window !== 'undefined' && window.py2dmolCartoon)
        ? window.py2dmolCartoon.localFrame : null;
    if (!localFrame || !entries.length) return null;

    const n = coords.length;
    const at = (i) => ({ x: coords[i][0], y: coords[i][1], z: coords[i][2] });
    // which residues can carry a frame at all
    const fr = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const hasFrame = new Uint8Array(n);
    for (const e of entries) {
        if (localFrame(at, n, e.pos, fr, null)) hasFrame[e.pos] = 1;
    }
    // nearest framed position, searching outward - only used at chain ends
    const framedNear = (pos) => {
        if (hasFrame[pos]) return pos;
        for (let d = 1; d <= 3; d++) {
            if (pos - d >= 0 && hasFrame[pos - d]) return pos - d;
            if (pos + d < n && hasFrame[pos + d]) return pos + d;
        }
        return -1;
    };

    const pos = []; const frameOf = []; const coef = [];
    const names = []; const elements = []; const bonds = [];
    // table rows bonded to their residue's own backbone position, not to
    // another row - the CA end of the side chain
    const toBackbone = [];
    for (const e of entries) {
        const ca = e.residue.caAtom;
        if (!ca) continue;
        const anchor = framedNear(e.pos);
        if (anchor < 0) continue;                 // too short to frame: skip
        if (!localFrame(at, n, anchor, fr, null)) continue;
        const o = at(anchor);

        // ONE CONFORMER, THE FIRST. A residue modelled in two positions writes
        // each of its atoms twice - alt A and alt B - and taking both gives a
        // side chain with two of every atom, bonded to each other by the
        // distance rule below into a tangle that is not any real conformer.
        // First-wins by atom NAME rather than by reading the alt-loc column:
        // it needs nothing from the parser, and it matches what the BACKBONE
        // already does - residue.caAtom is the first CA seen - so the side
        // chain comes from the same conformer as the position it hangs off
        // rather than mixing alt B's CB onto alt A's CA.
        // HYDROGEN, EVEN WITHOUT AN ELEMENT COLUMN. Columns 77-78 of a PDB
        // ATOM record are optional and older files leave them blank, so the
        // element test alone lets hydrogens through. A residue in the
        // connectivity table shrugs that off - the table never names a
        // hydrogen, so it attaches to nothing and the reachability pass drops
        // it - but the distance FALLBACK bonds it to its parent and draws it.
        // Measured on a hydrogen-bearing file with no element column: standard
        // residues came out clean, a non-standard one kept HB2, HG and 1HB.
        //
        // So the name decides it when the column is silent: PDB names
        // hydrogens H..., and v2 puts the count first (1HB, 2HB). Only
        // consulted when `element` is empty, so a ligand atom that really is
        // mercury keeps its element, and only inside a residue already
        // classified as protein, where an H-name cannot be anything else.
        const isHydrogen = (a) => (a.element
            ? (a.element === 'H' || a.element === 'D')
            : /^[0-9]?[HD]/.test(a.atomName || ''));
        const group = [];
        const seen = new Set();
        for (const a of e.residue.atoms) {
            if (isHydrogen(a)) continue;
            if (a.atomName !== 'CA' && PROTEIN_BACKBONE_ATOMS.has(a.atomName)) continue;
            if (seen.has(a.atomName)) continue;
            seen.add(a.atomName);
            group.push(a);
        }
        // CA first, so index 0 of every group is the anchor
        group.sort((a, b) => (a.atomName === 'CA' ? -1 : b.atomName === 'CA' ? 1 : 0));
        if (group.length < 2) continue;           // glycine: nothing to draw
        const base = pos.length;
        // CONNECTIVITY. From the residue's chemistry where we recognise it,
        // and only otherwise from distances.
        const link = [];
        const adj = group.map(() => []);
        const join = (i, j) => {
            link.push(i, j);
            adj[i].push(j); adj[j].push(i);
        };
        const known = PROTEIN_SIDECHAIN_BONDS[e.residue.resName];
        if (known) {
            const alias = SIDECHAIN_ATOM_ALIASES[e.residue.resName];
            const row = new Map();
            for (let i = 0; i < group.length; i++) {
                const n0 = group[i].atomName;
                row.set((alias && alias[n0]) || n0, i);
            }
            for (const [n1, n2] of known) {
                const i = row.get(n1); const j = row.get(n2);
                // an atom the file never modelled simply has no bond to make
                if (i !== undefined && j !== undefined) join(i, j);
            }
        } else {
            for (let i = 0; i < group.length; i++) {
                for (let j = i + 1; j < group.length; j++) {
                    const a = group[i], b = group[j];
                    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
                    if (dx * dx + dy * dy + dz * dz < SIDECHAIN_BOND_MAX_SQ) {
                        join(i, j);
                    }
                }
            }
        }
        // ONLY WHAT HANGS OFF THE CA. A side chain is a tree rooted at its CA,
        // so an atom the cutoff could not reach from there is not attached to
        // anything we are drawing - it is a fragment left by missing density,
        // a residue whose CG was never modelled while its CD was. Drawn anyway
        // it appears as a sphere floating beside a gap, which reads as a broken
        // bond rather than as the absent atom it really is. Dropping it says
        // the honest thing: nothing is drawn where nothing was measured.
        const reach = new Set([0]);          // index 0 is the CA anchor
        const grow = (from) => {
            const stack = [from];
            while (stack.length) {
                for (const nb of adj[stack.pop()]) {
                    if (reach.has(nb)) continue;
                    reach.add(nb); stack.push(nb);
                }
            }
        };
        grow(0);
        // REPAIR, FALLBACK RESIDUES ONLY. Where the chemistry is known a
        // detached fragment means an atom the file never modelled, and guessing
        // a bond across the hole would draw one that does not exist. Only the
        // distance rule needs rescuing from itself: there a fragment is either
        // a bond the tight threshold missed or an atom whose neighbour was
        // never modelled, and the two look completely different - the first
        // sits a little past the threshold, the second past any bond length at
        // all. So each detached fragment is offered ONE link, its shortest, and
        // joined if that link is short enough to be a bond. A single link per
        // fragment cannot over-coordinate anything, which is why it may reach
        // further than the threshold does.
        while (!known) {
            let bd = SIDECHAIN_LINK_MAX_SQ; let bi = -1; let bj = -1;
            for (let i = 0; i < group.length; i++) {
                if (!reach.has(i)) continue;
                for (let j = 0; j < group.length; j++) {
                    if (reach.has(j)) continue;
                    const a = group[i], b = group[j];
                    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 < bd) { bd = d2; bi = i; bj = j; }
                }
            }
            if (bi < 0) break;
            link.push(bi, bj);
            adj[bi].push(bj); adj[bj].push(bi);
            reach.add(bj);
            grow(bj);
        }
        // Whatever is STILL detached is dropped, for the reason above.
        if (reach.size < 2) continue;        // nothing reached the CA at all
        // renumber the survivors, since the rows are written in group order
        const keep = [];
        for (let i = 0; i < group.length; i++) if (reach.has(i)) keep.push(i);
        const rowOf = new Map();
        // the CA (group index 0) is the backbone position, so it is not emitted
        const emitted = keep.filter((i) => i !== 0);
        for (let i = 0; i < emitted.length; i++) rowOf.set(emitted[i], base + i);
        for (const i of emitted) {
            const a = group[i];
            const dx = a.x - o.x, dy = a.y - o.y, dz = a.z - o.z;
            pos.push(e.pos);
            frameOf.push(anchor);
            coef.push(dx * fr[0] + dy * fr[1] + dz * fr[2]);
            coef.push(dx * fr[3] + dy * fr[4] + dz * fr[5]);
            coef.push(dx * fr[6] + dy * fr[7] + dz * fr[8]);
            names.push(a.atomName);
            elements.push(a.element || '');
        }
        for (let k = 0; k + 1 < link.length; k += 2) {
            const p1 = link[k]; const p2 = link[k + 1];
            // a bond touching the CA becomes a bond to the OWNING POSITION,
            // recorded separately because it crosses out of the table
            if (p1 === 0 || p2 === 0) {
                const other = rowOf.get(p1 === 0 ? p2 : p1);
                if (other !== undefined) toBackbone.push(other);
                continue;
            }
            const a = rowOf.get(p1); const b = rowOf.get(p2);
            if (a !== undefined && b !== undefined) bonds.push(a, b);
        }
    }
    if (!pos.length) return null;
    return {
        pos: new Int32Array(pos),
        frameOf: new Int32Array(frameOf),
        coef: new Float32Array(coef),
        bonds: new Int32Array(bonds),
        toBackbone: new Int32Array(toBackbone),
        names,
        elements,
    };
}

/**
 * A side-chain table trimmed for SAVING - every residue kept, nothing that the
 * drawing does not need.
 *
 * The whole table goes in, not just the residues that were showing. Storing
 * only those made a smaller file and a session you could not change your mind
 * in: reload it and the side chains you had are there, but no others can ever
 * be turned on, because their atoms were never written down and the file they
 * came from is long gone. Being able to enable a residue later is most of the
 * point of the control.
 *
 * What is dropped is `names` and `elements`. Nothing reads them to draw - they
 * exist so the connectivity table can be applied at capture, which has already
 * happened by now - and they are a third of the bytes. Coefficients round to
 * 0.01 A, which is far finer than a side chain drawn a few pixels wide.
 *
 * Cost on 1TIM: 56 KB against 11 KB of coordinates, per frame. That ratio is
 * the price of the feature; it was 145 KB before this trimming.
 *
 * @param {object} sc - the full table
 * @returns {object|null}
 */
function trimSidechainTable(sc) {
    if (!sc || !sc.pos || !sc.pos.length) return null;
    const coef = new Array(sc.coef.length);
    for (let i = 0; i < sc.coef.length; i++) {
        coef[i] = Math.round(sc.coef[i] * 100) / 100;
    }
    return {
        pos: Array.from(sc.pos),
        frameOf: Array.from(sc.frameOf),
        coef,
        bonds: Array.from(sc.bonds),
        toBackbone: Array.from(sc.toBackbone || []),
    };
}

/**
 * Rebuild a table read back from a saved session. JSON has no typed arrays, so
 * the numeric columns come back as plain ones and are put back into the shapes
 * the renderer indexes.
 */
function reviveSidechainTable(raw) {
    if (!raw || !raw.pos || !raw.pos.length) return null;
    return {
        pos: new Int32Array(raw.pos),
        frameOf: new Int32Array(raw.frameOf),
        coef: new Float32Array(raw.coef),
        bonds: new Int32Array(raw.bonds || []),
        toBackbone: new Int32Array(raw.toBackbone || []),
        // absent in a saved table: nothing reads them to draw, and they were
        // dropped to save the bytes - see trimSidechainTable
        names: raw.names || [],
        elements: raw.elements || [],
    };
}

/**
 * Check if a residue is a real nucleic acid (standard or modified)
 * Simplified: only canonical DNA/RNA + common modifications + MODRES/CIF-defined if connected
 * @param {object} residue - Residue object with resName, record, atoms
 * @param {Map} modresMap - MODRES mapping (from PDB)
 * @param {Map} chemCompMap - Chemical component map (from CIF)
 * @param {Array} allResidues - Array of all residue objects (for connectivity check)
 * @returns {string|null} - 'D' for DNA, 'R' for RNA, or null if not a real nucleic acid
 */
function isRealNucleicAcid(residue, modresMap = null, chemCompMap = null, allResidues = null) {
    const resName = residue.resName;

    // 1. Check if it's a standard nucleic acid (always allowed, no connectivity check needed)
    if (STANDARD_NUCLEIC_ACIDS.has(resName)) {
        return standardNucleicType(resName, residue);
    }

    // 2. Check common modifications dictionary - requires connectivity
    const modifiedType = getModifiedResidueType(resName);
    if (modifiedType && (modifiedType.type === 'D' || modifiedType.type === 'R')) {
        // Common modifications require connectivity check
        if (allResidues) {
            if (isResidueConnected(residue, allResidues, modifiedType.type)) {
                return modifiedType.type;
            }
            return null;  // Not connected
        }
        // If no allResidues provided, allow it (backward compatibility, but less strict)
        return modifiedType.type;
    }

    // 3. Check MODRES map (from PDB) - requires connectivity
    if (modresMap && modresMap.has(resName)) {
        const stdResName = modresMap.get(resName);
        if (STANDARD_NUCLEIC_ACIDS.has(stdResName)) {
            // the modified residue carries its own sugar, so read it there
            const nucleicType = standardNucleicType(stdResName, residue);
            // MODRES-defined modifications require connectivity check
            if (allResidues) {
                if (isResidueConnected(residue, allResidues, nucleicType)) {
                    return nucleicType;
                }
                return null;  // Not connected
            }
            // If no allResidues provided, allow it (backward compatibility)
            return nucleicType;
        }
    }

    // 4. Check CIF chemical component map - requires connectivity
    if (chemCompMap && chemCompMap.has(resName)) {
        const compInfo = chemCompMap.get(resName);
        if (compInfo.type === 'D' || compInfo.type === 'R') {
            // Check if it maps to a standard nucleic acid
            const stdResName = compInfo.stdResName || compInfo.parent;
            if (stdResName && STANDARD_NUCLEIC_ACIDS.has(stdResName)) {
                // CIF-defined modifications require connectivity check
                if (allResidues) {
                    if (isResidueConnected(residue, allResidues, compInfo.type)) {
                        return compInfo.type;
                    }
                    return null;  // Not connected
                }
                // If no allResidues provided, allow it (backward compatibility)
                return compInfo.type;
            }
        }
    }

    // 5. STRUCTURAL fallback: a residue carrying a ribose/deoxyribose ring is a
    // nucleotide whatever it is called. The dictionary above only lists PSU, so
    // tRNA modifications (YYG, 5MC, 1MA, 2MG, 7MG, OMC, OMG, 4SU, H2U ...) fell
    // through and were dropped from the chain - 1EHZ lost 3 residues and the
    // backbone broke at each one, which then looked like an over-length bond
    // rather than the missing residue it was. Mirrors the same fix in
    // viewer.py. Connectivity is still required, so free nucleotide ligands
    // (ATP, GTP) are not swept in.
    const atomNamed = (...names) => residue.atoms
        && residue.atoms.some(a => names.indexOf(a.atomName) !== -1);
    if (atomNamed("C4'", "C4*") && atomNamed("O4'", "O4*") && atomNamed("C1'", "C1*")) {
        // the 2'-OH is what separates ribose from deoxyribose, and it survives
        // any modification of the base itself
        const nucleicType = atomNamed("O2'", "O2*") ? 'R' : 'D';
        if (allResidues) {
            if (isResidueConnected(residue, allResidues, nucleicType)) {
                return nucleicType;
            }
            return null;
        }
        return nucleicType;
    }

    // No other cases - return null (removed all "last resort" checks and NUCLEOTIDE_LIGANDS exclusion)
    return null;
}

/**
 * Map modified residue codes to their parent types
 * Returns 'P' for protein, 'D' for DNA, 'R' for RNA, or null if not a modified standard residue
 */
function getModifiedResidueType(resName) {
    // Simplified mapping of common modified residues to their parent types
    // Only includes the most common modifications (e.g., MSE->MET)
    // Format: modified_code -> {type: 'P'|'D'|'R', parent: standard_code}
    const modifiedResidueMap = {
        // Common modified amino acids (protein)
        'MSE': { type: 'P', parent: 'MET' }, // Selenomethionine (most common)
        'PTR': { type: 'P', parent: 'TYR' }, // Phosphotyrosine
        'SEP': { type: 'P', parent: 'SER' }, // Phosphoserine
        'TPO': { type: 'P', parent: 'THR' }, // Phosphothreonine
        'FME': { type: 'P', parent: 'MET' }, // N-formylmethionine
        'HYP': { type: 'P', parent: 'PRO' }, // 4-hydroxyproline
        'PCA': { type: 'P', parent: 'GLU' }, // Pyroglutamic acid
        'ALY': { type: 'P', parent: 'LYS' }, // N-acetyllysine
        // D-AMINO ACIDS. Deposited as HETATM with no MODRES record (5KX0), so
        // nothing above matched and they were dropped from the chain - that
        // structure lost 11 of its 26 residues and the backbone broke at each
        // one. gemmi tabulates all of these as amino acids, so the Python path
        // already handled them; this is what the web parser was missing.
        // GLY is achiral and has no D form.
        'DAL': { type: 'P', parent: 'ALA' }, // D-alanine
        'DAR': { type: 'P', parent: 'ARG' }, // D-arginine
        'DSG': { type: 'P', parent: 'ASN' }, // D-asparagine
        'DAS': { type: 'P', parent: 'ASP' }, // D-aspartic acid
        'DCY': { type: 'P', parent: 'CYS' }, // D-cysteine
        'DGN': { type: 'P', parent: 'GLN' }, // D-glutamine
        'DGL': { type: 'P', parent: 'GLU' }, // D-glutamic acid
        'DHI': { type: 'P', parent: 'HIS' }, // D-histidine
        'DIL': { type: 'P', parent: 'ILE' }, // D-isoleucine
        'DLE': { type: 'P', parent: 'LEU' }, // D-leucine
        'DLY': { type: 'P', parent: 'LYS' }, // D-lysine
        'MED': { type: 'P', parent: 'MET' }, // D-methionine
        'DPN': { type: 'P', parent: 'PHE' }, // D-phenylalanine
        'DPR': { type: 'P', parent: 'PRO' }, // D-proline
        'DSN': { type: 'P', parent: 'SER' }, // D-serine
        'DTH': { type: 'P', parent: 'THR' }, // D-threonine
        'DTR': { type: 'P', parent: 'TRP' }, // D-tryptophan
        'DTY': { type: 'P', parent: 'TYR' }, // D-tyrosine
        'DVA': { type: 'P', parent: 'VAL' }, // D-valine
        // Common modified nucleotides (DNA)
        '5MDA': { type: 'D', parent: 'DA' }, // 5-methyldeoxyadenosine
        '5MDC': { type: 'D', parent: 'DC' }, // 5-methyldeoxycytidine
        '5MDG': { type: 'D', parent: 'DG' }, // 5-methyldeoxyguanosine
        // Common modified nucleotides (RNA)
        'M6A': { type: 'R', parent: 'A' }, // N6-methyladenosine
        'M5C': { type: 'R', parent: 'C' }, // 5-methylcytidine
        'M7G': { type: 'R', parent: 'G' }, // 7-methylguanosine
        'PSU': { type: 'R', parent: 'U' }  // Pseudouridine
    };

    return modifiedResidueMap[resName] || null;
}

/**
 * Get the standard (unmodified) residue name for a given residue
 * Maps modified residues (e.g., MSE) to their standard equivalents (e.g., MET)
 * @param {string} resName - Residue name (may be modified)
 * @returns {string} - Standard residue name, or original if not a known modification
 */
function getStandardResidueName(resName) {
    if (!resName) return resName;

    // Check if it's a standard residue (no modification needed)
    if (STANDARD_AMINO_ACIDS.has(resName) || STANDARD_NUCLEIC_ACIDS.has(resName)) {
        return resName;
    }

    // Check if it's a known modification
    const modifiedType = getModifiedResidueType(resName);
    if (modifiedType && modifiedType.parent) {
        return modifiedType.parent;
    }

    // Check MODRES map (from PDB)
    if (typeof window !== 'undefined' && window._lastModresMap) {
        const modresMap = window._lastModresMap;
        if (modresMap.has(resName)) {
            const stdResName = modresMap.get(resName);
            if (STANDARD_AMINO_ACIDS.has(stdResName) || STANDARD_NUCLEIC_ACIDS.has(stdResName)) {
                return stdResName;
            }
        }
    }

    // Check CIF chemical component map
    if (typeof window !== 'undefined' && window._lastChemCompMap) {
        const chemCompMap = window._lastChemCompMap;
        if (chemCompMap.has(resName)) {
            const compInfo = chemCompMap.get(resName);
            const stdResName = compInfo.stdResName || compInfo.parent;
            if (stdResName && (STANDARD_AMINO_ACIDS.has(stdResName) || STANDARD_NUCLEIC_ACIDS.has(stdResName))) {
                return stdResName;
            }
        }
    }

    // Not a known modification, return original
    return resName;
}

// ============================================================================
// LIGAND GROUPING UTILITIES
// ============================================================================

/**
 * Create a unique key for a ligand group
 * @param {string} chain - Chain ID
 * @param {number} resSeq - Position index (residue sequence number)
 * @param {string} resName - Position name (residue name, optional)
 * @param {number} atomIndex - Position index (fallback)
 * @returns {string} - Ligand group key
 */
function createLigandGroupKey(chain, resSeq, resName, atomIndex) {
    if (resName) {
        // Primary: chain + resSeq + resName (most specific)
        return `${chain}:${resSeq}:${resName}`;
    } else if (resSeq !== undefined && resSeq !== null) {
        // Secondary: chain + resSeq
        return `${chain}:${resSeq}`;
    } else {
        // Fallback: chain + atomIndex (for consecutive atoms)
        return `${chain}:${atomIndex}`;
    }
}

/**
 * Group ligand atoms into ligand groups based on chain, residue_numbers, and position_names
 * @param {Array<string>} chains - Array of chain IDs for each position
 * @param {Array<string>} positionTypes - Array of position types ('P', 'D', 'R', 'L')
 * @param {Array<number>} residueNumbers - Array of PDB residue sequence numbers (optional)
 * @param {Array<string>} positionNames - Array of position names (optional)
 * @returns {Map<string, Array<number>>} - Map of ligand group keys to arrays of position indices
 * 
 * Grouping priority:
 * 1. If position_name available: "chain:resSeq:resName"
 * 2. If only residue_numbers available: "chain:resSeq"
 * 3. If neither available: "chain:firstPositionIdx" (groups consecutive atoms)
 */
function groupLigandAtoms(chains, positionTypes, residueNumbers, positionNames) {
    const ligandGroups = new Map();

    if (!chains || !positionTypes || chains.length !== positionTypes.length) {
        return ligandGroups; // Return empty map if invalid data
    }

    const hasResidueNumbers = residueNumbers && residueNumbers.length === chains.length;
    const hasPositionNames = positionNames && positionNames.length === chains.length;

    // Detect if residue_numbers appears to be default sequential values (1, 2, 3, ...)
    // This happens when residue_numbers was missing and defaults were created
    let isDefaultSequential = false;
    if (hasResidueNumbers) {
        // Check if all values are strictly sequential starting from 1
        isDefaultSequential = residueNumbers.every((val, idx) => val === idx + 1);
    }

    // For ligands, if residue_numbers is default sequential AND positionNames are missing or all 'UNK',
    // treat it as if residue_numbers is missing (use fallback grouping)
    const useFallbackGrouping = !hasResidueNumbers ||
        (isDefaultSequential && (!hasPositionNames || positionNames.every(r => !r || r === 'UNK')));

    // If using fallback grouping, group ALL ligand atoms in each chain as one ligand
    if (useFallbackGrouping) {
        // Group by chain: all ligand atoms in same chain = one ligand group
        const chainLigandGroups = new Map(); // chain -> array of position indices

        for (let i = 0; i < positionTypes.length; i++) {
            if (positionTypes[i] === 'L') {
                const chain = chains[i];
                if (!chainLigandGroups.has(chain)) {
                    chainLigandGroups.set(chain, []);
                }
                chainLigandGroups.get(chain).push(i);
            }
        }

        // Create group keys for each chain's ligand atoms
        for (const [chain, positionIndices] of chainLigandGroups) {
            if (positionIndices.length > 0) {
                // Use first position index as the group key identifier
                const groupKey = createLigandGroupKey(chain, null, null, positionIndices[0]);
                ligandGroups.set(groupKey, positionIndices);
            }
        }
    } else {
        // Normal grouping: use residue_numbers and position names when available
        for (let i = 0; i < positionTypes.length; i++) {
            if (positionTypes[i] === 'L') {
                const chain = chains[i];
                const residueNum = hasResidueNumbers ? residueNumbers[i] : null;
                const positionName = hasPositionNames ? positionNames[i] : null;

                // Create group key based on available data
                let groupKey;
                if (positionName && positionName !== 'UNK') {
                    // Primary: use chain + residueNum + positionName
                    groupKey = createLigandGroupKey(chain, residueNum, positionName, i);
                } else if (residueNum !== undefined && residueNum !== null) {
                    // Secondary: use chain + residueNum
                    groupKey = createLigandGroupKey(chain, residueNum, null, i);
                } else {
                    // Should not happen if useFallbackGrouping is false, but handle gracefully
                    groupKey = createLigandGroupKey(chain, null, null, i);
                }

                // Add position to ligand group
                if (!ligandGroups.has(groupKey)) {
                    ligandGroups.set(groupKey, []);
                }
                ligandGroups.get(groupKey).push(i);
            }
        }
    }

    return ligandGroups;
}

/**
 * Expand position selection to include all positions in any ligand groups that contain selected positions
 * @param {Set<number>|Array<number>} positionIndices - Selected position indices
 * @param {Map<string, Array<number>>} ligandGroups - Ligand groups from groupLigandAtoms()
 * @returns {Set<number>} - Expanded set of position indices
 */
function expandLigandSelection(positionIndices, ligandGroups) {
    const expandedPositions = new Set(positionIndices);

    if (!ligandGroups || ligandGroups.size === 0) {
        return expandedPositions; // No ligand groups, return original selection
    }

    // Create reverse map: position index -> ligand group key
    const positionToGroup = new Map();
    for (const [groupKey, positionIndicesInGroup] of ligandGroups) {
        for (const positionIdx of positionIndicesInGroup) {
            positionToGroup.set(positionIdx, groupKey);
        }
    }

    // Find all ligand groups that contain selected positions
    const selectedGroups = new Set();
    for (const positionIdx of positionIndices) {
        if (positionToGroup.has(positionIdx)) {
            selectedGroups.add(positionToGroup.get(positionIdx));
        }
    }

    // Add all positions from selected ligand groups
    for (const groupKey of selectedGroups) {
        const positionsInGroup = ligandGroups.get(groupKey);
        if (positionsInGroup) {
            for (const positionIdx of positionsInGroup) {
                expandedPositions.add(positionIdx);
            }
        }
    }

    return expandedPositions;
}

/**
 * Convert parsed atoms to frame data format, omitting keys for data that is not present.
 * @param {Array<object>} atoms - Parsed atoms
 * @param {Map} modresMap - Optional MODRES mapping from PDB (resName -> stdResName)
 * @param {Map} chemCompMap - Optional chemical component map from CIF
 * @param {boolean} includeAllResidues - If true, include all residues (even unconnected) for PAE mapping. If false, filter based on connectivity.
 * @param {Map} conectMap - Optional CONECT mapping from PDB (atom serial -> [bonded atom serials])
 * @param {Array} structConn - Optional _struct_conn array from CIF
 * @param {Map} chemCompBondMap - Optional chemical component bond map (resName -> {atom1, atom2, order}[])
 * @returns {object} - Frame data with coords, and optional plddts, chains, position_types, bonds
 */
function normalizePlddt(value) {
    // If plddt is in 0-1 range, multiply by 100 to get 0-100 range
    if (typeof value === 'number' && !isNaN(value) && value >= 0 && value <= 1) {
        return value * 100;
    }
    return value;
}

function convertParsedToFrameData(atoms, modresMap = null, chemCompMap = null, includeAllResidues = false, conectMap = null, structConn = null, chemCompBondMap = null) {
    const coords = [];
    const plddts = [];
    const position_chains = [];
    const position_types = [];
    const residues = [];
    const residue_numbers = [];

    // Map atom serial/ID to new index in coords array
    const atomSerialToIndex = new Map();
    // Also map chain:seq:atomName to index for CIF struct_conn resolution
    const atomIdToIndex = new Map();
    // Map resKey:atomName to new index for chemCompBondMap resolution
    const resAtomIdToIndex = new Map();

    const residueMap = new Map();
    for (const atom of atoms) {
        if (atom.resName === 'HOH') continue;
        // Optimize string concatenation - use array join or direct concatenation
        const resKey = atom.chain + ':' + atom.resSeq + ':' + atom.resName;
        let residue = residueMap.get(resKey);
        if (!residue) {
            residue = {
                atoms: [],
                resName: atom.resName,
                chain: atom.chain,
                record: atom.record,
                resSeq: atom.resSeq,
                caAtom: null, // Cache CA atom for proteins
                c4Atom: null  // Cache C4' atom for nucleic acids
            };
            residueMap.set(resKey, residue);
        }
        residue.atoms.push(atom);

        // Cache CA and C4' atoms during building to avoid .find() later
        if (!residue.caAtom && atom.atomName === 'CA') {
            residue.caAtom = atom;
        }
        if (!residue.c4Atom && (atom.atomName === "C4'" || atom.atomName === "C4*")) {
            residue.c4Atom = atom;
        }
    }

    // Convert residueMap to array for connectivity checks
    const allResidues = Array.from(residueMap.values());

    // Sort residues by chain and resSeq for proper neighbor checking
    allResidues.sort((a, b) => {
        if (a.chain !== b.chain) {
            return a.chain.localeCompare(b.chain);
        }
        return a.resSeq - b.resSeq;
    });

    // One DNA/RNA answer per chain - see resolveChainNucleicTypes.
    const chainNucleic = resolveChainNucleicTypes(allResidues);

    // Side-chain capture. Recorded here because this is the only moment the
    // atoms exist: the loop below keeps one CA per residue and everything else
    // is dropped, and the file text is not retained, so an atom not taken now
    // cannot be recovered later. The table it builds is never read by the
    // draw path unless a residue is actually selected - see buildSidechainTable.
    const sidechainEntries = [];

    for (let idx = 0; idx < allResidues.length; idx++) {
        const residue = allResidues[idx];

        // Use unified classification functions
        // If includeAllResidues is true, skip connectivity checks (for PAE mapping)
        // Otherwise, use connectivity checks (for normal filtering)
        let is_protein, nucleicType;
        if (includeAllResidues) {
            // For PAE mapping: include all residues, skip connectivity checks
            is_protein = isRealAminoAcid(residue, modresMap, chemCompMap, null, -1);
            nucleicType = isRealNucleicAcid(residue, modresMap, chemCompMap, null, -1);
        } else {
            // Normal mode: use connectivity checks
            is_protein = isRealAminoAcid(residue, modresMap, chemCompMap, allResidues, idx);
            nucleicType = isRealNucleicAcid(residue, modresMap, chemCompMap, allResidues, idx);
        }
        // Whether it IS a nucleotide is per residue; which KIND it is falls
        // back to the chain when the residue itself gave no evidence. A
        // residue that did keep its own answer, so a genuine chimera - the
        // deoxyadenosine in 1VQ8's CCdA-p-Puro inhibitor - survives intact.
        if (nucleicType && !nucleicSugarVote(residue.resName, residue)
            && chainNucleic.has(residue.chain)) {
            nucleicType = chainNucleic.get(residue.chain);
        }

        if (is_protein) {
            // Use cached CA atom instead of .find()
            const ca = residue.caAtom || residue.atoms.find(a => a.atomName === 'CA');
            if (ca) {
                const newIndex = coords.length;
                coords.push([ca.x, ca.y, ca.z]);
                plddts.push(normalizePlddt(ca.b));
                position_chains.push(ca.chain);
                position_types.push('P');
                residues.push(ca.res_name || ca.resName || residue.resName);
                residue_numbers.push(ca.res_seq || ca.resSeq || residue.resSeq);
                sidechainEntries.push({ pos: newIndex, residue });

                // Map serial/ID to new index
                if (ca.serial !== undefined) atomSerialToIndex.set(ca.serial, newIndex);
                // Map ID for CIF resolution
                const idKey = `${ca.chain}:${ca.resSeq}:${ca.atomName}`;
                atomIdToIndex.set(idKey, newIndex);
            }
        } else if (nucleicType) {
            // Use cached C4' atom instead of .find()
            const c4_atom = residue.c4Atom || residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
            if (c4_atom) {
                const newIndex = coords.length;
                coords.push([c4_atom.x, c4_atom.y, c4_atom.z]);
                plddts.push(normalizePlddt(c4_atom.b));
                position_chains.push(c4_atom.chain);
                position_types.push(nucleicType);
                residues.push(c4_atom.res_name || c4_atom.resName || residue.resName);
                residue_numbers.push(c4_atom.res_seq || c4_atom.resSeq || residue.resSeq);

                // Map serial/ID to new index
                if (c4_atom.serial !== undefined) atomSerialToIndex.set(c4_atom.serial, newIndex);
                // Map ID for CIF resolution
                const idKey = `${c4_atom.chain}:${c4_atom.resSeq}:${c4_atom.atomName}`;
                atomIdToIndex.set(idKey, newIndex);
            }
        } else if (includeAllResidues || residue.record === 'HETATM') {
            // If includeAllResidues is true, include everything (even unclassified residues)
            // Otherwise, only include HETATM records as ligands
            // For ligands or unclassified residues, use all non-H atoms (like Python code)
            for (const atom of residue.atoms) {
                if (atom.element !== 'H' && atom.element !== 'D') {
                    const newIndex = coords.length;
                    coords.push([atom.x, atom.y, atom.z]);
                    plddts.push(normalizePlddt(atom.b));
                    position_chains.push(atom.chain);
                    position_types.push('L');
                            residues.push(atom.res_name || atom.resName || residue.resName);
                    residue_numbers.push(atom.res_seq || atom.resSeq || residue.resSeq);

                    // Map serial/ID to new index
                    if (atom.serial !== undefined) atomSerialToIndex.set(atom.serial, newIndex);
                    // Map ID for CIF resolution
                    const idKey = `${atom.chain}:${atom.resSeq}:${atom.atomName}`;
                    atomIdToIndex.set(idKey, newIndex);
                }
            }
        }
    }

    // Resolve explicit bonds
    const bonds = [];

    // 1. Process PDB CONECT records
    if (conectMap && conectMap.size > 0) {
        const processedBonds = new Set(); // Track processed pairs to avoid duplicates

        for (const [serial1, bondedSerials] of conectMap.entries()) {
            const idx1 = atomSerialToIndex.get(serial1);
            if (idx1 === undefined) continue;

            for (const serial2 of bondedSerials) {
                const idx2 = atomSerialToIndex.get(serial2);
                if (idx2 === undefined) continue;

                // Sort indices to ensure unique key for undirected bond
                const minIdx = Math.min(idx1, idx2);
                const maxIdx = Math.max(idx1, idx2);
                const bondKey = `${minIdx}-${maxIdx}`;

                if (!processedBonds.has(bondKey)) {
                    bonds.push([minIdx, maxIdx]);
                    processedBonds.add(bondKey);
                }
            }
        }
    }

    // 2. Process CIF _struct_conn records
    if (structConn && structConn.length > 0) {
        const processedBonds = new Set();

        for (const conn of structConn) {
            const key1 = `${conn.chain1}:${conn.seq1}:${conn.atom1}`;
            const key2 = `${conn.chain2}:${conn.seq2}:${conn.atom2}`;

            const idx1 = atomIdToIndex.get(key1);
            const idx2 = atomIdToIndex.get(key2);

            if (idx1 !== undefined && idx2 !== undefined) {
                const minIdx = Math.min(idx1, idx2);
                const maxIdx = Math.max(idx1, idx2);
                const bondKey = `${minIdx}-${maxIdx}`;
                if (!processedBonds.has(bondKey)) {
                    bonds.push([minIdx, maxIdx]);
                    processedBonds.add(bondKey);
                }
            }
        }
    }

    // 3. Process explicit bonds from _chem_comp_bond (CIF component bonds)
    if (chemCompBondMap && chemCompBondMap.size > 0) {
        // Group atoms by residue unique ID (chain:resSeq:resName)
        // We need to map the original atom serial/ID to the *new* index in the coords array.
        // The `atomSerialToIndex` and `atomIdToIndex` maps already do this for the *final* positions.
        // However, the `chemCompBondMap` refers to atom names within a residue, not serials or IDs.
        // We need to map (resKey, atomName) -> newIndex.
        // The `resAtomIdToIndex` map was intended for this, but it's not populated.
        // Let's re-populate `resAtomIdToIndex` during the initial atom processing loop,
        // or create a new map here that links (resKey, atomName) to the final `coords` index.

        // Let's create a temporary map for this purpose, mapping (resKey, atomName) to the index in `coords`.
        // This requires iterating through the `allResidues` and their atoms again,
        // or modifying the initial loop to populate this map for *all* atoms that end up in `coords`.

        // For simplicity and to avoid re-looping all atoms, let's assume `resAtomIdToIndex`
        // should have been populated during the main loop where `coords` are built.
        // Since it wasn't, we need to reconstruct a similar mapping for the atoms that *made it into* `coords`.

        // A more robust way: iterate through the `allResidues` and their atoms,
        // and for each atom that was added to `coords`, store its (resKey, atomName) -> newIndex.
        const finalResidueAtomToIndex = new Map(); // Map<resKey, Map<atomName, finalCoordIndex>>

        // This requires re-iterating through the logic that populates `coords` to get the correct indices.
        // This is complex because `coords` indices are conditional.
        // A simpler approach is to use the `atomSerialToIndex` or `atomIdToIndex` if the original atoms
        // had unique identifiers that map to the final `coords` indices.

        // Given the current structure, the `atomIdToIndex` (chain:resSeq:atomName -> newIndex)
        // is the most suitable for resolving `chemCompBondMap` bonds.
        // The `chemCompBondMap` bonds are defined by `atom1` and `atom2` (atom names) within a `resName`.
        // So we need to find all atoms belonging to a specific residue (resName, chain, resSeq)
        // and then map their atom names to the `coords` index.

        // Let's iterate through the original `atoms` array to build a map of
        // (chain:resSeq:resName) -> Map(atomName -> originalAtomObject)
        // and then use `atomIdToIndex` to get the final `coords` index.

        // This is tricky because `chemCompBondMap` applies to *residues*, not individual atoms.
        // The `convertParsedToFrameData` function filters atoms and only adds certain ones to `coords`.
        // So we need to find the `coords` indices for the atoms specified in `chemCompBondMap` for a given residue.

        // Let's use the `residueMap` created earlier, which contains all atoms for each residue.
        // Then, for each atom in `residue.atoms`, we can check if it was added to `coords`
        // by looking it up in `atomIdToIndex`.

        const processedBonds = new Set(); // To avoid duplicate bonds from this source

        for (const [resKey, residue] of residueMap.entries()) {
            const resName = residue.resName;
            if (chemCompBondMap.has(resName)) {
                const bondsInComp = chemCompBondMap.get(resName);
                for (const bondDef of bondsInComp) {
                    const atomName1 = bondDef.atom1;
                    const atomName2 = bondDef.atom2;

                    // Find the indices in `coords` for these two atoms within this residue
                    const idKey1 = `${residue.chain}:${residue.resSeq}:${atomName1}`;
                    const idKey2 = `${residue.chain}:${residue.resSeq}:${atomName2}`;

                    const idx1 = atomIdToIndex.get(idKey1);
                    const idx2 = atomIdToIndex.get(idKey2);

                    if (idx1 !== undefined && idx2 !== undefined) {
                        const minIdx = Math.min(idx1, idx2);
                        const maxIdx = Math.max(idx1, idx2);
                        const bondKey = `${minIdx}-${maxIdx}`;

                        if (!processedBonds.has(bondKey)) {
                            bonds.push([minIdx, maxIdx]);
                            processedBonds.add(bondKey);
                        }
                    }
                }
            }
        }
    }

    const result = { coords, atomIdToIndex };

    if (bonds.length > 0) {
        result.bonds = bonds;
    }

    if (position_types.length > 0) {
        result.position_types = position_types;
    }
    // Include plddts if at least one value is not NaN
    // Note: 0 is a valid pLDDT value, so we only exclude if all are NaN
    // Assume pLDDT values are always in 0-100 range
    if (plddts.length > 0 && plddts.some(v => !isNaN(v))) {
        result.plddts = plddts;
    } else if (plddts.length > 0) {
        // If we have plddts array but all are NaN, still include it
        // (might be useful for debugging or default values)
        // But only if we actually tried to extract plddts (array is not empty)
        console.warn('All pLDDT values are NaN - B-factor column may be empty in PDB file');
    }

    if (position_chains.length > 0) {
        result.chains = position_chains;
    }
    if (residues.some(r => r && r.trim())) {
        result.position_names = residues;
    }
    if (residue_numbers.some(i => !isNaN(i))) {
        result.residue_numbers = residue_numbers;
    }

    const sidechains = buildSidechainTable(coords, sidechainEntries);
    if (sidechains) {
        result.sidechains = sidechains;
    }

    return result;
}

/**
 * Filter PAE matrix to remove ligand positions
 * @param {Array<Array<number>>} paeData - Original PAE matrix
 * @param {Array<boolean>} isLigandPosition - Boolean array indicating ligand positions
 * @returns {Array<Array<number>>} - Filtered PAE matrix
 */
function filterPAEForLigands(paeData, isLigandPosition) {
    if (!paeData || !isLigandPosition || isLigandPosition.length === 0) {
        // If TypedArray, return copy
        if (paeData && paeData.slice) return paeData.slice();
        return paeData ? paeData.map(row => [...row]) : null;
    }

    // Handle TypedArray (flat)
    if (paeData.buffer) {
        const n = Math.sqrt(paeData.length);
        // Calculate new size
        let newN = 0;
        for (let i = 0; i < isLigandPosition.length; i++) {
            if (!isLigandPosition[i]) newN++;
        }

        // If no ligands to filter, return copy
        if (newN === n) return paeData.slice();

        const filtered = new paeData.constructor(newN * newN);
        let r = 0;
        for (let i = 0; i < n; i++) {
            if (!isLigandPosition[i]) {
                let c = 0;
                for (let j = 0; j < n; j++) {
                    if (!isLigandPosition[j]) {
                        filtered[r * newN + c] = paeData[i * n + j];
                        c++;
                    }
                }
                r++;
            }
        }
        return filtered;
    }

    // Handle Array of Arrays (legacy)
    const filteredPae = [];
    for (let rowIdx = 0; rowIdx < paeData.length; rowIdx++) {
        if (!isLigandPosition[rowIdx]) {
            const filteredRow = [];
            for (let colIdx = 0; colIdx < paeData[rowIdx].length; colIdx++) {
                if (!isLigandPosition[colIdx]) {
                    filteredRow.push(paeData[rowIdx][colIdx]);
                }
            }
            filteredPae.push(filteredRow);
        }
    }
    return filteredPae;
}

/**
 * Fast extraction of PAE data from JSON text without full parsing.
 * Looks for "predicted_aligned_error": [[...]] pattern.
 * @param {string} text - JSON text
 * @returns {Uint8Array|null} - Flattened PAE matrix as Uint8Array or null
 */
function fastExtractPaeFromText(text) {
    if (!text) return null;

    // Find start of predicted_aligned_error
    // We look for "predicted_aligned_error" followed by optional whitespace and colon and [[
    const match = /"predicted_aligned_error"\s*:\s*\[\s*\[/.exec(text);
    if (!match) return null;

    const startIdx = match.index + match[0].length - 1; // Point to the first [ of [[

    // We need to parse the array of arrays.
    // Since we want to avoid full JSON parse, we can try to extract just this section.
    // However, counting brackets is safer.

    let bracketCount = 0;
    let endIdx = -1;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < text.length; i++) {
        const char = text[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (char === '\\') {
            escape = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === '[') {
                bracketCount++;
            } else if (char === ']') {
                bracketCount--;
                if (bracketCount === 0) {
                    endIdx = i + 1;
                    break;
                }
            }
        }
    }

    if (endIdx === -1) return null;

    const paeJson = text.substring(startIdx, endIdx);

    try {
        // Parse just the matrix part
        const paeMatrix = JSON.parse(paeJson);
        return flattenPaeToArray(paeMatrix);
    } catch (e) {
        console.warn("Fast PAE parse failed, falling back", e);
        return null;
    }
}

/**
 * Helper to flatten and scale PAE matrix to Uint8Array
 */
function flattenPaeToArray(paeMatrix) {
    if (!Array.isArray(paeMatrix) || paeMatrix.length === 0) return null;

    const n = paeMatrix.length;
    const totalSize = n * n;
    const flattened = new Uint8Array(totalSize);

    for (let i = 0; i < n; i++) {
        const row = paeMatrix[i];
        if (!Array.isArray(row)) return null; // Should be square matrix

        const rowLen = row.length;
        const len = Math.min(n, rowLen);

        for (let j = 0; j < len; j++) {
            // Scale: val * 8 (max 31.75 * 8 = 254)
            // Clamp to 0-255
            let val = Math.round(row[j] * 8);
            if (val > 255) val = 255;
            if (val < 0) val = 0;
            flattened[i * n + j] = val;
        }
    }
    return flattened;
}

/**
 * Extract PAE matrix from JSON object and flatten it to Uint8Array
 * @param {object} json - PAE JSON data
 * @returns {Uint8Array|null} - Flattened PAE matrix or null
 */
function extractPaeFromJSON(json) {
    try {
        // 1. Check for pre-extracted format (our optimization)
        if (json.is_pae_extracted && json.data) {
            if (json.data instanceof Uint8Array) {
                return json.data;
            }
            return new Uint8Array(json.data);
        }

        let paeMatrix = null;

        // 2. Standard AlphaFold format: [{ "predicted_aligned_error": [[...]] }]
        if (Array.isArray(json) && json.length > 0 && json[0].predicted_aligned_error) {
            paeMatrix = json[0].predicted_aligned_error;
        }
        // 3. Object format: { "predicted_aligned_error": [[...]] }
        else if (json.predicted_aligned_error) {
            paeMatrix = json.predicted_aligned_error;
        }
        // 4. "pae" key format (some variations)
        else if (json.pae) {
            paeMatrix = json.pae;
        }

        if (!paeMatrix) {
            // It might be that 'json' IS the matrix (array of arrays)
            if (Array.isArray(json) && json.length > 0 && Array.isArray(json[0])) {
                // Heuristic: check if it looks like a square matrix of numbers
                if (json.length === json[0].length && typeof json[0][0] === 'number') {
                    paeMatrix = json;
                }
            }
        }

        if (!paeMatrix) {
            // console.warn("Could not find PAE matrix in JSON.");
            return null;
        }

        return flattenPaeToArray(paeMatrix);

    } catch (e) {
        console.error("Error extracting PAE matrix:", e);
        return null;
    }
}
/**
 * Clean object name by removing file extensions
 * @param {string} name - Original name
 * @returns {string} - Cleaned name
 */
function cleanObjectName(name) {
    return name.replace(/\.(cif|pdb|ent|zip)$/i, '');
}

/**
 * Extract ligand bonds using distance-based method
 * Uses atomic coordinates to determine which atoms are bonded
 * @param {Array<object>} atoms - Parsed atoms (filtered, matching frameData)
 * @param {object} frameData - Frame data with position_types, coords
 * @returns {Array<Array>} - Array of bonds [[idx1, idx2], ...]
 */
function extractLigandBondsFromAtoms(atoms, frameData) {
    const bonds = [];

    if (!frameData || !frameData.position_types || !frameData.coords || atoms.length === 0) {
        return bonds;
    }

    const { position_types, coords, atomIdToIndex } = frameData;

    // Build a map: residue -> list of (atom, posIndex) for atoms in that residue
    const residueMap = new Map();

    // If we don't have atomIdToIndex, we can't reliably map atoms to frame data
    if (!atomIdToIndex) {
        return bonds;
    }


    for (const atom of atoms) {
        if (atom.resName === 'HOH') continue;

        // Find the index of this atom in the frame data
        const idKey = `${atom.chain}:${atom.resSeq}:${atom.atomName}`;
        const posIndex = atomIdToIndex.get(idKey);

        if (posIndex === undefined) {
            // Atom was filtered out (e.g. protein sidechain atom not in CA-only model)
            continue;
        }


        const resKey = atom.chain + ':' + atom.resSeq + ':' + atom.resName;
        if (!residueMap.has(resKey)) {
            residueMap.set(resKey, []);
        }
        residueMap.get(resKey).push({ atom, posIndex: posIndex });
    }


    // Extract bonds for each residue using distance-based method
    const processedBonds = new Set(); // Prevent duplicates


    // Element-specific bond distance thresholds (in Å)
    // Based on typical covalent bond lengths + tolerance
    const getBondDistanceThreshold = (elem1, elem2) => {
        // Normalize element names to uppercase
        const e1 = (elem1 || '').toUpperCase();
        const e2 = (elem2 || '').toUpperCase();

        // Sort elements alphabetically for consistent lookup
        const [elemA, elemB] = e1 < e2 ? [e1, e2] : [e2, e1];
        const pair = `${elemA}-${elemB}`;

        // Common bond type maxima (with ~15% tolerance)
        const bondThresholds = {
            'C-C': 1.8,   // Single: 1.54, Double: 1.34, Triple: 1.20
            'C-N': 1.7,   // Single: 1.47, Double: 1.27, Triple: 1.16
            'C-O': 1.65,  // Single: 1.43, Double: 1.20
            'C-S': 2.1,   // Single: 1.82
            'C-P': 2.1,   // Single: 1.84
            'N-N': 1.7,   // Single: 1.45, Double: 1.25
            'N-O': 1.6,   // Single: 1.40
            'N-S': 2.0,   // Single: 1.68
            'O-O': 1.7,   // Single: 1.48
            'O-S': 2.0,   // Single: 1.70
            'O-P': 1.9,   // Single: 1.63
            'S-S': 2.4,   // Single: 2.05 (disulfide bonds!)
            'P-P': 2.5,   // Single: 2.21
            // Metal-ligand bonds (typically longer)
            'C-FE': 2.5, 'C-ZN': 2.5, 'C-MG': 2.5, 'C-CA': 2.8,
            'N-FE': 2.5, 'N-ZN': 2.5, 'N-MG': 2.5, 'N-CA': 2.8,
            'O-FE': 2.5, 'O-ZN': 2.5, 'O-MG': 2.5, 'O-CA': 2.8,
            'S-FE': 2.8, 'S-ZN': 2.8, 'S-MG': 2.8, 'S-CA': 3.0,
        };

        // Return specific threshold if found, otherwise use conservative default
        return bondThresholds[pair] || 2.0;
    };

    for (const [resKey, atomsInResidue] of residueMap) {
        // Only process ligand atoms
        const ligandAtoms = atomsInResidue.filter(a =>
            position_types[a.posIndex] === 'L' &&
            a.atom.element !== 'H' && a.atom.element !== 'D'
        );

        if (ligandAtoms.length > 1) {
            for (let i = 0; i < ligandAtoms.length; i++) {
                for (let j = i + 1; j < ligandAtoms.length; j++) {
                    const atom1 = ligandAtoms[i].atom;
                    const atom2 = ligandAtoms[j].atom;
                    const idx1 = ligandAtoms[i].posIndex;
                    const idx2 = ligandAtoms[j].posIndex;

                    // Calculate distance between atoms
                    const dx = atom1.x - atom2.x;
                    const dy = atom1.y - atom2.y;
                    const dz = atom1.z - atom2.z;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                    // Get element-specific bond distance threshold
                    const threshold = getBondDistanceThreshold(atom1.element, atom2.element);

                    // Check if distance is within bonding range (min 0.9 Å to avoid overlapping atoms)
                    if (0.9 < dist && dist < threshold) {
                        const minIdx = Math.min(idx1, idx2);
                        const maxIdx = Math.max(idx1, idx2);
                        const bondKey = minIdx + ',' + maxIdx;

                        if (!processedBonds.has(bondKey)) {
                            bonds.push([minIdx, maxIdx]);
                            processedBonds.add(bondKey);
                        }
                    }
                }
            }
        }
    }
    return bonds;
}

// ============================================================================
// BIOLOGICAL ASSEMBLY PARSING
// ============================================================================

// Lightweight CIF tokenizer
function tokenizeCIFLine_light(s) {
    const out = [];
    let i = 0;
    const n = s.length;

    while (i < n) {
        // Faster whitespace skipping - avoid regex test
        while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || s[i] === '\n')) i++;
        if (i >= n) break;

        if (s[i] === "'") {
            let j = ++i;
            while (j < n && s[j] !== "'") j++;
            out.push(s.slice(i, j));
            i = Math.min(j + 1, n);
        } else if (s[i] === '"') {
            let j = ++i;
            while (j < n && s[j] !== '"') j++;
            out.push(s.slice(i, j));
            i = Math.min(j + 1, n);
        } else {
            let j = i;
            // Faster non-whitespace check - avoid regex test
            while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\r' && s[j] !== '\n') j++;
            const tok = s.slice(i, j);
            out.push(tok === '.' || tok === '?' ? '' : tok);
            i = j;
        }
    }
    return out;
}

function parseMinimalCIF_light(text) {
    const lines = text.split(/\r?\n/);
    const loops = [];
    let i = 0;
    let loopCount = 0;
    let rowCount = 0;

    while (i < lines.length) {
        let L = lines[i].trim();
        if (!L || L[0] === '#') {
            i++;
            continue;
        }

        if (/^loop_/i.test(L)) {
            i++;
            const cols = [];
            const rows = [];

            while (i < lines.length && /^\s*_/.test(lines[i])) {
                cols.push(lines[i].trim());
                i++;
            }

            while (i < lines.length) {
                const raw = lines[i];
                if (!raw || /^\s*#/.test(raw) || /^\s*loop_/i.test(raw) ||
                    /^\s*data_/i.test(raw) || /^\s*_/.test(raw)) break;

                let vals = tokenizeCIFLine_light(raw);
                while (vals.length < cols.length && i + 1 < lines.length) {
                    const more = tokenizeCIFLine_light(lines[++i]);
                    vals = vals.concat(more);
                }

                if (vals.length >= cols.length) {
                    rows.push(vals.slice(0, cols.length));
                    rowCount++;
                }
                i++;
            }
            loops.push([cols, rows]);
            loopCount++;
            continue;
        }
        i++;
    }
    return loops;
}

function expandOperExpr_light(expr) {
    if (!expr) return [];
    expr = expr.replace(/\s+/g, '');

    function splitTop(s, sep) {
        const out = [];
        let depth = 0;
        let last = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (depth === 0 && c === sep) {
                out.push(s.slice(last, i));
                last = i + 1;
            }
        }
        out.push(s.slice(last));
        return out.filter(Boolean);
    }

    const parts = splitTop(expr, ',');
    const seqs = [];

    for (const p of parts) {
        const groups = splitTop(p, 'x');
        let expanded = groups.map(term => {
            if (term.startsWith('(') && term.endsWith(')')) {
                term = term.slice(1, -1);
            }
            const m = term.match(/^(\d+)-(\d+)$/);
            if (/^\d+$/.test(term)) return [term];
            if (m) {
                const a = +m[1], b = +m[2];
                const out = [];
                const step = a <= b ? 1 : -1;
                for (let k = a; step > 0 ? k <= b : k >= b; k += step) {
                    out.push(String(k));
                }
                return out;
            }
            return term.split(',').filter(Boolean);
        });

        let acc = expanded[0].map(x => [x]);
        for (let i = 1; i < expanded.length; i++) {
            const next = [];
            for (const a of acc) {
                for (const x of expanded[i]) {
                    next.push(a.concat([x]));
                }
            }
            acc = next;
        }
        seqs.push(...acc);
    }
    return seqs;
}

function applyOp_light(atom, R, t) {
    return {
        ...atom,
        x: R[0] * atom.x + R[1] * atom.y + R[2] * atom.z + t[0],
        y: R[3] * atom.x + R[4] * atom.y + R[5] * atom.z + t[1],
        z: R[6] * atom.x + R[7] * atom.y + R[8] * atom.z + t[2]
    };
}

/**
 * Parse first biological assembly from PDB/CIF text
 * @param {string} text - Structure file content
 * @returns {object} - {atoms, meta}
 */
// ============================================================================
// UNIFIED BIOUNIT OPERATION EXTRACTION
// ============================================================================

/**
 * Extract biounit operations from PDB REMARK 350
 * @param {string} text - PDB file text
 * @returns {Array<object>|null} - Array of {id, R, t, chains} operations or null
 */
function extractPDBBiounitOperations(text) {
    // Fast-negative: no REMARK 350? no biounit.
    if (!/REMARK 350/.test(text)) return null;
    const lines = text.split(/\r?\n/);

    let inTargetBio = false;
    const targetBioId = 1;
    const chains = new Set();
    const opRows = {};

    for (const L of lines) {
        if (!L.startsWith('REMARK 350')) continue;

        if (/REMARK 350\s+BIOMOLECULE:\s*(\d+)/.test(L)) {
            const id = parseInt(L.match(/REMARK 350\s+BIOMOLECULE:\s*(\d+)/)[1], 10);
            inTargetBio = (id === targetBioId);
            continue;
        }

        if (!inTargetBio) continue;

        if (/:/.test(L) && /(APPLY THE FOLLOWING TO|AND|ALSO)\s+CHAIN[S]?:/i.test(L)) {
            const after = L.split(':')[1] || '';
            after.split(/[, ]+/)
                .map(s => s.replace(/[^A-Za-z0-9]/g, '').trim())
                .filter(Boolean)
                .forEach(c => chains.add(c));
            continue;
        }

        if (/REMARK 350\s+BIOMT[123]/.test(L)) {
            const rowChar = L.substring(18, 19);
            const rowNum = parseInt(rowChar, 10);
            const opIdx = parseInt(L.substring(19, 24), 10);
            if (!(rowNum >= 1 && rowNum <= 3) || isNaN(opIdx)) continue;

            const a1 = parseFloat(L.substring(23, 33));
            const a2 = parseFloat(L.substring(33, 43));
            const a3 = parseFloat(L.substring(43, 53));
            const t = parseFloat(L.substring(53, 68));
            if ([a1, a2, a3, t].some(v => Number.isNaN(v))) continue;

            const row = [a1, a2, a3, t];
            opRows[opIdx] = opRows[opIdx] || [null, null, null];
            opRows[opIdx][rowNum - 1] = row;
        }
    }

    const ops = [];
    Object.keys(opRows).forEach(k => {
        const r = opRows[k];
        if (r[0] && r[1] && r[2]) {
            const R = [
                r[0][0], r[0][1], r[0][2],
                r[1][0], r[1][1], r[1][2],
                r[2][0], r[2][1], r[2][2]
            ];
            const t = [r[0][3], r[1][3], r[2][3]];
            ops.push({ id: String(k), R, t, chains: [...chains] });
        }
    });

    return ops.length > 0 ? ops : null;
}

/**
 * Multiply two rotation matrices: Rb * Ra
 * @param {Array<number>} Rb - 9-element rotation matrix
 * @param {Array<number>} Ra - 9-element rotation matrix
 * @returns {Array<number>} - 9-element rotation matrix
 */
function multiplyRotationMatrices(Rb, Ra) {
    return [
        Rb[0] * Ra[0] + Rb[1] * Ra[3] + Rb[2] * Ra[6],
        Rb[0] * Ra[1] + Rb[1] * Ra[4] + Rb[2] * Ra[7],
        Rb[0] * Ra[2] + Rb[1] * Ra[5] + Rb[2] * Ra[8],
        Rb[3] * Ra[0] + Rb[4] * Ra[3] + Rb[5] * Ra[6],
        Rb[3] * Ra[1] + Rb[4] * Ra[4] + Rb[5] * Ra[7],
        Rb[3] * Ra[2] + Rb[4] * Ra[5] + Rb[5] * Ra[8],
        Rb[6] * Ra[0] + Rb[7] * Ra[3] + Rb[8] * Ra[6],
        Rb[6] * Ra[1] + Rb[7] * Ra[4] + Rb[8] * Ra[7],
        Rb[6] * Ra[2] + Rb[7] * Ra[5] + Rb[8] * Ra[8],
    ];
}

/**
 * Multiply rotation matrix by translation vector: R * t
 * @param {Array<number>} R - 9-element rotation matrix
 * @param {Array<number>} t - 3-element translation vector
 * @returns {Array<number>} - 3-element translation vector
 */
function multiplyRotationByTranslation(R, t) {
    return [
        R[0] * t[0] + R[1] * t[1] + R[2] * t[2],
        R[3] * t[0] + R[4] * t[1] + R[5] * t[2],
        R[6] * t[0] + R[7] * t[1] + R[8] * t[2],
    ];
}

/**
 * Compose a sequence of biounit operations
 * @param {Array<string>} seq - Sequence of operator IDs
 * @param {Map} opMap - Map of operator ID to {R, t}
 * @returns {object} - Composed {R, t}
 */
function composeBiounitOperations(seq, opMap) {
    // Apply operators left-to-right: x' = O_n(...O_2(O_1(x))...)
    let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let t = [0, 0, 0];
    for (const id of seq) {
        const op = opMap.get(id) || opMap.get('1');
        if (!op) continue;
        const Rb = op.R, tb = op.t;
        // new = Rb * (R*x + t) + tb = (Rb*R) x + (Rb*t + tb)
        const R_new = multiplyRotationMatrices(Rb, R);
        const Rt = multiplyRotationByTranslation(Rb, t);
        const t_new = [Rt[0] + tb[0], Rt[1] + tb[1], Rt[2] + tb[2]];
        R = R_new;
        t = t_new;
    }
    return { R, t };
}

/**
 * Extract biounit operations from CIF file
 * @param {string} text - CIF file text
 * @returns {Array<object>|null} - Array of {id, R, t, chains} operations or null
 */
function extractCIFBiounitOperations(text, cachedLoops = null) {
    // Fast-negative: require both loops to be present
    if (!/_pdbx_struct_assembly_gen\./.test(text) || !/_pdbx_struct_oper_list\./.test(text)) {
        return null;
    }

    let loops;
    if (cachedLoops) {
        // Use cached loops if provided
        loops = cachedLoops;
    } else {
        // Parse all loops if not cached
        loops = parseMinimalCIF_light(text);
    }

    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));

    const asmL = getLoop('_pdbx_struct_assembly_gen.assembly_id');
    const operL = getLoop('_pdbx_struct_oper_list.id');

    if (!asmL) return null;

    // Build operator map {id -> {R,t}}
    const opMap = new Map();
    if (operL) {
        const opCols = operL[0];
        const opRows = operL[1];
        const o = (n) => opCols.indexOf(n);
        for (const r of opRows) {
            const id = (r[o('_pdbx_struct_oper_list.id')] || '').toString();
            const R = [
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][1]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][2]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][3]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][1]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][2]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][3]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][1]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][2]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][3]')])
            ];
            const t = [
                parseFloat(r[o('_pdbx_struct_oper_list.vector[1]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.vector[2]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.vector[3]')])
            ];
            if (Number.isFinite(R[0])) opMap.set(id, { R, t });
        }
    }
    if (opMap.size === 0) {
        opMap.set('1', { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
    }

    // Choose assembly 1 (or fall back to first row)
    const a = (n) => asmL[0].indexOf(n);
    let candidates = asmL[1].filter(r => (r[a('_pdbx_struct_assembly_gen.assembly_id')] || '') === '1');
    if (candidates.length === 0 && asmL[1].length > 0) candidates = [asmL[1][0]];
    if (candidates.length === 0) return null;

    const chainSet = new Set();
    const operations = [];
    const seenRT = new Set();

    for (const r of candidates) {
        const asymList = (r[a('_pdbx_struct_assembly_gen.asym_id_list')] ||
            r[a('_pdbx_struct_assembly_gen.oper_asym_id_list')] || '').toString();
        // Normalize chain IDs: trim whitespace and convert to string
        const asymIds = asymList.split(',').map(s => String(s).trim()).filter(Boolean);
        asymIds.forEach(c => chainSet.add(c));

        const operExpr = (r[a('_pdbx_struct_assembly_gen.oper_expression')] || '').toString();
        const seqs = (operExpr && typeof expandOperExpr_light === 'function')
            ? expandOperExpr_light(operExpr) : [['1']];

        for (const seq of seqs) {
            const { R, t } = composeBiounitOperations(seq, opMap);
            const key = R.map(v => Number.isFinite(v) ? v.toFixed(6) : 'nan').join(',') + '|' +
                t.map(v => Number.isFinite(v) ? v.toFixed(6) : 'nan').join(',');
            if (!seenRT.has(key)) {
                seenRT.add(key);
                operations.push({ id: seq.join('*') || '1', R, t, chains: [] });
            }
        }
    }

    const chains = [...chainSet];
    operations.forEach(op => op.chains = chains);
    return operations.length > 0 ? operations : null;
}

/**
 * Convenience wrapper to extract biounit operations from PDB or CIF
 * @param {string} text - File text
 * @param {boolean} isCIF - Whether file is CIF format
 * @returns {Array<object>|null} - Array of operations or null
 */
function extractBiounitOperations(text, isCIF, cachedLoops = null) {
    if (isCIF) {
        return extractCIFBiounitOperations(text, cachedLoops);
    } else {
        return extractPDBBiounitOperations(text);
    }
}

/**
 * Apply biounit operations to an array of atoms
 * @param {Array<object>} atoms - Array of atom objects
 * @param {Array<object>} operations - Array of {id, R, t, chains} operations
 * @returns {Array<object>} - Transformed atoms
 */
function applyBiounitOperationsToAtoms(atoms, operations) {
    if (!operations || operations.length === 0) return atoms;

    // Get chains from operations, or use all chains if none specified
    let targetChains = new Set();
    operations.forEach(op => {
        if (op.chains && op.chains.length > 0) {
            op.chains.forEach(c => targetChains.add(c));
        }
    });

    if (targetChains.size === 0) {
        // No chains specified, use all
        atoms.forEach(a => {
            if (a.chain) targetChains.add(a.chain);
        });
    }

    const out = [];
    for (const op of operations) {
        for (const atom of atoms) {
            if (targetChains.size === 0 || targetChains.has(atom.chain)) {
                const transformed = {
                    ...atom,
                    x: op.R[0] * atom.x + op.R[1] * atom.y + op.R[2] * atom.z + op.t[0],
                    y: op.R[3] * atom.x + op.R[4] * atom.y + op.R[5] * atom.z + op.t[1],
                    z: op.R[6] * atom.x + op.R[7] * atom.y + op.R[8] * atom.z + op.t[2],
                    chain: (op.id === '1') ?
                        String(atom.chain || '') :
                        (String(atom.chain || '') + '|' + op.id)
                };
                out.push(transformed);
            }
        }
    }

    return out.length > 0 ? out : atoms;
}

function parseFirstBioAssembly(text) {
    const isCIF = /^\s*data_/i.test(text) || /_atom_site\./i.test(text);
    return isCIF ? buildBioFromCIF(text) : buildBioFromPDB(text);
}

function buildBioFromPDB(text) {
    const parseResult = parsePDB(text);
    const models = parseResult.models;
    const atoms = (models && models[0]) ? models[0] : [];

    // Extract biounit operations using unified function
    const operations = extractPDBBiounitOperations(text);

    if (!operations || operations.length === 0) {
        return { atoms, meta: { source: 'pdb', assembly: 'asymmetric_unit' } };
    }

    // Collect chains from operations or atoms
    const chains = new Set();
    operations.forEach(op => {
        if (op.chains && op.chains.length > 0) {
            op.chains.forEach(c => chains.add(c));
        }
    });
    if (chains.size === 0) {
        for (const a of atoms) {
            if (a.chain) chains.add(a.chain);
        }
    }

    // Apply operations using unified function
    const out = applyBiounitOperationsToAtoms(atoms, operations);

    return {
        atoms: out,
        meta: {
            source: 'pdb',
            assembly: '1',
            ops: operations.length,
            chains: [...chains]
        }
    };
}

function buildBioFromCIF(text) {
    const loops = parseMinimalCIF_light(text);
    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));

    // Parse chemical component table to identify modified residues
    const chemCompMap = new Map();
    const chemCompL = getLoop('_chem_comp.id');
    if (chemCompL) {
        const chemCompCols = chemCompL[0], chemCompRows = chemCompL[1];
        const ccol_id = chemCompCols.indexOf('_chem_comp.id');
        const ccol_type = chemCompCols.indexOf('_chem_comp.type');
        const ccol_mon_nstd = chemCompCols.indexOf('_chem_comp.mon_nstd_flag');

        if (ccol_id >= 0 && ccol_type >= 0) {
            for (const row of chemCompRows) {
                const resName = row[ccol_id]?.trim();
                const type = row[ccol_type]?.trim();
                const mon_nstd = ccol_mon_nstd >= 0 ? row[ccol_mon_nstd]?.trim() : null;

                if (resName && type) {
                    // Map residue type: 'RNA linking' -> 'R', 'DNA linking' -> 'D', 'L-peptide linking' -> 'P'
                    let mappedType = null;
                    if (type.includes('RNA linking')) {
                        mappedType = 'R';
                    } else if (type.includes('DNA linking')) {
                        mappedType = 'D';
                    } else if (type.includes('peptide linking') || type.includes('L-peptide linking')) {
                        mappedType = 'P';
                    }

                    // Store: is it a modified (non-standard) residue?
                    // mon_nstd_flag = 'n' means non-standard (modified)
                    const isModified = mon_nstd === 'n' || mon_nstd === 'y' || mon_nstd === 'Y';
                    chemCompMap.set(resName, { type: mappedType, isModified, originalType: type });
                }
            }
        }
    }

    // Atom table
    const atomL = loops.find(([cols]) => cols.some(c => c.startsWith('_atom_site.')));
    if (!atomL) return { atoms: [], meta: { source: 'mmcif', assembly: 'empty' }, chemCompMap };

    const atomCols = atomL[0], atomRows = atomL[1];
    const acol = (n) => atomCols.indexOf(n);

    const ixX = acol('_atom_site.Cartn_x');
    const ixY = acol('_atom_site.Cartn_y');
    const ixZ = acol('_atom_site.Cartn_z');
    const ixEl = acol('_atom_site.type_symbol');
    const ixLA = acol('_atom_site.label_asym_id');
    const ixRes = (acol('_atom_site.label_comp_id') >= 0 ?
        acol('_atom_site.label_comp_id') : acol('_atom_site.auth_comp_id'));
    const ixSeq = (acol('_atom_site.label_seq_id') >= 0 ?
        acol('_atom_site.label_seq_id') : acol('_atom_site.auth_seq_id'));
    const ixNm = acol('_atom_site.label_atom_id');
    const ixGrp = acol('_atom_site.group_PDB');
    const ixB = acol('_atom_site.B_iso_or_equiv');

    const baseAtoms = atomRows.map(r => {
        // Always use label_asym_id (required by mmCIF spec for biounit operations)
        // Normalize: convert to string and trim whitespace
        const labelChain = (ixLA >= 0 ? String(r[ixLA] || '').trim() : '');
        return {
            record: r[ixGrp] || 'ATOM',
            atomName: r[ixNm] || '',
            resName: r[ixRes] || '',
            lchain: labelChain,
            chain: labelChain,
            resSeq: r[ixSeq] ? parseInt(r[ixSeq], 10) : 0,
            x: parseFloat(r[ixX]),
            y: parseFloat(r[ixY]),
            z: parseFloat(r[ixZ]),
            b: ixB >= 0 ? (parseFloat(r[ixB]) || 0.0) : 0.0,
            element: (r[ixEl] || '').toUpperCase()
        };
    });

    // Extract biounit operations using unified function
    const operations = extractCIFBiounitOperations(text);

    if (!operations || operations.length === 0) {
        return { atoms: baseAtoms, meta: { source: 'mmcif', assembly: 'asymmetric_unit' }, chemCompMap: chemCompMap };
    }

    // CIF-specific assembly: need to map operations to asym_id_list and apply with lchain filtering
    const asmL = getLoop('_pdbx_struct_assembly_gen.assembly_id');
    if (!asmL) {
        // Fallback: use unified application function
        const out = applyBiounitOperationsToAtoms(baseAtoms, operations);
        const chains = new Set();
        operations.forEach(op => {
            if (op.chains && op.chains.length > 0) {
                op.chains.forEach(c => chains.add(c));
            }
        });
        return {
            atoms: out,
            meta: {
                source: 'mmcif',
                assembly: '1',
                chains: [...chains]
            },
            chemCompMap: chemCompMap
        };
    }

    // Build operator map for composition
    const operL = getLoop('_pdbx_struct_oper_list.id');
    const opCols = operL ? operL[0] : [];
    const opRows = operL ? operL[1] : [];
    const o = (n) => opCols.indexOf(n);
    const opMap = new Map();
    for (const r of opRows) {
        const id = (r[o('_pdbx_struct_oper_list.id')] || '').toString();
        const R = [
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][1]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][2]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][3]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][1]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][2]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][3]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][1]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][2]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][3]')])
        ];
        const t = [
            parseFloat(r[o('_pdbx_struct_oper_list.vector[1]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.vector[2]')]),
            parseFloat(r[o('_pdbx_struct_oper_list.vector[3]')])
        ];
        if (Number.isFinite(R[0])) {
            opMap.set(id, { R, t });
        }
    }
    if (opMap.size === 0) {
        opMap.set('1', { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
    }

    // Choose assembly 1
    const a = (n) => asmL[0].indexOf(n);
    let candidates = asmL[1].filter(r =>
        (r[a('_pdbx_struct_assembly_gen.assembly_id')] || '') === '1');
    if (candidates.length === 0 && asmL[1].length > 0) {
        candidates = [asmL[1][0]];
    }
    if (candidates.length === 0) {
        return { atoms: baseAtoms, meta: { source: 'mmcif', assembly: 'asymmetric_unit' }, chemCompMap: chemCompMap };
    }

    // Assemble using CIF-specific logic (filter by lchain/asymIds)
    const out = [];
    const seen = new Set();
    for (const r of candidates) {
        const asymList = (r[a('_pdbx_struct_assembly_gen.asym_id_list')] ||
            r[a('_pdbx_struct_assembly_gen.oper_asym_id_list')] || '').toString();
        // Normalize chain IDs: trim whitespace and convert to string
        const asymIds = asymList.split(',').map(s => String(s).trim()).filter(Boolean);
        asymIds.forEach(c => seen.add(c));

        const expr = (r[a('_pdbx_struct_assembly_gen.oper_expression')] || '1').toString();
        const seqs = expandOperExpr_light(expr);
        const seqsUse = (seqs && seqs.length) ? seqs : [['1']];

        for (const seq of seqsUse) {
            const seqLabel = seq.join('x');
            const { R, t } = composeBiounitOperations(seq, opMap);

            for (const aAtom of baseAtoms) {
                // Match by label_asym_id (lchain) - asym_id_list contains label_asym_id values per mmCIF spec
                if (!asymIds.includes(aAtom.lchain)) continue;
                const ax = applyOp_light(aAtom, R, t);
                ax.chain = (seqLabel === '1') ?
                    String(aAtom.lchain || aAtom.chain || '') :
                    (String(aAtom.lchain || aAtom.chain || '') + '|' + seqLabel);
                out.push(ax);
            }
        }
    }

    return {
        atoms: out,
        meta: {
            source: 'mmcif',
            assembly: '1',
            chains: [...seen]
        },
        chemCompMap: chemCompMap
    };
}
// ============================================================================
// RESIDUE MAPPING UTILITIES
// ============================================================================

/**
 * Residue name to single-letter amino acid code mapping
 */
const RESIDUE_TO_AA = {
    ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLU: 'E', GLN: 'Q', GLY: 'G',
    HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S',
    THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', SEC: 'U', PYL: 'O',
    // common modified residues → canonical letters
    MSE: 'M', HSD: 'H', HSE: 'H', HID: 'H', HIE: 'H', HIP: 'H',
    // D-amino acids → the letter of their L counterpart, as PyMOL and gemmi do
    DAL: 'A', DAR: 'R', DSG: 'N', DAS: 'D', DCY: 'C', DGN: 'Q', DGL: 'E',
    DHI: 'H', DIL: 'I', DLE: 'L', DLY: 'K', MED: 'M', DPN: 'F', DPR: 'P',
    DSN: 'S', DTH: 'T', DTR: 'W', DTY: 'Y', DVA: 'V'
};

// Expose globally
if (typeof window !== 'undefined') {
    window.RESIDUE_TO_AA = RESIDUE_TO_AA;
}
