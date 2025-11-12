// ============================================================================
// MSA VIEWER MODULE
// ============================================================================
// This module provides Multiple Sequence Alignment (MSA) viewer functionality for py2Dmol.
// It can be used in both web and Python interfaces.
// Uses canvas-based rendering for performance with large MSAs.

(function() {
    'use strict';

    // ============================================================================
    // INTERNAL STATE
    // ============================================================================
    let msaData = null; // { sequences: [], querySequence: string, queryLength: number }
    let originalMSAData = null; // Original unfiltered MSA data
    let msaCanvasData = null; // Canvas-based structure for MSA mode
    let weblogoCanvasData = null; // Canvas-based structure for weblogo mode
    let msaViewMode = 'msa'; // 'msa', 'pssm', or 'weblogo'
    let renderScheduled = false;
    let coverageCutoff = 0.75; // Coverage cutoff for filtering sequences (0.0 to 1.0), default 75%
    let previewCoverageCutoff = 0.75; // Preview value during drag (only applied on mouseup)
    let identityCutoff = 0.15; // Identity cutoff for filtering sequences (0.0 to 1.0), default 15%
    let previewIdentityCutoff = 0.15; // Preview value during drag (only applied on mouseup)
    
    // Cached weblogo data for performance
    let cachedFrequencies = null;
    let cachedLogOdds = null;
    let cachedDataHash = null; // Hash to detect when MSA data changes
    let isScrolling = false; // Flag to simplify rendering during scroll
    
    // Virtual scrolling state
    let visibleSequenceStart = 0;
    let visibleSequenceEnd = 0;
    let scrollTop = 0;
    let scrollLeft = 0;
    const MAX_VISIBLE_SEQUENCES = 100;
    const SEQUENCE_ROW_HEIGHT = 20;
    const CHAR_WIDTH = 20; // Doubled from 10 to make squares 20x20
    const NAME_COLUMN_WIDTH = 200;
    const TICK_ROW_HEIGHT = 15; // Height of tick mark row above query
    const TICK_INTERVAL = 10; // Show tick every 10 positions (1-indexed)
    
    // Selection state
    let dragState = {
        isDragging: false,
        dragStartPosition: null,
        dragEndPosition: null,
        hasMoved: false,
        dragUnselectMode: false,
        initialSelectionState: new Set()
    };
    
    // Track last selection hash to detect changes (same as viewer-seq)
    let lastMSAUpdateHash = null;
    
    // Dayhoff 6-group classification colors
    const DAYHOFF_COLORS = {
        'group1': {r: 255, g: 200, b: 100}, // Small nonpolar: A, S, T, P, G - Orange
        'group2': {r: 100, g: 200, b: 255}, // Hydrophobic: C, V, I, L, M - Blue
        'group3': {r: 200, g: 100, b: 255}, // Aromatic: F, Y, W - Purple
        'group4': {r: 255, g: 100, b: 100}, // Basic: H, K, R - Red
        'group5': {r: 100, g: 255, b: 100}, // Acidic: D, E - Green
        'group6': {r: 255, g: 255, b: 100}, // Polar: N, Q - Yellow
        'gap': {r: 200, g: 200, b: 200},    // Gaps - Gray
        'other': {r: 150, g: 150, b: 150}  // Other - Dark gray
    };
    
    // Dayhoff group mapping
    const DAYHOFF_GROUPS = {
        'A': 'group1', 'S': 'group1', 'T': 'group1', 'P': 'group1', 'G': 'group1',
        'C': 'group2', 'V': 'group2', 'I': 'group2', 'L': 'group2', 'M': 'group2',
        'F': 'group3', 'Y': 'group3', 'W': 'group3',
        'H': 'group4', 'K': 'group4', 'R': 'group4',
        'D': 'group5', 'E': 'group5',
        'N': 'group6', 'Q': 'group6'
    };
    
    // Callbacks for integration with host application
    let callbacks = {
        getRenderer: null,
        getObjectSelect: null,
        highlightAtom: null,
        highlightAtoms: null,
        clearHighlight: null,
        applySelection: null,
        getPreviewSelectionSet: null,
        setPreviewSelectionSet: null
    };

    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================
    
    function truncateSequenceName(name, maxLength = 32) {
        if (!name) return '';
        if (name.length <= maxLength) return name;
        return name.substring(0, maxLength - 3) + '...';
    }
    
    function getDayhoffColor(aa) {
        if (!aa || aa === '-' || aa === 'X') return DAYHOFF_COLORS.gap;
        const group = DAYHOFF_GROUPS[aa.toUpperCase()];
        if (group) return DAYHOFF_COLORS[group];
        return DAYHOFF_COLORS.other;
    }
    
    function calculateSequenceCoverage(sequence, queryLength) {
        if (!sequence || queryLength === 0) return 0;
        let nonGapCount = 0;
        for (let i = 0; i < sequence.length; i++) {
            if (sequence[i] !== '-' && sequence[i] !== 'X') {
                nonGapCount++;
            }
        }
        return nonGapCount / queryLength;
    }
    
    function calculateSequenceSimilarity(seq1, seq2) {
        if (!seq1 || !seq2 || seq1.length !== seq2.length) return 0;
        let matches = 0;
        let total = 0;
        for (let i = 0; i < seq1.length; i++) {
            const c1 = seq1[i].toUpperCase();
            const c2 = seq2[i].toUpperCase();
            if (c1 !== '-' && c1 !== 'X' && c2 !== '-' && c2 !== 'X') {
                total++;
                if (c1 === c2) matches++;
            }
        }
        return total > 0 ? matches / total : 0;
    }
    
    function filterSequencesByCoverage(sequences, minCoverage = 0.5) {
        if (!sequences || sequences.length === 0) return [];
        const queryLength = sequences[0]?.sequence?.length || 0;
        return sequences.filter(seq => {
            const coverage = calculateSequenceCoverage(seq.sequence, queryLength);
            return coverage >= minCoverage;
        });
    }
    
    function filterSequencesByIdentity(sequences, querySequence, minIdentity = 0.15) {
        if (!sequences || sequences.length === 0 || !querySequence) return sequences;
        return sequences.filter(seq => {
            // Always keep query sequence (header === '>query')
            if (seq.header === '>query') return true;
            const identity = calculateSequenceSimilarity(seq.sequence, querySequence);
            return identity >= minIdentity;
        });
    }
    
    function sortSequencesBySimilarity(sequences, querySequence) {
        if (!sequences || sequences.length === 0 || !querySequence) return sequences;
        
        // Calculate similarity for each sequence
        const sequencesWithSimilarity = sequences.map(seq => ({
            ...seq,
            similarity: calculateSequenceSimilarity(seq.sequence, querySequence)
        }));
        
        // Sort by similarity (descending), but keep query first
        sequencesWithSimilarity.sort((a, b) => {
            // Query always first
            if (a.header === '>query') return -1;
            if (b.header === '>query') return 1;
            // Then by similarity
            return b.similarity - a.similarity;
        });
        
        return sequencesWithSimilarity;
    }
    
    function parseA3M(fileContent) {
        const lines = fileContent.split('\n');
        const sequences = [];
        let currentHeader = null;
        let currentSequence = '';
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            if (line.startsWith('>')) {
                // Save previous sequence
                if (currentHeader && currentSequence) {
                    // Remove lowercase letters (insertions), keep only uppercase
                    const alignedSequence = currentSequence.replace(/[a-z]/g, '').toUpperCase();
                    sequences.push({
                        header: truncateSequenceName(currentHeader),
                        sequence: alignedSequence,
                        isPaired: false, // TODO: detect paired sequences
                        similarity: 0,
                        coverage: 0
                    });
                }
                // Extract header and split at first space or tab, keep only first part
                const fullHeader = line.substring(1);
                currentHeader = fullHeader.split(/[\s\t]/)[0]; // Split at first space or tab
                currentSequence = '';
            } else {
                currentSequence += line;
            }
        }
        
        // Add last sequence
        if (currentHeader && currentSequence) {
            const alignedSequence = currentSequence.replace(/[a-z]/g, '').toUpperCase();
            sequences.push({
                header: truncateSequenceName(currentHeader),
                sequence: alignedSequence,
                isPaired: false,
                similarity: 0,
                coverage: 0
            });
        }
        
        if (sequences.length === 0) return null;
        
        // Find query sequence (first one with header '>query' or first sequence)
        let queryIndex = sequences.findIndex(s => s.header.toLowerCase().includes('query'));
        if (queryIndex === -1) queryIndex = 0;
        
        const querySequence = sequences[queryIndex].sequence;
        const queryLength = querySequence.length;
        
        // Don't filter here - filtering will be done in setMSAData based on coverage slider
        // Sort by similarity (will be re-sorted after filtering in setMSAData)
        const sorted = sortSequencesBySimilarity(sequences, querySequence);
        
        return {
            sequences: sorted,
            querySequence: querySequence,
            queryLength: queryLength,
            queryIndex: queryIndex
        };
    }
    
    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            if (msaViewMode === 'msa') {
                renderMSACanvas();
            } else if (msaViewMode === 'pssm' || msaViewMode === 'weblogo') {
                renderWeblogoCanvas();
            }
        });
    }
    
    function getCanvasPositionFromMouse(e, canvas) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
        const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);
        
        const displayX = clientX - rect.left;
        const displayY = clientY - rect.top;
        
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        const scaleX = (canvas.width / dpiMultiplier) / rect.width;
        const scaleY = (canvas.height / dpiMultiplier) / rect.height;
        
        return {
            x: displayX * scaleX,
            y: displayY * scaleY
        };
    }
    
    function drawTickMarks(ctx, logicalWidth, scrollLeft, charWidth, scrollableAreaX, minX, maxX) {
        if (!msaData) return;
        
        const tickY = 0;
        const tickRowHeight = TICK_ROW_HEIGHT;
        
        // Draw white background for tick row
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, tickY, logicalWidth, tickRowHeight);
        
        // Calculate which tick marks are visible
        const visibleStartPos = Math.floor(scrollLeft / charWidth);
        const visibleEndPos = Math.min(msaData.queryLength, visibleStartPos + Math.ceil((maxX - minX) / charWidth) + 1);
        
        // Draw tick marks every 10 positions (1-indexed), plus position 1
        let xOffset = scrollableAreaX - (scrollLeft % charWidth);
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < msaData.queryLength; pos++) {
            // Draw at position 1 or positions divisible by 10 (1-indexed, so pos+1)
            if ((pos + 1) === 1 || (pos + 1) % TICK_INTERVAL === 0) {
                const tickX = xOffset;
                
                // Only draw if at least partially visible
                if (tickX + charWidth >= minX && tickX < maxX) {
                    const drawX = Math.max(minX, tickX);
                    const drawWidth = Math.min(charWidth, maxX - drawX);
                    const centerX = drawX + drawWidth / 2;
                    
                    // Draw position number (centered, no tick line)
                    ctx.fillStyle = '#333';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText((pos + 1).toString(), centerX, tickY + tickRowHeight / 2);
                }
            }
            xOffset += charWidth;
        }
    }
    
    function getPositionAtCanvasPosition(x, y) {
        if (!msaCanvasData || !msaData) return null;
        
        // Check if click is in sequence area (not name column or scrollbar)
        const SCROLLBAR_WIDTH = 15;
        const canvasWidth = msaCanvasData.canvas.width / (200/96);
        const canvasHeight = msaCanvasData.canvas.height / (200/96);
        const queryRowHeight = SEQUENCE_ROW_HEIGHT;
        const scrollableAreaX = NAME_COLUMN_WIDTH;
        const scrollableAreaY = TICK_ROW_HEIGHT + queryRowHeight; // MSA sequences start after tick + query
        
        // Check bounds - exclude name column, scrollbars
        if (x < scrollableAreaX || x > canvasWidth - SCROLLBAR_WIDTH) return null;
        if (y < 0 || y > canvasHeight - SCROLLBAR_WIDTH) return null;
        
        // Only allow selection on query row (sequenceIndex 0)
        // Query row is fixed below tick row (y=TICK_ROW_HEIGHT to y=TICK_ROW_HEIGHT+queryRowHeight)
        const queryY = TICK_ROW_HEIGHT;
        if (y < queryY || y >= queryY + queryRowHeight) {
            // Not clicking on query row - return null to disable selection
            return null;
        }
        
        // Account for horizontal scroll
        // MSA mode uses half-width characters
        const MSA_CHAR_WIDTH = CHAR_WIDTH / 2; // 10px for MSA mode
        const positionX = (x - scrollableAreaX) + scrollLeft;
        const position = Math.floor(positionX / MSA_CHAR_WIDTH);
        
        // Check bounds
        if (position < 0 || position >= msaData.queryLength) return null;
        
        return { position, sequenceIndex: 0 };
    }
    
    function computeSelectionFromPositionRange(startPos, endPos, initialSelection, unselectMode) {
        const [min, max] = [Math.min(startPos, endPos), Math.max(startPos, endPos)];
        const newAtoms = new Set(initialSelection);
        
        // Get renderer to map positions to atom indices
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return newAtoms;
        
        // Map MSA positions to atom indices (assuming 1:1 mapping for now)
        for (let pos = min; pos <= max; pos++) {
            if (unselectMode) {
                newAtoms.delete(pos);
            } else {
                newAtoms.add(pos);
            }
        }
        
        return newAtoms;
    }
    
    // Helper function to calculate scrollable area dimensions consistently
    function getScrollableAreaDimensions(canvasHeight) {
        const SCROLLBAR_WIDTH = 15;
        const queryRowHeight = SEQUENCE_ROW_HEIGHT;
        const scrollableAreaY = queryRowHeight; // No header row, no gap - MSA goes under query
        const scrollableAreaHeight = canvasHeight - scrollableAreaY - SCROLLBAR_WIDTH; // Exclude horizontal scrollbar
        return { scrollableAreaY, scrollableAreaHeight };
    }
    
    // Helper function to clamp scrollTop to valid bounds
    // Only updates scrollTop if it's outside valid bounds to prevent unnecessary re-renders
    function clampScrollTop(canvasHeight) {
        if (!msaData) return;
        
        const { scrollableAreaHeight } = getScrollableAreaDimensions(canvasHeight);
        const totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
        const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
        const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
        
        // Only update if actually changed to prevent unnecessary re-renders
        if (clampedScrollTop !== scrollTop) {
            scrollTop = clampedScrollTop;
        }
    }
    
    function getVisibleSequenceRange(canvasHeight) {
        if (!msaData || !msaCanvasData) return { start: 0, end: 0 };
        
        // Use actual canvas height for calculations
        const { scrollableAreaHeight } = getScrollableAreaDimensions(canvasHeight);
        
        // Clamp scrollTop to valid range to prevent overshooting
        clampScrollTop(canvasHeight);
        
        // Query sequence (index 0) is always fixed, not in scrollable area
        // Calculate which sequences are visible in scrollable area
        const startSequenceIndex = Math.max(1, Math.floor(scrollTop / SEQUENCE_ROW_HEIGHT));
        
        // Calculate how many rows fit in scrollable area
        const visibleRows = Math.ceil(scrollableAreaHeight / SEQUENCE_ROW_HEIGHT);
        // Add buffer for smooth scrolling
        const buffer = 10;
        const endSequenceIndex = Math.min(msaData.sequences.length, startSequenceIndex + visibleRows + buffer);
        
        return { start: startSequenceIndex, end: endSequenceIndex };
    }
    
    // ============================================================================
    // RENDERING FUNCTIONS
    // ============================================================================
    
    function renderMSACanvas() {
        if (!msaCanvasData || !msaData) return;
        
        const { canvas, ctx, container } = msaCanvasData;
        if (!canvas || !ctx) return;
        
        // Get logical dimensions (after DPI scaling)
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        const logicalWidth = canvas.width / dpiMultiplier;
        const logicalHeight = canvas.height / dpiMultiplier;
        
        // Clear canvas with white background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);
        
        // Get scroll position and visible range (using canvas-based scroll)
        // Clamp scrollTop first to prevent overshooting
        clampScrollTop(logicalHeight);
        const currentScrollTop = scrollTop;
        const visibleRange = getVisibleSequenceRange(logicalHeight);
        visibleSequenceStart = visibleRange.start;
        visibleSequenceEnd = visibleRange.end;
        
        // Get selection state for fading (not hiding) - use same logic as viewer-seq
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;
        
        const previewSelectionSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
        
        // Determine visible atoms - use same logic as viewer-seq
        let visibleAtoms = new Set();
        
        if (previewSelectionSet && previewSelectionSet.size > 0) {
            // During drag, use preview selection for live feedback (already atom indices)
            visibleAtoms = new Set(previewSelectionSet);
        } else {
            // Use atoms directly from selection model (same as viewer-seq)
            if (renderer.selectionModel && renderer.selectionModel.atoms && renderer.selectionModel.atoms.size > 0) {
                visibleAtoms = new Set(renderer.selectionModel.atoms);
            } else if (renderer.visibilityMask === null) {
                // null mask means all atoms are visible (default mode)
                for (let i = 0; i < msaData.queryLength; i++) {
                    visibleAtoms.add(i);
                }
            } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                // Non-empty Set means some atoms are visible
                visibleAtoms = new Set(renderer.visibilityMask);
            }
        }
        
        // Use dimFactor for fading (same as viewer-seq)
        const dimFactor = 0.3;
        
        // MSA mode uses half-width characters
        const MSA_CHAR_WIDTH = CHAR_WIDTH / 2; // 10px for MSA mode
        
        // Fixed areas: tick row, query row, name column
        const SCROLLBAR_WIDTH = 15;
        const queryRowHeight = SEQUENCE_ROW_HEIGHT;
        const queryY = TICK_ROW_HEIGHT; // Query row starts after tick row
        const scrollableAreaY = TICK_ROW_HEIGHT + queryRowHeight; // MSA sequences start after tick + query
        const scrollableAreaHeight = logicalHeight - scrollableAreaY - SCROLLBAR_WIDTH; // Exclude horizontal scrollbar
        const scrollableAreaX = NAME_COLUMN_WIDTH;
        const scrollableAreaWidth = logicalWidth - scrollableAreaX - SCROLLBAR_WIDTH; // Exclude vertical scrollbar
        
        // Draw fixed name column background (for all rows)
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, NAME_COLUMN_WIDTH, logicalHeight);
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, NAME_COLUMN_WIDTH, logicalHeight);
        
        // Draw tick marks (position numbers) at the top
        const minX = scrollableAreaX;
        const maxX = logicalWidth - SCROLLBAR_WIDTH;
        drawTickMarks(ctx, logicalWidth, scrollLeft, MSA_CHAR_WIDTH, scrollableAreaX, minX, maxX);
        
        // Calculate visible position range (accounting for horizontal scroll)
        const visibleStartPos = Math.floor(scrollLeft / MSA_CHAR_WIDTH);
        const visibleEndPos = Math.min(msaData.queryLength, visibleStartPos + Math.ceil(scrollableAreaWidth / MSA_CHAR_WIDTH) + 1);
        
        // Draw visible sequences FIRST (virtual scrolling) - so query can be drawn on top
        // Sequences can scroll under the query row
        // Calculate startY to align with scrollable area
        const scrollOffset = currentScrollTop % SEQUENCE_ROW_HEIGHT;
        const startY = scrollableAreaY - scrollOffset;
        
        for (let i = visibleSequenceStart; i < visibleSequenceEnd && i < msaData.sequences.length; i++) {
            if (i === 0) continue; // Skip query (already drawn)
            
            const seq = msaData.sequences[i];
            const sequenceOffset = (i - visibleSequenceStart) * SEQUENCE_ROW_HEIGHT;
            const y = startY + sequenceOffset;
            
            // Allow sequences to scroll past visible area - we'll clip them with overlay bars
            // No bounds check here - draw all sequences in the visible range
            
            // Draw fixed name in name column
            ctx.fillStyle = '#333';
            ctx.font = '12px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(seq.header, 5, y + SEQUENCE_ROW_HEIGHT / 2);
            
            // Draw sequence - only visible positions (scrollable horizontally)
            // Don't draw in name column or scrollbar area
            const minX = scrollableAreaX; // Don't draw in name column
            const maxX = logicalWidth - SCROLLBAR_WIDTH; // Don't draw in scrollbar
            const maxY = logicalHeight - SCROLLBAR_WIDTH;
            if (y >= maxY) continue; // Don't draw sequences in horizontal scrollbar area
            
            let xOffset = scrollableAreaX - (scrollLeft % MSA_CHAR_WIDTH);
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < seq.sequence.length; pos++) {
                // Check bounds before drawing - skip if outside scrollable area
                if (xOffset + MSA_CHAR_WIDTH < minX) {
                    // Not yet in scrollable area, continue
                    xOffset += MSA_CHAR_WIDTH;
                    continue;
                }
                if (xOffset >= maxX) break; // Past scrollbar, stop
                
                const aa = seq.sequence[pos];
                const color = getDayhoffColor(aa);
                const isSelected = visibleAtoms.has(pos);
                
                // Apply dimming if not selected (same as viewer-seq)
                let r = color.r;
                let g = color.g;
                let b = color.b;
                if (!isSelected) {
                    r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
                    g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
                    b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
                }
                
                // Clip drawing to scrollable area
                const drawX = Math.max(minX, xOffset);
                const drawWidth = Math.min(MSA_CHAR_WIDTH, maxX - drawX);
                if (drawWidth > 0) {
                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.fillRect(drawX, y, drawWidth, SEQUENCE_ROW_HEIGHT);
                    
                    // Draw text if at least partially visible - center in the actual drawn box
                    if (drawWidth > 0) {
                        ctx.fillStyle = '#000';
                        ctx.font = '10px monospace';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        // Center text in the actual drawn box (drawX + drawWidth/2) for clipped boxes
                        const textX = drawX + drawWidth / 2;
                        ctx.fillText(aa, textX, y + SEQUENCE_ROW_HEIGHT / 2);
                    }
                }
                
            xOffset += MSA_CHAR_WIDTH;
        }
    }
    
    // Draw query sequence LAST (on top of MSA sequences) - always fixed below tick row
    if (msaData.sequences.length > 0) {
        const querySeq = msaData.sequences[0];
        // queryY already defined above as TICK_ROW_HEIGHT
        
        // Draw white background for query row to make it appear on top of MSA sequences
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, queryY, logicalWidth, queryRowHeight);
        
        // Draw fixed name in name column
        ctx.fillStyle = '#333';
        ctx.font = '12px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(querySeq.header, 5, queryY + queryRowHeight / 2);
        
        // Draw query sequence - only visible positions (scrollable horizontally)
        // Don't draw in name column or scrollbar area
        const minX = scrollableAreaX; // Don't draw in name column
        const maxX = logicalWidth - SCROLLBAR_WIDTH; // Don't draw in scrollbar
        let xOffset = scrollableAreaX - (scrollLeft % MSA_CHAR_WIDTH);
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < querySeq.sequence.length; pos++) {
            // Check bounds before drawing - skip if outside scrollable area
            if (xOffset + MSA_CHAR_WIDTH < minX) {
                // Not yet in scrollable area, continue
                xOffset += MSA_CHAR_WIDTH;
                continue;
            }
            if (xOffset >= maxX) break; // Past scrollbar, stop
            
            const aa = querySeq.sequence[pos];
            const color = getDayhoffColor(aa);
            const isSelected = visibleAtoms.has(pos);
            
            // Apply dimming if not selected (same as viewer-seq)
            let r = color.r;
            let g = color.g;
            let b = color.b;
            if (!isSelected) {
                r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
                g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
                b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
            }
            
            // Clip drawing to scrollable area
            const drawX = Math.max(minX, xOffset);
            const drawWidth = Math.min(MSA_CHAR_WIDTH, maxX - drawX);
            if (drawWidth > 0) {
                ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                ctx.fillRect(drawX, queryY, drawWidth, queryRowHeight);
                
                // Draw text if at least partially visible (center in the drawn box)
                if (drawWidth > 0) {
                    ctx.fillStyle = '#000';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    // Center text in the actual drawn box (drawX + drawWidth/2) for clipped boxes
                    const textX = drawX + drawWidth / 2;
                    ctx.fillText(aa, textX, queryY + queryRowHeight / 2);
                }
            }
            
            xOffset += MSA_CHAR_WIDTH;
        }
        
        // Draw underline under query sequence
        const underlineY = queryY + queryRowHeight;
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, underlineY);
        ctx.lineTo(logicalWidth, underlineY);
        ctx.stroke();
    }
    
    // Draw custom scrollbars on canvas (in bottom-right corner, overlapping scrollable area)
    drawScrollbars(ctx, logicalWidth, logicalHeight, scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight);
}
    
    function drawScrollbars(ctx, canvasWidth, canvasHeight, scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight) {
        if (!msaCanvasData || !msaData) {
            console.warn('MSA Viewer: Cannot draw scrollbars - missing data');
            return;
        }
        
        const SCROLLBAR_WIDTH = 15;
        const SCROLLBAR_PADDING = 2;
        
        // Calculate scrollable content dimensions (excluding fixed header and query row)
        const totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT; // Exclude query row
        // MSA mode uses half-width characters
        const MSA_CHAR_WIDTH = CHAR_WIDTH / 2; // 10px for MSA mode
        const totalScrollableWidth = msaData.queryLength * MSA_CHAR_WIDTH; // Sequence width only (excluding name column)
        
        // Vertical scrollbar: right edge, from scrollable area to just above horizontal scrollbar
        const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
        const scrollRatio = maxScroll > 0 ? scrollTop / maxScroll : 0;
        const vScrollbarHeight = scrollableAreaHeight; // Height of scrollable area (excludes header, query, and horizontal scrollbar)
        const thumbHeight = Math.max(20, (vScrollbarHeight / totalScrollableHeight) * vScrollbarHeight);
        const thumbY = scrollableAreaY + scrollRatio * (vScrollbarHeight - thumbHeight);
        
        // Draw vertical scrollbar track (in scrollable area, right edge) - modern style
        const vScrollbarX = canvasWidth - SCROLLBAR_WIDTH;
        ctx.fillStyle = '#f0f0f0'; // Light gray track (modern)
        ctx.fillRect(vScrollbarX, scrollableAreaY, SCROLLBAR_WIDTH, vScrollbarHeight);
        
        // Draw vertical scrollbar thumb - modern style
        if (maxScroll > 0) {
            ctx.fillStyle = '#b0b0b0'; // Medium gray thumb (modern, more visible)
            ctx.fillRect(vScrollbarX + SCROLLBAR_PADDING, thumbY, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2, thumbHeight);
        } else {
            // Draw full-height thumb when no scrolling needed
            ctx.fillStyle = '#d0d0d0'; // Lighter gray when no scroll needed
            ctx.fillRect(vScrollbarX + SCROLLBAR_PADDING, scrollableAreaY, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2, vScrollbarHeight);
        }
        
        // Horizontal scrollbar: bottom edge, from name column to just before vertical scrollbar
        const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
        const scrollRatioX = maxScrollX > 0 ? scrollLeft / maxScrollX : 0;
        const hScrollbarWidth = scrollableAreaWidth; // Width of scrollable area (excludes name column and vertical scrollbar)
        const thumbWidth = Math.max(20, (hScrollbarWidth / totalScrollableWidth) * hScrollbarWidth);
        const thumbX = scrollableAreaX + scrollRatioX * (hScrollbarWidth - thumbWidth);
        
        // Draw white box over name column at bottom to hide overshooting sequence names
        // Also display current scroll position information
        const hScrollbarY = canvasHeight - SCROLLBAR_WIDTH;
        ctx.fillStyle = '#ffffff'; // White to hide overshooting text
        ctx.fillRect(0, hScrollbarY, scrollableAreaX, SCROLLBAR_WIDTH);
        
        // Calculate and display current position range in a centered box
        // Box matches scrollbar height and name column width
        if (msaData && msaData.queryLength > 0) {
            const MSA_CHAR_WIDTH = CHAR_WIDTH / 2; // 10px for MSA mode
            const visibleStartPos = Math.floor(scrollLeft / MSA_CHAR_WIDTH);
            const visibleEndPos = Math.min(msaData.queryLength, visibleStartPos + Math.ceil(scrollableAreaWidth / MSA_CHAR_WIDTH));
            const positionText = `${visibleStartPos + 1}-${visibleEndPos} / ${msaData.queryLength}`;
            
            // Box dimensions: match name column width and scrollbar height
            const boxWidth = scrollableAreaX; // NAME_COLUMN_WIDTH
            const boxHeight = SCROLLBAR_WIDTH;
            const boxX = 0; // Start at left edge (name column area)
            const boxY = hScrollbarY; // Match scrollbar position
            
            // Draw box background (white)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
            
            // Draw box border
            ctx.strokeStyle = '#999';
            ctx.lineWidth = 1;
            ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);
            
            // Draw text centered in box
            ctx.fillStyle = '#333';
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(positionText, boxWidth / 2, boxY + boxHeight / 2);
        }
        
        // Draw horizontal scrollbar track (in scrollable area, bottom edge) - modern style
        // SCROLLBAR_PADDING already defined above
        ctx.fillStyle = '#f0f0f0'; // Light gray track (modern)
        ctx.fillRect(scrollableAreaX, hScrollbarY, hScrollbarWidth, SCROLLBAR_WIDTH);
        
        if (maxScrollX > 0) {
            // Draw horizontal scrollbar thumb - modern style
            ctx.fillStyle = '#b0b0b0'; // Medium gray thumb (modern, more visible)
            ctx.fillRect(thumbX, hScrollbarY + SCROLLBAR_PADDING, thumbWidth, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2);
        } else {
            // Draw full-width thumb when no scrolling needed
            ctx.fillStyle = '#d0d0d0'; // Lighter gray when no scroll needed
            ctx.fillRect(scrollableAreaX, hScrollbarY + SCROLLBAR_PADDING, hScrollbarWidth, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2);
        }
        
        // No borders around scrollbars in MSA mode
    }
    
    function calculateFrequencies() {
        if (!msaData) return null;
        
        // Create a simple hash to detect data changes
        const dataHash = msaData.sequences.length + '_' + msaData.queryLength;
        
        // Return cached data if available and data hasn't changed
        if (cachedFrequencies && cachedDataHash === dataHash) {
            return cachedFrequencies;
        }
        
        // Calculate frequencies
        const frequencies = [];
        const queryLength = msaData.queryLength;
        
        for (let pos = 0; pos < queryLength; pos++) {
            const counts = {};
            let total = 0;
            
            for (const seq of msaData.sequences) {
                if (pos < seq.sequence.length) {
                    const aa = seq.sequence[pos].toUpperCase();
                    if (aa !== '-' && aa !== 'X') {
                        counts[aa] = (counts[aa] || 0) + 1;
                        total++;
                    }
                }
            }
            
            const freq = {};
            for (const aa in counts) {
                freq[aa] = counts[aa] / total;
            }
            frequencies.push(freq);
        }
        
        // Cache the results
        cachedFrequencies = frequencies;
        cachedDataHash = dataHash;
        cachedLogOdds = null; // Invalidate log-odds cache
        
        return frequencies;
    }
    
    function calculateLogOdds(frequencies) {
        if (!frequencies) return null;
        
        // Return cached data if available
        if (cachedLogOdds) {
            return cachedLogOdds;
        }
        
        // Background frequencies (uniform for simplicity, could use BLOSUM background)
        const backgroundFreq = 1 / 20;
        
        const logOdds = [];
        for (const freq of frequencies) {
            const logOddsPos = {};
            for (const aa in freq) {
                logOddsPos[aa] = Math.log2(freq[aa] / backgroundFreq);
            }
            logOdds.push(logOddsPos);
        }
        
        // Cache the results
        cachedLogOdds = logOdds;
        
        return logOdds;
    }
    
    function renderWeblogoCanvas() {
        if (!weblogoCanvasData || !msaData) return;
        
        const { canvas, ctx } = weblogoCanvasData;
        if (!canvas || !ctx) return;
        
        // Get logical dimensions (after DPI scaling)
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        const logicalWidth = canvas.width / dpiMultiplier;
        const logicalHeight = canvas.height / dpiMultiplier;
        
        // Clear canvas with white background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);
        
        // Use cached frequencies (only recalculate if data changed)
        const frequencies = calculateFrequencies();
        if (!frequencies) return;
        
        // Use cached log-odds if available, otherwise calculate and cache
        const data = msaViewMode === 'pssm' 
            ? frequencies 
            : (cachedLogOdds || calculateLogOdds(frequencies));
        if (!data) return;
        
        const SCROLLBAR_WIDTH = 15;
        const GAP_HEIGHT = 0; // No gap between query and weblogo
        // Make query row square (same height as CHAR_WIDTH)
        const queryRowHeight = CHAR_WIDTH;
        const CHAR_HEIGHT = 15; // Used for stacked logo mode only
        
        // Get selection state for fading (not hiding) - use same logic as viewer-seq
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;
        
        const previewSelectionSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
        
        // Determine visible atoms - use same logic as viewer-seq
        let visibleAtoms = new Set();
        
        if (previewSelectionSet && previewSelectionSet.size > 0) {
            // During drag, use preview selection for live feedback (already atom indices)
            visibleAtoms = new Set(previewSelectionSet);
        } else {
            // Use atoms directly from selection model (same as viewer-seq)
            if (renderer.selectionModel && renderer.selectionModel.atoms && renderer.selectionModel.atoms.size > 0) {
                visibleAtoms = new Set(renderer.selectionModel.atoms);
            } else if (renderer.visibilityMask === null) {
                // null mask means all atoms are visible (default mode)
                for (let i = 0; i < msaData.queryLength; i++) {
                    visibleAtoms.add(i);
                }
            } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                // Non-empty Set means some atoms are visible
                visibleAtoms = new Set(renderer.visibilityMask);
            }
        }
        
        // Use dimFactor for fading (same as viewer-seq)
        const dimFactor = 0.3;
        
        // Calculate visible position range (accounting for horizontal scroll)
        // In heatmap mode, account for label width (same as CHAR_WIDTH); in stacked logo mode, start from 0
        const LABEL_WIDTH = msaViewMode === 'pssm' ? CHAR_WIDTH : 0;
        const scrollableAreaX = LABEL_WIDTH;
        const scrollableAreaWidth = logicalWidth - LABEL_WIDTH - SCROLLBAR_WIDTH;
        const visibleStartPos = Math.floor(scrollLeft / CHAR_WIDTH);
        const visibleEndPos = Math.min(data.length, visibleStartPos + Math.ceil(scrollableAreaWidth / CHAR_WIDTH) + 1);
        
        // Draw tick marks at the top
        const tickMinX = LABEL_WIDTH;
        const tickMaxX = logicalWidth - SCROLLBAR_WIDTH;
        drawTickMarks(ctx, logicalWidth, scrollLeft, CHAR_WIDTH, LABEL_WIDTH, tickMinX, tickMaxX);
        
        // Draw query sequence below tick row
        const queryY = TICK_ROW_HEIGHT; // Query row starts after tick row
        if (msaData.sequences.length > 0) {
            const querySeq = msaData.sequences[0];
            
            // Draw query sequence - only visible positions (scrollable horizontally)
            // Align with heatmap (starts at LABEL_WIDTH in heatmap mode)
            const minX = LABEL_WIDTH; // Start from label width to align with heatmap
            const maxX = logicalWidth - SCROLLBAR_WIDTH; // Don't draw in scrollbar
            let xOffset = scrollableAreaX - (scrollLeft % CHAR_WIDTH);
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < querySeq.sequence.length; pos++) {
                // Check bounds before drawing
                if (xOffset + CHAR_WIDTH < minX) {
                    // Not yet visible, continue
                    xOffset += CHAR_WIDTH;
                    continue;
                }
                if (xOffset >= maxX) break; // Past scrollbar, stop
                // Allow drawing even if partially visible (will be clipped)
                
                const aa = querySeq.sequence[pos];
                const color = getDayhoffColor(aa);
                const isSelected = visibleAtoms.has(pos);
                
                // Apply dimming if not selected (same as viewer-seq)
                let r = color.r;
                let g = color.g;
                let b = color.b;
                if (!isSelected) {
                    r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
                    g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
                    b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
                }
                
                // Clip drawing to visible area
                const drawX = Math.max(minX, xOffset);
                const drawWidth = Math.min(CHAR_WIDTH, maxX - drawX);
                if (drawWidth > 0) {
                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.fillRect(drawX, queryY, drawWidth, queryRowHeight);
                    
                    // Draw text if at least partially visible (center in the drawn box)
                    if (drawWidth > 0) {
                        ctx.fillStyle = '#000';
                        ctx.font = '10px monospace';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(aa, drawX + drawWidth / 2, queryY + queryRowHeight / 2);
                    }
                }
                
                xOffset += CHAR_WIDTH;
            }
        }
        
        // Draw weblogo below query sequence with gap
        const weblogoY = TICK_ROW_HEIGHT + queryRowHeight + GAP_HEIGHT;
        
        // Define 20 standard amino acids grouped by Dayhoff groups
        const AMINO_ACIDS = [
            // Group 1: Small polar
            'A', 'S', 'T', 'P', 'G',
            // Group 2: Hydrophobic
            'C', 'V', 'I', 'L', 'M',
            // Group 3: Aromatic
            'F', 'Y', 'W',
            // Group 4: Basic
            'H', 'K', 'R',
            // Group 5: Acidic
            'D', 'E',
            // Group 6: Amide
            'N', 'Q'
        ];
        const NUM_AMINO_ACIDS = AMINO_ACIDS.length;
        // Make each amino acid row square (same height as CHAR_WIDTH)
        const aaRowHeight = CHAR_WIDTH;
        // Calculate weblogo height to fit exactly NUM_AMINO_ACIDS square rows
        const weblogoHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        
        // No name column in weblogo, but need to avoid scrollbar
        const minX = 0;
        const maxX = logicalWidth - SCROLLBAR_WIDTH;
        
        if (msaViewMode === 'pssm') {
            // HEATMAP MODE: Draw heatmap for probabilities
            // Each row is one amino acid, color from white (0) to black (1)
            
            // Draw amino acid labels on the left (if space allows)
            // LABEL_WIDTH already defined above
            const heatmapX = LABEL_WIDTH;
            const heatmapWidth = logicalWidth - LABEL_WIDTH - SCROLLBAR_WIDTH;
            
            // Draw labels with same style as query sequence (colored boxes with centered text)
            for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
                const aa = AMINO_ACIDS[i];
                const y = weblogoY + i * aaRowHeight;
                const dayhoffColor = getDayhoffColor(aa);
                
                // Draw colored box background (same as query sequence)
                ctx.fillStyle = `rgb(${dayhoffColor.r}, ${dayhoffColor.g}, ${dayhoffColor.b})`;
                ctx.fillRect(0, y, LABEL_WIDTH, aaRowHeight);
                
                // Draw centered text (same as query sequence)
                ctx.fillStyle = '#000';
                ctx.font = '10px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(aa, LABEL_WIDTH / 2, y + aaRowHeight / 2);
            }
            
            // Draw heatmap
            let xOffset = heatmapX - (scrollLeft % CHAR_WIDTH);
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < data.length; pos++) {
                // Check bounds before drawing
                if (xOffset + CHAR_WIDTH < heatmapX) {
                    xOffset += CHAR_WIDTH;
                    continue;
                }
                // Allow drawing even if partially visible (will be clipped)
                // Only break if completely past the visible area
                if (xOffset >= maxX) break;
                
                const posData = data[pos];
                const isSelected = visibleAtoms.has(pos);
                const logoDimFactor = isSelected ? 1.0 : dimFactor;
                
                // Draw each amino acid row
                for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
                    const aa = AMINO_ACIDS[i];
                    const probability = posData[aa] || 0;
                    const y = weblogoY + i * aaRowHeight;
                    
                    // Convert probability (0-1) to grayscale (white to black)
                    // White (255,255,255) at 0, Black (0,0,0) at 1
                    const grayValue = Math.round(255 * (1 - probability));
                    let r = grayValue;
                    let g = grayValue;
                    let b = grayValue;
                    
                    // Apply dimming if not selected
                    if (!isSelected) {
                        r = Math.round(r * logoDimFactor + 255 * (1 - logoDimFactor));
                        g = Math.round(g * logoDimFactor + 255 * (1 - logoDimFactor));
                        b = Math.round(b * logoDimFactor + 255 * (1 - logoDimFactor));
                    }
                    
                    // Clip drawing to visible area
                    const drawX = Math.max(heatmapX, xOffset);
                    const drawWidth = Math.min(CHAR_WIDTH, maxX - drawX);
                    if (drawWidth > 0) {
                        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                        ctx.fillRect(drawX, y, drawWidth, aaRowHeight);
                    }
                }
                
                xOffset += CHAR_WIDTH;
            }
        } else {
            // STACKED LOGO MODE: Draw stacked logo for log-odds/bit scores
            let xOffset = scrollableAreaX - (scrollLeft % CHAR_WIDTH);
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < data.length; pos++) {
                // Check bounds before drawing
                if (xOffset + CHAR_WIDTH < minX) {
                    // Not yet visible, continue
                    xOffset += CHAR_WIDTH;
                    continue;
                }
                if (xOffset >= maxX) break; // Past scrollbar, stop
                
                const posData = data[pos];
                const aas = Object.keys(posData).sort((a, b) => posData[b] - posData[a]); // Sort descending (highest first)
                
                const isSelected = visibleAtoms.has(pos);
                
                // Apply dimming to weblogo if position is not selected
                let logoDimFactor = isSelected ? 1.0 : dimFactor;
                
                // Start from top of weblogo area - highest probabilities will be on top
                let yOffset = weblogoY;
                for (const aa of aas) {
                    const value = posData[aa];
                    const height = Math.max(0, value * CHAR_HEIGHT);
                    
                    if (height > 0) {
                        const color = getDayhoffColor(aa);
                        
                        // Apply dimming if not selected
                        let r = color.r;
                        let g = color.g;
                        let b = color.b;
                        if (!isSelected) {
                            r = Math.round(r * logoDimFactor + 255 * (1 - logoDimFactor));
                            g = Math.round(g * logoDimFactor + 255 * (1 - logoDimFactor));
                            b = Math.round(b * logoDimFactor + 255 * (1 - logoDimFactor));
                        }
                        
                        // Clip drawing to visible area
                        const drawX = Math.max(minX, xOffset);
                        const drawWidth = Math.min(CHAR_WIDTH, maxX - drawX);
                        if (drawWidth > 0) {
                            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                            // Draw downward from current yOffset
                            ctx.fillRect(drawX, yOffset, drawWidth, height);
                        }
                    }
                    
                    // Move down for next amino acid (stacking downward)
                    yOffset += height;
                }
                
                xOffset += CHAR_WIDTH;
            }
        }
        
        // Draw horizontal scrollbar (aligned with heatmap/query sequence)
        const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH; // Full width of sequence
        const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
        if (maxScrollX > 0) {
            const scrollRatioX = scrollLeft / maxScrollX;
            const thumbWidth = Math.max(20, (scrollableAreaWidth / totalScrollableWidth) * scrollableAreaWidth);
            const thumbX = scrollableAreaX + scrollRatioX * (scrollableAreaWidth - thumbWidth); // Start from scrollableAreaX (LABEL_WIDTH)
            const hScrollbarY = logicalHeight - SCROLLBAR_WIDTH;
            const SCROLLBAR_PADDING = 2;
            
            // Draw white background for label area (to hide overshooting)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, hScrollbarY, LABEL_WIDTH, SCROLLBAR_WIDTH);
            
            // Draw track (aligned with scrollable area) - modern style
            ctx.fillStyle = '#f0f0f0'; // Light gray track (modern)
            ctx.fillRect(scrollableAreaX, hScrollbarY, scrollableAreaWidth, SCROLLBAR_WIDTH);
            
            // Draw thumb - modern style
            ctx.fillStyle = '#b0b0b0'; // Medium gray thumb (modern, more visible)
            ctx.fillRect(thumbX, hScrollbarY + SCROLLBAR_PADDING, thumbWidth, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2);
        } else {
            // Draw white background for label area even when no scrolling
            const hScrollbarY = logicalHeight - SCROLLBAR_WIDTH;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, hScrollbarY, LABEL_WIDTH, SCROLLBAR_WIDTH);
            
            // Draw full-width track - modern style
            ctx.fillStyle = '#f0f0f0'; // Light gray track (modern)
            ctx.fillRect(scrollableAreaX, hScrollbarY, scrollableAreaWidth, SCROLLBAR_WIDTH);
        }
        
        // Add selection handler for query sequence in weblogo view
        // (Selection is only allowed on query row, handled by getPositionAtCanvasPosition)
    }
    
    // ============================================================================
    // EVENT HANDLERS
    // ============================================================================
    
    function setupCanvasMSAEvents() {
        if (!msaCanvasData) return;
        
        const { canvas, container } = msaCanvasData;
        if (!canvas || !container) return;
        
        // Remove old listeners by cloning
        const newCanvas = canvas.cloneNode(false);
        canvas.parentNode.replaceChild(newCanvas, msaCanvasData.canvas);
        msaCanvasData.canvas = newCanvas;
        msaCanvasData.ctx = newCanvas.getContext('2d');
        
        // Apply DPI scaling
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        msaCanvasData.ctx.scale(dpiMultiplier, dpiMultiplier);
        
        // Canvas-based scrolling - handle mouse wheel
        let scrollbarDragState = {
            isDragging: false,
            dragType: null, // 'vertical' or 'horizontal'
            dragStartY: 0,
            dragStartScroll: 0,
            hasMoved: false, // Track if user has actually moved during drag
            clickOffset: 0 // Offset from click position to thumb center
        };
        
        newCanvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            
            const canvasWidth = newCanvas.width / dpiMultiplier;
            const canvasHeight = newCanvas.height / dpiMultiplier;
            const SCROLLBAR_WIDTH = 15;
            const scrollableAreaX = NAME_COLUMN_WIDTH;
            const scrollableAreaWidth = canvasWidth - scrollableAreaX - SCROLLBAR_WIDTH;
            // MSA mode uses half-width characters
            const MSA_CHAR_WIDTH = CHAR_WIDTH / 2; // 10px for MSA mode
            const totalScrollableWidth = msaData.queryLength * MSA_CHAR_WIDTH;
            const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
            
            // Handle horizontal scrolling
            // Check deltaX first (for trackpads with horizontal scrolling)
            // Also check if shift key is pressed (alternative horizontal scroll method)
            const hasHorizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const isShiftScroll = e.shiftKey && Math.abs(e.deltaY) > 0;
            
            if (hasHorizontalDelta || isShiftScroll) {
                const delta = hasHorizontalDelta ? e.deltaX : (isShiftScroll ? e.deltaY : 0);
                if (delta !== 0 && maxScrollX > 0) {
                    scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft + delta));
                    scheduleRender();
                    return; // Don't process vertical scroll if horizontal scroll was handled
                }
            }
            
            // Handle vertical scrolling (only if no horizontal scroll)
            if (Math.abs(e.deltaY) > 0 && !hasHorizontalDelta && !isShiftScroll) {
                // Use consistent calculation for scrollable area
                const { scrollableAreaHeight } = getScrollableAreaDimensions(canvasHeight);
                const totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
                const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
                
                // Update scrollTop with proper clamping
                scrollTop = Math.max(0, Math.min(maxScroll, scrollTop + e.deltaY));
                // Clamp again to ensure no overshooting
                clampScrollTop(canvasHeight);
                scheduleRender();
            }
        }, { passive: false });
        
        // Handle scrollbar dragging and position selection in single mousedown handler
        newCanvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const SCROLLBAR_WIDTH = 15;
            const canvasWidth = newCanvas.width / dpiMultiplier;
            const canvasHeight = newCanvas.height / dpiMultiplier;
            
            // First check if clicking on vertical scrollbar (right edge, in scrollable area)
            // Must match the calculation in renderMSACanvas (no header row, no gap - MSA goes under query)
            const queryRowHeight = SEQUENCE_ROW_HEIGHT;
            const scrollableAreaY = queryRowHeight; // No header row, no gap - MSA goes under query
            const scrollableAreaHeight = canvasHeight - scrollableAreaY - SCROLLBAR_WIDTH; // Exclude horizontal scrollbar
            const totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
            const vScrollbarX = canvasWidth - SCROLLBAR_WIDTH;
            const vScrollbarYEnd = canvasHeight - SCROLLBAR_WIDTH; // Just above horizontal scrollbar
            
            if (pos.x >= vScrollbarX && pos.x <= canvasWidth && pos.y >= scrollableAreaY && pos.y < vScrollbarYEnd) {
                // Ensure scrollTop is clamped before calculating scrollbar position
                clampScrollTop(canvasHeight);
                
                const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
                const scrollRatio = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0;
                const thumbHeight = Math.max(20, (scrollableAreaHeight / totalScrollableHeight) * scrollableAreaHeight);
                const thumbY = scrollableAreaY + scrollRatio * (scrollableAreaHeight - thumbHeight);
                
                if (pos.y >= thumbY && pos.y <= thumbY + thumbHeight) {
                    // Clicked on thumb - start dragging
                    // Calculate offset from click position to thumb center to maintain relative position
                    const thumbCenterY = thumbY + thumbHeight / 2;
                    const clickOffsetFromCenter = pos.y - thumbCenterY;
                    
                    scrollbarDragState.isDragging = true;
                    scrollbarDragState.dragType = 'vertical';
                    scrollbarDragState.dragStartY = pos.y;
                    scrollbarDragState.dragStartScroll = scrollTop;
                    scrollbarDragState.hasMoved = false; // Track if user has actually moved
                    scrollbarDragState.clickOffset = clickOffsetFromCenter; // Store offset for smooth dragging
                    e.preventDefault();
                    
                    const handleScrollbarDrag = (e) => {
                        if (!scrollbarDragState.isDragging) return;
                        const dragPos = getCanvasPositionFromMouse(e, newCanvas);
                        // Calculate movement from the original click position
                        const deltaY = dragPos.y - scrollbarDragState.dragStartY;
                        
                        // Only update scroll if user has moved at least 2 pixels (prevents jump on click)
                        // This threshold prevents accidental jumps from tiny mouse movements
                        if (Math.abs(deltaY) > 2) {
                            scrollbarDragState.hasMoved = true;
                            // Calculate scroll delta based on movement, accounting for the click offset
                            const scrollDelta = (deltaY / (scrollableAreaHeight - thumbHeight)) * maxScroll;
                            scrollTop = Math.max(0, Math.min(maxScroll, scrollbarDragState.dragStartScroll + scrollDelta));
                            // Clamp again to ensure no overshooting
                            clampScrollTop(canvasHeight);
                            scheduleRender();
                        }
                    };
                    
                    const handleScrollbarDragEnd = () => {
                        scrollbarDragState.isDragging = false;
                        scrollbarDragState.dragType = null;
                        scrollbarDragState.hasMoved = false;
                        window.removeEventListener('mousemove', handleScrollbarDrag);
                        window.removeEventListener('mouseup', handleScrollbarDragEnd);
                    };
                    
                    window.addEventListener('mousemove', handleScrollbarDrag);
                    window.addEventListener('mouseup', handleScrollbarDragEnd);
                    return;
                } else if (pos.y >= scrollableAreaY) {
                    // Clicked on track - jump to position
                    const newScrollRatio = Math.max(0, Math.min(1, (pos.y - scrollableAreaY - thumbHeight / 2) / (scrollableAreaHeight - thumbHeight)));
                    scrollTop = Math.max(0, Math.min(maxScroll, newScrollRatio * maxScroll));
                    // Clamp to ensure no overshooting
                    clampScrollTop(canvasHeight);
                    scheduleRender();
                    e.preventDefault();
                    return;
                }
            }
            
            // Check if clicking on horizontal scrollbar (bottom edge, in scrollable area)
            const scrollableAreaX = NAME_COLUMN_WIDTH;
            const scrollableAreaWidth = canvasWidth - scrollableAreaX - SCROLLBAR_WIDTH;
            // MSA mode uses half-width characters
            const MSA_CHAR_WIDTH = CHAR_WIDTH / 2; // 10px for MSA mode
            const totalScrollableWidth = msaData.queryLength * MSA_CHAR_WIDTH;
            const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
            const hScrollbarY = canvasHeight - SCROLLBAR_WIDTH;
            const hScrollbarXEnd = canvasWidth - SCROLLBAR_WIDTH; // Just before vertical scrollbar
            
            // Check if click is in horizontal scrollbar area (bottom of canvas, in scrollable area)
            if (pos.y >= hScrollbarY && pos.y <= canvasHeight && pos.x >= scrollableAreaX && pos.x < hScrollbarXEnd) {
                if (maxScrollX > 0) {
                    const scrollRatioX = scrollLeft / maxScrollX;
                    const thumbWidth = Math.max(20, (scrollableAreaWidth / totalScrollableWidth) * scrollableAreaWidth);
                    const thumbX = scrollableAreaX + scrollRatioX * (scrollableAreaWidth - thumbWidth);
                    
                    if (pos.x >= thumbX && pos.x <= thumbX + thumbWidth) {
                        // Clicked on thumb - start dragging
                        scrollbarDragState.isDragging = true;
                        scrollbarDragState.dragType = 'horizontal';
                        scrollbarDragState.dragStartY = pos.x;
                        scrollbarDragState.dragStartScroll = scrollLeft;
                        scrollbarDragState.hasMoved = false; // Track if user has actually moved
                        e.preventDefault();
                        
                        const handleScrollbarDrag = (e) => {
                            if (!scrollbarDragState.isDragging) return;
                            const dragPos = getCanvasPositionFromMouse(e, newCanvas);
                            const deltaX = dragPos.x - scrollbarDragState.dragStartY;
                            
                            // Only update scroll if user has moved at least 2 pixels (prevents jump on click)
                            // This threshold prevents accidental jumps from tiny mouse movements
                            if (Math.abs(deltaX) > 2) {
                                scrollbarDragState.hasMoved = true;
                                const scrollDelta = (deltaX / (scrollableAreaWidth - thumbWidth)) * maxScrollX;
                                scrollLeft = Math.max(0, Math.min(maxScrollX, scrollbarDragState.dragStartScroll + scrollDelta));
                                scheduleRender();
                            }
                        };
                        
                        const handleScrollbarDragEnd = () => {
                            scrollbarDragState.isDragging = false;
                            scrollbarDragState.dragType = null;
                            scrollbarDragState.hasMoved = false;
                            window.removeEventListener('mousemove', handleScrollbarDrag);
                            window.removeEventListener('mouseup', handleScrollbarDragEnd);
                        };
                        
                        window.addEventListener('mousemove', handleScrollbarDrag);
                        window.addEventListener('mouseup', handleScrollbarDragEnd);
                        return;
                    } else {
                        // Clicked on track - jump to position
                        const newScrollRatioX = (pos.x - scrollableAreaX - thumbWidth / 2) / (scrollableAreaWidth - thumbWidth);
                        scrollLeft = Math.max(0, Math.min(maxScrollX, newScrollRatioX * maxScrollX));
                        scheduleRender();
                        e.preventDefault();
                        return;
                    }
                } else {
                    // No scrolling needed, but still prevent position selection
                    e.preventDefault();
                    return;
                }
            }
            
            // Not clicking on scrollbar - handle position selection
            const positionInfo = getPositionAtCanvasPosition(pos.x, pos.y);
            
            if (!positionInfo) return;
            
            const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
            if (!renderer) return;
            
            // Get current selection state from selectionModel (same as rendering)
            let currentAtoms = new Set();
            if (renderer.selectionModel && renderer.selectionModel.atoms && renderer.selectionModel.atoms.size > 0) {
                currentAtoms = new Set(renderer.selectionModel.atoms);
            } else if (renderer.visibilityMask === null) {
                // null mask means all atoms are visible (default mode)
                for (let i = 0; i < msaData.queryLength; i++) {
                    currentAtoms.add(i);
                }
            } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                // Non-empty Set means some atoms are visible
                currentAtoms = new Set(renderer.visibilityMask);
            }
            
            const isInitiallySelected = currentAtoms.has(positionInfo.position);
            
            dragState.isDragging = true;
            dragState.hasMoved = false;
            dragState.dragStartPosition = positionInfo.position;
            dragState.dragEndPosition = positionInfo.position;
            dragState.dragUnselectMode = isInitiallySelected;
            dragState.initialSelectionState = new Set(currentAtoms);
            
            // Set preview selection for visual feedback (but don't apply until mouseup)
            const previewAtoms = new Set(dragState.initialSelectionState);
            if (previewAtoms.has(positionInfo.position)) {
                previewAtoms.delete(positionInfo.position);
            } else {
                previewAtoms.add(positionInfo.position);
            }
            
            if (callbacks.setPreviewSelectionSet) {
                callbacks.setPreviewSelectionSet(previewAtoms);
            }
            scheduleRender();
            
            // Add window listeners for drag
            const handleMove = (e) => handleDragMove(e, newCanvas);
            const handleUp = () => {
                handleMouseUp();
                window.removeEventListener('mousemove', handleMove);
                window.removeEventListener('mouseup', handleUp);
            };
            window.addEventListener('mousemove', handleMove);
            window.addEventListener('mouseup', handleUp);
        });
    }
    
    function handleDragMove(e, canvas) {
        if (!dragState.isDragging) return;
        
        const pos = getCanvasPositionFromMouse(e, canvas);
        const positionInfo = getPositionAtCanvasPosition(pos.x, pos.y);
        
        if (positionInfo && positionInfo.position !== dragState.dragEndPosition) {
            dragState.dragEndPosition = positionInfo.position;
            dragState.hasMoved = true;
            
            const newAtoms = computeSelectionFromPositionRange(
                dragState.dragStartPosition,
                dragState.dragEndPosition,
                dragState.initialSelectionState,
                dragState.dragUnselectMode
            );
            
            if (callbacks.setPreviewSelectionSet) {
                callbacks.setPreviewSelectionSet(newAtoms);
            }
            
            scheduleRender();
        }
    }
    
    function handleMouseUp() {
        const previewSelection = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        
        // Apply selection on mouseup (whether it was a click or drag)
        if (previewSelection && renderer) {
            // Preserve chains, selectionMode, and paeBoxes from current selection
            const currentSelection = renderer.getSelection();
            renderer.setSelection({
                atoms: previewSelection,
                chains: currentSelection?.chains || new Set(),
                selectionMode: currentSelection?.selectionMode || 'explicit',
                paeBoxes: currentSelection?.paeBoxes || []
            });
        }
        
        if (callbacks.setPreviewSelectionSet) {
            callbacks.setPreviewSelectionSet(null);
        }
        
        dragState.isDragging = false;
        dragState.dragStartPosition = null;
        dragState.dragEndPosition = null;
        dragState.hasMoved = false;
        dragState.dragUnselectMode = false;
        dragState.initialSelectionState = new Set();
        
        scheduleRender();
    }
    
    // ============================================================================
    // MAIN BUILD FUNCTIONS
    // ============================================================================
    
    function buildMSAView() {
        const msaViewEl = document.getElementById('msaView');
        if (!msaViewEl) {
            console.warn('MSA Viewer: msaView element not found');
            return;
        }
        
        msaViewEl.innerHTML = '';
        msaViewEl.classList.remove('hidden');
        
        if (!msaData) {
            console.warn('MSA Viewer: No MSA data available');
            return;
        }
        
        console.log('MSA Viewer: Building MSA view with', msaData.sequences.length, 'sequences');
        
        // Create container - NO HTML scrolling
        const container = document.createElement('div');
        container.style.width = '100%';
        container.style.overflow = 'hidden'; // Disable HTML scrolling
        container.style.position = 'relative';
        container.style.backgroundColor = '#ffffff';
        
        // Calculate total content dimensions for scrollbar calculation
        // MSA mode uses half-width characters
        const MSA_CHAR_WIDTH = CHAR_WIDTH / 2; // 10px for MSA mode
        const totalWidth = NAME_COLUMN_WIDTH + (msaData.queryLength * MSA_CHAR_WIDTH);
        const totalHeight = (msaData.sequences.length + 1) * SEQUENCE_ROW_HEIGHT; // +1 for header
        
        // Create canvas - only as tall as viewport (virtual scrolling)
        const canvas = document.createElement('canvas');
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        
        // Canvas should match viewport dimensions, not total content dimensions
        // Account for scrollbar width
        const SCROLLBAR_WIDTH = 15;
        const queryRowHeight = SEQUENCE_ROW_HEIGHT;
        
        // Use same canvas height as PSSM mode for consistency
        // PSSM: tickRow (15) + queryRowHeight (20) + 20 amino acids (400) + scrollbar (15) = 450px
        // MSA: tickRow (15) + queryRowHeight (20) + N sequences (N * 20) + scrollbar (15) = 450px
        // So: N = (450 - 15 - 20 - 15) / 20 = 400 / 20 = 20 sequences
        const targetTotalHeight = 450; // Match PSSM mode height (includes tick row)
        const availableForSequences = targetTotalHeight - TICK_ROW_HEIGHT - queryRowHeight - SCROLLBAR_WIDTH; // 400px
        const numSequencesToFit = Math.floor(availableForSequences / SEQUENCE_ROW_HEIGHT); // 20 sequences
        const exactScrollableHeight = numSequencesToFit * SEQUENCE_ROW_HEIGHT; // 400px
        const viewportHeight = TICK_ROW_HEIGHT + queryRowHeight + exactScrollableHeight + SCROLLBAR_WIDTH; // 450px
        
        container.style.height = viewportHeight + 'px';
        
        // Get container width to limit canvas width
        const containerEl = msaViewEl.closest('#msa-viewer-container');
        const maxViewportWidth = containerEl ? containerEl.offsetWidth - 32 : 948; // Account for padding
        const viewportWidth = Math.min(maxViewportWidth, totalWidth + SCROLLBAR_WIDTH);
        const canvasWidth = viewportWidth;
        const canvasHeight = viewportHeight;
        
        canvas.width = canvasWidth * dpiMultiplier;
        canvas.height = canvasHeight * dpiMultiplier;
        canvas.style.width = canvasWidth + 'px';
        canvas.style.height = canvasHeight + 'px';
        canvas.style.display = 'block';
        canvas.style.position = 'relative';
        canvas.style.pointerEvents = 'auto';
        canvas.style.cursor = 'default';
        
        container.appendChild(canvas);
        msaViewEl.appendChild(container);
        
        msaCanvasData = {
            canvas: canvas,
            ctx: canvas.getContext('2d'),
            container: container,
            totalWidth: totalWidth,
            totalHeight: totalHeight
        };
        
        // Apply DPI scaling
        msaCanvasData.ctx.scale(dpiMultiplier, dpiMultiplier);
        
        console.log('MSA Viewer: Canvas created, viewport:', canvasWidth, 'x', canvasHeight, 'total content:', totalWidth, 'x', totalHeight);
        
        setupCanvasMSAEvents();
        renderMSACanvas();
        
        console.log('MSA Viewer: MSA view rendered');
    }
    
    function buildWeblogoView() {
        const msaViewEl = document.getElementById('msaView');
        if (!msaViewEl) return;
        
        msaViewEl.innerHTML = '';
        msaViewEl.classList.remove('hidden');
        
        if (!msaData) return;
        
        // Preserve scroll position when switching modes (don't reset scrollLeft)
        
        // Define constants first
        const SCROLLBAR_WIDTH = 15;
        
        const container = document.createElement('div');
        container.style.width = '100%';
        container.style.overflow = 'hidden'; // Disable HTML scrolling
        container.style.position = 'relative';
        container.style.backgroundColor = '#ffffff';
        
        const canvas = document.createElement('canvas');
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        
        const totalWidth = NAME_COLUMN_WIDTH + (msaData.queryLength * CHAR_WIDTH);
        
        // Get container width to limit canvas width (like MSA view)
        const containerEl = msaViewEl.closest('#msa-viewer-container');
        const maxViewportWidth = containerEl ? containerEl.offsetWidth - 32 : 948; // Account for padding
        const viewportWidth = Math.min(maxViewportWidth, totalWidth + SCROLLBAR_WIDTH);
        const canvasWidth = viewportWidth;
        
        // Calculate canvas height to fit tick row + query row + 20 amino acid rows + scrollbar
        // Tick row: TICK_ROW_HEIGHT (15px)
        // Query row: CHAR_WIDTH (20px)
        // 20 amino acid rows: 20 * CHAR_WIDTH = 400px
        // Scrollbar: 15px
        // Total: 15 + 20 + 400 + 15 = 450px
        const queryRowHeight = CHAR_WIDTH;
        const NUM_AMINO_ACIDS = 20;
        const canvasHeight = TICK_ROW_HEIGHT + queryRowHeight + (NUM_AMINO_ACIDS * CHAR_WIDTH) + SCROLLBAR_WIDTH;
        
        // Set container height to match canvas height
        container.style.height = canvasHeight + 'px';
        
        canvas.width = canvasWidth * dpiMultiplier;
        canvas.height = canvasHeight * dpiMultiplier;
        canvas.style.width = canvasWidth + 'px';
        canvas.style.height = canvasHeight + 'px';
        canvas.style.display = 'block';
        canvas.style.position = 'relative';
        canvas.style.pointerEvents = 'auto';
        
        container.appendChild(canvas);
        msaViewEl.appendChild(container);
        
        weblogoCanvasData = {
            canvas: canvas,
            ctx: canvas.getContext('2d'),
            container: container,
            totalWidth: totalWidth,
            totalHeight: canvasHeight
        };
        
        weblogoCanvasData.ctx.scale(dpiMultiplier, dpiMultiplier);
        
        // Store dpiMultiplier for use in event handlers
        const weblogoDpiMultiplier = dpiMultiplier;
        
        // Helper function to get canvas position from mouse event (same as MSA view)
        function getWeblogoCanvasPositionFromMouse(e, canvasEl) {
            const rect = canvasEl.getBoundingClientRect();
            const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
            const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);
            
            const displayX = clientX - rect.left;
            const displayY = clientY - rect.top;
            
            const targetDPI = 200;
            const standardDPI = 96;
            const dpiMultiplier = targetDPI / standardDPI;
            const scaleX = (canvasEl.width / dpiMultiplier) / rect.width;
            const scaleY = (canvasEl.height / dpiMultiplier) / rect.height;
            
            return {
                x: displayX * scaleX,
                y: displayY * scaleY
            };
        }
        
        // Scrollbar drag state for weblogo view
        let weblogoScrollbarDragState = {
            isDragging: false,
            dragStartX: 0,
            dragStartScroll: 0
        };
        
        // Add wheel event for horizontal scrolling (same as MSA view)
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            
            // Get actual canvas dimensions
            const actualCanvasWidth = canvas.width / weblogoDpiMultiplier;
            
            // Calculate scrollable area (account for LABEL_WIDTH in heatmap mode)
            const LABEL_WIDTH = msaViewMode === 'pssm' ? CHAR_WIDTH : 0;
            const scrollableAreaX = LABEL_WIDTH;
            const scrollableAreaWidth = actualCanvasWidth - LABEL_WIDTH - SCROLLBAR_WIDTH;
            const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH; // Sequence width only
            const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
            
            // Handle horizontal scrolling
            // Check deltaX first (for trackpads with horizontal scrolling)
            // Also check if shift key is pressed (alternative horizontal scroll method)
            const hasHorizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const isShiftScroll = e.shiftKey && Math.abs(e.deltaY) > 0;
            
            if (hasHorizontalDelta || isShiftScroll) {
                const delta = hasHorizontalDelta ? e.deltaX : (isShiftScroll ? e.deltaY : 0);
                if (delta !== 0) {
                    if (maxScrollX > 0) {
                        scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft + delta));
                        // Set scrolling flag for simplified rendering
                        isScrolling = true;
                        renderWeblogoCanvas();
                        // Clear scrolling flag after a short delay
                        clearTimeout(window.weblogoScrollTimeout);
                        window.weblogoScrollTimeout = setTimeout(() => {
                            isScrolling = false;
                            renderWeblogoCanvas(); // Re-render with text labels
                        }, 150);
                    } else {
                        // Reset scrollLeft if content fits in viewport
                        scrollLeft = 0;
                        renderWeblogoCanvas();
                    }
                }
            }
        }, { passive: false });
        
        // Add mousedown event for scrollbar dragging
        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            
            const pos = getWeblogoCanvasPositionFromMouse(e, canvas);
            const actualCanvasWidth = canvas.width / weblogoDpiMultiplier;
            const actualCanvasHeight = canvas.height / weblogoDpiMultiplier;
            
            // Calculate scrollable area (account for LABEL_WIDTH in heatmap mode)
            const LABEL_WIDTH = msaViewMode === 'pssm' ? CHAR_WIDTH : 0;
            const scrollableAreaX = LABEL_WIDTH;
            const scrollableAreaWidth = actualCanvasWidth - LABEL_WIDTH - SCROLLBAR_WIDTH;
            const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH;
            const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
            const hScrollbarY = actualCanvasHeight - SCROLLBAR_WIDTH;
            const hScrollbarXEnd = actualCanvasWidth - SCROLLBAR_WIDTH;
            
            // Check if clicking on horizontal scrollbar (bottom edge, in scrollable area)
            const weblogoScrollableAreaX = scrollableAreaX;
            const weblogoScrollableAreaWidth = scrollableAreaWidth;
            const weblogoMaxScrollX = maxScrollX;
            
            if (weblogoMaxScrollX > 0 && pos.y >= hScrollbarY && pos.y <= actualCanvasHeight && pos.x >= weblogoScrollableAreaX && pos.x < hScrollbarXEnd) {
                const scrollRatioX = scrollLeft / weblogoMaxScrollX;
                const thumbWidth = Math.max(20, (weblogoScrollableAreaWidth / totalScrollableWidth) * weblogoScrollableAreaWidth);
                const thumbX = weblogoScrollableAreaX + scrollRatioX * (weblogoScrollableAreaWidth - thumbWidth); // Start from LABEL_WIDTH
                
                if (pos.x >= thumbX && pos.x <= thumbX + thumbWidth) {
                    // Clicked on thumb - start dragging
                    weblogoScrollbarDragState.isDragging = true;
                    weblogoScrollbarDragState.dragStartX = pos.x;
                    weblogoScrollbarDragState.dragStartScroll = scrollLeft;
                    e.preventDefault();
                    
                    const handleScrollbarDrag = (e) => {
                        if (!weblogoScrollbarDragState.isDragging) return;
                        e.preventDefault();
                        const dragPos = getWeblogoCanvasPositionFromMouse(e, canvas);
                        const deltaX = dragPos.x - weblogoScrollbarDragState.dragStartX;
                        
                        // Recalculate dimensions in case canvas size changed
                        const currentCanvasWidth = canvas.width / weblogoDpiMultiplier;
                        const currentLABEL_WIDTH = msaViewMode === 'pssm' ? CHAR_WIDTH : 0;
                        const currentScrollableAreaWidth = currentCanvasWidth - currentLABEL_WIDTH - SCROLLBAR_WIDTH;
                        const currentMaxScrollX = Math.max(0, totalScrollableWidth - currentScrollableAreaWidth);
                        const currentThumbWidth = Math.max(20, (currentScrollableAreaWidth / totalScrollableWidth) * currentScrollableAreaWidth);
                        
                        const scrollDelta = (deltaX / (currentScrollableAreaWidth - currentThumbWidth)) * currentMaxScrollX;
                        scrollLeft = Math.max(0, Math.min(currentMaxScrollX, weblogoScrollbarDragState.dragStartScroll + scrollDelta));
                        
                        // Set scrolling flag for simplified rendering
                        isScrolling = true;
                        renderWeblogoCanvas();
                        // Clear scrolling flag after a short delay
                        clearTimeout(window.weblogoScrollTimeout);
                        window.weblogoScrollTimeout = setTimeout(() => {
                            isScrolling = false;
                            renderWeblogoCanvas(); // Re-render with text labels
                        }, 150);
                    };
                    
                    const handleScrollbarDragEnd = () => {
                        weblogoScrollbarDragState.isDragging = false;
                        window.removeEventListener('mousemove', handleScrollbarDrag);
                        window.removeEventListener('mouseup', handleScrollbarDragEnd);
                    };
                    
                    window.addEventListener('mousemove', handleScrollbarDrag);
                    window.addEventListener('mouseup', handleScrollbarDragEnd);
                    return;
                } else if (pos.x >= weblogoScrollableAreaX && pos.x < hScrollbarXEnd) {
                    // Clicked on track - jump to position (account for LABEL_WIDTH)
                    const newScrollRatioX = (pos.x - weblogoScrollableAreaX - thumbWidth / 2) / (weblogoScrollableAreaWidth - thumbWidth);
                    scrollLeft = Math.max(0, Math.min(weblogoMaxScrollX, newScrollRatioX * weblogoMaxScrollX));
                    renderWeblogoCanvas();
                    e.preventDefault();
                    return;
                }
            }
            
            // Not clicking on scrollbar - handle position selection on query row or weblogo area
            // Tick row is at top, query row is below, weblogo is below query with no gap
            const queryY = TICK_ROW_HEIGHT; // Query row starts after tick row
            const queryRowHeight = CHAR_WIDTH; // Square cells
            const GAP_HEIGHT = 0; // No gap between query and weblogo
            const weblogoAreaY = queryY + queryRowHeight + GAP_HEIGHT;
            const weblogoAreaHeight = actualCanvasHeight - SCROLLBAR_WIDTH;
            
            // Check if clicking on query row
            if (pos.y >= queryY && pos.y < queryY + queryRowHeight && pos.x >= 0 && pos.x < actualCanvasWidth - SCROLLBAR_WIDTH) {
                // Calculate position from x coordinate
                const positionX = pos.x + scrollLeft;
                const position = Math.floor(positionX / CHAR_WIDTH);
                
                if (position >= 0 && position < msaData.queryLength) {
                    const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
                    if (!renderer) return;
                    
                    // Get current selection state from selectionModel (same as rendering)
                    let currentAtoms = new Set();
                    if (renderer.selectionModel && renderer.selectionModel.atoms && renderer.selectionModel.atoms.size > 0) {
                        currentAtoms = new Set(renderer.selectionModel.atoms);
                    } else if (renderer.visibilityMask === null) {
                        // null mask means all atoms are visible (default mode)
                        for (let i = 0; i < msaData.queryLength; i++) {
                            currentAtoms.add(i);
                        }
                    } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                        // Non-empty Set means some atoms are visible
                        currentAtoms = new Set(renderer.visibilityMask);
                    }
                    
                    const isInitiallySelected = currentAtoms.has(position);
                    
                    dragState.isDragging = true;
                    dragState.hasMoved = false;
                    dragState.dragStartPosition = position;
                    dragState.dragEndPosition = position;
                    dragState.dragUnselectMode = isInitiallySelected;
                    dragState.initialSelectionState = new Set(currentAtoms);
                    
                    // Set preview selection for visual feedback (but don't apply until mouseup)
                    const previewAtoms = new Set(dragState.initialSelectionState);
                    if (previewAtoms.has(position)) {
                        previewAtoms.delete(position);
                    } else {
                        previewAtoms.add(position);
                    }
                    
                    if (callbacks.setPreviewSelectionSet) {
                        callbacks.setPreviewSelectionSet(previewAtoms);
                    }
                    scheduleRender();
                    
                    // Add window listeners for drag
                    const handleMove = (e) => {
                        if (!dragState.isDragging) return;
                        const dragPos = getWeblogoCanvasPositionFromMouse(e, canvas);
                        // Allow dragging on query row
                        if (dragPos.y >= queryRowY && dragPos.y < queryRowHeight) {
                            const dragPositionX = dragPos.x + scrollLeft;
                            const dragPosition = Math.floor(dragPositionX / CHAR_WIDTH);
                            if (dragPosition >= 0 && dragPosition < msaData.queryLength) {
                                dragState.dragEndPosition = dragPosition;
                                dragState.hasMoved = true;
                                
                                const newAtoms = computeSelectionFromPositionRange(
                                    dragState.dragStartPosition,
                                    dragState.dragEndPosition,
                                    dragState.initialSelectionState,
                                    dragState.dragUnselectMode
                                );
                                
                                if (callbacks.setPreviewSelectionSet) {
                                    callbacks.setPreviewSelectionSet(newAtoms);
                                }
                                scheduleRender();
                            }
                        }
                    };
                    const handleUp = () => {
                        handleMouseUp();
                        window.removeEventListener('mousemove', handleMove);
                        window.removeEventListener('mouseup', handleUp);
                    };
                    window.addEventListener('mousemove', handleMove);
                    window.addEventListener('mouseup', handleUp);
                    e.preventDefault();
                    return;
                }
            }
            
            // Weblogo area is not selectable - only query row is selectable
        });
        
        renderWeblogoCanvas();
    }
    
    // ============================================================================
    // SELECTION STATE UPDATE (same as viewer-seq)
    // ============================================================================
    
    function updateMSAViewSelectionState() {
        if (!msaCanvasData && !weblogoCanvasData) return;
        if (!msaData) return;
        
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;
        
        // Determine what's actually visible from the unified model or visibilityMask
        // Use previewSelectionSet during drag for live feedback
        let visibleAtoms = new Set();
        
        const previewSelectionSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
        
        if (previewSelectionSet && previewSelectionSet.size > 0) {
            // During drag, use preview selection for live feedback (already atom indices)
            visibleAtoms = new Set(previewSelectionSet);
        } else {
            // Use atoms directly from selection model (same as viewer-seq)
            if (renderer.selectionModel && renderer.selectionModel.atoms && renderer.selectionModel.atoms.size > 0) {
                visibleAtoms = new Set(renderer.selectionModel.atoms);
            } else if (renderer.visibilityMask === null) {
                // null mask means all atoms are visible (default mode)
                for (let i = 0; i < msaData.queryLength; i++) {
                    visibleAtoms.add(i);
                }
            } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                // Non-empty Set means some atoms are visible
                visibleAtoms = new Set(renderer.visibilityMask);
            }
        }
        
        // Create hash to detect if selection actually changed
        // Include previewSelectionSet in hash to ensure live feedback during drag
        const previewHash = previewSelectionSet ? previewSelectionSet.size : 0;
        const currentHash = visibleAtoms.size + previewHash + (renderer?.visibilityMask === null ? 'all' : 'some');
        if (currentHash === lastMSAUpdateHash && !previewSelectionSet) {
            return; // No change, skip update (unless we have preview selection for live feedback)
        }
        lastMSAUpdateHash = currentHash;
        
        // Trigger canvas redraw
        scheduleRender();
    }
    
    // ============================================================================
    // PUBLIC API
    // ============================================================================
    
    window.MSAViewer = {
        setCallbacks: function(cb) {
            callbacks = Object.assign({}, callbacks, cb);
        },
        
        updateMSAViewSelectionState: updateMSAViewSelectionState,
        
        getMSAData: function() {
            return msaData;
        },
        
        setCoverageCutoff: function(cutoff) {
            coverageCutoff = Math.max(0, Math.min(1, cutoff));
            // Rebuild view with new coverage cutoff
            if (originalMSAData) {
                // Store old sequence count to adjust scroll position
                const oldSequenceCount = msaData ? msaData.sequences.length : 0;
                
                // Re-filter original data with both coverage and identity filters
                let filtered = filterSequencesByCoverage(originalMSAData.sequences, coverageCutoff);
                filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
                const sorted = sortSequencesBySimilarity(filtered, originalMSAData.querySequence);
                
                // Update msaData
                msaData = {
                    sequences: sorted,
                    querySequence: originalMSAData.querySequence,
                    queryLength: originalMSAData.queryLength
                };
                
                // Adjust scrollTop if sequence count changed (to prevent scroll instability)
                const newSequenceCount = msaData.sequences.length;
                if (oldSequenceCount > 0 && newSequenceCount !== oldSequenceCount) {
                    // Use consistent calculation - get canvas height from canvas data if available
                    let canvasHeight = 400; // Default
                    if (msaCanvasData && msaCanvasData.canvas) {
                        const targetDPI = 200;
                        const standardDPI = 96;
                        const dpiMultiplier = targetDPI / standardDPI;
                        canvasHeight = msaCanvasData.canvas.height / dpiMultiplier;
                    }
                    
                    // Clamp scrollTop to new maximum using helper function
                    clampScrollTop(canvasHeight);
                }
                
                // Invalidate cached data
                cachedFrequencies = null;
                cachedLogOdds = null;
                cachedDataHash = null;
                
                // Re-render existing view instead of rebuilding (prevents canvas recreation and visual jump)
                if (msaViewMode === 'msa') {
                    if (msaCanvasData && msaCanvasData.canvas) {
                        // Canvas already exists - just re-render
                        scheduleRender();
                    } else {
                        // Canvas doesn't exist - need to build it
                        buildMSAView();
                    }
                } else {
                    if (weblogoCanvasData && weblogoCanvasData.canvas) {
                        // Canvas already exists - just re-render
                        scheduleRender();
                    } else {
                        // Canvas doesn't exist - need to build it
                        buildWeblogoView();
                    }
                }
            }
        },
        
        getCoverageCutoff: function() {
            return coverageCutoff;
        },
        
        setPreviewCoverageCutoff: function(cutoff) {
            previewCoverageCutoff = Math.max(0, Math.min(1, cutoff));
        },
        
        applyPreviewCoverageCutoff: function() {
            coverageCutoff = previewCoverageCutoff;
            // Apply the preview cutoff
            this.setCoverageCutoff(coverageCutoff);
        },
        
        setIdentityCutoff: function(cutoff) {
            identityCutoff = Math.max(0, Math.min(1, cutoff));
            // Rebuild view with new identity cutoff
            if (originalMSAData) {
                // Store old sequence count to adjust scroll position
                const oldSequenceCount = msaData ? msaData.sequences.length : 0;
                
                // Re-filter original data with both coverage and identity filters
                let filtered = filterSequencesByCoverage(originalMSAData.sequences, coverageCutoff);
                filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
                const sorted = sortSequencesBySimilarity(filtered, originalMSAData.querySequence);
                
                // Update msaData
                msaData = {
                    sequences: sorted,
                    querySequence: originalMSAData.querySequence,
                    queryLength: originalMSAData.queryLength
                };
                
                // Adjust scrollTop if sequence count changed (to prevent scroll instability)
                const newSequenceCount = msaData.sequences.length;
                if (oldSequenceCount > 0 && newSequenceCount !== oldSequenceCount) {
                    // Use consistent calculation - get canvas height from canvas data if available
                    let canvasHeight = 400; // Default
                    if (msaCanvasData && msaCanvasData.canvas) {
                        const targetDPI = 200;
                        const standardDPI = 96;
                        const dpiMultiplier = targetDPI / standardDPI;
                        canvasHeight = msaCanvasData.canvas.height / dpiMultiplier;
                    }
                    
                    // Clamp scrollTop to new maximum using helper function
                    clampScrollTop(canvasHeight);
                }
                
                // Invalidate cached data
                cachedFrequencies = null;
                cachedLogOdds = null;
                cachedDataHash = null;
                
                // Re-render existing view instead of rebuilding (prevents canvas recreation and visual jump)
                if (msaViewMode === 'msa') {
                    if (msaCanvasData && msaCanvasData.canvas) {
                        // Canvas already exists - just re-render
                        scheduleRender();
                    } else {
                        // Canvas doesn't exist - need to build it
                        buildMSAView();
                    }
                } else {
                    if (weblogoCanvasData && weblogoCanvasData.canvas) {
                        // Canvas already exists - just re-render
                        scheduleRender();
                    } else {
                        // Canvas doesn't exist - need to build it
                        buildWeblogoView();
                    }
                }
            }
        },
        
        getIdentityCutoff: function() {
            return identityCutoff;
        },
        
        setPreviewIdentityCutoff: function(cutoff) {
            previewIdentityCutoff = Math.max(0, Math.min(1, cutoff));
        },
        
        applyPreviewIdentityCutoff: function() {
            identityCutoff = previewIdentityCutoff;
            // Apply the preview cutoff
            this.setIdentityCutoff(identityCutoff);
        },
        
        setMSAData: function(data) {
            // Store original unfiltered data
            originalMSAData = data;
            
            // Apply both coverage and identity filters
            let filtered = filterSequencesByCoverage(originalMSAData.sequences, coverageCutoff);
            filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
            const sorted = sortSequencesBySimilarity(filtered, originalMSAData.querySequence);
            
            msaData = {
                sequences: sorted,
                querySequence: originalMSAData.querySequence,
                queryLength: originalMSAData.queryLength
            };
            
            // Invalidate cached data when MSA data changes
            cachedFrequencies = null;
            cachedLogOdds = null;
            cachedDataHash = null;
            
            // Show MSA viewer container
            const msaContainer = document.getElementById('msa-viewer-container');
            if (msaContainer) {
                msaContainer.style.setProperty('display', 'block', 'important');
            }
            
            // Remove hidden class from msaView
            const msaViewEl = document.getElementById('msaView');
            if (msaViewEl) {
                msaViewEl.classList.remove('hidden');
            }
            if (msaViewMode === 'msa') {
                buildMSAView();
            } else if (msaViewMode === 'pssm' || msaViewMode === 'weblogo') {
                buildWeblogoView();
            }
        },
        
        getMSAMode: function() {
            return msaViewMode;
        },
        
        parseA3M: parseA3M,
        
        buildMSAView: buildMSAView,
        buildWeblogoView: buildWeblogoView,
        
        setMSAMode: function(mode) {
            // Convert scroll position when switching between modes with different character widths
            // MSA mode uses half-width (10px), PSSM/Weblogo use full-width (20px)
            if (msaViewMode !== mode && msaData) {
                const oldCharWidth = msaViewMode === 'msa' ? CHAR_WIDTH / 2 : CHAR_WIDTH;
                const newCharWidth = mode === 'msa' ? CHAR_WIDTH / 2 : CHAR_WIDTH;
                
                // Convert scrollLeft based on character position (not pixel position)
                // Calculate which character position we're at
                const charPosition = scrollLeft / oldCharWidth;
                // Convert to new pixel position
                scrollLeft = charPosition * newCharWidth;
            }
            
            msaViewMode = mode;
            // Invalidate log-odds cache when switching to weblogo mode
            if (mode === 'weblogo') {
                cachedLogOdds = null;
            }
            if (mode === 'msa') {
                buildMSAView();
                // Clamp scrollLeft after building MSA view with actual dimensions
                if (msaCanvasData && msaCanvasData.canvas && msaData) {
                    const SCROLLBAR_WIDTH = 15;
                    const NAME_COLUMN_WIDTH = 200;
                    const MSA_CHAR_WIDTH = CHAR_WIDTH / 2;
                    const canvasWidth = msaCanvasData.canvas.width / (200/96);
                    const scrollableAreaX = NAME_COLUMN_WIDTH;
                    const scrollableAreaWidth = canvasWidth - scrollableAreaX - SCROLLBAR_WIDTH;
                    const totalScrollableWidth = msaData.queryLength * MSA_CHAR_WIDTH;
                    const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
                    const oldScrollLeft = scrollLeft;
                    scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft));
                    // Re-render if scroll position was clamped
                    if (oldScrollLeft !== scrollLeft) {
                        scheduleRender();
                    }
                }
            } else if (mode === 'pssm' || mode === 'weblogo') {
                buildWeblogoView();
                // Clamp scrollLeft after building weblogo view with actual dimensions
                if (weblogoCanvasData && weblogoCanvasData.canvas && msaData) {
                    const SCROLLBAR_WIDTH = 15;
                    const canvasWidth = weblogoCanvasData.canvas.width / (200/96);
                    const LABEL_WIDTH = mode === 'pssm' ? CHAR_WIDTH : 0;
                    const scrollableAreaX = LABEL_WIDTH;
                    const scrollableAreaWidth = canvasWidth - scrollableAreaX - SCROLLBAR_WIDTH;
                    const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH;
                    const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
                    const oldScrollLeft = scrollLeft;
                    scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft));
                    // Re-render if scroll position was clamped
                    if (oldScrollLeft !== scrollLeft) {
                        scheduleRender();
                    }
                }
            }
        },
        
        clear: function() {
            msaData = null;
            msaCanvasData = null;
            weblogoCanvasData = null;
            // Clear cached data
            cachedFrequencies = null;
            cachedLogOdds = null;
            cachedDataHash = null;
            isScrolling = false;
            if (window.weblogoScrollTimeout) {
                clearTimeout(window.weblogoScrollTimeout);
            }
        }
    };

})();

