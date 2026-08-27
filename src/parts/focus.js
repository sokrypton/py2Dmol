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

            // THE FIRST FOCUS REMEMBERS WHAT WAS THERE, so clearFocus can put
            // it back. A second focus must NOT overwrite that record with its
            // own side chains, or leaving focus would leave the last
            // neighbourhood drawn for ever.
            if (!this._focusPrev) {
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
            const prev = this._focusPrev;
            if (!prev) return false;
            this._focusPrev = null;

            for (const [name, set] of prev.sidechains) {
                const obj = this.objectsData[name];
                if (obj) obj.sidechains = set;
            }
            this._invalidateSegmentCache();
            this.reloadDrawn(true);

            if (typeof this.setClipSlab === 'function') {
                if (prev.clip) this.setClipSlab(prev.clip.near, prev.clip.far);
                else this.setClipSlab(null, null);
                if (this._syncClipButton) this._syncClipButton();
            }
            this.viewerState.zoom = prev.zoom;
            this.focusMoveTo({
                center: prev.center,
                extent: (prev.extent !== null && prev.extent !== undefined)
                    ? prev.extent : this._currentExtent(),
                extentAspect: prev.extentAspect,
            }, opts !== false);
            // ...and the extent goes back to EXACTLY what was there, null
            // included: the tween needs a number to move to, and null means
            // "the object's own", which is not the same thing.
            if (prev.extent === null || prev.extent === undefined) {
                const settle = () => {
                    if (this._focusAnim) { requestAnimationFrame(settle); return; }
                    this.viewerState.extent = prev.extent;
                    this.viewerState.center = prev.center;
                    this._invalidateScreenProjection();
                    this.render('clearFocus');
                };
                settle();
            }
            this.setResidueSelection(prev.selection || new Set());
            this.render('clearFocus');
            return true;
        },
    },
});
})();
