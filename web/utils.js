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
        
        if (line.startsWith('MODEL')) {
            if (currentModelAtoms.length > 0) {
                models.push(currentModelAtoms);
            }
            currentModelAtoms = [];
        }
        
        if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
            currentModelAtoms.push({
                record: line.substring(0, 6).trim(),
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
    
    // Store MODRES map globally for use in convertParsedToFrameData
    window._lastModresMap = modresMap;
    
    return { models, modresMap };
}

/**
 * Parse CIF (mmCIF) file into models
 * @param {string} text - CIF file content
 * @returns {Array<Array<object>>} - Array of models, each containing atoms
 */
function parseCIF(text) {
    
    // Parse chemical component table first (for modified residue detection)
    const loops = parseMinimalCIF_light(text);
    
    // Cache loops globally for biounit extraction to reuse
    window._lastCIFLoops = loops;
    
    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));
    
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
    
    // Store chemCompMap globally for use in convertParsedToFrameData
    window._lastChemCompMap = chemCompMap;
    
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
    const headerLen = headers.length;
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
        
        // Use faster tokenizer instead of regex for better performance
        const values = tokenizeCIFLine_light(line);
        if (!values || values.length < headerLen) continue;

        // Direct array access - much faster than function calls
        // Update modelID if needed
        if (idxModelID >= 0) {
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
        const resNameVal = idxResName >= 0 ? values[idxResName] : '';
        // Parse residue sequence number, handling missing values ("?") by falling back to auth_seq_id
        // Use label_seq_id (PDB numbering) for SIFTS mapping compatibility
        let resSeqVal = 0;
        if (idxResSeq >= 0) {
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
            record: idxRecord >= 0 ? values[idxRecord] : 'ATOM',
            atomName: idxAtomName >= 0 ? values[idxAtomName] : '',
            resName: resNameVal,
            chain: idxChain >= 0 ? values[idxChain] : '',
            resSeq: resSeqVal,
            x: idxX >= 0 ? (+values[idxX] || 0) : 0,
            y: idxY >= 0 ? (+values[idxY] || 0) : 0,
            z: idxZ >= 0 ? (+values[idxZ] || 0) : 0,
            b: idxB >= 0 ? (+values[idxB] || 0) : 0,
            element: idxElement >= 0 ? values[idxElement] : '',
            res_name: resNameVal, // Duplicate for compatibility
            res_seq: resSeqVal // Duplicate for compatibility
        };

        currentModelArray.push(atom);
        atomCount++;
    }
    
    const modelCount = modelMap.size;

    const result = Array.from(modelMap.keys())
        .sort((a, b) => a - b)
        .map(id => modelMap.get(id));
    
    // Attach cached loops to result for reuse
    result._cachedLoops = loops;
    
    return result;
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
 * @param {number} residueIndex - Index of current residue in allResidues array
 * @param {string} type - 'P' for protein, 'D' for DNA, 'R' for RNA
 * @returns {boolean} - True if residue is connected to at least one neighbor
 */
function isResidueConnected(residue, allResidues, residueIndex, type) {
    if (!residue || !residue.atoms || !allResidues || residueIndex < 0 || residueIndex >= allResidues.length) {
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
    
    // Check neighbors in the same chain
    // Look at previous and next residues in the same chain
    for (let i = Math.max(0, residueIndex - 2); i < Math.min(allResidues.length, residueIndex + 3); i++) {
        if (i === residueIndex) continue;
        
        const neighbor = allResidues[i];
        if (!neighbor || neighbor.chain !== residue.chain) continue;
        
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
 * @param {number} residueIndex - Index of current residue in allResidues array
 * @returns {boolean} - True if residue is a real amino acid
 */
function isRealAminoAcid(residue, modresMap = null, chemCompMap = null, allResidues = null, residueIndex = -1) {
    const resName = residue.resName;
    
    // 1. Check if it's a standard amino acid (always allowed, no connectivity check needed)
    if (STANDARD_AMINO_ACIDS.has(resName)) {
        return true;
    }
    
    // 2. Check common modifications dictionary (e.g., MSE->MET)
    const modifiedType = getModifiedResidueType(resName);
    if (modifiedType && modifiedType.type === 'P') {
        // Common modifications require connectivity check
        if (allResidues && residueIndex >= 0) {
            return isResidueConnected(residue, allResidues, residueIndex, 'P');
        }
        // If no allResidues provided, allow it (backward compatibility, but less strict)
        return true;
    }
    
    // 3. Check MODRES map (from PDB) - requires connectivity
    if (modresMap && modresMap.has(resName)) {
        const stdResName = modresMap.get(resName);
        if (STANDARD_AMINO_ACIDS.has(stdResName)) {
            // MODRES-defined modifications require connectivity check
            if (allResidues && residueIndex >= 0) {
                return isResidueConnected(residue, allResidues, residueIndex, 'P');
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
                if (allResidues && residueIndex >= 0) {
                    return isResidueConnected(residue, allResidues, residueIndex, 'P');
                }
                // If no allResidues provided, allow it (backward compatibility)
                return true;
            }
        }
    }
    
    // No other cases - return false (removed all "last resort" checks)
    return false;
}

/**
 * Check if a residue is a real nucleic acid (standard or modified)
 * Simplified: only canonical DNA/RNA + common modifications + MODRES/CIF-defined if connected
 * @param {object} residue - Residue object with resName, record, atoms
 * @param {Map} modresMap - MODRES mapping (from PDB)
 * @param {Map} chemCompMap - Chemical component map (from CIF)
 * @param {Array} allResidues - Array of all residue objects (for connectivity check)
 * @param {number} residueIndex - Index of current residue in allResidues array
 * @returns {string|null} - 'D' for DNA, 'R' for RNA, or null if not a real nucleic acid
 */
function isRealNucleicAcid(residue, modresMap = null, chemCompMap = null, allResidues = null, residueIndex = -1) {
    const resName = residue.resName;
    
    // 1. Check if it's a standard nucleic acid (always allowed, no connectivity check needed)
    if (STANDARD_NUCLEIC_ACIDS.has(resName)) {
        // Determine DNA vs RNA
        // DNA-specific codes: T (thymine), DA, DC, DG, DT, DI (deoxyinosine)
        // RNA-specific codes: U (uracil), A, C, G (when not prefixed with D), RA, RC, RG, RU
        if (resName === 'T' || resName.startsWith('D') || resName === 'DI') {
            return 'D';
        }
        // RNA codes: U, A, C, G (without D prefix), RA, RC, RG, RU, I (inosine, more common in RNA)
        return 'R';
    }
    
    // 2. Check common modifications dictionary - requires connectivity
    const modifiedType = getModifiedResidueType(resName);
    if (modifiedType && (modifiedType.type === 'D' || modifiedType.type === 'R')) {
        // Common modifications require connectivity check
        if (allResidues && residueIndex >= 0) {
            if (isResidueConnected(residue, allResidues, residueIndex, modifiedType.type)) {
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
            // Determine DNA vs RNA
            let nucleicType;
            if (stdResName === 'T' || stdResName.startsWith('D') || stdResName === 'DI') {
                nucleicType = 'D';
            } else {
                nucleicType = 'R';
            }
            // MODRES-defined modifications require connectivity check
            if (allResidues && residueIndex >= 0) {
                if (isResidueConnected(residue, allResidues, residueIndex, nucleicType)) {
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
                if (allResidues && residueIndex >= 0) {
                    if (isResidueConnected(residue, allResidues, residueIndex, compInfo.type)) {
                        return compInfo.type;
                    }
                    return null;  // Not connected
                }
                // If no allResidues provided, allow it (backward compatibility)
                return compInfo.type;
            }
        }
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
        'MSE': {type: 'P', parent: 'MET'}, // Selenomethionine (most common)
        'PTR': {type: 'P', parent: 'TYR'}, // Phosphotyrosine
        'SEP': {type: 'P', parent: 'SER'}, // Phosphoserine
        'TPO': {type: 'P', parent: 'THR'}, // Phosphothreonine
        'FME': {type: 'P', parent: 'MET'}, // N-formylmethionine
        'HYP': {type: 'P', parent: 'PRO'}, // 4-hydroxyproline
        'PCA': {type: 'P', parent: 'GLU'}, // Pyroglutamic acid
        'ALY': {type: 'P', parent: 'LYS'}, // N-acetyllysine
        // Common modified nucleotides (DNA)
        '5MDA': {type: 'D', parent: 'DA'}, // 5-methyldeoxyadenosine
        '5MDC': {type: 'D', parent: 'DC'}, // 5-methyldeoxycytidine
        '5MDG': {type: 'D', parent: 'DG'}, // 5-methyldeoxyguanosine
        // Common modified nucleotides (RNA)
        'M6A': {type: 'R', parent: 'A'}, // N6-methyladenosine
        'M5C': {type: 'R', parent: 'C'}, // 5-methylcytidine
        'M7G': {type: 'R', parent: 'G'}, // 7-methylguanosine
        'PSU': {type: 'R', parent: 'U'}  // Pseudouridine
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
 * Group ligand atoms into ligand groups based on chain, residue_index, and residue_name
 * @param {Array<string>} chains - Array of chain IDs for each position
 * @param {Array<string>} atomTypes - Array of position types ('P', 'D', 'R', 'L')
 * @param {Array<number>} residueIndex - Array of position indices (optional)
 * @param {Array<string>} residues - Array of position names (optional)
 * @returns {Map<string, Array<number>>} - Map of ligand group keys to arrays of position indices
 * 
 * Grouping priority:
 * 1. If residue_name available: "chain:resSeq:resName"
 * 2. If only residue_index available: "chain:resSeq"
 * 3. If neither available: "chain:firstAtomIndex" (groups consecutive atoms)
 */
function groupLigandAtoms(chains, atomTypes, residueIndex, residues) {
    const ligandGroups = new Map();
    
    if (!chains || !atomTypes || chains.length !== atomTypes.length) {
        return ligandGroups; // Return empty map if invalid data
    }
    
    const hasResidueIndex = residueIndex && residueIndex.length === chains.length;
    const hasResidues = residues && residues.length === chains.length;
    
    // Detect if residue_index appears to be default sequential values (1, 2, 3, ...)
    // This happens when residue_index was missing and defaults were created
    let isDefaultSequential = false;
    if (hasResidueIndex) {
        // Check if all values are strictly sequential starting from 1
        isDefaultSequential = residueIndex.every((val, idx) => val === idx + 1);
    }
    
    // For ligands, if residue_index is default sequential AND residues are missing or all 'UNK',
    // treat it as if residue_index is missing (use fallback grouping)
    const useFallbackGrouping = !hasResidueIndex || 
        (isDefaultSequential && (!hasResidues || residues.every(r => !r || r === 'UNK')));
    
    // If using fallback grouping, group ALL ligand atoms in each chain as one ligand
    if (useFallbackGrouping) {
        // Group by chain: all ligand atoms in same chain = one ligand group
        const chainLigandGroups = new Map(); // chain -> array of atom indices
        
        for (let i = 0; i < atomTypes.length; i++) {
            if (atomTypes[i] === 'L') {
                const chain = chains[i];
                if (!chainLigandGroups.has(chain)) {
                    chainLigandGroups.set(chain, []);
                }
                chainLigandGroups.get(chain).push(i);
            }
        }
        
        // Create group keys for each chain's ligand atoms
        for (const [chain, atomIndices] of chainLigandGroups) {
            if (atomIndices.length > 0) {
                // Use first atom index as the group key identifier
                const groupKey = createLigandGroupKey(chain, null, null, atomIndices[0]);
                ligandGroups.set(groupKey, atomIndices);
            }
        }
    } else {
        // Normal grouping: use residue_index and residue names when available
        for (let i = 0; i < atomTypes.length; i++) {
            if (atomTypes[i] === 'L') {
                const chain = chains[i];
                const resSeq = hasResidueIndex ? residueIndex[i] : null;
                const resName = hasResidues ? residues[i] : null;
                
                // Create group key based on available data
                let groupKey;
                if (resName && resName !== 'UNK') {
                    // Primary: use chain + resSeq + resName
                    groupKey = createLigandGroupKey(chain, resSeq, resName, i);
                } else if (resSeq !== undefined && resSeq !== null) {
                    // Secondary: use chain + resSeq
                    groupKey = createLigandGroupKey(chain, resSeq, null, i);
                } else {
                    // Should not happen if useFallbackGrouping is false, but handle gracefully
                    groupKey = createLigandGroupKey(chain, null, null, i);
                }
                
                // Add atom to ligand group
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
 * @returns {object} - Frame data with coords, and optional plddts, chains, position_types
 */
function convertParsedToFrameData(atoms, modresMap = null, chemCompMap = null, includeAllResidues = false) {
    const coords = [];
    const plddts = [];
    const position_chains = [];
    const position_types = [];
    const residues = [];
    const residue_index = [];
    
    // Use global MODRES map if not provided (for backward compatibility)
    if (!modresMap && typeof window !== 'undefined' && window._lastModresMap) {
        modresMap = window._lastModresMap;
    }
    
    // Use global CIF chemCompMap if not provided (for backward compatibility)
    if (!chemCompMap && typeof window !== 'undefined' && window._lastChemCompMap) {
        chemCompMap = window._lastChemCompMap;
    }

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

        if (is_protein) {
            // Use cached CA atom instead of .find()
            const ca = residue.caAtom || residue.atoms.find(a => a.atomName === 'CA');
            if (ca) {
                coords.push([ca.x, ca.y, ca.z]);
                plddts.push(ca.b);
                position_chains.push(ca.chain);
                position_types.push('P');
                residues.push(ca.res_name || ca.resName || residue.resName);
                residue_index.push(ca.res_seq || ca.resSeq || residue.resSeq);
            }
        } else if (nucleicType) {
            // Use cached C4' atom instead of .find()
            const c4_atom = residue.c4Atom || residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
            if (c4_atom) {
                coords.push([c4_atom.x, c4_atom.y, c4_atom.z]);
                plddts.push(c4_atom.b);
                position_chains.push(c4_atom.chain);
                position_types.push(nucleicType);
                residues.push(c4_atom.res_name || c4_atom.resName || residue.resName);
                residue_index.push(c4_atom.res_seq || c4_atom.resSeq || residue.resSeq);
            }
        } else if (includeAllResidues || residue.record === 'HETATM') {
            // If includeAllResidues is true, include everything (even unclassified residues)
            // Otherwise, only include HETATM records as ligands
            // For ligands or unclassified residues, use all non-H atoms (like Python code)
            for (const atom of residue.atoms) {
                if (atom.element !== 'H' && atom.element !== 'D') {
                    coords.push([atom.x, atom.y, atom.z]);
                    plddts.push(atom.b);
                    position_chains.push(atom.chain);
                    position_types.push('L');
                    residues.push(atom.res_name || atom.resName || residue.resName);
                    residue_index.push(atom.res_seq || atom.resSeq || residue.resSeq);
                }
            }
        }
    }

    const result = { coords };

    if (position_types.length > 0) {
        result.position_types = position_types;
    }
    if (plddts.some(p => !isNaN(p))) {
        result.plddts = plddts;
    }
    if (position_chains.some(c => c && c.trim())) {
        result.chains = position_chains;
    }
    if (residues.some(r => r && r.trim())) {
        result.position_names = residues;
    }
    if (residue_index.some(i => !isNaN(i))) {
        result.position_index = residue_index;
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
        return paeData ? paeData.map(row => [...row]) : null;
    }
    
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
 * Extract PAE matrix from JSON object
 * @param {object} paeJson - PAE JSON data
 * @returns {Array<Array<number>>|null} - PAE matrix or null
 */
function extractPaeFromJSON(paeJson, warnIfMissing = false) {
    if (!paeJson) return null;
    if (paeJson.pae && Array.isArray(paeJson.pae)) return paeJson.pae;
    if (paeJson.predicted_aligned_error && Array.isArray(paeJson.predicted_aligned_error)) {
        return paeJson.predicted_aligned_error;
    }
    if (Array.isArray(paeJson) && paeJson.length > 0 && paeJson[0].predicted_aligned_error) {
        return paeJson[0].predicted_aligned_error;
    }
    // Check for AlphaFold3 format: paeJson might have a nested structure
    if (paeJson.predicted_aligned_error && typeof paeJson.predicted_aligned_error === 'object') {
        // Try nested structure
        const nested = paeJson.predicted_aligned_error;
        if (nested.pae && Array.isArray(nested.pae)) return nested.pae;
        if (nested.predicted_aligned_error && Array.isArray(nested.predicted_aligned_error)) {
            return nested.predicted_aligned_error;
        }
    }
    if (warnIfMissing) {
        console.warn("Could not find PAE matrix in JSON.");
    }
    return null;
}

/**
 * Clean object name by removing file extensions
 * @param {string} name - Original name
 * @returns {string} - Cleaned name
 */
function cleanObjectName(name) {
    return name.replace(/\.(cif|pdb|ent|zip)$/i, '');
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
        Rb[0]*Ra[0] + Rb[1]*Ra[3] + Rb[2]*Ra[6],
        Rb[0]*Ra[1] + Rb[1]*Ra[4] + Rb[2]*Ra[7],
        Rb[0]*Ra[2] + Rb[1]*Ra[5] + Rb[2]*Ra[8],
        Rb[3]*Ra[0] + Rb[4]*Ra[3] + Rb[5]*Ra[6],
        Rb[3]*Ra[1] + Rb[4]*Ra[4] + Rb[5]*Ra[7],
        Rb[3]*Ra[2] + Rb[4]*Ra[5] + Rb[5]*Ra[8],
        Rb[6]*Ra[0] + Rb[7]*Ra[3] + Rb[8]*Ra[6],
        Rb[6]*Ra[1] + Rb[7]*Ra[4] + Rb[8]*Ra[7],
        Rb[6]*Ra[2] + Rb[7]*Ra[5] + Rb[8]*Ra[8],
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
        R[0]*t[0] + R[1]*t[1] + R[2]*t[2],
        R[3]*t[0] + R[4]*t[1] + R[5]*t[2],
        R[6]*t[0] + R[7]*t[1] + R[8]*t[2],
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
    let R = [1,0,0, 0,1,0, 0,0,1];
    let t = [0,0,0];
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
        // Check global cache first
        if (window._lastCIFLoops) {
            loops = window._lastCIFLoops;
        } else {
            // Parse all loops if not cached
            loops = parseMinimalCIF_light(text);
        }
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
        opMap.set('1', { R: [1,0,0, 0,1,0, 0,0,1], t: [0,0,0] });
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
            const key = R.map(v => Number.isFinite(v)? v.toFixed(6) : 'nan').join(',') + '|' +
                        t.map(v => Number.isFinite(v)? v.toFixed(6) : 'nan').join(',');
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
    
    // Store chemCompMap in a global or pass it through
    // For now, we'll attach it to the returned object so convertParsedToFrameData can use it
    window._lastChemCompMap = chemCompMap;

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