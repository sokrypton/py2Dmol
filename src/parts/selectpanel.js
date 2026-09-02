// ============================================================================
// src/parts/selectpanel.js
// -----------------------
// AI Context: WHAT IS SELECTED, AND WHAT THE PANEL DOES WITH IT
// - The selection panel's verbs: colour, secondary structure, side chains,
//   elements, bases, contacts, visibility, Find interactions, Align. Plus the
//   state readers the panel syncs from - getActiveSelection, visibleState,
//   syncSelectionToggles, updateSelectionToolsState.
// - It lived under src/app/, which put it out of reach of the notebook and
//   the embed - the same gap clip, orient, focus and the side-chain set each
//   came home from. free_vars.js measured it at ZERO enclosing-scope locals,
//   closing over nothing but the status bar and the app's viewer handle, so
//   the move was those two names and nothing else.
// - THE SHELL SAYS WHERE THE VIEWER IS. py2dmolSelectionHost({renderer,
//   setStatus}) is how: the website passes its own viewer getter and its
//   status bar; a shell with no status bar passes nothing and the messages go
//   nowhere. A GETTER rather than a renderer, because the website replaces its
//   handle when a viewer is rebuilt and a captured reference would go on
//   editing the dead one.
// - Every one of these looks its own DOM up by id, which is what makes it
//   portable at all: the ids are parts/panel.js's now, so whichever shell
//   mounted the panel is the one it finds.
// ============================================================================

// The shell's two couplings, defaulted so the file is usable with neither.
let selectionHost = {
    renderer: () => null,
    setStatus: () => {},
    // ...and what else on the page follows a selection. On the website that is
    // the MSA, which dims to it; a shell without one passes nothing.
    afterChange: () => {},
    // 🔴 AND WHERE THIS VIEWER'S PANEL IS. Every control here is found by id,
    // which is right - the ids are parts/panel.js's - and `document` is the
    // wrong place to look for them the moment a page holds two viewers with
    // chrome. embed.html holds exactly that, and a click in the controls
    // example drove the PLAY example's panel five sections up the page:
    // getElementById answers with the first in document order, so one viewer's
    // click opened another's panel and its own stayed shut. From the reader's
    // seat, clicking did nothing.
    //
    // The third time this file has been written: the sequence strip and the MSA
    // are still document-scoped and cross-talk the same way. The PAE panel is
    // the pattern - scope to the container, fall back to the document - and it
    // is what this follows.
    root: null,
};

/**
 * One control of THIS viewer's panel.
 *
 * Falls back to the document when no root was named, which is every caller
 * that existed before the panel was shared and is still right for a page with
 * one viewer on it.
 */
function byId(id) {
    const root = selectionHost.root;
    return (root ? root.querySelector('#' + CSS.escape(id)) : null)
        || document.getElementById(id);
}
function py2dmolSelectionHost(h) {
    selectionHost = { ...selectionHost, ...h };
}

function getActiveSelection() {
    const renderer = selectionHost.renderer();
    if (!renderer || !renderer.currentObjectName) return null;
    // A drag records a selection and leaves visibility alone, so the
    // selection - not the visible set - is what the tools act on.
    const t = renderer.residueSelection;
    return (t && t.size) ? Array.from(t) : null;
}

// Write into the object's existing colour structure, in the SAME shape
// Python's set_color(position=...) produces: {type:'advanced', value:
// {position:{idx: colour}}}. One representation means a colour set here is
// indistinguishable from one set in Python, saves with the object, and is
// understood by resolveColorHierarchy without any new code path.
function setSelectionColor(positions, color) {
    const renderer = selectionHost.renderer();
    if (!renderer) return;
    // EACH OBJECT'S OWN MAP, IN ITS OWN NUMBERING. A selection can reach
    // two objects when several are on screen, and the colour is stored
    // against the object - so writing merged indices into the current one
    // would colour its residues instead of the ones that were picked.
    const groups = renderer.writeGroups
        ? renderer.writeGroups(positions)
        : [{ object: renderer.objectsData?.[renderer.currentObjectName],
            positions: Array.from(positions) }];
    for (const g of groups) {
        const obj = g.object;
        if (!obj) continue;
        let value = {};
        if (obj.color && obj.color.type === 'advanced' && obj.color.value) {
            value = obj.color.value;
        } else if (obj.color && obj.color.type === 'mode') {
            // preserve an object-wide mode as the base the overrides sit on
            value = { object: obj.color.value };
        } else if (obj.color && obj.color.type === 'literal') {
            value = { object: obj.color.value };
        }
        if (!value.position) value.position = {};
        for (const i of g.positions) {
            if (color === null) delete value.position[i];
            else value.position[i] = color;
        }
        if (Object.keys(value.position).length === 0) delete value.position;
        obj.color = Object.keys(value).length ? { type: 'advanced', value } : null;
    }
    renderer.colorsNeedUpdate = true;
    renderer.plddtColorsNeedUpdate = true;
    document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
    renderer.render('selection colour');
}

// SIDE-CHAIN COLOUR, kept apart from `color` and keyed by RESIDUE.
//
// It cannot go in the ordinary position colour map: side-chain atoms are
// positions only while they are being drawn, and their indices are handed
// out afresh every time the set changes, so a colour stored against one
// would come back pointing at a different atom. The residue index is the
// stable name for "this side chain", so that is what it is stored under,
// and the renderer resolves an atom's colour through its owner.
//
// Unset means FOLLOW THE RESIDUE, which is why this is a separate map
// rather than a copy of the residue's colour taken at the time: recolour
// the main chain and side chains that were never given their own colour
// come along, which is what you would expect of a part of the same residue.
function setSelectionSidechainColor(positions, color) {
    const renderer = selectionHost.renderer();
    if (!renderer) return;
    // THE WRITE IS THE RENDERER'S - this was the fourth copy of the same walk,
    // and the same thing happened here as with the side chains themselves:
    // moving the verb to the renderer gave the notebook and the embed a door
    // and left the website's own copy where it was because it worked. What
    // stays here is the panel's part, which is the EVENT: the swatches and the
    // sequence strip rebuild off it, and the renderer has no business
    // dispatching a document-scoped bus that would fire once per viewer.
    renderer.setSidechainColor(color, Array.from(positions));
    document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
}

// Secondary structure override. Lives on the renderer as a plain
// index -> letter map; cartoon/geom.js applies it to BOTH the geometry
// and the colour pass, and its contents are part of the SS cache key so an
// edit invalidates cleanly.
function setSelectionSse(positions, letter) {
    const renderer = selectionHost.renderer();
    if (!renderer) return;
    // Stored on the OBJECT as `sse`, exactly where set_color puts `color`
    // and where Python's set_sse writes. It used to live on the renderer,
    // which meant it was not object-scoped: its position indices would be
    // reinterpreted against whatever object became current. Written per
    // owning object for the same reason, now that a selection can reach
    // more than one of them at a time.
    for (const g of (renderer.writeGroups ? renderer.writeGroups(positions)
        : [{ object: renderer.objectsData?.[renderer.currentObjectName],
            positions: Array.from(positions) }])) {
        const obj = g.object;
        if (!obj) continue;
        const ov = obj.sse ? { ...obj.sse } : {};
        for (const i of g.positions) {
            if (letter === null) delete ov[i];
            else ov[i] = letter;
        }
        obj.sse = Object.keys(ov).length ? ov : null;
    }
    // the ribbon profile is built from sec, so the cached geometry has to go
    if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
    renderer.colorsNeedUpdate = true;
    document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
    renderer.render('selection structure');
}

// CONTACTS, between exactly two residues. Stored on the object as
// `contacts`, which already existed and is already saved and restored - the
// renderer turns each entry into a segment of type 'C'. Written in the
// CHAIN + RESIDUE form rather than as position indices: indices are a
// property of the current frame's arrays, and a copied sub-structure
// renumbers them, while a chain and residue number name the same pair
// whatever happens to the arrays.
//
// A contact is a line between a PAIR, so all of this needs exactly two
// residues; the row is not offered otherwise.
const contactKeyOf = (positions) => {
    const renderer = selectionHost.renderer();
    if (!renderer || !renderer.chains || positions.length !== 2) return null;
    const [a, b] = positions;
    const rn = renderer.residueNumbers;
    if (!rn || rn[a] === undefined || rn[b] === undefined) return null;
    return [renderer.chains[a], rn[a], renderer.chains[b], rn[b]];
};
/**
 * WHICH OBJECT A CONTACT BELONGS TO - and null when the pair spans two.
 *
 * A contact is stored on an object as a pair of chain+residue references,
 * and the renderer resolves it among THAT object's positions. A pair with
 * one end in each of two structures has nowhere to live: stored on either
 * one, the other end resolves to nothing and the line never appears. The
 * panel refuses it out loud instead - see the contact row.
 */
const contactOwnerOf = (positions) => {
    const renderer = selectionHost.renderer();
    if (!renderer || !positions || positions.length !== 2) return null;
    if (!renderer.ownerOf) return renderer.currentObjectName;
    const a = renderer.ownerOf(positions[0]);
    const b = renderer.ownerOf(positions[1]);
    const an = a ? a.name : renderer.currentObjectName;
    const bn = b ? b.name : renderer.currentObjectName;
    return (an && an === bn) ? an : null;
};
/** ...and the pair in that object's own numbering, for the index form. */
const contactLocalPair = (positions) => {
    const renderer = selectionHost.renderer();
    if (!renderer || !renderer.ownerOf) return positions;
    return positions.map((i) => {
        const o = renderer.ownerOf(i);
        return o ? o.local : i;
    });
};
// Does this stored contact name that pair? Either way round: a contact has
// no direction, and the user may have selected the two in any order.
//
// BOTH STORED FORMS. parseContactsFile writes the same entries the panel
// does, and it has two: "A 10 B 50 0.5" and the bare-index "10 50 0.5".
// Understanding only the first made a file written in indices invisible
// here - clicking the pair offered Add and made a duplicate, while Remove,
// colour and width all failed to find it. The panel keeps WRITING the chain
// form, which survives renumbering; it just has to read both.
const contactMatches = (c, key, positions) => {
    if (!Array.isArray(c) || c.length < 3) return false;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        if (!positions || positions.length !== 2) return false;
        // ...IN THE OBJECT'S OWN NUMBERING. The stored indices are that
        // object's; the positions handed in are the renderer's, and with
        // several objects merged those are not the same numbers.
        const [p1, p2] = contactLocalPair(positions);
        return (c[0] === p1 && c[1] === p2) || (c[0] === p2 && c[1] === p1);
    }
    if (c.length < 4 || typeof c[0] !== 'string') return false;
    return (c[0] === key[0] && c[1] === key[1] && c[2] === key[2] && c[3] === key[3])
        || (c[0] === key[2] && c[1] === key[3] && c[2] === key[0] && c[3] === key[1]);
};
// WHERE THE WEIGHT AND COLOUR SIT depends on the form. "A 10 B 50 0.5 red"
// puts them at 4 and 5; the bare-index "10 50 0.5 red" at 2 and 3. Reading
// both forms and then writing to the chain form's slots would have put a
// colour where the index form keeps nothing and left a hole behind it.
const contactSlots = (c) => ((typeof c[0] === 'number' && typeof c[1] === 'number')
    ? { w: 2, col: 3 } : { w: 4, col: 5 });
const findContact = (positions) => {
    const renderer = selectionHost.renderer();
    const owner = contactOwnerOf(positions);
    const obj = owner ? renderer?.objectsData?.[owner] : null;
    const key = contactKeyOf(positions);
    if (!obj || !key || !Array.isArray(obj.contacts)) return null;
    const i = obj.contacts.findIndex((c) => contactMatches(c, key, positions));
    return i < 0 ? null : { obj, key, i };
};
const commitContacts = (renderer, obj, contacts) => {
    obj.contacts = contacts.length ? contacts : null;
    // A RELOAD, not a repaint. Contacts become segments, and the segment
    // list - contact block included - is built inside setCoords, not inside
    // render. Invalidating the cache and repainting therefore changes
    // nothing at all: the contact is stored correctly, resolves correctly,
    // and never appears. Same trap the side-chain toggle hit.
    if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
    if (renderer.reloadDrawn) renderer.reloadDrawn();
    renderer.render('selection contact');
    if (window.updateSelectionToolsState) window.updateSelectionToolsState();
};
/** One end as an address - which is just a selector that names one residue. */
const contactAddressOf = (i) => {
    const renderer = selectionHost.renderer();
    const o = renderer.ownerOf ? renderer.ownerOf(i) : null;
    return {
        object: o ? o.name : renderer.currentObjectName,
        chain: renderer.chains[i],
        residues: [renderer.residueNumbers[i]],
    };
};
/**
 * A CONTACT BETWEEN TWO STRUCTURES, which used to be refused here.
 *
 * "there is nowhere to store it" was true: a contact lived on an object and
 * both of its ends were resolved inside that object's slice of the merged
 * array, so one end in each of two structures could not be written down. The
 * renderer has a viewer-level list now, whose ends are addresses rather than
 * indices - and an address names the object, so there is no slice to be inside.
 */
function addCrossObjectContact(positions) {
    const renderer = selectionHost.renderer();
    const ends = positions.map(contactAddressOf);
    const same = (a, b) => a.object === b.object && a.chain === b.chain
        && a.residues[0] === b.residues[0];
    const already = (renderer.crossContacts || []).some((c) =>
        (same(c[0], ends[0]) && same(c[1], ends[1]))
        || (same(c[0], ends[1]) && same(c[1], ends[0])));
    if (already) return;
    renderer.crossContacts = (renderer.crossContacts || []).concat([
        [ends[0], ends[1], 1.0],
    ]);
    if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
    if (renderer.reloadDrawn) renderer.reloadDrawn();
    renderer.render('cross contact');
    if (window.updateSelectionToolsState) window.updateSelectionToolsState();
}
function addSelectionContact(positions) {
    const renderer = selectionHost.renderer();
    const owner = contactOwnerOf(positions);
    if (!owner) {
        addCrossObjectContact(positions);
        return;
    }
    const obj = renderer?.objectsData?.[owner];
    const key = contactKeyOf(positions);
    if (!obj || !key) return;
    const contacts = Array.isArray(obj.contacts) ? obj.contacts.slice() : [];
    if (contacts.some((c) => contactMatches(c, key, positions))) return;  // already there
    // Weight 1, and no colour - which the renderer draws as its default
    // yellow. Left off rather than written in, so a contact that was never
    // given a colour keeps following that default if it ever changes.
    contacts.push([key[0], key[1], key[2], key[3], 1.0]);
    commitContacts(renderer, obj, contacts);
}
function removeSelectionContact(positions) {
    const found = findContact(positions);
    if (!found) return;
    const contacts = found.obj.contacts.slice();
    contacts.splice(found.i, 1);
    commitContacts(selectionHost.renderer(), found.obj, contacts);
}
// The stored colour is an {r,g,b} object, which is what the segment builder
// reads straight through as contactColor.
function setSelectionContactColor(positions, hex) {
    const found = findContact(positions);
    if (!found) return;
    const contacts = found.obj.contacts.slice();
    const c = contacts[found.i].slice();
    const sl = contactSlots(c);
    c[sl.w] = typeof c[sl.w] === 'number' ? c[sl.w] : 1.0;
    if (hex === null) c.length = sl.col;
    else {
        c[sl.col] = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16),
            b: parseInt(hex.slice(5, 7), 16) };
    }
    contacts[found.i] = c;
    commitContacts(selectionHost.renderer(), found.obj, contacts);
}

// Per-contact WIDTH, which is the entry's existing weight slot - the
// renderer already scales a contact's stroke by contactWeight, so this
// needs nothing new in the drawing, only a control.
function setSelectionContactWidth(positions, w) {
    const found = findContact(positions);
    if (!found) return;
    const contacts = found.obj.contacts.slice();
    const c = contacts[found.i].slice();
    c[contactSlots(c).w] = w;
    contacts[found.i] = c;
    commitContacts(selectionHost.renderer(), found.obj, contacts);
}

// SIDE CHAINS, per residue. Stored on the OBJECT as `sidechains`, a Set of
// position indices, exactly where `color` and `sse` live and for the same
// reason: position indices only mean anything against the object they were
// set on, so putting this on the renderer would reinterpret them the moment
// another object became current.
//
// Nothing is computed here. The atoms were captured at load
// (buildSidechainTable in src/io/parse.js), so this only ever writes down WHICH
// residues; a structure with no side-chain data simply draws nothing.
function setSelectionSidechains(positions, on) {
    const renderer = selectionHost.renderer();
    if (!renderer) return;
    if (on && !renderer.sidechains) {
        selectionHost.setStatus('No side-chain atoms in this structure (a backbone-only model has none).');
        return;
    }
    // 🔴 THE RENDERER'S OWN VERB, parts/sidechains.js. This was the FOURTH
    // copy of it - the same writeGroups walk, the same invalidate, the same
    // reloadDrawn - written out here because the website had it first. The
    // others were parts/embed.js's (gone), the notebook's (there was none:
    // view(sidechains=True) carried the atoms and nothing could ask for them
    // to be drawn) and now Python's show_sidechains(). Four spellings of one
    // action is how they drift, and every entry in CLAUDE.md's list of those
    // began as a copy that "did the same thing".
    //
    // positionsFor takes a Set as positions, so what the panel has is what the
    // verb wants; the check above stays because the panel says it in the
    // status bar where the verb throws.
    if (typeof renderer._setSidechains === 'function') {
        renderer._setSidechains(positions, on);
    }
}

// WHAT THE TOGGLES SHOW. Each reflects the selection it applies to, so a
// press is never a guess about the current state - which the +/- pairs it
// replaced could not do at all: a selection already showing its side chains
// looked exactly like one that was not.
//
// THREE STATES, because a selection is a set. All of it has the thing, none
// of it does, or some does - and "some" is neither, so it reads
// indeterminate rather than picking a side. Clicking an indeterminate box
// checks it, so the mixture resolves by turning everything on.
// IS THIS ROW ABOUT A LIGAND? A ligand atom is a position of the file's
// own: it owns no side chain and has no base plate, so a selection made
// only of them reaches the side-chain row for one reason - its elements -
// and every control on that row then means the LIGAND rather than a side
// chain nothing in the selection has. One definition, read by the panel and
// by the handlers behind it, so the row and its controls cannot disagree
// about which of the two it is.
//
// A MIXED selection is a side-chain row. Renaming the row the moment one
// ligand atom joined a dozen residues would take the side-chain controls
// away from the residues that do have them.
function ligandRowPositions(positions) {
    const renderer = selectionHost.renderer();
    if (!renderer || !positions || !positions.length) return null;
    const t = renderer.positionTypes || [];
    const owners = renderer.sidechainOwners ? renderer.sidechainOwners() : null;
    const map = renderer.sidechainMap;
    const lig = [];
    for (const i of positions) {
        if (owners && owners.has(i)) return null;      // a residue with a side chain
        if (t[i] === 'D' || t[i] === 'R') return null; // a nucleotide has a plate
        // ...and an APPENDED side-chain atom is type 'L' too, but it
        // belongs to a residue and is switched with it
        if (t[i] === 'L' && !(map && map.has(i))) lig.push(i);
    }
    return lig.length ? lig : null;
}

// ALL, NONE OR SOME of these positions drawn, read off the visibility mask
// - null there means everything is visible, which is the state a structure
// nobody has hidden anything in is in.
function visibleState(positions) {
    const renderer = selectionHost.renderer();
    const vis = renderer && renderer.visiblePositions;
    if (!vis) return true;
    let on = 0;
    for (const i of positions) if (vis.has(i)) on++;
    if (!on) return false;
    return on === positions.length ? true : null;
}

// WHAT THE SSE MENU SAYS. Four states - forced to helix, to sheet, to loop,
// or left to the assignment - and Mixed where the selection disagrees,
// which is a state and not a letter, so it is shown and cannot be picked.
//
// The DSSP entry carries the automatic answer in its label where the
// drawing already knows it ("DSSP (Helix)"), which is the difference
// between a state that says nothing and one that says what you are looking
// at. Not computed for it: see assignedSseFor.
function syncSseSelect(sel, renderer, picked) {
    // WHAT THE SELECTED RESIDUES ARE, in one word. Helix, Sheet or Loop -
    // and Mixed where they disagree.
    //
    // It used to say where the answer came from as well: "DSSP" when
    // nothing had been forced, then "Helix (DSSP)". Both are the same
    // mistake in different sizes - the control's other options are the
    // answer, so anything about its provenance reads as a fourth kind of
    // thing, and the longer form did not fit the 84px the row can spare.
    // A structure is a structure whoever decided it; the menu is how you
    // change it, and DSSP is the item that hands it back to the
    // assignment.
    const forced = renderer.forcedSseFor ? renderer.forcedSseFor(picked) : 'none';
    const auto = renderer.assignedSseFor ? renderer.assignedSseFor(picked) : '';
    const NAME = { H: 'Helix', E: 'Sheet', C: 'Loop' };
    sel.value = forced === 'none' ? 'dssp' : forced;
    const dssp = sel.querySelector('option[value="dssp"]');
    if (dssp) {
        // ...on the automatic option, because that is the one selected
        // while nothing is forced. With something forced it goes back to
        // naming what it DOES - the assignment is read off the array the
        // drawing uses, which has the override baked in, so it would
        // otherwise promise the forced letter as DSSP's own answer.
        dssp.textContent = (forced === 'none' && NAME[auto])
            ? NAME[auto] : 'DSSP';
    }
    const now = forced === 'none' ? auto : forced;
    sel.title = forced === ''
        ? 'The selected residues have different structures'
        : (NAME[now] || 'The secondary structure of the selected residues');
}


/**
 * A SHOW/HIDE PAIR: one question, two buttons, and the state on their faces.
 *
 * `true` fills the first button, `false` the second, and `null` - the
 * selection disagreeing with itself - fills neither. A single switch could
 * only show that third state as a grey smear, which is what made the panel
 * hard to read: the control said what it would do and left you to work out
 * what it had done.
 *
 * The wrapper carries `hidden` for the rows that come and go, so callers
 * hide the pair rather than reaching for a label around a checkbox.
 */
function setSelectionPair(id, state) {
    const pair = byId(id);
    if (!pair) return;
    const [on, off] = pair.querySelectorAll('.selection-switch-btn');
    if (!on || !off) return;
    on.classList.toggle('is-on', state === true);
    off.classList.toggle('is-on', state === false);
    on.setAttribute('aria-pressed', state === true ? 'true' : 'false');
    off.setAttribute('aria-pressed', state === false ? 'true' : 'false');
}

function syncSelectionToggles(picked, none) {
    const renderer = selectionHost.renderer();
    const obj = renderer?.objectsData?.[renderer.currentObjectName];
    const list = picked || [];
    const set = (id, state) => {
        const el = byId(id);
        if (!el) return;
        el.indeterminate = state === null;
        el.checked = state === true;
    };
    // how many of `of` are in `have`; `null` means the set is absent, which
    // for bases and elements means ALL and for side chains means NONE
    const tally = (of, have, absentIsAll) => {
        if (!of.length) return false;
        const n = of.filter((i) => (have ? have.has(i) : absentIsAll)).length;
        if (n === 0) return false;
        if (n === of.length) return true;
        return null;
    };
    if (none || !renderer || !obj) {
        for (const id of ['elementsShowToggle', 'plateShowToggle']) {
            set(id, false);
        }
        for (const id of ['sidechainPair', 'mainchainPair']) {
            setSelectionPair(id, false);
        }
        return;
    }
    // ...and only positions that still EXIST. A selection outlives the
    // coordinate array it was made against - a click can land on a
    // side-chain atom, and hiding side chains takes that atom away - so a
    // stale index would be tallied as "not visible" and read as mixed.
    // The renderer prunes them; this is the second lock on the same door.
    const nPos = renderer.coords ? renderer.coords.length : Infinity;
    const live = list.filter((i) => i < nPos);
    // ...AND AS RESIDUES, because that is what every question on this panel
    // is about.
    //
    // Showing a side chain APPENDS its atoms to the coordinate array as
    // positions of their own, carrying their residue's chain - so selecting
    // the chain again picks up the atoms as well as the residues. On 1YNE
    // that is 31 residues and 347 atoms, and an atom answers each of these
    // questions for ITSELF: it has no side chain of its own, so the row
    // read 31 full against 347 none and came back Mixed. The controls were
    // right about the selection and wrong about the structure - and it
    // only happened once the atoms existed, which is to say immediately
    // after using the control that made them.
    const scMapT = renderer.sidechainMap;
    const res = scMapT && scMapT.size
        ? [...new Set(live.map((i) => {
            const e = scMapT.get(i);
            return e ? e.owner : i;
        }))]
        : live;
    const owners = renderer.sidechainOwners ? renderer.sidechainOwners() : null;
    const scAble = owners ? live.filter((i) => owners.has(i)) : [];
    const t = renderer.positionTypes || [];
    // ELEMENTS ARE NOT ONLY A SIDE-CHAIN THING. A ligand atom is a position
    // of its own and carries its own element, so it can be coloured by it
    // with no side chain anywhere in the selection - which is why this is
    // tallied over the renderer's element owners rather than over scAble.
    const elOwners = renderer.elementOwners ? renderer.elementOwners() : owners;
    const elAble = elOwners ? live.filter((i) => elOwners.has(i)) : [];
    const ligEl = !!(elOwners && live.some((i) => t[i] === 'L' && elOwners.has(i)));
    // ...the set in MERGED indices, like the positions being tallied: read
    // off the object it would be that object's own numbering, and every
    // object after the first would answer for the wrong residues.
    set('elementsShowToggle', tally(elAble,
        renderer.mergedObjectSet ? renderer.mergedObjectSet('elements')
            : (obj.elements instanceof Set ? obj.elements : null), true));
    // ...and whether any of it is a nucleotide, which is the renderer's own
    // question rather than a second copy of the type test
    const hasNuc = !!(renderer.hasBasesFor && renderer.hasBasesFor(live));
    // THE SIDE-CHAIN MODE, read back per residue and shown only when the
    // whole selection agrees. Plate is offered only where the selection has
    // nucleotides - a protein has no such thing, and an option that does
    // nothing is worse than one that is not there.
    // HOW THE SELECTION'S SIDE CHAINS ARE DRAWN, read back per residue and
    // shown only where the whole selection agrees. One answer, two controls
    // that can show it: a switch where there are two states and a menu
    // where there are three.
    // ...both in MERGED indices - see shownSidechainSet and mergedObjectSet
    const scSet = renderer.shownSidechainSet ? renderer.shownSidechainSet()
        : (obj.sidechains instanceof Set ? obj.sidechains : null);
    const bSet = renderer.mergedObjectSet ? renderer.mergedObjectSet('bases')
        : (obj.bases instanceof Set ? obj.bases : null);
    const modeOf = (i) => {
        if (scSet && scSet.has(i)) return 'full';
        const isNuc = t[i] === 'D' || t[i] === 'R';
        if (isNuc && (!bSet || bSet.has(i))) return 'plate';
        return 'none';
    };
    const modes = new Set(res.map(modeOf));
    const mode = modes.size === 1 ? [...modes][0] : '';
    const scSel = byId('plateShowToggle');
    const scTog = byId('sidechainPair');
    // WHICH OF THE TWO IS ON THE ROW. A protein side chain is drawn or it
    // is not; only a nucleotide has the plate as well, and only there is a
    // menu worth reading. Never both - two controls for one question is
    // what this row stopped being.
    // BY ITS LABEL, NOT ITS CHECKBOX. The input is invisible on its own -
    // absolutely positioned at zero opacity, with the label carrying the
    // word - so hiding it left "Show" on the row beside the menu that had
    // replaced it. The select IS its own visible element and hides itself.
    // ...and on a LIGAND row the switch stays, meaning the ligand itself:
    // drawn or not drawn, which is the same two states a protein side chain
    // has. The menu never appears there - a ligand has no plate.
    // SHOW FIRST, ALWAYS, AND THE STYLE AFTER IT.
    //
    // Every row on this panel answers "is this drawn" with a Show switch,
    // and the side-chain row answered it with a three-way menu instead
    // wherever the selection had a nucleotide - so the same question had
    // two shapes depending on what you had picked, and None hid inside a
    // list where every other row has a switch. The switch is the question
    // now; the menu is the second question, WHICH WAY, and it appears
    // beside it only where there is a choice to make - a nucleotide, which
    // can be a plate or its real atoms. A protein side chain and a ligand
    // have one way of being drawn, so they have no menu.
    const ligPos = ligandRowPositions(live);
    const ligShown = ligPos ? visibleState(ligPos) : false;
    const scNothing = !scAble.length && !hasNuc;
    if (scTog) {
        scTog.hidden = scNothing && !ligPos;
        setSelectionPair('sidechainPair', ligPos ? ligShown
            : (mode === '' ? null : mode !== 'none'));
    }
    if (scSel) {
        // ...and the Plate switch only while something IS drawn: a way of
        // drawing a thing that is not drawn is a control for nothing. By
        // its LABEL, which is what carries the word - the checkbox is
        // invisible on its own.
        const wrapPlate = scSel.closest ? scSel.closest('label') : null;
        (wrapPlate || scSel).hidden = !hasNuc || mode === 'none' || mode === '';
        // ON MEANS PLATE, off means the real atoms. Left alone while
        // nothing is drawn, so the answer survives a switch off and on:
        // pick atoms, hide them, show them again, and they are still atoms.
        if (mode === 'plate' || mode === 'full') {
            scSel.checked = mode === 'plate';
            scSel.indeterminate = false;
        } else if (mode === '') {
            scSel.indeterminate = true;
        }
    }
    // ELEMENT COLOURS ARE A PROPERTY OF ATOMS, so the control only makes
    // sense while there are atoms drawn. On None there is nothing to
    // colour, and a plate is one flat shape with no elements in it - the
    // toggle sat there in both, doing nothing a user could see. Hidden by
    // its LABEL, which is what carries the text: hiding the checkbox alone
    // leaves "Elem" on the row with no control.
    // A LIGAND'S ELEMENTS FOLLOW ITS OWN SHOW, for the same reason a side
    // chain's follow Full: there is nothing to colour while nothing is
    // drawn. Hidden while the ligand is off, and while the selection is
    // half on, where the switch has no one answer to show.
    const elTog = byId('elementsShowToggle');
    if (elTog) {
        const wrap = elTog.closest ? elTog.closest('label') : null;
        (wrap || elTog).hidden = ligPos
            ? (ligShown !== true || !ligEl) : mode !== 'full';
    }
    // WHAT THE ROW IS CALLED. "Side chains" over a ligand's own controls
    // names something the selection has not got - and the swatch means the
    // ligand's colour there, which is why it stays: see the picker's own
    // dispatch on ligandRowPositions.
    const scRowEl = byId('sidechainRow');
    if (scRowEl) {
        const lbl = scRowEl.querySelector('.selection-panel-label');
        if (lbl) lbl.textContent = ligPos ? 'Ligand' : 'Side chains';
        const swatch = scRowEl.querySelector('.selection-color-wrap');
        if (swatch) swatch.hidden = false;
        // ...and what the two controls SAY they do, since what they do
        // changed with the row. A tooltip promising side chains over a
        // ligand is the same wrong label as the row's own name was.
        const tip = (el, text) => { if (el) el.title = text; };
        tip(byId('scColorButton'), ligPos
            ? 'Colour the selected ligand'
            : 'Colour the selected side chains');
        tip(scTog && scTog.closest ? scTog.closest('label') : null, ligPos
            ? 'Draw the selected ligand'
            : 'Draw side chains for the selected residues');
    }

    // MAIN CHAIN IS THE BACKBONE, which a ligand has not got: its Show
    // switches a backbone that is not drawn there either way, and its
    // swatch is the same colour the Ligand row's own swatch sets. So the
    // whole row goes for a ligand rather than sitting there as a duplicate
    // and a no-op.
    const mcRow = byId('mainchainRow');
    if (mcRow) mcRow.hidden = !!ligPos;
    // WHETHER THE MAIN CHAIN IS DRAWN, which two separate things can
    // answer no to, and the control has to mean both:
    //
    //   the per-residue switch  (backboneHiddenSet - this row's own),
    //   and the visibility mask (a box drawn on the PAE matrix, a chain
    //   hidden, Hide pressed on a selection).
    //
    // Reading only the switch, a residue hidden by a PAE box sat there
    // saying "Show" while nothing of it was on screen - reported exactly
    // that way. The set names what is HIDDEN, so a position in it is a
    // toggle that is off; the mask names what is VISIBLE, and null is
    // everything.
    // ...over residues too: an appended atom is not a backbone position, so
    // it is never in the hidden set, and a chain whose backbone is hidden
    // read as Mixed as soon as its side chains were drawn.
    const hidBB = renderer.backboneHiddenSet ? renderer.backboneHiddenSet() : null;
    const vis = renderer.visiblePositions;
    const mcDrawn = (i) => (!hidBB || !hidBB.has(i)) && (!vis || vis.has(i));
    setSelectionPair('mainchainPair', res.every(mcDrawn) ? true
        : (res.every((i) => !mcDrawn(i)) ? false : null));
    // THE CONTACT ROW IS ONE CONTROL PER STATE. No contact: an Add
    // button and nothing else, because there is nothing yet to colour or
    // to size. A contact: its own colour, its own width, and a bin - and
    // no Add, which by then would be a button that does nothing. Which of
    // the two is on the row is decided here; updateSelectionToolsState
    // shows the colour and the slider by the same answer.
    const hasContact = list.length === 2 && !!findContact(list);
    const addBtn = byId('contactAddButton');
    const binBtn = byId('contactDeleteButton');
    if (addBtn) addBtn.hidden = hasContact;
    if (binBtn) binBtn.hidden = !hasContact;
}

// Element colours, per residue. A pure repaint - the atoms and bonds are
// already there, only what colour a bond's halves take changes.
function setSelectionElements(positions, on) {
    const renderer = selectionHost.renderer();
    if (!renderer || !renderer.setElementsFor) return;
    if (!renderer.setElementsFor(positions, on)) return;   // nothing to redraw
    renderer.render('selection elements');
}

// HOW A SELECTION'S SIDE CHAINS ARE DRAWN: none, the nucleic plate, or the
// real atoms. One control, because the three are alternatives - a pair of
// toggles cannot say "one or the other", and with the plate on its own row
// the panel had two rows called Side chain.
function setSelectionSidechainMode(positions, mode) {
    const renderer = selectionHost.renderer();
    if (!renderer) return;
    const t = renderer.positionTypes || [];
    const nuc = positions.filter((i) => t[i] === 'D' || t[i] === 'R');
    // the plate is nucleic only; a protein asked for it gets nothing drawn
    // rather than a control that silently does something else
    if (mode === 'plate' && !nuc.length) {
        selectionHost.setStatus('Only nucleotides have a base plate.');
        updateSelectionToolsState();
        return;
    }
    if (nuc.length && renderer.setBasesFor) {
        renderer.setBasesFor(nuc, mode === 'plate');
    }
    // ...and the atoms, which are a frame RELOAD rather than a repaint
    setSelectionSidechains(positions, mode === 'full');
    syncSelectionVisibility(positions);
    renderer.render('selection side chain mode');
}

// A RESIDUE WITH NOTHING DRAWN IS HIDDEN, and one with any part drawn is
// not. The panel used to carry a Show toggle for the whole residue beside
// the per-part ones, which is a third thing to keep consistent with the
// other two; composing it means the mask always agrees with the picture,
// and Orient, the clip and picking all read the mask.
function syncSelectionVisibility(positions) {
    const renderer = selectionHost.renderer();
    const obj = renderer?.objectsData?.[renderer.currentObjectName];
    if (!renderer || !obj) return;
    const t = renderer.positionTypes || [];
    const hidBB = renderer.backboneHiddenSet ? renderer.backboneHiddenSet() : null;
    // ...in merged indices, like the positions this walks
    const sc = renderer.shownSidechainSet ? renderer.shownSidechainSet()
        : (obj.sidechains instanceof Set ? obj.sidechains : null);
    const bases = renderer.mergedObjectSet ? renderer.mergedObjectSet('bases')
        : (obj.bases instanceof Set ? obj.bases : null);
    const drawsSomething = (i) => {
        if (!hidBB || !hidBB.has(i)) return true;              // backbone drawn
        if (sc && sc.has(i)) return true;                      // real atoms
        const isNuc = t[i] === 'D' || t[i] === 'R';
        if (isNuc && (!bases || bases.has(i))) return true;    // plate
        return false;
    };
    // ...AND THEIR ATOMS WITH THEM. A shown side chain is APPENDED to the
    // coordinate array, and the mask is a set of position indices - so a
    // residue marked visible without its atoms leaves them out of it, and
    // the side chain the user just asked for is not drawn. They inherit
    // their owner's visibility at materialisation; this keeps that true
    // afterwards.
    // ...the renderer's own rule, not a third copy of it - see
    // withSidechainAtoms
    const withAtoms = (list) => (renderer.withSidechainAtoms
        ? [...renderer.withSidechainAtoms(new Set(list))] : list);
    const show = []; const hide = [];
    for (const i of positions) (drawsSomething(i) ? show : hide).push(i);
    if (hide.length) setSelectionVisible(withAtoms(hide), false);
    if (show.length) setSelectionVisible(withAtoms(show), true);
}

// WITHIN N ANGSTROM OF WHAT IS SELECTED, atom to atom. The renderer does
// the search (see residuesWithin); this is the button, and the reporting -
// a shell that found nothing has to say so, or it reads as a dead control.
// How near counts as an interaction, side chain to side chain. 5 A is a
// contact shell: a hydrogen bond is under 3.5 and a salt bridge under 4,
// and past about 6 the answer is everything in the neighbourhood.
const INTERACTION_CUTOFF_A = 5;

/**
 * The Align row appears only when there is something to align: a second
 * object, and a selection to align it to. The panel itself is already
 * gated on there being a selection, so the row only has to answer the
 * other half - and Undo appears within it whenever something is actually
 * off its file coordinates, which is not the same question.
 */
function syncAlignRow(picked, none) {
    const row = byId('alignRow');
    const sel = byId('alignSelect');
    if (!row || !sel) return;
    const r = selectionHost.renderer();
    const objects = r ? Object.keys(r.objectsData || {}) : [];
    const aligned = !!(r && r.anyAlignment && r.anyAlignment());
    const canAlign = !none && objects.length > 1 && !!window.Align;
    row.hidden = !(canAlign || aligned);
    for (const opt of sel.options) {
        if (opt.value === 'none') opt.hidden = !aligned;
        else if (opt.value) opt.hidden = !canAlign;
    }
}

/**
 * Run it, and say what happened in one line.
 *
 * The dropdown is disabled while it runs rather than queueing a second
 * job: TM-align is seconds of arithmetic on a big chain, and two runs
 * racing to write alignTransform would land in whichever order they
 * finished in.
 */
async function runAlign(mode) {
    const r = selectionHost.renderer();
    const sel = byId('alignSelect');
    if (!r) return;
    if (mode === 'none') {
        const n = r.clearAlignments();
        selectionHost.setStatus(n ? `${n} object${n === 1 ? '' : 's'} back to file coordinates`
            : 'nothing was aligned');
        updateSelectionToolsState();
        return;
    }
    if (sel) sel.disabled = true;
    try {
        selectionHost.setStatus('Aligning...');
        r.onAlignProgress = (done, total) => selectionHost.setStatus(`Aligning ${done}/${total}...`);
        const out = await r.alignToSelection(mode);
        r.onAlignProgress = null;
        // What the last run actually did, for the probe: whether it got a
        // worker is not visible in the picture and not visible in the
        // status line, and it is the half of this feature most likely to
        // fail silently by falling back to the main thread for good.
        window.__alignResult = { ref: out.ref, inWorker: out.inWorker,
            results: out.results, skipped: out.skipped };
        const res = out.results;
        if (!res.length) { selectionHost.setStatus('nothing could be aligned', true); return; }
        // ONE LINE, and it says the thing you would check: how good the fit
        // is. For a single object that is its own numbers; for several it
        // is the range, because listing four objects' scores is four lines
        // in a panel that has room for one.
        const fmt = (x) => x.toFixed(2);
        if (res.length === 1) {
            const a = res[0];
            selectionHost.setStatus(`${a.name} ${a.chain} to ${out.ref}: TM ${fmt(a.tm)},`
                + ` RMSD ${a.rmsd.toFixed(1)} A over ${a.aligned}`);
        } else {
            const tms = res.map((a) => a.tm);
            selectionHost.setStatus(`${res.length} objects to ${out.ref}: TM `
                + `${fmt(Math.min(...tms))}-${fmt(Math.max(...tms))}`);
        }
        updateSelectionToolsState();
    } catch (e) {
        r.onAlignProgress = null;
        selectionHost.setStatus(String((e && e.message) || e), true);
    } finally {
        if (sel) sel.disabled = false;
    }
}

function selectNearby(cutoff, sidechainsOnly) {
    const renderer = selectionHost.renderer();
    if (!renderer || !renderer.residuesWithin) return;
    const sel = renderer.residueSelection;
    const seed = sel ? (sel instanceof Set ? sel : new Set(sel)) : null;
    if (!seed || !seed.size) {
        selectionHost.setStatus('Select something first, then Within finds what is near it.');
        return;
    }
    const what = sidechainsOnly ? 'side chain to side chain' : 'atom to atom';
    const found = renderer.residuesWithin(seed, cutoff, { sidechainsOnly });
    const added = found.size - seed.size;
    if (!added) {
        // A SIDE-CHAIN SEARCH CAN FIND NOTHING FOR TWO REASONS, and they are
        // not the same news: nothing near enough, or nothing to measure -
        // a glycine, or a structure whose side chains were never captured.
        if (sidechainsOnly && renderer.hasSidechainsFor
            && !renderer.hasSidechainsFor([...seed])) {
            selectionHost.setStatus('Nothing selected has a side chain to measure from.');
            return;
        }
        selectionHost.setStatus(`Nothing else within ${cutoff} \u00c5 (${what}).`);
        return;
    }
    renderer.setResidueSelection(found);
    selectionHost.setStatus(`${added} more residue${added === 1 ? '' : 's'} within ${cutoff} \u00c5`
        + ` ${what} - ${found.size} selected.`);
}

// THE BACKBONE OF THE SELECTED RESIDUES. Not the same question as hiding
// them: hiding takes the side chain too, and this leaves it. Stored on the
// OBJECT beside `sidechains` and `bases`, and a pure DRAWING change - the
// positions are all still there, so this is a repaint (the GPU recaptures,
// because prims that are not built cannot be in a mesh).
function setSelectionBackbone(positions, on) {
    const renderer = selectionHost.renderer();
    if (!renderer || !renderer.setBackboneHiddenFor) return;
    if (!renderer.setBackboneHiddenFor(positions, !on)) return;
    renderer.render('selection backbone');
}

// VISIBILITY. Two things make this less obvious than it looks:
// (1) visiblePositions is a SET of visible position indices, not a per-residue
//     byte array, and null means "everything is visible";
// (2) setVisibility OWNS it - it recomputes visiblePositions from the selection
//     (core/mol.js) - so writing renderer.visiblePositions directly works
//     until the next selection change silently undoes it.
// So visibility is expressed as a selection, and set through setVisibility.
// NO `exclusive` FLAG. There was one - it replaced the visible set outright
// instead of adding to or subtracting from it - and all four call sites passed
// false, so the branch had never run. The embed says that shape as
// resetVisibility() then hide({not: x}), which is two calls that already exist.
function setSelectionVisible(positions, visible) {
    const renderer = selectionHost.renderer();
    if (!renderer || !renderer.coords) return;
    const n = renderer.coords.length;
    const inRange = positions.filter((i) => i >= 0 && i < n);
    let next;
    {
        const cur = renderer.visiblePositions;
        next = cur ? new Set(cur)
            : new Set(Array.from({ length: n }, (_, i) => i));
        for (const i of inRange) {
            if (visible) next.add(i); else next.delete(i);
        }
    }
    // Chains must be derived from the surviving positions, not left alone.
    // An empty chain set means "all chains" under the default mode but
    // "no chains" under explicit - so switching to explicit while leaving
    // chains empty made every chain label render as unselected even though
    // most of the structure was still visible.
    // BY (OBJECT, CHAIN) - see chainKeyAt. A bare id is chain A of every
    // object on screen, so hiding one object's chain A hid the other's.
    const chains = new Set();
    if (renderer.chains) {
        for (const i of next) {
            const c = renderer.chainKeyAt ? renderer.chainKeyAt(i) : renderer.chains[i];
            if (c) chains.add(c);
        }
    }
    renderer.setVisibility({ positions: next, chains, visibilityMode: 'explicit' });
    if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
    renderer.render('selection visibility');
}

// The restyling tools only mean anything with something selected, so the
// panel they live in is hidden outright rather than shown inert. They are
// disabled as well as hidden - a hidden control is still focusable by
// keyboard, and `disabled` is what actually takes it out of the tab order.
function updateSelectionToolsState() {
    const tools = byId('selectionTools');
    if (!tools) return;
    const picked = getActiveSelection();
    const none = picked === null;
    // THE PANEL IS THE STATE. It appears with a selection and goes away
    // without one, so there is never a row of controls that do nothing.
    // The old arrangement kept them visible but greyed, on the argument
    // that hiding them left no hint they existed - but they now live in
    // their own panel beside the structure, and a panel sliding in is a
    // louder cue than five buttons changing opacity in a header.
    const panel = byId('selectionPanel');
    // ...AND NOT IN FOCUS MODE. There is always a selection in there - the
    // residue you just clicked - so the panel would slide in and stay in,
    // beside a mode whose whole point is to look at one thing. Its buttons act
    // on the selection, and in focus the selection is the mode's own bookmark
    // rather than something the reader built up to act on.
    const inFocus = !!(selectionHost.renderer()?._focusMode);
    if (panel) panel.hidden = none || inFocus;
    // HOW MANY, AND ACROSS HOW MANY OBJECTS - and no more than that. The
    // count changes what pressing a button does, so it earns its place;
    // the residue ranges beside it ("A 11-13, 20-21; B 5, 7") did not. In
    // a 340px panel they were set small, ran past the edge of the head and
    // were cut short, and the tooltip that held the rest is not something
    // anybody hovers a header for. The strip below shows what is selected,
    // in the place made for showing it.
    // 🔴 AND THE COUNT IS GONE TOO. It was the last thing left in the head
    // after the residue ranges came out, and it is the same kind of thing: the
    // sequence strip below already shows what is selected, in the place made
    // for showing it, and a number over the top of that is a second answer to a
    // question nobody asked twice. What the head keeps is the word Selection
    // and the three actions.
    //
    // The element stays, because the head's flex layout uses it as the
    // stretching middle between the title and the actions - and because
    // something else may yet want to say something there. It is left empty.
    const count = byId('selectionPanelCount');
    if (count) {
        count.textContent = '';
        count.title = '';
    }
    // A contact is a line between a PAIR: nothing to draw for one residue or
    // for five, so the row is offered only for exactly two. Within it the
    // toggle's STATE says whether the pair is joined - which is what the
    // Add/Remove pair could only say by which of the two was showing.
    const contactRow = byId('contactRow');
    const pair = !none && picked.length === 2;
    if (contactRow) contactRow.hidden = !pair;
    syncAlignRow(picked, none);
    if (pair) {
        const found = findContact(picked);
        const has = !!found;
        const swatch = byId('contactColorButton');
        // nothing to colour or size until there is a contact
        if (swatch) swatch.parentElement.hidden = !has;
        const wSlider = byId('contactWidthSlider');
        if (wSlider) {
            wSlider.hidden = !has;
            if (has) {
                const entry = found.obj.contacts[found.i];
                const w = entry && entry[contactSlots(entry).w];
                wSlider.value = typeof w === 'number' ? w : 1;
            }
        }
    }
    syncSelectionToggles(picked, none);
    // The side-chain row is offered only when there is something to show:
    // glycine has no side chain, nor does any residue in a backbone-only
    // model, and a control that cannot do anything is worse than no
    // control. A NUCLEOTIDE HAS ONE NOW - its base, in the same table -
    // so the row appears for it too and its Plate option with it.
    const scRow = byId('sidechainRow');
    if (scRow) {
        const renderer = selectionHost.renderer();
        // hasElementsFor, not hasSidechainsFor: it answers yes for every
        // residue with a side chain AND for a ligand atom that knows its
        // element, which is the other reason this row has something to do.
        scRow.hidden = none || !renderer || !renderer.hasElementsFor
            || !renderer.hasElementsFor(picked);
    }
    // Elements rides that same row rather than gating itself: it colours
    // the atoms the row draws, so wherever there are none it is already
    // gone with them.
    //
    // SSE on the same rule, from the protein side. Secondary structure is
    // a property of a protein backbone: a nucleotide is never assigned a
    // letter, so on a DNA or RNA selection this menu offered four states
    // and did nothing whichever was picked. It hides rather than
    // disabling, because the row it sits on is about the main chain and
    // stays useful - a greyed control there reads as something broken.
    // ...AND THE LINE ONLY MEANS ANYTHING WITH SOMETHING ABOVE IT. Both
    // property rows can go at once - a ligand takes the main chain row
    // away, and a selection with no elements to colour takes the other -
    // and a divider at the top of the panel is a rule under nothing.
    const divider = byId('selActionDivider');
    if (divider) {
        const scR = byId('sidechainRow');
        const mcR = byId('mainchainRow');
        divider.hidden = none
            || ((!scR || scR.hidden) && (!mcR || mcR.hidden));
    }
    // SECONDARY STRUCTURE, WHERE ANYTHING IS DRAWN FROM IT. The cartoon
    // draws it - a helix is a coil of ribbon and a strand is an arrow -
    // and the SS colour mode paints it in any style. The TUBE draws a tube
    // whatever the structure is, so on a tube with any other colour mode
    // this control changes nothing on screen: it was a menu offering four
    // states of something invisible.
    //
    // It also costs: the panel reads the assignment to fill this in, and
    // in the tube style nothing else has computed one, so every selection
    // after an edit paid for a full SS pass - 81 ms on a ribosome. Not
    // asking is the cheapest way to not pay.
    const ssHide = byId('selSsSelect');
    if (ssHide) {
        const renderer = selectionHost.renderer();
        const drawsSse = !!renderer
            && (renderer.style === 'cartoon' || renderer.colorMode === 'ss');
        ssHide.hidden = none || !renderer || !drawsSse || !renderer.hasSseFor
            || !renderer.hasSseFor(picked);
        if (!ssHide.hidden) syncSseSelect(ssHide, renderer, picked);
    }
    tools.classList.toggle('disabled', none);
    // Also set the real disabled property, not just the class: hiding the
    // panel takes it off the screen but leaves its buttons in the tab
    // order, and `disabled` is what removes them from it.
    // INPUT is in that list because the +/- buttons became checkboxes: a
    // selector naming only buttons and selects stopped covering the show
    // toggles the moment they stopped being buttons.
    for (const el of tools.querySelectorAll('button, select, input')) el.disabled = none;
    // Unselect lives outside that group because it does not need a
    // selection to be discoverable - but it does need one to do anything,
    // so it follows the same state. Select all stays enabled either way.
    const unselectBtn = byId('clearAllResidues');
    if (unselectBtn) unselectBtn.disabled = none;
    // The swatches show the SELECTION's colour rather than the last colour
    // picked, so they are refreshed from the same place the enabled state
    // is and never go stale.
    if (window.refreshSelectionSwatches) window.refreshSelectionSwatches();
}
window.updateSelectionToolsState = updateSelectionToolsState;

// ============================================================================
// WIRING THE PANEL
// ----------------------------------------------------------------------------
// 🔴 A CONTROL THE SHARED PANEL SHOWS AND ONE SHELL WIRES IS WORSE THAN NO
// CONTROL. parts/panel.js builds the selection panel for every shell, so the
// listeners have to be here rather than in src/app/main.js, where they were:
// mounted in a notebook they would have appeared on screen, unseeded and inert
// - the fault Cyclic, Orient, Clip and Draw each shipped once already.
//
// It closed over exactly two names of the web app's - the viewer handle and
// applySelectionToMSA - and both are on the host now. `afterChange` is the
// second: the MSA dims to the selection on the website, and there is no MSA in
// a notebook.
// ============================================================================
function wireSelectionPanel() {
    // 🔴 THE PANEL A GESTURE CAME FROM IS THE CURRENT ONE.
    //
    // The host is module scope, so naming a root at wire time only changes
    // WHICH viewer wins on a page with two of them - the last to be built
    // instead of the first in document order. Neither is the one that was
    // clicked.
    //
    // So each panel claims the host on the way in, from a CAPTURING listener
    // on its own container: capture runs before any listener on a descendant,
    // so by the time a control's own handler executes, `byId` and
    // `selectionHost.renderer()` already answer for the viewer the reader is
    // touching. One hook per panel rather than a wrapper around forty
    // handlers, and it covers the controls built later too - the colour cells
    // are made on the first open of a menu.
    //
    // The canvas is inside the container as well, so a PICK claims it too,
    // which is what makes the right panel open when the right structure is
    // clicked.
    const myRoot = selectionHost.root;
    const myRenderer = selectionHost.renderer;
    const claim = () => py2dmolSelectionHost({ root: myRoot, renderer: myRenderer });
    if (myRoot) {
        for (const type of ['pointerdown', 'mousedown', 'click', 'change', 'input']) {
            myRoot.addEventListener(type, claim, true);
        }
    }

    // Copy selection button (moved to sequence actions)
    const copySelectionButton = byId('copySelectionButton');
    if (copySelectionButton) {
        copySelectionButton.addEventListener('click', () => {
            const r = selectionHost.renderer();
            if (!r || !r.extractSelection) {
                console.warn("Copy selection feature not available");
                return;
            }
            // A SELECTION CAN REACH SEVERAL OBJECTS, and Copy makes one new
            // object per object it touched - so it says which, rather than
            // leaving the user to find out that two appeared.
            const made = r.extractSelection();
            const names = Array.isArray(made) ? made : (made ? [made] : []);
            if (names.length > 1) {
                selectionHost.setStatus(`Copied into ${names.join(' and ')}`
                    + ' - one object per structure the selection reached.');
            }
            selectionHost.afterChange();
        });
    }

    // CUT: the copy Copy makes, minus the residues from where they came. The
    // renderer owns the order (see cutSelection - the two halves cannot simply
    // be pressed in sequence); this reports what happened, because a cut that
    // silently did nothing looks exactly like a copy that did.
    const cutSelectionButton = byId('cutSelectionButton');
    if (cutSelectionButton) {
        cutSelectionButton.addEventListener('click', () => {
            const r = selectionHost.renderer();
            if (!r || !r.cutSelection) return;
            const made = r.cutSelection();
            if (!made) {
                selectionHost.setStatus('Select something first, then Cut moves it into a new object.');
                return;
            }
            // ...one new object per structure the selection reached, named
            selectionHost.setStatus(`Cut ${made.removed} residue${made.removed === 1 ? '' : 's'}`
                + ` into ${made.name}. Reload the file to get them back.`);
            if (window.SEQ?.buildViewDeferred || window.SEQ?.buildView) {
                (window.SEQ.buildViewDeferred || window.SEQ.buildView)();
            }
            selectionHost.afterChange();
        });
    }

    // DELETE, beside Copy in the panel's corner. The renderer does the work;
    // this only reports what happened, since a delete that silently did nothing
    // (an empty selection, or one covering everything) is worse than a refusal.
    const deleteSelectionButton = byId('deleteSelectionButton');
    if (deleteSelectionButton) {
        deleteSelectionButton.addEventListener('click', () => {
            const r = selectionHost.renderer();
            if (!r || !r.deleteSelection) return;
            const gone = r.residueSelection ? r.residueSelection.size : 0;
            // ...from every object the selection reached, which the count
            // already covers and the message says when it is more than one
            const across = r.objectsInSelection ? r.objectsInSelection() : [];
            if (r.deleteSelection()) {
                selectionHost.setStatus(`Deleted ${gone} residue${gone === 1 ? '' : 's'}`
                    + (across.length > 1 ? ` from ${across.join(' and ')}` : '')
                    + '. Reload the file to get them back.');
                if (window.SEQ?.buildViewDeferred || window.SEQ?.buildView) {
                    (window.SEQ.buildViewDeferred || window.SEQ.buildView)();
                }
                selectionHost.afterChange();
            }
        });
    }

    // Positions the tools act on. In 'default' mode getVisibility() reports
    // every residue as selected, which is the right answer for visibility but
    // the WRONG one here - "colour everything because you have not selected
    // anything" is never what was meant. So an explicit selection is required.

    {
        const withSelection = (fn) => (e) => {
            if (e) e.preventDefault();
            const positions = getActiveSelection();
            if (!positions) return;
            fn(positions);
        };

        // COLOUR: a grid of PyMOL's named colours rather than an OS colour
        // picker, so the choices are the ones a PyMOL user already knows by
        // name. Built from the table core/mol.js exports.
        //
        // ONE implementation, two pickers - main chain and side chains colour
        // independently, and a second copy of this would drift from the first.
        // `apply` says where the colour goes; `current` says what the swatch
        // should show.
        const colorPickers = [];

        // THE COLOUR MODES, FROM THE ONE LIST THAT ALREADY EXISTS.
        //
        // The Style panel's #colorSelect is built from parts/panel.js and is
        // the project's list of colour modes; reading its options here means a
        // mode added there appears in the picker too, and - the part that
        // cannot be rewritten from a table - the picker inherits the panel's
        // decision about which are HIDDEN UNTIL USEFUL. `object` means nothing
        // with one structure on screen and `entropy` means nothing without an
        // MSA, and both are hidden by the same code that hides them above.
        //
        // 'auto' is dropped because the select's own first entry is Auto and
        // means something STRONGER: not "resolve the global mode here" but
        // "have no opinion at all", which is a cleared override.
        // 🔴 AND `ss:pymol` IS A COMPOSITE, WHICH THIS LIST MUST COLLAPSE.
        // It is the only value the Style dropdown carries that says two
        // things - the mode `ss` AND the viewer-wide `ssPalette` - and
        // resolveColorHierarchy knows only the first: stored at a position it
        // is not a mode name, so applySpec files it as a LITERAL and the
        // residues draw from hexToRgb('ss:pymol'), which is grey. Splitting it
        // the way parts/ui.js does is no better here, because the palette is
        // the VIEWER's: picking Jmol for four residues would repaint every
        // sheet on the page. The picker chooses the SCHEME and leaves the
        // palette where it belongs, so both options collapse to one `ss`.
        const colorModeOptions = () => {
            const src = byId('colorSelect');
            if (!src) return [];
            const out = [];
            const seen = new Set();
            for (const o of src.options) {
                if (o.hidden || !o.value || o.value === 'auto') continue;
                const cut = o.value.indexOf(':');
                const value = cut < 0 ? o.value : o.value.slice(0, cut);
                if (seen.has(value)) continue;
                seen.add(value);
                out.push([value, cut < 0 ? o.textContent : 'SSE']);
            }
            return out;
        };

        const wireColorPicker = ({ btnId, menuId, swatchId, apply, current,
            modes, currentMode }) => {
            const btn = byId(btnId);
            const menu = byId(menuId);
            const swatch = byId(swatchId);
            if (!btn || !menu) return;
            // Rebuilt each time the menu opens: the palette is the CHAIN colour
            // set, which swaps wholesale with colourblind mode.
            const buildSwatches = () => {
                menu.textContent = '';
                // A MODE IS A COLOUR ANSWER, NOT A COLOUR, so it cannot be a
                // swatch - and a selection can hold one. The hierarchy has
                // taken a mode name at position level since it was written
                // (applySpec in core/mol.js), and obj.sidechainColor takes one
                // too; nothing could SAY one. Set the backbone to Chain and a
                // pocket's side chains to Hydropathy and both answers are on
                // one picture.
                //
                // AUTO IS THIS CONTROL'S FIRST ENTRY, not a button beside it.
                // It used to be a row of its own, which was right while the
                // menu held colours and nothing else; with a mode list in the
                // same menu, two things reading Auto a few pixels apart is a
                // coin toss over which one you want. Auto here is the same
                // action it always was - CLEAR the override - which is what
                // makes it stronger than the 'auto' MODE: that one resolves
                // the global scheme at this position, this one leaves the
                // position with no opinion, so an object-wide colour still
                // reaches it.
                const options = modes ? colorModeOptions() : [];
                if (modes) {
                    const modeRow = document.createElement('div');
                    modeRow.className = 'selection-color-row';
                    const sel = document.createElement('select');
                    sel.className = 'selection-color-mode';
                    sel.title = 'Colour these by a scheme rather than by one'
                        + ' colour. Auto clears it and follows what is set'
                        + ' above.';
                    const add = (value, label) => {
                        const o = document.createElement('option');
                        o.value = value; o.textContent = label;
                        sel.appendChild(o);
                    };
                    add('', 'Auto (default colour)');
                    for (const [value, label] of options) add(value, label);
                    // THE SELECTION IT IS ABOUT, AND IT MAY NOT BE THERE.
                    // buildSwatches runs once at WIRE time, before anything is
                    // selected - the first version called currentMode() with
                    // no argument, which read positions[0] of undefined and
                    // threw inside setupEventListeners, taking every control
                    // wired after it with it. tests/selection_panel.py caught
                    // it as a panel that never opened and rows measuring 0px.
                    const held = getActiveSelection();
                    const now = (currentMode && held && held.length)
                        ? currentMode(held) : null;
                    sel.value = (now && options.some((o) => o[0] === now)) ? now : '';
                    sel.addEventListener('change', (e) => {
                        e.stopPropagation();
                        menu.hidden = true;
                        const positions = getActiveSelection();
                        if (positions) apply(positions, sel.value || null);
                        refresh();
                    });
                    // ...a click inside the open menu must not close it, which
                    // is what the document-level handler below would do to the
                    // native dropdown the moment it opened.
                    sel.addEventListener('click', (e) => e.stopPropagation());
                    modeRow.appendChild(sel);
                    menu.appendChild(modeRow);
                } else {
                    // AUTO: clears the override so the residues fall back to
                    // whatever the colour mode says. Not a colour, so it gets
                    // its own row rather than a swatch that would have to
                    // pretend to be one. Kept for the pickers with no mode
                    // list - a contact is one line between two residues, and
                    // there is no scheme that says what colour it should be.
                    const autoRow = document.createElement('div');
                    autoRow.className = 'selection-color-row';
                    const autoBtn = document.createElement('button');
                    autoBtn.type = 'button';
                    autoBtn.className = 'selection-color-auto';
                    autoBtn.textContent = 'Auto (default colour)';
                    autoBtn.title = 'Remove the colour override and follow the colour mode';
                    autoBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        menu.hidden = true;
                        const positions = getActiveSelection();
                        if (positions) apply(positions, null);
                        refresh();
                    });
                    autoRow.appendChild(autoBtn);
                    menu.appendChild(autoRow);
                }

                const groups = (window.py2dmol_paletteColors
                    ? window.py2dmol_paletteColors(!!selectionHost.renderer()?.colorblindMode)
                    : []);
                for (const group of groups) {
                    const row = document.createElement('div');
                    row.className = 'selection-color-row';
                    for (const hex of group) {
                        const cell = document.createElement('button');
                        cell.type = 'button';
                        cell.className = 'selection-color-cell';
                        cell.style.background = hex;
                        cell.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            menu.hidden = true;
                            const positions = getActiveSelection();
                            if (positions) apply(positions, hex);
                            refresh();
                        });
                        row.appendChild(cell);
                    }
                    menu.appendChild(row);
                }
            };
            // THE SWATCH SHOWS THE SELECTION, not the last colour picked. A
            // remembered colour is a statement about the tool; what you want to
            // know when you click a residue is what colour THAT residue is. A
            // mixed selection shows the first, since one square cannot show two.
            const refresh = () => {
                if (!swatch) return;
                const positions = getActiveSelection();
                const hex = positions && positions.length ? current(positions) : null;
                swatch.style.background = hex || 'transparent';
                swatch.classList.toggle('is-empty', !hex);
            };
            buildSwatches();
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // rebuilt on open: the chain palette swaps with colourblind mode
                buildSwatches();
                const wasHidden = menu.hidden;
                // only one grid open at a time - two overlapping popups in a
                // 340px panel is unreadable
                for (const other of (selectionHost.root || document)
                    .querySelectorAll('.selection-color-menu')) {
                    other.hidden = true;
                }
                menu.hidden = !wasHidden;
            });
            document.addEventListener('click', (e) => {
                if (!menu.hidden && !menu.contains(e.target)
                    && e.target !== btn && !btn.contains(e.target)) {
                    menu.hidden = true;
                }
            });
            colorPickers.push(refresh);
            refresh();
        };

        // What colour a residue is RIGHT NOW, as the renderer resolves it -
        // override, colour mode, palette and all - so the swatch matches the
        // pixels rather than a setting.
        const rgbToHex = (c) => (c && c.r !== undefined)
            ? '#' + [c.r, c.g, c.b].map((v) => {
                const n = Math.max(0, Math.min(255, Math.round(v > 1 ? v : v * 255)));
                return n.toString(16).padStart(2, '0');
            }).join('')
            : null;
        const mainChainColorOf = (positions) => {
            const renderer = selectionHost.renderer();
            if (!renderer || !renderer.getAtomColor) return null;
            return rgbToHex(renderer.getAtomColor(positions[0]));
        };

        // THE OBJECT THAT OWNS A POSITION, AND THAT POSITION IN ITS NUMBERING.
        // Every per-object map - color, sidechainColor - is keyed that way,
        // and a selection arrives in MERGED indices, so reading one without
        // this asks the wrong object about the wrong residue whenever more
        // than one structure is on screen.
        const ownerEntry = (position) => {
            const renderer = selectionHost.renderer();
            if (!renderer) return null;
            const o = renderer.ownerOf ? renderer.ownerOf(position) : null;
            const obj = renderer.objectsData?.[
                o ? o.name : renderer.currentObjectName];
            return obj ? { obj, at: o ? o.local : position } : null;
        };
        // ...and whether what is stored there is a MODE rather than a colour.
        // Both maps take either, and only the picker needs to tell them apart:
        // a mode has to come back as the dropdown's value while a hex has to
        // come back as the swatch's.
        const asMode = (value) => {
            if (typeof value !== 'string' || value[0] === '#') return null;
            const valid = (typeof window.py2dmol_colorModes === 'function')
                ? window.py2dmol_colorModes() : null;
            if (valid && !valid.includes(value)) return null;
            return value;
        };

        wireColorPicker({
            btnId: 'selColorButton', menuId: 'selColorMenu', swatchId: 'selColorSwatch',
            apply: setSelectionColor, current: mainChainColorOf,
            // A MODE AT POSITION LEVEL, which resolveColorHierarchy's applySpec
            // has understood since it was written - a string naming a mode
            // selects the mode and cancels any literal below it - and which
            // nothing could write. setSelectionColor stores what it is given,
            // so this needed no renderer change at all.
            modes: true,
            currentMode: (positions) => {
                const e = ownerEntry(positions[0]);
                const adv = e && e.obj.color && e.obj.color.type === 'advanced'
                    ? e.obj.color.value : null;
                return asMode(adv && adv.position && adv.position[e.at]);
            },
        });
        wireColorPicker({
            btnId: 'scColorButton', menuId: 'scColorMenu', swatchId: 'scColorSwatch',
            // ON A LIGAND ROW THIS IS THE LIGAND'S COLOUR. A side-chain colour
            // is stored against the OWNING residue, and a ligand atom has none
            // - so the side-chain path silently does nothing there, which is
            // what a swatch on that row would have looked like. The ordinary
            // per-position colour is the one that means anything for a ligand.
            apply: (positions, hex) => {
                const lig = ligandRowPositions(positions);
                if (lig) setSelectionColor(lig, hex);
                else setSelectionSidechainColor(positions, hex);
            },
            // an unset side chain follows its residue, so that is what it shows
            current: (positions) => {
                const renderer = selectionHost.renderer();
                const lig = ligandRowPositions(positions);
                if (lig) return mainChainColorOf(lig);
                const e = ownerEntry(positions[0]);
                const own = e && e.obj.sidechainColor
                    && e.obj.sidechainColor[e.at];
                if (typeof own === 'string' && own[0] === '#') return own;
                // ...A MODE IS RESOLVED, NOT SKIPPED. The swatch is meant to
                // show what is on screen, and a side chain following
                // hydropathy is not the colour its residue is - showing the
                // residue's would say the mode had not taken.
                const mode = asMode(own);
                if (mode && renderer && renderer._colorForMode) {
                    return rgbToHex(renderer._colorForMode(positions[0], mode));
                }
                return mainChainColorOf(positions);
            },
            modes: true,
            currentMode: (positions) => {
                if (ligandRowPositions(positions)) return null;
                const e = ownerEntry(positions[0]);
                return asMode(e && e.obj.sidechainColor
                    && e.obj.sidechainColor[e.at]);
            },
        });
        wireColorPicker({
            btnId: 'contactColorButton', menuId: 'contactColorMenu',
            swatchId: 'contactColorSwatch',
            apply: setSelectionContactColor,
            // a contact with no colour of its own draws in the default yellow,
            // so that is what the swatch shows rather than nothing
            current: (positions) => {
                const found = findContact(positions);
                if (!found) return null;
                const c = found.obj.contacts[found.i];
                const col = c && c[contactSlots(c).col];
                return (col && col.r !== undefined)
                    ? rgbToHex(col) : '#ffff00';
            },
        });
        window.refreshSelectionSwatches = () => { for (const f of colorPickers) f(); };

        const ssSelect = byId('selSsSelect');
        if (ssSelect) {
            ssSelect.addEventListener('change', withSelection((positions) => {
                const v = ssSelect.value;
                // DSSP is the one that UNFORCES: null takes the override off
                // and the assignment decides again.
                if (v) setSelectionSse(positions, v === 'dssp' ? null : v);
                // ...and then the menu is read back off the structure, like
                // every other control here, rather than reset to a placeholder
                updateSelectionToolsState();
            }));
        }
        const on = (id, fn) => {
            const el = byId(id);
            if (el) el.addEventListener('click', withSelection(fn));
        };
        // ONE visibility button. Which way it goes is read off the structure,
        // not remembered: if any of the selection is currently hidden the press
        // shows it, otherwise it hides it. That makes "show what I picked" the
        // behaviour for a selection that is partly hidden, which is what a user
        // reaching for this after a Hide actually wants.
        {
            const ws = byId('contactWidthSlider');
            if (ws) {
                // `input`, not `change`: the contact should follow the drag.
                // Redrawing per event is affordable here - one contact is a
                // handful of prims - where a residue-level control would not be.
                ws.addEventListener('input', () => {
                    const positions = getActiveSelection();
                    if (positions) setSelectionContactWidth(positions, +ws.value);
                });
            }
        }
        // A TOGGLE CARRIES ITS OWN DIRECTION. `on` fires on click and the
        // handler decided the direction; these fire on change and take it from
        // the box, so the control and what it does cannot disagree.
        //
        // A MIXED selection - some of it has the thing, some does not - is
        // shown indeterminate, and the browser's first click on an
        // indeterminate box checks it. So the click resolves the mixture by
        // turning everything ON, which is the useful direction: it is what
        // "show what I picked" means when half of it already is.
        const onToggle = (id, fn) => {
            const el = byId(id);
            if (!el) return;
            el.addEventListener('change', withSelection((positions) => {
                fn(positions, el.checked);
                // ...and re-read the state from the structure, not from the
                // box: an action can be refused (no side-chain atoms, base
                // plates switched off globally) and the toggle must then go
                // back to what is actually drawn rather than sit on a lie.
                updateSelectionToolsState();
            }));
        };
        // A PAIR IS TWO BUTTONS AND ONE QUESTION: each says which way it goes,
        // rather than a switch that means "the other one from now". Pressing
        // the button that is already filled is a no-op the same way asking for
        // what you already have is - it runs, and the state comes back the
        // same. The answer is re-read from the structure afterwards, like the
        // switches: an action can be refused (no side-chain atoms, base plates
        // off globally) and the buttons must then show what is drawn rather
        // than what was asked for.
        const onPair = (id, fn) => {
            const pair = byId(id);
            if (!pair) return;
            const btns = pair.querySelectorAll('.selection-switch-btn');
            btns.forEach((btn, k) => {
                btn.addEventListener('click', withSelection((positions) => {
                    fn(positions, k === 0);
                    updateSelectionToolsState();
                }));
            });
        };
        onToggle('elementsShowToggle', (p2, v) => setSelectionElements(p2, v));
        onPair('mainchainPair', (p2, v) => {
            setSelectionBackbone(p2, v);
            // SHOW MEANS SHOW, whatever was hiding it. The switch alone leaves
            // a residue that the mask excludes - one inside a PAE box's
            // shadow, say - exactly as invisible as it was, and the button
            // then does nothing you can see. Hide is the other way round: the
            // switch is all it needs, and syncSelectionVisibility takes the
            // residue out of the mask only if nothing else of it is drawn.
            if (v) setSelectionVisible(p2, true);
            syncSelectionVisibility(p2);
        });
        // FIND INTERACTIONS: one button, no settings. 5 A side chain to side
        // chain is the question people actually ask of a binding site, and the
        // any-atom half of the pair it replaces was mostly backbone running
        // past whatever it folds against.
        const nearBtn = byId('selectNearby');
        if (nearBtn) {
            nearBtn.addEventListener('click', (e) => {
                e.preventDefault();
                selectNearby(INTERACTION_CUTOFF_A, true);
            });
        }
        // ALIGN. The dropdown is a MENU OF ACTIONS, not a setting, so it snaps
        // back to its own label as soon as one is chosen - leaving it reading
        // "all to this" would claim a state the app does not hold, and pressing
        // it again would then be a no-op that looks like a repeat.
        const alignSel = byId('alignSelect');
        if (alignSel) {
            alignSel.addEventListener('change', () => {
                const mode = alignSel.value;
                alignSel.value = '';
                if (mode) runAlign(mode);
            });
        }
        // the protein form of the same control: two states, one switch - and on
        // a ligand row the same switch draws the ligand itself, which is the
        // visibility mask rather than a side chain nothing there owns
        onPair('sidechainPair', (p2, v) => {
            const lig = ligandRowPositions(p2);
            if (lig) { setSelectionVisible(lig, v); return; }
            // SHOW MEANS "DRAWN", AND THE MENU SAYS HOW. Switching on a
            // nucleotide brings back whichever way it was last drawn - the
            // plate unless the menu says otherwise - rather than jumping to the
            // atoms, which is not what a plain Show should decide.
            const r = selectionHost.renderer();
            const plate = byId('plateShowToggle');
            const nuc = !!(r && r.hasBasesFor && r.hasBasesFor(p2));
            const style = nuc ? ((plate && !plate.checked) ? 'full' : 'plate') : 'full';
            setSelectionSidechainMode(p2, v ? style : 'none');
        });
        // PLATE OR ATOMS, for a nucleotide that is being drawn at all. Show
        // owns whether; this owns which.
        onToggle('plateShowToggle', (p2, v) => {
            setSelectionSidechainMode(p2, v ? 'plate' : 'full');
        });
        // ...and the two buttons that replace the pair, each with one job
        const onPress = (id, fn) => {
            const el = byId(id);
            if (!el) return;
            el.addEventListener('click', withSelection((positions) => {
                fn(positions);
                updateSelectionToolsState();
            }));
        };
        onPress('contactAddButton', (p2) => addSelectionContact(p2));
        onPress('contactDeleteButton', (p2) => removeSelectionContact(p2));

        // Every surface that draws the selection listens here, so a change made
        // on ANY of them shows on all the others. The sequence strip used to be
        // missing: it redrew itself when IT cleared the selection, so clearing
        // from the 3D canvas left its yellow box behind.
        document.addEventListener('py2dmol-residue-selection-change', () => {
            // 🔴 THIS BUS IS document-SCOPED, so every viewer on the page hears
            // every viewer's selection change - and the capture hook above
            // cannot help, because the event is dispatched on `document` rather
            // than travelling through any container. Each listener claims its
            // own panel before it syncs, so what gets rebuilt is the panel
            // whose listener is running rather than whichever claimed last.
            claim();
            updateSelectionToolsState();
            // the selection is outlined by the renderer's own ink pass, so the
            // structure has to be redrawn when the selection changes
            if (selectionHost.renderer()) selectionHost.renderer().render('selection outline');
            // the strip draws the yellow box round the selected run
            if (window.SEQ?.updateColors) window.SEQ.updateColors();
            // the MSA dims to the selection, so it follows the same signal
            selectionHost.afterChange();
        });
        updateSelectionToolsState();
    }
}
