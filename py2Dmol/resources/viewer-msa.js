// ============================================================================
// MSA VIEWER MODULE (Rewritten from scratch)
// ============================================================================
// Simple, clean implementation with direct MSA position → atom index mapping

(function() {
    'use strict';

    // ============================================================================
    // INTERNAL STATE
    // ============================================================================
    let msaData = null; // { sequences: [], querySequence: string, queryLength: number }
    let originalMSAData = null; // Original unfiltered MSA data
    let msaCanvasData = null; // Canvas-based structure for MSA mode
    let logoCanvasData = null; // Canvas-based structure for logo mode
    let msaViewMode = 'msa'; // 'msa', 'pssm', or 'logo'
    let useBitScore = true; // true for bit-score, false for probabilities
    let currentChain = null; // Current chain ID
    let currentMSAType = 'unpaired'; // 'unpaired' or 'paired'
    let renderScheduled = false;
    let coverageCutoff = 0.75;
    let previewCoverageCutoff = 0.75;
    let identityCutoff = 0.15;
    let previewIdentityCutoff = 0.15;
    
    // Cached logo data
    let cachedFrequencies = null;
    let cachedLogOdds = null;
    let cachedDataHash = null;
    
    // Virtual scrolling state
    let visibleSequenceStart = 0;
    let visibleSequenceEnd = 0;
    let scrollTop = 0;
    let scrollLeft = 0;
    const MAX_VISIBLE_SEQUENCES = 100;
    const SEQUENCE_ROW_HEIGHT = 20;
    const CHAR_WIDTH = 20;
    const NAME_COLUMN_WIDTH = 200;
    const TICK_ROW_HEIGHT = 15;
    const TICK_INTERVAL = 10;
    
    // DPI scaling
    const TARGET_DPI = 200;
    const STANDARD_DPI = 96;
    const DPI_MULTIPLIER = TARGET_DPI / STANDARD_DPI;
    
    // Scrollbar constants
    const SCROLLBAR_WIDTH = 15;
    const SCROLLBAR_PADDING = 2;
    const SCROLLBAR_TRACK_COLOR = '#f0f0f0';
    const SCROLLBAR_THUMB_COLOR = '#b0b0b0';
    const SCROLLBAR_THUMB_COLOR_NO_SCROLL = '#d0d0d0';
    
    
    // Dayhoff 6-group classification
    const DAYHOFF_GROUP_DEFINITIONS = [
        { name: 'group1', label: 'Cysteine', aminoAcids: ['C'], color: {r: 255, g: 200, b: 100} },
        { name: 'group2', label: 'Small polar', aminoAcids: ['S', 'T', 'A', 'G', 'P'], color: {r: 100, g: 200, b: 255} },
        { name: 'group3', label: 'Acidic/Amide', aminoAcids: ['D', 'E', 'Q', 'N'], color: {r: 200, g: 100, b: 255} },
        { name: 'group4', label: 'Basic', aminoAcids: ['H', 'R', 'K'], color: {r: 255, g: 100, b: 100} },
        { name: 'group5', label: 'Hydrophobic', aminoAcids: ['M', 'I', 'L', 'V'], color: {r: 100, g: 255, b: 100} },
        { name: 'group6', label: 'Aromatic', aminoAcids: ['W', 'Y', 'F'], color: {r: 255, g: 255, b: 100} }
    ];
    
    const DAYHOFF_COLORS = {};
    const DAYHOFF_GROUPS = {};
    DAYHOFF_GROUP_DEFINITIONS.forEach(group => {
        DAYHOFF_COLORS[group.name] = group.color;
        group.aminoAcids.forEach(aa => {
            DAYHOFF_GROUPS[aa] = group.name;
        });
    });
    DAYHOFF_COLORS.gap = {r: 200, g: 200, b: 200};
    DAYHOFF_COLORS.other = {r: 150, g: 150, b: 150};
    
    const AMINO_ACIDS_ORDERED = DAYHOFF_GROUP_DEFINITIONS.flatMap(group => group.aminoAcids);
    
    const DAYHOFF_GROUP_BOUNDARIES = [];
    let currentIndex = 0;
    for (let i = 1; i < DAYHOFF_GROUP_DEFINITIONS.length; i++) {
        currentIndex += DAYHOFF_GROUP_DEFINITIONS[i - 1].aminoAcids.length;
        DAYHOFF_GROUP_BOUNDARIES.push(currentIndex);
    }
    
    function getDayhoffColor(aa) {
        if (!aa || aa === '-' || aa === 'X') return DAYHOFF_COLORS.gap;
        const group = DAYHOFF_GROUPS[aa.toUpperCase()];
        if (group) return DAYHOFF_COLORS[group];
        return DAYHOFF_COLORS.other;
    }
    
    // Standard amino acid background frequencies
    // These are the natural occurrence frequencies of amino acids in proteins
    const AMINO_ACID_BACKGROUND_FREQUENCIES = {
        'A': 0.082,  // Alanine
        'R': 0.057,  // Arginine
        'N': 0.044,  // Asparagine
        'D': 0.053,  // Aspartic acid
        'C': 0.017,  // Cysteine
        'Q': 0.040,  // Glutamine
        'E': 0.062,  // Glutamic acid
        'G': 0.072,  // Glycine
        'H': 0.022,  // Histidine
        'I': 0.052,  // Isoleucine
        'L': 0.090,  // Leucine
        'K': 0.057,  // Lysine
        'M': 0.024,  // Methionine
        'F': 0.039,  // Phenylalanine
        'P': 0.051,  // Proline
        'S': 0.069,  // Serine
        'T': 0.058,  // Threonine
        'W': 0.013,  // Tryptophan
        'Y': 0.032,  // Tyrosine
        'V': 0.066   // Valine
    };
    
    function getBackgroundFrequency(aa) {
        if (!aa || aa === '-' || aa === 'X') return 0;
        return AMINO_ACID_BACKGROUND_FREQUENCIES[aa.toUpperCase()] || (1 / 20);
    }
    
    // Callbacks
    let callbacks = {
        getRenderer: null
    };
    
    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================
    
    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            if (msaViewMode === 'msa') {
                renderMSACanvas();
            } else if (msaViewMode === 'pssm' || msaViewMode === 'logo') {
                renderLogoCanvas();
            }
        });
    }
    
    function getCanvasPositionFromMouse(e, canvas) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
        const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);
        
        const displayX = clientX - rect.left;
        const displayY = clientY - rect.top;
        
        const scaleX = (canvas.width / DPI_MULTIPLIER) / rect.width;
        const scaleY = (canvas.height / DPI_MULTIPLIER) / rect.height;
        
        return { x: displayX * scaleX, y: displayY * scaleY };
    }
    
    // ============================================================================
    // HELPER FUNCTIONS (continued)
    // ============================================================================
    
    function truncateSequenceName(name, maxLength = 32) {
        if (!name) return '';
        if (name.length <= maxLength) return name;
        return name.substring(0, maxLength - 3) + '...';
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
            if (seq.header === '>query') return true;
            const identity = calculateSequenceSimilarity(seq.sequence, querySequence);
            return identity >= minIdentity;
        });
    }
    
    function sortSequencesBySimilarity(sequences, querySequence) {
        if (!sequences || sequences.length === 0 || !querySequence) return sequences;
        
        const sequencesWithSimilarity = sequences.map(seq => ({
            ...seq,
            similarity: calculateSequenceSimilarity(seq.sequence, querySequence)
        }));
        
        sequencesWithSimilarity.sort((a, b) => {
            if (a.header === '>query') return -1;
            if (b.header === '>query') return 1;
            return b.similarity - a.similarity;
        });
        
        return sequencesWithSimilarity;
    }
    
    function parseA3M(fileContent, type = 'unpaired') {
        const isPaired = type === 'paired';
        const lines = fileContent.split('\n');
        const sequences = [];
        let currentHeader = null;
        let currentSequence = '';
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            if (line.startsWith('>')) {
                if (currentHeader && currentSequence) {
                    const alignedSequence = currentSequence.replace(/[a-z]/g, '').toUpperCase();
                    sequences.push({
                        header: truncateSequenceName(currentHeader),
                        sequence: alignedSequence,
                        isPaired: isPaired,
                        similarity: 0,
                        coverage: 0
                    });
                }
                const fullHeader = line.substring(1);
                currentHeader = fullHeader.split(/[\s\t]/)[0];
                currentSequence = '';
            } else {
                currentSequence += line;
            }
        }
        
        if (currentHeader && currentSequence) {
            const alignedSequence = currentSequence.replace(/[a-z]/g, '').toUpperCase();
            sequences.push({
                header: truncateSequenceName(currentHeader),
                sequence: alignedSequence,
                isPaired: isPaired,
                similarity: 0,
                coverage: 0
            });
        }
        
        if (sequences.length === 0) return null;
        
        let queryIndex = sequences.findIndex(s => s.header.toLowerCase().includes('query'));
        if (queryIndex === -1) queryIndex = 0;
        
        const querySequence = sequences[queryIndex].sequence;
        const queryLength = querySequence.length;
        const sorted = sortSequencesBySimilarity(sequences, querySequence);
        
        return {
            sequences: sorted,
            querySequence: querySequence,
            queryLength: queryLength,
            queryIndex: queryIndex
        };
    }
    
    // ============================================================================
    // HELPER FUNCTIONS (continued)
    // ============================================================================
    
    function getCharWidthForMode(mode) {
        if (mode === 'msa') {
            return CHAR_WIDTH / 2; // Half-width for MSA mode
        }
        return CHAR_WIDTH; // Full width for logo/PSSM
    }
    
    function getLogicalCanvasDimensions(canvas) {
        const logicalWidth = canvas.width / DPI_MULTIPLIER;
        const logicalHeight = canvas.height / DPI_MULTIPLIER;
        return { logicalWidth, logicalHeight };
    }
    
    function getScrollableAreaForMode(mode, logicalWidth, logicalHeight) {
        let scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight;
        
        if (mode === 'msa') {
            scrollableAreaX = NAME_COLUMN_WIDTH;
            scrollableAreaY = TICK_ROW_HEIGHT + SEQUENCE_ROW_HEIGHT;
            scrollableAreaWidth = logicalWidth - scrollableAreaX - SCROLLBAR_WIDTH;
            scrollableAreaHeight = logicalHeight - scrollableAreaY - SCROLLBAR_WIDTH;
        } else if (mode === 'pssm') {
            scrollableAreaX = CHAR_WIDTH;
            scrollableAreaY = TICK_ROW_HEIGHT + CHAR_WIDTH;
            scrollableAreaWidth = logicalWidth - scrollableAreaX - SCROLLBAR_WIDTH;
            scrollableAreaHeight = logicalHeight - scrollableAreaY - SCROLLBAR_WIDTH;
        } else {
            scrollableAreaX = 0;
            scrollableAreaY = TICK_ROW_HEIGHT + CHAR_WIDTH;
            scrollableAreaWidth = logicalWidth - SCROLLBAR_WIDTH;
            scrollableAreaHeight = logicalHeight - scrollableAreaY - SCROLLBAR_WIDTH;
        }
        
        return { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight };
    }
    
    function getScrollableAreaDimensions(canvasHeight) {
        const queryRowHeight = SEQUENCE_ROW_HEIGHT;
        const scrollableAreaY = TICK_ROW_HEIGHT + queryRowHeight;
        const scrollableAreaHeight = canvasHeight - scrollableAreaY - SCROLLBAR_WIDTH;
        return { scrollableAreaY, scrollableAreaHeight };
    }
    
    function clampScrollTop(canvasHeight) {
        if (!msaData) return;
        const { scrollableAreaHeight } = getScrollableAreaDimensions(canvasHeight);
        const totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
        const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
        scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
    }
    
    function clampScrollLeft(canvasWidth, charWidth) {
        if (!msaData) return;
        const scrollableAreaX = msaViewMode === 'msa' ? NAME_COLUMN_WIDTH : (msaViewMode === 'pssm' ? CHAR_WIDTH : 0);
        const scrollableAreaWidth = canvasWidth - scrollableAreaX;
        const totalContentWidth = msaData.queryLength * charWidth;
        const maxScrollLeft = Math.max(0, totalContentWidth - scrollableAreaWidth);
        scrollLeft = Math.max(0, Math.min(scrollLeft, maxScrollLeft));
    }
    
    function getVisibleSequenceRange(canvasHeight) {
        if (!msaData || !msaCanvasData) return { start: 0, end: 0 };
        const { scrollableAreaHeight } = getScrollableAreaDimensions(canvasHeight);
        clampScrollTop(canvasHeight);
        const startSequenceIndex = Math.max(1, Math.floor(scrollTop / SEQUENCE_ROW_HEIGHT));
        const visibleRows = Math.ceil(scrollableAreaHeight / SEQUENCE_ROW_HEIGHT);
        const buffer = 10;
        const endSequenceIndex = Math.min(msaData.sequences.length, startSequenceIndex + visibleRows + buffer);
        return { start: startSequenceIndex, end: endSequenceIndex };
    }
    
    function drawTickMarks(ctx, logicalWidth, scrollLeft, charWidth, scrollableAreaX, minX, maxX) {
        if (!msaData) return;
        const tickY = 0;
        const tickRowHeight = TICK_ROW_HEIGHT;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, tickY, logicalWidth, tickRowHeight);
        
        const visibleStartPos = Math.floor(scrollLeft / charWidth);
        const visibleEndPos = Math.min(msaData.queryLength, visibleStartPos + Math.ceil((maxX - minX) / charWidth) + 1);
        
        let xOffset = scrollableAreaX - (scrollLeft % charWidth);
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < msaData.queryLength; pos++) {
            if ((pos + 1) === 1 || (pos + 1) % TICK_INTERVAL === 0) {
                const tickX = xOffset;
                if (tickX + charWidth >= minX && tickX < maxX) {
                    const drawX = Math.max(minX, tickX);
                    const drawWidth = Math.min(charWidth, maxX - drawX);
                    const centerX = drawX + drawWidth / 2;
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
    
    // ============================================================================
    // RENDERING (Simplified - using new mapping)
    // ============================================================================
    
    function renderMSACanvas() {
        if (!msaCanvasData || !msaData) return;
        
        const { canvas, ctx } = msaCanvasData;
        if (!canvas || !ctx) return;
        
        const { logicalWidth, logicalHeight } = getLogicalCanvasDimensions(canvas);
        
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);
        
        clampScrollTop(logicalHeight);
        const visibleRange = getVisibleSequenceRange(logicalHeight);
        visibleSequenceStart = visibleRange.start;
        visibleSequenceEnd = visibleRange.end;
        
        const MSA_CHAR_WIDTH = getCharWidthForMode('msa');
        const { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight } = 
            getScrollableAreaForMode('msa', logicalWidth, logicalHeight);
        
        const queryRowHeight = SEQUENCE_ROW_HEIGHT;
        const queryY = TICK_ROW_HEIGHT;
        
        // Draw fixed name column background
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, NAME_COLUMN_WIDTH, logicalHeight);
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, NAME_COLUMN_WIDTH, logicalHeight);
        
        // Draw tick marks
        drawTickMarks(ctx, logicalWidth, scrollLeft, MSA_CHAR_WIDTH, scrollableAreaX, scrollableAreaX, logicalWidth);
        
        // Calculate visible position range
        const visibleStartPos = Math.floor(scrollLeft / MSA_CHAR_WIDTH);
        const visibleEndPos = Math.min(msaData.queryLength, visibleStartPos + Math.ceil(scrollableAreaWidth / MSA_CHAR_WIDTH) + 1);
        
        // Draw visible sequences (virtual scrolling)
        const currentScrollTop = scrollTop;
        const scrollOffset = currentScrollTop % SEQUENCE_ROW_HEIGHT;
        const startY = scrollableAreaY - scrollOffset;
        
        for (let i = visibleSequenceStart; i < visibleSequenceEnd && i < msaData.sequences.length; i++) {
            if (i === 0) continue; // Skip query (drawn separately)
            
            const seq = msaData.sequences[i];
            const sequenceOffset = (i - visibleSequenceStart) * SEQUENCE_ROW_HEIGHT;
            const y = startY + sequenceOffset;
            
            if (y + SEQUENCE_ROW_HEIGHT < scrollableAreaY || y > logicalHeight - SCROLLBAR_WIDTH) continue;
            
            // Draw sequence name
            ctx.fillStyle = '#333';
            ctx.font = '12px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(seq.header, 5, y + SEQUENCE_ROW_HEIGHT / 2);
            
            // Draw sequence
            let xOffset = scrollableAreaX - (scrollLeft % MSA_CHAR_WIDTH);
            const minX = scrollableAreaX;
            const maxX = logicalWidth - SCROLLBAR_WIDTH;
            
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < seq.sequence.length; pos++) {
                if (xOffset + MSA_CHAR_WIDTH < minX) {
                    xOffset += MSA_CHAR_WIDTH;
                    continue;
                }
                if (xOffset >= maxX) break;
                
                const aa = seq.sequence[pos];
                const color = getDayhoffColor(aa);
                const r = color.r, g = color.g, b = color.b;
                
                // Draw cell with clipping
                if (xOffset + MSA_CHAR_WIDTH >= minX && xOffset < maxX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(minX, scrollableAreaY, maxX - minX, scrollableAreaHeight);
                    ctx.clip();
                    
                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.fillRect(xOffset, y, MSA_CHAR_WIDTH, SEQUENCE_ROW_HEIGHT);
                    
                    ctx.fillStyle = '#000';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(aa, xOffset + MSA_CHAR_WIDTH / 2, y + SEQUENCE_ROW_HEIGHT / 2);
                    
                    ctx.restore();
                }
                
                xOffset += MSA_CHAR_WIDTH;
            }
        }
        
        // Draw query sequence (on top)
        if (msaData.sequences.length > 0) {
            const querySeq = msaData.sequences[0];
            
            // White background for query row
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, queryY, logicalWidth, queryRowHeight);
            
            // Draw query name
            ctx.fillStyle = '#333';
            ctx.font = '12px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(querySeq.header, 5, queryY + queryRowHeight / 2);
            
            // Draw query sequence
            let xOffset = scrollableAreaX - (scrollLeft % MSA_CHAR_WIDTH);
            const minX = scrollableAreaX;
            const maxX = logicalWidth - SCROLLBAR_WIDTH;
            
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < querySeq.sequence.length; pos++) {
                if (xOffset + MSA_CHAR_WIDTH < minX) {
                    xOffset += MSA_CHAR_WIDTH;
                    continue;
                }
                if (xOffset >= maxX) break;
                
                const aa = querySeq.sequence[pos];
                const color = getDayhoffColor(aa);
                const r = color.r, g = color.g, b = color.b;
                
                // Draw cell with clipping
                if (xOffset + MSA_CHAR_WIDTH >= minX && xOffset < maxX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(minX, queryY, maxX - minX, queryRowHeight);
                    ctx.clip();
                    
                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.fillRect(xOffset, queryY, MSA_CHAR_WIDTH, queryRowHeight);
                    
                    ctx.fillStyle = '#000';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(aa, xOffset + MSA_CHAR_WIDTH / 2, queryY + queryRowHeight / 2);
                    
                    ctx.restore();
                }
                
                xOffset += MSA_CHAR_WIDTH;
            }
            
            // Draw underline
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, queryY + queryRowHeight);
            ctx.lineTo(logicalWidth, queryY + queryRowHeight);
            ctx.stroke();
        }
        
        // Draw custom scrollbars on canvas
        drawScrollbars(ctx, logicalWidth, logicalHeight, scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight);
    }
    
    function drawScrollbars(ctx, canvasWidth, canvasHeight, scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight) {
        if (!msaCanvasData || !msaData) return;
        
        // Calculate scrollable content dimensions
        const totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
        const MSA_CHAR_WIDTH = getCharWidthForMode('msa');
        const totalScrollableWidth = msaData.queryLength * MSA_CHAR_WIDTH;
        
        // Vertical scrollbar
        const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
        const scrollRatio = maxScroll > 0 ? scrollTop / maxScroll : 0;
        const vScrollbarHeight = scrollableAreaHeight;
        const thumbHeight = Math.max(20, (vScrollbarHeight / totalScrollableHeight) * vScrollbarHeight);
        const thumbY = scrollableAreaY + scrollRatio * (vScrollbarHeight - thumbHeight);
        const vScrollbarX = canvasWidth - SCROLLBAR_WIDTH;
        
        // Draw vertical scrollbar track
        ctx.fillStyle = SCROLLBAR_TRACK_COLOR;
        ctx.fillRect(vScrollbarX, scrollableAreaY, SCROLLBAR_WIDTH, vScrollbarHeight);
        
        // Draw vertical scrollbar thumb
        if (maxScroll > 0) {
            ctx.fillStyle = SCROLLBAR_THUMB_COLOR;
            ctx.fillRect(vScrollbarX + SCROLLBAR_PADDING, thumbY, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2, thumbHeight);
        } else {
            ctx.fillStyle = SCROLLBAR_THUMB_COLOR_NO_SCROLL;
            ctx.fillRect(vScrollbarX + SCROLLBAR_PADDING, scrollableAreaY, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2, vScrollbarHeight);
        }
        
        // Horizontal scrollbar
        const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
        const scrollRatioX = maxScrollX > 0 ? scrollLeft / maxScrollX : 0;
        const hScrollbarWidth = scrollableAreaWidth;
        const thumbWidth = Math.max(20, (hScrollbarWidth / totalScrollableWidth) * hScrollbarWidth);
        const thumbX = scrollableAreaX + scrollRatioX * (hScrollbarWidth - thumbWidth);
        const hScrollbarY = canvasHeight - SCROLLBAR_WIDTH;
        
        // Draw white box over name column at bottom
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, hScrollbarY, scrollableAreaX, SCROLLBAR_WIDTH);
        
        // Draw position range info
        if (msaData && msaData.queryLength > 0) {
            const visibleStartPos = Math.floor(scrollLeft / MSA_CHAR_WIDTH);
            const visibleEndPos = Math.min(msaData.queryLength, visibleStartPos + Math.ceil(scrollableAreaWidth / MSA_CHAR_WIDTH));
            const positionText = `${visibleStartPos + 1}-${visibleEndPos} / ${msaData.queryLength}`;
            
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, hScrollbarY, scrollableAreaX, SCROLLBAR_WIDTH);
            ctx.strokeStyle = '#999';
            ctx.lineWidth = 1;
            ctx.strokeRect(0, hScrollbarY, scrollableAreaX, SCROLLBAR_WIDTH);
            
            ctx.fillStyle = '#333';
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(positionText, scrollableAreaX / 2, hScrollbarY + SCROLLBAR_WIDTH / 2);
        }
        
        // Draw horizontal scrollbar track
        ctx.fillStyle = SCROLLBAR_TRACK_COLOR;
        ctx.fillRect(scrollableAreaX, hScrollbarY, hScrollbarWidth, SCROLLBAR_WIDTH);
        
        // Draw horizontal scrollbar thumb
        if (maxScrollX > 0) {
            ctx.fillStyle = SCROLLBAR_THUMB_COLOR;
            ctx.fillRect(thumbX, hScrollbarY + SCROLLBAR_PADDING, thumbWidth, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2);
        } else {
            ctx.fillStyle = SCROLLBAR_THUMB_COLOR_NO_SCROLL;
            ctx.fillRect(scrollableAreaX, hScrollbarY + SCROLLBAR_PADDING, hScrollbarWidth, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2);
        }
    }
    
    function calculateFrequencies() {
        if (!msaData) return null;
        
        const dataHash = msaData.sequences.length + '_' + msaData.queryLength;
        if (cachedFrequencies && cachedDataHash === dataHash) {
            return cachedFrequencies;
        }
        
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
        
        cachedFrequencies = frequencies;
        cachedDataHash = dataHash;
        cachedLogOdds = null;
        
        return frequencies;
    }
    
    function calculateLogOdds(frequencies) {
        if (!frequencies) return null;
        if (cachedLogOdds) return cachedLogOdds;
        
        const logOdds = [];
        for (const freq of frequencies) {
            const logOddsPos = {};
            for (const aa in freq) {
                const backgroundFreq = getBackgroundFrequency(aa);
                logOddsPos[aa] = Math.log2(freq[aa] / backgroundFreq);
            }
            logOdds.push(logOddsPos);
        }
        
        cachedLogOdds = logOdds;
        return logOdds;
    }
    
    function renderLogoCanvas() {
        if (!logoCanvasData || !msaData) return;
        
        const { canvas, ctx } = logoCanvasData;
        if (!canvas || !ctx) return;
        
        const { logicalWidth, logicalHeight } = getLogicalCanvasDimensions(canvas);
        
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);
        
        const frequencies = calculateFrequencies();
        if (!frequencies) return;
        
        const data = msaViewMode === 'pssm' 
            ? frequencies 
            : (msaViewMode === 'logo' && useBitScore 
                ? (cachedLogOdds || calculateLogOdds(frequencies))
                : frequencies);
        if (!data) return;
        
        const queryRowHeight = CHAR_WIDTH;
        const GAP_HEIGHT = 0;
        const { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight } = 
            getScrollableAreaForMode(msaViewMode, logicalWidth, logicalHeight);
        
        const LABEL_WIDTH = msaViewMode === 'pssm' ? CHAR_WIDTH : 0;
        const visibleStartPos = Math.floor(scrollLeft / CHAR_WIDTH);
        const visibleEndPos = Math.min(data.length, visibleStartPos + Math.ceil(scrollableAreaWidth / CHAR_WIDTH) + 1);
        
        const tickMinX = LABEL_WIDTH;
        const tickMaxX = logicalWidth;
        drawTickMarks(ctx, logicalWidth, scrollLeft, CHAR_WIDTH, LABEL_WIDTH, tickMinX, tickMaxX);
        
        const queryY = TICK_ROW_HEIGHT;
        const logoY = scrollableAreaY + GAP_HEIGHT;
        
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const aaRowHeight = CHAR_WIDTH;
        const logoHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        
        const minX = 0;
        const maxX = logicalWidth;
        
        if (msaViewMode === 'pssm') {
            // HEATMAP MODE
            const heatmapX = LABEL_WIDTH;
            const heatmapWidth = logicalWidth - LABEL_WIDTH;
            
            // Draw labels
            for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
                const aa = AMINO_ACIDS_ORDERED[i];
                const y = logoY + i * aaRowHeight;
                const dayhoffColor = getDayhoffColor(aa);
                
                ctx.fillStyle = `rgb(${dayhoffColor.r}, ${dayhoffColor.g}, ${dayhoffColor.b})`;
                ctx.fillRect(0, y, LABEL_WIDTH, aaRowHeight);
                
                ctx.fillStyle = '#000';
                ctx.font = '10px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(aa, LABEL_WIDTH / 2, y + aaRowHeight / 2);
            }
            
            const querySeq = msaData.sequences.length > 0 ? msaData.sequences[0].sequence : '';
            
            // Draw heatmap
            let xOffset = heatmapX - (scrollLeft % CHAR_WIDTH);
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < data.length; pos++) {
                if (xOffset + CHAR_WIDTH < heatmapX) {
                    xOffset += CHAR_WIDTH;
                    continue;
                }
                if (xOffset >= maxX) break;
                
                const posData = data[pos];
                
                for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
                    const aa = AMINO_ACIDS_ORDERED[i];
                    const probability = posData[aa] || 0;
                    const y = logoY + i * aaRowHeight;
                    
                    const white = {r: 255, g: 255, b: 255};
                    const darkBlue = {r: 0, g: 0, b: 139};
                    const finalR = Math.round(white.r + (darkBlue.r - white.r) * probability);
                    const finalG = Math.round(white.g + (darkBlue.g - white.g) * probability);
                    const finalB = Math.round(white.b + (darkBlue.b - white.b) * probability);
                    
                    if (xOffset + CHAR_WIDTH >= heatmapX && xOffset < maxX) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(heatmapX, logoY, maxX - heatmapX, logoHeight);
                        ctx.clip();
                        
                        ctx.fillStyle = `rgb(${finalR}, ${finalG}, ${finalB})`;
                        ctx.fillRect(xOffset, y, CHAR_WIDTH, aaRowHeight);
                        
                        ctx.restore();
                    }
                }
                
                xOffset += CHAR_WIDTH;
            }
            
            // Draw black boxes around wildtype
            const querySeqForBoxes = msaData.sequences.length > 0 ? msaData.sequences[0].sequence : '';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            let boxXOffset = heatmapX - (scrollLeft % CHAR_WIDTH);
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < data.length; pos++) {
                if (boxXOffset + CHAR_WIDTH < heatmapX) {
                    boxXOffset += CHAR_WIDTH;
                    continue;
                }
                if (boxXOffset >= maxX) break;
                
                const wildtypeAA = pos < querySeqForBoxes.length ? querySeqForBoxes[pos].toUpperCase() : null;
                if (!wildtypeAA) {
                    boxXOffset += CHAR_WIDTH;
                    continue;
                }
                
                const wildtypeIndex = AMINO_ACIDS_ORDERED.indexOf(wildtypeAA);
                if (wildtypeIndex >= 0) {
                    const y = logoY + wildtypeIndex * aaRowHeight;
                    if (boxXOffset + CHAR_WIDTH >= heatmapX && boxXOffset < maxX) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(heatmapX, logoY, maxX - heatmapX, logoHeight);
                        ctx.clip();
                        
                        ctx.beginPath();
                        ctx.moveTo(boxXOffset, y);
                        ctx.lineTo(boxXOffset + CHAR_WIDTH, y);
                        ctx.moveTo(boxXOffset, y + aaRowHeight);
                        ctx.lineTo(boxXOffset + CHAR_WIDTH, y + aaRowHeight);
                        ctx.moveTo(boxXOffset, y);
                        ctx.lineTo(boxXOffset, y + aaRowHeight);
                        ctx.moveTo(boxXOffset + CHAR_WIDTH, y);
                        ctx.lineTo(boxXOffset + CHAR_WIDTH, y + aaRowHeight);
                        ctx.stroke();
                        
                        ctx.restore();
                    }
                }
                
                boxXOffset += CHAR_WIDTH;
            }
            
            // Draw group boundaries
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 2;
            for (const boundaryIdx of DAYHOFF_GROUP_BOUNDARIES) {
                const y = logoY + boundaryIdx * aaRowHeight;
                ctx.beginPath();
                ctx.moveTo(heatmapX, y);
                ctx.lineTo(heatmapX + heatmapWidth, y);
                ctx.stroke();
            }
        } else {
            // STACKED LOGO MODE
            const logoData = [];
            
            if (useBitScore) {
                let maxInfoContent = 0;
                const positionInfoContents = [];
                
                for (let pos = 0; pos < data.length; pos++) {
                    const posFreq = frequencies[pos];
                    let infoContent = 0;
                    const contributions = {};
                    
                    for (const aa in posFreq) {
                        const freq = posFreq[aa];
                        if (freq > 0) {
                            const backgroundFreq = getBackgroundFrequency(aa);
                            const contribution = freq * Math.log2(freq / backgroundFreq);
                            if (contribution > 0) {
                                infoContent += contribution;
                                contributions[aa] = contribution;
                            }
                        }
                    }
                    
                    positionInfoContents.push({ infoContent, contributions });
                    if (infoContent > maxInfoContent) {
                        maxInfoContent = infoContent;
                    }
                }
                
                for (let pos = 0; pos < positionInfoContents.length; pos++) {
                    const posInfo = positionInfoContents[pos];
                    const infoContent = posInfo.infoContent;
                    const contributions = posInfo.contributions;
                    
                    const totalStackHeight = maxInfoContent > 0 
                        ? (infoContent / maxInfoContent) * logoHeight 
                        : 0;
                    
                    const letterHeights = {};
                    if (infoContent > 0) {
                        for (const aa in contributions) {
                            letterHeights[aa] = (contributions[aa] / infoContent) * totalStackHeight;
                        }
                    }
                    
                    logoData.push({ infoContent, letterHeights, posData: data[pos] });
                }
            } else {
                const GAP_SIZE = 2;
                for (let pos = 0; pos < frequencies.length; pos++) {
                    const posFreq = frequencies[pos];
                    const letterHeights = {};
                    
                    let freqSum = 0;
                    for (const aa in posFreq) {
                        freqSum += posFreq[aa];
                    }
                    
                    const numAAs = Object.keys(posFreq).length;
                    const numGaps = Math.max(0, numAAs - 1);
                    const totalGapHeight = numGaps * GAP_SIZE;
                    const availableHeight = logoHeight - totalGapHeight;
                    const normalizationFactor = freqSum > 0 ? 1 / freqSum : 1;
                    
                    for (const aa in posFreq) {
                        letterHeights[aa] = (posFreq[aa] * normalizationFactor) * availableHeight;
                    }
                    
                    logoData.push({ infoContent: 0, letterHeights, posData: data[pos] });
                }
            }
            
            // Draw stacked logo
            let xOffset = scrollableAreaX - (scrollLeft % CHAR_WIDTH);
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < logoData.length; pos++) {
                if (xOffset + CHAR_WIDTH < minX) {
                    xOffset += CHAR_WIDTH;
                    continue;
                }
                if (xOffset >= maxX) break;
                
                const logoPos = logoData[pos];
                const letterHeights = logoPos.letterHeights;
                const aas = Object.keys(letterHeights).sort((a, b) => letterHeights[a] - letterHeights[b]);
                
                const GAP_SIZE = 2;
                const maxStackY = queryY + queryRowHeight;
                let yOffset = logoY + logoHeight;
                
                for (const aa of aas) {
                    const height = letterHeights[aa];
                    const isProbabilitiesMode = !useBitScore;
                    const shouldDraw = isProbabilitiesMode ? true : height > 1;
                    const drawHeight = isProbabilitiesMode && height > 0 && height < 0.5 ? 0.5 : height;
                    
                    if (shouldDraw && drawHeight > 0) {
                        const color = getDayhoffColor(aa);
                        const r = color.r, g = color.g, b = color.b;
                        
                        const drawX = Math.max(minX, xOffset);
                        const drawWidth = Math.min(CHAR_WIDTH, maxX - drawX);
                        if (drawWidth > 0) {
                            const drawY = yOffset - drawHeight - GAP_SIZE;
                            
                            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                            ctx.fillRect(drawX, drawY, drawWidth, drawHeight);
                            
                            const fontSize = Math.min(drawHeight * 0.8, CHAR_WIDTH * 0.8);
                            if (fontSize >= 8) {
                                ctx.fillStyle = '#000';
                                ctx.font = `bold ${fontSize}px monospace`;
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'middle';
                                const textY = drawY + drawHeight / 2;
                                ctx.fillText(aa, drawX + drawWidth / 2, textY);
                            }
                        }
                    }
                    
                    yOffset -= height + GAP_SIZE;
                }
                
                xOffset += CHAR_WIDTH;
            }
        }
        
        // Draw query sequence on top
        if (msaData.sequences.length > 0) {
            const querySeq = msaData.sequences[0];
            
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, queryY, logicalWidth, queryRowHeight);
            
            const minX = LABEL_WIDTH;
            const maxX = logicalWidth;
            let xOffset = scrollableAreaX - (scrollLeft % CHAR_WIDTH);
            for (let pos = visibleStartPos; pos < visibleEndPos && pos < querySeq.sequence.length; pos++) {
                if (xOffset + CHAR_WIDTH < minX) {
                    xOffset += CHAR_WIDTH;
                    continue;
                }
                if (xOffset >= maxX) break;
                
                const aa = querySeq.sequence[pos];
                const color = getDayhoffColor(aa);
                const r = color.r, g = color.g, b = color.b;
                
                if (xOffset + CHAR_WIDTH >= minX && xOffset < maxX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(minX, queryY, maxX - minX, queryRowHeight);
                    ctx.clip();
                    
                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.fillRect(xOffset, queryY, CHAR_WIDTH, queryRowHeight);
                    
                    ctx.fillStyle = '#000';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(aa, xOffset + CHAR_WIDTH / 2, queryY + queryRowHeight / 2);
                    
                    ctx.restore();
                }
                
                xOffset += CHAR_WIDTH;
            }
            
            const underlineY = queryY + queryRowHeight;
            const contentWidth = logoCanvasData.totalWidth;
            const underlineWidth = Math.min(logicalWidth, contentWidth);
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, underlineY);
            ctx.lineTo(underlineWidth, underlineY);
            ctx.stroke();
        }
        
        // Draw horizontal scrollbar
        const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH;
        const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
        const hScrollbarY = logicalHeight - SCROLLBAR_WIDTH;
        const hScrollbarWidth = logicalWidth - scrollableAreaX; // Full width from scrollableAreaX to canvas edge
        
        if (maxScrollX > 0) {
            const scrollRatioX = scrollLeft / maxScrollX;
            const thumbWidth = Math.max(20, (scrollableAreaWidth / totalScrollableWidth) * scrollableAreaWidth);
            const thumbX = scrollableAreaX + scrollRatioX * (scrollableAreaWidth - thumbWidth);
            
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, hScrollbarY, LABEL_WIDTH, SCROLLBAR_WIDTH);
            
            ctx.fillStyle = SCROLLBAR_TRACK_COLOR;
            ctx.fillRect(scrollableAreaX, hScrollbarY, hScrollbarWidth, SCROLLBAR_WIDTH);
            
            ctx.fillStyle = SCROLLBAR_THUMB_COLOR;
            ctx.fillRect(thumbX, hScrollbarY + SCROLLBAR_PADDING, thumbWidth, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2);
        } else {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, hScrollbarY, LABEL_WIDTH, SCROLLBAR_WIDTH);
            
            ctx.fillStyle = SCROLLBAR_TRACK_COLOR;
            ctx.fillRect(scrollableAreaX, hScrollbarY, hScrollbarWidth, SCROLLBAR_WIDTH);
        }
    }
    
    function buildMSAView() {
        const msaViewEl = document.getElementById('msaView');
        if (!msaViewEl) {
            console.warn('MSA Viewer: msaView element not found');
            return;
        }
        
        if (!msaData) {
            console.warn('MSA Viewer: No MSA data available');
            return;
        }
        
        
        msaViewEl.innerHTML = '';
        msaViewEl.classList.remove('hidden');
        
        const container = document.createElement('div');
        container.style.overflow = 'hidden';
        container.style.position = 'relative';
        container.style.backgroundColor = '#ffffff';
        
        const MSA_CHAR_WIDTH = getCharWidthForMode('msa');
        const totalWidth = NAME_COLUMN_WIDTH + (msaData.queryLength * MSA_CHAR_WIDTH);
        const totalHeight = (msaData.sequences.length + 1) * SEQUENCE_ROW_HEIGHT;
        
        const queryRowHeight = SEQUENCE_ROW_HEIGHT;
        const targetTotalHeight = 450;
        const availableForSequences = targetTotalHeight - TICK_ROW_HEIGHT - queryRowHeight - SCROLLBAR_WIDTH;
        const numSequencesToFit = Math.floor(availableForSequences / SEQUENCE_ROW_HEIGHT);
        const exactScrollableHeight = numSequencesToFit * SEQUENCE_ROW_HEIGHT;
        const viewportHeight = TICK_ROW_HEIGHT + queryRowHeight + exactScrollableHeight + SCROLLBAR_WIDTH;
        
        container.style.height = viewportHeight + 'px';
        
        const containerEl = msaViewEl.closest('#msa-viewer-container');
        const maxViewportWidth = containerEl ? containerEl.offsetWidth - 32 : 948;
        const viewportWidth = Math.min(maxViewportWidth, totalWidth + SCROLLBAR_WIDTH);
        const canvasWidth = viewportWidth;
        const canvasHeight = viewportHeight;
        
        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth * DPI_MULTIPLIER;
        canvas.height = canvasHeight * DPI_MULTIPLIER;
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
        
        msaCanvasData.ctx.scale(DPI_MULTIPLIER, DPI_MULTIPLIER);
        
        clampScrollTop(canvasHeight);
        clampScrollLeft(canvasWidth, MSA_CHAR_WIDTH);
        
        // Setup wheel scrolling
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const { logicalWidth: canvasWidth, logicalHeight: canvasHeight } = getLogicalCanvasDimensions(canvas);
            const scrollableAreaX = NAME_COLUMN_WIDTH;
            const scrollableAreaWidth = canvasWidth - scrollableAreaX - SCROLLBAR_WIDTH;
            const totalScrollableWidth = msaData.queryLength * MSA_CHAR_WIDTH;
            const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
            
            const hasHorizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const isShiftScroll = e.shiftKey && Math.abs(e.deltaY) > 0;
            
            if (hasHorizontalDelta || isShiftScroll) {
                const delta = hasHorizontalDelta ? e.deltaX : (isShiftScroll ? e.deltaY : 0);
                if (delta !== 0 && maxScrollX > 0) {
                    scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft + delta));
                    scheduleRender();
                    return;
                }
            }
            
            if (Math.abs(e.deltaY) > 0 && !hasHorizontalDelta && !isShiftScroll) {
                const { scrollableAreaHeight } = getScrollableAreaDimensions(canvasHeight);
                const totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
                const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
                scrollTop = Math.max(0, Math.min(maxScroll, scrollTop + e.deltaY));
                clampScrollTop(canvasHeight);
                scheduleRender();
            }
        }, { passive: false });
        
        // Setup scrollbar dragging (must be before selection handlers)
        let scrollbarDragState = {
            isDragging: false,
            dragType: null,
            dragStartY: 0,
            dragStartScroll: 0,
            hasMoved: false
        };
        
        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            
            const pos = getCanvasPositionFromMouse(e, canvas);
            const { logicalWidth: canvasWidth, logicalHeight: canvasHeight } = getLogicalCanvasDimensions(canvas);
            
            // Check vertical scrollbar
            const scrollableAreaY = TICK_ROW_HEIGHT + SEQUENCE_ROW_HEIGHT;
            const scrollableAreaHeight = canvasHeight - scrollableAreaY - SCROLLBAR_WIDTH;
            const totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
            const vScrollbarX = canvasWidth - SCROLLBAR_WIDTH;
            const vScrollbarYEnd = canvasHeight - SCROLLBAR_WIDTH;
            
            if (pos.x >= vScrollbarX && pos.x <= canvasWidth && pos.y >= scrollableAreaY && pos.y < vScrollbarYEnd) {
                clampScrollTop(canvasHeight);
                const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
                const scrollRatio = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0;
                const thumbHeight = Math.max(20, (scrollableAreaHeight / totalScrollableHeight) * scrollableAreaHeight);
                const thumbY = scrollableAreaY + scrollRatio * (scrollableAreaHeight - thumbHeight);
                
                if (pos.y >= thumbY && pos.y <= thumbY + thumbHeight) {
                    scrollbarDragState.isDragging = true;
                    scrollbarDragState.dragType = 'vertical';
                    scrollbarDragState.dragStartY = pos.y;
                    scrollbarDragState.dragStartScroll = scrollTop;
                    e.preventDefault();
                    
                    const handleDrag = (e) => {
                        if (!scrollbarDragState.isDragging) return;
                        const dragPos = getCanvasPositionFromMouse(e, canvas);
                        const deltaY = dragPos.y - scrollbarDragState.dragStartY;
                        if (Math.abs(deltaY) > 2) {
                            const scrollDelta = (deltaY / (scrollableAreaHeight - thumbHeight)) * maxScroll;
                            scrollTop = Math.max(0, Math.min(maxScroll, scrollbarDragState.dragStartScroll + scrollDelta));
                            clampScrollTop(canvasHeight);
                            scheduleRender();
                        }
                    };
                    
                    const handleDragEnd = () => {
                        scrollbarDragState.isDragging = false;
                        scrollbarDragState.dragType = null;
                        window.removeEventListener('mousemove', handleDrag);
                        window.removeEventListener('mouseup', handleDragEnd);
                    };
                    
                    window.addEventListener('mousemove', handleDrag);
                    window.addEventListener('mouseup', handleDragEnd);
                    return;
                } else if (pos.y >= scrollableAreaY) {
                    const newScrollRatio = Math.max(0, Math.min(1, (pos.y - scrollableAreaY - thumbHeight / 2) / (scrollableAreaHeight - thumbHeight)));
                    scrollTop = Math.max(0, Math.min(maxScroll, newScrollRatio * maxScroll));
                    clampScrollTop(canvasHeight);
                    scheduleRender();
                    e.preventDefault();
                    return;
                }
            }
            
            // Check horizontal scrollbar
            const scrollableAreaX = NAME_COLUMN_WIDTH;
            const scrollableAreaWidth = canvasWidth - scrollableAreaX - SCROLLBAR_WIDTH;
            const totalScrollableWidth = msaData.queryLength * MSA_CHAR_WIDTH;
            const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
            const hScrollbarY = canvasHeight - SCROLLBAR_WIDTH;
            const hScrollbarXEnd = canvasWidth - SCROLLBAR_WIDTH;
            
            if (pos.y >= hScrollbarY && pos.y <= canvasHeight && pos.x >= scrollableAreaX && pos.x < hScrollbarXEnd) {
                if (maxScrollX > 0) {
                    const scrollRatioX = scrollLeft / maxScrollX;
                    const thumbWidth = Math.max(20, (scrollableAreaWidth / totalScrollableWidth) * scrollableAreaWidth);
                    const thumbX = scrollableAreaX + scrollRatioX * (scrollableAreaWidth - thumbWidth);
                    
                    if (pos.x >= thumbX && pos.x <= thumbX + thumbWidth) {
                        scrollbarDragState.isDragging = true;
                        scrollbarDragState.dragType = 'horizontal';
                        scrollbarDragState.dragStartY = pos.x;
                        scrollbarDragState.dragStartScroll = scrollLeft;
                        e.preventDefault();
                        
                        const handleDrag = (e) => {
                            if (!scrollbarDragState.isDragging) return;
                            const dragPos = getCanvasPositionFromMouse(e, canvas);
                            const deltaX = dragPos.x - scrollbarDragState.dragStartY;
                            if (Math.abs(deltaX) > 2) {
                                const scrollDelta = (deltaX / (scrollableAreaWidth - thumbWidth)) * maxScrollX;
                                scrollLeft = Math.max(0, Math.min(maxScrollX, scrollbarDragState.dragStartScroll + scrollDelta));
                                scheduleRender();
                            }
                        };
                        
                        const handleDragEnd = () => {
                            scrollbarDragState.isDragging = false;
                            scrollbarDragState.dragType = null;
                            window.removeEventListener('mousemove', handleDrag);
                            window.removeEventListener('mouseup', handleDragEnd);
                        };
                        
                        window.addEventListener('mousemove', handleDrag);
                        window.addEventListener('mouseup', handleDragEnd);
                        return;
                    } else if (pos.x >= scrollableAreaX) {
                        const newScrollRatioX = Math.max(0, Math.min(1, (pos.x - scrollableAreaX - thumbWidth / 2) / (scrollableAreaWidth - thumbWidth)));
                        scrollLeft = Math.max(0, Math.min(maxScrollX, newScrollRatioX * maxScrollX));
                        scheduleRender();
                        e.preventDefault();
                        return;
                    }
                }
            }
        });
        
        
        // Initial render
        renderMSACanvas();
    }
    
    function buildLogoView() {
        const msaViewEl = document.getElementById('msaView');
        if (!msaViewEl || !msaData) return;
        
        msaViewEl.innerHTML = '';
        msaViewEl.classList.remove('hidden');
        
        const container = document.createElement('div');
        container.style.overflow = 'hidden';
        container.style.position = 'relative';
        container.style.backgroundColor = '#ffffff';
        
        const canvas = document.createElement('canvas');
        const LABEL_WIDTH = msaViewMode === 'pssm' ? CHAR_WIDTH : 0;
        const totalWidth = LABEL_WIDTH + (msaData.queryLength * CHAR_WIDTH);
        
        const containerEl = msaViewEl.closest('#msa-viewer-container');
        const maxViewportWidth = containerEl ? containerEl.offsetWidth - 32 : 948;
        const viewportWidth = Math.min(maxViewportWidth, totalWidth + SCROLLBAR_WIDTH);
        const canvasWidth = viewportWidth;
        
        const queryRowHeight = CHAR_WIDTH;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const logoHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        const canvasHeight = TICK_ROW_HEIGHT + queryRowHeight + logoHeight + SCROLLBAR_WIDTH;
        
        container.style.width = canvasWidth + 'px';
        container.style.height = canvasHeight + 'px';
        
        canvas.width = canvasWidth * DPI_MULTIPLIER;
        canvas.height = canvasHeight * DPI_MULTIPLIER;
        canvas.style.width = canvasWidth + 'px';
        canvas.style.height = canvasHeight + 'px';
        canvas.style.display = 'block';
        canvas.style.position = 'relative';
        canvas.style.pointerEvents = 'auto';
        
        container.appendChild(canvas);
        msaViewEl.appendChild(container);
        
        logoCanvasData = {
            canvas: canvas,
            ctx: canvas.getContext('2d'),
            container: container,
            totalWidth: totalWidth,
            canvasWidth: canvasWidth,
            totalHeight: canvasHeight
        };
        
        logoCanvasData.ctx.scale(DPI_MULTIPLIER, DPI_MULTIPLIER);
        
        clampScrollLeft(canvasWidth, CHAR_WIDTH);
        
        // Setup wheel scrolling
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const { logicalWidth: canvasWidth, logicalHeight: canvasHeight } = getLogicalCanvasDimensions(canvas);
            const { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight } = 
                getScrollableAreaForMode(msaViewMode, canvasWidth, canvasHeight);
            const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH;
            const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
            
            const hasHorizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const isShiftScroll = e.shiftKey && Math.abs(e.deltaY) > 0;
            
            if (hasHorizontalDelta || isShiftScroll) {
                const delta = hasHorizontalDelta ? e.deltaX : (isShiftScroll ? e.deltaY : 0);
                if (delta !== 0 && maxScrollX > 0) {
                    scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft + delta));
                    scheduleRender();
                }
            }
        }, { passive: false });
        
        // Setup scrollbar dragging
        let scrollbarDragState = {
            isDragging: false,
            dragType: null,
            dragStartY: 0,
            dragStartScroll: 0
        };
        
        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            
            const pos = getCanvasPositionFromMouse(e, canvas);
            const { logicalWidth: canvasWidth, logicalHeight: canvasHeight } = getLogicalCanvasDimensions(canvas);
            const { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight } = 
                getScrollableAreaForMode(msaViewMode, canvasWidth, canvasHeight);
            const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH;
            const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
            const hScrollbarY = canvasHeight - SCROLLBAR_WIDTH;
            
            // Check horizontal scrollbar
            if (pos.y >= hScrollbarY && pos.y <= canvasHeight && pos.x >= scrollableAreaX && pos.x < canvasWidth) {
                if (maxScrollX > 0) {
                    const scrollRatioX = scrollLeft / maxScrollX;
                    const thumbWidth = Math.max(20, (scrollableAreaWidth / totalScrollableWidth) * scrollableAreaWidth);
                    const thumbX = scrollableAreaX + scrollRatioX * (scrollableAreaWidth - thumbWidth);
                    
                    if (pos.x >= thumbX && pos.x <= thumbX + thumbWidth) {
                        scrollbarDragState.isDragging = true;
                        scrollbarDragState.dragType = 'horizontal';
                        scrollbarDragState.dragStartY = pos.x;
                        scrollbarDragState.dragStartScroll = scrollLeft;
                        e.preventDefault();
                        
                        const handleDrag = (e) => {
                            if (!scrollbarDragState.isDragging) return;
                            const dragPos = getCanvasPositionFromMouse(e, canvas);
                            const deltaX = dragPos.x - scrollbarDragState.dragStartY;
                            if (Math.abs(deltaX) > 2) {
                                const scrollDelta = (deltaX / (scrollableAreaWidth - thumbWidth)) * maxScrollX;
                                scrollLeft = Math.max(0, Math.min(maxScrollX, scrollbarDragState.dragStartScroll + scrollDelta));
                                scheduleRender();
                            }
                        };
                        
                        const handleDragEnd = () => {
                            scrollbarDragState.isDragging = false;
                            scrollbarDragState.dragType = null;
                            window.removeEventListener('mousemove', handleDrag);
                            window.removeEventListener('mouseup', handleDragEnd);
                        };
                        
                        window.addEventListener('mousemove', handleDrag);
                        window.addEventListener('mouseup', handleDragEnd);
                        return;
                    } else if (pos.x >= scrollableAreaX) {
                        const newScrollRatioX = Math.max(0, Math.min(1, (pos.x - scrollableAreaX - thumbWidth / 2) / (scrollableAreaWidth - thumbWidth)));
                        scrollLeft = Math.max(0, Math.min(maxScrollX, newScrollRatioX * maxScrollX));
                        scheduleRender();
                        e.preventDefault();
                        return;
                    }
                }
            }
        });
        
        
        renderLogoCanvas();
    }
    
    // ============================================================================
    // PUBLIC API
    // ============================================================================
    
    window.MSAViewer = {
        setCallbacks: function(cb) {
            callbacks = Object.assign({}, callbacks, cb);
        },
        
        parseA3M: parseA3M,
        
        getMSAData: function() {
            return msaData;
        },
        
        setCoverageCutoff: function(cutoff) {
            coverageCutoff = Math.max(0, Math.min(1, cutoff));
            if (originalMSAData) {
                const oldSequenceCount = msaData ? msaData.sequences.length : 0;
                
                let filtered = filterSequencesByCoverage(originalMSAData.sequences, coverageCutoff);
                filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
                const sorted = sortSequencesBySimilarity(filtered, originalMSAData.querySequence);
                
                msaData = {
                    sequences: sorted,
                    querySequence: originalMSAData.querySequence,
                    queryLength: originalMSAData.queryLength
                };
                
                const newSequenceCount = msaData.sequences.length;
                if (oldSequenceCount > 0 && newSequenceCount !== oldSequenceCount) {
                    let canvasHeight = 400;
                    if (msaCanvasData && msaCanvasData.canvas) {
                        canvasHeight = msaCanvasData.canvas.height / DPI_MULTIPLIER;
                    }
                    clampScrollTop(canvasHeight);
                }
                
                cachedFrequencies = null;
                cachedLogOdds = null;
                cachedDataHash = null;
                
                if (msaViewMode === 'msa') {
                    if (msaCanvasData && msaCanvasData.canvas) {
                        scheduleRender();
                    } else {
                        buildMSAView();
                    }
                } else {
                    if (logoCanvasData && logoCanvasData.canvas) {
                        scheduleRender();
                    } else {
                        buildLogoView();
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
            this.setCoverageCutoff(coverageCutoff);
        },
        
        setIdentityCutoff: function(cutoff) {
            identityCutoff = Math.max(0, Math.min(1, cutoff));
            if (originalMSAData) {
                const oldSequenceCount = msaData ? msaData.sequences.length : 0;
                
                let filtered = filterSequencesByCoverage(originalMSAData.sequences, coverageCutoff);
                filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
                const sorted = sortSequencesBySimilarity(filtered, originalMSAData.querySequence);
                
                msaData = {
                    sequences: sorted,
                    querySequence: originalMSAData.querySequence,
                    queryLength: originalMSAData.queryLength
                };
                
                const newSequenceCount = msaData.sequences.length;
                if (oldSequenceCount > 0 && newSequenceCount !== oldSequenceCount) {
                    let canvasHeight = 400;
                    if (msaCanvasData && msaCanvasData.canvas) {
                        canvasHeight = msaCanvasData.canvas.height / DPI_MULTIPLIER;
                    }
                    clampScrollTop(canvasHeight);
                }
                
                cachedFrequencies = null;
                cachedLogOdds = null;
                cachedDataHash = null;
                
                if (msaViewMode === 'msa') {
                    if (msaCanvasData && msaCanvasData.canvas) {
                        scheduleRender();
                    } else {
                        buildMSAView();
                    }
                } else {
                    if (logoCanvasData && logoCanvasData.canvas) {
                        scheduleRender();
                    } else {
                        buildLogoView();
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
            this.setIdentityCutoff(identityCutoff);
        },
        
        setMSAData: function(data, chainId = null, type = 'unpaired') {
            if (!chainId && callbacks.getRenderer) {
                const renderer = callbacks.getRenderer();
                if (renderer && renderer.currentObjectName) {
                    const obj = renderer.objectsData[renderer.currentObjectName];
                    if (obj && obj.msa) {
                        if (obj.msa.defaultChain) {
                            chainId = obj.msa.defaultChain;
                        } else if (obj.msa.availableChains && obj.msa.availableChains.length > 0) {
                            chainId = obj.msa.availableChains[0];
                        }
                    }
                }
            }
            currentChain = chainId;
            currentMSAType = type;
            originalMSAData = data;
            
            let filtered = filterSequencesByCoverage(originalMSAData.sequences, coverageCutoff);
            filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
            const sorted = sortSequencesBySimilarity(filtered, originalMSAData.querySequence);
            
            msaData = {
                sequences: sorted,
                querySequence: originalMSAData.querySequence,
                queryLength: originalMSAData.queryLength
            };
            
            cachedFrequencies = null;
            cachedLogOdds = null;
            cachedDataHash = null;
            
            let canvasWidth = 916;
            let charWidth = getCharWidthForMode(msaViewMode);
            if (msaViewMode === 'msa' && msaCanvasData && msaCanvasData.canvas) {
                canvasWidth = msaCanvasData.canvas.width / DPI_MULTIPLIER;
            } else if ((msaViewMode === 'pssm' || msaViewMode === 'logo') && logoCanvasData && logoCanvasData.canvas) {
                canvasWidth = logoCanvasData.canvas.width / DPI_MULTIPLIER;
            }
            clampScrollLeft(canvasWidth, charWidth);
            
            const msaContainer = document.getElementById('msa-viewer-container');
            if (msaContainer) {
                msaContainer.style.setProperty('display', 'block', 'important');
            }
            
            const msaViewEl = document.getElementById('msaView');
            if (msaViewEl) {
                msaViewEl.classList.remove('hidden');
            }
            
            if (msaViewMode === 'msa') {
                buildMSAView();
            } else if (msaViewMode === 'pssm' || msaViewMode === 'logo') {
                buildLogoView();
            }
        },
        
        setChain: function(chainId) {
            currentChain = chainId;
            if (callbacks.getRenderer) {
                const renderer = callbacks.getRenderer();
                if (renderer && renderer.currentObjectName) {
                    const obj = renderer.objectsData[renderer.currentObjectName];
                    if (obj && obj.msa && obj.msa.msasBySequence && obj.msa.chainToSequence) {
                        const querySeq = obj.msa.chainToSequence[chainId];
                        if (querySeq && obj.msa.msasBySequence[querySeq]) {
                            const {msaData, type} = obj.msa.msasBySequence[querySeq];
                            this.setMSAData(msaData, chainId, type);
                        }
                    }
                }
            }
        },
        
        setMSAType: function(type) {
            currentMSAType = type;
            if (currentChain && callbacks.getRenderer) {
                const renderer = callbacks.getRenderer();
                if (renderer && renderer.currentObjectName) {
                    const obj = renderer.objectsData[renderer.currentObjectName];
                    if (obj && obj.msa && obj.msa.msasBySequence && obj.msa.chainToSequence) {
                        const querySeq = obj.msa.chainToSequence[currentChain];
                        if (querySeq && obj.msa.msasBySequence[querySeq]) {
                            const msaEntry = obj.msa.msasBySequence[querySeq];
                            if (msaEntry.msaData) {
                                this.setMSAData(msaEntry.msaData, currentChain, type);
                            }
                        }
                    }
                }
            }
        },
        
        getCurrentChain: function() {
            return currentChain;
        },
        
        getCurrentMSAType: function() {
            return currentMSAType;
        },
        
        getMSAMode: function() {
            return msaViewMode;
        },
        
        setMSAMode: function(mode) {
            if (msaViewMode !== mode && msaData) {
                const oldCharWidth = msaViewMode === 'msa' ? CHAR_WIDTH / 2 : CHAR_WIDTH;
                const newCharWidth = mode === 'msa' ? CHAR_WIDTH / 2 : CHAR_WIDTH;
                const charPosition = scrollLeft / oldCharWidth;
                scrollLeft = charPosition * newCharWidth;
            }
            
            msaViewMode = mode;
            if (mode === 'logo') {
                cachedLogOdds = null;
            }
            
            if (mode === 'msa') {
                buildMSAView();
                if (msaCanvasData && msaCanvasData.canvas && msaData) {
                    const MSA_CHAR_WIDTH = CHAR_WIDTH / 2;
                    const canvasWidth = msaCanvasData.canvas.width / DPI_MULTIPLIER;
                    const scrollableAreaX = NAME_COLUMN_WIDTH;
                    const scrollableAreaWidth = canvasWidth - scrollableAreaX - SCROLLBAR_WIDTH;
                    const totalScrollableWidth = msaData.queryLength * MSA_CHAR_WIDTH;
                    const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
                    const oldScrollLeft = scrollLeft;
                    scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft));
                    if (oldScrollLeft !== scrollLeft) {
                        scheduleRender();
                    }
                }
            } else if (mode === 'pssm' || mode === 'logo') {
                buildLogoView();
                if (logoCanvasData && logoCanvasData.canvas && msaData) {
                    const canvasWidth = logoCanvasData.canvas.width / DPI_MULTIPLIER;
                    const LABEL_WIDTH = mode === 'pssm' ? CHAR_WIDTH : 0;
                    const scrollableAreaX = LABEL_WIDTH;
                    const scrollableAreaWidth = canvasWidth - scrollableAreaX - SCROLLBAR_WIDTH;
                    const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH;
                    const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
                    const oldScrollLeft = scrollLeft;
                    scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft));
                    if (oldScrollLeft !== scrollLeft) {
                        scheduleRender();
                    }
                }
            }
        },
        
        getUseBitScore: function() {
            return useBitScore;
        },
        
        setUseBitScore: function(value) {
            useBitScore = value;
            if (!useBitScore) {
                cachedLogOdds = null;
            }
            if (msaViewMode === 'logo') {
                scheduleRender();
            }
        },
        
        getSequenceCounts: function() {
            const filtered = msaData ? msaData.sequences.length : 0;
            const total = originalMSAData ? originalMSAData.sequences.length : 0;
            return { filtered, total };
        },
        
        clear: function() {
            msaData = null;
            originalMSAData = null;
            msaCanvasData = null;
            logoCanvasData = null;
            cachedFrequencies = null;
            cachedLogOdds = null;
            cachedDataHash = null;
        },
        
        buildMSAView: buildMSAView,
        buildLogoView: buildLogoView
    };
    
})();
