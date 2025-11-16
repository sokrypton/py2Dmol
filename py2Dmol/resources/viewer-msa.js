// ============================================================================
// MSA VIEWER MODULE (Rewritten from scratch)
// ============================================================================
// Simple, clean implementation with direct MSA position → atom index mapping

(function() {
    'use strict';

    // ============================================================================
    // SIMPLE CANVAS2SVG FOR MSA VIEWER
    // ============================================================================
    // Minimal canvas2svg implementation for MSA viewer
    // Supports: fillRect, strokeRect, fillText, clip, save/restore
    
    function SimpleCanvas2SVG(width, height) {
        this.width = width;
        this.height = height;
        this.strokeStyle = '#000000';
        this.fillStyle = '#000000';
        this.lineWidth = 1;
        this.font = '10px monospace';
        this.textAlign = 'left';
        this.textBaseline = 'alphabetic';
        this.operations = [];
        this.clipStack = [];
        this.currentClip = null;
        this.transformStack = [];
        this.currentTransform = { tx: 0, ty: 0, sx: 1, sy: 1, rotation: 0 };
    }
    
    SimpleCanvas2SVG.prototype.fillRect = function(x, y, w, h) {
        this.operations.push({
            type: 'rect',
            x: x, y: y, width: w, height: h,
            fillStyle: this.fillStyle,
            clip: this.currentClip
        });
    };
    
    SimpleCanvas2SVG.prototype.strokeRect = function(x, y, w, h) {
        this.operations.push({
            type: 'strokeRect',
            x: x, y: y, width: w, height: h,
            strokeStyle: this.strokeStyle,
            lineWidth: this.lineWidth,
            clip: this.currentClip
        });
    };
    
    SimpleCanvas2SVG.prototype.fillText = function(text, x, y) {
        // Store transform state at time of fillText call
        // Note: drawScaledLetter draws at (0,0) after translate/scale, so x,y will be 0,0
        // The transform contains the actual position (tx, ty) and scale (sx, sy)
        this.operations.push({
            type: 'text',
            text: text,
            x: x, y: y, // Usually (0,0) for drawScaledLetter
            fillStyle: this.fillStyle,
            font: this.font,
            textAlign: this.textAlign,
            textBaseline: this.textBaseline,
            clip: this.currentClip,
            transform: {
                tx: this.currentTransform.tx,
                ty: this.currentTransform.ty,
                sx: this.currentTransform.sx,
                sy: this.currentTransform.sy,
                rotation: this.currentTransform.rotation
            } // Copy current transform state
        });
    };
    
    SimpleCanvas2SVG.prototype.beginPath = function() {
        this.currentPath = [];
    };
    
    SimpleCanvas2SVG.prototype.moveTo = function(x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'M', x: x, y: y });
    };
    
    SimpleCanvas2SVG.prototype.lineTo = function(x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'L', x: x, y: y });
    };
    
    SimpleCanvas2SVG.prototype.stroke = function() {
        if (!this.currentPath || this.currentPath.length === 0) return;
        
        let pathData = '';
        for (let i = 0; i < this.currentPath.length; i++) {
            const cmd = this.currentPath[i];
            if (cmd.type === 'M') pathData += `M ${cmd.x} ${cmd.y} `;
            else if (cmd.type === 'L') pathData += `L ${cmd.x} ${cmd.y} `;
        }
        
        this.operations.push({
            type: 'stroke',
            pathData: pathData.trim(),
            strokeStyle: this.strokeStyle,
            lineWidth: this.lineWidth,
            clip: this.currentClip
        });
        this.currentPath = null;
    };
    
    SimpleCanvas2SVG.prototype.rect = function(x, y, w, h) {
        // Used for clipping
        this.currentPath = { type: 'rect', x: x, y: y, width: w, height: h };
    };
    
    SimpleCanvas2SVG.prototype.clip = function() {
        if (this.currentPath && this.currentPath.type === 'rect') {
            this.currentClip = {
                type: 'rect',
                x: this.currentPath.x,
                y: this.currentPath.y,
                width: this.currentPath.width,
                height: this.currentPath.height
            };
            this.currentPath = null;
        }
    };
    
    SimpleCanvas2SVG.prototype.save = function() {
        this.clipStack.push(this.currentClip);
        this.transformStack.push({...this.currentTransform});
    };
    
    SimpleCanvas2SVG.prototype.restore = function() {
        if (this.clipStack.length > 0) {
            this.currentClip = this.clipStack.pop();
        } else {
            this.currentClip = null;
        }
        if (this.transformStack.length > 0) {
            this.currentTransform = this.transformStack.pop();
        } else {
            this.currentTransform = { tx: 0, ty: 0, sx: 1, sy: 1, rotation: 0 };
        }
    };
    
    SimpleCanvas2SVG.prototype.clearRect = function() {
        // Ignore - we add white background in SVG
    };
    
    // Transform methods - track transforms and apply to operations
    SimpleCanvas2SVG.prototype.translate = function(tx, ty) {
        this.currentTransform.tx += tx * this.currentTransform.sx;
        this.currentTransform.ty += ty * this.currentTransform.sy;
    };
    
    SimpleCanvas2SVG.prototype.scale = function(sx, sy) {
        this.currentTransform.sx *= sx;
        this.currentTransform.sy *= (sy !== undefined ? sy : sx);
    };
    
    SimpleCanvas2SVG.prototype.rotate = function(angle) {
        this.currentTransform.rotation += angle;
    };
    
    SimpleCanvas2SVG.prototype.setTransform = function() {
        // Reset transform
        this.currentTransform = { tx: 0, ty: 0, sx: 1, sy: 1, rotation: 0 };
    };
    
    SimpleCanvas2SVG.prototype.fill = function() {};
    
    // measureText - needed for getGlyphMetrics
    // Create a temporary canvas context for text measurement
    let measureTextCanvas = null;
    let measureTextCtx = null;
    SimpleCanvas2SVG.prototype.measureText = function(text) {
        // Use a temporary canvas context for measurement
        if (!measureTextCanvas) {
            measureTextCanvas = document.createElement('canvas');
            measureTextCtx = measureTextCanvas.getContext('2d');
        }
        
        // Set font to match current font
        measureTextCtx.font = this.font;
        measureTextCtx.textAlign = this.textAlign;
        measureTextCtx.textBaseline = this.textBaseline;
        
        // Measure text
        const metrics = measureTextCtx.measureText(text);
        
        // Return metrics object with required properties
        return {
            width: metrics.width,
            actualBoundingBoxLeft: metrics.actualBoundingBoxLeft || 0,
            actualBoundingBoxRight: metrics.actualBoundingBoxRight || metrics.width,
            actualBoundingBoxAscent: metrics.actualBoundingBoxAscent || 0,
            actualBoundingBoxDescent: metrics.actualBoundingBoxDescent || 0
        };
    };
    
    // Color conversion: rgb(r,g,b) -> #rrggbb
    function rgbToHex(color) {
        if (!color || color.startsWith('#')) return color || '#000000';
        const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (m) {
            const r = parseInt(m[1]).toString(16).padStart(2, '0');
            const g = parseInt(m[2]).toString(16).padStart(2, '0');
            const b = parseInt(m[3]).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        }
        return color;
    }
    
    // Generate SVG
    SimpleCanvas2SVG.prototype.getSerializedSvg = function() {
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">\n`;
        svg += `  <rect width="${this.width}" height="${this.height}" fill="#ffffff"/>\n`;
        
        for (let i = 0; i < this.operations.length; i++) {
            const op = this.operations[i];
            let element = '';
            
            if (op.clip) {
                element += `  <g clip-path="url(#clip${i})">\n`;
                svg += `  <defs><clipPath id="clip${i}"><rect x="${op.clip.x}" y="${op.clip.y}" width="${op.clip.width}" height="${op.clip.height}"/></clipPath></defs>\n`;
            }
            
            if (op.type === 'rect') {
                element += `  <rect x="${op.x}" y="${op.y}" width="${op.width}" height="${op.height}" fill="${rgbToHex(op.fillStyle)}"/>\n`;
            } else if (op.type === 'strokeRect') {
                element += `  <rect x="${op.x}" y="${op.y}" width="${op.width}" height="${op.height}" fill="none" stroke="${rgbToHex(op.strokeStyle)}" stroke-width="${op.lineWidth}"/>\n`;
            } else if (op.type === 'stroke') {
                const cap = 'butt';
                element += `  <path d="${op.pathData}" stroke="${rgbToHex(op.strokeStyle)}" stroke-width="${op.lineWidth}" stroke-linecap="${cap}" fill="none"/>\n`;
            } else if (op.type === 'text') {
                // Handle two cases:
                // 1. Regular text (no transform): use x, y directly
                // 2. Scaled letters (with transform): drawScaledLetter does translate(tx,ty) -> scale(sx,sy) -> fillText(0,0)
                
                let textX = op.x;
                let textY = op.y;
                
                // Build transform string for SVG
                let transformParts = [];
                let hasTransform = op.transform && (op.transform.tx !== 0 || op.transform.ty !== 0 || 
                                                     op.transform.sx !== 1 || op.transform.sy !== 1 || 
                                                     op.transform.rotation !== 0);
                
                if (hasTransform) {
                    // This is from drawScaledLetter: text is drawn at (0,0) after translate/scale
                    // The translation becomes the text position
                    const tx = op.transform.tx;
                    const ty = op.transform.ty;
                    textX = tx;
                    textY = ty;
                    
                    // Apply scale as SVG transform around the text position
                    if (op.transform.sx !== 1 || op.transform.sy !== 1) {
                        transformParts.push(`translate(${tx.toFixed(4)},${ty.toFixed(4)})`);
                        transformParts.push(`scale(${op.transform.sx.toFixed(6)},${op.transform.sy.toFixed(6)})`);
                        transformParts.push(`translate(${-tx.toFixed(4)},${-ty.toFixed(4)})`);
                    }
                    
                    // Apply rotation if present
                    if (op.transform.rotation !== 0) {
                        transformParts.push(`rotate(${(op.transform.rotation * 180 / Math.PI).toFixed(2)} ${tx.toFixed(4)} ${ty.toFixed(4)})`);
                    }
                } else {
                    // Regular text: adjust for textBaseline
                    if (op.textBaseline === 'middle') {
                        const fontSizeMatch = op.font.match(/(\d+)px/);
                        const fontSize = fontSizeMatch ? parseInt(fontSizeMatch[1]) : 10;
                        textY += fontSize / 2;
                    }
                    // alphabetic baseline needs no adjustment
                }
                
                // Adjust for textAlign
                let textAnchor = 'start';
                if (op.textAlign === 'center') {
                    textAnchor = 'middle';
                } else if (op.textAlign === 'right' || op.textAlign === 'end') {
                    textAnchor = 'end';
                }
                
                // Escape XML special characters
                const escapedText = op.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                
                // Get font size
                const baseFontSize = parseInt(op.font.match(/(\d+)px/)?.[1] || 10);
                
                // Determine font weight
                let fontWeight = 'normal';
                if (op.font.includes('bold')) {
                    fontWeight = 'bold';
                }
                
                // Build transform attribute
                let transformAttr = '';
                if (transformParts.length > 0) {
                    transformAttr = ` transform="${transformParts.join(' ')}"`;
                }
                
                // Use appropriate dominant-baseline
                let dominantBaseline = op.textBaseline === 'middle' ? 'middle' : 'alphabetic';
                
                element += `  <text x="${textX}" y="${textY}" fill="${rgbToHex(op.fillStyle)}" font-family="monospace" font-size="${baseFontSize}" font-weight="${fontWeight}" text-anchor="${textAnchor}" dominant-baseline="${dominantBaseline}"${transformAttr}>${escapedText}</text>\n`;
            }
            
            if (op.clip) {
                element += `  </g>\n`;
            }
            
            svg += element;
        }
        
        svg += '</svg>';
        return svg;
    };

    // === Letter-mode helpers (WebLogo-style glyph scaling) ===
    const LETTER_BASE_FONT = 'bold 100px monospace'; // big base for precise metrics
    const glyphMetricsCache = new Map();

    function getGlyphMetrics(ctx, ch) {
        const key = ch;
        if (glyphMetricsCache.has(key)) return glyphMetricsCache.get(key);
        ctx.save();
        ctx.font = LETTER_BASE_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const m = ctx.measureText(ch);
        ctx.restore();
        const left   = m.actualBoundingBoxLeft   ?? 0;
        const right  = m.actualBoundingBoxRight  ?? (m.width ?? 100);
        const ascent = m.actualBoundingBoxAscent ?? 80;
        const desc   = m.actualBoundingBoxDescent?? 20;
        
        // Special handling for Q: its tail can extend beyond normal bounds
        // Use measured width for Q to get more accurate bounds
        let glyphWidth = (left + right) || (m.width || 100);
        if (ch === 'Q' || ch === 'q') {
            // For Q, use the measured width which better captures the full glyph
            glyphWidth = m.width || 100;
        }
        
        const metrics = {
            left,
            width: glyphWidth || 1,
            ascent,
            descent: desc,
            height: (ascent + desc) || 1
        };
        glyphMetricsCache.set(key, metrics);
        return metrics;
    }

    function drawScaledLetter(ctx, ch, x, yBottom, w, h, color, clipRect) {
        if (h <= 0 || w <= 0) return;
        const g = getGlyphMetrics(ctx, ch);
        const sx = w / g.width;
        const sy = h / g.height;
        
        // Adjust vertical position upward for all letters to keep descenders visible
        // This ensures letters with parts extending below baseline (Q, S, G, etc.) stay within bounds
        const yOffset = g.descent * sy * 1.0; // Move up by 100% of descent (full descent amount)
        
        ctx.save();
        // Apply clipRect if provided
        if (clipRect) {
            ctx.beginPath();
            ctx.rect(clipRect.x, clipRect.y, clipRect.w, clipRect.h);
            ctx.clip();
        }
        ctx.translate(x + g.left * sx, yBottom - yOffset);
        ctx.scale(sx, sy);
        ctx.fillStyle = color;
        ctx.font = LETTER_BASE_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(ch, 0, 0);
        ctx.restore();
    }



    // ============================================================================
    // INTERNAL STATE
    // ============================================================================
    let msaData = null; // { sequences: [], querySequence: string, queryLength: number, residueNumbers: [] }
    let originalMSAData = null; // Original unfiltered MSA data
    let msaResidueNumbers = null; // Array mapping MSA positions to structure residue_numbers values
    let msaCanvasData = null; // Canvas-based structure for MSA mode
    let pssmCanvasData = null; // Canvas-based structure for PSSM mode
    let logoCanvasData = null; // Canvas-based structure for Logo mode
    let msaViewMode = 'msa'; // 'msa', 'pssm', or 'logo'
    let useBitScore = true; // true for bit-score, false for probabilities
    let sortSequences = true; // true for sorted by similarity, false for original order
    let currentChain = null; // Current chain ID
    let renderScheduled = false;
    let coverageCutoff = 0.75;
    let previewCoverageCutoff = 0.75;
    let identityCutoff = 0.15;
    let previewIdentityCutoff = 0.15;
    
    // Cached logo data
    let cachedFrequencies = null;
    let cachedLogOdds = null;
    let cachedDataHash = null;
    let cachedEntropy = null;
    let cachedEntropyHash = null;
    
    // Virtual scrolling state
    let visibleSequenceStart = 0;
    let visibleSequenceEnd = 0;
    let scrollTop = 0;
    let scrollLeft = 0;
    const MAX_VISIBLE_SEQUENCES = 100;
    const SEQUENCE_ROW_HEIGHT = 20;
    const CHAR_WIDTH = 20;
    const NAME_COLUMN_WIDTH = 200;
    const Y_AXIS_WIDTH = 40; // For Logo mode Y-axis
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
    
    
    // Amino acid groups with custom colors
    const DAYHOFF_GROUP_DEFINITIONS = [
        { name: 'group1', label: 'KR', aminoAcids: ['K', 'R'], color: {r: 212, g: 68, b: 43} }, // #d4442b
        { name: 'group2', label: 'AFILMVW', aminoAcids: ['A', 'F', 'I', 'L', 'M', 'V', 'W'], color: {r: 61, g: 126, b: 223} }, // #3d7edf
        { name: 'group3', label: 'NQST', aminoAcids: ['N', 'Q', 'S', 'T'], color: {r: 96, g: 201, b: 65} }, // #60c941
        { name: 'group4', label: 'HY', aminoAcids: ['H', 'Y'], color: {r: 83, g: 177, b: 178} }, // #53b1b2
        { name: 'group5', label: 'C', aminoAcids: ['C'], color: {r: 217, g: 133, b: 130} }, // #d98582
        { name: 'group6', label: 'DE', aminoAcids: ['D', 'E'], color: {r: 189, g: 85, b: 198} }, // #bd55c6
        { name: 'group7', label: 'P', aminoAcids: ['P'], color: {r: 204, g: 204, b: 65} }, // #cccc41
        { name: 'group8', label: 'G', aminoAcids: ['G'], color: {r: 219, g: 157, b: 91} } // #db9d5b
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
    
    // Resize management
    let resizeObserver = null;
    let currentContainerWidth = 948;
    let currentContainerHeight = 500;  // Initial default height
    let resizeAnimationFrame = null;
    
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
            } else if (msaViewMode === 'pssm') {
                renderPSSMCanvas();
            } else if (msaViewMode === 'logo') {
                renderLogoCanvas();
            }
        });
    }
    
    function buildViewForMode(mode) {
        switch(mode) {
            case 'msa':
                buildMSAView();
                break;
            case 'pssm':
                buildPSSMView();
                break;
            case 'logo':
                buildLogoView();
                break;
        }
    }
    
    function renderForMode(mode) {
        switch(mode) {
            case 'msa':
                renderMSACanvas();
                break;
            case 'pssm':
                renderPSSMCanvas();
                break;
            case 'logo':
                renderLogoCanvas();
                break;
        }
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
            if (seq.name === '>query' || seq.name.toLowerCase().includes('query')) return true;
            // Use pre-calculated identity if available, otherwise calculate it
            if (seq.identity !== undefined) {
                return seq.identity >= minIdentity;
            }
            const identity = calculateSequenceSimilarity(seq.sequence, querySequence);
            return identity >= minIdentity;
        });
    }
    
    function sortSequencesByIdentity(sequences, querySequence, queryLength) {
        if (!sequences || sequences.length === 0 || !querySequence) return sequences;
        
        const sequencesWithIdentity = sequences.map(seq => ({
            ...seq,
            identity: calculateSequenceSimilarity(seq.sequence, querySequence),
            coverage: calculateSequenceCoverage(seq.sequence, queryLength)
        }));
        
        sequencesWithIdentity.sort((a, b) => {
            if (a.name === '>query' || a.name.toLowerCase().includes('query')) return -1;
            if (b.name === '>query' || b.name.toLowerCase().includes('query')) return 1;
            return b.identity - a.identity;
        });
        
        return sequencesWithIdentity;
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
                if (currentHeader && currentSequence) {
                    const alignedSequence = currentSequence.replace(/[a-z]/g, '').toUpperCase();
                    sequences.push({
                        name: currentHeader, // Preserve full name
                        sequence: alignedSequence
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
                name: currentHeader, // Preserve full name
                sequence: alignedSequence
            });
        }
        
        if (sequences.length === 0) return null;
        
        let queryIndex = sequences.findIndex(s => s.name.toLowerCase().includes('query'));
        if (queryIndex === -1) queryIndex = 0;
        
        const querySequence = sequences[queryIndex].sequence;
        if (!querySequence || querySequence.length === 0) {
            return null; // Invalid: query sequence is empty
        }
        
        const queryLength = querySequence.length;
        const sorted = sortSequencesByIdentity(sequences, querySequence, queryLength);
        
        return {
            sequences: sorted,
            sequencesOriginal: sequences, // Store original order
            querySequence: querySequence,
            queryLength: queryLength,
            queryIndex: queryIndex
        };
    }
    
    function parseFasta(fileContent) {
        const lines = fileContent.split('\n');
        const sequences = [];
        let currentHeader = null;
        let currentSequence = '';
        
        // Parse FASTA format
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            if (line.startsWith('>')) {
                if (currentHeader && currentSequence) {
                    // Preserve gaps, only convert to uppercase
                    const alignedSequence = currentSequence.toUpperCase();
                    sequences.push({
                        name: currentHeader, // Preserve full name
                        sequence: alignedSequence
                    });
                }
                const fullHeader = line.substring(1);
                currentHeader = fullHeader.split(/[\s\t]/)[0];
                currentSequence = '';
            } else {
                currentSequence += line;
            }
        }
        
        // Handle last sequence
        if (currentHeader && currentSequence) {
            // Preserve gaps, only convert to uppercase
            const alignedSequence = currentSequence.toUpperCase();
            sequences.push({
                name: currentHeader, // Preserve full name
                sequence: alignedSequence
            });
        }
        
        if (sequences.length === 0) return null;
        
        // First sequence is the query
        const queryIndex = 0;
        const originalQuerySequence = sequences[queryIndex].sequence;
        
        // Identify positions in query that are gaps ("-")
        // Build array of indices to keep (non-gap positions in query)
        const positionsToKeep = [];
        for (let i = 0; i < originalQuerySequence.length; i++) {
            if (originalQuerySequence[i] !== '-') {
                positionsToKeep.push(i);
            }
        }
        
        // Remove gap positions from query sequence
        const querySequence = positionsToKeep.map(i => originalQuerySequence[i]).join('');
        const queryLength = querySequence.length;
        
        // Filter all sequences: remove positions where query has gaps
        // Also truncate sequences longer than query to query's original length first
        const originalQueryLength = originalQuerySequence.length;
        const filteredSequences = sequences.map(seq => {
            let sequence = seq.sequence;
            
            // First, truncate if longer than original query length
            if (sequence.length > originalQueryLength) {
                sequence = sequence.substring(0, originalQueryLength);
            }
            
            // Then, remove positions where query has gaps
            const filteredSequence = positionsToKeep.map(i => {
                // If sequence is shorter than original query, pad with gaps
                return (i < sequence.length) ? sequence[i] : '-';
            }).join('');
            
            return {
                ...seq,
                sequence: filteredSequence
            };
        });
        
        const sorted = sortSequencesByIdentity(filteredSequences, querySequence, queryLength);
        
        return {
            sequences: sorted,
            sequencesOriginal: filteredSequences, // Store original order
            querySequence: querySequence,
            queryLength: queryLength,
            queryIndex: queryIndex
        };
    }
    
    function parseSTO(fileContent) {
        const lines = fileContent.split('\n');
        const sequences = new Map(); // Use Map to handle multi-line sequences
        let inAlignment = false;
        
        // Parse STO format
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines and comments/annotations
            if (!line || line.startsWith('#') || line === '//') {
                if (line === '//') break; // End of alignment
                continue;
            }
            
            // Check for STOCKHOLM header (optional, but good to recognize)
            if (line.startsWith('# STOCKHOLM')) {
                inAlignment = true;
                continue;
            }
            
            // Parse sequence line: <name> <sequence>
            // Name and sequence are separated by whitespace
            const parts = line.split(/\s+/);
            if (parts.length < 2) continue;
            
            const name = parts[0];
            const sequencePart = parts.slice(1).join('').toUpperCase(); // Join in case of spaces in sequence
            
            if (sequences.has(name)) {
                // Append to existing sequence (multi-line sequences)
                sequences.set(name, sequences.get(name) + sequencePart);
            } else {
                sequences.set(name, sequencePart);
            }
        }
        
        if (sequences.size === 0) return null;
        
        // Convert Map to array, preserving insertion order
        const sequencesArray = Array.from(sequences.entries()).map(([name, sequence]) => ({
            name: name, // Preserve full name
            sequence: sequence
        }));
        
        // First sequence is the query
        const queryIndex = 0;
        const originalQuerySequence = sequencesArray[queryIndex].sequence;
        
        // Identify positions in query that are gaps ("-")
        // Build array of indices to keep (non-gap positions in query)
        const positionsToKeep = [];
        for (let i = 0; i < originalQuerySequence.length; i++) {
            if (originalQuerySequence[i] !== '-') {
                positionsToKeep.push(i);
            }
        }
        
        // Remove gap positions from query sequence
        const querySequence = positionsToKeep.map(i => originalQuerySequence[i]).join('');
        const queryLength = querySequence.length;
        
        // Filter all sequences: remove positions where query has gaps
        // Also truncate sequences longer than query to query's original length first
        const originalQueryLength = originalQuerySequence.length;
        const filteredSequences = sequencesArray.map(seq => {
            let sequence = seq.sequence;
            
            // First, truncate if longer than original query length
            if (sequence.length > originalQueryLength) {
                sequence = sequence.substring(0, originalQueryLength);
            }
            
            // Then, remove positions where query has gaps
            const filteredSequence = positionsToKeep.map(i => {
                // If sequence is shorter than original query, pad with gaps
                return (i < sequence.length) ? sequence[i] : '-';
            }).join('');
            
            return {
                ...seq,
                sequence: filteredSequence
            };
        });
        
        const sorted = sortSequencesByIdentity(filteredSequences, querySequence, queryLength);
        
        return {
            sequences: sorted,
            sequencesOriginal: filteredSequences, // Store original order
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
    
    // ============================================================================
    // RESIZE MANAGEMENT
    // ============================================================================
    
    function initResizeObserver() {
        const container = document.getElementById('msa-viewer-container');
        if (!container) return;
        
        if (resizeObserver) {
            resizeObserver.disconnect();
        }
        
        resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                if (resizeAnimationFrame) {
                    cancelAnimationFrame(resizeAnimationFrame);
                }
                
                resizeAnimationFrame = requestAnimationFrame(() => {
                    handleContainerResize(entry.contentRect);
                    resizeAnimationFrame = null;
                });
            }
        });
        
        resizeObserver.observe(container);
        
        // Get initial content dimensions (contentRect gives us content box, not border box)
        // Use requestAnimationFrame to ensure container is laid out
        requestAnimationFrame(() => {
            const rect = container.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(container);
            const paddingLeft = parseFloat(computedStyle.paddingLeft);
            const paddingRight = parseFloat(computedStyle.paddingRight);
            const paddingTop = parseFloat(computedStyle.paddingTop);
            const paddingBottom = parseFloat(computedStyle.paddingBottom);
            
            // Content box dimensions
            const newWidth = Math.floor(rect.width - paddingLeft - paddingRight);
            const newHeight = Math.floor(rect.height - paddingTop - paddingBottom);
            
            // Only update if we got valid dimensions (container is visible)
            if (newWidth > 0 && newHeight > 0) {
                currentContainerWidth = newWidth;
                currentContainerHeight = newHeight;
                
                // If MSA data exists, rebuild the view with correct dimensions
                if (msaData) {
                    buildViewForMode(msaViewMode);
                }
            } else {
                // Container not visible yet, try again after a short delay
                setTimeout(() => {
                    const rect2 = container.getBoundingClientRect();
                    if (rect2.width > 0 && rect2.height > 0) {
                        const computedStyle2 = window.getComputedStyle(container);
                        const paddingLeft2 = parseFloat(computedStyle2.paddingLeft);
                        const paddingRight2 = parseFloat(computedStyle2.paddingRight);
                        const paddingTop2 = parseFloat(computedStyle2.paddingTop);
                        const paddingBottom2 = parseFloat(computedStyle2.paddingBottom);
                        currentContainerWidth = Math.floor(rect2.width - paddingLeft2 - paddingRight2);
                        currentContainerHeight = Math.floor(rect2.height - paddingTop2 - paddingBottom2);
                        if (msaData) {
                            buildViewForMode(msaViewMode);
                        }
                    }
                }, 100);
            }
        });
    }
    
    function handleContainerResize(rect) {
        // contentRect from ResizeObserver already gives us content box dimensions (no padding)
        const newWidth = Math.floor(rect.width);
        const newHeight = Math.floor(rect.height);
        
        if (newWidth === currentContainerWidth && newHeight === currentContainerHeight) {
            return; // No actual change
        }
        
        currentContainerWidth = newWidth;
        currentContainerHeight = newHeight;
        
        // Rebuild the view with new dimensions
        if (!msaData) return;
        
        buildViewForMode(msaViewMode);
    }
    
    function getContainerWidth() {
        return currentContainerWidth;
    }
    
    // ============================================================================
    // HELPER FUNCTIONS (continued)
    // ============================================================================
    
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
            scrollableAreaWidth = logicalWidth - scrollableAreaX; // No V-scroll
            scrollableAreaHeight = logicalHeight - scrollableAreaY - SCROLLBAR_WIDTH;
        } else { // logo
            scrollableAreaX = Y_AXIS_WIDTH;
            // Logo starts at top, query and ticks are below
            scrollableAreaY = 0; // Logo starts from top
            scrollableAreaWidth = logicalWidth - scrollableAreaX; // No V-scroll
            scrollableAreaHeight = logicalHeight - SCROLLBAR_WIDTH; // Full height minus scrollbar
        }
        
        return { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight };
    }
    
    function getScrollableAreaDimensions(canvasHeight) {
        const queryRowHeight = SEQUENCE_ROW_HEIGHT;
        const scrollableAreaY = TICK_ROW_HEIGHT + queryRowHeight;
        const scrollableAreaHeight = canvasHeight - scrollableAreaY - SCROLLBAR_WIDTH;
        return { scrollableAreaY, scrollableAreaHeight };
    }
    
    /**
     * Calculate scroll limits for a given mode
     * @param {string} mode - 'msa', 'pssm', or 'logo'
     * @param {number} charWidth - Character width for the mode
     * @param {number} canvasWidth - Canvas width
     * @param {number} canvasHeight - Canvas height
     * @returns {Object} Object with horizontal and vertical scroll limits
     */
    function getScrollLimitsForMode(mode, charWidth, canvasWidth, canvasHeight) {
        if (!msaData) {
            return {
                horizontal: { total: 0, max: 0 },
                vertical: { total: 0, max: 0 }
            };
        }
        
        const { scrollableAreaX, scrollableAreaWidth, scrollableAreaHeight } = 
            getScrollableAreaForMode(mode, canvasWidth, canvasHeight);
        
        const totalScrollableWidth = msaData.queryLength * charWidth;
        const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
        
        let totalScrollableHeight = 0;
        let maxScrollY = 0;
        
        if (mode === 'msa') {
            totalScrollableHeight = (msaData.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
            maxScrollY = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
        }
        
        return {
            horizontal: {
                total: totalScrollableWidth,
                max: maxScrollX
            },
            vertical: {
                total: totalScrollableHeight,
                max: maxScrollY
            }
        };
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
        let scrollableAreaX = 0;
        if (msaViewMode === 'msa') {
            scrollableAreaX = NAME_COLUMN_WIDTH;
        } else if (msaViewMode === 'pssm') {
            scrollableAreaX = CHAR_WIDTH;
        } else if (msaViewMode === 'logo') {
            scrollableAreaX = Y_AXIS_WIDTH;
        }
        
        const scrollableAreaWidth = canvasWidth - scrollableAreaX - (msaViewMode === 'msa' ? SCROLLBAR_WIDTH : 0);
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
        // Minimal buffer - just 1 sequence above and 2 below for smooth edges
        const topBuffer = 1;
        const bottomBuffer = 2;
        const start = Math.max(1, startSequenceIndex - topBuffer);
        const endSequenceIndex = Math.min(msaData.sequences.length, startSequenceIndex + visibleRows + bottomBuffer);
        return { start: start, end: endSequenceIndex };
    }
    
    function drawTickMarks(ctx, logicalWidth, scrollLeft, charWidth, scrollableAreaX, minX, maxX, tickY = 0) {
        if (!msaData) return;
        const tickRowHeight = TICK_ROW_HEIGHT;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, tickY, logicalWidth, tickRowHeight);
        
        const visibleStartPos = Math.floor(scrollLeft / charWidth);
        const visibleEndPos = Math.min(msaData.queryLength, visibleStartPos + Math.ceil((maxX - minX) / charWidth) + 1);
        
        // Use filtered residueNumbers from msaData if available, otherwise fall back to global msaResidueNumbers
        const residueNumbers = msaData.residueNumbers || msaResidueNumbers;
        
        let xOffset = scrollableAreaX - (scrollLeft % charWidth);
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < msaData.queryLength; pos++) {
            // Use residue_numbers if available, otherwise use 1-based position numbering
            let tickValue;
            if (residueNumbers && pos < residueNumbers.length && residueNumbers[pos] !== null) {
                tickValue = residueNumbers[pos];
            } else {
                tickValue = pos + 1; // Default: 1-based position numbering (for filtered positions)
            }
            
            // Show tick at position 1, or every TICK_INTERVAL positions
            // For residue_numbers, show tick if it's 1 or divisible by TICK_INTERVAL
            const shouldShowTick = (tickValue === 1 || tickValue % TICK_INTERVAL === 0);
            
            if (shouldShowTick) {
                const tickX = xOffset;
                if (tickX + charWidth >= minX && tickX < maxX) {
                    const drawX = Math.max(minX, tickX);
                    const drawWidth = Math.min(charWidth, maxX - drawX);
                    const centerX = drawX + drawWidth / 2;
                    ctx.fillStyle = '#333';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(tickValue.toString(), centerX, tickY + tickRowHeight / 2);
                }
            }
            xOffset += charWidth;
        }
    }
    
    /**
     * Build mapping from MSA positions to structure residue_numbers values
     * @param {string} chainId - Chain ID to map
     * @returns {Array|null} - Array mapping MSA position to residue_numbers, or null if not available
     */
    function buildMSAResidueNumbersMapping(chainId) {
        if (!callbacks.getRenderer) return null;
        
        const renderer = callbacks.getRenderer();
        if (!renderer || !renderer.currentObjectName) return null;
        
        const obj = renderer.objectsData[renderer.currentObjectName];
        if (!obj || !obj.frames || obj.frames.length === 0) return null;
        if (!obj.msa || !obj.msa.msasBySequence || !obj.msa.chainToSequence) return null;
        
        const frame = obj.frames[renderer.currentFrame >= 0 ? renderer.currentFrame : 0];
        if (!frame || !frame.chains || !frame.residue_numbers) return null;
        
        const querySeq = obj.msa.chainToSequence[chainId];
        if (!querySeq) return null;
        
        const msaEntry = obj.msa.msasBySequence[querySeq];
        if (!msaEntry || !msaEntry.msaData) return null;
        
        const msaData = msaEntry.msaData;
        const msaQuerySequence = msaData.querySequence; // Query sequence has no gaps (removed during parsing)
        
        // Check if extractChainSequences is available (from app.js)
        const extractChainSequences = typeof window !== 'undefined' && typeof window.extractChainSequences === 'function' 
            ? window.extractChainSequences 
            : null;
        
        if (!extractChainSequences) return null;
        
        // Extract chain sequence from structure
        const chainSequences = extractChainSequences(frame);
        const chainSequence = chainSequences[chainId];
        if (!chainSequence) return null;
        
        // Find representative positions for this chain (position_types === 'P')
        const chainPositions = []; // Array of position indices for this chain
        const positionCount = frame.chains.length;
        
        for (let i = 0; i < positionCount; i++) {
            if (frame.chains[i] === chainId && frame.position_types && frame.position_types[i] === 'P') {
                chainPositions.push(i);
            }
        }
        
        if (chainPositions.length === 0) return null;
        
        // Sort positions by residue number to match sequence order
        chainPositions.sort((a, b) => {
            const residueNumA = frame.residue_numbers ? frame.residue_numbers[a] : a;
            const residueNumB = frame.residue_numbers ? frame.residue_numbers[b] : b;
            return residueNumA - residueNumB;
        });
        
        // Map MSA positions to structure residue numbers
        // Query sequence has no gaps, so mapping is straightforward
        const residueNumbersMap = new Array(msaQuerySequence.length).fill(null);
        
        const msaQueryUpper = msaQuerySequence.toUpperCase();
        const chainSeqUpper = chainSequence.toUpperCase();
        const minLength = Math.min(msaQueryUpper.length, chainSeqUpper.length, chainPositions.length);
        
        for (let i = 0; i < minLength; i++) {
            // Check if this MSA position matches the chain sequence position
            if (msaQueryUpper[i] === chainSeqUpper[i]) {
                // Match found - map to structure residue_numbers
                const positionIdx = chainPositions[i];
                if (positionIdx < frame.residue_numbers.length) {
                    residueNumbersMap[i] = frame.residue_numbers[positionIdx];
                }
            }
        }
        
        return residueNumbersMap;
    }

    // ============================================================================
    // SHARED UTILITIES
    // ============================================================================
    
    /**
     * Truncate text if it exceeds max width (no ellipsis)
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {string} text - Text to truncate
     * @param {number} maxWidth - Maximum width in pixels
     * @returns {string} Truncated text
     */
    function truncateText(ctx, text, maxWidth) {
        const fullWidth = ctx.measureText(text).width;
        if (fullWidth <= maxWidth) {
            return text;
        }
        
        let truncated = text;
        while (ctx.measureText(truncated).width > maxWidth && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
        }
        return truncated;
    }
    
    /**
     * Draw a sequence label in the name column
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {string} labelText - Text to display
     * @param {number} rowY - Top Y coordinate of the row
     * @param {number} rowHeight - Height of the row
     * @param {number} nameColumnWidth - Width of name column
     * @param {Object} options - Rendering options
     * @returns {Object} Information about the drawn label
     */
    function drawSequenceLabel(ctx, labelText, rowY, rowHeight, nameColumnWidth, options = {}) {
        const {
            padding = 8,
            fontSize = 12,
            fontFamily = 'monospace',
            textColor = '#333',
            maxChars = 32 // Maximum characters to display (matches truncateSequenceName)
        } = options;
        
        // Calculate text position
        // X: padding from left edge
        const textX = padding;
        // Y: center of row (textBaseline: 'middle' means Y is the center)
        const textY = rowY + rowHeight / 2;
        
        // Set up text rendering context
        ctx.save();
        ctx.fillStyle = textColor;
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle'; // Y coordinate is the center
        
        // Calculate available width: name column width minus left padding
        // No right padding - text should extend to the edge (but not beyond)
        // Use Math.floor to ensure we don't exceed the boundary
        const availableWidth = Math.floor(nameColumnWidth - padding);
        
        // Truncate to maxChars (32) characters first
        let displayText = labelText;
        if (displayText.length > maxChars) {
            displayText = displayText.substring(0, maxChars);
        }
        
        // Measure actual text width and ensure it fits within available width
        // Be conservative: ensure text width is strictly less than available width
        // to prevent any pixel-level cutoff
        let textWidth = ctx.measureText(displayText).width;
        if (textWidth >= availableWidth) {
            // Text is too wide or exactly at boundary, truncate to be safely within
            // Use availableWidth - 1 to ensure we're definitely within bounds
            displayText = truncateText(ctx, displayText, availableWidth - 1);
            textWidth = ctx.measureText(displayText).width;
        }
        
        // Clip to name column to prevent any overflow
        ctx.beginPath();
        ctx.rect(0, rowY, nameColumnWidth, rowHeight);
        ctx.clip();
        
        // Draw text
        ctx.fillText(displayText, textX, textY);
        
        ctx.restore();
        
        return { 
            textX, 
            textY, 
            textWidth: ctx.measureText(displayText).width,
            wasTruncated: displayText !== labelText
        };
    }
    
    /**
     * Draw query sequence row (used by MSA, PSSM, and Logo modes)
     */
    function drawQuerySequence(ctx, logicalWidth, queryY, queryRowHeight, querySeq, scrollLeft, scrollableAreaX, visibleStartPos, visibleEndPos, labelWidth, totalWidth, drawUnderline = true) {
        if (!msaData || !querySeq) return;
        
        // Draw white background, but don't cover the y-axis area (start from labelWidth)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(labelWidth, queryY, logicalWidth - labelWidth, queryRowHeight);
        
        const minX = labelWidth;
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
        
        // Draw underline (only if requested, for logo mode we draw it above)
        if (drawUnderline) {
        const underlineY = queryY + queryRowHeight;
        const underlineWidth = logicalWidth; // Draw line across full canvas width
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, underlineY);
        ctx.lineTo(underlineWidth, underlineY);
        ctx.stroke();
        }
    }
    
    /**
     * Draw horizontal scrollbar (used by PSSM and Logo modes)
     */
    function drawHorizontalScrollbar(ctx, logicalWidth, logicalHeight, scrollableAreaX, scrollableAreaWidth, labelWidth, totalScrollableWidth) {
        if (!msaData) return;
        
        const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
        const hScrollbarY = logicalHeight - SCROLLBAR_WIDTH;
        const hScrollbarWidth = logicalWidth - scrollableAreaX;
        
        // Fill label area
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, hScrollbarY, labelWidth, SCROLLBAR_WIDTH);
        
        // Draw scrollbar track
        ctx.fillStyle = SCROLLBAR_TRACK_COLOR;
        ctx.fillRect(scrollableAreaX, hScrollbarY, hScrollbarWidth, SCROLLBAR_WIDTH);
        
        if (maxScrollX > 0) {
            const scrollRatioX = scrollLeft / maxScrollX;
            const thumbWidth = Math.max(20, (scrollableAreaWidth / totalScrollableWidth) * scrollableAreaWidth);
            const thumbX = scrollableAreaX + scrollRatioX * (scrollableAreaWidth - thumbWidth);
            
            ctx.fillStyle = SCROLLBAR_THUMB_COLOR;
            ctx.fillRect(thumbX, hScrollbarY + SCROLLBAR_PADDING, thumbWidth, SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2);
        }
    }
    
    // ============================================================================
    // RENDERING (Simplified - using new mapping)
    // ============================================================================
    
    /**
     * Check if an MSA position should be visible (selected)
     * @param {number} msaPos - MSA position index (0-based)
     * @param {Array<string>} chains - Array of chain IDs that map to this MSA
     * @param {Map<string, Set<number>>} msaSelectedPositions - Map of chainId -> Set of selected MSA positions
     * @returns {boolean} - True if position should be visible
     */
    function isPositionVisible(msaPos, chains, msaSelectedPositions) {
        if (!chains || chains.length === 0) return true;
        
        // null means all positions are selected (default mode)
        if (msaSelectedPositions === null) return true;
        
        // Empty Map means no positions selected - hide everything
        if (!msaSelectedPositions || msaSelectedPositions.size === 0) return false;
        
        const totalChains = chains.length;
        let selectedCount = 0;
        
        for (const chainId of chains) {
            const chainSelected = msaSelectedPositions.get(chainId);
            if (chainSelected && chainSelected.has(msaPos)) {
                selectedCount++;
            }
        }
        
        // Show if at least one chain has it selected
        return selectedCount > 0;
    }
    
    /**
     * Filter MSA data to remove unselected positions
     * @param {Object} sourceMSAData - Original MSA data to filter
     * @param {Array<string>} chains - Array of chain IDs that map to this MSA
     * @param {Map<string, Set<number>>} msaSelectedPositions - Map of chainId -> Set of selected MSA positions
     * @returns {Object} - Filtered MSA data with only selected positions
     */
    function filterMSADataBySelection(sourceMSAData, chains, msaSelectedPositions) {
        if (!sourceMSAData || !sourceMSAData.sequences || sourceMSAData.sequences.length === 0) {
            return sourceMSAData;
        }
        
        // If all positions are selected (null) or no selection data, return original
        if (msaSelectedPositions === null) {
            return sourceMSAData;
        }
        if (!msaSelectedPositions || msaSelectedPositions.size === 0) {
            // No selection - return empty MSA
            return {
                sequences: sourceMSAData.sequences.map(seq => ({ name: seq.name, sequence: '' })),
                querySequence: '',
                queryLength: 0,
                queryIndex: sourceMSAData.queryIndex || 0,
                residueNumbers: []
            };
        }
        
        // Build set of visible positions (positions that are selected in at least one chain)
        const visiblePositions = new Set();
        if (chains && chains.length > 0) {
            for (let pos = 0; pos < sourceMSAData.queryLength; pos++) {
                if (isPositionVisible(pos, chains, msaSelectedPositions)) {
                    visiblePositions.add(pos);
                }
            }
        } else {
            // No chain info - show all positions
            for (let pos = 0; pos < sourceMSAData.queryLength; pos++) {
                visiblePositions.add(pos);
            }
        }
        
        if (visiblePositions.size === 0) {
            // No visible positions - return empty MSA
            return {
                sequences: sourceMSAData.sequences.map(seq => ({ name: seq.name, sequence: '' })),
                querySequence: '',
                queryLength: 0,
                queryIndex: sourceMSAData.queryIndex || 0,
                residueNumbers: []
            };
        }
        
        // Filter sequences: remove positions that are not visible
        // Query sequence has no gaps, so mapping is straightforward
        const querySequence = sourceMSAData.querySequence || '';
        
        // Initialize filtered sequences
        const filteredSequences = [];
        for (let j = 0; j < sourceMSAData.sequences.length; j++) {
            filteredSequences.push({ 
                name: sourceMSAData.sequences[j].name, 
                sequence: '' 
            });
        }
        
        const filteredQuerySequence = [];
        const filteredResidueNumbers = [];
        
        // Walk through query sequence (no gaps) and filter based on visibility
        for (let i = 0; i < querySequence.length; i++) {
            // Check if this MSA position is visible
            if (visiblePositions.has(i)) {
                // Include this position (entire column)
                for (let seqIdx = 0; seqIdx < sourceMSAData.sequences.length; seqIdx++) {
                    filteredSequences[seqIdx].sequence += (sourceMSAData.sequences[seqIdx].sequence[i] || '-');
                }
                filteredQuerySequence.push(querySequence[i]);
                
                // Preserve residueNumbers if available
                // residueNumbers is indexed by query sequence position i
                if (sourceMSAData.residueNumbers && i < sourceMSAData.residueNumbers.length) {
                    const residueNum = sourceMSAData.residueNumbers[i];
                    if (residueNum !== null && residueNum !== undefined) {
                        filteredResidueNumbers.push(residueNum);
                    }
                }
            }
        }
        
        // Calculate new queryLength (query sequence has no gaps)
        const newQueryLength = filteredQuerySequence.length;
        const filteredQuerySeqStr = filteredQuerySequence.join('');
        
        // Build filtered MSA data
        const filteredMSA = {
            sequences: filteredSequences.length > 0 ? filteredSequences : sourceMSAData.sequences.map(seq => ({ name: seq.name, sequence: '' })),
            querySequence: filteredQuerySeqStr,
            queryLength: newQueryLength,
            queryIndex: sourceMSAData.queryIndex || 0
        };
        
        // Preserve residueNumbers if available - always set it so we know it's filtered
        // Even if empty, set it so drawTickMarks knows to use filtered data
        filteredMSA.residueNumbers = filteredResidueNumbers.length > 0 ? filteredResidueNumbers : undefined;
        
        // Preserve other properties
        if (sourceMSAData.sequencesOriginal) {
            filteredMSA.sequencesOriginal = sourceMSAData.sequencesOriginal;
        }
        
        return filteredMSA;
    }
    
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
        // Draw stroke at the right edge of name column, not overlapping text area
        ctx.beginPath();
        ctx.moveTo(NAME_COLUMN_WIDTH, 0);
        ctx.lineTo(NAME_COLUMN_WIDTH, logicalHeight);
        ctx.stroke();
        
        // Draw tick marks (background will be redrawn after labels to cover them)
        drawTickMarks(ctx, logicalWidth, scrollLeft, MSA_CHAR_WIDTH, scrollableAreaX, scrollableAreaX, logicalWidth);
        
        // Calculate visible position range
        const visibleStartPos = Math.floor(scrollLeft / MSA_CHAR_WIDTH);
        const visibleEndPos = Math.min(msaData.queryLength, visibleStartPos + Math.ceil(scrollableAreaWidth / MSA_CHAR_WIDTH) + 1);
        
        // Draw visible sequences (virtual scrolling)
        // Calculate Y position based on actual sequence index to prevent jumping
        // Sequence 1 starts at scrollableAreaY when scrollTop = 0
        // As we scroll down (scrollTop increases), sequences move up
        
        // Pre-calculate constants for performance
        const minX = scrollableAreaX;
        const maxX = logicalWidth - SCROLLBAR_WIDTH;
        const scrollLeftMod = scrollLeft % MSA_CHAR_WIDTH;
        const halfCharWidth = MSA_CHAR_WIDTH / 2;
        const halfRowHeight = SEQUENCE_ROW_HEIGHT / 2;
        
        // Get selection data and chain mappings for dimming
        let msaSelectedPositions = null;
        let chainsForMSA = null;
        if (callbacks.getRenderer) {
            const renderer = callbacks.getRenderer();
            if (renderer && renderer.currentObjectName) {
                const obj = renderer.objectsData[renderer.currentObjectName];
                if (obj && obj.msa && currentChain) {
                    // Get chains that map to this MSA
                    const querySeq = obj.msa.chainToSequence[currentChain];
                    if (querySeq && obj.msa.msasBySequence[querySeq]) {
                        const msaEntry = obj.msa.msasBySequence[querySeq];
                        chainsForMSA = msaEntry.chains || [currentChain];
                    } else {
                        chainsForMSA = [currentChain];
                    }
                    
                    // Get selection data
                    // Check for selection data (can be null, Map, or undefined)
                    // null = all selected (no dimming), Map = selection data, undefined = not initialized
                    if (typeof window !== 'undefined' && window._msaSelectedPositions !== undefined) {
                        msaSelectedPositions = window._msaSelectedPositions;
                    }
                }
            }
        }
        
        // Label rendering options
        const labelOptions = {
            padding: 8,
            fontSize: 12,
            fontFamily: 'monospace',
            textColor: '#333'
        };
        
        // Draw labels for visible sequences (same visibility as sequences - can go under query and tick bar)
        for (let i = visibleSequenceStart; i < visibleSequenceEnd && i < msaData.sequences.length; i++) {
            if (i === 0) continue; // Skip query (drawn separately)
            
            const seq = msaData.sequences[i];
            // Calculate Y based on actual sequence index and scrollTop
            // Sequence i (where i >= 1) should be at: scrollableAreaY + (i-1) * rowHeight - scrollTop
            const y = scrollableAreaY + (i - 1) * SEQUENCE_ROW_HEIGHT - scrollTop;
            
            // Draw labels that are visible on canvas (same check as sequences)
            // Labels can go under query and tick bar - they will be covered by white backgrounds
            if (y + SEQUENCE_ROW_HEIGHT >= 0 && y <= logicalHeight) {
                drawSequenceLabel(ctx, seq.name, y, SEQUENCE_ROW_HEIGHT, NAME_COLUMN_WIDTH, labelOptions);
            }
            
            // Draw sequence
            let xOffset = scrollableAreaX - scrollLeftMod;
            
            // Set text properties for amino acids once per sequence
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            
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
                    ctx.fillText(aa, xOffset + halfCharWidth, y + halfRowHeight);
                    
                    ctx.restore();
                }
                
                xOffset += MSA_CHAR_WIDTH;
            }
        }
        
        // Redraw tick bar background to cover any labels that scrolled up into it
        // This provides a natural hiding space for labels
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, queryY - TICK_ROW_HEIGHT, logicalWidth, TICK_ROW_HEIGHT);
        // Redraw tick marks on top
        drawTickMarks(ctx, logicalWidth, scrollLeft, MSA_CHAR_WIDTH, scrollableAreaX, scrollableAreaX, logicalWidth, queryY - TICK_ROW_HEIGHT);
        
        // Draw query sequence (on top - must be drawn last to appear above other labels)
        if (msaData.sequences.length > 0) {
            const querySeq = msaData.sequences[0];
            
            // White background for query row - covers name column too
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, queryY, logicalWidth, queryRowHeight);
            
            // Draw query label using the same function as other labels (drawn last so it's on top)
            drawSequenceLabel(ctx, querySeq.name, queryY, queryRowHeight, NAME_COLUMN_WIDTH, labelOptions);
            
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
    
    function downloadFile(content, baseName, extension, mimeType) {
        // Create filename with timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `${baseName}_${timestamp}.${extension}`;
        
        // Create blob and download
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    function calculateFrequencies() {
        if (!msaData) return null;
        
        // Check if already computed and stored in msaData
        if (msaData.frequencies) {
            return msaData.frequencies;
        }
        
        const dataHash = msaData.sequences.length + '_' + msaData.queryLength;
        if (cachedFrequencies && cachedDataHash === dataHash) {
            // Store in msaData for persistence
            msaData.frequencies = cachedFrequencies;
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
        
        // Store in msaData for persistence
        msaData.frequencies = frequencies;
        cachedFrequencies = frequencies;
        cachedDataHash = dataHash;
        cachedLogOdds = null;
        cachedEntropy = null;
        cachedEntropyHash = null;
        
        return frequencies;
    }
    
    function calculateLogOdds(frequencies) {
        if (!frequencies) return null;
        
        // Check if already computed and stored in msaData
        if (msaData && msaData.logOdds) {
            return msaData.logOdds;
        }
        
        if (cachedLogOdds) {
            // Store in msaData for persistence
            if (msaData) {
                msaData.logOdds = cachedLogOdds;
            }
            return cachedLogOdds;
        }
        
        const logOdds = [];
        for (const freq of frequencies) {
            const logOddsPos = {};
            for (const aa in freq) {
                const backgroundFreq = getBackgroundFrequency(aa);
                logOddsPos[aa] = Math.log2(freq[aa] / backgroundFreq);
            }
            logOdds.push(logOddsPos);
        }
        
        // Store in msaData for persistence
        if (msaData) {
            msaData.logOdds = logOdds;
        }
        cachedLogOdds = logOdds;
        return logOdds;
    }
    
    /**
     * Calculate Shannon entropy for each position in the MSA
     * Uses the same frequency calculation as logo/PSSM views
     * Formula: H = -Σ(p_i * log2(p_i)) / log2(20)
     * Returns normalized entropy values (0 to 1 scale)
     * Cached for performance
     * @returns {Array} - Array of entropy values (one per MSA position)
     */
    function calculateEntropy() {
        if (!msaData) return [];
        
        // Check if already computed and stored in msaData
        if (msaData.entropy) {
            return msaData.entropy;
        }
        
        // Check cache first
        const dataHash = msaData.sequences.length + '_' + msaData.queryLength;
        if (cachedEntropy && cachedEntropyHash === dataHash) {
            // Store in msaData for persistence
            msaData.entropy = cachedEntropy;
            return cachedEntropy;
        }
        
        const frequencies = calculateFrequencies();
        if (!frequencies || frequencies.length === 0) return [];
        
        const maxEntropy = Math.log2(20); // Maximum entropy for 20 amino acids
        const entropyValues = [];
        
        for (let pos = 0; pos < frequencies.length; pos++) {
            const posFreq = frequencies[pos];
            
            // Calculate Shannon entropy: H = -Σ(p_i * log2(p_i))
            let entropy = 0;
            for (const aa in posFreq) {
                const p = posFreq[aa];
                if (p > 0) {
                    entropy -= p * Math.log2(p);
                }
            }
            
            // Normalize by max entropy (0 to 1 scale)
            const normalizedEntropy = entropy / maxEntropy;
            entropyValues.push(normalizedEntropy);
        }
        
        // Store in msaData for persistence
        msaData.entropy = entropyValues;
        cachedEntropy = entropyValues;
        cachedEntropyHash = dataHash;
        
        return entropyValues;
    }
    
    function renderPSSMCanvas() {
        if (!pssmCanvasData || !msaData) return;
        
        const { canvas, ctx } = pssmCanvasData;
        if (!canvas || !ctx) return;
        
        const { logicalWidth, logicalHeight } = getLogicalCanvasDimensions(canvas);
        
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);
        
        const frequencies = calculateFrequencies();
        if (!frequencies) return;
        
        const queryRowHeight = CHAR_WIDTH;
        const GAP_HEIGHT = 0;
        const { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight } = 
            getScrollableAreaForMode('pssm', logicalWidth, logicalHeight);
        
        const LABEL_WIDTH = CHAR_WIDTH;
        const visibleStartPos = Math.floor(scrollLeft / CHAR_WIDTH);
        const visibleEndPos = Math.min(frequencies.length, visibleStartPos + Math.ceil(scrollableAreaWidth / CHAR_WIDTH) + 1);
        
        const tickMinX = LABEL_WIDTH;
        const tickMaxX = logicalWidth;
        drawTickMarks(ctx, logicalWidth, scrollLeft, CHAR_WIDTH, LABEL_WIDTH, tickMinX, tickMaxX);
        
        const queryY = TICK_ROW_HEIGHT;
        const heatmapY = scrollableAreaY + GAP_HEIGHT;
        
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const aaRowHeight = CHAR_WIDTH;
        const heatmapHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        
        const heatmapX = LABEL_WIDTH;
        const heatmapWidth = logicalWidth - LABEL_WIDTH;
        const minX = 0;
        const maxX = logicalWidth;
        
        // Draw labels
        for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
            const aa = AMINO_ACIDS_ORDERED[i];
            const y = heatmapY + i * aaRowHeight;
            const dayhoffColor = getDayhoffColor(aa);
            
            ctx.fillStyle = `rgb(${dayhoffColor.r}, ${dayhoffColor.g}, ${dayhoffColor.b})`;
            ctx.fillRect(0, y, LABEL_WIDTH, aaRowHeight);
            
            ctx.fillStyle = '#000';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(aa, LABEL_WIDTH / 2, y + aaRowHeight / 2);
        }
        
        // Draw heatmap
        let xOffset = heatmapX - (scrollLeft % CHAR_WIDTH);
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < frequencies.length; pos++) {
            if (xOffset + CHAR_WIDTH < heatmapX) {
                xOffset += CHAR_WIDTH;
                continue;
            }
            if (xOffset >= maxX) break;
            
            const posData = frequencies[pos];
            
            for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
                const aa = AMINO_ACIDS_ORDERED[i];
                const probability = posData[aa] || 0;
                const y = heatmapY + i * aaRowHeight;
                
                const white = {r: 255, g: 255, b: 255};
                const darkBlue = {r: 0, g: 0, b: 139};
                const finalR = Math.round(white.r + (darkBlue.r - white.r) * probability);
                const finalG = Math.round(white.g + (darkBlue.g - white.g) * probability);
                const finalB = Math.round(white.b + (darkBlue.b - white.b) * probability);
                
                if (xOffset + CHAR_WIDTH >= heatmapX && xOffset < maxX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(heatmapX, heatmapY, maxX - heatmapX, heatmapHeight);
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
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < frequencies.length; pos++) {
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
                const y = heatmapY + wildtypeIndex * aaRowHeight;
                if (boxXOffset + CHAR_WIDTH >= heatmapX && boxXOffset < maxX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(heatmapX, heatmapY, maxX - heatmapX, heatmapHeight);
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
            const y = heatmapY + boundaryIdx * aaRowHeight;
            ctx.beginPath();
            ctx.moveTo(heatmapX, y);
            ctx.lineTo(heatmapX + heatmapWidth, y);
            ctx.stroke();
        }
        
        // Draw query sequence on top
        if (msaData.sequences.length > 0) {
            const querySeq = msaData.sequences[0];
            drawQuerySequence(ctx, logicalWidth, queryY, queryRowHeight, querySeq, scrollLeft, scrollableAreaX, visibleStartPos, visibleEndPos, LABEL_WIDTH, pssmCanvasData.totalWidth);
        }
        
        // Draw horizontal scrollbar
        const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH;
        drawHorizontalScrollbar(ctx, logicalWidth, logicalHeight, scrollableAreaX, scrollableAreaWidth, LABEL_WIDTH, totalScrollableWidth);
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
        
        const data = useBitScore 
            ? (cachedLogOdds || calculateLogOdds(frequencies))
            : frequencies;
        if (!data) return;
        
        const queryRowHeight = CHAR_WIDTH;
        const { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight } = 
            getScrollableAreaForMode('logo', logicalWidth, logicalHeight);
        
        const LABEL_WIDTH = Y_AXIS_WIDTH;
        const visibleStartPos = Math.floor(scrollLeft / CHAR_WIDTH);
        const visibleEndPos = Math.min(data.length, visibleStartPos + Math.ceil(scrollableAreaWidth / CHAR_WIDTH) + 1);
        
        // Add padding above logo area for y-axis labels, but extend logo all the way down to query
        const LOGO_VERTICAL_PADDING = 12;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const aaRowHeight = CHAR_WIDTH;
        const originalLogoHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        
        // New layout: Logo at top, black bar above query, query sequence below, tick marks below query, scrollbar at bottom
        const logoY = scrollableAreaY + LOGO_VERTICAL_PADDING;
        const queryY = logoY + originalLogoHeight; // Logo extends all the way to query with no gap
        const effectiveLogoHeight = queryY - logoY; // Full height from logoY to queryY
        const tickY = queryY + queryRowHeight; // Below query sequence
        
        const minX = LABEL_WIDTH;
        const maxX = logicalWidth;
        
        // STACKED LOGO MODE
        const logoData = [];
        let maxInfoContent = 0; // For Y-axis scale
        
        if (useBitScore) {
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
                    ? (infoContent / maxInfoContent) * effectiveLogoHeight 
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
            // Probability mode: frequencies should sum to 1.0, and stack should fill full height
            // No gaps between letters, so use full effectiveLogoHeight
            for (let pos = 0; pos < frequencies.length; pos++) {
                const posFreq = frequencies[pos];
                const letterHeights = {};
                
                let freqSum = 0;
                for (const aa in posFreq) {
                    freqSum += posFreq[aa];
                }
                
                // Normalize frequencies to sum to 1.0, then scale to full logo height
                const normalizationFactor = freqSum > 0 ? 1 / freqSum : 1;
                
                for (const aa in posFreq) {
                    // Normalized frequency (sums to 1.0) * full height = letter height
                    letterHeights[aa] = (posFreq[aa] * normalizationFactor) * effectiveLogoHeight;
                }
                
                logoData.push({ infoContent: 0, letterHeights, posData: data[pos] });
            }
        }
        
        // Draw Y-axis
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, LABEL_WIDTH, logicalHeight);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LABEL_WIDTH, logoY - LOGO_VERTICAL_PADDING); // Start at top of logo area
        ctx.lineTo(LABEL_WIDTH, queryY); // End at queryY (logo extends all the way down)
        ctx.stroke();

        // Y-axis labels and scale
        const axisLabel = useBitScore ? "Bits" : "Probability";
        // Axis range: top has padding, bottom extends to queryY
        const axisTopY = logoY - LOGO_VERTICAL_PADDING;
        const axisBottomY = queryY;
        
        // Position axis label centered vertically, offset to the left to avoid overlap with middle tick value
        const axisLabelY = (axisTopY + axisBottomY) / 2;
        
        ctx.save();
        ctx.translate(LABEL_WIDTH / 2 - 15, axisLabelY);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = '#333';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(axisLabel, 0, 0);
        ctx.restore();
        
        // Y-axis ticks - map to full area including padding, so scale is accurate
        ctx.fillStyle = '#333';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        
        const tickValues = [];
        if (useBitScore) {
            const maxVal = maxInfoContent > 0 ? maxInfoContent : 1;
            tickValues.push({ value: 0, label: '0' });
            if (maxVal > 0) {
                tickValues.push({ value: maxVal / 2, label: (maxVal / 2).toFixed(1) });
                tickValues.push({ value: maxVal, label: maxVal.toFixed(1) });
            }
        } else {
            tickValues.push({ value: 0, label: '0.0' });
            tickValues.push({ value: 0.5, label: '0.5' });
            tickValues.push({ value: 1.0, label: '1.0' });
        }
        
        // Map tick values to the logo area (extending to queryY)
        // Ticks map to the full logo height: 0 at bottom (queryY), max at top of logo
        const logoBottomY = queryY; // Logo extends all the way to queryY
        const logoTopY = logoY;
        // effectiveLogoHeight already declared above
        
        for (const tick of tickValues) {
            let yPos;
            if (useBitScore) {
                const maxVal = maxInfoContent > 0 ? maxInfoContent : 1;
                // Map value to position: 0 at bottom (queryY), max at top of logo
                yPos = logoBottomY - (tick.value / maxVal) * effectiveLogoHeight;
            } else {
                // Map value to position: 0 at bottom (queryY), 1.0 at top of logo
                yPos = logoBottomY - tick.value * effectiveLogoHeight;
            }
            
            ctx.fillText(tick.label, LABEL_WIDTH - 8, yPos);
            ctx.beginPath();
            ctx.moveTo(LABEL_WIDTH - 5, yPos);
            ctx.lineTo(LABEL_WIDTH, yPos);
            ctx.stroke();
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
            // Sort ascending (smallest first) so both modes stack from bottom: smallest at bottom, tallest at top
            const aas = Object.keys(letterHeights).sort((a, b) => letterHeights[a] - letterHeights[b]);
            
            // Start from bottom (queryY) and stack upward - extend all the way to query with no gap
            let yOffset = queryY;
            
            for (const aa of aas) {
                const height = letterHeights[aa];
                const isProbabilitiesMode = !useBitScore;
                const shouldDraw = isProbabilitiesMode ? true : height > 1;
                const drawHeight = isProbabilitiesMode && height > 0 && height < 0.5 ? 0.5 : height;
                
                if (shouldDraw && drawHeight > 0) {
                    const color = getDayhoffColor(aa);
                    const r = color.r, g = color.g, b = color.b;
                    
                    const drawWidth = CHAR_WIDTH;
                    if (drawWidth > 0) {
                        // Draw from bottom up, no gap between letters
                        const drawY = yOffset - drawHeight;
                        
                        // Clip logo rendering to extend all the way to queryY (no gap)
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(minX, logoY, scrollableAreaWidth, queryY - logoY);
                        ctx.clip();
                        
                            // WebLogo-style letter mode: scale glyph bbox to fill full cell
                        // Extend clip rect to queryY so letters can extend all the way down
                            const colorStr = `rgb(${r}, ${g}, ${b})`;
                        const clipRect = { x: minX, y: logoY, w: scrollableAreaWidth, h: queryY - logoY };
                            if (drawHeight > 0) {
                                drawScaledLetter(ctx, aa, xOffset, yOffset, CHAR_WIDTH, drawHeight, colorStr, clipRect);
    }
                        
                        ctx.restore(); // Restore from clipping
                    }
                }
                
                // Update yOffset for next letter (move upward, no gap)
                yOffset -= drawHeight;
            }
            
            xOffset += CHAR_WIDTH;
        }
        
        // Draw query sequence
        if (msaData.sequences.length > 0) {
            const querySeq = msaData.sequences[0];
            drawQuerySequence(ctx, logicalWidth, queryY, queryRowHeight, querySeq, scrollLeft, scrollableAreaX, visibleStartPos, visibleEndPos, LABEL_WIDTH, logoCanvasData.totalWidth, false);
        }
        
        // Redraw 0 tick mark to ensure it's visible (query sequence white background no longer covers it, but redraw to be safe)
        const zeroTickY = queryY;
        ctx.fillStyle = '#333';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const zeroLabel = useBitScore ? '0' : '0.0';
        ctx.fillText(zeroLabel, LABEL_WIDTH - 8, zeroTickY);
        ctx.beginPath();
        ctx.moveTo(LABEL_WIDTH - 5, zeroTickY);
        ctx.lineTo(LABEL_WIDTH, zeroTickY);
        ctx.stroke();
        
        // Draw tick marks below query sequence
        const tickMinX = LABEL_WIDTH;
        const tickMaxX = logicalWidth;
        drawTickMarks(ctx, logicalWidth, scrollLeft, CHAR_WIDTH, LABEL_WIDTH, tickMinX, tickMaxX, tickY);
        
        // Draw horizontal scrollbar at bottom
        const totalScrollableWidth = msaData.queryLength * CHAR_WIDTH;
        drawHorizontalScrollbar(ctx, logicalWidth, logicalHeight, scrollableAreaX, scrollableAreaWidth, LABEL_WIDTH, totalScrollableWidth);
        
        // Draw black bar above query sequence LAST so it appears on top (starting from scrollableAreaX, not from 0)
        const underlineY = queryY;
        const underlineStartX = scrollableAreaX;
        const underlineEndX = logicalWidth;
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(underlineStartX, underlineY);
        ctx.lineTo(underlineEndX, underlineY);
        ctx.stroke();
    }
    
    // ============================================================================
    // SHARED INTERACTION MANAGER
    // ============================================================================
    // Consolidates event handling for all three modes to eliminate duplication
    
    class ViewInteractionManager {
        constructor(canvas, mode, config) {
            this.canvas = canvas;
            this.mode = mode;
            this.config = config; // { charWidth, supportsVerticalScroll, getScrollLimits }
            this.listeners = [];
            this.scrollbarDragState = {
                isDragging: false,
                dragType: null,
                dragStartY: 0,
                dragStartScroll: 0
            };
            this.panDragState = null;
            // Cache for canvas dimensions to avoid repeated calculations
            this._cachedDimensions = null;
            this._cachedScrollableArea = null;
            this._cachedScrollLimits = null;
        }
        
        _getCanvasDimensions() {
            // Cache dimensions (only invalidate on resize, which rebuilds the view)
            if (!this._cachedDimensions) {
                this._cachedDimensions = getLogicalCanvasDimensions(this.canvas);
            }
            return this._cachedDimensions;
        }
        
        _getScrollableArea() {
            if (!this._cachedScrollableArea) {
                const { logicalWidth, logicalHeight } = this._getCanvasDimensions();
                this._cachedScrollableArea = this.config.getScrollableArea(logicalWidth, logicalHeight);
            }
            return this._cachedScrollableArea;
        }
        
        _getScrollLimits() {
            if (!this._cachedScrollLimits) {
                const { logicalWidth, logicalHeight } = this._getCanvasDimensions();
                this._cachedScrollLimits = this.config.getScrollLimits(logicalWidth, logicalHeight);
            }
            return this._cachedScrollLimits;
        }
        
        _invalidateCache() {
            this._cachedDimensions = null;
            this._cachedScrollableArea = null;
            this._cachedScrollLimits = null;
        }
        
        setupWheelScrolling() {
            const handler = (e) => {
            e.preventDefault();
                const { logicalWidth: canvasWidth, logicalHeight: canvasHeight } = this._getCanvasDimensions();
                const { scrollableAreaX, scrollableAreaWidth } = this._getScrollableArea();
                const limits = this._getScrollLimits();
            
            const hasHorizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const isShiftScroll = e.shiftKey && Math.abs(e.deltaY) > 0;
            
            if (hasHorizontalDelta || isShiftScroll) {
                const delta = hasHorizontalDelta ? e.deltaX : (isShiftScroll ? e.deltaY : 0);
                    if (delta !== 0 && limits.horizontal.max > 0) {
                        scrollLeft = Math.max(0, Math.min(limits.horizontal.max, scrollLeft + delta));
                    scheduleRender();
                    return;
                }
            }
            
                if (this.config.supportsVerticalScroll && Math.abs(e.deltaY) > 0 && !hasHorizontalDelta && !isShiftScroll) {
                    scrollTop = Math.max(0, Math.min(limits.vertical.max, scrollTop + e.deltaY));
                    if (this.config.clampScrollTop) {
                        this.config.clampScrollTop(canvasHeight);
                    }
                scheduleRender();
            }
            };
            
            this.canvas.addEventListener('wheel', handler, { passive: false });
            this.listeners.push({ element: this.canvas, event: 'wheel', handler });
        }
        
        setupPointerInteractions() {
            const handlePointerDown = (e) => {
                // For mouse events, only handle left button
                if (e.button !== undefined && e.button !== 0) return;
                // For touch events, only handle single touch
                if (e.touches && e.touches.length !== 1) return;
                
                const pos = getCanvasPositionFromMouse(e, this.canvas);
                const { logicalWidth: canvasWidth, logicalHeight: canvasHeight } = this._getCanvasDimensions();
                const { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight } = 
                    this._getScrollableArea();
                // Always get fresh scroll limits (cache is invalidated when filters change)
                const limits = this._getScrollLimits();
                
                // Check scrollbars (vertical for MSA, horizontal for all)
                if (this.config.supportsVerticalScroll) {
            const vScrollbarX = canvasWidth - SCROLLBAR_WIDTH;
            const vScrollbarYEnd = canvasHeight - SCROLLBAR_WIDTH;
            
            if (pos.x >= vScrollbarX && pos.x <= canvasWidth && pos.y >= scrollableAreaY && pos.y < vScrollbarYEnd) {
                        if (this.config.clampScrollTop) {
                            this.config.clampScrollTop(canvasHeight);
                        }
                        const maxScroll = limits.vertical.max;
                const scrollRatio = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0;
                        const thumbHeight = Math.max(20, (scrollableAreaHeight / limits.vertical.total) * scrollableAreaHeight);
                const thumbY = scrollableAreaY + scrollRatio * (scrollableAreaHeight - thumbHeight);
                
                if (pos.y >= thumbY && pos.y <= thumbY + thumbHeight) {
                            this.startVerticalScrollbarDrag(pos.y, scrollableAreaHeight, thumbHeight, maxScroll, canvasHeight);
                    e.preventDefault();
                    return;
                } else if (pos.y >= scrollableAreaY) {
                    const newScrollRatio = Math.max(0, Math.min(1, (pos.y - scrollableAreaY - thumbHeight / 2) / (scrollableAreaHeight - thumbHeight)));
                    scrollTop = Math.max(0, Math.min(maxScroll, newScrollRatio * maxScroll));
                            if (this.config.clampScrollTop) {
                                this.config.clampScrollTop(canvasHeight);
                            }
                    scheduleRender();
                    e.preventDefault();
                    return;
                        }
                }
            }
            
            // Check horizontal scrollbar
            const hScrollbarY = canvasHeight - SCROLLBAR_WIDTH;
                const hScrollbarXEnd = canvasWidth - (this.config.supportsVerticalScroll ? SCROLLBAR_WIDTH : 0);
            
            if (pos.y >= hScrollbarY && pos.y <= canvasHeight && pos.x >= scrollableAreaX && pos.x < hScrollbarXEnd) {
                    if (limits.horizontal.max > 0) {
                        const scrollRatioX = scrollLeft / limits.horizontal.max;
                        const thumbWidth = Math.max(20, (scrollableAreaWidth / limits.horizontal.total) * scrollableAreaWidth);
                    const thumbX = scrollableAreaX + scrollRatioX * (scrollableAreaWidth - thumbWidth);
                    
                    if (pos.x >= thumbX && pos.x <= thumbX + thumbWidth) {
                            this.startHorizontalScrollbarDrag(pos.x, scrollableAreaWidth, thumbWidth, limits.horizontal.max);
                        e.preventDefault();
                        return;
                    } else if (pos.x >= scrollableAreaX) {
                        const newScrollRatioX = Math.max(0, Math.min(1, (pos.x - scrollableAreaX - thumbWidth / 2) / (scrollableAreaWidth - thumbWidth)));
                            scrollLeft = Math.max(0, Math.min(limits.horizontal.max, newScrollRatioX * limits.horizontal.max));
                        scheduleRender();
                        e.preventDefault();
                        return;
                    }
                }
            }
                
                // Grab and drag panning
                const scrollbarWidth = this.config.supportsVerticalScroll ? SCROLLBAR_WIDTH : 0;
                if (pos.x >= scrollableAreaX && pos.x < canvasWidth - scrollbarWidth &&
                    pos.y >= scrollableAreaY && pos.y < canvasHeight - SCROLLBAR_WIDTH) {
                    this.startPanDrag(pos, scrollableAreaX, scrollableAreaWidth, scrollableAreaY, scrollableAreaHeight, canvasWidth, canvasHeight);
                    e.preventDefault();
                    return;
                }
            };
            
            this.canvas.addEventListener('mousedown', handlePointerDown);
            this.listeners.push({ element: this.canvas, event: 'mousedown', handler: handlePointerDown });
            
            const touchHandler = (e) => {
            e.preventDefault();
                handlePointerDown(e);
            };
            this.canvas.addEventListener('touchstart', touchHandler, { passive: false });
            this.listeners.push({ element: this.canvas, event: 'touchstart', handler: touchHandler });
        }
        
        startVerticalScrollbarDrag(startY, scrollableAreaHeight, thumbHeight, maxScroll, canvasHeight) {
            this.scrollbarDragState.isDragging = true;
            this.scrollbarDragState.dragType = 'vertical';
            this.scrollbarDragState.dragStartY = startY;
            this.scrollbarDragState.dragStartScroll = scrollTop;
            this.scrollbarDragState.scrollableAreaHeight = scrollableAreaHeight;
            this.scrollbarDragState.canvasHeight = canvasHeight;
                        
                        const handleDrag = (e) => {
                if (!this.scrollbarDragState.isDragging || this.scrollbarDragState.dragType !== 'vertical') return;
                e.preventDefault();
                // Recalculate scroll limits dynamically (in case msaData.sequences.length changed during filtering)
                this._invalidateCache();
                const limits = this._getScrollLimits();
                const currentMaxScroll = limits.vertical.max;
                const currentScrollableAreaHeight = this.scrollbarDragState.scrollableAreaHeight;
                // Recalculate thumbHeight based on current sequence count (it depends on totalScrollableHeight)
                const currentThumbHeight = Math.max(20, (currentScrollableAreaHeight / limits.vertical.total) * currentScrollableAreaHeight);
                
                const dragPos = getCanvasPositionFromMouse(e, this.canvas);
                const deltaY = dragPos.y - this.scrollbarDragState.dragStartY;
                if (Math.abs(deltaY) > 2) {
                    const scrollDelta = (deltaY / (currentScrollableAreaHeight - currentThumbHeight)) * currentMaxScroll;
                    scrollTop = Math.max(0, Math.min(currentMaxScroll, this.scrollbarDragState.dragStartScroll + scrollDelta));
                    if (this.config.clampScrollTop) {
                        this.config.clampScrollTop(this.scrollbarDragState.canvasHeight);
                    }
                    scheduleRender();
                }
            };
            
            const handleDragEnd = () => {
                this.scrollbarDragState.isDragging = false;
                this.scrollbarDragState.dragType = null;
                window.removeEventListener('mousemove', handleDrag);
                window.removeEventListener('mouseup', handleDragEnd);
                window.removeEventListener('touchmove', handleDrag);
                window.removeEventListener('touchend', handleDragEnd);
            };
            
            window.addEventListener('mousemove', handleDrag);
            window.addEventListener('mouseup', handleDragEnd);
            window.addEventListener('touchmove', handleDrag, { passive: false });
            window.addEventListener('touchend', handleDragEnd);
        }
        
        startHorizontalScrollbarDrag(startX, scrollableAreaWidth, thumbWidth, maxScrollX) {
            this.scrollbarDragState.isDragging = true;
            this.scrollbarDragState.dragType = 'horizontal';
            this.scrollbarDragState.dragStartY = startX; // Reusing field name for X coordinate
            this.scrollbarDragState.dragStartScroll = scrollLeft;
            this.scrollbarDragState.scrollableAreaWidth = scrollableAreaWidth;
            this.scrollbarDragState.thumbWidth = thumbWidth;
                        
                        const handleDrag = (e) => {
                if (!this.scrollbarDragState.isDragging || this.scrollbarDragState.dragType !== 'horizontal') return;
                e.preventDefault();
                // Recalculate scroll limits dynamically (in case msaData.queryLength changed during filtering)
                this._invalidateCache();
                const limits = this._getScrollLimits();
                const currentMaxScrollX = limits.horizontal.max;
                const currentScrollableAreaWidth = this.scrollbarDragState.scrollableAreaWidth;
                // Recalculate thumbWidth based on current queryLength (it depends on totalScrollableWidth)
                const currentThumbWidth = Math.max(20, (currentScrollableAreaWidth / limits.horizontal.total) * currentScrollableAreaWidth);
                
                const dragPos = getCanvasPositionFromMouse(e, this.canvas);
                const deltaX = dragPos.x - this.scrollbarDragState.dragStartY;
                            if (Math.abs(deltaX) > 2) {
                                const scrollDelta = (deltaX / (currentScrollableAreaWidth - currentThumbWidth)) * currentMaxScrollX;
                    scrollLeft = Math.max(0, Math.min(currentMaxScrollX, this.scrollbarDragState.dragStartScroll + scrollDelta));
                                scheduleRender();
                            }
                        };
                        
                        const handleDragEnd = () => {
                this.scrollbarDragState.isDragging = false;
                this.scrollbarDragState.dragType = null;
                            window.removeEventListener('mousemove', handleDrag);
                            window.removeEventListener('mouseup', handleDragEnd);
                window.removeEventListener('touchmove', handleDrag);
                window.removeEventListener('touchend', handleDragEnd);
                        };
                        
                        window.addEventListener('mousemove', handleDrag);
                        window.addEventListener('mouseup', handleDragEnd);
            window.addEventListener('touchmove', handleDrag, { passive: false });
            window.addEventListener('touchend', handleDragEnd);
        }
        
        startPanDrag(pos, scrollableAreaX, scrollableAreaWidth, scrollableAreaY, scrollableAreaHeight, canvasWidth, canvasHeight) {
            this.panDragState = {
                isDragging: true,
                startX: pos.x,
                startY: pos.y,
                startScrollLeft: scrollLeft,
                startScrollTop: scrollTop
            };
            
            this.canvas.style.cursor = 'grabbing';
            
            const handlePanDrag = (e) => {
                if (!this.panDragState || !this.panDragState.isDragging) return;
                        e.preventDefault();
                const dragPos = getCanvasPositionFromMouse(e, this.canvas);
                const deltaX = this.panDragState.startX - dragPos.x;
                const deltaY = this.panDragState.startY - dragPos.y;
                
                // Horizontal scrolling
                const limits = this._getScrollLimits();
                scrollLeft = Math.max(0, Math.min(limits.horizontal.max, this.panDragState.startScrollLeft + deltaX));
                
                // Vertical scrolling (MSA only)
                if (this.config.supportsVerticalScroll) {
                    scrollTop = Math.max(0, Math.min(limits.vertical.max, this.panDragState.startScrollTop + deltaY));
                    if (this.config.clampScrollTop) {
                        this.config.clampScrollTop(canvasHeight);
                    }
                }
                
                scheduleRender();
            };
            
            const handlePanDragEnd = () => {
                if (this.panDragState) {
                    this.panDragState.isDragging = false;
                }
                this.canvas.style.cursor = 'default';
                window.removeEventListener('mousemove', handlePanDrag);
                window.removeEventListener('mouseup', handlePanDragEnd);
                window.removeEventListener('touchmove', handlePanDrag);
                window.removeEventListener('touchend', handlePanDragEnd);
            };
            
            window.addEventListener('mousemove', handlePanDrag);
            window.addEventListener('mouseup', handlePanDragEnd);
            window.addEventListener('touchmove', handlePanDrag, { passive: false });
            window.addEventListener('touchend', handlePanDragEnd);
        }
        
        cleanup() {
            this.listeners.forEach(({ element, event, handler }) => {
                element.removeEventListener(event, handler);
            });
            this.listeners = [];
            this.scrollbarDragState.isDragging = false;
            this.panDragState = null;
        }
    }
    
    // Track active interaction manager for cleanup
    let activeInteractionManager = null;
    
    // ============================================================================
    // SHARED CANVAS/CONTAINER CREATION
    // ============================================================================
    // Consolidates canvas and container setup to eliminate duplication
    
    function createViewCanvas(mode, config) {
        const { 
            viewElementId, 
            calculateDimensions, 
            additionalCanvasData = {}
        } = config;
        
        const viewEl = document.getElementById(viewElementId);
        if (!viewEl) {
            console.warn(`MSA Viewer: ${viewElementId} element not found`);
            return null;
        }
        
        if (!msaData) {
            console.warn('MSA Viewer: No MSA data available');
            return null;
        }
        
        viewEl.innerHTML = '';
        viewEl.classList.remove('hidden');
        
        // Create container
        const container = document.createElement('div');
        container.style.overflow = 'hidden';
        container.style.position = 'relative';
        container.style.backgroundColor = '#ffffff';
        container.style.margin = '0';
        container.style.padding = '0';
        
        // Calculate dimensions (mode-specific)
        const dimensions = calculateDimensions();
        const { canvasWidth, canvasHeight, totalWidth, totalHeight } = dimensions;
        
        // Set container dimensions
        container.style.width = '100%';
        container.style.height = canvasHeight + 'px';
        
        // Create canvas
        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth * DPI_MULTIPLIER;
        canvas.height = canvasHeight * DPI_MULTIPLIER;
        canvas.style.width = canvasWidth + 'px';
        canvas.style.height = canvasHeight + 'px';
        canvas.style.display = 'block';
        canvas.style.position = 'relative';
        canvas.style.pointerEvents = 'auto';
        canvas.style.cursor = 'default';
        canvas.style.margin = '0';
        canvas.style.padding = '0';
        
        container.appendChild(canvas);
        viewEl.appendChild(container);
        
        // Create canvas data object
        const canvasData = {
            canvas: canvas,
            ctx: canvas.getContext('2d'),
            container: container,
            totalWidth: totalWidth,
            ...(totalHeight !== undefined && { totalHeight: totalHeight }),
            ...additionalCanvasData
        };
        
        // Scale context for high DPI
        canvasData.ctx.scale(DPI_MULTIPLIER, DPI_MULTIPLIER);
        
        return { canvas, container, canvasData, dimensions };
    }
    
    function buildMSAView() {
        const MSA_CHAR_WIDTH = getCharWidthForMode('msa');
        const totalWidth = NAME_COLUMN_WIDTH + (msaData.queryLength * MSA_CHAR_WIDTH);
        const totalHeight = (msaData.sequences.length + 1) * SEQUENCE_ROW_HEIGHT;
        
        // Calculate actual available space
        const msaHeader = document.getElementById('msaHeader');
        const headerHeight = msaHeader ? msaHeader.offsetHeight + 8 : 40; // header + margin
        const containerHeight = currentContainerHeight || 450;
        const availableHeightForCanvas = containerHeight - headerHeight;
        const containerWidth = getContainerWidth();
        
        const result = createViewCanvas('msa', {
            viewElementId: 'msaView',
            calculateDimensions: () => ({
                canvasWidth: containerWidth,
                canvasHeight: availableHeightForCanvas,
                totalWidth: totalWidth,
                totalHeight: totalHeight
            })
        });
        
        if (!result) return;
        
        const { canvas, canvasData } = result;
        msaCanvasData = canvasData;
        
        clampScrollTop(result.dimensions.canvasHeight);
        clampScrollLeft(result.dimensions.canvasWidth, MSA_CHAR_WIDTH);
        
        // Cleanup previous interaction manager if exists
        if (activeInteractionManager) {
            activeInteractionManager.cleanup();
        }
        
        // Setup interaction manager with MSA-specific configuration
        const interactionConfig = {
            charWidth: MSA_CHAR_WIDTH,
            supportsVerticalScroll: true,
            clampScrollTop: (h) => clampScrollTop(h),
            getScrollableArea: (w, h) => getScrollableAreaForMode('msa', w, h),
            getScrollLimits: (w, h) => getScrollLimitsForMode('msa', MSA_CHAR_WIDTH, w, h)
        };
        
        activeInteractionManager = new ViewInteractionManager(canvas, 'msa', interactionConfig);
        activeInteractionManager.setupWheelScrolling();
        activeInteractionManager.setupPointerInteractions();
        
        // Initial render
        renderMSACanvas();
    }
    
    function buildPSSMView() {
        const LABEL_WIDTH = CHAR_WIDTH;
        const totalWidth = LABEL_WIDTH + (msaData.queryLength * CHAR_WIDTH);
        const containerWidth = getContainerWidth();
        
        // FIXED HEIGHT for PSSM mode
        const queryRowHeight = CHAR_WIDTH;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const heatmapHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        const canvasHeight = TICK_ROW_HEIGHT + queryRowHeight + heatmapHeight + SCROLLBAR_WIDTH;
        
        const result = createViewCanvas('pssm', {
            viewElementId: 'msaView',
            calculateDimensions: () => ({
                canvasWidth: containerWidth,
                canvasHeight: canvasHeight,
                totalWidth: totalWidth
            }),
            additionalCanvasData: {
                canvasWidth: containerWidth,
                totalHeight: canvasHeight
            }
        });
        
        if (!result) return;
        
        const { canvas, container, canvasData } = result;
        pssmCanvasData = canvasData;
        
        clampScrollLeft(result.dimensions.canvasWidth, CHAR_WIDTH);
        
        // Cleanup previous interaction manager if exists
        if (activeInteractionManager) {
            activeInteractionManager.cleanup();
        }
        
        // Setup interaction manager with PSSM-specific configuration
        const interactionConfig = {
            charWidth: CHAR_WIDTH,
            supportsVerticalScroll: false,
            getScrollableArea: (w, h) => getScrollableAreaForMode('pssm', w, h),
            getScrollLimits: (w, h) => getScrollLimitsForMode('pssm', CHAR_WIDTH, w, h)
        };
        
        activeInteractionManager = new ViewInteractionManager(canvas, 'pssm', interactionConfig);
        activeInteractionManager.setupWheelScrolling();
        activeInteractionManager.setupPointerInteractions();
        
        // Create tooltip element for hover information
        const tooltip = document.createElement('div');
        tooltip.style.position = 'absolute';
        tooltip.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
        tooltip.style.color = '#fff';
        tooltip.style.padding = '4px 8px';
        tooltip.style.borderRadius = '4px';
        tooltip.style.fontSize = '12px';
        tooltip.style.fontFamily = 'monospace';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.zIndex = '1000';
        tooltip.style.display = 'none';
        tooltip.style.whiteSpace = 'nowrap';
        pssmCanvasData.container.appendChild(tooltip);
        
        // Add hover tooltip functionality
        canvas.addEventListener('mousemove', (e) => {
            const pos = getCanvasPositionFromMouse(e, canvas);
            const { logicalWidth, logicalHeight } = getLogicalCanvasDimensions(canvas);
            const { scrollableAreaX, scrollableAreaY } = getScrollableAreaForMode('pssm', logicalWidth, logicalHeight);
            
            const LABEL_WIDTH = CHAR_WIDTH;
            const heatmapY = scrollableAreaY;
            const heatmapX = LABEL_WIDTH;
            const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
            const aaRowHeight = CHAR_WIDTH;
            
            // Check if mouse is over heatmap area
            if (pos.x >= heatmapX && pos.x < logicalWidth && 
                pos.y >= heatmapY && pos.y < heatmapY + NUM_AMINO_ACIDS * aaRowHeight) {
                
                // Calculate position (column)
                const relativeX = pos.x - heatmapX + scrollLeft;
                const position = Math.floor(relativeX / CHAR_WIDTH);
                
                // Calculate amino acid (row)
                const relativeY = pos.y - heatmapY;
                const aaIndex = Math.floor(relativeY / aaRowHeight);
                
                if (position >= 0 && position < msaData.queryLength && 
                    aaIndex >= 0 && aaIndex < NUM_AMINO_ACIDS) {
                    
                    const frequencies = calculateFrequencies();
                    if (frequencies && frequencies[position]) {
                        const aa = AMINO_ACIDS_ORDERED[aaIndex];
                        const probability = frequencies[position][aa] || 0;
                        
                        // Show tooltip
                        tooltip.textContent = `${position + 1}${aa} - ${probability.toFixed(2)}`;
                        tooltip.style.display = 'block';
                        
                        // Position tooltip near cursor (relative to container)
                        const containerRect = pssmCanvasData.container.getBoundingClientRect();
                        tooltip.style.left = (e.clientX - containerRect.left + 10) + 'px';
                        tooltip.style.top = (e.clientY - containerRect.top - 25) + 'px';
                    }
                } else {
                    tooltip.style.display = 'none';
                }
            } else {
                tooltip.style.display = 'none';
            }
        });
        
        canvas.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
        });
        
        renderPSSMCanvas();
    }
    
    function buildLogoView() {
        const LABEL_WIDTH = Y_AXIS_WIDTH;
        const totalWidth = LABEL_WIDTH + (msaData.queryLength * CHAR_WIDTH);
        const containerWidth = getContainerWidth();
        
        // FIXED HEIGHT for Logo mode
        // Layout: Logo at top (extends to query), black bar above query, query sequence below, tick marks below query, scrollbar at bottom
        const queryRowHeight = CHAR_WIDTH;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const LOGO_VERTICAL_PADDING = 12;
        const originalLogoHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        const logoStartY = LOGO_VERTICAL_PADDING;
        const queryY = logoStartY + originalLogoHeight; // Logo extends all the way to query with no gap
        const tickY = queryY + queryRowHeight;
        const canvasHeight = tickY + TICK_ROW_HEIGHT + SCROLLBAR_WIDTH;
        
        const result = createViewCanvas('logo', {
            viewElementId: 'msaView',
            calculateDimensions: () => ({
                canvasWidth: containerWidth,
                canvasHeight: canvasHeight,
                totalWidth: totalWidth
            }),
            additionalCanvasData: {
                canvasWidth: containerWidth,
                totalHeight: canvasHeight
            }
        });
        
        if (!result) return;
        
        const { canvas, canvasData } = result;
        logoCanvasData = canvasData;
        
        clampScrollLeft(result.dimensions.canvasWidth, CHAR_WIDTH);
        
        // Cleanup previous interaction manager if exists
        if (activeInteractionManager) {
            activeInteractionManager.cleanup();
        }
        
        // Setup interaction manager with Logo-specific configuration
        const interactionConfig = {
            charWidth: CHAR_WIDTH,
            supportsVerticalScroll: false,
            getScrollableArea: (w, h) => getScrollableAreaForMode('logo', w, h),
            getScrollLimits: (w, h) => getScrollLimitsForMode('logo', CHAR_WIDTH, w, h)
        };
        
        activeInteractionManager = new ViewInteractionManager(canvas, 'logo', interactionConfig);
        activeInteractionManager.setupWheelScrolling();
        activeInteractionManager.setupPointerInteractions();
        
        renderLogoCanvas();
    }
    
    // ============================================================================
    // SVG EXPORT HELPERS
    // ============================================================================
    
    // Render PSSM to any context (canvas or SVG) - full view, no scrolling
    function renderPSSMToContext(ctx, logicalWidth, logicalHeight, forExport) {
        if (!msaData) return;
        
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);
        
        const frequencies = calculateFrequencies();
        if (!frequencies) return;
        
        const queryRowHeight = CHAR_WIDTH;
        const GAP_HEIGHT = 0;
        const { scrollableAreaX, scrollableAreaY } = getScrollableAreaForMode('pssm', logicalWidth, logicalHeight);
        
        const LABEL_WIDTH = CHAR_WIDTH;
        const queryY = TICK_ROW_HEIGHT;
        const heatmapY = scrollableAreaY + GAP_HEIGHT;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const aaRowHeight = CHAR_WIDTH;
        const heatmapHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        const heatmapX = LABEL_WIDTH;
        const totalWidth = LABEL_WIDTH + (msaData.queryLength * CHAR_WIDTH);
        
        // For export, render all positions; otherwise use visible range
        const startPos = forExport ? 0 : Math.floor(scrollLeft / CHAR_WIDTH);
        const endPos = forExport ? frequencies.length : Math.min(frequencies.length, startPos + Math.ceil((logicalWidth - scrollableAreaX) / CHAR_WIDTH) + 1);
        const xOffsetStart = forExport ? heatmapX : heatmapX - (scrollLeft % CHAR_WIDTH);
        
        // Draw tick marks
        if (forExport) {
            // For export, draw all tick marks across full width
            drawTickMarks(ctx, logicalWidth, 0, CHAR_WIDTH, LABEL_WIDTH, LABEL_WIDTH, logicalWidth);
        } else {
            drawTickMarks(ctx, logicalWidth, scrollLeft, CHAR_WIDTH, LABEL_WIDTH, LABEL_WIDTH, logicalWidth);
        }
        
        // Draw labels
        for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
            const aa = AMINO_ACIDS_ORDERED[i];
            const y = heatmapY + i * aaRowHeight;
            const dayhoffColor = getDayhoffColor(aa);
            
            ctx.fillStyle = `rgb(${dayhoffColor.r}, ${dayhoffColor.g}, ${dayhoffColor.b})`;
            ctx.fillRect(0, y, LABEL_WIDTH, aaRowHeight);
            
            ctx.fillStyle = '#000';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(aa, LABEL_WIDTH / 2, y + aaRowHeight / 2);
        }
        
        // Draw heatmap
        let xOffset = xOffsetStart;
        for (let pos = startPos; pos < endPos && pos < frequencies.length; pos++) {
            const posData = frequencies[pos];
            
            for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
                const aa = AMINO_ACIDS_ORDERED[i];
                const probability = posData[aa] || 0;
                const y = heatmapY + i * aaRowHeight;
                
                const white = {r: 255, g: 255, b: 255};
                const darkBlue = {r: 0, g: 0, b: 139};
                const finalR = Math.round(white.r + (darkBlue.r - white.r) * probability);
                const finalG = Math.round(white.g + (darkBlue.g - white.g) * probability);
                const finalB = Math.round(white.b + (darkBlue.b - white.b) * probability);
                
                ctx.fillStyle = `rgb(${finalR}, ${finalG}, ${finalB})`;
                ctx.fillRect(xOffset, y, CHAR_WIDTH, aaRowHeight);
            }
            
            xOffset += CHAR_WIDTH;
        }
        
        // Draw black boxes around wildtype
        const querySeqForBoxes = msaData.sequences.length > 0 ? msaData.sequences[0].sequence : '';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        let boxXOffset = xOffsetStart;
        for (let pos = startPos; pos < endPos && pos < frequencies.length; pos++) {
            const wildtypeAA = pos < querySeqForBoxes.length ? querySeqForBoxes[pos].toUpperCase() : null;
            if (wildtypeAA) {
                const wildtypeIndex = AMINO_ACIDS_ORDERED.indexOf(wildtypeAA);
                if (wildtypeIndex >= 0) {
                    const y = heatmapY + wildtypeIndex * aaRowHeight;
                    ctx.strokeRect(boxXOffset, y, CHAR_WIDTH, aaRowHeight);
                }
            }
            boxXOffset += CHAR_WIDTH;
        }
        
        // Draw group boundaries
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        for (const boundaryIdx of DAYHOFF_GROUP_BOUNDARIES) {
            const y = heatmapY + boundaryIdx * aaRowHeight;
            ctx.beginPath();
            ctx.moveTo(heatmapX, y);
            ctx.lineTo(heatmapX + (msaData.queryLength * CHAR_WIDTH), y);
            ctx.stroke();
        }
        
        // Draw query sequence
        if (msaData.sequences.length > 0) {
            const querySeq = msaData.sequences[0];
            drawQuerySequence(ctx, totalWidth, queryY, queryRowHeight, querySeq, 0, scrollableAreaX, 0, frequencies.length, LABEL_WIDTH, totalWidth, false);
        }
    }
    
    // Render Logo to any context (canvas or SVG) - full view, no scrolling
    function renderLogoToContext(ctx, logicalWidth, logicalHeight, forExport) {
        if (!msaData) return;
        
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);
        
        const frequencies = calculateFrequencies();
        if (!frequencies) return;
        
        const data = useBitScore 
            ? (cachedLogOdds || calculateLogOdds(frequencies))
            : frequencies;
        if (!data) return;
        
        const queryRowHeight = CHAR_WIDTH;
        const { scrollableAreaX, scrollableAreaY } = getScrollableAreaForMode('logo', logicalWidth, logicalHeight);
        const LABEL_WIDTH = Y_AXIS_WIDTH;
        const LOGO_VERTICAL_PADDING = 12;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const aaRowHeight = CHAR_WIDTH;
        const originalLogoHeight = NUM_AMINO_ACIDS * CHAR_WIDTH;
        const logoY = scrollableAreaY + LOGO_VERTICAL_PADDING;
        const queryY = logoY + originalLogoHeight;
        const effectiveLogoHeight = queryY - logoY;
        const tickY = queryY + queryRowHeight;
        
        // Calculate logo data (same as renderLogoCanvas)
        const logoData = [];
        let maxInfoContent = 0;
        
        if (useBitScore) {
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
                    ? (infoContent / maxInfoContent) * effectiveLogoHeight 
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
            for (let pos = 0; pos < frequencies.length; pos++) {
                const posFreq = frequencies[pos];
                const letterHeights = {};
                let freqSum = 0;
                for (const aa in posFreq) {
                    freqSum += posFreq[aa];
                }
                const normalizationFactor = freqSum > 0 ? 1 / freqSum : 1;
                for (const aa in posFreq) {
                    letterHeights[aa] = (posFreq[aa] * normalizationFactor) * effectiveLogoHeight;
                }
                logoData.push({ infoContent: 0, letterHeights, posData: data[pos] });
            }
        }
        
        // Draw Y-axis
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, LABEL_WIDTH, logicalHeight);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LABEL_WIDTH, logoY - LOGO_VERTICAL_PADDING);
        ctx.lineTo(LABEL_WIDTH, queryY);
        ctx.stroke();
        
        // Y-axis labels
        const axisLabel = useBitScore ? "Bits" : "Probability";
        const axisLabelY = (logoY - LOGO_VERTICAL_PADDING + queryY) / 2;
        ctx.save();
        ctx.translate(LABEL_WIDTH / 2 - 15, axisLabelY);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = '#333';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(axisLabel, 0, 0);
        ctx.restore();
        
        // Y-axis ticks
        ctx.fillStyle = '#333';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const tickValues = [];
        if (useBitScore) {
            const maxVal = maxInfoContent > 0 ? maxInfoContent : 1;
            tickValues.push({ value: 0, label: '0' });
            if (maxVal > 0) {
                tickValues.push({ value: maxVal / 2, label: (maxVal / 2).toFixed(1) });
                tickValues.push({ value: maxVal, label: maxVal.toFixed(1) });
            }
        } else {
            tickValues.push({ value: 0, label: '0.0' });
            tickValues.push({ value: 0.5, label: '0.5' });
            tickValues.push({ value: 1.0, label: '1.0' });
        }
        
        const logoBottomY = queryY;
        const logoTopY = logoY;
        for (const tick of tickValues) {
            let yPos;
            if (useBitScore) {
                const maxVal = maxInfoContent > 0 ? maxInfoContent : 1;
                yPos = logoBottomY - (tick.value / maxVal) * effectiveLogoHeight;
            } else {
                yPos = logoBottomY - tick.value * effectiveLogoHeight;
            }
            ctx.fillText(tick.label, LABEL_WIDTH - 8, yPos);
            ctx.beginPath();
            ctx.moveTo(LABEL_WIDTH - 5, yPos);
            ctx.lineTo(LABEL_WIDTH, yPos);
            ctx.stroke();
        }
        
        // Draw stacked logo
        const startPos = forExport ? 0 : Math.floor(scrollLeft / CHAR_WIDTH);
        const endPos = forExport ? logoData.length : Math.min(logoData.length, startPos + Math.ceil((logicalWidth - scrollableAreaX) / CHAR_WIDTH) + 1);
        let xOffset = forExport ? scrollableAreaX : scrollableAreaX - (scrollLeft % CHAR_WIDTH);
        
        for (let pos = startPos; pos < endPos && pos < logoData.length; pos++) {
            const logoPos = logoData[pos];
            const letterHeights = logoPos.letterHeights;
            const aas = Object.keys(letterHeights).sort((a, b) => letterHeights[a] - letterHeights[b]);
            
            let currentY = queryY;
            for (const aa of aas) {
                const h = letterHeights[aa];
                if (h > 0) {
                    const color = getDayhoffColor(aa);
                    // drawScaledLetter takes x as left edge of cell (same as renderLogoCanvas)
                    drawScaledLetter(ctx, aa, xOffset, currentY, CHAR_WIDTH, h, `rgb(${color.r}, ${color.g}, ${color.b})`, null);
                    currentY -= h;
                }
            }
            
            xOffset += CHAR_WIDTH;
        }
        
        // Draw black bar above query
        ctx.fillStyle = '#000';
        ctx.fillRect(scrollableAreaX, queryY, logicalWidth - scrollableAreaX, 1);
        
        // Draw query sequence
        if (msaData.sequences.length > 0) {
            const querySeq = msaData.sequences[0];
            // For export, ensure query sequence aligns with logo by using same xOffset calculation
            if (forExport) {
                // Draw query sequence aligned with logo stacks
                let queryXOffset = scrollableAreaX;
                for (let pos = 0; pos < querySeq.sequence.length && pos < logoData.length; pos++) {
                    const aa = querySeq.sequence[pos];
                    const color = getDayhoffColor(aa);
                    
                    ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
                    ctx.fillRect(queryXOffset, queryY, CHAR_WIDTH, queryRowHeight);
                    
                    ctx.fillStyle = '#000';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(aa, queryXOffset + CHAR_WIDTH / 2, queryY + queryRowHeight / 2);
                    
                    queryXOffset += CHAR_WIDTH;
                }
            } else {
                drawQuerySequence(ctx, logicalWidth, queryY, queryRowHeight, querySeq, scrollLeft, scrollableAreaX, startPos, endPos, LABEL_WIDTH, logicalWidth, false);
            }
        }
        
        // Draw tick marks
        drawTickMarks(ctx, logicalWidth, forExport ? 0 : scrollLeft, CHAR_WIDTH, LABEL_WIDTH, LABEL_WIDTH, logicalWidth, tickY);
    }
    
    // ============================================================================
    // PUBLIC API
    // ============================================================================
    
    window.MSAViewer = {
        setCallbacks: function(cb) {
            callbacks = Object.assign({}, callbacks, cb);
        },
        
        parseA3M: parseA3M,
        parseFasta: parseFasta,
        parseSTO: parseSTO,
        
        getMSAData: function() {
            return msaData;
        },
        
        /**
         * Calculate Shannon entropy for each position in the current filtered MSA
         * Uses the same frequency calculation as logo/PSSM views
         * @returns {Array} - Array of normalized entropy values (0 to 1 scale, one per MSA position)
         */
        calculateEntropy: function() {
            return calculateEntropy();
        },
        
        setCoverageCutoff: function(cutoff) {
            coverageCutoff = Math.max(0, Math.min(1, cutoff));
            if (originalMSAData) {
                const oldSequenceCount = msaData ? msaData.sequences.length : 0;
                
                // Use original order sequences for filtering
                const sequencesToFilter = originalMSAData.sequencesOriginal || originalMSAData.sequences;
                let filtered = filterSequencesByCoverage(sequencesToFilter, coverageCutoff);
                filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
                
                // Apply sorting if enabled
                const finalSequences = sortSequences 
                    ? sortSequencesByIdentity(filtered, originalMSAData.querySequence, originalMSAData.queryLength)
                    : filtered;
                
                msaData = {
                    sequences: finalSequences,
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
                cachedEntropy = null;
                cachedEntropyHash = null;
                cachedDataHash = null;
                cachedEntropy = null;
                cachedEntropyHash = null;
                
                // Invalidate interaction manager cache (scroll limits depend on sequences.length)
                if (activeInteractionManager) {
                    activeInteractionManager._invalidateCache();
                }
                
                // Notify callback that filtered MSA has changed (for entropy recalculation)
                if (callbacks.onMSAFilterChange) {
                    callbacks.onMSAFilterChange(msaData, currentChain);
                }
                
                if (msaCanvasData && msaCanvasData.canvas && msaViewMode === 'msa') {
                    scheduleRender();
                } else if (pssmCanvasData && pssmCanvasData.canvas && msaViewMode === 'pssm') {
                    scheduleRender();
                } else if (logoCanvasData && logoCanvasData.canvas && msaViewMode === 'logo') {
                    scheduleRender();
                } else {
                    buildViewForMode(msaViewMode);
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
                
                // Use original order sequences for filtering
                const sequencesToFilter = originalMSAData.sequencesOriginal || originalMSAData.sequences;
                let filtered = filterSequencesByCoverage(sequencesToFilter, coverageCutoff);
                filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
                
                // Apply sorting if enabled
                const finalSequences = sortSequences 
                    ? sortSequencesByIdentity(filtered, originalMSAData.querySequence, originalMSAData.queryLength)
                    : filtered;
                
                msaData = {
                    sequences: finalSequences,
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
                cachedEntropy = null;
                cachedEntropyHash = null;
                cachedDataHash = null;
                cachedEntropy = null;
                cachedEntropyHash = null;
                
                // Invalidate interaction manager cache (scroll limits depend on sequences.length)
                if (activeInteractionManager) {
                    activeInteractionManager._invalidateCache();
                }
                
                // Notify callback that filtered MSA has changed (for entropy recalculation)
                if (callbacks.onMSAFilterChange) {
                    callbacks.onMSAFilterChange(msaData, currentChain);
                }
                
                if (msaCanvasData && msaCanvasData.canvas && msaViewMode === 'msa') {
                    scheduleRender();
                } else if (pssmCanvasData && pssmCanvasData.canvas && msaViewMode === 'pssm') {
                    scheduleRender();
                } else if (logoCanvasData && logoCanvasData.canvas && msaViewMode === 'logo') {
                    scheduleRender();
                } else {
                    buildViewForMode(msaViewMode);
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
        
        setMSAData: function(data, chainId = null) {
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
            originalMSAData = data;
            
            // Use original order sequences for filtering
            const sequencesToFilter = originalMSAData.sequencesOriginal || originalMSAData.sequences;
            let filtered = filterSequencesByCoverage(sequencesToFilter, coverageCutoff);
            filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
            
            // Apply sorting if enabled
            const finalSequences = sortSequences 
                ? sortSequencesByIdentity(filtered, originalMSAData.querySequence, originalMSAData.queryLength)
                : filtered;
            
            msaData = {
                sequences: finalSequences,
                querySequence: originalMSAData.querySequence,
                queryLength: originalMSAData.queryLength
            };
            
            // Copy computed properties from original data if they exist
            if (originalMSAData.frequencies) {
                msaData.frequencies = originalMSAData.frequencies;
            }
            if (originalMSAData.entropy) {
                msaData.entropy = originalMSAData.entropy;
            }
            if (originalMSAData.logOdds) {
                msaData.logOdds = originalMSAData.logOdds;
            }
            
            // Build residue_numbers mapping from structure if available
            // This maps MSA positions to structure residue_numbers values for display
            msaResidueNumbers = null;
            if (originalMSAData.residueNumbers) {
                // Use provided residueNumbers if available
                msaResidueNumbers = originalMSAData.residueNumbers;
                msaData.residueNumbers = msaResidueNumbers;
            } else {
                // Build residue_numbers mapping from structure if available
                msaResidueNumbers = buildMSAResidueNumbersMapping(chainId);
                if (msaResidueNumbers) {
                    msaData.residueNumbers = msaResidueNumbers;
                    // CRITICAL: Also update originalMSAData so it's available for filtering
                    originalMSAData.residueNumbers = msaResidueNumbers;
                }
            }
            
            // Compute properties if not already present (for filtered data, recompute)
            // Note: If filters changed, we need to recompute, so clear cached values
            cachedFrequencies = null;
            cachedLogOdds = null;
            cachedDataHash = null;
            cachedEntropy = null;
            cachedEntropyHash = null;
            
            // Compute and store frequencies, entropy, and logOdds once when MSA is set
            // This ensures they're available for entropy coloring without recalculation
            calculateFrequencies(); // This will compute and store in msaData.frequencies
            calculateEntropy(); // This will compute and store in msaData.entropy
            // logOdds will be computed on-demand when needed for logo view
            
            let canvasWidth = 916;
            let charWidth = getCharWidthForMode(msaViewMode);
            if (msaViewMode === 'msa' && msaCanvasData && msaCanvasData.canvas) {
                canvasWidth = msaCanvasData.canvas.width / DPI_MULTIPLIER;
            } else if (msaViewMode === 'pssm' && pssmCanvasData && pssmCanvasData.canvas) {
                canvasWidth = pssmCanvasData.canvas.width / DPI_MULTIPLIER;
            } else if (msaViewMode === 'logo' && logoCanvasData && logoCanvasData.canvas) {
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
            
            // Initialize resize observer
            initResizeObserver();
            
            buildViewForMode(msaViewMode);
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
                            const {msaData} = obj.msa.msasBySequence[querySeq];
                            this.setMSAData(msaData, chainId);
                        }
                    }
                }
            }
        },
        
        getCurrentChain: function() {
            return currentChain;
        },
        
        updateMSAViewSelectionState: function() {
            // Filter MSA data based on selection and rebuild view
            if (!originalMSAData) {
                // No MSA data - just trigger re-render
                if (msaViewMode === 'msa' && msaCanvasData) {
                    scheduleRender();
                } else if (msaViewMode === 'pssm' && pssmCanvasData) {
                    scheduleRender();
                } else if (msaViewMode === 'logo' && logoCanvasData) {
                    scheduleRender();
                }
                return;
            }
            
            // Get selection data and chain mappings
            let msaSelectedPositions = null;
            let chainsForMSA = null;
            if (callbacks.getRenderer) {
                const renderer = callbacks.getRenderer();
                if (renderer && renderer.currentObjectName) {
                    const obj = renderer.objectsData[renderer.currentObjectName];
                    if (obj && obj.msa && currentChain) {
                        // Get chains that map to this MSA
                        const querySeq = obj.msa.chainToSequence[currentChain];
                        if (querySeq && obj.msa.msasBySequence[querySeq]) {
                            const msaEntry = obj.msa.msasBySequence[querySeq];
                            chainsForMSA = msaEntry.chains || [currentChain];
                        } else {
                            chainsForMSA = [currentChain];
                        }
                        
                        // Get selection data
                        if (typeof window !== 'undefined' && window._msaSelectedPositions !== undefined) {
                            msaSelectedPositions = window._msaSelectedPositions;
                        }
                    }
                }
            }
            
            // First filter by selection to remove unselected positions
            // This ensures coverage/identity filters are calculated on the selected regions only
            const baseMSAData = {
                sequences: originalMSAData.sequencesOriginal || originalMSAData.sequences,
                querySequence: originalMSAData.querySequence,
                queryLength: originalMSAData.queryLength,
                queryIndex: originalMSAData.queryIndex || 0
            };
            
            // Preserve residueNumbers if available - need to copy the array
            if (originalMSAData.residueNumbers) {
                baseMSAData.residueNumbers = [...originalMSAData.residueNumbers];
            }
            if (originalMSAData.sequencesOriginal) {
                baseMSAData.sequencesOriginal = originalMSAData.sequencesOriginal;
            }
            
            // Filter by selection first (removes unselected positions)
            const selectionFilteredMSA = filterMSADataBySelection(baseMSAData, chainsForMSA, msaSelectedPositions);
            
            // Now apply coverage/identity filters to the selection-filtered MSA
            // This calculates coverage/identity based on the selected regions only
            const sequencesToFilter = selectionFilteredMSA.sequences;
            let filtered = filterSequencesByCoverage(sequencesToFilter, coverageCutoff);
            filtered = filterSequencesByIdentity(filtered, selectionFilteredMSA.querySequence, identityCutoff);
            
            // Apply sorting if enabled
            const finalSequences = sortSequences 
                ? sortSequencesByIdentity(filtered, selectionFilteredMSA.querySequence, selectionFilteredMSA.queryLength)
                : filtered;
            
            // Create final MSA data with both selection and coverage/identity filtering applied
            const filteredMSA = {
                sequences: finalSequences,
                querySequence: selectionFilteredMSA.querySequence,
                queryLength: selectionFilteredMSA.queryLength,
                queryIndex: selectionFilteredMSA.queryIndex || 0,
                residueNumbers: selectionFilteredMSA.residueNumbers
            };
            
            // Update msaData with filtered version
            msaData = filteredMSA;
            
            // CRITICAL: Update msaResidueNumbers to the filtered array
            // drawTickMarks uses msaData.residueNumbers || msaResidueNumbers
            // So we need to ensure msaResidueNumbers is set to the filtered version
            msaResidueNumbers = filteredMSA.residueNumbers || null;
            
            // Clear cached properties since data changed
            cachedFrequencies = null;
            cachedLogOdds = null;
            cachedDataHash = null;
            cachedEntropy = null;
            cachedEntropyHash = null;
            
            // Invalidate interaction manager cache (scroll limits depend on queryLength)
            if (activeInteractionManager) {
                activeInteractionManager._invalidateCache();
            }
            
            // Rebuild view for current mode
            buildViewForMode(msaViewMode);
        },
        
        getMSAMode: function() {
            return msaViewMode;
        },
        
        saveLogoAsSvg: function() {
            if (!logoCanvasData || !logoCanvasData.canvas || !msaData) {
                console.error('Logo canvas or MSA data not available');
                return;
            }
            
            const canvas = logoCanvasData.canvas;
            const { logicalHeight } = getLogicalCanvasDimensions(canvas);
            
            // Calculate full width needed for all positions
            const LABEL_WIDTH = Y_AXIS_WIDTH;
            const fullWidth = LABEL_WIDTH + (msaData.queryLength * CHAR_WIDTH);
            
            // Create SVG context with full width
            const svgCtx = new SimpleCanvas2SVG(fullWidth, logicalHeight);
            
            // Render to SVG context (full view, no scrolling)
            renderLogoToContext(svgCtx, fullWidth, logicalHeight, true);
            
            // Get SVG string and download
            const svgString = svgCtx.getSerializedSvg();
            downloadFile(svgString, 'msa_logo', 'svg', 'image/svg+xml;charset=utf-8');
        },
        
        savePSSMAsSvg: function() {
            if (!pssmCanvasData || !pssmCanvasData.canvas || !msaData) {
                console.error('PSSM canvas or MSA data not available');
                return;
            }
            
            const canvas = pssmCanvasData.canvas;
            const { logicalHeight } = getLogicalCanvasDimensions(canvas);
            
            // Calculate full width needed for all positions
            const LABEL_WIDTH = CHAR_WIDTH;
            const fullWidth = LABEL_WIDTH + (msaData.queryLength * CHAR_WIDTH);
            
            // Create SVG context with full width
            const svgCtx = new SimpleCanvas2SVG(fullWidth, logicalHeight);
            
            // Render to SVG context (full view, no scrolling)
            renderPSSMToContext(svgCtx, fullWidth, logicalHeight, true);
            
            // Get SVG string and download
            const svgString = svgCtx.getSerializedSvg();
            downloadFile(svgString, 'msa_pssm', 'svg', 'image/svg+xml;charset=utf-8');
        },
        
        savePSSMAsCsv: function() {
            if (!msaData) {
                console.error('MSA data not available');
                return;
            }
            
            const frequencies = calculateFrequencies();
            if (!frequencies || frequencies.length === 0) {
                console.error('No frequency data available');
                return;
            }
            
            // Build CSV output
            let csv = 'Position,' + AMINO_ACIDS_ORDERED.join(',') + '\n';
            
            for (let pos = 0; pos < frequencies.length; pos++) {
                const posData = frequencies[pos];
                const line = [pos + 1]; // 1-indexed position
                
                for (const aa of AMINO_ACIDS_ORDERED) {
                    const prob = posData[aa] || 0;
                    line.push(prob.toFixed(4));
                }
                
                csv += line.join(',') + '\n';
            }
            
            // Download CSV
            downloadFile(csv, 'msa_pssm', 'csv', 'text/csv;charset=utf-8');
        },
        
        saveMSAAsFasta: function() {
            if (!msaData || !msaData.sequences || msaData.sequences.length === 0) {
                console.error('MSA data not available');
                return;
            }
            
            // Build FASTA output from currently filtered/visible sequences
            let fasta = '';
            
            for (const seq of msaData.sequences) {
                // FASTA format: >name\nsequence\n
                const name = seq.name || 'Unknown';
                const sequence = seq.sequence || '';
                
                // Ensure name starts with '>' if it doesn't already
                const fastaName = name.startsWith('>') ? name : '>' + name;
                fasta += fastaName + '\n';
                fasta += sequence + '\n';
            }
            
            // Download FASTA
            downloadFile(fasta, 'msa_sequences', 'fasta', 'text/plain;charset=utf-8');
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
                cachedEntropy = null;
                cachedEntropyHash = null;
            }
            
            buildViewForMode(mode);
            
            // Adjust scroll position after mode switch
            if (msaData) {
                let canvasWidth = 916;
                let charWidth = getCharWidthForMode(mode);
                let scrollableAreaX = 0;
                
                if (mode === 'msa' && msaCanvasData && msaCanvasData.canvas) {
                    canvasWidth = msaCanvasData.canvas.width / DPI_MULTIPLIER;
                    scrollableAreaX = NAME_COLUMN_WIDTH;
                    charWidth = CHAR_WIDTH / 2;
                } else if (mode === 'pssm' && pssmCanvasData && pssmCanvasData.canvas) {
                    canvasWidth = pssmCanvasData.canvas.width / DPI_MULTIPLIER;
                    scrollableAreaX = CHAR_WIDTH;
                    charWidth = CHAR_WIDTH;
                } else if (mode === 'logo' && logoCanvasData && logoCanvasData.canvas) {
                    canvasWidth = logoCanvasData.canvas.width / DPI_MULTIPLIER;
                    scrollableAreaX = Y_AXIS_WIDTH;
                    charWidth = CHAR_WIDTH;
                }
                
                if (canvasWidth > 0) {
                    const scrollableAreaWidth = canvasWidth - scrollableAreaX - (mode === 'msa' ? SCROLLBAR_WIDTH : 0);
                    const totalScrollableWidth = msaData.queryLength * charWidth;
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
                cachedEntropy = null;
                cachedEntropyHash = null;
            }
            if (msaViewMode === 'logo') {
                scheduleRender();
            }
        },
        
        getSortSequences: function() {
            return sortSequences;
        },
        
        setSortSequences: function(value) {
            sortSequences = value;
            if (originalMSAData && msaViewMode === 'msa') {
                // Reapply filtering and sorting
                const sequencesToFilter = originalMSAData.sequencesOriginal || originalMSAData.sequences;
                let filtered = filterSequencesByCoverage(sequencesToFilter, coverageCutoff);
                filtered = filterSequencesByIdentity(filtered, originalMSAData.querySequence, identityCutoff);
                
                // Apply sorting if enabled
                const finalSequences = sortSequences 
                    ? sortSequencesByIdentity(filtered, originalMSAData.querySequence, originalMSAData.queryLength)
                    : filtered;
                
                msaData = {
                    sequences: finalSequences,
                    querySequence: originalMSAData.querySequence,
                    queryLength: originalMSAData.queryLength
                };
                
                // Invalidate interaction manager cache (scroll limits depend on sequences.length)
                if (activeInteractionManager) {
                    activeInteractionManager._invalidateCache();
                }
                
                if (msaCanvasData && msaCanvasData.canvas) {
                    scheduleRender();
                }
            }
        },
        
        getSequenceCounts: function() {
            const filtered = msaData ? msaData.sequences.length : 0;
            // Use sequencesOriginal for total count (all sequences before any filtering)
            // If sequencesOriginal doesn't exist, fall back to sequences
            const total = originalMSAData 
                ? (originalMSAData.sequencesOriginal ? originalMSAData.sequencesOriginal.length : originalMSAData.sequences.length)
                : 0;
            return { filtered, total };
        },
        
        clear: function() {
            msaData = null;
            originalMSAData = null;
            msaCanvasData = null;
            pssmCanvasData = null;
            logoCanvasData = null;
            cachedFrequencies = null;
            cachedLogOdds = null;
            cachedDataHash = null;
            cachedEntropy = null;
            cachedEntropyHash = null;
            
            // Reset state variables to initial values
            currentChain = null;
            
            // Disconnect resize observer
            if (resizeObserver) {
                resizeObserver.disconnect();
                resizeObserver = null;
            }
        },
        
        buildMSAView: buildMSAView,
        buildPSSMView: buildPSSMView,
        buildLogoView: buildLogoView
    };
    
})();