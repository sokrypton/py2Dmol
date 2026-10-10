// ============================================================================
// src/parts/plugins.js
// --------------------------------
// AI Context: THE PLUGIN REGISTRY (window.py2dmolPlugins)
// - A plugin is a named piece of JavaScript that draws things that are not
//   residues - an isosurface shell, a labelled site, a contact from a marker -
//   by returning primitives that cartoon/geom.js appends to the list BOTH
//   painters draw. docs/PLUGINS.md is the design and the evidence for it.
// - NOT a viewer-mol part. It does not push onto py2dmolMolParts, whose queue
//   is sealed by the first viewer (installMolParts) - a plugin must be able to
//   register at ANY time, and the notebook prepends scripts, so its order is
//   the reverse of the order the reads appear in. This file is a wrapped IIFE
//   that publishes one global and is loaded before core/mol.js only because
//   core/mol.js and cartoon/paintgl.js ask it questions at run time.
// - Needs nothing at load time; every question it is asked it answers from
//   its own state, so a page with no plugin pays one property read a frame.
// - IDEMPOTENT: a second evaluation on one page (a second notebook cell that
//   carries its own copy of the library) changes nothing, because the state -
//   which viewers exist, what they hold - lives ON the registry object.
// ============================================================================
(function () {
'use strict';

// THE CORE'S OWN VERSION OF THE PLUGIN API. A plugin declares the apiVersion
// it was written against and register() compares it with this. It moves when
// the ctx a plugin is handed, or what it may return, changes shape.
const PLUGIN_API_VERSION = 1;

// THIS FILE'S OWN REVISION, which is what makes a second evaluation a no-op.
const IMPL = 2;

// HOW MANY PRIMITIVES A PLUGIN MAY EMIT PER FRAME, BY PAINTER. Chosen from a
// measurement (docs/PLUGINS.md, "The budget"): the 2D painter strokes every prim on the
// CPU and was still interactive at ~7,700 lines; the GPU mesh took 46,000
// lines through one build. These are the defaults the registry enforces and
// hands to a plugin as ctx.maxPrims; `window.py2dmolPlugins.caps` can be
// changed by the host page before a viewer renders. An SVG export always runs
// on the 2D painter and so uses the 2D cap, whatever painter the viewer has.
const DEFAULT_CAPS = { '2d': 8000, 'gpu': 60000 };

// A PLUGIN THAT OVERRUNS ITS CAP THROWS, IT IS NOT TRUNCATED. A truncated
// wireframe is a picture that is wrong and looks right. The throw is caught
// by collect(), which drops the WHOLE plugin for this frame and says so - in
// the console, on the viewer, in errors(), and in an SVG's own text - so a
// budget failure is an error state and never a silently thinner drawing.
class PluginBudgetError extends Error {
    constructor(name, cap, painter, capsByPainter) {
        super('plugin "' + name + '" tried to emit more than maxPrims=' + cap
            + ' primitives on the ' + painter + ' (caps: 2D '
            + capsByPainter['2d'] + ', GPU ' + capsByPainter.gpu + '). Nothing from it'
            + ' is drawn. Send fewer primitives - decimate the payload in Python -'
            + ' or raise window.py2dmolPlugins.caps if the machine can take it.');
        this.name = 'PluginBudgetError';
    }
}

// THE REGISTRY IS CREATED IF ABSENT, ON BOTH SIDES. A plugin script can load
// before this file (the notebook prepends; an external plugin is inlined ahead
// of the bundle) and so must be able to leave its definition on a stub:
//
//     var P = window.py2dmolPlugins = window.py2dmolPlugins || {list: [], pending: []};
//     if (P.register) P.register(def); else P.pending.push(def);
//
// ...and this file takes the stub over rather than replacing it, so whichever
// script ran first, the object is the same one and nothing registered is lost.
const P = window.py2dmolPlugins = window.py2dmolPlugins || { list: [], pending: [] };
// ...AND A SECOND COPY OF THIS FILE ON THE SAME PAGE DOES NOTHING. Redefining
// register/key/collect over a fresh `states` would run init twice per viewer and
// lose, to a late registration, every viewer only the first copy had seen.
// `>=`, NOT `===`: a page can carry bundles of different ages (a notebook where an
// older cell's library loads after a newer one's), and the older must never replace
// a newer registry - it would downgrade it. The same or a newer implementation wins;
// an older one (or none) is taken over, its registered plugins kept and its per-viewer
// state started afresh (a viewer re-attaches on its next question).
if (P.__impl >= IMPL) return;
P.__impl = IMPL;
if (!P.list) P.list = [];
if (!P.pending) P.pending = [];
P.rejected = P.rejected || [];
P.apiVersion = PLUGIN_API_VERSION;
P.caps = P.caps || Object.assign({}, DEFAULT_CAPS);
P.PluginBudgetError = PluginBudgetError;

// STATE, ON THE REGISTRY: per viewer a WeakMap (so a dead renderer takes its
// state with it), a list of weak references (so register() can reach the live
// ones to redraw them), and what has been said on the console.
const core = P.__core = { states: new WeakMap(), live: [], logged: new Set() };
const states = core.states;
const hasWeakRef = typeof WeakRef === 'function';

const rgbOf = (c, fallback) => {
    if (Array.isArray(c) && c.length >= 3) return { r: c[0] | 0, g: c[1] | 0, b: c[2] | 0 };
    if (c && typeof c === 'object' && 'r' in c) return { r: c.r | 0, g: c.g | 0, b: c.b | 0 };
    if (typeof c === 'string') {
        const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
        if (m) {
            const v = parseInt(m[1], 16);
            return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
        }
    }
    return fallback || { r: 200, g: 200, b: 200 };
};

// ---------------------------------------------------------------- state ----

function viewerIdOf(r) {
    return r.viewerId || (r.config && r.config.viewer_id) || null;
}

// The error states a viewer can be in, PER PAINTER. They are separate because
// they are different questions: the 2D and GPU painters have different caps and
// a viewer is on one of them; an SVG export is always the 2D painter, however
// the viewer is drawn; and `load` is init/setPayload/key/bounds, which no
// painter asks. An export that overruns must not look like the viewer's own
// failure - and never enters the GPU's cache key.
const PAINTERS = ['2d', 'gpu', 'svg', 'load', 'style'];

// The state a viewer carries for plugins. Built lazily on the first question,
// from what Python put on the page (window.py2dmol_plugins[viewerId]) and from
// every plugin registered so far.
function stateFor(r) {
    let st = states.get(r);
    if (st) return st;
    st = { r, id: viewerIdOf(r), entries: new Map(), logged: new Set(), badge: null,
        extKey: null, ext: 0, err: { '2d': new Map(), gpu: new Map(), svg: new Map(), load: new Map(),
            style: new Map() } };
    states.set(r, st);
    core.live.push(hasWeakRef ? new WeakRef(r) : r);
    const all = (typeof window !== 'undefined' && window.py2dmol_plugins && st.id)
        ? window.py2dmol_plugins[st.id] : null;
    if (all && typeof all === 'object') {
        for (const name of Object.keys(all)) {
            const d = all[name];
            if (d && typeof d === 'object') addEntry(st, name, d);
        }
    }
    for (const def of P.list) bindDef(st, def);
    for (const e of st.entries.values()) {
        if (!e.def) {
            const why = P.rejected.find((x) => x.name === e.name);
            note(st, 'unregistered:' + e.name, 'plugin "' + e.name + '": this viewer carries'
                + ' a payload for it but no plugin of that name is registered'
                + (why ? ' - ' + why.message : '') + '. It will draw if it registers later.',
                'warn');
        }
    }
    return st;
}

function addEntry(st, name, data) {
    const e = { name, data: {
        version: data.version == null ? null : data.version,
        apiVersion: data.apiVersion == null ? null : data.apiVersion,
        options: Object.assign({}, data.options || {}),
        payloads: Array.isArray(data.payloads) ? data.payloads : [],
    }, def: null, inst: null, rev: 0 };
    st.entries.set(name, e);
    return e;
}

function hostOf(st) {
    const r = st.r;
    return { renderer: r, viewerId: st.id,
        requestRender() { try { r.render('plugin'); } catch (err) { /* a viewer mid-load */ } } };
}

// Give the viewer's entry for `def.name` (if it has one) its plugin: init, then
// setPayload. Called when a viewer attaches and when a plugin registers late.
// `dispose` is called on the plugin being REPLACED - the only teardown there is:
// a viewer has no destroy hook to call it from (docs/PLUGINS.md).
function bindDef(st, def) {
    const e = st.entries.get(def.name);
    if (!e) return;
    if (e.def && e.def !== def && typeof e.def.dispose === 'function') {
        try { e.def.dispose({ instance: e.inst, host: hostOf(st) }); } catch (err) { /* replaced */ }
    }
    e.def = def;
    e.inst = null;
    try {
        if (typeof def.init === 'function') e.inst = def.init(hostOf(st));
        if (typeof def.setPayload === 'function') def.setPayload(ctxBase(st, e));
        st.err.load.delete(e.name);
    } catch (err) {
        fail(st, e, err, 'load');
    }
    e.rev++;
    st.extKey = null;
    paintBadge(st);
}

// ---------------------------------------------------------------- errors ---

function note(st, id, msg, level) {
    if (st.logged.has(id)) return;
    st.logged.add(id);
    if (typeof console !== 'undefined') (console[level] || console.error)('py2Dmol: ' + msg);
}

function errMessage(e, err) {
    const msg = (err && err.message) ? err.message : String(err);
    return err instanceof PluginBudgetError ? msg : 'plugin "' + e.name + '": ' + msg;
}

function fail(st, e, err, painter) {
    const full = errMessage(e, err);
    st.err[painter].set(e.name, full);
    note(st, 'err:' + painter + ':' + e.name + ':' + full, full, 'error');
    paintBadge(st);
    return full;
}

// THE ERROR STATE, WHERE A READER CAN SEE IT. One small line inside the
// viewer's own box; the console has the same text, and errors(renderer) has it
// for a test. Nothing is touched outside the viewer. An SVG export's failure is
// not a fact about the viewer and is not shown here - it is in the file.
function paintBadge(st) {
    if (typeof document === 'undefined') return;
    const msgs = [];
    for (const p of ['2d', 'gpu', 'load', 'style']) for (const m of st.err[p].values()) msgs.push(m);
    try {
        if (!msgs.length) {
            if (st.badge && st.badge.parentNode) st.badge.parentNode.removeChild(st.badge);
            st.badge = null;
            return;
        }
        const host = st.r.canvas && st.r.canvas.parentElement;
        if (!host) return;
        if (!st.badge) {
            st.badge = document.createElement('div');
            st.badge.setAttribute('data-py2dmol-plugin-error', '');
            st.badge.style.cssText = 'position:absolute;left:6px;bottom:6px;right:6px;'
                + 'padding:3px 6px;font:11px/1.35 ui-monospace,Menlo,monospace;color:#a11;'
                + 'background:rgba(253,244,244,0.92);border:1px solid #e0b4b4;'
                + 'border-radius:4px;pointer-events:none;z-index:5';
            host.appendChild(st.badge);
        }
        st.badge.textContent = Array.from(new Set(msgs)).join(' | ');
    } catch (err) { /* no DOM to draw the badge on: the console has it */ }
}

// ------------------------------------------------------------ the context --

// WHICH PAINTER THIS FRAME IS FOR. The GPU harvests the list through
// _probeOnly; an SVG export hands render() a context that can serialise itself
// and is always the 2D painter; anything else is the 2D painter on the screen.
function painterOf(r, ctx) {
    if (r._probeOnly) return 'gpu';
    if (ctx && typeof ctx.getSerializedSvg === 'function') return 'svg';
    return '2d';
}
const capOf = (painter) => (painter === 'gpu' ? P.caps.gpu : P.caps['2d']);
const labelOf = (painter) => (painter === 'gpu' ? 'GPU painter'
    : painter === 'svg' ? 'SVG export (2D painter)' : '2D painter');

// What every callback a plugin has is handed, before any geometry: the
// viewer, the state Python sent, the options (defaults under the viewer's own)
// and the payloads that apply to what is drawn right now.
function selectPayloads(st, e) {
    const r = st.r;
    const names = (typeof r.drawnObjects === 'function') ? r.drawnObjects()
        : (r.currentObjectName ? [r.currentObjectName] : []);
    const out = [];
    const all = e.data.payloads;
    for (let i = 0; i < all.length; i++) {
        const p = all[i] || {};
        const obj = p.object == null ? null : p.object;
        if (obj !== null && names.indexOf(obj) < 0) continue;
        if (p.frame != null) {
            const nm = obj !== null ? obj : r.currentObjectName;
            const f = (nm === r.currentObjectName || typeof r._parkedFrameIndex !== 'function')
                ? r.currentFrame : r._parkedFrameIndex(nm);
            if (f !== p.frame) continue;
        }
        out.push({ object: obj, frame: p.frame == null ? null : p.frame,
            payload: p.payload, index: i });
    }
    return out;
}

function optionsOf(e) {
    return Object.assign({}, (e.def && e.def.options) || {}, e.data.options);
}

function ctxBase(st, e) {
    const r = st.r;
    return { renderer: r, host: hostOf(st), instance: e.inst, name: e.name,
        version: e.data.version, apiVersion: e.data.apiVersion,
        options: optionsOf(e), payloads: selectPayloads(st, e), frame: r.currentFrame,
        maxPrims: Math.min(P.caps['2d'], P.caps.gpu) };
}

// HOW FAR FROM THE VIEW CENTRE A POINT MAY BE before it is refused: fifty times
// the structure's own extent (and never less than 500 A). A coordinate that is
// finite and absurd - 1e30 - is as bad for the GPU's depth range as Infinity:
// it would stretch the range until the cartoon collapsed into one depth step.
function reachOf(r, object) {
    const ds = (typeof r.drawnStats === 'function') ? r.drawnStats() : null;
    const ext = (ds && ds.maxExtent > 0) ? ds.maxExtent
        : ((object && object.maxExtent > 0) ? object.maxExtent : 30);
    return 50 * Math.max(ext, 10);
}
const finite3 = (p) => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);

// MODEL -> VIEW FOR ONE OBJECT: its alignment, then the object's own rotation
// and the viewer's (renderer._modelToView). `name` picks whose alignment; the
// default is the object being drawn.
function viewMapper(r, object, c) {
    const R = r._rotationCtx(object, c);
    const xfCache = {};
    const xfOf = (name) => {
        if (name == null || name === r.currentObjectName) return object ? object.alignTransform || null : null;
        if (!(name in xfCache)) {
            const o = r.objectsData && r.objectsData[name];
            xfCache[name] = (o && o.alignTransform) || null;
        }
        return xfCache[name];
    };
    return (p, name) => r._modelToView(p, R, xfOf(name));
}

// ------------------------------------------------------------------ API ----

// A REFUSAL IS THE SAME WHEREVER IT HAPPENS: recorded in `rejected`, said once on
// the console, and null back - never a throw. A direct register() and a
// definition parked before the bundle must behave alike, and a throw at load
// time would kill the whole bundle.
function register(def) {
    let problem = null;
    if (!def || typeof def !== 'object') problem = 'register() takes a plugin object';
    else if (typeof def.name !== 'string' || !def.name) problem = 'a plugin needs a string `name`';
    else if (def.apiVersion === undefined) {
        problem = 'plugin "' + def.name + '" declares no apiVersion - it must say which plugin'
            + ' API (' + PLUGIN_API_VERSION + ' here) it was written against';
    } else if (def.apiVersion !== PLUGIN_API_VERSION) {
        problem = 'plugin "' + def.name + '"' + (def.version ? ' (version ' + def.version + ')' : '')
            + ' declares apiVersion ' + def.apiVersion + ', but this py2Dmol core provides plugin'
            + ' API version ' + PLUGIN_API_VERSION + ', so it was NOT registered and draws nothing.'
            + (def.apiVersion > PLUGIN_API_VERSION
                ? ' The plugin is newer than this core: update py2Dmol.'
                : ' The plugin is older than this core: update the plugin.');
    } else if (typeof def.prims !== 'function') {
        problem = 'plugin "' + def.name + '" has no prims(ctx) function';
    }
    if (problem) {
        if (!P.rejected.some((x) => x.name === (def && def.name) && x.message === problem)) {
            P.rejected.push({ name: def && def.name, message: problem });
        }
        if (!core.logged.has(problem)) {
            core.logged.add(problem);
            if (typeof console !== 'undefined') console.error('py2Dmol: ' + problem);
        }
        return null;
    }
    const at = P.list.findIndex((x) => x.name === def.name);
    if (at >= 0) {
        // The same plugin arriving twice - one inline script per viewer on a
        // page - is not an event. A different VERSION under the same name is,
        // and replaces the old one in place.
        if (P.list[at] === def || P.list[at].version === def.version) return P.list[at];
        if (typeof console !== 'undefined') {
            console.warn('py2Dmol: plugin "' + def.name + '" replaced: version '
                + P.list[at].version + ' -> ' + def.version);
        }
        P.list[at] = def;
    } else {
        P.list.push(def);
    }
    P.rejected = P.rejected.filter((x) => x.name !== def.name);
    // LATE REGISTRATION REACHES EVERY VIEWER ALREADY UP: bind the plugin where
    // the viewer has a payload for it, then draw that viewer again. A viewer
    // that has not drawn yet needs nothing - it binds on its first frame.
    const still = [];
    for (const ref of core.live) {
        const r = hasWeakRef ? ref.deref() : ref;
        if (!r) continue;
        still.push(ref);
        const st = states.get(r);
        if (!st) continue;
        const e = st.entries.get(def.name);
        if (!e) continue;
        bindDef(st, def);
        try { r.render('plugin registered'); } catch (err) { /* a viewer mid-load */ }
    }
    core.live = still;
    return def;
}

P.register = register;

// A plugin registered before this file ran, on the stub.
for (const def of P.pending.splice(0)) register(def);

// WHAT THE PLUGINS OF ONE VIEWER CONTRIBUTE TO ITS GEOMETRY KEY: a short
// string that moves whenever anything a plugin would draw moves - its payload,
// its options, which payloads apply to this frame, its own key(), and the GPU
// cap a plugin is held to. The GPU rebuilds its mesh only when the signature
// changes (cartoon/paintgl.js sharedGeometryKey), so a plugin whose state is
// not in here never appears. Error states are NOT in it: they are a fact about
// one painter, and an SVG export that overran must not make the next GPU frame
// look like a different mesh. Empty for a viewer with no plugin, which leaves
// the signature as it was.
// The options as a string, once per revision: every way an option changes
// (setOption, setPayload, a late bind) bumps `rev`, and this is asked on every
// frame - by the GPU's signature and again by the fit-to-view.
function optionsKey(e) {
    if (e.optRev !== e.rev) { e.optStr = JSON.stringify(e.data.options); e.optRev = e.rev; }
    return e.optStr;
}

P.key = function (r) {
    if (!r) return '';
    const st = stateFor(r);
    if (!st.entries.size) return '';
    let s = '';
    for (const e of st.entries.values()) {
        if (!e.def) continue;
        let own = '';
        if (typeof e.def.key === 'function') {
            try { own = String(e.def.key(ctxBase(st, e))); } catch (err) { fail(st, e, err, 'load'); }
        }
        s += e.name + '~' + (e.def.version || '') + '~' + e.rev + '~'
            + optionsKey(e) + '~'
            + selectPayloads(st, e).map((x) => x.index).join(',') + '~' + own + ';';
    }
    return s ? s + 'cap' + P.caps.gpu : '';
};

// THE SEAM, called from cartoon/geom.js's render() after the depth range and
// before the filters and the sort. `g` is what geometry has that a plugin needs
// and cannot build itself: the projection and the lighting (and the context,
// which says whether this is an export). Pushes onto g.prims and returns how
// many it added.
P.collect = function (g) {
    const r = g.renderer;
    const st = stateFor(r);
    if (!st.entries.size) return 0;
    const painter = painterOf(r, g.ctx);
    const cap = capOf(painter);
    const reach = reachOf(r, g.object);
    let added = 0;
    const c = r._computeViewCentre(g.object) || { x: 0, y: 0, z: 0 };
    const toView = viewMapper(r, g.object, c);
    for (const e of st.entries.values()) {
        if (!e.def) continue;
        // Collected into a list of its own, appended only on success: a plugin
        // that throws half way through - or overruns its cap - adds NOTHING.
        const out = [];
        let count = 0;
        let refused = 0;
        const bump = () => {
            if (++count > cap) {
                throw new PluginBudgetError(e.name, cap, labelOf(painter), P.caps);
            }
        };
        // A VIEW-SPACE POINT THE PAINTERS CAN HOLD: finite, and not absurdly far.
        const place = (p, name) => {
            if (!finite3(p)) return null;
            const v = toView(p, name);
            if (!finite3(v) || v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > reach * reach) return null;
            return v;
        };
        const base = ctxBase(st, e);
        const ctx = Object.assign(base, {
            maxPrims: cap, painter, scale: g.scale, persp: g.persp,
            displayWidth: g.displayWidth, displayHeight: g.displayHeight,
            toView, project: g.project,
            // a straight stroke between two MODEL-space points. `width` is in
            // Angstrom. NEAR-PLANE CLIPPING IS NOT DONE: a segment with either
            // end behind the camera (or within 0.1 A of it) is dropped whole -
            // and so is one with a coordinate that is not finite or is absurdly
            // far from the structure (counted, and reported once per frame).
            line(a, b, o) {
                o = o || {};
                const va = place(a, o.object); const vb = place(b, o.object);
                if (!va || !vb) { refused++; return false; }
                const A = g.project(va[0], va[1], va[2]); const B = g.project(vb[0], vb[1], vb[2]);
                if (!A || !B) return false;
                bump();
                const wA = o.width > 0 ? o.width : 0.35;
                out.push({ kind: 'line', pts: [A, B], x1: A[0], y1: A[1], x2: B[0], y2: B[1],
                    z: (A[2] + B[2]) / 2, w: Math.max(0.5, wA * g.scale * (A[3] + B[3]) / 2), wA,
                    zBias: 0, c: rgbOf(o.color), flat: true, pA: A, pB: B, sel: false,
                    // REQUIRED: paint2d reads g.joints[0] unconditionally when ink
                    // is on, and a line without it throws at ink time
                    joints: [null, null],
                    noInk: !o.ink, plugin: true });
                return true;
            },
            // a ball at a MODEL-space point; `radius` in Angstrom
            dot(p, o) {
                o = o || {};
                const v = place(p, o.object);
                if (!v) { refused++; return false; }
                const A = g.project(v[0], v[1], v[2]);
                if (!A) return false;
                bump();
                const rA = o.radius > 0 ? o.radius : 0.5;
                out.push({ kind: 'dot', x1: A[0], y1: A[1], z: A[2], r: rA * g.scale * A[3], rA,
                    c: rgbOf(o.color), pA: A, sel: false, noInk: !o.ink, plugin: true,
                    // no residue owns it, so no residue's visibility hides it
                    resId: -1 });
                return true;
            },
            // an OPAQUE flat triangle, from the existing `joint` prim: one
            // colour, lit by its own normal, double-sided.
            tri(a, b, cc, o) {
                o = o || {};
                const va = place(a, o.object); const vb = place(b, o.object);
                const vc = place(cc, o.object);
                if (!va || !vb || !vc) { refused++; return false; }
                const A = g.project(va[0], va[1], va[2]); const B = g.project(vb[0], vb[1], vb[2]);
                const C = g.project(vc[0], vc[1], vc[2]);
                if (!A || !B || !C) return false;
                const ux = vb[0] - va[0]; const uy = vb[1] - va[1]; const uz = vb[2] - va[2];
                const wx = vc[0] - va[0]; const wy = vc[1] - va[1]; const wz = vc[2] - va[2];
                let nx = uy * wz - uz * wy; let ny = uz * wx - ux * wz; let nz = ux * wy - uy * wx;
                const ln = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (!(ln > 1e-12)) return false;          // degenerate: nothing to draw
                // double-sided: take the normal that faces the viewer (+z)
                const sg = nz < 0 ? -1 / ln : 1 / ln;
                nx *= sg; ny *= sg; nz *= sg;
                bump();
                // ONLY `nl`: the GPU drops `unlit` on this kind of face
                out.push({ kind: 'joint', q: [A, B, C], z: (A[2] + B[2] + C[2]) / 3,
                    c: rgbOf(o.color), gs0: -1, resId: -1, sc: false, ci: undefined, half: 0,
                    nl: nx * g.light[0] + ny * g.light[1] + nz * g.light[2], two: true, face: 1,
                    noInk: true, plugin: true });
                return true;
            },
        });
        try {
            e.def.prims(ctx);
            for (let i = 0; i < out.length; i++) g.prims.push(out[i]);
            added += out.length;
            if (refused) {
                // THE PLUGIN DREW, MINUS WHAT COULD NOT BE DRAWN - and says so,
                // once per frame, in its own error state.
                fail(st, e, new Error(refused + ' primitive' + (refused === 1 ? '' : 's')
                    + ' dropped: a coordinate was not finite, or lay more than ' + reach
                    + ' A from the view centre'), painter);
            } else if (st.err[painter].delete(e.name)) {
                paintBadge(st);
            }
        } catch (err) {
            const msg = fail(st, e, err, painter);
            // AN EXPORT CANNOT SHOW A BADGE: it says it in the file it writes.
            if (painter === 'svg' && g.ctx && typeof g.ctx.comment === 'function') {
                g.ctx.comment('py2dmol plugin ' + e.name + ' not drawn: ' + msg);
            }
        }
    }
    return added;
};

// WHAT A PLUGIN ADDS TO THE FIT-TO-VIEW: a radius in Angstrom about the view
// centre, in which everything its bounds(ctx) reported lies - an axis-aligned
// box `{min:[x,y,z], max:[x,y,z]}` in MODEL space. A radius, because it has to
// be the same at every rotation or the picture would zoom as it turned.
// core/mol.js's _viewHalfSpan never lets the FITTED span be smaller than it
// (and leaves a span that orient, focus or the app has set alone).
// 0 for a viewer with no plugin (the common case: one map lookup). A box with a
// coordinate that is not finite, or absurdly far, is an error and is ignored.
P.extent = function (r, object) {
    const st = states.get(r) || (r && stateFor(r));
    if (!st || !st.entries.size) return 0;
    let any = false;
    for (const e of st.entries.values()) if (e.def && typeof e.def.bounds === 'function') any = true;
    if (!any) return 0;
    const c = r._computeViewCentre(object) || { x: 0, y: 0, z: 0 };
    const k = P.key(r) + '@' + c.x + ',' + c.y + ',' + c.z;
    if (st.extKey === k) return st.ext;
    const toView = viewMapper(r, object, c);
    const reach = reachOf(r, object);
    let rad = 0;
    for (const e of st.entries.values()) {
        if (!e.def || typeof e.def.bounds !== 'function') continue;
        try {
            const b = e.def.bounds(ctxBase(st, e));
            if (!b || !b.min || !b.max) { st.err.load.delete(e.name); continue; }
            let mine = 0;
            let badBox = false;
            for (let i = 0; i < 8; i++) {
                const p = [(i & 1) ? b.max[0] : b.min[0], (i & 2) ? b.max[1] : b.min[1],
                    (i & 4) ? b.max[2] : b.min[2]];
                const v = finite3(p) ? toView(p) : null;
                const d = v ? Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) : NaN;
                if (!(d <= reach)) { badBox = true; break; }
                if (d > mine) mine = d;
            }
            if (badBox) {
                fail(st, e, new Error('bounds() has a coordinate that is not finite or lies more than '
                    + reach + ' A from the view centre - ignored'), 'load');
            } else {
                st.err.load.delete(e.name);
                if (mine > rad) rad = mine;
            }
        } catch (err) {
            fail(st, e, err, 'load');
        }
    }
    paintBadge(st);
    st.extKey = k;
    st.ext = rad;
    return rad;
};

// Errors currently showing on a viewer: [{name, message, painter}].
P.errors = function (r) {
    const st = states.get(r);
    const out = [];
    if (!st) return out;
    for (const painter of PAINTERS) {
        for (const [name, message] of st.err[painter]) out.push({ name, message, painter });
    }
    return out;
};

// THE TUBE STYLE DRAWS NO PLUGIN: the tube never goes through cartoon/geom.js's
// render(), which is where plugins are collected. Asked by core/mol.js's render()
// on every frame, so the notice follows the style both ways: ON the viewer, in
// its badge, while a style that draws no plugin is up - a console line alone is
// invisible in a notebook, and a payload that silently draws nothing is the
// bug - and gone again once the style is one that does. A viewer with no
// payload pays one WeakMap lookup.
P.styleNotice = function (r) {
    if (!r) return;
    const st = states.get(r) || stateFor(r);
    if (!st.entries.size) return;
    const off = r.style !== 'cartoon' && r.style !== undefined;
    if (!off) {
        if (st.err.style.size) { st.err.style.clear(); paintBadge(st); }
        return;
    }
    if (st.err.style.has(r.style)) return;
    st.err.style.clear();
    const names = Array.from(st.entries.keys()).map((n) => '"' + n + '"').join(', ');
    const msg = 'plugin' + (st.entries.size > 1 ? 's ' : ' ') + names
        + ' not drawn: the "' + r.style + '" style draws no plugin geometry -'
        + ' switch to a cartoon style (richardson, ribbon or 3d)';
    st.err.style.set(r.style, msg);
    note(st, 'style:' + r.style, msg, 'warn');
    paintBadge(st);
};

// JS-side doors, for a host page that has no Python: hand a viewer a payload
// (creating its entry), or change one option. Both redraw it.
P.setPayload = function (r, name, data) {
    const st = stateFor(r);
    let e = st.entries.get(name);
    if (!e) e = addEntry(st, name, data || {});
    else {
        e.data.payloads = Array.isArray(data && data.payloads) ? data.payloads : e.data.payloads;
        if (data && data.options) Object.assign(e.data.options, data.options);
        if (data && data.version != null) e.data.version = data.version;
    }
    e.rev++;
    st.extKey = null;
    const def = P.list.find((x) => x.name === name);
    if (def) bindDef(st, def);
    try { r.render('plugin payload'); } catch (err) { /* a viewer mid-load */ }
};
// A VIEWER'S PAYLOADS AS A SESSION FILE HOLDS THEM - the shape Python's
// save_state writes under state["plugins"], so a file saved on either side opens
// on the other. A copy, through JSON: the file must not alias live state. null
// for a viewer with none, so a session without plugins writes no key at all.
P.snapshot = function (r) {
    const st = r && states.get(r);
    if (!st || !st.entries.size) return null;
    const out = {};
    for (const e of st.entries.values()) {
        out[e.name] = JSON.parse(JSON.stringify({ version: e.data.version,
            apiVersion: e.data.apiVersion, options: e.data.options, payloads: e.data.payloads }));
    }
    return out;
};

// ...AND BACK. `replace` drops the payloads the viewer had (a session load that
// replaces the scene); without it the file's entries are added beside them (an
// append). `rename` is the object renaming an append applied, so a payload bound
// to an object follows it to its new name. A plugin the page has never
// registered is kept all the same and draws when it registers - the rule
// load_state follows in Python.
P.restore = function (r, map, opts) {
    if (!r) return;
    opts = opts || {};
    const st = stateFor(r);
    if (opts.replace) {
        for (const e of st.entries.values()) {
            if (e.def && typeof e.def.dispose === 'function') {
                try { e.def.dispose({ instance: e.inst, host: hostOf(st) }); } catch (err) { /* gone */ }
            }
        }
        st.entries.clear();
        for (const p of PAINTERS) st.err[p].clear();
        st.extKey = null;
    }
    if (map && typeof map === 'object') {
        const rn = opts.rename;
        for (const name of Object.keys(map)) {
            const d = map[name];
            if (!d || typeof d !== 'object') continue;
            const payloads = (Array.isArray(d.payloads) ? d.payloads : []).map((p) => (
                p && p.object != null && rn && rn.has(p.object)
                    ? Object.assign({}, p, { object: rn.get(p.object) }) : p));
            const prev = st.entries.get(name);
            // an append adds payloads and layers the file's options over the
            // viewer's, the way add_plugin merges options in Python
            const keep = !opts.replace && prev;
            const e = addEntry(st, name, Object.assign({}, d, {
                payloads: keep ? prev.data.payloads.concat(payloads) : payloads,
                options: keep ? Object.assign({}, prev.data.options, d.options || {}) : d.options }));
            if (prev) e.rev = prev.rev + 1;
            const def = P.list.find((x) => x.name === name);
            if (def) bindDef(st, def);
        }
    }
    paintBadge(st);
    try { r.render('plugin restore'); } catch (err) { /* a viewer mid-load */ }
};

P.setOption = function (r, name, key, value) {
    const st = stateFor(r);
    const e = st.entries.get(name);
    if (!e) throw new Error('py2Dmol: viewer has no payload for plugin "' + name + '"');
    e.data.options[key] = value;
    e.rev++;
    st.extKey = null;
    try { r.render('plugin option'); } catch (err) { /* a viewer mid-load */ }
};
})();
