// ============================================================================
// src/parts/slots.js
// ------------------
// AI Context: TWO SLOTS, EVERY VIEW (window.py2dmolSlots)
// - A big slot where the structure was and a small one where the heatmap was.
// - Both carry the same tabs - Structure, each map, Scatter - and a view lives
//   in exactly one of them: picking one the other slot is showing swaps them.
// - A view with no data has no tab. A slot with no view is hidden.
// ============================================================================
// WHY THIS EXISTS. An object with no coordinates - a fold whose trunk has
// produced a contact map and no structure yet - left a 600px empty canvas
// beside a 340px map, which is the picture exactly backwards. Rather than a
// rule for that one case, the two boxes became places and the views became
// things that go in them, and the empty case is simply the default choice:
// with nothing to draw, the big slot takes the first thing there is.
//
// 🔴 NOTHING IS DUPLICATED, AND THAT IS THE WHOLE CONSTRAINT. Every view is
// the one instance the viewer already had, MOVED into a slot or into a hidden
// park. A parked canvas is skipped by the render loop (core/mol.js asks
// getClientRects before it draws) and by the viewport (a box measuring 0 is
// not a resize), so the structure costs nothing while it is not shown. The
// heatmap is the one view that can be on screen TWICE - PAE big, contacts
// small - and that is the only case that makes a second panel; see
// Heatmap.slotPanels for the pool and for why a panel belongs to a map.
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
// for a box that never changed. The structure can now be put in the small
// slot, so `prepare` marks it `data-autosize="css"` BEFORE setupViewport reads
// that - and the notebook's Colab rule (the page must be the right height
// before any script runs) still holds, because the size token stays inline in
// the markup and only moves one element outwards when the script does run.
(function () {
'use strict';

const MOL = 'molecular';
const SCATTER = 'scatter';
const MAP = 'map:';
const PANEL_IDS = ['#heatmapContainer', '#paeContainer'];

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
resizes and the body carries the knob: the big slot has one, the small slot has
neither, and a view's own handle is hidden wherever it lands.
A shell that wants no drag (the website below 980px) says resize: none on the
body and hides .py2dmol-slot-knob - see src/app/style.css. */
.py2dmol-slot--big > .py2dmol-slot-body { resize: both; overflow: hidden; }
.py2dmol-slot--big > .py2dmol-slot-body::-webkit-resizer { display: none; }
.py2dmol-slot-body .resize-handle { display: none !important; }
.py2dmol-slot-knob { position: absolute; bottom: 2px; right: 2px; width: 16px;
height: 16px; opacity: 0.4; transition: opacity 0.2s; z-index: 4;
pointer-events: none; }
.py2dmol-slot-body:hover > .py2dmol-slot-knob { opacity: 0.8; }
.py2dmol-slot-knob::before { content: ''; position: absolute; bottom: 0;
right: 0; width: 0; height: 0; border-style: solid;
border-width: 0 0 16px 16px; border-color: transparent transparent #3b82f6; }
.py2dmol-slot--small > .py2dmol-slot-body > .py2dmol-slot-knob { display: none; }
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
 * Wrap a box in a slot, in place. The box's own inline size goes to the slot's
 * body; a box sized by a stylesheet leaves the body to one (see style.css).
 */
function makeSlot(box, kind) {
    const slot = document.createElement('div');
    slot.className = 'py2dmol-slot py2dmol-slot--' + kind;
    slot.dataset.py2dmolSlot = kind;
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
    return { slot, tabs, body, kind, view: null, sig: '' };
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
    const big = makeSlot(cc, 'big');
    if (!cssOwned && !big.body.style.width) {
        // The embed's shell states no size; setupViewport would have written
        // the config's onto the box. It is the slot's now.
        const size = (config && config.display && config.display.size) || [300, 300];
        big.body.style.width = size[0] + 'px';
        big.body.style.height = size[1] + 'px';
    }
    cc.dataset.autosize = 'css';
    cc.classList.add('py2dmol-slot-view');

    const small = makeSlot(anchor, 'small');
    if (panel && !small.body.style.width) {
        // The notebook's panel is sized by its config, not its markup.
        const hs = config && config.heatmap && config.heatmap.size;
        if (hs && !cssOwned) {
            small.body.style.width = hs + 'px';
            small.body.style.height = hs + 'px';
        }
    }
    const park = document.createElement('div');
    park.className = 'py2dmol-slot-park';
    small.slot.parentNode.insertBefore(park, small.slot.nextSibling);
    // Everything starts parked but the structure; bind() places the rest.
    for (const el of [panel, scatter]) {
        if (!el) continue;
        el.classList.add('py2dmol-slot-view');
        park.appendChild(el);
    }
    if (scatter) scatter.classList.add('py2dmol-slot-flex');
    small.slot.hidden = true;
    return { big, small, park, cc, scatter, root };
}

/**
 * THE RENDERER HALF. `refresh()` is asked from the render loop on every frame
 * and returns at the first line unless something it depends on moved - the
 * signature is a handful of property reads - so there is one place that
 * notices a map arriving, a structure landing, scatter data appearing, however
 * each of them arrived: a frame, a live update, a host calling setMaps.
 */
// 🔴 ONE SLOT ON A PHONE, AND IT IS A PARK RATHER THAN A `display: none`.
// The two slots side by side are 940px of a 390px screen, and stacked they put
// the structure above the fold and the map below it - where hiding the second
// one costs nothing now, because the tabs over the first can reach every view.
// Done HERE and not in a stylesheet because a hidden view is still a DRAWING
// view: a `display: none` small slot would keep a second heatmap panel, its
// decoded matrix and its colour image, and would go on painting a scatter plot
// nobody can see. Parked, every rule this file already has applies.
//
// 980px is the website's own breakpoint (src/app/style.css), which is where its
// columns stack; the notebook and the embed have no media query of their own
// and inherit the same answer. THE VIEWPORT, not the container: a narrow cell
// on a desktop is a layout choice, a phone is a screen, and only the second one
// means "there is no room for a second picture".
const NARROW = '(max-width: 980px)';

function bind(renderer, layout) {
    if (!layout) return null;
    const want = { big: null, small: null };
    const shown = { big: null, small: null };
    let lastSig = '';
    // 🔴 A STRUCTURE THAT BLINKS IS NOT A STRUCTURE THAT LEFT. The empty case
    // above - "with nothing to draw, the big slot takes the first thing there
    // is" - is a FIRST-TIME default, and it was being re-decided on every
    // frame. Every ingestion path empties an object before the new frames
    // land (`existing.frames.length = 0`, then addFrame), so for the one or
    // two frames in between there are no coordinates, and a renderer-level
    // map - LocalFold keeps a live contact map through a whole fold - was the
    // first thing there was. The big slot swapped to it and back.
    //
    // Reported as: when the last frame is added, after diffusion and the
    // confidence come back, the contact map briefly replaces the structure.
    // Measured on that sequence, sampling the slot every animation frame:
    // structure -> contact -> structure.
    //
    // So the default applies while no structure has EVER been there, which is
    // the case it was written for - a fold whose trunk has produced a map and
    // no coordinates yet. After that the big slot is the structure's and an
    // empty canvas for two frames is the honest picture: it is what the
    // reader was already looking at, with nothing in it for a moment.
    // A host that WANTS the map big says so (`setSlots`), and that is
    // `want.big`, which is tested first and is how LocalFold opens a fold.
    //
    // 🔴 AND THE HOLD IS PER OBJECT, OR IT SWALLOWS THE CASE IT IS FOR. A
    // reader who SWITCHES to an object with no coordinates - a trunk that has
    // produced a map and nothing else - must still get the map big; that is a
    // standing state, not a blink. What separates the two is which object is
    // being drawn: a blink is the SAME object mid-update, a switch is a
    // different one. So this remembers the object the coordinates belonged to
    // and holds the slot only for that one. tests/slots.py already asserts the
    // switch case and fails a hold that does not make the distinction.
    let molObject = null;

    const hasCoords = () => {
        const obj = renderer.currentObjectName && renderer.objectsData
            ? renderer.objectsData[renderer.currentObjectName] : null;
        if (obj && obj.frames && obj.frames.length) return true;
        const set = renderer.shownObjects;
        if (set instanceof Set) {
            for (const name of set) {
                const o = renderer.objectsData[name];
                if (o && o.frames && o.frames.length) return true;
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
    const smallDefault = (cands) => cands.find((v) => v.startsWith(MAP))
        || cands.find((v) => v === SCATTER) || cands.find((v) => v === MOL) || null;

    const choose = (slotName, v) => {
        const other = slotName === 'big' ? 'small' : 'big';
        if (shown[other] === v) want[other] = shown[slotName];
        want[slotName] = v;
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
                    choose(s.kind, a);
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
        if (avail.indexOf(MOL) >= 0) molObject = renderer.currentObjectName;
        // ...and forgotten when that object is gone, so a page that clears up
        // and then loads a map on its own gets the first-time default back
        // rather than an empty canvas.
        else if (!renderer.objectsData
            || !(molObject in (renderer.objectsData || {}))) molObject = null;
        const molHold = molObject !== null
            && molObject === renderer.currentObjectName;
        const narrow = !!(mq && mq.matches);
        const sig = avail.join('\u0000') + '|' + want.big + '|' + want.small
            + '|' + narrow + '|' + (molObject === renderer.currentObjectName ? 1 : 0);
        if (sig === lastSig) return false;
        lastSig = sig;

        const big = avail.indexOf(want.big) >= 0 ? want.big
            : ((avail.indexOf(MOL) >= 0 || molHold) ? MOL : (avail[0] || MOL));
        const rest = avail.filter((v) => v !== big);
        // ...and on a narrow screen there is no second slot at all. The reader's
        // choice is KEPT rather than cleared: turn the phone round and it is back.
        const small = narrow ? null
            : (rest.indexOf(want.small) >= 0 ? want.small : smallDefault(rest));
        shown.big = big;
        shown.small = small;

        // Which panel shows which map, before anything moves.
        const mapKeys = [big, small].filter((v) => v && v.startsWith(MAP))
            .map((v) => v.slice(MAP.length));
        const panels = window.Heatmap && renderer.heatmapRenderer
            ? window.Heatmap.slotPanels(renderer, mapKeys) : {};
        const elOf = (v) => {
            if (v === MOL) return layout.cc;
            if (v === SCATTER) return layout.scatter;
            return panels[v.slice(MAP.length)] || null;
        };
        const inUse = new Set();
        for (const [s, v] of [[layout.big, big], [layout.small, small]]) {
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
        // WHATEVER NEITHER SLOT SHOWS GOES TO THE PARK, and that is the only
        // parking there is. A per-slot sweep before each placement was written
        // first and measured as a no-op: a view taken by the other slot MOVES
        // (appendChild), and one taken by neither is caught here in the same
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
        const at = shown.big === MAP + entry.key ? 'big'
            : (shown.small === MAP + entry.key ? 'small' : null);
        if (!at) return false;
        choose(at, MAP + key);
        return true;
    };

    // THE NAMES A CALLER USES. `structure` (or `molecular`), `scatter`, and a
    // map by its key - `pae`, `contact`, whatever the frame calls it - which is
    // what Python's set_slots, the embed's config and renderer.setSlots all
    // take. null hands a slot back to the automatic choice.
    const toView = (n) => (n === null || n === undefined) ? null
        : (n === 'structure' || n === MOL) ? MOL
        : n === SCATTER ? SCATTER : MAP + n;
    const toName = (v) => !v ? null : v === MOL ? 'structure'
        : v === SCATTER ? SCATTER : v.slice(MAP.length);
    /**
     * ASK FOR A LAYOUT, which is a standing choice rather than a move: a view
     * that does not exist yet (a PAE before the fold has one) takes its slot
     * the moment it does, exactly as a tab the reader clicked would.
     */
    const setSlots = (opts) => {
        const o = opts || {};
        if ('big' in o) want.big = toView(o.big);
        if ('small' in o) want.small = toView(o.small);
        lastSig = '';
        refresh();
    };

    const api = {
        refresh,
        choose,
        showMap,
        setSlots,
        getSlots: () => ({ big: toName(shown.big), small: toName(shown.small) }),
        shown: () => ({ big: shown.big, small: shown.small }),
        available,
        layout,
    };
    renderer._slots = api;
    // ...and the layout a config asked for: `slots: {big: 'pae'}` from the
    // embed's show() or Python's set_slots before show().
    if (renderer.config && renderer.config.slots) setSlots(renderer.config.slots);
    return api;
}

window.py2dmolSlots = { prepare, bind, MOL, SCATTER, MAP };

})();
