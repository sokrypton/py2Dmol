// ============================================================================
// src/parts/multi.js
// --------------------------------
// AI Context: SEVERAL OBJECTS AS ONE (a part of Pseudo3DRenderer)
// - The merge: which objects are drawn, their positions concatenated into one
//   array, and the arithmetic for reading a merged index back to the object it
//   came from (ownerOf, sourceOffsetOf, localRangeOf, sourceGroups).
// - Per-object style, per-object visibility, per-object edits - everything that
//   has to answer whose? before it can answer anything else.
// - That the merge is REAL and not a composite is what buys shadowing, depth
//   sorting, picking and both GPU paths with no new code.
// ============================================================================
(function () {
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({
    name: 'multi',
    proto: {
        /**
         * WHICH OBJECTS THIS FRAME DRAWS, in the order they are drawn.
         *
         * One, today - and the callers ask through here rather than reading
         * currentObjectName so that the day it returns several, they already
         * do the right thing. `shownObjects` is the set the object list will
         * write to; anything not in objectsData is ignored rather than
         * dropped, because an object can be deleted while the set remembers
         * it.
         */
        drawnObjects() {
            const all = this.objectsData || {};
            const names = Object.keys(all);
            const want = this.shownObjects;
            if (want) {
                // AN EMPTY SET IS AN ANSWER: everything switched off, nothing on
                // screen. Only a set that names objects which have all been
                // deleted is stale, and falls through to the default.
                if (!want.size) return [];
                // the load order, so the list and the painting agree
                const out = names.filter((n) => want.has(n));
                if (out.length) return out;
            }
            // NULL MEANS THE ONE BEING EDITED, and that is the resting state:
            // one object on screen, chosen with the dropdown, exactly as it has
            // always been. Showing several is something the user asks for, by
            // pressing All or lighting an eye in the list - never something
            // that happens to them because a second file was loaded.
            return this.currentObjectName ? [this.currentObjectName] : [];
        },

        /**
         * WHOSE MATRIX THE PAE PANEL IS SHOWING, or null for none.
         *
         * A PAE matrix is a square over ONE structure's residues; there is no
         * such thing across two, and a row of it means a residue only once you
         * know which object it counts from. The panel was wired to the object
         * last LOADED and nothing re-asked when the drawn set changed, so
         * loading a structure with no PAE, then a prediction with one, then
         * hiding the prediction, left its matrix on screen describing residues
         * that were not - and a box drawn on it selected the other object's.
         *
         * IN MULTI THERE IS NO PANEL AT ALL. Not "the one object that has a
         * matrix", which is defensible and still leaves the reader working out
         * which structure in front of them the square belongs to. Multi is the
         * mode for looking at several things at once; the matrix belongs to
         * one, so it waits until the viewer is back to one.
         *
         * Outside Multi it is what it has always been: the object on screen,
         * when that object has a matrix.
         */
        paeObjectName() {
            const P = (typeof window !== 'undefined') ? window.PAE : null;
            if (!P) return null;
            // the shown set is a Set in Multi and null in the ordinary mode -
            // see setShownObjects
            if (this.shownObjects instanceof Set) return null;
            const cur = this.currentObjectName;
            const o = cur && this.objectsData ? this.objectsData[cur] : null;
            return (o && P.hasData(o)) ? cur : null;
        },

        /**
         * THE PER-OBJECT STATE TABLE, for the app's session save and restore.
         * One list, walked by every lifecycle operation - see OBJECT_STATE.
         */
        objectStateToJSON(object) { return objectStateToJSON(object); },

        objectStateFromJSON(object, saved) { objectStateFromJSON(object, saved); },

        /**
         * WHAT THE COORDINATE ARRAY IS SUPPOSED TO HOLD, as a string.
         *
         * Everything that builds the array - a frame load, a merge, an empty
         * canvas - records this afterwards in `_loadedKey`, and anything
         * thinking of skipping the work compares the two. The alternative,
         * which is what was here, is to REASON about it: "one object, and it
         * is the one being edited, so the ordinary path must already have it
         * loaded". That was true from every direction but one - the array had
         * just been emptied on purpose by switching every object off - and
         * lighting the eye again then drew nothing at all, for good.
         *
         * A recorded fact cannot be wrong in that way. It can only be
         * incomplete, so it names everything that decides the CONTENTS: which
         * objects, which frame of each, whether the overlay merge is up, and
         * how many side chains are materialised into it (they are appended
         * positions, so they change the array's length).
         *
         * It deliberately does NOT try to cover colours, contacts or anything
         * else that changes the picture without changing the array. Those
         * paths reload through reloadDrawn, which does not consult this.
         */
        _arrayKey() {
            const ov = !!(this.overlayState && this.overlayState.enabled);
            const parts = [];
            for (const n of this.drawnObjects()) {
                const o = this.objectsData[n];
                const f = (n === this.currentObjectName)
                    ? this.currentFrame
                    : ((o && o.viewerState && o.viewerState.currentFrame) || 0);
                parts.push(n + '#' + f);
            }
            const sc = this.shownSidechainSet ? this.shownSidechainSet() : null;
            return (ov ? 'overlay|' : 'frames|') + parts.join(',')
                + '|sc' + (sc ? sc.size : 0);
        },

        /**
         * WHAT THE ARRAY HOLDS AND WHAT IS IN IT - the one statement anything
         * caching something derived from the coordinates should key on.
         *
         * `_arrayKey` names the objects, their frames and the appended atoms;
         * three samples stand in for the coordinates themselves, which the
         * names cannot see MOVE - a live-mode replace() and an alignment both
         * do exactly that, same objects, same frame, same length. Every cache
         * that used to write out its own version of this list disagreed with
         * the others in some small way: the GPU mesh key kept only the array's
         * length, the tube's kept its identity (which is a different array for
         * the same picture, so every eye toggle rebuilt), and the secondary
         * structure's could not see a coordinate swap at all - which is why
         * _invalidateSegmentCache has to reach in and clear it by hand.
         */
        _coordsKey() {
            const co = this.coords;
            const n = co ? co.length : 0;
            let s = '';
            for (const i of [0, n >> 1, n - 1]) {
                const p = n ? co[i] : null;
                if (p) s += (((p.x + p.y * 3 + p.z * 7) * 1000) | 0) + ',';
            }
            return this._arrayKey() + '|' + n + ':' + s;
        },

        /**
         * HOW LONG THE ARRAY IS BEFORE THE SIDE-CHAIN ATOMS. Everything keyed
         * by residue counts up to here; the atoms live past it.
         */
        _baseCount() {
            const n = this.coords ? this.coords.length : 0;
            const map = this.sidechainMap;
            return (map && map.size) ? Math.max(0, n - map.size) : n;
        },

        /** Record what was just loaded. Called by everything that builds it. */
        _noteArrayLoaded() {
            this._loadedKey = this._arrayKey();
            // ...AND THAT THE CAMERA HAS NOW SEEN THESE OBJECTS. Anything that
            // has been in the array has been framed for once; switching its
            // eye afterwards must leave the camera exactly where it is, so
            // that things appear and disappear where they are rather than the
            // picture rescaling under the pointer. Only a file just LOADED is
            // new to the camera - addObject drops its name from this - and
            // only that widens the view.
            for (const n of this.drawnObjects()) this._framedObjects.add(n);
        },

        /**
         * WHICH OBJECTS ARE ON SCREEN. The list UI writes here.
         *
         * Names not loaded are ignored rather than an error - an object can be
         * deleted while a saved session still names it. An empty set, or one
         * naming nothing that exists, falls back to the current object: the
         * viewer never shows nothing because a list went stale.
         *
         * @returns {boolean} whether the picture changed
         */
        setShownObjects(names, skipRender = false, opts = {}) {
            const all = this.objectsData || {};
            const before = this.drawnObjects().join(' ');
            // NULL RESETS TO THE DEFAULT - the object being edited, on its own.
            // An array is authoritative, including an empty one, which is every
            // object switched off and an empty canvas.
            if (names === null || names === undefined) {
                this.shownObjects = null;
            } else {
                const live = names.filter((n) => all[n]);
                // A LIST THAT NAMES ONLY OBJECTS WHICH ARE GONE is stale - a
                // restored session, a deleted object - and means the default,
                // not "show nothing". Asking for nothing is passing nothing.
                this.shownObjects = (names.length && !live.length)
                    ? null : new Set(live);
            }
            const after = this.drawnObjects().join(' ');
            if (before === after) return false;
            this._applyShownObjects(skipRender, opts);
            return true;
        },

        /**
         * LEAVE MULTI, KEEPING WHAT YOU WERE LOOKING AT.
         *
         * Two questions have separate answers in Multi - what is on screen is
         * the eyes, what is being edited is where you last clicked in the
         * strip - and they are allowed to disagree: you can be looking at one
         * structure while editing another. Dropping back to one object at a
         * time has to reconcile them, and it used to do it by keeping the
         * EDITED one, so pressing Multi off swapped the picture for a
         * different structure. Everything that structure had - its side
         * chains, its colours, its hidden backbone - went off screen with it,
         * which reads exactly like the choices not being recovered.
         *
         * What you were looking at wins. The edited object keeps the job when
         * it is one of the things on screen; otherwise the first drawn object
         * takes it. With nothing on screen at all there is nothing to keep, so
         * the edited object is what comes back.
         *
         * @returns {string|null} an object the caller must switch to, or null
         *   when the edited object was already the right answer
         */
        leaveMultiObject() {
            const drawn = this.drawnObjects();
            const keep = (drawn.indexOf(this.currentObjectName) >= 0)
                ? this.currentObjectName : drawn[0];
            this.shownObjects = null;
            if (!keep || keep === this.currentObjectName) {
                this._applyShownObjects(false, { reframe: true });
                return null;
            }
            // THE MERGE IS OVER BEFORE THE SWITCH, so the switch is a real one:
            // _switchToObject deliberately freezes the camera, the clip, the
            // style and the mask while several objects are on screen, and the
            // object being switched TO here is the only one left.
            this._dropMergeState();
            return keep;
        },

        /**
         * Load whatever drawnObjects() now says, as ONE coordinate array.
         *
         * One object is loaded exactly as it always was - the merge path is not
         * entered at all, so the ordinary single-object case cannot be slowed
         * down or subtly changed by code it never runs.
         */
        _applyShownObjects(skipRender = false, opts = {}) {
            const names = this.drawnObjects();
            const ms = this.multiState;
            // AN EMPTY CANVAS HAS NO CAMERA WORTH HOLDING. Everything below
            // holds the view still for an object it has already framed, so
            // that an eye makes things appear and disappear where they are -
            // but that argument is about a picture you can see. With nothing
            // on screen there is no "where they are", and the first eye lit
            // was left drawing into whatever framing the last thing happened
            // to use: switch a ribosome and a peptide both off, light the
            // ribosome, and it was drawn at the peptide's scale, 3,200 px off
            // the side of a 1,200 px canvas. A blank window, with the object
            // reported as drawn.
            //
            // Asked of the coordinate array rather than of the bookkeeping:
            // the array is what is on screen.
            const wasEmpty = !(this.coords && this.coords.length);
            const reframe = !!opts.reframe || wasEmpty;

            // NOTHING ON SCREEN, because every object was switched off. The
            // coordinate array is emptied rather than the objects unloaded:
            // the panels, the sequence strip and the picker all go on working
            // on the object being edited, and lighting an eye brings it back.
            if (!names.length) {
                this._dropMergeState();
                this.coords = [];
                this.segmentIndices = [];
                this._invalidateScreenProjection();
                this._invalidateSegmentCache();
                this._invalidateShadowCache();
                this._noteArrayLoaded();
                this._syncPaeToDrawn();
                if (!skipRender) this.render('nothing shown');
                return;
            }

            // ONE OBJECT, AND IT IS THE ONE BEING EDITED: the ordinary path,
            // untouched. Any other single object goes through the merge, which
            // is what knows how to draw an object that is not the current one.
            if (names.length === 1 && names[0] === this.currentObjectName) {
                // ...IF THE ARRAY ALREADY HOLDS IT. Asked of the record of
                // what was last loaded (see _arrayKey), not reasoned about
                // from which path we are on: reasoning is what left this
                // returning without loading anything after every object had
                // been switched off, so lighting an eye again drew nothing at
                // all, for good.
                if (!ms.enabled) {
                    if (this._loadedKey === this._arrayKey()) return;
                    // ...and from an empty canvas, framed on what is coming
                    // back, for the reason given at the top of this method.
                    const own = this.objectsData[this.currentObjectName];
                    if (reframe && own && own.center) {
                        this.viewerState.center = { x: own.center[0],
                            y: own.center[1], z: own.center[2] };
                        this.viewerState.extent = own.maxExtent || null;
                    }
                    this._loadFrameData(this.currentFrame >= 0 ? this.currentFrame : 0,
                        skipRender);
                    // ...AND THE MASK FROM THIS OBJECT'S OWN RECORD. The live
                    // one describes the array that was just replaced: showing
                    // a 68-residue structure and then a 574-residue one left
                    // it naming positions 0..67, and two thirds of the second
                    // structure was simply not drawn.
                    this._applyRecordVisibility(skipRender);
                    return;
                }
                const carriedOut = this._selectionAsOwners();
                this._dropMergeState();
                this._invalidateSegmentCache();
                this._invalidateShadowCache();
                // ...AND THE CAMERA HOLDS STILL, unless this object is new to
                // it or the caller asked. Switching every eye off but one is
                // an eye being switched, and an eye makes things appear and
                // disappear where they are: re-framing here was the last place
                // the picture still jumped, because dropping to one object
                // takes this branch rather than the merge below. Leaving Multi
                // passes reframe, and then a camera set to hold two structures
                // does not leave the one that is left small and off to a side.
                const one = this.currentObjectName;
                const back = this.objectsData[one];
                if (back && back.center
                        && (reframe || !this._framedObjects.has(one))) {
                    this.viewerState.center = { x: back.center[0], y: back.center[1],
                        z: back.center[2] };
                    this.viewerState.extent = back.maxExtent || null;
                }
                // THE FRAME IS HELD BACK UNTIL THE STATE IS WHOLE. Loading
                // with a render of its own painted the picture before the
                // selection had been carried across and before the mask had
                // been composed, so leaving Multi with a selection dropped its
                // highlight until something else happened to redraw - measured
                // at 8,946 yellow pixels missing, and they stayed missing.
                this._loadFrameData(this.currentFrame, true);
                this._restoreSelectionFromOwners(carriedOut);
                // ...and the mask from this object's own record, for the same
                // reason as the branch above: the live one is a set of indices
                // into the merged array that has just been replaced, so a
                // residue hidden in the merge would hide whichever residue of
                // this object now has that number.
                this._applyRecordVisibility(true);
                this._syncPaeToDrawn();
                if (!skipRender) this.render('one object again');
                return;
            }

            // THE TWO MERGES ARE EXCLUSIVE. Overlay puts every frame of one
            // object in the array; this puts one frame of every shown object.
            // Both at once is a cross product nobody asked for, and one
            // sourceGroups() answer cannot describe it.
            if (this.overlayState.enabled) {
                const cur = this.objectsData[this.currentObjectName];
                this._leavingOverlayForMerge = true;
                try {
                    if (cur) this._exitOverlayMode(cur, this.currentFrame, true);
                } finally {
                    this._leavingOverlayForMerge = false;
                }
            }

            // WHAT EACH OBJECT HAD HIDDEN is read from its own record, which
            // every visibility change keeps up to date in that object's own
            // numbering - see _saveVisibilityToObjects. Snapshotting the LIVE
            // mask here instead looked equivalent and was not: on a plain load
            // the mask still describes the object that was on screen a moment
            // ago while currentObjectName is already the new one, so the whole
            // of the old object's mask was attributed to the new one and the
            // old one vanished from the picture with its eye showing open.
            const sameSources = !!(ms.enabled && ms.sourceNames
                && ms.sourceNames.length === names.length
                && ms.sourceNames.every((n, k) => n === names[k]));

            const merged = this._mergeObjects(names);
            if (!merged) return;

            ms.enabled = true;
            ms.sourceIdMap = merged.sourceIdMap;
            ms.sourceNames = merged.sourceNames;
            ms.sourceOffsets = merged.sourceOffsets;
            ms.sourceFrames = merged.sourceFrames;
            ms.sourceAutoColors = merged.sourceAutoColors;
            ms.autoColor = merged.autoColor;
            ms.stats = this._mergedStats(merged.coords);
            // FRAME ON THE LOT WHEN SOMETHING NEW ARRIVES, and not otherwise.
            //
            // The camera has to move for an object it has never seen - a file
            // just loaded is out of shot otherwise - but switching an eye is
            // not that. Re-framing on every change to the drawn set meant the
            // picture jumped and rescaled each time an object was switched off
            // and on: "I want to see things appear and disappear", not zoom.
            // A rebuild for a frame step or a side chain never re-framed, for
            // the same reason.
            //
            // _framedObjects is what the camera has already accommodated;
            // addObject drops a name from it, so a re-fetched object counts as
            // new again.
            const fresh = names.filter((nm) => !this._framedObjects.has(nm));
            for (const nm of names) this._framedObjects.add(nm);
            if (ms.stats && (reframe || fresh.length)) {
                this.viewerState.center = { x: ms.stats.center[0],
                    y: ms.stats.center[1], z: ms.stats.center[2] };
                this.viewerState.extent = ms.stats.maxExtent;
            }
            this._sourceGroupsCache = null;
            this._mergedSetCache = null;
            this.lastOperationMode = 'multi-object';
            this._invalidateSegmentCache();
            this._invalidateShadowCache();
            this.lastShadowRotationMatrix = null;
            // THE SELECTION FOLLOWS ITS RESIDUES. It is a set of indices into
            // the array being replaced, so it is carried across as (object,
            // local index) pairs and put back where those residues have landed
            // - anything belonging to an object that is no longer drawn is
            // dropped, and nothing else is. Clearing outright meant that
            // switching one object off threw away a selection made on the one
            // still on screen.
            const carried = sameSources ? null : this._selectionAsOwners();
            this._loadDataIntoRenderer(merged, true);
            this._noteArrayLoaded();
            if (carried) this._restoreSelectionFromOwners(carried);
            this._syncPaeToDrawn();
            this._applyMergedVisibility(merged, skipRender);
        },

        /** Hand the PAE panel the matrix of whatever paeObjectName() names. */
        _syncPaeToDrawn() {
            if (window.PAE && window.PAE.syncToDrawn) window.PAE.syncToDrawn(this);
        },

        /**
         * The name src/app/ has always called after loading or switching an
         * object - and which nothing defined, so three call sites guarded with
         * `typeof ... === 'function'` had been doing nothing for as long as
         * they have existed. It is exactly the moment the panel needs asking
         * again, so it is the sync.
         */
        updatePAEContainerVisibility() {
            this._syncPaeToDrawn();
        },

        /**
         * THE CENTRE AND SIZE OF WHAT IS ON SCREEN, which is not the current
         * object's once more than one is drawn.
         *
         * The camera frames on these: the view scale divides by the extent, the
         * shadow grid is sized by it, and the ortho slider reads the spread.
         * Left as the current object's, a second object beside it is simply
         * out of frame - which is what the first run of this looked like:
         * both structures merged, mapped and coloured correctly, and LESS ink
         * on screen than one of them alone.
         *
         * Shaped like an object on purpose - center, maxExtent, stdDev,
         * totalPositions, globalCenterSum - so every reader takes it in place
         * of one with no other change.
         */
        drawnStats() {
            const ms = this.multiState;
            if (ms && ms.enabled && ms.stats) return ms.stats;
            return this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
        },

        /** The same numbers _recomputeObjectStats gives an object, for a merge. */
        _mergedStats(coords) {
            const n = coords ? coords.length : 0;
            if (!n) return null;
            let cx = 0; let cy = 0; let cz = 0;
            for (let i = 0; i < n; i++) {
                cx += coords[i][0]; cy += coords[i][1]; cz += coords[i][2];
            }
            cx /= n; cy /= n; cz /= n;
            let maxSq = 0; let sumSq = 0;
            for (let i = 0; i < n; i++) {
                const dx = coords[i][0] - cx;
                const dy = coords[i][1] - cy;
                const dz = coords[i][2] - cz;
                const d = dx * dx + dy * dy + dz * dz;
                if (d > maxSq) maxSq = d;
                sumSq += d;
            }
            return {
                center: [cx, cy, cz],
                maxExtent: Math.sqrt(maxSq),
                stdDev: Math.sqrt(sumSq / n),
                totalPositions: n,
                globalCenterSum: new Vec3(cx * n, cy * n, cz * n)
            };
        },

        /**
         * EVERY SHOWN OBJECT'S OWN VISIBILITY, in merged indices.
         *
         * The mask is a set of position indices, and each object's was written
         * against its own array. Loaded merged and left alone, the mask of the
         * object that happened to be current still names 0..k - so the second
         * object, sitting past the end of it, is entirely hidden. That is what
         * the first working merge looked like: both structures in the array,
         * both mapped, both coloured, and only one of them on screen.
         *
         * An object nobody has hidden anything in contributes all of itself.
         */
        /**
         * A SET OF POSITIONS, PLUS THE SIDE-CHAIN ATOMS HANGING OFF THEM.
         *
         * A shown side chain is real positions APPENDED to the coordinate
         * array, past everything the frame itself holds. Anything that talks
         * about residues and is then used as a mask has to take them along, or
         * the atoms are left out of the picture their residue is in.
         *
         * There were three copies of this rule - the materialiser's own
         * `follow`, the panel's `withAtoms`, and the merged mask's - and the
         * merged one did not exist at all until every side chain in a merge
         * was found to vanish whenever an eye was clicked. One rule now, with
         * three callers.
         *
         * @param {Set<number>} set
         * @param {boolean} inPlace mutate the set given, rather than copying
         */
        withSidechainAtoms(set, inPlace = false) {
            const map = this.sidechainMap;
            if (!set || !map || !map.size) return set;
            const out = inPlace ? set : new Set(set);
            for (const [idx, e] of map) {
                if (e && out.has(e.owner)) out.add(idx);
            }
            return out;
        },

        /**
         * WHICH STYLE ONE OBJECT IS DRAWN IN.
         *
         * The style has always travelled with the object (see _switchToObject:
         * "what is right for a ribosome is not right for the peptide beside
         * it"), but only one of them could be on screen at a time, so the
         * renderer kept a single `style` and swapped it on the way in and out.
         * With several objects merged into one array they can be drawn in
         * DIFFERENT styles at once, and this is the question the painters ask.
         *
         * `this.style` is still the answer for an object that has never been
         * given one of its own - a freshly loaded file, before the size rule
         * has had its say.
         */
        styleForObject(name) {
            const o = this.objectsData && this.objectsData[name];
            const st = o && (o.style
                || (o.viewerState && o.viewerState.style));
            return (st === 'cartoon' || st === 'tube') ? st : this.style;
        },

        /** ...and give one object a style of its own. */
        setStyleForObject(name, style) {
            const o = this.objectsData && this.objectsData[name];
            if (!o || (style !== 'cartoon' && style !== 'tube')) return false;
            if (o.style === style) return false;
            o.style = style;
            // the saved view carries it too, because that is what a switch back
            // to single-object mode reads
            if (o.viewerState) o.viewerState.style = style;
            this._invalidateSegmentCache();
            return true;
        },

        /**
         * THE DRAWN OBJECTS, GROUPED BY THE STYLE EACH IS DRAWN IN.
         *
         * Two groups and never more, because there are two painters. Empty
         * lists are kept out, so `groups.length === 1` is "one style on
         * screen" - the ordinary case, and the only one the 2D path can draw.
         */
        drawnStyleGroups() {
            const by = new Map();
            for (const n of this.drawnObjects()) {
                const st = this.styleForObject(n);
                if (!by.has(st)) by.set(st, []);
                by.get(st).push(n);
            }
            return by;
        },

        /**
         * THE MERGED POSITIONS THAT BELONG TO THESE OBJECTS, side-chain atoms
         * included - they are appended past every source's range and answer for
         * the residue they grow out of (see withSidechainAtoms).
         *
         * With nothing merged the array IS one object's, so the answer is
         * everything or nothing.
         */
        positionsOfObjects(names) {
            const want = new Set(names);
            const total = this._positionCount();
            const ms = this.multiState;
            const out = new Set();
            if (!ms || !ms.enabled || !ms.sourceNames) {
                if (want.has(this.currentObjectName)) {
                    for (let i = 0; i < total; i++) out.add(i);
                }
                return out;
            }
            const base = this._baseCount();
            for (let s = 0; s < ms.sourceNames.length; s++) {
                if (!want.has(ms.sourceNames[s])) continue;
                const from = ms.sourceOffsets[s];
                const to = (s + 1 < ms.sourceOffsets.length)
                    ? ms.sourceOffsets[s + 1] : base;
                for (let i = from; i < to; i++) out.add(i);
            }
            return this.withSidechainAtoms(out, true);
        },


        /**
         * COMPOSE THE LIVE MASK FROM THE OBJECTS' OWN RECORDS, and apply it.
         *
         * Called whenever the coordinate array is rebuilt - by the merge, and
         * by the ordinary single-object path, which did NOT do this and drifted
         * for it: show a 68-residue structure alone, switch to a 574-residue
         * one, and the live mask still named positions 0..67, so two thirds of
         * the second structure was invisible. The mask means nothing except
         * against the array it was built for; the records mean something
         * against their own object, which is why they are what survives.
         *
         * @param {Array<string>} names the drawn objects, in array order
         * @param {Array<number>} offsets where each starts
         * @param {number} n the array's length BEFORE side-chain atoms
         */
        _applyRecordVisibility(skipRender = false) {
            this._composeAndApplyMask(skipRender);
            this._syncModelToMask();
        },

        /**
         * THE LIVE MODEL FOLLOWS THE MASK - it does not write it.
         *
         * `visibilityModel` is the editing buffer the selection panel, the
         * sequence strip and the PAE matrix all read and write; the records
         * are what survives a rebuild. After a rebuild the buffer has to
         * describe the new array, and this is where it is brought up to date.
         *
         * IT USED TO GO THE OTHER WAY. The rebuild composed a mask from the
         * records and pushed it back through setVisibility with `paeBoxes: []`
         * - which saved it into every object's record, wiping the boxes and
         * dropping the mode to default. A box drawn on a prediction survived
         * exactly until the next eye click.
         */
        _syncModelToMask() {
            const vm = this.visibilityModel;
            if (!vm) return;
            const total = (this.coords && this.coords.length) || 0;
            vm.positions = this.visiblePositions
                ? new Set(this.visiblePositions)
                : (() => { const all = new Set(); for (let i = 0; i < total; i++) all.add(i); return all; })();
            // resolved into positions above: a chain id means one thing per
            // object and the mask spans several
            vm.chains = new Set();
            // ...and the BOXES stay the current object's own, because that is
            // whose matrix the panel is showing (see paeObjectName).
            const own = this.objectsData && this.objectsData[this.currentObjectName];
            vm.paeBoxes = ((own && own.visibilityState && own.visibilityState.paeBoxes) || [])
                .map((b) => ({ ...b }));
            vm.visibilityMode = (this.visiblePositions === null) ? 'default' : 'explicit';
        },

        /** The merge's share of that: one call, from what it just built. */
        _applyMergedVisibility(merged, skipRender = false) {
            this._applyRecordVisibility(skipRender);
        },



        // COPY, CUT AND DELETE RUN ON ONE OBJECT AT A TIME - see
        // _editOneObject - but a SELECTION can reach several, so each of them
        // runs once per object the selection touches. Silently taking only the
        // edited object's share was the alternative, and a Cut that quietly
        // leaves half the selection behind is worse than one that refuses.
        //
        // Wrapped rather than taught the merge: each renumbers half a dozen
        // things keyed by position index, all written against a single
        // object's array.
        //
        // @returns {Array} what each object gave back, in drawing order
        _perObjectEdit(fn) {
            const names = this.objectsInSelection();
            if (names.length <= 1) {
                return [this._editOneObject(() => fn(), names[0])];
            }
            // THE SELECTION IS PUT BACK BEFORE EACH ONE. An edit consumes it -
            // it is narrowed to that object's share, and Copy leaves its own
            // behind - so the second object would be handed whatever the first
            // one finished with, and get nothing of its own.
            const carried = this._selectionAsOwners();
            this._lastEditMade = null;
            const out = [];
            for (const name of names) {
                this._restoreSelectionFromOwners(carried);
                out.push(this._editOneObject(() => fn(), name));
            }
            // ...AND END ON WHAT WAS MADE, the way a single-object Copy always
            // has: it switches to the object it makes. Each object's turn puts
            // the edited object back so the next one starts clean, so the
            // switch happens once, here, when they are all done.
            if (this._lastEditMade && this.objectsData[this._lastEditMade]) {
                this._showObject(this._lastEditMade);
            }
            this._lastEditMade = null;
            return out;
        },

        extractSelection() {
            const made = this._perObjectEdit(() => this._extractSelection())
                .filter(Boolean);
            // ONE NAME BACK for one object, so nothing that called this before
            // has to change; the list is there for a caller that wants to
            // report all of them.
            return made.length > 1 ? made : (made[0] || null);
        },

        deleteSelection() {
            return this._perObjectEdit(() => this._deleteSelection())
                .some(Boolean);
        },

        cutSelection() {
            const made = this._perObjectEdit(() => this._cutSelection())
                .filter(Boolean);
            if (!made.length) return null;
            if (made.length === 1) return made[0];
            return {
                name: made.map((m) => m.name).join(', '),
                names: made.map((m) => m.name),
                removed: made.reduce((n, m) => n + (m.removed || 0), 0)
            };
        },

        /**
         * IS THERE MORE THAN ONE OBJECT TO DRAW? The merge is not a mode the
         * user turns on: it is simply what drawing two things at once means,
         * and every path that loads coordinates asks this rather than checking
         * whether a merge happens to be up already.
         */
        _mergeWanted() {
            const drawn = this.drawnObjects();
            return drawn.length !== 1 || drawn[0] !== this.currentObjectName;
        },

        /**
         * FILE THE LIVE MASK UNDER THE OBJECT OR OBJECTS IT DESCRIBES.
         *
         * Every visibility change is written through to the object, so that
         * switching away and back finds it where it was left. With several
         * objects merged the mask describes ALL of them, in merged indices -
         * saved whole under whichever object happens to be current, it writes
         * another object's hidden residues into this one's record, and reading
         * it back hides most of the picture. Measured on a plain load of two
         * structures: 348 positions visible out of 433, all of them the first
         * object's, and the second invisible with its eye showing open.
         *
         * Each object gets its own share, in its own numbering.
         */
        _saveVisibilityToObjects() {
            const vm = this.visibilityModel;
            if (!vm) return;
            const ms = this.multiState;
            if (ms && ms.enabled && ms.sourceNames) {
                for (const nm of ms.sourceNames) {
                    const o = this.objectsData[nm];
                    if (!o) continue;
                    o.visibilityState = {
                        positions: this._maskForObject(nm) || new Set(),
                        // chain ids collide across objects, so the chain half
                        // of a merged mask means nothing per object - it is
                        // resolved into positions when the merge is built
                        chains: new Set(),
                        paeBoxes: (nm === this.currentObjectName)
                            ? vm.paeBoxes.map((b) => ({ ...b }))
                            : ((o.visibilityState && o.visibilityState.paeBoxes) || []),
                        visibilityMode: vm.visibilityMode
                    };
                }
                return;
            }
            if (this.currentObjectName && this.objectsData[this.currentObjectName]) {
                this.objectsData[this.currentObjectName].visibilityState = {
                    positions: new Set(vm.positions),
                    chains: new Set(vm.chains),
                    paeBoxes: vm.paeBoxes.map((box) => ({ ...box })),
                    visibilityMode: vm.visibilityMode
                };
            }
        },

        /**
         * RELOAD WHAT IS DRAWN, whichever that is.
         *
         * Side chains, bases and elements all change the coordinate array
         * rather than just its colours, so the panel reloads the frame after
         * writing one. Reloading the FRAME while several objects are merged
         * throws the other objects off the screen; the merge has its own way
         * back in, and this is the one call the UI needs to know about.
         */
        reloadDrawn(skipRender = false) {
            if ((this.multiState && this.multiState.enabled) || this._mergeWanted()) {
                this._applyShownObjects(skipRender);
                return;
            }
            this._loadFrameData(this.currentFrame >= 0 ? this.currentFrame : 0, skipRender);
        },

        /**
         * THE SELECTION AS (OBJECT, LOCAL INDEX) PAIRS, which survive a change
         * of array; merged indices do not.
         */
        _selectionAsOwners() {
            const sel = this.residueSelection;
            if (!sel || !sel.size) return null;
            const out = [];
            for (const i of sel) {
                const o = this.ownerOf(i);
                out.push(o ? [o.name, o.local] : [this.currentObjectName, i]);
            }
            return out;
        },

        /**
         * ...and back, into whatever array is loaded now. A residue whose
         * object is no longer drawn has no index to come back to and is
         * dropped; everything else lands where it now lives.
         */
        _restoreSelectionFromOwners(pairs) {
            if (!pairs) return;
            const out = new Set();
            for (const [name, local] of pairs) {
                const off = this.sourceOffsetOf(name);
                const drawn = this.drawnObjects();
                if (drawn.indexOf(name) < 0) continue;
                const at = off + local;
                if (at >= 0 && at < this.coords.length) out.add(at);
            }
            this.residueSelection = out.size ? out : null;
        },

        /**
         * The selection, restricted to one object and in ITS numbering.
         *
         * `residueSelection` is a set of merged indices; an edit rewrites one
         * object's frames and knows nothing about the merge.
         */
        selectionForObject(name) {
            const sel = this.residueSelection;
            if (!sel || !sel.size) return null;
            const ms = this.multiState;
            if (!ms || !ms.enabled) return new Set(sel);
            const out = new Set();
            for (const i of sel) {
                const o = this.ownerOf(i);
                if (o && o.name === name) out.add(o.local);
            }
            return out.size ? out : null;
        },

        /**
         * The visibility mask, likewise: one object's share, in its numbering.
         *
         * AN EMPTY SET IS AN ANSWER. "Nothing of this object is visible" is
         * what Hide all gives, and it has to be distinguishable from "no mask
         * here" - which is read as "all of it" by the caller. Null is returned
         * only when there is no live mask at all.
         */
        _maskForObject(name) {
            const set = this.visibilityModel && this.visibilityModel.positions;
            if (!set) return null;
            const ms = this.multiState;
            if (!ms || !ms.enabled) return new Set(set);
            const out = new Set();
            for (const i of set) {
                const o = this.ownerOf(i);
                if (o && o.name === name) out.add(o.local);
            }
            return out;
        },

        /**
         * WHICH OBJECTS A SELECTION REACHES, in drawing order.
         *
         * Copy, Cut and Delete are per object - each rewrites one object's
         * frames - but a selection is not: with several structures on screen a
         * drag, a Within, or two clicks reach into more than one of them.
         */
        objectsInSelection() {
            const sel = this.residueSelection;
            if (!sel || !sel.size) return [];
            const seen = new Set();
            for (const i of sel) {
                const o = this.ownerOf(i);
                seen.add(o ? o.name : this.currentObjectName);
            }
            return this.drawnObjects().filter((n) => seen.has(n));
        },

        /**
         * RUN A STRUCTURAL EDIT ON THE CURRENT OBJECT ALONE.
         *
         * Copy, Cut and Delete rewrite an object's frames and renumber
         * everything keyed to them - the mask, the side chains, the contacts,
         * the MSA columns. All of that is written against the object's own
         * array, and all of it would be handed merged indices instead, so
         * Delete would remove somebody else's residues or none at all.
         *
         * Rather than teach each of those the merge, the merge is put down for
         * the duration and picked up again after: the edit then runs on exactly
         * the array it was written for. The selection and the mask are
         * translated down with it, and the shown set is restored at the end -
         * including the object a Copy just made, which is the one thing the
         * user will be looking for.
         */
        _editOneObject(fn, name) {
            const ms = this.multiState;
            const editing = name || this.currentObjectName;
            if (!ms || !ms.enabled) {
                if (editing === this.currentObjectName) return fn();
                // ...an object that is not the current one still has to BE the
                // current one for the duration: every one of these paths reads
                // currentObjectName to find the frames it rewrites.
                const was = this.currentObjectName;
                this.currentObjectName = editing;
                try { return fn(); } finally { this.currentObjectName = was; }
            }
            const shown = this.shownObjects ? Array.from(this.shownObjects) : [];
            const sel = this.selectionForObject(editing);
            const mask = this._maskForObject(editing);

            const wasCurrent = this.currentObjectName;
            this.currentObjectName = editing;
            this.setShownObjects([editing], true);
            this.residueSelection = (sel && sel.size) ? sel : null;
            if (this.visibilityModel) {
                this.visibilityModel.positions = mask || new Set();
            }

            let out = null;
            try {
                out = fn();
            } finally {
                // ...and back, minus anything the edit removed, plus whatever
                // it made: a Copy that lands off screen looks like a Copy that
                // did not happen.
                // ...BACK TO THE OBJECT THAT WAS BEING EDITED, so the next
                // object's turn starts from a known place. What an edge MADE
                // is switched to by the caller, once, after every object has
                // had its turn - see _perObjectEdit.
                const made = this.currentObjectName;
                if (made && made !== editing && this.objectsData[made]) {
                    this._lastEditMade = made;
                }
                if (wasCurrent && this.objectsData[wasCurrent]) {
                    this.currentObjectName = wasCurrent;
                }
                const back = shown.filter((n) => this.objectsData[n]);
                if (made && this.objectsData[made] && !back.includes(made)) {
                    back.push(made);
                }
                if (back.length) this.setShownObjects(back);
            }
            return out;
        },

        /**
         * WHAT COUNTS AS ONE CHAIN, ANYWHERE: colour, visibility, selection.
         *
         * Chain ids are only unique inside a file: put two structures on screen
         * and both have a chain A, which under the chain scheme comes out the
         * same colour for both - a dimer beside a dimer reading as one
         * four-chain thing. So the key carries the OBJECT with the id.
         *
         * BY NAME, NOT BY POSITION IN THE MERGE. Keyed by which source it
         * happened to be, an object's colours changed every time something else
         * was switched on or off - it is source 0 alone and source 1 beside
         * another, and those are different palette slots. Reported as a clash
         * in both viewers, and it was: the same molecule, two colours, decided
         * by what else was on screen.
         *
         * Plain chain ids while only ONE object is loaded, which is every
         * single-structure session and leaves those colours exactly as they
         * have always been.
         *
         * EVERYTHING that asks "is this position in that chain" asks through
         * here - the visibility mask, the chain buttons in the strip, the PAE
         * map. Keyed by the bare id, selecting chain A of one object selected
         * chain A of the other, which is what a bare id MEANS once two files
         * are on screen. `this.chains` stays the bare id: it is what the file
         * said, and what the panel prints.
         */
        chainKeyAt(i) {
            if (!this._chainColorKeys) return this.chains[i] || 'A';
            return this._chainColorKeys[i];
        },

        /** The same key, for a chain of a named object rather than a position. */
        chainKeyFor(chainId, objectName) {
            const names = Object.keys(this.objectsData || {});
            if (names.length < 2) return chainId;
            const name = objectName || this.currentObjectName;
            return name ? (name + '|' + chainId) : chainId;
        },

        /**
         * A PALETTE SLOT FOR EVERY CHAIN OF EVERY LOADED OBJECT, whether or
         * not it is on screen.
         *
         * Built over what is LOADED rather than what is drawn, for two
         * reasons: an object's colours must not move when its neighbour is
         * switched off, and the sequence strip asks for the colours of the
         * object it is showing, which may be hidden.
         *
         * EACH OBJECT NUMBERS ITS OWN CHAINS FROM ZERO. The slots used to run
         * in one sequence across every loaded object, so an object's colours
         * depended on WHAT WAS LOADED BEFORE IT: a ribosome opened in one set
         * of chain colours on its own and a different set if a peptide was
         * loaded first, every chain shifted by the peptide's chain count.
         *
         * That running sequence was there to keep two merged objects from
         * sharing chain colours - two molecules reading as one, which is a
         * report of its own (see tests/multi_object.py). The two cannot both
         * hold, and stability won: a structure has to look the same every time
         * you open it. In a merge, telling two objects apart is what the
         * per-object 'auto' colouring does, which is what Multi picks anyway.
         */
        _buildChainIndexMap() {
            const all = this.objectsData || {};
            const names = Object.keys(all);
            const many = names.length > 1;
            const map = new Map();
            // one counter per object, so nothing an object gets depends on its
            // neighbours - not their chain count, and not the order they loaded
            const slots = new Map();
            const add = (owner, key) => {
                if (!key || map.has(key)) return;
                const at = slots.get(owner) || 0;
                map.set(key, at);
                slots.set(owner, at + 1);
            };
            for (const name of names) {
                const fr = all[name] && all[name].frames && all[name].frames[0];
                const chs = (fr && fr.chains) || [];
                for (const c of [...new Set(chs)].sort()) {
                    add(name, many ? (name + '|' + c) : c);
                }
            }
            // ...and anything the LOADED array has that frame 0 did not - a
            // later frame with an extra chain, a side chain appended under a
            // chain of its own. Appended after its own object's chains rather
            // than renumbered, so nothing above moves.
            const n = this.chains ? this.chains.length : 0;
            for (let i = 0; i < n; i++) {
                const key = this.chainKeyAt(i);
                if (!key) continue;
                const bar = key.indexOf('|');
                add(bar > 0 ? key.slice(0, bar) : this.currentObjectName, key);
            }
            this.chainIndexMap = map;
        },

        /**
         * How many positions the loaded array holds. Both arrays describe it,
         * and the panel paths run with only the second one present.
         */
        _positionCount() {
            if (this.coords && this.coords.length) return this.coords.length;
            return this.positionTypes ? this.positionTypes.length : 0;
        },

        /**
         * WHICH OBJECT A MERGED POSITION BELONGS TO, and where it sits in that
         * object's own numbering.
         *
         * Everything an object remembers about its residues - which show side
         * chains, which show base plates, which are hidden, what colour they
         * were given, what secondary structure was forced on them - is a set or
         * a map keyed by POSITION INDEX, written against that object's own
         * array. Merged, only the first object still numbers from zero. This is
         * the one place that knows the difference, and every reader of those
         * sets goes through it or through mergedObjectSet below.
         *
         * A side-chain atom answers for the residue it grows out of: it was
         * appended after the merge, so its own index is past every source's
         * range and means nothing to the object it belongs to.
         *
         * @returns {{name, local, source, frame}|null} null when nothing is
         *   merged, which is the caller's signal that indices are already the
         *   object's own.
         */
        ownerOf(i) {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) return null;
            if (this.sidechainMap && this.sidechainMap.has(i)) {
                i = this.sidechainMap.get(i).owner;
            }
            const g = this.sourceGroups();
            const s = g ? g[i] : -1;
            if (!(s >= 0) || s >= ms.sourceNames.length) return null;
            return {
                name: ms.sourceNames[s],
                local: i - ms.sourceOffsets[s],
                source: s,
                frame: ms.sourceFrames ? ms.sourceFrames[s] : 0
            };
        },

        /**
         * A PER-OBJECT SET OF POSITIONS, READ IN MERGED INDICES.
         *
         * The sets come in two polarities and both have to survive the merge:
         *
         *   'none' - null means the object has none of this (side chains, a
         *            hidden backbone). An untouched object contributes nothing.
         *   'all'  - null means the object has all of it (base plates, element
         *            colours: on until somebody switches one off). An untouched
         *            object contributes its whole range, because the merged
         *            answer has to be a set the moment ANY object has one.
         *
         * Returns null only when every shown object is untouched - which is
         * what keeps "nobody has asked" distinguishable from "everything was
         * switched off", a distinction both polarities depend on.
         *
         * Cached by the identity of the sets it was built from, because the
         * drawing asks per segment and the GPU signature asks per frame.
         *
         * @param {string} field  the property on the object
         * @param {'all'|'none'} nullMeans  what an absent set means
         */
        /**
         * ...and what an ABSENT set means is the field's own business, not the
         * caller's: no side chains are shown by default while every base and
         * every element is, so a caller passing the wrong one inverts the
         * feature for merged objects only. The answer is in OBJECT_STATE.
         */
        mergedObjectSet(field, nullMeans = objectStateAbsent(field)) {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const o = this.objectsData?.[this.currentObjectName];
                const set = o && o[field];
                return (set instanceof Set) ? set : null;
            }
            const parts = ms.sourceNames.map(
                (n) => (this.objectsData[n] || {})[field]);
            const cache = this._mergedSetCache || (this._mergedSetCache = {});
            const hit = cache[field];
            if (hit && hit.names === ms.sourceNames && hit.parts.length === parts.length
                && hit.parts.every((p, k) => p === parts[k])) {
                return hit.out;
            }

            const total = this._positionCount();
            let touched = false;
            const out = new Set();
            for (let s = 0; s < ms.sourceNames.length; s++) {
                const off = ms.sourceOffsets[s];
                const end = (s + 1 < ms.sourceOffsets.length)
                    ? ms.sourceOffsets[s + 1] : total;
                const set = parts[s];
                if (set instanceof Set) {
                    touched = true;
                    for (const p of set) {
                        const at = p + off;
                        if (at >= off && at < end) out.add(at);
                    }
                } else if (nullMeans === 'all') {
                    for (let i = off; i < end; i++) out.add(i);
                }
            }
            const res = touched ? out : null;
            cache[field] = { names: ms.sourceNames, parts, out: res };
            return res;
        },

        /**
         * The entropy vector for what is on screen: one value per position,
         * each object's own alignment mapped onto its own residues and the
         * lot concatenated. One object's vector laid over a merged array
         * would colour the second object by the first one's conservation.
         */
        entropyForDrawn() {
            if (!window.MSA || !window.MSA.mapEntropyToStructure) return undefined;
            const frame = this.currentFrame >= 0 ? this.currentFrame : 0;
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const o = this.objectsData?.[this.currentObjectName];
                return o ? window.MSA.mapEntropyToStructure(o, frame) : undefined;
            }
            const out = [];
            for (let s = 0; s < ms.sourceNames.length; s++) {
                const o = this.objectsData[ms.sourceNames[s]];
                const off = ms.sourceOffsets[s];
                const end = (s + 1 < ms.sourceOffsets.length)
                    ? ms.sourceOffsets[s + 1] : this._positionCount();
                const v = o ? window.MSA.mapEntropyToStructure(
                    o, ms.sourceFrames ? ms.sourceFrames[s] : 0) : null;
                for (let i = off; i < end; i++) {
                    // -1 is what the colour path reads as "no entropy here"
                    out.push((v && v[i - off] !== undefined) ? v[i - off] : -1);
                }
            }
            return out;
        },

        /**
         * THE LIGAND GROUPS OF EVERY SHOWN OBJECT, in merged indices.
         *
         * A group is a Map from a key - chain, residue number, name - to the
         * position indices of one ligand's atoms. Keys collide across objects
         * for the same reason chain ids do, so each is prefixed with the object
         * it came from; the indices are offset like everything else.
         */
        /**
         * ONE OBJECT'S LIGAND GROUPS, derived from the frame it holds.
         *
         * Ask for them; do not read a field. See ligandGroupsForFrame - the
         * answer follows the frames, so an edit cannot leave it stale.
         */
        ligandGroupsOf(name) {
            const o = (typeof name === 'string') ? this.objectsData?.[name] : name;
            const f = o && o.frames && o.frames[0];
            return ligandGroupsForFrame(f);
        },

        mergedLigandGroups() {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const g = this.ligandGroupsOf(this.currentObjectName);
                return (g && g.size) ? g : null;
            }
            const parts = ms.sourceNames.map((n) => this.ligandGroupsOf(n));
            const c = this._mergedLigCache;
            if (c && c.names === ms.sourceNames && c.parts.length === parts.length
                && c.parts.every((p, k) => p === parts[k])) {
                return c.out;
            }
            const out = new Map();
            for (let s = 0; s < ms.sourceNames.length; s++) {
                const g = parts[s];
                if (!g || !g.size) continue;
                const off = ms.sourceOffsets[s];
                for (const [key, idxs] of g.entries()) {
                    out.set(ms.sourceNames[s] + '|' + key, idxs.map((i) => i + off));
                }
            }
            const res = out.size ? out : null;
            this._mergedLigCache = { names: ms.sourceNames, parts, out: res };
            return res;
        },

        /**
         * The object a write to these positions should land on, and the
         * positions in ITS numbering.
         *
         * A panel edits whatever is selected, and in a merged view a selection
         * can reach two objects at once. Grouped here so a setter writes each
         * object's own set rather than pushing merged indices into one of them.
         *
         * @param {Iterable<number>} positions merged indices
         * @returns {Array<{object, name, positions:number[]}>},
         */
        writeGroups(positions) {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const name = this.currentObjectName;
                const object = name ? this.objectsData[name] : null;
                return object ? [{ object, name, positions: Array.from(positions) }] : [];
            }
            const by = new Map();
            for (const i of positions) {
                const o = this.ownerOf(i);
                if (!o) continue;
                if (!by.has(o.name)) by.set(o.name, []);
                by.get(o.name).push(o.local);
            }
            const out = [];
            for (const [name, local] of by) {
                const object = this.objectsData[name];
                if (object) out.push({ object, name, positions: local });
            }
            return out;
        },

        /**
         * That object's positions, in ITS numbering: [0, n) for a lone object,
         * and the slice of the merged array it occupies otherwise. Setters that
         * materialise a full set - "every nucleotide", "every element owner" -
         * need to do it per object, not over the whole merged array.
         */
        localRangeOf(name) {
            const ms = this.multiState;
            const total = this._positionCount();
            // A LONE OBJECT OWNS EVERYTHING, however long the array turns out
            // to be. Answering with a counted length instead means every path
            // that runs before the coordinates are in - the panel's, in
            // particular - materialises an empty set and reads as "nothing
            // here" rather than "all of it".
            if (!ms || !ms.enabled || !ms.sourceNames) return { off: 0, end: Infinity };
            const s = ms.sourceNames.indexOf(name);
            if (s < 0) return { off: 0, end: total };
            return {
                off: ms.sourceOffsets[s],
                end: (s + 1 < ms.sourceOffsets.length) ? ms.sourceOffsets[s + 1] : total
            };
        },

        /** Forget the merge, without touching what is loaded. */
        _dropMergeState() {
            const ms = this.multiState;
            if (!ms) return;
            ms.enabled = false;
            ms.sourceIdMap = null;
            ms.sourceNames = null;
            ms.sourceOffsets = null;
            ms.sourceFrames = null;
            ms.sourceAutoColors = null;
            ms.autoColor = null;
            ms.stats = null;
            this._sourceGroupsCache = null;
            this._mergedSetCache = null;
            this._mergedLigCache = null;
        },

        /**
         * Where an object's positions start in the merged array. Every set
         * that is keyed by position index - side chains, bases, elements, the
         * selection - is written against its own object and read against this.
         *
         * @param {string} name
         * @returns {number} the offset, or 0 when nothing is merged
         */
        sourceOffsetOf(name) {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) return 0;
            const at = ms.sourceNames.indexOf(name);
            return at < 0 ? 0 : ms.sourceOffsets[at];
        },

        /**
         * THE RESIDUES WHOSE SIDE CHAINS ARE SWITCHED ON, in merged indices.
         *
         * `obj.sidechains` is a set of position indices meaningful against its
         * own object. Merged, every object after the first sits at an offset,
         * so read raw the second object's set would grow side chains on the
         * FIRST object's residues - visibly, and on the wrong atoms.
         */
        shownSidechainSet() {
            const ms = this.multiState;
            if (!ms || !ms.enabled || !ms.sourceNames) {
                const obj = this.objectsData?.[this.currentObjectName];
                return (obj && obj.sidechains) || null;
            }
            const out = new Set();
            for (let s = 0; s < ms.sourceNames.length; s++) {
                const set = this.objectsData?.[ms.sourceNames[s]]?.sidechains;
                if (!set) continue;
                const off = ms.sourceOffsets[s];
                for (const p of set) out.add(p + off);
            }
            return out.size ? out : null;
        },

        /**
         * WHICH POSITIONS ARE ALLOWED TO BE PART OF THE SAME THING.
         *
         * The coordinate array can hold more than one structure at a time -
         * every frame of a trajectory in overlay mode, or several objects in a
         * multi-object view - and in both cases a position may only bond,
         * count along a chain, and cast a shadow WITHIN its own source. The two
         * merges therefore answer to one array here rather than each gating its
         * own copy of those rules, which is how the overlay came to have four
         * such gates and a fifth one it was missing.
         *
         * SIDE CHAINS ARE APPENDED AFTER THE MERGE, so the map is SHORTER than
         * the coordinate array whenever any are showing. Read raw, every one of
         * those atoms comes back undefined - which compares equal to every
         * other undefined, so they all silently become one extra source that
         * bonds to itself and shades itself. Each appended atom is given its
         * owning residue's source instead, and the extension is cached against
         * the map it was built from.
         *
         * @returns {Array|null} one source id per position, or null when the
         *   array holds a single structure and every position may reach any
         *   other.
         */
        sourceGroups() {
            const n = this.coords ? this.coords.length : 0;
            const ov = this.overlayState;
            const ms = this.multiState;
            let base = null;
            if (ov && ov.enabled && ov.frameIdMap) base = ov.frameIdMap;
            else if (ms && ms.enabled && ms.sourceIdMap) base = ms.sourceIdMap;
            if (!base || !n) return null;
            if (base.length === n) return base;
            // A map LONGER than the array is stale - the merge it describes is
            // not the one loaded - and guessing which part of it still applies
            // would cut the structure somewhere arbitrary.
            if (base.length > n) return null;

            const c = this._sourceGroupsCache;
            if (c && c.base === base && c.out.length === n) return c.out;

            const out = base.slice ? Array.from(base) : Array.prototype.slice.call(base);
            const map = this.sidechainMap;
            for (let i = base.length; i < n; i++) {
                const owner = map && map.get(i) ? map.get(i).owner : undefined;
                // No owner means nothing here knows where the position came
                // from; give it a source of its own rather than fold it into
                // somebody else's, so a stray bond is visible instead of wrong.
                out.push((owner !== undefined && owner < base.length)
                    ? base[owner] : -(i + 1));
            }
            this._sourceGroupsCache = { base, out };
            return out;
        },
    },
});
})();