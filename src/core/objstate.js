// ============================================================================
// src/core/objstate.js
// ----------------------------------
// AI Context: WHAT AN OBJECT REMEMBERS (OBJECT_STATE, ligandGroupsForFrame)
// - The registry of every per-object field that is keyed by position index,
//   and the six things each field has to survive: a merge reading it up into
//   merged indices, a write coming back down, an edit renumbering it, a session
//   saving and restoring it, a Copy carrying it across, a Delete renumbering it
//   in place. Each of those was once written out field by field, which is six
//   places to forget one - and they were forgotten, repeatedly.
// - Plus the per-FRAME ligand grouping cache, which is here for the same
//   reason: it is state derived from a structure rather than from a drawing.
// - Module scope on purpose. core/mol.js's class reads OBJECT_STATE and the
//   remappers from inside method bodies, so this file only has to be loaded
//   before anything runs, not before core/mol.js parses.
// ============================================================================

/**
 * WHICH ATOMS MAKE UP ONE LIGAND, keyed by the FRAME they were read from.
 *
 * This used to be computed once in addFrame and stored on the object, which
 * made it a fact that had to be maintained: every path that rewrote the frames
 * had to remember to recompute it, and Delete did not - so after cutting a
 * chain out, the ligands that were left pointed at whatever had moved into
 * their slots, drew as loose spheres and stopped collapsing to one token in
 * the sequence strip.
 *
 * It is not a fact about an object. It is a function of a frame - chain,
 * residue number and name - so it is computed from one and cached against it.
 * An edit builds NEW frame objects (see _subsetFrames), so the answer for them
 * is computed fresh the first time anything asks, and there is no invalidation
 * to forget. The WeakMap lets the cache go when the frame does.
 */
const LIGAND_GROUPS_BY_FRAME = new WeakMap();
const NO_LIGAND_GROUPS = new Map();

function ligandGroupsForFrame(frame) {
    if (!frame || typeof groupLigandAtoms !== 'function') return NO_LIGAND_GROUPS;
    if (!frame.chains || !frame.position_types) return NO_LIGAND_GROUPS;
    let g = LIGAND_GROUPS_BY_FRAME.get(frame);
    if (!g) {
        g = groupLigandAtoms(frame.chains, frame.position_types,
            frame.residue_numbers || [], frame.position_names || []);
        LIGAND_GROUPS_BY_FRAME.set(frame, g);
    }
    return g;
}

// >>> OBJECT_STATE BEGIN
//
// THE MARKERS ARE LOAD-BEARING. tests/interaction.js and tests/copy_selection.js
// both evaluate this whole region - the table AND its remappers - to score the
// shipped list rather than a copy of it. They used to slice it out as
// "everything between `const OBJECT_STATE = [` and `function
// initializePy2DmolViewer(`", which quietly required the table to sit
// immediately before the factory and nothing to be inserted between the two.
// The markers say that out loud, and survive the region moving to a file of its
// own. See tests/lift.js `between`.
/**
 * EVERY PIECE OF PER-OBJECT STATE THAT IS KEYED BY POSITION INDEX.
 *
 * All of it means nothing except against the object it was set on, and all of
 * it has to survive the same six things: a merge reading it up into merged
 * indices, a write coming back down, an edit renumbering it, a session saving
 * and restoring it. Each of those was written out field by field, so each was
 * a place to forget one - and they were forgotten, repeatedly: a Copy that
 * carried no colours, a Delete that left the ligand bonds pointing at whatever
 * had moved into their slots.
 *
 * The list is here, once. `absent` is what a MISSING value means, which is not
 * the same for all of them - no side chains are shown by default, while every
 * base and every element is - and getting it backwards inverts the feature.
 * `remap` is how an edit renumbers it; the ones without a remap say why.
 *
 * When you add a per-object field, add it here. tests/copy_selection.js fails
 * until you do.
 */
const OBJECT_STATE = [
    { key: 'sidechains', kind: 'set', absent: 'none', json: 'sidechains',
        remap: remapPositionSet },
    { key: 'bases', kind: 'set', absent: 'all', json: 'bases',
        remap: remapPositionSet },
    { key: 'elements', kind: 'set', absent: 'all', json: 'elements',
        remap: remapPositionSet },
    { key: 'hiddenBackbone', kind: 'set', absent: 'none', json: 'hidden_backbone',
        remap: remapPositionSet },
    // position -> letter, and position -> colour
    { key: 'sse', kind: 'plain', absent: 'none', json: 'sse',
        remap: remapPositionMap },
    { key: 'sidechainColor', kind: 'plain', absent: 'none', json: 'sidechain_color',
        remap: remapPositionMap },
    // only the `position` map inside the tree is keyed by index
    { key: 'color', kind: 'plain', absent: 'none', json: 'color',
        remap: remapColorTree },
    // [i, j, ...] indices, or [chain, res, chain, res, ...] names
    { key: 'contacts', kind: 'plain', absent: 'none', json: 'contacts',
        remap: remapContacts },
    // [i, j] only - the object's fallback list for frames carrying none.
    // json:null because it is NOT saved here: bonds travel with the frames,
    // and the object's list is rebuilt from them on load.
    { key: 'bonds', kind: 'plain', absent: 'none', json: null,
        remap: remapIndexPairs },
    // NOT REMAPPED, deliberately: a copy starts fully visible rather than
    // inheriting what was hidden in the original, and Delete renumbers the
    // record in place (it is the one piece of this that has a live twin).
    // Saved by hand too - it is four fields, not a set, and two of them are
    // renamed on the way out.
    { key: 'visibilityState', kind: 'plain', absent: 'all', json: null,
        remap: null },
    // WHERE AN ALIGNMENT PUT THE OBJECT: {t[3], u[9]}, applied on the way to
    // the screen (see _transformedFrame). The ONE field here that is not keyed
    // by position, so it is carried across a copy WHOLE rather than renumbered
    // - and it has to be carried, because a Cut reads the raw frames: without
    // it the piece you just cut out of an aligned structure would jump back to
    // where its file put it, on its own, with nothing said.
    { key: 'alignTransform', kind: 'plain', absent: 'none', json: 'align_transform',
        remap: remapWhole },
];

/** Carried across unchanged: this one is not keyed by position. */
function remapWhole(v) {
    return v === undefined ? undefined : v;
}

/** A Set of positions. An EMPTY result is not the same as an absent one. */
function remapPositionSet(set, ctx) {
    if (!(set instanceof Set)) return undefined;
    const out = new Set();
    for (const i of set) {
        const to = ctx.map.get(i);
        if (to !== undefined) out.add(to);
    }
    return out;
}

/** A plain object keyed by position. Empty collapses to null. */
function remapPositionMap(src, ctx) {
    if (!src) return undefined;
    const out = {};
    for (const k of Object.keys(src)) {
        const to = ctx.map.get(Number(k));
        if (to !== undefined) out[to] = src[k];
    }
    return Object.keys(out).length ? out : null;
}

/**
 * COLOUR. Only the `position` map inside it is keyed by index; the rest of the
 * structure - an object-wide mode or literal the per-residue colours sit on
 * top of - is not, and is carried through untouched so a copy keeps the same
 * base to override.
 */
function remapColorTree(color, ctx) {
    if (!color) return undefined;
    if (color.type !== 'advanced' || !color.value) return color;
    const value = { ...color.value };
    if (value.position) {
        const out = remapPositionMap(value.position, ctx);
        if (out) value.position = out;
        else delete value.position;
    }
    return Object.keys(value).length ? { type: 'advanced', value } : null;
}

/** [i, j, ...rest] where i and j are positions. */
function remapIndexPairs(list, ctx) {
    if (!Array.isArray(list) || !list.length) return undefined;
    const kept = [];
    for (const c of list) {
        if (!Array.isArray(c)) continue;
        const a = ctx.map.get(c[0]);
        const b = ctx.map.get(c[1]);
        if (a === undefined || b === undefined) continue;
        kept.push(c.length > 2 ? [a, b, ...c.slice(2)] : [a, b]);
    }
    return kept.length ? kept : null;
}

/**
 * Contacts come in two shapes. [i, j, w, colour?] is indices and renumbers;
 * [chain, res, chain, res, w, colour?] names residues and survives a copy
 * untouched - but only if both of its ends came with it, or it resolves to
 * nothing on every frame load and warns to the console for the life of the
 * object.
 */
function remapContacts(list, ctx) {
    if (!Array.isArray(list) || !list.length) return undefined;
    const r = ctx.renderer;
    const survives = new Set();
    for (const i of ctx.selected) {
        const chain = r.chains && r.chains[i];
        const res = r.residueNumbers && r.residueNumbers[i];
        if (chain !== undefined && res !== undefined) survives.add(chain + ':' + res);
    }
    const kept = [];
    for (const c of list) {
        if (!Array.isArray(c)) continue;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
            const a = ctx.map.get(c[0]);
            const b = ctx.map.get(c[1]);
            if (a === undefined || b === undefined) continue;
            kept.push([a, b, ...c.slice(2)]);
        } else if (typeof c[0] === 'string' && c.length >= 4) {
            if (!survives.has(c[0] + ':' + c[1])) continue;
            if (!survives.has(c[2] + ':' + c[3])) continue;
            kept.push(c.slice());
        }
    }
    return kept.length ? kept : null;
}

/** What an absent value means for one field, from the table. */
function objectStateAbsent(key) {
    const e = OBJECT_STATE.find((f) => f.key === key);
    return e ? e.absent : 'none';
}

/**
 * ONE OBJECT'S POSITION-KEYED STATE, ready for JSON.
 *
 * The save rule follows from `absent`, and this is why the field list carries
 * it: a set whose absence means ALL has to be written even when it is EMPTY,
 * because empty means "none of them" and leaving it out means "all of them" -
 * the opposite. A set whose absence means NONE is only worth writing when it
 * has something in it.
 */
function objectStateToJSON(object) {
    const out = {};
    if (!object) return out;
    for (const f of OBJECT_STATE) {
        if (!f.json) continue;
        const v = object[f.key];
        if (f.kind === 'set') {
            if (!(v instanceof Set)) continue;
            if (f.absent === 'none' && !v.size) continue;
            out[f.json] = Array.from(v);
        } else if (v) {
            out[f.json] = v;
        }
    }
    return out;
}

/** ...and back, onto an object. The inverse of objectStateToJSON. */
function objectStateFromJSON(object, saved) {
    if (!object || !saved) return;
    for (const f of OBJECT_STATE) {
        if (!f.json) continue;
        const v = saved[f.json];
        if (v === undefined || v === null) continue;
        if (f.kind === 'set') {
            if (Array.isArray(v)) object[f.key] = new Set(v);
        } else {
            object[f.key] = v;
        }
    }
}
// <<< OBJECT_STATE END
