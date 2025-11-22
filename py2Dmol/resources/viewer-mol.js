// ============================================================================
// GLOBAL REGISTRY
// ============================================================================
// Global registry for all viewer instances
if (!window.py2dmol_viewers) {
    window.py2dmol_viewers = {};
}

// ============================================================================
// SIMPLE CANVAS2SVG FOR PY2DMOL
// ============================================================================
// Minimal canvas2svg implementation for py2Dmol viewer.
// Only supports: lines (moveTo/lineTo/stroke), circles (arc/fill), rectangles (fillRect)

(function () {
    'use strict';

    function SimpleCanvas2SVG(width, height) {
        this.width = width;
        this.height = height;
        this.strokeStyle = '#000000';
        this.fillStyle = '#000000';
        this.lineWidth = 1;
        this.lineCap = 'butt';
        this.currentPath = null;
        this.operations = [];
    }

    // Path operations
    SimpleCanvas2SVG.prototype.beginPath = function () {
        this.currentPath = [];
    };

    SimpleCanvas2SVG.prototype.moveTo = function (x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'M', x: x, y: y });
    };

    SimpleCanvas2SVG.prototype.lineTo = function (x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'L', x: x, y: y });
    };

    SimpleCanvas2SVG.prototype.arc = function (x, y, radius, startAngle, endAngle) {
        if (!this.currentPath) this.beginPath();
        // py2Dmol only uses full circles (0 to 2π)
        this.currentPath.push({ type: 'CIRCLE', x: x, y: y, radius: radius });
    };

    // Drawing operations
    SimpleCanvas2SVG.prototype.stroke = function () {
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
            lineCap: this.lineCap
        });
        this.currentPath = null;
    };

    SimpleCanvas2SVG.prototype.fill = function () {
        if (!this.currentPath || this.currentPath.length === 0) return;

        // Check if single full circle (positions)
        if (this.currentPath.length === 1 && this.currentPath[0].type === 'CIRCLE') {
            const c = this.currentPath[0];
            this.operations.push({
                type: 'circle',
                x: c.x,
                y: c.y,
                radius: c.radius,
                fillStyle: this.fillStyle
            });
        } else {
            // Path fill (shouldn't happen in py2Dmol, but handle it)
            let pathData = '';
            for (let i = 0; i < this.currentPath.length; i++) {
                const cmd = this.currentPath[i];
                if (cmd.type === 'M') pathData += `M ${cmd.x} ${cmd.y} `;
                else if (cmd.type === 'L') pathData += `L ${cmd.x} ${cmd.y} `;
            }
            this.operations.push({
                type: 'fill',
                pathData: pathData.trim(),
                fillStyle: this.fillStyle
            });
        }
        this.currentPath = null;
    };

    SimpleCanvas2SVG.prototype.fillRect = function (x, y, w, h) {
        this.operations.push({
            type: 'rect',
            x: x, y: y, width: w, height: h,
            fillStyle: this.fillStyle
        });
    };

    SimpleCanvas2SVG.prototype.clearRect = function () {
        // Ignore - we add white background in SVG
    };

    // Stub methods (not used in rendering)
    SimpleCanvas2SVG.prototype.save = function () { };
    SimpleCanvas2SVG.prototype.restore = function () { };
    SimpleCanvas2SVG.prototype.scale = function () { };
    SimpleCanvas2SVG.prototype.setTransform = function () { };
    SimpleCanvas2SVG.prototype.translate = function () { };
    SimpleCanvas2SVG.prototype.rotate = function () { };

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
    SimpleCanvas2SVG.prototype.getSerializedSvg = function () {
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">\n`;
        svg += `  <rect width="${this.width}" height="${this.height}" fill="#ffffff"/>\n`;

        for (let i = 0; i < this.operations.length; i++) {
            const op = this.operations[i];
            if (op.type === 'rect') {
                svg += `  <rect x="${op.x}" y="${op.y}" width="${op.width}" height="${op.height}" fill="${rgbToHex(op.fillStyle)}"/>\n`;
            } else if (op.type === 'circle') {
                svg += `  <circle cx="${op.x}" cy="${op.y}" r="${op.radius}" fill="${rgbToHex(op.fillStyle)}"/>\n`;
            } else if (op.type === 'stroke') {
                const cap = op.lineCap === 'round' ? 'round' : 'butt';
                svg += `  <path d="${op.pathData}" stroke="${rgbToHex(op.strokeStyle)}" stroke-width="${op.lineWidth}" stroke-linecap="${cap}" fill="none"/>\n`;
            } else if (op.type === 'fill') {
                svg += `  <path d="${op.pathData}" fill="${rgbToHex(op.fillStyle)}"/>\n`;
            }
        }
        svg += '</svg>';
        return svg;
    };

    // Export as C2S for compatibility with existing code
    if (typeof window !== 'undefined') {
        window.C2S = SimpleCanvas2SVG;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = SimpleCanvas2SVG;
    }

})();

// ============================================================================
// VIEWER INITIALIZATION
// ============================================================================

/**
 * Initializes a py2dmol viewer instance within a specific container.
 * All logic is scoped to this container.
 * @param {HTMLElement} containerElement The root <div> element for this viewer.
 */
function initializePy2DmolViewer(containerElement) {

    // Helper function to normalize ortho value from old (50-200) or new (0-1) format
    function normalizeOrthoValue(value) {
        if (typeof value !== 'number') return 1.0; // Default
        if (value >= 50 && value <= 200) {
            // Old format: convert 50-200 to 0-1
            return (value - 50) / 150;
        }
        if (value >= 0 && value <= 1) {
            // New format: already normalized
            return value;
        }
        return 0.5; // Default if out of range
    }

    // ============================================================================
    // VECTOR MATH
    // ============================================================================
    class Vec3 {
        constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
        add(v) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
        sub(v) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
        mul(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
        dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
        length() { return Math.sqrt(this.dot(this)); }
        distanceTo(v) { return this.sub(v).length(); }
        distanceToSq(v) { const s = this.sub(v); return s.dot(s); }
        normalize() {
            const len = this.length();
            return len > 0 ? this.mul(1 / len) : new Vec3(0, 0, 1);
        }
    }
    function rotationMatrixX(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
    function rotationMatrixY(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
    function multiplyMatrices(a, b) { const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j]; return r; }
    function applyMatrix(m, v) { return new Vec3(m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z, m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z, m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z); }
    function sigmoid(x) { return 0.5 + x / (2 * (1 + Math.abs(x))); }
    // ============================================================================
    // COLOR UTILITIES
    // ============================================================================
    const pymolColors = ["#33ff33", "#00ffff", "#ff33cc", "#ffff00", "#ff9999", "#e5e5e5", "#7f7fff", "#ff7f00", "#7fff7f", "#199999", "#ff007f", "#ffdd5e", "#8c3f99", "#b2b2b2", "#007fff", "#c4b200", "#8cb266", "#00bfbf", "#b27f7f", "#fcd1a5", "#ff7f7f", "#ffbfdd", "#7fffff", "#ffff7f", "#00ff7f", "#337fcc", "#d8337f", "#bfff3f", "#ff7fff", "#d8d8ff", "#3fffbf", "#b78c4c", "#339933", "#66b2b2", "#ba8c84", "#84bf00", "#b24c66", "#7f7f7f", "#3f3fa5", "#a5512b"];
    const colorblindSafeChainColors = ["#4e79a7", "#f28e2c", "#e15759", "#76b7b2", "#59a14f", "#edc949", "#af7aa1", "#ff9da7", "#9c755f", "#bab0ab"]; // Tableau 10
    function hexToRgb(hex) { if (!hex || typeof hex !== 'string') { return { r: 128, g: 128, b: 128 }; } const r = parseInt(hex.slice(1, 3), 16); const g = parseInt(hex.slice(3, 5), 16); const b = parseInt(hex.slice(5, 7), 16); return { r, g, b }; }
    function hsvToRgb(h, s, v) { const c = v * s; const x = c * (1 - Math.abs((h / 60) % 2 - 1)); const m = v - c; let r, g, b; if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; } return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }; }

    // N-term (blue) to C-term (red)
    function getRainbowColor(value, min, max) {
        if (max - min < 1e-6) return hsvToRgb(240, 1.0, 1.0); // Default to blue
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        const hue = 240 * (1 - normalized); // 0 -> 240 (blue), 1 -> 0 (red)
        return hsvToRgb(hue, 1.0, 1.0);
    }

    // 50 (red) to 90 (blue)
    function getPlddtRainbowColor(value, min, max) {
        if (max - min < 1e-6) return hsvToRgb(0, 1.0, 1.0); // Default to red
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        const hue = 240 * normalized; // 0 -> 0 (red), 1 -> 240 (blue)
        return hsvToRgb(hue, 1.0, 1.0);
    }

    // Cividis-like: N-term (blue) to C-term (yellow)
    function getRainbowColor_Colorblind(value, min, max) {
        if (max - min < 1e-6) return hsvToRgb(240, 1.0, 1.0); // Default to blue
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        // Interpolate hue from 240 (Blue) down to 60 (Yellow)
        const hue = 240 - normalized * 180;
        return hsvToRgb(hue, 1.0, 1.0);
    }

    // Cividis-like: 50 (yellow) to 90 (blue)
    function getPlddtRainbowColor_Colorblind(value, min, max) {
        if (max - min < 1e-6) return hsvToRgb(60, 1.0, 1.0); // Default to yellow
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        // Interpolate hue from 60 (Yellow) to 240 (Blue)
        const hue = 60 + normalized * 180;
        return hsvToRgb(hue, 1.0, 1.0);
    }

    function getPlddtColor(plddt) { return getPlddtRainbowColor(plddt, 50, 90); }
    function getPlddtColor_Colorblind(plddt) { return getPlddtRainbowColor_Colorblind(plddt, 50, 90); }

    // Entropy color: low entropy (conserved, blue) to high entropy (variable, red)
    // Entropy values are normalized 0-1, where 0 = conserved, 1 = variable
    function getEntropyColor(entropy) {
        // Clamp entropy to 0-1 range
        const normalized = Math.max(0, Math.min(1, entropy || 0));
        // Low entropy (conserved) -> blue (240), high entropy (variable) -> red (0)
        const hue = 240 * (1 - normalized); // 0 -> 240 (blue), 1 -> 0 (red)
        return hsvToRgb(hue, 1.0, 1.0);
    }

    // Entropy colorblind: low entropy (conserved, blue) to high entropy (yellow)
    function getEntropyColor_Colorblind(entropy) {
        // Clamp entropy to 0-1 range
        const normalized = Math.max(0, Math.min(1, entropy || 0));
        // Low entropy (conserved) -> blue (240), high entropy (variable) -> yellow (60)
        const hue = 240 - normalized * 180; // 240 -> 60 (blue to yellow)
        return hsvToRgb(hue, 1.0, 1.0);
    }

    // AlphaFold pLDDT color scheme (4 categories based on confidence)
    // Based on PyMOL AlphaFold plugin colors
    function getPlddtAFColor(plddt) {
        // DeepMind uses 4 color categories:
        // >= 100: n0 - Very high confidence (blue) [not used, max is typically 100]
        // >= 90:  n1 - High confidence (cyan)
        // >= 70:  n2 - Confident (yellow)
        // >= 50:  n3 - Low confidence (orange)
        // < 50:   n3 - Very low confidence (red) [actually orange-red]

        if (plddt >= 90) {
            // Cyan: [0.416, 0.796, 0.945]
            return { r: Math.round(0.416 * 255), g: Math.round(0.796 * 255), b: Math.round(0.945 * 255) };
        } else if (plddt >= 70) {
            // Yellow: [0.996, 0.851, 0.212]
            return { r: Math.round(0.996 * 255), g: Math.round(0.851 * 255), b: Math.round(0.212 * 255) };
        } else if (plddt >= 50) {
            // Orange: [0.992, 0.490, 0.302]
            return { r: Math.round(0.992 * 255), g: Math.round(0.490 * 255), b: Math.round(0.302 * 255) };
        } else {
            // Red-orange (slightly more red): [1.0, 0.4, 0.2]
            return { r: 255, g: 102, b: 51 };
        }
    }

    // AlphaFold pLDDT color scheme for colorblind mode (uses different colors)
    function getPlddtAFColor_Colorblind(plddt) {
        // Use blue, green, yellow, red for better colorblind accessibility
        if (plddt >= 90) {
            // Blue
            return { r: 0, g: 100, b: 255 };
        } else if (plddt >= 70) {
            // Green
            return { r: 0, g: 200, b: 100 };
        } else if (plddt >= 50) {
            // Yellow
            return { r: 255, g: 255, b: 0 };
        } else {
            // Red
            return { r: 255, g: 0, b: 0 };
        }
    }

    function getChainColor(chainIndex) { if (chainIndex < 0) chainIndex = 0; return hexToRgb(pymolColors[chainIndex % pymolColors.length]); }

    // PAE color functions moved to viewer-pae.js
    // Use window.getPAEColor and window.getPAEColor_Colorblind if available

    // ============================================================================
    // RENDERING CONSTANTS
    // ============================================================================

    // Type-specific baseline multipliers (maintains visual hierarchy)
    const TYPE_BASELINES = {
        'L': 0.4,   // Ligands: thinner baseline
        'P': 1.0,   // Proteins: standard baseline
        'D': 1.6,   // DNA: thicker baseline
        'R': 1.6,   // RNA: thicker baseline
        'C': 0.5    // Contacts: half width of proteins
    };

    // Reference lengths for length normalization (typical segment lengths in Å)
    const REF_LENGTHS = {
        'L': 1.5,   // Typical ligand bond
        'P': 3.8,   // Typical protein CA-CA distance
        'D': 5.9,   // Typical DNA C4'-C4' distance (adjacent nucleotides)
        'R': 5.9    // Typical RNA C4'-C4' distance (adjacent nucleotides)
    };

    // Width calculation parameters
    const ATOM_WIDTH_MULTIPLIER = 0.5;      // Fixed width for positions (zero-length segments)

    // Shadow/tint parameters
    const SHADOW_CUTOFF_MULTIPLIER = 2.0;   // shadow_cutoff = avgLen * 2.0
    const TINT_CUTOFF_MULTIPLIER = 0.5;     // tint_cutoff = avgLen * 0.5
    const SHADOW_OFFSET_MULTIPLIER = 2.5;   // Proportional offset multiplier
    const TINT_OFFSET_MULTIPLIER = 2.5;     // Proportional offset multiplier
    const WIDTH_RATIO_CLAMP_MIN = 0.01;     // Minimum width ratio for shadow/tint
    const WIDTH_RATIO_CLAMP_MAX = 10.0;     // Maximum width ratio for shadow/tint
    const MAX_SHADOW_SUM = 12;              // Maximum accumulated shadow sum (saturating accumulation)

    // ============================================================================
    // PSEUDO-3D RENDERER
    // ============================================================================
    class Pseudo3DRenderer {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');

            // Store screen positions of positions for fast highlight drawing
            // Array of {x, y, radius} for each position index, updated during render()
            // Used by sequence viewer to draw highlights on overlay canvas
            this.positionScreenPositions = null;

            // Unified cutoff for performance optimizations (inertia, caching, grid-based shadows)
            this.LARGE_MOLECULE_CUTOFF = 1000;

            // Store display dimensions (CSS size) for calculations
            // Internal resolution is scaled by devicePixelRatio, but we work in display pixels
            // Initialize cached dimensions (will be updated on resize)
            this.displayWidth = parseInt(canvas.style.width) || canvas.width;
            this.displayHeight = parseInt(canvas.style.height) || canvas.height;

            // Get config from Python
            // This relies on window.viewerConfig being available globally
            const config = window.viewerConfig || {
                size: [300, 300],
                pae_size: 300,
                color: "rainbow",
                shadow: true,
                outline: true,
                width: 3.0,
                rotate: false,
                controls: true,
                autoplay: false,
                box: true,
                pastel: 0.25,
                pae: false,
                colorblind: false,
                depth: false
            };

            // Current render state
            this.coords = []; // This is now an array of Vec3 objects
            this.plddts = [];
            this.chains = [];
            this.positionTypes = [];
            this.entropy = undefined; // Entropy vector mapped to structure positions

            // Viewer state - Color mode: auto, chain, rainbow, plddt, DeepMind, or entropy
            const validModes = ['auto', 'chain', 'rainbow', 'plddt', 'deepmind', 'entropy'];
            this.colorMode = (config.color && validModes.includes(config.color)) ? config.color : 'auto';
            // Ensure it's always valid
            if (!this.colorMode || !validModes.includes(this.colorMode)) {
                this.colorMode = 'auto';
            }

            // What 'auto' resolves to (calculated when data loads)
            this.resolvedAutoColor = 'rainbow';
            this.rotationMatrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            this.zoom = 1.0;
            this.lineWidth = (typeof config.width === 'number') ? config.width : 3.0;
            this.relativeOutlineWidth = 3.0; // Default outline width relative to line width
            this.shadowIntensity = 0.95;
            // Perspective/orthographic projection state
            this.perspectiveEnabled = false; // false = orthographic, true = perspective
            this.focalLength = 200.0; // Will be set by ortho slider based on object size

            // Temporary center and extent for orienting to visible positions
            this.temporaryCenter = null;
            this.temporaryExtent = null;

            // Set defaults from config, with fallback
            this.shadowEnabled = (typeof config.shadow === 'boolean') ? config.shadow : true;
            this.depthEnabled = (typeof config.depth === 'boolean') ? config.depth : false;
            // Outline mode: 'none', 'partial', or 'full'
            if (typeof config.outline === 'string' && ['none', 'partial', 'full'].includes(config.outline)) {
                this.outlineMode = config.outline;
            } else if (typeof config.outline === 'boolean') {
                // Legacy boolean support: true -> 'full', false -> 'none'
                this.outlineMode = config.outline ? 'full' : 'none';
            } else {
                this.outlineMode = 'full'; // Default to full
            }
            this.pastelLevel = (typeof config.pastel === 'number') ? config.pastel : 0.25;
            this.colorblindMode = (typeof config.colorblind === 'boolean') ? config.colorblind : false;

            // Width multipliers are now always based on TYPE_BASELINES (no robust scaling)

            this.isTransparent = false; // Default to white background

            // Performance
            this.chainRainbowScales = {};
            this.perChainIndices = [];
            this.chainIndexMap = new Map(); // Initialize chain index map
            this.ligandOnlyChains = new Set(); // Chains that contain only ligands (no P/D/R atoms)
            this.rotatedCoords = [];
            this.segmentIndices = [];
            this.segData = [];
            this.colors = [];
            this.plddtColors = [];
            // Flags to track when color arrays need recalculation
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;

            // [OPTIMIZATION] Phase 4: Allocation-free rendering
            // Pre-allocated arrays to replace Maps/Sets in render loop
            this.adjList = null;         // Array of arrays: adjList[posIdx] = [segIdx1, segIdx2, ...]
            this.segmentOrder = null;    // Int32Array: segmentOrder[segIdx] = renderOrderIndex
            this.segmentFrame = null;    // Int32Array: segmentFrame[segIdx] = frameId (last rendered frame)
            this.renderFrameId = 0;      // Counter for render frames to validate segmentFrame entries

            // [OPTIMIZATION] Phase 5: Micro-optimizations
            this.segmentEndpointFlags = null; // Uint8Array: bit 0=start, bit 1=end
            this.screenX = null;              // Float32Array: screen X for each position
            this.screenY = null;              // Float32Array: screen Y for each position
            this.screenRadius = null;         // Float32Array: screen radius for each position
            this.screenValid = null;          // Int32Array: frameId if valid/visible, 0 otherwise
            this.screenFrameId = 0;           // Counter for screen projection validity

            // Animation & State
            this.objectsData = {};
            this.currentObjectName = null;
            this.previousObjectName = null; // Track previous object to detect changes
            this.currentFrame = -1;

            // Cache segment indices per frame (bonds don't change within a frame)
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesFrame = -1;
            this.cachedSegmentIndicesObjectName = null;

            // Playback
            this.isPlaying = false;
            this.animationSpeed = 100; // ms per frame
            this.frameAdvanceTimer = null; // Independent timer for frame advancement
            this.lastRenderedFrame = -1; // Track what frame was last rendered
            this.recordingFrameSequence = null; // Timeout ID for sequential recording

            // Overlay mode (for merging multiple frames in same view)
            this.overlayMode = false;
            this.overlayFrameRange = null; // null = all frames, or [start, end]

            // Interaction state
            this.isDragging = false; // Used for selection preview
            this.autoRotate = (typeof config.rotate === 'boolean') ? config.rotate : false;
            this.autoplay = (typeof config.autoplay === 'boolean') ? config.autoplay : false;

            // Inertia
            this.spinVelocityX = 0;
            this.spinVelocityY = 0;
            this.lastDragTime = 0;
            this.lastDragX = 0;
            this.lastDragY = 0;
            this.zoomTimeout = null; // Timeout for clearing zoom flag

            // Touch
            this.initialPinchDistance = 0;

            // Track slider interaction
            this.isSliderDragging = false;

            // PAE and Visibility
            this.paeRenderer = null;
            this.visibilityMask = null; // Set of position indices to *show*
            this.highlightedAtom = null; // To store position index for highlighting (property name kept for API compatibility)
            this.highlightedAtoms = null; // To store Set of position indices for highlighting multiple positions (property name kept for API compatibility)

            // [PATCH] Unified selection model (sequence/chain + PAE)
            // positions: Set of position indices (0, 1, 2, ...) - one position per entry in frame data
            // chains: Set of chain IDs (empty => all chains)
            // paeBoxes: Array of selection rectangles in PAE position space {i_start,i_end,j_start,j_end}
            // selectionMode: 'default' = empty selection means "show all" (initial state)
            //                'explicit' = empty selection means "show nothing" (user cleared)
            this.selectionModel = {
                positions: new Set(), // Position indices: 0, 1, 2, ... (one position per entry in frame data)
                chains: new Set(),
                paeBoxes: [],
                selectionMode: 'default' // Start in default mode (show all)
            };

            // Ligand groups: Map of ligand group keys to arrays of position indices
            // Computed when frame data is loaded, used by sequence and PAE viewers
            this.ligandGroups = new Map();

            // Explicit bonds: Array of [idx1, idx2] pairs defining bonds between any atoms/positions
            // Can be between P (protein), D (DNA), R (RNA), L (ligand), or mixed types
            // If provided, these bonds are rendered as regular segments with proper type handling
            this.bonds = null;

            // UI elements
            this.playButton = null;
            this.overlayButton = null;
            this.recordButton = null;
            this.saveSvgButton = null;
            this.frameSlider = null;
            this.frameCounter = null;
            this.objectSelect = null;
            this.controlsContainer = null;
            this.speedSelect = null;
            this.rotationCheckbox = null;
            this.lineWidthSlider = null;
            this.outlineWidthSlider = null;
            this.shadowEnabledCheckbox = null;
            this.outlineModeButton = null; // Button that cycles through outline modes (index.html)
            this.outlineModeSelect = null; // Dropdown for outline modes (viewer.html)
            this.depthCheckbox = null;
            this.colorblindCheckbox = null;
            this.orthoSlider = null;

            // Recording state
            this.isRecording = false;
            this.mediaRecorder = null;
            this.recordedChunks = [];
            this.recordingStream = null;
            this.recordingEndFrame = 0;

            // Cache shadow/tint arrays during dragging for performance
            this.cachedShadows = null;
            this.cachedTints = null;
            this.isZooming = false; // Track zoom state to skip shadow recalculation
            this.isOrientAnimating = false; // Track orient animation state to skip shadow recalculation
            this.lastShadowRotationMatrix = null; // Track rotation matrix for shadow caching

            // Batch loading flag to suppress unnecessary renders during bulk data loading
            this._batchLoading = false;

            // Width multipliers are now always based on TYPE_BASELINES (no scaling factors needed)

            // Cached width multipliers per type (calculated once per molecule load)
            this.typeWidthMultipliers = {
                'atom': ATOM_WIDTH_MULTIPLIER
            };

            this.setupInteraction();
        }

        setClearColor(isTransparent) {
            this.isTransparent = isTransparent;
            this.render('setClearColor'); // Re-render with new clear color
        }

        // [PATCH] --- Unified Selection API ---
        setSelection(patch, skip3DRender = false) {
            if (!patch) return;
            if (patch.positions !== undefined) {
                const a = patch.positions;
                this.selectionModel.positions = (a instanceof Set) ? new Set(a) : new Set(Array.from(a || []));
            }
            if (patch.chains !== undefined) {
                const c = patch.chains;
                this.selectionModel.chains = (c instanceof Set) ? new Set(c) : new Set(Array.from(c || []));
            }
            if (patch.paeBoxes !== undefined) {
                if (patch.paeBoxes === 'clear' || patch.paeBoxes === null) {
                    this.selectionModel.paeBoxes = [];
                } else if (Array.isArray(patch.paeBoxes)) {
                    this.selectionModel.paeBoxes = patch.paeBoxes.map(b => ({
                        i_start: Math.max(0, Math.floor(b.i_start ?? 0)),
                        i_end: Math.max(0, Math.floor(b.i_end ?? 0)),
                        j_start: Math.max(0, Math.floor(b.j_start ?? 0)),
                        j_end: Math.max(0, Math.floor(b.j_end ?? 0))
                    }));
                }
            }
            if (patch.selectionMode !== undefined) {
                this.selectionModel.selectionMode = patch.selectionMode;
            }

            // Normalize default mode: if in default mode with empty positions, populate with all positions
            // This ensures default mode always has positions filled, simplifying all selection logic
            if (this.selectionModel.selectionMode === 'default' &&
                (!this.selectionModel.positions || this.selectionModel.positions.size === 0)) {
                const n = this.coords ? this.coords.length : 0;
                this.selectionModel.positions = new Set();
                for (let i = 0; i < n; i++) {
                    this.selectionModel.positions.add(i);
                }
            }

            // Save selection state to current object whenever it changes
            if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                this.objectsData[this.currentObjectName].selectionState = {
                    positions: new Set(this.selectionModel.positions),
                    chains: new Set(this.selectionModel.chains),
                    paeBoxes: this.selectionModel.paeBoxes.map(box => ({ ...box })),
                    selectionMode: this.selectionModel.selectionMode
                };
            }

            this._composeAndApplyMask(skip3DRender);
        }

        getSelection() {
            const m = this.selectionModel;

            // Normalize default mode: if in default mode with empty positions, populate with all positions
            // This ensures getSelection() always returns positions populated for default mode
            let positions = new Set(m.positions);
            if (m.selectionMode === 'default' && positions.size === 0) {
                const n = this.coords ? this.coords.length : 0;
                positions = new Set();
                for (let i = 0; i < n; i++) {
                    positions.add(i);
                }
            }

            return {
                positions: positions,
                chains: new Set(m.chains),
                paeBoxes: m.paeBoxes.map(b => ({ ...b })),
                selectionMode: m.selectionMode
            };
        }

        resetSelection() {
            this.selectionModel = {
                positions: new Set(),
                chains: new Set(),
                paeBoxes: [],
                selectionMode: 'default'
            };
            this._composeAndApplyMask();
        }

        // Reset to default state: show all positions
        resetToDefault() {
            const n = this.coords ? this.coords.length : 0;
            if (n === 0) {
                this.resetSelection();
                return;
            }

            // Select all positions (one position per entry in frame data)
            const allPositions = new Set();
            for (let i = 0; i < n; i++) {
                allPositions.add(i);
            }

            // Select all chains
            const allChains = new Set(this.chains);

            // Clear PAE boxes when resetting to default (select all)
            this.setSelection({
                positions: allPositions,
                chains: allChains,
                paeBoxes: [],
                selectionMode: 'default'
            });
        }

        // Clear all selections: show nothing (explicit mode)
        clearSelection() {
            this.setSelection({
                positions: new Set(),
                chains: new Set(),
                paeBoxes: [],
                selectionMode: 'explicit'
            });
        }

        _composeAndApplyMask(skip3DRender = false) {
            const n = this.coords ? this.coords.length : 0;
            if (n === 0) {
                this.visibilityMask = null;
                if (!skip3DRender) {
                    this.render('_composeAndApplyMask: empty coords');
                }
                return;
            }

            // (1) Position/Chain contribution
            // Always compute position selection - it works together with PAE via UNION
            let allowedChains;
            if (this.selectionModel.chains && this.selectionModel.chains.size > 0) {
                allowedChains = this.selectionModel.chains;
            } else {
                // All chains
                allowedChains = new Set(this.chains);
            }

            let seqPositions = null;
            if ((this.selectionModel.positions && this.selectionModel.positions.size > 0) ||
                (this.selectionModel.chains && this.selectionModel.chains.size > 0)) {
                seqPositions = new Set();
                for (let i = 0; i < n; i++) {
                    const ch = this.chains[i];
                    if (!allowedChains.has(ch)) continue;
                    // If positions are explicitly selected, check if this position is in the set
                    // If no positions selected but chains are, include all positions in allowed chains
                    if (this.selectionModel.positions.size === 0 || this.selectionModel.positions.has(i)) {
                        seqPositions.add(i);
                    }
                }
            }

            // (2) PAE contribution: expand i/j ranges into position indices
            // PAE boxes are in PAE position space (0, 1, 2, ... for PAE matrix)
            // If PAE data exists, it maps PAE positions to position indices
            // For now, assume PAE positions directly map to position indices (0, 1, 2, ...)
            // PAE may only cover subset of positions (e.g., only polymer)
            // Handled by mapping PAE positions directly to position indices
            let paePositions = null;
            if (this.selectionModel.paeBoxes && this.selectionModel.paeBoxes.length > 0) {
                paePositions = new Set();
                for (const box of this.selectionModel.paeBoxes) {
                    const i0 = Math.max(0, Math.min(n - 1, Math.min(box.i_start, box.i_end)));
                    const i1 = Math.max(0, Math.min(n - 1, Math.max(box.i_start, box.i_end)));
                    const j0 = Math.max(0, Math.min(n - 1, Math.min(box.j_start, box.j_end)));
                    const j1 = Math.max(0, Math.min(n - 1, Math.max(box.j_start, box.j_end)));
                    // PAE positions map directly to position indices (one position per entry in frame data)
                    for (let r = i0; r <= i1; r++) {
                        if (r < n) paePositions.add(r);
                    }
                    for (let r = j0; r <= j1; r++) {
                        if (r < n) paePositions.add(r);
                    }
                }
            }

            // (3) Combine via UNION
            let combined = null;
            if (seqPositions && paePositions) {
                combined = new Set(seqPositions);
                for (const a of paePositions) combined.add(a);
            } else {
                combined = seqPositions || paePositions;
            }

            // (4) Apply based on selection mode
            const mode = this.selectionModel.selectionMode || 'default';
            const oldVisibilityMask = this.visibilityMask;
            if (combined && combined.size > 0) {
                // We have some selection - use it
                this.visibilityMask = combined;
            } else {
                // No selection computed
                if (mode === 'default') {
                    // Default mode: empty selection means "show all"
                    this.visibilityMask = null;
                } else {
                    // Explicit mode: empty selection means "show nothing"
                    this.visibilityMask = new Set(); // Empty set = nothing visible
                }
            }

            // Clear shadow cache when visibility changes (selection/deselection)
            // Visibility changes affect which segments are visible, so shadows need recalculation
            // Compare by reference and size (simple check - if different objects or different sizes, changed)
            const visibilityChanged = (
                oldVisibilityMask !== this.visibilityMask &&
                (oldVisibilityMask === null || this.visibilityMask === null ||
                    oldVisibilityMask.size !== this.visibilityMask.size)
            );
            if (visibilityChanged && !skip3DRender) {
                this.cachedShadows = null;
                this.cachedTints = null;
                this.lastShadowRotationMatrix = null; // Force recalculation
            }

            // Only render 3D viewer if not skipping (e.g., during PAE drag)
            if (!skip3DRender) {
                this.render('_composeAndApplyMask');
            }

            // Always dispatch event to notify UI of selection change (sequence/PAE viewers need this)
            if (typeof document !== 'undefined') {
                try {
                    document.dispatchEvent(new CustomEvent('py2dmol-selection-change', {
                        detail: {
                            hasSelection: this.visibilityMask !== null && this.visibilityMask.size > 0,
                            selectionModel: {
                                positions: Array.from(this.selectionModel.positions),
                                chains: Array.from(this.selectionModel.chains),
                                paeBoxes: this.selectionModel.paeBoxes.map(b => ({ ...b })),
                                selectionMode: this.selectionModel.selectionMode
                            }
                        }
                    }));
                } catch (e) {
                    console.warn('Failed to dispatch selection change event:', e);
                }
            }
        }
        // [END PATCH]

        // --- PAE / Visibility ---
        setPAERenderer(paeRenderer) {
            this.paeRenderer = paeRenderer;
        }

        // [PATCH] Re-routed setResidueVisibility to use the new unified selection model
        setResidueVisibility(selection) {
            if (selection === null) {
                // Clear only PAE contribution; leave sequence/chain selections intact
                this.setSelection({ paeBoxes: 'clear' });
            } else {
                const { i_start, i_end, j_start, j_end } = selection;
                this.setSelection({ paeBoxes: [{ i_start, i_end, j_start, j_end }] });
            }
        }
        // [END PATCH]

        _applyPastel(rgb) {
            if (this.pastelLevel <= 0) {
                return rgb;
            }
            // Apply pastel transformation (mix with white)
            const mix = this.pastelLevel;
            return {
                r: Math.round(rgb.r * (1 - mix) + 255 * mix),
                g: Math.round(rgb.g * (1 - mix) + 255 * mix),
                b: Math.round(rgb.b * (1 - mix) + 255 * mix)
            };
        }

        setupInteraction() {
            // Add inertia logic
            this.canvas.addEventListener('mousedown', (e) => {
                // Only start dragging if we clicked directly on the canvas or the highlight overlay
                // (the overlay has pointer-events: none, but we check for it just in case)
                const isHighlightOverlay = e.target.id === 'highlightOverlay';
                if (e.target !== this.canvas && !isHighlightOverlay) return;

                this.isDragging = true;
                this.spinVelocityX = 0;
                this.spinVelocityY = 0;
                this.lastDragX = e.clientX;
                this.lastDragY = e.clientY;
                this.lastDragTime = performance.now();
                if (this.autoRotate) {
                    this.autoRotate = false;
                    if (this.rotationCheckbox) this.rotationCheckbox.checked = false;
                }

                // Add temporary window listeners for drag outside canvas
                const handleMove = (e) => {
                    if (!this.isDragging) return;

                    // Stop canvas drag if interacting with controls
                    const tagName = e.target.tagName;
                    if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'BUTTON') {
                        this.isDragging = false;
                        window.removeEventListener('mousemove', handleMove);
                        window.removeEventListener('mouseup', handleUp);
                        return;
                    }

                    const now = performance.now();
                    const timeDelta = now - this.lastDragTime;

                    const dx = e.clientX - this.lastDragX;
                    const dy = e.clientY - this.lastDragY;

                    // Only update rotation if there's actual movement
                    if (dy !== 0 || dx !== 0) {
                        if (dy !== 0) {
                            const rot = rotationMatrixX(dy * 0.01);
                            this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                        }
                        if (dx !== 0) {
                            const rot = rotationMatrixY(dx * 0.01);
                            this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                        }
                    } else {
                        return; // No movement, skip render
                    }

                    // Store velocity for inertia (disabled for large molecules based on visible segments)
                    const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                    const totalSegmentCount = object && object.frames && object.frames[this.currentFrame]
                        ? (this.segmentIndices ? this.segmentIndices.length : 0)
                        : 0;
                    // Count visible segments for inertia determination
                    let visibleSegmentCount = totalSegmentCount;
                    if (this.visibilityMask && this.segmentIndices) {
                        visibleSegmentCount = 0;
                        for (let i = 0; i < this.segmentIndices.length; i++) {
                            const seg = this.segmentIndices[i];
                            if (this.visibilityMask.has(seg.idx1) && this.visibilityMask.has(seg.idx2)) {
                                visibleSegmentCount++;
                            }
                        }
                    }
                    const enableInertia = visibleSegmentCount <= this.LARGE_MOLECULE_CUTOFF;

                    if (enableInertia && timeDelta > 0) {
                        // Weighted average to smooth out jerky movements
                        const smoothing = 0.5;
                        this.spinVelocityX = (this.spinVelocityX * (1 - smoothing)) + ((dx / timeDelta * 20) * smoothing);
                        this.spinVelocityY = (this.spinVelocityY * (1 - smoothing)) + ((dy / timeDelta * 20) * smoothing);
                    } else {
                        // Disable inertia for large objects
                        this.spinVelocityX = 0;
                        this.spinVelocityY = 0;
                    }

                    this.lastDragX = e.clientX;
                    this.lastDragY = e.clientY;
                    this.lastDragTime = now;

                    this.render();
                };

                const handleUp = () => {
                    if (!this.isDragging) return;
                    this.isDragging = false;
                    window.removeEventListener('mousemove', handleMove);
                    window.removeEventListener('mouseup', handleUp);
                };

                window.addEventListener('mousemove', handleMove);
                window.addEventListener('mouseup', handleUp);
            });

            // Canvas-bound mouseup (fallback, but window listener handles it)
            this.canvas.addEventListener('mouseup', () => {
                if (!this.isDragging) return;
                this.isDragging = false;

                // Clear shadow cache when dragging ends (shadows need recalculation)
                this.cachedShadows = null;
                this.cachedTints = null;
                this.lastShadowRotationMatrix = null; // Force recalculation

                // For large molecules, immediately recalculate shadows
                // since inertia is disabled and rotation has stopped
                const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                const segmentCount = object && this.segmentIndices ? this.segmentIndices.length : 0;
                const isLargeMolecule = segmentCount > this.LARGE_MOLECULE_CUTOFF;

                if (isLargeMolecule) {
                    // Render immediately with fresh shadows
                    this.render();
                }

                // Restart animate loop after dragging ends
                requestAnimationFrame(() => this.animate());

                const now = performance.now();
                const timeDelta = now - this.lastDragTime;

                if (timeDelta > 100) { // If drag was too slow, or just a click
                    this.spinVelocityX = 0;
                    this.spinVelocityY = 0;
                }
                // Else, the velocity from the last mousemove is used by the animate loop
            });

            this.canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                this.isZooming = true;
                this.zoom *= (1 - e.deltaY * 0.001);
                this.zoom = Math.max(0.1, Math.min(5, this.zoom));
                this.render();
                // Clear zoom flag after a short delay to allow render to complete
                clearTimeout(this.zoomTimeout);
                this.zoomTimeout = setTimeout(() => {
                    this.isZooming = false;
                }, 100);
            }, { passive: false });


            // Touch Listeners

            this.canvas.addEventListener('touchstart', (e) => {
                e.preventDefault(); // Prevent page scroll

                if (e.touches.length === 1) {
                    // Start of a drag
                    this.isDragging = true;
                    this.spinVelocityX = 0;
                    this.spinVelocityY = 0;
                    this.lastDragX = e.touches[0].clientX;
                    this.lastDragY = e.touches[0].clientY;
                    this.lastDragTime = performance.now();
                    if (this.autoRotate) {
                        this.autoRotate = false;
                        if (this.rotationCheckbox) this.rotationCheckbox.checked = false;
                    }
                } else if (e.touches.length === 2) {
                    // Start of a pinch-zoom
                    this.isDragging = false; // Stop dragging
                    this.initialPinchDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
                }
            }, { passive: false });

            this.canvas.addEventListener('touchmove', (e) => {
                e.preventDefault(); // Prevent page scroll

                if (e.touches.length === 1 && this.isDragging) {
                    // Rotation/Drag
                    const now = performance.now();
                    const timeDelta = now - this.lastDragTime;
                    const touch = e.touches[0];

                    const dx = touch.clientX - this.lastDragX;
                    const dy = touch.clientY - this.lastDragY;

                    if (dy !== 0) { const rot = rotationMatrixX(dy * 0.01); this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); }
                    if (dx !== 0) { const rot = rotationMatrixY(dx * 0.01); this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); }

                    // Store velocity for inertia (disabled for large molecules based on visible segments)
                    const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                    const totalSegmentCount = object && object.frames && object.frames[this.currentFrame]
                        ? (this.segmentIndices ? this.segmentIndices.length : 0)
                        : 0;
                    // Count visible segments for inertia determination
                    let visibleSegmentCount = totalSegmentCount;
                    if (this.visibilityMask && this.segmentIndices) {
                        visibleSegmentCount = 0;
                        for (let i = 0; i < this.segmentIndices.length; i++) {
                            const seg = this.segmentIndices[i];
                            if (this.visibilityMask.has(seg.idx1) && this.visibilityMask.has(seg.idx2)) {
                                visibleSegmentCount++;
                            }
                        }
                    }
                    const enableInertia = visibleSegmentCount <= this.LARGE_MOLECULE_CUTOFF;

                    if (enableInertia && timeDelta > 0) {
                        const smoothing = 0.5;
                        this.spinVelocityX = (this.spinVelocityX * (1 - smoothing)) + ((dx / timeDelta * 20) * smoothing);
                        this.spinVelocityY = (this.spinVelocityY * (1 - smoothing)) + ((dy / timeDelta * 20) * smoothing);
                    } else {
                        // Disable inertia for large objects
                        this.spinVelocityX = 0;
                        this.spinVelocityY = 0;
                    }

                    this.lastDragX = touch.clientX;
                    this.lastDragY = touch.clientY;
                    this.lastDragTime = now;

                    this.render();
                } else if (e.touches.length === 2) {
                    // Zoom/Pinch
                    if (this.initialPinchDistance <= 0) return; // Not initialized

                    this.isZooming = true;
                    const currentPinchDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
                    const scale = currentPinchDistance / this.initialPinchDistance;

                    this.zoom *= scale;
                    this.zoom = Math.max(0.1, Math.min(5, this.zoom));
                    this.render();

                    // Reset for next move event
                    this.initialPinchDistance = currentPinchDistance;

                    // Clear zoom flag after a short delay
                    clearTimeout(this.zoomTimeout);
                    this.zoomTimeout = setTimeout(() => {
                        this.isZooming = false;
                    }, 100);
                }
            }, { passive: false });

            this.canvas.addEventListener('touchend', (e) => {
                // Handle inertia for drag
                if (e.touches.length === 0 && this.isDragging) {
                    this.isDragging = false;

                    // Clear shadow cache when dragging ends (shadows need recalculation)
                    this.cachedShadows = null;
                    this.cachedTints = null;
                    this.lastShadowRotationMatrix = null; // Force recalculation

                    // For large molecules (based on visible segments), immediately recalculate shadows
                    // since inertia is disabled and rotation has stopped
                    const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                    const totalSegmentCount = object && this.segmentIndices ? this.segmentIndices.length : 0;
                    // Count visible segments
                    let visibleSegmentCount = totalSegmentCount;
                    if (this.visibilityMask && this.segmentIndices) {
                        visibleSegmentCount = 0;
                        for (let i = 0; i < this.segmentIndices.length; i++) {
                            const seg = this.segmentIndices[i];
                            if (this.visibilityMask.has(seg.idx1) && this.visibilityMask.has(seg.idx2)) {
                                visibleSegmentCount++;
                            }
                        }
                    }
                    const isLargeMolecule = visibleSegmentCount > this.LARGE_MOLECULE_CUTOFF;

                    if (isLargeMolecule) {
                        // Render immediately with fresh shadows
                        this.render('touchend: large molecule');
                    }

                    // Restart animate loop after dragging ends (needed for inertia and auto-rotation)
                    requestAnimationFrame(() => this.animate());

                    const now = performance.now();
                    const timeDelta = now - this.lastDragTime;

                    if (timeDelta > 100) { // If drag was too slow, or just a tap
                        this.spinVelocityX = 0;
                        this.spinVelocityY = 0;
                    }
                    // Else, the velocity from the last touchmove is used by the animate loop
                }

                // Handle end of pinch
                if (e.touches.length < 2) {
                    this.initialPinchDistance = 0;
                }

                // If all touches are up, reset dragging
                if (e.touches.length === 0) {
                    const wasDragging = this.isDragging;
                    this.isDragging = false;

                    // Clear shadow cache when dragging ends (shadows need recalculation)
                    if (wasDragging) {
                        this.cachedShadows = null;
                        this.cachedTints = null;
                        this.lastShadowRotationMatrix = null; // Force recalculation
                    }

                    // Restart animation loop if it was stopped
                    requestAnimationFrame(() => this.animate());
                }
            });

            this.canvas.addEventListener('touchcancel', (e) => {
                // Handle touch cancellation (e.g., system gesture interference)
                if (this.isDragging) {
                    this.isDragging = false;

                    // Clear shadow cache when dragging ends (shadows need recalculation)
                    this.cachedShadows = null;
                    this.cachedTints = null;
                    this.lastShadowRotationMatrix = null; // Force recalculation

                    // Restart animation loop
                    requestAnimationFrame(() => this.animate());
                }
                this.initialPinchDistance = 0;
            });
        }

        getTouchDistance(touch1, touch2) {
            const dx = touch1.clientX - touch2.clientX;
            const dy = touch1.clientY - touch2.clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        // Set UI controls from main script
        setUIControls(controlsContainer, playButton, overlayButton, recordButton, saveSvgButton, frameSlider, frameCounter, objectSelect, speedSelect, rotationCheckbox, lineWidthSlider, outlineWidthSlider, shadowEnabledCheckbox, outlineModeButton, outlineModeSelect, depthCheckbox, colorblindCheckbox, orthoSlider) {
            this.controlsContainer = controlsContainer;
            this.playButton = playButton;
            this.overlayButton = overlayButton;
            this.recordButton = recordButton;
            this.saveSvgButton = saveSvgButton;
            this.frameSlider = frameSlider;
            this.frameCounter = frameCounter;
            this.objectSelect = objectSelect;
            this.speedSelect = speedSelect;
            this.rotationCheckbox = rotationCheckbox;
            this.lineWidthSlider = lineWidthSlider;
            this.outlineWidthSlider = outlineWidthSlider;
            this.shadowEnabledCheckbox = shadowEnabledCheckbox;
            this.outlineModeButton = outlineModeButton;
            this.outlineModeSelect = outlineModeSelect;
            this.depthCheckbox = depthCheckbox;
            this.colorblindCheckbox = colorblindCheckbox;
            this.orthoSlider = orthoSlider;
            this.lineWidth = this.lineWidthSlider ? parseFloat(this.lineWidthSlider.value) : (this.lineWidth || 3.0); // Read default from slider or use existing/default
            this.relativeOutlineWidth = this.outlineWidthSlider ? parseFloat(this.outlineWidthSlider.value) : (this.relativeOutlineWidth || 3.0); // Read default from slider or use existing/default
            this.autoRotate = this.rotationCheckbox ? this.rotationCheckbox.checked : false; // Read default from checkbox

            // Bind all event listeners
            this.playButton.addEventListener('click', () => {
                this.togglePlay();
            });

            if (this.overlayButton) {
                this.overlayButton.addEventListener('click', () => {
                    this.toggleOverlay();
                });
            }

            if (this.recordButton) {
                this.recordButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleRecording();
                });
            } else {
                console.warn("Record button not found - recording will not be available");
            }

            if (this.saveSvgButton) {
                this.saveSvgButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.saveAsSvg();
                });
            }

            if (this.objectSelect) {
                this.objectSelect.addEventListener('change', () => {
                    this.stopAnimation();
                    const newObjectName = this.objectSelect.value;
                    if (this.currentObjectName === newObjectName) {
                        return;
                    }

                    this._switchToObject(newObjectName);
                    this.setFrame(0);
                    this.updatePAEContainerVisibility();
                });
            }

            this.speedSelect.addEventListener('change', (e) => {
                const wasPlaying = this.isPlaying;
                this.animationSpeed = parseInt(e.target.value);

                // If animation is playing, restart timer with new speed
                if (wasPlaying) {
                    this.stopAnimation();
                    this.startAnimation();
                }
            });

            this.rotationCheckbox.addEventListener('change', (e) => {
                this.autoRotate = e.target.checked;
                // Stop inertia if user clicks auto-rotate
                this.spinVelocityX = 0;
                this.spinVelocityY = 0;
            });

            if (this.lineWidthSlider) {
                this.lineWidthSlider.addEventListener('input', (e) => {
                    this.lineWidth = parseFloat(e.target.value);
                    if (!this.isPlaying) {
                        this.render('updateUIControls: lineWidthSlider');
                    }
                });
            }

            if (this.outlineWidthSlider) {
                this.outlineWidthSlider.addEventListener('input', (e) => {
                    this.relativeOutlineWidth = parseFloat(e.target.value);
                    if (!this.isPlaying) {
                        this.render('updateUIControls: outlineWidthSlider');
                    }
                });
            }

            // Ortho slider: controls perspective/orthographic projection
            // Value range: 0.0 (strongest perspective) to 1.0 (full orthographic)
            if (this.orthoSlider) {
                // Constants for perspective focal length calculation
                const PERSPECTIVE_MIN_MULT = 1.5;  // Closest camera (strongest perspective)
                const PERSPECTIVE_MAX_MULT = 20.0; // Farthest camera (weakest perspective)
                const STD_DEV_MULT = 2.0;           // Use stdDev * 2.0 as base size measure
                const DEFAULT_SIZE = 30.0;         // Fallback if no object loaded

                this.orthoSlider.addEventListener('input', (e) => {
                    const normalizedValue = parseFloat(e.target.value);

                    // Get object size using standard deviation from center
                    const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                    let baseSize = DEFAULT_SIZE;
                    if (object && object.stdDev > 0) {
                        // Use standard deviation * 3.0 as the base size measure
                        baseSize = object.stdDev * STD_DEV_MULT;
                    } else if (object && object.maxExtent > 0) {
                        // Fallback to maxExtent if stdDev not available
                        baseSize = object.maxExtent;
                    }

                    if (normalizedValue >= 1.0) {
                        // Orthographic mode: no perspective
                        this.perspectiveEnabled = false;
                        this.focalLength = baseSize * PERSPECTIVE_MAX_MULT;
                    } else {
                        // Perspective mode: interpolate focal length based on slider value
                        const multiplier = PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * normalizedValue;
                        this.perspectiveEnabled = true;
                        this.focalLength = baseSize * multiplier;
                    }

                    if (!this.isPlaying) {
                        this.render('orthoSlider');
                    }
                });
            }


            if (this.shadowEnabledCheckbox) {
                this.shadowEnabledCheckbox.addEventListener('change', (e) => {
                    this.shadowEnabled = e.target.checked;
                    this.render('shadowEnabledCheckbox');
                });
            }

            if (this.outlineModeButton) {
                // Button mode (index.html) - cycles through modes
                this.outlineModeButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    // Cycle through modes: none -> partial -> full -> none
                    if (this.outlineMode === 'none') {
                        this.outlineMode = 'partial';
                    } else if (this.outlineMode === 'partial') {
                        this.outlineMode = 'full';
                    } else { // full
                        this.outlineMode = 'none';
                    }
                    this.updateOutlineButtonStyle();
                    this.render('outlineModeButton');
                });
                // Initialize button style
                this.updateOutlineButtonStyle();
            } else if (this.outlineModeSelect) {
                // Dropdown mode (viewer.html) - already handled in initialization
                this.outlineModeSelect.value = this.outlineMode || 'full';
            }

            if (this.depthCheckbox) {
                this.depthCheckbox.addEventListener('change', (e) => {
                    this.depthEnabled = e.target.checked;
                    this.render('depthCheckbox');
                });
            }

            if (this.colorblindCheckbox) {
                this.colorblindCheckbox.addEventListener('change', (e) => {
                    this.colorblindMode = e.target.checked;
                    // Mark colors as needing update - will be recalculated on next render
                    this.colorsNeedUpdate = true;
                    this.plddtColorsNeedUpdate = true;
                    // Re-render main canvas
                    this.render('colorblindCheckbox');
                    // Dispatch event to notify sequence viewer
                    document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
                    // Re-render PAE canvas
                    if (this.paeRenderer) {
                        this.paeRenderer.render();
                    }
                });
            }


            // Prevent canvas drag from interfering with slider
            const handleSliderChange = (e) => {
                this.stopAnimation();
                this.setFrame(parseInt(e.target.value));
            };

            // Track when user is interacting with slider
            this.frameSlider.addEventListener('mousedown', (e) => {
                this.isDragging = false;
                this.isSliderDragging = true;
                e.stopPropagation();
            });

            this.frameSlider.addEventListener('mouseup', (e) => {
                this.isSliderDragging = false;
            });

            // Also clear on window mouseup in case user releases outside slider
            window.addEventListener('mouseup', () => {
                this.isSliderDragging = false;
            });

            this.frameSlider.addEventListener('input', handleSliderChange);
            this.frameSlider.addEventListener('change', handleSliderChange);

            // Also prevent canvas drag when interacting with other controls
            const allControls = [this.playButton, this.objectSelect, this.speedSelect,
            this.rotationCheckbox, this.lineWidthSlider,
            this.shadowEnabledCheckbox, this.outlineModeButton, this.outlineModeSelect,
            this.colorblindCheckbox, this.orthoSlider];
            allControls.forEach(control => {
                if (control) {
                    control.addEventListener('mousedown', (e) => {
                        this.isDragging = false;
                        e.stopPropagation();
                    });
                }
            });
        }

        // Switch to a different object (handles save/restore of selection state)
        _switchToObject(newObjectName) {
            // Save current object's selection state
            if (this.currentObjectName && this.currentObjectName !== newObjectName && this.objectsData[this.currentObjectName]) {
                this.objectsData[this.currentObjectName].selectionState = {
                    positions: new Set(this.selectionModel.positions),
                    chains: new Set(this.selectionModel.chains),
                    paeBoxes: this.selectionModel.paeBoxes.map(box => ({ ...box })),
                    selectionMode: this.selectionModel.selectionMode
                };
            }

            // Switch to new object
            this.currentObjectName = newObjectName;

            // Invalidate segment cache to ensure contacts and other object-specific data are regenerated
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesFrame = -1;
            this.cachedSegmentIndicesObjectName = null;

            // Clear renderer bonds (will be restored from object data when frames load)
            this.bonds = null;

            // Ensure object has selectionState initialized
            if (!this.objectsData[newObjectName]) {
                this.objectsData[newObjectName] = {};
            }
            if (!this.objectsData[newObjectName].selectionState) {
                this.objectsData[newObjectName].selectionState = {
                    positions: new Set(),
                    chains: new Set(),
                    paeBoxes: [],
                    selectionMode: 'default'
                };
            }

            // Get the correct coords length from the new object's first frame for normalization
            // This ensures normalization uses the correct size, not the previous object's coords
            const newObject = this.objectsData[newObjectName];
            const firstFrame = newObject?.frames?.[0];
            const correctCoordsLength = firstFrame?.coords?.length || 0;

            // Restore selection state
            const savedState = this.objectsData[newObjectName].selectionState;

            // Apply the saved selection directly to selectionModel (bypassing setSelection's normalization)
            this.selectionModel.positions = new Set(savedState.positions);
            this.selectionModel.chains = new Set(savedState.chains);
            this.selectionModel.paeBoxes = savedState.paeBoxes.map(box => ({ ...box }));
            this.selectionModel.selectionMode = savedState.selectionMode;

            // Only normalize if in default mode with empty positions, using correct coords length
            if (this.selectionModel.selectionMode === 'default' &&
                (!this.selectionModel.positions || this.selectionModel.positions.size === 0)) {
                this.selectionModel.positions = new Set();
                for (let i = 0; i < correctCoordsLength; i++) {
                    this.selectionModel.positions.add(i);
                }
            }

            // Populate entropy data from MSA if available
            if (this.objectsData[newObjectName]?.msa?.msasBySequence && this.objectsData[newObjectName]?.msa?.chainToSequence) {
                this._mapEntropyToStructure(newObjectName);
            } else if (this.colorMode === 'entropy') {
                // If entropy mode is active but no MSA, try to map it anyway
                this._mapEntropyToStructure();
            } else {
                // No MSA data - clear entropy
                this.entropy = undefined;
            }

            // Save the restored selection state (setSelection would do this, but we're bypassing it)
            if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                this.objectsData[this.currentObjectName].selectionState = {
                    positions: new Set(this.selectionModel.positions),
                    chains: new Set(this.selectionModel.chains),
                    paeBoxes: this.selectionModel.paeBoxes.map(box => ({ ...box })),
                    selectionMode: this.selectionModel.selectionMode
                };
            }

            // Note: _composeAndApplyMask will be called by setFrame after the frame data is loaded
        }

        // Add a new object
        addObject(name) {
            this.stopAnimation();

            // If object with same name already exists, clear it instead of creating duplicate
            const objectExists = this.objectsData[name] !== undefined;
            if (objectExists) {
                this.objectsData[name].frames = [];
                this.objectsData[name].maxExtent = 0;
                this.objectsData[name].stdDev = 0;
                this.objectsData[name].globalCenterSum = new Vec3(0, 0, 0);
                this.objectsData[name].totalPositions = 0;
                this.objectsData[name]._lastPlddtFrame = -1;
                this.objectsData[name]._lastPaeFrame = -1;
                // Don't clear selectionState - preserve it
            } else {
                // Create new object
                this.objectsData[name] = {
                    maxExtent: 0,
                    stdDev: 0,
                    frames: [],
                    globalCenterSum: new Vec3(0, 0, 0),
                    totalPositions: 0,
                    _lastPlddtFrame: -1,
                    _lastPaeFrame: -1,
                    bonds: null,
                    contacts: null,
                    selectionState: {
                        positions: new Set(),
                        chains: new Set(),
                        paeBoxes: [],
                        selectionMode: 'default'
                    }
                };

                // Add to dropdown
                if (this.objectSelect) {
                    const existingOption = Array.from(this.objectSelect.options).find(opt => opt.value === name);
                    if (!existingOption) {
                        const option = document.createElement('option');
                        option.value = name;
                        option.textContent = name;
                        this.objectSelect.appendChild(option);
                    }
                }
            }

            // Switch to object (handles save/restore)
            this._switchToObject(name);

            this.currentFrame = -1;
            this.lastRenderedFrame = -1;
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesFrame = -1;
            this.cachedSegmentIndicesObjectName = null;

            if (this.objectSelect) {
                this.objectSelect.value = name;
            }

            this.setFrame(-1);
        }

        // Add a frame (data is raw parsed JSON)
        addFrame(data, objectName) {
            let targetObjectName = objectName;
            if (!targetObjectName) {
                console.warn("addFrame called without objectName, using current view.");
                targetObjectName = this.currentObjectName;
            }

            if (!targetObjectName) {
                // This can happen if addFrame is called before new_obj
                console.warn("addFrame: No object active. Creating '0'.");
                this.addObject("0");
                targetObjectName = "0";
            }

            if (!this.objectsData[targetObjectName]) {
                console.error(`addFrame: Object '${targetObjectName}' does not exist.`);
                console.warn(`addFrame: Object '${targetObjectName}' not found. Creating it.`);
                this.addObject(targetObjectName);
            }

            const object = this.objectsData[targetObjectName];
            const newFrameIndex = object.frames.length; // Index of frame we're about to add

            // Store contacts if provided in data (object-level)
            if (data.contacts !== undefined && data.contacts !== null) {
                object.contacts = data.contacts;
            }

            // Store explicit bonds if provided in data (object-level)
            if (data.bonds !== undefined && data.bonds !== null) {
                object.bonds = data.bonds;
            }

            // Update object-level tracking (for optimization during resolution)
            if (this._hasPlddtData(data)) {
                object._lastPlddtFrame = newFrameIndex;
            } else if (newFrameIndex === 0) {
                object._lastPlddtFrame = -1; // No plddt in first frame
            }

            if (this._hasPaeData(data)) {
                object._lastPaeFrame = newFrameIndex;
            } else if (newFrameIndex === 0) {
                object._lastPaeFrame = -1; // No PAE in first frame
            }
            object.frames.push(data);

            // Set view to this object
            if (this.currentObjectName !== targetObjectName) {
                this.stopAnimation(); // Stop if playing on another obj
                this.currentObjectName = targetObjectName;
                this.lastRenderedFrame = -1; // Reset frame tracking on object change
                if (this.objectSelect) {
                    this.objectSelect.value = targetObjectName;
                }
            }

            // Update global center sum and count (from all positions for viewing)
            let frameSum = new Vec3(0, 0, 0);
            let frameAtoms = 0;
            if (data && data.coords) {
                frameAtoms = data.coords.length;
                for (let i = 0; i < data.coords.length; i++) {
                    const c = data.coords[i];
                    frameSum = frameSum.add(new Vec3(c[0], c[1], c[2]));
                }
                object.globalCenterSum = object.globalCenterSum.add(frameSum);
                object.totalPositions += frameAtoms;
            }

            const globalCenter = (object.totalPositions > 0) ? object.globalCenterSum.mul(1 / object.totalPositions) : new Vec3(0, 0, 0);

            // Recalculate maxExtent and standard deviation for all frames using the new global center
            let maxDistSq = 0;
            let sumDistSq = 0;
            let positionCount = 0;
            for (const frame of object.frames) {
                if (frame && frame.coords) {
                    for (let i = 0; i < frame.coords.length; i++) {
                        const c = frame.coords[i];
                        const coordVec = new Vec3(c[0], c[1], c[2]);
                        const centeredCoord = coordVec.sub(globalCenter);
                        const distSq = centeredCoord.dot(centeredCoord);
                        if (distSq > maxDistSq) maxDistSq = distSq;
                        sumDistSq += distSq;
                        positionCount++;
                    }
                }
            }
            object.maxExtent = Math.sqrt(maxDistSq);
            // Calculate standard deviation: sqrt(mean of squared distances)
            object.stdDev = positionCount > 0 ? Math.sqrt(sumDistSq / positionCount) : 0;

            // If this is the first frame being loaded, we need to
            // Recalculate focal length if perspective is enabled and object size changed
            // Skip during batch loading to avoid unnecessary renders
            if (object.frames.length === 1 && this.perspectiveEnabled && this.orthoSlider && !this._batchLoading) {
                this.orthoSlider.dispatchEvent(new Event('input'));
            }

            // Skip setFrame during batch loading to avoid expensive renders
            // We'll render once at the end in updateViewerFromGlobalBatch
            if (!this.isPlaying && !this._batchLoading) {
                this.setFrame(object.frames.length - 1);
            } else if (!this.isPlaying) {
                // During batch loading, just update the frame index without rendering
                this.currentFrame = object.frames.length - 1;
                this.lastRenderedFrame = -1; // Mark as needing render
            }

            this.updateUIControls();

            // Update PAE container visibility when frames are added
            this.updatePAEContainerVisibility();

            // Handle autoplay
            if (this.autoplay && !this.isPlaying && this.currentObjectName) {
                // Check if the current object now has multiple frames
                const obj = this.objectsData[this.currentObjectName];
                if (obj && obj.frames.length > 1) {
                    this.startAnimation();
                }
            }
        }

        // Extract current selection to a new object
        extractSelection() {
            // Check if we have a current object and frame
            if (!this.currentObjectName) {
                console.warn("No object loaded. Cannot extract selection.");
                return;
            }

            const object = this.objectsData[this.currentObjectName];
            if (!object || !object.frames || object.frames.length === 0) {
                console.warn("No frames available. Cannot extract selection.");
                return;
            }

            // Use first frame to determine selection (selection is frame-independent)
            const firstFrame = object.frames[0];
            if (!firstFrame || !firstFrame.coords) {
                console.warn("First frame has no coordinates. Cannot extract selection.");
                return;
            }

            // Get selected positions (selection is frame-independent, so use first frame to determine indices)
            let selectedPositions = new Set();

            // Check selectionModel first (explicit selection)
            if (this.selectionModel && this.selectionModel.positions && this.selectionModel.positions.size > 0) {
                selectedPositions = new Set(this.selectionModel.positions);
            } else if (this.visibilityMask !== null && this.visibilityMask.size > 0) {
                // Use visibilityMask if available
                selectedPositions = new Set(this.visibilityMask);
            } else {
                // No selection - all positions visible (could extract all, but warn user)
                console.warn("No selection found. All positions are visible. Extracting all positions.");
                // Extract all positions
                for (let i = 0; i < firstFrame.coords.length; i++) {
                    selectedPositions.add(i);
                }
            }

            if (selectedPositions.size === 0) {
                console.warn("Selection is empty. Cannot extract.");
                return;
            }

            // Convert to sorted array for consistent ordering
            const selectedIndices = Array.from(selectedPositions).sort((a, b) => a - b);

            // Generate object name with chain ranges: name_A1-100_B10-20 or name_A_B (if entire chains)
            const baseName = this.currentObjectName;

            // Group selected positions by chain and find position index ranges (use first frame for naming)
            const chainRanges = new Map(); // chain -> {min, max, selectedCount, totalCount}

            // First, count total positions per chain in original frame
            const chainTotalCounts = new Map(); // chain -> total position count
            if (firstFrame.chains) {
                for (let i = 0; i < firstFrame.chains.length; i++) {
                    const chain = firstFrame.chains[i];
                    chainTotalCounts.set(chain, (chainTotalCounts.get(chain) || 0) + 1);
                }
            }

            // Then, count selected positions per chain and find ranges
            const chainSelectedCounts = new Map(); // chain -> selected position count
            if (firstFrame.chains && firstFrame.residue_numbers) {
                for (const idx of selectedIndices) {
                    if (idx < firstFrame.chains.length && idx < firstFrame.residue_numbers.length) {
                        const chain = firstFrame.chains[idx];
                        const resIdx = firstFrame.residue_numbers[idx];

                        chainSelectedCounts.set(chain, (chainSelectedCounts.get(chain) || 0) + 1);

                        if (!chainRanges.has(chain)) {
                            chainRanges.set(chain, { min: resIdx, max: resIdx });
                        } else {
                            const range = chainRanges.get(chain);
                            range.min = Math.min(range.min, resIdx);
                            range.max = Math.max(range.max, resIdx);
                        }
                    }
                }
            }

            // Build name with chain ranges (or just chain IDs if entire chains are selected)
            let extractName = baseName;
            if (chainRanges.size > 0) {
                const chainParts = [];
                // Sort chains for consistent ordering
                const sortedChains = Array.from(chainRanges.keys()).sort();
                for (const chain of sortedChains) {
                    const range = chainRanges.get(chain);
                    const selectedCount = chainSelectedCounts.get(chain) || 0;
                    const totalCount = chainTotalCounts.get(chain) || 0;

                    // If entire chain is selected, just use chain ID
                    if (selectedCount === totalCount && totalCount > 0) {
                        chainParts.push(chain);
                    } else {
                        // Partial selection, use range format
                        chainParts.push(`${chain}${range.min}-${range.max}`);
                    }
                }
                extractName = `${baseName}_${chainParts.join('_')}`;
            } else {
                // Fallback if no chain/position info
                extractName = `${baseName}_extracted`;
            }

            // Ensure unique name
            let originalExtractName = extractName;
            let extractCounter = 1;
            while (this.objectsData[extractName] !== undefined) {
                extractName = `${originalExtractName}_${extractCounter}`;
                extractCounter++;
            }

            // Create new object
            this.addObject(extractName);

            // Extract all frames, not just the current one
            for (let frameIndex = 0; frameIndex < object.frames.length; frameIndex++) {
                const frame = object.frames[frameIndex];
                if (!frame || !frame.coords) {
                    continue; // Skip invalid frames
                }

                // Resolve inherited plddt and PAE data before extracting
                const resolvedPlddt = this._resolvePlddtData(object, frameIndex);
                const resolvedPae = this._resolvePaeData(object, frameIndex);

                // Use resolved data if available, otherwise use frame's own data
                const sourcePlddt = resolvedPlddt !== null ? resolvedPlddt : frame.plddts;
                const sourcePae = resolvedPae !== null ? resolvedPae : frame.pae;

                // Extract frame data for selected positions
                const extractedFrame = {
                    coords: [],
                    chains: frame.chains ? [] : undefined,
                    plddts: sourcePlddt ? [] : undefined,
                    position_types: frame.position_types ? [] : undefined,
                    position_names: frame.position_names ? [] : undefined,
                    residue_numbers: frame.residue_numbers ? [] : undefined,
                    pae: undefined, // Will be handled separately
                    bonds: undefined // Will be handled separately
                };

                // Extract data for each selected position
                for (const idx of selectedIndices) {
                    if (idx >= 0 && idx < frame.coords.length) {
                        extractedFrame.coords.push(frame.coords[idx]);

                        if (frame.chains && idx < frame.chains.length) {
                            extractedFrame.chains.push(frame.chains[idx]);
                        }
                        if (sourcePlddt && idx < sourcePlddt.length) {
                            extractedFrame.plddts.push(sourcePlddt[idx]);
                        }
                        if (frame.position_types && idx < frame.position_types.length) {
                            extractedFrame.position_types.push(frame.position_types[idx]);
                        }
                        if (frame.position_names && idx < frame.position_names.length) {
                            extractedFrame.position_names.push(frame.position_names[idx]);
                        }
                        if (frame.residue_numbers && idx < frame.residue_numbers.length) {
                            extractedFrame.residue_numbers.push(frame.residue_numbers[idx]);
                        }
                    }
                }

                // Filter PAE matrix if present (use resolved PAE data)
                if (sourcePae && Array.isArray(sourcePae) && sourcePae.length > 0) {
                    // Create new PAE matrix with only selected positions
                    const newPAE = [];
                    for (let i = 0; i < selectedIndices.length; i++) {
                        const row = [];
                        for (let j = 0; j < selectedIndices.length; j++) {
                            const originalI = selectedIndices[i];
                            const originalJ = selectedIndices[j];
                            if (originalI < sourcePae.length && originalJ < sourcePae[originalI].length) {
                                row.push(sourcePae[originalI][originalJ]);
                            } else {
                                row.push(0); // Default value if out of bounds
                            }
                        }
                        newPAE.push(row);
                    }
                    extractedFrame.pae = newPAE;
                }

                // Filter bonds if present
                if (frame.bonds && Array.isArray(frame.bonds) && frame.bonds.length > 0) {
                    const selectedIndicesSet = new Set(selectedIndices);
                    // Create mapping from original indices to new indices
                    const indexMap = new Map();
                    for (let newIdx = 0; newIdx < selectedIndices.length; newIdx++) {
                        indexMap.set(selectedIndices[newIdx], newIdx);
                    }

                    // Extract bonds where both endpoints are in selection
                    const extractedBonds = [];
                    for (const [idx1, idx2] of frame.bonds) {
                        if (selectedIndicesSet.has(idx1) && selectedIndicesSet.has(idx2)) {
                            const newIdx1 = indexMap.get(idx1);
                            const newIdx2 = indexMap.get(idx2);
                            extractedBonds.push([newIdx1, newIdx2]);
                        }
                    }
                    if (extractedBonds.length > 0) {
                        extractedFrame.bonds = extractedBonds;
                    }
                }

                // Add extracted frame to new object
                this.addFrame(extractedFrame, extractName);
            }

            // Extract MSA data for selected positions if MSA exists
            if (object.msa && object.msa.msasBySequence && object.msa.chainToSequence) {
                const extractedObject = this.objectsData[extractName];
                if (extractedObject) {
                    // Extract MSA data for the selected positions
                    this._extractMSADataForSelection(object, extractedObject, firstFrame, selectedIndices);
                }
            }

            // Reset selection to show all positions in extracted object
            this.setSelection({
                positions: new Set(),
                chains: new Set(),
                paeBoxes: [],
                selectionMode: 'default'
            });

            // Update UI controls to reflect new object
            this.updateUIControls();

            // Update PAE container visibility
            this.updatePAEContainerVisibility();

            // Force sequence viewer to rebuild for the new object
            if (typeof window !== 'undefined' && window.SequenceViewer && window.SequenceViewer.buildSequenceView) {
                // Clear sequence viewer cache to force rebuild
                if (window.SequenceViewer.clear) {
                    window.SequenceViewer.clear();
                }
                // Rebuild sequence view for the new extracted object
                window.SequenceViewer.buildSequenceView();
            }

            // Trigger object change event to ensure all UI updates
            if (this.objectSelect) {
                this.objectSelect.dispatchEvent(new Event('change'));
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
        _extractMSADataForSelection(sourceObject, extractedObject, frame, selectedIndices) {
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

            // Check if extractChainSequences is available (from app.js)
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
                // This must be done because the extracted sequences are different from the original
                if (typeof window !== 'undefined' && typeof window.computeMSAProperties === 'function') {
                    window.computeMSAProperties(extractedMSAData);
                }

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
        }

        // Set the current frame and render it
        setFrame(frameIndex, skipRender = false) {
            frameIndex = parseInt(frameIndex);

            // Handle clearing the canvas based on transparency
            const clearCanvas = () => {
                // Use cached display dimensions
                const displayWidth = this.displayWidth;
                const displayHeight = this.displayHeight;
                if (this.isTransparent) {
                    this.ctx.clearRect(0, 0, displayWidth, displayHeight);
                } else {
                    this.ctx.fillStyle = '#ffffff';
                    this.ctx.fillRect(0, 0, displayWidth, displayHeight);
                }
            };

            // Handle null object name
            if (!this.currentObjectName) {
                this.currentFrame = -1;
                this.coords = [];
                clearCanvas();
                if (this.paeRenderer) { this.paeRenderer.setData(null); }
                this.updateUIControls();
                // Prevent "spinning wheel" on reload
                this.setUIEnabled(true);
                return;
            }

            const object = this.objectsData[this.currentObjectName];
            if (!object || frameIndex < 0 || frameIndex >= object.frames.length) {
                this.currentFrame = -1;
                this.coords = [];
                clearCanvas();
                if (this.paeRenderer) { this.paeRenderer.setData(null); }
                this.updateUIControls();
                this.setUIEnabled(true); // Enable, even if frame is invalid (so user can change obj)
                return;
            }

            this.currentFrame = frameIndex;

            // Load frame data and render immediately for manual frame changes (e.g., slider)
            this._loadFrameData(frameIndex, true); // Load without render

            // Apply selection mask after frame data is loaded (in case selection was restored during object switch)
            this._composeAndApplyMask(skipRender); // skip3DRender if requested

            if (!skipRender) {
                this.render('setFrame'); // Render once unless skipped
            }
            this.lastRenderedFrame = frameIndex;

            // Update PAE container visibility
            this.updatePAEContainerVisibility();

            this.setUIEnabled(true); // Make sure controls are enabled
        }

        // Check if PAE data is valid
        _isValidPAE(pae) {
            if (!pae) return false;
            // Standard array or TypedArray
            if ((Array.isArray(pae) && pae.length > 0) || (pae.buffer && pae.length > 0)) return true;
            // Array-like object (JSON serialized Uint8Array)
            if (typeof pae === 'object' && typeof pae.length !== 'number') {
                // Check if it has keys that look like indices
                const keys = Object.keys(pae);
                return keys.length > 0 && !isNaN(parseInt(keys[0]));
            }
            return false;
        }

        // Check if frame has valid plddt data
        _hasPlddtData(frame) {
            return frame && frame.plddts && Array.isArray(frame.plddts) && frame.plddts.length > 0;
        }

        // Check if frame has valid PAE data
        _hasPaeData(frame) {
            return this._isValidPAE(frame && frame.pae);
        }

        // Resolve plddt data for a frame (returns actual data or null)
        // Searches backward from frameIndex to find most recent frame with plddt
        _resolvePlddtData(object, frameIndex) {
            if (frameIndex < 0 || frameIndex >= object.frames.length) return null;

            // Check current frame first
            if (this._hasPlddtData(object.frames[frameIndex])) {
                return object.frames[frameIndex].plddts;
            }

            // Use object-level tracking for optimization (if available and valid)
            if (object._lastPlddtFrame >= 0 && object._lastPlddtFrame < frameIndex) {
                if (this._hasPlddtData(object.frames[object._lastPlddtFrame])) {
                    return object.frames[object._lastPlddtFrame].plddts;
                }
            }

            // Search backward for most recent frame with plddt
            for (let i = frameIndex - 1; i >= 0; i--) {
                if (this._hasPlddtData(object.frames[i])) {
                    return object.frames[i].plddts;
                }
            }

            return null;
        }

        // Resolve PAE data for a frame (returns actual data or null)
        // Searches backward from frameIndex to find most recent frame with PAE
        _resolvePaeData(object, frameIndex) {
            if (frameIndex < 0 || frameIndex >= object.frames.length) return null;

            // Check current frame first
            if (this._hasPaeData(object.frames[frameIndex])) {
                return object.frames[frameIndex].pae;
            }

            // Use object-level tracking for optimization (if available and valid)
            if (object._lastPaeFrame >= 0 && object._lastPaeFrame < frameIndex) {
                if (this._hasPaeData(object.frames[object._lastPaeFrame])) {
                    return object.frames[object._lastPaeFrame].pae;
                }
            }

            // Search backward for most recent frame with PAE
            for (let i = frameIndex - 1; i >= 0; i--) {
                if (this._hasPaeData(object.frames[i])) {
                    return object.frames[i].pae;
                }
            }

            return null;
        }

        // Find PAE container with fallback logic
        _findPAEContainer() {
            if (this.paeContainer) return this.paeContainer;

            if (this.canvas && this.canvas.parentElement) {
                const mainContainer = this.canvas.parentElement.closest('#mainContainer');
                if (mainContainer) {
                    this.paeContainer = mainContainer.querySelector('#paeContainer');
                    if (this.paeContainer) return this.paeContainer;
                }
            }

            this.paeContainer = document.querySelector('#paeContainer');
            return this.paeContainer;
        }

        // Check if an object has PAE data (can be called with object name or uses current object)
        objectHasPAE(objectName = null) {
            const name = objectName || this.currentObjectName;
            if (!name || !this.objectsData[name]) return false;

            const object = this.objectsData[name];
            if (!object.frames || object.frames.length === 0) return false;

            // Check if any frame has valid PAE data (directly or via inheritance)
            // If first frame has PAE, all frames can inherit; otherwise check if any frame has it
            if (object.frames.length > 0) {
                // Check first frame - if it has PAE, all can inherit
                if (this._hasPaeData(object.frames[0])) {
                    return true;
                }
                // Otherwise, check if any frame has PAE
                return object.frames.some(frame => this._hasPaeData(frame));
            }

            return false;
        }

        // Update PAE container visibility based on current object's PAE data
        updatePAEContainerVisibility() {
            const paeContainer = this._findPAEContainer();
            if (!paeContainer) return;

            const hasPAE = this.objectHasPAE();
            paeContainer.style.display = hasPAE ? 'flex' : 'none';

            const paeCanvas = paeContainer.querySelector('#paeCanvas');
            if (paeCanvas) {
                paeCanvas.style.display = hasPAE ? 'block' : 'none';
            }
        }

        // Update outline button style based on current mode
        updateOutlineButtonStyle() {
            if (!this.outlineModeButton) return;

            // Get the inner span element (the actual styled element)
            const spanElement = this.outlineModeButton.querySelector('span');
            if (!spanElement) return;

            // Remove all mode classes from button
            this.outlineModeButton.classList.remove('outline-none', 'outline-partial', 'outline-full');

            // Reset all inline styles first (on the span, not the button)
            spanElement.style.backgroundColor = '';
            spanElement.style.border = '';
            spanElement.style.color = '';
            spanElement.style.fontWeight = '';
            spanElement.style.transition = 'none'; // Disable animations

            // Apply appropriate class and style based on mode
            // All modes use grey background, only border style differs
            if (this.outlineMode === 'none') {
                this.outlineModeButton.classList.add('outline-none');
                spanElement.style.backgroundColor = '#e5e7eb'; // light grey background
                spanElement.style.border = '3px solid #e5e7eb'; // match background color to make border invisible
                spanElement.style.color = '#000000';
                spanElement.style.fontWeight = '500';
            } else if (this.outlineMode === 'partial') {
                this.outlineModeButton.classList.add('outline-partial');
                spanElement.style.backgroundColor = '#e5e7eb'; // grey background
                spanElement.style.border = '3px dashed #000000';
                spanElement.style.color = '#000000';
                spanElement.style.fontWeight = '500';
            } else { // full
                this.outlineModeButton.classList.add('outline-full');
                spanElement.style.backgroundColor = '#e5e7eb'; // grey background
                spanElement.style.border = '3px solid #000000';
                spanElement.style.color = '#000000';
                spanElement.style.fontWeight = '500';
            }
        }

        // Update UI element states (e.g., disabled)
        setUIEnabled(enabled) {
            this.playButton.disabled = !enabled;
            this.frameSlider.disabled = !enabled;
            if (this.objectSelect) this.objectSelect.disabled = !enabled;
            this.speedSelect.disabled = !enabled;
            this.rotationCheckbox.disabled = !enabled;
            this.lineWidthSlider.disabled = !enabled;
            if (this.shadowEnabledCheckbox) this.shadowEnabledCheckbox.disabled = !enabled;
            if (this.outlineModeButton) this.outlineModeButton.disabled = !enabled;
            if (this.outlineModeSelect) this.outlineModeSelect.disabled = !enabled;
            if (this.depthCheckbox) this.depthCheckbox.disabled = !enabled;
            if (this.colorblindCheckbox) this.colorblindCheckbox.disabled = !enabled;
            if (this.orthoSlider) this.orthoSlider.disabled = !enabled;
            this.canvas.style.cursor = enabled ? 'grab' : 'wait';
        }

        // Update the text/slider values
        updateUIControls() {
            if (!this.playButton) return;

            // Handle null object
            const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
            const total = object ? object.frames.length : 0;
            const current = Math.max(0, this.currentFrame) + 1;

            // Check config.controls before showing
            const config = window.viewerConfig || {};
            if (total <= 1 || !config.controls) {
                this.controlsContainer.style.display = 'none';
            } else {
                this.controlsContainer.style.display = 'flex';
            }

            // Get container element from canvas (for finding parent containers)
            const containerElement = this.canvas ? this.canvas.closest('.py2dmol-container') ||
                this.canvas.parentElement?.closest('#mainContainer')?.parentElement : null;

            // Count number of objects
            const objectCount = Object.keys(this.objectsData).length;

            // Handle object selection dropdown visibility
            if (this.objectSelect) {
                // Hide object dropdown if only 1 object
                const objectSelectParent = this.objectSelect.closest('.toggle-item') ||
                    this.objectSelect.parentElement;
                if (objectSelectParent) {
                    objectSelectParent.style.display = (objectCount <= 1) ? 'none' : 'flex';
                }

                // Also handle container visibility (for backward compatibility)
                if (containerElement) {
                    const mainControlsContainer = containerElement.querySelector('#mainControlsContainer');
                    const objectContainer = containerElement.querySelector('#objectContainer');

                    // Prioritize new structure, then old structure
                    // Don't hide styleAppearanceContainer as it contains other controls in index.html
                    const containerToShow = mainControlsContainer || objectContainer;
                    if (containerToShow) {
                        // Always show if controls are enabled (regardless of number of objects)
                        containerToShow.style.display = config.controls ? 'flex' : 'none';
                    }
                }
            }

            this.frameSlider.max = Math.max(0, total - 1);

            // Don't update slider value while user is dragging it
            if (!this.isSliderDragging) {
                this.frameSlider.value = this.currentFrame;
            }

            this.frameCounter.textContent = `${total > 0 ? current : 0} / ${total}`;

            // Update overlay button
            if (this.overlayButton) {
                // Disable overlay button if only 1 frame
                this.overlayButton.disabled = (total <= 1);

                // Hide overlay button if only 1 frame
                this.overlayButton.style.display = (total <= 1) ? 'none' : '';
            }

            // Unified frame control state
            const shouldDisableFrameControls = this.overlayMode || (total <= 1);

            // Update play button - checkbox style (grey when off, blue when on)
            if (this.playButton) {
                const hasIcon = this.playButton.querySelector('i');
                if (hasIcon) {
                    // Web version with Font Awesome - use icons
                    this.playButton.innerHTML = this.isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
                    // Checkbox-style: change button class based on state
                    if (this.isPlaying) {
                        this.playButton.classList.remove('btn-secondary');
                        this.playButton.classList.add('btn-primary');
                    } else {
                        this.playButton.classList.remove('btn-primary');
                        this.playButton.classList.add('btn-secondary');
                    }
                } else {
                    // Use symbols for play/pause
                    this.playButton.innerHTML = '';
                    this.playButton.textContent = this.isPlaying ? '⏸' : '▶︎';
                }
                this.playButton.disabled = shouldDisableFrameControls;
            }

            // Update record button - checkbox style (grey when off, red when on)
            if (this.recordButton) {
                const icon = this.recordButton.querySelector('i');
                if (icon) {
                    // index.html: has icon with Font Awesome
                    if (this.isRecording) {
                        icon.className = 'fa-solid fa-stop';
                        this.recordButton.classList.remove('btn-secondary');
                        this.recordButton.classList.add('btn-danger');
                    } else {
                        icon.className = 'fa-solid fa-video';
                        this.recordButton.classList.remove('btn-danger');
                        this.recordButton.classList.add('btn-secondary');
                    }
                } else {
                    // viewer.html: just emoji, change button background color
                    if (this.isRecording) {
                        this.recordButton.style.background = '#ef4444';
                        this.recordButton.style.color = '#fff';
                        this.recordButton.style.borderColor = '#dc2626';
                    } else {
                        this.recordButton.style.background = '';
                        this.recordButton.style.color = '';
                        this.recordButton.style.borderColor = '';
                    }
                }
                const canRecord = this.currentObjectName &&
                    this.objectsData[this.currentObjectName] &&
                    this.objectsData[this.currentObjectName].frames.length >= 2;
                // Disable if can't record OR if frame controls are disabled
                this.recordButton.disabled = !canRecord || shouldDisableFrameControls;

                // Hide record button if only 1 frame
                const recordButtonParent = this.recordButton.closest('.toggle-item');
                if (recordButtonParent) {
                    // viewer.html: hide the toggle-item container
                    recordButtonParent.style.display = (total <= 1) ? 'none' : 'flex';
                } else {
                    // index.html: hide the button itself
                    this.recordButton.style.display = (total <= 1) ? 'none' : '';
                }
            }

            // Update frame slider
            if (this.frameSlider) {
                this.frameSlider.disabled = this.overlayMode;
                this.frameSlider.style.opacity = this.overlayMode ? '0.5' : '';
            }
        }

        // Toggle play/pause
        togglePlay() {
            if (this.isPlaying) {
                this.stopAnimation();
            } else {
                // Ensure we're not in a recording state when starting normal playback
                if (this.isRecording) {
                    console.warn("Cannot start playback while recording");
                    return;
                }
                // Ensure we're not in overlay mode
                if (this.overlayMode) {
                    console.warn("Cannot start playback while in overlay mode");
                    return;
                }
                this.startAnimation();
            }
        }

        // Toggle overlay mode (merge all frames in same view)
        toggleOverlay() {
            // Stop any playing animation
            if (this.isPlaying) {
                this.stopAnimation();
            }

            // Toggle overlay mode
            this.overlayMode = !this.overlayMode;

            if (this.overlayMode) {
                // Entering overlay mode - merge all frames
                if (!this.currentObjectName) return;

                const object = this.objectsData[this.currentObjectName];
                if (!object || object.frames.length === 0) return;

                // Store pre-merge auto color for use with 'auto' color mode
                // This is based on the first frame before merging
                // Determine auto color mode based on first frame characteristics
                const firstFrame = object.frames[0];
                if (firstFrame) {
                    const firstFrameChains = firstFrame.chains || [];
                    const uniqueFirstChains = new Set(firstFrameChains);
                    const hasFirstPAE = firstFrame.pae && firstFrame.pae.length > 0;

                    if (hasFirstPAE) {
                        this.overlayAutoColor = 'plddt';
                    } else if (uniqueFirstChains.size > 1) {
                        this.overlayAutoColor = 'chain';
                    } else {
                        this.overlayAutoColor = 'rainbow';
                    }
                } else {
                    this.overlayAutoColor = 'rainbow';
                }

                // Merge frame data with unique chain IDs per frame
                const frameRange = this.overlayFrameRange || [0, object.frames.length - 1];
                const startFrame = Math.max(0, frameRange[0]);
                const endFrame = Math.min(object.frames.length - 1, frameRange[1]);

                const mergedCoords = [];
                const mergedPlddts = [];
                const mergedChains = [];
                const mergedPositionTypes = [];
                const mergedPositionNames = [];
                const mergedResidueNumbers = [];
                const mergedBonds = [];
                const frameIdMap = [];

                // Chain IDs to use for each frame (so segment builder separates them)
                const chainIds = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

                for (let frameIdx = startFrame; frameIdx <= endFrame; frameIdx++) {
                    const frame = object.frames[frameIdx];
                    const frameCoords = frame.coords || [];
                    const frameBonds = frame.bonds || [];
                    const frameChains = frame.chains || Array(frameCoords.length).fill('A');
                    const atomOffset = mergedCoords.length;
                    const frameAtomCount = frameCoords.length;

                    // Merge coords
                    for (let i = 0; i < frameAtomCount; i++) {
                        mergedCoords.push(frameCoords[i]);
                        frameIdMap.push(frameIdx);
                    }

                    // Merge data fields - always create arrays with frameAtomCount elements
                    const plddts = frame.plddts && frame.plddts.length === frameAtomCount ? frame.plddts : Array(frameAtomCount).fill(50.0);
                    const positionTypes = frame.position_types && frame.position_types.length === frameAtomCount ? frame.position_types : Array(frameAtomCount).fill('P');
                    const positionNames = frame.position_names && frame.position_names.length === frameAtomCount ? frame.position_names : Array(frameAtomCount).fill('UNK');
                    const residueNumbers = frame.residue_numbers && frame.residue_numbers.length === frameAtomCount ? frame.residue_numbers : Array.from({ length: frameAtomCount }, (_, i) => i + 1);

                    mergedPlddts.push(...plddts);
                    mergedPositionTypes.push(...positionTypes);
                    mergedPositionNames.push(...positionNames);
                    mergedResidueNumbers.push(...residueNumbers);

                    // Preserve original chain IDs from this frame
                    for (let i = 0; i < frameAtomCount; i++) {
                        mergedChains.push(frameChains[i] || 'A');
                    }

                    // Merge bonds with adjusted indices
                    for (let i = 0; i < frameBonds.length; i++) {
                        const bond = frameBonds[i];
                        mergedBonds.push([bond[0] + atomOffset, bond[1] + atomOffset]);
                    }
                }

                // Store overlay-specific data
                this.frameIdMap = frameIdMap;
                this.cachedSegmentIndices = null;
                this.cachedSegmentIndicesFrame = -1;
                this.cachedSegmentIndicesObjectName = null;

                // Load merged data
                const mergedData = {
                    coords: mergedCoords,
                    plddts: mergedPlddts,
                    chains: mergedChains,
                    position_types: mergedPositionTypes,
                    position_names: mergedPositionNames,
                    residue_numbers: mergedResidueNumbers,
                    pae: this.pae || null,
                    bonds: mergedBonds.length > 0 ? mergedBonds : null
                };


                this._loadDataIntoRenderer(mergedData, false);

            } else {
                // Exiting overlay mode - return to single frame view
                this.overlayFrames = null;
                this.overlayAutoColor = null;
                this.frameIdMap = null;

                // Invalidate segment cache to force rebuild from single-frame data
                this.cachedSegmentIndices = null;
                this.cachedSegmentIndicesFrame = -1;
                this.cachedSegmentIndicesObjectName = null;

                const currentFrame = Math.max(0, this.currentFrame);
                this.setFrame(currentFrame);
            }

            // Update overlay button styling - checkbox style
            if (this.overlayButton) {
                if (this.overlayMode) {
                    this.overlayButton.classList.remove('btn-secondary');
                    this.overlayButton.classList.add('btn-primary');
                } else {
                    this.overlayButton.classList.remove('btn-primary');
                    this.overlayButton.classList.add('btn-secondary');
                }
            }

            this.updateUIControls();
        }

        // Start playback
        startAnimation() {
            // Check for null
            if (!this.currentObjectName) return;
            const object = this.objectsData[this.currentObjectName];
            if (!object || object.frames.length < 2) return;

            // If we're at the last frame and not recording, reset to first frame for looping
            if (!this.isRecording && this.currentFrame >= object.frames.length - 1) {
                this.currentFrame = 0;
                this._loadFrameData(0, true); // Load without render
            }

            this.isPlaying = true;

            // Start independent timer for frame advancement
            if (this.frameAdvanceTimer) {
                clearInterval(this.frameAdvanceTimer);
            }

            this.frameAdvanceTimer = setInterval(() => {
                if (this.isPlaying && this.currentObjectName) {
                    // Skip if recording (recording uses its own sequential method)
                    if (this.isRecording) {
                        return; // Recording handles its own frame advancement
                    }

                    const obj = this.objectsData[this.currentObjectName];
                    if (obj && obj.frames.length > 1) {
                        let nextFrame = this.currentFrame + 1;

                        // Normal playback - loop
                        if (nextFrame >= obj.frames.length) {
                            nextFrame = 0;
                        }

                        // Update the frame index - render loop will pick it up
                        this.currentFrame = nextFrame;
                        this._loadFrameData(nextFrame, true); // Load without render
                        this.updateUIControls(); // Update slider
                    } else {
                        this.stopAnimation();
                    }
                }
            }, this.animationSpeed);

            this.updateUIControls();
        }

        // Stop playback
        stopAnimation() {
            this.isPlaying = false;

            // Clear frame advancement timer
            if (this.frameAdvanceTimer) {
                clearInterval(this.frameAdvanceTimer);
                this.frameAdvanceTimer = null;
            }

            // Clear recording sequence if active
            if (this.recordingFrameSequence) {
                clearTimeout(this.recordingFrameSequence);
                this.recordingFrameSequence = null;
            }

            this.updateUIControls();
        }

        // Sequential frame recording (ensures all frames are captured)
        recordFrameSequence() {
            if (!this.isRecording) return;

            const object = this.objectsData[this.currentObjectName];
            if (!object) {
                this.stopRecording();
                return;
            }

            const currentFrame = this.currentFrame;

            // Check if we've reached the end
            if (currentFrame > this.recordingEndFrame) {
                this.stopRecording();
                return;
            }

            // Load and render current frame
            this._loadFrameData(currentFrame, true); // Load without render
            this.render();
            this.lastRenderedFrame = currentFrame;
            this.updateUIControls();

            // Wait for frame to be captured, then advance
            // Use requestAnimationFrame to ensure render is complete
            requestAnimationFrame(() => {
                // Give MediaRecorder time to capture (MediaRecorder captures at 30fps = ~33ms per frame)
                // Use animationSpeed or minimum 50ms to ensure capture
                const captureDelay = Math.max(50, this.animationSpeed);

                this.recordingFrameSequence = setTimeout(() => {
                    // Advance to next frame
                    this.currentFrame = currentFrame + 1;
                    // Recursively record next frame
                    this.recordFrameSequence();
                }, captureDelay);
            });
        }

        // Toggle recording
        toggleRecording() {
            if (this.isRecording) {
                this.stopRecording();
            } else {
                this.startRecording();
            }
        }

        // Start recording animation
        startRecording() {
            // Check if we have frames to record
            if (!this.currentObjectName) {
                console.warn("Cannot record: No object loaded");
                return;
            }

            const object = this.objectsData[this.currentObjectName];
            if (!object || object.frames.length < 2) {
                console.warn("Cannot record: Need at least 2 frames");
                return;
            }

            // Check if MediaRecorder is supported
            if (typeof MediaRecorder === 'undefined' || !this.canvas.captureStream) {
                console.error("Recording not supported in this browser");
                alert("Video recording is not supported in this browser. Please use Chrome, Edge, or Firefox.");
                return;
            }

            // Stop any existing animation first
            this.stopAnimation();

            // Clean up any existing recording state first
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                try {
                    this.mediaRecorder.stop();
                } catch (e) {
                    console.warn("Error stopping existing recorder:", e);
                }
            }
            this._stopRecordingTracks();
            this.mediaRecorder = null;
            this.recordedChunks = [];

            // Set recording state
            this.isRecording = true;
            this.recordingEndFrame = object.frames.length - 1;

            // Disable interaction during recording
            this.isDragging = false; // Stop any active drag
            this.spinVelocityX = 0; // Stop inertia
            this.spinVelocityY = 0; // Stop inertia
            // Temporarily disable drag by preventing mousedown
            this.canvas.style.pointerEvents = 'none'; // Disable all mouse interaction

            // Capture stream from canvas at 30fps for smooth playback
            const fps = 30;
            this.recordingStream = this.canvas.captureStream(fps);

            // Set up MediaRecorder with very low compression (very high quality)
            const options = {
                mimeType: 'video/webm;codecs=vp9', // VP9 for better quality
                videoBitsPerSecond: 20000000 // 20 Mbps for very high quality (very low compression)
            };

            // Fallback to VP8 if VP9 not supported
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm;codecs=vp8';
                options.videoBitsPerSecond = 15000000; // 15 Mbps for VP8
            }

            // Fallback to default if neither supported
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm';
                options.videoBitsPerSecond = 15000000;
            }

            try {
                this.mediaRecorder = new MediaRecorder(this.recordingStream, options);

                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        this.recordedChunks.push(event.data);
                    }
                };

                this.mediaRecorder.onstop = () => {
                    this.finishRecording();
                };

                this.mediaRecorder.onerror = (event) => {
                    console.error("MediaRecorder error:", event.error);
                    this.isRecording = false;
                    this.updateUIControls();
                    alert("Recording error: " + event.error.message);
                };

                // Start recording
                this.mediaRecorder.start(100); // Collect data every 100ms

                // Update UI to show recording state
                this.updateUIControls();

                // Stop any existing animation first
                this.stopAnimation();

                // Go to first frame (this will render frame 0)
                this.setFrame(0);

                // Start sequential recording (don't use startAnimation)
                // Wait a moment for MediaRecorder to start capturing
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        // Start sequential frame recording
                        this.recordFrameSequence();
                    });
                });

            } catch (error) {
                console.error("Failed to start recording:", error);
                this.isRecording = false;
                this.updateUIControls();
                alert("Failed to start recording: " + error.message);
            }
        }

        // Stop recording
        stopRecording() {
            if (!this.isRecording) {
                return;
            }

            // Stop sequential recording
            if (this.recordingFrameSequence) {
                clearTimeout(this.recordingFrameSequence);
                this.recordingFrameSequence = null;
            }

            // Re-enable interaction
            this.canvas.style.pointerEvents = 'auto'; // Re-enable mouse interaction

            // Stop animation (this also clears interval timer)
            this.stopAnimation();

            // Stop MediaRecorder
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }

            // Stop stream
            this._stopRecordingTracks();
        }

        // Finish recording and download file
        finishRecording() {
            if (this.recordedChunks.length === 0) {
                console.warn("No video data recorded");
                this.isRecording = false;
                this.mediaRecorder = null;
                if (this.recordingStream) {
                    this.recordingStream.getTracks().forEach(track => track.stop());
                    this.recordingStream = null;
                }
                // Ensure animation is stopped and state is clean
                this.stopAnimation();
                this.updateUIControls();
                return;
            }

            // Create blob from recorded chunks
            const blob = new Blob(this.recordedChunks, { type: 'video/webm' });

            // Create download link
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `py2dmol_animation_${this.currentObjectName || 'recording'}_${Date.now()}.webm`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Clean up
            URL.revokeObjectURL(url);

            // Clean up all recording state
            this.recordedChunks = [];
            this.isRecording = false;
            this.mediaRecorder = null;
            this._stopRecordingTracks();

            // Ensure animation is fully stopped and state is clean
            this.stopAnimation();

            this.updateUIControls();
        }

        // Clear all objects
        clearAllObjects() {
            this.stopAnimation();

            // Reset data
            this.objectsData = {};
            this.currentObjectName = null;

            // Reset object dropdown
            if (this.objectSelect) {
                this.objectSelect.innerHTML = ''; // Clear all options
            }

            // Clear PAE
            if (this.paeRenderer) {
                this.paeRenderer.setData(null);
            }

            // Set to empty frame, which clears canvas and updates UI
            this.setFrame(-1);
        }

        // Comprehensive reset method - resets all controls and state to defaults
        resetAll() {
            // Stop all active operations
            if (this.isPlaying) {
                this.stopAnimation();
            }
            if (this.isRecording) {
                this.stopRecording();
            }

            // Clear all objects
            this.clearAllObjects();

            // Reset camera to initial state
            this.rotationMatrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            this.zoom = 1.0;
            this.perspectiveEnabled = false;
            this.focalLength = 200.0;
            this.temporaryCenter = null;
            this.temporaryExtent = null;
            this.isDragging = false;
            this.spinVelocityX = 0;
            this.spinVelocityY = 0;

            // Reset renderer state to defaults
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;
            this.shadowEnabled = true;
            this.outlineMode = 'full';
            this.autoRotate = false;
            this.colorblindMode = false;
            this.lineWidth = 3.0;
            this.animationSpeed = 100;
            this.currentFrame = -1;
            this.lastRenderedFrame = -1;
            if (this.shadowEnabledCheckbox) {
                this.shadowEnabledCheckbox.checked = true;
            }
            if (this.depthCheckbox) {
                this.depthCheckbox.checked = true;
            }
            if (this.outlineModeButton) {
                this.outlineMode = 'full';
                this.updateOutlineButtonStyle();
            } else if (this.outlineModeSelect) {
                this.outlineMode = 'full';
                this.outlineModeSelect.value = 'full';
            }
            if (this.rotationCheckbox) {
                this.rotationCheckbox.checked = false;
            }
            if (this.colorblindCheckbox) {
                this.colorblindCheckbox.checked = false;
            }
            if (this.lineWidthSlider) {
                this.lineWidthSlider.value = '3.0';
            }
            if (this.orthoSlider) {
                this.orthoSlider.value = '1.0';
                // Update camera perspective - trigger input event to update camera
                this.orthoSlider.dispatchEvent(new Event('input'));
            }
            if (this.frameSlider) {
                this.frameSlider.value = '0';
                this.frameSlider.max = '0';
            }
            if (this.frameCounter) {
                this.frameCounter.textContent = '0/0';
            }
            if (this.playButton) {
                this.playButton.textContent = '▶︎';
            }
            if (this.recordButton) {
                this.recordButton.classList.remove('btn-toggle');
                this.recordButton.disabled = false;
            }

            // Clear selection
            this.clearSelection();

            // Update UI controls
            this.updateUIControls();

            // Trigger render to show empty state
            this.render();
        }

        _loadDataIntoRenderer(data, skipRender = false) {
            if (data && data.coords && data.coords.length > 0) {
                const coords = data.coords.map(c => new Vec3(c[0], c[1], c[2]));
                // Pass other data fields directly, allowing them to be undefined
                this.setCoords(
                    coords,
                    data.plddts,
                    data.chains,
                    data.position_types,
                    (data.pae && data.pae.length > 0),
                    data.position_names,
                    data.residue_numbers,
                    skipRender,
                    data.bonds
                );
            }
        }

        setCoords(coords, plddts, chains, positionTypes, hasPAE = false, positionNames, residueNumbers, skipRender = false, bonds = null) {
            this.coords = coords;

            // Set bonds from parameter or from object's stored bonds
            if (bonds !== null && bonds !== undefined) {
                // Frame has explicit bonds - use them
                this.bonds = bonds;
                // Store in object for reuse
                if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                    this.objectsData[this.currentObjectName].bonds = bonds;
                }
            } else if (this.currentObjectName && this.objectsData[this.currentObjectName] && this.objectsData[this.currentObjectName].bonds) {
                // No bonds for this frame - use object's stored bonds
                this.bonds = this.objectsData[this.currentObjectName].bonds;
            } else {
                // No bonds - will use distance calculation
                this.bonds = null;
            }

            const n = this.coords.length;

            // Ensure colorMode is valid
            const validModes = ['auto', 'chain', 'rainbow', 'plddt', 'deepmind', 'entropy'];
            if (!this.colorMode || !validModes.includes(this.colorMode)) {
                this.colorMode = 'auto';
            }

            // Map entropy to structure if entropy mode is active
            if (this.colorMode === 'entropy') {
                this._mapEntropyToStructure();
            } else {
                // Clear entropy when not in entropy mode
                this.entropy = undefined;
                this._updateEntropyOptionVisibility();
            }

            // Mark colors as needing update when coordinates change
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;

            // --- Handle Data Inheritance and Defaults ---
            // Use provided data if available, otherwise inherit from cache, otherwise use defaults

            // plddts: inherit from previous frame if not provided
            if (plddts && plddts.length === n) {
                this.plddts = plddts;
                this.cachedPlddts = plddts;
            } else if (this.cachedPlddts && this.cachedPlddts.length === n) {
                this.plddts = this.cachedPlddts; // Inherit
            } else {
                this.plddts = Array(n).fill(50.0); // Default
            }

            // chains: inherit from previous frame if not provided
            if (chains && chains.length === n) {
                this.chains = chains;
                this.cachedChains = chains;
            } else if (this.cachedChains && this.cachedChains.length === n) {
                this.chains = this.cachedChains; // Inherit
            } else {
                this.chains = Array(n).fill('A'); // Default
            }

            // positionTypes: inherit from previous frame if not provided
            if (positionTypes && positionTypes.length === n) {
                this.positionTypes = positionTypes;
                this.cachedPositionTypes = positionTypes;
            } else if (this.cachedPositionTypes && this.cachedPositionTypes.length === n) {
                this.positionTypes = this.cachedPositionTypes; // Inherit
            } else {
                this.positionTypes = Array(n).fill('P'); // Default
            }

            // positionNames: inherit from previous frame if not provided
            if (positionNames && positionNames.length === n) {
                this.positionNames = positionNames;
                this.cachedPositionNames = positionNames;
            } else if (this.cachedPositionNames && this.cachedPositionNames.length === n) {
                this.positionNames = this.cachedPositionNames; // Inherit
            } else {
                this.positionNames = Array(n).fill('UNK'); // Default
            }

            // residueNumbers: inherit from previous frame if not provided
            if (residueNumbers && residueNumbers.length === n) {
                this.residueNumbers = residueNumbers;
                this.cachedResidueNumbers = residueNumbers;
            } else if (this.cachedResidueNumbers && this.cachedResidueNumbers.length === n) {
                this.residueNumbers = this.cachedResidueNumbers; // Inherit
            } else {
                this.residueNumbers = Array.from({ length: n }, (_, i) => i + 1); // Default
            }

            // Calculate what 'auto' should resolve to
            // Priority: plddt (if PAE present) > chain (if multi-chain) > rainbow
            // In overlay mode, use pre-merge auto color based on first frame
            const uniqueChains = new Set(this.chains);
            if (this.overlayMode && this.overlayAutoColor) {
                this.resolvedAutoColor = this.overlayAutoColor;
            } else {
                if (hasPAE) {
                    this.resolvedAutoColor = 'plddt';
                } else if (uniqueChains.size > 1) {
                    this.resolvedAutoColor = 'chain';
                } else {
                    this.resolvedAutoColor = 'rainbow';
                }
            }

            // Sync dropdown to renderer's colorMode (if dropdown exists)
            if (this.colorSelect && this.colorMode) {
                if (this.colorSelect.value !== this.colorMode) {
                    this.colorSelect.value = this.colorMode;
                }
            }

            // Create the definitive chain index map for this dataset.
            this.chainIndexMap = new Map();
            // Track which chains contain only ligands (no P/D/R atoms)
            this.ligandOnlyChains = new Set();
            if (this.chains.length > 0) {
                // Use a sorted list of unique chain IDs to ensure a consistent order
                const sortedUniqueChains = [...uniqueChains].sort();
                for (const chainId of sortedUniqueChains) {
                    if (chainId && !this.chainIndexMap.has(chainId)) {
                        this.chainIndexMap.set(chainId, this.chainIndexMap.size);
                    }
                }

                // Check each chain to see if it contains only ligands
                for (const chainId of sortedUniqueChains) {
                    let hasNonLigand = false;
                    for (let i = 0; i < n; i++) {
                        if (this.chains[i] === chainId) {
                            const type = this.positionTypes[i];
                            if (type === 'P' || type === 'D' || type === 'R') {
                                hasNonLigand = true;
                                break;
                            }
                        }
                    }
                    // If chain has no P/D/R atoms, it's ligand-only
                    if (!hasNonLigand) {
                        this.ligandOnlyChains.add(chainId);
                    }
                }
            }

            // No longer need polymerPositionIndices - all positions are treated the same
            // (One position = one position, no distinction between polymer/ligand)

            // Pre-calculate per-chain indices for rainbow coloring (N-to-C)
            // Include ligands in ligand-only chains for rainbow coloring
            this.perChainIndices = new Array(n);
            const chainIndices = {}; // Temporary tracker
            let lastFrame = -1; // Track frame changes for overlay mode

            for (let i = 0; i < n; i++) {
                const type = this.positionTypes[i];
                const chainId = this.chains[i] || 'A';
                const isLigandOnlyChain = this.ligandOnlyChains.has(chainId);

                // In overlay mode, reset chain indices when frame changes
                if (this.overlayMode && this.frameIdMap) {
                    const currentFrame = this.frameIdMap[i];
                    if (currentFrame !== lastFrame) {
                        // Frame changed, reset all chain counters
                        for (const key in chainIndices) {
                            chainIndices[key] = 0;
                        }
                        lastFrame = currentFrame;
                    }
                }

                if (type === 'P' || type === 'D' || type === 'R' || (type === 'L' && isLigandOnlyChain)) {
                    if (chainIndices[chainId] === undefined) {
                        chainIndices[chainId] = 0;
                    }
                    this.perChainIndices[i] = chainIndices[chainId];
                    chainIndices[chainId]++;
                } else {
                    this.perChainIndices[i] = 0; // Default for ligands in mixed chains
                }
            }

            // Pre-calculate rainbow scales
            // Include ligands in ligand-only chains for rainbow coloring
            this.chainRainbowScales = {};
            for (let i = 0; i < this.positionTypes.length; i++) {
                const type = this.positionTypes[i];
                const chainId = this.chains[i] || 'A';
                const isLigandOnlyChain = this.ligandOnlyChains.has(chainId);

                if (type === 'P' || type === 'D' || type === 'R' || (type === 'L' && isLigandOnlyChain)) {
                    if (!this.chainRainbowScales[chainId]) {
                        this.chainRainbowScales[chainId] = { min: Infinity, max: -Infinity };
                    }
                    const colorIndex = this.perChainIndices[i];
                    const scale = this.chainRainbowScales[chainId];
                    scale.min = Math.min(scale.min, colorIndex);
                    scale.max = Math.max(scale.max, colorIndex);
                }
            }

            // Compute ligand groups using shared utility function
            // This groups ligands by chain, residue_numbers, and position_names (if available)
            if (typeof groupLigandAtoms === 'function') {
                this.ligandGroups = groupLigandAtoms(
                    this.chains,
                    this.positionTypes,
                    this.residueNumbers,
                    this.positionNames
                );
            } else {
                // Fallback: empty map if utility function not available
                this.ligandGroups = new Map();
            }

            // Pre-allocate rotatedCoords array
            if (this.rotatedCoords.length !== n) {
                this.rotatedCoords = Array.from({ length: n }, () => new Vec3(0, 0, 0));
            }

            // Check if we can reuse cached segment indices (bonds don't change within a frame)
            const canUseCache = this.cachedSegmentIndices !== null &&
                this.cachedSegmentIndicesFrame === this.currentFrame &&
                this.cachedSegmentIndicesObjectName === this.currentObjectName &&
                this.cachedSegmentIndices.length > 0;

            if (canUseCache) {
                // Reuse cached segment indices (deep copy to avoid mutation)
                this.segmentIndices = this.cachedSegmentIndices.map(seg => ({ ...seg }));
            } else {
                // Generate Segment Definitions ONCE
                this.segmentIndices = [];
                const proteinChainbreak = 5.0;
                const nucleicChainbreak = 7.5;
                const ligandBondCutoff = 2.0;
                const proteinChainbreakSq = proteinChainbreak * proteinChainbreak;
                const nucleicChainbreakSq = nucleicChainbreak * nucleicChainbreak;
                const ligandBondCutoffSq = ligandBondCutoff * ligandBondCutoff;

                let firstPolymerIndex = -1;
                let lastPolymerIndex = -1;
                const ligandIndicesByChain = new Map(); // Group ligands by chain

                // Helper function to check if position type is polymer (for rendering only)
                const isPolymer = (type) => (type === 'P' || type === 'D' || type === 'R');
                const isPolymerArr = this.positionTypes.map(isPolymer);

                const getChainbreakDistSq = (type1, type2) => {
                    if ((type1 === 'D' || type1 === 'R') && (type2 === 'D' || type2 === 'R')) {
                        return nucleicChainbreakSq;
                    }
                    return proteinChainbreakSq;
                };

                for (let i = 0; i < n; i++) {
                    if (isPolymerArr[i]) {
                        const type = this.positionTypes[i];
                        if (firstPolymerIndex === -1) { firstPolymerIndex = i; }
                        lastPolymerIndex = i;

                        if (i < n - 1) {
                            if (isPolymerArr[i + 1]) {
                                const type1 = type;
                                const type2 = this.positionTypes[i + 1];
                                const samePolymerType = (type1 === type2) ||
                                    ((type1 === 'D' || type1 === 'R') && (type2 === 'D' || type2 === 'R'));

                                // In overlay mode, also check that both atoms are in the same frame
                                let sameFrame = true;
                                if (this.overlayMode && this.frameIdMap) {
                                    sameFrame = this.frameIdMap[i] === this.frameIdMap[i + 1];
                                }

                                if (samePolymerType && this.chains[i] === this.chains[i + 1] && sameFrame) {
                                    const start = this.coords[i];
                                    const end = this.coords[i + 1];
                                    const distSq = start.distanceToSq(end);
                                    const chainbreakDistSq = getChainbreakDistSq(type1, type2);

                                    if (distSq < chainbreakDistSq) {
                                        this.segmentIndices.push({
                                            idx1: i,
                                            idx2: i + 1,
                                            colorIndex: this.perChainIndices[i],
                                            origIndex: i,
                                            chainId: this.chains[i] || 'A',
                                            type: type1,
                                            len: Math.sqrt(distSq)
                                        });
                                    }
                                }
                            }
                        }
                    } else if (this.positionTypes[i] === 'L') {
                        // Group ligand indices by chain
                        const chainId = this.chains[i] || 'A';
                        if (!ligandIndicesByChain.has(chainId)) {
                            ligandIndicesByChain.set(chainId, []);
                        }
                        ligandIndicesByChain.get(chainId).push(i);
                    }
                }

                if (firstPolymerIndex !== -1 && lastPolymerIndex !== -1 && firstPolymerIndex !== lastPolymerIndex) {
                    const firstChainId = this.chains[firstPolymerIndex] || 'A';
                    const lastChainId = this.chains[lastPolymerIndex] || 'A';

                    if (firstChainId === lastChainId && isPolymerArr[firstPolymerIndex] && isPolymerArr[lastPolymerIndex]) {
                        const type1 = this.positionTypes[firstPolymerIndex];
                        const type2 = this.positionTypes[lastPolymerIndex];
                        const samePolymerType = (type1 === type2) ||
                            ((type1 === 'D' || type1 === 'R') && (type2 === 'D' || type2 === 'R'));

                        if (samePolymerType) {
                            const start = this.coords[firstPolymerIndex];
                            const end = this.coords[lastPolymerIndex];
                            const distSq = start.distanceToSq(end);
                            const chainbreakDistSq = getChainbreakDistSq(type1, type2);

                            if (distSq < chainbreakDistSq) {
                                this.segmentIndices.push({
                                    idx1: firstPolymerIndex,
                                    idx2: lastPolymerIndex,
                                    colorIndex: this.perChainIndices[firstPolymerIndex],
                                    origIndex: firstPolymerIndex,
                                    chainId: firstChainId,
                                    type: type1,
                                    len: Math.sqrt(distSq)
                                });
                            }
                        }
                    }
                }

                // Compute explicit bonds (from user input or structure file)
                // These can be between ANY position types (P, D, R, L, etc.)
                if (this.bonds && Array.isArray(this.bonds) && this.bonds.length > 0) {
                    // Use explicit bond definitions
                    for (const [idx1, idx2] of this.bonds) {
                        // Validate indices
                        if (idx1 < 0 || idx1 >= this.coords.length ||
                            idx2 < 0 || idx2 >= this.coords.length) {
                            continue;
                        }

                        // In overlay mode, skip bonds between different frames
                        if (this.overlayMode && this.frameIdMap) {
                            const frame1 = this.frameIdMap[idx1];
                            const frame2 = this.frameIdMap[idx2];
                            if (frame1 !== frame2) {
                                continue;
                            }
                        }

                        const start = this.coords[idx1];
                        const end = this.coords[idx2];
                        const distSq = start.distanceToSq(end);
                        const chainId = this.chains[idx1] || 'A';
                        // Determine segment type based on position types of both ends
                        const type1 = this.positionTypes?.[idx1] || 'L';
                        const type2 = this.positionTypes?.[idx2] || 'L';
                        // Use most restrictive type (P > D/R > L)
                        const segmentType = (type1 === 'P' || type2 === 'P') ? 'P' :
                            ((type1 === 'D' || type2 === 'D') ? 'D' :
                                ((type1 === 'R' || type2 === 'R') ? 'R' : 'L'));

                        this.segmentIndices.push({
                            idx1: idx1,
                            idx2: idx2,
                            colorIndex: 0,
                            origIndex: idx1,
                            chainId: chainId,
                            type: segmentType,
                            len: Math.sqrt(distSq)
                        });
                    }
                } else if (this.ligandGroups && this.ligandGroups.size > 0) {
                    // Use ligand groups: only compute distances within each group
                    for (const [groupKey, ligandPositionIndices] of this.ligandGroups.entries()) {
                        // Compute pairwise distances only within this ligand group
                        for (let i = 0; i < ligandPositionIndices.length; i++) {
                            for (let j = i + 1; j < ligandPositionIndices.length; j++) {
                                const idx1 = ligandPositionIndices[i];
                                const idx2 = ligandPositionIndices[j];

                                // Skip if indices are out of bounds
                                if (idx1 < 0 || idx1 >= this.coords.length ||
                                    idx2 < 0 || idx2 >= this.coords.length) {
                                    continue;
                                }

                                const start = this.coords[idx1];
                                const end = this.coords[idx2];
                                const distSq = start.distanceToSq(end);
                                if (distSq < ligandBondCutoffSq) {
                                    const chainId = this.chains[idx1] || 'A';
                                    this.segmentIndices.push({
                                        idx1: idx1,
                                        idx2: idx2,
                                        colorIndex: 0,
                                        origIndex: idx1,
                                        chainId: chainId,
                                        type: 'L',
                                        len: Math.sqrt(distSq)
                                    });
                                }
                            }
                        }
                    }
                } else {
                    // Fallback: iterate over each chain's ligands separately (old behavior)
                    for (const [chainId, ligandIndices] of ligandIndicesByChain.entries()) {
                        for (let i = 0; i < ligandIndices.length; i++) {
                            for (let j = i + 1; j < ligandIndices.length; j++) {
                                const idx1 = ligandIndices[i];
                                const idx2 = ligandIndices[j];

                                // All positions here are guaranteed to be in the same chain (chainId)

                                const start = this.coords[idx1];
                                const end = this.coords[idx2];
                                const distSq = start.distanceToSq(end);
                                if (distSq < ligandBondCutoffSq) {
                                    this.segmentIndices.push({
                                        idx1: idx1,
                                        idx2: idx2,
                                        colorIndex: 0,
                                        origIndex: idx1,
                                        chainId: chainId, // Use the chainId from the map key
                                        type: 'L',
                                        len: Math.sqrt(distSq)
                                    });
                                }
                            }
                        }
                    }
                }

                // Find all disconnected positions (any type) that don't appear in any segment
                // and add them as zero-length segments (will render as circles)
                const positionsInSegments = new Set();
                for (const segInfo of this.segmentIndices) {
                    positionsInSegments.add(segInfo.idx1);
                    positionsInSegments.add(segInfo.idx2);
                }

                // Add all disconnected positions as zero-length segments
                for (let i = 0; i < this.coords.length; i++) {
                    if (!positionsInSegments.has(i)) {
                        // This position is disconnected - add as zero-length segment
                        const positionType = this.positionTypes[i] || 'P';
                        const chainId = this.chains[i] || 'A';
                        const colorIndex = this.perChainIndices[i] || 0;

                        this.segmentIndices.push({
                            idx1: i,
                            idx2: i, // Same index = zero-length segment (will render as circle)
                            colorIndex: colorIndex,
                            origIndex: i,
                            chainId: chainId,
                            type: positionType,
                            len: 0 // Zero length indicates disconnected position
                        });
                    }
                }

                // Add contact segments from object-level contacts
                if (this.currentObjectName) {
                    const object = this.objectsData[this.currentObjectName];
                    if (object && object.contacts && Array.isArray(object.contacts) && object.contacts.length > 0) {
                        for (const contact of object.contacts) {
                            const resolved = this._resolveContactToIndices(contact, n);

                            if (resolved && resolved.idx1 >= 0 && resolved.idx1 < n &&
                                resolved.idx2 >= 0 && resolved.idx2 < n && resolved.idx1 !== resolved.idx2) {

                                const start = this.coords[resolved.idx1];
                                const end = this.coords[resolved.idx2];
                                const totalDist = Math.sqrt(start.distanceToSq(end));
                                const chainId = this.chains[resolved.idx1] || 'A';

                                this.segmentIndices.push({
                                    idx1: resolved.idx1,
                                    idx2: resolved.idx2,
                                    colorIndex: 0,
                                    origIndex: resolved.idx1,
                                    chainId: chainId,
                                    type: 'C',
                                    len: totalDist,
                                    contactIdx1: resolved.idx1,
                                    contactIdx2: resolved.idx2,
                                    contactWeight: resolved.weight || 1.0,
                                    contactColor: resolved.color || null
                                });
                            }
                        }
                    }
                }

                // Expand rotatedCoords to match coords array
                const currentCoordsLength = this.coords.length;
                while (this.rotatedCoords.length < currentCoordsLength) {
                    this.rotatedCoords.push(new Vec3(0, 0, 0));
                }
                // But we need to make sure they're all the same length
                const finalN = this.coords.length;
                while (this.plddts.length < finalN) {
                    this.plddts.push(50.0);
                }
                while (this.chains.length < finalN) {
                    this.chains.push('A');
                }
                while (this.positionTypes.length < finalN) {
                    this.positionTypes.push('P'); // Default to protein type for intermediate positions
                }
                while (this.positionNames.length < finalN) {
                    this.positionNames.push('UNK');
                }
                while (this.residueNumbers.length < finalN) {
                    this.residueNumbers.push(-1);
                }
                if (this.perChainIndices) {
                    while (this.perChainIndices.length < finalN) {
                        this.perChainIndices.push(0);
                    }
                }
            }

            // Cache the calculated segment indices for this frame
            // This block was previously inside the `if (!this.cachedSegmentIndices || ...)` block.
            // Moving it here ensures it runs whenever segments are generated or updated,
            // regardless of whether they were loaded from cache or newly computed.
            if (this.currentFrame >= 0 && this.currentObjectName) {
                this.cachedSegmentIndices = this.segmentIndices.map(seg => ({ ...seg }));
                this.cachedSegmentIndicesFrame = this.currentFrame;
                this.cachedSegmentIndicesObjectName = this.currentObjectName;
            }

            // [OPTIMIZATION] Ensure static adjacency list and arrays exist
            // This must run regardless of whether we used cache or generated segments
            const numSegments = this.segmentIndices.length;
            const numPositions = this.coords.length;

            // Check if we need to (re)build the optimization structures
            // Rebuild if:
            // 1. adjList is missing or wrong size (coords changed)
            // 2. segmentOrder is missing or too small (segments increased)
            // 3. We just generated new segments (canUseCache was false) - though if cache was false, we likely need to rebuild anyway

            const needBuild = !this.adjList ||
                this.adjList.length !== numPositions ||
                !this.segmentOrder ||
                this.segmentOrder.length < numSegments;

            if (needBuild) {
                // Build adjacency list
                this.adjList = new Array(numPositions);
                for (let i = 0; i < numPositions; i++) this.adjList[i] = [];

                // Allocate arrays if needed
                if (!this.segmentOrder || this.segmentOrder.length < numSegments) {
                    this.segmentOrder = new Int32Array(numSegments);
                    this.segmentFrame = new Int32Array(numSegments);
                    this.segmentEndpointFlags = new Uint8Array(numSegments);
                }

                // Allocate screen coordinate arrays
                if (!this.screenX || this.screenX.length < numPositions) {
                    this.screenX = new Float32Array(numPositions);
                    this.screenY = new Float32Array(numPositions);
                    this.screenRadius = new Float32Array(numPositions);
                    this.screenValid = new Int32Array(numPositions);
                }

                // Populate adjacency list
                for (let i = 0; i < numSegments; i++) {
                    const seg = this.segmentIndices[i];
                    if (seg.idx1 < numPositions) this.adjList[seg.idx1].push(i);
                    if (seg.idx2 < numPositions) this.adjList[seg.idx2].push(i);
                }
            }

            // Pre-allocate segData array
            const m = this.segmentIndices.length;
            if (this.segData.length !== m) {
                this.segData = Array.from({ length: m }, () => ({
                    x: 0, y: 0, z: 0, len: 0, zVal: 0, gx: -1, gy: -1
                }));
            }

            // Pre-calculate colors ONCE (if not plddt)
            // effectiveColorMode is not available yet during setCoords, so it will be calculated on demand
            this.colors = this._calculateSegmentColors();
            this.colorsNeedUpdate = false;

            // Pre-calculate pLDDT colors
            this.plddtColors = this._calculatePlddtColors();
            this.plddtColorsNeedUpdate = false;

            // [PATCH] Apply initial mask and render once
            // Don't render before applying mask - _composeAndApplyMask will handle rendering
            this._composeAndApplyMask(skipRender);

            // Dispatch event to notify sequence viewer that colors have changed (e.g., when frame changes)
            document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        }

        // Load frame data without rendering (for decoupled animation)
        _loadFrameData(frameIndex, skipRender = false) {
            if (!this.currentObjectName) return;
            const object = this.objectsData[this.currentObjectName];
            if (!object || frameIndex < 0 || frameIndex >= object.frames.length) {
                return;
            }

            const data = object.frames[frameIndex];

            // Resolve inherited plddt and PAE data
            const resolvedPlddt = this._resolvePlddtData(object, frameIndex);
            const resolvedPae = this._resolvePaeData(object, frameIndex);

            // Get bonds from object-level if available
            const resolvedBonds = object.bonds || null;

            // Create resolved data object (use resolved values if frame doesn't have its own)
            const resolvedData = {
                ...data,
                plddts: resolvedPlddt !== null ? resolvedPlddt : data.plddts,
                pae: resolvedPae !== null ? resolvedPae : data.pae,
                bonds: resolvedBonds
            };

            // Load 3D data (with skipRender option)
            this._loadDataIntoRenderer(resolvedData, skipRender);

            // Load PAE data (use resolved value)
            if (this.paeRenderer) {
                this.paeRenderer.setData(resolvedPae !== null ? resolvedPae : (data.pae || null));
            }

            // Reset selection to default (show all) when loading a new object's frame
            // Check if object actually changed (not just frame change within same object)
            const objectChanged = this.previousObjectName !== null &&
                this.previousObjectName !== this.currentObjectName;

            if (objectChanged) {
                // Object changed: reset to default (show all positions of new object)
                this.resetToDefault();
                this.previousObjectName = this.currentObjectName; // Update tracking
            } else if (this.selectionModel.selectionMode === 'explicit' &&
                this.selectionModel.positions.size === 0) {
                // Selection was explicitly cleared, reset to default
                this.resetToDefault();
            }

            // Update UI controls (but don't render yet)
            this.updateUIControls();

            // Map entropy to structure if entropy mode is active
            if (this.colorMode === 'entropy') {
                this._mapEntropyToStructure();
            }
        }

        /**
         * Map entropy values from current object's MSA to structure positions
         * Entropy is stored in object.msa.msasBySequence[querySeq].msaData.entropy
         * This function maps MSA entropy array to structure position indices
         */
        _mapEntropyToStructure(objectName = null) {
            // Use current object if not specified
            if (!objectName) {
                objectName = this.currentObjectName;
            }

            if (!objectName) {
                this.entropy = undefined;
                this._updateEntropyOptionVisibility();
                return;
            }

            const object = this.objectsData[objectName];
            if (!object || !object.msa || !object.msa.msasBySequence || !object.msa.chainToSequence) {
                this.entropy = undefined;
                this._updateEntropyOptionVisibility();
                return;
            }

            const frameIndex = this.currentFrame >= 0 ? this.currentFrame : 0;
            const frame = object.frames[frameIndex];
            if (!frame || !frame.chains) {
                this.entropy = undefined;
                this._updateEntropyOptionVisibility();
                return;
            }

            // Initialize entropy vector with -1 for all positions (full molecule length)
            const positionCount = frame.chains.length;
            const entropyVector = new Array(positionCount).fill(-1);

            // Check if extractChainSequences is available
            const extractChainSequences = typeof window !== 'undefined' && typeof window.extractChainSequences === 'function'
                ? window.extractChainSequences
                : null;

            if (!extractChainSequences) {
                this.entropy = entropyVector;
                this._updateEntropyOptionVisibility();
                return;
            }

            // Extract chain sequences from structure
            const chainSequences = extractChainSequences(frame);

            // For each chain, get its MSA and map entropy values
            for (const [chainId, querySeq] of Object.entries(object.msa.chainToSequence)) {
                const msaEntry = object.msa.msasBySequence[querySeq];
                if (!msaEntry || !msaEntry.msaData || !msaEntry.msaData.entropy) {
                    continue; // No entropy data for this chain's MSA
                }

                const msaData = msaEntry.msaData;
                const msaEntropy = msaData.entropy; // Pre-computed entropy array (one per filtered MSA position)

                const chainSequence = chainSequences[chainId];
                if (!chainSequence) {
                    continue; // Chain not found in frame
                }

                // Find representative positions for this chain (position_types === 'P')
                const allChainPositions = []; // Array of all position indices for this chain

                for (let i = 0; i < positionCount; i++) {
                    if (frame.chains[i] === chainId && frame.position_types && frame.position_types[i] === 'P') {
                        allChainPositions.push(i);
                    }
                }

                if (allChainPositions.length === 0) {
                    continue; // No representative positions found
                }

                // Sort positions by residue number to match sequence order
                allChainPositions.sort((a, b) => {
                    const residueNumA = frame.residue_numbers ? frame.residue_numbers[a] : a;
                    const residueNumB = frame.residue_numbers ? frame.residue_numbers[b] : b;
                    return residueNumA - residueNumB;
                });

                // Direct 1:1 mapping: msaEntropy[i] -> allChainPositions[i]
                // MSA entropy array contains ALL positions (dimming is visual only, not in data)
                const mapLength = Math.min(msaEntropy.length, allChainPositions.length);
                for (let i = 0; i < mapLength; i++) {
                    const positionIndex = allChainPositions[i];
                    if (positionIndex < entropyVector.length) {
                        entropyVector[positionIndex] = msaEntropy[i];
                    }
                }
            }

            this.entropy = entropyVector;

            // Update entropy option visibility in color dropdown
            this._updateEntropyOptionVisibility();
        }

        /**
         * Show or hide the Entropy color option based on whether entropy data is available
         */
        _updateEntropyOptionVisibility() {
            const entropyOption = document.getElementById('entropyColorOption');
            if (entropyOption) {
                // Show entropy option if we have valid entropy data
                const hasEntropy = this.entropy && this.entropy.some(val => val !== undefined && val >= 0);
                entropyOption.hidden = !hasEntropy;

                // If entropy option is hidden and currently selected, switch to auto
                if (!hasEntropy && this.colorMode === 'entropy') {
                    this.colorMode = 'auto';
                    if (this.colorSelect) {
                        this.colorSelect.value = 'auto';
                    }
                    this.colorsNeedUpdate = true;
                    this.render('_updateEntropyOptionVisibility: auto switch');
                }
            }
        }

        _getEffectiveColorMode() {
            const validModes = ['auto', 'chain', 'rainbow', 'plddt', 'deepmind', 'entropy'];
            if (!this.colorMode || !validModes.includes(this.colorMode)) {
                console.warn('Invalid colorMode:', this.colorMode, 'resetting to auto');
                this.colorMode = 'auto';
            }

            // If 'auto', resolve to the calculated mode
            if (this.colorMode === 'auto') {
                const resolved = this.resolvedAutoColor || 'rainbow';
                return resolved;
            }

            return this.colorMode;
        }

        /**
         * Get the color for a position based on current color mode
         * @param {number} atomIndex - Position index (0-based array index into coords/positionTypes arrays).
         *                             Note: Parameter name kept as 'atomIndex' for API compatibility, but represents a position index.
         *                             For proteins/DNA/RNA, one position = one residue (represented by CA/C4').
         *                             For ligands, one position = one heavy atom.
         * @returns {{r: number, g: number, b: number}} RGB color object
         */
        getAtomColor(atomIndex, effectiveColorMode = null) {
            if (atomIndex < 0 || atomIndex >= this.coords.length) {
                return this._applyPastel({ r: 128, g: 128, b: 128 }); // Default grey
            }

            // Use provided color mode or calculate it once
            if (!effectiveColorMode) {
                effectiveColorMode = this._getEffectiveColorMode();
            }
            const type = (this.positionTypes && atomIndex < this.positionTypes.length) ? this.positionTypes[atomIndex] : undefined;
            let color;

            // Ligands should always be grey in chain and rainbow modes (not plddt)
            const isLigand = type === 'L';

            if (effectiveColorMode === 'plddt') {
                const plddtFunc = this.colorblindMode ? getPlddtColor_Colorblind : getPlddtColor;
                const plddt = (this.plddts[atomIndex] !== null && this.plddts[atomIndex] !== undefined) ? this.plddts[atomIndex] : 50;
                color = plddtFunc(plddt);
            } else if (effectiveColorMode === 'deepmind') {
                // DeepMind colors don't use colorblind mode - always use standard colors
                const plddtAfFunc = getPlddtAFColor;
                const plddt = (this.plddts[atomIndex] !== null && this.plddts[atomIndex] !== undefined) ? this.plddts[atomIndex] : 50;
                color = plddtAfFunc(plddt);
            } else if (effectiveColorMode === 'entropy') {
                const entropyFunc = this.colorblindMode ? getEntropyColor_Colorblind : getEntropyColor;
                // Get entropy value from mapped entropy vector
                const entropy = (this.entropy && atomIndex < this.entropy.length && this.entropy[atomIndex] !== undefined && this.entropy[atomIndex] >= 0)
                    ? this.entropy[atomIndex]
                    : undefined;
                if (entropy !== undefined) {
                    color = entropyFunc(entropy);
                } else {
                    // No entropy data for this position (ligand, RNA/DNA, or unmapped) - use default grey
                    color = { r: 128, g: 128, b: 128 };
                }
            } else if (effectiveColorMode === 'chain') {
                const chainId = this.chains[atomIndex] || 'A';
                if (isLigand && !this.ligandOnlyChains.has(chainId)) {
                    // Ligands in chains with P/D/R positions are grey
                    color = { r: 128, g: 128, b: 128 };
                } else {
                    // Regular positions, or ligands in ligand-only chains, get chain color
                    if (this.chainIndexMap && this.chainIndexMap.has(chainId)) {
                        const chainIndex = this.chainIndexMap.get(chainId);
                        const colorArray = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
                        const hex = colorArray[chainIndex % colorArray.length];
                        color = hexToRgb(hex);
                    } else {
                        // Fallback: use a default color if chainIndexMap is not initialized
                        const colorArray = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
                        const hex = colorArray[0]; // Use first color as default
                        color = hexToRgb(hex);
                    }
                }
            } else { // rainbow
                if (isLigand) {
                    // All ligands are grey in rainbow mode
                    color = { r: 128, g: 128, b: 128 };
                } else {
                    // Regular positions get rainbow color
                    const chainId = this.chains[atomIndex] || 'A';
                    const scale = this.chainRainbowScales && this.chainRainbowScales[chainId];
                    const rainbowFunc = this.colorblindMode ? getRainbowColor_Colorblind : getRainbowColor;
                    if (scale && scale.min !== Infinity && scale.max !== -Infinity) {
                        const colorIndex = this.perChainIndices && atomIndex < this.perChainIndices.length ? this.perChainIndices[atomIndex] : 0;
                        color = rainbowFunc(colorIndex, scale.min, scale.max);
                    } else {
                        // Fallback: if scale not found, use a default rainbow based on colorIndex
                        const colorIndex = (this.perChainIndices && atomIndex < this.perChainIndices.length ? this.perChainIndices[atomIndex] : 0) || 0;
                        color = rainbowFunc(colorIndex, 0, Math.max(1, colorIndex));
                    }
                }
            }

            // Don't apply pastel to DeepMind mode - preserve saturated AF confidence colors
            if (effectiveColorMode === 'deepmind') {
                return color;
            }

            return this._applyPastel(color);
        }

        // Get chain color for a given chain ID (for UI elements like sequence viewer)
        getChainColorForChainId(chainId) {
            if (!this.chainIndexMap || !chainId) {
                return { r: 128, g: 128, b: 128 }; // Default gray
            }
            const chainIndex = this.chainIndexMap.get(chainId) || 0;
            const colorArray = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
            const hex = colorArray[chainIndex % colorArray.length];
            return hexToRgb(hex);
        }

        // Calculate segment colors (chain or rainbow)
        // Uses getAtomColor() as single source of truth for all color logic
        _calculateSegmentColors(effectiveColorMode = null) {
            const m = this.segmentIndices.length;
            if (m === 0) return [];

            // Cache effective color mode to avoid calling _getEffectiveColorMode() for every position
            if (!effectiveColorMode) {
                effectiveColorMode = this._getEffectiveColorMode();
            }

            // Use getAtomColor() for each segment - ensures consistency and eliminates duplicate logic
            return this.segmentIndices.map(segInfo => {
                // Contacts use custom color if provided, otherwise yellow (no pastel applied)
                if (segInfo.type === 'C') {
                    if (segInfo.contactColor) {
                        return segInfo.contactColor; // Use custom color from contact file
                    }
                    return { r: 255, g: 255, b: 0 }; // Default yellow
                }

                const positionIndex = segInfo.origIndex;
                // getAtomColor() already handles all color modes, ligands, ligand-only chains, pastel, etc.
                return this.getAtomColor(positionIndex, effectiveColorMode);
            });
        }

        // Calculate pLDDT colors
        _calculatePlddtColors() {
            const m = this.segmentIndices.length;
            if (m === 0) return [];

            const colors = new Array(m);

            // Select the appropriate plddt color function based on effective color mode
            const effectiveMode = this._getEffectiveColorMode();
            let plddtFunc;
            if (effectiveMode === 'deepmind') {
                // DeepMind colors don't use colorblind mode - always use standard colors
                plddtFunc = getPlddtAFColor;
            } else {
                plddtFunc = this.colorblindMode ? getPlddtColor_Colorblind : getPlddtColor;
            }

            for (let i = 0; i < m; i++) {
                const segInfo = this.segmentIndices[i];

                // Contacts use custom color if provided, otherwise yellow (no pastel applied)
                if (segInfo.type === 'C') {
                    if (segInfo.contactColor) {
                        colors[i] = segInfo.contactColor; // Use custom color from contact file
                    } else {
                        colors[i] = { r: 255, g: 255, b: 0 }; // Default yellow
                    }
                    continue;
                }

                const positionIndex = segInfo.origIndex;
                const type = segInfo.type;
                let color;

                if (type === 'L') {
                    const plddt1 = (this.plddts[positionIndex] !== null && this.plddts[positionIndex] !== undefined) ? this.plddts[positionIndex] : 50;
                    color = plddtFunc(plddt1); // Use selected plddt function
                } else {
                    const plddt1 = (this.plddts[positionIndex] !== null && this.plddts[positionIndex] !== undefined) ? this.plddts[positionIndex] : 50;
                    const plddt2_idx = (segInfo.idx2 < this.coords.length) ? segInfo.idx2 : segInfo.idx1;
                    const plddt2 = (this.plddts[plddt2_idx] !== null && this.plddts[plddt2_idx] !== undefined) ? this.plddts[plddt2_idx] : 50;
                    color = plddtFunc((plddt1 + plddt2) / 2); // Use selected plddt function
                }
                // Don't apply pastel to DeepMind mode - preserve saturated AF confidence colors
                colors[i] = effectiveMode === 'deepmind' ? color : this._applyPastel(color);
            }
            return colors;
        }

        /**
         * Compares two rotation matrices for equality.
         * @param {Array} m1 - First rotation matrix
         * @param {Array} m2 - Second rotation matrix
         * @returns {boolean} True if matrices are equal (within tolerance)
         */
        _rotationMatricesEqual(m1, m2) {
            if (!m1 || !m2) return false;
            const tolerance = 1e-6;
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    if (Math.abs(m1[i][j] - m2[i][j]) > tolerance) {
                        return false;
                    }
                }
            }
            return true;
        }

        /**
         * Creates a deep copy of a rotation matrix.
         * @param {Array} matrix - Rotation matrix to copy
         * @returns {Array} Deep copy of matrix
         */
        _deepCopyMatrix(matrix) {
            return [
                [matrix[0][0], matrix[0][1], matrix[0][2]],
                [matrix[1][0], matrix[1][1], matrix[1][2]],
                [matrix[2][0], matrix[2][1], matrix[2][2]]
            ];
        }

        /**
         * Resolves contact specification to position indices.
         * @param {Array} contact - Contact specification: [idx1, idx2, weight, color?] or [chain1, res1, chain2, res2, weight, color?]
         * @returns {{idx1: number, idx2: number, weight: number, color: {r: number, g: number, b: number}|null}|null} Resolved indices, weight, and color or null if invalid
         */
        _resolveContactToIndices(contact, maxIndex = null) {
            if (!contact || !Array.isArray(contact)) return null;

            // Extract weight and color
            let weight = 1.0;
            let color = null;

            if (contact.length >= 3 && typeof contact[0] === 'number' && typeof contact[1] === 'number') {
                // Direct indices format: [idx1, idx2, weight, color?]
                weight = typeof contact[2] === 'number' ? contact[2] : 1.0;
                if (contact.length >= 4 && typeof contact[3] === 'object' && contact[3] !== null) {
                    color = contact[3]; // Color object {r, g, b}
                }
                return { idx1: contact[0], idx2: contact[1], weight: weight, color: color };
            } else if (contact.length >= 5 && typeof contact[0] === 'string') {
                // Chain + residue format: [chain1, res1, chain2, res2, weight, color?]
                const [chain1, res1, chain2, res2] = contact;
                weight = typeof contact[4] === 'number' ? contact[4] : 1.0;
                if (contact.length >= 6 && typeof contact[5] === 'object' && contact[5] !== null) {
                    color = contact[5]; // Color object {r, g, b}
                }

                // Find position indices matching chain+residue
                // Only search in original structure positions (before intermediate positions were added)
                const searchLimit = maxIndex !== null ? maxIndex : this.chains.length;
                let idx1 = -1, idx2 = -1;

                // Debug: log available chains and residue ranges for first failed contact
                let debugLogged = false;

                for (let i = 0; i < searchLimit; i++) {
                    // Skip intermediate positions (they have residueNumber = -1)
                    if (this.residueNumbers[i] === -1) continue;

                    if (this.chains[i] === chain1 && this.residueNumbers[i] === res1 && idx1 === -1) {
                        idx1 = i;
                    }
                    if (this.chains[i] === chain2 && this.residueNumbers[i] === res2 && idx2 === -1) {
                        idx2 = i;
                    }
                    if (idx1 !== -1 && idx2 !== -1) break;
                }

                if (idx1 === -1 || idx2 === -1) {
                    // Enhanced debugging: show what's available in the structure
                    if (!debugLogged) {
                        const availableChains = new Set();
                        const chainResidueRanges = {};
                        for (let i = 0; i < Math.min(searchLimit, 1000); i++) { // Limit to first 1000 for performance
                            if (this.residueNumbers[i] === -1) continue;
                            const chain = this.chains[i];
                            const resNum = this.residueNumbers[i];
                            availableChains.add(chain);
                            if (!chainResidueRanges[chain]) {
                                chainResidueRanges[chain] = { min: resNum, max: resNum, samples: [] };
                            } else {
                                chainResidueRanges[chain].min = Math.min(chainResidueRanges[chain].min, resNum);
                                chainResidueRanges[chain].max = Math.max(chainResidueRanges[chain].max, resNum);
                            }
                            if (chainResidueRanges[chain].samples.length < 10) {
                                chainResidueRanges[chain].samples.push(resNum);
                            }
                        }
                        console.warn(`Could not resolve contact: [${chain1}, ${res1}, ${chain2}, ${res2}]`);
                        console.warn(`  Available chains:`, Array.from(availableChains).sort());
                        console.warn(`  Residue ranges:`, Object.keys(chainResidueRanges).map(chain =>
                            `${chain}: ${chainResidueRanges[chain].min}-${chainResidueRanges[chain].max} (samples: ${chainResidueRanges[chain].samples.slice(0, 5).join(', ')})`
                        ));
                        console.warn(`  Searching in first ${searchLimit} positions`);
                        debugLogged = true;
                    } else {
                        console.warn(`Could not resolve contact: [${chain1}, ${res1}, ${chain2}, ${res2}]`);
                    }
                    return null;
                }

                return { idx1, idx2, weight: weight, color: color };
            }

            console.warn(`Invalid contact format:`, contact);
            return null;
        }

        /**
         * Calculates width multiplier for a given molecule type.
         * Always uses TYPE_BASELINES (no length-based scaling).
         * @param {string} type - Molecule type ('L', 'P', 'D', 'R', 'C')
         * @returns {number} Width multiplier
         */
        _calculateTypeWidthMultiplier(type) {
            // Always use baseline (no length-based scaling)
            const baseline = TYPE_BASELINES[type] ?? TYPE_BASELINES['P'];
            return baseline;
        }

        /**
         * Gets width multiplier for a segment.
         * Uses cached type-based width (calculated once per molecule load).
         * @param {object} segData - Segment data (not used, kept for API compatibility)
         * @param {object} segInfo - Segment info (has type, idx1, idx2)
         * @returns {number} Width multiplier
         */
        _calculateSegmentWidthMultiplier(segData, segInfo) {
            // Handle zero-length segments (positions)
            if (segInfo.idx1 === segInfo.idx2) {
                return this.typeWidthMultipliers?.atom ?? ATOM_WIDTH_MULTIPLIER;
            }

            // Use cached width multiplier for this type (O(1) lookup)
            const type = segInfo.type;
            const baseMultiplier = this.typeWidthMultipliers?.[type] ?? this._calculateTypeWidthMultiplier(type);

            // For contacts, apply weight multiplier if available
            if (type === 'C' && segInfo.contactWeight !== undefined) {
                return baseMultiplier * segInfo.contactWeight;
            }

            return baseMultiplier;
        }

        // Helper function for shadow calculation
        /**
         * Calculates the shadow and tint contribution for a pair of segments.
         * @param {object} s1 - The segment being shaded (further back).
         * @param {object} s2 - The segment casting the shadow (further forward).
         * @param {object} segInfo1 - Segment info for s1 (has type, idx1, idx2)
         * @param {object} segInfo2 - Segment info for s2 (has type, idx1, idx2)
         * @returns {{shadow: number, tint: number}}
         */
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

            // Skip width calculation for performance (use constant ratio)
            const widthRatio = 1.0; // Assume equal widths for speed
            return { shadow: shadow * widthRatio, tint: tint * widthRatio };
        }


        // Helper method to stop recording tracks
        _stopRecordingTracks() {
            if (this.recordingStream) {
                this.recordingStream.getTracks().forEach(track => track.stop());
                this.recordingStream = null;
            }
        }

        // Update cached canvas dimensions (call on resize)
        _updateCanvasDimensions() {
            this.displayWidth = parseInt(this.canvas.style.width) || this.canvas.width;
            this.displayHeight = parseInt(this.canvas.style.height) || this.canvas.height;

            // Update highlight overlay canvas size to match (managed by sequence viewer)
            if (window.SequenceViewer && window.SequenceViewer.updateHighlightOverlaySize) {
                window.SequenceViewer.updateHighlightOverlaySize();
            }
        }

        // RENDER (Core drawing logic)
        // RENDER (Core drawing logic)
        render(reason = 'Unknown') {
            if (this.currentFrame < 0) {
                // Clear canvas if no frame is set
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                return;
            }
            this._renderToContext(this.ctx, this.displayWidth, this.displayHeight);
        }

        // Core rendering logic - can render to any context (canvas, SVG, etc.)
        _renderToContext(ctx, displayWidth, displayHeight) {
            // Use clearRect or fillRect based on transparency
            if (this.isTransparent) {
                ctx.clearRect(0, 0, displayWidth, displayHeight);
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, displayWidth, displayHeight);
            }

            // Check segment length
            if (this.coords.length === 0 || this.segmentIndices.length === 0 || !this.currentObjectName) {
                return;
            }

            const object = this.objectsData[this.currentObjectName];
            if (!object) {
                console.warn("Render called but object data is missing.");
                return;
            }

            // Use temporary center if set (for orienting to visible positions), otherwise use global center
            const globalCenter = (object && object.totalPositions > 0) ? object.globalCenterSum.mul(1 / object.totalPositions) : new Vec3(0, 0, 0);
            const c = this.temporaryCenter || globalCenter;

            // Update pre-allocated rotatedCoords
            const m = this.rotationMatrix;
            for (let i = 0; i < this.coords.length; i++) {
                const v = this.coords[i];
                const subX = v.x - c.x, subY = v.y - c.y, subZ = v.z - c.z;
                const out = this.rotatedCoords[i];
                out.x = m[0][0] * subX + m[0][1] * subY + m[0][2] * subZ;
                out.y = m[1][0] * subX + m[1][1] * subY + m[1][2] * subZ;
                out.z = m[2][0] * subX + m[2][1] * subY + m[2][2] * subZ;
            }
            const rotated = this.rotatedCoords;

            // Segment generation is now just data lookup
            const n = this.segmentIndices.length;
            const segments = this.segmentIndices; // Use the pre-calculated segment definitions

            const effectiveColorMode = this._getEffectiveColorMode();

            // Select pre-calculated color array
            let colors;
            if (effectiveColorMode === 'plddt' || effectiveColorMode === 'deepmind') {
                if (!this.plddtColors || this.plddtColors.length !== n || this.plddtColorsNeedUpdate) {
                    this.plddtColors = this._calculatePlddtColors();
                    this.plddtColorsNeedUpdate = false;
                }
                colors = this.plddtColors;
            } else {
                if (!this.colors || this.colors.length !== n || this.colorsNeedUpdate) {
                    // Pass effectiveColorMode to avoid redundant _getEffectiveColorMode() calls
                    this.colors = this._calculateSegmentColors(effectiveColorMode);
                    this.colorsNeedUpdate = false;
                }
                colors = this.colors;
            }

            // Safety check: ensure color arrays match segment count
            if (!colors || colors.length !== n) {
                console.warn("Color array mismatch, recalculating.");
                this.colors = this._calculateSegmentColors(effectiveColorMode);
                this.plddtColors = this._calculatePlddtColors();
                this.colorsNeedUpdate = false;
                this.plddtColorsNeedUpdate = false;
                colors = (effectiveColorMode === 'plddt' || effectiveColorMode === 'deepmind') ? this.plddtColors : this.colors;
                if (colors.length !== n) {
                    console.error("Color array mismatch even after recalculation. Aborting render.");
                    return; // Still bad, abort render
                }
            }

            // Get visibility mask early to build visible segment list
            const visibilityMask = this.visibilityMask;

            // Build list of visible segment indices early - this is the key optimization
            // A segment is visible if both positions are visible (or no mask = all visible)
            // For contact segments, check visibility based on original contact endpoints, not intermediate positions
            const visibleSegmentIndices = [];
            for (let i = 0; i < n; i++) {
                const segInfo = segments[i];
                let isVisible = false;

                // In overlay mode, show all segments regardless of visibility mask
                if (this.overlayMode) {
                    isVisible = true;
                } else if (!visibilityMask) {
                    // No mask = all segments visible
                    isVisible = true;
                } else if (segInfo.type === 'C' && segInfo.contactIdx1 !== undefined && segInfo.contactIdx2 !== undefined) {
                    // For contact segments, check visibility based on original contact endpoints
                    isVisible = visibilityMask.has(segInfo.contactIdx1) && visibilityMask.has(segInfo.contactIdx2);
                } else {
                    // For regular segments, check visibility based on segment endpoints
                    isVisible = visibilityMask.has(segInfo.idx1) && visibilityMask.has(segInfo.idx2);
                }

                if (isVisible) {
                    visibleSegmentIndices.push(i);
                }
            }
            const numVisibleSegments = visibleSegmentIndices.length;

            // Combine Z-value/norm and update segData
            // Only calculate z-values for visible segments to avoid unnecessary computation
            const zValues = new Float32Array(n);
            let zMin = Infinity;
            let zMax = -Infinity;
            // Also track min/max from actual position coordinates (for outline width calculation)
            let zMinAtoms = Infinity;
            let zMaxAtoms = -Infinity;
            const segData = this.segData; // Use pre-allocated array

            // Calculate z-values without clamping (preserve actual range)
            for (let i = 0; i < numVisibleSegments; i++) {
                const segIdx = visibleSegmentIndices[i];
                const segInfo = segments[segIdx];
                const start = rotated[segInfo.idx1];
                const end = rotated[segInfo.idx2];

                const midX = (start.x + end.x) * 0.5;
                const midY = (start.y + end.y) * 0.5;
                const midZ = (start.z + end.z) * 0.5;
                // Use mean z-value for all segments
                const z = midZ;

                zValues[segIdx] = z;
                if (z < zMin) zMin = z;
                if (z > zMax) zMax = z;

                // Track position z-coordinates for outline calculation
                if (start.z < zMinAtoms) zMinAtoms = start.z;
                if (start.z > zMaxAtoms) zMaxAtoms = start.z;
                if (end.z < zMinAtoms) zMinAtoms = end.z;
                if (end.z > zMaxAtoms) zMaxAtoms = end.z;

                // Update pre-allocated segData object
                const s = segData[segIdx];
                s.x = midX;
                s.y = midY;
                s.z = z; // Use mean z-value for sorting
                s.len = segInfo.len; // Use pre-calculated length
                s.zVal = z;
                // gx/gy are reset in shadow logic
            }

            const zNorm = new Float32Array(n);

            // Count visible positions for performance mode determination
            let numVisiblePositions;
            if (!visibilityMask) {
                // All positions are visible
                numVisiblePositions = this.coords.length;
            } else {
                // Count positions in visibility mask
                numVisiblePositions = visibilityMask.size;
            }

            // Collect z-values from visible segments only (for depth calculation)
            const visibleZValues = [];
            for (let i = 0; i < numVisibleSegments; i++) {
                const segIdx = visibleSegmentIndices[i];
                visibleZValues.push(zValues[segIdx]);
            }

            // Calculate mean and std only from visible segments
            const numVisible = visibleZValues.length;
            let zSum = 0;
            for (let i = 0; i < numVisible; i++) {
                zSum += visibleZValues[i];
            }
            const zMean = numVisible > 0 ? zSum / numVisible : 0;

            // Calculate standard deviation from visible segments only
            let varianceSum = 0;
            for (let i = 0; i < numVisible; i++) {
                const diff = visibleZValues[i] - zMean;
                varianceSum += diff * diff;
            }
            const zVariance = numVisible > 0 ? varianceSum / numVisible : 0;
            const zStd = Math.sqrt(zVariance);

            // Map using std: zMean - 2*std → 0, zMean + 2*std → 1
            // Formula: zNorm = (z - (zMean - 2*std)) / (4*std)
            // Only normalize visible segments to avoid unnecessary computation
            if (zStd > 1e-6) {
                let zFront = zMean - 2.0 * zStd; // 2 std below mean (front)
                let zBack = zMean + 2.0 * zStd;  // 2 std above mean (back)

                // Apply symmetric range expansion: ensure minimum range of 64 units
                // Expand symmetrically around center if range is too small
                const DEPTH_RANGE = 64; // Minimum range (from -32 to +32)
                const zCenter = (zFront + zBack) / 2;
                const zRange = zBack - zFront;
                if (zRange < DEPTH_RANGE) {
                    // Expand symmetrically around center
                    zFront = zCenter - DEPTH_RANGE / 2;  // zCenter - 32
                    zBack = zCenter + DEPTH_RANGE / 2;   // zCenter + 32
                }
                const zRangeStd = zBack - zFront;  // Recalculate range

                // Only normalize visible segments
                for (let i = 0; i < numVisibleSegments; i++) {
                    const segIdx = visibleSegmentIndices[i];
                    // Map zFront to 0, zBack to 1
                    zNorm[segIdx] = (zValues[segIdx] - zFront) / zRangeStd;
                    // Clamp to [0, 1] for values outside range
                    zNorm[segIdx] = Math.max(0, Math.min(1, zNorm[segIdx]));
                }
            } else {
                // Fallback: if std is too small, use min/max approach
                // Apply symmetric range expansion: ensure minimum range of 64 units
                const DEPTH_RANGE = 64; // Minimum range (from -32 to +32)
                let expandedZMin = zMin;
                let expandedZMax = zMax;

                const zCenter = (zMin + zMax) / 2;
                const zRange = zMax - zMin;
                if (zRange < DEPTH_RANGE) {
                    // Expand symmetrically around center
                    expandedZMin = zCenter - DEPTH_RANGE / 2;  // zCenter - 32
                    expandedZMax = zCenter + DEPTH_RANGE / 2;   // zCenter + 32
                }
                const finalRange = expandedZMax - expandedZMin;

                if (finalRange > 1e-6) {
                    // Only normalize visible segments
                    for (let i = 0; i < numVisibleSegments; i++) {
                        const segIdx = visibleSegmentIndices[i];
                        zNorm[segIdx] = (zValues[segIdx] - expandedZMin) / finalRange;
                    }
                } else {
                    // Only set visible segments to 0.5
                    for (let i = 0; i < numVisibleSegments; i++) {
                        const segIdx = visibleSegmentIndices[i];
                        zNorm[segIdx] = 0.5;
                    }
                }
            }

            const renderShadows = this.shadowEnabled;
            const maxExtent = (object && object.maxExtent > 0) ? object.maxExtent : 30.0;

            const shadows = new Float32Array(n);
            const tints = new Float32Array(n);

            // Initialize shadows and tints to default values (no shadow, no tint)
            // These will be overwritten by shadow calculation or cache, but initialize for safety
            shadows.fill(1.0);
            tints.fill(1.0);

            // Limit number of rendered segments for performance
            const RENDER_CUTOFF = 1000000; // Fully opaque segments


            // [OPTIMIZATION] Allocation-free sorting
            // Sort visibleSegmentIndices in-place using zValues lookup
            // This avoids creating N objects and 2 intermediate arrays per frame
            // Sort by z-depth (back to front)
            visibleSegmentIndices.sort((a, b) => zValues[a] - zValues[b]);

            // Use the sorted array directly
            let visibleOrder = visibleSegmentIndices;

            // [OPTIMIZATION] Apply culling immediately after sorting
            // visibleOrder is sorted back-to-front (index 0 is furthest, index N-1 is closest)
            // We want to keep the END of the array (closest segments)
            const totalVisible = visibleOrder.length;
            const maxRender = RENDER_CUTOFF;

            if (totalVisible > maxRender) {
                // Keep the last maxRender segments (closest to camera)
                visibleOrder = visibleOrder.slice(totalVisible - maxRender);
            }

            // Update numRendered to reflect the culled count
            // IMPORTANT: This variable is used in subsequent loops (grid, endpoint detection)
            // We must update it so those loops only process the segments we intend to render
            const numRendered = visibleOrder.length;

            // [OPTIMIZATION] Removed redundant 'order' array sorting
            // Previously we sorted all N segments here, but it was never used for rendering
            // This saves O(N log N) operations and significant memory allocation

            // visibilityMask already declared above for depth calculation

            // Determine fast/slow mode based on visible positions (not total segments)
            // Fast mode: skip expensive operations when many visible positions
            // Slow mode: full quality rendering when few visible positions
            const isFastMode = numVisiblePositions > this.LARGE_MOLECULE_CUTOFF;
            const isLargeMolecule = n > this.LARGE_MOLECULE_CUTOFF;

            // Check if rotation changed (shadows depend on 3D positions, not width/ortho)
            // Shadows only need recalculation when rotation changes, not when width/ortho changes
            const rotationChanged = !this._rotationMatricesEqual(this.rotationMatrix, this.lastShadowRotationMatrix);

            // For fast mode (many visible positions), skip expensive shadow calculations during dragging, zooming, or orient animation - use cached
            // During zoom, shadows don't change, so reuse cached values
            // During drag, use cached for performance, but recalculate after drag stops
            // During orient animation, use cached for performance, but recalculate after animation completes
            // Also skip if rotation hasn't changed (width/ortho changes don't affect shadows)
            const skipShadowCalc = (
                (isFastMode && (this.isDragging || this.isZooming || this.isOrientAnimating) && this.cachedShadows && this.cachedShadows.length === n) ||
                (!rotationChanged && this.cachedShadows && this.cachedShadows.length === n)
            );

            if (renderShadows && !skipShadowCalc) {
                // Use fast mode threshold based on visible positions, not total segments
                if (!isFastMode) {
                    // Only process visible segments in outer loop
                    for (let i_idx = visibleOrder.length - 1; i_idx >= 0; i_idx--) {
                        const i = visibleOrder[i_idx];
                        let shadowSum = 0;
                        let maxTint = 0;
                        const s1 = segData[i];
                        const segInfoI = segments[i]; // Cache segment info
                        const isContactI = segInfoI.type === 'C';
                        const isMoleculeI = segInfoI.type === 'P' || segInfoI.type === 'D' || segInfoI.type === 'R';

                        // Only check visible segments (already filtered)
                        for (let j_idx = i_idx + 1; j_idx < visibleOrder.length; j_idx++) {
                            const j = visibleOrder[j_idx];

                            // Early exit: if shadow is already saturated or tint is maxed
                            if (shadowSum >= MAX_SHADOW_SUM || (maxTint >= 1.0 && shadowSum >= MAX_SHADOW_SUM)) {
                                break; // Shadow sum is saturated, skip remaining segments
                            }

                            const s2 = segData[j];
                            const segInfo2 = segments[j];

                            // Shadow isolation: in overlay mode, only allow shadows within same frame
                            if (this.overlayMode && this.frameIdMap) {
                                const frameI = this.frameIdMap[segInfoI.idx1];
                                const frameJ = this.frameIdMap[segInfo2.idx1];
                                if (frameI !== frameJ) {
                                    continue; // Skip shadows between different frames
                                }
                            }

                            const isContactJ = segInfo2.type === 'C';
                            const isMoleculeJ = segInfo2.type === 'P' || segInfo2.type === 'D' || segInfo2.type === 'R';

                            // Skip if one is contact and one is molecule - contacts don't influence molecule shadows/tints
                            if ((isContactI && isMoleculeJ) || (isMoleculeI && isContactJ)) {
                                continue;
                            }

                            // Call helper function with segment info for width weighting
                            const { shadow, tint } = this._calculateShadowTint(s1, s2, segInfoI, segInfo2);
                            // Saturating accumulation: naturally caps at MAX_SHADOW_SUM
                            shadowSum = Math.min(shadowSum + shadow, MAX_SHADOW_SUM);
                            maxTint = Math.max(maxTint, tint);
                        }
                        shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                        tints[i] = 1 - maxTint;
                    }
                } else { // Fast mode: many visible positions, use grid-based optimization
                    // Increase grid resolution for large structures to reduce segments per cell
                    // Target: ~5-10 segments per cell for better performance
                    let GRID_DIM = Math.ceil(Math.sqrt(numVisibleSegments / 5));
                    GRID_DIM = Math.max(20, Math.min(150, GRID_DIM)); // Increased max from 100 to 150

                    const gridSize = GRID_DIM * GRID_DIM;
                    const grid = Array.from({ length: gridSize }, () => []);

                    const gridMin = -maxExtent - 1.0;
                    const gridRange = (maxExtent + 1.0) * 2;
                    const gridCellSize = gridRange / GRID_DIM;

                    // Limit number of segments to check per cell for very large structures
                    // This prevents excessive shadow calculations
                    // More aggressive limit for very large structures
                    const MAX_SEGMENTS_PER_CELL = numVisibleSegments > 15000 ? 30 : (numVisibleSegments > 10000 ? 50 : Infinity);

                    if (gridCellSize > 1e-6) {
                        const invCellSize = 1.0 / gridCellSize;

                        // Only calculate grid positions for visible segments
                        // [OPTIMIZATION] Use visibleOrder (culled list) instead of visibleSegmentIndices
                        for (let i = 0; i < numRendered; i++) {
                            const segIdx = visibleOrder[i];
                            const s = segData[segIdx];
                            const gx = Math.floor((s.x - gridMin) * invCellSize);
                            const gy = Math.floor((s.y - gridMin) * invCellSize);

                            if (gx >= 0 && gx < GRID_DIM && gy >= 0 && gy < GRID_DIM) {
                                s.gx = gx;
                                s.gy = gy;
                            } else {
                                s.gx = -1; // Mark as outside grid
                                s.gy = -1;
                            }
                        }

                        // Populate grid with all visible segments BEFORE calculating shadows
                        // Sort segments within each cell by z-depth (front to back) for early exit optimization
                        // [OPTIMIZATION] Use visibleOrder (culled list)
                        for (let i = 0; i < numRendered; i++) {
                            const segIdx = visibleOrder[i];
                            const s = segData[segIdx];
                            if (s.gx >= 0 && s.gy >= 0) {
                                const gridIndex = s.gx + s.gy * GRID_DIM;
                                grid[gridIndex].push(segIdx);
                            }
                        }

                        // Sort each grid cell by z-depth (front to back) for early exit
                        // Only sort cells that have multiple segments (optimization)
                        for (let cellIdx = 0; cellIdx < gridSize; cellIdx++) {
                            const cell = grid[cellIdx];
                            if (cell.length > 1) {
                                // Limit cell size first (faster than sorting large arrays)
                                if (cell.length > MAX_SEGMENTS_PER_CELL) {
                                    // For very large cells, just take the first MAX_SEGMENTS_PER_CELL
                                    // This is faster than sorting and then truncating
                                    cell.length = MAX_SEGMENTS_PER_CELL;
                                }
                                // Sort by z-depth descending (front to back) for early exit
                                // Simple sorting, no post-processing
                                // Only sort if cell has more than 2 segments (sorting 2 items is unnecessary)
                                if (cell.length > 2) {
                                    cell.sort((a, b) => {
                                        return segData[b].z - segData[a].z;
                                    });
                                } else if (cell.length === 2) {
                                    // For 2-item case, swap if needed for z-depth
                                    if (segData[cell[0]].z < segData[cell[1]].z) {
                                        const temp = cell[0];
                                        cell[0] = cell[1];
                                        cell[1] = temp;
                                    }
                                }
                            }
                        }

                        // Only process visible segments in outer loop
                        for (let i_idx = visibleOrder.length - 1; i_idx >= 0; i_idx--) {
                            const i = visibleOrder[i_idx];
                            let shadowSum = 0;
                            let maxTint = 0;
                            const s1 = segData[i];
                            const gx1 = s1.gx;
                            const gy1 = s1.gy;
                            const segInfoI = segments[i];
                            const isContactI = segInfoI.type === 'C';
                            const isMoleculeI = segInfoI.type === 'P' || segInfoI.type === 'D' || segInfoI.type === 'R';

                            if (gx1 < 0) {
                                shadows[i] = 1.0;
                                tints[i] = 1.0;
                                continue;
                            }

                            // Process grid cells to accumulate shadows
                            for (let dy = -1; dy <= 1; dy++) {
                                const gy2 = gy1 + dy;
                                if (gy2 < 0 || gy2 >= GRID_DIM) continue;
                                const rowOffset = gy2 * GRID_DIM;

                                for (let dx = -1; dx <= 1; dx++) {
                                    const gx2 = gx1 + dx;
                                    if (gx2 < 0 || gx2 >= GRID_DIM) continue;

                                    // Early exit: if shadow is already saturated, skip remaining cells
                                    if (shadowSum >= MAX_SHADOW_SUM) {
                                        break;
                                    }

                                    const gridIndex = gx2 + rowOffset;
                                    const cell = grid[gridIndex];
                                    const cellLen = cell.length;

                                    // Process segments in cell (already sorted by z-depth, front to back)
                                    // Since cells are sorted front-to-back, we can break early when we hit segments behind
                                    for (let k = 0; k < cellLen; k++) {
                                        const j = cell[k];

                                        // Early exit: if shadow is already saturated, skip remaining segments
                                        // Check this first before accessing segData (faster)
                                        if (shadowSum >= MAX_SHADOW_SUM && maxTint >= 1.0) {
                                            break;
                                        }

                                        // Shadow isolation: in overlay mode, only allow shadows within same frame
                                        if (this.overlayMode && this.frameIdMap) {
                                            const frameI = this.frameIdMap[segInfoI.idx1];
                                            const frameJ = this.frameIdMap[segments[j].idx1];
                                            if (frameI !== frameJ) {
                                                continue; // Skip shadows between different frames
                                            }
                                        }

                                        // Only visible segments are in the grid, so no visibility check needed
                                        const s2 = segData[j];
                                        const segInfoJ = segments[j];
                                        const isContactJ = segInfoJ.type === 'C';
                                        const isMoleculeJ = segInfoJ.type === 'P' || segInfoJ.type === 'D' || segInfoJ.type === 'R';

                                        // Skip if one is contact and one is molecule - contacts don't influence molecule shadows/tints
                                        if ((isContactI && isMoleculeJ) || (isMoleculeI && isContactJ)) {
                                            continue;
                                        }

                                        // CRITICAL: Only check segments that are in FRONT of i (closer to camera)
                                        // Segment j casts shadow on i only if j.z > i.z (j is in front)
                                        // Since cells are sorted front-to-back, if we hit a segment behind, we can break
                                        if (s2.z <= s1.z) {
                                            break; // All remaining segments in this cell are behind, skip them
                                        }

                                        // Early exit: if shadow is already saturated, skip remaining segments
                                        if (shadowSum >= MAX_SHADOW_SUM) {
                                            break;
                                        }

                                        // Call helper function with segment info for width weighting
                                        const { shadow, tint } = this._calculateShadowTint(s1, s2, segInfoI, segInfoJ);
                                        // Saturating accumulation: naturally caps at MAX_SHADOW_SUM
                                        shadowSum = Math.min(shadowSum + shadow, MAX_SHADOW_SUM);
                                        maxTint = Math.max(maxTint, tint);
                                    }
                                }
                            }

                            shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                            tints[i] = 1 - maxTint;
                        }
                    } else {
                        shadows.fill(1.0);
                        tints.fill(1.0);
                    }
                }

                // Cache shadows/tints when rotation hasn't changed (for reuse on width/ortho changes)
                // Store rotation matrix after calculation
                this.lastShadowRotationMatrix = this._deepCopyMatrix(this.rotationMatrix);

                // Cache shadows/tints for reuse
                if (isLargeMolecule && !this.isDragging && !this.isZooming && !this.isOrientAnimating) {
                    this.cachedShadows = new Float32Array(shadows);
                    this.cachedTints = new Float32Array(tints);
                } else if (!isLargeMolecule) {
                    // Small molecules: cache if rotation hasn't changed
                    if (!rotationChanged) {
                        this.cachedShadows = new Float32Array(shadows);
                        this.cachedTints = new Float32Array(tints);
                    } else {
                        // Rotation changed, clear cache
                        this.cachedShadows = null;
                        this.cachedTints = null;
                    }
                }
            } else if (skipShadowCalc && this.cachedShadows && this.cachedShadows.length === n) {
                // Use cached shadows (rotation hasn't changed, or dragging/zooming)
                shadows.set(this.cachedShadows);
                tints.set(this.cachedTints);
            } else if (!renderShadows) {
                // Shadows disabled - use defaults (no shadows/tints)
                shadows.fill(1.0);
                tints.fill(1.0);
            }
            // If skipShadowCalc is true but cache is invalid, shadows/tints remain uninitialized
            // This should not happen, but if it does, they'll be filled with defaults elsewhere

            // dataRange is just the molecule's extent in Angstroms
            // Use temporary extent if set (for orienting to visible positions), otherwise use object's maxExtent
            const effectiveExtent = this.temporaryExtent || maxExtent;
            const dataRange = (effectiveExtent * 2) || 1.0; // fallback to 1.0 to avoid div by zero

            // Calculate scale based on window dimensions and aspect ratio
            // Project the structure extent to screen space considering the rotation
            // The rotation matrix rows represent screen axes: R[0] = x-axis, R[1] = y-axis

            // Calculate projected extent in screen space (x and y directions)
            // The extent vector in 3D space, when rotated, projects to screen space
            // We approximate by using the rotation matrix rows to project the extent
            // For a roughly spherical extent, we can use the diagonal of the bounding box
            // But for better accuracy with oriented structures, we calculate projected extents

            // Project extent to x-axis (screen width direction)
            // The x screen axis direction is R[0], which is a unit vector
            // For a spherical extent, the projection is just the extent itself
            // But we need to consider how the actual 3D extent distribution
            // Since rotation matrix rows are orthonormal, we can use the extent directly
            // but we need to consider how the 3D bounding box projects to 2D
            // Approximate by using the extent scaled by the axis alignment
            const xProjectedExtent = effectiveExtent;
            const yProjectedExtent = effectiveExtent;

            // Calculate scale needed for each dimension
            // We want the structure to fit within the viewport with some padding
            const padding = 0.9; // Use 90% of viewport to leave some margin
            let scaleX = (displayWidth * padding) / (xProjectedExtent * 2);
            let scaleY = (displayHeight * padding) / (yProjectedExtent * 2);

            // Note: Do NOT compensate for perspective at the viewport scale level.
            // Individual atoms already get scaled correctly by their own perspective factor
            // (perspectiveScale = focalLength / z at line 5003).
            // The previous compensation code (using avgZ=0) was mathematically incorrect and
            // caused width jumps when switching between perspective modes near ortho=1.0

            // Use the minimum scale to ensure structure fits in both dimensions
            // This accounts for window aspect ratio
            const baseScale = Math.min(scaleX, scaleY);

            // Apply zoom multiplier
            const scale = baseScale * this.zoom;

            // baseLineWidth is this.lineWidth (in Angstroms) converted to pixels
            const baseLineWidthPixels = this.lineWidth * scale;

            const centerX = displayWidth / 2;
            const centerY = displayHeight / 2;

            // ====================================================================
            // DETECT OUTER ENDPOINTS - For rounded edges on outer segments
            // ====================================================================
            // Build a map of position connections to identify outer endpoints
            // [OPTIMIZATION] Phase 4: Allocation-free endpoint detection
            // Use pre-computed adjList and frame-based tracking to avoid Map/Set creation

            // 1. Mark visible segments in the frame tracking array
            this.renderFrameId++;
            const currentFrameId = this.renderFrameId;
            const segmentOrder = this.segmentOrder;
            const segmentFrame = this.segmentFrame;

            for (let i = 0; i < numRendered; i++) {
                const segIdx = visibleOrder[i];
                segmentOrder[segIdx] = i; // Store render order (0 is furthest)
                segmentFrame[segIdx] = currentFrameId; // Mark as visible in this frame
            }

            // 2. Pre-compute which endpoints should be rounded
            // Iterate over visible segments and check their endpoints using adjList
            // [OPTIMIZATION] Use Uint8Array for flags instead of Map
            const segmentEndpointFlags = this.segmentEndpointFlags;

            for (let i = 0; i < numRendered; i++) {
                const segIdx = visibleOrder[i];
                const segInfo = segments[segIdx];
                const isZeroSized = segInfo.idx1 === segInfo.idx2;
                const currentOrderIdx = i; // We know the order is 'i' from the loop
                const isPolymer = segInfo.type === 'P' || segInfo.type === 'D' || segInfo.type === 'R';

                // Extract properties once (used by both endpoint checks)
                const currentChainId = segInfo.chainId;
                const currentType = segInfo.type;

                // Helper to check if endpoint should be rounded
                const shouldRoundEndpoint = (positionIndex) => {
                    // Zero-sized segments always round
                    if (isZeroSized) return true;

                    // Contacts always have rounded endpoints
                    if (currentType === 'C') return true;

                    // Check connected segments using static adjacency list
                    const connectedSegments = this.adjList[positionIndex];
                    if (!connectedSegments) return true; // Should not happen if adjList is built correctly

                    // Filter for RELEVANT visible segments sharing this position
                    let relevantCount = 0;
                    let lowestOrderIdx = currentOrderIdx;

                    const len = connectedSegments.length;
                    for (let k = 0; k < len; k++) {
                        const otherSegIdx = connectedSegments[k];

                        // 1. Check visibility: must be in current frame
                        if (segmentFrame[otherSegIdx] !== currentFrameId) continue;

                        const otherSeg = segments[otherSegIdx];

                        // 2. Check connectivity type rules
                        let isRelevant = false;
                        if (isPolymer) {
                            // For polymers: must match type and chain
                            if (otherSeg.type === currentType && otherSeg.chainId === currentChainId) {
                                isRelevant = true;
                            }
                        } else {
                            // For ligands: only check other ligands
                            if (otherSeg.type === 'L') {
                                isRelevant = true;
                            }
                        }

                        if (isRelevant) {
                            relevantCount++;

                            // Check render order
                            const otherOrderIdx = segmentOrder[otherSegIdx];
                            if (otherOrderIdx < lowestOrderIdx) {
                                lowestOrderIdx = otherOrderIdx;
                            }
                        }
                    }

                    // Logic:
                    // 1. If only 1 relevant segment (itself), it's an outer endpoint -> Round
                    // 2. If multiple, only round if THIS segment is the one rendered first (lowest order)
                    if (relevantCount <= 1) return true;

                    return currentOrderIdx === lowestOrderIdx;
                };

                let flags = 0;
                if (shouldRoundEndpoint(segInfo.idx1)) flags |= 1; // Bit 0: Start
                if (shouldRoundEndpoint(segInfo.idx2)) flags |= 2; // Bit 1: End
                segmentEndpointFlags[segIdx] = flags;
            }

            // [OPTIMIZATION] Phase 5: SoA Projection Loop
            // Project all visible atoms once and store in SoA arrays
            this.screenFrameId++;
            const currentScreenFrameId = this.screenFrameId;
            const screenX = this.screenX;
            const screenY = this.screenY;
            const screenRadius = this.screenRadius;
            const screenValid = this.screenValid;

            // Helper to project a position if not already projected
            const projectPosition = (idx) => {
                if (screenValid[idx] === currentScreenFrameId) return; // Already projected

                const vec = rotated[idx];
                let x, y, radius;

                // Calculate width multiplier (simplified for positions)
                let widthMultiplier = 0.5;
                if (this.positionTypes && idx < this.positionTypes.length) {
                    // Reuse logic: simplified width calculation for atoms
                    const type = this.positionTypes[idx];
                    widthMultiplier = (this.typeWidthMultipliers && this.typeWidthMultipliers[type]) || 0.5;
                }
                let atomLineWidth = baseLineWidthPixels * widthMultiplier;

                if (this.perspectiveEnabled) {
                    const z = this.focalLength - vec.z;
                    if (z < 0.01) {
                        // Invalid (behind camera)
                        screenValid[idx] = 0; // Mark invalid
                        return;
                    }
                    const perspectiveScale = this.focalLength / z;
                    x = centerX + (vec.x * scale * perspectiveScale);
                    y = centerY - (vec.y * scale * perspectiveScale);
                    atomLineWidth *= perspectiveScale;
                } else {
                    x = centerX + vec.x * scale;
                    y = centerY - vec.y * scale;
                }

                radius = Math.max(2, atomLineWidth * 0.5);

                screenX[idx] = x;
                screenY[idx] = y;
                screenRadius[idx] = radius;
                screenValid[idx] = currentScreenFrameId;
            };

            // Iterate visible segments and project their endpoints
            for (let i = 0; i < numRendered; i++) {
                const segIdx = visibleOrder[i];
                const segInfo = segments[segIdx];
                projectPosition(segInfo.idx1);
                projectPosition(segInfo.idx2);
            }

            // [OPTIMIZATION] Ensure highlighted atoms are projected even if not in visible segments
            const numPositions = rotated.length;
            if (this.highlightedAtoms && this.highlightedAtoms.size > 0) {
                for (const idx of this.highlightedAtoms) {
                    if (idx >= 0 && idx < numPositions) {
                        projectPosition(idx);
                    }
                }
            }
            if (this.highlightedAtom !== null && this.highlightedAtom !== undefined) {
                const idx = this.highlightedAtom;
                if (idx >= 0 && idx < numPositions) {
                    projectPosition(idx);
                }
            }

            // ====================================================================
            // OPTIMIZED DRAWING LOOP - Reduced property changes and string ops
            // ====================================================================
            // Track last canvas properties to avoid redundant changes
            let lastStrokeStyle = null;
            let lastLineWidth = null;
            let lastLineCap = null;

            const setCanvasProps = (strokeStyle, lineWidth, lineCap) => {
                if (strokeStyle !== lastStrokeStyle) {
                    ctx.strokeStyle = strokeStyle;
                    lastStrokeStyle = strokeStyle;
                }
                if (lineWidth !== lastLineWidth) {
                    ctx.lineWidth = lineWidth;
                    lastLineWidth = lineWidth;
                }
                if (lineCap !== lastLineCap) {
                    ctx.lineCap = lineCap;
                    lastLineCap = lineCap;
                }
            };

            // [OPTIMIZATION] Simplified loop - visibleOrder is already culled
            // Only iterate over visible segments - no need for visibility check inside loop
            for (let i = 0; i < numRendered; i++) {
                const idx = visibleOrder[i];

                // Calculate opacity based on position in visibleOrder
                // i=0 is furthest (start of sliced array), i=numRendered-1 is closest
                // Distance from front: numRendered - 1 - i
                const distFromFront = numRendered - 1 - i;

                let opacity = 1.0;

                // --- 1. COMMON CALCULATIONS (Do these ONCE) ---
                const segInfo = segments[idx];

                // Color Calculation
                let { r, g, b } = colors[idx];
                r /= 255; g /= 255; b /= 255;

                // Skip shadows/tints/depth for contact segments - keep them bright and flat
                if (segInfo.type !== 'C') {
                    // Cache zNorm value
                    const zNormVal = zNorm[idx];

                    if (renderShadows) {
                        const tintFactor = this.depthEnabled
                            ? (0.50 * zNormVal + 0.50 * tints[idx]) / 3
                            : (0.50 * tints[idx]) / 3;
                        r = r + (1 - r) * tintFactor;
                        g = g + (1 - g) * tintFactor;
                        b = b + (1 - b) * tintFactor;
                        const shadowFactor = this.depthEnabled
                            ? (0.20 + 0.25 * zNormVal + 0.55 * shadows[idx])
                            : (0.20 + 0.80 * shadows[idx]);
                        r *= shadowFactor; g *= shadowFactor; b *= shadowFactor;
                    } else {
                        if (this.depthEnabled) {
                            const depthFactor = 0.70 + 0.30 * zNormVal;
                            r *= depthFactor; g *= depthFactor; b *= depthFactor;
                        }
                        // If depth coloring disabled, keep original colors unchanged
                    }
                }

                // Projection (Use pre-computed SoA values)
                const idx1 = segInfo.idx1;
                const idx2 = segInfo.idx2;

                // If either endpoint is invalid (behind camera), skip segment
                if (screenValid[idx1] !== currentScreenFrameId || screenValid[idx2] !== currentScreenFrameId) {
                    continue;
                }

                const x1 = screenX[idx1];
                const y1 = screenY[idx1];
                const x2 = screenX[idx2];
                const y2 = screenY[idx2];

                // Width Calculation: unified approach using helper
                const s = segData[idx];
                const widthMultiplier = this._calculateSegmentWidthMultiplier(s, segInfo);
                let currentLineWidth = baseLineWidthPixels * widthMultiplier;

                if (this.perspectiveEnabled) {
                    // Apply perspective scaling to the segment width
                    // Calculate the average perspective scale for this segment
                    // based on the Z-coordinates of its endpoints
                    const vec1 = rotated[idx1];
                    const vec2 = rotated[idx2];
                    const z1 = this.focalLength - vec1.z;
                    const z2 = this.focalLength - vec2.z;

                    // Average perspective scale for the segment
                    const avgPerspectiveScale = (this.focalLength / z1 + this.focalLength / z2) / 2;

                    // Apply perspective scale to the base width (which already includes widthMultiplier)
                    currentLineWidth *= avgPerspectiveScale;
                }

                currentLineWidth = Math.max(0.5, currentLineWidth);

                // --- 2. CONDITIONAL DRAWING ---
                const r_int = r * 255 | 0;
                const g_int = g * 255 | 0;
                const b_int = b * 255 | 0;

                // Use rgb for opacity
                const color = `rgb(${r_int},${g_int},${b_int})`;

                // For gap filler (outline), also apply opacity
                // Note: Gap filler is usually darker/lighter, here we just darken
                const gapR = r_int * 0.7 | 0;
                const gapG = g_int * 0.7 | 0;
                const gapB = b_int * 0.7 | 0;
                const gapFillerColor = `rgb(${gapR},${gapG},${gapB})`;

                // Get pre-computed endpoint rounding flags (Uint8Array)
                const flags = segmentEndpointFlags[idx];
                const hasOuterStart = (flags & 1) !== 0;
                const hasOuterEnd = (flags & 2) !== 0;

                if (this.outlineMode === 'none') {
                    // --- 1-STEP DRAW (No Outline) ---
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(color, currentLineWidth, 'round');
                    ctx.stroke();
                } else if (this.outlineMode === 'partial') {
                    // --- 2-STEP DRAW (Partial Outline) - Background segment with butt caps only (no rounded caps) ---
                    const totalOutlineWidth = currentLineWidth + this.relativeOutlineWidth;

                    // Pass 1: Gap filler outline (3px larger than main line) with butt caps only
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(gapFillerColor, totalOutlineWidth, 'butt');
                    ctx.stroke();

                    // No rounded caps in partial mode

                    // Pass 2: Main colored line (always round caps)
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(color, currentLineWidth, 'round');
                    ctx.stroke();
                } else { // this.outlineMode === 'full'
                    // --- 2-STEP DRAW (Full Outline) - Background segment with rounded caps at outer endpoints ---
                    const totalOutlineWidth = currentLineWidth + this.relativeOutlineWidth;

                    // Pass 1: Gap filler outline (3px larger than main line)
                    // Draw line with butt caps, then add rounded caps manually at outer endpoints
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(gapFillerColor, totalOutlineWidth, 'butt');
                    ctx.stroke();

                    // Add rounded caps at outer endpoints
                    const outlineRadius = totalOutlineWidth / 2;
                    if (hasOuterStart) {
                        ctx.beginPath();
                        ctx.arc(x1, y1, outlineRadius, 0, Math.PI * 2);
                        ctx.fillStyle = gapFillerColor;
                        ctx.fill();
                    }
                    if (hasOuterEnd) {
                        ctx.beginPath();
                        ctx.arc(x2, y2, outlineRadius, 0, Math.PI * 2);
                        ctx.fillStyle = gapFillerColor;
                        ctx.fill();
                    }

                    // Pass 2: Main colored line (always round caps)
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(color, currentLineWidth, 'round');
                    ctx.stroke();
                }
            }
            // ====================================================================
            // END OF REFACTORED LOOP
            // ====================================================================

            // ====================================================================
            // STORE POSITION SCREEN POSITIONS for fast highlight drawing
            // ====================================================================
            // [OPTIMIZATION] Phase 5: Removed redundant position loop
            // Screen positions are already computed in SoA arrays (screenX, screenY, screenRadius)
            // during the projection phase above.
            // The sequence viewer will access these arrays directly.

            // Draw highlights on overlay canvas (doesn't require full render)
            // Highlight overlay is now managed by sequence viewer
            // Skip drawing highlights during dragging to prevent interference
            if (!this.isDragging && window.SequenceViewer && window.SequenceViewer.drawHighlights) {
                window.SequenceViewer.drawHighlights();
            }
        }

        // [OPTIMIZATION] Phase 6: Public API for highlights
        // Returns array of {x, y, radius} for currently highlighted atoms
        // Decouples external viewers from internal SoA arrays
        getHighlightCoordinates() {
            const coords = [];
            // Ensure arrays exist
            if (!this.screenValid || !this.screenX || !this.screenY || !this.screenRadius) {
                return coords;
            }

            const addCoord = (idx) => {
                // Check if projected in current frame
                if (idx >= 0 && idx < this.screenValid.length && this.screenValid[idx] === this.screenFrameId) {
                    coords.push({
                        x: this.screenX[idx],
                        y: this.screenY[idx],
                        radius: this.screenRadius[idx]
                    });
                }
            };

            // Add multiple highlights
            if (this.highlightedAtoms && this.highlightedAtoms.size > 0) {
                for (const idx of this.highlightedAtoms) {
                    addCoord(idx);
                }
            }

            // Add single highlight
            if (this.highlightedAtom !== null && this.highlightedAtom !== undefined) {
                addCoord(this.highlightedAtom);
            }

            return coords;
        }

        // Main animation loop
        animate() {
            // Skip all work if dragging (mousemove handler calls render directly)
            if (this.isDragging) {
                // Don't schedule another frame - mousemove will call render directly
                return;
            }

            const now = performance.now();
            let needsRender = false;

            // 1. Handle inertia/spin - disabled during recording and for large molecules
            if (!this.isRecording) {
                // Check if object is large (disable inertia for performance based on visible segments)
                const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                const totalSegmentCount = object && this.segmentIndices ? this.segmentIndices.length : 0;
                // Count visible segments for inertia determination
                let visibleSegmentCount = totalSegmentCount;
                if (this.visibilityMask && this.segmentIndices) {
                    visibleSegmentCount = 0;
                    for (let i = 0; i < this.segmentIndices.length; i++) {
                        const seg = this.segmentIndices[i];
                        if (this.visibilityMask.has(seg.idx1) && this.visibilityMask.has(seg.idx2)) {
                            visibleSegmentCount++;
                        }
                    }
                }
                const enableInertia = visibleSegmentCount <= this.LARGE_MOLECULE_CUTOFF;

                if (enableInertia) {
                    const INERTIA_THRESHOLD = 0.0001; // Stop when velocity is below this

                    if (Math.abs(this.spinVelocityX) > INERTIA_THRESHOLD) {
                        const rot = rotationMatrixY(this.spinVelocityX * 0.005);
                        this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                        this.spinVelocityX *= 0.95; // Damping
                        needsRender = true;
                    } else {
                        this.spinVelocityX = 0;
                    }

                    if (Math.abs(this.spinVelocityY) > INERTIA_THRESHOLD) {
                        const rot = rotationMatrixX(this.spinVelocityY * 0.005);
                        this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                        this.spinVelocityY *= 0.95; // Damping
                        needsRender = true;
                    } else {
                        this.spinVelocityY = 0;
                    }
                } else {
                    // Disable inertia for large objects
                    this.spinVelocityX = 0;
                    this.spinVelocityY = 0;
                }
            }

            // 2. Handle auto-rotate
            if (this.autoRotate && this.spinVelocityX === 0 && this.spinVelocityY === 0) {
                const rot = rotationMatrixY(0.005); // Constant rotation speed
                this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                needsRender = true;
            }

            // 3. Check if frame changed (decoupled frame advancement)
            const currentFrame = this.currentFrame;
            const previousFrame = this.lastRenderedFrame;
            if (previousFrame !== currentFrame && this.currentObjectName) {
                // Frame changed - ensure data is loaded (may have been loaded by timer)
                const object = this.objectsData[this.currentObjectName];
                if (object && object.frames[currentFrame]) {
                    // Data should already be loaded by _loadFrameData in timer
                    // But ensure it's loaded if somehow it wasn't
                    if (this.coords.length === 0 || this.lastRenderedFrame === -1) {
                        this._loadFrameData(currentFrame, true); // Load without render
                    }
                    needsRender = true;
                }
            }

            // 4. Final render if needed
            if (needsRender) {
                this.render('animate loop');
                if (previousFrame !== currentFrame) {
                    this.lastRenderedFrame = currentFrame;
                }
            }

            // 5. Loop
            requestAnimationFrame(() => this.animate());
        }

        // Save as SVG
        saveAsSvg() {
            try {
                if (typeof C2S === 'undefined') {
                    throw new Error("canvas2svg library not loaded");
                }

                const canvas = this.canvas;
                if (!canvas) {
                    throw new Error("Canvas not found");
                }

                // Get display dimensions
                const width = this.displayWidth || parseInt(canvas.style.width) || canvas.width;
                const height = this.displayHeight || parseInt(canvas.style.height) || canvas.height;

                // Create SVG context and render directly to it - no context switching needed!
                const svgCtx = new C2S(width, height);
                this._renderToContext(svgCtx, width, height);

                // Get SVG string and download
                const svgString = svgCtx.getSerializedSvg();
                this._downloadSvg(svgString, this.currentObjectName);
            } catch (e) {
                console.error("Failed to export SVG:", e);
                const errorMsg = `Error exporting SVG: ${e.message}`;
                if (typeof setStatus === 'function') {
                    setStatus(errorMsg, true);
                } else {
                    alert(errorMsg);
                }
            }
        }

        // Helper method to download SVG file
        _downloadSvg(svgString, objectName) {
            // Create filename with object name and timestamp
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);

            // Sanitize object name for filename
            let name = objectName || 'viewer';
            name = name.replace(/[^a-zA-Z0-9_-]/g, '_');
            if (name.length > 50) {
                name = name.substring(0, 50);
            }

            const svgFilename = `py2dmol_${name}_${timestamp}.svg`;

            // Download the SVG file
            const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = svgFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Use setStatus if available (index.html), otherwise console.log (viewer.html)
            if (typeof setStatus === 'function') {
                setStatus(`SVG exported to ${svgFilename}`);
            }
        }
    }

    // ============================================================================
    // PAE RENDERER
    // ============================================================================
    // PAERenderer class moved to viewer-pae.js
    // Use window.PAERenderer if available (loaded from viewer-pae.js)

    // ============================================================================
    // MAIN APP & COLAB COMMUNICATION
    // ============================================================================

    // 1. Get config from Python
    // This relies on window.viewerConfig being available globally
    const config = window.viewerConfig || {
        size: [300, 300],
        pae_size: 300,
        color: "auto",
        shadow: true,
        outline: true,
        width: 3.0,
        rotate: false,
        controls: true,
        autoplay: false,
        box: true,
        pastel: 0.25,
        pae: false,
        colorblind: false
    };

    // 2. Setup Canvas with high-DPI scaling for crisp rendering
    const canvas = containerElement.querySelector('#canvas');
    if (!canvas) {
        console.error("py2dmol: Could not find #canvas element in container.");
        return;
    }

    // Get device pixel ratio for high-DPI displays
    // Use devicePixelRatio for native scaling, capped at 1.5x for performance
    // Can be overridden with window.canvasDPR
    const currentDPR = window.canvasDPR !== undefined ? window.canvasDPR : Math.min(window.devicePixelRatio || 1, 1.5);

    // Store display dimensions as constants - these never change
    const displayWidth = config.size[0];
    const displayHeight = config.size[1];
    // pae_size is now a single integer (backward compatible: if array/tuple, use first value)
    const paeSize = Array.isArray(config.pae_size) || (typeof config.pae_size === 'object' && config.pae_size.length !== undefined)
        ? config.pae_size[0]
        : config.pae_size;
    const paeDisplayWidth = paeSize;
    const paeDisplayHeight = paeSize;

    // Initialize canvas with DPI scaling (before renderer creation)
    canvas.width = displayWidth * currentDPR;
    canvas.height = displayHeight * currentDPR;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';

    // Scale the context to match the internal resolution
    const ctx = canvas.getContext('2d');
    ctx.scale(currentDPR, currentDPR);

    const viewerColumn = containerElement.querySelector('#viewerColumn');

    // We no longer set a fixed width on viewerColumn, to allow resizing.

    // 3. Create renderer
    const renderer = new Pseudo3DRenderer(canvas);

    // ADDED: ResizeObserver to handle canvas resizing
    const canvasContainer = containerElement.querySelector('#canvasContainer');

    // Set initial container dimensions to match canvas size
    // This prevents the container from shrinking when the window is closed/reopened
    if (canvasContainer) {
        canvasContainer.style.width = displayWidth + 'px';
        canvasContainer.style.height = displayHeight + 'px';
    }
    if (canvasContainer && window.ResizeObserver) {
        let resizeTimeout;
        const resizeObserver = new ResizeObserver(entries => {
            // Debounce resize to avoid excessive rendering
            if (resizeTimeout) clearTimeout(resizeTimeout);

            resizeTimeout = setTimeout(() => {
                for (let entry of entries) {
                    // Get new dimensions from the container
                    let newWidth = entry.contentRect.width;
                    let newHeight = entry.contentRect.height;

                    // Ensure non-zero dimensions which can break canvas
                    newWidth = Math.max(newWidth, 1);
                    newHeight = Math.max(newHeight, 1);

                    // Only update if display size actually changed
                    const currentDisplayWidth = parseInt(canvas.style.width) || displayWidth;
                    const currentDisplayHeight = parseInt(canvas.style.height) || displayHeight;

                    if (Math.abs(newWidth - currentDisplayWidth) > 1 ||
                        Math.abs(newHeight - currentDisplayHeight) > 1) {
                        // Update canvas resolution with high-DPI scaling
                        const internalWidth = newWidth * currentDPR;
                        const internalHeight = newHeight * currentDPR;

                        canvas.width = internalWidth;
                        canvas.height = internalHeight;
                        canvas.style.width = newWidth + 'px';
                        canvas.style.height = newHeight + 'px';

                        // Scale context to match internal resolution
                        const ctx = canvas.getContext('2d');
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.scale(currentDPR, currentDPR);

                        // Update cached dimensions in renderer
                        renderer._updateCanvasDimensions();

                        // Always render on resize - canvas setup is necessary for proper display
                        renderer.render('ResizeObserver');
                    }
                }
            }, 100); // 100ms debounce
        });

        // Start observing the canvas container
        resizeObserver.observe(canvasContainer);
    } else if (!window.ResizeObserver) {
        console.warn("py2dmol: ResizeObserver not supported. Canvas resizing will not work.");
    }

    // 4. Setup PAE Renderer (if enabled and PAE module is loaded)
    if (config.pae && window.PAERenderer) {
        try {
            const paeContainer = containerElement.querySelector('#paeContainer');
            const paeCanvas = containerElement.querySelector('#paeCanvas');
            if (!paeContainer || !paeCanvas) {
                console.warn("PAE container or canvas not found");
            } else {
                renderer.paeContainer = paeContainer;
                paeContainer.style.display = 'none';

                // Function to update PAE canvas size based on container
                const updatePAECanvasSize = () => {
                    const containerRect = paeContainer.getBoundingClientRect();
                    const paeContainerWidth = containerRect.width || 340;
                    const paeContainerHeight = containerRect.height || paeContainerWidth;

                    // Set canvas size to match container
                    paeCanvas.width = paeContainerWidth;
                    paeCanvas.height = paeContainerHeight;

                    // Use 100% to fill container
                    paeCanvas.style.width = '100%';
                    paeCanvas.style.height = '100%';

                    // Update context
                    const paeCtx = paeCanvas.getContext('2d');
                    paeCtx.setTransform(1, 0, 0, 1, 0, 0);

                    // Update PAE renderer size if it exists
                    if (renderer.paeRenderer) {
                        renderer.paeRenderer.size = paeContainerWidth;
                        renderer.paeRenderer.scheduleRender();
                    }

                    return paeContainerWidth;
                };

                // Set initial size (will be updated when container is visible)
                updatePAECanvasSize();

                // Update size when container becomes visible (in case it was hidden)
                requestAnimationFrame(() => {
                    updatePAECanvasSize();

                    const paeRenderer = new window.PAERenderer(paeCanvas, renderer);
                    const containerRect = paeContainer.getBoundingClientRect();
                    paeRenderer.size = containerRect.width || 340;
                    renderer.setPAERenderer(paeRenderer);
                    // If static data was already loaded, set PAE data for current frame
                    if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                        const object = renderer.objectsData[renderer.currentObjectName];
                        if (object.frames && object.frames.length > 0 && renderer.currentFrame >= 0) {
                            const currentFrame = object.frames[renderer.currentFrame];
                            if (currentFrame && currentFrame.pae) {
                                paeRenderer.setData(currentFrame.pae);
                            }
                        }
                    }
                    renderer.updatePAEContainerVisibility();
                });
            }
        } catch (e) {
            console.error("Failed to initialize PAE renderer:", e);
        }
    } else if (config.pae && !window.PAERenderer) {
        console.warn("PAE is enabled but viewer-pae.js is not loaded. PAE functionality will not be available.");
    }

    // 5. Setup general controls
    const colorSelect = containerElement.querySelector('#colorSelect');

    // Initialize color mode
    const validModes = ['auto', 'chain', 'rainbow', 'plddt'];
    if (!renderer.colorMode || !validModes.includes(renderer.colorMode)) {
        renderer.colorMode = (config.color && validModes.includes(config.color)) ? config.color : 'auto';
    }
    // Sync dropdown to renderer's colorMode
    if (colorSelect && renderer.colorMode) {
        colorSelect.value = renderer.colorMode;
    }

    colorSelect.addEventListener('change', (e) => {
        const selectedMode = e.target.value;
        const validModes = ['auto', 'chain', 'rainbow', 'plddt', 'deepmind', 'entropy'];

        if (validModes.includes(selectedMode)) {
            renderer.colorMode = selectedMode;
            renderer.colorsNeedUpdate = true;
            renderer.plddtColorsNeedUpdate = true;

            // Map entropy to structure if entropy mode is selected
            if (selectedMode === 'entropy') {
                renderer._mapEntropyToStructure();
            } else {
                // Clear entropy when switching away from entropy mode
                renderer.entropy = undefined;
            }

            renderer.render();
            document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        } else {
            // Invalid mode - reset dropdown to current colorMode
            colorSelect.value = renderer.colorMode || 'auto';
        }
    });

    // Store reference to colorSelect in renderer for syncing
    renderer.colorSelect = colorSelect;

    // Setup shadowEnabledCheckbox
    const shadowEnabledCheckbox = containerElement.querySelector('#shadowEnabledCheckbox');
    shadowEnabledCheckbox.checked = renderer.shadowEnabled; // Set default from renderer

    // Setup outline control - can be either a button (index.html) or dropdown (viewer.html)
    const outlineModeButton = containerElement.querySelector('#outlineModeButton');
    const outlineModeSelect = containerElement.querySelector('#outlineModeSelect');

    if (outlineModeButton) {
        // Button mode (index.html) - style will be set by updateOutlineButtonStyle() in setUIControls
    } else if (outlineModeSelect) {
        // Dropdown mode (viewer.html)
        outlineModeSelect.value = renderer.outlineMode || 'full';
        outlineModeSelect.addEventListener('change', (e) => {
            renderer.outlineMode = e.target.value;
            renderer.render();
        });
    }

    // Setup depthCheckbox
    const depthCheckbox = containerElement.querySelector('#depthCheckbox');
    if (depthCheckbox) {
        depthCheckbox.checked = renderer.depthEnabled; // Set default from renderer
    }

    // Setup colorblindCheckbox
    const colorblindCheckbox = containerElement.querySelector('#colorblindCheckbox');
    colorblindCheckbox.checked = renderer.colorblindMode; // Set default from renderer

    // 6. Setup animation and object controls
    const controlsContainer = containerElement.querySelector('#controlsContainer');
    const playButton = containerElement.querySelector('#playButton');
    const overlayButton = containerElement.querySelector('#overlayButton');
    // recordButton and saveSvgButton might be in containerElement or in document (web app vs embedded)
    const recordButton = containerElement.querySelector('#recordButton') || document.querySelector('#recordButton');
    const saveSvgButton = containerElement.querySelector('#saveSvgButton') || document.querySelector('#saveSvgButton');
    const frameSlider = containerElement.querySelector('#frameSlider');
    const frameCounter = containerElement.querySelector('#frameCounter');
    // objectSelect is now in the sequence header, query from container
    const objectSelect = containerElement.querySelector('#objectSelect');
    const speedSelect = containerElement.querySelector('#speedSelect');
    const rotationCheckbox = containerElement.querySelector('#rotationCheckbox');
    const lineWidthSlider = containerElement.querySelector('#lineWidthSlider');
    const outlineWidthSlider = containerElement.querySelector('#outlineWidthSlider');
    const orthoSlider = containerElement.querySelector('#orthoSlider');


    // Set defaults for width, rotate, and pastel
    if (lineWidthSlider) lineWidthSlider.value = renderer.lineWidth;
    if (outlineWidthSlider) outlineWidthSlider.value = renderer.relativeOutlineWidth || 3.0;
    rotationCheckbox.checked = renderer.autoRotate;

    // Pass ALL controls to the renderer
    renderer.setUIControls(
        controlsContainer, playButton, overlayButton, recordButton, saveSvgButton,
        frameSlider, frameCounter, objectSelect,
        speedSelect, rotationCheckbox, lineWidthSlider, outlineWidthSlider,
        shadowEnabledCheckbox, outlineModeButton, outlineModeSelect,
        depthCheckbox, colorblindCheckbox, orthoSlider
    );

    // Setup save state button (for Python interface only - web interface handles it in app.js)
    // Only add listener if we're in Python interface (no window.saveViewerState exists yet)
    const saveStateButton = containerElement.querySelector('#saveStateButton');
    if (saveStateButton && typeof window.saveViewerState !== 'function') {
        saveStateButton.addEventListener('click', () => {
            // For Python interface, use view.save_state(filepath) method
            alert("Save state: Use the Python method view.save_state(filepath) to save the current state.");
        });
    }

    // Set ortho slider from config
    if (config.ortho !== undefined && orthoSlider) {
        orthoSlider.value = normalizeOrthoValue(config.ortho);
        // The slider's input event will be triggered after data loads to set the correct focalLength
    }



    // Handle new UI config options
    if (!config.controls) {
        const rightPanel = containerElement.querySelector('#rightPanelContainer');
        if (rightPanel) rightPanel.style.display = 'none';
        // controlsContainer is handled by updateUIControls
    }

    // Handle box
    if (!config.box) {
        const canvasCont = containerElement.querySelector('#canvasContainer');
        if (canvasCont) {
            canvasCont.style.border = 'none';
            canvasCont.style.background = 'transparent';
        }
        if (canvas) canvas.style.background = 'transparent';

        // Also update PAE canvas if it exists
        if (config.pae) {
            const paeCanvas = containerElement.querySelector('#paeCanvas');
            if (paeCanvas) {
                paeCanvas.style.border = 'none';
                paeCanvas.style.background = 'transparent';
            }
        }

        renderer.setClearColor(true);
    }

    // 7. Add function for Python to call (for new frames)
    // These are now locally scoped consts, not on window
    const handlePythonUpdate = (jsonDataOrObject, objectName) => {
        try {
            // Accept either JSON string or raw object to avoid Uint8Array serialization issues
            const data = typeof jsonDataOrObject === 'string' ? JSON.parse(jsonDataOrObject) : jsonDataOrObject;
            // Pass name to addFrame
            renderer.addFrame(data, objectName);
        } catch (e) {
            console.error("Failed to parse JSON from Python:", e);
        }
    };

    // 8. Add function for Python to start a new object
    const handlePythonNewObject = (name) => {
        renderer.addObject(name);
    };

    // 9. Add function for Python to clear everything
    const handlePythonClearAll = () => {
        renderer.clearAllObjects();
    };

    // 9b. Add function to reset all controls and state
    const handlePythonResetAll = () => {
        renderer.resetAll();
    };

    // 10. Add function for Python to set color mode (e.g., for from_afdb)
    const handlePythonSetColor = (colorMode) => {
        if (colorSelect) {
            colorSelect.value = colorMode;
            // Manually trigger the change event
            colorSelect.dispatchEvent(new Event('change'));
        }
    };


    // 11. Load initial data
    if (window.staticObjectData && window.staticObjectData.length > 0) {
        // === STATIC MODE (from show()) ===
        try {
            for (const obj of window.staticObjectData) {
                if (obj.name && obj.frames && obj.frames.length > 0) {

                    const staticChains = obj.chains; // Might be undefined
                    const staticPositionTypes = obj.position_types; // Might be undefined
                    const staticContacts = obj.contacts; // Might be undefined

                    for (let i = 0; i < obj.frames.length; i++) {
                        const lightFrame = obj.frames[i];

                        // Robust resolution: frame-level > object-level > undefined (will use defaults)
                        const n = lightFrame.coords ? lightFrame.coords.length : 0;

                        // Re-construct the full frame data with proper inheritance
                        const fullFrameData = {
                            coords: lightFrame.coords,  // Required
                            // Resolve with fallbacks: frame-level > object-level > undefined
                            chains: lightFrame.chains || staticChains || undefined,
                            position_types: lightFrame.position_types || staticPositionTypes || undefined,
                            plddts: lightFrame.plddts || undefined,  // Will use inheritance or default in setCoords
                            pae: lightFrame.pae || undefined,  // Will use inheritance or default
                            position_names: lightFrame.position_names || undefined,  // Will default in setCoords
                            residue_numbers: lightFrame.residue_numbers || undefined  // Will default in setCoords
                        };

                        renderer.addFrame(fullFrameData, obj.name);
                    }

                    // Store contacts at object level if present
                    if (staticContacts) {
                        const object = renderer.objectsData[obj.name];
                        if (object) {
                            object.contacts = staticContacts;
                            // Invalidate segment cache to ensure contacts are included in next render
                            renderer.cachedSegmentIndices = null;
                        }
                    }
                }
            }
            // Set view to the first frame of the first object
            if (window.staticObjectData.length > 0) {
                renderer.currentObjectName = window.staticObjectData[0].name;
                renderer.objectSelect.value = window.staticObjectData[0].name;

                // Populate entropy data from MSA if available
                const firstObjectName = window.staticObjectData[0].name;
                if (renderer.objectsData[firstObjectName]?.msa?.msasBySequence &&
                    renderer.objectsData[firstObjectName]?.msa?.chainToSequence) {
                    renderer._mapEntropyToStructure(firstObjectName);
                }

                renderer.setFrame(0);
                // Update PAE container visibility after initial load
                // Use requestAnimationFrame to ensure PAE renderer is initialized
                requestAnimationFrame(() => {
                    renderer.updatePAEContainerVisibility();
                });
            }
        } catch (error) {
            console.error("Error loading static object data:", error);
            renderer.setFrame(-1); // Start empty on error
        }

    } else if (window.proteinData && window.proteinData.coords && window.proteinData.coords.length > 0) {
        // === HYBRID MODE (first frame) ===
        try {
            // Load the single, statically-injected frame into "0"
            renderer.addFrame(window.proteinData, "0");
        } catch (error) {
            console.error("Error loading initial data:", error);
            renderer.setFrame(-1);
        }
    } else {
        // === EMPTY DYNAMIC MODE ===
        // No initial data, start with an empty canvas.
        renderer.setFrame(-1);
    }

    // After data load, trigger ortho slider to set correct initial focal length
    if (orthoSlider) {
        orthoSlider.dispatchEvent(new Event('input'));
    }


    // 12. Start the main animation loop
    renderer.animate();

    // 12.5. If overlay_frames is enabled, activate overlay mode
    if (config.overlay_frames && renderer) {
        // Use a small delay to ensure renderer is ready
        setTimeout(() => {
            if (renderer.toggleOverlay) {
                renderer.toggleOverlay();
            }
        }, 100);
    }

    // 13. Expose Public API
    const viewer_id = config.viewer_id;
    if (viewer_id) {
        window.py2dmol_viewers[viewer_id] = {
            handlePythonUpdate,
            handlePythonNewObject,
            handlePythonClearAll,
            handlePythonResetAll,
            handlePythonSetColor,
            renderer // Expose the renderer instance for external access
        };
    } else {
        console.error("py2dmol: viewer_id not found in config. Cannot register API.");
    }

} // <-- End of initializePy2DmolViewer