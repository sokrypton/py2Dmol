// ============================================================================
// src/app/objects.js
// ------------------
// AI Context: THE OBJECT LIST
// - One question: which objects are on screen. The list, its eyes, the picker,
//   and which object the panels below are acting on.
// ============================================================================
// ============================================================================
// THE OBJECT LIST
// ============================================================================
// ONE QUESTION: which objects are on screen.
//
// ONE OBJECT AT A TIME IS THE RESTING STATE, chosen with the dropdown in the
// sequence header - which is how the viewer has always worked, and loading a
// second file must not change it. Showing several is something the user asks
// for: press All, or light an eye in the list. All is literal - every object
// on, or every object off, and an empty canvas is a picture you are allowed to
// ask for.
//
// The list used to answer a second question too - which object is CURRENT, the
// one Copy, Delete, the side-chain toggles and the sequence strip act on - and
// with the shown set meaning "the current object", picking one in the list took
// the other off the screen: "when I click one it hides the other". That
// question belongs to the picker, where the thing it governs is visible.

function objectListEls() {
    return {
        btn: document.getElementById('objectListButton'),
        list: document.getElementById('objectList'),
        select: document.getElementById('objectSelect'),
    };
}

/** Which objects are drawn right now, as a Set the rows can be built from. */
function shownObjectSet(renderer) {
    return new Set(renderer.drawnObjects ? renderer.drawnObjects() : []);
}

/**
 * The Object colour mode is only offered when there is more than one object on
 * screen. With one, it colours everything the same - a scheme with no meaning,
 * which is worse than an absent one. Switched back to Auto if it was showing
 * when the second object went away.
 */
function syncObjectColorOption() {
    const renderer = viewerApi?.renderer;
    const sel = document.getElementById('colorSelect');
    if (!renderer || !sel) return;
    const opt = sel.querySelector('option[value="object"]');
    if (!opt) return;
    const many = (renderer.drawnObjects ? renderer.drawnObjects().length : 1) > 1;
    opt.hidden = !many;
    if (!many && sel.value === 'object') {
        sel.value = 'auto';
        sel.dispatchEvent(new Event('change'));
    }
}

/**
 * IS THE VIEWER IN MULTI MODE? The renderer's shown set answers it: null is
 * the resting state - one object on screen, the one the picker names, which is
 * how this viewer has always worked - and a Set is Multi, whatever is in it.
 * Nothing else records the mode, so it cannot disagree with the picture, and a
 * restored session comes back in the mode it was saved in.
 */
function objectMultiOn(renderer) {
    const r = renderer || viewerApi?.renderer;
    return !!(r && r.shownObjects instanceof Set);
}

/**
 * The button is a MODE, not a menu: pressed means Multi. The count is in the
 * list below it, which is open whenever Multi is on, so the face stays the one
 * word.
 */
function syncObjectListButton() {
    const { btn, list, select } = objectListEls();
    const renderer = viewerApi?.renderer;
    if (!btn || !renderer) return;
    const on = objectMultiOn(renderer);
    const total = Object.keys(renderer.objectsData || {}).length;
    const shown = renderer.drawnObjects ? renderer.drawnObjects().length : 1;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-on', on);
    btn.title = on
        ? `${shown} of ${total} objects on screen - click to go back to one`
        : 'Expand: show several objects at once';
    if (list) list.hidden = !on;
    // THE PICKER CHOOSES WHAT YOU ARE EDITING, in both modes. It used to grey
    // out in Multi, on the reasoning that with several objects on screen the
    // eyes decide what is drawn and the picker had no job left. It has one:
    // the style, the clip and the panels below all belong to ONE object, and
    // the picker is how you say which. In Multi it changes nothing about the
    // picture - the eyes still decide that - it changes what the controls act
    // on.
    if (select) {
        select.disabled = false;
        select.title = on
            ? 'Which object the controls below act on - the eyes decide what is drawn'
            : 'Which object to show and edit';
    }
}

function renderObjectList() {
    const { btn, list } = objectListEls();
    const renderer = viewerApi?.renderer;
    if (!list || !btn || !renderer) return;
    syncObjectListButton();
    if (list.hidden) return;

    const names = Object.keys(renderer.objectsData || {});
    const shown = shownObjectSet(renderer);
    list.innerHTML = '';

    for (const name of names) {
        const on = shown.has(name);
        const row = document.createElement('div');
        row.className = 'object-list-row' + (on ? '' : ' is-hidden');
        row.title = on ? 'Hide this object' : 'Show this object';

        const eye = document.createElement('span');
        eye.className = 'object-list-eye';
        eye.innerHTML = on
            ? '<i class="fa-regular fa-eye"></i>'
            : '<i class="fa-regular fa-eye-slash"></i>';

        const label = document.createElement('span');
        label.className = 'object-list-name';
        label.textContent = name;

        // ONLY THE EYE SWITCHES IT ON AND OFF. A row that toggled anywhere
        // along its length was one stray click away from taking a structure
        // off the screen.
        eye.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleObjectShown(name);
        });

        // ...AND THE NAME SELECTS IT, which is what the picker does: the
        // object whose style and settings the panels act on. Visibility and
        // selection are different questions and this row answers both, one
        // per half.
        const editing = name === renderer.currentObjectName;
        if (editing) row.classList.add('is-editing');
        label.title = editing
            ? 'The controls act on this object'
            : 'Edit this object - its style and settings';
        label.addEventListener('click', (e) => {
            e.stopPropagation();
            selectObjectForEditing(name);
        });

        // ...AND `sele` TAKES THE WHOLE OF IT. The third question a row can
        // answer: not what is drawn and not what is edited, but what is
        // SELECTED - so the panels, Focus, Copy and Cut can act on one
        // structure without dragging its whole sequence in the strip.
        const sele = document.createElement('span');
        sele.className = 'object-list-sele';
        sele.textContent = 'sele';
        sele.title = 'Select every residue of this object'
            + ' (press again to clear, shift-click to add another)';
        sele.setAttribute('aria-pressed', 'false');
        // 🔴 A LATCH, NOT A ONE-WAY DOOR. The button lights up while its
        // selection stands, and a lit button that does nothing when you press
        // it is the worst kind: it looks like the click was missed. Pressing
        // again clears, which is what Clip already does and what the arrow on
        // the button's own state promises.
        //
        // Asked of the SELECTION, not of the attribute: the attribute is the
        // answer syncObjectSeleState computed on the last selection change,
        // and one question with two answers is how they come to disagree.
        sele.addEventListener('click', (e) => {
            e.stopPropagation();
            // 🔴 SHIFT IS THE RELATIVE PAIR, and it toggles the OBJECT rather
            // than replacing the selection: shift-click a second row and both
            // structures are selected, shift-click a lit one and it drops out
            // while the others stay. Without the second half, shift could only
            // ever add and there would be no way to take one back except by
            // starting again.
            if (e.shiftKey) {
                selectWholeObject(name, covered(name) ? 'remove' : 'add');
                return;
            }
            // A plain click NARROWS to this object - and clears only when the
            // selection is already exactly that, which is the state the button
            // itself put you in. With two objects selected, clicking one means
            // "just this one", not "none".
            if (selectionIsExactlyObject(name)) clearObjectSelection();
            else selectWholeObject(name);
        });

        row.appendChild(eye);
        row.appendChild(label);
        row.appendChild(sele);
        list.appendChild(row);
    }
    syncObjectSeleState();
}

/**
 * WHICH `sele` IS ON, without rebuilding a row.
 *
 * 🔴 MUTATED, NEVER REBUILT. This runs on every selection change - which is
 * every click on the canvas and every step of a drag in the sequence strip -
 * and re-rendering the list would destroy the button the pointer is on.
 * Chrome fires `click` only when mousedown and mouseup share a live common
 * ancestor, so a rebuild between the two swallows the press: the play button
 * lost its icon that way ten times a second.
 *
 * A row is ON when the selection is EXACTLY that object's residues - the
 * state the button puts you in. Not "overlaps": a click that selects one
 * residue of an object would otherwise light the whole row, and the button
 * would look pressed while naming something it did not do.
 */
/**
 * TWO QUESTIONS, AND THE ROW LIGHTS ON THE WIDER ONE.
 *
 * `covered` is "every residue of this object is selected" - true for both rows
 * when two objects have been shift-selected, which is what the lit state has
 * to mean once more than one can be on at a time. It is still not "overlaps":
 * a click that selects ONE residue lights nothing, which is the rule the
 * single-object version was written for.
 *
 * `selectionIsExactlyObject` is the narrower one, and only the plain click
 * asks it - it is the state that click puts you in, and so the only state in
 * which pressing again can mean "let go".
 */
function objectWindow(name) {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.localRangeOf) return null;
    const win = renderer.localRangeOf(name);
    const total = (renderer.coords || []).length;
    const lo = win.off;
    const hi = Math.min(total, win.end === Infinity ? total : win.end);
    return hi > lo ? { lo, hi } : null;
}

function covered(name) {
    const sel = viewerApi?.renderer?.residueSelection;
    const w = objectWindow(name);
    if (!sel || !sel.size || !w) return false;
    for (let i = w.lo; i < w.hi; i++) if (!sel.has(i)) return false;
    return true;
}

function selectionIsExactlyObject(name) {
    const sel = viewerApi?.renderer?.residueSelection;
    const w = objectWindow(name);
    if (!sel || !w) return false;
    return sel.size === w.hi - w.lo && covered(name);
}

function syncObjectSeleState() {
    const renderer = viewerApi?.renderer;
    const { list } = objectListEls();
    if (!renderer || !list || list.hidden) return;
    for (const row of list.querySelectorAll('.object-list-row')) {
        const name = row.querySelector('.object-list-name')?.textContent;
        const btn = row.querySelector('.object-list-sele');
        if (!btn || !name) continue;
        const want = covered(name) ? 'true' : 'false';
        if (btn.getAttribute('aria-pressed') !== want) {
            btn.setAttribute('aria-pressed', want);
        }
    }
}

/**
 * ...AND LET IT GO AGAIN.
 *
 * `clearResidueSelection`, not `setResidueSelection` with an empty set: that
 * is the verb a click on the background calls, and the two are not the same
 * door - parts/ui.js wraps both for focus mode and only one of them means
 * "nothing is selected any more".
 */
function clearObjectSelection() {
    const r = viewerApi?.renderer;
    if (!r) return;
    r.clearResidueSelection();
    if (window.SEQ?.updateColors) window.SEQ.updateColors();
    r.render('unselect object');
}

/**
 * SELECT EVERY RESIDUE OF ONE OBJECT.
 *
 * 🔴 IT HAS TO BE ADDRESSABLE FIRST. `localRangeOf` answers
 * `{off: 0, end: Infinity}` whenever the merge is not enabled, and
 * `{0, total}` when it is but the name is not one of its sources - both
 * correct on their own terms, and both meaning "everything". So
 * a selector naming an object hands back the WHOLE array in either state,
 * and naming a row to get another row's residues is worse than the button
 * not being there.
 *
 * These rows only exist in Multi - syncObjectListButton hides the list
 * otherwise - so the usual case is a real slice and nothing has to move.
 * What is left is the window where Multi is on and the merge has not been
 * built yet, which a click can land in. There, switching makes the object
 * the only one in the arrays, and "everything" becomes the right answer by
 * construction. The select waits a frame because the switch goes through the
 * picker's change event and the coordinates are not the new object's until
 * it has settled.
 */
function selectWholeObject(name, mode) {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.coords) return;
    const ms = renderer.multiState;
    const addressable = !!(ms && ms.enabled && ms.sourceNames
        && ms.sourceNames.indexOf(name) >= 0);
    const take = () => {
        const r = viewerApi?.renderer;
        if (!r || !r.coords) return;
        // THROUGH THE RENDERER'S OWN VERB, beside clipTo and orientTo. A
        // shell that resolves a selector itself is a second copy of the
        // translation, and tests/interaction.js refuses one by name.
        r.selectTo({ object: name }, mode);
        if (window.SEQ?.updateColors) window.SEQ.updateColors();
        r.render('select object');
    };
    if (!addressable && renderer.currentObjectName !== name) {
        selectObjectForEditing(name);
        requestAnimationFrame(() => requestAnimationFrame(take));
        return;
    }
    take();
}

/**
 * EDIT THIS OBJECT - without changing what is on screen.
 *
 * Driven through the picker, like every other path that changes the current
 * object (the renderer listens to it), so there is one way in and the two
 * cannot disagree about which object is being edited.
 */
function selectObjectForEditing(name) {
    const select = document.getElementById('objectSelect');
    const renderer = viewerApi?.renderer;
    if (!select || !renderer || renderer.currentObjectName === name) return;
    if (select.value !== name) {
        select.value = name;
        select.dispatchEvent(new Event('change'));
    }
    renderObjectList();
}

/**
 * IN MULTI, PICKING AN OBJECT SHOWS IT.
 *
 * The two questions the object row answers - what is DRAWN (the eyes) and what
 * is being EDITED (the picker, or a row's name) - are deliberately separate,
 * but only one direction of that is useful: choosing to work on something you
 * cannot see is not a state anyone asks for. It reads as the picker being
 * broken, because nothing happens.
 *
 * The other direction stays as it was: switching an eye off does NOT stop you
 * editing that object, which is how you set its style and switch it back on to
 * look at it.
 *
 * ON THE EVENT, NOT IN handleObjectChange. That function is a SYNC - the
 * session restore calls it directly "to ensure the UI is fully updated" - and
 * the rule there added the restored object to the shown set every time a saved
 * session came back, which is a third object on screen that nobody asked for.
 * A change EVENT means somebody picked.
 */
function showPickedObject() {
    const renderer = viewerApi?.renderer;
    const select = document.getElementById('objectSelect');
    const want = select && select.value;
    if (!renderer || !want || !objectMultiOn(renderer)) return;
    const shown = shownObjectSet(renderer);
    if (shown.has(want)) return;
    shown.add(want);
    renderer.setShownObjects(Array.from(shown));
    afterShownObjectsChange();
}

/**
 * WHAT FOLLOWS A CHANGE TO WHAT IS ON SCREEN.
 *
 * The strip is one section per drawn object, so it is rebuilt - it is not a
 * repaint: the sections, their rows and their cells all change. The colour
 * mode, the button and the picker follow too.
 */
function afterShownObjectsChange() {
    // ...AND WHAT IS DRAWN DECIDES THE STYLE, when nobody has chosen one. Two
    // objects on screen can be an order of magnitude more structure than
    // either of them alone.
    tubeByDefaultForDrawn(viewerApi?.renderer);
    syncObjectColorOption();
    syncObjectListButton();
    renderObjectList();
    const seq = window.SEQ;
    if (seq && (seq.buildViewDeferred || seq.buildView)) {
        (seq.buildViewDeferred || seq.buildView)();
    }
    updateFrameNameLabel();
}

/** Show or hide one object. Only reachable in Multi, where the eyes decide. */
function toggleObjectShown(name) {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.setShownObjects) return;
    const shown = shownObjectSet(renderer);
    if (shown.has(name)) shown.delete(name);
    else shown.add(name);
    // ...including down to nothing: an empty list is an empty canvas, and the
    // objects are all still there to be switched back on.
    renderer.setShownObjects(Array.from(shown));
    afterShownObjectsChange();
}

/**
 * MULTI ON AND OFF.
 *
 * On, it opens on exactly what was already on screen - the object the picker
 * names - so pressing the button changes the picture not at all until an eye
 * is clicked. Off, the shown set is dropped entirely rather than trimmed to
 * one name: null is the resting state, and an object loaded later becomes the
 * one on screen the way it always did.
 */
function toggleObjectMulti() {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.setShownObjects) return;
    if (objectMultiOn(renderer)) {
        // ...KEEPING WHAT YOU WERE LOOKING AT, and framing on it. Switching an
        // eye never moves the camera - things appear and disappear where they
        // are - but leaving Multi is a mode change, and the one object that
        // stays would otherwise sit small and off to a side in a camera set to
        // hold several. If the object being edited is not one of the ones on
        // screen, the picture wins and the picker follows it: see
        // leaveMultiObject.
        const keep = renderer.leaveMultiObject
            ? renderer.leaveMultiObject()
            : (renderer.setShownObjects(null, false, { reframe: true }), null);
        if (keep) {
            const sel = document.getElementById('objectSelect');
            if (sel) {
                sel.value = keep;
                sel.dispatchEvent(new Event('change'));
            }
        }
    } else {
        const cur = renderer.currentObjectName;
        renderer.setShownObjects(cur ? [cur] : []);
    }
    afterShownObjectsChange();
}

/**
 * SHOW EVERYTHING, IN MULTI. What a drop of several files ends with.
 *
 * Dropping four structures and being shown one of them reads as three of
 * them having failed to load - the objects are there, the picker lists them,
 * and the canvas shows one. Turning Multi on and lighting every eye is what
 * "load all of them" means on screen.
 *
 * Through setShownObjects, the renderer's own setter, because that is what
 * keeps `_framedObjects` - assigning `shownObjects` by hand skips it and the
 * camera never widens to hold what just arrived.
 */
function showAllObjectsMulti() {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.setShownObjects) return false;
    const names = Object.keys(renderer.objectsData || {});
    if (names.length < 2) return false;
    renderer.setShownObjects(names);
    afterShownObjectsChange();
    return true;
}

function attachObjectList() {
    const { btn, select } = objectListEls();
    if (!btn || !select) return;
    btn.addEventListener('click', toggleObjectMulti);
    // ...AND `sele` FOLLOWS THE SELECTION, however it was made - a canvas
    // click, a drag in the sequence strip, Select all, another row's button.
    // A control that shows something the viewer is not doing is worse than no
    // control, which is a rule this project has three other instances of.
    // 🔴 SYNC, NOT RENDER: this fires on every step of a drag, and
    // renderObjectList rebuilds every row - which destroys the button the
    // pointer is on and swallows the click.
    document.addEventListener('py2dmol-residue-selection-change',
                              syncObjectSeleState);
    // WHAT IS ON SCREEN CAN CHANGE WITHOUT A CLICK IN THIS LIST - a restored
    // session, a Copy, the Python API - and so can which object is being
    // edited. Both labels follow the renderer rather than the buttons.
    document.addEventListener('py2dmol-color-change', () => {
        syncObjectColorOption();
        syncObjectListButton();
        // ...and the rows themselves, which show which objects are on screen
        renderObjectList();
        updateFrameNameLabel();
    });
    // OBJECTS ARE ADDED, RENAMED AND REMOVED FROM A DOZEN PLACES - a load, a
    // Copy, a Cut, a session restore - and every one of them goes through the
    // select's options. Watching those is one hook instead of a dozen, and it
    // cannot be forgotten by the next path that adds an object.
    if (typeof MutationObserver === 'function') {
        new MutationObserver(() => renderObjectList())
            .observe(select, { childList: true });
    }
    select.addEventListener('change', () => renderObjectList());
}

function handleObjectChange() {
    // a different object is a different set of frames, and frame 0 of the new
    // one may be the same INDEX as the old - so no frame-change event fires
    setTimeout(updateFrameNameLabel, 0);
    // ...and a different object has its own clip, which the panel has to show
    setTimeout(syncClipPanelToObject, 0);
    const objectSelect = document.getElementById('objectSelect');

    const selectedObject = objectSelect.value;
    if (!selectedObject) return;

    // Selection state is now managed per-object in the renderer's objectSelect change handler
    // Each object maintains its own selection state that is saved/restored automatically
    // No need to reset here - the renderer handles it

    // Sync MSA data from pendingObjects to renderer's objectsData if needed
    // This ensures MSA data is available even if it was added after initial load
    if (viewerApi?.renderer) {
        const pendingObj = pendingObjects.find(obj => obj.name === selectedObject);
        const rendererObj = viewerApi.renderer.objectsData[selectedObject];
        if (pendingObj && pendingObj.msa && rendererObj && !rendererObj.msa) {
            rendererObj.msa = pendingObj.msa;
        }
    }

    // After MSA is synced, remap entropy if MSA data now exists
    if (viewerApi?.renderer && selectedObject) {
        const rendererObj = viewerApi.renderer.objectsData[selectedObject];
        if (rendererObj && rendererObj.msa && rendererObj.msa.msasBySequence && rendererObj.msa.chainToSequence) {
            if (selectedObject && window.MSA) {
                // ...for everything DRAWN - see entropyForDrawn
                viewerApi.renderer.entropy = viewerApi.renderer.entropyForDrawn
                    ? viewerApi.renderer.entropyForDrawn()
                    : window.MSA.mapEntropyToStructure(rendererObj, viewerApi.renderer.currentFrame >= 0 ? viewerApi.renderer.currentFrame : 0);
                if (viewerApi.renderer._updateEntropyOptionVisibility) viewerApi.renderer._updateEntropyOptionVisibility();
            }
        }
    }

    if (viewerApi?.renderer && typeof viewerApi.renderer.updateHeatmapPanelVisibility === 'function') {
        viewerApi.renderer.updateHeatmapPanelVisibility();
    }

    // Clear preview selection when switching objects
    if (window.SEQ?.clearPreview) window.SEQ.clearPreview();

    // Rebuild sequence view for the new object
    window.SEQ?.buildView();
    // (no defaulting here — renderer already restored the object's saved selection)

    // Update MSA chain selector and container visibility for index.html
    if (window.updateMSAChainSelectorIndex) {
        window.updateMSAChainSelectorIndex();
    }
    if (window.updateMSAContainerVisibility) {
        window.updateMSAContainerVisibility();
    }

    refreshEntropyColors();
}




