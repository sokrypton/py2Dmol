// ============================================================================
// src/panels/heatmap.js
// -------------------------------
// AI Context: THE RESIDUE x RESIDUE HEATMAP PANEL
// - Draws an N x N matrix over one object's residues, one byte per cell.
// - A drag on it is a selection of RESIDUES, cross-referenced with the viewer.
// - Several maps, picked with a tab strip; PAE is one of them. See MAP_SCALES.
// ============================================================================
// THE HEATMAP PANEL
// ============================================================================
// It was the PAE panel, under a name of its own. Nothing in the
// drag, the cells/residues crossings, the chain rules, the dim mask or the
// selection outlines was ever about predicted aligned error - only how a
// value becomes a byte and what colour a byte is, which is what MAP_SCALES
// holds. `window.PAE` and `window.PAERenderer` are kept as aliases below.
//
// WHAT DID NOT MOVE, and why: `frame.pae` / `frame.pae_n`, because every
// .ipynb ever saved
// carries them; and `pae_boxes` in a saved session file. The config switch
// is `heatmap` now, with `pae` aliased to the same object (normalizeConfig),
// and so are the markup ids - see PANEL_IDS.
// Loaded conditionally - every reader is guarded on `window.Heatmap`.

(function () {
'use strict';

// ============================================================================
// COLOUR UTILITIES
// ============================================================================
// hsvToRgb is generic; the two ramps under it are PAE's own - see MAP_SCALES,
// where each map names the ramp it is drawn with.
function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let r, g, b;
    if (h < 60) {
        r = c; g = x; b = 0;
    } else if (h < 120) {
        r = x; g = c; b = 0;
    } else if (h < 180) {
        r = 0; g = c; b = x;
    } else if (h < 240) {
        r = 0; g = x; b = c;
    } else if (h < 300) {
        r = x; g = 0; b = c;
    } else {
        r = c; g = 0; b = x;
    }
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
    };
}

// PAE color functions
function getPAEColor(value, colorblind = false) {
    // 0 (blue) to 15 (white) to 30 (red/orange)
    const v = Math.max(0, Math.min(30, (value || 0)));

    if (v <= 15.0) {
        // 0 (blue) -> 15 (white)
        // Hue is 240 (blue)
        // Saturation goes from 1.0 down to 0.0
        const norm_blue = v / 15.0; // 0 to 1
        const saturation = 1.0 - norm_blue;
        return hsvToRgb(240, saturation, 1.0);
    } else {
        // 15 (white) -> 30 (red or orange for colorblind)
        const norm_red = (v - 15.0) / 15.0; // 0 to 1
        const saturation = norm_red;
        const hue = colorblind ? 30 : 0; // Orange for colorblind, red for normal
        return hsvToRgb(hue, saturation, 1.0);
    }
}

function getPAEColor_DeepMind(value) {
    // DeepMind green gradient: 0 (dark green) to 30 (very light green)
    // Green gradient is already colorblind-safe, no variant needed
    const v = Math.max(0, Math.min(30, (value || 0)));
    const t = v / 30.0; // 0 to 1

    // Interpolate between dark green and very light green
    const r = Math.round(5 + (225 - 5) * t);
    const g = Math.round(113 + (243 - 113) * t);
    const b = Math.round(47 + (220 - 47) * t);

    return { r, g, b };
}

// ============================================================================
// WHAT A MAP IS: A BYTE CODEC AND A RAMP
// ============================================================================
// This panel draws an N x N matrix over residues, one BYTE per cell, and
// everything else it does - the drag, the cells/residues crossing, the chain
// rules, the dim mask, the selection outlines - is about that shape and not
// about what the numbers mean. Only two things were ever PAE: how a value
// becomes a byte, and what colour a byte is.
//
// `vmin`/`vmax` are that codec: a byte is the position between them, so
// `byte = round((value - vmin) / (vmax - vmin) * 255)`. PAE is 0 - 31.875 A,
// a sixteenth of an Angstrom a byte - and both PAE ramps clamp at 30, so the
// top fifteen bytes are one colour. That is the behaviour there has always
// been and it is reproduced here exactly. A MAP MAY STATE ITS OWN, along
// with `colors` (stops) and `xlabel`/`ylabel`; all of them beat the registry
// entry for its key, which is what makes the panel configurable without
// editing this file. The tab's NAME is the key - see labelFor.
//
// `ramp` takes the DECODED value, in the map's own units, which is what lets
// getPAEColor stay written the way it was written. It is also handed the
// viewer's colour mode - and PAE'S RAMP IS THE ONLY ONE THAT MAY READ IT.
// Picking the DeepMind green because the structure is coloured DeepMind-style
// is a statement about predicted aligned error; a probability inherits none
// of it.
const MAP_SCALES = {
    pae: {
        label: 'PAE',
        empty: 'No PAE Data',
        // 0 - 31.875 A, which is 255 bytes at a sixteenth of an Angstrom -
        // what `perUnit: 8` used to say. Both ramps clamp at 30, so the top
        // fifteen bytes are one colour; that is the behaviour there has
        // always been and it is reproduced here exactly.
        vmin: 0,
        vmax: 255 / 8,
        // AlphaFold's own reading of the matrix: the value at (x, y) is the
        // expected error at residue x when the prediction is superposed on
        // residue y. So the columns are what is SCORED and the rows are what
        // it is ALIGNED on.
        xlabel: 'Scored position',
        ylabel: 'Aligned position',
        ramp: (value, colorblind, mode) => (mode === 'deepmind')
            ? getPAEColor_DeepMind(value)
            : getPAEColor(value, colorblind),
    },
    // p(contact): a probability, so the domain is exactly 0-1 and a byte is
    // 1/255 of it. WHITE IS ZERO AND THE INK IS THE SIGNAL, which is the
    // opposite reading from PAE's - there low is the good news and the plot
    // is blue where the model is sure. A contact map has nothing to be sure
    // about; it has somewhere it says yes, and that is what should be dark.
    // One hue, monotone in lightness, so it needs no colourblind variant for
    // the same reason the DeepMind ramp does not.
    contact: {
        label: 'Contact',
        empty: 'No Contact Map',
        vmin: 0,
        vmax: 1,
        // 🔴 A CONTACT MAP CAPTIONS ITS AXES BECAUSE PAE DOES. Both are
        // symmetric in the residue index and neither caption says anything
        // surprising - but the panel reserves its axis bands for the maps it
        // HOLDS, so a map with no caption beside one with two makes the
        // reservation change the moment the second arrives. A prediction adds
        // them at different times: the contact map comes off the trunk before
        // there is a structure, the PAE only after the confidence head. So the
        // plot resized mid-fold, which is the same jump switching tabs used to
        // produce and has the same cure.
        xlabel: 'Position',
        ylabel: 'Position',
        ramp: (value) => {
            const t = Math.max(0, Math.min(1, value || 0));
            return {
                r: Math.round(255 + (37 - 255) * t),
                g: Math.round(255 + (52 - 255) * t),
                b: Math.round(255 + (148 - 255) * t),
            };
        },
    },
};
const DEFAULT_MAP_KEY = 'pae';
const MAP_ORDER = Object.keys(MAP_SCALES);
// 🔴 A MAP THIS FILE HAS NEVER HEARD OF IS NOT A PAE. Falling back to the
// default key gave an unknown map PAE's ramp AND PAE's codec: a 0-1 quantity
// decoded at eight bytes per unit is every cell inside the first eighth of
// the scale, drawn as one flat blue - a plausible picture of nothing. The
// generic scale is a probability, because that is what an unnamed residue x
// residue map almost always is, and it is GREY so that it cannot be mistaken
// for one of the two the panel actually understands. Its `per_unit` still
// arrives with the data and wins; this is only what to do without one.
const GENERIC_SCALE = {
    label: null,   // labelFor falls back to the key, which is its name
    empty: 'No Data',
    vmin: 0,
    vmax: 1,
    // 🔴 AND IT RAMPS OVER THE MAP'S OWN DOMAIN, NOT OVER 0-1. A scale with
    // no opinion about units has no business assuming the values are
    // probabilities - `perUnit` is exactly the declaration that they are
    // not, since a map states its own `vmin`/`vmax`. The first version
    // clamped the decoded VALUE at 1, so a distance map over 0-127 A drew
    // its top 99% as flat black: arithmetically fine, visually empty, and it
    // passed a "has it got more than 20 colours" check because the bottom 1%
    // still ramped. `frac` is the byte over 255, which IS the position
    // between whatever vmin and vmax the map declared.
    ramp: (value, colorblind, mode, frac) => {
        const t = Math.max(0, Math.min(1, frac || 0));
        const c = Math.round(255 + (34 - 255) * t);
        return { r: c, g: c, b: c };
    },
};
const scaleFor = (key) => MAP_SCALES[key] || GENERIC_SCALE;

// 🔴 A RAMP THAT A CALLER CAN STATE HAS TO BE DATA, NOT A FUNCTION. It comes
// from Python through JSON and from a host page through a config object, so
// `colors` is a list of stops and this turns it into the same (value, cb,
// mode, frac) callback the built-in ramps are. Two forms:
//
//   ['#ffffff', '#253494']                     evenly spaced
//   [[0, '#00f'], [0.5, '#fff'], [1, '#f00']]  positions stated
//
// It ramps on `frac` - the position between the map's vmin and vmax - which
// is what a stop list means. The built-ins stay functions because PAE's is
// HSV-based and not a lerp; a caller's `colors` overrides whichever it is.
function parseHexColor(h) {
    if (typeof h !== 'string') return null;
    let t = h.trim().replace(/^#/, '');
    if (t.length === 3) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2];
    if (t.length !== 6 || /[^0-9a-fA-F]/.test(t)) return null;
    return {
        r: parseInt(t.slice(0, 2), 16),
        g: parseInt(t.slice(2, 4), 16),
        b: parseInt(t.slice(4, 6), 16),
    };
}

function rampFromStops(colors) {
    if (!Array.isArray(colors) || colors.length === 0) return null;
    const pts = [];
    for (let i = 0; i < colors.length; i++) {
        const s = colors[i];
        const stated = Array.isArray(s);
        const c = parseHexColor(stated ? s[1] : s);
        if (!c) continue;
        const t = stated ? Number(s[0])
            : (colors.length > 1 ? i / (colors.length - 1) : 0);
        if (!isFinite(t)) continue;
        pts.push({ t: Math.max(0, Math.min(1, t)), c });
    }
    if (pts.length === 0) return null;
    pts.sort((a, b) => a.t - b.t);
    // A single stop is a flat fill, which is a legitimate thing to ask for.
    if (pts.length === 1) return () => pts[0].c;
    return (value, colorblind, mode, frac) => {
        const t = Math.max(0, Math.min(1, frac || 0));
        let k = 1;
        while (k < pts.length - 1 && pts[k].t < t) k++;
        const a = pts[k - 1], b = pts[k];
        const span = b.t - a.t;
        const u = span > 0 ? Math.max(0, Math.min(1, (t - a.t) / span))
                           : (t < a.t ? 0 : 1);
        return {
            r: Math.round(a.c.r + (b.c.r - a.c.r) * u),
            g: Math.round(a.c.g + (b.c.g - a.c.g) * u),
            b: Math.round(a.c.b + (b.c.b - a.c.b) * u),
        };
    };
}

// 🔴 THE MARKUP IDS TOOK THE SAME TREATMENT AS `window.PAE`, and it was
// inconsistent not to at first. A host page OWNS this markup - three shells
// here and every embedding page elsewhere - so renaming the id outright is a
// panel that silently never mounts. But an id that says `pae` on a box
// holding a contact map is exactly the confusion the rename exists to
// remove, and it is the MOST visible of the old names because it is the one
// a host page author types. So: the new id wins, the old one still works,
// and the documentation teaches the new. Same shape as the JS aliases and
// the `paeBoxes:` patch key.
const PANEL_IDS = ['#heatmapContainer', '#paeContainer'];
const CANVAS_IDS = ['#heatmapCanvas', '#paeCanvas'];
const findIn = (root, ids) => {
    if (!root) return null;
    for (const id of ids) {
        const el = root.querySelector(id);
        if (el) return el;
    }
    return null;
};
// Stated outright rather than through a class: the strip is built into a
// container whose stylesheet belongs to whichever shell is hosting it, and
// two of the three define nothing it could inherit. Same reason
// SELECTION_PANEL_CSS spells out every value it needs.
// The chrome around the plot, in pixels. The canvas stays 100% PLOT - it is
// inset by these and nothing inside it moves - which is what keeps the
// cells/residues crossings the panel already has from gaining a third term.
const HM_TAB_H = 22;
const HM_AXIS = 15;
const HM_AXIS_CSS = 'position: absolute; font: 10px/1 system-ui, sans-serif;'
    + ' color: #666; letter-spacing: 0.02em; pointer-events: none;'
    + ' white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
// SHAPED LIKE A BROWSER TAB: rounded on top only and no bottom border, so it
// sits ON the plot's top edge and reads as attached to it. That says "this is
// the one you are looking at" from the SHAPE; the pills this replaced said it
// only through fill, which gets weaker the more tabs there are.
// NO BAR LINE UNDER IT: the strip carried a hairline for the active tab to
// merge into, and across a plot that is a rule drawn over the data for no
// reason - the tab's own outline is the whole cue. The active fill is the
// panel's white, which every shell gives the container.
// 🔴 A TAB HAS TO LOOK LIKE ONE, WHICH MEANS A BASELINE IT BREAKS THROUGH.
// These were a white chip on a white panel with a #dcdcdc hairline, which is
// almost invisible - the reader could not tell there were two maps, let alone
// which was showing. The strip now carries a bottom rule and the ACTIVE tab
// overlaps it by a pixel (margin-bottom: -1px, no bottom border, white fill),
// so it reads as continuous with the plot while the others sit behind the
// line. That is the oldest tab idiom there is and it needs no colour.
const MAP_TAB_CSS = 'font: 11px/1 system-ui, sans-serif;'
    + ' padding: 4px 12px 6px; border: 1px solid #bcbcbc;'
    + ' border-bottom: none; border-radius: 6px 6px 0 0; margin: 0 0 -1px 0;'
    + ' cursor: pointer; box-sizing: border-box; letter-spacing: 0.01em;'
    + ' max-width: 46%; overflow: hidden; text-overflow: ellipsis;'
    + ' white-space: nowrap; position: relative;'
    // ...and they SHRINK rather than overrun a narrow plot: four tabs at
    // 46% would be 184% of it. min-width 0 is what lets a flex item ellipsis
    // at all - without it the content width is the floor.
    + ' flex: 0 1 auto; min-width: 0;';
// The tab's text: what the panel calls that kind of map, else the KEY.
// There is no per-map `title`. The key already names the map, and a second
// name for the same thing bought nothing but a way for the two to disagree -
// and it cost a per-frame mutation path of its own, because a title can
// change between frames where a key cannot: the strip is rebuilt only when
// the key SET changes (rebuilding destroys the button under the pointer), so
// a retitled map needed its text patched in place every frame. Name the key
// what you want to read.
const labelFor = (key) => (MAP_SCALES[key] && MAP_SCALES[key].label) || key;

// ============================================================================
// PAE RENDERER CLASS
// ============================================================================
class HeatmapRenderer {
    constructor(canvas, mainRenderer) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false }); // Optimize for opaque canvas
        this.mainRenderer = mainRenderer; // Reference to Pseudo3DRenderer

        this.bytes = null;
        // WHICH MAP THIS IS. One canvas, one renderer, and the data is
        // swapped - see MAP_SCALES. Defaults to PAE, which is what every
        // caller that predates this asks for by asking for nothing.
        this.mapKey = DEFAULT_MAP_KEY;
        this.scale = MAP_SCALES[DEFAULT_MAP_KEY];
        this.maps = null;      // every map available at the current frame
        this._wantKey = null;  // ...and which of them the reader asked for
        this.tabStrip = null;  // built by initialize(), hidden below two maps
        this._tabKeys = '';
        this.n = 0; // Matrix dimension, in CELLS
        this.residues = 0; // ...and in RESIDUES, which a resampled matrix
                           // has more of than it has cells.

        // Use canvas internal width for size (canvas may be stretched by CSS)
        // This ensures rendering coordinates match mouse coordinates
        this.size = canvas.width;

        this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
        this.isDragging = false;
        this.isAdding = false; // Track if Shift is held for additive selection

        // Performance optimization: cache base image and selection state
        this.baseCanvas = null; // Offscreen canvas for base heatmap
        this.lastSelectionHash = null; // Hash of last selection state to detect changes
        this.renderScheduled = false; // Flag to prevent multiple queued renders
        this.cachedSequencePositions = null; // Cache sequence selected positions

        this.setupInteraction();

        // Listen for selection changes to re-render PAE with sequence selections
        if (typeof document !== 'undefined') {
            this.selectionChangeHandler = () => {
                if (this.bytes) {
                    // Invalidate cache when selection changes
                    this.lastSelectionHash = null;
                    this.cachedSequencePositions = null;
                    this.scheduleRender();
                }
            };
            document.addEventListener('py2dmol-visibility-change', this.selectionChangeHandler);

            // Listen for color mode changes to re-render PAE with new color scheme
            this.colorChangeHandler = () => {
                if (this.bytes) {
                    // Invalidate base image cache to force regeneration with new colors
                    this._scaleSig = null;
                    this.baseCanvas = null;
                    this.scheduleRender();
                }
            };
            document.addEventListener('py2dmol-color-change', this.colorChangeHandler);
        }
    }

    /**
     * SHOW THIS MAP, whatever the frame's set offers first. A slot names a
     * map; the panel in it is pinned to that key the way a tab click pins it,
     * through `_wantKey`, so a frame step keeps it there.
     */
    pin(key) {
        this._wantKey = key;
        if (this.parked) return;
        if (this.maps && this.maps[key] && (key !== this.mapKey || !this.bytes)) {
            this._selectMap(key, this.maps[key]);
        }
    }

    /**
     * 🔴 A PANEL NO SLOT SHOWS HOLDS NO PICTURE. The decoded matrix is n^2
     * bytes and the colour image 4n^2 - 9 MB for a 1,500-residue PAE - and a
     * parked panel kept both and went on rebuilding them on every frame that
     * brought a new map. Parked, it keeps only the REFERENCE to the frame's
     * maps (which the frame owns anyway) and decodes on the way back out.
     */
    park() {
        if (this.parked) return;
        this.parked = true;
        this.bytes = null;
        this.baseCanvas = null;
        this._rawSource = null;
        this._scratch = null;
    }

    unpark() {
        if (!this.parked) return;
        this.parked = false;
        const key = this.maps && (this.maps[this._wantKey] ? this._wantKey
            : (this.maps[this.mapKey] ? this.mapKey : Object.keys(this.maps)[0]));
        if (key) this._selectMap(key, this.maps[key]);
        else this.scheduleRender();
    }

    /** A pooled panel going away: its document listeners go with it. */
    destroy() {
        this.park();
        this.maps = null;
        if (typeof document !== 'undefined') {
            document.removeEventListener('py2dmol-visibility-change', this.selectionChangeHandler);
            document.removeEventListener('py2dmol-color-change', this.colorChangeHandler);
        }
        if (this._resizeObserver) this._resizeObserver.disconnect();
    }

    // Schedule render using requestAnimationFrame to throttle
    scheduleRender() {
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        requestAnimationFrame(() => {
            this.renderScheduled = false;
            this.render();
        });
    }

    // Expand ligand positions
    expandLigandPositions(positionIndices) {
        if (typeof expandLigandSelection === 'function') {
            // ...in MERGED indices, like the positions handed in - the
            // object's own groups are in its own numbering, and matched
            // against merged indices they expand nothing (or somebody
            // else's ligand).
            const groups = this.mainRenderer.mergedLigandGroups
                ? this.mainRenderer.mergedLigandGroups()
                : (this.mainRenderer.ligandGroupsOf
                    ? this.mainRenderer.ligandGroupsOf(this.mainRenderer.currentObjectName)
                    : null);
            if (groups) return expandLigandSelection(positionIndices, groups);
        }
        return new Set(positionIndices);
    }

    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        // Support both mouse and touch events
        const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
        const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);

        const displayX = clientX - rect.left;
        const displayY = clientY - rect.top;

        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;

        return {
            x: displayX * scaleX,
            y: displayY * scaleY
        };
    }

    getCellIndices(e) {
        const { x, y } = this.getMousePos(e);
        if (!this.bytes) return { i: -1, j: -1 };
        const n = this.n;
        if (n === 0) return { i: -1, j: -1 };
        const cellSize = this.size / n;
        const i = Math.floor(y / cellSize);
        const j = Math.floor(x / cellSize);
        return { i, j };
    }

    /**
     * A block of cells out to the residues it covers, inclusive both ends.
     * The identity when the matrix was not resampled.
     */
    cellsToResidues(i_start, i_end, j_start, j_end) {
        const k = this.n;
        const N = this.residues || k;
        if (!k || N === k) return { i_start, i_end, j_start, j_end };
        const lo = (c) => Math.floor(c * N / k);
        const hi = (c) => Math.min(N - 1, Math.floor((c + 1) * N / k) - 1);
        return { i_start: lo(i_start), i_end: hi(i_end),
                 j_start: lo(j_start), j_end: hi(j_end) };
    }

    /** ...and a residue back to the cell that drew it. */
    residueToCell(r) {
        const k = this.n;
        const N = this.residues || k;
        if (!k || N === k) return r;
        return Math.min(k - 1, Math.floor(r * k / N));
    }

    setupInteraction() {
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || !this.bytes) return;
            this.isAdding = e.shiftKey;
            if (!this.isAdding) {
                this.mainRenderer.setVisibility({
                    heatmapBoxes: [], positions: new Set(), chains: new Set(), visibilityMode: 'explicit'
                }, true);
            }
            this.isDragging = true;
            const { i, j } = this.getCellIndices(e);
            this.selection.x1 = j; this.selection.y1 = i;
            this.selection.x2 = j; this.selection.y2 = i;
            this.lastSelectionHash = null;
            this.scheduleRender();

            const handleMove = (e) => {
                if (!this.isDragging || !this.bytes) return;
                let cellIndices;
                try { cellIndices = this.getCellIndices(e); } catch (err) { return; }
                const { i, j } = cellIndices;
                const n = this.n;
                const newX2 = Math.max(0, Math.min(n - 1, j));
                const newY2 = Math.max(0, Math.min(n - 1, i));
                if (this.selection.x2 !== newX2 || this.selection.y2 !== newY2) {
                    this.selection.x2 = newX2; this.selection.y2 = newY2;
                    this.scheduleRender();
                }
            };

            const handleUp = (e) => {
                if (!this.isDragging) return;
                handleEnd(e);
                window.removeEventListener('mousemove', handleMove);
                window.removeEventListener('mouseup', handleUp);
            };
            window.addEventListener('mousemove', handleMove);
            window.addEventListener('mouseup', handleUp);
        });

        const handleEnd = (e) => {
            if (!this.isDragging) return;
            this.isDragging = false;
            let i_start = Math.min(this.selection.y1, this.selection.y2);
            let i_end = Math.max(this.selection.y1, this.selection.y2);
            let j_start = Math.min(this.selection.x1, this.selection.x2);
            let j_end = Math.max(this.selection.x1, this.selection.x2);
            const n = this.n;
            if (n === 0 || i_start < 0 || j_start < 0) {
                this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                this.render();
                return;
            }
            const isClick = (i_start === i_end && j_start === j_end);
            if (isClick) {
                this.mainRenderer.setVisibility({
                    heatmapBoxes: [], positions: new Set(), chains: new Set(), visibilityMode: 'default'
                }, false);
                this.cachedSequencePositions = null;
                this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
            } else {
                // A BOX IS A RANGE OF RESIDUES, not of cells. setVisibility
                // reads i_start..i_end as position indices, so a resampled
                // matrix has to be scaled back out here - the whole cell is
                // covered, so the end is the LAST residue of the last cell.
                ({ i_start, i_end, j_start, j_end } = this.cellsToResidues(
                    i_start, i_end, j_start, j_end));
                const newBox = { i_start, i_end, j_start, j_end };
                const currentSelection = this.mainRenderer.getVisibility();
                const existingBoxes = currentSelection.heatmapBoxes || [];
                const existingPositions = currentSelection.positions || new Set();
                // A PAE ROW IS A RESIDUE OF THIS OBJECT, and the mask
                // speaks merged indices - so a box drawn on the second
                // object's matrix used to hide the first object's residues.
                const srcOff = this.mainRenderer.sourceOffsetOf
                    ? this.mainRenderer.sourceOffsetOf(Heatmap.heatmapObject(this.mainRenderer)) : 0;
                const newPositions = new Set();
                const inRange = (r) => (r + srcOff) >= 0
                    && (r + srcOff) < this.mainRenderer.chains.length;
                for (let r = i_start; r <= i_end; r++) if (inRange(r)) newPositions.add(r + srcOff);
                for (let r = j_start; r <= j_end; r++) if (inRange(r)) newPositions.add(r + srcOff);
                const expandedNewPositions = this.expandLigandPositions(newPositions);

                if (this.isAdding) {
                    const expandedExistingPositions = this.expandLigandPositions(existingPositions);
                    const combinedBoxes = [...existingBoxes, newBox];
                    const combinedPositions = new Set([...expandedExistingPositions, ...expandedNewPositions]);
                    const newChains = new Set();
                    if (this.mainRenderer.chains) {
                        for (const pos of combinedPositions) {
                            if (pos >= 0 && pos < this.mainRenderer.chains.length) {
                                newChains.add(this.mainRenderer.chainKeyAt
                                    ? this.mainRenderer.chainKeyAt(pos)
                                    : this.mainRenderer.chains[pos]);
                            }
                        }
                    }
                    const hasPartialSelections = combinedPositions.size > 0 && combinedPositions.size < (this.mainRenderer.chains?.length || 0);
                    this.mainRenderer.setVisibility({
                        heatmapBoxes: combinedBoxes, positions: combinedPositions, chains: newChains,
                        visibilityMode: hasPartialSelections ? 'explicit' : 'default'
                    }, false);
                } else {
                    const newChains = new Set();
                    if (this.mainRenderer.chains) {
                        for (const pos of expandedNewPositions) {
                            if (pos >= 0 && pos < this.mainRenderer.chains.length) {
                                newChains.add(this.mainRenderer.chainKeyAt
                                    ? this.mainRenderer.chainKeyAt(pos)
                                    : this.mainRenderer.chains[pos]);
                            }
                        }
                    }
                    const hasPartialSelections = expandedNewPositions.size > 0 && expandedNewPositions.size < (this.mainRenderer.chains?.length || 0);
                    this.mainRenderer.setVisibility({
                        heatmapBoxes: [newBox], positions: expandedNewPositions, chains: newChains,
                        visibilityMode: hasPartialSelections ? 'explicit' : 'default'
                    }, false);
                }
                this.cachedSequencePositions = null;
            }
            this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
            this.lastSelectionHash = null;
            this.cachedSequencePositions = null;
            this.scheduleRender();
        };

        this.canvas.addEventListener('mouseup', handleEnd);
        // Touch handling omitted for brevity but should be preserved if copied from original
        this.canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1 || !this.bytes) return;
            e.preventDefault();
            this.isAdding = false;
            this.mainRenderer.setVisibility({ heatmapBoxes: [], positions: new Set(), chains: new Set(), visibilityMode: 'explicit' }, true);
            this.isDragging = true;
            const { i, j } = this.getCellIndices(e);
            this.selection.x1 = j; this.selection.y1 = i;
            this.selection.x2 = j; this.selection.y2 = i;
            this.lastSelectionHash = null;
            this.scheduleRender();

            const handleTouchMove = (e) => {
                if (!this.isDragging || !this.bytes || e.touches.length !== 1) return;
                e.preventDefault();
                let cellIndices;
                try { cellIndices = this.getCellIndices(e.touches[0]); } catch (err) { return; }
                const { i, j } = cellIndices;
                const n = this.n;
                const newX2 = Math.max(0, Math.min(n - 1, j));
                const newY2 = Math.max(0, Math.min(n - 1, i));
                if (this.selection.x2 !== newX2 || this.selection.y2 !== newY2) {
                    this.selection.x2 = newX2; this.selection.y2 = newY2;
                    this.scheduleRender();
                }
            };
            const handleTouchEnd = (e) => {
                if (!this.isDragging) return;
                e.preventDefault();
                handleEnd(e);
                window.removeEventListener('touchmove', handleTouchMove);
                window.removeEventListener('touchend', handleTouchEnd);
                window.removeEventListener('touchcancel', handleTouchCancel);
            };
            const handleTouchCancel = (e) => {
                if (!this.isDragging) return;
                e.preventDefault();
                this.isDragging = false;
                this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                this.render();
                window.removeEventListener('touchmove', handleTouchMove);
                window.removeEventListener('touchend', handleTouchEnd);
                window.removeEventListener('touchcancel', handleTouchCancel);
            };
            window.addEventListener('touchmove', handleTouchMove, { passive: false });
            window.addEventListener('touchend', handleTouchEnd, { passive: false });
            window.addEventListener('touchcancel', handleTouchCancel, { passive: false });
        });
    }

    /**
     * @param {*} bytes base64 of the scaled bytes, a Uint8Array, a flat
     *        array of scaled ints, or a nested array of floats in Angstrom.
     * @param {number} [residues] how many RESIDUES the matrix covers, which is
     *        not the same as how many CELLS it has: viewer.py resamples a big
     *        matrix down to what the panel can draw. Defaults to the cell
     *        count, which is what every non-notebook caller has.
     */
    setData(bytes, residues) {
        // A DIRECT setData IS "ONE MAP, THE ONE YOU ARE ON" - core/mol.js
        // calls it to clear the panel and to hand it a single matrix, and it
        // predates there being more than one. Collapsing the set here is what
        // keeps a stale tab from outliving the data behind it.
        this.maps = bytes ? { [this.mapKey]: { data: bytes, n: residues } } : null;
        this._loadMatrix(bytes, residues);
        this._syncTabs();
    }

    /**
     * ALL THE MAPS FOR ONE FRAME. Each entry is `{data, n}` and carries its
     * OWN residue count, because two maps of one structure need not have been
     * resampled alike - a 900-residue PAE is cut to 300 cells and a contact
     * map of the same prediction may not be.
     */
    setMaps(maps) {
        const keys = maps ? Object.keys(maps).filter((k) => maps[k] && maps[k].data) : [];
        const previous = this.maps;
        this.maps = keys.length ? maps : null;
        // KEEP THE READER ON THE TAB THEY CHOSE. A frame step and an object
        // switch both come through here, and throwing them back to the first
        // map every time would make the strip unusable during playback.
        //
        // 🔴 AND A CHOICE OUTLIVES A FRAME THAT CANNOT HONOUR IT. The maps
        // are resolved backwards per frame, so a contact map that starts at
        // frame 2 simply does not exist at frame 0 - and falling back there
        // used to overwrite the chosen key, so scrubbing to the start and
        // forward again left the reader on PAE with no way to tell why.
        // `_wantKey` is what they CLICKED; `mapKey` is what is on screen.
        const key = keys.indexOf(this._wantKey) >= 0 ? this._wantKey
            : (keys.indexOf(this.mapKey) >= 0 ? this.mapKey : keys[0]);
        const entry = key ? maps[key] : null;

        // 🔴 A FRAME THAT INHERITED THE SAME MAP REDRAWS NOTHING. Every frame
        // step comes through here, and _selectMap ends in _syncAxes, which
        // relayouts - which resizes the canvas, and a resized canvas is a
        // CLEARED one. During a live trajectory that is one clear-and-repaint
        // per frame as frames arrive: the panel flickers. `setMap` has guarded
        // on the key alone since it was written; this needs the ENTRY too,
        // because a contact map that changes every recycle keeps one key while
        // its data moves. Identity is the right test - the maps are resolved
        // by backward search, so an inherited one is the SAME object, and a
        // new one never is.
        const held = previous && key ? previous[key] : null;
        const same = entry !== null && entry === held && key === this.mapKey
            && this._sameKeys(previous, maps);
        if (same) return;

        // 🔴 AND AN EMPTY SET IS THE SAME CASE, WHICH THE TEST ABOVE CANNOT
        // SEE. `entry` is null when there are no maps at all, so `same` is
        // false on every call and a structure with no PAE ran _selectMap,
        // _loadMatrix and a full relayout on every frame of every trajectory -
        // a forced layout and a canvas resize per step for a panel that is not
        // on screen. Measured on _traj_1tim.pdb: 60 relayouts over 30 steps
        // (setFrame asks twice - _loadFrameData and setFrame itself), 0.23 ms
        // a step, 1.7% of the step in a sampling profile.
        //
        // `_emptied` rather than `!previous`, because the FIRST empty call has
        // work to do: it is what clears a matrix left by the object before.
        // Once the panel holds nothing, being handed nothing again is a no-op.
        //
        // 🔴 AND IT ASKS `previous` AS WELL AS THE FLAG, because setData()
        // writes `this.maps` without coming through here: a direct
        // setData(bytes) followed by setMaps({}) must still clear, and it is
        // `previous` being non-null that says so.
        if (!keys.length) {
            if (!previous && this._emptied) return;
            this._emptied = true;
        }

        this._selectMap(key || DEFAULT_MAP_KEY, entry);
        this._syncTabs();
    }

    /** Do two map sets offer the same tabs? The strip is redrawn when not. */
    _sameKeys(a, b) {
        if (!a || !b) return false;
        const one = Object.keys(a);
        const two = Object.keys(b);
        return one.length === two.length && one.every((k) => two.indexOf(k) >= 0);
    }

    /**
     * Does ANY map in the strip caption this axis?
     *
     * 🔴 THE MARGINS ARE RESERVED FOR THE SET, NOT FOR THE MAP ON SCREEN, and
     * that is what stops the plot jumping when a tab is clicked. `pae`
     * captions both axes and a bare contact map captions neither, so sizing
     * from the CURRENT map's labels added and removed two 15px bands on every
     * switch - the plot resized and re-centred under the pointer, and the tab
     * strip moved with it. Reserving the union costs an empty band on the maps
     * that have no caption and holds every map at one size.
     *
     * The map's own label beats the registry's, exactly as _selectMap merges
     * them, so a host page that captions its own map is answered here too.
     */
    anyAxisLabel(which) {
        if (!this.maps) return false;
        for (const key of Object.keys(this.maps)) {
            const entry = this.maps[key];
            const own = entry && entry[which];
            if (own !== null && own !== undefined && own !== '') return true;
            const registry = scaleFor(key);
            if (registry && registry[which]) return true;
        }
        return false;
    }

    /** Show one of the maps already loaded. What a tab click does. */
    setMap(key) {
        if (!this.maps || !this.maps[key]) return;
        // IN A SLOT, THE SLOT DECIDES WHICH MAP A PANEL SHOWS - so a host's
        // setMap goes through it, or the tabs would say one map while the
        // panel under them drew another.
        const slots = this.slotted && this.mainRenderer && this.mainRenderer._slots;
        if (slots && slots.showMap(this, key)) return;
        this._wantKey = key;   // the reader's choice, which survives a frame
        if (key === this.mapKey) return;
        this._selectMap(key, this.maps[key]);
        this._syncTabs();
    }

    _selectMap(key, entry) {
        this.mapKey = key;
        // ...the layout this matrix was computed for, where it states one.
        this.mapChains = (entry && Array.isArray(entry.chains)) ? entry.chains : null;
        const base = scaleFor(key);
        const spec = {};
        if (entry) {
            if (entry.vmin !== null && entry.vmin !== undefined && isFinite(entry.vmin)) {
                spec.vmin = entry.vmin;
            }
            if (entry.vmax !== null && entry.vmax !== undefined && isFinite(entry.vmax)) {
                spec.vmax = entry.vmax;
            }
            // ...and the older spelling, which stated the same span from 0.
            if (spec.vmin === undefined && spec.vmax === undefined && entry.perUnit) {
                spec.vmin = 0;
                spec.vmax = 255 / entry.perUnit;
            }
            const ramp = rampFromStops(entry.colors);
            if (ramp) spec.ramp = ramp;
            if (entry.xlabel !== null && entry.xlabel !== undefined) {
                spec.xlabel = entry.xlabel;
            }
            if (entry.ylabel !== null && entry.ylabel !== undefined) {
                spec.ylabel = entry.ylabel;
            }
            // (There is no title to carry: see labelFor.)
        }
        this.scale = Object.keys(spec).length
            ? Object.assign({}, base, spec) : base;
        // A degenerate span would divide by zero on every cell. Widen it by
        // the smallest amount that keeps the picture flat rather than NaN.
        if (!(this.scale.vmax > this.scale.vmin)) {
            this.scale = Object.assign({}, this.scale,
                { vmax: this.scale.vmin + 1 });
        }
        // 🔴 ONLY THROW THE CACHED IMAGE AWAY WHEN THE SCALE ACTUALLY
        // CHANGED. This nulled it unconditionally, so every frame of a
        // trajectory regenerated n^2 pixels even when the map was inherited
        // unchanged from an earlier frame - and `_loadMatrix`'s own
        // "same data, same residues" early-out could never fire, because it
        // also requires a live baseCanvas. A signature rather than an
        // object comparison: `rampFromStops` builds a NEW function each
        // call, so the scales are never `===` even when identical.
        const sig = key + '|' + this.scale.vmin + '|' + this.scale.vmax + '|'
            + (entry && entry.colors ? JSON.stringify(entry.colors) : '')
            + '|' + (this.mainRenderer && this.mainRenderer._getEffectiveColorMode
                ? this.mainRenderer._getEffectiveColorMode() : '')
            + '|' + (this.mainRenderer && this.mainRenderer.colorblindMode ? 1 : 0);
        if (sig !== this._scaleSig) {
            this._scaleSig = sig;
            this.baseCanvas = null;
        }
        this._loadMatrix(entry ? entry.data : null, entry ? entry.n : 0);
        this._syncAxes();
    }

    /**
     * THE AXIS LABELS ARE DOM, AROUND AN INSET CANVAS - NOT DRAWN ON IT.
     *
     * Reserving margins INSIDE the canvas would add a term to every one of
     * getCellIndices, render's mask, _drawSelectionBoxes and
     * _drawChainBoundaries - a third coordinate space beside residues and
     * cells, in a file whose worst bugs have all been a crossing that one
     * drawing was not told about. The canvas stays 100% plot and simply gets
     * smaller; only the layout below knows the margins exist.
     */
    _syncAxes() {
        const sc = this.scale || {};
        const set = (el, text) => {
            if (!el) return;
            const t = (typeof text === 'string' && text) ? text : '';
            if (el.textContent !== t) el.textContent = t;
            // `flex`, not `block`: the layout centres the text in its band
            // with align/justify, which a block box would ignore.
            el.style.display = t ? 'flex' : 'none';
        };
        set(this.xLabelEl, sc.xlabel);
        set(this.yLabelEl, sc.ylabel);
        if (this._relayout) this._relayout();
    }

    _loadMatrix(bytes, residues) {
        // ...and `!this.baseCanvas` is part of the question, not noise: two
        // maps can share one matrix under different scales, and without it
        // the switch early-returns and leaves the first map's colours up.
        // 🔴 AND AGAINST THE RAW SOURCE, not the decoded bytes. Python
        // sends a map as base64 and this decodes it into a NEW Uint8Array
        // every call, so `this.bytes === bytes` compared an array with a
        // string and could never hold - every frame of a trajectory
        // re-decoded and re-drew n^2 pixels for a map it had inherited
        // unchanged from an earlier frame.
        if (this._rawSource === bytes && bytes !== null && bytes !== undefined
            && this.residues === residues && this.baseCanvas) return;
        // ...and a parked panel decodes nothing: `unpark` re-selects the map
        // it is pinned to, which comes back through here.
        if (this.parked) return;
        this._rawSource = bytes;
        try {
            // A STRING IS BASE64 OF THE SCALED BYTES - the shortest way to put
            // an N^2 matrix in an .ipynb, and the closest to what this panel
            // keeps. viewer.py used to write a JSON list of the same numbers,
            // which costs three characters and a comma each: 3,048 KB for
            // AF-Q5VSL9 against 912. Decoded here into the Uint8Array branch
            // below rather than beside it - it IS that case, only smaller on
            // the wire, and every older form still lands where it did.
            if (typeof bytes === 'string') {
                const bin = atob(bytes);
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                bytes = u8;
            }
            if (bytes && typeof bytes === 'object' && !Array.isArray(bytes) && !(bytes instanceof Uint8Array)) {
                console.warn("map data is an object, converting to array (slow!)");
                if (bytes.predicted_aligned_error) bytes = bytes.predicted_aligned_error;
            }
            if (bytes) {
                if (bytes instanceof Uint8Array) {
                    this.bytes = bytes;
                    this.n = Math.round(Math.sqrt(bytes.length));
                } else if (Array.isArray(bytes)) {
                    if (bytes.length > 0 && Array.isArray(bytes[0])) {
                        // ...at this scale's bytes per unit: a matrix of
                        // NUMBERS is in the map's own units and has to be
                        // encoded, where a Uint8Array is already bytes.
                        const sc = this.scale || MAP_SCALES[DEFAULT_MAP_KEY];
                        const encLo = sc.vmin;
                        const encSpan = (sc.vmax - sc.vmin) || 1;
                        const n = bytes.length;
                        this.n = n;
                        const flattened = new Uint8Array(n * n);
                        for (let i = 0; i < n; i++) {
                            const row = bytes[i];
                            for (let j = 0; j < n; j++) {
                                let val = Math.round(
                                    ((row[j] - encLo) / encSpan) * 255);
                                if (val > 255) val = 255;
                                if (val < 0) val = 0;
                                flattened[i * n + j] = val;
                            }
                        }
                        this.bytes = flattened;
                    } else {
                        this.bytes = new Uint8Array(bytes);
                        this.n = Math.round(Math.sqrt(bytes.length));
                    }
                } else {
                    console.error("Invalid map data type:", typeof bytes);
                    this.bytes = null;
                    this.n = 0;
                }
            } else {
                this.bytes = null;
                this.n = 0;
            }

            // THE GRID AND THE RESIDUES ARE TWO NUMBERS NOW. They are equal
            // for everything except a notebook payload big enough to have been
            // resampled, and the scaling below is the identity when they are -
            // so nothing that was exact stops being exact.
            this.residues = (residues > 0) ? residues : this.n;
            if (this.n > 0 && this.n * this.n !== this.bytes.length) {
                console.warn(`map data length(${this.bytes.length}) is not a perfect square. inferred N = ${this.n}`);
            }
            this.lastSelectionHash = null;
            this.cachedSequencePositions = null;
            if (this.n > 0 && this.bytes) {
                this._generateBaseImage();
            } else {
                this.baseCanvas = null;
            }
            this.scheduleRender();
        } finally { }
    }

    getSequenceSelectedPositions() {
        const selectedPositions = new Set();
        const renderer = this.mainRenderer;
        if (!this.bytes || this.n === 0) return selectedPositions;
        const visibilityModel = renderer.visibilityModel;
        const hasPositionSelection = visibilityModel.positions && visibilityModel.positions.size > 0;
        const hasChainSelection = visibilityModel.chains && visibilityModel.chains.size > 0;
        const mode = visibilityModel.visibilityMode || 'default';
        if (mode === 'default') {
            if (!hasPositionSelection) return selectedPositions;
        }
        if (!hasPositionSelection && !hasChainSelection) return selectedPositions;
        // ...and the chain set speaks (object, chain) keys - see chainKeyAt
        let allowedChains = visibilityModel.chains;
        if (!hasChainSelection) {
            allowedChains = new Set();
            for (let i = 0; i < renderer.chains.length; i++) {
                allowedChains.add(renderer.chainKeyAt ? renderer.chainKeyAt(i)
                    : renderer.chains[i]);
            }
        }
        const n = this.residues || this.n;
        // A PAE row is a residue of the object this matrix belongs to; the
        // mask and the chain array are the viewer's, and with several
        // objects merged this object starts partway into them.
        const off = renderer.sourceOffsetOf
            ? renderer.sourceOffsetOf(Heatmap.heatmapObject(renderer)) : 0;
        for (let r = 0; r < n; r++) {
            if (r + off >= renderer.chains.length) continue;
            const chain = renderer.chainKeyAt
                ? renderer.chainKeyAt(r + off) : renderer.chains[r + off];
            if (allowedChains.has(chain)
                && (!hasPositionSelection || visibilityModel.positions.has(r + off))) {
                // ...AS A CELL, because this set is drawn on the plot. The
                // loop walks residues; the overlay wants the cell each one
                // landed in, and several residues share a cell once the
                // matrix has been resampled.
                selectedPositions.add(this.residueToCell(r));
            }
        }
        return selectedPositions;
    }

    /**
     * THE TAB STRIP IS BUILT, NOT MARKED UP, and it is an OVERLAY.
     *
     * Built, because a container and a canvas is all three shells and
     * every host page provide - index.html, viewer.html and whatever page
     * calls show() - so a strip in markup is three copies to keep in step,
     * which is how the Style panel came to differ three times before
     * parts/panel.js made it data.
     *
     * ABSOLUTELY POSITIONED, because in BOTH shipped shells the container is
     * a fixed square with `overflow: hidden` and the canvas is pinned to
     * fill it - an in-flow strip is laid out under the canvas and clipped.
     * So the strip takes a reserved band at the top and the LAYOUT insets
     * the canvas below it (see updateSize), which is also what makes room
     * for the axis captions.
     *
     * 🔴 AND THE BUTTONS ARE MUTATED, NEVER REBUILT, unless the SET of maps
     * changed. This is reached from _show, which runs on every frame - so a
     * strip rebuilt per tick would destroy the button the pointer went down
     * on and swallow the click, which is exactly what the play button did.
     */
    _syncTabs() {
        const strip = this.tabStrip;
        if (!strip) return;
        // 🔴 THE STRIP'S VISIBILITY IS A LAYOUT INPUT, so a change to it has
        // to reach updateSize. It did not: _selectMap relayouts through
        // _syncAxes and _syncTabs runs AFTER that, so the first map turned
        // the strip on with nobody left to re-measure - and the plot was
        // sized as though there were no tab bar, overflowing the container
        // by exactly the strip's height. Only on CHANGE: this runs every
        // frame, and resizing the canvas throws away the cached base image.
        const wasShown = strip.style.display;
        const keys = this.maps ? Object.keys(this.maps) : [];
        // IN A SLOT THE SLOT'S TABS NAME THE MAP (parts/slots.js), and a
        // second strip over the same plot would be two answers to one choice.
        if (keys.length < 1 || this.slotted) {
            strip.style.display = 'none';
            strip.textContent = '';
            this._tabKeys = '';
            if (wasShown !== 'none' && this._relayout) this._relayout();
            return;
        }
        // ONE MAP STILL GETS ITS TAB, which is how a lone PAE shows its name
        // at all - a lone map is named by its own tab. A single tab is a
        // title chip that happens to be built the same way, and it is drawn
        // active because it IS the map on screen.
        strip.style.display = 'flex';
        const sig = keys.join('\u0000');
        if (sig !== this._tabKeys) {
            this._tabKeys = sig;
            strip.textContent = '';
            for (const key of keys) {
                const b = document.createElement('button');
                b.type = 'button';
                b.setAttribute('role', 'tab');
                b.dataset.mapKey = key;
                b.textContent = labelFor(key);
                b.style.cssText = MAP_TAB_CSS;
                b.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.setMap(key);
                });
                strip.appendChild(b);
            }
        }
        for (const b of strip.children) {
            const on = b.dataset.mapKey === this.mapKey;
            // `aria-selected` IS the state, so it is the dirty flag too -
            // a tab says aria-selected the way a latch says aria-pressed and
            // a panel button says aria-expanded. Restyled only when it
            // CHANGED, because this runs on every frame and a write to
            // .style invalidates whether or not the value differs.
            const want = on ? 'true' : 'false';
            if (b.getAttribute('aria-selected') !== want) {
                b.setAttribute('aria-selected', want);
                // White and level with the plot when selected; recessed,
                // greyer and a pixel shorter when not - so the difference is
                // in the SHAPE as well as the fill, which survives a screen
                // that renders the two greys alike.
                b.style.background = on ? '#ffffff' : '#e9e9e9';
                b.style.color = on ? '#111111' : '#5c5c5c';
                b.style.borderColor = on ? '#bcbcbc' : '#c9c9c9';
                b.style.fontWeight = on ? '600' : '400';
                b.style.paddingBottom = on ? '6px' : '4px';
                b.style.zIndex = on ? '1' : '0';
            }
        }
        if (wasShown !== strip.style.display && this._relayout) this._relayout();
    }

    _generateBaseImage() {
        if (!this.bytes || this.n === 0) {
            this.baseCanvas = null;
            return;
        }
        const n = this.n;
        const offscreen = document.createElement('canvas');
        offscreen.width = n;
        offscreen.height = n;
        const ctx = offscreen.getContext('2d', { alpha: false });
        const imageData = ctx.createImageData(n, n);
        const data32 = new Uint32Array(imageData.data.buffer);
        const mainColorMode = this.mainRenderer && this.mainRenderer._getEffectiveColorMode ? this.mainRenderer._getEffectiveColorMode() : 'auto';
        const colorblind = this.mainRenderer?.colorblindMode || false;
        const scale = this.scale || MAP_SCALES[DEFAULT_MAP_KEY];
        const colorMap = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            const value = scale.vmin + (scale.vmax - scale.vmin) * (i / 255);
            // ...and the byte's own fraction beside it, for a ramp that has
            // no units to work in. PAE and contact ignore it; see
            // GENERIC_SCALE.
            const { r, g, b } = scale.ramp(value, colorblind, mainColorMode, i / 255);
            colorMap[i] = (255 << 24) | (b << 16) | (g << 8) | r;
        }
        const len = n * n;
        const bytes = this.bytes;
        for (let i = 0; i < len; i++) {
            data32[i] = colorMap[bytes[i]];
        }
        ctx.putImageData(imageData, 0, 0);
        this.baseCanvas = offscreen;
    }

    render() {
        if (this.parked) return;
        // THE OTHER PANEL IN THE POOL REDRAWS WITH THIS ONE. core/mol.js asks
        // `renderer.heatmapRenderer` to render when the selection moves, and
        // knows nothing about a second panel - so the page's own passes it on.
        const pool = this.mainRenderer && this.mainRenderer._heatmapPool;
        if (pool && pool.length > 1 && this === this.mainRenderer.heatmapRenderer) {
            for (const e of pool) if (e.hm !== this) e.hm.scheduleRender();
        }
        this.ctx.clearRect(0, 0, this.size, this.size);
        if (!this.bytes || this.n === 0) {
            this.ctx.fillStyle = '#f9f9f9';
            this.ctx.fillRect(0, 0, this.size, this.size);
            this.ctx.fillStyle = '#999';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.font = '14px sans-serif';
            const sc = this.scale || MAP_SCALES[DEFAULT_MAP_KEY];
            this.ctx.fillText(sc.empty || ('No ' + (sc.label || '') + ' Data'),
                this.size / 2, this.size / 2);
            return;
        }
        const n = this.n;
        if (!this.baseCanvas) this._generateBaseImage();
        if (this.baseCanvas) {
            this.ctx.imageSmoothingEnabled = false;
            this.ctx.drawImage(this.baseCanvas, 0, 0, this.size, this.size);
        }

        const activeBoxes = this.mainRenderer.visibilityModel.heatmapBoxes || [];
        // 🔴 CONVERTED ONCE, HERE, because there are TWO things drawn from a
        // stored box - the mask and the outline - and only the mask had been
        // told. A box is stored in RESIDUES; everything on this canvas is laid
        // out in CELLS. `residueToCell` is the identity until a matrix is
        // resampled, which is why this only ever went wrong in a notebook.
        const activeCells = activeBoxes.map((box) => ({
            i_start: this.residueToCell(Math.min(box.i_start, box.i_end)),
            i_end: this.residueToCell(Math.max(box.i_start, box.i_end)),
            j_start: this.residueToCell(Math.min(box.j_start, box.j_end)),
            j_end: this.residueToCell(Math.max(box.j_start, box.j_end)),
        }));
        const previewBox = (this.isDragging && this.selection.x1 !== -1) ? this.selection : null;
        if (this.cachedSequencePositions === null) this.cachedSequencePositions = this.getSequenceSelectedPositions();
        const sequenceSelectedPositions = this.cachedSequencePositions;
        const mode = this.mainRenderer.visibilityModel?.visibilityMode || 'default';
        const hasSelection = activeBoxes.length > 0 || previewBox !== null || sequenceSelectedPositions.size > 0 || (mode === 'explicit');

        if (hasSelection) {
            const cellSize = this.size / n;
            // 🔴 TWO SCRATCH CANVASES, KEPT - not two new ones per redraw. A
            // drag redraws every frame, and at the size a slot can make this
            // plot (600 CSS px) that was two 600x600 allocations a frame for
            // the life of the drag. Resizing a canvas clears it, which is what
            // each redraw needs anyway.
            if (!this._scratch || this._scratch.size !== this.size) {
                const mk = () => {
                    const c = document.createElement('canvas');
                    c.width = this.size; c.height = this.size;
                    return c;
                };
                this._scratch = { size: this.size, mask: mk(), overlay: mk() };
            }
            const maskCanvas = this._scratch.mask;
            const maskCtx = maskCanvas.getContext('2d');
            maskCtx.globalCompositeOperation = 'source-over';
            maskCtx.clearRect(0, 0, this.size, this.size);
            maskCtx.fillStyle = 'white';
            const drawMaskRegion = (i_start, i_end, j_start, j_end) => {
                const x = Math.floor(j_start * cellSize);
                const y = Math.floor(i_start * cellSize);
                const w = Math.ceil((j_end - j_start + 1) * cellSize);
                const h = Math.ceil((i_end - i_start + 1) * cellSize);
                maskCtx.fillRect(x, y, w, h);
            };
            // The preview box is already in cells - it is what the pointer
            // drew - and the stored ones were converted at the top.
            for (const b of activeCells) {
                drawMaskRegion(b.i_start, b.i_end, b.j_start, b.j_end);
            }
            if (previewBox && previewBox.x1 !== -1) {
                const i_start = Math.min(previewBox.y1, previewBox.y2);
                const i_end = Math.max(previewBox.y1, previewBox.y2);
                const j_start = Math.min(previewBox.x1, previewBox.x2);
                const j_end = Math.max(previewBox.x1, previewBox.x2);
                drawMaskRegion(i_start, i_end, j_start, j_end);
            }
            if (sequenceSelectedPositions.size > 0) {
                const sortedPos = Array.from(sequenceSelectedPositions).sort((a, b) => a - b);
                const ranges = [];
                if (sortedPos.length > 0) {
                    let start = sortedPos[0], prev = sortedPos[0];
                    for (let i = 1; i < sortedPos.length; i++) {
                        if (sortedPos[i] !== prev + 1) {
                            ranges.push([start, prev]);
                            start = sortedPos[i];
                        }
                        prev = sortedPos[i];
                    }
                    ranges.push([start, prev]);
                }
                for (const r1 of ranges) {
                    for (const r2 of ranges) {
                        drawMaskRegion(r1[0], r1[1], r2[0], r2[1]);
                    }
                }
            }
            const overlayCanvas = this._scratch.overlay;
            const overlayCtx = overlayCanvas.getContext('2d');
            overlayCtx.globalCompositeOperation = 'source-over';
            overlayCtx.clearRect(0, 0, this.size, this.size);
            overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            overlayCtx.fillRect(0, 0, this.size, this.size);
            overlayCtx.globalCompositeOperation = 'destination-out';
            overlayCtx.drawImage(maskCanvas, 0, 0);
            this.ctx.drawImage(overlayCanvas, 0, 0);
        }

        // ...and let them go when nothing is selected, so keeping them for a
        // drag does not keep 8 bytes a pixel for the life of the panel.
        if (!hasSelection) this._scratch = null;

        // 4. Draw selection boxes (outlines)
        this._drawSelectionBoxes(activeCells, previewBox, n, this.size / n);

        // 5. Draw chain boundary lines
        this._drawChainBoundaries(n, this.size / n);
    }

    // Helper to draw selection boxes around selected regions
    /**
     * `activeBoxes` here is IN CELLS - `render()` converts before calling, and
     * this is the drawing that made that necessary: it multiplied residue
     * indices by a cell size, so on a resampled matrix the outline sat at the
     * wrong place and the wrong size while the mask under it was right. The
     * reported symptom is exactly that: "the box showing the selection is not
     * matching selection".
     */
    _drawSelectionBoxes(activeBoxes, previewBox, n, cellSize) {
        this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)'; // Black box
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([]);

        // Draw active boxes
        for (const box of activeBoxes) {
            const i_start = Math.min(box.i_start, box.i_end);
            const i_end = Math.max(box.i_start, box.i_end);
            const j_start = Math.min(box.j_start, box.j_end);
            const j_end = Math.max(box.j_start, box.j_end);

            const x1 = Math.floor(j_start * cellSize);
            const y1 = Math.floor(i_start * cellSize);
            const x2 = Math.floor((j_end + 1) * cellSize);
            const y2 = Math.floor((i_end + 1) * cellSize);

            this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        }

        // Draw preview box if dragging
        if (previewBox && previewBox.x1 !== -1) {
            const i_start = Math.min(previewBox.y1, previewBox.y2);
            const i_end = Math.max(previewBox.y1, previewBox.y2);
            const j_start = Math.min(previewBox.x1, previewBox.x2);
            const j_end = Math.max(previewBox.x1, previewBox.x2);

            const x1 = Math.floor(j_start * cellSize);
            const y1 = Math.floor(i_start * cellSize);
            const x2 = Math.floor((j_end + 1) * cellSize);
            const y2 = Math.floor((i_end + 1) * cellSize);

            // Dashed line for preview
            this.ctx.setLineDash([5, 5]);
            this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'; // Lighter black for preview
            this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            this.ctx.setLineDash([]);
        }
    }

    // Helper to draw chain boundary lines in PAE plot
    _drawChainBoundaries(n, cellSize) {
        const renderer = this.mainRenderer;
        // 🔴 THE MAP'S OWN LAYOUT WINS, AND IT DEFINES ITS OWN RESIDUE AXIS.
        // Everything below is the fallback for a map that says nothing - a
        // parsed structure's PAE, where the renderer's array IS this
        // matrix's.
        //
        // 🔴 AND IT SCALES BY ITS OWN LENGTH, NOT BY `this.residues`. That
        // field comes from a DIFFERENT key of the same entry (`n`/`pae_n`),
        // so the two are independent inputs and can disagree - and this file
        // has the scar to prove what that costs: a residue index scaled by
        // the wrong count is a line ruled in the wrong place, silently, which
        // is the whole fault the field exists to stop. Saying the array is
        // the axis removes the dependency instead of testing it, and it is
        // EXACTLY `residueToCell` wherever the two agree, which is every
        // payload anything in this tree produces.
        if (Array.isArray(this.mapChains) && this.mapChains.length > 0) {
            // 🔴 RESIDUES HERE, CELLS THERE. The map's array is one entry
            // per RESIDUE and `n` is the matrix SIDE; on a resampled matrix
            // they are different numbers, which is the crossing every worst
            // fault in this panel has been. The walk is over the array and
            // `residueToCell` is what puts the line on the picture.
            const own = this.mapChains;
            const marks = new Set();
            for (let r = 0; r + 1 < own.length; r++) {
                if (own[r] !== own[r + 1]) marks.add(r + 1);
            }
            this._paintChainLines(marks, n, cellSize,
                                  (residue) => Math.min(
                                      n - 1, Math.floor(residue * n / own.length)));
            return;
        }
        if (!renderer.chains || renderer.chains.length === 0) return;

        const boundaries = new Set(); // Set of RESIDUE positions where the chain changes

        // A PAE ROW IS A RESIDUE OF THE OBJECT THIS MATRIX BELONGS TO, and
        // with several objects merged that object starts partway into the
        // chain array - so the lines were ruled where the FIRST object's
        // chains change, across a matrix belonging to another one.
        const off = renderer.sourceOffsetOf
            ? renderer.sourceOffsetOf(Heatmap.heatmapObject(renderer)) : 0;
        const chainAt = (i) => (renderer.chainKeyAt
            ? renderer.chainKeyAt(i) : renderer.chains[i]);

        // ...AND THE WALK IS OVER RESIDUES, THE LINE IS DRAWN IN CELLS.
        // Same crossing as the selection box two functions up. `n` is the
        // matrix side, so on a resampled matrix this walked 300 of 360
        // residues - the chains past that got no line at all - and then ruled
        // the ones it did find at a residue index times a cell width.
        const N = this.residues || n;

        // 🔴 AND THE CHAIN ARRAY HAS TO BE THIS MATRIX'S. `renderer.chains`
        // belongs to whatever is DRAWN, and a map can be on screen while it
        // is not: a fold's trunk shows a contact map for the sequence being
        // folded, over an object that still holds the PREVIOUS fold - so a
        // longer stale array was walked and its boundaries ruled across a
        // smaller matrix. Reported as chain lines from previous objects, of
        // a different length, bleeding through the intermediate maps.
        //
        // The guard below only stopped the walk running off the END of the
        // array, which is the case where the stale one is SHORTER; a longer
        // one indexed cleanly and drew nonsense.
        //
        // Unmerged, the array covers exactly the matrix's residues, so
        // spanning it means being exactly as long; merged, it covers every
        // source and this object starts at `off`, so the most that can be
        // asked is that it reaches. Not a guess in either case: a boundary
        // list that does not span the picture is not the picture's.
        // 🔴 AND THE COUNT IS `_baseCount`, NOT `chains.length`. The chain
        // array is per POSITION, and showing side chains APPENDS positions -
        // so an exact comparison against its length switched the lines off
        // for every structure with its side chains out, which is a different
        // bug of the same size. `_baseCount` is the positions before those
        // were materialised, which is the residue count this matrix is in.
        // 🔴 AND THE ARRAY IS ASKED AS WELL AS THE DRAWING, because a map can
        // be on screen before there IS a drawing: a fold's intermediate
        // contact map is the sequence being folded, the object it opened is
        // still empty, and the page writes that sequence's chain ids straight
        // onto the renderer. `_baseCount()` is then 0 and the array is exactly
        // the matrix - so asking the drawing alone took the boundaries off
        // every intermediate map. Reported as losing the lines between chains
        // during intermediate contact map views.
        const merged = !!(renderer.multiState && renderer.multiState.enabled);
        const drawnResidues = renderer._baseCount
            ? renderer._baseCount() : renderer.chains.length;
        const spansThisMatrix = merged
            ? drawnResidues - off >= N
            : (drawnResidues === N || renderer.chains.length === N);
        if (!spansThisMatrix) return;
        for (let r = 0; r < N - 1 && r + off < renderer.chains.length - 1; r++) {
            const chain1 = chainAt(r + off);
            const chain2 = chainAt(r + off + 1);

            if (chain1 !== chain2) {
                // Chain boundary at position r+1 (draw line before this position)
                boundaries.add(this.residueToCell(r + 1));
            }
        }

        this._paintChainLines(boundaries, n, cellSize, null);
    }

    /**
     * The lines themselves, for either source of boundaries.
     *
     * `toCell` converts a RESIDUE to a cell where the caller has not already
     * done it - the crossing this panel's worst faults have all been - and is
     * null when the set is in cells already.
     */
    _paintChainLines(boundaries, n, cellSize, toCell) {
        if (!boundaries || boundaries.size === 0) return;
        this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([]);
        this.ctx.beginPath();
        for (const pos of boundaries) {
            const cell = toCell === null ? pos : toCell(pos);
            const coord = Math.floor(cell * cellSize);
            this.ctx.moveTo(coord, 0);
            this.ctx.lineTo(coord, this.size);
            this.ctx.moveTo(0, coord);
            this.ctx.lineTo(this.size, coord);
        }
        this.ctx.stroke();
    }
}

// ============================================================================
// PAE NAMESPACE
// ============================================================================
/**
 * ONE PANEL: a container, the canvas in it, and the chrome laid out around
 * the plot. `initialize` mounts the page's own; `Heatmap.slotPanels` mounts a
 * second when two maps are on screen at once (parts/slots.js), which is why
 * this is not written into `initialize` any more - it was, and there was no
 * way to have two.
 *
 * Returns the renderer, NOT registered on the viewer: the page's own panel is
 * `renderer.heatmapRenderer`, and a second one is the pool's.
 */
function mountPanel(renderer, heatmapPanel, heatmapCanvas) {
    // updateSize places the canvas with left/top, which mean nothing to a
    // static box - and a host page styles neither element, so on embed.html
    // the plot sat in the corner with its captions laid out for the inset.
    // The shells' stylesheets say this already; saying it inline covers a
    // page that does not.
    heatmapCanvas.style.position = 'absolute';
    if (getComputedStyle(heatmapPanel).position === 'static') {
        heatmapPanel.style.position = 'relative';
    }
    // THE PLOT IS A SQUARE INSET INTO WHATEVER THE CHROME LEAVES.
    // The shells' stylesheets pin the canvas at top:0/left:0 and
    // 100% x 100%; every one of those is overridden INLINE here, so
    // no shell has to learn about the margins. The canvas is still
    // entirely plot - see _syncAxes for why that matters.
    const updateSize = () => {
        // 🔴 THE PADDING BOX, NOT THE BORDER BOX. An absolutely
        // positioned child is placed against the padding box, so
        // sizing from getBoundingClientRect - which includes the
        // border - leaves the centring off by the border width on
        // one side and not the other. index.html's panel has a 1px
        // border and that is exactly the residual lean it produced.
        const boxW = heatmapPanel.clientWidth
            || heatmapPanel.getBoundingClientRect().width || 340;
        const boxH = heatmapPanel.clientHeight || boxW;
        // A hidden panel measures 0 and the fallback above is a
        // GUESS. Laying out against it writes gaps that are wrong by
        // whatever the guess missed by, and nothing later corrects
        // them - so do not lay out at all; updateVisibility calls
        // back the moment the panel is on screen.
        if (!heatmapPanel.clientWidth) return;
        const hm = heatmapRenderer;
        const shown = (el) => !!(el && el.style.display !== 'none'
            && el.textContent);
        // 🔴 THE STRIP HANGS ABOVE THE BOX, SO THE BOX HAS TO LEAVE
        // ROOM FOR IT. Otherwise the tabs are drawn over whatever the
        // host page put above the panel - measured on index.html, on
        // top of the object selector. A margin rather than a gap in
        // the host's layout, because the strip is the panel's and no
        // host should have to know its height.
        heatmapPanel.style.marginTop =
            (strip && strip.style.display !== 'none') ? HM_TAB_H + 'px' : '';
        // ...and the plot is inset on all four sides, not two. The
        // captions need their bands on the left and the bottom; the
        // top and the right get the same so the square sits in even
        // margins rather than hard against two edges.
        const padT = HM_AXIS;
        const padR = HM_AXIS;
        // ...from the SET of maps, not the one on screen - see
        // anyAxisLabel. `shown` is kept for the case with no renderer
        // yet, where there are no maps to ask about either.
        const padL = (hm && hm.anyAxisLabel)
            ? (hm.anyAxisLabel('ylabel') ? HM_AXIS : 0)
            : (shown(hm && hm.yLabelEl) ? HM_AXIS : 0);
        const padB = (hm && hm.anyAxisLabel)
            ? (hm.anyAxisLabel('xlabel') ? HM_AXIS : 0)
            : (shown(hm && hm.xLabelEl) ? HM_AXIS : 0);
        const availW = Math.max(40, boxW - padL - padR);
        const availH = Math.max(40, boxH - padT - padB);
        // SQUARE, because the matrix is n x n and `size` is used for
        // both axes.
        const size = Math.max(40, Math.floor(Math.min(availW, availH)));
        // 🔴 THE PLOT IS CENTRED, AND THE CAPTION LIVES IN ITS
        // MARGIN - it does not add to it. Centring the ASSEMBLY
        // (caption plus plot) is defensible arithmetic and looks
        // wrong: a 15px column of thin vertical text reads as part
        // of the white space, so the eye sees the plot sitting 27px
        // from one edge and 10 from the other. Measured on a 340px
        // panel, that is a 17px lean. Centre the PLOT and the
        // caption sits in the margin the centring already left.
        //
        // The `max` is what keeps it honest when the plot is nearly
        // as wide as the panel: the caption still gets its column,
        // and the lean comes back rather than the text being clipped.
        const left = Math.max(padL, Math.round((boxW - size) / 2));
        const top = Math.max(padT,
            Math.round((boxH - padB - size) / 2));

        heatmapCanvas.width = size;
        heatmapCanvas.height = size;
        heatmapCanvas.style.width = size + 'px';
        heatmapCanvas.style.height = size + 'px';
        heatmapCanvas.style.left = left + 'px';
        heatmapCanvas.style.top = top + 'px';

        // 🔴 THE TABS SPAN THE PLOT, NOT THE CONTAINER. Left at
        // the container's width they floated free of the thing they
        // belong to - the plot is inset and centred, so a full-width
        // bar lines up with neither edge. A browser tab sits over
        // its own content; this is that, hanging off the top of the
        // card (`bottom: 100%`, and the card's overflow is visible
        // for it) rather than taking a band inside the picture.
        if (strip) {
            strip.style.left = left + 'px';
            strip.style.width = size + 'px';
            strip.style.right = 'auto';
        }
        // 🔴 BOTH CAPTIONS ARE CENTRED IN A BAND OF THE SAME
        // THICKNESS, which is the only way they end up the same
        // distance from their edges. The y one was already centred
        // in its 15px column - 2.5px of clearance for 10px text -
        // while the x one was pinned at `bottom: 1px`, so it sat
        // closer to the edge and the pair looked lopsided. Centring
        // is stated the same way for both rather than by working
        // out one offset from the other, which drifts the moment
        // the font changes.
        if (xLabel) {
            xLabel.style.left = left + 'px';
            xLabel.style.width = size + 'px';
            xLabel.style.top = (top + size) + 'px';
            xLabel.style.bottom = 'auto';
            xLabel.style.height = HM_AXIS + 'px';
            xLabel.style.alignItems = 'center';
            xLabel.style.justifyContent = 'center';
        }
        if (yLabel) {
            yLabel.style.left = (left - HM_AXIS) + 'px';
            yLabel.style.width = HM_AXIS + 'px';
            yLabel.style.top = top + 'px';
            yLabel.style.height = size + 'px';
            yLabel.style.alignItems = 'center';
            yLabel.style.justifyContent = 'center';
        }

        if (hm) {
            hm.size = size;
            // 🔴 PAINTED NOW, NOT NEXT FRAME, BECAUSE THE LINE THAT RESIZED IT
            // ALREADY WIPED IT. Assigning `canvas.width` resets the backing
            // store, and this context is `alpha: false` (see the constructor),
            // so what it resets TO is opaque BLACK - not transparent. A
            // scheduled render paints it on the next animation frame, and
            // between the two the panel composites as a black rectangle.
            //
            // Reported as the big viewer going black for a brief second when
            // the layout switches from one slot to two. Every one of those
            // resizes this canvas: the reveal at the start of a fold, a slot
            // switch, a drag of the divider, a window resize. Caught on a real
            // headed Chrome by screencasting a live fold at 30 frames a second
            // - one frame of 592, the big slot 100% black, at the moment the
            // trunk's contact map took it.
            //
            // 🔴 AND THE GAP IS A FRAME ONLY WHEN THE PAGE IS IDLE. During a
            // fold the main thread is running inference, so the rAF that
            // scheduleRender waits for can be hundreds of milliseconds away -
            // which is why it reads as a second rather than a flicker, and why
            // it shows up in LocalFold and not in a quiet page.
            //
            // The fix is not a paper-coloured background under the canvas, nor
            // dropping `alpha: false`: both leave the canvas unpainted and
            // merely change what shows through. The rule is that a canvas is
            // never left cleared - the resize and the paint are one act.
            hm.render();
        }
    };

    // Create renderer
    const heatmapRenderer = new HeatmapRenderer(heatmapCanvas, renderer);

    // ...and its tab strip, in the band the layout reserves for it
    // at the top. It used to be an OVERLAY on the plot's corner,
    // which was right while it appeared only for a second map and
    // wrong now that a lone PAE gets one too: a permanent chip
    // sitting on the data is a permanent hole in the data. See
    // _syncTabs for why it is built rather than marked up.
    let strip = heatmapPanel.querySelector('.py2dmol-map-tabs');
    if (!strip) {
        strip = document.createElement('div');
        strip.className = 'py2dmol-map-tabs';
        strip.setAttribute('role', 'tablist');
        strip.setAttribute('aria-label', 'Which map to show');
        // ...and the rule the active tab breaks through. It is the
        // strip's own bottom border, so it spans the plot's full
        // width rather than stopping at the last tab.
        // 🔴 ABOVE THE BOX, NOT INSIDE IT. `bottom: 100%` puts the
        // strip on the container's outer top edge, so the tabs read as
        // controls OVER the panel the way a folder tab does. Inside, in
        // a reserved white band, they read as part of the plot - and
        // they cost the plot that band. The box's own top border is
        // the baseline the active tab breaks through, so the strip
        // needs none of its own.
        strip.style.cssText = 'position: absolute; bottom: 100%;'
            + ' left: 0; right: 0; height: ' + HM_TAB_H + 'px;'
            + ' display: none; align-items: flex-end; gap: 3px;'
            + ' padding: 0 8px; box-sizing: border-box; z-index: 2;'
            + ' pointer-events: auto;';
        heatmapPanel.appendChild(strip);
    }
    // ...and the axis captions. `writing-mode` turns the y one on
    // its side and the rotate makes it read bottom-to-top, which is
    // the way round every plotting library draws a y label.
    let xLabel = heatmapPanel.querySelector('.py2dmol-map-xlabel');
    if (!xLabel) {
        xLabel = document.createElement('div');
        xLabel.className = 'py2dmol-map-xlabel';
        xLabel.style.cssText = HM_AXIS_CSS + ' display: none;';
        heatmapPanel.appendChild(xLabel);
    }
    let yLabel = heatmapPanel.querySelector('.py2dmol-map-ylabel');
    if (!yLabel) {
        yLabel = document.createElement('div');
        yLabel.className = 'py2dmol-map-ylabel';
        yLabel.style.cssText = HM_AXIS_CSS + ' display: none;'
            + ' writing-mode: vertical-rl; transform: rotate(180deg);'
            + ' text-align: center;';
        heatmapPanel.appendChild(yLabel);
    }

    heatmapRenderer.tabStrip = strip;
    heatmapRenderer.xLabelEl = xLabel;
    heatmapRenderer.yLabelEl = yLabel;
    heatmapRenderer._relayout = updateSize;
    heatmapRenderer._syncAxes();
    // Set initial size
    updateSize();
    // ...and AGAIN WHENEVER THE BOX CHANGES. The panel was a fixed square, so
    // it laid out when it was shown and when its chrome changed, and nothing
    // else could move it. In a slot it is whatever the slot is - slot 1,
    // slot 2, a box the reader is dragging - so the box is watched.
    // updateSize bails while the box measures 0, which is a parked panel.
    if (typeof ResizeObserver !== 'undefined') {
        let lastW = -1, lastH = -1;
        const ro = new ResizeObserver(() => {
            const w = heatmapPanel.clientWidth, h = heatmapPanel.clientHeight;
            if (w === lastW && h === lastH) return;
            lastW = w; lastH = h;
            updateSize();
        });
        ro.observe(heatmapPanel);
        heatmapRenderer._resizeObserver = ro;
    }
    return heatmapRenderer;
}

const Heatmap = {
    Renderer: HeatmapRenderer,

    // Check if PAE data is valid (Uint8Array or Array or Array-like)
    isValid: function (m) {
        if (!m) return false;
        // A STRING IS BASE64 OF THE SCALED BYTES - see setData. Every check in
        // this file goes through here, so a form isValid does not know is a
        // form that is dropped in silence: the payload carried the matrix, the
        // panel came up empty, and nothing said why.
        if (typeof m === 'string') return m.length > 0;
        if ((Array.isArray(m) && m.length > 0) || (m.buffer && m.length > 0)) return true;
        if (typeof m === 'object' && typeof m.length !== 'number') {
            const keys = Object.keys(m);
            return keys.length > 0 && !isNaN(parseInt(keys[0]));
        }
        return false;
    },

    // Resolve PAE data for a frame (handles inheritance and backward search)
    /**
     * THE FRAME THAT HOLDS THE MATRIX, not the matrix. `pae_n` - how many
     * residues it covers - lives on the same frame, and returning the data
     * alone left the caller pairing it with whatever frame it was asked
     * about, which is a different frame whenever the search below walks back.
     */
    resolveFrame: function (object, frameIndex) {
        if (!object || !object.frames || frameIndex < 0 || frameIndex >= object.frames.length) return null;
        const currentFrame = object.frames[frameIndex];

        // Check current frame
        if (this.isValid(currentFrame.pae)) return currentFrame;

        // Use object-level tracking cache if available
        if (object._lastPaeFrame >= 0 && object._lastPaeFrame < frameIndex) {
            if (this.isValid(object.frames[object._lastPaeFrame].pae)) {
                return object.frames[object._lastPaeFrame];
            }
        }

        // Search backward
        for (let i = frameIndex - 1; i >= 0; i--) {
            if (this.isValid(object.frames[i].pae)) {
                // Update cache for next time
                object._lastPaeFrame = i;
                return object.frames[i];
            }
        }
        return null;
    },

    /**
     * EVERY MAP ON ONE FRAME, keyed by name, each `{data, n}`.
     *
     * `frame.pae` / `frame.pae_n` is the original pair and every payload
     * still carries it, so it is READ here rather than rewritten anywhere:
     * viewer.py's FRAME_ALWAYS, parts/ui.js's STATIC_FRAME_FIELDS and the
     * live update all keep the shape they had. A frame may also carry
     * `frame.maps`, which is `{key: {data, n}}` - or `{key: data}` for a
     * caller with nothing else to say - and that is the door a second map
     * arrives through.
     *
     * `maps.pae` WINS OVER `frame.pae` when a frame somehow has both: the
     * legacy field is what everything writes by default, so the explicit
     * one is the one that was meant.
     */
    mapsOfFrame: function (frame) {
        const out = {};
        if (!frame) return out;
        const m = frame.maps;
        if (m && typeof m === 'object') {
            for (const k of Object.keys(m)) {
                const e = m[k];
                if (!e) continue;
                const data = (e.data !== undefined) ? e.data : e;
                if (!this.isValid(data)) continue;
                out[k] = {
                    data,
                    n: e.n || e.residues || 0,
                    // 🔴 THE CODEC ARRIVES WITH THE DATA. viewer.py encodes
                    // `byte = round(value * per_unit)` and SENDS the number
                    // rather than trusting this file's table to match its
                    // own - a scale looked up on both sides is two tables
                    // that must agree. The registry's is the fallback, for a
                    // host page that wrote bytes into `frame.maps` itself.
                    // WHAT THE MAP SAYS ABOUT ITSELF, all optional and all
                    // beating the built-in registry: the value bounds the
                    // bytes were encoded against, the colour stops to draw
                    // them with, and what to call it on its tab.
                    vmin: (e.vmin === undefined || e.vmin === null) ? null : +e.vmin,
                    vmax: (e.vmax === undefined || e.vmax === null) ? null : +e.vmax,
                    colors: Array.isArray(e.colors) ? e.colors : null,
                    xlabel: (typeof e.xlabel === 'string') ? e.xlabel : null,
                    ylabel: (typeof e.ylabel === 'string') ? e.ylabel : null,
                    // 🔴 AND WHOSE CHAINS THESE ARE. The boundaries were ruled
                    // from `renderer.chains`, which belongs to whatever is
                    // DRAWN - and during a fold that is the PREVIOUS job's
                    // structure, because the new object has none yet. The
                    // guard that stood there compared LENGTHS, which cannot
                    // tell "this array describes this matrix" from "this
                    // array happens to be the same size": change the copy
                    // count or the sequence length so the totals coincide and
                    // the last job's boundaries are ruled across this
                    // picture. A map that states its own layout cannot be
                    // wrong about it.
                    chains: Array.isArray(e.chains) ? e.chains : null,
                    // ...and the pre-vmin/vmax spelling, which said the same
                    // thing as `vmin: 0, vmax: 255/perUnit`.
                    perUnit: e.per_unit || e.perUnit || 0,
                };
            }
        }
        if (!out[DEFAULT_MAP_KEY] && this.isValid(frame.pae)) {
            out[DEFAULT_MAP_KEY] = { data: frame.pae, n: frame.pae_n || 0 };
        }
        return out;
    },

    /**
     * Which maps this object has ANYWHERE in its frames, in a stable order:
     * the ones this panel knows a scale for, in registry order, then the
     * rest alphabetically. Stable because it is the tab order, and a strip
     * whose tabs move between frames is unusable.
     */
    mapKeysOf: function (object) {
        if (!object || !object.frames) return [];
        const seen = new Set();
        for (const f of object.frames) {
            for (const k of Object.keys(this.mapsOfFrame(f))) seen.add(k);
        }
        const known = MAP_ORDER.filter((k) => seen.has(k));
        const rest = [...seen].filter((k) => MAP_ORDER.indexOf(k) < 0).sort();
        return known.concat(rest);
    },

    /**
     * The frame holding a given map at or before `frameIndex` - the same
     * backward search resolveFrame does, asked about ONE map, because a
     * trajectory can carry a contact map every frame and a PAE only once.
     * `pae` is delegated so that core/mol.js's `_lastPaeFrame` bookkeeping
     * keeps working exactly as it did.
     */
    resolveMapFrame: function (object, frameIndex, key) {
        // 🔴 NO SPECIAL CASE FOR `pae`. This delegated that key to
        // resolveFrame - which reads the LEGACY `frame.pae` field and knows
        // nothing about `frame.maps` - so a PAE handed over as a full map
        // entry resolved to null on every frame and simply never appeared.
        // `mapsOfFrame` already folds the legacy field in under this key, so
        // one generic walk is correct for both and there is nothing to keep
        // in step. `resolveFrame` still exists for `resolveData`, which
        // core/mol.js calls.
        if (!object || !object.frames || frameIndex < 0
            || frameIndex >= object.frames.length) return null;
        const has = (f) => !!(f && this.mapsOfFrame(f)[key]);
        if (has(object.frames[frameIndex])) return object.frames[frameIndex];
        const cache = object._lastMapFrame || (object._lastMapFrame = {});
        const c = cache[key];
        // 🔴 THE CACHE IS A FLOOR, NOT AN ANSWER. Returning frames[c] straight
        // out skips every frame BETWEEN c and frameIndex - so once the cache
        // held frame 0, a frame carrying no map of its own resolved to the
        // FIRST map in the trajectory rather than the nearest one behind it.
        // A host that attaches a map just after adding its frame - which is
        // what computing one off the critical path means - lands in exactly
        // that window on every frame: the panel jumps back to the original
        // map and then snaps forward when the map arrives. It reads as a
        // flicker and it is a wrong answer.
        //
        // As a floor it still saves the scan it was written for: nothing below
        // c needs looking at, because c is known to have the map.
        const floor = (c >= 0 && c < frameIndex && has(object.frames[c])) ? c : 0;
        for (let i = frameIndex - 1; i >= floor; i--) {
            if (has(object.frames[i])) { cache[key] = i; return object.frames[i]; }
        }
        return null;
    },

    resolveData: function (object, frameIndex) {
        const f = this.resolveFrame(object, frameIndex);
        return f ? f.pae : null;
    },

    // Check if object has any PAE data
    hasData: function (object) {
        if (!object || !object.frames) return false;
        // ANY map, not just the PAE one - this is what decides whether the
        // container is shown at all, so an object carrying only a contact
        // map would otherwise be drawn into a panel set to display: none.
        return object.frames.some((f) => this.isValid(f.pae)
            || (f && f.maps && Object.keys(this.mapsOfFrame(f)).length > 0));
    },

    /**
     * The object whose matrix the panel shows. The renderer decides (see
     * heatmapObjectName); this is the fallback for a renderer that predates
     * it, where the edited object is the only object.
     */
    heatmapObject: function (renderer) {
        return renderer.heatmapObjectName
            ? renderer.heatmapObjectName() : renderer.currentObjectName;
    },

    /**
     * POINT THE PANEL AT WHAT IS ON SCREEN. Called whenever the drawn set
     * or the edited object changes - the two things heatmapObject() reads.
     * With no answer the panel is emptied as well as hidden, or the next
     * object to arrive would find the old matrix still in the canvas.
     */
    syncToDrawn: function (renderer) {
        if (!renderer.heatmapRenderer) return;
        const name = this.heatmapObject(renderer);
        const object = name ? renderer.objectsData[name] : null;
        if (!object) {
            renderer.heatmapRenderer.setData(null);
            this.updateVisibility(renderer);
            return;
        }
        // ...on the frame THAT object is on, which for anything but the
        // object being edited is the frame it was parked on.
        const parked = (object.viewerState && object.viewerState.currentFrame) || 0;
        const frameIndex = (name === renderer.currentObjectName)
            ? Math.max(0, renderer.currentFrame)
            : Math.max(0, Math.min(parked, object.frames.length - 1));
        this._show(renderer, object, frameIndex);
    },

    /**
     * Update the panel for a frame of ONE object.
     *
     * The callers all ask about the object being edited, because for most
     * of this viewer's life that was the only object there was. It is not
     * the object the panel belongs to once several are on screen - so the
     * question is answered about the owner instead of refused, and a frame
     * step on an object with no matrix stops wiping out the matrix of the
     * prediction next to it.
     */
    updateFrame: function (renderer, object, frameIndex) {
        if (!renderer.heatmapRenderer) return;
        const owner = this.heatmapObject(renderer);
        const name = object && object.name;
        if (name && name !== owner) return this.syncToDrawn(renderer);
        if (!owner && name) return this.syncToDrawn(renderer);
        this._show(renderer, object, frameIndex);
    },

    _show: function (renderer, object, frameIndex) {
        // EACH MAP IS RESOLVED ON ITS OWN. They need not live on the same
        // frame: a prediction may carry its PAE once at frame 0 and a
        // contact map on every step of a trajectory.
        const maps = {};
        for (const key of this.mapKeysOf(object)) {
            const f = this.resolveMapFrame(object, frameIndex, key);
            const m = f && this.mapsOfFrame(f)[key];
            if (m) maps[key] = m;
        }
        renderer.heatmapRenderer.setMaps(maps);
        // ...and every other panel in the pool, each pinned to its own key.
        const pool = renderer._heatmapPool;
        if (pool) for (const e of pool) if (e.hm !== renderer.heatmapRenderer) e.hm.setMaps(maps);
        this.updateVisibility(renderer);
    },

    /** What a tab calls a map. */
    labelFor: function (key) { return labelFor(key); },

    /** The maps loaded right now, in the order the frame gave them. */
    loadedKeys: function (renderer) {
        const hm = renderer.heatmapRenderer;
        return hm && hm.maps ? Object.keys(hm.maps) : [];
    },

    /**
     * ONE PANEL PER MAP ON SCREEN, AND NO MORE. parts/slots.js asks for the
     * maps it is showing - none, one or two - and gets back the container to
     * put where for each.
     *
     * 🔴 A PANEL BELONGS TO A MAP, NOT TO A SLOT. Moving a map from one
     * slot to another moves its panel, so the colour image it already
     * built comes with it and a swap costs a layout, not two n^2 rebuilds.
     *
     * The page's own panel is always the pool's first entry and is PARKED
     * when no map is showing - kept, because core/mol.js and every host hold
     * `renderer.heatmapRenderer`. A second one exists only while two maps
     * are on screen together and is destroyed the moment that stops, which
     * is what keeps a layout with at most one map at exactly the memory it
     * had before there were slots.
     */
    slotPanels: function (renderer, keys) {
        const primary = renderer.heatmapRenderer;
        if (!primary || !renderer.heatmapContainer) return {};
        if (!renderer._heatmapPool) {
            renderer._heatmapPool = [{ hm: primary, panel: renderer.heatmapContainer, key: null }];
        }
        const pool = renderer._heatmapPool;
        for (const e of pool) e.hm.slotted = true;
        const out = {};
        const taken = new Set();
        // ...each map keeps the panel already showing it,
        for (const key of keys) {
            const e = pool.find((x) => x.key === key);
            if (e) { out[key] = e; taken.add(e); }
        }
        // ...and the rest take a free one, or a new one.
        for (const key of keys) {
            if (out[key]) continue;
            let e = pool.find((x) => !taken.has(x));
            if (!e) {
                e = this._extraPanel(renderer);
                if (!e) continue;
                pool.push(e);
            }
            e.key = key;
            out[key] = e;
            taken.add(e);
        }
        for (let i = pool.length - 1; i >= 0; i--) {
            const e = pool[i];
            if (taken.has(e)) {
                // The key first, so whichever of these selects - a new panel
                // being handed the maps, or a parked one coming back - selects
                // THIS map, and it is decoded once rather than twice.
                e.hm._wantKey = e.key;
                if (e.hm.maps !== primary.maps) e.hm.setMaps(primary.maps);
                e.hm.unpark();
                e.hm.pin(e.key);
                continue;
            }
            e.key = null;
            if (e.hm === primary) {
                e.hm.park();
            } else {
                e.hm.destroy();
                if (e.panel.parentNode) e.panel.parentNode.removeChild(e.panel);
                pool.splice(i, 1);
            }
        }
        const panels = {};
        for (const key of Object.keys(out)) panels[key] = out[key].panel;
        return panels;
    },

    /**
     * A second panel, dressed like the page's own. The shells style the
     * panel by ID, which a second element cannot share - so what the id
     * bought (border, corners, ground) is copied off the first as it
     * computes, and nothing about any shell's stylesheet has to change.
     */
    _extraPanel: function (renderer) {
        const first = renderer.heatmapContainer;
        if (!first || typeof document === 'undefined') return null;
        const panel = document.createElement('div');
        panel.className = first.className;
        panel.classList.add('py2dmol-heatmap-extra');
        const cs = getComputedStyle(first);
        for (const k of ['borderTopWidth', 'borderTopStyle', 'borderTopColor',
            'borderRightWidth', 'borderRightStyle', 'borderRightColor',
            'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
            'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
            'borderRadius', 'backgroundColor', 'boxShadow', 'boxSizing']) {
            panel.style[k] = cs[k];
        }
        panel.style.position = 'relative';
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position: absolute; display: block; cursor: crosshair; touch-action: none;';
        panel.appendChild(canvas);
        const hm = mountPanel(renderer, panel, canvas);
        hm.slotted = true;
        return { hm, panel, key: null };
    },

    // Update PAE container visibility
    updateVisibility: function (renderer) {
        // Find container if not cached
        if (!renderer.heatmapContainer) {
            if (renderer.canvas && renderer.canvas.parentElement) {
                const main = renderer.canvas.parentElement.closest('#mainContainer');
                renderer.heatmapContainer = findIn(main, PANEL_IDS)
                    || findIn(document, PANEL_IDS);
            }
        }
        const container = renderer.heatmapContainer;
        if (!container) return; // Should we warn?

        // Determine visibility
                // But we need to know if the CURRENT object has PAE

        // WHOSE MATRIX THIS IS - not simply the object being edited. With
        // several objects on screen the panel belongs to the one whose
        // residues its rows count, and when that object is not drawn there
        // is nothing for the panel to describe. See heatmapObjectName.
        const name = Heatmap.heatmapObject(renderer);
        const object = name ? renderer.objectsData[name] : null;
        // 🔴 OR WHATEVER THE RENDERER IS ALREADY HOLDING, because a map can
        // exist before any structure does. AlphaFold 3 computes its distogram
        // in the trunk and runs every recycle before the sampler emits a
        // single frame, so a host with a contact map to show during that has
        // no frame to put it on - it calls setMaps directly. Keyed only on the
        // object's frames, the panel stayed hidden through the longest part of
        // a fold with a perfectly good map loaded.
        const loaded = renderer.heatmapRenderer && renderer.heatmapRenderer.maps;
        const hasAny = (object ? this.hasData(object) : false)
            || !!(loaded && Object.keys(loaded).length);

        // 🔴 SHOWING THE PANEL IS A LAYOUT INPUT TOO, and this is the third
        // time that has bitten: a hidden element has `clientWidth` 0, so a
        // relayout that runs before this line measures NOTHING and falls
        // back to the 340 default - which is 2px wider than the real padding
        // box on index.html, and every gap is then off by that. The whole
        // sequence runs hidden: _syncTabs relayouts, _syncAxes relayouts,
        // and only afterwards does the container become visible.
        const wasShown = container.style.display;
        container.style.display = hasAny ? 'flex' : 'none';
        const canvas = findIn(container, CANVAS_IDS);
        if (canvas) canvas.style.display = hasAny ? 'block' : 'none';
        if (wasShown !== container.style.display && renderer.heatmapRenderer
            && renderer.heatmapRenderer._relayout) {
            renderer.heatmapRenderer._relayout();
        }
    },

    // Initialization logic for core/mol.js to call
    initialize: function (renderer, containerElement, config) {
        // Either spelling - normalizeConfig aliases them to one object, and a
    // host page may hand show() a raw config that never went through it.
    if (!(config.heatmap?.enabled ?? config.pae?.enabled)) return;

        try {
            // Find PAE container and canvas
            // Try finding within containerElement first to support multiple viewers
            let heatmapPanel = findIn(containerElement, PANEL_IDS);

            // Fallback for grid/standalone if not nested
            if (!heatmapPanel) {
                const mainWithId = containerElement.closest('#mainContainer');
                if (mainWithId) heatmapPanel = findIn(mainWithId, PANEL_IDS);
            }

            if (!heatmapPanel) {
                // Last resort document query
                heatmapPanel = findIn(document, PANEL_IDS);
            }

            if (!heatmapPanel) return; // Can't initialize

            const heatmapCanvas = findIn(heatmapPanel, CANVAS_IDS);
            if (!heatmapCanvas) return;

            renderer.heatmapContainer = heatmapPanel;
            heatmapPanel.style.display = 'none';

            const heatmapRenderer = mountPanel(renderer, heatmapPanel, heatmapCanvas);
            renderer.setHeatmapRenderer(heatmapRenderer);

            // If static data loaded, set data
            if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                const object = renderer.objectsData[renderer.currentObjectName];
                // Use renderer.currentFrame or 0
                const frameIdx = renderer.currentFrame >= 0 ? renderer.currentFrame : 0;
                this.updateFrame(renderer, object, frameIdx);
            }

            this.updateVisibility(renderer);

        } catch (e) {
            console.error("Failed to initialize the heatmap panel:", e);
        }
    }
};

// ============================================================================
// EXPOSE
// ============================================================================
// 🔴 THE OLD NAMES STAY AS ALIASES, because this project has no modules and a
// global IS the interface. `window.PAE` was reachable from any host page for
// as long as the panel has existed, and a rename that turns a working call
// into `undefined is not a function` is exactly the silent break the DOM
// ids in the header are not renamed to avoid. They cost four lines.
window.Heatmap = Heatmap;
window.HeatmapRenderer = HeatmapRenderer;
window.PAE = Heatmap;                  // pre-heatmap name
window.PAERenderer = HeatmapRenderer;  // pre-heatmap name

if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('py2dmol_heatmap_loaded'));
    window.dispatchEvent(new Event('py2dmol_pae_loaded'));  // pre-heatmap name
}

})();
