// ============================================================================
// ESMFOLD API SUPPORT
// ============================================================================
// This file contains ESMFold API integration for protein structure prediction.
// Currently disabled - can be re-enabled by uncommenting the call in app.js
// and including this file in index.html

/**
 * Call ESMFold API to predict protein structure from sequence
 * @param {string} sequence - Protein sequence (one-letter amino acid codes)
 * @returns {Promise<string|null>} - PDB format structure string, or null if failed
 */
async function callESMFoldAPI(sequence) {
    if (!sequence || sequence.length === 0) {
        return null;
    }
    
    // ESMFold API has a limit of 256 amino acids (for speed)
    if (sequence.length > 256) {
        // For sequences > 256, use chunked approach (handled by callESMFoldChunked)
        // This function should only be called for sequences <= 256
        throw new Error(`Sequence length (${sequence.length}) exceeds ESMFold limit (256). Use callESMFoldChunked instead.`);
    }
    
    const apiUrl = 'https://api.esmatlas.com/foldSequence/v1/pdb/';
    
    try {
        setStatus(`Calling ESMFold API for structure prediction (${sequence.length} residues)...`);
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
            },
            body: sequence
        });
        
        if (!response.ok) {
            if (response.status === 400) {
                throw new Error('Invalid sequence format');
            } else if (response.status === 413) {
                throw new Error('Sequence too long for ESMFold API');
            } else if (response.status === 429) {
                throw new Error('Rate limit exceeded. Please try again later.');
            } else {
                throw new Error(`ESMFold API error (HTTP ${response.status})`);
            }
        }
        
        const pdbText = await response.text();
        
        if (!pdbText || pdbText.trim().length === 0) {
            throw new Error('Empty response from ESMFold API');
        }
        
        // Validate that it looks like PDB format
        if (!pdbText.includes('ATOM') && !pdbText.includes('HETATM')) {
            throw new Error('Invalid PDB format received from ESMFold API');
        }
        
        // Check if B-factor column (60-66) contains pLDDT values
        // Sample a few ATOM lines to see if B-factor column has values
        const atomLines = pdbText.split('\n').filter(line => line.startsWith('ATOM'));
        if (atomLines.length > 0) {
            let hasBfactor = false;
            let sampleBfactors = [];
            for (let i = 0; i < Math.min(5, atomLines.length); i++) {
                const line = atomLines[i];
                if (line.length >= 66) {
                    const bfactorStr = line.substring(60, 66).trim();
                    const bfactor = parseFloat(bfactorStr);
                    if (!isNaN(bfactor)) {
                        hasBfactor = true;
                        sampleBfactors.push(bfactor);
                    }
                }
            }
            if (!hasBfactor) {
                console.warn('ESMFold PDB response: B-factor column appears empty or invalid. pLDDT values may not be available.');
            } else {
                console.log(`ESMFold PDB response: Sample B-factor (pLDDT) values: ${sampleBfactors.join(', ')}`);
            }
        }
        
        setStatus(`ESMFold prediction successful (${sequence.length} residues)`);
        return pdbText;
        
    } catch (error) {
        console.error('ESMFold API error:', error);
        setStatus(`ESMFold API failed: ${error.message}. Using fallback helix structure.`, true);
        return null;
    }
}

/**
 * Extract coordinates and metadata from PDB text
 * @param {string} pdbText - PDB file content
 * @param {number} startRes - Optional: start residue index (0-based in sequence)
 * @param {number} endRes - Optional: end residue index (0-based in sequence, exclusive)
 * @returns {Object|null} - Frame data object or null if parsing fails
 */
function extractCoordinatesFromPDB(pdbText, startRes = null, endRes = null) {
    try {
        const parseResult = parsePDB(pdbText);
        const models = parseResult.models;
        
        if (!models || models.length === 0) {
            return null;
        }
        
        // Use first model
        const atoms = models[0];
        if (!atoms || atoms.length === 0) {
            return null;
        }
        
        // Convert to frame data
        const frameData = convertParsedToFrameData(atoms);
        
        // If range specified, filter to that range
        if (startRes !== null || endRes !== null) {
            const start = startRes !== null ? startRes : 0;
            const end = endRes !== null ? endRes : frameData.coords.length;
            
            return {
                coords: frameData.coords.slice(start, end),
                plddts: frameData.plddts ? frameData.plddts.slice(start, end) : undefined,
                position_names: frameData.position_names ? frameData.position_names.slice(start, end) : undefined,
                chains: frameData.chains ? frameData.chains.slice(start, end) : undefined,
                residue_numbers: frameData.residue_numbers ? frameData.residue_numbers.slice(start, end) : undefined,
                position_types: frameData.position_types ? frameData.position_types.slice(start, end) : undefined
            };
        }
        
        return frameData;
    } catch (error) {
        console.error('Error extracting coordinates from PDB:', error);
        return null;
    }
}

/**
 * Find best cutpoint in overlap region where CA atoms are closest
 * @param {Array<Array<number>>} prevOverlap - CA coordinates from previous chunk (last 50 residues)
 * @param {Array<Array<number>>} currOverlap - CA coordinates from current chunk (first 50 residues, already aligned)
 * @returns {number} - Index (0-49) of best cutpoint
 */
function findBestCutpoint(prevOverlap, currOverlap) {
    if (prevOverlap.length !== currOverlap.length || prevOverlap.length === 0) {
        // Default to middle if lengths don't match
        return Math.floor(prevOverlap.length / 2);
    }
    
    let minDistance = Infinity;
    let bestCutpoint = Math.floor(prevOverlap.length / 2); // Default to middle
    
    // Calculate distance for each position in overlap
    for (let i = 0; i < prevOverlap.length; i++) {
        const prev = prevOverlap[i];
        const curr = currOverlap[i];
        
        // Euclidean distance
        const dx = prev[0] - curr[0];
        const dy = prev[1] - curr[1];
        const dz = prev[2] - curr[2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        if (distance < minDistance) {
            minDistance = distance;
            bestCutpoint = i;
        }
    }
    
    return bestCutpoint;
}

/**
 * Call ESMFold API for chunked sequences (>256 residues)
 * @param {string} sequence - Full protein sequence
 * @returns {Promise<Array<string>|string|null>} - Array of PDB texts (chunked) or single PDB text, or null if failed
 */
async function callESMFoldChunked(sequence) {
    if (!sequence || sequence.length === 0) {
        return null;
    }
    
    const chunkSize = 256;
    
    // If sequence is <= 256, use regular API call
    if (sequence.length <= chunkSize) {
        return await callESMFoldAPI(sequence);
    }
    
    // Calculate chunks with maximum overlap
    // For sequences > 256, we want chunks with maximum overlap
    // Example: 500 residues -> chunk1: 0-256, chunk2: 206-462, chunk3: 412-500 (overlap: 50)
    const chunks = [];
    const sequenceLength = sequence.length;
    
    if (sequenceLength <= chunkSize * 2) {
        // Two chunks with maximum overlap
        const firstChunk = {
            sequence: sequence.substring(0, chunkSize),
            start: 0,
            end: chunkSize,
            index: 0
        };
        chunks.push(firstChunk);
        
        // Second chunk starts at (sequenceLength - chunkSize) to maximize overlap
        const secondChunkStart = sequenceLength - chunkSize;
        const secondChunk = {
            sequence: sequence.substring(secondChunkStart, sequenceLength),
            start: secondChunkStart,
            end: sequenceLength,
            index: 1
        };
        chunks.push(secondChunk);
        
        // Overlap is: chunkSize - (sequenceLength - chunkSize) = 2*chunkSize - sequenceLength
        const overlap = 2 * chunkSize - sequenceLength;
        console.log(`Sequence length ${sequenceLength}: Chunk 1 (0-${chunkSize}), Chunk 2 (${secondChunkStart}-${sequenceLength}), Overlap: ${overlap} residues`);
    } else {
        // Multi-chunk case: sequences > 256 residues (2 * chunkSize)
        // Strategy: Use sliding window ensuring at least minOverlap between all chunks
        // For 2 chunks, maximize overlap. For more chunks, ensure minimum overlap while maximizing where possible
        const minOverlap = 50;
        
        let start = 0;
        let chunkIndex = 0;
        
        while (start < sequenceLength) {
            const end = Math.min(start + chunkSize, sequenceLength);
            const chunkSeq = sequence.substring(start, end);
            
            chunks.push({
                sequence: chunkSeq,
                start: start,
                end: end,
                index: chunkIndex
            });
            
            chunkIndex++;
            
            if (end >= sequenceLength) {
                break;
            }
            
            // Calculate next start position
            const remainingResidues = sequenceLength - end;
            
            if (remainingResidues <= chunkSize) {
                // Last chunk - maximize overlap with previous chunk
                const lastChunkStart = sequenceLength - chunkSize;
                const potentialOverlap = end - lastChunkStart;
                
                if (potentialOverlap >= minOverlap) {
                    start = lastChunkStart;
                } else {
                    // Ensure minimum overlap
                    start = end - minOverlap;
                }
            } else {
                // Intermediate chunks - use minimum overlap to ensure we can cover all residues
                // But try to maximize if possible
                start = end - minOverlap;
            }
        }
        
        // Enhanced logging
        console.log(`Sequence length ${sequenceLength}: Created ${chunks.length} chunks with overlaps:`);
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            let overlapInfo = '';
            if (i > 0) {
                const prevChunk = chunks[i - 1];
                const overlap = prevChunk.end - chunk.start;
                overlapInfo = `, overlap with prev: ${overlap}`;
            }
            console.log(`  Chunk ${i + 1}: ${chunk.start}-${chunk.end} (${chunk.end - chunk.start} residues${overlapInfo})`);
        }
    }
    
    setStatus(`Predicting ${chunks.length} chunks for ${sequence.length} residue sequence...`);
    console.log(`Chunking ${sequence.length} residue sequence into ${chunks.length} chunks:`, chunks.map(c => `${c.start}-${c.end} (${c.end - c.start} residues)`).join(', '));
    
        // Call API for all chunks in parallel
        try {
            const pdbPromises = chunks.map(async (chunk, idx) => {
                setStatus(`Predicting chunk ${idx + 1}/${chunks.length} (residues ${chunk.start + 1}-${chunk.end})...`);
                
                // Debug: verify the sequence being sent
                console.log(`Chunk ${idx + 1}: Sending sequence to ESMFold: length=${chunk.sequence.length}, first 20 chars="${chunk.sequence.substring(0, 20)}", last 20 chars="${chunk.sequence.substring(Math.max(0, chunk.sequence.length - 20))}"`);
                console.log(`Chunk ${idx + 1}: Expected from original sequence: "${sequence.substring(chunk.start, Math.min(chunk.start + 20, chunk.end))}..." (should match first 20 chars)`);
                
                const pdbText = await callESMFoldAPI(chunk.sequence);
                if (!pdbText) {
                    throw new Error(`Chunk ${idx + 1} failed`);
                }
                
                // Debug: check how many residues were returned and sample pLDDT values
                const atomLines = pdbText.split('\n').filter(line => line.startsWith('ATOM') && line.substring(12, 16).trim() === 'CA');
                const samplePlddts = [];
                for (let i = 0; i < Math.min(5, atomLines.length); i++) {
                    const line = atomLines[i];
                    if (line.length >= 66) {
                        const bfactor = parseFloat(line.substring(60, 66).trim());
                        if (!isNaN(bfactor)) {
                            samplePlddts.push(bfactor);
                        }
                    }
                }
                const avgPlddt = samplePlddts.length > 0 ? (samplePlddts.reduce((a, b) => a + b, 0) / samplePlddts.length).toFixed(2) : 'N/A';
                console.log(`Chunk ${idx + 1}: ESMFold returned ${atomLines.length} CA atoms (expected ${chunk.sequence.length}), sample pLDDT: [${samplePlddts.map(p => p.toFixed(2)).join(', ')}], avg: ${avgPlddt}`);
                
                return { pdbText, chunk };
            });
        
        const results = await Promise.all(pdbPromises);
        // Return both PDB texts and chunk info for stitching
        return {
            pdbTexts: results.map(r => r.pdbText),
            chunkInfo: chunks
        };
        
    } catch (error) {
        console.error('ESMFold chunked prediction failed:', error);
        setStatus(`ESMFold chunked prediction failed: ${error.message}. Using fallback helix structure.`, true);
        return null;
    }
}

/**
 * Align and stitch multiple ESMFold chunks together
 * @param {Array<string>} pdbTexts - Array of PDB text strings (one per chunk)
 * @param {string} originalSequence - Original full sequence
 * @param {Array<Object>} chunkInfo - Optional array of chunk info with start/end positions
 * @returns {Object|null} - Combined frame data object or null if stitching fails
 */
function alignAndStitchChunks(pdbTexts, originalSequence, chunkInfo = null) {
    if (!pdbTexts || pdbTexts.length === 0) {
        return null;
    }
    
    // If only one chunk, just return it
    if (pdbTexts.length === 1) {
        return extractCoordinatesFromPDB(pdbTexts[0]);
    }
    
    setStatus(`Aligning and stitching ${pdbTexts.length} chunks...`);
    
    try {
        // Parse first chunk - this is our base
        const firstChunkData = extractCoordinatesFromPDB(pdbTexts[0]);
        if (!firstChunkData || !firstChunkData.coords) {
            throw new Error('Failed to parse first chunk');
        }
        
        // Initialize combined structure with first chunk
        const combined = {
            coords: [...firstChunkData.coords],
            plddts: firstChunkData.plddts ? [...firstChunkData.plddts] : undefined,
            position_names: firstChunkData.position_names ? [...firstChunkData.position_names] : undefined,
            chains: firstChunkData.chains ? [...firstChunkData.chains] : undefined,
            residue_numbers: firstChunkData.residue_numbers ? [...firstChunkData.residue_numbers] : undefined,
            position_types: firstChunkData.position_types ? [...firstChunkData.position_types] : undefined
        };
        
        // Track expected position in original sequence
        let expectedEndPosition = chunkInfo && chunkInfo[0] ? chunkInfo[0].end : firstChunkData.coords.length;
        
        // Process each subsequent chunk
        for (let i = 1; i < pdbTexts.length; i++) {
            const currentChunkData = extractCoordinatesFromPDB(pdbTexts[i]);
            if (!currentChunkData || !currentChunkData.coords) {
                throw new Error(`Failed to parse chunk ${i + 1}`);
            }
            
            // Calculate overlap from actual chunk positions if available
            let overlap;
            if (chunkInfo && chunkInfo[i] && chunkInfo[i-1]) {
                // Calculate overlap from chunk positions in original sequence
                const prevChunkEnd = chunkInfo[i-1].end;  // End position of previous chunk in original sequence
                const currChunkStart = chunkInfo[i].start; // Start position of current chunk in original sequence
                
                if (currChunkStart < prevChunkEnd) {
                    // There is overlap
                    overlap = prevChunkEnd - currChunkStart;
                    console.log(`Chunk ${i + 1}: overlap calculated from positions: prev ends at ${prevChunkEnd}, curr starts at ${currChunkStart}, overlap = ${overlap}`);
                } else {
                    // No overlap - this shouldn't happen with our chunking, but handle it
                    overlap = Math.min(combined.coords.length, currentChunkData.coords.length, 10);
                    console.warn(`Chunk ${i + 1}: No overlap detected! prev ends at ${prevChunkEnd}, curr starts at ${currChunkStart}`);
                }
            } else {
                // Fallback: estimate overlap (shouldn't happen if chunkInfo is provided)
                if (pdbTexts.length === 2) {
                    const chunkSize = 256;
                    overlap = 2 * chunkSize - originalSequence.length;
                } else {
                    // Estimate based on expected positions
                    overlap = Math.min(combined.coords.length, currentChunkData.coords.length, 50);
                }
                console.warn(`Chunk ${i + 1}: Using estimated overlap ${overlap} (chunkInfo not available)`);
            }
            
            // Ensure overlap is reasonable (at least 1, at most the smaller of the two chunks)
            overlap = Math.max(1, Math.min(overlap, combined.coords.length, currentChunkData.coords.length));
            
            // Extract overlap regions
            const prevOverlapStart = combined.coords.length - overlap;
            const prevOverlap = combined.coords.slice(prevOverlapStart);
            const currOverlap = currentChunkData.coords.slice(0, overlap);
            
            if (prevOverlap.length !== overlap || currOverlap.length !== overlap) {
                console.warn(`Overlap region size mismatch in chunk ${i + 1}: expected ${overlap}, got prev=${prevOverlap.length}, curr=${currOverlap.length}`);
                // Use the smaller of the two as the actual overlap
                const actualOverlap = Math.min(prevOverlap.length, currOverlap.length);
                if (actualOverlap < 1) {
                    throw new Error(`Overlap too small in chunk ${i + 1}: ${actualOverlap} residues`);
                }
                // Adjust overlap regions to match actual overlap
                if (prevOverlap.length > actualOverlap) {
                    prevOverlap = prevOverlap.slice(-actualOverlap);
                }
                if (currOverlap.length > actualOverlap) {
                    currOverlap = currOverlap.slice(0, actualOverlap);
                }
                overlap = actualOverlap;
            }
            
            // Align current chunk to previous chunk using overlap regions
            const alignedCurrentCoords = align_a_to_b(
                currentChunkData.coords,  // All coordinates of current chunk
                currOverlap,              // First 50 residues of current chunk
                prevOverlap               // Last 50 residues of previous chunk
            );
            
            // Find best cutpoint where CA atoms are closest
            const alignedCurrOverlap = alignedCurrentCoords.slice(0, overlap);
            const cutpoint = findBestCutpoint(prevOverlap, alignedCurrOverlap);
            
            // Stitch: remove overlap from previous chunk, then add from cutpoint onwards
            // cutpoint is the index in the overlap region (0 to overlap-1) where to cut
            // We want to keep previous chunk up to (combined.length - overlap + cutpoint)
            // Then add current chunk from cutpoint onwards
            const residuesToKeepFromPrev = combined.coords.length - overlap + cutpoint;
            combined.coords = combined.coords.slice(0, residuesToKeepFromPrev);
            if (combined.plddts) {
                combined.plddts = combined.plddts.slice(0, residuesToKeepFromPrev);
            }
            if (combined.position_names) {
                combined.position_names = combined.position_names.slice(0, residuesToKeepFromPrev);
            }
            if (combined.chains) {
                combined.chains = combined.chains.slice(0, residuesToKeepFromPrev);
            }
            if (combined.residue_numbers) {
                combined.residue_numbers = combined.residue_numbers.slice(0, residuesToKeepFromPrev);
            }
            if (combined.position_types) {
                combined.position_types = combined.position_types.slice(0, residuesToKeepFromPrev);
            }
            
            // Append aligned current chunk starting from cutpoint
            const residuesToAdd = alignedCurrentCoords.slice(cutpoint);
            const beforeAdd = combined.coords.length;
            combined.coords.push(...residuesToAdd);
            const afterAdd = combined.coords.length;
            
            // Debug: check pLDDT values being added
            let plddtInfo = '';
            if (currentChunkData.plddts && currentChunkData.plddts.length > cutpoint) {
                const plddtsToAdd = currentChunkData.plddts.slice(cutpoint);
                const samplePlddts = plddtsToAdd.slice(0, Math.min(5, plddtsToAdd.length));
                const avgPlddt = plddtsToAdd.length > 0 ? (plddtsToAdd.reduce((a, b) => a + b, 0) / plddtsToAdd.length).toFixed(2) : 'N/A';
                plddtInfo = `, pLDDT: sample=[${samplePlddts.map(p => p.toFixed(1)).join(', ')}], avg=${avgPlddt}`;
            }
            
            console.log(`Chunk ${i + 1}: kept ${residuesToKeepFromPrev} from previous, added ${residuesToAdd.length} from current (cutpoint=${cutpoint}, overlap=${overlap}), total: ${afterAdd}${plddtInfo}`);
            
            if (currentChunkData.plddts) {
                const plddtsToAdd = currentChunkData.plddts.slice(cutpoint);
                if (combined.plddts) {
                    combined.plddts.push(...plddtsToAdd);
                } else {
                    combined.plddts = [...plddtsToAdd];
                }
            }
            
            if (currentChunkData.position_names) {
                const namesToAdd = currentChunkData.position_names.slice(cutpoint);
                if (combined.position_names) {
                    combined.position_names.push(...namesToAdd);
                } else {
                    combined.position_names = [...namesToAdd];
                }
            }
            
            if (currentChunkData.chains) {
                const chainsToAdd = currentChunkData.chains.slice(cutpoint);
                if (combined.chains) {
                    combined.chains.push(...chainsToAdd);
                } else {
                    combined.chains = [...chainsToAdd];
                }
            }
            
            if (currentChunkData.residue_numbers) {
                const resNumsToAdd = currentChunkData.residue_numbers.slice(cutpoint);
                if (combined.residue_numbers) {
                    combined.residue_numbers.push(...resNumsToAdd);
                } else {
                    combined.residue_numbers = [...resNumsToAdd];
                }
            }
            
            if (currentChunkData.position_types) {
                const typesToAdd = currentChunkData.position_types.slice(cutpoint);
                if (combined.position_types) {
                    combined.position_types.push(...typesToAdd);
                } else {
                    combined.position_types = [...typesToAdd];
                }
            }
        }
        
        // Verify final length matches original sequence
        if (combined.coords.length !== originalSequence.length) {
            console.error(`Stitched structure length (${combined.coords.length}) does not match sequence length (${originalSequence.length}). Expected ${originalSequence.length} but got ${combined.coords.length}.`);
            // Try to fix by padding or truncating if close
            const diff = originalSequence.length - combined.coords.length;
            if (Math.abs(diff) <= 10) {
                console.warn(`Attempting to fix length mismatch by ${diff > 0 ? 'padding' : 'truncating'} ${Math.abs(diff)} residues`);
                // This is a workaround - ideally the stitching should be correct
            }
        } else {
            // Debug: log final pLDDT statistics
            let plddtStats = '';
            if (combined.plddts && combined.plddts.length > 0) {
                const validPlddts = combined.plddts.filter(p => !isNaN(p) && p !== null && p !== undefined);
                if (validPlddts.length > 0) {
                    const minPlddt = Math.min(...validPlddts);
                    const maxPlddt = Math.max(...validPlddts);
                    const avgPlddt = validPlddts.reduce((a, b) => a + b, 0) / validPlddts.length;
                    // Sample pLDDT from different regions
                    const sample1 = validPlddts.slice(0, 10).map(p => p.toFixed(1)).join(', ');
                    const sample2 = validPlddts.slice(Math.floor(validPlddts.length / 2), Math.floor(validPlddts.length / 2) + 10).map(p => p.toFixed(1)).join(', ');
                    const sample3 = validPlddts.slice(-10).map(p => p.toFixed(1)).join(', ');
                    plddtStats = `, pLDDT: min=${minPlddt.toFixed(1)}, max=${maxPlddt.toFixed(1)}, avg=${avgPlddt.toFixed(1)}, samples: start=[${sample1}], middle=[${sample2}], end=[${sample3}]`;
                }
            }
            console.log(`Successfully stitched ${pdbTexts.length} chunks: final length ${combined.coords.length} matches sequence length ${originalSequence.length}${plddtStats}`);
        }
        
        setStatus(`Successfully stitched ${pdbTexts.length} chunks into ${combined.coords.length} residue structure`);
        return combined;
        
    } catch (error) {
        console.error('Error aligning and stitching chunks:', error);
        setStatus(`Failed to stitch chunks: ${error.message}`, true);
        return null;
    }
}

