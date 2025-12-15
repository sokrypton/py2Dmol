// ============================================================================
// py2Dmol/resources/viewer-mol.js
// -------------------------------
// AI Context: CORE RENDERER (Pseudo3DRenderer)
// - This is the heart of the visualization.
// - Implements `Pseudo3DRenderer` class.
// - Handles 3D projection, depth sorting, and canvas drawing.
// - Manages the scene graph (objects, frames, atoms).
// - Handles user interaction (rotation, zoom, selection).
// - Shared by both the Python widget and the standalone Web App.
// ============================================================================
// GLOBAL REGISTRY
// ============================================================================
// Global registry for all viewer instances
if (!window.py2dmol_viewers) {
    window.py2dmol_viewers = {};
}

// Registry for custom color modes (e.g., "binding", "conservation", etc.)
if (!window.py2dmol_customColors) {
    window.py2dmol_customColors = {};
}

/**
 * Register a custom color mode that can be used in color dropdowns
 * @param {string} modeName - Name of the color mode (e.g., "binding", "conservation")
 * @param {function} colorFunc - Function(atomIndex, renderer) -> {r, g, b} color object
 */
function registerCustomColorMode(modeName, colorFunc) {
    if (!window.py2dmol_customColors) {
        window.py2dmol_customColors = {};
    }
    window.py2dmol_customColors[modeName] = colorFunc;
}

/**
 * Get all valid color modes (including custom ones)
 */
function getAllValidColorModes() {
    const builtinModes = ['auto', 'chain', 'rainbow', 'plddt', 'deepmind', 'entropy'];
    const customModes = window.py2dmol_customColors ? Object.keys(window.py2dmol_customColors) : [];
    return builtinModes.concat(customModes);
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
function initializePy2DmolViewer(containerElement, viewerId) {

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
    const colorblindSafeChainColors = [
        "#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD",
        "#8C564B", "#E377C2", "#7F7F7F", "#BCBD22", "#17BECF",
        "#AEC7E8", "#FFBB78", "#98DF8A", "#FF9896", "#C5B0D5",
        "#C49C94", "#F7B6D2", "#C7C7C7", "#DBDB8D", "#9EDAE5",
        "#393B79", "#637939", "#8C6D31", "#843C39", "#7B4173",
        "#5254A3", "#8CA252", "#BD9E39", "#AD494A", "#A55194"];
    const LIGHTEN_FACTOR = 0.25;

    // Named color map for common color names
    const namedColorsMap = {
        "red": "#ff0000", "green": "#00ff00", "blue": "#0000ff", "yellow": "#ffff00", "cyan": "#00ffff", "magenta": "#ff00ff",
        "orange": "#ffa500", "purple": "#800080", "pink": "#ffc0cb", "brown": "#8b4513", "gray": "#808080", "grey": "#808080",
        "white": "#ffffff", "black": "#000000", "lime": "#00ff00", "navy": "#000080", "teal": "#008080",
        "silver": "#c0c0c0", "maroon": "#800000", "olive": "#808000", "aqua": "#00ffff", "fuchsia": "#ff00ff"
    };

    function hexToRgb(hex) { if (!hex || typeof hex !== 'string') { return { r: 128, g: 128, b: 128 }; } const r = parseInt(hex.slice(1, 3), 16); const g = parseInt(hex.slice(3, 5), 16); const b = parseInt(hex.slice(5, 7), 16); return { r, g, b }; }
    function rgbToHex({ r, g, b }) { const clamp = (v) => Math.max(0, Math.min(255, Math.round(v))); const cr = clamp(r).toString(16).padStart(2, '0'); const cg = clamp(g).toString(16).padStart(2, '0'); const cb = clamp(b).toString(16).padStart(2, '0'); return `#${cr}${cg}${cb}`; }
    function lightenRgb(color, factor = LIGHTEN_FACTOR) { return { r: Math.round(color.r * (1 - factor) + 255 * factor), g: Math.round(color.g * (1 - factor) + 255 * factor), b: Math.round(color.b * (1 - factor) + 255 * factor) }; }
    function lightenHex(hex, factor = LIGHTEN_FACTOR) { return rgbToHex(lightenRgb(hexToRgb(hex), factor)); }
    const chainColors = pymolColors.map(hex => lightenHex(hex));
    const chainColorsColorblind = colorblindSafeChainColors.map(hex => lightenHex(hex));
    const DEFAULT_GREY = { r: 160, g: 160, b: 160 };
    const DEFAULT_CONTACT_COLOR = { r: 255, g: 255, b: 0 };
    function hsvToRgb(h, s, v) {
        const c = v * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = v - c;
        let r, g, b;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
    }
    function lightenColor(color) { return lightenRgb(color, LIGHTEN_FACTOR); }

    // N-term (blue) to C-term (red/yellow)
    function getRainbowColor(value, min, max, colorblind = false) {
        if (max - min < 1e-6) return lightenColor(hsvToRgb(240, 1.0, 1.0)); // Default to blue
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        const hue = colorblind
            ? 240 - normalized * 180  // Blue (240°) → Yellow (60°)
            : 240 * (1 - normalized);  // Blue (240°) → Red (0°)
        return lightenColor(hsvToRgb(hue, 1.0, 1.0));
    }

    // pLDDT rainbow: 50 (red/yellow) to 90 (blue)
    function getPlddtRainbowColor(value, min, max, colorblind = false) {
        if (max - min < 1e-6) {
            return lightenColor(hsvToRgb(colorblind ? 60 : 0, 1.0, 1.0)); // Default to yellow or red
        }
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        const hue = colorblind
            ? 60 + normalized * 180   // Yellow (60°) → Blue (240°)
            : normalized * 240;        // Red (0°) → Blue (240°)
        return lightenColor(hsvToRgb(hue, 1.0, 1.0));
    }

    function getPlddtColor(plddt, colorblind = false) {
        return getPlddtRainbowColor(plddt, 50, 90, colorblind);
    }



    // AlphaFold pLDDT color scheme (4 categories based on confidence)
    // Based on PyMOL AlphaFold plugin colors
    function getPlddtAFColor(plddt, colorblind = false) {
        if (colorblind) {
            // Colorblind-safe: Blue → Green → Yellow → Red
            if (plddt >= 90) return { r: 0, g: 100, b: 255 };      // Blue
            else if (plddt >= 70) return { r: 0, g: 200, b: 100 }; // Green
            else if (plddt >= 50) return { r: 255, g: 255, b: 0 }; // Yellow
            else return { r: 255, g: 0, b: 0 };                    // Red
        } else {
            // Official AlphaFold: Dark Blue → Cyan → Yellow → Orange
            if (plddt >= 90) return { r: 13, g: 87, b: 211 };      // Dark Blue
            else if (plddt >= 70) return { r: 106, g: 203, b: 241 }; // Cyan
            else if (plddt >= 50) return { r: 254, g: 217, b: 54 }; // Yellow
            else return { r: 253, g: 125, b: 77 };                 // Orange
        }
    }

    function getChainColor(chainIndex) { if (chainIndex < 0) chainIndex = 0; return hexToRgb(pymolColors[chainIndex % pymolColors.length]); }

    // PAE color functions moved to viewer-pae.js

    // ============================================================================
    // COLOR RESOLUTION (Unified Hierarchy System)
    // ============================================================================

    /**
     * Resolves color through the hierarchy: position > chain > frame > object > global
     * @param {Object} context - { frameIndex, posIndex, chainId, renderer }
     * @param {Object} colorSpec - { type: "mode"|"literal"|"advanced", value: ... }
     * @returns {Object} - {resolvedMode: "chain"|"plddt"|etc, resolvedColor: "#hex"|{r,g,b}|null}
     */
    function resolveColorHierarchy(context, colorSpec) {
        const { frameIndex, posIndex, chainId, renderer } = context;
        const objectName = renderer.currentObjectName;
        const object = renderer.objectsData[objectName];

        let resolvedMode = renderer.colorMode || 'auto';  // Global default
        let resolvedLiteralColor = null;

        // === Level 1: Object-level color ===
        if (object && object.color) {
            const objColor = object.color;
            if (objColor.type === 'mode') {
                resolvedMode = objColor.value;
            } else if (objColor.type === 'literal') {
                resolvedLiteralColor = objColor.value;
            } else if (objColor.type === 'advanced') {
                // Advanced dict at object level
                const adv = objColor.value;

                // Check object-level key first
                if (adv.object) {
                    const objLevelColor = adv.object;
                    if (typeof objLevelColor === 'string' && VALID_COLOR_MODES.includes(objLevelColor.toLowerCase())) {
                        resolvedMode = objLevelColor.toLowerCase();
                    } else {
                        resolvedLiteralColor = objLevelColor;
                    }
                }

                // Check chain-level at object scope
                if (adv.chain && chainId && adv.chain[chainId]) {
                    const chainColor = adv.chain[chainId];
                    if (typeof chainColor === 'string' && VALID_COLOR_MODES.includes(chainColor.toLowerCase())) {
                        resolvedMode = chainColor.toLowerCase();
                        resolvedLiteralColor = null;
                    } else {
                        resolvedLiteralColor = chainColor;
                    }
                }

                // Check position-level at object scope (highest priority)
                if (adv.position && adv.position[posIndex] !== undefined) {
                    const posColor = adv.position[posIndex];
                    if (typeof posColor === 'string' && VALID_COLOR_MODES.includes(posColor.toLowerCase())) {
                        resolvedMode = posColor.toLowerCase();
                        resolvedLiteralColor = null;
                    } else {
                        resolvedLiteralColor = posColor;
                    }
                }
            }
        }

        // === Level 2: Frame-level color ===
        if (frameIndex >= 0 && object && object.frames && object.frames[frameIndex]) {
            const frameData = object.frames[frameIndex];
            if (frameData.color) {
                const frameColor = frameData.color;
                if (frameColor.type === 'mode') {
                    resolvedMode = frameColor.value;
                    resolvedLiteralColor = null;  // Reset literal when switching to mode
                } else if (frameColor.type === 'literal') {
                    resolvedLiteralColor = frameColor.value;
                    // Keep resolvedMode for fallback, but literal takes priority
                } else if (frameColor.type === 'advanced') {
                    const adv = frameColor.value;
                    // Check frame-level key first
                    if (adv.frame) {
                        const frameLevelColor = adv.frame;
                        if (typeof frameLevelColor === 'string' && VALID_COLOR_MODES.includes(frameLevelColor.toLowerCase())) {
                            resolvedMode = frameLevelColor.toLowerCase();
                            resolvedLiteralColor = null;
                        } else {
                            resolvedLiteralColor = frameLevelColor;
                        }
                    }

                    // === Level 3: Chain-level color ===
                    if (adv.chain && chainId && adv.chain[chainId]) {
                        const chainColor = adv.chain[chainId];
                        if (typeof chainColor === 'string' && VALID_COLOR_MODES.includes(chainColor.toLowerCase())) {
                            resolvedMode = chainColor.toLowerCase();
                            resolvedLiteralColor = null;
                        } else {
                            resolvedLiteralColor = chainColor;
                        }
                    }

                    // === Level 4: Position-level color (highest priority) ===
                    if (adv.position && adv.position[posIndex] !== undefined) {
                        const posColor = adv.position[posIndex];
                        if (typeof posColor === 'string' && VALID_COLOR_MODES.includes(posColor.toLowerCase())) {
                            resolvedMode = posColor.toLowerCase();
                            resolvedLiteralColor = null;
                        } else {
                            resolvedLiteralColor = posColor;
                        }
                    }
                }
            }
        }

        return {
            resolvedMode: resolvedMode,
            resolvedLiteralColor: resolvedLiteralColor
        };
    }

    // ============================================================================
    // RENDERING CONSTANTS
    // ============================================================================

    // Valid color modes for protein coloring
    const VALID_COLOR_MODES = ['chain', 'plddt', 'rainbow', 'auto', 'entropy', 'deepmind'];

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

    // Default nested config used by both Python and standalone HTML
    const DEFAULT_CONFIG = {
        viewer_id: null,
        display: {
            size: [300, 300],
            rotate: false,
            autoplay: false,
            controls: true,
            box: true
        },
        rendering: {
            shadow: true,
            shadow_strength: 0.5,
            outline: "full",
            width: 3.0,
            ortho: 1.0,
            detect_cyclic: true
        },
        color: {
            mode: "auto",
            colorblind: false
        },
        pae: {
            enabled: false,
            size: 300
        },
        scatter: {
            enabled: false,
            size: 300
        },
        overlay: {
            enabled: false
        }
    };

    // Normalize legacy flat configs into the nested structure expected by the renderer
    function normalizeConfig(rawConfig = {}) {
        const cfg = rawConfig || {};

        // Support legacy flat color config: { color: "auto", colorblind: false }
        const colorMode = typeof cfg.color === 'string' ? cfg.color : cfg.color?.mode;

        const normalized = {
            viewer_id: cfg.viewer_id ?? DEFAULT_CONFIG.viewer_id,
            display: {
                size: cfg.display?.size || cfg.size || DEFAULT_CONFIG.display.size,
                rotate: cfg.display?.rotate ?? cfg.rotate ?? DEFAULT_CONFIG.display.rotate,
                autoplay: cfg.display?.autoplay ?? cfg.autoplay ?? DEFAULT_CONFIG.display.autoplay,
                controls: cfg.display?.controls ?? cfg.controls ?? DEFAULT_CONFIG.display.controls,
                box: cfg.display?.box ?? cfg.box ?? DEFAULT_CONFIG.display.box
            },
            rendering: {
                shadow: cfg.rendering?.shadow ?? cfg.shadow ?? DEFAULT_CONFIG.rendering.shadow,
                shadow_strength: cfg.rendering?.shadow_strength ?? cfg.shadow_strength ?? DEFAULT_CONFIG.rendering.shadow_strength,
                outline: cfg.rendering?.outline ?? cfg.outline ?? DEFAULT_CONFIG.rendering.outline,
                width: cfg.rendering?.width ?? cfg.width ?? DEFAULT_CONFIG.rendering.width,
                ortho: cfg.rendering?.ortho ?? cfg.ortho ?? DEFAULT_CONFIG.rendering.ortho,
                detect_cyclic: cfg.rendering?.detect_cyclic ?? cfg.detect_cyclic ?? DEFAULT_CONFIG.rendering.detect_cyclic
            },
            color: {
                mode: colorMode || DEFAULT_CONFIG.color.mode,
                colorblind: cfg.color?.colorblind ?? cfg.colorblind ?? DEFAULT_CONFIG.color.colorblind
            },
            pae: {
                enabled: cfg.pae?.enabled ?? cfg.pae ?? DEFAULT_CONFIG.pae.enabled,
                size: cfg.pae?.size || cfg.pae_size || DEFAULT_CONFIG.pae.size
            },
            scatter: {
                enabled: cfg.scatter?.enabled ?? cfg.scatter ?? DEFAULT_CONFIG.scatter.enabled,
                size: cfg.scatter?.size || cfg.scatter_size || DEFAULT_CONFIG.scatter.size
            },
            overlay: {
                enabled: cfg.overlay?.enabled ?? cfg.overlay ?? DEFAULT_CONFIG.overlay.enabled
            }
        };

        // Carry over any additional top-level keys not explicitly normalized
        const knownKeys = new Set(["viewer_id", "display", "rendering", "color", "pae", "scatter", "overlay", "size", "rotate", "autoplay", "controls", "box", "shadow", "outline", "width", "ortho", "colorblind", "pae_size", "scatter_size", "detect_cyclic"]);
        for (const [key, value] of Object.entries(cfg)) {
            if (!knownKeys.has(key)) {
                normalized[key] = value;
            }
        }

        // Preserve legacy pae_size if present as an alias
        if (cfg.pae_size && !cfg.pae?.size) {
            normalized.pae.size = cfg.pae_size;
        }

        return normalized;
    }

    // ============================================================================
    // PSEUDO-3D RENDERER
    // ============================================================================
    class Pseudo3DRenderer {
        constructor(canvas, viewerConfig) {
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

            // Store viewer-specific config on instance for reliable access in methods
            // Use provided config or fallback to window.viewerConfig
            const config = viewerConfig || normalizeConfig(window.viewerConfig);
            this.config = config;

            // Update global viewerConfig for backward compatibility
            window.viewerConfig = config;

            // Current render state
            this.coords = []; // This is now an array of Vec3 objects
            this.plddts = [];
            this.chains = [];
            this.positionTypes = [];
            this.entropy = undefined; // Entropy vector mapped to structure positions

            // Viewer state - Color mode: auto, chain, rainbow, plddt, DeepMind, entropy, or custom
            const validModes = getAllValidColorModes();
            this.colorMode = (config.color?.mode && validModes.includes(config.color.mode)) ? config.color.mode : 'auto';
            // Ensure it's always valid
            if (!this.colorMode || !validModes.includes(this.colorMode)) {
                this.colorMode = 'auto';
            }

            // What 'auto' resolves to (calculated when data loads)
            this.resolvedAutoColor = 'rainbow';

            // Unified viewer state (rotation, zoom, perspective, center/extent, frame)
            this.viewerState = {
                rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                zoom: 1.0,
                perspectiveEnabled: false,
                focalLength: 200.0,
                center: null,
                extent: null,
                currentFrame: -1
            };

            this.lineWidth = (typeof config.rendering?.width === 'number') ? config.rendering.width : 3.0;
            this.relativeOutlineWidth = 3.0; // Default outline width relative to line width
            this.shadowIntensity = 0.95;

            // Set defaults from config, with fallback
            this.shadowEnabled = (typeof config.rendering?.shadow === 'boolean') ? config.rendering.shadow : true;
            this.shadowStrength = (typeof config.rendering?.shadow_strength === 'number') ? config.rendering.shadow_strength : 0.5;
            // Outline mode: 'none', 'partial', or 'full'
            if (typeof config.rendering?.outline === 'string' && ['none', 'partial', 'full'].includes(config.rendering.outline)) {
                this.outlineMode = config.rendering.outline;
            } else if (typeof config.rendering?.outline === 'boolean') {
                // Backward compatibility: true -> 'full', false -> 'none'
                this.outlineMode = config.rendering.outline ? 'full' : 'none';
            } else {
                this.outlineMode = 'full'; // Default to full
            }
            this.colorblindMode = (typeof config.color?.colorblind === 'boolean') ? config.color.colorblind : false;

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
            this.animationFrameId = null; // Track active requestAnimationFrame loop to avoid duplicates

            // Cache segment indices per frame (bonds don't change within a frame)
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesFrame = -1;
            this.cachedSegmentIndicesObjectName = null;

            // Playback
            this.isPlaying = false;
            this.animationSpeed = 100; // ms per frame
            this.speedOptions = [100, 50, 25]; // ms per frame: 1x, 2x, 4x
            this.speedIndex = this.speedOptions.indexOf(this.animationSpeed);
            if (this.speedIndex === -1) {
                this.speedIndex = 0;
                this.animationSpeed = this.speedOptions[this.speedIndex];
            }
            this.frameAdvanceTimer = null; // Independent timer for frame advancement
            this.lastRenderedFrame = -1; // Track what frame was last rendered
            this.recordingFrameSequence = null; // Timeout ID for sequential recording

            // Overlay mode (for merging multiple frames in same view)
            // UNIFIED overlay state object (Commit 1 refactor)
            this.overlayState = {
                enabled: false,              // Is overlay mode currently active?
                shouldAutoEnable: (typeof config.overlay?.enabled === 'boolean') ? config.overlay.enabled : false,
                frameIdMap: null,            // Maps atom index → frame index (null if not merged)
                autoColor: null              // Auto color determination (rainbow/chain/plddt)
            };

            // Debug properties
            this.lastOperationMode = 'unknown'; // Track mode: 'single-frame', 'merged', 'overlay-toggle', etc.

            // Interaction state
            this.isDragging = false; // Used for selection preview
            this.autoRotate = (typeof config.display?.rotate === 'boolean') ? config.display.rotate : false;
            this.autoplay = (typeof config.display?.autoplay === 'boolean') ? config.display.autoplay : false;

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

            // Ligand groups: Now stored per-object in objectsData[name].ligandGroups
            // (removed from renderer-level to fix bug where loading object B overwrites object A's groups)

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
            this.speedButton = null;
            this.rotationCheckbox = null;
            this.lineWidthSlider = null;
            this.outlineWidthSlider = null;
            this.shadowEnabledCheckbox = null;
            this.outlineModeButton = null; // Button that cycles through outline modes (index.html)
            this.outlineModeSelect = null; // Dropdown for outline modes (viewer.html)
            this.colorblindCheckbox = null;
            this.orthoSlider = null;
            this.shadowSlider = null;

            // Recording state
            this.isRecording = false;
            this.mediaRecorder = null;
            this.recordedChunks = [];
            this.recordingStream = null;
            this.recordingEndFrame = 0;

            // Cache shadow/tint arrays during dragging for performance
            this._invalidateShadowCache();
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

                // In overlay mode, selections are based on frame[0] indices but need to be expanded
                // to include corresponding positions from all frames in the merged array
                if (this.overlayState.enabled && this.overlayState.frameIdMap && this.selectionModel.positions.size > 0) {
                    // Build frame offset map: frameIdx -> starting index in merged array
                    const frameOffsets = new Map();
                    const frameSizes = new Map();
                    let currentFrame = -1;
                    let frameStart = 0;

                    for (let i = 0; i < this.overlayState.frameIdMap.length; i++) {
                        const frameIdx = this.overlayState.frameIdMap[i];
                        if (frameIdx !== currentFrame) {
                            if (currentFrame >= 0) {
                                frameSizes.set(currentFrame, i - frameStart);
                            }
                            frameOffsets.set(frameIdx, i);
                            frameStart = i;
                            currentFrame = frameIdx;
                        }
                    }
                    if (currentFrame >= 0) {
                        frameSizes.set(currentFrame, this.overlayState.frameIdMap.length - frameStart);
                    }

                    // Expand selections: for each selected position (based on frame 0),
                    // find corresponding positions in all frames
                    const frame0Size = frameSizes.get(0) || 0;
                    for (const selectedPos of this.selectionModel.positions) {
                        // Only process positions that exist in frame 0
                        if (selectedPos >= frame0Size) continue;

                        // Add this position from all frames
                        for (const [frameIdx, offset] of frameOffsets.entries()) {
                            const frameSize = frameSizes.get(frameIdx) || 0;
                            // Only add if this position exists in this frame
                            if (selectedPos < frameSize) {
                                const mergedIdx = offset + selectedPos;
                                const ch = this.chains[mergedIdx];
                                if (allowedChains.has(ch)) {
                                    seqPositions.add(mergedIdx);
                                }
                            }
                        }
                    }
                } else {
                    // Normal mode or overlay with no position selection
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

                // In overlay mode, PAE selections should expand across all frames
                // (same logic as sequence selections)
                if (this.overlayState.enabled && this.overlayState.frameIdMap) {
                    // Build frame offset map
                    const frameOffsets = new Map();
                    const frameSizes = new Map();
                    let currentFrame = -1;
                    let frameStart = 0;

                    for (let i = 0; i < this.overlayState.frameIdMap.length; i++) {
                        const frameIdx = this.overlayState.frameIdMap[i];
                        if (frameIdx !== currentFrame) {
                            if (currentFrame >= 0) {
                                frameSizes.set(currentFrame, i - frameStart);
                            }
                            frameOffsets.set(frameIdx, i);
                            frameStart = i;
                            currentFrame = frameIdx;
                        }
                    }
                    if (currentFrame >= 0) {
                        frameSizes.set(currentFrame, this.overlayState.frameIdMap.length - frameStart);
                    }

                    const frame0Size = frameSizes.get(0) || 0;
                    for (const box of this.selectionModel.paeBoxes) {
                        const i0 = Math.max(0, Math.min(frame0Size - 1, Math.min(box.i_start, box.i_end)));
                        const i1 = Math.max(0, Math.min(frame0Size - 1, Math.max(box.i_start, box.i_end)));
                        const j0 = Math.max(0, Math.min(frame0Size - 1, Math.min(box.j_start, box.j_end)));
                        const j1 = Math.max(0, Math.min(frame0Size - 1, Math.max(box.j_start, box.j_end)));

                        // Expand i and j ranges across all frames
                        for (let r = i0; r <= i1; r++) {
                            for (const [frameIdx, offset] of frameOffsets.entries()) {
                                const frameSize = frameSizes.get(frameIdx) || 0;
                                if (r < frameSize) {
                                    paePositions.add(offset + r);
                                }
                            }
                        }
                        for (let r = j0; r <= j1; r++) {
                            for (const [frameIdx, offset] of frameOffsets.entries()) {
                                const frameSize = frameSizes.get(frameIdx) || 0;
                                if (r < frameSize) {
                                    paePositions.add(offset + r);
                                }
                            }
                        }
                    }
                } else {
                    // Normal mode
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
                this._invalidateShadowCache();
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

        setScatterRenderer(scatterRenderer) {
            this.scatterRenderer = scatterRenderer;
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
                            this.viewerState.rotation = multiplyMatrices(rot, this.viewerState.rotation);
                        }
                        if (dx !== 0) {
                            const rot = rotationMatrixY(dx * 0.01);
                            this.viewerState.rotation = multiplyMatrices(rot, this.viewerState.rotation);
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
                this._invalidateShadowCache();
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
                this.ensureAnimationLoop();

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
                this.viewerState.zoom *= (1 - e.deltaY * 0.001);
                this.viewerState.zoom = Math.max(0.1, Math.min(5, this.viewerState.zoom));
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

                    if (dy !== 0) { const rot = rotationMatrixX(dy * 0.01); this.viewerState.rotation = multiplyMatrices(rot, this.viewerState.rotation); }
                    if (dx !== 0) { const rot = rotationMatrixY(dx * 0.01); this.viewerState.rotation = multiplyMatrices(rot, this.viewerState.rotation); }

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

                    this.viewerState.zoom *= scale;
                    this.viewerState.zoom = Math.max(0.1, Math.min(5, this.viewerState.zoom));
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
                    this._invalidateShadowCache();
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
                    this.ensureAnimationLoop();

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
                        this._invalidateShadowCache();
                        this.lastShadowRotationMatrix = null; // Force recalculation
                    }

                    // Restart animation loop if it was stopped
                    this.ensureAnimationLoop();
                }
            });

            this.canvas.addEventListener('touchcancel', (e) => {
                // Handle touch cancellation (e.g., system gesture interference)
                if (this.isDragging) {
                    this.isDragging = false;

                    // Clear shadow cache when dragging ends (shadows need recalculation)
                    this._invalidateShadowCache();
                    this.lastShadowRotationMatrix = null; // Force recalculation

                    // Restart animation loop
                    this.ensureAnimationLoop();
                }
                this.initialPinchDistance = 0;
            });
        }

        getTouchDistance(touch1, touch2) {
            const dx = touch1.clientX - touch2.clientX;
            const dy = touch1.clientY - touch2.clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        _updateSpeedButtonLabel() {
            if (!this.speedButton) return;
            const label = `${Math.round(100 / this.animationSpeed)}x`;
            this.speedButton.textContent = label;
        }

        _cycleSpeed() {
            const wasPlaying = this.isPlaying;
            this.speedIndex = (this.speedIndex + 1) % this.speedOptions.length;
            this.animationSpeed = this.speedOptions[this.speedIndex];
            this._updateSpeedButtonLabel();
            if (wasPlaying) {
                this.stopAnimation();
                this.startAnimation();
            }
        }

        // Set UI controls from main script
        setUIControls(controlsContainer, playButton, overlayButton, recordButton, saveSvgButton, frameSlider, frameCounter, objectSelect, speedButton, rotationCheckbox, lineWidthSlider, outlineWidthSlider, shadowEnabledCheckbox, outlineModeButton, outlineModeSelect, colorblindCheckbox, orthoSlider, shadowSlider) {
            this.controlsContainer = controlsContainer;
            this.playButton = playButton;
            this.overlayButton = overlayButton;
            this.recordButton = recordButton;
            this.saveSvgButton = saveSvgButton;
            this.frameSlider = frameSlider;
            this.frameCounter = frameCounter;
            this.objectSelect = objectSelect;
            this.speedButton = speedButton;
            this.rotationCheckbox = rotationCheckbox;
            this.lineWidthSlider = lineWidthSlider;
            this.outlineWidthSlider = outlineWidthSlider;
            this.shadowEnabledCheckbox = shadowEnabledCheckbox;
            this.outlineModeButton = outlineModeButton;
            this.outlineModeSelect = outlineModeSelect;
            this.colorblindCheckbox = colorblindCheckbox;
            this.orthoSlider = orthoSlider;
            this.shadowSlider = shadowSlider;
            this.lineWidth = this.lineWidthSlider ? parseFloat(this.lineWidthSlider.value) : (this.lineWidth || 3.0); // Read default from slider or use existing/default
            this.relativeOutlineWidth = this.outlineWidthSlider ? parseFloat(this.outlineWidthSlider.value) : (this.relativeOutlineWidth || 3.0); // Read default from slider or use existing/default
            this.autoRotate = this.rotationCheckbox ? this.rotationCheckbox.checked : false; // Read default from checkbox
            this.shadowStrength = this.shadowSlider ? parseFloat(this.shadowSlider.value) : 0.5; // Read default from slider or use 0.5

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
                    // PAE visibility updated by setFrame -> updateFrame
                    this.updateScatterContainerVisibility();
                });
            }

            if (this.speedButton) {
                this._updateSpeedButtonLabel();
                this.speedButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._cycleSpeed();
                });
            }

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
                        this.viewerState.perspectiveEnabled = false;
                        this.viewerState.focalLength = baseSize * PERSPECTIVE_MAX_MULT;
                    } else {
                        // Perspective mode: interpolate focal length based on slider value
                        const multiplier = PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * normalizedValue;
                        this.viewerState.perspectiveEnabled = true;
                        this.viewerState.focalLength = baseSize * multiplier;
                    }

                    if (!this.isPlaying) {
                        this.render('orthoSlider');
                    }
                });
            }

            if (this.shadowSlider) {
                this.shadowSlider.addEventListener('input', (e) => {
                    this.shadowStrength = parseFloat(e.target.value);
                    // Invalidate shadow cache to force recalculation with new strength
                    this._invalidateShadowCache();
                    if (!this.isPlaying) {
                        this.render('shadowSlider');
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
            const allControls = [this.playButton, this.objectSelect, this.speedButton,
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

        // Helper to set data field with inheritance from cache
        _setDataField(fieldName, cacheFieldName, value, n, defaultFn) {
            if (value && value.length === n) {
                this[fieldName] = value;
                this[cacheFieldName] = value;
            } else if (value === null) {
                // Explicit null: use defaults, don't cache
                this[fieldName] = defaultFn(n);
            } else if (this[cacheFieldName] && this[cacheFieldName].length === n) {
                this[fieldName] = this[cacheFieldName];
            } else {
                this[fieldName] = defaultFn(n);
            }
        }

        // Helper method to invalidate segment cache
        _invalidateSegmentCache() {
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesFrame = -1;
            this.cachedSegmentIndicesObjectName = null;
        }

        // Helper to invalidate shadow and tint cache
        _invalidateShadowCache() {
            this.cachedShadows = null;
            this.cachedTints = null;
        }

        // Switch to a different object (handles save/restore of selection state)
        _switchToObject(newObjectName) {
            // Save current object's selection state and viewer state
            if (this.currentObjectName && this.currentObjectName !== newObjectName && this.objectsData[this.currentObjectName]) {
                const obj = this.objectsData[this.currentObjectName];
                obj.selectionState = {
                    positions: new Set(this.selectionModel.positions),
                    chains: new Set(this.selectionModel.chains),
                    paeBoxes: this.selectionModel.paeBoxes.map(box => ({ ...box })),
                    selectionMode: this.selectionModel.selectionMode
                };
                obj.viewerState = {
                    rotation: this._deepCopyMatrix(this.viewerState.rotation),
                    zoom: this.viewerState.zoom,
                    perspectiveEnabled: this.viewerState.perspectiveEnabled,
                    focalLength: this.viewerState.focalLength,
                    center: this.viewerState.center ? { ...this.viewerState.center } : null,
                    extent: this.viewerState.extent,
                    currentFrame: this.currentFrame
                };

                // Persist scatter metadata (labels/limits) from renderer before switching away
                if (this.scatterRenderer && this.objectHasScatter(this.currentObjectName)) {
                    const meta = obj.scatterConfig || {};
                    meta.xlabel = this.scatterRenderer.xLabel || meta.xlabel || 'X';
                    meta.ylabel = this.scatterRenderer.yLabel || meta.ylabel || 'Y';
                    meta.xlim = [this.scatterRenderer.xMin, this.scatterRenderer.xMax];
                    meta.ylim = [this.scatterRenderer.yMin, this.scatterRenderer.yMax];
                    obj.scatterConfig = meta;
                }
            }

            // Switch to new object
            this.currentObjectName = newObjectName;

            // Get new object reference
            let newObject = this.objectsData[newObjectName];

            // Exit overlay mode if switching to single-frame object
            if (this.overlayState.enabled && newObject && newObject.frames) {
                if (newObject.frames.length <= 1) {
                    // Exit overlay mode for single-frame objects
                    this._exitOverlayMode(newObject, 0);
                }
            }

            // Invalidate segment cache to ensure contacts and other object-specific data are regenerated
            this._invalidateSegmentCache();

            // Invalidate shadow cache since shadows depend on object geometry, not just rotation
            // Different objects have different geometries, so shadows must be recalculated
            this._invalidateShadowCache();
            this.lastShadowRotationMatrix = null;

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
            newObject = this.objectsData[newObjectName];
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
            if (this.objectsData[newObjectName]?.msa?.msasBySequence && this.objectsData[newObjectName]?.msa?.chainToSequence && window.MSA) {
                this.entropy = window.MSA.mapEntropyToStructure(this.objectsData[newObjectName], this.currentFrame >= 0 ? this.currentFrame : 0);
                this._updateEntropyOptionVisibility();
            } else if (this.colorMode === 'entropy') {
                // If entropy mode is active but no MSA, try to map it anyway
                const objectName = this.currentObjectName;
                if (objectName && this.objectsData[objectName] && window.MSA) {
                    this.entropy = window.MSA.mapEntropyToStructure(this.objectsData[objectName], this.currentFrame >= 0 ? this.currentFrame : 0);
                    this._updateEntropyOptionVisibility();
                } else {
                    this.entropy = undefined;
                }
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

            // Restore viewer state from new object (fallback to defaults if missing)
            const obj = this.objectsData[newObjectName];
            const saved = obj.viewerState || {
                rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                zoom: 1.0,
                perspectiveEnabled: false,
                focalLength: 200.0,
                center: null,
                extent: null,
                currentFrame: -1
            };
            this.viewerState = {
                rotation: this._deepCopyMatrix(saved.rotation),
                zoom: saved.zoom,
                perspectiveEnabled: saved.perspectiveEnabled,
                focalLength: saved.focalLength,
                center: saved.center ? { ...saved.center } : null,
                extent: saved.extent,
                currentFrame: saved.currentFrame
            };

            // Restore currentFrame from viewerState
            this.currentFrame = this.viewerState.currentFrame;

            // Restore scatter plot for the new object using its stored data/metadata
            if (this.scatterRenderer) {
                this.updateScatterData(newObjectName);
                this.scatterRenderer.currentFrameIndex = this.currentFrame;
                this.scatterRenderer.render();
                // Update visibility to hide scatter container if new object has no scatter data
                this.updateScatterContainerVisibility();
            }

            // Rebuild sequence viewer for the new object to prevent stale data
            if (typeof window !== 'undefined' && window.SEQ && window.SEQ.buildView) {
                // Clear sequence viewer cache to force rebuild
                if (window.SEQ.clear) {
                    window.SEQ.clear();
                }
                // Rebuild sequence view for the new object
                window.SEQ.buildView();
            }

            // Note: _composeAndApplyMask will be called by setFrame after the frame data is loaded
        }

        // Add a new object
        addObject(name) {
            const objectExists = this.objectsData[name] !== undefined;
            const existingScatterConfig = objectExists
                ? (this.objectsData[name].scatterConfig || null)
                : null;

            this.stopAnimation();

            // If object with same name already exists, only clear if it has no frames
            // (preserves loaded frames during data refresh)
            if (objectExists) {
                const hasFrames = this.objectsData[name].frames && this.objectsData[name].frames.length > 0;

                if (hasFrames) {
                    // Object already has frames (from data load), don't clear it
                    return;
                } else {
                    // Object exists but is empty, preserve scatter config if it exists
                    const preservedScatterConfig = existingScatterConfig;

                    this.objectsData[name].frames = [];
                    this.objectsData[name].maxExtent = 0;
                    this.objectsData[name].stdDev = 0;
                    this.objectsData[name].globalCenterSum = new Vec3(0, 0, 0);
                    this.objectsData[name].totalPositions = 0;
                    this.objectsData[name]._lastPlddtFrame = -1;
                    this.objectsData[name]._lastPaeFrame = -1;
                    // Don't clear selectionState - preserve it
                    // Don't clear scatterConfig - preserve it
                    if (preservedScatterConfig) {
                        this.objectsData[name].scatterConfig = preservedScatterConfig;
                    }
                }
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
                    ligandGroups: new Map(),  // Per-object ligand groups
                    selectionState: {
                        positions: new Set(),
                        chains: new Set(),
                        paeBoxes: [],
                        selectionMode: 'default'
                    },
                    viewerState: {
                        rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                        zoom: 1.0,
                        perspectiveEnabled: false,
                        focalLength: 200.0,
                        center: null,
                        extent: null,
                        currentFrame: -1
                    },
                    // Initialize scatterConfig with neutral defaults; labels/limits can be set per object
                    scatterConfig: {
                        xlabel: 'X',
                        ylabel: 'Y',
                        xlim: null,
                        ylim: null
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
            this._invalidateSegmentCache();

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
                console.error(`addFrame: Object '${targetObjectName}' does not exist. Creating it.`);
                this.addObject(targetObjectName);
            }

            const object = this.objectsData[targetObjectName];
            const newFrameIndex = object.frames.length; // Index of frame we're about to add

            // Add frame to object
            this.objectsData[targetObjectName].frames.push(data);

            // Compute ligandGroups NOW, before any UI updates
            if (typeof groupLigandAtoms === 'function' && data.chains && data.position_types) {
                this.objectsData[targetObjectName].ligandGroups = groupLigandAtoms(
                    data.chains,
                    data.position_types,
                    data.residue_numbers || [],
                    data.position_names || []
                );
            }

            // If this was the active object and it was on last frame, stay on last frame.
            // Store contacts if provided in data (object-level)
            if (data.contacts !== undefined && data.contacts !== null) {
                object.contacts = data.contacts;
            }

            // Store explicit bonds if provided in data (object-level)
            if (data.bonds !== undefined && data.bonds !== null) {
                object.bonds = data.bonds;
            }

            // Store frame-level color if provided in data
            // Color is handled entirely through the hierarchy resolver in getAtomColor
            if (data.color !== undefined && data.color !== null) {
                this._invalidateSegmentCache();
            }

            // Update object-level tracking (for optimization during resolution)
            if (this._hasPlddtData(data)) {
                object._lastPlddtFrame = newFrameIndex;
            } else if (newFrameIndex === 0) {
                object._lastPlddtFrame = -1; // No plddt in first frame
            }

            if (window.PAE && window.PAE.isValid(data.pae)) {
                object._lastPaeFrame = newFrameIndex;
            } else if (newFrameIndex === 0) {
                object._lastPaeFrame = -1; // No PAE in first frame
            }

            // Update scatter renderer if new frame has scatter data
            if (this.scatterRenderer && data.scatter && Array.isArray(data.scatter) && data.scatter.length === 2) {
                try {
                    this.scatterRenderer.addPoint(data.scatter[0], data.scatter[1]);
                } catch (e) {
                    console.error("Error adding scatter point:", e);
                }
            }

            // If this is the first frame and overlay should be auto-enabled, enable it now
            // Commit 6: Use _enterOverlayMode instead of toggleOverlay for atomic state management
            let justAutoEnabledOverlay = false;
            if (this.overlayState.shouldAutoEnable && object.frames.length === 1 && !this.overlayState.enabled) {
                // Use atomic entry to overlay mode
                this._enterOverlayMode(object, false);
                this.overlayState.shouldAutoEnable = false;  // Only auto-enable once
                justAutoEnabledOverlay = true;  // Flag to skip re-merge on this frame
            }

            // Set view to this object
            if (this.currentObjectName !== targetObjectName) {
                this.stopAnimation(); // Stop if playing on another obj
                this.currentObjectName = targetObjectName;
                this.lastRenderedFrame = -1; // Reset frame tracking on object change
                if (this.objectSelect) {
                    this.objectSelect.value = targetObjectName;
                }
            }

            // If color was provided and we're not in batch mode, render immediately to apply new colors
            if (data.color !== undefined && data.color !== null && !this._batchLoading) {
                this.render('addFrame-color');
            }

            // Recompute global center and extent across all frames (handles overlay/non-overlay)
            let globalCenter = new Vec3(0, 0, 0);
            let totalCount = 0;
            for (const frame of object.frames) {
                if (frame && frame.coords) {
                    for (let i = 0; i < frame.coords.length; i++) {
                        const c = frame.coords[i];
                        globalCenter = globalCenter.add(new Vec3(c[0], c[1], c[2]));
                        totalCount++;
                    }
                }
            }
            if (totalCount > 0) {
                globalCenter = globalCenter.mul(1 / totalCount);
            }

            // Recalculate maxExtent and standard deviation using the global center
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
            object.center = [globalCenter.x, globalCenter.y, globalCenter.z];
            this.viewerState.center = { x: globalCenter.x, y: globalCenter.y, z: globalCenter.z };
            object.totalPositions = totalCount;
            object.globalCenterSum = new Vec3(globalCenter.x * totalCount, globalCenter.y * totalCount, globalCenter.z * totalCount);

            // If this is the first frame being loaded, we need to
            // Recalculate focal length if perspective is enabled and object size changed
            // Skip during batch loading to avoid unnecessary renders
            if (object.frames.length === 1 && this.viewerState.perspectiveEnabled && this.orthoSlider && !this._batchLoading) {
                this.orthoSlider.dispatchEvent(new Event('input'));
            }

            // If in overlay mode, re-merge to include the new frame
            // Skip re-merge if we just auto-enabled overlay on this frame (toggleOverlay already did it)
            if (this.overlayState.enabled && !this._batchLoading && !justAutoEnabledOverlay) {
                // Re-merge all frames when new frame added in overlay mode (Commit 2)
                const merged = this._mergeFrameRange(object, 0, object.frames.length - 1);

                if (merged) {
                    // Store overlay-specific data from merge result
                    this.overlayState.frameIdMap = merged.frameIdMap;
                    this.overlayState.autoColor = merged.autoColor;

                    this._invalidateSegmentCache();

                    // Load re-merged data
                    this._loadDataIntoRenderer(merged, false);
                }
            }

            // Skip setFrame during batch loading to avoid expensive renders
            // We'll render once at the end in updateViewerFromGlobalBatch
            // In overlay mode, DON'T call setFrame - it would load individual frame data instead of merged
            if (!this.isPlaying && !this._batchLoading) {
                if (!this.overlayState.enabled) {
                    // Non-overlay: load the new frame normally
                    this.setFrame(object.frames.length - 1);
                } else {
                    // Overlay mode: just set currentFrame without loading individual frame data
                    this.currentFrame = 0;
                    this.render('addFrame-overlay');
                }
            } else if (!this.isPlaying) {
                // During batch loading, just update the frame index without rendering
                if (!this.overlayState.enabled) {
                    this.currentFrame = object.frames.length - 1;
                } else {
                    // Overlay mode: keep frame 0 which has merged data
                    this.currentFrame = 0;
                }
                this.lastRenderedFrame = -1; // Mark as needing render
            }

            // UI updates moved to handleIncrementalStateUpdate for performance

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
                const resolvedPae = window.PAE ? window.PAE.resolveData(object, frameIndex) : null;

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
                // PAE can be Uint8Array (flattened, scaled x8) or 2D array (legacy)
                if (sourcePae) {
                    const isUint8 = sourcePae instanceof Uint8Array;
                    const is2DArray = Array.isArray(sourcePae) && sourcePae.length > 0 && Array.isArray(sourcePae[0]);
                    const isFlatArray = Array.isArray(sourcePae) && sourcePae.length > 0 && !Array.isArray(sourcePae[0]);

                    if (isUint8 || isFlatArray) {
                        // Uint8Array or flat array format: flattened N x N matrix
                        // Calculate N from the original PAE size
                        const originalN = Math.round(Math.sqrt(sourcePae.length));
                        const newN = selectedIndices.length;

                        // Create new flattened PAE array for extracted selection
                        const newPAE = new Uint8Array(newN * newN);

                        for (let i = 0; i < newN; i++) {
                            for (let j = 0; j < newN; j++) {
                                const originalI = selectedIndices[i];
                                const originalJ = selectedIndices[j];

                                // Bounds check
                                if (originalI < originalN && originalJ < originalN) {
                                    const originalIdx = originalI * originalN + originalJ;
                                    newPAE[i * newN + j] = sourcePae[originalIdx];
                                } else {
                                    newPAE[i * newN + j] = 0; // Default value
                                }
                            }
                        }

                        extractedFrame.pae = newPAE;
                    } else if (is2DArray) {
                        // Legacy 2D array format
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
                    if (window.MSA && typeof window.MSA.extractSubset === 'function') {
                        // Extract MSA data for the selected positions using the new module
                        window.MSA.extractSubset(object, extractedObject, firstFrame, selectedIndices);
                    }
                }
            }

            // Switch to the extracted object (synchronously)
            // This properly sets currentObjectName, exits overlay mode if needed, and invalidates caches
            this._switchToObject(extractName);

            // Load the first frame to populate coords and render the molecule
            this.setFrame(0);

            // CRITICAL: Update PAE renderer with the new object's PAE data
            // The PAE renderer stores its own copy of paeData, so we must call setData()
            // with the extracted object's PAE before calling render()
            const extractedObj = this.objectsData[extractName];
            if (window.PAE && extractedObj) {
                window.PAE.updateFrame(this, extractedObj, 0);
            }
            if (this.paeRenderer && this.paeRenderer.render) {
                this.paeRenderer.render();
            }

            // Update scatter visibility and data for extracted object
            this.updateScatterContainerVisibility();

            // Update object dropdown to reflect the change
            if (this.objectSelect) {
                this.objectSelect.value = extractName;
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

            // Force sequence viewer to rebuild for the new object
            if (typeof window !== 'undefined' && window.SEQ && window.SEQ.buildView) {
                // Clear sequence viewer cache to force rebuild
                if (window.SEQ.clear) {
                    window.SEQ.clear();
                }
                // Rebuild sequence view for the new extracted object
                window.SEQ.buildView();
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
                this.viewerState.currentFrame = -1;
                this.coords = [];
                clearCanvas();
                if (this.paeRenderer) { this.paeRenderer.setData(null); }
                this.updateUIControls();
                this.setUIEnabled(true); // Enable, even if frame is invalid (so user can change obj)
                return;
            }

            this.currentFrame = frameIndex;
            this.viewerState.currentFrame = frameIndex;

            // Invalidate shadow cache when frame changes (different geometry needs new shadows)
            this._invalidateShadowCache();
            this.lastShadowRotationMatrix = null;

            // Commit 4: Make setFrame overlay-aware
            // In overlay mode, DON'T reload frame data (would destroy merged data)
            // Just update display and render
            if (this.overlayState.enabled) {
                // Overlay mode: keep merged data, just update display focus
                this._composeAndApplyMask(skipRender);

                if (!skipRender) {
                    this.render('setFrame-overlay');
                }
            } else {
                // Normal mode: load individual frame data
                this._loadFrameData(frameIndex, true); // Load without render

                // Apply selection mask after frame data is loaded
                this._composeAndApplyMask(skipRender);

                if (!skipRender) {
                    this.render('setFrame'); // Render once unless skipped
                }
            }

            this.lastRenderedFrame = frameIndex;

            // Update PAE container visibility and data
            if (window.PAE) {
                window.PAE.updateFrame(this, object, frameIndex);
            }

            this.setUIEnabled(true); // Make sure controls are enabled

            // Notify listeners (e.g., scatter plot) of frame change
            try {
                if (typeof document !== 'undefined') {
                    document.dispatchEvent(new CustomEvent('py2dmol-frame-change', {
                        detail: { frameIndex }
                    }));
                }
            } catch (e) {
                // Ignore dispatch errors
            }

            // Directly update scatter renderer highlight if present
            if (this.scatterRenderer) {
                this.scatterRenderer.currentFrameIndex = frameIndex;
                this.scatterRenderer.render();
            }
        }



        // Check if frame has valid plddt data
        _hasPlddtData(frame) {
            return frame && frame.plddts && Array.isArray(frame.plddts) && frame.plddts.length > 0;
        }

        // Resolve plddt data for a frame (returns actual data or null)
        // Searches backward from frameIndex to find most recent frame with plddt
        _resolvePlddtData(object, frameIndex) {
            if (frameIndex < 0 || frameIndex >= object.frames.length) return null;

            const currentFrame = object.frames[frameIndex];

            // If frame explicitly has plddts (even if null), don't inherit
            if ('plddts' in currentFrame) {
                return currentFrame.plddts;
            }

            // Check current frame first
            if (this._hasPlddtData(currentFrame)) {
                return currentFrame.plddts;
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

        // Check if current object has scatter data
        objectHasScatter(objectName = null) {
            const name = objectName || this.currentObjectName;
            if (!name || !this.objectsData[name]) {
                return false;
            }

            const object = this.objectsData[name];
            if (!object.frames || object.frames.length === 0) {
                return false;
            }

            // Check if any frame has valid scatter data (directly or via inheritance)
            let lastScatter = null;
            for (let i = 0; i < object.frames.length; i++) {
                const frame = object.frames[i];
                const scatterPoint = frame.scatter !== undefined ? frame.scatter : lastScatter;

                if (scatterPoint && Array.isArray(scatterPoint) && scatterPoint.length === 2) {
                    return true;
                }
                lastScatter = scatterPoint;
            }
            return false;
        }

        // Update scatter plot data for current object
        updateScatterData(objectName = null) {
            if (!this.scatterRenderer) {
                return;
            }

            const name = objectName || this.currentObjectName;

            if (!name || !this.objectsData[name]) {
                this.scatterRenderer.setData([], [], 'X', 'Y');
                this.scatterRenderer.render();
                return;
            }

            const object = this.objectsData[name];
            const frames = object.frames || [];

            if (frames.length === 0) {
                return;
            }

            // If object truly has no scatter data, note it explicitly
            // (no-op here; scatter presence is derived from frames below)

            // Collect scatter data from all frames (same logic as initialization)
            const xData = [];
            const yData = [];
            let lastScatter = null;

            for (let i = 0; i < frames.length; i++) {
                const frame = frames[i];
                const scatterPoint = frame.scatter !== undefined ? frame.scatter : lastScatter;

                if (scatterPoint && Array.isArray(scatterPoint) && scatterPoint.length === 2) {
                    xData.push(scatterPoint[0]);
                    yData.push(scatterPoint[1]);
                    lastScatter = scatterPoint;
                } else {
                    // Frame has no scatter point - use NaN for gap
                    xData.push(NaN);
                    yData.push(NaN);
                }
            }

            // Ensure scatter_config is initialized (labels/limits)
            const cfg = object.scatterConfig || {};
            cfg.xlabel = cfg.xlabel || 'X';
            cfg.ylabel = cfg.ylabel || 'Y';
            cfg.xlim = cfg.xlim || null;
            cfg.ylim = cfg.ylim || null;
            object.scatterConfig = cfg;

            const xlabel = cfg.xlabel;
            const ylabel = cfg.ylabel;
            const xlim = cfg.xlim;
            const ylim = cfg.ylim;

            // Update scatter renderer with new data
            this.scatterRenderer.setData(xData, yData, xlabel, ylabel);

            // Apply limits from object-specific metadata
            if (xlim && Array.isArray(xlim) && xlim.length === 2) {
                this.scatterRenderer.xMin = xlim[0];
                this.scatterRenderer.xMax = xlim[1];
            }
            if (ylim && Array.isArray(ylim) && ylim.length === 2) {
                this.scatterRenderer.yMin = ylim[0];
                this.scatterRenderer.yMax = ylim[1];
            }

            this.scatterRenderer.render();
        }

        // Check if scatter should be visible
        objectHasScatter() {
            if (!this.currentObjectName || !this.objectsData[this.currentObjectName]) {
                return false;
            }

            const obj = this.objectsData[this.currentObjectName];
            const frames = obj.frames || [];

            // Check if there's actual scatter data in any frame
            const hasScatterData = frames.some(frame => frame.scatter && frame.scatter.length === 2);

            // If there's actual scatter data, show it
            if (hasScatterData) {
                return true;
            }

            // If no scatter data but scatter is explicitly enabled in config (e.g., viewer.py with scatter=True),
            // show empty scatter plot waiting for data
            if (this.config && this.config.scatter && this.config.scatter.enabled) {
                return true;
            }

            // No scatter data and not explicitly enabled
            return false;
        }

        // Update scatter container visibility based on current object's scatter data
        updateScatterContainerVisibility() {
            // Use viewer-specific canvas reference to avoid capturing wrong container
            // when multiple py2Dmol viewers exist (e.g., in different notebook cells)
            let scatterContainer = null;
            let scatterCanvas = null;

            if (this.scatterRenderer && this.scatterRenderer.canvas) {
                scatterCanvas = this.scatterRenderer.canvas;
                scatterContainer = scatterCanvas.parentElement;
            }

            if (!scatterContainer) return;

            const hasScatter = this.objectHasScatter();

            scatterContainer.style.display = hasScatter ? 'flex' : 'none';

            if (scatterCanvas) {
                scatterCanvas.style.display = hasScatter ? 'block' : 'none';
            }

            // Update data if scatter exists
            if (hasScatter) {
                this.updateScatterData();
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
            if (this.speedButton) this.speedButton.disabled = !enabled;
            this.rotationCheckbox.disabled = !enabled;
            this.lineWidthSlider.disabled = !enabled;
            if (this.shadowEnabledCheckbox) this.shadowEnabledCheckbox.disabled = !enabled;
            if (this.outlineModeButton) this.outlineModeButton.disabled = !enabled;
            if (this.outlineModeSelect) this.outlineModeSelect.disabled = !enabled;
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

            // Check config.display.controls before showing
            // Unified check for all object/frame totals
            const controlsEnabled = this.config.display?.controls !== false;
            this.controlsContainer.style.display = controlsEnabled ? 'flex' : 'none';

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
                        containerToShow.style.display = this.config.display?.controls ? 'flex' : 'none';
                    }
                }
            }

            this.frameSlider.max = Math.max(0, total - 1);

            // Don't update slider value while user is dragging it
            if (!this.isSliderDragging) {
                this.frameSlider.value = this.currentFrame;
            }

            this.frameCounter.textContent = `${total > 0 ? current : 0} / ${total}`;

            // Hide frame/play controls when only one frame (or none)
            const hasMultipleFrames = total > 1;
            const frameControls = [
                this.playButton,
                this.frameSlider,
                this.frameCounter,
                this.speedButton
            ];
            frameControls.forEach((el) => {
                if (el) {
                    el.style.display = hasMultipleFrames && controlsEnabled ? '' : 'none';
                }
            });

            // Hide controls container if no multiple frames (prevents empty white box)
            // controlsContainer in index.html only contains frame-related controls
            // In viewer.html, it may have other controls, so check what's inside
            if (this.controlsContainer) {
                // Show container only if controls are enabled AND there are multiple frames
                this.controlsContainer.style.display = (controlsEnabled && hasMultipleFrames) ? 'flex' : 'none';
            }

            this._updateSpeedButtonLabel();

            // Update overlay button
            if (this.overlayButton) {
                // Disable overlay button if only 1 frame
                this.overlayButton.disabled = (total <= 1);

                // Hide overlay button if only 1 frame
                this.overlayButton.style.display = (total <= 1) ? 'none' : '';
            }

            // Unified frame control state
            const shouldDisableFrameControls = this.overlayState.enabled || (total <= 1);

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
                    this.playButton.textContent = this.isPlaying ? '❚❚' : '▶︎';
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
                this.frameSlider.disabled = this.overlayState.enabled;
                this.frameSlider.style.opacity = this.overlayState.enabled ? '0.5' : '';
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
                if (this.overlayState.enabled) {
                    console.warn("Cannot start playback while in overlay mode");
                    return;
                }
                this.startAnimation();
            }
        }

        /**
         * Merge a range of frames into a single coordinate/property set with frameIdMap tracking.
         * This is the SINGLE SOURCE OF TRUTH for frame merging logic (Commit 2 refactor).
         * Used by both toggleOverlay() and addFrame() to ensure consistent behavior.
         *
         * @param {Object} object - The object containing frames to merge
         * @param {number} startFrame - Starting frame index (0-based)
         * @param {number} endFrame - Ending frame index (inclusive)
         * @returns {Object} Merged data object with coords, plddts, chains, frameIdMap, autoColor, etc.
         */
        _mergeFrameRange(object, startFrame, endFrame) {
            if (!object || object.frames.length === 0) {
                return null;
            }

            // Validate frame range
            startFrame = Math.max(0, startFrame);
            endFrame = Math.min(object.frames.length - 1, endFrame);

            if (startFrame > endFrame) {
                return null;
            }

            // Determine auto color mode based on first frame characteristics
            let autoColor = 'rainbow';  // Default
            const firstFrame = object.frames[0];
            if (firstFrame) {
                const firstFrameChains = firstFrame.chains || [];
                const uniqueFirstChains = new Set(firstFrameChains);
                const hasFirstPAE = firstFrame.pae && firstFrame.pae.length > 0;

                if (hasFirstPAE) {
                    autoColor = 'plddt';
                } else if (uniqueFirstChains.size > 1) {
                    autoColor = 'chain';
                } else {
                    autoColor = 'rainbow';
                }
            }

            // Initialize merge arrays
            const mergedCoords = [];
            const mergedPlddts = [];
            const mergedChains = [];
            const mergedPositionTypes = [];
            const mergedPositionNames = [];
            const mergedResidueNumbers = [];
            const mergedBonds = [];
            const frameIdMap = [];

            // Merge all frames in the range
            for (let frameIdx = startFrame; frameIdx <= endFrame; frameIdx++) {
                const frame = object.frames[frameIdx];
                if (!frame) continue;

                const frameCoords = frame.coords || [];
                const frameBonds = frame.bonds || [];
                const frameChains = frame.chains || Array(frameCoords.length).fill('A');
                const atomOffset = mergedCoords.length;
                const frameAtomCount = frameCoords.length;

                // Merge coords and build frameIdMap
                for (let i = 0; i < frameAtomCount; i++) {
                    mergedCoords.push(frameCoords[i]);
                    frameIdMap.push(frameIdx);
                }

                // Merge data fields - always create arrays with frameAtomCount elements
                const plddts = frame.plddts && frame.plddts.length === frameAtomCount ?
                    frame.plddts : Array(frameAtomCount).fill(50.0);
                const positionTypes = frame.position_types && frame.position_types.length === frameAtomCount ?
                    frame.position_types : Array(frameAtomCount).fill('P');
                const positionNames = frame.position_names && frame.position_names.length === frameAtomCount ?
                    frame.position_names : Array(frameAtomCount).fill('UNK');
                const residueNumbers = frame.residue_numbers && frame.residue_numbers.length === frameAtomCount ?
                    frame.residue_numbers : Array.from({ length: frameAtomCount }, (_, i) => i + 1);

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

            // Recalculate autoColor based on MERGED chains, not just first frame
            // This ensures multi-chain structures are properly colored by chain in overlay mode
            const uniqueMergedChains = new Set(mergedChains);
            const hasFirstPAE = firstFrame?.pae && firstFrame.pae.length > 0;

            if (hasFirstPAE) {
                autoColor = 'plddt';
            } else if (uniqueMergedChains.size > 1) {
                autoColor = 'chain';
            } else {
                autoColor = 'rainbow';
            }

            // Return merged data object
            return {
                coords: mergedCoords,
                plddts: mergedPlddts,
                chains: mergedChains,
                position_types: mergedPositionTypes,
                position_names: mergedPositionNames,
                residue_numbers: mergedResidueNumbers,
                pae: this.pae || null,
                bonds: mergedBonds.length > 0 ? mergedBonds : null,
                frameIdMap: frameIdMap,
                autoColor: autoColor,
                startFrame: startFrame,
                endFrame: endFrame
            };
        }

        /**
         * Atomically enter overlay mode for the current object.
         * Merges all frames and loads the merged data.
         * This is the SINGLE PATH to enter overlay mode (Commit 3 refactor).
         */
        _enterOverlayMode(object, skipRender = false) {
            if (!object || object.frames.length === 0) {
                return false;
            }

            // Merge all frames
            const merged = this._mergeFrameRange(object, 0, object.frames.length - 1);
            if (!merged) {
                return false;
            }

            // Atomically set all overlay state
            this.overlayState.enabled = true;
            this.overlayState.frameIdMap = merged.frameIdMap;
            this.overlayState.autoColor = merged.autoColor;
            this.lastOperationMode = 'overlay-enter';

            // Disable speed button in overlay mode (no animation)
            if (this.speedButton) {
                this.speedButton.disabled = true;
                this.speedButton.style.opacity = '0.5';
                this.speedButton.style.cursor = 'not-allowed';
            }

            this._invalidateSegmentCache();

            // Set current frame to 0 for merged view
            this.currentFrame = 0;

            // Load merged data
            this._loadDataIntoRenderer(merged, skipRender);

            return true;
        }

        /**
         * Atomically exit overlay mode and return to single frame view.
         * Clears all overlay state and loads the target frame.
         * This is the SINGLE PATH to exit overlay mode (Commit 3 refactor).
         */
        _exitOverlayMode(object, targetFrame = 0, skipRender = false) {
            if (!object || object.frames.length === 0) {
                return false;
            }

            // Validate target frame
            targetFrame = Math.max(0, Math.min(targetFrame, object.frames.length - 1));

            // Atomically clear all overlay state
            this.overlayState.enabled = false;
            this.overlayState.frameIdMap = null;
            this.overlayState.autoColor = null;
            this.lastOperationMode = 'overlay-exit';

            // Re-enable speed button when exiting overlay mode
            if (this.speedButton) {
                this.speedButton.disabled = false;
                this.speedButton.style.opacity = '1.0';
                this.speedButton.style.cursor = 'pointer';
            }

            // Invalidate segment cache (critical after exiting overlay)
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesFrame = -1;
            this.cachedSegmentIndicesObjectName = null;

            // Load the target single frame (NOT merged)
            this._loadFrameData(targetFrame, skipRender);

            return true;
        }

        // Toggle overlay mode (merge all frames in same view)
        toggleOverlay() {
            // Stop any playing animation
            if (this.isPlaying) {
                this.stopAnimation();
            }

            if (!this.currentObjectName) return;

            const object = this.objectsData[this.currentObjectName];
            if (!object || object.frames.length === 0) return;

            // Use atomic state transition methods (Commit 3)
            if (!this.overlayState.enabled) {
                // Enter overlay mode using unified method
                this._enterOverlayMode(object, false);
            } else {
                // Exit overlay mode using unified method
                const targetFrame = Math.max(0, this.currentFrame);
                this._exitOverlayMode(object, targetFrame, false);
            }

            // Update overlay button styling - checkbox style
            if (this.overlayButton) {
                if (this.overlayState.enabled) {
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
                // In overlay mode, don't reload frame data (would destroy merged data)
                if (!this.overlayState.enabled) {
                    this._loadFrameData(0, true); // Load without render
                }
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
                        // In overlay mode, don't reload frame data (would destroy merged data)
                        if (!this.overlayState.enabled) {
                            this._loadFrameData(nextFrame, true); // Load without render
                        }
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
            // In overlay mode, don't reload frame data (would destroy merged data)
            if (!this.overlayState.enabled) {
                this._loadFrameData(currentFrame, true); // Load without render
            }
            this.render();
            this.lastRenderedFrame = currentFrame;
            this.updateUIControls();

            // Wait for frame to be captured, then advance
            // Use requestAnimationFrame to ensure render is complete
            requestAnimationFrame(() => {
                // Update scatter plot for current frame if present
                if (this.scatterRenderer) {
                    this.scatterRenderer.currentFrameIndex = currentFrame;
                    this.scatterRenderer.render();
                }

                // Update composite canvas if recording with scatter plot
                if (this.updateCompositeCanvas) {
                    this.updateCompositeCanvas();
                }

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

            // Check if scatter plot is visible
            // Use viewer-specific canvas reference to avoid capturing scatter from wrong viewer
            // when multiple py2Dmol viewers exist (e.g., in different notebook cells)
            let scatterCanvas = null;
            let scatterContainer = null;

            if (this.scatterRenderer && this.scatterRenderer.canvas) {
                // The scatter renderer already has the correct canvas reference for THIS viewer
                scatterCanvas = this.scatterRenderer.canvas;
                scatterContainer = scatterCanvas.parentElement;
            }

            const hasScatter = scatterCanvas && scatterContainer &&
                scatterContainer.style.display !== 'none' &&
                this.scatterRenderer;

            // Capture stream from canvas at 30fps for smooth playback
            const fps = 30;

            if (hasScatter) {
                // Create composite canvas for both molecular viewer and scatter plot
                this.recordingCompositeCanvas = document.createElement('canvas');
                const molHeight = this.canvas.height;
                const molWidth = this.canvas.width;
                const scatterHeight = scatterCanvas.height;
                const scatterWidth = scatterCanvas.width;

                // Calculate scatter dimensions when scaled to match mol height
                const scatterScale = molHeight / scatterHeight;
                const scatterScaledWidth = scatterWidth * scatterScale;
                const scatterScaledHeight = molHeight;

                // Set composite canvas size (side by side, same height)
                this.recordingCompositeCanvas.height = molHeight;
                this.recordingCompositeCanvas.width = molWidth + scatterScaledWidth;

                const ctx = this.recordingCompositeCanvas.getContext('2d');

                // Create a function to composite both canvases
                this.updateCompositeCanvas = () => {
                    // Clear composite canvas
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, this.recordingCompositeCanvas.width, this.recordingCompositeCanvas.height);

                    // Draw molecular viewer on the left
                    ctx.drawImage(this.canvas, 0, 0, molWidth, molHeight);

                    // Draw scatter plot on the right, scaled to match molecular viewer height
                    ctx.drawImage(scatterCanvas, molWidth, 0, scatterScaledWidth, scatterScaledHeight);
                };

                // Capture stream from composite canvas
                // Note: composite is updated on-demand in recordFrameSequence() after each render
                this.recordingStream = this.recordingCompositeCanvas.captureStream(fps);
            } else {
                // No scatter plot - capture only the molecular viewer canvas
                this.recordingStream = this.canvas.captureStream(fps);
            }

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
                        // Update scatter plot and composite for frame 0 before starting
                        if (this.scatterRenderer) {
                            this.scatterRenderer.currentFrameIndex = 0;
                            this.scatterRenderer.render();
                        }
                        if (this.updateCompositeCanvas) {
                            this.updateCompositeCanvas();
                        }

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

            // Clean up composite canvas if it exists
            this.updateCompositeCanvas = null;
            this.recordingCompositeCanvas = null;
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

                // Clean up composite canvas if it exists
                this.updateCompositeCanvas = null;
                this.recordingCompositeCanvas = null;

                // Ensure animation is stopped and state is clean
                this.stopAnimation();
                // Reset currentFrame to last valid frame before updating UI
                const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                if (object && object.frames.length > 0) {
                    this.currentFrame = Math.max(0, object.frames.length - 1);
                }
                this.updateUIControls();
                return;
            }

            // Create blob from recorded chunks
            const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
            const filename = `py2dmol_animation_${this.currentObjectName || 'recording'}_${Date.now()}.webm`;

            // Download video directly
            this._downloadVideo(blob, filename);


            // Clean up all recording state
            this.recordedChunks = [];
            this.isRecording = false;
            this.mediaRecorder = null;
            this._stopRecordingTracks();

            // Clean up composite canvas if it exists
            this.updateCompositeCanvas = null;
            this.recordingCompositeCanvas = null;

            // Ensure animation is fully stopped and state is clean
            this.stopAnimation();

            // Reset currentFrame to last valid frame before updating UI
            const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
            if (object && object.frames.length > 0) {
                this.currentFrame = Math.max(0, object.frames.length - 1);
            }

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
            this.viewerState = {
                rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                zoom: 1.0,
                perspectiveEnabled: false,
                focalLength: 200.0,
                center: null,
                extent: null,
                currentFrame: -1
            };
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
            } else {
                console.warn(`[_loadDataIntoRenderer] No data to load: coords=${data?.coords?.length}`);
            }
        }

        setCoords(coords, plddts, chains, positionTypes, hasPAE = false, positionNames, residueNumbers, skipRender = false, bonds = null) {
            // Invalidate shadow cache when coordinates change (different geometry needs new shadows)
            this._invalidateShadowCache();
            this.lastShadowRotationMatrix = null;

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
            const validModes = getAllValidColorModes();
            if (!this.colorMode || !validModes.includes(this.colorMode)) {
                this.colorMode = 'auto';
            }

            // Map entropy to structure if entropy mode is active
            if (this.colorMode === 'entropy' && this.currentObjectName && this.objectsData[this.currentObjectName] && window.MSA) {
                this.entropy = window.MSA.mapEntropyToStructure(this.objectsData[this.currentObjectName], this.currentFrame >= 0 ? this.currentFrame : 0);
                this._updateEntropyOptionVisibility();
            } else {
                // Clear entropy when not in entropy mode
                this.entropy = undefined;
                this._updateEntropyOptionVisibility();
            }

            // Mark colors as needing update when coordinates change
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;

            // Use provided data if available, otherwise inherit from cache, otherwise use defaults
            this._setDataField('plddts', 'cachedPlddts', plddts, n, (n) => Array(n).fill(50.0));
            this._setDataField('chains', 'cachedChains', chains, n, (n) => Array(n).fill('A'));
            this._setDataField('positionTypes', 'cachedPositionTypes', positionTypes, n, (n) => Array(n).fill('P'));
            this._setDataField('positionNames', 'cachedPositionNames', positionNames, n, (n) => Array(n).fill('UNK'));
            this._setDataField('residueNumbers', 'cachedResidueNumbers', residueNumbers, n, (n) => Array.from({ length: n }, (_, i) => i + 1));

            // Calculate what 'auto' should resolve to
            // Priority: plddt (if PAE present) > chain (if multi-chain) > rainbow
            // In overlay mode, use merged auto color based on all frames
            const uniqueChains = new Set(this.chains);
            if (this.overlayState.enabled && this.overlayState.autoColor) {
                this.resolvedAutoColor = this.overlayState.autoColor;
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
                if (this.overlayState.enabled && this.overlayState.frameIdMap) {
                    const currentFrame = this.overlayState.frameIdMap[i];
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
            // In overlay mode: per-frame scales (each frame gets own 0-100% gradient)
            // In normal mode: global scales
            if (this.overlayState.enabled && this.overlayState.frameIdMap) {
                // Per-frame rainbow scales
                this.frameRainbowScales = {};
                for (let i = 0; i < this.positionTypes.length; i++) {
                    const type = this.positionTypes[i];
                    const chainId = this.chains[i] || 'A';
                    const frameIdx = this.overlayState.frameIdMap[i];
                    const isLigandOnlyChain = this.ligandOnlyChains.has(chainId);

                    if (type === 'P' || type === 'D' || type === 'R' || (type === 'L' && isLigandOnlyChain)) {
                        // Initialize frame scale if needed
                        if (!this.frameRainbowScales[frameIdx]) {
                            this.frameRainbowScales[frameIdx] = {};
                        }
                        if (!this.frameRainbowScales[frameIdx][chainId]) {
                            this.frameRainbowScales[frameIdx][chainId] = { min: Infinity, max: -Infinity };
                        }
                        const colorIndex = this.perChainIndices[i];
                        const scale = this.frameRainbowScales[frameIdx][chainId];
                        scale.min = Math.min(scale.min, colorIndex);
                        scale.max = Math.max(scale.max, colorIndex);
                    }
                }
                // Keep chainRainbowScales as null in overlay mode to avoid confusion
                this.chainRainbowScales = null;
            } else {
                // Global rainbow scales (normal mode)
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

            // Expand rotatedCoords to match coords array BEFORE any segment operations
            // This must happen whether using cache or generating new segments
            const currentCoordsLength = this.coords.length;
            while (this.rotatedCoords.length < currentCoordsLength) {
                this.rotatedCoords.push(new Vec3(0, 0, 0));
            }

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

                const ligandIndicesByChain = new Map(); // Group ligands by chain
                const chainPolymerBounds = new Map(); // Track first/last polymer per chain

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
                        const chainId = this.chains[i] || 'A';

                        // Track first and last polymer index per chain
                        if (!chainPolymerBounds.has(chainId)) {
                            chainPolymerBounds.set(chainId, { first: i, last: i });
                        } else {
                            chainPolymerBounds.get(chainId).last = i;
                        }

                        if (i < n - 1) {
                            if (isPolymerArr[i + 1]) {
                                const type1 = type;
                                const type2 = this.positionTypes[i + 1];
                                const samePolymerType = (type1 === type2) ||
                                    ((type1 === 'D' || type1 === 'R') && (type2 === 'D' || type2 === 'R'));

                                // In overlay mode, also check that both atoms are in the same frame
                                let sameFrame = true;
                                if (this.overlayState.enabled && this.overlayState.frameIdMap) {
                                    sameFrame = this.overlayState.frameIdMap[i] === this.overlayState.frameIdMap[i + 1];
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

                // Check for cyclic peptides (first-to-last bond) per chain
                const detectCyclic = (typeof this.config.rendering?.detect_cyclic === 'boolean') ? this.config.rendering.detect_cyclic : true;
                if (detectCyclic) {
                    for (const [chainId, bounds] of chainPolymerBounds.entries()) {
                        const firstIdx = bounds.first;
                        const lastIdx = bounds.last;

                        // Skip if only one position in chain or same position
                        if (firstIdx === lastIdx) continue;

                        // Check if both are polymer positions of compatible type
                        if (isPolymerArr[firstIdx] && isPolymerArr[lastIdx]) {
                            const type1 = this.positionTypes[firstIdx];
                            const type2 = this.positionTypes[lastIdx];
                            const samePolymerType = (type1 === type2) ||
                                ((type1 === 'D' || type1 === 'R') && (type2 === 'D' || type2 === 'R'));

                            if (samePolymerType) {
                                const start = this.coords[firstIdx];
                                const end = this.coords[lastIdx];
                                const distSq = start.distanceToSq(end);
                                const chainbreakDistSq = getChainbreakDistSq(type1, type2);

                                if (distSq < chainbreakDistSq) {
                                    this.segmentIndices.push({
                                        idx1: firstIdx,
                                        idx2: lastIdx,
                                        colorIndex: this.perChainIndices[firstIdx],
                                        origIndex: firstIdx,
                                        chainId: chainId,
                                        type: type1,
                                        len: Math.sqrt(distSq)
                                    });
                                }
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
                        if (this.overlayState.enabled && this.overlayState.frameIdMap) {
                            const frame1 = this.overlayState.frameIdMap[idx1];
                            const frame2 = this.overlayState.frameIdMap[idx2];
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
                }

                // === Generate ligand bonds ===
                const obj = this.objectsData[this.currentObjectName];
                if (obj?.ligandGroups?.size > 0) {
                    // Use ligand groups: only compute distances within each group
                    for (const [groupKey, ligandPositionIndices] of obj.ligandGroups.entries()) {
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

                // Make sure all data arrays are the same length
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
            // 3. We just generated new segments (canUseCache was false)

            const needBuild = !this.adjList ||
                this.adjList.length !== numPositions ||
                !this.segmentOrder ||
                this.segmentOrder.length < numSegments ||
                !canUseCache;

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
            const resolvedPae = window.PAE ? window.PAE.resolveData(object, frameIndex) : (data.pae || null);

            // Get bonds from object-level if available
            const resolvedBonds = object.bonds || null;

            // Create resolved data object (use resolved values if frame doesn't have its own)
            const resolvedData = {
                ...data,
                plddts: resolvedPlddt ?? data.plddts ?? null,
                pae: resolvedPae !== null ? resolvedPae : data.pae,
                bonds: resolvedBonds
            };

            // Load 3D data (with skipRender option)
            this._loadDataIntoRenderer(resolvedData, skipRender);

            // Load PAE data (use resolved value)
            if (window.PAE) {
                // We use updateFrame which handles data setting and visibility
                window.PAE.updateFrame(this, object, frameIndex);
            } else if (this.paeRenderer) {
                this.paeRenderer.setData(resolvedPae);
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
            if (this.colorMode === 'entropy' && this.currentObjectName && this.objectsData[this.currentObjectName] && window.MSA) {
                this.entropy = window.MSA.mapEntropyToStructure(this.objectsData[this.currentObjectName], this.currentFrame >= 0 ? this.currentFrame : 0);
                this._updateEntropyOptionVisibility();
            }
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
            const validModes = getAllValidColorModes();

            // Check for object-level color mode first
            if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                const objectColorMode = this.objectsData[this.currentObjectName].colorMode;
                if (objectColorMode && validModes.includes(objectColorMode)) {
                    // If object color mode is 'auto', resolve to calculated mode
                    if (objectColorMode === 'auto') {
                        const resolved = this.resolvedAutoColor || 'rainbow';
                        return resolved;
                    }
                    return objectColorMode;
                }
            }

            // Fall back to global color mode
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
                return DEFAULT_GREY;
            }

            // Resolve color through the unified hierarchy
            // In overlay mode, determine which frame this atom belongs to from frameIdMap
            let frameIndex = this.currentFrame >= 0 ? this.currentFrame : 0;
            if (this.overlayState.enabled && this.overlayState.frameIdMap && atomIndex < this.overlayState.frameIdMap.length) {
                frameIndex = this.overlayState.frameIdMap[atomIndex];
            }

            const chainId = this.chains[atomIndex] || 'A';

            const context = {
                frameIndex: frameIndex,
                posIndex: atomIndex,
                chainId: chainId,
                renderer: this
            };

            const { resolvedMode, resolvedLiteralColor } = resolveColorHierarchy(context, null);

            // Use resolved color mode (frame color takes priority over passed-in global mode)
            // If resolveColorHierarchy found a specific mode, use it
            // IMPORTANT: 'auto' is not a real color mode, it must be resolved via _getEffectiveColorMode()
            if (resolvedMode && resolvedMode !== 'auto' && resolvedMode !== this.colorMode) {
                effectiveColorMode = resolvedMode;
            } else if (!effectiveColorMode || effectiveColorMode === 'auto' || resolvedMode === 'auto') {
                // Resolve 'auto' to actual mode (chain/rainbow/plddt)
                effectiveColorMode = this._getEffectiveColorMode();
            }

            // If we have a resolved literal color, use it immediately (highest priority)
            if (resolvedLiteralColor !== null) {
                let literalColor;
                if (typeof resolvedLiteralColor === 'string' && resolvedLiteralColor.startsWith('#')) {
                    literalColor = hexToRgb(resolvedLiteralColor);
                } else if (typeof resolvedLiteralColor === 'string') {
                    // Try to convert named color to hex
                    const hex = namedColorsMap[resolvedLiteralColor.toLowerCase()];
                    literalColor = hex ? hexToRgb(hex) : DEFAULT_GREY;
                } else if (resolvedLiteralColor && typeof resolvedLiteralColor === 'object' && (resolvedLiteralColor.r !== undefined || resolvedLiteralColor.g !== undefined || resolvedLiteralColor.b !== undefined)) {
                    literalColor = resolvedLiteralColor; // Already RGB object
                }
                if (literalColor) {
                    return literalColor;
                }
            }

            const type = (this.positionTypes && atomIndex < this.positionTypes.length) ? this.positionTypes[atomIndex] : undefined;
            let color;

            // Ligands should always be grey in chain and rainbow modes (not plddt)
            const isLigand = type === 'L';

            if (effectiveColorMode === 'plddt') {
                const plddt = (this.plddts[atomIndex] !== null && this.plddts[atomIndex] !== undefined) ? this.plddts[atomIndex] : 50;
                color = getPlddtColor(plddt, this.colorblindMode);
            } else if (effectiveColorMode === 'deepmind') {
                const plddt = (this.plddts[atomIndex] !== null && this.plddts[atomIndex] !== undefined) ? this.plddts[atomIndex] : 50;
                color = getPlddtAFColor(plddt, this.colorblindMode);
            } else if (effectiveColorMode === 'entropy') {
                // Get entropy value from mapped entropy vector
                const entropy = (this.entropy && atomIndex < this.entropy.length && this.entropy[atomIndex] !== undefined && this.entropy[atomIndex] >= 0)
                    ? this.entropy[atomIndex]
                    : undefined;
                if (entropy !== undefined && window.MSA && window.MSA.getEntropyColor) {
                    color = window.MSA.getEntropyColor(entropy, this.colorblindMode);
                } else {
                    // No entropy data for this position (ligand, RNA/DNA, or unmapped) - use default grey
                    color = DEFAULT_GREY;
                }
            } else if (effectiveColorMode === 'chain') {
                const chainId = this.chains[atomIndex] || 'A';
                if (isLigand && !this.ligandOnlyChains.has(chainId)) {
                    // Ligands in chains with P/D/R positions are grey
                    color = DEFAULT_GREY;
                } else {
                    // Regular positions, or ligands in ligand-only chains, get chain color
                    if (this.chainIndexMap && this.chainIndexMap.has(chainId)) {
                        const chainIndex = this.chainIndexMap.get(chainId);
                        const colorArray = this.colorblindMode ? chainColorsColorblind : chainColors;
                        const hex = colorArray[chainIndex % colorArray.length];
                        color = hexToRgb(hex);
                    } else {
                        // Fallback: use a default color if chainIndexMap is not initialized
                        const colorArray = this.colorblindMode ? chainColorsColorblind : chainColors;
                        const hex = colorArray[0]; // Use first color as default
                        color = hexToRgb(hex);
                    }
                }
            } else if (window.py2dmol_customColors && window.py2dmol_customColors[effectiveColorMode]) {
                // Custom color mode registered by external code
                const customColorFunc = window.py2dmol_customColors[effectiveColorMode];
                try {
                    color = customColorFunc(atomIndex, this);
                    if (!color) {
                        color = { r: 128, g: 128, b: 128 }; // Fallback grey if function returns null
                    }
                } catch (e) {
                    console.error(`Error in custom color function for mode "${effectiveColorMode}":`, e);
                    color = { r: 128, g: 128, b: 128 };
                }
            } else { // rainbow
                if (isLigand) {
                    // All ligands are grey in rainbow mode
                    color = DEFAULT_GREY;
                } else {
                    // Regular positions get rainbow color
                    const chainId = this.chains[atomIndex] || 'A';

                    // In overlay mode, use per-frame scales; otherwise use global scales
                    let scale = null;
                    if (this.overlayState.enabled && this.overlayState.frameIdMap && this.frameRainbowScales) {
                        const frameIdx = this.overlayState.frameIdMap[atomIndex];
                        scale = this.frameRainbowScales[frameIdx] && this.frameRainbowScales[frameIdx][chainId];
                    } else {
                        scale = this.chainRainbowScales && this.chainRainbowScales[chainId];
                    }

                    if (scale && scale.min !== Infinity && scale.max !== -Infinity) {
                        const colorIndex = this.perChainIndices && atomIndex < this.perChainIndices.length ? this.perChainIndices[atomIndex] : 0;
                        color = getRainbowColor(colorIndex, scale.min, scale.max, this.colorblindMode);
                    } else {
                        // Fallback: if scale not found, use a default rainbow based on colorIndex
                        const colorIndex = (this.perChainIndices && atomIndex < this.perChainIndices.length ? this.perChainIndices[atomIndex] : 0) || 0;
                        color = getRainbowColor(colorIndex, 0, Math.max(1, colorIndex), this.colorblindMode);
                    }
                }
            }

            return color;
        }

        // Get chain color for a given chain ID (for UI elements like sequence viewer)
        getChainColorForChainId(chainId) {
            if (!this.chainIndexMap || !chainId) {
                return DEFAULT_GREY; // Default lightened gray
            }
            const chainIndex = this.chainIndexMap.get(chainId) || 0;
            const colorArray = this.colorblindMode ? chainColorsColorblind : chainColors;
            const hex = colorArray[chainIndex % colorArray.length];
            return hexToRgb(hex);
        }

        // Calculate segment colors (chain or rainbow)
        // Uses getAtomColor() as single source of truth for all color logic
        _calculateSegmentColors(effectiveColorMode = null) {
            const m = this.segmentIndices.length;
            if (m === 0) return [];

            // In overlay mode with frame-level colors, let each atom determine its own color mode
            // Otherwise cache the effective color mode to avoid recalculating for every position
            let usePerAtomColorMode = this.overlayState.enabled && this.overlayState.frameIdMap;
            if (!effectiveColorMode && !usePerAtomColorMode) {
                effectiveColorMode = this._getEffectiveColorMode();
            }

            // Use getAtomColor() for each segment - ensures consistency and eliminates duplicate logic
            return this.segmentIndices.map(segInfo => {
                // Contacts use custom color if provided, otherwise yellow
                if (segInfo.type === 'C') {
                    if (segInfo.contactColor) {
                        return segInfo.contactColor; // Use custom color from contact file
                    }
                    return DEFAULT_CONTACT_COLOR; // Default yellow
                }

                const positionIndex = segInfo.origIndex;
                // In overlay mode with per-frame colors, pass null so getAtomColor resolves per-atom
                const colorMode = usePerAtomColorMode ? null : effectiveColorMode;
                return this.getAtomColor(positionIndex, colorMode);
            });
        }

        // Calculate pLDDT colors
        _calculatePlddtColors() {
            const m = this.segmentIndices.length;
            if (m === 0) return [];

            const colors = new Array(m);
            const effectiveMode = this._getEffectiveColorMode();

            // Select the appropriate plddt color function based on effective color mode
            const plddtFunc = (effectiveMode === 'deepmind') ? getPlddtAFColor : getPlddtColor;

            for (let i = 0; i < m; i++) {
                const segInfo = this.segmentIndices[i];

                // Contacts: use custom color if provided, otherwise yellow
                if (segInfo.type === 'C') {
                    const contactColor = segInfo.contactColor || DEFAULT_CONTACT_COLOR;
                    colors[i] = contactColor;
                    continue;
                }

                const positionIndex = segInfo.origIndex;
                const type = segInfo.type;
                let color;

                if (type === 'L') {
                    const plddt1 = (this.plddts[positionIndex] !== null && this.plddts[positionIndex] !== undefined) ? this.plddts[positionIndex] : 50;
                    color = plddtFunc(plddt1, this.colorblindMode);
                } else {
                    const plddts = this.plddts;
                    const plddt1 = (plddts[positionIndex] !== null && plddts[positionIndex] !== undefined) ? plddts[positionIndex] : 50;
                    const plddt2_idx = (segInfo.idx2 < this.coords.length) ? segInfo.idx2 : segInfo.idx1;
                    const plddt2 = (plddts[plddt2_idx] !== null && plddts[plddt2_idx] !== undefined) ? plddts[plddt2_idx] : 50;
                    color = plddtFunc((plddt1 + plddt2) / 2, this.colorblindMode);
                }

                colors[i] = color;
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
        }

        // Dispatcher method: selects fast/slow shadow calculation based on position count
        _calculateFrameShadows(segmentList, numPositions, segments, segData, maxExtent, shadows, tints) {
            const useFastMode = numPositions > this.LARGE_MOLECULE_CUTOFF;

            if (useFastMode) {
                this._calculateShadowsWithGrid(segmentList, segments, segData, maxExtent, shadows, tints);
            } else {
                this._calculateShadowsExhaustive(segmentList, segments, segData, shadows, tints);
            }
        }

        // Slow mode: exhaustive O(n²) shadow calculation for small frames
        _calculateShadowsExhaustive(segmentList, segments, segData, shadows, tints) {
            // Process segments back-to-front (already sorted by z-depth)
            for (let i_idx = segmentList.length - 1; i_idx >= 0; i_idx--) {
                const i = segmentList[i_idx];
                let shadowSum = 0;
                let maxTint = 0;
                const s1 = segData[i];
                const segInfoI = segments[i];
                const isContactI = segInfoI.type === 'C';
                const isMoleculeI = segInfoI.type === 'P' || segInfoI.type === 'D' || segInfoI.type === 'R';

                // Check against all segments in front
                for (let j_idx = i_idx + 1; j_idx < segmentList.length; j_idx++) {
                    const j = segmentList[j_idx];
                    if (shadowSum >= MAX_SHADOW_SUM) break;

                    const s2 = segData[j];
                    const segInfo2 = segments[j];
                    const isContactJ = segInfo2.type === 'C';
                    const isMoleculeJ = segInfo2.type === 'P' || segInfo2.type === 'D' || segInfo2.type === 'R';

                    if ((isContactI && isMoleculeJ) || (isMoleculeI && isContactJ)) {
                        continue;
                    }

                    const { shadow, tint } = this._calculateShadowTint(s1, s2, segInfoI, segInfo2);
                    shadowSum = Math.min(shadowSum + shadow, MAX_SHADOW_SUM);
                    maxTint = Math.max(maxTint, tint);
                }

                shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                tints[i] = 1 - maxTint;
            }
        }

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
                const isContactI = segInfoI.type === 'C';
                const isMoleculeI = segInfoI.type === 'P' || segInfoI.type === 'D' || segInfoI.type === 'R';

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
                            const isContactJ = segInfoJ.type === 'C';
                            const isMoleculeJ = segInfoJ.type === 'P' || segInfoJ.type === 'D' || segInfoJ.type === 'R';

                            if ((isContactI && isMoleculeJ) || (isMoleculeI && isContactJ)) {
                                continue;
                            }

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
            if (window.SEQ && window.SEQ.updateHighlightOverlaySize) {
                window.SEQ.updateHighlightOverlaySize();
            }
        }

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
            // Clear the full canvas in device pixels, independent of current transform
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            if (this.isTransparent) {
                ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            }
            ctx.restore();

            // Check segment length
            if (this.coords.length === 0 || this.segmentIndices.length === 0 || !this.currentObjectName) {
                return;
            }

            const object = this.objectsData[this.currentObjectName];
            if (!object) {
                console.warn("Render called but object data is missing.");
                return;
            }

            // Ensure rotatedCoords array is expanded to match coords
            while (this.rotatedCoords.length < this.coords.length) {
                this.rotatedCoords.push(new Vec3(0, 0, 0));
            }

            // Use temporary center if set (for orienting to visible positions), otherwise use global center
            const globalCenter = (object && object.totalPositions > 0) ? object.globalCenterSum.mul(1 / object.totalPositions) : new Vec3(0, 0, 0);
            const c = this.viewerState.center || globalCenter;

            // Update pre-allocated rotatedCoords
            // Apply object's rotation_matrix first (best_view), then user's rotation
            const m = this.viewerState.rotation;
            const objectRotation = (object && object.rotation_matrix && object.center) ? object.rotation_matrix : null;
            const objectCenter = (object && object.center) ? object.center : null;

            for (let i = 0; i < this.coords.length; i++) {
                let v = this.coords[i];

                // Step 1: Apply object-level rotation (best_view) if present
                if (objectRotation && objectCenter) {
                    const cx = v.x - objectCenter[0];
                    const cy = v.y - objectCenter[1];
                    const cz = v.z - objectCenter[2];
                    const rotX = objectRotation[0][0] * cx + objectRotation[0][1] * cy + objectRotation[0][2] * cz;
                    const rotY = objectRotation[1][0] * cx + objectRotation[1][1] * cy + objectRotation[1][2] * cz;
                    const rotZ = objectRotation[2][0] * cx + objectRotation[2][1] * cy + objectRotation[2][2] * cz;
                    v = new Vec3(rotX + objectCenter[0], rotY + objectCenter[1], rotZ + objectCenter[2]);
                }

                // Step 2: Apply user rotation
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

                if (!visibilityMask) {
                    // No mask = all segments visible (including overlay mode with no selection)
                    isVisible = true;
                } else if (segInfo.type === 'C' && segInfo.contactIdx1 !== undefined && segInfo.contactIdx2 !== undefined) {
                    // For contact segments, check visibility based on original contact endpoints
                    isVisible = visibilityMask.has(segInfo.contactIdx1) && visibilityMask.has(segInfo.contactIdx2);
                } else {
                    // For regular segments, check visibility based on segment endpoints
                    // In overlay mode, the visibility mask has been expanded to include all corresponding positions
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
            const rotationChanged = !this._rotationMatricesEqual(this.viewerState.rotation, this.lastShadowRotationMatrix);

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
                // OVERLAY MODE: Calculate shadows per-frame independently
                if (this.overlayState.enabled && this.overlayState.frameIdMap) {
                    // Group segments by frame
                    const segmentsByFrame = new Map();
                    const frameNumPositions = new Map();

                    for (let i = 0; i < visibleOrder.length; i++) {
                        const segIdx = visibleOrder[i];
                        const frameIdx = this.overlayState.frameIdMap[segments[segIdx].idx1];
                        if (!segmentsByFrame.has(frameIdx)) {
                            segmentsByFrame.set(frameIdx, []);
                            frameNumPositions.set(frameIdx, 0);
                        }
                        segmentsByFrame.get(frameIdx).push(segIdx);
                    }

                    // Count positions per frame
                    for (let i = 0; i < this.coords.length; i++) {
                        const frameIdx = this.overlayState.frameIdMap[i];
                        frameNumPositions.set(frameIdx, (frameNumPositions.get(frameIdx) || 0) + 1);
                    }

                    // Calculate shadows for each frame independently
                    for (const [frameIdx, frameSegments] of segmentsByFrame) {
                        const framePositions = frameNumPositions.get(frameIdx);
                        this._calculateFrameShadows(frameSegments, framePositions, segments, segData, maxExtent, shadows, tints);
                    }
                }
                // NORMAL MODE: Calculate shadows for all visible segments
                else {
                    this._calculateFrameShadows(visibleOrder, numVisiblePositions, segments, segData, maxExtent, shadows, tints);
                }

                // Cache shadows/tints when rotation hasn't changed (for reuse on width/ortho changes)
                // Store rotation matrix after calculation
                this.lastShadowRotationMatrix = this._deepCopyMatrix(this.viewerState.rotation);

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
            const effectiveExtent = this.viewerState.extent || maxExtent;
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
            const scale = baseScale * this.viewerState.zoom;

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

                if (this.viewerState.perspectiveEnabled) {
                    const z = this.viewerState.focalLength - vec.z;
                    // Clamp z to prevent division by zero or negative values
                    // If z is too small, atom is too close to camera
                    if (z <= 0.1) {
                        screenValid[idx] = 0; // Mark invalid
                        return;
                    }
                    const perspectiveScale = this.viewerState.focalLength / z;
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
                        const tintFactor = (0.50 * tints[idx]) / 3;
                        r = r + (1 - r) * tintFactor;
                        g = g + (1 - g) * tintFactor;
                        b = b + (1 - b) * tintFactor;
                        const shadowFactor = (0.20 + 0.80 * shadows[idx]);
                        r *= shadowFactor; g *= shadowFactor; b *= shadowFactor;
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

                if (this.viewerState.perspectiveEnabled) {
                    // Apply perspective scaling to the segment width
                    // Calculate the average perspective scale for this segment
                    // based on the Z-coordinates of its endpoints
                    const vec1 = rotated[idx1];
                    const vec2 = rotated[idx2];
                    const z1 = this.viewerState.focalLength - vec1.z;
                    const z2 = this.viewerState.focalLength - vec2.z;
                    if (z1 <= 0.1 || z2 <= 0.1) continue;

                    // Average perspective scale for the segment
                    const avgPerspectiveScale = (this.viewerState.focalLength / z1 + this.viewerState.focalLength / z2) / 2;

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

                if (this.outlineMode !== 'none') {
                    // --- 2-STEP DRAW (Outline) ---
                    const totalOutlineWidth = currentLineWidth + this.relativeOutlineWidth;

                    // For zero-length segments, draw single outline circle
                    if (segInfo.idx1 === segInfo.idx2) {
                        const outlineRadius = totalOutlineWidth / 2;
                        ctx.beginPath();
                        ctx.arc(x1, y1, outlineRadius, 0, Math.PI * 2);
                        ctx.fillStyle = gapFillerColor;
                        ctx.fill();
                    } else {
                        // Pass 1: Gap filler outline (butt caps)
                        ctx.beginPath();
                        ctx.moveTo(x1, y1);
                        ctx.lineTo(x2, y2);
                        setCanvasProps(gapFillerColor, totalOutlineWidth, 'butt');
                        ctx.stroke();

                        // Add rounded caps at outer endpoints if full outline mode
                        if (this.outlineMode === 'full') {
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
                        }
                    }
                }

                // --- MAIN DRAW (Always) ---
                // Pass 2: Main colored line (always round caps)
                // For zero-length segments, draw explicit circle instead of relying on stroke caps
                if (segInfo.idx1 === segInfo.idx2) {
                    const radius = currentLineWidth / 2;
                    ctx.beginPath();
                    ctx.arc(x1, y1, radius, 0, Math.PI * 2);
                    ctx.fillStyle = color;
                    ctx.fill();
                } else {
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
            if (!this.isDragging && window.SEQ && window.SEQ.drawHighlights) {
                window.SEQ.drawHighlights();
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

        // Ensure the animation loop is running (without creating duplicates)
        ensureAnimationLoop() {
            if (this.animationFrameId !== null) return;
            this.animationFrameId = requestAnimationFrame(() => this.animate());
        }

        // Main animation loop
        animate() {
            let needsRender = false;

            // 1. Handle inertia/spin - disabled during recording, large molecules, or active drag
            if (!this.isRecording && !this.isDragging) {
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
                        this.viewerState.rotation = multiplyMatrices(rot, this.viewerState.rotation);
                        this.spinVelocityX *= 0.95; // Damping
                        needsRender = true;
                    } else {
                        this.spinVelocityX = 0;
                    }

                    if (Math.abs(this.spinVelocityY) > INERTIA_THRESHOLD) {
                        const rot = rotationMatrixX(this.spinVelocityY * 0.005);
                        this.viewerState.rotation = multiplyMatrices(rot, this.viewerState.rotation);
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

            // 2. Handle auto-rotate (skip while actively dragging)
            if (!this.isDragging && this.autoRotate && this.spinVelocityX === 0 && this.spinVelocityY === 0) {
                const rot = rotationMatrixY(0.005); // Constant rotation speed
                this.viewerState.rotation = multiplyMatrices(rot, this.viewerState.rotation);
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
                    // CRITICAL FIX: In overlay mode, DON'T call _loadFrameData - it would destroy merged data!
                    // In overlay mode, merged data is already loaded, so just render it
                    if (!this.overlayState.enabled && (this.coords.length === 0 || this.lastRenderedFrame === -1)) {
                        this._loadFrameData(currentFrame, true); // Load without render
                    }
                    needsRender = true;
                }

                // Keep scatter highlight in sync during playback
                if (this.scatterRenderer) {
                    this.scatterRenderer.currentFrameIndex = currentFrame;
                    this.scatterRenderer.render();
                }
            }

            // 4. Final render if needed
            if (needsRender) {
                this.render('animate loop');
                if (previousFrame !== currentFrame) {
                    this.lastRenderedFrame = currentFrame;
                }
            }

            // 5. Loop - keep animation alive even when dragging so playback continues
            this.animationFrameId = requestAnimationFrame(() => this.animate());
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

                // Download SVG directly
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

        // Generate filename from object name and current timestamp
        _generateFilename(objectName, extension) {
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            let name = objectName || 'viewer';
            name = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
            return `py2dmol_${name}_${timestamp}.${extension}`;
        }

        // Download video directly
        _downloadVideo(blob, filename) {
            this._triggerDownload(blob, filename);
        }

        // Download SVG directly

        _downloadSvg(svgString, objectName) {
            const filename = this._generateFilename(objectName, 'svg');
            const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            this._triggerDownload(blob, filename);
            if (typeof setStatus === 'function') {
                setStatus(`SVG exported to ${filename}`);
            }
        }

        // Helper to trigger browser download
        _triggerDownload(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
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

    // 1. Get config - check viewer-specific config first (Python), then global (web app)
    const baseConfig = window.viewerConfig || {};
    const initialViewerId = viewerId || baseConfig.viewer_id || containerElement?.id || null;
    const registryConfig = initialViewerId && window.py2dmol_configs ? window.py2dmol_configs[initialViewerId] : null;
    const config = normalizeConfig(registryConfig || baseConfig);

    // Resolve viewerId even when caller omits the second argument (standalone web app)
    const resolvedViewerId = viewerId
        || config.viewer_id
        || containerElement?.id
        || `py2dmol_${Math.random().toString(36).slice(2, 10)}`;
    config.viewer_id = resolvedViewerId;
    viewerId = resolvedViewerId;

    // Persist normalized config for any downstream consumers
    window.viewerConfig = config;

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
    const displayWidth = config.display?.size[0] || 300;
    const displayHeight = config.display?.size[1] || 300;

    const paeSize = Array.isArray(config.pae?.size) || (typeof config.pae?.size === 'object' && config.pae.size.length !== undefined)
        ? config.pae.size[0]
        : config.pae?.size || 300;
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

    // 3. Create renderer with viewer-specific config
    const renderer = new Pseudo3DRenderer(canvas, config);
    renderer.viewerId = viewerId;  // Store viewerId for config access

    // ADDED: ResizeObserver to handle canvas resizing
    const canvasContainer = containerElement.querySelector('#canvasContainer');
    const viewerWrapper = containerElement.querySelector('#viewerWrapper');
    const controlsContainer = containerElement.querySelector('#controlsContainer');

    // Set initial container dimensions to match canvas size
    // This prevents the container from shrinking when the window is closed/reopened
    if (canvasContainer) {
        canvasContainer.style.width = displayWidth + 'px';
        canvasContainer.style.height = displayHeight + 'px';
        if (viewerWrapper) {
            viewerWrapper.style.width = displayWidth + 'px';
        }
    }
    if (canvasContainer && window.ResizeObserver) {
        let resizeRaf = null;
        let lastWidth = displayWidth;
        let lastHeight = displayHeight;
        const resizeObserver = new ResizeObserver(entries => {
            if (!entries || entries.length === 0) return;
            let newWidth = Math.max(entries[0].contentRect.width, 1);
            let newHeight = Math.max(entries[0].contentRect.height, 1);

            if (Math.abs(newWidth - lastWidth) < 0.5 && Math.abs(newHeight - lastHeight) < 0.5) {
                return; // no meaningful change
            }
            lastWidth = newWidth;
            lastHeight = newHeight;

            const internalWidth = newWidth * currentDPR;
            const internalHeight = newHeight * currentDPR;

            canvas.width = internalWidth;
            canvas.height = internalHeight;
            canvas.style.width = newWidth + 'px';
            canvas.style.height = newHeight + 'px';
            if (viewerWrapper) {
                viewerWrapper.style.width = newWidth + 'px';
            }

            const ctx = canvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(currentDPR, currentDPR);

            renderer._updateCanvasDimensions();
            renderer.render('ResizeObserver');
        });

        // Start observing the canvas container
        resizeObserver.observe(canvasContainer);
    } else if (!window.ResizeObserver) {
        console.warn("py2dmol: ResizeObserver not supported. Canvas resizing will not work.");
    }

    // 4. Setup PAE Renderer (if enabled)
    // 4. Setup PAE Renderer (if enabled)
    if (config.pae?.enabled) {
        // Initialize immediately if PAE script is loaded
        const initPAE = () => {
            if (window.PAE && window.PAE.initialize) {
                window.PAE.initialize(renderer, containerElement, config);
            }
        };

        if (window.PAE) {
            initPAE();
        } else {
            // Wait for script
            window.addEventListener('py2dmol_pae_loaded', initPAE, { once: true });
        }
    }

    // Initialize scatter plot if enabled
    if (config.scatter && config.scatter.enabled) {
        try {
            const scatterContainer = containerElement.querySelector('#scatterContainer');
            const scatterCanvas = containerElement.querySelector('#scatterCanvas');

            if (scatterContainer && scatterCanvas) {
                // Apply size using the same pattern as the main viewer
                const scatterDisplaySize = config.scatter?.size || config.scatter_size || 300;
                const scatterDPR = Math.max(2, currentDPR * 2); // keep sharper DPI but mirror naming
                const showBox = config.display?.box !== false;

                // Intrinsic size (DPI scaled) + CSS size (display pixels)
                const borderAdjust = 2; // 1px border on each side
                const cssScatterSize = Math.max(10, scatterDisplaySize - borderAdjust);
                scatterCanvas.width = cssScatterSize * scatterDPR;
                scatterCanvas.height = cssScatterSize * scatterDPR;
                scatterCanvas.style.width = `${cssScatterSize}px`;
                scatterCanvas.style.height = `${cssScatterSize}px`;
                scatterCanvas.style.margin = '0px';

                // Container sizing mirrors main viewer containers
                scatterContainer.style.display = 'flex';
                scatterContainer.style.width = `${scatterDisplaySize}px`;
                scatterContainer.style.height = `${scatterDisplaySize}px`;
                scatterContainer.style.padding = '0px';

                // Box styling via CSS classes (kept unchanged)
                scatterContainer.classList.toggle('scatter-container', true);
                scatterContainer.classList.toggle('box-off', !showBox);

                // Mirror main viewer: observe container resizes and resize canvas accordingly
                if (scatterContainer && window.ResizeObserver) {
                    let lastWidth = scatterDisplaySize;
                    let lastHeight = scatterDisplaySize;
                    const resizeObserver = new ResizeObserver(entries => {
                        if (!entries || entries.length === 0) return;
                        const rect = entries[0].contentRect || {};
                        const newWidth = Math.max(rect.width || scatterDisplaySize, 1);
                        const newHeight = Math.max(rect.height || scatterDisplaySize, 1);

                        if (Math.abs(newWidth - lastWidth) < 0.5 && Math.abs(newHeight - lastHeight) < 0.5) {
                            return;
                        }
                        lastWidth = newWidth;
                        lastHeight = newHeight;

                        const innerW = Math.max(10, newWidth - borderAdjust);
                        const innerH = Math.max(10, newHeight - borderAdjust);
                        scatterCanvas.width = innerW * scatterDPR;
                        scatterCanvas.height = innerH * scatterDPR;
                        scatterCanvas.style.width = `${innerW}px`;
                        scatterCanvas.style.height = `${innerH}px`;

                        if (renderer.scatterRenderer) {
                            renderer.scatterRenderer.render();
                        }
                    });
                    resizeObserver.observe(scatterContainer);
                } else if (!window.ResizeObserver) {
                    console.warn("py2dmol: ResizeObserver not supported. Scatter resizing will not work.");
                }

                // Function to initialize scatter renderer
                const initializeScatterRenderer = () => {
                    if (!window.ScatterPlotViewer) {
                        return;
                    }

                    const scatterRenderer = new window.ScatterPlotViewer(scatterCanvas, renderer);
                    renderer.setScatterRenderer(scatterRenderer);

                    // Initialize with empty data (labels will be set when object metadata is available)
                    scatterRenderer.setData([], [], 'X', 'Y');

                    // Apply scatter_config from current object if it exists
                    if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                        const obj = renderer.objectsData[renderer.currentObjectName];
                        if (obj.scatterConfig) {
                            const cfg = obj.scatterConfig;
                            const xlabel = cfg.xlabel || 'X';
                            const ylabel = cfg.ylabel || 'Y';
                            scatterRenderer.setData([], [], xlabel, ylabel);

                            // Apply limits if provided
                            if (cfg.xlim && Array.isArray(cfg.xlim) && cfg.xlim.length === 2) {
                                scatterRenderer.xMin = cfg.xlim[0];
                                scatterRenderer.xMax = cfg.xlim[1];
                            }
                            if (cfg.ylim && Array.isArray(cfg.ylim) && cfg.ylim.length === 2) {
                                scatterRenderer.yMin = cfg.ylim[0];
                                scatterRenderer.yMax = cfg.ylim[1];
                            }
                            scatterRenderer.render(true);
                        }
                    }

                    // Collect scatter data from ALL frames in current object
                    if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                        const object = renderer.objectsData[renderer.currentObjectName];
                        const frames = object.frames || [];

                        // Get labels from object metadata
                        const cfg = object.scatterConfig || {};
                        const xlabel = cfg.xlabel || 'X';
                        const ylabel = cfg.ylabel || 'Y';
                        const xlim = cfg.xlim || null;
                        const ylim = cfg.ylim || null;


                        if (frames.length > 0) {
                            const xData = [];
                            const yData = [];

                            // Iterate through all frames to collect scatter points
                            let lastScatter = null;
                            for (let i = 0; i < frames.length; i++) {
                                const frame = frames[i];

                                // Resolve scatter with inheritance (like plddts, chains)
                                const scatterPoint = frame.scatter !== undefined ? frame.scatter : lastScatter;

                                if (scatterPoint && Array.isArray(scatterPoint) && scatterPoint.length === 2) {
                                    xData.push(scatterPoint[0]);
                                    yData.push(scatterPoint[1]);
                                    lastScatter = scatterPoint;
                                } else {
                                    // Frame has no scatter point - use NaN for gap
                                    xData.push(NaN);
                                    yData.push(NaN);
                                }
                            }

                            // Set accumulated data to scatter renderer
                            if (xData.length > 0) {
                                scatterRenderer.setData(xData, yData, xlabel, ylabel);

                                // Apply limits if provided
                                if (xlim && Array.isArray(xlim) && xlim.length === 2) {
                                    scatterRenderer.xMin = xlim[0];
                                    scatterRenderer.xMax = xlim[1];
                                }
                                if (ylim && Array.isArray(ylim) && ylim.length === 2) {
                                    scatterRenderer.yMin = ylim[0];
                                    scatterRenderer.yMax = ylim[1];
                                }

                                scatterRenderer.render();

                                // Show scatter container
                                scatterContainer.style.display = 'flex';
                            }
                        } else {
                            // No frames yet, but apply labels if scatter_config exists
                            scatterRenderer.setData([], [], xlabel, ylabel);

                            // Apply limits if provided
                            if (xlim && Array.isArray(xlim) && xlim.length === 2) {
                                scatterRenderer.xMin = xlim[0];
                                scatterRenderer.xMax = xlim[1];
                            }
                            if (ylim && Array.isArray(ylim) && ylim.length === 2) {
                                scatterRenderer.yMin = ylim[0];
                                scatterRenderer.yMax = ylim[1];
                            }

                            scatterRenderer.render(true);
                        }
                    }
                };

                // Try to initialize immediately (offline mode) or wait for scatter script load event
                requestAnimationFrame(() => {
                    if (window.ScatterPlotViewer) {
                        initializeScatterRenderer();
                    } else {
                        // Wait for scatter script to load (online mode)
                        window.addEventListener('py2dmol_scatter_loaded', initializeScatterRenderer, { once: true });
                    }
                });
            }
        } catch (e) {
            console.error("Failed to initialize scatter renderer:", e);
        }
    }

    // 5. Setup general controls
    const colorSelect = containerElement.querySelector('#colorSelect');

    // Initialize color mode
    let validModes = getAllValidColorModes();
    if (!renderer.colorMode || !validModes.includes(renderer.colorMode)) {
        renderer.colorMode = (config.color?.mode && validModes.includes(config.color.mode)) ? config.color.mode : 'auto';
    }
    // Sync dropdown to renderer's colorMode
    if (colorSelect && renderer.colorMode) {
        colorSelect.value = renderer.colorMode;
    }

    colorSelect.addEventListener('change', (e) => {
        const selectedMode = e.target.value;
        const validModes = getAllValidColorModes();

        if (validModes.includes(selectedMode)) {
            renderer.colorMode = selectedMode;
            renderer.colorsNeedUpdate = true;
            renderer.plddtColorsNeedUpdate = true;

            // Map entropy to structure if entropy mode is selected
            if (selectedMode === 'entropy' && renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName] && window.MSA) {
                renderer.entropy = window.MSA.mapEntropyToStructure(renderer.objectsData[renderer.currentObjectName], renderer.currentFrame >= 0 ? renderer.currentFrame : 0);
                renderer._updateEntropyOptionVisibility();
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

    // Setup colorblindCheckbox
    const colorblindCheckbox = containerElement.querySelector('#colorblindCheckbox');
    colorblindCheckbox.checked = renderer.colorblindMode; // Set default from renderer

    // 6. Setup animation and object controls
    const playButton = containerElement.querySelector('#playButton');
    const overlayButton = containerElement.querySelector('#overlayButton');
    // All buttons are within containerElement in both div and iframe modes
    const recordButton = containerElement.querySelector('#recordButton');
    const saveSvgButton = containerElement.querySelector('#saveSvgButton');
    const frameSlider = containerElement.querySelector('#frameSlider');
    const frameCounter = containerElement.querySelector('#frameCounter');
    // objectSelect is now in the sequence header, query from container
    const objectSelect = containerElement.querySelector('#objectSelect');
    const speedButton = containerElement.querySelector('#speedButton');
    const rotationCheckbox = containerElement.querySelector('#rotationCheckbox');
    const lineWidthSlider = containerElement.querySelector('#lineWidthSlider');
    const outlineWidthSlider = containerElement.querySelector('#outlineWidthSlider');
    const orthoSlider = containerElement.querySelector('#orthoSlider');
    const shadowSlider = containerElement.querySelector('#shadowSlider');


    // Set defaults for width, rotation, and shadow
    if (lineWidthSlider) lineWidthSlider.value = renderer.lineWidth;
    if (outlineWidthSlider) outlineWidthSlider.value = renderer.relativeOutlineWidth || 3.0;
    if (shadowSlider) shadowSlider.value = renderer.shadowStrength || 0.5;
    rotationCheckbox.checked = renderer.autoRotate;

    // Pass ALL controls to the renderer
    renderer.setUIControls(
        controlsContainer, playButton, overlayButton, recordButton, saveSvgButton,
        frameSlider, frameCounter, objectSelect,
        speedButton, rotationCheckbox, lineWidthSlider, outlineWidthSlider,
        shadowEnabledCheckbox, outlineModeButton, outlineModeSelect,
        colorblindCheckbox, orthoSlider, shadowSlider
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
    if (config.rendering?.ortho !== undefined && orthoSlider) {
        orthoSlider.value = normalizeOrthoValue(config.rendering.ortho);
        // The slider's input event will be triggered after data loads to set the correct focalLength
    }





    // Handle new UI config options
    if (!config.display?.controls) {
        const rightPanel = containerElement.querySelector('#rightPanelContainer');
        if (rightPanel) rightPanel.style.display = 'none';
        // controlsContainer is handled by updateUIControls
    }

    // Handle box
    if (!config.display?.box) {
        const canvasCont = containerElement.querySelector('#canvasContainer');
        if (canvasCont) {
            canvasCont.style.border = 'none';
            canvasCont.style.background = 'transparent';
        }
        if (canvas) canvas.style.background = 'transparent';

        // Also update PAE canvas if it exists
        if (config.pae?.enabled) {
            const paeCanvas = containerElement.querySelector('#paeCanvas');
            if (paeCanvas) {
                paeCanvas.style.border = 'none';
                paeCanvas.style.background = 'transparent';
            }
        }

        renderer.setClearColor(true);
    }

    // Snapshot persistence (sessionStorage)
    let lastIncrementalSeq = -1;

    // 7. Load initial data
    if ((window.py2dmol_staticData && window.py2dmol_staticData[viewerId]) && (window.py2dmol_staticData[viewerId]).length > 0) {
        // === STATIC MODE (from show()) ===
        try {
            for (const obj of (window.py2dmol_staticData && window.py2dmol_staticData[viewerId])) {
                // Create object even if no frames (for metadata like scatter_config)
                if (obj.name) {
                    // Ensure object exists in objectsData
                    if (!renderer.objectsData[obj.name]) {
                        renderer.addObject(obj.name);
                    }

                    // Store scatter config IMMEDIATELY after creating object
                    if (obj.scatter_config) {
                        renderer.objectsData[obj.name].scatterConfig = obj.scatter_config;
                    }
                }

                if (obj.name && obj.frames && obj.frames.length > 0) {

                    const staticChains = obj.chains; // Might be undefined
                    const staticPositionTypes = obj.position_types; // Might be undefined
                    const staticContacts = obj.contacts; // Might be undefined
                    const staticBonds = obj.bonds; // Might be undefined

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
                            residue_numbers: lightFrame.residue_numbers || undefined,  // Will default in setCoords
                            bonds: lightFrame.bonds || staticBonds || undefined,  // Bonds for connectivity
                            color: lightFrame.color || undefined,  // Frame-level color from Python
                            scatter: lightFrame.scatter || undefined  // Scatter point for this frame
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

                    // Store color overrides at object level if present
                    if (obj.color) {
                        if (renderer.objectsData[obj.name]) {
                            renderer.objectsData[obj.name].color = obj.color;
                            // Invalidate segment cache to ensure new colors are applied
                            renderer.cachedSegmentIndices = null;
                        }
                    }

                    // Store rotation matrix and center for view transform if present
                    if (obj.rotation_matrix && obj.center) {
                        if (renderer.objectsData[obj.name]) {
                            renderer.objectsData[obj.name].rotation_matrix = obj.rotation_matrix;
                            renderer.objectsData[obj.name].center = obj.center;

                            // Invalidate shadow cache since rotation affects shadows
                            renderer.cachedShadows = null;
                            renderer.lastShadowRotationMatrix = null;
                        }
                    }
                }
            }
            // Set view to the first frame of the first object
            if ((window.py2dmol_staticData && window.py2dmol_staticData[viewerId]) && window.py2dmol_staticData[viewerId].length > 0) {
                renderer.currentObjectName = (window.py2dmol_staticData && window.py2dmol_staticData[viewerId])[0].name;
                renderer.objectSelect.value = (window.py2dmol_staticData && window.py2dmol_staticData[viewerId])[0].name;

                // Populate entropy data from MSA if available
                const firstObjectName = (window.py2dmol_staticData && window.py2dmol_staticData[viewerId])[0].name;
                if (renderer.objectsData[firstObjectName]?.msa?.msasBySequence &&
                    renderer.objectsData[firstObjectName]?.msa?.chainToSequence && window.MSA) {
                    renderer.entropy = window.MSA.mapEntropyToStructure(renderer.objectsData[firstObjectName], 0);
                    renderer._updateEntropyOptionVisibility();
                }

                // Commit 7: In overlay mode, DON'T call setFrame - it would load individual frame data
                // Instead, just render the merged data that's already been loaded via auto-enable
                if (renderer.overlayState.enabled) {
                    renderer.currentFrame = 0;
                    renderer.render('staticLoad-overlay');
                } else {
                    renderer.setFrame(0);
                }
                // Update PAE container visibility after initial load
                // Use requestAnimationFrame to ensure PAE renderer is initialized
                requestAnimationFrame(() => {
                    if (window.PAE) {
                        window.PAE.updateVisibility(renderer);
                    }

                    // Update scatter with newly loaded config
                    if (renderer.scatterRenderer) {
                        renderer.updateScatterData(renderer.currentObjectName);
                    }

                    renderer.updateScatterContainerVisibility();
                });
            }
        } catch (error) {
            console.error("Error loading static object data:", error);
            renderer.setFrame(-1); // Start empty on error
        }

    } else if ((window.py2dmol_proteinData && window.py2dmol_proteinData[viewerId]) && (window.py2dmol_proteinData[viewerId]).coords && (window.py2dmol_proteinData[viewerId]).coords.length > 0) {
        // === HYBRID MODE (first frame) ===
        try {
            // Load the single, statically-injected frame into "0"
            renderer.addFrame((window.py2dmol_proteinData && window.py2dmol_proteinData[viewerId]), "0");
        } catch (error) {
            console.error("Error loading initial data:", error);
            renderer.setFrame(-1);
        }
    } else {
        // === EMPTY DYNAMIC MODE ===
        // No initial data, start with an empty canvas.
        renderer.setFrame(-1);
    }

    // Update scatter visibility after initial load (handles empty objects with scatter_config)
    if (renderer.scatterRenderer) {
        renderer.updateScatterContainerVisibility();
    }

    // After data load, trigger ortho slider to set correct initial focal length
    if (orthoSlider) {
        orthoSlider.dispatchEvent(new Event('input'));
    }


    // 12. Start the main animation loop
    renderer.animate();

    // 12b. Handle incremental state updates from Python (memory-efficient)
    const handleIncrementalStateUpdate = (newFramesByObject, changedMetadataByObject, seq = null) => {
        /**
         * Processes incremental updates sent from Python.
         * Python only sends NEW frames and CHANGED metadata to minimize data transfer.
         *
         * @param {Object} newFramesByObject - {"objectName": [newFrame1, newFrame2, ...]}
         * @param {Object} changedMetadataByObject - {"objectName": {color, contacts, bonds, ...}}
         * @param {number|null} seq - Optional sequence number for de-duplication
         */

        if (typeof seq === 'number') {
            if (seq <= lastIncrementalSeq) return;
            lastIncrementalSeq = seq;
        }

        // Create objects if they don't exist yet
        const newlyCreatedObjects = new Set();

        if (newFramesByObject) {
            for (const objectName of Object.keys(newFramesByObject)) {
                if (!renderer.objectsData[objectName]) {
                    renderer.addObject(objectName);
                    newlyCreatedObjects.add(objectName);
                }
            }
        }

        // Ensure objects exist when only metadata (e.g., scatter_config) arrives
        if (changedMetadataByObject) {
            for (const objectName of Object.keys(changedMetadataByObject)) {
                if (!renderer.objectsData[objectName]) {
                    renderer.addObject(objectName);
                    newlyCreatedObjects.add(objectName);
                }
            }
        }

        // Add new frames to each object
        if (newFramesByObject) {
            for (const [objectName, newFrames] of Object.entries(newFramesByObject)) {
                if (!newFrames || newFrames.length === 0) continue;

                // Python sends only NEW frames, so we just append them all
                for (const frame of newFrames) {
                    try {
                        renderer.addFrame(frame, objectName);
                    } catch (e) {
                        console.error(`Error adding frame to '${objectName}':`, e);
                    }
                }
            }

            // Invalidate shadow cache since new frames may have different geometry
            renderer._invalidateShadowCache();
            renderer.lastShadowRotationMatrix = null;

            // Update UI once after all frames added
            renderer.updateUIControls();

            // Update PAE container visibility once at end
            if (window.PAE) {
                window.PAE.updateVisibility(renderer);
            }

            // Update scatter plot if frames were added (may have scatter data)
            if (renderer.scatterRenderer && renderer.currentObjectName) {
                renderer.updateScatterData(renderer.currentObjectName);
                renderer.updateScatterContainerVisibility();
            }

            // Update UI controls to show/hide play button based on frame count
            renderer.updateUIControls();

            // Trigger render to update shadows and display new frame
            if (!renderer.isPlaying) {
                renderer.render('handleIncrementalStateUpdate');
            }
        }

        // Apply changed metadata fields
        if (changedMetadataByObject) {
            let needsRerender = false;

            for (const [objectName, changedFields] of Object.entries(changedMetadataByObject)) {
                const obj = renderer.objectsData[objectName];
                if (!obj) continue;

                // Apply each changed metadata field
                if (changedFields.color) {
                    obj.color = changedFields.color;
                    needsRerender = true;
                }
                if (changedFields.contacts) {
                    obj.contacts = changedFields.contacts;
                    needsRerender = true;
                }
                if (changedFields.bonds) {
                    obj.bonds = changedFields.bonds;
                    needsRerender = true;
                }
                if (changedFields.scatter_config) {
                    obj.scatterConfig = changedFields.scatter_config;
                    // Refresh scatter axes if this is the active object
                    if (objectName === renderer.currentObjectName && renderer.scatterRenderer) {
                        renderer.updateScatterData(objectName);
                        renderer.updateScatterContainerVisibility();
                    }
                }

                // Only apply rotation/center for newly created objects
                if (newlyCreatedObjects.has(objectName)) {
                    if (changedFields.rotation_matrix && obj.viewerState) {
                        obj.viewerState.rotation = changedFields.rotation_matrix;
                        needsRerender = true;
                    }
                    if (changedFields.center && obj.viewerState) {
                        obj.viewerState.center = changedFields.center;
                        needsRerender = true;
                    }
                }
            }

            // Invalidate caches and re-render if metadata changed
            if (needsRerender) {
                renderer.cachedSegmentIndices = null;
                renderer.cachedSegmentIndicesFrame = -1;
                renderer.cachedSegmentIndicesObjectName = null;
                renderer.setFrame(renderer.currentFrame);
            }
        }
    };

    // 12c. Handle replace-frame updates (overwrite latest frame)
    const handleReplaceFrame = (frame, meta = {}, objectName = null, seq = null) => {
        if (typeof seq === 'number') {
            if (seq <= lastIncrementalSeq) return;
            lastIncrementalSeq = seq;
        }

        const objName = objectName || renderer.currentObjectName || Object.keys(renderer.objectsData)[0] || '0';

        if (!renderer.objectsData[objName]) {
            renderer.addObject(objName);
        }
        const obj = renderer.objectsData[objName];

        // Reset frames and load single frame
        obj.frames = [];
        obj._lastPlddtFrame = -1;
        obj._lastPaeFrame = -1;
        renderer.addFrame(frame, objName);

        if (meta.color) obj.color = meta.color;
        if (meta.contacts) obj.contacts = meta.contacts;
        if (meta.bonds) obj.bonds = meta.bonds;
        if (meta.scatter_config) obj.scatterConfig = meta.scatter_config;

        renderer._invalidateShadowCache();
        renderer.lastShadowRotationMatrix = null;

        if (renderer.currentObjectName === objName) {
            if (renderer.scatterRenderer) {
                renderer.updateScatterData(objName);
                renderer.updateScatterContainerVisibility();
            }
            renderer.cachedSegmentIndices = null;
            renderer.cachedSegmentIndicesFrame = -1;
            renderer.cachedSegmentIndicesObjectName = null;
            renderer.setFrame(0);
        }
    };

    // 12c. Mailbox-based incremental delivery (single-slot, overwrite-only)
    const mailboxId = `py2dmol_live_${viewerId}`;
    let mailboxSeq = -1;

    const processMailbox = () => {
        const node = document.getElementById(mailboxId);
        if (!node) return;

        const raw = node.textContent || '';
        if (!raw.trim()) return;

        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (e) {
            console.error('py2Dmol mailbox JSON parse error', e);
            return;
        }

        const seq = typeof payload.seq === 'number' ? payload.seq : -1;
        if (seq <= mailboxSeq) return;
        mailboxSeq = seq;

        const frames = payload.frames || payload.new_frames || {};
        const meta = payload.meta || payload.changed_meta || {};
        handleIncrementalStateUpdate(frames, meta, seq);
    };

    const mailboxObserver = new MutationObserver(() => processMailbox());

    const startMailboxObserver = () => {
        const node = document.getElementById(mailboxId);
        if (!node) return false;
        mailboxObserver.disconnect();
        mailboxObserver.observe(node, { characterData: true, childList: true });
        processMailbox();
        return true;
    };

    // Observe document for mailbox creation/replacement (update_display swaps the node)
    const mailboxRootObserver = new MutationObserver(() => {
        startMailboxObserver();
    });
    mailboxRootObserver.observe(document.body, { childList: true, subtree: true });

    // Kick off once in case mailbox already exists
    startMailboxObserver();

    // 13. Expose Public API
    // Use viewerId parameter passed to function
    if (viewerId) {
        window.py2dmol_viewers[viewerId] = {
            handleIncrementalStateUpdate, // Primary: Memory-efficient incremental state updates
            handleReplaceFrame,
            renderer // Expose the renderer instance for external access
        };

        // BroadcastChannel for cross-iframe communication
        try {
            const channel = new BroadcastChannel(`py2dmol_${viewerId}`);
            const thisInstanceId = 'viewer_' + Math.random().toString(36).substring(2, 15);

            // Send viewerReady signal
            channel.postMessage({
                operation: 'viewerReady',
                sourceInstanceId: thisInstanceId
            });

            channel.onmessage = (event) => {
                const { operation, args, sourceInstanceId, seq } = event.data;

                // Ignore messages from this viewer instance (avoid echo)
                if (sourceInstanceId === thisInstanceId) return;

                if (operation === 'incrementalStateUpdate') {
                    // Unpack new frames and changed metadata from args
                    const [newFramesByObject, changedMetadataByObject] = args;
                    handleIncrementalStateUpdate(newFramesByObject, changedMetadataByObject, seq);
                } else if (operation === 'replaceFrame') {
                    const [frame, metaArg, objectName] = args;
                    handleReplaceFrame(frame, metaArg, objectName, seq);
                }
            };
        } catch (e) {
            // BroadcastChannel not supported
        }

    } else {
        console.error("py2dmol: viewer_id not found in config. Cannot register API.");
    }

} // <-- End of initializePy2DmolViewer
