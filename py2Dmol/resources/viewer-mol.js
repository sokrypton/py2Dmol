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

    /**
     * Linear gradients. Without these the cartoon renderer's `canGrad` guards
     * see no createLinearGradient and fall back to FLAT fills, so every
     * exported face and thickness band lost its shading - the SVG came out
     * noticeably flatter than the screen. Two stops is all the renderer ever
     * uses, but arbitrary stops cost nothing to support.
     */
    function SVGLinearGradient(x0, y0, x1, y1) {
        this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
        this.stops = [];
    }
    SVGLinearGradient.prototype.addColorStop = function (offset, color) {
        this.stops.push({ offset, color });
    };
    SVGLinearGradient.prototype.__isGradient = true;

    SimpleCanvas2SVG.prototype.createLinearGradient = function (x0, y0, x1, y1) {
        return new SVGLinearGradient(x0, y0, x1, y1);
    };

    // Path operations
    SimpleCanvas2SVG.prototype.beginPath = function () {
        this.currentPath = [];
    };

    // Coordinates are rounded to 0.01 px AT CAPTURE. Full doubles serialized
    // as 15+ digit strings were most of the file: a 1TIM export carried 115k
    // coordinates averaging ~17 characters each - over a third of 3.3 MB -
    // for precision no renderer can display.
    const r2 = (v) => Math.round(v * 100) / 100;

    SimpleCanvas2SVG.prototype.moveTo = function (x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'M', x: r2(x), y: r2(y) });
    };

    SimpleCanvas2SVG.prototype.lineTo = function (x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'L', x: r2(x), y: r2(y) });
    };

    SimpleCanvas2SVG.prototype.closePath = function () {
        // Was missing: any caller that closed a path threw during SVG export
        // ("ctx.closePath is not a function"). Emits the SVG 'Z' command, which
        // both stroke and fill below already pass through untouched.
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'Z' });
    };

    SimpleCanvas2SVG.prototype.arc = function (x, y, radius, startAngle, endAngle) {
        if (!this.currentPath) this.beginPath();
        // py2Dmol only uses full circles (0 to 2π)
        this.currentPath.push({ type: 'CIRCLE', x: r2(x), y: r2(y), radius: r2(radius) });
    };

    // Drawing operations
    SimpleCanvas2SVG.prototype.stroke = function () {
        if (!this.currentPath || this.currentPath.length === 0) return;

        let pathData = '';
        for (let i = 0; i < this.currentPath.length; i++) {
            const cmd = this.currentPath[i];
            if (cmd.type === 'M') pathData += `M ${cmd.x} ${cmd.y} `;
            else if (cmd.type === 'L') pathData += `L ${cmd.x} ${cmd.y} `;
            else if (cmd.type === 'Z') pathData += 'Z ';
        }

        this.operations.push({
            type: 'stroke',
            alpha: this.globalAlpha,
            pathData: pathData.trim(),
            strokeStyle: this.strokeStyle,
            lineWidth: r2(this.lineWidth),
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
                alpha: this.globalAlpha,
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
            else if (cmd.type === 'Z') pathData += 'Z ';
            }
            this.operations.push({
                type: 'fill',
                alpha: this.globalAlpha,
                pathData: pathData.trim(),
                fillStyle: this.fillStyle
            });
        }
        this.currentPath = null;
    };

    SimpleCanvas2SVG.prototype.fillRect = function (x, y, w, h) {
        // A full-canvas fill BEFORE any content is the background, not
        // content: recorded as an operation it ends up inside the pencil
        // filter's group, where its opaque alpha made SourceAlpha the whole
        // canvas and the grain covered the page instead of the structure.
        // The serializer emits its own background rect; keep only its colour.
        if (this.operations.length === 0 && x <= 0 && y <= 0
            && w >= this.width && h >= this.height) {
            this.backgroundFill = this.fillStyle;
            return;
        }
        this.operations.push({
            type: 'rect',
            alpha: this.globalAlpha,
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
    /**
     * Paint value -> SVG attribute. Gradients are registered in `defs` and
     * DEDUPED on their geometry and stops: a large structure emits tens of
     * thousands of quads and many repeat exactly, so without this the file
     * gains a separate <linearGradient> per quad.
     */
    function paintRef(value, defs, index) {
        if (!value || !value.__isGradient) return rgbToHex(value);
        const key = [value.x0, value.y0, value.x1, value.y1].map((v) => Math.round(v * 10) / 10)
            .join(',') + '|' + value.stops.map((s) => s.offset + ':' + rgbToHex(s.color)).join(',');
        let id = index[key];
        if (!id) {
            id = 'g' + defs.length;
            index[key] = id;
            defs.push('    <linearGradient id="' + id + '" gradientUnits="userSpaceOnUse"'
                + ' x1="' + value.x0.toFixed(2) + '" y1="' + value.y0.toFixed(2) + '"'
                + ' x2="' + value.x1.toFixed(2) + '" y2="' + value.y1.toFixed(2) + '">'
                + value.stops.map((s) => '<stop offset="' + s.offset + '" stop-color="'
                    + rgbToHex(s.color) + '"/>').join('')
                + '</linearGradient>');
        }
        return 'url(#' + id + ')';
    }

    SimpleCanvas2SVG.prototype.getSerializedSvg = function () {
        // Body first: walking the operations is what discovers which gradients
        // are used, and <defs> has to be emitted before them.
        const gradDefs = [];
        const gradIndex = {};
        let body = '';
        // opacity attribute, omitted at full strength so ordinary files are
        // unchanged by any of this
        const op_ = (op) => ((op.alpha === undefined || op.alpha >= 0.999)
            ? '' : ' opacity="' + Math.max(0, op.alpha).toFixed(3) + '"');
        for (let i = 0; i < this.operations.length; i++) {
            const op = this.operations[i];
            if (op.type === 'rect') {
                body += '  <rect x="' + op.x + '" y="' + op.y + '" width="' + op.width
                    + '" height="' + op.height + '" fill="'
                    + paintRef(op.fillStyle, gradDefs, gradIndex) + '"' + op_(op) + '/>\n';
            } else if (op.type === 'circle') {
                body += '  <circle cx="' + op.x + '" cy="' + op.y + '" r="' + op.radius
                    + '" fill="' + paintRef(op.fillStyle, gradDefs, gradIndex) + '"'
                    + op_(op) + '/>\n';
            } else if (op.type === 'stroke') {
                const cap = op.lineCap === 'round' ? 'round' : 'butt';
                body += '  <path d="' + op.pathData + '" stroke="'
                    + paintRef(op.strokeStyle, gradDefs, gradIndex)
                    + '" stroke-width="' + op.lineWidth + '" stroke-linecap="' + cap
                    + '" fill="none"' + op_(op) + '/>\n';
            } else if (op.type === 'fill') {
                body += '  <path d="' + op.pathData + '" fill="'
                    + paintRef(op.fillStyle, gradDefs, gradIndex) + '"' + op_(op) + '/>\n';
            }
        }

        // PENCIL GRAIN. The canvas path multiplies a noise tile over the frame
        // and masks it to the structure's alpha; SVG expresses the same thing
        // natively, so the export is not stuck with flat colour:
        //   feTurbulence        - fractal noise, the tile's octaves in one node
        //   feComponentTransfer - squeeze it into a narrow band near white, so
        //                         it reads as paper tooth rather than static
        //   feComposite in2="SourceAlpha" operator="in"
        //                       - the analogue of canvas 'destination-in':
        //                         grain only where the structure is, so the
        //                         paper stays clean
        //   feBlend mode="multiply" - how a pencil lays pigment down
        // Set by the cartoon renderer as ctx.pencilAmount.
        const grain = Number(this.pencilAmount) || 0;

        let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + this.width
            + '" height="' + this.height + '" viewBox="0 0 ' + this.width + ' '
            + this.height + '">\n';

        {
            svg += '  <defs>\n';
            // Everything renders through this clip. The canvas clips at its
            // own edge implicitly; without the equivalent here, strokes that
            // CROSS the border (kept whole, correctly) overhang the artboard
            // in editors like Illustrator/Inkscape, which show the pasteboard.
            svg += '    <clipPath id="py2dmolCanvas"><rect x="0" y="0" width="'
                + this.width + '" height="' + this.height + '"/></clipPath>\n';
            if (gradDefs.length) svg += gradDefs.join('\n') + '\n';
            if (grain > 0) {
                // Map the noise into a narrow band NEAR WHITE, matching the
                // canvas tile: mean slightly below 1 (a little darkening) with
                // a swing either side (the texture). Centring it on the noise's
                // own mean of 0.5 instead - the obvious first attempt -
                // multiplies everything by ~0.73, a flat wash with no grain.
                // Coefficients calibrated so the export matches the SCREEN,
                // measured with the same flat-interior grain metric on both;
                // feTurbulence and the canvas tile are different generators, so
                // equal parameters do not give equal results.
                const amp = 0.41 * grain;
                const centre = 1 - 0.09 * grain;
                const slope = amp.toFixed(3);
                const intercept = (centre - amp / 2).toFixed(3);
                // sRGB, not the linearRGB default: the canvas composites in
                // sRGB, and without this the exported grain differs visibly
                // from what is on screen.
                svg += '    <filter id="py2dmolPencil" x="0%" y="0%" width="100%"'
                    + ' height="100%" color-interpolation-filters="sRGB">\n';
                svg += '      <feTurbulence type="fractalNoise" baseFrequency="0.34"'
                    + ' numOctaves="3" seed="11" result="noise"/>\n';
                svg += '      <feColorMatrix in="noise" type="saturate" values="0" result="grey"/>\n';
                svg += '      <feComponentTransfer in="grey" result="paper">\n';
                svg += '        <feFuncR type="linear" slope="' + slope + '" intercept="' + intercept + '"/>\n';
                svg += '        <feFuncG type="linear" slope="' + slope + '" intercept="' + intercept + '"/>\n';
                svg += '        <feFuncB type="linear" slope="' + slope + '" intercept="' + intercept + '"/>\n';
                svg += '        <feFuncA type="discrete" tableValues="1"/>\n';
                svg += '      </feComponentTransfer>\n';
                svg += '      <feComposite in="paper" in2="SourceAlpha" operator="in" result="masked"/>\n';
                svg += '      <feBlend in="SourceGraphic" in2="masked" mode="multiply"/>\n';
                svg += '    </filter>\n';
            }
            svg += '  </defs>\n';
        }

        svg += '  <rect width="' + this.width + '" height="' + this.height
            + '" fill="' + rgbToHex(this.backgroundFill || '#ffffff') + '"/>\n';
        svg += '  <g clip-path="url(#py2dmolCanvas)">\n';
        if (grain > 0) svg += '  <g filter="url(#py2dmolPencil)">\n';
        svg += body;
        if (grain > 0) svg += '  </g>\n';
        svg += '  </g>\n';
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
    // Perspective is not a flag, it is what an ortho value below 1 MEANS. Read
    // through here so there is one definition; `ortho` missing (an old saved
    // state) reads as fully orthographic, which is what those sessions had.
    const isPerspective = (vs) => (vs && typeof vs.ortho === 'number')
        ? vs.ortho < 1
        : false;

    const LIGHTEN_FACTOR = 0.25;

    // Named color map for common color names
    // Selection indicator. The cartoon plugin has its own copy of the colour
    // (viewer-cartoon.js, SELECTION_INK_CSS) because it is a separate file
    // loaded independently; keep the two in step. The WIDTHS differ by design:
    // this style adds to its line width, the cartoon sets an absolute stroke,
    // hence EXTRA here and WIDTH there.
    // Click targets are sized from the tube stroke, but the cartoon draws a
    // ribbon several times wider; without this the fat parts of a helix are
    // not clickable. Kept modest so background clicks still deselect.
    const PICK_WIDTH_SCALE = 2.2;

    const SELECTION_INK_CSS = 'rgb(255, 190, 0)';
    const SELECTION_INK_EXTRA = 5;
    // SELECTION HALO. Painted as a translucent band OVER the finished drawing
    // rather than inked into the geometry, so it does not go behind anything.
    // The old indicator was part of the depth sort - a selected residue on the
    // far side of the molecule was hidden by everything in front of it, which
    // is exactly when you most need to see where it is.
    // The SAME yellow the sequence viewer uses for its hover highlight
    // (rgba(255,255,0) in viewer-seq.js), so pointing at a residue there and
    // selecting it here read as the same colour of feedback rather than two
    // different signals. Lower alpha than the hover: this one lies over the
    // structure and has to leave it legible, where hover marks bare canvas.
    // A side chain rides the ligand path but is part of its residue, so it is
    // drawn heavier than a ligand - and thinner than the backbone it hangs off,
    // so the backbone still reads as the main line.
    //
    // An ABSOLUTE baseline, on the same scale as TYPE_BASELINES ('P' is 1.0),
    // rather than a multiplier on the ligand's 0.4: this number is the thing
    // anyone would want to tune, and expressing it as a boost meant retuning
    // the LIGAND width would silently move side chains with it.
    const SIDECHAIN_WIDTH = 0.5;
    // A CONTACT IS ONE WIDTH IN BOTH STYLES, and does not follow the Line Width
    // control in either. That control sets how heavy the BACKBONE is drawn; a
    // contact is an annotation over the structure, and one that changed weight
    // with the backbone stopped reading as a separate mark.
    //
    // HALF of what tube used to draw at its widest: the Line Width slider tops
    // out at 4.7 and TYPE_BASELINES gives a contact half of that, so 2.35, and
    // half again is 1.175. That is what a weight of 1.0 means - full width for
    // a contact - and the per-contact slider only takes it down from there.
    //
    // viewer-cartoon.js carries the same number as CONTACT_WIDTH; the two are
    // checked against each other in tests/interaction.js, since a contact that
    // changes width when you switch style is exactly what this exists to stop.
    const CONTACT_WIDTH_A = 1.175;
    const SELECTION_HALO_CSS = 'rgba(255, 255, 0, 0.45)';
    // The hover MARK has no colour of its own: it is the selection band, drawn
    // over what the pointer is on. Only the readout needs one, and it follows
    // the paper rather than sitting on a plate of its own.
    const HOVER_TEXT_LIGHT_CSS = 'rgba(40, 40, 40, 0.9)';    // on white paper
    const HOVER_TEXT_DARK_CSS = 'rgba(235, 235, 235, 0.9)';  // on the 3d preset's black
    const HOVER_TEXT_MARGIN = 10;
    // How far toward the paper the clip box washes what it would cut. 0.75 is
    // "a quarter of its presence left" - enough to place a face against, not
    // enough to be mistaken for what is being kept.
    const CLIP_GHOST = 0.75;
    const CLIP_EDGE_CSS = 'rgba(37, 99, 235, 0.9)';       // the box
    const CLIP_FACE_CSS = 'rgba(37, 99, 235, 0.35)';      // its face handles
    const CLIP_HANDLE_PX = 7;                             // handle radius, screen px
    const CLIP_GRAB_PX = 14;                              // how near counts as a grab
    // Half-width in screen pixels at unit perspective, before the per-residue
    // radius is added. Wide enough to read as a band around the ribbon rather
    // than a line on it.
    const SELECTION_HALO_PX = 7;

    const namedColorsMap = {
        "red": "#ff0000", "green": "#00ff00", "blue": "#0000ff", "yellow": "#ffff00", "cyan": "#00ffff", "magenta": "#ff00ff",
        "orange": "#ffa500", "purple": "#800080", "pink": "#ffc0cb", "brown": "#8b4513", "gray": "#808080", "grey": "#808080",
        "white": "#ffffff", "black": "#000000", "lime": "#00ff00", "navy": "#000080", "teal": "#008080",
        "silver": "#c0c0c0", "maroon": "#800000", "olive": "#808000", "aqua": "#00ffff", "fuchsia": "#ff00ff"
    };

    // Swatches for the selection colour picker: the SAME colours chains are
    // drawn in, so the palette is the app's own vocabulary rather than a second
    // one to learn - pick "the green one" and you get the green chains are.
    // Follows colourblind mode for the same reason. Three neutrals are appended
    // because white/grey/black are constantly wanted and are not chain colours.
    // white / grey / black are constantly wanted and are not chain colours, so
    // they join the end of the same run rather than sitting in a row of their own.
    const PALETTE_NEUTRALS = ['#FFFFFF', '#808080', '#000000'];
    function getPaletteColors(colorblind) {
        const src = colorblind ? chainColorsColorblind : chainColors;
        const rgbToHex = (c) => '#' + [c.r, c.g, c.b]
            .map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
        const cells = src
            .map((c) => (typeof c === 'string' ? c : rgbToHex(c)))
            .concat(PALETTE_NEUTRALS);
        // One continuous grid. The row width is chosen so the last row is not a
        // near-empty stub - with 42 chain colours + 3 neutrals, 14 per row left a
        // single black swatch stranded on a row of its own.
        const perRow = Math.ceil(cells.length / Math.max(1, Math.round(cells.length / 15)));
        const rows = [];
        for (let i = 0; i < cells.length; i += perRow) rows.push(cells.slice(i, i + perRow));
        return rows;
    }
    window.py2dmol_paletteColors = getPaletteColors;

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

    // N-term (blue) to C-term (red/yellow); a CYCLIC chain goes all the way
    // round the wheel instead, so its two ends meet.
    function getRainbowColor(value, min, max, colorblind = false, cyclic = false) {
        if (max - min < 1e-6) return lightenColor(hsvToRgb(240, 1.0, 1.0)); // Default to blue
        if (cyclic && !colorblind) {
            // A ring has no first or last residue, but the ramp does: it runs
            // out of hue at the C-term and puts blue hard against red exactly
            // where the backbone closes, drawing a seam the structure does not
            // have. Going the full circle - blue, cyan, green, yellow, red,
            // magenta, back to blue - makes the colour as continuous as the
            // chain. The span is one residue LONGER than the chain so the step
            // from the last residue round to the first is the same size as
            // every other step, instead of landing on the same hue twice.
            let t = (value - min) / (max - min + 1);
            t = Math.max(0, Math.min(1, t));
            const hue = (240 - 360 * t + 360) % 360;
            return lightenColor(hsvToRgb(hue, 1.0, 1.0));
        }
        if (cyclic && colorblind) {
            // A dichromat has roughly TWO usable dimensions - luminance and the
            // blue-yellow axis - and the ordinary colourblind ramp is a LINE
            // along one of them. A line cannot close: running blue to yellow
            // and back would give every colour twice over. Hue alone therefore
            // cannot make a cyclic ramp that a dichromat can read.
            //
            // A closed LOOP in that plane can. Blue to yellow on the way out at
            // high lightness, yellow to blue on the way back at low lightness,
            // so position round the ring is (blue-yellow, light-dark) and every
            // point is unique. Simulated against deuteranopia, protanopia and
            // tritanopia, the closest pair more than a sixth of the ring apart
            // scores 0.105 / 0.130 / 0.041 - better on every axis than the
            // straight ramp this replaces (0.057 / 0.078 / 0.008), because the
            // loop uses a second dimension the line left idle. The amplitude
            // below is the measured optimum; more lightness helps tritanopes
            // and costs the far more common red-green cases.
            const th = 2 * Math.PI * Math.max(0, Math.min(1, (value - min) / (max - min + 1)));
            const u = (1 - Math.cos(th)) / 2;         // 0 blue -> 1 yellow -> 0 blue
            const L = 0.5 + 0.38 * Math.sin(th);      // out in the light, back in the dark
            const base = hsvToRgb(240 - 180 * u, 1.0, 1.0);
            let c;
            if (L >= 0.5) {
                const k = (L - 0.5) * 2 * 0.85;
                c = { r: base.r + (255 - base.r) * k,
                    g: base.g + (255 - base.g) * k,
                    b: base.b + (255 - base.b) * k };
            } else {
                const k = (0.5 - L) * 2 * 0.8;
                c = { r: base.r * (1 - k), g: base.g * (1 - k), b: base.b * (1 - k) };
            }
            return lightenColor({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
        }
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
                    if (typeof objLevelColor === 'string' && getAllValidColorModes().includes(objLevelColor.toLowerCase())) {
                        resolvedMode = objLevelColor.toLowerCase();
                    } else {
                        resolvedLiteralColor = objLevelColor;
                    }
                }

                // Check chain-level at object scope
                if (adv.chain && chainId && adv.chain[chainId]) {
                    const chainColor = adv.chain[chainId];
                    if (typeof chainColor === 'string' && getAllValidColorModes().includes(chainColor.toLowerCase())) {
                        resolvedMode = chainColor.toLowerCase();
                        resolvedLiteralColor = null;
                    } else {
                        resolvedLiteralColor = chainColor;
                    }
                }

                // Check position-level at object scope (highest priority)
                if (adv.position && adv.position[posIndex] !== undefined) {
                    const posColor = adv.position[posIndex];
                    if (typeof posColor === 'string' && getAllValidColorModes().includes(posColor.toLowerCase())) {
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
                        if (typeof frameLevelColor === 'string' && getAllValidColorModes().includes(frameLevelColor.toLowerCase())) {
                            resolvedMode = frameLevelColor.toLowerCase();
                            resolvedLiteralColor = null;
                        } else {
                            resolvedLiteralColor = frameLevelColor;
                        }
                    }

                    // === Level 3: Chain-level color ===
                    if (adv.chain && chainId && adv.chain[chainId]) {
                        const chainColor = adv.chain[chainId];
                        if (typeof chainColor === 'string' && getAllValidColorModes().includes(chainColor.toLowerCase())) {
                            resolvedMode = chainColor.toLowerCase();
                            resolvedLiteralColor = null;
                        } else {
                            resolvedLiteralColor = chainColor;
                        }
                    }

                    // === Level 4: Position-level color (highest priority) ===
                    if (adv.position && adv.position[posIndex] !== undefined) {
                        const posColor = adv.position[posIndex];
                        if (typeof posColor === 'string' && getAllValidColorModes().includes(posColor.toLowerCase())) {
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
            style: "tube",
            detail: 0.5,
            // thickness / cel / highlight / outline_tint / width / arrows /
            // pencil / sheet_flat are deliberately absent: they are resolved
            // per style in the renderer constructor (see PRESET_KEYS in
            // normalizeConfig), so a default here would override the preset.
            shadow: true,
            shadow_strength: 0.5,
            outline: "full",
            ortho: 0.5,
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
                box: cfg.display?.box ?? cfg.box ?? DEFAULT_CONFIG.display.box,
                background: cfg.display?.background ?? cfg.bg ?? 'white'
            },
            rendering: {
                style: cfg.rendering?.style ?? cfg.style ?? DEFAULT_CONFIG.rendering.style,
                detail: cfg.rendering?.detail ?? cfg.detail ?? DEFAULT_CONFIG.rendering.detail,
                shadow: cfg.rendering?.shadow ?? cfg.shadow ?? DEFAULT_CONFIG.rendering.shadow,
                shadow_strength: cfg.rendering?.shadow_strength ?? cfg.shadow_strength ?? DEFAULT_CONFIG.rendering.shadow_strength,
                outline: cfg.rendering?.outline ?? cfg.outline ?? DEFAULT_CONFIG.rendering.outline,
                ortho: cfg.rendering?.ortho ?? cfg.ortho ?? DEFAULT_CONFIG.rendering.ortho,
                detect_cyclic: cfg.rendering?.detect_cyclic ?? cfg.detect_cyclic ?? DEFAULT_CONFIG.rendering.detect_cyclic
            },
            color: {
                mode: colorMode || DEFAULT_CONFIG.color.mode,
                colorblind: cfg.color?.colorblind ?? cfg.colorblind ?? DEFAULT_CONFIG.color.colorblind,
                // named palette for the 'ss' colour mode; undefined = the
                // renderer's default palette (owned by viewer-cartoon.js)
                ss_palette: cfg.color?.ss_palette ?? cfg.ss_palette
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

        // Style-preset keys are passed through ONLY when the caller actually set
        // one. Substituting a default here would make every value look explicit
        // to the renderer, which resolves the per-style presets (richardson wants
        // thickness 0.7, width 2.0, a tinted outline, no cel banding) for exactly
        // the keys that were left out - so defaulting them silently flattened
        // richardson into cartoon for any caller who set only `style`.
        // arrows/pencil/sheet_flat additionally used to be dropped outright:
        // they were absent from this object, so view(arrows=False) never reached
        // the renderer at all.
        const PRESET_KEYS = ["thickness", "smooth", "highlight", "outline_tint", "width",
                             "arrows", "pencil", "sheet_flat", "fade"];
        // base_plates has ONE global default (on), owned by the renderer -
        // same pass-through-only-when-set rule as the preset keys.
        for (const key of [...PRESET_KEYS, "base_plates", "preset"]) {
            const value = cfg.rendering?.[key] ?? cfg[key];
            if (value !== undefined && value !== null) {
                normalized.rendering[key] = value;
            }
        }

        // Carry over any additional top-level keys not explicitly normalized
        const knownKeys = new Set(["viewer_id", "display", "rendering", "color", "pae", "scatter", "overlay", "size", "rotate", "autoplay", "controls", "box", "shadow", "outline", "ortho", "colorblind", "pae_size", "scatter_size", "detect_cyclic", "style", "detail", "base_plates", "ss_palette", "preset", ...PRESET_KEYS]);
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
                // seeded from the control, not hardcoded: a new object must not
                // silently discard the ortho setting the viewer is already on
                ortho: this.orthoSlider ? parseFloat(this.orthoSlider.value) : 1,
                focalLength: 200.0,
                center: null,
                extent: null,
                currentFrame: -1
            };

            // Render style: 'tube' (default segment pipeline below) or 'cartoon'
            // (secondary-structure cartoon; draw stage delegated to viewer-cartoon.js)
            const _st = config.rendering?.style;
            let _style = (_st === 'cartoon') ? 'cartoon' : 'tube';
            if (_style === 'cartoon' && !window.py2dmolCartoon) {
                // The plugin may simply not have been loaded yet (index.html
                // loads it after this file). Fall back to ribbon so the dropdown
                // never labels a ribbon "Cartoon", and take the requested style
                // as soon as the plugin announces itself. setStyle applies the
                // preset, so nothing is lost by deferring.
                this._pendingStyle = _style;
                _style = 'tube';
                window.addEventListener('py2dmol_cartoon_loaded', () => {
                    const want = this._pendingStyle;
                    this._pendingStyle = null;
                    if (want) this.setStyle(want);
                }, { once: true });
            }
            this.style = _style;
            // Richardson is the cartoon draw path with a per-SS profile preset.
            this.cartoonRichardson = (config.rendering?.preset === 'richardson');
            // Preset LABEL for the GUI dropdown; the concrete values arrive
            // as normal settings, so this only names them.
            // 'ribbon' (plain cartoon) is the default, and the only other
            // values are 'richardson' and '3d'. This used to fall back to
            // 'custom', a preset that was removed - leaving the dropdown with a
            // value it does not list.
            const _p = config.rendering?.preset;
            this.stylePreset = (_p === '3d' || _p === 'ribbon') ? _p : 'richardson';
            const th = Number(config.rendering?.thickness);
            // Richardson's per-SS thickness is a set of RATIOS scaled by this
            // control, so the global default of 0 (flat ribbons) would cancel
            // the preset and the style would appear to do nothing. Fall back to
            // the preset's own default instead - an explicit thickness, 0
            // included, is still honoured.
            const thDefault = this.cartoonRichardson ? 0.7 : 0;
            this.cartoonThickness = Number.isFinite(th) && th >= 0 ? th : thDefault;
            // arrows / pencil / sheet_flat are resolved here rather than left
            // undefined for viewer-cartoon.js to default: leaving them unset let
            // the sliders seed themselves from a different value than the draw
            // path was using, so the panel read 0.85 while the render was flat.
            this.cartoonArrows = config.rendering?.arrows !== false;
            // DNA/RNA base plates on/off (the Bases toggle); default on
            this.cartoonBasePlates = config.rendering?.base_plates !== false;
            const pc = Number(config.rendering?.pencil);
            this.cartoonPencil = Number.isFinite(pc) && pc >= 0
                ? Math.min(1, pc) : (this.cartoonRichardson ? 1 : 0);
            const sf = Number(config.rendering?.sheet_flat);
            this.cartoonSheetFlat = Number.isFinite(sf) && sf >= 0
                ? Math.min(1, sf) : (this.cartoonRichardson ? 1 : 0);
            // Cartoon sampling density; 0.5 = tuned default, lower = faceted
            // (and cheaper). Clamped again inside viewer-cartoon.js.
            const det = Number(config.rendering?.detail);
            // integer 1-4: subdivisions per helix residue at the floor
            this.cartoonDetail = Number.isFinite(det) && det > 0
                ? Math.min(8, Math.max(2, Math.round(det))) : 4;
            // depth fade toward the paper (the Fade slider); off by default
            const fd = Number(config.rendering?.fade);
            this.cartoonFade = Number.isFinite(fd) && fd >= 0
                ? Math.min(1, fd) : 0;
            // Cel shading: one flat tone per face per piece instead of the
            // smooth per-station gradient.
            // smooth = gradient shading; off = flat tone bands (cel)
            this.cartoonSmooth = (config.rendering?.smooth !== undefined)
                ? config.rendering.smooth === true
                : (this.style !== 'cartoon');
            // THE GPU PATH, off unless asked for. It changes how fast the
            // picture appears and not what the picture is, so it is a rendering
            // option like any other - and it is checked against WebGL2 at the
            // point of use rather than here, because a context can be lost long
            // after the viewer was built.
            this.cartoonGPU = config.rendering?.gpu === true;
            // Highlight gain: 0 = the old ceiling at the base colour, 1 = a
            // full lift toward white on faces pointing at the light.
            const hg = Number(config.rendering?.highlight);
            this.cartoonHighlight = Number.isFinite(hg) && hg >= 0
                ? hg : (this.cartoonRichardson ? 3.0 : 1.8);
            // Outline tint: 0 = black ink, 1 = ribbon mode's 0.7 colour tint.
            const ot = Number(config.rendering?.outline_tint);
            // Richardson outlines are a tint of the element colour (see
            // RICH_TINT_DEFAULT); an explicit value still wins.
            this.cartoonOutlineTint = Number.isFinite(ot) && ot >= 0
                ? Math.min(1, ot) : (this.cartoonRichardson ? 0.8 : 0);

            this.lineWidth = (typeof config.rendering?.width === 'number')
                ? config.rendering.width
                : (this.cartoonRichardson ? 2.0 : 3.0);
            // Width is a SHARED control - ribbon uses it too - so a style switch
            // has to decide whether to impose the new style's preset on it. The
            // rule is "until the user says otherwise": a switch adopts the
            // preset, and stops doing so once the Width slider has been dragged.
            // Keying this off the CONFIG instead was wrong: both shipped pages
            // and every py2Dmol.view() send a width whether or not anyone chose
            // it, so richardson kept ribbon's 3.0 while taking every other
            // preset value.
            this._lineWidthUserSet = false;
            // Same idea for THICKNESS, and for the ligand's sake. The plain
            // cartoon preset sets thickness 0 because a flat ribbon is the look
            // it means; a ligand stick at 0 is not a thinner stick, it is a
            // sheet. So a ligand falls back to the richardson default whenever
            // the 0 came from a preset rather than from the user - see
            // viewer-cartoon.js. Once the control has been touched, it is the
            // user's, 0 included.
            this._thicknessUserSet = false;
            this.relativeOutlineWidth = 3.0; // Default outline width relative to line width
            this.shadowIntensity = 0.95;

            // Set defaults from config, with fallback
            this.shadowEnabled = (typeof config.rendering?.shadow === 'boolean') ? config.rendering.shadow : true;
            // SHADE: the cartoon's directional shading (light + inner
            // shadow). Separate from 'shadow', which is the ribbon's
            // cast-shadow effect (and reserved for real cartoon shadows).
            // 0 = flat colour, 1 = full modelling. Was a boolean toggle; the
            // panel now exposes it as a slider, and 0 matches the old "off".
            this.cartoonShade = Number.isFinite(Number(config.rendering?.shade))
                ? Math.min(1, Math.max(0, Number(config.rendering.shade))) : 1;
            // page background: 'white' (default) or 'black'; the cartoon's
            // paper, fade target and base ink all derive from it
            this.backgroundColor = config.display?.background === 'black'
                ? '#000000' : '#ffffff';
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
            this.cyclicChains = new Set();   // chains whose backbone closes head to tail
            // Scale and centre of the last frame drawn, filled in by render().
            // A pan needs both to turn a drag in pixels into a shift in
            // Angstroms of viewerState.center.
            this._viewScale = null;
            this._viewCenter = null;
            this.segmentIndices = [];
            this.segData = [];
            this.colors = [];
            this.plddtColors = [];
            // Flags to track when color arrays need recalculation
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;

            // Allocation-free rendering
            // Pre-allocated arrays to replace Maps/Sets in render loop
            this.adjList = null;         // Array of arrays: adjList[posIdx] = [segIdx1, segIdx2, ...]
            this.segmentOrder = null;    // Int32Array: segmentOrder[segIdx] = renderOrderIndex
            this.segmentFrame = null;    // Int32Array: segmentFrame[segIdx] = frameId (last rendered frame)
            this.renderFrameId = 0;      // Counter for render frames to validate segmentFrame entries

            // Micro-optimizations
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
            // UNIFIED overlay state object
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
            // Set of position indices to SHOW; null means everything is
            // visible. Was called visibilityMask, which invited the wrong
            // mental model - it is not a per-residue boolean array.
            this.visiblePositions = null;
            // THE CLIP BOX, in MODEL space so it turns with the structure
            // instead of sliding over it. {min:[x,y,z], max:[x,y,z]}, or null
            // for "never set one". clipEditing means it is on screen and
            // draggable and everything outside it is ghosted; committing hands
            // the inside set to setVisibility, which is the same road Hide
            // takes, so save, copy and the sequence strip all follow with no
            // work of their own.
            this.clipBox = null;
            this.clipEditing = false;
            this.clipCommitted = false;
            this._clipVersion = 0;
            this.highlightedAtom = null; // To store position index for highlighting (property name kept for API compatibility)
            this.highlightedAtoms = null; // To store Set of position indices for highlighting multiple positions (property name kept for API compatibility)

            // Unified selection model (sequence/chain + PAE)
            // positions: Set of position indices (0, 1, 2, ...) - one position per entry in frame data
            // chains: Set of chain IDs (empty => all chains)
            // paeBoxes: Array of selection rectangles in PAE position space {i_start,i_end,j_start,j_end}
            // visibilityMode: 'default' = empty selection means "show all" (initial state)
            //                'explicit' = empty selection means "show nothing" (user cleared)
            // CLICK-SELECTION IS OFF UNLESS SOMETHING TURNS IT ON.
            //
            // The Python path loads viewer-mol.js and the cartoon plugin and
            // nothing else - no sequence strip, no selection panel - so a click
            // there changed a selection with no way to see it, act on it or
            // clear it except by clicking the background again. Selection is
            // done in Python by scripting, which does not go through the mouse.
            //
            // The web app turns it on when it wires the selection tools, so the
            // switch is owned by whoever can actually show the result.
            this.selectionEnabled = false;
            this.visibilityModel = {
                positions: new Set(), // Position indices: 0, 1, 2, ... (one position per entry in frame data)
                chains: new Set(),
                paeBoxes: [],
                visibilityMode: 'default' // Start in default mode (show all)
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
            this.saveImageButton = null;
            this.frameSlider = null;
            this.frameCounter = null;
            this.objectSelect = null;
            this.controlsContainer = null;
            this.speedButton = null;
            this.rotationCheckbox = null;
            this.lineWidthSlider = null;
            this.outlineWidthSlider = null;
            this.shadeSlider = null;
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

        // --- Unified Selection API ---
        setVisibility(patch, skip3DRender = false) {
            if (!patch) return;
            if (patch.positions !== undefined) {
                const a = patch.positions;
                this.visibilityModel.positions = (a instanceof Set) ? new Set(a) : new Set(Array.from(a || []));
            }
            if (patch.chains !== undefined) {
                const c = patch.chains;
                this.visibilityModel.chains = (c instanceof Set) ? new Set(c) : new Set(Array.from(c || []));
            }
            if (patch.paeBoxes !== undefined) {
                if (patch.paeBoxes === 'clear' || patch.paeBoxes === null) {
                    this.visibilityModel.paeBoxes = [];
                } else if (Array.isArray(patch.paeBoxes)) {
                    this.visibilityModel.paeBoxes = patch.paeBoxes.map(b => ({
                        i_start: Math.max(0, Math.floor(b.i_start ?? 0)),
                        i_end: Math.max(0, Math.floor(b.i_end ?? 0)),
                        j_start: Math.max(0, Math.floor(b.j_start ?? 0)),
                        j_end: Math.max(0, Math.floor(b.j_end ?? 0))
                    }));
                }
            }
            if (patch.visibilityMode !== undefined) {
                this.visibilityModel.visibilityMode = patch.visibilityMode;
            }

            // Normalize default mode: if in default mode with empty positions, populate with all positions
            // This ensures default mode always has positions filled, simplifying all selection logic
            if (this.visibilityModel.visibilityMode === 'default' &&
                (!this.visibilityModel.positions || this.visibilityModel.positions.size === 0)) {
                const n = this.coords ? this.coords.length : 0;
                this.visibilityModel.positions = new Set();
                for (let i = 0; i < n; i++) {
                    this.visibilityModel.positions.add(i);
                }
            }

            // Save selection state to current object whenever it changes
            if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                this.objectsData[this.currentObjectName].visibilityState = {
                    positions: new Set(this.visibilityModel.positions),
                    chains: new Set(this.visibilityModel.chains),
                    paeBoxes: this.visibilityModel.paeBoxes.map(box => ({ ...box })),
                    visibilityMode: this.visibilityModel.visibilityMode
                };
            }

            this._composeAndApplyMask(skip3DRender);
        }

        getVisibility() {
            const m = this.visibilityModel;

            // Normalize default mode: if in default mode with empty positions, populate with all positions
            // This ensures getVisibility() always returns positions populated for default mode
            let positions = new Set(m.positions);
            if (m.visibilityMode === 'default' && positions.size === 0) {
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
                visibilityMode: m.visibilityMode
            };
        }

        resetVisibility() {
            this.visibilityModel = {
                positions: new Set(),
                chains: new Set(),
                paeBoxes: [],
                visibilityMode: 'default'
            };
            this._composeAndApplyMask();
        }

        // Reset to default state: show all positions
        showAll() {
            // ...INCLUDING WHATEVER THE CLIP BOX WAS HOLDING BACK. Without
            // this the box is still committed, and the next frame re-derives
            // the mask from it - Show all would undo itself one frame later.
            this.clearClip();
            const n = this.coords ? this.coords.length : 0;
            if (n === 0) {
                this.resetVisibility();
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
            this.setVisibility({
                positions: allPositions,
                chains: allChains,
                paeBoxes: [],
                visibilityMode: 'default'
            });
        }

        // Clear all selections: show nothing (explicit mode)
        hideAll() {
            this.setVisibility({
                positions: new Set(),
                chains: new Set(),
                paeBoxes: [],
                visibilityMode: 'explicit'
            });
        }

        _composeAndApplyMask(skip3DRender = false) {
            const n = this.coords ? this.coords.length : 0;
            if (n === 0) {
                this.visiblePositions = null;
                if (!skip3DRender) {
                    this.render('_composeAndApplyMask: empty coords');
                }
                return;
            }

            // (1) Position/Chain contribution
            // Always compute position selection - it works together with PAE via UNION
            let allowedChains;
            if (this.visibilityModel.chains && this.visibilityModel.chains.size > 0) {
                allowedChains = this.visibilityModel.chains;
            } else {
                // All chains
                allowedChains = new Set(this.chains);
            }

            let seqPositions = null;
            if ((this.visibilityModel.positions && this.visibilityModel.positions.size > 0) ||
                (this.visibilityModel.chains && this.visibilityModel.chains.size > 0)) {
                seqPositions = new Set();

                // In overlay mode, selections are based on frame[0] indices but need to be expanded
                // to include corresponding positions from all frames in the merged array
                if (this.overlayState.enabled && this.overlayState.frameIdMap && this.visibilityModel.positions.size > 0) {
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
                    for (const selectedPos of this.visibilityModel.positions) {
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
                        if (this.visibilityModel.positions.size === 0 || this.visibilityModel.positions.has(i)) {
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
            if (this.visibilityModel.paeBoxes && this.visibilityModel.paeBoxes.length > 0) {
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
                    for (const box of this.visibilityModel.paeBoxes) {
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
                    for (const box of this.visibilityModel.paeBoxes) {
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
            const mode = this.visibilityModel.visibilityMode || 'default';
            const oldVisiblePositions = this.visiblePositions;
            if (combined && combined.size > 0) {
                // We have some selection - use it
                this.visiblePositions = combined;
            } else {
                // No selection computed
                if (mode === 'default') {
                    // Default mode: empty selection means "show all"
                    this.visiblePositions = null;
                } else {
                    // Explicit mode: empty selection means "show nothing"
                    this.visiblePositions = new Set(); // Empty set = nothing visible
                }
            }

            // Clear shadow cache when visibility changes (selection/deselection)
            // Visibility changes affect which segments are visible, so shadows need recalculation
            // Compare by reference and size (simple check - if different objects or different sizes, changed)
            const visibilityChanged = (
                oldVisiblePositions !== this.visiblePositions &&
                (oldVisiblePositions === null || this.visiblePositions === null ||
                    oldVisiblePositions.size !== this.visiblePositions.size)
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
                    document.dispatchEvent(new CustomEvent('py2dmol-visibility-change', {
                        detail: {
                            hasSelection: this.visiblePositions !== null && this.visiblePositions.size > 0,
                            visibilityModel: {
                                positions: Array.from(this.visibilityModel.positions),
                                chains: Array.from(this.visibilityModel.chains),
                                paeBoxes: this.visibilityModel.paeBoxes.map(b => ({ ...b })),
                                visibilityMode: this.visibilityModel.visibilityMode
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

        // Re-routed setResidueVisibility to use the new unified selection model
        setResidueVisibility(selection) {
            if (selection === null) {
                // Clear only PAE contribution; leave sequence/chain selections intact
                this.setVisibility({ paeBoxes: 'clear' });
            } else {
                const { i_start, i_end, j_start, j_end } = selection;
                this.setVisibility({ paeBoxes: [{ i_start, i_end, j_start, j_end }] });
            }
        }
        // [END PATCH]

        setupInteraction() {
            // Add inertia logic
            // HOVER READOUT. Moving over a residue names it in the same box the
            // sequence view uses (see setHoveredResidue in viewer-seq.js) rather
            // than growing a second tooltip beside it. Skipped while a gesture
            // is running: the pick is a per-move cost nobody is reading mid-drag.
            this.canvas.addEventListener('mousemove', (e) => {
                if (this.isDragging || this.isZooming) return;
                if (!(window.SEQ && window.SEQ.setHoveredResidue)) return;
                const i = this.pickResidueAt(e.clientX, e.clientY);
                if (i === this._hoverIdx) return;      // only on a change
                this._hoverIdx = i;
                if (i < 0) { window.SEQ.setHoveredResidue(null); return; }
                const num = this.residueNumbers && this.residueNumbers[i];
                window.SEQ.setHoveredResidue({
                    chain: (this.chains && this.chains[i]) || '?',
                    resName: (this.positionNames && this.positionNames[i]) || 'UNK',
                    resSeq: (num === undefined || num === null) ? i : num,
                });
            });
            this.canvas.addEventListener('mouseleave', () => {
                this._hoverIdx = -1;
                if (window.SEQ && window.SEQ.setHoveredResidue) {
                    window.SEQ.setHoveredResidue(null);
                }
            });

            this.canvas.addEventListener('mousedown', (e) => {
                if (e.target !== this.canvas) return;

                // A GRAB ON A CLIP FACE IS NOT A ROTATE. Tested first, because
                // the handle sits on top of the structure and every other
                // gesture here would otherwise claim the press.
                if (this.clipEditing && e.button === 0 && !e.metaKey && !e.ctrlKey) {
                    const r = this.canvas.getBoundingClientRect();
                    const face = this._clipFaceAt(e.clientX - r.left, e.clientY - r.top);
                    if (face && this._clipBeginDrag(face, e.clientX - r.left,
                        e.clientY - r.top)) {
                        e.preventDefault();
                        const move = (ev) => {
                            const rr = this.canvas.getBoundingClientRect();
                            if (this._clipDragTo(ev.clientX - rr.left, ev.clientY - rr.top)) {
                                this.render('clip drag');
                            }
                        };
                        const up = () => {
                            this._clipDrag = null;
                            window.removeEventListener('mousemove', move);
                            window.removeEventListener('mouseup', up);
                        };
                        window.addEventListener('mousemove', move);
                        window.addEventListener('mouseup', up);
                        return;
                    }
                }

                // PAN instead of rotate on the middle button, or Cmd/Ctrl with
                // the left - the same two gestures PyMOL uses. preventDefault
                // is needed for the middle button or the browser starts its own
                // autoscroll and swallows the drag.
                this.isPanning = (e.button === 1) || e.metaKey || e.ctrlKey;
                if (this.isPanning) e.preventDefault();

                this.isDragging = true;
                this.spinVelocityX = 0;
                this.spinVelocityY = 0;
                // press origin, so mouseup can tell a CLICK from a rotate-drag
                this._pressX = e.clientX;
                this._pressY = e.clientY;
                this.lastDragX = e.clientX;
                this.lastDragY = e.clientY;
                this.lastDragTime = performance.now();
                if (this.autoRotate) this._setAutoRotate(false);

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

                    if (this.isPanning) {
                        if (dx === 0 && dy === 0) return;
                        // MOVE THE ROTATION CENTRE, not the projection origin.
                        // The centre is the 3D point that lands at the middle of
                        // the canvas, so shifting it slides the structure while
                        // leaving the pivot where it was on screen: drag the
                        // structure left and the centre is now off to its right,
                        // and rotation, ortho and zoom all work about that
                        // point - which is what makes a pan useful for looking
                        // at one end of a long molecule.
                        //
                        // rotated = m . (v - c), and screen x/y are
                        // centre +- rotated * scale, so to move the drawing by
                        // (dx, dy) pixels the centre moves by
                        // -m^T . (dx/scale, -dy/scale, 0). m is a rotation, so
                        // its transpose is its inverse.
                        const sc = this._viewScale;
                        const c0 = this.viewerState.center || this._viewCenter;
                        const m = this.viewerState.rotation;
                        if (sc && c0 && m) {
                            const rx = dx / sc;
                            const ry = -dy / sc;
                            this.viewerState.center = {
                                x: c0.x - (m[0][0] * rx + m[1][0] * ry),
                                y: c0.y - (m[0][1] * rx + m[1][1] * ry),
                                z: c0.z - (m[0][2] * rx + m[1][2] * ry),
                            };
                        }
                        this.lastDragX = e.clientX;
                        this.lastDragY = e.clientY;
                        this.lastDragTime = now;
                        // no inertia on a pan: a thrown structure that keeps
                        // sliding is a nuisance to place precisely
                        this.spinVelocityX = 0;
                        this.spinVelocityY = 0;
                        this.render();
                        return;
                    }

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

                    const enableInertia = this._inertiaAllowed();

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
                    // cleared AFTER the canvas mouseup has run, which reads it to
                    // tell a pan from a selection click
                    setTimeout(() => { this.isPanning = false; }, 0);
                    window.removeEventListener('mousemove', handleMove);
                    window.removeEventListener('mouseup', handleUp);
                };

                window.addEventListener('mousemove', handleMove);
                window.addEventListener('mouseup', handleUp);
            });

            // Canvas-bound mouseup (fallback, but window listener handles it)
            // DOUBLE CLICK SELECTS THE WHOLE CHAIN. The single-click handler has
            // already selected the one residue by the time this fires, so this
            // widens that to its chain rather than starting from nothing.
            // SHIFT adds the chain to what is already selected, matching the way
            // shift extends a single-residue click - otherwise picking a second
            // chain would throw away the first.
            this.canvas.addEventListener('dblclick', (e) => {
                if (!this.selectionEnabled) return;
                if (e.target !== this.canvas) return;
                const i = this.pickResidueAt(e.clientX, e.clientY);
                if (i < 0 || !this.chains) return;
                const chain = this.chains[i];
                if (chain === undefined) return;
                // the two shift-clicks that precede this already toggled residue
                // i; the chain union covers it either way
                const next = e.shiftKey ? new Set(this.residueSelection || []) : new Set();
                for (let k = 0; k < this.chains.length; k++) {
                    if (this.chains[k] === chain) next.add(k);
                }
                this.setResidueSelection(next);
            });

            this.canvas.addEventListener('mouseup', (e) => {
                if (!this.isDragging) return;
                this.isDragging = false;

                // CLICK ON EMPTY BACKGROUND CLEARS THE SELECTION, the way
                // clicking the background deselects in PyMOL. Only a click, not
                // a rotate-drag, and only where nothing was hit - clicking the
                // structure itself leaves the selection alone rather than
                // clearing it out from under a tool the user is about to use.
                // A pan gesture is never a selection click, even if it happened
                // not to move: middle-click and Cmd-click mean "grab", not "pick".
                if (this.selectionEnabled
                    && e && this._pressX !== undefined && !this.isPanning) {
                    const moved = Math.hypot(e.clientX - this._pressX,
                        e.clientY - this._pressY);
                    if (moved < 4) {
                        const i = this.pickResidueAt(e.clientX, e.clientY);
                        if (i < 0) {
                            // empty background: deselect, as in PyMOL
                            this.clearResidueSelection();
                        } else if (e.shiftKey) {
                            // shift extends, as in PyMOL - otherwise a click
                            // replaces, so picking residues one at a time does
                            // not silently accumulate. A ligand toggles as ONE
                            // thing: already fully selected means remove it,
                            // anything less means take all of it.
                            const pick = this.pickGroupAt(i);
                            const next = new Set(this.residueSelection || []);
                            const whole = pick.every((k) => next.has(k));
                            for (const k of pick) {
                                if (whole) next.delete(k); else next.add(k);
                            }
                            this.setResidueSelection(next);
                        } else {
                            this.setResidueSelection(new Set(this.pickGroupAt(i)));
                        }
                    }
                }

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
                // COALESCE TO ONE RENDER PER FRAME. Wheel events are not
                // frame-aligned: a trackpad emits several per frame plus a
                // momentum tail, and rendering synchronously in each one
                // queued full renders back to back - which is why zooming
                // stuttered while rotating stayed smooth (mousemove IS
                // frame-aligned by the browser, so the drag path never had
                // this problem). The zoom factor still accumulates on every
                // event, so nothing about the zoom feel changes - only the
                // redundant renders between frames are dropped.
                if (!this._zoomRaf) {
                    this._zoomRaf = requestAnimationFrame(() => {
                        this._zoomRaf = null;
                        this.render();
                    });
                }
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
                    if (this.autoRotate) this._setAutoRotate(false);
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

                    const enableInertia = this._inertiaAllowed();

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
                    if (this.visiblePositions && this.segmentIndices) {
                        visibleSegmentCount = 0;
                        for (let i = 0; i < this.segmentIndices.length; i++) {
                            const seg = this.segmentIndices[i];
                            if (this.visiblePositions.has(seg.idx1) && this.visiblePositions.has(seg.idx2)) {
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
        setUIControls(controlsContainer, playButton, overlayButton, recordButton, saveImageButton, frameSlider, frameCounter, objectSelect, speedButton, rotationCheckbox, lineWidthSlider, outlineWidthSlider, outlineModeButton, outlineModeSelect, colorblindCheckbox, orthoSlider, shadowSlider) {
            this.controlsContainer = controlsContainer;
            this.playButton = playButton;
            this.overlayButton = overlayButton;
            this.recordButton = recordButton;
            this.saveImageButton = saveImageButton;
            this.frameSlider = frameSlider;
            this.frameCounter = frameCounter;
            this.objectSelect = objectSelect;
            this.speedButton = speedButton;
            this.rotationCheckbox = rotationCheckbox;
            this.lineWidthSlider = lineWidthSlider;
            this.outlineWidthSlider = outlineWidthSlider;
            this.outlineModeButton = outlineModeButton;
            this.outlineModeSelect = outlineModeSelect;
            this.colorblindCheckbox = colorblindCheckbox;
            this.orthoSlider = orthoSlider;
            this.shadowSlider = shadowSlider;
            this.lineWidth = this.lineWidthSlider ? parseFloat(this.lineWidthSlider.value) : (this.lineWidth || 3.0); // Read default from slider or use existing/default
            // ?? not ||, for the same reason as the slider sync below: with no
            // slider in the DOM (an embedded viewer with the controls hidden)
            // this is the only seed, and || would raise a deliberate 0 to 1.0.
            this.relativeOutlineWidth = this.outlineWidthSlider ? parseFloat(this.outlineWidthSlider.value) : (this.relativeOutlineWidth ?? 3.0);
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

            // A page may still supply a record button; recording now lives in
            // the Save panel, so its absence is the normal case and not a
            // warning. toggleRecording() stays public either way.
            if (this.recordButton) {
                this.recordButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleRecording();
                });
            }

            if (this.saveImageButton) {
                this._syncSaveButtonMode();
                this.saveImageButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // shift-click skips the panel and writes a PNG at whatever
                    // DPI was last used, for when the settings are already right
                    if (e.shiftKey) this.saveImage(this._saveOpts || { dpi: 300 });
                    else this._toggleSaveImagePanel(this.saveImageButton);
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
                this._syncSaveButtonMode();
                // Stop inertia if user clicks auto-rotate
                this.spinVelocityX = 0;
                this.spinVelocityY = 0;
            });

            if (this.lineWidthSlider) {
                this.lineWidthSlider.addEventListener('input', (e) => {
                    this.lineWidth = parseFloat(e.target.value);
                    // THE USER, NOT THE APP. This latch stops a style switch
                    // imposing its preset width (see _applyStyleDefaults), and
                    // it must only be tripped by an actual gesture.
                    //
                    // Restoring saved state sets the slider and dispatches a
                    // synthetic 'input' to push the value through - and this
                    // handler could not tell the two apart, so the latch closed
                    // on load and width never followed the preset again. That is
                    // richardson and 3d rendering at the same width while the
                    // panel truthfully reports the one number they share, even
                    // though their defaults are 2.0 and 3.0.
                    //
                    // isTrusted is false for any event dispatched from script
                    // and true only for one the browser raised from real input,
                    // which is exactly the distinction wanted here.
                    if (e.isTrusted) this._lineWidthUserSet = true;
                    if (!this.isPlaying) {
                        this.render('updateUIControls: lineWidthSlider');
                    }
                });
            }

            if (this.outlineWidthSlider) {
                this.outlineWidthSlider.addEventListener('input', (e) => {
                    const w = parseFloat(e.target.value);
                    this.relativeOutlineWidth = w;
                    // Width IS the outline switch: 0 turns it off. Skipped when a
                    // separate mode control exists, so such a page keeps its own
                    // none/partial/full behaviour.
                    if (!this.outlineModeButton && !this.outlineModeSelect) {
                        this.outlineMode = w > 0 ? 'full' : 'none';
                    }
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

                    // ORTHO IS THE STATE; there is no separate "perspective is
                    // on" flag to keep in step with it. One used to exist and
                    // could disagree with the slider - it was written only from
                    // here, so a value supplied by config or a restored session
                    // left the slider showing perspective while the projection
                    // stayed flat.
                    this.viewerState.ortho = normalizedValue;
                    if (normalizedValue >= 1.0) {
                        this.viewerState.focalLength = baseSize * PERSPECTIVE_MAX_MULT;
                    } else {
                        const multiplier = PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * normalizedValue;
                        this.viewerState.focalLength = baseSize * multiplier;
                    }

                    if (!this.isPlaying) {
                        this.render('orthoSlider');
                    }
                });
            }

            if (this.shadowSlider) {
                this.shadowSlider.addEventListener('input', (e) => {
                    const s = parseFloat(e.target.value);
                    this.shadowStrength = s;
                    // Strength IS the shadow switch: 0 turns it off. Skipped when a
                    // separate toggle exists. Cartoon reads only the on/off flag.
                    this.shadowEnabled = s > 0;
                    // Invalidate shadow cache to force recalculation with new strength
                    this._invalidateShadowCache();
                    if (!this.isPlaying) {
                        this.render('shadowSlider');
                    }
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
            this.shadeSlider, this.outlineModeButton, this.outlineModeSelect,
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
            // Everything the cartoon path derives from the unrotated coordinates
            // goes stale whenever segments do. All three caches are keyed on
            // object|frame|n|overlay, which a live-mode replace() leaves
            // untouched, so the key alone cannot catch a coordinate swap:
            //   _cartoonSec   secondary structure assignment
            //   _cartoonPair  nucleic base pairing
            //   _ssColorSec   SS assignment behind the 'ss' color mode
            //   _cartoonLadder / _cartoonSheet  beta ladders, and the strand
            //                 frames built on them
            this._cartoonSec = null;
            this._cartoonSecKey = null;
            this._cartoonPair = null;
            this._cartoonPairKey = null;
            this._cartoonLadder = null;
            this._cartoonLadderKey = null;
            this._cartoonSheet = null;
            this._cartoonSheetKey = null;
            this._ssColorSec = null;
            this._ssColorKey = null;
        }

        /**
         * Switch render style: 'tube' (the segment pipeline in this file) or
         * 'cartoon' (secondary-structure cartoon, drawn by viewer-cartoon.js).
         *
         * Those are the only two DRAW PATHS, and so the only two styles.
         * Richardson is not a third: it is the cartoon path driven by a
         * different per-SS profile, which makes it a PRESET (see setPreset).
         * It used to be a style value as well, which meant every consumer -
         * the dropdown, the panel row filter, the delegation check - carried a
         * special case reading "...or richardson" to undo the mistake.
         */
        setStyle(style) {
            if (style !== 'tube' && style !== 'cartoon') {
                console.warn(`Invalid style "${style}" - expected "tube" or "cartoon".`);
                return;
            }
            if (style === 'cartoon' && !window.py2dmolCartoon) {
                console.warn(`Style "${style}" requested but viewer-cartoon.js is not loaded.`);
                return;
            }
            if (this.style === style) return;
            // WILL THE CARTOON EVEN FIT?
            //
            // The cartoon build materialises prims, one object per face and an
            // edge table all at once, and that costs about 20 kB PER POSITION -
            // measured 339 MB for 4UG0's 17,544. A capsid is 313,236 positions,
            // so it would ask for 6.3 GB on top of the ~1.9 GB the structure
            // already occupies, against a 4.2 GB heap. It does not fail
            // gracefully: the tab dies, and a structure that took sixteen
            // seconds to load dies with it.
            //
            // So the switch is refused before anything is allocated. This is a
            // ceiling, not a fix - see GPU3D_NOTES - and cartoonForce bypasses
            // it for anyone who wants to find their own limit.
            if (style === 'cartoon' && !this.cartoonForce) {
                const fit = this._cartoonWouldFit();
                if (!fit.ok) {
                    console.warn('py2dmol: staying in tube style - the cartoon '
                        + 'build needs about ' + fit.needMB + ' MB for '
                        + fit.positions + ' positions and only ' + fit.freeMB
                        + ' MB of heap is left. Set renderer.cartoonForce = true '
                        + 'to try anyway.');
                    if (this.onStyleRefused) this.onStyleRefused(fit);
                    if (this.styleSelect && this.styleSelect.value !== this.style) {
                        this.styleSelect.value = this.style;
                    }
                    return;
                }
            }
            this.style = style;
            // The build-up is cartoon-only, so leaving cartoon leaves the mode
            // too - otherwise the save button goes on offering to record a
            // drawing this style cannot make.
            if (style !== 'cartoon' && this.drawMode) this.setDrawMode(false);
            if (style === 'cartoon') {
                // Entering the cartoon path lands on its default preset, which
                // is what actually decides the look.
                this.setPreset(this.stylePreset || 'richardson');
                return;
            }
            this.cartoonRichardson = false;
            // stylePreset is deliberately NOT touched: tube has no preset, and
            // clobbering it lost which cartoon preset to come back to, so
            // Cartoon -> Tube -> Cartoon landed somewhere else than it left.
            this._applyPresetBackground('ribbon');   // tube is drawn on paper
            this._applyStyleDefaults('tube');
            if (this.styleSelect && this.styleSelect.value !== style) {
                this.styleSelect.value = style;
            }
            if (this._syncStylePanel) this._syncStylePanel();
            this.render('setStyle');
        }

        /**
         * CAN A CARTOON BUILD FOR THIS STRUCTURE FIT IN THE HEAP THAT IS LEFT?
         *
         * THE FIGURE IS THE BUILD'S PEAK, not what it keeps. Those are very
         * different numbers and the distinction matters, because it is the
         * peak that kills the tab:
         *
         *   retained after a build      163 bytes per position
         *   peak during the build    ~14,000 bytes per position
         *
         * The build holds the captured 2D primitives, a face object per quad,
         * the per-piece rails and the normals all at once, and only the mesh
         * survives. An earlier version of this comment quoted 20 kB as the
         * RETAINED cost, measured by watching the heap after a build without
         * forcing a collection first - most of what it saw was garbage, and
         * `window.gc` is a no-op unless Chrome is started with
         * --js-flags=--expose-gc. Measure live data only after a real
         * collection.
         *
         * 14 kB/position is the large-structure figure (135,780 positions,
         * peak 2.0 GB). Small structures cost more per position because the
         * build has fixed overheads; erring high is the right way to err.
         *
         * performance.memory is Chrome-only and non-standard. Where it is
         * missing there is no way to ask how much room is left, so the test
         * falls back to a flat position count - chosen as what fits in a 4 GB
         * heap with a typical structure already in it.
         */
        _cartoonWouldFit() {
            const positions = (this.coords && this.coords.length) || 0;
            const needMB = Math.round(positions * 14000 / 1048576);
            const m = (typeof performance !== 'undefined') && performance.memory;
            if (!m || !m.jsHeapSizeLimit) {
                const CAP = 120000;
                return { ok: positions <= CAP, positions, needMB, freeMB: -1 };
            }
            const freeMB = Math.round(
                (m.jsHeapSizeLimit - m.usedJSHeapSize) / 1048576);
            // 0.8 of what is left: the build's peak is higher than its
            // residue, and a tab that survives the allocation only to die on
            // the next one has not been saved from anything.
            return { ok: needMB < freeMB * 0.8, positions, needMB, freeMB };
        }

        /**
         * Select a cartoon PRESET: 'richardson' (the default), 'ribbon' or '3d'.
         * Presets are starting points - the sliders stay live and editing them
         * simply diverges from the named values.
         *
         * This is where richardson lives. The preset owns three things: the
         * geometry profile (cartoonRichardson), the slider values
         * (STYLE_DEFAULTS), and the page background. A preset always implies
         * the cartoon style, so choosing one switches to it.
         *
         * 'ribbon' is the plain cartoon - smooth off, no slab thickness, ink on
         * - which IS STYLE_DEFAULTS.cartoon; it exists as a named preset so
         * there is a way back to plain cartoon after richardson or 3d.
         */
        setPreset(name) {
            if (name !== 'richardson' && name !== 'ribbon' && name !== '3d') {
                console.warn(`Invalid preset "${name}" - expected "richardson", "ribbon" or "3d".`);
                return;
            }
            if (!window.py2dmolCartoon) {
                console.warn(`Preset "${name}" requested but viewer-cartoon.js is not loaded.`);
                return;
            }
            this.style = 'cartoon';
            this.stylePreset = name;
            this.cartoonRichardson = (name === 'richardson');
            this._applyStyleDefaults(name === 'ribbon' ? 'cartoon' : name);
            this._applyPresetBackground(name);
            if (this.styleSelect && this.styleSelect.value !== 'cartoon') {
                this.styleSelect.value = 'cartoon';
            }
            if (this._syncStylePanel) this._syncStylePanel();
            this.render('setPreset');
        }

        /**
         * A preset carries its page background: '3d' is solid shaded geometry
         * and is meant to be seen on black, the other two are drawings on
         * paper. Applied as part of the preset rather than left to the user,
         * for the same reason the sliders are - a preset is a whole look.
         * Still just a starting point: the Dark toggle stays live afterwards.
         */
        _applyPresetBackground(name) {
            const want = (name === '3d') ? '#000000' : '#ffffff';
            if (this.backgroundColor === want) return;
            this.backgroundColor = want;
            const dark = this.containerElement
                ? this.containerElement.querySelector('#darkCheckbox')
                : (typeof document !== 'undefined' ? document.getElementById('darkCheckbox') : null);
            if (dark) dark.checked = (want === '#000000');
        }

        /**
         * Set every preset-controlled value to the given style's defaults and
         * sync the sliders. Values come from py2dmolCartoon.STYLE_DEFAULTS so
         * the renderer and the UI cannot disagree about what a style means.
         */
        _applyStyleDefaults(style) {
            const table = window.py2dmolCartoon && window.py2dmolCartoon.STYLE_DEFAULTS;
            const d = table && (table[style] || table.cartoon);
            if (!d) return;
            // Width is shared with ribbon, so it follows the style only until
            // the user takes it over (see _lineWidthUserSet).
            if (!this._lineWidthUserSet) this.lineWidth = d.width;
            this.cartoonThickness = d.thickness;
            this.cartoonOutlineTint = d.outlineTint;
            this.cartoonHighlight = d.highlight;
            this.cartoonSheetFlat = d.sheetFlat;
            this.cartoonPencil = d.pencil;
            if (d.smooth !== undefined) this.cartoonSmooth = d.smooth;
            // Every other style-owned control re-asserts too; anything left
            // out here inherits the previous style's slider silently -
            // invisible under richardson, whose panel hides the controls.
            if (d.outlineWidth !== undefined) {
                this.relativeOutlineWidth = d.outlineWidth;
                // width IS the outline switch (matches the slider handler):
                // the 3d preset's 0 must actually turn the ink off
                if (!this.outlineModeButton && !this.outlineModeSelect) {
                    this.outlineMode = d.outlineWidth > 0 ? 'full' : 'none';
                }
            }
            if (d.arrows !== undefined) this.cartoonArrows = d.arrows;
            if (d.detail !== undefined) this.cartoonDetail = d.detail;
            if (d.fade !== undefined) this.cartoonFade = d.fade;
            if (d.shade !== undefined) this.cartoonShade = d.shade;
            if (this._invalidateShadowCache) this._invalidateShadowCache();
            if (this._invalidateSegmentCache) this._invalidateSegmentCache();
            if (this._syncStyleControls) this._syncStyleControls();
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
                obj.visibilityState = {
                    positions: new Set(this.visibilityModel.positions),
                    chains: new Set(this.visibilityModel.chains),
                    paeBoxes: this.visibilityModel.paeBoxes.map(box => ({ ...box })),
                    visibilityMode: this.visibilityModel.visibilityMode
                };
                obj.viewerState = {
                    rotation: this._deepCopyMatrix(this.viewerState.rotation),
                    zoom: this.viewerState.zoom,
                    ortho: this.viewerState.ortho,
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
            // ... and drop the residue selection with it: the selection is a set
            // of position indices, meaningful only against the object it was
            // made on (see clearResidueSelection).
            if (this.currentObjectName !== newObjectName) this.clearResidueSelection();
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

            // Ensure object has visibilityState initialized
            if (!this.objectsData[newObjectName]) {
                this.objectsData[newObjectName] = {};
            }
            if (!this.objectsData[newObjectName].visibilityState) {
                this.objectsData[newObjectName].visibilityState = {
                    positions: new Set(),
                    chains: new Set(),
                    paeBoxes: [],
                    visibilityMode: 'default'
                };
            }

            // Get the correct coords length from the new object's first frame for normalization
            // This ensures normalization uses the correct size, not the previous object's coords
            newObject = this.objectsData[newObjectName];
            const firstFrame = newObject?.frames?.[0];
            const correctCoordsLength = firstFrame?.coords?.length || 0;

            // Restore selection state
            const savedState = this.objectsData[newObjectName].visibilityState;

            // Apply the saved selection directly to visibilityModel (bypassing setVisibility's normalization)
            this.visibilityModel.positions = new Set(savedState.positions);
            this.visibilityModel.chains = new Set(savedState.chains);
            this.visibilityModel.paeBoxes = savedState.paeBoxes.map(box => ({ ...box }));
            this.visibilityModel.visibilityMode = savedState.visibilityMode;

            // Only normalize if in default mode with empty positions, using correct coords length
            if (this.visibilityModel.visibilityMode === 'default' &&
                (!this.visibilityModel.positions || this.visibilityModel.positions.size === 0)) {
                this.visibilityModel.positions = new Set();
                for (let i = 0; i < correctCoordsLength; i++) {
                    this.visibilityModel.positions.add(i);
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

            // Save the restored selection state (setVisibility would do this, but we're bypassing it)
            if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                this.objectsData[this.currentObjectName].visibilityState = {
                    positions: new Set(this.visibilityModel.positions),
                    chains: new Set(this.visibilityModel.chains),
                    paeBoxes: this.visibilityModel.paeBoxes.map(box => ({ ...box })),
                    visibilityMode: this.visibilityModel.visibilityMode
                };
            }

            // Restore viewer state from new object (fallback to defaults if missing)
            const obj = this.objectsData[newObjectName];
            const saved = obj.viewerState || {
                rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                zoom: 1.0,
                // seeded from the control - see the first of these three defaults
                ortho: this.orthoSlider ? parseFloat(this.orthoSlider.value) : 1,
                focalLength: 200.0,
                center: null,
                extent: null,
                currentFrame: -1
            };
            this.viewerState = {
                rotation: this._deepCopyMatrix(saved.rotation),
                zoom: saved.zoom,
                // older saves carry the boolean instead; false meant orthographic
                ortho: (typeof saved.ortho === 'number') ? saved.ortho
                    : (saved.perspectiveEnabled ? 0.5 : 1),
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
                // Rebuild sequence view for the new object - after the paint,
                // since nothing the structure canvas draws depends on it
                (window.SEQ.buildViewDeferred || window.SEQ.buildView)();
            }

            // Focal length is derived from the ortho value AND the object's
            // size, so it cannot simply be carried across with the restored
            // viewer state - a saved 200 belongs to whatever object saved it.
            // Re-run the control, which is the one thing that knows how to turn
            // an ortho value into a focal length for the object now in view.
            if (this.orthoSlider) {
                this.orthoSlider.dispatchEvent(new Event('input'));
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
                    // Don't clear visibilityState - preserve it
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
                    visibilityState: {
                        positions: new Set(),
                        chains: new Set(),
                        paeBoxes: [],
                        visibilityMode: 'default'
                    },
                    viewerState: {
                        rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                        zoom: 1.0,
                        ortho: this.orthoSlider ? parseFloat(this.orthoSlider.value) : 1,
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
            // Use _enterOverlayMode instead of toggleOverlay for atomic state management
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
                this.clearResidueSelection();   // indices belong to the old object
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

            // First frame in: re-apply the Ortho slider, which sets both the
            // perspective flag and a focal length scaled to the object's size.
            // This used to be gated on perspective already being on, which was
            // circular - the slider is what turns it on. With the old default of
            // 1.0 (fully orthographic) that was invisible, but any default below
            // 1.0 never reached the renderer for the first object loaded: the
            // slider showed perspective while the view stayed flat.
            // Skip during batch loading to avoid unnecessary renders.
            if (object.frames.length === 1 && this.orthoSlider && !this._batchLoading) {
                this.orthoSlider.dispatchEvent(new Event('input'));
            }

            // If in overlay mode, re-merge to include the new frame
            // Skip re-merge if we just auto-enabled overlay on this frame (toggleOverlay already did it)
            if (this.overlayState.enabled && !this._batchLoading && !justAutoEnabledOverlay) {
                // Re-merge all frames when new frame added in overlay mode
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
        /**
         * Drop the residue selection and tell the UI. The selection is a set of
         * position indices, so it is only meaningful against the object it was
         * made on - anything that changes which object is current must clear it
         * rather than let stale indices be reinterpreted.
         */
        /**
         * Residue index under a client-space point, or -1 for empty background.
         *
         * Hit-tests the backbone SEGMENTS, not the residue centres. Testing
         * discs around each Ca leaves the chain a string of beads with gaps
         * between them - consecutive Ca are 3.8 A apart while the disc is a
         * quarter of the stroke width, so ~65% of the pixels the user can see
         * inked picked nothing at all. Clicks landed in the gaps and simply
         * did not register.
         *
         * FRONTMOST wins among everything under the cursor. Ranking candidates
         * by screen distance ignores depth, so a residue on the far side of the
         * molecule beats the one drawn on top of it - you would click what you
         * can see and get what is behind it. Depth decides first; screen
         * distance only separates candidates at equal depth.
         */
        pickResidueAt(clientX, clientY) {
            this._ensurePickProjection();
            if (!this.canvas || !this.screenX || !this.screenValid) return -1;
            const rect = this.canvas.getBoundingClientRect();
            const px = clientX - rect.left;
            const py = clientY - rect.top;
            const fid = this.screenFrameId;
            const rotated = this.rotatedCoords;
            const zOf = (i) => ((rotated && rotated[i]) ? rotated[i].z : 0);

            let best = -1;
            let bestZ = -Infinity;
            let bestD2 = Infinity;
            // WHICH SEGMENT WON, kept so a CONTACT can be picked as one thing.
            // The loop below already tests contact segments - it has to, or the
            // line would not be clickable at all - but it attributes the hit to
            // the nearer END, so clicking a contact selected one of its two
            // residues and the fact that it was a contact was thrown away.
            // Recording the winner lets pickGroupAt widen it to the pair.
            let bestSeg = null;
            // +z is toward the viewer (see Coordinate System)
            const offer = (idx, d2, z, seg) => {
                if (z > bestZ + 1e-6 || (Math.abs(z - bestZ) <= 1e-6 && d2 < bestD2)) {
                    bestZ = z; bestD2 = d2; best = idx; bestSeg = seg || null;
                }
            };

            // The drawn ribbon is wider than the picking radius, which is
            // derived from the tube stroke - widen the target so the fat parts
            // of a helix or a sheet arrow are clickable, but not so far that
            // clicking clear background stops deselecting.
            const PICK_W = PICK_WIDTH_SCALE;

            const segs = this.segmentIndices;
            if (segs) {
                for (let s = 0; s < segs.length; s++) {
                    const a = segs[s].idx1; const b = segs[s].idx2;
                    if (this.screenValid[a] !== fid || this.screenValid[b] !== fid) continue;
                    const ax = this.screenX[a]; const ay = this.screenY[a];
                    const bx = this.screenX[b]; const by = this.screenY[b];
                    const vx = bx - ax; const vy = by - ay;
                    const len2 = vx * vx + vy * vy;
                    // clamp to the segment: t outside [0,1] means the nearest
                    // point is an endpoint, which its own segment also covers
                    let t = len2 > 1e-9 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
                    if (t < 0) t = 0; else if (t > 1) t = 1;
                    const cxp = ax + vx * t; const cyp = ay + vy * t;
                    const dx = cxp - px; const dy = cyp - py;
                    const d2 = dx * dx + dy * dy;
                    const ra = Math.max(4, this.screenRadius[a]);
                    const rb = Math.max(4, this.screenRadius[b]);
                    const rad = (ra + (rb - ra) * t) * PICK_W;
                    if (d2 > rad * rad) continue;
                    // attribute the hit to the nearer end, and take the depth
                    // where the cursor actually is along the segment
                    offer(t < 0.5 ? a : b, d2, zOf(a) + (zOf(b) - zOf(a)) * t, segs[s]);
                }
            }

            // Positions no segment covers: chain termini, ligands, lone atoms.
            for (let i = 0; i < this.screenX.length; i++) {
                if (this.screenValid[i] !== fid) continue;
                const rad = Math.max(4, this.screenRadius[i]) * PICK_W;
                const dx = this.screenX[i] - px;
                const dy = this.screenY[i] - py;
                const d2 = dx * dx + dy * dy;
                if (d2 <= rad * rad) offer(i, d2, zOf(i));
            }

            // NUCLEIC BASE PLATES. A rung reaches several Angstrom off the
            // backbone, so the segment test above cannot see it: clicking a
            // plate missed, or picked whichever backbone was nearest. The
            // cartoon records one screen outline per HALF rung, each tagged
            // with its own residue, so a click selects the base it is actually
            // over rather than its partner across the pair.
            const naPick = this._naPick;
            if (naPick && naPick.length) {
                for (let k = 0; k < naPick.length; k++) {
                    const e = naPick[k];
                    const q = e.poly;
                    let inside = false;
                    for (let a2 = 0, b2 = q.length - 1; a2 < q.length; b2 = a2++) {
                        if (((q[a2][1] > py) !== (q[b2][1] > py))
                            && (px < (q[b2][0] - q[a2][0]) * (py - q[a2][1])
                                / (q[b2][1] - q[a2][1]) + q[a2][0])) {
                            inside = !inside;
                        }
                    }
                    if (inside) offer(e.res, 0, e.z);
                }
            }
            // Cleared unless a CONTACT won, so a later pick cannot inherit it.
            this._pickedContact = (bestSeg && bestSeg.type === 'C'
                && bestSeg.contactIdx1 !== undefined)
                ? [bestSeg.contactIdx1, bestSeg.contactIdx2] : null;
            return best;
        }

        /**
         * The positions a pick should really select. A residue is one thing to
         * click on, and so is a LIGAND - but a ligand is stored as loose atoms,
         * so picking one returns a single atom and selected one bond's worth of
         * it. Ligand groups are already known (the bonding search uses them), so
         * a pick inside one widens to the whole group; anything else is itself.
         */
        pickGroupAt(i) {
            if (i < 0) return [];
            // A CONTACT IS ONE THING TO CLICK, and what it names is the pair it
            // joins - selecting one end of it says nothing you did not already
            // know from where you clicked. Only when the contact is what was
            // actually hit: a click on a residue that happens to be a contact
            // endpoint is a click on the residue, and the segment test in
            // pickResidueAt has already decided which of the two was nearer.
            const pc = this._pickedContact;
            if (pc && (pc[0] === i || pc[1] === i)) return [pc[0], pc[1]];
            // A SIDE CHAIN IS PART OF ITS RESIDUE, not a molecule of its own.
            // It is stored as ligand positions so the ligand machinery draws it
            // (see _materialiseSidechains), but that is an implementation
            // detail and it must not leak into what a click means: clicking a
            // leucine's side chain has to select the leucine, so the sequence
            // strip highlights it and every selection tool acts on it. Falling
            // through to the ligand branch below would instead select the loose
            // atoms - which are not residues, so the sequence strip would show
            // nothing at all and the click would appear to do nothing.
            const sc = this.sidechainMap;
            if (sc && sc.has(i)) return [sc.get(i).owner];
            const types = this.positionTypes;
            if (types && types[i] !== 'L') return [i];   // a residue is itself
            // WHOLE MOLECULE = THE CONNECTED COMPONENT over ligand bonds. Not
            // the parsed ligand group: that exists only for ligands read out of
            // a structure file, and a ligand handed straight to add() has none,
            // so grouping by it would still select one atom there. Connectivity
            // is what "this molecule" means, and it is already computed.
            const segs = this.segmentIndices;
            if (segs && segs.length) {
                const adj = new Map();
                for (const s of segs) {
                    if (s.type !== 'L' || s.idx1 === s.idx2) continue;
                    if (!adj.has(s.idx1)) adj.set(s.idx1, []);
                    if (!adj.has(s.idx2)) adj.set(s.idx2, []);
                    adj.get(s.idx1).push(s.idx2);
                    adj.get(s.idx2).push(s.idx1);
                }
                if (adj.has(i)) {
                    const seen = new Set([i]);
                    const stack = [i];
                    while (stack.length) {
                        for (const nb of adj.get(stack.pop()) || []) {
                            if (seen.has(nb)) continue;
                            seen.add(nb); stack.push(nb);
                        }
                    }
                    return Array.from(seen);
                }
            }
            // a lone atom with no bonds still belongs to its parsed group
            const obj = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const groups = obj && obj.ligandGroups;
            if (groups && groups.size) {
                for (const members of groups.values()) {
                    if (members.indexOf(i) >= 0) return members.slice();
                }
            }
            return [i];
        }

        /**
         * The selection AS DRAWN: the residue selection, plus the side-chain
         * atoms of every selected residue.
         *
         * `residueSelection` stays residues and nothing else, because that is
         * what everything reading it expects - the sequence strip maps its
         * entries to rows, the selection tools act on them one residue at a
         * time, and the side-chain toggle asks whether its own set already
         * contains them. Putting loose atoms in there breaks all three.
         *
         * But the OUTLINE has to cover the side chain too, or selecting a
         * residue highlights its backbone and leaves the sticks growing out of
         * it unmarked - and worse, the two ways in disagree: clicking a side
         * chain would light up the ribbon and not the thing you clicked. Both
         * styles ink from this instead, so both agree however the selection was
         * made.
         *
         * Cached against the selection and the map it expands through, since it
         * is asked for on every frame and changes only when one of those does.
         */
        selectionInk() {
            const sel = (this.residueSelection && this.residueSelection.size)
                ? this.residueSelection : null;
            const sc = this.sidechainMap;
            if (!sel || !sc || !sc.size) return sel;
            if (this._selInkFor === sel && this._selInkMap === sc) return this._selInk;
            const out = new Set(sel);
            for (const [idx, e] of sc) {
                if (sel.has(e.owner)) out.add(idx);
            }
            this._selInkFor = sel;
            this._selInkMap = sc;
            this._selInk = out;
            return out;
        }

        /** Set the residue selection and tell every surface that draws it. */
        setResidueSelection(positions) {
            const next = (positions && positions.size) ? new Set(positions) : null;
            this.residueSelection = next;
            if (typeof document !== 'undefined') {
                document.dispatchEvent(new CustomEvent('py2dmol-residue-selection-change'));
            }
        }

        clearResidueSelection() {
            if (!this.residueSelection) return;
            this.residueSelection = null;
            if (typeof document !== 'undefined') {
                document.dispatchEvent(new CustomEvent('py2dmol-residue-selection-change'));
            }
        }

        // ====================================================================
        // CLIP BOX
        //
        // A box you drag around the part you want to keep. While it is being
        // edited everything outside it is ghosted rather than hidden, so you
        // can see what you are about to cut; turning it off commits, and the
        // outside becomes hidden through the ordinary visibility mask.
        //
        // Model space, not view space: the box belongs to the structure, so it
        // turns when the structure does and a face you set stays on the feature
        // you set it against.
        // ====================================================================

        /** A box round everything, with a little air - the starting point. */
        clipBoxDefault() {
            const n = this.coords ? this.coords.length : 0;
            if (!n) return null;
            let x0 = Infinity, y0 = Infinity, z0 = Infinity;
            let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
            for (let i = 0; i < n; i++) {
                const c = this.coords[i];
                if (c.x < x0) x0 = c.x; if (c.x > x1) x1 = c.x;
                if (c.y < y0) y0 = c.y; if (c.y > y1) y1 = c.y;
                if (c.z < z0) z0 = c.z; if (c.z > z1) z1 = c.z;
            }
            if (!(x1 >= x0)) return null;
            // AIR ROUND IT, so the default box contains the whole structure
            // rather than grazing its outermost atom - a box that starts by
            // clipping something is a box that starts by lying about itself.
            const pad = Math.max(2, 0.02 * Math.max(x1 - x0, y1 - y0, z1 - z0));
            return {
                min: [x0 - pad, y0 - pad, z0 - pad],
                max: [x1 + pad, y1 + pad, z1 + pad],
            };
        }

        /** Position indices inside the box; null when there is no box. */
        clipInsideSet(box = this.clipBox) {
            const n = this.coords ? this.coords.length : 0;
            if (!box || !n) return null;
            const [ax, ay, az] = box.min;
            const [bx, by, bz] = box.max;
            const out = new Set();
            for (let i = 0; i < n; i++) {
                const c = this.coords[i];
                if (c.x >= ax && c.x <= bx && c.y >= ay && c.y <= by
                    && c.z >= az && c.z <= bz) out.add(i);
            }
            return out;
        }

        /**
         * Turn the box on (show and edit it) or off (commit it).
         *
         * Committing writes the inside set as the visibility, which is the
         * mechanism Hide already uses - so a clip is undone by Show all, saved
         * with the object, and carried by Copy selection, none of which this
         * has to know about.
         */
        setClipEditing(on) {
            const want = !!on;
            if (want === this.clipEditing) return;
            if (want) {
                if (!this.clipBox) this.clipBox = this.clipBoxDefault();
                if (!this.clipBox) return;                 // nothing loaded yet
                this.clipEditing = true;
                this._clipVersion++;
                this.render('clip on');
                return;
            }
            this.clipEditing = false;
            this._clipDrag = null;
            this._clipVersion++;
            this.applyClip();
        }

        /** Hand the inside of the box to the visibility mask. */
        applyClip() {
            const inside = this.clipInsideSet();
            if (!inside) { this.render('clip off'); return; }
            this.clipCommitted = true;
            // 'explicit', because an empty inside means "nothing", not "all" -
            // a box dragged off the structure must show nothing, which is a
            // legible mistake, rather than silently showing everything.
            this.setVisibility({ positions: inside, visibilityMode: 'explicit' });
        }

        /**
         * A COMMITTED CLIP IS A BOX, NOT A LIST. The mask is position indices,
         * and the positions move when the frame does - so a clip applied on one
         * frame of a trajectory would keep cutting the residues that were in
         * the way THEN. Re-derived from the box whenever the frame changes.
         */
        _reapplyClipForFrame() {
            if (!this.clipCommitted || !this.clipBox || this.clipEditing) return;
            const inside = this.clipInsideSet();
            if (inside) {
                this.setVisibility({ positions: inside, visibilityMode: 'explicit' },
                    true);
            }
        }

        /** Forget the box and everything it did. */
        clearClip() {
            this.clipBox = null;
            this.clipEditing = false;
            this.clipCommitted = false;
            this._clipDrag = null;
            this._clipVersion++;
        }

        /**
         * The colour array with everything outside the box washed toward the
         * paper. Cached against the array it came from and the box's version,
         * so a still box uploads nothing on the GPU (which keys its recolour on
         * the array's identity) and a moving one uploads once per move.
         */
        _clipGhostColors(colors) {
            const key = this._clipVersion;
            if (this._clipTintFrom === colors && this._clipTintKey === key) {
                return this._clipTint;
            }
            const box = this.clipBox;
            const segs = this.segmentIndices;
            if (!box || !segs || segs.length !== colors.length) return colors;
            const [ax, ay, az] = box.min;
            const [bx, by, bz] = box.max;
            const paper = (this.backgroundColor === '#000000') ? 0 : 255;
            const K = CLIP_GHOST;
            const inBox = (i) => {
                const c = this.coords && this.coords[i];
                if (!c) return true;
                return c.x >= ax && c.x <= bx && c.y >= ay && c.y <= by
                    && c.z >= az && c.z <= bz;
            };
            const out = new Array(colors.length);
            for (let i = 0; i < colors.length; i++) {
                const c = colors[i];
                // A SEGMENT SPANS TWO POSITIONS and is ghosted only when BOTH
                // are outside: the one that straddles the face is half of what
                // is being kept, and washing it out frays the edge of the very
                // thing the box is holding on to.
                const seg = segs[i];
                const keep = inBox(seg.idx1) || inBox(seg.idx2);
                if (keep) { out[i] = c; continue; }
                out[i] = {
                    r: c.r + (paper - c.r) * K,
                    g: c.g + (paper - c.g) * K,
                    b: c.b + (paper - c.b) * K,
                };
            }
            this._clipTintFrom = colors;
            this._clipTintKey = key;
            this._clipTint = out;
            return out;
        }

        /**
         * The side-chain table, rewritten for an extracted sub-structure.
         *
         * The table is keyed by POSITION INDEX, and a copy renumbers every
         * position - so it can neither be dropped (the copy then has no side
         * chains at all, and asking for them does nothing) nor carried across
         * unchanged (its indices would name whichever residues happen to land
         * on those numbers). It has to be remapped.
         *
         * A row needs BOTH its residue and its anchor to survive: the
         * coefficients are expressed in the anchor's backbone frame, and
         * without that residue there is no frame to rebuild them in. At the
         * edge of a selection an anchor can fall outside it, so a residue on
         * the boundary may come across without its side chain. That is honest -
         * the alternative is re-anchoring it to a frame the coefficients were
         * never measured against, which would point the side chain somewhere
         * arbitrary.
         *
         * @param {object} sc - the source table, or null
         * @param {Array<number>} selectedIndices - old indices, ascending
         * @returns {object|null} the remapped table
         */
        /**
         * Carry an object's DISPLAY STATE onto a copy of part of it.
         *
         * The frame arrays are extracted position by position; this is
         * everything else - the per-object state that says which of those
         * positions are drawn with a side chain, which carry an element
         * colouring, which nucleotides show a base, what secondary structure
         * has been forced on them, what colour they and their side chains were
         * given, and which pairs are joined by a contact. All of it is
         * keyed by POSITION INDEX, so a copy has to renumber it exactly the
         * way the side-chain table is renumbered, and drop whatever fell
         * outside the selection.
         *
         * None of it used to be carried at all: copying a selection you had
         * just posed - side chains out, coloured, bases showing - produced a
         * bare backbone, because a new object starts with none of these keys
         * and nothing filled them in.
         *
         * EVERY FIELD IS NAMED HERE. That is the trap this file keeps falling
         * into (see extractedFrame, and frameObj in web/app.js): a state
         * carried field by field silently drops whatever nobody wrote down.
         * `tests/copy_selection.js` sets all of them and checks each one
         * survives - and separately walks the source for per-object keys that
         * nobody copies, so a new one added without a line here fails there.
         */
        _remapObjectState(src, dst, selectedIndices) {
            if (!src || !dst) return;
            const renumber = new Map();
            for (let i = 0; i < selectedIndices.length; i++) {
                renumber.set(selectedIndices[i], i);
            }
            // position sets: sidechains, elements, bases
            for (const key of ['sidechains', 'elements', 'bases']) {
                const set = src[key];
                if (!(set instanceof Set)) continue;
                const out = new Set();
                for (const i of set) {
                    const to = renumber.get(i);
                    if (to !== undefined) out.add(to);
                }
                // An empty result is NOT the same as absent for every one of
                // these - null means ALL for bases and elements and NONE for
                // side chains - so an empty set is stored as empty rather than
                // collapsed to null, which would invert two of the three.
                dst[key] = out;
            }
            // forced secondary structure: position -> letter
            if (src.sse) {
                const out = {};
                for (const k of Object.keys(src.sse)) {
                    const to = renumber.get(Number(k));
                    if (to !== undefined) out[to] = src.sse[k];
                }
                dst.sse = Object.keys(out).length ? out : null;
            }
            // COLOUR. Only the `position` map inside it is keyed by index; the
            // rest of the structure - an object-wide mode or literal the
            // per-residue colours sit on top of - is not, and is carried
            // through untouched so a copy keeps the same base to override.
            if (src.color) {
                if (src.color.type === 'advanced' && src.color.value) {
                    const value = { ...src.color.value };
                    if (value.position) {
                        const out = {};
                        for (const k of Object.keys(value.position)) {
                            const to = renumber.get(Number(k));
                            if (to !== undefined) out[to] = value.position[k];
                        }
                        if (Object.keys(out).length) value.position = out;
                        else delete value.position;
                    }
                    dst.color = Object.keys(value).length
                        ? { type: 'advanced', value } : null;
                } else {
                    // a mode or a literal applies to the whole object either way
                    dst.color = src.color;
                }
            }
            // per-residue side-chain colour, keyed by owner position
            if (src.sidechainColor) {
                const out = {};
                for (const k of Object.keys(src.sidechainColor)) {
                    const to = renumber.get(Number(k));
                    if (to !== undefined) out[to] = src.sidechainColor[k];
                }
                dst.sidechainColor = Object.keys(out).length ? out : null;
            }
            // contacts come in two shapes. [i, j, w, colour?] is indices and
            // renumbers; [chain, res, chain, res, w, colour?] names residues
            // and survives a copy untouched - but only if both of its ends
            // came with it, or it resolves to nothing on every frame load and
            // warns to the console for the life of the object.
            if (Array.isArray(src.contacts) && src.contacts.length) {
                const kept = [];
                const survives = new Set();
                for (const i of selectedIndices) {
                    const chain = this.chains && this.chains[i];
                    const res = this.residueNumbers && this.residueNumbers[i];
                    if (chain !== undefined && res !== undefined) survives.add(chain + ':' + res);
                }
                for (const c of src.contacts) {
                    if (!Array.isArray(c)) continue;
                    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
                        const a = renumber.get(c[0]);
                        const b = renumber.get(c[1]);
                        if (a === undefined || b === undefined) continue;
                        kept.push([a, b, ...c.slice(2)]);
                    } else if (typeof c[0] === 'string' && c.length >= 4) {
                        if (!survives.has(c[0] + ':' + c[1])) continue;
                        if (!survives.has(c[2] + ':' + c[3])) continue;
                        kept.push(c.slice());
                    }
                }
                dst.contacts = kept.length ? kept : null;
            }
        }

        _remapSidechains(sc, selectedIndices, srcCoords, dstCoords) {
            if (!sc || !sc.pos || !sc.pos.length) return null;
            const renumber = new Map();
            for (let i = 0; i < selectedIndices.length; i++) {
                renumber.set(selectedIndices[i], i);
            }
            // THE FRAME A COEFFICIENT IS EXPRESSED IN MAY NOT EXIST IN THE COPY,
            // and where it does exist it may not be the SAME frame: it is built
            // from the anchor's neighbours, and a selection with a gap in it
            // puts a different residue next door. Both cases used to go
            // unnoticed - the rows were carried across with their numbers
            // renumbered and their coefficients untouched, so a copy of one
            // residue drew no side chain at all (measured: 3 rows in the table,
            // 0 atoms on screen), four residues drew one of four, and two runs
            // of three drew five of thirteen.
            //
            // So each row is taken back to a world offset using the frame it
            // was built in, and then put into whichever frame the copy can
            // actually build at that anchor - or left as a world offset, with
            // anchor -1, when the copy can build none.
            // BOTH coordinate arrays are required, and deliberately not
            // defaulted: the whole job here is comparing the frame the copy can
            // build against the one the source had, and a caller that passed
            // neither would get a table that renumbers cleanly and draws
            // nothing - which is the bug this exists to fix.
            const localFrame = window.py2dmolCartoon && window.py2dmolCartoon.localFrame;
            const nSrc = srcCoords.length;
            const nDst = dstCoords.length;
            const srcAt = (i) => ({ x: srcCoords[i][0], y: srcCoords[i][1], z: srcCoords[i][2] });
            const dstAt = (i) => ({ x: dstCoords[i][0], y: dstCoords[i][1], z: dstCoords[i][2] });
            const fbuf = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            const frameCache = new Map();
            const frameIn = (which, i) => {
                const key = which + i;
                if (!frameCache.has(key)) {
                    const at = which === 's' ? srcAt : dstAt;
                    const n = which === 's' ? nSrc : nDst;
                    frameCache.set(key,
                        (localFrame && localFrame(at, n, i, fbuf, null)) ? fbuf.slice() : null);
                }
                return frameCache.get(key);
            };
            const pos = []; const frameOf = []; const coef = [];
            const names = []; const elements = [];
            const rowOf = new Map();          // old table row -> new table row
            for (let k = 0; k < sc.pos.length; k++) {
                const owner = renumber.get(sc.pos[k]);
                if (owner === undefined) continue;
                const srcAnchor = sc.frameOf[k];
                const dstAnchor = renumber.get(srcAnchor);
                const fSrc = frameIn('s', srcAnchor);
                if (!fSrc) continue;                  // unframable at source: it was never drawn
                const cx = sc.coef[k * 3];
                const cy = sc.coef[k * 3 + 1];
                const cz = sc.coef[k * 3 + 2];
                // the atom's offset from its anchor, in world axes
                const wx = fSrc[0] * cx + fSrc[3] * cy + fSrc[6] * cz;
                const wy = fSrc[1] * cx + fSrc[4] * cy + fSrc[7] * cz;
                const wz = fSrc[2] * cx + fSrc[5] * cy + fSrc[8] * cz;
                const fDst = dstAnchor === undefined ? null : frameIn('d', dstAnchor);
                rowOf.set(k, pos.length);
                pos.push(owner);
                if (fDst) {
                    frameOf.push(dstAnchor);
                    // world offset back into the copy's own frame
                    coef.push(fDst[0] * wx + fDst[1] * wy + fDst[2] * wz,
                        fDst[3] * wx + fDst[4] * wy + fDst[5] * wz,
                        fDst[6] * wx + fDst[7] * wy + fDst[8] * wz);
                } else {
                    // no frame in the copy: keep it as a world offset from the
                    // OWNER, which is the one position this row is certain of
                    const anchorPos = srcAt(srcAnchor);
                    const ownerPos = srcAt(sc.pos[k]);
                    frameOf.push(-1);
                    coef.push(anchorPos.x + wx - ownerPos.x,
                        anchorPos.y + wy - ownerPos.y,
                        anchorPos.z + wz - ownerPos.z);
                }
                names.push(sc.names[k]);
                elements.push(sc.elements[k]);
            }
            if (!pos.length) return null;
            // bonds are TABLE ROWS, not positions, so they renumber separately
            const bonds = [];
            for (let e = 0; e + 1 < sc.bonds.length; e += 2) {
                const a = rowOf.get(sc.bonds[e]);
                const b = rowOf.get(sc.bonds[e + 1]);
                if (a !== undefined && b !== undefined) bonds.push(a, b);
            }
            // The CA end is a row index too and renumbers the same way. Losing
            // it would leave a copied side chain floating free of its ribbon
            // with nothing joining them, while every atom and every other bond
            // came across intact.
            const toBackbone = [];
            for (const row of (sc.toBackbone || [])) {
                const a = rowOf.get(row);
                if (a !== undefined) toBackbone.push(a);
            }
            return {
                pos: new Int32Array(pos),
                frameOf: new Int32Array(frameOf),
                coef: new Float32Array(coef),
                bonds: new Int32Array(bonds),
                toBackbone: new Int32Array(toBackbone),
                names,
                elements,
            };
        }

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

            // THE SELECTION, and only the selection. Copy used to fall back to
            // the selection model and then to visiblePositions, so with nothing
            // selected it silently extracted whatever happened to be on screen -
            // an "extract" that quietly copied the whole structure. Selection
            // and visibility are separate concepts now (a drag selects and
            // leaves visibility alone), so falling back from one to the other
            // cannot be right. No selection means nothing to copy.
            const selectedPositions = (this.residueSelection && this.residueSelection.size > 0)
                ? new Set(this.residueSelection)
                : new Set();

            if (selectedPositions.size === 0) {
                console.warn("Nothing selected - select a region in the sequence view first.");
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
                    bonds: undefined, // Will be handled separately
                    // Keyed by position index, so a copy has to renumber it -
                    // see _remapSidechains. Named here because this object is
                    // built field by field and anything left out is dropped in
                    // silence, which is how the copy came to have no side
                    // chains at all. FILLED IN BELOW, once the coordinates
                    // exist: the remap has to ask whether the COPY can build a
                    // local frame at each anchor, and it cannot answer that
                    // against coordinates that have not been extracted yet.
                    sidechains: null,
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

                extractedFrame.sidechains = this._remapSidechains(
                    frame.sidechains, selectedIndices, frame.coords, extractedFrame.coords);

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

            // ...and the display state that goes with those positions: which
            // of them show a side chain or a base, their colours, and the
            // contacts between them. Frames carry coordinates; this carries
            // the pose.
            this._remapObjectState(object, this.objectsData[extractName], selectedIndices);

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
            this.setVisibility({
                positions: new Set(),
                chains: new Set(),
                paeBoxes: [],
                visibilityMode: 'default'
            });

            // DROP THE SELECTION. It holds position indices into the object
            // that was current when the drag happened, and the extracted copy
            // is now current - the same indices name different residues there,
            // or none at all. Carrying it over made a second Copy extract a
            // slice of the first copy rather than the region the user could
            // see highlighted.
            this.clearResidueSelection();

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
                    this.ctx.fillStyle = this.backgroundColor || '#ffffff';
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

            // Make setFrame overlay-aware
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
            if (this.shadeSlider) this.shadeSlider.disabled = !enabled;
            if (this.outlineModeButton) this.outlineModeButton.disabled = !enabled;
            if (this.outlineModeSelect) this.outlineModeSelect.disabled = !enabled;
            if (this.colorblindCheckbox) this.colorblindCheckbox.disabled = !enabled;
            if (this.orthoSlider) this.orthoSlider.disabled = !enabled;
            this.canvas.style.cursor = enabled ? 'grab' : 'wait';
        }

        // Update the text/slider values
        updateUIControls() {
            // the panel's nucleic rows depend on what is loaded
            if (this._syncStylePanel) this._syncStylePanel();
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
         * This is the SINGLE SOURCE OF TRUTH for frame merging logic.
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
            // Nucleic base geometry. Frames that repeat the previous frame's
            // value carry none (Python delta-encodes it), so fall back to the
            // last one seen and then to the object-level copy; frames with no
            // base geometry at all contribute zero rows, which the cartoon
            // reads as "estimate this one".

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
         * This is the SINGLE PATH to enter overlay mode.
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
         * This is the SINGLE PATH to exit overlay mode.
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
            this._invalidateSegmentCache();

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

            // Use atomic state transition methods
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
                    ctx.fillStyle = this.backgroundColor || '#ffffff';
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
                // seeded from the control - see the first of these three defaults
                ortho: this.orthoSlider ? parseFloat(this.orthoSlider.value) : 1,
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
            this.cartoonShade = 1;
            this.outlineMode = 'full';
            this.autoRotate = false;
            this.colorblindMode = false;
            this.lineWidth = 3.0;
            this.animationSpeed = 100;
            this.currentFrame = -1;
            this.lastRenderedFrame = -1;
            if (this.shadeSlider) {
                this.shadeSlider.value = 1;
            }
            if (this.shadowSlider) {
                this.shadowSlider.value = 0.5;
                this.shadowStrength = 0.5;
                this.shadowEnabled = true;
            }
            if (this.outlineWidthSlider && !this.outlineModeButton && !this.outlineModeSelect) {
                this.outlineWidthSlider.value = 3.0;
                this.relativeOutlineWidth = 3.0;
                this.outlineMode = 'full';
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
                this.orthoSlider.value = '0.5';
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
            this.hideAll();

            // Update UI controls
            this.updateUIControls();

            // Trigger render to show empty state
            this.render();
        }

        /**
         * SIDE CHAINS BECOME LIGAND POSITIONS.
         *
         * The atoms arrive as a side table of local-frame coefficients (see
         * buildSidechainTable in web/utils.js) which no hot path reads. When a
         * residue is switched on, its atoms are materialised here into ordinary
         * positions of type 'L' with ordinary bonds between them - which is to
         * say, into a ligand. Everything downstream then works with no new code
         * at all: both styles draw them, both depth-sort them correctly against
         * the backbone, picking and selection reach them, and the cartoon draws
         * them as the same sticks it gives a real ligand.
         *
         * They are APPENDED, never inserted. Every position index already in
         * use - selection sets, colour overrides, sse overrides, PAE rows,
         * the sequence strip - keeps its meaning, and a trailing run of 'L'
         * positions is what a file with ligands in it looks like anyway.
         *
         * Coordinates are rebuilt in the file's own frame here, which is exact
         * for the tube style. The cartoon moves its backbone after this point
         * (sheet projection, flattening) and re-derives them from the moved
         * positions - see the side-chain pass in viewer-cartoon.js.
         *
         * @returns {object} a NEW data object with the atoms appended; `data`
         *   itself is left alone. The visibility sets are the exception - they
         *   outlive the frame load and are updated in place, both to drop a
         *   previous pass's indices and to follow the residues switched on.
         */
        _materialiseSidechains(data) {
            const sc = data.sidechains;
            const obj = this.objectsData?.[this.currentObjectName];
            const show = obj && obj.sidechains;
            this.sidechainMap = null;
            // Drop anything a PREVIOUS materialisation added. Visibility sets
            // outlive a frame load, so turning side chains off would otherwise
            // leave indices in them that now point past the end of the
            // coordinate array - and those get saved into the object's
            // visibilityState and carried forward.
            //
            // THE SELECTION IS ONE OF THOSE SETS. A click in the 3D view can
            // land on a side-chain atom, which selects an APPENDED index; hide
            // the side chains and that index points past the end. Everything
            // that reads the selection then asks about a position that no
            // longer exists - the panel's toggles tally it as not-visible and
            // the main chain read as half hidden the moment side chains went.
            const nBase = data.coords.length;
            for (const set of [this.visiblePositions, this.residueSelection,
                this.visibilityModel && this.visibilityModel.positions]) {
                if (!set) continue;
                for (const i of set) if (i >= nBase) set.delete(i);
            }
            // ...and any bond a previous materialisation added. This is not
            // belt and braces: setCoords PERSISTS the bond list onto the object
            // (`objectsData[name].bonds = bonds`) and _loadFrameData reads it
            // back, so without this each show appends to the previous show's
            // list. Hiding leaves those bonds behind - harmlessly, since they
            // are then out of range and skipped - and showing again brings them
            // back into range pointing at DIFFERENT atoms, which draws bonds
            // between unrelated side chains. That is the show/hide/show
            // corruption.
            //
            // The test is exact rather than a guess: a frame's own bonds cannot
            // reference a position the frame does not have, so anything
            // touching an index at or past nBase came from a previous pass.
            let bonds = data.bonds || null;
            if (bonds && bonds.some(([a, b]) => a >= nBase || b >= nBase)) {
                bonds = bonds.filter(([a, b]) => a < nBase && b < nBase);
                data = { ...data, bonds };
            }
            if (!sc || !show || !show.size || !sc.pos.length) return data;
            const localFrame = window.py2dmolCartoon && window.py2dmolCartoon.localFrame;
            if (!localFrame) return data;

            const n = data.coords.length;
            const at = (i) => ({ x: data.coords[i][0], y: data.coords[i][1], z: data.coords[i][2] });
            const fr = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            const frames = new Map();
            const frameAt = (i) => {
                if (!frames.has(i)) {
                    frames.set(i, localFrame(at, n, i, fr, null) ? fr.slice() : null);
                }
                return frames.get(i);
            };

            // EVERY per-position array has to grow together. setCoords feeds
            // each one through _setDataField, which silently replaces an array
            // whose length does not match the coordinate count with a default -
            // it does not warn, and it does not fail. Missing plddts that way
            // filled every position with 50, the low-confidence band, and an
            // AlphaFold model turned entirely red the moment a side chain was
            // shown. The five here are exactly the five _setDataField handles;
            // adding a sixth there means adding it here.
            const coords = data.coords.slice();
            const types = (data.position_types || []).slice();
            const chains = (data.chains || []).slice();
            const names = (data.position_names || []).slice();
            const numbers = (data.residue_numbers || []).slice();
            const plddts = data.plddts ? data.plddts.slice() : null;
            const bondsOut = (data.bonds || []).slice();
            // position index -> {anchor, cx, cy, cz}, so the cartoon can put
            // these back where the flattened backbone actually is
            const map = new Map();
            const idxOf = new Map();       // table row -> new position index

            for (let k = 0; k < sc.pos.length; k++) {
                const owner = sc.pos[k];
                if (!show.has(owner)) continue;
                const anchor = sc.frameOf[k];
                // ANCHOR -1: the coefficients are a plain offset from the
                // owner's own position, in world axes, because the structure
                // this row belongs to cannot build a local frame at all.
                // `localFrame` needs a residue before and two after (see its
                // 1 <= i <= n-3 guard) and an unbroken chain through them, so a
                // copy of one residue, or of anything under four, or of runs
                // with gaps between them, has no frame anywhere. The offsets
                // are baked at copy time, where the frame still existed.
                //
                // What this costs is the only thing the frame buys: these
                // atoms do not follow the backbone when a sheet is flattened.
                // A structure too short to be framed is also too short to be
                // flattened, so there is nothing to follow.
                const f = anchor >= 0 ? frameAt(anchor) : null;
                if (anchor >= 0 && !f) continue;
                const o = at(anchor >= 0 ? anchor : owner);
                const cx = sc.coef[k * 3], cy = sc.coef[k * 3 + 1], cz = sc.coef[k * 3 + 2];
                const idx = coords.length;
                coords.push(f ? [
                    o.x + f[0] * cx + f[3] * cy + f[6] * cz,
                    o.y + f[1] * cx + f[4] * cy + f[7] * cz,
                    o.z + f[2] * cx + f[5] * cy + f[8] * cz,
                ] : [o.x + cx, o.y + cy, o.z + cz]);
                types.push('L');
                chains.push(chains[owner] !== undefined ? chains[owner] : '');
                names.push(names[owner] !== undefined ? names[owner] : '');
                numbers.push(numbers[owner] !== undefined ? numbers[owner] : 0);
                // pLDDT is a per-RESIDUE confidence, so an atom of that residue
                // carries the residue's own value - which also keeps a side
                // chain the same colour as the backbone it grows out of.
                if (plddts) plddts.push(plddts[owner] !== undefined ? plddts[owner] : 50);
                // el: the atom's ELEMENT, carried so a bond can be coloured by
                // what it joins. Nothing else knows it - the side-chain table
                // has it, but by the time a segment is coloured the table row
                // is long gone and only the position index remains.
                map.set(idx, { anchor, cx, cy, cz, owner,
                    el: (sc.elements && sc.elements[k]) || '' });
                idxOf.set(k, idx);
            }
            if (!idxOf.size) return data;
            // A SIDE CHAIN IS VISIBLE EXACTLY WHEN ITS RESIDUE IS. Visibility is
            // a Set of position indices, and in the DEFAULT "show everything"
            // mode it is not empty - it is filled with every index there was at
            // the time. Appending positions without extending it therefore hides
            // them: they are drawn, sorted and then filtered out for not being
            // in a set that was written before they existed. That is invisible
            // from every angle except the screen, so it is done here, next to
            // the append, rather than left to a caller to remember.
            const follow = (set) => {
                if (!set || !set.size) return;
                for (const [idx, e] of map) {
                    if (set.has(e.owner)) set.add(idx);
                }
            };
            // EXPLICIT bonds, so the distance guess never runs on them: a side
            // chain's connectivity is known, and letting a 2.0 A cutoff re-derive
            // it would bond atoms across a fold that merely sit close.
            // EXPLICIT bonds, so the distance guess never runs on them: a side
            // chain's connectivity is known, and letting a 2.0 A cutoff re-derive
            // it would bond atoms across a fold that merely sit close.
            for (let e = 0; e + 1 < sc.bonds.length; e += 2) {
                const a = idxOf.get(sc.bonds[e]);
                const b = idxOf.get(sc.bonds[e + 1]);
                if (a !== undefined && b !== undefined) bondsOut.push([a, b]);
            }
            // ...and the CA end joins the BACKBONE POSITION itself. The CA is
            // already drawn - the backbone runs through it - so the table does
            // not carry a copy, and the side chain hangs off the position that
            // is really there rather than off a coincident duplicate of it.
            for (const row of (sc.toBackbone || [])) {
                const a = idxOf.get(row);
                if (a === undefined) continue;
                const owner = sc.pos[row];
                if (owner >= 0 && owner < nBase) bondsOut.push([owner, a]);
            }
            // DISULFIDES, FOUND IN THE GEOMETRY, between the cysteines whose
            // side chains are actually drawn.
            //
            // The file's own record is no use here. `_struct_conn` is parsed
            // and its `disulf` rows reach convertParsedToFrameData, but they
            // name atoms - chain:seq:SG - and a protein's positions are one per
            // residue, so the lookup finds no SG and the bond is dropped in
            // silence. Measured on 3PTB: six disulf records in, zero bonds out,
            // every bond that reached the renderer belonging to the ligand.
            // Detecting them here instead also covers PDB files with no SSBOND
            // records and CIFs with no struct_conn at all.
            //
            // 2.5 A, and the number is not a guess. Over every SG-SG pair in
            // the corpus the bonded ones run 1.79-2.09 A and the next pair is
            // at 3.36 - a 1.3 A gap, so anything from 2.1 to 3.3 finds exactly
            // the same 16 disulfides. 2.5 sits in the middle of it.
            //
            // ONLY BETWEEN MATERIALISED ATOMS, which is what makes "if both are
            // enabled" fall out for free: an SG exists as a position only while
            // its cysteine's side chain is shown, so a bond to a hidden partner
            // has nothing to attach to and is simply not found. It is also why
            // this is redone on every materialisation rather than stored -
            // indices are reissued whenever the set changes, and a remembered
            // pair would point at the wrong atoms.
            const SS_MAX = 2.5;
            // idxOf is table row -> position index, which is the way round
            // needed to ask an atom its NAME: sidechainMap carries the frame
            // it was rebuilt in, not its row.
            const sgIdx = [];
            for (const [row, idx] of idxOf) {
                if (sc.names[row] === 'SG') sgIdx.push(idx);
            }
            // Recorded as well as bonded, because nothing downstream can tell a
            // disulfide from the CB-SG bond beside it - both join two appended
            // atoms and both are about 2 A long - so without this the feature
            // cannot be tested or inspected at all.
            const ssFound = [];
            for (let a = 0; a < sgIdx.length; a++) {
                for (let b = a + 1; b < sgIdx.length; b++) {
                    // [x, y, z] ARRAYS, which is what this function appends -
                    // not the Vector3 objects the base coords are. Reading .x
                    // off one gives undefined, every comparison is NaN, and the
                    // detector silently finds nothing: measured, 0 of 3PTB's 6.
                    const p1 = coords[sgIdx[a]]; const p2 = coords[sgIdx[b]];
                    if (!p1 || !p2) continue;
                    // NEVER A RESIDUE TO ITSELF. Alt-loc conformers of one
                    // cysteine sit ~1.8 A apart - measured on 2R8S, whose CYS
                    // L194 and H148 are each modelled twice - which is well
                    // inside the cutoff and would draw a bond from a residue to
                    // itself. Capture already keeps only the first conformer,
                    // so this cannot fire today; it costs a comparison and
                    // stops the day that changes from being a mystery.
                    const o1 = map.get(sgIdx[a]); const o2 = map.get(sgIdx[b]);
                    if (o1 && o2 && o1.owner === o2.owner) continue;
                    const dx = p1[0] - p2[0];
                    const dy = p1[1] - p2[1];
                    const dz = p1[2] - p2[2];
                    if (dx * dx + dy * dy + dz * dz <= SS_MAX * SS_MAX) {
                        bondsOut.push([sgIdx[a], sgIdx[b]]);
                        ssFound.push([sgIdx[a], sgIdx[b]]);
                    }
                }
            }
            this.disulfides = ssFound;
            // VISIBILITY LAST, once every appended position exists. It walks the
            // side-chain map and gives each atom its owner's visibility, and the
            // midpoints created by bond splitting are appended AFTER the atoms -
            // so running it earlier left them out of the visible set and they
            // vanished from the drawing.
            follow(this.visiblePositions);
            follow(this.visibilityModel && this.visibilityModel.positions);
            this.sidechainMap = map;
            // The coordinate array just changed length, so segments built for
            // the old one are wrong. The cache keys on frame and object name,
            // neither of which moves when a side chain is toggled, so it would
            // happily be reused and none of this would ever be drawn.
            if (this._invalidateSegmentCache) this._invalidateSegmentCache();
            return {
                ...data,
                coords, position_types: types, chains,
                position_names: names, residue_numbers: numbers, bonds: bondsOut,
                plddts: plddts || data.plddts,
            };
        }

        _loadDataIntoRenderer(data, skipRender = false) {
            if (data && data.coords && data.coords.length > 0) {
                // The side table itself is kept as-is; _materialiseSidechains
                // turns the switched-on part of it into real positions.
                this.sidechains = data.sidechains || null;
                data = this._materialiseSidechains(data);
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

                // WHICH CHAINS ARE LIGAND-ONLY: one pass over the positions,
                // not one pass PER CHAIN.
                //
                // This asked, for every chain, "does any position in it carry a
                // polymer type" by scanning the whole position list - so it
                // cost chains x positions. On a capsid that is 1,356 chains
                // against 313,236 positions: 425 million string comparisons,
                // and 3.6 s of a 16 s load, all of it inside setCoords.
                //
                // The question is per POSITION, not per chain: walk the
                // positions once, note the chain of each polymer one, and any
                // chain not noted is ligand-only. Same answer, O(n + chains).
                const polymerChains = new Set();
                for (let i = 0; i < n; i++) {
                    const type = this.positionTypes[i];
                    if (type === 'P' || type === 'D' || type === 'R') {
                        polymerChains.add(this.chains[i]);
                    }
                }
                for (const chainId of sortedUniqueChains) {
                    if (!polymerChains.has(chainId)) {
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
                // rebuilt alongside them: which chains close head to tail
                this.cyclicChains = new Set();
                const cutoffs = this.config.cutoffs || {};
                const proteinChainbreak = cutoffs.protein_bond ?? 5.0;
                const nucleicChainbreak = cutoffs.nucleic_bond ?? 7.5;
                const ligandBondCutoff = cutoffs.ligand_bond ?? 2.0;
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
                                    // this chain is a ring - the rainbow ramp
                                    // wraps the full hue circle for it
                                    this.cyclicChains.add(chainId);
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

                // ONE SEGMENT PER BOND. The explicit list below and the ligand
                // distance search further down routinely find the SAME pair -
                // a PDB ligand usually arrives with both CONECT records and
                // atoms close enough to bond - and emitting it twice is not
                // merely wasteful. The cartoon style reads connectivity off
                // these segments to decide how bonds meet: a duplicate doubles
                // every atom's apparent degree, so a two-bond atom looks like a
                // four-way junction and never joins as a run, while a junction's
                // mitre gets pairs of IDENTICAL leg directions, its determinant
                // vanishes and it gives up. Every bond then draws as a loose box
                // with square ends. On a heme: 99 segments for 50 real bonds.
                const emittedBondKeys = new Set();
                const bondKey = (i, j) => (i < j ? i + '-' + j : j + '-' + i);

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

                        if (emittedBondKeys.has(bondKey(idx1, idx2))) continue;
                        emittedBondKeys.add(bondKey(idx1, idx2));

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
                // DISTANCE BONDING IS A GUESS, AND ONLY FILLS IN WHERE THE FILE
                // SAID NOTHING. A structure that carries its own connectivity -
                // CONECT records, or a chemical component definition - has
                // already been believed above; re-deriving the same ligand from
                // a 2.0 A cutoff can only agree with it or contradict it, and
                // where it contradicts, the file is right. A cutoff has no way
                // to know a bond is dative, or that two atoms sit close without
                // being bonded. Measured on 4HHB's haem: dropping the guess
                // loses O1A-O2A (1.54 A) and O1D-O2D (1.94 A) - the paired
                // oxygens of a carboxylate, never bonded to each other - and
                // gains the four Fe-N coordinations (2.15-2.23 A, past the
                // cutoff) plus two stretched propionate C-C. Better both ways.
                // On BEN (3PTB) and G3A (9FOG) the two sets are identical.
                //
                // The test is per LIGAND, not per structure: a file may name the
                // bonds of one ligand and say nothing about the next, and that
                // next one still needs them derived.
                //
                // "Provided" has to mean the whole ligand, not one atom of it.
                // _struct_conn records INTER-residue links - a metal
                // coordination, a covalent tether to the protein - so a haem
                // whose file mentions only the Fe-His bond would pass a
                // does-any-atom-have-a-bond test and lose all 50 of its real
                // ones. So: count only bonds with BOTH ends inside the ligand,
                // and require every atom to have at least one. Partial
                // connectivity falls through and is supplemented by distance,
                // which the dedupe above keeps from restating what we have.
                //
                // ASKED OF THE BOND LIST ONCE, not once per ligand. Walking
                // every bond to answer for one ligand is fine for a structure
                // with a haem in it and quadratic for one with thousands:
                // 7Y7A has ~8,800 ligand groups and 223,276 bonds, which is
                // two billion comparisons inside setCoords. Instead every bond
                // is looked at once and charged to the group both its ends sit
                // in, which is the same question read from the other side.
                const obj = this.objectsData[this.currentObjectName];
                let touchedByGroup = null;
                if (obj?.ligandGroups?.size > 0) {
                    const groupOf = new Map();
                    let shared = false;
                    for (const [key, idxs] of obj.ligandGroups.entries()) {
                        for (const i of idxs) {
                            if (groupOf.has(i)) { shared = true; break; }
                            groupOf.set(i, key);
                        }
                        if (shared) break;
                    }
                    // A position in two groups at once would be charged to only
                    // one of them here, so that case keeps the old walk.
                    if (!shared) {
                        touchedByGroup = new Map();
                        for (const [b1, b2] of (this.bonds || [])) {
                            const g = groupOf.get(b1);
                            if (g === undefined || g !== groupOf.get(b2)) continue;
                            let s = touchedByGroup.get(g);
                            if (!s) { s = new Set(); touchedByGroup.set(g, s); }
                            s.add(b1); s.add(b2);
                        }
                    }
                }
                const fileKnowsIt = (indices, groupKey) => {
                    if (!indices || indices.length < 2) return false;
                    if (touchedByGroup && groupKey !== undefined) {
                        const s = touchedByGroup.get(groupKey);
                        return !!s && s.size === new Set(indices).size;
                    }
                    const inGroup = new Set(indices);
                    const touched = new Set();
                    for (const [b1, b2] of (this.bonds || [])) {
                        if (inGroup.has(b1) && inGroup.has(b2)) {
                            touched.add(b1);
                            touched.add(b2);
                        }
                    }
                    return touched.size === inGroup.size;
                };
                if (obj?.ligandGroups?.size > 0) {
                    // Use ligand groups: only compute distances within each group
                    for (const [groupKey, ligandPositionIndices] of obj.ligandGroups.entries()) {
                        if (fileKnowsIt(ligandPositionIndices, groupKey)) continue;
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
                                    // already found as an explicit bond?
                                    if (emittedBondKeys.has(bondKey(idx1, idx2))) continue;
                                    emittedBondKeys.add(bondKey(idx1, idx2));
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
                        if (fileKnowsIt(ligandIndices)) continue;
                        for (let i = 0; i < ligandIndices.length; i++) {
                            for (let j = i + 1; j < ligandIndices.length; j++) {
                                const idx1 = ligandIndices[i];
                                const idx2 = ligandIndices[j];

                                // All positions here are guaranteed to be in the same chain (chainId)

                                const start = this.coords[idx1];
                                const end = this.coords[idx2];
                                const distSq = start.distanceToSq(end);
                                if (distSq < ligandBondCutoffSq) {
                                    // already found as an explicit bond?
                                    if (emittedBondKeys.has(bondKey(idx1, idx2))) continue;
                                    emittedBondKeys.add(bondKey(idx1, idx2));
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

            // Ensure static adjacency list and arrays exist
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

            // NOT THE pLDDT COLOURS. The draw path builds them itself the
            // moment the colour mode actually asks for them - it has to, since
            // the mode can change without the coordinates changing - so doing
            // it here as well is a second pass over every position for an
            // array most structures never read. Marked stale instead.
            this.plddtColors = [];
            this.plddtColorsNeedUpdate = true;

            // Apply initial mask and render once
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
                this.showAll();
                this.previousObjectName = this.currentObjectName; // Update tracking
            } else if (this.visibilityModel.visibilityMode === 'explicit' &&
                this.visibilityModel.positions.size === 0) {
                // Selection was explicitly cleared, reset to default
                this.showAll();
            }

            // A CLIP IS A BOX, AND THE ATOMS MOVED. Re-derive the mask from it
            // for this frame - see _reapplyClipForFrame. A no-op when there is
            // no committed box.
            this._reapplyClipForFrame();

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
        /**
         * The EXPLICIT colour override for a position, or null if its colour
         * comes from a mode (chain/rainbow/plddt/ss).
         *
         * Exists because the cartoon plugin resolves secondary-structure colour
         * per INTERVAL rather than per residue, and so re-derives colour itself
         * instead of calling getAtomColor. Without this it had no way to tell a
         * palette colour from one the user had set by hand, and overwrote the
         * latter - a region coloured from the selection tools stayed the palette
         * colour in ss mode.
         * @param {number} atomIndex
         * @returns {{r:number,g:number,b:number}|null}
         */
        /**
         * A side-chain atom's colour, resolved through the RESIDUE it belongs
         * to. Side-chain atoms are positions only while they are drawn, and
         * their indices are reissued whenever the set changes, so nothing can
         * be stored against them; `sidechainColor` is keyed by residue instead.
         * Unset means follow the residue, so recolouring a main chain carries
         * its side chains with it unless they were given a colour of their own.
         * @returns {number} the position index to resolve colour from
         */
        _colorPositionFor(atomIndex) {
            const e = this.sidechainMap && this.sidechainMap.get(atomIndex);
            return e ? e.owner : atomIndex;
        }

        /**
         * PyMOL's element colours, for the atoms a side chain can contain.
         *
         * Sulfur is the gold this exists for: a disulfide drawn in the residue's
         * own colour is indistinguishable from the carbon skeleton either side
         * of it, and the whole point of drawing one is that it reads as a
         * cross-link. The rest are here because a table with one entry invites
         * the next one to be added somewhere else.
         *
         * SELENIUM for selenomethionine - the connectivity table already knows
         * MSE, and a structure phased that way has Se where a methionine's S
         * would be. No MSE in this repo's corpus, so it is untested on real
         * data and is deliberately the same family of colour as sulfur.
         *
         * CARBON IS ABSENT ON PURPOSE. It follows the residue's own colour, the
         * way PyMOL's colour-by-element leaves the carbon skeleton alone: a
         * side chain that turned grey when you coloured its residue would lose
         * the thing the colour was for.
         */
        static get ELEMENT_COLORS() {
            return {
                N: { r: 51, g: 51, b: 255 },      // blue
                O: { r: 255, g: 76, b: 76 },      // red
                S: { r: 229, g: 198, b: 64 },     // gold
                SE: { r: 240, g: 161, b: 54 },    // a warmer gold
            };
        }

        /**
         * A segment's colour when BOTH its ends are the same non-carbon element.
         *
         * Both ends, deliberately. This renderer draws a bond as ONE stick with
         * one colour, where PyMOL splits it at the midpoint and gives each half
         * its own atom's colour. Colouring a mixed bond by either end would be
         * a coin toss - a CB-SG bond is half carbon - so only a bond whose two
         * ends agree takes an element colour. For the atoms a side chain
         * actually contains that means exactly one thing: the S-S of a
         * disulfide.
         */
        /**
         * What each END of a bond should be coloured, by its atom's element.
         *
         * PyMOL cuts a bond at its midpoint and gives each half its own atom's
         * colour. This says what the two halves should be; the renderer does the
         * cutting, because it is a drawing decision and nothing outside the
         * drawing should have to know about it. An earlier attempt put a real
         * midpoint POSITION in the coordinate array instead, and then every
         * data-level pass - distance bonding, picking, visibility, saving - had
         * to be taught to ignore it. A midpoint is not an atom.
         *
         * NULL FOR CARBON, so it follows the residue's own colour: a side chain
         * that was coloured stays coloured, with only its heteroatoms standing
         * out. That is PyMOL's colour-by-element too.
         */
        _segmentElementHalves(segInfo) {
            const map = this.sidechainMap;
            if (!map) return null;
            const a = map.get(segInfo.idx1);
            const b = map.get(segInfo.idx2);
            if (!a || !b) return null;
            // ...unless this residue's elements were switched off. Absent means
            // ON for everything, so a structure nobody has touched keeps them.
            const obj = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const only = obj && obj.elements instanceof Set ? obj.elements : null;
            if (only && !only.has(a.owner)) return null;
            const T = this.constructor.ELEMENT_COLORS;
            const ca = T[(a.el || '').toUpperCase()] || null;
            const cb = T[(b.el || '').toUpperCase()] || null;
            if (!ca && !cb) return null;
            return { a: ca, b: cb };
        }

        /**
         * A segment's colour when its own atom is a coloured element.
         *
         * PyMOL cuts a bond at its midpoint and gives each half its atom's
         * colour. That is done here by CUTTING THE BOND ITSELF, in
         * _materialiseSidechains: a bond between two different elements is
         * emitted as two bonds meeting at a real midpoint position, each
         * running from ITS atom to the middle. So by the time a segment is
         * coloured it already has one atom and one meaning, and this is just
         * "what element is idx1".
         *
         * Splitting there rather than in the renderer is the whole trick. A
         * half-bond that is an ordinary bond between two ordinary positions is
         * seen consistently by everything downstream - the incidence map, the
         * run-joining, the degree and mitre logic, the ink pass, picking. An
         * earlier version instead emitted two BOND RECORDS naming the same pair
         * of atoms, which lies to all of that, and bonds went missing.
         *
         * NULL FOR CARBON and for a midpoint, so those follow the residue's own
         * colour: a side chain that was coloured stays coloured, with only its
         * heteroatoms standing out. That is PyMOL's colour-by-element too.
         */
        _segmentElementColor(segInfo) {
            const h = this._segmentElementHalves(segInfo);
            if (!h || !h.a || !h.b) return null;
            return (h.a === h.b) ? h.a : null;
        }

        /**
         * Which position a SEGMENT resolves its colour from.
         *
         * A segment normally takes `origIndex`, which is its first index. That
         * is wrong for the bond joining a side chain to its backbone: it is
         * emitted as [owner, CB], so origIndex is the BACKBONE alpha carbon and
         * the bond kept the main chain's colour while every other bond of the
         * same side chain took the side chain's. Reported as colouring a side
         * chain leaving its CA-CB bond behind.
         *
         * A bond with one end on a side-chain atom is part of that side chain,
         * so it resolves through that end. Safe where no side-chain colour is
         * set: `_colorPositionFor` sends a side-chain atom back to its owner,
         * which is the position it would have used anyway.
         */
        _colorSegmentPosition(segInfo) {
            if (this.sidechainMap) {
                if (this.sidechainMap.has(segInfo.idx2)) return segInfo.idx2;
                if (this.sidechainMap.has(segInfo.idx1)) return segInfo.idx1;
            }
            return segInfo.origIndex;
        }

        /** An explicit side-chain colour for this atom, if one was set. */
        _sidechainColorOf(atomIndex) {
            const e = this.sidechainMap && this.sidechainMap.get(atomIndex);
            if (!e) return null;
            const obj = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const hex = obj && obj.sidechainColor && obj.sidechainColor[e.owner];
            return hex ? hexToRgb(hex) : null;
        }

        /**
         * Which residues have side-chain atoms to show at all.
         *
         * Glycine has none, nor does a nucleotide, nor any residue in a
         * backbone-only model - so "show side chains" is meaningless for a
         * selection made entirely of those, and the control for it should not
         * be offered. Cached against the table's identity rather than rebuilt
         * per call: it is asked on every selection change and the table can run
         * to tens of thousands of atoms.
         *
         * @returns {Set<number>|null} owning position indices, or null if the
         *          structure carries no side-chain data at all
         */
        sidechainOwners() {
            const sc = this.sidechains;
            if (!sc || !sc.pos || !sc.pos.length) return null;
            if (this._scOwnersFor !== sc) {
                this._scOwnersFor = sc;
                this._scOwners = new Set(sc.pos);
            }
            return this._scOwners;
        }

        /** Does any of `positions` have a side chain to draw? */
        hasSidechainsFor(positions) {
            const owners = this.sidechainOwners();
            if (!owners) return false;
            for (const i of positions) if (owners.has(i)) return true;
            return false;
        }

        /**
         * Is there anything here whose elements could be coloured? Side-chain
         * atoms are the only things that carry an element, so the row is
         * offered exactly where the Side chains row is.
         */
        hasElementsFor(positions) {
            return this.hasSidechainsFor(positions);
        }

        /**
         * Show or hide element colours for these residues.
         *
         * NULL MEANS ALL, the same way `bases` reads it and the opposite of
         * `sidechains`: element colouring is on by default, so an object nobody
         * has touched has it everywhere. An EMPTY set means none, which is what
         * selecting everything and hiding it gives, and has to be
         * distinguishable from "never asked". Materialising from the full set
         * of side-chain owners is what makes hiding a few work.
         *
         * @returns {boolean} whether anything changed and a redraw is due
         */
        setElementsFor(positions, on) {
            const obj = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            if (!obj) return false;
            const owners = this.sidechainOwners();
            if (!owners) return false;
            let cur;
            if (obj.elements instanceof Set) cur = new Set(obj.elements);
            else cur = new Set(owners);
            let changed = false;
            for (const i of positions) {
                if (!owners.has(i)) continue;
                if (on ? !cur.has(i) : cur.has(i)) changed = true;
                if (on) cur.add(i); else cur.delete(i);
            }
            if (!changed) return false;
            obj.elements = cur;
            // colours are cached; this changes them
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;
            return true;
        }

        /**
         * Are any of these positions nucleotides - i.e. is there a base to show
         * or hide? The Bases row is offered only where the answer is yes, the
         * same way the Side chains row is hidden for a selection that has none.
         * Position types 'D' and 'R' are DNA and RNA.
         */
        /**
         * Does this selection have a secondary structure to force?
         *
         * SECONDARY STRUCTURE IS A PROTEIN BACKBONE PROPERTY. A nucleotide has
         * no helix or sheet to be in, and the assignment never gives one a
         * letter, so the SSE control did nothing at all on a DNA or RNA
         * selection - it just sat there offering four states none of which
         * could apply.
         */
        hasSseFor(positions) {
            const t = this.positionTypes;
            if (!t) return false;
            for (const i of positions) {
                if (t[i] === 'P') return true;
            }
            return false;
        }

        hasBasesFor(positions) {
            const t = this.positionTypes;
            if (!t) return false;
            for (const i of positions) {
                if (t[i] === 'D' || t[i] === 'R') return true;
            }
            return false;
        }

        /**
         * Show or hide the base plates of these positions.
         *
         * NULL MEANS ALL, unlike `sidechains` where null means none. A duplex
         * has always been drawn with its rungs, so an object nobody has touched
         * keeps them; an EMPTY set means none, which is what selecting
         * everything and hiding it has to give. Materialising the set on first
         * use from "every nucleotide" is what makes hiding a few work: the set
         * has to start full, or hiding three bases would hide all but three.
         *
         * @returns {boolean} whether anything changed and a redraw is due
         */
        setBasesFor(positions, on) {
            const obj = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            if (!obj) return false;
            const t = this.positionTypes || [];
            const isBase = (i) => t[i] === 'D' || t[i] === 'R';
            let cur;
            if (obj.bases instanceof Set) {
                cur = new Set(obj.bases);
            } else {
                cur = new Set();
                for (let i = 0; i < t.length; i++) if (isBase(i)) cur.add(i);
            }
            let changed = false;
            for (const i of positions) {
                if (!isBase(i)) continue;
                if (on ? !cur.has(i) : cur.has(i)) changed = true;
                if (on) cur.add(i); else cur.delete(i);
            }
            if (!changed) return false;
            obj.bases = cur;
            return true;
        }

        /**
         * LIVE SELECTION PREVIEW, for the cost of a blit.
         *
         * A drag in the sequence strip only commits its selection on mouseup,
         * so the band in the 3D view used to sit still until you let go. Simply
         * committing on every mousemove is not the answer: that is a full
         * re-render of the molecule per pointer event, which is fine on a
         * peptide and hopeless on a ribosome.
         *
         * The molecule does not change during such a drag - only which residues
         * are marked - so the finished frame is snapshotted once at the start
         * and each update is that image blitted back plus one halo pass. Cost
         * is independent of structure size.
         *
         * The snapshot is dropped by any real render (see _invalidateSelectionPreview),
         * so a rotation, a frame step or a colour change during a preview cannot
         * leave a stale picture behind - the next update just re-snapshots.
         */
        beginSelectionPreview() {
            // Kept as the public way in, but the snapshot itself is taken by
            // the render (_snapshotCleanFrame) - which is the only moment the
            // canvas holds the molecule and nothing else. Capturing here would
            // take the last frame's overlays with it.
            if (this._previewLive) return true;
            this.render('selection preview snapshot');
            return !!this._previewLive;
        }

        /**
         * Show `set` as the selection without touching the real one. Falls back
         * to a normal render if there is no usable snapshot, so a caller never
         * has to decide which path it is on.
         */
        updateSelectionPreview(set) {
            this._selectionPreview = set || null;
            // ONE compositor for everything drawn on top of the molecule: the
            // preview is a selection that has not been committed, and it lands
            // on the same clean frame the hover marks do.
            this._repaintOverlays();
        }

        /** Drop the preview; the next real render draws the committed selection. */
        endSelectionPreview() {
            this._previewLive = false;
            this._selectionPreview = null;
        }

        _invalidateSelectionPreview() {
            this._previewLive = false;
        }

        /**
         * Paint the selection as a translucent band over the finished drawing.
         *
         * NOT depth-sorted, and deliberately so: this is a UI indicator, not
         * part of the molecule, and its whole job is to say WHERE the selection
         * is - including when it is behind something. Inked into the geometry
         * (the old way) a selection on the far side was occluded by everything
         * in front of it, which is the case you most need it for.
         *
         * Drawn INSIDE the render rather than on the sequence viewer's DOM
         * overlay, because that overlay is a separate canvas: it is skipped
         * during drags, has to be kept in size-sync with the main one, and is
         * not part of a saved image. Compositing here costs one pass and gives
         * the live view, gestures and exports the same answer.
         *
         * The band follows the DRAWN positions (screenX/screenY are written at
         * the flattened, projected coordinates), so it sits on the ribbon you
         * can see rather than on the raw trace.
         */
        /**
         * Keep the finished molecule frame, overlays not yet painted, so that a
         * change to what is MARKED does not have to redraw what is DRAWN.
         *
         * Not during a gesture: mid-drag the picture is superseded a frame
         * later, and the copy would be paid for on every frame of a rotation
         * for a hover that cannot happen while the pointer is holding the
         * canvas. The gesture just leaves no snapshot, and the first hover
         * afterwards pays one ordinary render to make one.
         */
        _snapshotCleanFrame(ctx) {
            this._previewLive = false;
            if (this._exportPxScale) return;
            const c = this.canvas;
            if (!c || !c.width || !c.height) return;
            if (!ctx || ctx.canvas !== c) return;              // an export target
            if (this.isDragging || this.isZooming || this.isOrientAnimating) return;
            if (typeof document === 'undefined' || !document.createElement) return;
            if (!this._previewCanvas) this._previewCanvas = document.createElement('canvas');
            const snap = this._previewCanvas;
            if (snap.width !== c.width || snap.height !== c.height) {
                snap.width = c.width;
                snap.height = c.height;
            }
            const sctx = snap.getContext('2d');
            if (!sctx) return;
            sctx.setTransform(1, 0, 0, 1, 0, 0);
            sctx.clearRect(0, 0, snap.width, snap.height);
            sctx.drawImage(c, 0, 0);
            this._previewLive = true;
        }

        /**
         * WHAT IS HOVERED, from whoever knows - the sequence strip, today.
         * `atoms` are position indices to mark, `info` is {lines: [...]} for the
         * corner tooltip, or null for neither. Repaints the overlays over the
         * clean frame; falls back to an ordinary render when there is no
         * snapshot to blit.
         */
        setHover(atoms, info) {
            const next = (atoms && atoms.size) ? atoms : null;
            const had = !!(this.highlightedAtoms && this.highlightedAtoms.size)
                || !!this.hoverInfo;
            this.highlightedAtoms = next;
            // the singular field is the older API for the same thing; a set
            // arriving here supersedes it, or the two disagree on screen
            this.highlightedAtom = null;
            this.hoverInfo = (info && info.text) ? info : null;
            if (!next && !this.hoverInfo && !had) return;      // nothing to undraw
            this._repaintOverlays();
        }

        /** Blit the clean frame back and put the overlays on it. */
        _repaintOverlays() {
            const ctx = this.ctx || (this.canvas && this.canvas.getContext('2d'));
            if (!ctx || !this._previewLive || !this._previewCanvas) {
                this.render('overlay repaint');
                return;
            }
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            ctx.drawImage(this._previewCanvas, 0, 0);
            ctx.restore();
            this._paintOverlays(ctx, this._exportPxScale || 1);
        }

        /**
         * EVERYTHING THAT SITS ON TOP OF THE MOLECULE, in one pass at the end
         * of the frame: the selection band, then the hover marks and their
         * tooltip.
         *
         * This used to be two canvases. The hover half lived on a second canvas
         * the sequence viewer owned and painted on its own schedule, which is
         * how it went out of step with the picture underneath: that paint
         * resized its canvas and read getBoundingClientRect twice - a forced
         * synchronous layout per frame - so the frame skipped it during a drag,
         * a zoom and the orient fly-to, and skipped it BEFORE the clear. The
         * marks stayed where they were while the structure turned under them,
         * and a settle timer put them right afterwards. Painted here they are
         * the same frame, from the same projection, and cannot disagree.
         */
        _paintOverlays(ctx, pxScale = 1, fromRender = false) {
            // THE CLEAN FRAME, taken here because here is the only moment it
            // exists: the molecule is finished and nothing has been drawn on
            // top of it yet. Hover marks and the drag preview then repaint by
            // blitting it back, which costs the same on a hexapeptide and a
            // ribosome. Snapshotting lazily at the START of a gesture (what
            // beginSelectionPreview did on its own) catches the canvas WITH the
            // last frame's overlays already on it, and bakes them in.
            if (fromRender) this._snapshotCleanFrame(ctx);
            // ONE BAND, ONE COLOUR, for the selection and whatever is hovered.
            // Two marks in two styles asked the reader to learn which yellow
            // meant what; the same band for both says "this is the thing you
            // mean" whichever way you pointed at it. Drawn as a UNION rather
            // than one over the other: the colour is translucent, so anything
            // stroked twice comes out darker, and hovering a residue that is
            // already selected would stain it.
            //
            // NOT IN AN EXPORT, the hover half. The selection is something the
            // user asked to have marked and belongs in a saved image; where the
            // pointer happens to be does not - and an export renders from its
            // own context, with nobody to move the pointer off first.
            const sel = this._selectionPreview
                || (this.selectionInk ? this.selectionInk() : this.residueSelection);
            const hov = this._exportPxScale ? null : this.hoverSet();
            let band = sel;
            if (hov && hov.size) {
                band = new Set(hov);
                if (sel) for (const i of sel) band.add(i);
            }
            this._paintSelectionHalo(ctx, pxScale, band);
            if (!this._exportPxScale) {
                this._paintHoverReadout(ctx, pxScale);
                // The box is a tool, not part of the drawing - it goes with the
                // hover marks, not with the selection.
                this._paintClipBox(ctx, pxScale);
            }
        }

        /** The hovered positions, from either field, or null. */
        hoverSet() {
            if (this.highlightedAtoms && this.highlightedAtoms.size) {
                return this.highlightedAtoms;
            }
            if (this.highlightedAtom !== null && this.highlightedAtom !== undefined) {
                return new Set([this.highlightedAtom]);
            }
            return null;
        }

        /**
         * ONE MODEL POINT INTO VIEW SPACE, by the same road _rotateCoords takes
         * every atom down: the object's own best_view rotation about its centre
         * first, then the view centre off, then the user's rotation. The clip
         * box is model geometry that no frame data holds, so it cannot ride
         * along in rotatedCoords and has to be projected on its own.
         */
        _modelToView(p) {
            const object = this.objectsData[this.currentObjectName];
            let x = p[0]; let y = p[1]; let z = p[2];
            const oR = (object && object.rotation_matrix && object.center)
                ? object.rotation_matrix : null;
            if (oR) {
                const oc = object.center;
                const cx = x - oc[0]; const cy = y - oc[1]; const cz = z - oc[2];
                x = oR[0][0] * cx + oR[0][1] * cy + oR[0][2] * cz + oc[0];
                y = oR[1][0] * cx + oR[1][1] * cy + oR[1][2] * cz + oc[1];
                z = oR[2][0] * cx + oR[2][1] * cy + oR[2][2] * cz + oc[2];
            }
            const c = this._computeViewCentre(object);
            const sx = x - c.x; const sy = y - c.y; const sz = z - c.z;
            const m = this.viewerState.rotation;
            return {
                x: m[0][0] * sx + m[0][1] * sy + m[0][2] * sz,
                y: m[1][0] * sx + m[1][1] * sy + m[1][2] * sz,
                z: m[2][0] * sx + m[2][1] * sy + m[2][2] * sz,
            };
        }

        /** ...and from view space to display pixels, as the draw does. */
        _viewToScreen(v) {
            const W = this.displayWidth || (this.canvas ? this.canvas.width : 0);
            const H = this.displayHeight || (this.canvas ? this.canvas.height : 0);
            const scale = this._viewScale || 1;
            let pe = 1;
            if (isPerspective(this.viewerState)) {
                const d = this.viewerState.focalLength - v.z;
                if (d <= 0.1) return null;                 // behind the camera
                pe = this.viewerState.focalLength / d;
            }
            return { x: W / 2 + v.x * scale * pe, y: H / 2 - v.y * scale * pe, pe };
        }

        /** The box's eight corners in display pixels, or null if unprojectable. */
        _clipCorners() {
            const b = this.clipBox;
            if (!b) return null;
            const [ax, ay, az] = b.min;
            const [bx, by, bz] = b.max;
            const pts = [
                [ax, ay, az], [bx, ay, az], [bx, by, az], [ax, by, az],
                [ax, ay, bz], [bx, ay, bz], [bx, by, bz], [ax, by, bz],
            ];
            const out = [];
            for (const p of pts) {
                const q = this._viewToScreen(this._modelToView(p));
                if (!q) return null;
                out.push(q);
            }
            return out;
        }

        /**
         * The six faces, as {axis, side, centre} - axis 0/1/2 for x/y/z, side 0
         * for the min face and 1 for the max. The handle sits at the face's
         * centre, which is the one point on a face that is always on it however
         * the box is turned.
         */
        _clipFaces() {
            const b = this.clipBox;
            if (!b) return [];
            const mid = [
                (b.min[0] + b.max[0]) / 2,
                (b.min[1] + b.max[1]) / 2,
                (b.min[2] + b.max[2]) / 2,
            ];
            const out = [];
            for (let axis = 0; axis < 3; axis++) {
                for (let side = 0; side < 2; side++) {
                    const p = mid.slice();
                    p[axis] = side ? b.max[axis] : b.min[axis];
                    const q = this._viewToScreen(this._modelToView(p));
                    if (q) out.push({ axis, side, sx: q.x, sy: q.y, model: p });
                }
            }
            return out;
        }

        /** The clip box over the finished frame: twelve edges, six handles. */
        _paintClipBox(ctx, pxScale = 1) {
            if (!this.clipEditing || !this.clipBox) return;
            const c = this._clipCorners();
            if (!c) return;
            const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7],
                [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(pxScale, pxScale);
            ctx.strokeStyle = CLIP_EDGE_CSS;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (const [a, b] of E) {
                ctx.moveTo(c[a].x, c[a].y);
                ctx.lineTo(c[b].x, c[b].y);
            }
            ctx.stroke();
            ctx.fillStyle = CLIP_FACE_CSS;
            for (const f of this._clipFaces()) {
                ctx.beginPath();
                ctx.arc(f.sx, f.sy, CLIP_HANDLE_PX, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();
        }

        /** Which face handle is under this point, or null. */
        _clipFaceAt(px, py) {
            if (!this.clipEditing || !this.clipBox) return null;
            let best = null; let bestD = CLIP_GRAB_PX * CLIP_GRAB_PX;
            for (const f of this._clipFaces()) {
                const dx = f.sx - px; const dy = f.sy - py;
                const d = dx * dx + dy * dy;
                if (d <= bestD) { bestD = d; best = f; }
            }
            return best;
        }

        /**
         * Drag one face along its own axis.
         *
         * The axis is a model direction; on screen it is however that direction
         * happens to point under the current rotation. So the drag is the mouse
         * movement PROJECTED onto the axis's screen direction, divided by how
         * many pixels an Angstrom of it covers - which is what makes a face
         * follow the pointer rather than a fixed number of Angstrom per pixel.
         * A face seen edge-on has almost no screen direction to project onto,
         * so it barely moves: correct, and the reason for the floor.
         */
        _clipDragTo(px, py) {
            const d = this._clipDrag;
            if (!d) return false;
            const b = this.clipBox;
            const axis = d.axis;
            const dx = px - d.px; const dy = py - d.py;
            const along = dx * d.ux + dy * d.uy;
            if (!(d.pxPerA > 1e-6)) return false;
            let v = d.start + along / d.pxPerA;
            // A face cannot pass its opposite: the box would turn inside out
            // and "inside" would stop meaning anything.
            const MIN = 0.5;
            if (d.side) v = Math.max(v, b.min[axis] + MIN);
            else v = Math.min(v, b.max[axis] - MIN);
            if (d.side) b.max[axis] = v; else b.min[axis] = v;
            this._clipVersion++;
            return true;
        }

        /** Set up a face drag: remember where it started and its screen axis. */
        _clipBeginDrag(face, px, py) {
            const b = this.clipBox;
            const step = 1;
            const p0 = face.model.slice();
            const p1 = face.model.slice();
            p1[face.axis] += step;
            const s0 = this._viewToScreen(this._modelToView(p0));
            const s1 = this._viewToScreen(this._modelToView(p1));
            if (!s0 || !s1) return false;
            let ux = s1.x - s0.x; let uy = s1.y - s0.y;
            const len = Math.hypot(ux, uy);
            if (!(len > 1e-6)) return false;              // the axis points at us
            ux /= len; uy /= len;
            this._clipDrag = {
                axis: face.axis, side: face.side, px, py, ux, uy,
                pxPerA: len / step,
                start: face.side ? b.max[face.axis] : b.min[face.axis],
            };
            return true;
        }

        /**
         * WHAT IS UNDER THE POINTER, named: "A GLY 39", bottom left, one line.
         *
         * No box behind it. A panel with a label per line was more furniture
         * than the three words need, and it sat in the bottom RIGHT, which is
         * where the structure usually is once it has been oriented on
         * something. The colour follows the paper instead of a background
         * plate: dark text on white, light on the 3d preset's black.
         */
        _paintHoverReadout(ctx, pxScale = 1) {
            const text = this.hoverInfo && this.hoverInfo.text;
            if (!text) return;
            const H = this.displayHeight || (this.canvas ? this.canvas.height : 0);
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(pxScale, pxScale);
            ctx.font = '14px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = (this.backgroundColor === '#000000')
                ? HOVER_TEXT_DARK_CSS : HOVER_TEXT_LIGHT_CSS;
            ctx.fillText(text, HOVER_TEXT_MARGIN, H - HOVER_TEXT_MARGIN);
            ctx.restore();
        }

        _paintSelectionHalo(ctx, pxScale = 1, set = null) {
            // a live drag preview wins: it is what the user is pointing at
            const sel = set || this._selectionPreview
                || (this.selectionInk ? this.selectionInk() : this.residueSelection);
            if (!sel || !sel.size) return;
            // Only now, and only because there IS a selection to place. On the
            // GPU tube path the frame did not project anything; this is where
            // that debt is settled, and it is settled once per frame at most.
            this._ensurePickProjection();
            const fid = this.screenFrameId;
            const sx = this.screenX; const sy = this.screenY;
            const sr = this.screenRadius; const sv = this.screenValid;
            if (!sx || !sv) return;
            const drawn = (i) => i >= 0 && i < sv.length && sv[i] === fid && sel.has(i);
            const idx = Array.from(sel).filter(drawn);
            if (!idx.length) return;
            idx.sort((a, b) => a - b);
            const chains = this.chains;
            const sc = this.sidechainMap;

            // THE BAND FOLLOWS WHAT IS ACTUALLY CONNECTED.
            //
            // A backbone is a linear chain, so consecutive residues of the same
            // chain join up. A SIDE CHAIN is not: it is a tree - a leucine
            // branches at CG - and its atoms are appended positions whose index
            // order says nothing about which are bonded. Joining those by index
            // would draw a bond from CD1 to CD2 that does not exist, and would
            // run a band from the last atom of one residue's side chain to the
            // first of the next straight through empty space. So side-chain
            // atoms are joined along their BONDS instead - the same
            // connectivity the sticks themselves are drawn from.
            const edges = [];
            const touched = new Set();
            const addEdge = (a, b) => {
                edges.push(a, b);
                touched.add(a); touched.add(b);
            };
            for (let k = 1; k < idx.length; k++) {
                const a = idx[k - 1]; const b = idx[k];
                if (b !== a + 1) continue;                     // a gap
                if (sc && (sc.has(a) || sc.has(b))) continue;   // bonds decide these
                if (chains && chains[a] !== chains[b]) continue;
                addEdge(a, b);
            }
            if (sc && sc.size && this.bonds) {
                for (const [a, b] of this.bonds) {
                    if (!drawn(a) || !drawn(b)) continue;
                    if (!sc.has(a) && !sc.has(b)) continue;
                    addEdge(a, b);
                }
            }

            ctx.save();
            ctx.strokeStyle = SELECTION_HALO_CSS;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            // ONE path, stroked ONCE. A translucent colour composites per draw
            // call, so anything drawn twice comes out darker where it overlaps:
            // a selected stretch would be banded light and dark residue by
            // residue, and every branch point would show as a blot. A single
            // stroked path composites the whole union in one go and comes out
            // flat. That is also why an isolated atom is a ZERO-LENGTH segment
            // rather than a filled arc - with a round cap it draws the same
            // circle, but inside the same path and the same single stroke.
            let w = 0;
            for (const i of idx) w = Math.max(w, sr[i] || 2);
            ctx.lineWidth = 2 * ((SELECTION_HALO_PX * pxScale) + w);
            ctx.beginPath();
            for (let k = 0; k + 1 < edges.length; k += 2) {
                ctx.moveTo(sx[edges[k]], sy[edges[k]]);
                ctx.lineTo(sx[edges[k + 1]], sy[edges[k + 1]]);
            }
            for (const i of idx) {
                if (touched.has(i)) continue;
                // a hair of length, so a round cap has something to cap
                ctx.moveTo(sx[i], sy[i]);
                ctx.lineTo(sx[i] + 0.01, sy[i]);
            }
            ctx.stroke();
            ctx.restore();
        }

        getColorOverride(atomIndex) {
            if (atomIndex < 0 || !this.coords || atomIndex >= this.coords.length) return null;
            const own = this._sidechainColorOf(atomIndex);
            if (own) return own;
            atomIndex = this._colorPositionFor(atomIndex);
            let frameIndex = this.currentFrame >= 0 ? this.currentFrame : 0;
            if (this.overlayState?.enabled && this.overlayState.frameIdMap
                && atomIndex < this.overlayState.frameIdMap.length) {
                frameIndex = this.overlayState.frameIdMap[atomIndex];
            }
            const context = {
                frameIndex,
                posIndex: atomIndex,
                chainId: this.chains[atomIndex] || 'A',
                renderer: this,
            };
            const { resolvedLiteralColor } = resolveColorHierarchy(context, null);
            if (resolvedLiteralColor === null || resolvedLiteralColor === undefined) return null;
            if (typeof resolvedLiteralColor === 'string') {
                if (resolvedLiteralColor.startsWith('#')) return hexToRgb(resolvedLiteralColor);
                const hex = namedColorsMap[resolvedLiteralColor.toLowerCase()];
                return hex ? hexToRgb(hex) : null;
            }
            if (typeof resolvedLiteralColor === 'object'
                && resolvedLiteralColor.r !== undefined) return resolvedLiteralColor;
            return null;
        }

        getAtomColor(atomIndex, effectiveColorMode = null) {
            if (atomIndex < 0 || atomIndex >= this.coords.length) {
                return DEFAULT_GREY;
            }
            // same rule as getColorOverride: a side chain is coloured as its
            // residue unless it was given a colour of its own
            const ownSc = this._sidechainColorOf(atomIndex);
            if (ownSc) return ownSc;
            atomIndex = this._colorPositionFor(atomIndex);

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
                        color = getRainbowColor(colorIndex, scale.min, scale.max,
                            this.colorblindMode, this.cyclicChains && this.cyclicChains.has(chainId));
                    } else {
                        // Fallback: if scale not found, use a default rainbow based on colorIndex
                        const colorIndex = (this.perChainIndices && atomIndex < this.perChainIndices.length ? this.perChainIndices[atomIndex] : 0) || 0;
                        color = getRainbowColor(colorIndex, 0, Math.max(1, colorIndex),
                            this.colorblindMode, this.cyclicChains && this.cyclicChains.has(chainId));
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

            // ...and, alongside them, what each END should be where the two
            // differ. The renderer cuts such a bond at its middle and paints the
            // halves from this.
            //
            // CARRIED ON THE COLOUR ARRAY, not in a field of its own. Colour
            // arrays are CACHED - recomputed only when one is missing, changes
            // length, or is explicitly invalidated - and there are two of them,
            // the plain one and the pLDDT one. A separate field is written only
            // by whichever function last ran, so a cached array would be served
            // beside halves belonging to a different segment list, or to the
            // other colour mode, and the half-colours landed on whatever bond
            // now sat at that index: carbon bonds coming out red. Riding on the
            // array makes that impossible - they are cached and invalidated as
            // one thing.
            const halves = new Array(m).fill(null);
            const out = this.segmentIndices.map((segInfo, segI) => {
                // Contacts use custom color if provided, otherwise yellow
                if (segInfo.type === 'C') {
                    if (segInfo.contactColor) {
                        return segInfo.contactColor; // Use custom color from contact file
                    }
                    return DEFAULT_CONTACT_COLOR; // Default yellow
                }

                const h = this._segmentElementHalves(segInfo);
                if (h && h.a && h.b && h.a === h.b) return h.a;
                const positionIndex = this._colorSegmentPosition(segInfo);
                // In overlay mode with per-frame colors, pass null so getAtomColor resolves per-atom
                const colorMode = usePerAtomColorMode ? null : effectiveColorMode;
                const base = this.getAtomColor(positionIndex, colorMode);
                if (h && h.a !== h.b) halves[segI] = { a: h.a || base, b: h.b || base };
                return base;
            });
            out.halves = halves;
            return out;
        }

        // Calculate pLDDT colors
        _calculatePlddtColors() {
            const m = this.segmentIndices.length;
            if (m === 0) return [];

            const colors = new Array(m);
            // see _calculateSegmentColors: the halves ride on the array
            colors.halves = new Array(m).fill(null);
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

                const elc = this._segmentElementColor(segInfo);
                if (elc) { colors[i] = elc; continue; }
                const hp = this._segmentElementHalves(segInfo);
                const positionIndex = this._colorSegmentPosition(segInfo);
                const type = segInfo.type;
                let color;

                // An EXPLICIT colour (selection tools, or set_color from
                // Python) wins over the pLDDT ramp. This array is built
                // straight from the pLDDT values and used INSTEAD of
                // _calculateSegmentColors, which is the path that consults the
                // colour hierarchy - so without this, overriding a colour did
                // nothing at all in plddt/deepmind mode, including the 'auto'
                // mode that resolves to plddt for an AlphaFold model.
                const ov = this.getColorOverride
                    ? this.getColorOverride(positionIndex) : null;
                if (ov) {
                    colors[i] = ov;
                    continue;
                }

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

                if (hp && hp.a !== hp.b) {
                    colors.halves[i] = { a: hp.a || color, b: hp.b || color };
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

            // CONTACTS: a fixed width, divided back out of the Line Width the
            // caller is about to multiply by, so the control cannot reach them.
            // Their own stored weight still scales it.
            if (type === 'C') {
                const lw = this.lineWidth || 3.0;
                const w = segInfo.contactWeight !== undefined ? segInfo.contactWeight : 1;
                return (CONTACT_WIDTH_A / lw) * w;
            }

            // A SIDE CHAIN IS NOT A LIGAND, even though it is drawn as ligand
            // positions so the ligand machinery can build it. TYPE_BASELINES
            // gives 'L' a deliberately thin 0.4 - a ligand is a guest and
            // should not out-weigh the chain it sits in - but a side chain is
            // part of its residue, and at 0.4 it came out as a hairline hanging
            // off a full-width backbone. This is what "side chains do not work
            // in tube mode" looked like: they were drawn all along, just far
            // too faint to read as part of the structure. See SIDECHAIN_WIDTH.
            if (type === 'L' && this.sidechainMap && this.sidechainMap.size
                && (this.sidechainMap.has(segInfo.idx1)
                    || this.sidechainMap.has(segInfo.idx2))) {
                return SIDECHAIN_WIDTH;
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
        }

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
        }

        // RENDER (Core drawing logic)
        /**
         * May a throw keep spinning after the user lets go?
         *
         * Two tests, and the second is the one that matters. A COASTING SPIN IS
         * NOT A GESTURE: isDragging is already false while it runs, so the
         * cartoon's gesture degrade does not apply and every coasting frame is
         * drawn at FULL cost - outline and all. On a structure that was only
         * just keeping up during the drag, letting go is therefore the most
         * expensive thing that can happen, and it goes on redrawing for a
         * second or more after the user has stopped asking for anything.
         *
         * So inertia is allowed only where a full-quality frame is actually
         * affordable, measured the same way the ink degrade measures it
         * (the cheapest of the last five inked frames - see the note there on
         * why the minimum and not the median), and never above the segment
         * cutoff. Cost is the honest test - a segment count says nothing about
         * canvas size, detail or the machine - but the count stays as a floor
         * for styles that never report a time.
         */
        _inertiaAllowed() {
            return this.smoothAnimationOk();
        }

        /**
         * Will the GPU draw this frame? Asked by anything that budgets a frame,
         * because the answer changes what a frame COSTS by more than an order of
         * magnitude and every cost heuristic here predates it.
         *
         * The conditions are the two draw hooks' own, kept together so they
         * cannot drift: the flag, a working WebGL2, and an entry point for the
         * current style. Still a guess and not a promise - the hook may decline
         * the frame for a reason only it can see (a lost context, an export
         * canvas) - so callers must stay correct if it turns out wrong. Every
         * caller does: they choose between two ways of drawing the same picture.
         */
        /* THE GPU TUBE FRAME, and everything it needs to draw one.
         *
         * The 2D tube pass and this one want almost disjoint things. The 2D
         * pass needs a depth order, per-endpoint cap flags and a projected
         * screen position for every atom, because it strokes the picture itself
         * with a painter that has no depth buffer. The GPU needs the segment
         * list, the colours and the view scale, and derives the rest on the
         * card. This method is that short list; the long one below it is what
         * the 2D pass still runs when this returns false.
         *
         * Returns false for anything it cannot do - no WebGL2, a lost context,
         * an export context - having done no work worth speaking of, so the
         * caller falls through to the full path unharmed.
         */
        /* WILL THE GPU TUBE PATH TAKE THIS FRAME? Asked before the rotation
         * loop, which is why it cannot simply be "did _tubeGPUFrame succeed".
         * It repeats the refusals _tubeGPUFrame itself makes, and like
         * _gpuWillDraw it is a guess: being wrong costs one rotation done late
         * rather than early, never a wrong picture.
         */
        _tubeGPUWillTake(ctx) {
            return this.style !== 'cartoon' && this._gpuWillTake(ctx);
        }

        /* The same question for either style, and the one the CLEAR depends on.
         * Same standing as _gpuWillDraw: a guess made before the attempt, whose
         * cost when wrong is a repaint, never a wrong picture.
         */
        _gpuWillTake(ctx) {
            if (this.cartoonGPU !== true) return false;
            const G = window.py2dmolCartoonGPU;
            if (!G) return false;
            if (this.style === 'cartoon') {
                if (typeof G.render !== 'function' || !window.py2dmolCartoon) return false;
            } else if (typeof G.renderTube !== 'function') return false;
            if (!ctx || !ctx.canvas || !ctx.drawImage || ctx.getSerializedSvg) return false;
            return ctx.canvas === this.canvas;
        }

        /* THE POINT THE VIEW TURNS ABOUT. O(1), and separate from the rotation
         * because a pan reads _viewCenter on the next gesture whether or not
         * anything was rotated this frame.
         */
        _computeViewCentre(object) {
            const globalCenter = (object && object.totalPositions > 0)
                ? object.globalCenterSum.mul(1 / object.totalPositions) : new Vec3(0, 0, 0);
            const c = this.viewerState.center || globalCenter;
            // A pan MOVES this point; remember it so the first drag has
            // something to move even when the view is still on the default
            // (null) centre.
            this._viewCenter = { x: c.x, y: c.y, z: c.z };
            return c;
        }

        /* EVERY POSITION INTO VIEW SPACE: the object's own rotation_matrix
         * (best_view) first, then the user's. Lifted out of _renderToContext
         * unchanged so that the GPU tube path can decide not to call it.
         */
        _rotateCoords(object, c) {
            this._rotPending = false;
            while (this.rotatedCoords.length < this.coords.length) {
                this.rotatedCoords.push(new Vec3(0, 0, 0));
            }
            const m = this.viewerState.rotation;
            const objectRotation = (object && object.rotation_matrix && object.center)
                ? object.rotation_matrix : null;
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
        }

        /* SETTLE A DEFERRED ROTATION. Called by everything that reads
         * rotatedCoords on a GPU frame: picking, the selection halo, and
         * renderApp when it rebuilds the cartoon mesh. Cheap and idempotent -
         * a no-op unless a frame actually skipped the loop.
         */
        _ensureRotated() {
            if (!this._rotPending) return;
            const object = this.objectsData[this.currentObjectName];
            if (object) this._rotateCoords(object, this._computeViewCentre(object));
            else this._rotPending = false;
        }

        /* PAY FOR THE SCREEN POSITIONS AT THE MOMENT SOMETHING READS THEM.
         *
         * On the GPU tube path the frame leaves an IOU rather than a
         * projection: rotatedCoords may be a view out of date and screenX and
         * friends may be unwritten. There are exactly two readers in the
         * codebase - pickResidueAt and _paintSelectionHalo - and both call this
         * first. A no-op on every other path, where the 2D pass has already
         * filled both as a side effect of drawing.
         */
        _ensurePickProjection() {
            this._ensureRotated();
            const p = this._pickPending;
            if (p) {
                this._pickPending = null;
                this._projectForPicking(p.dw, p.dh, p.scale);
            }
        }

        _tubeGPUFrame(ctx, displayWidth, displayHeight, colors, object) {
            const G = window.py2dmolCartoonGPU;
            if (!G || !G.renderTube) return false;
            // the same refusals renderTube makes, asked before spending
            // anything: an export wants the vector or the exact-size raster the
            // 2D pass produces, not a blit from a screen-sized canvas
            if (!ctx || !ctx.canvas || !ctx.drawImage || ctx.getSerializedSvg) return false;
            if (ctx.canvas !== this.canvas) return false;

            const segments = this.segmentIndices;
            const n = segments ? segments.length : 0;
            if (!n) return false;

            // WHICH SEGMENTS ARE DRAWN - and in no particular order, which is
            // the whole point of being here. The 2D pass sorts this list back
            // to front because its painter has nothing else to resolve overlap
            // with; the GPU has a depth buffer.
            //
            // KEPT BETWEEN FRAMES. The answer depends on the mask and the
            // segment list and on nothing else - not on the view - so turning
            // the model does not change it. Rescanning anyway cost 2.5 ms of a
            // 20 ms frame at 320,000 positions.
            //
            // Pointer comparison is exact here: viewer-mol.js only ever
            // ASSIGNS visiblePositions (null, a new Set, or a freshly combined
            // one) and rebuilds segmentIndices into a new array. Neither is
            // edited in place, so an unchanged pointer is an unchanged answer.
            const vis = this.visiblePositions;
            let order = this._gpuTubeOrder;
            let cnt;
            if (order && this._gpuTubeVisSrc === vis && this._gpuTubeSegSrc === segments
                    && this._gpuTubeSegN === n) {
                cnt = this._gpuTubeCount;
            } else {
                if (!order || order.length < n) order = this._gpuTubeOrder = new Int32Array(n);
                cnt = 0;
                for (let i = 0; i < n; i++) {
                    const s = segments[i];
                    let ok;
                    if (!vis) {
                        ok = true;
                    } else if (s.type === 'C' && s.contactIdx1 !== undefined
                            && s.contactIdx2 !== undefined) {
                        // a contact is visible with its ORIGINAL endpoints, not
                        // the intermediate positions it was expanded into
                        ok = vis.has(s.contactIdx1) && vis.has(s.contactIdx2);
                    } else {
                        ok = vis.has(s.idx1) && vis.has(s.idx2);
                    }
                    if (ok) order[cnt++] = i;
                }
                this._gpuTubeVisSrc = vis;
                this._gpuTubeSegSrc = segments;
                this._gpuTubeSegN = n;
                this._gpuTubeCount = cnt;
            }
            if (!cnt) return false;

            // THE VIEW SCALE, the one number from the block below that is still
            // needed up here: the GPU draws with it and a pan drag converts
            // screen pixels to Angstroms with it. Arithmetic, not a pass.
            const maxExtent = (object && object.maxExtent > 0) ? object.maxExtent : 30.0;
            const extent = this.viewerState.extent || maxExtent;
            const padding = 0.9;
            const baseScale = Math.min((displayWidth * padding) / (extent * 2),
                (displayHeight * padding) / (extent * 2));
            const scale = baseScale * this.viewerState.zoom;
            this._viewScale = scale;
            const pxScale = this._exportPxScale || 1;

            // renderShadows is FALSE and not a question. The CPU occlusion pass
            // is what this path exists to not run; the GPU computes its own from
            // a depth prepass, at a cost that follows pixels rather than
            // segments.
            if (!G.renderTube(this, ctx, displayWidth, displayHeight, {
                order, count: cnt, segments, segData: this.segData, colors,
                shadows: null, tints: null, renderShadows: false,
                outlineWidthPx: this.relativeOutlineWidth * pxScale,
            })) return false;

            // NOT PROJECTED NOW. Nothing in the picture needs screen
            // positions - the card has them - and the two things that do
            // (pickResidueAt, _paintSelectionHalo) run on an event, not on a
            // frame. What is recorded is enough to do it when one of them asks.
            this._pickPending = { dw: displayWidth, dh: displayHeight, scale };
            return true;
        }

        /* SCREEN POSITIONS FOR EVERYTHING THAT IS NOT THE PICTURE - picking,
         * the selection halo, the sequence overlay. The 2D pass writes these as
         * a side effect of projecting each segment's endpoints; nothing on the
         * GPU path projects on the CPU at all, so they are written here.
         *
         * A flat loop over positions rather than a walk over segment endpoints
         * with a per-position "did I already do this one" test: same answer,
         * and it was 6.3 ms of a 60 ms frame done the other way. The cartoon
         * path has its own version of this (projectPositions in
         * viewer-cartoon-gpu.js) for the same reason.
         */
        _projectForPicking(displayWidth, displayHeight, scale) {
            const np = this.coords.length;
            const sx = this.screenX; const sy = this.screenY;
            const sr = this.screenRadius; const sv = this.screenValid;
            if (!sx || !sv || sx.length < np) return;
            const rotated = this.rotatedCoords;
            this.screenFrameId++;
            const fid = this.screenFrameId;
            const cx = displayWidth / 2;
            const cy = displayHeight / 2;
            const persp = isPerspective(this.viewerState);
            const fl = this.viewerState.focalLength;
            const base = this.lineWidth * scale;
            const types = this.positionTypes;
            const tw = this.typeWidthMultipliers;
            const mask = this.visiblePositions;
            for (let i = 0; i < np; i++) {
                if (mask && !mask.has(i)) { sv[i] = 0; continue; }
                const v = rotated[i];
                let pe = 1;
                if (persp) {
                    const dz = fl - v.z;
                    if (dz <= 0.1) { sv[i] = 0; continue; }
                    pe = fl / dz;
                }
                const wm = (types && tw && tw[types[i]]) || 0.5;
                sx[i] = cx + v.x * scale * pe;
                sy[i] = cy - v.y * scale * pe;
                sr[i] = Math.max(2, base * wm * 0.5 * pe);
                sv[i] = fid;
            }
        }

        _gpuWillDraw() {
            if (this.cartoonGPU !== true) return false;
            const G = window.py2dmolCartoonGPU;
            if (!G || typeof G.available !== 'function' || !G.available()) return false;
            return this.style === 'cartoon'
                ? (typeof G.render === 'function' && !!window.py2dmolCartoon)
                : typeof G.renderTube === 'function';
        }

        /**
         * Can this structure carry a SMOOTH ANIMATION - one that draws many
         * frames in a row at full quality and is judged on whether it flows?
         *
         * Three things ask: inertia after a throw, the orient fly-to, and any
         * future tween. They all fail the same way. An animation that cannot
         * hold a frame rate does not read as slow, it reads as BROKEN - a
         * one-second orient at 80 ms a frame is twelve frames, which is a
         * slideshow, and a throw that stutters feels like the viewer has locked
         * up. Jumping straight to the answer is not a degraded version of the
         * animation, it is the better outcome.
         *
         * Two tests, because they catch different things. The measured cost is
         * the honest one - it knows about canvas size, detail and the machine,
         * none of which a count does. It is also the one that goes stale, so
         * the history behind it is keyed on the canvas as well as the object.
         * The segment count is a floor for the styles and first frames that
         * have never reported a cost.
         */
        smoothAnimationOk() {
            let visible = this.segmentIndices ? this.segmentIndices.length : 0;
            if (this.visiblePositions && this.segmentIndices) {
                visible = 0;
                for (let i = 0; i < this.segmentIndices.length; i++) {
                    const seg = this.segmentIndices[i];
                    if (this.visiblePositions.has(seg.idx1)
                        && this.visiblePositions.has(seg.idx2)) {
                        visible++;
                    }
                }
            }
            // THE SEGMENT FLOOR IS A COST MODEL FOR THE 2D PATH, and it stops
            // being true the moment the GPU is drawing. A thousand segments is
            // roughly where a canvas repaint stops keeping up; the GPU draws
            // 3431 of them in ~3 ms, so the count says nothing about whether
            // this structure can hold a frame rate. Left in, the floor vetoed
            // inertia and turned the orient fly-to into a jump on anything past
            // the cutoff - and switching side chains on is enough to cross it,
            // which is exactly what "acceleration is disabled during
            // interactions" looked like from the outside.
            //
            // The MEASURED test below still applies, to both backends. That one
            // is honest: it asks what frames actually cost on this machine at
            // this canvas size, which is the question, and it will veto a GPU
            // frame too if the GPU turns out to be slow here.
            if (!this._gpuWillDraw() && visible > this.LARGE_MOLECULE_CUTOFF) return false;
            return !this._frameOverBudget();
        }

        /**
         * Is a full-quality frame too expensive to draw during a gesture?
         * The cartoon plugin records the CHEAPEST of the last five INKED frames
         * as _lastInkedMs - every source of noise here only ever makes a frame
         * slower, so the cheapest of them is the one paying for the drawing
         * alone. Undefined means nothing has reported a cost yet (a style that
         * does not measure, or the very first frame), and an unknown cost is
         * not evidence of a slow one.
         */
        _frameOverBudget() {
            const budget = (typeof this.cartoonGestureInk === 'number')
                ? this.cartoonGestureInk : 25;
            // The same three-sample rule the ink degrade uses. A drag's or an
            // orient's FIRST full-quality frame is its most expensive - JIT and
            // cold caches - and vetoing the animation on that one sample is how
            // a structure that animates perfectly well got jumped instead of
            // flown. The plugin excludes cache-building frames from the history
            // outright; this guards the warm-up frames that follow one.
            const hist = this._inkedMs;
            if (!hist || hist.length < 3) return false;
            return this._lastInkedMs !== undefined && this._lastInkedMs > budget;
        }

        /**
         * A gesture that dropped the outline has to put it back. Without this
         * the last degraded frame is simply what stays on screen once the
         * gesture ends, and the outline never returns until something else
         * happens to redraw. One settle rather than a hook in each gesture
         * handler - there are four (mouseup, two touch paths, and the zoom
         * timeout, which does not re-render at all), and one settle also covers
         * gestures none of them know about.
         *
         * It RESCHEDULES while a gesture is still running rather than returning.
         * Bailing out was a real bug: the timer only has to land inside a
         * still-running gesture once - trivial during a slow scroll or a long
         * drag - and the settle was then lost for good, leaving the outline off
         * until something unrelated redrew.
         */
        _scheduleSettle() {
            clearTimeout(this._inkSettleTimer);
            this._inkSettleTimer = setTimeout(() => {
                if (this.isDragging || this.isZooming) {
                    this._scheduleSettle();
                    return;
                }
                if (!this._inkSkipped) return;
                this._inkSkipped = false;
                this.render('gestureSettle');
            }, 140);
        }

        render(reason = 'Unknown') {
            if (this.currentFrame < 0) {
                // Clear canvas if no frame is set
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                return;
            }
            this._renderToContext(this.ctx, this.displayWidth, this.displayHeight);
            if (this._inkSkipped) this._scheduleSettle();
        }

        // Core rendering logic - can render to any context (canvas, SVG, etc.)
        _renderToContext(ctx, displayWidth, displayHeight) {
            // Clear the full canvas in device pixels, independent of current transform
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            if (this.isTransparent) {
                ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            } else {
                ctx.fillStyle = this.backgroundColor || '#ffffff';
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

            // THE VIEW CENTRE IS ALWAYS FRESH - a pan reads it on the next
            // gesture, so it cannot be deferred with the rotation below. It is
            // O(1); the rotation is O(positions).
            const c = this._computeViewCentre(object);

            // ROTATING EVERY POSITION, UNLESS THE GPU IS ABOUT TO TAKE THE FRAME.
            //
            // Neither GPU path reads rotatedCoords to draw with. The tube's
            // instances are model space and the vertex shader turns them; the
            // cartoon draws a mesh that is already on the card and projects its
            // overlay positions from its own captured copy. What still needs
            // this array is PICKING, the selection halo, and a cartoon REBUILD
            // - none of which happens on most frames. So it is deferred to
            // whoever actually asks (_ensureRotated, reached through
            // _ensurePickProjection and from renderApp's rebuild branch) rather
            // than done 60 times a second on the chance that someone will.
            // 4.3 ms of a 20 ms frame at 320,000 positions.
            //
            // A guess, like _gpuWillDraw: if the GPU then declines the frame
            // the 2D pass below needs the array after all, and both branches
            // settle up before falling through.
            const deferRot = this._gpuWillTake(ctx);
            if (deferRot) this._rotPending = true; else this._rotateCoords(object, c);
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

            // GHOST WHAT THE CLIP BOX WOULD CUT. Through the COLOURS, not
            // through an alpha: both styles already take this array, and the
            // GPU treats a colour change as three texels a segment rather than
            // a rebuild - so the box can be dragged without the mesh being
            // rebuilt behind it. Per-position colour overrides would have done
            // the same job and cost a full rebuild per drag frame, because they
            // mark the GPU palette incomplete.
            if (this.clipEditing && this.clipBox) colors = this._clipGhostColors(colors);

            // STYLE DELEGATION: 'cartoon' replaces the entire draw stage below.
            // The cartoon renderer (viewer-cartoon.js) reuses the rotation and
            // per-segment colors computed above, plus this renderer's projection
            // parameters, and paints its own primitives (SS ribbons + tubes).
            if (this.style === 'cartoon'
                && window.py2dmolCartoon) {
                // THE GPU PATH, when it is asked for and it works. It paints
                // the same drawing from a mesh that lives on the card, so
                // turning the model is one draw call instead of a full repaint.
                // Everything after it here is unchanged: the halo, the sequence
                // overlay and both exports stay on the path they are on today,
                // because the GPU replaces the DRAW and not the frame.
                //
                // It returns false rather than throwing for anything it cannot
                // do - no WebGL2, a lost context, an export context, a shader
                // that will not link on some driver - and the 2D renderer below
                // then draws the frame as if the option had never been set.
                const gpuOk = this.cartoonGPU === true
                    && window.py2dmolCartoonGPU
                    && window.py2dmolCartoonGPU.render(this, ctx,
                        displayWidth, displayHeight, colors);
                // WHICH PATH DREW THIS FRAME. The GPU declining is silent by
                // design - that is the point of returning false - but it makes
                // the two paths indistinguishable from outside, and they differ
                // by more than an order of magnitude on a large structure.
                // Timing a render without knowing which one ran measures
                // nothing: on a 305,000-position assembly the same operation
                // read 740 ms and 0 ms on consecutive runs, purely because the
                // GPU was available in one and not the other.
                this.gpuDrewLastFrame = !!gpuOk;
                if (!gpuOk) {
                    // it declined: the 2D renderer below is built on rotatedCoords
                    this._ensureRotated();
                    window.py2dmolCartoon.render(this, ctx, displayWidth, displayHeight, colors);
                }
                // A real frame supersedes any snapshot taken from an older one.
                this._invalidateSelectionPreview();
                // over the finished drawing, so it is never occluded
                this._paintOverlays(ctx, this._exportPxScale || 1, true);
                return;
            }

            // THE TUBE STYLE ON THE GPU, TAKEN BEFORE THE 2D RECKONING.
            //
            // It used to be taken at the bottom, beside the stroking loop it
            // replaces, on the reasoning that everything it needs is decided by
            // then. That was true and it was still wrong: almost nothing it
            // needs is decided there. Measured on 4UG0 (17,789 positions), a
            // 60 ms GPU tube frame spent 15.5 ms sorting by depth, 10.7 ms
            // deciding which endpoints get round caps, 6.3 ms projecting
            // positions and 3.8 ms on depth normalisation - 36 ms of a 60 ms
            // frame computing answers the GPU throws away. The depth buffer
            // sorts, buildTube derives its own caps from the topology, and the
            // vertex shader projects. The actual GL work was 0.4 ms.
            //
            // So the branch moved up here, beside the cartoon one, and the
            // whole block below it is now what runs only when the GPU declines
            // the frame - which it still can, and then nothing above has been
            // skipped that the 2D pass needs.
            const tubeGPUTook = deferRot
                && this._tubeGPUFrame(ctx, displayWidth, displayHeight, colors, object);
            // see gpuDrewLastFrame in the cartoon branch: the two paths differ
            // by more than an order of magnitude and decline silently, so a
            // frame time means nothing without knowing which one produced it
            if (deferRot) this.gpuDrewLastFrame = tubeGPUTook;
            if (deferRot && !tubeGPUTook) {
                // declined - the 2D pass below reads what was skipped above
                this._ensureRotated();
            } else if (deferRot) {
                this._invalidateSelectionPreview();
                this._paintOverlays(ctx, this._exportPxScale || 1, true);
                return;
            }

            // Get visibility mask early to build visible segment list
            const visiblePositions = this.visiblePositions;

            // Build list of visible segment indices early - this is the key optimization
            // A segment is visible if both positions are visible (or no mask = all visible)
            // For contact segments, check visibility based on original contact endpoints, not intermediate positions
            const visibleSegmentIndices = [];
            for (let i = 0; i < n; i++) {
                const segInfo = segments[i];
                let isVisible = false;

                if (!visiblePositions) {
                    // No mask = all segments visible (including overlay mode with no selection)
                    isVisible = true;
                } else if (segInfo.type === 'C' && segInfo.contactIdx1 !== undefined && segInfo.contactIdx2 !== undefined) {
                    // For contact segments, check visibility based on original contact endpoints
                    isVisible = visiblePositions.has(segInfo.contactIdx1) && visiblePositions.has(segInfo.contactIdx2);
                } else {
                    // For regular segments, check visibility based on segment endpoints
                    // In overlay mode, the visibility mask has been expanded to include all corresponding positions
                    isVisible = visiblePositions.has(segInfo.idx1) && visiblePositions.has(segInfo.idx2);
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
            if (!visiblePositions) {
                // All positions are visible
                numVisiblePositions = this.coords.length;
            } else {
                // Count positions in visibility mask
                numVisiblePositions = visiblePositions.size;
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

            // WILL THE GPU TAKE THIS FRAME? It changes when the occlusion is
            // worth computing, not whether.
            //
            // `shadows` and `tints` ARE the style: every segment tested against
            // everything in front of it, which is what makes a buried loop sit
            // behind an exposed one. Nothing cheap looks like it - a depth ramp
            // darkens the whole back of the structure including the parts that
            // are plainly in the open - so the GPU keeps using these exact
            // numbers rather than an approximation of them.
            //
            // What it does not do is recompute them mid-gesture. The pass is
            // ~90% of a tube frame (9FOG: 67 ms against 6.8 ms without), and
            // this is already the policy for large structures, where the
            // occlusion is allowed to go stale during a drag and is brought up
            // to date the moment the view settles. Occlusion changes slowly
            // under rotation, so the staleness is nearly invisible; the cost is
            // not. On the GPU path the drawing itself is ~1 ms, so that policy
            // has to apply at EVERY size or the occlusion is the whole frame.
            //
            // Deliberately a guess, not a promise: renderTube may still decline
            // the frame, and the 2D pass then draws with whatever these hold -
            // possibly a gesture out of date, never wrong.
            const gpuWillDraw = this._gpuWillDraw();
            // The GPU computes its own occlusion now - a depth prepass and one
            // screen-space pass, whose cost is a function of pixels rather than
            // of segments - so the CPU pass is not just deferred but skipped.
            // That is the whole speed argument: this pass is ~90% of a tube
            // frame and it grows with the structure.
            const renderShadows = this.shadowEnabled && !gpuWillDraw;
            const maxExtent = (object && object.maxExtent > 0) ? object.maxExtent : 30.0;

            const shadows = new Float32Array(n);
            const tints = new Float32Array(n);

            // Initialize shadows and tints to default values (no shadow, no tint)
            // These will be overwritten by shadow calculation or cache, but initialize for safety
            shadows.fill(1.0);
            tints.fill(1.0);

            // Limit number of rendered segments for performance
            const RENDER_CUTOFF = 1000000; // Fully opaque segments


            // Allocation-free sorting
            // Sort visibleSegmentIndices in-place using zValues lookup
            // This avoids creating N objects and 2 intermediate arrays per frame
            // Sort by z-depth (back to front)
            visibleSegmentIndices.sort((a, b) => zValues[a] - zValues[b]);

            // Use the sorted array directly
            let visibleOrder = visibleSegmentIndices;

            // Apply culling immediately after sorting
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

            // Removed redundant 'order' array sorting
            // Previously we sorted all N segments here, but it was never used for rendering
            // This saves O(N log N) operations and significant memory allocation

            // visiblePositions already declared above for depth calculation

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
            // the scale this style drew at, for converting a pan drag from
            // screen pixels to Angstroms
            this._viewScale = scale;

            // baseLineWidth is this.lineWidth (in Angstroms) converted to pixels
            const baseLineWidthPixels = this.lineWidth * scale;
            // Outline width is set in PIXELS, so unlike everything derived from
            // Angstroms it does not follow the output resolution on its own. An
            // export renders the view at its own (larger) size, which would
            // leave a 300 dpi PNG with the same 3px outline around a structure
            // drawn three times bigger - a hairline where the screen shows a
            // firm edge. Scaling it here keeps the ratio the user set.
            const pxScale = this._exportPxScale || 1;
            const outlineWidthPx = this.relativeOutlineWidth * pxScale;

            const centerX = displayWidth / 2;
            const centerY = displayHeight / 2;

            // ====================================================================
            // DETECT OUTER ENDPOINTS - For rounded edges on outer segments
            // ====================================================================
            // Build a map of position connections to identify outer endpoints
            // Allocation-free endpoint detection
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
            // Use Uint8Array for flags instead of Map
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

            // SoA Projection Loop
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

                if (isPerspective(this.viewerState)) {
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

            // Ensure highlighted atoms are projected even if not in visible segments
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

            // THE GPU TUBE FRAME WAS OFFERED THIS FRAME AND DECLINED IT.
            //
            // It used to be offered here instead, which meant a frame the GPU
            // did take had still paid for the depth sort, the cap flags and the
            // projection above - 36 ms of a 60 ms frame on 4UG0, all of it
            // discarded. The offer now happens before any of that
            // (_tubeGPUFrame), so reaching this line means WebGL2 is absent,
            // the context is lost, or this is an export - and the stroking loop
            // below is the answer, unchanged.

            // Simplified loop - visibleOrder is already culled
            // Only iterate over visible segments - no need for visibility check inside loop
            for (let i = 0; i < numRendered; i++) {
                const idx = visibleOrder[i];

                // Calculate opacity based on position in visibleOrder
                // i=0 is furthest (start of sliced array), i=numRendered-1 is closest
                // Distance from front: numRendered - 1 - i
                const distFromFront = numRendered - 1 - i;
                // NO IN-GEOMETRY SELECTION INK. This used to recolour the
                // style's own outline pass, which put the selection into the
                // depth sort: a selected residue behind anything was hidden by
                // it. _paintSelectionHalo draws over the finished frame
                // instead and cannot be occluded.
                //
                // Kept as a null rather than torn out, matching selInk in
                // viewer-cartoon.js - both go when the ink path does.
                const selSet = null;
                const isSel = !!(selSet
                    && (selSet.has(segments[idx].idx1) || selSet.has(segments[idx].idx2)));

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

                // OFF-SCREEN CULL. "Visible" above means the user has not hidden
                // it; nothing until now asked whether it is actually on the
                // canvas. Zoomed in, most of a structure is outside the viewport
                // and every one of those segments was still being stroked for
                // the canvas to clip away. The margin covers the stroke's own
                // half-width plus its outline, so a segment whose centreline is
                // just outside still draws the part that reaches back in.
                {
                    const m = (baseLineWidthPixels
                        * this._calculateSegmentWidthMultiplier(segData[idx], segInfo)
                        + outlineWidthPx) / 2 + 2;
                    if ((x1 < -m && x2 < -m)
                        || (x1 > displayWidth + m && x2 > displayWidth + m)
                        || (y1 < -m && y2 < -m)
                        || (y1 > displayHeight + m && y2 > displayHeight + m)) {
                        continue;
                    }
                }


                // Width Calculation: unified approach using helper
                const s = segData[idx];
                const widthMultiplier = this._calculateSegmentWidthMultiplier(s, segInfo);
                let currentLineWidth = baseLineWidthPixels * widthMultiplier;

                if (isPerspective(this.viewerState)) {
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

                const outlineCol = isSel ? SELECTION_INK_CSS : gapFillerColor;
                if (this.outlineMode !== 'none' || isSel) {
                    // --- 2-STEP DRAW (Outline) ---
                    const totalOutlineWidth = currentLineWidth + (isSel
                        ? Math.max(outlineWidthPx, SELECTION_INK_EXTRA * pxScale)
                        : outlineWidthPx);

                    // For zero-length segments, draw single outline circle
                    if (segInfo.idx1 === segInfo.idx2) {
                        const outlineRadius = totalOutlineWidth / 2;
                        ctx.beginPath();
                        ctx.arc(x1, y1, outlineRadius, 0, Math.PI * 2);
                        ctx.fillStyle = outlineCol;
                        ctx.fill();
                    } else {
                        // Pass 1: Gap filler outline (butt caps)
                        ctx.beginPath();
                        ctx.moveTo(x1, y1);
                        ctx.lineTo(x2, y2);
                        setCanvasProps(outlineCol, totalOutlineWidth, 'butt');
                        ctx.stroke();

                        // Add rounded caps at outer endpoints if full outline mode
                        if (this.outlineMode === 'full' || isSel) {
                            const outlineRadius = totalOutlineWidth / 2;
                            if (hasOuterStart) {
                                ctx.beginPath();
                                ctx.arc(x1, y1, outlineRadius, 0, Math.PI * 2);
                                ctx.fillStyle = outlineCol;
                                ctx.fill();
                            }
                            if (hasOuterEnd) {
                                ctx.beginPath();
                                ctx.arc(x2, y2, outlineRadius, 0, Math.PI * 2);
                                ctx.fillStyle = outlineCol;
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
            // Removed redundant position loop
            // Screen positions are already computed in SoA arrays (screenX, screenY, screenRadius)
            // during the projection phase above.
            // The sequence viewer will access these arrays directly.

            // A real frame supersedes any snapshot taken from an older one.
            this._invalidateSelectionPreview();
            // over the finished drawing, so it is never occluded
            this._paintOverlays(ctx, this._exportPxScale || 1, true);
        }

        // Public API for highlights
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
                // ONE RULE FOR INERTIA, and this is not where it lives. This
                // counted visible segments against the cutoff itself - the same
                // arithmetic as smoothAnimationOk() but WITHOUT its measured
                // cost test, so the two could and did disagree: _inertiaAllowed
                // was documented as the rule while this copy quietly decided it.
                // Asking the rule means the GPU exemption applies here too.
                const enableInertia = this._inertiaAllowed();

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

            // 2. Handle auto-rotate (skip while actively dragging, or while the
            // save panel is open - see _pauseForSavePanel)
            if (!this.isDragging && this.autoRotate && !this._uiPaused
                && this.spinVelocityX === 0 && this.spinVelocityY === 0) {
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

        /**
         * Save the current view as an image.
         *
         * opts.format    'svg' | 'svgz' | 'png'
         * opts.dpi       PNG only; CSS pixels are 96 dpi, so this is the scale
         *
         * Detail is NOT forced up for an export. Subdivision is capped by how
         * big a residue is in the OUTPUT (see subCapCur in viewer-cartoon.js),
         * so a PNG at 300 dpi already gets three times the subdivision of the
         * screen, and on a large structure the extra stations the old "max
         * detail" option added were finer than a pixel either way.
         *
         * EXPORTS ARE ALWAYS TRANSPARENT, whatever the viewer background is set
         * to. A saved figure goes into a document whose page colour is not ours
         * to choose, and a baked-in white rectangle is far more annoying to
         * remove than a transparent one is to fill. The dark preset in
         * particular would otherwise export a black slab.
         */
        saveImage(opts) {
            const o = opts || {};
            // PNG unless asked otherwise. The panel offers SVG alongside it
            // everywhere except in Draw mode, where the look is made of
            // sub-pixel pencil and translucent stains and PNG is simply what it
            // is (see the panel for the argument).
            const format = o.format || 'png';
            const dpi = Math.max(36, Math.min(1200, Number(o.dpi) || 300));

            const prevTransparent = this.isTransparent;
            this.isTransparent = true;
            const restore = () => {
                this.isTransparent = prevTransparent;
                try { this.render(); } catch (e) { /* view is cosmetic here */ }
            };

            try {
                const canvas = this.canvas;
                if (!canvas) throw new Error('Canvas not found');
                const width = this.displayWidth || parseInt(canvas.style.width) || canvas.width;
                const height = this.displayHeight || parseInt(canvas.style.height) || canvas.height;

                if (format === 'png') {
                    // CSS px are 96 dpi by definition, so the scale IS dpi/96.
                    // Clamped so a stray 4-digit dpi cannot ask for a canvas the
                    // browser refuses to allocate - which fails as a silently
                    // blank image rather than an error.
                    let k = dpi / 96;
                    const maxPx = 16000;
                    if (width * k > maxPx || height * k > maxPx) {
                        k = Math.min(maxPx / width, maxPx / height);
                    }
                    const out = document.createElement('canvas');
                    out.width = Math.max(1, Math.round(width * k));
                    out.height = Math.max(1, Math.round(height * k));
                    const octx = out.getContext('2d');
                    // Render AT the output size rather than scaling a
                    // screen-sized drawing up: the subdivision cap then sees
                    // the real resolution, which is what makes a 300 dpi export
                    // genuinely smoother rather than merely larger.
                    // _exportPxScale tells the renderers how much bigger this
                    // is than the view, so the quantities that are PIXELS by
                    // definition - outline width, selection ink, the thickness
                    // fade's screen-size test - keep the size they have on
                    // screen. Everything else is Angstroms and follows the
                    // resolution by itself.
                    this._exportPxScale = k;
                    try {
                        this._renderToContext(octx, out.width, out.height);
                    } finally {
                        this._exportPxScale = 1;
                    }
                    const objectName = this.currentObjectName;
                    out.toBlob((blob) => {
                        if (!blob) {
                            if (typeof setStatus === 'function') setStatus('PNG export failed', true);
                            return;
                        }
                        const filename = this._generateFilename(objectName, 'png');
                        this._triggerDownload(blob, filename);
                        if (typeof setStatus === 'function') {
                            setStatus(`PNG exported to ${filename} `
                                + `(${out.width}x${out.height}, ${Math.round(k * 96)} dpi)`);
                        }
                    }, 'image/png');
                    restore();
                    return;
                }

                if (typeof C2S === 'undefined') throw new Error('canvas2svg library not loaded');
                const svgCtx = new C2S(width, height);
                this._renderToContext(svgCtx, width, height);
                const svgString = svgCtx.getSerializedSvg();
                const objectName = this.currentObjectName;

                if (format === 'svgz' && typeof CompressionStream !== 'undefined') {
                    // .svgz: the same bytes through the browser's native gzip.
                    // Async, so it downloads from the promise; errors fall back
                    // to the plain path rather than losing the export.
                    new Response(
                        new Blob([svgString]).stream()
                            .pipeThrough(new CompressionStream('gzip'))
                    ).blob().then((gz) => {
                        const filename = this._generateFilename(objectName, 'svgz');
                        this._triggerDownload(
                            new Blob([gz], { type: 'image/svg+xml' }), filename);
                        if (typeof setStatus === 'function') {
                            setStatus(`SVGZ exported to ${filename}`);
                        }
                    }).catch(() => this._downloadSvg(svgString, objectName));
                    restore();
                    return;
                }

                this._downloadSvg(svgString, objectName);
                restore();
            } catch (e) {
                restore();
                console.error('Failed to export image:', e);
                const msg = `Error exporting image: ${e.message}`;
                if (typeof setStatus === 'function') setStatus(msg, true);
                else alert(msg);
            }
        }

        /** Deprecated: kept so existing callers and saved pages keep working. */
        saveAsSvg(compress) {
            this.saveImage({ format: compress ? 'svgz' : 'svg' });
        }

        /**
         * Save panel, opened by the camera button.
         *
         * Built in JS rather than as markup so the standalone HTML export - which
         * ships none of the app's CSS or panels - gets the same menu, and so
         * pages exported before this existed still work. It is inserted IN FLOW
         * under the button's row, the way the Style panel is, rather than
         * floating over the canvas: a floating layer has to be positioned and
         * repositioned against scroll and resize, and gets it wrong the first
         * time it is opened near an edge.
         *
         * The Save button copies its class list from the camera button, so it
         * inherits whatever button styling the host page uses (btn-toggle here,
         * controlButton in the standalone viewer) instead of guessing.
         */
        /**
         * Record ONE FULL TURN as a video that loops seamlessly.
         *
         * The loop is the whole point, so the frames cover [0, 360) and stop one
         * step SHORT of 360: a frame at exactly 360 degrees is the same picture
         * as the frame at 0, and playing both back-to-back stutters on every
         * repeat. With the last frame one step short, wrapping round to the
         * first continues the same constant angular step.
         *
         * Each frame is built as Ry(i * step) * R0 from the ORIGINAL matrix
         * rather than by multiplying the previous frame again, so rounding
         * cannot accumulate and leave the turn a fraction of a degree short of
         * closing - which would show up as a jump exactly once per loop.
         */
        // --- HAND-DRAWN BUILD-UP ------------------------------------------
        // Reveals the picture the way an illustrator builds one: graphite
        // under-drawing first, colour wash over it, ink line last, with the
        // pencil erased at the end. Each layer sweeps N->C along the chain, so
        // the hand follows the molecule rather than wiping across the canvas.
        //
        // The layers OVERLAP in time on purpose. Nobody finishes sketching the
        // whole page before opening the paints - the wash follows a little way
        // behind the pencil, and the pen follows the wash - and that overlap is
        // most of what makes it look like someone working rather than three
        // separate animations played in sequence.
        //
        // All of it is a gate on the normal render (see _drawAnim in
        // viewer-cartoon.js): every frame is an ordinary depth-sorted drawing
        // of the part that exists so far, so occlusion stays correct and the
        // final frame is EXACTLY the normal picture, not an approximation of
        // it that happens to look close.
        // WHERE EVERY LAYER IS AT TIME t (0..1 over the run). Pulled out of the
        // animation loop because two things drive it: the live animation, off
        // requestAnimationFrame, and the video recorder, which steps t itself
        // at a fixed frame rate. Both have to produce identical pictures.
        //
        // Phase windows are [start, end] fractions of the run.
        _drawAnimAt(t) {
            // THE PENCIL GETS HALF THE RUN, in one continuous sweep - it is
            // where the drawing is made, and the colour only follows it. The
            // wash starts a beat after the pencil finishes, so the completed
            // line drawing stands on its own for a moment before the colour
            // begins to go over it.
            //
            // The paint dims the graphite under it but never removes it (see
            // the pencil pass in viewer-cartoon.js), so these windows decide
            // how long any part of the picture spends as bare pencil before the
            // colour arrives, and nothing after that.
            const SKETCH = [0.00, 0.50];
            const WASH = [0.56, 0.94];
            // ...and then nothing, for the last twentieth of the run: the
            // picture is complete and STILL for a beat before the clock stops,
            // so it reads as finished rather than as cut off.
            //
            // TWO LAYERS, AND NOTHING AFTER THEM. The look this arrives at is
            // watercolour over pencil, so the run has exactly two things to do
            // and then it is done. An earlier version faded a dark outline in
            // at the end and rubbed the pencil out under it - which is how an
            // INKED illustration is made, and it threw away the thing being
            // made on the way there.
            const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1
                : u * u * (3 - 2 * u));       // smoothstep: starts and ends gently
            const span = (w) => ease((t - w[0]) / (w[1] - w[0]));
            // Where each hand has got to, as a fraction of the chain. Nothing
            // else varies over a run: how the pencil and the paint LOOK is the
            // renderer's business (viewer-cartoon.js), and none of it changes
            // with time.
            return { sketch: span(SKETCH), wash: span(WASH) };
        }

        animateDrawing(opts) {
            const o = opts || {};
            const ms = Math.max(500, Math.min(60000, Number(o.duration) || 12000));
            if (this._drawAnimRaf) {          // pressed again: skip to the end
                this.stopDrawing();
                return;
            }
            if (!this._canDraw()) return;
            if (this.drawCheckbox) this.drawCheckbox.checked = true;
            // Resuming picks up where the pause left off rather than starting
            // over - the drawing on screen is the one being continued. Pressing
            // Draw while a finished painting is up replays it from blank paper,
            // since `from` defaults to 0.
            const from = Math.max(0, Math.min(1, Number(o.from) || 0));
            const clock = () => (typeof performance !== 'undefined'
                ? performance.now() : Date.now());
            const t0 = clock() - from * ms;
            const step = () => {
                const t = Math.min(1, (clock() - t0) / ms);
                this._drawT = t;
                this._drawAnim = this._drawAnimAt(t);
                this.render('animateDrawing');
                // Finished: the clock stops but the picture stays as it was
                // painted. Draw remains on - it is now what is holding the
                // watercolour on screen - so the save button also goes on
                // offering to record the run.
                if (t >= 1) {
                    if (this._drawAnimRaf) cancelAnimationFrame(this._drawAnimRaf);
                    this._drawAnimRaf = null;
                    this._drawT = 1;
                    return;
                }
                this._drawAnimRaf = requestAnimationFrame(step);
            };
            this._drawAnimRaf = requestAnimationFrame(step);
        }

        // Shared gate: the build-up is a cartoon-style thing.
        _canDraw() {
            if (this.style === 'cartoon') return true;
            const msg = 'The drawing animation needs the cartoon style.';
            if (typeof setStatus === 'function') setStatus(msg, true);
            this.drawMode = false;
            if (this.drawCheckbox) this.drawCheckbox.checked = false;
            this._syncSaveButtonMode();
            return false;
        }

        // Ends the build-up and returns to the ordinary picture. Safe to call
        // at any point - during a drag, on a style change, or from the button.
        stopDrawing() {
            if (this._drawAnimRaf) cancelAnimationFrame(this._drawAnimRaf);
            this._drawAnimRaf = null;
            if (this._drawAnim) {
                this._drawAnim = null;
                this.render('stopDrawing');
            }
        }

        // OPENING THE SAVE PANEL PAUSES WHATEVER IS RUNNING. The panel exists
        // to set up a recording of that very animation, so leaving it running
        // underneath is both distracting and pointless - and for the drawing it
        // was worse than that: a run finishing while the panel was open turned
        // the mode off, which took the panel with it. Frozen, the picture on
        // screen is also a fair preview of what is about to be recorded.
        //
        // Nothing is cancelled here. The drawing keeps its state and its
        // position in the run, so dismissing the panel carries on from where it
        // stopped, while pressing Record restarts it from blank paper.
        _pauseForSavePanel() {
            this._uiPaused = true;
            if (this._drawAnimRaf) {
                cancelAnimationFrame(this._drawAnimRaf);
                this._drawAnimRaf = null;
                this._drawPausedAt = this._drawT || 0;
            } else {
                // Nothing running - either the painting is finished or Draw is
                // off. Marked complete so dismissing the panel does not restart
                // a run from a position left over from an earlier pause.
                this._drawPausedAt = 1;
            }
        }

        _resumeFromSavePanel() {
            if (!this._uiPaused) return;
            this._uiPaused = false;
            // Only a paused-mid-run drawing needs restarting; auto-rotate picks
            // itself up again from the flag alone.
            if (this.drawMode && this._drawAnim && !this._drawRecording
                && this._drawPausedAt < 1) {
                this.animateDrawing({ from: this._drawPausedAt });
            }
        }

        // Auto-rotate goes on and off from several places - the checkbox, a
        // mouse drag, a touch drag - and each has to keep the checkbox AND the
        // save button in step, because that button records a rotation while it
        // is on. Dragging used to set the flag and the checkbox directly, which
        // left the button offering to record a rotation that had stopped.
        _setAutoRotate(on) {
            this.autoRotate = !!on;
            if (this.rotationCheckbox) this.rotationCheckbox.checked = this.autoRotate;
            this._syncSaveButtonMode();
        }

        // Draw is a MODE, like auto-rotate. It stays on after the run finishes,
        // because what it is holding on screen is the painting - the runs, the
        // off-register colour, the whole watercolour. Turning it off is what
        // takes the viewer back to its ordinary picture, and while it is on the
        // save button offers to record the run rather than save an image (see
        // _syncSaveButtonMode), so a recording is always one press away.
        setDrawMode(on) {
            this.drawMode = !!on;
            if (this.drawCheckbox) this.drawCheckbox.checked = this.drawMode;
            if (this.drawMode) {
                if (!this._canDraw()) { this.drawMode = false; return; }
                this._syncSaveButtonMode();
                this.animateDrawing();
            } else {
                this.stopDrawing();
                this._syncSaveButtonMode();
            }
        }

        // Record the build-up to a video file. Reached from the save button,
        // which reads Save Video while Draw is on - the same way auto-rotate
        // turns it into a recorder for a turn.
        //
        // Frames are stepped HERE, on a timer, rather than recorded off the
        // live animation - the same choice saveRotationVideo makes, for the
        // same two reasons. One rendered frame becomes one video frame however
        // slow a frame is to draw, so a big structure records at the same speed
        // as a small one; and setTimeout keeps running in a background tab,
        // where requestAnimationFrame stops dead and would record a still.
        //
        // The curve is _drawAnimAt, exactly as the live animation uses it, so
        // the video is the animation and not a second implementation of it.
        saveDrawingVideo(opts) {
            const o = opts || {};
            const fps = Math.max(5, Math.min(60, Number(o.fps) || 30));
            const seconds = Math.max(1, Math.min(60, Number(o.seconds) || 12));
            const N = Math.max(2, Math.round(seconds * fps));
            // A beat of the finished picture at the end, so the file does not
            // stop on the frame the last change landed in.
            const TAIL = Math.round(fps * 0.6);

            if (typeof MediaRecorder === 'undefined' || !this.canvas
                || !this.canvas.captureStream) {
                const msg = 'Video recording is not supported in this browser.';
                if (typeof setStatus === 'function') setStatus(msg, true); else alert(msg);
                return;
            }
            if (this.isRecording || this._rotationRecording || this._drawRecording) return;
            if (!this._canDraw()) return;

            this.stopDrawing();               // no live run underneath the recording
            this._drawRecording = true;
            this.canvas.style.pointerEvents = 'none';
            // AND IT CAN TURN WHILE IT DRAWS. If auto-rotate is on, the view
            // makes exactly one revolution over the recording - driven here,
            // per frame, rather than left to auto-rotate's wall clock, for the
            // same reason the frames are: so the file does not depend on how
            // fast this machine happens to render.
            const R0 = this.viewerState.rotation.map((row) => [...row]);
            const turning = !!this.autoRotate;
            this.autoRotate = false;
            this._drawR0 = R0;
            this._drawWasAuto = turning;

            const options = { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 20000000 };
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm;codecs=vp8';
                options.videoBitsPerSecond = 15000000;
            }
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm';
                options.videoBitsPerSecond = 15000000;
            }

            const stream = this.canvas.captureStream(fps);
            const chunks = [];
            let rec;
            try {
                rec = new MediaRecorder(stream, options);
            } catch (err) {
                this._endDrawingVideo(stream);
                const msg = 'Failed to start recording: ' + err.message;
                if (typeof setStatus === 'function') setStatus(msg, true); else alert(msg);
                return;
            }
            rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
            rec.onstop = () => {
                this._endDrawingVideo(stream);
                if (!chunks.length) {
                    if (typeof setStatus === 'function') setStatus('No video data recorded', true);
                    return;
                }
                const blob = new Blob(chunks, { type: 'video/webm' });
                const filename = this._generateFilename(this.currentObjectName, 'webm');
                this._triggerDownload(blob, filename);
                if (typeof setStatus === 'function') {
                    setStatus(`Drawing exported to ${filename} `
                        + `(${N + TAIL} frames, ${seconds}s at ${fps}fps)`);
                }
            };
            rec.start(100);

            const track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
            let i = 0;
            const tick = () => {
                if (i > N + TAIL) {
                    setTimeout(() => {
                        try { rec.stop(); } catch (e) { /* already stopped */ }
                    }, 1000 / fps);
                    return;
                }
                // Past N the run is over; the tail frames hold the finished
                // painting, which is where the animation ends on screen too.
                this._drawAnim = this._drawAnimAt(Math.min(1, i / N));
                if (turning) {
                    this.viewerState.rotation = multiplyMatrices(
                        rotationMatrixY((2 * Math.PI * i) / N), R0);
                }
                this.render('saveDrawingVideo');
                if (track && track.requestFrame) {
                    try { track.requestFrame(); } catch (e) { /* optional */ }
                }
                if (typeof setStatus === 'function' && i % fps === 0) {
                    setStatus(`Recording drawing... ${Math.round((100 * i) / (N + TAIL))}%`);
                }
                i++;
                this._drawTimer = setTimeout(tick, 1000 / fps);
            };
            tick();
        }

        _endDrawingVideo(stream) {
            if (this._drawTimer) { clearTimeout(this._drawTimer); this._drawTimer = null; }
            this._drawRecording = false;
            // Leave the finished painting up, exactly as a live run does.
            this._drawAnim = this.drawMode ? this._drawAnimAt(1) : null;
            this._drawT = 1;
            if (this._drawR0) {
                this.viewerState.rotation = this._drawR0;
                this._drawR0 = null;
            }
            if (this._drawWasAuto) { this.autoRotate = true; this._drawWasAuto = false; }
            if (this.canvas) this.canvas.style.pointerEvents = '';
            if (stream) {
                try { stream.getTracks().forEach((tr) => tr.stop()); } catch (e) { /* gone */ }
            }
            this.render('drawingVideoEnd');
        }

        saveRotationVideo(opts) {
            const o = opts || {};
            const fps = Math.max(5, Math.min(60, Number(o.fps) || 30));
            const seconds = Math.max(1, Math.min(60, Number(o.seconds) || 6));
            const N = Math.max(2, Math.round(seconds * fps));

            if (typeof MediaRecorder === 'undefined' || !this.canvas || !this.canvas.captureStream) {
                const msg = 'Video recording is not supported in this browser.';
                if (typeof setStatus === 'function') setStatus(msg, true); else alert(msg);
                return;
            }
            if (this.isRecording || this._rotationRecording) return;

            const R0 = this.viewerState.rotation.map((row) => [...row]);
            const wasAuto = this.autoRotate;
            // Drive the turn ourselves: auto-rotate advances by wall clock, which
            // would make the number of degrees per recorded frame depend on how
            // fast the machine happens to render.
            this.autoRotate = false;
            this._rotationRecording = true;
            this.canvas.style.pointerEvents = 'none';

            const options = { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 20000000 };
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm;codecs=vp8';
                options.videoBitsPerSecond = 15000000;
            }
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm';
                options.videoBitsPerSecond = 15000000;
            }

            const stream = this.canvas.captureStream(fps);
            const chunks = [];
            let rec;
            try {
                rec = new MediaRecorder(stream, options);
            } catch (err) {
                this._endRotationVideo(R0, wasAuto, stream);
                const msg = 'Failed to start recording: ' + err.message;
                if (typeof setStatus === 'function') setStatus(msg, true); else alert(msg);
                return;
            }
            rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
            rec.onstop = () => {
                this._endRotationVideo(R0, wasAuto, stream);
                if (!chunks.length) {
                    if (typeof setStatus === 'function') setStatus('No video data recorded', true);
                    return;
                }
                const blob = new Blob(chunks, { type: 'video/webm' });
                const filename = this._generateFilename(this.currentObjectName, 'webm');
                this._triggerDownload(blob, filename);
                if (typeof setStatus === 'function') {
                    setStatus(`Video exported to ${filename} `
                        + `(${N} frames, ${seconds}s at ${fps}fps, loops seamlessly)`);
                }
            };
            rec.start(100);

            const track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
            const step = (2 * Math.PI) / N;
            let i = 0;
            const tick = () => {
                if (i >= N) {
                    // let the last frame land in the stream before closing
                    setTimeout(() => { try { rec.stop(); } catch (e) { /* already stopped */ } }, 1000 / fps);
                    return;
                }
                this.viewerState.rotation = multiplyMatrices(rotationMatrixY(i * step), R0);
                this.render();
                // captureStream samples the canvas on its own clock; nudging it
                // where supported keeps one rendered frame to one video frame
                if (track && track.requestFrame) { try { track.requestFrame(); } catch (e) { /* optional */ } }
                if (typeof setStatus === 'function' && i % fps === 0) {
                    setStatus(`Recording rotation... ${Math.round((100 * i) / N)}%`);
                }
                i++;
                // setTimeout rather than requestAnimationFrame: the pacing has to
                // hold even when the tab is not the foreground one, and rAF is
                // throttled to a stop there.
                this._rotationTimer = setTimeout(tick, 1000 / fps);
            };
            tick();
        }

        _endRotationVideo(R0, wasAuto, stream) {
            if (this._rotationTimer) { clearTimeout(this._rotationTimer); this._rotationTimer = null; }
            this._rotationRecording = false;
            if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ } }
            if (this.canvas) this.canvas.style.pointerEvents = '';
            // put the view back exactly where it was, and hand rotation back
            if (R0) this.viewerState.rotation = R0.map((row) => [...row]);
            this.autoRotate = wasAuto;
            if (this.rotationCheckbox) this.rotationCheckbox.checked = wasAuto;
            this.render();
        }

        /** Keeps the camera button's label and icon fixed as the mode changes. */
        _syncSaveButtonMode() {
            const b = this.saveImageButton;
            if (!b) return;
            // ONE CONTROL, ONE NAME. It used to relabel itself "Save Video"
            // whenever Rotate or Draw was on, and swap its icon - so the same
            // button in the same place meant different things depending on
            // state, next to a record button that meant a third thing. What is
            // offered is decided INSIDE the panel, where the options are
            // visible and can be read; the button is just the way in.
            const video = !!this.autoRotate || !!this.drawMode;
            const span = b.querySelector('span');
            const icon = b.querySelector('i');
            if (icon) {
                icon.classList.add('fa-camera');
                icon.classList.remove('fa-video');
            }
            if (span) {
                let replaced = false;
                span.childNodes.forEach((n) => {
                    if (n.nodeType === 3 && n.textContent.trim()) { n.textContent = 'Capture'; replaced = true; }
                });
                if (!replaced) span.appendChild(document.createTextNode('Capture'));
            }
            // CAPTURE, not Save: the toolbar already has a Save, which writes
            // the session file. Two buttons reading "Save" a few centimetres
            // apart is a coin toss over which one keeps your work.
            b.title = 'Capture an image or a video (shift-click saves a PNG straight away)';
            // the open panel belongs to the other mode now
            if (this._savePanel) {
                this._savePanel.remove();
                this._savePanel = null;
                b.setAttribute('aria-expanded', 'false');
                this._uiPaused = false;
            }
        }

        _toggleSaveImagePanel(anchorEl) {
            if (this._savePanel) {
                const open = this._savePanel.style.display === 'none';
                this._savePanel.style.display = open ? 'flex' : 'none';
                if (anchorEl) anchorEl.setAttribute('aria-expanded', String(open));
                if (open) this._pauseForSavePanel();
                else this._resumeFromSavePanel();
                return;
            }
            // WHAT CAN BE RECORDED FROM HERE. Three different videos, and the
            // panel offers whichever the viewer can actually make right now:
            //   * a drawing, if Draw is on   * a turn, if Rotate is on
            //   * the trajectory, if the object has frames to play
            // The last one used to belong to a separate record button in the
            // controls bar. Two entry points for "make a video" - one of which
            // silently did nothing on a single-frame structure - is what made
            // this confusing, so there is one now: Save.
            const obj = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const canTraj = !!(obj && obj.frames && obj.frames.length > 1);
            const video = !!this.autoRotate || !!this.drawMode;
            if (video) this._pauseForSavePanel();
            const prev = this._saveOpts || { format: 'png', dpi: 300 };
            const prevV = this._videoOpts || { seconds: 6, fps: 30 };
            // WRAPS. The embedded viewer's panel is 180px wide, and a row of
            // two labelled numbers plus a button wants about 210 - so it hung
            // out of the panel there while fitting fine in the standalone
            // page's wider column. Wrapping adapts to both instead of picking
            // one; the button simply falls to the next line when it has to.
            const ROW = 'display:flex; align-items:center; gap:6px;'
                + ' flex-wrap:wrap; row-gap:6px;';
            const LBL = 'font-size:12px; flex-shrink:0;';

            const p = document.createElement('div');
            p.id = 'savePanel';
            p.style.cssText = 'display:flex; flex-direction:column; gap:6px;'
                + ' box-sizing:border-box; max-width:100%;'
                + ' border:1px solid #e5e7eb; border-radius:8px; background:#fff;'
                + ' padding:8px; margin-top:6px;';
            // ONE ROW PER OUTPUT, each ending in its own button: the numbers
            // that decide a recording with a record dot after them, and the
            // one that decides a still with a camera after that. Nothing has to
            // be read in order or chosen between - the row you fill in is the
            // thing you get.
            //
            // Glyphs rather than icon fonts: the embedded viewer does not load
            // FontAwesome (its record button is a plain bullet), and one
            // implementation for both pages beats two.
            //
            // Saving a frame while an animation runs is the point of having the
            // camera here at all: the panel pauses whatever is running, so a
            // half-finished drawing or a particular angle can be kept, and
            // before it existed the only way to save one was to switch the
            // animation off - which threw away the frame being looked at.
            //
            // SVG is offered on the plain panel but never with an animation up.
            // A vector file of a normal cartoon is the better artifact; a
            // vector file of the drawing is not, since that look is a pencil
            // line a fraction of a pixel wide, paint sitting off register and
            // translucent stains.
            const svgOk = !video && !this.drawMode;
            // ONE SIZE FOR EVERY CONTROL IN THE PANEL, and big enough to read.
            // The numbers were 46x24 at 12px, which is a cramped target and
            // genuinely hard to make out - worst when a video row and the still
            // row are both up, because then the two rows sat at different
            // weights and the eye had to work out which number belonged to
            // which output. Same height everywhere, so the rows line up
            // whatever combination is showing.
            const H = 28;
            const NUM = `width:62px; flex:0 0 auto; min-width:0; height:${H}px;`
                + ' font-size:13px; padding:0 6px; border:1px solid #d1d5db;'
                + ' border-radius:6px; background:#fff;';
            const CAP = 'font-size:12px; color:#6b7280; flex:0 0 auto;';
            // Styled inline rather than by copying the toolbar button's class:
            // the two pages skin their buttons differently (and index.html's
            // toggle skin lives on a span that follows a checkbox, which these
            // do not have), so borrowing it renders one of them invisible.
            const BTN = `flex:0 0 auto; width:${H + 8}px; min-width:0; padding:0;`
                + ` height:${H}px; line-height:1; cursor:pointer; font-size:15px;`
                + ' border:1px solid #d1d5db; border-radius:6px; background:#fff;';
            // EACH ROW SAYS WHAT IT MAKES. With a video row and the still row
            // both up, the fields alone did not say which output they belonged
            // to - the reported "hard to see when both options are available".
            // A fixed-width name at the head of every row lines them up and
            // answers it without another glance.
            const NAME = 'font-size:12px; font-weight:600; color:#374151;'
                + ' flex:0 0 auto; width:46px;';
            const cell = (id, label, min, max, stepv) =>
                `<label for="${id}" style="${CAP}">${label}</label>`
                + `<input id="${id}" type="number" min="${min}" max="${max}"`
                + ` step="${stepv}" style="${NUM}">`;
            let html = '';
            if (video) {
                html += `<div style="${ROW}">`
                    + `<span style="${NAME}">${this.drawMode ? 'Draw' : 'Turn'}</span>`
                    + cell('saveSecondsInput', this.drawMode ? 'Sec' : 'Turn', 1, 60, 1)
                    + cell('saveFpsInput', 'FPS', 5, 60, 1)
                    + '<span style="flex:1 1 auto;"></span>'
                    + `<button data-rec style="${BTN} color:#ef4444;"`
                    + ' title="Record to a video file"><span>&#9679;</span></button></div>';
            }
            if (canTraj) {
                html += `<div style="${ROW}">`
                    + `<span style="${NAME}">Frames</span>`
                    + `<span style="${CAP}">${obj.frames.length}</span>`
                    + '<span style="flex:1 1 auto;"></span>'
                    + `<button data-traj style="${BTN} color:#ef4444;"`
                    + ' title="Record the frames playing through, as a video">'
                    + '<span>&#9679;</span></button></div>';
            }
            if (!video && svgOk) {
                html += `<div style="${ROW}">`
                    + `<span style="${NAME}">Format</span>`
                    + `<select id="saveFormatSelect" style="${NUM} width:auto; flex:1 1 auto;`
                    + ' padding-right:4px;">'
                    + '<option value="png">PNG</option>'
                    + '<option value="svg">SVG</option>'
                    + '<option value="svgz">SVG.gz</option>'
                    + '</select></div>';
            }
            html += `<div style="${ROW}">`
                + `<span style="${NAME}">Image</span>`
                + `<span data-dpicell style="${ROW}">`
                + cell('saveDpiInput', 'DPI', 36, 1200, 12) + '</span>'
                + '<span style="flex:1 1 auto;"></span>'
                + `<button data-ok style="${BTN}"`
                + ` title="${video ? 'Save the frame on screen as an image'
                    : 'Save an image'}"><span>&#128247;</span></button></div>`;
            p.innerHTML = html;

            const row = (anchorEl && (anchorEl.closest('.toolbar-row') || anchorEl.parentElement))
                || (this.controlsContainer || document.body);
            row.insertAdjacentElement('afterend', p);

            const fSel = p.querySelector('#saveFormatSelect');
            const dpiIn = p.querySelector('#saveDpiInput');
            const dpiCell = p.querySelector('[data-dpicell]');
            const okBtn = p.querySelector('[data-ok]');
            dpiIn.value = prev.dpi;
            if (fSel) fSel.value = svgOk ? prev.format : 'png';
            // In Draw mode, and for a frame grabbed mid-animation, the look is
            // PNG's whatever was last chosen.
            const fmtOf = () => (svgOk && fSel ? fSel.value : 'png');
            // DPI is meaningless for a vector export, so the cell is not merely
            // disabled there - it is not shown at all. Set display rather than
            // `hidden`: the element carries an inline display, which outranks
            // the user-agent [hidden] rule (the same trap the Style panel
            // documents).
            const syncDpi = () => {
                dpiCell.style.display = fmtOf() === 'png' ? 'flex' : 'none';
            };
            syncDpi();
            if (fSel) fSel.addEventListener('change', syncDpi);

            if (video) {
                const secIn = p.querySelector('#saveSecondsInput');
                const fpsIn = p.querySelector('#saveFpsInput');
                const recB = p.querySelector('[data-rec]');
                secIn.value = prevV.seconds;
                fpsIn.value = prevV.fps;
                recB.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    const vo = {
                        seconds: Number(secIn.value) || 6,
                        fps: Number(fpsIn.value) || 30,
                    };
                    this._videoOpts = vo;
                    p.style.display = 'none';
                    if (anchorEl) anchorEl.setAttribute('aria-expanded', 'false');
                    // The recorders drive their own frames, so the pause the
                    // panel put on is lifted without resuming anything.
                    this._uiPaused = false;
                    // Recording a drawing RESTARTS it from blank paper, so
                    // hitting record part way through a run still gives a whole
                    // one. Recording a rotation does not need to, since a turn
                    // has no beginning.
                    if (this.drawMode) this.saveDrawingVideo(vo);
                    else this.saveRotationVideo(vo);
                });
            }

            const trajB = p.querySelector('[data-traj]');
            if (trajB) {
                trajB.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    p.style.display = 'none';
                    if (anchorEl) anchorEl.setAttribute('aria-expanded', 'false');
                    // the recorder drives its own playback, so the panel's
                    // pause is lifted without resuming anything
                    this._uiPaused = false;
                    this.toggleRecording();
                });
            }

            okBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const opts = { format: fmtOf(), dpi: Number(dpiIn.value) || 300 };
                this._saveOpts = opts;
                p.style.display = 'none';
                if (anchorEl) anchorEl.setAttribute('aria-expanded', 'false');
                this.saveImage(opts);
                // Saving a frame is not a reason to lose the run: whatever the
                // panel paused picks up again once the file is on its way.
                this._resumeFromSavePanel();
            });
            this._savePanel = p;
            if (anchorEl) {
                anchorEl.setAttribute('aria-controls', 'savePanel');
                anchorEl.setAttribute('aria-expanded', 'true');
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
    // Uncapped: the display's own ratio. See the note in web/app.js - the 1.5x
    // cap traded sharpness for paint cost, which stopped being the right trade
    // when the GPU path took over the drawing. window.canvasDPR still overrides.
    const currentDPR = window.canvasDPR !== undefined
        ? window.canvasDPR : (window.devicePixelRatio || 1);

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
    // Palette for the 'ss' colour mode (config.color.ss_palette / the SSE
    // dropdown). Unset = viewer-cartoon.js's default palette.
    if (config.color?.ss_palette) renderer.ssPalette = config.color.ss_palette;

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
            // the SSE palette row only shows while the mode is 'ss'
            if (renderer._syncStylePanel) renderer._syncStylePanel();
        } else {
            // Invalid mode - reset dropdown to current colorMode
            colorSelect.value = renderer.colorMode || 'auto';
        }
    });

    // Store reference to colorSelect in renderer for syncing
    renderer.colorSelect = colorSelect;

    // SSE palette picker (optional container, inside the Style panel): a
    // CUSTOM dropdown, because a native <select> cannot colour its options.
    // The closed button shows the CURRENT palette as C H E N L colour chips
    // (coil, helix, strand, nucleic, ligand - each letter on its own palette
    // colour) plus the name; opening it lists every palette the same way.
    // Built from py2dmolCartoon.SS_PALETTES so the preview cannot drift from
    // what the renderer draws. Row visibility is handled by syncStylePanel
    // via data-needs-ss.
    const ssPaletteBox = containerElement.querySelector('#ssPaletteButtons');
    if (ssPaletteBox) {
        const PAL_NAMES = {
            pymol: 'PyMOL', jmol: 'Jmol',
            jr1: 'JR1', jr2: 'JR2',   // Jane Richardson palettes, numbered
        };
        const fillRow = (el, key, pal, caret) => {
            el.textContent = '';
            for (const cls of ['C', 'H', 'E', 'N', 'L']) {
                const c = pal[cls];
                const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
                const chip = document.createElement('span');
                chip.textContent = cls;
                chip.style.cssText = 'display:inline-block;width:14px;'
                    + 'text-align:center;border-radius:3px;font-size:10px;'
                    + 'font-weight:600;line-height:14px;flex-shrink:0;'
                    + 'border:1px solid rgba(0,0,0,0.12);'
                    + `background:rgb(${c.r},${c.g},${c.b});`
                    + `color:${lum > 160 ? '#1f2937' : '#ffffff'};`;
                el.appendChild(chip);
            }
            const nm = document.createElement('span');
            nm.textContent = PAL_NAMES[key] || key;
            nm.style.cssText = 'font-size:11px;color:#6b7280;margin-left:3px;'
                + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
                + 'flex:1 1 0;min-width:0;text-align:left;';
            el.appendChild(nm);
            if (caret) {
                const cv = document.createElement('span');
                cv.textContent = '\u25be';
                cv.style.cssText = 'font-size:10px;color:#6b7280;flex-shrink:0;';
                el.appendChild(cv);
            }
        };
        const buildSsPalette = () => {
            const table = window.py2dmolCartoon && window.py2dmolCartoon.SS_PALETTES;
            if (!table) return;
            ssPaletteBox.textContent = '';
            ssPaletteBox.style.position = 'relative';
            const rowCss = 'display:flex;align-items:center;gap:2px;width:100%;'
                + 'justify-content:flex-start;padding:2px 4px;height:24px;min-width:0;';
            const closed = document.createElement('button');
            closed.type = 'button';
            closed.className = 'controlButton';
            closed.style.cssText = rowCss;
            closed.title = 'SSE palette - C coil, H helix, E strand, N nucleic, L ligand';
            // MATCH THE SIBLING DROPDOWNS: copy the box (border, radius,
            // height, font) from the page's own Style select, so the closed
            // state looks like one of them on any page without hardcoding
            // either page's dimensions here.
            const refSel = containerElement.querySelector('#styleSelect');
            let menuRadius = '6px';
            if (refSel) {
                const cs = refSel.ownerDocument.defaultView.getComputedStyle(refSel);
                closed.style.border = cs.border;
                closed.style.borderRadius = cs.borderRadius;
                closed.style.height = cs.height;
                closed.style.fontSize = cs.fontSize;
                closed.style.background = '#ffffff';
                menuRadius = cs.borderRadius;
            }
            const menu = document.createElement('div');
            menu.hidden = true;
            // sized to CONTENT and anchored to the right edge: constrained
            // to the box width the chip rows overflowed the narrow widget
            // panel; as an overlay the menu may spread left over the panel.
            menu.style.cssText = 'position:absolute;top:100%;right:0;left:auto;'
                + 'width:max-content;'
                + 'margin-top:2px;background:#ffffff;border:1px solid #d1d5db;'
                + 'box-shadow:0 4px 12px rgba(0,0,0,0.15);'
                + 'display:flex;flex-direction:column;gap:2px;padding:3px;'
                + 'z-index:1000;';
            menu.style.borderRadius = menuRadius;
            const syncClosed = () => {
                const cur = renderer.ssPalette || 'pymol';
                fillRow(closed, cur, table[cur] || table.pymol, true);
                menu.querySelectorAll('.ssPalOption').forEach((b) => {
                    const on = b.dataset.palette === cur;
                    b.style.background = on ? '#e5e7eb' : '#ffffff';
                });
            };
            for (const key of Object.keys(table)) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'controlButton ssPalOption';
                btn.dataset.palette = key;
                btn.title = (PAL_NAMES[key] || key)
                    + ' - C coil, H helix, E strand, N nucleic, L ligand';
                btn.style.cssText = rowCss + 'border:none;';
                fillRow(btn, key, table[key], false);
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    renderer.ssPalette = key;
                    menu.hidden = true;
                    syncClosed();
                    renderer.colorsNeedUpdate = true;
                    renderer.plddtColorsNeedUpdate = true;
                    renderer.render('ssPalette');
                    // The sequence view and the PAE plot colour their residues
                    // through the same per-residue colour function, so a palette
                    // swap changes them too - but they only find out through
                    // this event, which the colour-MODE dropdown dispatches and
                    // this handler used to skip. Result: the ribbon recoloured
                    // and the sequence stayed on the old palette.
                    document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
                });
                menu.appendChild(btn);
            }
            closed.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.hidden = !menu.hidden;
            });
            // close on any click outside this widget
            containerElement.ownerDocument.addEventListener('click', (e) => {
                if (!menu.hidden && !ssPaletteBox.contains(e.target)) menu.hidden = true;
            });
            ssPaletteBox.appendChild(closed);
            ssPaletteBox.appendChild(menu);
            syncClosed();
            // Expose it so ANY programmatic change to renderer.ssPalette (state
            // restore, a preset, the Python API) can refresh the closed chip.
            // Without this the ribbon recoloured while the dropdown kept
            // showing the previous palette.
            renderer._syncSsPaletteChip = syncClosed;
        };
        if (window.py2dmolCartoon) buildSsPalette();
        else window.addEventListener('py2dmol_cartoon_loaded', buildSsPalette, { once: true });
    }

    // Setup style control (ribbon vs cartoon) - optional element
    const styleSelect = containerElement.querySelector('#styleSelect');
    // the dropdown lists ribbon/cartoon; richardson is a PRESET of cartoon
    const uiStyleOf = (s) => (s || 'tube');
    if (styleSelect) {
        styleSelect.value = uiStyleOf(renderer.style);
        styleSelect.addEventListener('change', (e) => {
            // Cartoon's default preset is Richardson, so picking Cartoon lands
            // there; the Preset dropdown reaches Ribbon (plain cartoon) and 3D.
            renderer.setStyle(e.target.value);
            // setStyle rejects invalid/unloaded styles; re-sync the dropdown
            if (styleSelect.value !== uiStyleOf(renderer.style)) {
                styleSelect.value = uiStyleOf(renderer.style);
            }
            syncStylePanel();
        });
        renderer.styleSelect = styleSelect;
    }

    // Preset dropdown: named starting points for the cartoon style
    // (Richardson is the default; sliders stay live under any of them).
    const presetSelect = containerElement.querySelector('#presetSelect');
    if (presetSelect) {
        presetSelect.value = renderer.stylePreset || 'richardson';
        presetSelect.addEventListener('change', (e) => {
            renderer.setPreset(e.target.value);
            if (presetSelect.value !== (renderer.stylePreset || 'richardson')) {
                presetSelect.value = renderer.stylePreset || 'richardson';
            }
        });
    }

    // Setup the collapsible Style panel - optional. It holds the render
    // controls; rows tagged data-style="ribbon|cartoon" appear only under that
    // style (untagged rows are shared). Both markup and panel are optional, so
    // every lookup below is null-guarded.
    const styleToggle = containerElement.querySelector('#styleToggle');
    const stylePanel = containerElement.querySelector('#stylePanel');

    // HOW WIDE THE WIDTH CONTROL GOES, PER STYLE.
    //
    // A tube is a solid stroke and keeps reading as one when it fattens, so it
    // goes to 5.0; the cartoon keeps the 4.7 the control has always had.
    //
    // The ceiling is deliberately modest, because the two renderers agree less
    // well the wider the stroke gets. Measured on 1TIM, GPU against the 2D
    // pass, mean absolute difference per pixel: 3.40 at width 2, 3.41 at 3,
    // 3.85 at 4, 4.14 at 5. The visible part is the outlines: as capsules
    // overlap more, the GPU keeps fewer of them than the 2D pass does (thin
    // dark pixels at width 5: 7,233 against 9,913), so a wide tube reads as a
    // smoother mass there and as a drawn one here. None of that is new - the
    // same gap is in the pre-GPU-optimisation build at the default width - it
    // just grows with the control, which is reason enough not to open the
    // control very far.
    //
    // The VALUE comes down with the ceiling when the style changes. A slider
    // pinned at its maximum while the renderer holds a larger number is a
    // control that lies about the drawing, which is the same failure the
    // STYLE_DEFAULTS table exists to prevent - and _lineWidthUserSet means a
    // width the user actually dragged survives a style switch, so without this
    // a tube at 5 would carry 5 into a cartoon whose slider stops at 4.7.
    const WIDTH_MAX = { tube: 5.0, cartoon: 4.7 };

    function syncStylePanel() {
        const style = renderer.style || 'tube';
        if (!stylePanel) return;
        const widthSlider = stylePanel.querySelector('#lineWidthSlider');
        if (widthSlider) {
            const cap = WIDTH_MAX[style] || WIDTH_MAX.cartoon;
            widthSlider.max = String(cap);
            if (renderer.lineWidth > cap) {
                renderer.lineWidth = cap;
                widthSlider.value = String(cap);
            }
        }
        Array.prototype.forEach.call(stylePanel.children, (row) => {
            row.hidden = false;
        });
        stylePanel.querySelectorAll('[data-style]').forEach((el) => {
            const want = el.getAttribute('data-style');
            // Rows may name several styles, space separated.
            const wanted = want ? want.split(/\s+/) : null;
            const show = !wanted || wanted.includes(style);
            el.hidden = !show;
        });
        // Both panels pair half-cells per row (same DOM); collapse a row once
        // every tagged cell in it is hidden, so no empty rows are left behind.
        // Rows with untagged children (Width/Outline) never auto-collapse.
        stylePanel.querySelectorAll('.toggle-item').forEach((row) => {
            const cells = row.querySelectorAll(':scope > [data-style]');
            if (!cells.length || cells.length !== row.children.length) return;
            row.hidden = Array.prototype.every.call(cells, (c) => c.hidden);
        });
        // The SSE palette row exists only while colouring by secondary
        // structure.
        const ssOn = (renderer._getEffectiveColorMode
            ? renderer._getEffectiveColorMode() : renderer.colorMode) === 'ss';
        stylePanel.querySelectorAll('[data-needs-ss]').forEach((el) => {
            if (!ssOn) el.hidden = true;
        });
        // keep the Preset dropdown showing the live preset
        const ps = stylePanel.querySelector('#presetSelect');
        if (ps) ps.value = renderer.stylePreset || 'richardson';
    }

    if (styleToggle && stylePanel) {
        styleToggle.addEventListener('click', () => {
            const open = stylePanel.hidden;
            stylePanel.hidden = !open;
            styleToggle.setAttribute('aria-expanded', String(open));
        });
    }
    // Exposed so setStyle() can re-filter the rows when called programmatically.
    // Push renderer values onto the preset sliders. Registered here because
    // this is where the slider elements are in scope; called by
    // _applyStyleDefaults on every style switch.
    renderer._syncStyleControls = () => {
        const set = (el, v) => { if (el && v !== undefined) el.value = v; };
        set(lineWidthSlider, renderer.lineWidth);
        set(thicknessSlider, renderer.cartoonThickness);
        set(highlightSlider, renderer.cartoonHighlight);
        set(outlineTintSlider, renderer.cartoonOutlineTint);
        set(sheetFlatSlider, renderer.cartoonSheetFlat);
        set(pencilSlider, renderer.cartoonPencil);
        if (smoothCheckbox) smoothCheckbox.checked = renderer.cartoonSmooth === true;
        // queried at call time: these elements are set up after this closure
        // is defined, and a lookup here can never hit a TDZ.
        const qs = (id) => containerElement.querySelector(id);
        set(qs('#outlineWidthSlider'), renderer.relativeOutlineWidth);
        set(qs('#detailSlider'), renderer.cartoonDetail);
        set(qs('#shadeSlider'), renderer.cartoonShade);
        const arrowsCb = qs('#arrowsCheckbox');
        if (arrowsCb) arrowsCb.checked = renderer.cartoonArrows !== false;
        if (renderer._syncSsPaletteChip) renderer._syncSsPaletteChip();

    };

    renderer._syncStylePanel = syncStylePanel;
    syncStylePanel();

    // ---- Slider value readouts (calibration aid) --------------------------
    // Every range input gets a small bubble above its thumb naming the option
    // and showing its exact value, on hover and throughout a drag. Purely
    // additive: the bubble is position:fixed so it costs no layout, and it
    // never writes to the control.
    // One bubble and one document listener per DOCUMENT, not per viewer: a page
    // can host many viewers and nothing here is ever torn down, so a per-viewer
    // node plus a per-viewer document listener would accumulate.
    const sliderDoc = containerElement.ownerDocument;
    if (!sliderDoc.__py2dmolReadout) {
        sliderDoc.__py2dmolReadout = { el: null, dragging: null };
    }
    const readout = sliderDoc.__py2dmolReadout;

    function readoutBubble() {
        let readoutEl = readout.el;
        if (readoutEl && readoutEl.isConnected) return readoutEl;
        readoutEl = sliderDoc.createElement('div');
        readout.el = readoutEl;
        readoutEl.id = 'sliderReadout';
        readoutEl.style.cssText = [
            'position:fixed', 'z-index:2147483000', 'pointer-events:none',
            'background:#111827', 'color:#f9fafb', 'font-size:11px',
            'font-family:inherit', 'font-weight:500', 'line-height:1',
            'padding:4px 6px', 'border-radius:4px', 'white-space:nowrap',
            'box-shadow:0 1px 4px rgba(0,0,0,0.3)', 'display:none',
        ].join(';');
        sliderDoc.body.appendChild(readoutEl);
        return readoutEl;
    }

    function readoutName(slider) {
        // Scoped to this viewer: a page can host several viewers, and their
        // control ids repeat, so a document-wide lookup could match a sibling.
        const lab = slider.id && containerElement.querySelector(`label[for="${slider.id}"]`);
        const raw = (lab && lab.textContent) || slider.getAttribute('aria-label') || slider.id || '';
        return raw.trim().replace(/:$/, '');
    }

    function readoutText(slider) {
        // Decimal places follow the step, so 0.05 shows 0.55 and 1 shows 3.
        const step = parseFloat(slider.step);
        const dp = Number.isFinite(step) && step > 0 && step < 1
            ? (String(step).split('.')[1] || '').length : 0;
        return `${readoutName(slider)}: ${parseFloat(slider.value).toFixed(dp)}`;
    }

    function showReadout(slider) {
        const el = readoutBubble();
        el.textContent = readoutText(slider);
        el.style.display = 'block';
        // The thumb centre travels the track width minus one thumb width.
        const r = slider.getBoundingClientRect();
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        const frac = max > min ? (parseFloat(slider.value) - min) / (max - min) : 0;
        const THUMB = 14;
        const x = r.left + THUMB / 2 + (r.width - THUMB) * frac;
        const b = el.getBoundingClientRect();
        el.style.left = `${Math.round(Math.max(2, x - b.width / 2))}px`;
        el.style.top = `${Math.round(r.top - b.height - 6)}px`;
    }

    function hideReadout() {
        if (readout.el) readout.el.style.display = 'none';
    }

    containerElement.querySelectorAll('input[type="range"]').forEach((slider) => {
        if (slider.id === 'frameSlider') return;   // already has its own counter
        slider.addEventListener('pointerenter', () => { if (!readout.dragging) showReadout(slider); });
        slider.addEventListener('pointerleave', () => { if (!readout.dragging) hideReadout(); });
        slider.addEventListener('pointerdown', () => { readout.dragging = slider; showReadout(slider); });
        slider.addEventListener('input', () => {
            if (readout.dragging === slider || slider.matches(':hover')) showReadout(slider);
        });
    });
    // Drags routinely end outside the track, so the release is caught on the
    // document - once per document, shared by every viewer on the page.
    if (!readout.bound) {
        readout.bound = true;
        sliderDoc.addEventListener('pointerup', () => {
            if (!readout.dragging) return;
            const s = readout.dragging;
            readout.dragging = null;
            if (!s.matches(':hover') && readout.el) readout.el.style.display = 'none';
        });
    }

    // Dark background toggle: black page, white ink, fade toward black.
    const darkCheckbox = containerElement.querySelector('#darkCheckbox');
    if (darkCheckbox) {
        darkCheckbox.checked = renderer.backgroundColor === '#000000';
        darkCheckbox.addEventListener('change', (e) => {
            renderer.backgroundColor = e.target.checked ? '#000000' : '#ffffff';
            if (renderer.canvas) renderer.canvas.style.background = renderer.backgroundColor;
            renderer.render('darkCheckbox');
        });
        // seed the canvas css background to match the config
        if (renderer.canvas && renderer.backgroundColor === '#000000') {
            renderer.canvas.style.background = renderer.backgroundColor;
        }
    }

    // Setup the Shade toggle (cartoon directional shading)


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
    // #saveSvgButton is the old id; still accepted so previously exported
    // standalone HTML keeps working.
    const saveImageButton = containerElement.querySelector('#saveImageButton')
        || containerElement.querySelector('#saveSvgButton');
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
    const thicknessSlider = containerElement.querySelector('#thicknessSlider');
    const detailSlider = containerElement.querySelector('#detailSlider');
    const sheetFlatSlider = containerElement.querySelector('#sheetFlatSlider');
    const pencilSlider = containerElement.querySelector('#pencilSlider');


    // Set defaults for width, rotation, and shadow
    if (lineWidthSlider) lineWidthSlider.value = renderer.lineWidth;
    if (thicknessSlider) {
        thicknessSlider.value = renderer.cartoonThickness !== undefined
            ? renderer.cartoonThickness : 0;
        thicknessSlider.addEventListener('input', (e) => {
            renderer.cartoonThickness = parseFloat(e.target.value);
            // Same rule as the Width slider: only a real gesture takes the
            // control over. Nothing dispatches a synthetic 'input' at this
            // slider today, but the two latches are siblings and drifted once
            // already - the guard makes that impossible rather than lucky.
            if (e.isTrusted) renderer._thicknessUserSet = true;
            renderer.render('thicknessSlider');
        });
    }
    if (pencilSlider) {
        pencilSlider.value = renderer.cartoonPencil;
        pencilSlider.addEventListener('input', (e) => {
            renderer.cartoonPencil = parseFloat(e.target.value);
            renderer.render('pencilSlider');
        });
    }
    if (sheetFlatSlider) {
        sheetFlatSlider.value = renderer.cartoonSheetFlat;
        sheetFlatSlider.addEventListener('input', (e) => {
            renderer.cartoonSheetFlat = parseFloat(e.target.value);
            // strand geometry changes, so cached segment geometry is stale
            if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
            renderer.render('sheetFlatSlider');
        });
    }
    const shadeSlider = containerElement.querySelector('#shadeSlider');
    if (shadeSlider) {
        renderer.shadeSlider = shadeSlider;
        shadeSlider.value = renderer.cartoonShade !== undefined ? renderer.cartoonShade : 1;
        shadeSlider.addEventListener('input', (e) => {
            renderer.cartoonShade = parseFloat(e.target.value);
            renderer.render('shadeSlider');
        });
    }
    if (detailSlider) {
        detailSlider.value = renderer.cartoonDetail !== undefined
            ? renderer.cartoonDetail : 4;
        detailSlider.addEventListener('input', (e) => {
            renderer.cartoonDetail = parseInt(e.target.value, 10);
            renderer.render('detailSlider');
        });
    }
    const smoothCheckbox = containerElement.querySelector('#smoothCheckbox');
    const arrowsCheckbox = containerElement.querySelector('#arrowsCheckbox');
    if (arrowsCheckbox) {
        arrowsCheckbox.checked = renderer.cartoonArrows !== false;
        arrowsCheckbox.addEventListener('change', (e) => {
            renderer.cartoonArrows = e.target.checked;
            if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
            renderer.render('arrowsCheckbox');
        });
    }
    // Bases toggle: DNA/RNA base plates (the rungs of a duplex) on/off.
    const basePlatesCheckbox = containerElement.querySelector('#basePlatesCheckbox');
    if (basePlatesCheckbox) {
        basePlatesCheckbox.checked = renderer.cartoonBasePlates !== false;
        basePlatesCheckbox.addEventListener('change', (e) => {
            renderer.cartoonBasePlates = e.target.checked;
            renderer.render('basePlatesCheckbox');
        });
    }
    if (smoothCheckbox) {
        smoothCheckbox.checked = renderer.cartoonSmooth === true;
        smoothCheckbox.addEventListener('change', (e) => {
            renderer.cartoonSmooth = e.target.checked;
            syncStylePanel();
            renderer.render('smoothCheckbox');
        });
    }
    // NO GPU CONTROL HERE. `cartoonGPU` is a rendering BACKEND and applies to
    // both styles, so the Style panel was the wrong home for it: tagged for one
    // style it was hidden in the other, and tagged for both it was still sitting
    // among the things that change what the picture IS. The web app owns the
    // control now (index.html's Use GPU, wired in web/app.js) and Python owns
    // the flag (view(gpu=True) -> config.rendering.gpu). This file just reads it.
    const highlightSlider = containerElement.querySelector('#highlightSlider');
    if (highlightSlider) {
        highlightSlider.value = renderer.cartoonHighlight !== undefined
            ? renderer.cartoonHighlight : 1.8;
        highlightSlider.addEventListener('input', (e) => {
            renderer.cartoonHighlight = parseFloat(e.target.value);
            renderer.render('highlightSlider');
        });
    }
    const outlineTintSlider = containerElement.querySelector('#outlineTintSlider');
    if (outlineTintSlider) {
        outlineTintSlider.value = renderer.cartoonOutlineTint || 0;
        outlineTintSlider.addEventListener('input', (e) => {
            renderer.cartoonOutlineTint = parseFloat(e.target.value);
            renderer.render('outlineTintSlider');
        });
    }

    // outline/shadow are OFF at slider zero, so seed each from the live state
    if (outlineWidthSlider) {
        // ?? not ||: an outline deliberately set to 0 is not an unset one, and
        // || turned it back on at the default. Reachable through the 3d preset,
        // whose outlineWidth IS 0 - _applyStyleDefaults only forces outlineMode
        // to 'none' when there is no mode control, so with one present the width
        // sat at 0 while this put 1.0 on the slider.
        outlineWidthSlider.value = renderer.outlineMode === 'none'
            ? 0 : (renderer.relativeOutlineWidth ?? 3.0);
    }
    if (shadowSlider) {
        shadowSlider.value = renderer.shadowEnabled === false
            ? 0 : (renderer.shadowStrength || 0.5);
    }
    rotationCheckbox.checked = renderer.autoRotate;

    // Hand-drawn build-up. A checkbox rather than a plain button so it takes
    // the same pressed skin as Colorblind and Dark beside it, and so it reads
    // as ON while the drawing is being made. The renderer clears it when the
    // animation finishes or is interrupted, which is why it holds the element.
    const drawCheckbox = containerElement.querySelector('#drawCheckbox');
    if (drawCheckbox) {
        renderer.drawCheckbox = drawCheckbox;
        drawCheckbox.checked = false;
        drawCheckbox.addEventListener('change', () => {
            renderer.setDrawMode(drawCheckbox.checked);
        });
    }

    // Pass ALL controls to the renderer
    renderer.setUIControls(
        controlsContainer, playButton, overlayButton, recordButton, saveImageButton,
        frameSlider, frameCounter, objectSelect,
        speedButton, rotationCheckbox, lineWidthSlider, outlineWidthSlider,
        outlineModeButton, outlineModeSelect,
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
                            renderer._invalidateSegmentCache();
                        }
                    }

                    // Store color overrides at object level if present
                    if (obj.color) {
                        if (renderer.objectsData[obj.name]) {
                            renderer.objectsData[obj.name].color = obj.color;
                            // Invalidate segment cache to ensure new colors are applied
                            renderer._invalidateSegmentCache();
                        }
                    }

                    // ... and secondary structure (Python's set_sse). The static
                    // path is what a notebook/Colab cell renders from, so an
                    // override set before show() only survives if it is read back
                    // here, exactly like color.
                    if (obj.sse && renderer.objectsData[obj.name]) {
                        renderer.objectsData[obj.name].sse = obj.sse;
                        renderer._invalidateSegmentCache();
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

                // In overlay mode, DON'T call setFrame - it would load individual frame data
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

    /**
     * Helper: Apply metadata fields to an object.
     * 
     * Centralizes metadata application logic shared by both handleIncrementalStateUpdate
     * and handleReplaceFrame.
     *
     * @param {Object} obj - Object data to update
     * @param {Object} meta - Metadata fields (color, contacts, bonds, scatter_config)
     * @returns {boolean} True if rerender is needed
     */
    const applyMetadataToObject = (obj, meta) => {
        if (!obj || !meta) return false;

        let needsRerender = false;

        // Apply visual metadata
        if (meta.color) {
            obj.color = meta.color;
            needsRerender = true;
        }
        if (meta.contacts) {
            obj.contacts = meta.contacts;
            needsRerender = true;
        }
        if (meta.bonds) {
            obj.bonds = meta.bonds;
            needsRerender = true;
        }
        // Secondary structure (Python's set_sse), keyed by position index like
        // `color`. The cartoon's SS cache key is derived from this map, so
        // replacing it invalidates the cached assignment and geometry by itself.
        if (meta.sse) {
            obj.sse = meta.sse;
            needsRerender = true;
        }

        // Scatter config doesn't trigger rerender (handled separately)
        if (meta.scatter_config) {
            obj.scatterConfig = meta.scatter_config;
        }

        return needsRerender;
    };

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
                renderer._invalidateSegmentCache();
                renderer.setFrame(renderer.currentFrame);
            }
        }
    };

    // 12c. Handle replace-frame updates (overwrite latest frame)
    /**
     * Handle replace-frame updates from Python replace() calls.
     *
     * Always replaces the LAST frame (or adds if no frames exist).
     *
     * @param {Object} frame - Frame data to replace with (coords, plddts, chains, etc.)
     * @param {Object} [meta={}] - Metadata (color, contacts, bonds, scatter_config)
     * @param {string|null} [objectName=null] - Target object name (defaults to current)
     * @param {number|null} [seq=null] - Sequence number for deduplication
     *
     * Behavior:
     *   - Removes LAST frame and adds new one
     *   - If no frames exist, simply adds the new frame
     *   - Builds trajectory incrementally as replace() is called
     *
     * Frame Processing:
     *   - Uses renderer.addFrame() to ensure proper validation and data processing
     *   - Updates _lastPlddtFrame and _lastPaeFrame tracking correctly
     *   - Maintains shadow cache invalidation
     *
     * @see handleIncrementalStateUpdate For add() operations (always appends)
     */
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

        // Replace last frame (or add if no frames exist)
        if (obj.frames && obj.frames.length > 0) {
            // Remove the last frame
            obj.frames.pop();

            // Adjust pLDDT/PAE tracking indices if they point to the removed frame
            if (obj._lastPlddtFrame >= obj.frames.length) {
                obj._lastPlddtFrame = obj.frames.length - 1;
            }
            if (obj._lastPaeFrame >= obj.frames.length) {
                obj._lastPaeFrame = obj.frames.length - 1;
            }
        }
        // Add new frame properly using addFrame() to ensure correct processing
        renderer.addFrame(frame, objName);


        // Apply metadata using helper
        applyMetadataToObject(obj, meta);


        renderer._invalidateShadowCache();
        renderer.lastShadowRotationMatrix = null;

        if (renderer.currentObjectName === objName) {
            if (renderer.scatterRenderer) {
                renderer.updateScatterData(objName);
                renderer.updateScatterContainerVisibility();
            }
            // replace() swaps coordinates while object, frame index and length
            // all stay the same, so the cartoon caches must be cleared by hand:
            // their key cannot see the difference.
            renderer._invalidateSegmentCache();
            renderer.setFrame(obj.frames.length > 0 ? obj.frames.length - 1 : 0);
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
                    const [frame, metaArg, objectName] = args;  // persistence no longer needed
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
