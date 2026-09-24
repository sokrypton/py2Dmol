// ============================================================================
// src/parts/slots.js
// ------------------
// AI Context: N SLOTS, NUMBERED FROM 1 (window.py2dmolSlots)
// - A viewer is an ordered list of slots. Slot 1 is where the structure was,
//   slot 2 where the heatmap was, and a shell may one day provide more.
// - Every slot carries the same tabs - Structure, each map, Scatter - and a
//   view lives in exactly one of them: picking one another slot is showing
//   swaps the two.
// - A view with no data has no tab. A slot with no view is hidden.
// ============================================================================
// WHY THIS EXISTS. An object with no coordinates - a fold whose trunk has
// produced a contact map and no structure yet - left a 600px empty canvas
// beside a 340px map, which is the picture exactly backwards. Rather than a
// rule for that one case, the two boxes became places and the views became
// things that go in them, and the empty case is simply the default choice:
// with nothing to draw, the first slot takes the first thing there is.
//
// 🔴 A SLOT IS AN INDEX, NOT A SIZE. They were `big` and `small` for one
// release and that name carried three claims at once - which slot comes
// first, how large it is, and which one may be dragged. Only the FIRST is
// this file's business: the website makes slot 1 600px and slot 2 340 in its
// own stylesheet, and where nothing says otherwise a slot is the size the
// caller asked the VIEWER for - so in the notebook `big` and `small` were two
// names for one number. Everything a shell can decide for itself is in the
// shell's CSS, keyed on `.py2dmol-slot--1`, `--2`, ...; what is left here is
// the order. `big`/`small` are still accepted at every door - see
// `normalizeAsk` - because a host page and a saved notebook hold them.
// (FULL SCREEN IS SLOT 1's ALONE and lives in parts/viewport.js: sizing a box
// is a thing you do to that box, where going full screen takes over the page.)
//
// 🔴 AND "NOTHING SAYS OTHERWISE" IS THE WHOLE OF THE SIZE RULE. A box that
// arrives with an inline size KEEPS it - `makeSlot` moves it to the slot -
// which is how `embed.html`'s own 260px `#heatmapContainer` stays 260 and how
// a host page sizes a slot at all. The viewer's size is the FALLBACK, for a
// box that states none, which is the notebook's panel and the embed's when
// its page says nothing.
//
// 🔴 NOTHING IS DUPLICATED, AND THAT IS THE WHOLE CONSTRAINT. Every view is
// the one instance the viewer already had, MOVED into a slot or into a hidden
// park. A parked canvas is skipped by the render loop (core/mol.js asks
// getClientRects before it draws) and by the viewport (a box measuring 0 is
// not a resize), so the structure costs nothing while it is not shown. The
// heatmap is the one view that can be on screen TWICE - PAE in one slot,
// contacts in another - and that is the only case that makes a second panel;
// see Heatmap.slotPanels for the pool and for why a panel belongs to a map.
//
// 🔴 THE SLOT OWNS THE SIZE, THE VIEW FILLS IT. The boxes carried their own:
// 600 on the website's canvas, a size token in the notebook's markup, 340 on
// the website's heatmap. `prepare` moves an inline size from the box to its
// slot and a stylesheet sizes the slot where CSS did it before, and every view
// in a body is 100% x 100%, !important, because four code paths write inline
// sizes and displays onto these boxes and every one of them predates slots.
//
// 🔴 AND THE CANVAS FOLLOWS ITS BOX NOW, IN EVERY SHELL. The notebook's canvas
// was sized once from the config and never followed anything, which was right
// for a box that never changed. The structure can now be put in any slot, so
// `prepare` marks it `data-autosize="css"` BEFORE setupViewport reads that -
// and the notebook's Colab rule (the page must be the right height before any
// script runs) still holds, because the size token stays inline in the markup
// and only moves one element outwards when the script does run.
(function () {
'use strict';

const MOL = 'molecular';
const SCATTER = 'scatter';
const MAP = 'map:';
const PANEL_IDS = ['#heatmapContainer', '#paeContainer'];
// The two names the first version of this file used, in slot order, still
// accepted wherever a slot is named and still written onto slots 1 and 2 as
// extra classes - a host stylesheet that says `.py2dmol-slot--big` predates
// the numbers and is not wrong, only old.
const LEGACY = ['big', 'small'];

const CSS = `
.py2dmol-slot { display: flex; flex-direction: column; position: relative;
box-sizing: border-box; flex: 0 0 auto; }
.py2dmol-slot[hidden] { display: none !important; }
.py2dmol-slot-tabs { display: flex; align-items: flex-end; gap: 3px;
height: 22px; padding: 0 8px; box-sizing: border-box; }
.py2dmol-slot-tabs[hidden] { display: none !important; }
.py2dmol-slot-tab { font: 11px/1 system-ui, sans-serif; padding: 4px 12px 5px;
margin: 0; border: 1px solid #c9c9c9; border-bottom: none;
border-radius: 6px 6px 0 0; background: #e9e9e9; color: #5c5c5c;
cursor: pointer; box-sizing: border-box; white-space: nowrap;
overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0;
height: auto; }
.py2dmol-slot-tab[aria-selected="true"] { background: #fff; color: #111;
border-color: #bcbcbc; font-weight: 600; padding-bottom: 6px; }
/* NO max-width HERE: the notebook's column is width: fit-content, and a
percentage of a box sized by its content resolved to the play strip's width
- a 500px slot came out 352. A shell that wants a fluid slot says so. */
.py2dmol-slot-body { position: relative; box-sizing: border-box; }
.py2dmol-slot-body > .py2dmol-slot-view { width: 100% !important;
height: 100% !important; max-width: none !important; min-width: 0 !important;
min-height: 0 !important; aspect-ratio: auto !important; resize: none !important;
margin: 0 !important; }
.py2dmol-slot-body > .py2dmol-slot-view:not(.py2dmol-slot-flex) {
display: block !important; }
.py2dmol-slot-body > .py2dmol-slot-flex { display: flex !important; }
.py2dmol-slot-park { display: none !important; }
/* 🔴 THE DRAG AND ITS KNOB BELONG TO THE SLOT, NOT TO THE VIEW.
#canvasContainer and #scatterContainer each carry resize: both and a
.resize-handle of their own - a blue corner triangle, pointer-events: none -
and in a slot the view is 100% x 100% !important, so BOTH were wrong: the box
could no longer be dragged at all (the notebook and the embed lost it outright)
while its knob still showed, in whichever slot it happened to sit. So the body
resizes and the body carries the knob.
🔴 AND EVERY SLOT HAS ONE, which the big/small version did not: the drag
went to whichever slot was called big, so a reader could not make the map
bigger and could not make the structure smaller. That was the name deciding a
capability - the fault the numbering exists to end - and the answer is that a
slot is a box you can size, whichever one it is.
A shell that wants no drag (the website below 980px) says resize: none on the
body and hides .py2dmol-slot-knob - see src/app/style.css. */
.py2dmol-slot > .py2dmol-slot-body { resize: both; overflow: hidden; }
.py2dmol-slot > .py2dmol-slot-body::-webkit-resizer { display: none; }
.py2dmol-slot-body .resize-handle { display: none !important; }
.py2dmol-slot-knob { position: absolute; bottom: 2px; right: 2px; width: 16px;
height: 16px; opacity: 0.4; transition: opacity 0.2s; z-index: 4;
pointer-events: none; }
.py2dmol-slot-body:hover > .py2dmol-slot-knob { opacity: 0.8; }
.py2dmol-slot-knob::before { content: ''; position: absolute; bottom: 0;
right: 0; width: 0; height: 0; border-style: solid;
border-width: 0 0 16px 16px; border-color: transparent transparent #3b82f6; }
`;

function installCSS() {
    if (typeof document === 'undefined' || document.getElementById('py2dmol-slots-css')) return;
    const el = document.createElement('style');
    el.id = 'py2dmol-slots-css';
    el.textContent = CSS;
    (document.head || document.documentElement).appendChild(el);
}

const findPanel = (root) => {
    for (const id of PANEL_IDS) {
        const el = root && root.querySelector(id);
        if (el) return el;
    }
    return null;
};

/**
 * Wrap a box in slot number `n` (1-based), in place. The box's own inline size
 * goes to the slot's body; a box sized by a stylesheet leaves the body to one
 * (see style.css).
 */
function makeSlot(box, n) {
    const slot = document.createElement('div');
    slot.className = 'py2dmol-slot py2dmol-slot--' + n
        + (LEGACY[n - 1] ? ' py2dmol-slot--' + LEGACY[n - 1] : '');
    slot.dataset.py2dmolSlot = String(n);
    const tabs = document.createElement('div');
    tabs.className = 'py2dmol-slot-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.hidden = true;
    const body = document.createElement('div');
    body.className = 'py2dmol-slot-body';
    box.parentNode.insertBefore(slot, box);
    slot.appendChild(tabs);
    slot.appendChild(body);
    body.appendChild(box);
    // ...and the knob that says the body can be dragged. One per slot, built
    // here so every shell has the same cue: the shells drew their own inside
    // the canvas box, which is the wrong element to hang it on now.
    const knob = document.createElement('div');
    knob.className = 'py2dmol-slot-knob';
    body.appendChild(knob);
    for (const k of ['width', 'height']) {
        if (box.style[k]) { body.style[k] = box.style[k]; }
    }
    return { slot, tabs, body, index: n, view: null, sig: '' };
}

/**
 * THE DOM HALF, before the canvas is measured. Returns null when there is
 * nothing to put in a second slot - a bare canvas, or a shell with neither a
 * heatmap box nor a scatter box - and the page is then exactly what it was.
 */
function prepare(root, config) {
    if (typeof document === 'undefined' || !root) return null;
    const cc = root.querySelector('#canvasContainer');
    if (!cc) return null;
    // Already done - a second wire of the same shell.
    if (cc.parentNode && cc.parentNode.classList
        && cc.parentNode.classList.contains('py2dmol-slot-body')) return null;
    // The heatmap box is looked up the way the panel looks it up: in the
    // viewer first, then the page, because an embed's host page puts it
    // BESIDE the viewer (show() replaces the container's children).
    let panel = findPanel(root) || findPanel(document);
    if (panel && panel.closest('.py2dmol-slot-body, .py2dmol-slot-park')) panel = null;
    const scatter = root.querySelector('#scatterContainer');
    const anchor = panel || scatter;
    if (!anchor) return null;
    installCSS();

    const cssOwned = cc.dataset.autosize === 'css';
    const slots = [makeSlot(cc, 1)];
    // 🔴 EVERY SLOT IS THE SAME SIZE UNLESS SOMETHING SAYS OTHERWISE, and
    // that is the size the caller asked the VIEWER for. It used to be the
    // display size for the structure and `heatmap.size` for the panel - two
    // different numbers for two boxes side by side, because one of them was
    // called small. `heatmap.size` still decides what a MAP is: the panel
    // outside a slot, and how far a matrix is resampled on the way over
    // (viewer.py's _map_cap). Neither of those is a box in a row of boxes.
    // "Something" is the shell's stylesheet (`cssOwned`) or an inline size on
    // the box itself, which makeSlot has already moved onto the body - so
    // this only fills in what nobody stated.
    // 🔴 AND THE MAP IS STILL CAPPED AT `heatmap.size`, 300 by default: in a
    // box larger than that a resampled matrix is drawn up to the box, which
    // is a hair softer than it was when the box was 300 too. The dial is
    // `heatmap_size`; the cap is not raised with the box because the matrix
    // is the biggest thing a notebook payload carries and doubling it is not
    // something a size= should do quietly.
    const size = (config && config.display && config.display.size) || [300, 300];
    const sizeSlot = (s) => {
        if (cssOwned || s.body.style.width) return;
        s.body.style.width = size[0] + 'px';
        s.body.style.height = size[1] + 'px';
    };
    sizeSlot(slots[0]);
    cc.dataset.autosize = 'css';
    cc.classList.add('py2dmol-slot-view');

    slots.push(makeSlot(anchor, 2));
    sizeSlot(slots[1]);
    const park = document.createElement('div');
    park.className = 'py2dmol-slot-park';
    const last = slots[slots.length - 1];
    last.slot.parentNode.insertBefore(park, last.slot.nextSibling);
    // Everything starts parked but the structure; bind() places the rest.
    for (const el of [panel, scatter]) {
        if (!el) continue;
        el.classList.add('py2dmol-slot-view');
        park.appendChild(el);
    }
    if (scatter) scatter.classList.add('py2dmol-slot-flex');
    for (let i = 1; i < slots.length; i++) slots[i].slot.hidden = true;
    // `big`/`small` name slots 1 and 2 here too, for the same reason the
    // classes do: three probes and one host reach for them.
    return { slots, big: slots[0], small: slots[1], park, cc, scatter, root };
}

/**
 * THE RENDERER HALF. `refresh()` is asked from the render loop on every frame
 * and returns at the first line unless something it depends on moved - the
 * signature is a handful of property reads - so there is one place that
 * notices a map arriving, a structure landing, scatter data appearing, however
 * each of them arrived: a frame, a live update, a host calling setMaps.
 */
// 🔴 ONE SLOT ON A PHONE, AND IT IS A PARK RATHER THAN A `display: none`.
// Two slots side by side are 940px of a 390px screen, and stacked they put
// the structure above the fold and the map below it - where dropping every
// slot after the first costs nothing now, because the tabs over it can reach
// every view. Done HERE and not in a stylesheet because a hidden view is still
// a DRAWING view: a `display: none` slot would keep a second heatmap panel,
// its decoded matrix and its colour image, and would go on painting a scatter
// plot nobody can see. Parked, every rule this file already has applies.
//
// 980px is the website's own breakpoint (src/app/style.css), which is where its
// columns stack; the notebook and the embed have no media query of their own
// and inherit the same answer. THE VIEWPORT, not the container: a narrow cell
// on a desktop is a layout choice, a phone is a screen, and only the second one
// means "there is no room for a second picture".
const NARROW = '(max-width: 980px)';

/**
 * WHAT A CALLER MAY HAND setSlots, AND IT IS ONE LIST. `['structure',
 * 'contact']` names the slots in order; a SHORTER list names the slots it
 * reaches and leaves the rest choosing for themselves, which is what makes
 * `setSlots(['pae'])` mean "put the PAE first" rather than "throw the other
 * box away". How MANY boxes there are is `count`, a separate question with a
 * separate answer, because those two were one field once (`small: false`) and
 * a caller naming the first slot kept accidentally answering the second.
 *
 * Still accepted, and tested: `{big, small}` - the first version's spelling,
 * held by LocalFold, by every notebook saved before the numbers and by the
 * `slots` key of every saved session. `small: false`/`'none'` is `count: 1`.
 */
function normalizeAsk(x) {
    if (x === null || x === undefined) return { views: [], reset: true };
    if (typeof x === 'string') return { views: [x] };
    if (Array.isArray(x)) return { views: x.slice() };
    if (typeof x !== 'object') return { views: [] };
    if (Array.isArray(x.views) || 'count' in x) {
        return { views: (x.views || []).slice(),
                 count: 'count' in x ? x.count : undefined };
    }
    const out = { views: [], count: undefined };
    let any = false;
    for (let i = 0; i < LEGACY.length; i++) {
        const k = LEGACY[i];
        if (!(k in x)) { out.views.push(undefined); continue; }
        any = true;
        const v = x[k];
        if (v === false || v === 'none') {
            // "no slot here" is a count, and it truncates.
            out.count = i;
            out.views.push(undefined);
        } else out.views.push(v);
    }
    while (out.views.length && out.views[out.views.length - 1] === undefined) out.views.pop();
    if (!any && out.count === undefined) return { views: [], reset: true };
    return out;
}

function bind(renderer, layout) {
    if (!layout) return null;
    const N = layout.slots.length;
    const want = new Array(N).fill(null);
    let wantCount = null;               // null = as many as the shell has
    const shown = new Array(N).fill(null);
    let lastSig = '';
    // 🔴 A STRUCTURE THAT BLINKS IS NOT A STRUCTURE THAT LEFT. The empty case
    // above - "with nothing to draw, the first slot takes the first thing
    // there is" - is a FIRST-TIME default, and it was being re-decided on
    // every frame. Every ingestion path empties an object before the new
    // frames land (`existing.frames.length = 0`, then addFrame), so for the
    // one or two frames in between there are no coordinates, and a
    // renderer-level map - LocalFold keeps a live contact map through a whole
    // fold - was the first thing there was. Slot 1 swapped to it and back.
    //
    // Reported as: when the last frame is added, after diffusion and the
    // confidence come back, the contact map briefly replaces the structure.
    // Measured on that sequence, sampling the slot every animation frame:
    // structure -> contact -> structure.
    //
    // So the default applies while no structure has EVER been there, which is
    // the case it was written for - a fold whose trunk has produced a map and
    // no coordinates yet. After that slot 1 is the structure's and an empty
    // canvas for two frames is the honest picture: it is what the reader was
    // already looking at, with nothing in it for a moment.
    // A host that WANTS the map first says so (`setSlots`), and that is
    // `want[0]`, which is tested first and is how LocalFold opens a fold.
    //
    // 🔴 AND THE HOLD IS PER OBJECT, OR IT SWALLOWS THE CASE IT IS FOR. A
    // reader who SWITCHES to an object with no coordinates - a trunk that has
    // produced a map and nothing else - must still get the map first; that is
    // a standing state, not a blink. What separates the two is which object is
    // being drawn: a blink is the SAME object mid-update, a switch is a
    // different one. So this remembers the object the coordinates belonged to
    // and holds the slot only for that one. tests/slots.py already asserts the
    // switch case and fails a hold that does not make the distinction.
    let molObject = null;

    // 🔴 A FRAME IS NOT A STRUCTURE, AND THIS COUNTED FRAMES. The empty case
    // above is "a fold whose trunk has a contact map and no structure yet",
    // and the only way a Python caller can SAY that is to add a frame whose
    // coords are empty - a map has to ride on a frame, there is no other
    // door. That frame made frames.length 1, so the object counted as a
    // structure, the first-slot default never fired for the case it was
    // written for, and an empty Structure tab sat beside the map for the whole
    // trunk. Reported from ColabFold2's live cell, which is exactly that fold.
    //
    // CONSERVATIVE ON PURPOSE: only an explicitly EMPTY array is "no
    // structure". A frame with no `coords` field at all is unknown, and
    // unknown stays a structure, so no existing ingestion path can be
    // switched off by a shape this does not recognise.
    const framesDrawSomething = (o) => {
        if (!o || !o.frames || !o.frames.length) return false;
        const f = o.frames[o.frames.length - 1];
        return !f || !Array.isArray(f.coords) || f.coords.length > 0;
    };
    const hasCoords = () => {
        const obj = renderer.currentObjectName && renderer.objectsData
            ? renderer.objectsData[renderer.currentObjectName] : null;
        if (framesDrawSomething(obj)) return true;
        const set = renderer.shownObjects;
        if (set instanceof Set) {
            for (const name of set) {
                if (framesDrawSomething(renderer.objectsData[name])) return true;
            }
        }
        return false;
    };
    // 🔴 objectHasScatter WALKS THE FRAMES, and this is asked every frame the
    // loop runs - a 10,000-frame trajectory would pay 10,000 iterations to
    // learn nothing had changed. Remembered against what can change the
    // answer: which object, how many frames, how many points were loaded.
    let scatterMemo = { key: null, val: false };
    const hasScatter = () => {
        if (typeof renderer.objectHasScatter !== 'function') return false;
        const obj = renderer.objectsData && renderer.objectsData[renderer.currentObjectName];
        const sr = renderer.scatterRenderer;
        const key = renderer.currentObjectName + '|' + (obj && obj.frames ? obj.frames.length : -1)
            + '|' + (sr && sr.xData ? sr.xData.length : -1);
        if (key !== scatterMemo.key) scatterMemo = { key, val: !!renderer.objectHasScatter() };
        return scatterMemo.val;
    };
    const available = () => {
        const out = [];
        if (hasCoords()) out.push(MOL);
        if (window.Heatmap && renderer.heatmapRenderer) {
            for (const k of window.Heatmap.loadedKeys(renderer)) out.push(MAP + k);
        }
        if (layout.scatter && renderer.scatterRenderer && hasScatter()) out.push(SCATTER);
        return out;
    };
    const labelOf = (v) => {
        if (v === MOL) return 'Structure';
        if (v === SCATTER) return 'Scatter';
        const key = v.slice(MAP.length);
        return window.Heatmap && window.Heatmap.labelFor ? window.Heatmap.labelFor(key) : key;
    };
    // What a slot after the first takes when nobody said: a map before the
    // scatter plot before the structure, which is the order in which a second
    // box earns its place beside a structure.
    const nextDefault = (cands) => cands.find((v) => v.startsWith(MAP))
        || cands.find((v) => v === SCATTER) || cands.find((v) => v === MOL) || null;

    // A slot is named by its NUMBER (1-based), and `big`/`small` still answer
    // for 1 and 2 - tabs, hosts and three probes all call choose().
    const indexOfSlot = (name) => {
        if (typeof name === 'number') return name - 1;
        const at = LEGACY.indexOf(name);
        if (at >= 0) return at;
        const n = parseInt(name, 10);
        return isNaN(n) ? -1 : n - 1;
    };
    const choose = (slotName, v) => {
        const i = indexOfSlot(slotName);
        if (i < 0 || i >= N) return;
        // Whichever OTHER slot is showing it gives up what this one had: a
        // pick is a swap, which is what stops a view being in two places.
        for (let j = 0; j < N; j++) if (j !== i && shown[j] === v) want[j] = shown[i];
        want[i] = v;
        lastSig = '';
        refresh();
    };

    const drawTabs = (s, avail, v) => {
        const show = !!v && (avail.length >= 2 || v.startsWith(MAP));
        s.tabs.hidden = !show;
        if (!show) return;
        const sig = avail.join('\u0000');
        if (s.tabSig !== sig) {
            // REBUILT ONLY WHEN THE SET CHANGES, never per frame - a rebuild
            // destroys the button under the pointer and swallows the click,
            // which is the play button's bug and the map strip's before this.
            s.tabSig = sig;
            s.tabs.textContent = '';
            for (const a of avail) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'py2dmol-slot-tab';
                b.setAttribute('role', 'tab');
                b.dataset.view = a;
                b.textContent = labelOf(a);
                b.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    choose(s.index, a);
                });
                s.tabs.appendChild(b);
            }
        }
        for (const b of s.tabs.children) {
            const on = b.dataset.view === v ? 'true' : 'false';
            if (b.getAttribute('aria-selected') !== on) b.setAttribute('aria-selected', on);
        }
    };

    // 🔴 A SIZE WRITTEN ON A VIEW'S BOX IS A SIZE FOR ITS SLOT. Pages and
    // probes resize the viewer by writing #canvasContainer's inline width and
    // height - tests/resize_reuse.py, tests/gpu_mesh_reuse.py, any host that
    // predates slots - and inside a slot that box is 100% x 100% !important,
    // so the write did nothing and nothing said so. It is handed to the slot
    // the box is in, and taken off the box.
    const adoptSize = (el) => {
        const body = el && el.parentNode;
        if (!body || !body.classList || !body.classList.contains('py2dmol-slot-body')) return;
        for (const k of ['width', 'height']) {
            if (el.style[k]) { body.style[k] = el.style[k]; el.style[k] = ''; }
        }
    };
    if (typeof MutationObserver !== 'undefined') {
        const mo = new MutationObserver((records) => {
            for (const rec of records) adoptSize(rec.target);
        });
        // The canvas box only. The scatter box has its size written by its own
        // loader (src/app/scatter.js, 300px on every CSV), which would override
        // the slot it happens to be in; the heatmap's is taken once, from the
        // markup, by `prepare`.
        mo.observe(layout.cc, { attributes: true, attributeFilter: ['style'] });
    }
    const place = (el, body) => {
        if (el && el.parentNode !== body) body.appendChild(el);
    };

    // ...and the media query, which is a layout input like any other: a change
    // has to re-ask, and it is IN the signature so no answer is cached across it.
    const mq = (typeof window !== 'undefined' && window.matchMedia)
        ? window.matchMedia(NARROW) : null;
    if (mq) {
        const onNarrow = () => { lastSig = ''; refresh(); };
        if (mq.addEventListener) mq.addEventListener('change', onNarrow);
        else if (mq.addListener) mq.addListener(onNarrow);
    }

    function refresh() {
        const avail = available();
        // 🔴 AN OBJECT BETWEEN ITS FRAMES SAYS NOTHING, AND ASKING IT MADE THE
        // TABS BLINK. Loading a structure over an object that already has one
        // empties it and refills it, and the refill is not in the same task -
        // so a frame lands in the middle, where the renderer still has the old
        // COORDINATES and the object has no frames and the panel no maps. The
        // slot then saw exactly one view, hid the tab row, and put it back a
        // frame later with three tabs in it. Reported as the tabs disappearing
        // and reappearing at the end of a fold, with the layout jumping.
        //
        // The test is all three together, because each alone is a real state:
        // a fold's blank object has no frames AND no coordinates, and a trunk
        // showing its contact map has no frames AND a map. What cannot happen
        // on purpose is a DRAWN structure whose object has neither.
        const drawn = renderer.objectsData
            && renderer.objectsData[renderer.currentObjectName];
        // ...and the object can be GONE rather than empty: the loader
        // deletes it and adds it again under the same name, which is the
        // state a frame actually landed in - measured, `objectsData[current]`
        // was undefined there, so requiring the object made the hold a no-op.
        // 🔴 AND THE TEST IS THE DRAWN ARRAY, NOT `hasCoords()`. That helper
        // asks whether the object's FRAMES draw something, which is exactly
        // what has collapsed here - so using it made the hold unreachable,
        // measured twice. `renderer.coords` is the array on screen and it
        // still holds the structure the reader is looking at.
        const onScreen = !!(renderer.coords && renderer.coords.length);
        const between = onScreen && avail.length <= 1
            && !(drawn && drawn.frames && drawn.frames.length);
        if (between) return false;
        if (avail.indexOf(MOL) >= 0) molObject = renderer.currentObjectName;
        // ...and forgotten when that object is gone, so a page that clears up
        // and then loads a map on its own gets the first-time default back
        // rather than an empty canvas.
        else if (!renderer.objectsData
            || !(molObject in (renderer.objectsData || {}))) molObject = null;
        const molHold = molObject !== null
            && molObject === renderer.currentObjectName;
        const narrow = !!(mq && mq.matches);
        const sig = avail.join('\u0000') + '|' + want.join('\u0000')
            + '|' + wantCount + '|' + narrow
            + '|' + (molObject === renderer.currentObjectName ? 1 : 0);
        if (sig === lastSig) return false;
        lastSig = sig;

        // ...and on a narrow screen there is one slot whatever was asked for.
        // The reader's choice is KEPT rather than cleared: turn the phone
        // round and it is back.
        //
        // 🔴 AND A HOST MAY ASK FOR FEWER SLOTS ON ANY SCREEN. That is a
        // COUNT, not a view name, which the tabs make reasonable: every view
        // is reachable from the strip over the first box, so a second box is
        // a second copy of the same strip. A notebook cell asking for a 420px
        // viewer does not want 840 of them.
        const n = narrow ? 1 : Math.max(1, Math.min(N, wantCount === null ? N : wantCount));
        const taken = [];
        for (let i = 0; i < N; i++) {
            if (i >= n) { shown[i] = null; continue; }
            const rest = avail.filter((v) => taken.indexOf(v) < 0);
            let v;
            if (rest.indexOf(want[i]) >= 0) v = want[i];
            else if (i === 0) v = ((avail.indexOf(MOL) >= 0 || molHold) ? MOL : (rest[0] || MOL));
            else v = nextDefault(rest);
            shown[i] = v || null;
            if (v) taken.push(v);
        }

        // Which panel shows which map, before anything moves.
        const mapKeys = shown.filter((v) => v && v.startsWith(MAP))
            .map((v) => v.slice(MAP.length));
        const panels = window.Heatmap && renderer.heatmapRenderer
            ? window.Heatmap.slotPanels(renderer, mapKeys) : {};
        const elOf = (v) => {
            if (v === MOL) return layout.cc;
            if (v === SCATTER) return layout.scatter;
            return panels[v.slice(MAP.length)] || null;
        };
        const inUse = new Set();
        for (let i = 0; i < N; i++) {
            const s = layout.slots[i];
            const v = shown[i];
            s.view = v;
            const el = v ? elOf(v) : null;
            if (el) {
                el.classList.add('py2dmol-slot-view');
                place(el, s.body);
                inUse.add(el);
            }
            s.slot.hidden = !el;
            drawTabs(s, avail, v);
        }
        // WHATEVER NO SLOT SHOWS GOES TO THE PARK, and that is the only
        // parking there is. A per-slot sweep before each placement was written
        // first and measured as a no-op: a view taken by another slot MOVES
        // (appendChild), and one taken by none is caught here in the same
        // synchronous call, before anything paints. A second map panel is not
        // in this list because Heatmap.slotPanels removes it outright.
        for (const el of [layout.cc, layout.scatter, renderer.heatmapContainer]) {
            if (el && !inUse.has(el) && el.parentNode !== layout.park) layout.park.appendChild(el);
        }
        // A view that comes back out of the park was skipped while it was
        // there; ask for the draw now rather than on its next reason to.
        if (inUse.has(layout.cc) && typeof renderer.render === 'function') renderer._renderOwed = true;
        if (layout.scatter && inUse.has(layout.scatter) && renderer.scatterRenderer) {
            renderer.scatterRenderer.render(true);
        }
        return true;
    }

    /** Put `key` where this panel's map is showing - a host's setMap. */
    const showMap = (hm, key) => {
        const pool = renderer._heatmapPool || [];
        const entry = pool.find((e) => e.hm === hm);
        if (!entry || !entry.key || available().indexOf(MAP + key) < 0) return false;
        const at = shown.indexOf(MAP + entry.key);
        if (at < 0) return false;
        choose(at + 1, MAP + key);
        return true;
    };

    // THE NAMES A CALLER USES. `structure` (or `molecular`), `scatter`, and a
    // map by its key - `pae`, `contact`, whatever the frame calls it - which is
    // what Python's set_slots, the embed's config and renderer.setSlots all
    // take. null in a list hands that one slot back to the automatic choice.
    // `false`/`'none'` in a list is the old spelling of "stop here" and
    // truncates the count, because without this line it became the map key
    // 'map:false' and quietly showed nothing.
    const toView = (n) => (n === null || n === undefined) ? null
        : (n === false || n === 'none') ? false
        : (n === 'structure' || n === MOL) ? MOL
        : n === SCATTER ? SCATTER : MAP + n;
    const toName = (v) => !v ? null : v === MOL ? 'structure'
        : v === SCATTER ? SCATTER : v.slice(MAP.length);
    /**
     * ASK FOR A LAYOUT, which is a standing choice rather than a move: a view
     * that does not exist yet (a PAE before the fold has one) takes its slot
     * the moment it does, exactly as a tab the reader clicked would.
     *
     *   setSlots(['structure', 'contact'])   slot 1 and slot 2
     *   setSlots('pae')                      slot 1; the rest choose
     *   setSlots({views: ['pae'], count: 1}) one box, the PAE in it
     *   setSlots(null)                       automatic, every slot
     *   setSlots({big: 'pae', small: 'none'})  the first version's spelling
     */
    const setSlots = (opts) => {
        const ask = normalizeAsk(opts);
        if (ask.reset) {
            want.fill(null);
            wantCount = null;
        }
        for (let i = 0; i < ask.views.length && i < N; i++) {
            const v = ask.views[i];
            if (v === undefined) continue;          // not named: leave it
            const w = toView(v);
            if (w === false) { wantCount = i; continue; }   // "none" truncates
            want[i] = w;
        }
        if (ask.count !== undefined && ask.count !== null) {
            wantCount = Math.max(1, Math.min(N, ask.count | 0));
        }
        lastSig = '';
        refresh();
    };

    // WHAT IS ON SCREEN, AS A LIST - and `big`/`small` hang off it, because
    // that array IS the answer the old pair gave. A probe reads [0]; anything
    // written before the numbers reads .big and gets slot 1.
    // 🔴 THOSE TWO DO NOT SURVIVE JSON. A named property on an Array is
    // dropped by JSON.stringify, so a caller reading this over CDP or out of
    // a notebook's channel gets a plain list and must index it -
    // tests/mobile_layout.py did `shown['small']` and threw.
    const getSlots = () => {
        const out = shown.map(toName);
        out.big = out[0] === undefined ? null : out[0];
        out.small = out.length > 1 ? out[1] : null;
        out.count = shown.filter((v) => v).length;
        return out;
    };

    const api = {
        refresh,
        choose,
        showMap,
        setSlots,
        getSlots,
        shown: () => {
            const out = shown.slice();
            out.big = out[0];
            out.small = out.length > 1 ? out[1] : null;
            return out;
        },
        available,
        layout,
        count: () => N,
    };
    renderer._slots = api;
    // ...and the layout a config asked for: `slots: ['pae']` from the embed's
    // show(), or Python's set_slots before show().
    if (renderer.config && renderer.config.slots) setSlots(renderer.config.slots);
    return api;
}

window.py2dmolSlots = { prepare, bind, normalizeAsk, MOL, SCATTER, MAP };

})();
