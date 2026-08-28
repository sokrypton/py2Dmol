// ============================================================================
// src/parts/focus.js
// --------------------------------
// AI Context: FOCUS - one click, one neighbourhood (a part of Pseudo3DRenderer)
// - focusOn(selector): pick it, draw the side chains of everything within
//   reach of it, move IN on it, and cut a slab around it. clearFocus() undoes
//   all four.
// - IT DOES NOT ROTATE. The camera keeps its angle and only its centre and its
//   zoom move, so clicking from residue to residue walks THROUGH a structure
//   instead of spinning it. That is the whole difference between this and
//   Orient, which chooses an angle and flies there.
// - Every step is an existing verb - residuesWithin, the object's sidechains
//   set, viewerState.center/extent, autoClip - and this is the composition.
// ============================================================================
(function () {
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({
    name: 'focus',
    proto: {
        /**
         * WHAT COUNTS AS THE NEIGHBOURHOOD. 5 A is the app's Find-interactions
         * cutoff and the reason is written there: a hydrogen bond is under
         * 3.5 and a salt bridge under 4, and past about 6 the answer is
         * everything in the neighbourhood. One number, so the two agree.
         */
        focusCutoffA() {
            return 5;
        },

        /**
         * EVERYTHING THE MODE IS ABOUT TO BORROW, in one record.
         *
         * Focus is a MODE, and a mode that leaves anything of its own behind
         * is worse than no mode: a reader who turns it off wants the picture
         * they had, not that picture plus five side chains and a slab. So the
         * snapshot is taken when the mode is ENTERED rather than on the first
         * click, and it covers everything the mode itself changes - what was
         * selected, what side chains each object was showing, the slab, and
         * the camera's centre and zoom.
         *
         * NOT the rotation, which is the one thing in the camera that focus
         * never touches. If it moved, the reader moved it, and it is theirs to
         * keep on the way out.
         */
        _focusSnapshot() {
            const sidechains = new Map();
            for (const name of Object.keys(this.objectsData || {})) {
                const obj = this.objectsData[name];
                if (!obj) continue;
                sidechains.set(name, obj.sidechains instanceof Set
                    ? new Set(obj.sidechains) : null);
            }
            return {
                sidechains,
                clip: (typeof this.clipSlabOn === 'function' && this.clipSlabOn())
                    ? { near: this.clipNear, far: this.clipFar } : null,
                center: this.viewerState.center
                    ? Object.assign({}, this.viewerState.center) : null,
                extent: this.viewerState.extent,
                extentAspect: this.viewerState.extentAspect,
                zoom: this.viewerState.zoom,
                // NOT THE ROTATION. Everything else here is something the mode
                // BORROWS - it drew those side chains, it cut that slab, it
                // moved that centre - and giving back what you borrowed is the
                // whole rule. An angle the reader turned to while inside the
                // mode is not borrowed, it is theirs: they looked at the
                // pocket from the other side because that is where they wanted
                // to be, and snapping back on the way out throws away the one
                // thing focus never touched on its own.
                selection: this.residueSelection instanceof Set
                    ? new Set(this.residueSelection) : null,
                // ...AND HOW A SELECTION IS MARKED, because the mode changes
                // it: focus draws the neighbourhood's side chains around the
                // residue you clicked, and a translucent band laid over the
                // middle of that is a blot exactly where you are looking. An
                // outline says which one without covering it.
                selectionMark: this.selectionMark || 'highlight',
            };
        },

        /**
         * Put a snapshot back. `animate` false snaps rather than flies.
         *
         * `withSelection` false leaves the selection EMPTY instead of putting
         * the snapshot's back - which is what clicking the background inside
         * the mode wants: it is a step BACK OUT of one focus, not a step out of
         * the mode, and reviving the selection the reader had before they
         * pressed the button re-marks residues they have since moved on from.
         * Leaving the mode restores it, because then it is theirs again.
         */
        _focusRestore(snap, animate, withSelection) {
            if (!snap) return false;
            for (const [name, set] of snap.sidechains) {
                const obj = this.objectsData[name];
                if (obj) obj.sidechains = set;
            }
            this._invalidateSegmentCache();
            this.reloadDrawn(true);

            if (typeof this.setClipSlab === 'function') {
                if (snap.clip) this.setClipSlab(snap.clip.near, snap.clip.far);
                else this.setClipSlab(null, null);
                if (this._syncClipButton) this._syncClipButton();
            }
            // THE ANGLE IS LEFT ALONE - see the snapshot. The centre and the
            // zoom come back because the mode moved them; the rotation does
            // not, because only the reader did.
            this.viewerState.zoom = snap.zoom;
            this.focusMoveTo({
                center: snap.center,
                extent: (snap.extent !== null && snap.extent !== undefined)
                    ? snap.extent : this._currentExtent(),
                extentAspect: snap.extentAspect,
            }, animate !== false);
            // ...and the extent goes back to EXACTLY what was there, null
            // included: the tween needs a number to move to, and null means
            // "the object's own", which is not the same thing.
            if (snap.extent === null || snap.extent === undefined) {
                const settle = () => {
                    if (this._focusAnim) { requestAnimationFrame(settle); return; }
                    this.viewerState.extent = snap.extent;
                    this.viewerState.center = snap.center;
                    this._invalidateScreenProjection();
                    this.render('focusRestore');
                };
                settle();
            }
            // THE MARK GOES BACK WHEN THE MODE IS OVER, AND NOT BEFORE.
            // 🔴 This restored it on every clearFocus, and clearFocus INSIDE
            // the mode is the way out of one focus rather than out of the
            // mode - so a click on the background, or anything else that
            // empties the selection, took the outline off and left the mode
            // running with the reader's mark on. Loading a new structure is
            // exactly that: it clears the selection, ui.js reads an empty
            // selection as the background gesture, and the Sele dropdown
            // dropped to Highlight while Focus stayed lit. `_focusMode` is
            // already false by the time exitFocusMode restores, so this needs
            // no argument.
            //
            // Same line as the rotation otherwise: what focus changed, focus
            // puts back; what the reader changed while they were in there is
            // theirs. If they picked Highlight or None from the panel
            // mid-focus, that is a choice about how they want selections
            // marked, not a thing the mode borrowed.
            if (!this._focusMode && this.selectionMark === 'outline'
                && snap.selectionMark && snap.selectionMark !== 'outline') {
                this.selectionMark = snap.selectionMark;
                if (this._syncSelectionMark) this._syncSelectionMark();
            }
            this.setResidueSelection(
                (withSelection === false) ? new Set() : (snap.selection || new Set()));
            this.render('focusRestore');
            return true;
        },

        /**
         * ENTER THE MODE: remember everything, then clear the decorations so
         * the session starts from the structure and nothing else.
         *
         * The CAMERA is deliberately left where it is. Resetting the view on
         * the way in would throw away the angle the reader chose to look from,
         * and the mode's whole promise is that it does not rotate - the first
         * click moves in from wherever you were standing.
         */
        enterFocusMode() {
            if (this._focusMode) return false;
            this._focusEntry = this._focusSnapshot();
            this._focusPrev = null;
            this._focusByObject = null;   // both exits clear it; say so here too
            this._focusMode = true;
            // A CLEAN SLATE, or the session is the reader's leftovers plus the
            // mode's: side chains they turned on by hand look like ones focus
            // drew, and a slab from before cuts the neighbourhood it moves to.
            let hadSidechains = false;
            for (const name of Object.keys(this.objectsData || {})) {
                const obj = this.objectsData[name];
                if (obj && obj.sidechains) { obj.sidechains = null; hadSidechains = true; }
            }
            if (hadSidechains) {
                this._invalidateSegmentCache();
                this.reloadDrawn(true);
            }
            if (typeof this.setClipSlab === 'function'
                && typeof this.clipSlabOn === 'function' && this.clipSlabOn()) {
                this.setClipSlab(null, null);
                if (this._syncClipButton) this._syncClipButton();
            }
            // A SELECTION ALREADY THERE IS AN INTENT, NOT A LEFTOVER. Side
            // chains and a slab are decorations the reader turned on at some
            // point and forgot; a selection is "this is the thing I am looking
            // at", and pressing Focus with one is asking to look at it closer.
            // So it is not cleared - it is FOCUSED, and the mode opens on the
            // neighbourhood of what was already picked instead of waiting for
            // a click that says the same thing again.
            // AN OUTLINE, NOT A WASH, for as long as the mode is on. The
            // whole point of focus is to look closely at one residue with its
            // neighbours drawn around it, and the default mark is a
            // translucent band laid OVER that residue - a blot in the middle
            // of the thing you moved in to see. See docs/SELECTION_MARK.md.
            if (this.selectionMark !== 'outline') {
                this.selectionMark = 'outline';
                if (this._syncSelectionMark) this._syncSelectionMark();
            }
            const seed = (this.residueSelection instanceof Set
                && this.residueSelection.size)
                ? new Set(this.residueSelection) : null;
            if (seed) {
                // ...and the guard, because focusOn sets the selection itself
                // and parts/ui.js WRAPS that setter to trigger a focus. Without
                // it, entering the mode focuses, which selects, which focuses.
                const was = this._focusBusy;
                this._focusBusy = true;
                try { this.focusOn(seed); } finally { this._focusBusy = was; }
            }
            this.render('enterFocusMode');
            return true;
        },

        // ====================================================================
        // THE MODE REMEMBERS ONE FOCUS PER OBJECT
        //
        // A switch drops the residue selection - the indices mean nothing in
        // the object being switched to - but the CAMERA is per object already
        // (`obj.viewerState` in `_switchToObject`). So leaving a focused
        // object and coming back parked you exactly where the focus had put
        // you, with no selection, no side chains and no slab: the camera
        // remembered and nothing else did.
        //
        // Both halves are the mode's, so the memory is too - it is dropped
        // when the mode ends, and a click on the background forgets the
        // object it was on, because dismissing a focus is a decision.
        // ====================================================================

        /**
         * Before a switch: keep what is focused on the object being left.
         *
         * 🔴 NOT WHILE OBJECTS ARE MERGED, at either end. There the selection
         * is not dropped by the switch at all - the indices are the merged
         * array's and mean the same thing whichever object is being edited -
         * and the strip SETS the edited object from where you clicked. So a
         * recall would replace the selection that ASKED for the switch, which
         * is the very thing that branch of `_switchToObject` exists to
         * protect.
         *
         * The two guards cover different things and only one is observable
         * from inside a single mode. RECALL is the load-bearing one: a set
         * stored in an object's OWN numbering, then Multi turned on, is a set
         * of merged indices naming different residues - turning Multi on
         * translates the live selection (residue 10 of the second object
         * becomes 10 + its offset) but a stored one is just numbers.
         * REMEMBER matters the other way round: without it a merged selection
         * would be filed under an object name and read back after Multi is
         * turned off. The range check below is the backstop there, and it
         * only catches the out-of-range half.
         */
        _focusRememberBeforeSwitch(fromName, merged) {
            if (merged) return false;
            if (!this._focusMode || !fromName) return false;
            if (!this._focusByObject) this._focusByObject = new Map();
            const sel = this.residueSelection;
            if (sel instanceof Set && sel.size) this._focusByObject.set(fromName, new Set(sel));
            else this._focusByObject.delete(fromName);
            return true;
        },

        /**
         * ...and after it, focus again whatever that object was showing.
         *
         * Called from `_switchToObject`'s settle frame, AFTER its one draw:
         * the first version returned early when it recalled, on the reasoning
         * that focusOn draws anyway, and that skipped the draw a switch owes -
         * `tests/interaction.js` has a rule that the hold is always released
         * with one, because without it the previous object stays on screen.
         */
        _focusRecallAfterSwitch(toName, merged) {
            if (merged) return false;
            if (!this._focusMode || !this._focusByObject) return false;
            const want = this._focusByObject.get(toName);
            if (!want || !want.size) return false;
            // The object's coordinates are loaded by the switch's CALLER, so
            // this runs a frame later - and an index past the end means the
            // object changed under the memory, which is a memory to drop.
            const n = (this.coords || []).length;
            for (const i of want) {
                if (!(i >= 0 && i < n)) { this._focusByObject.delete(toName); return false; }
            }
            if (this._focusBusy) return false;
            this._focusBusy = true;
            try { this.focusOn(new Set(want)); } finally { this._focusBusy = false; }
            return true;
        },

        /**
         * FORGET THE MODE ENTIRELY, without restoring anything.
         *
         * For Clear All and the like: there is nothing to put the snapshot
         * back ONTO - the objects it names are going away - and leaving the
         * mode latched is how a fresh structure arrives already in focus, with
         * the previous session's mark on the Sele dropdown and an entry
         * snapshot describing objects that no longer exist. Reported as
         * "leftovers from focus after Clear All".
         *
         * The MARK is the one thing that does go back, because the mode
         * borrowed it from the reader rather than from the structure.
         */
        _resetFocusState() {
            const snap = this._focusEntry;
            this._focusMode = false;
            this._focusEntry = null;
            this._focusPrev = null;
            this._focusBusy = false;
            this._focusByObject = null;      // the mode's memory, not the object's
            this._focusAnim = null;          // cancels whatever was flying
            if (this.selectionMark === 'outline') {
                this.selectionMark = (snap && snap.selectionMark) || 'highlight';
                if (this._syncSelectionMark) this._syncSelectionMark();
            }
            if (this._syncFocusButton) this._syncFocusButton();
            return true;
        },

        /** LEAVE IT, and put back everything the mode borrowed. */
        exitFocusMode(animate) {
            if (!this._focusMode) return false;
            this._focusMode = false;
            const snap = this._focusEntry || this._focusPrev;
            this._focusEntry = null;
            this._focusPrev = null;
            this._focusByObject = null;
            return this._focusRestore(snap, animate);
        },

        /**
         * Pick a residue or a ligand and look at what it is doing.
         *
         *   r.focusOn({type: 'L'})              // the ligand and its pocket
         *   r.focusOn({chain: 'A', residues: [42]})
         *   r.focusOn()                         // whatever is selected now
         *
         * Four things at once, and each of them is undone by the next call -
         * so clicking from one residue to the next replaces the last focus
         * rather than piling side chains up behind you.
         *
         * @param {*} sel a selector, or nothing to use the current selection
         * @param {object} [opts] {cutoff, sidechains, clip} to turn parts off
         * @returns {Set|null} the neighbourhood, or null when nothing resolved
         */
        focusOn(sel, opts) {
            const o = opts || {};
            const seed = (sel === undefined || sel === null)
                ? (this.residueSelection instanceof Set
                    ? new Set(this.residueSelection) : null)
                : positionsFor(this, sel);
            if (!seed || !seed.size) return null;

            const cut = (o.cutoff > 0) ? o.cutoff : this.focusCutoffA();
            // 🔴 SIDE CHAIN TO SIDE CHAIN, NOT ATOM TO ATOM.
            //
            // residuesWithin counts the TRACE POINT as an atom unless told
            // otherwise, and a residue is one CA plus its side chain in this
            // model. Two things follow that are not interactions:
            //
            //   i-1 and i+1, always. Consecutive CAs are 3.8 A apart, so the
            //   sequence neighbours are inside any useful cutoff on the
            //   backbone alone. They are the chain, not something it is doing.
            //
            //   THE RESIDUE ACROSS A SHEET. Adjacent strands sit ~5 A apart CA
            //   to CA, so the partner opposite is picked up even when its side
            //   chain points at the other face. Measured on 1UBQ, seeded at
            //   residue 4 mid-strand: atom-to-atom finds 3, 5 and 11 that side
            //   chain to side chain does not, and 11 is exactly that partner.
            //
            // A LIGAND IS ALL SIDE CHAIN, so this does not weaken the case
            // focus exists for - residuesWithin says so and slices nothing off
            // a ligand.
            //
            // AND IT NEEDS A TABLE. Without one every residue is a bare trace
            // point, side-chain-only measures nothing and the answer would be
            // the seed alone - so a structure with no side chains (a CA trace,
            // or anything a notebook payload carries) falls back to what it
            // always did.
            const scOnly = (o.sidechainsOnly !== undefined)
                ? !!o.sidechainsOnly : !!this.sidechains;
            const near = (typeof this.residuesWithin === 'function')
                ? this.residuesWithin(seed, cut, {sidechainsOnly: scOnly})
                : new Set(seed);
            // 🔴 A SIDE-CHAIN ATOM IS ITS RESIDUE, the rule `_wholeThingAt`
            // already applies to a click. Showing side chains APPENDS their
            // atoms as real positions, so the search can return one - and only
            // when some are already out, which inside the mode is the restored
            // baseline. That put an index past the last residue into the
            // object's side-chain set: 748 on a 748-residue 4HHB, six
            // neighbours where the same focus finds five from a clean start.
            // Self-correcting (the next focus replaces the set) and invisible
            // (its residue is drawn either way), but it is not a residue.
            const scMap = this.sidechainMap;
            if (scMap && scMap.size) {
                for (const i of [...near]) {
                    const owns = scMap.get(i);
                    if (owns) { near.delete(i); near.add(owns.owner); }
                }
            }

            // THE FIRST FOCUS REMEMBERS WHAT WAS THERE, so clearFocus can put
            // it back. A second focus must NOT overwrite that record with its
            // own side chains, or leaving focus would leave the last
            // neighbourhood drawn for ever.
            // INSIDE THE MODE THE BASELINE IS THE MODE'S, taken when it was
            // entered - so clicking away goes back to what the reader had
            // before they pressed the button, not to what the first click
            // happened to find. Outside it (the JS API calling focusOn
            // directly) the first focus still remembers, which is what
            // clearFocus has always undone.
            if (!this._focusPrev && !this._focusEntry) {
                this._focusPrev = {
                    sidechains: new Map(),
                    clip: (typeof this.clipSlabOn === 'function' && this.clipSlabOn())
                        ? { near: this.clipNear, far: this.clipFar } : null,
                    center: this.viewerState.center
                        ? Object.assign({}, this.viewerState.center) : null,
                    extent: this.viewerState.extent,
                    extentAspect: this.viewerState.extentAspect,
                    zoom: this.viewerState.zoom,
                    // 🔴 WHAT WAS SELECTED BEFORE THE CLICK, which is not
                    // what is selected now. parts/ui.js's wrap sets the
                    // selection and THEN focuses, so reading it here captured
                    // the residue that had just been clicked - and clicking
                    // away restored it, leaving one position highlighted with
                    // nothing else on screen. The caller passes the earlier
                    // one; `prior` may legitimately be null.
                    selection: ('prior' in o)
                        ? o.prior
                        : (this.residueSelection instanceof Set
                            ? new Set(this.residueSelection) : null),
                };
                for (const name of this.drawnObjects()) {
                    const obj = this.objectsData[name];
                    if (!obj) continue;
                    this._focusPrev.sidechains.set(
                        name, obj.sidechains instanceof Set
                            ? new Set(obj.sidechains) : null);
                }
            }

            // THE HALO FIRST, AND THE SIDE CHAINS AFTER.
            //
            // 🔴 THE OTHER ORDER COST 48 ms A CLICK. setResidueSelection
            // dispatches py2dmol-residue-selection-change on DOCUMENT, and the
            // listeners - the sequence strip, the selection panel - rebuild
            // themselves against a structure whose position count has just
            // changed, because materialising side chains APPENDS real
            // positions. Announced before that change it is 0.2 ms on 4HHB;
            // announced after it, 47.8. The search everyone suspects
            // (residuesWithin) is 0.2 either way.
            //
            // Safe in this order because side-chain positions are APPENDED:
            // every index the selection names still means the same residue
            // afterwards.
            //
            // The halo stays on WHAT WAS CLICKED, not on the neighbourhood:
            // the side chains already say what is near, and lighting all of it
            // up leaves nothing to say which residue you asked about.
            this.setResidueSelection(new Set(seed));

            // ...AND THE SIDE CHAINS ARE ASSIGNED, NOT ADDED TO. Every object
            // is written, including the ones the neighbourhood does not reach,
            // because "hide the last click's" is the whole point and an object
            // with no positions in the group would otherwise keep its own.
            if (o.sidechains !== false && this.sidechains) {
                const want = new Map();
                for (const g of this.writeGroups(near)) want.set(g.name, g.positions);
                for (const name of this.drawnObjects()) {
                    const obj = this.objectsData[name];
                    if (!obj) continue;
                    const mine = want.get(name);
                    obj.sidechains = (mine && mine.length) ? new Set(mine) : null;
                }
                this._invalidateSegmentCache();
                this.reloadDrawn(true);
            }

            this.focusCamera(near, o);
            if (o.clip !== false && typeof this.autoClip === 'function') {
                this.autoClip(near);
                if (this._syncClipButton) this._syncClipButton();
            }
            this.render('focusOn');
            return near;
        },

        /**
         * MOVE IN, DO NOT TURN. The centre and the extent, from the same
         * measurements parts/orient.js takes - and the rotation is not
         * touched, so the reader keeps their bearings while clicking from one
         * residue to the next.
         *
         * extentAspect comes with it for the same reason it does there: the
         * extent is a radius and the canvas is rarely square, so without the
         * shape the neighbourhood is fitted into a square of side min(w, h).
         * Measured under the CURRENT rotation, which is the one that stays.
         */
        focusCamera(near, opts) {
            const set = (this.framingPositions && near)
                ? this.framingPositions(near) : near;
            if (!set || !set.size) return false;
            const co = this.coords;
            if (!co || !co.length) return false;

            let cx = 0; let cy = 0; let cz = 0; let m = 0;
            for (const i of set) {
                const c = co[i];
                if (!c) continue;
                cx += c.x !== undefined ? c.x : c[0];
                cy += c.y !== undefined ? c.y : c[1];
                cz += c.z !== undefined ? c.z : c[2];
                m++;
            }
            if (!m) return false;
            cx /= m; cy /= m; cz /= m;

            const R = this.viewerState.rotation;
            let r2 = 0; let hx = 0; let hy = 0;
            for (const i of set) {
                const c = co[i];
                if (!c) continue;
                const dx = (c.x !== undefined ? c.x : c[0]) - cx;
                const dy = (c.y !== undefined ? c.y : c[1]) - cy;
                const dz = (c.z !== undefined ? c.z : c[2]) - cz;
                const d = dx * dx + dy * dy + dz * dz;
                if (d > r2) r2 = d;
                const x = Math.abs(R[0][0] * dx + R[0][1] * dy + R[0][2] * dz);
                const y = Math.abs(R[1][0] * dx + R[1][1] * dy + R[1][2] * dz);
                if (x > hx) hx = x;
                if (y > hy) hy = y;
            }
            // A FLOOR, for the same reason orient.js has one: a single residue
            // has almost no extent and asking for that magnification puts one
            // side chain across the whole canvas with nothing to read it
            // against. A residue's own reach is about 7 A.
            const FOCUS_MIN_EXTENT_A = 8;
            const extent = Math.max(Math.sqrt(r2), FOCUS_MIN_EXTENT_A);
            const mx = Math.max(hx, hy);

            this.focusMoveTo({
                center: { x: cx, y: cy, z: cz },
                extent,
                extentAspect: (mx > 0) ? { x: hx / mx, y: hy / mx } : null,
            }, !(opts && opts.animate === false));
            return true;
        },

        /**
         * THE MOVE ITSELF, over about a third of a second.
         *
         * A jump is disorienting in exactly the way this feature exists to
         * avoid: the reader is walking from one residue to the next, and if
         * the picture teleports each time there is nothing to follow. Short,
         * because it happens on every click and anything longer is in the way.
         *
         * ONE ANIMATION AT A TIME, replaced rather than queued - clicking
         * three residues quickly should end at the third, not visit all three.
         * The centre may be null (the object's own centre), so the start is
         * read from where the camera actually is.
         */
        focusMoveTo(target, animate) {
            const st = this.viewerState;
            const from = {
                center: st.center ? Object.assign({}, st.center)
                    : (this._viewCenter ? Object.assign({}, this._viewCenter) : null),
                extent: (st.extent !== null && st.extent !== undefined)
                    ? st.extent : this._currentExtent(),
                extentAspect: st.extentAspect,
            };
            this._focusAnim = null;                 // cancel whatever was running
            const apply = (c, e, a) => {
                st.center = c;
                st.extent = e;
                st.extentAspect = a;
                this._invalidateScreenProjection();
            };
            if (!animate || !from.center || !(from.extent > 0)
                || typeof requestAnimationFrame !== 'function') {
                apply(target.center, target.extent, target.extentAspect);
                return;
            }
            const DURATION_MS = 320;
            const anim = { t0: null };
            this._focusAnim = anim;
            const lerp = (a, b, t) => a + (b - a) * t;
            const step = (now) => {
                if (this._focusAnim !== anim) return;   // superseded
                if (anim.t0 === null) anim.t0 = now;
                const t = Math.min(1, (now - anim.t0) / DURATION_MS);
                // ...eased, so it leaves and arrives gently rather than
                // starting and stopping dead.
                const e = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
                apply({
                    x: lerp(from.center.x, target.center.x, e),
                    y: lerp(from.center.y, target.center.y, e),
                    z: lerp(from.center.z, target.center.z, e),
                }, lerp(from.extent, target.extent, e),
                    // THE SHAPE IS NOT INTERPOLATED. It belongs to the target
                    // and lerping it makes the fit wrong the whole way there -
                    // the picture would breathe sideways. Applied at once; the
                    // extent carries the movement.
                    target.extentAspect);
                this.render('focusMove');
                if (t < 1) requestAnimationFrame(step);
                else if (this._focusAnim === anim) this._focusAnim = null;
            };
            requestAnimationFrame(step);
        },

        /** What the camera is framing now, when nothing has set an extent. */
        _currentExtent() {
            const framed = this.drawnStats()
                || (this.currentObjectName ? this.objectsData[this.currentObjectName] : null);
            return (framed && framed.maxExtent > 0) ? framed.maxExtent : 30.0;
        },

        /** Is a focus in place? */
        focusOn_active() {
            return !!this._focusPrev;
        },

        /**
         * BACK TO WHAT WAS THERE - the side chains each object had, the slab,
         * the camera and the selection. Restoring is why _focusPrev is written
         * once and not on every focus.
         */
        clearFocus(opts) {
            // INSIDE THE MODE this is the way BACK OUT of one focus, not the
            // way out of the mode: a click on the background zooms out and
            // leaves the reader still in focus, ready for the next click. So
            // it restores the mode's own baseline and KEEPS it, where the
            // per-click record is consumed.
            const snap = this._focusEntry || this._focusPrev;
            if (!snap) return false;
            const inMode = !!this._focusEntry;
            if (!inMode) this._focusPrev = null;
            // Inside the mode the selection goes EMPTY rather than back to
            // what the reader had before they entered; outside it, clearFocus
            // is the undo of one focusOn and puts back what that focus found.
            return this._focusRestore(snap, opts !== false, !inMode);
        },
    },
});
})();
