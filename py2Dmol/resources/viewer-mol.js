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
    // 'object' only means anything with more than one object merged in, and
    // is what 'auto' resolves to there - see setCoords.
    const builtinModes = ['auto', 'chain', 'rainbow', 'plddt', 'deepmind', 'entropy', 'object'];
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
    // How far an atom can sit from its residue's trace point: an arginine's tip
    // is ~7 A from its CA and a purine's ~7 from its C4'. Used to widen a
    // distance search's first pass, so the exact one never misses a pair.
    const SIDECHAIN_REACH_A = 8;
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
    // ...and the same colour split in two, for the scratch layer: opaque while
    // the widths are drawn, composited once at the alpha they share.
    const SELECTION_HALO_SOLID_CSS = 'rgb(255, 255, 0)';
    const SELECTION_HALO_ALPHA = 0.45;
    // The hover MARK has no colour of its own: it is the selection band, drawn
    // over what the pointer is on. Only the readout needs one, and it follows
    // the paper rather than sitting on a plate of its own.
    const HOVER_TEXT_LIGHT_CSS = 'rgba(40, 40, 40, 0.9)';    // on white paper
    const HOVER_TEXT_DARK_CSS = 'rgba(235, 235, 235, 0.9)';  // on the 3d preset's black
    const HOVER_TEXT_MARGIN = 10;
    // HOW FAR THE BAND REACHES PAST THE GEOMETRY, as a multiple of what is
    // drawn rather than a number of pixels.
    //
    // It was a flat 7 px, which is a band around the ribbon at the zoom the
    // number was chosen at and a stripe with a ribbon inside it anywhere else:
    // zoomed out on 1TIM the drawn radius is 2 px and the band was 18 px wide -
    // four and a half times the thing it was marking - and on a structure big
    // enough to pin the radius at its floor (3J3Q) it was 18 px at every zoom.
    //
    // PROPORTION, AND NOTHING ELSE. The band is 1.3 x the radius of whatever
    // it marks, so a highlight looks the same at every zoom and on every kind
    // of thing - and the two clamps that used to bound it were exactly where it
    // stopped doing that:
    //
    //   the FLOOR was added to the margin, so a small mark got a band far wider
    //   than its proportion - 2.5 px around a 1.7 px zinc, which is why a
    //   selected metal started out looking too heavy;
    //   the CEILING held the margin at 14 px, so a big mark stopped growing -
    //   2.30x the radius at 7 px and 1.52x at 27, which is why it then refused
    //   to keep up on the way in.
    //
    // Between the two it was proportional only in the middle, which is where a
    // ribbon happens to live (2-7 px) - so the rule looked right for years and
    // was wrong for the first thing drawn at a size of its own.
    //
    // What survives is a floor on the WHOLE BAND rather than on the margin: a
    // hairline still has to be markable, and 2.5 px of band around a half-pixel
    // strand does that without touching anything bigger. Nothing else needs a
    // bound - a band around a big thing is big, and that is what proportion
    // means. The default view is unchanged either way (12.5 px, as before).
    const SELECTION_HALO_RADIUS_FRAC = 0.5;
    /**
     * How wide the band over something of drawn radius `rad` is - a DIAMETER,
     * because it is used as a stroke width.
     *
     * Module scope so it can be tested: the proportion it holds is the whole
     * point of it, and it is not visible in a screenshot of one zoom.
     */
    function selectionBandFor(rad, pxScale, ref) {
        const r = rad || 2;
        // THE RING IS A PEN, THE INNER EDGE IS THE THING. Its thickness comes
        // from `ref` - the ordinary residue radius at this view - and not from
        // r, so a mark sticks out by the same amount whatever it is drawn
        // around. Defaults to r, which is the same number for everything that
        // is drawn at the residue radius, so this changes nothing there.
        const m = SELECTION_HALO_GAIN * (ref === undefined ? r : ref);
        return 2 * Math.max(r + m, SELECTION_HALO_MIN_PX * pxScale);
    }
    const SELECTION_HALO_GAIN = 1.3;
    const SELECTION_HALO_MIN_PX = 2.5;

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
        let { frameIndex, posIndex } = context;
        const { chainId, renderer } = context;
        // EVERY LEVEL OF THIS IS PER OBJECT - a colour set on the object, on
        // one of its frames, on one of its chains, on one of its positions -
        // and in a merged view the position index arriving here belongs to
        // whichever object it came from, not to the current one. Resolved back
        // to that object and its own numbering, or the second structure takes
        // the first one's per-position colours.
        const owner = renderer.ownerOf ? renderer.ownerOf(posIndex) : null;
        const objectName = owner ? owner.name : renderer.currentObjectName;
        const object = renderer.objectsData[objectName];
        if (owner) { posIndex = owner.local; frameIndex = owner.frame; }

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
    const MAX_SHADOW_SUM = 12;              // Maximum accumulated shadow sum (saturating accumulation)

    // The clip's soft edge, as a fraction of the slab's thickness. The panel
    // shows it as a percentage - 10 - and the renderer works in fractions.
    const CLIP_FADE_DEFAULT = 0.1;

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
            this.useGPU = config.rendering?.gpu === true;
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
            // WIDTH IS REMEMBERED PER STYLE. The slider is one control but it
            // is not one quantity: in tube it is the radius of the tube, in
            // cartoon it scales the ribbon. A width dragged in tube used to
            // follow the switch into cartoon and arrive as a ribbon several
            // times too wide - invisible until opening a second, smaller
            // structure started switching style on its own, and then it looked
            // like the tube's settings being copied into cartoon, which is
            // what it was.
            this._widthByStyle = {};
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

            // Several objects shown at once, merged into one coordinate array
            // the same way the overlay merges frames - see _mergeObjects and
            // MULTI_OBJECT_PLAN.md. The two are mutually exclusive: a merge is
            // of frames or of objects, never both.
            this.multiState = {
                enabled: false,              // Is more than one object merged in?
                sourceIdMap: null,           // position -> index into sourceNames
                sourceNames: null,           // the objects merged, in drawing order
                sourceOffsets: null,         // where each of them starts
                sourceFrames: null,          // the frame each was taken from
                sourceAutoColors: null,      // what 'auto' means for each of them
                stats: null,                 // centre and extent of the lot - see drawnStats
                autoColor: null
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
            // THE CLIP SLAB, in view space: keep what lies between clipFar
            // and clipNear along the camera's own z. null for no clipping. It
            // cuts the DRAWING, not the visibility - see the note on setClipSlab.
            this.clipNear = null;
            this.clipFar = null;
            // ...and how soft its edges are: a FRACTION of the slab's own
            // thickness over which the drawing fades out instead of stopping.
            // 0 is the knife. A fraction rather than Angstrom because the
            // useful softness scales with what is being looked at - the same
            // 0.2 reads the same on a peptide and on a ribosome. The control
            // shows it as a percentage, and a tenth is the default: enough to
            // read as a soft edge, little enough to keep the cut a cut.
            this.clipFade = CLIP_FADE_DEFAULT;
            // Whether the CONTROLS are up. Separate from the slab itself,
            // which stays where it was set: switching Clip off puts the panel
            // away, it does not undo the cut. Reset is what uncuts.
            this.clipEditing = false;
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

            // Recording state. The recorder itself lives in _recSink for as
            // long as a recording is running - see _makeVideoSink.
            this.isRecording = false;
            this._recSink = null;
            this.recordingEndFrame = 0;

            // Cache shadow/tint arrays during dragging for performance
            this._invalidateShadowCache();
            this.isZooming = false; // Track zoom state to skip shadow recalculation
            this.isOrientAnimating = false; // Track orient animation state to skip shadow recalculation
            this.lastShadowRotationMatrix = null; // Track rotation matrix for shadow caching

            // Batch loading flag to suppress unnecessary renders during bulk data loading
            this._batchLoading = false;
            // WHICH OBJECTS ARE ON SCREEN. Empty means "just the current one",
            // which is every session today; the object list will write names
            // into it. Read through drawnObjects(), never directly, so the
            // day it holds several the callers need no changing.
            // See MULTI_OBJECT_PLAN.md.
            this.shownObjects = null;

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

            // Save selection state to the object it belongs to - or to each
            // of them, when several are merged. See _saveVisibilityToObjects.
            this._saveVisibilityToObjects();

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

            // Select all chains - by (object, chain), like everything else
            const allChains = new Set();
            for (let i = 0; i < (this.chains ? this.chains.length : 0); i++) {
                allChains.add(this.chainKeyAt(i));
            }

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
            // CHAIN IDENTITY IS (OBJECT, CHAIN) - see chainKeyAt. Compared as
            // bare ids, hiding chain A of one object hid chain A of the other.
            let allowedChains;
            if (this.visibilityModel.chains && this.visibilityModel.chains.size > 0) {
                allowedChains = this.visibilityModel.chains;
            } else {
                allowedChains = new Set();
                for (let i = 0; i < (this.chains ? this.chains.length : 0); i++) {
                    allowedChains.add(this.chainKeyAt(i));
                }
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
                                const ch = this.chainKeyAt(mergedIdx);
                                if (allowedChains.has(ch)) {
                                    seqPositions.add(mergedIdx);
                                }
                            }
                        }
                    }
                } else {
                    // Normal mode or overlay with no position selection
                    for (let i = 0; i < n; i++) {
                        const ch = this.chainKeyAt(i);
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
                    // Normal mode. A PAE matrix belongs to ONE object - the
                    // current one, which is whose matrix the panel shows - so
                    // its rows are that object's residues and land at its
                    // offset in a merged array.
                    const paeOff = this.sourceOffsetOf
                        ? this.sourceOffsetOf(this.currentObjectName) : 0;
                    const last = n - 1 - paeOff;
                    for (const box of this.visibilityModel.paeBoxes) {
                        const i0 = Math.max(0, Math.min(last, Math.min(box.i_start, box.i_end)));
                        const i1 = Math.max(0, Math.min(last, Math.max(box.i_start, box.i_end)));
                        const j0 = Math.max(0, Math.min(last, Math.min(box.j_start, box.j_end)));
                        const j1 = Math.max(0, Math.min(last, Math.max(box.j_start, box.j_end)));
                        for (let r = i0; r <= i1; r++) {
                            if (r + paeOff < n) paePositions.add(r + paeOff);
                        }
                        for (let r = j0; r <= j1; r++) {
                            if (r + paeOff < n) paePositions.add(r + paeOff);
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
                const own = this.ownerOf ? this.ownerOf(i) : null;
                window.SEQ.setHoveredResidue({
                    // ...and WHICH OBJECT, when several are drawn: chain A
                    // residue 39 exists in both, and the readout was the same
                    // three words for two different molecules.
                    object: own ? own.name : this.currentObjectName,
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
                // A DRAG STOPS THE SPIN - unless the spin is already held.
                // While the Capture panel is open the turn is paused so the
                // view can be aimed before recording; a drag there is the
                // aiming, and switching Rotate off would take the Turn button
                // off the panel (and the panel with it) at the moment it was
                // about to be pressed. Reported as: adjusting the view with
                // Capture up disabled Rotate.
                if (this.autoRotate && !this._uiPaused) this._setAutoRotate(false);

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
                const chain = this.chainKeyAt(i);
                if (chain === undefined) return;
                // the two shift-clicks that precede this already toggled residue
                // i; the chain union covers it either way
                const next = e.shiftKey ? new Set(this.residueSelection || []) : new Set();
                // THE WHOLE CHAIN OF THAT OBJECT, clip or no clip: the pick
                // must land on something visible, but widening it is a bulk
                // operation on a NAME - and by bare id that name was chain A
                // of every object on screen (chainKeyAt).
                for (let k = 0; k < this.chains.length; k++) {
                    if (this.chainKeyAt(k) === chain) next.add(k);
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
                    // A DRAG STOPS THE SPIN - unless the spin is already held.
                // While the Capture panel is open the turn is paused so the
                // view can be aimed before recording; a drag there is the
                // aiming, and switching Rotate off would take the Turn button
                // off the panel (and the panel with it) at the moment it was
                // about to be pressed. Reported as: adjusting the view with
                // Capture up disabled Rotate.
                if (this.autoRotate && !this._uiPaused) this._setAutoRotate(false);
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
                    if (e.shiftKey) this.saveImage(this.captureOpts());
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
                    // THE USER, NOT THE APP. A width the user dragged is
                    // remembered against the style it was dragged in, and a
                    // style switch restores that style's own (see
                    // _applyStyleDefaults) - so this must only record an actual
                    // gesture.
                    //
                    // Restoring saved state sets the slider and dispatches a
                    // synthetic 'input' to push the value through. Recording
                    // that as a drag would make every load look like a choice,
                    // and the style's profile width would never apply again.
                    //
                    // isTrusted is false for any event dispatched from script
                    // and true only for one the browser raised from real input,
                    // which is exactly the distinction wanted here.
                    if (e.isTrusted) {
                        if (!this._widthByStyle) this._widthByStyle = {};
                        this._widthByStyle[this.style] = this.lineWidth;
                    }
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
                    const object = this.drawnStats();
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
        /**
         * @param {string} style 'tube' or 'cartoon'
         * @param {boolean} [quiet] set the style WITHOUT drawing. For a caller
         *   that is about to draw anyway - _switchToObject restores an object's
         *   style before its frames are loaded, so the render here would build
         *   the picture out of the PREVIOUS object's coordinates and throw it
         *   away a moment later. Measured on a ribosome-to-peptide switch:
         *   1,150-1,550 ms of a 2 s switch, all of it wasted.
         */
        setStyle(style, quiet) {
            // QUIET IS A FLAG ON THE RENDERER, not a parameter threaded down.
            // The draw this has to stop is not the one at the end of this
            // method: setPreset draws too, and so does anything else the
            // switch reaches. Suppressing only the last one left the cost
            // exactly where it was (measured: 1,143 ms of a 1,144 ms call).
            if (quiet) {
                const prev = this._quietStyle;
                this._quietStyle = true;
                try { return this.setStyle(style); } finally { this._quietStyle = prev; }
            }
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
            if (!quiet) this.render('setStyle');
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
        /**
         * @param {number} [nPositions] count to ask about, when it is not the
         *   one currently loaded. _switchToObject restores an object's style
         *   BEFORE its frames are loaded - this.coords is still the previous
         *   object's there, so a small structure following a huge one was
         *   refused its own cartoon and came back as a tube.
         */
        _cartoonWouldFit(nPositions) {
            const positions = (typeof nPositions === 'number') ? nPositions
                : ((this.coords && this.coords.length) || 0);
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
            // WIDTH: this style's own, if it was ever set by hand; the
            // profile's otherwise. The latch alone made it sticky ACROSS
            // styles, which carried a tube radius into a cartoon ribbon - see
            // _widthByStyle. Keyed on the current style, which setStyle has
            // already assigned by the time this runs, and not on the argument:
            // that is a PRESET name (richardson, 3d) on half the call sites.
            // PER STYLE, because the slider is one control and not one
            // quantity: in tube it is the radius of the tube, in cartoon it
            // scales the ribbon. This was a single "the user has taken it
            // over" flag, and once set the width stopped following ANY switch -
            // which is how a tube radius arrived in cartoon as a ribbon width.
            // A style that has never had its width dragged takes the profile's;
            // one that has takes its own back.
            const mine = this._widthByStyle && this._widthByStyle[this.style];
            this.lineWidth = (typeof mine === 'number') ? mine : d.width;
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
            // ONE DRAW PER SWITCH, AND NOT UNTIL THE NEW OBJECT IS IN.
            //
            // A switch is followed by half a dozen things that each ask for a
            // render - the visibility mask, the scatter, the sequence view,
            // and app.js re-running the Ortho slider - and every one of them
            // fires while this.coords still holds the PREVIOUS object: the
            // frames are loaded by the caller, after this returns. Cheap while
            // both objects were drawn the same way; ruinous once the style
            // travels with the object, because switching to a small cartoon
            // meant building a full cartoon of the ribosome still in memory
            // and throwing it away. Measured on 4UG0 -> 6MRR: one
            // render('orthoSlider') of 1,146 ms with 17,550 positions loaded,
            // for a picture of 68.
            //
            // Held until the next frame, by which time the caller has loaded
            // the frames, and then drawn ONCE.
            this._switchQuiet = true;
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    this._switchQuiet = false;
                    this.render('object switch settled');
                });
            } else {
                this._switchQuiet = false;
            }
            // THE MASK IS NOT ONE OBJECT'S WHILE SEVERAL ARE DRAWN. It covers
            // everything on screen, in merged indices, so filing it under the
            // object being switched away from would write another object's
            // hidden residues into its record - and restoring the new object's
            // copy below would hide most of the picture. Each object's share is
            // recovered from the live mask when the merge is rebuilt; see
            // _maskForObject.
            const mergedMask = (this.multiState && this.multiState.enabled)
                || this._mergeWanted();
            // Save current object's selection state and viewer state
            if (this.currentObjectName && this.currentObjectName !== newObjectName && this.objectsData[this.currentObjectName]) {
                const obj = this.objectsData[this.currentObjectName];
                this._saveVisibilityToObjects();
                obj.viewerState = {
                    rotation: this._deepCopyMatrix(this.viewerState.rotation),
                    zoom: this.viewerState.zoom,
                    ortho: this.viewerState.ortho,
                    focalLength: this.viewerState.focalLength,
                    center: this.viewerState.center ? { ...this.viewerState.center } : null,
                    extent: this.viewerState.extent,
                    currentFrame: this.currentFrame,
                    // THE CLIP TRAVELS WITH THE OBJECT. A slab is Angstrom along
                    // the camera's depth, and objects differ in size by orders
                    // of magnitude - a slab set on a peptide cuts a ribosome in
                    // half, and one set on a ribosome does nothing to a peptide.
                    // It rides with the rest of the per-object view state.
                    clipNear: this.clipNear,
                    clipFar: this.clipFar,
                    clipFade: this.clipFade,
                    // ...AND SO DOES THE STYLE. A ribosome is drawn as a tube
                    // because a ribbon of it is a tangle; a peptide beside it
                    // is not, and switching between the two should not mean
                    // setting the style again each time. The flag rides along
                    // with it so an automatic choice stays automatic and a
                    // hand-picked one stays picked.
                    style: this.style,
                    styleChosen: !!this.styleChosen
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
            //
            // NOT WHILE SEVERAL ARE MERGED. There the indices are the merged
            // array's and mean the same thing whichever object is being
            // edited - and the strip SETS the edited object from where you
            // clicked, so clearing here would throw away the selection that
            // asked for the switch.
            if (this.currentObjectName !== newObjectName && !mergedMask) {
                this.clearResidueSelection();
            }
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

            // ...and it is not restored under a merge either: what is hidden on
            // screen stays hidden, whichever object is being edited. Only the
            // PAE boxes travel, since the map belongs to the new object.
            if (mergedMask) {
                this.visibilityModel.paeBoxes = (savedState.paeBoxes || []).map((b) => ({ ...b }));
            } else {
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

            // Save the restored selection state (setVisibility would do this,
            // but we're bypassing it) - per object under a merge, where the
            // live mask is not any one object's.
            this._saveVisibilityToObjects();

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
                currentFrame: -1,
                clipNear: null,
                clipFar: null,
                clipFade: CLIP_FADE_DEFAULT,
                style: null,
                styleChosen: false
            };
            // THE CAMERA DOES NOT MOVE WHEN SEVERAL OBJECTS ARE ON SCREEN.
            //
            // Picking a different object to work on is not a request to look
            // somewhere else: both structures are in front of you, framed
            // together, and swinging to one object's saved pose would throw the
            // other off the screen - the same complaint as clicking a name
            // hiding the other, in a different disguise. Only the frame index
            // is taken, since that is which frame of the new object to draw.
            const merged = (this.multiState && this.multiState.enabled)
                || this._mergeWanted();
            this.viewerState = merged ? {
                ...this.viewerState,
                currentFrame: saved.currentFrame
            } : {
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

            // ...and its clip. An object that has never been clipped comes back
            // unclipped, rather than inheriting the slab of whatever was on
            // screen before it.
            // ...and neither does the clip, for the same reason: a slab set on
            // one of two merged structures is a slab through the picture, and
            // the picture has not changed.
            if (!merged) {
                this.clipNear = (typeof saved.clipNear === 'number') ? saved.clipNear : null;
                this.clipFar = (typeof saved.clipFar === 'number') ? saved.clipFar : null;
                this.clipFade = (typeof saved.clipFade === 'number')
                    ? saved.clipFade : CLIP_FADE_DEFAULT;
            }

            // ...AND ITS STYLE, for the same reason the clip travels: what is
            // right for a ribosome is not right for the peptide beside it.
            // An object that has never been drawn (no saved style) keeps
            // whatever is on screen, and the loader's size rule decides for it
            // a moment later - see tubeByDefaultIfBig in web/app.js.
            //
            // setStyle, not an assignment: a style carries a whole profile of
            // defaults with it, and half-switching leaves the panel describing
            // one style while the renderer draws another.
            // ...NOR DOES THE STYLE CHANGE UNDER A MERGE. One array is drawn
            // one way, so taking the newly picked object's style would restyle
            // the other structures with it - and the user asked to edit that
            // object, not to redraw the picture.
            this.styleChosen = merged ? this.styleChosen : !!saved.styleChosen;
            if (!merged && saved.style && saved.style !== this.style && this.setStyle) {
                // ...ASKED ABOUT THE OBJECT BEING SWITCHED TO, not the one on
                // screen. The frames are loaded by the caller, after this, so
                // this.coords is still the PREVIOUS object's - and a small
                // structure following a huge one had its cartoon refused on
                // the huge one's size and came back as a tube.
                const fr = obj.frames && obj.frames[
                    (saved.currentFrame >= 0 ? saved.currentFrame : 0)];
                const nPos = (fr && fr.coords && fr.coords.length) || 0;
                const fits = saved.style !== 'cartoon' || this.cartoonForce
                    || !this._cartoonWouldFit || this._cartoonWouldFit(nPos).ok;
                if (fits) {
                    const force = this.cartoonForce;
                    this.cartoonForce = true;      // the size question is settled
                    // ...AND NOT A PIXEL DRAWN HERE. setStyle ends in a render,
                    // and at this point the new object's frames are not loaded
                    // yet - this.coords still holds the PREVIOUS object's. On a
                    // switch from a ribosome to a peptide that render built a
                    // full cartoon of the ribosome and threw it away a moment
                    // later when 68 positions replaced 17,550: measured 1,150
                    // to 1,550 ms of the 2 s the switch took, all of it wasted.
                    // The caller draws once the frames are in.
                    this.setStyle(saved.style, true);
                    this.cartoonForce = force;
                }
            }

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

            // ...AND THE CAPTURE PANEL, if it is open. A different object has a
            // different answer to "is there a trajectory to record": switching
            // from one with frames to one without left a Frames button that
            // recorded nothing, and switching the other way left the button
            // missing until the panel was closed and opened again.
            if (this._savePanel && !this._captureBusy) this._rebuildSavePanel();

            // Note: _composeAndApplyMask will be called by setFrame after the frame data is loaded
        }

        // Add a new object
        addObject(name) {
            // A NEW OBJECT JOINS WHAT IS ON SCREEN. The shown set is a list of
            // names, and one that does not mention the object just loaded
            // leaves it invisible - so a fetch, a Copy or a drag-and-drop while
            // two structures are up would appear to have done nothing. Only
            // when a set exists at all: empty still means "just the current
            // one", which is every single-object session.
            if (this.shownObjects instanceof Set && this.shownObjects.size) {
                this.shownObjects.add(name);
            }
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

            this._recomputeObjectStats(object);

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
            // WHAT IS CLIPPED AWAY CANNOT BE CLICKED. The slab cuts the drawing,
            // and picking has to agree with the drawing or the click lands on
            // something nobody can see - the residue behind the near plane,
            // which is exactly the one the clip was set to get out of the way.
            // Tested on the depth the cursor is at along a segment, which is
            // the same number the shader discards on.
            const clipped = (z) => !this.clipAccepts(z);
            // +z is toward the viewer (see Coordinate System)
            const offer = (idx, d2, z, seg) => {
                if (clipped(z)) return;
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
        /**
         * Is this position one a click in the viewer may land on? False for
         * anything the clip slab has cut away - the drawing does not show it,
         * so a selection made in the viewer must not contain it.
         */
        _pickable(i) {
            if (!this.clipSlabOn()) return true;
            this._ensureRotated();
            const c = this.rotatedCoords && this.rotatedCoords[i];
            return !c || this.clipAccepts(c.z);
        }

        pickGroupAt(i) {
            if (i < 0) return [];
            // A CONTACT IS ONE THING TO CLICK, and what it names is the pair it
            // joins - selecting one end of it says nothing you did not already
            // know from where you clicked. Only when the contact is what was
            // actually hit: a click on a residue that happens to be a contact
            // endpoint is a click on the residue, and the segment test in
            // pickResidueAt has already decided which of the two was nearer.
            const pc = this._pickedContact;
            if (pc && (pc[0] === i || pc[1] === i)) {
                // both ends, unless the clip has taken one of them
                return [pc[0], pc[1]].filter((k) => this._pickable(k));
            }
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
        // CLIP, THE WAY PyMOL DOES IT
        //
        // A slab in CAMERA space: keep what lies between clipFar and clipNear
        // along the view's own z, and cut everything else. Not a selection and
        // not a visibility state - the geometry is CUT, so a ribbon that
        // crosses the plane is drawn up to it and stops, and the interior it
        // exposes is open to the camera. That is what "clip" means in PyMOL,
        // and it is why this lives in the draw rather than in the mask.
        //
        // Being camera space it follows the view for nothing: turn the
        // structure and the slab stays where the camera is, which is the whole
        // point of clipping into something.
        //
        // Nothing is committed and nothing is remembered per object: switch it
        // off and the drawing is whole again.
        // ====================================================================

        /**
         * How far the drawing reaches from the view centre, in Angstrom: the
         * furthest position, plus what the STYLE adds around it.
         *
         * A radius, and deliberately not the view's depth extent. The extent
         * changes as the structure turns - a molecule seen end-on is deeper
         * than the same molecule side-on - so a slab set from it starts cutting
         * the moment you rotate, without anyone touching a control. That is
         * what "resetting doesn't recover everything" was: reset restored the
         * extent OF THAT VIEW, and the next rotation ate into the structure
         * again. A radius cannot do that: it is the same number from every
         * angle, so a slab set to it cuts nothing until a slider is moved.
         *
         * The pad is the style's own reach past the positions: a ribbon is
         * drawn lineWidth Angstrom wide about its backbone and a tube has a
         * radius, so a slab tight to the ATOMS would shave the surface drawn
         * around them.
         */
        _clipReach() {
            this._ensureRotated();
            const n = this.coords ? this.coords.length : 0;
            const rc = this.rotatedCoords;
            if (!n || !rc || rc.length < n) return 0;
            let r2 = 0;
            for (let i = 0; i < n; i++) {
                const c = rc[i];
                const d = c.x * c.x + c.y * c.y + c.z * c.z;
                if (d > r2) r2 = d;
            }
            if (!(r2 > 0)) return 0;
            return Math.sqrt(r2) + Math.max(2, 2 * (this.lineWidth || 3));
        }

        /**
         * The structure's actual depth range IN THIS VIEW - what the control's
         * track spans, so that moving a knob cuts something immediately.
         *
         * Not the same as the rest state: that is a radius, deliberately, so
         * that rotating cannot start a cut on its own. The radius is bigger
         * than this whenever the structure is wider than it is deep, and a
         * track drawn to the radius spends its first stretch crossing empty
         * space - which is what "the endpoints do not hide anything when I move
         * them" is. So the track measures the view and the ENDS mean off: a
         * knob at its limit is stored as the rest state, not as this number.
         */
        clipViewExtent() {
            this._ensureRotated();
            const n = this.coords ? this.coords.length : 0;
            const rc = this.rotatedCoords;
            if (!n || !rc || rc.length < n) return null;
            let lo = Infinity; let hi = -Infinity;
            for (let i = 0; i < n; i++) {
                const z = rc[i].z;
                if (z < lo) lo = z;
                if (z > hi) hi = z;
            }
            if (!(hi >= lo)) return null;
            // NO PAD. The rest state pads, because a slab tight to the ATOMS
            // would shave the surface drawn around them - but the track is
            // where the knobs travel, and padding it spends the first stretch
            // of that travel on empty space: 6 Angstrom of a 36 Angstrom
            // structure, during which moving the knob visibly did nothing. A
            // knob at the end is off anyway (see the caller), so the end has no
            // shaving to avoid; one step in cuts the front of the drawing,
            // which is what a knob at the front of the structure should do.
            return { far: lo, near: hi };
        }

        /** A slab that holds the whole structure however it is turned. */
        clipSlabDefault() {
            const R = this._clipReach();
            if (!(R > 0)) return null;
            return { far: -R, near: R };
        }

        /**
         * THE SLAB THAT HOLDS THE SELECTION - what Auto sets.
         *
         * A cut is nearly always wanted around something: you pick a site and
         * you want the rest of the structure out of the way. Doing that by hand
         * means dragging two knobs against a picture that changes as you drag,
         * and the answer is already known - the selection has a depth range in
         * this view, and the slab is that range with room to breathe.
         *
         * WITH NOTHING SELECTED IT IS THE REST STATE, which cuts nothing from
         * any angle. That is the same answer the Reset button used to give, so
         * Auto replaces it rather than sitting beside it: no selection, no
         * context, and the only sensible context-free slab is all of it.
         *
         * The set is expanded the way Orient expands it (framingPositions): a
         * residue's side-chain atoms and a ligand's other atoms belong to the
         * thing you picked, and hidden ones do not.
         *
         * THICK ENOUGH TO SURVIVE A ROTATION. The obvious slab is the
         * selection's depth range in this view, and it is wrong the moment the
         * model turns: a site lying flat in the screen plane has almost no
         * depth, so that slab is a few Angstrom thick, and a quarter turn
         * stands the site up on end and cuts it in half.
         *
         * The selection's RADIUS does not turn. Half the thickness is the
         * distance from the selection's centre to the furthest thing in it, so
         * the slab holds the whole of it whatever angle it is seen from - the
         * same reason a bounding sphere is used for framing rather than a
         * bounding box.
         *
         * Its CENTRE is still this view's: a slab is camera space and its
         * depth has to come from somewhere. That part goes stale on a rotation
         * about anything other than the selection itself, which is what makes
         * this a button rather than a mode - and pressing Orient first pins
         * the view to the selection, after which it does not move at all.
         */
        clipSlabForSelection(set) {
            const base = this.clipSlabDefault();
            this.clipAuto = null;
            const raw = set || (this.selectionInk ? this.selectionInk()
                : this.residueSelection);
            const sel = this.framingPositions
                ? this.framingPositions(raw) : raw;
            if (!sel || !sel.size) return base;
            this._ensureRotated();
            const rc = this.rotatedCoords;
            const n = this.coords ? this.coords.length : 0;
            if (!rc || !n) return base;
            // The centre, and then the furthest thing from it. In MODEL space,
            // where neither number depends on the view at all: a distance
            // survives a rotation, and a centre that is remembered as
            // coordinates can be re-projected at any angle. That is what makes
            // the slab TRACK - see _refreshAutoClip.
            const co = this.coords;
            let cx = 0; let cy = 0; let cz = 0; let m = 0;
            for (const i of sel) {
                if (!(i >= 0 && i < n) || !co[i]) continue;
                cx += co[i].x; cy += co[i].y; cz += co[i].z; m++;
            }
            if (!m) return base;
            cx /= m; cy /= m; cz /= m;
            let r2 = 0;
            for (const i of sel) {
                if (!(i >= 0 && i < n) || !co[i]) continue;
                const dx = co[i].x - cx; const dy = co[i].y - cy;
                const dz = co[i].z - cz;
                const d = dx * dx + dy * dy + dz * dz;
                if (d > r2) r2 = d;
            }
            // ROOM TO BREATHE. A position is a point and the thing drawn at it
            // has a radius, so a slab through the extreme atoms cuts the very
            // residues it was asked to show. Half the line width clears the
            // geometry and the rest is context - enough to see what the site
            // sits in, not so much that the cut stops being one.
            const pad = 1.5 + 0.5 * (this.lineWidth || 3);
            const half = Math.sqrt(r2) + pad;
            // REMEMBERED, so the slab can follow. Pressing Auto and then
            // rotating used to leave the cut where the selection HAD been, and
            // pressing it again gave a different answer at every angle - the
            // depth of the thing had changed and the slab had not. Held as a
            // point and a radius rather than as two planes, because that is
            // the part of the answer that does not depend on the view.
            this.clipAuto = { x: cx, y: cy, z: cz, half };
            const view = this._autoClipDepth();
            return (view === null) ? base : { near: view + half, far: view - half };
        }

        /**
         * AUTO: fit the slab to the selection and keep it there.
         *
         * The one entry point, because the tracking has to survive the set:
         * setClipSlab drops it (a knob dragged wins over a slab computed), and
         * this is the one caller that means the opposite.
         */
        autoClip(set) {
            const slab = this.clipSlabForSelection(set);
            if (!slab) return null;
            const keep = this.clipAuto;
            this.setClipSlab(slab.near, slab.far);
            this.clipAuto = keep;
            return slab;
        }

        /**
         * The remembered auto-clip centre's depth IN THIS VIEW, by the same two
         * steps _rotateCoords applies to every position: the object's own
         * best_view rotation, then the user's, about the view centre. One point
         * rather than the whole array, so this is a handful of multiplies and
         * can run every frame.
         */
        _autoClipDepth() {
            const a = this.clipAuto;
            if (!a) return null;
            const object = this.objectsData
                ? this.objectsData[this.currentObjectName] : null;
            let x = a.x; let y = a.y; let z = a.z;
            const oR = (object && object.rotation_matrix && object.center)
                ? object.rotation_matrix : null;
            if (oR) {
                const oc = object.center;
                const dx = x - oc[0]; const dy = y - oc[1]; const dz = z - oc[2];
                x = oR[0][0] * dx + oR[0][1] * dy + oR[0][2] * dz + oc[0];
                y = oR[1][0] * dx + oR[1][1] * dy + oR[1][2] * dz + oc[1];
                z = oR[2][0] * dx + oR[2][1] * dy + oR[2][2] * dz + oc[2];
            }
            const c = this._computeViewCentre(object);
            const m = this.viewerState.rotation;
            if (!m) return null;
            return m[2][0] * (x - c.x) + m[2][1] * (y - c.y) + m[2][2] * (z - c.z);
        }

        /**
         * KEEP AN AUTO SLAB ON ITS SELECTION. Called once per frame, before
         * anything reads the planes.
         *
         * A slab is camera space and the thing it was cut around is not, so a
         * rotation moves one and not the other: the cut slid off the site, and
         * pressing Auto again gave a different pair of planes at every angle
         * because the depth of the selection had changed underneath it. The
         * thickness never needed to change - a radius does not rotate - only
         * where the slab sits, and that is one point re-projected.
         *
         * Dropped the moment the slab is set by hand (see setClipSlab): a knob
         * dragged is an answer given, and it must not be overwritten on the
         * next frame.
         */
        _refreshAutoClip() {
            if (!this.clipAuto || this.clipNear === null) return;
            const z = this._autoClipDepth();
            if (z === null) return;
            this.clipNear = z + this.clipAuto.half;
            this.clipFar = z - this.clipAuto.half;
        }

        /**
         * Set the slab. near is the plane closer to the camera (larger z), far
         * the one further away; near <= far is refused rather than swapped,
         * because a slab of nothing is a drawing of nothing and reads as a bug.
         * Pass nulls to clip nothing.
         */
        setClipSlab(near, far) {
            // A SLAB SET BY HAND IS AN ANSWER GIVEN, and the next frame must
            // not overwrite it: any explicit set drops the auto tracking. Auto
            // itself goes through autoClip, which puts it back afterwards.
            this.clipAuto = null;
            if (near === null || far === null) {
                this.clipNear = null;
                this.clipFar = null;
            } else {
                const nz = Number(near); const fz = Number(far);
                if (!isFinite(nz) || !isFinite(fz)) return;
                const MIN = 0.5;
                this.clipNear = Math.max(nz, fz + MIN);
                this.clipFar = Math.min(fz, this.clipNear - MIN);
            }
            // written through to the object as well, so switching away and back
            // finds it where it was left
            const obj = this.objectsData && this.objectsData[this.currentObjectName];
            if (obj && obj.viewerState) {
                obj.viewerState.clipNear = this.clipNear;
                obj.viewerState.clipFar = this.clipFar;
                obj.viewerState.clipFade = this.clipFade;
            }
            this.render('clip slab');
        }

        // NUMBERS, not "not null". A renderer built before this existed - a
        // saved state, the lifted class the tests build - has neither field at
        // all, and `undefined !== null` is true, which turned a viewer with no
        // slab into one that clipped everything.
        clipSlabOn() {
            return typeof this.clipNear === 'number' && typeof this.clipFar === 'number';
        }

        /**
         * Set the soft edge, as a fraction of the slab's thickness. 0 is a
         * hard cut. Clamped to 1: a fade wider than the slab itself leaves
         * nothing at full strength anywhere, which reads as a bug rather than
         * as a setting.
         */
        setClipFade(f) {
            const v = Number(f);
            if (!isFinite(v)) return;
            this.clipFade = Math.max(0, Math.min(1, v));
            const obj = this.objectsData && this.objectsData[this.currentObjectName];
            if (obj && obj.viewerState) obj.viewerState.clipFade = this.clipFade;
            this.render('clip fade');
        }

        /**
         * The soft edge in ANGSTROM - what the shaders and the 2D paths want.
         * Zero whenever there is no slab to be soft about.
         */
        clipFadeWidth() {
            if (!this.clipSlabOn()) return 0;
            const f = (typeof this.clipFade === 'number') ? this.clipFade : 0;
            if (!(f > 0)) return 0;
            return Math.max(0, (this.clipNear - this.clipFar)) * f;
        }

        /**
         * How much of this view-space depth survives the clip: 1 inside the
         * slab, 0 past the fade, a straight ramp between. THE one test, so the
         * 2D paths and the shaders cannot drift apart about where the planes
         * are or how soft they are.
         */
        clipCoverage(z) {
            if (!this.clipSlabOn()) return 1;
            const d = Math.min(this.clipNear - z, z - this.clipFar);
            if (d >= 0) return 1;
            const w = this.clipFadeWidth();
            if (!(w > 0)) return 0;
            return Math.max(0, 1 + d / w);
        }

        /**
         * Is this depth inside the slab enough to be treated as there? Drawing
         * asks clipCoverage, because it can draw a ghost; picking and the
         * cheap culls ask this, because a click cannot land on half a residue.
         * Half covered is the line.
         */
        clipAccepts(z) {
            if (!this.clipSlabOn()) return true;
            return this.clipCoverage(z) >= 0.5;
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
            // position sets: sidechains, elements, bases, hiddenBackbone
            for (const key of ['sidechains', 'elements', 'bases', 'hiddenBackbone']) {
                const set = src[key];
                if (!(set instanceof Set)) continue;
                const out = new Set();
                for (const i of set) {
                    const to = renumber.get(i);
                    if (to !== undefined) out.add(to);
                }
                // An empty result is NOT the same as absent for every one of
                // these - null means ALL for bases and elements, NONE for side
                // chains and NONE HIDDEN for the backbone - so an empty set is
                // stored as empty rather than collapsed to null, which would
                // invert two of the four.
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
            const C = window.py2dmolCartoon;
            const localFrame = C && C.localFrame;
            // A NUCLEIC TRACE STEPS 5.5-6.5 A, and localFrame's default range is
            // the peptide's 3.0-4.2 - so every nucleotide read as a chain break
            // here, every row was dropped as "unframable at source", and a
            // copied RNA arrived with no bases at all. The range is the one the
            // table was BUILT with; anything else and the coefficients mean
            // something different in the copy from what they meant here.
            const nucLo = C && C.NUCLEIC_STEP_MIN;
            const nucHi = C && C.NUCLEIC_STEP_MAX;
            const types = this.positionTypes || [];
            // ...asked of the SOURCE index either way: a destination anchor is
            // the same residue, just renumbered.
            const isNuc = (which, i) => {
                const src = which === 's' ? i : selectedIndices[i];
                return types[src] === 'D' || types[src] === 'R';
            };
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
                    const nuc = isNuc(which, i);
                    const ok = localFrame && (nuc
                        ? localFrame(at, n, i, fbuf, null, nucLo, nucHi)
                        : localFrame(at, n, i, fbuf, null));
                    frameCache.set(key, ok ? fbuf.slice() : null);
                }
                return frameCache.get(key);
            };
            const pos = []; const frameOf = []; const coef = [];
            const names = []; const elements = []; const onBackbone = [];
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
                // ...and whether this row is a backbone atom kept on purpose -
                // proline's ring-closing N. Dropped here, a copied proline goes
                // back to diving into the ribbon.
                onBackbone.push((sc.onBackbone && sc.onBackbone[k]) ? 1 : 0);
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
                onBackbone: new Uint8Array(onBackbone),
            };
        }

        /**
         * DELETE THE SELECTED RESIDUES from this object, in place.
         *
         * The object stays the object: same name, same entry in the list, same
         * camera, same frame, same everything except the residues that are
         * gone. It is Hide with the positions actually removed - and it looks
         * the same while it happens, because nothing switches and nothing is
         * rebuilt around it.
         *
         * The frames come from the shared subset builder, which is also what
         * Copy uses, so there is one implementation of "these positions,
         * renumbered" rather than two that can drift. Everything keyed by
         * position index travels through the same remap Copy uses: side chains,
         * bases, per-residue colours, contacts, the MSA columns, and the
         * visibility mask.
         *
         * Destructive in the session only: nothing is written to disk.
         */
        _deleteSelection() {
            const name = this.currentObjectName;
            const object = name ? this.objectsData[name] : null;
            if (!object || !object.frames || !object.frames.length) return false;
            const sel = this.residueSelection;
            if (!sel || !sel.size) {
                console.warn('Nothing selected - nothing to delete.');
                return false;
            }
            const first = object.frames[0];
            const n = (first.coords || []).length;
            const keep = [];
            for (let i = 0; i < n; i++) if (!sel.has(i)) keep.push(i);
            if (!keep.length) {
                console.warn('That would delete every residue - use Clear All instead.');
                return false;
            }
            if (keep.length === n) return false;              // nothing selected here

            // WHERE EACH SURVIVOR ENDS UP, for everything that is keyed by
            // position index rather than carried in the frames.
            const newIndexOf = new Map();
            for (let k = 0; k < keep.length; k++) newIndexOf.set(keep[k], k);

            const frames = this._subsetFrames(object, keep);
            if (!frames.length) return false;

            // ...the pose, through the same remap Copy uses. Into a scratch
            // object first: the remap reads the source while it writes, and the
            // source here is the destination.
            const moved = {};
            this._remapObjectState(object, moved, keep);
            for (const key of Object.keys(moved)) object[key] = moved[key];

            // ...the MSA columns for the residues that are left
            if (object.msa && window.MSA && typeof window.MSA.extractSubset === 'function') {
                const holder = { frames: frames, msa: null };
                window.MSA.extractSubset(object, holder, first, keep);
                object.msa = holder.msa || null;
            }

            object.frames = frames;
            this._recomputeObjectStats(object, false);        // ...but do not move the camera

            // THE MASK IS POSITION INDICES TOO. Renumbered rather than reset:
            // a delete is not a reason to un-hide the chain you were hiding.
            const vm = this.visibilityModel;
            if (vm && vm.positions && vm.positions.size) {
                const next = new Set();
                for (const i of vm.positions) {
                    const at = newIndexOf.get(i);
                    if (at !== undefined) next.add(at);
                }
                vm.positions = next;
            }
            if (object.visibilityState && object.visibilityState.positions) {
                const next = new Set();
                for (const i of object.visibilityState.positions) {
                    const at = newIndexOf.get(i);
                    if (at !== undefined) next.add(at);
                }
                object.visibilityState.positions = next;
            }

            // the selection named the residues that are gone
            this.clearResidueSelection();
            this._invalidateSegmentCache();
            this._invalidateShadowCache();
            this.lastShadowRotationMatrix = null;
            if (window.py2dmolCartoonGPU) window.py2dmolCartoonGPU.invalidate();
            // ...and the frame reloads where it was, which is what makes this
            // look like a hide rather than a reload
            const at = (this.currentFrame >= 0 && this.currentFrame < frames.length)
                ? this.currentFrame : 0;
            this.setFrame(at);
            this.updateUIControls();
            return true;
        }

        /**
         * THE FRAMES OF A SUBSET, position by position - the half of Copy that
         * Delete needs too.
         *
         * Lifted out of extractSelection unchanged rather than paraphrased: it
         * is the third field-by-field frame build in this codebase and the one
         * that has silently dropped side chains twice, so there is exactly one
         * of it. `keep` is sorted position indices; the frames come back
         * renumbered to match, and nothing is installed anywhere.
         */
        /**
         * The object's own measurements - centre, extent, spread - recomputed
         * over every frame it holds. Lifted out of addFrame so that anything
         * which CHANGES the frames can refresh them, and taking a flag for the
         * one part that is not a measurement: addFrame recentres the camera on
         * what it just loaded, and a delete must not.
         */
        _recomputeObjectStats(object, moveCamera = true) {
            if (!object || !object.frames) return;
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
            if (moveCamera) {
                this.viewerState.center = { x: globalCenter.x, y: globalCenter.y, z: globalCenter.z };
            }
            object.totalPositions = totalCount;
            object.globalCenterSum = new Vec3(globalCenter.x * totalCount, globalCenter.y * totalCount, globalCenter.z * totalCount);
        }

        _subsetFrames(object, keep) {
            const selectedIndices = keep;
            const selectedIndicesSet = new Set(keep);
            const out = [];
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
                // the file this frame came from: a copy is the same frames
                // with fewer positions, so it is still that file's frame
                name: frame.name,
                chains: frame.chains ? [] : undefined,
                plddts: sourcePlddt ? [] : undefined,
                position_types: frame.position_types ? [] : undefined,
                position_names: frame.position_names ? [] : undefined,
                // a ligand atom's own name and element, where the frame has
                // them - a copy of a ligand that lost these would lose its
                // element colours with them
                position_atoms: frame.position_atoms ? [] : undefined,
                position_elements: frame.position_elements ? [] : undefined,
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
                    if (frame.position_atoms && idx < frame.position_atoms.length) {
                        extractedFrame.position_atoms.push(frame.position_atoms[idx]);
                    }
                    if (frame.position_elements && idx < frame.position_elements.length) {
                        extractedFrame.position_elements.push(frame.position_elements[idx]);
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

            out.push(extractedFrame);
        }
            return out;
        }

        _extractSelection() {
            // Check if we have a current object and frame
            if (!this.currentObjectName) {
                console.warn("No object loaded. Cannot extract selection.");
                return null;
            }

            const object = this.objectsData[this.currentObjectName];
            if (!object || !object.frames || object.frames.length === 0) {
                console.warn("No frames available. Cannot extract selection.");
                return null;
            }

            // Use first frame to determine selection (selection is frame-independent)
            const firstFrame = object.frames[0];
            if (!firstFrame || !firstFrame.coords) {
                console.warn("First frame has no coordinates. Cannot extract selection.");
                return null;
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
                return null;
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

            // the frames themselves, built by the shared subset builder
            for (const extractedFrame of this._subsetFrames(object, selectedIndices)) {
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

            this._showObject(extractName);
            return extractName;
        }

        /**
         * PUT AN OBJECT ON SCREEN, whole: switch to it, load its first frame,
         * and bring everything that has its own copy of the data along - the
         * PAE panel, the scatter plot, the object dropdown, the sequence strip.
         *
         * Lifted out of extractSelection so Cut can end the same way. Cut makes
         * the copy, goes BACK to the source to take the residues out of it, and
         * has to land on the new object afterwards; without this it would be a
         * second copy of a dozen lines that were already easy to get wrong.
         */
        _showObject(name) {
            // synchronous: sets currentObjectName, leaves overlay mode if it is
            // on, and invalidates the caches
            this._switchToObject(name);
            this.setFrame(0);
            // The PAE renderer keeps its own copy of the matrix, so it is told
            // rather than left to notice.
            const obj = this.objectsData[name];
            if (window.PAE && obj) window.PAE.updateFrame(this, obj, 0);
            if (this.paeRenderer && this.paeRenderer.render) this.paeRenderer.render();
            this.updateScatterContainerVisibility();
            if (this.objectSelect) this.objectSelect.value = name;
            // everything visible, since nothing here has been hidden yet
            this.setVisibility({
                positions: new Set(), chains: new Set(), paeBoxes: [],
                visibilityMode: 'default',
            });
            // DROP THE SELECTION. It holds position indices into the object
            // that was current when the drag happened, and a different object
            // is current now - the same indices name different residues there,
            // or none at all. Carrying it over made a second Copy extract a
            // slice of the first copy rather than the region the user could
            // see highlighted.
            this.clearResidueSelection();
            this.updateUIControls();
            if (typeof window !== 'undefined' && window.SEQ && window.SEQ.buildView) {
                if (window.SEQ.clear) window.SEQ.clear();
                window.SEQ.buildView();
            }
        }

        /**
         * CUT: the copy Copy makes, minus the residues from where they came.
         *
         * Not a button that presses the other two, because the order is the
         * whole difficulty. Copy switches to the new object, and Delete works
         * on whatever is current - so pressing them in sequence deletes the
         * copy out of itself and leaves the original untouched, which is the
         * opposite of a cut. This goes back to the source with the selection it
         * had, takes them out there, and then lands on the piece that was cut.
         *
         * @returns {object|null} {name, removed} or null if there was nothing
         *          to cut
         */
        _cutSelection() {
            const src = this.currentObjectName;
            const sel = (this.residueSelection && this.residueSelection.size)
                ? new Set(this.residueSelection) : null;
            if (!src || !sel) {
                console.warn('Nothing selected - nothing to cut.');
                return null;
            }
            const made = this._extractSelection();
            if (!made) return null;
            // ...back to where they came from, with the selection that named
            // them, and out
            this._switchToObject(src);
            this.setResidueSelection(sel);
            const removed = this._deleteSelection() ? sel.size : 0;
            this._showObject(made);
            return { name: made, removed };
        }



        /**
         * MOVE TO A FRAME DURING PLAYBACK, loading whatever that means.
         *
         * Three cases, and every animation and recording path needs all three:
         * in overlay mode every frame is already in the array and loading one
         * would destroy the merge; with several objects merged, the merge is
         * rebuilt so the OTHER objects stay on screen; otherwise the frame is
         * loaded as it always was. Each of these call sites used to test the
         * overlay alone, so playing an animation with two objects up dropped
         * one of them on the first tick.
         */
        _loadFrameForPlayback(frameIndex) {
            if (this.overlayState && this.overlayState.enabled) return;
            if ((this.multiState && this.multiState.enabled) || this._mergeWanted()) {
                this._applyShownObjects(true);
                return;
            }
            this._loadFrameData(frameIndex, true);
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
            } else if (this.multiState.enabled || this._mergeWanted()) {
                // SEVERAL OBJECTS: the merge is rebuilt, not replaced by one
                // frame. This object stepping a frame changes its share of the
                // array and nothing else's, and loading the frame on its own
                // would drop every other object off the screen - which is what
                // switching the current object does, since that is a switch
                // followed by setFrame(0). It is also how the merge STARTS:
                // the second object to load makes drawnObjects answer with two
                // names, and the next frame load builds it.
                this._applyShownObjects(skipRender);
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

            // BOTH OBJECT CONTROLS APPEAR WITH THE SECOND OBJECT, and neither
            // before it: with one object loaded there is nothing to show or
            // hide and nothing to pick between.
            if (this.objectSelect) {
                // The picker is not shown at all any more - the strip's
                // sections say which object you are working on, and clicking
                // in one is how you change it. The element stays because
                // everything drives the current object through it.
                const doc = this.objectSelect.ownerDocument || document;
                const row = doc.getElementById('objectRow');
                if (row) row.style.display = (objectCount <= 1) ? 'none' : 'flex';
                const list = doc.getElementById('objectList');
                if (list && objectCount <= 1) {
                    list.hidden = true;
                    const btn = doc.getElementById('objectListButton');
                    if (btn) btn.setAttribute('aria-expanded', 'false');
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
            // ligand atom names and elements, blank-filled for the frames that
            // have none so the merged arrays stay in step with the coordinates
            const mergedPositionAtoms = [];
            const mergedPositionElements = [];
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

                // ONE AT A TIME, not spread: `out.push(...src)` passes every
                // element as an argument and blows the stack between 100k and
                // 125k of them. A capsid overlaid on itself reaches that on its
                // own, and the failure is a thrown RangeError in the middle of
                // a load, not a slow frame.
                const append = (out, src) => {
                    for (let k = 0; k < src.length; k++) out.push(src[k]);
                };
                append(mergedPlddts, plddts);
                append(mergedPositionTypes, positionTypes);
                append(mergedPositionNames, positionNames);
                append(mergedPositionAtoms, (frame.position_atoms
                    && frame.position_atoms.length === frameAtomCount
                    ? frame.position_atoms : Array(frameAtomCount).fill('')));
                append(mergedPositionElements, (frame.position_elements
                    && frame.position_elements.length === frameAtomCount
                    ? frame.position_elements : Array(frameAtomCount).fill('')));
                append(mergedResidueNumbers, residueNumbers);

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
                position_atoms: mergedPositionAtoms,
                position_elements: mergedPositionElements,
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
         * ONE OBJECT'S FRAME, WITH EVERYTHING IT INHERITS RESOLVED.
         *
         * A frame stores only what changed: plddts, PAE and bonds may live on
         * the object or on an earlier frame instead. Both the single-object
         * load and the multi-object merge need the resolved article, so it is
         * built in one place.
         */
        _resolvedFrame(object, frameIndex) {
            const data = object?.frames?.[frameIndex];
            if (!data) return null;
            const resolvedPlddt = this._resolvePlddtData(object, frameIndex);
            const resolvedPae = window.PAE ? window.PAE.resolveData(object, frameIndex)
                : (data.pae || null);
            return {
                ...data,
                plddts: resolvedPlddt ?? data.plddts ?? null,
                pae: resolvedPae !== null ? resolvedPae : data.pae,
                bonds: object.bonds || null
            };
        }

        /**
         * SEVERAL OBJECTS AS ONE COORDINATE ARRAY.
         *
         * The overlay merges the frames of one object (_mergeFrameRange); this
         * merges the current frame of several objects, and the two are
         * deliberately the same shape. Downstream nothing knows the difference:
         * one array of positions, one bond list with the indices offset, and a
         * map saying where each position came from - handed to the cartoon as a
         * bonding group, exactly as frameIdMap is, so nothing joins across
         * sources.
         *
         * That the merge is real and not a composite is what buys shadowing,
         * depth sorting, picking and both GPU paths with no new code. The price
         * is that ONE style draws the lot; see MULTI_OBJECT_PLAN.md.
         *
         * @param {string[]} names - objects to merge, in drawing order
         * @returns {Object|null} merged data, plus sourceIdMap (position ->
         *   index into sourceNames), sourceNames and sourceOffsets
         */
        _mergeObjects(names) {
            const list = (names || []).filter(
                n => this.objectsData?.[n]?.frames?.length);
            if (!list.length) return null;

            const coords = [];
            const plddts = [];
            const chains = [];
            const positionTypes = [];
            const positionNames = [];
            const positionAtoms = [];
            const positionElements = [];
            const residueNumbers = [];
            const bonds = [];
            const sourceIdMap = [];
            const sourceOffsets = [];
            const sourceNames = [];
            // ...and which frame each was taken from, so the colour hierarchy
            // can ask a source's OWN frame for a frame-level colour
            const sourceFrames = [];
            const sourceAutoColors = [];
            const sideRows = [];
            let firstPae;

            for (const name of list) {
                const object = this.objectsData[name];
                // The frame each object is PARKED ON. The current object's is
                // live in this.currentFrame; every other object's was saved
                // when it was switched away from.
                let frameIdx = (name === this.currentObjectName)
                    ? this.currentFrame
                    : (object.viewerState?.currentFrame ?? 0);
                frameIdx = Math.max(0, Math.min(frameIdx | 0, object.frames.length - 1));

                const frame = this._resolvedFrame(object, frameIdx);
                if (!frame) continue;

                const fc = frame.coords || [];
                const n = fc.length;
                if (!n) continue;

                const offset = coords.length;
                const src = sourceNames.length;
                sourceNames.push(name);
                sourceOffsets.push(offset);
                sourceFrames.push(frameIdx);

                const fill = (arr, fallback) => (arr && arr.length === n) ? arr : fallback();
                // APPENDED ONE AT A TIME, not spread. `out.push(...src)` passes
                // every element as an argument and blows the stack somewhere
                // between 100k and 125k of them - which a capsid or a ribosome
                // reaches on its own, and this is the path that puts two of
                // them in one array. Measured: 100,000 fine, 125,000 throws.
                const append = (out, src) => {
                    for (let k = 0; k < src.length; k++) out.push(src[k]);
                };
                const fChains = fill(frame.chains, () => Array(n).fill('A'));

                for (let i = 0; i < n; i++) {
                    coords.push(fc[i]);
                    sourceIdMap.push(src);
                    chains.push(fChains[i] || 'A');
                }
                append(plddts, fill(frame.plddts, () => Array(n).fill(50.0)));
                append(positionTypes, fill(frame.position_types, () => Array(n).fill('P')));
                append(positionNames, fill(frame.position_names, () => Array(n).fill('UNK')));
                append(positionAtoms, fill(frame.position_atoms, () => Array(n).fill('')));
                append(positionElements, fill(frame.position_elements, () => Array(n).fill('')));
                append(residueNumbers, fill(frame.residue_numbers,
                    () => Array.from({ length: n }, (_, i) => i + 1)));

                for (const b of (frame.bonds || [])) {
                    bonds.push([b[0] + offset, b[1] + offset]);
                }
                sideRows.push({ table: frame.sidechains || null, offset });
                if (firstPae === undefined) firstPae = frame.pae || null;
                // EACH OBJECT RESOLVES ITS OWN AUTO COLOUR, from its own
                // chains and its own PAE - a monomer rainbows, a complex
                // colours by chain, a predicted model by confidence, exactly
                // as each would on its own. One answer for the whole merge
                // made a dimer beside a monomer look like neither.
                const ownChains = new Set(fChains);
                sourceAutoColors.push(
                    (frame.pae && frame.pae.length) ? 'plddt'
                        : (ownChains.size > 1 ? 'chain' : 'rainbow'));
            }

            if (!coords.length) return null;

            // PAE is a matrix over ONE structure's residues; there is no such
            // thing across two. Kept when a single object is merged so that
            // path stays identical to loading it on its own, dropped otherwise
            // rather than quietly indexed into the wrong rows.
            const pae = (sourceNames.length === 1) ? (firstPae || null) : null;

            let autoColor;
            if (pae && pae.length > 0) autoColor = 'plddt';
            else if (new Set(chains).size > 1) autoColor = 'chain';
            else autoColor = 'rainbow';

            return {
                coords,
                plddts,
                chains,
                position_types: positionTypes,
                position_names: positionNames,
                position_atoms: positionAtoms,
                position_elements: positionElements,
                residue_numbers: residueNumbers,
                pae,
                bonds: bonds.length > 0 ? bonds : null,
                sidechains: this._mergeSidechainTables(sideRows),
                sourceIdMap,
                sourceNames,
                sourceOffsets,
                sourceFrames,
                sourceAutoColors,
                autoColor
            };
        }

        /**
         * The side tables of the merged objects, concatenated.
         *
         * Every index in a table is relative to its own object: `pos` and
         * `frameOf` are positions, `bonds` and `toBackbone` are ROWS of the
         * table itself. Both get their own offset. Without this a merged view
         * would grow side chains on the wrong residues rather than none.
         *
         * @param {Array<{table: Object|null, offset: number}>} parts
         */
        _mergeSidechainTables(parts) {
            const live = parts.filter(p => p.table && p.table.pos && p.table.pos.length);
            if (!live.length) return null;
            if (live.length === 1 && live[0].offset === 0) return live[0].table;

            const pos = []; const frameOf = []; const coef = [];
            const bonds = []; const toBackbone = []; const onBackbone = [];
            const names = []; const elements = [];
            let rowBase = 0;
            for (const { table, offset } of live) {
                const rows = table.pos.length;
                for (let i = 0; i < rows; i++) {
                    pos.push(table.pos[i] + offset);
                    frameOf.push(table.frameOf[i] + offset);
                    onBackbone.push(table.onBackbone ? table.onBackbone[i] : 0);
                    names.push(table.names[i]);
                    elements.push(table.elements[i]);
                }
                for (let i = 0; i < table.coef.length; i++) coef.push(table.coef[i]);
                for (let i = 0; i < table.bonds.length; i++) bonds.push(table.bonds[i] + rowBase);
                for (let i = 0; i < table.toBackbone.length; i++) {
                    toBackbone.push(table.toBackbone[i] + rowBase);
                }
                rowBase += rows;
            }
            return {
                pos: new Int32Array(pos),
                frameOf: new Int32Array(frameOf),
                coef: new Float32Array(coef),
                bonds: new Int32Array(bonds),
                toBackbone: new Int32Array(toBackbone),
                names,
                elements,
                onBackbone: new Uint8Array(onBackbone)
            };
        }

        /**
         * THE OVERLAY BUTTON SAYS WHETHER OVERLAY IS ON.
         *
         * It used to be styled inside the toggle, which was the only thing that
         * could change the state - until showing several objects started
         * putting the overlay down on its way in. The button then stayed lit
         * over a view that was not overlaid, which is worse than no indicator:
         * pressing it again would have turned overlay ON and read as off.
         */
        _syncOverlayButton() {
            if (!this.overlayButton) return;
            const on = !!(this.overlayState && this.overlayState.enabled);
            this.overlayButton.classList.toggle('btn-primary', on);
            this.overlayButton.classList.toggle('btn-secondary', !on);
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

            // THE TWO MERGES ARE EXCLUSIVE - the object merge puts one frame of
            // several objects in the array, this one puts every frame of one.
            // Entering here with the other still on left a coordinate array
            // described by two maps at once: sourceGroups would answer with the
            // frames while every per-object set was still read at merge
            // offsets. The objects are put down first, and the shown set is
            // left alone so leaving overlay can pick them back up.
            if (this.multiState && this.multiState.enabled) {
                const keep = Array.from(this.shownObjects);
                this.setShownObjects([this.currentObjectName], true);
                this._overlaySuspendedShow = keep;
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
            this._syncOverlayButton();

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
            this._syncOverlayButton();

            // Re-enable speed button when exiting overlay mode
            if (this.speedButton) {
                this.speedButton.disabled = false;
                this.speedButton.style.opacity = '1.0';
                this.speedButton.style.cursor = 'pointer';
            }

            // Invalidate segment cache (critical after exiting overlay)
            this._invalidateSegmentCache();

            // ...and pick the objects back up, if entering overlay put them
            // down. Not when the object merge itself is what asked to leave -
            // it is about to load its own array, and re-merging here would have
            // the two calling each other.
            const resume = this._overlaySuspendedShow;
            this._overlaySuspendedShow = null;
            if (resume && resume.length > 1 && !this._leavingOverlayForMerge) {
                this.overlayState.enabled = false;
                this.setShownObjects(resume.filter((n) => this.objectsData[n]), skipRender);
                return true;
            }

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

            this._syncOverlayButton();
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
                this._loadFrameForPlayback(0);
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
                        this._loadFrameForPlayback(nextFrame);
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

            // Load and render current frame - see _loadFrameForPlayback
            this._loadFrameForPlayback(currentFrame);
            // The sink renders when it is recording at its own size (see
            // _makeVideoSink); rendering here as well would draw every frame
            // twice, and on the GPU path at two different sizes, which rebuilds
            // the mesh both times.
            if (this._recSpin) {
                this.viewerState.rotation = multiplyMatrices(
                    rotationMatrixY((2 * Math.PI * this._recSpin.turns * currentFrame)
                        / this._recSpin.n),
                    this._recSpin.R0);
            }
            if (!this._recSink || !this._recSink.rendersItself) this.render();
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
                // ...and hand the frame over. The stream used to be left to
                // sample the canvas on its own clock, which is why every frame
                // had to be held on screen for 50 ms whatever the frame rate
                // asked for; the sink takes the frame that was just rendered.
                if (this._recSink) this._recSink.frame();

                // PACED BY THE FRAME RATE THAT WAS ASKED FOR. A recording is
                // timestamped by the wall clock, so how long each frame is held
                // here IS the frame rate of the file - and this used to hold
                // each one for the viewer's animation speed instead, which has
                // nothing to do with the FPS box. Floored at 60 fps: past that
                // the render cannot keep up and the pacing stops meaning
                // anything.
                const fps2 = (this._recSink && this._recSink.fps) || 30;
                const captureDelay = Math.max(1000 / 60, 1000 / fps2);

                this.recordingFrameSequence = setTimeout(() => {
                    // Advance to next frame
                    this.currentFrame = currentFrame + 1;
                    // Recursively record next frame
                    this.recordFrameSequence();
                }, captureDelay);
            });
        }

        // Toggle recording
        toggleRecording(opts) {
            if (this.isRecording) {
                this.stopRecording();
            } else {
                this.startRecording(opts);
            }
        }

        // Start recording animation
        startRecording(opts) {
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

            // Clean up any recording still standing
            if (this._recSink) {
                try { this._recSink.cancel(); } catch (e) { /* already gone */ }
                this._recSink = null;
            }

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

            // The panel's settings drive this recording too - format, size,
            // frame rate and bitrate all come from captureOpts through the
            // shared sink. It used to be a fourth copy of the MediaRecorder
            // dance, hard-coded to 30 fps and 20 Mbps.
            const vopts = Object.assign(this.captureOpts(), opts || {});
            const fps = Math.max(5, Math.min(60, Number(vopts.fps) || 30));
            // ...AND IT CAN TURN WHILE IT PLAYS, if that is what was asked for.
            // One revolution over the whole trajectory, driven per frame like
            // the other two recorders drive theirs, rather than left to
            // auto-rotate's wall clock - so the file does not depend on how
            // fast this machine happens to render.
            this._recSpin = vopts.spin
                ? { R0: this.viewerState.rotation.map((row) => [...row]),
                    n: Math.max(2, object.frames.length), was: this.autoRotate,
                    turns: Math.max(1, Math.min(10, Number(vopts.rotations) || 1)) }
                : null;
            if (this._recSpin) this.autoRotate = false;

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

            }

            try {
                // A COMPOSITE IS RECORDED AS IT IS. The scatter plot beside the
                // structure is a second canvas drawn into a third; re-rendering
                // that at a larger size would mean re-rendering the scatter
                // too, which is not this renderer's to do. So the size option
                // applies to the plain path and the composite records at the
                // size it composites at.
                this._recSink = this._makeVideoSink(Object.assign({}, vopts, {
                    fps,
                    sourceCanvas: hasScatter ? this.recordingCompositeCanvas : null,
                }));
                if (!this._recSink) throw new Error('no recorder for this format');

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

            // Hand the frames over. finishRecording is the callback rather
            // than a MediaRecorder event, so the GIF path - which has no
            // recorder to fire one - ends the same way.
            const sink = this._recSink;
            this._recSink = null;
            if (sink) sink.finish((blob, ext) => this.finishRecording(blob, ext, sink));
            else this.finishRecording(null, null, null);
        }

        // Finish recording and download file
        finishRecording(blob, ext, sink) {
            this._captureBusy = false;
            // put the view back where the recording found it, and hand rotation
            // back to whoever had it
            if (this._recSpin) {
                this.viewerState.rotation = this._recSpin.R0.map((row) => [...row]);
                this.autoRotate = this._recSpin.was;
                this._recSpin = null;
            }
            if (blob) {
                const frames = (this.recordingEndFrame || 0) + 1;
                this._deliverVideo(blob, ext, 'Frames',
                    `${frames} frames`
                    + (sink ? `, ${sink.width}x${sink.height}${sink.note}` : ''));
            } else {
                this._captureStatus('No video data recorded', true);
                if (this._savePanel) this._pauseForSavePanel();
            }

            // Clean up all recording state
            this.isRecording = false;
            this._recSink = null;
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
            // ...and what was on screen with it. A shown set naming objects
            // that no longer exist would have the next load open into a merge
            // of one, and the merge state itself would outlive its array.
            this.shownObjects = new Set();
            this.multiState.enabled = false;
            this.multiState.sourceIdMap = null;
            this.multiState.sourceNames = null;
            this.multiState.sourceOffsets = null;
            this.multiState.sourceFrames = null;
            this.multiState.stats = null;
            this._sourceGroupsCache = null;
            this._mergedSetCache = null;
            this._mergedLigCache = null;

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
            // in merged indices when several objects are on screen
            const show = this.shownSidechainSet();
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
            // A NUCLEIC TRACE STEPS FURTHER. localFrame's default range is the
            // peptide's, and a base rebuilt through it lands nowhere: the frame
            // fails, the atom is dropped, and the table looks empty. Same range
            // the table was BUILT with, or the coefficients mean something else
            // here than they did there.
            const C0 = window.py2dmolCartoon;
            const nucLo = C0 && C0.NUCLEIC_STEP_MIN;
            const nucHi = C0 && C0.NUCLEIC_STEP_MAX;
            const posTypes = this.positionTypes || [];
            const frameAt = (i) => {
                if (!frames.has(i)) {
                    const nuc = posTypes[i] === 'D' || posTypes[i] === 'R';
                    const ok = nuc
                        ? localFrame(at, n, i, fr, null, nucLo, nucHi)
                        : localFrame(at, n, i, fr, null);
                    frames.set(i, ok ? fr.slice() : null);
                }
                return frames.get(i);
            };

            // EVERY per-position array has to grow together. setCoords feeds
            // each one through _setDataField, which silently replaces an array
            // whose length does not match the coordinate count with a default -
            // it does not warn, and it does not fail. Missing plddts that way
            // filled every position with 50, the low-confidence band, and an
            // AlphaFold model turned entirely red the moment a side chain was
            // shown. The ones here are exactly the ones _setDataField handles;
            // adding another there means adding it here.
            const coords = data.coords.slice();
            const types = (data.position_types || []).slice();
            const chains = (data.chains || []).slice();
            const names = (data.position_names || []).slice();
            const numbers = (data.residue_numbers || []).slice();
            // Only present where a ligand was loaded. Left empty otherwise
            // rather than grown to the coordinate count: _setDataField would
            // take a short array for a missing one and fill in the default,
            // which is the same blank.
            const atomNames = (data.position_atoms || []).slice();
            const atomEls = (data.position_elements || []).slice();
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
                // The table knows this atom's name and element; the arrays are
                // where every other consumer looks for them. Both are dropped
                // from a SAVED table - see trimSidechainTable - so a reloaded
                // session leaves these blank and the side chain colours from
                // sidechainMap.el instead, which is where it always came from.
                if (atomNames.length) atomNames.push((sc.names && sc.names[k]) || '');
                if (atomEls.length) atomEls.push((sc.elements && sc.elements[k]) || '');
                // pLDDT is a per-RESIDUE confidence, so an atom of that residue
                // carries the residue's own value - which also keeps a side
                // chain the same colour as the backbone it grows out of.
                if (plddts) plddts.push(plddts[owner] !== undefined ? plddts[owner] : 50);
                // el: the atom's ELEMENT, carried so a bond can be coloured by
                // what it joins. Nothing else knows it - the side-chain table
                // has it, but by the time a segment is coloured the table row
                // is long gone and only the position index remains.
                map.set(idx, { anchor, cx, cy, cz, owner,
                    el: (sc.elements && sc.elements[k]) || '',
                    // a backbone atom kept on purpose - proline's ring-closing
                    // N. The drawing lifts it onto the ribbon's surface; every
                    // other consumer uses the atom where it was measured.
                    bb: (sc.onBackbone && sc.onBackbone[k]) ? 1 : 0 });
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
                position_atoms: atomNames.length ? atomNames : data.position_atoms,
                position_elements: atomEls.length ? atomEls : data.position_elements,
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
                    data.bonds,
                    data.position_atoms,
                    data.position_elements
                );
            } else {
                console.warn(`[_loadDataIntoRenderer] No data to load: coords=${data?.coords?.length}`);
            }
        }

        setCoords(coords, plddts, chains, positionTypes, hasPAE = false, positionNames, residueNumbers, skipRender = false, bonds = null, positionAtoms = null, positionElements = null) {
            // Invalidate shadow cache when coordinates change (different geometry needs new shadows)
            this._invalidateShadowCache();
            this.lastShadowRotationMatrix = null;

            this.coords = coords;

            // Set bonds from parameter or from object's stored bonds
            if (bonds !== null && bonds !== undefined) {
                // Frame has explicit bonds - use them
                this.bonds = bonds;
                // Store in object for reuse - but NEVER a merged list. Its
                // indices are offsets into an array of several objects, and
                // written onto the current object they outlive the merge:
                // the next plain load reads them back and bonds that object's
                // residues to positions that no longer exist.
                const merged = this.multiState && this.multiState.enabled;
                if (!merged && this.currentObjectName && this.objectsData[this.currentObjectName]) {
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
                this.entropy = this.entropyForDrawn();
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
            // Blank everywhere but a ligand atom, which is the only position
            // that stands for one atom of the file rather than a whole residue.
            this._setDataField('positionAtoms', 'cachedPositionAtoms', positionAtoms, n, (n) => Array(n).fill(''));
            this._setDataField('positionElements', 'cachedPositionElements', positionElements, n, (n) => Array(n).fill(''));

            // Calculate what 'auto' should resolve to
            // Priority: plddt (if PAE present) > chain (if multi-chain) > rainbow
            // In overlay mode, use merged auto color based on all frames
            const uniqueChains = new Set(this.chains);
            if (this.multiState && this.multiState.enabled) {
                // EACH OBJECT KEEPS ITS OWN SCHEME. A monomer rainbows, a
                // complex colours by chain, a predicted model by confidence -
                // the same answer each would get on its own, resolved per
                // source in _mergeObjects and read back through
                // _autoColorFor. What is left here is the fallback for
                // anything that asks without a position, and for it the merge
                // as a whole answers by object.
                // ...and when only ONE object is drawn through the merge -
                // which happens whenever the object on screen is not the one
                // being edited - it is coloured as itself, not as "object 0 of
                // one", which would be a single flat colour.
                const own = this.multiState.sourceAutoColors;
                this.resolvedAutoColor = (own && own.length === 1)
                    ? own[0] : 'object';
            } else if (this.overlayState.enabled && this.overlayState.autoColor) {
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
            // ...keyed by SOURCE AND CHAIN when several objects are merged, so
            // two structures that both have a chain A do not share its colour.
            // Null otherwise, and then the key is the plain id - see
            // chainColorKeyAt.
            {
                // KEYED BY OBJECT NAME once more than one object is loaded, so
                // an object's colours do not move when another is switched on
                // or off. Never for the overlay: it puts every frame of ONE
                // object in the array, and chain A is the same chain A in all
                // of them - keyed per frame it would come out a different
                // colour in each, which the overlay has never looked like.
                const ms = this.multiState;
                const loaded = Object.keys(this.objectsData || {});
                const grp = (ms && ms.enabled) ? this.sourceGroups() : null;
                const nameOf = (i) => {
                    if (grp && ms.sourceNames) {
                        const s = grp[i];
                        if (s >= 0 && s < ms.sourceNames.length) return ms.sourceNames[s];
                    }
                    return this.currentObjectName;
                };
                this._chainColorKeys = (loaded.length > 1)
                    ? this.chains.map((c, i) => nameOf(i) + '|' + (c || 'A'))
                    : null;
            }
            if (this.chains.length > 0) {
                // Every chain of every LOADED object, in load order - see
                // _buildChainIndexMap. Not just the drawn ones, or an object's
                // colours would move as its neighbours came and went.
                this._buildChainIndexMap();
                const sortedUniqueChains = [...this.chainIndexMap.keys()];

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
                        polymerChains.add(this.chainKeyAt(i));
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
            let lastFrame = -1; // the source the walk is currently inside
            const chainIndexGroups = this.sourceGroups();

            for (let i = 0; i < n; i++) {
                const type = this.positionTypes[i];
                const chainId = this.chainKeyAt(i);
                const isLigandOnlyChain = this.ligandOnlyChains.has(chainId);

                // Chain A of the second source is not a continuation of
                // chain A of the first, so the count along it starts again.
                if (chainIndexGroups) {
                    const src = chainIndexGroups[i];
                    if (src !== lastFrame) {
                        for (const key in chainIndices) {
                            chainIndices[key] = 0;
                        }
                        lastFrame = src;
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

            // Pre-calculate rainbow scales.
            // A MERGED VIEW RAMPS EACH SOURCE ON ITS OWN - each frame of a
            // trajectory, or each object, running its own blue-to-red rather
            // than taking a slice of one ramp spread over the lot. Two copies
            // of the same protein should look like two copies of it.
            const rainbowGroups = this.sourceGroups();
            if (rainbowGroups) {
                this.sourceRainbowScales = {};
                for (let i = 0; i < this.positionTypes.length; i++) {
                    const type = this.positionTypes[i];
                    const chainId = this.chainKeyAt(i);
                    const src = rainbowGroups[i];
                    const isLigandOnlyChain = this.ligandOnlyChains.has(chainId);

                    if (type === 'P' || type === 'D' || type === 'R' || (type === 'L' && isLigandOnlyChain)) {
                        if (!this.sourceRainbowScales[src]) {
                            this.sourceRainbowScales[src] = {};
                        }
                        if (!this.sourceRainbowScales[src][chainId]) {
                            this.sourceRainbowScales[src][chainId] = { min: Infinity, max: -Infinity };
                        }
                        const colorIndex = this.perChainIndices[i];
                        const scale = this.sourceRainbowScales[src][chainId];
                        scale.min = Math.min(scale.min, colorIndex);
                        scale.max = Math.max(scale.max, colorIndex);
                    }
                }
                // Keep chainRainbowScales as null in a merged view to avoid confusion
                this.chainRainbowScales = null;
            } else {
                // Global rainbow scales (normal mode)
                this.chainRainbowScales = {};
                for (let i = 0; i < this.positionTypes.length; i++) {
                    const type = this.positionTypes[i];
                    const chainId = this.chainKeyAt(i);
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
                // Nothing joins across sources - see sourceGroups().
                const srcGroups = this.sourceGroups();

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
                        // PER (OBJECT, CHAIN). The first and last polymer of
                        // "chain A" decide whether it closes head to tail; by
                        // bare id that ran from one object's first residue to
                        // another object's last, and the ring it tested for
                        // spanned two structures.
                        const chainId = this.chainKeyAt(i);

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

                                // ...and that both ends came from the same
                                // source - the same frame of a trajectory, or
                                // the same object of a multi-object view.
                                const sameSource = !srcGroups
                                    || srcGroups[i] === srcGroups[i + 1];

                                if (samePolymerType && this.chains[i] === this.chains[i + 1] && sameSource) {
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
                        // Group ligand indices by chain - PER OBJECT, or the
                        // fallback below bonds one structure's ligand atoms to
                        // another's whenever both call the chain A.
                        const chainId = this.chainKeyAt(i);
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
                                        // the BARE id here, like every other
                                        // segment: segInfo.chainId is only ever
                                        // compared between segments that share
                                        // a position, which are in the same
                                        // object by construction, and a key
                                        // among bare ids would read as a
                                        // different chain at every joint.
                                        chainId: this.chains[firstIdx] || 'A',
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

                        // A bond never spans two sources - two frames of a
                        // trajectory, or two objects.
                        if (srcGroups && srcGroups[idx1] !== srcGroups[idx2]) {
                            continue;
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
                const objLigGroups = this.mergedLigandGroups();
                let touchedByGroup = null;
                if (objLigGroups?.size > 0) {
                    const groupOf = new Map();
                    let shared = false;
                    for (const [key, idxs] of objLigGroups.entries()) {
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
                if (objLigGroups?.size > 0) {
                    // Use ligand groups: only compute distances within each group
                    for (const [groupKey, ligandPositionIndices] of objLigGroups.entries()) {
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
                                        // the BARE id, like every other segment
                                        // - the map key carries the object now
                                        chainId: this.chains[idx1] || 'A',
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

                // Add contact segments from object-level contacts.
                // PER OBJECT, EACH IN ITS OWN NUMBERING. A contact is either a
                // pair of position indices, which belong to the object that
                // stored them, or a pair of chain+residue references, which
                // must be looked up among THAT object's positions - both
                // structures have a chain A, and an unwindowed search finds
                // whichever comes first in the merged array.
                for (const cName of this.drawnObjects()) {
                    const object = this.objectsData[cName];
                    const win = this.localRangeOf(cName);
                    if (object && object.contacts && Array.isArray(object.contacts) && object.contacts.length > 0) {
                        for (const contact of object.contacts) {
                            const resolved = this._resolveContactToIndices(contact, n, win);

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

            // WHICH POSITIONS ARE LONE ATOMS - bonded to nothing, so drawn as a
            // ball of their element's van der Waals radius rather than as a
            // segment of anything. The click target and the selection band are
            // sized from that (see projectPosition and radiusAt), so this has
            // to be true of whatever list we ended up with: taken from
            // segmentIndices rather than from the loop that builds them,
            // because the CACHED branch above skips that loop entirely and a
            // set left over from the previous structure sizes the wrong things.
            this._loneAtoms = new Set();
            for (const sg of this.segmentIndices) {
                if (sg && sg.idx1 === sg.idx2) this._loneAtoms.add(sg.idx1);
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
                    // ...and HOW BIG THE THING IS ACTUALLY DRAWN, which is a
                    // different question from how big a click target it wants
                    // and is what anything MARKING it has to measure off.
                    this.screenDrawRadius = new Float32Array(numPositions);
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

            // Inherited plddt, PAE and bonds resolved in the one place the
            // merge reads them from too.
            const resolvedData = this._resolvedFrame(object, frameIndex);
            if (!resolvedData) return;

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

            // Update UI controls (but don't render yet)
            this.updateUIControls();

            // Map entropy to structure if entropy mode is active
            if (this.colorMode === 'entropy' && this.currentObjectName && this.objectsData[this.currentObjectName] && window.MSA) {
                this.entropy = this.entropyForDrawn();
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

        /**
         * WHAT 'auto' MEANS FOR ONE POSITION.
         *
         * With several objects merged it is not one answer: each resolved its
         * own from its own chains and its own PAE when the merge was built, so
         * a monomer beside a dimer rainbows while the dimer colours by chain -
         * which is what each of them looks like on its own, and what was asked
         * for. Without a position to go on, the merge answers by object.
         */
        _autoColorFor(i) {
            const ms = this.multiState;
            if (i !== undefined && ms && ms.enabled && ms.sourceAutoColors) {
                const g = this.sourceGroups();
                const s = g ? g[i] : -1;
                if (s >= 0 && ms.sourceAutoColors[s]) return ms.sourceAutoColors[s];
            }
            return this.resolvedAutoColor || 'rainbow';
        }

        _getEffectiveColorMode(atIndex) {
            const validModes = getAllValidColorModes();

            // Check for object-level color mode first
            if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                const objectColorMode = this.objectsData[this.currentObjectName].colorMode;
                if (objectColorMode && validModes.includes(objectColorMode)) {
                    // If object color mode is 'auto', resolve to calculated mode
                    if (objectColorMode === 'auto') {
                        return this._autoColorFor(atIndex);
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
                return this._autoColorFor(atIndex);
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
        static get SELECTION_BAND() { return selectionBandFor; }

        static get ELEMENT_COLORS() {
            return {
                N: { r: 51, g: 51, b: 255 },      // blue
                O: { r: 255, g: 76, b: 76 },      // red
                S: { r: 229, g: 198, b: 64 },     // gold
                SE: { r: 240, g: 161, b: 54 },    // a warmer gold
                // THE REST IS PYMOL'S TABLE, read off layer1/Color.cpp and
                // converted from its 0..1 floats - so a reader who knows PyMOL
                // already knows these colours. The four above turn out to be
                // PyMOL's too (nitrogen 0.2/0.2/1, oxygen 1/0.3/0.3, sulfur
                // 0.9/0.775/0.25); only selenium differs, and that one is kept
                // as it is - PyMOL's is a flat orange, this is warmer and reads
                // beside the gold sulfur it usually accompanies.
                //
                // The metals are the reason this table grew. A lone ion takes
                // its colour from here (idx1 === idx2, so both `halves` agree
                // and _segmentElementColor returns it) - and with no entry it
                // fell back to the position's own colour, so a zinc came out
                // whatever the ligand palette handed it: orange in one chain,
                // green in the next, which says nothing about what it is.
                H: { r: 230, g: 230, b: 230 },   // 0.9 grey, not white
                P: { r: 255, g: 128, b: 0 },      // orange
                F: { r: 179, g: 255, b: 255 },   // pale cyan, PyMOL's
                CL: { r: 31, g: 240, b: 31 },     // green
                BR: { r: 166, g: 41, b: 41 },
                I: { r: 148, g: 0, b: 148 },
                // group 1 and 2: violet and green, the CPK convention
                NA: { r: 171, g: 92, b: 242 },
                K: { r: 143, g: 64, b: 212 },
                MG: { r: 138, g: 255, b: 0 },
                CA: { r: 61, g: 255, b: 0 },
                // ...and the transition metals, which is what a structure
                // usually has one of
                MN: { r: 156, g: 122, b: 199 },
                FE: { r: 224, g: 102, b: 51 },    // rust
                CO: { r: 240, g: 144, b: 160 },
                NI: { r: 80, g: 208, b: 80 },
                CU: { r: 200, g: 128, b: 51 },    // copper
                ZN: { r: 125, g: 128, b: 176 },   // silver, slightly blue
                MO: { r: 84, g: 181, b: 181 },
                CD: { r: 255, g: 217, b: 143 },
                PT: { r: 208, g: 208, b: 224 },
                AU: { r: 255, g: 209, b: 35 },    // gold, and actually gold
                HG: { r: 184, g: 184, b: 208 },
                // CARBON IS DELIBERATELY ABSENT and must stay absent: a null
                // sends the atom to its residue's own colour, so a coloured
                // side chain stays coloured with only its heteroatoms standing
                // out. Adding C here would repaint every ligand mid-grey.
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
        /**
         * This position's element, whatever kind of position it is.
         *
         * Two sources, because there are two kinds of atom in the array. An
         * appended side-chain atom carries its element in sidechainMap, put
         * there when the table was materialised; a LIGAND atom is a position of
         * the file's own, and its element was read off the file at capture and
         * kept in positionElements. Everything else - an alpha carbon, a C4' -
         * stands for a whole residue rather than an atom and has none.
         */
        elementAt(index) {
            const e = this.sidechainMap && this.sidechainMap.get(index);
            if (e) return (e.el || '').toUpperCase();
            const el = this.positionElements && this.positionElements[index];
            return el ? el.toUpperCase() : '';
        }

        /**
         * Which position owns this atom's element switch. A side-chain atom is
         * switched with its residue, so it answers with the owner; a ligand
         * atom is its own, since a ligand is selected atom by atom.
         */
        _elementOwnerOf(index) {
            const e = this.sidechainMap && this.sidechainMap.get(index);
            return e ? e.owner : index;
        }

        /**
         * Every position whose element could be coloured: the residues with a
         * side chain, plus the ligand atoms that know what they are.
         *
         * Cached against the two things it is built from - the side-chain table
         * and the element array - because it is asked on every selection change
         * and both are replaced wholesale rather than edited.
         */
        elementOwners() {
            const sc = this.sidechains;
            const els = this.positionElements;
            if (this._elOwnersScFor !== sc || this._elOwnersElFor !== els) {
                this._elOwnersScFor = sc;
                this._elOwnersElFor = els;
                const out = new Set(sc && sc.pos ? sc.pos : []);
                const types = this.positionTypes || [];
                if (els) {
                    for (let i = 0; i < els.length; i++) {
                        if (els[i] && types[i] === 'L' && !(this.sidechainMap
                            && this.sidechainMap.has(i))) out.add(i);
                    }
                }
                this._elOwners = out.size ? out : null;
            }
            return this._elOwners;
        }

        _segmentElementHalves(segInfo) {
            const ea = this.elementAt(segInfo.idx1);
            const eb = this.elementAt(segInfo.idx2);
            if (!ea && !eb) return null;
            // ...unless these atoms' elements were switched off. Absent means
            // ON for everything, so a structure nobody has touched keeps them.
            // Asked per END rather than for the bond: a ligand atom answers for
            // itself, so the two ends of a bond can be switched separately, and
            // half of one is still worth drawing.
            // per object, in merged indices - see mergedObjectSet
            const only = this.mergedObjectSet('elements', 'all');
            const on = (i) => !only || only.has(this._elementOwnerOf(i));
            const T = this.constructor.ELEMENT_COLORS;
            const ca = (ea && on(segInfo.idx1)) ? (T[ea] || null) : null;
            const cb = (eb && on(segInfo.idx2)) ? (T[eb] || null) : null;
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
            // per object, keyed by ITS position numbers
            const own = this.ownerOf(e.owner);
            const obj = this.objectsData[own ? own.name : this.currentObjectName];
            const at = own ? own.local : e.owner;
            const hex = obj && obj.sidechainColor && obj.sidechainColor[at];
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
        /**
         * Is this segment part of a side chain rather than the backbone?
         *
         * One endpoint in the side-chain map is enough, which is what keeps the
         * CA-CB bond: CA is a base position and CB an appended one, so the bond
         * that anchors a side chain counts as side chain and the atom it hangs
         * from stays on screen. A contact is not backbone either - it is an
         * annotation between two residues and has nothing to do with the fold.
         */
        _isSidechainSegment(segInfo) {
            if (!segInfo) return false;
            if (segInfo.type === 'C') return true;
            const sc = this.sidechainMap;
            if (!sc || !sc.size) return false;
            return sc.has(segInfo.idx1) || sc.has(segInfo.idx2);
        }

        /**
         * EVERY RESIDUE WITHIN `cutoff` ANGSTROM OF THIS ONE, atom to atom.
         *
         * The same question PyMOL answers with `byres (all within 5 of sele)`,
         * and it has to be asked of ATOMS: a 5 A neighbourhood measured between
         * trace points is not a contact shell, it is a list of residues whose
         * CAs happen to be close, and it misses the side chain reaching past
         * them - which is the whole reason anyone asks.
         *
         * The atoms exist whether or not they are DRAWN. A side chain is a
         * table of coefficients in the residue's own frame (see
         * _materialiseSidechains); this rebuilds them for the test and throws
         * them away, so a neighbourhood is the same before and after anyone
         * turns side chains on.
         *
         * Two passes, because rebuilding every side chain in a 300,000-residue
         * assembly to answer a question about twelve of them is not a search,
         * it is a rebuild. The first bins TRACE points and keeps anything whose
         * trace is within cutoff + 2 x SIDECHAIN_REACH; the second rebuilds
         * only those and measures exactly.
         *
         * The seed comes back with the answer, as PyMOL's byres does.
         *
         * `opts.sidechainsOnly` measures SIDE CHAIN TO SIDE CHAIN, with the
         * trace atom left out of both ends - the CA of a protein, the C4' of a
         * nucleotide. A backbone runs past everything it folds against, so an
         * any-atom shell around a binding-site residue is half main chain; this
         * asks the other question, which is which residues have their SIDE
         * CHAINS near each other. A residue with no side-chain atoms at all
         * (glycine, or anything in a backbone-only model) is not in the answer,
         * because it has nothing to measure.
         *
         * A LIGAND KEEPS EVERY ATOM in that mode. It has no backbone to leave
         * out - each of its heavy atoms is a position of its own - so what an
         * interaction with a ligand means is any of those against a side chain
         * or against another ligand.
         */
        residuesWithin(seed, cutoff, opts) {
            const scOnly = !!(opts && opts.sidechainsOnly);
            const out = new Set(seed || []);
            const co = this.coords;
            const n = co ? co.length : 0;
            const cut = Number(cutoff);
            if (!n || !out.size || !isFinite(cut) || cut <= 0) return out;
            const xyz = (i) => {
                const c = co[i];
                if (!c) return null;
                return Array.isArray(c) ? c : [c.x, c.y, c.z];
            };
            // ---- pass 1: trace points, on a grid ----------------------------
            const REACH = SIDECHAIN_REACH_A;
            const coarse = cut + 2 * REACH;
            const cell = Math.max(coarse, 1e-3);
            const key = (x, y, z) => x + ',' + y + ',' + z;
            const cellOf = (p) => [Math.floor(p[0] / cell), Math.floor(p[1] / cell),
                Math.floor(p[2] / cell)];
            // KEPT BETWEEN CALLS. Binning every position is the whole cost on a
            // large assembly - 313,236 of them on 3J3Q, 40 ms of a 48 ms search
            // - and growing a shell means asking again and again against the
            // same coordinates. Keyed by the array's identity and the cell
            // size: viewer-mol only ever ASSIGNS coords, so an unchanged
            // pointer is an unchanged structure.
            let g = this._nearGrid;
            if (!g || g.src !== co || g.cell !== cell || g.n !== n) {
                const bins0 = new Map();
                for (let i = 0; i < n; i++) {
                    const p = xyz(i);
                    if (!p) continue;
                    const c = cellOf(p);
                    const k = key(c[0], c[1], c[2]);
                    let arr = bins0.get(k);
                    if (!arr) { arr = []; bins0.set(k, arr); }
                    arr.push(i);
                }
                g = { src: co, cell, n, bins: bins0 };
                this._nearGrid = g;
            }
            const bins = g.bins;
            const near = new Set();
            const coarse2 = coarse * coarse;
            for (const i of out) {
                const p = xyz(i);
                if (!p) continue;
                const c = cellOf(p);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            const arr = bins.get(key(c[0] + dx, c[1] + dy, c[2] + dz));
                            if (!arr) continue;
                            for (const j of arr) {
                                if (out.has(j)) continue;
                                const q = xyz(j);
                                if (!q) continue;
                                const ddx = p[0] - q[0]; const ddy = p[1] - q[1];
                                const ddz = p[2] - q[2];
                                if (ddx * ddx + ddy * ddy + ddz * ddz <= coarse2) near.add(j);
                            }
                        }
                    }
                }
            }
            if (!near.size) return out;
            // ---- pass 2: every atom of the seed against every atom of those --
            const atomsFor = this._atomsOfResidues(new Set([...out, ...near]));
            const cut2 = cut * cut;
            // index 0 of every list is the trace point itself, so leaving the
            // backbone out is a slice rather than a second pass over the table.
            //
            // A LIGAND IS ALL SIDE CHAIN. Its atoms are positions in their own
            // right - no trace point, no backbone - so slicing one off would
            // throw away a real atom, and a single-atom ligand would drop out
            // of the search altogether. An interaction with a ligand is any of
            // its heavy atoms against a side chain or another ligand, which is
            // what this leaves.
            const ptypes = this.positionTypes || [];
            const atomsOf = (i) => {
                const list = atomsFor.get(i);
                if (!list) return null;
                if (!scOnly || ptypes[i] === 'L') return list;
                return list.length > 1 ? list.slice(1) : null;
            };
            const seedAtoms = [];
            for (const i of out) {
                const list = atomsOf(i);
                if (list) for (const p of list) seedAtoms.push(p);
            }
            if (!seedAtoms.length) return out;
            for (const j of near) {
                const list = atomsOf(j);
                if (!list) continue;
                let hit = false;
                for (const q of list) {
                    for (const p of seedAtoms) {
                        const dx = p[0] - q[0]; const dy = p[1] - q[1]; const dz = p[2] - q[2];
                        if (dx * dx + dy * dy + dz * dz <= cut2) { hit = true; break; }
                    }
                    if (hit) break;
                }
                if (hit) out.add(j);
            }
            // A LIGAND COMES BACK WHOLE. Each of its heavy atoms is a position
            // of its own, so a side chain reaching one corner of a benzamidine
            // would otherwise select that corner - a single atom floating in
            // the middle of a molecule nobody asked to take apart. The same
            // expansion a click on one of its atoms gets.
            const groups = this.mergedLigandGroups();
            if (groups && groups.size && typeof expandLigandSelection === 'function') {
                for (const i of expandLigandSelection(out, groups)) out.add(i);
            }
            return out;
        }

        /**
         * Every atom of each of these residues, in world space: the position
         * itself, plus its side-chain table rows rebuilt through the frame they
         * were measured in - drawn or not. Keyed by residue.
         */
        _atomsOfResidues(want) {
            const co = this.coords;
            const out = new Map();
            if (!co || !want || !want.size) return out;
            const xyz = (i) => {
                const c = co[i];
                if (!c) return null;
                return Array.isArray(c) ? c : [c.x, c.y, c.z];
            };
            for (const i of want) {
                const p = xyz(i);
                if (p) out.set(i, [p]);
            }
            const sc = this.sidechains;
            const C = (typeof window !== 'undefined') ? window.py2dmolCartoon : null;
            const localFrame = C && C.localFrame;
            if (!sc || !sc.pos || !localFrame) return out;
            const n = co.length;
            const at = (i) => {
                const p = xyz(i);
                return p ? { x: p[0], y: p[1], z: p[2] } : { x: 0, y: 0, z: 0 };
            };
            const types = this.positionTypes || [];
            const fr = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            const frames = new Map();
            const frameAt = (i) => {
                if (!frames.has(i)) {
                    const nuc = types[i] === 'D' || types[i] === 'R';
                    const ok = nuc
                        ? localFrame(at, n, i, fr, null, C.NUCLEIC_STEP_MIN, C.NUCLEIC_STEP_MAX)
                        : localFrame(at, n, i, fr, null);
                    frames.set(i, ok ? fr.slice() : null);
                }
                return frames.get(i);
            };
            for (let k = 0; k < sc.pos.length; k++) {
                const owner = sc.pos[k];
                if (!out.has(owner)) continue;
                const anchor = sc.frameOf[k];
                const f = anchor >= 0 ? frameAt(anchor) : null;
                if (anchor >= 0 && !f) continue;
                const o = at(anchor >= 0 ? anchor : owner);
                const cx = sc.coef[k * 3]; const cy = sc.coef[k * 3 + 1];
                const cz = sc.coef[k * 3 + 2];
                out.get(owner).push(f ? [
                    o.x + f[0] * cx + f[3] * cy + f[6] * cz,
                    o.y + f[1] * cx + f[4] * cy + f[7] * cz,
                    o.z + f[2] * cx + f[5] * cy + f[8] * cz,
                ] : [o.x + cx, o.y + cy, o.z + cz]);
            }
            return out;
        }

        /**
         * The positions to FRAME a set on: every atom of the things it names.
         *
         * A residue is ONE position here - the trace point - so orienting on a
         * single residue framed a single point and fell back to the 8 Angstrom
         * floor, pointing the camera at a CA with the side chain the user was
         * looking at hanging off to one side. Its atoms exist as positions
         * whenever the side chain is drawn (they are appended: see
         * _materialiseSidechains), and they are what the residue actually
         * occupies, so the framing takes them.
         *
         * A ligand is the same argument one level up: its atoms are separate
         * positions and picking one means the ligand, so the rest of the group
         * comes too.
         *
         * Framing only. The SELECTION is untouched - what is selected is what
         * the user picked, and the panel, Copy and Delete all read that.
         */
        framingPositions(set) {
            if (!set || !set.size) return set;
            const out = new Set(set);
            const sc = this.sidechainMap;
            if (sc && sc.size) {
                for (const [idx, e] of sc) {
                    if (e && out.has(e.owner)) out.add(idx);
                }
            }
            const groups = this.mergedLigandGroups();
            if (groups && groups.size && typeof expandLigandSelection === 'function') {
                for (const i of expandLigandSelection(out, groups)) out.add(i);
            }
            // ...and nothing that is not on screen: a hidden atom is not part
            // of what the view is being framed on
            const vis = this.visiblePositions;
            if (vis) for (const i of out) if (!vis.has(i)) out.delete(i);
            return out.size ? out : set;
        }

        /**
         * WHICH RESIDUES ARE DRAWN WITHOUT THEIR BACKBONE.
         *
         * Hiding a residue takes its side chain with it; this takes the ribbon
         * (or the tube) and LEAVES the side chain, which is how you look at a
         * binding site without the fold in front of it. Per residue and per
         * object, beside `sidechains` and `bases` and for the same reason -
         * position indices only mean anything against the object they were set
         * on. Empty or missing means the whole backbone is drawn.
         */
        backboneHiddenSet() {
            const set = this.mergedObjectSet('hiddenBackbone', 'none');
            return (set instanceof Set && set.size) ? set : null;
        }

        /** Is this position's backbone hidden? */
        backboneHiddenAt(i) {
            const set = this.backboneHiddenSet();
            return !!set && set.has(i);
        }

        /**
         * Hide or show the backbone of these positions. Returns false when
         * nothing changed, so the caller can skip the redraw.
         */
        setBackboneHiddenFor(positions, hidden) {
            let changed = false;
            // A selection can reach two objects at once in a merged view, and
            // each keeps its own set in its own numbering - see writeGroups.
            for (const g of this.writeGroups(positions)) {
                const cur = g.object.hiddenBackbone instanceof Set
                    ? new Set(g.object.hiddenBackbone) : new Set();
                let mine = false;
                for (const i of g.positions) {
                    if (hidden ? !cur.has(i) : cur.has(i)) mine = true;
                    if (hidden) cur.add(i); else cur.delete(i);
                }
                if (!mine) continue;
                changed = true;
                // A NEW SET EVERY TIME, like the visibility mask: both mesh
                // signatures compare it by identity, so editing one in place
                // would leave the GPU redrawing the cached backbone.
                g.object.hiddenBackbone = cur.size ? cur : null;
            }
            return changed;
        }

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
         * Is there anything here whose elements could be coloured? A residue
         * with a side chain, or a ligand atom that knows what element it is -
         * see elementOwners. Everything else is a position standing for a whole
         * residue, which has no single element to colour by.
         */
        hasElementsFor(positions) {
            const owners = this.elementOwners();
            if (!owners) return false;
            for (const i of positions) if (owners.has(i)) return true;
            return false;
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
            const owners = this.elementOwners();
            if (!owners) return false;
            let changed = false;
            for (const g of this.writeGroups(positions)) {
                const { off, end } = this.localRangeOf(g.name);
                let cur;
                if (g.object.elements instanceof Set) {
                    cur = new Set(g.object.elements);
                } else {
                    // this object's own element owners, in its own numbering
                    cur = new Set();
                    for (const o of owners) {
                        if (o >= off && o < end) cur.add(o - off);
                    }
                }
                let mine = false;
                for (const i of g.positions) {
                    if (!owners.has(i + off)) continue;
                    if (on ? !cur.has(i) : cur.has(i)) mine = true;
                    if (on) cur.add(i); else cur.delete(i);
                }
                if (!mine) continue;
                changed = true;
                g.object.elements = cur;
            }
            if (!changed) return false;
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
        /**
         * WHICH SECONDARY STRUCTURE THESE POSITIONS ARE FORCED TO.
         *
         * Three answers, because a selection is a set: one letter if every
         * protein position in it is forced to that letter, 'none' if not one of
         * them is forced - the state a structure nobody has touched is in - and
         * '' if they disagree, which is a state of its own and not a letter.
         *
         * Only 'P' positions count. A nucleotide is never assigned a letter and
         * cannot be forced to one, so a selection of a duplex plus one helix
         * would otherwise read as mixed for a reason the user cannot act on.
         */
        forcedSseFor(positions) {
            const single = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const t = this.positionTypes || [];
            let seen = null;
            let n = 0;
            for (const i of positions) {
                if (t[i] !== 'P') continue;
                n++;
                // sse is a map keyed by position, per object, so a merged
                // index has to be resolved back to the object that wrote it
                const o = this.ownerOf(i);
                const ov = (o ? this.objectsData[o.name]?.sse : single && single.sse) || null;
                const at = o ? o.local : i;
                const letter = (ov && ov[at]) || 'none';
                if (seen === null) seen = letter;
                else if (seen !== letter) return '';
            }
            return n ? seen : 'none';
        }

        /**
         * What the ASSIGNMENT makes of these positions, where the drawing has
         * already worked it out. Read off the cache the cartoon pass fills, and
         * '' when there is none: running the assignment from here would put a
         * whole SS pipeline behind a panel refresh, and on a capsid that is a
         * second of it for a word in a menu.
         */
        assignedSseFor(positions) {
            const n = this.coords ? this.coords.length : 0;
            const sec = (this._cartoonSec && this._cartoonSec.length === n)
                ? this._cartoonSec
                : ((this._ssColorSec && this._ssColorSec.length === n)
                    ? this._ssColorSec : null);
            if (!sec) return '';
            const t = this.positionTypes || [];
            let seen = null;
            for (const i of positions) {
                if (t[i] !== 'P') continue;
                const letter = sec[i] || 'C';
                if (seen === null) seen = letter;
                else if (seen !== letter) return '';
            }
            return seen || '';
        }

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
            const t = this.positionTypes || [];
            let changed = false;
            for (const g of this.writeGroups(positions)) {
                // MATERIALISED PER OBJECT. The set has to start full or hiding
                // three bases would hide all but three - and "full" is that
                // object's own nucleotides, not every nucleotide on screen.
                const { off, end } = this.localRangeOf(g.name);
                const isBase = (local) => {
                    const at = local + off;
                    return t[at] === 'D' || t[at] === 'R';
                };
                let cur;
                if (g.object.bases instanceof Set) {
                    cur = new Set(g.object.bases);
                } else {
                    cur = new Set();
                    // end is Infinity for a lone object - see localRangeOf
                    const stop = Math.min(end, t.length);
                    for (let i = off; i < stop; i++) {
                        if (t[i] === 'D' || t[i] === 'R') cur.add(i - off);
                    }
                }
                let mine = false;
                for (const i of g.positions) {
                    if (!isBase(i)) continue;
                    if (on ? !cur.has(i) : cur.has(i)) mine = true;
                    if (on) cur.add(i); else cur.delete(i);
                }
                if (!mine) continue;
                changed = true;
                g.object.bases = cur;
            }
            return changed;
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
            if (!this._exportPxScale) this._paintHoverReadout(ctx, pxScale);
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
            // NO setTransform HERE. The app has already scaled this context by
            // the device ratio, and everything else on this canvas - the halo,
            // the structure itself - is drawn through it in DISPLAY pixels.
            // Resetting the transform threw that scale away: on a 2x screen the
            // text came out half size and "the bottom" landed in the middle of
            // the canvas, which is exactly how it was reported. There is no
            // pxScale here because this never runs in an export.
            ctx.save();
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
            // A SELECTED RESIDUE INCLUDES ITS SIDE CHAIN, wherever one is drawn.
            // Picking a residue selects the residue - one position - and its
            // atoms are appended positions of their own, so the band stopped at
            // the backbone and the side chain the user was looking at was the
            // one part of it left unmarked. Marked here rather than added to
            // the SELECTION, which stays what was picked: Copy, Delete and the
            // panel all read that, and they mean the residue.
            const scOwned = this.sidechainMap;
            let marks = sel;
            if (scOwned && scOwned.size) {
                let extra = null;
                for (const [idx0, e] of scOwned) {
                    if (!e || !sel.has(e.owner) || sel.has(idx0)) continue;
                    if (!extra) extra = new Set(sel);
                    extra.add(idx0);
                }
                if (extra) marks = extra;
            }
            const drawn = (i) => i >= 0 && i < sv.length && sv[i] === fid && marks.has(i);
            const idx = Array.from(marks).filter(drawn);
            if (!idx.length) return;
            idx.sort((a, b) => a - b);
            const chains = this.chains;
            const sc = this.sidechainMap;

            // THE BAND FOLLOWS WHAT IS ACTUALLY CONNECTED.
            //
            // A backbone is a linear chain, so consecutive residues of the same
            // chain join up. AN ATOM IS NOT: a side chain is a tree - a leucine
            // branches at CG - and a ligand is whatever the chemistry says,
            // with its atoms sitting in the array in the order the file listed
            // them. Index order says nothing about which of those are bonded.
            // Joining them by index draws a bond from CD1 to CD2 that does not
            // exist, runs a band from the last atom of one side chain to the
            // first of the next straight through empty space, and - reported
            // on 3PTB - joins a calcium ion to the first carbon of a
            // benzamidine that is 20 A away, because they are neighbours in the
            // array. So every atom position is joined along its BONDS instead,
            // the same connectivity the sticks themselves are drawn from.
            //
            // Type 'L' is the test rather than the side-chain map: an appended
            // side-chain atom and a ligand atom of the file's own are both
            // atoms, and only one of the two is in that map.
            const edges = [];
            const touched = new Set();
            const addEdge = (a, b) => {
                edges.push(a, b);
                touched.add(a); touched.add(b);
            };
            const types = this.positionTypes || [];
            const isAtom = (i) => types[i] === 'L' || !!(sc && sc.has(i));
            for (let k = 1; k < idx.length; k++) {
                const a = idx[k - 1]; const b = idx[k];
                if (b !== a + 1) continue;                     // a gap
                if (isAtom(a) || isAtom(b)) continue;          // bonds decide these
                // ...and never across the join between two objects, which
                // consecutive indices with the same chain id would otherwise
                // be: see chainKeyAt.
                if (chains && this.chainKeyAt(a) !== this.chainKeyAt(b)) continue;
                addEdge(a, b);
            }
            if (this.bonds) {
                for (const [a, b] of this.bonds) {
                    if (!drawn(a) || !drawn(b)) continue;
                    if (!isAtom(a) && !isAtom(b)) continue;
                    addEdge(a, b);
                }
            }

            // A SELECTED CONTACT IS MARKED ALONG ITS LINE. Selecting a contact
            // selects the pair it joins, and marking two residues at opposite
            // ends of a structure says nothing about which contact was meant -
            // there may be several between the same chains. The band runs along
            // the contact itself, from the same edge list, so it composites in
            // one stroke with the rest and cannot double-darken where it meets
            // a marked residue.
            const segsC = this.segmentIndices;
            if (segsC) {
                for (let i = 0; i < segsC.length; i++) {
                    const sg = segsC[i];
                    if (!sg || sg.type !== 'C') continue;
                    const a = sg.contactIdx1; const b = sg.contactIdx2;
                    if (a === undefined || b === undefined) continue;
                    if (!sel.has(a) || !sel.has(b)) continue;
                    if (!drawn(a) || !drawn(b)) continue;
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
            // EACH PART GETS THE BAND ITS OWN THICKNESS ASKS FOR. One width for
            // the whole selection is the max over it, so a side chain - a stick
            // a third the backbone's width - was marked with the backbone's
            // band and disappeared inside it. The width is a function of the
            // radius, so the edges are bucketed by the width they want and each
            // bucket is stroked once.
            // THE PICKING RADIUS IS NOT THE DRAWN ONE, anywhere. screenRadius is
            // a residue-sized CLICK TARGET - the same 5.29 px for a CA as the
            // 5.33 for the CD1 hanging off it - and banding at face value made
            // the mark heavier than the thing it marks. The side chains were
            // the loud case, because their sticks really are half the width;
            // the backbone was over-banded by the same rule and looked normal
            // only because it had always looked like that.
            //
            // So one fraction, everywhere: the band is measured off half the
            // picking radius, which puts it around the ribbon rather than over
            // it and takes the default view from 24.9 px to 12.5.
            // ONE QUESTION, ASKED ONCE: how big is this position drawn. The
            // projection answers it (screenDrawRadius) - exactly for a lone
            // atom, and by the old half-the-click-target estimate for a ribbon,
            // which is what this fraction always meant. Asking it here instead
            // needs a branch per kind of thing, and a metal was the first kind
            // the estimate was wrong about rather than the only one.
            const sdr = this.screenDrawRadius;
            const radiusAt = (i) => (sdr && sdr[i])
                || ((sr[i] || 2) * SELECTION_HALO_RADIUS_FRAC);
            // ...AND WHAT AN ORDINARY RESIDUE MEASURES AT THIS VIEW, which is
            // what sets how far the mark sticks out. The two are the same
            // number for a residue and differ for anything drawn at a size of
            // its own: a zinc's ball is 6.89 px where the residue radius is
            // 1.86, so a margin taken from the ball's own radius made the ring
            // around a metal three and a half times the ring around the chain
            // next to it - the same 1.3, meaning something different because
            // the radius under it meant something different.
            const refAt = (i) => (sr[i] || 2) * SELECTION_HALO_RADIUS_FRAC;
            const bandFor = (r, ref) => selectionBandFor(r, pxScale, ref);
            // ...QUANTISED, so a hundred residues do not become a hundred
            // strokes: half a pixel is finer than the eye reads on a band.
            const bucketOf = (r, ref) => Math.round(bandFor(r, ref) * 2) / 2;
            const groups = new Map();
            const addTo = (key, fn) => {
                let g = groups.get(key);
                if (!g) { g = []; groups.set(key, g); }
                g.push(fn);
            };
            // an edge takes the THINNER of its two ends: the band has to sit
            // inside the thicker one rather than swallow the thinner
            for (let k = 0; k + 1 < edges.length; k += 2) {
                const a = edges[k]; const b = edges[k + 1];
                const r = Math.min(radiusAt(a), radiusAt(b));
                addTo(bucketOf(r, Math.min(refAt(a), refAt(b))), (c) => {
                    c.moveTo(sx[a], sy[a]); c.lineTo(sx[b], sy[b]);
                });
            }
            for (const i of idx) {
                if (touched.has(i)) continue;
                const r = radiusAt(i);
                // a hair of length, so a round cap has something to cap
                addTo(bucketOf(r, refAt(i)), (c) => {
                    c.moveTo(sx[i], sy[i]); c.lineTo(sx[i] + 0.01, sy[i]);
                });
            }
            // ONE COMPOSITE, HOWEVER MANY WIDTHS. A translucent colour darkens
            // wherever two strokes overlap - a backbone band and the side-chain
            // band leaving it would show a blot at every CA - so the widths are
            // drawn OPAQUE into a scratch layer and that layer is composited
            // once. Same flat wash as the single stroke this replaces, without
            // being held to a single width.
            const one = groups.size <= 1;
            let lctx = ctx;
            let layer = null;
            if (!one && typeof document !== 'undefined' && ctx.canvas) {
                layer = this._haloLayer
                    || (this._haloLayer = document.createElement('canvas'));
                if (layer.width !== ctx.canvas.width || layer.height !== ctx.canvas.height) {
                    layer.width = ctx.canvas.width; layer.height = ctx.canvas.height;
                }
                lctx = layer.getContext('2d');
                lctx.setTransform(1, 0, 0, 1, 0, 0);
                lctx.clearRect(0, 0, layer.width, layer.height);
                if (ctx.getTransform) {
                    const m = ctx.getTransform();
                    lctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
                }
                lctx.strokeStyle = SELECTION_HALO_SOLID_CSS;
                lctx.lineJoin = 'round';
                lctx.lineCap = 'round';
            }
            for (const [width, fns] of groups) {
                lctx.lineWidth = width;
                lctx.beginPath();
                for (const fn of fns) fn(lctx);
                lctx.stroke();
            }
            if (layer) {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = SELECTION_HALO_ALPHA;
                ctx.drawImage(layer, 0, 0);
            }
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
                // Resolve 'auto' to actual mode - and to THIS POSITION'S, which
                // in a merged view is its own object's answer
                effectiveColorMode = this._getEffectiveColorMode(atomIndex);
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
            } else if (effectiveColorMode === 'object') {
                // One colour per object, from the chain palette, chosen by LOAD
                // ORDER - not by position in the merge, which changes whenever
                // something is switched on or off and would repaint the objects
                // that stayed. A ligand is grey everywhere else; here it
                // belongs to an object like everything else does, and greying
                // it would hide which.
                const owner = this.ownerOf(atomIndex);
                const loaded = Object.keys(this.objectsData || {});
                const at = Math.max(0, loaded.indexOf(
                    owner ? owner.name : this.currentObjectName));
                const colorArray = this.colorblindMode ? chainColorsColorblind : chainColors;
                color = hexToRgb(colorArray[at % colorArray.length]);
            } else if (effectiveColorMode === 'chain') {
                // by SOURCE and chain: both objects have a chain A
                const chainId = this.chainKeyAt(atomIndex);
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
                    const chainId = this.chainKeyAt(atomIndex);

                    // In overlay mode, use per-frame scales; otherwise use global scales
                    let scale = null;
                    const rgroups = this.sourceGroups();
                    if (rgroups && this.sourceRainbowScales) {
                        const src = rgroups[atomIndex];
                        scale = this.sourceRainbowScales[src] && this.sourceRainbowScales[src][chainId];
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
        getChainColorForChainId(chainId, objectName) {
            if (!this.chainIndexMap || !chainId) {
                return DEFAULT_GREY; // Default lightened gray
            }
            // The strip belongs to ONE object - the current one unless told
            // otherwise - so a bare chain id is that object's chain id, and in
            // a merged view it has to be keyed with the object to find the
            // colour that chain is actually drawn in.
            const key = this.chainKeyFor(chainId, objectName);
            const chainIndex = (this.chainIndexMap.has(key)
                ? this.chainIndexMap.get(key)
                : this.chainIndexMap.get(chainId)) || 0;
            const colorArray = this.colorblindMode ? chainColorsColorblind : chainColors;
            const hex = colorArray[chainIndex % colorArray.length];
            return hexToRgb(hex);
        }

        // Calculate segment colors (chain or rainbow)
        // Uses getAtomColor() as single source of truth for all color logic
        _calculateSegmentColors(effectiveColorMode = null) {
            const m = this.segmentIndices.length;
            if (m === 0) return [];

            // A merged view colours per source, so each atom resolves its own
            // mode; otherwise the effective mode is cached rather than asked
            // again for every position.
            let usePerAtomColorMode = !!this.sourceGroups();
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
        _resolveContactToIndices(contact, maxIndex = null, window = null) {
            if (!contact || !Array.isArray(contact)) return null;
            // The slice of the array belonging to the object that stored this
            // contact - the whole array when nothing is merged.
            const off = window ? window.off : 0;
            const stop = window ? window.end : Infinity;

            // Extract weight and color
            let weight = 1.0;
            let color = null;

            if (contact.length >= 3 && typeof contact[0] === 'number' && typeof contact[1] === 'number') {
                // Direct indices format: [idx1, idx2, weight, color?]
                weight = typeof contact[2] === 'number' ? contact[2] : 1.0;
                if (contact.length >= 4 && typeof contact[3] === 'object' && contact[3] !== null) {
                    color = contact[3]; // Color object {r, g, b}
                }
                const i1 = contact[0] + off;
                const i2 = contact[1] + off;
                if (i1 >= stop || i2 >= stop) return null;
                return { idx1: i1, idx2: i2, weight: weight, color: color };
            } else if (contact.length >= 5 && typeof contact[0] === 'string') {
                // Chain + residue format: [chain1, res1, chain2, res2, weight, color?]
                const [chain1, res1, chain2, res2] = contact;
                weight = typeof contact[4] === 'number' ? contact[4] : 1.0;
                if (contact.length >= 6 && typeof contact[5] === 'object' && contact[5] !== null) {
                    color = contact[5]; // Color object {r, g, b}
                }

                // Find position indices matching chain+residue
                // Only search in original structure positions (before intermediate positions were added)
                const searchLimit = Math.min(
                    maxIndex !== null ? maxIndex : this.chains.length, stop);
                let idx1 = -1, idx2 = -1;

                // Debug: log available chains and residue ranges for first failed contact
                let debugLogged = false;

                for (let i = off; i < searchLimit; i++) {
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
            // ...AND THE BOND THAT JOINS IT TO THE BACKBONE IS PART OF IT.
            //
            // This asked for type 'L' as well, and the CA-CB bond is not: it
            // runs [owner, CB], the owner is a protein position, and the
            // segment builder takes the most restrictive of the two types - so
            // that one link came out 'P' and took the BACKBONE's full width
            // while every other bond in the same side chain took 0.5. Half the
            // side chain drawn at twice the weight of the rest of it, and
            // most visible in tube mode where the backbone is thickest.
            //
            // Asked through _isSidechainSegment, which is the same question
            // the drawing and the visibility mask already ask, so the three
            // cannot drift apart again. Contacts never reach here - type 'C'
            // returns above.
            if (this._isSidechainSegment && this._isSidechainSegment(segInfo)) {
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


        // Update cached canvas dimensions (call on resize)
        _updateCanvasDimensions() {
            this.displayWidth = parseInt(this.canvas.style.width) || this.canvas.width;
            this.displayHeight = parseInt(this.canvas.style.height) || this.canvas.height;
            // EVERY NUMBER IN THE CAPTURE PANEL IS DERIVED FROM THIS. The image
            // size, the recording sizes, the whole Video menu - all computed
            // when the panel was built, and all wrong the moment the window is
            // dragged wider. Rebuilt rather than patched: the panel is a dozen
            // elements, its state lives in _captureOpts, and there is no
            // half-edited field to lose.
            if (this._savePanel && this._saveAnchor && !this._captureBusy) {
                this._rebuildSavePanel(true);      // every size in it just changed
            }
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
            if (this.useGPU !== true) return false;
            // DRAW IS A 2D EFFECT, so the frame has to be a 2D one.
            //
            // The build-up is three layers in an illustrator's order - graphite
            // under-drawing, colour wash, ink line - revealed along the chain by
            // a pen whose pace follows the local curvature, and all of it is
            // canvas compositing in viewer-cartoon.js. The GPU knows nothing
            // about it, so with the GPU on it simply drew the finished picture
            // and the animation ran invisibly: measured 33% of the way through a
            // build-up, the canvas held 99.5% of the finished ink.
            //
            // The reveal itself would port (a pen position against each
            // instance's residue is one uniform and one comparison); the
            // watercolour is the work - off-register washes, bleed, grain. Until
            // someone does that, Draw takes the 2D path and hands it back when
            // it is switched off.
            if (this.drawMode) return false;
            const G = window.py2dmolCartoonGPU;
            if (!G) return false;
            if (this.style === 'cartoon') {
                if (typeof G.render !== 'function' || !window.py2dmolCartoon) return false;
            } else if (typeof G.renderTube !== 'function') return false;
            // A 2D CANVAS IS A 2D CANVAS, the screen's or an export's. It used
            // to insist on the screen one, which is why Capture was always the
            // 2D drawing however the viewer was drawn: saveImage renders into a
            // canvas of its own at k times the size, and that is a display of
            // k times the density as far as this stage is concerned. An SVG
            // context is still refused - there is no vector to hand back from a
            // raster - and so is a buffer the driver will not make that big,
            // which the GPU module checks for itself.
            if (!ctx || !ctx.canvas || !ctx.drawImage || ctx.getSerializedSvg) return false;
            return true;
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
            // anything: an SVG export wants the vector the 2D pass produces,
            // and there is none in a raster. A PNG export is a canvas like any
            // other and the GPU draws it - see _gpuWillTake.
            if (!ctx || !ctx.canvas || !ctx.drawImage || ctx.getSerializedSvg) return false;

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
            // ...and the backbone switch, which changes WHICH segments are in
            // the list. Left out of the key the cached order outlived the
            // toggle and the backbone stayed on screen until something else
            // invalidated it.
            const noBB = this.backboneHiddenSet();
            let order = this._gpuTubeOrder;
            let cnt;
            if (order && this._gpuTubeVisSrc === vis && this._gpuTubeSegSrc === segments
                    && this._gpuTubeSegN === n && this._gpuTubeNoBB === noBB) {
                cnt = this._gpuTubeCount;
            } else {
                if (!order || order.length < n) order = this._gpuTubeOrder = new Int32Array(n);
                cnt = 0;
                for (let i = 0; i < n; i++) {
                    const s = segments[i];
                    let ok;
                    if (noBB && !this._isSidechainSegment(s)
                            && noBB.has(s.idx1) && noBB.has(s.idx2)) {
                        ok = false;
                    } else if (!vis) {
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
                this._gpuTubeNoBB = noBB;
                this._gpuTubeSegSrc = segments;
                this._gpuTubeSegN = n;
                this._gpuTubeCount = cnt;
            }
            if (!cnt) return false;

            // THE VIEW SCALE, the one number from the block below that is still
            // needed up here: the GPU draws with it and a pan drag converts
            // screen pixels to Angstroms with it. Arithmetic, not a pass.
            const framed = this.drawnStats() || object;
            const maxExtent = (framed && framed.maxExtent > 0) ? framed.maxExtent : 30.0;
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
        /**
         * HOW BIG POSITION i IS ON SCREEN - the two answers, from one place.
         *
         *   drawn  the radius of the thing that is actually painted. What
         *          anything MARKING the position measures off.
         *   pick   the radius that counts as a hit, which is deliberately
         *          bigger than the drawn thing for a ribbon: a residue is a
         *          click target the size of a residue, not the width of the
         *          tape drawn through it.
         *
         * The two differ, and confusing them is what put a selection band
         * through the middle of a metal: the band took the picking radius and
         * halved it, which is a fair estimate of a RIBBON's width and simply
         * wrong for a ball drawn at a known radius.
         *
         * A LONE ATOM IS THE CASE THE ESTIMATE CANNOT COVER. It is not a
         * segment of anything - it is drawn as a ball of its element's van der
         * Waals radius, a zinc 1.39 A against a potassium's 2.75 - so its size
         * comes from the element and follows the zoom, and there is nothing to
         * estimate. Everything else keeps the old estimate exactly.
         *
         * Here rather than in either caller because there are TWO projections
         * (this and projectPosition, the older per-position one) and they had
         * already drifted: sizing a metal in one of them left the other
         * handing out the width of a bond.
         */
        _positionRadiiPx(i, base, wm, pe, scale) {
            const lone = this._loneAtoms;
            if (lone && lone.has(i) && this.elementAt) {
                const api = typeof window !== 'undefined' && window.py2dmolCartoon;
                const el = this.elementAt(i);
                if (el && api && api.loneAtomRadiusA) {
                    const d = api.loneAtomRadiusA(el) * scale * pe;
                    return { drawn: d, pick: Math.max(2, d) };
                }
            }
            const pick = Math.max(2, base * wm * 0.5 * pe);
            return { drawn: pick * SELECTION_HALO_RADIUS_FRAC, pick };
        }

        _projectForPicking(displayWidth, displayHeight, scale) {
            const np = this.coords.length;
            const sx = this.screenX; const sy = this.screenY;
            const sr = this.screenRadius; const sv = this.screenValid;
            const sdr = this.screenDrawRadius;
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
            // A SELECTED POSITION IS PROJECTED WHETHER OR NOT IT IS DRAWN. The
            // band over it is a UI indicator, not part of the molecule: it says
            // where the selection is, and a selection you have hidden is
            // precisely the one you need told about. Over nothing, if that is
            // what is there.
            const marked = this.selectionInk ? this.selectionInk() : this.residueSelection;
            const wanted = (i) => !mask || mask.has(i) || (marked && marked.has(i));
            for (let i = 0; i < np; i++) {
                if (!wanted(i)) { sv[i] = 0; continue; }
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
                const rr = this._positionRadiiPx(i, base, wm, pe, scale);
                sr[i] = rr.pick;
                if (sdr) sdr[i] = rr.drawn;
                sv[i] = fid;
            }
        }

        _gpuWillDraw() {
            if (this.useGPU !== true) return false;
            if (this.drawMode) return false;      // see _gpuWillTake
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
            // A STYLE BEING SET WITHOUT DRAWING. _switchToObject restores an
            // object's style before its frames are loaded, so anything drawn
            // here is built out of the PREVIOUS object's coordinates and thrown
            // away a moment later - see setStyle's quiet flag.
            if (this._quietStyle || this._switchQuiet) return;
            // An auto slab follows its selection through a rotation; everything
            // below reads the planes, so it is brought up to date first.
            this._refreshAutoClip();
            if (this.currentFrame < 0) {
                // Clear canvas if no frame is set
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                return;
            }
            this._renderToContext(this.ctx, this.displayWidth, this.displayHeight);
            if (this._inkSkipped) this._scheduleSettle();
        }

        // Core rendering logic - can render to any context (canvas, SVG, etc.)
        /**
         * WHICH OBJECTS THIS FRAME DRAWS, in the order they are drawn.
         *
         * One, today - and the callers ask through here rather than reading
         * currentObjectName so that the day it returns several, they already
         * do the right thing. `shownObjects` is the set the object list will
         * write to; anything not in objectsData is ignored rather than
         * dropped, because an object can be deleted while the set remembers
         * it.
         */
        drawnObjects() {
            const all = this.objectsData || {};
            const names = Object.keys(all);
            const want = this.shownObjects;
            if (want) {
                // AN EMPTY SET IS AN ANSWER: everything switched off, nothing on
                // screen. Only a set that names objects which have all been
                // deleted is stale, and falls through to the default.
                if (!want.size) return [];
                // the load order, so the list and the painting agree
                const out = names.filter((n) => want.has(n));
                if (out.length) return out;
            }
            // NULL MEANS THE ONE BEING EDITED, and that is the resting state:
            // one object on screen, chosen with the dropdown, exactly as it has
            // always been. Showing several is something the user asks for, by
            // pressing All or lighting an eye in the list - never something
            // that happens to them because a second file was loaded.
            return this.currentObjectName ? [this.currentObjectName] : [];
        }

        /**
         * WHICH OBJECTS ARE ON SCREEN. The list UI writes here.
         *
         * Names not loaded are ignored rather than an error - an object can be
         * deleted while a saved session still names it. An empty set, or one
         * naming nothing that exists, falls back to the current object: the
         * viewer never shows nothing because a list went stale.
         *
         * @returns {boolean} whether the picture changed
         */
        setShownObjects(names, skipRender = false) {
            const all = this.objectsData || {};
            const before = this.drawnObjects().join(' ');
            // NULL RESETS TO THE DEFAULT - the object being edited, on its own.
            // An array is authoritative, including an empty one, which is every
            // object switched off and an empty canvas.
            if (names === null || names === undefined) {
                this.shownObjects = null;
            } else {
                const live = names.filter((n) => all[n]);
                // A LIST THAT NAMES ONLY OBJECTS WHICH ARE GONE is stale - a
                // restored session, a deleted object - and means the default,
                // not "show nothing". Asking for nothing is passing nothing.
                this.shownObjects = (names.length && !live.length)
                    ? null : new Set(live);
            }
            const after = this.drawnObjects().join(' ');
            if (before === after) return false;
            this._applyShownObjects(skipRender);
            return true;
        }

        /**
         * Load whatever drawnObjects() now says, as ONE coordinate array.
         *
         * One object is loaded exactly as it always was - the merge path is not
         * entered at all, so the ordinary single-object case cannot be slowed
         * down or subtly changed by code it never runs.
         */
        _applyShownObjects(skipRender = false) {
            const names = this.drawnObjects();
            const ms = this.multiState;

            // NOTHING ON SCREEN, because every object was switched off. The
            // coordinate array is emptied rather than the objects unloaded:
            // the panels, the sequence strip and the picker all go on working
            // on the object being edited, and lighting an eye brings it back.
            if (!names.length) {
                this._dropMergeState();
                this.coords = [];
                this.segmentIndices = [];
                this._invalidateSegmentCache();
                this._invalidateShadowCache();
                if (!skipRender) this.render('nothing shown');
                return;
            }

            // ONE OBJECT, AND IT IS THE ONE BEING EDITED: the ordinary path,
            // untouched. Any other single object goes through the merge, which
            // is what knows how to draw an object that is not the current one.
            if (names.length === 1 && names[0] === this.currentObjectName) {
                if (!ms.enabled) return;
                const carriedOut = this._selectionAsOwners();
                this._dropMergeState();
                this._invalidateSegmentCache();
                this._invalidateShadowCache();
                // ...and frame on what is left, the same re-framing that
                // entering the merge did. A camera still set to hold two
                // structures shows one of them small and off to a side.
                const back = this.objectsData[this.currentObjectName];
                if (back && back.center) {
                    this.viewerState.center = { x: back.center[0], y: back.center[1],
                        z: back.center[2] };
                    this.viewerState.extent = back.maxExtent || null;
                }
                this._loadFrameData(this.currentFrame, skipRender);
                this._restoreSelectionFromOwners(carriedOut);
                return;
            }

            // THE TWO MERGES ARE EXCLUSIVE. Overlay puts every frame of one
            // object in the array; this puts one frame of every shown object.
            // Both at once is a cross product nobody asked for, and one
            // sourceGroups() answer cannot describe it.
            if (this.overlayState.enabled) {
                const cur = this.objectsData[this.currentObjectName];
                this._leavingOverlayForMerge = true;
                try {
                    if (cur) this._exitOverlayMode(cur, this.currentFrame, true);
                } finally {
                    this._leavingOverlayForMerge = false;
                }
            }

            // WHAT EACH OBJECT HAD HIDDEN is read from its own record, which
            // every visibility change keeps up to date in that object's own
            // numbering - see _saveVisibilityToObjects. Snapshotting the LIVE
            // mask here instead looked equivalent and was not: on a plain load
            // the mask still describes the object that was on screen a moment
            // ago while currentObjectName is already the new one, so the whole
            // of the old object's mask was attributed to the new one and the
            // old one vanished from the picture with its eye showing open.
            const sameSources = !!(ms.enabled && ms.sourceNames
                && ms.sourceNames.length === names.length
                && ms.sourceNames.every((n, k) => n === names[k]));

            const merged = this._mergeObjects(names);
            if (!merged) return;

            ms.enabled = true;
            ms.sourceIdMap = merged.sourceIdMap;
            ms.sourceNames = merged.sourceNames;
            ms.sourceOffsets = merged.sourceOffsets;
            ms.sourceFrames = merged.sourceFrames;
            ms.sourceAutoColors = merged.sourceAutoColors;
            ms.autoColor = merged.autoColor;
            ms.stats = this._mergedStats(merged.coords);
            // FRAME ON THE LOT WHEN THE LOT CHANGES, and not otherwise. The
            // camera has to move when an object joins or leaves, or the new one
            // is out of shot - but a rebuild for a frame step or a side chain
            // is not a request to re-frame, and doing it there threw away every
            // pan the user had made since the merge began.
            if (ms.stats && !sameSources) {
                this.viewerState.center = { x: ms.stats.center[0],
                    y: ms.stats.center[1], z: ms.stats.center[2] };
                this.viewerState.extent = ms.stats.maxExtent;
            }
            this._sourceGroupsCache = null;
            this._mergedSetCache = null;
            this.lastOperationMode = 'multi-object';
            this._invalidateSegmentCache();
            this._invalidateShadowCache();
            this.lastShadowRotationMatrix = null;
            // THE SELECTION FOLLOWS ITS RESIDUES. It is a set of indices into
            // the array being replaced, so it is carried across as (object,
            // local index) pairs and put back where those residues have landed
            // - anything belonging to an object that is no longer drawn is
            // dropped, and nothing else is. Clearing outright meant that
            // switching one object off threw away a selection made on the one
            // still on screen.
            const carried = sameSources ? null : this._selectionAsOwners();
            this._loadDataIntoRenderer(merged, true);
            if (carried) this._restoreSelectionFromOwners(carried);
            this._applyMergedVisibility(merged, skipRender);
        }

        /**
         * THE CENTRE AND SIZE OF WHAT IS ON SCREEN, which is not the current
         * object's once more than one is drawn.
         *
         * The camera frames on these: the view scale divides by the extent, the
         * shadow grid is sized by it, and the ortho slider reads the spread.
         * Left as the current object's, a second object beside it is simply
         * out of frame - which is what the first run of this looked like:
         * both structures merged, mapped and coloured correctly, and LESS ink
         * on screen than one of them alone.
         *
         * Shaped like an object on purpose - center, maxExtent, stdDev,
         * totalPositions, globalCenterSum - so every reader takes it in place
         * of one with no other change.
         */
        drawnStats() {
            const ms = this.multiState;
            if (ms && ms.enabled && ms.stats) return ms.stats;
            return this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
        }

        /** The same numbers _recomputeObjectStats gives an object, for a merge. */
        _mergedStats(coords) {
            const n = coords ? coords.length : 0;
            if (!n) return null;
            let cx = 0; let cy = 0; let cz = 0;
            for (let i = 0; i < n; i++) {
                cx += coords[i][0]; cy += coords[i][1]; cz += coords[i][2];
            }
            cx /= n; cy /= n; cz /= n;
            let maxSq = 0; let sumSq = 0;
            for (let i = 0; i < n; i++) {
                const dx = coords[i][0] - cx;
                const dy = coords[i][1] - cy;
                const dz = coords[i][2] - cz;
                const d = dx * dx + dy * dy + dz * dz;
                if (d > maxSq) maxSq = d;
                sumSq += d;
            }
            return {
                center: [cx, cy, cz],
                maxExtent: Math.sqrt(maxSq),
                stdDev: Math.sqrt(sumSq / n),
                totalPositions: n,
                globalCenterSum: new Vec3(cx * n, cy * n, cz * n)
            };
        }

        /**
         * EVERY SHOWN OBJECT'S OWN VISIBILITY, in merged indices.
         *
         * The mask is a set of position indices, and each object's was written
         * against its own array. Loaded merged and left alone, the mask of the
         * object that happened to be current still names 0..k - so the second
         * object, sitting past the end of it, is entirely hidden. That is what
         * the first working merge looked like: both structures in the array,
         * both mapped, both coloured, and only one of them on screen.
         *
         * An object nobody has hidden anything in contributes all of itself.
         */
        _applyMergedVisibility(merged, skipRender = false) {
            const names = merged.sourceNames;
            const offsets = merged.sourceOffsets;
            const n = merged.coords.length;
            const chains = merged.chains || [];
            const vis = new Set();

            for (let s = 0; s < names.length; s++) {
                const off = offsets[s];
                const end = (s + 1 < offsets.length) ? offsets[s + 1] : n;
                const name = names[s];
                // That object's own record, in its own numbering.
                const st = this.objectsData[name] && this.objectsData[name].visibilityState;
                const hasPos = st && st.positions && st.positions.size > 0;
                const hasChains = st && st.chains && st.chains.size > 0;
                // NOBODY HAS ASKED, versus NOTHING IS VISIBLE. An object with
                // no record, or an untouched one, contributes all of itself;
                // an EMPTY record in explicit mode is Hide all, and putting
                // that object back on screen at the next rebuild would undo it.
                const untouched = !st || !st.positions
                    || (!hasPos && !hasChains && st.visibilityMode !== 'explicit');
                if (untouched) {
                    for (let i = off; i < end; i++) vis.add(i);
                    continue;
                }
                for (let i = off; i < end; i++) {
                    const local = i - off;
                    if ((hasPos && st.positions.has(local))
                        || (hasChains && st.chains.has(this.chainKeyAt(i)))) {
                        vis.add(i);
                    }
                }
            }

            this.setVisibility({
                positions: vis,
                // CHAIN IDS COLLIDE ACROSS OBJECTS - both structures have a
                // chain A - so the chain half of the mask is resolved into
                // positions above and cleared here rather than re-applied
                // across everything.
                chains: new Set(),
                paeBoxes: [],
                visibilityMode: (vis.size === n) ? 'default' : 'explicit'
            }, skipRender);
        }



        // COPY, CUT AND DELETE RUN ON ONE OBJECT AT A TIME - see
        // _editOneObject - but a SELECTION can reach several, so each of them
        // runs once per object the selection touches. Silently taking only the
        // edited object's share was the alternative, and a Cut that quietly
        // leaves half the selection behind is worse than one that refuses.
        //
        // Wrapped rather than taught the merge: each renumbers half a dozen
        // things keyed by position index, all written against a single
        // object's array.
        //
        // @returns {Array} what each object gave back, in drawing order
        _perObjectEdit(fn) {
            const names = this.objectsInSelection();
            if (names.length <= 1) {
                return [this._editOneObject(() => fn(), names[0])];
            }
            // THE SELECTION IS PUT BACK BEFORE EACH ONE. An edit consumes it -
            // it is narrowed to that object's share, and Copy leaves its own
            // behind - so the second object would be handed whatever the first
            // one finished with, and get nothing of its own.
            const carried = this._selectionAsOwners();
            const out = [];
            for (const name of names) {
                this._restoreSelectionFromOwners(carried);
                out.push(this._editOneObject(() => fn(), name));
            }
            return out;
        }

        extractSelection() {
            const made = this._perObjectEdit(() => this._extractSelection())
                .filter(Boolean);
            // ONE NAME BACK for one object, so nothing that called this before
            // has to change; the list is there for a caller that wants to
            // report all of them.
            return made.length > 1 ? made : (made[0] || null);
        }

        deleteSelection() {
            return this._perObjectEdit(() => this._deleteSelection())
                .some(Boolean);
        }

        cutSelection() {
            const made = this._perObjectEdit(() => this._cutSelection())
                .filter(Boolean);
            if (!made.length) return null;
            if (made.length === 1) return made[0];
            return {
                name: made.map((m) => m.name).join(', '),
                names: made.map((m) => m.name),
                removed: made.reduce((n, m) => n + (m.removed || 0), 0)
            };
        }

        /**
         * IS THERE MORE THAN ONE OBJECT TO DRAW? The merge is not a mode the
         * user turns on: it is simply what drawing two things at once means,
         * and every path that loads coordinates asks this rather than checking
         * whether a merge happens to be up already.
         */
        _mergeWanted() {
            const drawn = this.drawnObjects();
            return drawn.length !== 1 || drawn[0] !== this.currentObjectName;
        }

        /**
         * FILE THE LIVE MASK UNDER THE OBJECT OR OBJECTS IT DESCRIBES.
         *
         * Every visibility change is written through to the object, so that
         * switching away and back finds it where it was left. With several
         * objects merged the mask describes ALL of them, in merged indices -
         * saved whole under whichever object happens to be current, it writes
         * another object's hidden residues into this one's record, and reading
         * it back hides most of the picture. Measured on a plain load of two
         * structures: 348 positions visible out of 433, all of them the first
         * object's, and the second invisible with its eye showing open.
         *
         * Each object gets its own share, in its own numbering.
         */
        _saveVisibilityToObjects() {
            const vm = this.visibilityModel;
            if (!vm) return;
            const ms = this.multiState;
            if (ms && ms.enabled && ms.sourceNames) {
                for (const nm of ms.sourceNames) {
                    const o = this.objectsData[nm];
                    if (!o) continue;
                    o.visibilityState = {
                        positions: this._maskForObject(nm) || new Set(),
                        // chain ids collide across objects, so the chain half
                        // of a merged mask means nothing per object - it is
                        // resolved into positions when the merge is built
                        chains: new Set(),
                        paeBoxes: (nm === this.currentObjectName)
                            ? vm.paeBoxes.map((b) => ({ ...b }))
                            : ((o.visibilityState && o.visibilityState.paeBoxes) || []),
                        visibilityMode: vm.visibilityMode
                    };
                }
                return;
            }
            if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                this.objectsData[this.currentObjectName].visibilityState = {
                    positions: new Set(vm.positions),
                    chains: new Set(vm.chains),
                    paeBoxes: vm.paeBoxes.map((box) => ({ ...box })),
                    visibilityMode: vm.visibilityMode
                };
            }
        }

        /**
         * RELOAD WHAT IS DRAWN, whichever that is.
         *
         * Side chains, bases and elements all change the coordinate array
         * rather than just its colours, so the panel reloads the frame after
         * writing one. Reloading the FRAME while several objects are merged
         * throws the other objects off the screen; the merge has its own way
         * back in, and this is the one call the UI needs to know about.
         */
        reloadDrawn(skipRender = false) {
            if ((this.multiState && this.multiState.enabled) || this._mergeWanted()) {
                this._applyShownObjects(skipRender);
                return;
            }
            this._loadFrameData(this.currentFrame >= 0 ? this.currentFrame : 0, skipRender);
        }

        /**
         * THE SELECTION AS (OBJECT, LOCAL INDEX) PAIRS, which survive a change
         * of array; merged indices do not.
         */
        _selectionAsOwners() {
            const sel = this.residueSelection;
            if (!sel || !sel.size) return null;
            const out = [];
            for (const i of sel) {
                const o = this.ownerOf(i);
                out.push(o ? [o.name, o.local] : [this.currentObjectName, i]);
            }
            return out;
        }

        /**
         * ...and back, into whatever array is loaded now. A residue whose
         * object is no longer drawn has no index to come back to and is
         * dropped; everything else lands where it now lives.
         */
        _restoreSelectionFromOwners(pairs) {
            if (!pairs) return;
            const out = new Set();
            for (const [name, local] of pairs) {
                const off = this.sourceOffsetOf(name);
                const drawn = this.drawnObjects();
                if (drawn.indexOf(name) < 0) continue;
                const at = off + local;
                if (at >= 0 && at < this.coords.length) out.add(at);
            }
            this.residueSelection = out.size ? out : null;
        }

        /**
         * The selection, restricted to one object and in ITS numbering.
         *
         * `residueSelection` is a set of merged indices; an edit rewrites one
         * object's frames and knows nothing about the merge.
         */
        selectionForObject(name) {
            const sel = this.residueSelection;
            if (!sel || !sel.size) return null;
            const ms = this.multiState;
            if (!ms || !ms.enabled) return new Set(sel);
            const out = new Set();
            for (const i of sel) {
                const o = this.ownerOf(i);
                if (o && o.name === name) out.add(o.local);
            }
            return out.size ? out : null;
        }

        /**
         * The visibility mask, likewise: one object's share, in its numbering.
         *
         * AN EMPTY SET IS AN ANSWER. "Nothing of this object is visible" is
         * what Hide all gives, and it has to be distinguishable from "no mask
         * here" - which is read as "all of it" by the caller. Null is returned
         * only when there is no live mask at all.
         */
        _maskForObject(name) {
            const set = this.visibilityModel && this.visibilityModel.positions;
            if (!set) return null;
            const ms = this.multiState;
            if (!ms || !ms.enabled) return new Set(set);
            const out = new Set();
            for (const i of set) {
                const o = this.ownerOf(i);
                if (o && o.name === name) out.add(o.local);
            }
            return out;
        }

        /**
         * WHICH OBJECTS A SELECTION REACHES, in drawing order.
         *
         * Copy, Cut and Delete are per object - each rewrites one object's
         * frames - but a selection is not: with several structures on screen a
         * drag, a Within, or two clicks reach into more than one of them.
         */
        objectsInSelection() {
            const sel = this.residueSelection;
            if (!sel || !sel.size) return [];
            const seen = new Set();
            for (const i of sel) {
                const o = this.ownerOf(i);
                seen.add(o ? o.name : this.currentObjectName);
            }
            return this.drawnObjects().filter((n) => seen.has(n));
        }

        /**
         * RUN A STRUCTURAL EDIT ON THE CURRENT OBJECT ALONE.
         *
         * Copy, Cut and Delete rewrite an object's frames and renumber
         * everything keyed to them - the mask, the side chains, the contacts,
         * the MSA columns. All of that is written against the object's own
         * array, and all of it would be handed merged indices instead, so
         * Delete would remove somebody else's residues or none at all.
         *
         * Rather than teach each of those the merge, the merge is put down for
         * the duration and picked up again after: the edit then runs on exactly
         * the array it was written for. The selection and the mask are
         * translated down with it, and the shown set is restored at the end -
         * including the object a Copy just made, which is the one thing the
         * user will be looking for.
         */
        _editOneObject(fn, name) {
            const ms = this.multiState;
            const editing = name || this.currentObjectName;
            if (!ms || !ms.enabled) {
                if (editing === this.currentObjectName) return fn();
                // ...an object that is not the current one still has to BE the
                // current one for the duration: every one of these paths reads
                // currentObjectName to find the frames it rewrites.
                const was = this.currentObjectName;
                this.currentObjectName = editing;
                try { return fn(); } finally { this.currentObjectName = was; }
            }
            const shown = this.shownObjects ? Array.from(this.shownObjects) : [];
            const sel = this.selectionForObject(editing);
            const mask = this._maskForObject(editing);

            const wasCurrent = this.currentObjectName;
            this.currentObjectName = editing;
            this.setShownObjects([editing], true);
            this.residueSelection = (sel && sel.size) ? sel : null;
            if (this.visibilityModel) {
                this.visibilityModel.positions = mask || new Set();
            }

            let out = null;
            try {
                out = fn();
            } finally {
                // ...and back, minus anything the edit removed, plus whatever
                // it made: a Copy that lands off screen looks like a Copy that
                // did not happen.
                const made = this.currentObjectName;
                if (wasCurrent && this.objectsData[wasCurrent]) {
                    this.currentObjectName = wasCurrent;
                }
                const back = shown.filter((n) => this.objectsData[n]);
                if (made && this.objectsData[made] && !back.includes(made)) {
                    back.push(made);
                }
                if (back.length) this.setShownObjects(back);
            }
            return out;
        }

        /**
         * WHAT COUNTS AS ONE CHAIN, ANYWHERE: colour, visibility, selection.
         *
         * Chain ids are only unique inside a file: put two structures on screen
         * and both have a chain A, which under the chain scheme comes out the
         * same colour for both - a dimer beside a dimer reading as one
         * four-chain thing. So the key carries the OBJECT with the id.
         *
         * BY NAME, NOT BY POSITION IN THE MERGE. Keyed by which source it
         * happened to be, an object's colours changed every time something else
         * was switched on or off - it is source 0 alone and source 1 beside
         * another, and those are different palette slots. Reported as a clash
         * in both viewers, and it was: the same molecule, two colours, decided
         * by what else was on screen.
         *
         * Plain chain ids while only ONE object is loaded, which is every
         * single-structure session and leaves those colours exactly as they
         * have always been.
         *
         * EVERYTHING that asks "is this position in that chain" asks through
         * here - the visibility mask, the chain buttons in the strip, the PAE
         * map. Keyed by the bare id, selecting chain A of one object selected
         * chain A of the other, which is what a bare id MEANS once two files
         * are on screen. `this.chains` stays the bare id: it is what the file
         * said, and what the panel prints.
         */
        chainKeyAt(i) {
            if (!this._chainColorKeys) return this.chains[i] || 'A';
            return this._chainColorKeys[i];
        }

        /** The same key, for a chain of a named object rather than a position. */
        chainKeyFor(chainId, objectName) {
            const names = Object.keys(this.objectsData || {});
            if (names.length < 2) return chainId;
            const name = objectName || this.currentObjectName;
            return name ? (name + '|' + chainId) : chainId;
        }

        /**
         * A PALETTE SLOT FOR EVERY CHAIN OF EVERY LOADED OBJECT, in load order,
         * whether or not it is on screen.
         *
         * Built over what is LOADED rather than what is drawn, for two reasons:
         * an object's colours must not move when its neighbour is switched off,
         * and the sequence strip asks for the colours of the object it is
         * showing, which may be hidden.
         *
         * One object gets 0..n-1 and the next carries on from there, which is
         * what a single file with all those chains would have got.
         */
        _buildChainIndexMap() {
            const all = this.objectsData || {};
            const names = Object.keys(all);
            const many = names.length > 1;
            const map = new Map();
            let slot = 0;
            const add = (key) => {
                if (key && !map.has(key)) map.set(key, slot++);
            };
            for (const name of names) {
                const fr = all[name] && all[name].frames && all[name].frames[0];
                const chs = (fr && fr.chains) || [];
                for (const c of [...new Set(chs)].sort()) {
                    add(many ? (name + '|' + c) : c);
                }
            }
            // ...and anything the LOADED array has that frame 0 did not - a
            // later frame with an extra chain, a side chain appended under a
            // chain of its own. Appended rather than renumbered, so nothing
            // above moves.
            const n = this.chains ? this.chains.length : 0;
            for (let i = 0; i < n; i++) add(this.chainKeyAt(i));
            this.chainIndexMap = map;
        }

        /**
         * How many positions the loaded array holds. Both arrays describe it,
         * and the panel paths run with only the second one present.
         */
        _positionCount() {
            if (this.coords && this.coords.length) return this.coords.length;
            return this.positionTypes ? this.positionTypes.length : 0;
        }

        /**
         * WHICH OBJECT A MERGED POSITION BELONGS TO, and where it sits in that
         * object's own numbering.
         *
         * Everything an object remembers about its residues - which show side
         * chains, which show base plates, which are hidden, what colour they
         * were given, what secondary structure was forced on them - is a set or
         * a map keyed by POSITION INDEX, written against that object's own
         * array. Merged, only the first object still numbers from zero. This is
         * the one place that knows the difference, and every reader of those
         * sets goes through it or through mergedObjectSet below.
         *
         * A side-chain atom answers for the residue it grows out of: it was
         * appended after the merge, so its own index is past every source's
         * range and means nothing to the object it belongs to.
         *
         * @returns {{name, local, source, frame}|null} null when nothing is
         *   merged, which is the caller's signal that indices are already the
         *   object's own.
         */
        ownerOf(i) {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) return null;
            if (this.sidechainMap && this.sidechainMap.has(i)) {
                i = this.sidechainMap.get(i).owner;
            }
            const g = this.sourceGroups();
            const s = g ? g[i] : -1;
            if (!(s >= 0) || s >= ms.sourceNames.length) return null;
            return {
                name: ms.sourceNames[s],
                local: i - ms.sourceOffsets[s],
                source: s,
                frame: ms.sourceFrames ? ms.sourceFrames[s] : 0
            };
        }

        /**
         * A PER-OBJECT SET OF POSITIONS, READ IN MERGED INDICES.
         *
         * The sets come in two polarities and both have to survive the merge:
         *
         *   'none' - null means the object has none of this (side chains, a
         *            hidden backbone). An untouched object contributes nothing.
         *   'all'  - null means the object has all of it (base plates, element
         *            colours: on until somebody switches one off). An untouched
         *            object contributes its whole range, because the merged
         *            answer has to be a set the moment ANY object has one.
         *
         * Returns null only when every shown object is untouched - which is
         * what keeps "nobody has asked" distinguishable from "everything was
         * switched off", a distinction both polarities depend on.
         *
         * Cached by the identity of the sets it was built from, because the
         * drawing asks per segment and the GPU signature asks per frame.
         *
         * @param {string} field  the property on the object
         * @param {'all'|'none'} nullMeans  what an absent set means
         */
        mergedObjectSet(field, nullMeans) {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const o = this.objectsData?.[this.currentObjectName];
                const set = o && o[field];
                return (set instanceof Set) ? set : null;
            }
            const parts = ms.sourceNames.map(
                (n) => (this.objectsData[n] || {})[field]);
            const cache = this._mergedSetCache || (this._mergedSetCache = {});
            const hit = cache[field];
            if (hit && hit.names === ms.sourceNames && hit.parts.length === parts.length
                && hit.parts.every((p, k) => p === parts[k])) {
                return hit.out;
            }

            const total = this._positionCount();
            let touched = false;
            const out = new Set();
            for (let s = 0; s < ms.sourceNames.length; s++) {
                const off = ms.sourceOffsets[s];
                const end = (s + 1 < ms.sourceOffsets.length)
                    ? ms.sourceOffsets[s + 1] : total;
                const set = parts[s];
                if (set instanceof Set) {
                    touched = true;
                    for (const p of set) {
                        const at = p + off;
                        if (at >= off && at < end) out.add(at);
                    }
                } else if (nullMeans === 'all') {
                    for (let i = off; i < end; i++) out.add(i);
                }
            }
            const res = touched ? out : null;
            cache[field] = { names: ms.sourceNames, parts, out: res };
            return res;
        }

        /**
         * The entropy vector for what is on screen: one value per position,
         * each object's own alignment mapped onto its own residues and the
         * lot concatenated. One object's vector laid over a merged array
         * would colour the second object by the first one's conservation.
         */
        entropyForDrawn() {
            if (!window.MSA || !window.MSA.mapEntropyToStructure) return undefined;
            const frame = this.currentFrame >= 0 ? this.currentFrame : 0;
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const o = this.objectsData?.[this.currentObjectName];
                return o ? window.MSA.mapEntropyToStructure(o, frame) : undefined;
            }
            const out = [];
            for (let s = 0; s < ms.sourceNames.length; s++) {
                const o = this.objectsData[ms.sourceNames[s]];
                const off = ms.sourceOffsets[s];
                const end = (s + 1 < ms.sourceOffsets.length)
                    ? ms.sourceOffsets[s + 1] : this._positionCount();
                const v = o ? window.MSA.mapEntropyToStructure(
                    o, ms.sourceFrames ? ms.sourceFrames[s] : 0) : null;
                for (let i = off; i < end; i++) {
                    // -1 is what the colour path reads as "no entropy here"
                    out.push((v && v[i - off] !== undefined) ? v[i - off] : -1);
                }
            }
            return out;
        }

        /**
         * THE LIGAND GROUPS OF EVERY SHOWN OBJECT, in merged indices.
         *
         * A group is a Map from a key - chain, residue number, name - to the
         * position indices of one ligand's atoms. Keys collide across objects
         * for the same reason chain ids do, so each is prefixed with the object
         * it came from; the indices are offset like everything else.
         */
        mergedLigandGroups() {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const o = this.objectsData?.[this.currentObjectName];
                return (o && o.ligandGroups) || null;
            }
            const parts = ms.sourceNames.map(
                (n) => (this.objectsData[n] || {}).ligandGroups);
            const c = this._mergedLigCache;
            if (c && c.names === ms.sourceNames && c.parts.length === parts.length
                && c.parts.every((p, k) => p === parts[k])) {
                return c.out;
            }
            const out = new Map();
            for (let s = 0; s < ms.sourceNames.length; s++) {
                const g = parts[s];
                if (!g || !g.size) continue;
                const off = ms.sourceOffsets[s];
                for (const [key, idxs] of g.entries()) {
                    out.set(ms.sourceNames[s] + '|' + key, idxs.map((i) => i + off));
                }
            }
            const res = out.size ? out : null;
            this._mergedLigCache = { names: ms.sourceNames, parts, out: res };
            return res;
        }

        /**
         * The object a write to these positions should land on, and the
         * positions in ITS numbering.
         *
         * A panel edits whatever is selected, and in a merged view a selection
         * can reach two objects at once. Grouped here so a setter writes each
         * object's own set rather than pushing merged indices into one of them.
         *
         * @param {Iterable<number>} positions merged indices
         * @returns {Array<{object, name, positions:number[]}>}
         */
        writeGroups(positions) {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const name = this.currentObjectName;
                const object = name ? this.objectsData[name] : null;
                return object ? [{ object, name, positions: Array.from(positions) }] : [];
            }
            const by = new Map();
            for (const i of positions) {
                const o = this.ownerOf(i);
                if (!o) continue;
                if (!by.has(o.name)) by.set(o.name, []);
                by.get(o.name).push(o.local);
            }
            const out = [];
            for (const [name, local] of by) {
                const object = this.objectsData[name];
                if (object) out.push({ object, name, positions: local });
            }
            return out;
        }

        /**
         * That object's positions, in ITS numbering: [0, n) for a lone object,
         * and the slice of the merged array it occupies otherwise. Setters that
         * materialise a full set - "every nucleotide", "every element owner" -
         * need to do it per object, not over the whole merged array.
         */
        localRangeOf(name) {
            const ms = this.multiState;
            const total = this._positionCount();
            // A LONE OBJECT OWNS EVERYTHING, however long the array turns out
            // to be. Answering with a counted length instead means every path
            // that runs before the coordinates are in - the panel's, in
            // particular - materialises an empty set and reads as "nothing
            // here" rather than "all of it".
            if (!ms || !ms.enabled || !ms.sourceNames) return { off: 0, end: Infinity };
            const s = ms.sourceNames.indexOf(name);
            if (s < 0) return { off: 0, end: total };
            return {
                off: ms.sourceOffsets[s],
                end: (s + 1 < ms.sourceOffsets.length) ? ms.sourceOffsets[s + 1] : total
            };
        }

        /** Forget the merge, without touching what is loaded. */
        _dropMergeState() {
            const ms = this.multiState;
            if (!ms) return;
            ms.enabled = false;
            ms.sourceIdMap = null;
            ms.sourceNames = null;
            ms.sourceOffsets = null;
            ms.sourceFrames = null;
            ms.sourceAutoColors = null;
            ms.autoColor = null;
            ms.stats = null;
            this._sourceGroupsCache = null;
            this._mergedSetCache = null;
            this._mergedLigCache = null;
        }

        /**
         * Where an object's positions start in the merged array. Every set
         * that is keyed by position index - side chains, bases, elements, the
         * selection - is written against its own object and read against this.
         *
         * @param {string} name
         * @returns {number} the offset, or 0 when nothing is merged
         */
        sourceOffsetOf(name) {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) return 0;
            const at = ms.sourceNames.indexOf(name);
            return at < 0 ? 0 : ms.sourceOffsets[at];
        }

        /**
         * THE RESIDUES WHOSE SIDE CHAINS ARE SWITCHED ON, in merged indices.
         *
         * `obj.sidechains` is a set of position indices meaningful against its
         * own object. Merged, every object after the first sits at an offset,
         * so read raw the second object's set would grow side chains on the
         * FIRST object's residues - visibly, and on the wrong atoms.
         */
        shownSidechainSet() {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const obj = this.objectsData?.[this.currentObjectName];
                return (obj && obj.sidechains) || null;
            }
            const out = new Set();
            for (let s = 0; s < ms.sourceNames.length; s++) {
                const set = this.objectsData?.[ms.sourceNames[s]]?.sidechains;
                if (!set) continue;
                const off = ms.sourceOffsets[s];
                for (const p of set) out.add(p + off);
            }
            return out.size ? out : null;
        }

        /**
         * WHICH POSITIONS ARE ALLOWED TO BE PART OF THE SAME THING.
         *
         * The coordinate array can hold more than one structure at a time -
         * every frame of a trajectory in overlay mode, or several objects in a
         * multi-object view - and in both cases a position may only bond,
         * count along a chain, and cast a shadow WITHIN its own source. The two
         * merges therefore answer to one array here rather than each gating its
         * own copy of those rules, which is how the overlay came to have four
         * such gates and a fifth one it was missing.
         *
         * SIDE CHAINS ARE APPENDED AFTER THE MERGE, so the map is SHORTER than
         * the coordinate array whenever any are showing. Read raw, every one of
         * those atoms comes back undefined - which compares equal to every
         * other undefined, so they all silently become one extra source that
         * bonds to itself and shades itself. Each appended atom is given its
         * owning residue's source instead, and the extension is cached against
         * the map it was built from.
         *
         * @returns {Array|null} one source id per position, or null when the
         *   array holds a single structure and every position may reach any
         *   other.
         */
        sourceGroups() {
            const n = this.coords ? this.coords.length : 0;
            const ov = this.overlayState;
            const ms = this.multiState;
            let base = null;
            if (ov && ov.enabled && ov.frameIdMap) base = ov.frameIdMap;
            else if (ms && ms.enabled && ms.sourceIdMap) base = ms.sourceIdMap;
            if (!base || !n) return null;
            if (base.length === n) return base;
            // A map LONGER than the array is stale - the merge it describes is
            // not the one loaded - and guessing which part of it still applies
            // would cut the structure somewhere arbitrary.
            if (base.length > n) return null;

            const c = this._sourceGroupsCache;
            if (c && c.base === base && c.out.length === n) return c.out;

            const out = base.slice ? Array.from(base) : Array.prototype.slice.call(base);
            const map = this.sidechainMap;
            for (let i = base.length; i < n; i++) {
                const owner = map && map.get(i) ? map.get(i).owner : undefined;
                // No owner means nothing here knows where the position came
                // from; give it a source of its own rather than fold it into
                // somebody else's, so a stray bond is visible instead of wrong.
                out.push((owner !== undefined && owner < base.length)
                    ? base[owner] : -(i + 1));
            }
            this._sourceGroupsCache = { base, out };
            return out;
        }

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
                const gpuOk = this.useGPU === true
                    && !this.drawMode                      // see _gpuWillTake
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
            // WHICH PATH DREW THIS FRAME, on every frame and not only the ones
            // the GPU was asked about. Assigned under `if (deferRot)` it went
            // stale the moment the GPU was switched off: the flag still said
            // true while the 2D pass was drawing, and it is what the harnesses
            // read to know which renderer they just measured.
            this.gpuDrewLastFrame = deferRot ? tubeGPUTook : false;
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
            const bbHidden = this.backboneHiddenSet();
            for (let i = 0; i < n; i++) {
                const segInfo = segments[i];
                let isVisible = false;
                // the backbone switch, before the visibility mask: a hidden
                // backbone is not a hidden RESIDUE, so its side chain stays.
                // BOTH ends, so the cut lands at the edge of the selection
                // rather than a residue short of it.
                if (bbHidden && !this._isSidechainSegment(segInfo)
                    && bbHidden.has(segInfo.idx1) && bbHidden.has(segInfo.idx2)) continue;

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
            const framed = this.drawnStats() || object;
            const maxExtent = (framed && framed.maxExtent > 0) ? framed.maxExtent : 30.0;

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

            // THE CLIP SLAB, on the 2D path, is a CULL rather than a cut: a
            // canvas paints whole segments, so one straddling a plane is kept
            // or dropped by its own depth and the cut comes out stepped at the
            // scale of one segment. The GPU path cuts per fragment and is
            // exact; this is the fallback, asking the same clipAccepts.
            //
            // CULLED AT THE PAINT, NOT HERE. visibleOrder is what gets
            // PROJECTED, and a position with no screen coordinates cannot carry
            // a selection band, a hover mark or a click - so dropping clipped
            // segments from this list made the selection vanish along with the
            // geometry, which it must not: the band is a UI indicator drawn over
            // the finished frame, and it says where the selection IS even when
            // that is behind something or outside the slab.
            const clipCull = this.clipSlabOn();

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
                // A MERGED VIEW SHADES EACH SOURCE ON ITS OWN. Frames of a
                // trajectory sit on top of each other, so a shared shadow pass
                // has them darkening each other into mud; objects placed side
                // by side for comparison have the same problem, and "do not
                // cast shadow between objects" was the ask. One pass per
                // source answers both.
                const shadowGroups = this.sourceGroups();
                if (shadowGroups) {
                    const segmentsBySource = new Map();
                    const sourceNumPositions = new Map();

                    for (let i = 0; i < visibleOrder.length; i++) {
                        const segIdx = visibleOrder[i];
                        const src = shadowGroups[segments[segIdx].idx1];
                        if (!segmentsBySource.has(src)) {
                            segmentsBySource.set(src, []);
                            sourceNumPositions.set(src, 0);
                        }
                        segmentsBySource.get(src).push(segIdx);
                    }

                    // how big each source is on its own, which is what the
                    // shadow pass sizes its grid from
                    for (let i = 0; i < this.coords.length; i++) {
                        const src = shadowGroups[i];
                        sourceNumPositions.set(src, (sourceNumPositions.get(src) || 0) + 1);
                    }

                    for (const [src, srcSegments] of segmentsBySource) {
                        this._calculateFrameShadows(srcSegments, sourceNumPositions.get(src),
                            segments, segData, maxExtent, shadows, tints);
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
            const screenDrawRadius = this.screenDrawRadius;
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

                let pe = 1;
                if (isPerspective(this.viewerState)) {
                    const z = this.viewerState.focalLength - vec.z;
                    // Clamp z to prevent division by zero or negative values
                    // If z is too small, atom is too close to camera
                    if (z <= 0.1) {
                        screenValid[idx] = 0; // Mark invalid
                        return;
                    }
                    pe = this.viewerState.focalLength / z;
                    x = centerX + (vec.x * scale * pe);
                    y = centerY - (vec.y * scale * pe);
                } else {
                    x = centerX + vec.x * scale;
                    y = centerY - vec.y * scale;
                }

                // THE SAME TWO RADII _projectForPicking uses - see
                // _positionRadiiPx. This path used to compute its own, which is
                // how the two came to disagree about a metal.
                const rr = this._positionRadiiPx(idx, baseLineWidthPixels,
                    widthMultiplier, pe, scale);
                radius = rr.pick;
                screenDrawRadius[idx] = rr.drawn;

                screenX[idx] = x;
                screenY[idx] = y;
                screenRadius[idx] = radius;
                screenValid[idx] = currentScreenFrameId;
            };

            // ...and the selected positions the mask left out, for the same
            // reason _projectForPicking does: the band over a hidden selection
            // is the one you most need to see.
            const markedSel = this.selectionInk ? this.selectionInk() : this.residueSelection;
            if (markedSel && markedSel.size) {
                for (const i of markedSel) {
                    if (i >= 0 && i < rotated.length) projectPosition(i);
                }
            }

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
                // ...except by the clip, which is applied here rather than to
                // the order, so that what it cuts is still projected
                if (clipCull && !this.clipAccepts(zValues[idx])) continue;

                // Calculate opacity based on position in visibleOrder
                // i=0 is furthest (start of sliced array), i=numRendered-1 is closest
                // Distance from front: numRendered - 1 - i
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
                    if (this.coords.length === 0 || this.lastRenderedFrame === -1) {
                        this._loadFrameForPlayback(currentFrame);
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
        /**
         * WHAT THE CAPTURE PANEL REMEMBERS, and what it starts at.
         *
         * One object for both outputs. There used to be two - _saveOpts for the
         * image, _videoOpts for a recording - written and defaulted in four
         * places between them, which is how the DPI default came to be 300 in
         * one of them and 300 spelled again in the shift-click path.
         *
         * dpi 200: a 1000 px canvas comes out about 2000 px, which is a figure
         * at column width in print and a file measured in single-digit
         * megabytes. 300 is the right number for a full-page plate and was the
         * wrong one to reach for every time.
         *
         * mbps 12: A BITRATE IS A CEILING, NOT A TARGET, which is the whole
         * reason to be generous with it. Measured on one turn at 1196x1196,
         * 15 fps, asking for N and seeing what the encoder actually spent:
         *
         *      asked   spent   file    SSIM against a 40 Mbps take
         *        2     1.07    261 kB   0.9797
         *        5     2.59    632 kB   0.9894
         *       10     5.04    1.2 MB   0.9967
         *       20     9.8     2.4 MB   0.9993
         *       40     14.7    3.6 MB   -
         *
         * So on flat cartoon colour the encoder stops well short of the
         * allowance and a high ceiling costs nothing; it only spends the bytes
         * where the picture genuinely needs them. 5 was chosen against the 20
         * the three recorders each hard-coded, and it is fine at the size a
         * viewer opens at - but it is thin for an upload master at 2x or 3x,
         * where 5 Mbps over 1196x1196 at 30 fps is 0.12 bits a pixel. Anything
         * bound for a platform is re-encoded on arrival (TikTok, Instagram and
         * YouTube all do), and that second encode is only as good as what it
         * is given, which is the argument for the headroom.
         */
        static get CAPTURE_DEFAULTS() {
            return { format: 'png', dpi: 200,
                seconds: 6, fps: 30, mbps: 12, container: 'webm', scale: 1,
                rotations: 1 };
        }

        /** The panel's state, defaults filled in, so every reader agrees. */
        captureOpts() {
            const d = this.constructor.CAPTURE_DEFAULTS;
            return Object.assign({}, d, this._captureOpts || {});
        }

        /**
         * WHICH VIDEO FORMATS THIS PAGE CAN ACTUALLY WRITE.
         *
         * Asked of the browser and of the page, never assumed. WebM is
         * MediaRecorder's own and is always there; MP4 is MediaRecorder's too
         * where the build has an H.264 encoder, which recent Chrome and Safari
         * do and Firefox does not; GIF has no native encoder at all and is
         * offered only where py2dmolGif is loaded - web/utils.js, which is
         * index.html and not the notebook. A format that cannot be written must
         * not be in the menu: a recording that fails after the fact has already
         * cost the user the take.
         */
        videoFormats() {
            const ok = (m) => (typeof MediaRecorder !== 'undefined'
                && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
            const out = [];
            const webm = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
                .find(ok);
            if (webm) out.push({ id: 'webm', label: 'WebM', ext: 'webm', mime: webm });
            const mp4 = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4']
                .find(ok);
            if (mp4) out.push({ id: 'mp4', label: 'MP4', ext: 'mp4', mime: mp4 });
            if (typeof window !== 'undefined' && typeof window.py2dmolGif === 'function') {
                out.push({ id: 'gif', label: 'GIF', ext: 'gif', mime: null });
            }
            // A ZIP OF PNGs IS A VIDEO FORMAT TOO - the same frames, written
            // one file each instead of one file for all of them, which is what
            // you want for a figure per timepoint or for handing the frames to
            // an editor rather than a re-encode of them. It was a button of its
            // own on the Image row that only ever wrote a trajectory; as a
            // format it records a turn and a drawing as well, and takes its
            // resolution from the dpi above rather than from a Size menu that
            // would be a second way of saying the same thing.
            if (typeof JSZip !== 'undefined') {
                out.push({ id: 'zip', label: 'Images', ext: 'zip', mime: null });
            }
            return out;
        }

        videoFormatOf(id) {
            const all = this.videoFormats();
            return all.find((f) => f.id === id) || all[0] || null;
        }

        /**
         * THE SIZES A RECORDING CAN BE MADE AT, in real pixels.
         *
         * The old answer to "what resolution is the video" was "whatever the
         * canvas happens to be" - the backing store, which is the panel size
         * times the device pixel ratio and never stated anywhere. It is stated
         * now, and can be multiplied: a frame is re-rendered at the target size
         * rather than scaled up from the screen one, the same way a 300 dpi PNG
         * is, so a 2x recording genuinely resolves more.
         *
         * Even numbers, because H.264 wants both dimensions even and simply
         * fails on a stream that is not. Capped at 4096, the level limit most
         * hardware encoders stop at.
         */
        videoSizes() {
            const c = this.canvas;
            if (!c || !c.width) return [];
            const out = [];
            // SMALLER AS WELL AS LARGER. A half-size recording is a quarter of
            // the pixels and about a quarter of the file - which is what you
            // want for a GIF, for a slide, or for anything going into a
            // message - and there was no way to ask for one: the recording was
            // whatever the canvas happened to be.
            const FRACTION = { 0.25: '1/4', 0.5: '1/2' };
            for (const k of [0.25, 0.5, 1, 2, 4]) {
                const w = 2 * Math.round(c.width * k / 2);
                const h = 2 * Math.round(c.height * k / 2);
                if (w < 64 || h < 64) continue;            // below this it is a thumbnail
                if (k > 1 && (w > 4096 || h > 4096)) break; // the encoder level limit
                // THE MULTIPLIER IS THE LABEL, not the pixels. The info line
                // under the row already says what the file will be - "WebM
                // 598x598 - 6s at 30 fps" - so spelling the same number into
                // the menu said it twice and made the widest control in a
                // 160px panel out of the half that was already there. And a
                // fraction reads as a fraction: "0.25x" is a decimal doing a
                // fraction's job, with an x repeating what the control's own
                // name already says.
                out.push({ scale: k, w, h, label: FRACTION[k] || String(k) });
            }
            return out;
        }

        // A GIF IS NOT A VIDEO FILE and cannot be treated as one: every frame
        // is kept in memory until the palette is known, its delays are whole
        // centiseconds so anything past ~20 fps is a lie, and 256 colours over
        // a megapixel is a slow quantisation and a huge file. These are the
        // limits the panel shows and the sink enforces.
        static get GIF_LIMITS() { return { maxPx: 1024, maxFps: 20, maxFrames: 300 }; }

        /**
         * WHERE A RECORDING'S FRAMES GO. One object, three recorders, two very
         * different destinations behind it.
         *
         * The turn, the drawing and the trajectory each drive their own frames
         * for their own reasons and none of them should have to know how a file
         * gets written. They render, then call frame(); at the end they call
         * finish(). What that does - hand a canvas stream to MediaRecorder, or
         * collect pixels for the GIF encoder - is decided here, once, from the
         * panel's options.
         *
         * @param {object} opts - seconds/fps/mbps/container/scale, plus
         *        sourceCanvas to record something other than the live canvas
         *        (the trajectory recorder composites a scatter plot beside it)
         * @returns {object|null} {frame, finish, cancel, width, height, note}
         */
        _makeVideoSink(opts) {
            const o = opts || {};
            const fmt = this.videoFormatOf(o.container);
            if (!fmt) return null;
            const gif = fmt.id === 'gif';
            const zip = fmt.id === 'zip';
            const LIM = this.constructor.GIF_LIMITS;
            const fps = Math.max(5, Math.min(gif ? LIM.maxFps : 60, Number(o.fps) || 30));
            const live = this.canvas;
            const source = o.sourceCanvas || live;
            const dispW = this.displayWidth || parseInt(live.style.width) || live.width;
            const dispH = this.displayHeight || parseInt(live.style.height) || live.height;

            // WHAT SIZE, AND WHETHER THAT NEEDS A SECOND CANVAS AT ALL.
            // Scale 1 with no compositing records the live canvas directly -
            // the path this always took, and the cheapest. Anything else needs
            // its own canvas, and every frame is RE-RENDERED into it at that
            // size rather than blown up from the screen.
            let w = source.width; let h = source.height;
            let note = '';
            if (zip) {
                // THE IMAGE ROW'S DPI, not the video Size: these frames ARE
                // images, and two controls for one resolution is how they come
                // to disagree.
                const k = Math.max(36, Math.min(1200, Number(o.dpi) || 200)) / 96;
                w = Math.max(1, Math.round(dispW * k));
                h = Math.max(1, Math.round(dispH * k));
                const maxPx = 16000;
                if (w > maxPx || h > maxPx) {
                    const f = Math.min(maxPx / w, maxPx / h);
                    w = Math.round(w * f); h = Math.round(h * f);
                }
                note = `, ${Math.round(96 * w / dispW)} dpi`;
            } else if (!o.sourceCanvas) {
                // ...and DOWN as well as up: the clamp used to floor at 1,
                // which silently turned every half-size recording back into a
                // full-size one - the panel said 300x300 and the file came out
                // 598x598.
                const k = Math.max(0.1, Math.min(3, Number(o.scale) || 1));
                w = 2 * Math.round(live.width * k / 2);
                h = 2 * Math.round(live.height * k / 2);
            }
            if (gif) {
                const long = Math.max(w, h);
                if (long > LIM.maxPx) {
                    const f = LIM.maxPx / long;
                    w = 2 * Math.round(w * f / 2); h = 2 * Math.round(h * f / 2);
                    note = ` (GIF capped at ${LIM.maxPx}px)`;
                }
            }
            // A CUT-OUT GIF HAS TO BE RENDERED, not read off the screen: the
            // live canvas has the paper painted into it and every pixel is
            // opaque. So transparency forces the offscreen path even at 1x.
            // A GIF IS ALWAYS CUT OUT. Its transparency is one palette entry
            // rather than an alpha channel, so the edge is a hard cut - but a
            // turn dropped onto a slide or a dark page wants that far more
            // often than it wants a white square around the structure, and the
            // choice was one more control on the widest row in the panel. PNG
            // already exports this way; WebM and MP4 cannot, which is why it
            // is not a question anywhere else either.
            const clear = gif;
            // A zip is always rendered: its frames are PNGs at their own size,
            // and a PNG of the live canvas would be the screen's.
            const offscreen = zip || clear || (w !== source.width || h !== source.height);
            let target = source;
            let octx = null;
            if (offscreen) {
                target = document.createElement('canvas');
                target.width = w; target.height = h;
                octx = target.getContext('2d');
            }
            // Re-render at the target size, exactly as the PNG export does:
            // _exportPxScale keeps the quantities that are PIXELS by definition
            // - outline width, selection ink - the size they are on screen,
            // while everything measured in Angstrom follows the resolution.
            // ONE RENDER PER FRAME, NOT TWO.
            //
            // The recorders used to render to the screen and then, for a scaled
            // recording, render AGAIN into the offscreen canvas - so every
            // frame was drawn twice at two different sizes. On the 2D path that
            // is simply double the work (4HHB: 33 ms + 40 ms a frame). On the
            // GPU path it is worse than double: the mesh cache is keyed on the
            // output size, so alternating 598 px and 1196 px REBUILT THE MESH
            // TWICE A FRAME - 91 ms a frame against about 2 for the same
            // recording at screen size.
            //
            // So the offscreen render is the only one, and the screen is shown
            // a scaled-down copy of it. That is a blit, and it costs nothing
            // next to a render.
            const blit = () => {
                if (!octx || !this.ctx || !this.canvas) return;
                const c = this.ctx;
                c.save();
                c.setTransform(1, 0, 0, 1, 0, 0);
                if (this.isTransparent) c.clearRect(0, 0, this.canvas.width, this.canvas.height);
                else {
                    c.fillStyle = this.backgroundColor || '#ffffff';
                    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
                }
                c.drawImage(target, 0, 0, this.canvas.width, this.canvas.height);
                c.restore();
            };
            const paint = () => {
                if (!octx) return;
                const wasClear = this.isTransparent;
                if (clear) this.isTransparent = true;
                octx.save();
                octx.setTransform(1, 0, 0, 1, 0, 0);
                if (this.isTransparent) octx.clearRect(0, 0, w, h);
                else { octx.fillStyle = this.backgroundColor || '#ffffff'; octx.fillRect(0, 0, w, h); }
                octx.restore();
                const prev = this._exportPxScale;
                this._exportPxScale = w / dispW;
                try { this._renderToContext(octx, w, h); } finally {
                    this._exportPxScale = prev || 1;
                    this.isTransparent = wasClear;
                }
            };

            const rendersItself = !!offscreen;
            if (zip) {
                const store = new JSZip();
                const name = this.currentObjectName || 'viewer';
                let n = 0; let pending = 0; let closed = null;
                const settle = () => {
                    if (!closed || pending) return;
                    const done = closed; closed = null;
                    this._captureStatus(`Zipping ${n} frames...`);
                    store.generateAsync({ type: 'blob' })
                        .then((blob) => done(blob, 'zip'))
                        .catch(() => done(null, 'zip'));
                };
                return {
                    width: w, height: h, fps, note, ext: 'zip', rendersItself,
                    frame: () => {
                        paint(); blit();
                        n++;
                        const at = n;
                        pending++;
                        // toBlob is asynchronous, so the zip cannot be closed
                        // until the last one has come back - hence the count.
                        target.toBlob((blob) => {
                            if (blob) store.file(`${name}_${String(at).padStart(4, '0')}.png`, blob);
                            pending--;
                            settle();
                        }, 'image/png');
                    },
                    cancel: () => { closed = null; },
                    finish: (done) => { closed = done; settle(); },
                };
            }
            if (gif) {
                const shots = [];
                const gctx = octx || source.getContext('2d');
                return {
                    width: w, height: h, fps, note, ext: 'gif', rendersItself,
                    frame: () => {
                        if (shots.length >= LIM.maxFrames) return;
                        if (octx) { paint(); blit(); } else this.render('capture');
                        shots.push(gctx.getImageData(0, 0, w, h).data);
                    },
                    cancel: () => { shots.length = 0; },
                    finish: (done) => {
                        if (!shots.length) { done(null); return; }
                        // Encoding a few hundred megapixels blocks the tab, so
                        // the status line is set BEFORE it starts rather than
                        // after, or the only sign of life is a frozen page.
                        this._captureStatus(`Encoding ${shots.length} GIF frames...`);
                        setTimeout(() => {
                            const blob = window.py2dmolGif(shots, { width: w, height: h,
                                colors: Math.max(8, Math.min(256, Number(o.colors) || 256)),
                                transparent: clear,
                                delayCs: Math.max(2, Math.round(100 / fps)) });
                            shots.length = 0;
                            done(blob, 'gif');
                        }, 0);
                    },
                };
            }

            // MANUAL CAPTURE. captureStream(fps) samples the canvas on its own
            // clock AND accepts requestFrame, so every rendered frame went in
            // twice over: a 6-frame trajectory came out a 12-frame video, twice
            // the length the panel promised. With 0 the stream produces exactly
            // the frames it is handed. Chrome, Firefox and Safari all take it;
            // if one does not, the old behaviour is the fallback.
            let stream;
            try { stream = target.captureStream(0); }
            catch (e) { stream = target.captureStream(fps); }
            const bits = Math.max(1, Math.min(80, Number(o.mbps) || 5)) * 1000000;
            let rec;
            try {
                rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: bits });
            } catch (err) {
                try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
                return null;
            }
            const chunks = [];
            let onDone = null;
            rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
            rec.onstop = () => {
                try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
                if (onDone) {
                    onDone(chunks.length ? new Blob(chunks, { type: fmt.mime }) : null, fmt.ext);
                }
            };
            // STARTED ON THE FIRST FRAME, not before it. A recorder started
            // while the canvas already holds the opening frame captures that
            // state as a frame of its own, so a 6-frame trajectory came out 7
            // frames long - the first one twice.
            let started = false;
            const begin = () => { if (!started) { started = true; rec.start(100); } };
            const track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
            return {
                width: w, height: h, fps, note, ext: fmt.ext, rendersItself,
                frame: () => {
                    // The composite path (a scatter plot beside the structure)
                    // has its own canvas and is drawn by the recorder, so there
                    // is nothing to render here.
                    if (octx) { paint(); blit(); } else if (!o.sourceCanvas) {
                        this.render('capture');
                    }
                    begin();
                    // captureStream samples the canvas on its own clock;
                    // nudging it where supported keeps one rendered frame to
                    // one video frame.
                    if (track && track.requestFrame) {
                        try { track.requestFrame(); } catch (e) { /* optional */ }
                    }
                },
                cancel: () => {
                    onDone = null;
                    try { rec.stop(); } catch (e) { /* already stopped */ }
                },
                finish: (done) => {
                    onDone = done;
                    if (!started) { done(null, fmt.ext); return; }   // nothing was ever handed over
                    // let the last frame land in the stream before closing
                    setTimeout(() => { try { rec.stop(); } catch (e) { /* stopped */ } }, 1000 / fps);
                },
            };
        }

        /**
         * WHAT THESE SETTINGS WILL PRODUCE, in the panel's own words, before
         * anything is written. The Image row shows its pixel size beside the
         * dpi; this says the same for a recording, where the size depends on
         * the format as well as the menu (a GIF is capped, and clamped to 20
         * fps) and nothing else in the row would show it.
         */
        _describeCapture() {
            if (!this._savePanel || this._captureBusy) return;
            const o = this.captureOpts();
            const lines = [];
            // THE IMAGE, in the same box as everything else. Its pixel size
            // used to sit inline on its own row, which is a second place for
            // the kind of thing this box exists to hold - and the row is a
            // format, a dpi and two buttons already.
            const dispW = this.displayWidth
                || parseInt(this.canvas && this.canvas.style.width) || 0;
            const dispH = this.displayHeight
                || parseInt(this.canvas && this.canvas.style.height) || 0;
            if (o.format === 'png') {
                const k = o.dpi / 96;
                lines.push(`PNG ${Math.round(dispW * k)}x${Math.round(dispH * k)}`
                    + ` \u00b7 ${o.dpi} dpi`);
            } else {
                // A VECTOR HAS NEITHER. No pixels to count and no dpi to count
                // them at - it is resolution-independent, which is the reason
                // to pick it - so saying "598x598 at 96 dpi" described a
                // property the file does not have.
                lines.push(`${o.format === 'svgz' ? 'SVG.gz' : 'SVG'} \u00b7 vector`);
            }
            const fmt = this.videoFormatOf(o.container);
            if (!fmt || !this._savePanel.querySelector('#saveVideoFormat')) {
                this._captureStatus(lines.join('\n'));
                return;
            }
            const sizes = this.videoSizes();
            const z = sizes.find((q) => q.scale === Number(o.scale)) || sizes[0];
            const gif = fmt.id === 'gif';
            const zip = fmt.id === 'zip';
            const LIM = this.constructor.GIF_LIMITS;
            const fps = Math.min(o.fps, gif ? LIM.maxFps : 60);
            // Images are sized by the dpi above, not by the Size menu - the
            // line has to say the size the sink will actually use.
            let w = z ? z.w : 0; let h = z ? z.h : 0;
            if (zip) {
                const k = (o.dpi || 200) / 96;
                w = Math.round(dispW * k); h = Math.round(dispH * k);
            }
            if (gif && Math.max(w, h) > LIM.maxPx) {
                const f = LIM.maxPx / Math.max(w, h);
                w = 2 * Math.round(w * f / 2); h = 2 * Math.round(h * f / 2);
            }
            const bits = [`${fmt.label} ${w}x${h}`];
            lines.push('');
            // WHAT THIS COMBINATION WILL ACTUALLY PRODUCE. The four sources
            // differ in who sets the length, so the line has to work it out
            // rather than repeat the boxes: on F and FR the trajectory decides
            // and the seconds are DERIVED (N frames at the chosen rate); on R
            // and RF the seconds decide and the frame count is derived. Saying
            // "6s" over a recording whose length the trajectory fixes is the
            // kind of small lie that makes a panel untrustworthy.
            const obj2 = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const nTraj = (obj2 && obj2.frames) ? obj2.frames.length : 0;
            const src = o.source || '';
            const led = (src === 'F' || src === 'FR') && nTraj > 1;
            if (!zip) {
                const n = led ? nTraj : Math.max(2, Math.round(o.seconds * fps));
                const secs = led ? (nTraj / fps) : o.seconds;
                bits.push(`${n} frames`, `${(Math.round(secs * 10) / 10)}s at ${fps} fps`);
                if (src === 'R' || src === 'FR' || src === 'RF' || src === 'DR') {
                    const t = Math.max(1, Math.min(10, o.rotations || 1));
                    bits.push(`${t} turn${t === 1 ? '' : 's'}`);
                }
                if (src === 'RF' && nTraj > 1) bits.push(`${nTraj} model frames fitted`);
            }
            if (zip) {
                // one per trajectory frame where the trajectory sets the
                // length, and the count where it does not
                const n = led ? `${nTraj} PNGs, one per frame`
                    : `${o.frames || 36} PNGs`;
                bits.push(n, `${o.dpi} dpi`);
            } else if (gif) {
                bits.push(`${o.colors} colours`, 'transparent');
            } else {
                bits.push(`${o.mbps} Mbps`);
            }
            lines[lines.length - 1] = bits.join(' \u00b7 ');
            this._captureStatus(lines.join('\n'));
        }

        /** A job is running: nothing else may start until it is done. */
        _syncCaptureButtons() {
            if (!this._savePanel) return;
            const busy = !!this._captureBusy;
            for (const b of this._savePanel.querySelectorAll('button')) {
                b.disabled = busy;
                b.style.opacity = busy ? '0.45' : '';
            }
        }

        /**
         * EVERYTHING THE CAPTURE PANEL HAS TO SAY, in one line inside it.
         *
         * It used to talk through the page's status line: "Recording
         * rotation... 40%", then "Turn exported to ...", from a panel that had
         * closed itself when the recording started - so the feedback for an
         * action appeared somewhere else, under whatever the loader said last,
         * and on the embedded viewer there is no status line at all. One box,
         * at the foot of the panel that started the job.
         *
         * The page's status line is still written when there is no panel open
         * (the shift-click shortcut, a Python-driven save), because then it is
         * the only place there is.
         */
        _captureStatus(text, isError) {
            this._captureNote = text ? { text, error: !!isError } : null;
            const box = this._savePanel
                && this._savePanel.querySelector('[data-info]');
            if (box) {
                box.textContent = text || '';
                box.style.color = isError ? '#b91c1c' : '#6b7280';
                return;
            }
            if (typeof setStatus === 'function') setStatus(text, !!isError);
        }

        /** One place that turns a finished recording into a file on disk. */
        _deliverVideo(blob, ext, what, detail) {
            this._captureBusy = false;
            // THE PANEL IS STILL OPEN, so the view goes back to being held. The
            // record button lifts the pause to let the recorder drive its own
            // frames, and the recorders hand auto-rotate back when they finish
            // - so the structure started spinning again the moment a recording
            // ended, under a panel whose whole job is to hold it still while
            // the next take is set up.
            if (this._savePanel) this._pauseForSavePanel();
            if (!blob) {
                this._captureStatus('No video data recorded', true);
                return;
            }
            const filename = this._generateFilename(this.currentObjectName, ext);
            this._triggerDownload(blob, filename);
            const mb = (blob.size / 1048576).toFixed(1);
            this._captureStatus(`Saved ${what.toLowerCase()}: ${detail}, ${mb} MB`);
            if (this._savePanel) this._syncCaptureButtons();
        }

        saveImage(opts) {
            const o = opts || {};
            // PNG unless asked otherwise. The panel offers SVG alongside it
            // everywhere except in Draw mode, where the look is made of
            // sub-pixel pencil and translucent stains and PNG is simply what it
            // is (see the panel for the argument).
            const format = o.format || 'png';
            const dpi = Math.max(36, Math.min(1200, Number(o.dpi)
                || this.constructor.CAPTURE_DEFAULTS.dpi));

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
                            this._captureStatus('PNG export failed', true);
                            return;
                        }
                        const filename = this._generateFilename(objectName, 'png');
                        this._triggerDownload(blob, filename);
                        this._captureStatus(`Saved PNG: ${out.width}x${out.height}, `
                            + `${Math.round(k * 96)} dpi, `
                            + `${(blob.size / 1048576).toFixed(1)} MB`);
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
                        this._captureStatus(`Saved ${filename}`);
                    }).catch(() => this._downloadSvg(svgString, objectName));
                    restore();
                    return;
                }

                this._downloadSvg(svgString, objectName);
                restore();
            } catch (e) {
                restore();
                console.error('Failed to export image:', e);
                this._captureStatus(`Error exporting image: ${e.message}`, true);
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
            const seconds = Math.max(1, Math.min(60, Number(o.seconds) || 12));

            if (typeof MediaRecorder === 'undefined' || !this.canvas
                || !this.canvas.captureStream) {
                this._captureStatus('Video recording is not supported in this browser.', true);
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
            // ASKED FOR, NOT INFERRED. The panel offers Draw and Draw+Rotate as
            // separate things to record; before that this read whatever
            // auto-rotate happened to be, so which of the two you got was a
            // side effect of a switch somewhere else on the page.
            const turning = (o.spin === undefined) ? !!this.autoRotate : !!o.spin;
            this.autoRotate = false;
            this._drawR0 = R0;
            this._drawWasAuto = turning;

            // the shared sink: format, size and bitrate come from the panel
            const sink = this._makeVideoSink(o);
            if (!sink) {
                this._endDrawingVideo(null);
                this._captureStatus('Failed to start recording.', true);
                return;
            }
            const fps = sink.fps;                 // clamped for GIF - see the turn
            const N = (o.container === 'zip')
                ? Math.max(2, Math.min(600, Number(o.frames) || 36))
                : Math.max(2, Math.round(seconds * fps));
            // A beat of the finished picture at the end, so the file does not
            // stop on the frame the last change landed in.
            const TAIL = Math.round(fps * 0.6);

            let i = 0;
            const tick = () => {
                if (i > N + TAIL) {
                    sink.finish((blob, ext) => {
                        this._endDrawingVideo(null);
                        this._deliverVideo(blob, ext, 'Drawing',
                            `${N + TAIL} frames, ${seconds}s at ${fps}fps, `
                            + `${sink.width}x${sink.height}${sink.note}`);
                    });
                    return;
                }
                // Past N the run is over; the tail frames hold the finished
                // painting, which is where the animation ends on screen too.
                this._drawAnim = this._drawAnimAt(Math.min(1, i / N));
                if (turning) {
                    this.viewerState.rotation = multiplyMatrices(
                        rotationMatrixY((2 * Math.PI * i) / N), R0);
                }
                sink.frame();          // renders, at the size being recorded
                if (i % fps === 0) {
                    this._captureStatus(
                        `Recording drawing... ${Math.round((100 * i) / (N + TAIL))}%`);
                }
                i++;
                this._drawTimer = setTimeout(tick, 1000 / fps);
            };
            tick();
        }

        _endDrawingVideo(stream) {
            // whatever happened, the panel is free again
            this._captureBusy = false;
            if (this._savePanel) this._syncCaptureButtons();
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
            const seconds = Math.max(1, Math.min(60, Number(o.seconds) || 6));

            if (typeof MediaRecorder === 'undefined' || !this.canvas || !this.canvas.captureStream) {
                this._captureStatus('Video recording is not supported in this browser.', true);
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

            // FORMAT, SIZE AND BITRATE ARE THE PANEL'S, not this recorder's:
            // see _makeVideoSink, which all three recorders share.
            const sink = this._makeVideoSink(o);
            if (!sink) {
                this._endRotationVideo(R0, wasAuto, null);
                this._captureStatus('Failed to start recording.', true);
                return;
            }
            // FRAMES FROM THE SINK'S fps, NOT THE PANEL'S. A GIF is clamped to
            // 20 - its delays are whole centiseconds - and counting frames at
            // the asked-for 30 would then stretch one turn into one and a half.
            const fps = sink.fps;
            // A ZIP OF IMAGES IS COUNTED, NOT TIMED: its own control says how
            // many PNGs a turn should come to.
            const N = (o.container === 'zip')
                ? Math.max(2, Math.min(600, Number(o.frames) || 36))
                : Math.max(2, Math.round(seconds * fps));

            // HOW MANY TURNS, over however many frames this recording has.
            const turns = Math.max(1, Math.min(10, Number(o.rotations) || 1));
            const step = (2 * Math.PI * turns) / N;
            // ...AND THE TRAJECTORY, FITTED INTO IT. RF says "turn for this
            // long and play the frames inside that": a trajectory longer than
            // the recording is sampled, a shorter one holds each frame for
            // several video frames. The frame is loaded WITHOUT rendering -
            // the sink renders, once, at the size it is recording.
            const object = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const nFrames = (o.playFrames && object && object.frames)
                ? object.frames.length : 0;
            let i = 0;
            const tick = () => {
                if (nFrames > 1) {
                    const at = Math.min(nFrames - 1, Math.floor((i * nFrames) / N));
                    if (at !== this.currentFrame) {
                        this.currentFrame = at;
                        this._loadFrameForPlayback(at);
                        this.lastRenderedFrame = at;
                    }
                }
                if (i >= N) {
                    sink.finish((blob, ext) => {
                        this._endRotationVideo(R0, wasAuto, null);
                        this._deliverVideo(blob, ext, 'Turn',
                            `${N} frames, ${seconds}s at ${sink.fps}fps, `
                            + `${turns} turn${turns === 1 ? '' : 's'}`
                            + (nFrames > 1 ? `, ${nFrames} model frames` : '')
                            + `, ${sink.width}x${sink.height}${sink.note}`
                            + ', loops seamlessly');
                    });
                    return;
                }
                this.viewerState.rotation = multiplyMatrices(rotationMatrixY(i * step), R0);
                sink.frame();          // renders, at the size being recorded
                if (i % sink.fps === 0) {
                    this._captureStatus(`Recording turn... ${Math.round((100 * i) / N)}%`);
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
            // whatever happened, the panel is free again
            this._captureBusy = false;
            if (this._savePanel) this._syncCaptureButtons();
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
            // A MODE CHANGE CHANGES WHAT CAN BE RECORDED, so the open panel is
            // rebuilt rather than thrown away. Switching Rotate on with Capture
            // already open used to close the panel: the user had turned on the
            // very thing they wanted to record and the panel vanished, so they
            // had to open it again to find the button that had just appeared.
            if (this._savePanel && !this._captureBusy) this._rebuildSavePanel();
        }

        /**
         * THE CAPTURE PANEL: two blocks and a line that says what they will
         * make. A grid of name, settings, button:
         *
         *   Img  Type[PNG] DPI[200]                          [Save]
         *   ------------------------------------------------------
         *   Vid  Type[WebM] Rec[FR]                           [ ● ]
         *        Sec[6] FPS[30] Rot[1] Mbps[12] Size[1]
         *   ------------------------------------------------------
         *   PNG 1246x1246 - 200 dpi
         *   WebM 598x598 - 20 frames - 2s at 10 fps - 1 turn - 12 Mbps
         *
         * WHAT CHANGED AND WHY. It used to be one row per OUTPUT, each ending
         * in its own button and each carrying its own copy of the settings - so
         * the frame rate for a turn and the frame rate for a drawing were
         * different controls holding the same number, the trajectory row had no
         * settings at all (30 fps and 20 Mbps, decided in the recorder and
         * shown nowhere), and nothing anywhere said what resolution any of it
         * came out at.
         *
         * WHAT IS OFFERED IS WHAT CAN BE MADE. Formats are asked of the browser
         * and of the page (videoFormats), sizes of the canvas (videoSizes), and
         * a source appears only where there is something to record: a turn
         * needs Rotate, a drawing needs Draw, frames need a trajectory. With
         * none of them there is no video row at all.
         *
         * WHICH CONTROLS SHOW follows from one question - who decides how long
         * the recording is (see the sources) - and from the format. See
         * syncVideo; the info line describes the answer rather than repeating
         * the boxes.
         */
        _toggleSaveImagePanel(anchorEl) {
            // OPEN MEANS BUILT, FRESH. The panel used to be built once and then
            // shown and hidden, so everything it reads off the viewer - which
            // sources can be recorded, how big the canvas is, whether the
            // object has frames - was whatever was true the first time it was
            // opened. Loading a trajectory with the panel already made left it
            // with no Frames button until the mode happened to change and threw
            // it away. It is a dozen elements; building it is free.
            if (this._savePanel) {
                this._savePanel.remove();
                this._savePanel = null;
                if (anchorEl) anchorEl.setAttribute('aria-expanded', 'false');
                this._resumeFromSavePanel();
                return;
            }
            this._saveAnchor = anchorEl || this._saveAnchor;
            this._buildSavePanel(this._saveAnchor);
        }

        /**
         * Same panel, same options, current numbers - see
         * _updateCanvasDimensions.
         *
         * @param {boolean} fresh - drop whatever the line was saying. A resize
         *        changes every size in it, so a result from before the resize
         *        ("Saved ... 3738x3738") is describing a file made at a size
         *        the panel no longer offers.
         */
        _rebuildSavePanel(fresh) {
            if (!this._savePanel) return;
            // A RESULT SURVIVES THE REBUILD, A DESCRIPTION DOES NOT. "Saved
            // turn: ... 0.1 MB" is news and has to stay; "WebM 598x598" is a
            // description of settings against a canvas that has just changed
            // size, and restoring it would put the old numbers back over the
            // new ones the rebuild exists to produce.
            const note = fresh ? null : this._captureNote;
            const keep = note && !/^(WebM|MP4|GIF|PNG|SVG|Images)\b.*\u00b7/.test(note.text);
            this._savePanel.remove();
            this._savePanel = null;
            this._buildSavePanel(this._saveAnchor);
            if (keep) this._captureStatus(note.text, note.error);
        }

        _buildSavePanel(anchorEl) {
            const obj = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            // WHAT THERE IS TO RECORD, INCLUDING THE COMBINATIONS. A
            // trajectory can play while the view turns, and a drawing can build
            // up while it turns - the recorders could always do both, but the
            // panel had one button per source and no way to say "both", so the
            // combination depended on whether Rotate happened to be on when you
            // pressed Frames. It is a choice now, and pressing record cannot
            // mean two things.
            // FOUR WAYS TO PUT A TRAJECTORY AND A TURN IN ONE FILE, and the
            // difference between them is WHO DECIDES HOW LONG IT IS:
            //
            //   F    the frames, played once, not turning. The trajectory
            //        decides: N frames at the chosen rate.
            //   R    a turn on the spot. You decide, in seconds.
            //   FR   frames-led. Every frame is played, once, and the rotation
            //        is fitted into however long that takes.
            //   RF   rotation-led. The turn runs for the seconds you asked for
            //        and the whole trajectory is fitted into it - so a long
            //        trajectory is sampled and a short one holds frames.
            //
            // Which controls are worth showing follows straight from that
            // column: Sec means something only where YOU set the length, so it
            // is offered for R and RF and derived for the other two.
            const spin = !!this.autoRotate;
            const hasFrames = !!(obj && obj.frames && obj.frames.length > 1);
            const sources = [];
            if (hasFrames) {
                sources.push({ id: 'F', label: 'F', spin: false, timed: false,
                    title: 'frames once' });
            }
            if (hasFrames && spin) {
                sources.push({ id: 'FR', label: 'FR', spin: true, timed: false,
                    title: 'frames once, turning' });
                sources.push({ id: 'RF', label: 'RF', spin: true, timed: true,
                    title: 'timed turn, frames fitted in' });
            }
            if (this.drawMode) {
                sources.push({ id: 'D', label: 'D', spin: false, timed: true,
                    title: 'the drawing' });
            }
            if (this.drawMode && spin) {
                sources.push({ id: 'DR', label: 'DR', spin: true, timed: true,
                    title: 'the drawing, turning' });
            }
            if (spin) {
                sources.push({ id: 'R', label: 'R', spin: true, timed: true,
                    title: 'a turn' });
            }
            // A running animation is paused while the panel is up, so what is
            // saved is the frame that was on screen when it was opened.
            if (sources.length) this._pauseForSavePanel();
            const opts = this.captureOpts();
            const formats = this.videoFormats();
            const sizes = this.videoSizes();

            // SVG is offered on the plain panel but never with a drawing up. A
            // vector file of a normal cartoon is the better artifact; a vector
            // file of the drawing is not, since that look is a pencil line a
            // fraction of a pixel wide, paint sitting off register and
            // translucent stains.
            const svgOk = !this.drawMode;

            // WRAPS. The embedded viewer's panel is 180px wide and the
            // standalone page's column is wider; a row that wraps fits both,
            // where a fixed layout has to pick one and hang out of the other.
            // ONE ROW PER SUBJECT, WRAPPING FREELY. The embedded viewer's
            // panel is 180px wide and the standalone page's column is three
            // times that: a row that wraps fits both, and the controls simply
            // take a second line where they have to. What must NOT be here is
            // anything that forces a break - a spacer with flex-grow pushed the
            // camera button to the right edge, which in the narrow panel meant
            // a line of its own with nothing on it.
            // THE SETTINGS AREA IS A GRID TOO, of equal cells. As a wrapping
            // flex line the pairs packed edge to edge at whatever width each
            // happened to be, so nothing lined up with anything above it and a
            // row of six controls read as a paragraph. Equal cells put every
            // field in a column.
            const ROW = 'display:grid; align-items:center; gap:6px;'
                + ' grid-template-columns:repeat(auto-fill, minmax(84px, 1fr));'
                + ' min-width:0;';
            // ONE SIZE FOR EVERY CONTROL, and big enough to read: two rows of
            // controls at different weights make the eye work out which number
            // belongs to which output.
            const H = 28;
            // BOX-SIZING, or a field told to fill its cell overflows it by its
            // own padding and border: 100% plus 12px of padding and 2px of
            // frame stuck 14px out of a 160px panel.
            const FIELD = `height:${H}px; font-size:12px; padding:0 4px;`
                + ' border:1px solid #d1d5db; border-radius:6px; background:#fff;'
                + ' box-sizing:border-box; flex:0 1 auto; min-width:0; max-width:100%;';
            const NUM = FIELD + ' width:52px; padding:0 6px;';
            const CAP = 'font-size:12px; color:#6b7280; flex:0 0 auto;';
            // SHORT NAMES, because the column costs the same on every row and
            // the settings beside them are what needs the width: "Image" and
            // "Video" spent 18px of a 160px panel saying what "Img" and "Vid"
            // say.
            const NAME = 'font-size:12px; font-weight:600; color:#374151;'
                + ' flex:0 0 auto; min-width:28px;';
            const BTN = `flex:0 0 auto; padding:0 8px; height:${H}px; line-height:1;`
                + ' cursor:pointer; font-size:12px; border:1px solid #d1d5db;'
                + ' border-radius:6px; background:#fff; box-sizing:border-box;';
            // THE PAGE'S OWN BUTTON, WHERE THE PAGE HAS ONE.
            //
            // These were styled inline because the two pages skin their
            // buttons differently and one class renders invisible on the
            // other - but that left Save and Turn as the only controls in the
            // viewer that do not look like the buttons beside them, which is
            // exactly what a button should not do. So the skin is LOOKED UP:
            // index.html has .btn.btn-grey.btn-small, the notebook viewer has
            // .controlButton, and both are 28px high, which is this panel's
            // height already. A page with neither keeps the inline style.
            const skin = ['btn btn-grey btn-small', 'controlButton'].find((c) => {
                try {
                    return !!document.querySelector('.' + c.trim().split(/\s+/).join('.'));
                } catch (e) { return false; }
            }) || '';
            const button = (text, title) => {
                // Only the layout is ours when the page has a skin: its height,
                // padding, border and hover are the page's business, and
                // repeating them here is how two buttons come to disagree.
                const b = el('button',
                    (skin ? 'min-width:0;' : BTN) + ' width:100%; box-sizing:border-box;', text);
                b.type = 'button';
                if (skin) b.className = skin;
                if (title) b.title = title;
                return b;
            };

            const p = document.createElement('div');
            p.id = 'savePanel';
            // A GRID, THREE COLUMNS: what the row is, what it is set to, and
            // the button that does it. Everything used to be one wrapping line
            // per row, so the button sat wherever the settings left it - at the
            // end of the line, halfway along, or on a line of its own - and
            // the two rows lined up with each other only by accident. The
            // action column is fixed at the right, so Save and the record dot
            // are always in the same place, on top of each other, whatever is
            // showing between.
            p.style.cssText = 'display:grid;'
                + ' grid-template-columns:auto minmax(0,1fr) auto;'
                + ' gap:6px 8px; align-items:center;'
                + ' box-sizing:border-box; max-width:100%;'
                + ' border:1px solid #e5e7eb; border-radius:8px; background:#fff;'
                + ' padding:8px; margin-top:6px;';

            const el = (tag, css, text) => {
                const n = document.createElement(tag);
                if (css) n.style.cssText = css;
                if (text !== undefined) n.textContent = text;
                return n;
            };
            // HOW WIDE THE PANEL WILL BE, before it is in the page. Three
            // columns fit the standalone page's 300px column and do not fit
            // the embedded viewer's 160px one - name and button take 94 of it
            // between them and leave the settings 40px, which is narrower than
            // one field. So a narrow panel puts the name and the button on one
            // line and the settings across the whole width underneath.
            // ...AND WHICH OF THE TWO SHAPES IT TAKES IS MEASURED, not guessed.
            // Three columns fit the standalone page's 300px column and do not
            // fit the embedded viewer's 160px one: name and button take 94 of
            // it between them and leave the settings 40px, narrower than one
            // field. So the rows are BUILT first and PLACED after the panel is
            // in the page and its width is a fact - three across where there is
            // room, and name-and-button over settings where there is not.
            const blocks = [];

            const row = (name) => {
                const nameEl = el('span', NAME, name);
                const controls = el('div', ROW);
                // ONE WIDTH FOR BOTH BUTTONS. Save is a word and the record
                // button is a dot, so left to themselves they were 45px and
                // 28px in a column of their own - two different buttons in the
                // same place, one above the other, not lining up with each
                // other. The column stretches them to its width, which is the
                // wider of the two.
                const action = el('div', 'display:grid; gap:6px; align-items:center;'
                    + ' justify-items:stretch;');
                blocks.push({ kind: 'row', nameEl, controls, action });
                // `appendChild` on the row still means "another control", which
                // is what every caller wants; the button column is asked for
                // by name.
                controls.action = action;
                controls.nameEl = nameEl;
                return controls;
            };
            const menu = (id, items, value, tip) => {
                const sel = el('select', FIELD);
                sel.id = id;
                if (tip) sel.title = tip;
                for (const it of items) {
                    const o = document.createElement('option');
                    o.value = String(it.value);
                    o.textContent = it.label;
                    sel.appendChild(o);
                }
                sel.value = String(value);
                return sel;
            };
            // A LABEL AND ITS FIELD ARE ONE THING. The row wraps - it has to,
            // in a 160px panel - and a bare label followed by a bare input is
            // two wrappable items, so a line break landed between them and left
            // "FPS" hanging at the end of one line with its box at the start of
            // the next. Each pair goes in a nowrap group, which wraps whole.
            // SHOWING A PAIR PUTS ITS GRID BACK. `style.display = ''` removes
            // the inline declaration - and the inline declaration is where
            // `display:grid` lives, so hiding a pair and showing it again left
            // it a plain block: the label and the field became inline
            // siblings, the field kept its width:100%, and it hung its own
            // label's width out of the panel. That is the 10-19px of overflow
            // in a 160px panel, and it appeared only after a format change.
            const show = (node, on) => {
                if (node) node.style.display = on ? 'grid' : 'none';
            };
            const pair = (labelText, forId, control, tip) => {
                const g = el('span', 'display:grid; align-items:center; gap:5px;'
                    + ' grid-template-columns:34px minmax(0,1fr);'
                    + ' min-width:0; white-space:nowrap;');
                if (labelText) {
                    const lab = el('label', CAP, labelText);
                    lab.setAttribute('for', forId);
                    if (tip) lab.title = tip;
                    g.appendChild(lab);
                } else {
                    g.style.gridTemplateColumns = 'minmax(0,1fr)';
                }
                control.style.width = '100%';
                g.appendChild(control);
                return g;
            };
            const num = (id, label, value, min, max, tip) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.id = id; inp.min = min; inp.max = max;
                inp.step = '1'; inp.value = value;
                if (tip) inp.title = tip;
                return [pair(label, id, inp, tip), inp];
            };

            // ---- IMAGE -------------------------------------------------
            // Declared with the row it belongs to: this is used while the row
            // is built, and a `let` further down the function is a temporal
            // dead zone - the panel threw before it appeared at all.
            let dpiBox = null;
            const imgRow = row('Img');
            // PNG AND SVG. The gzipped SVG went from the menu: it is the same
            // file through a compressor, every tool that opens an .svgz opens
            // an .svg, and it was a third of the width of the widest control on
            // the row for a choice nobody has to make. saveImage still writes
            // one if it is asked for by name.
            const fmtSel = menu('saveFormatSelect', svgOk
                ? [{ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG' }]
                : [{ value: 'png', label: 'PNG' }],
            (svgOk && opts.format !== 'svgz') ? opts.format : 'png', 'Image format');
            // EVERY CONTROL SAYS WHAT IT IS. A bare menu reading "PNG" is
            // only obvious while you already know what the row does, and a
            // captioned pair is also the same SHAPE as every other pair, which
            // is what makes the columns line up.
            imgRow.appendChild(pair('Type', 'saveFormatSelect', fmtSel));
            // DPI AS A LIST, not a spinner. The useful values are a short list
            // - screen, a figure, a plate - and typing 250 into a spinner is a
            // decision nobody has a reason to make. 200 is the default: a
            // 1000px canvas comes out about 2000px, which is a figure at column
            // width in print.
            const dpiSel = menu('saveDpiInput', [
                { value: 96, label: '96' }, { value: 150, label: '150' },
                { value: 200, label: '200' }, { value: 300, label: '300' },
                { value: 600, label: '600' },
            ], opts.dpi, 'Image resolution (96 = screen)');
            dpiBox = pair('DPI', 'saveDpiInput', dpiSel);
            imgRow.appendChild(dpiBox);
            // A WORD, NOT A GLYPH. The camera and the card-index emoji were
            // small, low-contrast and rendered differently on every platform -
            // and being the only pictures in a panel of words, they read as
            // decoration rather than as the buttons that do the thing.
            const okBtn = button('Save', 'Save an image');
            imgRow.action.appendChild(okBtn);
            // EVERY FRAME AS FILES IS A VIDEO FORMAT, not a button here - see
            // videoFormats. It writes the same frames the recorders drive, so
            // it belongs where the other formats are, and it records a turn or
            // a drawing as well as a trajectory now.

            const syncImg = () => {
                show(dpiBox, fmtSel.value === 'png');
                this._describeCapture();
            };
            fmtSel.addEventListener('change', syncImg);
            dpiSel.addEventListener('change', syncImg);
            syncImg();
            // ...and the dpi is the Images format's size, so the video line
            // has to follow it as well
            dpiSel.addEventListener('change', () => { if (vFmt) commit(); });

            // ---- VIDEO -------------------------------------------------
            // A LINE BETWEEN THE TWO. They are different outputs with different
            // buttons, and stacked without a break the panel read as one list
            // of controls where the Image row's dpi looked like it might apply
            // to the recording underneath it.
            const rule = () => {
                const hr = el('div', 'height:1px; background:#e5e7eb; margin:1px 0;');
                blocks.push({ kind: 'span', el: hr });
            };
            let vFmt = null; let secIn = null; let fpsIn = null;
            let mbpsIn = null; let sizeSel = null; let colorsSel = null;
            let framesIn = null; let colorsBox = null; let sizeBox = null;
            let srcSel = null; let rotIn = null;
            let vFmtBox = null; let srcBox = null;
            // ...assigned with the video row, called from the record row too:
            // what the count control means depends on WHICH source is picked.
            let syncVideo = () => {};
            let videoRow = null;
            if (sources.length && formats.length) {
                rule();
                const vRow = row('Vid');
                videoRow = vRow;
                vFmt = menu('saveVideoFormat', formats.map((f) => (
                    { value: f.id, label: f.label })), opts.container, 'Video format');
                vFmtBox = pair('Type', 'saveVideoFormat', vFmt);
                vRow.appendChild(vFmtBox);
                const [secL, sec] = num('saveSecondsInput', 'Sec', opts.seconds, 1, 60,
                    'Length in seconds');
                vRow.appendChild(secL); secIn = sec;
                const [fpsL, fps] = num('saveFpsInput', 'FPS', opts.fps, 5, 60,
                    'Frames per second');
                vRow.appendChild(fpsL); fpsIn = fps;
                // IMAGES ARE COUNTED, NOT TIMED. A zip of PNGs has no duration
                // and no frame rate - what you want to say is how many of them
                // - so Sec and FPS give way to one number. On the trajectory
                // source even that is decided for you: one PNG per frame.
                const [frL, fr] = num('saveFrameCount', 'Count', opts.frames || 36,
                    2, 600, 'How many images');
                vRow.appendChild(frL); framesIn = fr;
                // HOW MANY TURNS. One is the usual answer, but a trajectory
                // fitted into a single revolution can be too slow to read - two
                // or three turns over the same frames give the eye a second
                // look at every angle.
                const [rotL, rot] = num('saveRotations', 'Rot', opts.rotations || 1,
                    1, 10, 'Full turns');
                vRow.appendChild(rotL); rotIn = rot;
                const [mbL, mb] = num('saveMbpsInput', 'Mbps', opts.mbps, 1, 80,
                    'Bitrate ceiling');
                vRow.appendChild(mbL); mbpsIn = mb;
                // GIF'S OWN CONTROLS, and only where GIF can be written at
                // all: on the notebook page there is no encoder, so these are
                // not hidden controls, they are absent ones.
                // A GIF is a palette, not a bitrate: the size of the file is
                // decided by how many colours it is allowed and how many
                // pixels, so those are the two things to offer - and Mbps,
                // which means nothing here, goes away rather than sitting
                // greyed out pretending to be part of the format.
                const gifOk = formats.some((f) => f.id === 'gif');
                if (gifOk) {
                // ...NAMED LIKE THE REST OF THE ROW. Sec, FPS, Mbps and Size
                // all say what they are in front of the value; "256 col"
                // repeated the unit inside every option instead, which is the
                // only control on the row that spelled itself out four times.
                colorsSel = menu('saveGifColors', [
                    { value: 256, label: '256' },
                    { value: 128, label: '128' },
                    { value: 64, label: '64' },
                    { value: 32, label: '32' },
                ], opts.colors || 256, 'GIF palette size');
                colorsBox = pair('Color', 'saveGifColors', colorsSel);
                vRow.appendChild(colorsBox);
                }
                if (sizes.length) {
                    // ...WITH ITS NAME IN FRONT OF IT, like Sec and FPS. "1x"
                    // on its own is a multiplier of nothing stated.
                    sizeSel = menu('saveVideoSize', sizes.map((z) => (
                        { value: z.scale, label: z.label })), opts.scale,
                    'Recording size');
                    sizeBox = pair('Size', 'saveVideoSize', sizeSel);
                    vRow.appendChild(sizeBox);
                }
                syncVideo = () => {
                    const gif = vFmt.value === 'gif';
                    const zip = vFmt.value === 'zip';
                    const LIM = this.constructor.GIF_LIMITS;
                    // IMAGES TAKE THEIR SIZE FROM THE DPI ABOVE, so the Size
                    // menu goes: two controls for one resolution is how they
                    // come to disagree. There is no bitrate in a PNG either.
                    show(sizeBox, !zip);
                    // ONE ROW, TWO FORMATS, and only the controls that mean
                    // something for the one that is picked. What is shared -
                    // how long, how fast, how big - stays put, so switching
                    // format does not move the rest of the row about.
                    show(mbL, !(gif || zip));
                    // ...and the frame rate is the one control every source
                    // needs: it is how fast the file plays, whoever decided how
                    // many frames there are. Images have no rate at all.
                    show(fpsL, !zip);
                    // THE COUNT IS FOR A TURN OR A DRAWING, which have no
                    // frames of their own to follow - it says how many PNGs to
                    // write over one revolution. A trajectory HAS frames, and
                    // then the answer is one image per frame and there is
                    // nothing to ask. Reading it off the picked source rather
                    // than off the list is the difference between "Frames: 36"
                    // sitting beside a Frames recording, saying something that
                    // is not true of it, and not being there at all.
                    const pickedId = srcSel ? srcSel.value : (sources[0] || {}).id;
                    const src = sources.find((x) => x.id === pickedId) || sources[0] || {};
                    // SEC IS ONLY A CONTROL WHERE YOU SET THE LENGTH. On F and
                    // FR the trajectory does: the file is N frames long at the
                    // rate you chose, and a seconds box there would be a number
                    // that either does nothing or silently drops frames.
                    const timed = !!src.timed;
                    show(secL, timed && !zip);
                    // ...and a rotation count only where something rotates
                    const turns = !!src.spin;
                    show(rotL, turns);
                    // THE IMAGE COUNT is for a recording with no frames of its
                    // own to follow - a turn or a drawing. A trajectory has
                    // them, and then the answer is one image per frame.
                    const counted = zip && (pickedId === 'R' || pickedId === 'D'
                        || pickedId === 'DR');
                    show(frL, counted);
                    show(colorsBox, gif);
                    // A GIF'S LIMITS ARE APPLIED TO THE CONTROLS, not just to
                    // the recording. The sink clamps either way, but a panel
                    // reading 30 fps and 1194x1194 over a file that came out
                    // 20 fps and 1024 wide is the panel lying about what it is
                    // about to make. Whole-centisecond delays are what cap the
                    // rate; memory is what caps the size, since every frame is
                    // held until the palette is known.
                    fpsIn.max = gif ? LIM.maxFps : 60;
                    if (gif && Number(fpsIn.value) > LIM.maxFps) fpsIn.value = LIM.maxFps;
                    if (sizeSel) {
                        let fallback = null;
                        for (const opt of sizeSel.options) {
                            const z = sizes.find((q) => String(q.scale) === opt.value);
                            const tooBig = gif && z && Math.max(z.w, z.h) > LIM.maxPx;
                            opt.disabled = !!tooBig;
                            if (!tooBig) fallback = opt.value;
                        }
                        const cur = sizeSel.selectedOptions[0];
                        if (cur && cur.disabled && fallback !== null) sizeSel.value = fallback;
                    }
                };
                if (sizeSel) sizeSel.addEventListener('change', syncVideo);
                fpsIn.addEventListener('change', syncVideo);
                vFmt.addEventListener('change', syncVideo);
                syncVideo();
            }

            // ---- RECORD ------------------------------------------------
            const commit = () => {
                this._captureOpts = Object.assign(this.captureOpts(), readVideo(), {
                    format: fmtSel.value, dpi: Number(dpiSel.value) || 200,
                });
                this._describeCapture();
            };
            // WHAT THE CONTROLS SAY, AND WHAT WAS ALREADY SET FOR THE REST.
            //
            // A control that is not on the row has no value to read, and the
            // fallbacks used to be written out here as numbers - which meant a
            // panel opened with nothing recordable (no video row at all) wrote
            // those numbers over the settings: the bitrate came back 5 where
            // the default is 12, because 5 was the literal in this function.
            // Read from the stored options instead, so an absent control
            // leaves its setting alone.
            const readVideo = () => {
                const was = this.captureOpts();
                return {
                seconds: secIn ? Number(secIn.value) || was.seconds : was.seconds,
                fps: fpsIn ? Number(fpsIn.value) || was.fps : was.fps,
                mbps: mbpsIn ? Number(mbpsIn.value) || was.mbps : was.mbps,
                container: vFmt ? vFmt.value : was.container,
                scale: sizeSel ? Number(sizeSel.value) || was.scale : was.scale,
                colors: colorsSel ? Number(colorsSel.value) || was.colors : was.colors,
                // the Images format renders at the Image row's resolution, and
                // is counted rather than timed
                dpi: Number(dpiSel.value) || was.dpi,
                frames: framesIn ? Number(framesIn.value) || was.frames : was.frames,
                rotations: rotIn ? Number(rotIn.value) || was.rotations : was.rotations,
                // WHICH OF THE FOUR, so the description can work out who sets
                // the length. It used to be written only when record was
                // pressed, so until then the line described the last thing
                // recorded rather than the thing on the row.
                //
                // ...AND ONLY WHERE THERE WAS A CHOICE. With one source there
                // is no menu, and writing that single option down made it look
                // chosen: open the panel with Rotate off and the only source is
                // F, so switching Rotate on afterwards kept F instead of
                // landing on FR, which is what having both on means.
                source: srcSel ? srcSel.value : (was.source || ''),
                };
            };
            // WRITTEN BACK ON EVERY CHANGE, not read at the moment a button is
            // pressed. The panel is rebuilt whenever the canvas is resized (see
            // _updateCanvasDimensions), and a value that lived only in the DOM
            // would be lost with it - so it lives in _captureOpts and the DOM
            // is filled from there.
            for (const c of [fmtSel, dpiSel, vFmt, secIn, fpsIn, mbpsIn, sizeSel,
                colorsSel, framesIn, rotIn]) {
                if (c) c.addEventListener('change', commit);
            }
            commit();

            // NO SECOND NAME FOR THE SAME THING. This row used to be called
            // Record, under a row called Video, which read as two subjects;
            // it is the same one - the settings above, the button that uses
            // them here - so the block is named once and this row lines its
            // buttons up under them. With nothing recordable it is the only
            // video row there is, and then it does say Video.
            // THE RECORD BUTTONS GO ON THE VIDEO ROW, at the end of the
            // controls they use. They had a row of their own called Record,
            // which is a second name for one subject and, in a panel of
            // wrapping rows, a line break nobody asked for. The row wraps on
            // its own when it has to, and the button follows the settings
            // instead of sitting under them.
            // NO ROW WHERE THERE IS NOTHING TO RECORD. A Vid row whose only
            // content is "you cannot" is a rule, a name and a sentence spent
            // on an absence - and the panel is rebuilt whenever Rotate or Draw
            // is switched on or a trajectory arrives, so the row appears the
            // moment it can do something. The exception is a browser with no
            // recorder at all: video is missing there for a reason worth
            // saying, since nothing the user does will bring it back.
            const recRow = videoRow || (!formats.length
                ? (() => { rule(); return row('Vid'); })() : null);
            if (!recRow) {
                // nothing to record - the row is not there at all
            } else if (!formats.length) {
                recRow.appendChild(el('span', CAP, 'No video recorder in this browser'));
            } else {
                // ONE BUTTON, AND A MENU WHERE THERE IS A CHOICE. A row of
                // buttons reading "Rotate", "Frames", "Draw+Rotate" is a row of
                // sentences; the button is the verb and belongs to the row's
                // controls, so what to record joins them as one more menu and
                // the button is the red dot it always wanted to be.
                if (sources.length > 1) {
                    // BOTH, WHEN BOTH ARE ON. Switching Rotate on with a
                    // trajectory loaded is a request to see it turning, so the
                    // combination is what record means unless something else
                    // was picked.
                    const preferred = sources.find((x) => x.id === 'FR')
                        || sources.find((x) => x.id === 'DR') || sources[0];
                    const want = sources.some((x) => x.id === opts.source)
                        ? opts.source : preferred.id;
                    srcSel = menu('saveVideoSource', sources.map((x) => (
                        { value: x.id, label: x.label })), want, 'What to record');
                    // NEXT TO THE FORMAT, at the head of the row, because these
                    // two are the controls that decide which of the others are
                    // there at all. Appended at the end - where it was built -
                    // it sat AFTER the controls it governs, so picking a source
                    // moved the very menu you had just used: hiding Sec pulls
                    // everything to its right two fields leftwards. The two
                    // choosers stay put now and only the tail rearranges.
                    srcBox = pair('Rec', 'saveVideoSource', srcSel);
                    recRow.insertBefore(srcBox, vFmtBox ? vFmtBox.nextSibling : null);
                }
                const recBtn = button('\u25CF', '');
                recBtn.dataset.rec = '1';
                recBtn.style.color = '#ef4444';
                const pick = () => sources.find((x) => x.id
                    === (srcSel ? srcSel.value : sources[0].id)) || sources[0];
                const syncRec = () => {
                    const src = pick();
                    recBtn.title = 'Record ' + (src.title || src.label);
                };
                if (srcSel) {
                    srcSel.addEventListener('change', syncRec);
                    // ...and the row follows the source, and so does what the
                    // panel remembers: without the commit the description went
                    // on describing whichever source was last RECORDED, so
                    // picking F still read "1 turn" from the FR before it.
                    srcSel.addEventListener('change', () => { syncVideo(); commit(); });
                }
                syncRec();
                recBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    if (this._captureBusy) return;
                    // EVERY FAILURE HAS TO COME BACK HERE. Marking the panel
                    // busy and then throwing on the way to the recorder leaves
                    // every button disabled with no recording running and
                    // nothing said - which is how a one-word mistake in the
                    // sink (a missing `const zip`) read as "Capture, Rotate,
                    // Turn does not record" and as "the GIF path is broken",
                    // both at once, for the rest of the session.
                    try {
                        const src = pick();
                        const vo = Object.assign(readVideo(), { spin: src.spin });
                        this._captureOpts = Object.assign(this.captureOpts(), vo,
                            { source: src.id });
                        // THE PANEL STAYS UP while it records. It used to close
                        // itself, which put the progress and the result
                        // somewhere the user was no longer looking - and left
                        // no way to see that anything was happening at all.
                        // The recorders drive their own frames, so the pause
                        // the panel put on is lifted without resuming anything.
                        this._uiPaused = false;
                        this._captureBusy = true;
                        this._syncCaptureButtons();
                        this._captureStatus('Recording...');
                        // Recording a drawing RESTARTS it from blank paper, so
                        // pressing record part way through a run still gives a
                        // whole one. A turn has no beginning, so it does not.
                        if (src.id === 'D' || src.id === 'DR') this.saveDrawingVideo(vo);
                        else if (src.id === 'R' || src.id === 'RF') {
                            // RF is the turn, with the trajectory fitted into
                            // it - the rotation recorder already drives its own
                            // frames on a clock, which is exactly what "fit the
                            // frames into this many seconds" needs.
                            this.saveRotationVideo(Object.assign({}, vo,
                                { playFrames: src.id === 'RF' }));
                        } else this.toggleRecording(vo);
                    } catch (err) {
                        this._captureBusy = false;
                        this._syncCaptureButtons();
                        this._captureStatus('Could not record: ' + err.message, true);
                        throw err;      // ...and still say so in the console
                    }
                });
                // ...AND THE DOT SITS WITH THEM, not at the end of the row.
                // At the end it was the one control that moved every time: the
                // fields to its left appear and disappear with the source and
                // the format, so it slid about and, in a narrow panel, hopped
                // between lines - and it is the one control you aim at. Format,
                // source, go: the three that are always there, always in the
                // same place, with the settings they govern behind them.
                recRow.action.appendChild(recBtn);
            }

            okBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const io = { format: fmtSel.value, dpi: Number(dpiSel.value) || 200 };
                this._captureOpts = Object.assign(this.captureOpts(), io);
                this.saveImage(io);
            });

            // ...AND ONE LINE THAT SAYS WHAT IS HAPPENING. Everything the
            // capture path has to say goes here - what these settings will
            // produce, how far a recording has got, what was written - instead
            // of into the page's status line, which is somewhere else, under
            // whatever the loader said last, and does not exist at all in the
            // embedded viewer.
            // ...BEHIND A LINE OF ITS OWN. It describes both outputs and it
            // reports whatever was last written, so sitting flush under the
            // Video row it read as another of that row's readouts - a size for
            // the recording rather than a size for the image above it too.
            rule();
            const info = el('div', 'font-size:11px; color:#6b7280; line-height:1.35;'
                + ' overflow-wrap:anywhere; min-width:0; white-space:pre-line;');
            info.dataset.info = '1';
            blocks.push({ kind: 'span', el: info });

            // ONE PASS OVER THE BLOCKS, in the shape the width allows.
            const place = (narrow) => {
                while (p.firstChild) p.removeChild(p.firstChild);
                for (const b of blocks) {
                    if (b.kind === 'span') {
                        b.el.style.gridColumn = '1 / -1';
                        p.appendChild(b.el);
                        continue;
                    }
                    if (narrow) {
                        b.controls.style.gridColumn = '1 / -1';
                        p.appendChild(b.nameEl);
                        p.appendChild(el('span', ''));   // the empty middle cell
                        p.appendChild(b.action);
                        p.appendChild(b.controls);
                    } else {
                        b.controls.style.gridColumn = '';
                        p.appendChild(b.nameEl);
                        p.appendChild(b.controls);
                        p.appendChild(b.action);
                    }
                }
            };
            place(false);

            const anchorRow = (anchorEl && (anchorEl.closest('.toolbar-row')
                || anchorEl.parentElement))
                || (this.controlsContainer || document.body);
            anchorRow.insertAdjacentElement('afterend', p);
            // ...and now its width is a fact rather than a guess
            if (p.clientWidth && p.clientWidth < 260) place(true);
            this._savePanel = p;
            if (anchorEl) {
                anchorEl.setAttribute('aria-controls', 'savePanel');
                anchorEl.setAttribute('aria-expanded', 'true');
            }
            // ...and only now, with the panel installed, can it be written to
            syncVideo();
            this._syncCaptureButtons();
            this._describeCapture();
        }


        // Generate filename from object name and current timestamp
        _generateFilename(objectName, extension) {
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            let name = objectName || 'viewer';
            name = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
            return `py2dmol_${name}_${timestamp}.${extension}`;
        }

        // Download SVG directly

        _downloadSvg(svgString, objectName) {
            const filename = this._generateFilename(objectName, 'svg');
            const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            this._triggerDownload(blob, filename);
            this._captureStatus(`Saved ${filename}`);
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
        const PAL_NAMES = { pymol: 'PyMOL', jmol: 'Jmol' };
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
            // PICKED BY HAND, and remembered as such: the loader chooses tube
            // over cartoon for a large structure, and it must not go on
            // choosing for someone who has said what they want.
            renderer.styleChosen = true;
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
    // STYLE_DEFAULTS table exists to prevent. Width is remembered per style
    // now (_widthByStyle), so a tube at 5 no longer walks into a cartoon whose
    // slider stops at 4.7 - this stays as the guard for a width arriving from
    // anywhere else, a restored session among them.
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
    // WHICH OBJECT IS BEING EDITED - the picker beside the sequence strip. It
    // sits in the sequence panel, which is a sibling of the viewer container
    // rather than inside it, so the container query comes back empty and the
    // renderer would have no picker at all: no options, no change listener,
    // and no way to switch objects. Falls back to the document, and stays
    // container-first so two viewers on one page keep their own.
    const objectSelect = containerElement.querySelector('#objectSelect')
        || (containerElement.ownerDocument || document).getElementById('objectSelect');
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
    // NO GPU CONTROL HERE. `useGPU` is a rendering BACKEND and applies to
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
