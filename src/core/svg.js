// ============================================================================
// src/core/svg.js
// -----------------------------
// AI Context: SVG EXPORT CONTEXT (window.C2S)
// - A minimal canvas2svg: a 2D-context lookalike that records what it is asked
//   to draw and serialises it as SVG. Save > SVG hands one of these to the
//   ordinary render path in place of the canvas context, so the vector file is
//   drawn by exactly the same code as the screen.
// - Only what py2Dmol actually draws: lines (moveTo/lineTo/stroke), circles
//   (arc/fill), rectangles (fillRect), and linear gradients.
// - OPTIONAL. core/mol.js guards with `typeof C2S === 'undefined'` and
//   refuses the export rather than failing, so a build that leaves this out -
//   the WebGL one, which cannot draw to a vector context at all - simply has no
//   SVG button.
// ============================================================================

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
