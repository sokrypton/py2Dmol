// ============================================================================
// src/parts/clip.js
// -------------------------------
// AI Context: CLIP (a part of Pseudo3DRenderer)
// - The camera-space slab. See the banner below, which says it properly.
// ============================================================================
(function () {
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({
    name: 'clip',
    proto: {
        // ====================================================================
        // CLIP, THE WAY PyMOL DOES IT
        //
        // A slab in CAMERA space: keep what lies between clipFar and clipNear
        // along the view's own z, and cut everything else. Not a selection and
        // not a visibility state - the geometry is CUT, so a ribbon that
        // crosses the plane is drawn up to it and stops, and the interior it
        // exposes is open to the camera. That is what "clip" means in PyMOL,
        // and it is why this lives in the draw rather than in the mask.
        //
        // Being camera space it follows the view for nothing: turn the
        // structure and the slab stays where the camera is, which is the whole
        // point of clipping into something.
        //
        // Nothing is committed and nothing is remembered per object: switch it
        // off and the drawing is whole again.
        // ====================================================================

        /**
         * How far the drawing reaches from the view centre, in Angstrom: the
         * furthest position, plus what the STYLE adds around it.
         *
         * A radius, and deliberately not the view's depth extent. The extent
         * changes as the structure turns - a molecule seen end-on is deeper
         * than the same molecule side-on - so a slab set from it starts cutting
         * the moment you rotate, without anyone touching a control. That is
         * what "resetting doesn't recover everything" was: reset restored the
         * extent OF THAT VIEW, and the next rotation ate into the structure
         * again. A radius cannot do that: it is the same number from every
         * angle, so a slab set to it cuts nothing until a slider is moved.
         *
         * The pad is the style's own reach past the positions: a ribbon is
         * drawn lineWidth Angstrom wide about its backbone and a tube has a
         * radius, so a slab tight to the ATOMS would shave the surface drawn
         * around them.
         */
        _clipReach() {
            this._ensureRotated();
            const n = this.coords ? this.coords.length : 0;
            const rc = this.rotatedCoords;
            if (!n || !rc || rc.length < n) return 0;
            let r2 = 0;
            for (let i = 0; i < n; i++) {
                const c = rc[i];
                const d = c.x * c.x + c.y * c.y + c.z * c.z;
                if (d > r2) r2 = d;
            }
            if (!(r2 > 0)) return 0;
            return Math.sqrt(r2) + Math.max(2, 2 * (this.lineWidth || 3));
        },

        /**
         * The structure's actual depth range IN THIS VIEW - what the control's
         * track spans, so that moving a knob cuts something immediately.
         *
         * Not the same as the rest state: that is a radius, deliberately, so
         * that rotating cannot start a cut on its own. The radius is bigger
         * than this whenever the structure is wider than it is deep, and a
         * track drawn to the radius spends its first stretch crossing empty
         * space - which is what "the endpoints do not hide anything when I move
         * them" is. So the track measures the view and the ENDS mean off: a
         * knob at its limit is stored as the rest state, not as this number.
         */
        clipViewExtent() {
            this._ensureRotated();
            const n = this.coords ? this.coords.length : 0;
            const rc = this.rotatedCoords;
            if (!n || !rc || rc.length < n) return null;
            let lo = Infinity; let hi = -Infinity;
            for (let i = 0; i < n; i++) {
                const z = rc[i].z;
                if (z < lo) lo = z;
                if (z > hi) hi = z;
            }
            if (!(hi >= lo)) return null;
            // NO PAD. The rest state pads, because a slab tight to the ATOMS
            // would shave the surface drawn around them - but the track is
            // where the knobs travel, and padding it spends the first stretch
            // of that travel on empty space: 6 Angstrom of a 36 Angstrom
            // structure, during which moving the knob visibly did nothing. A
            // knob at the end is off anyway (see the caller), so the end has no
            // shaving to avoid; one step in cuts the front of the drawing,
            // which is what a knob at the front of the structure should do.
            return { far: lo, near: hi };
        },

        /** A slab that holds the whole structure however it is turned. */
        clipSlabDefault() {
            const R = this._clipReach();
            if (!(R > 0)) return null;
            return { far: -R, near: R };
        },

        /**
         * THE SLAB THAT HOLDS THE SELECTION - what Auto sets.
         *
         * A cut is nearly always wanted around something: you pick a site and
         * you want the rest of the structure out of the way. Doing that by hand
         * means dragging two knobs against a picture that changes as you drag,
         * and the answer is already known - the selection has a depth range in
         * this view, and the slab is that range with room to breathe.
         *
         * WITH NOTHING SELECTED IT IS THE REST STATE, which cuts nothing from
         * any angle. That is the same answer the Reset button used to give, so
         * Auto replaces it rather than sitting beside it: no selection, no
         * context, and the only sensible context-free slab is all of it.
         *
         * The set is expanded the way Orient expands it (framingPositions): a
         * residue's side-chain atoms and a ligand's other atoms belong to the
         * thing you picked, and hidden ones do not.
         *
         * THICK ENOUGH TO SURVIVE A ROTATION. The obvious slab is the
         * selection's depth range in this view, and it is wrong the moment the
         * model turns: a site lying flat in the screen plane has almost no
         * depth, so that slab is a few Angstrom thick, and a quarter turn
         * stands the site up on end and cuts it in half.
         *
         * The selection's RADIUS does not turn. Half the thickness is the
         * distance from the selection's centre to the furthest thing in it, so
         * the slab holds the whole of it whatever angle it is seen from - the
         * same reason a bounding sphere is used for framing rather than a
         * bounding box.
         *
         * Its CENTRE is still this view's: a slab is camera space and its
         * depth has to come from somewhere. That part goes stale on a rotation
         * about anything other than the selection itself, which is what makes
         * this a button rather than a mode - and pressing Orient first pins
         * the view to the selection, after which it does not move at all.
         */
        clipSlabForSelection(set) {
            const base = this.clipSlabDefault();
            this.clipAuto = null;
            const raw = set || (this.selectionInk ? this.selectionInk()
                : this.residueSelection);
            const sel = this.framingPositions
                ? this.framingPositions(raw) : raw;
            if (!sel || !sel.size) return base;
            this._ensureRotated();
            const rc = this.rotatedCoords;
            const n = this.coords ? this.coords.length : 0;
            if (!rc || !n) return base;
            // The centre, and then the furthest thing from it. In MODEL space,
            // where neither number depends on the view at all: a distance
            // survives a rotation, and a centre that is remembered as
            // coordinates can be re-projected at any angle. That is what makes
            // the slab TRACK - see _refreshAutoClip.
            const co = this.coords;
            let cx = 0; let cy = 0; let cz = 0; let m = 0;
            for (const i of sel) {
                if (!(i >= 0 && i < n) || !co[i]) continue;
                cx += co[i].x; cy += co[i].y; cz += co[i].z; m++;
            }
            if (!m) return base;
            cx /= m; cy /= m; cz /= m;
            let r2 = 0;
            for (const i of sel) {
                if (!(i >= 0 && i < n) || !co[i]) continue;
                const dx = co[i].x - cx; const dy = co[i].y - cy;
                const dz = co[i].z - cz;
                const d = dx * dx + dy * dy + dz * dz;
                if (d > r2) r2 = d;
            }
            // ROOM TO BREATHE. A position is a point and the thing drawn at it
            // has a radius, so a slab through the extreme atoms cuts the very
            // residues it was asked to show. Half the line width clears the
            // geometry and the rest is context - enough to see what the site
            // sits in, not so much that the cut stops being one.
            const pad = 1.5 + 0.5 * (this.lineWidth || 3);
            // ...AND THE THICKNESS IS A DEPTH, NOT A RADIUS.
            //
            // This used to be the selection's 3D bounding radius, on the
            // reasoning that a radius does not rotate and so the slab could
            // track by moving one point. True, and the price is that a radius
            // is the WORST-CASE depth over every possible view: measured on a
            // trypsin pocket, radius 8.2 A against an actual depth of 4.2 -
            // so the slab came out 22 A thick on a 40 A protein and left three
            // quarters of the model standing. The cut did not go far enough,
            // and could not, at any angle.
            //
            // So the SET is remembered rather than a radius, and the half
            // thickness is recomputed from its extent along the view - which
            // is the same arithmetic _autoClipDepth already does for the
            // centre, over a handful more points. Capped, because a selection
            // can be the whole ribosome and this runs every frame; beyond the
            // cap it samples, which can only widen the slab slightly.
            const CAP = 2048;
            const pts = [];
            const list = [...sel].filter((i) => i >= 0 && i < n && co[i]);
            const step = Math.max(1, Math.ceil(list.length / CAP));
            for (let k = 0; k < list.length; k += step) {
                const c = co[list[k]];
                pts.push(c.x, c.y, c.z);
            }
            // REMEMBERED, so the slab can follow. Pressing Auto and then
            // rotating used to leave the cut where the selection HAD been, and
            // pressing it again gave a different answer at every angle.
            this.clipAuto = { x: cx, y: cy, z: cz, half: Math.sqrt(r2) + pad,
                pts, pad };
            const view = this._autoClipDepth();
            if (view === null) return base;
            const half = this._autoClipHalf();
            return { near: view + half, far: view - half };
        },

        /**
         * A SELECTOR IN, A SLAB OUT - the one route from the project's way of
         * naming residues to the slab, and the only thing three callers need.
         *
         * There were three copies of these four lines: parts/embed.js's
         * `v.clip(sel)`, parts/ui.js's applyClipSelector for what Python asks
         * for, and index.html's panel. They differed already - only one of
         * them re-synced the Clip button, so the notebook's button and the
         * notebook's slab could disagree about whether clipping was on.
         *
         * Nothing is not a selector: `clipTo()` turns the slab off, which is
         * what every caller's empty case meant separately.
         */
        clipTo(sel) {
            if (!sel) {
                this.setClipSlab(null, null);
            } else {
                this.autoClip(positionsFor(this, sel));
            }
            if (this._syncClipButton) this._syncClipButton();
            this.render('clipTo');
            return this;
        },

        /**
         * AUTO: fit the slab to the selection and keep it there.
         *
         * The one entry point, because the tracking has to survive the set:
         * setClipSlab drops it (a knob dragged wins over a slab computed), and
         * this is the one caller that means the opposite.
         */
        autoClip(set) {
            const slab = this.clipSlabForSelection(set);
            if (!slab) return null;
            const keep = this.clipAuto;
            this.setClipSlab(slab.near, slab.far);
            this.clipAuto = keep;
            return slab;
        },

        /**
         * The remembered auto-clip centre's depth IN THIS VIEW, by the same two
         * steps _rotateCoords applies to every position: the object's own
         * best_view rotation, then the user's, about the view centre. One point
         * rather than the whole array, so this is a handful of multiplies and
         * can run every frame.
         */
        _autoClipDepth() {
            const a = this.clipAuto;
            if (!a) return null;
            const object = this.objectsData
                ? this.objectsData[this.currentObjectName] : null;
            let x = a.x; let y = a.y; let z = a.z;
            const oR = (object && object.rotation_matrix && object.center)
                ? object.rotation_matrix : null;
            if (oR) {
                const oc = object.center;
                const dx = x - oc[0]; const dy = y - oc[1]; const dz = z - oc[2];
                x = oR[0][0] * dx + oR[0][1] * dy + oR[0][2] * dz + oc[0];
                y = oR[1][0] * dx + oR[1][1] * dy + oR[1][2] * dz + oc[1];
                z = oR[2][0] * dx + oR[2][1] * dy + oR[2][2] * dz + oc[2];
            }
            const c = this._computeViewCentre(object);
            const m = this.viewerState.rotation;
            if (!m) return null;
            return m[2][0] * (x - c.x) + m[2][1] * (y - c.y) + m[2][2] * (z - c.z);
        },

        /**
         * KEEP AN AUTO SLAB ON ITS SELECTION. Called once per frame, before
         * anything reads the planes.
         *
         * A slab is camera space and the thing it was cut around is not, so a
         * rotation moves one and not the other: the cut slid off the site, and
         * pressing Auto again gave a different pair of planes at every angle
         * because the depth of the selection had changed underneath it. The
         * thickness never needed to change - a radius does not rotate - only
         * where the slab sits, and that is one point re-projected.
         *
         * Dropped the moment the slab is set by hand (see setClipSlab): a knob
         * dragged is an answer given, and it must not be overwritten on the
         * next frame.
         */
        /**
         * HALF THE SELECTION'S DEPTH IN THIS VIEW, plus the pad.
         *
         * The points are model coordinates and are put through exactly what
         * _autoClipDepth puts the centre through - the object's own best-view
         * rotation, then the user's - so the two answers are in the same space.
         *
         * Falls back to the remembered radius when there are no points, which
         * is what a session saved before this existed restores as.
         */
        _autoClipHalf() {
            const a = this.clipAuto;
            if (!a) return 0;
            if (!a.pts || !a.pts.length) return a.half;
            const object = this.objectsData
                ? this.objectsData[this.currentObjectName] : null;
            const oR = (object && object.rotation_matrix && object.center)
                ? object.rotation_matrix : null;
            const oc = object ? object.center : null;
            const c = this._computeViewCentre(object);
            const m = this.viewerState.rotation;
            if (!m) return a.half;
            let lo = Infinity; let hi = -Infinity;
            for (let k = 0; k < a.pts.length; k += 3) {
                let x = a.pts[k]; let y = a.pts[k + 1]; let z = a.pts[k + 2];
                if (oR) {
                    const dx = x - oc[0]; const dy = y - oc[1]; const dz = z - oc[2];
                    x = oR[0][0] * dx + oR[0][1] * dy + oR[0][2] * dz + oc[0];
                    y = oR[1][0] * dx + oR[1][1] * dy + oR[1][2] * dz + oc[1];
                    z = oR[2][0] * dx + oR[2][1] * dy + oR[2][2] * dz + oc[2];
                }
                const zv = m[2][0] * (x - c.x) + m[2][1] * (y - c.y)
                    + m[2][2] * (z - c.z);
                if (zv < lo) lo = zv;
                if (zv > hi) hi = zv;
            }
            if (!isFinite(lo)) return a.half;
            return (hi - lo) / 2 + (a.pad || 0);
        },

        _refreshAutoClip() {
            if (!this.clipAuto || this.clipNear === null) return;
            const z = this._autoClipDepth();
            if (z === null) return;
            // ...RECOMPUTED, not carried. The thickness is a depth now, so it
            // genuinely changes with the view: a pocket seen face-on wants a
            // thinner slab than the same pocket seen edge-on, and the old
            // fixed radius was both at once and neither.
            const half = this._autoClipHalf();
            this.clipNear = z + half;
            this.clipFar = z - half;
        },

        /**
         * Set the slab. near is the plane closer to the camera (larger z), far
         * the one further away; near <= far is refused rather than swapped,
         * because a slab of nothing is a drawing of nothing and reads as a bug.
         * Pass nulls to clip nothing.
         */
        setClipSlab(near, far) {
            // A SLAB SET BY HAND IS AN ANSWER GIVEN, and the next frame must
            // not overwrite it: any explicit set drops the auto tracking. Auto
            // itself goes through autoClip, which puts it back afterwards.
            this.clipAuto = null;
            if (near === null || far === null) {
                this.clipNear = null;
                this.clipFar = null;
            } else {
                const nz = Number(near); const fz = Number(far);
                if (!isFinite(nz) || !isFinite(fz)) return;
                const MIN = 0.5;
                this.clipNear = Math.max(nz, fz + MIN);
                this.clipFar = Math.min(fz, this.clipNear - MIN);
            }
            // written through to the object as well, so switching away and back
            // finds it where it was left
            const obj = this.objectsData && this.objectsData[this.currentObjectName];
            if (obj && obj.viewerState) {
                obj.viewerState.clipNear = this.clipNear;
                obj.viewerState.clipFar = this.clipFar;
                obj.viewerState.clipFade = this.clipFade;
            }
            this.render('clip slab');
        },

        // NUMBERS, not "not null". A renderer built before this existed - a
        // saved state, the lifted class the tests build - has neither field at
        // all, and `undefined !== null` is true, which turned a viewer with no
        // slab into one that clipped everything.
        clipSlabOn() {
            return typeof this.clipNear === 'number' && typeof this.clipFar === 'number';
        },

        /**
         * Set the soft edge, as a fraction of the slab's thickness. 0 is a
         * hard cut. Clamped to 1: a fade wider than the slab itself leaves
         * nothing at full strength anywhere, which reads as a bug rather than
         * as a setting.
         */
        setClipFade(f) {
            const v = Number(f);
            if (!isFinite(v)) return;
            this.clipFade = Math.max(0, Math.min(1, v));
            const obj = this.objectsData && this.objectsData[this.currentObjectName];
            if (obj && obj.viewerState) obj.viewerState.clipFade = this.clipFade;
            this.render('clip fade');
        },

        /**
         * The soft edge in ANGSTROM - what the shaders and the 2D paths want.
         * Zero whenever there is no slab to be soft about.
         */
        clipFadeWidth() {
            if (!this.clipSlabOn()) return 0;
            const f = (typeof this.clipFade === 'number') ? this.clipFade : 0;
            if (!(f > 0)) return 0;
            return Math.max(0, (this.clipNear - this.clipFar)) * f;
        },

        /**
         * How much of this view-space depth survives the clip: 1 inside the
         * slab, 0 past the fade, a straight ramp between. THE one test, so the
         * 2D paths and the shaders cannot drift apart about where the planes
         * are or how soft they are.
         */
        clipCoverage(z) {
            if (!this.clipSlabOn()) return 1;
            const d = Math.min(this.clipNear - z, z - this.clipFar);
            if (d >= 0) return 1;
            const w = this.clipFadeWidth();
            if (!(w > 0)) return 0;
            return Math.max(0, 1 + d / w);
        },

        /**
         * Is this depth inside the slab enough to be treated as there? Drawing
         * asks clipCoverage, because it can draw a ghost; picking and the
         * cheap culls ask this, because a click cannot land on half a residue.
         * Half covered is the line.
         */
        clipAccepts(z) {
            if (!this.clipSlabOn()) return true;
            return this.clipCoverage(z) >= 0.5;
        },
    },
});
})();