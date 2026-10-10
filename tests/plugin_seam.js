// THE PLUGIN SEAM on the 2D painter: registry, render(), paint2d - no browser.
// parts/plugins.js (the registry) into cartoon/geom.js's render() into
// cartoon/paint2d.js, with core/mol.js's own view arithmetic lifted from the source.
//
//     node tests/plugin_seam.js
//
// No browser: a recording canvas, like tests/paint_trace.js. The GPU half of the
// same claim (the mesh holds the plugin's lines, survives a rotation, is rebuilt
// when the key moves, and is not clipped) needs WebGL2 and is tests/plugin_browser.py.
//
// EVERY GUARD HERE FAILS A CHECK WHEN IT IS REMOVED: the registry `key()`, the apiVersion
// check, the maxPrims throw, the `joints` field, the alignTransform step.
//
//   R4     an empty registry, a registry with a plugin the viewer has no payload
//          for, and a plugin that emits nothing all draw BYTE-IDENTICALLY to no
//          registry at all
//   R1     the plugin's colour reaches the canvas, through the depth sort
//   R2     registration before the bundle, after it, and after a viewer is up
//   R6     a wrong apiVersion is refused WITH A MESSAGE
//   R7     over maxPrims throws, names the plugin and the cap, and draws NOTHING
//          of that plugin
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.dirname(__dirname);
const L = require('./lift.js');

const lifted = (name) => new Function('return function ' + L.method(name))();
global.halfSpanOf = new Function('return ' + L.topFunction('halfSpanOf'))();
global.Vec3 = new Function('return ' + L.klass('Vec3'))();
let _t = 0;
global.performance = { now: () => (_t += 1) };
const logged = { error: [], warn: [] };
global.console = { log: console.log, error: (m) => logged.error.push(String(m)),
    warn: (m) => logged.warn.push(String(m)) };
global.window = { addEventListener() {}, dispatchEvent() {}, devicePixelRatio: 1 };
global.document = { createElement: () => ({ getContext: () => null, width: 0, height: 0,
    style: {}, setAttribute() {} }) };
global.Event = function Event() {};

const load = (rel) => (0, eval)(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
// the geometry and its painter, the way a page loads them
for (const rel of ['src/cartoon/geom.js', 'src/cartoon/paint2d.js']) load(rel);
const cartoon = global.window.py2dmolCartoon;
const PLUGINS_JS = 'src/parts/plugins.js';

let bad = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) bad++; };
const throws = (fn) => { try { fn(); } catch (e) { return e; } return null; };

function recorder() {
    const ops = [];
    const t = {};
    const ctx = new Proxy(t, {
        get(o, k) {
            if (k === 'canvas') return { width: 600, height: 600 };
            if (k === 'measureText') return () => ({ width: 10 });
            if (k === 'createLinearGradient' || k === 'createRadialGradient') {
                return () => ({ addColorStop() {} });
            }
            if (k === 'getImageData') {
                return (x, y, w, h) => ({ data: new Uint8ClampedArray(4 * Math.max(1, w | 0) * Math.max(1, h | 0)) });
            }
            if (k === 'setLineDash') return () => {};
            // a real canvas context is not an SVG one: say so, or the registry takes it for an export
            if (k === 'getSerializedSvg' || k === 'comment') return undefined;
            if (k in o) return o[k];
            return (...a) => { ops.push(k + '(' + a.map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)).join(',') + ')'); };
        },
        set(o, k, v) { ops.push(k + '=' + v); o[k] = v; return true; },
    });
    return { ctx, ops };
}

function helix(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const th = i * 100 * Math.PI / 180;
        out.push({ x: 2.3 * Math.cos(th), y: 2.3 * Math.sin(th), z: 1.5 * i });
    }
    return out;
}
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
function mk(over) {
    const c = helix(24);
    const segs = [];
    for (let i = 0; i + 1 < c.length; i++) segs.push({ type: 'P', idx1: i, idx2: i + 1, origIndex: i });
    const r = {
        coords: c, rotatedCoords: c.map((p) => ({ ...p })), segmentIndices: segs,
        positionTypes: new Array(24).fill('P'), positionNames: new Array(24).fill('ALA'),
        residueNumbers: Array.from({ length: 24 }, (_, i) => i + 1), chains: new Array(24).fill('A'),
        viewerState: { extent: 30, zoom: 1, ortho: 1, focalLength: 100, rotation: I3,
            center: { x: 0, y: 0, z: 0 } },
        objectsData: { obj: { maxExtent: 30 } }, currentObjectName: 'obj', currentFrame: 0,
        viewerId: 'v1',
        lineWidth: 3.0, visibilityMask: null, visiblePositions: null, outlineMode: 'on',
        relativeOutlineWidth: 3, shadowEnabled: true, cartoonShade: 1, colorMode: 'chain',
        screenFrameId: 0, screenX: new Float64Array(24), screenY: new Float64Array(24),
        screenRadius: new Float64Array(24), screenValid: new Uint8Array(24),
        _calculateSegmentWidthMultiplier: () => 1,
        render() { this._renders = (this._renders || 0) + 1; },
    };
    // THE SHIPPED VIEW ARITHMETIC, not a paraphrase of it
    for (const m of ['_viewportScale', '_viewHalfSpan', '_viewInto', '_rotateAt', '_modelToView',
        '_rotationCtx', '_computeViewCentre']) r[m] = lifted(m);
    Object.assign(r, over || {});
    return { r, segs };
}
function trace(over, fn) {
    const { r, segs } = mk(over);
    if (fn) fn(r);
    const { ctx, ops } = recorder();
    _t = 0;
    cartoon.render(r, ctx, 600, 600, segs.map(() => ({ r: 100, g: 140, b: 220 })));
    return { ops, r };
}
const payloadsFor = (name, extra) => ({ [name]: Object.assign(
    { version: '1', apiVersion: 1, options: {}, payloads: [{ object: null, frame: null, payload: {} }] }, extra) });
function attach(name, extra) { global.window.py2dmol_plugins = { v1: payloadsFor(name, extra) }; }
function reset() {
    delete global.window.py2dmolPlugins;
    delete global.window.py2dmol_plugins;
    logged.error.length = 0; logged.warn.length = 0;
    load(PLUGINS_JS);
}

// ---- R4: nothing registered, nothing changes --------------------------------
delete global.window.py2dmolPlugins;
const base = trace().ops;
ok(base.length > 1000, 'the baseline draws something (' + base.length + ' ops)');
reset();
ok(trace().ops.join('\n') === base.join('\n'), 'R4: an EMPTY registry draws byte-identically to none');

let called = 0;
global.window.py2dmolPlugins.register({ name: 'p', version: '1', apiVersion: 1, prims() { called++; } });
ok(trace().ops.join('\n') === base.join('\n') && called === 0,
    'R4: a plugin the viewer has NO PAYLOAD for is never called and changes nothing');
attach('p');
ok(trace().ops.join('\n') === base.join('\n') && called === 1,
    'control: a plugin WITH a payload is called, and emitting nothing changes nothing');
ok(global.window.py2dmolPlugins.key(mk({ viewerId: 'v2' }).r) === '', 'key() is empty for a viewer with nothing attached');

// ---- the view arithmetic is the renderer's own ------------------------------
{
    const rot = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];
    const objRot = [[0.8, 0.6, 0], [-0.6, 0.8, 0], [0, 0, 1]];
    const { r } = mk({ objectsData: { obj: { maxExtent: 30, rotation_matrix: objRot, center: [1, 2, 3] } },
        viewerState: { extent: 30, zoom: 1, ortho: 1, focalLength: 100, rotation: rot,
            center: { x: 0.5, y: -1, z: 2 } } });
    const obj = r.objectsData.obj;
    const R = r._rotationCtx(obj, r._computeViewCentre(obj));
    let worst = 0;
    for (let i = 0; i < r.coords.length; i++) {
        r._rotateAt(i, R);
        const v = r._modelToView([r.coords[i].x, r.coords[i].y, r.coords[i].z], R, null);
        const d = Math.max(Math.abs(v[0] - r.rotatedCoords[i].x), Math.abs(v[1] - r.rotatedCoords[i].y),
            Math.abs(v[2] - r.rotatedCoords[i].z));
        if (d > worst) worst = d;
    }
    ok(worst === 0, '_modelToView(coords[i]) equals _rotateAt(i) BIT FOR BIT, with an object rotation'
        + ' and a view centre (worst ' + worst + ')');
    // ...and the alignment: the same as transforming the coordinates first, which
    // is what _resolvedFrame does on the way in
    const transformed = lifted('_transformedFrame');
    const xf = { t: [10, -4, 2], u: [0, -1, 0, 1, 0, 0, 0, 0, 1] };
    const fr = transformed.call(r, { coords: r.coords.map((c) => [c.x, c.y, c.z]) }, xf);
    let worstA = 0;
    for (let i = 0; i < r.coords.length; i++) {
        const want = r._modelToView(fr.coords[i], R, null);
        const got = r._modelToView([r.coords[i].x, r.coords[i].y, r.coords[i].z], R, xf);
        worstA = Math.max(worstA, Math.abs(want[0] - got[0]), Math.abs(want[1] - got[1]), Math.abs(want[2] - got[2]));
    }
    ok(worstA < 1e-12, '_modelToView applies the object\'s alignTransform exactly as _resolvedFrame does (worst ' + worstA + ')');
    const noXf = r._modelToView([1, 1, 1], R, null);
    const withXf = r._modelToView([1, 1, 1], R, xf);
    ok(Math.abs(noXf[0] - withXf[0]) > 1, 'control: the alignment MOVES a point (the test above can fail)');
}

// ---- R1: geometry reaches the canvas, depth-sorted ----------------------------
const has = (ops, s) => ops.filter((o) => o === 'strokeStyle=' + s).length;
reset();
global.window.py2dmolPlugins.register({ name: 'wire', version: '1', apiVersion: 1, prims(ctx) {
    ctx.line([-10, 0, 0], [10, 0, 0], { color: [220, 40, 40], width: 0.3 });
    ctx.line([0, -10, 0], [0, 10, 0], { color: '#0a64c8', width: 0.3 });
} });
attach('wire');
const withP = trace().ops;
ok(has(withP, 'rgb(220,40,40)') > 0 && has(withP, 'rgb(10,100,200)') > 0,
    'R1: both plugin lines reach the canvas (rgb array and #hex colours)');
ok(withP.join('\n') !== base.join('\n'), 'the stream with a plugin differs from the stream without');
{
    // the stroke LANDS WHERE ctx.line said: model (-10,0,0)..(10,0,0) with the
    // identity view is the horizontal through the centre of a 600x600 canvas
    // at scale s = 600*0.85/(2*30)
    const s = 600 * 0.85 / 60;
    const i = withP.indexOf('strokeStyle=rgb(220,40,40)');
    const seg = withP.slice(i, i + 12).filter((o) => /^(moveTo|lineTo)\(/.test(o));
    ok(seg[0] === 'moveTo(' + Math.round((300 - 10 * s) * 1000) / 1000 + ',300)'
        && seg[1] === 'lineTo(' + Math.round((300 + 10 * s) * 1000) / 1000 + ',300)',
    'the stroke is where the model point projects: ' + seg.join(' '));
}

// depth order: a NEAR line (z=+20) paints after a FAR one (z=-20), whichever order emitted
reset();
global.window.py2dmolPlugins.register({ name: 'depth', version: '1', apiVersion: 1, prims(ctx) {
    ctx.line([-10, 2, 20], [10, 2, 20], { color: [220, 40, 40] });     // NEAR
    ctx.line([-10, 0, -20], [10, 0, -20], { color: [10, 20, 200] });   // FAR
} });
attach('depth');
{
    const o = trace().ops;
    const iFar = o.indexOf('strokeStyle=rgb(10,20,200)');
    const iNear = o.indexOf('strokeStyle=rgb(220,40,40)');
    ok(iFar >= 0 && iNear > iFar, 'depth sort: the FAR line paints before the NEAR one (ops ' + iFar + ' < ' + iNear + ')');
}

// ---- prim schema --------------------------------------------------------------
reset();
const probe = { prims: [] };
global.window.py2dmolPlugins.register({ name: 'schema', version: '1', apiVersion: 1, prims(ctx) {
    ctx.line([0, 0, 0], [5, 0, 0], { color: [1, 2, 3], width: 0.2 });
    ctx.dot([1, 1, 1], { color: [4, 5, 6], radius: 0.7 });
    ctx.tri([0, 0, 0], [4, 0, 0], [0, 4, 0], { color: [7, 8, 9] });
} });
attach('schema');
{
    const { r, segs } = mk();
    r._primProbe = null;
    const { ctx } = recorder();
    cartoon.render(r, ctx, 600, 600, segs.map(() => ({ r: 100, g: 140, b: 220 })));
    const pl = (r._primProbe || []).filter((g) => g.plugin);
    const line = pl.find((g) => g.kind === 'line'); const dot = pl.find((g) => g.kind === 'dot');
    const tri = pl.find((g) => g.kind === 'joint');
    const hasAll = (g, ks) => ks.every((k) => k in g);
    ok(line && hasAll(line, ['pts', 'x1', 'y1', 'x2', 'y2', 'z', 'w', 'wA', 'zBias', 'c', 'flat', 'pA', 'pB', 'sel', 'joints'])
        && Array.isArray(line.joints) && line.joints.length === 2 && line.flat === true && line.zBias === 0 && line.sel === false,
    'line prim carries the REQUIRED fields (joints, flat, pA/pB, zBias 0, sel false)');
    ok(dot && hasAll(dot, ['x1', 'y1', 'z', 'r', 'rA', 'c', 'pA', 'sel']) && Math.abs(dot.rA - 0.7) < 1e-9,
        'dot prim carries x1,y1,z,r,rA,c,pA,sel and the caller\'s radius in Angstrom');
    ok(tri && tri.q.length === 3 && tri.two === true && tri.gs0 === -1 && tri.resId === -1
        && typeof tri.nl === 'number' && !('unlit' in tri),
    'tri reuses the joint prim: q x3, two, gs0 -1, resId -1 (no residue hides it), nl, NO unlit');
    ok(pl.length === 3 && pl.every((g) => g.noInk === true), 'plugin prims are noInk by default');
    // the near-plane drop: ortho is ignored here, so force perspective and put a point behind the camera
    const p2 = mk({ viewerState: { extent: 30, zoom: 1, ortho: 0.1, focalLength: 50, rotation: I3, center: { x: 0, y: 0, z: 0 } } });
    let back = null;
    global.window.py2dmolPlugins.register({ name: 'behind', version: '1', apiVersion: 1, prims(ctx) {
        back = [ctx.line([0, 0, 0], [0, 0, 80], {}), ctx.dot([0, 0, 90], {}), ctx.line([0, 0, 0], [5, 0, 0], {})];
    } });
    global.window.py2dmol_plugins = { v1: payloadsFor('behind') };
    cartoon.render(p2.r, recorder().ctx, 600, 600, p2.segs.map(() => ({ r: 1, g: 1, b: 1 })));
    ok(back && back[0] === false && back[1] === false && back[2] === true,
        'a segment or point behind the camera is DROPPED (no near-plane clipping), the rest is kept');
}
// CONTROL: a hand-built `line` prim without `joints` throws in the 2D painter.
// This is why ctx.line() exists and fills the whole schema.
reset();
attach('hand');
global.window.py2dmolPlugins.register({ name: 'hand', version: '1', apiVersion: 1, prims() {} });
{
    const { r, segs } = mk();
    const prims = [];
    const A = [200, 300, 0, 1]; const B = [400, 300, 0, 1];
    prims.push({ kind: 'line', pts: [A, B], x1: 200, y1: 300, x2: 400, y2: 300, z: 0, w: 3, wA: 0.3, zBias: 0,
        c: { r: 1, g: 2, b: 3 }, flat: true, pA: A, pB: B, sel: false });
    r._primProbe = null;
    // a real render, then the same prim added by a geometry hook: emulate by a plugin-less collect
    global.window.py2dmolPlugins.collect = ((orig) => (g) => { g.prims.push(prims[0]); return orig(g) || 1; })(global.window.py2dmolPlugins.collect);
    const e = throws(() => cartoon.render(r, recorder().ctx, 600, 600, segs.map(() => ({ r: 100, g: 140, b: 220 }))));
    ok(e instanceof TypeError, 'CONTROL: a `line` prim WITHOUT `joints` throws in the 2D painter: '
        + (e ? String(e.message).slice(0, 60) : 'did NOT throw'));
}

// ---- R6: the apiVersion is checked, with a message --------------------------------
// A REFUSAL IS THE SAME WHEREVER IT HAPPENS: recorded in `rejected`, logged ONCE, null back,
// and never a throw - a direct register() and a definition parked before the bundle behave alike.
reset();
{
    const P = global.window.py2dmolPlugins;
    const r1 = P.register({ name: 'future', version: '3', apiVersion: 2, prims() {} });
    const rj = (n) => (P.rejected.find((x) => x.name === n) || {}).message || '';
    ok(r1 === null && /"future"/.test(rj('future')) && /apiVersion 2/.test(rj('future')) && /API version 1/.test(rj('future'))
        && /NOT registered/.test(rj('future')) && /update py2Dmol/.test(rj('future')),
    'R6: a NEWER apiVersion is refused by name, with both versions and what to do, and returns null: ' + rj('future').slice(0, 70));
    const r0 = P.register({ name: 'ancient', version: '0', apiVersion: 0, prims() {} });
    ok(r0 === null && /older than this core: update the plugin/.test(rj('ancient')), 'R6: an OLDER apiVersion says so');
    const rN = P.register({ name: 'none', prims() {} });
    ok(rN === null && /declares no apiVersion/.test(rj('none')), 'R6: no apiVersion at all is refused, not assumed');
    ok(P.list.length === 0 && P.rejected.length === 3, 'a refused plugin is not in the list, and is recorded in `rejected`');
    ok(logged.error.some((m) => /future/.test(m)), 'and it is on the console (never a silent no-op)');
    const rP = P.register({ name: 'noprims', version: '1', apiVersion: 1 });
    ok(rP === null && /no prims\(ctx\)/.test(rj('noprims')), 'a plugin with no prims() is refused');
    const n0 = logged.error.length;
    P.register({ name: 'future', version: '3', apiVersion: 2, prims() {} });
    P.register({ name: 'future', version: '3', apiVersion: 2, prims() {} });
    ok(logged.error.length === n0, 'the same refusal arriving again (one inline script per viewer) is logged ONCE, not per script');
    // ...and the PARKED path gives the same answer as the direct one
    const direct = rj('future');
    delete global.window.py2dmolPlugins;
    global.window.py2dmolPlugins = { list: [], pending: [{ name: 'future', version: '3', apiVersion: 2, prims() {} }] };
    logged.error.length = 0;
    const e = throws(() => load(PLUGINS_JS));
    const Q = global.window.py2dmolPlugins;
    ok(e === null && Q.list.length === 0 && Q.rejected.length === 1 && Q.rejected[0].message === direct
        && logged.error.length === 1, 'R6: parked before the bundle gives the SAME record and message as a direct register()');
    reset();
}

// ---- R2: registration at any time ---------------------------------------------------
{
    // BEFORE the bundle: the stub, the definition parked on it, then this file
    delete global.window.py2dmolPlugins;
    const P0 = global.window.py2dmolPlugins = { list: [], pending: [] };
    const def = { name: 'early', version: '1', apiVersion: 1, prims(ctx) { ctx.line([0, 0, 0], [9, 0, 0], { color: [9, 9, 250] }); } };
    (P0.register ? P0.register(def) : P0.pending.push(def));
    attach('early');
    load(PLUGINS_JS);
    ok(global.window.py2dmolPlugins === P0 && P0.list.length === 1 && P0.pending.length === 0,
        'R2: a plugin parked on the stub BEFORE the bundle is adopted by it (same object, nothing lost)');
    ok(has(trace().ops, 'rgb(9,9,250)') > 0, 'R2: ...and it draws');
    // a bad one parked before the bundle must not stop the bundle loading
    delete global.window.py2dmolPlugins;
    global.window.py2dmolPlugins = { list: [], pending: [{ name: 'badv', version: '1', apiVersion: 99, prims() {} }] };
    const e = throws(() => load(PLUGINS_JS));
    ok(e === null && global.window.py2dmolPlugins.rejected.length === 1,
        'R2: a refused plugin parked before the bundle is recorded and does NOT stop the bundle loading');
}
{
    // AFTER the bundle, AFTER a viewer is already up: no throw, and the live viewer redraws
    reset();
    attach('late');
    const { r, segs } = mk();
    const { ctx } = recorder();
    cartoon.render(r, ctx, 600, 600, segs.map(() => ({ r: 100, g: 140, b: 220 })));    // the viewer is up (attaches)
    ok(global.window.py2dmolPlugins.key(r) === '', 'a payload for a plugin nobody registered yet contributes no key');
    ok(logged.warn.some((m) => /"late"/.test(m) && /no plugin of that name is registered/.test(m)),
        'an unregistered payload is warned about by name');
    const e = throws(() => global.window.py2dmolPlugins.register({ name: 'late', version: '1', apiVersion: 1,
        prims(c) { c.line([0, 0, 0], [9, 0, 0], { color: [1, 250, 1] }); } }));
    ok(e === null, 'R2: registering AFTER the first viewer does not throw (py2dmolMolParts would)');
    ok(r._renders === 1, 'R2: the live viewer is asked to draw again on register() (render called ' + (r._renders || 0) + 'x)');
    ok(global.window.py2dmolPlugins.key(r) !== '', 'and its key now carries the plugin');
    const { ctx: c2, ops } = recorder();
    cartoon.render(r, c2, 600, 600, segs.map(() => ({ r: 100, g: 140, b: 220 })));
    ok(has(ops, 'rgb(1,250,1)') > 0, 'R2: the late plugin draws in the viewer that was already up');
}
{
    // the same plugin arriving twice (one inline script per viewer) is one plugin
    reset();
    const def = { name: 'twice', version: '1', apiVersion: 1, prims() {} };
    const P = global.window.py2dmolPlugins;
    P.register(def); P.register({ name: 'twice', version: '1', apiVersion: 1, prims() {} });
    ok(P.list.length === 1 && P.list[0] === def, 'the same name and version registered twice is one plugin');
    P.register({ name: 'twice', version: '2', apiVersion: 1, prims() {} });
    ok(P.list.length === 1 && P.list[0].version === '2' && logged.warn.some((m) => /replaced/.test(m)),
        'a new VERSION under the same name replaces it in place, with a warning');
}

// ---- R7: maxPrims ---------------------------------------------------------------------
reset();
{
    const P = global.window.py2dmolPlugins;
    let n = 8000;
    P.register({ name: 'big', version: '1', apiVersion: 1, prims(ctx) {
        for (let i = 0; i < n; i++) ctx.line([0, 0, 0], [i % 7, 1, 0], { color: [250, 0, 250] });
    } });
    attach('big');
    const atCap = trace();
    ok(has(atCap.ops, 'rgb(250,0,250)') > 0 && P.errors(atCap.r).length === 0,
        'exactly maxPrims (8000) primitives on the 2D painter is allowed');
    n = 8001;
    logged.error.length = 0;
    const over = trace();
    ok(has(over.ops, 'rgb(250,0,250)') === 0 && over.ops.join('\n') === base.join('\n'),
        'R7: ONE over the cap draws NOTHING of that plugin - not a truncated 8000');
    const errs = P.errors(over.r);
    ok(errs.length === 1 && /"big"/.test(errs[0].message) && /maxPrims=8000/.test(errs[0].message)
        && /2D/.test(errs[0].message) && /GPU 60000/.test(errs[0].message) && /decimate/.test(errs[0].message),
    'R7: the error names the plugin, the cap, both painters and the remedy: ' + (errs[0] && errs[0].message.slice(0, 90)));
    ok(logged.error.length === 1 && /maxPrims=8000/.test(logged.error[0]), 'R7: and it is on the console, once');
    {
        const { r: r1, segs: s1 } = mk();
        const d1 = () => cartoon.render(r1, recorder().ctx, 600, 600, s1.map(() => ({ r: 100, g: 140, b: 220 })));
        logged.error.length = 0;
        d1(); d1(); d1();
        ok(logged.error.length === 1, 'R7: ...once per viewer, not once a frame (' + logged.error.length + ' in 3 frames)');
    }
    // the GPU painter harvests geometry with _probeOnly and has a larger cap
    const g = trace({ _probeOnly: true });
    ok(P.errors(g.r).length === 0, 'R7: the same 8001 prims are inside the GPU cap (60000)');
    n = 60001;
    const g2 = trace({ _probeOnly: true });
    ok(/maxPrims=60000/.test((P.errors(g2.r)[0] || {}).message || '') && /GPU painter/.test((P.errors(g2.r)[0] || {}).message || ''),
        'R7: 60001 is over the GPU cap and says GPU');
    // a good plugin beside a bad one still draws
    P.register({ name: 'good', version: '1', apiVersion: 1, prims(ctx) { ctx.line([0, 0, 0], [9, 0, 0], { color: [1, 2, 250] }); } });
    global.window.py2dmol_plugins = { v1: Object.assign(payloadsFor('big'), payloadsFor('good')) };
    const both = trace();
    ok(has(both.ops, 'rgb(1,2,250)') > 0 && has(both.ops, 'rgb(250,0,250)') === 0,
        'R7: one plugin over its cap does not take the others down');
    ok(P.errors(both.r).length === 1, '...and only it is in the error state');
    // the state clears on the next good frame OF THE SAME VIEWER
    n = 8001;
    const { r: rr, segs: ss } = mk();
    const draw = () => cartoon.render(rr, recorder().ctx, 600, 600, ss.map(() => ({ r: 100, g: 140, b: 220 })));
    draw();
    const was = P.errors(rr).length;
    n = 10;
    draw();
    ok(was === 1 && P.errors(rr).length === 0, 'R7: the error state clears on the next frame that fits (' + was + ' -> ' + P.errors(rr).length + ')');
}

// ---- a plugin that THROWS -------------------------------------------------------------
reset();
{
    const P = global.window.py2dmolPlugins;
    P.register({ name: 'boom', version: '1', apiVersion: 1, prims(ctx) { ctx.line([0, 0, 0], [3, 0, 0], { color: [250, 250, 0] }); throw new Error('kaboom'); } });
    attach('boom');
    const t = trace();
    ok(has(t.ops, 'rgb(250,250,0)') === 0, 'a plugin that throws half way adds NOTHING (its earlier prims are rolled back)');
    ok(P.errors(t.r)[0] && /plugin "boom": kaboom/.test(P.errors(t.r)[0].message), 'and the error is named and kept');
    ok(t.ops.join('\n') === base.join('\n'), 'and the rest of the picture is exactly the picture without it');
}

// ---- the key --------------------------------------------------------------------------
reset();
{
    const P = global.window.py2dmolPlugins;
    let own = 'a';
    P.register({ name: 'k', version: '1', apiVersion: 1, options: { shell: 1 }, key() { return own; }, prims() {} });
    attach('k');
    const { r } = mk();
    const k0 = P.key(r);
    ok(k0 !== '', 'a viewer with a live plugin has a key');
    own = 'b';
    ok(P.key(r) !== k0, 'key moves with the plugin\'s own key()');
    own = 'a';
    ok(P.key(r) === k0, 'key is stable while nothing moves');
    P.setOption(r, 'k', 'shell', 2);
    ok(P.key(r) !== k0 && r._renders === 1, 'key moves with an option, and the viewer is redrawn');
    const k1 = P.key(r);
    P.setPayload(r, 'k', { payloads: [{ object: null, frame: null, payload: { x: 1 } }] });
    ok(P.key(r) !== k1, 'key moves with a new payload');
    // frame-bound payloads select by frame
    global.window.py2dmol_plugins = { v1: { k: { version: '1', apiVersion: 1, options: {}, payloads: [
        { object: null, frame: 0, payload: 'f0' }, { object: null, frame: 1, payload: 'f1' }] } } };
    const { r: r2 } = mk({ viewerId: 'v1' });
    const ka = P.key(r2);
    r2.currentFrame = 1;
    ok(P.key(r2) !== ka, 'key moves with the FRAME when a payload is frame-bound');
}

// ---- bounds: a plugin's extent joins the fit to view ------------------------------------
// ...ONLY while nothing has set the view span. orient, focus and the app write a tight
// target through setViewSpan (viewerState.extent); a floor applied over THAT would stop a
// focus on one residue from zooming closer than a shell drawn around it.
reset();
{
    const P = global.window.py2dmolPlugins;
    const setViewSpan = new Function('return ' + L.topFunction('setViewSpan'))();
    const view = (over, maxExtent) => mk({
        objectsData: { obj: { maxExtent: maxExtent === undefined ? 10 : maxExtent } },
        viewerState: Object.assign({ extent: null, zoom: 1, ortho: 1, focalLength: 100, rotation: I3,
            center: { x: 0, y: 0, z: 0 } }, over || {}) }).r;
    const plain = view();
    const w0 = plain._viewHalfSpan(plain.objectsData.obj);
    P.register({ name: 'b', version: '1', apiVersion: 1, prims() {}, bounds() { return { min: [-3, -3, -3], max: [3, 3, 40] }; } });
    attach('b');
    const r = view();
    // _viewHalfSpan asks the registry; the lifted method is the shipped one
    const w1 = r._viewHalfSpan(r.objectsData.obj);
    const want = Math.sqrt(3 * 3 + 3 * 3 + 40 * 40);
    ok(w0.x === 10 && Math.abs(w1.x - want) < 1e-9 && Math.abs(w1.y - want) < 1e-9,
        'bounds: the half-span grows to the plugin\'s radius (' + w1.x.toFixed(3) + ' vs ' + want.toFixed(3) + '), was ' + w0.x);
    const rot = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
    const r3 = view({ rotation: rot });
    ok(Math.abs(r3._viewHalfSpan(r3.objectsData.obj).x - w1.x) < 1e-9, 'bounds: the radius is the same at another rotation');
    const r4 = view({ zoom: 2 });
    ok(Math.abs(r4._viewHalfSpan(r4.objectsData.obj).x - want / 2) < 1e-9, 'bounds: zoom still divides the span');
    const small = view({}, 100);
    ok(small._viewHalfSpan(small.objectsData.obj).x === 100, 'bounds: a plugin inside the structure does not move the view');
    // orient / focus: a tight target span is honoured, whatever the plugin's radius
    const f = view();
    setViewSpan(f.viewerState, { x: 4, y: 4 });
    const tight = f._viewHalfSpan(f.objectsData.obj);
    ok(tight.x === 4 && tight.y === 4, 'bounds: a span set by orient/focus (setViewSpan) is NOT raised to the plugin\'s radius ('
        + tight.x + ', plugin radius ' + want.toFixed(1) + ')');
    const fz = view({ zoom: 2 });
    setViewSpan(fz.viewerState, { x: 8, y: 8 });
    ok(fz._viewHalfSpan(fz.objectsData.obj).x === 4, '...and the reader\'s zoom still divides it');
    setViewSpan(f.viewerState, null);        // "orient to all" ends with no temporary span
    ok(Math.abs(f._viewHalfSpan(f.objectsData.obj).x - want) < 1e-9, 'bounds: back to the fit when the span is released, the plugin is framed again');
}

// ---- the floor an orient-to-everything puts under the span is PER AXIS --------------------------------
// (extent, aspect): extent * aspect.x and extent * aspect.y are the half-spans. Flooring the
// EXTENT at a plugin's radius would raise the long axis of an elongated structure by
// need / aspect.min - 19x for a helix (aspect 0.053 : 1) - and the picture would come out tiny.
{
    const text = L.orient;
    const a = text.indexOf('function floorViewSpan(');
    const b = text.indexOf('\n}\n', a);
    ok(a >= 0, 'floor: parts/orient.js has floorViewSpan');
    const floorViewSpan = new Function('return ' + text.slice(a, b + 2))();
    const half = (f) => [f.extent * ((f.aspect && f.aspect.x) || 1), f.extent * ((f.aspect && f.aspect.y) || 1)];
    const near = (u, v) => Math.abs(u - v) < 1e-9;
    // an elongated structure: an 88 A helix, shell radius 45 A. Its own span is (45, {0.0528, 1}).
    const helix = floorViewSpan(45, { x: 0.0528, y: 1 }, 45);
    const hh = half(helix);
    ok(near(hh[0], 45) && near(hh[1], 45) && near(helix.extent, 45),
        'floor: an ELONGATED structure gets the floor on each axis and no more (half-spans ' + hh.map((v) => v.toFixed(1)).join(' x ') + ', extent ' + helix.extent.toFixed(1) + ')');
    const isotropic = (e, asp, need) => e * 0 + Math.max(e, need / Math.min(asp.x, asp.y));
    ok(isotropic(45, { x: 0.0528, y: 1 }, 45) > 800,
        'floor: CONTROL - flooring the extent alone would ask for ' + isotropic(45, { x: 0.0528, y: 1 }, 45).toFixed(0) + ' A on the long axis, so the check above can fail');
    // a LONG axis already past the floor is not touched; only the short one rises
    const rod = floorViewSpan(88, { x: 0.05, y: 1 }, 45);
    const rh = half(rod);
    ok(near(rh[1], 88) && near(rh[0], 45), 'floor: a long axis already past the floor is left alone, the short one rises to it (' + rh.map((v) => v.toFixed(1)).join(' x ') + ')');
    // square
    const sq = floorViewSpan(20, { x: 1, y: 1 }, 45);
    ok(near(sq.extent, 45) && near(sq.aspect.x, 1) && near(sq.aspect.y, 1), 'floor: a square-aspect structure rises to the floor on both axes');
    const sq2 = floorViewSpan(20, { x: 1, y: 0.8 }, 45);
    const s2 = half(sq2);
    ok(near(s2[0], 45) && near(s2[1], 45), 'floor: a near-square one too (' + s2.map((v) => v.toFixed(1)).join(' x ') + ')');
    // nothing to raise: the very same span comes back, untouched
    const same = floorViewSpan(60, { x: 0.9, y: 1 }, 45);
    ok(same.extent === 60 && same.aspect.x === 0.9 && same.aspect.y === 1, 'floor: a span that already holds the floor is returned as it was');
    ok(floorViewSpan(10, null, 0).extent === 10, 'floor: a floor of 0 (no plugin) changes nothing, and a null aspect is tolerated');
    // the stored form round-trips through the renderer's own writer and reader
    const setViewSpan = new Function('return ' + L.topFunction('setViewSpan'))();
    const st = {};
    setViewSpan(st, { x: hh[0], y: hh[1] });
    ok(near(half({ extent: st.extent, aspect: st.extentAspect })[0], 45) && near(half({ extent: st.extent, aspect: st.extentAspect })[1], 45),
        'floor: what it returns is what setViewSpan would have written for the same half-spans');
}

// ---- noInk reaches the painter -------------------------------------------------------------
reset();
{
    const P = global.window.py2dmolPlugins;
    let ink = false;
    P.register({ name: 'ink', version: '1', apiVersion: 1, prims(ctx) {
        for (let i = 0; i < 20; i++) ctx.line([-10, i - 10, 0], [10, i - 10, 0], { color: [3, 200, 3], width: 0.3, ink });
    } });
    attach('ink');
    const off = trace().ops;
    ink = true;
    const on = trace().ops;
    const lwOf = (o) => o.filter((x) => /^lineWidth=/.test(x)).length;
    ok(on.length > off.length && lwOf(on) > lwOf(off), 'noInk: a plugin line with ink:true strokes its outline, the default does not (' + off.length + ' vs ' + on.length + ' ops)');
}

// ---- a registered plugin changes nothing for ANOTHER viewer ---------------------------------
reset();
{
    const P = global.window.py2dmolPlugins;
    P.register({ name: 'only1', version: '1', apiVersion: 1, prims(ctx) { ctx.line([0, 0, 0], [9, 0, 0], { color: [9, 250, 9] }); } });
    attach('only1');
    const other = trace({ viewerId: 'v2' });
    ok(other.ops.join('\n') === base.join('\n'), 'a payload is per viewer: another viewer draws byte-identically to none');
}

// ---- the bundle evaluated TWICE on one page ------------------------------------------------
// A second notebook cell (any mode that does not lend the library) runs this file again. The
// state - which viewers exist, what they hold - lives on the registry object, so the second
// evaluation must change NOTHING: init once per viewer, and a late registration still reaches
// every viewer either copy ever saw.
reset();
{
    const P = global.window.py2dmolPlugins;
    let inits = 0;
    const r1 = mk({ viewerId: 'v1' }).r; const r2 = mk({ viewerId: 'v2' }).r;
    global.window.py2dmol_plugins = { v1: payloadsFor('p').p ? payloadsFor('p') : null, v2: payloadsFor('p') };
    P.register({ name: 'p', version: '1', apiVersion: 1, init() { inits++; return {}; }, prims() {}, key() { return 'k'; } });
    P.key(r1); P.key(r2);
    ok(inits === 2, 'twice: one init per viewer after the first evaluation (' + inits + ')');
    const reg = P.register; const keyFn = P.key;
    load(PLUGINS_JS);
    ok(global.window.py2dmolPlugins === P && P.register === reg && P.key === keyFn,
        'twice: the second evaluation leaves the registry and its functions alone');
    P.key(r1); P.key(r2);
    ok(inits === 2, 'twice: ...so asking again does NOT run init again (' + inits + ')');
    const r3 = mk({ viewerId: 'v3' }).r;
    global.window.py2dmol_plugins.v3 = payloadsFor('p');
    P.key(r3);
    ok(inits === 3, 'twice: a viewer first seen AFTER the second evaluation gets exactly one init');
    P.register({ name: 'p', version: '2', apiVersion: 1, init() { inits++; return {}; }, prims() {}, key() { return 'k2'; } });
    ok(r1._renders === 1 && r2._renders === 1 && r3._renders === 1,
        'twice: a late registration redraws EVERY viewer, including those the first evaluation saw (' + [r1, r2, r3].map((r) => r._renders).join(',') + ')');
}

// ---- an OLDER copy of the library cannot downgrade a NEWER registry --------------------------------------
// The guard is `__impl >= IMPL`: the same or a newer implementation already on the page wins and this
// file does nothing; an older one (or none) is taken over, with its plugins kept and fresh per-viewer state.
{
    delete global.window.py2dmolPlugins;
    const sentinel = () => 'newer';
    const newer = global.window.py2dmolPlugins = { list: [{ name: 'kept' }], pending: [{ name: 'parked' }], __impl: 99, register: sentinel, key: sentinel };
    load(PLUGINS_JS);
    ok(global.window.py2dmolPlugins === newer && newer.register === sentinel && newer.key === sentinel && newer.__impl === 99,
        'older-than-page: a NEWER registry already on the page is left exactly as it was (register, key, __impl 99)');
    ok(newer.pending.length === 1 && newer.list.length === 1 && newer.rejected === undefined && newer.caps === undefined,
        'older-than-page: ...and nothing of this file ran (pending not consumed, no caps or rejected added)');
    delete global.window.py2dmolPlugins;
    const older = global.window.py2dmolPlugins = { list: [], pending: [], __impl: 1, register: sentinel };
    load(PLUGINS_JS);
    ok(older.__impl === 2 && older.register !== sentinel && typeof older.collect === 'function',
        'older-than-page: an OLDER registry (impl 1) IS taken over by this one');
    reset();
}

// ---- NEAR is clamped for a plugin's faces and balls -----------------------------------------------
// paint2d asks nearOf(g.z), which is the STRUCTURE's own depth span and unclamped: a plugin
// triangle outside it extrapolates (paper-white behind, brighter than its colour in front).
// The GPU clamps near01; so must this.
reset();
{
    const P = global.window.py2dmolPlugins;
    let z = 0; let what = 'tri';
    P.register({ name: 'depth', version: '1', apiVersion: 1, prims(ctx) {
        if (what === 'tri') ctx.tri([-5, -5, z], [5, -5, z], [0, 6, z], { color: [10, 200, 30] });
        else ctx.dot([-5, -5, z], { color: [10, 200, 30], radius: 1.2 });
    } });
    attach('depth');
    const fillOf = (zz, kind) => {
        z = zz; what = kind;
        const { r, segs } = mk({ cartoonFade: 1 });
        const { ctx, ops } = recorder();
        cartoon.render(r, ctx, 600, 600, segs.map(() => ({ r: 100, g: 140, b: 220 })));
        const s = 600 * 0.85 / 60;
        const at = kind === 'tri' ? 'moveTo(' + (300 - 5 * s) + ',' + (300 + 5 * s) + ')'
            : 'arc(' + (300 - 5 * s) + ',' + (300 + 5 * s) + ',';
        const i = ops.findIndex((o) => o.startsWith(at));
        if (i < 0) return null;
        // a triangle is filled with the style set BEFORE its path; a ball's bands set theirs after the arc
        if (kind === 'dot') { for (let k = i; k < ops.length; k++) if (/^fillStyle=rgb/.test(ops[k])) return ops[k]; return null; }
        for (let k = i; k >= 0; k--) if (/^fillStyle=rgb/.test(ops[k])) return ops[k];
        return null;
    };
    const chans = (f) => (/rgb\((-?\d+),(-?\d+),(-?\d+)\)/.exec(f || '') || []).slice(1).map(Number);
    for (const kind of ['tri', 'dot']) {
        const far1 = fillOf(-200, kind); const far2 = fillOf(-1000, kind);
        const near1 = fillOf(200, kind); const near2 = fillOf(1000, kind);
        ok(far1 && far2 && near1 && near2, 'near [' + kind + ']: the plugin ' + kind + ' is painted at every depth');
        const inRange = [far1, far2, near1, near2].every((f) => chans(f).length === 3 && chans(f).every((v) => v >= 0 && v <= 255));
        ok(inRange, 'near [' + kind + ']: every colour is inside 0..255 at depths far outside the structure\'s span: ' + [far1, near1].join(' '));
        ok(far1 === far2 && near1 === near2, 'near [' + kind + ']: beyond the span the colour stops changing - clamped, not extrapolated ('
            + far1 + ' / ' + far2 + ' ; ' + near1 + ' / ' + near2 + ')');
    }
}

// ---- non-finite and absurd coordinates never reach a painter ---------------------------------------------
reset();
{
    const P = global.window.py2dmolPlugins;
    const got = [];
    P.register({ name: 'nan', version: '1', apiVersion: 1, prims(ctx) {
        got.push(ctx.line([NaN, 0, 0], [1, 0, 0], { color: [1, 2, 3] }));
        got.push(ctx.line([0, 0, 0], [Infinity, 0, 0], { color: [1, 2, 3] }));
        got.push(ctx.line([0, 0, 0], [1e6, 0, 0], { color: [1, 2, 3] }));      // finite, and absurd
        got.push(ctx.dot([1e30, 0, 0], { color: [1, 2, 3] }));
        got.push(ctx.tri([0, 0, 0], [1, 0, 0], [0, NaN, 0], { color: [1, 2, 3] }));
        got.push(ctx.line([-10, 0, 0], [10, 0, 0], { color: [250, 0, 250] }));   // the one good one
    } });
    attach('nan');
    const { r, segs } = mk();
    r._primProbe = null;
    const { ctx, ops } = recorder();
    const e = throws(() => cartoon.render(r, ctx, 600, 600, segs.map(() => ({ r: 100, g: 140, b: 220 }))));
    ok(e === null, 'finite: a plugin handing over NaN / Infinity / 1e30 does not make render throw');
    ok(got.join() === 'false,false,false,false,false,true', 'finite: each bad primitive is refused by its helper (returns false), the good one kept: ' + got.join());
    const pl = (r._primProbe || []).filter((g) => g.plugin);
    const numbers = (g) => JSON.stringify(g, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? '!' + v : v));
    ok(pl.length === 1 && !pl.some((g) => /"!/.test(numbers(g))), 'finite: one plugin prim reaches the list, and nothing non-finite is in it');
    ok(!ops.some((o) => /NaN|Infinity|e\+\d/.test(o)), 'finite: no NaN, Infinity or exponent reaches a canvas call');
    ok(has(ops, 'rgb(250,0,250)') > 0, 'finite: the good stroke is drawn');
    const errs = P.errors(r);
    ok(errs.length === 1 && /5 primitives/.test(errs[0].message) && /not finite/.test(errs[0].message),
        'finite: the plugin is in an error state that counts what it dropped: ' + (errs[0] && errs[0].message.slice(0, 100)));
    ok(logged.error.length === 1, 'finite: ...and it is logged once');
    // bounds() is held to the same rule: a NaN corner cannot poison the fit
    reset();
    P.register; // (new registry after reset)
    const Q = global.window.py2dmolPlugins;
    Q.register({ name: 'nb', version: '1', apiVersion: 1, prims() {}, bounds() { return { min: [0, 0, 0], max: [NaN, 1, 1] }; } });
    attach('nb');
    const rb = mk({ objectsData: { obj: { maxExtent: 10 } },
        viewerState: { extent: null, zoom: 1, ortho: 1, focalLength: 100, rotation: I3, center: { x: 0, y: 0, z: 0 } } }).r;
    const hs = rb._viewHalfSpan(rb.objectsData.obj);
    ok(hs.x === 10 && Q.errors(rb).length === 1, 'finite: a NaN in bounds() leaves the fit alone and is an error state (half-span ' + hs.x + ')');
}

// ---- one cap per painter; an export cannot thrash the GPU key --------------------------------------------
reset();
load('src/core/svg.js');
{
    const P = global.window.py2dmolPlugins;
    let n = 10000;
    P.register({ name: 'many', version: '1', apiVersion: 1, prims(ctx) {
        for (let i = 0; i < n; i++) ctx.line([-10, (i % 100) / 10 - 5, 0], [10, (i % 100) / 10 - 5, 1], { color: [250, 0, 250], width: 0.05 });
    } });
    attach('many');
    const { r, segs } = mk();
    const cols = segs.map(() => ({ r: 100, g: 140, b: 220 }));
    // the GPU painter harvests the list under _probeOnly
    r._probeOnly = true; r._primProbe = null;
    cartoon.render(r, recorder().ctx, 600, 600, cols);
    r._probeOnly = false;
    const gpuPrims = (r._primProbe || []).filter((g) => g.plugin).length;
    ok(gpuPrims === 10000 && P.errors(r).length === 0, 'export: 10,000 lines are inside the GPU cap and are all in the list (' + gpuPrims + ')');
    const k0 = P.key(r);
    // ...the SAME viewer exports an SVG: always the 2D painter, cap 8,000
    const svgCtx = new global.window.C2S(600, 600);
    logged.error.length = 0;
    const eSvg = throws(() => cartoon.render(r, svgCtx, 600, 600, cols));
    ok(eSvg === null, 'export: the SVG render does not throw (' + (eSvg && eSvg.message) + ')');
    const svg = svgCtx.getSerializedSvg();
    ok(/<!-- py2dmol plugin many not drawn: [^>]*maxPrims=8000[^>]*-->/.test(svg),
        'export: the SVG carries an XML comment saying the plugin was not drawn, and why');
    ok(!/--[^>]*--[^>]*-->/.test(svg.replace(/<!--[\s\S]*?-->/g, (m) => (m.slice(4, -3).includes('--') ? 'BAD--BAD-->' : ''))),
        'export: the comment text contains no "--" (it would make the file invalid XML)');
    ok(logged.error.length === 1, 'export: ...and it is logged once');
    const errs = P.errors(r);
    ok(errs.length === 1 && errs[0].painter === 'svg', 'export: the failure is recorded against the SVG painter, not the viewer\'s (' + JSON.stringify(errs.map((e) => e.painter)) + ')');
    ok(P.key(r) === k0, 'export: the SVG overrun does NOT move the registry key - no GPU rebuild (same key before and after)');
    // a fresh GPU frame afterwards is still clean, and still the same key
    r._probeOnly = true; r._primProbe = null;
    cartoon.render(r, recorder().ctx, 600, 600, cols);
    r._probeOnly = false;
    ok(P.key(r) === k0 && (r._primProbe || []).filter((g) => g.plugin).length === 10000, 'export: the next GPU frame draws all 10,000 again under the same key');
    ok(P.errors(r).every((e) => e.painter !== 'gpu'), 'export: and the GPU has no error state of its own');
    // 2D painter over its cap: the viewer's own badge, and again NOT in the key
    const k1 = P.key(r);
    cartoon.render(r, recorder().ctx, 600, 600, cols);
    ok(P.errors(r).some((e) => e.painter === '2d') && P.key(r) === k1, 'export: a 2D overrun is an error state of the 2D painter and leaves the key alone');
    // the cap is in the key: raising it is a different mesh
    const gpuCap = P.caps.gpu;
    P.caps.gpu = 5000;
    ok(P.key(r) !== k1, 'export: the caps ARE in the key (a changed cap is a different mesh)');
    P.caps.gpu = gpuCap;
}

// ---- the comment an SVG export carries is valid XML 1.0 ----------------------------------------------------
// A plugin's error message can carry anything the plugin was handed (a name, an id from its payload), and
// the message is written into the file: `--`, `<`, `>`, a control character or an unpaired surrogate in it
// must not make the file unreadable.
{
    const c = new global.window.C2S(200, 100);
    c.comment('py2dmol plugin p not drawn: mesh id "a\u0001b\uffffc" -- bad <x> & trailing-');
    c.comment('ends with dashes ---');
    c.comment('lone \ud800 surrogate and \u0000 nul');
    const out = c.getSerializedSvg();
    // the characters XML 1.0 forbids: C0 controls but tab / newline / carriage return, U+FFFE/FFFF, lone surrogates
    const invalid = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    ok(!invalid.test(out), 'comment(): the characters XML 1.0 forbids are dropped');
    // A REAL XML PARSER (python's, through a subprocess - node has none): the file must parse
    const { spawnSync } = require('child_process');
    const r = spawnSync('python3', ['-c', 'import sys, xml.dom.minidom as m; m.parseString(sys.stdin.buffer.read())'], { input: out });
    ok(r.status === 0, 'comment(): the SVG with those comments PARSES as XML' + (r.status === 0 ? '' : ': ' + String(r.stderr).split('\n').filter(Boolean).pop()));
    ok(/mesh id "abc" - bad  x  & trailing-/.test(out), 'comment(): and what is left of the message is readable');
}

// ---- the GPU tube's plugins: the same plugin, as MODEL-SPACE capsules ---------------------------------------
// The tube's instances never hold a screen coordinate, so collectModel runs the plugin into model space:
// a point goes through its object's alignment and nothing else - the rotation is a uniform. A triangle has
// no capsule to be and is only counted (the tube then gives the frame to the 2D path).
reset();
{
    const P = global.window.py2dmolPlugins;
    P.register({ name: 'tb', version: '1', apiVersion: 1, prims(c) {
        c.line([1, 2, 3], [4, 5, 6], { color: [255, 0, 0], width: 0.8, ink: true });
        c.dot([7, 8, 9], { color: '#00ff00', radius: 2 });
        if (c.options.tri) c.tri([0, 0, 0], [1, 0, 0], [0, 1, 0], { color: [0, 0, 255] });
        if (c.options.far) c.line([0, 0, 0], [1e30, 0, 0]);
    } });
    attach('tb');
    const { r } = mk();
    const m = P.collectModel(r, r.objectsData.obj);
    ok(m && m.lines.length === 1 && m.dots.length === 1 && m.tris === 0, 'collectModel: one line and one ball, no triangle');
    const ln = m.lines[0]; const dt = m.dots[0];
    ok(ln.a.join() === '1,2,3' && ln.b.join() === '4,5,6' && ln.rad === 0.4 && ln.c.r === 255 && ln.ink === true,
        'collectModel: a line is its two MODEL-space ends, half its width as a radius, its colour and its ink');
    ok(dt.p.join() === '7,8,9' && dt.rad === 2 && dt.c.g === 255 && dt.ink === false,
        'collectModel: a ball is its centre and radius in Angstrom, no ink unless asked');
    r.objectsData.obj.alignTransform = { t: [10, 0, 0], u: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    ok(P.collectModel(r, r.objectsData.obj).lines[0].a.join() === '11,2,3',
        'collectModel: the object\'s alignment is applied, as renderer.coords has it applied');
    delete r.objectsData.obj.alignTransform;
    P.setOption(r, 'tb', 'tri', true);
    const mt = P.collectModel(r, r.objectsData.obj);
    ok(mt.tris === 1 && mt.lines.length === 1, 'collectModel: a triangle is COUNTED, not drawn (the tube has no shape for it)');
    P.setOption(r, 'tb', 'tri', false);
    P.setOption(r, 'tb', 'far', true);
    const mf = P.collectModel(r, r.objectsData.obj);
    ok(mf.lines.length === 1 && P.errors(r).some((x) => x.painter === 'gpu' && /dropped/.test(x.message)),
        'collectModel: an absurd coordinate is refused and reported, as on the screen path');
    P.setOption(r, 'tb', 'far', false);
    const cap0 = P.caps.gpu;
    P.caps.gpu = 1;
    const mb = P.collectModel(r, r.objectsData.obj);
    ok(mb.lines.length === 0 && mb.dots.length === 0 && P.errors(r).some((x) => /maxPrims=1/.test(x.message)),
        'collectModel: over the GPU cap the plugin draws NOTHING, as on the screen path');
    P.caps.gpu = cap0;
    delete global.window.py2dmol_plugins;
    const rn = mk({ viewerId: 'nobody' }).r;
    ok(P.collectModel(rn, rn.objectsData.obj) === null, 'collectModel: null for a viewer with no plugin payload');
}

// ---- the GPU's cached part is keyed on what a plugin line IS, noInk and all -------------------------------
{
    const text = L.read('src/cartoon/paintgl.js');
    const a = text.indexOf('function linesKeyOf(');
    const b = text.indexOf('\n}\n', a);
    const linesKeyOf = new Function('return ' + text.slice(a, b + 2))();
    const ln = (extra) => Object.assign({ pts: [[1, 2, 3], [4, 5, 6]], c: { r: 1, g: 2, b: 3 }, w: 2, wA: 0.3, zBias: 0 }, extra);
    const plain = linesKeyOf([ln()]);
    ok(plain === linesKeyOf([ln()]), 'linesKeyOf: the same stroke hashes the same');
    ok(linesKeyOf([ln({ noInk: true, plugin: true })]) !== linesKeyOf([ln({ noInk: false, plugin: true })]),
        'linesKeyOf: a plugin stroke with and without its border are DIFFERENT parts (else the cached part keeps a stale rim)');
    ok(linesKeyOf([ln({ noInk: false, plugin: true })]) !== plain, 'linesKeyOf: a plugin stroke is not a contact of the same shape');
}

process.exit(bad ? 1 : 0);
