// ============================================================================
// py2Dmol/resources/viewer-cartoon.js
// -----------------------------------
// AI Context: CARTOON STYLE RENDERER (config.rendering.style === "cartoon")
// - Self-contained DRAW STAGE that replaces Pseudo3DRenderer's default
//   "ribbon" drawing. viewer-mol.js delegates here from _renderToContext()
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
    const RICH_HALF_A = { H: 1.45, E: 1.65, C: 0.30 };
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
    const RICH_WIDTH_DEFAULT = 2.0;
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
    const PENCIL_DEFAULT = 1.0;    // grain amount when the preset is selected
    const PENCIL_STRENGTH = 0.54;  // alpha at pencil = 1 (Richardson's amount)
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
    // Nucleic backbone half-width. Wider than a protein coil (0.42): the
    // strand has to stay legible next to 3.6 A base plates, and a duplex
    // read as thread when it matched the coil width.
    const NA_HALF_A = 1.55;
    const LOOP_TUBE_A = 0.35;              // loop tube radius
    const RIBBON_TH_A = 0.25;              // slab half-thickness (total 0.5 A)
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
    const NA_PLATE_TH = 0.30;   // plate half-thickness, A
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
    const NA_PAIR_MIN = 12.5;   // A, C4'-C4' across a pair
    const NA_PAIR_MAX = 16.5;
    const NA_PAIR_IDEAL = 14.6;
    const NA_RUN_W = 0.6;         // weight on contiguous register length
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
    function predictBaseFrames(at, n, want, isPur, isDna, out) {
        const bf = out || new Float64Array(n * 6);
        // The window needs i-1 .. i+2, so the two residues at each end of a
        // chain have none - and on a 12-mer duplex that is a quarter of the
        // structure, with bare ribbon where its terminal base pairs should be.
        // PULCHRA pads its trace for the same reason; this continues the local
        // screw motion, applying the turn between the last two steps once more.
        const ext = (a, b, c) => {
            // Continue the SCREW: take the turn from a->b to b->c and apply it
            // once more, keeping the step length. Adding the difference of the
            // two steps instead (c + 2*v2 - v1) overshoots by up to 40% on a
            // helix, and the padded point then failed the bond-length test
            // below - so the residue it was invented for got no frame at all,
            // which is worse than no padding: a zero frame puts the base
            // centroid on the C4' itself.
            const v1x = b.x - a.x, v1y = b.y - a.y, v1z = b.z - a.z;
            const v2x = c.x - b.x, v2y = c.y - b.y, v2z = c.z - b.z;
            const l1 = Math.hypot(v1x, v1y, v1z), l2 = Math.hypot(v2x, v2y, v2z);
            if (l1 < 1e-6 || l2 < 1e-6) return { x: c.x + v2x, y: c.y + v2y, z: c.z + v2z };
            let kx = v1y * v2z - v1z * v2y;
            let ky = v1z * v2x - v1x * v2z;
            let kz = v1x * v2y - v1y * v2x;
            const kl = Math.hypot(kx, ky, kz);
            if (kl < 1e-9) return { x: c.x + v2x, y: c.y + v2y, z: c.z + v2z };
            kx /= kl; ky /= kl; kz /= kl;
            const cs = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y + v1z * v2z) / (l1 * l2)));
            const sn = Math.sin(Math.acos(cs));
            const dt = kx * v2x + ky * v2y + kz * v2z;
            const rx = v2x * cs + (ky * v2z - kz * v2y) * sn + kx * dt * (1 - cs);
            const ry = v2y * cs + (kz * v2x - kx * v2z) * sn + ky * dt * (1 - cs);
            const rz = v2z * cs + (kx * v2y - ky * v2x) * sn + kz * dt * (1 - cs);
            return { x: c.x + rx, y: c.y + ry, z: c.z + rz };
        };
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
     * `want` accepts - in practice the strands, the only place the result is
     * used. Both matter at ribosome scale: over 10000 residues, returning one
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
    function localFrame(at, n, i, out) {
        if (i < 1 || i > n - 3) return false;
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1);
        let ux = p2.x - p1.x, uy = p2.y - p1.y, uz = p2.z - p1.z;
        const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (ul < CO_BOND_MIN || ul > CO_BOND_MAX) return false;   // chain break
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
    function predictBackbone(at, n, want, out) {
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
            const r14 = Math.sqrt(dx14 * dx14 + dy14 * dy14 + dz14 * dz14)
                * chiralSign(nx, ny, nz, cx, cy, cz);
            let b13 = (r13 - 4.6) * (1 / 0.4) | 0;
            b13 = b13 < 0 ? 0 : (b13 > PEP_NB13 - 1 ? PEP_NB13 - 1 : b13);
            let b14 = (r14 + 11) * (1 / 0.9) | 0;
            b14 = b14 < 0 ? 0 : (b14 > PEP_NB14 - 1 ? PEP_NB14 - 1 : b14);
            const t = (b13 * PEP_NB14 + b14) * 6;
            // C(i) and N(i+1), out of the local frame and back into space
            const ccx = p1.x + ux * PEPTIDE_TABLE[t] + vx * PEPTIDE_TABLE[t + 1] + wx * PEPTIDE_TABLE[t + 2];
            const ccy = p1.y + uy * PEPTIDE_TABLE[t] + vy * PEPTIDE_TABLE[t + 1] + wy * PEPTIDE_TABLE[t + 2];
            const ccz = p1.z + uz * PEPTIDE_TABLE[t] + vz * PEPTIDE_TABLE[t + 1] + wz * PEPTIDE_TABLE[t + 2];
            const nnx = p1.x + ux * PEPTIDE_TABLE[t + 3] + vx * PEPTIDE_TABLE[t + 4] + wx * PEPTIDE_TABLE[t + 5];
            const nny = p1.y + uy * PEPTIDE_TABLE[t + 3] + vy * PEPTIDE_TABLE[t + 4] + wy * PEPTIDE_TABLE[t + 5];
            const nnz = p1.z + uz * PEPTIDE_TABLE[t + 3] + vz * PEPTIDE_TABLE[t + 4] + wz * PEPTIDE_TABLE[t + 5];
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
    function assignSecondary(coords, n, positionTypes, opts) {
        const cutoff = (opts && opts.hbCutoff !== undefined) ? opts.hbCutoff : HB_ENERGY_CUTOFF;
        const LADDER_EXTEND = (opts && opts.extendLadder !== undefined) ? opts.extendLadder : LADDER_EXTEND_DEFAULT;
        const extendGate = (opts && opts.extendGate) || LADDER_EXTEND_GATE;
        const sec = new Array(n).fill('C');
        const ladders = [];
        if (n < 5) return { sec, ladders };
        const at = (i) => coords[i];
        const isProtein = (i) => !positionTypes || positionTypes[i] === 'P';
        const bb = predictBackbone(at, n, isProtein);
        const has = (i, k) => {
            const o = i * 9 + k;
            return bb[o] !== 0 || bb[o + 1] !== 0 || bb[o + 2] !== 0;
        };
        // amide hydrogens
        const H = new Float64Array(n * 3);
        for (let i = 1; i < n; i++) {
            if (!isProtein(i) || !has(i, 6) || !has(i - 1, 0)) continue;
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
            for (const cls of ['H', 'E']) {
                const b = SS_PHI_PSI[cls];
                const dpsi = delta(psi, b.psi), dphi = delta(phi, b.phi);
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
    function buildSheetFrames(coords, n, sec, positionTypes, ladders, opts) {
        const flatCycles = (opts && opts.cycles !== undefined) ? opts.cycles : SHEET_FLAT_CYCLES;
        const relaxSweeps = (opts && opts.relax !== undefined) ? opts.relax : SHEET_FRAME_RELAX;
        const alongW = (opts && opts.along !== undefined) ? opts.along : SHEET_ALONG_W;
        const acrossW = (opts && opts.across !== undefined) ? opts.across : SHEET_ACROSS_W;
        const at = (i) => coords[i];
        const isStrand = (i) => sec[i] === 'E' && (!positionTypes || positionTypes[i] === 'P');
        const bb = predictBackbone(at, n, isStrand);

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
        const rawTan = (i) => {
            const a = at(Math.max(0, i - 1)), b = at(Math.min(n - 1, i + 1));
            const x = b.x - a.x, y = b.y - a.y, z = b.z - a.z;
            const l = Math.hypot(x, y, z);
            return l > 1e-9 ? [x / l, y / l, z / l] : null;
        };
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
    const subFloor = (base) => Math.max(MIN_SUB, Math.round(base * detailCur));
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
    // 0.68 is set to match the contrast jr2 gets from its explicit two-tone,
    // so every palette reads with the same inner/outer separation. Measured
    // inner-minus-outer median luminance on an ideal helix: jr2 58.4 (its own
    // hue, unaffected by this constant), pymol 57.3, jmol 52.2, jr1 61.4.
    // It has to be this large because the tint competes with an already-light
    // outer face - at 0.40 the others reached only ~30-37, well short of jr2.
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

    // ------------------------------------------------------------------------
    // Main entry, called by Pseudo3DRenderer._renderToContext when
    // style === 'cartoon'. `colors` is the per-segment color array the main
    // pipeline already computed (respects the full 5-level color hierarchy).
    // ------------------------------------------------------------------------
    function render(renderer, ctx, displayWidth, displayHeight, colors) {
        const rotated = renderer.rotatedCoords;   // Vec3, rotated + centered, Angstroms
        const n = renderer.coords.length;
        const segments = renderer.segmentIndices;
        const vs = renderer.viewerState;
        const object = renderer.objectsData[renderer.currentObjectName];
        const positionTypes = renderer.positionTypes;

        // --- projection: identical to the ribbon path so zoom/ortho match ---
        const maxExtent = (object && object.maxExtent > 0) ? object.maxExtent : 30.0;
        const effectiveExtent = vs.extent || maxExtent;
        const padding = 0.9;
        const scale = Math.min(
            (displayWidth * padding) / (effectiveExtent * 2),
            (displayHeight * padding) / (effectiveExtent * 2)
        ) * vs.zoom;
        const centerX = displayWidth / 2;
        const centerY = displayHeight / 2;
        const persp = vs.perspectiveEnabled;
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

        const mask = renderer.visibilityMask;
        const vis = (i) => !mask || mask.has(i);

        // --- partition segments: backbone (drawn as cartoon) vs everything else ---
        // A backbone segment is a consecutive-index polymer segment; explicit
        // bonds, cyclic closures, ligand bonds, contacts and lone-position dots
        // all stay generic and depth-sort against the cartoon.
        const bbSeg = new Int32Array(n).fill(-1);  // residue i -> segment index for (i, i+1)
        const genericSegs = [];
        for (let s = 0; s < segments.length; s++) {
            const seg = segments[s];
            const isBB = (seg.type === 'P' || seg.type === 'D' || seg.type === 'R')
                && seg.idx2 === seg.idx1 + 1 && seg.contactIdx1 === undefined;
            if (isBB) bbSeg[seg.idx1] = s;
            else genericSegs.push(s);
        }

        // Outline width follows the outline control, matching the ribbon
        // style: black ink under/between the fills. Declared before the
        // geometry loop because ribbon ink prims are emitted DURING
        // construction (sorted at their own depth).
        const outlineW = renderer.outlineMode !== 'none'
            ? (renderer.relativeOutlineWidth === 0
                ? 0 : Math.max(1, renderer.relativeOutlineWidth || 3))
            : 0;
        // Edge candidates for the ink pass (hull silhouette + crease edges)
        const inkCurves = [];
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
        if (renderer._naDebug) { renderer._naFrame = {}; renderer._naTwist = []; }
        const naWidthA = numOr(renderer.cartoonNaWidth, NA_HALF_A);
        const naPlateWA = numOr(renderer.cartoonNaPlateW, NA_PLATE_W);
        const naPlateThA = numOr(renderer.cartoonNaPlateTh, NA_PLATE_TH);
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

        // --- secondary structure, cached per object/frame ---
        // Distances are rotation-invariant, so this never changes with the view.
        // guarded like secForColor below: render can run before overlayState exists
        const secKey = `${renderer.currentObjectName}|${renderer.currentFrame}|${n}|${renderer.overlayState && renderer.overlayState.enabled}`;
        //
        // The assignment runs over the WHOLE structure at once rather than per
        // run: sheets pair strands from different chains, and a hydrogen bond
        // does not care that its two ends were parsed as separate segments. The
        // bridge partners come back with it, and are the sheet ladders.
        let sec = renderer._cartoonSec;
        let ladders = renderer._cartoonLadder;
        if (!sec || renderer._cartoonSecKey !== secKey) {
            const assigned = assignSecondary(renderer.coords, n, positionTypes);
            sec = assigned.sec;
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
        const baseFramesRot = hasNA ? predictBaseFrames(
            (i) => rotated[i], n, isNucleotide, isPurine, isDna) : null;

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
                                    if (!complementary(bi, baseOf(names[j]))) continue;
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
                            runLen++; a2 += da; b2 += db;
                        }
                    }
                    if (runLen < 2) continue;     // isolated: not a helix
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
            sheet = ladders.length
                ? buildSheetFrames(renderer.coords, n, sec, positionTypes, ladders)
                : null;
            renderer._cartoonSheet = sheet;
            renderer._cartoonSheetKey = secKey;
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
                if (!localFrame((k) => rotated[k], n, i, fr)) continue;
                const x = fr[0] * lx + fr[3] * ly + fr[6] * lz;
                const y = fr[1] * lx + fr[4] * ly + fr[7] * lz;
                const z = fr[2] * lx + fr[5] * ly + fr[8] * lz;
                const l = Math.hypot(x, y, z);
                if (l > 1e-9) sheetSides[i] = [x / l, y / l, z / l];
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
        // The strand itself is flattened END TO END, and the transition is
        // spread OUTWARD into the flanking loop residues instead. Tapering
        // inside the strand was the first attempt and it was wrong twice over:
        // the weight was min(1, integer distance from the end), which is 0 at
        // the terminal residue and 1 at its neighbour - a step, not a ramp - so
        // the strand visibly snapped flat one residue in. And even a smooth
        // taper there is the wrong shape: pinning the last residue while the
        // interior goes flat puts the entire bend inside the strand, which is
        // the one place it must not be. Loops absorb it invisibly.
        // 0 = untouched (pleated), 1 = fully averaged.
        const sheetFlat = Math.max(0, Math.min(1,
            renderer.cartoonSheetFlat !== undefined
                ? renderer.cartoonSheetFlat : (rich ? SHEET_FLAT_DEFAULT : 0)));
        const FLAT_EXT = 2;     // loop residues each side that absorb the bend
        // SHEET PROJECTION: move each strand residue onto its own sheet plane
        // (see buildSheetFrames). renderer.cartoonSheetProject is the blend, 0
        // to 1; the offset travels as local-frame coefficients so it can be
        // applied to the rotated trace without a matrix.
        const sheetProject = Math.max(0, Math.min(1,
            renderer.cartoonSheetProject !== undefined
                ? renderer.cartoonSheetProject : SHEET_PROJECT));
        let basePos = rotated;
        if (sheet && sheetProject > 0.001) {
            basePos = new Array(n);
            const fr3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            for (let i = 0; i < n; i++) {
                const p = rotated[i];
                if (!sheet.onSheet[i] || !localFrame((k) => rotated[k], n, i, fr3)) {
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
            // PROTEIN ONLY. sec defaults to 'C' for every position and only
            // protein runs are ever assigned, so nucleic residues look exactly
            // like loops to the test below and were being smoothed with them.
            // That breaks base plates: the plate and base-pair geometry read
            // rotated[] directly while the backbone reads the smoothed posArr,
            // so moving the backbone slid it out from under its own bases.
            // Nucleic has its own frame machinery and must keep the raw trace.
            const isLoopSS = (t) => t !== 'H' && t !== 'E';
            const smoothable = (i) => !positionTypes || positionTypes[i] === 'P';
            for (let a = 0; a < n; a++) {
                // Strands get FLATTENED (pleat removed) and loops get SMOOTHED,
                // both off the same control: they are the same operation - damp
                // the high-frequency wiggle - and a structure where only the
                // strands were cleaned up looked inconsistent. Helices are never
                // touched; smoothing a helix would unwind the coil that is the
                // whole point of it.
                if (!smoothable(a)) continue;
                const kind = sec[a] === 'E' ? 'E' : (isLoopSS(sec[a]) ? 'C' : null);
                if (!kind) continue;
                let b = a;
                // ... and never past the residue's own chain run: two chains
                // whose facing termini are both coil are adjacent in index
                // order, and without this bound the span crossed the break -
                // the 3-point average then mixed positions ~15 A apart and
                // bent both termini toward each other whenever sheetFlat > 0.
                while (b + 1 < n && smoothable(b + 1)
                    && (runHi[a] < 0 || b + 1 <= runHi[a])
                    && (kind === 'E' ? sec[b + 1] === 'E' : isLoopSS(sec[b + 1]))) b++;
                if (kind === 'E' && b - a >= 2) {
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
                    const len = b - a + 1;
                    const pvE = new Float64Array(len * 3);
                    for (let j = a; j <= b; j++) {
                        const k = (j - a) * 3;
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
                    for (let j = a + 1; j <= b - 1; j++) {   // ends pinned
                        const k = (j - a) * 3;
                        const v = rotated[j];
                        const p = posArr[j];
                        posArr[j] = {
                            x: p.x + (pvE[k] - v.x) * w,
                            y: p.y + (pvE[k + 1] - v.y) * w,
                            z: p.z + (pvE[k + 2] - v.z) * w,
                        };
                    }
                } else if (kind === 'C' && b - a >= 2 && runLo[a] >= 0) {
                    // LOOPS: iterated narrow smoothing. A loop keeps to its
                    // own span - its neighbours are elements, and moving
                    // their end residues would tear the ribbon away from the
                    // tube - so the ramp below tapers to zero at both ends.
                    //
                    // A wide window (+-2) flattens real curvature and
                    // shortens the curve; repeating a 3-point average instead
                    // attacks exactly the alternating component - each pass
                    // cuts it to a third, three passes to 1/27 - while low
                    // frequency shape, and therefore arc length, is nearly
                    // untouched.
                    const W = 1;
                    const PASSES = 3;
                    const len = b - a + 1;
                    let cur = new Float64Array(len * 3);
                    for (let j = a; j <= b; j++) {
                        const v = basePos[j];
                        const o = (j - a) * 3;
                        cur[o] = v.x; cur[o + 1] = v.y; cur[o + 2] = v.z;
                    }
                    let nxt = new Float64Array(len * 3);
                    for (let pass = 0; pass < PASSES; pass++) {
                        for (let q = 0; q < len; q++) {
                            let sx = 0; let sy = 0; let sz = 0; let c = 0;
                            for (let k = Math.max(0, q - W);
                                k <= Math.min(len - 1, q + W); k++) {
                                sx += cur[k * 3];
                                sy += cur[k * 3 + 1];
                                sz += cur[k * 3 + 2];
                                c++;
                            }
                            nxt[q * 3] = sx / c;
                            nxt[q * 3 + 1] = sy / c;
                            nxt[q * 3 + 2] = sz / c;
                        }
                        const swap = cur; cur = nxt; nxt = swap;
                    }
                    const sm = cur;
                    for (let j = a; j <= b; j++) {
                        // taper to 0 at the loop's own ends
                        const dEnd = Math.min(j - a, b - j);
                        const w0 = Math.min(1, dEnd / (FLAT_EXT + 1));
                        const ramp = w0 * w0 * (3 - 2 * w0);
                        const w = sheetFlat * ramp;
                        if (w <= 0) continue;
                        const v = rotated[j];
                        const o = (j - a) * 3;
                        // TRANSVERSE component only: the raw average also has
                        // a LONGITUDINAL component that shortens steps by an
                        // amount depending on local geometry. Projecting the
                        // displacement onto the plane perpendicular to the
                        // local tangent damps the wiggle and leaves spacing
                        // along the chain untouched.
                        const pv = rotated[Math.max(a, j - 1)];
                        const nv = rotated[Math.min(b, j + 1)];
                        let tx = nv.x - pv.x;
                        let ty = nv.y - pv.y;
                        let tz = nv.z - pv.z;
                        const tm = Math.hypot(tx, ty, tz);
                        let dx = sm[o] - v.x;
                        let dy = sm[o + 1] - v.y;
                        let dz = sm[o + 2] - v.z;
                        if (tm > 1e-9) {
                            tx /= tm; ty /= tm; tz /= tm;
                            const dot = dx * tx + dy * ty + dz * tz;
                            dx -= dot * tx; dy -= dot * ty; dz -= dot * tz;
                        }
                        posArr[j] = {
                            x: v.x + dx * w,
                            y: v.y + dy * w,
                            z: v.z + dz * w,
                        };
                    }
                }
                a = b;
            }
        }
        // set renderer._posProbe = null before a render to receive the drawn
        // positions; used by the smoothing checks to measure per-class curvature
        if (renderer._posProbe === null) renderer._posProbe = posArr;
        const at = (i) => posArr[i];
        // UNFLATTENED positions. The ribbon's face direction must come from
        // these, never from the flattened ones - see sideOf.
        const atRaw = (i) => rotated[i];

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
        const sideOf = (i, lo, hi) => {
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
            if (i - 1 < lo && i + 3 <= hi) return oneSided(i, 1);
            if (i + 1 > hi && i - 3 >= lo) return oneSided(i, -1);
            const a = atRaw(Math.max(lo, i - 1));
            const b = atRaw(i);
            const c = atRaw(Math.min(hi, i + 1));
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
        const cullSeg = (p1, p2) => {
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
        const naMid = (i) => {
            if (i < 0 || i >= n) return null;
            const j = pairOf[i];
            if (j < 0 || j >= n) return null;
            const a = rotated[i], b = rotated[j];
            return [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
        };

        for (const [lo, hi] of runs) {
            if (hi <= lo) continue;
            const isProt = positionTypes[lo] === 'P';

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
                    rawSides.push(sideOf(i, lo, hi));
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
                // NUCLEIC: PARALLEL-TRANSPORT the frame.
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
                    const ntRaw = Number(renderer.cartoonNaTrack);
                    const naTrack = Number.isFinite(ntRaw)
                        ? Math.min(1, Math.max(0, ntRaw)) : NA_TRACK_DEFAULT;
                    const tanAt = (i) => {
                        const pA = rotated[Math.max(lo, i - 1)];
                        const pC = rotated[Math.min(hi, i + 1)];
                        const x = pC.x - pA.x, y = pC.y - pA.y, z = pC.z - pA.z;
                        const l = Math.hypot(x, y, z);
                        return l > 1e-9 ? [x / l, y / l, z / l] : null;
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
                            const u = rotated[k], v = rotated[q];
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
                            // hybrid: radial from C4' to the axis line
                            const q = rotated[j], pI = rotated[i];
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
                        const a = Math.max(lo, i - 1), b = Math.min(hi, i + 1);
                        if (a === b) return null;
                        const pA = rotated[a], pB = rotated[i], pC = rotated[b];
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
                        } else if (prevT) {
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
                        if (naTrack > 0) {
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
                        if (k > 0 && sides[k - 1]) {
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
                        if (renderer._naDebug) {
                            (renderer._naFrame || (renderer._naFrame = {}))[lo + k] = {
                                s: [s[0], s[1], s[2]],
                                t: [tv[0], tv[1], tv[2]],
                                p: [rotated[lo + k].x, rotated[lo + k].y, rotated[lo + k].z],
                                j: pairOf[lo + k],
                            };
                        }
                        prevT = tv;
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
                        let sv = sheetSides[i];
                        if (!sv) { prevSide = sides[k]; continue; }
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
                        const p0 = at(Math.max(lo, j - 1));
                        const p1 = at(Math.min(hi, j + 1));
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
                    const isLoopAt = (j) => sec[j] !== 'H' && sec[j] !== 'E';
                    for (let a2 = lo; a2 <= hi; a2++) {
                        if (!isLoopAt(a2)) continue;
                        let b2 = a2;
                        while (b2 + 1 <= hi && isLoopAt(b2 + 1)) b2++;
                        // seed from the element before the run, else its own side
                        let cur = sides[(a2 > lo ? a2 - 1 : a2) - lo];
                        const out = [];
                        for (let j = a2; j <= b2; j++) {
                            const t = tanOf(j);
                            const pj = proj(cur, t);
                            if (pj) cur = pj;
                            out.push(cur);
                        }
                        // residual against the element after the run
                        if (b2 < hi && out.length) {
                            const tEnd = tanOf(b2);
                            const want = proj(sides[b2 + 1 - lo], tEnd);
                            const have = out[out.length - 1];
                            if (want) {
                                let dp = have[0] * want[0] + have[1] * want[1] + have[2] * want[2];
                                dp = Math.max(-1, Math.min(1, dp));
                                let ang = Math.acos(dp);
                                const cx = have[1] * want[2] - have[2] * want[1];
                                const cy = have[2] * want[0] - have[0] * want[2];
                                const cz = have[0] * want[1] - have[1] * want[0];
                                if (cx * tEnd[0] + cy * tEnd[1] + cz * tEnd[2] < 0) ang = -ang;
                                const nSteps = out.length;
                                for (let k = 0; k < nSteps; k++) {
                                    const f = (k + 1) / nSteps;
                                    out[k] = rot(out[k], tanOf(a2 + k), ang * f);
                                }
                            }
                        }
                        for (let j = a2; j <= b2; j++) sides[j - lo] = out[j - a2];
                        a2 = b2;
                    }
                }
            }


            // set renderer._sideProbe = null before a render to receive the
            // per-residue side vectors; used to measure frame twist rate
            if (renderer._sideProbe === null && isProt) {
                renderer._sideProbe = [];
                for (let j = 0; j < lo; j++) renderer._sideProbe.push(null);
                for (let j = lo; j <= hi; j++) renderer._sideProbe.push(sides[j - lo]);
            }

            // Per-RESIDUE half-width and half-thickness for the continuous
            // profile. Loops are square (thickness == width); helices and
            // strands keep the user's thickness setting.
            const WIDTHS = rich ? RICH_HALF_A : SS_HALF_A;
            const halfW = (j) => {
                if (!isProt) return naWidthA * widthScale;
                const jj = Math.min(hi, Math.max(lo, j));
                const t = sec[jj];
                // Richardson loops are a SQUARE section whose side is the sheet
                // THICKNESS: the loop reads as the same piece of card as the
                // arrows, seen end-on. That ties it to the thickness control
                // rather than the width one - halfT returns halfW for 'C', so
                // setting the width here makes both dimensions equal - and it
                // means the Thick slider moves loops and sheets together, which
                // is what keeps them looking like one material.
                if (rich && t !== 'H' && t !== 'E') return thickScale;
                return (WIDTHS[t] || WIDTHS.C) * widthScale;
            };
            // ARROWHEADS (Richardson preset). The head is HALF a CA-CA step
            // long and sits on the C-terminal end of a strand, so it is a
            // property of the last INTERVAL, not of whole residues. An earlier
            // version widened the final two residues, which made the head as
            // long as the strand's last two steps - far longer than it is
            // drawn, and long enough to swallow short strands whole.
            const isArrowInterval = (j) => arrowsOn && isProt
                && j >= lo && j + 1 <= hi
                && sec[j] === 'E' && sec[j + 1] === 'E'
                && (j + 2 > hi || sec[j + 2] !== 'E');
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
            // cannot express. Loops there take thickness == width so they read
            // as round rather than as a flat tape on edge. The Thick slider
            // still scales the whole profile, so the control keeps working.
            const thickScale = (renderer.cartoonThickness !== undefined
                ? renderer.cartoonThickness / 2 : RIBBON_TH_A);
            const halfT = (j) => {
                if (!rich || !isProt) return thickScale;
                const jj = Math.min(hi, Math.max(lo, j));
                const t = sec[jj];
                if (t === 'C') return halfW(jj);           // round-ish loop
                const k = RICH_TH_REL[t] !== undefined ? RICH_TH_REL[t] : RICH_TH_REL.C;
                return thickScale * k;
            };

            // Is interval j part of the same ribbon element as type t?
            // (Used for end caps: an element boundary closes the outline with
            // a cross-edge stroke, which is what makes a helix-to-loop
            // junction read as a finished ribbon end instead of a raw cut.)
            const sameElem = (j, t) => {
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

            for (let i = lo; i < hi; i++) {
                const segIdx = bbSeg[i];
                if (segIdx < 0) { flushTubeRun(); continue; }
                if (!vis(i) || !vis(i + 1)) { flushTubeRun(); continue; }
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
                    ? ((sec[i] === sec[i + 1]) ? sec[i]
                        : ((sec[i] === 'H' || sec[i + 1] === 'H') ? 'H' : 'C'))
                    : 'C';
                let col = colors[segIdx];
                if (ssColor && isProt) {
                    col = ssPal[ssCls] || ssPal.C || col;
                }
                if (!col) { flushTubeRun(); continue; }
                // Offscreen: contributes nothing on screen and cannot occlude
                // anything that is - skip before building any geometry. Ends
                // the current tube run exactly like an invisible interval.
                if (cullSeg(at(i), at(i + 1))) { flushTubeRun(); continue; }
                const t0 = isProt ? sec[i] : 'C';
                const t1 = isProt ? sec[i + 1] : 'C';
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
                    const hw = (squareLoop ? SS_HALF_A.C : SS_HALF_A[t0])
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
                    const afterArrow = isArrowInterval(i - 1);
                    // Mirror case at the OTHER end: the interval running into a
                    // strand's N-terminus used to ramp up from loop width to
                    // strand width, so the strand faded in as a long wedge
                    // instead of starting. Holding this interval at loop width
                    // leaves a clean step at the first strand residue, which is
                    // where the flat back face belongs (capped below).
                    const beforeStrand = arrowsOn && isProt && i + 1 <= hi
                        && sec[i + 1] === 'E' && sec[i] !== 'E';
                    const hwA = profiled
                        ? halfW(afterArrow ? i + 1 : i) : hw;
                    const hwB = profiled
                        ? halfW(beforeStrand ? i : i + 1) : hw;
                    const htA = profiled
                        ? halfT(afterArrow ? i + 1 : i) : null;
                    const htB = profiled
                        ? halfT(beforeStrand ? i : i + 1) : null;
                    const arrowHead = isArrowInterval(i);
                    const arrowBase = (WIDTHS.E || SS_HALF_A.E) * widthScale;
                    const s1 = sides[i - lo];
                    const s2 = sides[i + 1 - lo];
                    const pa = at(i);
                    const pb = at(i + 1);
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
                        const q1 = at(Math.max(lo, j - 1));
                        const q2 = at(Math.min(hi, j + 1));
                        if (t0 === 'H') {
                            if (j - 2 < lo && j + 3 <= hi) {
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
                            if (j + 2 > hi && j - 3 >= lo) {
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
                            const q0w = at(Math.max(lo, j - 2));
                            const q3w = at(Math.min(hi, j + 2));
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
                    const mB = tanAt(i + 1);
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
                        const q1 = sides[Math.max(0, j - 1 - lo)];
                        const q2 = sides[Math.min(hi - lo, j + 1 - lo)];
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
                            const q0w = sides[Math.max(0, j - 2 - lo)];
                            const q3w = sides[Math.min(hi - lo, j + 2 - lo)];
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
                    const nTanB = sideTanAt(i + 1);
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
                        const qm = at(Math.max(lo, i - 1));
                        const q1 = at(i);
                        const q2 = at(i + 1);
                        const qp = at(Math.min(hi, i + 2));
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
                    const ht = squareLoop ? hw
                        : (renderer.cartoonThickness !== undefined
                            ? renderer.cartoonThickness / 2
                            : RIBBON_TH_A);
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
                        return cnr; // [L+, L-, R+, R-, n.v, b.v, t.v, b.k]
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
                    const strandStart = arrowsOn && isProt && sec[i] === 'E'
                        && (i === lo || sec[i - 1] !== 'E');
                    const capStartV = strandStart
                        || (profiled ? (i === lo) : !sameElem(i - 1, t0));
                    const capEndV = profiled ? (i + 1 === hi) : !sameElem(i + 1, t0);
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
                        const prim = {
                            kind: 'rib',
                            // SS class of this interval, so paintSide can give
                            // strand EDGES their own colour (see below) and
                            // paintFace can find the two-tone underside. Same
                            // value the colour above used, so a transition
                            // interval cannot be drawn helix-coloured but
                            // two-toned as coil.
                            ss: ssCls,
                            arrow: arrowHead,
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
                            z: zSort,
                            zShade,
                            c: col,
                            capStart: a0 === 0 && capStartV,
                            capEnd: e0 === nsub && capEndV,
                            gs0: i + a0 / nsub,
                            gsStep: 1 / nsub,
                        };
                        if (a0 === 0) registerJoint(`R${i}`, prim);
                        if (e0 === nsub) registerJoint(`R${i + 1}`, prim);
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
                    if (outlineW) {
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
                            const TOL2 = 1.5 * 1.5;
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
                        }

                        for (let c = 0; c < 4; c++) {
                            let any = false;
                            for (let s = 0; s < visC[c].length; s++) {
                                if (visC[c][s]) { any = true; break; }
                            }
                            if (any) {
                                inkCurves.push({
                                    pts: curves[c],
                                    vis: visC[c],
                                    gs0: i,
                                    gsStep: 1 / Math.max(1, nsF - 1),
                                    c: col,
                                });
                            }
                        }
                    }
                } else {
                    // Loop, or the junction between two different elements:
                    // round tube, Catmull-Rom smoothed. The whole interval is ONE
                    // polyline primitive: stroking its outline and fill as single
                    // paths keeps the black outline continuous, where per-sample
                    // segments read as dashes (each neighbour's fill overpaints
                    // part of the previous sample's outline).
                    const p0 = at(Math.max(lo, i - 1));
                    const p1 = at(i);
                    const p2 = at(i + 1);
                    const p3 = at(Math.min(hi, i + 2));
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
                        tubeRun.i1 = i + 1;
                        // ext is only a tangent aid; rebuilt after the merge
                        tubeRun.ext = null;
                    } else {
                        flushTubeRun();
                    }
                }
            }
            flushTubeRun();
        }

        // --- generic segments: ligands, explicit bonds, cyclic closures,
        //     contacts, lone-position dots. Same widths as the ribbon style. ---
        for (const s of genericSegs) {
            const seg = segments[s];
            if (mask) {
                if (seg.type === 'C' && seg.contactIdx1 !== undefined) {
                    if (!mask.has(seg.contactIdx1) || !mask.has(seg.contactIdx2)) continue;
                } else if (!mask.has(seg.idx1) || !mask.has(seg.idx2)) {
                    continue;
                }
            }
            const v1 = rotated[seg.idx1];
            const v2 = rotated[seg.idx2];
            const A = project(v1.x, v1.y, v1.z);
            const B = project(v2.x, v2.y, v2.z);
            if (!A || !B) continue;
            const col = colors[s];
            if (!col) continue;
            const widthMult = renderer._calculateSegmentWidthMultiplier(null, seg);
            const wpx = Math.max(0.5, baseLineWidthPixels * widthMult * ((A[3] + B[3]) / 2));
            {   // offscreen: same cull as backbone intervals, stroke-width pad
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
            if (seg.idx1 === seg.idx2) {
                prims.push({ kind: 'dot', x1: A[0], y1: A[1], z: A[2], r: wpx / 2, c: col, pA: A });
            } else {
                const prim = {
                    kind: 'line',
                    x1: A[0], y1: A[1], x2: B[0], y2: B[1],
                    z: (A[2] + B[2]) / 2,
                    w: wpx,
                    c: col,
                    flat: seg.type === 'C', // contacts stay bright and flat
                    pA: A, pB: B,
                };
                registerJoint(`R${seg.idx1}`, prim);
                registerJoint(`R${seg.idx2}`, prim);
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
                            prims.push({ kind: 'ribStroke', pts: cp, z: zq + bias, c: cv.c });
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
        if (renderer.cartoonBasePlates !== false) {
            const mid = (i) => {
                // bounds first: pairOf[-1] is undefined, and `undefined < 0` is
                // false, so an unguarded index walks off the ends of rotated[]
                if (i < 0 || i >= n) return null;
                const j = pairOf[i];
                if (j < 0 || j >= n) return null;
                const a = rotated[i], b = rotated[j];
                return [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
            };
            for (let i = 0; i < n; i++) {
                const j = pairOf[i];
                if (j < 0 || j < i) continue;          // emit each pair once
                if (!vis(i) || !vis(j)) continue;
                const pi = rotated[i], pj = rotated[j];
                let lx = pj.x - pi.x, ly = pj.y - pi.y, lz = pj.z - pi.z;
                const ll = Math.hypot(lx, ly, lz);
                if (ll < 1e-3) continue;
                lx /= ll; ly /= ll; lz /= ll;
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
                if (pts.length < 2) continue;
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
                if (!Number.isFinite(ax) || Math.hypot(ax, ay, az) < 1e-9) continue;
                // Prefer the REAL base-plane normals when stored: the rung then
                // lies in the plane the bases actually occupy, instead of a
                // plane inferred from a fitted helix axis (~20 deg off).
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
                // perpendicular component only: the pair plane is normal to the axis
                const ad = ax * lx + ay * ly + az * lz;
                ax -= lx * ad; ay -= ly * ad; az -= lz * ad;
                const al = Math.hypot(ax, ay, az);
                if (al < 1e-4) continue;
                ax /= al; ay /= al; az /= al;
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
                const th = 0;
                const ribHalfT = (renderer.cartoonThickness !== undefined
                    ? renderer.cartoonThickness / 2 : RIBBON_TH_A);
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
                // is now measured to point at the partner in 100% of pairs; aimed
                // the old way it would have sent rungs out sideways.
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
                const mk = (base, fr, col) => {
                    const n0x = fr.t[1] * fr.s[2] - fr.t[2] * fr.s[1];
                    const n0y = fr.t[2] * fr.s[0] - fr.t[0] * fr.s[2];
                    const n0z = fr.t[0] * fr.s[1] - fr.t[1] * fr.s[0];
                    const n0l = Math.hypot(n0x, n0y, n0z) || 1;
                    // near edge: clear of the ribbon's face. Normally that is
                    // just the slab's half-thickness, but at thickness 0 the slab
                    // IS a plane and the rung would start exactly on it -
                    // coplanar, so which of the two wins at the joint is
                    // arbitrary and the rung's ink bled through the backbone.
                    // A floor of NA_JOINT_CLEAR keeps them separable in depth.
                    const off = Math.max(ribHalfT, NA_JOINT_CLEAR);
                    const ncx = base.x + (n0x / n0l) * off;
                    const ncy = base.y + (n0y / n0l) * off;
                    const ncz = base.z + (n0z / n0l) * off;
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
                    const corner = (u, sgn) => {
                        const cxu = ncx + (midP.x - ncx) * u;
                        const cyu = ncy + (midP.y - ncy) * u;
                        const czu = ncz + (midP.z - ncz) * u;
                        let ax2 = ux + (vx2 - ux) * u;
                        let ay2 = uy + (vy2 - uy) * u;
                        let az2 = uz + (vz2 - uz) * u;
                        const al2 = Math.hypot(ax2, ay2, az2) || 1;
                        const hwu = (nearHW + (hw - nearHW) * u) * sgn;
                        return project(cxu + (ax2 / al2) * hwu,
                            cyu + (ay2 / al2) * hwu,
                            czu + (az2 / al2) * hwu);
                    };
                    // SUBDIVIDED, for DEPTH. As one quad a rung carries a single
                    // sort key across ~7 A, so it cannot order correctly against
                    // everything it overlaps and rungs crossed each other wrongly.
                    // Pieces sort individually. (It also tracks the ~50 deg twist
                    // instead of flattening it.)
                    // The seams this used to leave are handled where the pieces
                    // are drawn - see the hairline stroke in the plate branch.
                    const nseg = subFloor(NA_PLATE_SEG);
                    for (let s = 0; s < nseg; s++) {
                        const u0 = s / nseg, u1 = (s + 1) / nseg;
                        const quad = [corner(u0, -1), corner(u0, 1),
                            corner(u1, 1), corner(u1, -1)];
                        if (quad.some((q) => !q)) continue;
                        // offscreen pieces are skipped: exact corners, so the
                        // pad only needs the outline stroke's reach
                        {
                            const m2 = outlineW + 4;
                            let x0c = Infinity, y0c = Infinity;
                            let x1c = -Infinity, y1c = -Infinity;
                            for (const q of quad) {
                                if (q[0] < x0c) x0c = q[0];
                                if (q[0] > x1c) x1c = q[0];
                                if (q[1] < y0c) y0c = q[1];
                                if (q[1] > y1c) y1c = q[1];
                            }
                            if (x1c < -m2 || x0c > displayWidth + m2
                                || y1c < -m2 || y0c > displayHeight + m2) continue;
                        }
                        let zs = 0, pes = 0;
                        for (const q of quad) { zs += q[2]; pes += q[3]; }
                        prims.push({ kind: 'plate', q: quad, z: zs / 4, c: col,
                            pe: pes / 4, face: Math.abs(az), th });
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
                if (ci) mk(pi, fi, ci);
                if (cj) mk(pj, fj, cj);
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
        prims.sort((a, b) => a.z - b.z);
        if (renderer._phase) { renderer._phase.prims = prims.length;
            renderer._phase.sorted = (typeof performance !== 'undefined' ? performance.now() : 0); }
        // First pass: record the earliest draw order at every joint. A
        // primitive whose order IS the minimum at a joint is drawn before all
        // its neighbours there, so its round cap gets covered by them.
        for (let o = 0; o < prims.length; o++) {
            const g = prims[o];
            if (!g.joints) continue;
            g.order = o;
            for (const key of g.joints) {
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
                } else if (g.kind === 'plate') {
                    tri2(g.q[0], g.q[1], g.q[2]);
                    tri2(g.q[0], g.q[2], g.q[3]);
                } else if (g.kind === 'line' && g.pA && g.pB) {
                    cap2(g.pA, g.pB, (g.w + outlineW) / 2 - 1);
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
        const ribHidden = (g) => {
            const nsH = g.Lp.length;
            for (let s = 0; s < nsH; s++) {
                if (!exportHidden(g.Lp[s]) || !exportHidden(g.Lm[s])
                    || !exportHidden(g.Rp[s]) || !exportHidden(g.Rm[s])) return false;
            }
            return true;
        };

        ctx.lineJoin = 'round';
        for (const g of prims) {
            const near = nearOf(g.z);
            // export culling: a piece whose every sampled corner is clearly
            // behind other geometry paints nothing visible - skip it entirely
            if (exportHidden) {
                if (g.kind === 'rib' && ribHidden(g)) continue;
                if (g.kind === 'plate' && g.q.every(exportHidden)) continue;
                // strokes kept by the interval culling's safety pad but lying
                // fully outside the canvas: nothing of them can show
                if (g.kind === 'tube' || (g.kind === 'line' && g.pA && g.pB)
                    || (g.kind === 'dot' && g.pA)) {
                    const mOut = (g.kind === 'dot' ? g.r
                        : g.kind === 'line' ? g.w / 2
                            : Math.max(1.5, g.tubeA * 2 * scale * g.pe) / 2)
                        + outlineW + 2;
                    const P = g.kind === 'tube' ? g.pts
                        : g.kind === 'line' ? [g.pA, g.pB] : [g.pA];
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
                    const gc = (rich && g.ss === 'E') ? SHEET_EDGE_RGB : g.c;
                    ctx.lineWidth = 1;
                    ctx.lineJoin = 'round';
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
                        // sides are constant-lum since the edge-shading
                        // purge, so this is solid in practice; keep the
                        // gradient path for when edge-band shading returns
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
                if (outlineW && (g.capStart || g.capEnd)) {
                    ctx.strokeStyle = inkOf(g, nearS);
                    ctx.lineWidth = Math.max(2, outlineW);
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
                const capCol = shade((rich && g.ss === 'E') ? SHEET_EDGE_RGB : g.c,
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
                    const nL = isTop ? lb : -lb;
                    const inner = isTop ? k : -k;
                    let q = LIGHT_AMB + LIGHT_DIFF * Math.max(0, nL);
                    // inner shadow scales the diffuse AND the highlight, as it
                    // did when the two were one expression
                    const shadowF = inner > 0
                        ? 1 - innerShade * (innerMul === undefined ? 1 : innerMul)
                            * Math.min(1, inner)
                        : 1;
                    q *= shadowF;
                    let w = Math.min(1, Math.max(0, a) / 0.35);
                    w *= Math.min(1, Math.max(0, (1 - Math.abs(t)) / 0.3));
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
                    // NOTE for anyone adding a `back` colour for another class:
                    // a helix curves hard enough for this call to be decisive
                    // (|kAvg| median 0.87, nothing below 0.02), but flat strands
                    // sit AT zero half the time - a back colour on E would pick
                    // a side from sign noise and flicker under rotation.
                    const inward = (isTop ? kAvg : -kAvg) > 0;
                    let fc = g.c;
                    if (inward) {
                        const hue = (ssColor && ssPal.back) ? ssPal.back[g.ss] : null;
                        if (hue) {
                            fc = hue;
                        } else if (rich && g.ss === 'H') {
                            // no explicit two-tone in this palette: synthesise
                            // one by tinting toward white. Cached on the prim -
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
                if (outlineW) {
                    ctx.strokeStyle = inkOf(g, near);
                    ctx.lineWidth = Math.max(1.4, outlineW * 0.55);
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    strokePath(g.pts);
                }
            } else if (g.kind === 'plate') {
                // Flat quad: fill, then ink the rim. Tone follows how face-on
                // the plate is (same 0.72-1.0 ramp the slab faces use) so a
                // plate seen edge-on pales into the page instead of staying a
                // hard slab, and lum follows the light like every other
                // surface - both gated by lightOn via faceTone's own switch.
                const a = Math.min(1, Math.max(0, g.face));
                const tv = soft(0.72 + 0.28 * a);
                const lv = soft(LIGHT_AMB + LIGHT_DIFF * (0.35 + 0.65 * a));
                const body = shade(g.c, near, 1, tv, lv);
                // THICKNESS by stroke dilation rather than a 6-face box. A
                // base plate is thin, and viewed along the helix axis it is
                // seen almost edge-on - as a zero-width quad it collapses to a
                // hairline and reads as a stick. Stroking the quad outline
                // with the fill colour at the plate's thickness widens it by
                // exactly that amount in every direction, so edge-on it is a
                // solid band and face-on it is unchanged. Six real faces would
                // cost 6x the fills for a difference only visible at grazing.
                // Ink the two LONG edges only. A cross edge at the centre drew a
                // line straight across every rung where its two halves meet -
                // they are one base pair, so there is nothing to divide - and one
                // at the backbone drew over a join already covered by the slab.
                // With no cross edges the subdivision cuts are invisible too:
                // neighbouring segments simply continue the same two edges.
                const longEdges = () => {
                    ctx.beginPath();
                    ctx.moveTo(g.q[1][0], g.q[1][1]); ctx.lineTo(g.q[2][0], g.q[2][1]);
                    ctx.moveTo(g.q[3][0], g.q[3][1]); ctx.lineTo(g.q[0][0], g.q[0][1]);
                };
                ctx.lineJoin = 'miter';
                ctx.miterLimit = 2;
                ctx.lineCap = 'butt';
                if (outlineW) {
                    ctx.strokeStyle = inkOf(g, near);
                    ctx.lineWidth = outlineW;
                    longEdges();
                    ctx.stroke();
                }
                // Fill AND hairline-stroke in the same colour. Neighbouring
                // pieces share an edge exactly, and two abutting fills still let
                // the background through as an antialiasing seam - a thin line
                // ruled across the rung. The ribbon's own quads are painted this
                // way for the same reason (see fillQuadSafe).
                ctx.fillStyle = body;
                ctx.strokeStyle = body;
                ctx.beginPath();
                ctx.moveTo(g.q[0][0], g.q[0][1]);
                for (let k = 1; k < 4; k++) ctx.lineTo(g.q[k][0], g.q[k][1]);
                ctx.closePath();
                ctx.fill();
                ctx.lineWidth = 1;
                ctx.stroke();
            } else if (g.kind === 'tube') {
                const lw = Math.max(1.5, g.tubeA * 2 * scale * g.pe);
                if (outlineW) {
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
                const tubeBands = (!lightOn || lw < 3)
                    ? 0 : (cel ? celLevels : 4);
                ctx.lineCap = 'round';
                if (tubeBands < 2) {
                    ctx.strokeStyle = shade(g.c, near, LOOP_DIM);
                    ctx.lineWidth = lw;
                    strokePath(g.pts);
                } else {
                    // Per-point screen normal, signed toward the light.
                    // The tube's own points carry the direction dependence,
                    // so the GEOMETRY (how far each band is pushed toward the
                    // light) varies smoothly along and ACROSS primitives.
                    //
                    // The band TONES are deliberately constant - identical for
                    // every tube in the scene. An earlier version scaled them
                    // by the primitive's mean |n.L|, which made each residue
                    // interval a slightly different tone; once quantized, that
                    // stepped at whichever intervals happened to straddle a
                    // level boundary, and the loops read as a chain of visibly
                    // separate segments. Tone must not depend on anything
                    // per-primitive, or the seams come back.
                    const P = g.pts;
                    const last = P.length - 1;
                    const push = new Array(P.length);
                    // ext[i+1] === P[i] when every sample projected; then the
                    // ends get a true central difference from the neighbour
                    // interval's territory instead of a one-sided one.
                    const E = (g.ext && g.ext.length === P.length + 2
                        && g.ext.every(Boolean)) ? g.ext : null;
                    for (let i = 0; i <= last; i++) {
                        const a = E ? E[i] : P[Math.max(0, i - 1)];
                        const b = E ? E[i + 2] : P[Math.min(last, i + 1)];
                        let tx = b[0] - a[0];
                        let ty = b[1] - a[1];
                        const m = Math.hypot(tx, ty);
                        if (m < 1e-6) { push[i] = [0, 0, 0, 0, 0]; continue; }
                        tx /= m; ty /= m;
                        // screen normal (perpendicular), signed toward light
                        const nx = -ty;
                        const ny = tx;
                        const d = nx * LIGHT_SCREEN[0] + ny * LIGHT_SCREEN[1];
                        push[i] = [nx * Math.sign(d), ny * Math.sign(d),
                            Math.abs(d), tx, ty];
                    }
                    // band 0 = full width at the shadow tone, then inward
                    const half = lw / 2;
                    for (let k = 0; k < tubeBands; k++) {
                        const t = k / (tubeBands - 1);          // 0 shadow -> 1 lit
                        let q = LIGHT_AMB + LIGHT_DIFF * t;
                        if (hiGain > 0 && t > 0.999) {
                            q += LIGHT_HI * hiGain;
                        }
                        if (cel) {
                            q = quant(q, LIGHT_AMB,
                                LIGHT_AMB + LIGHT_DIFF + LIGHT_HI * hiGain);
                        }
                        ctx.strokeStyle = shade(g.c, near, LOOP_DIM, 1, q);
                        ctx.lineWidth = Math.max(1, lw * (1 - 0.8 * t));
                        const bandHalf = ctx.lineWidth / 2;
                        if (k === 0) {
                            strokePath(P);
                        } else {
                            // offset stays inside the tube: the band's own
                            // half-width never crosses the silhouette, so the
                            // black outline is never overpainted.
                            const off = (half - bandHalf) * t;
                            const shifted = P.map((p, i) => [
                                p[0] + push[i][0] * push[i][2] * off,
                                p[1] + push[i][1] * push[i][2] * off,
                            ]);
                            // LONGITUDINAL EXTENSION. Round caps reach half a
                            // LINE WIDTH past each end, so a narrow highlight
                            // band covers far less of the joint than the
                            // full-width shadow band beneath it. The next
                            // tube's shadow band then erased the previous
                            // tube's highlight over the difference, dashing
                            // the stripe. Extending each narrow band along the
                            // tangent by exactly that difference makes every
                            // band span the same arc, so a tube always repaints
                            // a COMPLETE cylinder over any joint it covers.
                            // Butt caps fixed the dashes too, but left wedge
                            // gaps on the outside of every turn, because
                            // lineJoin does not apply between separate paths.
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
                    }
                }
            } else if (g.kind === 'line') {
                const pts = [[g.x1, g.y1], [g.x2, g.y2]];
                if (outlineW) {
                    const ink = inkOf(g, near);
                    ctx.lineCap = 'butt';
                    ctx.strokeStyle = ink;
                    ctx.lineWidth = g.w + outlineW;
                    strokePath(pts);
                    const r = (g.w + outlineW) / 2;
                    if (capAt(g, g.joints[0])) blackCap(g.x1, g.y1, r, ink);
                    if (capAt(g, g.joints[1])) blackCap(g.x2, g.y2, r, ink);
                }
                ctx.lineCap = 'round';
                ctx.strokeStyle = g.flat
                    ? `rgb(${g.c.r},${g.c.g},${g.c.b})`
                    : shade(g.c, near, 1);
                ctx.lineWidth = g.w;
                strokePath(pts);
            } else { // dot
                if (outlineW) {
                    ctx.beginPath();
                    ctx.arc(g.x1, g.y1, g.r + outlineW / 2, 0, Math.PI * 2);
                    ctx.fillStyle = inkOf(g, near);
                    ctx.fill();
                }
                ctx.beginPath();
                ctx.arc(g.x1, g.y1, g.r, 0, Math.PI * 2);
                ctx.fillStyle = shade(g.c, near, 1);
                ctx.fill();
            }
        }

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
        if (perfectInk && outlineW && inkCurves.length) {
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
                    rasterTri(q[0], q[1], q[2]);
                    rasterTri(q[0], q[2], q[3]);
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
                } else if (g.kind === 'plate') {
                    // Base plates OCCLUDE. Without this the grid only knows
                    // about ribbons and tubes, so the backbone's outline - drawn
                    // in this final pass and tested only against what the grid
                    // holds - stayed visible straight through any rung in front
                    // of it. The plate quad is already four projected corners,
                    // which is exactly what addQuad consumes.
                    addQuad(g.q, 0);
                } else if (g.kind === 'line' && g.pA && g.pB) {
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
                    addCapsule(g.pA, g.pB, (g.w + outlineW) / 2 - 1);
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
                        if (triHides(o.q[0], o.q[1], o.q[2], x, y, z, eps)
                            || triHides(o.q[0], o.q[2], o.q[3], x, y, z, eps)) return true;
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
            ctx.lineWidth = Math.max(1.4, outlineW * 0.55);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            // One batched path per ink colour. With tint 0 every curve inks
            // black and this collapses to the single path it always was;
            // with a tint the curves group by element colour instead.
            // Grouped by FADED colour: each curve's depth (mean z, the same
            // scale the fills use) picks one of 12 fade levels, so background
            // outlines pale with their fills instead of floating full-black
            // over ghost geometry. 12 levels keeps stroke batching coarse.
            const inkGroups = new Map();
            for (const cv of inkCurves) {
                let zSum = 0;
                for (const q2 of cv.pts) zSum += q2[2];
                const nearQ = Math.round(nearOf(zSum / cv.pts.length) * 11) / 11;
                const key = inkColor(cv.c, inkTint, nearQ);
                let arr = inkGroups.get(key);
                if (!arr) { arr = []; inkGroups.set(key, arr); }
                arr.push(cv);
            }
            let _strokeMs = 0;
            for (const [inkCss, group] of inkGroups) {
            ctx.strokeStyle = inkCss;
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
                let open = false;
                for (let s = 0; s < nSeg; s++) {
                    let draw = okAt(s) && onCanvas(s);
                    if (draw && (s === 0 || !okAt(s - 1)
                        || s + 1 >= nSeg || !okAt(s + 1))) {
                        if (hidden(pts[s][0], pts[s][1], pts[s][2],
                            cv.gs0 + s * cv.gsStep)
                            || hidden(pts[s + 1][0], pts[s + 1][1],
                                pts[s + 1][2],
                                cv.gs0 + (s + 1) * cv.gsStep)) draw = false;
                    }
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
            ctx.stroke();
            if (_ph) _strokeMs += _pt() - _s0;
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
            let tile = renderer._pencilTile;
            if (!tile) {
                const TS = 128;
                tile = document.createElement('canvas');
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
                    tile = null;
                }
            }
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
        if (renderer.screenX && renderer.screenX.length >= n) {
            for (let i = 0; i < n; i++) {
                if (!vis(i)) { renderer.screenValid[i] = 0; continue; }
                const v = rotated[i];
                const A = project(v.x, v.y, v.z);
                if (!A) { renderer.screenValid[i] = 0; continue; }
                renderer.screenX[i] = A[0];
                renderer.screenY[i] = A[1];
                renderer.screenRadius[i] = Math.max(2, baseLineWidthPixels * 0.25 * A[3]);
                renderer.screenValid[i] = fid;
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
        // way to see or fix it. (width is the one deliberate exception - see
        // _lineWidthUserSet in viewer-mol.js: it follows the style only until
        // the user drags the slider, because ribbon shares it.)
        richardson: {
            width: RICH_WIDTH_DEFAULT,
            outlineWidth: 3.0,
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
            width: 3.0,
            outlineWidth: 3.0,
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
            width: 3.0,
            outlineWidth: 0,
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
    STYLE_DEFAULTS.ribbon = STYLE_DEFAULTS.cartoon;

    // ---- 'ss' COLOR MODE ---------------------------------------------------
    // Colour by secondary structure, in the convention the Richardson drawings
    // use: strands green, helices blue, loops a paler blue-grey. Registered as
    // a normal custom colour mode, so it works with any style - it is only
    // grouped here because this file owns the SS assignment.
    //
    // Reuses renderer._cartoonSec when the cartoon path has already built it.
    // Colours are resolved BEFORE the draw stage, so on the very first paint of
    // a viewer that cache does not exist yet; rather than return grey and
    // depend on a second render to self-correct, it computes the assignment
    // itself using the same run-splitting rule (consecutive backbone protein
    // positions, minimum 5 residues) and caches it the same way.
    // Sampled to sit where the drawings do: a saturated but LIGHT royal blue
    // for helices and a spring green for strands. The first pass was noticeably
    // darker - shade() dims everything by depth on top of these, so the base
    // colours have to start lighter than the intended on-screen result.
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
        // Jane Richardson palettes (numbered; more of her schemes may join).
        // jr1: the blue/green convention - royal-blue helices, spring-green
        // strands; nucleic in warm amber so a protein-DNA complex separates
        // at a glance.
        jr1: {
            H: { r: 92, g: 112, b: 222 },
            E: { r: 96, g: 244, b: 166 },
            C: { r: 122, g: 142, b: 224 },
            N: { r: 235, g: 178, b: 100 },
            L: { r: 150, g: 150, b: 150 },
        },
        // jr2: her 1981 hand-coloured drawings (Anatomy and Taxonomy of
        // Protein Structures): green strand arrows and TWO-TONE brown helix
        // spirals - the outside of the ribbon dark umber, the inside a warm
        // tan, so the spiral reads as a twisted band rather than a flat
        // corkscrew. Loops are the same dark brown as the helix outside.
        // Values sampled from a photograph of one of the paintings: the
        // saturated warm pixels are sharply bimodal, ~(106,85,63) for the
        // outer faces against ~(203,171,109) for the inner, with almost
        // nothing between. Base pigments here sit brighter than those
        // samples because the renderer's own tone/luminance terms multiply
        // down from the base. Nucleic in a dusty slate that stays outside
        // the protein's warm range.
        jr2: {
            H: { r: 124, g: 96, b: 62 },
            E: { r: 102, g: 196, b: 137 },
            C: { r: 134, g: 106, b: 74 },
            N: { r: 130, g: 148, b: 186 },
            L: { r: 168, g: 120, b: 82 },
            // ribbon undersides, by SS class (see paintFace)
            back: {
                H: { r: 216, g: 184, b: 124 },
            },
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
        predictBackbone, predictBaseFrames, assignSecondary, buildSheetFrames, localFrame,
        STYLE_DEFAULTS, SS_PALETTES };
    // Near-white, not pure white: a pure white edge disappears into the page.
    const SHEET_EDGE_RGB = { r: 244, g: 246, b: 240 };
    const secForColor = (renderer) => {
        const n = renderer.coords ? renderer.coords.length : 0;
        if (!n) return null;
        const key = `${renderer.currentObjectName}|${renderer.currentFrame}|${n}`
            + `|${renderer.overlayState && renderer.overlayState.enabled}`;
        if (renderer._cartoonSec && renderer._cartoonSecKey === key) {
            return renderer._cartoonSec;
        }
        if (renderer._ssColorSec && renderer._ssColorKey === key) {
            return renderer._ssColorSec;
        }
        // Same call the draw stage makes, so the colours cannot disagree with
        // the geometry: colouring from a different pipeline used to tint the
        // last residue of every helix as coil while the ribbon drew it as helix.
        const assigned = assignSecondary(renderer.coords, n, renderer.positionTypes);
        const sec = assigned.sec;
        renderer._ssColorSec = sec;
        renderer._ssColorKey = key;
        return sec;
    };
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
