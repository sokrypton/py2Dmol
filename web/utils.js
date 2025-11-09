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
    const firstCoord = coords[0];
    const allSame = coords.every(c => 
        Math.abs(c[0] - firstCoord[0]) < 1e-10 &&
        Math.abs(c[1] - firstCoord[1]) < 1e-10 &&
        Math.abs(c[2] - firstCoord[2]) < 1e-10
    );
    if (allSame) {
        return currentRotation || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    }
    
    // Use Kabsch algorithm like Python best_view: kabsch(a_cent, a_cent, return_v=True)
    // This computes the eigenvectors of the covariance matrix
    const mu = mean3(coords);
    const centeredCoords = coords.map(c => [c[0] - mu[0], c[1] - mu[1], c[2] - mu[2]]);
    
    // Compute H = centeredCoords^T @ centeredCoords (covariance matrix)
    const H = numeric.dot(numeric.transpose(centeredCoords), centeredCoords);
    
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
            let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0;
            for (const c of centeredCoords) {
                const projX = R[0][0] * c[0] + R[0][1] * c[1] + R[0][2] * c[2];
                const projY = R[1][0] * c[0] + R[1][1] * c[1] + R[1][2] * c[2];
                sumX += projX;
                sumY += projY;
                sumX2 += projX * projX;
                sumY2 += projY * projY;
            }
            const n = centeredCoords.length;
            const meanX = sumX / n;
            const meanY = sumY / n;
            const varX = (sumX2 / n) - (meanX * meanX);
            const varY = (sumY2 / n) - (meanY * meanY);
            
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
 * Parse PDB file into models
 * @param {string} text - PDB file content
 * @returns {Array<Array<object>>} - Array of models, each containing atoms
 */
function parsePDB(text) {
    const models = [];
    let currentModelAtoms = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
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
    
    return models;
}

/**
 * Parse CIF (mmCIF) file into models
 * @param {string} text - CIF file content
 * @returns {Array<Array<object>>} - Array of models, each containing atoms
 */
function parseCIF(text) {
    // Parse chemical component table first (for modified residue detection)
    const loops = parseMinimalCIF_light(text);
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

    // Parse data
    for (const line of lines) {
        if (line.startsWith('_atom_site.')) {
            atomSiteLoop = true;
        } else if (atomSiteLoop && line.startsWith('#')) {
            atomSiteLoop = false;
        } else if (atomSiteLoop && !line.startsWith(';')) {
            const values = line.match(/(?:[^\s"']+|"([^"]*)"|'([^']*)')+/g);
            if (!values || values.length < headers.length) continue;

            const getString = (key) => values[headerMap[key]];
            const getFloat = (key) => parseFloat(values[headerMap[key]]);
            const getInt = (key) => parseInt(values[headerMap[key]]);

            const atomNameRaw = getString('_atom_site.label_atom_id');
            let atomName = atomNameRaw;
            if (atomName && atomName.length > 1 && atomName.startsWith("'") && atomName.endsWith("'")) {
                atomName = atomName.substring(1, atomName.length - 1);
            } else if (atomName && atomName.length > 1 && atomName.startsWith('"') && atomName.endsWith('"')) {
                atomName = atomName.substring(1, atomName.length - 1);
            }

            const atom = {
                record: getString('_atom_site.group_PDB'),
                atomName: atomName,
                resName: getString('_atom_site.label_comp_id'),
                chain: getString('_atom_site.auth_asym_id'),
                resSeq: getInt('_atom_site.auth_seq_id'),
                x: getFloat('_atom_site.Cartn_x'),
                y: getFloat('_atom_site.Cartn_y'),
                z: getFloat('_atom_site.Cartn_z'),
                b: getFloat('_atom_site.B_iso_or_equiv'),
                element: getString('_atom_site.type_symbol'),
                res_name: getString('_atom_site.label_comp_id'),
                res_seq: getInt('_atom_site.auth_seq_id')
            };

            if (modelIDKey) {
                modelID = getInt(modelIDKey);
            }

            if (!modelMap.has(modelID)) {
                modelMap.set(modelID, []);
            }
            modelMap.get(modelID).push(atom);
        }
    }

    return Array.from(modelMap.keys())
        .sort((a, b) => a - b)
        .map(id => modelMap.get(id));
}

/**
 * Map modified residue codes to their parent types
 * Returns 'P' for protein, 'D' for DNA, 'R' for RNA, or null if not a modified standard residue
 */
function getModifiedResidueType(resName) {
    // Comprehensive mapping of modified residues to their parent types
    // Format: modified_code -> {type: 'P'|'D'|'R', parent: standard_code}
    const modifiedResidueMap = {
        // Modified amino acids (protein)
        'MSE': {type: 'P', parent: 'MET'}, // Selenomethionine
        'PTR': {type: 'P', parent: 'TYR'}, // Phosphotyrosine
        'SEP': {type: 'P', parent: 'SER'}, // Phosphoserine
        'TPO': {type: 'P', parent: 'THR'}, // Phosphothreonine
        'M3L': {type: 'P', parent: 'LYS'}, // N-methyllysine
        'FME': {type: 'P', parent: 'MET'}, // N-formylmethionine
        'OMY': {type: 'P', parent: 'TYR'}, // O-methyltyrosine
        'OMT': {type: 'P', parent: 'THR'}, // O-methylthreonine
        'OMG': {type: 'P', parent: 'GLY'}, // O-methylglycine
        'OMU': {type: 'P', parent: 'SER'}, // O-methylserine
        'CME': {type: 'P', parent: 'CYS'}, // S-(carboxymethyl)cysteine
        'CSO': {type: 'P', parent: 'CYS'}, // S-hydroxycysteine
        'CSD': {type: 'P', parent: 'CYS'}, // S-sulfocysteine
        'CSX': {type: 'P', parent: 'CYS'}, // Cysteine sulfonic acid
        'CAS': {type: 'P', parent: 'CYS'}, // S-(dimethylarsenic)cysteine
        'CCS': {type: 'P', parent: 'CYS'}, // Carboxyethylcysteine
        'CEA': {type: 'P', parent: 'CYS'}, // S-carbamoyl-cysteine
        'CGU': {type: 'P', parent: 'GLU'}, // Carboxyglutamic acid
        'CMH': {type: 'P', parent: 'HIS'}, // N-methylhistidine
        'HIP': {type: 'P', parent: 'HIS'}, // Protonated histidine
        'HIC': {type: 'P', parent: 'HIS'}, // 4-methylhistidine
        'HIE': {type: 'P', parent: 'HIS'}, // Histidine epsilon
        'HID': {type: 'P', parent: 'HIS'}, // Histidine delta
        'MEN': {type: 'P', parent: 'ASN'}, // N-methylasparagine
        'MGN': {type: 'P', parent: 'GLN'}, // N-methylglutamine
        'PCA': {type: 'P', parent: 'GLU'}, // Pyroglutamic acid
        'SCH': {type: 'P', parent: 'CYS'}, // S-methylcysteine
        'SCY': {type: 'P', parent: 'CYS'}, // S-ethylcysteine
        'SCS': {type: 'P', parent: 'CYS'}, // S-methylthiocysteine
        'KCX': {type: 'P', parent: 'LYS'}, // Lysine with modified side chain
        'LLP': {type: 'P', parent: 'LYS'}, // Lysine with lipoyl group
        'MLY': {type: 'P', parent: 'LYS'}, // N-dimethyllysine
        'MLZ': {type: 'P', parent: 'LYS'}, // N-trimethyllysine
        'ALY': {type: 'P', parent: 'LYS'}, // N-acetyllysine
        'LYZ': {type: 'P', parent: 'LYS'}, // N-methyl-N-acetyllysine
        'STY': {type: 'P', parent: 'TYR'}, // Sulfotyrosine
        'TYI': {type: 'P', parent: 'TYR'}, // Iodotyrosine
        'TYS': {type: 'P', parent: 'TYR'}, // Sulfotyrosine
        'IYR': {type: 'P', parent: 'TYR'}, // 3-iodotyrosine
        'TRN': {type: 'P', parent: 'TRP'}, // N-methyltryptophan
        'TRQ': {type: 'P', parent: 'TRP'}, // N-formyltryptophan
        'HTR': {type: 'P', parent: 'TRP'}, // Hydroxytryptophan
        'PHI': {type: 'P', parent: 'PHE'}, // Iodophenylalanine
        'PHL': {type: 'P', parent: 'PHE'}, // Hydroxyphenylalanine
        'DPN': {type: 'P', parent: 'PHE'}, // D-phenylalanine
        'DPR': {type: 'P', parent: 'PRO'}, // D-proline
        'HYP': {type: 'P', parent: 'PRO'}, // 4-hydroxyproline
        '3HP': {type: 'P', parent: 'PRO'}, // 3-hydroxyproline
        '4HP': {type: 'P', parent: 'PRO'}, // 4-hydroxyproline
        'PFF': {type: 'P', parent: 'PHE'}, // 4-fluorophenylalanine
        // Modified nucleotides (DNA)
        '5MU': {type: 'D', parent: 'DT'}, // 5-methyluridine (DNA)
        '5MC': {type: 'D', parent: 'DC'}, // 5-methylcytidine (DNA)
        '5MG': {type: 'D', parent: 'DG'}, // 5-methylguanosine (DNA)
        '5MA': {type: 'D', parent: 'DA'}, // 5-methyladenosine (DNA)
        'OMC': {type: 'D', parent: 'DC'}, // O-methylcytidine (DNA)
        'OMG': {type: 'D', parent: 'DG'}, // O-methylguanosine (DNA)
        'OMA': {type: 'D', parent: 'DA'}, // O-methyladenosine (DNA)
        'OMT': {type: 'D', parent: 'DT'}, // O-methylthymidine (DNA)
        // Modified nucleotides (RNA)
        '1MA': {type: 'R', parent: 'A'}, // 1-methyladenosine
        '2MA': {type: 'R', parent: 'A'}, // 2-methyladenosine
        '5MU': {type: 'R', parent: 'U'}, // 5-methyluridine
        '5MC': {type: 'R', parent: 'C'}, // 5-methylcytidine
        '5MG': {type: 'R', parent: 'G'}, // 5-methylguanosine
        'OMC': {type: 'R', parent: 'C'}, // O-methylcytidine
        'OMG': {type: 'R', parent: 'G'}, // O-methylguanosine
        'OMA': {type: 'R', parent: 'A'}, // O-methyladenosine
        'OMU': {type: 'R', parent: 'U'}, // O-methyluridine
        'PSU': {type: 'R', parent: 'U'}, // Pseudouridine
        '1MG': {type: 'R', parent: 'G'}, // 1-methylguanosine
        '2MG': {type: 'R', parent: 'G'}, // 2-methylguanosine
        '7MG': {type: 'R', parent: 'G'}, // 7-methylguanosine
        'M2G': {type: 'R', parent: 'G'}, // N2-methylguanosine
        'QUO': {type: 'R', parent: 'G'}, // Queuosine
        'Y': {type: 'R', parent: 'U'}, // Pseudouridine (alternative code)
        'I': {type: 'R', parent: 'A'}, // Inosine
        'DI': {type: 'D', parent: 'DA'}, // Deoxyinosine
    };
    
    return modifiedResidueMap[resName] || null;
}

/**
 * Convert parsed atoms to frame data format, omitting keys for data that is not present.
 * @param {Array<object>} atoms - Parsed atoms
 * @returns {object} - Frame data with coords, and optional plddts, chains, atom_types
 */
function convertParsedToFrameData(atoms) {
    const coords = [];
    const plddts = [];
    const atom_chains = [];
    const atom_types = [];
    const residues = [];
    const residue_index = [];
    const rna_bases = ['A', 'C', 'G', 'U', 'RA', 'RC', 'RG', 'RU'];
    const proteinResidues = new Set([
        "ALA", "ARG", "ASN", "ASP", "CYS", "GLU", "GLN", "GLY", "HIS", "ILE",
        "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL"
    ]);
    const nucleicResidues = new Set([
        "A", "C", "G", "U", "T", "DA", "DC", "DG", "DT", "RA", "RC", "RG", "RU"
    ]);

    const residueMap = new Map();
    for (const atom of atoms) {
        if (atom.resName === 'HOH') continue;
        const resKey = `${atom.chain}:${atom.resSeq}:${atom.resName}`;
        if (!residueMap.has(resKey)) {
            residueMap.set(resKey, {
                atoms: [],
                resName: atom.resName,
                chain: atom.chain,
                record: atom.record,
                resSeq: atom.resSeq
            });
        }
        residueMap.get(resKey).atoms.push(atom);
    }

    for (const [, residue] of residueMap.entries()) {
        // Check if it's a standard residue by name
        let is_protein = proteinResidues.has(residue.resName);
        let is_nucleic = nucleicResidues.has(residue.resName);
        
        // For HETATM records, check if it has backbone atoms (CA or C4')
        // If it has backbone atoms, treat as modified protein/nucleic acid
        // If it doesn't, keep as ligand
        if (residue.record === 'HETATM' && !is_protein && !is_nucleic) {
            // Check if it has CA atom (characteristic of amino acids)
            const hasCA = residue.atoms.some(a => a.atomName === 'CA');
            // Check if it has C4' atom (characteristic of nucleotides)
            const hasC4 = residue.atoms.some(a => a.atomName === "C4'" || a.atomName === "C4*");
            
            if (hasCA) {
                // Has CA atom - treat as modified amino acid (protein)
                is_protein = true;
            } else if (hasC4) {
                // Has C4' atom - treat as modified nucleotide
                is_nucleic = true;
            }
            // If no backbone atoms, it will be treated as ligand below
        }

        if (is_protein) {
            const ca = residue.atoms.find(a => a.atomName === 'CA');
            if (ca) {
                coords.push([ca.x, ca.y, ca.z]);
                plddts.push(ca.b);
                atom_chains.push(ca.chain);
                atom_types.push('P');
                residues.push(ca.res_name || ca.resName || residue.resName);
                residue_index.push(ca.res_seq || ca.resSeq || residue.resSeq);
            }
        } else if (is_nucleic) {
            let c4_atom = residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
            if (c4_atom) {
                coords.push([c4_atom.x, c4_atom.y, c4_atom.z]);
                plddts.push(c4_atom.b);
                atom_chains.push(c4_atom.chain);
                // Determine DNA vs RNA: check for O2' (RNA-specific) or residue name patterns
                const hasO2 = residue.atoms.some(a => a.atomName === "O2'" || a.atomName === "O2*");
                const atomType = hasO2 || residue.resName.startsWith('R') || rna_bases.some(base => residue.resName.includes(base)) ?
                    'R' : (residue.resName.startsWith('D') || residue.resName.includes('DT') || residue.resName.includes('DA') || residue.resName.includes('DG') || residue.resName.includes('DC') ? 'D' : 'R');
                atom_types.push(atomType);
                residues.push(c4_atom.res_name || c4_atom.resName || residue.resName);
                residue_index.push(c4_atom.res_seq || c4_atom.resSeq || residue.resSeq);
            }
        } else if (residue.record === 'HETATM') {
            // HETATM without backbone atoms - treat as ligand
            for (const atom of residue.atoms) {
                if (atom.element !== 'H' && atom.element !== 'D') {
                    coords.push([atom.x, atom.y, atom.z]);
                    plddts.push(atom.b);
                    atom_chains.push(atom.chain);
                    atom_types.push('L');
                    residues.push(atom.res_name || atom.resName || residue.resName);
                    residue_index.push(atom.res_seq || atom.resSeq || residue.resSeq);
                }
            }
        }
    }

    const result = { coords };

    if (atom_types.length > 0) {
        result.atom_types = atom_types;
    }
    if (plddts.some(p => !isNaN(p))) {
        result.plddts = plddts;
    }
    if (atom_chains.some(c => c && c.trim())) {
        result.chains = atom_chains;
    }
    if (residues.some(r => r && r.trim())) {
        result.residues = residues;
    }
    if (residue_index.some(i => !isNaN(i))) {
        result.residue_index = residue_index;
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
        while (i < n && /\s/.test(s[i])) i++;
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
            while (j < n && !/\s/.test(s[j])) j++;
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
                }
                i++;
            }
            loops.push([cols, rows]);
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
function parseFirstBioAssembly(text) {
    const isCIF = /^\s*data_/i.test(text) || /_atom_site\./i.test(text);
    return isCIF ? buildBioFromCIF(text) : buildBioFromPDB(text);
}

function buildBioFromPDB(text) {
    const models = parsePDB(text);
    const atoms = (models && models[0]) ? models[0] : [];
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
            ops.push({ id: String(k), R, t });
        }
    });
    
    if (ops.length === 0) {
        return { atoms, meta: { source: 'pdb', assembly: 'asymmetric_unit' } };
    }
    
    if (chains.size === 0) {
        for (const a of atoms) {
            if (a.chain) chains.add(a.chain);
        }
    }
    
    const out = [];
    for (const op of ops) {
        for (const a of atoms) {
            if (!chains.size || chains.has(a.chain)) {
                const ax = applyOp_light(a, op.R, op.t);
                ax.chain = (op.id === '1') ?
                    String(a.chain || '') :
                    (String(a.chain || '') + '|' + op.id);
                out.push(ax);
            }
        }
    }
    
    return {
        atoms: out,
        meta: {
            source: 'pdb',
            assembly: String(targetBioId),
            ops: ops.length,
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
    const ixAA = acol('_atom_site.auth_asym_id');
    const ixRes = (acol('_atom_site.label_comp_id') >= 0 ?
        acol('_atom_site.label_comp_id') : acol('_atom_site.auth_comp_id'));
    const ixSeq = (acol('_atom_site.label_seq_id') >= 0 ?
        acol('_atom_site.label_seq_id') : acol('_atom_site.auth_seq_id'));
    const ixNm = acol('_atom_site.label_atom_id');
    const ixGrp = acol('_atom_site.group_PDB');
    const ixB = acol('_atom_site.B_iso_or_equiv');

    const baseAtoms = atomRows.map(r => ({
        record: r[ixGrp] || 'ATOM',
        atomName: r[ixNm] || '',
        resName: r[ixRes] || '',
        lchain: (ixLA >= 0 ? r[ixLA] : (ixAA >= 0 ? r[ixAA] : '')) || '',
        chain: (ixLA >= 0 ? r[ixLA] : (ixAA >= 0 ? r[ixAA] : '')) || '',
        authChain: (ixAA >= 0 ? r[ixAA] : ''),
        resSeq: r[ixSeq] ? parseInt(r[ixSeq], 10) : 0,
        x: parseFloat(r[ixX]),
        y: parseFloat(r[ixY]),
        z: parseFloat(r[ixZ]),
        b: ixB >= 0 ? (parseFloat(r[ixB]) || 0.0) : 0.0,
        element: (r[ixEl] || '').toUpperCase()
    }));

    // Assembly generator
    const asmL = getLoop('_pdbx_struct_assembly_gen.assembly_id');
    if (!asmL) {
        return { atoms: baseAtoms, meta: { source: 'mmcif', assembly: 'asymmetric_unit' } };
    }

    // Operator list
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
    
    if (!operL || opMap.size === 0) {
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

    // Assemble
    const out = [];
    const seen = new Set();
    for (const r of candidates) {
        const asymList = (r[a('_pdbx_struct_assembly_gen.asym_id_list')] ||
            r[a('_pdbx_struct_assembly_gen.oper_asym_id_list')] || '').toString();
        const asymIds = asymList.split(',').map(s => s.trim()).filter(Boolean);
        asymIds.forEach(c => seen.add(c));

        const expr = (r[a('_pdbx_struct_assembly_gen.oper_expression')] || '1').toString();
        const seqs = expandOperExpr_light(expr);
        const seqsUse = (seqs && seqs.length) ? seqs : [['1']];

        for (const seq of seqsUse) {
            const seqLabel = seq.join('x');
            let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
            let t = [0, 0, 0];
            
            for (const id of seq) {
                const op = opMap.get(id);
                if (!op) continue;
                t = [
                    op.R[0] * t[0] + op.R[1] * t[1] + op.R[2] * t[2] + op.t[0],
                    op.R[3] * t[0] + op.R[4] * t[1] + op.R[5] * t[2] + op.t[1],
                    op.R[6] * t[0] + op.R[7] * t[1] + op.R[8] * t[2] + op.t[2]
                ];
                R = [
                    op.R[0] * R[0] + op.R[1] * R[3] + op.R[2] * R[6],
                    op.R[0] * R[1] + op.R[1] * R[4] + op.R[2] * R[7],
                    op.R[0] * R[2] + op.R[1] * R[5] + op.R[2] * R[8],
                    op.R[3] * R[0] + op.R[4] * R[3] + op.R[5] * R[6],
                    op.R[3] * R[1] + op.R[4] * R[4] + op.R[5] * R[7],
                    op.R[3] * R[2] + op.R[4] * R[5] + op.R[5] * R[8],
                    op.R[6] * R[0] + op.R[7] * R[3] + op.R[8] * R[6],
                    op.R[6] * R[1] + op.R[7] * R[4] + op.R[8] * R[7],
                    op.R[6] * R[2] + op.R[7] * R[5] + op.R[8] * R[8]
                ];
            }
            
            for (const aAtom of baseAtoms) {
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