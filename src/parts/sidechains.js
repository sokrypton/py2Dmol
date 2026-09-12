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
        // JS API alone: the website turns them on through parts/selectpanel.js and
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
        /**
         * WHICH OBJECT A NAMED SELECTOR IS REALLY ABOUT, and in whose
         * numbering.
         *
         * A per-object set - side chains, their colours - is stored against the
         * object in the object's OWN indices and read back through ownerOf, so
         * it never needed the drawn arrays. Resolving it through positionsFor
         * did, and that answers in the DRAWN array's space: a selector naming
         * an object that is not on screen resolved against the one that IS,
         * and the write landed there. Measured before this existed:
         * showSidechains({object: '1UBQ', positions: [10, 11, 12]}) with 6MRR
         * drawn put 10, 11 and 12 on 6MRR and left 1UBQ empty, silently.
         *
         * So a selector that NAMES an object the drawn arrays do not cover is
         * resolved in that object's own data and written straight to it.
         * Everything else goes the way it always did.
         *
         * 🔴 A METHOD RATHER THAN A HELPER BESIDE THE FILE, because the proto
         * is LIFTED into node by tests/lift.js and a const in this file's
         * closure is not there: "writeTargets is not defined", from
         * tests/interaction.js, which is the only suite that runs these verbs
         * without a browser. It belongs on the renderer regardless - it is a
         * question about the renderer's own state.
         */
        _writeTargets(sel) {
            const named = (sel && typeof sel === 'object' && !Array.isArray(sel)
                && !(sel instanceof Set)) ? sel.object : undefined;
            if (named && typeof this.addressesObject === 'function'
                && !this.addressesObject(named)) {
                const object = this.objectsData ? this.objectsData[named] : null;
                if (!object) {
                    throw new Error('py2Dmol: no object named '
                        + JSON.stringify(named));
                }
                return [{ object, name: named,
                    positions: [...this.objectPositions(named, sel)] }];
            }
            const set = (typeof positionsFor === 'function')
                ? positionsFor(this, sel) : new Set();
            return this.writeGroups ? this.writeGroups(set)
                : [{ object: this.objectsData[this.currentObjectName],
                     name: this.currentObjectName, positions: [...set] }];
        },

        _setSidechains(sel, on) {
            const groups = this._writeTargets(sel);
            // 🔴 ASK THE OBJECTS THIS REQUEST NAMES, NOT WHICHEVER ONE IS
            // CURRENT. `this.sidechains` is the DRAWN object's table, and the
            // guard read it for a request that may name another object
            // entirely - so `show_sidechains(name='ubq', ...)` was refused,
            // with a message about ubq, because the object the page happened
            // to open on was a C-alpha helix carrying no atoms. It threw,
            // ui.js caught and logged it, and the request was gone.
            //
            // It went unseen while the page always opened on the first object,
            // which in any payload with side chains is one that has them.
            if (on) {
                const has = groups.some((g) => g.object
                    && ((g.object.frames || []).some((f) => f && f.sidechains)
                        || (g.name === this.currentObjectName && this.sidechains)));
                if (!has) {
                    // A C-alpha trace carries none, and neither does a notebook
                    // payload built without view(sidechains=True) - the table is
                    // what would have to exist, and there is nothing to draw.
                    throw new Error('showSidechains: this structure has no'
                        + ' side-chain atoms - a C-alpha trace carries none, so'
                        + ' there is nothing to show');
                }
            }
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
            // reloadDrawn renders on its own unless told not to, and this is
            // the most-clicked of the five places that got this wrong
            this.reloadDrawn(true);
            this.render('sidechains');
            return true;
        },

        /** Draw these residues' side chains. */
        showSidechains(sel) { this._setSidechains(sel, true); return this; },

        /** ...and take them away again. */
        hideSidechains(sel) { this._setSidechains(sel, false); return this; },

        // ====================================================================
        // AND WHAT COLOUR THEY ARE, WHICH IS A SEPARATE QUESTION
        //
        // The storage has been here since the selection panel was written -
        // `obj.sidechainColor`, keyed by RESIDUE because a side-chain atom is
        // a position only while it is drawn and its index is reissued whenever
        // the set changes - and `src/parts/selectpanel.js` was the only thing that
        // could reach it. Same rule as _setSidechains above, one layer along:
        // a capability in the bundle that no interface reaches is not shipped.
        //
        // UNSET MEANS FOLLOW THE RESIDUE. That is what makes this worth having
        // rather than colouring the residues: recolour a main chain and the
        // side chains that were never given a colour of their own come with
        // it, and the ones that were stay put. Colouring side chains by
        // hydropathy over a backbone coloured by pLDDT is two questions on one
        // picture, and there is no other way to ask both.
        //
        // ONLY THE CARBON SKELETON MOVES. Element colouring is on by default
        // and resolves FIRST, so oxygen stays red and sulfur stays gold - the
        // element table returns null for carbon and for a bond's midpoint, so
        // those are the atoms that fall through to this. That is PyMOL's
        // colour-by-element too, and `hideElements(sel)` is how you get a flat
        // colour instead.
        // ====================================================================

        /**
         * Colour a selection's side chains, apart from their residues.
         *
         *     v.setSidechainColor('hydrophobicity')   // a mode, everywhere
         *     v.setSidechainColor('#ffcc00', { chain: 'A' })
         *     v.setSidechainColor(null)               // back to the residue
         *
         * A MODE IS STORED AS A MODE, not resolved into colours here.
         * Hydropathy is a fact about the residue's identity and freezing it
         * would be harmless, but pLDDT is per frame and rainbow follows the
         * chain scale - so a frozen mode would be right once and wrong from
         * the next frame on. `_sidechainColorOf` resolves it at draw time.
         *
         * @param {string|null} colour a colour, a colour mode, or null to
         *     clear - which is not the same as any colour, since unset means
         *     follow the residue.
         * @param {*} sel anything positionsFor takes; absent means every
         *     residue, as it does for every other selector-taking verb.
         */
        setSidechainColor(colour, sel) {
            let value = null;
            if (colour !== null && colour !== undefined) {
                if (typeof colour !== 'string') {
                    throw new Error('setSidechainColor: expected a colour, a'
                        + ' colour mode, or null');
                }
                const modes = (typeof getAllValidColorModes === 'function')
                    ? getAllValidColorModes() : [];
                const named = (typeof namedColorsMap === 'object'
                    && namedColorsMap) ? namedColorsMap[colour.toLowerCase()]
                    : null;
                if (colour[0] === '#') value = colour;
                else if (modes.includes(colour)) value = colour;
                else if (named) value = named;
                else {
                    throw new Error('setSidechainColor: unknown colour'
                        + ` ${JSON.stringify(colour)} - expected #rrggbb, a`
                        + ` named colour, or one of ${modes.join(', ')}`);
                }
            }
            // ...PER OWNING OBJECT AND IN ITS OWN NUMBERING, like the residue
            // colours. positionsFor answers in merged indices and the map is
            // read back through ownerOf, so writing merged indices into it
            // would point at whatever residue held that number in object one.
            const groups = this._writeTargets(sel);
            for (const g of groups) {
                if (!g.object) continue;
                const map = g.object.sidechainColor
                    ? Object.assign({}, g.object.sidechainColor) : {};
                for (const i of g.positions) {
                    if (value === null) delete map[i]; else map[i] = value;
                }
                g.object.sidechainColor =
                    Object.keys(map).length ? map : null;
            }
            // A REPAINT, not a reload: no position is created or destroyed by
            // this, unlike _setSidechains above, which appends atoms.
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;
            this.render('sidechain colour');
            return this;
        },
    },
});
})();
