// ============================================================================
// src/parts/sidechains.js
// -------------------------------
// AI Context: SIDE CHAINS (a part of Pseudo3DRenderer)
// - Which residues show theirs. The verb, for every shell.
// ============================================================================
(function () {
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({
    name: 'sidechains',
    proto: {
        // ====================================================================
        // WHICH RESIDUES SHOW THEIR SIDE CHAINS
        //
        // This was written out in parts/embed.js and reachable from the embed's
        // JS API alone: the website turns them on through app/selection.js and
        // the notebook could not turn them on AT ALL - view(sidechains=True)
        // carried the atoms and nothing could ask for them to be drawn. Same
        // shape as clipTo and orientTo before it, and the same rule: a
        // capability in the bundle that no interface reaches is not shipped.
        //
        // THE SET IS THE OBJECT'S, IN THE OBJECT'S OWN NUMBERING, which is what
        // writeGroups translates a merged selection into. And it is not a
        // repaint: the atoms become real positions APPENDED to the coordinate
        // array, so only a frame load builds them - hence reloadDrawn rather
        // than render.
        // ====================================================================

        /**
         * Add or remove a selection's side chains. Relative, like show/hide:
         * with no selector it means every residue.
         *
         * @returns {boolean} whether anything actually changed.
         */
        _setSidechains(sel, on) {
            if (on && !this.sidechains) {
                // A C-alpha trace carries none, and neither does a notebook
                // payload built without view(sidechains=True) - the table is
                // what would have to exist, and there is nothing to draw.
                throw new Error('showSidechains: this structure has no'
                    + ' side-chain atoms - a C-alpha trace carries none, so'
                    + ' there is nothing to show');
            }
            const set = (typeof positionsFor === 'function')
                ? positionsFor(this, sel) : new Set();
            const groups = this.writeGroups ? this.writeGroups(set)
                : [{ object: this.objectsData[this.currentObjectName],
                     positions: [...set] }];
            let changed = false;
            for (const g of groups) {
                if (!g.object) continue;
                const cur = g.object.sidechains instanceof Set
                    ? new Set(g.object.sidechains) : new Set();
                for (const i of g.positions) {
                    if (on ? !cur.has(i) : cur.has(i)) changed = true;
                    if (on) cur.add(i); else cur.delete(i);
                }
                g.object.sidechains = cur.size ? cur : null;
            }
            if (!changed) return false;
            this._invalidateSegmentCache();
            this.reloadDrawn();
            this.render('sidechains');
            return true;
        },

        /** Draw these residues' side chains. */
        showSidechains(sel) { this._setSidechains(sel, true); return this; },

        /** ...and take them away again. */
        hideSidechains(sel) { this._setSidechains(sel, false); return this; },
    },
});
})();
