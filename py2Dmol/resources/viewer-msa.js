// ============================================================================
// py2Dmol/resources/viewer-msa.js
// -------------------------------
// AI Context: MSA VIEWER
// - Visualizes Multiple Sequence Alignments.
// - Supports multiple modes: MSA, PSSM, Logo, Coverage.
// - Implements client-side filtering and sorting of sequences.
// ============================================================================
// MSA VIEWER MODULE
// ============================================================================
/**
 * DATA FLOW ARCHITECTURE
 * 
 * 1. SOURCE DATA (immutable after loading)
 *    sourceMSA ← Loaded from file/API, never modified
 *    
 * 2. FILTERING PIPELINE (creates displayedMSA)
 *    sourceMSA 
 *      → buildSelectionMask()           [marks selected/dimmed positions]
 *      → filterByCoverage()             [filters sequences by coverage]
 *      → filterByIdentity()             [filters sequences by identity]
 *      → sortByIdentity()               [sorts by identity (optional)]
 *      → displayedMSA                   [final data with selectionMask]
 * 
 * 3. RENDERING (all 4 modes read displayedMSA)
 *    displayedMSA → MSA Mode      [direct visualization]
 *    displayedMSA → PSSM Mode     [via computePositionFrequencies]
 *    displayedMSA → Logo Mode     [via computePositionFrequencies]
 *    displayedMSA → Coverage Mode [via computeCoverageDataset]
 * 
 * 4. UPDATE TRIGGERS (re-run pipeline)
 *    - Selection change          → applyFiltersAndRender()
 *    - Coverage slider           → applyFiltersAndRender()
 *    - Identity slider           → applyFiltersAndRender()
 *    - Sort toggle               → applyFiltersAndRender()
 * 
 * NAMING CONVENTIONS:
 *    compute*    - Pure calculations (no state changes)
 *    filter*     - Returns filtered subset
 *    apply*      - Updates state + triggers render
 *    build*      - Creates canvas/view setup
 *    render*     - Draws to canvas
 *    get*        - Retrieves/derives data
 */

(function () {
    'use strict';

    // ============================================================================
    // SIMPLE CANVAS2SVG FOR MSA VIEWER
    // ============================================================================
    // Minimal canvas2svg implementation for MSA viewer
    // Supports: fillRect, strokeRect, fillText, clip, save/restore

    function MSACanvas2SVG(width, height) {
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

    MSACanvas2SVG.prototype.fillRect = function (x, y, w, h) {
        this.operations.push({
            type: 'rect',
            x: x, y: y, width: w, height: h,
            fillStyle: this.fillStyle,
            clip: this.currentClip
        });
    };

    MSACanvas2SVG.prototype.strokeRect = function (x, y, w, h) {
        this.operations.push({
            type: 'strokeRect',
            x: x, y: y, width: w, height: h,
            strokeStyle: this.strokeStyle,
            lineWidth: this.lineWidth,
            clip: this.currentClip
        });
    };

    MSACanvas2SVG.prototype.fillText = function (text, x, y) {
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

    MSACanvas2SVG.prototype.beginPath = function () {
        this.currentPath = [];
    };

    MSACanvas2SVG.prototype.moveTo = function (x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'M', x: x, y: y });
    };

    MSACanvas2SVG.prototype.lineTo = function (x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'L', x: x, y: y });
    };

    MSACanvas2SVG.prototype.stroke = function () {
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

    MSACanvas2SVG.prototype.rect = function (x, y, w, h) {
        // Used for clipping
        this.currentPath = { type: 'rect', x: x, y: y, width: w, height: h };
    };

    MSACanvas2SVG.prototype.clip = function () {
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

    MSACanvas2SVG.prototype.save = function () {
        this.clipStack.push(this.currentClip);
        this.transformStack.push({ ...this.currentTransform });
    };

    MSACanvas2SVG.prototype.restore = function () {
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

    MSACanvas2SVG.prototype.clearRect = function () {
        // Ignore - we add white background in SVG
    };

    // Transform methods - track transforms and apply to operations
    MSACanvas2SVG.prototype.translate = function (tx, ty) {
        this.currentTransform.tx += tx * this.currentTransform.sx;
        this.currentTransform.ty += ty * this.currentTransform.sy;
    };

    MSACanvas2SVG.prototype.scale = function (sx, sy) {
        this.currentTransform.sx *= sx;
        this.currentTransform.sy *= (sy !== undefined ? sy : sx);
    };

    MSACanvas2SVG.prototype.rotate = function (angle) {
        this.currentTransform.rotation += angle;
    };

    MSACanvas2SVG.prototype.setTransform = function () {
        // Reset transform
        this.currentTransform = { tx: 0, ty: 0, sx: 1, sy: 1, rotation: 0 };
    };

    MSACanvas2SVG.prototype.fill = function () { };

    // measureText - needed for getGlyphMetrics
    // Create a temporary canvas context for text measurement
    let measureTextCanvas = null;
    let measureTextCtx = null;
    MSACanvas2SVG.prototype.measureText = function (text) {
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
    MSACanvas2SVG.prototype.getSerializedSvg = function () {
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
        const left = m.actualBoundingBoxLeft ?? 0;
        const right = m.actualBoundingBoxRight ?? (m.width ?? 100);
        const ascent = m.actualBoundingBoxAscent ?? 80;
        const desc = m.actualBoundingBoxDescent ?? 20;

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
    // ============================================================================
    // DATA STATE - Single Source of Truth
    // ============================================================================

    // Primary MSA data (what user currently sees after all filters applied)
    let displayedMSA = null; // { sequences: [], querySequence: string, queryLength: number, residueNumbers: [] }

    // Source data (immutable after loading, never filtered)
    let sourceMSA = null; // Original unfiltered MSA data

    // Position mapping
    let positionToResidueMap = null; // Array mapping MSA positions to structure residue_numbers values

    // Canvas data for each mode
    let msaCanvasData = null; // Canvas-based structure for MSA mode
    let pssmCanvasData = null; // Canvas-based structure for PSSM mode
    let logoCanvasData = null; // Canvas-based structure for Logo mode
    let coverageCanvasData = null; // Canvas-based structure for Coverage mode

    // View state
    let msaViewMode = 'msa'; // 'msa', 'pssm', 'logo', or 'coverage'
    let useBitScore = true; // true for bit-score, false for probabilities
    let renderScheduled = false;

    // Filter and sort settings
    let shouldSortByIdentity = true; // true for sorted by similarity, false for original order
    let activeChainId = null; // Current chain ID
    let minCoverageThreshold = 0.75;
    let previewCoverageThreshold = 0.75;
    let minIdentityThreshold = 0.15;
    let previewIdentityThreshold = 0.15;


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
        { name: 'group1', label: 'KR', aminoAcids: ['K', 'R'], color: { r: 212, g: 68, b: 43 } }, // #d4442b
        { name: 'group2', label: 'AFILMVW', aminoAcids: ['A', 'F', 'I', 'L', 'M', 'V', 'W'], color: { r: 61, g: 126, b: 223 } }, // #3d7edf
        { name: 'group3', label: 'NQST', aminoAcids: ['N', 'Q', 'S', 'T'], color: { r: 96, g: 201, b: 65 } }, // #60c941
        { name: 'group4', label: 'HY', aminoAcids: ['H', 'Y'], color: { r: 83, g: 177, b: 178 } }, // #53b1b2
        { name: 'group5', label: 'C', aminoAcids: ['C'], color: { r: 217, g: 133, b: 130 } }, // #d98582
        { name: 'group6', label: 'DE', aminoAcids: ['D', 'E'], color: { r: 189, g: 85, b: 198 } }, // #bd55c6
        { name: 'group7', label: 'P', aminoAcids: ['P'], color: { r: 204, g: 204, b: 65 } }, // #cccc41
        { name: 'group8', label: 'G', aminoAcids: ['G'], color: { r: 219, g: 157, b: 91 } } // #db9d5b
    ];

    const DAYHOFF_COLORS = {};
    const DAYHOFF_GROUPS = {};
    DAYHOFF_GROUP_DEFINITIONS.forEach(group => {
        DAYHOFF_COLORS[group.name] = group.color;
        group.aminoAcids.forEach(aa => {
            DAYHOFF_GROUPS[aa] = group.name;
        });
    });
    DAYHOFF_COLORS.gap = { r: 200, g: 200, b: 200 };
    DAYHOFF_COLORS.other = { r: 150, g: 150, b: 150 };

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
    // CONSTANTS
    // ============================================================================

    const MIN_CANVAS_WIDTH = 948;
    const DEFAULT_COVERAGE_HEIGHT = 420;

    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    function clamp01(value) {
        return Math.max(0, Math.min(1, value));
    }

    function clearCanvas(ctx, width, height) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
    }

    function isQuerySequence(seqName) {
        return seqName === '>query' || seqName.toLowerCase().includes('query');
    }

    function isGapResidue(residue) {
        return !residue || residue === '-' || residue === '.' || residue === ' ' || residue === 'X';
    }

    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            renderForMode(msaViewMode);
        });
    }

    function buildViewForMode(mode) {
        switch (mode) {
            case 'msa':
                buildMSAView();
                break;
            case 'pssm':
                buildPSSMView();
                break;
            case 'logo':
                buildLogoView();
                break;
            case 'coverage':
                buildCoverageView();
                break;
        }
    }

    function renderForMode(mode) {
        switch (mode) {
            case 'msa':
                renderMSACanvas();
                break;
            case 'pssm':
                renderPSSMCanvas();
                break;
            case 'logo':
                renderLogoCanvas();
                break;
            case 'coverage':
                renderCoverageCanvas();
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

    // ============================================================================
    // CORE COMPUTATIONS (Pure Functions)
    // ============================================================================

    function computeSequenceCoverage(sequence, queryLength, selectionMask = null) {
        if (!sequence || queryLength === 0) return 0;
        let nonGapCount = 0;
        let effectiveLength = 0;

        for (let i = 0; i < sequence.length; i++) {
            // Only count positions that are selected (if selectionMask is provided)
            if (selectionMask && !selectionMask[i]) continue;

            effectiveLength++;
            if (!isGapResidue(sequence[i])) {
                nonGapCount++;
            }
        }

        return effectiveLength > 0 ? nonGapCount / effectiveLength : 0;
    }

    function computeSequenceIdentity(seq1, seq2, selectionMask = null) {
        if (!seq1 || !seq2 || seq1.length !== seq2.length) return 0;
        let matches = 0;
        let total = 0;

        for (let i = 0; i < seq1.length; i++) {
            // Only count positions that are selected (if selectionMask is provided)
            if (selectionMask && !selectionMask[i]) continue;

            const c1 = seq1[i].toUpperCase();
            const c2 = seq2[i].toUpperCase();
            total++;
            if (!isGapResidue(c1) && !isGapResidue(c2) && c1 === c2) {
                matches++;
            }
        }

        return total > 0 ? matches / total : 0;
    }

    const COVERAGE_COLOR_STOPS = [
        { value: 0.0, color: [239, 68, 68] },   // red
        { value: 0.5, color: [252, 211, 77] },  // yellow
        { value: 0.75, color: [16, 185, 129] }, // green
        { value: 1.0, color: [37, 99, 235] }    // blue
    ];

    function interpolateColor(colorA, colorB, t) {
        return [
            Math.round(colorA[0] + (colorB[0] - colorA[0]) * t),
            Math.round(colorA[1] + (colorB[1] - colorA[1]) * t),
            Math.round(colorA[2] + (colorB[2] - colorA[2]) * t)
        ];
    }

    function getCoverageColor(identity) {
        const clamped = clamp01(identity || 0);
        for (let i = 0; i < COVERAGE_COLOR_STOPS.length - 1; i++) {
            const stopA = COVERAGE_COLOR_STOPS[i];
            const stopB = COVERAGE_COLOR_STOPS[i + 1];
            if (clamped >= stopA.value && clamped <= stopB.value) {
                const span = stopB.value - stopA.value || 1;
                const t = (clamped - stopA.value) / span;
                return interpolateColor(stopA.color, stopB.color, t);
            }
        }
        return COVERAGE_COLOR_STOPS[COVERAGE_COLOR_STOPS.length - 1].color;
    }

    // ============================================================================
    // SELECTION STATE HELPERS
    // ============================================================================

    /**
     * Get current selection state from renderer
     * @returns {{positions: Map|null, chains: Array<string>|null}}
     */
    function getSelectionState() {
        if (!callbacks.getRenderer) {
            return { positions: null, chains: null };
        }

        const renderer = callbacks.getRenderer();
        if (!renderer?.currentObjectName) {
            return { positions: null, chains: null };
        }

        const obj = renderer.objectsData[renderer.currentObjectName];
        if (!obj?.msa || !activeChainId) {
            return { positions: null, chains: null };
        }

        // Get chains that map to this MSA
        const querySeq = obj.msa.chainToSequence[activeChainId];
        const msaEntry = querySeq && obj.msa.msasBySequence[querySeq];
        const chains = msaEntry?.chains || [activeChainId];

        // Get selection positions from object's MSA state (per-object storage)
        const positions = obj.msa.selectedPositions !== undefined
            ? obj.msa.selectedPositions
            : null;

        return { positions, chains };
    }

    // ============================================================================
    // FILTERING & TRANSFORMATION
    // ============================================================================

    /**
     * Unified filtering pipeline - applies all filters in correct order
     * @param {Object} sourceData - Original unfiltered MSA data
     * @param {Object} options - Filter options
     * @returns {Object} Filtered MSA data
     */
    function computeFilteredMSA(sourceData, options = {}) {
        const {
            selectedPositions = null,
            chains = null,
            minCoverage = minCoverageThreshold,
            minIdentity = minIdentityThreshold,
            shouldSort = shouldSortByIdentity
        } = options;

        // Prepare base data structure
        const baseMSAData = {
            sequences: sourceData.sequencesOriginal || sourceData.sequences,
            querySequence: sourceData.querySequence,
            queryLength: sourceData.queryLength,
            queryIndex: sourceData.queryIndex || 0
        };
        if (sourceData.residueNumbers) {
            baseMSAData.residueNumbers = [...sourceData.residueNumbers];
        }
        if (sourceData.sequencesOriginal) {
            baseMSAData.sequencesOriginal = sourceData.sequencesOriginal;
        }

        // 1. Build selection mask (marks selected vs dimmed positions) - for visual dimming only
        const selectionProcessed = buildSelectionMask(baseMSAData, chains, selectedPositions);

        // 2. Filter by coverage (removes low-coverage sequences)
        // Note: Pass null for mask so filtering is based on all positions, not just selected ones
        let filtered = filterByCoverage(selectionProcessed.sequences, minCoverage, null);

        // 3. Filter by identity (removes low-identity sequences)
        // Note: Pass null for mask so filtering is based on all positions, not just selected ones
        filtered = filterByIdentity(filtered, selectionProcessed.querySequence, minIdentity, null);

        // 4. Sort if enabled
        // Note: Pass null for mask so sorting is based on all positions, not just selected ones
        if (shouldSort) {
            filtered = sortByIdentity(filtered, selectionProcessed.querySequence, selectionProcessed.queryLength, null);
        }

        return {
            sequences: filtered,
            querySequence: selectionProcessed.querySequence,
            queryLength: selectionProcessed.queryLength,
            queryIndex: selectionProcessed.queryIndex || 0,
            residueNumbers: selectionProcessed.residueNumbers,
            selectionMask: selectionProcessed.selectionMask // Include selection mask for dimming
        };
    }

    function filterByCoverage(sequences, minCoverage = 0.5, selectionMask = null) {
        if (!sequences || sequences.length === 0) return [];
        const queryLength = sequences[0]?.sequence?.length || 0;
        return sequences.filter(seq => {
            const coverage = computeSequenceCoverage(seq.sequence, queryLength, selectionMask);
            return coverage >= minCoverage;
        });
    }

    function filterByIdentity(sequences, querySequence, minIdentity = 0.15, selectionMask = null) {
        if (!sequences || sequences.length === 0 || !querySequence) return sequences;
        return sequences.filter(seq => {
            if (isQuerySequence(seq.name)) return true;
            // Use pre-calculated identity if available, otherwise calculate it
            if (seq.identity !== undefined) {
                return seq.identity >= minIdentity;
            }
            const identity = computeSequenceIdentity(seq.sequence, querySequence, selectionMask);
            return identity >= minIdentity;
        });
    }

    function sortByIdentity(sequences, querySequence, queryLength, selectionMask = null) {
        if (!sequences || sequences.length === 0 || !querySequence) return sequences;

        const sequencesWithIdentity = sequences.map(seq => ({
            ...seq,
            identity: computeSequenceIdentity(seq.sequence, querySequence, selectionMask),
            coverage: computeSequenceCoverage(seq.sequence, queryLength, selectionMask)
        }));

        sequencesWithIdentity.sort((a, b) => {
            if (isQuerySequence(a.name)) return -1;
            if (isQuerySequence(b.name)) return 1;
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

        let queryIndex = sequences.findIndex(s => isQuerySequence(s.name));
        if (queryIndex === -1) queryIndex = 0;

        const querySequence = sequences[queryIndex].sequence;
        if (!querySequence || querySequence.length === 0) {
            return null; // Invalid: query sequence is empty
        }

        const queryLength = querySequence.length;
        const sorted = sortByIdentity(sequences, querySequence, queryLength);

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

        const sorted = sortByIdentity(filteredSequences, querySequence, queryLength);

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

        const sorted = sortByIdentity(filteredSequences, querySequence, queryLength);

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

    // Get canvas container dimensions (accounting for padding)
    function getContainerDimensions() {
        const canvasContainer = document.querySelector('.msa-canvas');

        // If canvas container exists, use its dimensions
        if (canvasContainer) {
            const cr = canvasContainer.getBoundingClientRect();
            const padding = 12; // var(--container-padding)
            const width = Math.max(1, Math.floor(cr.width - (padding * 2)) || MIN_CANVAS_WIDTH);
            const height = Math.max(1, Math.floor(cr.height - (padding * 2)) || 420);
            return { width, height };
        }

        // Fallback: default dimensions
        return { width: MIN_CANVAS_WIDTH, height: 420 };
    }

    // Helper specifically for coverage mode: measure available width next to header
    function getMSAStageDimensions() {
        const header = document.getElementById('msa-buttons');
        if (!header) return null;
        const parent = header.parentElement || header;
        const rect = parent.getBoundingClientRect();
        if (!rect || rect.width <= 0) return null;

        let paddingX = 0;
        if (window.getComputedStyle) {
            const styles = window.getComputedStyle(parent);
            const parseSize = (value) => {
                const parsed = parseFloat(value);
                return Number.isFinite(parsed) ? parsed : 0;
            };
            paddingX = parseSize(styles.paddingLeft) + parseSize(styles.paddingRight);
        }

        return {
            width: Math.max(1, Math.floor(rect.width - paddingX)),
            height: Math.max(1, Math.floor(rect.height))
        };
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
        } else if (mode === 'coverage') {
            scrollableAreaX = Y_AXIS_WIDTH;
            scrollableAreaY = 0;
            scrollableAreaWidth = logicalWidth - scrollableAreaX; // No scrolling, stretch to fill
            scrollableAreaHeight = logicalHeight; // Full height, no scrollbar
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
     * @param {string} mode - 'msa', 'pssm', 'logo', or 'coverage'
     * @param {number} charWidth - Character width for the mode
     * @param {number} canvasWidth - Canvas width
     * @param {number} canvasHeight - Canvas height
     * @returns {Object} Object with horizontal and vertical scroll limits
     */
    function getScrollLimitsForMode(mode, charWidth, canvasWidth, canvasHeight) {
        // For coverage mode, use sourceMSA if available
        const dataToUse = (mode === 'coverage' && sourceMSA) ? sourceMSA : displayedMSA;
        if (!dataToUse) {
            return {
                horizontal: { total: 0, max: 0 },
                vertical: { total: 0, max: 0 }
            };
        }

        const { scrollableAreaX, scrollableAreaWidth, scrollableAreaHeight } =
            getScrollableAreaForMode(mode, canvasWidth, canvasHeight);

        const totalScrollableWidth = dataToUse.queryLength * charWidth;
        const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);

        let totalScrollableHeight = 0;
        let maxScrollY = 0;

        if (mode === 'msa') {
            totalScrollableHeight = (dataToUse.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
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
        if (!displayedMSA) return;
        const { scrollableAreaHeight } = getScrollableAreaDimensions(canvasHeight);
        const totalScrollableHeight = (displayedMSA.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
        const maxScroll = Math.max(0, totalScrollableHeight - scrollableAreaHeight);
        scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
    }

    function clampScrollLeft(canvasWidth, charWidth) {
        if (!displayedMSA) return;
        let scrollableAreaX = 0;
        if (msaViewMode === 'msa') {
            scrollableAreaX = NAME_COLUMN_WIDTH;
        } else if (msaViewMode === 'pssm') {
            scrollableAreaX = CHAR_WIDTH;
        } else if (msaViewMode === 'logo') {
            scrollableAreaX = Y_AXIS_WIDTH;
        }

        const scrollableAreaWidth = canvasWidth - scrollableAreaX - (msaViewMode === 'msa' ? SCROLLBAR_WIDTH : 0);
        const totalContentWidth = displayedMSA.queryLength * charWidth;
        const maxScrollLeft = Math.max(0, totalContentWidth - scrollableAreaWidth);
        scrollLeft = Math.max(0, Math.min(scrollLeft, maxScrollLeft));
    }

    function getVisibleSequenceRange(canvasHeight) {
        if (!displayedMSA || !msaCanvasData) return { start: 0, end: 0 };
        const { scrollableAreaHeight } = getScrollableAreaDimensions(canvasHeight);
        clampScrollTop(canvasHeight);
        const startSequenceIndex = Math.max(1, Math.floor(scrollTop / SEQUENCE_ROW_HEIGHT));
        const visibleRows = Math.ceil(scrollableAreaHeight / SEQUENCE_ROW_HEIGHT);
        // Minimal buffer - just 1 sequence above and 2 below for smooth edges
        const topBuffer = 1;
        const bottomBuffer = 2;
        const start = Math.max(1, startSequenceIndex - topBuffer);
        const endSequenceIndex = Math.min(displayedMSA.sequences.length, startSequenceIndex + visibleRows + bottomBuffer);
        return { start: start, end: endSequenceIndex };
    }

    function drawTickMarks(ctx, logicalWidth, scrollLeft, charWidth, scrollableAreaX, minX, maxX, tickY = 0) {
        if (!displayedMSA) return;
        const tickRowHeight = TICK_ROW_HEIGHT;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, tickY, logicalWidth, tickRowHeight);

        const visibleStartPos = Math.floor(scrollLeft / charWidth);
        const visibleEndPos = Math.min(displayedMSA.queryLength, visibleStartPos + Math.ceil((maxX - minX) / charWidth) + 1);

        // Use filtered residueNumbers from displayedMSA if available, otherwise fall back to global positionToResidueMap
        const residueNumbers = displayedMSA.residueNumbers || positionToResidueMap;

        let xOffset = scrollableAreaX - (scrollLeft % charWidth);
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < displayedMSA.queryLength; pos++) {
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
    function computePositionToResidueMapping(chainId, querySequence = null) {
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
        if (!msaEntry) return null;

        // Use provided querySequence or fall back to stored MSA data
        const msaQuerySequence = querySequence || msaEntry.displayedMSA?.querySequence;
        if (!msaQuerySequence) return null;

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
    function drawQuerySequence(ctx, logicalWidth, queryY, queryRowHeight, querySeq, scrollLeft, scrollableAreaX, visibleStartPos, visibleEndPos, labelWidth, totalWidth, drawUnderline = true, charWidth = CHAR_WIDTH) {
        if (!displayedMSA || !querySeq) return;

        // Draw white background, but don't cover the y-axis area (start from labelWidth)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(labelWidth, queryY, logicalWidth - labelWidth, queryRowHeight);

        const minX = labelWidth;
        const maxX = logicalWidth;
        let xOffset = scrollableAreaX - (scrollLeft % charWidth);

        for (let pos = visibleStartPos; pos < visibleEndPos && pos < querySeq.sequence.length; pos++) {
            if (xOffset + charWidth < minX) {
                xOffset += charWidth;
                continue;
            }
            if (xOffset >= maxX) break;

            const aa = querySeq.sequence[pos];
            const color = getDayhoffColor(aa);
            let r = color.r, g = color.g, b = color.b;

            // Apply dimming if position not selected
            const isSelected = !displayedMSA.selectionMask || displayedMSA.selectionMask[pos];
            if (!isSelected) {
                const dimFactor = 0.4;
                r = Math.floor(r + (255 - r) * (1 - dimFactor));
                g = Math.floor(g + (255 - g) * (1 - dimFactor));
                b = Math.floor(b + (255 - b) * (1 - dimFactor));
            }

            if (xOffset + charWidth >= minX && xOffset < maxX) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(minX, queryY, maxX - minX, queryRowHeight);
                ctx.clip();

                ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                ctx.fillRect(xOffset, queryY, charWidth, queryRowHeight);

                ctx.fillStyle = isSelected ? '#000' : '#999';
                ctx.font = '10px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(aa, xOffset + charWidth / 2, queryY + queryRowHeight / 2);

                ctx.restore();
            }

            xOffset += charWidth;
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
        if (!displayedMSA) return;

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
     * Build selection mask for MSA positions
     * Marks which positions are selected (true) vs dimmed (false)
     * @param {Object} sourceMSAData - Original MSA data
     * @param {Array<string>} chains - Array of chain IDs that map to this MSA
     * @param {Map<string, Set<number>>} msaSelectedPositions - Map of chainId -> Set of selected MSA positions
     * @returns {Object} - MSA data with selectionMask array
     */
    function buildSelectionMask(sourceMSAData, chains, msaSelectedPositions) {
        if (!sourceMSAData || !sourceMSAData.sequences || sourceMSAData.sequences.length === 0) {
            return sourceMSAData;
        }

        const queryLength = sourceMSAData.queryLength || sourceMSAData.querySequence?.length || 0;
        const selectionMask = new Array(queryLength);

        // If null or undefined, all positions are selected (default mode)
        if (msaSelectedPositions === null || msaSelectedPositions === undefined) {
            selectionMask.fill(true);
        } else if (msaSelectedPositions.size === 0) {
            // Empty Map - dim everything (Hide All was clicked)
            selectionMask.fill(false);
        } else {
            // Check each position - show if at least one chain has it selected
            for (let pos = 0; pos < queryLength; pos++) {
                if (!chains || chains.length === 0) {
                    selectionMask[pos] = true;
                    continue;
                }

                let isSelected = false;
                for (const chainId of chains) {
                    const chainSelected = msaSelectedPositions.get(chainId);
                    if (chainSelected && chainSelected.has(pos)) {
                        isSelected = true;
                        break; // Early exit optimization
                    }
                }
                selectionMask[pos] = isSelected;
            }
        }

        return {
            ...sourceMSAData,
            selectionMask
        };
    }

    // filterBySelectedPositions() removed - now only using dim mode

    // ============================================================================
    // RENDERERS (Mode-Specific Drawing)
    // ============================================================================

    function renderMSACanvas() {
        if (!msaCanvasData || !displayedMSA) return;

        const { canvas, ctx } = msaCanvasData;
        if (!canvas || !ctx) return;

        const { logicalWidth, logicalHeight } = getLogicalCanvasDimensions(canvas);
        clearCanvas(ctx, logicalWidth, logicalHeight);

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
        const visibleEndPos = Math.min(displayedMSA.queryLength, visibleStartPos + Math.ceil(scrollableAreaWidth / MSA_CHAR_WIDTH) + 1);

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
        // null = all selected (no dimming), Map = selection data, undefined = not initialized
        const { positions: msaSelectedPositions, chains: chainsForMSA } = getSelectionState();

        // Label rendering options
        const labelOptions = {
            padding: 8,
            fontSize: 12,
            fontFamily: 'monospace',
            textColor: '#333'
        };

        // Draw labels for visible sequences (same visibility as sequences - can go under query and tick bar)
        for (let i = visibleSequenceStart; i < visibleSequenceEnd && i < displayedMSA.sequences.length; i++) {
            if (i === 0) continue; // Skip query (drawn separately)

            const seq = displayedMSA.sequences[i];
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
                let r = color.r, g = color.g, b = color.b;

                // Apply dimming if this position is not selected
                const dimFactor = 0.3;
                const isSelected = !displayedMSA.selectionMask || displayedMSA.selectionMask[pos];
                if (!isSelected) {
                    r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
                    g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
                    b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
                }

                // Draw cell with clipping
                if (xOffset + MSA_CHAR_WIDTH >= minX && xOffset < maxX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(minX, scrollableAreaY, maxX - minX, scrollableAreaHeight);
                    ctx.clip();

                    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                    ctx.fillRect(xOffset, y, MSA_CHAR_WIDTH, SEQUENCE_ROW_HEIGHT);

                    ctx.fillStyle = '#000';
                    ctx.globalAlpha = isSelected ? 1.0 : 0.4; // Dim text too
                    ctx.fillText(aa, xOffset + halfCharWidth, y + halfRowHeight);
                    ctx.globalAlpha = 1.0;

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
        if (displayedMSA.sequences.length > 0) {
            const querySeq = displayedMSA.sequences[0];

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
                let r = color.r, g = color.g, b = color.b;

                // Apply dimming if this position is not selected
                const dimFactor = 0.3;
                const isSelected = !displayedMSA.selectionMask || displayedMSA.selectionMask[pos];
                if (!isSelected) {
                    r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
                    g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
                    b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
                }

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
                    ctx.globalAlpha = isSelected ? 1.0 : 0.4; // Dim text too
                    ctx.fillText(aa, xOffset + MSA_CHAR_WIDTH / 2, queryY + queryRowHeight / 2);
                    ctx.globalAlpha = 1.0;

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
        if (!msaCanvasData || !displayedMSA) return;

        // Calculate scrollable content dimensions
        const totalScrollableHeight = (displayedMSA.sequences.length - 1) * SEQUENCE_ROW_HEIGHT;
        const MSA_CHAR_WIDTH = getCharWidthForMode('msa');
        const totalScrollableWidth = displayedMSA.queryLength * MSA_CHAR_WIDTH;

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
        if (displayedMSA && displayedMSA.queryLength > 0) {
            const visibleStartPos = Math.floor(scrollLeft / MSA_CHAR_WIDTH);
            const visibleEndPos = Math.min(displayedMSA.queryLength, visibleStartPos + Math.ceil(scrollableAreaWidth / MSA_CHAR_WIDTH));
            const positionText = `${visibleStartPos + 1}-${visibleEndPos} / ${displayedMSA.queryLength}`;

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

    function computePositionFrequencies() {
        if (!displayedMSA) return null;

        // Check if already computed and stored in displayedMSA
        if (displayedMSA.frequencies) {
            return displayedMSA.frequencies;
        }

        const frequencies = [];
        const queryLength = displayedMSA.queryLength;
        const numSequences = displayedMSA.sequences.length;

        // Amino acid code mapping to array index
        const aaCodeMap = {
            'A': 0, 'R': 1, 'N': 2, 'D': 3, 'C': 4, 'Q': 5, 'E': 6, 'G': 7, 'H': 8,
            'I': 9, 'L': 10, 'K': 11, 'M': 12, 'F': 13, 'P': 14, 'S': 15, 'T': 16,
            'W': 17, 'Y': 18, 'V': 19
        };
        const aaCodes = ['A', 'R', 'N', 'D', 'C', 'Q', 'E', 'G', 'H', 'I', 'L', 'K', 'M', 'F', 'P', 'S', 'T', 'W', 'Y', 'V'];

        // Pre-extract all sequence strings to avoid repeated property access
        const sequenceStrings = new Array(numSequences);
        const sequenceLengths = new Uint16Array(numSequences);
        for (let seqIdx = 0; seqIdx < numSequences; seqIdx++) {
            const seqStr = displayedMSA.sequences[seqIdx].sequence;
            sequenceStrings[seqIdx] = seqStr;
            sequenceLengths[seqIdx] = seqStr.length;
        }

        // Character code lookup table for fast AA code mapping
        const charCodeToAACode = new Int8Array(128);
        charCodeToAACode.fill(-1);
        charCodeToAACode[65] = 0; charCodeToAACode[97] = 0;  // A/a
        charCodeToAACode[82] = 1; charCodeToAACode[114] = 1; // R/r
        charCodeToAACode[78] = 2; charCodeToAACode[110] = 2; // N/n
        charCodeToAACode[68] = 3; charCodeToAACode[100] = 3; // D/d
        charCodeToAACode[67] = 4; charCodeToAACode[99] = 4;  // C/c
        charCodeToAACode[81] = 5; charCodeToAACode[113] = 5; // Q/q
        charCodeToAACode[69] = 6; charCodeToAACode[101] = 6; // E/e
        charCodeToAACode[71] = 7; charCodeToAACode[103] = 7; // G/g
        charCodeToAACode[72] = 8; charCodeToAACode[104] = 8; // H/h
        charCodeToAACode[73] = 9; charCodeToAACode[105] = 9; // I/i
        charCodeToAACode[76] = 10; charCodeToAACode[108] = 10; // L/l
        charCodeToAACode[75] = 11; charCodeToAACode[107] = 11; // K/k
        charCodeToAACode[77] = 12; charCodeToAACode[109] = 12; // M/m
        charCodeToAACode[70] = 13; charCodeToAACode[102] = 13; // F/f
        charCodeToAACode[80] = 14; charCodeToAACode[112] = 14; // P/p
        charCodeToAACode[83] = 15; charCodeToAACode[115] = 15; // S/s
        charCodeToAACode[84] = 16; charCodeToAACode[116] = 16; // T/t
        charCodeToAACode[87] = 17; charCodeToAACode[119] = 17; // W/w
        charCodeToAACode[89] = 18; charCodeToAACode[121] = 18; // Y/y
        charCodeToAACode[86] = 19; charCodeToAACode[118] = 19; // V/v

        for (let pos = 0; pos < queryLength; pos++) {
            // Use typed array for counts (faster than object)
            const counts = new Uint32Array(20);
            let total = 0;

            // Count amino acids at this position - optimized inner loop
            for (let seqIdx = 0; seqIdx < numSequences; seqIdx++) {
                if (pos < sequenceLengths[seqIdx]) {
                    const charCode = sequenceStrings[seqIdx].charCodeAt(pos);
                    // Fast lookup: skip gaps (45='-') and X (88='X', 120='x')
                    if (charCode !== 45 && charCode !== 88 && charCode !== 120) {
                        const code = charCodeToAACode[charCode];
                        if (code >= 0) {
                            counts[code]++;
                            total++;
                        }
                    }
                }
            }

            // Build frequency object
            const freq = {};
            const invTotal = total > 0 ? 1 / total : 0;
            for (let i = 0; i < 20; i++) {
                if (counts[i] > 0) {
                    freq[aaCodes[i]] = counts[i] * invTotal;
                }
            }
            frequencies.push(freq);
        }

        // Store in displayedMSA for persistence
        displayedMSA.frequencies = frequencies;

        return frequencies;
    }

    function computeLogOddsScores(frequencies) {
        if (!frequencies) return null;

        // Check if already computed and stored in displayedMSA
        if (displayedMSA && displayedMSA.logOdds) {
            return displayedMSA.logOdds;
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

        // Store in displayedMSA for persistence
        if (displayedMSA) {
            displayedMSA.logOdds = logOdds;
        }
        return logOdds;
    }


    function renderPSSMCanvas() {
        if (!pssmCanvasData || !displayedMSA) return;

        const { canvas, ctx } = pssmCanvasData;
        if (!canvas || !ctx) return;

        const { logicalWidth, logicalHeight } = getLogicalCanvasDimensions(canvas);
        clearCanvas(ctx, logicalWidth, logicalHeight);

        const frequencies = computePositionFrequencies();
        if (!frequencies) return;

        const queryRowHeight = CHAR_WIDTH;
        const GAP_HEIGHT = 0;
        const { scrollableAreaX, scrollableAreaY, scrollableAreaWidth, scrollableAreaHeight } =
            getScrollableAreaForMode('pssm', logicalWidth, logicalHeight);

        const LABEL_WIDTH = CHAR_WIDTH * 0.5; // Labels are 1/2 width for PSSM
        const boxWidth = CHAR_WIDTH * 0.5; // Boxes are 1/2 width
        const visibleStartPos = Math.floor(scrollLeft / boxWidth);
        const visibleEndPos = Math.min(frequencies.length, visibleStartPos + Math.ceil(scrollableAreaWidth / boxWidth) + 1);

        const tickMinX = LABEL_WIDTH;
        const tickMaxX = logicalWidth;
        drawTickMarks(ctx, logicalWidth, scrollLeft, boxWidth, LABEL_WIDTH, tickMinX, tickMaxX);

        const queryY = TICK_ROW_HEIGHT;
        const heatmapY = scrollableAreaY + GAP_HEIGHT;

        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        // Use scaled row height from canvas data if available
        const aaRowHeight = pssmCanvasData.aaRowHeight || SEQUENCE_ROW_HEIGHT;
        const heatmapHeight = NUM_AMINO_ACIDS * aaRowHeight;

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

        // Draw heatmap (boxes are 1/2 width and height)
        let xOffset = heatmapX - (scrollLeft % boxWidth);
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < frequencies.length; pos++) {
            if (xOffset + boxWidth < heatmapX) {
                xOffset += boxWidth;
                continue;
            }
            if (xOffset >= maxX) break;

            const posData = frequencies[pos];

            // Check if position is selected for dimming
            const dimFactor = 0.3;
            const isSelected = !displayedMSA.selectionMask || displayedMSA.selectionMask[pos];

            for (let i = 0; i < NUM_AMINO_ACIDS; i++) {
                const aa = AMINO_ACIDS_ORDERED[i];
                const probability = posData[aa] || 0;
                const y = heatmapY + i * aaRowHeight;

                const white = { r: 255, g: 255, b: 255 };
                const darkBlue = { r: 0, g: 0, b: 139 };
                let finalR = Math.round(white.r + (darkBlue.r - white.r) * probability);
                let finalG = Math.round(white.g + (darkBlue.g - white.g) * probability);
                let finalB = Math.round(white.b + (darkBlue.b - white.b) * probability);

                // Apply dimming if this position is not selected
                if (!isSelected) {
                    finalR = Math.round(finalR * dimFactor + 255 * (1 - dimFactor));
                    finalG = Math.round(finalG * dimFactor + 255 * (1 - dimFactor));
                    finalB = Math.round(finalB * dimFactor + 255 * (1 - dimFactor));
                }

                if (xOffset + boxWidth >= heatmapX && xOffset < maxX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(heatmapX, heatmapY, maxX - heatmapX, heatmapHeight);
                    ctx.clip();

                    ctx.fillStyle = `rgb(${finalR}, ${finalG}, ${finalB})`;
                    ctx.fillRect(xOffset, y, boxWidth, aaRowHeight);

                    ctx.restore();
                }
            }

            xOffset += boxWidth;
        }

        // Draw black boxes around wildtype (boxes are 1/2 width and height)
        const querySeqForBoxes = displayedMSA.sequences.length > 0 ? displayedMSA.sequences[0].sequence : '';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        let boxXOffset = heatmapX - (scrollLeft % boxWidth);
        for (let pos = visibleStartPos; pos < visibleEndPos && pos < frequencies.length; pos++) {
            if (boxXOffset + boxWidth < heatmapX) {
                boxXOffset += boxWidth;
                continue;
            }
            if (boxXOffset >= maxX) break;

            const wildtypeAA = pos < querySeqForBoxes.length ? querySeqForBoxes[pos].toUpperCase() : null;
            if (!wildtypeAA) {
                boxXOffset += boxWidth;
                continue;
            }

            // Apply dimming to wildtype box stroke if position not selected
            const isSelected = !displayedMSA.selectionMask || displayedMSA.selectionMask[pos];
            ctx.strokeStyle = isSelected ? '#000' : '#999';
            ctx.globalAlpha = isSelected ? 1.0 : 0.4;

            const wildtypeIndex = AMINO_ACIDS_ORDERED.indexOf(wildtypeAA);
            if (wildtypeIndex >= 0) {
                const y = heatmapY + wildtypeIndex * aaRowHeight;
                if (boxXOffset + boxWidth >= heatmapX && boxXOffset < maxX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(heatmapX, heatmapY, maxX - heatmapX, heatmapHeight);
                    ctx.clip();

                    ctx.beginPath();
                    ctx.moveTo(boxXOffset, y);
                    ctx.lineTo(boxXOffset + boxWidth, y);
                    ctx.moveTo(boxXOffset, y + aaRowHeight);
                    ctx.lineTo(boxXOffset + boxWidth, y + aaRowHeight);
                    ctx.moveTo(boxXOffset, y);
                    ctx.lineTo(boxXOffset, y + aaRowHeight);
                    ctx.moveTo(boxXOffset + boxWidth, y);
                    ctx.lineTo(boxXOffset + boxWidth, y + aaRowHeight);
                    ctx.stroke();

                    ctx.restore();
                }
            }

            ctx.globalAlpha = 1.0; // Reset alpha after each position
            boxXOffset += boxWidth;
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

        // Draw query sequence on top (boxes are 1/2 width, align with heatmap)
        if (displayedMSA.sequences.length > 0) {
            const querySeq = displayedMSA.sequences[0];
            // Use heatmapX instead of scrollableAreaX to ensure perfect alignment with heatmap boxes
            drawQuerySequence(ctx, logicalWidth, queryY, queryRowHeight, querySeq, scrollLeft, heatmapX, visibleStartPos, visibleEndPos, LABEL_WIDTH, pssmCanvasData.totalWidth, true, boxWidth);
        }

        // Draw horizontal scrollbar (boxes are 1/2 width)
        const totalScrollableWidth = displayedMSA.queryLength * boxWidth;
        drawHorizontalScrollbar(ctx, logicalWidth, logicalHeight, scrollableAreaX, scrollableAreaWidth, LABEL_WIDTH, totalScrollableWidth);
    }

    function renderLogoCanvas() {
        if (!logoCanvasData || !displayedMSA) return;

        const { canvas, ctx } = logoCanvasData;
        if (!canvas || !ctx) return;

        const { logicalWidth, logicalHeight } = getLogicalCanvasDimensions(canvas);
        clearCanvas(ctx, logicalWidth, logicalHeight);

        const frequencies = computePositionFrequencies();
        if (!frequencies) return;

        const data = useBitScore
            ? computeLogOddsScores(frequencies)
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
        // Use scaled logo height from canvas data if available
        const originalLogoHeight = logoCanvasData.originalLogoHeight || (NUM_AMINO_ACIDS * CHAR_WIDTH * 0.5);

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

            // Check if position is selected for dimming
            const dimFactor = 0.3;
            const isSelected = !displayedMSA.selectionMask || displayedMSA.selectionMask[pos];

            // Start from bottom (queryY) and stack upward - extend all the way to query with no gap
            let yOffset = queryY;

            for (const aa of aas) {
                const height = letterHeights[aa];
                const isProbabilitiesMode = !useBitScore;
                const shouldDraw = isProbabilitiesMode ? true : height > 1;
                const drawHeight = isProbabilitiesMode && height > 0 && height < 0.5 ? 0.5 : height;

                if (shouldDraw && drawHeight > 0) {
                    const color = getDayhoffColor(aa);
                    let r = color.r, g = color.g, b = color.b;

                    // Apply dimming if this position is not selected
                    if (!isSelected) {
                        r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
                        g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
                        b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
                    }

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
        if (displayedMSA.sequences.length > 0) {
            const querySeq = displayedMSA.sequences[0];
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
        const totalScrollableWidth = displayedMSA.queryLength * CHAR_WIDTH;
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
                // Recalculate scroll limits dynamically (in case displayedMSA.sequences.length changed during filtering)
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
                // Recalculate scroll limits dynamically (in case displayedMSA.queryLength changed during filtering)
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

    // Helper: Get canvas data for a specific mode
    function getCanvasDataForMode(mode) {
        if (mode === 'msa') return msaCanvasData;
        if (mode === 'pssm') return pssmCanvasData;
        if (mode === 'logo') return logoCanvasData;
        if (mode === 'coverage') return coverageCanvasData;
        return null;
    }

    // Helper: Set visibility for all canvas containers based on current mode
    function setCanvasVisibility(currentMode) {
        if (msaCanvasData?.container) {
            msaCanvasData.container.style.display = currentMode === 'msa' ? 'block' : 'none';
        }
        if (pssmCanvasData?.container) {
            pssmCanvasData.container.style.display = currentMode === 'pssm' ? 'block' : 'none';
        }
        if (logoCanvasData?.container) {
            logoCanvasData.container.style.display = currentMode === 'logo' ? 'block' : 'none';
        }
        if (coverageCanvasData?.container) {
            coverageCanvasData.container.style.display = currentMode === 'coverage' ? 'block' : 'none';
        }
    }

    // Helper: Ensure dimensions are valid, using fallback if needed
    function ensureValidDimensions(dimensions, fallback) {
        let { canvasWidth, canvasHeight } = dimensions;
        if (canvasWidth <= 0 || canvasHeight <= 0) {
            const fb = fallback || getContainerDimensions();
            canvasWidth = Math.max(1, fb.width || MIN_CANVAS_WIDTH);
            canvasHeight = Math.max(1, fb.height || 450);
            dimensions.canvasWidth = canvasWidth;
            dimensions.canvasHeight = canvasHeight;
        }
        return dimensions;
    }

    // Helper: Clamp value to minimum
    function clampMin(value, min) {
        return Math.max(min, value);
    }

    // Helper: Ensure positive value
    function ensurePositive(value) {
        return Math.max(1, value);
    }

    // Helper: Create canvas element with proper sizing
    function createCanvasElement(contentWidth, height, dpiMultiplier) {
        const canvas = document.createElement('canvas');
        canvas.width = ensurePositive(Math.floor(contentWidth * dpiMultiplier));
        canvas.height = ensurePositive(Math.floor(height * dpiMultiplier));
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'auto';
        canvas.style.cursor = 'default';
        return canvas;
    }

    // Helper: Create canvas container element
    function createCanvasContainer(width, height) {
        const container = document.createElement('div');
        container.className = 'msa-canvas';
        container.style.position = 'relative';
        container.style.overflow = 'hidden';
        container.style.display = 'block';
        container.style.visibility = 'visible';
        container.style.width = width + 'px';
        container.style.height = height + 'px';
        return container;
    }

    // Helper: Create resize handle element
    function createResizeHandle() {
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle';
        return resizeHandle;
    }

    // Helper: Recalculate scale factors for PSSM and Logo modes
    function recalculateScaleFactors(mode, height, canvasData) {
        if (mode === 'pssm') {
            const queryRowHeight = CHAR_WIDTH;
            const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
            const baseAaRowHeight = SEQUENCE_ROW_HEIGHT;
            const baseHeatmapHeight = NUM_AMINO_ACIDS * baseAaRowHeight;
            const fixedElementsHeight = TICK_ROW_HEIGHT + queryRowHeight + SCROLLBAR_WIDTH;
            const availableHeatmapHeight = ensurePositive(height - fixedElementsHeight);
            const pssmScaleFactor = availableHeatmapHeight / baseHeatmapHeight;
            const aaRowHeight = baseAaRowHeight * pssmScaleFactor;
            canvasData.pssmScaleFactor = pssmScaleFactor;
            canvasData.aaRowHeight = aaRowHeight;
        } else if (mode === 'logo') {
            const queryRowHeight = CHAR_WIDTH;
            const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
            const LOGO_VERTICAL_PADDING = 12;
            const baseLogoHeight = NUM_AMINO_ACIDS * CHAR_WIDTH * 0.5;
            const fixedElementsHeight = LOGO_VERTICAL_PADDING + queryRowHeight + TICK_ROW_HEIGHT + SCROLLBAR_WIDTH;
            const availableLogoHeight = ensurePositive(height - fixedElementsHeight);
            const logoScaleFactor = availableLogoHeight / baseLogoHeight;
            const originalLogoHeight = baseLogoHeight * logoScaleFactor;
            canvasData.logoScaleFactor = logoScaleFactor;
            canvasData.originalLogoHeight = originalLogoHeight;
        }
    }

    // Render function map for mode-based rendering (lazy initialization)
    function getRenderFunction(mode) {
        if (mode === 'msa' && typeof renderMSACanvas === 'function') return renderMSACanvas;
        if (mode === 'pssm' && typeof renderPSSMCanvas === 'function') return renderPSSMCanvas;
        if (mode === 'logo' && typeof renderLogoCanvas === 'function') return renderLogoCanvas;
        if (mode === 'coverage' && typeof renderCoverageCanvas === 'function') return renderCoverageCanvas;
        return null;
    }

    function createViewCanvas(mode, config) {
        const DEFAULT_CONTAINER_PADDING = 12;
        const { viewElementId, calculateDimensions, additionalCanvasData } = config;
        const hasCustomPadding = typeof config.contentPadding === 'number' && Number.isFinite(config.contentPadding);
        const resolvedPadding = Math.max(0, hasCustomPadding ? config.contentPadding : DEFAULT_CONTAINER_PADDING);

        const viewEl = document.getElementById(viewElementId);
        if (!viewEl) {
            console.warn('MSA Viewer: View element not found');
            return null;
        }
        if (!displayedMSA) {
            console.warn('MSA Viewer: No MSA data available');
            return null;
        }

        // Check if canvas already exists for this mode - reuse if possible
        const existing = getCanvasDataForMode(mode);
        if (existing?.canvas?.parentElement) {
            // Reuse existing canvas, just update dimensions
            setCanvasVisibility(mode);
            existing.container.style.visibility = 'visible';

            const dimensions = ensureValidDimensions(calculateDimensions());
            const { canvasWidth, canvasHeight } = dimensions;

            // Canvas already exists, return it
            return {
                canvas: existing.canvas,
                container: existing.container,
                canvasData: existing,
                dimensions: { ...dimensions, canvasWidth, canvasHeight }
            };
        }

        // New canvas - ensure stage is visible and positioned before calculating dimensions
        viewEl.classList.remove('hidden');
        viewEl.style.position = viewEl.style.position || 'relative';

        // Force layout recalculation to ensure stage has dimensions BEFORE clearing
        void viewEl.offsetHeight; // Force reflow

        // Calculate dimensions BEFORE clearing (stage still has content/height)
        const dimensions = ensureValidDimensions(calculateDimensions());
        const { canvasWidth, canvasHeight, totalWidth, totalHeight } = dimensions;

        // Clear only canvases for this mode, not all canvases
        // This preserves canvases for other modes
        const existingForThisMode = getCanvasDataForMode(mode);
        const parentEl = viewEl.parentElement || viewEl;

        if (existingForThisMode?.container?.parentElement) {
            // Remove only the canvas for this mode if it exists
            existingForThisMode.container.parentElement.removeChild(existingForThisMode.container);
        }
        // Also remove any orphaned canvas containers (safety check)
        // Containers are appended to parentEl, so search there
        const existingContainers = parentEl.querySelectorAll('.msa-canvas');
        existingContainers.forEach(container => {
            // Only remove if it's not associated with any canvas data
            const isOrphaned = !Array.from(container.querySelectorAll('canvas')).some(canvas => {
                return (msaCanvasData?.canvas === canvas) ||
                    (pssmCanvasData?.canvas === canvas) ||
                    (logoCanvasData?.canvas === canvas) ||
                    (coverageCanvasData?.canvas === canvas);
            });
            if (isOrphaned) {
                container.parentElement?.removeChild(container);
            }
        });

        // Create canvas container - ensure minimum width of 974px (default from CSS)
        const minWidth = MIN_CANVAS_WIDTH;
        const finalWidth = clampMin(canvasWidth > 0 ? canvasWidth : minWidth, minWidth);
        const container = createCanvasContainer(finalWidth, canvasHeight);
        if (mode) {
            container.dataset.mode = mode;
            container.classList.add(`msa-canvas--${mode}`);
        }
        container.style.padding = `${resolvedPadding}px`;

        // Create canvas element - account for padding (2 * resolvedPadding)
        const paddingToSubtract = resolvedPadding * 2;
        const minContentWidth = Math.max(1, minWidth - paddingToSubtract);
        const canvasContentWidth = Math.max(minContentWidth, finalWidth - paddingToSubtract);
        const canvas = createCanvasElement(canvasContentWidth, canvasHeight, DPI_MULTIPLIER);

        container.appendChild(canvas);
        container.appendChild(createResizeHandle());

        // Append canvas container outside the buttons container (as sibling)
        (viewEl.parentElement || viewEl).appendChild(container);

        // Set visibility for all canvases
        setCanvasVisibility(mode);

        const canvasData = {
            canvas,
            ctx: canvas.getContext('2d'),
            container,
            totalWidth,
            contentPadding: resolvedPadding,
            ...(totalHeight !== undefined && { totalHeight }),
            ...(additionalCanvasData || {})
        };
        canvasData.ctx.scale(DPI_MULTIPLIER, DPI_MULTIPLIER);

        // Setup resize observer to update canvas when container is resized
        if (window.ResizeObserver) {
            const resizeObserver = new ResizeObserver(entries => {
                for (const entry of entries) {
                    const { width, height } = entry.contentRect;
                    if (width > 0 && height > 0) {
                        // Update canvas backing store to match container size
                        const newCanvasWidth = ensurePositive(Math.floor(width * DPI_MULTIPLIER));
                        const newCanvasHeight = ensurePositive(Math.floor(height * DPI_MULTIPLIER));

                        if (canvas.width !== newCanvasWidth || canvas.height !== newCanvasHeight) {
                            canvas.width = newCanvasWidth;
                            canvas.height = newCanvasHeight;
                            // Get fresh context after resize
                            canvasData.ctx = canvas.getContext('2d');
                            canvasData.ctx.scale(DPI_MULTIPLIER, DPI_MULTIPLIER);

                            // Ensure canvas CSS fills container
                            canvas.style.width = '100%';
                            canvas.style.height = '100%';

                            // Recalculate scale factors for PSSM and Logo modes
                            recalculateScaleFactors(mode, height, canvasData);

                            // For coverage mode, recalculate sequence row height based on new height
                            if (mode === 'coverage' && canvasData.sequencesWithIdentity) {
                                const COVERAGE_LINE_HEIGHT = canvasData.COVERAGE_LINE_HEIGHT || 30;
                                const TICK_ROW_HEIGHT_COVERAGE = canvasData.TICK_ROW_HEIGHT_COVERAGE || 20;
                                const numSequences = canvasData.numSequences || canvasData.sequencesWithIdentity.length;
                                const availableHeatmapHeight = height - COVERAGE_LINE_HEIGHT - TICK_ROW_HEIGHT_COVERAGE;
                                canvasData.sequenceRowHeight = Math.max(0.5, availableHeatmapHeight / numSequences);
                            }

                            // Invalidate cached scroll extents and clamp to new bounds
                            if (activeInteractionManager) {
                                activeInteractionManager._invalidateCache();
                            }
                            const charWidth = getCharWidthForMode(mode);
                            if (mode !== 'coverage') {
                                clampScrollLeft(width, charWidth);
                                clampScrollTop(height);
                            }

                            // Re-render the canvas
                            const renderFn = getRenderFunction(mode);
                            if (renderFn) renderFn();
                        }
                    }
                }
            });
            resizeObserver.observe(container);
            // Store observer for cleanup if needed
            canvasData.resizeObserver = resizeObserver;
        }

        return { canvas, container, canvasData, dimensions };
    }

    // ============================================================================
    // VIEW BUILDERS (Mode-Specific Setup)
    // ============================================================================

    function buildMSAView() {
        const MSA_CHAR_WIDTH = getCharWidthForMode('msa');
        const totalWidth = NAME_COLUMN_WIDTH + (displayedMSA.queryLength * MSA_CHAR_WIDTH);
        const totalHeight = (displayedMSA.sequences.length + 1) * SEQUENCE_ROW_HEIGHT;

        // Calculate canvas dimensions
        const { width: containerWidth, height: containerHeight } = getContainerDimensions();

        const result = createViewCanvas('msa', {
            viewElementId: 'msa-buttons',
            calculateDimensions: () => ({
                canvasWidth: containerWidth,
                canvasHeight: containerHeight,
                totalWidth: totalWidth,
                totalHeight: totalHeight
            })
        });

        if (!result) return;

        const { canvas, canvasData } = result;
        msaCanvasData = canvasData;

        // Ensure canvas is visible when reusing
        if (canvasData.container) {
            canvasData.container.style.display = 'block';
            canvasData.container.style.visibility = 'visible';
        }

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

        // Always render - even if canvas was reused, ensure it's drawn
        renderMSACanvas();
    }

    function buildPSSMView() {
        const LABEL_WIDTH = CHAR_WIDTH * 0.5; // Labels are 1/2 width for PSSM
        const boxWidth = CHAR_WIDTH * 0.5; // Boxes are 1/2 width
        const totalWidth = LABEL_WIDTH + (displayedMSA.queryLength * boxWidth);
        const { width: containerWidth } = getContainerDimensions();
        const canvasWidth = Math.max(MIN_CANVAS_WIDTH, containerWidth);

        // DYNAMIC HEIGHT for PSSM mode - scale based on container height
        const queryRowHeight = CHAR_WIDTH;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const baseAaRowHeight = SEQUENCE_ROW_HEIGHT; // Base height for MSA characters
        const baseHeatmapHeight = NUM_AMINO_ACIDS * baseAaRowHeight;

        // Get container height for scaling
        const { height: containerHeight } = getContainerDimensions();

        // Calculate available height for heatmap
        const fixedElementsHeight = TICK_ROW_HEIGHT + queryRowHeight + SCROLLBAR_WIDTH;
        const availableHeatmapHeight = containerHeight ?
            ensurePositive(containerHeight - fixedElementsHeight) :
            baseHeatmapHeight;

        // Calculate scale factor, but never let rows shrink below MSA character height
        const pssmScaleFactor = Math.max(1, availableHeatmapHeight / baseHeatmapHeight);
        const aaRowHeight = baseAaRowHeight * pssmScaleFactor;
        const heatmapHeight = NUM_AMINO_ACIDS * aaRowHeight;
        const canvasHeight = TICK_ROW_HEIGHT + queryRowHeight + heatmapHeight + SCROLLBAR_WIDTH;

        const result = createViewCanvas('pssm', {
            viewElementId: 'msa-buttons',
            calculateDimensions: () => ({
                canvasWidth: canvasWidth,
                canvasHeight: canvasHeight,
                totalWidth: totalWidth
            }),
            additionalCanvasData: {
                canvasWidth: containerWidth,
                totalHeight: canvasHeight,
                pssmScaleFactor: pssmScaleFactor,
                aaRowHeight: aaRowHeight
            }
        });

        if (!result) return;

        const { canvas, container, canvasData } = result;
        pssmCanvasData = canvasData;

        clampScrollLeft(result.dimensions.canvasWidth, boxWidth);

        // Cleanup previous interaction manager if exists
        if (activeInteractionManager) {
            activeInteractionManager.cleanup();
        }

        // Setup interaction manager with PSSM-specific configuration
        const interactionConfig = {
            charWidth: boxWidth, // Use boxWidth for scrolling
            supportsVerticalScroll: false,
            getScrollableArea: (w, h) => getScrollableAreaForMode('pssm', w, h),
            getScrollLimits: (w, h) => getScrollLimitsForMode('pssm', boxWidth, w, h)
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

                if (position >= 0 && position < displayedMSA.queryLength &&
                    aaIndex >= 0 && aaIndex < NUM_AMINO_ACIDS) {

                    const frequencies = computePositionFrequencies();
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
        const totalWidth = LABEL_WIDTH + (displayedMSA.queryLength * CHAR_WIDTH);
        const { width: containerWidth } = getContainerDimensions();
        const canvasWidth = Math.max(MIN_CANVAS_WIDTH, containerWidth);

        // DYNAMIC HEIGHT for Logo mode - scale based on container height
        // Layout: Logo at top (extends to query), black bar above query, query sequence below, tick marks below query, scrollbar at bottom
        const queryRowHeight = CHAR_WIDTH;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const LOGO_VERTICAL_PADDING = 12;
        const baseLogoHeight = NUM_AMINO_ACIDS * CHAR_WIDTH * 0.5; // Base logo height is 1/2 the size

        // Get container height for scaling
        const msaHeader = document.getElementById('msaHeader');
        const headerHeight = msaHeader ? msaHeader.offsetHeight + 8 : 40; // header + margin
        const { height: containerHeight } = getContainerDimensions();

        // Calculate available height for logo
        const fixedElementsHeight = LOGO_VERTICAL_PADDING + queryRowHeight + TICK_ROW_HEIGHT + SCROLLBAR_WIDTH;
        const availableLogoHeight = containerHeight ?
            (containerHeight - headerHeight - fixedElementsHeight) :
            baseLogoHeight;

        // Calculate scale factor
        const logoScaleFactor = availableLogoHeight / baseLogoHeight;
        const originalLogoHeight = baseLogoHeight * logoScaleFactor;
        const logoStartY = LOGO_VERTICAL_PADDING;
        const queryY = logoStartY + originalLogoHeight; // Logo extends all the way to query with no gap
        const tickY = queryY + queryRowHeight;
        const canvasHeight = tickY + TICK_ROW_HEIGHT + SCROLLBAR_WIDTH;

        const result = createViewCanvas('logo', {
            viewElementId: 'msa-buttons',
            calculateDimensions: () => ({
                canvasWidth: canvasWidth,
                canvasHeight: canvasHeight,
                totalWidth: totalWidth
            }),
            additionalCanvasData: {
                canvasWidth: containerWidth,
                totalHeight: canvasHeight,
                logoScaleFactor: logoScaleFactor,
                originalLogoHeight: originalLogoHeight
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

    function padOrTruncateSequence(sequence, targetLength) {
        let normalized = sequence || '';
        if (normalized.length > targetLength) {
            normalized = normalized.slice(0, targetLength);
        } else if (normalized.length < targetLength) {
            normalized = normalized.padEnd(targetLength, '-');
        }
        return normalized;
    }

    function computeCoverageDataset() {
        if (!displayedMSA || !Array.isArray(displayedMSA.sequences) || displayedMSA.sequences.length === 0) {
            return null;
        }

        // Initialize cache on sourceMSA if not present
        if (sourceMSA && !sourceMSA._coverageCache) {
            sourceMSA._coverageCache = {
                displayedMSA: null,
                dataset: null
            };
        }

        // Return cached result if displayedMSA hasn't changed
        if (sourceMSA && sourceMSA._coverageCache &&
            sourceMSA._coverageCache.displayedMSA === displayedMSA) {
            return sourceMSA._coverageCache.dataset;
        }

        const querySequence = displayedMSA.querySequence || '';
        const queryLength = displayedMSA.queryLength || querySequence.length;
        if (!queryLength) return null;

        const normalizedQuery = padOrTruncateSequence(querySequence, queryLength);

        const selectionMask = displayedMSA.selectionMask;

        const sequencesWithIdentity = displayedMSA.sequences.map((seq, index) => {
            const normalizedSequence = padOrTruncateSequence(seq.sequence || '', queryLength);
            const identity = computeSequenceIdentity(normalizedSequence, normalizedQuery, selectionMask);
            return {
                ...seq,
                sequence: normalizedSequence,
                identity,
                _originalIndex: index
            };
        });

        sequencesWithIdentity.sort((a, b) => {
            const aIsQuery = a.name && isQuerySequence(a.name);
            const bIsQuery = b.name && isQuerySequence(b.name);
            if (aIsQuery && !bIsQuery) return -1;
            if (!aIsQuery && bIsQuery) return 1;
            if (b.identity === a.identity) {
                return (a._originalIndex ?? 0) - (b._originalIndex ?? 0);
            }
            return b.identity - a.identity;
        });

        const coveragePerPosition = new Array(queryLength).fill(0);
        for (const seq of sequencesWithIdentity) {
            const sequenceString = seq.sequence;
            for (let i = 0; i < queryLength; i++) {
                if (!isGapResidue(sequenceString[i])) {
                    coveragePerPosition[i]++;
                }
            }
            delete seq._originalIndex;
        }

        const result = {
            sequencesWithIdentity,
            coveragePerPosition,
            queryLength,
            residueNumbers: displayedMSA.residueNumbers
                ? [...displayedMSA.residueNumbers]
                : null
        };

        // Cache the result on sourceMSA
        if (sourceMSA && sourceMSA._coverageCache) {
            sourceMSA._coverageCache.displayedMSA = displayedMSA;
            sourceMSA._coverageCache.dataset = result;
        }

        return result;
    }

    // Helper function to apply filters and update view
    // This preserves selection state
    function applyFiltersAndRender() {
        if (!sourceMSA) return;

        // Get selection data and chain mappings
        const { positions: msaSelectedPositions, chains: chainsForMSA } = getSelectionState();

        const oldSequenceCount = displayedMSA ? displayedMSA.sequences.length : 0;

        // Apply unified filtering pipeline
        displayedMSA = computeFilteredMSA(sourceMSA, {
            selectedPositions: msaSelectedPositions,
            chains: chainsForMSA,
            minCoverage: minCoverageThreshold,
            minIdentity: minIdentityThreshold,
            shouldSort: shouldSortByIdentity
        });

        positionToResidueMap = displayedMSA.residueNumbers || null;

        const newSequenceCount = displayedMSA.sequences.length;
        if (oldSequenceCount > 0 && newSequenceCount !== oldSequenceCount) {
            let canvasHeight = 400;
            if (msaCanvasData && msaCanvasData.canvas) {
                canvasHeight = msaCanvasData.canvas.height / DPI_MULTIPLIER;
            }
            clampScrollTop(canvasHeight);
        }

        // Invalidate interaction manager cache (scroll limits depend on sequences.length)
        if (activeInteractionManager) {
            activeInteractionManager._invalidateCache();
        }

        // Notify callback that filtered MSA has changed
        if (callbacks.onMSAFilterChange) {
            callbacks.onMSAFilterChange(displayedMSA, activeChainId);
        }

        // Render the current mode
        const canvasDataMap = {
            'msa': msaCanvasData,
            'pssm': pssmCanvasData,
            'logo': logoCanvasData,
            'coverage': coverageCanvasData
        };

        const canvasData = canvasDataMap[msaViewMode];
        if (canvasData && canvasData.canvas) {
            scheduleRender();
        } else {
            buildViewForMode(msaViewMode);
        }
    }

    function buildCoverageView() {
        const dataset = computeCoverageDataset();
        if (!dataset) {
            if (!displayedMSA) {
                console.warn('MSA Viewer: displayedMSA is not set');
            } else if (!Array.isArray(displayedMSA.sequences)) {
                console.warn('MSA Viewer: displayedMSA.sequences is not an array:', displayedMSA.sequences);
            } else if (displayedMSA.sequences.length === 0) {
                console.warn('MSA Viewer: All sequences were filtered out for coverage view. Consider lowering coverage/identity filter thresholds.');
            } else if (!displayedMSA.queryLength && !displayedMSA.querySequence?.length) {
                console.warn('MSA Viewer: Query sequence has no length');
            } else {
                console.warn('MSA Viewer: Unknown issue preventing coverage view build');
            }
            return;
        }

        const stageDimensions = getMSAStageDimensions();
        const { width: containerWidth, height: containerHeight } = getContainerDimensions();
        const canvasWidth = Math.max(MIN_CANVAS_WIDTH, stageDimensions?.width || containerWidth || 0);
        const canvasHeight = containerHeight > 150 ? containerHeight : DEFAULT_COVERAGE_HEIGHT;
        const AXIS_LABEL_HEIGHT = 32;
        const Y_AXIS_LABEL_WIDTH = 55;

        const result = createViewCanvas('coverage', {
            viewElementId: 'msa-buttons',
            contentPadding: 0,
            calculateDimensions: () => ({
                canvasWidth,
                canvasHeight
            }),
            additionalCanvasData: {
                axisLabelHeight: AXIS_LABEL_HEIGHT,
                yAxisLabelWidth: Y_AXIS_LABEL_WIDTH
            }
        });

        if (!result) return;

        const { canvas, container, canvasData } = result;
        container.classList.add('msa-canvas--coverage');
        if (canvas) {
            canvas.style.borderRadius = 'var(--radius-lg)';
        }

        coverageCanvasData = canvasData;

        if (activeInteractionManager) {
            activeInteractionManager.cleanup();
            activeInteractionManager = null;
        }

        renderCoverageCanvas();
    }

    function renderCoverageCanvas() {
        if (!coverageCanvasData || !displayedMSA) return;

        const { canvas, ctx } = coverageCanvasData;
        if (!canvas || !ctx) return;

        // Build dataset from current displayedMSA (like logo mode does with computePositionFrequencies)
        const coverageState = computeCoverageDataset();
        if (!coverageState) return;

        const { sequencesWithIdentity, coveragePerPosition, queryLength, residueNumbers } = coverageState;
        if (!sequencesWithIdentity || sequencesWithIdentity.length === 0 || !queryLength) return;

        const { logicalWidth, logicalHeight } = getLogicalCanvasDimensions(canvas);
        if (logicalWidth <= 0 || logicalHeight <= 0) return;

        const axisLabelHeight = coverageCanvasData.axisLabelHeight || 32;
        const yAxisLabelWidth = coverageCanvasData.yAxisLabelWidth || 40;
        const numSequences = sequencesWithIdentity.length;

        const topPadding = 20;
        const rightPadding = 65; // Space for colorbar and labels with extra padding
        const plotX = yAxisLabelWidth;
        const plotY = topPadding;
        const plotWidth = Math.max(10, logicalWidth - plotX - rightPadding);
        const heatmapHeight = Math.max(40, logicalHeight - axisLabelHeight - topPadding);
        const rowHeight = heatmapHeight / Math.max(1, numSequences);
        const charWidth = plotWidth / queryLength;
        if (!Number.isFinite(charWidth) || charWidth <= 0) return;

        clearCanvas(ctx, logicalWidth, logicalHeight);

        const SCALE_BOOST_X = 2;
        const SCALE_BOOST_Y = 2;
        const heatmapPixelWidth = Math.max(1, Math.round(plotWidth * SCALE_BOOST_X));
        const heatmapPixelHeight = Math.max(1, Math.round(heatmapHeight * SCALE_BOOST_Y));
        const charWidthPixels = heatmapPixelWidth / queryLength;
        const rowHeightPixels = heatmapPixelHeight / Math.max(1, numSequences);

        const imageData = ctx.createImageData(heatmapPixelWidth, heatmapPixelHeight);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = 255;
        }

        const colorCache = sequencesWithIdentity.map(seq => getCoverageColor(seq.identity));
        const dimFactor = 0.3;

        for (let pos = 0; pos < queryLength; pos++) {
            const pixelXStart = Math.max(0, Math.floor(pos * charWidthPixels));
            const pixelXEnd = (pos === queryLength - 1)
                ? heatmapPixelWidth
                : Math.max(pixelXStart + 1, Math.floor((pos + 1) * charWidthPixels));

            // Check if position is selected for dimming
            const isSelected = !displayedMSA.selectionMask || displayedMSA.selectionMask[pos];

            for (let seqIdx = 0; seqIdx < numSequences; seqIdx++) {
                const residue = sequencesWithIdentity[seqIdx].sequence[pos];
                if (isGapResidue(residue)) continue;

                const pixelYStart = Math.max(0, Math.floor(seqIdx * rowHeightPixels));
                const pixelYEnd = (seqIdx === numSequences - 1)
                    ? heatmapPixelHeight
                    : Math.max(pixelYStart + 1, Math.floor((seqIdx + 1) * rowHeightPixels));

                const rgb = colorCache[seqIdx];
                let r = rgb[0], g = rgb[1], b = rgb[2];

                // Apply dimming if this position is not selected
                if (!isSelected) {
                    r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
                    g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
                    b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
                }

                for (let py = pixelYStart; py < pixelYEnd; py++) {
                    const rowOffset = py * heatmapPixelWidth;
                    for (let px = pixelXStart; px < pixelXEnd; px++) {
                        const idx = (rowOffset + px) * 4;
                        data[idx] = r;
                        data[idx + 1] = g;
                        data[idx + 2] = b;
                        data[idx + 3] = 255;
                    }
                }
            }
        }

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = heatmapPixelWidth;
        offscreenCanvas.height = heatmapPixelHeight;
        const offscreenCtx = offscreenCanvas.getContext('2d');
        offscreenCtx.putImageData(imageData, 0, 0);

        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
            offscreenCanvas,
            0,
            0,
            heatmapPixelWidth,
            heatmapPixelHeight,
            plotX,
            plotY,
            plotWidth,
            heatmapHeight
        );
        ctx.restore();

        const maxCoverage = Math.max(numSequences, 1);
        const normalizeCount = (value) => value / maxCoverage;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        coveragePerPosition.forEach((value, pos) => {
            const x = pos === queryLength - 1 ? plotX + plotWidth : plotX + (pos * charWidth) + (charWidth / 2);
            const normalized = normalizeCount(value);
            const y = plotY + heatmapHeight - (normalized * heatmapHeight);
            if (pos === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();

        const tickBaseY = plotY + heatmapHeight + 2;
        ctx.fillStyle = '#000000';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // X-axis ticks: roughly every 32 pixels using "nice numbers"
        const targetPixelSpacing = 32;
        const approxNumTicks = Math.max(1, Math.floor(plotWidth / targetPixelSpacing));

        // Find the max residue number
        const maxTickValue = residueNumbers && residueNumbers.length > 0
            ? Math.max(...residueNumbers.filter(n => n !== null && n !== undefined))
            : queryLength;

        // Calculate nice tick interval (Excel-style: 1, 2, 5, 10, 20, 50, 100, ...)
        const rawInterval = maxTickValue / approxNumTicks;
        const magnitude = Math.pow(10, Math.floor(Math.log10(rawInterval)));
        const normalized = rawInterval / magnitude; // between 1 and 10

        let niceFactor;
        if (normalized <= 1) niceFactor = 1;
        else if (normalized <= 2) niceFactor = 2;
        else if (normalized <= 5) niceFactor = 5;
        else niceFactor = 10;

        const tickInterval = niceFactor * magnitude;

        // Draw ticks at multiples of the interval
        for (let pos = 0; pos < queryLength; pos++) {
            let tickValue = pos + 1; // Default: 1-based position

            // Use residue number if available
            if (residueNumbers && pos < residueNumbers.length) {
                const residueNum = residueNumbers[pos];
                if (residueNum !== null && residueNum !== undefined) {
                    tickValue = residueNum;
                }
            }

            // Show tick if value is a multiple of our interval
            if (tickValue % tickInterval === 0) {
                const x = pos >= queryLength - 1 ? plotX + plotWidth : plotX + (pos + 0.5) * charWidth;
                ctx.fillText(String(tickValue), x, tickBaseY);
            }
        }
        const axisXLine = plotX;
        const axisYLine = plotY + heatmapHeight;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(axisXLine, plotY);
        ctx.lineTo(axisXLine, axisYLine);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(axisXLine, axisYLine);
        ctx.lineTo(plotX + plotWidth, axisYLine);
        ctx.stroke();

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('Positions', plotX + plotWidth / 2, tickBaseY + 12);
        ctx.restore();

        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        // Y-axis ticks: roughly every 16 pixels using "nice numbers"
        const targetYPixelSpacing = 16;
        const approxNumYTicks = Math.max(1, Math.floor(heatmapHeight / targetYPixelSpacing));

        // Calculate nice tick interval (Excel-style: 1, 2, 5, 10, 20, 50, 100, ...)
        const rawYInterval = maxCoverage / approxNumYTicks;
        const yMagnitude = Math.pow(10, Math.floor(Math.log10(rawYInterval)));
        const yNormalized = rawYInterval / yMagnitude; // between 1 and 10

        let yNiceFactor;
        if (yNormalized <= 1) yNiceFactor = 1;
        else if (yNormalized <= 2) yNiceFactor = 2;
        else if (yNormalized <= 5) yNiceFactor = 5;
        else yNiceFactor = 10;

        const yTickInterval = Math.max(1, yNiceFactor * yMagnitude); // Ensure at least 1

        // Generate tick values (only integers)
        const yTickValues = [];
        for (let val = yTickInterval; val <= maxCoverage; val += yTickInterval) {
            if (Number.isInteger(val)) {
                yTickValues.push(val);
            }
        }

        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        yTickValues.forEach(val => {
            const normalized = normalizeCount(val);
            const y = plotY + heatmapHeight - normalized * heatmapHeight;
            ctx.fillText(String(Math.round(val)), plotX - 6, y);
            ctx.beginPath();
            ctx.moveTo(plotX - 6, y);
            ctx.lineTo(plotX - 2, y);
            ctx.stroke();
        });
        ctx.textBaseline = 'middle';
        ctx.fillText('0', plotX - 6, axisYLine);
        ctx.save();
        ctx.translate(15, plotY + heatmapHeight / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('Sequences', 0, -6);
        ctx.restore();

        // Draw colorbar for sequence identity
        const colorbarWidth = 15;
        const colorbarHeight = Math.min(120, heatmapHeight - 24); // Leave space for QID label at top (18px) + bottom padding (6px)
        const colorbarX = plotX + plotWidth + 15; // Symmetric padding from plot edge
        const colorbarSteps = 100;

        // Calculate panel dimensions (includes padding around colorbar and labels)
        const panelPadding = 6;
        const labelWidth = 22; // Space for labels like "100"
        const qidLabelHeight = 12;
        const panelX = colorbarX - panelPadding;
        const panelY = plotY; // Align panel top to bitmap top
        const colorbarY = panelY + qidLabelHeight + panelPadding; // Position colorbar below QID label
        const panelWidth = colorbarWidth + labelWidth + panelPadding * 2;
        const panelHeight = qidLabelHeight + panelPadding + colorbarHeight + panelPadding;

        // Draw panel background with subtle shadow
        ctx.fillStyle = '#f8f8f8';
        ctx.fillRect(panelX + 1, panelY + 1, panelWidth, panelHeight); // Shadow
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(panelX, panelY, panelWidth, panelHeight);

        // Draw panel border
        ctx.strokeStyle = '#d0d0d0';
        ctx.lineWidth = 1;
        ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

        // Draw gradient
        // Draw gradient with clipping to prevent bleed
        ctx.save();
        ctx.beginPath();
        ctx.rect(colorbarX, colorbarY, colorbarWidth, colorbarHeight);
        ctx.clip();
        for (let i = 0; i < colorbarSteps; i++) {
            const identity = 1 - (i / (colorbarSteps - 1)); // Top = 1.0 (blue), bottom = 0.0 (red)
            const rgb = getCoverageColor(identity);
            ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
            const stepHeight = colorbarHeight / colorbarSteps;
            const stepY = colorbarY + i * stepHeight;
            // Draw slightly larger to avoid gaps, clipping handles the overflow
            ctx.fillRect(colorbarX, stepY, colorbarWidth, stepHeight + 1);
        }
        ctx.restore();

        // Draw colorbar border
        ctx.strokeStyle = '#666666';
        ctx.lineWidth = 1;
        ctx.strokeRect(colorbarX, colorbarY, colorbarWidth, colorbarHeight);

        // Draw colorbar labels
        ctx.fillStyle = '#000000';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        const colorbarLabels = [
            { value: 1.0, label: '100' },
            { value: 0.75, label: '75' },
            { value: 0.5, label: '50' },
            { value: 0.25, label: '25' },
            { value: 0.0, label: '0' }
        ];

        colorbarLabels.forEach(({ value, label }) => {
            const labelY = colorbarY + (1 - value) * colorbarHeight;
            ctx.fillText(label, colorbarX + colorbarWidth + 4, labelY);
        });

        // Draw "QID" label at top inside panel
        ctx.fillStyle = '#333333';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('QID', colorbarX + colorbarWidth / 2, panelY + 3);
    }

    // ============================================================================
    // SVG EXPORT HELPERS
    // ============================================================================

    // Render PSSM to any context (canvas or SVG) - full view, no scrolling
    function renderPSSMToContext(ctx, logicalWidth, logicalHeight, forExport) {
        if (!displayedMSA) return;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);

        const frequencies = computePositionFrequencies();
        if (!frequencies) return;

        const queryRowHeight = CHAR_WIDTH;
        const GAP_HEIGHT = 0;
        const { scrollableAreaX, scrollableAreaY } = getScrollableAreaForMode('pssm', logicalWidth, logicalHeight);

        const LABEL_WIDTH = CHAR_WIDTH * 0.5; // Labels are 1/2 width for PSSM
        const queryY = TICK_ROW_HEIGHT;
        const heatmapY = scrollableAreaY + GAP_HEIGHT;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        // Use scaled row height from canvas data if available
        const aaRowHeight = pssmCanvasData ? (pssmCanvasData.aaRowHeight || SEQUENCE_ROW_HEIGHT) : SEQUENCE_ROW_HEIGHT;
        const heatmapHeight = NUM_AMINO_ACIDS * aaRowHeight;
        const heatmapX = LABEL_WIDTH;
        const boxWidth = CHAR_WIDTH * 0.5; // Boxes are 1/2 width
        const totalWidth = LABEL_WIDTH + (displayedMSA.queryLength * boxWidth);

        // For export, render all positions; otherwise use visible range
        const startPos = forExport ? 0 : Math.floor(scrollLeft / boxWidth);
        const endPos = forExport ? frequencies.length : Math.min(frequencies.length, startPos + Math.ceil((logicalWidth - scrollableAreaX) / boxWidth) + 1);
        const xOffsetStart = forExport ? heatmapX : heatmapX - (scrollLeft % boxWidth);

        // Draw tick marks
        if (forExport) {
            // For export, draw all tick marks across full width
            drawTickMarks(ctx, logicalWidth, 0, boxWidth, LABEL_WIDTH, LABEL_WIDTH, logicalWidth);
        } else {
            drawTickMarks(ctx, logicalWidth, scrollLeft, boxWidth, LABEL_WIDTH, LABEL_WIDTH, logicalWidth);
        }

        // Draw labels (1/2 width)
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

                const white = { r: 255, g: 255, b: 255 };
                const darkBlue = { r: 0, g: 0, b: 139 };
                const finalR = Math.round(white.r + (darkBlue.r - white.r) * probability);
                const finalG = Math.round(white.g + (darkBlue.g - white.g) * probability);
                const finalB = Math.round(white.b + (darkBlue.b - white.b) * probability);

                ctx.fillStyle = `rgb(${finalR}, ${finalG}, ${finalB})`;
                ctx.fillRect(xOffset, y, boxWidth, aaRowHeight);
            }

            xOffset += boxWidth;
        }

        // Draw black boxes around wildtype (boxes are 1/2 width and height)
        const querySeqForBoxes = displayedMSA.sequences.length > 0 ? displayedMSA.sequences[0].sequence : '';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        let boxXOffset = xOffsetStart;
        for (let pos = startPos; pos < endPos && pos < frequencies.length; pos++) {
            const wildtypeAA = pos < querySeqForBoxes.length ? querySeqForBoxes[pos].toUpperCase() : null;
            if (wildtypeAA) {
                const wildtypeIndex = AMINO_ACIDS_ORDERED.indexOf(wildtypeAA);
                if (wildtypeIndex >= 0) {
                    const y = heatmapY + wildtypeIndex * aaRowHeight;
                    ctx.strokeRect(boxXOffset, y, boxWidth, aaRowHeight);
                }
            }
            boxXOffset += boxWidth;
        }

        // Draw group boundaries
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        for (const boundaryIdx of DAYHOFF_GROUP_BOUNDARIES) {
            const y = heatmapY + boundaryIdx * aaRowHeight;
            ctx.beginPath();
            ctx.moveTo(heatmapX, y);
            ctx.lineTo(heatmapX + (displayedMSA.queryLength * boxWidth), y);
            ctx.stroke();
        }

        // Draw query sequence (boxes are 1/2 width, align with heatmap)
        if (displayedMSA.sequences.length > 0) {
            const querySeq = displayedMSA.sequences[0];
            // Use heatmapX instead of scrollableAreaX to ensure perfect alignment with heatmap boxes
            drawQuerySequence(ctx, totalWidth, queryY, queryRowHeight, querySeq, 0, heatmapX, 0, frequencies.length, LABEL_WIDTH, totalWidth, false, boxWidth);
        }
    }

    // Render Logo to any context (canvas or SVG) - full view, no scrolling
    function renderLogoToContext(ctx, logicalWidth, logicalHeight, forExport) {
        if (!displayedMSA) return;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);

        const frequencies = computePositionFrequencies();
        if (!frequencies) return;

        const data = useBitScore
            ? computeLogOddsScores(frequencies)
            : frequencies;
        if (!data) return;

        const queryRowHeight = CHAR_WIDTH;
        const { scrollableAreaX, scrollableAreaY } = getScrollableAreaForMode('logo', logicalWidth, logicalHeight);
        const LABEL_WIDTH = Y_AXIS_WIDTH;
        const LOGO_VERTICAL_PADDING = 12;
        const NUM_AMINO_ACIDS = AMINO_ACIDS_ORDERED.length;
        const aaRowHeight = CHAR_WIDTH;
        // Use scaled logo height from canvas data if available
        const originalLogoHeight = logoCanvasData ? (logoCanvasData.originalLogoHeight || (NUM_AMINO_ACIDS * CHAR_WIDTH * 0.5)) : (NUM_AMINO_ACIDS * CHAR_WIDTH * 0.5);
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
        if (displayedMSA.sequences.length > 0) {
            const querySeq = displayedMSA.sequences[0];
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
        setCallbacks: function (cb) {
            callbacks = Object.assign({}, callbacks, cb);
        },

        parseA3M: parseA3M,
        parseFasta: parseFasta,
        parseSTO: parseSTO,

        getMSAData: function () {
            return displayedMSA;
        },

        /**
         * Apply filters to MSA data and return filtered copy
         * This is a utility function that can be used externally to filter any MSA data
         * @param {Object} displayedMSAToFilter - MSA data object to filter
         * @param {number} minCoverageThreshold - Minimum coverage threshold (0-1)
         * @param {number} minIdentityThreshold - Minimum identity threshold (0-1)
         * @returns {Object} - Filtered MSA data object
         */
        applyFiltersToMSA: function (displayedMSAToFilter, minCoverageThreshold, minIdentityThreshold) {
            if (!displayedMSAToFilter || !displayedMSAToFilter.sequences) {
                return null;
            }

            const sequencesToFilter = displayedMSAToFilter.sequencesOriginal || displayedMSAToFilter.sequences;
            let filtered = filterByCoverage(sequencesToFilter, minCoverageThreshold);
            filtered = filterByIdentity(filtered, displayedMSAToFilter.querySequence, minIdentityThreshold);

            return {
                querySequence: displayedMSAToFilter.querySequence,
                queryLength: displayedMSAToFilter.queryLength,
                sequences: filtered,
                sequencesOriginal: displayedMSAToFilter.sequencesOriginal || displayedMSAToFilter.sequences
            };
        },


        setCoverageCutoff: function (cutoff) {
            minCoverageThreshold = clamp01(cutoff);
            applyFiltersAndRender();
        },

        getCoverageCutoff: function () {
            return minCoverageThreshold;
        },

        setPreviewCoverageCutoff: function (cutoff) {
            previewCoverageThreshold = clamp01(cutoff);
        },

        applyPreviewCoverageCutoff: function () {
            this.setCoverageCutoff(previewCoverageThreshold);
        },

        setIdentityCutoff: function (cutoff) {
            minIdentityThreshold = clamp01(cutoff);
            applyFiltersAndRender();
        },

        getIdentityCutoff: function () {
            return minIdentityThreshold;
        },

        setPreviewIdentityCutoff: function (cutoff) {
            previewIdentityThreshold = clamp01(cutoff);
        },

        applyPreviewIdentityCutoff: function () {
            this.setIdentityCutoff(previewIdentityThreshold);
        },

        setMSAData: function (data, chainId = null) {

            // Ensure container lays out header + stage as grid
            (function ensureMSALayout() {
                const container = document.getElementById('msa-viewer-container');
                const stage = document.getElementById('msaView');
                if (!container || !stage) return;
                container.style.display = 'grid';
                container.style.gridTemplateRows = 'auto auto'; // Both auto-size to content
                stage.style.position = 'relative';
            })();

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
            activeChainId = chainId;
            sourceMSA = data;

            // Build residue_numbers mapping from structure if available BEFORE filtering
            // This maps MSA positions to structure residue_numbers values for display
            if (!sourceMSA.residueNumbers) {
                // Build residue_numbers mapping from structure if available
                // Pass the querySequence directly from sourceMSA to avoid circular dependency
                const mapping = computePositionToResidueMapping(chainId, sourceMSA.querySequence);
                if (mapping) {
                    sourceMSA.residueNumbers = mapping;
                }
            }

            // Apply unified filtering pipeline (no selection on initial load)
            const { positions: msaSelectedPositions, chains: chainsForMSA } = getSelectionState();
            displayedMSA = computeFilteredMSA(sourceMSA, {
                selectedPositions: msaSelectedPositions,
                chains: chainsForMSA,
                minCoverage: minCoverageThreshold,
                minIdentity: minIdentityThreshold,
                shouldSort: shouldSortByIdentity
            });

            // Update global position map
            positionToResidueMap = displayedMSA.residueNumbers || null;

            // Copy computed properties from original data if they exist
            if (sourceMSA.frequencies) {
                displayedMSA.frequencies = sourceMSA.frequencies;
            }
            if (sourceMSA.logOdds) {
                displayedMSA.logOdds = sourceMSA.logOdds;
            }

            // Compute properties if not already present (for filtered data, recompute)
            // Compute and store frequencies and logOdds once when MSA is set
            computePositionFrequencies(); // This will compute and store in displayedMSA.frequencies
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

            buildViewForMode(msaViewMode);
        },

        setChain: function (chainId) {
            activeChainId = chainId;
            if (callbacks.getRenderer) {
                const renderer = callbacks.getRenderer();
                if (renderer && renderer.currentObjectName) {
                    const obj = renderer.objectsData[renderer.currentObjectName];
                    if (obj && obj.msa && obj.msa.msasBySequence && obj.msa.chainToSequence) {
                        const querySeq = obj.msa.chainToSequence[chainId];
                        if (querySeq && obj.msa.msasBySequence[querySeq]) {
                            const { displayedMSA } = obj.msa.msasBySequence[querySeq];
                            this.setMSAData(displayedMSA, chainId);
                        }
                    }
                }
            }
        },

        getCurrentChain: function () {
            return activeChainId;
        },

        updateMSAViewSelectionState: function () {
            // Update selection mask for visual dimming only (no filtering)
            if (!sourceMSA || !displayedMSA) {
                return;
            }

            // Get selection data and chain mappings
            const { positions: msaSelectedPositions, chains: chainsForMSA } = getSelectionState();

            // Update only the selection mask in displayedMSA (for dimming)
            const selectionProcessed = buildSelectionMask(displayedMSA, chainsForMSA, msaSelectedPositions);
            displayedMSA.selectionMask = selectionProcessed.selectionMask;

            // Just re-render the current view with updated dimming
            scheduleRender();
        },

        getMSAMode: function () {
            return msaViewMode;
        },

        saveLogoAsSvg: function () {
            if (!logoCanvasData || !logoCanvasData.canvas || !displayedMSA) {
                console.error('Logo canvas or MSA data not available');
                return;
            }

            const canvas = logoCanvasData.canvas;
            const { logicalHeight } = getLogicalCanvasDimensions(canvas);

            // Calculate full width needed for all positions
            const LABEL_WIDTH = Y_AXIS_WIDTH;
            const fullWidth = LABEL_WIDTH + (displayedMSA.queryLength * CHAR_WIDTH);

            // Create SVG context with full width
            const svgCtx = new MSACanvas2SVG(fullWidth, logicalHeight);

            // Render to SVG context (full view, no scrolling)
            renderLogoToContext(svgCtx, fullWidth, logicalHeight, true);

            // Get SVG string and download
            const svgString = svgCtx.getSerializedSvg();
            downloadFile(svgString, 'msa_logo', 'svg', 'image/svg+xml;charset=utf-8');
        },

        savePSSMAsSvg: function () {
            if (!pssmCanvasData || !pssmCanvasData.canvas || !displayedMSA) {
                console.error('PSSM canvas or MSA data not available');
                return;
            }

            const canvas = pssmCanvasData.canvas;
            const { logicalHeight } = getLogicalCanvasDimensions(canvas);

            // Calculate full width needed for all positions
            const LABEL_WIDTH = CHAR_WIDTH;
            const fullWidth = LABEL_WIDTH + (displayedMSA.queryLength * CHAR_WIDTH);

            // Create SVG context with full width
            const svgCtx = new MSACanvas2SVG(fullWidth, logicalHeight);

            // Render to SVG context (full view, no scrolling)
            renderPSSMToContext(svgCtx, fullWidth, logicalHeight, true);

            // Get SVG string and download
            const svgString = svgCtx.getSerializedSvg();
            downloadFile(svgString, 'msa_pssm', 'svg', 'image/svg+xml;charset=utf-8');
        },

        savePSSMAsCsv: function () {
            if (!displayedMSA) {
                console.error('MSA data not available');
                return;
            }

            const frequencies = computePositionFrequencies();
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

        saveMSAAsFasta: function () {
            if (!displayedMSA || !displayedMSA.sequences || displayedMSA.sequences.length === 0) {
                console.error('MSA data not available');
                return;
            }

            // Build FASTA output from currently filtered/visible sequences
            let fasta = '';

            for (const seq of displayedMSA.sequences) {
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

        setMSAMode: function (mode) {
            if (msaViewMode !== mode && displayedMSA) {
                const oldCharWidth = msaViewMode === 'msa' ? CHAR_WIDTH / 2 : CHAR_WIDTH;
                const newCharWidth = mode === 'msa' ? CHAR_WIDTH / 2 : CHAR_WIDTH;
                const charPosition = scrollLeft / oldCharWidth;
                scrollLeft = charPosition * newCharWidth;
            }

            msaViewMode = mode;
            buildViewForMode(mode);

            // Always render after mode switch (even if canvas was reused)
            // Use requestAnimationFrame to ensure DOM updates are complete
            requestAnimationFrame(() => {
                renderForMode(mode);
            });

            // Adjust scroll position after mode switch
            if (displayedMSA) {
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
                } else if (mode === 'coverage' && coverageCanvasData && coverageCanvasData.canvas) {
                    canvasWidth = coverageCanvasData.canvas.width / DPI_MULTIPLIER;
                    scrollableAreaX = Y_AXIS_WIDTH;
                    charWidth = CHAR_WIDTH;
                }

                if (canvasWidth > 0) {
                    const scrollableAreaWidth = canvasWidth - scrollableAreaX - (mode === 'msa' ? SCROLLBAR_WIDTH : 0);
                    const totalScrollableWidth = displayedMSA.queryLength * charWidth;
                    const maxScrollX = Math.max(0, totalScrollableWidth - scrollableAreaWidth);
                    const oldScrollLeft = scrollLeft;
                    scrollLeft = Math.max(0, Math.min(maxScrollX, scrollLeft));
                    if (oldScrollLeft !== scrollLeft) {
                        scheduleRender();
                    }
                }
            }
        },

        getUseBitScore: function () {
            return useBitScore;
        },

        setUseBitScore: function (value) {
            useBitScore = value;
            if (msaViewMode === 'logo') {
                scheduleRender();
            }
        },

        getSortSequences: function () {
            return shouldSortByIdentity;
        },

        setSortSequences: function (value) {
            shouldSortByIdentity = value;
            if (sourceMSA) {
                // Use unified filtering pipeline
                applyFiltersAndRender();
            }
        },

        getSequenceCounts: function () {
            const filtered = displayedMSA ? displayedMSA.sequences.length : 0;
            // Use sequencesOriginal for total count (all sequences before any filtering)
            // If sequencesOriginal doesn't exist, fall back to sequences
            const total = sourceMSA
                ? (sourceMSA.sequencesOriginal ? sourceMSA.sequencesOriginal.length : sourceMSA.sequences.length)
                : 0;
            return { filtered, total };
        },

        clear: function () {
            // Cleanup resize observers before clearing data
            if (msaCanvasData?.resizeObserver) {
                msaCanvasData.resizeObserver.disconnect();
            }
            if (pssmCanvasData?.resizeObserver) {
                pssmCanvasData.resizeObserver.disconnect();
            }
            if (logoCanvasData?.resizeObserver) {
                logoCanvasData.resizeObserver.disconnect();
            }
            if (coverageCanvasData?.resizeObserver) {
                coverageCanvasData.resizeObserver.disconnect();
            }

            // Remove containers from DOM
            const containers = document.querySelectorAll('.msa-canvas');
            containers.forEach(container => {
                if (container.parentElement) {
                    container.parentElement.removeChild(container);
                }
            });

            displayedMSA = null;
            sourceMSA = null;
            msaCanvasData = null;
            pssmCanvasData = null;
            logoCanvasData = null;
            coverageCanvasData = null;

            // Reset state variables to initial values
            activeChainId = null;
        },

        buildMSAView: buildMSAView,
        buildPSSMView: buildPSSMView,
        buildLogoView: buildLogoView,
        computeMSAProperties: computeMSAProperties,
        extractSubset: extractMSASubset
    };

    // ============================================================================
    // MOVED LOGIC FROM APP.JS AND VIEWER-MOL.JS
    // ============================================================================

    function computeMSAProperties(msaData, selectionMask = null) {
        if (!msaData || !msaData.sequences || msaData.sequences.length === 0) return;

        const queryLength = msaData.queryLength;
        const numSequences = msaData.sequences.length;

        // Use selectionMask from msaData if not provided
        if (!selectionMask && msaData.selectionMask) {
            selectionMask = msaData.selectionMask;
        }
        const frequencies = msaData.frequencies || [];

        // Amino acid code mapping to array index (A=0, R=1, N=2, D=3, C=4, Q=5, E=6, G=7, H=8, I=9, L=10, K=11, M=12, F=13, P=14, S=15, T=16, W=17, Y=18, V=19)
        const aaCodeMap = {
            'A': 0, 'R': 1, 'N': 2, 'D': 3, 'C': 4, 'Q': 5, 'E': 6, 'G': 7, 'H': 8,
            'I': 9, 'L': 10, 'K': 11, 'M': 12, 'F': 13, 'P': 14, 'S': 15, 'T': 16,
            'W': 17, 'Y': 18, 'V': 19
        };
        // Reverse mapping: array index to amino acid code
        const aaCodes = ['A', 'R', 'N', 'D', 'C', 'Q', 'E', 'G', 'H', 'I', 'L', 'K', 'M', 'F', 'P', 'S', 'T', 'W', 'Y', 'V'];

        // Compute frequencies
        if (!msaData.frequencies) {
            // Pre-extract all sequence strings to avoid repeated property access
            const sequenceStrings = new Array(numSequences);
            const sequenceLengths = new Uint16Array(numSequences);
            for (let seqIdx = 0; seqIdx < numSequences; seqIdx++) {
                const seqStr = msaData.sequences[seqIdx].sequence;
                sequenceStrings[seqIdx] = seqStr;
                sequenceLengths[seqIdx] = seqStr.length;
            }

            // Pre-allocate arrays
            if (!msaData.frequencies) {
                for (let pos = 0; pos < queryLength; pos++) {
                    frequencies.push({});
                }
            }

            // Character code lookup table for fast AA code mapping (ASCII: A=65, Z=90, a=97, z=122)
            // Maps char codes directly to array indices, -1 for invalid
            const charCodeToAACode = new Int8Array(128);
            charCodeToAACode.fill(-1);
            charCodeToAACode[65] = 0;  // A
            charCodeToAACode[97] = 0;  // a
            charCodeToAACode[82] = 1;  // R
            charCodeToAACode[114] = 1; // r
            charCodeToAACode[78] = 2;  // N
            charCodeToAACode[110] = 2; // n
            charCodeToAACode[68] = 3;  // D
            charCodeToAACode[100] = 3; // d
            charCodeToAACode[67] = 4;  // C
            charCodeToAACode[99] = 4;  // c
            charCodeToAACode[81] = 5;  // Q
            charCodeToAACode[113] = 5; // q
            charCodeToAACode[69] = 6;  // E
            charCodeToAACode[101] = 6; // e
            charCodeToAACode[71] = 7;  // G
            charCodeToAACode[103] = 7; // g
            charCodeToAACode[72] = 8;  // H
            charCodeToAACode[104] = 8; // h
            charCodeToAACode[73] = 9;  // I
            charCodeToAACode[105] = 9; // i
            charCodeToAACode[76] = 10; // L
            charCodeToAACode[108] = 10; // l
            charCodeToAACode[75] = 11; // K
            charCodeToAACode[107] = 11; // k
            charCodeToAACode[77] = 12; // M
            charCodeToAACode[109] = 12; // m
            charCodeToAACode[70] = 13; // F
            charCodeToAACode[102] = 13; // f
            charCodeToAACode[80] = 14; // P
            charCodeToAACode[112] = 14; // p
            charCodeToAACode[83] = 15; // S
            charCodeToAACode[115] = 15; // s
            charCodeToAACode[84] = 16; // T
            charCodeToAACode[116] = 16; // t
            charCodeToAACode[87] = 17; // W
            charCodeToAACode[119] = 17; // w
            charCodeToAACode[89] = 18; // Y
            charCodeToAACode[121] = 18; // y
            charCodeToAACode[86] = 19; // V
            charCodeToAACode[118] = 19; // v

            // Compute frequencies for ALL positions (dimming happens during rendering, not computation)
            const resultFrequencies = [];

            for (let pos = 0; pos < queryLength; pos++) {
                // Use typed array for counts (faster than object)
                const counts = new Uint32Array(20);
                let total = 0;

                // Count amino acids at this position - optimized inner loop
                for (let seqIdx = 0; seqIdx < numSequences; seqIdx++) {
                    if (pos < sequenceLengths[seqIdx]) {
                        const charCode = sequenceStrings[seqIdx].charCodeAt(pos);
                        // Fast lookup: skip gaps (45='-') and X (88='X', 120='x')
                        if (charCode !== 45 && charCode !== 88 && charCode !== 120) {
                            const code = charCodeToAACode[charCode];
                            if (code >= 0) {
                                counts[code]++;
                                total++;
                            }
                        }
                    }
                }

                // Build frequency object
                const freq = {};
                const invTotal = total > 0 ? 1 / total : 0;

                for (let i = 0; i < 20; i++) {
                    if (counts[i] > 0) {
                        const p = counts[i] * invTotal;
                        freq[aaCodes[i]] = p;
                    }
                }

                resultFrequencies.push(freq);
            }

            msaData.frequencies = resultFrequencies;
        }

        // Compute entropy from frequencies (if frequencies exist and entropy not already computed)
        if (msaData.frequencies && !msaData.entropy) {
            const maxEntropy = Math.log2(20); // Maximum entropy for 20 amino acids
            const entropyValues = [];

            // Compute entropy for ALL positions (frequencies array contains all positions)
            for (let i = 0; i < msaData.frequencies.length; i++) {
                const freq = msaData.frequencies[i];
                if (!freq) {
                    entropyValues.push(0);
                    continue;
                }

                // Calculate Shannon entropy: H = -Σ(p_i * log2(p_i))
                let entropy = 0;
                for (const aa in freq) {
                    const p = freq[aa];
                    if (p > 0) {
                        entropy -= p * Math.log2(p);
                    }
                }

                // Normalize by max entropy (0 to 1 scale)
                const normalizedEntropy = entropy / maxEntropy;
                entropyValues.push(normalizedEntropy);
            }

            msaData.entropy = entropyValues;
        }
    }

    /**
     * Extract MSA data for selected positions
     * Maps structure positions to MSA positions and extracts only selected MSA regions
     * @param {Object} sourceObject - Original object with MSA data
     * @param {Object} extractedObject - New extracted object
     * @param {Object} frame - Frame data for mapping
     * @param {Array} selectedIndices - Array of selected position indices
     */
    function extractMSASubset(sourceObject, extractedObject, frame, selectedIndices) {
        if (!sourceObject.msa || !sourceObject.msa.msasBySequence || !sourceObject.msa.chainToSequence) {
            return;
        }

        const selectedPositionsSet = new Set(selectedIndices);
        const extractedFrame = extractedObject.frames[0];
        if (!extractedFrame || !extractedFrame.chains) {
            return;
        }

        // Initialize MSA structure for extracted object
        extractedObject.msa = {
            msasBySequence: {},
            chainToSequence: {},
            availableChains: [],
            defaultChain: null,
            msaToChains: {}
        };

        // Check if extractChainSequences is available (from global window)
        const extractChainSequences = typeof window !== 'undefined' && typeof window.extractChainSequences === 'function'
            ? window.extractChainSequences
            : null;

        if (!extractChainSequences) {
            console.warn("extractChainSequences not available, cannot extract MSA data");
            return;
        }

        // Extract chain sequences from extracted frame
        const extractedChainSequences = extractChainSequences(extractedFrame);

        // For each chain in the original MSA
        for (const [chainId, querySeq] of Object.entries(sourceObject.msa.chainToSequence)) {
            const msaEntry = sourceObject.msa.msasBySequence[querySeq];
            if (!msaEntry) continue;

            // Use msaData directly - it is now always the canonical unfiltered source
            // (We no longer mutate msaEntry.msaData with filtered data)
            const originalMSAData = msaEntry.msaData;
            if (!originalMSAData) continue;

            const originalQuerySequence = originalMSAData.querySequence; // Query sequence has no gaps (removed during parsing)

            // Extract chain sequence from original frame
            const originalChainSequences = extractChainSequences(frame);
            const originalChainSequence = originalChainSequences[chainId];
            if (!originalChainSequence) continue;

            // Find representative positions for this chain in original frame (position_types === 'P')
            const chainPositions = [];
            const positionCount = frame.chains.length;

            for (let i = 0; i < positionCount; i++) {
                if (frame.chains[i] === chainId && frame.position_types && frame.position_types[i] === 'P') {
                    chainPositions.push(i);
                }
            }

            if (chainPositions.length === 0) continue;

            // Sort positions by residue number to match sequence order
            chainPositions.sort((a, b) => {
                const residueNumA = frame.residue_numbers ? frame.residue_numbers[a] : a;
                const residueNumB = frame.residue_numbers ? frame.residue_numbers[b] : b;
                return residueNumA - residueNumB;
            });

            // Map MSA positions to structure positions and find which MSA positions are selected
            // Query sequence has no gaps, so mapping is straightforward
            const msaQueryUpper = originalQuerySequence.toUpperCase();
            const chainSeqUpper = originalChainSequence.toUpperCase();
            const minLength = Math.min(msaQueryUpper.length, chainSeqUpper.length, chainPositions.length);
            const selectedMSAPositions = new Set(); // MSA position indices that correspond to selected structure positions

            for (let i = 0; i < minLength; i++) {
                // Check if this MSA position matches the chain sequence position
                if (msaQueryUpper[i] === chainSeqUpper[i]) {
                    // Match found - check if this structure position is selected
                    const positionIndex = chainPositions[i];
                    if (selectedPositionsSet.has(positionIndex)) {
                        selectedMSAPositions.add(i); // Store MSA position index
                    }
                }
            }

            if (selectedMSAPositions.size === 0) continue;

            // Extract selected MSA positions from ALL sequences (not filtered by coverage/identity)
            // Use sequencesOriginal to include all sequences, even those hidden by coverage/identity filters
            const allSequences = originalMSAData.sequencesOriginal || originalMSAData.sequences;
            const extractedSequences = [];
            const extractedQuerySequence = [];

            // Extract from query sequence (only selected positions/columns)
            for (let i = 0; i < originalQuerySequence.length; i++) {
                if (selectedMSAPositions.has(i)) {
                    extractedQuerySequence.push(originalQuerySequence[i]);
                }
            }

            // Extract from ALL sequences (including those hidden by coverage/identity filters)
            // But only extract the selected MSA positions (columns)
            for (const seq of allSequences) {
                const extractedSeq = {
                    name: seq.name || 'Unknown',
                    sequence: ''
                };

                // Copy any other properties from the original sequence
                if (seq.id !== undefined) extractedSeq.id = seq.id;
                if (seq.description !== undefined) extractedSeq.description = seq.description;

                // Handle both string and array sequence formats
                const seqStr = Array.isArray(seq.sequence) ? seq.sequence.join('') : seq.sequence;

                // Extract only the selected MSA positions (columns) from this sequence
                for (let i = 0; i < seqStr.length; i++) {
                    if (selectedMSAPositions.has(i)) {
                        extractedSeq.sequence += seqStr[i];
                    }
                }

                extractedSequences.push(extractedSeq);
            }

            // Create new MSA data with extracted sequences (selected positions only, but all sequences)
            const extractedQuerySeq = extractedQuerySequence.join('');
            const extractedQuerySeqNoGaps = extractedQuerySeq.replace(/-/g, '').toUpperCase();

            if (extractedQuerySeqNoGaps.length === 0) continue;

            // Find query sequence in original MSA and extract its name
            // Use sequencesOriginal to find query in all sequences
            let queryName = '>query';
            const originalQueryIndex = originalMSAData.queryIndex !== undefined ? originalMSAData.queryIndex : 0;
            if (allSequences && allSequences[originalQueryIndex]) {
                queryName = allSequences[originalQueryIndex].name || '>query';
            }

            // Ensure query sequence is first and has proper name
            const querySeqIndex = extractedSequences.findIndex(s =>
                s.name && s.name.toLowerCase().includes('query')
            );
            if (querySeqIndex === -1 && extractedSequences.length > 0) {
                // No query found, make first sequence the query
                extractedSequences[0].name = queryName;
            } else if (querySeqIndex > 0) {
                // Query found but not first, move it to first position
                const querySeq = extractedSequences.splice(querySeqIndex, 1)[0];
                extractedSequences.unshift(querySeq);
            }

            // Build residue_numbers mapping for extracted MSA
            // Map extracted MSA positions to extracted structure residue_numbers values
            const extractedResidueNumbers = new Array(extractedQuerySeq.length).fill(null);

            // Get sorted selected indices for THIS CHAIN ONLY to match sequence order
            const selectedIndicesForChain = chainPositions.filter(posIdx => selectedPositionsSet.has(posIdx));
            const sortedSelectedIndicesForChain = selectedIndicesForChain.sort((a, b) => {
                const residueNumA = frame.residue_numbers ? frame.residue_numbers[a] : a;
                const residueNumB = frame.residue_numbers ? frame.residue_numbers[b] : b;
                return residueNumA - residueNumB;
            });

            let extractedSeqIdx = 0; // Position in extracted sequence (no gaps, sorted by residue_numbers)

            // Map extracted MSA positions to extracted structure residue numbers
            for (let i = 0; i < extractedQuerySeq.length; i++) {
                const msaChar = extractedQuerySeq[i];
                if (msaChar === '-') {
                    // Gap - leave as null
                    continue;
                }
                // Find corresponding position in extracted frame (for this chain only)
                if (extractedSeqIdx < sortedSelectedIndicesForChain.length) {
                    const originalPositionIdx = sortedSelectedIndicesForChain[extractedSeqIdx];
                    // Get residue_numbers from original frame
                    if (frame.residue_numbers && originalPositionIdx < frame.residue_numbers.length) {
                        extractedResidueNumbers[i] = frame.residue_numbers[originalPositionIdx];
                    }
                    extractedSeqIdx++;
                }
            }

            const extractedMSAData = {
                sequences: extractedSequences,
                querySequence: extractedQuerySeq,
                queryLength: extractedQuerySeqNoGaps.length,
                sequencesOriginal: extractedSequences, // All sequences included (not filtered by cov/qid)
                queryIndex: 0, // Query is always first after extraction
                residueNumbers: extractedResidueNumbers // Map to structure residue_numbers
            };

            // Compute MSA properties (frequencies, logOdds) for extracted sequences
            computeMSAProperties(extractedMSAData);

            // Check if extracted chain sequence matches the extracted query sequence (no gaps)
            const extractedChainSeq = extractedChainSequences[chainId];
            if (extractedChainSeq && extractedChainSeq.toUpperCase() === extractedQuerySeqNoGaps) {
                // Store MSA in extracted object
                if (!extractedObject.msa.msasBySequence[extractedQuerySeqNoGaps]) {
                    extractedObject.msa.msasBySequence[extractedQuerySeqNoGaps] = {
                        msaData: extractedMSAData,
                        chains: [chainId]
                    };
                }

                extractedObject.msa.chainToSequence[chainId] = extractedQuerySeqNoGaps;

                if (!extractedObject.msa.availableChains.includes(chainId)) {
                    extractedObject.msa.availableChains.push(chainId);
                }

                if (!extractedObject.msa.defaultChain) {
                    extractedObject.msa.defaultChain = chainId;
                }
            }
        }

        // Update MSA container visibility and chain selector after extraction
        if (typeof window !== 'undefined') {
            // Trigger MSA viewer update if available
            if (window.updateMSAContainerVisibility) {
                setTimeout(() => {
                    window.updateMSAContainerVisibility();
                }, 100);
            }
            if (window.updateMSAChainSelectorIndex) {
                setTimeout(() => {
                    window.updateMSAChainSelectorIndex();
                }, 100);
            }
        }

        return extractedObject.msa;
    }


})();
