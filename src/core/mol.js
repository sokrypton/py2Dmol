// ============================================================================
// src/core/mol.js
// -----------------------------
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

// ...and NO register helper. There was a six-line registerCustomColorMode here
// that nothing ever called: the one real registrant, cartoon/geom.js's 'ss',
// writes the table itself because it has to work when loaded alone. A public
// extension point the only extension cannot use is not one.

/**
 * Get all valid color modes (including custom ones)
 */
// ============================================================================
// ONE WAY TO SAY WHICH RESIDUES
// ============================================================================
//
// AT MODULE SCOPE IN core/mol.js, NOT IN THE EMBED. It started in
// parts/embed.js because the embed was the only caller, and that put the
// project's one way of naming residues inside a file the notebook and the
// website do not load. Three things need it: the embed's verbs, contact
// ENDPOINTS - which are an address of one residue and were drifting their own
// key names - and eventually the web app, whose panel does this by hand.
//
// Declared bare here, which is what core/mol.js's module scope is for: those
// declarations ARE the interface (see CLAUDE.md, two kinds of file).
//
// There were four, and no two agreed. setColor took {chain}/{positions}/{range}
// on an object; select took a bare array of indices; setVisibility took Sets of
// what STAYS plus a mode; and contacts named endpoints by chain and AUTHOR
// RESIDUE NUMBER, which nothing else accepted at all. Four spellings of one
// idea, each with its own edge cases, is most of what made this API hard to
// hold - and the visibility one was documented backwards for a year without
// anything noticing.
//
// So: ONE selector, understood everywhere, resolved to a Set of position
// indices. The forms are
//
//     'B'                          a chain, by id
//     [3, 4, 5]  /  new Set(...)   positions outright
//     {chain: 'B'}                 the same, spelled out
//     {positions: [3, 4, 5]}
//     {range: [0, 20]}             positions 0..19, half open, as in Python
//     {residues: [12, 13]}         AUTHOR residue numbers, what the file says
//     {object: 'A', ...}           within that object, not the merged array
//     {type: 'L'}                  ligands ('P' protein, 'N' nucleic)
//     {near: sel}                  within 5 A of that, atom to atom
//     {near: sel, angstroms: 8}    ...or another distance
//     'all' / null                 everything drawn
//
// KEYS COMBINE BY AND, index keys first: {chain: 'B', residues: [12, 13]} is
// two residues of one chain, not a chain plus two residues. positions and range
// union with each other because both name indices, then the chain and residue
// tests narrow what is left.
//
// 🔴 positions AND residues ARE NOT THE SAME NUMBERS, and both are integers, so
// nothing will tell you when you pass one for the other. A POSITION is an index
// into what is drawn, counting from zero across every chain. A RESIDUE is the
// number in the file - it starts wherever the depositor started, repeats across
// chains and skips gaps. `residues` is here because contacts already worked
// this way and there was no way to say it anywhere else.

// `object`, NOT `name`. Two different questions were both spelled name:
// which object do you mean (this), and what shall I call the one you are
// loading (v.load's second argument). One word for both is how you end up
// reading a selector and not knowing which it is.
const SELECTOR_KEYS = ['object', 'chain', 'positions', 'range',
    'residues', 'type', 'near', 'angstroms', 'not'];

/** A selector, as the Set of position indices it names. */
/** [a, b) as a list, which is what Python's (start, end) tuple means. */
function selectorRange(a, b) {
    const out = [];
    for (let i = a; i < b; i++) out.push(i);
    return out;
}

function positionsFor(renderer, sel) {
    const n = (renderer.coords || []).length;
    if (sel === undefined || sel === null || sel === 'all') {
        return new Set(selectorRange(0, n));
    }
    // ...the two shorthands. A string is a chain because a chain id is the one
    // thing anybody writes bare; an array or Set is positions.
    if (typeof sel === 'string') sel = { chain: sel };
    else if (Array.isArray(sel) || sel instanceof Set) sel = { positions: sel };
    if (typeof sel !== 'object') {
        throw new Error('py2Dmol: a selector is a chain id, a list of positions,'
            + ` or an object with ${SELECTOR_KEYS.join('/')} - got ` + typeof sel);
    }
    // A TYPO MUST NOT SELECT EVERYTHING. {chian: 'B'} matches no key, narrows
    // nothing, and would quietly mean "the whole structure" - which for hide()
    // is the entire model disappearing and for setColor is every residue
    // repainted. Named keys only.
    for (const k of Object.keys(sel)) {
        if (!SELECTOR_KEYS.includes(k)) {
            throw new Error(`py2Dmol: unknown selector key ${JSON.stringify(k)}`
                + ` - expected ${SELECTOR_KEYS.join(', ')}`);
        }
    }

    // WHICH OBJECT, first. With several structures merged, the arrays are one
    // array and an object owns a slice of it; naming one makes `positions` and
    // `range` that object's own numbering, which is what a caller who loaded it
    // under a name means by "position 4". With no name they are the merged
    // array's, and for the single-structure case those are the same thing.
    const win = (sel.object && renderer.localRangeOf)
        ? renderer.localRangeOf(sel.object) : { off: 0, end: Infinity };
    const lo = win.off;
    const hi = Math.min(n, win.end === Infinity ? n : win.end);

    let out;
    if (sel.positions || sel.range) {
        out = new Set();
        const push = (i) => { const k = i + lo; if (k >= lo && k < hi) out.add(k); };
        if (sel.positions) for (const i of sel.positions) push(i);
        if (sel.range) for (const i of selectorRange(sel.range[0], sel.range[1])) push(i);
    } else {
        out = new Set(selectorRange(lo, hi));
    }
    // ONE KEY FOR ONE IDEA. This was `chain` for one and `chains` for several,
    // which is two spellings of the same question and a coin toss every time
    // you write it. One key, and it takes either.
    if (sel.chain !== undefined) {
        const want = new Set([].concat(sel.chain));
        for (const i of [...out]) {
            if (!want.has((renderer.chains || [])[i])) out.delete(i);
        }
    }
    if (sel.residues) {
        const want = new Set(sel.residues);
        for (const i of [...out]) {
            if (!want.has((renderer.residueNumbers || [])[i])) out.delete(i);
        }
    }
    // ...WHAT KIND OF THING IT IS. 'L' is a ligand, 'P' protein, 'N' nucleic -
    // the renderer's own per-position type, which is how it decides what to
    // draw. {type: 'L'} is the whole of "select the ligand", which otherwise
    // means knowing its residue number.
    if (sel.type) {
        const want = new Set([].concat(sel.type));
        for (const i of [...out]) {
            if (!want.has((renderer.positionTypes || [])[i])) out.delete(i);
        }
    }
    // ...AND WHAT IS NEAR IT. residuesWithin is the renderer's own search, on
    // a spatial grid it keeps between calls, and it already backs the web app's
    // Find-interactions button. {near: sel} is that search as a selector, so
    // "the residues lining this pocket" is one expression rather than a script.
    //
    // TWO FLAT KEYS, not one nested object. This was
    // {within: {of: sel, angstroms: 5}} - a selector inside a wrapper inside a
    // selector, three levels deep to say one thing - and `angstroms` is nearly
    // always left at its default anyway.
    //
    // ATOM TO ATOM, not centre to centre: a residue counts if any of its atoms
    // is within the cutoff, side chains included, which is what makes 5 A a
    // contact shell rather than a rough sphere.
    if (sel.near !== undefined) {
        const seed = positionsFor(renderer, sel.near);
        const cut = Number(sel.angstroms !== undefined ? sel.angstroms : 5);
        const near = renderer.residuesWithin
            ? renderer.residuesWithin(seed, cut) : seed;
        for (const i of [...out]) if (!near.has(i)) out.delete(i);
        // ...the seed itself is part of the answer unless asked otherwise,
        // because "within 5 A of the ligand" that excludes the ligand is a
        // different question and the caller can say {not: ...} for it.
    }
    // ...AND THE COMPLEMENT, LAST. {not: x} is everything the rest of this
    // selector matched, minus what x matches - so {not: 'B'} on its own is
    // every position except chain B's, and {chain: 'A', not: {residues: [1]}}
    // is chain A without its first residue.
    //
    // It composes with the verbs rather than replacing them: hide and show are
    // OPERATIONS on the visible set and this is an OPERAND. Inverting one is
    // not the same as inverting the other - resetVisibility() then
    // hide({not: x}) draws only x, while hide(x) alone leaves whatever else
    // was already off the screen where it was.
    if (sel.not !== undefined) {
        for (const i of positionsFor(renderer, sel.not)) out.delete(i);
    }
    return out;
}


/**
 * WRITE A FRAMING AS ONE ACT.
 *
 * `extent` and `extentAspect` are one fact in two fields, and every camera bug
 * in this file came from writing one without the other or with a different
 * convention: orient normalising by the 3D radius while focus normalised by
 * `max(hx, hy)`, the aspect assigned on completion while the extent
 * interpolated, a session saving the first and not the second.
 *
 * The fields STAY - they are copied by Object.assign, serialised into sessions
 * and stored per object, and an accessor property survives none of that - but
 * nothing writes them apart any more. Give this the half-spans and it puts
 * both down together, in one convention: the extent is the larger half-span
 * and the aspect is the pair over it, so `extent * aspect.x === half.x`
 * exactly.
 *
 * @param {Object} viewerState the camera to write into
 * @param {{x: number, y: number}|null} half Angstrom, or null for "no framing
 *     of its own", which is what falls back to the object's own extent.
 */
/**
 * The pair `setViewSpan` wants, from the three fields a caller measured in.
 *
 * The inverse of what setViewSpan stores, and the second half of having one
 * convention: orient measures a radius and a shape, focus measures a radius
 * and a shape, and both had written this multiplication out themselves - twice
 * each, once for the jump and once for the flight.
 *
 * `zoom` divides, because `_viewHalfSpan` divides by it on the way back out;
 * pass 1 (or nothing) for a span that is not being scaled by the reader's
 * multiplier.
 */
// How far the camera stands back, for a given ortho setting and a given
// structure. 1.5x the structure at ortho 0, 20x at ortho 1 - so "orthographic"
// is a camera far enough away that the divergence is invisible rather than a
// separate projection.
const PERSPECTIVE_MIN_MULT = 1.5;
const PERSPECTIVE_MAX_MULT = 20.0;
const PERSPECTIVE_STD_DEV_MULT = 2.0;
const PERSPECTIVE_DEFAULT_SIZE = 30.0;

/**
 * The focal length an ortho setting asks for, against what is on screen.
 *
 * Written out in the ortho slider's handler and, until it was deleted, again
 * in parts/orient.js - which is how a flight came to move the perspective and
 * the zoom at once. One copy, and the slider is now just one of its callers.
 */
function focalLengthFor(stats, ortho) {
    let baseSize = PERSPECTIVE_DEFAULT_SIZE;
    if (stats && stats.stdDev > 0) baseSize = stats.stdDev * PERSPECTIVE_STD_DEV_MULT;
    else if (stats && stats.maxExtent > 0) baseSize = stats.maxExtent;
    const t = (typeof ortho === 'number') ? ortho : 1;
    const mult = (t >= 1) ? PERSPECTIVE_MAX_MULT
        : PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * t;
    return baseSize * mult;
}

function halfSpanOf(extent, aspect, zoom) {
    if (!(extent > 0)) return null;
    const z = (zoom > 0) ? zoom : 1;
    return {
        x: extent * ((aspect && aspect.x > 0) ? aspect.x : 1) / z,
        y: extent * ((aspect && aspect.y > 0) ? aspect.y : 1) / z,
    };
}

function setViewSpan(viewerState, half) {
    if (!half || !(half.x > 0) || !(half.y > 0)) {
        viewerState.extent = null;
        viewerState.extentAspect = null;
        return;
    }
    const e = Math.max(half.x, half.y);
    viewerState.extent = e;
    viewerState.extentAspect = { x: half.x / e, y: half.y / e };
}
if (typeof window !== 'undefined') window.py2dmolSetViewSpan = setViewSpan;

function getAllValidColorModes() {
    // 'object' only means anything with more than one object merged in, and
    // is what 'auto' resolves to there - see setCoords.
    const builtinModes = ['auto', 'chain', 'rainbow', 'plddt', 'deepmind',
        'entropy', 'object', 'hydrophobicity'];
    const customModes = window.py2dmol_customColors ? Object.keys(window.py2dmol_customColors) : [];
    return builtinModes.concat(customModes);
}


// ============================================================================
// VIEWER INITIALIZATION
// ============================================================================

/**
 * Initializes a py2dmol viewer instance within a specific container.
 * All logic is scoped to this container.
 * @param {HTMLElement} containerElement The root <div> element for this viewer.
 */

// ============================================================================
// THE VOCABULARY, at module scope.
// ============================================================================
// Vector maths, the colour palettes and their converters, the colour-resolution
// hierarchy, the drawing constants and the config schema. All pure: no DOM, no
// viewer, no state.
//
// It lived inside initializePy2DmolViewer, which meant it was rebuilt on every
// viewer and - the reason it moved - was invisible to any sibling file. A
// method extracted from Pseudo3DRenderer into a file of its own cannot see a
// local of the factory, and almost every method reaches one of these: hexToRgb,
// Vec3, DEFAULT_CONFIG, a SHADOW_ constant. Hoisting them is what makes the
// rest of the split possible.
//
// Measured with tools/free_vars.js before the move: zero enclosing-scope
// locals over all 607 lines, one global (getAllValidColorModes, already at
// module scope here).

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
// (cartoon/geom.js, SELECTION_INK_CSS) because it is a separate file
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
// (rgba(255,255,0) in panels/seq.js), so pointing at a residue there and
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
// cartoon/geom.js carries the same number as CONTACT_WIDTH; the two are
// checked against each other in tests/interaction.js, since a contact that
// changes width when you switch style is exactly what this exists to stop.
const CONTACT_WIDTH_A = 1.175;
// TWO MARKS AND A THIRD OPTION, chosen by `selectionMark` - see
// docs/SELECTION_MARK.md for the six that were drawn and the two rejected.
//
//   'highlight'  the band below, laid over the residue. The default, and what
//                this has always been.
//   'outline'    the same band with its middle punched out, so what reaches
//                the canvas is the rim and the geometry inside is untouched.
//                Thin enough to be quiet BECAUSE it covers nothing - the
//                highlight has to be pale for the opposite reason.
//   'none'       no mark. Legible only where something else says where you
//                are; in focus mode the zoom does, up to a point.
const SELECTION_MARKS = ['highlight', 'outline', 'none'];
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
function selectionBandFor(rad, pxScale, ref, gain) {
    const r = rad || 2;
    // THE RING IS A PEN, THE INNER EDGE IS THE THING. Its thickness comes
    // from `ref` - the ordinary residue radius at this view - and not from
    // r, so a mark sticks out by the same amount whatever it is drawn
    // around. Defaults to r, which is the same number for everything that
    // is drawn at the residue radius, so this changes nothing there.
    const g = (typeof gain === 'number') ? gain : SELECTION_HALO_GAIN;
    const m = g * (ref === undefined ? r : ref);
    return 2 * Math.max(r + m, SELECTION_HALO_MIN_PX * pxScale);
}
const SELECTION_HALO_GAIN = 1.3;
// ...AND THE OUTLINE'S OWN, because the gain belongs to the SHAPE: a band
// reads at its outer edge and a ring at its inner one, so the number that puts
// a wash's edge in the right place leaves an outline standing off the thing it
// traces. 1.0 hugs it.
const SELECTION_OUTLINE_GAIN = 1.0;
// A pencil line, and it follows the paper: an ink line on the 3d preset's
// black says nothing is selected at all, which is worse than saying it loudly.
// The same rule the hover readout follows.
const SELECTION_OUTLINE_LIGHT = 'rgb(40, 42, 55)';    // on white paper
const SELECTION_OUTLINE_DARK = 'rgb(238, 238, 244)';  // on black
const SELECTION_OUTLINE_ALPHA = 0.45;
const SELECTION_OUTLINE_PX = 1.4;
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

// ...AND THE PICKER'S OWN COLOURS ARE PyMOL'S, ORGANISED AS PyMOL ORGANISES
// THEM: one ROW PER FAMILY, each running its own shades - reds, greens, blues,
// yellows, magentas, cyans, oranges, tints, grays. That is the structure of
// PyMOL's colour menu (`all_colors_list` in modules/pymol/menu.py) and these
// are its values (`reg_named_color` in layer1/Color.cpp), the greys from its
// own `grey<NN> = NN/99` loop.
//
// It used to be the CHAIN CYCLE - the 40 colours PyMOL hands to chains, in the
// order it hands them, which is deliberately unlike itself from one entry to
// the next so that neighbouring chains contrast. As a chain palette that is
// exactly right and it still is one; as a grid to pick from it was confetti,
// and finding "a darker red" meant reading all 43 squares. The two lists
// answer different questions, which is why they are now two lists.
//
// The rows are what src/app/main.js draws, one <div> each, so the layout is
// the data - nothing there had to change.
const PYMOL_COLOR_FAMILIES = [
    // reds
    ['#ff0000', '#ff3333', '#b24c66', '#ba8c85', '#ff9999', '#ff8080', '#d93380', '#b22121', '#993333', '#8e391c', '#a6522b'],
    // greens
    ['#00ff00', '#33ff33', '#80ff00', '#85bf00', '#8cb266', '#a6e6a6', '#00ff80', '#80ff80', '#bfff40', '#339933'],
    // blues
    ['#0000ff', '#4c4cff', '#0080ff', '#8080ff', '#bfbfff', '#3380cc', '#8000ff', '#4040a6', '#1a1a99'],
    // yellows
    ['#ffff00', '#ffff33', '#ffff80', '#ffde5e', '#bfff40', '#fcd1a6', '#b88c4c'],
    // magentas
    ['#ff00ff', '#ff33cc', '#ff0080', '#ffa6d9', '#ffbfde', '#b28080', '#ff80ff', '#8c4099', '#bf00bf', '#991a99'],
    // cyans
    ['#00ffff', '#ccffff', '#80ffff', '#40ffbf', '#00bfbf', '#1a9999', '#66b2b2'],
    // oranges
    ['#ff8000', '#ff8c26', '#ffb233', '#ffcc80', '#ffde5e', '#c4b200', '#99991a'],
    // tints
    ['#fcd1a6', '#a6e6a6', '#bfbfff', '#ffff80', '#ffbfde', '#ccffff', '#ffcc80', '#d9d9ff'],
    // grays
    ['#ffffff', '#e8e8e8', '#cecece', '#b4b4b4', '#9b9b9b', '#818181', '#676767', '#4d4d4d', '#343434', '#1a1a1a', '#000000'],
];

function getPaletteColors(colorblind) {
    // COLOURBLIND MODE KEEPS ITS OWN LIST, which is a categorical palette
    // chosen to stay distinguishable - reorganising it by hue would be
    // organising the thing it exists to avoid relying on.
    if (!colorblind) return PYMOL_COLOR_FAMILIES.map((row) => row.slice());
    const src = chainColorsColorblind;
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
// ...and the colour MODES, beside the colours and for the same reason: the
// selection panel offers both now, and app/main.js reads its list from here
// rather than keeping one. getAllValidColorModes already folds in whatever
// cartoon/geom.js and anyone else registered in py2dmol_customColors, so a
// mode that exists is a mode the picker can offer.
window.py2dmol_colorModes = getAllValidColorModes;

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

// ============================================================================
// HYDROPHOBICITY
// ============================================================================
// Kyte & Doolittle 1982, J Mol Biol 157:105-132 - the hydropathy scale
// everyone means when they say "colour it by hydrophobicity".
//
// BY THREE-LETTER NAME, because that is what a structure carries: the renderer
// keeps positionNames, not a sequence, and a viewer that only knew one-letter
// codes could not answer for the residues a PDB actually names.
const KYTE_DOOLITTLE = {
    ILE: 4.5, VAL: 4.2, LEU: 3.8, PHE: 2.8, CYS: 2.5, MET: 1.9, ALA: 1.8,
    GLY: -0.4, THR: -0.7, SER: -0.8, TRP: -0.9, TYR: -1.3, PRO: -1.6,
    HIS: -3.2, GLU: -3.5, GLN: -3.5, ASP: -3.5, ASN: -3.5, LYS: -3.9,
    ARG: -4.5,
    // ...and the spellings a real file uses for the same residues.
    // Selenomethionine IS a methionine - the connectivity table already knows
    // MSE, so a structure phased that way draws its side chains, and without
    // this row they would have been the one thing on screen coloured grey.
    // The histidine protonation states and CYX come out of Amber and its
    // relatives, which is where a trajectory comes from.
    MSE: 1.9, HID: -3.2, HIE: -3.2, HIP: -3.2, HSD: -3.2, HSE: -3.2,
    HSP: -3.2, CYX: 2.5, CYM: 2.5,
};

// FIVE BUCKETS, NOT A RAMP. A gradient over twenty residues reads as twenty
// slightly different colours, which is a picture you cannot name anything in.
// Buckets you can point at - "the orange ones are the core" - and that is the
// whole reason to colour by hydropathy rather than by anything else.
//
// The ramp is orange to blue, so it survives every kind of colour blindness
// and there is no second table for it - unlike the chain and rainbow palettes,
// which are hue wheels and need one.
const HYDROPHOBICITY_BANDS = [
    { min: 3.0, hex: '#f2994a', label: 'very hydrophobic' },
    { min: 1.0, hex: '#f2c94c', label: 'hydrophobic' },
    { min: -1.0, hex: '#cfd8d4', label: 'neutral' },
    { min: -3.0, hex: '#56b9dc', label: 'hydrophilic' },
    { min: -Infinity, hex: '#187bd1', label: 'very hydrophilic' },
];

/**
 * A residue's hydropathy colour, from its three-letter name.
 *
 * Anything the scale does not name - a nucleotide, a ligand, UNK - comes back
 * GREY rather than the middle band. "No answer" and "neither hydrophobic nor
 * hydrophilic" are different things, and the neutral colour would say the
 * second while meaning the first.
 */
function getHydrophobicityColor(resName) {
    const v = KYTE_DOOLITTLE[(resName || '').toUpperCase()];
    if (v === undefined) return DEFAULT_GREY;
    for (const band of HYDROPHOBICITY_BANDS) {
        if (v >= band.min) return hexToRgb(band.hex);
    }
    return DEFAULT_GREY;
}

// PAE color functions moved to panels/heatmap.js

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

    /**
     * One entry of an advanced spec, applied.
     *
     * A STRING NAMING A MODE SELECTS THE MODE AND CANCELS ANY LITERAL BELOW IT;
     * anything else IS the literal. That rule was written out six times - once
     * per level, object/chain/position at both object and frame scope - and had
     * already drifted: the object-level copy did not clear the literal. Harmless
     * only because it runs first, while there is nothing to clear. One copy now.
     */
    const applySpec = (value) => {
        if (typeof value === 'string'
            && getAllValidColorModes().includes(value.toLowerCase())) {
            resolvedMode = value.toLowerCase();
            resolvedLiteralColor = null;
        } else {
            resolvedLiteralColor = value;
        }
    };

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
                applySpec(adv.object);
            }

            // Check chain-level at object scope
            if (adv.chain && chainId && adv.chain[chainId]) {
                applySpec(adv.chain[chainId]);
            }

            // Check position-level at object scope (highest priority)
            if (adv.position && adv.position[posIndex] !== undefined) {
                applySpec(adv.position[posIndex]);
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
                    applySpec(adv.frame);
                }

                // === Level 3: Chain-level color ===
                if (adv.chain && chainId && adv.chain[chainId]) {
                    applySpec(adv.chain[chainId]);
                }

                // === Level 4: Position-level color (highest priority) ===
                if (adv.position && adv.position[posIndex] !== undefined) {
                    applySpec(adv.position[posIndex]);
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
        // SUBDIVISIONS PER RESIDUE, 2-8, matching the slider and the
        // Python default. It read 0.5 here, left over from when detail was
        // a fractional sampling density: the constructor rounds and clamps
        // to 2..8, so 0.5 came out as 2 - the LOWEST setting - for any
        // caller that went through normalizeConfig without naming one.
        detail: 4,
        // thickness / cel / highlight / outline_tint / width / arrows /
        // pencil / sheet_flat are deliberately absent: they are resolved
        // per style in the renderer constructor (see PRESET_KEYS in
        // normalizeConfig), so a default here would override the preset.
        shadow: true,
        shadow_strength: 0.5,
        outline: "full",
        ortho: 0.5,
        cyclic: true
    },
    color: {
        mode: "auto",
        colorblind: false
    },
    // The residue x residue heatmap panel. `pae` is the same switch under
    // its old name - see normalizeConfig, which accepts both and hands back
    // ONE object under both keys.
    heatmap: {
        enabled: false,
        size: 300
    },
    scatter: {
        enabled: false,
        size: 300
    },
    overlay: {
        enabled: false
    },
    // THE SELECTION PANEL, AND THE CLICK THAT FILLS IT - one key, because they
    // are one decision. `selectionEnabled` is off in the constructor on the
    // reasoning that a click which changes a selection nobody can see, act on
    // or clear is worse than no click; that reasoning is about the PANEL, and
    // the panel used to be markup in index.html so only the website could ever
    // answer yes. It is parts/panel.js's now, so the question is a config key
    // and every shell can ask it.
    selection: {
        enabled: false
    }
};

// Normalize legacy flat configs into the nested structure expected by the renderer
// THE NAMES A CALLER USES, AND THE PAIR THEY MEAN.
//
// Inside, a look is a STYLE (which draw path: the backbone trace, or the
// cartoon) and a PRESET (which profile the cartoon draws with). That split is
// real and stays - they are different questions, and setPreset only makes sense
// for one of the two paths.
//
// It is not a distinction a caller should have to hold. `cartoon` on its own is
// not a look at all: setStyle('cartoon') immediately delegates to
// setPreset(stylePreset || 'richardson'), so choosing it means choosing a
// preset with extra steps - and having to keep two fields agreeing is what let
// a viewer report richardson and draw ribbon for as long as both existed.
//
// So the API takes ONE name from a flat list, and this is where it becomes a
// pair. 'cartoon' is still accepted and still means richardson.
const STYLE_ALIASES = {
    tube: { style: 'tube', preset: null },
    cartoon: { style: 'cartoon', preset: 'richardson' },
    richardson: { style: 'cartoon', preset: 'richardson' },
    ribbon: { style: 'cartoon', preset: 'ribbon' },
    '3d': { style: 'cartoon', preset: '3d' },
};

/** A style name from the flat list, as the (style, preset) it stands for. */
function resolveStyleName(name) {
    return STYLE_ALIASES[name] || null;
}

/**
 * ...and back: the one name that stands for a (style, preset) pair.
 *
 * THIS IS WHAT A DROPDOWN HOLDS. Assigning the internal style to a select that
 * lists the flat names sets it to 'cartoon', which is not one of its options -
 * and a <select> given a value it does not have goes EMPTY. In the app
 * syncStylePanel put it back a moment later, so the only visible symptom was in
 * an embed, whose strip has no panel to re-sync it.
 */
function styleNameFor(style, preset) {
    return style === 'cartoon' ? (preset || 'richardson') : (style || 'tube');
}

function normalizeConfig(rawConfig = {}) {
    const cfg = rawConfig || {};

    // Support legacy flat color config: { color: "auto", colorblind: false }
    const colorMode = typeof cfg.color === 'string' ? cfg.color : cfg.color?.mode;

    // ...one name in, a (style, preset) pair out. An explicitly named preset
    // still wins, which is what Python has always done: preset implies cartoon.
    const _rawStyle = cfg.rendering?.style ?? cfg.style ?? DEFAULT_CONFIG.rendering.style;
    const _styleName = resolveStyleName(_rawStyle)
        || { style: DEFAULT_CONFIG.rendering.style, preset: null };
    const _rawPreset = cfg.rendering?.preset ?? cfg.preset;

    const normalized = {
        viewer_id: cfg.viewer_id ?? DEFAULT_CONFIG.viewer_id,
        display: {
            size: cfg.display?.size || cfg.size || DEFAULT_CONFIG.display.size,
            rotate: cfg.display?.rotate ?? cfg.rotate ?? DEFAULT_CONFIG.display.rotate,
            autoplay: cfg.display?.autoplay ?? cfg.autoplay ?? DEFAULT_CONFIG.display.autoplay,
            controls: cfg.display?.controls ?? cfg.controls ?? DEFAULT_CONFIG.display.controls,
            box: cfg.display?.box ?? cfg.box ?? DEFAULT_CONFIG.display.box,
            // A LOOK CARRIES ITS PAGE, AND THE CONFIG PATH WAS THE ONE THAT
            // MISSED IT. `3d` is solid shaded geometry meant to be seen on
            // black, and _applyLookBackground says so - but that runs from
            // setStyle and setPreset only, and a viewer built from a config
            // never calls either. So py2Dmol.show({style: '3d'}) came up as
            // solid geometry on white paper, which is the one background it is
            // not drawn for. viewer.py already worked around this in Python
            // ("bg = black if is3d"); this is the same rule one layer down, so
            // the embed and the notebook agree without either restating it.
            //
            // AN EXPLICIT bg STILL WINS, which is why the default is computed
            // here rather than assigned in the constructor: by the time the
            // renderer reads this field, 'white' from a caller and 'white' from
            // a default are the same string.
            // ...the EFFECTIVE preset, because an outright `preset` beats the
            // one the style name implies (see _rawPreset below) - so
            // {style: 'ribbon', preset: '3d'} is a 3d look and gets 3d's page.
            background: cfg.display?.background ?? cfg.bg
                ?? ((_rawPreset ?? _styleName.preset) === '3d' ? 'black' : 'white')
        },
        rendering: {
            style: _styleName.style,
            detail: cfg.rendering?.detail ?? cfg.detail ?? DEFAULT_CONFIG.rendering.detail,
            shadow: cfg.rendering?.shadow ?? cfg.shadow ?? DEFAULT_CONFIG.rendering.shadow,
            shadow_strength: cfg.rendering?.shadow_strength ?? cfg.shadow_strength ?? DEFAULT_CONFIG.rendering.shadow_strength,
            outline: cfg.rendering?.outline ?? cfg.outline ?? DEFAULT_CONFIG.rendering.outline,
            ortho: cfg.rendering?.ortho ?? cfg.ortho ?? DEFAULT_CONFIG.rendering.ortho,
            cyclic: cfg.rendering?.cyclic ?? cfg.cyclic ?? DEFAULT_CONFIG.rendering.cyclic,
            // THE BACKEND, AND IT WAS MISSING FROM THIS LIST.
            //
            // This block is rebuilt field by field, so a key absent from it is
            // a key thrown away - and `gpu` was absent. viewer.py sets
            // config["rendering"]["gpu"], the constructor reads
            // `config.rendering?.gpu === true`, and in between this function
            // dropped it: py2Dmol.view(gpu=True) turned nothing on, for as long
            // as the flag has existed. The carry-over loop below did not save
            // it either - that walks TOP-LEVEL keys, and `rendering` is already
            // in knownKeys.
            //
            // The web app never noticed because it does not come through here:
            // src/app/main.js assigns renderer.useGPU straight from the
            // checkbox.
            //
            // DEFAULTS TO OFF, and `=== true` in the constructor means only an
            // explicit true counts. A build with no WebGL2 painter must ask for
            // the GPU deliberately.
            gpu: cfg.rendering?.gpu ?? cfg.gpu ?? DEFAULT_CONFIG.rendering.gpu ?? false
        },
        color: {
            mode: colorMode || DEFAULT_CONFIG.color.mode,
            colorblind: cfg.color?.colorblind ?? cfg.colorblind ?? DEFAULT_CONFIG.color.colorblind,
            // named palette for the 'ss' colour mode; undefined = the
            // renderer's default palette (owned by cartoon/geom.js)
            ss_palette: cfg.color?.ss_palette ?? cfg.ss_palette
        },
        // 🔴 ONE SWITCH, TWO SPELLINGS, AND THE SAME OBJECT UNDER BOTH.
        // The panel draws the PAE and whatever else a frame carries, so the
        // key is `heatmap` - but `pae` is what Python's `view(pae=True)`
        // sends, what every config a host page has written says, and what a
        // saved session holds. An unrecognised key here is not an error, it
        // is a panel that never mounts with nothing thrown, which is the
        // same reason the markup ids kept their old spellings.
        //
        // ALIASED BELOW TO THE SAME OBJECT rather than copied: two fields
        // that must agree are two fields that can disagree, and this file
        // has half a dozen entries about exactly that.
        heatmap: {
            enabled: cfg.heatmap?.enabled ?? cfg.heatmap
                ?? cfg.pae?.enabled ?? cfg.pae ?? DEFAULT_CONFIG.heatmap.enabled,
            size: cfg.heatmap?.size || cfg.heatmap_size
                || cfg.pae?.size || cfg.pae_size || DEFAULT_CONFIG.heatmap.size
        },
        scatter: {
            enabled: cfg.scatter?.enabled ?? cfg.scatter ?? DEFAULT_CONFIG.scatter.enabled,
            size: cfg.scatter?.size || cfg.scatter_size || DEFAULT_CONFIG.scatter.size
        },
        overlay: {
            enabled: cfg.overlay?.enabled ?? cfg.overlay ?? DEFAULT_CONFIG.overlay.enabled
        },
        selection: {
            enabled: cfg.selection?.enabled ?? cfg.selection
                ?? DEFAULT_CONFIG.selection.enabled
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
    // ...and `shade`, which core/mol.js reads at config.rendering?.shade and
    // which this loop is the only thing carrying: it was dropped exactly like
    // `gpu` was, so view(shade=...) never changed the cel quantisation.
    // ...the preset the style name implies, unless one was named outright.
    if (_rawPreset === undefined || _rawPreset === null) {
        if (_styleName.preset) normalized.rendering.preset = _styleName.preset;
    }
    for (const key of [...PRESET_KEYS, "base_plates", "preset", "shade"]) {
        const value = cfg.rendering?.[key] ?? cfg[key];
        if (value !== undefined && value !== null) {
            normalized.rendering[key] = value;
        }
    }

    // Carry over any additional top-level keys not explicitly normalized
    const knownKeys = new Set(["viewer_id", "display", "rendering", "color", "heatmap", "pae", "scatter", "overlay", "selection", "size", "rotate", "autoplay", "controls", "box", "shadow", "outline", "ortho", "colorblind", "heatmap_size", "pae_size", "scatter_size", "cyclic", "style", "detail", "base_plates", "ss_palette", "preset", "gpu", "shade", ...PRESET_KEYS]);
    for (const [key, value] of Object.entries(cfg)) {
        if (!knownKeys.has(key)) {
            normalized[key] = value;
        }
    }

    // ...and the panel's switch answers to its old name as well. THE SAME
    // OBJECT, not a copy: `config.pae.enabled` is what a host page, a saved
    // session and this tree's own older readers all say, and an alias that
    // can drift from what it aliases is worse than no alias. (`pae_size` is
    // already folded into `heatmap.size` above, so nothing is left to
    // preserve separately - the block that used to sit here wrote
    // `normalized.pae.size` and became a TypeError the moment `pae` stopped
    // being the normalised key.)
    normalized.pae = normalized.heatmap;

    return normalized;
}

// ============================================================================
// PARTS OF Pseudo3DRenderer THAT LIVE IN SIBLING FILES
// ============================================================================
// A part file pushes `{name, proto, statics}` onto window.py2dmolMolParts and
// this installs it. That is how a coherent block of methods - shadows, clip,
// capture - can be its own file without the class being split in two.
//
// WHY NOT JUST DECLARE THEM IN THE CLASS. Because the class is inside
// initializePy2DmolViewer, one per viewer, and a sibling file at module scope
// cannot reach into a closure. Installing onto the prototype from in here is
// the only way round that which does not require hoisting the class - see the
// commit that hoisted the vocabulary for why the class stays put.
//
// defineProperties AND NOT Object.assign: assign READS a getter and copies its
// value, which would turn `static get ELEMENT_COLORS()` from a fresh object per
// access into one shared mutable table. Descriptors keep the getter a getter.
//
// A DUPLICATE NAME IS AN ERROR, not a last-one-wins. Two parts defining the
// same method is a merge accident, and the symptom - one of them silently not
// running - is unfindable.
//
// THE PARTS MUST ALL BE LOADED BEFORE THE FIRST VIEWER IS CREATED. The manifest
// guarantees it by load order, and after the first install the array's `push`
// is replaced with one that says so rather than accepting a part nobody will
// ever apply.
function installMolParts(Cls) {
    const parts = (typeof window !== 'undefined' && window.py2dmolMolParts) || [];
    const from = new Map();
    for (const part of parts) {
        for (const [name, desc] of
            Object.entries(Object.getOwnPropertyDescriptors(part.proto || {}))) {
            if (from.has(name)) {
                throw new Error(`two viewer-mol parts define ${name}:`
                    + ` ${from.get(name)} and ${part.name}`);
            }
            from.set(name, part.name);
            Object.defineProperty(Cls.prototype, name, desc);
        }
        if (part.statics) {
            Object.defineProperties(Cls, Object.getOwnPropertyDescriptors(part.statics));
        }
    }
    if (!parts._sealed) {
        parts._sealed = true;
        parts.push = (p) => {
            throw new Error(`the viewer-mol part "${p && p.name}" loaded after the`
                + ' first viewer was created, so its methods would be missing from'
                + ' it - move its <script> above core/mol.js (and remember the'
                + ' notebook PREPENDS, so its order there is reversed)');
        };
    }
    return from;
}

function initializePy2DmolViewer(containerElement, viewerId) {


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
            // WHICH OBJECTS THE CAMERA HAS ALREADY BEEN FRAMED FOR. A merge
            // re-frames for an object that is new to it and holds still for
            // one being switched back on - see _applyShownObjects.
            this._framedObjects = new Set();
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
                ortho: this._orthoSetting(),
                focalLength: 200.0,
                center: null,
                extent: null,
                extentAspect: null,
                currentFrame: -1
            };

            // Render style: 'tube' (default segment pipeline below) or 'cartoon'
            // (secondary-structure cartoon; draw stage delegated to cartoon/geom.js)
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
            // ...set properly a few lines down, once stylePreset is resolved.
            // It used to be decided HERE, by whether the config NAMED the
            // preset - while stylePreset below defaults to richardson when it
            // does not. So a viewer built with style:'cartoon' and no preset
            // reported stylePreset 'richardson' and drew none of it: every
            // fallback in this constructor asks cartoonRichardson, and it was
            // false. py2Dmol.view(style='cartoon') has never been Richardson.
            this.cartoonRichardson = false;
            // Preset LABEL for the GUI dropdown; the concrete values arrive
            // as normal settings, so this only names them.
            // 'ribbon' (plain cartoon) is the default, and the only other
            // values are 'richardson' and '3d'. This used to fall back to
            // 'custom', a preset that was removed - leaving the dropdown with a
            // value it does not list.
            const _p = config.rendering?.preset;
            this.stylePreset = (_p === '3d' || _p === 'ribbon') ? _p : 'richardson';
            // ...and the flag follows the RESOLVED preset, so the defaults below
            // are the ones the named preset actually asks for. Gated on the
            // style for the same reason setStyle gates it: tube has no preset,
            // and coming back to cartoon goes through setPreset, which sets it
            // again from the name it kept.
            this.cartoonRichardson = this.style === 'cartoon'
                && this.stylePreset === 'richardson';
            // THE PRESET'S OWN VALUES, FROM THE ONE TABLE THAT HOLDS THEM.
            //
            // Every default below used to be written here a second time, as
            // `cartoonRichardson ? a : b` - a copy of two rows of
            // LOOK_DEFAULTS, which is what _applyLookDefaults reads when the
            // same preset is chosen from the panel. The two copies disagreed:
            // width was 2.0 here and 3.0 there, and smooth was false here and
            // true there, so a viewer BUILT as richardson drew differently from
            // one SWITCHED to richardson. Nothing compares those two paths, so
            // nothing said.
            //
            // Absent when no cartoon file is loaded - the tube-only embed - and
            // then none of these fields is ever read.
            const _look = (window.py2dmolCartoon && window.py2dmolCartoon.LOOK_DEFAULTS)
                || {};
            const _d = _look[this.style === 'cartoon' ? this.stylePreset : 'tube'] || {};
            // ...a config value wins; the preset's is the fallback; the literal
            // is only for a build with no cartoon at all.
            const _pick = (raw, key, floor) => {
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 0) return n;
                return _d[key] !== undefined ? _d[key] : floor;
            };
            // Richardson's per-SS thickness is a set of RATIOS scaled by this
            // control, so the global default of 0 (flat ribbons) would cancel
            // the preset and the style would appear to do nothing. Fall back to
            // the preset's own default instead - an explicit thickness, 0
            // included, is still honoured.
            this.cartoonThickness = _pick(config.rendering?.thickness, 'thickness', 0);
            // arrows / pencil / sheet_flat are resolved here rather than left
            // undefined for cartoon/geom.js to default: leaving them unset let
            // the sliders seed themselves from a different value than the draw
            // path was using, so the panel read 0.85 while the render was flat.
            this.cartoonArrows = config.rendering?.arrows !== undefined
                ? config.rendering.arrows !== false
                : (_d.arrows !== undefined ? _d.arrows !== false : true);
            // DNA/RNA base plates on/off (the Bases toggle); default on
            this.cartoonBasePlates = config.rendering?.base_plates !== false;
            this.cartoonPencil = Math.min(1, _pick(config.rendering?.pencil, 'pencil', 0));
            this.cartoonSheetFlat = Math.min(1,
                _pick(config.rendering?.sheet_flat, 'sheetFlat', 0));
            // Cartoon sampling density; 0.5 = tuned default, lower = faceted
            // (and cheaper). Clamped again inside cartoon/geom.js.
            // integer 2-8: subdivisions per helix residue at the floor
            this.cartoonDetail = Math.min(8, Math.max(2, Math.round(
                _pick(config.rendering?.detail, 'detail', 4) || 4)));
            // depth fade toward the paper (the Fade slider); off by default
            this.cartoonFade = Math.min(1, _pick(config.rendering?.fade, 'fade', 0));
            // Cel shading: one flat tone per face per piece instead of the
            // smooth per-station gradient.
            // smooth = gradient shading; off = flat tone bands (cel)
            this.cartoonSmooth = (config.rendering?.smooth !== undefined)
                ? config.rendering.smooth === true
                : (_d.smooth !== undefined ? _d.smooth === true
                    : this.style !== 'cartoon');
            // WHICH PAINTER, DECIDED BY WHICH PAINTER IS LOADED.
            //
            // Every build outside the website ships exactly one: the notebook
            // and py2Dmol.embed.min.js carry cartoon/paintgl.js, py2Dmol.embed.cpu.min.js
            // carries cartoon/paint2d.js. Asking for the other one is not a
            // preference, it is a request for a file that is not in the
            // download - so there is nothing for a flag to mean, and
            // py2Dmol.view(gpu=...) and py2Dmol.show({gpu}) are both gone.
            //
            // The WEBSITE is the one build with both, and there the choice is
            // real: index.html's checkbox assigns renderer.useGPU directly, and
            // config.rendering.gpu seeds it. So an explicit setting still wins
            // where it can be honoured, and elsewhere the bundle answers.
            const _gl = !!window.py2dmolCartoonGPU;
            const _2d = typeof window.py2dmolCartoonPaint === 'function';
            this.useGPU = (_gl && _2d)
                ? config.rendering?.gpu === true      // both here: as configured
                : _gl;                                 // otherwise: whatever is
            // Highlight gain: 0 = the old ceiling at the base colour, 1 = a
            // full lift toward white on faces pointing at the light.
            this.cartoonHighlight = _pick(config.rendering?.highlight, 'highlight', 1.8);
            // Outline tint: 0 = black ink, 1 = ribbon mode's 0.7 colour tint.
            // Richardson outlines are a tint of the element colour (see
            // RICH_TINT_DEFAULT); an explicit value still wins.
            this.cartoonOutlineTint = Math.min(1,
                _pick(config.rendering?.outline_tint, 'outlineTint', 0));

            this.lineWidth = (typeof config.rendering?.width === 'number')
                ? config.rendering.width
                : (_d.width !== undefined ? _d.width : 3.0);
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
            // cartoon/geom.js. Once the control has been touched, it is the
            // user's, 0 included.
            // The reader's own thickness needs no flag: cartoon/geom.js compares
            // the value with the look's own default, which is the whole of
            // "did a person ask for this". See thicknessIsChosen there.
            // ...FROM THE LOOK, like every other style-owned default above it.
            // This was a bare 3.0, so a viewer built as richardson came up with
            // a 3.0 outline where the preset asks for 1.0 - "the outline states
            // the edge, it does not weigh it down" - while one SWITCHED to
            // richardson got the 1.0, because _applyLookDefaults reads the
            // table and this did not. Python sends the outline MODE and never a
            // width, so nothing else could have corrected it.
            this.relativeOutlineWidth = (typeof _d.outlineWidth === 'number')
                ? _d.outlineWidth : 3.0;
            this.shadowIntensity = 0.95;

            // Set defaults from config, with fallback
            this.shadowEnabled = (typeof config.rendering?.shadow === 'boolean') ? config.rendering.shadow : true;
            // SHADE: the cartoon's directional shading (light + inner
            // shadow). Separate from 'shadow', which is the ribbon's
            // cast-shadow effect (and reserved for real cartoon shadows).
            // 0 = flat colour, 1 = full modelling. Was a boolean toggle; the
            // panel now exposes it as a slider, and 0 matches the old "off".
            // ...and its default is the PRESET's, like thickness and pencil
            // above. Richardson's is 0.7 (LOOK_DEFAULTS), and a flat 1 here was
            // the last field still disagreeing with setPreset('richardson')
            // once the flag was fixed.
            this.cartoonShade = Math.min(1, Math.max(0,
                _pick(config.rendering?.shade, 'shade', 1)));
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
            this.cachedSegmentIndicesCoords = null;
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
            // docs/MULTI_OBJECT_PLAN.md. The two are mutually exclusive: a merge is
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
            this.heatmapRenderer = null;
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
            // heatmapBoxes: selection rectangles dragged on the heatmap panel,
            //   in RESIDUE space - {i_start,i_end,j_start,j_end}. Not cells: see
            //   cellsToResidues in src/panels/heatmap.js.
            // visibilityMode: 'default' = empty selection means "show all" (initial state)
            //                'explicit' = empty selection means "show nothing" (user cleared)
            // CLICK-SELECTION IS OFF UNLESS SOMETHING TURNS IT ON.
            //
            // The Python path loads core/mol.js and the cartoon plugin and
            // nothing else - no sequence strip, no selection panel - so a click
            // there changed a selection with no way to see it, act on it or
            // clear it except by clicking the background again. Selection is
            // done in Python by scripting, which does not go through the mouse.
            //
            // The web app turns it on when it wires the selection tools, so the
            // switch is owned by whoever can actually show the result - and
            // that is now a config key rather than "whichever shell happens to
            // have the markup", because parts/panel.js builds the panel for
            // all three. parts/ui.js reads the SAME flag to decide whether to
            // mount it, so the control and the gesture cannot disagree.
            this.selectionEnabled = !!(this.config?.selection?.enabled);
            this.visibilityModel = {
                positions: new Set(), // Position indices: 0, 1, 2, ... (one position per entry in frame data)
                chains: new Set(),
                heatmapBoxes: [],
                visibilityMode: 'default' // Start in default mode (show all)
            };

            // Ligand groups: derived from each object's frame on demand -
            // see ligandGroupsForFrame and renderer.ligandGroupsOf
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
            // See docs/MULTI_OBJECT_PLAN.md.
            this.shownObjects = null;

            // CONTACTS THAT BELONG TO NO ONE OBJECT, because their two ends are
            // in different ones. Object-level contacts stay where they are and
            // travel with their object (OBJECT_STATE); these are the viewer's,
            // with both ends written as addresses - {object, chain, residue} -
            // so they survive renumbering and a reload without an index in
            // sight, and they draw whenever both ends are on screen.
            this.crossContacts = [];

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
            // 🔴 BOTH SPELLINGS, because this is a patch key on a public
            // setter. The field is `heatmapBoxes` now - a box dragged on the
            // contact map was never a PAE box - but `paeBoxes:` is what
            // every caller written before the rename passes, and an unknown
            // key on a patch object is dropped without a word.
            const boxPatch = (patch.heatmapBoxes !== undefined)
                ? patch.heatmapBoxes : patch.paeBoxes;
            if (boxPatch !== undefined) {
                if (boxPatch === 'clear' || boxPatch === null) {
                    this.visibilityModel.heatmapBoxes = [];
                } else if (Array.isArray(boxPatch)) {
                    this.visibilityModel.heatmapBoxes = boxPatch.map(b => ({
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
                heatmapBoxes: m.heatmapBoxes.map(b => ({ ...b })),
                visibilityMode: m.visibilityMode
            };
        }

        resetVisibility() {
            this.visibilityModel = {
                positions: new Set(),
                chains: new Set(),
                heatmapBoxes: [],
                visibilityMode: 'default'
            };
            // ...AND THE OBJECTS' OWN RECORDS WITH IT. Every other write to
            // the live mask files itself down per object (see setVisibility);
            // this one did not, so the records still said what had been hidden
            // and the next merge rebuild - one click of an eye - composed the
            // hiding straight back out of them. Reachable only with no object
            // or an empty array today, which is luck rather than design: the
            // invariant is that the live mask and the records never disagree.
            this._saveVisibilityToObjects();
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
                heatmapBoxes: [],
                visibilityMode: 'default'
            });
        }

        // Clear all selections: show nothing (explicit mode)
        hideAll() {
            this.setVisibility({
                positions: new Set(),
                chains: new Set(),
                heatmapBoxes: [],
                visibilityMode: 'explicit'
            });
        }

        /**
         * WHAT ONE OBJECT SHOWS, in the merged array's numbering.
         *
         * THE ONE RULE, and there used to be two. A visibility record holds
         * three contributors - residues picked in the strip, whole chains, and
         * boxes drawn on the PAE matrix - and they combine by UNION, with the
         * mode deciding what an EMPTY answer means: `default` shows everything
         * (nobody has asked for anything), `explicit` shows nothing (someone
         * asked for nothing).
         *
         * The rebuild path used to have its own version of this that knew
         * about positions and chains and nothing else, and it wrote its answer
         * back through setVisibility with `heatmapBoxes: []` - so every rebuild of
         * the coordinate array (an eye, a side chain, a frame step) silently
         * erased the boxes and dropped the mode back to default. Draw a box on
         * a prediction, switch on a second object, and the whole structure
         * came back: measured, 7 residues visible before and all 144 after.
         *
         * @returns {Set<number>|null} null means "all of this object" - not
         *   the same as an empty set, which means none of it.
         */
        _visibleForObject(name, off, end) {
            const o = this.objectsData && this.objectsData[name];
            const st = o && o.visibilityState;
            const hasPos = !!(st && st.positions && st.positions.size);
            const hasChains = !!(st && st.chains && st.chains.size);
            const boxes = (st && st.heatmapBoxes) || [];
            const explicit = !!(st && st.visibilityMode === 'explicit');
            if (!st || (!hasPos && !hasChains && !boxes.length && !explicit)) return null;

            const out = new Set();
            // ...THE FRAMES OF AN OVERLAY ARE ONE OBJECT. The record is in
            // frame 0's numbering and the array holds every frame end to end,
            // so a residue picked once is picked in all of them.
            const ov = this.overlayState && this.overlayState.enabled
                && this.overlayState.frameIdMap;
            const spans = [];
            if (ov) {
                const map = this.overlayState.frameIdMap;
                let at = 0;
                for (let i = 1; i <= map.length; i++) {
                    if (i === map.length || map[i] !== map[at]) {
                        spans.push([off + at, i - at]);
                        at = i;
                    }
                }
            } else {
                spans.push([off, end - off]);
            }
            const add = (local) => {
                for (const [base, len] of spans) {
                    if (local >= 0 && local < len) out.add(base + local);
                }
            };

            // THE ALGEBRA, and it is not symmetric: RESIDUES AND CHAINS
            // INTERSECT, and the PAE boxes UNION with the result.
            //
            // A chain set is a FILTER over the residues - "of these residues,
            // the ones in these chains", and with no residues named, all of
            // those chains - while a box drawn on the matrix ADDS its rows and
            // columns to whatever is already showing. Making chains a
            // contributor instead of a filter shows the whole structure the
            // moment anything writes a chain set, which is most of the time.
            if (hasPos || hasChains) {
                const first = spans[0];
                for (let local = 0; local < first[1]; local++) {
                    // CHAIN IDENTITY IS (OBJECT, CHAIN) - chainKeyAt - even
                    // though the record belongs to one object, because that is
                    // the vocabulary everything that WRITES the set uses (the
                    // panel, the strip). Compared as bare ids, hiding chain A
                    // of one object hid chain A of the other.
                    if (hasChains && !st.chains.has(this.chainKeyAt(first[0] + local))) continue;
                    if (hasPos && !st.positions.has(local)) continue;
                    add(local);
                }
            }
            if (out.size) return out;
            // nothing asked for: everything, or nothing, per the mode
            return explicit ? out : null;
        }

        /**
         * THE LIVE MASK, COMPOSED FROM THE OBJECTS' OWN RECORDS.
         *
         * One composer for every path that needs one: a selection made in the
         * strip, a box drawn on the PAE matrix, an eye switched in Multi, a
         * side chain appended, a frame step. The records are the truth and the
         * mask is derived; the mask means nothing except against the array it
         * was built for, which is why rebuilding it is the answer rather than
         * translating the old one.
         */
        _composeAndApplyMask(skip3DRender = false) {
            const n = this.coords ? this.coords.length : 0;
            if (n === 0) {
                this.visiblePositions = null;
                if (!skip3DRender) {
                    this.render('_composeAndApplyMask: empty coords');
                }
                return;
            }
            const ms = this.multiState;
            const merged = !!(ms && ms.enabled && ms.sourceNames);
            const names = merged ? ms.sourceNames
                : (this.currentObjectName ? [this.currentObjectName] : []);
            const offsets = merged ? ms.sourceOffsets : [0];
            const base = this._baseCount();

            const vis = new Set();
            let everything = true;
            for (let s = 0; s < names.length; s++) {
                const off = offsets[s];
                const end = (s + 1 < offsets.length) ? offsets[s + 1] : base;
                const own = this._visibleForObject(names[s], off, end);
                if (own === null) {
                    for (let i = off; i < end; i++) vis.add(i);
                    continue;
                }
                everything = false;
                for (const i of own) vis.add(i);
            }
            // ...AND THE SIDE-CHAIN ATOMS, which are positions too and are in
            // nobody's record: they are not residues of any object. Left out,
            // every side chain in the picture went out the moment the array
            // was rebuilt - including on objects nobody had touched.
            this.withSidechainAtoms(vis, true);

            const oldVisiblePositions = this.visiblePositions;
            // NULL IS "EVERYTHING", and it is worth reaching: every drawing
            // path tests the mask per position, so a mask naming every
            // position is a hash lookup per position for an answer that is
            // always yes.
            this.visiblePositions = (everything || vis.size >= n) ? null : vis;

            // Clear shadow cache when visibility changes: which segments are
            // drawn decides which cast.
            // ...and NOT-A-MASK is null OR undefined: a renderer that has
            // never composed one has neither, and `=== null` alone read the
            // size of undefined.
            const visibilityChanged = (
                oldVisiblePositions !== this.visiblePositions
                && (!oldVisiblePositions || !this.visiblePositions
                    || oldVisiblePositions.size !== this.visiblePositions.size)
            );
            if (visibilityChanged && !skip3DRender) {
                this._invalidateShadowCache();
                this.lastShadowRotationMatrix = null;
            }
            if (!skip3DRender) this.render('_composeAndApplyMask');

            // Always dispatch: the sequence strip and the PAE panel draw their
            // own version of the selection and have no other way to hear.
            if (typeof document !== 'undefined') {
                try {
                    document.dispatchEvent(new CustomEvent('py2dmol-visibility-change', {
                        detail: {
                            hasSelection: this.visiblePositions !== null
                                && this.visiblePositions.size > 0,
                            visibilityModel: {
                                positions: Array.from(this.visibilityModel.positions),
                                chains: Array.from(this.visibilityModel.chains),
                                heatmapBoxes: this.visibilityModel.heatmapBoxes.map((b) => ({ ...b })),
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
        setHeatmapRenderer(heatmapRenderer) {
            this.heatmapRenderer = heatmapRenderer;
        }

        setScatterRenderer(scatterRenderer) {
            this.scatterRenderer = scatterRenderer;
        }

        // Re-routed setResidueVisibility to use the new unified selection model
        setResidueVisibility(selection) {
            if (selection === null) {
                // Clear only PAE contribution; leave sequence/chain selections intact
                this.setVisibility({ heatmapBoxes: 'clear' });
            } else {
                const { i_start, i_end, j_start, j_end } = selection;
                this.setVisibility({ heatmapBoxes: [{ i_start, i_end, j_start, j_end }] });
            }
        }
        // [END PATCH]

        setupInteraction() {
            // Add inertia logic
            // HOVER READOUT. Moving over a residue names it in the same box the
            // sequence view uses (see setHoveredResidue in panels/seq.js) rather
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
            // ...and guarded like the play button above: this is called from
            // updateUIControls, which the frame timer runs on every tick.
            if (this.speedButton.textContent !== label) {
                this.speedButton.textContent = label;
            }
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
                    // _applyLookDefaults) - so this must only record an actual
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
                this.orthoSlider.addEventListener('input', (e) => {
                    const normalizedValue = parseFloat(e.target.value);

                    // ORTHO IS THE STATE; there is no separate "perspective is
                    // on" flag to keep in step with it. One used to exist and
                    // could disagree with the slider - it was written only from
                    // here, so a value supplied by config or a restored session
                    // left the slider showing perspective while the projection
                    // stayed flat.
                    this.viewerState.ortho = normalizedValue;
                    this.viewerState.focalLength =
                        focalLengthFor(this.drawnStats(), normalizedValue);

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
                    if (this.heatmapRenderer) {
                        this.heatmapRenderer.render();
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
            // 🔴 THE RIBBON TRACE IS NOT DROPPED HERE, and it used to be.
            //
            // The reasoning looked sound - the trace is a curve through these
            // segments, so it goes stale with them - and it broke the thing it
            // was protecting: toggling Cyclic invalidates AFTER the rebuild
            // that would have refilled it, so the trace went to null and
            // nothing ever asked for another. The selection went back to
            // chording every helix and stayed that way.
            //
            // It does not need dropping. A cartoon BUILD refills it, and a
            // build happens exactly when the ribbon changes - that is what the
            // mesh signature is for, and it is deliberately generous. Between
            // two builds the ribbon is the same ribbon.
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesCoords = null;
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
         * 'cartoon' (secondary-structure cartoon, drawn by cartoon/geom.js).
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
        /**
         * EVERYTHING A STYLE OWNS, in one list.
         *
         * A style switch re-asserts every one of these from LOOK_DEFAULTS
         * (see _applyLookDefaults), which is right the first time a style is
         * entered and wrong every time after: the settings are single fields
         * on the renderer, so tube's defaults land on top of the cartoon
         * numbers and the cartoon's land back on top of tube's. With one
         * object on screen that only cost you your own adjustments. With the
         * style per object it became visible as objects interfering with each
         * other - select a tube object and the cartoon object beside it was
         * suddenly drawn with tube's thickness and outline.
         *
         * So each style keeps its own set, remembered when you leave it and
         * put back when you return. `_widthByStyle` did exactly this for the
         * width slider alone, for the same reason ("a tube radius arrived in
         * cartoon as a ribbon width"); this is that rule for the rest of them.
         *
         * A field added to the Style panel belongs here, or it will be the one
         * that leaks between styles next.
         */
        static get STYLE_SETTINGS() {
            return ['lineWidth', 'cartoonThickness', 'cartoonOutlineTint',
                'cartoonHighlight', 'cartoonSheetFlat', 'cartoonPencil',
                'cartoonSmooth', 'relativeOutlineWidth', 'outlineMode',
                'cartoonArrows', 'cartoonDetail', 'cartoonFade', 'cartoonShade',
                'cartoonRichardson', 'cartoonBasePlates', 'cartoonStyle',
                'cartoonGpuRibbonThick', 'cartoonGpuHelixTh',
                'cartoonHelixThRel', 'naSmooth'];
            // NOT stylePreset, deliberately, and setStyle says why where it
            // switches to tube: "tube has no preset, and clobbering it lost
            // which cartoon preset to come back to". Listed here it became
            // style-owned again through the back door - the tube's profile
            // captured whatever preset happened to be current and handed it
            // back on the way out, so a picture holding both styles would
            // drop into Ribbon on its own.
        }

        /**
         * INSTALL A STYLE'S SETTINGS FOR THE DURATION OF ONE PASS, and hand
         * back what was there so the caller can put it straight.
         *
         * Field assignment and nothing else: no cache invalidation and no
         * panel sync. This runs TWICE PER FRAME on a mixed picture, where
         * dropping the segment cache would rebuild it sixty times a second and
         * syncing the panel would have the controls flickering between two
         * styles. What the fields affect is the geometry, and both mesh keys
         * already carry every one of them that does.
         */
        _installStyleProfile(style) {
            const keys = this.constructor.STYLE_SETTINGS;
            const prev = {};
            for (const k of keys) prev[k] = this[k];
            const held = this._styleSettings && this._styleSettings[style];
            if (held) {
                for (const k of keys) if (held[k] !== undefined) this[k] = held[k];
            } else {
                // NEVER SELECTED THIS STYLE IN THIS SESSION: its profile is its
                // defaults - the same ones setStyle would apply, arrived at the
                // same way, so that a style first met inside a mixed frame and
                // a style first chosen from the panel come out identical.
                // Cartoon's defaults are the PRESET's (a preset is a whole
                // look); tube has none, and no Richardson with it.
                const wasQuiet = this._quietStyleDefaults;
                this._quietStyleDefaults = true;
                try {
                    if (style === 'cartoon') {
                        const preset = this.stylePreset || 'richardson';
                        this.cartoonRichardson = (preset === 'richardson');
                        this._applyLookDefaults(preset);
                    } else {
                        this.cartoonRichardson = false;
                        this._applyLookDefaults('tube');
                    }
                } finally { this._quietStyleDefaults = wasQuiet; }
                this._keepStyleSettings(style);
            }
            return prev;
        }

        /** ...and put back what the pass found. */
        _restoreStyleProfile(prev) {
            if (!prev) return;
            for (const k of this.constructor.STYLE_SETTINGS) this[k] = prev[k];
        }

        /** Remember what this style is set to. */
        _keepStyleSettings(style) {
            const keys = this.constructor.STYLE_SETTINGS;
            const out = {};
            for (const k of keys) out[k] = this[k];
            (this._styleSettings || (this._styleSettings = {}))[style || this.style] = out;
        }

        /**
         * Put a style's settings back. Returns false when this style has never
         * been visited, and then the caller applies its defaults instead.
         */
        _recallStyleSettings(style) {
            const held = this._styleSettings && this._styleSettings[style];
            if (!held) return false;
            for (const k of this.constructor.STYLE_SETTINGS) {
                if (held[k] !== undefined) this[k] = held[k];
            }
            if (this._invalidateShadowCache) this._invalidateShadowCache();
            if (this._invalidateSegmentCache) this._invalidateSegmentCache();
            if (this._syncStyleControls) this._syncStyleControls();
            return true;
        }

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
            // ...a preset name is a style name here. setStyle('richardson')
            // and setPreset('richardson') are the same request, and a caller
            // should not have to know which word this library files it under.
            const named = resolveStyleName(style);
            if (!named) {
                console.warn(`Invalid style "${style}" - expected one of `
                    + Object.keys(STYLE_ALIASES).join(', ') + '.');
                return;
            }
            // A NAMED PRESET IS TWO STEPS FROM TUBE, IN THIS ORDER.
            //
            // setPreset assigns this.style = 'cartoon' but does none of the work
            // of ARRIVING there - the heap check, the recalled per-style
            // settings, the cache invalidation below. Called from tube it left
            // every field saying cartoon while the canvas went on showing the
            // tube, and only a second switch repainted.
            //
            // Setting stylePreset and falling through does not work either: the
            // path below short-circuits on _recallStyleSettings, which restores
            // whatever cartoon was last set to and returns - so tube -> ribbon
            // drew richardson, the remembered one, while reporting ribbon.
            //
            // So: enter the cartoon by the normal route, then switch preset. The
            // guard is `style !== 'cartoon'`, because 'cartoon' resolves to
            // richardson too and would recurse here forever.
            if (named.preset && style !== 'cartoon') {
                if (this.style !== 'cartoon') {
                    this.setStyle('cartoon');
                    // ...refused: no cartoon file, or it would not fit
                    if (this.style !== 'cartoon') return;
                }
                if (named.preset !== this.stylePreset) this.setPreset(named.preset);
                return;
            }
            style = named.style;
            if (style === 'cartoon' && !window.py2dmolCartoon) {
                console.warn(`Style "${style}" requested but cartoon/geom.js is not loaded.`);
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
                        this.styleSelect.value = styleNameFor(this.style, this.stylePreset);
                    }
                    return;
                }
            }
            // WHAT THE STYLE BEING LEFT IS SET TO, before anything overwrites
            // it - and what the one being entered was left at, after.
            this._keepStyleSettings(this.style);
            this.style = style;
            // ...AND THE OBJECT BEING EDITED IS DRAWN IN IT. The style has
            // always been per object; with several on screen at once it has to
            // be recorded the moment it is picked rather than when the object
            // is switched away from, because the painters read it every frame.
            //
            // A QUIET call is the restore path putting an object's own style
            // back (see _switchToObject), so it says nothing about anyone
            // having CHOSEN: only a call from the panel marks that, and what
            // it marks is the size rule keeping its hands off this object.
            if (this.currentObjectName && this.objectsData
                    && this.objectsData[this.currentObjectName]) {
                const cur = this.objectsData[this.currentObjectName];
                cur.style = style;
                if (cur.viewerState) cur.viewerState.style = style;
                if (!this._quietStyle) cur.styleChosen = true;
            }
            // The build-up is cartoon-only, so leaving cartoon leaves the mode
            // too - otherwise the save button goes on offering to record a
            // drawing this style cannot make.
            if (style !== 'cartoon' && this.drawMode) this.setDrawMode(false);
            // ...AND A STYLE YOU HAVE BEEN IN BEFORE COMES BACK AS YOU LEFT IT.
            // Only a style's FIRST visit takes the defaults below.
            if (this._recallStyleSettings(style)) {
                const uiName = styleNameFor(style, this.stylePreset);
                // ...INCLUDING ITS PAGE. backgroundColor is deliberately not in
                // STYLE_SETTINGS - it is a property of the LOOK, not of the
                // style, and 'cartoon' holds three looks - so the recall above
                // cannot restore it and this is where it has to come from.
                //
                // Without this the black page was a first-visit-only effect.
                // 3d turns it black, tube turns it back to white, and 3d again
                // takes the short cut here and returns: the settings all came
                // back, the preset still said 3d, and the solid geometry drew
                // on white paper. Every visit after the first, on the website
                // dropdown as much as anywhere.
                this._applyLookBackground(uiName);
                if (this.styleSelect && this.styleSelect.value !== uiName) {
                    this.styleSelect.value = uiName;
                }
                if (this._syncStylePanel) this._syncStylePanel();
            // ...AND THE SAVE PANEL, WHOSE FORMATS DEPEND ON THE STYLE. It is
            // built fresh on open, so switching style while it is OPEN left it
            // offering what the old style could do: SVG stayed on the menu
            // after a tube became a cartoon on a build with no 2D painter, and
            // that combination writes a 359-byte file with nothing in it.
            if (this._savePanel && !this._captureBusy) this._rebuildSavePanel();
                if (!quiet) this.render('setStyle');
                return;
            }
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
            this._applyLookBackground('tube');       // tube is drawn on paper
            this._applyLookDefaults('tube');
            // ...the flat name, which for tube is 'tube' either way - written
            // through the same helper so all four sites agree.
            const tubeName = styleNameFor(style, this.stylePreset);
            if (this.styleSelect && this.styleSelect.value !== tubeName) {
                this.styleSelect.value = tubeName;
            }
            if (this._syncStylePanel) this._syncStylePanel();
            // ...AND THE SAVE PANEL, WHOSE FORMATS DEPEND ON THE STYLE. It is
            // built fresh on open, so switching style while it is OPEN left it
            // offering what the old style could do: SVG stayed on the menu
            // after a tube became a cartoon on a build with no 2D painter, and
            // that combination writes a 359-byte file with nothing in it.
            if (this._savePanel && !this._captureBusy) this._rebuildSavePanel();
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
         * (LOOK_DEFAULTS), and the page background. A preset always implies
         * the cartoon style, so choosing one switches to it.
         *
         * 'ribbon' is the plain cartoon - smooth off, no slab thickness, ink
         * on - and it is LOOK_DEFAULTS.ribbon, under its own name. It exists
         * as a named preset so there is a way back to plain cartoon after
         * richardson or 3d.
         */
        setPreset(name) {
            if (name !== 'richardson' && name !== 'ribbon' && name !== '3d') {
                console.warn(`Invalid preset "${name}" - expected "richardson", "ribbon" or "3d".`);
                return;
            }
            if (!window.py2dmolCartoon) {
                console.warn(`Preset "${name}" requested but cartoon/geom.js is not loaded.`);
                return;
            }
            this.style = 'cartoon';
            this.stylePreset = name;
            this.cartoonRichardson = (name === 'richardson');
            this._applyLookDefaults(name);
            this._applyLookBackground(name);
            const uiName = styleNameFor('cartoon', this.stylePreset);
            if (this.styleSelect && this.styleSelect.value !== uiName) {
                this.styleSelect.value = uiName;
            }
            if (this._syncStylePanel) this._syncStylePanel();
            // ...AND THE SAVE PANEL, WHOSE FORMATS DEPEND ON THE STYLE. It is
            // built fresh on open, so switching style while it is OPEN left it
            // offering what the old style could do: SVG stayed on the menu
            // after a tube became a cartoon on a build with no 2D painter, and
            // that combination writes a 359-byte file with nothing in it.
            if (this._savePanel && !this._captureBusy) this._rebuildSavePanel();
            this.render('setPreset');
        }

        /**
         * A LOOK carries its page background: '3d' is solid shaded geometry
         * and is meant to be seen on black; tube, ribbon and richardson are
         * drawings on paper. Applied as part of the look rather than left to
         * the user, for the same reason the sliders are - a look is a whole
         * look. Still just a starting point: the Dark toggle stays live
         * afterwards.
         */
        _applyLookBackground(look) {
            const want = (look === '3d') ? '#000000' : '#ffffff';
            if (this.backgroundColor === want) return;
            this.backgroundColor = want;
            const dark = this.containerElement
                ? this.containerElement.querySelector('#darkCheckbox')
                : (typeof document !== 'undefined' ? document.getElementById('darkCheckbox') : null);
            if (dark) dark.checked = (want === '#000000');
        }

        /**
         * Set every preset-controlled value to the given style's defaults and
         * sync the sliders. Values come from py2dmolCartoon.LOOK_DEFAULTS so
         * the renderer and the UI cannot disagree about what a style means.
         */
        /**
         * SET EVERY CONTROL TO WHAT ONE LOOK ASKS FOR.
         *
         * A LOOK is the `tube` STYLE or one of the cartoon style's presets -
         * `richardson`, `ribbon`, `3d` - and those four names are the table's
         * keys (cartoon/geom.js: LOOK_DEFAULTS). It used to be handed a
         * STYLE by some callers and a PRESET by others, with the plain-cartoon
         * entry keyed 'cartoon' so that both spellings resolved to something:
         * 'ribbon' had to be translated on the way in, and anything passing
         * the style name 'cartoon' got the ribbon look silently, whatever
         * preset was selected.
         */
        _applyLookDefaults(look) {
            const table = window.py2dmolCartoon && window.py2dmolCartoon.LOOK_DEFAULTS;
            const d = table && table[look];
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
            // ...UNLESS THIS IS A PASS OF A MIXED FRAME, which installs a
            // style's profile for the length of one draw: there is nothing to
            // invalidate (the mesh keys carry these fields) and the panel must
            // go on describing the object you selected, not whichever half of
            // the picture is being painted.
            if (this._quietStyleDefaults) return;
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
            // and src/app/main.js re-running the Ortho slider - and every one of them
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
                    // ...then the focus mode's memory - see parts/focus.js.
                    if (this._focusRecallAfterSwitch) {
                        this._focusRecallAfterSwitch(newObjectName, mergedMask);
                    }
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
            // ...BUT THE FOCUS MODE KEEPS ONE PER OBJECT. The camera already
            // is per object, so dropping the selection alone left a returning
            // reader parked at the pocket they had focused with nothing marked
            // and no side chains. parts/focus.js holds the memory; it is the
            // MODE's and is dropped with it.
            if (this._focusRememberBeforeSwitch) {
                this._focusRememberBeforeSwitch(this.currentObjectName, mergedMask);
            }
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
                    heatmapBoxes: [],
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
                this.visibilityModel.heatmapBoxes = (savedState.heatmapBoxes || []).map((b) => ({ ...b }));
            } else {
                // Apply the saved selection directly to visibilityModel (bypassing setVisibility's normalization)
                this.visibilityModel.positions = new Set(savedState.positions);
                this.visibilityModel.chains = new Set(savedState.chains);
                this.visibilityModel.heatmapBoxes = savedState.heatmapBoxes.map(box => ({ ...box }));
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
                // ...for everything DRAWN, not the object just switched to
                this.entropy = this.entropyForDrawn();
                this._updateEntropyOptionVisibility();
            } else if (this.colorMode === 'entropy') {
                // If entropy mode is active but no MSA, try to map it anyway
                const objectName = this.currentObjectName;
                if (objectName && this.objectsData[objectName] && window.MSA) {
                    this.entropy = this.entropyForDrawn();
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
                ortho: this._orthoSetting(),
                focalLength: 200.0,
                center: null,
                extent: null,
                extentAspect: null,
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
            // a moment later - see tubeByDefaultIfBig in src/app/.
            //
            // setStyle, not an assignment: a style carries a whole profile of
            // defaults with it, and half-switching leaves the panel describing
            // one style while the renderer draws another.
            // ...AND THE STYLE FOLLOWS UNDER A MERGE TOO, now that the style
            // belongs to the object. It used to be held back here: one array
            // was drawn one way, so adopting the newly picked object's style
            // would have restyled every other structure with it. It no longer
            // does - each drawn object is painted in its own style (see
            // drawnStyleGroups) - so what this changes is only which object
            // the Style panel is describing, which is exactly what picking an
            // object in Multi is asking for.
            this.styleChosen = merged ? this.styleChosen : !!saved.styleChosen;
            const ownStyle = merged
                ? (newObject && (newObject.style
                    || (newObject.viewerState && newObject.viewerState.style)))
                : saved.style;
            if (merged && ownStyle && ownStyle !== this.style && this.setStyle) {
                // quiet: the frames are not loaded yet, and the picture does
                // not change anyway - only the panel does
                this.setStyle(ownStyle, true);
            }
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

            // ...AND THE PAE PANEL, which follows the object being edited when
            // that object is drawn. Under a merge nothing else here reloads a
            // frame, so this is the only thing that would ask.
            this._syncPaeToDrawn();

            // Note: _composeAndApplyMask will be called by setFrame after the frame data is loaded
        }

        // Add a new object
        addObject(name) {
            // A NEW OBJECT JOINS WHAT IS ON SCREEN. The shown set is a list of
            // names, and one that does not mention the object just loaded
            // leaves it invisible - so a fetch, a Copy or a drag-and-drop while
            // two structures are up would appear to have done nothing.
            //
            // INCLUDING FROM AN EMPTY SET. Everything switched off is a state
            // the user can be in, and loading a file from there is a request
            // to see that file: leaving the set empty made the load look like
            // it had failed. Only a set at all - a null set is the resting
            // state, where the object being edited is drawn and this one is
            // about to become it.
            if (this.shownObjects instanceof Set) {
                this.shownObjects.add(name);
            }
            // ...and it is new to the CAMERA, which will widen once to take it
            // in. A re-fetch under the same name counts: the structure behind
            // it can be anywhere.
            if (this._framedObjects) this._framedObjects.delete(name);
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
                    visibilityState: {
                        positions: new Set(),
                        chains: new Set(),
                        heatmapBoxes: [],
                        visibilityMode: 'default'
                    },
                    viewerState: {
                        rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                        zoom: 1.0,
                        ortho: this._orthoSetting(),
                        focalLength: 200.0,
                        center: null,
                        extent: null,
                extentAspect: null,
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

            // SUPERPOSE ONTO THE FRAME BEFORE IT, which viewer.py used to do
            // with numpy before the payload was built.
            //
            // TO THE PREVIOUS FRAME, because Python chained it: each frame was
            // aligned to the running result, which then became the reference.
            //
            // The two are all but indistinguishable in practice - Kabsch is very
            // nearly transitive, and chained against align-to-frame-zero differs
            // by at most 0.0006 A over rigid, sheared and twisting trajectories
            // measured against numpy. This matches what the notebook did, which
            // is the reason to prefer it; do not expect a test to catch a change
            // here, because none can.
            //
            // Only when the shapes match: a frame with a different number of
            // positions is a different structure, and Kabsch has nothing to say
            // about it. That was Python's test too.
            //
            // It runs HERE because addFrame is the one funnel - a static load
            // from show(), a frame streamed into a live cell, and an embed's
            // own addFrame all arrive through it.
            if (data && data.align && data.coords && newFrameIndex > 0
                && typeof align_a_to_b === 'function') {
                const prev = object.frames[newFrameIndex - 1];
                if (prev && prev.coords && prev.coords.length === data.coords.length) {
                    data.coords = align_a_to_b(data.coords, data.coords, prev.coords,
                        data.allow_reflection === true);
                }
            }

            // Add frame to object
            this.objectsData[targetObjectName].frames.push(data);

            // ...and NOT the ligand groups, which are derived from the
            // frame whenever something asks - see ligandGroupsForFrame.

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

            if (window.Heatmap && window.Heatmap.isValid(data.pae)) {
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
            // ...AND THE CAMERA'S DISTANCE, when nothing else will set it. The
            // ortho slider recomputes the focal length on every input; a shell
            // without one (an embed, a notebook) never did, so a config asking
            // for perspective would have got the 200 default - a distance with
            // no relation to the structure in front of it. Here, because this
            // is where stdDev becomes known.
            if (!this.orthoSlider && isPerspective(this.viewerState)) {
                this.viewerState.focalLength =
                    focalLengthFor(this.drawnStats() || object,
                        this.viewerState.ortho);
            }

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

        /**
         * Replace the LAST frame of an object rather than appending one.
         *
         * THE FRAME COUNT DOES NOT MOVE, which is the whole point: an
         * animation that walks a structure from one conformation to another
         * wants to change what is drawn sixty times a second, and doing that
         * with addFrame leaves sixty frames on the play bar and a viewer that
         * has to be rebuilt to get rid of them. Replacing in place costs
         * nothing but the redraw that was going to happen anyway.
         *
         * IT ALREADY EXISTED, in `parts/ui.js`'s handleReplaceFrame - pop, then
         * addFrame - and only a notebook could reach it, over a
         * BroadcastChannel. Same shape as the slab, the side chains and the
         * superposition before it, and ui.js calls this now so there is one
         * copy of the pop.
         *
         * THE LAST ONE, not an arbitrary index. `addFrame` pushes, and it is
         * where the alignment against the previous frame and the pLDDT/PAE
         * tracking are done - reaching those for a frame in the middle means
         * taking addFrame apart, and no caller has wanted it.
         *
         * @param {Object} frame the replacement, in addFrame's shape
         * @param {string} [objectName] defaults to the current object
         * @returns {this}
         */
        replaceFrame(frame, objectName) {
            const name = objectName || this.currentObjectName
                || Object.keys(this.objectsData)[0];
            const object = name && this.objectsData[name];
            if (!object) {
                throw new Error(`replaceFrame: no object ${JSON.stringify(name)}`);
            }
            if (object.frames && object.frames.length > 0) {
                object.frames.pop();
                // ...and the trackers, which name a frame index that has just
                // stopped existing. addFrame will set them again for the
                // replacement; what must not happen is their pointing past the
                // end in between.
                if (object._lastPlddtFrame >= object.frames.length) {
                    object._lastPlddtFrame = object.frames.length - 1;
                }
                if (object._lastPaeFrame >= object.frames.length) {
                    object._lastPaeFrame = object.frames.length - 1;
                }
            }
            this.addFrame(frame, name);
            return this;
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
            // ...and only if they were drawn by the frame these screen
            // positions came from - see _naPickId, set where they are built.
            const naPick = (this._naPickId === fid) ? this._naPick : null;
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
            // a lone atom with no bonds still belongs to its parsed group -
            // ITS object's, in merged indices, or a click on the second
            // structure's ion is matched against the first structure's groups
            const groups = this.mergedLigandGroups();
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
            // A SET OR AN ARRAY. Every caller inside this repo passes a Set, so
            // the test was `positions.size` - and an array has no `.size`, so
            // setResidueSelection([10, 11, 12]) read as falsy and CLEARED the
            // selection instead of making one. Silently: the natural JS spelling
            // did the opposite of what it says. An embed has no sequence strip
            // to select with, so an array is the only way it can ask.
            const many = positions
                && (positions.size || (Array.isArray(positions) && positions.length));
            const next = many ? new Set(positions) : null;
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
         * into (see extractedFrame, and frameObj in src/app/): a state
         * carried field by field silently drops whatever nobody wrote down.
         * `tests/copy_selection.js` sets all of them and checks each one
         * survives - and separately walks the source for per-object keys that
         * nobody copies, so a new one added without a line here fails there.
         */
        _remapObjectState(src, dst, selectedIndices) {
            if (!src || !dst) return;
            const map = new Map();
            for (let i = 0; i < selectedIndices.length; i++) {
                map.set(selectedIndices[i], i);
            }
            this._renumberObjectState(src, dst, map, selectedIndices);
        }

        /**
         * RENUMBER EVERY PIECE OF PER-OBJECT STATE, from one field list.
         *
         * This was written out field by field - a paragraph each for the
         * position sets, the SSE map, the colour tree, the side-chain colours
         * and the contacts - which is five chances to forget one, and the
         * bonds were forgotten for as long as they have existed. The list is
         * OBJECT_STATE now, and each field says how it renumbers.
         *
         * `dst` may be `src` itself, or a scratch object copied over it
         * afterwards, which is what a Delete does: the remap reads while it
         * writes, and there the source and the destination are the same
         * object.
         *
         * @param {Map<number, number>} map old position -> new position
         * @param {Array<number>} selected the positions that survive, in order
         */
        _renumberObjectState(src, dst, map, selected) {
            const ctx = { map, selected, renderer: this };
            for (const field of OBJECT_STATE) {
                if (!field.remap) continue;
                const out = field.remap(src[field.key], ctx);
                // undefined means "this object has none of that" - leave the
                // destination alone rather than writing an absence, which for
                // half of these fields means the opposite of nothing
                if (out !== undefined) dst[field.key] = out;
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
            // ...AND THE LIGAND GROUPS, which are position indices like
            // everything else here and are computed nowhere but addFrame - so
            // an edit that rewrote the frames in place left them pointing at
            // whatever had moved into those slots. Cut one chain out of a
            // structure with a haem in each and the ones that were left drew
            // as loose spheres and stopped collapsing to one token in the
            // strip. Rebuilt from the frame rather than renumbered: the map is
            // derived from the frame in the first place, and there is one
            // function that does it.
            // (the ligand groups need no upkeep: they are derived from the
            // frames, which have just been replaced - see ligandGroupsForFrame)
            this._mergedLigCache = null;
            // (the object's own bond list is renumbered with everything else
            // keyed by position - see OBJECT_STATE)

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
            const resolvedPae = window.Heatmap ? window.Heatmap.resolveData(object, frameIndex) : null;

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
                // a ligand atom's element, where the frame has it - a copy of
                // a ligand that lost this would lose its element colours and
                // its bond thresholds with it
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
            if (window.Heatmap && obj) window.Heatmap.updateFrame(this, obj, 0);
            if (this.heatmapRenderer && this.heatmapRenderer.render) this.heatmapRenderer.render();
            this.updateScatterContainerVisibility();
            if (this.objectSelect) this.objectSelect.value = name;
            // everything visible, since nothing here has been hidden yet
            this.setVisibility({
                positions: new Set(), chains: new Set(), heatmapBoxes: [],
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
                this._invalidateScreenProjection();
                this._loadedKey = null;
                clearCanvas();
                if (this.heatmapRenderer) { this.heatmapRenderer.setData(null); }
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
                this._invalidateScreenProjection();
                this._loadedKey = null;
                clearCanvas();
                if (this.heatmapRenderer) { this.heatmapRenderer.setData(null); }
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
            if (window.Heatmap) {
                window.Heatmap.updateFrame(this, object, frameIndex);
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
            // THE CURSOR IS THE ONLY PART A PANEL-LESS VIEWER HAS. An embed is
            // a canvas in someone's page and none of these controls exist;
            // updateUIControls below already returns early on the same test,
            // and this method used to throw on the first of them instead.
            this.canvas.style.cursor = enabled ? 'grab' : 'wait';
            // ...and EVERY ONE OF THEM IS OPTIONAL, not just most. An embed
            // that offers a play strip and no style panel has playButton and
            // frameSlider and none of the sliders below, so the three that were
            // dereferenced bare here threw on the first frame it loaded.
            if (!this.playButton) return;
            this.playButton.disabled = !enabled;
            if (this.frameSlider) this.frameSlider.disabled = !enabled;
            if (this.objectSelect) this.objectSelect.disabled = !enabled;
            if (this.speedButton) this.speedButton.disabled = !enabled;
            if (this.rotationCheckbox) this.rotationCheckbox.disabled = !enabled;
            if (this.lineWidthSlider) this.lineWidthSlider.disabled = !enabled;
            if (this.shadeSlider) this.shadeSlider.disabled = !enabled;
            if (this.outlineModeButton) this.outlineModeButton.disabled = !enabled;
            if (this.outlineModeSelect) this.outlineModeSelect.disabled = !enabled;
            if (this.colorblindCheckbox) this.colorblindCheckbox.disabled = !enabled;
            if (this.orthoSlider) this.orthoSlider.disabled = !enabled;
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
            // ...guarded like the second use of it ninety lines down. An embed
            // can hand over a play strip and no container, and this threw on
            // the first frame it loaded.
            if (this.controlsContainer) {
                this.controlsContainer.style.display = controlsEnabled ? 'flex' : 'none';
            }

            // Get container element from canvas (for finding parent containers)
            const containerElement = this.canvas ? this.canvas.closest('.py2dmol-container') ||
                this.canvas.parentElement?.closest('#mainContainer')?.parentElement : null;

            // THE OBJECT ROW IS ALWAYS THERE. It used to appear only with a
            // second object, on the reasoning that there is nothing to pick
            // between with one - but the row is now what the panels below it
            // act on: the picker names the object whose style, clip and
            // settings the rest of the panel is editing. A control that
            // appears once a second file loads makes that relationship
            // invisible until then, and Multi unavailable for the one object
            // that IS loaded.
            if (this.objectSelect) {
                // The picker is not shown at all any more - the strip's
                // sections say which object you are working on, and clicking
                // in one is how you change it. The element stays because
                // everything drives the current object through it.
                // ...found the way the picker is: within this viewer's own
                // container if it lives there, and from the document only when
                // the page holds exactly one of them. Several viewers can share
                // a document, and the first match would be another's.
                const doc = this.objectSelect.ownerDocument || document;
                const only = (id) => {
                    const mine = containerElement && containerElement.querySelector('#' + id);
                    if (mine) return mine;
                    const all = doc.querySelectorAll('#' + id);
                    return all.length === 1 ? all[0] : null;
                };
                const row = only('objectRow');
                if (row) row.style.display = 'flex';
                // ONE OBJECT IS NOT A CHOICE - WHERE THE PICKER IS ALL THE
                // ROW HOLDS. In the notebook shell it has a row to itself,
                // and with a single object that row is a label and a dropdown
                // that can only say what it already says. index.html's picker
                // sits in #objectRow beside Multi and the prev/next buttons,
                // which stay useful with one object.
                //
                // The rule is what the row CONTAINS, not which page it is on,
                // and it is AFTER the line above so that one rule decides. It
                // tested the class first, which was wrong and looked right:
                // index.html's row is `.toggle-item object-row`, so it hid
                // the website's Multi button too - and passed every test,
                // because the line above happened to put the row back.
                const pickerRow = this.objectSelect.closest
                    ? this.objectSelect.closest('.toggle-item') : null;
                const alone = pickerRow && [...pickerRow.children].every(
                    (el) => el === this.objectSelect
                        || (el.tagName === 'LABEL'
                            && el.htmlFor === this.objectSelect.id));
                if (alone) {
                    pickerRow.style.display =
                        this.objectSelect.options.length > 1 ? '' : 'none';
                }
                // ...the LIST still follows the mode, and the mode is the
                // button's business: hiding it here on a count would close a
                // list the user had opened.

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

            if (this.frameCounter) {
                this.frameCounter.textContent = `${total > 0 ? current : 0} / ${total}`;
            }

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
            //
            // 🔴 THE ICON IS MUTATED, NEVER REPLACED, AND THAT IS WHAT MAKES THE
            // BUTTON CLICKABLE WHILE IT PLAYS. This function is called from the
            // frame-advance timer on EVERY tick - 100 ms at 1x, 25 ms at 4x -
            // and it used to assign `innerHTML`, which destroys the <i> the
            // pointer went down on and builds a fresh one. Chrome fires `click`
            // only when mousedown and mouseup share a live common ancestor, so
            // a tick landing between a human's press and release (about 100 ms,
            // i.e. most of them) SWALLOWS THE PRESS ENTIRELY. Reported as the
            // play button not always responding when you press it to stop, and
            // needing several clicks - and it gets worse the faster you play,
            // which is the tell that it is the tick and not the handler.
            //
            // The record button below has always done it this way (it assigns
            // `icon.className`), which is why only Play had the fault.
            if (this.playButton) {
                const icon = this.playButton.querySelector('i');
                if (icon) {
                    // Web version with Font Awesome - use icons
                    const want = this.isPlaying
                        ? 'fa-solid fa-pause' : 'fa-solid fa-play';
                    if (icon.className !== want) icon.className = want;
                    // Checkbox-style: change button class based on state
                    if (this.isPlaying) {
                        this.playButton.classList.remove('btn-secondary');
                        this.playButton.classList.add('btn-primary');
                    } else {
                        this.playButton.classList.remove('btn-primary');
                        this.playButton.classList.add('btn-secondary');
                    }
                } else {
                    // Use symbols for play/pause. Guarded for the same reason:
                    // assigning textContent replaces the text node every tick.
                    const glyph = this.isPlaying ? '❚❚' : '▶︎';
                    if (this.playButton.textContent !== glyph) {
                        this.playButton.textContent = glyph;
                    }
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
            // ligand atom elements, blank-filled for the frames that have
            // none so the merged array stays in step with the coordinates
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
                position_elements: mergedPositionElements,
                residue_numbers: mergedResidueNumbers,
                // NO PAE ACROSS FRAMES. A matrix is a square over one
                // structure's residues, and an overlay holds several frames of
                // it at once; there is no such thing over the lot. This read
                // `this.pae`, which nothing has ever assigned - a dead
                // reference that reads as if the renderer kept one.
                pae: null,
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
            const resolvedPae = window.Heatmap ? window.Heatmap.resolveData(object, frameIndex)
                : (data.pae || null);
            const resolved = {
                ...data,
                plddts: resolvedPlddt ?? data.plddts ?? null,
                pae: resolvedPae !== null ? resolvedPae : data.pae,
                // THE FRAME'S OWN BONDS COME FIRST. This asked the object
                // and nothing else, so the frame's list - the one _subsetFrames
                // renumbers when a Cut or a Delete rewrites the positions - was
                // never read: after cutting a chain out, the object still held
                // the bonds of the structure that was there before, and every
                // ligand in what was left drew as loose atoms with its sticks
                // either gone or joining the wrong pair. The object's list
                // stays as the fallback for frames that carry none of their
                // own, which is most of a trajectory.
                bonds: (data.bonds && data.bonds.length) ? data.bonds
                    : (object.bonds || null)
            };
            return object.alignTransform ? this._transformedFrame(resolved, object.alignTransform)
                : resolved;
        }


        /**
         * The frame an object is PARKED ON - live for the current object,
         * saved for every other. Read by the merge and by the aligner, which
         * must agree: aligning a trajectory on frame 12 and drawing frame 0
         * would superpose one thing and show another.
         */
        _parkedFrameIndex(name) {
            const object = this.objectsData?.[name];
            if (!object || !object.frames?.length) return -1;
            const idx = (name === this.currentObjectName)
                ? this.currentFrame
                : (object.viewerState?.currentFrame ?? 0);
            return Math.max(0, Math.min(idx | 0, object.frames.length - 1));
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
         * is that ONE style draws the lot; see docs/MULTI_OBJECT_PLAN.md.
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
                const frameIdx = this._parkedFrameIndex(name);
                if (frameIdx < 0) continue;

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
            // THE VIEWER'S OWN CONTACTS GO TOO. An object's contacts belong to
            // it and vanish with it; these join two objects and live on the
            // viewer, so clearing the objects left them pointing at names that
            // no longer exist - inherited by whatever was loaded next, drawn or
            // silently dropped depending on whether the ends still resolved.
            this.crossContacts = [];
            // ...AND THE FOCUS MODE, for the same reason one line up: it holds
            // a snapshot naming objects that are about to stop existing, and a
            // latch that survives the clear puts the next structure straight
            // into a mode the reader did not ask for, wearing the previous
            // session's selection mark. Nothing is restored - there is nothing
            // left to restore it onto - except that mark, which the mode
            // borrowed from the reader and not from the structure.
            if (this._resetFocusState) this._resetFocusState();
            this.stopAnimation();

            // Reset data
            this.objectsData = {};
            this.currentObjectName = null;
            // ...and what was on screen with it. A shown set naming objects
            // that no longer exist would have the next load open into a merge
            // of one, and the merge state itself would outlive its array.
            this.shownObjects = new Set();
            this._framedObjects = new Set();
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
            if (this.heatmapRenderer) {
                this.heatmapRenderer.setData(null);
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
                ortho: this._orthoSetting(),
                focalLength: 200.0,
                center: null,
                extent: null,
                extentAspect: null,
                currentFrame: -1
            };
            this.isDragging = false;
            this.spinVelocityX = 0;
            this.spinVelocityY = 0;

            // Reset renderer state to defaults
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;
            this.shadowEnabled = true;
            this.autoRotate = false;
            this.colorblindMode = false;
            this.animationSpeed = 100;
            // cartoonShade, lineWidth, relativeOutlineWidth and outlineMode are
            // NOT set here. They belong to the look, and the look is applied
            // once at the end of this method - see the note there.
            this.currentFrame = -1;
            this.lastRenderedFrame = -1;
            if (this.shadowSlider) {
                this.shadowSlider.value = 0.5;
                this.shadowStrength = 0.5;
                this.shadowEnabled = true;
            }
            if (this.outlineModeButton) {
                this.updateOutlineButtonStyle();
            }
            if (this.rotationCheckbox) {
                this.rotationCheckbox.checked = false;
            }
            if (this.colorblindCheckbox) {
                this.colorblindCheckbox.checked = false;
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

            // ...AND THE LOOK, FROM THE ONE PLACE THAT KNOWS IT.
            //
            // This method used to state cartoonShade, lineWidth,
            // relativeOutlineWidth and outlineMode as literals - a fourth copy
            // of numbers that LOOK_DEFAULTS already holds - so Clear All
            // dropped richardson's shade of 0.7 to 1 and its outline of 1.0 to
            // 3.0 and left them there, on a viewer still calling itself
            // richardson. Loading again did not put them back, because nothing
            // re-enters the style you are already in.
            //
            // The latches go first: a reset that kept "the user has dragged
            // this" would restore the preset and then immediately override it
            // with the drag it is supposed to be clearing.
            // _widthByStyle is the per-style memory of a dragged Width; there
            // is deliberately no single "the user took it over" latch, because
            // one flag for both styles is how a tube radius arrived in cartoon
            // as a ribbon width - see tests/interaction.js, which forbids the
            // name outright and caught it being written back here.
            this._widthByStyle = {};
            this._applyLookDefaults(
                this.style === 'cartoon' ? (this.stylePreset || 'richardson') : 'tube');
            if (this._syncStylePanel) this._syncStylePanel();

            // Update UI controls
            this.updateUIControls();

            // Trigger render to show empty state
            this.render();
        }

        /**
         * SIDE CHAINS BECOME LIGAND POSITIONS.
         *
         * The atoms arrive as a side table of local-frame coefficients (see
         * buildSidechainTable in src/io/parse.js) which no hot path reads. When a
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
         * positions - see the side-chain pass in cartoon/geom.js.
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
            // THE TYPES OF THE FRAME BEING MATERIALISED, not the renderer's.
            //
            // this.positionTypes still describes the array that is being
            // REPLACED - setCoords has not run yet - so on any load that
            // changes the shape of the array it answers about the wrong
            // structure. Leaving Multi with a nucleic object on screen is that
            // case: the types were the merged array's, so index 3 of the RNA
            // read as some protein residue of the object beside it, the base
            // was rebuilt through the peptide's step range, localFrame failed
            // for every one of them, and all 347 atoms were dropped in
            // silence - the bases the user had just switched to full atoms
            // simply were not drawn.
            //
            // The frame carries its own types, exactly as long as its
            // coordinates. There is nothing to be out of step with.
            const posTypes = data.position_types || this.positionTypes || [];
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
            // one rule, three callers - see withSidechainAtoms. The map is
            // not on the renderer yet at this point in the load, so it is
            // handed in.
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
                    data.position_elements
                );
            } else {
                console.warn(`[_loadDataIntoRenderer] No data to load: coords=${data?.coords?.length}`);
            }
        }

        setCoords(coords, plddts, chains, positionTypes, hasPAE = false, positionNames, residueNumbers, skipRender = false, bonds = null, positionElements = null) {
            // Invalidate shadow cache when coordinates change (different geometry needs new shadows)
            this._invalidateShadowCache();
            this.lastShadowRotationMatrix = null;

            this.coords = coords;

            // WHAT THE FRAME RESOLVED TO, and nothing written back.
            //
            // This used to store the bonds it was handed onto the current
            // object, which made object.bonds a cache pretending to be data:
            // the object's list was rewritten on every load, so an edit that
            // left it in the old numbering was quietly healed the next time a
            // frame came through - until a path came along where no frame
            // carried bonds of its own and the stale list was all there was.
            // The object's list is DECLARED now (addFrame writes it, an edit
            // renumbers it) and read as a fallback in _resolvedFrame.
            if (bonds !== null && bonds !== undefined) {
                this.bonds = bonds;
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

            // THE CACHES BELONG TO ONE OBJECT, and nothing said so.
            //
            // _setDataField falls back to the last array it saw whenever the
            // frame does not carry one, which is right WITHIN an object - a
            // trajectory writes chains on frame 0 and omits them after - and
            // wrong the moment the object changes. The only guard was
            // `length === n`, so two objects of the SAME LENGTH inherit each
            // other's: load a 60-residue two-chain complex, switch to a
            // 60-residue single-chain model that carries no chains of its own,
            // and it is drawn as two chains, coloured by a chain break that is
            // not in it. Every field routed through here does it - plddts,
            // types, names, residue numbers, atoms and elements alike.
            //
            // So the run of calls below is one object's, and the caches are
            // dropped when that object is not the one they were filled for.
            // Here rather than inside _setDataField, because the seven calls
            // share the decision: the first would flip the owner and the other
            // six would then read the stale arrays as if they belonged.
            if (this._dataCacheObject !== this.currentObjectName) {
                this._dataCacheObject = this.currentObjectName;
                this.cachedPlddts = null;
                this.cachedChains = null;
                this.cachedPositionTypes = null;
                this.cachedPositionNames = null;
                this.cachedResidueNumbers = null;
                this.cachedPositionAtoms = null;
                this.cachedPositionElements = null;
            }

            // Use provided data if available, otherwise inherit from cache, otherwise use defaults
            this._setDataField('plddts', 'cachedPlddts', plddts, n, (n) => Array(n).fill(50.0));
            this._setDataField('chains', 'cachedChains', chains, n, (n) => Array(n).fill('A'));
            this._setDataField('positionTypes', 'cachedPositionTypes', positionTypes, n, (n) => Array(n).fill('P'));
            this._setDataField('positionNames', 'cachedPositionNames', positionNames, n, (n) => Array(n).fill('UNK'));
            this._setDataField('residueNumbers', 'cachedResidueNumbers', residueNumbers, n, (n) => Array.from({ length: n }, (_, i) => i + 1));
            // Blank everywhere but a ligand atom, which is the only position
            // that stands for one atom of the file rather than a whole residue.
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

            // Sync dropdown to renderer's colorMode (if dropdown exists).
            // THROUGH THE SHELL'S HELPER, because the SSE modes carry their
            // palette in the value - `ss:pymol` - and assigning the bare mode
            // would leave the box blank on a select that has no plain 'ss'
            // option showing. parts/ui.js installs it; without it (a harness
            // building a renderer by hand) the mode alone is what it always
            // was.
            if (this.colorSelect && this.colorMode) {
                const want = this._colorSelectValue
                    ? this._colorSelectValue() : this.colorMode;
                if (this.colorSelect.value !== want) {
                    this.colorSelect.value = want;
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

            // WHERE EACH RESIDUE SITS ALONG ITS CHAIN, and how long that
            // chain is - one walk, because the second answer falls out of the
            // first. The index counts 0, 1, 2... along each chain, so the
            // rainbow's range for that chain is 0 to the last index it handed
            // out; it was recomputed by a second pass over every position that
            // could only ever arrive at the same two numbers, and both passes
            // built a chain key per position to do it.
            //
            // A MERGED VIEW RAMPS EACH SOURCE ON ITS OWN - each frame of a
            // trajectory, or each object, running its own blue-to-red rather
            // than taking a slice of one ramp spread over the lot. Two copies
            // of the same protein should look like two copies of it. So the
            // count along a chain restarts at each source, and the scales are
            // kept per source; with one source they are kept per chain, and
            // the other table is left null so nothing reads the wrong one.
            this.perChainIndices = new Array(n);
            const chainIndices = {};        // running count, per chain
            const groups = this.sourceGroups();
            let lastFrame = -1;             // the source the walk is inside
            const scales = {};              // src -> chain -> {min, max}
            this.sourceRainbowScales = groups ? scales : null;
            this.chainRainbowScales = groups ? null : {};
            const scaleFor = (src, chainId) => {
                if (groups) {
                    const bySrc = scales[src] || (scales[src] = {});
                    return bySrc[chainId]
                        || (bySrc[chainId] = { min: 0, max: 0 });
                }
                return this.chainRainbowScales[chainId]
                    || (this.chainRainbowScales[chainId] = { min: 0, max: 0 });
            };
            for (let i = 0; i < n; i++) {
                const type = this.positionTypes[i];
                const chainId = this.chainKeyAt(i);
                const src = groups ? groups[i] : 0;
                // Chain A of the second source is not a continuation of
                // chain A of the first, so the count along it starts again.
                if (groups && src !== lastFrame) {
                    for (const key in chainIndices) chainIndices[key] = 0;
                    lastFrame = src;
                }
                const counts = (type === 'P' || type === 'D' || type === 'R'
                    || (type === 'L' && this.ligandOnlyChains.has(chainId)));
                if (!counts) {
                    this.perChainIndices[i] = 0;   // a ligand in a mixed chain
                    continue;
                }
                if (chainIndices[chainId] === undefined) chainIndices[chainId] = 0;
                const at = chainIndices[chainId]++;
                this.perChainIndices[i] = at;
                const scale = scaleFor(src, chainId);
                if (at > scale.max) scale.max = at;
            }

            // Pre-allocate rotatedCoords array
            if (this.rotatedCoords.length !== n) {
                this.rotatedCoords = Array.from({ length: n }, () => new Vec3(0, 0, 0));
            }

            // Check if we can reuse cached segment indices (bonds don't change within a frame)
            // ...AND THE ARRAY IT WAS BUILT FROM, by identity. The frame and
            // the object name do not describe the coordinate array once
            // several objects can be merged into it, or once side chains can
            // be appended to it: both leave that pair unchanged. Every path
            // that replaces the array does build a NEW one (see
            // _loadDataIntoRenderer), so a pointer comparison is exact - and
            // it cannot be forgotten the way an explicit invalidation can.
            //
            // The explicit invalidations stay: they are for the other
            // direction, where the array is the same and the segments are not
            // - a contact added, a bond list changed, the backbone hidden.
            const canUseCache = this.cachedSegmentIndices !== null &&
                this.cachedSegmentIndicesCoords === this.coords &&
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
                // 🔴 ONE FLAT NUMBER FOR EVERY PAIR OF ELEMENTS, and it was
                // the whole of what a notebook had: viewer.py forwards only
                // bonds a caller supplied by hand, so this fallback IS the
                // notebook's ligand chemistry, while the website got
                // src/io/parse.js's element table. One question, two answers,
                // decided by which page you were on.
                //
                // src/io/bonds.js is the table now and both read it. The flat
                // number stays as the fallback for a pair it does not name and
                // as an EXPLICIT override: `cutoffs.ligand_bond` set by a
                // caller means that number and nothing else, which is what it
                // has always meant.
                const ligandBondFlat = cutoffs.ligand_bond ?? 2.0;
                const ligandBondFixed = cutoffs.ligand_bond !== undefined
                    && cutoffs.ligand_bond !== null;
                const ligElems = (!ligandBondFixed && typeof bondMaxFor === 'function')
                    ? this.positionElements : null;
                // The prefilter has to be the LARGEST threshold in play or a
                // long bond is dropped before its own rule is asked.
                const ligandBondCutoff = ligElems
                    ? Math.max(ligandBondFlat, (typeof BOND_MAX_ANY === 'number')
                        ? BOND_MAX_ANY : ligandBondFlat)
                    : ligandBondFlat;
                // ...and the pair's own answer, for a candidate that passed it.
                const ligandBonded = ligElems
                    ? ((a, b, d2) => d2 < Math.pow(
                        bondMaxFor(ligElems[a], ligElems[b], ligandBondFlat), 2))
                    : ((a, b, d2) => d2 < ligandBondFlat * ligandBondFlat);
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
                const cyclic = (typeof this.config.rendering?.cyclic === 'boolean') ? this.config.rendering.cyclic : true;
                if (cyclic) {
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
                                if (distSq < ligandBondCutoffSq
                                    && ligandBonded(idx1, idx2, distSq)) {
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
                                if (distSq < ligandBondCutoffSq
                                    && ligandBonded(idx1, idx2, distSq)) {
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
                // ...AND THE VIEWER'S OWN LIST, which is not any object's and is
                // where a contact BETWEEN two of them lives. Both ends are
                // addresses, so there is no window to apply and no owner to
                // ask: it is drawn whenever both ends are on screen.
                const contactSources = this.drawnObjects().map((cName) => ({
                    list: (this.objectsData[cName] || {}).contacts,
                    win: this.localRangeOf(cName),
                }));
                contactSources.push({ list: this.crossContacts, win: null });
                for (const src of contactSources) {
                    const object = { contacts: src.list };
                    const win = src.win;
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
                this.cachedSegmentIndicesCoords = this.coords;
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
            this._noteArrayLoaded();

            // Load PAE data (use resolved value)
            if (window.Heatmap) {
                // We use updateFrame which handles data setting and visibility
                window.Heatmap.updateFrame(this, object, frameIndex);
            } else if (this.heatmapRenderer) {
                this.heatmapRenderer.setData(resolvedPae);
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
            const only = this.mergedObjectSet('elements');
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
            const v = obj && obj.sidechainColor && obj.sidechainColor[at];
            if (!v || typeof v !== 'string') return null;
            if (v[0] === '#') return hexToRgb(v);
            const named = namedColorsMap[v.toLowerCase()];
            if (named) return hexToRgb(named);
            // ...OTHERWISE IT IS A MODE, AND IT IS RESOLVED HERE RATHER THAN
            // WHEN IT WAS SET. Freezing it into hexes would be right for
            // hydrophobicity, which is a fact about the residue's identity and
            // never changes, and wrong for every other mode: plddt is per
            // frame, rainbow follows the chain scale, entropy arrives with an
            // alignment. A mode stored as a mode keeps answering.
            //
            // Through _colorForMode, NOT getAtomColor: the mode is the whole
            // point of the call, and getAtomColor would let the residue's own
            // explicit colour beat it - which is exactly the thing a
            // side-chain mode is being asked to differ from.
            const mode = (v === 'auto')
                ? this._getEffectiveColorMode(e.owner) : v;
            return this._colorForMode(e.owner, mode) || null;
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
         * occupies, so the view span takes them.
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
            const set = this.mergedObjectSet('hiddenBackbone');
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
        /**
         * WHAT THE ASSIGNMENT SAYS these residues are - one letter, or '' when
         * they disagree or nothing can be said.
         *
         * ASKED FOR, not scavenged. This used to read the two SS caches and
         * give up when both were absent, which is most of the time: they are
         * built during a render and _invalidateSegmentCache drops them, so
         * adding a contact or showing a side chain emptied them. The panel's
         * control then said "Helix" after one click and "DSSP" after the next
         * with nothing about the structure having changed - the instability
         * was in the question, not the answer. The cartoon module computes it
         * on a miss and caches it the same way the colour path does.
         */
        assignedSseFor(positions) {
            const n = this.coords ? this.coords.length : 0;
            let sec = (this._cartoonSec && this._cartoonSec.length === n)
                ? this._cartoonSec
                : ((this._ssColorSec && this._ssColorSec.length === n)
                    ? this._ssColorSec : null);
            if (!sec) {
                const C = (typeof window !== 'undefined') ? window.py2dmolCartoon : null;
                if (C && C.secondaryFor && n) {
                    const built = C.secondaryFor(this);
                    if (built && built.length === n) sec = built;
                }
            }
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
            // WHICH MARK, AND THE EARLIEST POSSIBLE EXIT FOR 'none'. Before the
            // projection below, which is a per-frame debt this method settles
            // on the GPU tube path - a reader who has turned the mark off
            // should not pay for one.
            const mark = SELECTION_MARKS.indexOf(this.selectionMark) >= 0
                ? this.selectionMark : 'highlight';
            if (mark === 'none') return;
            // A RING NEEDS SOMEWHERE OF ITS OWN TO PUNCH, and two callers
            // cannot give it one: an SVG export, where `destination-out` means
            // nothing and compositing a raster layer would put a BITMAP in the
            // file, and a context with no document behind it (the node
            // harnesses hand in a recording mock, where createElement answers
            // and getContext does not). Both fall back to the highlight,
            // which is the mark this had always been.
            const wantRing = mark === 'outline' && !ctx.getSerializedSvg;
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
            // 🔴 FROM THE SEGMENTS, WHICH IS WHAT THE STICKS ARE DRAWN FROM.
            //
            // This used to read `this.bonds` - the bond list a FILE carried -
            // and the comment above already claimed it was using the sticks'
            // own connectivity. On the website the two agree, because
            // src/io/parse.js derives ligand bonds and hands them over. On the
            // NOTEBOOK path they do not: viewer.py only ever passes bonds a
            // caller supplied by hand, so `this.bonds` is null for an ordinary
            // ligand - and the renderer falls back to distance for the STICKS
            // ("No bonds - will use distance calculation" in setCoords) while
            // the mark had no fallback at all. Every atom came out as an
            // isolated position, and an isolated position is drawn as a
            // zero-length segment with a round cap: a ring around each atom
            // instead of a band along the bonds. Reported from a notebook,
            // where 3PTB's benzamidine has ten bonds in the segment list and
            // none in `this.bonds`.
            //
            // The segment list is the one answer both are built from, so there
            // is nothing to keep in step.
            // ...AND ONLY WHEN SOMETHING SELECTED IS AN ATOM. Every edge this
            // finds has an atom at one end - that is the test inside the loop -
            // so a selection of ordinary residues cannot produce one, and
            // walking the segment list to discover that is pure cost: it is one
            // entry per drawn bond, 13,689 on a ribosome, EVERY FRAME while
            // anything is selected. Measured on 4UG0 with 20 residues selected:
            // 0.46 ms a frame against 0.02. The scan for an atom is over the
            // SELECTION, which is the small set.
            let anyAtom = false;
            for (let k = 0; k < idx.length; k++) {
                if (isAtom(idx[k])) { anyAtom = true; break; }
            }
            const segsAll = anyAtom ? this.segmentIndices : null;
            if (segsAll && segsAll.length) {
                for (const sg of segsAll) {
                    if (!sg || sg.type === 'C') continue;   // contacts, below
                    const a = sg.idx1; const b = sg.idx2;
                    if (a === undefined || b === undefined) continue;
                    if (!drawn(a) || !drawn(b)) continue;
                    if (!isAtom(a) && !isAtom(b)) continue;
                    addEdge(a, b);
                }
            } else if (anyAtom && this.bonds) {
                // ...and the file's own list where there are no segments yet,
                // which is a frame that has not been drawn.
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
            const onDark = this.backgroundColor === '#000000';
            ctx.strokeStyle = wantRing
                ? (onDark ? SELECTION_OUTLINE_DARK : SELECTION_OUTLINE_LIGHT)
                : SELECTION_HALO_CSS;
            if (wantRing) ctx.globalAlpha = SELECTION_OUTLINE_ALPHA;
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
            const bandFor = (r, ref) => selectionBandFor(r, pxScale, ref,
                wantRing ? SELECTION_OUTLINE_GAIN : SELECTION_HALO_GAIN);
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
            // 🔴 ALONG THE RIBBON, NOT ACROSS IT. A straight line between two
            // residues chords the drawn curve, and on a helix - which is a
            // ribbon spiralling THROUGH those residues - the chord falls 17 to
            // 22 px from the curve at a working zoom, against a band 9 px
            // wide. The mark zig-zagged over the thing it was marking.
            //
            // cartoon/geom.js records where it actually ran (`_traceProbe`,
            // about five points per residue) and the renderer keeps it in the
            // pre-rotation space, so this is the DRAWING's own curve rather
            // than a second smoothing to keep in step with it. Absent - the
            // tube, a structure over the size cap, a frame the cartoon has not
            // drawn - it is the straight line it always was, which is what the
            // tube draws anyway.
            // ...AND ONLY WHILE A CARTOON IS WHAT DREW IT. The trace outlives
            // a build on purpose, so after switching to the tube it is still
            // there, describing a ribbon that is no longer on the screen - and
            // a tube IS the straight lines between its residues.
            const trace = (this.style === 'cartoon') ? this._ribbonTrace : null;
            // THE PROJECTION, BUILT HERE RATHER THAN BORROWED. There are two
            // routines that fill screenX/screenY - the deferred one for the
            // GPU tube and the drawing pass everything else goes through - and
            // on a cached GPU cartoon frame NEITHER runs: the positions are
            // last frame's, still stamped valid because nothing moved. So a
            // parameter block left behind by one of them is a thing that is
            // usually there, which is the worst kind of dependency. Every term
            // is on the viewer state anyway.
            const pv = (this._viewScale && this.canvas) ? {
                cx: (this.canvas.clientWidth || this.canvas.width) / 2,
                cy: (this.canvas.clientHeight || this.canvas.height) / 2,
                scale: this._viewScale,
                persp: isPerspective(this.viewerState),
                fl: this.viewerState.focalLength,
                rot: this.viewerState.rotation,
                centre: this._computeViewCentre(
                    this.objectsData[this.currentObjectName]),
            } : null;
            const traceBetween = (a, b) => {
                if (!trace || !pv) return null;
                const lo = a < b ? a : b;
                return (b === lo + 1 || a === lo + 1) ? trace[lo] : null;
            };
            let lastX = 0; let lastY = 0;      // the path log's own scratch
            const strokeTrace = (c, flat, forward, log) => {
                const m = pv.rot;
                const ce = pv.centre || { x: 0, y: 0, z: 0 };
                const n = flat.length / 3;
                for (let k = 0; k < n; k++) {
                    const j = (forward ? k : n - 1 - k) * 3;
                    const dx = flat[j] - ce.x;
                    const dy = flat[j + 1] - ce.y;
                    const dz = flat[j + 2] - ce.z;
                    const rx = m[0][0] * dx + m[0][1] * dy + m[0][2] * dz;
                    const ry = m[1][0] * dx + m[1][1] * dy + m[1][2] * dz;
                    const rz = m[2][0] * dx + m[2][1] * dy + m[2][2] * dz;
                    let pe = 1;
                    if (pv.persp) {
                        const dzz = pv.fl - rz;
                        if (dzz <= 0.1) return false;      // behind the eye
                        pe = pv.fl / dzz;
                    }
                    const px = pv.cx + rx * pv.scale * pe;
                    const py = pv.cy - ry * pv.scale * pe;
                    if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
                    if (log) {
                        if (k > 0) log.drawn += Math.hypot(px - lastX, py - lastY);
                        lastX = px; lastY = py; log.pts++;
                    }
                }
                return true;
            };
            // WHAT THE MARK ACTUALLY STROKED, for a probe that has to tell a
            // curve from a chord without reading pixels. Off unless asked.
            const pathLog = (typeof window !== 'undefined' && window.__haloPath)
                ? (window.__haloPath = { chord: 0, drawn: 0, pts: 0, curved: 0 })
                : null;
            for (let k = 0; k + 1 < edges.length; k += 2) {
                const a = edges[k]; const b = edges[k + 1];
                const r = Math.min(radiusAt(a), radiusAt(b));
                const flat = traceBetween(a, b);
                if (pathLog) {
                    pathLog.chord += Math.hypot(sx[b] - sx[a], sy[b] - sy[a]);
                    if (flat) pathLog.curved++;
                }
                addTo(bucketOf(r, Math.min(refAt(a), refAt(b))), (c) => {
                    // ...and the straight line is the fallback INSIDE the
                    // closure, because whether a sample projects at all is a
                    // per-frame question: a point behind the eye has no screen
                    // position, and half a curve is worse than a chord.
                    if (flat && strokeTrace(c, flat, a < b, pathLog)) return;
                    if (pathLog) {
                        pathLog.drawn += Math.hypot(sx[b] - sx[a], sy[b] - sy[a]);
                        pathLog.pts += 2;
                    }
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
            // THE HIGHLIGHT SKIPS THE LAYER when it has a single width - one
            // translucent stroke composites correctly on its own. A RING
            // cannot: the punch below is `destination-out`, and against the
            // finished frame that would erase the DRAWING.
            const one = wantRing ? false : groups.size <= 1;
            let lctx = ctx;
            let layer = null;
            if (!one && typeof document !== 'undefined' && ctx.canvas) {
                layer = this._haloLayer
                    || (this._haloLayer = document.createElement('canvas'));
                if (layer.width !== ctx.canvas.width || layer.height !== ctx.canvas.height) {
                    layer.width = ctx.canvas.width; layer.height = ctx.canvas.height;
                }
                lctx = layer.getContext('2d');
                // ...and with no real 2d context behind it, the highlight it is.
                if (!lctx || typeof lctx.beginPath !== 'function') {
                    lctx = ctx; layer = null;
                } else {
                lctx.setTransform(1, 0, 0, 1, 0, 0);
                lctx.clearRect(0, 0, layer.width, layer.height);
                if (ctx.getTransform) {
                    const m = ctx.getTransform();
                    lctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
                }
                lctx.strokeStyle = wantRing
                    ? (onDark ? SELECTION_OUTLINE_DARK : SELECTION_OUTLINE_LIGHT)
                    : SELECTION_HALO_SOLID_CSS;
                lctx.lineJoin = 'round';
                lctx.lineCap = 'round';
                }
            }
            for (const [width, fns] of groups) {
                lctx.lineWidth = width;
                lctx.beginPath();
                for (const fn of fns) fn(lctx);
                lctx.stroke();
            }
            // ...AND THE MIDDLE COMES BACK OUT, for a ring. Each width group
            // is stroked again, thinner by two ring widths, with the layer as
            // the destination - so what is left of every band is its rim. One
            // group's punch may cut into another's rim where a side chain
            // crosses its backbone, and that is right: the mark is the outline
            // of the UNION, and a rim buried inside the union is not part of
            // it.
            if (layer && wantRing) {
                lctx.save();
                lctx.globalCompositeOperation = 'destination-out';
                for (const [width, fns] of groups) {
                    const inner = width - 2 * SELECTION_OUTLINE_PX * pxScale;
                    if (inner <= 0) continue;      // thinner than its own rim
                    lctx.lineWidth = inner;
                    lctx.beginPath();
                    for (const fn of fns) fn(lctx);
                    lctx.stroke();
                }
                lctx.restore();
            }
            if (layer) {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = wantRing
                    ? SELECTION_OUTLINE_ALPHA : SELECTION_HALO_ALPHA;
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

        /**
         * A COLOUR MODE'S ANSWER FOR ONE POSITION, and nothing else.
         *
         * This was the tail of getAtomColor and had no other way in, so a
         * caller that wanted "what would plddt say here" had to go through the
         * whole hierarchy - literal colours, frame colours, the side-chain
         * override - and get one of those back instead. `_sidechainColorOf`
         * wants exactly this: a side chain told to follow a MODE follows the
         * mode, not the residue's own explicit colour, which is the one thing
         * that call is asking to differ from.
         *
         * `atomIndex` is already resolved through _colorPositionFor by every
         * caller: a side-chain atom is coloured as the residue it belongs to.
         */
        _colorForMode(atomIndex, effectiveColorMode) {
            const type = (this.positionTypes && atomIndex < this.positionTypes.length) ? this.positionTypes[atomIndex] : undefined;
            let color;

            // Ligands should always be grey in chain and rainbow modes (not plddt)
            const isLigand = type === 'L';

            if (effectiveColorMode === 'hydrophobicity') {
                // BY RESIDUE IDENTITY, so it is the same answer in every frame
                // of a trajectory and needs nothing from the file but the name.
                color = getHydrophobicityColor(
                    this.positionNames && this.positionNames[atomIndex]);
            } else if (effectiveColorMode === 'plddt') {
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

            return this._colorForMode(atomIndex, effectiveColorMode);
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
                    // 🔴 AND IT STILL HAS TWO HALVES. This branch `continue`d
                    // straight past the halves assignment at the foot of the
                    // loop, so an override flattened a mixed bond to one
                    // colour and the heteroatom end lost its element colour -
                    // in plddt/deepmind ONLY, because _calculateSegmentColors
                    // reaches its own halves line by falling through rather
                    // than by jumping. An override is the colour of the atom
                    // that has no element of its own; it was never an answer
                    // for the other end. `hp` is computed above and was simply
                    // unused here.
                    if (hp && hp.a !== hp.b) {
                        colors.halves[i] = { a: hp.a || ov, b: hp.b || ov };
                    }
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
        /**
         * ONE END OF A CONTACT, WRITTEN AS AN ADDRESS.
         *
         *     {object: 'A', chain: 'X', residue: 12}
         *     {object: 'B', position: 34}
         *
         * Resolved against the WHOLE merged array, which is what lets the two
         * ends live in different structures. `object` picks the slice to search
         * - without it the search is global, and with two structures on screen
         * that means chain A of whichever comes first.
         *
         * `residue` is the author number from the file; `position` is an index
         * into that object's own numbering, or the merged array's when no
         * object is named. Returns -1 for anything it cannot find, and the
         * caller drops the contact.
         */
        _resolveContactEnd(end) {
            if (typeof end === 'number') return end;
            if (!end || typeof end !== 'object') return -1;
            // ...THE SAME SELECTOR AS EVERYTHING ELSE, which is what stops an
            // endpoint growing its own key names. It had `residue` where the
            // grammar says `residues`, and `position` where it says
            // `positions` - near-misses of exactly the kind that make an API
            // feel bigger than it is.
            //
            // EXACTLY ONE POSITION, or it is not an address. A selector that
            // matches a whole chain is a perfectly good selector and a
            // hopeless endpoint, and silently taking its first position would
            // draw a line to a residue nobody named.
            const set = positionsFor(this, end);
            if (set.size === 1) return set.values().next().value;
            console.warn('py2dmol: a contact endpoint must name ONE residue;'
                + ` ${JSON.stringify(end)} names ${set.size}`);
            return -1;
        }

        _resolveContactToIndices(contact, maxIndex = null, window = null) {
            if (!contact || !Array.isArray(contact)) return null;
            // The slice of the array belonging to the object that stored this
            // contact - the whole array when nothing is merged.
            const off = window ? window.off : 0;
            const stop = window ? window.end : Infinity;

            // AN ADDRESS AT EITHER END IS RESOLVED GLOBALLY, and that is the
            // whole of what makes a cross-object contact possible. The two
            // forms below both add ONE object's offset to BOTH ends and refuse
            // anything past its slice, so a contact between two structures
            // could not be written at all - parts/selectpanel.js says so out loud
            // when you try: "there is nowhere to store it".
            if ((contact[0] && typeof contact[0] === 'object' && !Array.isArray(contact[0]))
                || (contact[1] && typeof contact[1] === 'object' && !Array.isArray(contact[1]))) {
                const i1 = this._resolveContactEnd(contact[0]);
                const i2 = this._resolveContactEnd(contact[1]);
                if (i1 < 0 || i2 < 0) return null;
                return {
                    idx1: i1, idx2: i2,
                    weight: typeof contact[2] === 'number' ? contact[2] : 1.0,
                    color: (contact[3] && typeof contact[3] === 'object') ? contact[3] : null,
                };
            }

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
        _gpuWillTake(ctx, style) {
            if (this.useGPU !== true) return false;
            // DRAW IS A 2D EFFECT, so the frame has to be a 2D one.
            //
            // The build-up is three layers in an illustrator's order - graphite
            // under-drawing, colour wash, ink line - revealed along the chain by
            // a pen whose pace follows the local curvature, and all of it is
            // canvas compositing in cartoon/geom.js. The GPU knows nothing
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
            if ((style || this.style) === 'cartoon') {
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
        /**
         * IS THE RIBBON TRACE WORTH RECORDING? Asked by both painters, so the
         * cap is one number in one place rather than the same 20,000 written
         * into geom's caller and into paintgl's.
         *
         * It is about five points per residue: nothing on a protein, two
         * million numbers on a capsid - where the ribbons are a pixel wide and
         * the difference between a chord and a curve does not exist.
         */
        _wantRibbonTrace() {
            return (this.coords || []).length <= 20000;
        }

        /**
         * THE DRAWN RIBBON'S CENTRE LINE, KEPT IN A SPACE THAT SURVIVES A
         * TURN.
         *
         * cartoon/geom.js records it in ROTATED space - `M * (v - c)` for the
         * rotation and view centre of the frame that drew it - which is fine
         * for the 2D painter, that runs geom every frame, and useless on the
         * GPU path, where geom runs only on a mesh REBUILD and the reader
         * turns the view between rebuilds. A trace kept in that space is the
         * last rebuild's picture: feeding it to the projection put the PICKER
         * on stale geometry and `tests/multi_object.py` reported "nothing was
         * pickable even while drawn".
         *
         * So it is stored the way the coordinates themselves are - before the
         * user rotation and the centring - and re-rotated at use. Both
         * painters call this while their own frame's rotation is still
         * current, which is what makes the inverse below the right one.
         */
        _storeRibbonTrace(samples) {
            if (!samples || !samples.length) { this._ribbonTrace = null; return; }
            const m = this.viewerState.rotation;
            const object = this.objectsData[this.currentObjectName];
            const c = this._computeViewCentre(object) || { x: 0, y: 0, z: 0 };
            const out = [];
            for (let i = 0; i < samples.length; i++) {
                const pts = samples[i];
                if (!pts || !pts.length) continue;
                const flat = new Float64Array(pts.length * 3);
                for (let k = 0; k < pts.length; k++) {
                    const p = pts[k];
                    // M is orthonormal, so its inverse is its transpose
                    flat[k * 3] = m[0][0] * p[0] + m[1][0] * p[1] + m[2][0] * p[2] + c.x;
                    flat[k * 3 + 1] = m[0][1] * p[0] + m[1][1] * p[1] + m[2][1] * p[2] + c.y;
                    flat[k * 3 + 2] = m[0][2] * p[0] + m[1][2] * p[1] + m[2][2] * p[2] + c.z;
                }
                out[i] = flat;
            }
            this._ribbonTrace = out;
        }

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

        /**
         * THE POSITIONS ONE STYLE DRAWS, and only those: an object's own
         * positions, intersected with whatever the visibility mask allows.
         *
         * CACHED, because both painters key their geometry on the mask BY
         * IDENTITY - a fresh Set every frame is a rebuilt mesh every frame.
         * The answer depends on the drawn set, the mask and the array, and on
         * nothing else; all three are only ever replaced, never edited.
         */
        _styleMaskFor(names, slot, baseMask) {
            const cache = this._styleMaskCache || (this._styleMaskCache = {});
            // THE MASK THE FRAME STARTED WITH, passed in - not the live one.
            // The live one is being SWAPPED as each painter takes its turn, so
            // asking for the second painter's share while the first painter's
            // is installed intersected one object's positions with another
            // object's, and came out empty: the tube half of the frame simply
            // did not draw.
            const vis = baseMask === undefined ? this.visiblePositions : baseMask;
            const key = names.join(',');
            const hit = cache[slot];
            if (hit && hit.vis === vis && hit.arr === this.coords && hit.key === key) {
                return hit.out;
            }
            const own = this.positionsOfObjects(names);
            let out = own;
            if (vis) {
                out = new Set();
                for (const i of own) if (vis.has(i)) out.add(i);
            }
            cache[slot] = { vis, arr: this.coords, key, out };
            return out;
        }

        /**
         * TWO PAINTERS, ONE FRAME.
         *
         * An object carries its own style, so a merge can hold a ribosome
         * drawn as a tube beside a peptide drawn as a ribbon. The two are
         * different geometry models and stay different - but on the GPU they
         * write into the same framebuffer with the same depth buffer, so
         * interleaving them is free and exact: nearer wins, per pixel, with no
         * sorting anywhere. (The 2D path cannot do this. Its painter resolves
         * overlap by paint order, and two independent sorts cannot be merged
         * without one depth-sorted stream across both models - which is the
         * problem docs/PAINT_ORDER.md records every attempt at.)
         *
         * Each painter is shown only its own objects, by swapping the
         * visibility mask for the duration: both of them already build their
         * geometry from that mask and key it on the mask's contents, so
         * subsetting comes for free and each keeps its own mesh.
         *
         * ONE DEPTH RANGE FOR BOTH. Each model normally maps view z through
         * its OWN bounding range, and two different ranges are two different
         * depth scales - the picture would sort by which model a pixel came
         * from rather than by depth. The range handed to both is the drawn
         * extent, which contains everything either of them can draw.
         */
        /**
         * THE STYLE THE PICTURE IS DRAWN IN.
         *
         * `this.style` is the style of the object being EDITED - what the
         * Style panel describes and what a switch back to single-object mode
         * restores. It is not always what is on screen: light one eye on an
         * object you are not editing and the picture is that object's, so it
         * is drawn the way THAT object wants to be drawn.
         *
         * With two styles among the drawn objects there is no single answer
         * and the mixed path takes the frame; this returns the edited object's
         * so that everything downstream still has one to fall back on.
         */
        _drawStyle() {
            const groups = this.drawnStyleGroups();
            if (groups.size === 1) return groups.keys().next().value;
            return this.style;
        }

        _mixedGPUFrame(ctx, displayWidth, displayHeight, colors, object, groups) {
            const G = window.py2dmolCartoonGPU;
            if (!G || !G.render || !G.renderTube || !window.py2dmolCartoon) return false;
            if (!ctx || !ctx.canvas || !ctx.drawImage || ctx.getSerializedSvg) return false;
            const cartoonNames = groups.get('cartoon') || [];
            const tubeNames = groups.get('tube') || [];
            if (!cartoonNames.length || !tubeNames.length) return false;
            const framed = this.drawnStats() || object;
            // ...AND NO WIDER THAN IT HAS TO BE. Every depth bias in both
            // shaders - the outline's, the tube's skirt and caps - is a
            // constant in NDC, so widening the range makes each of them stand
            // for a LARGER distance in Angstrom. Measured on 1TIM + 1UBQ with
            // a range 20% too wide: the cartoon's outline lost to the tube
            // behind it over a fifth of the pixels where the two overlap.
            // maxExtent is already the bounding radius of what is drawn; the
            // margin covers a capsule's bulge and a ribbon's thickness.
            const R = ((framed && framed.maxExtent > 0) ? framed.maxExtent : 30) + 4;
            const z = [-R, R];
            const keep = this.visiblePositions;
            // ...AND EACH PAINTER DRAWS WITH ITS OWN STYLE'S SETTINGS. The
            // thickness, the outline, the detail and the rest are single
            // fields on the renderer holding whatever the style you last
            // SELECTED left there - so with a tube object picked, the cartoon
            // half of the picture was drawn with tube's numbers. Each style
            // keeps its own set (see STYLE_SETTINGS); the frame installs one
            // for each pass and puts back what it found.
            const keepStyle = this.style;
            this._keepStyleSettings(keepStyle);
            let prev = null;
            let drew = false;
            try {
                this.visiblePositions = this._styleMaskFor(cartoonNames, 'cartoon', keep);
                this.style = 'cartoon';
                prev = this._installStyleProfile('cartoon');
                const okC = G.render(this, ctx, displayWidth, displayHeight, colors,
                    { keep: false, blit: false, z });
                this.visiblePositions = this._styleMaskFor(tubeNames, 'tube', keep);
                this.style = 'tube';
                this._installStyleProfile('tube');
                // ...and it only KEEPS the frame if there is one to keep
                const okT = this._tubeGPUFrame(ctx, displayWidth, displayHeight,
                    colors, object, { keep: !!okC, blit: true, z });
                // the tube declining after the cartoon drew would leave the
                // frame on the offscreen canvas and never on the page
                if (okC && !okT) G.blit(ctx);
                drew = !!okC || !!okT;
                // WHICH HALF DREW, for the probes: two painters that decline
                // silently are indistinguishable from one that drew badly.
                if (typeof window !== 'undefined') {
                    window.__mixedFrame = { cartoon: !!okC, tube: !!okT,
                        nCartoon: this._styleMaskFor(cartoonNames, 'cartoon', keep).size,
                        nTube: this._styleMaskFor(tubeNames, 'tube', keep).size };
                }
            } finally {
                this.visiblePositions = keep;
                this.style = keepStyle;
                this._restoreStyleProfile(prev);
            }
            return drew;
        }

        _tubeGPUFrame(ctx, displayWidth, displayHeight, colors, object, compose) {
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
            // Pointer comparison is exact here: core/mol.js only ever
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
            const scale = this._viewportScale(displayWidth, displayHeight, object);
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
                // ...one painter of a composed frame, when it is one
                compose: compose || null,
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
         * cartoon/paintgl.js) for the same reason.
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

        /**
         * THE SCREEN POSITIONS DESCRIBE A PICTURE THAT IS NO LONGER THERE.
         *
         * screenX/Y and friends are written once per drawn frame and stamped
         * with screenFrameId; everything that reads them (pickResidueAt, the
         * selection halo) checks the stamp. A frame that draws NOTHING never
         * runs the projection loop, so the stamps from the last real frame
         * stayed valid and the picker went on answering out of them: with every
         * object switched off, clicking blank canvas selected a residue, and
         * double-clicking it selected a whole chain of a molecule that was not
         * on screen.
         *
         * Bumping the id is the whole invalidation - every stamp is now stale.
         * The pending GPU projection has to go with it, or _ensurePickProjection
         * would re-stamp the very coordinates being retired.
         */
        _invalidateScreenProjection() {
            this.screenFrameId++;
            this._pickPending = null;
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

        /**
         * HOW MANY PIXELS PER ANGSTROM, and the only place that decides it.
         *
         * 🔴 THERE WERE TWO. The GPU tube path computes the scale for itself
         * (it does not run the 2D block at all) and the 2D block computed it
         * again a thousand lines later - the same padding, the same extent,
         * the same min(). Giving the two screen axes their true shares was
         * written into one of them and measured as no change at all, because
         * the default build draws the tube on the GPU and never reached it.
         *
         * The extent is a RADIUS - how big - and extentAspect is how it is
         * SHAPED, normalised so the longer screen axis is 1. Both axes used to
         * get the radius unchanged, which fits the structure into a SQUARE of
         * side min(w, h) whatever the window is: a 598x298 viewer drew a rod
         * across 280 of its 598 pixels, laid out correctly by the best-view
         * search - which does read the aspect - and then framed as if the
         * canvas were square.
         *
         * The aspect is measured once, by parts/orient.js, under the rotation
         * it chose. Absent it is 1:1 and this is exactly what it always was.
         * It belongs to that rotation: turning a long structure end-on
         * afterwards can push it past the edge, and Orient reframes it.
         */
        /**
         * THE HALF-WIDTH AND HALF-HEIGHT BEING FRAMED, IN ANGSTROM.
         *
         * `extent`, `extentAspect` and `zoom` are four numbers that produce
         * exactly two, and the slack between them is where this file's camera
         * bugs have lived: orient and focus normalising the aspect differently,
         * the aspect assigned on completion while the extent interpolated, a
         * session saving one and not the other, a cached mesh dividing out the
         * size and not the shape, a linear zoom ramp against a geometric
         * extent. None of those are expressible once there is one answer.
         *
         *   extent * aspect.x  is the half-width the view span asks for
         *   dividing by zoom   is the same as multiplying the scale by it
         *
         * so the whole view span is this pair, and the scale is what fits it.
         * The three places that used to combine the fields themselves -
         * _viewportScale, cartoon/paintgl.js's view-span multiplier, and the
         * flight in parts/orient.js - ask here instead.
         *
         * @returns {{x: number, y: number}} Angstrom
         */
        /**
         * THE PROJECTION THE VIEWER IS ON: the slider when there is one, the
         * config when there is not.
         *
         * 🔴 IT WAS `slider ? value : 1` IN FOUR PLACES, so an embed and a
         * notebook - neither of which has an ortho slider - were ALWAYS
         * orthographic, whatever the config said. `normalizeConfig` carried
         * `rendering.ortho` and nothing read it: the same family as the `gpu`
         * and `shade` keys before it, except that this one is also documented
         * in viewer.py's signature and in embed.html, so three surfaces
         * promised a setting that did nothing.
         */
        _orthoSetting() {
            if (this.orthoSlider) return parseFloat(this.orthoSlider.value);
            const v = this.config && this.config.rendering
                && this.config.rendering.ortho;
            return (typeof v === 'number' && v >= 0 && v <= 1) ? v : 1;
        }

        _viewHalfSpan(object) {
            const framed = (this.drawnStats && this.drawnStats()) || object;
            const maxExtent = (framed && framed.maxExtent > 0)
                ? framed.maxExtent : 30.0;
            const extent = this.viewerState.extent || maxExtent;
            const a = this.viewerState.extentAspect;
            return halfSpanOf(extent, a, this.viewerState.zoom)
                || { x: 1, y: 1 };
        }

        _viewportScale(displayWidth, displayHeight, object) {
            // 0.85 IS MEASURED, NOT CHOSEN. The half-spans are the exact
            // projected extent of the POSITIONS, and a fit exact on the points
            // clips the ink drawn around them - at 0.9 the globular fixture's
            // ink crosses the canvas edge, which parts/orient.js predicted and
            // tests/python_multi.py checks. 0.85 is the largest of
            // 0.9 / 0.85 / 0.82 / 0.78 that clears it.
            //
            // A CONSTANT, and it has to be: cartoon/paintgl.js draws a cached
            // mesh by dividing out the view span it was captured under and
            // applying the live one, which only works while the view span is the
            // whole of the scale. Paying for the ink explicitly - the ribbon's
            // half-width in Angstrom, the outline in pixels - was written,
            // measured and reverted for exactly that: a reused mesh came out
            // at 1.099 of the wanted scale.
            const padding = 0.85;
            const half = this._viewHalfSpan(object);
            return Math.min((displayWidth * padding) / (half.x * 2),
                            (displayHeight * padding) / (half.y * 2));
        }

        _gpuWillDraw(ctx) {
            if (this.useGPU !== true) return false;
            if (this.drawMode) return false;      // see _gpuWillTake
            // 🔴 AND THE CONTEXT, WHEN THERE IS ONE. This asked from STATE
            // alone, and the comment beside it said being wrong costs a
            // repaint and never a wrong picture - which was true while the
            // answer only chose WHEN to do work. It also gates the CPU
            // occlusion pass, and that is work the fallback NEEDS: an SVG
            // export refuses the GPU (see _gpuWillTake) but this said yes, so
            // the shadows were never computed and the vector came out flat.
            // gpu + tube + svg, reported as "the shadow is lost".
            if (ctx && (ctx.getSerializedSvg || !ctx.drawImage || !ctx.canvas)) {
                return false;
            }
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
         * THE PICTURE IS DRAWN IN THE DRAWN OBJECT'S STYLE - and with that
         * STYLE'S SETTINGS.
         *
         * `this.style` belongs to the object being EDITED, which is not always
         * the object on screen: pick a tube object, then switch ITS eye off,
         * and what is left is a cartoon while the renderer still holds tube's
         * numbers - thickness 0, no pencil, a 3.0 outline. The cartoon was
         * then drawn with them, which is a plain ribbon: the drawing dropped
         * to Ribbon while the preset dropdown still said Richardson, because
         * the preset had not changed. Only the numbers had.
         *
         * The mixed path already installs a profile per pass; this is the same
         * rule for an ordinary single-style frame, which is why both go
         * through _installStyleProfile.
         */
        _renderToContext(ctx, displayWidth, displayHeight) {
            const drawStyle = this._drawStyle();
            if (drawStyle === this.style) {
                this._drawFrame(ctx, displayWidth, displayHeight);
                return;
            }
            const styleWas = this.style;
            const profileWas = this._installStyleProfile(drawStyle);
            this.style = drawStyle;
            // WHAT THE FRAME WAS ACTUALLY DRAWN WITH, for the probes: the
            // fields are put back before anything outside can read them, so
            // there is otherwise no way to tell a Richardson from a ribbon
            // except by looking at the pixels.
            if (typeof window !== 'undefined') {
                window.__drawProfile = { style: drawStyle,
                    thickness: this.cartoonThickness, pencil: this.cartoonPencil,
                    sheetFlat: this.cartoonSheetFlat,
                    outline: this.relativeOutlineWidth,
                    richardson: this.cartoonRichardson };
            }
            try {
                this._drawFrame(ctx, displayWidth, displayHeight);
            } finally {
                this.style = styleWas;
                this._restoreStyleProfile(profileWas);
            }
        }

        // Core rendering logic - can render to any context (canvas, SVG, etc.)
        /**
         * Which segment ends get a rounded cap: the OUTER ones.
         *
         * A segment end is outer when no other drawn segment shares that
         * position - the tip of a chain, or the edge of what visibility has
         * left on screen. Interior joints stay square, because a cap there
         * would show through the neighbour abutting it.
         *
         * Ninety-seven lines lifted out of _drawFrame, from between the shadow
         * pass and the projection loop. It closes over exactly three things -
         * free_vars said so before anything moved - and writes its answer into
         * this.segmentEndpointFlags, which it reads off the instance itself.
         *
         * @param {Array} segments - every segment, drawn or not
         * @param {Int32Array|Array} visibleOrder - indices of the drawn ones
         * @param {number} numRendered - how many of visibleOrder are live
         */
        _markOuterEndpoints(segments, visibleOrder, numRendered) {
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
        }

        /**
         * The tube style, painted: every visible segment, its outline and its
         * shadow, in one pass over visibleOrder.
         *
         * TWO HUNDRED AND THIRTY LINES OUT OF _drawFrame, which is the biggest
         * single thing in this file after the cartoon. It takes a FRAME STATE
         * rather than nineteen arguments, the same shape cartoon/geom.js hands
         * its own painter - free_vars counted twenty-four names this range
         * closes over, and five of those are plain this.* aliases it can read
         * back itself.
         *
         * @param {object} S - everything _drawFrame computed for this frame
         */
        _paintTubeSegments(S) {
            const { ctx, colors, segments, segData, visibleOrder, numRendered,
                    shadows, tints, zValues, displayWidth, displayHeight, isPerspective,
                    clipCull, pxScale, baseLineWidthPixels, outlineWidthPx,
                    renderShadows, SELECTION_INK_EXTRA } = S;
            // ...and the five read straight off the instance
            const currentScreenFrameId = this.screenFrameId;
            // ...written by _markOuterEndpoints, which took its own alias with
            // it when it was lifted out - so this reads the instance, like the
            // rest of the frame's scratch arrays.
            const segmentEndpointFlags = this.segmentEndpointFlags;
            const rotated = this.rotatedCoords;
            const screenValid = this.screenValid;
            const screenX = this.screenX;
            const screenY = this.screenY;

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
            // cartoon/geom.js - both go when the ink path does.
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

        _drawFrame(ctx, displayWidth, displayHeight) {
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
            // WHO IS DRAWN AND HOW. The style is per object; when the drawn
            // objects agree the frame has one style - theirs, which is not
            // always the edited object's - and when they do not, the mixed
            // path below draws both.
            const groups = this.drawnStyleGroups();
            const drawStyle = (groups.size === 1)
                ? groups.keys().next().value : this.style;
            const deferRot = this._gpuWillTake(ctx, drawStyle);
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

            // TWO STYLES AT ONCE, when the objects on screen disagree about
            // which one they want and the GPU is available to draw both into
            // one depth buffer. Everything below is the single-style path, and
            // it stays exactly as it was: this branch either draws the frame
            // or declines, and declining means the picture is drawn in
            // whatever style `this.style` says, as it always was.
            if (deferRot) {
                if (groups.size > 1
                    && this._mixedGPUFrame(ctx, displayWidth, displayHeight,
                        colors, object, groups)) {
                    this.gpuDrewLastFrame = true;
                    this._invalidateSelectionPreview();
                    this._paintOverlays(ctx, this._exportPxScale || 1, true);
                    return;
                }
            }

            // STYLE DELEGATION: 'cartoon' replaces the entire draw stage below.
            // The cartoon renderer (cartoon/geom.js) reuses the rotation and
            // per-segment colors computed above, plus this renderer's projection
            // parameters, and paints its own primitives (SS ribbons + tubes).
            if (drawStyle === 'cartoon'
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
                    // ...and tell us where the ribbon ran, if anything is
                    // selected. Nothing else reads it, so nothing else pays.
                    const wantTrace = this._wantRibbonTrace();
                    if (wantTrace) this._traceProbe = null;
                    window.py2dmolCartoon.render(this, ctx, displayWidth, displayHeight, colors);
                    if (wantTrace) {
                        this._storeRibbonTrace(this._traceProbe);
                        this._traceProbe = undefined;
                    }
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
            //
            // ...ASKED OF THIS CONTEXT. An export context is one the GPU will
            // refuse, and skipping the occlusion for it is not a stale guess
            // but a missing pass - see _gpuWillDraw.
            const gpuWillDraw = this._gpuWillDraw(ctx);
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

            // ...and no dataRange: it was the extent doubled, computed here
            // and read by nothing once _viewportScale became the one place
            // that decides the scale.

            // ...AND THE SCALE, from the one place that decides it. This
            // was a second copy of _viewportScale's arithmetic - same padding,
            // same extent, same min() - and the GPU tube path never reaches
            // this block at all, so a fix written here was measured as no
            // change on the default build.
            const scale = this._viewportScale(displayWidth, displayHeight, object);
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
            // ...and which of their ends are outer, and so rounded.
            this._markOuterEndpoints(segments, visibleOrder, numRendered);

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
            // ...and paint them. The state the pass needs, in one object.
            this._paintTubeSegments({
                ctx, colors, segments, segData,
                visibleOrder, numRendered, shadows, tints,
                zValues, displayWidth, displayHeight, isPerspective,
                clipCull, pxScale, baseLineWidthPixels, outlineWidthPx,
                renderShadows, SELECTION_INK_EXTRA,
            });
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
         * Detail is NOT forced up for an export: sampling is whatever the
         * Detail control says, here as on screen, so what you export is what
         * you were looking at. (It used to be capped by how big a residue came
         * out in the OUTPUT, which meant a 300 dpi PNG quietly got three times
         * the subdivision of the screen; that cap is gone - see subFloor in
         * cartoon/geom.js for why.)
         *
         * EXPORTS ARE ALWAYS TRANSPARENT, whatever the viewer background is set
         * to. A saved figure goes into a document whose page colour is not ours
         * to choose, and a baked-in white rectangle is far more annoying to
         * remove than a transparent one is to fill. The dark preset in
         * particular would otherwise export a black slab.
         */
    }

    // ...and the methods that live in sibling files, onto the class just made
    installMolParts(Pseudo3DRenderer);

    // ...and the container wired to it: the canvas, the controls, the data
    // the page arrived with, and the public API. See parts/ui.js.
    //
    // TWO WIRERS, CHOSEN BY THE CONFIG AND NEVER BY WHAT HAPPENS TO BE LOADED.
    // parts/ui.js expects the notebook's markup - forty-two controls it looks
    // up by id - and parts/embed.js expects a bare canvas. A page that asks for
    // the embed and did not load it gets a clear error here, not the panel
    // wirer reaching for controls that are not there.
    const rawConfig = (window.py2dmol_configs || {})[viewerId]
        || window.viewerConfig || {};
    if (rawConfig.embed) {
        if (typeof wireEmbedUI !== 'function') {
            console.error('py2dmol: config.embed is set but parts/embed.js is not'
                + ' loaded - use one of the embed bundles.');
            return;
        }
        wireEmbedUI(containerElement, viewerId, Pseudo3DRenderer);
        return;
    }
    wireViewerUI(containerElement, viewerId, Pseudo3DRenderer);

} // <-- End of initializePy2DmolViewer
