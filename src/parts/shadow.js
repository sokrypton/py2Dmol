// ============================================================================
// src/parts/shadow.js
// ---------------------------------
// AI Context: SHADOWS AND TINTS (a part of Pseudo3DRenderer)
// - Which segments darken which, by how much, and the grid that avoids asking
//   every pair. One entry point, _calculateFrameShadows, called from the draw
//   path; one cache, invalidated by _invalidateShadowCache.
// - The GPU path computes its own ambient occlusion and never comes here.
// ============================================================================
(function () {
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({
    name: 'shadow',
    proto: {
        // Helper function for shadow calculation
        /**
         * Calculates the shadow and tint contribution for a pair of segments.
         * @param {object} s1 - The segment being shaded (further back).
         * @param {object} s2 - The segment casting the shadow (further forward).
         * @param {object} segInfo1 - Segment info for s1 (has type, idx1, idx2)
         * @param {object} segInfo2 - Segment info for s2 (has type, idx1, idx2)
         * @returns {{shadow: number, tint: number}}
         */
        /**
         * Should this pair exchange shadow at all? `recv` is the segment being
         * shaded, `cast` the one in front of it.
         *
         * Two things are excluded, and the reason is the same both times: they
         * are drawn ON the structure rather than being part of it.
         *
         *  - CONTACTS are annotation. A contact line darkening the backbone it
         *    points at would read as geometry.
         *  - SIDE CHAINS cast nothing onto the backbone. They are thin sticks
         *    at a fifth of its weight, sitting right against it, so every one
         *    would print a hard little shadow on the chain it grows out of -
         *    and the eye reads that as the backbone being dented, not as the
         *    side chain being in front. The backbone still shades THEM, which
         *    is the direction that carries depth.
         *
         * Was duplicated at both call sites; one copy so the two cannot drift.
         */
        _shadowPairExcluded(recv, cast) {
            const isMolecule = (t) => t === 'P' || t === 'D' || t === 'R';
            if ((recv.type === 'C' && isMolecule(cast.type))
                || (isMolecule(recv.type) && cast.type === 'C')) return true;
            const sc = this.sidechainMap;
            if (sc && sc.size && isMolecule(recv.type)
                && (sc.has(cast.idx1) || sc.has(cast.idx2))) return true;
            return false;
        },

        _calculateShadowTint(s1, s2, segInfo1, segInfo2) {
            // Fast approximation: skip expensive calculations (sqrt, sigmoid, width)
            // Uses rational function approximation: cutoff² / (cutoff² + dist² * alpha)
            // This avoids sqrt and sigmoid while maintaining similar visual quality

            // Cache segment lengths
            const len1 = s1.len;
            const len2 = s2.len;

            // Handle zero-length segments (positions)
            // Use type-based reference length for positions to ensure proper shadow/tint calculation
            const isPosition1 = segInfo1.idx1 === segInfo1.idx2;
            const isPosition2 = segInfo2.idx1 === segInfo2.idx2;

            // Calculate effective lengths for cutoff calculation
            let effectiveLen1 = len1;
            let effectiveLen2 = len2;

            if (isPosition1) {
                // For positions, use type-based reference length
                effectiveLen1 = REF_LENGTHS[segInfo1.type] ?? REF_LENGTHS['P'];
            }
            if (isPosition2) {
                effectiveLen2 = REF_LENGTHS[segInfo2.type] ?? REF_LENGTHS['P'];
            }

            const avgLen = (effectiveLen1 + effectiveLen2) * 0.5;
            const shadow_cutoff = avgLen * SHADOW_CUTOFF_MULTIPLIER;
            const tint_cutoff = avgLen * TINT_CUTOFF_MULTIPLIER;

            // Always use reference length for receiving segment type
            const refLen = REF_LENGTHS[segInfo1.type] ?? REF_LENGTHS['P'];
            const shadow_offset = refLen * SHADOW_OFFSET_MULTIPLIER;
            const tint_offset = refLen * TINT_OFFSET_MULTIPLIER;

            const max_cutoff = shadow_cutoff + shadow_offset;
            const max_cutoff_sq = max_cutoff * max_cutoff;

            // Use properties from the segment data objects
            const dx_dist = s1.x - s2.x;
            const dy_dist = s1.y - s2.y;

            const dist2D_sq = dx_dist * dx_dist + dy_dist * dy_dist;

            // Early exit: if 2D distance is too large, no shadow or tint
            if (dist2D_sq > max_cutoff_sq) {
                return { shadow: 0, tint: 0 };
            }

            let shadow = 0;
            let tint = 0;

            const dz = s1.z - s2.z;
            const dist3D_sq = dist2D_sq + dz * dz;

            // Fast approximation: rational function that approximates sigmoid(cutoff - sqrt(dist))
            // Formula: cutoff² / (cutoff² + dist² * alpha) where alpha = 2.0
            // This avoids sqrt and sigmoid calculations while maintaining similar visual quality

            // Shadow approximation
            if (dist3D_sq < max_cutoff_sq) {
                const shadow_cutoff_sq = shadow_cutoff * shadow_cutoff;
                const alpha = 2.0; // Tuned to match sigmoid behavior
                shadow = shadow_cutoff_sq / (shadow_cutoff_sq + dist3D_sq * alpha);
            }

            // Tint approximation
            const tint_max_cutoff = tint_cutoff + tint_offset;
            const tint_max_cutoff_sq = tint_max_cutoff * tint_max_cutoff;
            if (dist2D_sq < tint_max_cutoff_sq) {
                const tint_cutoff_sq = tint_cutoff * tint_cutoff;
                const alpha = 2.0; // Tuned to match sigmoid behavior
                tint = tint_cutoff_sq / (tint_cutoff_sq + dist2D_sq * alpha);
            }

            // Adjust shadow strength proportional to ideal bond lengths
            // Using protein CA-CA as baseline = 1.0
            // Ligand: REF_LENGTHS['L'] / REF_LENGTHS['P'] ≈ 0.395
            // Protein: REF_LENGTHS['P'] / REF_LENGTHS['P'] = 1.0
            // DNA/RNA: REF_LENGTHS['D'] / REF_LENGTHS['P'] ≈ 1.553

            let strengthMultiplier = 1.0;

            // Base strength proportional to segment length
            const type2 = segInfo2.type;
            const proteinRefLength = REF_LENGTHS['P'];

            if (type2 === 'P') {
                // Protein: use as baseline
                strengthMultiplier = 1.0;
            } else if (type2 === 'D' || type2 === 'R') {
                // DNA/RNA: longer segments cast stronger shadows
                strengthMultiplier = REF_LENGTHS['D'] / proteinRefLength;
            } else if (type2 === 'L') {
                // Ligand: shorter segments cast weaker shadows
                strengthMultiplier = REF_LENGTHS['L'] / proteinRefLength;
            }

            // Further reduce for single atoms (positions)
            if (isPosition2) {
                // Single atom represents half the mass of a segment (bond)
                strengthMultiplier *= 0.5;
            }

            // Final scaling by user-controlled shadow strength
            strengthMultiplier *= this.shadowStrength;

            return { shadow: shadow * strengthMultiplier, tint: tint * strengthMultiplier };
        },

        // Dispatcher method: selects fast/slow shadow calculation based on position count
        _calculateFrameShadows(segmentList, numPositions, segments, segData, maxExtent, shadows, tints) {
            const useFastMode = numPositions > this.LARGE_MOLECULE_CUTOFF;

            if (useFastMode) {
                this._calculateShadowsWithGrid(segmentList, segments, segData, maxExtent, shadows, tints);
            } else {
                this._calculateShadowsExhaustive(segmentList, segments, segData, shadows, tints);
            }
        },

        // Slow mode: exhaustive O(n²) shadow calculation for small frames
        _calculateShadowsExhaustive(segmentList, segments, segData, shadows, tints) {
            // Process segments back-to-front (already sorted by z-depth)
            for (let i_idx = segmentList.length - 1; i_idx >= 0; i_idx--) {
                const i = segmentList[i_idx];
                let shadowSum = 0;
                let maxTint = 0;
                const s1 = segData[i];
                const segInfoI = segments[i];

                // Check against all segments in front
                for (let j_idx = i_idx + 1; j_idx < segmentList.length; j_idx++) {
                    const j = segmentList[j_idx];
                    if (shadowSum >= MAX_SHADOW_SUM) break;

                    const s2 = segData[j];
                    const segInfo2 = segments[j];
                    if (this._shadowPairExcluded(segInfoI, segInfo2)) continue;

                    const { shadow, tint } = this._calculateShadowTint(s1, s2, segInfoI, segInfo2);
                    shadowSum = Math.min(shadowSum + shadow, MAX_SHADOW_SUM);
                    maxTint = Math.max(maxTint, tint);
                }

                shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                tints[i] = 1 - maxTint;
            }
        },

        // Fast mode: grid-based spatial optimization for large frames
        _calculateShadowsWithGrid(segmentList, segments, segData, maxExtent, shadows, tints) {
            const numVisibleSegments = segmentList.length;

            // Grid setup
            let GRID_DIM = Math.ceil(Math.sqrt(numVisibleSegments / 5));
            GRID_DIM = Math.max(20, Math.min(150, GRID_DIM));
            const gridSize = GRID_DIM * GRID_DIM;
            const grid = Array.from({ length: gridSize }, () => []);

            const gridMin = -maxExtent - 1.0;
            const gridRange = (maxExtent + 1.0) * 2;
            const gridCellSize = gridRange / GRID_DIM;
            const MAX_SEGMENTS_PER_CELL = numVisibleSegments > 15000 ? 30 :
                (numVisibleSegments > 10000 ? 50 : Infinity);

            if (gridCellSize <= 1e-6) {
                shadows.fill(1.0);
                tints.fill(1.0);
                return;
            }

            const invCellSize = 1.0 / gridCellSize;

            // Assign grid coordinates
            for (let i = 0; i < segmentList.length; i++) {
                const segIdx = segmentList[i];
                const s = segData[segIdx];
                const gx = Math.floor((s.x - gridMin) * invCellSize);
                const gy = Math.floor((s.y - gridMin) * invCellSize);

                if (gx >= 0 && gx < GRID_DIM && gy >= 0 && gy < GRID_DIM) {
                    s.gx = gx;
                    s.gy = gy;
                } else {
                    s.gx = -1;
                    s.gy = -1;
                }
            }

            // Populate grid
            for (let i = 0; i < segmentList.length; i++) {
                const segIdx = segmentList[i];
                const s = segData[segIdx];
                if (s.gx >= 0 && s.gy >= 0) {
                    const gridIndex = s.gx + s.gy * GRID_DIM;
                    grid[gridIndex].push(segIdx);
                }
            }

            // Sort cells by z-depth
            for (let cellIdx = 0; cellIdx < gridSize; cellIdx++) {
                const cell = grid[cellIdx];
                if (cell.length > 1) {
                    if (cell.length > MAX_SEGMENTS_PER_CELL) {
                        cell.length = MAX_SEGMENTS_PER_CELL;
                    }
                    if (cell.length > 2) {
                        cell.sort((a, b) => segData[b].z - segData[a].z);
                    } else if (cell.length === 2) {
                        if (segData[cell[0]].z < segData[cell[1]].z) {
                            const temp = cell[0];
                            cell[0] = cell[1];
                            cell[1] = temp;
                        }
                    }
                }
            }

            // Calculate shadows using 3x3 grid neighborhood
            for (let i_idx = segmentList.length - 1; i_idx >= 0; i_idx--) {
                const i = segmentList[i_idx];
                let shadowSum = 0;
                let maxTint = 0;
                const s1 = segData[i];
                const gx1 = s1.gx;
                const gy1 = s1.gy;
                const segInfoI = segments[i];

                if (gx1 < 0) {
                    shadows[i] = 1.0;
                    tints[i] = 1.0;
                    continue;
                }

                // Check 3x3 neighborhood
                for (let dy = -1; dy <= 1; dy++) {
                    const gy2 = gy1 + dy;
                    if (gy2 < 0 || gy2 >= GRID_DIM) continue;
                    const rowOffset = gy2 * GRID_DIM;

                    for (let dx = -1; dx <= 1; dx++) {
                        const gx2 = gx1 + dx;
                        if (gx2 < 0 || gx2 >= GRID_DIM) continue;
                        if (shadowSum >= MAX_SHADOW_SUM) break;

                        const gridIndex = gx2 + rowOffset;
                        const cell = grid[gridIndex];
                        const cellLen = cell.length;

                        for (let k = 0; k < cellLen; k++) {
                            const j = cell[k];
                            if (shadowSum >= MAX_SHADOW_SUM && maxTint >= 1.0) break;

                            const s2 = segData[j];
                            const segInfoJ = segments[j];
                            if (this._shadowPairExcluded(segInfoI, segInfoJ)) continue;

                            if (s2.z <= s1.z) break;
                            if (shadowSum >= MAX_SHADOW_SUM) break;

                            const { shadow, tint } = this._calculateShadowTint(s1, s2, segInfoI, segInfoJ);
                            shadowSum = Math.min(shadowSum + shadow, MAX_SHADOW_SUM);
                            maxTint = Math.max(maxTint, tint);
                        }
                    }
                }

                shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                tints[i] = 1 - maxTint;
            }
        },
    },
});
})();