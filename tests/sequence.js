/* The sequence strip's input layer, end to end:
 *
 *   node tests/sequence.js
 *
 * viewer-seq.js had no tests at all, which is how it came to hold two
 * independent copies of the selection logic - one for the mouse, one for
 * touch - that had drifted apart: a tap on a chain label toggled that chain's
 * VISIBILITY while a click toggled its SELECTION, and dragging across chain
 * labels worked with a mouse and did nothing with a finger.
 *
 * So the tests below run the SAME assertions through both pointer types
 * wherever a behaviour is meant to be shared. A behaviour that lands on one
 * path only fails here.
 *
 * The DOM stub is the minimum buildView() touches: an element tree, a canvas
 * with a no-op 2D context, and a window that records listeners so a synthetic
 * gesture can be driven through them.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---- DOM stub --------------------------------------------------------------
const RECT = { left: 0, top: 0, width: 900, height: 452 };

function mkCtx() {
    const noop = () => {};
    return new Proxy({}, {
        get: (t, k) => {
            if (k === 'measureText') return () => ({ width: 10 });
            if (k === 'createLinearGradient' || k === 'createRadialGradient') {
                return () => ({ addColorStop: noop });
            }
            if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
            return noop;
        },
        set: () => true,
    });
}

function mkEl(tag) {
    const el = {
        tagName: tag,
        style: {},
        children: [],
        listeners: new Map(),
        width: 0,
        height: 0,
        parentNode: null,
        innerHTML: '',
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const a = this.listeners.get(type) || [];
            const i = a.indexOf(fn);
            if (i >= 0) a.splice(i, 1);
        },
        fire(type, ev) {
            for (const fn of (this.listeners.get(type) || []).slice()) fn(ev);
        },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            return c;
        },
        replaceChild(nw, old) {
            const i = this.children.indexOf(old);
            if (i >= 0) this.children[i] = nw;
            nw.parentNode = this;
            return old;
        },
        // cloneNode COPIES THE SIZE. setupCanvasSequenceEvents clears the old
        // listeners by cloning the canvas, and a clone that came back with
        // width 0 made getCanvasPositionFromMouse scale every coordinate to
        // zero - which put every click on the scrollbar, so nothing was ever
        // selected and every assertion here passed vacuously.
        cloneNode() {
            const c = mkEl(this.tagName);
            c.width = this.width;
            c.height = this.height;
            c.style = { ...this.style };
            c.id = this.id;
            return c;
        },
        getBoundingClientRect() { return { ...RECT }; },
        getContext() { return mkCtx(); },
    };
    return el;
}

const sequenceViewEl = mkEl('div');
const winListeners = new Map();

global.window = {
    addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
        const a = winListeners.get(type) || [];
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
    },
    dispatchEvent: () => {},
};
const fireWindow = (type, ev) => {
    for (const fn of (winListeners.get(type) || []).slice()) fn(ev);
};
global.document = {
    getElementById: (id) => (id === 'sequenceView' ? sequenceViewEl : null),
    createElement: (tag) => mkEl(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
};
global.CustomEvent = function CustomEvent(name) { this.name = name; };
global.requestAnimationFrame = (fn) => { fn(); return 1; };

eval(fs.readFileSync(path.join(ROOT, 'py2Dmol/resources/viewer-seq.js'), 'utf8'));
const SEQ = global.window.SEQ;
if (!SEQ || !SEQ.buildView) throw new Error('viewer-seq did not install window.SEQ');

// ---- a structure: three chains, 6 residues each -----------------------------
const CHAINS = ['A', 'B', 'C'];
const PER = 6;
// A structure tall enough that the strip has to scroll: 452 px of canvas at
// 14 px a line, so 30 chains is comfortably past the end.
const MANY = Array.from({ length: 30 }, (_, i) => 'C' + i);
let chainSet = CHAINS;
function mkRenderer() {
    const CHAINS = chainSet;
    const chains = [];
    const names = [];
    const nums = [];
    const types = [];
    for (const c of CHAINS) {
        for (let i = 0; i < PER; i++) {
            chains.push(c); names.push('ALA'); nums.push(i + 1); types.push('P');
        }
    }
    const n = chains.length;
    const frame = {
        coords: new Array(n * 3).fill(0),
        chains, position_names: names, residue_numbers: nums, position_types: types,
    };
    return {
        currentObjectName: 'obj',
        currentFrame: 0,
        objectsData: { obj: { frames: [frame], ligandGroups: new Map() } },
        coords: new Array(n),
        residueSelection: null,
        visiblePositions: null,
        visibilityModel: null,
        canvas: null,
        getVisibility: () => ({ positions: new Set(), chains: new Set(), visibilityMode: 'default' }),
        getChainColorForChainId: () => ({ r: 100, g: 100, b: 100 }),
        getAtomColor: () => ({ r: 100, g: 100, b: 100 }),
        _getEffectiveColorMode: () => 'chain',
        updateSelectionPreview() {},
        endSelectionPreview() {},
        render() {},
    };
}

let renderer = mkRenderer();
SEQ.setCallbacks({
    getRenderer: () => renderer,
    getObjectSelect: () => ({ value: 'obj' }),
    highlightAtom() {}, highlightAtoms() {}, clearHighlight() {},
    // These two are what the OLD touch path called to hide a chain. They are
    // no longer in the strip's callback contract at all, and are kept here as
    // tripwires: if a visibility call ever comes back, the assertion below
    // sees it rather than the change passing unnoticed.
    setChainResiduesSelected(chain, sel) { visibilityCalls.push([chain, sel]); },
    toggleChainResidues(chain) { visibilityCalls.push([chain, 'toggle']); },
});
let visibilityCalls = [];

// The canvas buildView leaves in the container, after the clone-to-clear-
// listeners step inside setupCanvasSequenceEvents.
const liveCanvas = () => sequenceViewEl.children[sequenceViewEl.children.length - 1];

function build(mode, chains) {
    chainSet = chains || CHAINS;
    SEQ.setMode(mode);
    sequenceViewEl.children.length = 0;
    renderer = mkRenderer();
    visibilityCalls = [];
    SEQ.clear();
    SEQ.buildView();
    const cv = liveCanvas();
    if (!cv) throw new Error('buildView produced no canvas');
    return cv;
}

// Where things are. The layout is not exported, so positions are recovered by
// probing: the same hit test the handlers use decides what is under a point,
// so a fixture that guesses wrong would silently test empty space. These walk
// the canvas until they find the thing they are named for, and throw if it is
// not there.
function findPoint(cv, pred) {
    const w = RECT.width;
    const h = RECT.height;
    for (let y = 1; y < h; y += 2) {
        for (let x = 1; x < w; x += 2) {
            const hit = probe(cv, x, y);
            if (hit && pred(hit)) return { x, y, hit };
        }
    }
    return null;
}
// Probing uses the click path itself: press, read what got selected, undo.
function probe(cv, x, y) {
    const before = renderer.residueSelection;
    renderer.residueSelection = null;
    click(cv, x, y);
    const got = renderer.residueSelection ? new Set(renderer.residueSelection) : null;
    renderer.residueSelection = before;
    if (!got || !got.size) return null;
    return got;
}

const ev = (x, y, extra) => ({
    button: 0, buttons: 1, clientX: x, clientY: y, shiftKey: false,
    preventDefault() {}, ...(extra || {}),
});

function press(cv, x, y, opts) { cv.fire('mousedown', ev(x, y, opts)); }
function moveTo(x, y) { fireWindow('mousemove', ev(x, y)); }
function release(x, y) { fireWindow('mouseup', ev(x, y)); }
function click(cv, x, y, opts) { press(cv, x, y, opts); release(x, y); }
function dblclick(cv, x, y, opts) { cv.fire('dblclick', ev(x, y, opts)); }

const touch = (x, y) => ({
    touches: [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
    preventDefault() {},
});
function tapStart(cv, x, y) { cv.fire('touchstart', touch(x, y)); }
function tapMove(x, y) { fireWindow('touchmove', touch(x, y)); }
function tapEnd(x, y) { fireWindow('touchend', touch(x, y)); }
function tap(cv, x, y) { tapStart(cv, x, y); tapEnd(x, y); }

const sel = () => (renderer.residueSelection ? [...renderer.residueSelection].sort((a, b) => a - b) : []);
const chainPositions = (c) => {
    const out = [];
    const chains = renderer.objectsData.obj.frames[0].chains;
    for (let i = 0; i < chains.length; i++) if (chains[i] === c) out.push(i);
    return out;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// any residue-sized hit in whatever fixture is currently built
function resPtBig() {
    const cv = liveCanvas();
    const p = findPoint(cv, (got) => got.size === 1);
    if (!p) throw new Error('tall fixture: found no single-residue hit');
    return p;
}

let failures = 0;
function test(name, fn) {
    try { fn(); console.log('PASS', name); }
    catch (e) { failures++; console.log('FAIL', name, '-', e.message); }
}

// ---- the fixtures locate themselves ----------------------------------------
// chain mode: every hit is a chain block
const chainModeCanvas = build(false);
const chainPt = {};
for (const c of CHAINS) {
    const want = chainPositions(c);
    const p = findPoint(chainModeCanvas, (got) => same([...got].sort((a, b) => a - b), want));
    if (!p) throw new Error('chain mode: never found the block for chain ' + c);
    chainPt[c] = p;
}

// sequence mode: chain labels and individual residues
const seqCanvas = build(true);
const seqChainPt = {};
for (const c of CHAINS) {
    const want = chainPositions(c);
    const p = findPoint(seqCanvas, (got) => same([...got].sort((a, b) => a - b), want));
    if (!p) throw new Error('sequence mode: never found the label for chain ' + c);
    seqChainPt[c] = p;
}
const resPt = {};
for (const want of [0, 2, 5, 6, 13]) {
    const p = findPoint(seqCanvas, (got) => got.size === 1 && got.has(want));
    if (!p) throw new Error('sequence mode: never found residue ' + want);
    resPt[want] = p;
}

// ---- shared behaviour, asserted through BOTH pointer types ------------------

test('a chain block selects its whole chain, by click and by tap', () => {
    for (const [label, go] of [['click', click], ['tap', tap]]) {
        const cv = build(false);
        go(cv, chainPt.B.x, chainPt.B.y);
        if (!same(sel(), chainPositions('B'))) {
            throw new Error(`${label} on chain B selected ${JSON.stringify(sel())}`);
        }
        // ...and the same gesture again clears it
        go(cv, chainPt.B.x, chainPt.B.y);
        if (sel().length) throw new Error(`${label} did not toggle chain B off`);
    }
});

test('a chain block selects rather than hiding, by click and by tap', () => {
    // The touch path used to call setChainResiduesSelected, which is
    // VISIBILITY. Selecting must not touch what is on screen.
    for (const [label, go] of [['click', click], ['tap', tap]]) {
        const cv = build(false);
        go(cv, chainPt.A.x, chainPt.A.y);
        if (visibilityCalls.length) {
            throw new Error(`${label} changed visibility (${JSON.stringify(visibilityCalls)})`
                + ' - selecting a chain must not hide anything');
        }
    }
});

test('dragging across chain blocks picks the span, by mouse and by finger', () => {
    const want = [...chainPositions('A'), ...chainPositions('B'), ...chainPositions('C')];
    {
        const cv = build(false);
        press(cv, chainPt.A.x, chainPt.A.y);
        moveTo(chainPt.B.x, chainPt.B.y);
        moveTo(chainPt.C.x, chainPt.C.y);
        release(chainPt.C.x, chainPt.C.y);
        if (!same(sel(), want)) throw new Error('mouse drag gave ' + JSON.stringify(sel()));
    }
    {
        const cv = build(false);
        tapStart(cv, chainPt.A.x, chainPt.A.y);
        tapMove(chainPt.B.x, chainPt.B.y);
        tapMove(chainPt.C.x, chainPt.C.y);
        tapEnd(chainPt.C.x, chainPt.C.y);
        if (!same(sel(), want)) throw new Error('touch drag gave ' + JSON.stringify(sel()));
    }
});

test('a chain label is not re-taken by a double click - the toggles stand', () => {
    // A single click on a chain label already takes the whole chain, so if the
    // double gesture took it again, clicking twice in a hurry to clear it
    // would leave it selected instead.
    // A browser fires click, click, THEN dblclick - modelling only the last
    // of the three would test an event order that never happens.
    for (const [label, go] of [
        ['mouse', (cv, p) => { click(cv, p.x, p.y); click(cv, p.x, p.y); dblclick(cv, p.x, p.y); }],
        ['touch', (cv, p) => { tap(cv, p.x, p.y); tapStart(cv, p.x, p.y); tapEnd(p.x, p.y); }],
    ]) {
        const cv = build(false);
        go(cv, chainPt.B);
        if (sel().length) {
            throw new Error(`${label}: a quick second hit on chain B left `
                + JSON.stringify(sel()) + ' selected instead of clearing it');
        }
    }
});

test('a double click and a double tap both take the whole chain', () => {
    {
        const cv = build(true);
        dblclick(cv, resPt[2].x, resPt[2].y);
        if (!same(sel(), chainPositions('A'))) {
            throw new Error('double click gave ' + JSON.stringify(sel()));
        }
    }
    {
        const cv = build(true);
        // two taps in the same place, inside the double-tap window
        tap(cv, resPt[2].x, resPt[2].y);
        tapStart(cv, resPt[2].x, resPt[2].y);
        tapEnd(resPt[2].x, resPt[2].y);
        if (!same(sel(), chainPositions('A'))) {
            throw new Error('double tap gave ' + JSON.stringify(sel()));
        }
    }
});

test('two taps far apart are two separate taps, not a double', () => {
    const cv = build(true);
    tap(cv, resPt[0].x, resPt[0].y);
    tap(cv, resPt[5].x, resPt[5].y);
    if (!same(sel(), [0, 5])) {
        throw new Error('expected both residues toggled on, got ' + JSON.stringify(sel()));
    }
});

// ---- shift ------------------------------------------------------------------

test('shift-click extends over chains in chain mode', () => {
    const cv = build(false);
    click(cv, chainPt.A.x, chainPt.A.y);
    click(cv, chainPt.C.x, chainPt.C.y, { shiftKey: true });
    const want = [...chainPositions('A'), ...chainPositions('B'), ...chainPositions('C')];
    if (!same(sel(), want)) {
        throw new Error('shift-click over A..C gave ' + JSON.stringify(sel())
            + ' - chain B in the middle of the span was not picked up');
    }
});

test('shift-click extends over residues in sequence mode', () => {
    const cv = build(true);
    click(cv, resPt[2].x, resPt[2].y);
    click(cv, resPt[6].x, resPt[6].y, { shiftKey: true });
    if (!same(sel(), [2, 3, 4, 5, 6])) {
        throw new Error('shift-click 2..6 gave ' + JSON.stringify(sel()));
    }
});

test('shift-click extends over chain labels in sequence mode too', () => {
    const cv = build(true);
    click(cv, seqChainPt.A.x, seqChainPt.A.y);
    click(cv, seqChainPt.C.x, seqChainPt.C.y, { shiftKey: true });
    const want = [...chainPositions('A'), ...chainPositions('B'), ...chainPositions('C')];
    if (!same(sel(), want)) throw new Error('gave ' + JSON.stringify(sel()));
});

test('the shift anchor stays put, and re-stretching shorter shrinks the span', () => {
    // This is the only assertion that can see the anchor at all. If shift
    // merely ADDED its span, the second extension would be a subset of the
    // first and an anchor that had wandered to 6 would give an identical
    // result - so the span has to replace, from the selection as it stood
    // when the anchor was set.
    const cv = build(true);
    click(cv, resPt[2].x, resPt[2].y);
    click(cv, resPt[6].x, resPt[6].y, { shiftKey: true });
    if (!same(sel(), [2, 3, 4, 5, 6])) throw new Error('first span gave ' + JSON.stringify(sel()));
    click(cv, resPt[5].x, resPt[5].y, { shiftKey: true });
    if (!same(sel(), [2, 3, 4, 5])) {
        throw new Error('re-stretching 2..6 down to 2..5 gave ' + JSON.stringify(sel())
            + ' - either the anchor moved off 2, or the longer span was left behind');
    }
});

test('shift with nothing to anchor to behaves as a plain click', () => {
    const cv = build(true);
    click(cv, resPt[2].x, resPt[2].y, { shiftKey: true });
    if (!same(sel(), [2])) throw new Error('gave ' + JSON.stringify(sel()));
});

test('shift keeps what was selected before the anchor, and never unselects', () => {
    const cv = build(true);
    click(cv, resPt[13].x, resPt[13].y);   // in chain C, away from the span
    click(cv, resPt[2].x, resPt[2].y);
    click(cv, resPt[5].x, resPt[5].y, { shiftKey: true });
    for (const i of [13, 2, 3, 4, 5]) {
        if (!sel().includes(i)) {
            throw new Error('position ' + i + ' missing from ' + JSON.stringify(sel()));
        }
    }
});

// ---- the structural guarantee ------------------------------------------------

test('the strip can be scrolled by dragging the scrollbar, with mouse or finger', () => {
    // A phone has no wheel event, and the wheel handler was the ONLY way to
    // reach a long sequence: the scrollbar branch existed on mousedown and had
    // no touch equivalent, so on mobile everything below the first screenful
    // was unreachable.
    for (const [label, drag] of [
        ['mouse', (cv, x, y0, y1) => { press(cv, x, y0); moveTo(x, y1); release(x, y1); }],
        ['touch', (cv, x, y0, y1) => { tapStart(cv, x, y0); tapMove(x, y1); tapEnd(x, y1); }],
    ]) {
        const cv = build(true, MANY);
        const bar = RECT.width - 4;          // inside the scrollbar gutter
        const spot = { x: 30, y: 40 };       // some point over the residue grid
        // Both ends are driven here rather than assuming where the strip
        // starts: scrollTop survives a rebuild, so a test that only dragged
        // downwards passed or failed depending on what ran before it.
        drag(cv, bar, 300, 1);
        const atTop = probe(cv, spot.x, spot.y);
        drag(cv, bar, 1, 300);
        const scrolled = probe(cv, spot.x, spot.y);
        if (!atTop) throw new Error(`${label}: the probe point hit nothing at the top`);
        if (scrolled && [...scrolled].join() === [...atTop].join()) {
            throw new Error(`${label}: dragging the scrollbar did not move the strip`
                + ' - the same residue is still under the same point');
        }
    }
});

test('a drag on the scrollbar does not select anything', () => {
    for (const [label, drag] of [
        ['mouse', (cv, x, y0, y1) => { press(cv, x, y0); moveTo(x, y1); release(x, y1); }],
        ['touch', (cv, x, y0, y1) => { tapStart(cv, x, y0); tapMove(x, y1); tapEnd(x, y1); }],
    ]) {
        const cv = build(true, MANY);
        click(cv, resPtBig().x, resPtBig().y);
        const held = sel().slice();
        drag(cv, RECT.width - 4, 2, 300);
        if (!same(sel(), held)) {
            throw new Error(`${label}: scrolling changed the selection from `
                + JSON.stringify(held) + ' to ' + JSON.stringify(sel()));
        }
    }
});

test('mouse and touch run one code path, not two copies', () => {
    // The drift this file exists to prevent is a behaviour implemented for one
    // pointer type and not the other. Both listeners must be thin: they may
    // translate their own events, but the selection logic they reach has to be
    // the shared one, so neither may name the selection helpers directly.
    const src = fs.readFileSync(path.join(ROOT, 'py2Dmol/resources/viewer-seq.js'), 'utf8');
    const at = (ev2) => {
        const i = src.indexOf(`newCanvas.addEventListener('${ev2}'`);
        if (i < 0) throw new Error('no ' + ev2 + ' listener');
        let d = 0; let k = src.indexOf('(', i + 26); const s0 = k;
        for (; k < src.length; k++) {
            if (src[k] === '(') d++;
            else if (src[k] === ')' && !--d) break;
        }
        return src.slice(s0, k);
    };
    for (const ev2 of ['mousedown', 'touchstart']) {
        const body = at(ev2);
        for (const banned of ['applyResidueSelection', 'computeSelectionFromRange',
            'toggleItemPositions', 'setChainResiduesSelected']) {
            if (body.includes(banned)) {
                throw new Error(`the ${ev2} listener calls ${banned} directly - the`
                    + ' selection logic is being reimplemented per pointer type,'
                    + ' which is exactly how the two paths drifted apart');
            }
        }
        if (!body.includes('beginGesture')) {
            throw new Error(`the ${ev2} listener does not go through beginGesture`);
        }
    }
});

test('no listener is registered under a name that can never fire', () => {
    // Two handlers sat here disabled by renaming their event, for long enough
    // that the live copy drifted from them.
    const src = fs.readFileSync(path.join(ROOT, 'py2Dmol/resources/viewer-seq.js'), 'utf8');
    const m = src.match(/addEventListener\('([a-zA-Z]+__[A-Z]+|[a-zA-Z]*_[a-zA-Z]*)'/g);
    if (m) throw new Error('dead listener names: ' + m.join(', '));
});

process.exit(failures ? 1 : 0);
