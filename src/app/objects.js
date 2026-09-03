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

        row.appendChild(eye);
        row.appendChild(label);
        list.appendChild(row);
    }
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

function attachObjectList() {
    const { btn, select } = objectListEls();
    if (!btn || !select) return;
    btn.addEventListener('click', toggleObjectMulti);
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




