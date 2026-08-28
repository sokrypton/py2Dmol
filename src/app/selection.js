// ============================================================================
// src/app/selection.js
// --------------------
// AI Context: WHAT IS SELECTED, AND WHAT THE PANEL DOES WITH IT
// - The selection panel: colour, secondary structure, side chains, elements,
//   bases, contacts, visibility, Find interactions, Align. Plus the state
//   readers the panel syncs from - getActiveSelection, visibleState,
//   syncSelectionToggles, updateSelectionToolsState.
// - Every one of these looks its own DOM up by id. That is why they came out of
//   setupEventListeners cleanly: tools/free_vars.js measured the whole block at
//   ZERO enclosing-scope locals, closing over nothing but setStatus and
//   viewerApi, both module scope in main.js.
// ============================================================================
function getActiveSelection() {
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
    if (!renderer) return;
    // ...per owning object and in its numbering, like the residue colours
    for (const g of (renderer.writeGroups ? renderer.writeGroups(positions)
        : [{ object: renderer.objectsData?.[renderer.currentObjectName],
            positions: Array.from(positions) }])) {
        const obj = g.object;
        if (!obj) continue;
        const map = obj.sidechainColor ? { ...obj.sidechainColor } : {};
        for (const i of g.positions) {
            if (color === null) delete map[i];
            else map[i] = color;
        }
        obj.sidechainColor = Object.keys(map).length ? map : null;
    }
    renderer.colorsNeedUpdate = true;
    renderer.plddtColorsNeedUpdate = true;
    document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
    renderer.render('selection sidechain colour');
}

// Secondary structure override. Lives on the renderer as a plain
// index -> letter map; cartoon/geom.js applies it to BOTH the geometry
// and the colour pass, and its contents are part of the SS cache key so an
// edit invalidates cleanly.
function setSelectionSse(positions, letter) {
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    commitContacts(viewerApi.renderer, found.obj, contacts);
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
    commitContacts(viewerApi.renderer, found.obj, contacts);
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
    commitContacts(viewerApi.renderer, found.obj, contacts);
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
    const renderer = viewerApi?.renderer;
    if (!renderer) return;
    if (on && !renderer.sidechains) {
        setStatus('No side-chain atoms in this structure (a backbone-only model has none).');
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
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const pair = document.getElementById(id);
    if (!pair) return;
    const [on, off] = pair.querySelectorAll('.selection-switch-btn');
    if (!on || !off) return;
    on.classList.toggle('is-on', state === true);
    off.classList.toggle('is-on', state === false);
    on.setAttribute('aria-pressed', state === true ? 'true' : 'false');
    off.setAttribute('aria-pressed', state === false ? 'true' : 'false');
}

function syncSelectionToggles(picked, none) {
    const renderer = viewerApi?.renderer;
    const obj = renderer?.objectsData?.[renderer.currentObjectName];
    const list = picked || [];
    const set = (id, state) => {
        const el = document.getElementById(id);
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
    const scSel = document.getElementById('plateShowToggle');
    const scTog = document.getElementById('sidechainPair');
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
    const elTog = document.getElementById('elementsShowToggle');
    if (elTog) {
        const wrap = elTog.closest ? elTog.closest('label') : null;
        (wrap || elTog).hidden = ligPos
            ? (ligShown !== true || !ligEl) : mode !== 'full';
    }
    // WHAT THE ROW IS CALLED. "Side chains" over a ligand's own controls
    // names something the selection has not got - and the swatch means the
    // ligand's colour there, which is why it stays: see the picker's own
    // dispatch on ligandRowPositions.
    const scRowEl = document.getElementById('sidechainRow');
    if (scRowEl) {
        const lbl = scRowEl.querySelector('.selection-panel-label');
        if (lbl) lbl.textContent = ligPos ? 'Ligand' : 'Side chains';
        const swatch = scRowEl.querySelector('.selection-color-wrap');
        if (swatch) swatch.hidden = false;
        // ...and what the two controls SAY they do, since what they do
        // changed with the row. A tooltip promising side chains over a
        // ligand is the same wrong label as the row's own name was.
        const tip = (el, text) => { if (el) el.title = text; };
        tip(document.getElementById('scColorButton'), ligPos
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
    const mcRow = document.getElementById('mainchainRow');
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
    const addBtn = document.getElementById('contactAddButton');
    const binBtn = document.getElementById('contactDeleteButton');
    if (addBtn) addBtn.hidden = hasContact;
    if (binBtn) binBtn.hidden = !hasContact;
}

// Element colours, per residue. A pure repaint - the atoms and bonds are
// already there, only what colour a bond's halves take changes.
function setSelectionElements(positions, on) {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.setElementsFor) return;
    if (!renderer.setElementsFor(positions, on)) return;   // nothing to redraw
    renderer.render('selection elements');
}

// HOW A SELECTION'S SIDE CHAINS ARE DRAWN: none, the nucleic plate, or the
// real atoms. One control, because the three are alternatives - a pair of
// toggles cannot say "one or the other", and with the plate on its own row
// the panel had two rows called Side chain.
function setSelectionSidechainMode(positions, mode) {
    const renderer = viewerApi?.renderer;
    if (!renderer) return;
    const t = renderer.positionTypes || [];
    const nuc = positions.filter((i) => t[i] === 'D' || t[i] === 'R');
    // the plate is nucleic only; a protein asked for it gets nothing drawn
    // rather than a control that silently does something else
    if (mode === 'plate' && !nuc.length) {
        setStatus('Only nucleotides have a base plate.');
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
    const renderer = viewerApi?.renderer;
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
    const row = document.getElementById('alignRow');
    const sel = document.getElementById('alignSelect');
    if (!row || !sel) return;
    const r = viewerApi?.renderer;
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
    const r = viewerApi?.renderer;
    const sel = document.getElementById('alignSelect');
    if (!r) return;
    if (mode === 'none') {
        const n = r.clearAlignments();
        setStatus(n ? `${n} object${n === 1 ? '' : 's'} back to file coordinates`
            : 'nothing was aligned');
        updateSelectionToolsState();
        return;
    }
    if (sel) sel.disabled = true;
    try {
        setStatus('Aligning...');
        r.onAlignProgress = (done, total) => setStatus(`Aligning ${done}/${total}...`);
        const out = await r.alignToSelection(mode);
        r.onAlignProgress = null;
        // What the last run actually did, for the probe: whether it got a
        // worker is not visible in the picture and not visible in the
        // status line, and it is the half of this feature most likely to
        // fail silently by falling back to the main thread for good.
        window.__alignResult = { ref: out.ref, inWorker: out.inWorker,
            results: out.results, skipped: out.skipped };
        const res = out.results;
        if (!res.length) { setStatus('nothing could be aligned', true); return; }
        // ONE LINE, and it says the thing you would check: how good the fit
        // is. For a single object that is its own numbers; for several it
        // is the range, because listing four objects' scores is four lines
        // in a panel that has room for one.
        const fmt = (x) => x.toFixed(2);
        if (res.length === 1) {
            const a = res[0];
            setStatus(`${a.name} ${a.chain} to ${out.ref}: TM ${fmt(a.tm)},`
                + ` RMSD ${a.rmsd.toFixed(1)} A over ${a.aligned}`);
        } else {
            const tms = res.map((a) => a.tm);
            setStatus(`${res.length} objects to ${out.ref}: TM `
                + `${fmt(Math.min(...tms))}-${fmt(Math.max(...tms))}`);
        }
        updateSelectionToolsState();
    } catch (e) {
        r.onAlignProgress = null;
        setStatus(String((e && e.message) || e), true);
    } finally {
        if (sel) sel.disabled = false;
    }
}

function selectNearby(cutoff, sidechainsOnly) {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.residuesWithin) return;
    const sel = renderer.residueSelection;
    const seed = sel ? (sel instanceof Set ? sel : new Set(sel)) : null;
    if (!seed || !seed.size) {
        setStatus('Select something first, then Within finds what is near it.');
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
            setStatus('Nothing selected has a side chain to measure from.');
            return;
        }
        setStatus(`Nothing else within ${cutoff} \u00c5 (${what}).`);
        return;
    }
    renderer.setResidueSelection(found);
    setStatus(`${added} more residue${added === 1 ? '' : 's'} within ${cutoff} \u00c5`
        + ` ${what} - ${found.size} selected.`);
}

// THE BACKBONE OF THE SELECTED RESIDUES. Not the same question as hiding
// them: hiding takes the side chain too, and this leaves it. Stored on the
// OBJECT beside `sidechains` and `bases`, and a pure DRAWING change - the
// positions are all still there, so this is a repaint (the GPU recaptures,
// because prims that are not built cannot be in a mesh).
function setSelectionBackbone(positions, on) {
    const renderer = viewerApi?.renderer;
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
    const renderer = viewerApi?.renderer;
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
    const tools = document.getElementById('selectionTools');
    if (!tools) return;
    const picked = getActiveSelection();
    const none = picked === null;
    // THE PANEL IS THE STATE. It appears with a selection and goes away
    // without one, so there is never a row of controls that do nothing.
    // The old arrangement kept them visible but greyed, on the argument
    // that hiding them left no hint they existed - but they now live in
    // their own panel beside the structure, and a panel sliding in is a
    // louder cue than five buttons changing opacity in a header.
    const panel = document.getElementById('selectionPanel');
    // ...AND NOT IN FOCUS MODE. There is always a selection in there - the
    // residue you just clicked - so the panel would slide in and stay in,
    // beside a mode whose whole point is to look at one thing. Its buttons act
    // on the selection, and in focus the selection is the mode's own bookmark
    // rather than something the reader built up to act on.
    const inFocus = !!(viewerApi?.renderer?._focusMode);
    if (panel) panel.hidden = none || inFocus;
    // HOW MANY, AND ACROSS HOW MANY OBJECTS - and no more than that. The
    // count changes what pressing a button does, so it earns its place;
    // the residue ranges beside it ("A 11-13, 20-21; B 5, 7") did not. In
    // a 340px panel they were set small, ran past the edge of the head and
    // were cut short, and the tooltip that held the rest is not something
    // anybody hovers a header for. The strip below shows what is selected,
    // in the place made for showing it.
    const count = document.getElementById('selectionPanelCount');
    if (count) {
        if (none) {
            count.textContent = '';
            count.title = '';
        } else {
            const r = viewerApi?.renderer;
            const across = (r && r.objectsInSelection) ? r.objectsInSelection() : [];
            count.textContent = `${picked.length} residue${picked.length === 1 ? '' : 's'}`
                + (across.length > 1 ? ` in ${across.length} objects` : '');
            count.title = '';
        }
    }
    // A contact is a line between a PAIR: nothing to draw for one residue or
    // for five, so the row is offered only for exactly two. Within it the
    // toggle's STATE says whether the pair is joined - which is what the
    // Add/Remove pair could only say by which of the two was showing.
    const contactRow = document.getElementById('contactRow');
    const pair = !none && picked.length === 2;
    if (contactRow) contactRow.hidden = !pair;
    syncAlignRow(picked, none);
    if (pair) {
        const found = findContact(picked);
        const has = !!found;
        const swatch = document.getElementById('contactColorButton');
        // nothing to colour or size until there is a contact
        if (swatch) swatch.parentElement.hidden = !has;
        const wSlider = document.getElementById('contactWidthSlider');
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
    const scRow = document.getElementById('sidechainRow');
    if (scRow) {
        const renderer = viewerApi?.renderer;
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
    const divider = document.getElementById('selActionDivider');
    if (divider) {
        const scR = document.getElementById('sidechainRow');
        const mcR = document.getElementById('mainchainRow');
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
    const ssHide = document.getElementById('selSsSelect');
    if (ssHide) {
        const renderer = viewerApi?.renderer;
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
    const unselectBtn = document.getElementById('clearAllResidues');
    if (unselectBtn) unselectBtn.disabled = none;
    // The swatches show the SELECTION's colour rather than the last colour
    // picked, so they are refreshed from the same place the enabled state
    // is and never go stale.
    if (window.refreshSelectionSwatches) window.refreshSelectionSwatches();
}
window.updateSelectionToolsState = updateSelectionToolsState;
