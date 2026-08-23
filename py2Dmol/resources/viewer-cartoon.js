// ============================================================================
// py2Dmol/resources/viewer-cartoon.js
// -----------------------------------
// AI Context: CARTOON STYLE RENDERER (config.rendering.style === "cartoon")
// - Self-contained DRAW STAGE that replaces Pseudo3DRenderer's default
//   "tube" drawing. viewer-mol.js delegates here from _renderToContext()
//   once rotation and per-segment colors are computed; everything else
//   (data model, gestures, color hierarchy, selection/visibility, live
//   updates, PAE/seq/scatter sync) stays in viewer-mol.js and keeps working.
// - Geometry is a port of sokrypton/mpnn app/trace3d.js (itself from
//   CIRPIN-web src/trace3d.js), which encodes hard-won fixes: per-quad
//   depth sorting, flattened sheets, halo carving of nearer elements,
//   butt-capped halos so a segment's halo never eats its neighbour's fill.
// - Secondary structure is TM-align's make_sec (C-alpha only, no side
//   chains needed), via mpnn app/sec.js, plus its display smoothing pass.
// ============================================================================

(function () {
    'use strict';

    // ------------------------------------------------------------------------
    // Secondary structure from C-alpha geometry (port of TMalign.cpp make_sec)
    // ------------------------------------------------------------------------

    function dist(x, i, j) {
        const d1 = x[i] - x[j];
        const d2 = x[i + 1] - x[j + 1];
        const d3 = x[i + 2] - x[j + 2];
        return Math.sqrt(d1 * d1 + d2 * d2 + d3 * d3);
    }

    // Tunable thresholds for the CA-only SS assignment, in one place so
    // tests/ss_bench.js can sweep them against pydssp instead of them being
    // guessed. Exported as py2dmolCartoon.SS_PARAMS; mutating it changes the
    // assignment, which is the point - nothing else should write to it.
    const SS = {
        helixDelta: 1.9,      // secStr tolerance on the helix distance set
        strandDelta: 1.42,    // ... and on the strand set
        extPasses: 8,         // extendSec growth iterations
        chainMax: 4.6,        // CA-CA above this is a chain break
        extMode: 'hyst',      // 'hyst' (hysteresis) | 'hbond' (original)
        pruneStrands: true,   // drop unpaired strand runs (see pruneStrands)
        helixDeltaExt: 2.6,   // relaxed helix tolerance when CONTINUING
        strandDeltaExt: 1.9,  // ... and when continuing a strand (unused at maxGrowE 0)
        // Growth is limited per class, and helices grow UNCONDITIONALLY.
        // Measured: gating helix growth on geometry is not merely unnecessary
        // but harmful (Q3 84.41 gated vs 84.64 ungated), while gating strand
        // growth is essential (82.74 ungated). The asymmetry is real - a helix
        // end is determined by its own preceding turn, so make_sec's window
        // truncates it predictably and the correction is just "put it back";
        // a strand only exists by pairing with another strand, so extending one
        // needs evidence that the pairing continues.
        maxGrowH: 1,          // helix residues restored at each end
        // Strands are NOT extended. Every gated variant tried scored worse than
        // none: the relaxed distance test is not selective enough to tell a
        // real strand continuation from the coil next to it, so growth costs
        // more in false positives than it recovers. The consequence is that
        // strands render about a residue short of DSSP at each end - the
        // honest state of a CA-only test, and the thing to fix with a better
        // feature (cross-strand pairing, or a virtual-dihedral term) rather
        // than with a looser threshold.
        maxGrowE: 0,          // strand residues, gated by strandDeltaExt
        minStrand: 2,         // strand runs shorter than this are dropped
        pairFrac: 0.67,       // fraction of a strand run needing a partner
        pairMinSep: 4,        // |i-j| below this is the same strand, not a pair
        h3lo: 4.3, h3hi: 5.9, // i->i+3 helix H-bond proxy window
        h4lo: 5.4, h4hi: 7.0, // i->i+4 helix H-bond proxy window
        splo: 4.1, sphi: 5.7, // cross-strand pairing window
    };

    function secStr(dis13, dis14, dis15, dis24, dis25, dis35, hDelta, eDelta) {
        let delta = hDelta === undefined ? SS.helixDelta : hDelta;
        if (Math.abs(dis15 - 6.37) < delta && Math.abs(dis14 - 5.18) < delta
            && Math.abs(dis25 - 5.18) < delta && Math.abs(dis13 - 5.45) < delta
            && Math.abs(dis24 - 5.45) < delta && Math.abs(dis35 - 5.45) < delta) return 'H';
        delta = eDelta === undefined ? SS.strandDelta : eDelta;
        if (Math.abs(dis15 - 13) < delta && Math.abs(dis14 - 10.4) < delta
            && Math.abs(dis25 - 10.4) < delta && Math.abs(dis13 - 6.1) < delta
            && Math.abs(dis24 - 6.1) < delta && Math.abs(dis35 - 6.1) < delta) return 'E';
        if (dis15 < 8) return 'T';
        return 'C';
    }

    /** make_sec (TMalign.cpp:2466). x is a flat [x,y,z,...] array of C-alpha. */
    function makeSec(x, len) {
        const sec = new Array(len);
        for (let i = 0; i < len; i++) {
            sec[i] = 'C';
            const j1 = i - 2; const j5 = i + 2;
            if (j1 >= 0 && j5 < len) {
                sec[i] = secStr(
                    dist(x, j1 * 3, i * 3),
                    dist(x, j1 * 3, (i + 1) * 3),
                    dist(x, j1 * 3, j5 * 3),
                    dist(x, (i - 1) * 3, (i + 1) * 3),
                    dist(x, (i - 1) * 3, j5 * 3),
                    dist(x, i * 3, j5 * 3),
                );
            }
        }
        return sec.join('');
    }

    /** secStr for residue i of a flat CA array, at explicit tolerances. */
    function secAt(x, len, i, hDelta, eDelta) {
        if (i - 2 < 0 || i + 2 >= len) return 'C';
        return secStr(
            dist(x, (i - 2) * 3, i * 3),
            dist(x, (i - 2) * 3, (i + 1) * 3),
            dist(x, (i - 2) * 3, (i + 2) * 3),
            dist(x, (i - 1) * 3, (i + 1) * 3),
            dist(x, (i - 1) * 3, (i + 2) * 3),
            dist(x, i * 3, (i + 2) * 3),
            hDelta, eDelta,
        );
    }

    /**
     * HYSTERESIS extension. make_sec's 5-residue window cannot classify the
     * first or last two residues of any element, so helices and strands always
     * stop short and have to be grown back out.
     *
     * The previous method grew them using hydrogen-bond PROXIES on CA geometry
     * - a different signal from the one that seeded the element - and measured
     * against pydssp on 151 natives it cost more than it bought: H and E recall
     * rose to 92% but 2930 coil residues were swallowed, and Q3 fell from 82.0%
     * (no extension at all) to 77.5%. Growth in a signal the seeding never
     * agreed with has nothing to stop it.
     *
     * Hysteresis keeps ONE signal and uses two tolerances on it: strict to
     * START an element, loose to CONTINUE one - the standard fix for a detector
     * that truncates its own boundaries. A residue joins the element beside it
     * only if TM-align's own distance set still calls it that class at the
     * relaxed tolerance, and only within maxGrow residues of the seeded end,
     * which is the width of the window that created the truncation.
     */
    function extendSecHyst(x, len, sec) {
        const a = [...sec];
        const d = (i, j) => dist(x, i * 3, j * 3);
        const chainOk = (i) => i >= 0 && i + 1 < len && d(i, i + 1) < SS.chainMax;
        const maxPass = Math.max(SS.maxGrowH, SS.maxGrowE);
        for (let pass = 0; pass < maxPass; pass++) {
            const prev = a.slice();
            for (let i = 0; i < len; i++) {
                if (prev[i] === 'H' || prev[i] === 'E') continue;
                const left = i > 0 ? prev[i - 1] : null;
                const right = i + 1 < len ? prev[i + 1] : null;
                for (const t of ['H', 'E']) {
                    if (t === 'H' && pass >= SS.maxGrowH) continue;
                    if (t === 'E' && pass >= SS.maxGrowE) continue;
                    const joinL = left === t && chainOk(i - 1);
                    const joinR = right === t && chainOk(i);
                    if (!joinL && !joinR) continue;
                    if (t === 'H') { a[i] = 'H'; break; }   // ungated, see above
                    if (secAt(x, len, i, SS.helixDelta, SS.strandDeltaExt) === 'E') {
                        a[i] = 'E';
                        break;
                    }
                }
            }
        }
        return a.join('');
    }

    /**
     * Drop strand runs that have no cross-strand PARTNER.
     *
     * make_sec's strand test is purely local - a set of CA-CA distances over a
     * 5-residue window - so a tight turn whose geometry happens to fall inside
     * the strand tolerances is called 'E' even though nothing is paired with
     * it. Measured on 1TIM against pydssp: 12 coil residues came out as strand,
     * in runs of 2-3, all inside loops. Rendered, a 2-residue strand is a wide
     * green arrow cutting through a curved region.
     *
     * A beta strand is not a local conformation, it is a PAIRING: it only
     * exists because another strand runs alongside it. So require exactly
     * that - some residue at least minSep apart in sequence, at sheet contact
     * distance - for a sufficient fraction of the run, and delete the run
     * otherwise. This is the same geometric test the old extendSec used to GROW
     * strands, which was the wrong direction: as a filter it removes false
     * positives instead of manufacturing them.
     */
    function pruneStrands(x, len, sec) {
        const a = [...sec];
        const d = (i, j) => dist(x, i * 3, j * 3);
        const paired = (i) => {
            for (let j = 0; j < len; j++) {
                if (Math.abs(j - i) < SS.pairMinSep) continue;
                const v = d(i, j);
                if (v > SS.splo && v < SS.sphi) return true;
            }
            return false;
        };
        for (let i = 0; i < len; i++) {
            if (a[i] !== 'E') continue;
            let hi = i;
            while (hi + 1 < len && a[hi + 1] === 'E') hi++;
            const runLen = hi - i + 1;
            let nPaired = 0;
            for (let k = i; k <= hi; k++) if (paired(k)) nPaired++;
            if (runLen < SS.minStrand || nPaired < runLen * SS.pairFrac) {
                for (let k = i; k <= hi; k++) a[k] = 'C';
            }
            i = hi;
        }
        return a.join('');
    }

    /**
     * Tidy a secondary-structure string for DISPLAY (not for alignment).
     * Bridges a one-residue gap inside an element and drops lone speckle;
     * deliberately does NOT grow element ends (that would draw structure
     * that was never assigned).
     */
    function smoothSec(sec) {
        const a = [...sec];
        for (let i = 0; i + 2 < a.length; i++) {
            for (const j of ['H', 'E']) {
                if (a[i] === j && a[i + 1] !== j && a[i + 2] === j) a[i + 1] = j;
            }
        }
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== 'H' && a[i] !== 'E') continue;
            const before = i > 0 && a[i - 1] === a[i];
            const after = i + 1 < a.length && a[i + 1] === a[i];
            if (!before && !after) a[i] = 'C';
        }
        return a.join('');
    }

    /**
     * Extend element ends using HYDROGEN-BOND PROXIES on C-alpha geometry.
     * make_sec's 5-residue window cannot classify the first/last two
     * residues of any element, so helices and strands always stop short.
     * A residue adjacent to a helix joins it while it stays "self-paired":
     * d(i,i+3) ~ 5.1 A and d(i,i+4) ~ 6.2 A (the i -> i+4 backbone H-bond
     * proxy), looking forward at the N-end and backward at the C-end. A
     * residue adjacent to a strand joins it while it keeps a CROSS-STRAND
     * partner: some j (|i-j| >= 4, possibly long-range) at sheet contact
     * distance (~4.8-5.2 A) whose neighbour j+-1 also pairs with the
     * adjacent strand residue (the +-1 covering parallel and antiparallel).
     */
    function extendSec(x, len, sec) {
        if (SS.pruneStrands !== false) sec = pruneStrands(x, len, sec);
        if (SS.extMode === 'hyst') return extendSecHyst(x, len, sec);
        return extendSecHBond(x, len, sec);
    }

    function extendSecHBond(x, len, sec) {
        const a = [...sec];
        const d = (i, j) => dist(x, i * 3, j * 3);
        const chainOk = (i) => i >= 0 && i + 1 < len && d(i, i + 1) < SS.chainMax;
        const h3 = (i, j) => { const v = d(i, j); return v > SS.h3lo && v < SS.h3hi; };
        const h4 = (i, j) => { const v = d(i, j); return v > SS.h4lo && v < SS.h4hi; };
        const helixFwd = (i) => i + 4 < len && h3(i, i + 3) && h4(i, i + 4);
        const helixBwd = (i) => i - 4 >= 0 && h3(i - 3, i) && h4(i - 4, i);
        const sp = (i, j) => { const v = d(i, j); return v > SS.splo && v < SS.sphi; };
        const strandPair = (i, iPrev) => {
            for (let j = 0; j < len; j++) {
                if (Math.abs(j - i) < 4 || !sp(i, j)) continue;
                if (j + 1 < len && sp(iPrev, j + 1)) return true;
                if (j - 1 >= 0 && sp(iPrev, j - 1)) return true;
            }
            return false;
        };
        for (let pass = 0; pass < SS.extPasses; pass++) {
            let changed = false;
            for (let i = 0; i < len; i++) {
                if (a[i] === 'H' || a[i] === 'E') continue;
                const prevH = i > 0 && a[i - 1] === 'H';
                const nextH = i + 1 < len && a[i + 1] === 'H';
                if ((nextH && chainOk(i) && helixFwd(i))
                    || (prevH && chainOk(i - 1) && helixBwd(i))) {
                    a[i] = 'H';
                    changed = true;
                    continue;
                }
                const prevE = i > 0 && a[i - 1] === 'E';
                const nextE = i + 1 < len && a[i + 1] === 'E';
                if ((prevE && chainOk(i - 1) && strandPair(i, i - 1))
                    || (nextE && chainOk(i) && strandPair(i, i + 1))) {
                    a[i] = 'E';
                    changed = true;
                }
            }
            if (!changed) break;
        }
        return a.join('');
    }

    // ------------------------------------------------------------------------
    // Cartoon dimensions in ANGSTROMS, scaled at draw time by the width slider
    // (renderer.lineWidth / 3.0, so the default slider position is 1x).
    // Values match trace3d.js, where they were tuned against real renders.
    // ------------------------------------------------------------------------
    // ribbon half-width. C is only used by the SQUARE LOOP style, where a
    // loop is built by the slab pipeline with width == thickness, giving a
    // square-section tube instead of a stroked round one.
    const SS_HALF_A = { H: 1.3, E: 1.1, C: 0.42 };
    // ---- RICHARDSON PRESET -------------------------------------------------
    // Jane Richardson's hand-drawn convention, as a set of per-SS overrides on
    // the same slab pipeline. The differences from the default cartoon are all
    // about which elements read as SOLID and which read as RIBBON:
    //   - strands are the widest thing on the page and carry an ARROWHEAD, and
    //     they have real thickness so the sheet reads as a slab you could
    //     stack. They are also the only element with a light edge.
    //   - helices are WIDE but essentially FLAT - a paper streamer coiling in
    //     space. Thickness there would fight the coil, which is why the
    //     default single global thickness cannot serve both.
    //   - loops are thin and round, closer to a wire than a ribbon, so they
    //     recede and let the elements dominate.
    // C is 0.525 rather than 0.30 so that a loop keeps the size it had when its
    // width was taken from the THICKNESS control: 0.525 * (2/3 width scale) is
    // the 0.35 half-side it used to get from thickness 0.7. Same picture at the
    // defaults, but Width now moves it.
    // RESCALED SO THE WIDTH CONTROL MEANS THE SAME THING IN EVERY PRESET.
    //
    // These were 1.45 / 1.65 / 0.525, and richardson compensated for them by
    // asking for a Width of 2.0 where the other presets ask for 3.0 - so with
    // widthScale = lineWidth / 3, the drawn half-widths came out at 2/3 of the
    // table. Two knobs cancelling each other: the slider read 2.0 against 3.0
    // for the same ribbon on screen, richardson sat pinned on the slider's
    // minimum, and giving all three presets one width silently made richardson
    // half again as wide because it removed one side of the cancellation.
    //
    // The factor is folded in here instead. Every preset now starts at
    // PRESET_WIDTH, one slider value means one width everywhere, and richardson
    // draws exactly the ribbon it drew before: these are the old numbers times
    // 2/3, which is what the old pairing produced.
    const RICH_HALF_A = { H: 0.9667, E: 1.1, C: 0.35 };
    // Per-SS thickness, RELATIVE to the Thick setting rather than absolute.
    // The whole point of the preset is that one global thickness cannot give
    // flat helices and solid strands at once - but the Thick slider still has
    // to work, and thickness 0 still has to mean "flatten everything", so
    // these are ratios and the slider supplies the scale. Loops are ignored
    // here: they take thickness == width (square section) so they read round.
    const RICH_TH_REL = { H: 0, E: 1.0, C: 1.0 };
    // Default total thickness when the Richardson style is selected. The
    // global default is 0 (flat ribbons), which would cancel the preset
    // entirely, so selecting this style seeds the Thick control instead of
    // silently ignoring it.
    const RICH_THICK_DEFAULT = 0.7;
    // Outlines in the drawings are a dark tint of the element's own colour, not
    // black - black flattens the palette and fights the pale sheet edges.
    const RICH_TINT_DEFAULT = 0.8;
    // The drawings carry a much stronger specular band than the default
    // cartoon - it is what makes a helix read as a glossy coiled streamer.
    const RICH_HILITE_DEFAULT = 3.0;
    // Width slider default for the preset. RICH_HALF_A already sets the per-SS
    // proportions; this sets the overall scale they are drawn at.
    // ONE WIDTH FOR EVERY PRESET. Richardson used to ask for 2.0 while cartoon
    // and 3d asked for 3.0, which made the same structure change width when you
    // switched preset - and because widthScale is lineWidth / 3.0, that is a
    // third narrower, not a nuance. Width is not part of what distinguishes
    // these looks: thickness, outline, tint, pencil and the per-SS profile are.
    //
    // It also sat exactly on the Width slider's own minimum, so richardson was
    // pinned to the left end with no room below it, and "the preset did not
    // apply" was indistinguishable from "the slider is at its floor".
    //
    // Shared as one constant rather than three literals so they cannot drift
    // apart again.
    const PRESET_WIDTH = 3.0;
    // Richardson sits at the TOP of the slider, and the slider's top is
    // exactly the grain the preset used to apply (0.9 x 0.6 = 0.54 alpha). So
    // pencil = 1 in plain cartoon now matches the Richardson default rather
    // than overshooting it, and the control spans a useful range instead of
    // spending its upper half beyond anything the style ever wanted.
    const CEL_LEVELS = 8;          // flat tone bands when Poster is on
    // Detail is an INTEGER, 1-4: the number of subdivisions each helix
    // residue gets at the sampling floor (other elements keep their tuned
    // ratios). Internally it maps to the old fraction (N/8), so Detail 4
    // renders identically to the previous tuned ceiling of 0.5; above that
    // extra stations cost time without changing the drawn curves.
    // Detail is subdivisions per residue for a HELIX (ratio 8, so detailCur
    // = N/8 gives exactly N); flatter elements take their own ratio of it.
    // The range runs 2-8: 2 is the geometric floor (see MIN_SUB) and 8 is
    // where the retired adaptive term used to sit when it was floor-bound,
    // i.e. the old smooth look is still reachable at the top of the slider.
    const DETAIL_MIN_N = 2;
    const DETAIL_MAX_N = 8;
    // Default 4: the midpoint of the range. The retired adaptive term
    // produced ~8.7 subdivisions per helix residue on a 600px canvas and
    // ~6 on a 430px one, so 4 is about half the old sampling for roughly
    // half the frame time, and 8 reproduces the old look outright. 2 is
    // the geometric floor (see MIN_SUB) and reads as deliberately faceted.
    const DETAIL_DEFAULT_N = 4;
    // --- HAND-DRAWN BUILD-UP (see animateDrawing in viewer-mol.js) ----------
    // Graphite, not black: a pencil under-drawing is grey and slightly warm,
    // and it has to sit UNDER the ink without competing with it. Light, too -
    // this is the layer you are meant to look past.
    // Dark warm graphite on white paper. It was lighter once, on the theory
    // that an under-drawing should be something you look past - but the layer
    // has to be READABLE first: thin strokes at low alpha over a white ground
    // disappear long before they read as pencil. Fine AND dark is a sharp
    // pencil; fine and pale is nothing at all.
    //
    // On a black ground the same argument runs the other way: graphite on black
    // is invisible, and what an illustrator reaches for is a white pencil - so
    // the layer flips with the background, exactly as the ink and the paper
    // tone already do. Warm off-white rather than pure white, to keep it a
    // pencil rather than a highlight.
    const SKETCH_ON_WHITE = 'rgb(74, 68, 62)';
    const SKETCH_ON_BLACK = 'rgb(228, 223, 213)';
    let SKETCH_CSS = SKETCH_ON_WHITE;
    // ONE pencil line, continuous - not several passes overlaid. The layers of
    // the drawing do not accumulate on top of each other; each one ERASES what
    // is under it as it advances. So a given stretch of the picture is pencil
    // until the colour reaches it, and colour from then on, and the pencil
    // exists only in the band between where the hand has drawn and where the
    // brush has caught up.
    //
    // No dashes either. A dashed line is what a pencil looks like from close
    // up on rough paper; on screen, at this size, it just looks dashed.
    // Time to draw one residue: PACE_FLOOR on a dead straight run, plus
    // PACE_CURVE x (turn angle / pi). Measured over 40 chains of the SS
    // benchmark, this puts the sharpest 5% of turns at 2.0x the time of a
    // straight step, loops at 1.28x and helices at 1.12x. A helix is close to
    // straight here on purpose - its AXIS is what the hand follows, and paying
    // for its per-residue coil made the pen crawl through most of a typical
    // protein, which reads as uniformly slow rather than as slowing down.
    //
    // The floor matters as much as the coefficient: with the floor at 1 the
    // whole range compresses into 1.0-1.5x and the effect stops being visible.
    const PACE_FLOOR = 0.4;
    const PACE_CURVE = 2.6;
    // A gap longer than this is a chain break, not a corner.
    const PACE_BREAK_A = 5.0;
    // Half-width, in residues, of the smoothing applied before curvature is
    // measured. 3 is a 7-residue window - about two turns of a helix, which is
    // what it takes to average one down to its axis. At 2 the leftover coil
    // still reads as curvature and helices come out 1.55x slow.
    const PACE_SMOOTH = 3;
    const SKETCH_ALPHA = 0.55;
    // Pencil width in pixels, INDEPENDENT of the outline control. It used to be
    // a fraction of the ink width, which tied the pencil to a setting that has
    // nothing to do with it: the 3d preset draws no outline at all, so the
    // pencil collapsed to its floor and the drawing was invisible, and even at
    // the default outline it came out at 0.69px - a hairline that reads as a
    // smudge rather than a line. A pencil is a pencil whatever the style does
    // about outlines afterwards, so it is stated here in pixels, and only
    // pxScale (the export factor) moves it.
    const SKETCH_PX = 1.3;
    // The pencil is not erased by the paint - it SHOWS THROUGH it. A wash is
    // transparent, so the graphite under it stays visible; what happens to it
    // is that it gets rubbed out at the end, once the ink is down, which is
    // what the ERASE window in animateDrawing does. So behind the brush the
    // line drops to a fraction of its strength rather than to nothing.
    const SKETCH_UNDER = 0.45;
    // Width of the step from full strength to that fraction, in fractions of
    // the chain, and how many alpha levels it is drawn in. Stepped rather than
    // per-segment because the whole layer is one stroked path per level; four
    // is enough that it reads as the paint dulling the line rather than as a
    // hard edge travelling over it.
    const SKETCH_ERASE_U = 0.05;
    const SKETCH_BANDS = 4;
    // How far a sketch stroke wanders from the true line, in pixels. Big
    // enough to read as a hand at a glance, small enough that the sketch still
    // predicts where the ink lands - past about 2px the two layers stop
    // looking like the same drawing.
    const SKETCH_WOBBLE_PX = 0.9;
    // Watercolour runs. A wash that stops exactly on its edge everywhere is
    // the one thing that never happens on wet paper, but a wash that runs
    // EVERYWHERE is a blur - so a minority of pieces bleed, faintly.
    // How far the colour layer sits off register, in pixels. A hand colouring a
    // drawing does not follow its own pencil exactly, and that near-miss is
    // most of what makes the result read as painted rather than as computed.
    const WASH_OFF_X = 0.9;
    const WASH_OFF_Y = -0.7;
    const WASH_SMEAR_FRAC = 0.18;   // share of pieces that run
    const WASH_BLEED_ALPHA = 0.30;  // how strongly, relative to the wash
    const WASH_BLEED_PX = 3.0;      // how far, mostly downhill
    const PENCIL_DEFAULT = 1.0;    // grain amount when the preset is selected
    const PENCIL_STRENGTH = 0.54;
    // Paper tooth size, as a multiplier on the grain tile. Below 1 the texture
    // is finer; the drawings it imitates have a tight tooth, and at 1.0 the
    // speckle read as coarse against the ribbon widths at normal zoom.
    // Going much below this starts washing the tooth into a flat tint - the
    // clusters stop resolving and only the broad mottle survives.
    const GRAIN_SCALE = 0.4;       // texture scale: <1 minifies, so finer
    const PENCIL_TOOTH = 70;       // tooth amplitude (~3 px clusters)
    const PENCIL_GRIT = 26;        // finest bite on top of the tooth
    const PENCIL_MOTTLE = 40;      // broad paper unevenness amplitude
    // Default sheet flattening for the preset. Strands in the drawings are
    // flat; the pleat is a real feature of the backbone, so this is a
    // deliberate stylisation and stays adjustable rather than hard-coded.
    const SHEET_FLAT_DEFAULT = 1.0;
    const RICH_ARROW_W = 1.5;    // arrowhead half-width, x the strand's own
    const RICH_ARROW_TIP = 0.06; // half-width at the very point, in Angstroms
    // Arrowhead length in ANGSTROMS along the centreline - about two thirds of
    // a CA-CA step. NOT a fixed fraction of the interval's parameter u: the
    // centreline is a Hermite curve whose speed depends on its end tangents, so
    // equal spans of u are unequal spans of ARC LENGTH, and heads came out
    // visibly different sizes from strand to strand. Solving for u by arc
    // length makes every head the same physical length.
    // Was 0.5 (1.90 A) and read slightly stubby against the width the head
    // already flares to (RICH_ARROW_W = 1.5x the strand); 0.65 is 2.47 A.
    // A short final interval still clamps the head to 85% of its arc length,
    // so this cannot eat a whole strand.
    const CA_STEP_A = 3.8;
    const ARROW_LEN_A = CA_STEP_A * 0.65;
    // Nucleic backbone half-width. Wider than a protein coil (0.42) - the
    // strand has to stay legible next to 3.6 A base plates, and a duplex
    // read as thread when it matched the coil width - but NO WIDER THAN THE
    // PROTEIN MAIN CHAIN (SS_HALF_A.H, 1.3). At 1.55 and above the rails are
    // the fattest thing on a nucleosome and the DNA reads as the subject with
    // the histones drawn around it; matched to the helix ribbon the two read
    // as the same kind of object at the same scale, which is what a complex
    // is. This is the width the Width slider used to reach only at its 2.0
    // end, so a drawing that wanted it no longer has to spend the slider.
    const NA_HALF_A = 1.33;
    const LOOP_TUBE_A = 0.35;              // loop tube radius
    const RIBBON_TH_A = 0.25;              // slab half-thickness (total 0.5 A)
    // NUCLEIC GEOMETRY IS THICKER THAN PROTEIN. A duplex is drawn as two thin
    // rails carrying a ladder of rungs, and at the ribbon's own 0.7-1.0 the
    // rails read as tape rather than as the backbone of something with a
    // diameter. 1.5 gives them body without touching protein, which needs none.
    // Same rule the ligand section follows: a preset asking for FLAT still gets
    // flat, so the ribbon preset is unaffected, and the Thickness control takes
    // over the moment the user moves it.
    const NA_THICK_DEFAULT = 1.5;
    const NA_TUBE_A = 1.0;                 // nucleic backbone tube radius
    // BASE PLATES. Only the C4' atom survives parsing (viewer.py keeps one
    // point per nucleotide), so there is no glycosidic vector and no base
    // plane to read - the plate frame has to come from the backbone curve
    // itself. Smoothing the trace over roughly one helical turn yields the
    // local helix AXIS; the base then lies along the inward radial direction,
    // in the plane whose normal is the axis. That is exactly true for an ideal
    // duplex and degrades gracefully elsewhere (see NA_PLATE_MIN/MAX).
    // Fitted over 550 nucleotides from 1BNA/1EHZ/1AOI/355D/2R8S in the local
    // (T, N, B) frame of the C4' trace. Direction of the base centroid from
    // C4', and the base-plane normal; DNA and RNA are separate because the
    // binormal term changes sign between B-form and A-form.
    // An earlier attempt placed each base independently by a direction fitted
    // in a local frame of the C4' trace (scripts kept in the scratchpad
    // analysis: median error 8.3 deg for DNA, 18.4 for RNA). It is not used:
    // pairing gives the frame EXACTLY, since a pair's midpoint lies on the
    // helix axis, and a fitted per-residue direction cannot guarantee the two
    // halves of a pair end up coplanar - which is the thing that makes them
    // read as base pairs.
    // Just enough to bury the joint. A flat ribbon's surface is the C4' plane
    // itself, so anything much past it protrudes out the far side as a tab.
    // 0.5, not 0.25. Measured facing (fraction of pairs whose ribbon face
    // actually points at its partner): 1BNA 88% -> 100%, and the 1YNE RNA
    // hairpin 45% -> 100%. A hairpin transports its frame THROUGH the
    // unpaired loop with nothing to correct it, so it arrives on the
    // returning strand rotated; a weak gain never catches up, which showed
    // as the two halves not facing each other past the loop.
    // The backbone face should point where the BASE points, not at the partner's
    // C4' - those differ by ~40 deg. Fitted C4'->base direction in the local
    // (T, N=curvature, B=TxN) frame; benchmarked in tests/na_bench.py, which
    // scores the face against the real base centroid from full-atom structures.
    // Overall median error 39.9 -> 21.6 deg, and 43 -> 14 on B-DNA duplexes.
    // HYBRID frame (local tangent; second axis the radial toward the helix axis
    // fitted through pair midpoints). Refit in exactly that frame - reusing the
    // local-curvature constants here scored 47 deg because the frame changed and
    // the numbers did not. Benchmark: overall median 21.2 -> 15.5 deg, B-DNA
    // 14.4 -> 8.7. Held out (fit on 1BNA+1EHZ, scored on the other three) it
    // reproduces, so this is not fitting itself.
    const NA_BASE_DIR_D = [0.024, 0.679, 0.734];   // DNA, hybrid frame
    const NA_BASE_DIR_R = [0.071, 0.914, 0.400];   // RNA, hybrid frame
    // Fallback for unpaired residues, where there is no axis: the older fit in
    // the raw local-curvature frame.
    const NA_LOCAL_DIR_D = [0.012, 0.954, 0.299];
    const NA_LOCAL_DIR_R = [0.051, 0.783, -0.620];
    // 1.0, not 0.5: against the base-direction metric the gain is monotonic.
    // 0.5 was optimal only for the old facing% test, which checks a SIGN and so
    // read 100% while every face sat ~40 deg off the base.
    const NA_TRACK_DEFAULT = 1.0;   // how hard the backbone frame follows the pairing
    // Most the ribbon may twist between consecutive residues. A duplex turns
    // ~32 deg per step, so this leaves normal helical twist untouched and only
    // clamps the flips.
    const NA_TWIST_MAX = 60 * Math.PI / 180;
    // Only has to break exact coplanarity so the depth sort is deterministic -
    // NOT to open a visible gap. At 0.30 A this was ~3 px at normal zoom and
    // read as the rung floating off the backbone; the comparison is in world z,
    // so a hair is enough.
    const NA_PLATE_SEG = 4;      // rung depth-sort pieces at detail 1
    const NA_JOINT_CLEAR = 0.02; // A, min offset from the backbone face
    const NA_PLATE_W = 3.6;     // plate width along the helix axis, A (~the 3.4 A rise)
    // (A rung's thickness is no longer its own number: it follows the
    // backbone at half, so renderer.cartoonNaPlateTh no longer has an
    // effect. NA_PLATE_W still sets the rung's WIDTH at the pair.)
    // NEGATIVE: the outline stroke is wider than the plate (thPx + outlineW),
    // so it has to be painted BEHIND the fills, which then cover its middle
    // and leave only the rim. Biased in front it simply swallows the plate.
    // BASE PAIRING. C4'-C4' across a Watson-Crick pair sits near 10.5 A in
    // B-DNA and A-RNA alike (the sugars are on opposite backbones, so the
    // span is set by the duplex diameter, not by which bases are involved).
    // Pairing is what makes the plates read as RUNGS instead of two rows of
    // inward stubs, so it is worth detecting even without base atoms.
    // MEASURED, not assumed: across a Watson-Crick pair (identified by the
    // N1/N3 H-bond being under 3.2 A) the C4'-C4' span is 14.61 A with sd 0.33
    // in both 1BNA and 355D - a tight enough band to identify pairs on its own.
    // An earlier guess of 10.5 A here excluded every real pair.
    const NA_PAIR_MIN = 11.0;   // A, C4'-C4' across a pair
    const NA_PAIR_MAX = 16.5;
    const NA_PAIR_IDEAL = 14.6;
    const NA_RUN_W = 0.6;         // weight on contiguous register length
    const NA_WOBBLE_RUN_W = 0.5;  // what a bridging G.U contributes to that
    // 6.8, not 7.5. True pairs sit at ~5.9-6.4 A; the false ones that survive
    // cluster at 6.9-7.5, so the looser cutoff was letting exactly those in
    // (measured on 9FOG and 5H0R). Tightening loses no true pairs.
    // Base-geometry gate on a candidate pair. These are set for PREDICTED base
    // frames (the only kind there are): centroid separation and coplanarity,
    // wide enough to keep 86% of true pairs while rejecting three quarters of
    // the false candidates. See tests/na_table.py for what the prediction is
    // worth and viewer-cartoon's pairing test for how they are used.
    const NA_BASE_SEP_MAX = 12.0;  // A, base-centroid separation across a pair
    const NA_COPLANAR_MIN = 0.25;  // |n.n| between the two base planes
    const NA_PAIR_SEQ_GAP = 3;  // ignore near-neighbours along the same strand
    // Stem-growing pass. Measured over 291 consecutive true pairs: the step
    // between neighbouring pair midpoints is 4.17 A median (p95 4.83, max
    // 5.33) and the deviation from the axis is 1.56 A mean (p95 2.54).
    const NA_RISE_MIN = 2.5;
    const NA_RISE_MAX = 5.4;
    const NA_AXIS_OFF = 2.6;
    const NA_GROW_ROUNDS = 4;
    const NA_AXIS_WIN = 3;      // +/- pairs in the least-squares helix-axis fit
    // Loops recede: most of a trace IS loop, so this multiplies almost
    // everything on screen - enough to let elements come forward, not enough
    // to bleach the rest.
    const LOOP_DIM = 0.85;
    // How hard a ligand models, against the backbone tube's 1.0. Enough to say
    // "this is round and lit from over there" and no more: a ligand is a detail
    // inside the picture, and modelling it as strongly as the backbone made it
    // the loudest thing on screen.
    const LIGAND_MODEL = 0.35;
    // --- LIGAND STICKS -----------------------------------------------------
    // A bond is drawn as a BOX: two square end faces of half-side
    // LIGAND_STICK_H, joined by four faces. Just under the Richardson loop's
    // 0.35 A, so a ligand reads as finer than the backbone it hangs off.
    // tests/junction_math.py derives everything here and checks it numerically.
    const LIGAND_STICK_H = 0.30;
    // A LIGAND KEEPS ITS OWN WIDTH. The Line Width control sets how heavy the
    // BACKBONE is drawn, and a ligand is not part of that: sticks that grew and
    // shrank with it stopped reading as a small thing sitting in a big one.
    // 2.5 on the same scale the control uses, so the section no longer depends
    // on it at all.
    const LIGAND_WIDTH = 2.5;
    // A LONE ATOM IS A BALL, AND ITS SIZE IS THE ELEMENT'S. A metal ion is a
    // position with no bonds at all, so it misses every width the sticks use
    // and came out at the 'L' baseline like everything else: 0.6 A of radius,
    // the same for a zinc as for a chloride, and thinner than the bonds around
    // it. Nothing else in a structure is drawn to a size that says WHAT it is,
    // because nothing else is a bare atom - a ribbon stands for a residue.
    //
    // van der Waals radii, Bondi (1964) where he gives one and Alvarez (2013)
    // for the transition metals he does not. NOT ionic radii: an ion in a
    // structure is drawn at the size it occupies, which is the vdW sphere, and
    // Zn(2+) at 0.74 A would be smaller than the sticks again.
    const VDW_A = {
        H: 1.20, C: 1.70, N: 1.55, O: 1.52, F: 1.47, NA: 2.27, MG: 1.73,
        AL: 1.84, SI: 2.10, P: 1.80, S: 1.80, CL: 1.75, K: 2.75, CA: 2.31,
        MN: 2.05, FE: 2.04, CO: 2.00, NI: 1.63, CU: 1.40, ZN: 1.39, SE: 1.90,
        BR: 1.85, SR: 2.49, MO: 2.17, AG: 1.72, CD: 1.58, I: 1.98, W: 2.18,
        PT: 1.75, AU: 1.66, HG: 1.55, PB: 2.02,
    };
    // Carbon's, for an atom whose element the file did not say.
    const VDW_DEFAULT = 1.70;
    // AT THE FULL RADIUS, not a fraction of it. A lone atom is the one thing in
    // this drawing that IS an atom - everything else stands for a residue - so
    // it is drawn the size an atom is. Zinc's vdW radius is 1.39 A against
    // carbon's 1.70: SMALLER than a carbon, which is not what people expect of
    // a metal, but it is what makes the sizes mean something. What made an ion
    // look wrong before was not the element, it was 0.6 A for all of them.
    const ION_VDW_FRAC = 1.0;
    /**
     * How big a lone atom of this element is drawn, in Angstrom.
     *
     * EXPORTED, because two files need the same number: this one draws the
     * ball, and viewer-mol.js sizes the click target and the selection band
     * from it. A second copy of the table there would drift.
     */
    function loneAtomRadiusA(el) {
        const k = (el || '').toUpperCase();
        return (VDW_A[k] || VDW_DEFAULT) * ION_VDW_FRAC;
    }

    // ...and its own THICKNESS, for the same reason. 0.5 A total against the
    // 0.5 A width the line above works out to, so the section is square. The
    // control still takes it over the moment the user moves it (0 included,
    // which is the flat single-face path); what this replaces is the ribbon
    // PRESET reaching in - plain cartoon asks for 0 because it wants a flat
    // ribbon, and a ligand followed it into being a sheet, so the same molecule
    // changed shape between cartoon and richardson.
    // A CONTACT IS CUT FOR DEPTH. Target length of one piece, in Angstrom, and
    // a ceiling on how many: a contact can cross the whole structure, and past
    // a point the extra pieces buy no ordering and cost prims. 2 A is about a
    // residue's spacing, which is the scale at which it can pass behind one
    // thing and in front of the next.
    // A CONTACT KEEPS ITS OWN WIDTH, in ANGSTROM, on the same scale the Line
    // Width control works in - so the control no longer reaches it at all (see
    // the generic segment loop) but it still grows and shrinks with the
    // structure. For reference the ribbon's own half-widths are SS_HALF_A:
    // 0.42 A for a loop, 1.3 for a helix. Each contact then scales this by its
    // own stored weight, which is at most 1.
    // The SAME number viewer-mol.js calls CONTACT_WIDTH_A - a contact that
    // changed width when you switched style is what this exists to stop, and
    // tests/interaction.js checks the two against each other. It is HALF what
    // tube used to draw at its widest: the Line Width slider tops out at 4.7,
    // a contact took half of that, and half again is 1.175.
    const CONTACT_WIDTH = 1.175;
    const CONTACT_SEG_A = 2.0;
    const CONTACT_SEG_MAX = 24;
    // A CONTACT SITS TOWARD THE VIEWER BY ITS OWN RADIUS. It is drawn as a line
    // but stands for something with thickness, so what should sort is its NEAR
    // SURFACE, not its centre line. The case that matters is a contact joining
    // two parts at the same depth - two strands of a flat sheet above all -
    // where the centre lines coincide and the sort is a coin toss.
    //
    // ...UNLESS THE RIBBON IS THICKER. A slab has a near surface too, and if it
    // stands proud of the contact's then it genuinely is in front and should
    // cover it. So the bias is the difference of the two radii and never
    // negative: at the default thickness the contact wins by a little, and past
    // the point where the ribbon is fatter than the contact the ribbon wins,
    // which is what a thickness control is for.
    const CONTACT_TUBE_R = 0.5;
    const LIGAND_TH_DEFAULT = 0.5;
    // Ceiling on that, in Angstrom, TOTAL thickness. Sticks are 0.3 A wide, so
    // past this they stop reading as sticks; the ribbon has no such limit and
    // carries on.
    const LIGAND_TH_MAX = 0.5;
    // NO ANGLE CUTOFF: every side chain gets its end square cut into the
    // surface it leaves through, however shallowly it leaves. There was a 0.35
    // floor on |axis.normal| - about a tenth of real side chains fall below it
    // - on the grounds that the corners travel far and the section stretches
    // into a sliver. The floor is gone because the CAUSE is: the runaway came
    // from assuming the bond exits through the face, and picking the surface it
    // really exits through bounds the travel instead. See ribbonSurfaceToward.
    //
    // This epsilon is only the divide-by-zero guard. A bond running exactly
    // along a surface never meets its plane, so the divisor goes to zero and
    // the corners go to infinity - a broken frame, not a shallow joint.
    //
    // TWO CORRECTIONS TO WHAT USED TO BE WRITTEN HERE, both worth keeping
    // because both misled:
    //
    //  - a distance bound was once removed on the strength of "measured well
    //    behaved down to |axis.normal| = 0.002". That was wrong. The real law
    //    is corner travel = 0.37/|d.n| Angstrom, so 0.002 is 185 A; the
    //    measurement that said otherwise happened to sample bonds whose offset
    //    was tiny. A travel bound is back, at the side-chain cut, expressed as
    //    "no corner past the bond it is cutting".
    //  - the 379 A corner that prompted that bound in the first place was not
    //    real either: it came of comparing a prim's PROJECTED corners, which
    //    are screen pixels, against an Angstrom position.
    const SC_FLUSH_EPS = 1e-4;
    // Thickness DOES reach the ligand, from the same control the ribbon uses,
    // and carries the same unit it does there: the value is the TOTAL thickness
    // in Angstrom, so the half is thickness/2 and Thickness 1 is a stick 1 A
    // thick. Zero is honoured exactly rather than floored - see stickIsFlat.
    // Vertices are (+u+v, +u-v, -u-v, -u+v) at each end - a CYCLE round the
    // square, not a bit pattern. Every face below is then a simple quad; the
    // bow-ties in the previous attempt came from indexing corners in the
    // ribbon's (+n+b, +n-b, -n+b, -n-b) order, where opposite corners are
    // adjacent in the array.
    //   ax 0 = u, 1 = v, 2 = t   sgn = which way the face looks
    const STICK_FACES = [
        { q: [0, 1, 5, 4], ax: 0, sgn: 1 },     // +u
        { q: [1, 2, 6, 5], ax: 1, sgn: -1 },    // -v
        { q: [2, 3, 7, 6], ax: 0, sgn: -1 },    // -u
        { q: [3, 0, 4, 7], ax: 1, sgn: 1 },     // +v
        { q: [0, 3, 2, 1], ax: 2, sgn: -1 },    // cap at the first atom
        { q: [4, 5, 6, 7], ax: 2, sgn: 1 },     // cap at the second
    ];
    // The twelve edges, each with the two faces that meet along it. `end` is 0
    // or 1 for the rings round the two caps and -1 for the four running along
    // the bond - which is how a cap ring is suppressed at an atom where other
    // bonds arrive, without any geometric test.
    // AT ZERO THICKNESS THE BOX IS A SHEET. The +u and -u faces land on each
    // other and the remaining four have no area, so the solid's six faces
    // collapse to one quad that has to be drawn from both sides. Its outline is
    // simply its own four edges - with one face there is no front/back pair to
    // test, and no interior crease to exclude, because there is no interior.
    // `end` keeps the meaning it has for the box: those edges are the cap ring,
    // and are inked only where the atom carries nothing else.
    // AN N-SIDED SECTION, for a bond that is a TUBE rather than a box. The
    // vertex layout is the box's generalised: 0..n-1 is the near section and
    // n..2n-1 the far one, so every consumer that indexes V/W is unchanged.
    // n = 4 returns the hand-written tables above rather than a generated copy,
    // so a ligand stick's geometry is bit-for-bit what it was.
    const RING_CACHE = new Map();
    const ringTables = (n) => {
        if (n === 4) return { faces: STICK_FACES, edges: STICK_EDGES };
        let t = RING_CACHE.get(n);
        if (t) return t;
        const faces = [];
        for (let i = 0; i < n; i++) {
            // ax IS A ROLE, NOT AN INDEX: 2 means "this is an end cap", and the
            // side facets must never claim it. The box uses 0 and 1 for its two
            // pairs of sides, so alternate the same way. Numbering the facets
            // instead made facet 2 of a 10-sided tube read as a cap - it came
            // out flagged as the square lying on the backbone, and its ink was
            // suppressed with it.
            faces.push({ q: [i, (i + 1) % n, n + ((i + 1) % n), n + i],
                ax: i % 2, sgn: 1 });
        }
        // the two caps, wound outward: the near one runs backwards round its
        // ring, the far one forwards, exactly as the box's do
        const capA = []; for (let i = n - 1; i >= 0; i--) capA.push(i);
        const capB = []; for (let i = 0; i < n; i++) capB.push(n + i);
        const iA = faces.length; faces.push({ q: capA, ax: 2, sgn: -1 });
        const iB = faces.length; faces.push({ q: capB, ax: 2, sgn: 1 });
        const edges = [];
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            edges.push({ a: i, b: j, f0: i, f1: iA, end: 0 });
            edges.push({ a: n + i, b: n + j, f0: i, f1: iB, end: 1 });
            // the rails: each is shared by two neighbouring side facets, and
            // the front/back test across that pair is what puts the outline on
            // the two rails that are actually the silhouette - which is the
            // whole reason a tube needs no special ink rule.
            edges.push({ a: i, b: n + i, f0: i, f1: (i - 1 + n) % n, end: -1 });
        }
        t = { faces, edges };
        RING_CACHE.set(n, t);
        return t;
    };
    const STICK_FACES_FLAT = [{ q: [0, 1, 5, 4], ax: 0, sgn: 1, two: true }];
    const STICK_EDGES_FLAT = [
        { a: 0, b: 1, f0: 0, f1: 0, end: 0 },
        { a: 4, b: 5, f0: 0, f1: 0, end: 1 },
        { a: 1, b: 5, f0: 0, f1: 0, end: -1 },
        { a: 0, b: 4, f0: 0, f1: 0, end: -1 },
    ];
    const STICK_EDGES = [
        { a: 0, b: 1, f0: 0, f1: 4, end: 0 },
        { a: 1, b: 2, f0: 1, f1: 4, end: 0 },
        { a: 2, b: 3, f0: 2, f1: 4, end: 0 },
        { a: 3, b: 0, f0: 3, f1: 4, end: 0 },
        { a: 4, b: 5, f0: 0, f1: 5, end: 1 },
        { a: 5, b: 6, f0: 1, f1: 5, end: 1 },
        { a: 6, b: 7, f0: 2, f1: 5, end: 1 },
        { a: 7, b: 4, f0: 3, f1: 5, end: 1 },
        { a: 0, b: 4, f0: 0, f1: 3, end: -1 },
        { a: 1, b: 5, f0: 0, f1: 1, end: -1 },
        { a: 2, b: 6, f0: 1, f1: 2, end: -1 },
        { a: 3, b: 7, f0: 2, f1: 3, end: -1 },
    ];
    // Screen width, in pixels, over which round shading fades in. Under the
    // first there is less than a band's worth of line to shade.
    const SHADE_W_MIN = 2.0;
    const SHADE_W_FULL = 5.0;
    // A helix turns every ~3.6 residues; one quad per residue facets visibly.
    // Subdivision is cheap since a whole interval is one primitive, so sample
    // finely enough that edges read as curves rather than chords.
    const HELIX_SUB = 8;
    // Strands drawn as flat plates (every cartoon convention flattens the
    // pleat because it competes with reading the packing).
    const FLAT_SHEETS = true;
    const SHEET_SUB = 6;
    const SHEET_SMOOTH = 3;   // half-window for averaging strand side vectors
    // ---- NUCLEIC BASE FRAME, PREDICTED FROM THE C4' TRACE -------------------
    //
    // The same trick as the protein backbone below, on the other polymer: bin
    // the local internal coordinates of the C4' trace and look up where the
    // base points. Per bin, the C4'->base-centroid direction and the base-plane
    // normal, in the local frame of C4' i-1..i+2, one plane per nucleic type.
    //
    // It is WEAKER than the protein table, and the reason is physical rather
    // than a matter of fitting. Fitted and scored by tests/na_table.py over 153
    // chains / 16748 nucleotides, held out by chain: the direction lands 16.7
    // deg median but with a 69 deg p90 tail, against 8.8 / 24 for the peptide. Even
    // knowing the bin exactly, the true direction varies 21 deg around the bin
    // mean, and clustering inside the best-populated bins finds a tight ~10 deg
    // majority plus a 3-25% minority pointing 43-165 deg away. That minority is
    // the glycosidic torsion: a base can sit anti or syn on an identical
    // backbone, and the trace cannot tell which. Coverage explains the rest -
    // residues whose bin was well sampled in training score 12.6 deg, the
    // sparse ones 31-40.
    //
    // This is the ONLY source of base geometry - nothing per-nucleotide is
    // parsed, stored or shipped. Coverage is 99.9% of nucleotides (the window is
    // padded at chain ends and breaks, below). Measured against the frames the
    // files themselves carry, before that path was removed: a B-DNA duplex
    // pairs identically (1BNA, 12 pairs and all 12 rungs), a tRNA identically
    // (1EHZ, 21 pairs), and tertiary RNA differs on a handful (2R8S, 42 against
    // 44) in the loose non-helical regions - which is exactly where the trace
    // stops determining the base. Three things downstream exist because of the
    // tail: the widened pairing gate (NA_BASE_SEP_MAX), the partner sign check
    // after pairing, and the per-residue twist cap (NA_TWIST_MAX).
    const NA_NB13 = 8;          // r13 bins, 1.0 A from 4.5
    const NA_NB14 = 10;         // signed r14 bins, 4.0 A from -20
    const NA_STEP_MIN = 4.5;    // A, C4'-C4' along the backbone
    const NA_STEP_MAX = 7.5;
    // C4'->centroid length, measured: purine 5.19 +- 0.12 A, pyrimidine
    // 4.62 +- 0.17. The plates and the pairing test need the centroid POSITION,
    // not just the direction, and this is constant enough to assume.
    const NA_CEN_PURINE = 5.19;
    const NA_CEN_PYRIMIDINE = 4.62;
    const NA_PURINES = { A: 1, G: 1, DA: 1, DG: 1, RA: 1, RG: 1, I: 1, DI: 1 };
    const NA_BASE_TABLE = [
        2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135,
        4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36,
        1.111, -3.846, 0.907, -2.99, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612,
        5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612,
        5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 2.135, 4.36,
        1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111,
        -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846,
        0.907, -2.99, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325,
        4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325,
        4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 2.135, 4.36, 1.111, -3.846,
        0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907,
        -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99,
        3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413,
        3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413,
        3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135,
        4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36,
        1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 3.885, 8.612, 5.591,
        -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591,
        -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591,
        -7.325, 4.662, -6.413, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846,
        0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 2.135, 4.36, 1.111, -3.846, 0.907,
        -2.99, 2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413,
        3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413,
        3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413,
        2.135, 4.36, 1.111, -3.846, 0.907, -2.99, 0.429, 0.875, 0.223, -0.776, 0.183, -0.603, 0.429,
        0.875, 0.223, -0.776, 0.183, -0.603, 0.429, 0.875, 0.223, -0.776, 0.183, -0.603, 0.429,
        0.875, 0.223, -0.776, 0.183, -0.603, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 3.885,
        8.612, 5.591, -7.325, 4.662, -6.413, 3.885, 8.612, 5.591, -7.325, 4.662, -6.413, 0.354,
        0.784, 0.509, -0.679, 0.432, -0.594, 0.354, 0.784, 0.509, -0.679, 0.432, -0.594, 0.327,
        0.945, -0.019, -0.798, -0.036, -0.601, 0.322, 0.944, -0.073, 0.821, 0.051, 0.569, 0.322,
        0.944, -0.073, 0.821, 0.051, 0.569, 0.322, 0.944, -0.073, 0.821, 0.051, 0.569, 0.322, 0.944,
        -0.073, 0.821, 0.051, 0.569, 13.292, 47.661, 38.078, -42.671, 26.539, -44.72, 13.292,
        47.661, 38.078, -42.671, 26.539, -44.72, 13.292, 47.661, 38.078, -42.671, 26.539, -44.72,
        0.213, 0.763, 0.61, -0.634, 0.395, -0.665, 0.232, 0.828, 0.511, -0.625, 0.33, -0.707, 0.271,
        0.938, -0.217, -0.8, -0.165, -0.576, 0.322, 0.944, -0.073, 0.821, 0.051, 0.569, 0.322,
        0.944, -0.073, 0.821, 0.051, 0.569, 0.322, 0.944, -0.073, 0.821, 0.051, 0.569, 0.322, 0.944,
        -0.073, 0.821, 0.051, 0.569, 0.935, 5.757, 3.408, 4.645, -1.333, 4.906, 0.935, 5.757, 3.408,
        4.645, -1.333, 4.906, 0.935, 5.757, 3.408, 4.645, -1.333, 4.906, 0.138, 0.852, 0.504, 0.675,
        -0.194, 0.712, 0.277, 0.926, 0.256, -0.674, 0.153, -0.723, -22.669, -8.988, -37.39, -32.05,
        -4.693, 25.606, -22.669, -8.988, -37.39, -32.05, -4.693, 25.606, -0.508, -0.201, -0.838,
        -0.776, -0.114, 0.62, -0.508, -0.201, -0.838, -0.776, -0.114, 0.62, -0.508, -0.201, -0.838,
        -0.776, -0.114, 0.62, -2.102, -1.531, -3.547, 3.126, -2.775, 0.868, -0.478, -0.348, -0.806,
        0.732, -0.65, 0.203, -0.897, -0.257, -0.361, -0.351, -0.75, 0.561, -0.897, -0.257, -0.361,
        -0.351, -0.75, 0.561, -0.897, -0.257, -0.361, -0.351, -0.75, 0.561, -9.786, -4.155, -12.645,
        -9.907, -7.724, 2.764, -9.786, -4.155, -12.645, -9.907, -7.724, 2.764, -0.592, -0.252,
        -0.765, -0.77, -0.6, 0.215, -0.592, -0.252, -0.765, -0.77, -0.6, 0.215, -0.592, -0.252,
        -0.765, -0.77, -0.6, 0.215, -0.478, -0.348, -0.806, 0.732, -0.65, 0.203, -0.478, -0.348,
        -0.806, 0.732, -0.65, 0.203, -0.764, -0.215, -0.609, -0.716, 0.42, 0.558, -0.387, -0.336,
        -0.859, 0.946, 0.068, -0.317, -0.387, -0.336, -0.859, 0.946, 0.068, -0.317, -0.688, -2.894,
        -5.256, 3.46, 5.001, 3.39, -0.114, -0.479, -0.87, 0.497, 0.718, 0.487, -0.358, -0.376,
        -0.855, -0.74, 0.656, 0.145, -0.358, -0.376, -0.855, -0.74, 0.656, 0.145, -0.358, -0.376,
        -0.855, -0.74, 0.656, 0.145, -11.627, -6.153, -15.797, 4.423, -4.04, -18.817, -11.627,
        -6.153, -15.797, 4.423, -4.04, -18.817, -0.566, -0.299, -0.768, 0.224, -0.205, -0.953,
        -0.857, -0.283, -0.431, 0.294, 0.063, -0.954, -0.857, -0.283, -0.431, 0.294, 0.063, -0.954,
        -3.214, -4.963, -25.427, -28.662, -14.254, 2.556, -0.123, -0.19, -0.974, -0.893, -0.444,
        0.08, -0.254, -0.044, -0.966, -0.541, 0.591, 0.598, -0.254, -0.044, -0.966, -0.541, 0.591,
        0.598, -0.254, -0.044, -0.966, -0.541, 0.591, 0.598, -11.586, -2.017, -5.069, -2.866, 5.573,
        12.398, -0.905, -0.157, -0.396, -0.206, 0.401, 0.892, -0.265, -0.27, -0.926, 0.81, -0.12,
        0.574, -0.646, -0, -0.763, 0.7, -0.231, -0.676, -0.646, -0, -0.763, 0.7, -0.231, -0.676,
        -7.07, 8.879, -103.93, -96.446, -38.485, -17.831, -0.068, 0.085, -0.994, -0.915, -0.365,
        -0.169, 0.087, 0.05, -0.995, 0.022, 0.822, 0.569, -0.988, 0.137, -0.068, -0.876, -0.482,
        0.007, -0.988, 0.137, -0.068, -0.876, -0.482, 0.007, -22.851, -7.737, -1.026, 2.158,
        -16.756, -24.29, -0.946, -0.32, -0.042, 0.073, -0.566, -0.821, -0.028, -0.035, -0.999,
        -0.908, -0.249, -0.338, -0.302, 0.092, -0.949, -0.224, 0.821, 0.526, -0.302, 0.092, -0.949,
        -0.224, 0.821, 0.526, -0.149, -0.077, -0.986, -0.987, 0.097, 0.126, 0.242, 0.149, -0.959,
        0.126, 0.931, 0.343, -0.208, 0.224, -0.952, 0.957, -0.062, -0.285, -0.988, 0.137, -0.068,
        -0.876, -0.482, 0.007, -0.988, 0.137, -0.068, -0.876, -0.482, 0.007, -13.329, -7.335, 1.956,
        -3.134, -10.824, -14.892, -0.869, -0.478, 0.127, -0.168, -0.58, -0.797, -0.485, -0.444,
        -0.753, -0.118, 0.251, 0.961, 0.153, 0.593, -0.791, 0.898, -0.302, 0.321, -0.556, -0.719,
        0.418, 0.34, -0.48, -0.809, 0.379, 0.641, -0.667, 0.796, 0.017, 0.606, 0.303, 0.361, -0.882,
        0.871, 0.181, 0.456, -0.155, 0.367, -0.917, 0.959, -0.219, -0.178, -0.155, 0.367, -0.917,
        0.959, -0.219, -0.178, -0.155, 0.367, -0.917, 0.959, -0.219, -0.178, -4.788, -1.96, -1.032,
        -1.965, 2.941, 3.741, -0.908, -0.372, -0.196, -0.382, 0.571, 0.727, -0.618, -0.467, -0.632,
        -0.059, 0.216, 0.975, 0.383, 0.747, -0.543, -0.703, 0.084, -0.706, 0.422, 0.869, -0.258,
        0.738, -0.292, 0.608, 0.287, 0.654, -0.7, -0.758, -0.164, -0.632, 0.139, 0.409, -0.902,
        0.937, 0.129, 0.324, -0.114, 0.314, -0.943, 0.995, 0.096, -0.038, -0.114, 0.314, -0.943,
        0.995, 0.096, -0.038, -0.114, 0.314, -0.943, 0.995, 0.096, -0.038, -2.395, -3.987, 0.878,
        -0.784, 1.95, 3.843, -0.506, -0.842, 0.185, -0.179, 0.445, 0.877, -0.351, -0.366, -0.862,
        0.909, -0.091, -0.407, 0.264, 0.727, -0.634, 0.77, 0.05, 0.636, 0.324, 0.88, -0.348, -0.676,
        0.121, -0.727
    ];

    /**
     * Base frames predicted from the C4' trace: 6 per residue, the same layout
     * the stored ones use (C4'->centroid vector, then the base-plane normal).
     *
     * @param at    index -> position
     * @param n     number of positions
     * @param want  (i) -> is this a nucleotide to predict for
     * @param isPur (i) -> is this a purine (sets the centroid distance)
     * @param isDna (i) -> DNA rather than RNA (selects the table plane)
     */
    /**
     * CONTINUE THE SCREW one step past c: take the turn from a->b to b->c and
     * apply it once more, keeping the step length. This is how both nucleic
     * passes invent a neighbour they do not have - the base-frame window at a
     * chain end, and the smoothing pass at a run end.
     */
    /**
     * ROTATE w BY THE TURN THAT TAKES v1 ONTO v2 (directions only; w keeps its
     * length). On a helix, consecutive chords are related by exactly this
     * rotation - about the helix axis, by the twist per residue - so it
     * transports anything defined in the local frame one step along: the next
     * chord (screwNext), or the displacement a filter would have applied
     * (the run-end case in smoothNucleicTrace).
     * Identity when either vector vanishes or the two are collinear.
     */
    function turnLike(v1, v2, w) {
        const l1 = Math.hypot(v1[0], v1[1], v1[2]), l2 = Math.hypot(v2[0], v2[1], v2[2]);
        if (l1 < 1e-6 || l2 < 1e-6) return w;
        let kx = v1[1] * v2[2] - v1[2] * v2[1];
        let ky = v1[2] * v2[0] - v1[0] * v2[2];
        let kz = v1[0] * v2[1] - v1[1] * v2[0];
        const kl = Math.hypot(kx, ky, kz);
        if (kl < 1e-9) return w;
        kx /= kl; ky /= kl; kz /= kl;
        const cs = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (l1 * l2)));
        const sn = Math.sin(Math.acos(cs));
        const dt = kx * w[0] + ky * w[1] + kz * w[2];
        return [
            w[0] * cs + (ky * w[2] - kz * w[1]) * sn + kx * dt * (1 - cs),
            w[1] * cs + (kz * w[0] - kx * w[2]) * sn + ky * dt * (1 - cs),
            w[2] * cs + (kx * w[1] - ky * w[0]) * sn + kz * dt * (1 - cs),
        ];
    }

    /**
     * CONTINUE THE SCREW one step past c: take the turn from a->b to b->c and
     * apply it once more, keeping the step length. Adding the difference of
     * the two steps instead (c + 2*v2 - v1) overshoots by up to 40% on a helix,
     * and the padded point then failed the bond-length test in the caller - so
     * the residue it was invented for got no frame at all, which is worse than
     * no padding: a zero frame puts the base centroid on the C4' itself.
     */
    function screwNext(a, b, c) {
        const v1 = [b.x - a.x, b.y - a.y, b.z - a.z];
        const v2 = [c.x - b.x, c.y - b.y, c.z - b.z];
        const r = turnLike(v1, v2, v2);
        return { x: c.x + r[0], y: c.y + r[1], z: c.z + r[2] };
    }

    // ---- NUCLEIC TRACE SMOOTHING ------------------------------------------
    //
    // A C4' trace is not a smooth curve. The atom sits one bond out from the
    // base and the sugar pucker swings it about the glycosidic axis, so
    // consecutive C4' positions alternate in and out - and everything the
    // drawing infers from the LOCAL SCREW of that trace inherits the wobble.
    // Measured on 1BNA and 355D, the angle between consecutive predicted base
    // normals (~12 degrees on real stacked bases):
    //
    //     raw C4'              46.2 deg +/- 55.2      (the spread is the wave)
    //     smoothed, 0.5 x2     11.5 deg +/-  3.4
    //     C1' trace instead    28.4 deg +/- 16.7
    //
    // So the fix is not a different atom - a C1' trace is steadier here but
    // takes 9.3 A steps in folded RNA, and a P trace is the worst of the three
    // (2.0-2.7 A off an ideal helix against C4's 1.4-2.0) - it is to stop
    // reading a jagged path as if it were a curve.
    //
    // ONE ARRAY FOR EVERYTHING NUCLEIC. The smoothed positions feed the ribbon
    // path, the base frames, the rungs and the appended base atoms alike. The
    // sheet-flattening pass below is protein-only precisely because it moves
    // the trace and nothing else - plates read the rotated array directly and
    // would be left behind - so this moves them together instead.
    // TAUBIN, NOT A PLAIN AVERAGE. Averaging a curve shrinks it: two Laplacian
    // passes pull a duplex in by 5-6% and move every point 1.18 A, which showed
    // up as the ribbon losing a tenth of its ink and the sharp turns of a tRNA
    // rounding off. Taubin alternates a positive pass with a slightly larger
    // negative one, which removes the high-frequency wobble and puts the scale
    // back. Measured on 1BNA, base-normal turn per step and what it cost:
    //
    //     raw                46.2 deg +/- 55.2   spread 100%   moved 0.00 A
    //     laplacian 0.5 x2   11.5 deg +/-  3.4   spread  94%   moved 1.18 A
    //     taubin  x2 (this)  12.0 deg +/-  5.5   spread 100%   moved 0.30 A
    //
    // 0.6/-0.62 was tried and is unstable - it blew one rail of 1BNA back out
    // to 41 +/- 61 - so the pair is left at the textbook ratio.
    const NA_SMOOTH_STEPS = [0.5, -0.53, 0.5, -0.53];

    /**
     * @param {Array} rotated - view-rotated positions, one per position
     * @param {number} n
     * @param {Array<string>} types - position types; 'D' and 'R' are smoothed
     * @param {Array<Array<number>>} runs - [lo, hi] backbone runs
     * @param {Map|null} scMap - side-chain map, so appended base atoms follow
     * @returns {Array} the same array when there is nothing to smooth
     */
    function smoothNucleicTrace(rotated, n, types, runs, scMap) {
        if (!types) return rotated;
        let any = false;
        for (let i = 0; i < n; i++) {
            if (types[i] === 'D' || types[i] === 'R') { any = true; break; }
        }
        if (!any) return rotated;
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = rotated[i];
        const nuc = (i) => i >= 0 && i < n && (types[i] === 'D' || types[i] === 'R');
        for (const lam of NA_SMOOTH_STEPS) {
            const src = out.slice();
            for (const [lo, hi] of runs) {
                for (let i = lo + 1; i < hi; i++) {
                    if (!nuc(i) || !nuc(i - 1) || !nuc(i + 1)) continue;
                    const a = src[i - 1]; const c = src[i + 1];
                    const b = src[i];
                    out[i] = {
                        x: b.x + lam * ((a.x + c.x) / 2 - b.x),
                        y: b.y + lam * ((a.y + c.y) / 2 - b.y),
                        z: b.z + lam * ((a.z + c.z) / 2 - b.z),
                    };
                }
                // ...AND THE TWO ENDS TAKE THE MOVE THEY WOULD HAVE HAD.
                //
                // Pinning them is the obvious thing and it is the same mistake
                // the centered tangent stencil makes at a run end (HT1_A, which
                // exists to solve exactly this for helices). It does not show
                // where you expect. Take an IDEAL B-DNA (r 9.0, rise 3.38,
                // twist 36 deg) and cut it: the filter moves every interior
                // point 0.071 A straight at the axis and nothing along it, so
                // the pinned terminal residue is only 0.071 A behind - but its
                // NEIGHBOUR, with one fixed point to average against, moves
                // 0.441 A, six times too far, and lands 0.382 A off the helix.
                // The end does not lag; it DRAGS, and the last turn of the
                // duplex is pulled off its own axis.
                //
                // The move the end should have had is exact and needs no
                // extrapolated position: a helix is homogeneous, so every point
                // gets the same displacement in its own local frame, and one
                // step along that frame is one turn about the helix axis - the
                // rotation that carries the next chord onto this one. Measured
                // on the ideal helix, transporting the neighbour's displacement
                // that way reproduces the true end displacement to 0.0000 A at
                // every residue, so a cut duplex smooths exactly as the uncut
                // one did. Over 153 real chains the path turn at the seam goes
                // 25.5 -> 30.0 deg median against an interior of 32.1: the
                // point is not that the corner gets gentler - pinning already
                // did that, by flattening it - but that the end now bends like
                // the rest of the helix. Terminal base direction against real
                // ring geometry is unchanged (19.6 -> 19.9 deg median).
                //
                // Reading a POSITION out of the raw trace instead - continue
                // the screw past the end and average against that - is also
                // exact on an ideal helix, but on a real one it is built from
                // the three raw terminal points, which is where the pucker
                // wobble is: it extrapolates the wobble, measured 31.8 deg at
                // the seam, and folded the terminal interval visibly.
                const endMove = (i, d) => {
                    const j = i + d, k = i + 2 * d;
                    if (!nuc(i) || !nuc(j) || !nuc(k)) return;
                    const mv = [out[j].x - src[j].x, out[j].y - src[j].y,
                        out[j].z - src[j].z];
                    if (Math.hypot(mv[0], mv[1], mv[2]) < 1e-9) return;
                    // ONE STEP BACK ALONG THE SCREW. This must be the turn
                    // about the HELIX AXIS, not the shortest turn carrying one
                    // chord onto the next: both map chord to chord, but they
                    // send everything else somewhere different, and the thing
                    // being carried here is a radial displacement, not a chord.
                    // Using the shortest turn leaves 0.137 A of the ideal-helix
                    // error behind where the axial one leaves nothing.
                    // Three chords give the axis for free - a rotation about it
                    // cannot change a chord's axial component, so every chord
                    // DIFFERENCE is perpendicular to it.
                    const l = i + 3 * d;
                    const ch = (u2, v2) => [src[v2].x - src[u2].x,
                        src[v2].y - src[u2].y, src[v2].z - src[u2].z];
                    const A = ch(j, i), B = ch(k, j);
                    let r = null;
                    if (nuc(l)) {
                        const C = ch(l, k);
                        const d1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
                        const d2 = [C[0] - B[0], C[1] - B[1], C[2] - B[2]];
                        let ux = d1[1] * d2[2] - d1[2] * d2[1];
                        let uy = d1[2] * d2[0] - d1[0] * d2[2];
                        let uz = d1[0] * d2[1] - d1[1] * d2[0];
                        const ul = Math.hypot(ux, uy, uz);
                        if (ul > 1e-9) {
                            ux /= ul; uy /= ul; uz /= ul;
                            // the turn from B to A, measured in the plane
                            // normal to the axis
                            const perp = (v2) => {
                                const t = v2[0] * ux + v2[1] * uy + v2[2] * uz;
                                return [v2[0] - t * ux, v2[1] - t * uy, v2[2] - t * uz];
                            };
                            const bp = perp(B), ap = perp(A);
                            const cx2 = bp[1] * ap[2] - bp[2] * ap[1];
                            const cy2 = bp[2] * ap[0] - bp[0] * ap[2];
                            const cz2 = bp[0] * ap[1] - bp[1] * ap[0];
                            const th = Math.atan2(cx2 * ux + cy2 * uy + cz2 * uz,
                                bp[0] * ap[0] + bp[1] * ap[1] + bp[2] * ap[2]);
                            const cs = Math.cos(th), sn = Math.sin(th);
                            const dt = ux * mv[0] + uy * mv[1] + uz * mv[2];
                            r = [
                                mv[0] * cs + (uy * mv[2] - uz * mv[1]) * sn + ux * dt * (1 - cs),
                                mv[1] * cs + (uz * mv[0] - ux * mv[2]) * sn + uy * dt * (1 - cs),
                                mv[2] * cs + (ux * mv[1] - uy * mv[0]) * sn + uz * dt * (1 - cs),
                            ];
                        }
                    }
                    // A run of three has no axis to find; the shortest turn is
                    // the best available and is right to first order.
                    if (!r) r = turnLike(B, A, mv);
                    const b = src[i];
                    out[i] = { x: b.x + r[0], y: b.y + r[1], z: b.z + r[2] };
                };
                endMove(lo, 1);
                endMove(hi, -1);
            }
        }
        // ...AND THE ATOMS RIDE ALONG. A base drawn as real atoms is appended
        // positions hanging off its trace atom; leaving them behind would
        // detach the sugar from the ribbon by the distance the trace moved,
        // about 1 A. Each one takes its owner's displacement.
        if (scMap && scMap.size) {
            for (const [idx, e] of scMap) {
                if (!e || idx >= n) continue;
                const o = e.owner;
                if (!nuc(o) || out[o] === rotated[o]) continue;
                const d = out[o]; const r = rotated[o]; const p = rotated[idx];
                if (!p) continue;
                out[idx] = { x: p.x + (d.x - r.x), y: p.y + (d.y - r.y),
                    z: p.z + (d.z - r.z) };
            }
        }
        return out;
    }

    function predictBaseFrames(at, n, want, isPur, isDna, out) {
        const bf = out || new Float64Array(n * 6);
        // The window needs i-1 .. i+2, so the two residues at each end of a
        // chain have none - and on a 12-mer duplex that is a quarter of the
        // structure, with bare ribbon where its terminal base pairs should be.
        // PULCHRA pads its trace for the same reason; this continues the local
        // screw motion, applying the turn between the last two steps once more.
        const ext = screwNext;
        // A CHAIN BREAK is an end too. The window runs i-1 .. i+2, so the last
        // residue of every chain has its forward neighbours in the NEXT chain,
        // 15 A away - and reading them gives nonsense while dropping the residue
        // gives it no base at all. Both ends are padded the same way: walk out
        // from i while the steps are real, then continue the screw for whatever
        // is missing.
        const realStep = (a, b) => {
            if (a < 0 || b < 0 || a >= n || b >= n) return false;
            const p = at(a), q = at(b);
            const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
            const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
            return l >= NA_STEP_MIN && l <= NA_STEP_MAX;
        };
        const win = [null, null, null, null];   // i-1, i, i+1, i+2
        const fillWindow = (i) => {
            win[1] = at(i);
            win[0] = realStep(i - 1, i) ? at(i - 1) : null;
            win[2] = realStep(i, i + 1) ? at(i + 1) : null;
            win[3] = (win[2] && realStep(i + 1, i + 2)) ? at(i + 2) : null;
            // Every gap is filled by continuing the screw through three REAL
            // points. Chaining extrapolations instead - inventing a point and
            // then extrapolating from it - degenerates: two of the three inputs
            // coincide, the screw collapses to a straight line, and the window
            // comes out COPLANAR. Its handedness is then decided by the last
            // bits of the coordinates, which change every time the structure is
            // re-rotated, so the table lookup flipped bins and the base visibly
            // twitched as the view turned.
            if (!win[0]) {
                if (!win[2] || !win[3]) return false;
                win[0] = ext(win[3], win[2], win[1]);
            }
            if (!win[2]) {
                if (!realStep(i - 2, i - 1)) return false;
                win[2] = ext(at(i - 2), win[0], win[1]);
            }
            if (!win[3]) win[3] = ext(win[0], win[1], win[2]);
            return true;
        };
        for (let i = 0; i < n; i++) {
            if (want && !want(i)) continue;
            if (!fillWindow(i)) continue;
            const p0 = win[0], p1 = win[1], p2 = win[2], p3 = win[3];
            let ux = p2.x - p1.x, uy = p2.y - p1.y, uz = p2.z - p1.z;
            const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
            if (ul < NA_STEP_MIN || ul > NA_STEP_MAX) continue;   // chain break
            ux /= ul; uy /= ul; uz /= ul;
            const bx = p0.x - p1.x, by = p0.y - p1.y, bz = p0.z - p1.z;
            let wx = uy * bz - uz * by;
            let wy = uz * bx - ux * bz;
            let wz = ux * by - uy * bx;
            const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
            if (wl < 1e-6) continue;
            wx /= wl; wy /= wl; wz /= wl;
            const vx = wy * uz - wz * uy;
            const vy = wz * ux - wx * uz;
            const vz = wx * uy - wy * ux;
            const dx13 = p2.x - p0.x, dy13 = p2.y - p0.y, dz13 = p2.z - p0.z;
            const r13 = Math.sqrt(dx13 * dx13 + dy13 * dy13 + dz13 * dz13);
            const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
            const ex = p2.x - p1.x, ey = p2.y - p1.y, ez = p2.z - p1.z;
            const cx = p3.x - p2.x, cy = p3.y - p2.y, cz = p3.z - p2.z;
            const nx = ay * ez - az * ey;
            const ny = az * ex - ax * ez;
            const nz = ax * ey - ay * ex;
            const dx14 = p3.x - p0.x, dy14 = p3.y - p0.y, dz14 = p3.z - p0.z;
            const r14 = Math.sqrt(dx14 * dx14 + dy14 * dy14 + dz14 * dz14)
                * chiralSign(nx, ny, nz, cx, cy, cz);
            let b13 = (r13 - 4.5) | 0;
            b13 = b13 < 0 ? 0 : (b13 > NA_NB13 - 1 ? NA_NB13 - 1 : b13);
            let b14 = (r14 + 20) * 0.25 | 0;
            b14 = b14 < 0 ? 0 : (b14 > NA_NB14 - 1 ? NA_NB14 - 1 : b14);
            const t = (((isDna && isDna(i) ? 0 : 1) * NA_NB13 + b13) * NA_NB14 + b14) * 6;
            const mag = (isPur && isPur(i)) ? NA_CEN_PURINE : NA_CEN_PYRIMIDINE;
            const o = i * 6;
            for (let h = 0; h < 6; h += 3) {
                const lx = NA_BASE_TABLE[t + h], ly = NA_BASE_TABLE[t + h + 1], lz = NA_BASE_TABLE[t + h + 2];
                const qx = ux * lx + vx * ly + wx * lz;
                const qy = uy * lx + vy * ly + wy * lz;
                const qz = uz * lx + vz * ly + wz * lz;
                const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
                if (ql < 1e-9) continue;
                const scale = h === 0 ? mag / ql : 1 / ql;
                bf[o + h] = qx * scale; bf[o + h + 1] = qy * scale; bf[o + h + 2] = qz * scale;
            }
        }
        return bf;
    }

    // ---- BACKBONE, PREDICTED FROM THE C-ALPHA TRACE -------------------------
    //
    // py2Dmol holds C-alphas and nothing else, but two things the cartoon needs
    // are properties of the full backbone:
    //
    //   secondary structure  DSSP reads backbone hydrogen bonds. Without them
    //                        the assignment has to be guessed from C-alpha
    //                        geometry (TM-align's make_sec, still here as
    //                        makeSec), which costs mostly strands: Q3 85% with
    //                        strand recall 73%.
    //   which way a strand faces  a strand's carbonyls point at the strand it
    //                        pairs with, so they give both the ladder pairing
    //                        and the plane the ribbon lies in. C-alpha
    //                        curvature does not - see SHEET_FRAME_RELAX.
    //
    // So the backbone is rebuilt, PULCHRA-style (Rotkiewicz & Skolnick 2008):
    // bin the local internal coordinates, look up the peptide geometry. PULCHRA
    // stores a fragment per bin and superimposes it; only C and N are needed
    // here, so this is one table read and one frame per residue - no fragment
    // library, no superposition.
    //
    // The table holds, per bin, the offsets of C(i) and N(i+1) from CA(i) in the
    // local frame of C-alphas i-1..i+2. O is not stored: the carbonyl carbon is
    // sp2, so O sits in the CA-C-N plane opposite the bisector, 1.231 A out.
    //
    // Fitted by `python tests/sheet_bench.py --fit` over half of
    // tests/natives.zip and scored on the other half: C to 0.21 A rms, N to
    // 0.17 A, the C=O direction to 8.8 deg median. Running DSSP on the result
    // reproduces DSSP on the real backbone at Q3 90.0%, strand recall 94.0%
    // (tests/ss_bench.js), against 85.3% / 72.4% for the C-alpha-only make_sec.
    const PEP_NB13 = 8;        // r13 bins, 0.4 A from 4.6
    const PEP_NB14 = 25;       // signed r14 bins, 0.9 A from -11
    const PEP_CO_LENGTH = 1.231;   // A, Engh & Huber
    const CO_BOND_MIN = 3.0;   // A, CA-CA across a peptide bond (cis included)
    const CO_BOND_MAX = 4.2;
    const PEPTIDE_TABLE = [
        1.425, -0.292, -0.093, 2.393, 0.143, 0.047, 1.425, -0.292, -0.093, 2.393, 0.143, 0.047,
        1.425, -0.292, -0.093, 2.393, 0.143, 0.047, 1.425, -0.409, 0.121, 2.395, 0.283, -0.123,
        1.421, -0.499, 0.123, 2.391, 0.307, -0.199, 1.421, -0.499, 0.123, 2.391, 0.307, -0.199,
        1.425, -0.346, -0.387, 2.393, 0.303, 0.211, 1.425, -0.346, -0.387, 2.393, 0.303, 0.211,
        1.425, -0.346, -0.387, 2.393, 0.303, 0.211, 1.425, -0.346, -0.387, 2.393, 0.303, 0.211,
        1.425, -0.346, -0.387, 2.393, 0.303, 0.211, 1.426, -0.431, 0.28, 2.394, 0.273, -0.197,
        1.426, -0.431, 0.28, 2.394, 0.273, -0.197, 1.426, -0.431, 0.28, 2.394, 0.273, -0.197, 1.426,
        -0.431, 0.28, 2.394, 0.273, -0.197, 1.426, -0.431, 0.28, 2.394, 0.273, -0.197, 1.426,
        -0.431, 0.28, 2.394, 0.273, -0.197, 1.426, -0.431, 0.28, 2.394, 0.273, -0.197, 1.426,
        -0.431, 0.28, 2.394, 0.273, -0.197, 1.426, -0.431, 0.28, 2.394, 0.273, -0.197, 1.426,
        -0.431, 0.28, 2.394, 0.273, -0.197, 1.423, -0.432, -0.196, 2.392, 0.281, 0.145, 1.421,
        -0.333, -0.363, 2.388, 0.235, 0.253, 1.421, -0.333, -0.363, 2.388, 0.235, 0.253, 1.421,
        -0.333, -0.363, 2.388, 0.235, 0.253, 1.425, -0.292, -0.093, 2.393, 0.143, 0.047, 1.425,
        -0.292, -0.093, 2.393, 0.143, 0.047, 1.425, -0.292, -0.093, 2.393, 0.143, 0.047, 1.425,
        -0.409, 0.121, 2.395, 0.283, -0.123, 1.421, -0.499, 0.123, 2.391, 0.307, -0.199, 1.421,
        -0.499, 0.123, 2.391, 0.307, -0.199, 1.425, -0.346, -0.387, 2.393, 0.303, 0.211, 1.425,
        -0.346, -0.387, 2.393, 0.303, 0.211, 1.425, -0.346, -0.387, 2.393, 0.303, 0.211, 1.425,
        -0.346, -0.387, 2.393, 0.303, 0.211, 1.425, -0.346, -0.387, 2.393, 0.303, 0.211, 1.425,
        -0.346, -0.387, 2.393, 0.303, 0.211, 1.429, -0.354, 0.388, 2.396, 0.226, -0.303, 1.429,
        -0.354, 0.388, 2.396, 0.226, -0.303, 1.429, -0.354, 0.388, 2.396, 0.226, -0.303, 1.429,
        -0.354, 0.388, 2.396, 0.226, -0.303, 1.429, -0.354, 0.388, 2.396, 0.226, -0.303, 1.429,
        -0.354, 0.388, 2.396, 0.226, -0.303, 1.428, -0.397, 0.333, 2.396, 0.293, -0.235, 1.424,
        -0.454, 0.217, 2.393, 0.262, -0.204, 1.424, -0.486, 0.048, 2.394, 0.342, -0.029, 1.423,
        -0.432, -0.196, 2.392, 0.281, 0.145, 1.421, -0.333, -0.363, 2.388, 0.235, 0.253, 1.421,
        -0.333, -0.363, 2.388, 0.235, 0.253, 1.421, -0.333, -0.363, 2.388, 0.235, 0.253, 1.421,
        -0.335, -0.184, 2.39, 0.186, 0.039, 1.421, -0.335, -0.184, 2.39, 0.186, 0.039, 1.423,
        -0.299, -0.207, 2.392, 0.137, 0.138, 1.427, -0.471, 0.17, 2.397, 0.336, -0.154, 1.424,
        -0.447, 0.115, 2.392, 0.311, -0.11, 1.422, -0.272, -0.166, 2.396, 0.274, 0.12, 1.421,
        -0.253, -0.253, 2.393, 0.277, 0.144, 1.421, -0.253, -0.253, 2.393, 0.277, 0.144, 1.421,
        -0.253, -0.253, 2.393, 0.277, 0.144, 1.421, -0.253, -0.253, 2.393, 0.277, 0.144, 1.421,
        -0.253, -0.253, 2.393, 0.277, 0.144, 1.421, -0.253, -0.253, 2.393, 0.277, 0.144, 1.43,
        -0.309, 0.422, 2.398, 0.215, -0.32, 1.43, -0.309, 0.422, 2.398, 0.215, -0.32, 1.43, -0.309,
        0.422, 2.398, 0.215, -0.32, 1.43, -0.309, 0.422, 2.398, 0.215, -0.32, 1.43, -0.309, 0.422,
        2.398, 0.215, -0.32, 1.43, -0.309, 0.422, 2.398, 0.215, -0.32, 1.429, -0.33, 0.396, 2.397,
        0.273, -0.264, 1.424, -0.435, 0.234, 2.395, 0.324, -0.116, 1.426, -0.463, 0.149, 2.396,
        0.344, -0.088, 1.427, -0.461, -0.063, 2.397, 0.337, 0.043, 1.427, -0.426, -0.226, 2.396,
        0.32, 0.146, 1.427, -0.426, -0.226, 2.396, 0.32, 0.146, 1.427, -0.426, -0.226, 2.396, 0.32,
        0.146, 1.424, -0.033, -0.473, 2.391, -0.054, 0.333, 1.424, -0.033, -0.473, 2.391, -0.054,
        0.333, 1.426, -0.037, -0.399, 2.395, -0.062, 0.279, 1.424, -0.243, -0.047, 2.391, 0.134,
        -0.019, 1.421, -0.348, -0.335, 2.392, 0.177, 0.132, 1.421, -0.348, -0.335, 2.392, 0.177,
        0.132, 1.424, 0.082, 0.063, 2.391, -0.053, -0.044, 1.424, 0.082, 0.063, 2.391, -0.053,
        -0.044, 1.424, 0.082, 0.063, 2.391, -0.053, -0.044, 1.424, 0.082, 0.063, 2.391, -0.053,
        -0.044, 1.424, 0.082, 0.063, 2.391, -0.053, -0.044, 1.424, 0.082, 0.063, 2.391, -0.053,
        -0.044, 1.424, 0.082, 0.063, 2.391, -0.053, -0.044, 1.426, -0.15, 0.275, 2.395, 0.194,
        -0.14, 1.426, -0.15, 0.275, 2.395, 0.194, -0.14, 1.426, -0.15, 0.275, 2.395, 0.194, -0.14,
        1.426, -0.15, 0.275, 2.395, 0.194, -0.14, 1.426, -0.15, 0.275, 2.395, 0.194, -0.14, 1.426,
        -0.15, 0.275, 2.395, 0.194, -0.14, 1.419, -0.356, 0.373, 2.391, 0.328, -0.158, 1.426,
        -0.413, 0.262, 2.396, 0.347, -0.12, 1.427, -0.429, 0.11, 2.398, 0.343, -0.028, 1.425,
        -0.229, -0.405, 2.395, 0.095, 0.3, 1.426, -0.015, -0.514, 2.393, -0.094, 0.353, 1.426,
        -0.015, -0.514, 2.393, -0.094, 0.353, 1.425, 0.196, -0.475, 2.392, -0.167, 0.328, 1.425,
        0.129, -0.495, 2.392, -0.083, 0.355, 1.426, 0.211, -0.453, 2.394, -0.153, 0.331, 1.425,
        0.342, -0.321, 2.391, -0.247, 0.225, 1.421, 0.215, -0.169, 2.389, -0.25, 0.049, 1.423,
        0.134, -0.166, 2.392, -0.042, 0.12, 1.422, 0.188, -0.226, 2.395, -0.057, 0.153, 1.422,
        0.188, -0.226, 2.395, -0.057, 0.153, 1.422, 0.188, -0.226, 2.395, -0.057, 0.153, 1.422,
        0.188, -0.226, 2.395, -0.057, 0.153, 1.422, 0.188, -0.226, 2.395, -0.057, 0.153, 1.422,
        0.188, -0.226, 2.395, -0.057, 0.153, 1.422, 0.188, -0.226, 2.395, -0.057, 0.153, 1.422,
        0.235, -0.387, 2.391, -0.091, 0.304, 1.422, 0.235, -0.387, 2.391, -0.091, 0.304, 1.422,
        0.235, -0.387, 2.391, -0.091, 0.304, 1.422, 0.235, -0.387, 2.391, -0.091, 0.304, 1.422,
        0.235, -0.387, 2.391, -0.091, 0.304, 1.422, 0.235, -0.387, 2.391, -0.091, 0.304, 1.426,
        0.016, 0.106, 2.398, 0.131, 0.006, 1.416, -0.238, 0.377, 2.387, 0.271, -0.101, 1.42, -0.206,
        0.165, 2.391, 0.243, -0.05, 1.425, 0.069, -0.46, 2.393, -0.048, 0.342, 1.424, 0.101, -0.497,
        2.391, -0.084, 0.351, 1.424, 0.101, -0.497, 2.391, -0.084, 0.351, 1.422, 0.254, -0.458,
        2.39, -0.136, 0.335, 1.422, 0.257, -0.442, 2.39, -0.089, 0.35, 1.424, 0.328, -0.367, 2.392,
        -0.207, 0.275, 1.426, 0.439, -0.244, 2.394, -0.304, 0.16, 1.419, 0.322, -0.059, 2.382,
        -0.151, -0.009, 1.426, 0.102, -0.453, 2.398, -0.082, 0.324, 1.426, 0.102, -0.453, 2.398,
        -0.082, 0.324, 1.426, 0.102, -0.453, 2.398, -0.082, 0.324, 1.426, 0.102, -0.453, 2.398,
        -0.082, 0.324, 1.426, 0.102, -0.453, 2.398, -0.082, 0.324, 1.426, 0.102, -0.453, 2.398,
        -0.082, 0.324, 1.426, 0.102, -0.453, 2.398, -0.082, 0.324, 1.426, 0.102, -0.453, 2.398,
        -0.082, 0.324, 1.423, 0.317, -0.337, 2.395, -0.17, 0.255, 1.423, 0.317, -0.337, 2.395,
        -0.17, 0.255, 1.423, 0.317, -0.337, 2.395, -0.17, 0.255, 1.423, 0.317, -0.337, 2.395, -0.17,
        0.255, 1.423, 0.317, -0.337, 2.395, -0.17, 0.255, 1.423, 0.317, -0.337, 2.395, -0.17, 0.255,
        1.423, 0.317, -0.337, 2.395, -0.17, 0.255, 1.423, 0.317, -0.337, 2.395, -0.17, 0.255, 1.418,
        0.227, -0.436, 2.385, -0.086, 0.331, 1.418, 0.227, -0.436, 2.385, -0.086, 0.331, 1.424,
        0.206, -0.485, 2.391, -0.098, 0.354, 1.43, 0.263, -0.444, 2.398, -0.202, 0.317, 1.419,
        0.419, -0.306, 2.387, -0.208, 0.266, 1.418, 0.429, -0.279, 2.386, -0.201, 0.267, 1.424,
        0.44, -0.227, 2.391, -0.273, 0.205, 1.423, 0.478, -0.132, 2.394, -0.32, 0.02, 1.419, 0.394,
        0.086, 2.389, -0.174, -0.125, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.419, 0.394,
        0.086, 2.389, -0.174, -0.125, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.419, 0.394,
        0.086, 2.389, -0.174, -0.125, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.419, 0.394,
        0.086, 2.389, -0.174, -0.125, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.419, 0.394,
        0.086, 2.389, -0.174, -0.125, 1.422, 0.436, -0.303, 2.393, -0.24, 0.268, 1.422, 0.436,
        -0.303, 2.393, -0.24, 0.268, 1.422, 0.436, -0.303, 2.393, -0.24, 0.268, 1.422, 0.436,
        -0.303, 2.393, -0.24, 0.268, 1.422, 0.436, -0.303, 2.393, -0.24, 0.268, 1.422, 0.436,
        -0.303, 2.393, -0.24, 0.268, 1.422, 0.436, -0.303, 2.393, -0.24, 0.268, 1.422, 0.436,
        -0.303, 2.393, -0.24, 0.268, 1.421, 0.451, -0.113, 2.388, -0.305, 0.085, 1.423, 0.38, -0.29,
        2.385, -0.226, 0.227, 1.418, 0.366, -0.362, 2.386, -0.11, 0.299, 1.42, 0.38, -0.364, 2.386,
        -0.191, 0.313, 1.419, 0.419, -0.306, 2.387, -0.208, 0.266, 1.418, 0.429, -0.279, 2.386,
        -0.201, 0.267, 1.424, 0.44, -0.227, 2.391, -0.273, 0.205, 1.423, 0.478, -0.132, 2.394,
        -0.32, 0.02, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.419, 0.394, 0.086, 2.389, -0.174,
        -0.125, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.419, 0.394, 0.086, 2.389, -0.174,
        -0.125, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.419, 0.394, 0.086, 2.389, -0.174,
        -0.125, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.419, 0.394, 0.086, 2.389, -0.174,
        -0.125, 1.419, 0.394, 0.086, 2.389, -0.174, -0.125, 1.422, 0.436, -0.303, 2.393, -0.24,
        0.268, 1.422, 0.436, -0.303, 2.393, -0.24, 0.268, 1.422, 0.436, -0.303, 2.393, -0.24, 0.268,
        1.422, 0.436, -0.303, 2.393, -0.24, 0.268, 1.422, 0.436, -0.303, 2.393, -0.24, 0.268, 1.422,
        0.436, -0.303, 2.393, -0.24, 0.268, 1.422, 0.436, -0.303, 2.393, -0.24, 0.268, 1.422, 0.436,
        -0.303, 2.393, -0.24, 0.268, 1.421, 0.451, -0.113, 2.388, -0.305, 0.085, 1.423, 0.38, -0.29,
        2.385, -0.226, 0.227, 1.418, 0.366, -0.362, 2.386, -0.11, 0.299, 1.42, 0.38, -0.364, 2.386,
        -0.191, 0.313
    ];

    /**
     * Unit C=O direction per residue, predicted from the C-alpha trace.
     *
     * For residue i the peptide runs to i+1, so the frame is built on that
     * bond: u along CA(i)->CA(i+1), w normal to the CA(i-1),CA(i),CA(i+1)
     * plane, v = w x u. The table is read with the two internal coordinates
     * PULCHRA keys on - r13 = |CA(i+1) - CA(i-1)|, and r14 = |CA(i+2) -
     * CA(i-1)| signed by the chirality of the four - and the stored vector is
     * mapped back out of the frame.
     *
     * Writes into a flat Float64Array (3 per residue) and only for the residues
     * `want` accepts. Two callers, and the filter is the difference: the
     * secondary-structure pass asks for EVERY protein residue, because the
     * phi/psi gate and the hydrogen-bond search both read these atoms, while
     * the sheet-frame pass asks only for strands. Both matter at ribosome scale: over 10000 residues, returning one
     * small array per residue and computing every one of them costs 9.6 ms per
     * call; a typed array brings that to 5.2 ms, and skipping everything that
     * is not a strand to 1.4 ms. This runs once per render.
     *
     * Left as zeros for the first and last residues (the frame needs i-1 and
     * i+2) and across a chain break, where CA-CA is not a peptide bond.
     *
     * @param at    index -> position (Vec3-like: .x .y .z)
     * @param n     number of positions
     * @param want  optional (i) -> boolean filter
     * @param out   optional Float64Array(n * 3) to fill
     */
    /**
     * Local right-handed frame at residue i, built on the peptide bond to i+1:
     * u along CA(i)->CA(i+1), w normal to the CA(i-1),CA(i),CA(i+1) plane,
     * v = w x u. Written into `out` as u,v,w (9 numbers). False if the residue
     * has no usable frame - the chain ends, a break, or three collinear
     * C-alphas.
     *
     * This is the frame the carbonyl table is written in, and the one the
     * cached sheet coefficients are expressed in, so the two cannot drift.
     */
    // HOW FAR APART TWO TRACE POINTS MAY BE. The default pair is the peptide's:
    // CA to CA is 3.8 A and anything outside 3.0-4.2 is a chain break. A
    // NUCLEIC trace is C4' to C4', which is 5.5-6.5 A in both A and B form, so
    // the same test called every nucleotide a break - and a position with no
    // frame has no side chain, which is why bases could not be drawn as atoms
    // at all. Passed in rather than widened: a range that admits both would
    // stop catching a break in either.
    const NUCLEIC_STEP_MIN = 4.5;
    const NUCLEIC_STEP_MAX = 7.5;

    function localFrame(at, n, i, out, wrap, stepMin, stepMax) {
        // `wrap` makes the frame available at the ends of a CYCLIC run, where
        // i-1 or i+1 falls outside [0, n) but the chain genuinely continues.
        // Without it the last residues of a ring have no frame, which is not a
        // missing nicety: anything expressed in this frame - the cached sheet
        // coefficients above all - silently falls back to another source there,
        // and mixing two side-vector sources mid-strand is a visible twist.
        if (!wrap && (i < 1 || i > n - 3)) return false;
        const iP = wrap ? wrap(i - 1) : i - 1;
        const iN = wrap ? wrap(i + 1) : i + 1;
        const p0 = at(iP), p1 = at(i), p2 = at(iN);
        let ux = p2.x - p1.x, uy = p2.y - p1.y, uz = p2.z - p1.z;
        const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
        const loStep = stepMin || CO_BOND_MIN;
        const hiStep = stepMax || CO_BOND_MAX;
        if (ul < loStep || ul > hiStep) return false;             // chain break
        ux /= ul; uy /= ul; uz /= ul;
        const bx = p0.x - p1.x, by = p0.y - p1.y, bz = p0.z - p1.z;
        let wx = uy * bz - uz * by;
        let wy = uz * bx - ux * bz;
        let wz = ux * by - uy * bx;
        const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (wl < 1e-6) return false;                              // collinear
        wx /= wl; wy /= wl; wz /= wl;
        out[0] = ux; out[1] = uy; out[2] = uz;
        out[3] = wy * uz - wz * uy; out[4] = wz * ux - wx * uz; out[5] = wx * uy - wy * ux;
        out[6] = wx; out[7] = wy; out[8] = wz;
        return true;
    }

    const _frameTmp = [0, 0, 0, 0, 0, 0, 0, 0, 0];

    /**
     * Handedness of a four-point window, as the sign of the triple product -
     * with a DEADZONE, because the table lookups bin on it.
     *
     * Where the four points are nearly coplanar the triple product sits at
     * zero and its sign is decided by the last bits, which differ every time
     * the coordinates are re-rotated: the bin then flipped between renders and
     * the frame visibly twitched as the structure turned. Near-planar windows
     * are common at chain ends (where the trace is padded by continuing the
     * screw, which is planar when the chain runs straight) and in extended
     * strands. Resolving them one fixed way costs a bin at worst; letting
     * floating-point noise choose costs a stable picture.
     */
    function chiralSign(nx, ny, nz, cx, cy, cz) {
        const trip = nx * cx + ny * cy + nz * cz;
        const scale = Math.sqrt((nx * nx + ny * ny + nz * nz) * (cx * cx + cy * cy + cz * cz));
        return trip < -1e-6 * scale ? -1 : 1;
    }

    /**
     * Normal of the least-squares plane through a set of points: the
     * eigenvector of their covariance for the smallest eigenvalue.
     *
     * Symmetric 3x3, so the eigenvalues are closed form (Smith 1961) and the
     * vector follows from a cross product of two rows of (C - lambda I). Falls
     * back through all three row pairs because any one pair can be degenerate.
     * Returns null if the points are collinear or too few.
     */
    function planeNormal(pts, count) {
        if (count < 3) return null;
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < count; k++) {
            const p = pts[k];
            cx += p[0]; cy += p[1]; cz += p[2];
        }
        cx /= count; cy /= count; cz /= count;
        let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
        for (let k = 0; k < count; k++) {
            const p = pts[k];
            const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
            xx += dx * dx; xy += dx * dy; xz += dx * dz;
            yy += dy * dy; yz += dy * dz; zz += dz * dz;
        }
        xx /= count; xy /= count; xz /= count; yy /= count; yz /= count; zz /= count;
        // smallest eigenvalue of the symmetric covariance
        const q = (xx + yy + zz) / 3;
        const axx = xx - q, ayy = yy - q, azz = zz - q;
        const p2 = axx * axx + ayy * ayy + azz * azz + 2 * (xy * xy + xz * xz + yz * yz);
        const pp = Math.sqrt(p2 / 6);
        let lambda;
        if (pp < 1e-12) {
            lambda = q;                       // isotropic: no plane to speak of
        } else {
            const bxx = axx / pp, byy = ayy / pp, bzz = azz / pp;
            const bxy = xy / pp, bxz = xz / pp, byz = yz / pp;
            let det = bxx * (byy * bzz - byz * byz)
                - bxy * (bxy * bzz - byz * bxz)
                + bxz * (bxy * byz - byy * bxz);
            det /= 2;
            const phi = Math.acos(Math.min(1, Math.max(-1, det))) / 3;
            // eig1 >= eig2 >= eig3; we want the smallest
            lambda = q + 2 * pp * Math.cos(phi + (2 * Math.PI / 3));
        }
        const m = [xx - lambda, xy, xz, xy, yy - lambda, yz, xz, yz, zz - lambda];
        const rows = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
        let best = null, bestLen = 0;
        for (let a = 0; a < 3; a++) {
            const b = (a + 1) % 3;
            const r1 = rows[a], r2 = rows[b];
            const vx = r1[1] * r2[2] - r1[2] * r2[1];
            const vy = r1[2] * r2[0] - r1[0] * r2[2];
            const vz = r1[0] * r2[1] - r1[1] * r2[0];
            const l = Math.hypot(vx, vy, vz);
            if (l > bestLen) { bestLen = l; best = [vx / l, vy / l, vz / l]; }
        }
        return bestLen > 1e-9 ? best : null;
    }

    /**
     * Rebuild C, O and N from the C-alpha trace.
     *
     * The peptide at residue i (running to i+1) supplies C(i), O(i) and N(i+1),
     * so a residue's N comes from the unit before it. Everything is written
     * into one flat Float64Array, 9 per residue: C, O, N.
     *
     * `want` limits the work to the residues that matter to the caller (the
     * strands, when only the faces are wanted). It gates the PEPTIDE UNIT, so
     * asking for residue i also fills N(i+1).
     *
     * Rows stay zero where the frame is undefined: the first and last residues,
     * and across a chain break, where CA-CA is not a peptide bond.
     */
    // D-AMINO ACIDS, by PDB code. The backbone predictor and the phi/psi gate
    // below are both built from L-protein statistics, so a D residue has to be
    // mirrored into that frame before either can be applied to it. GLY is
    // achiral and has no D form.
    const D_AMINO_ACIDS = new Set([
        'DAL', 'DAR', 'DSG', 'DAS', 'DCY', 'DGN', 'DGL', 'DHI', 'DIL', 'DLE',
        'DLY', 'MED', 'DPN', 'DPR', 'DSN', 'DTH', 'DTR', 'DTY', 'DVA',
    ]);
    // names -> (i) => is this residue a D-amino acid. Null when no names were
    // supplied, which is every all-L path and the benchmarks.
    const mirroredOf = (names) => (names
        ? (i) => D_AMINO_ACIDS.has(names[i])
        : null);

    function predictBackbone(at, n, want, out, mirrored) {
        const bb = out || new Float64Array(n * 9);
        const fr = _frameTmp;
        for (let i = 1; i < n - 2; i++) {
            if (want && !want(i)) continue;
            if (!localFrame(at, n, i, fr)) continue;
            const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
            const ux = fr[0], uy = fr[1], uz = fr[2];
            const vx = fr[3], vy = fr[4], vz = fr[5];
            const wx = fr[6], wy = fr[7], wz = fr[8];
            const dx13 = p2.x - p0.x, dy13 = p2.y - p0.y, dz13 = p2.z - p0.z;
            const r13 = Math.sqrt(dx13 * dx13 + dy13 * dy13 + dz13 * dz13);
            // chirality of the four C-alphas, the sign PULCHRA gives r14
            const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
            const ex = p2.x - p1.x, ey = p2.y - p1.y, ez = p2.z - p1.z;
            const cx = p3.x - p2.x, cy = p3.y - p2.y, cz = p3.z - p2.z;
            const nx = ay * ez - az * ey;
            const ny = az * ex - ax * ez;
            const nz = ax * ey - ay * ex;
            const dx14 = p3.x - p0.x, dy14 = p3.y - p0.y, dz14 = p3.z - p0.z;
            // MIRROR FOR D RESIDUES. PULCHRA's table is L-protein statistics,
            // and a mirrored conformation does NOT map to the mirrored table
            // entry - the negative-r14 bins hold what an L residue does when it
            // happens to be locally left-handed, which is a different
            // conformation, not the reflection of this one. So reflect into the
            // table's frame instead: r14 carries the chirality, and the local
            // frame's w = u x b is a cross product, so under reflection u and v
            // map across unchanged while w flips. Negating both the r14 sign and
            // the w coefficient below is therefore exactly equivalent to
            // reflecting the four C-alphas, reading the table, and reflecting
            // the answer back - without touching any coordinates. O is placed
            // off C, N and CA afterwards, so it follows for free.
            const m = (mirrored && mirrored(i)) ? -1 : 1;
            const r14 = Math.sqrt(dx14 * dx14 + dy14 * dy14 + dz14 * dz14)
                * chiralSign(nx, ny, nz, cx, cy, cz) * m;
            let b13 = (r13 - 4.6) * (1 / 0.4) | 0;
            b13 = b13 < 0 ? 0 : (b13 > PEP_NB13 - 1 ? PEP_NB13 - 1 : b13);
            let b14 = (r14 + 11) * (1 / 0.9) | 0;
            b14 = b14 < 0 ? 0 : (b14 > PEP_NB14 - 1 ? PEP_NB14 - 1 : b14);
            const t = (b13 * PEP_NB14 + b14) * 6;
            // C(i) and N(i+1), out of the local frame and back into space
            const cw = m * PEPTIDE_TABLE[t + 2];
            const nw = m * PEPTIDE_TABLE[t + 5];
            const ccx = p1.x + ux * PEPTIDE_TABLE[t] + vx * PEPTIDE_TABLE[t + 1] + wx * cw;
            const ccy = p1.y + uy * PEPTIDE_TABLE[t] + vy * PEPTIDE_TABLE[t + 1] + wy * cw;
            const ccz = p1.z + uz * PEPTIDE_TABLE[t] + vz * PEPTIDE_TABLE[t + 1] + wz * cw;
            const nnx = p1.x + ux * PEPTIDE_TABLE[t + 3] + vx * PEPTIDE_TABLE[t + 4] + wx * nw;
            const nny = p1.y + uy * PEPTIDE_TABLE[t + 3] + vy * PEPTIDE_TABLE[t + 4] + wy * nw;
            const nnz = p1.z + uz * PEPTIDE_TABLE[t + 3] + vz * PEPTIDE_TABLE[t + 4] + wz * nw;
            // O opposite the CA-C / N-C bisector, in their plane (sp2 carbon)
            let a1x = p1.x - ccx, a1y = p1.y - ccy, a1z = p1.z - ccz;
            let a2x = nnx - ccx, a2y = nny - ccy, a2z = nnz - ccz;
            const l1 = Math.hypot(a1x, a1y, a1z), l2 = Math.hypot(a2x, a2y, a2z);
            if (l1 < 1e-6 || l2 < 1e-6) continue;
            let bx = a1x / l1 + a2x / l2, by = a1y / l1 + a2y / l2, bz = a1z / l1 + a2z / l2;
            const bl = Math.hypot(bx, by, bz);
            if (bl < 1e-6) continue;
            bx /= bl; by /= bl; bz /= bl;
            const o = i * 9;
            bb[o] = ccx; bb[o + 1] = ccy; bb[o + 2] = ccz;
            bb[o + 3] = ccx - bx * PEP_CO_LENGTH;
            bb[o + 4] = ccy - by * PEP_CO_LENGTH;
            bb[o + 5] = ccz - bz * PEP_CO_LENGTH;
            const q = (i + 1) * 9;
            bb[q + 6] = nnx; bb[q + 7] = nny; bb[q + 8] = nnz;
        }
        return bb;
    }

    // ---- SECONDARY STRUCTURE FROM THE REBUILT BACKBONE ----------------------
    //
    // Real DSSP rules (Kabsch & Sander) on the predicted backbone, following
    // pydssp's formulation:
    //
    //   H-bond   E = 0.084 * 332 * (1/r_ON + 1/r_CH - 1/r_OH - 1/r_CN) kcal/mol,
    //            bonded below -0.5, with |i - j| > 2. The amide H sits 1.01 A
    //            from N along the bisector of N->C(prev) and N->CA.
    //   helix    two consecutive n-turns, n = 4 first (alpha), then 3 and 5
    //            wherever the alpha helix has not already claimed the residue.
    //   strand   a residue in any bridge, parallel or antiparallel.
    //
    // The bridge pairs fall out of the same pass and ARE the sheet ladders, so
    // the strand frames downstream are built on real hydrogen bonding rather
    // than on a distance-and-angle guess.
    //
    // Scored against pydssp on the true backbones of tests/natives.zip: Q3 90.0%
    // with 94.0% strand recall, against 85.3% / 72.4% for the C-alpha-only
    // makeSec it replaces. See tests/ss_bench.js, which also prints what each
    // choice here costs.
    // DSSP's own cutoff is -0.5 kcal/mol. This backbone is PREDICTED, so the
    // energies carry the table's error (C to 0.21 A rms), which scatters
    // marginal bonds either side of the line - and a lost bond can cost a whole
    // strand: 1TIM chain B dropped the eighth barrel strand that chain A kept.
    // Measured over the natives, -0.4 recovers strand recall at no cost in Q3;
    // looser than that trades precision for recall and Q3 starts falling.
    // tests/ss_bench.js prints the comparison against DSSP's own -0.5.
    const HB_ENERGY_CUTOFF = -0.4;
    const HB_COUPLING = 0.084 * 332;
    const HB_NH_LENGTH = 1.01;
    const HB_SEARCH = 9.0;      // A between C-alphas; an H-bond cannot be longer
    // Rungs to walk past the end of a detected ladder. DSSP's strand boundaries
    // are conservative and this backbone is predicted, so ladders end early and
    // a strand can be drawn as a loop - which is a far more visible error in a
    // cartoon than a strand one residue too long. Measured over the natives:
    // one step of extension takes strand recall 86.9 -> 94.0% for 1.3 points of
    // Q3 (91.3 -> 90.0), and it only steps onto residues whose dihedrals allow a
    // strand (see LADDER_EXTEND_GATE) - gated on C-alpha distance alone instead,
    // it swallows the flanking loops and strand precision falls to 69%.
    const LADDER_EXTEND_DEFAULT = 1;   // rungs to walk past the end of a ladder
    // 'allow' is PyMOL's own gate semantics - the dihedrals must not EXCLUDE
    // the class - and is what the helix and bridge tests above use too.
    // Measured: 'allow' gives strand recall 94.0% at Q3 90.0, 'support'
    // (dihedrals must actively back the class) 87.6% at Q3 90.9, no extension
    // at all 86.9% at Q3 91.3. The looser gate is the right trade for a
    // cartoon: 1TIM chain B's eighth barrel strand only survives under it.
    const LADDER_EXTEND_GATE = 'allow';
    const LADDER_CA_MIN = 4.0;  // A, C-alpha separation across a plausible rung
    const LADDER_CA_MAX = 6.2;
    // PHI/PSI BANDS, PyMOL's ss_helix_* / ss_strand_* defaults. PyMOL's `dss`
    // uses the dihedrals as a GATE on hydrogen-bond evidence rather than as
    // evidence themselves - a residue is excluded from a class when its
    // dihedrals are far from that class's target, and counts as supporting the
    // class when they are close - which is exactly the test wanted at the end of
    // a ladder, where the bonds run out before the conformation does. We can ask
    // it because the rebuilt backbone has N, CA and C.
    const SS_PHI_PSI = {
        H: { psi: -48, psiIn: 55, psiOut: 85, phi: -57, phiIn: 55, phiOut: 85 },
        E: { psi: 124, psiIn: 40, psiOut: 90, phi: -129, phiIn: 40, phiOut: 100 },
    };

    /**
     * -> { sec, ladders } from C-alphas alone.
     *
     * `sec` is one of 'H' | 'E' | 'C' per position ('C' for anything that is not
     * protein), `ladders` the bridge pairs as [i, j].
     */
    /**
     * [lo, hi] runs that close head to tail, from the same segment list the
     * geometry uses - so the SS pass and the ribbon cannot disagree about which
     * runs are rings.
     */
    function ringsOf(segments, n) {
        const bb = new Int8Array(n);
        const cand = [];
        for (const seg of (segments || [])) {
            const poly = (seg.type === 'P' || seg.type === 'D' || seg.type === 'R')
                && seg.contactIdx1 === undefined;
            if (!poly) continue;
            if (seg.idx2 === seg.idx1 + 1) bb[seg.idx1] = 1;
            else if (seg.idx2 > seg.idx1 + 1) cand.push(seg);
        }
        if (!cand.length) return [];
        const runs = [];
        let st = -1;
        for (let i = 0; i < n; i++) {
            if (bb[i]) { if (st < 0) st = i; } else if (st >= 0) { runs.push([st, i]); st = -1; }
        }
        const rings = [];
        for (const seg of cand) {
            for (const r of runs) {
                if (seg.idx1 === r[0] && seg.idx2 === r[1]) { rings.push(r); break; }
            }
        }
        return rings;
    }

    /**
     * Secondary structure, RING AWARE.
     *
     * assignSecondaryOpen walks the chain by index at every level - the
     * backbone frame needs i-1..i+2, DSSP's turn patterns step i to i+n, and
     * bridge partners compare index separation - so a head-to-tail closure is
     * invisible to it and any element spanning the seam is cut in two.
     *
     * Rather than wrap every one of those index expressions, and risk the far
     * more common linear path while doing it, a ring is assigned TWICE under
     * different rotations of its residue order and the two merged. Rotating a
     * ring gives a different but equally valid linear chain - no coordinate
     * moves, only where the artificial break falls - so every residue is
     * assigned once near a break and once far from one, and the far one wins.
     * DSSP is local, so a residue well inside its rotation gets the assignment
     * it would have had on a true ring. This is the same construction the
     * benchmark uses to build its reference (tests/cyclic_bench.py).
     *
     * opts.rings: array of [lo, hi] inclusive ranges that close head to tail.
     */
    function assignSecondary(coords, n, positionTypes, opts) {
        const rings = (opts && opts.rings) || null;
        if (!rings || !rings.length) {
            return assignSecondaryOpen(coords, n, positionTypes, opts);
        }
        const names = (opts && opts.names) || null;
        const base = assignSecondaryOpen(coords, n, positionTypes, opts);
        const sec = Array.isArray(base.sec) ? base.sec.slice() : [...base.sec];
        const ladders = (base.ladders || []).map((p) => [p[0], p[1]]);
        const seenLad = new Set(ladders.map((p) => (p[0] < p[1]
            ? p[0] * n + p[1] : p[1] * n + p[0])));

        // ONLY THE SEAM IS WRONG, so only the seam is recomputed. The first
        // pass above is the ordinary global assignment - every residue more
        // than a DSSP neighbourhood from a closure already has its final answer
        // there, with the full structure for context. The extra passes exist to
        // give the residues AT the closure a view in which the break is
        // somewhere else, and they run on the ring alone: a ring is a closed
        // sub-chain, so rotating it needs none of the rest of the file. An
        // earlier version rotated and re-assigned the whole structure per pass,
        // which cost 7x on a 2000-residue complex holding one 30-residue ring.
        //
        // The trade is that a ring-local pass cannot see a bridge to another
        // chain. That only reaches residues near the closure, where its result
        // is used at all - and when the ring IS the structure, which is the
        // usual case for a cyclic peptide, there is nothing to lose.
        for (const [lo, hi] of rings) {
            const span = hi - lo + 1;
            if (span < 5) continue;
            // Enough rotations that every residue gets one where the break is a
            // full neighbourhood away. Cost is passes * span, independent of
            // how big the rest of the structure is, so this can be generous.
            const passes = Math.max(2, Math.min(8, span));
            // margin from pass 0's break, which sits between hi and lo
            const margin = new Int32Array(span);
            for (let q = 0; q < span; q++) margin[q] = Math.min(q, span - 1 - q);
            const sub = Object.assign({}, opts || {});
            delete sub.rings;
            for (let pass = 1; pass < passes; pass++) {
                const shift = Math.round((pass * span) / passes) % span;
                if (!shift) continue;
                const pc = new Array(span);
                const pt = positionTypes ? new Array(span) : null;
                const pn = names ? new Array(span) : null;
                const back = new Int32Array(span);      // local -> global
                for (let q = 0; q < span; q++) {
                    const g = lo + ((q + shift) % span);
                    back[q] = g;
                    pc[q] = coords[g];
                    if (pt) pt[q] = positionTypes[g];
                    if (pn) pn[q] = names[g];
                }
                if (pn) sub.names = pn; else delete sub.names;
                const res = assignSecondaryOpen(pc, span, pt, sub);
                for (let q = 0; q < span; q++) {
                    const m = Math.min(q, span - 1 - q);
                    const g = back[q];
                    if (m > margin[g - lo]) { margin[g - lo] = m; sec[g] = res.sec[q]; }
                }
                for (const pair of (res.ladders || [])) {
                    const a = back[pair[0]];
                    const b = back[pair[1]];
                    const key = a < b ? a * n + b : b * n + a;
                    if (!seenLad.has(key)) { seenLad.add(key); ladders.push([a, b]); }
                }
            }
        }
        return { sec, ladders };
    }

    function assignSecondaryOpen(coords, n, positionTypes, opts) {
        const cutoff = (opts && opts.hbCutoff !== undefined) ? opts.hbCutoff : HB_ENERGY_CUTOFF;
        // Positions that may NOT bond to each other, one id per index. Overlay
        // mode merges every frame of a trajectory into one coordinate array, so
        // without this the assignment goes looking for hydrogen bonds between
        // superimposed COPIES of the molecule - which are a couple of Angstroms
        // apart and bond enthusiastically - and the secondary structure changed
        // as soon as the overlay was switched on.
        const groups = (opts && opts.groups) || null;
        // ...and may not be each other's chain NEIGHBOURS either. Merged frames
        // sit next to each other in the array, so the last residue of one and
        // the first of the next are adjacent indices: without this the amide
        // hydrogen and the phi/psi of the residues at every seam are built from
        // a neighbour in a different copy of the molecule.
        // ...and may not be each other's chain NEIGHBOURS either, which is a
        // SEPARATE question from bonding. Two chains packed against each other
        // SHOULD pair into a sheet - an inter-chain hydrogen bond is a real
        // one - but they are not one polymer, and their termini are only
        // adjacent in the array. When a C-terminus happened to land 3-4 A from
        // the next chain's N-terminus (a packing distance, and exactly the
        // window a peptide bond occupies), the backbone predictor invented a
        // peptide bond across the break and the junction grew a strand.
        //
        // `links` is the file's own connectivity, one id per residue; `groups`
        // is the overlay's frames, which are neither linked NOR bondable.
        const links = (opts && opts.links) || groups || null;
        const adj = (i, j) => !links
            || (links[i] !== undefined && links[i] === links[j]);
        const LADDER_EXTEND = (opts && opts.extendLadder !== undefined) ? opts.extendLadder : LADDER_EXTEND_DEFAULT;
        const extendGate = (opts && opts.extendGate) || LADDER_EXTEND_GATE;
        const mirrored = mirroredOf(opts && opts.names);
        const sec = new Array(n).fill('C');
        const ladders = [];
        if (n < 5) return { sec, ladders };
        const at = (i) => coords[i];
        const isProtein = (i) => !positionTypes || positionTypes[i] === 'P';
        // The backbone is predicted from a four-CA window, so a residue whose
        // window would reach into another group gets none - which is exactly
        // what happens to a residue at the end of a chain. Without this the
        // last residue of each merged frame had a C and an O invented for it
        // from the first residue of the NEXT frame, and went on to form bonds
        // and a strand that do not exist.
        const wantBb = links
            ? (i) => isProtein(i) && adj(i, i - 1) && adj(i, i + 1) && adj(i, i + 2)
            : isProtein;
        const bb = predictBackbone(at, n, wantBb, undefined, mirrored);
        const has = (i, k) => {
            const o = i * 9 + k;
            return bb[o] !== 0 || bb[o + 1] !== 0 || bb[o + 2] !== 0;
        };
        // amide hydrogens
        const H = new Float64Array(n * 3);
        for (let i = 1; i < n; i++) {
            if (!isProtein(i) || !has(i, 6) || !has(i - 1, 0)) continue;
            if (!adj(i, i - 1)) continue;
            const o = i * 9, pc = (i - 1) * 9;
            let ax = bb[o + 6] - bb[pc], ay = bb[o + 7] - bb[pc + 1], az = bb[o + 8] - bb[pc + 2];
            const p = at(i);
            let cx = bb[o + 6] - p.x, cy = bb[o + 7] - p.y, cz = bb[o + 8] - p.z;
            const la = Math.hypot(ax, ay, az), lc = Math.hypot(cx, cy, cz);
            if (la < 1e-6 || lc < 1e-6) continue;
            let hx = ax / la + cx / lc, hy = ay / la + cy / lc, hz = az / la + cz / lc;
            const lh = Math.hypot(hx, hy, hz);
            if (lh < 1e-6) continue;
            const q = i * 3;
            H[q] = bb[o + 6] + hx / lh * HB_NH_LENGTH;
            H[q + 1] = bb[o + 7] + hy / lh * HB_NH_LENGTH;
            H[q + 2] = bb[o + 8] + hz / lh * HB_NH_LENGTH;
        }
        // --- phi/psi per residue, from the rebuilt backbone ---
        // phi: C(i-1) N(i) CA(i) C(i);  psi: N(i) CA(i) C(i) N(i+1)
        const dihedral = (p0, p1, p2, p3) => {
            const b0x = p1[0] - p0[0], b0y = p1[1] - p0[1], b0z = p1[2] - p0[2];
            const b1x = p2[0] - p1[0], b1y = p2[1] - p1[1], b1z = p2[2] - p1[2];
            const b2x = p3[0] - p2[0], b2y = p3[1] - p2[1], b2z = p3[2] - p2[2];
            let n1x = b0y * b1z - b0z * b1y;
            let n1y = b0z * b1x - b0x * b1z;
            let n1z = b0x * b1y - b0y * b1x;
            let n2x = b1y * b2z - b1z * b2y;
            let n2y = b1z * b2x - b1x * b2z;
            let n2z = b1x * b2y - b1y * b2x;
            const l1 = Math.hypot(n1x, n1y, n1z), l2 = Math.hypot(n2x, n2y, n2z);
            if (l1 < 1e-9 || l2 < 1e-9) return null;
            n1x /= l1; n1y /= l1; n1z /= l1;
            n2x /= l2; n2y /= l2; n2z /= l2;
            const bl = Math.hypot(b1x, b1y, b1z);
            if (bl < 1e-9) return null;
            const mx = n1y * (b1z / bl) - n1z * (b1y / bl);
            const my = n1z * (b1x / bl) - n1x * (b1z / bl);
            const mz = n1x * (b1y / bl) - n1y * (b1x / bl);
            // negated: with b0 taken as p1 - p0 the cross products come out
            // left-handed, which flips the sign of every dihedral (and put every
            // helix at phi +57 instead of -57, excluding the entire structure)
            return -Math.atan2(mx * n2x + my * n2y + mz * n2z,
                n1x * n2x + n1y * n2y + n1z * n2z) * 180 / Math.PI;
        };
        const delta = (a, target) => {
            let d = Math.abs(a - target);
            return d > 180 ? 360 - d : d;
        };
        // per residue: 1 = dihedrals support the class, -1 = they exclude it
        const phiPsi = { H: new Int8Array(n), E: new Int8Array(n) };
        for (let i = 1; i < n - 1; i++) {
            if (!isProtein(i)) continue;
            const o = i * 9, prev = (i - 1) * 9, next = (i + 1) * 9;
            if (!has(i - 1, 0) || !has(i, 6) || !has(i, 0) || !has(i + 1, 6)) continue;
            if (!adj(i, i - 1) || !adj(i, i + 1)) continue;
            const ca = at(i);
            const phi = dihedral(
                [bb[prev], bb[prev + 1], bb[prev + 2]],
                [bb[o + 6], bb[o + 7], bb[o + 8]],
                [ca.x, ca.y, ca.z],
                [bb[o], bb[o + 1], bb[o + 2]]);
            const psi = dihedral(
                [bb[o + 6], bb[o + 7], bb[o + 8]],
                [ca.x, ca.y, ca.z],
                [bb[o], bb[o + 1], bb[o + 2]],
                [bb[next + 6], bb[next + 7], bb[next + 8]]);
            if (phi === null || psi === null) continue;
            // A D residue's dihedrals are genuinely the negatives of its L
            // mirror image - that is real geometry, not a prediction artefact,
            // so it survives the fix above. The targets are L, so reflect the
            // measurement into them; without this the gate does not merely fail
            // to support helix, it actively EXCLUDES it, and the H-bond
            // evidence never gets considered.
            const ms = (mirrored && mirrored(i)) ? -1 : 1;
            for (const cls of ['H', 'E']) {
                const b = SS_PHI_PSI[cls];
                const dpsi = delta(ms * psi, b.psi), dphi = delta(ms * phi, b.phi);
                if (dpsi > b.psiOut || dphi > b.phiOut) phiPsi[cls][i] = -1;
                else if (dpsi < b.psiIn && dphi < b.phiIn) phiPsi[cls][i] = 1;
            }
        }

        // hbond.get(i) = donors j whose N-H is bonded to the C=O of i
        const hb = new Set();
        const key = (i, j) => i * n + j;
        {   // cell grid over the C-alphas: only near neighbours can bond
            const bins = new Map();
            const bkey = (x, y, z) => `${Math.floor(x / HB_SEARCH)},${Math.floor(y / HB_SEARCH)},${Math.floor(z / HB_SEARCH)}`;
            for (let i = 0; i < n; i++) {
                if (!isProtein(i)) continue;
                const p = at(i);
                const k = bkey(p.x, p.y, p.z);
                let arr = bins.get(k);
                if (!arr) { arr = []; bins.set(k, arr); }
                arr.push(i);
            }
            for (let i = 0; i < n; i++) {          // i donates C=O
                if (!isProtein(i) || !has(i, 0) || !has(i, 3)) continue;
                const p = at(i);
                const bx = Math.floor(p.x / HB_SEARCH);
                const by = Math.floor(p.y / HB_SEARCH);
                const bz = Math.floor(p.z / HB_SEARCH);
                const o = i * 9;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            const arr = bins.get(`${bx + dx},${by + dy},${bz + dz}`);
                            if (!arr) continue;
                            for (const j of arr) {      // j donates N-H
                                if (Math.abs(i - j) < 3) continue;
                                if (groups && groups[i] !== groups[j]) continue;
                                if (!has(j, 6)) continue;
                                const hq = j * 3;
                                if (!H[hq] && !H[hq + 1] && !H[hq + 2]) continue;
                                const jo = j * 9;
                                const dON = Math.hypot(bb[o + 3] - bb[jo + 6], bb[o + 4] - bb[jo + 7], bb[o + 5] - bb[jo + 8]);
                                if (dON > 5.5) continue;
                                const dCH = Math.hypot(bb[o] - H[hq], bb[o + 1] - H[hq + 1], bb[o + 2] - H[hq + 2]);
                                const dOH = Math.hypot(bb[o + 3] - H[hq], bb[o + 4] - H[hq + 1], bb[o + 5] - H[hq + 2]);
                                const dCN = Math.hypot(bb[o] - bb[jo + 6], bb[o + 1] - bb[jo + 7], bb[o + 2] - bb[jo + 8]);
                                if (dON < 0.5 || dCH < 0.5 || dOH < 0.5 || dCN < 0.5) continue;
                                const e = HB_COUPLING * (1 / dON + 1 / dCH - 1 / dOH - 1 / dCN);
                                if (e < cutoff) hb.add(key(i, j));
                            }
                        }
                    }
                }
            }
        }
        const bonded = (i, j) => (i >= 0 && j >= 0 && i < n && j < n && hb.has(key(i, j)));
        // helices: two consecutive n-turns. 4 wins, then 3 and 5 fill in.
        const helix = new Uint8Array(n);
        const mark = (i, len) => {
            for (let k = i; k < i + len && k < n; k++) helix[k] = 1;
        };
        for (const turn of [4, 3, 5]) {
            for (let i = 1; i + turn < n; i++) {
                if (!bonded(i - 1, i - 1 + turn) || !bonded(i, i + turn)) continue;
                if (phiPsi.H[i] === -1) continue;    // dihedrals exclude helix
                if (turn !== 4) {
                    // alpha wins: skip a 3-10 or pi turn that overlaps one
                    let clash = false;
                    for (let k = i; k < i + turn && k < n; k++) if (helix[k] === 1) { clash = true; break; }
                    if (clash) continue;
                }
                mark(i, turn);
            }
        }
        // bridges. Every bridge condition names a hydrogen bond between i+-1
        // and j+-1, so the candidates for i are the partners of its own
        // neighbourhood - which keeps this O(n x bonds) instead of O(n^2).
        const nbr = new Map();
        const addNbr = (a, b) => {
            let arr = nbr.get(a);
            if (!arr) { arr = []; nbr.set(a, arr); }
            arr.push(b);
        };
        for (const k of hb) {
            const i = Math.floor(k / n), j = k % n;
            addNbr(i, j); addNbr(j, i);
        }
        const strand = new Uint8Array(n);
        const seen = new Set();
        const candidates = new Set();
        for (let i = 1; i < n - 1; i++) {
            if (!isProtein(i)) continue;
            candidates.clear();
            for (let d = -1; d <= 1; d++) {
                const arr = nbr.get(i + d);
                if (!arr) continue;
                for (const j of arr) {
                    for (let e = -1; e <= 1; e++) candidates.add(j + e);
                }
            }
            for (const j of candidates) {
                if (j <= i + 2 || j >= n - 1 || j < 1 || !isProtein(j)) continue;
                const parallel = (bonded(i - 1, j) && bonded(j, i + 1))
                    || (bonded(j - 1, i) && bonded(i, j + 1));
                const anti = (bonded(i, j) && bonded(j, i))
                    || (bonded(i - 1, j + 1) && bonded(j - 1, i + 1));
                if (!parallel && !anti) continue;
                if (phiPsi.E[i] === -1 || phiPsi.E[j] === -1) continue;
                strand[i] = 1; strand[j] = 1;
                const k = key(i, j);
                if (!seen.has(k)) { seen.add(k); ladders.push([i, j]); }
            }
        }
        // LADDER EXTENSION. A bridge needs two hydrogen bonds and this backbone
        // is predicted, so a rung whose bonds land just the wrong side of the
        // cutoff breaks the ladder there - and a strand can survive as a single
        // residue while DSSP calls four (1TIM chain B's eighth barrel strand
        // did exactly that). Walk each ladder outward while the next rung is
        // still a plausible one: the two residues at ladder spacing, neither
        // already helical, and the strands running on rather than turning.
        const extendLadder = (i, j, di, dj) => {
            let a = i + di, b = j + dj;
            for (let step = 0; step < LADDER_EXTEND; step++) {
                if (a < 0 || a >= n || b < 0 || b >= n) return;
                if (!isProtein(a) || !isProtein(b)) return;
                if (helix[a] || helix[b]) return;
                if (Math.abs(a - b) < 3) return;
                const pa = at(a), pb = at(b);
                const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
                if (d < LADDER_CA_MIN || d > LADDER_CA_MAX) return;
                // both ends must have STRAND DIHEDRALS. Distance alone walks the
                // ladder straight into the flanking loops (recall 87 -> 98% but
                // strand precision 96 -> 69%, because a loop residue sits a rung
                // away from a strand all the time). This is PyMOL's test for the
                // same situation - it admits an open ladder only where the phi/
                // psi geometry supports the assignment.
                if (extendGate === 'support') {
                    if (phiPsi.E[a] !== 1 || phiPsi.E[b] !== 1) return;
                } else if (phiPsi.E[a] === -1 || phiPsi.E[b] === -1) {
                    return;
                }
                if (!strand[a] || !strand[b]) {
                    strand[a] = 1; strand[b] = 1;
                    const k = key(Math.min(a, b), Math.max(a, b));
                    if (!seen.has(k)) { seen.add(k); ladders.push([a, b]); }
                }
                a += di; b += dj;
            }
        };
        if (LADDER_EXTEND > 0) {
            for (const [i, j] of ladders.slice()) {
                // parallel ladders run the same way, antiparallel the other;
                // try both and let the distance test decide
                extendLadder(i, j, 1, 1);
                extendLadder(i, j, -1, -1);
                extendLadder(i, j, 1, -1);
                extendLadder(i, j, -1, 1);
            }
        }
        for (let i = 0; i < n; i++) {
            if (!isProtein(i)) continue;
            sec[i] = strand[i] ? 'E' : (helix[i] ? 'H' : 'C');
        }
        // AN ISOLATED BRIDGE IS NOT A STRAND. A single residue can satisfy the
        // bridge test on its own, and that came straight through as a
        // one-residue 'E' - which draws as a lone arrowhead stub sitting in the
        // middle of a loop (1TIM had three such runs). DSSP calls this a bridge
        // rather than a strand and cartoons render it as loop; the superseded
        // C-alpha pipeline dropped them too, via this same SS.minStrand, but
        // that guard was never carried over here.
        // Helices need no equivalent: the helix test already requires several
        // consecutive residues, and 1TIM's shortest H run is 3.
        // Runs are taken over consecutive indices. A run that spanned a chain
        // break would only measure LONGER and so fail to be dropped - it cannot
        // wrongly delete a real strand.
        for (let i = 0; i < n; i++) {
            if (sec[i] !== 'E') continue;
            let hi = i;
            while (hi + 1 < n && sec[hi + 1] === 'E') hi++;
            if (hi - i + 1 < SS.minStrand) {
                for (let k = i; k <= hi; k++) sec[k] = 'C';
            }
            i = hi;
        }
        return { sec, ladders };
    }

    /**
     * Side vectors for every strand residue, as coefficients in that residue's
     * local frame.
     *
     * This is a port of PyMOL's cartoon frame construction (layer2/
     * RepCartoon.cpp), which is what a well-drawn sheet is built on. The four
     * steps, the first three PyMOL's:
     *
     *  1. ORIENTATION VECTOR. The peptide plane normal, cross(N-C, N-O), is the
     *     ribbon normal - measured against the local sheet plane over 40 native
     *     chains, 19 deg median. Consecutive residues in a strand have it
     *     pointing opposite ways (that alternation IS the pleat), so every other
     *     one is inverted: PyMOL's `parity`, toggled per sheet residue and reset
     *     at any non-sheet residue.
     *  2. FLATTEN SHEETS (cartoon_flat_sheets, cartoon_flat_cycles = 4). Per
     *     contiguous strand, four cycles of: 3-point average of the positions,
     *     3-point average of the normals, then re-orthogonalize each normal
     *     against the tangent of the SMOOTHED positions. Averaging both in
     *     lockstep is the part that matters - the normals end up describing the
     *     surface the flattened strand actually lies on. The smoothed positions
     *     stay local to this function; the renderer flattens its own drawing.
     *  3. REFINE NORMALS (cartoon_refine_normals). Walk each strand making the
     *     sign consistent with the predecessor, then soften kinks: where a
     *     normal disagrees with both neighbours (the two dot products,
     *     multiplied, below -0.10) blend it toward their sum.
     *  4. RELAX ACROSS THE LADDERS. The one addition. Paired residues step
     *     toward each other's normal, which is what pulls two strands onto a
     *     common plane rather than merely making each strand smooth. PyMOL has
     *     nothing like it because it never looks across a sheet.
     *
     * -> Float64Array(n * 3), zeros where the residue has no sheet frame.
     */
    /**
     * Sheet frames, RING AWARE.
     *
     * buildSheetFramesOpen collects contiguous strand STRETCHES by index, so a
     * strand crossing a head-to-tail closure arrives as two - and a one-residue
     * remnant is dropped outright, leaving that residue with no sheet frame and
     * a face orientation taken from raw curvature instead. Both show at the
     * seam as a twist in the plate.
     *
     * The stretch loops are the tuned part of the sheet pipeline, so rather
     * than teach six of them to wrap, each ring is ROTATED so its break lands
     * on a residue that is not in a strand - then no strand is ever split and
     * the machinery runs unchanged. A cut needs only sec[cut] !== 'E': a strand
     * is split only when the residues either side of the break are both strand.
     * A ring that is strand end to end has no such point and keeps the old
     * behaviour, which is the best available.
     */
    function buildSheetFrames(coords, n, sec, positionTypes, ladders, opts) {
        const rings = (opts && opts.rings) || null;
        if (!rings || !rings.length) {
            return buildSheetFramesOpen(coords, n, sec, positionTypes, ladders, opts);
        }
        const perm = new Int32Array(n);      // perm[newIdx] = oldIdx
        const inv = new Int32Array(n);       // inv[oldIdx] = newIdx
        for (let i = 0; i < n; i++) { perm[i] = i; inv[i] = i; }
        let rotated = false;
        for (const [lo, hi] of rings) {
            const span = hi - lo + 1;
            if (span < 3) continue;
            // WHERE TO CUT. Two conditions, and the second is the one that
            // bit: no strand may be SPLIT by the break, and no strand residue
            // may land at either END of the array. buildSheetFramesOpen builds
            // its orientation vectors from predictBackbone, which is linear -
            // it runs i = 1..n-3 and localFrame needs i-1..i+2 - so residues 0,
            // n-2 and n-1 never get a frame at all. Cutting merely off-strand
            // moved the seam strand to exactly those slots, and its residues
            // fell back to curvature-derived sides while their neighbours used
            // the sheet frame. Mixing the two sources mid-strand is a visible
            // twist (1YP8 model 11).
            //
            // So require the residues landing at 0, 1, n-2 and n-1 to be
            // non-strand, i.e. four in a row around the cut, and relax to three
            // then to any non-strand residue when a ring has no such run.
            const nonE = (q) => sec[lo + ((q % span) + span) % span] !== 'E';
            let cut = -1;
            for (const need of [4, 3, 1]) {
                for (let q = 0; q < span; q++) {
                    let ok = true;
                    // positions n-2, n-1 come from q-2, q-1; 0 and 1 from q, q+1
                    for (let d = -2; d < need - 2 && ok; d++) if (!nonE(q + d)) ok = false;
                    if (need === 1) ok = nonE(q) && nonE(q - 1) && nonE(q - 2);
                    if (ok) { cut = q; break; }
                }
                if (cut >= 0) break;
            }
            if (cut < 0) continue;           // strand end to end: nothing better
            if (cut === 0) continue;         // already clean
            rotated = true;
            for (let q = 0; q < span; q++) {
                const old = lo + ((q + cut) % span);
                perm[lo + q] = old;
                inv[old] = lo + q;
            }
        }
        if (!rotated) {
            return buildSheetFramesOpen(coords, n, sec, positionTypes, ladders, opts);
        }
        const names = (opts && opts.names) || null;
        const pc = new Array(n);
        const ps = new Array(n);
        const pt = positionTypes ? new Array(n) : null;
        const pn = names ? new Array(n) : null;
        for (let k = 0; k < n; k++) {
            pc[k] = coords[perm[k]];
            ps[k] = sec[perm[k]];
            if (pt) pt[k] = positionTypes[perm[k]];
            if (pn) pn[k] = names[perm[k]];
        }
        const pl = (ladders || []).map((pair) => [inv[pair[0]], inv[pair[1]]]);
        const sub = Object.assign({}, opts || {});
        delete sub.rings;
        if (pn) sub.names = pn;
        const res = buildSheetFramesOpen(pc, n, ps, pt, pl, sub);
        // back to the caller's indexing. The coefficients are expressed in each
        // residue's own local frame, which is built from its neighbours - and
        // rotation preserves those, so they carry over unchanged.
        const local = new Float64Array(n * 3);
        const flatLocal = new Float64Array(n * 3);
        const onSheet = new Uint8Array(n);
        for (let k = 0; k < n; k++) {
            const old = perm[k];
            for (let c = 0; c < 3; c++) {
                local[old * 3 + c] = res.local[k * 3 + c];
                flatLocal[old * 3 + c] = res.flatLocal[k * 3 + c];
            }
            onSheet[old] = res.onSheet[k];
        }
        return { local, flatLocal, onSheet };
    }

    function buildSheetFramesOpen(coords, n, sec, positionTypes, ladders, opts) {
        const flatCycles = (opts && opts.cycles !== undefined) ? opts.cycles : SHEET_FLAT_CYCLES;
        const relaxSweeps = (opts && opts.relax !== undefined) ? opts.relax : SHEET_FRAME_RELAX;
        const alongW = (opts && opts.along !== undefined) ? opts.along : SHEET_ALONG_W;
        const acrossW = (opts && opts.across !== undefined) ? opts.across : SHEET_ACROSS_W;
        const mirrored = mirroredOf(opts && opts.names);
        const at = (i) => coords[i];
        const isStrand = (i) => sec[i] === 'E' && (!positionTypes || positionTypes[i] === 'P');
        const bb = predictBackbone(at, n, isStrand, undefined, mirrored);

        // --- 1. orientation vectors, with PyMOL's parity flip ---
        const nrm = new Array(n).fill(null);
        let parity = 0;
        for (let i = 0; i < n; i++) {
            if (!isStrand(i)) { parity = 0; continue; }
            parity = parity ? 0 : 1;
            const o = i * 9;
            const cx = bb[o], cy = bb[o + 1], cz = bb[o + 2];
            const ox = bb[o + 3], oy = bb[o + 4], oz = bb[o + 5];
            const nx = bb[o + 6], ny = bb[o + 7], nz = bb[o + 8];
            if ((!cx && !cy && !cz) || (!nx && !ny && !nz)) continue;
            let ax = nx - cx, ay = ny - cy, az = nz - cz;      // N <- C
            let bx = nx - ox, by = ny - oy, bz = nz - oz;      // N <- O
            const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
            if (la < 1e-6 || lb < 1e-6) continue;
            ax /= la; ay /= la; az /= la;
            bx /= lb; by /= lb; bz /= lb;
            const vx = ay * bz - az * by;
            const vy = az * bx - ax * bz;
            const vz = ax * by - ay * bx;
            const lv = Math.hypot(vx, vy, vz);
            if (lv < 1e-6) continue;
            const sgn = parity ? -1 / lv : 1 / lv;
            nrm[i] = [vx * sgn, vy * sgn, vz * sgn];
        }

        // contiguous strand stretches, the unit PyMOL flattens over
        const stretches = [];
        for (let i = 0; i < n; i++) {
            if (!nrm[i]) continue;
            let j = i;
            while (j + 1 < n && nrm[j + 1]) j++;
            if (j > i) stretches.push([i, j]);
            i = j;
        }

        const tanOf = (pv, i, lo, hi) => {
            const a = pv[Math.max(lo, i - 1)], b = pv[Math.min(hi, i + 1)];
            const x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
            const l = Math.hypot(x, y, z);
            return l > 1e-9 ? [x / l, y / l, z / l] : null;
        };
        // The renderer lays the strip on the ORIGINAL trace, so the frame it is
        // handed has to be built against that tangent. pv - PyMOL's smoothed
        // copy - is for the flattening cycles only: taking the side vector
        // against the smoothed tangent instead threw away most of what the
        // surface fit had just bought (partner faces 5 deg -> 21).
        const orthoNorm = (v, t) => {
            if (!v || !t) return v;
            const d = v[0] * t[0] + v[1] * t[1] + v[2] * t[2];
            const x = v[0] - t[0] * d, y = v[1] - t[1] * d, z = v[2] - t[2] * d;
            const l = Math.hypot(x, y, z);
            return l > 1e-9 ? [x / l, y / l, z / l] : v;
        };

        // --- 2. flatten sheets: positions and normals together ---
        const pv = new Array(n);
        for (let i = 0; i < n; i++) { const p = at(i); pv[i] = [p.x, p.y, p.z]; }
        for (const [lo, hi] of stretches) {
            for (let c = 0; c < flatCycles; c++) {
                const tmpP = [], tmpN = [];
                for (let i = lo + 1; i <= hi - 1; i++) {
                    tmpP.push([(pv[i - 1][0] + pv[i][0] + pv[i + 1][0]) / 3,
                        (pv[i - 1][1] + pv[i][1] + pv[i + 1][1]) / 3,
                        (pv[i - 1][2] + pv[i][2] + pv[i + 1][2]) / 3]);
                    tmpN.push([(nrm[i - 1][0] + nrm[i][0] + nrm[i + 1][0]) / 3,
                        (nrm[i - 1][1] + nrm[i][1] + nrm[i + 1][1]) / 3,
                        (nrm[i - 1][2] + nrm[i][2] + nrm[i + 1][2]) / 3]);
                }
                for (let i = lo + 1; i <= hi - 1; i++) {
                    pv[i] = tmpP[i - lo - 1];
                    nrm[i] = tmpN[i - lo - 1];
                }
                for (let i = lo + 1; i <= hi - 1; i++) {
                    nrm[i] = orthoNorm(nrm[i], tanOf(pv, i, lo, hi));
                }
            }
        }

        // --- 3. refine normals: consistent sign, then soften kinks ---
        for (const [lo, hi] of stretches) {
            for (let i = lo; i <= hi; i++) nrm[i] = orthoNorm(nrm[i], tanOf(pv, i, lo, hi));
            for (let i = lo + 1; i <= hi; i++) {
                const p = nrm[i - 1], v = nrm[i];
                if (p[0] * v[0] + p[1] * v[1] + p[2] * v[2] < 0) nrm[i] = [-v[0], -v[1], -v[2]];
            }
            for (let i = lo + 1; i <= hi - 1; i++) {
                const v = nrm[i], a = nrm[i - 1], b = nrm[i + 1];
                const dp = (v[0] * b[0] + v[1] * b[1] + v[2] * b[2])
                    * (v[0] * a[0] + v[1] * a[1] + v[2] * a[2]);
                if (dp >= SHEET_KINK_LIMIT) continue;
                const cand = orthoNorm([a[0] + b[0] + v[0] * 0.001,
                    a[1] + b[1] + v[1] * 0.001,
                    a[2] + b[2] + v[2] * 0.001], tanOf(pv, i, lo, hi));
                if (!cand) continue;
                const sgn = (v[0] * cand[0] + v[1] * cand[1] + v[2] * cand[2]) < 0 ? -1 : 1;
                let mix = 2 * (SHEET_KINK_LIMIT - dp);
                if (mix > 1) mix = 1;
                const mx = v[0] + (cand[0] * sgn - v[0]) * mix;
                const my = v[1] + (cand[1] * sgn - v[1]) * mix;
                const mz = v[2] + (cand[2] * sgn - v[2]) * mix;
                const ml = Math.hypot(mx, my, mz);
                if (ml > 1e-9) nrm[i] = [mx / ml, my / ml, mz / ml];
            }
        }

        const partnerOf = new Map();
        for (const [i, j] of ladders) {
            if (!partnerOf.has(i)) partnerOf.set(i, []);
            partnerOf.get(i).push(j);
            if (!partnerOf.has(j)) partnerOf.set(j, []);
            partnerOf.get(j).push(i);
        }

        // --- 4. THE SHEET SURFACE ITSELF ---
        //
        // Steps 1-3 give each strand a smooth frame of its own, which is as far
        // as PyMOL goes, and it is not far enough: neighbouring strands still
        // sat 19 deg apart, which is what "the sheet is not flat" looks like.
        //
        // A sheet is a surface, so read the frame off the surface. For each
        // strand residue, fit a plane through its own neighbourhood AND the
        // neighbourhoods of the residues it hydrogen bonds to - a patch of the
        // sheet about two rungs wide - and take the normal. Paired residues then
        // agree because they are looking at nearly the same patch of it.
        // Measured over the natives: the fitted normals of two paired residues
        // agree to 4.7 deg, against 19.1 for per-residue peptide normals.
        //
        // Residues with too small a patch (an edge strand's tip, an isolated
        // bridge) keep the frame from steps 1-3.
        const patch = [];
        const fitted = new Array(n).fill(null);
        const flatLocal = new Float64Array(n * 3);
        const onSheet = new Uint8Array(n);
        const fr2 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (const [lo, hi] of stretches) {
            for (let i = lo; i <= hi; i++) {
                let count = 0;
                const addWindow = (c) => {
                    for (let k = c - SHEET_FIT_WIN; k <= c + SHEET_FIT_WIN; k++) {
                        if (k < 0 || k >= n || sec[k] !== 'E') continue;
                        const p = at(k);
                        if (!patch[count]) patch[count] = [0, 0, 0];
                        patch[count][0] = p.x; patch[count][1] = p.y; patch[count][2] = p.z;
                        count++;
                    }
                };
                addWindow(i);
                // the residue's own partners, and those of its neighbours along
                // the strand: without the second the patch is one rung wide and
                // its normal wobbles residue to residue (28 deg between
                // consecutive residues, measured)
                for (let d = -1; d <= 1; d++) {
                    const ps = partnerOf.get(i + d);
                    if (!ps) continue;
                    for (const j of ps) addWindow(j);
                }
                if (count < 4) continue;
                const nr = planeNormal(patch, count);
                if (!nr) continue;
                fitted[i] = nr;
                // ...and where that patch of the sheet actually is. A strand
                // PLEATS: successive C-alphas sit ~0.5 A either side of the
                // sheet. Dropping each residue onto its own patch removes that
                // and nothing else, which is the geometric version of what
                // every cartoon convention does by blurring the strand along
                // its length. Offered as SHEET_PROJECT rather than imposed,
                // since it moves the drawn backbone.
                let cx2 = 0, cy2 = 0, cz2 = 0;
                for (let k = 0; k < count; k++) {
                    cx2 += patch[k][0]; cy2 += patch[k][1]; cz2 += patch[k][2];
                }
                cx2 /= count; cy2 /= count; cz2 /= count;
                const p = at(i);
                const d = (p.x - cx2) * nr[0] + (p.y - cy2) * nr[1] + (p.z - cz2) * nr[2];
                if (!localFrame(at, n, i, fr2)) continue;
                const dx = -nr[0] * d, dy = -nr[1] * d, dz = -nr[2] * d;
                const o = i * 3;
                flatLocal[o] = dx * fr2[0] + dy * fr2[1] + dz * fr2[2];
                flatLocal[o + 1] = dx * fr2[3] + dy * fr2[4] + dz * fr2[5];
                flatLocal[o + 2] = dx * fr2[6] + dy * fr2[7] + dz * fr2[8];
                onSheet[i] = 1;
            }
        }
        for (let i = 0; i < n; i++) if (fitted[i]) nrm[i] = fitted[i];
        // the fit has no sign convention of its own; carry one along each strand
        for (const [lo, hi] of stretches) {
            for (let i = lo + 1; i <= hi; i++) {
                const p = nrm[i - 1], v = nrm[i];
                if (!p || !v) continue;
                if (p[0] * v[0] + p[1] * v[1] + p[2] * v[2] < 0) nrm[i] = [-v[0], -v[1], -v[2]];
            }
        }

        // --- 5. joint relaxation: along the strand AND across the rungs ---
        //
        // One Laplacian over a graph whose edges are the backbone within a
        // strand and the hydrogen bonds across it, so smoothing a strand and
        // agreeing with its neighbours happen in the same sweep instead of
        // undoing each other. Signs are aligned per edge, because a normal and
        // its opposite describe the same ribbon.
        for (let sweep = 0; sweep < relaxSweeps; sweep++) {
            const src = nrm.slice();
            for (const [lo, hi] of stretches) {
                for (let i = lo; i <= hi; i++) {
                    const v = src[i];
                    if (!v) continue;
                    let ax = v[0] * SHEET_SELF_W, ay = v[1] * SHEET_SELF_W, az = v[2] * SHEET_SELF_W;
                    const add = (uv, w) => {
                        if (!uv) return;
                        const sgn = (v[0] * uv[0] + v[1] * uv[1] + v[2] * uv[2]) < 0 ? -w : w;
                        ax += uv[0] * sgn; ay += uv[1] * sgn; az += uv[2] * sgn;
                    };
                    if (i > lo) add(src[i - 1], alongW);
                    if (i < hi) add(src[i + 1], alongW);
                    const ps = partnerOf.get(i);
                    if (ps) for (const j of ps) add(src[j], acrossW);
                    // NOT orthogonalized against the tangent here: doing that
                    // every sweep rotates each residue's normal by its own
                    // tangent wobble, which undoes the agreement the sweep just
                    // reached (measured: 21 deg partner faces instead of 5).
                    // The projection happens once, at the hand-over below.
                    const l = Math.hypot(ax, ay, az);
                    if (l > 1e-9) nrm[i] = [ax / l, ay / l, az / l];
                }
            }
        }

        // The renderer wants the ribbon's WIDTH axis, which is the normal
        // crossed with the tangent; stored as coefficients in the local frame so
        // the draw stage only has to rebuild that frame from rotated coords.
        const local = new Float64Array(n * 3);
        const fr = _frameTmp;
        for (const [lo, hi] of stretches) {
            for (let i = lo; i <= hi; i++) {
                const v = nrm[i];
                // The smoothed tangent - the ribbon is laid along the strand,
                // and the pleat in the raw trace would tilt the frame by that
                // residue's own wobble.
                const t = tanOf(pv, i, lo, hi);
                if (!v || !t || !localFrame(at, n, i, fr)) continue;
                let sx = v[1] * t[2] - v[2] * t[1];
                let sy = v[2] * t[0] - v[0] * t[2];
                let sz = v[0] * t[1] - v[1] * t[0];
                const sl = Math.hypot(sx, sy, sz);
                if (sl < 1e-9) continue;
                sx /= sl; sy /= sl; sz /= sl;
                const o = i * 3;
                local[o] = sx * fr[0] + sy * fr[1] + sz * fr[2];
                local[o + 1] = sx * fr[3] + sy * fr[4] + sz * fr[5];
                local[o + 2] = sx * fr[6] + sy * fr[7] + sz * fr[8];
            }
        }
        return { local, flatLocal, onSheet };
    }

    // ---- STRAND FRAME CONSTRUCTION -----------------------------------------
    const SHEET_FLAT_CYCLES = 4;     // PyMOL's cartoon_flat_cycles
    const SHEET_KINK_LIMIT = -0.10;  // PyMOL's kink threshold in refine_normals
    const SHEET_FIT_WIN = 1;         // residues each side in a sheet patch
    // Moving strand residues onto their own sheet plane (the offsets computed
    // in buildSheetFrames) is available but OFF: it makes the drawn side vector
    // exactly perpendicular to the drawn tangent, but measured over the natives
    // it left the ribbon slightly FURTHER from the sheet plane, not closer
    // (13.9 -> 15.2 deg), because each residue is projected onto a slightly
    // different local plane. renderer.cartoonSheetProject overrides it.
    const SHEET_PROJECT = 0;         // how far strands are moved onto their sheet plane
    // Joint relaxation over the sheet graph - a residue's own normal, its
    // backbone neighbours' and its hydrogen-bonded partners'. Swept in
    // tests/sheet_bench.js over 71 native chains: this takes the angle between
    // the ribbon faces of two paired residues from 38.9 deg (C-alpha curvature
    // frames) to 21.2, and the roll between consecutive residues in a strand
    // from 19.6 to 10.4. The remaining 21 deg is not error - it is what the
    // constraint "each ribbon's face is perpendicular to its own strand" costs
    // in a twisted sheet, and the same measurement on the sheets themselves
    // gives 20.0.
    const SHEET_FRAME_RELAX = 4;     // sweeps
    const SHEET_SELF_W = 1;
    const SHEET_ALONG_W = 1;
    const SHEET_ACROSS_W = 1;
    const SUB = 6;            // loop samples per residue interval
    const NA_SUB = 6;         // nucleic samples (coarser geometry, fatter tube)
    // DETAIL (renderer.cartoonDetail, an integer 1-4) is the ONLY thing that
    // sets sampling: subdivisions per residue = the per-element ratio above
    // scaled by it (a helix, ratio 8, gets exactly Detail subdivisions).
    //
    // There used to be a second, ADAPTIVE term targeting a fixed on-screen
    // chord length, and it usually won: a 30-residue helix on a 900px canvas
    // ran at 27 subdivisions per residue while the floor asked for 8. That
    // made Detail mostly decorative, made cost depend on canvas size and
    // zoom in ways nobody could predict, and was the single largest term in
    // the frame (halving sampling halves the frame). Removed: sampling is now
    // exactly what the control says, and identical at every canvas size and
    // zoom level. Magnified curves facet rather than resample - the
    // deliberate "cartoon" look, and what Detail is for.
    // 2 is a HARD FLOOR, not a preference. A helix turns ~100 degrees per
    // residue, so a single sample per residue cannot represent the coil at
    // all (it collapses to a flat zigzag), and with nsub 1 the sign-fold
    // cutting loop below - `for k = 1; k < nsub` - never runs, so no piece
    // is ever cut where a surface turns over and the depth sort has nothing
    // to work with: overlapping faces and dropped outlines. The Detail range
    // therefore starts at 2; the range, not the clamp, is what makes every
    // step of the control distinct.
    const MIN_SUB = 2;
    let detailCur = 1;
    // Stations closer together than this on screen cannot be told apart, so the
    // extra ones are geometry, depth sorting and stroking spent on curvature the
    // display cannot show.
    const SUB_TARGET_PX = 3;
    // Upper bound on subdivision from the size of a residue in the OUTPUT, set
    // per render below. Exports are capped the same way - they render at their
    // own resolution, so a high-dpi PNG raises the cap by itself.
    let subCapCur = Infinity;
    const subFloor = (base) => Math.max(MIN_SUB,
        Math.min(Math.round(base * detailCur), subCapCur));
    // Depth fade DISABLED by default (user decision): 1.0 = uniform tone
    // at any depth. The old 0.45 fade read as "the object fading into the
    // screen" / a shade stuck to the view. Re-enable per renderer with
    // renderer.cartoonFade, the Fade slider: 0 = uniform tone at any depth,
    // 1 = the far side fully bleached into the paper. Internally the fade is
    // a FLOOR on the shade factor (floor = 1 - fade); the old always-on cue
    // sat at floor 0.45 and read as "a shade stuck to the view", so the
    // default is OFF - the slider is there when depth separation is wanted.
    // Shade slider: 0 = flat colour, 1 = full directional modelling. This
    // replaced an on/off switch; 0 reproduces the old "off" exactly.
    const SHADE_DEFAULT = 1;
    const FADE_DEFAULT = 0;
    let depthFloorCur = 1 - FADE_DEFAULT;
    // The OUTLINE fades less than the fill it surrounds. In Richardson's
    // paintings the receding parts are washed out in TONE but still fully
    // drawn - the pen line holds all the way back, and it is the colour that
    // drains. Fading both together instead turned distant structure into a
    // vague smudge and lost the read of what crosses what, which is the one
    // thing the outline is there for. At 0.35 a fully faded fill still keeps
    // roughly two thirds of its line.
    // (The opposite error is just as bad and is why inkColor takes `near` at
    // all: an outline at FULL strength over a bleached fill reads as a dark
    // wireframe floating over ghost geometry.)
    const INK_FADE_SCALE = 0.35;
    let inkFloorCur = 1 - FADE_DEFAULT * INK_FADE_SCALE;
    // The page behind the canvas (renderer.backgroundColor, white or black).
    // viewer-mol.js paints the canvas with it when not transparent; the depth
    // blend goes toward it, and the base INK is its opposite - black outlines
    // vanish on a black page, so dark mode inks in white. Both are set per
    // render from the renderer.
    let PAPER = [255, 255, 255];
    let INK_BASE = 0;
    // Outline drawn under every element, matching py2Dmol's inked aesthetic;
    // because it is painted back-to-front under each element's fill it
    // doubles as the occlusion cue where elements cross.
    let OUTLINE_CSS = 'rgb(0,0,0)';
    // Ribbon mode inks each segment with its OWN colour darkened to 70%
    // (viewer-mol.js, gapFillerColor), so outlines follow the colour scheme.
    // Cartoon inked everything pure black, which holds the silhouette harder
    // where elements cross but makes the two styles look like different
    // viewers. renderer.cartoonOutlineTint mixes between them: 0 = black
    // (default, the inked aesthetic), 1 = ribbon's 0.7 tint of the element
    // colour. Anything between keeps a dark edge that still belongs to its
    // element.
    const RIBBON_INK_MUL = 0.7;   // matches viewer-mol.js gapFillerColor
    // The drawn weight of an outline, and its floor, both relative to the
    // Outline control. Named because the WebGL2 port needs the SAME numbers -
    // it had its own 0.8 and 0.2 and drew every line 1.45x heavy.
    const INK_W_MUL = 0.55;
    const INK_W_MIN = 0.35;
    function inkColor(rgb, tint, near) {
        // `near` applies the SAME depth fade the fills get (see shade):
        // without it the outline stayed full-strength black while the fill
        // behind it paled, and a faded structure read as a dark wireframe
        // floating over ghost geometry. Omitting `near` keeps full strength.
        const t = (tint && rgb) ? Math.min(1, Math.max(0, tint)) : 0;
        const f = near === undefined ? 1
            : inkFloorCur + (1 - inkFloorCur) * near;
        if (t === 0 && f >= 1) return OUTLINE_CSS;
        const r = rgb ? rgb.r : 0;
        const g = rgb ? rgb.g : 0;
        const b = rgb ? rgb.b : 0;
        const ch = (v) => Math.round(
            (t === 0 ? INK_BASE : v * RIBBON_INK_MUL * t) * f + PAPER[0] * (1 - f));
        return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
    }

    // A colour, straight, with no light and no depth blend on it. What an
    // annotation wants: the flat stroke a contact used to be drew exactly this.
    function rgbCss(c) {
        const q = (v) => Math.max(0, Math.min(255, Math.round(v || 0)));
        return `rgb(${q(c && c.r)},${q(c && c.g)},${q(c && c.b)})`;
    }

    /**
     * Blend toward the page background; opaque, so overlaps occlude.
     * `lum` (default 1) is a LIGHTING multiplier applied after the paper
     * blend - it darkens toward black (shadow), which is visually distinct
     * from the depth blend toward white.
     */
    // NOTE: memoising this was tried and is NOT a win - measured neutral to
    // slightly worse (1085 vs 1050 ms at 10000 residues). Computing a key and
    // probing a Map costs about what building the string costs, and cel
    // shading (which collapses 39k distinct colours to 4.6k) does not change
    // that because the repeats are not adjacent in draw order.
    function shade(rgb, near, dim, extra, lum) {
        const f = (depthFloorCur + (1 - depthFloorCur) * near) * dim * (extra || 1);
        const q = lum === undefined ? 1 : lum;
        // lum <= 1 multiplies toward black (shadow), exactly as before.
        // lum > 1 is a HIGHLIGHT: blend toward the paper white instead of
        // multiplying. Multiplying past 1 clips channels one at a time, which
        // slews the hue (a saturated blue clips to cyan before it looks lit);
        // blending toward white lifts all three together and keeps the hue.
        const mul = q < 1 ? q : 1;
        const hi = q > 1 ? Math.min(1, q - 1) : 0;
        const ch = (v, paper) => {
            const c = (v * f + paper * (1 - f)) * mul;
            // highlight lifts toward WHITE regardless of the paper: toward
            // a black paper it would darken, inverting its meaning
            return Math.round(hi > 0 ? c + (255 - c) * hi : c);
        };
        return `rgb(${ch(rgb.r, PAPER[0])},`
            + `${ch(rgb.g, PAPER[1])},`
            + `${ch(rgb.b, PAPER[2])})`;
    }

    // Directional light, VIEW space (+z toward the viewer, y up): from the
    // upper left, in front. Ambient floor keeps shadowed faces readable.
    const LIGHT = (() => {
        const v = [-0.45, 0.6, 0.75];
        const m = Math.hypot(v[0], v[1], v[2]);
        return [v[0] / m, v[1] / m, v[2] / m];
    })();
    const LIGHT_AMB = 0.72;
    const LIGHT_DIFF = 0.28;
    // HIGHLIGHT: the diffuse term above tops out at exactly 1.0, so the base
    // colour was the ceiling - a face pointing straight at the light got the
    // unmodified colour and everything else was darker, which reads muddy.
    // This adds a term ABOVE 1 for faces past the knee, which shade() turns
    // into a blend toward white. Off when renderer.cartoonHighlight is 0.
    const LIGHT_HI = 0.22;    // peak lift above base colour
    const HI_KNEE = 0.55;     // n.L below this gets no lift at all
    // ... except in Richardson, where the highlight is BROAD. Measured on 1TIM,
    // the fraction of each helix carrying any highlight and how much that
    // fraction varies between helices:
    //     knee 0.55   21% coverage, sd 10.9%, 3 of 49 helices get none
    //     knee 0.25   38% coverage, sd  5.8%, none missed
    // A tight knee is a specular highlight - it suits the '3d' preset, which is
    // pretending to be a rendered solid. Richardson's are pencil, laid down
    // broadly along every coil, which is why they read across the whole picture
    // rather than picking out the helices that happen to face the light.
    // NOTE the light ANGLE is not the lever here, though it looks like it
    // should be: a helix spirals through every orientation, so any angle
    // catches about the same fraction of each spiral. Measured across 0-60 deg
    // off the view axis, coverage stayed ~21% and a head-on light was slightly
    // WORSE (9 of 49 helices unhighlighted, against 3 at the current 45 deg).
    // The angle moves highlights ALONG a helix; the knee decides how many
    // helices have one at all.
    const RICH_HI_KNEE = 0.25;
    // extra darkening for the concave (inner) side of curved elements -
    // "the inside of the helix is darker"
    const INNER_SHADE = 0.22;
    // ... scaled down on a face that already carries a palette `back` colour.
    // The inner shadow and the pale underside hue encode the SAME fact - that
    // this face looks into the backbone's concavity - so applying both at full
    // strength double-counts it and drives the tan toward mud, losing the
    // contrast with the dark outer face that is the whole point of the
    // two-tone. Not zero: a little shading still models the ribbon's curl.
    const BACK_INNER_SHADE = 0.3;
    // Richardson mode LIGHTENS the inner face instead of shadowing it. Her
    // paintings light the inside of a helix spiral brighter than the outside -
    // a drawing convention, not a light-transport result, which is why it
    // belongs to the STYLE and applies whatever palette is loaded.
    // Done as a TINT TOWARD WHITE, not as a brightness multiplier. A multiplier
    // cannot deliver this: palette hues are already near-saturated in their
    // dominant channel (pymol helix red is 224), so scaling up clips at 255 and
    // the effect flattens - measured, an 18% lift moved the inner face only
    // ~1.8 luminance and tripling it bought ~1.2 more. A tint raises every
    // channel toward 255 instead, so it keeps working on saturated colours.
    // 0.68 was set against a palette that carried an explicit two-tone helix
    // of its own (one of the Richardson pair, both since removed), so that
    // every palette would read with the same inner/outer separation. Measured
    // inner-minus-outer median luminance on an ideal helix at this value: 58.4
    // for that palette's own two-tone, 57.3 pymol, 52.2 jmol. It has to be
    // this large because the tint competes with an already-light outer face -
    // at 0.40 the others reached only ~30-37, well short of it.
    // Helices only: strand concavity sits AT zero about half the time, so
    // tinting there would pick a side from sign noise and flicker on rotation.
    const RICH_INNER_TINT = 0.68;
    const tintWhite = (c, f) => ({
        r: c.r + (255 - c.r) * f,
        g: c.g + (255 - c.g) * f,
        b: c.b + (255 - c.b) * f,
    });

    // Tangent stencil that makes a cubic Hermite reproduce an ideal helix
    // essentially exactly. A helix is a circle plus a linear rise, and no
    // single scale on the chord (p+1 - p-1) fits both: the chord's circular
    // part has magnitude 2r*sin(theta) (true tangent r*theta, so it needs
    // scale theta/(2 sin theta) ~ 0.886 at the 100 degrees between helix
    // residues) while its axial part is 2c (true tangent c, needing 0.5).
    // Catmull-Rom's 0.5 scallops the circle; 0.886 alone makes the rise
    // overshoot ~77% and the "helix" waves along its axis instead. The
    // two-term stencil a*(p+1 - p-1) + b*(p+2 - p-2) has two coefficients
    // for the two conditions:
    //   axial:    2a + 4b = 1
    //   circular: 2a*sin(theta) + 2b*sin(2*theta) = theta
    const HELIX_THETA = (100 * Math.PI) / 180;   // twist per residue, ideal alpha-helix
    const HSIN1 = Math.sin(HELIX_THETA);
    const HSIN2 = Math.sin(2 * HELIX_THETA);
    const HTAN_B = (HELIX_THETA - HSIN1) / (2 * HSIN2 - 4 * HSIN1); // ~ -0.165
    const HTAN_A = (1 - 4 * HTAN_B) / 2;                            // ~  0.829
    // ONE-SIDED helix-exact stencil for run ends (same circle+rise
    // conditions solved with only forward points): T(0) = a1*(p1-p0) +
    // a2*(p2-p0) + a3*(p3-p0). The centered stencil clamps its missing
    // neighbour at run boundaries, which visibly distorts the terminal
    // interval - noticeable once SSE extension made end residues helical.
    const HT1_A = 1.82814575;
    const HT1_B = -1.2497675;
    const HT1_C = 0.55712975;
    // ... and the matching one-sided CURVATURE stencil (second derivative:
    // axial 0, circular -theta^2), for the side vector at run ends
    const HK1_A = -0.39633845;
    const HK1_B = 2.14477528;
    const HK1_C = -1.29773737;

    /**
     * Catmull-Rom point between p1 and p2 (p0, p3 are neighbours).
     * Vec3 in, array out. Used for loops and nucleic tubes.
     */
    function catmullV(p0, p1, p2, p3, t, o) {
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        o[0] = h00 * p1.x + h10 * 0.5 * (p2.x - p0.x) + h01 * p2.x + h11 * 0.5 * (p3.x - p1.x);
        o[1] = h00 * p1.y + h10 * 0.5 * (p2.y - p0.y) + h01 * p2.y + h11 * 0.5 * (p3.y - p1.y);
        o[2] = h00 * p1.z + h10 * 0.5 * (p2.z - p0.z) + h01 * p2.z + h11 * 0.5 * (p3.z - p1.z);
    }

    /**
     * Cubic Hermite point between p1 and p2 with explicit tangents m1, m2
     * (arrays). Vec3 endpoints in, array out.
     */
    function hermiteV(p1, p2, m1, m2, t, o) {
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        o[0] = h00 * p1.x + h10 * m1[0] + h01 * p2.x + h11 * m2[0];
        o[1] = h00 * p1.y + h10 * m1[1] + h01 * p2.y + h11 * m2[1];
        o[2] = h00 * p1.z + h10 * m1[2] + h01 * p2.z + h11 * m2[2];
    }

    // PAPER. One 128px tile of two-octave value noise, cached on the renderer
    // and multiplied over the finished frame by the coloured-pencil grain pass.
    function paperTile(renderer) {
        if (renderer._pencilTile !== undefined) return renderer._pencilTile;
        if (typeof document === 'undefined') {
            renderer._pencilTile = null;
            return null;
        }
        const TS = 128;
        const tile = document.createElement('canvas');
        tile.width = TS; tile.height = TS;
        const tc = tile.getContext('2d');
        if (tc) {
            // TWO OCTAVES. Paper has a fine tooth AND a coarser
            // unevenness, and a single per-pixel noise gives only the
            // first - it reads as film grain, which stays flat and
            // uniform however strong it is pushed. The low-frequency
            // layer is what makes it look like a sheet of paper: broad
            // patches take slightly more pigment than their neighbours.
            // Wrapped sampling keeps the tile seamless when repeated.
            // Value noise on a wrapping grid, so the tile repeats
            // seamlessly. Grain is built from OCTAVES rather than
            // per-pixel randomness: independent noise at every pixel is
            // film static - it has no scale, so pushing it harder just
            // makes it louder, never more paper-like. Tooth is a
            // clustered thing, a couple of pixels across.
            const lerp = (a, b, t) => a + (b - a) * t;
            const smooth = (t) => t * t * (3 - 2 * t);
            const mkOctave = (G) => {
                const g = new Float32Array(G * G);
                for (let i = 0; i < G * G; i++) g[i] = Math.random();
                return (x, y) => {
                    const gx = (x / TS) * G;
                    const gy = (y / TS) * G;
                    const x0 = Math.floor(gx);
                    const y0 = Math.floor(gy);
                    const fx = smooth(gx - x0);
                    const fy = smooth(gy - y0);
                    const ix = (a, b2) => g[((b2 % G) + G) % G * G
                        + ((a % G) + G) % G];
                    return lerp(lerp(ix(x0, y0), ix(x0 + 1, y0), fx),
                        lerp(ix(x0, y0 + 1), ix(x0 + 1, y0 + 1), fx), fy);
                };
            };
            const mottleAt = mkOctave(8);    // broad paper unevenness
            const toothAt = mkOctave(44);    // ~3 px clusters: the tooth
            const gritAt = mkOctave(96);     // just enough bite on top
            const im = tc.createImageData(TS, TS);
            for (let y = 0; y < TS; y++) {
                for (let x = 0; x < TS; x++) {
                    const i = y * TS + x;
                    const tooth = toothAt(x, y) - 0.5;
                    const grit = gritAt(x, y) - 0.5;
                    const mott = mottleAt(x, y) - 0.5;
                    let v = 232 + tooth * PENCIL_TOOTH
                        + grit * PENCIL_GRIT + mott * PENCIL_MOTTLE;
                    v = v < 120 ? 120 : (v > 255 ? 255 : v);
                    im.data[i * 4] = v;
                    im.data[i * 4 + 1] = v;
                    im.data[i * 4 + 2] = v - 3;   // faintly warm
                    im.data[i * 4 + 3] = 255;
                }
            }
            tc.putImageData(im, 0, 0);
            renderer._pencilTile = tile;
        } else {
            // cache the failure too, or every frame retries the build
            renderer._pencilTile = null;
        }
        return renderer._pencilTile;
    }

    // ------------------------------------------------------------------------
    // Main entry, called by Pseudo3DRenderer._renderToContext when
    // style === 'cartoon'. `colors` is the per-segment color array the main
    // pipeline already computed (respects the full 5-level color hierarchy).
    // ------------------------------------------------------------------------
    function render(renderer, ctx, displayWidth, displayHeight, colors) {
        const _t0 = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        const rotated = renderer.rotatedCoords;   // Vec3, rotated + centered, Angstroms
        const n = renderer.coords.length;
        const segments = renderer.segmentIndices;
        const vs = renderer.viewerState;
        const object = renderer.objectsData[renderer.currentObjectName];
        const positionTypes = renderer.positionTypes;

        // --- projection: identical to the ribbon path so zoom/ortho match ---
        // ...including the extent of what is DRAWN rather than of the current
        // object, which with several merged is a fraction of the picture.
        const framed = (renderer.drawnStats && renderer.drawnStats()) || object;
        const maxExtent = (framed && framed.maxExtent > 0) ? framed.maxExtent : 30.0;
        const effectiveExtent = vs.extent || maxExtent;
        const padding = 0.9;
        const scale = Math.min(
            (displayWidth * padding) / (effectiveExtent * 2),
            (displayHeight * padding) / (effectiveExtent * 2)
        ) * vs.zoom;
        const centerX = displayWidth / 2;
        const centerY = displayHeight / 2;
        // the scale this style actually drew at, so a pan drag can convert
        // screen pixels into Angstroms (see the pan handler in viewer-mol.js)
        renderer._viewScale = scale;
        // AUTO-SUBDIVISION. Detail is a quality control, not a promise to draw
        // curvature finer than the screen can resolve. A residue is CA_STEP_A
        // long, so at this scale it spans CA_STEP_A * scale pixels; splitting it
        // into more than that over SUB_TARGET_PX gains nothing visible and costs
        // a station's worth of work in every pass. It binds only when the
        // structure is SMALL on screen - a single domain at default zoom is
        // ~31px per residue and keeps the full setting - so it is a large-
        // structure and zoomed-out saving, which is where the cost actually is.
        // MIN_SUB still applies underneath: 2 is a hard floor, not a preference.
        subCapCur = Math.max(MIN_SUB, Math.floor((CA_STEP_A * scale) / SUB_TARGET_PX));
        // Emit each ribbon station's frame in MODEL space alongside the
        // projected corners. For consumers that keep the geometry and re-use it
        // at other views; see evalSlab for why a projected drawing is not
        // enough to recover it. Declared HERE, with the other render-scope
        // switches, because evalSlab reads it far above where the shading
        // parameters are set up.
        const frameProbe = !!renderer._frameProbe;
        const persp = (typeof vs.ortho === 'number') ? vs.ortho < 1 : false;
        const fl = vs.focalLength;
        const widthScale = (renderer.lineWidth || 3.0) / 3.0;
        const baseLineWidthPixels = (renderer.lineWidth || 3.0) * scale;

        // Returns [screenX, screenY, z, perspectiveFactor] or null if behind camera.
        const project = (x, y, z) => {
            if (persp) {
                const dz = fl - z;
                if (dz <= 0.1) return null;
                const pe = fl / dz;
                return [centerX + x * scale * pe, centerY - y * scale * pe, z, pe];
            }
            return [centerX + x * scale, centerY - y * scale, z, 1];
        };

        const mask = renderer.visiblePositions;
        const vis = (i) => !mask || mask.has(i);

        // --- partition segments: backbone (drawn as cartoon) vs everything else ---
        // A backbone segment is a consecutive-index polymer segment; explicit
        // bonds, cyclic closures, ligand bonds, contacts and lone-position dots
        // all stay generic and depth-sort against the cartoon.
        const bbSeg = new Int32Array(n).fill(-1);  // residue i -> segment index for (i, i+1)
        const genericSegs = [];
        // HEAD-TO-TAIL CLOSURE (cyclic peptides). viewer-mol.js emits a bond
        // between a chain's first and last polymer residue when they sit within
        // the chainbreak cutoff. It is a real peptide bond, but it is not
        // index-adjacent, so it used to fail the backbone test here and fall
        // through to the generic primitives - the cartoon drew a tube stub
        // across the seam while the ribbon terminated at both ends, and a
        // cyclic peptide read as a linear one with a stick glued on. Held aside
        // and matched against the runs below; a non-adjacent bond that does not
        // close a run exactly (a user-defined bond, say) goes back to generic.
        const closureCand = [];
        for (let s = 0; s < segments.length; s++) {
            const seg = segments[s];
            const isPoly = (seg.type === 'P' || seg.type === 'D' || seg.type === 'R')
                && seg.contactIdx1 === undefined;
            if (isPoly && seg.idx2 === seg.idx1 + 1) bbSeg[seg.idx1] = s;
            else if (isPoly && seg.idx2 > seg.idx1 + 1) closureCand.push(s);
            else genericSegs.push(s);
        }

        // EXPORT PIXEL SCALE. Most sizes here are Angstroms through `scale`, so
        // they follow the output resolution by themselves. A few are pixels by
        // definition - line widths the user set in pixels, and tolerances that
        // ask "do these project to the same spot on screen" - and those have to
        // be multiplied to keep their SCREEN meaning when a 300 dpi export
        // renders the same view three times larger. Without it an export comes
        // out with hairline outlines over a full-size structure.
        const pxScale = renderer._exportPxScale || 1;
        // Outline width follows the outline control, matching the ribbon
        // style: black ink under/between the fills. Declared before the
        // geometry loop because ribbon ink prims are emitted DURING
        // construction (sorted at their own depth).
        // No lower clamp beyond zero-means-off: the control is a width in
        // pixels and fractional widths are meaningful - canvas draws a
        // sub-pixel stroke as a lighter line, which is exactly what a finer
        // outline should look like. A floor of 1 here (with the ink floor
        // below) made the whole bottom half of the slider draw identically,
        // so the outline appeared to stop thinning and then snap off at 0.
        // THE OUTLINE SCALES WITH ZOOM, like everything else in the drawing.
        // The ribbon's own width is baseLineWidthPixels = lineWidth * scale, and
        // `scale` carries vs.zoom - so zooming out shrank the ribbon while the
        // outline stayed a fixed pixel width, and the ink took over the drawing
        // until a zoomed-out structure read as a mass of black. Anchored at
        // zoom 1, which is the fit-to-view scale, so the default look is
        // unchanged and only zooming away from it moves the weight.
        //
        // Clamped, and ASYMMETRICALLY, because the two failure modes are not
        // the same size. Zoomed out, a fixed-width outline swamps a shrinking
        // ribbon and the drawing turns into a mass of ink - that is the fault
        // being fixed, so real thinning is allowed, down to about a third.
        // Zoomed in, a fixed outline is merely a little fine, and following the
        // ribbon all the way up turns a drawn LINE into a band: 3 px would
        // reach 7.5 at 2.5x. So growth stops at 1.5x.
        //
        // KEPT, deliberately, when the thickness fade below was removed. They
        // look like the same thing and are not: this keeps the outline in
        // PROPORTION to a ribbon that is itself shrinking, so the drawing holds
        // its balance. The thickness fade changed the ribbon's actual geometry
        // - the same setting drew a solid slab or a flat strip depending on how
        // big the file was - which is a different fault.
        const zoomW = Math.max(0.35, Math.min(1.5,
            (renderer.viewerState && renderer.viewerState.zoom) || 1));
        // Ink the ring where a side chain meets the backbone? No, by default -
        // see scBase in the stick builder for why.
        const baseInk = renderer.cartoonBaseInk === true;
        const outlineW = renderer.outlineMode !== 'none'
            ? (renderer.relativeOutlineWidth === 0
                ? 0 : (renderer.relativeOutlineWidth || 3) * pxScale * zoomW)
            : 0;
        // HAND-DRAWN BUILD-UP. Null on every normal render, so all of this
        // costs one property read. When the drawing animation is running
        // (animateDrawing, viewer-mol.js) it carries how far each MEDIUM has
        // got, as a position along the chain in 0..1, plus how strongly to
        // paint it. Three layers in the order an illustrator works: graphite
        // under-drawing, colour wash over it, ink line last.
        // Chain position rather than depth or screen position is what makes it
        // read as drawing rather than as a wipe: the hand follows the molecule.
        let anim = renderer._drawAnim || null;
        if (anim) {
            // A HAND DOES NOT MOVE AT A CONSTANT RATE. It runs along a straight
            // stretch and slows right down through a tight turn, because a turn
            // is where the line can go wrong. So the layers' progress values
            // arrive here as fractions of TIME and are converted to positions
            // along the chain through the local curvature - which is why this
            // lives in the renderer and not in the animation driver: the driver
            // knows how long the run is, and nothing at all about the shape.
            //
            // Cost per residue is 1 + PACE_CURVE x (turn angle / pi), summed
            // along the chain; the hand is at the point where the running cost
            // reaches its share of the total. Chain breaks are skipped rather
            // than read as an infinitely tight corner - two chains a long way
            // apart in space are not a turn of the pen.
            // Curvature of the SMOOTHED trace, not of the raw CA zigzag. The
            // pen follows the drawn ribbon, which is a spline through the
            // trace, and on the raw trace a helix turns about 89 degrees at
            // EVERY residue - so measuring it directly makes every helix a
            // tight corner and the whole structure uniformly slow. Averaged
            // over a few residues the helix becomes what it looks like on the
            // page, a long smooth sweep, and what stands out as a real corner
            // is a turn between elements.
            const sm = new Float64Array(n * 3);
            for (let i = 0; i < n; i++) {
                let sx = 0; let sy = 0; let sz = 0; let cnt = 0;
                for (let j = i - PACE_SMOOTH; j <= i + PACE_SMOOTH; j++) {
                    const q = rotated[j < 0 ? 0 : (j >= n ? n - 1 : j)];
                    if (!q) continue;
                    sx += q.x; sy += q.y; sz += q.z; cnt++;
                }
                if (!cnt) cnt = 1;
                sm[i * 3] = sx / cnt; sm[i * 3 + 1] = sy / cnt; sm[i * 3 + 2] = sz / cnt;
            }
            const cum = new Float64Array(n);
            let acc = 0;
            for (let i = 0; i < n; i++) {
                let ang = 0;
                if (i > 0 && i + 1 < n) {
                    const ux = sm[i * 3] - sm[(i - 1) * 3];
                    const uy = sm[i * 3 + 1] - sm[(i - 1) * 3 + 1];
                    const uz = sm[i * 3 + 2] - sm[(i - 1) * 3 + 2];
                    const vx = sm[(i + 1) * 3] - sm[i * 3];
                    const vy = sm[(i + 1) * 3 + 1] - sm[i * 3 + 1];
                    const vz = sm[(i + 1) * 3 + 2] - sm[i * 3 + 2];
                    const lu = Math.sqrt(ux * ux + uy * uy + uz * uz);
                    const lv = Math.sqrt(vx * vx + vy * vy + vz * vz);
                    if (lu > 0.05 && lv > 0.05
                        && lu < PACE_BREAK_A && lv < PACE_BREAK_A) {
                        const d = (ux * vx + uy * vy + uz * vz) / (lu * lv);
                        ang = Math.acos(Math.max(-1, Math.min(1, d)));
                    }
                }
                acc += PACE_FLOOR + PACE_CURVE * (ang / Math.PI);
                cum[i] = acc;
            }
            // time fraction -> position along the chain, by binary search on
            // the running cost
            const paceU = (f) => {
                if (!(f > 0)) return 0;
                if (f >= 1 || acc <= 0 || n < 2) return 1;
                const want = f * acc;
                let lo = 0;
                let hi = n - 1;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (cum[mid] < want) lo = mid + 1; else hi = mid;
                }
                const prev = lo > 0 ? cum[lo - 1] : 0;
                const frac = cum[lo] > prev ? (want - prev) / (cum[lo] - prev) : 0;
                return Math.min(1, (lo + frac) / (n - 1));
            };
            // A copy: the driver's object is the timeline, this is the same
            // timeline read through the shape of this particular molecule.
            anim = { sketch: paceU(anim.sketch), wash: paceU(anim.wash) };
        }
        // Where a piece sits along the chain, 0..1. Only ribbons and ink curves
        // carry a chain coordinate; ligands, base plates and lone atoms do not,
        // and 1 puts them at the END, which is where the details of a drawing
        // go anyway.
        // CLAMPED AT 1. The interval that closes a CYCLIC chain runs from the
        // last residue back to the first, so its stations carry gs0 values
        // PAST the end of the chain - n-1 and a bit. Unclamped they never
        // satisfy `<= 1`, so the piece joining C back to N was skipped at every
        // point of the run, including the finished painting: a cyclic peptide
        // came out drawn as an open arc.
        const chainU = (g) => (g.gs0 === undefined
            ? 1 : Math.min(1, g.gs0 / Math.max(1, n - 1)));
        // Pencil state. anim.sketch is where the drawing hand has got to.
        const sketching = !!(anim && anim.sketch > 0);
        const sketchMax = sketching ? anim.sketch : 0;
        const sketchSegs = [];   // x1,y1,x2,y2,u,curveId,station per segment
        // Deterministic wobble, keyed to WHERE ON THE MOLECULE a point is
        // rather than to time. A hand is unsteady, but it is unsteady in one
        // fixed way per drawing - jitter reseeded per frame is a boiling
        // outline, which reads as video noise rather than as pencil.
        const wobble = (a, b) => {
            const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
            return h - Math.floor(h) - 0.5;
        };
        // The ink pass strokes at a fraction of the outline width - the band
        // under the fills carries the weight, the ink only has to close it.
        // The floor exists so a hairline cannot vanish entirely; it is far
        // below any useful setting and, being a floor on a fraction, it never
        // makes a line thicker than the outline the user asked for.
        const gestureInk = renderer.cartoonGestureInk;
        const INK_GESTURE_MS = (typeof gestureInk === 'number') ? gestureInk : 25;
        // how far back under the budget the cost has to fall before the outline
        // comes back - see the hysteresis note at dropInk
        const INK_RESTORE_FRAC = 0.7;
        // inked frames needed before the degrade may fire at all
        const INK_MIN_SAMPLES = 3;
        // What a full frame costs relative to a bare one, until this structure
        // has been measured both ways. Measured at 900px: 1TIM 1.6x, 3A3A 2.3x,
        // 1BNA 2.6x. Guessing here only costs a frame - if the guess is low the
        // outline comes back, gets measured, and goes off again with the real
        // number; if it is high the outline stays off one gesture longer.
        const INK_COST_RATIO_DEFAULT = 2.0;
        const gesturing = !!(renderer.isDragging || renderer.isZooming);
        // the pencil is TRACED from the ink pass, so a sketch must keep it
        // HYSTERESIS. A structure whose cost sits near the budget would
        // otherwise flip between drags - outline on, outline off, outline on -
        // which reads as the viewer being unreliable rather than as it adapting.
        // Once dropped, the outline stays dropped until the cost falls clearly
        // back under; once kept, it is kept until the cost clearly exceeds.
        // Kept on its OWN field rather than reusing _inkSkipped: viewer-mol
        // clears that one on every settle, which would reset the hysteresis
        // between gestures - exactly where the flip-flop is visible.
        // WHAT A FULL-QUALITY FRAME WOULD COST RIGHT NOW. While the outline is
        // off there is no inked frame to measure, so it is estimated from the
        // bare frame that IS being measured every frame, times what the ink is
        // known to cost on this structure. That is what lets the outline come
        // back mid-gesture once the machine has warmed up, instead of the
        // decision standing on a measurement taken before it was made.
        let inkCost = renderer._lastInkedMs || 0;
        if (renderer._inkDegraded && renderer._lastBareMs !== undefined) {
            inkCost = renderer._lastBareMs
                * (renderer._inkRatio || INK_COST_RATIO_DEFAULT);
        }
        // ENOUGH SAMPLES TO HAVE AN OPINION. With one sample the "minimum of
        // five" is that one sample, and the first inked frame of a drag is a
        // warm-up: on 1TIM it costs 34 ms where every frame after it costs 11.
        // Degrading on it latched the outline off for the whole gesture, and
        // nothing could correct it - while the ink is off, no new sample is
        // taken. Waiting for three lets the warm-up be outvoted, and a
        // structure that really is slow simply degrades three frames later.
        const inkSamples = renderer._inkedMs ? renderer._inkedMs.length : 0;
        const dropInk = gesturing && !anim && gestureInk !== false
            && inkSamples >= INK_MIN_SAMPLES
            && (renderer._inkDegraded
                ? inkCost > INK_GESTURE_MS * INK_RESTORE_FRAC
                : inkCost > INK_GESTURE_MS);
        if (gesturing) renderer._inkDegraded = dropInk;
        // read by viewer-mol.js, which re-renders once the gesture settles -
        // otherwise the last degraded frame is what stays on screen
        renderer._inkSkipped = dropInk;
        const inkW = Math.max(INK_W_MIN * pxScale, outlineW * INK_W_MUL);
        // NO INK ANYWHERE WHILE A DRAWING IS UP, OR WHILE A GESTURE HAS DROPPED
        // IT. Switching the ink PASS off is not enough: ink is also laid down in
        // the paint loop, as the rim across the end of an element, the outline
        // under a tube or a ligand bond, and the long edges of a base plate.
        // Those kept drawing through the watercolour - most visibly as a dark
        // line across the tip of every strand, which is where a cap rim is.
        //
        // The gesture degrade had exactly the same hole, and in the same places:
        // a strand's C-terminal arrow and every nucleic base plate kept their
        // outlines through a rotation while the ribbon around them lost theirs,
        // so the drawing came apart into outlined and un-outlined halves rather
        // than simply going quieter. dropInk is decided above this line for that
        // reason.
        //
        // Selection ink is not ink in this sense and is exempt from the drawing
        // case: it is an indicator and has to stay legible.
        const paintInkW = (anim || dropInk) ? 0 : outlineW;
        // SELECTION INK. The selected residues are outlined using the ink pass
        // itself rather than a separate overlay: the silhouette machinery
        // already knows the exact contour of every element, so re-colouring its
        // curves gives an outline that hugs the ribbon for free, in the right
        // depth order, and in SVG export too.
        // Width is a CONSTANT, not the style's outline width: this is a UI
        // indicator, so at outline 0 it must still appear and at a heavy setting
        // it must not swamp the structure it points at.
        // NO IN-GEOMETRY SELECTION INK. The selection used to be inked into the
        // prims and depth-sorted with them, so a selected residue on the far
        // side of the molecule was covered by everything in front of it -
        // exactly the case you need it for. It is painted as a translucent band
        // over the finished frame instead: see _paintSelectionHalo in
        // viewer-mol.js, which the draw calls once this returns.
        //
        // Kept as a null rather than torn out: the `sel` flag it sets threads
        // through the prim builders, the merge test and both paint passes, and
        // this is the hottest code in the renderer. One switch, dead by
        // construction, until the ink path is removed in its own change.
        const selInk = null;
        const SELECTION_INK_CSS = 'rgb(255, 190, 0)';
        // absolute stroke width here, unlike viewer-mol.js's
        // SELECTION_INK_EXTRA, which is ADDED to the line width.
        //
        // ...AND IT FOLLOWS THE ZOOM, like every other ink width in this pass
        // (zoomW, above). Flat, it is the one part of a selection mark that
        // does not shrink with the thing it marks, and on a LONE ATOM that is
        // the whole mark: a zinc is 1.7 px at zoom 0.25 and this rim was 2.5,
        // so the ball plus its rim came to 4.2 px - which is exactly where the
        // selection band's outer edge falls. Measured, the visible band around
        // a selected metal was 6.5 px at the default view, 2.0 at half zoom
        // and 0.0 at a quarter: the highlight stopped tracking the atom on the
        // way out, because a constant cannot track anything. Scaled, the ring
        // holds at 0.87-1.03 x the ball's radius from zoom 0.25 to 4.
        const SELECTION_INK_WIDTH = 2.5 * pxScale * zoomW;
        // ... which also means the ink pass has to RUN when the outline is off
        // but something is selected.
        // The pencil is traced from the ink pass's own visibility (see the
        // sketch collection there), so that pass has to RUN while a drawing is
        // being sketched even if the style has no outline at all.
        // DROP THE OUTLINE WHILE A GESTURE IS IN FLIGHT, on big structures.
        // Measured with the ink pass on and off, interleaved, minimum of 9:
        //   1k residues 20.8 -> 7.4 ms, 3k 32.3 -> 14.8, 8k 96.4 -> 41.9,
        //   20k 253.7 -> 109.5. The outline is 55-64% of the frame throughout,
        //   so this is a 2.2-2.8x speedup and nothing else comes close.
        //
        // This was deliberately REMOVED once before, because switching quality
        // mid-drag changes the drawing and snaps back when you stop, which
        // reads as the render breaking rather than adapting. That objection is
        // real and the threshold is the answer to it: below it nothing changes,
        // and it is set where the frame is already past ~2x the 60fps budget -
        // at which point the drag is visibly stuttering anyway, and a stable
        // drawing nobody can turn smoothly is the worse trade.
        //
        // THE TRIGGER IS THE MEASURED COST, not the size of the structure. A
        // segment count is a bad proxy for it: 5H0R draws 1736 segments in
        // 40 ms while 4HHB draws 738 in 15 ms, so any count that catches the
        // first also catches structures that never needed help. Cost also
        // accounts for canvas size, detail and the machine, none of which a
        // count knows about.
        //
        // renderer.cartoonGestureInk = false turns the degrade off; a NUMBER
        // sets the budget in milliseconds.
        const inkWanted = (outlineW || !!selInk || !!anim) && !dropInk;
        renderer._inkRan = inkWanted;
        // Edge candidates for the ink pass (hull silhouette + crease edges)
        const inkCurves = [];
    // THE SILHOUETTE OF A SLAB STRIP, as ink prims. Lifted out of the ribbon
    // interval so the nucleic RUNGS can use it too: a rung is the same shape - a
    // slab swept along a path - and hand-rolling a second outline for it is what
    // left the base edges dashed, every subdivision cut being a place for the
    // line to break. It needs only the four corner curves and the facing terms,
    // so anything that can build those gets the ribbon's own outline.
    // `outerOnly` picks the extreme-corner rule (corners extreme across the
    // chain) over the hull rule. A rung passes TRUE - see its call site: a base plate
    // carries no inner line either.
    //
    // IT IS NOT ONLY LOOPS ANY MORE. The rule was written for them - a square
    // loop's crease runs a hair inside the silhouette and reads as a doubled
    // line rather than as structure - but the same is true of every ribbon
    // outside richardson. Richardson is the style whose slabs are meant to read
    // as solids, and it is the only one the WebGL2 port inks creases for
    // (fullOutline = rich && ss === 'E'); the other presets keep their
    // interiors clean. Passing `squareLoop || !rich` here is what makes the two
    // renderers agree about that.
    const emitSlabInk = (Lp, Lm, Rp, Rm, oN, oB, oK, col, selFlag, gs0In,
        outerOnly, isBackbone) => {
                        const nsF = Lp.length;
                        const curves = [Lp, Lm, Rp, Rm];
                        const visC = [[], [], [], []];
                        // SILHOUETTE BY CONVEX HULL: per segment, project the
                        // eight corner points (4 corners x 2 stations); a
                        // corner is silhouette iff one of its points lies on
                        // (or within ~1px of) the hull of those eight. This
                        // is orientation-free - a single-axis extreme test
                        // (perpendicular to the chain direction) misses the
                        // boundary on TWISTING DIVES, where the silhouette
                        // wraps around the piece; the hull cannot. Interior
                        // crease corners are never on the hull, so no inner
                        // line.
                        const hx = new Array(8);
                        const hy = new Array(8);
                        const cross = (ox, oy, ax, ay, bx, by) =>
                            (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
                        for (let s = 0; s + 1 < nsF; s++) {
                            for (let c = 0; c < 4; c++) {
                                hx[c * 2] = curves[c][s][0];
                                hy[c * 2] = curves[c][s][1];
                                hx[c * 2 + 1] = curves[c][s + 1][0];
                                hy[c * 2 + 1] = curves[c][s + 1][1];
                                visC[c].push(false);
                            }
                            // monotone chain on 8 points (indices sorted)
                            const idx = [0, 1, 2, 3, 4, 5, 6, 7];
                            idx.sort((a, b) => (hx[a] - hx[b]) || (hy[a] - hy[b]));
                            const hull = [];
                            for (const iP of idx) {
                                while (hull.length >= 2 && cross(
                                    hx[hull[hull.length - 2]], hy[hull[hull.length - 2]],
                                    hx[hull[hull.length - 1]], hy[hull[hull.length - 1]],
                                    hx[iP], hy[iP]) <= 0) hull.pop();
                                hull.push(iP);
                            }
                            const lower = hull.length + 1;
                            for (let k = idx.length - 2; k >= 0; k--) {
                                const iP = idx[k];
                                while (hull.length >= lower && cross(
                                    hx[hull[hull.length - 2]], hy[hull[hull.length - 2]],
                                    hx[hull[hull.length - 1]], hy[hull[hull.length - 1]],
                                    hx[iP], hy[iP]) <= 0) hull.pop();
                                hull.push(iP);
                            }
                            hull.pop();
                            // mark corners whose points are on or near the
                            // hull boundary (near-tie: coincident twins)
                            const TOL2 = (1.5 * pxScale) * (1.5 * pxScale);
                            for (let c8 = 0; c8 < 8; c8++) {
                                let on = false;
                                for (let h = 0; h < hull.length && !on; h++) {
                                    const a = hull[h];
                                    if (a === c8) { on = true; break; }
                                    const b = hull[(h + 1) % hull.length];
                                    const abx = hx[b] - hx[a];
                                    const aby = hy[b] - hy[a];
                                    const L2 = abx * abx + aby * aby;
                                    let t = L2 > 1e-9
                                        ? ((hx[c8] - hx[a]) * abx + (hy[c8] - hy[a]) * aby) / L2
                                        : 0;
                                    if (t < 0) t = 0;
                                    else if (t > 1) t = 1;
                                    const ex = hx[a] + t * abx - hx[c8];
                                    const ey = hy[a] + t * aby - hy[c8];
                                    if (ex * ex + ey * ey <= TOL2) on = true;
                                }
                                if (on) visC[c8 >> 1][s] = true;
                            }
                            // CREASE EDGES: an edge whose adjacent SIDE
                            // face clearly faces the viewer (the up/down
                            // thickness band at a helix flank) or whose
                            // OUTER face does (concavity-gated so the inner
                            // face's rim does not add hook noise). These sit
                            // exposed on the side of the ribbon - they were
                            // never candidates in the hull-only build.
                            const nMid = (oN[s] + oN[s + 1]) / 2;
                            const bMid2 = (oB[s] + oB[s + 1]) / 2;
                            const kMid = (oK[s] + oK[s + 1]) / 2;
                            const CE = 0.25;
                            const topOuter = bMid2 > CE && kMid <= 0.15;
                            const botOuter = bMid2 < -CE && kMid >= -0.15;
                            if (nMid > CE || topOuter) visC[0][s] = true;
                            if (nMid > CE || botOuter) visC[1][s] = true;
                            if (nMid < -CE || topOuter) visC[2][s] = true;
                            if (nMid < -CE || botOuter) visC[3][s] = true;
                            // LOOPS: OUTER LINES ONLY. A slab seen at an angle
                            // puts three lines on screen - the two silhouette
                            // edges, plus the crease where the visible wide
                            // face meets the visible side face. On a helix or
                            // strand that crease is worth drawing: it is what
                            // separates a wide face from its thin edge. On a
                            // loop it is not. The section is square at the
                            // defaults (0.35 A half-side either way), so the
                            // crease runs a hair inside the silhouette and
                            // reads as a doubled line rather than as structure.
                            // Keeping only the corners that are EXTREME across
                            // the chain leaves the silhouette exact and the
                            // crease unlined, carried by shading alone.
                            //
                            // Gated on squareLoop rather than on ssCls: a
                            // transition interval is BUILT as a loop but is
                            // classed 'H' next to a helix (see ssCls - the
                            // helix wins its transitions so the spiral is not
                            // cut a residue early), and the question here is
                            // geometric, not what colour the interval takes.
                            //
                            // Extremes are taken at EACH station and unioned,
                            // which normally keeps 2 corners and keeps 3 across
                            // a handoff - where the outer edge passes from the
                            // top corner to the bottom one. A single winner per
                            // segment unlines the incoming curve for exactly
                            // the segment in which it becomes the silhouette,
                            // which shows as a nick in the outer line at every
                            // turn. No tolerance on the comparison: a handoff
                            // mid-step already reads as two different winners
                            // at the two ends, so a tolerance adds nothing but
                            // corners a pixel inside the edge, and those stroke
                            // as the second line this is here to remove.
                            if (outerOnly) {
                                // Across-chain direction: the segment's mean
                                // step, turned 90 degrees. Unnormalised - only
                                // the ORDER of the projections matters.
                                let mx0 = 0; let my0 = 0; let mx1 = 0; let my1 = 0;
                                for (let c = 0; c < 4; c++) {
                                    mx0 += curves[c][s][0]; my0 += curves[c][s][1];
                                    mx1 += curves[c][s + 1][0]; my1 += curves[c][s + 1][1];
                                }
                                const perpX = (my0 - my1) / 4;
                                const perpY = (mx1 - mx0) / 4;
                                // Chain running at the viewer: the step projects
                                // to under a hundredth of a pixel and "across"
                                // is undefined, so leave the hull's answer -
                                // which needs no chain direction - in place.
                                if (perpX * perpX + perpY * perpY > 1e-4) {
                                    const v0 = new Array(4);   // offset at s
                                    const v1 = new Array(4);   // offset at s+1
                                    let hi0 = -Infinity; let lo0 = Infinity;
                                    let hi1 = -Infinity; let lo1 = Infinity;
                                    for (let c = 0; c < 4; c++) {
                                        const a = curves[c][s][0] * perpX
                                            + curves[c][s][1] * perpY;
                                        const b = curves[c][s + 1][0] * perpX
                                            + curves[c][s + 1][1] * perpY;
                                        v0[c] = a; v1[c] = b;
                                        if (a > hi0) hi0 = a;
                                        if (a < lo0) lo0 = a;
                                        if (b > hi1) hi1 = b;
                                        if (b < lo1) lo1 = b;
                                    }
                                    for (let c = 0; c < 4; c++) {
                                        // >= and <=, so exact ties keep both
                                        const keep = v0[c] >= hi0 || v1[c] >= hi1
                                            || v0[c] <= lo0 || v1[c] <= lo1;
                                        if (!keep) visC[c][s] = false;
                                    }
                                }
                            }
                        }

                        for (let c = 0; c < 4; c++) {
                            let any = false;
                            for (let s = 0; s < visC[c].length; s++) {
                                if (visC[c][s]) { any = true; break; }
                            }
                            if (any) {
                                inkCurves.push({
                                    // stable identity for the pencil's wobble,
                                    // so its wander does not reshuffle between
                                    // frames of the same view
                                    id: inkCurves.length,
                                    pts: curves[c],
                                    vis: visC[c],
                                    sel: selFlag,
                                    gs0: gs0In,
                                    gsStep: 1 / Math.max(1, nsF - 1),
                                    // WHOSE OUTLINE THIS IS. The ink curves are
                                    // collected here, nowhere near the prim list
                                    // the backbone switch filters, so without
                                    // this hiding the backbone left its outline
                                    // drawn over empty paper - the same shape of
                                    // bug the clip had. A nucleic RUNG comes
                                    // through the same emitter and is not
                                    // backbone: it is that residue's side chain.
                                    bb: isBackbone ? 1 : 0,
                                    c: col,
                                });
                            }
                        }
    };

        // The Shade slider sets how much directional shading is applied:
        // 0 = flat colour, 1 = full modelling. It replaced an on/off switch,
        // and every lighting term below already had a neutral value it returned
        // when the switch was off - so the slider is just a blend toward that
        // same neutral, and 0 reproduces the old "off" exactly.
        const shadeAmt = (() => {
            const v = Number(renderer.cartoonShade);
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : SHADE_DEFAULT;
        })();
        // kept as a gate for the branches that switch technique rather than
        // scale a value (banded tubes, which need a minimum contrast to read)
        const lightOn = shadeAmt > 0.001;
        // Blend any lighting factor toward 1 (unshaded) by the slider amount.
        // Applied at each term's return rather than to the final colour so that
        // terms which multiply each other stay consistent with one another.
        const soft = (v) => 1 + (v - 1) * shadeAmt;
        // Nucleic tunables, overridable from the GUI; each falls back to the
        // fitted constant when unset.
        const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
        // per-residue ribbon frame for nucleic runs, shared with the plates
        const naFrames = {};
        if (renderer._naDebug) {
            renderer._naFrame = {}; renderer._naTwist = []; renderer._naAxis = [];
        }
        const naWidthA = numOr(renderer.cartoonNaWidth, NA_HALF_A);
        const naPlateWA = numOr(renderer.cartoonNaPlateW, NA_PLATE_W);
        // WHAT THE NUCLEIC SLAB ACTUALLY CAME OUT AS, recorded by the ribbon
        // run below and read by the rungs. The rung starts where the rail's face
        // is, so it needs the rail's REAL half-thickness, which under some
        // paths came from thickScaleRaw rather than from naHalfT at all. (It
        // also used to differ by the screen-space thickness fade, which is now
        // gone.) Two independent numbers meant the rung started at one offset
        // while the rail's face was at another: the plates sat off the backbone
        // until the Thickness slider was touched, at which point the two
        // happened to agree again and everything jumped into place.
        let naSlabHalfT = null;
        // WHERE EACH BASE PLATE IS ON SCREEN, so a click can land on one. The
        // pick otherwise only knows the backbone segments, and a rung reaches
        // several Angstrom away from those - clicking a plate either missed or
        // picked whatever backbone happened to be nearest. One entry per HALF,
        // tagged with that half's own residue, so a click selects the base it
        // is over and not its partner across the pair.
        renderer._naPick = [];
        // half-thickness for everything nucleic - both rails and rungs
        const naHalfT = (() => {
            const t = renderer.cartoonThickness;
            if (renderer._thicknessUserSet && t !== undefined) return t / 2;
            if (t === 0) return 0;                // a preset that wants it flat
            return NA_THICK_DEFAULT / 2;
        })();
        // TONE is the facing ramp: it pales grazing surfaces toward the paper.
        // That is a brightness cue like the lum terms, so it has to switch off
        // with the light too - otherwise shadow-off still shows a pale rim
        // along every helix edge (faces graze there, and sides/caps sit at a
        // constant 0.72). Flat light means flat tone: 1 everywhere.
        const FLAT_TONE = 0.72;
        const edgeTone = () => soft(FLAT_TONE);
        {
            const fd = Number(renderer.cartoonFade);
            const fadeAmt = Number.isFinite(fd)
                ? Math.min(1, Math.max(0, fd)) : FADE_DEFAULT;
            depthFloorCur = 1 - fadeAmt;
            inkFloorCur = 1 - fadeAmt * INK_FADE_SCALE;
            const dark = renderer.backgroundColor === '#000000';
            PAPER = dark ? [0, 0, 0] : [255, 255, 255];
            INK_BASE = dark ? 255 : 0;
            OUTLINE_CSS = dark ? 'rgb(255,255,255)' : 'rgb(0,0,0)';
            SKETCH_CSS = dark ? SKETCH_ON_BLACK : SKETCH_ON_WHITE;
        }
        // Detail is capped at the TUNED value (0.5) rather than at 2. Above it
        // the sampling only adds stations - and therefore cost, since fills
        // scale as stations x surfaces - without changing what the curves look
        // like, so the upper range was expense with nothing to show for it. The
        // slider tops out here too, so the control spans the range that
        // actually differs.
        const dRaw = Number(renderer.cartoonDetail);
        const dN = Number.isFinite(dRaw) && dRaw > 0
            ? Math.min(DETAIL_MAX_N, Math.max(DETAIL_MIN_N, Math.round(dRaw)))
            : DETAIL_DEFAULT_N;
        detailCur = dN / 8;
        // LOOP STYLE. 'tube' (default) is the original stroked round tube.
        // 'square' routes loops through the SAME slab pipeline as helices and
        // strands, with width == thickness so the cross-section is square.
        // The slab path has no joint artifacts by construction: neighbouring
        // intervals share their boundary stations exactly, edges stroke as
        // continuous polylines, and the silhouette comes from the ink pass
        // rather than from overlapping round caps. The tube code below is
        // left intact and is still what runs in 'tube' mode.
        // Escape hatch only - NOT a supported option and not in the UI or
        // the Python API. renderer._loopStyle = 'tube' | 'square' restores
        // the two earlier loop treatments for comparison; anything else (the
        // default) uses the continuous profiled strip.
        // Richardson preset: per-SS width AND thickness, plus strand
        // arrowheads. Everything else on this path is shared with the default
        // cartoon, so the preset is a profile change, not a second renderer.
        const rich = renderer.cartoonRichardson === true;
        // Strand arrowheads are the standard convention, so they are on for
        // every cartoon, not just the Richardson preset. Head length is a fixed
        // arc length (half a CA-CA step) and its width scales off the strand's
        // own width, so it lands correctly whichever style's profile is in use.
        const arrowsOn = renderer.cartoonArrows !== false;
        // colour-by-secondary-structure needs per-interval handling below
        const ssColor = (renderer._getEffectiveColorMode
            ? renderer._getEffectiveColorMode() : renderer.colorMode) === 'ss';
        const ssPal = ssPaletteOf(renderer);
        // Does this object carry any explicit per-position/chain colour? Gates
        // the per-interval override lookup below so structures without manual
        // colouring pay nothing for the feature.
        const hasColorOverrides = (() => {
            // ANY drawn object's - the fast path below is skipped for the whole
            // picture, and a second object's per-position colours are just as
            // real as the current one's.
            const names = renderer.drawnObjects ? renderer.drawnObjects()
                : [renderer.currentObjectName];
            for (const nm of names) {
                const c = (renderer.objectsData && renderer.objectsData[nm] || {}).color;
                if (c && c.type === 'advanced' && c.value
                    && (c.value.position || c.value.chain)) return true;
            }
            return false;
        })();
        const legacyLoop = renderer._loopStyle;
        const loopSquare = legacyLoop === 'square';
        // 'continuous': the whole protein backbone is ONE strip whose
        // half-width and half-thickness are a PROFILE along the chain - full
        // ribbon width through helices and strands, narrow and square through
        // loops, blended across the transition. There are then no element
        // boundaries at all, so the junction stubs, end caps and type
        // switching that every other style has to reconcile simply do not
        // exist. 'square' keeps a constant width per interval; 'tube' is the
        // original stroked loop.
        const loopCont = legacyLoop !== 'tube' && legacyLoop !== 'square';
        // INK QUALITY. The exact hidden-line pass always runs; there is no
        // automatic downgrade. Gesture-based switching used to drop the outline
        // and clamp detail on large structures, which is a real speedup but
        // CHANGES THE DRAWING mid-drag and snaps back when you stop - that
        // reads as the render breaking rather than as adapting.
        // renderer._quality = 'fast' still selects the cheap painter ink
        // explicitly, for anyone who wants the frame rate on a huge complex.
        const perfectInk = renderer._quality !== 'fast';

        // Contiguous runs of backbone. bbSeg[i] connects i to i+1, so a run
        // that stops having segments at i still INCLUDES residue i.
        const runs = [];
        let runStart = -1;
        for (let i = 0; i < n; i++) {
            if (bbSeg[i] >= 0) {
                if (runStart < 0) runStart = i;
            } else if (runStart >= 0) {
                runs.push([runStart, i]);
                runStart = -1;
            }
        }
        // A run is CYCLIC when a closure bond joins exactly its two ends.
        // Matching on both ends rather than on either one keeps an unrelated
        // long-range bond from silently turning a chain into a ring.
        const runClose = new Int32Array(runs.length).fill(-1);
        if (closureCand.length) {
            const byEnds = new Map();
            for (const s of closureCand) {
                byEnds.set(`${segments[s].idx1},${segments[s].idx2}`, s);
            }
            for (let r = 0; r < runs.length; r++) {
                const k = `${runs[r][0]},${runs[r][1]}`;
                if (byEnds.has(k)) { runClose[r] = byEnds.get(k); byEnds.delete(k); }
            }
            // whatever did not close a run is still an ordinary bond to draw
            for (const s of byEnds.values()) genericSegs.push(s);
        }
        // the cyclic runs, shared by the SS pass and the sheet-frame pass
        const ringRuns = [];
        for (let r = 0; r < runs.length; r++) {
            if (runClose[r] >= 0) ringRuns.push(runs[r]);
        }

        // --- secondary structure, cached per object/frame ---
        // Distances are rotation-invariant, so this never changes with the view.
        // guarded like secForColor below: render can run before overlayState exists
        // ...keyed on WHICH objects are in the array as well as which frame:
        // shown-set changes keep the object name and can keep the position
        // count, and a cached assignment from the other set is a structure
        // drawn with somebody else's helices.
        const secKey = secCacheKey(renderer, n);
        //
        // The assignment runs over the WHOLE structure at once rather than per
        // run: sheets pair strands from different chains, and a hydrogen bond
        // does not care that its two ends were parsed as separate segments. The
        // bridge partners come back with it, and are the sheet ladders. What it
        // is told, below, is which residues are one POLYMER and which may bond
        // at all - two different questions, and neither of them "same chain".
        // DID THIS FRAME PAY THE ONE-OFF BUILD? Secondary structure, base
        // pairing and sheet frames are cached on secKey, which a gesture never
        // changes - so the frame that rebuilds them costs several times what
        // every following frame costs, and that cost will never be paid again
        // during the drag. It must NOT be timed as if it were a normal frame:
        // see the record at the end of render().
        let cacheRebuilt = false;
        let sec = renderer._cartoonSec;
        let ladders = renderer._cartoonLadder;
        if (!sec || renderer._cartoonSecKey !== secKey) {
            if (renderer._cartoonSecKey !== secKey) cacheRebuilt = true;
            // A merged view has more than one structure in `coords` at once -
            // every frame of a trajectory in overlay mode, or several objects
            // side by side - so the source each position came from is handed
            // over as a bonding group: a residue may only bond within its own.
            const groupSrc = renderer.sourceGroups ? renderer.sourceGroups() : null;
            const ovMap = (groupSrc && groupSrc.length === n) ? groupSrc : null;
            // Which residues are actually one polymer, taken from the segments
            // the file gave us rather than guessed from distance. Runs are
            // already this: bbSeg[i] connects i to i+1.
            const linkId = new Int32Array(n).fill(-1);
            for (let r = 0; r < runs.length; r++) {
                for (let i = runs[r][0]; i <= runs[r][1]; i++) linkId[i] = r;
            }
            const assigned = assignSecondary(renderer.coords, n, positionTypes,
                { names: renderer.positionNames, rings: ringRuns,
                    groups: ovMap, links: linkId });
            sec = applySse(assigned.sec, renderer);
            ladders = assigned.ladders;
            renderer._cartoonSec = sec;
            renderer._cartoonSecKey = secKey;
            renderer._cartoonLadder = ladders;
            renderer._cartoonLadderKey = secKey;
        }
        if (!ladders || renderer._cartoonLadderKey !== secKey) ladders = [];
        // Base frames, predicted from the C4' trace - see predictBaseFrames.
        // Nothing per-nucleotide is stored or shipped: the trace is the input.
        const naNames = renderer.positionNames || [];
        const isNucleotide = (i) => positionTypes[i] === 'D' || positionTypes[i] === 'R';
        const isPurine = (i) => {
            const nm = String(naNames[i] || '').trim().toUpperCase();
            return NA_PURINES[nm] === 1;
        };
        const isDna = (i) => positionTypes[i] === 'D';
        // Rotated frames for the draw stage. The prediction is a rigid
        // function of the trace, so feeding it rotated positions gives
        // rotated frames directly. Skipped entirely when the structure has
        // no nucleotides: the want() filter already made the loop a no-op,
        // but the Float64Array(n*6) still allocated every frame - ~0.5 MB
        // per render on a 10000-residue protein, all of it dead.
        let hasNA = false;
        for (let i = 0; i < n; i++) {
            if (isNucleotide(i)) { hasNA = true; break; }
        }
        // THE SMOOTHED TRACE IS WHAT EVERYTHING NUCLEIC READS - see
        // smoothNucleicTrace. Identical to `rotated` for a structure with no
        // nucleotides, and when the switch is off.
        const naSmoothOn = hasNA && renderer.naSmooth !== false;
        const naPos = naSmoothOn
            ? smoothNucleicTrace(rotated, n, positionTypes, runs, renderer.sidechainMap)
            : rotated;
        const baseFramesRot = hasNA ? predictBaseFrames(
            (i) => naPos[i], n, isNucleotide, isPurine, isDna) : null;

        // --- base pairing (nucleic only), cached like sec: both depend on the
        // unrotated coords, so neither changes as the view moves ---
        //
        // Measured against Watson-Crick H-bonds (N1/N3 under 3.2 A) over
        // 1BNA/355D/1EHZ/1AOI/2R8S, recall / precision by rule:
        //   mutual-best nearest neighbour        58% / 55%   <- was here
        //   greedy max-weight matching           68% / 53%
        //   + base complementarity               85% / 68%
        //   + stacking support (this)            84% / 72%
        // Complementarity is the single biggest gain, and it is free: the base
        // name is already parsed. Matching is greedy rather than a Nussinov DP
        // because pairs here are NOT nested - duplexes span two chains and
        // tertiary contacts pseudoknot - and greedy is O(m log m) against the
        // DP's O(n^3), which matters on ribosome-sized inputs.
        let pairOf = renderer._cartoonPair;
        if (!pairOf || renderer._cartoonPairKey !== secKey) {
            if (renderer._cartoonPairKey !== secKey) cacheRebuilt = true;
            pairOf = new Int32Array(n).fill(-1);
            const coords = renderer.coords;
            const names = renderer.positionNames || [];
            // Unrotated frames: pairing is cached on the unrotated coords.
            // Predicted HERE, inside the cache rebuild, because this is the
            // only consumer - computing them every render alongside the
            // rotated set doubled the prediction cost for a result that was
            // thrown away on every cache hit.
            const bf = hasNA ? predictBaseFrames(
                (i) => coords[i], n, isNucleotide, isPurine, isDna) : null;
            const runOf = new Int32Array(n).fill(-1);
            const idx = [];
            for (let r = 0; r < runs.length; r++) {
                const [lo, hi] = runs[r];
                if (positionTypes[lo] === 'P') continue;   // protein run
                for (let i = lo; i <= hi; i++) { runOf[i] = r; idx.push(i); }
            }
            // 'DA'/'RA'/'A' all reduce to 'A'; anything else (modified bases)
            // yields '' and simply never pairs
            // Modified nucleotides keep Watson-Crick faces (pseudouridine still
            // pairs with A, 5-methyl-C still pairs with G), so they must map to
            // their parent base or every pair involving one is lost - tRNA is
            // full of them.
            const MODBASE = {
                PSU: 'U', H2U: 'U', '4SU': 'U', '5MU': 'U', UR3: 'U', '2MU': 'U',
                '5MC': 'C', OMC: 'C', '4OC': 'C', '5IC': 'C',
                '1MA': 'A', '2MA': 'A', '6MA': 'A', MIA: 'A',
                '2MG': 'G', M2G: 'G', '7MG': 'G', OMG: 'G', '1MG': 'G', YYG: 'G', YG: 'G',
                OMU: 'U', '5MB': 'C',
            };
            const baseOf = (nm) => {
                if (!nm) return '';
                const s = String(nm).trim().toUpperCase();
                if (s.length === 1) return s;
                if (s.length === 2 && (s[0] === 'D' || s[0] === 'R')) return s[1];
                return MODBASE[s] || '';
            };
            // G.U (and G.T) wobble: real and common, but only admitted in the
            // stem-growing pass below - see the note there.
            const wobble = (a, b) => (
                (a === 'G' && (b === 'U' || b === 'T'))
                || (b === 'G' && (a === 'U' || a === 'T')));
            const complementary = (a, b) => (
                (a === 'A' && (b === 'T' || b === 'U'))
                || (b === 'A' && (a === 'T' || a === 'U'))
                || (a === 'G' && b === 'C') || (a === 'C' && b === 'G'));
            if (idx.length > 1) {
                const CELLA = NA_PAIR_MAX;
                const bins = new Map();
                const bkey = (x, y, z) => `${Math.floor(x / CELLA)},${Math.floor(y / CELLA)},${Math.floor(z / CELLA)}`;
                for (const i of idx) {
                    const c = coords[i];
                    const k = bkey(c.x, c.y, c.z);
                    let arr = bins.get(k);
                    if (!arr) { arr = []; bins.set(k, arr); }
                    arr.push(i);
                }
                const cand = new Map();          // i*n+j (i<j) -> distance cost
                const wob = new Set();           // of those, the G.U wobbles
                for (const i of idx) {
                    const ci = coords[i];
                    const bi = baseOf(names[i]);
                    if (!bi) continue;
                    const bx = Math.floor(ci.x / CELLA);
                    const by = Math.floor(ci.y / CELLA);
                    const bz = Math.floor(ci.z / CELLA);
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dz = -1; dz <= 1; dz++) {
                                const arr = bins.get(`${bx + dx},${by + dy},${bz + dz}`);
                                if (!arr) continue;
                                for (const j of arr) {
                                    if (j <= i) continue;
                                    // a sequence neighbour is not a partner, but
                                    // only WITHIN one strand: the two halves of a
                                    // duplex are adjacent in index order, and a
                                    // global gap test wrongly blocked the pairs
                                    // either side of the chain boundary
                                    if (runOf[i] === runOf[j] && j - i <= NA_PAIR_SEQ_GAP) continue;
                                    // A wobble is admitted as a candidate but
                                    // NOT as an assignable pair (it is filtered
                                    // out again at the scoring loop below). It
                                    // is here only so that it can SUPPORT its
                                    // neighbours' register.
                                    //
                                    // Keeping wobbles out of pass 1 entirely -
                                    // which is what this did - is right for
                                    // assignment but wrong for the run-length
                                    // score, because a G.U inside a stem then
                                    // punches a hole in the true register's
                                    // candidate run while leaving a shifted
                                    // register's run intact. Measured on 3A3A
                                    // (tRNA-Sec, whose 9 bp acceptor stem
                                    // carries a G6.U81 wobble): the true A7-U80
                                    // fell to runLen 1 and was dropped as
                                    // "isolated", the shifted A7-U81 kept a
                                    // neighbour and took the slot, and pass 2
                                    // could not repair it because both residues
                                    // were then spoken for. One wobble cost
                                    // three real pairs and added a wrong one.
                                    const bj = baseOf(names[j]);
                                    const isWob = !complementary(bi, bj)
                                        && wobble(bi, bj);
                                    if (!complementary(bi, bj) && !isWob) continue;
                                    const cj = coords[j];
                                    const d = Math.hypot(cj.x - ci.x, cj.y - ci.y, cj.z - ci.z);
                                    if (d < NA_PAIR_MIN || d > NA_PAIR_MAX) continue;
                                    // Real base geometry, where the file gave it
                                    // to us, is a far better discriminator than
                                    // C4'-C4' distance: measured separation is
                                    // 5.9 A across a true pair vs 11.2 A for a
                                    // register-shifted false one. Precision
                                    // 76.8% -> 93.4%, and it is the only thing
                                    // that separates registers in a homopolymer
                                    // duplex (5H0R), where complementarity says
                                    // nothing and distance actively misleads.
                                    let score = Math.abs(d - NA_PAIR_IDEAL);
                                    // A frame of zeros means "this base could
                                    // not be read or predicted" - a modified or
                                    // incomplete base from the file, or a
                                    // residue the prediction skipped. It must
                                    // ABSTAIN: taken at face value it puts the
                                    // centroid on the C4' itself, the separation
                                    // below becomes the C4'-C4' distance (~14 A),
                                    // and the pair is rejected - so one
                                    // unreadable base silently cost its partner
                                    // its pairing too.
                                    const oi = i * 6, oj = j * 6;
                                    const haveI = bf && (bf[oi] || bf[oi + 1] || bf[oi + 2]);
                                    const haveJ = bf && (bf[oj] || bf[oj + 1] || bf[oj + 2]);
                                    if (haveI && haveJ) {
                                        const gi = [ci.x + bf[oi], ci.y + bf[oi + 1], ci.z + bf[oi + 2]];
                                        const gj = [cj.x + bf[oj], cj.y + bf[oj + 1], cj.z + bf[oj + 2]];
                                        const sep = Math.hypot(gi[0] - gj[0], gi[1] - gj[1], gi[2] - gj[2]);
                                        if (sep > 1e-6) {
                                            const cop = Math.abs(
                                                bf[oi + 3] * bf[oj + 3] + bf[oi + 4] * bf[oj + 4]
                                                + bf[oi + 5] * bf[oj + 5]);
                                            // GROSS violations only. The frames
                                            // are predicted to ~17 deg with a
                                            // long tail, and a test tight enough
                                            // for exact geometry (6.8 A / 0.7)
                                            // throws out 45% of true pairs -
                                            // measured over 60 chains. Widened
                                            // to catch bases that are
                                            // perpendicular or far apart, it
                                            // still removes three quarters of
                                            // the false candidates while keeping
                                            // 86% of the true ones, and the
                                            // ranking is left to the C4'
                                            // distance.
                                            if (sep > NA_BASE_SEP_MAX) continue;
                                            if (cop < NA_COPLANAR_MIN) continue;
                                        }
                                    }
                                    cand.set(i * n + j, score);
                                    if (isWob) wob.add(i * n + j);
                                }
                            }
                        }
                    }
                }
                // STACKING support: in a helix the neighbours of a pair are a
                // pair too, one step along each strand in opposite directions.
                // Rewarding that both ranks real helical pairs first and lets
                // isolated candidates be dropped.
                // REGISTER RUN LENGTH, not just immediate support. Adjacent
                // pairs in a stack share i+j by construction, so a shifted
                // register is internally just as consistent as the true one and
                // ±1 support cannot tell them apart - measured on 5H0R, a
                // homopolymer duplex, a 6-pair false register survived alongside
                // the 27-pair true one. What separates them is LENGTH, so score
                // by the whole contiguous run a candidate belongs to. Recall
                // 69.7 -> 84.9%, precision 80.9 -> 92.1%, and 5H0R's false pairs
                // fall from 15 to 2.
                const scored = [];
                for (const [k, s] of cand) {
                    const i = Math.floor(k / n);
                    const j = k % n;
                    let runLen = 1;
                    for (const [da, db] of [[1, -1], [-1, 1]]) {
                        let a2 = i + da, b2 = j + db;
                        while (a2 >= 0 && b2 >= 0 && a2 < n && b2 < n
                            && cand.has(a2 < b2 ? a2 * n + b2 : b2 * n + a2)) {
                            // A wobble BRIDGES the run but only half counts
                            // toward it. Letting the walk step over a G.U is
                            // the whole point - a wobble mid-stem otherwise
                            // splits the true register in two and a shifted one
                            // wins. But scoring it as a full pair over-rewards
                            // the registers that a wobble happens to bridge by
                            // chance. Measured over 84 chains against H-bond
                            // geometry: bridging at weight 1 gains 25 true pairs
                            // for 23 false, at 0.5 it gains 22 for 8 (F1 81.49
                            // -> 81.89%). Anything in 0.25..0.75 measures the
                            // same, so the bridging is what matters, not the
                            // size of the increment.
                            runLen += wob.has(a2 < b2 ? a2 * n + b2
                                : b2 * n + a2) ? NA_WOBBLE_RUN_W : 1;
                            a2 += da; b2 += db;
                        }
                    }
                    if (runLen < 2) continue;     // isolated: not a helix
                    // wobbles supported their neighbours' run above; they are
                    // not assigned here. Pass 2 will take them once the stem
                    // they belong to exists, where the axis test can guard them.
                    if (wob.has(k)) continue;
                    scored.push([s - NA_RUN_W * runLen, i, j]);
                }
                scored.sort((a, b) => a[0] - b[0]);
                for (const [, i, j] of scored) {
                    if (pairOf[i] >= 0 || pairOf[j] >= 0) continue;
                    pairOf[i] = j; pairOf[j] = i;
                }

                // PASS 2 - grow the confirmed stems.
                // Pass 1 deliberately admits only Watson-Crick pairs: allowing
                // G.U wobble up front floods the candidate set and a spurious
                // partner can evict a real one (measured: 4.5x the false pairs,
                // precision down across every test structure). But once a stem
                // exists, its pairs fix the local helix axis EXACTLY - a pair's
                // midpoint lies on it - so a neighbouring pair only has to
                // continue that axis. That is a far stronger test than any
                // threshold on the noisy fitted base-plane normals, which
                // overlap too much between true and false pairs to separate.
                // Windows are measured over 291 consecutive true pairs, not
                // taken from ideal-helix theory: the C4' midpoint sits off-axis,
                // so its step is 4.17 A median (NOT the 2.8 A rise) and it
                // deviates from the axis by up to ~2.5 A.
                const mid3 = (a, b) => {
                    const x = coords[a], y = coords[b];
                    return [(x.x + y.x) / 2, (x.y + y.y) / 2, (x.z + y.z) / 2];
                };
                const dist3 = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
                for (let round = 0; round < NA_GROW_ROUNDS; round++) {
                    const add = [];
                    for (let a = 0; a < n; a++) {
                        const b = pairOf[a];
                        if (b < 0 || b < a) continue;
                        for (const [da, db] of [[1, -1], [-1, 1]]) {
                            const c = a + da, d = b + db;
                            if (c < 0 || d < 0 || c >= n || d >= n) continue;
                            if (pairOf[c] >= 0 || pairOf[d] >= 0) continue;
                            if (runOf[c] < 0 || runOf[d] < 0) continue;
                            if (runOf[c] === runOf[d] && Math.abs(d - c) <= NA_PAIR_SEQ_GAP) continue;
                            const bc = baseOf(names[c]), bd = baseOf(names[d]);
                            if (!bc || !bd) continue;
                            // wobble allowed here, where the axis test guards it
                            if (!complementary(bc, bd) && !wobble(bc, bd)) continue;
                            const cc = coords[c], cd = coords[d];
                            const dist = Math.hypot(cd.x - cc.x, cd.y - cc.y, cd.z - cc.z);
                            if (dist < NA_PAIR_MIN || dist > NA_PAIR_MAX) continue;
                            const M0 = mid3(a, b), M1 = mid3(c, d);
                            const step = dist3(M0, M1);
                            if (step < NA_RISE_MIN || step > NA_RISE_MAX) continue;
                            // must CONTINUE the axis set by the previous pair
                            const pPrev = pairOf[a - da];
                            if (pPrev >= 0) {
                                const Mp = mid3(a - da, pPrev);
                                let ax = M0[0] - Mp[0], ay = M0[1] - Mp[1], az = M0[2] - Mp[2];
                                const al = Math.hypot(ax, ay, az);
                                if (al > 1e-6) {
                                    ax /= al; ay /= al; az /= al;
                                    const vx = M1[0] - M0[0], vy = M1[1] - M0[1], vz = M1[2] - M0[2];
                                    const dot = vx * ax + vy * ay + vz * az;
                                    const off = Math.hypot(vx - ax * dot, vy - ay * dot, vz - az * dot);
                                    if (off > NA_AXIS_OFF) continue;
                                }
                            }
                            add.push([c, d]);
                        }
                    }
                    if (!add.length) break;
                    for (const [c, d] of add) {
                        if (pairOf[c] >= 0 || pairOf[d] >= 0) continue;
                        pairOf[c] = d; pairOf[d] = c;
                    }
                }
            }
            renderer._cartoonPair = pairOf;
            renderer._cartoonPairKey = secKey;
        }

        // A BASE POINTS AT ITS PARTNER. The prediction gets that sign wrong for
        // 8.9% of paired residues (measured over 153 chains), and a wrong sign
        // is a 180 deg error that the ribbon frame then follows: one residue
        // where the backbone visibly half-turns, which is how it was found
        // (3A3A A44, 161 deg between neighbouring frames against a 20 deg
        // median). The pairing is derived from distance, complementarity and
        // stacking - not from these frames - so it is an independent check, and
        // applying it cuts errors past 90 deg from 7.2% to 3.0%.
        //
        // Note this would be WRONG for exact geometry - a base does not always
        // point across its pair (100% on B-DNA, 98% on tRNA, but 83% on 2R8S,
        // where tertiary contacts break it) - but against a ~17 deg prediction
        // with a 180 deg failure mode it is the better prior.
        if (baseFramesRot && pairOf) {
            for (let i = 0; i < n; i++) {
                const j = pairOf[i];
                if (j < 0 || j >= n) continue;
                const o = i * 6;
                const a = rotated[i], b = rotated[j];
                const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
                if (baseFramesRot[o] * dx + baseFramesRot[o + 1] * dy
                    + baseFramesRot[o + 2] * dz >= 0) continue;
                baseFramesRot[o] = -baseFramesRot[o];
                baseFramesRot[o + 1] = -baseFramesRot[o + 1];
                baseFramesRot[o + 2] = -baseFramesRot[o + 2];
            }
        }

        // --- strand frames from the carbonyls + the ladders --------------------
        //
        // The whole construction - predict the carbonyls, seed each strand
        // residue's side from its own, smooth along the strand, relax across the
        // rungs, smooth again - depends only on the UNROTATED coordinates, so it
        // is done once per object/frame and cached beside sec and the ladders.
        //
        // What is cached is not the side vector but its three coefficients in
        // the LOCAL FRAME of the trace at that residue (the same frame the
        // peptide table is written in). Rebuilding that frame from the rotated
        // coordinates and mapping the coefficients back out reproduces the
        // rotated side vector exactly, without the plugin having to know
        // anything about the view or object rotation matrices - and it costs two
        // cross products per strand residue per render instead of a prediction,
        // two smoothing passes and three relaxation sweeps.
        //
        // Empty when there are no ladders (no sheet, or a chain too short to
        // bin): the curvature frame below then stands unchanged, which is what
        // every style did before this existed.
        let sheet = renderer._cartoonSheet;
        if (!sheet || renderer._cartoonSheetKey !== secKey) {
            // KEY, not the cache being falsy. `sheet` is legitimately null when
            // the structure has no ladders, so `!sheet` re-enters this branch on
            // every frame of an all-helix protein - and flagging that as a
            // rebuild switched the frame timer off entirely for those
            // structures, so the degrade could never fire on them at all.
            if (renderer._cartoonSheetKey !== secKey) cacheRebuilt = true;
            sheet = ladders.length
                ? buildSheetFrames(renderer.coords, n, sec, positionTypes, ladders,
                    { names: renderer.positionNames, rings: ringRuns })
                : null;
            renderer._cartoonSheet = sheet;
            renderer._cartoonSheetKey = secKey;
        }
        // index wrap for residues inside a cyclic run, else null
        const ringWrap = new Array(n).fill(null);
        for (const [rl, rh] of ringRuns) {
            const span = rh - rl + 1;
            const f = (k) => rl + (((k - rl) % span) + span) % span;
            for (let i = rl; i <= rh && i < n; i++) ringWrap[i] = f;
        }
        const sheetLocal = sheet && sheet.local;
        // Map the cached coefficients into the rotated frame.
        let sheetSides = null;
        if (sheetLocal) {
            sheetSides = new Array(n).fill(null);
            const fr = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            for (let i = 0; i < n; i++) {
                const o = i * 3;
                const lx = sheetLocal[o], ly = sheetLocal[o + 1], lz = sheetLocal[o + 2];
                if (!lx && !ly && !lz) continue;
                if (!localFrame((k) => rotated[k], n, i, fr, ringWrap[i])) continue;
                const x = fr[0] * lx + fr[3] * ly + fr[6] * lz;
                const y = fr[1] * lx + fr[4] * ly + fr[7] * lz;
                const z = fr[2] * lx + fr[5] * ly + fr[8] * lz;
                const l = Math.hypot(x, y, z);
                if (l > 1e-9) sheetSides[i] = [x / l, y / l, z / l];
            }
            // STRAND EDGES BORROW THEIR OWN STRAND'S FACE.
            // buildSheetFrames only yields coefficients where it could pair a
            // residue into a ladder, so the first and last residue of a stretch
            // - and any isolated one - come back empty: on 1TIM that is 17 of
            // 32 such residues. Falling through to the curvature normal there
            // is not a small error. A strand's curvature normal alternates with
            // the PLEAT, the very thing the sheet frame exists to remove, so
            // the fallback face can sit ~140 degrees from the strand's own
            // (measured on 1YP8: sheet-vs-curvature runs 138, 23, 137, 21 along
            // one strand). A short loop between two strands then has to absorb
            // that in a step or two and the strip pinches to nothing - the
            // bow-tie at a seam was this, not the loop transport, which was
            // faithfully interpolating a garbage endpoint.
            //
            // Carry the nearest framed residue OF THE SAME STRAND across
            // instead, walking contiguously so a neighbouring strand is never
            // borrowed from, and orthonormalise it against the local tangent so
            // the result is a valid side vector.
            const isE = (i) => sec[i] === 'E';
            for (let i = 0; i < n; i++) {
                if (sheetSides[i] || !isE(i)) continue;
                const wf = ringWrap[i];
                const step = (k, d) => (wf ? wf(k + d) : k + d);
                let src = null;
                for (const dir of [-1, 1]) {
                    let j = i;
                    for (let d = 0; d < 6 && !src; d++) {
                        const k = step(j, dir);
                        if (k < 0 || k >= n || !isE(k)) break;
                        j = k;
                        if (sheetSides[j]) src = sheetSides[j];
                    }
                    if (src) break;
                }
                if (!src) continue;
                const a = rotated[wf ? wf(i - 1) : Math.max(0, i - 1)];
                const b = rotated[wf ? wf(i + 1) : Math.min(n - 1, i + 1)];
                let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
                const tl = Math.hypot(tx, ty, tz);
                if (tl < 1e-9) continue;
                tx /= tl; ty /= tl; tz /= tl;
                const dp = src[0] * tx + src[1] * ty + src[2] * tz;
                const ox = src[0] - dp * tx;
                const oy = src[1] - dp * ty;
                const oz = src[2] - dp * tz;
                const ol = Math.hypot(ox, oy, oz);
                if (ol > 1e-9) sheetSides[i] = [ox / ol, oy / ol, oz / ol];
            }
        }

        // Debug hook: force an SS string (e.g. 'HH' on a 2-residue chain
        // renders a single slab interval - a box - the minimal test case for
        // the rendering rules; make_sec itself needs 5 consecutive residues).
        if (renderer._forceSec) {
            sec = renderer._forceSec.split('');
        }

        // --- build primitives ---
        const prims = [];
        const q0 = [0, 0, 0];
        // ---- SHEET FLATTENING ----------------------------------------------
        // A real strand PLEATS: successive CA atoms alternate above and below
        // the strand's mean plane, so a ribbon built straight through them
        // ripples. Richardson's strands are drawn flat, and the pleat is the
        // only thing standing between this pipeline and that look.
        //
        // Flattening blends each strand residue toward a windowed average of
        // its neighbours along the SAME strand, which cancels the alternating
        // component while leaving the strand's real curvature and twist. It is
        // done here, on one accessor, so every consumer - rails, side vectors,
        // occluders, ink - sees the same flattened geometry and nothing has to
        // be kept in sync.
        //
        // The strand's END RESIDUES ARE PINNED and only its interior moves, so
        // the ribbon still meets its flanking loops exactly where it did and no
        // loop residue has to be touched. Tapering the weight inside the strand
        // was an earlier attempt and it was wrong: min(1, integer distance from
        // the end) is 0 at the terminal residue and 1 at its neighbour - a step,
        // not a ramp - so the strand visibly snapped flat one residue in.
        // 0 = untouched (pleated), 1 = fully averaged.
        const sheetFlat = Math.max(0, Math.min(1,
            renderer.cartoonSheetFlat !== undefined
                ? renderer.cartoonSheetFlat : (rich ? SHEET_FLAT_DEFAULT : 0)));
        // SHEET PROJECTION: move each strand residue onto its own sheet plane
        // (see buildSheetFrames). renderer.cartoonSheetProject is the blend, 0
        // to 1; the offset travels as local-frame coefficients so it can be
        // applied to the rotated trace without a matrix.
        const sheetProject = Math.max(0, Math.min(1,
            renderer.cartoonSheetProject !== undefined
                ? renderer.cartoonSheetProject : SHEET_PROJECT));
        // ...and the ribbon path starts from the same array, so the rails and
        // the plates are drawn through one set of positions.
        let basePos = naPos;
        if (sheet && sheetProject > 0.001) {
            basePos = new Array(n);
            const fr3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            for (let i = 0; i < n; i++) {
                const p = rotated[i];
                if (!sheet.onSheet[i]
                    || !localFrame((k) => rotated[k], n, i, fr3, ringWrap[i])) {
                    basePos[i] = p;
                    continue;
                }
                const o = i * 3;
                const lx = sheet.flatLocal[o] * sheetProject;
                const ly = sheet.flatLocal[o + 1] * sheetProject;
                const lz = sheet.flatLocal[o + 2] * sheetProject;
                basePos[i] = {
                    x: p.x + fr3[0] * lx + fr3[3] * ly + fr3[6] * lz,
                    y: p.y + fr3[1] * lx + fr3[4] * ly + fr3[7] * lz,
                    z: p.z + fr3[2] * lx + fr3[5] * ly + fr3[8] * lz,
                };
            }
        }
        let posArr = basePos;
        if (sheetFlat > 0.001 && sec) {
            // chain-run bounds per residue, so smoothing never reaches across a
            // break in the backbone
            const runLo = new Int32Array(n).fill(-1);
            const runHi = new Int32Array(n).fill(-1);
            for (const [rl, rh] of runs) {
                for (let i = rl; i <= rh && i < n; i++) { runLo[i] = rl; runHi[i] = rh; }
            }
            posArr = new Array(n);
            for (let i = 0; i < n; i++) posArr[i] = basePos[i];
            // PROTEIN ONLY, belt and braces. Nucleic residues cannot reach the
            // strand test below anyway - sec is only ever assigned on protein
            // runs and defaults to 'C' - but moving a nucleic backbone would
            // break base plates: plate and base-pair geometry read rotated[]
            // directly while the backbone would read posArr, sliding the trace
            // out from under its own bases.
            const smoothable = (i) => !positionTypes || positionTypes[i] === 'P';
            // RING-AWARE SPANS. A strand can cross a head-to-tail closure, and
            // a span gathered as an [a, b] range stops dead at hi - the strand
            // is then flattened as two short fragments, or not at all when a
            // fragment is under three residues, leaving the pleat visible at
            // exactly the seam. Spans are gathered as index LISTS that wrap
            // instead. On a linear run these walk lo..hi and nothing changes.
            const onRing = new Int32Array(n).fill(-1);
            for (let r = 0; r < runs.length; r++) {
                if (runClose[r] < 0) continue;
                for (let i = runs[r][0]; i <= runs[r][1] && i < n; i++) onRing[i] = r;
            }
            const nextRes = (i) => {
                const r = onRing[i];
                if (r >= 0 && i === runs[r][1]) return runs[r][0];
                return i + 1 < n ? i + 1 : -1;
            };
            const prevRes = (i) => {
                const r = onRing[i];
                if (r >= 0 && i === runs[r][0]) return runs[r][1];
                return i - 1;
            };
            const doneE = new Uint8Array(n);
            for (let a = 0; a < n; a++) {
                // STRANDS ONLY, as in PyMOL: cartoon_flat_sheets flattens
                // sheets and leaves everything else alone. Loops used to be
                // smoothed off the same control on the reasoning that both are
                // "damp the high-frequency wiggle", but that overloaded one
                // setting with two effects - asking for flat sheets silently
                // redrew every loop as well. Helices are likewise untouched;
                // smoothing one would unwind the coil that is its whole point.
                if (doneE[a] || !smoothable(a)) continue;
                if (sec[a] !== 'E') continue;
                // back up to the strand's true start, then walk it forward;
                // both stop at a chain end, a run change, or a full loop
                let st = a;
                for (;;) {
                    const q = prevRes(st);
                    if (q < 0 || q === a) break;
                    if (!smoothable(q) || sec[q] !== 'E' || runHi[q] !== runHi[st]) break;
                    st = q;
                }
                const idxs = [st];
                doneE[st] = 1;
                for (;;) {
                    const q = nextRes(idxs[idxs.length - 1]);
                    if (q < 0 || q === st) break;
                    if (!smoothable(q) || sec[q] !== 'E' || runHi[q] !== runHi[st]) break;
                    idxs.push(q);
                    doneE[q] = 1;
                }
                let b = a;
                // ... and never past the residue's own chain run: two chains
                // whose facing termini are both coil are adjacent in index
                // order, and without this bound the span crossed the break -
                // the 3-point average then mixed positions ~15 A apart and
                // bent both termini toward each other whenever sheetFlat > 0.
                b = idxs[idxs.length - 1];
                if (idxs.length >= 3) {
                    // STRANDS: PyMOL's cartoon_flat_sheets, exactly
                    // (RepCartoonFlattenSheets, layer2/RepCartoon.cpp): per
                    // contiguous strand, flat_cycles (4) iterations of a
                    // 3-point positional average over the INTERIOR residues
                    // only - the two endpoints are PINNED and no flanking
                    // loop residue enters the window or moves.
                    //
                    // Pinning is the load-bearing detail, found the hard way.
                    // Three earlier versions each failed "flatten = suppress
                    // the zigzag, preserve the sheet's global curvature":
                    //  - averaging WITH loop extension dragged strand ends
                    //    toward their loops (6MRR's hairpin pair splayed 5.4
                    //    -> 14.1 deg apart, and the turn twisted to bridge);
                    //  - sheet-patch projection preserved axes but left half
                    //    the pleat on 2POR's curved strands (a curved
                    //    strand's residues sit legitimately off any one local
                    //    plane, so the plane offset is not the pleat);
                    //  - removing only the alternating NORMAL component
                    //    preserved both, but left the IN-PLANE wiggle, which
                    //    still read as wavy sheets on 2POR.
                    // Pinned-end interior averaging handles all three at
                    // once: the chord (axis, and with it pair parallelism)
                    // is exact by construction, the alternating mode decays
                    // by 1/3 per cycle in every direction (waviness
                    // included), and four cycles leave the low-frequency bow
                    // - the sheet's real curvature - largely intact.
                    const len = idxs.length;
                    const pvE = new Float64Array(len * 3);
                    for (let q = 0; q < len; q++) {
                        const j = idxs[q];
                        const k = q * 3;
                        pvE[k] = rotated[j].x;
                        pvE[k + 1] = rotated[j].y;
                        pvE[k + 2] = rotated[j].z;
                    }
                    const tmpE = new Float64Array(len * 3);
                    for (let c2 = 0; c2 < SHEET_FLAT_CYCLES; c2++) {
                        for (let q = 1; q + 1 < len; q++) {
                            const k = q * 3;
                            tmpE[k] = (pvE[k - 3] + pvE[k] + pvE[k + 3]) / 3;
                            tmpE[k + 1] = (pvE[k - 2] + pvE[k + 1] + pvE[k + 4]) / 3;
                            tmpE[k + 2] = (pvE[k - 1] + pvE[k + 2] + pvE[k + 5]) / 3;
                        }
                        for (let q = 1; q + 1 < len; q++) {
                            const k = q * 3;
                            pvE[k] = tmpE[k];
                            pvE[k + 1] = tmpE[k + 1];
                            pvE[k + 2] = tmpE[k + 2];
                        }
                    }
                    const w = Math.min(1, sheetFlat);
                    for (let q = 1; q < len - 1; q++) {      // ends pinned
                        const j = idxs[q];
                        const k = q * 3;
                        const v = rotated[j];
                        const p = posArr[j];
                        posArr[j] = {
                            x: p.x + (pvE[k] - v.x) * w,
                            y: p.y + (pvE[k + 1] - v.y) * w,
                            z: p.z + (pvE[k + 2] - v.z) * w,
                        };
                    }
                }
                // Skip past the span just handled. Guarded because a WRAPPED
                // span ends below where it started, and rewinding the cursor
                // would rescan the whole ring; doneE makes the skip an
                // optimisation rather than something correctness rests on.
                if (b > a) a = b;
            }
        }
        // set renderer._posProbe = null before a render to receive the drawn
        // positions; used by the smoothing checks to measure per-class curvature
        // SIDE CHAINS KEEP THE ORIGINAL CA, and are deliberately NOT moved with
        // the flattened backbone.
        //
        // Flattening is a drawing device: it takes the pleat out of a strand so
        // the ribbon reads cleanly. The pleat, though, is real chemistry - it is
        // what decides which face of the sheet each side chain points at, and
        // consecutive residues alternate. Rebuilding a side chain in the
        // FLATTENED frame rotates it by however much the pleat was removed, so
        // the drawing would show side chains pointing somewhere the molecule
        // does not put them. The ribbon is already an abstraction and can be
        // idealised; the atoms are the measurement and cannot.
        //
        // So nothing happens here: _materialiseSidechains placed these atoms
        // against the file's own trace, and that is where they stay. The cost
        // is a visible offset between a flattened strand and the side chains
        // growing off it - the flattening distance itself, up to ~2 A - which
        // is a truthful depiction of the ribbon having been smoothed and the
        // atoms not. Nothing outside a strand moves at all, so loops, helices
        // and coil are unaffected either way.
        if (renderer._posProbe === null) renderer._posProbe = posArr;
        const at = (i) => posArr[i];
        // UNFLATTENED positions. The ribbon's face direction must come from
        // these, never from the flattened ones - see sideOf. Nucleic smoothing
        // is not flattening: it is the trace this drawing is OF, so it belongs
        // in here too (naPos is `rotated` itself for anything not nucleic).
        const atRaw = (i) => naPos[i];

        // Side vector for the ribbon face: curvature direction crossed with the
        // tangent, so the ribbon twists the way the backbone does.
        //
        // Reads the UNFLATTENED backbone (atRaw), which matters only when sheet
        // flattening is on. A strand's dominant curvature IS its pleat, so
        // flattening removes precisely the vector this frame is built from: at
        // full flattening the cross product collapses to numerical noise, or to
        // null via the degeneracy guard below, and the ribbon - arrowheads
        // worst of all, being the widest part - tears up. Flattening is meant
        // to move the CENTRELINE, not to reorient the ribbon, and the pleat is
        // the honest source for which way a strand faces. Taking the frame from
        // the raw coordinates separates the two cleanly and leaves every
        // unflattened style bit-identical.
        const sideOf = (i, lo, hi, cyc) => {
            // At run ends the centered tangent/curvature degenerate (their
            // cross vanishes and the side used to be COPIED from the
            // neighbour, losing the ~100 deg/residue rotation - visible as
            // a twisted terminal interval). One-sided helix-exact stencils
            // for both derivatives give the true end side.
            const oneSided = (j, dir) => {
                const p0 = atRaw(j);
                const pa = atRaw(j + dir);
                const pb = atRaw(j + 2 * dir);
                const pc = atRaw(j + 3 * dir);
                const tx = dir * (HT1_A * (pa.x - p0.x) + HT1_B * (pb.x - p0.x) + HT1_C * (pc.x - p0.x));
                const ty = dir * (HT1_A * (pa.y - p0.y) + HT1_B * (pb.y - p0.y) + HT1_C * (pc.y - p0.y));
                const tz = dir * (HT1_A * (pa.z - p0.z) + HT1_B * (pb.z - p0.z) + HT1_C * (pc.z - p0.z));
                const kx = HK1_A * (pa.x - p0.x) + HK1_B * (pb.x - p0.x) + HK1_C * (pc.x - p0.x);
                const ky = HK1_A * (pa.y - p0.y) + HK1_B * (pb.y - p0.y) + HK1_C * (pc.y - p0.y);
                const kz = HK1_A * (pa.z - p0.z) + HK1_B * (pb.z - p0.z) + HK1_C * (pc.z - p0.z);
                let sx = ty * kz - tz * ky;
                let sy = tz * kx - tx * kz;
                let sz = tx * ky - ty * kx;
                const m = Math.hypot(sx, sy, sz);
                if (m < 1e-9) return null;
                return [sx / m, sy / m, sz / m];
            };
            // A cyclic run has no ends, so the one-sided end stencils and the
            // clamping below would both invent a boundary where the chain
            // actually continues - wrap instead and the frame stays centred.
            if (!cyc && i - 1 < lo && i + 3 <= hi) return oneSided(i, 1);
            if (!cyc && i + 1 > hi && i - 3 >= lo) return oneSided(i, -1);
            const a = atRaw(i - 1 < lo ? (cyc ? hi : lo) : i - 1);
            const b = atRaw(i);
            const c = atRaw(i + 1 > hi ? (cyc ? lo : hi) : i + 1);
            const tx = c.x - a.x; const ty = c.y - a.y; const tz = c.z - a.z;
            const kx = a.x + c.x - 2 * b.x; const ky = a.y + c.y - 2 * b.y; const kz = a.z + c.z - 2 * b.z;
            let sx = ty * kz - tz * ky;
            let sy = tz * kx - tx * kz;
            let sz = tx * ky - ty * kx;
            const m = Math.hypot(sx, sy, sz);
            if (m < 1e-9) return null;
            return [sx / m, sy / m, sz / m];
        };

        // Joint bookkeeping for the outline: primitives meeting at a shared
        // residue (or ligand atom) register under the same key. After the
        // depth sort, the primitive drawn FIRST at a joint gets a round black
        // cap there (everything drawn later covers the cap's centre, leaving
        // just the outline rim), while later primitives keep butt caps so they
        // never paint black over a neighbour's fill. This is the same rule the
        // ribbon style uses for its outline endpoints.
        const jointMinOrder = new Map();
        const registerJoint = (key, prim) => {
            if (!prim.joints) prim.joints = [];
            prim.joints.push(key);
        };

        // ---- OFFSCREEN INTERVAL CULLING ----------------------------------
        // Rotation leaves the per-interval sampling alone (the adaptive term
        // is world-chord x zoom, by design), but zooming IN raises nsub
        // toward its cap for EVERY interval - including the ones that
        // project entirely off the canvas, which at high zoom is most of the
        // structure. Measured on 1TIM at 800px: prims and ink queries
        // plateau at their zoom-4 maximum all the way out to zoom 16, when
        // ~5% of the structure is visible - which is why zooming stuttered
        // while rotating stayed smooth. An interval whose projected segment
        // lies beyond the canvas by more than the geometry's own reach can
        // contribute nothing - no fill, no ink, and no occlusion of any
        // on-screen ink query - so it is skipped before any station is built.
        // The pad covers the widest profile (a Richardson arrowhead), the
        // Hermite's bulge past its chord, and the outline width.
        const cullPadA = 4.5 * Math.max(1, widthScale);
        // OFF-SCREEN CULLING, AND HOW TO TURN IT OFF. Dropping what falls
        // outside the viewport is right for painting a frame and wrong for
        // harvesting geometry: a consumer that keeps the primitives and re-uses
        // them at other views (the GPU prototype does exactly that) gets a model
        // with holes wherever this frame happened to look, and geometry winks in
        // and out as it turns. renderer._noViewCull keeps everything.
        const noViewCull = !!renderer._noViewCull;
        const cullSeg = (p1, p2) => {
            if (noViewCull) return false;
            const A = project(p1.x, p1.y, p1.z);
            const B = project(p2.x, p2.y, p2.z);
            if (!A || !B) return false;      // behind camera: keep, existing
            const m = cullPadA * scale * Math.max(A[3], B[3]) + outlineW + 4;
            return (A[0] < -m && B[0] < -m)
                || (A[0] > displayWidth + m && B[0] > displayWidth + m)
                || (A[1] < -m && B[1] < -m)
                || (A[1] > displayHeight + m && B[1] > displayHeight + m);
        };

        // Midpoint of a base pair - it lies on the local helix axis, and both
        // the ribbon frame and the plate frame are built from it so the two stay
        // consistent with each other.
        // ribbon side vector per residue, filled as each run is framed - see
        // the store below
        const protSide = new Array(n);
        const protHalfT = new Float64Array(n);
        // ...and the half-WIDTH, because a slab has two pairs of surfaces and a
        // side chain may leave through either - see ribbonSurfaceToward.
        const protHalfW = new Float64Array(n);
        for (let runIdx = 0; runIdx < runs.length; runIdx++) {
            const [lo, hi] = runs[runIdx];
            if (hi <= lo) continue;
            const isProt = positionTypes[lo] === 'P';
            // head-to-tail closure segment for this run, or -1
            const closeSeg = runClose[runIdx];
            const cyclic = closeSeg >= 0;
            // Neighbour lookup for the spline stencils. A ring has no ends, so
            // clamping at lo/hi would fold a neighbour onto the point itself
            // and flatten the curve at exactly the seam - the one interval the
            // clamp was never meant to describe. Wraps for a cyclic run and
            // clamps otherwise, so the linear path keeps its old behaviour.
            const span = hi - lo + 1;
            const wrapIdx = (k) => (cyclic
                ? lo + (((k - lo) % span) + span) % span
                : Math.min(hi, Math.max(lo, k)));

            let sides = null;
            {   // every run, nucleic included: the strip pipeline needs a
                // side vector per residue, and the sheet-averaging pass
                // below is a no-op when sec is all 'C'
                // Side vectors come from local curvature, which is undefined
                // at the FIRST residue of a run (the clamped stencil
                // degenerates). Falling back to an arbitrary axis there makes
                // the strip twist from a bogus direction to the true normal
                // over the first interval - the N-terminal cap renders as a
                // skewed wedge instead of a rectangle. Backfill leading
                // undefined sides from the first well-defined one (trailing
                // ones already forward-fill from their predecessor).
                const rawSides = [];
                for (let i = lo; i <= hi; i++) {
                    rawSides.push(sideOf(i, lo, hi, cyclic));
                }
                let firstDef = rawSides.findIndex((s) => s);
                if (firstDef < 0) firstDef = 0;
                for (let j = 0; j < firstDef; j++) {
                    rawSides[j] = rawSides[firstDef];
                }
                // Keep the ribbon face continuous: flip a side vector that reversed.
                sides = [];
                let prevSide = null;
                for (let j = 0; j < rawSides.length; j++) {
                    let sv = rawSides[j] || prevSide || [0, 0, 1];
                    if (prevSide && (sv[0] * prevSide[0] + sv[1] * prevSide[1] + sv[2] * prevSide[2]) < 0) {
                        sv = [-sv[0], -sv[1], -sv[2]];
                    }
                    sides.push(sv);
                    prevSide = sv;
                }
                // NUCLEIC FRAME. A PAIRED residue takes its frame from its
                // partner outright (see pairSide below): the face normal is
                // SOLVED to point at the partner, exactly, with no tracking and
                // nothing carried in from the previous residue, so it cannot
                // accumulate or jitter. Measured over 153 chains the face aims
                // within 0.0 deg where it used to be 17.6 median / 49.5 p90,
                // and the twist per residue inside a stem drops from stdev 28.9
                // to 8.6 with frame reversals 22.2% -> 4.1%. That reversal rate
                // is the visible waviness on a duplex.
                //
                // An UNPAIRED residue has no partner to solve against, so it
                // keeps the older construction: PARALLEL TRANSPORT.
                // The curvature normal of a helix points at the axis, so any
                // curvature-derived side spins with the helix - a full 36 deg per
                // residue for a duplex. That is the frame's true rotation rate,
                // not noise, which is why smoothing it and re-deriving it from
                // the base pairs both left the ribbon looking over-twisted.
                // Parallel transport instead carries one seed vector along the
                // curve, rotating it only as much as the tangent itself turns, so
                // the strip twists with the chain's torsion and nothing else.
                if (!isProt) {
                    // renderer.cartoonNaTrack: 0 = pure parallel transport (least
                    // twist, face drifts off the partner), 1 = track the partner
                    // exactly (faces always aimed, full 36 deg/residue twist).
                    // UNPAIRED RESIDUES ONLY. A paired one is solved against its
                    // partner and neither this nor the twist cap below applies -
                    // the knob cannot damp a stem any more, which is the point:
                    // damping was what made the frame lag and then catch up.
                    const ntRaw = Number(renderer.cartoonNaTrack);
                    const naTrack = Number.isFinite(ntRaw)
                        ? Math.min(1, Math.max(0, ntRaw)) : NA_TRACK_DEFAULT;
                    const tanAt = (i) => {
                        // PyMOL builds the tangent from the sum of the two
                        // normalized chord directions.  A centered raw
                        // difference gives a different answer when adjacent
                        // C4' steps have unequal lengths, which is common at
                        // the ends of a crystallographic strand.
                        const p0 = rotated[wrapIdx(i - 1)];
                        const p1 = rotated[wrapIdx(i)];
                        const p2 = rotated[wrapIdx(i + 1)];
                        const x0 = p1.x - p0.x, y0 = p1.y - p0.y, z0 = p1.z - p0.z;
                        const x1 = p2.x - p1.x, y1 = p2.y - p1.y, z1 = p2.z - p1.z;
                        const l0 = Math.hypot(x0, y0, z0), l1 = Math.hypot(x1, y1, z1);
                        if (l0 < 1e-9 && l1 < 1e-9) return null;
                        const d0 = l0 > 1e-9 ? [x0 / l0, y0 / l0, z0 / l0] : [0, 0, 0];
                        const d1 = l1 > 1e-9 ? [x1 / l1, y1 / l1, z1 / l1] : [0, 0, 0];
                        const sx = d0[0] + d1[0], sy = d0[1] + d1[1], sz = d0[2] + d1[2];
                        const sl = Math.hypot(sx, sy, sz);
                        if (sl < 1e-9) return l1 > 1e-9 ? d1 : d0;
                        return [sx / sl, sy / sl, sz / sl];
                    };
                    // C4'->base direction predicted from the local curvature
                    // frame (see NA_BASE_DIR_*). Independent of the pairing, so
                    // it is defined for unpaired residues too.
                    // Least-squares helix axis through a window of pair
                    // midpoints (a midpoint does NOT lie on the axis, so two of
                    // them are not enough - it traces a small helix around it).
                    const naAxisAt = (i) => {
                        const pts = [];
                        for (let d = -NA_AXIS_WIN; d <= NA_AXIS_WIN; d++) {
                            const k = i + d;
                            if (k < 0 || k >= n) continue;
                            const q = pairOf[k];
                            if (q < 0 || q >= n) continue;
                            // the axis of the SMOOTHED duplex, since that is
                            // the one being drawn
                            const u = naPos[k], v = naPos[q];
                            pts.push([(u.x + v.x) / 2, (u.y + v.y) / 2, (u.z + v.z) / 2]);
                        }
                        if (pts.length < 2) return null;
                        let cx = 0, cy = 0, cz = 0;
                        for (const q of pts) { cx += q[0]; cy += q[1]; cz += q[2]; }
                        cx /= pts.length; cy /= pts.length; cz /= pts.length;
                        let vx = pts[pts.length - 1][0] - cx;
                        let vy = pts[pts.length - 1][1] - cy;
                        let vz = pts[pts.length - 1][2] - cz;
                        if (Math.hypot(vx, vy, vz) < 1e-9) { vx = 1; vy = 0; vz = 0; }
                        for (let it = 0; it < 8; it++) {
                            let nx = 0, ny = 0, nz = 0;
                            for (const q of pts) {
                                const dx = q[0] - cx, dy = q[1] - cy, dz = q[2] - cz;
                                const w = dx * vx + dy * vy + dz * vz;
                                nx += dx * w; ny += dy * w; nz += dz * w;
                            }
                            const nl = Math.hypot(nx, ny, nz);
                            if (nl < 1e-12) break;
                            vx = nx / nl; vy = ny / nl; vz = nz / nl;
                        }
                        return [vx, vy, vz];
                    };
                    // Base direction from the predicted frames (see
                    // predictBaseFrames). Everything below is the fallback for
                    // the few residues that get no frame - a chain of two, or a
                    // trace too broken to bin.
                    const rbf = baseFramesRot;
                    const trueBaseDir = (i) => {
                        if (!rbf) return null;
                        const o = i * 6;
                        const x = rbf[o], y = rbf[o + 1], z = rbf[o + 2];
                        const l = Math.hypot(x, y, z);
                        return l > 1e-6 ? [x / l, y / l, z / l] : null;
                    };
                    const baseDirAt = (i, tv) => {
                        const td = trueBaseDir(i);
                        if (td) return td;
                        const j = pairOf[i];
                        const ax = j >= 0 && j < n ? naAxisAt(i) : null;
                        if (ax) {
                            // hybrid: radial from the trace to the axis line,
                            // read off the SMOOTHED trace like everything else
                            // nucleic - a rung pointing at where the rail used
                            // to be is the wobble seen end-on
                            const q = naPos[j], pI = naPos[i];
                            let rx = (pI.x + q.x) / 2 - pI.x;
                            let ry = (pI.y + q.y) / 2 - pI.y;
                            let rz = (pI.z + q.z) / 2 - pI.z;
                            const ad = rx * ax[0] + ry * ax[1] + rz * ax[2];
                            rx -= ax[0] * ad; ry -= ax[1] * ad; rz -= ax[2] * ad;
                            const rt = rx * tv[0] + ry * tv[1] + rz * tv[2];
                            rx -= tv[0] * rt; ry -= tv[1] * rt; rz -= tv[2] * rt;
                            const rl = Math.hypot(rx, ry, rz);
                            if (rl > 1e-6) {
                                rx /= rl; ry /= rl; rz /= rl;
                                const bx2 = tv[1] * rz - tv[2] * ry;
                                const by2 = tv[2] * rx - tv[0] * rz;
                                const bz2 = tv[0] * ry - tv[1] * rx;
                                const co = positionTypes[i] === 'D'
                                    ? NA_BASE_DIR_D : NA_BASE_DIR_R;
                                const dx = tv[0] * co[0] + rx * co[1] + bx2 * co[2];
                                const dy = tv[1] * co[0] + ry * co[1] + by2 * co[2];
                                const dz = tv[2] * co[0] + rz * co[1] + bz2 * co[2];
                                const dl = Math.hypot(dx, dy, dz);
                                if (dl > 1e-6) return [dx / dl, dy / dl, dz / dl];
                            }
                        }
                        const a = wrapIdx(i - 1), b = wrapIdx(i + 1);
                        if (a === b) return null;
                        const pA = naPos[a], pB = naPos[i], pC = naPos[b];
                        let cx = pA.x - 2 * pB.x + pC.x;
                        let cy = pA.y - 2 * pB.y + pC.y;
                        let cz = pA.z - 2 * pB.z + pC.z;
                        const cd = cx * tv[0] + cy * tv[1] + cz * tv[2];
                        cx -= tv[0] * cd; cy -= tv[1] * cd; cz -= tv[2] * cd;
                        const cl = Math.hypot(cx, cy, cz);
                        if (cl < 1e-6) return null;
                        cx /= cl; cy /= cl; cz /= cl;
                        const bx = tv[1] * cz - tv[2] * cy;
                        const by = tv[2] * cx - tv[0] * cz;
                        const bz = tv[0] * cy - tv[1] * cx;
                        const co = positionTypes[i] === 'D'
                            ? NA_LOCAL_DIR_D : NA_LOCAL_DIR_R;
                        const dx = tv[0] * co[0] + cx * co[1] + bx * co[2];
                        const dy = tv[1] * co[0] + cy * co[1] + by * co[2];
                        const dz = tv[2] * co[0] + cz * co[1] + bz * co[2];
                        const dl = Math.hypot(dx, dy, dz);
                        return dl > 1e-6 ? [dx / dl, dy / dl, dz / dl] : null;
                    };
                    const ortho = (v, tv) => {
                        const d = v[0] * tv[0] + v[1] * tv[1] + v[2] * tv[2];
                        const x = v[0] - tv[0] * d, y = v[1] - tv[1] * d, z = v[2] - tv[2] * d;
                        const l = Math.hypot(x, y, z);
                        return l > 1e-6 ? [x / l, y / l, z / l] : null;
                    };
                    let prevT = null;
                    let s = null;
                    for (let k = 0; k < sides.length; k++) {
                        const tv = tanAt(lo + k);
                        if (!tv) continue;
                        const pairIdx = pairOf[lo + k];
                        let pairSide = null;
                        if (pairIdx >= 0 && pairIdx < n) {
                            const aPair = rotated[lo + k], bPair = rotated[pairIdx];
                            const towardPair = ortho([
                                bPair.x - aPair.x, bPair.y - aPair.y, bPair.z - aPair.z], tv);
                            if (towardPair) {
                                // Solve t x side = direction-to-partner, which
                                // has the closed form side = direction x t:
                                // t x (d x t) = d(t.t) - t(t.d) = d, since
                                // ortho() already took d perpendicular to t.
                                // So the ribbon face looks straight at the
                                // partner - not approximately, exactly.
                                //
                                // The two rails do NOT come out with a common
                                // side axis: measured, theirs sit 82 deg apart.
                                // They cannot - the two C4' traces wind at
                                // ~59 deg to the helix axis, so the strands'
                                // tangents are nowhere near antiparallel, and
                                // a side perpendicular to both its own tangent
                                // and its own partner direction is necessarily
                                // a different vector on each rail. What the two
                                // share is the PROPERTY, each aiming at the
                                // other, and that is what the plate needs.
                                pairSide = [
                                    towardPair[1] * tv[2] - towardPair[2] * tv[1],
                                    towardPair[2] * tv[0] - towardPair[0] * tv[2],
                                    towardPair[0] * tv[1] - towardPair[1] * tv[0],
                                ];
                            }
                        }
                        const hasPairFrame = !!pairSide;
                        if (pairSide) s = pairSide;
                        if (!s) {
                            // SEED from the base pair, not from curvature: the
                            // face normal is tangent x side, so taking the side as
                            // tangent x pairDir aims the face straight across the
                            // duplex. Both strands then start in phase with each
                            // other instead of at independent arbitrary rolls.
                            // Note the frame cannot HOLD that facing all the way -
                            // staying aimed at the partner means turning 36 deg per
                            // residue, which is the twist we just removed - so it
                            // sets the phase and transport carries it from there.
                            const j = pairOf[lo + k];
                            if (j >= 0 && j < n) {
                                const a = rotated[lo + k], b = rotated[j];
                                const pv = ortho([b.x - a.x, b.y - a.y, b.z - a.z], tv);
                                if (pv) {
                                    // pairDir x tangent, NOT tangent x pairDir:
                                    // the face normal is tangent x side, and
                                    // t x (t x p) = -p, which aimed both faces
                                    // AWAY from the partner. Measured: 0% of
                                    // pairs facing their partner before this,
                                    // 100% after.
                                    s = [pv[1] * tv[2] - pv[2] * tv[1],
                                        pv[2] * tv[0] - pv[0] * tv[2],
                                        pv[0] * tv[1] - pv[1] * tv[0]];
                                }
                            }
                            if (!s) s = ortho(sides[k], tv);   // unpaired: curvature
                            if (!s) { prevT = tv; continue; }
                        } else if (prevT && !hasPairFrame) {
                            // rotate the carried vector by the same rotation that
                            // takes the previous tangent onto this one (Rodrigues)
                            const ax = prevT[1] * tv[2] - prevT[2] * tv[1];
                            const ay = prevT[2] * tv[0] - prevT[0] * tv[2];
                            const az = prevT[0] * tv[1] - prevT[1] * tv[0];
                            const sn = Math.hypot(ax, ay, az);
                            if (sn > 1e-9) {
                                const ux = ax / sn, uy = ay / sn, uz = az / sn;
                                const ang = Math.atan2(sn,
                                    prevT[0] * tv[0] + prevT[1] * tv[1] + prevT[2] * tv[2]);
                                const ca = Math.cos(ang), sa = Math.sin(ang);
                                const dt = ux * s[0] + uy * s[1] + uz * s[2];
                                const cx = uy * s[2] - uz * s[1];
                                const cy = uz * s[0] - ux * s[2];
                                const cz = ux * s[1] - uy * s[0];
                                s = [s[0] * ca + cx * sa + ux * dt * (1 - ca),
                                    s[1] * ca + cy * sa + uy * dt * (1 - ca),
                                    s[2] * ca + cz * sa + uz * dt * (1 - ca)];
                            }
                            const o = ortho(s, tv);
                            if (o) s = o;
                        }
                        // No roll: the transported vector IS the side, so the
                        // face keeps the protein convention. The 90 deg roll was
                        // only ever compensating for a frame that spun with the
                        // helix; with the spin gone it is not needed.
                        // DAMPED TRACKING toward the partner. Pure transport
                        // (gain 0) never turns, so the face drifts off the
                        // partner over a turn; full tracking (gain 1) stays
                        // aimed but turns the duplex's whole 36 deg per residue,
                        // which is the over-twisted look. In between, the frame
                        // turns at a fraction of that and stays roughly aimed.
                        if (naTrack > 0 && !hasPairFrame) {
                            const j2 = pairOf[lo + k];
                            if (j2 >= 0 && j2 < n) {
                                const a2 = rotated[lo + k], b2 = rotated[j2];
                                // NO sign correction from the partner. It was
                                // tried and is worse: it assumes a base always
                                // points across its pair, which holds 100% on
                                // B-DNA and 98% on tRNA but only 83% on 2R8S,
                                // where tertiary contacts and weaker pairing
                                // break it - and inverting those faces ADDED 9
                                // flips there (14 -> 23 beyond 120 deg). The
                                // fitted direction already carries its own sign:
                                // the curvature term dominates, so it points
                                // inward by construction and needs no reference.
                                const tgt = baseDirAt(lo + k, tv);
                                const pv2 = tgt
                                    ? ortho(tgt, tv)
                                    : ortho([b2.x - a2.x, b2.y - a2.y, b2.z - a2.z], tv);
                                if (pv2) {
                                    let gx = pv2[1] * tv[2] - pv2[2] * tv[1];
                                    let gy = pv2[2] * tv[0] - pv2[0] * tv[2];
                                    let gz = pv2[0] * tv[1] - pv2[1] * tv[0];
                                    const gl = Math.hypot(gx, gy, gz);
                                    if (gl > 1e-6) {
                                        gx /= gl; gy /= gl; gz /= gl;
                                        // ROTATE toward the target about the
                                        // tangent by gain x the true angle - do
                                        // NOT flip the target to the near side.
                                        // Flipping let a stem lock onto the
                                        // REVERSED orientation and hold it:
                                        // measured on tRNA, whole stems came out
                                        // 0/10 facing while others were 10/10,
                                        // because each stem inherits an
                                        // independent 180 deg ambiguity through
                                        // the loop before it. A linear blend
                                        // cannot cross 180 deg (it passes through
                                        // zero); a rotation can, converging in a
                                        // couple of residues.
                                        const cosA = Math.max(-1, Math.min(1,
                                            s[0] * gx + s[1] * gy + s[2] * gz));
                                        // signed about the tangent
                                        const crx = s[1] * gz - s[2] * gy;
                                        const cry = s[2] * gx - s[0] * gz;
                                        const crz = s[0] * gy - s[1] * gx;
                                        const sinA = crx * tv[0] + cry * tv[1] + crz * tv[2];
                                        const ang = Math.atan2(sinA, cosA) * naTrack;
                                        const ca2 = Math.cos(ang), sa2 = Math.sin(ang);
                                        const dt2 = tv[0] * s[0] + tv[1] * s[1] + tv[2] * s[2];
                                        const kx = tv[1] * s[2] - tv[2] * s[1];
                                        const ky = tv[2] * s[0] - tv[0] * s[2];
                                        const kz = tv[0] * s[1] - tv[1] * s[0];
                                        const o2 = ortho([
                                            s[0] * ca2 + kx * sa2 + tv[0] * dt2 * (1 - ca2),
                                            s[1] * ca2 + ky * sa2 + tv[1] * dt2 * (1 - ca2),
                                            s[2] * ca2 + kz * sa2 + tv[2] * dt2 * (1 - ca2)], tv);
                                        if (o2) s = o2;
                                    }
                                }
                            }
                        }
                        // TWIST CAP. The frame follows the base, and a base can
                        // sit almost anywhere relative to the backbone - at a
                        // bulge or a syn nucleotide it turns most of a half
                        // circle from its neighbour, and the ribbon then flips
                        // over between two residues. Measured over six nucleic
                        // structures, ~3% of steps exceed 90 deg with the frames
                        // READ from the file, so this is not a prediction
                        // artefact; it is real geometry that a ribbon cannot
                        // show. Capping the step lets the frame keep tracking
                        // and catch up over the next residue or two instead.
                        if (k > 0 && sides[k - 1] && !hasPairFrame) {
                            const pS = sides[k - 1];
                            const cs = Math.max(-1, Math.min(1,
                                pS[0] * s[0] + pS[1] * s[1] + pS[2] * s[2]));
                            const turn = Math.acos(cs);
                            if (turn > NA_TWIST_MAX) {
                                // rotate the PREVIOUS side toward this one by
                                // the cap, about the tangent
                                const sgn = (tv[0] * (pS[1] * s[2] - pS[2] * s[1])
                                    + tv[1] * (pS[2] * s[0] - pS[0] * s[2])
                                    + tv[2] * (pS[0] * s[1] - pS[1] * s[0])) < 0 ? -1 : 1;
                                const a2 = sgn * NA_TWIST_MAX;
                                const ca3 = Math.cos(a2), sa3 = Math.sin(a2);
                                const dt3 = tv[0] * pS[0] + tv[1] * pS[1] + tv[2] * pS[2];
                                const kx3 = tv[1] * pS[2] - tv[2] * pS[1];
                                const ky3 = tv[2] * pS[0] - tv[0] * pS[2];
                                const kz3 = tv[0] * pS[1] - tv[1] * pS[0];
                                const capped = ortho([
                                    pS[0] * ca3 + kx3 * sa3 + tv[0] * dt3 * (1 - ca3),
                                    pS[1] * ca3 + ky3 * sa3 + tv[1] * dt3 * (1 - ca3),
                                    pS[2] * ca3 + kz3 * sa3 + tv[2] * dt3 * (1 - ca3)], tv);
                                if (capped) s = capped;
                            }
                        }
                        sides[k] = s;
                        // The plates are built from THIS frame, so record it.
                        naFrames[lo + k] = { s: [s[0], s[1], s[2]],
                            t: [tv[0], tv[1], tv[2]] };
                        prevT = tv;
                    }
                }
                // FINAL NUCLEIC FRAME SIGN PASS. Solving each side against its
                // own partner fixes its DIRECTION but says nothing about its
                // sign relative to the neighbour, and the interpolator between
                // two residues slerps from one side to the next: given a pair
                // that reads as opposed it takes the long way round and wrings
                // the rail through most of a half turn inside one residue.
                // Make the whole run agree instead. Only the relative sign
                // matters - the slab is symmetric under s -> -s, and the plate
                // picks its own face geometrically (see faceSign in mk) - so
                // negating the tail of a run costs nothing.
                if (!isProt) {
                    let finalSide = null;
                    for (let k = 0; k < sides.length; k++) {
                        let sv = sides[k];
                        if (!sv) continue;
                        if (finalSide && (sv[0] * finalSide[0]
                            + sv[1] * finalSide[1] + sv[2] * finalSide[2]) < 0) {
                            sv = [-sv[0], -sv[1], -sv[2]];
                            sides[k] = sv;
                        }
                        finalSide = sv;
                        const f = naFrames[lo + k];
                        if (f) f.s = [sv[0], sv[1], sv[2]];
                        // AFTER the sign pass, so _naDebug reports the frame
                        // the geometry is actually built from. Recording it
                        // where the side is first computed made the debug
                        // output disagree with the drawing for ~45% of
                        // residues, which is exactly the case you reach for it.
                        if (renderer._naDebug && f) {
                            (renderer._naFrame || (renderer._naFrame = {}))[lo + k] = {
                                s: [sv[0], sv[1], sv[2]],
                                t: [f.t[0], f.t[1], f.t[2]],
                                p: [rotated[lo + k].x, rotated[lo + k].y, rotated[lo + k].z],
                                j: pairOf[lo + k],
                            };
                        }
                    }
                }
                // STRAND FRAMES FROM THE SHEET, where the carbonyls gave us one.
                // Overrides the curvature side for 'E' residues only: helices
                // and loops keep their own frame (a helix's curvature points at
                // its axis, which is exactly the right face for it, and a
                // carbonyl there points ALONG the axis instead). Each vector is
                // still flipped into agreement with its predecessor so the strip
                // stays continuous across the helix/strand/loop joins.
                let fromSheet = null;
                if (isProt && sheetSides) {
                    fromSheet = new Uint8Array(hi - lo + 1);
                    let prevSide = null;
                    for (let i = lo; i <= hi; i++) {
                        const k = i - lo;
                        const sv0 = sheetSides[i];
                        // BREAK THE CHAIN AT A LOOP, do not follow it. This used
                        // to carry `prevSide = sides[k]` across loop residues,
                        // which let a loop's curvature-derived face - a
                        // direction with no intrinsic meaning, swinging through
                        // every inflection - decide the sign of the next
                        // strand's sheet face. Elements are the things with a
                        // real face; loops connect them. The absolute sign of
                        // each element is settled by the loop pass below, which
                        // transports one element's face to the next.
                        if (!sv0) { prevSide = null; continue; }
                        let sv = sv0;
                        if (prevSide && (sv[0] * prevSide[0] + sv[1] * prevSide[1]
                            + sv[2] * prevSide[2]) < 0) {
                            sv = [-sv[0], -sv[1], -sv[2]];
                        }
                        sides[k] = sv;
                        fromSheet[k] = 1;
                        prevSide = sv;
                    }
                }
                // Average side vectors within each strand so the plate does not
                // twist with the pleat. After the flip pass, or averaging would
                // cancel vectors that merely point opposite ways. Skipped where
                // the sheet frame already supplied the side: that pass is itself
                // smoothed, and averaging it again pulls partners back apart.
                if (FLAT_SHEETS) {
                    const src = sides.slice();
                    for (let i = lo; i <= hi; i++) {
                        if (sec[i] !== 'E') continue;
                        if (fromSheet && fromSheet[i - lo]) continue;
                        let ax = 0; let ay = 0; let az = 0;
                        for (let j = i - SHEET_SMOOTH; j <= i + SHEET_SMOOTH; j++) {
                            if (j < lo || j > hi || sec[j] !== 'E') continue;
                            const v = src[j - lo];
                            ax += v[0]; ay += v[1]; az += v[2];
                        }
                        const m = Math.hypot(ax, ay, az);
                        if (m > 1e-9) sides[i - lo] = [ax / m, ay / m, az / m];
                    }
                }

                // LOOPS GET A MINIMAL-TWIST FRAME.
                // Side vectors come from the local CURVATURE, which is the
                // right source for an element - a helix's curvature points at
                // its axis, a strand's at its pleat - but a loop has no
                // intrinsic face, and its curvature direction swings through
                // every inflection. The strip then rolls about its own centre
                // line for no reason, which is the extra twist visible in
                // loops.
                //
                // A loop's frame should instead carry the neighbouring
                // element's orientation along with as little rotation as the
                // path allows: parallel transport. Each side is the previous
                // one projected perpendicular to the new tangent, which is the
                // rotation-minimising frame.
                //
                // Transport alone would leave the far end mismatched against
                // the NEXT element, trading a wandering twist for a sudden one,
                // so the residual angle at the far end is measured and spread
                // evenly along the run. The result is continuous with the
                // element at both ends and turns at a constant, minimal rate in
                // between.
                if (isProt && renderer._loopFrame !== 'curvature') {
                    const tanOf = (j) => {
                        const p0 = at(wrapIdx(j - 1));
                        const p1 = at(wrapIdx(j + 1));
                        const v = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
                        const m2 = Math.hypot(v[0], v[1], v[2]) || 1;
                        return [v[0] / m2, v[1] / m2, v[2] / m2];
                    };
                    const proj = (v, t) => {
                        const d = v[0] * t[0] + v[1] * t[1] + v[2] * t[2];
                        const o = [v[0] - d * t[0], v[1] - d * t[1], v[2] - d * t[2]];
                        const m2 = Math.hypot(o[0], o[1], o[2]);
                        return m2 > 1e-9 ? [o[0] / m2, o[1] / m2, o[2] / m2] : null;
                    };
                    // rotate v about unit axis k by angle a (Rodrigues)
                    const rot = (v, k, a) => {
                        const c = Math.cos(a); const si = Math.sin(a);
                        const d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
                        return [
                            v[0] * c + (k[1] * v[2] - k[2] * v[1]) * si + k[0] * d * (1 - c),
                            v[1] * c + (k[2] * v[0] - k[0] * v[2]) * si + k[1] * d * (1 - c),
                            v[2] * c + (k[0] * v[1] - k[1] * v[0]) * si + k[2] * d * (1 - c),
                        ];
                    };
                    // WHAT COUNTS AS AN ELEMENT, for framing. Not the SS
                    // letter - whether the residue has a face worth keeping. A
                    // helix does: its curvature points at its own axis. A strand
                    // does only where the sheet frame reached it; a strand
                    // residue the sheet missed has nothing but the pleat normal,
                    // which alternates side every residue and carries no
                    // information about the sheet's plane.
                    //
                    // Pinning the ribbon to that is worse than not pinning it at
                    // all. 1YP8 model 14 reads E C E C H H H at its start: the
                    // lone 'E' at residue 2 has a single-residue loop on either
                    // side, so the frame had to swing out to the pleat normal
                    // and back within one step each way - the twist at residue
                    // 3. Treated as loop, the transport simply carries the face
                    // through it, and the mismatch that was jammed into one
                    // residue is spread over three.
                    const isElAt = (j) => (sec[j] === 'H'
                        || (sec[j] === 'E' && !!(sheetSides && sheetSides[j])));
                    const isLoopAt = (j) => !isElAt(j);
                    // Maximal runs of one kind, wrapping on a ring so a loop
                    // that crosses the closure is ONE run rather than two
                    // half-loops that each seed themselves from nothing.
                    const runsOf = (want) => {
                        const seen = new Uint8Array(span);
                        const out = [];
                        for (let i = lo; i <= hi; i++) {
                            if (!want(i) || seen[i - lo]) continue;
                            let s0 = i;
                            if (cyclic) {
                                let g = 0;
                                while (want(wrapIdx(s0 - 1)) && g++ < span) s0 = wrapIdx(s0 - 1);
                            } else {
                                while (s0 > lo && want(s0 - 1)) s0--;
                            }
                            const list = [];
                            let j = s0;
                            let g = 0;
                            while (want(j) && !seen[j - lo] && g++ <= span) {
                                seen[j - lo] = 1;
                                list.push(j);
                                if (!cyclic && j >= hi) break;
                                j = cyclic ? wrapIdx(j + 1) : j + 1;
                            }
                            if (list.length) out.push(list);
                        }
                        return out;
                    };
                    const elems = runsOf(isElAt);
                    const loops = runsOf(isLoopAt);
                    const elemOf = new Int32Array(span).fill(-1);
                    elems.forEach((el, ei) => el.forEach((j) => { elemOf[j - lo] = ei; }));

                    // ELEMENT-INTERNAL SIGN, in the element's OWN order, which
                    // wraps. The continuity pass far above walks lo..hi, so an
                    // element spanning the closure - a helix straight through
                    // the seam, as in the AS-48 bacteriocins - has its chain
                    // broken at exactly that step and the strip arrives there
                    // reversed. Flipping to agree costs nothing: a helix side
                    // turns ~100 degrees per residue, and the flipped 80 draws
                    // the same band. What matters is only that consecutive
                    // vectors are not ANTIparallel, which is what makes the
                    // strip between two stations pinch through zero and cross.
                    for (const el of elems) {
                        for (let k = 1; k < el.length; k++) {
                            const a = sides[el[k - 1] - lo];
                            const b = sides[el[k] - lo];
                            if (!a || !b) continue;
                            if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0) {
                                sides[el[k] - lo] = [-b[0], -b[1], -b[2]];
                            }
                        }
                    }

                    // ORDER. Each loop reconciles the two elements it joins, so
                    // nothing accumulates around the ring - the twist a loop
                    // absorbs is its own neighbours' mismatch, measured at 11-86
                    // degrees on 1YP8 rather than the ring's total. The element
                    // signs are shared between adjacent loops though, so on a
                    // ring the cycle may not close: exactly one loop can be left
                    // with the complement of its residual. Process the LONGEST
                    // loop last so that leftover lands where it is spread over
                    // the most residues - and in the Richardson preset a loop's
                    // thickness equals its width, so its face has no observable
                    // orientation and the leftover is free.
                    const order = loops.map((_, k) => k);
                    if (cyclic && loops.length > 1) {
                        let longest = 0;
                        for (let k = 1; k < loops.length; k++) {
                            if (loops[k].length > loops[longest].length) longest = k;
                        }
                        order.splice(order.indexOf(longest), 1);
                        order.push(longest);
                    }
                    const locked = new Uint8Array(elems.length);
                    for (const li of order) {
                        const L = loops[li];
                        const first = L[0];
                        const last = L[L.length - 1];
                        const prevI = cyclic ? wrapIdx(first - 1) : first - 1;
                        const nextI = cyclic ? wrapIdx(last + 1) : last + 1;
                        const hasPrev = prevI >= lo && prevI <= hi && isElAt(prevI);
                        const hasNext = nextI >= lo && nextI <= hi && isElAt(nextI);
                        if (hasPrev && elemOf[prevI - lo] >= 0) locked[elemOf[prevI - lo]] = 1;
                        // seed from the element before the run, else its own side
                        let cur = sides[(hasPrev ? prevI : first) - lo];
                        const out = [];
                        for (const j of L) {
                            const t = tanOf(j);
                            const pj = proj(cur, t);
                            if (pj) cur = pj;
                            out.push(cur);
                        }
                        // residual against the element after the run
                        if (hasNext && out.length) {
                            const tEnd = tanOf(last);
                            let want = proj(sides[nextI - lo], tEnd);
                            const have = out[out.length - 1];
                            if (want) {
                                let dp = have[0] * want[0] + have[1] * want[1] + have[2] * want[2];
                                dp = Math.max(-1, Math.min(1, dp));
                                // AN ELEMENT'S FACE IS A DIRECTION, NOT AN
                                // ORIENTATION: negating it draws the same ribbon.
                                // So flip the element rather than make the loop
                                // twist more than 90 degrees to reach it. Only
                                // while it is still free - once a loop has been
                                // solved against an element, that element is
                                // fixed, or this would undo the earlier one.
                                const eid = elemOf[nextI - lo];
                                if (dp < 0 && eid >= 0 && !locked[eid]) {
                                    for (const j of elems[eid]) {
                                        const sv = sides[j - lo];
                                        sides[j - lo] = [-sv[0], -sv[1], -sv[2]];
                                    }
                                    want = [-want[0], -want[1], -want[2]];
                                    dp = -dp;
                                }
                                if (eid >= 0) locked[eid] = 1;
                                let ang = Math.acos(dp);
                                const cx = have[1] * want[2] - have[2] * want[1];
                                const cy = have[2] * want[0] - have[0] * want[2];
                                const cz = have[0] * want[1] - have[1] * want[0];
                                if (cx * tEnd[0] + cy * tEnd[1] + cz * tEnd[2] < 0) ang = -ang;
                                const nSteps = out.length;
                                for (let k = 0; k < nSteps; k++) {
                                    const f = (k + 1) / nSteps;
                                    out[k] = rot(out[k], tanOf(L[k]), ang * f);
                                }
                            }
                        }
                        for (let k = 0; k < L.length; k++) sides[L[k] - lo] = out[k];
                    }
                }
            }

            // set renderer._sideProbe = null before a render to receive the final
            // ribbon side vector per residue; tests/cyclic_bench.js measures the
            // frame's twist rate from it. Keyed by residue index rather than
            // pushed in order, so a structure with several runs records all of
            // them instead of only the first.
            if (renderer._sideProbe === null) renderer._sideProbe = {};
            if (renderer._sideProbe && isProt) {
                for (let j = lo; j <= hi; j++) {
                    const sv = sides[j - lo];
                    if (sv) renderer._sideProbe[j] = [sv[0], sv[1], sv[2]];
                }
            }

            // Per-RESIDUE half-width and half-thickness for the continuous
            // profile. Loops are square (thickness == width); helices and
            // strands keep the user's thickness setting.
            const WIDTHS = rich ? RICH_HALF_A : SS_HALF_A;
            const halfW = (j) => {
                if (!isProt) return naWidthA * widthScale;
                const jj = wrapIdx(j);
                const t = sec[jj];
                // Every class reads the WIDTH control, loops included. Richardson
                // loops used to take their width from the THICKNESS control so
                // they came out square, which made the two sliders one control
                // in disguise: Width did nothing to a loop and Thick changed its
                // width. They are separate quantities and are now read from
                // separate controls; RICH_HALF_A.C is calibrated so the default
                // still draws the square section the preset is meant to have.
                return (WIDTHS[t] || WIDTHS.C) * widthScale;
            };
            // ARROWHEADS (Richardson preset). The head is HALF a CA-CA step
            // long and sits on the C-terminal end of a strand, so it is a
            // property of the last INTERVAL, not of whole residues. An earlier
            // version widened the final two residues, which made the head as
            // long as the strand's last two steps - far longer than it is
            // drawn, and long enough to swallow short strands whole.
            // The arrow head marks where a strand ENDS. On a ring, running off
            // the end of the index range is not the end of anything: for a
            // strand crossing the closure this fired one interval early and
            // planted a head mid-strand, splitting it into an arrow plus a
            // detached plate on the far side of the seam.
            const isArrowInterval = (j) => {
                if (!arrowsOn || !isProt) return false;
                if (cyclic) {
                    if (j < lo || j > hi) return false;
                    return sec[j] === 'E' && sec[wrapIdx(j + 1)] === 'E'
                        && sec[wrapIdx(j + 2)] !== 'E';
                }
                return j >= lo && j + 1 <= hi
                    && sec[j] === 'E' && sec[j + 1] === 'E'
                    && (j + 2 > hi || sec[j + 2] !== 'E');
            };
            // Thickness. In the DEFAULT cartoon this is ONE setting for the
            // whole strip - loops included. Forcing loops square ignored the
            // thickness control entirely: the Thick slider, and thickness=0
            // which is meant to give flat single-sheet ribbons, did nothing to
            // loops, so a structure came out with flat ribbons joined by fat
            // square loops. Only the WIDTH varies along the chain.
            //
            // The Richardson preset is the exception, and the reason this
            // function had to take an argument: the look REQUIRES flat helices
            // and solid strands simultaneously, which a single global value
            // cannot express. Each class scales the Thick control by its own
            // factor - a helix is 0, so it stays a flat ribbon whatever the
            // slider says.
            // nucleic carries its own default, so the preset reaches the rails
            // through the same value the rungs use
            const thickScaleRaw = !isProt ? naHalfT
                : (renderer.cartoonThickness !== undefined
                    ? renderer.cartoonThickness / 2 : RIBBON_TH_A);

            // THICKNESS IS WHAT THE CONTROL SAYS IT IS, at every scale.
            //
            // It used to taper off as the drawing got small on screen - faded
            // to nothing between a projected half-thickness of 1.0 and 2.5 px -
            // on the argument that a sub-pixel side face reads as a dark fringe
            // rather than as depth. The trouble is that the test was against
            // PROJECTED size, and projected size depends on the structure:
            // fit-to-view scales a large assembly down until its ribbons fall
            // through that window, so loading a bigger file silently flattened
            // the cartoon. The same setting drew with depth or without it
            // according to how many residues the file had, which reads as a bug
            // rather than as perspective.
            //
            // Removed rather than re-tuned: any threshold in screen space has
            // the same property. The control is in Angstrom and now means the
            // same thing whatever it is pointed at.
            const thickScale = thickScaleRaw;
            if (!isProt) naSlabHalfT = thickScale;

            // HELIX RATIO, OVERRIDABLE. RICH_TH_REL.H is 0 - a richardson helix
            // is exactly flat, which is the look - but a zero-thickness piece
            // is also the source of a whole class of trouble for a consumer
            // that rebuilds the surface (it has no outward direction, so it has
            // to be oriented at the eye per view, and edges it shares are
            // interior with nothing to test). A hair of real thickness makes it
            // an ordinary solid. Exposed so that can be tried without touching
            // the constant, and so the two renderers can differ on it.
            const hxRel = (typeof renderer.cartoonHelixThRel === 'number'
                && renderer.cartoonHelixThRel >= 0)
                ? renderer.cartoonHelixThRel : RICH_TH_REL.H;
            const halfT = (j) => {
                if (!rich || !isProt) return thickScale;
                const jj = wrapIdx(j);
                const t = sec[jj];
                const k = t === 'H' ? hxRel
                    : (RICH_TH_REL[t] !== undefined ? RICH_TH_REL[t] : RICH_TH_REL.C);
                return thickScale * k;
            };

            // KEEP THE FINAL SIDE VECTOR, the way the nucleic path keeps
            // naFrames. `sides` is local to this run, and the side chains are
            // built much later from the generic segment list, where they need
            // to know which way the ribbon's FACE points at their residue.
            if (isProt && protSide) {
                for (let j = lo; j <= hi; j++) {
                    const sv = sides[j - lo];
                    if (sv) protSide[j] = sv;
                    // ...and how far out each of the slab's surfaces is. Both,
                    // because a side chain leaves through whichever one it
                    // points at. Per-run scoped like `sides`, for the same
                    // reason: they vary with the richardson per-SS ratios.
                    protHalfT[j] = halfT(j);
                    protHalfW[j] = halfW(j);
                }
            }

            // Is interval j part of the same ribbon element as type t?
            // (Used for end caps: an element boundary closes the outline with
            // a cross-edge stroke, which is what makes a helix-to-loop
            // junction read as a finished ribbon end instead of a raw cut.)
            const sameElem = (j, t) => {
                // On a ring the interval AT hi is the closure, and j == hi is a
                // real interval rather than one past the end - without this an
                // element crossing the seam looks like it stops there.
                if (cyclic) {
                    if (j < lo || j > hi) return false;
                    const jN = j === hi ? lo : j + 1;
                    const sIdx = j === hi ? closeSeg : bbSeg[j];
                    if (sIdx < 0 || !colors[sIdx]) return false;
                    if (!vis(j) || !vis(jN)) return false;
                    if (!isProt) return false;
                    return sec[j] === t && sec[jN] === t;
                }
                if (j < lo || j >= hi) return false;
                const sIdx = bbSeg[j];
                if (sIdx < 0 || !colors[sIdx]) return false;
                if (!vis(j) || !vis(j + 1)) return false;
                if (!isProt) return false;
                return sec[j] === t && sec[j + 1] === t;
            };

            // TUBE RUN ACCUMULATOR. Consecutive loop intervals are merged
            // into ONE polyline before emitting. Per-interval tubes meet at a
            // shared knot, and every fix for that joint failed in a different
            // way: round caps let the next tube's wide shadow band erase the
            // previous tube's narrow highlight (dashes), butt caps left a
            // wedge on the outside of turns (triangle gaps, or black where
            // the outline showed through). Both are joint artifacts, so the
            // fix is to have no joint - exactly the reasoning already written
            // down for why an interval is one polyline rather than per-sample
            // segments. A merged run has round caps only at its free ends,
            // and lineJoin handles every turn inside it.
            let tubeRun = null;
            const flushTubeRun = () => {
                if (!tubeRun) return;
                if (tubeRun.pts.length >= 2) {
                    // SPLIT AT DEPTH TURNING POINTS.
                    // A merged run is ONE primitive with ONE depth key - the
                    // mean over the whole polyline - and it is stroked in PATH
                    // order, so within a run a later segment paints over an
                    // earlier one no matter which is nearer. Measured on 1TIM,
                    // loop runs span up to 15.2 A in depth, so the far side of a
                    // loop was drawn on top of its near side.
                    //
                    // Merging exists to avoid joints (per-interval tubes left
                    // dashes and wedges at every knot), so this splits as little
                    // as possible: only where the polyline stops receding and
                    // starts approaching, or vice versa. Each piece is then
                    // monotonic in depth and sorts honestly, and the splits sit
                    // exactly at depth EXTREMA - where the two pieces are at the
                    // same depth, so their shared round cap overlaps rather than
                    // showing a seam.
                    const pts = tubeRun.pts;
                    const cuts = [0];
                    for (let k = 1; k + 1 < pts.length; k++) {
                        const dPrev = pts[k][2] - pts[k - 1][2];
                        const dNext = pts[k + 1][2] - pts[k][2];
                        if (dPrev !== 0 && dNext !== 0
                            && (dPrev > 0) !== (dNext > 0)) cuts.push(k);
                    }
                    cuts.push(pts.length - 1);
                    for (let c = 0; c + 1 < cuts.length; c++) {
                        const a0 = cuts[c];
                        const e0 = cuts[c + 1];
                        if (e0 <= a0) continue;
                        const seg = pts.slice(a0, e0 + 1);
                        let zs = 0;
                        let ps = 0;
                        for (const q of seg) { zs += q[2]; ps += q[3]; }
                        const prim = {
                            kind: 'tube',
                            pts: seg,
                            // where this piece sits along the chain, for the
                            // drawing animation; interpolated across the run
                            // so a long loop is drawn along its length rather
                            // than appearing whole
                            gs0: tubeRun.i0 + (tubeRun.i1 - tubeRun.i0)
                                * (a0 / Math.max(1, pts.length - 1)),
                            // ext carries one extension point beyond each end
                            // of the WHOLE run; the paint path only uses it when
                            // its length matches the piece, so a split piece
                            // simply falls back to its own endpoints.
                            ext: (a0 === 0 && e0 === pts.length - 1)
                                ? tubeRun.ext : null,
                            z: zs / seg.length,
                            pe: ps / seg.length,
                            c: tubeRun.c,
                            tubeA: tubeRun.tubeA,
                        };
                        // EVERY piece needs a key at BOTH ends: registerJoint is
                        // what creates prim.joints, and the cap logic reads
                        // g.joints[0] unconditionally - interior pieces with no
                        // joints crashed the render. The outer ends keep the
                        // run's residue keys so they still pair with the
                        // neighbouring ribbon; each interior split gets one key
                        // SHARED by the two pieces that meet there, so the
                        // earlier-drawn of the pair takes the round cap and
                        // covers the seam, exactly as at any other joint.
                        registerJoint(a0 === 0
                            ? `R${tubeRun.i0}` : `T${tubeRun.i0}_${a0}`, prim);
                        registerJoint(e0 === pts.length - 1
                            ? `R${tubeRun.i1}` : `T${tubeRun.i0}_${e0}`, prim);
                        prims.push(prim);
                    }
                }
                tubeRun = null;
            };

            // A CYCLIC run takes one extra step, from hi back to lo, so the
            // closure is built by the same ribbon code as every other interval
            // rather than drawn as a separate stick. iN is the next residue,
            // wrapping on that last step; the body below is otherwise unchanged
            // and simply never sees the seam as special.
            const lastStep = cyclic ? hi : hi - 1;
            for (let i = lo; i <= lastStep; i++) {
                const iN = (i === hi) ? lo : i + 1;
                const segIdx = (i === hi) ? closeSeg : bbSeg[i];
                if (segIdx < 0) { flushTubeRun(); continue; }
                if (!vis(i) || !vis(iN)) { flushTubeRun(); continue; }
                // SS COLOURING IS PER-INTERVAL, NOT PER-RESIDUE.
                // viewer-mol.js gives every segment the colour of ONE residue -
                // segInfo.origIndex, its first - which is fine for schemes that
                // vary smoothly along the chain but wrong for a scheme with
                // hard class boundaries. The interval spanning a strand's last
                // residue and the following loop residue inherited the strand's
                // green, so the loop leaving an arrow tip was always painted as
                // sheet. An interval belongs to an element only if BOTH of its
                // ends do; a transition interval is coil.
                // ... EXCEPT that a HELIX wins its transition intervals. A
                // strand stops dead at its arrow tip, so the interval leaving
                // the tip really is loop - that is the case this rule was
                // written for. A helix does not stop: the ribbon is still
                // spiralling across the interval that leaves it, and calling
                // that interval coil cut the spiral a residue early and left a
                // stub of loop colour on the end of every helix. So: both ends
                // agree -> that class; otherwise H if either end is H; else coil.
                const ssCls = isProt
                    ? ((sec[i] === sec[iN]) ? sec[i]
                        : ((sec[i] === 'H' || sec[iN] === 'H') ? 'H' : 'C'))
                    : 'C';
                // Is this interval's colour EXPLICIT (set by hand from the
                // selection tools or set_color) rather than coming from a mode?
                // Only asked when the object actually carries overrides, so the
                // usual path costs nothing.
                const ovI = hasColorOverrides && renderer.getColorOverride
                    ? renderer.getColorOverride(i) : null;
                const ovN = hasColorOverrides && renderer.getColorOverride
                    ? renderer.getColorOverride(iN) : null;
                // A COLOUR BELONGS TO A RESIDUE, BUT AN INTERVAL SPANS TWO.
                //
                // colors[segIdx] is getAtomColor(idx1) - a segment takes its
                // FIRST residue's colour - so colouring residue 5 painted the
                // ribbon from 5 to 6 and left 4 to 5 alone: a band the right
                // width but half a residue late, sitting between residues
                // rather than around the one that was picked. The ss-palette
                // path had the opposite fault, taking an override from EITHER
                // end, which painted both neighbouring intervals and made one
                // residue read as two.
                //
                // Both ends are resolved instead, and where they differ the
                // interval is cut at its midpoint (below) so each half takes
                // its own end's colour. A single coloured residue then runs
                // from the midpoint before it to the midpoint after it - one
                // residue's width, centred on the residue.
                let col = colors[segIdx];
                let colFar = col;
                if (ssColor && isProt) {
                    // An explicit per-residue/chain colour BEATS the palette:
                    // ss colouring is a mode, and a colour the user set by hand
                    // (selection tools, or set_color from Python) is not. Without
                    // this the palette overwrote it and manual colouring silently
                    // did nothing in ss mode.
                    const pal = ssPal[ssCls] || ssPal.C;
                    col = ovI || pal || col;
                    colFar = ovN || pal || colors[segIdx];
                } else if (hasColorOverrides && renderer.getAtomColor) {
                    // Only asked for when the object carries overrides at all,
                    // so the usual path costs nothing extra.
                    colFar = renderer.getAtomColor(iN) || col;
                }
                const twoTone = !!(col && colFar && col !== colFar
                    && (col.r !== colFar.r || col.g !== colFar.g || col.b !== colFar.b));
                if (!col) { flushTubeRun(); continue; }
                // Offscreen: contributes nothing on screen and cannot occlude
                // anything that is - skip before building any geometry. Ends
                // the current tube run exactly like an invisible interval.
                if (cullSeg(at(i), at(iN))) { flushTubeRun(); continue; }
                const t0 = isProt ? sec[i] : 'C';
                const t1 = isProt ? sec[iN] : 'C';
                const isElem = (t0 === 'H' || t0 === 'E') && t0 === t1;
                // In square-loop mode EVERY interval the tube branch would
                // otherwise take is built by the strip pipeline instead
                // (SS_HALF_A.C wide, and square: see the thickness override
                // in evalSlab's caller below). That deliberately includes
                // JUNCTION intervals - the ones spanning a helix/strand end
                // and the following coil, or two different element types.
                // Matching on t0 === 'C' && t1 === 'C' alone left every one of
                // those as a round tube, so a structure came out only partly
                // square, with a stub of tube at both ends of every element.
                // Richardson loops stay on the CONTINUOUS STRIP, like every
                // other cartoon style. Routing them to the round tube branch was
                // tried and reverted: it gives a genuinely round section, but a
                // tube is a separate primitive, so the helix ribbon simply stops
                // and a thin tube starts - there is no junction. The strip's
                // defining property is that width and thickness are a PROFILE
                // along the chain, so an element morphs into its loop across the
                // transition, which is what the drawings show and what the tube
                // version lost. Roundness is approached by shading instead - see
                // the directional edge lighting in the paint pass.
                const squareLoop = (loopSquare || loopCont) && !isElem;
                const ribbon = isElem || squareLoop;
                // width/thickness come from the per-residue profile
                const profiled = loopCont;

                if (ribbon) {
                    flushTubeRun();
                    // The whole interval is ONE strip primitive holding all its
                    // subdivision stations. Edges stroke as continuous
                    // polylines with round joins and the outline band is a
                    // single polygon, where per-quad primitives left a seam
                    // and a paint-order notch at every subdivision.
                    // A junction interval has t0 = 'H' or 'E' but is being
                    // drawn as a loop, so the width must come from the LOOP
                    // entry, not from t0 - otherwise the stub leaving a helix
                    // is drawn at full helix width.
                    // A NUCLEIC RAIL IS A SQUARE SECTION, so its thickness and
                    // its width are the same number - which is why the Thickness
                    // control never appeared to reach it. For nucleic that one
                    // number is naHalfT, so the rail has the body a duplex
                    // backbone needs instead of the 0.42 coil half-width it
                    // inherited from protein loops.
                    // ...floored at the coil half-width it used to have, so a
                    // rail keeps its WIDTH when the thickness goes to zero.
                    // Without the floor a flat preset took the whole section to
                    // nothing and the nucleic backbone disappeared: thickness 0
                    // means flat, not absent.
                    const hw = (!isProt ? Math.max(SS_HALF_A.C, naHalfT)
                        : (squareLoop ? SS_HALF_A.C : SS_HALF_A[t0]))
                        * widthScale;
                    // Profile endpoints for this interval. halfW/halfT are
                    // keyed on the RESIDUE, not the interval, so the value at
                    // a shared residue is identical from both sides and the
                    // strip is C0 continuous across every interval boundary.
                    // The interval FOLLOWING an arrowhead drops straight to
                    // loop size instead of restarting at strand size.
                    // Width is keyed on the residue, and a strand's last
                    // residue is still 'E', so this interval used to begin at
                    // full strand width - immediately after the head had
                    // tapered to a point - and narrow again over one step. That
                    // second taper is a triangle sitting right behind the tip,
                    // which reads as a second arrowhead. Starting it at the
                    // loop's own profile makes the loop leave the point at loop
                    // size, with no ghost.
                    const afterArrow = isArrowInterval(cyclic ? wrapIdx(i - 1) : i - 1);
                    // Mirror case at the OTHER end: the interval running into a
                    // strand's N-terminus used to ramp up from loop width to
                    // strand width, so the strand faded in as a long wedge
                    // instead of starting. Holding this interval at loop width
                    // leaves a clean step at the first strand residue, which is
                    // where the flat back face belongs (capped below).
                    const beforeStrand = arrowsOn && isProt && iN <= hi
                        && sec[iN] === 'E' && sec[i] !== 'E';
                    const hwA = profiled
                        ? halfW(afterArrow ? iN : i) : hw;
                    const hwB = profiled
                        ? halfW(beforeStrand ? i : iN) : hw;
                    const htA = profiled
                        ? halfT(afterArrow ? iN : i) : null;
                    const htB = profiled
                        ? halfT(beforeStrand ? i : iN) : null;
                    const arrowHead = isArrowInterval(i);
                    const arrowBase = (WIDTHS.E || SS_HALF_A.E) * widthScale;
                    const s1 = sides[i - lo];
                    let s2 = sides[iN - lo];
                    // BOWTIE GUARD. A strip whose two end sides point opposite
                    // ways crosses itself - the corners swap and the interval
                    // renders as an hourglass. Inside a run this cannot happen:
                    // the continuity pass above walks lo..hi flipping each side
                    // to agree with its predecessor. The closure interval is
                    // the one pair that pass never compares, so whatever sign
                    // the ring accumulates on its way round lands exactly here
                    // (1YP8 model 2, where the two sheet frames themselves
                    // agree to within 0.1 degree - it is the propagated sign,
                    // not the frame, that is inverted). Flip it back for this
                    // strip; a ring whose parity is genuinely odd still has to
                    // put half a twist somewhere, but a smooth twist beats a
                    // self-intersection.
                    if (s1 && s2
                        && s1[0] * s2[0] + s1[1] * s2[1] + s1[2] * s2[2] < 0) {
                        s2 = [-s2[0], -s2[1], -s2[2]];
                    }
                    const pa = at(i);
                    const pb = at(iN);
                    // Ribbons have THICKNESS. An infinitely thin strip
                    // projects to a degenerate sliver at tangency, and
                    // everything downstream of that (fold detection, cusp
                    // interpolation, cut curves, sliver modes, lobe ordering)
                    // existed to patch around the degeneracy. A slab never
                    // degenerates: at grazing you see its SIDE face, and the
                    // silhouette is the pointwise outermost of four
                    // well-defined corner curves - nothing to detect.
                    //
                    // Sampling comes from the Detail control alone (see
                    // subFloor): the same subdivisions per residue at every
                    // canvas size, zoom and rotation.
                    let nsub = subFloor(t0 === 'H' ? HELIX_SUB
                        : (FLAT_SHEETS ? SHEET_SUB : 2));
                    // Helix-exact tangents (two-term stencil) for helices;
                    // Catmull-Rom tangents for the nearly straight (and
                    // flattened) strands.
                    const tanAt = (j) => {
                        const q1 = at(wrapIdx(j - 1));
                        const q2 = at(wrapIdx(j + 1));
                        if (t0 === 'H') {
                            if (!cyclic && j - 2 < lo && j + 3 <= hi) {
                                // one-sided forward (N-terminal end)
                                const p0 = at(j);
                                const pa = at(j + 1);
                                const pb = at(j + 2);
                                const pc = at(j + 3);
                                return [
                                    HT1_A * (pa.x - p0.x) + HT1_B * (pb.x - p0.x) + HT1_C * (pc.x - p0.x),
                                    HT1_A * (pa.y - p0.y) + HT1_B * (pb.y - p0.y) + HT1_C * (pc.y - p0.y),
                                    HT1_A * (pa.z - p0.z) + HT1_B * (pb.z - p0.z) + HT1_C * (pc.z - p0.z),
                                ];
                            }
                            if (!cyclic && j + 2 > hi && j - 3 >= lo) {
                                // one-sided backward (C-terminal end)
                                const p0 = at(j);
                                const pa = at(j - 1);
                                const pb = at(j - 2);
                                const pc = at(j - 3);
                                return [
                                    -(HT1_A * (pa.x - p0.x) + HT1_B * (pb.x - p0.x) + HT1_C * (pc.x - p0.x)),
                                    -(HT1_A * (pa.y - p0.y) + HT1_B * (pb.y - p0.y) + HT1_C * (pc.y - p0.y)),
                                    -(HT1_A * (pa.z - p0.z) + HT1_B * (pb.z - p0.z) + HT1_C * (pc.z - p0.z)),
                                ];
                            }
                            const q0w = at(wrapIdx(j - 2));
                            const q3w = at(wrapIdx(j + 2));
                            return [
                                HTAN_A * (q2.x - q1.x) + HTAN_B * (q3w.x - q0w.x),
                                HTAN_A * (q2.y - q1.y) + HTAN_B * (q3w.y - q0w.y),
                                HTAN_A * (q2.z - q1.z) + HTAN_B * (q3w.z - q0w.z),
                            ];
                        }
                        return [
                            0.5 * (q2.x - q1.x),
                            0.5 * (q2.y - q1.y),
                            0.5 * (q2.z - q1.z),
                        ];
                    };
                    const mA = tanAt(i);
                    const mB = tanAt(iN);
                    // seam parameter: the u at which ARROW_LEN_A of arc length
                    // remains. Chord-sampled; the interval is short and nearly
                    // straight, so 16 samples are well past converged.
                    let arrowU = 0.5;
                    if (arrowHead) {
                        const SN = 16;
                        const cum = new Float64Array(SN + 1);
                        const tmpP = [0, 0, 0];
                        let px = 0; let py = 0; let pz = 0;
                        for (let k = 0; k <= SN; k++) {
                            hermiteV(pa, pb, mA, mB, k / SN, tmpP);
                            if (k > 0) {
                                cum[k] = cum[k - 1] + Math.hypot(
                                    tmpP[0] - px, tmpP[1] - py, tmpP[2] - pz);
                            }
                            px = tmpP[0]; py = tmpP[1]; pz = tmpP[2];
                        }
                        const total = cum[SN];
                        if (total > 1e-6) {
                            // never let the head eat the whole interval
                            const want = Math.min(total * 0.85, ARROW_LEN_A);
                            const target = total - want;
                            let k = SN;
                            while (k > 0 && cum[k - 1] > target) k--;
                            const c0 = cum[Math.max(0, k - 1)];
                            const c1 = cum[k];
                            const f = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
                            arrowU = Math.min(0.98, Math.max(0.02,
                                (k - 1 + f) / SN));
                        }
                        // set renderer._arrowProbe = [] before a render to
                        // collect the realised head geometry; the point of the
                        // arc-length solve is that these come out CONSTANT
                        // across strands and across flatten settings, which is
                        // only checkable by measuring what was actually built
                        if (renderer._arrowProbe) {
                            renderer._arrowProbe.push({
                                i,
                                len: +(total - cum[0] > 0
                                    ? (total - (total - Math.min(total * 0.85,
                                        ARROW_LEN_A))) : 0).toFixed(4),
                                w: +(arrowBase * RICH_ARROW_W).toFixed(4),
                                u: +arrowU.toFixed(4),
                                interval: +total.toFixed(4),
                            });
                        }
                    }
                    // The ribbon normal is carried along the interval by the
                    // SAME Hermite scheme as the centre line, with tangents
                    // shared across residue boundaries. Per-interval slerp is
                    // continuous in VALUE at a boundary but not in RATE - each
                    // interval rotates the normal at its own speed - and that
                    // slope kink bends the edge curves at every residue
                    // boundary. Near grazing the projection amplifies the kink
                    // into adjacent intervals' edge arcs visibly CROSSING,
                    // with the fill honestly following its own segment's edge
                    // and leaving a wedge. Shared tangents make the edges C1.
                    // The helix stencil applies because side vectors rotate at
                    // the same 100 degrees per residue as the positions.
                    const sideTanAt = (j) => {
                        const q1 = sides[wrapIdx(j - 1) - lo];
                        const q2 = sides[wrapIdx(j + 1) - lo];
                        if (t0 === 'H') {
                            const jl = j - lo;
                            const nL = hi - lo;
                            if (jl - 2 < 0 && jl + 3 <= nL) {
                                const p0 = sides[jl];
                                const pa = sides[jl + 1];
                                const pb = sides[jl + 2];
                                const pc = sides[jl + 3];
                                return [
                                    HT1_A * (pa[0] - p0[0]) + HT1_B * (pb[0] - p0[0]) + HT1_C * (pc[0] - p0[0]),
                                    HT1_A * (pa[1] - p0[1]) + HT1_B * (pb[1] - p0[1]) + HT1_C * (pc[1] - p0[1]),
                                    HT1_A * (pa[2] - p0[2]) + HT1_B * (pb[2] - p0[2]) + HT1_C * (pc[2] - p0[2]),
                                ];
                            }
                            if (jl + 2 > nL && jl - 3 >= 0) {
                                const p0 = sides[jl];
                                const pa = sides[jl - 1];
                                const pb = sides[jl - 2];
                                const pc = sides[jl - 3];
                                return [
                                    -(HT1_A * (pa[0] - p0[0]) + HT1_B * (pb[0] - p0[0]) + HT1_C * (pc[0] - p0[0])),
                                    -(HT1_A * (pa[1] - p0[1]) + HT1_B * (pb[1] - p0[1]) + HT1_C * (pc[1] - p0[1])),
                                    -(HT1_A * (pa[2] - p0[2]) + HT1_B * (pb[2] - p0[2]) + HT1_C * (pc[2] - p0[2])),
                                ];
                            }
                            const q0w = sides[wrapIdx(j - 2) - lo];
                            const q3w = sides[wrapIdx(j + 2) - lo];
                            return [
                                HTAN_A * (q2[0] - q1[0]) + HTAN_B * (q3w[0] - q0w[0]),
                                HTAN_A * (q2[1] - q1[1]) + HTAN_B * (q3w[1] - q0w[1]),
                                HTAN_A * (q2[2] - q1[2]) + HTAN_B * (q3w[2] - q0w[2]),
                            ];
                        }
                        return [
                            0.5 * (q2[0] - q1[0]),
                            0.5 * (q2[1] - q1[1]),
                            0.5 * (q2[2] - q1[2]),
                        ];
                    };
                    const nTanA = sideTanAt(i);
                    const nTanB = sideTanAt(iN);
                    // Concavity of the CENTERLINE (discrete second
                    // difference, averaged over the interval ends): points
                    // toward the inside of the local curve - for a helix,
                    // toward the axis. This is what "inner face" means
                    // geometrically; the +-b labels are an accident of the
                    // side-vector seed and differ between helices. Nearly
                    // straight strands have tiny curvature and the weight
                    // fades the distinction out.
                    let kvx = 0;
                    let kvy = 0;
                    let kvz = 0;
                    {
                        const qm = at(wrapIdx(i - 1));
                        const q1 = at(i);
                        const q2 = at(iN);
                        const qp = at(wrapIdx(i + 2));
                        kvx = (qm.x + q2.x - 2 * q1.x + q1.x + qp.x - 2 * q2.x) / 2;
                        kvy = (qm.y + q2.y - 2 * q1.y + q1.y + qp.y - 2 * q2.y) / 2;
                        kvz = (qm.z + q2.z - 2 * q1.z + q1.z + qp.z - 2 * q2.z) / 2;
                        const km = Math.hypot(kvx, kvy, kvz);
                        // weight: full for helix-like curvature (~5 A per
                        // residue^2), zero for nearly straight strands
                        const kw = Math.min(1, Math.max(0, (km - 0.5) / 1.5));
                        if (km > 1e-9) {
                            kvx = (kvx / km) * kw;
                            kvy = (kvy / km) * kw;
                            kvz = (kvz / km) * kw;
                        }
                    }
                    // Slab corners at chain parameter u in [0, 1]: width
                    // direction n (C1 Hermite - tangents shared across residue
                    // boundaries, so the edges have no boundary kinks), face
                    // normal b = tangent x n; corners = centre +-n*hw +-b*ht.
                    // Thickness option: config.rendering.thickness (A,
                    // total) via renderer.cartoonThickness; 0 = flat
                    // single-sheet ribbons (the original look).
                    // ABSOLUTE, not scaled by the Width slider: thickness
                    // is its own option now, and coupling it to width made
                    // the Width control appear to change thickness too.
                    // Square section for loops: half-thickness == half-width,
                    // so the slab is a square-section tube and reads as a
                    // loop rather than a flattened ribbon. Helices and
                    // strands keep the user's thickness setting.
                    // A NUCLEIC RAIL IS NOT LOCKED SQUARE. Protein loops are -
                    // ht = hw is what makes a coil read as a tube - but tying
                    // the two together for nucleic means thickness 0 can only
                    // be reached by taking the width to 0 as well, and the
                    // backbone vanishes instead of going flat. Width and
                    // thickness are separate here, so ribbon mode gives a flat
                    // rail of full width and the extra faces have no area at
                    // all (see the zero-thickness guard in the painter).
                    // THE PER-SS RATIO DELIBERATELY DOES NOT REACH HERE.
                    //
                    // Routing this through halfT() was tried, on the reasoning
                    // that the richardson ratios should apply on every path and
                    // not only through htA/htB on the `profiled` one. It is a
                    // defensible reading, but it is a GEOMETRY change to both
                    // renderers, not a fix: on a non-profiled interval a helix
                    // went from the Thick slider's value to exactly zero, which
                    // moves silhouettes across the whole structure and so moves
                    // every outline that follows them. Reverted rather than
                    // carried while the outline rules were being changed
                    // underneath it - two moving parts, one picture.
                    //
                    // If it is wanted, the change is `halfT(i)` here, and it
                    // needs looking at on its own with the ink rules stable.
                    const htFlat = !isProt ? (naSlabHalfT !== null ? naSlabHalfT : naHalfT)
                        : (squareLoop ? hw
                            : (renderer.cartoonThickness !== undefined
                                ? renderer.cartoonThickness / 2
                                : RIBBON_TH_A));
                    const ht = htFlat;
                    const evalSlab = (u, afterSeam) => {
                        hermiteV(pa, pb, mA, mB, u, q0);
                        const t2 = u * u;
                        const t3 = t2 * u;
                        const h00 = 2 * t3 - 3 * t2 + 1;
                        const h10 = t3 - 2 * t2 + u;
                        const h01 = -2 * t3 + 3 * t2;
                        const h11 = t3 - t2;
                        let nx = h00 * s1[0] + h10 * nTanA[0] + h01 * s2[0] + h11 * nTanB[0];
                        let ny = h00 * s1[1] + h10 * nTanA[1] + h01 * s2[1] + h11 * nTanB[1];
                        let nz = h00 * s1[2] + h10 * nTanA[2] + h01 * s2[2] + h11 * nTanB[2];
                        let m = Math.hypot(nx, ny, nz) || 1;
                        nx /= m; ny /= m; nz /= m;
                        // centre-line tangent = Hermite derivative
                        const d00 = 6 * t2 - 6 * u;
                        const d10 = 3 * t2 - 4 * u + 1;
                        const d01 = -6 * t2 + 6 * u;
                        const d11 = 3 * t2 - 2 * u;
                        const tx = d00 * pa.x + d10 * mA[0] + d01 * pb.x + d11 * mB[0];
                        const ty = d00 * pa.y + d10 * mA[1] + d01 * pb.y + d11 * mB[1];
                        const tz = d00 * pa.z + d10 * mA[2] + d01 * pb.z + d11 * mB[2];
                        if (!isProt && s1 && s2) {
                            // A cubic interpolation of frame vectors is not
                            // a rotation: it overshoots between residues and
                            // creates a small roll/bulge at every boundary.
                            // Interpolate on the unit sphere, then make the
                            // result exactly perpendicular to the centerline.
                            let fd = s1[0] * s2[0] + s1[1] * s2[1] + s1[2] * s2[2];
                            fd = Math.max(-1, Math.min(1, fd));
                            let fw0 = 1 - u;
                            let fw1 = u;
                            const fa = Math.acos(fd);
                            const fs = Math.sin(fa);
                            if (fs > 1e-6) {
                                fw0 = Math.sin((1 - u) * fa) / fs;
                                fw1 = Math.sin(u * fa) / fs;
                            }
                            nx = fw0 * s1[0] + fw1 * s2[0];
                            ny = fw0 * s1[1] + fw1 * s2[1];
                            nz = fw0 * s1[2] + fw1 * s2[2];
                            const tl = Math.hypot(tx, ty, tz) || 1;
                            const td = (nx * tx + ny * ty + nz * tz) / (tl * tl);
                            nx -= tx * td; ny -= ty * td; nz -= tz * td;
                            const nl = Math.hypot(nx, ny, nz) || 1;
                            nx /= nl; ny /= nl; nz /= nl;
                        }
                        let bx = ty * nz - tz * ny;
                        let by = tz * nx - tx * nz;
                        let bz = tx * ny - ty * nx;
                        m = Math.hypot(bx, by, bz) || 1;
                        // UNIT face normal for orientation values - they
                        // must not collapse when the thickness is 0
                        const ubx = bx / m;
                        const uby = by / m;
                        const ubz = bz / m;
                        // Width/thickness at THIS station. Smoothstep, not
                        // linear: a linear blend leaves a visible crease in
                        // the silhouette at the residue where the profile
                        // starts changing, because the width's derivative
                        // jumps there. Smoothstep is C1 at both ends, so the
                        // ribbon flares out of a helix and tapers into a loop
                        // without a corner.
                        let hwU = hw;
                        let htU = ht;
                        if (profiled) {
                            const uu = u * u * (3 - 2 * u);
                            hwU = hwA + (hwB - hwA) * uu;
                            htU = htA + (htB - htA) * uu;
                        }
                        if (arrowHead) {
                            // Shaft width up to the seam, then a straight
                            // LINEAR taper from the barb tips to the point.
                            // Linear, not smoothstep: an arrow's edges are
                            // straight, and easing them turns it into a leaf.
                            const v = afterSeam
                                ? (u - arrowU) / (1 - arrowU) : 0;
                            hwU = afterSeam
                                ? arrowBase * RICH_ARROW_W
                                    + (RICH_ARROW_TIP * widthScale
                                        - arrowBase * RICH_ARROW_W) * v
                                : arrowBase;
                            // THICKNESS IS CONSTANT through the head. The
                            // arrowhead is a flat plate: it tapers to a point in
                            // the PLANE of the sheet, and its tip is a short
                            // vertical edge, not a point in 3D. Tapering the
                            // thickness too was tried and makes the head a
                            // spike. It looked like a fix for faces going
                            // missing at the tip when viewed from above, but the
                            // top face narrowing to a sliver there is simply
                            // what a tapering flat plate looks like from that
                            // angle - the real artifact was never reproduced.
                        }
                        bx = ubx * htU;
                        by = uby * htU;
                        bz = ubz * htU;
                        const wx = nx * hwU;
                        const wy = ny * hwU;
                        const wz = nz * hwU;
                        const cnr = [
                            project(q0[0] + wx + bx, q0[1] + wy + by, q0[2] + wz + bz),
                            project(q0[0] + wx - bx, q0[1] + wy - by, q0[2] + wz - bz),
                            project(q0[0] - wx + bx, q0[1] - wy + by, q0[2] - wz + bz),
                            project(q0[0] - wx - bx, q0[1] - wy - by, q0[2] - wz - bz),
                        ];
                        if (!cnr[0] || !cnr[1] || !cnr[2] || !cnr[3]) return null;
                        // Orientation of the frame vectors AGAINST THE EYE
                        // RAY at this station, not against the world z axis:
                        // under perspective the eye rays diverge, and a face
                        // near the canvas edge can face the eye while its
                        // normal's raw z-component is negative - orientation
                        // by nz alone culled faces (and edges) that were
                        // plainly visible whenever the ortho slider added
                        // perspective. Under ortho the eye ray IS +z and
                        // this reduces to the old values.
                        let vx = 0;
                        let vy = 0;
                        let vz = 1;
                        if (persp) {
                            vx = -q0[0];
                            vy = -q0[1];
                            vz = fl - q0[2];
                            const vm = Math.hypot(vx, vy, vz) || 1;
                            vx /= vm; vy /= vm; vz /= vm;
                        }
                        const tm = Math.hypot(tx, ty, tz) || 1;
                        cnr.push(
                            nx * vx + ny * vy + nz * vz,
                            ubx * vx + uby * vy + ubz * vz,
                            (tx * vx + ty * vy + tz * vz) / tm,
                            // inner-ness of the +b face: how much it points
                            // into the local concavity (weighted unit k)
                            ubx * kvx + uby * kvy + ubz * kvz,
                            // lighting dots: face normal . L, width normal
                            // . L, tangent . L (for cross-section caps)
                            ubx * LIGHT[0] + uby * LIGHT[1] + ubz * LIGHT[2],
                            nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2],
                            (tx * LIGHT[0] + ty * LIGHT[1] + tz * LIGHT[2]) / tm,
                        );
                        // THE FRAME ITSELF, IN MODEL SPACE, for a consumer that
                        // re-uses the geometry at other views. Everything above
                        // is this frame already dotted with the eye or the
                        // light - one view baked in - and a consumer handed only
                        // those has to invert the projection and rebuild the
                        // frame by cross products, which recovers its DIRECTION
                        // but not its SIGN. Nothing in a projected drawing says
                        // which side of a ribbon was the outside.
                        // Off by default: it is three arrays per station that a
                        // normal render never reads.
                        if (frameProbe) {
                            // ub is the FACE normal, n the WIDTH normal (it is
                            // what oN above is built from), t the tangent
                            cnr.push([ubx, uby, ubz],
                                [nx, ny, nz],
                                [tx / tm, ty / tm, tz / tm]);
                        }
                        return cnr; // [L+, L-, R+, R-, n.v, b.v, t.v, b.k, ...]
                    };
                    const Lp = [];
                    const Lm = [];
                    const Rp = [];
                    const Rm = [];
                    const oN = [];
                    const oB = [];
                    const oT = [];
                    const oK = [];
                    const oLb = [];
                    const oLn = [];
                    const oLt = [];
                    // model-space frame per station, only when asked for
                    const mUb = [];
                    const mWa = [];
                    const mT = [];
                    let ok = true;
                    let zSum = 0;
                    // Station parameters. Uniform normally; an arrowhead needs
                    // the seam sampled TWICE - once at shaft width, once at
                    // full barb width - so the step across the barbs is exactly
                    // perpendicular instead of slanting over one sub-interval.
                    const us = [];
                    let seamIdx = -1;
                    if (arrowHead) {
                        const halfN = Math.max(2, Math.round(nsub / 2));
                        for (let k = 0; k <= halfN; k++) us.push(arrowU * k / halfN);
                        seamIdx = us.length - 1;
                        for (let k = 0; k <= halfN; k++) {
                            us.push(arrowU + (1 - arrowU) * k / halfN);
                        }
                    } else {
                        for (let k = 0; k <= nsub; k++) us.push(k / nsub);
                    }
                    nsub = us.length - 1;   // everything below indexes stations
                    for (let k = 0; k <= nsub; k++) {
                        const st = evalSlab(us[k], arrowHead && k > seamIdx);
                        if (!st) { ok = false; break; }
                        Lp.push(st[0]);
                        Lm.push(st[1]);
                        Rp.push(st[2]);
                        Rm.push(st[3]);
                        oN.push(st[4]);
                        oB.push(st[5]);
                        oT.push(st[6]);
                        oK.push(st[7]);
                        oLb.push(st[8]);
                        oLn.push(st[9]);
                        oLt.push(st[10]);
                        if (frameProbe) { mUb.push(st[11]); mWa.push(st[12]); mT.push(st[13]); }
                        zSum += (st[0][2] + st[1][2] + st[2][2] + st[3][2]) / 4;
                    }
                    if (!ok) continue;
                    // Two primitives per interval. One per interval lets a
                    // prim's own fill fold over its boundary at a winding apex
                    // and erase its understroke; per-sub-quad pieces make
                    // neighbouring fills nibble each other's understrokes into
                    // fur. Halves are coarse enough for clean stroke
                    // continuity and fine enough that self-overlap within one
                    // piece (half a residue, ~50 degrees of twist) is rare.
                    // Shade uses the INTERVAL mean depth so the face keeps one
                    // colour.
                    const zShade = zSum / (nsub + 1);
                    // In continuous mode the chain is one uninterrupted
                    // strip, so the only cross-section rims are the run's own
                    // termini - capping at element boundaries would draw a
                    // rim straight across the middle of a continuous surface.
                    // NO cap at the arrow shoulder. A cap is a cross-edge
                    // spanning the FULL width, so at a shoulder it draws a line
                    // straight across the shaft - which is not how the arrow is
                    // drawn: the shaft runs on into the head uninterrupted, and
                    // only the two barbs standing proud of it are outlined.
                    // Those come from the head's own side edges, so removing
                    // the cap loses nothing but the spurious line.
                    // A strand now BEGINS at full width rather than ramping up
                    // to it, so its first cross-section is a real rim and needs
                    // the flat end face - without it you see straight into the
                    // hollow back of the sheet at its N-terminus.
                    // Tied to the ARROWS option, not to the style: a strand
                    // drawn as an arrow is a plate with a point at one end and a
                    // blunt end at the other, so the flat internal end belongs
                    // to the same convention. Turning arrows off puts strands
                    // back to flowing continuously out of their loops at both
                    // ends.
                    // A ring has no first or last residue, so `i === lo` is not
                    // an element start and `iN === hi` is not an element end -
                    // taking them as such put a flat cap on both sides of the
                    // seam, cutting a helix that runs straight through it. Fall
                    // back to the neighbour's class, which is what decides every
                    // other element boundary anyway.
                    const iP = cyclic ? wrapIdx(i - 1) : i - 1;
                    const strandStart = arrowsOn && isProt && sec[i] === 'E'
                        && (cyclic ? sec[iP] !== 'E' : (i === lo || sec[i - 1] !== 'E'));
                    // A ring has no first or last residue, so lo and hi are
                    // not element ends and get no cap. Note this SUPPRESSES the
                    // profiled cap on a ring rather than switching to the
                    // sameElem test: `profiled` covers every interval in the
                    // run, so consulting sameElem here put a cross-edge stroke
                    // at EVERY residue of a cyclic peptide - visible as lines
                    // ruled across the ribbon (5KX0).
                    const capStartV = strandStart
                        || (profiled ? (i === lo && !cyclic) : !sameElem(iP, t0));
                    const capEndV = profiled
                        ? (iN === hi && !cyclic) : !sameElem(iN, t0);
                    // Quarter-interval pieces: the depth sort can only be as
                    // good as each piece's z is local. A folded-back piece that
                    // wraps toward the viewer drags its mean depth past any
                    // fixed tiebreaker; smaller spans (~25 degrees of turn)
                    // keep mean z honest. Fine granularity is safe now that
                    // strokes are visibility-tested and drawn after fills.
                    const q1 = Math.max(1, Math.floor(nsub / 4));
                    const q2c = Math.max(q1 + 1, Math.floor(nsub / 2));
                    const q3 = Math.max(q2c + 1, Math.floor((3 * nsub) / 4));
                    // ... and ALSO cut at every ORIENTATION FOLD (the face
                    // or width normal crossing zero): a piece that spans a
                    // fold carries its near half's depth key, and the
                    // painter then hoists its ENTIRE footprint - including
                    // the folded-away part - above lines that are plainly
                    // visible in front of that part. That over-cover is
                    // what chopped the silhouette around every flank
                    // crossing. Cut at the fold and the two halves sort at
                    // their own honest depths.
                    // renderer._cuts: 'quarter' (default) | 'half' | 'none'.
                    // Cuts exist so each piece sorts at its own depth, but they
                    // are the multiplier on EVERYTHING - prim count drives build
                    // cost, marshalling and draw calls alike. Sign-fold cuts
                    // below are kept in every mode: those mark where a surface
                    // actually turns over, so dropping them causes real errors
                    // rather than approximation.
                    const cutMode = renderer._cuts || 'quarter';
                    const cutSet = cutMode === 'none'
                        ? [0, nsub]
                        : (cutMode === 'half' || nsub < 4)
                            ? [0, Math.max(1, Math.floor(nsub / 2)), nsub]
                            : [0, q1, q2c, q3, nsub];
                    for (let k = 1; k < nsub; k++) {
                        if ((oB[k - 1] < 0) !== (oB[k] < 0)
                            || (oN[k - 1] < 0) !== (oN[k] < 0)) {
                            cutSet.push(k);
                        }
                    }
                    // the barb step is a genuine discontinuity in the surface
                    if (seamIdx > 0) cutSet.push(seamIdx);
                    // ...and so is a colour change, which has to land at the
                    // MIDPOINT between the two residues rather than at either
                    // end. Forced even in 'none' mode: without a cut here the
                    // interval is one piece and one colour, and the boundary
                    // goes back to sitting on a residue.
                    // The stations are integers, so an odd nsub has none at
                    // exactly u = 0.5 and the boundary lands on the nearest -
                    // within half a station, 1/6 of a residue at the default
                    // detail and less above it.
                    const midCut = Math.max(1, Math.min(nsub - 1, Math.round(nsub / 2)));
                    if (twoTone) cutSet.push(midCut);
                    cutSet.sort((a, b) => a - b);
                    const cutsQ = [];
                    for (let ci = 0; ci + 1 < cutSet.length; ci++) {
                        if (cutSet[ci + 1] > cutSet[ci]) {
                            cutsQ.push([cutSet[ci], cutSet[ci + 1]]);
                        }
                    }
                    for (const [a0, e0] of cutsQ) {
                        if (e0 <= a0) continue;
                        let zSeg = 0;
                        for (let k = a0; k <= e0; k++) {
                            zSeg += (Lp[k][2] + Lm[k][2] + Rp[k][2] + Rm[k][2]) / 4;
                        }
                        // Sort by CENTROID depth. Measured against the true
                        // pairwise overlap order on 1TIM (4 rotations, faces
                        // from different pieces), mis-ordered pairs:
                        //     zMean              0.71% / 0.69%  (detail 2 / 4)
                        //     zMax               0.85% / 0.78%
                        //     zMax + facingBias  1.13% / 0.92%   <- previous
                        //     zMean + facingBias 1.22% / 1.27%
                        // The facing tiebreaker (0.35 A * mean oB) was tuned
                        // around the max-z key and makes a centroid key WORSE
                        // than either alone, so it goes with it. What it used
                        // to buy: at a winding apex the near and folded-back
                        // surfaces converge in depth, and it forced the
                        // front-facing piece to occlude. Watch for lighter
                        // far-side planes popping over near outlines as the
                        // view turns - that is this bias being missed.
                        const zSort = zSeg / (e0 - a0 + 1);
                        // which residue this piece belongs to: the one its own
                        // midpoint is nearer to
                        // the boundary IS the forced cut, so a piece is far
                        // when it starts at or after it - comparing midpoints
                        // instead lets the piece straddling the cut fall on the
                        // wrong side of it
                        const far = twoTone && a0 >= midCut;
                        const pieceCol = far ? colFar : col;
                        const pieceOv = far ? ovN : ovI;
                        const prim = {
                            kind: 'rib',
                            // WHICH OUTLINE RULE THIS PIECE TAKES, stated on the
                            // prim so a consumer does not have to re-derive it.
                            // emitSlabInk is called with `squareLoop || !rich`
                            // just below, and a renderer that rebuilds the
                            // outline from these prims has to make the same
                            // choice or its interiors disagree with this one's.
                            squareLoop,
                            // SS class of this interval, so paintSide can give
                            // strand EDGES their own colour (see below) and
                            // paintFace can find the two-tone underside. Same
                            // value the colour above used, so a transition
                            // interval cannot be drawn helix-coloured but
                            // two-toned as coil.
                            ss: ssCls,
                            // colour was set by hand, not derived from a mode -
                            // see the inner-face tint in paintFace
                            co: !!pieceOv,
                            arrow: arrowHead,
                            // WHICH END OF THIS PIECE IS THE ARROW'S BARB STEP.
                            // The interval is cut at seamIdx because the step is
                            // a real discontinuity, so the arrow arrives as two
                            // pieces and the seam is an END on both of them. A
                            // consumer that outlines piece boundaries needs to
                            // know which boundary this is: inking across the
                            // seam draws a line over the full barb width, which
                            // is the inner arrow line nobody wants, while every
                            // other boundary on the arrow is real outline.
                            seam0: seamIdx > 0 && a0 === seamIdx,
                            seam1: seamIdx > 0 && e0 === seamIdx,
                            // ...AND THE SEAM AS AN ABSOLUTE STATION, which is
                            // the only form that survives how this interval gets
                            // cut. seam0/seam1 say "this piece BEGINS/ENDS at the
                            // seam", and that is not the same question. For an
                            // arrow nsub is 2*halfN+1, so the midpoint cut and
                            // the quarter cut q2c both land beside seamIdx - and
                            // when one of them is seamIdx+1 the step becomes its
                            // own two-station piece. The pieces either side then
                            // begin and end at those cuts rather than at the
                            // seam, carry no flag, and draw their cross-sections:
                            // one line at barb width, one at shaft width, which
                            // is the double line at the base of the arrowhead.
                            //
                            // The station index does not care how the interval
                            // was divided, so a consumer can ask "is this station
                            // the seam" wherever it lands.
                            seamA: seamIdx > 0 ? seamIdx : -1,
                            st0: a0,
                            Lp: Lp.slice(a0, e0 + 1),
                            Lm: Lm.slice(a0, e0 + 1),
                            Rp: Rp.slice(a0, e0 + 1),
                            Rm: Rm.slice(a0, e0 + 1),
                            oN: oN.slice(a0, e0 + 1),
                            oB: oB.slice(a0, e0 + 1),
                            oT: oT.slice(a0, e0 + 1),
                            oK: oK.slice(a0, e0 + 1),
                            oLb: oLb.slice(a0, e0 + 1),
                            oLn: oLn.slice(a0, e0 + 1),
                            oLt: oLt.slice(a0, e0 + 1),
                            // the model-space frame, when renderer._frameProbe
                            // asked for it - see evalSlab
                            ub: frameProbe ? mUb.slice(a0, e0 + 1) : undefined,
                            wa: frameProbe ? mWa.slice(a0, e0 + 1) : undefined,
                            tv: frameProbe ? mT.slice(a0, e0 + 1) : undefined,
                            z: zSort,
                            zShade,
                            c: pieceCol,
                            // WHICH SLOT OF `colors` THIS PIECE TOOK, so a
                            // consumer holding the geometry can repaint it from
                            // a new palette without asking for it again. Only
                            // meaningful when the colour came from the palette:
                            // an override or an ss-mode colour did not, and says
                            // so, because a lookup would then be wrong.
                            ci: frameProbe ? segIdx : undefined,
                            ciPalette: frameProbe
                                ? !(ssColor && isProt) && !hasColorOverrides
                                : undefined,
                            capStart: a0 === 0 && capStartV,
                            capEnd: e0 === nsub && capEndV,
                            gs0: i + a0 / nsub,
                            gsStep: 1 / nsub,
                        };
                        if (a0 === 0) registerJoint(`R${i}`, prim);
                        if (e0 === nsub) registerJoint(`R${iN}`, prim);
                        prims.push(prim);
                    }
                    // INK as SEPARATE prims sorted at their OWN depth
                    // (nearer fills cover occluded runs; the up-bias lets
                    // near-tie boundary lines win and draw whole). Emitted
                    // over the WHOLE INTERVAL's stations - per-quarter runs
                    // were only ~2 segments, and every chunk join read as a
                    // notch or kink ("jaggedy"). Interval runs join at the
                    // exactly-shared residue-boundary stations.
                    // WHICH corners get ink: at each segment the SILHOUETTE
                    // corners are the two whose projections are EXTREME
                    // perpendicular to the chain's screen direction - pure
                    // screen-space classification, no orientation
                    // thresholds. At a fold the outline hands off between
                    // corner curves exactly where they project to the same
                    // point; interior crease corners are never extreme, so
                    // no inner line.
                if (inkWanted) {
                    emitSlabInk(Lp, Lm, Rp, Rm, oN, oB, oK, col,
                        !!(selInk && (selInk.has(i) || selInk.has(iN))), i,
                        squareLoop || !rich, true);
                }
                } else {
                    // Loop, or the junction between two different elements:
                    // round tube, Catmull-Rom smoothed. The whole interval is ONE
                    // polyline primitive: stroking its outline and fill as single
                    // paths keeps the black outline continuous, where per-sample
                    // segments read as dashes (each neighbour's fill overpaints
                    // part of the previous sample's outline).
                    const p0 = at(wrapIdx(i - 1));
                    const p1 = at(i);
                    const p2 = at(iN);
                    const p3 = at(wrapIdx(i + 2));
                    // Detail alone, like the ribbons above
                    const sub = subFloor(isProt ? SUB : NA_SUB);
                    const tubeA = (isProt ? LOOP_TUBE_A : NA_TUBE_A) * widthScale;
                    const pts = [];
                    let zSum = 0;
                    let peSum = 0;
                    // One EXTRA sample beyond each end, kept only for the
                    // tangent estimate. Without them the first and last point
                    // fall back to a one-sided difference, and two tubes
                    // meeting at a shared residue disagree about the tangent
                    // there by O(h) - their cylinder bands then land at
                    // different offsets and the highlight stripe breaks at
                    // every residue boundary. Catmull-Rom is C1 across knots,
                    // so sampling just past the end agrees with the
                    // neighbour's own sample to O(h^2) and the stripe runs
                    // continuously down the whole loop.
                    const ext = [];
                    for (let k = -1; k <= sub + 1; k++) {
                        catmullV(p0, p1, p2, p3, k / sub, q0);
                        const A = project(q0[0], q0[1], q0[2]);
                        ext.push(A || null);
                        if (k < 0 || k > sub) continue;
                        if (!A) continue;
                        pts.push(A);
                        zSum += A[2];
                        peSum += A[3];
                    }
                    if (pts.length >= 2) {
                        // Append to the current run, or start one. A colour or
                        // radius change (chain boundary, protein/nucleic
                        // switch) ends the run so each prim keeps one colour.
                        if (tubeRun && (tubeRun.c !== col
                            || tubeRun.tubeA !== tubeA
                            || tubeRun.i1 !== i)) {
                            flushTubeRun();
                        }
                        if (!tubeRun) {
                            tubeRun = {
                                pts: [], ext: [], zSum: 0, peSum: 0,
                                c: col, tubeA, i0: i, i1: i,
                            };
                        } else {
                            // consecutive intervals share this knot exactly
                            pts.shift();
                        }
                        for (const A of pts) {
                            tubeRun.pts.push(A);
                            tubeRun.zSum += A[2];
                            tubeRun.peSum += A[3];
                        }
                        tubeRun.i1 = iN;
                        // ext is only a tangent aid; rebuilt after the merge
                        tubeRun.ext = null;
                    } else {
                        flushTubeRun();
                    }
                }
            }
            flushTubeRun();
        }

        // Where the ribbon's SURFACE is at residue `j`, on the side that `tip`
        // lies on. The slab's face normal is tangent x side; the tangent is
        // taken from the drawn neighbours so it follows the ribbon rather than
        // the raw trace, and the sign is chosen by which face the side chain is
        // actually on - a fixed sign would send half of them out through the
        // back.
        const scMap = renderer.sidechainMap;
        // THE RIBBON AS A BOX AT RESIDUE j: its centre, its three axes, and how
        // far it extends along each. Everything that has to meet the backbone
        // from outside reads it - side-chain sticks and contact lines alike -
        // so there is one construction of the frame rather than one per caller.
        //
        const ribbonSlabAt = (j) => {
            const sv = protSide[j];
            const o = at(j) || rotated[j];
            if (!sv || !o) return null;
            const pA = at(j - 1) || rotated[j - 1] || o;
            const pB = at(j + 1) || rotated[j + 1] || o;
            let tx = pB.x - pA.x, ty = pB.y - pA.y, tz = pB.z - pA.z;
            const tl = Math.hypot(tx, ty, tz);
            if (tl < 1e-6) return null;
            tx /= tl; ty /= tl; tz /= tl;
            let nx = ty * sv[2] - tz * sv[1];
            let ny = tz * sv[0] - tx * sv[2];
            let nz = tx * sv[1] - ty * sv[0];
            const nl = Math.hypot(nx, ny, nz);
            if (nl < 1e-6) return null;
            nx /= nl; ny /= nl; nz /= nl;
            const svl = Math.hypot(sv[0], sv[1], sv[2]);
            if (svl < 1e-6) return null;
            // HOW FAR THE SLAB REACHES ALONG THE CHAIN - half a CA-CA step,
            // this residue's own slice of ribbon. Taken from the NEARER
            // neighbour and capped at half the chain-break distance: the span
            // pB - pA is the obvious source and is wrong at a break, where one
            // "neighbour" is not one, the span reads tens of Angstrom, and a
            // contact leaving along the chain was cropped by up to 10.4 A.
            const step = Math.min(
                Math.hypot(o.x - pA.x, o.y - pA.y, o.z - pA.z) || Infinity,
                Math.hypot(pB.x - o.x, pB.y - o.y, pB.z - o.z) || Infinity);
            return {
                o,
                t: [tx, ty, tz],
                n: [nx, ny, nz],
                s: [sv[0] / svl, sv[1] / svl, sv[2] / svl],
                hT: Math.max(protHalfT[j] || 0, 0.05),
                hW: Math.max(protHalfW[j] || 0, 0.05),
                hL: Math.max(Math.min(step, SS.chainMax) / 2, 0.05),
            };
        };
        const ribbonSurfaceToward = (j, tip) => {
            const slab = ribbonSlabAt(j);
            if (!slab) return null;
            const o = slab.o;
            let [nx, ny, nz] = slab.n;
            const [ux, uy, uz] = slab.s;

            // WHICH SURFACE DOES IT LEAVE THROUGH? A ray/slab exit: run out
            // from the CA along the bond and take whichever surface it reaches
            // FIRST, the face at halfT/|d.n| or the side at halfW/|d.s|.
            //
            // Cutting every stick against the FACE, as this used to, assumes
            // they all leave that way - very nearly true wherever the ribbon
            // has a real frame, not true at all where it does not:
            //
            //   |bond . face normal|, 21,274 CA-CB bonds over the whole corpus
            //     helix   0 of 7,607 below 0.17     strand  2 of 4,581
            //     coil    9.5% below 0.17, min 0.0004
            //
            // A helix and a strand FIX the ribbon's roll, so their side chains
            // genuinely come out of the faces. A loop's roll is a free choice
            // made for smoothness, so the side chain points wherever it likes
            // relative to it, and ~10% of the time that is edge-on. Edge-on the
            // cut runs away: each corner slides (offset)/(d.n) along the bond,
            // measured at 0.37/|d.n| Angstrom, which at the observed minimum is
            // 1009 A. THAT is the "random long lines". The exit test takes the
            // worst corner travel over the corpus to 1.0 A.
            //
            // TWO WRONG ANSWERS, both measured, because both look plausible:
            //
            //  - Take the better-CONDITIONED plane, the one the bond meets most
            //    squarely. Fixes the runaway and breaks helices: a helix ribbon
            //    is ~3x wider than thick and its side chains leave at a median
            //    50 deg to the face normal, so |d.s| routinely beats |d.n| on a
            //    bond that plainly exits the FACE. That put the joint out at
            //    the ribbon's edge and the flush contact was gone. The exit
            //    test weighs the angle against how far each surface actually
            //    is, which is the difference.
            //  - Turn the ribbon to face the side chain. The CB axis swings a
            //    median 57 deg between consecutive loop residues against 18 deg
            //    for the frame in use, so the ribbon would tumble through every
            //    loop. Its job is to be smooth; reading the right surface off
            //    it costs it nothing.
            const dx = tip.x - o.x, dy = tip.y - o.y, dz = tip.z - o.z;
            const dl = Math.hypot(dx, dy, dz) || 1;
            const onFace = Math.abs((dx * nx + dy * ny + dz * nz) / dl);
            const onSide = Math.abs((dx * ux + dy * uy + dz * uz) / dl);

            // EVERY SURFACE IS AVAILABLE, on every element.
            //
            // A helix was briefly restricted to its two faces, to stop the
            // ATTACHMENT POINT jumping between surfaces when contacts anchored
            // on them. That restriction does not survive the move to cropping,
            // and cannot: a line that genuinely leaves through the EDGE has no
            // face to be cropped at, so halfT/|d.n| runs away with it. Measured
            // on a helix slab, faces-only against the true exit:
            //
            //     90 deg off the face normal   >50 A   against  1.30 A
            //     80 deg                        2.59 A          1.32 A
            //     70 deg                        1.32 A          1.32 A
            //
            // and past 80 degrees the crop guard clamps, taking most of the
            // contact with it.
            //
            // compared as 1/t, so a surface the bond runs parallel to is one it
            // never reaches rather than a division to guard. Both cannot be
            // zero: d is a unit vector, and the two axes span everything but
            // its component along the chain.
            const useSide = (onSide / slab.hW) > (onFace / slab.hT);
            if (useSide) { nx = ux; ny = uy; nz = uz; }
            const sgn = (dx * nx + dy * ny + dz * nz) >= 0 ? 1 : -1;
            // HOW FAR OUT THAT SURFACE IS, and no further: the stick's AXIS
            // lands on it so its box straddles it and the two solids merge with
            // no seam. Clearing the stick's own half-width as well would set
            // them apart and leave a visible joint - and the overlap costs
            // nothing, for the reason the ligand junctions already rely on:
            // where two boxes interpenetrate the hidden-line pass removes
            // whatever is inside. What mattered was starting at the SURFACE
            // rather than at the centre, which is what stopped a side chain
            // sitting half inside the ribbon with no correct paint order.
            //
            // A face sits at the half-THICKNESS, a side at the half-WIDTH -
            // which on a strand is three times further out, so reading the
            // wrong one would plant the cutting plane inside the ribbon or well
            // outside it.
            const off = useSide ? slab.hW : slab.hT;
            // WHERE THE RAY LEAVES THE SLAB ALTOGETHER, which is the surface it
            // was cut against OR the end of this residue's slice, whichever
            // comes first. A side chain ignores this and uses the plane above;
            // a CONTACT crops itself here, and needs the third axis because a
            // contact between i and i+4 in a helix runs very nearly along the
            // chain and would otherwise meet no surface squarely at all.
            const onChain = Math.abs((dx * slab.t[0] + dy * slab.t[1]
                + dz * slab.t[2]) / dl);
            const cross = onFace > 1e-6 || onSide > 1e-6 || onChain > 1e-6;
            let exit = off / Math.max(useSide ? onSide : onFace, 1e-6);
            if (onChain > 1e-6) exit = Math.min(exit, slab.hL / onChain);
            return {
                exit: cross ? exit : 0,
                x: o.x + sgn * nx * off, y: o.y + sgn * ny * off,
                z: o.z + sgn * nz * off,
                // the outward normal of the surface it leaves through, for the
                // stick to roll its section onto - see rollN in stickFrame
                n: [sgn * nx, sgn * ny, sgn * nz],
            };
        };

        // WHICH RESIDUES HAVE A KEPT BACKBONE ATOM, and where the ring they
        // close has to move to clear the slab. One pass over the map rather
        // than a scan per bond, and the shift is worked out once per residue -
        // both arms of the ring and every bond inside it must take the SAME
        // one, or the ring comes apart.
        const bbAtomOf = new Map();
        const bbShift = new Map();
        if (scMap && scMap.size) {
            for (const [idx, e] of scMap) {
                if (e && e.bb && !bbAtomOf.has(e.owner)) bbAtomOf.set(e.owner, idx);
            }
        }

        // THE STICK SECTION'S THICKNESS, resolved here because two passes need
        // it: the box builder far below, and the side-chain cut in the loop
        // that follows, which has to know how far its corners will travel
        // before it agrees to make the cut. See the long note at the box
        // builder for why a stick stops thickening before the ribbon does.
        const thPreset = renderer.cartoonThickness;
        const thLig = Math.min(LIGAND_TH_MAX,
            (renderer._thicknessUserSet && thPreset !== undefined)
                ? thPreset
                : (thPreset === 0 ? 0 : LIGAND_TH_DEFAULT));
        const stickHT = Math.max(0, thLig / 2);
        // THE CONTACT'S OWN SECTION. Its width is CONTACT_WIDTH, in Angstrom,
        // and that is the FULL width - the same number the flat stroke used, so
        // switching to a box does not change how heavy a contact reads. Its
        // thickness follows the ribbon's, because a contact tying two slabs
        // together should look like it is made of the same stuff; at thickness
        // zero it collapses to the flat double-sided face on its own, through
        // the same path a zero-thickness ligand stick takes.
        // A RADIUS, the same on both axes. The section builder spends u on the
        // thickness and v on the width, and giving those two different numbers
        // makes an ellipse - a tube that is fatter one way than the other, and
        // so still has an orientation, which is the thing a round section is
        // for getting rid of. A contact is a cylinder: same width, same depth,
        // and its radius is its own, not the ribbon's thickness control.
        const contactR = CONTACT_WIDTH / 2;
        const contactHT = contactR;
        // A CONTACT IS A FLAT BRIGHT STROKE. That is the default and it is a
        // deliberate one: a contact is annotation OVER the picture, not part of
        // it, and anything with a lit surface and an outline reads as part of
        // it however carefully it is attached.
        //
        // Drawing it as a solid was tried - a box, then a cylinder, both
        // attached the way a side chain is, with each end's section cut into
        // the ribbon's own plane so it lies in the surface. The attachment is
        // the good part of that and the machinery for it is still here, behind
        // this flag, because it is the section that was wrong rather than the
        // join. Set cartoonContactBoxes = true for the solid, and
        // cartoonContactSides for its section: 4 is a square rod, 10 a
        // cylinder. Both are painted unlit, one flat colour.
        const contactBoxes = renderer.cartoonContactBoxes === true;
        // ROUND, not square. A contact is a tie between two residues rather than
        // a piece of chemistry, and a square rod reads as the latter - the flat
        // faces catch the light in bands and the corners give it an orientation
        // it has no business having. A tube has neither: it is the same solid
        // from every side, which is what an annotation that happens to be three
        // dimensional should be. It attaches exactly as the square did - the
        // ring rolls onto the ribbon's face and its section is cut into that
        // plane, so the end lies in the surface as an ELLIPSE instead of a
        // square, which is the same connection and a quieter join.
        //
        // 10 facets: at a contact's width on screen the silhouette is smooth
        // by 8, and the outline pass puts ink on exactly the two rails that
        // are the silhouette, so the facet count costs geometry and nothing
        // else. Set cartoonContactSides to 4 for the square.
        const contactSides = Math.max(3, Math.min(24,
            renderer.cartoonContactSides || 10));

        // --- generic segments: ligands, explicit bonds, cyclic closures,
        //     contacts, lone-position dots. Same widths as the ribbon style. ---
        const bondList = [];
        for (const s of genericSegs) {
            const seg = segments[s];
            if (mask) {
                if (seg.type === 'C' && seg.contactIdx1 !== undefined) {
                    if (!mask.has(seg.contactIdx1) || !mask.has(seg.contactIdx2)) continue;
                } else if (!mask.has(seg.idx1) || !mask.has(seg.idx2)) {
                    continue;
                }
            }
            // Endpoints follow the DRAWN backbone, so a contact or a ligand
            // bond meets the ribbon where the ribbon actually is - flattening
            // moves a strand up to ~2 A, which left contact lines ending in
            // space beside the strand they point at. at() returns the raw
            // position for anything the cartoon does not reposition (ligand
            // atoms, lone dots), so those are unaffected.
            let v1 = at(seg.idx1) || rotated[seg.idx1];
            let v2 = at(seg.idx2) || rotated[seg.idx2];
            // PROLINE'S RING CLOSES ON A BACKBONE ATOM, and the backbone here is
            // a solid. Its N sits 1.46 A from the CA - inside the ribbon at any
            // normal width - so the arm that closes the ring ran into the slab
            // and vanished, and the pentagon read as a loop diving through the
            // tube.
            //
            // THE WHOLE RING MOVES, as one. Lifting the buried atom alone bends
            // the pentagon: that vertex ends up on the face while the other
            // three stay where they were, and a ring with one corner pulled in
            // is a worse drawing than one sitting a third of an Angstrom out.
            // The shift is what it takes to bring the buried atom to the nearer
            // FACE of the slab, along that face's normal, and every atom of the
            // residue takes it - so the ring keeps its shape and rests on the
            // ribbon instead of cutting through it. The two bonds back to the
            // CA stretch by the same amount and stay anchored, and the existing
            // cut at the surface takes care of where they meet it.
            //
            // Only what is DRAWN moves. The atoms keep their measured positions
            // for everything else - element colour, picking, the distance
            // search - which is the same split a base plate makes when it runs
            // from its ribbon's face rather than from the trace inside it.
            if (scMap && scMap.size) {
                const shiftOf = (owner) => {
                    if (bbShift.has(owner)) return bbShift.get(owner);
                    let out = null;
                    const idx = bbAtomOf.get(owner);
                    const slab = idx === undefined ? null : ribbonSlabAt(owner);
                    if (slab) {
                        const p = at(idx) || rotated[idx];
                        const dx0 = p.x - slab.o.x, dy0 = p.y - slab.o.y,
                            dz0 = p.z - slab.o.z;
                        const d = dx0 * slab.n[0] + dy0 * slab.n[1] + dz0 * slab.n[2];
                        // outside already: nothing to lift, and pulling it IN
                        // would be the bug this exists to avoid
                        if (Math.abs(d) < slab.hT) {
                            const need = (d < 0 ? -slab.hT : slab.hT) - d;
                            out = [slab.n[0] * need, slab.n[1] * need, slab.n[2] * need];
                        }
                    }
                    bbShift.set(owner, out);
                    return out;
                };
                const lift = (idx, v) => {
                    const e = scMap.get(idx);
                    if (!e) return v;
                    const sft = shiftOf(e.owner);
                    return sft
                        ? { x: v.x + sft[0], y: v.y + sft[1], z: v.z + sft[2] } : v;
                };
                v1 = lift(seg.idx1, v1);
                v2 = lift(seg.idx2, v2);
            }
            const scRollN = [null, null];
            const scRollP = [null, null];
            const scRollFlush = [false, false];
            // A SIDE CHAIN LEAVES THROUGH THE RIBBON'S FACE, not out of its
            // middle. Its CA end is a backbone position, which is the CENTRE of
            // the slab - so the first stick began inside the ribbon, the two
            // solids interpenetrated, and no paint order was correct for both:
            // seen along a sheet the side chains printed over the backbone.
            //
            // This is what a base plate already does, and for the same reason -
            // "a rung runs from its own ribbon's FACE to the centre of the
            // pair, so it never crosses either backbone it connects". Moving
            // the start out to the surface separates the two solids, and then
            // ordinary depth sorting is enough.
            //
            // Only the CA END moves. The side-chain atoms stay exactly where
            // they were measured - their direction is real geometry (see the
            // flattening note in the posArr pass) and this must not rotate it.
            // It also closes the gap flattening leaves: the stick now starts on
            // the ribbon you can see rather than beside it.
            if (scMap && scMap.size) {
                const a1 = scMap.has(seg.idx1); const a2 = scMap.has(seg.idx2);
                if (a1 !== a2) {                     // exactly one end is an atom
                    const own = a1 ? seg.idx2 : seg.idx1;
                    const tip = a1 ? v1 : v2;
                    const face = ribbonSurfaceToward(own, tip);
                    if (face) {
                        // THE BOND KEEPS ITS OWN AXIS. It used to have this end
                        // MOVED out to the ribbon's surface, which is a shift
                        // along the face normal - sideways to the bond - so the
                        // stick stopped being collinear with the CA-CB bond it
                        // represents and leant off it by the slab's
                        // half-thickness. What actually happens physically is
                        // that the bond runs all the way to the CA and the
                        // BACKBONE CUTS IT: the stick is whole, and the slab's
                        // surface takes a slice off the end. Where that slice
                        // falls along the bond then depends on the thickness,
                        // which is right - a thicker ribbon swallows more of it.
                        //
                        // So only the cutting plane is recorded here; the end
                        // point stays where the atom is. (Recorded just below,
                        // once the end index is known.)
                        // ROLL THE SECTION ONTO THE RIBBON. A stick's square is
                        // otherwise rolled by its neighbours, so it meets the
                        // surface at whatever angle that happened to give and
                        // the joint shows a corner. Taking the ribbon's face
                        // normal as the section's thickness axis lays the box's
                        // flat faces parallel to the ribbon's own and its width
                        // across the surface - which is what a base plate does
                        // at its joint, "matches the ribbon's own half-width and
                        // side vector, so the two line up exactly".
                        // which END of this bond is the ribbon one
                        const scEndIdx = a1 ? 1 : 0;
                        scRollN[scEndIdx] = face.n;
                        scRollP[scEndIdx] = face;
                        // ...and whether the end square can be cut into that
                        // surface's plane at all. Decided here, once, because
                        // two things downstream need the same answer: the cut
                        // itself, and whether to DRAW the resulting face. Split
                        // between them, a bond too shallow to cut still got a
                        // cap - a perpendicular lid at the wrong angle over the
                        // join.
                        const dx = v2.x - v1.x, dy = v2.y - v1.y, dz = v2.z - v1.z;
                        const dl = Math.hypot(dx, dy, dz) || 1;
                        const dn = Math.abs((dx * face.n[0] + dy * face.n[1]
                            + dz * face.n[2]) / dl);
                        // THE CORNERS MUST NOT TRAVEL PAST THE BOND. Each one
                        // slides along the bond by (its distance from the
                        // plane)/dn, so the section stretches by 1/dn - and a
                        // cut that carries a corner beyond the far atom is no
                        // longer a slice of THIS bond at all. Choosing the
                        // right surface above already bounds dn well away from
                        // zero (worst 0.101 over the corpus, against 0.0004
                        // when the face was assumed); this is the backstop for
                        // the residual, and it is expressed in the quantity
                        // that actually breaks rather than as an angle.
                        //
                        // The plane sits `off` out from the CA and the section
                        // reaches half its own thickness either side of that,
                        // so the furthest corner is (off + halfThick)/dn.
                        const off = Math.hypot(face.x - (a1 ? v2.x : v1.x),
                            face.y - (a1 ? v2.y : v1.y),
                            face.z - (a1 ? v2.z : v1.z));
                        scRollFlush[scEndIdx] = dn >= SC_FLUSH_EPS
                            && (off + stickHT) <= dn * dl;
                    }
                }
            }
            // A CONTACT RUNS CA TO CA AND THE RIBBON CROPS IT - the same
            // thing the backbone does to a side chain, and for the same reason.
            //
            // It used to be drawn from CA to CA with nothing removed, and a CA
            // is the CENTRE of the slab, so both ends began buried inside the
            // ribbon they point at: line and slab interpenetrate, no paint
            // order is right for both, and the contact reads as passing THROUGH
            // the backbone. So the line keeps its full CA-to-CA axis and each
            // end is cut back to where it leaves the slab - a crop along its
            // own direction, which cannot tilt it off the two residues it
            // names.
            //
            // WHERE THE CROP FALLS DEPENDS ON THICKNESS AND WIDTH, because the
            // slab it is leaving has both: the exit is the nearer of
            // halfT/|d.n| and halfW/|d.s|, bounded by the residue's own
            // half-step along the chain. A thicker or wider ribbon swallows
            // more of the contact, which is what those controls are for.
            //
            // Anchoring each end at the surface point straight out from the CA
            // was tried instead. It puts every joint at the same spot, but the
            // line then no longer points at the partner - each end is displaced
            // by up to the ribbon's half-extent, about 23 degrees of bearing
            // over a 6 A contact - and a contact's whole job is to say WHICH
            // TWO residues are in contact.
            if (seg.type === 'C' && v1 && v2) {
                const e1 = ribbonSurfaceToward(seg.idx1, v2);
                const e2 = ribbonSurfaceToward(seg.idx2, v1);
                const ta = e1 ? e1.exit : 0;
                const tb = e2 ? e2.exit : 0;
                const dxc = v2.x - v1.x, dyc = v2.y - v1.y, dzc = v2.z - v1.z;
                const len = Math.hypot(dxc, dyc, dzc);
                // NEVER CROP THE CONTACT AWAY. Two residues packed against each
                // other can sit closer than the two half-ribbons between them,
                // and the ends would cross over and draw the line backwards.
                // Both crops are scaled back together so the line keeps most of
                // its length and all of its direction.
                if (len > 1e-6 && ta + tb > 0) {
                    const room = 0.8 * len;
                    const k = (ta + tb) > room ? room / (ta + tb) : 1;
                    const ux = dxc / len, uy = dyc / len, uz = dzc / len;
                    v1 = { x: v1.x + ux * ta * k, y: v1.y + uy * ta * k,
                        z: v1.z + uz * ta * k };
                    v2 = { x: v2.x - ux * tb * k, y: v2.y - uy * tb * k,
                        z: v2.z - uz * tb * k };
                }
                // ...AND THEN IT ATTACHES THE WAY A SIDE CHAIN DOES. The crop
                // above puts each end ON the surface, which stops the two
                // solids interpenetrating; what it cannot do is make the end
                // look like it belongs there, because a perpendicular cut
                // across a bond that meets the ribbon obliquely is a square
                // standing on a slope. The same surfaces the crop just found
                // are handed on as roll planes, so each end's section is rolled
                // onto the ribbon's own face and sliced into its plane - the
                // side chain's "square that lies on the backbone", at both ends
                // instead of one.
                //
                // A contact is the only bond that can need this at BOTH ends,
                // which is why the roll data is a pair.
                if (contactBoxes) {
                    const setRoll = (e, endIdx, p, other) => {
                        if (!e || !e.n) return;
                        const dxr = other.x - p.x, dyr = other.y - p.y,
                            dzr = other.z - p.z;
                        const dlr = Math.hypot(dxr, dyr, dzr) || 1;
                        const dnr = Math.abs((dxr * e.n[0] + dyr * e.n[1]
                            + dzr * e.n[2]) / dlr);
                        scRollN[endIdx] = e.n;
                        scRollP[endIdx] = e;
                        // the same backstop the side chain uses: a corner must
                        // not travel past the far end of the bond
                        const offr = Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z);
                        // ...AND THE SECTION'S CENTRE MUST BARELY MOVE. The end
                        // has already been cropped ONTO this surface, so the
                        // slice should only tilt the square, not slide it: the
                        // centre travels ((plane - end).n)/dn, and where that is
                        // more than the crop itself the two disagree about where
                        // the surface is and the cut is not a slice of this bond
                        // any more. Measured at 150 degrees off the face normal,
                        // where it reached -1.29 A of "crop" on a slab 1.1 A
                        // thick - backwards, and further than the slab is deep.
                        const slide = ((e.x - p.x) * e.n[0] + (e.y - p.y) * e.n[1]
                            + (e.z - p.z) * e.n[2]) / (dnr || 1);
                        scRollFlush[endIdx] = dnr >= SC_FLUSH_EPS
                            && (offr + contactHT) <= dnr * dlr
                            && Math.abs(slide) <= 2 * contactR;
                    };
                    setRoll(e1, 0, v1, v2);
                    setRoll(e2, 1, v2, v1);
                }
            }
            const A = project(v1.x, v1.y, v1.z);
            const B = project(v2.x, v2.y, v2.z);
            // A CONTACT SORTS ON ITS NEAR SURFACE. It is drawn as a flat stroke
            // but stands for something with thickness, so what should sort is
            // the surface facing the viewer, not the centre line. The case that
            // matters is a contact joining two parts at the same depth - two
            // strands of a flat sheet above all - where the centre lines
            // coincide and the order is a coin toss.
            //
            // ...UNLESS THE RIBBON IS THICKER, in which case it genuinely is in
            // front and should cover the contact. So the bias is the difference
            // of the two radii and never negative.
            //
            // IT GOES IN THE DEPTH CHANNEL, not on the sort key. project()
            // returns [x, y, z, pe] with z the world depth in Angstrom, and
            // that third slot is what the painter sorts on AND what the ink
            // pass registers as an occluder. Biasing only the sort key - as
            // this used to - left the two modelling different solids: the
            // painter drew the contact over a ribbon while the ink pass still
            // believed the ribbon was in front, so the ribbon's outline showed
            // through the contact. Biasing the channel keeps them agreed, and
            // costs nothing: x and y are already fixed, so the drawn line does
            // not move.
            // ...AND A BOX DOES NOT NEED IT. The bias exists because a flat
            // stroke "stands for something with thickness" and has no near
            // surface of its own to sort on. A box has one, so biasing it as
            // well would push it in front of things it genuinely sits behind.
            const zBias = (seg.type === 'C' && !contactBoxes)
                ? Math.max(0, CONTACT_TUBE_R - (renderer.cartoonThickness || 0) / 2)
                : 0;
            if (zBias && A) A[2] += zBias;
            if (zBias && B) B[2] += zBias;
            if (!A || !B) continue;
            const col = colors[s];
            const segCi = frameProbe ? s : undefined;   // its slot, for repainting
            if (!col) continue;
            const widthMult = renderer._calculateSegmentWidthMultiplier(null, seg);
            // A CONTACT KEEPS ITS OWN WIDTH, the way a ligand does. The Line
            // Width control sets how heavy the BACKBONE is drawn, and a contact
            // is not part of the structure - it is an annotation over it, and
            // one that grew and shrank with the backbone stopped reading as a
            // separate mark. Its own weight is per contact, carried in the
            // stored entry (contactWeight), so two contacts in one picture can
            // differ.
            // * scale, because CONTACT_WIDTH is in ANGSTROM like every other
            // width here - baseLineWidthPixels is lineWidth * scale, and
            // substituting a bare constant for it dropped the conversion, so
            // the contact came out a couple of raw pixels wide at any zoom.
            const wBase = seg.type === 'C' ? CONTACT_WIDTH * scale : baseLineWidthPixels;
            const wMult = seg.type === 'C'
                ? (seg.contactWeight !== undefined ? seg.contactWeight : 1)
                : widthMult;
            const wpx = Math.max(0.5, wBase * wMult * ((A[3] + B[3]) / 2));
            // THE SAME WIDTH IN ANGSTROM, for a consumer that keeps the
            // geometry. `wpx` has the view scale and the perspective factor
            // already multiplied in, so it is only true of the frame it was
            // computed for - and a consumer re-drawing at another zoom needs
            // the quantity this style actually owns, which is a distance in the
            // molecule and not a number of pixels.
            const wAng = (seg.type === 'C' ? CONTACT_WIDTH : (renderer.lineWidth || 3.0))
                * wMult;
            if (!noViewCull) {   // offscreen: same cull as backbone intervals
                const m2 = wpx / 2 + outlineW + 4;
                if ((A[0] < -m2 && B[0] < -m2)
                    || (A[0] > displayWidth + m2 && B[0] > displayWidth + m2)
                    || (A[1] < -m2 && B[1] < -m2)
                    || (A[1] > displayHeight + m2 && B[1] > displayHeight + m2)) continue;
            }
            // pA/pB keep the FULL projected points ([x, y, z, pe]) alongside the
            // flattened screen coords, because the ink pass needs the
            // perspective attribute to occlusion-test against these - see the
            // 'line'/'dot' occluder branches.
            // Selected? Generic prims (ligand atoms and their bonds, contacts,
            // explicit bonds, lone dots) are not ribbon pieces, so they carry no
            // ink curves - without this a selected ligand showed no outline at
            // all while the backbone around it did.
            const segSel = !!(selInk
                && (selInk.has(seg.idx1) || selInk.has(seg.idx2)));
            if (seg.idx1 === seg.idx2) {
                // A LONE ATOM IS SIZED BY ITS ELEMENT, not by the Line Width
                // control - the same rule the ligand sticks follow, and for the
                // same reason: this is a small thing sitting in a big one and
                // it should not grow with the backbone. Only a position that
                // knows its element gets this; a lone C-alpha (a one-residue
                // chain) is not an atom and keeps the segment width.
                const el = renderer.elementAt ? renderer.elementAt(seg.idx1) : '';
                const isAtom = !!el || seg.type === 'L';
                const rA = isAtom ? loneAtomRadiusA(el) : null;
                // pe is the perspective factor already in wpx; scale converts
                // Angstrom to pixels, exactly as baseLineWidthPixels does.
                const rpx = rA !== null ? rA * scale * A[3] : wpx / 2;
                prims.push({ kind: 'dot', x1: A[0], y1: A[1], z: A[2],
                    // BOTH RADII. The GPU port builds a real sphere from this
                    // and needs the Angstrom one; their ratio is also the only
                    // way it can recover pixels-per-Angstrom at this depth.
                    r: rpx, rA: rA !== null ? rA : rpx / Math.max(1e-6, scale * A[3]),
                    c: col, ci: segCi, pA: A, sel: segSel, gs0: seg.idx1 });
            } else {
                bondList.push({
                    a: seg.idx1, b: seg.idx2, A, B, w: wpx, wA: wAng, c: col,
                    // WHERE THE TWO ENDS ARE DIFFERENT ELEMENTS, what each half
                    // should be. The box is cut at its middle and painted from
                    // this - see the K loop in stickBox.
                    //
                    // OFF THE COLOUR ARRAY THIS RENDER WAS GIVEN, never off the
                    // renderer: colour arrays are cached, and a half-colour list
                    // held separately gets served beside a DIFFERENT segment
                    // list - the halves then land on whatever bond now sits at
                    // that index, and carbon bonds come out red.
                    halfC: (colors && colors.halves && colors.halves[s]) || null,
                    ci: segCi,
                    // A CONTACT IS A BOX NOW, not a flat stroke - see the roll
                    // note above. `flat` stays for the other thing that reaches
                    // this list: a bond whose box could not be built.
                    flat: (seg.type === 'C' && !contactBoxes), sel: segSel,
                    // ...times its OWN stored weight, which is the per-contact
                    // control and the only thing that sizes it. Dropping it
                    // when the flat stroke became a box was caught by the test
                    // that exists for exactly that.
                    hw: seg.type === 'C' ? contactR * wMult : undefined,
                    ht: seg.type === 'C' ? contactR * wMult : undefined,
                    segA: seg.type === 'C' ? CONTACT_SEG_A : undefined,
                    sides: seg.type === 'C' ? contactSides : undefined,
                    unlit: seg.type === 'C',
                    va: v1, vb: v2,      // 3D: the box is built in Angstroms
                    // ROLL DATA PER END, because a bond can meet the ribbon at
                    // BOTH. A side chain only ever does at its CA, so this used
                    // to be three scalars plus `rollAt` naming the one end that
                    // had them; a contact runs ribbon to ribbon and needs the
                    // same treatment at each. Indexed [end0, end1], null where
                    // the end meets nothing.
                    rollN: scRollN,      // the surface's outward normal
                    rollP: scRollP,      // ...a point on its plane
                    rollFlush: scRollFlush,  // ...and whether the square lies in it
                    zBias,               // contacts: sort on the near surface
                });
            }
        }

        // Side-chain atoms are ordinary 'L' positions by the time they reach
        // here (see _materialiseSidechains in viewer-mol.js), so the generic
        // segment loop above has already picked them up and nothing special is
        // drawn for them. What IS special is where they sit: they were placed
        // against the file's backbone, and this renderer has since moved it.
        // The posArr pass near the top of the draw puts them back on it.

        // BONDS JOIN UP INTO RUNS before they are drawn, the same way the
        // backbone's intervals do. One primitive per bond meant one round cap
        // per bond END: at every junction the later-painted bond laid its
        // full-width shadow band over its neighbour's narrow highlight, so each
        // bond read as a separate capsule and a ligand came out as a string of
        // sausages. A run is a single polyline, stroked once per band, so the
        // joints inside it are lineJoin's problem and simply disappear.
        //
        // A run stops where the chain branches (an atom with three bonds is a
        // fork, and there is no single polyline through it), and wherever
        // colour, width or kind changes - a run has one of each.
        // How many bonds each atom carries, and which they are. Needed by the
        // sticks (a cap ring is drawn only where an atom has ONE bond, and the
        // section's roll is read off the neighbours) and by the run merging
        // below, so both read one copy.
        const deg = new Map();
        const inc = new Map();
        // ...and the same count over the bonds that actually become BOXES. A
        // contact is a flat annotation stroke, not a solid, so it covers
        // nothing: an end with only a contact leaving it is still an open end
        // and has to keep its cap and the ink round it.
        const boxDeg = new Map();
        for (const bd of bondList) {
            deg.set(bd.a, (deg.get(bd.a) || 0) + 1);
            deg.set(bd.b, (deg.get(bd.b) || 0) + 1);
            if (!bd.flat) {
                boxDeg.set(bd.a, (boxDeg.get(bd.a) || 0) + 1);
                boxDeg.set(bd.b, (boxDeg.get(bd.b) || 0) + 1);
            }
            if (!inc.has(bd.a)) inc.set(bd.a, []);
            if (!inc.has(bd.b)) inc.set(bd.b, []);
            inc.get(bd.a).push(bd);
            inc.get(bd.b).push(bd);
        }
        // --- LIGAND STICKS ---------------------------------------------------
        // One box per bond, running atom to atom. Boxes at a shared atom simply
        // OVERLAP: the union of two opaque solids is a solid, and every part of
        // one that lies inside the other is behind its surface, so the ink
        // pass removes it. There is no junction geometry, so there is nothing
        // at a junction to get wrong.
        //
        // The section's ROLL comes from the local plane normal - the sum of
        // t x (q - mid) over the bonded neighbours of both atoms. Each term is
        // perpendicular to the bond and to the plane through it and that
        // neighbour, so bonds sharing a plane come out sharing their face
        // planes exactly (measured: 0.0 degrees around an aromatic ring).
        // It is built from the molecule, so it turns with it.
        // HALF-WIDTH is fixed to the ligand's own width, independent of the
        // Line Width control; HALF-THICKNESS follows the Thickness control.
        // The section is a rectangle: v spans the width, u the thickness - u
        // being the axis a mitre rolls onto its junction plane, which is what
        // makes it the thickness direction everywhere below.
        const stickHW = LIGAND_STICK_H * (LIGAND_WIDTH / 3);
        // THE CONTROL IS A THICKNESS IN ANGSTROM - the value is the TOTAL
        // thickness, so the half is thickness/2, the same as the ribbon's own
        // expression. One number means one distance everywhere.
        //
        // A LIGAND KEEPS ITS OWN SECTION, the way it keeps its own width: a
        // preset does not get to reshape it just because it reshaped the
        // ribbon. So richardson's 0.7 and 3d's 0.5 both leave the stick at its
        // own LIGAND_TH_DEFAULT, and a ligand looks the same under either.
        //
        // THE ONE EXCEPTION IS A PRESET THAT ASKS FOR FLAT. Ribbon (plain
        // cartoon) sets thickness 0 because flatness IS the look it means, not
        // as a side effect, and a solid stick sitting in flat ribbons reads
        // wrong. So a preset 0 does reach the ligand; every other preset value
        // does not.
        //
        // And the user outranks all of it: once the Thickness control has been
        // touched it owns the section, 0 included, which is the flat
        // single-face path.
        //
        // thPreset / thLig / stickHT are resolved ABOVE the generic segment
        // loop, not here: the side-chain cut needs the stick's half-thickness
        // to know how far its corners will travel, and a `const` read before
        // its declaration is a dead viewer rather than a wrong number.
        //
        // At zero the box has no interior: the +u and -u faces land on each
        // other and the other four have no area. Drawing it as a solid then
        // costs six faces, four of them degenerate, to paint one quad. FLAT
        // draws that quad once, double-sided - which is the whole point of
        // taking the thickness to zero on a preset: fewer faces.
        const stickFlatEps = 0.5 * stickHW * 0.02;
        const stickIsFlat = stickHT <= stickFlatEps;
        // A face is kept while it still looks at the eye, plus a margin: a
        // projected quad undercovers its own outline at grazing, so culling
        // exactly at zero leaves a hairline of paper along the silhouette.
        const STICK_CULL = 0.02;
        // The section frame of one bond: axis, and the two section axes. Split
        // out of the box builder because the junctions below have to be solved
        // BEFORE any box is built - a mitred end is not a square.
        const stickFrame = (bd) => {
            const va = bd.va;
            const vb = bd.vb;
            let tx = vb.x - va.x;
            let ty = vb.y - va.y;
            let tz = vb.z - va.z;
            const tl = Math.hypot(tx, ty, tz);
            if (tl < 1e-6) return null;
            tx /= tl; ty /= tl; tz /= tl;
            const mx = (va.x + vb.x) / 2;
            const my = (va.y + vb.y) / 2;
            const mz = (va.z + vb.z) / 2;
            // Each neighbour gives t x (q - mid), which is perpendicular to
            // the bond and to the plane through it and that neighbour. They are
            // summed to average out of a noisy environment - but the sign of
            // each term depends on WHICH SIDE the neighbour is on, so a
            // symmetrically substituted centre (the commonest kind: a trigonal
            // carbon with two neighbours either side) cancels to nothing and
            // the rule falls through to its fallback, leaving the section
            // rolled arbitrarily. So each term is flipped to agree with the
            // first before adding: a plane has a normal, not a signed normal.
            // Each neighbour gives t x (q - mid), which names a PLANE through
            // the bond - a direction with no sign to it. Averaging such things
            // by flipping each term to agree with the running total works until
            // a term lands square across that total: the sign is then decided
            // by whichever way the rounding fell, and at a tetrahedral centre,
            // where the remaining neighbours sit symmetrically about the bond,
            // that is exactly what happens. The inputs are ROTATED coordinates,
            // so it fell differently at different viewing angles and the roll
            // jumped between two answers 60 degrees apart - the boxes spun and
            // flickered as the structure turned.
            //
            // Undirected directions are averaged by DOUBLING THE ANGLE, where
            // a direction and its opposite land on the same place and there is
            // no sign to get wrong. The basis it is measured in cancels out of
            // the answer, so any perpendicular pair will do.
            const perp = (x, y, z) => {
                const d = x * tx + y * ty + z * tz;
                const ax = x - tx * d;
                const ay = y - ty * d;
                const az = z - tz * d;
                const l = Math.hypot(ax, ay, az);
                return l > 1e-6 ? [ax / l, ay / l, az / l] : null;
            };
            const e1 = perp(1, 0, 0) || perp(0, 1, 0) || perp(0, 0, 1);
            if (!e1) return null;
            const e2 = [ty * e1[2] - tz * e1[1], tz * e1[0] - tx * e1[2],
                tx * e1[1] - ty * e1[0]];
            let accX = 0; let accY = 0; let accW = 0;
            let pick = null; let pickIdx = Infinity;
            for (const [atom, other] of [[bd.a, bd.b], [bd.b, bd.a]]) {
                for (const nb of (inc.get(atom) || [])) {
                    const far = (nb.a === atom) ? nb.b : nb.a;
                    if (far === other || nb === bd) continue;
                    const q = at(far) || rotated[far];
                    if (!q) continue;
                    let qx = q.x - mx; let qy = q.y - my; let qz = q.z - mz;
                    const ql = Math.hypot(qx, qy, qz) || 1;
                    qx /= ql; qy /= ql; qz /= ql;
                    // the lowest-numbered neighbour, kept as a fallback that is
                    // a real direction in the MOLECULE rather than in the view
                    if (far < pickIdx) { pickIdx = far; pick = [qx, qy, qz]; }
                    const cx = ty * qz - tz * qy;
                    const cy = tz * qx - tx * qz;
                    const cz = tx * qy - ty * qx;
                    const w = Math.hypot(cx, cy, cz);
                    if (w < 1e-9) continue;
                    const th = Math.atan2(cx * e2[0] + cy * e2[1] + cz * e2[2],
                        cx * e1[0] + cy * e1[1] + cz * e1[2]);
                    accX += w * Math.cos(2 * th);
                    accY += w * Math.sin(2 * th);
                    accW += w;
                }
            }
            // A SET OF PLANES THAT CANCELS NAMES NO PLANE. Judged against what
            // went in, not against zero: a residue left by symmetry is small
            // but not tiny, and its direction is meaningless either way. The
            // tetrahedral centre lands here, and takes a neighbour instead.
            let sx = 0; let sy = 0; let sz = 0;
            if (accW > 0 && Math.hypot(accX, accY) > 0.05 * accW) {
                const half = Math.atan2(accY, accX) / 2;
                const ch = Math.cos(half); const sh = Math.sin(half);
                sx = e1[0] * ch + e2[0] * sh;
                sy = e1[1] * ch + e2[1] * sh;
                sz = e1[2] * ch + e2[2] * sh;
            }
            // ...and if there are no neighbours to read - an isolated bond -
            // there is nothing in the neighbourhood to read a roll from. A
            // section still has to be rolled SOMEHOW, and the one thing that
            // must not decide it is the view: a square has only four-fold
            // symmetry, so a roll taken off a screen axis stays put while the
            // structure turns under it, and the rod visibly refuses to rotate.
            // Measured on a lone centred bond: 34 degrees of drift across 16
            // viewing angles.
            //
            // So the choice is made in MODEL space, where the molecule sits
            // still, and carried into view space by the same rotation that put
            // the coordinates there. Any fixed axis will do as the seed - what
            // matters is only that it is fixed in the MOLECULE.
            const R3 = vs && vs.rotation;
            let modelRoll = null;
            if (R3 && renderer.coords) {
                const A = renderer.coords[bd.a];
                const B = renderer.coords[bd.b];
                if (A && B) {
                    let dxm = B.x - A.x; let dym = B.y - A.y; let dzm = B.z - A.z;
                    const dl = Math.hypot(dxm, dym, dzm);
                    if (dl > 1e-9) {
                        dxm /= dl; dym /= dl; dzm /= dl;
                        // the world axis least parallel to the bond, so the
                        // projection below never lands on nothing
                        const ax = (Math.abs(dxm) < 0.9) ? [1, 0, 0] : [0, 1, 0];
                        const d0 = ax[0] * dxm + ax[1] * dym + ax[2] * dzm;
                        const px = ax[0] - dxm * d0;
                        const py = ax[1] - dym * d0;
                        const pz = ax[2] - dzm * d0;
                        const pl = Math.hypot(px, py, pz);
                        if (pl > 1e-9) {
                            const mxr = px / pl; const myr = py / pl; const mzr = pz / pl;
                            modelRoll = [
                                R3[0][0] * mxr + R3[0][1] * myr + R3[0][2] * mzr,
                                R3[1][0] * mxr + R3[1][1] * myr + R3[1][2] * mzr,
                                R3[2][0] * mxr + R3[2][1] * myr + R3[2][2] * mzr];
                        }
                    }
                }
            }
            // Each fallback is a direction the MOLECULE supplies, so it turns
            // with the structure: a neighbour first, then the line back to the
            // centre of the view volume. The axis triple at the end is fixed in
            // VIEW space and so does not - but by then the bond has no
            // neighbours and no offset from the centre, and a lone rod on the
            // axis looks the same whichever way its square is rolled.
            // Either end's surface will do as the SEED: it only sets which way
            // the square is rolled along the whole bond, and each end is then
            // cut into its own plane on top of that. End 0 first so a side
            // chain, which only ever has one, is unchanged.
            const rn = bd.rollN && (bd.rollN[0] || bd.rollN[1]);
            const u = (rn && perp(rn[0], rn[1], rn[2]))
                || perp(sx, sy, sz)
                || (pick && perp(pick[0], pick[1], pick[2]))
                || (modelRoll && perp(modelRoll[0], modelRoll[1], modelRoll[2]))
                || perp(-mx, -my, -mz)
                || perp(1, 0, 0) || perp(0, 1, 0) || perp(0, 0, 1);
            if (!u) return null;
            const vv = [ty * u[2] - tz * u[1], tz * u[0] - tx * u[2],
                tx * u[1] - ty * u[0]];
            return { t: [tx, ty, tz], u, v: vv, mid: [mx, my, mz] };
        };

        const stickBox = (bd) => {
            const fr = bd.fr;
            if (!fr) return false;
            // A BOND MAY CARRY ITS OWN SECTION. Ligand and side-chain sticks all
            // share one, which is what stickHW/stickHT are - but a CONTACT is a
            // bond too, and it has its own width in Angstrom (CONTACT_WIDTH,
            // "on the same scale the Line Width control works in"). So the
            // section is asked of the bond first and falls back to the stick's,
            // and the flatness test follows it rather than the global one: a
            // contact drawn as a solid box beside flat ligand sticks is right,
            // and the reverse is right too.
            const bHW = bd.hw !== undefined ? bd.hw : stickHW;
            const bHT = bd.ht !== undefined ? bd.ht : stickHT;
            const bFlat = bHT <= 0.5 * bHW * 0.02;
            const bSides = (bd.sides && bd.sides >= 3) ? (bd.sides | 0) : 4;
            const va = bd.va;
            const vb = bd.vb;
            const tx = fr.t[0]; const ty = fr.t[1]; const tz = fr.t[2];
            const u = fr.u; const vv = fr.v;
            const mx = fr.mid[0]; const my = fr.mid[1]; const mz = fr.mid[2];
            // The four corners at each end: the mitred quad where a junction
            // solved one, otherwise the plain square section.
            // ONE SECTION FRAME PER END, not one per bond. A mitred end is
            // rolled onto its own junction's plane, and a bond running between
            // two junctions in different planes has to TWIST from one to the
            // other along its length - the ruled side faces do exactly that.
            // The half turn is a symmetry of a square, so the far end's sign is
            // flipped where that turns it the shorter way, keeping the twist
            // under 90 degrees; past that a square prism starts to pinch. That
            // flip relabels the corners by two places, so a mitred quad already
            // written in the other sign is rotated to match rather than being
            // rebuilt.
            // AN UNPINNED END TAKES THE OTHER END'S ROLL. Only a junction or a
            // sweep fixes a section; an end with neither is free to sit any way
            // round, and the value the roll rule produced there is arbitrary.
            // Keeping it anyway is twist for nothing: the bond turns from that
            // arbitrary roll to whatever the pinned end needs. A terminal bond
            // off a junction is the common case - measured on an ILE with its
            // sp3 centre mitred, CA-CB turned 28 degrees and CB-CG2 24, both
            // with a free far end that could simply have matched.
            const alongT = (v) => {
                const d = v[0] * tx + v[1] * ty + v[2] * tz;
                const ax = v[0] - tx * d;
                const ay = v[1] - ty * d;
                const az = v[2] - tz * d;
                const l = Math.hypot(ax, ay, az);
                return l > 1e-6 ? [ax / l, ay / l, az / l] : null;
            };
            let u0 = bd.roll0 || (bd.roll1 ? (alongT(bd.roll1) || u) : u);
            let u1 = bd.roll1 || (bd.roll0 ? (alongT(bd.roll0) || u) : u);
            let cut1 = bd.cut1;
            if (u1[0] * u0[0] + u1[1] * u0[1] + u1[2] * u0[2] < 0) {
                u1 = [-u1[0], -u1[1], -u1[2]];
                if (cut1) cut1 = [cut1[2], cut1[3], cut1[0], cut1[1]];
            }
            const vOf = (uu) => [ty * uu[2] - tz * uu[1], tz * uu[0] - tx * uu[2],
                tx * uu[1] - ty * uu[0]];
            const v0 = vOf(u0);           // vOf(fr.u) is fr.v, so an unmitred
            const v1 = vOf(u1);           // end reproduces the old frame exactly
            // segC: the colour for THIS sub-segment. A box is already cut into
            // K pieces that SHARE their sections - that is how twist is handled
            // - so giving the pieces different colours cuts a bond in two
            // without cutting the solid: no second box, no abutting caps, no
            // seam to ink, and nothing added to any graph. It is the machinery
            // that was already here.
            const emitSeg = (secA, secB, firstSeg, lastSeg, segC) => {
            const V = [];
            const W = [];                       // the same eight, in Angstroms
            for (const sec of [secA, secB]) {
                for (let k = 0; k < sec.length; k++) {
                    const w = sec[k];
                    const q = project(w[0], w[1], w[2]);
                    if (!q) return false;
                    W.push(w);
                    V.push(q);
                }
            }
            // Orientation against the EYE RAY, taken once at the bond's middle
            // - the same quantity the ribbon uses, for the same reason: under
            // perspective the rays diverge, so a face near the edge of the
            // canvas can look at the eye while its normal's raw z is negative.
            //
            // IN VIEW SPACE, WHERE THE NORMALS LIVE. The camera sits at
            // (0, 0, fl) in Angstroms, so the ray from a point to the eye is
            // simply (-x, -y, fl - z) there. Feeding the PROJECTED point in
            // instead mixes spaces: screen x and y carry the canvas-centre
            // offset and the pixel scale while z stays in Angstroms, so the
            // centre offset dominates and the "eye ray" points off sideways.
            // Faces that plainly face the viewer then test as back-facing and
            // are culled - whole sides of a stick go missing, but only under
            // perspective, because ortho never evaluates this branch.
            let smx = 0; let smy = 0; let smz = 0;
            for (const w of W) { smx += w[0]; smy += w[1]; smz += w[2]; }
            smx /= 8; smy /= 8; smz /= 8;
            if (!project(smx, smy, smz)) return false;  // behind the camera?
            let ex = 0; let ey = 0; let ez = 1;
            if (persp) {
                ex = -smx; ey = -smy; ez = fl - smz;
                const em = Math.hypot(ex, ey, ez) || 1;
                ex /= em; ey /= em; ez /= em;
            }
            // ONE NORMAL PER FACE, taken from the face's own corners rather
            // than from the box's axes. A mitred end is an OBLIQUE cut, so its
            // outward normal is the mitre plane's, not the bond axis: culling
            // and lighting it as though it faced along the bond drops it at the
            // wrong angles, which shows as a hole where the junction should be.
            // The cross product of the diagonals also copes with a face that is
            // slightly non-planar, which a twisted box has.
            // the mean of all eight, which is inside any convex solid; the
            // midpoint of two opposite corners is not, once an end is cut
            // obliquely, and a centre outside the box flips some of its
            // normals inward
            let cx3 = 0; let cy3 = 0; let cz3 = 0;
            for (const w of W) { cx3 += w[0]; cy3 += w[1]; cz3 += w[2]; }
            cx3 /= W.length; cy3 /= W.length; cz3 /= W.length;
            const o = [];
            const l = [];
            const RT = ringTables(bSides);
            const SF = bFlat ? STICK_FACES_FLAT : RT.faces;
            for (const f of SF) {
                // NEWELL, over however many corners the face has. A tube's
                // caps are n-gons, and the two-diagonal cross product is only
                // the quad's special case of this - it reads f.q[3] and there
                // may not be one. Newell is also the right answer for a
                // non-planar face, which a twisted side facet is.
                const fw = f.q.map((vi) => W[vi]);
                const p0 = fw[0]; const p1 = fw[1];
                let nx2 = 0; let ny2 = 0; let nz2 = 0;
                for (let i2 = 0; i2 < fw.length; i2++) {
                    const a2 = fw[i2];
                    const b2 = fw[(i2 + 1) % fw.length];
                    nx2 += (a2[1] - b2[1]) * (a2[2] + b2[2]);
                    ny2 += (a2[2] - b2[2]) * (a2[0] + b2[0]);
                    nz2 += (a2[0] - b2[0]) * (a2[1] + b2[1]);
                }
                const nl2 = Math.hypot(nx2, ny2, nz2);
                if (nl2 < 1e-9) { o.push(0); l.push(0); continue; }
                nx2 /= nl2; ny2 /= nl2; nz2 /= nl2;
                // point it away from the box's middle - except on a sheet,
                // where the face centroid IS the middle and that difference is
                // zero, so the test would be deciding on rounding noise. A
                // double-sided face has no outward direction to find: orient it
                // at the eye, which both keeps it lit and makes it always drawn.
                if (f.two) {
                    if (nx2 * ex + ny2 * ey + nz2 * ez < 0) {
                        nx2 = -nx2; ny2 = -ny2; nz2 = -nz2;
                    }
                } else {
                    let gx = 0; let gy = 0; let gz = 0;
                    for (const q of fw) { gx += q[0]; gy += q[1]; gz += q[2]; }
                    gx = gx / fw.length - cx3;
                    gy = gy / fw.length - cy3;
                    gz = gz / fw.length - cz3;
                    if (nx2 * gx + ny2 * gy + nz2 * gz < 0) {
                        nx2 = -nx2; ny2 = -ny2; nz2 = -nz2;
                    }
                }
                // A TWISTED BOX HAS NON-PLANAR SIDES. Once an end is rolled onto
                // its junction's plane the bond turns along its length, and a
                // side face is then a ruled surface, not a flat quad: it can
                // face the eye down one half and away down the other. Culling
                // it on the averaged normal alone throws the whole face away
                // and takes the visible half with it. So the face is kept if
                // EITHER of its triangles faces the eye, while the averaged
                // normal - which is what the surface does on the whole - still
                // decides how the face is lit and how squarely it reads.
                let best = nx2 * ex + ny2 * ey + nz2 * ez;
                const tris = [];
                for (let i2 = 1; i2 + 1 < fw.length; i2++) {
                    tris.push([fw[0], fw[i2], fw[i2 + 1]]);
                }
                for (const [A, B, C] of tris) {
                    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
                    const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
                    let X = e1[1] * e2[2] - e1[2] * e2[1];
                    let Y = e1[2] * e2[0] - e1[0] * e2[2];
                    let Z = e1[0] * e2[1] - e1[1] * e2[0];
                    const m = Math.hypot(X, Y, Z);
                    if (m < 1e-9) continue;
                    X /= m; Y /= m; Z /= m;
                    if (X * nx2 + Y * ny2 + Z * nz2 < 0) { X = -X; Y = -Y; Z = -Z; }
                    const ot = X * ex + Y * ey + Z * ez;
                    if (ot > best) best = ot;
                }
                o.push(best);
                l.push(nx2 * LIGHT[0] + ny2 * LIGHT[1] + nz2 * LIGHT[2]);
            }
            const prim = {
                // only the bond's OWN ends can be free; a cut made inside the
                // bond has the next segment on the other side of it
                free0: firstSeg && (boxDeg.get(bd.a) || 0) === 1,
                free1: lastSeg && (boxDeg.get(bd.b) || 0) === 1,
                gs0: Math.min(bd.a, bd.b),
            };
            // ONE PRIMITIVE PER FACE, not per box. Prims carry a single depth
            // key and are painted in that order, and a whole box is far too big
            // to have one: where two boxes overlap at an atom their ends
            // interleave, so sorting by box paints a surface that is behind
            // over one in front. Measured on a real heme, 3.3% of the pixels
            // where sticks overlap had a farther face painted last - which is
            // seen as a chunk of the stick missing. A face is small and flat,
            // so its own centroid depth is an honest key.
            //
            // Every face is emitted, including the ones turned away. They are
            // not painted, but they belong in the occluder sets: the cap faces
            // at a shared atom are what hides the neighbouring box's buried
            // edges.
            for (let fi = 0; fi < SF.length; fi++) {
                const f = SF[fi];
                // A CAP IS INTERIOR EXACTLY WHEN ITS END WAS CUT. An interior
                // face has material on both sides, and painting one is a fault
                // no depth sort can repair: it is front-facing for exactly one
                // of the two solids that share it, and that one paints it over
                // its neighbour. From behind a bend it read as a panel laid
                // across the joint.
                //
                // An end is cut in exactly two situations, and both put solid
                // on the far side:
                //   MERGED SEAM  - the neighbouring box holds the identical
                //                  polygon, so the two are face to face;
                //   MITRED JOINT - the cut quad is the side wall of the little
                //                  prism in the middle, which is solid and is
                //                  filled top and bottom.
                // Checked rather than assumed: with the cut quads dropped, the
                // remaining faces use every edge exactly twice - a closed
                // surface - for 3-way and 4-way junctions alike, so nothing can
                // show through. See tests/junction_math.py.
                //
                // An end that is FREE, or that merely OVERLAPS its neighbours
                // (a tetrahedral centre, where there is no shared plane and so
                // no prism), is never cut, and its cap is boundary. Suppressing
                // those by degree alone opened real holes - 2.7% of a three-way
                // planar centre's area, 3.1% of a heme's.
                // A SIDE CHAIN'S CA END KEEPS ITS CAP ONLY IF THAT CAP LIES IN
                // THE RIBBON. Cut into the surface plane it IS the square lying
                // on the backbone, and drawing it is what closes the box - drop
                // it and you see in through the end. Where the cut declined -
                // the bond running too nearly along the surface to solve - the
                // cap is back to being perpendicular to the stick, a lid at the
                // wrong angle over the join, and is buried instead, exactly
                // like the internal joints the same flag already covers.
                // WHICH END this cap belongs to: ax 2 is the pair of end
                // sections, and its sign says which.
                // ...AND ONLY ON THE RUN'S OWN OUTER ENDS. A long bond is cut
                // into pieces, and every piece reads the same bond record - so
                // each of them thought its end sections were the ones meeting
                // the ribbon. The interior ones are buried and never painted,
                // so it did not show as a wrong face, but it did suppress their
                // ink and mark them as bases. A contact makes it easy to hit:
                // it is the one bond long enough to be cut routinely.
                const capEnd = f.ax === 2
                    ? (f.sgn < 0 ? (firstSeg ? 0 : -1) : (lastSeg ? 1 : -1))
                    : -1;
                const capRolled = capEnd >= 0 && !!(bd.rollN && bd.rollN[capEnd]);
                const capFlush = capEnd >= 0 && !!(bd.rollFlush && bd.rollFlush[capEnd]);
                const scEnd = capRolled && !capFlush;
                // THE BASE: the square that lies flat on the backbone, at the
                // end of the side chain that was cut into the ribbon's own
                // plane. It is a real face and is painted; what it does not get
                // is a RING OF INK around it. A side chain is part of the
                // residue, not an object standing on it, and an inked ring says
                // the opposite - it draws the join as a seam. Dropping it also
                // makes the one thing that can go wrong there far less visible:
                // where the box pokes a little through the ribbon surface, an
                // untraced edge reads as nothing much and an inked one reads as
                // a mistake.
                const scBase = capFlush;
                const buried = scEnd || (f.ax === 2
                    && (f.sgn < 0 ? (!firstSeg || !!bd.cut0)
                        : (!lastSeg || !!bd.cut1)));
                const fq = f.q.map((vi) => V[vi]);
                let zf = 0;
                for (const p2 of fq) zf += p2[2];
                zf /= fq.length;
                prims.push({
                    kind: 'stickFace',
                    q: fq,
                    z: zf,
                    // painted as one flat colour - see rgbCss in the fill
                    unlit: !!bd.unlit,
                    c: segC || bd.c,
                    // WHICH PALETTE SLOT THIS FACE TOOK. `ci` is the generic
                    // segment index and `half` says whether it used the
                    // segment's own colour (0) or one of the two half-bond
                    // colours (1, 2) that element colouring supplies. Together
                    // they let a consumer repaint the face from a new palette
                    // without asking for the geometry again.
                    ci: bd.ci,
                    half: segC ? (segC === (bd.halfC && bd.halfC.a) ? 1 : 2) : 0,
                    key: o[fi],
                    nl: l[fi],
                    // DOUBLE-SIDED, and a consumer has to be told. At zero
                    // thickness the box collapses to ONE quad with nothing
                    // behind it (STICK_FACES_FLAT), and the rule above is
                    // `orient it at the eye` - which is a per-VIEW decision.
                    // A consumer that keeps the geometry and re-lights it from
                    // a new angle (the WebGL2 port) must redo that, or it
                    // lights the face from wherever the camera was when the
                    // prims were taken and back-face culls it the moment the
                    // model turns - every side chain vanishing as it goes
                    // round. Absent on a solid stick, where each face has a
                    // real outward direction.
                    two: !!f.two,
                    // ...and a consumer that re-derives the outline needs to
                    // know which face this is; see baseInk below
                    base: scBase,
                    draw: o[fi] > -STICK_CULL && !buried,
                    gs0: prim.gs0,
                    gsStep: 0,
                });
            }

            // INK: THE SILHOUETTE, AND NOTHING ELSE. An edge is drawn only
            // where one of the two faces meeting along it faces the viewer and
            // the other does not. An interior crease - both faces visible, the
            // edge you see running along a stick - fails that test by
            // construction, so no line can ever cross a face. There is no
            // fallback branch here for foreshortened bonds: when a bond points
            // at the viewer the test simply yields fewer edges, which is right,
            // because there is less outline to draw.
            //
            // Cap rings are dropped at any atom that carries another bond:
            // there the ring is inside the neighbouring box, and inking it is
            // exactly the line ruled across the stick that this whole rewrite
            // is about.
            if (inkWanted) {
                const front = SF.map((f, fi) => o[fi] > 0);
                // Set renderer._stickProbe = [] before a render to collect each
                // box and the edges it inked. The property worth testing is
                // local to one box - that no edge of it lands inside its own
                // outline - and that cannot be seen from the finished canvas,
                // where a stick legitimately draws over whatever is behind it.
                const probe = renderer._stickProbe
                    ? {
                        V: V.map((q) => [q[0], q[1]]),
                        // the same eight in Angstroms, and which atom each end
                        // belongs to: a merged run is tested by checking that
                        // consecutive boxes share their end face exactly
                        W: W.map((w) => [w[0], w[1], w[2]]),
                        a: firstSeg ? bd.a : -1,
                        b: lastSeg ? bd.b : -1,
                        // was either end cut by a MITRE? such a section is
                        // oblique by construction, and its corners sit turned
                        // from a perpendicular one without the bond twisting
                        mitre0: firstSeg && !!bd.cut0 && !bd.seam0,
                        mitre1: lastSeg && !!bd.cut1 && !bd.seam1,
                        edges: [],
                        // every face with the flag that decides whether it is
                        // painted, so a test can check that the painted ones
                        // still cover the box's whole outline
                        faces: SF.map((f, fi) => ({
                            q: f.q.map((vi) => [V[vi][0], V[vi][1]]),
                            drawn: o[fi] > -STICK_CULL,
                        })),
                    } : null;
                if (probe) renderer._stickProbe.push(probe);
                // A SILHOUETTE EDGE LIES ON THE OUTLINE. That is what the word
                // means, and for a convex box with flat faces the front/back
                // test below delivers it. A junction solved out of plane does
                // not give a box like that: its section is rolled onto the
                // junction's plane at one end and carried at the other, so the
                // side faces are RULED and the test can pass for an edge that
                // sits well inside the shape. Drawn, it is a line ruled across
                // the face - the exact fault this whole construction exists to
                // avoid. Measured on a 3-legged centre lifted out of plane, it
                // reached 12 px inside at 25 degrees of pyramidalisation.
                //
                // So the rule is checked against the outline itself: the hull
                // of the box's own eight projected corners. An edge both of
                // whose ends lie clearly inside it is not a silhouette, whatever
                // the face test says.
                const hullPts = (() => {
                    const p = V.map((q) => [q[0], q[1]])
                        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
                    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1])
                        - (a[1] - o[1]) * (b[0] - o[0]);
                    const lo = []; const hi = [];
                    for (const q of p) {
                        while (hi.length > 1
                            && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
                        hi.push(q);
                    }
                    for (let i = p.length - 1; i >= 0; i--) {
                        const q = p[i];
                        while (lo.length > 1
                            && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
                        lo.push(q);
                    }
                    hi.pop(); lo.pop();
                    return hi.concat(lo);
                })();
                const insideBy = (pt) => {
                    let m = Infinity;
                    for (let i = 0; i < hullPts.length; i++) {
                        const a = hullPts[i];
                        const b = hullPts[(i + 1) % hullPts.length];
                        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
                        m = Math.min(m, ((b[0] - a[0]) * (pt[1] - a[1])
                            - (b[1] - a[1]) * (pt[0] - a[0])) / L);
                    }
                    return m;
                };
                const ON_OUTLINE = 0.5;                  // px
                for (const e of (bFlat ? STICK_EDGES_FLAT : RT.edges)) {
                    if (!bFlat && front[e.f0] === front[e.f1]) continue;
                    if (e.end === 0 && !prim.free0) continue;
                    if (e.end === 1 && !prim.free1) continue;
                    // THE BASE RING IS NOT INKED - see scBase above. Set
                    // renderer.cartoonBaseInk = true to draw it, which is what
                    // every version before this did.
                    if (!baseInk && e.end >= 0 && bd.rollFlush && bd.rollFlush[e.end]
                        && (e.end === 0 ? firstSeg : lastSeg)) continue;
                    if (hullPts.length > 2
                        && insideBy(V[e.a]) > ON_OUTLINE
                        && insideBy(V[e.b]) > ON_OUTLINE) continue;
                    if (probe) probe.edges.push([e.a, e.b]);
                    inkCurves.push({
                        id: inkCurves.length,
                        pts: [V[e.a], V[e.b]],
                        vis: [true],
                        sel: !!bd.sel,
                        gs0: prim.gs0,
                        gsStep: 0,
                        c: bd.c,
                    });
                }
            }
            return true;
            };

            // BREAK THE BOND UP TO GIVE THE TWIST SOMEWHERE TO GO. The two ends
            // of a bond can be pinned by different things - a junction's plane
            // at one, a sweep's carried frame at the other - and where those
            // disagree the section has to turn on the way across. Over a single
            // box that turn happens all at once, and the stick reads as wrung.
            // Split into enough pieces and the same total turn is shared out:
            // each piece carries the SAME shape, only less of the rotation, and
            // consecutive pieces hold the identical section polygon between
            // them so no seam can open.
            //
            // The count comes from the turn itself, so a straight bond stays a
            // single box and pays nothing. Only the interior sections are new
            // geometry; the two ends are exactly what they were, mitre or
            // sweep or square.
            // THE SECTION. Four corners is a square box; more is a tube, and
            // the ring is the SAME shape the square is - u is the thickness
            // axis and v the width, so a tube with unequal half-sizes is an
            // ellipse, and it rolls onto the ribbon and cuts into its plane
            // through exactly the code the square does. The 4-point case keeps
            // its own corner list so a ligand stick is unchanged: a generated
            // ring of 4 would be the same square rotated 45 degrees.
            const SQ = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
            const ring = bSides === 4 ? SQ : (() => {
                const out = [];
                for (let i = 0; i < bSides; i++) {
                    const a = (2 * Math.PI * i) / bSides;
                    out.push([Math.cos(a), Math.sin(a)]);
                }
                return out;
            })();
            const squareAt = (px, py, pz, uu) => {
                const vvv = vOf(uu);
                return ring.map(([su, sv]) => [
                    px + uu[0] * su * bHT + vvv[0] * sv * bHW,
                    py + uu[1] * su * bHT + vvv[1] * sv * bHW,
                    pz + uu[2] * su * bHT + vvv[2] * sv * bHW]);
            };
            // A SQUARE THAT LIES ON THE BACKBONE.
            //
            // A stick's end section is perpendicular to the STICK. Where it
            // meets the ribbon that is the wrong plane: unless the side chain
            // happens to leave exactly along the face normal, a perpendicular
            // cap cuts down through the surface on one side and lifts off it on
            // the other, and no amount of placing or rolling the box makes that
            // edge sit flat. What lies flat on the ribbon is a section in the
            // RIBBON's plane, so the four corners are slid along the bond until
            // they reach it - an oblique cut, the same thing a mitred junction
            // does to a leg, and the answer to "how would you draw a square
            // that lays on the backbone".
            //
            // Declines only when the bond runs exactly ALONG the surface, where
            // it never meets the plane and the slide is unbounded. There is no
            // angle cutoff above that - see SC_FLUSH_EPS.
            const flushCut = (end) => {
                const n = bd.rollN && bd.rollN[end];
                const pl = bd.rollP && bd.rollP[end];
                const t = bd.fr && bd.fr.t;
                if (!n || !pl || !t) return null;
                if (!(bd.rollFlush && bd.rollFlush[end])) return null;
                const dn = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
                if (Math.abs(dn) < SC_FLUSH_EPS) return null;
                // The square is built where the ATOM is, so the box is the whole
                // bond; each corner then slides along the bond to the ribbon's
                // surface, which is the slice the backbone takes out of it.
                const p0 = end === 0 ? va : vb;
                const sq = squareAt(p0.x, p0.y, p0.z, end === 0 ? u0 : u1);
                return sq.map((c) => {
                    const sl = ((pl.x - c[0]) * n[0] + (pl.y - c[1]) * n[1]
                        + (pl.z - c[2]) * n[2]) / dn;
                    return [c[0] + t[0] * sl, c[1] + t[1] * sl, c[2] + t[2] * sl];
                });
            };
            const secA = bd.cut0 || flushCut(0) || squareAt(va.x, va.y, va.z, u0);
            const secB = cut1 || flushCut(1) || squareAt(vb.x, vb.y, vb.z, u1);
            // THE TURN IS READ OFF THE SECTIONS, NOT OFF THE ROLLS. Where an end
            // is cut by a junction its corners come from the corner solve, and
            // the roll is only the axis that solve was built on - at an oblique
            // cut the two are not the same, and the roll angle can read as
            // nothing while the corners are most of a quarter turn apart. Since
            // it is the CORNERS that the side faces connect, and the corners the
            // eye sees, the section is asked directly: corners 0 and 1 are the
            // +u pair, so their midpoint marks that face, and the angle between
            // those marks across the bond is the turn to be shared out.
            const faceMark = (sec) => {
                let cx3 = 0; let cy3 = 0; let cz3 = 0;
                for (const q of sec) { cx3 += q[0]; cy3 += q[1]; cz3 += q[2]; }
                const m = sec.length;
                return alongT([(sec[0][0] + sec[1][0]) / 2 - cx3 / m,
                    (sec[0][1] + sec[1][1]) / 2 - cy3 / m,
                    (sec[0][2] + sec[1][2]) / 2 - cz3 / m]);
            };
            const mA = faceMark(secA);
            const mB = faceMark(secB);
            let tw = 0;
            if (mA && mB) {
                const vA = vOf(mA);
                tw = Math.atan2(
                    mB[0] * vA[0] + mB[1] * vA[1] + mB[2] * vA[2],
                    Math.max(-1, Math.min(1,
                        mB[0] * mA[0] + mB[1] * mA[1] + mB[2] * mA[2])));
            }
            const MAX_SEG_TWIST = 18 * Math.PI / 180;
            // AN EVEN K WHEN THE BOND IS TWO COLOURS, so a piece boundary lands
            // exactly at the middle and the two halves are whole numbers of
            // pieces. Twist alone decides it otherwise.
            let K = Math.max(1, Math.min(8, Math.ceil(Math.abs(tw) / MAX_SEG_TWIST)));
            // ...AND BY LENGTH, for a bond that spans the picture. Twist alone
            // is the right measure for a stick a bond long: it is what decides
            // whether the ruled side faces read as wrung. A CONTACT can cross
            // the whole structure dead straight, so it twists not at all and
            // would come out as one box - one depth key for each of its side
            // faces over their whole span, sorting as if the contact were all
            // at its own midpoint, which is exactly what it must not do when it
            // passes behind one thing and in front of the next. Same 2 A pitch
            // and same ceiling the flat stroke used.
            if (bd.segA) {
                const bl = Math.hypot(vb.x - va.x, vb.y - va.y, vb.z - va.z);
                K = Math.max(K, Math.min(CONTACT_SEG_MAX,
                    Math.ceil(bl / bd.segA)));
            }
            if (bd.halfC && bd.halfC.a && bd.halfC.b) K = Math.max(2, K + (K % 2));
            const secs = [secA];
            for (let k = 1; k < K; k++) {
                const f = k / K;
                let sec;
                if (mA) {
                    const ang = tw * f;
                    const ca = Math.cos(ang); const sa = Math.sin(ang);
                    const vA = vOf(mA);
                    const uk = [mA[0] * ca + vA[0] * sa, mA[1] * ca + vA[1] * sa,
                        mA[2] * ca + vA[2] * sa];
                    sec = squareAt(va.x + (vb.x - va.x) * f,
                        va.y + (vb.y - va.y) * f,
                        va.z + (vb.z - va.z) * f, uk);
                } else {
                    // NO FACE MARK TO ROTATE. faceMark returns null on a
                    // degenerate section - a flat stick, thickness 0 - and with
                    // no mark there is no twist either (tw stays 0), so the
                    // section does not turn along the bond and interpolating
                    // its corners IS the section at f. Forcing this path to run
                    // without the guard is what threw on a null mark the first
                    // time a bond was cut in two.
                    sec = secA.map((q, i2) => [
                        q[0] + (secB[i2][0] - q[0]) * f,
                        q[1] + (secB[i2][1] - q[1]) * f,
                        q[2] + (secB[i2][2] - q[2]) * f,
                    ]);
                }
                secs.push(sec);
            }
            secs.push(secB);
            let any = false;
            for (let k = 0; k < K; k++) {
                // the near half takes the first end's colour, the far half the
                // second's; K is even whenever this is set, so the boundary is
                // the middle of the bond
                const segC = (bd.halfC && bd.halfC.a && bd.halfC.b)
                    ? (k < K / 2 ? bd.halfC.a : bd.halfC.b) : null;
                if (emitSeg(secs[k], secs[k + 1], k === 0, k === K - 1, segC)) any = true;
            }
            return any;
        };

        {
            const sameStyle = (p, q) => p.w === q.w && p.flat === q.flat
                && p.sel === q.sel && p.c.r === q.c.r && p.c.g === q.c.g
                && p.c.b === q.c.b;
            const used = new Set();
            // Extend from `bd` away from atom `from`, while the far atom has
            // exactly two bonds and the next one matches.
            const walk = (bd, from, pts, idxs) => {
                let cur = bd;
                let at2 = (cur.a === from) ? cur.b : cur.a;
                for (;;) {
                    if ((deg.get(at2) || 0) !== 2) break;
                    const next = (inc.get(at2) || []).find((o) => o !== cur
                        && !used.has(o) && sameStyle(o, cur));
                    if (!next) break;
                    used.add(next);
                    const far = (next.a === at2) ? next.b : next.a;
                    pts.push((next.a === at2) ? next.B : next.A);
                    idxs.push(far);
                    cur = next;
                    at2 = far;
                }
                return at2;
            };
            // --- MITRED JUNCTIONS ------------------------------------------
            // Two legs meeting at an atom share the corner where their facing
            // side faces cross, at d = h*cot(theta/2) along each of them. The
            // corners bound each leg's end - which is why a mitred end is a
            // trapezoid and not a square - and for three or more legs they also
            // bound the polygon left in the middle, which is filled above and
            // below to close the joint.
            //
            // This is exact for legs that SHARE A PLANE and undefined for legs
            // that do not: a tetrahedral centre has no plane, so there is no
            // above and below to fill. So it runs only there. Everywhere else
            // the boxes run to the atom and overlap, which needs no geometry
            // and cannot be wrong. tests/junction_math.py has the derivation.
            for (const bd of bondList) {
                if (!bd.flat) bd.fr = stickFrame(bd);
            }
            // which atoms the mitre actually solved: the run pass below may
            // carry a path THROUGH any junction it did not
            const mitredAtoms = new Set();
            for (const [atom, arr] of inc) {
                let legs = arr.filter((bd) => !bd.flat && bd.fr);
                // Three legs or more. An atom with exactly two is the interior
                // of a linear run and belongs to the sweep below, which joins it
                // without pinning its roll; mitring it here as well would put
                // the twist straight back in.
                if (legs.length < 3) continue;
                const pA = at(atom) || rotated[atom];
                if (!pA) continue;
                // each leg's direction AWAY from this atom
                const dirAll = legs.map((bd) => {
                    const s = (bd.a === atom) ? 1 : -1;
                    return [bd.fr.t[0] * s, bd.fr.t[1] * s, bd.fr.t[2] * s];
                });
                let dir = dirAll;
                // A TETRAHEDRAL CENTRE IS THREE LEGS PLUS ONE. The mitre below
                // walks the legs in angular order about an axis, which is a
                // two-dimensional idea: an sp3 centre has no such order, and
                // forcing one puts the two corners that are meant to be a single
                // point 0.36 A apart - most of a stick's width - which snapping
                // then paints over. So it used to give up here and let the boxes
                // overlap.
                //
                // But four sp3 directions SUM TO ZERO, so the sum of any three
                // is exactly minus the fourth. The mitre's axis for a triple is
                // that sum, therefore the leg left out points exactly back down
                // the axis - straight through the middle of the bottom triangle
                // the mitre already leaves behind. Nothing has to be invented:
                // mitre three (exact, unchanged), and run a COLLAR from that
                // triangle to the fourth leg's section instead of filling it.
                // Measured in tests/junction_sp3.py: the leg leaves 0.00 deg off
                // axis on an ideal centre and 1.1 / 10.6 deg on GDP's two real
                // phosphates, and the mitre's residual goes 0.36 A -> 0.010 A.
                let collarBd = null;
                let collarDir = null;
                let forcedAx = null;
                // ONLY WHERE THE MITRE CANNOT REACH. A PLANAR four-way - a
                // haem's iron, a square-planar metal - stands around its own
                // plane normal and mitres exactly, and must be left alone. It
                // also passes the collar's own test with full marks, because in
                // a planar cross the three remaining legs sum to the opposite of
                // the one left out, so the omitted leg reads as leaving straight
                // down the axis. Gating on "four legs" alone therefore stole
                // every planar centre and distorted the iron. The collar is for
                // centres with NO plane.
                let hasPlane = false;
                if (legs.length === 4) {
                    let px = 0; let py = 0; let pz = 0;
                    for (let i2 = 0; i2 < dirAll.length; i2++) {
                        for (let j2 = i2 + 1; j2 < dirAll.length; j2++) {
                            let cx = dirAll[i2][1] * dirAll[j2][2] - dirAll[i2][2] * dirAll[j2][1];
                            let cy = dirAll[i2][2] * dirAll[j2][0] - dirAll[i2][0] * dirAll[j2][2];
                            let cz = dirAll[i2][0] * dirAll[j2][1] - dirAll[i2][1] * dirAll[j2][0];
                            if (px * cx + py * cy + pz * cz < 0) { cx = -cx; cy = -cy; cz = -cz; }
                            px += cx; py += cy; pz += cz;
                        }
                    }
                    const pl = Math.hypot(px, py, pz);
                    if (pl > 1e-6) {
                        let tilt = 0;
                        for (const d of dirAll) {
                            tilt = Math.max(tilt, Math.abs(
                                (d[0] * px + d[1] * py + d[2] * pz) / pl));
                        }
                        if (tilt < 0.50) hasPlane = true;
                    }
                }
                if (legs.length === 4 && !hasPlane) {
                    // WHICH LEG TO LEAVE OUT IS A PROPERTY OF THE MOLECULE, and
                    // has to be decided like one. An IDEAL tetrahedron ties all
                    // four triples at exactly 1, and this runs on ROTATED
                    // coordinates, so picking the numerical maximum let rounding
                    // choose - a different triple per view, and the section
                    // visibly rolled 38 deg as the structure turned. So near-ties
                    // are broken by the bonded atom's own index, which no camera
                    // can change.
                    const cand = [];
                    for (let k = 0; k < 4; k++) {
                        let sx = 0; let sy = 0; let sz = 0;
                        for (let i2 = 0; i2 < 4; i2++) {
                            if (i2 === k) continue;
                            sx += dirAll[i2][0]; sy += dirAll[i2][1]; sz += dirAll[i2][2];
                        }
                        const sl = Math.hypot(sx, sy, sz);
                        if (sl < 1e-6) continue;
                        const a3 = [sx / sl, sy / sl, sz / sl];
                        // want the omitted leg to point back ALONG the axis
                        const dt = -(dirAll[k][0] * a3[0] + dirAll[k][1] * a3[1]
                            + dirAll[k][2] * a3[2]);
                        const far = (legs[k].a === atom) ? legs[k].b : legs[k].a;
                        cand.push({ k, dt, a3, far });
                    }
                    let bestK = -1; let bestDot = -2; let bestAx = null;
                    if (cand.length) {
                        let top = -2;
                        for (const c of cand) if (c.dt > top) top = c.dt;
                        let pick = null;
                        for (const c of cand) {
                            if (c.dt < top - 1e-3) continue;
                            if (!pick || c.far < pick.far) pick = c;
                        }
                        bestK = pick.k; bestDot = top; bestAx = pick.a3;
                    }
                    // cos 40 deg: past that the leg is not leaving down the hole
                    // and the collar would have to double back on itself
                    if (bestK >= 0 && bestDot > 0.766) {
                        collarBd = legs[bestK];
                        collarDir = dirAll[bestK];
                        legs = legs.filter((_, i2) => i2 !== bestK);
                        dir = dirAll.filter((_, i2) => i2 !== bestK);
                        forcedAx = bestAx;
                    }
                }
                // THE LEGS STOP WHERE THEY MEET, AND A POLYGON FILLS THE REST.
                // Each leg is cut by the BISECTOR plane it shares with every
                // neighbour - the same rule a two-way bend already uses - so the
                // boxes cut EACH OTHER rather than being set back from the atom.
                // Where two legs meet, their top faces meet along a ridge; the
                // ridges meet three at a time, and the corners collapse to one
                // point per pair. What is left open is a single polygon at each
                // end - a triangle for three legs, a quadrilateral for four.
                //
                // Checked in tests/junction_math.py: every edge of the finished
                // solid is used exactly twice, for a planar centre, a shallow
                // pyramid and a full sp3 one alike. Nothing is widened, narrowed
                // or sheared: each leg keeps its own square section, and its
                // cut is where the neighbour actually is.
                //
                // THE AXIS the sections are rolled onto is the PLANE'S NORMAL
                // wherever the legs have a plane, and only otherwise the way the
                // tripod points.
                //
                // Deciding that by whether the legs sum to zero is wrong, and
                // wrong in the worst way: a real planar centre is not perfectly
                // symmetric - a haem's ring carbons come out at 127/124/106 -
                // so its legs sum to something appreciable, lying IN the plane.
                // Rolling the sections onto that stands every one of them on
                // edge, and a flat porphyrin comes out twisted.
                //
                // So the plane is looked for first: fit a normal, and if every
                // leg lies near it, that is the axis. A tripod that genuinely
                // has no plane - an sp3 centre, 50 degrees out - falls through
                // to the sum, which is what points along its apex.
                let ax = forcedAx;
                if (!ax) {
                    let nx3 = 0; let ny3 = 0; let nz3 = 0;
                    for (let i2 = 0; i2 < dir.length; i2++) {
                        for (let j2 = i2 + 1; j2 < dir.length; j2++) {
                            let cx = dir[i2][1] * dir[j2][2] - dir[i2][2] * dir[j2][1];
                            let cy = dir[i2][2] * dir[j2][0] - dir[i2][0] * dir[j2][2];
                            let cz = dir[i2][0] * dir[j2][1] - dir[i2][1] * dir[j2][0];
                            // a plane has a normal, not a signed one: agree with
                            // the running sum before adding, or a symmetric
                            // centre cancels itself to nothing
                            if (nx3 * cx + ny3 * cy + nz3 * cz < 0) {
                                cx = -cx; cy = -cy; cz = -cz;
                            }
                            nx3 += cx; ny3 += cy; nz3 += cz;
                        }
                    }
                    const nl3 = Math.hypot(nx3, ny3, nz3);
                    if (nl3 > 1e-6) {
                        const n3 = [nx3 / nl3, ny3 / nl3, nz3 / nl3];
                        let tilt = 0;
                        for (const d of dir) {
                            tilt = Math.max(tilt, Math.abs(d[0] * n3[0]
                                + d[1] * n3[1] + d[2] * n3[2]));
                        }
                        if (tilt < 0.50) ax = n3;        // they share a plane
                    }
                    if (!ax) {                            // no plane: the apex
                        let sx = 0; let sy = 0; let sz = 0;
                        for (const d of dir) { sx += d[0]; sy += d[1]; sz += d[2]; }
                        const sl = Math.hypot(sx, sy, sz);
                        if (sl > 0.2) ax = [sx / sl, sy / sl, sz / sl];
                    }
                    if (!ax) continue;                    // collinear
                }
                // four or more legs must stand around that axis for the ring
                // below to walk them in order; a tetrahedral centre does not
                if (!collarBd && legs.length > 3) {
                    let tilt = 0;
                    for (const d of dir) {
                        tilt = Math.max(tilt, Math.abs(d[0] * ax[0] + d[1] * ax[1]
                            + d[2] * ax[2]));
                    }
                    if (tilt > 0.50) continue;
                }
                let e1a = null;
                for (let i2 = 0; i2 < dir.length && !e1a; i2++) {
                    const cx = ax[1] * dir[i2][2] - ax[2] * dir[i2][1];
                    const cy = ax[2] * dir[i2][0] - ax[0] * dir[i2][2];
                    const cz = ax[0] * dir[i2][1] - ax[1] * dir[i2][0];
                    const cl = Math.hypot(cx, cy, cz);
                    if (cl > 1e-6) e1a = [cx / cl, cy / cl, cz / cl];
                }
                if (!e1a) continue;
                const e2a = [ax[1] * e1a[2] - ax[2] * e1a[1],
                    ax[2] * e1a[0] - ax[0] * e1a[2],
                    ax[0] * e1a[1] - ax[1] * e1a[0]];
                // where each corner ray of each leg meets the nearest bisector
                const corner = []; const uOf = []; const ang = [];
                let cutOk = true;
                for (let i2 = 0; i2 < legs.length && cutOk; i2++) {
                    const d = dir[i2];
                    const dax = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
                    let u = [ax[0] - d[0] * dax, ax[1] - d[1] * dax, ax[2] - d[2] * dax];
                    let ul = Math.hypot(u[0], u[1], u[2]);
                    if (ul < 1e-6) {
                        const r = (Math.abs(d[2]) < 0.9) ? [0, 0, 1] : [1, 0, 0];
                        const rd = r[0] * d[0] + r[1] * d[1] + r[2] * d[2];
                        u = [r[0] - d[0] * rd, r[1] - d[1] * rd, r[2] - d[2] * rd];
                        ul = Math.hypot(u[0], u[1], u[2]);
                        if (ul < 1e-6) { cutOk = false; break; }
                    }
                    u = [u[0] / ul, u[1] / ul, u[2] / ul];
                    const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2],
                        d[0] * u[1] - d[1] * u[0]];
                    const q = (legs[i2].a === atom) ? legs[i2].vb : legs[i2].va;
                    const len = Math.hypot(q.x - pA.x, q.y - pA.y, q.z - pA.z);
                    const four = [];
                    for (const [su, sv] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
                        const off = [u[0] * su * stickHT + v[0] * sv * stickHW,
                            u[1] * su * stickHT + v[1] * sv * stickHW,
                            u[2] * su * stickHT + v[2] * sv * stickHW];
                        let t = 0;
                        for (let j2 = 0; j2 < dir.length; j2++) {
                            if (i2 === j2) continue;
                            const nx3 = d[0] - dir[j2][0];
                            const ny3 = d[1] - dir[j2][1];
                            const nz3 = d[2] - dir[j2][2];
                            const den = d[0] * nx3 + d[1] * ny3 + d[2] * nz3;
                            if (Math.abs(den) < 1e-9) continue;
                            const tj = -(off[0] * nx3 + off[1] * ny3 + off[2] * nz3) / den;
                            if (tj > t) t = tj;
                        }
                        if (t > 0.35 * len) { cutOk = false; break; }
                        four.push([pA.x + d[0] * t + off[0], pA.y + d[1] * t + off[1],
                            pA.z + d[2] * t + off[2]]);
                    }
                    if (!cutOk) break;
                    corner.push(four);
                    uOf.push(u);
                    ang.push(Math.atan2(
                        d[0] * e2a[0] + d[1] * e2a[1] + d[2] * e2a[2],
                        d[0] * e1a[0] + d[1] * e1a[1] + d[2] * e1a[2]));
                }
                if (!cutOk) continue;
                const ord = legs.map((_, i2) => i2).sort((x, y) => ang[x] - ang[y]);
                const kk = ord.length;
                // NEIGHBOURS ARE SNAPPED TOGETHER. Two legs' cuts land on the
                // same point only where they are mirror images about their
                // bisector; a real side chain is not that even, and the pair
                // came out about 0.03 A apart - a hairline at the ridge. Each
                // shared corner is moved to the midpoint of the two, which costs
                // nothing visible and makes the faces meet exactly.
                const dist2 = (p, q) => (p[0] - q[0]) * (p[0] - q[0])
                    + (p[1] - q[1]) * (p[1] - q[1]) + (p[2] - q[2]) * (p[2] - q[2]);
                const shareTop = []; const shareBot = [];
                for (let a2 = 0; a2 < kk; a2++) {
                    const i2 = ord[a2]; const j2 = ord[(a2 + 1) % kk];
                    for (const [ci, cj, store] of [[[0, 1], [0, 1], shareTop],
                        [[3, 2], [3, 2], shareBot]]) {
                        let best = Infinity; let bi = ci[0]; let bj = cj[0];
                        for (const x of ci) {
                            for (const y of cj) {
                                const dd = dist2(corner[i2][x], corner[j2][y]);
                                if (dd < best) { best = dd; bi = x; bj = y; }
                            }
                        }
                        const mid = [(corner[i2][bi][0] + corner[j2][bj][0]) / 2,
                            (corner[i2][bi][1] + corner[j2][bj][1]) / 2,
                            (corner[i2][bi][2] + corner[j2][bj][2]) / 2];
                        corner[i2][bi] = mid; corner[j2][bj] = mid;
                        store.push(mid);
                    }
                }
                // hand each leg its cut, in ITS OWN corner cycle
                for (let i2 = 0; i2 < legs.length; i2++) {
                    const bd = legs[i2];
                    const C4 = corner[i2];
                    const quad = (bd.a === atom) ? C4 : [C4[1], C4[0], C4[3], C4[2]];
                    mitredAtoms.add(atom);
                    if (bd.a === atom) { bd.cut0 = quad; bd.roll0 = uOf[i2]; }
                    else { bd.cut1 = quad; bd.roll1 = uOf[i2]; }
                }
                // and the hole each end is left with: one polygon through the
                // points the legs now share
                const emitEnd = (pts, nrm) => {
                    if (pts.length < 3) return;
                    const poly = [];
                    for (const w of pts) {
                        const q2 = project(w[0], w[1], w[2]);
                        if (!q2) return;
                        poly.push(q2);
                    }
                    let zs = 0;
                    for (const q2 of poly) zs += q2[2];
                    let nx = nrm[0]; let ny = nrm[1]; let nz = nrm[2];
                    // A SHEET'S JOINT IS SEEN FROM BOTH SIDES. ax's sign comes
                    // from sign-aligned cross products of the legs, so which way
                    // it points is a property of the leg ORDER, not of the view.
                    // A solid gets away with that because it emits the polygon
                    // twice and the wrong-facing copy is inside the solid; the
                    // sheet emits it once, and then that arbitrary sign decides
                    // whether the junction is lit or sits at bare ambient.
                    // Measured on a flat haem: 10 of 23 joints came out dark -
                    // the triangles and squares visible at the junctions. So
                    // orient it at the eye, the same rule the flat faces use.
                    if (stickIsFlat) {
                        let jx = 0; let jy = 0; let jz = 0;
                        for (const w of pts) { jx += w[0]; jy += w[1]; jz += w[2]; }
                        jx /= pts.length; jy /= pts.length; jz /= pts.length;
                        let gx = 0; let gy = 0; let gz = 1;
                        if (persp) {
                            gx = -jx; gy = -jy; gz = fl - jz;
                            const gm = Math.hypot(gx, gy, gz) || 1;
                            gx /= gm; gy /= gm; gz /= gm;
                        }
                        if (nx * gx + ny * gy + nz * gz < 0) {
                            nx = -nx; ny = -ny; nz = -nz;
                        }
                    }
                    // THE JUNCTION IS AT AN ATOM, so it takes THAT atom's
                    // colour. It used to take the whole bond's - legs[0].c -
                    // which under element colouring is the segment's base
                    // colour, so the triangle filling a three-way nitrogen came
                    // out in the residue's colour with three blue legs meeting
                    // in it. Which half belongs here is the same question the
                    // stick faces answer: end `a` or end `b`.
                    const jbd = legs[0];
                    const jHalf = (jbd.halfC && jbd.halfC.a && jbd.halfC.b)
                        ? (jbd.a === atom ? jbd.halfC.a : jbd.halfC.b) : null;
                    prims.push({
                        kind: 'joint', q: poly, z: zs / poly.length,
                        c: jHalf || jbd.c, gs0: atom,
                        ci: jbd.ci,
                        half: jHalf ? (jbd.a === atom ? 1 : 2) : 0,
                        nl: nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2],
                        // same as the flat stick face above: at zero thickness
                        // the junction polygon is emitted ONCE and oriented at
                        // the eye, so its facing is the view's and not the
                        // geometry's
                        two: stickIsFlat,
                        face: Math.abs(nz),
                    });
                    // set renderer._jointProbe = [] to collect the junction
                    // fills: which way each one ended up facing is not visible
                    // on the finished canvas, only in how it is lit
                    if (renderer._jointProbe) {
                        renderer._jointProbe.push({ at: atom, n: [nx, ny, nz] });
                    }
                };
                // THE COLLAR. The fourth leg leaves down the axis, through the
                // bottom triangle, so that triangle is not filled: it is the far
                // rim of a band running to the fourth leg's own section. Three
                // points to four, stitched by angle about the leg - seven
                // triangles, and every edge of the finished solid still used
                // exactly twice (tests/junction_sp3.py, stage 8).
                // ...but only where there is a solid to collar. At zero
                // thickness the fourth leg's section is a LINE, not a square,
                // and a band stitched from a triangle to a line is degenerate.
                // The three mitred legs still join perfectly well, so the leg is
                // simply left to overlap - what must NOT happen is losing the
                // whole junction, which is what gating the TRIPLE on flatness
                // did: collarBd stayed null, the four-way then hit the tilt
                // bail, and a joined phosphate came apart the moment the
                // Thickness control reached 0.
                let collared = false;
                if (collarBd && !stickIsFlat) {
                    const d4 = collarDir;
                    const d4ax = d4[0] * ax[0] + d4[1] * ax[1] + d4[2] * ax[2];
                    let u4 = [ax[0] - d4[0] * d4ax, ax[1] - d4[1] * d4ax,
                        ax[2] - d4[2] * d4ax];
                    let u4l = Math.hypot(u4[0], u4[1], u4[2]);
                    if (u4l < 1e-6) {
                        // THE FOURTH LEG LIES ON THE AXIS - which is the whole
                        // point of choosing it, and exactly so on an ideal sp3
                        // centre, so this branch is the NORMAL case and not an
                        // edge one. There is no "ax across the leg" left to roll
                        // onto, so the roll has to come from somewhere else -
                        // and it must be the MOLECULE. A screen axis here keyed
                        // the section to the camera and it rolled 38 deg as the
                        // structure turned (smoke test 13). Take it from a
                        // sibling leg instead: about 109 deg away, so never
                        // parallel, and it turns with the structure.
                        const r = dir[0];
                        const rd = r[0] * d4[0] + r[1] * d4[1] + r[2] * d4[2];
                        u4 = [r[0] - d4[0] * rd, r[1] - d4[1] * rd, r[2] - d4[2] * rd];
                        u4l = Math.hypot(u4[0], u4[1], u4[2]);
                    }
                    if (u4l > 1e-6) {
                        u4 = [u4[0] / u4l, u4[1] / u4l, u4[2] / u4l];
                        const v4 = [d4[1] * u4[2] - d4[2] * u4[1],
                            d4[2] * u4[0] - d4[0] * u4[2],
                            d4[0] * u4[1] - d4[1] * u4[0]];
                        // ONE setback for the whole section, not one per corner:
                        // the collar's near rim has to be a flat quad or the band
                        // twists. Clear of all three legs, and clear of the
                        // triangle it runs from.
                        let t4 = 0;
                        const sig4 = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
                        for (const [su, sv] of sig4) {
                            const off = [u4[0] * su * stickHT + v4[0] * sv * stickHW,
                                u4[1] * su * stickHT + v4[1] * sv * stickHW,
                                u4[2] * su * stickHT + v4[2] * sv * stickHW];
                            for (let j2 = 0; j2 < dir.length; j2++) {
                                const nx3 = d4[0] - dir[j2][0];
                                const ny3 = d4[1] - dir[j2][1];
                                const nz3 = d4[2] - dir[j2][2];
                                const den = d4[0] * nx3 + d4[1] * ny3 + d4[2] * nz3;
                                if (Math.abs(den) < 1e-9) continue;
                                const tj = -(off[0] * nx3 + off[1] * ny3
                                    + off[2] * nz3) / den;
                                if (tj > t4) t4 = tj;
                            }
                        }
                        for (const w of shareBot) {
                            const pr = (w[0] - pA.x) * d4[0] + (w[1] - pA.y) * d4[1]
                                + (w[2] - pA.z) * d4[2];
                            if (pr + 0.001 > t4) t4 = pr + 0.001;
                        }
                        const q4 = (collarBd.a === atom) ? collarBd.vb : collarBd.va;
                        const len4 = Math.hypot(q4.x - pA.x, q4.y - pA.y, q4.z - pA.z);
                        if (t4 <= 0.35 * len4) {
                            const sec4 = sig4.map(([su, sv]) => [
                                pA.x + d4[0] * t4 + u4[0] * su * stickHT
                                    + v4[0] * sv * stickHW,
                                pA.y + d4[1] * t4 + u4[1] * su * stickHT
                                    + v4[1] * sv * stickHW,
                                pA.z + d4[2] * t4 + u4[2] * su * stickHT
                                    + v4[2] * sv * stickHW]);
                            const qq = (collarBd.a === atom) ? sec4
                                : [sec4[1], sec4[0], sec4[3], sec4[2]];
                            if (collarBd.a === atom) {
                                collarBd.cut0 = qq; collarBd.roll0 = u4;
                            } else {
                                collarBd.cut1 = qq; collarBd.roll1 = u4;
                            }
                            // stitch the two rings by angle about the leg
                            const cen = (ring) => {
                                let x = 0; let y = 0; let z = 0;
                                for (const w of ring) { x += w[0]; y += w[1]; z += w[2]; }
                                return [x / ring.length, y / ring.length, z / ring.length];
                            };
                            const cB = cen(shareBot); const c4 = cen(sec4);
                            let f1 = [shareBot[0][0] - cB[0], shareBot[0][1] - cB[1],
                                shareBot[0][2] - cB[2]];
                            const f1d = f1[0] * d4[0] + f1[1] * d4[1] + f1[2] * d4[2];
                            f1 = [f1[0] - d4[0] * f1d, f1[1] - d4[1] * f1d,
                                f1[2] - d4[2] * f1d];
                            const f1l = Math.hypot(f1[0], f1[1], f1[2]);
                            if (f1l > 1e-9) {
                                f1 = [f1[0] / f1l, f1[1] / f1l, f1[2] / f1l];
                                const f2 = [d4[1] * f1[2] - d4[2] * f1[1],
                                    d4[2] * f1[0] - d4[0] * f1[2],
                                    d4[0] * f1[1] - d4[1] * f1[0]];
                                const angOf = (w, c) => {
                                    const rx = w[0] - c[0]; const ry = w[1] - c[1];
                                    const rz = w[2] - c[2];
                                    return Math.atan2(rx * f2[0] + ry * f2[1] + rz * f2[2],
                                        rx * f1[0] + ry * f1[1] + rz * f1[2]);
                                };
                                const aA = shareBot.map((w) => angOf(w, cB));
                                const aB = sec4.map((w) => angOf(w, c4));
                                const A4 = shareBot.map((_, i2) => i2)
                                    .sort((x, y) => aA[x] - aA[y]);
                                const TAU = Math.PI * 2;
                                const a0 = aA[A4[0]];
                                const nrm2 = (x) => {
                                    let y = (x - a0) % TAU;
                                    if (y < 0) y += TAU;
                                    return y;
                                };
                                const B4 = sec4.map((_, i2) => i2)
                                    .sort((x, y) => nrm2(aB[x]) - nrm2(aB[y]));
                                const na = A4.length; const nb = B4.length;
                                let i3 = 0; let j3 = 0;
                                const tris = [];
                                while (i3 < na || j3 < nb) {
                                    const ai = A4[i3 % na]; const bj = B4[j3 % nb];
                                    const an = A4[(i3 + 1) % na];
                                    const bn = B4[(j3 + 1) % nb];
                                    const da = (i3 < na) ? nrm2(aA[an]) : Infinity;
                                    const db = (j3 < nb) ? nrm2(aB[bn]) : Infinity;
                                    if (i3 < na && (j3 >= nb || da <= db)) {
                                        tris.push([shareBot[ai], sec4[bj], shareBot[an]]);
                                        i3++;
                                    } else {
                                        tris.push([sec4[bj], sec4[bn], shareBot[ai]]);
                                        j3++;
                                    }
                                }
                                for (const tri of tris) {
                                    const e1t = [tri[1][0] - tri[0][0], tri[1][1] - tri[0][1],
                                        tri[1][2] - tri[0][2]];
                                    const e2t = [tri[2][0] - tri[0][0], tri[2][1] - tri[0][1],
                                        tri[2][2] - tri[0][2]];
                                    let nx4 = e1t[1] * e2t[2] - e1t[2] * e2t[1];
                                    let ny4 = e1t[2] * e2t[0] - e1t[0] * e2t[2];
                                    let nz4 = e1t[0] * e2t[1] - e1t[1] * e2t[0];
                                    const nl4 = Math.hypot(nx4, ny4, nz4);
                                    if (nl4 < 1e-12) continue;
                                    nx4 /= nl4; ny4 /= nl4; nz4 /= nl4;
                                    // outward = away from the leg's own axis
                                    const tc = cen(tri);
                                    let rx = tc[0] - pA.x; let ry = tc[1] - pA.y;
                                    let rz = tc[2] - pA.z;
                                    const rd = rx * d4[0] + ry * d4[1] + rz * d4[2];
                                    rx -= d4[0] * rd; ry -= d4[1] * rd; rz -= d4[2] * rd;
                                    if (nx4 * rx + ny4 * ry + nz4 * rz < 0) {
                                        nx4 = -nx4; ny4 = -ny4; nz4 = -nz4;
                                    }
                                    emitEnd(tri, [nx4, ny4, nz4]);
                                }
                                collared = true;
                            }
                        }
                    }
                }
                // at zero thickness the two share polygons are the same points
                emitEnd(shareTop, ax);
                if (!stickIsFlat && !collared) {
                    emitEnd(shareBot.slice().reverse(), [-ax[0], -ax[1], -ax[2]]);
                }
            }

            // A LINEAR RUN IS MERGED, THE WAY A LOOP IS. A chain of atoms each
            // carrying exactly two sticks - a propionate, a vinyl - is one path,
            // and mitring it bond by bond is what wrings it. An exact mitre of
            // SQUARE sections only closes when a section axis is perpendicular
            // to both legs, so each bend pins the roll to its own local plane;
            // along a zig-zag those planes swing, and the box twists to follow.
            // Measured on a heme: 5 bonds twisting 25 to 66 degrees, every one
            // of them touching a two-stick atom.
            //
            // So the run stops being mitred and starts being SWEPT. One section
            // is built per station, perpendicular to the bisector of the two
            // bonds there, and the SAME polygon is handed to both of them: they
            // share a face by construction, which needs no alignment at all and
            // frees the roll. The roll is then carried along by minimal
            // rotation, and whatever residual the far end's junction demands is
            // spread evenly over the run rather than dumped into one bond.
            // Worst twist per bond drops from 40 degrees to 12.
            {
                const legsOf = (a) => (inc.get(a) || []).filter(
                    (b) => !b.flat && b.fr);
                // THE PATH THROUGH A THREE-WAY ATOM IS A TOPOLOGICAL QUESTION,
                // not a geometric one. A ring carbon carrying a substituent is
                // trigonal: its three angles come out around 127/124/106, a
                // spread of twenty degrees, so there is no "straight through"
                // pair to pick out by angle - measured on a haem, the widest
                // pair at C2A is a ring bond paired with the PROPIONATE arm,
                // and at NA it is a ring bond paired with the bond to the IRON.
                // Both read as the branch being smoothed into the ring.
                //
                // What distinguishes the ring path is that its two legs lie on
                // a common cycle, and on the SMALLEST one: at NA every pair
                // lies on some cycle, because the macrocycle joins everything,
                // and only ring size separates the five-membered pyrrole from
                // the way round through the iron. So for each pair of legs,
                // measure the shortest way back from one neighbour to the other
                // WITHOUT passing through this atom - that plus one is the
                // smallest ring through both - and take the pair with the
                // smallest, when it is a strict winner.
                //
                // Only where the mitre did not already solve the junction: a
                // mitred one is exact and its legs already share their corners,
                // so there is nothing to gain. And only for exactly three legs
                // - with four the choice is genuinely ambiguous (an iron has
                // two trans pairs, and no run can fork to take both).
                const throughPair = new Map();
                for (const [atom, arr] of inc) {
                    const legs = arr.filter((b) => !b.flat && b.fr);
                    if (legs.length < 3 || mitredAtoms.has(atom)) continue;
                    const far = (bd) => (bd.a === atom ? bd.b : bd.a);
                    // shortest path between two neighbours with `atom` removed
                    const hop = (from, to) => {
                        const seen = new Set([atom, from]);
                        let front = [from];
                        for (let d = 1; d <= 12 && front.length; d++) {
                            const next = [];
                            for (const v of front) {
                                for (const nb of legsOf(v)) {
                                    const w = (nb.a === v) ? nb.b : nb.a;
                                    if (w === to) return d;
                                    if (seen.has(w)) continue;
                                    seen.add(w); next.push(w);
                                }
                            }
                            front = next;
                        }
                        return Infinity;
                    };
                    let best = Infinity; let bestPair = null; let ties = 0;
                    for (let i = 0; i < 3; i++) {
                        for (let j = i + 1; j < 3; j++) {
                            const d = hop(far(legs[i]), far(legs[j]));
                            if (d < best) { best = d; bestPair = [legs[i], legs[j]]; ties = 1; }
                            else if (d === best) ties++;
                        }
                    }
                    if (bestPair && best < Infinity && ties === 1) {
                        throughPair.set(atom, bestPair);
                        continue;
                    }
                    // NO CYCLE HERE: THE PATH IS THE TWO LEGS CARRYING MOST.
                    // An acyclic branch point has no ring to appeal to, but it
                    // is still a chain with something hanging off it, and what
                    // separates them is how much structure each leg leads to.
                    // Rank every leg by the size of what lies beyond it and take
                    // the two largest: on a phosphate that picks the two oxygens
                    // continuing the backbone over the two loose ones, and on an
                    // ILE it picks CG1 - which carries CD1 - over the bare CG2.
                    //
                    // EVERY leg is ranked, not only the ones leading onward. A
                    // terminal methyl is still a bond that should flow out of
                    // the chain rather than sit against it, and on a trimmed
                    // side chain there may be only one leg leading anywhere at
                    // all: ILE, LEU, VAL and THR all have sp3 branch points with
                    // one onward leg or none, and asking for two left them as
                    // loose boxes. Ties are broken by the lower atom index -
                    // a symmetric centre has no better answer, and any answer
                    // beats none as long as it is the same one every frame.
                    const reach = (bd) => {
                        const start = (bd.a === atom) ? bd.b : bd.a;
                        const seen = new Set([atom, start]);
                        const st = [start];
                        while (st.length) {
                            for (const nb of legsOf(st.pop())) {
                                const w = (nb.a === atom || nb.b === atom) ? null
                                    : ((seen.has(nb.a)) ? nb.b : nb.a);
                                if (w === null || seen.has(w)) continue;
                                seen.add(w); st.push(w);
                            }
                        }
                        return seen.size - 1;            // not counting `atom`
                    };
                    const sized = legs.map((bd) => ({ bd, n: reach(bd),
                        i: (bd.a === atom) ? bd.b : bd.a }))
                        .sort((x, y) => (y.n - x.n) || (x.i - y.i));
                    throughPair.set(atom, [sized[0].bd, sized[1].bd]);
                }
                const un = (v) => {
                    const m = Math.hypot(v[0], v[1], v[2]);
                    return m > 1e-9 ? [v[0] / m, v[1] / m, v[2] / m] : null;
                };
                const crs = (p, q) => [p[1] * q[2] - p[2] * q[1],
                    p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
                const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
                const rej = (v, t) => {           // the part of v across t
                    const d = dot(v, t);
                    return un([v[0] - t[0] * d, v[1] - t[1] * d, v[2] - t[2] * d]);
                };
                const rot = (v, ax, ang) => {     // Rodrigues, about a unit axis
                    const c = Math.cos(ang); const s = Math.sin(ang);
                    const k = crs(ax, v); const d = dot(ax, v) * (1 - c);
                    return [v[0] * c + k[0] * s + ax[0] * d,
                        v[1] * c + k[1] * s + ax[1] * d,
                        v[2] * c + k[2] * s + ax[2] * d];
                };
                const pos = (a) => at(a) || rotated[a];
                const runSeen = new Set();
                for (const seed of bondList) {
                    if (seed.flat || !seed.fr || runSeen.has(seed)) continue;
                    // grow the path both ways through two-stick atoms
                    const bonds = [seed];
                    const atoms = [seed.a, seed.b];
                    runSeen.add(seed);
                    let closed = false;
                    for (const dirn of [1, 0]) {
                        for (;;) {
                            const end = dirn ? atoms[atoms.length - 1] : atoms[0];
                            const here = dirn ? bonds[bonds.length - 1] : bonds[0];
                            const L = legsOf(end);
                            // two legs: the only way on is the other one.
                            // three, with a ring path through them: carry on
                            // along the ring and leave the branch to overlap.
                            let nb = null;
                            if (L.length === 2) {
                                nb = (L[0] === here) ? L[1] : L[0];
                            } else {
                                const pair = throughPair.get(end);
                                if (!pair) break;
                                if (pair[0] === here) nb = pair[1];
                                else if (pair[1] === here) nb = pair[0];
                                else break;         // we arrived on the branch
                            }
                            if (!nb || nb.flat || !nb.fr) break;
                            const nxt = (nb.a === end) ? nb.b : nb.a;
                            if (runSeen.has(nb)) {
                                // came back round: a ring of two-stick atoms
                                if (nb === bonds[0] || nb === bonds[bonds.length - 1]) {
                                    closed = true;
                                }
                                break;
                            }
                            runSeen.add(nb);
                            if (dirn) { bonds.push(nb); atoms.push(nxt); }
                            else { bonds.unshift(nb); atoms.unshift(nxt); }
                            if (nxt === (dirn ? atoms[0] : atoms[atoms.length - 1])) {
                                closed = true; break;
                            }
                        }
                    }
                    if (bonds.length < 2) continue;   // no interior station
                    // COMING BACK TO THE START IS NOT THE SAME AS CLOSING ON IT.
                    // A ring hanging off a junction - an imidazole on its CG, a
                    // phenyl on its CG - is walked out of that atom, round, and
                    // back to it, so the walk returns to where it began. But the
                    // atom is a JUNCTION, already solved by the mitre, and
                    // treating the run as closed makes the sweep join there too:
                    // it overwrote the mitre's cut on the two ring legs and left
                    // the third carrying the mitre's, so one junction was built
                    // by two constructions that disagree. It is only closed if
                    // the atom it closes on is a station the sweep may own.
                    if (closed && !(legsOf(atoms[0]).length === 2
                        || throughPair.has(atoms[0]))) {
                        closed = false;
                    }
                    const nB = bonds.length;
                    const P = atoms.map(pos);
                    if (P.some((p) => !p)) continue;
                    const T = [];
                    for (let i = 0; i < nB; i++) {
                        const t = un([P[i + 1].x - P[i].x, P[i + 1].y - P[i].y,
                            P[i + 1].z - P[i].z]);
                        if (!t) { T.length = 0; break; }
                        T.push(t);
                    }
                    if (T.length !== nB) continue;
                    // the roll this run starts from: whatever the junction at
                    // its first atom already fixed, else the bond's own rule
                    const endRoll = (bd, atom) => ((bd.a === atom)
                        ? bd.roll0 : bd.roll1) || null;
                    const u0 = rej(endRoll(bonds[0], atoms[0]) || bonds[0].fr.u, T[0]);
                    if (!u0) continue;
                    // carry it along by minimal rotation, station by station
                    const U = [u0];
                    for (let i = 1; i < nB; i++) {
                        const ax = un(crs(T[i - 1], T[i]));
                        let u = U[i - 1];
                        if (ax) {
                            const c = Math.max(-1, Math.min(1, dot(T[i - 1], T[i])));
                            u = rot(u, ax, Math.acos(c));
                        }
                        const r = rej(u, T[i]);
                        if (!r) { U.length = 0; break; }
                        U.push(r);
                    }
                    if (U.length !== nB) continue;
                    // ...and spread the far junction's demand over the whole run
                    const uEndPin = closed ? null
                        : endRoll(bonds[nB - 1], atoms[nB]);
                    if (uEndPin) {
                        const w = rej(uEndPin, T[nB - 1]);
                        if (w) {
                            const vN = crs(T[nB - 1], U[nB - 1]);
                            let a = Math.atan2(dot(vN, w),
                                Math.max(-1, Math.min(1, dot(U[nB - 1], w))));
                            // A QUARTER TURN IS NOT NOTHING. The square's
                            // OUTLINE repeats every 90 degrees, but its four
                            // faces do not - they carry different normals, so a
                            // section turned a quarter of the way round is lit
                            // differently all along the bond, and reads as a
                            // twist however little the silhouette moved.
                            // Folding the residual to 45 degrees therefore
                            // threw away up to a quarter turn per run and left
                            // it in the geometry: across 53 real ligands the
                            // worst bond twisted 94 degrees, every one of the
                            // worst ten running from a merged seam to a mitred
                            // junction. Only the HALF turn is free, because a
                            // mitred end needs its section on the junction's
                            // plane and either way round satisfies that.
                            while (a > Math.PI / 2) a -= Math.PI;
                            while (a < -Math.PI / 2) a += Math.PI;
                            // A FREE START IS NOT A CONSTRAINT, SO TURN THE
                            // WHOLE RUN. Only a junction pins a roll; at an open
                            // end the section may sit any way round, and the
                            // value the roll rule produced there is arbitrary.
                            // So when a run starts free there is nothing to
                            // spread the residual BETWEEN - rotating every
                            // station by the same amount lands the far end on
                            // its pin and leaves no twist anywhere. Relative
                            // twist is untouched, since each station turns by
                            // the same angle about its own tangent.
                            //
                            // This is what a side chain is: HIS runs CA-CB-CG,
                            // free at CA and pinned at the imidazole, and
                            // sharing the residual out gave 39 degrees on one
                            // bond and 51 on the other where none was needed.
                            //
                            // SPREAD OVER THE BONDS when BOTH ends are pinned
                            // and the residual has to go somewhere. There are
                            // nB bonds and nB - 1 interior stations, and it is
                            // the BONDS that carry it: station i takes i/nB, so
                            // every bond turns the same a/nB, the last one
                            // included. Dividing by nB - 1 instead brought the
                            // last station all the way onto the pin, leaving
                            // the final bond flat and cramming the residual into
                            // the ones before it - on a two-bond run, all of it
                            // into the first. The closed-run case divides by nB.
                            if (!endRoll(bonds[0], atoms[0])) {
                                for (let i = 0; i < nB; i++) {
                                    U[i] = rej(rot(U[i], T[i], a), T[i]) || U[i];
                                }
                            } else {
                                for (let i = 1; i < nB; i++) {
                                    U[i] = rej(rot(U[i], T[i], a * i / nB), T[i])
                                        || U[i];
                                }
                            }
                        }
                    }
                    // A CLOSED RUN HAS TO CLOSE. Carrying the frame round a ring
                    // and back lands it somewhere near - but not on - where it
                    // started, and that leftover has to be spread around the
                    // loop rather than dumped at the seam.
                    if (closed) {
                        const ax = un(crs(T[nB - 1], T[0]));
                        let uBack = U[nB - 1];
                        if (ax) {
                            const c = Math.max(-1, Math.min(1, dot(T[nB - 1], T[0])));
                            uBack = rot(uBack, ax, Math.acos(c));
                        }
                        const w = rej(uBack, T[0]);
                        if (w) {
                            const vN = crs(T[0], U[0]);
                            let a = Math.atan2(dot(vN, w),
                                Math.max(-1, Math.min(1, dot(U[0], w))));
                            while (a > Math.PI / 2) a -= Math.PI;   // half turns only
                            while (a < -Math.PI / 2) a += Math.PI;
                            for (let i = 1; i < nB; i++) {
                                U[i] = rej(rot(U[i], T[i], a * i / nB), T[i]) || U[i];
                            }
                        }
                    }
                    // One shared section per station, square in the plane that
                    // bisects the two bonds meeting there. A closed run also
                    // joins at the seam it was grown from - the walk leaves the
                    // start atom at BOTH ends of the path, so stopping at nB - 1
                    // leaves exactly one vertex of a ring unjoined, which shows
                    // as a wedge of daylight at one corner of a benzene.
                    const stations = [];
                    for (let i = 1; i < nB; i++) {
                        stations.push({ i, at: atoms[i], p: P[i],
                            tIn: T[i - 1], tOut: T[i], L: bonds[i - 1], R: bonds[i],
                            pPrev: P[i - 1], pNext: P[i + 1], u: U[i] });
                    }
                    if (closed) {
                        stations.push({ i: 0, at: atoms[0], p: P[0],
                            tIn: T[nB - 1], tOut: T[0],
                            L: bonds[nB - 1], R: bonds[0],
                            pPrev: P[nB - 1], pNext: P[1], u: U[0] });
                    }
                    for (const st of stations) {
                        const b = un([st.tIn[0] + st.tOut[0], st.tIn[1] + st.tOut[1],
                            st.tIn[2] + st.tOut[2]]);
                        if (!b) continue;
                        // the oblique cut reaches h*tan(theta/2) along each
                        // bond, and must not eat the bond it is cutting
                        const c = Math.max(-1, Math.min(1, dot(st.tIn, st.tOut)));
                        const half = Math.acos(c) / 2;
                        const reach = Math.max(stickHW, stickHT) * Math.tan(half);
                        const lenL = Math.hypot(st.p.x - st.pPrev.x,
                            st.p.y - st.pPrev.y, st.p.z - st.pPrev.z);
                        const lenR = Math.hypot(st.pNext.x - st.p.x,
                            st.pNext.y - st.p.y, st.pNext.z - st.p.z);
                        if (reach > 0.30 * Math.min(lenL, lenR)) continue;
                        const uS = rej(st.u, b);
                        if (!uS) continue;
                        // ONE POLYGON, TRAVERSED TWO WAYS. The section is built
                        // once, in the plane bisecting the two bonds, so both
                        // boxes end on the very same four points and the seam
                        // is a shared face rather than two faces that have to
                        // agree. Taking v from each bond's own tangent instead
                        // would rotate one quad against the other by the bend
                        // angle - measured 0.32 A of daylight at the join.
                        //
                        // What does differ per bond is the ORDER. A bond is
                        // stored with whatever endpoints it came with, so its
                        // tangent may run into this station rather than out of
                        // it, which reverses the corner cycle; walking it the
                        // wrong way turns the box inside out and culls every
                        // face. Reversing v maps the cycle (+u+v, +u-v, -u-v,
                        // -u+v) onto indices 1, 0, 3, 2 of the forward one.
                        const vS = un(crs(b, uS));
                        if (!vS) continue;
                        const Q = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(
                            ([su, sv]) => [
                                st.p.x + uS[0] * su * stickHT + vS[0] * sv * stickHW,
                                st.p.y + uS[1] * su * stickHT + vS[1] * sv * stickHW,
                                st.p.z + uS[2] * su * stickHT + vS[2] * sv * stickHW]);
                        const QR = [Q[1], Q[0], Q[3], Q[2]];
                        const L = st.L; const R = st.R;
                        const qL = dot(L.fr.t, b) > 0 ? Q : QR;
                        const qR = dot(R.fr.t, b) > 0 ? Q : QR;
                        // flagged as a SEAM: both boxes hold this polygon, so it
                        // is inside the solid and neither may paint it
                        if (L.a === st.at) { L.cut0 = qL; L.roll0 = uS; L.seam0 = true; }
                        else { L.cut1 = qL; L.roll1 = uS; L.seam1 = true; }
                        if (R.a === st.at) { R.cut0 = qR; R.roll0 = uS; R.seam0 = true; }
                        else { R.cut1 = qR; R.roll1 = uS; R.seam1 = true; }
                    }
                    // a free end keeps a square section on the carried frame
                    if (!closed) {
                        for (const [bd, atom, u] of [[bonds[0], atoms[0], U[0]],
                            [bonds[nB - 1], atoms[nB], U[nB - 1]]]) {
                            if (endRoll(bd, atom)) continue;
                            if (bd.a === atom) bd.roll0 = u; else bd.roll1 = u;
                        }
                    }
                }
            }

            for (const bd of bondList) {
                if (used.has(bd)) continue;
                used.add(bd);
                // A real bond is a box. Contacts are not - they are an
                // annotation drawn over the structure, and they keep the flat
                // bright stroke the 'line' path gives them.
                if (!bd.flat && stickBox(bd)) continue;
                // A CONTACT IS CUT INTO PIECES, for the same reason a base
                // plate is: "as one quad a rung carries a single sort key
                // across ~7 A, so it cannot order correctly against everything
                // it overlaps". A contact reaches further than any rung - it
                // joins two residues anywhere in the structure - and as one
                // prim it sorts as though it were all at its midpoint, so it
                // passes in front of what it should go behind and behind what
                // it should cross in front of, along its whole length.
                //
                // Stations are interpolated in 3D and projected one by one, not
                // interpolated on screen: under perspective those are different
                // curves, and it is the DEPTH of each piece that this is for.
                //
                // Cartoon only - this file is the cartoon. The tube path draws
                // its contacts as one stroke and stays that way.
                if (bd.flat && bd.va && bd.vb) {
                    const dxc = bd.vb.x - bd.va.x;
                    const dyc = bd.vb.y - bd.va.y;
                    const dzc = bd.vb.z - bd.va.z;
                    const lenC = Math.hypot(dxc, dyc, dzc);
                    const nC = Math.max(1, Math.min(CONTACT_SEG_MAX,
                        Math.ceil(lenC / CONTACT_SEG_A)));
                    if (nC > 1) {
                        const proj = [];
                        for (let k = 0; k <= nC; k++) {
                            const u = k / nC;
                            const q = project(bd.va.x + dxc * u, bd.va.y + dyc * u,
                                bd.va.z + dzc * u);
                            if (!q) { proj.length = 0; break; }
                            // the same near-surface bias the whole contact
                            // carries, in the same depth channel - see zBias
                            q[2] += bd.zBias || 0;
                            proj.push(q);
                        }
                        if (proj.length === nC + 1) {
                            for (let k = 0; k < nC; k++) {
                                const p1 = proj[k]; const p2 = proj[k + 1];
                                const piece = {
                                    kind: 'line',
                                    pts: [p1, p2],
                                    x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
                                    z: (p1[2] + p2[2]) / 2,
                                    w: bd.w, wA: bd.wA, c: bd.c, flat: true,
                                    // THE DEPTH BIAS, so a consumer that reads
                                    // POSITION out of the depth channel can take
                                    // it back off - see the note where it is
                                    // applied. The 2D pass only sorts on that
                                    // channel, so moving it does not move the
                                    // drawn line; the WebGL2 path unprojects
                                    // from it, and a biased z plants the whole
                                    // contact half an Angstrom toward the eye in
                                    // MODEL space, where it then swings around
                                    // with the structure as the view turns.
                                    zBias: bd.zBias || 0,
                                    pA: p1, pB: p2,
                                    sel: bd.sel,
                                    // POSITIONAL: the ink pass reads joints[0]
                                    // for the START point and joints[1] for the
                                    // END. Registering only the outer ends left
                                    // the last piece with its outer key in slot
                                    // 0, so it capped at its START - an internal
                                    // cut, showing as a dark tick across the
                                    // contact at some angles.
                                    //
                                    // The two real ends cap; the internal cuts
                                    // get NOTHING. A cap fills the gap an angled
                                    // joint leaves, and a contact is a straight
                                    // line - there is no gap to fill, so a cap
                                    // there is only something extra to see.
                                    joints: [
                                        k === 0 ? `R${bd.a}` : null,
                                        k === nC - 1 ? `R${bd.b}` : null,
                                    ],
                                    gs0: Math.min(bd.a, bd.b),
                                };
                                prims.push(piece);
                            }
                            continue;
                        }
                    }
                }
                // grow backwards from a, then forwards from b
                const back = [bd.A];
                const backIdx = [bd.a];
                const endA = walk(bd, bd.b, back, backIdx);
                const fwd = [bd.B];
                const fwdIdx = [bd.b];
                const endB = walk(bd, bd.a, fwd, fwdIdx);
                back.reverse(); backIdx.reverse();
                const pts = back.concat(fwd);
                const idxs = backIdx.concat(fwdIdx);
                let zSum = 0;
                for (const q of pts) zSum += q[2];
                const prim = {
                    kind: 'line',
                    pts,
                    x1: pts[0][0], y1: pts[0][1],
                    x2: pts[pts.length - 1][0], y2: pts[pts.length - 1][1],
                    z: zSum / pts.length,
                    w: bd.w, wA: bd.wA,
                    // see the note on the other line emitter: a consumer that
                    // reads position out of the depth channel needs this back
                    zBias: bd.zBias || 0,
                    c: bd.c,
                    flat: bd.flat,
                    pA: pts[0], pB: pts[pts.length - 1],
                    sel: bd.sel,
                    gs0: Math.min.apply(null, idxs),
                };
                registerJoint(`R${endA}`, prim);
                registerJoint(`R${endB}`, prim);
                prims.push(prim);
            }

        }

        // --- depth range for shading ---
        let zMin = Infinity;
        let zMax = -Infinity;
        for (const g of prims) {
            if (g.z < zMin) zMin = g.z;
            if (g.z > zMax) zMax = g.z;
        }
        const zSpan = zMax - zMin;
        const nearOf = (z) => (zSpan > 1e-6 ? (z - zMin) / zSpan : 0.75);

        const strokePath = (pts) => {
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
            ctx.stroke();
        };

        if (renderer._dumpCand) {
            renderer._candDump = inkCurves.map((cv) => ({
                vis: cv.vis.map((v) => (v ? 1 : 0)).join(''),
                pts: cv.pts.map((q) => [+q[0].toFixed(1), +q[1].toFixed(1), +q[2].toFixed(2)]),
            }));
        }
        // FAST ink: the painter approximation - candidates as depth-sorted
        // overlapping chunks biased UP one slab thickness. Skips the entire
        // occlusion grid, which is what makes fast mode actually fast; the
        // known artifact (user-accepted for interaction) is dotted ink along
        // inner edges at near-ties. The perfect pass replaces the frame the
        // moment the gesture ends.
        if (!perfectInk && outlineW) {
            const bias = 0.3 * widthScale;
            for (const cv of inkCurves) {
                const pts = cv.pts;
                const vis = cv.vis;
                let run = null;
                const flushRun = () => {
                    if (run && run.length > 1) {
                        for (let a = 0; a + 1 < run.length; a += 1) {
                            const cp = run.slice(a, Math.min(run.length, a + 3));
                            if (cp.length < 2) break;
                            let zq = -Infinity;
                            for (const pq of cp) {
                                if (pq[2] > zq) zq = pq[2];
                            }
                            // cv.c, not col: `col` belongs to the per-interval
                            // loop far above and is out of scope here, so this
                            // threw "col is not defined" the moment the fast ink
                            // path ran. It stayed latent for a long time because
                            // nothing selected that path automatically; it is
                            // reachable now only via renderer._quality='fast'.
                            prims.push({ kind: 'ribStroke', pts: cp, z: zq + bias, c: cv.c,
                            gs0: cv.gs0 });
                            if (a + 3 >= run.length) break;
                        }
                    }
                    run = null;
                };
                for (let s = 0; s < vis.length; s++) {
                    if (vis[s]) {
                        if (!run) run = [pts[s]];
                        run.push(pts[s + 1]);
                    } else {
                        flushRun();
                    }
                }
                flushRun();
            }
        }

        // ---- BASE PLATES -------------------------------------------------
        // Built per PAIR, in one frame shared by both halves, so the two bases
        // of a pair are exactly coplanar and collinear - independent
        // per-residue frames left them at visibly different angles, which is
        // what stopped them reading as base pairs.
        //
        // The frame is exact rather than fitted. The MIDPOINT of a pair lies on
        // the helix axis by construction, so consecutive pair midpoints give
        // the local axis direction directly - no smoothing window (which a
        // 12-mer duplex is too short to fill anyway) and no fitted constants.
        // The base-pair plane is perpendicular to that axis.
        const rbfP = baseFramesRot;
        // WHICH RESIDUES SHOW A BASE. `cartoonBasePlates` is still the master
        // switch (the Python `base_plates` option); on top of it, a selection
        // can name the nucleotides whose plates are drawn, the way it names the
        // residues whose side chains are.
        //
        // NULL MEANS ALL, which is the opposite of how side chains read it and
        // is deliberate: a duplex has always been drawn with its rungs, so an
        // object nobody has touched has to keep them. An EMPTY set means none -
        // that is what selecting everything and hiding it gives you, and it has
        // to be distinguishable from "never asked".
        // ...and per OBJECT: several can be on screen at once, each with its
        // own set in its own numbering (see mergedObjectSet in viewer-mol.js).
        const baseSet = renderer.mergedObjectSet
            ? renderer.mergedObjectSet('bases')
            : (renderer.currentObjectName
                && (renderer.objectsData || {})[renderer.currentObjectName]
                && (renderer.objectsData[renderer.currentObjectName].bases instanceof Set)
                ? renderer.objectsData[renderer.currentObjectName].bases : null);
        const baseShown = (res) => !baseSet || baseSet.has(res);
        if (renderer.cartoonBasePlates !== false) {
            const mid = (i) => {
                // bounds first: pairOf[-1] is undefined, and `undefined < 0` is
                // false, so an unguarded index walks off the ends of rotated[]
                if (i < 0 || i >= n) return null;
                const j = pairOf[i];
                if (j < 0 || j >= n) return null;
                // the SMOOTHED rails, like everything else the plate is built
                // from: this midpoint is what the whole helix axis is fitted
                // through, and an axis fitted to the raw trace tilts every
                // plate on a ribbon drawn through the smoothed one
                const a = naPos[i], b = naPos[j];
                return [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
            };
            // ---- ONE AXIS PER PAIR, THEN SMOOTHED ALONG THE STEM ----------
            // The axis is what the whole plate hangs off: the pair plane is
            // normal to it, so an axis that is d degrees wrong tilts the plate
            // by d degrees. It is computed for every pair first and smoothed
            // afterwards, because a pair on its own has only local evidence and
            // that evidence is weakest exactly where it matters most - at the
            // END of a helix, where the fitting window runs off the stem into a
            // loop and the predicted base normals stop being helical. Measured
            // against base planes fitted to the real ring atoms of 3A3A:
            // helix-interior pairs 10.0 deg median, helix-end pairs 18.5 deg,
            // and all three worst plates in the structure were end pairs.
            const rawAxis = (i, j) => {
                // local axis from the neighbouring pairs' midpoints
                // HELIX AXIS by least squares through a window of pair
                // midpoints. Two adjacent midpoints are not enough: a pair's
                // midpoint does NOT lie on the axis (the two C4' atoms sit at
                // different heights and angles, so the midpoint traces a small
                // helix around it), and measured on real duplexes the 2-point
                // direction swings 20-29 deg between neighbouring pairs. Fitting
                // a line averages that orbit out. Against the true base-pair
                // plane from the ring atoms: 2-point ~87 deg wrong, fitted ~20.
                const pts = [];
                for (let d = -NA_AXIS_WIN; d <= NA_AXIS_WIN; d++) {
                    const mm = mid(i + d);
                    if (mm) pts.push(mm);
                }
                if (pts.length < 2) return null;
                let cx0 = 0, cy0 = 0, cz0 = 0;
                for (const q of pts) { cx0 += q[0]; cy0 += q[1]; cz0 += q[2]; }
                cx0 /= pts.length; cy0 /= pts.length; cz0 /= pts.length;
                // dominant direction by power iteration on the covariance -
                // cheaper than a full SVD and this matrix is 3x3
                let ax = 0, ay = 0, az = 0;
                {
                    const seed = mid(i + 1) || mid(i - 1) || pts[pts.length - 1];
                    let vx = seed[0] - cx0, vy = seed[1] - cy0, vz = seed[2] - cz0;
                    if (Math.hypot(vx, vy, vz) < 1e-9) { vx = 1; vy = 0; vz = 0; }
                    for (let it = 0; it < 8; it++) {
                        let nx2 = 0, ny2 = 0, nz2 = 0;
                        for (const q of pts) {
                            const dx2 = q[0] - cx0, dy2 = q[1] - cy0, dz2 = q[2] - cz0;
                            const w2 = dx2 * vx + dy2 * vy + dz2 * vz;
                            nx2 += dx2 * w2; ny2 += dy2 * w2; nz2 += dz2 * w2;
                        }
                        const nl2 = Math.hypot(nx2, ny2, nz2);
                        if (nl2 < 1e-12) break;
                        vx = nx2 / nl2; vy = ny2 / nl2; vz = nz2 / nl2;
                    }
                    ax = vx; ay = vy; az = vz;
                }
                if (!Number.isFinite(ax) || Math.hypot(ax, ay, az) < 1e-9) return null;
                // Prefer the base-plane normals where the prediction gave us
                // some: the rung then lies in the plane the bases occupy rather
                // than one inferred from a fitted helix axis (~20 deg off).
                if (rbfP) {
                    const oi = i * 6, oj = j * 6;
                    let px2 = rbfP[oi + 3], py2 = rbfP[oi + 4], pz2 = rbfP[oi + 5];
                    const qx = rbfP[oj + 3], qy = rbfP[oj + 4], qz = rbfP[oj + 5];
                    if (Math.hypot(px2, py2, pz2) > 0.1 && Math.hypot(qx, qy, qz) > 0.1) {
                        // the two normals are ~antiparallel across a pair; align
                        // before averaging or they cancel
                        const s2 = (px2 * qx + py2 * qy + pz2 * qz) < 0 ? -1 : 1;
                        px2 += s2 * qx; py2 += s2 * qy; pz2 += s2 * qz;
                        const pl2 = Math.hypot(px2, py2, pz2);
                        if (pl2 > 1e-6) { ax = px2 / pl2; ay = py2 / pl2; az = pz2 / pl2; }
                    }
                }
                return [ax, ay, az];
            };
            const axRaw = new Map();          // pair leader (lower index) -> axis
            for (let i = 0; i < n; i++) {
                const j = pairOf[i];
                if (j < 0 || j < i) continue;
                if (!vis(i) || !vis(j)) continue;
                const a = rawAxis(i, j);
                if (a) axRaw.set(i, a);
            }
            // Plain average with whichever register neighbours exist - the pair
            // one step along each strand in opposite directions, which is the
            // next pair UP THE SAME STEM. A terminal pair has one neighbour and
            // is pulled halfway toward it; an interior pair has two and barely
            // moves, which is what we want since it was already the reliable
            // case. Weighting the neighbours below 1 recovers less and a second
            // round recovers almost nothing more, so this stays a flat mean over
            // at most three pairs.
            //
            // tests/na_axis.js scores this against the real ring-atom base
            // planes, 98 chains / 4697 pairs:
            //                    median    p90    mean   >30deg
            //   stem ends     18.8->15.6  56->49  25->23  25.8->20.5%
            //   stem interior 12.0->11.3  20->19  13->13   1.3-> 1.7%
            //   all pairs     14.2->13.0  36->32  19->18  13.1->10.8%
            // The ends are where it pays, which is the point. Interior pairs
            // barely move and a few get marginally worse, pulled toward a bad
            // neighbour - worth it for a fifth off the end-pair failures.
            // 3A3A's worst plate, the anticodon stem's closing pair U28-A46,
            // goes 43.9 -> 24.9 deg.
            const axSm = new Map();
            for (const [i, a] of axRaw) {
                const j = pairOf[i];
                let sx = a[0], sy = a[1], sz = a[2];
                for (const d of [-1, 1]) {
                    const c = i + d, e = j - d;
                    if (c < 0 || c >= n || e < 0 || e >= n) continue;
                    if (pairOf[c] !== e) continue;      // not the same stem
                    const b = axRaw.get(c < e ? c : e);
                    if (!b) continue;
                    // an axis has no sign; align before averaging or they cancel
                    const sg = (b[0] * a[0] + b[1] * a[1] + b[2] * a[2]) < 0 ? -1 : 1;
                    sx += sg * b[0]; sy += sg * b[1]; sz += sg * b[2];
                }
                const sl = Math.hypot(sx, sy, sz);
                if (sl > 1e-9) axSm.set(i, [sx / sl, sy / sl, sz / sl]);
            }
            for (let i = 0; i < n; i++) {
                const j = pairOf[i];
                if (j < 0 || j < i) continue;          // emit each pair once
                if (!vis(i) || !vis(j)) continue;
                // A RUNG STARTS AT ITS OWN RAIL. These are the two ends of
                // the pair and everything about the rung is built from them -
                // where it leaves the ribbon, the pair midpoint it runs to,
                // the axis it sits normal to - so reading the RAW trace here
                // while the rails are drawn through the smoothed one starts
                // each rung up to an Angstrom off its ribbon: it begins inside
                // the band and stabs out of the far side, which is what the
                // plates looked like the moment the trace was smoothed.
                const pi = naPos[i], pj = naPos[j];
                let lx = pj.x - pi.x, ly = pj.y - pi.y, lz = pj.z - pi.z;
                const ll = Math.hypot(lx, ly, lz);
                if (ll < 1e-3) continue;
                lx /= ll; ly /= ll; lz /= ll;
                const aSm = axSm.get(i);
                if (!aSm) continue;
                let ax = aSm[0], ay = aSm[1], az = aSm[2];
                // perpendicular component only: the pair plane is normal to the axis
                const ad = ax * lx + ay * ly + az * lz;
                ax -= lx * ad; ay -= ly * ad; az -= lz * ad;
                const al = Math.hypot(ax, ay, az);
                if (al < 1e-4) continue;
                ax /= al; ay /= al; az /= al;
                if (renderer._naDebug) {
                    (renderer._naAxis || (renderer._naAxis = []))
                        .push({ i, j, a: [ax, ay, az] });
                }
                // in-plane width axis
                const wx = ay * lz - az * ly;
                const wy = az * lx - ax * lz;
                const wz = ax * ly - ay * lx;
                const hw = (naPlateWA / 2) * widthScale;
                // Bases are ALWAYS a plane. Thickness here was only ever a
                // stroke dilating from the quad's centre-plane, not real
                // geometry, so the join style became the corner shape and it
                // could not shade a face differently from a rim - it rounded off
                // when round-joined and spiked when mitred. A flat plate has
                // none of that. The Thick control still drives the backbone; the
                // rung just has to clear the slab it leaves, hence ribHalfT.
                // (Plain Angstroms, matching halfT(): halfW() is the one scaled
                // by widthScale, and mixing the two is what broke the clearance
                // before.)
                // the rail this rung leaves, so the two match by construction
                const ribHalfT = (naSlabHalfT !== null) ? naSlabHalfT : naHalfT;
                // HALF THE BACKBONE'S THICKNESS. A base is a thinner thing
                // than the strand it hangs off, but it is not a sheet: drawn
                // perfectly flat it vanished to a hairline whenever the duplex
                // turned edge-on and the rungs read as sticks. Following the
                // backbone means the Thick control drives both, and a preset
                // that asks for a flat ribbon still gets flat rungs.
                //
                // Carried in ANGSTROM and dilated at paint time rather than
                // built as a box: stroking the piece's own outline widens it by
                // exactly this much in every direction, which is what thickness
                // looks like edge-on, and six real faces would cost 6x the fills
                // for a difference only visible at grazing.
                const th = ribHalfT / 2;
                const half = ll / 2;
                // SUBDIVIDED along its length. A pair rung is ~14.6 A end to
                // end, so a half-rung spans a good fraction of the duplex; as a
                // single quad with one mean depth it cannot sort correctly
                // against a backbone ribbon that crosses it, and the plate
                // showed through the ribbon. Splitting it lets each piece sort
                // at its own depth - the same reason the ribbon itself is built
                // from per-station strips. Cross edges are inked only at the
                // real ends (capA/capB) so the cuts leave no internal lines.
                // A base plate is a plain RECTANGLE: constant width from the
                // backbone to the centre of the pair. It used to taper into the
                // backbone, which was meant to hide the joint but read as a
                // hexagon rather than a base. Thickness comes from the same
                // Thick control as the ribbon, so plates and backbone are one
                // material rather than two independently-sized things.
                // Built in the BACKBONE's frame, not the pair's. The plate
                // leaves along the ribbon's face normal and is as wide as the
                // ribbon's own side vector, so its base edge lies exactly on a
                // ribbon face - two boxes sharing a face, with no pitch-angle
                // wedge to bury or taper away. Only valid because the face normal
                // is solved to point at the partner; aimed the old way it would
                // have sent rungs out sideways. Which of the slab's two faces
                // that is depends on the sign the run settled on, so mk picks it
                // geometrically rather than assuming t x s - see faceSign.
                // ---- one half-rung, ONE primitive -------------------------
                // Rewritten. Every artifact this went through - dashed edges,
                // outlines going missing, ink drawn over the backbone - traced
                // back to the rung being SPLIT: either into depth-sorted
                // segments (whose strokes overwrite each other's ink, because
                // they paint in depth order rather than in sequence) or into a
                // fill plus a separate outline prim (which anything drawn
                // between them could erase). One primitive has no seam to show
                // and nothing can be inserted inside it, so ink, thickness and
                // fill are guaranteed to stay together.
                //
                // Splitting was only ever there for depth sorting, and it is not
                // needed: a rung runs from its own ribbon's FACE to the centre of
                // the pair, so it never crosses either backbone it connects.
                //
                // Shape is a trapezoid: at the joint it matches the ribbon's own
                // half-width and side vector, so the two line up exactly; by the
                // centre it has become the plate width on the shared pair axis,
                // so the two halves meet. The ~16 deg the helix pitch puts
                // between those frames is spread along the rung instead of
                // landing at either end.
                // `res` is WHOSE HALF THIS IS. Both halves of a pair are built
                // inside the same i/j loop, so using `i` for both made the two
                // indistinguishable downstream: selecting one residue lit the
                // whole rung, right across to its partner's backbone.
                // `slot` is WHICH COLOUR THIS RUNG TOOK - the same index into
                // `colors` its backbone residue took. Without it the GPU port
                // has to bake the colour into the mesh, and a mesh with one
                // baked face in it cannot be repainted from a new palette at
                // all: every colour change on any structure with a base pair
                // in it rebuilt the whole thing. Measured on 4UG0, 21,744 of
                // 167,824 faces were rungs, and a colour change cost 950 ms
                // against 30 ms for the upload it should have been.
                const mk = (base, fr, col, res, slot) => {
                    const n0x = fr.t[1] * fr.s[2] - fr.t[2] * fr.s[1];
                    const n0y = fr.t[2] * fr.s[0] - fr.t[0] * fr.s[2];
                    const n0z = fr.t[0] * fr.s[1] - fr.t[1] * fr.s[0];
                    const n0l = Math.hypot(n0x, n0y, n0z) || 1;
                    // The face sign is not a property of the strand order.
                    // Choose the slab face geometrically: a rung must leave
                    // through the face that points toward the pair midpoint.
                    // A fixed t x s sign selects the outer face on one strand
                    // whenever the two antiparallel frames have opposite roll.
                    const towardX = midP.x - base.x;
                    const towardY = midP.y - base.y;
                    const towardZ = midP.z - base.z;
                    const faceSign = (n0x * towardX + n0y * towardY + n0z * towardZ) >= 0 ? 1 : -1;
                    const faceX = faceSign * n0x / n0l;
                    const faceY = faceSign * n0y / n0l;
                    const faceZ = faceSign * n0z / n0l;
                    // near edge: clear of the ribbon's face. Normally that is
                    // just the slab's half-thickness, but at thickness 0 the slab
                    // IS a plane and the rung would start exactly on it -
                    // coplanar, so which of the two wins at the joint is
                    // arbitrary and the rung's ink bled through the backbone.
                    // A floor of NA_JOINT_CLEAR keeps them separable in depth.
                    const off = Math.max(ribHalfT, NA_JOINT_CLEAR);
                    const ncx = base.x + faceX * off;
                    const ncy = base.y + faceY * off;
                    const ncz = base.z + faceZ * off;
                    const nearHW = naWidthA * widthScale;
                    // far edge: the SHARED pair axis, taken with the same sign
                    // for both halves. Flipping it per half - to agree with that
                    // half's own side vector - let the two halves end up with
                    // opposite far edges, so their corners crossed and the quads
                    // did not line up at the centre. The near edge is symmetric
                    // about the rung, so flipping THAT instead costs nothing.
                    const vx2 = wx, vy2 = wy, vz2 = wz;
                    let ux = fr.s[0], uy = fr.s[1], uz = fr.s[2];
                    if (ux * vx2 + uy * vy2 + uz * vz2 < 0) { ux = -ux; uy = -uy; uz = -uz; }
                    if (renderer._naDebug) {
                        // the rung's TWIST is exactly the angle its width axis
                        // turns through, joint to centre
                        const c = Math.max(-1, Math.min(1,
                            ux * vx2 + uy * vy2 + uz * vz2));
                        (renderer._naTwist || (renderer._naTwist = []))
                            .push(Math.acos(c) * 180 / Math.PI);
                    }
                    // SUBDIVIDED, for DEPTH. As one quad a rung carries a single
                    // sort key across ~7 A, so it cannot order correctly against
                    // everything it overlaps and rungs crossed each other wrongly.
                    // Pieces sort individually. (It also tracks the ~50 deg twist
                    // instead of flattening it.)
                    // The seams this used to leave are handled where the pieces
                    // are drawn - see the hairline stroke in the plate branch.
                    // A RUNG IS A SLAB, SO IT IS BUILT AS ONE. It used to be a
                    // flat quad with its thickness faked at paint time by
                    // dilating the outline, which cannot be right in principle:
                    // a stroke grows a shape in every direction, and a slab has
                    // thickness in exactly one. That showed as the rung spilling
                    // past the backbone at its joint and as its long edge
                    // breaking into dashes where the pieces met.
                    //
                    // Now it produces the same four corner curves the ribbon
                    // does and goes through the same painter and the same
                    // silhouette (emitSlabInk), which is what the ligand boxes
                    // taught: build the solid and let the existing machinery
                    // draw it, rather than faking the look of one.
                    //
                    // Its geometry is SIMPLER than a ribbon interval's - the
                    // centre line is straight, so there is no curve to evaluate
                    // and the concavity term oK is 0 throughout.
                    const nseg = subFloor(NA_PLATE_SEG);
                    const Lp = []; const Lm = []; const Rp = []; const Rm = [];
                    const oN = []; const oB = []; const oT = []; const oK = [];
                    const oLb = []; const oLn = []; const oLt = [];
                    // the rung runs straight from the backbone face to the pair
                    // centre, so its tangent is constant
                    let ttx = midP.x - ncx; let tty = midP.y - ncy;
                    let ttz = midP.z - ncz;
                    const ttm = Math.hypot(ttx, tty, ttz) || 1;
                    ttx /= ttm; tty /= ttm; ttz /= ttm;
                    let zSum = 0; let okRung = true;
                    for (let k = 0; k <= nseg && okRung; k++) {
                        const u = k / nseg;
                        const cx2 = ncx + (midP.x - ncx) * u;
                        const cy2 = ncy + (midP.y - ncy) * u;
                        const cz2 = ncz + (midP.z - ncz) * u;
                        // Width axis turns from the backbone's own side vector
                        // to the shared pair axis. BOTH ENDS ARE FIXED: the side
                        // vector is what makes the base edge line up with the
                        // ribbon's own cross-section rather than merely lie in
                        // its plane (projecting the pair axis into that plane
                        // keeps it flush but turns it WITHIN the face, which
                        // misaligns the joint), and the pair axis is what makes
                        // the two halves meet.
                        //
                        // What is free is the RATE. The two strands' side
                        // vectors genuinely differ - the rails wind at ~59 deg
                        // to the helix axis, so neither their tangents nor
                        // their sides are antiparallel - and the turn each half
                        // makes on its way in is 46 deg at the median. Blending
                        // linearly is still most of the way through that
                        // halfway along, so the two halves of a pair meet the
                        // eye visibly rotated against each other. Easing puts
                        // the turn where the rung is buried against the
                        // backbone and leaves the visible plate flat, with
                        // u = 0 and u = 1 both untouched.
                        //
                        // SLERP, not lerp: a straight blend of two unit vectors
                        // is not a rotation, it slows in the middle and dips
                        // toward the origin, which the renormalise then turns
                        // into an uneven turn rate along the rung. ux is
                        // sign-matched to vx2 just above, so the arc is always
                        // the short one and never approaches the 180 deg
                        // degenerate case.
                        const fB = 1 - (1 - u) * (1 - u) * (1 - u);
                        let cd = Math.max(-1, Math.min(1,
                            ux * vx2 + uy * vy2 + uz * vz2));
                        const ca = Math.acos(cd);
                        const cs = Math.sin(ca);
                        let cw0 = 1 - fB; let cw1 = fB;
                        if (cs > 1e-6) {
                            cw0 = Math.sin((1 - fB) * ca) / cs;
                            cw1 = Math.sin(fB * ca) / cs;
                        }
                        let wax = cw0 * ux + cw1 * vx2;
                        let way = cw0 * uy + cw1 * vy2;
                        let waz = cw0 * uz + cw1 * vz2;
                        const wam = Math.hypot(wax, way, waz) || 1;
                        wax /= wam; way /= wam; waz /= wam;
                        // face normal: across both the length and the width
                        let fnx = tty * waz - ttz * way;
                        let fny = ttz * wax - ttx * waz;
                        let fnz = ttx * way - tty * wax;
                        const fnm = Math.hypot(fnx, fny, fnz) || 1;
                        fnx /= fnm; fny /= fnm; fnz /= fnm;
                        const hwU = nearHW + (hw - nearHW) * u;
                        // THE END THAT MEETS THE BACKBONE IS CUT IN ITS FACE.
                        // A rung leaves the ribbon at an angle - measured, its
                        // own thickness axis sits ~62 deg from the ribbon's face
                        // normal - so a square end cut carries one corner DOWN
                        // into the slab and lifts the opposite one OUT of it. At
                        // thickness 0 the end is a line lying in the face and
                        // the joint is exact, which is why it only shows once
                        // the rung is given depth: the error is the thickness
                        // offset's component along the face normal.
                        //
                        // So at the joint the thickness offset is taken IN THE
                        // FACE PLANE - the same oblique cut a mitred ligand
                        // junction uses, for the same reason. Only the first
                        // station: everywhere else the section stays square to
                        // the rung.
                        let ofx = fnx; let ofy = fny; let ofz = fnz;
                        if (k === 0) {
                            const fd2 = ofx * (n0x / n0l) + ofy * (n0y / n0l)
                                + ofz * (n0z / n0l);
                            ofx -= (n0x / n0l) * fd2;
                            ofy -= (n0y / n0l) * fd2;
                            ofz -= (n0z / n0l) * fd2;
                        }
                        const P = (sw, sf) => project(
                            cx2 + wax * hwU * sw + ofx * th * sf,
                            cy2 + way * hwU * sw + ofy * th * sf,
                            cz2 + waz * hwU * sw + ofz * th * sf);
                        const lp = P(1, 1); const lm = P(1, -1);
                        const rp = P(-1, 1); const rm = P(-1, -1);
                        if (!lp || !lm || !rp || !rm) { okRung = false; break; }
                        Lp.push(lp); Lm.push(lm); Rp.push(rp); Rm.push(rm);
                        // facing terms, in the same order evalSlab returns them
                        let vx3 = 0; let vy3 = 0; let vz3 = 1;
                        if (persp) {
                            vx3 = -cx2; vy3 = -cy2; vz3 = fl - cz2;
                            const vm = Math.hypot(vx3, vy3, vz3) || 1;
                            vx3 /= vm; vy3 /= vm; vz3 /= vm;
                        }
                        oN.push(wax * vx3 + way * vy3 + waz * vz3);
                        oB.push(fnx * vx3 + fny * vy3 + fnz * vz3);
                        oT.push(ttx * vx3 + tty * vy3 + ttz * vz3);
                        oK.push(0);          // a straight rung has no concavity
                        oLb.push(fnx * LIGHT[0] + fny * LIGHT[1] + fnz * LIGHT[2]);
                        oLn.push(wax * LIGHT[0] + way * LIGHT[1] + waz * LIGHT[2]);
                        oLt.push(ttx * LIGHT[0] + tty * LIGHT[1] + ttz * LIGHT[2]);
                        zSum += (lp[2] + lm[2] + rp[2] + rm[2]) / 4;
                    }
                    if (!okRung || Lp.length < 2) return;
                    // FILL IN PIECES, INK IN ONE RUN - the ribbon's own split.
                    // A rung spans ~7 A, so a single prim carries one sort key
                    // across the whole of it and cannot order against everything
                    // it crosses; that is why this was subdivided in the first
                    // place. But the OUTLINE must not be cut with it: an ink run
                    // per piece is what left the long edge dashed, each piece's
                    // fill painting over the previous piece's edge. So the fills
                    // are sliced per station and the silhouette is emitted once,
                    // over every station at once.
                    for (let s = 0; s + 1 < Lp.length; s++) {
                        const zPiece = (Lp[s][2] + Lm[s][2] + Rp[s][2] + Rm[s][2]
                            + Lp[s + 1][2] + Lm[s + 1][2] + Rp[s + 1][2]
                            + Rm[s + 1][2]) / 8;
                        prims.push({
                            kind: 'rib',
                            ss: 'C',

                            // it IS a rib, and is drawn as one; the flag is only
                            // so a rung can be told from a backbone downstream
                            naRung: true,
                            // colour is the base's own, already chosen
                            co: true,
                            arrow: false,
                            Lp: Lp.slice(s, s + 2), Lm: Lm.slice(s, s + 2),
                            Rp: Rp.slice(s, s + 2), Rm: Rm.slice(s, s + 2),
                            oN: oN.slice(s, s + 2), oB: oB.slice(s, s + 2),
                            oT: oT.slice(s, s + 2), oK: oK.slice(s, s + 2),
                            oLb: oLb.slice(s, s + 2), oLn: oLn.slice(s, s + 2),
                            oLt: oLt.slice(s, s + 2),
                            z: zPiece,
                            zShade: zPiece,
                            c: col,
                            // the near end is buried in the backbone slab and the
                            // far end meets its partner's rung exactly, so
                            // neither is a boundary wanting a cross-section
                            capStart: false,
                            capEnd: false,
                            // THE RESIDUE THIS RUNG BELONGS TO, stated rather
                            // than inferred. gs0 carries a sub-station offset so
                            // the pencil can vary along the rung, and a consumer
                            // that rounds it to get a residue lands on the NEXT
                            // one for every slice past the midpoint.
                            resId: res,
                            // ...and the palette slot, on the same terms the
                            // backbone states it (see the rib prim): only when
                            // the colour really did come from the palette, or a
                            // lookup would repaint it with something else. A
                            // rung is never protein, so the ss-mode half of
                            // that test cannot apply to it.
                            ci: frameProbe ? slot : undefined,
                            ciPalette: frameProbe ? !hasColorOverrides : undefined,
                            gs0: res + s / Math.max(1, nseg),
                            gsStep: 1 / Math.max(1, nseg),
                        });
                    }
                    // the boundary of the top face, at EVERY station rather than
                    // just the four extreme corners. A rung that twists on its
                    // way out - which is most of them in a folded RNA - projects
                    // to a shape the corner quad gets wrong, and where the twist
                    // passes edge-on the corner quad self-intersects into a
                    // bowtie, so the point-in-polygon test reports the middle of
                    // the plate as outside it. Walking the rails costs a handful
                    // of points and is exact for what is painted.
                    const pickPoly = [];
                    for (let s = 0; s < Lp.length; s++) {
                        pickPoly.push([Lp[s][0], Lp[s][1]]);
                    }
                    for (let s = Rp.length - 1; s >= 0; s--) {
                        pickPoly.push([Rp[s][0], Rp[s][1]]);
                    }
                    renderer._naPick.push({
                        res,
                        z: zSum / Lp.length,
                        poly: pickPoly,
                    });
                    if (inkWanted) {
                        // THE LOOP RULE, so the rung carries no INNER line.
                        // The hull test finds every silhouette corner, and on a
                        // section with real depth the interior crease - where
                        // the broad face turns into the thin edge - runs a hair
                        // inside that silhouette and is picked up with it, which
                        // draws as a second line down the rung rather than as
                        // structure. Keeping only the corners extreme ACROSS the
                        // rung leaves the outline exact and lets shading carry
                        // the crease, which is what loops and strands already do
                        // (see the same flag at the ribbon's own call).
                        emitSlabInk(Lp, Lm, Rp, Rm, oN, oB, oK, col,
                            !!(selInk && selInk.has(res)), res, true, false);
                    }
                };
                const fi = naFrames[i], fj = naFrames[j];
                if (!fi || !fj) continue;
                const reach = (fr, from2, to2) => {
                    // how far the midpoint lies along this residue's face normal
                    const n0 = [fr.t[1] * fr.s[2] - fr.t[2] * fr.s[1],
                        fr.t[2] * fr.s[0] - fr.t[0] * fr.s[2],
                        fr.t[0] * fr.s[1] - fr.t[1] * fr.s[0]];
                    const l0 = Math.hypot(n0[0], n0[1], n0[2]) || 1;
                    return ((to2.x - from2.x) * n0[0] + (to2.y - from2.y) * n0[1]
                        + (to2.z - from2.z) * n0[2]) / l0;
                };
                const midP = { x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2,
                    z: (pi.z + pj.z) / 2 };
                const ci = colors[bbSeg[i] >= 0 ? bbSeg[i] : bbSeg[i - 1]];
                const cj = colors[bbSeg[j] >= 0 ? bbSeg[j] : bbSeg[j - 1]];
                // each half spans its own backbone to the centre of the pair,
                // so the two colours meet in the middle of one continuous rung
                // start at the ribbon SURFACE (half its thickness out along the
                // face normal), run to the centre of the pair
                // Both halves on the SHARED pair axis, so they are collinear by
                // construction. Building each in its own backbone frame instead
                // gave a perfect joint but left the two halves 16 deg apart at
                // the middle - measured - and a rung that does not meet its
                // partner stops reading as a base pair.
                // each half is gated on ITS OWN residue: hiding one base of a
                // pair leaves the other's half rung standing, which is what
                // "show the bases I selected" has to mean when a selection
                // covers one strand of a duplex
                const si = bbSeg[i] >= 0 ? bbSeg[i] : bbSeg[i - 1];
                const sj = bbSeg[j] >= 0 ? bbSeg[j] : bbSeg[j - 1];
                if (ci && baseShown(i)) mk(pi, fi, ci, i, si);
                if (cj && baseShown(j)) mk(pj, fj, cj, j, sj);
            }
        }

        // ---- OFFSCREEN REDIRECT FOR THE PENCIL PASS ------------------------
        // Grain has to apply to the structure and not the paper, and the only
        // thing that distinguishes them is COVERAGE. On the real canvas there
        // is none to read: viewer-mol fills it opaque white, so every pixel has
        // full alpha. The first version recovered coverage by comparing pixels
        // against the background colour, which meant a getImageData +
        // putImageData round trip every frame - measured 26 ms on a 518 px
        // canvas, about half the frame, and bounding the region did not help
        // because the structure fills most of the view.
        //
        // Drawing into a TRANSPARENT offscreen canvas instead gives coverage
        // for free as alpha, and the whole effect becomes GPU compositing:
        //   grain tile -> masked by the structure's alpha (destination-in)
        //              -> multiplied onto the structure (multiply)
        //              -> blitted onto the real canvas
        // Multiply with a transparent source leaves the destination untouched,
        // which is exactly why masking the grain FIRST protects the paper
        // without any per-pixel work.
        const pencilWanted = Math.max(0, Math.min(1,
            renderer.cartoonPencil !== undefined
                ? renderer.cartoonPencil : (rich ? PENCIL_DEFAULT : 0)));
        // Applied on EVERY frame, dragging included. It was skipped during
        // gestures when it cost 26 ms - half the frame - but the GPU
        // compositing path below runs in 0.6-1.6 ms, so skipping saves nothing
        // worth having and costs something real: the grain popped in the moment
        // the view settled, which reads as the render changing under you.
        const pencilOn = pencilWanted > 0.001;
        let realCtx = null;
        let offCv = null;
        if (pencilOn && typeof document !== 'undefined'
            && ctx.canvas && ctx.drawImage && ctx.createPattern) {
            const dw = ctx.canvas.width;
            const dh = ctx.canvas.height;
            if (dw > 0 && dh > 0) {
                offCv = renderer._pencilOff;
                if (!offCv || offCv.width !== dw || offCv.height !== dh) {
                    offCv = document.createElement('canvas');
                    offCv.width = dw; offCv.height = dh;
                    renderer._pencilOff = offCv;
                }
                const oc = offCv.getContext('2d');
                if (oc) {
                    oc.setTransform(1, 0, 0, 1, 0, 0);
                    oc.clearRect(0, 0, dw, dh);
                    // carry the real context's transform so every coordinate
                    // computed above lands in the same place
                    let m = null;
                    if (ctx.getTransform) { try { m = ctx.getTransform(); } catch (e) { m = null; } }
                    if (m) oc.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
                    else {
                        const k = dw / Math.max(1, displayWidth);
                        oc.setTransform(k, 0, 0, k, 0, 0);
                    }
                    realCtx = ctx;
                    ctx = oc;
                } else {
                    offCv = null;
                }
            }
        }

        // ---- PAINT BACKEND SEAM --------------------------------------------
        // Every filled quad in the cartoon goes through painter.quad(). The
        // default backend below issues the canvas path calls this code always
        // made, so nothing changes; the point is that the geometry is now handed
        // over as DATA at a single choke point.
        //
        // Why here: profiling puts ~73% of a large frame in paint, and that cost
        // is draw-call COUNT - 262k calls at 10000 residues, ~1.9 us each, 4.2
        // fills per primitive with a different tone on every one. Batching at the
        // canvas level is therefore impossible (measured: no runs to merge, and
        // dropping the seam stroke bought only ~7%). A GPU backend wins by
        // consuming these same quads as vertex data - 260k triangles is one draw
        // call - and gets hardware depth testing, which also retires the
        // painter's-algorithm sorting this file works so hard around.
        //
        // A backend implements: quad(x0,y0,x1,y1,x2,y2,x3,y3, fillStyle,
        // strokeStyle, lineWidth) and is set as renderer.cartoonPainter.
        // SVG export keeps working through the canvas backend unchanged.
        const painter = renderer.cartoonPainter || {
            quad: (x0, y0, x1, y1, x2, y2, x3, y3, fill, strokeStyle, lw) => {
                ctx.fillStyle = fill;
                ctx.beginPath();
                ctx.moveTo(x0, y0);
                ctx.lineTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x3, y3);
                ctx.lineTo(x0, y0);
                ctx.fill();
                if (strokeStyle) {
                    ctx.strokeStyle = strokeStyle;
                    ctx.lineWidth = lw || 1;
                    ctx.stroke();
                }
            },
            begin: () => {},
            end: () => {},
        };
        if (painter.begin) painter.begin(displayWidth, displayHeight);

        // --- paint, back to front ---
        if (renderer._phase) renderer._phase.build = (typeof performance !== 'undefined'
            ? performance.now() : 0);
        // set renderer._primProbe = null before a render to receive the sorted
        // primitive list - each carries gs0 (its position along the backbone,
        // in residues) and c, which is what makes a colour boundary measurable
        // in residue units rather than in pixels
        if (renderer._primProbe === null) renderer._primProbe = prims;
        // THE CLIP SLAB, on the 2D path, is a CULL rather than a cut: a canvas
        // paints whole primitives, so a piece straddling a plane is kept or
        // dropped by its own depth and the cut comes out stepped at the scale
        // of one station (a residue over `detail`). The GPU path cuts per
        // fragment and is exact; this is the fallback, and it is the same slab
        // - renderer.clipAccepts is the single test both ask.
        // THE BACKBONE SWITCH, at the same place the clip cuts. Two questions,
        // both per prim: is this backbone at all - only the ribbon and the loop
        // tube are, while sticks, joints, base plates and contact lines are
        // what a side chain is made of - and does it belong to a residue whose
        // backbone the user hid. The CA stays either way: the sticks are drawn
        // from it and it is a point on a face, not a prim of its own.
        const bbHide = renderer.backboneHiddenSet ? renderer.backboneHiddenSet() : null;
        if (bbHide) {
            const isBackbonePrim = (kd) => kd === 'rib' || kd === 'ribStroke' || kd === 'tube';
            // WHICH RESIDUE A PRIM IS, from the position it carries along the
            // backbone. A piece spans a fraction of a residue to a couple of
            // them, so it is asked at its MIDDLE - the ends of a piece are
            // shared with its neighbours and would each answer twice.
            const resOf = (g) => {
                if (typeof g.gs0 !== 'number') return -1;
                const ns = (g.Lp && g.Lp.length) || (g.pts && g.pts.length) || 1;
                const step = typeof g.gsStep === 'number' ? g.gsStep : 0;
                return Math.round(g.gs0 + step * (ns - 1) / 2);
            };
            let k = 0;
            for (let i = 0; i < prims.length; i++) {
                const g = prims[i];
                if (isBackbonePrim(g.kind) && bbHide.has(resOf(g))) continue;
                prims[k++] = g;
            }
            prims.length = k;
        }
        if (renderer.clipSlabOn && renderer.clipSlabOn()) {
            let k = 0;
            for (let i = 0; i < prims.length; i++) {
                if (renderer.clipAccepts(prims[i].z)) prims[k++] = prims[i];
            }
            prims.length = k;
        }
        prims.sort((a, b) => a.z - b.z);
        if (renderer._phase) { renderer._phase.prims = prims.length;
            renderer._phase.sorted = (typeof performance !== 'undefined' ? performance.now() : 0); }
        // GEOMETRY ONLY. A consumer that wants the primitives and not the
        // picture - the GPU prototype harvesting a mesh - has everything it
        // came for by this line: the prims are built, and _primProbe already
        // holds them. Everything past here paints a frame nobody will look at,
        // and the ink pass alone is the larger half of it. Measured on 1UBQ,
        // 13 ms of a 44 ms capture.
        //
        // The sort above is deliberately kept: it costs nothing next to the
        // paint and it leaves the list in the order the painter would use,
        // which a consumer comparing against a painted reference wants.
        if (renderer._probeOnly) return;
        // First pass: record the earliest draw order at every joint. A
        // primitive whose order IS the minimum at a joint is drawn before all
        // its neighbours there, so its round cap gets covered by them.
        for (let o = 0; o < prims.length; o++) {
            const g = prims[o];
            if (!g.joints) continue;
            g.order = o;
            for (const key of g.joints) {
                // An EMPTY slot is a joint that wants no cap, not a joint named
                // `undefined`: without this the empty slots of every such prim
                // collide on one key and whichever landed lowest draws a cap.
                // The slots are positional - [0] is the start point, [1] the end
                // - so a prim that caps only one of its ends has to be able to
                // say which.
                if (!key) continue;
                const cur = jointMinOrder.get(key);
                if (cur === undefined || o < cur) jointMinOrder.set(key, o);
            }
        }
        const capAt = (g, key) =>
            g.joints && (jointMinOrder.get(key) === g.order);
        // Outline colour: black by default, or a tint of the element's own
        // colour (matching ribbon mode) when cartoonOutlineTint > 0.
        const inkTint = renderer.cartoonOutlineTint !== undefined
            ? renderer.cartoonOutlineTint : 0;
        const inkOf = (g, near) => inkColor(g && g.c, inkTint, near);
        // Shading parameters shared by ribbons (slab faces) and loops (tubes).
        // Hoisted to render scope so the tube branch can band its cylinder
        // with the SAME levels the ribbon faces use - loops previously took
        // no lighting at all and read as pasted-on wire next to lit ribbons.
        const innerShade = renderer._innerShade !== undefined
            ? renderer._innerShade : INNER_SHADE;
        const hiGain = renderer.cartoonHighlight !== undefined
            ? renderer.cartoonHighlight : 1;
        // `smooth` names the STATE (gradients vs flat tone bands); the local
        // `cel` keeps the technique's name for the banding code below.
        const cel = renderer.cartoonSmooth !== true;
        // SVG EXPORT: one path per face strip with ONE multi-stop gradient,
        // instead of a fill (and often a 2-stop gradient def) per sub-quad.
        // Measured on 1TIM richardson: 9.8k fill paths + 4.1k gradient defs,
        // 3.3 MB. On screen the per-sub-quad path stays: a per-piece gradient
        // runs along a straight chord axis, and under ROTATION the tone seam
        // where neighbouring pieces' axes disagree jumps visibly - a static
        // export has no rotation, so the seam objection does not apply.
        const svgStrips = !!ctx.getSerializedSvg && !!ctx.createLinearGradient;
        // Stop thinning for the export gradients, by the SAME visibility rule
        // the canvas path uses to decide gradient vs solid (differences of
        // <= 3 RGB units are invisible): a slowly drifting tone keeps only
        // its endpoints and lets the gradient interpolate the middle.
        const parseRgb = (c) => {
            const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(c);
            return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
        };
        const stopsThin = (stops) => {
            const out = [stops[0]];
            let last = parseRgb(stops[0][1]);
            for (let i = 1; i < stops.length; i++) {
                const cur = parseRgb(stops[i][1]);
                const d = Math.max(Math.abs(cur[0] - last[0]),
                    Math.abs(cur[1] - last[1]), Math.abs(cur[2] - last[2]));
                if (d > 3 || i === stops.length - 1) {
                    out.push(stops[i]);
                    last = cur;
                }
            }
            return out;
        };
        // Fixed at 8. It was exposed as a "Bands" slider, but the low end
        // posterises hard enough to lose the shape's read and the high end is
        // indistinguishable from smooth shading, so the useful range was a
        // single value - a control with one good setting is not a control.
        const celLevels = CEL_LEVELS;
        // snap v (in [lo,hi]) to celLevels evenly spaced values.
        // Degenerate range guard: with the light off, faceTone and edgeTone
        // both collapse to 1, so lo === hi here and the division below is
        // 0/0 - the NaN propagated into shade() as an invalid fillStyle,
        // which canvas silently ignores, so faces painted with whatever
        // colour happened to be set last.
        const quant = (v, lo, hi) => {
            if (hi - lo < 1e-9) return v;
            const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
            return lo + (Math.round(t * (celLevels - 1))
                / (celLevels - 1)) * (hi - lo);
        };
        // Light direction projected into SCREEN space. project() maps world
        // +y to screen -y, so the y component flips; the z component drops
        // out because a tube's cross-section shading only depends on the
        // light's component perpendicular to the tube ON SCREEN.
        const LIGHT_SCREEN = (() => {
            const lx = LIGHT[0];
            const ly = -LIGHT[1];
            const m = Math.hypot(lx, ly) || 1;
            return [lx / m, ly / m];
        })();
        const blackCap = (x, y, r, ink) => {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = ink || OUTLINE_CSS;
            ctx.fill();
        };

        // ---- EXPORT OCCLUSION CULLING ---------------------------------------
        // The painter's algorithm draws back-to-front, so on a globular
        // structure a large share of the fills are completely buried under
        // nearer geometry - free on canvas (overdraw), permanent bytes in an
        // SVG. For exports, rasterise every opaque primitive into a depth
        // buffer first (a compact copy of the ink pass's zbuf backend, same
        // slope-scaled bias so a surface never occludes a point lying on
        // itself), then skip any rib piece or plate whose sampled corners are
        // ALL clearly behind something else. Conservative: one visible sample
        // keeps the piece. renderer._svgCull = false turns it off.
        let exportHidden = null;
        // renderer._paintCull = true enables the same culling for CANVAS
        // frames - an experiment gate, not a default: the depth raster costs
        // real per-frame CPU and the sliver risk becomes temporal flicker.
        if ((svgStrips && renderer._svgCull !== false) || renderer._paintCull === true) {
            const ZW2 = Math.max(1, Math.ceil(displayWidth));
            const ZH2 = Math.max(1, Math.ceil(displayHeight));
            const EMPTY2 = -Infinity;
            const zb = new Float32Array(ZW2 * ZH2).fill(EMPTY2);
            const BIAS2 = 4;
            const dOf = (pt) => (persp ? pt[3] : pt[2]);
            const zOf2 = (D) => (persp ? fl - fl / D : D);
            const tri2 = (p0, p1, p2) => {
                const x0 = p0[0]; const y0 = p0[1];
                const x1 = p1[0]; const y1 = p1[1];
                const x2 = p2[0]; const y2 = p2[1];
                let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
                if (area > -1e-9 && area < 1e-9) return;
                let a0 = p0; let a1 = p1; let a2 = p2;
                if (area < 0) { a1 = p2; a2 = p1; area = -area; }
                const bx0 = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
                const bx1 = Math.min(ZW2 - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
                const by0 = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
                const by1 = Math.min(ZH2 - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
                if (bx1 < bx0 || by1 < by0) return;
                const ax = a0[0]; const ay = a0[1];
                const bxx = a1[0]; const byy = a1[1];
                const cxx = a2[0]; const cyy = a2[1];
                const da = dOf(a0); const db = dOf(a1); const dc = dOf(a2);
                const inv = 1 / area;
                const gx = ((db - da) * (cyy - ay) - (dc - da) * (byy - ay)) * inv;
                const gy = ((dc - da) * (bxx - ax) - (db - da) * (cxx - ax)) * inv;
                const bias = (Math.abs(gx) + Math.abs(gy)) * 0.5 * BIAS2;
                for (let py = by0; py <= by1; py++) {
                    const sy = py + 0.5;
                    const row = py * ZW2;
                    for (let px = bx0; px <= bx1; px++) {
                        const sx = px + 0.5;
                        const w0 = (bxx - ax) * (sy - ay) - (sx - ax) * (byy - ay);
                        if (w0 < 0) continue;
                        const w1 = (cxx - bxx) * (sy - byy) - (sx - bxx) * (cyy - byy);
                        if (w1 < 0) continue;
                        const w2 = (ax - cxx) * (sy - cyy) - (sx - cxx) * (ay - cyy);
                        if (w2 < 0) continue;
                        const d = (w1 * da + w2 * db + w0 * dc) * inv - bias;
                        const k = row + px;
                        if (d > zb[k]) zb[k] = d;
                    }
                }
            };
            const cap2 = (aP, bP, rr) => {
                if (rr <= 0.5) return;
                const bx0 = Math.max(0, Math.ceil(Math.min(aP[0], bP[0]) - rr - 0.5));
                const bx1 = Math.min(ZW2 - 1, Math.floor(Math.max(aP[0], bP[0]) + rr - 0.5));
                const by0 = Math.max(0, Math.ceil(Math.min(aP[1], bP[1]) - rr - 0.5));
                const by1 = Math.min(ZH2 - 1, Math.floor(Math.max(aP[1], bP[1]) + rr - 0.5));
                if (bx1 < bx0 || by1 < by0) return;
                const dx = bP[0] - aP[0];
                const dy = bP[1] - aP[1];
                const L2 = dx * dx + dy * dy;
                const invL2 = L2 > 1e-9 ? 1 / L2 : 0;
                const da = dOf(aP); const db = dOf(bP);
                const rr2 = rr * rr;
                const segLen = Math.sqrt(L2);
                const bias = segLen > 1e-6
                    ? Math.abs(db - da) / segLen * 0.7071 * BIAS2 : 0;
                for (let py = by0; py <= by1; py++) {
                    const sy = py + 0.5;
                    const row = py * ZW2;
                    for (let px = bx0; px <= bx1; px++) {
                        const sx = px + 0.5;
                        let t = ((sx - aP[0]) * dx + (sy - aP[1]) * dy) * invL2;
                        if (t < 0) t = 0; else if (t > 1) t = 1;
                        const ex = aP[0] + t * dx - sx;
                        const ey = aP[1] + t * dy - sy;
                        if (ex * ex + ey * ey >= rr2) continue;
                        const d = da + t * (db - da) - bias;
                        const k = row + px;
                        if (d > zb[k]) zb[k] = d;
                    }
                }
            };
            for (const g of prims) {
                if (g.kind === 'rib') {
                    const nsO = g.Lp.length;
                    if (g.capStart) tri2(g.Lp[0], g.Lm[0], g.Rm[0]);
                    if (g.capStart) tri2(g.Lp[0], g.Rm[0], g.Rp[0]);
                    if (g.capEnd) tri2(g.Lp[nsO - 1], g.Lm[nsO - 1], g.Rm[nsO - 1]);
                    if (g.capEnd) tri2(g.Lp[nsO - 1], g.Rm[nsO - 1], g.Rp[nsO - 1]);
                    for (const [A, B] of [[g.Lp, g.Rp], [g.Lm, g.Rm],
                        [g.Lp, g.Lm], [g.Rp, g.Rm]]) {
                        for (let s = 0; s + 1 < nsO; s++) {
                            tri2(A[s], A[s + 1], B[s + 1]);
                            tri2(A[s], B[s + 1], B[s]);
                        }
                    }
                } else if (g.kind === 'tube') {
                    const rr = (Math.max(1.5, g.tubeA * 2 * scale * g.pe)
                        + outlineW) / 2 - 1;
                    for (let j = 0; j + 1 < g.pts.length; j++) {
                        cap2(g.pts[j], g.pts[j + 1], rr);
                    }
                } else if (g.kind === 'line' && g.pts) {
                    // a run: every leg of it occludes
                    for (let j = 0; j + 1 < g.pts.length; j++) {
                        cap2(g.pts[j], g.pts[j + 1], (g.w + outlineW) / 2 - 1);
                    }
                } else if (g.kind === 'joint') {
                    for (let k2 = 1; k2 + 1 < g.q.length; k2++) {
                        tri2(g.q[0], g.q[k2], g.q[k2 + 1]);
                    }
                } else if (g.kind === 'stickFace') {
                    // FANNED, because a tube's end cap is an n-gon. A quad is
                    // the two-triangle case of the same loop.
                    for (let k2 = 1; k2 + 1 < g.q.length; k2++) {
                        tri2(g.q[0], g.q[k2], g.q[k2 + 1]);
                    }
                } else if (g.kind === 'dot' && g.pA) {
                    cap2(g.pA, g.pA, g.r + outlineW / 2 - 1);
                }
            }
            const EPS2 = 0.15;
            exportHidden = (pt) => {
                const px = pt[0] | 0;
                const py = pt[1] | 0;
                if (px < 0 || py < 0 || px >= ZW2 || py >= ZH2) return true; // offscreen
                const d = zb[py * ZW2 + px];
                if (d === EMPTY2) return false;
                return zOf2(d) > pt[2] + EPS2;
            };
        }
        // THE MIDDLE IS SAMPLED TOO, not just the four corner curves. A piece
        // is dropped only when every sample is behind something else, so a
        // sample set that covers only the RIM will drop a piece whose edges are
        // occluded while its wide face is in plain view - the ribbon passes
        // behind something that hides its two borders and not its middle. The
        // test is a conservative one by design (a single visible sample keeps
        // the piece), and adding samples can only keep more, never fewer.
        const ribHidden = (g) => {
            const nsH = g.Lp.length;
            const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
                (a[2] + b[2]) / 2];
            for (let s = 0; s < nsH; s++) {
                if (!exportHidden(g.Lp[s]) || !exportHidden(g.Lm[s])
                    || !exportHidden(g.Rp[s]) || !exportHidden(g.Rm[s])) return false;
                // the centre of the section, and the middle of each wide face
                if (!exportHidden(mid(g.Lp[s], g.Rm[s]))
                    || !exportHidden(mid(g.Lp[s], g.Rp[s]))
                    || !exportHidden(mid(g.Lm[s], g.Rm[s]))) return false;
            }
            return true;
        };
        // Same reasoning for a flat quad: its corners can all be covered while
        // the middle shows through.
        const quadHidden = (q) => {
            if (!q.every(exportHidden)) return false;
            let cx = 0; let cy = 0; let cz = 0;
            for (const p of q) { cx += p[0]; cy += p[1]; cz += p[2]; }
            const k = q.length || 1;
            return exportHidden([cx / k, cy / k, cz / k]);
        };

        // ROUND SHADING FOR ANYTHING STROKED AS A CYLINDER: the backbone
        // tube, and now ligand bonds too. A run of nested strokes, each
        // narrower than the last and pushed further toward the light, reads as
        // a round section - no gradients, so it survives the SVG export the way
        // a gradient fill would not.
        //
        // Factored out of the tube branch rather than reimplemented: the
        // fiddly parts (per-point normals signed toward the light, and the
        // longitudinal extension that stops a narrow band being erased at a
        // joint by the next primitive's full-width band) are exactly as
        // necessary for a bond meeting another bond as for two tube pieces.
        //
        // `ext` carries one extension point beyond each end where the caller
        // has them, for a true central difference at the ends.
        // `gain` scales how far the modelling goes, in tone AND in how much of
        // the section the lit core covers. The tube uses the full amount; a
        // ligand uses a fraction of it, because a stick that models as hard as
        // the backbone stops reading as a small thing in front of a big one and
        // starts competing with the structure it sits in.
        const strokeRound = (P, lw, col, near, dim, ext, gain) => {
            // Modelling FADES IN with width rather than switching on at a
            // threshold. Bond widths vary with perspective and with the width
            // control, so a fixed cutoff put some bonds of one ligand either
            // side of it: half the sticks came out round and half flat, and
            // zooming flipped them. Below MIN a band is thinner than the line
            // it sits in and there is nothing to show; above FULL it is the
            // full effect; between, the bands converge in tone, which reads as
            // the same shape lit more softly.
            const wG = Math.max(0, Math.min(1,
                (lw - SHADE_W_MIN) / (SHADE_W_FULL - SHADE_W_MIN)));
            const gn = (gain === undefined ? 1 : gain) * wG;
            const bands = (!lightOn || gn < 0.02) ? 0 : (cel ? celLevels : 4);
            ctx.lineCap = 'round';
            if (bands < 2) {
                ctx.strokeStyle = shade(col, near, dim);
                ctx.lineWidth = lw;
                strokePath(P);
                return;
            }
            const last = P.length - 1;
            const push = new Array(P.length);
            const E = (ext && ext.length === P.length + 2 && ext.every(Boolean))
                ? ext : null;
            for (let i = 0; i <= last; i++) {
                const a = E ? E[i] : P[Math.max(0, i - 1)];
                const b = E ? E[i + 2] : P[Math.min(last, i + 1)];
                let tx = b[0] - a[0];
                let ty = b[1] - a[1];
                const m = Math.hypot(tx, ty);
                if (m < 1e-6) { push[i] = [0, 0, 0, 0, 0]; continue; }
                tx /= m; ty /= m;
                const nx = -ty;
                const ny = tx;
                const d = nx * LIGHT_SCREEN[0] + ny * LIGHT_SCREEN[1];
                push[i] = [nx * Math.sign(d), ny * Math.sign(d),
                    Math.abs(d), tx, ty];
            }
            const half = lw / 2;
            for (let k = 0; k < bands; k++) {
                const t2 = k / (bands - 1);            // 0 shadow -> 1 lit
                let q = LIGHT_AMB + LIGHT_DIFF * gn * t2;
                if (hiGain > 0 && t2 > 0.999) q += LIGHT_HI * hiGain * gn;
                if (cel) {
                    q = quant(q, LIGHT_AMB,
                        LIGHT_AMB + (LIGHT_DIFF + LIGHT_HI * hiGain) * gn);
                }
                ctx.strokeStyle = shade(col, near, dim, 1, q);
                ctx.lineWidth = Math.max(1, lw * (1 - 0.8 * gn * t2));
                const bandHalf = ctx.lineWidth / 2;
                if (k === 0) { strokePath(P); continue; }
                const off = (half - bandHalf) * t2;
                const shifted = P.map((q2, i) => [
                    q2[0] + push[i][0] * push[i][2] * off,
                    q2[1] + push[i][1] * push[i][2] * off,
                ]);
                const e = half - bandHalf;
                if (e > 0.01) {
                    const p0 = shifted[0];
                    const t0 = push[0];
                    const pN = shifted[last];
                    const tN = push[last];
                    shifted.unshift([p0[0] - t0[3] * e, p0[1] - t0[4] * e]);
                    shifted.push([pN[0] + tN[3] * e, pN[1] + tN[4] * e]);
                }
                strokePath(shifted);
            }
        };

        // ...and the same idea for a lone atom, which is a SPHERE rather than a
        // cylinder: concentric discs shrinking toward a centre offset along the
        // light, which is the 2D read of a highlight sitting off-centre on a
        // ball. Discs, not a radial gradient, for the same export reason.
        const fillRound = (x, y, r, col, near, dim, gain) => {
            const wG = Math.max(0, Math.min(1,
                (2 * r - SHADE_W_MIN) / (SHADE_W_FULL - SHADE_W_MIN)));
            const gn = (gain === undefined ? 1 : gain) * wG;
            const bands = (!lightOn || gn < 0.02) ? 0 : (cel ? celLevels : 4);
            if (bands < 2) {
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fillStyle = shade(col, near, dim);
                ctx.fill();
                return;
            }
            for (let k = 0; k < bands; k++) {
                const t2 = k / (bands - 1);
                let q = LIGHT_AMB + LIGHT_DIFF * gn * t2;
                if (hiGain > 0 && t2 > 0.999) q += LIGHT_HI * hiGain * gn;
                if (cel) {
                    q = quant(q, LIGHT_AMB,
                        LIGHT_AMB + (LIGHT_DIFF + LIGHT_HI * hiGain) * gn);
                }
                const rr = r * (1 - 0.75 * gn * t2);
                const off = (r - rr) * t2;
                ctx.beginPath();
                ctx.arc(x + LIGHT_SCREEN[0] * off, y + LIGHT_SCREEN[1] * off,
                    rr, 0, Math.PI * 2);
                ctx.fillStyle = shade(col, near, dim, 1, q);
                ctx.fill();
            }
        };

        ctx.lineJoin = 'round';
        // COLOUR WASH. The fills go down over the sketch, slightly off
        // register - a hand colouring a drawing does not follow its own pencil
        // exactly, and that near-miss is most of what makes it read as painted
        // rather than as computed. The offset is applied to the whole layer, so
        // it costs one transform rather than a shift per piece.
        const animWash = anim ? anim.wash : 1;
        // Does this piece bleed? Deterministic per piece, so the same places
        // run on every frame and the smear sits still instead of crawling.
        const smearOf = (g) => (wobble(g.gs0 === undefined ? 0 : g.gs0, 3.7)
            + 0.5) < WASH_SMEAR_FRAC;
        // WHERE THE PAINT RAN. A minority of pieces get one extra translucent
        // copy, offset past their own edge and mostly DOWNWARD - a wet edge
        // runs with gravity, and matching the colour layer's own offset would
        // only look like a thicker ribbon.
        //
        // Filled as ONE closed path per piece - up the top face's left edge and
        // back down its right - never as the quads the piece is really made of.
        // That is the whole trick: a translucent quad strip shows every seam
        // inside it and reads as wireframe, while a single translucent
        // silhouette reads as a stain. It is also cheaper than the painting it
        // replaces, since it skips shading, lighting and edges entirely.
        // animWash > 0: before the brush has touched the paper there is no
        // paint to have run, and `>` alone would leave the first piece's stain
        // sitting there through the entire pencil phase.
        if (anim && animWash > 0) {
            ctx.save();
            ctx.translate((WASH_OFF_X * 2 + WASH_BLEED_PX * 0.4) * pxScale,
                (WASH_OFF_Y * 2 + WASH_BLEED_PX) * pxScale);
            ctx.globalAlpha = WASH_BLEED_ALPHA;
            for (const g of prims) {
                if (chainU(g) > animWash || !smearOf(g)) continue;
                if (g.kind === 'rib') {
                    const A = g.Lp;
                    const B = g.Rp;
                    if (!A || A.length < 2) continue;
                    ctx.fillStyle = `rgb(${g.c.r},${g.c.g},${g.c.b})`;
                    ctx.beginPath();
                    ctx.moveTo(A[0][0], A[0][1]);
                    for (let s = 1; s < A.length; s++) ctx.lineTo(A[s][0], A[s][1]);
                    for (let s = B.length - 1; s >= 0; s--) ctx.lineTo(B[s][0], B[s][1]);
                    ctx.closePath();
                    ctx.fill();
                }
            }
            ctx.restore();
        }
        if (anim) {
            ctx.save();
            ctx.translate(WASH_OFF_X * pxScale, WASH_OFF_Y * pxScale);
        }
        // PAINT GOES DOWN OPAQUE. A piece used to fade up over a short "wet
        // frontier", which sounded right and looked wrong: a ribbon is built
        // from many quads that overlap along their shared edges, plus hairline
        // strokes that seal the seams between them, and at any alpha below 1
        // every one of those doubles up and shows. The result was a visible
        // mesh over the drawing - the tessellation of the model, which is the
        // one thing the illusion cannot survive. Anything translucent here has
        // to be flattened first (see the bleed pass, which fills ONE silhouette
        // path per piece for exactly this reason).
        for (const g of prims) {
            // `>` alone lets the piece at chainU 0 through while the brush is
            // still at 0 - so the first piece of the chain, and its bleed
            // stain, sat on the paper through the whole pencil phase as a
            // smudge in the middle of a drawing that had no colour in it yet.
            if (anim && (animWash <= 0 || chainU(g) > animWash)) continue;
            const near = nearOf(g.z);
            // export culling: a piece whose every sampled corner is clearly
            // behind other geometry paints nothing visible - skip it entirely
            if (exportHidden) {
                if (g.kind === 'rib' && ribHidden(g)) continue;
                if (g.kind === 'stickFace' && quadHidden(g.q)) continue;
                if (g.kind === 'joint' && quadHidden(g.q)) continue;
                // strokes kept by the interval culling's safety pad but lying
                // fully outside the canvas: nothing of them can show
                if (g.kind === 'tube' || (g.kind === 'line' && g.pA && g.pB)
                    || (g.kind === 'dot' && g.pA)) {
                    const mOut = (g.kind === 'dot' ? g.r
                        : g.kind === 'line' ? g.w / 2
                            : Math.max(1.5, g.tubeA * 2 * scale * g.pe) / 2)
                        + outlineW + 2;
                    const P = (g.kind === 'tube' || g.kind === 'line')
                        ? g.pts : [g.pA];
                    let x0b = Infinity; let y0b = Infinity;
                    let x1b = -Infinity; let y1b = -Infinity;
                    for (const q of P) {
                        if (q[0] < x0b) x0b = q[0];
                        if (q[0] > x1b) x1b = q[0];
                        if (q[1] < y0b) y0b = q[1];
                        if (q[1] > y1b) y1b = q[1];
                    }
                    if (x1b < -mOut || x0b > displayWidth + mOut
                        || y1b < -mOut || y0b > displayHeight + mOut) continue;
                }
            }
            if (g.kind === 'rib') {
                const Lp = g.Lp;
                const Lm = g.Lm;
                const Rp = g.Rp;
                const Rm = g.Rm;
                const ns = Lp.length;
                // interval-level depth for colour, piece-level depth for sort
                const nearS = g.zShade !== undefined ? nearOf(g.zShade) : near;
                // PER-STATION side lighting (piece-flat lum stepped tone
                // at every quarter boundary - "choppy" bands). The visible
                // side flips with the sign of oN; blend the two sides'
                // diffuse terms by |oN| so the value is continuous through
                // the flip.
                // EDGE-BAND SHADING PURGED (deliberate, to be revisited):
                // the side bands (thickness) render at the constant NEUTRAL
                // luminance - the same value lit faces converge to at
                // grazing, so the face-to-edge transition stays smooth. All
                // remaining "edge-band shading pops" came from these
                // surfaces; with a constant lum they cannot pop. Directional
                // light + inner shadow remain on the wide faces only.
                const sideLumAt = () => soft(LIGHT_AMB + LIGHT_DIFF * 0.5);
                // fill one sub-quad, splitting BOW-TIES (twisted quads whose
                // outline self-intersects fill only two opposing triangles;
                // the uncovered pair flashes against the lighting)
                // Goes through painter.quad() - see the backend seam above.
                // fillStyle/strokeStyle are read off ctx so the many call sites
                // that set them before calling keep working unchanged.
                // The seam stroke stays: removing it measured only ~7% and
                // reintroduces the antialiasing seams it exists to hide.
                // ONE path, always. A twisted quad projects to a BOW-TIE, and
                // the nonzero winding rule already fills it correctly: each
                // lobe winds +-1 so both paint, while the two remaining
                // triangles of the hull wind 0 and stay empty - which is
                // right, because no ruling of the surface between (a0,b0) and
                // (a1,b1) ever sweeps them.
                //
                // This used to special-case the bow-tie and emit all four
                // triangles of the four corners. That covers the whole convex
                // hull - measured 100% MORE area than the surface actually
                // occupies - and the surplus paints over whatever neighbouring
                // face lies behind it. Which quads were classified as bow-ties
                // changed with the view, so faces appeared and vanished as the
                // structure turned. It showed only with smooth shading on,
                // because cel faces go through pathStrip (a single closed path,
                // already nonzero-filled) and never reached this code.
                const fillQuadSafe = (a0x, a0y, a1x, a1y, b1x, b1y, b0x, b0y) => {
                    painter.quad(a0x, a0y, a1x, a1y, b1x, b1y, b0x, b0y,
                        ctx.fillStyle, ctx.strokeStyle, ctx.lineWidth);
                };
                // SIDE strips per sub-quad with the same twist handling:
                // the thin thickness bands twist at every flank, and the
                // whole-piece path left bow-tie holes that flickered
                // LOOP ROUNDNESS. A loop is a slab of SQUARE section, and what
                // makes it read as square is not its silhouette - at loop width
                // that is 2-3 px - but its SHADING: four surfaces, four flat
                // tones, meeting at hard steps. A cylinder is the same lighting
                // sampled continuously around the section, so interpolating
                // toward "round" means giving the thickness bands the same
                // directional model the broad faces already use, evaluated on
                // the band's own outward direction (+-n instead of +-b).
                // At 0 the bands keep the constant neutral value they were
                // purged down to; at 1 all four surfaces are lit consistently
                // and the section reads as a tube.
                //
                // Reusing faceLum rather than raw diffuse matters: it carries
                // the grazing/dive convergence to LUM_NEUTRAL, which is what
                // stops edge bands flashing when overlapping pieces swap paint
                // order - the reason side shading was removed in the first
                // place.
                // Applies to EVERY element, not just loops. The thickness band
                // is the same surface whether it edges a loop, a helix or a
                // sheet, and lighting it consistently is what stops an element's
                // edge reading as a flat facet against its own face. Restricting
                // it to loops left helix and sheet edges shaded by a constant,
                // which is the discontinuity it exists to remove.

                const paintSide = (A, B, outward) => {
                    // SHEET EDGES ARE WHITE in the Richardson convention: the
                    // arrow reads as a plate of white card with a coloured
                    // face, and the pale rim is what separates strands where
                    // they overlap in a crowded sheet. Only the THICKNESS
                    // faces change - the broad faces keep the element colour.
                    //
                    // A BASE PLATE IS THE SAME OBJECT: a card with a coloured
                    // face, stacked against its neighbours up the duplex, where
                    // a pale rim is what keeps one rung from merging into the
                    // next. So it takes the same edge.
                    const gc = (rich && (g.ss === 'E' || g.naRung))
                        ? SHEET_EDGE_RGB : g.c;
                    ctx.lineWidth = 1;
                    ctx.lineJoin = 'round';
                    // CEL SHADING, same as paintFace above. This branch was
                    // MISSING, so with smooth off the broad faces went flat
                    // and the thickness bands kept their per-station gradient
                    // - one surface of every loop still airbrushed while the
                    // rest of the drawing was banded. The constant sideLumAt
                    // below is why it went unnoticed: it reads as though the
                    // sides were already flat, but BOTH call sites pass a
                    // non-zero `outward`, so that constant is never the value
                    // actually used.
                    //
                    // Piece means of the band's OWN outward direction (+-n),
                    // exactly as paintFace means over +-b. The quantization
                    // range is paintFace's with the inner-shadow term at
                    // zero, which is what it collapses to here (k = 0), so a
                    // side band lands on the SAME level ladder as the faces
                    // it meets - a band off the faces' ladder puts a visible
                    // step along an edge that should be continuous.
                    if (cel) {
                        const isPos = outward > 0;
                        let lnA = 0;
                        let nA = 0;
                        let tA = 0;
                        for (let s = 0; s < ns; s++) {
                            lnA += g.oLn ? g.oLn[s] : g.oN[s];
                            nA += g.oN[s];
                            tA += g.oT[s];
                        }
                        lnA /= Math.max(1, ns);
                        nA /= Math.max(1, ns);
                        tA /= Math.max(1, ns);
                        const lv = quant(
                            faceLum(lnA, 0, isPos, isPos ? nA : -nA, tA),
                            soft(LIGHT_AMB), soft(1) + LIGHT_HI * hiGain);
                        const flat = shade(gc, nearS, 1, edgeTone(), lv);
                        ctx.fillStyle = flat;
                        ctx.strokeStyle = flat;
                        pathStrip(A, B);
                        return;
                    }
                    // Export: whole band as one path + one multi-stop
                    // gradient, mirroring the paintFace export path above.
                    if (svgStrips && ns >= 2) {
                        // export culling, per STRIP: a visible piece's turned-
                        // away face sits a slab thickness behind its own front
                        // face, which is past the depth margin - so buried
                        // faces of visible pieces drop out here even when the
                        // piece as a whole survives.
                        if (exportHidden) {
                            let anyVis = false;
                            for (let s = 0; s < ns && !anyVis; s++) {
                                if (!exportHidden(A[s]) || !exportHidden(B[s])) anyVis = true;
                            }
                            if (!anyVis) return;
                        }
                        const x0 = (A[0][0] + B[0][0]) / 2;
                        const y0 = (A[0][1] + B[0][1]) / 2;
                        const x1 = (A[ns - 1][0] + B[ns - 1][0]) / 2;
                        const y1 = (A[ns - 1][1] + B[ns - 1][1]) / 2;
                        const axL2 = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0);
                        if (axL2 > 1) {
                            const stops = [];
                            let prevOff = 0;
                            for (let s = 0; s < ns; s++) {
                                const mx = (A[s][0] + B[s][0]) / 2 - x0;
                                const my = (A[s][1] + B[s][1]) / 2 - y0;
                                let off = (mx * (x1 - x0) + my * (y1 - y0)) / axL2;
                                off = Math.max(prevOff, Math.min(1, off));
                                off = Math.round(off * 1000) / 1000;
                                const lm = outward
                                    ? faceLum(g.oLn ? g.oLn[s] : g.oN[s], 0,
                                        outward > 0,
                                        outward > 0 ? g.oN[s] : -g.oN[s], g.oT[s])
                                    : sideLumAt(s);
                                stops.push([off, shade(gc, nearS, 1, edgeTone(), lm)]);
                                prevOff = off;
                            }
                            const th = stopsThin(stops);
                            const uni = th.every((st) => st[1] === th[0][1]);
                            let style2 = th[0][1];
                            if (!uni) {
                                const gr = ctx.createLinearGradient(x0, y0, x1, y1);
                                for (const st of th) gr.addColorStop(st[0], st[1]);
                                style2 = gr;
                            }
                            ctx.fillStyle = style2;
                            ctx.strokeStyle = style2;
                            pathStrip(A, B);
                            return;
                        }
                    }
                    const canGrad2 = !!ctx.createLinearGradient;
                    for (let s = 0; s + 1 < ns; s++) {
                        let l0v = sideLumAt(s);
                        let l1v = sideLumAt(s + 1);
                        if (outward) {
                            const isPos = outward > 0;
                            const d0 = faceLum(g.oLn ? g.oLn[s] : g.oN[s], 0,
                                isPos, isPos ? g.oN[s] : -g.oN[s], g.oT[s]);
                            const d1 = faceLum(g.oLn ? g.oLn[s + 1] : g.oN[s + 1], 0,
                                isPos, isPos ? g.oN[s + 1] : -g.oN[s + 1], g.oT[s + 1]);
                            l0v = d0;
                            l1v = d1;
                        }
                        // NOT constant-lum: `outward` is set at both call
                        // sites, so l0v/l1v above came from faceLum on the
                        // band's own direction and genuinely vary along the
                        // piece. This gradient is the smooth path doing its
                        // job; the flat one is the cel branch at the top.
                        let style = shade(gc, nearS, 1, edgeTone(), (l0v + l1v) / 2);
                        if (canGrad2 && Math.abs(l0v - l1v) * edgeTone() * 255 > 3) {
                            const x0 = (A[s][0] + B[s][0]) / 2;
                            const y0 = (A[s][1] + B[s][1]) / 2;
                            const x1 = (A[s + 1][0] + B[s + 1][0]) / 2;
                            const y1 = (A[s + 1][1] + B[s + 1][1]) / 2;
                            if (Math.hypot(x1 - x0, y1 - y0) >= 1) {
                                try {
                                    const gr = ctx.createLinearGradient(x0, y0, x1, y1);
                                    gr.addColorStop(0, shade(gc, nearS, 1, edgeTone(), l0v));
                                    gr.addColorStop(1, shade(gc, nearS, 1, edgeTone(), l1v));
                                    style = gr;
                                } catch (err) { /* solid fallback */ }
                            }
                        }
                        ctx.fillStyle = style;
                        ctx.strokeStyle = style;
                        fillQuadSafe(A[s][0], A[s][1], A[s + 1][0], A[s + 1][1],
                            B[s + 1][0], B[s + 1][1], B[s][0], B[s][1]);
                    }
                };
                // Face orientations per sub-quad from the view-space z-signs
                // of the outward directions (+z is toward the viewer): the
                // slab is locally convex, so a face is visible iff its outward
                // normal points at the viewer, and an EDGE is visible iff at
                // least one adjacent face is. This is the classic hidden-edge
                // rule; nothing is chosen per station and nothing degenerates.
                // For fills the raw sign decides which face paints last; for
                // EDGES a small threshold keeps near-grazing faces (b.z ~ 0,
                // e.g. every face when looking straight down the helix axis)
                // from flickering marginal edges on and off - the silhouette
                // there is carried by the clearly-visible side bands.
                const bMid = [];
                const nMid = [];
                for (let s = 0; s + 1 < ns; s++) {
                    bMid.push((g.oB[s] + g.oB[s + 1]) / 2);
                    nMid.push((g.oN[s] + g.oN[s + 1]) / 2);
                }
                const quad = (a, b, c2, d) => {
                    ctx.beginPath();
                    ctx.moveTo(a[0], a[1]);
                    ctx.lineTo(b[0], b[1]);
                    ctx.lineTo(c2[0], c2[1]);
                    ctx.lineTo(d[0], d[1]);
                    ctx.lineTo(a[0], a[1]);
                    ctx.fill();
                };
                // A strip (side or face) fills as ONE closed path down the
                // piece: per-sub-quad quads leave an antialiasing seam at
                // every joint, and the lighter face painted underneath shows
                // through the seams as thin banded "internal planes". A
                // quarter-piece holds at most one fold, and a single
                // self-crossing cannot cancel under the nonzero fill rule.
                // Used by cel shading, where one flat tone covers the whole
                // strip so there is nothing for per-sub-quad splitting to buy.
                // Strokes as well as fills, matching fillQuadSafe, so a strip
                // is dilated the same ~0.5px and the depth-sorted order still
                // decides the shared rails.
                const pathStrip = (A, B) => {
                    ctx.beginPath();
                    ctx.moveTo(A[0][0], A[0][1]);
                    for (let s = 1; s < ns; s++) ctx.lineTo(A[s][0], A[s][1]);
                    for (let s = ns - 1; s >= 0; s--) ctx.lineTo(B[s][0], B[s][1]);
                    ctx.lineTo(A[0][0], A[0][1]);
                    ctx.fill();
                    ctx.stroke();
                };
                // Fills: all six surfaces of the slab are painted in one
                // depth-sorted pass at the end of this branch (see "SURFACE
                // ORDER WITHIN THE PIECE"), so the nearest of them - face,
                // thickness band, or cap - is the one painted last. Face
                // colours ramp smoothly with the piece's mean orientation so
                // grazing pieces converge to one mid-tone instead of flipping
                // bright/dark.
                // BACKFACE CULLING: the piece is a closed slab, so any
                // surface whose outward direction points away from the viewer
                // across the WHOLE piece is covered by the piece's own front
                // surfaces and can never be seen. Skipping it removes exactly
                // the paint that flashes when the depth order of overlapping
                // pieces swaps during rotation. Mixed/grazing surfaces still
                // draw (they carry the silhouette); the margin keeps a
                // surface alive until it is clearly turned away.
                // 0.12, not hairline: culling assumes the front faces
                // cover a culled face's projection exactly, but the strips
                // are POLYLINES - at extreme grazing the discretized front
                // strips undercover by a sliver and the culled thickness
                // face shows as a white gap along the rim. Keep any surface
                // alive until it is clearly turned away; a nearly-edge-on
                // extra face is sub-pixel overdraw at the side tone.
                const CULL_EPS = renderer._cullEps !== undefined ? renderer._cullEps : 0.12;
                let nMax = -2, nMin = 2, bMax = -2, bMin = 2;
                for (let s = 0; s < ns; s++) {
                    if (g.oN[s] > nMax) nMax = g.oN[s];
                    if (g.oN[s] < nMin) nMin = g.oN[s];
                    if (g.oB[s] > bMax) bMax = g.oB[s];
                    if (g.oB[s] < bMin) bMin = g.oB[s];
                }
                let showL = nMax > -CULL_EPS;        // left outward = +n
                let showR = nMin < CULL_EPS;         // right outward = -n
                let showTop = bMax > -CULL_EPS;      // top outward = +b
                let showBot = bMin < CULL_EPS;       // bottom outward = -b
                // A SLAB OF NO THICKNESS HAS NO EXTRA FACES. At thickness 0 the
                // +b and -b faces land on each other and the two thickness
                // bands and both caps have no area at all, so drawing them is
                // one fill painted twice over and four more that cover nothing.
                // Flat means flat: one face, no sides, no caps.
                const flatSlab = (() => {
                    for (let s2 = 0; s2 < ns; s2++) {
                        const a2 = Lp[s2]; const b2 = Lm[s2];
                        if (Math.hypot(a2[0] - b2[0], a2[1] - b2[1]) > 0.25) {
                            return false;                     // a quarter pixel
                        }
                    }
                    return true;
                })();
                if (flatSlab) {
                    // The two bands have no area, and the two faces are the SAME
                    // quad - so exactly one is drawn, and WHICH one is not a free
                    // choice. Top and bottom carry different colours (a helix's
                    // inner face is tinted pale, its outer face is not) and
                    // different shading, so picking the wrong one paints the
                    // inside of a helix in the outside's colour.
                    //
                    // Pick by the MEAN facing over the piece, which is the face
                    // actually turned toward the viewer. `if (showTop) showBot =
                    // false` was wrong twice over: on a curved piece oB straddles
                    // zero, so both flags are set and top won regardless of which
                    // way the piece really faced; and CULL_EPS keeps a face alive
                    // until it is CLEARLY turned away, which is right when both
                    // faces are drawn and wrong when it decides between them.
                    showL = false;
                    showR = false;
                    let bSum = 0;
                    for (let s2 = 0; s2 < ns; s2++) bSum += g.oB[s2];
                    showTop = bSum >= 0;
                    showBot = !showTop;
                }
                // ARROWHEAD BARB FACES. Backface culling assumes a surface's
                // outward direction is +-n or +-b, which holds for a plain slab.
                // A head breaks that: the barb step is a quad whose two stations
                // sit at the SAME point with different widths, so it lies in the
                // cross-section plane and its normal is the TANGENT - yet it
                // rides in the TOP/BOTTOM strips and is culled by oB, which says
                // nothing about whether it faces the viewer. Hence barb faces
                // vanishing at some orientations.
                //
                // Only the two strips that carry it are forced. Forcing all four
                // was tried and is worse: it keeps the FAR thickness band alive,
                // and since those bands are white in this style, a twisted piece
                // whose averaged sort key puts the band last paints a white
                // stripe straight across the arrow's face. Side culling is what
                // suppresses that, so it has to stay.
                if (g.arrow) { showTop = true; showBot = true; }
                // Terminal cross-section rim: the ORIGINAL piece-attached
                // understroke, drawn just before this piece's fills. Under
                // the fills it yields to everything painted later (loops at
                // the junction included), which reads correctly at element
                // ends - the depth-sorted thin-rim experiment either crossed
                // the junction loop (up-bias) or hollowed out (down-bias).
                if (paintInkW && (g.capStart || g.capEnd)) {
                    ctx.strokeStyle = inkOf(g, nearS);
                    // The rim is the outline's own width - no separate floor,
                    // which used to hold it at 2px while the outline thinned
                    // past it and left every element end heavier than its sides.
                    ctx.lineWidth = outlineW;
                    ctx.lineCap = 'butt';
                    ctx.lineJoin = 'round';
                    ctx.beginPath();
                    if (g.capStart) {
                        ctx.moveTo(Lp[0][0], Lp[0][1]);
                        ctx.lineTo(Lm[0][0], Lm[0][1]);
                        ctx.lineTo(Rm[0][0], Rm[0][1]);
                        ctx.lineTo(Rp[0][0], Rp[0][1]);
                        ctx.lineTo(Lp[0][0], Lp[0][1]);
                    }
                    if (g.capEnd) {
                        const e = ns - 1;
                        ctx.moveTo(Lp[e][0], Lp[e][1]);
                        ctx.lineTo(Lm[e][0], Lm[e][1]);
                        ctx.lineTo(Rm[e][0], Rm[e][1]);
                        ctx.lineTo(Rp[e][0], Rp[e][1]);
                        ctx.lineTo(Lp[e][0], Lp[e][1]);
                    }
                    ctx.stroke();
                }
                // Caps are CROSS-SECTION faces: light them by the chain
                // tangent (their outward normal), not the side bands' n -
                // the mismatch flashed dark quads as pieces turned to face
                // the viewer.
                // caps exist only in the diving regime, where everything
                // converges to neutral - give them exactly that
                const capLum = () => soft(LIGHT_AMB + LIGHT_DIFF * 0.5);
                // Cap faces are EDGES too: the flat rim at a strand's blunt end
                // and the cross-section at the arrow tip are the same white card
                // as the thickness bands. Colouring them with the element colour
                // left a green end on an otherwise white-edged plate.
                const capCol = shade((rich && (g.ss === 'E' || g.naRung))
                    ? SHEET_EDGE_RGB : g.c,
                    nearS, 1, edgeTone(), capLum());
                // start cap outward = -T, end cap outward = +T
                const showCapStart = g.capStart && g.oT[0] < CULL_EPS;
                const showCapEnd = g.capEnd && g.oT[ns - 1] > -CULL_EPS;
                // INTERIOR CAP: when the chain tangent points nearly at (or
                // away from) the viewer, all four strips project edge-on -
                // they degenerate to the OUTLINE of the cross-section
                // rectangle and its interior goes unpainted (the missing
                // face inside a winding seen down the tube). Fill the
                // cross-section explicitly in that regime; where the strips
                // still have area, every sorted strip below paints after and
                // covers it (this is the one fill that is deliberately NOT
                // depth-sorted - it is a backstop for a hole, not a surface).
                // 0.85, not 0.6: the interior cap only needs to cover the
                // degenerate-projection hole near a TRUE dive (|oT| ~ 1).
                // Switching on at 0.6 painted neutral-toned patches all
                // along the flanks, phase-locked per winding - the "brighter
                // regions between residue boundaries" (measured: bright
                // bumps repeating at exactly the winding pitch).
                const capT = renderer._capT !== undefined ? renderer._capT : 0.85;
                if (Math.abs(g.oT[0]) > capT) {
                    ctx.fillStyle = capCol;
                    quad(Lp[0], Lm[0], Rm[0], Rp[0]);
                }
                if (Math.abs(g.oT[ns - 1]) > capT) {
                    ctx.fillStyle = capCol;
                    quad(Lp[ns - 1], Lm[ns - 1], Rm[ns - 1], Rp[ns - 1]);
                }
                let bAvg = 0;
                for (let s = 0; s < bMid.length; s++) bAvg += bMid[s];
                bAvg /= Math.max(1, bMid.length);
                let nAvg = 0;
                for (let s = 0; s < nMid.length; s++) nAvg += nMid[s];
                nAvg /= Math.max(1, nMid.length);
                // Face shade varies CONTINUOUSLY within the piece via a
                // linear gradient with stops from the per-station orientation.
                // A single per-piece tone makes each flank piece (mean
                // orientation ~0) a uniform mid-tone plane that pops against
                // both neighbours exactly where orientation changes fastest.
                // The SVG exporter has no gradients - solid mean tone there.
                // Lambert-style: each face's tone rises with how much it
                // faces the viewer and CONVERGES TO THE SIDE TONE (0.72) as
                // it goes edge-on. A grazing face is then the same colour as
                // the side band it physically merges with, so pieces whose
                // paint order shuffles at the flanks can no longer flash a
                // lighter plane over the dark band. The outer face peaks
                // brighter (1.0) than the inner face (0.92) to keep the
                // inside/outside depth cue.
                const faceTone = (b, k, isTop) => {
                    // facing ramp only (pale at grazing); light and inner
                    // shading are handled by the luminance term below
                    if (!lightOn) return 1;
                    const a = isTop ? b : -b;
                    const t = Math.min(1, Math.max(0, a / 0.4));
                    return soft(0.72 + 0.28 * t);
                };
                // DIRECTIONAL LIGHT + inner shadow: diffuse from the face
                // normal against the fixed light, then darkened toward
                // black by how much this face points into the backbone's
                // concavity - the inside of a helix reads in shadow at any
                // orientation.
                // CONVERGENCE PRINCIPLE, extended to lighting: overlapping
                // pieces at grazing constantly swap paint order, and any
                // tone difference between the two sheets flashes at every
                // swap (the choppy triangles). The facing ramp always
                // converged to one tone at grazing; the light must too -
                // blend each surface's lum to a NEUTRAL value as it turns
                // edge-on (b: viewer-facing amount 'a'), so any two grazing
                // surfaces are indistinguishable and swaps are invisible.
                const LUM_NEUTRAL = LIGHT_AMB + LIGHT_DIFF * 0.5;
                // ... and converge with DIVE too: when the chain tangent
                // points at/away from the viewer (|oT| -> 1), a piece's
                // caps, sides and faces all stack onto the same footprint,
                // and consecutive diving pieces micro-swap constantly - any
                // lum difference there flashes triangles (probe-verified:
                // every jumping pixel had |oT| ~ 0.93).
                const faceLum = (lb, k, isTop, a, t, innerMul) => {
                    // Two-sided on a base plate - see the note in the WebGL2
                    // port's faceLum: every plate in a duplex shares one axis,
                    // so an outward-only nL leaves the whole stack unable to
                    // highlight whenever that axis points away from the light.
                    const nLs = isTop ? lb : -lb;
                    const nL = g.naRung ? Math.abs(nLs) : nLs;
                    const inner = isTop ? k : -k;
                    let q = LIGHT_AMB + LIGHT_DIFF * Math.max(0, nL);
                    // inner shadow scales the diffuse AND the highlight, as it
                    // did when the two were one expression
                    const shadowF = inner > 0
                        ? 1 - innerShade * (innerMul === undefined ? 1 : innerMul)
                            * Math.min(1, inner)
                        : 1;
                    q *= shadowF;
                    // A FLAT CARD DOES NOT CONVERGE, so it is not damped.
                    // `w` fades a face as it turns edge-on, which is what stops
                    // a ribbon flashing at a paint-order swap. A base plate's
                    // normal points along the helix axis, so seen from the side
                    // - the usual view of a duplex - `a` is near zero and w
                    // collapses, taking the diffuse modelling and the highlight
                    // with it: the broad face sat at LUM_NEUTRAL whatever the
                    // Hilite slider said, while its thin edges still lit.
                    let w = g.naRung ? 1
                        : Math.min(1, Math.max(0, a) / 0.35)
                            * Math.min(1, Math.max(0, (1 - Math.abs(t)) / 0.3));
                    // DIFFUSE MODELLING - this is what the Shade slider scales.
                    const base = soft(LUM_NEUTRAL + (q - LUM_NEUTRAL) * w);
                    // HIGHLIGHT is a SEPARATE control (the Hilite slider) and is
                    // deliberately NOT scaled by Shade: shade 0 means flat,
                    // unmodelled colour, but a highlight is still wanted on top
                    // of it. It keeps its own two dampers, which are about
                    // stability rather than amount - the `w` convergence factor,
                    // so it fades at grazing and on dives instead of flashing at
                    // every paint-order swap (this is what LUM_NEUTRAL exists to
                    // prevent), and the inner shadow, so it cannot light up a
                    // face that points into the backbone.
                    const knee = rich ? RICH_HI_KNEE : HI_KNEE;
                    if (hiGain > 0 && nL > knee) {
                        return base + LIGHT_HI * hiGain
                            * ((nL - knee) / (1 - knee)) * w * shadowF;
                    }
                    return base;
                };
                let kAvg = 0;
                let lbAvg = 0;
                let tAvg = 0;
                for (let s = 0; s < ns; s++) {
                    kAvg += g.oK[s];
                    lbAvg += g.oLb[s];
                    tAvg += g.oT[s];
                }
                kAvg /= Math.max(1, ns);
                lbAvg /= Math.max(1, ns);
                tAvg /= Math.max(1, ns);
                // CEL SHADING (cartoonSmooth off): one flat tone per face
                // per piece, filled as a SINGLE strip path. The smooth path
                // below varies tone per sub-quad (and per station within it),
                // which is physically right but reads as an airbrushed render
                // rather than a cartoon. Flat tone is the whole point of the
                // cartoon look, so this is not a quality reduction - it is a
                // different target.
                // Uses the piece MEANS, so the tone still steps between
                // pieces (that is the cel banding), and pathStrip rather than
                // per-sub-quad quads because equal-toned neighbouring quads
                // still leave antialiasing seams that let the face underneath
                // show through as thin lines.
                // CEL LEVELS: flat-per-piece was not flat enough on its own.
                // Pieces are quarter-cut AND cut at every orientation fold,
                // so a 30-residue helix carries ~120 of them; one mean tone
                // each still stepped ~165 distinct colours down the ribbon,
                // which is visually a gradient however it is computed.
                // Quantizing tone and lum to a few levels collapses that to a
                // handful of bands per colour - the actual cartoon look.
                // Face tone painted PER SUB-QUAD, each with a two-stop
                // gradient whose endpoint tones come from the SHARED
                // stations: the tone field is then continuous across every
                // sub-quad AND piece boundary by construction. A single
                // per-piece gradient runs along the piece's chord axis, and
                // neighbouring pieces' axes twist ~25 deg apart - their
                // gradients disagreed along the slanted cross-section cut,
                // which parked a visible tone edge on the cut that jumped a
                // quarter-piece at a time under rotation.
                const paintFace = (isTop) => {
                    const A = isTop ? Lp : Lm;
                    const B = isTop ? Rp : Rm;
                    // TWO-TONE RIBBON: a palette may give an SS class a second
                    // colour for the ribbon's INNER face, so a helix reads dark
                    // on the outside of the spiral and pale on the inside the
                    // way Richardson hand-coloured them. Only in ss colouring -
                    // by chain or b-factor the ribbon is one colour by
                    // definition and a second hue would be a lie.
                    // Selected by CONCAVITY, not by isTop: which of Lp/Rp and
                    // Lm/Rm is the physical outside of the spiral depends on how
                    // the local frame came out for this piece, so keying off the
                    // top/bottom label put the dark face inward on some helices
                    // and outward on others. `inner` is the same frame-
                    // independent term faceLum uses to shade the concave face,
                    // which is why the shading was already right when the colour
                    // was not. On 1TIM the two rules disagree on 55% of helix
                    // pieces, which is what made the pale face land inside on
                    // some helices and outside on others.
                    // NOTE for anyone giving a palette an explicit inner
                    // colour per SS class - which one of them used to have: a
                    // helix curves hard enough for this call to be decisive
                    // (|kAvg| median 0.87, nothing below 0.02), but flat strands
                    // sit AT zero half the time, so an inner colour on E would
                    // pick a side from sign noise and flicker under rotation.
                    const inward = (isTop ? kAvg : -kAvg) > 0;
                    let fc = g.c;
                    if (inward) {
                        if (rich && g.ss === 'H' && !g.co) {
                            // no explicit two-tone in this palette: synthesise
                            // one by tinting toward white. NOT applied when the
                            // colour was set by hand (g.co): the tint is a heavy
                            // 0.68 toward white, so a picked colour came back
                            // washed out over most of a helix and did not look
                            // like the colour that was picked. A palette colour is
                            // a style choice and can be stylised; an explicit one
                            // is an instruction. Cached on the prim -
                            // paintFace runs per face per piece per frame, and
                            // g.c is fixed for the piece.
                            fc = g._cIn || (g._cIn = tintWhite(g.c, RICH_INNER_TINT));
                        }
                    }
                    // A pale inner hue already reads as "inside", so ease off
                    // the inner shadow on exactly the faces that got one -
                    // otherwise the two encode the same fact twice and the
                    // lighter face is dragged back toward mud.
                    const iMul = (fc === g.c) ? 1 : BACK_INNER_SHADE;
                    if (cel) {
                        // quantized over each term's own full range: tone is
                        // the 0.72-1.0 facing ramp, lum spans the shadowed
                        // floor up to the highlight ceiling. Both ends track
                        // iMul: quantizing over a range the value cannot reach
                        // wastes levels and steps the face coarsely, and a
                        // range the value OVERSHOOTS clips the lift away
                        // entirely. Only one end ever moves - a positive iMul
                        // lowers the floor, a negative one raises the ceiling.
                        const tv = quant(faceTone(bAvg, kAvg, isTop), edgeTone(), 1);
                        const lv = quant(faceLum(lbAvg, kAvg, isTop,
                            isTop ? bAvg : -bAvg, tAvg, iMul),
                            soft(LIGHT_AMB * (1 - innerShade * Math.max(0, iMul))),
                            soft(1 + innerShade * Math.max(0, -iMul))
                                + LIGHT_HI * hiGain);
                        const flat = shade(fc, nearS, 1, tv, lv);
                        ctx.fillStyle = flat;
                        ctx.strokeStyle = flat;
                        ctx.lineWidth = 1;
                        ctx.lineJoin = 'round';
                        pathStrip(A, B);
                        return;
                    }
                    // Export: the whole strip as one path, tones as stops of
                    // one gradient along the piece's chord axis. Stop offsets
                    // are each station midpoint projected onto that axis,
                    // clamped monotonic; consecutive identical colours are
                    // merged. Pieces are quarter-interval cuts (~25 deg of
                    // turn), so the straight axis is a close approximation.
                    if (svgStrips && ns >= 2) {
                        // export culling, per STRIP - see the identical guard above.
                        if (exportHidden) {
                            let anyVis = false;
                            for (let s = 0; s < ns && !anyVis; s++) {
                                if (!exportHidden(A[s]) || !exportHidden(B[s])) anyVis = true;
                            }
                            if (!anyVis) return;
                        }
                        const x0 = (A[0][0] + B[0][0]) / 2;
                        const y0 = (A[0][1] + B[0][1]) / 2;
                        const x1 = (A[ns - 1][0] + B[ns - 1][0]) / 2;
                        const y1 = (A[ns - 1][1] + B[ns - 1][1]) / 2;
                        const axL2 = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0);
                        if (axL2 > 1) {
                            const stops = [];
                            let prevOff = 0;
                            for (let s = 0; s < ns; s++) {
                                const mx = (A[s][0] + B[s][0]) / 2 - x0;
                                const my = (A[s][1] + B[s][1]) / 2 - y0;
                                let off = (mx * (x1 - x0) + my * (y1 - y0)) / axL2;
                                off = Math.max(prevOff, Math.min(1, off));
                                off = Math.round(off * 1000) / 1000;
                                stops.push([off, shade(fc, nearS, 1,
                                    faceTone(g.oB[s], g.oK[s], isTop),
                                    faceLum(g.oLb[s], g.oK[s], isTop,
                                        isTop ? g.oB[s] : -g.oB[s], g.oT[s], iMul))]);
                                prevOff = off;
                            }
                            // near-constant strips need no gradient def at all
                            const th = stopsThin(stops);
                            const uni = th.every((st) => st[1] === th[0][1]);
                            let style2 = th[0][1];
                            if (!uni) {
                                const gr = ctx.createLinearGradient(x0, y0, x1, y1);
                                for (const st of th) gr.addColorStop(st[0], st[1]);
                                style2 = gr;
                            }
                            ctx.fillStyle = style2;
                            ctx.strokeStyle = style2;
                            ctx.lineWidth = 1;
                            pathStrip(A, B);
                            return;
                        }
                        // degenerate axis (piece seen end-on): sub-quads below
                    }
                    const canGrad = !!ctx.createLinearGradient;
                    for (let s = 0; s + 1 < ns; s++) {
                        const t0v = faceTone(g.oB[s], g.oK[s], isTop);
                        const l0v = faceLum(g.oLb[s], g.oK[s], isTop,
                            isTop ? g.oB[s] : -g.oB[s], g.oT[s], iMul);
                        const t1v = faceTone(g.oB[s + 1], g.oK[s + 1], isTop);
                        const l1v = faceLum(g.oLb[s + 1], g.oK[s + 1], isTop,
                            isTop ? g.oB[s + 1] : -g.oB[s + 1], g.oT[s + 1], iMul);
                        // solid MIDPOINT colour by default (continuous
                        // limit; adjacent sub-quads share stations so no
                        // banding accumulates). Gradient objects are
                        // expensive - build one only when the endpoints
                        // differ VISIBLY (> ~3 RGB units over the ~5px
                        // sub-quad).
                        let style = shade(fc, nearS, 1,
                            (t0v + t1v) / 2, (l0v + l1v) / 2);
                        if (canGrad
                            && Math.abs(t0v * l0v - t1v * l1v) * 255 > 3) {
                            const x0 = (A[s][0] + B[s][0]) / 2;
                            const y0 = (A[s][1] + B[s][1]) / 2;
                            const x1 = (A[s + 1][0] + B[s + 1][0]) / 2;
                            const y1 = (A[s + 1][1] + B[s + 1][1]) / 2;
                            if (Math.hypot(x1 - x0, y1 - y0) >= 1) {
                                try {
                                    const gr = ctx.createLinearGradient(x0, y0, x1, y1);
                                    gr.addColorStop(0, shade(fc, nearS, 1, t0v, l0v));
                                    gr.addColorStop(1, shade(fc, nearS, 1, t1v, l1v));
                                    style = gr;
                                } catch (err) { /* solid fallback */ }
                            }
                        }
                        ctx.fillStyle = style;
                        ctx.strokeStyle = style;
                        ctx.lineWidth = 1;
                        ctx.lineJoin = 'round';
                        fillQuadSafe(A[s][0], A[s][1], A[s + 1][0], A[s + 1][1],
                            B[s + 1][0], B[s + 1][1], B[s][0], B[s][1]);
                    }
                };
                // SURFACE ORDER WITHIN THE PIECE: the slab is a closed body,
                // so its own surfaces paint back-to-front by how much each
                // outward direction points at the eye. oN/oB/oT are all unit
                // dot products against the SAME eye ray (evalSlab), so the
                // six keys below are directly comparable: top +bAvg, bottom
                // -bAvg, left +nAvg, right -nAvg, start cap -oT[0], end cap
                // +oT[last]. Ascending order = most-turned-away first.
                //
                // This used to be positional: both side bands, then the caps,
                // then the two faces ordered by bAvg alone. That hard-codes
                // "a wide face is always nearer than a thickness band", which
                // is false for a large part of every helix winding (the
                // ribbon twists ~100 deg per residue, so |oN| > |oB| often).
                // A convex body's visible faces tile without overlap, so the
                // order would not matter if the projection were exact - but
                // three things make neighbouring surfaces overlap for real:
                // CULL_EPS deliberately keeps turned-away surfaces drawing,
                // fillQuadSafe strokes each sub-quad at lineWidth 1 (so every
                // strip is dilated ~0.5px past its polygon), and a twisted
                // slab is a saddle, not convex. The last painter wins in that
                // overlap band, so a fixed order let the wide face eat ~1px
                // of the thickness band along its whole length whenever the
                // band was actually in front.
                //
                // Sign-fold cutting (see cutSet above) splits pieces wherever
                // oN or oB changes sign, so within one piece each key holds a
                // constant sign and the per-piece mean is an honest key, not
                // an average over a fold.
                const surfaces = [];
                if (showTop) surfaces.push([bAvg, () => paintFace(true)]);
                if (showBot) surfaces.push([-bAvg, () => paintFace(false)]);
                if (showL) surfaces.push([nAvg, () => paintSide(Lp, Lm, 1)]);
                if (showR) surfaces.push([-nAvg, () => paintSide(Rp, Rm, -1)]);
                if (showCapStart) surfaces.push([-g.oT[0], () => {
                    ctx.fillStyle = capCol;
                    quad(Lp[0], Lm[0], Rm[0], Rp[0]);
                }]);
                if (showCapEnd) surfaces.push([g.oT[ns - 1], () => {
                    ctx.fillStyle = capCol;
                    quad(Lp[ns - 1], Lm[ns - 1], Rm[ns - 1], Rp[ns - 1]);
                }]);
                surfaces.sort((s1, s2) => s1[0] - s2[0]);
                for (const s of surfaces) s[1]();
            } else if (g.kind === 'ribStroke') {
                if (paintInkW) {
                    ctx.strokeStyle = inkOf(g, near);
                    ctx.lineWidth = inkW;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    strokePath(g.pts);
                }
            } else if (g.kind === 'tube') {
                const lw = Math.max(1.5, g.tubeA * 2 * scale * g.pe);
                if (paintInkW) {
                    const ink = inkOf(g, near);
                    ctx.lineCap = 'butt';
                    ctx.strokeStyle = ink;
                    ctx.lineWidth = lw + outlineW;
                    strokePath(g.pts);
                    const r = (lw + outlineW) / 2;
                    const last = g.pts.length - 1;
                    if (capAt(g, g.joints[0])) blackCap(g.pts[0][0], g.pts[0][1], r, ink);
                    if (capAt(g, g.joints[1])) blackCap(g.pts[last][0], g.pts[last][1], r, ink);
                }
                // BUTT caps for the banded path. Round caps extend half a
                // line width PAST each endpoint, so the next tube's
                // full-width shadow band reached backwards over the previous
                // tube's highlight and chopped the stripe into dashes at
                // every residue - the depth sort draws the two tubes at
                // different times, so the overlap is not self-covering the
                // way a single-tone stroke was. Butt caps abut exactly at the
                // shared knot instead. (The single-stroke fallback below
                // keeps round caps: one tone per tube means overlap is
                // invisible there, and free run-ends want the rounding.)
                // CYLINDER SHADING. A tube is radially symmetric, so its
                // cross-section shading is fully determined by the light's
                // component PERPENDICULAR to the tube on screen - no surface
                // normals needed in the primitive (it carries none). Paint
                // the full width at the shadow tone, then progressively
                // narrower strokes offset toward the light at brighter
                // tones: nested bands across the tube, which is the standard
                // comic treatment and reuses the same cel levels the ribbon
                // faces use. Falls back to the old flat stroke when the light
                // is off or the tube is too thin for bands to resolve.
                strokeRound(g.pts, lw, g.c, near, LOOP_DIM, g.ext);
            } else if (g.kind === 'line') {
                const pts = g.pts.map((q2) => [q2[0], q2[1]]);
                if (paintInkW || g.sel) {
                    const ink = g.sel ? SELECTION_INK_CSS : inkOf(g, near);
                    ctx.lineCap = 'butt';
                    ctx.strokeStyle = ink;
                    ctx.lineWidth = g.w + (g.sel
                        ? Math.max(paintInkW, SELECTION_INK_WIDTH * 2) : paintInkW);
                    strokePath(pts);
                    const r = ctx.lineWidth / 2;
                    // only the run's own ends can be free ends
                    if (capAt(g, g.joints[0])) blackCap(g.x1, g.y1, r, ink);
                    if (capAt(g, g.joints[1])) blackCap(g.x2, g.y2, r, ink);
                }
                // What reaches here is a contact - an annotation drawn over
                // the structure, which stays flat and bright because lighting
                // one makes it read as another bond - or a bond whose box could
                // not be built (a zero-length or unprojectable one), which is
                // better as a plain stroke than as nothing.
                ctx.lineCap = 'round';
                ctx.strokeStyle = g.flat
                    ? `rgb(${g.c.r},${g.c.g},${g.c.b})`
                    : shade(g.c, near, 1);
                ctx.lineWidth = g.w;
                strokePath(pts);
            } else if (g.kind === 'joint') {
                // The polygon a mitred junction leaves in the middle, above and
                // below. Its edges are all shared with the legs' own faces, so
                // none of them is ever a silhouette and it carries no ink of
                // its own - it is simply the top of the joint.
                const nearS = nearOf(g.z);
                // Same material as the legs it bridges, so the same rule: no
                // facing wash. A joint lies between two sticks that keep their
                // full tone, and fading only this one toward the paper as the
                // junction turns edge-on made it read as a hole between them.
                const tv = 1;
                let qv = LIGHT_AMB + LIGHT_DIFF * Math.max(0, g.nl);
                if (hiGain > 0 && g.nl > HI_KNEE) {
                    qv += LIGHT_HI * hiGain * (g.nl - HI_KNEE) / (1 - HI_KNEE);
                }
                if (cel) {
                    qv = quant(qv, LIGHT_AMB,
                        LIGHT_AMB + LIGHT_DIFF + LIGHT_HI * hiGain);
                }
                // ONE FLAT COLOUR, where the prim asks for it. A contact is an
                // annotation: it is drawn as a solid so that it can attach to
                // the ribbon's face and be occluded properly, but it is not
                // MADE of anything, and lighting it gives it a material and a
                // direction it should not have. Unlit, a cylinder reads as a
                // single bright tie whose outline happens to be round - which
                // is the flat stroke it replaced, with the ends trimmed to the
                // surfaces it joins.
                const body = g.unlit ? rgbCss(g.c)
                    : shade(g.c, nearS, 1, tv, soft(qv));
                ctx.fillStyle = body;
                ctx.strokeStyle = body;
                ctx.lineWidth = 1;
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(g.q[0][0], g.q[0][1]);
                for (let k2 = 1; k2 < g.q.length; k2++) {
                    ctx.lineTo(g.q[k2][0], g.q[k2][1]);
                }
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            } else if (g.kind === 'stickFace') {
                // ONE FACE OF A LIGAND BOND, lit the way a ribbon face is lit -
                // same shade(), same facing ramp, same response to the Shade
                // and Hilite controls - so a ligand is made of the same
                // material as the structure it sits in.
                //
                // NOTHING HERE DRAWS INK. Every line a stick carries comes from
                // the silhouette curves emitted when its box was built. In
                // particular there is no cross-section rim: that stroke is what
                // ruled a line across every stick in the previous attempt.
                if (!g.draw) continue;
                const nearS = nearOf(g.z);
                // NO FACING WASH. The ribbon fades toward the paper as it turns
                // edge-on, which is what makes a ribbon look thin and airy. A
                // stick is a solid rod, and its SIDE faces are near edge-on at
                // every angle - so that same ramp bleaches precisely the faces
                // that should read as the shaded sides, and the stick loses its
                // dark side and its depth with it. A solid keeps its full tone
                // and lets the light alone decide how dark a face is.
                const tv = 1;
                let qv = LIGHT_AMB + LIGHT_DIFF * Math.max(0, g.nl);
                if (hiGain > 0 && g.nl > HI_KNEE) {
                    qv += LIGHT_HI * hiGain * (g.nl - HI_KNEE) / (1 - HI_KNEE);
                }
                if (cel) {
                    qv = quant(qv, LIGHT_AMB,
                        LIGHT_AMB + LIGHT_DIFF + LIGHT_HI * hiGain);
                }
                const body = shade(g.c, nearS, 1, tv, soft(qv));
                ctx.fillStyle = body;
                // stroked in its own colour at 1px, like the base plates: two
                // abutting fills otherwise let the paper through as a hairline,
                // which on a box reads as a ruled crease
                ctx.strokeStyle = body;
                ctx.lineWidth = 1;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'butt';
                ctx.beginPath();
                ctx.moveTo(g.q[0][0], g.q[0][1]);
                for (let k2 = 1; k2 < g.q.length; k2++) ctx.lineTo(g.q[k2][0], g.q[k2][1]);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            } else { // dot
                if (paintInkW || g.sel) {
                    const ow = g.sel
                        ? Math.max(paintInkW, SELECTION_INK_WIDTH * 2) : paintInkW;
                    ctx.beginPath();
                    ctx.arc(g.x1, g.y1, g.r + ow / 2, 0, Math.PI * 2);
                    ctx.fillStyle = g.sel ? SELECTION_INK_CSS : inkOf(g, near);
                    ctx.fill();
                }
                // A lone atom is the one thing here with no axis, so it stays
                // round: a box drawn for it would take its roll from nowhere
                // and read as a die rolled onto the page.
                fillRound(g.x1, g.y1, g.r, g.c, near, 1, LIGAND_MODEL);
            }
        }
        if (anim) ctx.restore();   // end of the off-register colour layer

        if (renderer._dumpInk) {
            renderer._inkDump = prims
                .filter((g) => g.kind === 'ribStroke')
                .map((g) => ({ z: +g.z.toFixed(2), pts: g.pts.map((q) => [+q[0].toFixed(1), +q[1].toFixed(1)]) }));
        }
        if (renderer._inkDebug) {
            ctx.strokeStyle = 'rgb(255,0,0)';
            ctx.lineWidth = 0.8;
            ctx.lineCap = 'butt';
            for (const g of prims) {
                if (g.kind === 'ribStroke') strokePath(g.pts);
            }
        }

        // --- HIDDEN-LINE INK PASS (CAD-style exact vector visibility) ---
        // Ink is drawn LAST, on top of every fill, so paint order can never
        // erase or leak a line. Visibility is computed geometrically: an
        // edge segment draws iff its corner is self-visible (orientation
        // test at collection) AND no other surface covers its midpoint at a
        // clearly nearer depth. Occluders are the slab sub-quads and tube
        // capsules, indexed in a screen-space grid so each query touches a
        // handful of candidates. Pure vector: fast, and SVG-exportable.
        if (perfectInk && inkWanted && inkCurves.length) {
            const _pt = () => (typeof performance !== 'undefined' ? performance.now() : 0);
            const _ph = renderer._phase;
            if (_ph) _ph.inkStart = _pt();
            // Occluder grid pitch, sized from the occluder COUNT rather than
            // fixed. A fixed pitch cannot win at both ends: coarse cells pile
            // unrelated occluders into every list (measured 4284 per cell and
            // 99.85% bounding-box rejects at 10000 residues, which is what made
            // the ink pass scale ~n^1.8), while a fixed fine pitch pays for a
            // huge mostly-empty grid on small inputs. Target a few occluders
            // per cell and let density pick the pitch.
            // OCCLUSION BACKEND. 'grid' (default) is the exact analytic test.
            // 'zbuf' rasterises every occluder into a depth buffer once, making
            // a visibility query a single array lookup. Opt in with
            // renderer._inkMode = 'zbuf'.
            //
            // The zbuf path is much faster at what it does: the grid path
            // spends most of a large frame in the query loop - measured at
            // 10000 residues, 515 ms of 1093 ms, doing 68.5 M occluder scans
            // for 271 k queries, i.e. 253 scans per query, and that ratio GROWS
            // with n (29 -> 79 -> 76 -> 150 -> 253 across 500..10000). The
            // adaptive cell pitch does not fix it: cells are sorted far-to-near
            // and the loop breaks at the first occluder that is not nearer, but
            // in a dense structure most surfaces genuinely ARE nearer, so the
            // break never fires and every query walks its whole list.
            // Rasterising is linear in covered pixels instead. Ink output stays
            // vector either way (SVG-safe) - only the visibility TEST changes.
            //
            // It is NOT the default because of where the win lands. Measured:
            //   - ink pass 3-5x faster (ribosome 356 -> 143 ms), but the ink
            //     pass is only ~28% of a real frame, so end to end it is 1.20x
            //     on 4UG0 and 1.2x on the nucleic set. The 1.8x on synthetic
            //     10000-residue chains is not representative - those render as
            //     sub-pixel-thin ribbons where ink dominates.
            //   - a depth buffer answers at pixel resolution where the analytic
            //     test answers exactly at the query point, so ~5-12% of drawn
            //     pixels differ and outline segments flip 2x as often between
            //     nearly identical views (churn 3.9 vs 1.9 per 1000 segments
            //     per 0.02 deg). That is visible as flickering outlines.
            //   - the speedup lands on every frame now that there is no
            //     gesture downgrade, but so does the flicker, and a wrong
            //     outline is more noticeable than a slower one.
            // Slope bias and sample filtering were both tuned against this
            // (see BIAS_K and hiddenZBilinear); neither closes the gap, because
            // the error is quantisation, not bias or noise.
            const inkMode = renderer._inkMode || 'grid';
            const useZBuf = inkMode !== 'grid';
            let CELL;
            if (typeof renderer._inkCell === 'number' && renderer._inkCell > 0) {
                CELL = renderer._inkCell;
            } else {
                let occN = 0;
                for (const g of prims) {
                    if (g.kind === 'rib') {
                        const nsO = g.Lp.length;
                        occN += 4 * Math.max(0, nsO - 1)
                            + (g.capStart ? 1 : 0) + (g.capEnd ? 1 : 0);
                    } else if (g.kind === 'tube') {
                        occN += Math.max(0, g.pts.length - 1);
                    }
                }
                const target = renderer._inkTarget > 0 ? renderer._inkTarget : 3;
                const area = Math.max(1, displayWidth * displayHeight);
                CELL = Math.round(Math.sqrt(area * target / Math.max(1, occN)));
                CELL = Math.max(2, Math.min(24, CELL || 24));
            }
            const gw = Math.max(1, Math.ceil(displayWidth / CELL));
            const gh = Math.max(1, Math.ceil(displayHeight / CELL));
            const grid = useZBuf ? null : new Array(gw * gh);

            // ---- depth buffer ------------------------------------------------
            // Stores the DEPTH ATTRIBUTE d (= pe under perspective, z under
            // ortho) of the nearest occluder at each pixel. d is what
            // interpolates linearly across a projected triangle - raw z does
            // not - which is the same projective invariant the analytic path
            // relies on, so both backends compare depths in identical terms.
            // Larger d is nearer. EMPTY marks "no occluder here".
            const SS = renderer._inkSS > 0 ? renderer._inkSS : 1;
            // Bias multiplier. The half-pixel minimum (k=1) is the theoretical floor
            // for "never self-occlude", but measured against the analytic path a
            // larger margin is strictly better on BOTH axes - fidelity and
            // flicker - because the query point is not the only thing sampled
            // coarsely: neighbouring surfaces land in the same pixel. Swept
            // k = 0,1,2,4,8 on three structures; both metrics improve to k=4 and
            // flatten after it.
            const BIAS_K = renderer._inkBias > 0 ? renderer._inkBias : 4;
            const ZW = Math.max(1, Math.ceil(displayWidth * SS));
            const ZH = Math.max(1, Math.ceil(displayHeight * SS));
            const EMPTY = -Infinity;
            let zbuf = null;
            if (useZBuf) {
                if (!renderer._zbuf || renderer._zbuf.length < ZW * ZH) {
                    renderer._zbuf = new Float32Array(ZW * ZH);
                }
                zbuf = renderer._zbuf;
                zbuf.fill(EMPTY, 0, ZW * ZH);
            }
            // Rasterise one triangle, keeping the nearest d per pixel. Standard
            // edge-function scan over the bounding box; the triangles here are
            // small (a slab sub-quad is a few pixels across), so the bbox is a
            // tight bound and there is no benefit to anything cleverer.
            const rasterTri = (p0, p1, p2) => {
                const x0 = p0[0] * SS; const y0 = p0[1] * SS;
                const x1 = p1[0] * SS; const y1 = p1[1] * SS;
                const x2 = p2[0] * SS; const y2 = p2[1] * SS;
                let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
                if (area > -1e-9 && area < 1e-9) return;
                // orient consistently so the inside test is one sign
                let a0 = p0; let a1 = p1; let a2 = p2;
                if (area < 0) { a1 = p2; a2 = p1; area = -area; }
                const bx0 = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
                const bx1 = Math.min(ZW - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
                const by0 = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
                const by1 = Math.min(ZH - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
                if (bx1 < bx0 || by1 < by0) return;
                const ax = a0[0] * SS; const ay = a0[1] * SS;
                const bxx = a1[0] * SS; const byy = a1[1] * SS;
                const cxx = a2[0] * SS; const cyy = a2[1] * SS;
                const da = persp ? a0[3] : a0[2];
                const db = persp ? a1[3] : a1[2];
                const dc = persp ? a2[3] : a2[2];
                const inv = 1 / area;
                // SLOPE-SCALED BIAS. The analytic path evaluates an occluder's
                // depth exactly AT the query point; a depth buffer can only
                // store it at the pixel CENTRE. On a slanted surface those
                // differ by up to half a pixel of depth gradient, which is
                // enough for an edge to be occluded by its OWN surface - and
                // the result was outlines dropping out all over the ribbon.
                // d is linear in screen space, so the minimum over a pixel is
                // exactly d(centre) - (|dd/dx| + |dd/dy|)/2. Store that: a
                // surface then never hides a point lying on itself, and still
                // hides anything genuinely behind it.
                const gx = ((db - da) * (cyy - ay) - (dc - da) * (byy - ay)) * inv;
                const gy = ((dc - da) * (bxx - ax) - (db - da) * (cxx - ax)) * inv;
                const bias = (Math.abs(gx) + Math.abs(gy)) * 0.5 * BIAS_K;
                for (let py = by0; py <= by1; py++) {
                    const sy = py + 0.5;
                    const row = py * ZW;
                    for (let px = bx0; px <= bx1; px++) {
                        const sx = px + 0.5;
                        const w0 = (bxx - ax) * (sy - ay) - (sx - ax) * (byy - ay);
                        if (w0 < 0) continue;
                        const w1 = (cxx - bxx) * (sy - byy) - (sx - bxx) * (cyy - byy);
                        if (w1 < 0) continue;
                        const w2 = (ax - cxx) * (sy - cyy) - (sx - cxx) * (ay - cyy);
                        if (w2 < 0) continue;
                        // barycentric: w1 weights a0, w2 weights a1, w0 weights a2
                        const d = (w1 * da + w2 * db + w0 * dc) * inv - bias;
                        const k = row + px;
                        if (d > zbuf[k]) zbuf[k] = d;
                    }
                }
            };
            // Capsule (round-capped thick segment), rasterised directly over its
            // bounding box with the same point-to-segment distance test the
            // analytic path used - so a tube occludes identically under both
            // backends, round joints included.
            const rasterCapsule = (aIn, bIn, rIn) => {
                const a = [aIn[0] * SS, aIn[1] * SS, aIn[2], aIn[3]];
                const b = [bIn[0] * SS, bIn[1] * SS, bIn[2], bIn[3]];
                const rr = rIn * SS;
                const bx0 = Math.max(0, Math.ceil(Math.min(a[0], b[0]) - rr - 0.5));
                const bx1 = Math.min(ZW - 1, Math.floor(Math.max(a[0], b[0]) + rr - 0.5));
                const by0 = Math.max(0, Math.ceil(Math.min(a[1], b[1]) - rr - 0.5));
                const by1 = Math.min(ZH - 1, Math.floor(Math.max(a[1], b[1]) + rr - 0.5));
                if (bx1 < bx0 || by1 < by0) return;
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const L2 = dx * dx + dy * dy;
                const invL2 = L2 > 1e-9 ? 1 / L2 : 0;
                const da = persp ? a[3] : a[2];
                const db = persp ? b[3] : b[2];
                const rr2 = rr * rr;
                // same half-pixel slope bias as rasterTri; depth varies only
                // along the segment, so the gradient is (db-da)/|segment|
                const segLen = Math.sqrt(L2);
                const bias = segLen > 1e-6
                    ? Math.abs(db - da) / segLen * 0.7071 * BIAS_K : 0;
                for (let py = by0; py <= by1; py++) {
                    const sy = py + 0.5;
                    const row = py * ZW;
                    for (let px = bx0; px <= bx1; px++) {
                        const sx = px + 0.5;
                        let t = ((sx - a[0]) * dx + (sy - a[1]) * dy) * invL2;
                        if (t < 0) t = 0; else if (t > 1) t = 1;
                        const ex = a[0] + t * dx - sx;
                        const ey = a[1] + t * dy - sy;
                        if (ex * ex + ey * ey >= rr2) continue;
                        const d = da + t * (db - da) - bias;
                        const k = row + px;
                        if (d > zbuf[k]) zbuf[k] = d;
                    }
                }
            };
            const addToGrid = (o, x0, y0, x1, y1) => {
                const c0 = Math.max(0, Math.floor(x0 / CELL));
                const r0 = Math.max(0, Math.floor(y0 / CELL));
                const c1 = Math.min(gw - 1, Math.floor(x1 / CELL));
                const r1 = Math.min(gh - 1, Math.floor(y1 / CELL));
                for (let r = r0; r <= r1; r++) {
                    for (let c = c0; c <= c1; c++) {
                        const k = r * gw + c;
                        (grid[k] || (grid[k] = [])).push(o);
                    }
                }
            };
            // Occluders carry their bbox and max depth so a query can
            // reject almost every candidate with one comparison.
            const addQuad = (q, gs) => {
                if (useZBuf) {
                    for (let k2 = 1; k2 + 1 < q.length; k2++) {
                        rasterTri(q[0], q[k2], q[k2 + 1]);
                    }
                    return;
                }
                let x0 = Infinity;
                let y0 = Infinity;
                let x1 = -Infinity;
                let y1 = -Infinity;
                let zM = -Infinity;
                for (const pq of q) {
                    if (pq[0] < x0) x0 = pq[0];
                    if (pq[0] > x1) x1 = pq[0];
                    if (pq[1] < y0) y0 = pq[1];
                    if (pq[1] > y1) y1 = pq[1];
                    if (pq[2] > zM) zM = pq[2];
                }
                addToGrid({ q, x0, y0, x1, y1, zM, gs }, x0, y0, x1, y1);
            };
            // One round-capped thick segment, into whichever backend is active.
            const addCapsule = (a, b, rr) => {
                if (rr <= 0.5) return;
                if (useZBuf) { rasterCapsule(a, b, rr); return; }
                const x0 = Math.min(a[0], b[0]) - rr;
                const y0 = Math.min(a[1], b[1]) - rr;
                const x1 = Math.max(a[0], b[0]) + rr;
                const y1 = Math.max(a[1], b[1]) + rr;
                addToGrid({ seg: [a, b], r: rr, x0, y0, x1, y1,
                    zM: Math.max(a[2], b[2]) }, x0, y0, x1, y1);
            };
            for (const g of prims) {
                // Only what the drawing has REACHED can hide anything - ink
                // already on the paper must not be erased by a ribbon that has
                // not been drawn yet, or finished strokes wink out as the
                // drawing advances past them. Sketched geometry counts as well
                // as painted: while the pencil is still working there is no
                // colour anywhere, and an empty occluder set would let it draw
                // every hidden line on the far side of the form.
                const reached = Math.max(animWash > 0 ? animWash : -1, sketchMax);
                if (anim && chainU(g) > reached) continue;
                if (g.kind === 'rib') {
                    const strips = [
                        [g.Lp, g.Rp], [g.Lm, g.Rm], [g.Lp, g.Lm], [g.Rp, g.Rm],
                    ];
                    const nsO = g.Lp.length;
                    // terminal caps occlude too
                    if (g.capStart) {
                        addQuad([g.Lp[0], g.Lm[0], g.Rm[0], g.Rp[0]], g.gs0);
                    }
                    if (g.capEnd) {
                        addQuad([g.Lp[nsO - 1], g.Lm[nsO - 1],
                            g.Rm[nsO - 1], g.Rp[nsO - 1]],
                        g.gs0 + (nsO - 1) * g.gsStep);
                    }
                    for (const st of strips) {
                        const A = st[0];
                        const B = st[1];
                        for (let s = 0; s + 1 < nsO; s++) {
                            addQuad([A[s], A[s + 1], B[s + 1], B[s]],
                                g.gs0 + (s + 0.5) * g.gsStep);
                        }
                    }
                } else if (g.kind === 'tube') {
                    // slightly shrunk so tangential contact at junctions
                    // does not eat the ribbon's edge
                    const rr = (Math.max(1.5, g.tubeA * 2 * scale * g.pe)
                        + outlineW) / 2 - 1;
                    for (let j = 0; j + 1 < g.pts.length; j++) {
                        addCapsule(g.pts[j], g.pts[j + 1], rr);
                    }
                } else if (g.kind === 'line' && g.pts) {
                    // GENERIC SEGMENTS OCCLUDE: ligand bonds, explicit bonds,
                    // cyclic closures and contacts. They are painted as opaque
                    // strokes (width w, plus their own outline), but were never
                    // in the occluder set, so a backbone outline - inked last,
                    // on top of every fill, and tested only against what this
                    // grid holds - drew straight over any ligand standing in
                    // front of it. Same omission the base plates had.
                    //
                    // Contacts are included: nothing here is dashed, so a
                    // contact line covers what is behind it exactly like any
                    // other stroke. Radius matches the painted extent (stroke +
                    // outline), shrunk by 1 like tubes so a bond touching the
                    // ribbon does not eat the ribbon's own edge.
                    for (let k2 = 0; k2 + 1 < g.pts.length; k2++) {
                        addCapsule(g.pts[k2], g.pts[k2 + 1], (g.w + outlineW) / 2 - 1);
                    }
                } else if (g.kind === 'joint') {
                    for (let k2 = 1; k2 + 1 < g.q.length; k2++) {
                        addQuad([g.q[0], g.q[k2], g.q[k2 + 1], g.q[0]], g.gs0);
                    }
                } else if (g.kind === 'stickFace') {
                    // every face, turned away or not: a box's back faces and
                    // its caps at a shared atom are what hide the neighbouring
                    // box's buried edges
                    addQuad(g.q, g.gs0);
                } else if (g.kind === 'dot' && g.pA) {
                    // lone-position dot: a capsule of zero length is a disc
                    addCapsule(g.pA, g.pA, g.r + outlineW / 2 - 1);
                }
            }
            // Depth margin: big enough to ignore surfaces that merely abut
            // the edge (chain neighbours share its stations exactly), small
            // enough that a winding passing in front still hides it.
            // Each cell sorted far-to-near by max depth: a query walks
            // only the occluders NEARER than its own point and stops at the
            // first one that is not.
            if (_ph) _ph.inkGrid = _pt();
            if (!useZBuf) {
                for (let k = 0; k < grid.length; k++) {
                    if (grid[k] && grid[k].length > 1) {
                        grid[k].sort((a, b) => b.zM - a.zM);
                    }
                }
            }
            if (_ph) {
                _ph.inkSorted = _pt();
                let cells = 0; let occs = 0;
                if (grid) {
                    for (let k = 0; k < grid.length; k++) {
                        if (grid[k]) { cells++; occs += grid[k].length; }
                    }
                }
                _ph.inkCell = CELL; _ph.inkCells = cells; _ph.inkOccRefs = occs;
                _ph.inkQueries = 0;
            }
            const EPS_OCC = 0.15;
            // PERSPECTIVE-CORRECT depth: raw z does NOT interpolate linearly
            // across a projected triangle when the ortho slider adds
            // perspective - but pe = fl/(fl - z) DOES (the projective
            // invariant), and it is monotonic in z. Interpolate pe on
            // screen, convert back to z, compare in world units. Under
            // ortho pe is 1 everywhere, so z itself is the attribute.
            const dAt = (pt) => (persp ? pt[3] : pt[2]);
            const zOf = (D) => (persp ? fl - fl / D : D);
            const triHides = (p0, p1, p2, x, y, z, eps) => {
                const d = (p1[1] - p2[1]) * (p0[0] - p2[0])
                    + (p2[0] - p1[0]) * (p0[1] - p2[1]);
                if (d > -1e-9 && d < 1e-9) return false;
                const w0 = ((p1[1] - p2[1]) * (x - p2[0])
                    + (p2[0] - p1[0]) * (y - p2[1])) / d;
                if (w0 < 0) return false;
                const w1 = ((p2[1] - p0[1]) * (x - p2[0])
                    + (p0[0] - p2[0]) * (y - p2[1])) / d;
                if (w1 < 0 || w0 + w1 > 1) return false;
                const w2 = 1 - w0 - w1;
                const zo = zOf(w0 * dAt(p0) + w1 * dAt(p1) + w2 * dAt(p2));
                return zo > z + eps;
            };
            let _nq = 0; let _nscan = 0;
            const hiddenGrid = (x, y, z, gs) => {
                _nq++;
                const c = Math.floor(x / CELL);
                const r = Math.floor(y / CELL);
                if (c < 0 || r < 0 || c >= gw || r >= gh) return false;
                const list = grid[r * gw + c];
                if (!list) return false;
                const zCut = z + EPS_OCC;
                for (const o of list) {
                    if (o.zM <= zCut) break; // sorted: nothing nearer remains
                    _nscan++;
                    if (x < o.x0 || x > o.x1 || y < o.y0 || y > o.y1) continue;
                    const eps = EPS_OCC;
                    if (o.q) {
                        for (let k2 = 1; k2 + 1 < o.q.length; k2++) {
                            if (triHides(o.q[0], o.q[k2], o.q[k2 + 1],
                                x, y, z, eps)) return true;
                        }
                    } else {
                        const a = o.seg[0];
                        const b = o.seg[1];
                        const dx = b[0] - a[0];
                        const dy = b[1] - a[1];
                        const L2 = dx * dx + dy * dy;
                        let t = L2 > 1e-9
                            ? ((x - a[0]) * dx + (y - a[1]) * dy) / L2 : 0;
                        if (t < 0) t = 0;
                        else if (t > 1) t = 1;
                        const ex = a[0] + t * dx - x;
                        const ey = a[1] + t * dy - y;
                        if (ex * ex + ey * ey < o.r * o.r) {
                            const zo = zOf(dAt(a) + t * (dAt(b) - dAt(a)));
                            if (zo > z + eps) return true;
                        }
                    }
                }
                return false;
            };
            // Depth-buffer query: one lookup. Samples the pixel CONTAINING the
            // query point rather than filtering, because the points tested are
            // on silhouette edges - a filtered sample would mix in the
            // background on one side and bias every silhouette toward hidden.
            // The EPS_OCC margin does the rest: an edge lies on its own surface,
            // which wrote that pixel at the same depth, so a surface only hides
            // it by standing clearly in front.
            const hiddenZPoint = (xIn, yIn, z) => {
                _nq++;
                const x = xIn * SS;
                const y = yIn * SS;
                const px = x | 0;
                const py = y | 0;
                if (px < 0 || py < 0 || px >= ZW || py >= ZH) return false;
                const d = zbuf[py * ZW + px];
                if (d === EMPTY) return false;
                return zOf(d) > z + EPS_OCC;
            };
            // BILINEAR depth sample. Nearest-pixel sampling makes the stored
            // depth a STEP function of position, so as the view turns an edge
            // crosses a pixel boundary and its visibility flips - measured at
            // 2.5-4.7x the segment churn of the analytic path, which is the
            // outline flicker you see while dragging. Interpolating makes
            // depth continuous in x and y, so the decision moves smoothly with
            // the geometry instead of snapping.
            //
            // Empty samples (background) are DROPPED and the weights
            // renormalised rather than treated as infinitely far: letting a
            // background sample into the average would drag the interpolated
            // depth behind the query point near every silhouette and turn
            // hidden lines back on.
            const hiddenZBilinear = (xIn, yIn, z) => {
                _nq++;
                const fx = xIn * SS - 0.5;
                const fy = yIn * SS - 0.5;
                let x0 = Math.floor(fx);
                let y0 = Math.floor(fy);
                const tx = fx - x0;
                const ty = fy - y0;
                let acc = 0;
                let wsum = 0;
                for (let j = 0; j < 2; j++) {
                    const yy = y0 + j;
                    if (yy < 0 || yy >= ZH) continue;
                    const wy = j ? ty : 1 - ty;
                    if (wy <= 0) continue;
                    const row = yy * ZW;
                    for (let i = 0; i < 2; i++) {
                        const xx = x0 + i;
                        if (xx < 0 || xx >= ZW) continue;
                        const w = wy * (i ? tx : 1 - tx);
                        if (w <= 0) continue;
                        const d = zbuf[row + xx];
                        if (d === EMPTY) continue;
                        acc += w * d;
                        wsum += w;
                    }
                }
                if (wsum <= 0) return false;
                return zOf(acc / wsum) > z + EPS_OCC;
            };
            const hiddenZ = renderer._inkSample === 'point'
                ? hiddenZPoint : hiddenZBilinear;
            const hidden = useZBuf ? hiddenZ : hiddenGrid;
            ctx.lineWidth = inkW;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            // One batched path per ink colour. With tint 0 every curve inks
            // black and this collapses to the single path it always was;
            // with a tint the curves group by element colour instead.
            // Grouped by FADED colour: each curve's depth (mean z, the same
            // scale the fills use) picks one of 12 fade levels, so background
            // outlines pale with their fills instead of floating full-black
            // over ghost geometry. 12 levels keeps stroke batching coarse.
            const clipInk = !!(renderer.clipSlabOn && renderer.clipSlabOn());
            const bbHideInk = renderer.backboneHiddenSet
                ? renderer.backboneHiddenSet() : null;
            const inkGroups = new Map();
            const selKey = '\u0000sel';   // cannot collide with a colour string
            const sketchKey = '\u0000sketch';
            for (const cv of inkCurves) {
                // ...and the outline of a backbone the user hid, which is
                // collected nowhere near the prim list above
                if (bbHideInk && cv.bb
                    && bbHideInk.has(Math.round(cv.gs0
                        + (typeof cv.gsStep === 'number' ? cv.gsStep : 0)
                            * ((cv.pts ? cv.pts.length : 1) - 1) / 2))) continue;
                // Selected curves batch under one key and skip the depth fade -
                // an indicator that pales into the background is not doing its
                // job. Unselected curves are dropped entirely when the style
                // has no outline, so turning the outline off still leaves the
                // selection visible and nothing else.
                let key;
                if (cv.sel) {
                    key = selKey;
                } else if (!outlineW) {
                    // No ink in this style - but the pencil still traces these
                    // curves, so they are kept under a key that collects their
                    // visibility and strokes nothing.
                    if (!sketching) continue;
                    key = sketchKey;
                } else {
                    let zSum = 0;
                    for (const q2 of cv.pts) zSum += q2[2];
                    const nearQ = Math.round(nearOf(zSum / cv.pts.length) * 11) / 11;
                    key = inkColor(cv.c, inkTint, nearQ);
                }
                let arr = inkGroups.get(key);
                if (!arr) { arr = []; inkGroups.set(key, arr); }
                arr.push(cv);
            }
            let _strokeMs = 0;
            // NO INK WHILE A DRAWING IS UP. The look is watercolour over
            // pencil, and a dark outline is neither. The pass still runs: the
            // pencil's lines are collected from its visibility decisions, which
            // is the whole reason the two layers agree about what is visible.
            //
            // The selection indicator is exempt - it is an indicator, not ink,
            // and has to stay legible whatever the drawing is doing.
            for (const [inkCss, group] of inkGroups) {
            const isSel = inkCss === selKey;
            // Collected for the pencil only: this group exists because the
            // style has no ink at all, so nothing is stroked from it.
            const sketchOnly = inkCss === sketchKey;
            ctx.strokeStyle = isSel ? SELECTION_INK_CSS : inkCss;
            ctx.lineWidth = isSel ? SELECTION_INK_WIDTH : inkW;
            ctx.beginPath();
            for (const cv of group) {
                const pts = cv.pts;
                const vis = cv.vis;
                // sample every station once, plus each segment's midpoint;
                // a segment draws only if ALL THREE samples are visible -
                // half-hidden segments vanish rather than poke through
                // TRANSITION-REFINED sampling: midpoint-test every visible
                // segment, then endpoint-test ONLY the segments at
                // visibility boundaries (run ends, or a hidden neighbour).
                // Interior segments of a fully visible run never needed
                // their endpoint tests - both neighbours share them and
                // agree - so this makes the SAME decisions as the uniform
                // 3-sample rule wherever the outcome can differ, for about
                // a third of the queries.
                const nSeg = vis.length;
                const mids = new Array(nSeg).fill(false);
                for (let s = 0; s < nSeg; s++) {
                    if (!vis[s]) continue;
                    const mx = (pts[s][0] + pts[s + 1][0]) / 2;
                    const my = (pts[s][1] + pts[s + 1][1]) / 2;
                    // z at the SCREEN midpoint: pe interpolates linearly
                    // there, raw z does not (perspective)
                    const mz = zOf((dAt(pts[s]) + dAt(pts[s + 1])) / 2);
                    mids[s] = hidden(mx, my, mz,
                        cv.gs0 + (s + 0.5) * cv.gsStep);
                }
                const okAt = (s) => vis[s] && !mids[s];
                // OFF-CANVAS segments never draw. The occlusion grid treats
                // an off-grid query as visible, so ink from geometry kept by
                // the interval culling's safety pad ran past the border -
                // invisible on canvas (clipped), but real elements sticking
                // out of the SVG export's artboard. A segment crossing the
                // border is kept whole; only fully-outside ones drop.
                const mIn = 4 + outlineW;
                const onCanvas = (s) => {
                    const ax = pts[s][0]; const ay = pts[s][1];
                    const bx = pts[s + 1][0]; const by = pts[s + 1][1];
                    return !((ax < -mIn && bx < -mIn)
                        || (ax > displayWidth + mIn && bx > displayWidth + mIn)
                        || (ay < -mIn && by < -mIn)
                        || (ay > displayHeight + mIn && by > displayHeight + mIn));
                };
                // THE SLAB CUTS INK TOO. The fills are culled where the prims
                // are built; these curves are collected earlier and are not in
                // that list, so with a clip on the outline of everything it had
                // cut away went on being drawn - a wire drawing floating in the
                // space the ribbon used to fill. Asked per SEGMENT, on its own
                // depth, through the same clipAccepts the fills use: half
                // coverage, so a soft edge cuts the ink where it cuts them.
                const inSlab = (s) => !clipInk
                    || renderer.clipAccepts((pts[s][2] + pts[s + 1][2]) / 2);
                let open = false;
                for (let s = 0; s < nSeg; s++) {
                    // VISIBLE is the geometric question - is this piece of edge
                    // in sight - and is decided first, on its own. What each
                    // MEDIUM has reached is a separate question asked of it
                    // below, so the pencil and the pen make exactly the same
                    // lines and differ only in how far along they have got.
                    let visible = okAt(s) && onCanvas(s) && inSlab(s);
                    if (visible && (s === 0 || !okAt(s - 1)
                        || s + 1 >= nSeg || !okAt(s + 1))) {
                        if (hidden(pts[s][0], pts[s][1], pts[s][2],
                            cv.gs0 + s * cv.gsStep)
                            || hidden(pts[s + 1][0], pts[s + 1][1],
                                pts[s + 1][2],
                                cv.gs0 + (s + 1) * cv.gsStep)) visible = false;
                    }
                    // clamped for the same reason chainU is: a closure curve
                    // runs past the end of the chain
                    const uSeg = anim
                        ? Math.min(1, (cv.gs0 + (s + 0.5) * cv.gsStep)
                            / Math.max(1, n - 1))
                        : 0;
                    // THE PENCIL TRACES THE INK. An artist does not sketch the
                    // creases inside a form or the edges hidden behind it -
                    // they draw the outline they can see and then work into it.
                    // Collecting here, from the same `visible`, is what
                    // guarantees that: the two layers cannot disagree, because
                    // there is only one decision.
                    if (visible && sketching && uSeg <= sketchMax) {
                        sketchSegs.push(pts[s][0], pts[s][1],
                            pts[s + 1][0], pts[s + 1][1], uSeg, cv.id || 0, s);
                    }
                    const draw = visible && !sketchOnly;
                    // Optional visibility trace: one bit per ink segment, in a
                    // deterministic order, so a test can measure how many
                    // segments FLIP between two nearly identical views. That is
                    // the direct measure of outline flicker - a pixel diff is
                    // dominated by the geometry's own motion and cannot see it.
                    if (renderer._inkTrace) renderer._inkTrace.push(draw ? 1 : 0);
                    if (draw) {
                        if (!open) {
                            ctx.moveTo(pts[s][0], pts[s][1]);
                            open = true;
                        }
                        ctx.lineTo(pts[s + 1][0], pts[s + 1][1]);
                    } else {
                        open = false;
                    }
                }
            }
            const _s0 = _ph ? _pt() : 0;
            if (!sketchOnly && (!anim || isSel)) ctx.stroke();
            if (_ph) _strokeMs += _pt() - _s0;
            }

            // --- THE PENCIL --------------------------------------------------
            // One continuous line, drawn on exactly the edges the ink pass just
            // decided are visible - an artist draws neither the creases inside
            // a form nor the edges behind it.
            //
            // Full strength ahead of the wash, and SKETCH_UNDER of it behind:
            // paint dulls the graphite under it but does not remove it, and an
            // illustrator only rubs the pencil out at the end, once the ink is
            // down. That final erase is the ERASE window in animateDrawing.
            //
            // Drawn after the ink, which is both where its visibility comes
            // from and where it belongs: under-drawing shows THROUGH a
            // transparent wash, so painting it over the colour is what it
            // looks like from the front.
            if (sketching && sketchSegs.length) {
                ctx.save();
                ctx.strokeStyle = SKETCH_CSS;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.lineWidth = SKETCH_PX * pxScale;
                const wet = anim.wash;
                for (let band = 0; band <= SKETCH_BANDS; band++) {
                    // band 0 is everything the brush has already passed; the
                    // rest step up across SKETCH_ERASE_U to full strength.
                    const lo = (band === 0) ? -Infinity
                        : wet + ((band - 1) / SKETCH_BANDS) * SKETCH_ERASE_U;
                    const hi = (band === SKETCH_BANDS) ? Infinity
                        : wet + (band / SKETCH_BANDS) * SKETCH_ERASE_U;
                    ctx.globalAlpha = SKETCH_ALPHA
                        * (SKETCH_UNDER + (1 - SKETCH_UNDER) * band / SKETCH_BANDS);
                    ctx.beginPath();
                    let prevId = -1;
                    let prevS = -99;
                    for (let k = 0; k < sketchSegs.length; k += 7) {
                        const u = sketchSegs[k + 4];
                        if (u < lo || u >= hi) { prevId = -1; continue; }
                        const id = sketchSegs[k + 5];
                        const st = sketchSegs[k + 6];
                        const amp = SKETCH_WOBBLE_PX * pxScale;
                        const jx = (x, kk) => x + amp * wobble(kk, id);
                        const jy = (y, kk) => y + amp * wobble(id, kk);
                        if (id !== prevId || st !== prevS + 1) {
                            ctx.moveTo(jx(sketchSegs[k], st),
                                jy(sketchSegs[k + 1], st));
                        }
                        ctx.lineTo(jx(sketchSegs[k + 2], st + 1),
                            jy(sketchSegs[k + 3], st + 1));
                        prevId = id;
                        prevS = st;
                    }
                    ctx.stroke();
                }
                ctx.restore();
            }
            if (_ph) {
                _ph.inkStroke = _strokeMs;
                _ph.inkQueries = _nq;
                _ph.inkScans = _nscan;
                _ph.inkEnd = _pt();
            }
        }

        // --- COLOURED-PENCIL GRAIN -----------------------------------------
        // One composite pass over the finished frame, not a change to how any
        // surface is painted. That is the whole reason it is affordable: the
        // per-quad path is untouched, so this costs one fillRect regardless of
        // structure size.
        //
        // Multiply blending is what makes it read as pencil rather than as
        // dirt on the lens - it darkens where the tooth of the paper catches
        // pigment and leaves the highlights alone, which is how a pencil
        // actually lays down colour. The tile is generated once and cached; it
        // is deliberately low-contrast, because grain that is legible as
        // individual dots looks like noise rather than paper.
        //
        // RASTER ONLY. SVG export runs this same function through
        // SimpleCanvas2SVG, which has no pattern or composite support, so the
        // guard below skips the pass entirely and exports come out as clean
        // flat colour. That is a deliberate, graceful degradation rather than a
        // broken export - an SVG equivalent would need a filter primitive.
        const _pencilT0 = (renderer._phase && typeof performance !== 'undefined')
            ? performance.now() : 0;
        // SVG EXPORT: hand the amount to the serializer, which expresses the
        // same effect with an feTurbulence filter. The canvas compositing below
        // needs a real canvas and is skipped for this context.
        if (pencilWanted > 0.001 && ctx.getSerializedSvg) {
            ctx.pencilAmount = PENCIL_STRENGTH * pencilWanted;
        }
        if (realCtx && offCv) {
            const dw = offCv.width;
            const dh = offCv.height;
            let tile = paperTile(renderer);
            const gc = tile && (renderer._pencilGrain
                && renderer._pencilGrain.width === dw
                && renderer._pencilGrain.height === dh
                ? renderer._pencilGrain
                : (renderer._pencilGrain = document.createElement('canvas')));
            if (tile && gc) {
                gc.width = dw; gc.height = dh;
                const g2 = gc.getContext('2d');
                const oc = offCv.getContext('2d');
                if (g2 && oc) {
                    // grain sheet, then keep it only where the structure is
                    g2.setTransform(1, 0, 0, 1, 0, 0);
                    g2.globalCompositeOperation = 'source-over';
                    g2.globalAlpha = 1;
                    g2.clearRect(0, 0, dw, dh);
                    const pat = g2.createPattern(tile, 'repeat');
                    if (pat) {
                        // THE GRAIN DOES NOT ZOOM. The paper is the MEDIUM, not
                        // part of the subject: a drawing is made on one sheet at
                        // one tooth, and moving closer to it does not coarsen the
                        // tooth. So the tile is pinned to the canvas and stays
                        // fine at every zoom.
                        //
                        // It used to scale with the view, on the argument that a
                        // fixed speckle over a shrinking drawing reads as the
                        // noise coarsening rather than the drawing shrinking.
                        // That is true of the zoomed-OUT end and wrong at the
                        // other: following the zoom up multiplied the tile by as
                        // much as 3, and grain that coarse stops being paper and
                        // becomes a visible texture laid over the picture, which
                        // is the more damaging of the two. It also meant the same
                        // structure never looked like the same sheet twice.
                        //
                        // GRAIN_SCALE shrinks the whole texture, all three
                        // octaves together. Done here rather than by raising the
                        // octave grid counts because the finest octave already
                        // sits near one cell per 1.3 px on a 128 px tile - push
                        // that further and it degenerates into the per-pixel
                        // film static the octave construction exists to avoid.
                        // Minifying a texture is filtered by the browser, so it
                        // softens rather than aliases.
                        const zoomK = GRAIN_SCALE;
                        if (pat.setTransform && typeof DOMMatrix !== 'undefined') {
                            try {
                                const cx = dw / 2;
                                const cy = dh / 2;
                                pat.setTransform(new DOMMatrix([
                                    zoomK, 0, 0, zoomK,
                                    cx - zoomK * cx, cy - zoomK * cy,
                                ]));
                            } catch (err) { /* unscaled grain is still fine */ }
                        }
                        g2.fillStyle = pat;
                        g2.fillRect(0, 0, dw, dh);
                        g2.globalCompositeOperation = 'destination-in';
                        g2.drawImage(offCv, 0, 0);
                        // multiply it onto the structure; transparent grain
                        // outside the structure is a no-op, so paper is safe
                        oc.setTransform(1, 0, 0, 1, 0, 0);
                        oc.globalCompositeOperation = 'multiply';
                        oc.globalAlpha = PENCIL_STRENGTH * pencilWanted;
                        oc.drawImage(gc, 0, 0);
                        oc.globalAlpha = 1;
                        oc.globalCompositeOperation = 'source-over';
                    }
                }
            }
            // blit the finished structure onto the real canvas
            const prevT = realCtx.getTransform ? realCtx.getTransform() : null;
            realCtx.setTransform(1, 0, 0, 1, 0, 0);
            realCtx.drawImage(offCv, 0, 0);
            if (prevT) realCtx.setTransform(prevT.a, prevT.b, prevT.c, prevT.d, prevT.e, prevT.f);
            ctx = realCtx;
        }
        if (renderer._phase && typeof performance !== 'undefined') {
            renderer._phase.pencilMs = performance.now() - _pencilT0;
        }

        // --- populate the screen-position SoA arrays so the sequence viewer's
        //     hover/highlight machinery keeps working in cartoon mode ---
        if (painter.end) painter.end();
        if (renderer._phase) {
            renderer._phase.painted = (typeof performance !== 'undefined'
                ? performance.now() : 0);
        }
        renderer.screenFrameId++;
        const fid = renderer.screenFrameId;
        // THE BASE PLATES BELONG TO THIS FRAME AND NO OTHER. _naPick is a list
        // of screen-space outlines, filled by the pass above and read by
        // pickResidueAt; nothing else in the codebase writes it. The tube style
        // and the GPU cartoon path never run this pass, so without a stamp the
        // outlines from the last CPU cartoon frame simply stayed clickable -
        // through a style change, through a rotation that moved every plate,
        // and through switching every object off, where they were the last
        // things on an empty canvas still answering a click.
        renderer._naPickId = fid;
        if (renderer.screenX && renderer.screenX.length >= n) {
            // A SELECTED POSITION IS PROJECTED WHETHER OR NOT IT IS DRAWN. The
            // band over it is a UI indicator: it says where the selection is,
            // and a selection that has been hidden is the one that most needs
            // saying. Over nothing, if that is what is left there. The same
            // rule is in _projectForPicking and in the GPU's projectPositions.
            const marked = renderer.selectionInk
                ? renderer.selectionInk() : renderer.residueSelection;
            for (let i = 0; i < n; i++) {
                if (!vis(i) && !(marked && marked.has(i))) {
                    renderer.screenValid[i] = 0; continue;
                }
                // The DRAWN position, not the input one. These feed hover,
                // click-picking and the highlight overlay, and sheet flattening
                // moves a strand up to ~2 A (median 0.89 A on 1TIM) from where
                // its atom actually is - so picking against the raw coordinate
                // meant the ribbon you can see and the thing you hit were in
                // different places. `at()` falls back to the raw position for
                // anything the cartoon does not reposition.
                const v = at(i) || rotated[i];
                const A = project(v.x, v.y, v.z);
                if (!A) { renderer.screenValid[i] = 0; continue; }
                renderer.screenX[i] = A[0];
                renderer.screenY[i] = A[1];
                // BOTH RADII, FROM THE RENDERER'S OWN RULE. There are four
                // projections in this codebase - this one, _projectForPicking,
                // projectPosition and the GPU's - and each used to size a
                // position itself. They agreed until something was drawn at a
                // size none of them knew about: a lone atom is a ball of its
                // element's van der Waals radius, so the selection band over a
                // zinc was drawn from the width of a bond.
                //
                // wm 0.5 reproduces this line's own `base * 0.25 * pe` exactly,
                // so nothing else moves.
                const rr = renderer._positionRadiiPx
                    ? renderer._positionRadiiPx(i, baseLineWidthPixels, 0.5, A[3], scale)
                    : null;
                renderer.screenRadius[i] = rr
                    ? rr.pick : Math.max(2, baseLineWidthPixels * 0.25 * A[3]);
                if (rr && renderer.screenDrawRadius) {
                    renderer.screenDrawRadius[i] = rr.drawn;
                }
                renderer.screenValid[i] = fid;
            }
        }
        // WHAT A FULL-QUALITY FRAME COSTS, which is what the gesture degrade
        // decides on. Recorded ONLY when the ink actually ran: measuring every
        // frame would feed the decision its own result - drop the ink, the
        // frame gets fast, the ink comes straight back - and the outline would
        // flicker on and off through the drag.
        // A frame that REBUILT the caches is not a sample of what a gesture
        // frame costs. Secondary structure, pairing and sheet frames are keyed
        // on secKey, which a drag never changes, so that work happens once and
        // then never again for the whole gesture - but it lands in the same
        // timer. Measured at 900px, Richardson, ink on:
        //     1TIM (494 residues)  cold 46.0, 49.6, 38.3, 30.1, 23.1 ms
        //                          warm 11.2 ms median
        //     3A3A ( 86 residues)  cold 22.7 ms   warm  3.5 ms
        // A five-frame history cannot absorb this on its own, by either
        // estimator: the cold frames arrive CONSECUTIVELY, so right after any
        // cache invalidation EVERY sample in the window is cold - a median of
        // 38 ms, and a minimum still of 23. Hence the exclusion here rather
        // than a cleverer average. A drag started at that moment dropped the
        // outline on a 494-residue protein, and - because nothing is recorded
        // while the ink is off - stayed degraded for the entire gesture. A
        // drag started a second later read 11 ms and behaved perfectly. That
        // is the whole of the
        // reported "sometimes fine, sometimes not": the decision was reading the
        // cost of building the structure, not the cost of drawing it.
        // THE HISTORY BELONGS TO A STRUCTURE. It used to persist across loads,
        // so opening a ribosome and then a small protein left the small one
        // carrying the ribosome's 260 ms samples, and spent its first drags
        // degraded for no reason. (The minimum recovers from a stale history
        // in ONE cheap sample where the median needed three - but only once
        // such a sample is taken, and while the outline is off none is.)
        // Keyed on the object rather than on
        // secKey, which also changes per FRAME: a trajectory step is the same
        // structure at the same cost, and resetting there would mean the history
        // never fills during playback.
        // ...AND TO THE CANVAS, because cost is per pixel as much as per
        // structure. Measured: keeping the key on the object alone, a resize
        // from 900 to 1400 px - 2.4x the pixels - left the 900 px samples and
        // their median in place to decide 1400 px frames. Rounded to 100 px so
        // a drag on a resize handle does not clear the history every frame.
        {
            const px = Math.round((renderer.displayWidth || 0)
                * (renderer.displayHeight || 0) / 1e4);
            const costKey = `${renderer.currentObjectName}|${n}|${px}`;
            if (renderer._inkedMsKey !== costKey) {
                renderer._inkedMsKey = costKey;
                renderer._inkedMs = [];
                renderer._bareMs = [];
                renderer._lastInkedMs = undefined;
                renderer._lastBareMs = undefined;
                renderer._inkRatio = undefined;
                renderer._inkDegraded = false;
            }
        }
        if (!cacheRebuilt) {
            const _t1 = (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
            // THE MINIMUM OF THE LAST FIVE, not the last one and not their
            // median. A single frame is a bad estimate - the first render
            // after any change pays JIT and cache costs (measured 52 and 60 ms
            // on a structure that settles at 16), and a GC can land anywhere.
            //
            // The min rather than the median because EVERY SOURCE OF NOISE HERE
            // IS ONE-SIDED. JIT, a cold cache, a GC pause, another tab getting
            // the CPU - all of them only ever make a frame slower; nothing
            // makes one faster than the work it does. So the cheapest of the
            // last five IS the cost of the frame, and the dearer ones are that
            // cost plus an accident. The median only helps against noise that
            // goes both ways, and against a RUN of consecutive cold frames -
            // which is exactly how warm-up arrives - its median is cold too.
            // Measured, six 5-frame drags on 1UBQ with nothing else changing:
            // the median read 27.7 ms on the first and 6.1 on the second, so
            // the first drag dropped the outline and the rest kept it. That is
            // the whole of the reported "same structure, sometimes slow".
            //
            // It biases LOW, which is the safe direction: an underestimate
            // keeps the outline on for a frame or two more and is corrected by
            // the next sample, while an overestimate drops it for the whole
            // gesture and - with no inked frame left to measure - cannot be.
            //
            // BOTH KINDS OF FRAME ARE TIMED, into their own histories. Timing
            // only the inked ones was a one-way door: the moment the outline
            // came off, the estimate froze at whatever had just been measured -
            // and what had just been measured was the warm-up, since the drag's
            // first inked frames are its most expensive. On 1TIM those first
            // frames cost 27 ms against a 25 ms budget while frame 30 of the
            // same drag cost 9, so the estimate latched 3x high and the outline
            // stayed off for a gesture that could easily have carried it.
            // Timing the bare frames too means the estimate keeps tracking while
            // degraded and the outline can come back.
            const inked = renderer._inkRan;
            const hist = inked
                ? (renderer._inkedMs || (renderer._inkedMs = []))
                : (renderer._bareMs || (renderer._bareMs = []));
            hist.push(_t1 - _t0);
            if (hist.length > 5) hist.shift();
            let best = hist[0];
            for (let i = 1; i < hist.length; i++) {
                if (hist[i] < best) best = hist[i];
            }
            if (inked) renderer._lastInkedMs = best;
            else renderer._lastBareMs = best;
            // What the ink COSTS, as a multiplier on a bare frame. Measured at
            // 900px: 1BNA 2.6x, 3A3A 2.3x, 1TIM 1.6x - it falls as the structure
            // grows, because the fills grow faster than the silhouette does.
            // Taken from this structure's own two histories once both are real,
            // so it needs no constant.
            // Updated ONLY on a frame where the ink actually ran, so the two
            // sides of the ratio are contemporaneous. Recomputing it every frame
            // was circular and did nothing: while degraded the inked estimate
            // is frozen, so bare x (frozenInked / bare) is just frozenInked
            // again.
            // CLAMPED AT 1, because a frame that also draws the ink cannot
            // be cheaper than the same frame without it. Measured on one
            // structure across six drags the raw quotient read 4.26, 0.94,
            // 1.12, 0.94, 0.97 and 0.77 - the two sides are measured at
            // different moments, so a warm bare frame divided into a
            // cold inked one, or the reverse, gives a number the geometry
            // forbids. Below 1 it made the degraded estimate cheaper than the
            // bare frame it is built from, which brings the outline back and
            // the next cold frame takes it away again: the flip-flop.
            if (inked && renderer._lastBareMs > 0.01
                && renderer._inkedMs.length >= 3 && renderer._bareMs.length >= 3) {
                renderer._inkRatio = Math.max(1,
                    renderer._lastInkedMs / renderer._lastBareMs);
            }
        }
    }

    // extendSec is exported alongside makeSec/smoothSec so tests/ss_bench.js can
    // run the EXACT pipeline the renderer runs. Scoring a reimplementation
    // instead lets the two drift apart silently, which has happened before.
    // Per-style preset values, in ONE place. viewer-mol.js applies these on a
    // style switch so every control lands on that style's default instead of
    // keeping whatever the previous style left behind.
    const STYLE_DEFAULTS = {
        // Every style-owned control appears here, because a style SWITCH
        // re-asserts all of them: any key left out kept whatever the previous
        // style's slider was at - a high Outline set in cartoon silently
        // survived into richardson, whose panel hides the slider, leaving no
        // way to see or fix it.
        //
        // WIDTH IS THE SAME IN ALL THREE (PRESET_WIDTH). It is shared rather
        // than style-owned, so switching preset never moves it; _lineWidthUserSet
        // in viewer-mol.js still lets a real drag survive a switch, but with the
        // three values equal that latch no longer decides what you see.
        richardson: {
            width: PRESET_WIDTH,
            // Lighter ink than the plain ribbon's 2.0. A Richardson drawing is
            // pencil: the outline states the edge, it does not weigh it down.
            outlineWidth: 1.0,
            thickness: RICH_THICK_DEFAULT,
            outlineTint: RICH_TINT_DEFAULT,
            highlight: RICH_HILITE_DEFAULT,
            sheetFlat: SHEET_FLAT_DEFAULT,
            pencil: PENCIL_DEFAULT,
            arrows: true,
            detail: DETAIL_DEFAULT_N,
            fade: FADE_DEFAULT,
            // Richardson is pencil on paper: the modelling is lighter than a
            // rendered solid, and the inner face of a helix is meant to read
            // pale rather than shadowed.
            shade: 0.7,
            // Richardson shades smoothly: the drawings are pencil on paper,
            // graded rather than posterised, and the grain supplies the texture
            // that flat banding would otherwise have to.
            smooth: true,
        },
        cartoon: {
            width: PRESET_WIDTH,
            outlineWidth: 2.0,
            thickness: 0,
            outlineTint: 0,
            highlight: 1.8,
            sheetFlat: 0,
            pencil: 0,
            arrows: true,
            detail: DETAIL_DEFAULT_N,
            fade: FADE_DEFAULT,
            shade: 1,
            smooth: false,
        },
        // '3D': shaded solid geometry - a real slab, no ink, smooth shading
        // at full highlight, flattened sheets. A PRESET of the cartoon style
        // (like richardson), reachable from the Preset dropdown or
        // view(preset='3d'); unlike richardson it keeps the standard per-SS
        // geometry profile.
        '3d': {
            width: PRESET_WIDTH,
            outlineWidth: 0,
            // 1.0 A of slab - a half-thickness of 0.5, four times the ribbon's
            // usual RIBBON_TH_A. This preset is solid shaded geometry rather
            // than a drawing, and a thin slab under full highlight reads as a
            // lit sheet of paper rather than as an object.
            //
            // The control is a TOTAL thickness in Angstrom. It used to sit at
            // 0.5 so that the LIGAND sticks, which followed it, came out square;
            // that is no longer a consideration - a ligand keeps its own section
            // and only a preset asking for 0 reaches it - so this value now
            // describes the ribbon alone.
            thickness: 1.0,
            outlineTint: 0,
            highlight: 2.0,
            sheetFlat: 1.0,
            pencil: 0,
            arrows: true,
            detail: DETAIL_DEFAULT_N,
            fade: FADE_DEFAULT,
            shade: 1,
            smooth: true,
        },
    };
    // The tube style starts from the plain cartoon values. (The 'ribbon' PRESET
    // does too, but setPreset maps it to .cartoon directly rather than needing
    // an alias of its own.)
    // TUBE STARTS FROM THE PLAIN CARTOON VALUES, but it is a STYLE in its own
    // right - tube and cartoon are the two the Style control offers - so it
    // needs its own table, not a reference to someone else's.
    //
    // This used to be `STYLE_DEFAULTS.tube = STYLE_DEFAULTS.cartoon`, which
    // shares the OBJECT rather than the values: the two could never hold
    // different settings, and an edit meant for one silently moved the other.
    // Giving Ribbon a 2.0 outline moved tube's with it, twice.
    //
    // A COPY OF EVERYTHING, not a lean table of the few keys tube actually
    // draws with (width and outline; the cartoon* keys belong to the plugin,
    // which only draws the cartoon style). That is the rule at the top of
    // STYLE_DEFAULTS and it is load-bearing: _applyStyleDefaults guards the
    // optional keys with `!== undefined`, so a key left out here is not
    // defaulted, it is SKIPPED - and the previous style's value survives into
    // this one. Spelling out only what differs keeps the two in step as the
    // table grows.
    STYLE_DEFAULTS.tube = Object.assign({}, STYLE_DEFAULTS.cartoon, {
        // the heavier outline tube has always had; Ribbon is 2.0, Richardson 1.0
        outlineWidth: 3.0,
    });

    // ---- 'ss' COLOR MODE ---------------------------------------------------
    // Colour by secondary structure. Registered as a normal custom colour mode,
    // so it works with any style - it is only grouped here because this file
    // owns the SS assignment.
    //
    // Reuses renderer._cartoonSec when the cartoon path has already built it.
    // Colours are resolved BEFORE the draw stage, so on the very first paint of
    // a viewer that cache does not exist yet; rather than return grey and
    // depend on a second render to self-correct, it computes the assignment
    // itself using the same run-splitting rule (consecutive backbone protein
    // positions, minimum 5 residues) and caches it the same way.
    // Named palettes for the 'ss' mode, selected by renderer.ssPalette (the
    // SSE dropdown in the Style panel, or ss_palette from Python). H/E/C are
    // the protein classes; N is the nucleic backbone (base plates inherit the
    // backbone colour, so they follow it); L is everything else (ligands).
    // All values are pre-lightened for this renderer's white paper - shade()
    // dims by depth on top of them, so dark saturated colours go muddy.
    const SS_PALETTES = {
        // the canonical PyMOL idiom (color red, ss h / yellow, ss s / green
        // loops); orange nucleic, and a magenta ligand that pops the binding
        // site the way a PyMOL selection does. THE DEFAULT.
        pymol: {
            H: { r: 224, g: 96, b: 96 },
            E: { r: 240, g: 208, b: 96 },
            C: { r: 126, g: 200, b: 126 },
            N: { r: 240, g: 160, b: 90 },
            L: { r: 200, g: 120, b: 200 },
        },
        // RasMol / Jmol "structure" colouring: magenta helices, yellow
        // sheets, near-white coil - carried by the ink outlines here.
        jmol: {
            H: { r: 232, g: 100, b: 170 },
            E: { r: 240, g: 208, b: 96 },
            C: { r: 235, g: 235, b: 230 },
            N: { r: 150, g: 190, b: 235 },
            L: { r: 150, g: 150, b: 150 },
        },
    };
    const ssPaletteOf = (renderer) =>
        SS_PALETTES[renderer && renderer.ssPalette] || SS_PALETTES.pymol;

    // predictBackbone and assignSecondary are exported for tests/sheet_bench.js
    // and tests/ss_bench.js for the same reason makeSec is: scoring a
    // reimplementation lets the two drift apart silently. makeSec, smoothSec and
    // extendSec are the superseded C-alpha-only pipeline, kept because the
    // benchmarks report against them.
    window.py2dmolCartoon = { render, makeSec, smoothSec, extendSec, SS_PARAMS: SS,
        predictBackbone, predictBaseFrames, assignSecondary, assignSecondaryOpen,
        smoothNucleicTrace, loneAtomRadiusA,
        ringsOf, buildSheetFrames, localFrame,
        NUCLEIC_STEP_MIN, NUCLEIC_STEP_MAX,
        // THE PAPER, and the three numbers that place it. The WebGL2 port
        // multiplies the same grain in its fragment shaders, and it has to be
        // the SAME SHEET: the tile is built from Math.random(), so a second
        // generator would give the two renderers different paper and every
        // comparison between them would be dominated by noise that means
        // nothing. `paperTile` caches on whatever object it is handed, so
        // passing the renderer shares one tile between both paths.
        paperTile,
        PENCIL: { STRENGTH: PENCIL_STRENGTH, DEFAULT: PENCIL_DEFAULT,
            TILE: 128, GRAIN_SCALE },
        // THE SHADING NUMBERS, for the same reason paperTile is shared: a
        // second copy in the WebGL2 port is a second source of truth, and the
        // two drift silently because nothing compares them. Every one of these
        // had already been restated over there, and one pair had drifted.
        SHADING: { HI_KNEE, RICH_HI_KNEE, LIGHT_AMB, LIGHT_DIFF, LIGHT_HI,
            BACK_INNER_SHADE, RIBBON_INK_MUL, INK_FADE_SCALE,
            INK_W_MUL, INK_W_MIN },
        STYLE_DEFAULTS, SS_PALETTES };
    // Near-white, not pure white: a pure white edge disappears into the page.
    const SHEET_EDGE_RGB = { r: 244, g: 246, b: 240 };
    // PER-RESIDUE SECONDARY-STRUCTURE OVERRIDE.
    // renderer.objectsData[name].sse maps a position index to 'H', 'E' or 'C' and wins over
    // whatever the assignment produced, so a user can force a region to draw as
    // helix/strand/loop from the GUI (or from Python) without touching geometry.
    // Applied in BOTH places that derive sec - the draw stage and secForColor -
    // because those are separately cached, and colouring from a different SS
    // string than the geometry is exactly the bug secForColor exists to prevent.
    const SS_LETTERS = { H: 1, E: 1, C: 1 };
    // Stored PER OBJECT as `sse`, exactly like `color`: both are keyed by
    // position index, so both are only meaningful against the object they were
    // set on. Python's set_sse and the GUI's SSE control write the same field.
    const sseOf = (renderer) => {
        if (!renderer) return null;
        // MERGED INDICES, like everything else the drawing reads. Each object
        // stores the override in its own numbering, so a second object's
        // forced helix would land on the first object's residues.
        const ms = renderer.multiState;
        if (ms && ms.enabled && ms.sourceNames && renderer.sourceOffsetOf) {
            const out = {};
            let any = false;
            for (const nm of ms.sourceNames) {
                const own = (renderer.objectsData[nm] || {}).sse;
                if (!own) continue;
                const off = renderer.sourceOffsetOf(nm);
                for (const k of Object.keys(own)) { out[Number(k) + off] = own[k]; any = true; }
            }
            return any ? out : null;
        }
        const o = renderer.objectsData && renderer.currentObjectName
            ? renderer.objectsData[renderer.currentObjectName] : null;
        return (o && o.sse) || null;
    };
    const sseKey = (renderer) => {
        const ov = sseOf(renderer);
        if (!ov) return '';
        // part of the cache key, so editing the override invalidates both caches
        const ks = Object.keys(ov);
        return '|ss' + ks.length + ':' + ks.join(',') + ':' + ks.map((k) => ov[k]).join('');
    };
    // EXPORTED, because the WebGL2 port's rebuild signature needs this exact
    // digest. An sse edit changes which residues are helix, strand or loop, so
    // it changes the GEOMETRY - and the port cannot reach it through
    // _cartoonSecKey: that is only refreshed while the 2D pass runs, which on
    // the GPU path happens inside the capture, i.e. AFTER the signature has
    // been compared. The mesh would never rebuild, so the capture would never
    // run, so the key would never update - a stale picture that stays stale.
    //
    // Attached here rather than in the export literal above because that
    // literal is built before this const exists.
    if (typeof window !== 'undefined' && window.py2dmolCartoon) {
        window.py2dmolCartoon.sseKey = sseKey;
    }
    /**
     * WHAT AN SS ASSIGNMENT WAS COMPUTED FOR - the object, the frame, the size,
     * both merges, and any forced letters.
     *
     * ONE BUILDER, because there were two and they disagreed: the draw stage
     * named the merged objects in its key and the colour path did not, so with
     * several objects on screen the colour path could never match the cache
     * the drawing had just filled and recomputed the whole assignment for
     * itself - and its shorter key could describe two different merges of the
     * same total length.
     */
    const secCacheKey = (renderer, n) => (
        `${renderer.currentObjectName}|${renderer.currentFrame}|${n}`
        + `|${!!(renderer.overlayState && renderer.overlayState.enabled)}`
        + `|${(renderer.multiState && renderer.multiState.enabled
            && renderer.multiState.sourceNames)
            ? renderer.multiState.sourceNames.join(',') : ''}`
        + sseKey(renderer));

    const applySse = (sec, renderer) => {
        const ov = sseOf(renderer);
        if (!ov || !sec) return sec;
        for (const k in ov) {
            const i = +k;
            if (i >= 0 && i < sec.length && SS_LETTERS[ov[k]]) sec[i] = ov[k];
        }
        return sec;
    };

    const secForColor = (renderer) => {
        const n = renderer.coords ? renderer.coords.length : 0;
        if (!n) return null;
        const key = secCacheKey(renderer, n);
        if (renderer._cartoonSec && renderer._cartoonSecKey === key) {
            return renderer._cartoonSec;
        }
        if (renderer._ssColorSec && renderer._ssColorKey === key) {
            return renderer._ssColorSec;
        }
        // Same call the draw stage makes, so the colours cannot disagree with
        // the geometry: colouring from a different pipeline used to tint the
        // last residue of every helix as coil while the ribbon drew it as helix.
        const assigned = assignSecondary(renderer.coords, n, renderer.positionTypes,
            { names: renderer.positionNames,
                rings: ringsOf(renderer.segmentIndices, n) });
        const sec = applySse(assigned.sec, renderer);
        renderer._ssColorSec = sec;
        renderer._ssColorKey = key;
        return sec;
    };
    // ...AND ANYONE ELSE WHO NEEDS THE ASSIGNMENT CAN ASK FOR IT.
    //
    // The selection panel used to read renderer._cartoonSec directly and give
    // up when it was absent - which is most of the time, because it is a
    // render-time cache that _invalidateSegmentCache clears, and adding a
    // contact or a side chain clears it. So the panel's SSE control said
    // "Helix" after one click and "DSSP" after the next, with nothing about
    // the structure having changed. It computes on a miss and caches the same
    // way the colour path does.
    if (typeof window !== 'undefined' && window.py2dmolCartoon) {
        window.py2dmolCartoon.secondaryFor = secForColor;
    }
    // Registered by writing the table directly: the register helper is module
    // scoped in viewer-mol.js and not exposed on window.
    if (!window.py2dmol_customColors) window.py2dmol_customColors = {};
    {
        window.py2dmol_customColors.ss = ((i, renderer) => {
            const pal = ssPaletteOf(renderer);
            const types = renderer.positionTypes;
            if (types && types[i] !== 'P') {
                // nucleic backbone (and, through it, the base plates) gets
                // its own colour; everything else non-protein is ligand
                return (types[i] === 'D' || types[i] === 'R') ? pal.N : pal.L;
            }
            const sec = secForColor(renderer);
            if (!sec) return pal.C;
            return pal[sec[i]] || pal.C;
        });
    }
    window.dispatchEvent(new Event('py2dmol_cartoon_loaded'));
})();
