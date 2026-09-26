// ============================================================================
// src/panels/plddt.js
// -----------------------------------
// AI Context: THE CONFIDENCE TRACE, AS A GRAPH RATHER THAN A PICTURE
// - A line plot of the drawn frame's pLDDT, one point per residue
// - SVG in the DOM, not a canvas: the marks ARE elements, so hovering and
//   dragging are events on them and nothing is ever repainted pixel by pixel
// - Drag selects those residues, through the renderer's own setter
// ============================================================================

(function () {
'use strict';

// 🔴 SCOPED TO THE VIEWER, THEN THE PAGE. The sequence strip and the MSA are
// `document`-scoped and two of them on one page find each other's; the heatmap
// panel already does it this way and this follows it rather than the older two.
// The second lookup is not a fallback for a missing box - it is where an
// EMBED's box lives: `show()` replaces its container's children, so a host
// page puts the panel beside the viewer rather than inside it.
const BOX_ID = '#plddtContainer';
const NS = 'http://www.w3.org/2000/svg';

// Room for the axis, in the SAME units the plot is laid out in - which are
// CSS pixels, because the viewBox tracks the box. No device-pixel scaling
// anywhere: an SVG line is resolution-independent by construction, which is
// most of the reason this is not a canvas.
// Room for the axis, in the SAME units the plot is laid out in - CSS pixels,
// because the viewBox tracks the box. `left` holds a three-digit label AND the
// rotated axis title; `bottom` holds the residue numbers and the chain letters.
const PAD = { left: 42, right: 12, top: 10, bottom: 32 };
// AlphaFold's own cuts, which is what a confidence plot is read in. 70 and 90
// are the ones that mean something, so they are drawn darker than the rest.
const BANDS = [0, 50, 70, 90, 100];
const INK = '#444';

/**
 * THE CROSSING, BOTH DIRECTIONS, IN ONE PLACE.
 *
 * 🔴 A RESIDUE IS A BAND, NOT A POINT. With N residues over W pixels a residue
 * owns W/N of them - under one on anything large, several on a peptide - and
 * the line, the selection band and the hit test must agree about which. Every
 * worst fault in the heatmap panel has been a crossing one of its drawings was
 * not told about; the answer there was the same as here, which is to convert
 * once and hand the answer to everything that needs it.
 */
const xOf = (r, n, box) => box.x + (n > 1 ? (r * box.w) / (n - 1) : box.w / 2);
const bandOf = (r, n, box) => {
    const w = box.w / Math.max(1, n);
    return { x0: box.x + r * w, x1: box.x + (r + 1) * w };
};
const residueAt = (px, n, box) => {
    if (!(n > 0) || !(box.w > 0)) return -1;
    const r = Math.floor((px - box.x) * n / box.w);
    return r < 0 ? 0 : (r >= n ? n - 1 : r);
};

const el = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    for (const k in attrs) if (attrs[k] !== null) node.setAttribute(k, attrs[k]);
    return node;
};

class PlddtGraph {
    constructor(container, mainRenderer) {
        this.container = container;
        this.mainRenderer = mainRenderer;
        // 🔴 EMPTY, NEVER NULL. `setCoords` pads all three - the confidence to
        // 50.0, the chains to 'A', the numbers to -1 - so they are arrays from
        // the first structure onwards, and starting them empty means nothing
        // downstream has to ask whether they are there. An `n` of 0 is the
        // only "no data" state and `draw` already returns on it.
        this.values = [];   // per RESIDUE, this frame's
        this.chains = [];
        this.numbers = [];
        this.isDragging = false;
        this.dragFrom = -1;
        this.dragTo = -1;
        this.dragAdds = false;
        this.w = 0;
        this.h = 0;

        const svg = el('svg', {
            xmlns: NS, preserveAspectRatio: 'none',
            style: 'width:100%;height:100%;display:block;cursor:crosshair;'
                 + 'background:#fff;user-select:none',
        });
        svg.id = 'plddtSvg';
        this.svg = svg;
        // ONE GROUP PER LAYER, in paint order, created once. Redrawing means
        // replacing the children of a group - never rebuilding the <svg>,
        // which would drop the listeners and the element under the pointer.
        this.gGrid = el('g', { 'stroke-width': '1', stroke: '#e2e2e2' });
        this.gSel = el('g', { fill: 'rgba(255,213,79,0.45)' });
        this.gChain = el('g', { stroke: 'rgba(0,0,0,0.4)', 'stroke-width': '1' });
        this.gLine = el('g', null);
        this.gText = el('g', { fill: INK, 'font-size': '11',
                               'font-family': 'system-ui, sans-serif' });
        this.hover = el('line', { stroke: '#666', 'stroke-width': '1',
                                  'stroke-dasharray': '2 2', visibility: 'hidden' });
        this.line = el('polyline', { fill: 'none', stroke: '#3b82f6',
                                     'stroke-width': '1.5',
                                     'stroke-linejoin': 'round' });
        this.gLine.appendChild(this.line);
        for (const g of [this.gGrid, this.gSel, this.gChain, this.gLine, this.gText]) {
            svg.appendChild(g);
        }
        svg.appendChild(this.hover);

        // The readout, plain DOM over the graph - a <title> would need a
        // hover pause and cannot follow the pointer.
        this.tip = document.createElement('div');
        this.tip.style.cssText = 'position:absolute;pointer-events:none;'
            + 'background:rgba(0,0,0,0.75);color:#fff;font:11px sans-serif;'
            + 'padding:1px 5px;border-radius:3px;white-space:nowrap;'
            + 'visibility:hidden;z-index:2';
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        container.appendChild(svg);
        container.appendChild(this.tip);
        this._dirtySize = true;
        this._ro = new ResizeObserver(() => { this._dirtySize = true; });
        this._ro.observe(container);
        this.setupInteraction();
    }

    get n() { return this.values.length; }

    /**
     * 🔴 WHAT THE FILE CALLS THIS RESIDUE, NOT WHERE IT SITS IN THE ARRAY.
     * A position index and a residue number are different integers that both
     * look like integers - this tree's own words - and they differ whenever a
     * structure does not start at 1, which is most crystal structures, every
     * construct with a cleaved tag, and every chain after the first. Labelling
     * the axis with `index + 1` puts "1, 10, 20" under residues 100, 110, 120.
     * `-1` is the pad `setCoords` leaves when a file named no number, and the
     * fallback is the one panels/seq.js already uses.
     */
    /**
     * ONE WALK, THREE ANSWERS: where the chains break, what each is called,
     * and where each line starts and stops. They are the same fact, and two
     * walks of it drift by a residue - at which point the boundary rule stops
     * landing where the line breaks.
     */
    spans() {
        const n = this.n, out = [];
        if (!(n > 0)) return out;
        let start = 0;
        for (let r = 1; r <= n; r++) {
            const cut = r === n || this.chains[r] !== this.chains[r - 1];
            if (!cut) continue;
            out.push({ from: start, to: r - 1, id: this.chains[start] });
            start = r;
        }
        return out;
    }

    numAt(i) {
        const v = this.numbers[i];
        return (v === null || v === undefined || v === -1) ? i + 1 : v;
    }

    /**
     * 🔴 THE RESIDUES ARE `_baseCount()`, NOT `values.length`. Showing side
     * chains APPENDS their atoms as real positions and the confidence array is
     * per POSITION - so a structure with its side chains out would draw a line
     * several times too long, most of it repeating one residue. The heatmap
     * panel learnt this from the other side, where comparing `chains.length`
     * switched its chain rules off for exactly that case.
     */
    setData(values, chains, baseCount, numbers) {
        const n = baseCount;
        this.values = Array.prototype.slice.call(values, 0, n);
        this.chains = Array.prototype.slice.call(chains, 0, n);
        this.numbers = Array.prototype.slice.call(numbers, 0, n);
    }

    /**
     * 🔴 THE STROKE IS A SHARE OF THE BOX, NOT A CONSTANT. 1.5px is right in a
     * 340px card, heavy in a 180px control column - where it is a fortieth of
     * the height and the trace reads as a band rather than a line - and thin
     * on a full-screen slot. Taken from the SMALLER side, because that is what
     * bounds the plot, and clamped: under 1 a line disappears on a
     * non-retina display, over ~2.5 it starts hiding the dips it is drawn to
     * show.
     */
    strokeWidth() {
        const b = this.box();
        return Math.max(1, Math.min(2.4, Math.min(b.w, b.h) / 190)).toFixed(2);
    }

    box() {
        return { x: PAD.left, y: PAD.top,
                 w: Math.max(0, this.w - PAD.left - PAD.right),
                 h: Math.max(0, this.h - PAD.top - PAD.bottom) };
    }

    yOf(v) {
        const b = this.box();
        return b.y + b.h * (1 - Math.max(0, Math.min(100, v)) / 100);
    }

    /**
     * The viewBox tracks the element's own box, so one unit is one CSS pixel.
     *
     * 🔴 AND IT IS NOT ASKED EVERY FRAME. `getBoundingClientRect` FLUSHES
     * style and layout, so calling it from the render loop makes the browser
     * re-lay-out the page sixty times a second on a graph that changes size
     * about twice an hour - and the cost lands on whatever else the loop is
     * doing, which is the structure. Reported as switching between the trace
     * and the structure lagging. A ResizeObserver says when the box moved;
     * between those, the last measurement stands.
     */
    measure() {
        if (!this._dirtySize && this.w > 0 && this.h > 0) return false;
        this._dirtySize = false;
        const r = this.container.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
        if (w === this.w && h === this.h) return false;
        this.w = w; this.h = h;
        this.svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
        return true;
    }

    draw() {
        const n = this.n, b = this.box();
        if (!(b.w > 0) || !(b.h > 0)) return;
        const put = (g, kids) => {
            while (g.firstChild) g.removeChild(g.firstChild);
            for (const k of kids) g.appendChild(k);
        };

        // Y AXIS: a rule and a number at each band, with 70 and 90 darker -
        // they are the cuts a reader is actually looking for.
        put(this.gGrid, BANDS.map((v) => el('line', {
            x1: b.x, x2: b.x + b.w, y1: this.yOf(v), y2: this.yOf(v),
            stroke: (v === 70 || v === 90) ? '#c2c2c2' : '#e6e6e6' })));

        const xSpans = this.spans();
        const texts = [];
        for (const v of BANDS) {
            const t = el('text', { x: b.x - 5, y: this.yOf(v) + 3.5,
                                   'text-anchor': 'end' });
            t.textContent = String(v);
            texts.push(t);
        }
        // ...and the axis says what the numbers ARE. Rotated, because a
        // horizontal title would cost more width than the plot can spare in a
        // 180px control column.
        const title = el('text', {
            x: 0, y: 0, 'text-anchor': 'middle', fill: INK,
            'font-weight': '600',
            transform: 'translate(11,' + (b.y + b.h / 2) + ') rotate(-90)' });
        title.textContent = 'pLDDT';
        texts.push(title);

        // X AXIS: FRIENDLY RESIDUE NUMBERS, PER CHAIN.
        //
        // The ticks are chosen in RESIDUE-NUMBER space, not index space, so
        // they land on round numbers a reader would have picked - 10, 20, 30 -
        // and per CHAIN, because numbering restarts at every one of them: a
        // single axis across two chains would have to count through B's
        // residue 1 as though it came after A's last.
        //
        // The step is a power of ten times 1, 2 or 5, so a short chain reads
        // 1,2,3, a domain reads 10,20,30 and a ribosomal protein reads
        // 100,200,300, with the count falling as the box narrows.
        //
        // 🔴 AND THE LABEL IS THE NUMBER THAT IS THERE. Where numbering has a
        // GAP the tick goes to the first residue at or past the round number
        // and is labelled with what that residue actually is - so a plot never
        // claims a residue the structure does not contain.
        const tickAt = (idx, label) => {
            const x = xOf(idx, n, b);
            this.gGrid.appendChild(el('line', { x1: x, x2: x, y1: b.y,
                y2: b.y + b.h, stroke: '#ededed' }));
            texts.push(el('line', { x1: x, x2: x, y1: b.y + b.h,
                                    y2: b.y + b.h + 3, stroke: '#c2c2c2' }));
            const t = el('text', { x: x, y: b.y + b.h + 14, 'text-anchor': 'middle' });
            t.textContent = String(label);
            texts.push(t);
        };
        // 🔴 THE COLLISION GUARD IS ACROSS THE WHOLE AXIS, NOT WITHIN A CHAIN.
        // Kept per span it only stops a chain colliding with ITSELF, and 4HHB
        // is four globins plus six hemes and ions of one or two residues each:
        // every tiny span emitted its own ticks and the right-hand end read
        // "10014214821421 48". One left-to-right cursor for every label there
        // is, whichever chain asked for it.
        let last = -Infinity;
        const place = (idx, label) => {
            const px = xOf(idx, n, b);
            if (px - last < 24) return;
            last = px;
            this.gGrid.appendChild(el('line', { x1: px, x2: px, y1: b.y,
                y2: b.y + b.h, stroke: '#ededed' }));
            texts.push(el('line', { x1: px, x2: px, y1: b.y + b.h,
                                    y2: b.y + b.h + 3, stroke: '#c2c2c2' }));
            const t = el('text', { x: px, y: b.y + b.h + 14, 'text-anchor': 'middle' });
            t.textContent = String(label);
            texts.push(t);
        };
        for (const sp of xSpans) {
            const lo = this.numAt(sp.from), hi = this.numAt(sp.to);
            const spanW = xOf(sp.to, n, b) - xOf(sp.from, n, b);
            // ...and a span too narrow to hold one label gets NONE. A heme is
            // one residue: a number under it says nothing the chain letter
            // does not, and it is the thing that was overprinting its
            // neighbours.
            if (spanW < 26) continue;
            const room = Math.max(1, Math.floor(spanW / 40));
            let step = 1;
            while (Math.floor(Math.max(0, hi - lo) / step) > room) {
                const mag = Math.pow(10, Math.floor(Math.log10(step)));
                const lead = Math.round(step / mag);
                step = (lead === 1) ? 2 * mag : (lead === 2) ? 5 * mag : 10 * mag;
            }
            place(sp.from, lo);
            let mark = Math.ceil((lo + 1) / step) * step;
            for (let r = sp.from; r <= sp.to; r++) {
                const v = this.numAt(r);
                if (v < mark) continue;
                place(r, v);
                mark = Math.floor(v / step) * step + step;
            }
        }
        put(this.gText, texts);

        // 🔴 THE SELECTION IS A BAND UNDER THE LINE, not a mark on it: a blot
        // over the one thing you are reading is what the `outline` selection
        // mark exists to avoid.
        const sel = this.mainRenderer && this.mainRenderer.residueSelection;
        const rects = [];
        if (sel && sel.size && n > 0) {
            // contiguous runs, so a range is ONE rect rather than N
            let start = -1;
            for (let r = 0; r <= n; r++) {
                const inside = r < n && sel.has(r);
                if (inside && start < 0) start = r;
                if (!inside && start >= 0) {
                    const a = bandOf(start, n, b), z = bandOf(r - 1, n, b);
                    rects.push(el('rect', { x: a.x0, y: b.y,
                        width: Math.max(1, z.x1 - a.x0), height: b.h }));
                    start = -1;
                }
            }
        }
        put(this.gSel, rects);

        // 🔴 ONE LINE PER CHAIN, NOT ONE LINE. A single polyline joins the last
        // residue of a chain to the first of the next, which draws a segment
        // between two residues that are not neighbours and are not even in the
        // same molecule - a slope across the boundary that means nothing. The
        // runs are cut where the chain letter changes, which is the same place
        // the boundary rule is drawn, from the same walk.
        const spans = xSpans;
        const marks = [];
        for (let i = 1; i < spans.length; i++) {
            const x = bandOf(spans[i].from, n, b).x0;
            marks.push(el('line', { x1: x, x2: x, y1: b.y, y2: b.y + b.h }));
        }
        put(this.gChain, marks);

        // ...and the letter under each span, but only when there is more than
        // one: a single chain's 'A' under every plot is a label that never
        // varies, which is a label that says nothing.
        if (spans.length > 1) {
            let lastLetter = -Infinity;
            for (const sp of spans) {
                if (!sp.id) continue;
                const mid = (xOf(sp.from, n, b) + xOf(sp.to, n, b)) / 2;
                // ...and a letter that would sit on its neighbour is dropped:
                // six ligand chains in the last 4% of the axis cannot each
                // have a legible label, and overlapping ones name nothing.
                if (mid - lastLetter < 11) continue;
                lastLetter = mid;
                const t = el('text', { x: mid, y: b.y + b.h + 27,
                                       'text-anchor': 'middle',
                                       'font-weight': '600' });
                t.textContent = String(sp.id);
                this.gText.appendChild(t);
            }
        }

        // 🔴 ONE LINE PER CHAIN, NOT ONE LINE. A single polyline joins the last
        // residue of a chain to the first of the next, which draws a segment
        // between two residues that are not neighbours and are not even in the
        // same molecule - a slope across the boundary that means nothing.
        const runs = [];
        for (const sp of spans) {
            const run = [];
            for (let r = sp.from; r <= sp.to; r++) {
                const v = this.values[r];
                if (v === null || v === undefined || isNaN(v)) continue;
                run.push(xOf(r, n, b).toFixed(1) + ',' + this.yOf(v).toFixed(1));
            }
            if (run.length) runs.push(run);
        }

        // The first run stays on `this.line` so anything holding it still
        // works; the rest are siblings, made fresh each draw. Emptied and
        // re-appended rather than trimmed back to a sentinel: a `while
        // (lastChild !== this.line)` never ends if that node is not a child,
        // and an unbounded loop in a draw path takes the tab with it.
        const lw = this.strokeWidth();
        this.line.setAttribute('stroke-width', lw);
        while (this.gLine.firstChild) this.gLine.removeChild(this.gLine.firstChild);
        this.gLine.appendChild(this.line);
        for (let i = 1; i < runs.length; i++) {
            this.gLine.appendChild(el('polyline', {
                fill: 'none', stroke: '#3b82f6', 'stroke-width': lw,
                'stroke-linejoin': 'round', points: runs[i].join(' ') }));
        }
        const pts = runs.length ? runs[0] : [];
        this.line.setAttribute('points', pts.join(' '));
        this.hover.setAttribute('y1', b.y);
        this.hover.setAttribute('y2', b.y + b.h);
    }

    _dragRange() {
        const a = Math.min(this.dragFrom, this.dragTo);
        const z = Math.max(this.dragFrom, this.dragTo);
        const out = new Set();
        for (let r = a; r <= z; r++) out.add(r);
        return out;
    }

    _apply() {
        const r = this.mainRenderer;
        const next = this._dragRange();
        if (this.dragAdds && r.residueSelection) {
            for (const i of r.residueSelection) next.add(i);
        }
        // 🔴 THROUGH THE SETTER, NEVER THE FIELD. `parts/ui.js` WRAPS
        // `setResidueSelection` to drive focus mode, and `panels/seq.js`
        // writing the field directly is why a strip click used to go straight
        // past it - the same two lines in a second place.
        r.setResidueSelection(next);
        this._sig = null;
        this.draw();
    }

    _at(e) {
        const rect = this.svg.getBoundingClientRect();
        const px = (e.clientX - rect.left) * (this.w / Math.max(1, rect.width));
        return residueAt(px, this.n, this.box());
    }

    setupInteraction() {
        const svg = this.svg;
        svg.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || !this.n) return;
            this.isDragging = true;
            this.dragAdds = e.shiftKey;
            this.dragFrom = this.dragTo = this._at(e);
            this._apply();
            e.preventDefault();
        });
        svg.addEventListener('mousemove', (e) => {
            const r = this._at(e);
            if (r >= 0 && this.n) {
                const b = this.box(), x = xOf(r, this.n, b);
                this.hover.setAttribute('x1', x);
                this.hover.setAttribute('x2', x);
                this.hover.setAttribute('visibility', 'visible');
                const v = this.values[r];
                const who = this.chains[r] ? this.chains[r] + ':' : '';
                this.tip.textContent = who + this.numAt(r) + '  ' + (v === null || v === undefined
                    ? '-' : Math.round(v * 10) / 10);
                this.tip.style.visibility = 'visible';
                const rect = this.svg.getBoundingClientRect();
                const host = this.container.getBoundingClientRect();
                this.tip.style.left = (e.clientX - host.left + 8) + 'px';
                this.tip.style.top = (rect.top - host.top + 4) + 'px';
            }
            if (!this.isDragging || r === this.dragTo) return;
            this.dragTo = r;
            this._apply();
        });
        svg.addEventListener('mouseleave', () => {
            this.isDragging = false;
            this.hover.setAttribute('visibility', 'hidden');
            this.tip.style.visibility = 'hidden';
        });
        svg.addEventListener('mouseup', () => { this.isDragging = false; });
        svg.addEventListener('dblclick', () => {
            // The way back out is `clearResidueSelection`, NOT the setter with
            // an empty set: parts/ui.js reads the two differently, and wrapping
            // only the setter is how the gesture a reader makes came to be the
            // one that did not work.
            this.mainRenderer.clearResidueSelection();
        });
    }
}

window.Plddt = {
    PlddtGraph: PlddtGraph,

    container: function (renderer) {
        const root = renderer && renderer.container;
        return (root && root.querySelector(BOX_ID)) || document.querySelector(BOX_ID);
    },

    /**
     * Is there anything to plot?
     *
     * 🔴 ASKED OF THE OBJECT, NOT OF THE DRAWN FRAME - which is what every
     * other view here does and what this got wrong. A map resolves BACKWARDS
     * on its own (`a trajectory can carry a contact map every frame and a PAE
     * once`), and `objectHasScatter` walks the frames; the confidence array
     * resolves backwards too, in `_resolvePlddtData`. But `setCoords` PADS a
     * frame that names none to a flat 50.0, and the flatness test below then
     * answered "no data" for that frame - so the tab came and went as the play
     * bar moved, while the PAE beside it stayed put. Reported as pLDDT
     * appearing only on the frames that carry it.
     *
     * 🔴 AND A CONSTANT IS STILL NOT A MEASUREMENT. That pad is why: every
     * structure ever loaded has an array of numbers, so "there are numbers" is
     * true of a 1987 crystal file. What earns a tab is an array that VARIES,
     * anywhere in the object.
     */
    hasData: function (renderer) {
        if (!renderer) return false;
        const name = renderer.currentObjectName;
        const object = name && renderer.objectsData && renderer.objectsData[name];
        const varies = (arr, n) => {
            if (!arr || !arr.length) return false;
            const end = Math.min(n || arr.length, arr.length);
            const first = arr[0];
            for (let i = 1; i < end; i++) if (arr[i] !== first) return true;
            return false;
        };
        if (object && object.frames && object.frames.length) {
            for (let i = 0; i < object.frames.length; i++) {
                const f = object.frames[i];
                if (f && varies(f.plddts)) return true;
            }
            // An object whose frames name none has nothing to plot, whatever
            // the drawn array was padded to.
            return false;
        }
        // 🔴 AND NO OBJECT MEANS NO PLOT, WITH NO FALLBACK TO THE DRAWN ARRAY.
        // `clearAllObjects` empties `objectsData` and nulls the current name
        // but does NOT clear `this.plddts` - so a fallback that reads the
        // drawn array answers TRUE after a Clear All and leaves a tab over a
        // structure that no longer exists, plotting the last one's numbers.
        // The leftovers-after-Clear-All fault this file has three other
        // records of.
        //
        // There was such a fallback, written for "a host that put the array
        // straight on the renderer, which a fold's trunk does". It does not:
        // the trunk writes `renderer.chains`, and nothing in this tree or in
        // LocalFold assigns `.plddts` at all. It was a user I asserted and
        // did not check.
        return false;
    },

    initialize: function (renderer) {
        const box = this.container(renderer);
        if (!box) return null;
        if (renderer.plddtRenderer && renderer.plddtRenderer.container === box) {
            return renderer.plddtRenderer;
        }
        renderer.plddtRenderer = new PlddtGraph(box, renderer);
        renderer.plddtContainer = box;
        return renderer.plddtRenderer;
    },

    /**
     * Called on every frame the slot shows it: the data is the DRAWN frame's.
     *
     * 🔴 AND IT CARRIES ITS OWN SIGNATURE, because the driver cannot. The
     * render loop asks every frame and a still structure has nothing new to
     * say. What is compared is what the graph DRAWS FROM: the object, the
     * frame, the residue count, the box and the selection. The frame index
     * stands for the values - re-reading the array to hash it would cost more
     * than rebuilding the line.
     */
    update: function (renderer) {
        const p = renderer && renderer.plddtRenderer;
        if (!p) return;
        const n = renderer._baseCount();
        const sel = renderer.residueSelection;
        const resized = p.measure();
        const sig = [renderer.currentObjectName, renderer.currentFrame, n,
                     p.w, p.h, sel ? sel.size : 0,
                     // size alone cannot see a selection that MOVED: a drag
                     // from 10-20 to 30-40 is the same count. O(1) on a Set,
                     // where a min/max would be O(size) and "select all" is
                     // every residue.
                     sel ? sel.values().next().value : -1].join('\u0000');
        if (!resized && sig === p._sig) return;
        p._sig = sig;
        p.setData(renderer.plddts, renderer.chains, n, renderer.residueNumbers);
        p.draw();
    },

    /** Forget the last signature, so the next frame redraws whatever happens. */
    invalidate: function (renderer) {
        const p = renderer && renderer.plddtRenderer;
        if (p) p._sig = null;
    },
};
})();
