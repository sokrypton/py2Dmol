// ============================================================================
// src/parts/align.js
// --------------------------------
// AI Context: ALIGNMENT: superposing objects onto a selection
// - The renderer's side of TM-align. window.Align does the arithmetic in a
//   Worker; this decides what to hand it, where the answer goes, and how it
//   reaches the screen.
// - THE TRANSFORM IS NEVER WRITTEN TO THE FILE. It lives on the object as
//   {t, u} and _transformedFrame applies it on the way out, which is what makes
//   aligning twice start from the original, undo a deleted field, and a
//   re-fetch not a silent revert.
// - Optional. _resolvedFrame stays in the core and only calls in here when an
//   object actually carries a transform, which nothing can set without this.
// ============================================================================
(function () {
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({
    name: 'align',
    proto: {
        /**
         * ONE OBJECT'S FRAME, MOVED BY ITS ALIGNMENT.
         *
         * WHERE AN OBJECT SITS IS STILL THE FILE'S BUSINESS - the coordinates
         * on disk are never rewritten. An alignment is a rigid motion held on
         * the object as {t, u} and applied HERE, on the way to the screen,
         * which buys three things a rewrite would not: aligning again starts
         * from the original coordinates rather than compounding, undoing is
         * dropping a field, and a re-fetch of the object does not silently
         * revert it.
         *
         * It is applied in _resolvedFrame because that is the ONE place both
         * the single-object load and the multi-object merge pass through. Doing
         * it in the merge alone would have left an aligned object shown BY
         * ITSELF drawn where the file put it, which is the same picture as "the
         * alignment was forgotten".
         *
         * SIDE CHAINS COME ALONG FOR FREE, almost. They are stored as
         * coefficients in a local frame built from the backbone (see
         * _mergeSidechainTables), and a rigid motion of the backbone carries
         * that frame with it - so most of the table needs nothing. The
         * exception is rows with frameOf === -1, whose coefficients are a WORLD
         * offset from the owner because the copy they came from was too short
         * to be framed. A world offset has to be rotated by hand; left alone,
         * those atoms would keep the old orientation while their residue turned.
         */
        _transformedFrame(frame, xf) {
            const t = xf.t; const u = xf.u;
            const fc = frame.coords || [];
            const coords = new Array(fc.length);
            for (let i = 0; i < fc.length; i++) {
                const c = fc[i];
                if (!c) { coords[i] = c; continue; }
                const x = c[0]; const y = c[1]; const z = c[2];
                coords[i] = [
                    t[0] + u[0] * x + u[1] * y + u[2] * z,
                    t[1] + u[3] * x + u[4] * y + u[5] * z,
                    t[2] + u[6] * x + u[7] * y + u[8] * z
                ];
            }
            let sidechains = frame.sidechains;
            if (sidechains && sidechains.frameOf && sidechains.coef) {
                let loose = false;
                for (let k = 0; k < sidechains.frameOf.length; k++) {
                    if (sidechains.frameOf[k] === -1) { loose = true; break; }
                }
                if (loose) {
                    const coef = Float32Array.from(sidechains.coef);
                    for (let k = 0; k < sidechains.frameOf.length; k++) {
                        if (sidechains.frameOf[k] !== -1) continue;
                        const x = coef[k * 3]; const y = coef[k * 3 + 1]; const z = coef[k * 3 + 2];
                        coef[k * 3] = u[0] * x + u[1] * y + u[2] * z;
                        coef[k * 3 + 1] = u[3] * x + u[4] * y + u[5] * z;
                        coef[k * 3 + 2] = u[6] * x + u[7] * y + u[8] * z;
                    }
                    sidechains = { ...sidechains, coef };
                }
            }
            return { ...frame, coords, sidechains };
        },

        /**
         * ALIGN OTHER OBJECTS ONTO THE CURRENT SELECTION.
         *
         * The reference is THE SELECTED RESIDUES, not the object they are in:
         * picking one chain of a complex, or one domain of a chain, aligns
         * everything else onto that much and nothing more. Their coordinates
         * are read from the MERGED array - where they are on screen right now,
         * alignment and all - so aligning B onto A and then C onto A puts all
         * three in one frame of reference rather than two.
         *
         * The reference object is whichever object owns the selection, found
         * with ownerOf, and it never moves. A selection spanning two objects is
         * refused rather than guessed at: there is no single thing to align to.
         *
         * @param {'all'|'visible'} mode  every loaded object, or only the drawn
         * @returns {Promise<{ref, refLen, results, skipped, inWorker}>}
         */
        async alignToSelection(mode) {
            if (!window.Align) throw new Error('the aligner is not loaded');
            const sel = this.residueSelection;
            if (!sel || sel.size === 0) throw new Error('nothing is selected');

            // WHOSE selection is it? One object's, or this cannot run.
            let refName = null;
            for (const i of sel) {
                const owner = this.ownerOf(i);
                const name = owner ? owner.name : this.currentObjectName;
                if (refName === null) refName = name;
                else if (refName !== name) {
                    throw new Error('the selection spans more than one object');
                }
            }
            if (!refName) throw new Error('nothing is selected');

            // The reference, out of the merged array: exactly the selected
            // C-alphas, in position order, as ONE chain. A selection crossing a
            // chain break is the user's to make - it is still a set of points
            // to superpose onto.
            // ...as ONE chain: chainsOf is told nothing about chain ids, so every
            // selected C-alpha lands in the same bucket whatever chain it is in.
            const refChains = window.Align.chainsOf(
                this.coords, this.positionTypes, null, sel);
            if (!refChains.length) {
                throw new Error(`the selection has fewer than ${window.Align.MIN_CHAIN} protein residues`);
            }
            const ref = { flat: refChains[0].flat, len: refChains[0].len };

            const pool = (mode === 'visible')
                ? this.drawnObjects()
                : Object.keys(this.objectsData || {});
            const targets = [];
            const skipped = [];
            for (const name of pool) {
                if (name === refName) continue;
                const idx = this._parkedFrameIndex(name);
                if (idx < 0) continue;
                // ...THE COORDINATES ON DISK, not the ones on screen. Aligning
                // an object a second time must start where its file put it,
                // or every run compounds on the last.
                const frame = this.objectsData[name].frames[idx];
                const fc = frame.coords || [];
                if (!fc.length) continue;
                const chains = window.Align.chainsOf(fc, frame.position_types,
                    frame.chains || null, null);
                if (!chains.length) { skipped.push(name); continue; }
                targets.push({ name, chains });
            }
            if (!targets.length) {
                throw new Error(skipped.length
                    ? 'no other object has a protein chain to align'
                    : 'there is nothing else to align');
            }

            const out = await window.Align.superpose({ ref, targets },
                (done, total) => { if (this.onAlignProgress) this.onAlignProgress(done, total); });
            for (const r of (out.results || [])) {
                this.setAlignTransform(r.name, { t: r.t, u: r.u, ref: refName, tm: r.tm });
            }
            this._reapplyAfterAlign();
            return { ref: refName, refLen: ref.len, results: out.results || [],
                skipped, inWorker: out.inWorker };
        },

        /** Hang a rigid motion on an object, or drop it with null. */
        setAlignTransform(name, xf) {
            const object = this.objectsData?.[name];
            if (!object) return false;
            if (xf) object.alignTransform = xf;
            else delete object.alignTransform;
            return true;
        },

        /** Every object back where its file put it. */
        clearAlignments() {
            let n = 0;
            for (const name of Object.keys(this.objectsData || {})) {
                if (this.objectsData[name].alignTransform) {
                    delete this.objectsData[name].alignTransform;
                    n++;
                }
            }
            if (n) this._reapplyAfterAlign();
            return n;
        },

        /** Is anything currently moved off its file coordinates? */
        anyAlignment() {
            return Object.keys(this.objectsData || {})
                .some(n => !!this.objectsData[n].alignTransform);
        },

        /**
         * Rebuild the picture after the coordinates moved - WITHOUT re-framing.
         * The reference did not move, so the camera still holds what it held;
         * re-framing here would zoom out over structures that have just been
         * brought together, which is the opposite of what was asked for.
         */
        _reapplyAfterAlign() {
            this._invalidateSegmentCache();
            if (this.multiState && this.multiState.enabled) {
                this._applyShownObjects(false, { reframe: false });
            } else {
                this._loadFrameData(this.currentFrame >= 0 ? this.currentFrame : 0, true);
                this.render('aligned');
            }
        },
    },
});
})();