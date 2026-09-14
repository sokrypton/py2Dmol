/* WebGL2 cartoon renderer - the same drawing as cartoon/geom.js, resident on
 * the GPU so that turning the model costs one draw call instead of one full
 * repaint.
 *
 * WHAT THIS IS NOT: a second cartoon renderer. It does not decide where a
 * ribbon goes, how wide it is, which way a helix faces or what colour anything
 * takes. It asks cartoon/geom.js for its primitives ONCE, lifts them back
 * into model space, and re-paints them from any angle. Every shading rule in
 * here is a port of a rule in that file, arrived at by measuring one against
 * the other - see tests/GPU3D_NOTES.md for what each is and why. A second
 * implementation of any of them would drift silently.
 *
 * THE CONTRACT WITH THE 2D RENDERER is three opt-in hooks, all default off:
 *   _frameProbe   emit each station's frame in MODEL space. A projected
 *                 drawing gives a frame's direction but not its SIGN.
 *   _noViewCull   keep primitives outside the viewport. Dropping them is right
 *                 for painting a frame and wrong for harvesting geometry.
 *   _probeOnly    return once the prims exist; the rest is a frame nobody sees.
 *
 * PARAMETERS ARRIVE AS AN OBJECT, never read from a document. The measurement
 * harness in tests/ builds that object from its own controls; the app builds it
 * from the renderer's own properties. One producer each, and the module has no
 * opinion about where a page keeps its state.
 */
(function () {
'use strict';

// LENGTH OF A VECTOR, WHICH IS NOT WHAT `Math.hypot` IS FOR. That builtin
// exists to survive arguments whose squares overflow or underflow a double,
// and it pays for that with a compensated summation. Nothing here is ever
// near 1e154: these are Angstroms and unit normals, and their squares live
// around 1e4. Measured over two million random triples in a 200A box the two
// answers differ 37.5% of the time, by at most 4.4e-16 relative - and ZERO of
// those differences survive `Math.fround`, which is the precision every one
// of these numbers is stored and drawn at.
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

// ---- what the consumer tells us about itself -------------------------------
// A residue map (how many backbone positions, and which generic index each
// side-chain segment belongs to), the capture canvas size, where colours come
// from, and a fallback parameter producer. All of it used to be read off the
// harness's own globals; naming it here is the whole difference between a test
// page and a module.
let resMap = { nBase: 0, sidechainMap: null };
let capW = 600;
let capH = 600;
let paletteSource = null;
let orthoVal = 1;                       // 1 = orthographic, 0 = full perspective
// DEVICE PIXELS PER DISPLAY PIXEL. The 2D renderer works in DISPLAY pixels -
// the app scales its context by the ratio and hands it CSS sizes - so the
// captured geometry and `_viewScale` are both in that space, while the WebGL
// drawing buffer is the full device size. One number reconciles them, and
// getting it wrong draws the whole structure at 1/ratio in the middle of a
// retina canvas. The harness renders 1:1 and leaves it at 1.
let pixelRatio = 1;
function setPixelRatio(k) { pixelRatio = (typeof k === 'number' && k > 0) ? k : 1; }
function setOrtho(v) { orthoVal = Math.max(0, Math.min(1, v === undefined ? 1 : v)); }
let defaultParams = () => ({});
function setResidueMap(m) { resMap = m || { nBase: 0, sidechainMap: null }; }
function setSize(w, h) { capW = w; capH = h; }
function setPaletteSource(fn) { paletteSource = fn; }
function setDefaultParams(fn) { defaultParams = fn; }
function recolour() { if (paletteSource) setPalette(paletteSource()); }

// THE PAGE BEHIND THE CANVAS. The depth blend goes toward it and the base INK
// is its opposite - a black outline vanishes on a black page, so dark mode inks
// in white. Both are the renderer's, set per frame; the harness leaves them at
// the off-white it measured against.
let PAPER = [252, 252, 250];
let INK_BASE = 0;
function setPaper(rgb, inkBase) {
    if (rgb) PAPER = rgb;
    INK_BASE = inkBase || 0;
}
function toneOf(q, c, zMin, zMax, real) {
    if (real) return [real.r, real.g, real.b];   // the renderer's own answer
    // face normal in screen space; z grows toward the eye
    const ux = q[1][0] - q[0][0], uy = q[1][1] - q[0][1], uz = q[1][2] - q[0][2];
    const vx = q[3][0] - q[0][0], vy = q[3][1] - q[0][1], vz = q[3][2] - q[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = len3(nx, ny, nz) || 1;
    nz = Math.abs(nz / nl);                       // 1 = facing the eye
    const lum = 0.72 + 0.28 * nz;
    const zc = (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4;
    const near = zMax > zMin ? (zc - zMin) / (zMax - zMin) : 1;
    const fade = 0.55 + 0.45 * near;              // far things sink toward paper
    return [0, 1, 2].map((i) => {
        const base = [c.r, c.g, c.b][i] * lum;
        return Math.round(base * fade + PAPER[i] * (1 - fade));
    });
}

// Every filled face the cartoon emits as a quad, with its own corner depths.
// Which residue a primitive belongs to. `gs0` is an ATOM index on a stick and a
// backbone position on a ribbon, so a side-chain atom has to be mapped back to
// the residue that owns it - which is exactly what sidechainMap records.
function residueOf(p) {
    // AN EXPLICIT RESIDUE WINS. gs0 is a position with a sub-station offset on
    // top - `res + s / nseg` for a base plate - and rounding that lands on the
    // NEXT residue for every slice past the midpoint. On the last residue it
    // lands one past the end, and the visibility lookup below is a texelFetch:
    // out of range returns 0 in WebGL2, which reads as "hidden", so half of the
    // terminal base pair was culled in every nucleic structure. The 2D pass has
    // no visibility texture, which is why it was GPU-only.
    if (p.resId !== undefined) return p.resId;
    const g = p.gs0;
    if (g === undefined) return 0;
    if (!resMap || g < resMap.nBase) return Math.round(g);
    const sc = resMap.sidechainMap && resMap.sidechainMap.get(Math.round(g));
    return sc ? sc.owner : Math.round(g);
}

/**
 * @param consume  drop each prim as it is read. The prim list is the largest
 *   thing the capture allocates - 37,637 prims and 89 MB on 4UG0, 288,611 and
 *   541 MB on a capsid - and it is alive through the whole of this function on
 *   top of the faces it is being turned into. Emptying the array afterwards,
 *   which is what the caller used to do, frees it one pass too late to matter.
 *   OPT-IN, because emptying a caller's array is a surprising thing for a
 *   function to do and the lab harnesses read their prims back.
 */
function facesOf(prims, prm, consume) {
    const P0 = prm || defaultParams();
    const skipKinds = {};
    const lines = [];
    let palComplete = true;
    const faces = [];
    let skipped = 0;
    let pieces = 0;
    for (let pi = 0; pi < prims.length; pi++) {
        const p = prims[pi];
        if (consume) prims[pi] = null;
        if (p.kind === 'rib' && p.Lp) {
            const ns = p.Lp.length;
            // oK is ub·k - the inner-ness of the +b face, and the one shading
            // input that does not depend on the camera, so it travels as a
            // scalar rather than being rebuilt from geometry.
            let kAvg = 0;
            if (p.oK) { for (let i = 0; i < p.oK.length; i++) kAvg += p.oK[i]; kAvg /= p.oK.length; }
            const mean = (a) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t / a.length; };
            const bAvg = p.oB ? mean(p.oB) : 0;
            const lbAvg = p.oLb ? mean(p.oLb) : 0;
            const tAvg = p.oT ? mean(p.oT) : 0;
            // A THICKNESS BAND IS LIT BY THE WIDTH NORMAL, not the face
            // normal, so its `exact inputs` dots are the renderer's oN/oLn -
            // NOT oB/oLb. Feeding a side the broad face's numbers made the
            // control that exists to separate "port wrong" from "capture
            // imprecise" quietly wrong itself on a quarter of the surfaces.
            const nAvg = p.oN ? mean(p.oN) : 0;
            const lnAvg = p.oLn ? mean(p.oLn) : (p.oN ? mean(p.oN) : 0);
            // IS THIS PIECE A FLAT SHEET? Richardson gives a helix zero
            // thickness (RICH_TH_REL H: 0), so its +b and -b faces are the
            // SAME surface. Emitting both puts two coincident quads in the
            // depth buffer, which z-fight: the painter draws them in a fixed
            // order so the outer one always wins, a depth test picks per pixel
            // and the pale inner face breaks through in patches. That is the
            // "some helices painted all lighter".
            //
            // A sheet has one side facing you at a time, so it is emitted once
            // and the shader decides which side it is looking at.
            // PER STATION, NOT PER PIECE. This asked whether the WHOLE piece
            // was flat, and a piece that runs from a zero-thickness helix into
            // a solid loop is not - so neither of its two coincident faces was
            // culled at the flat end, and they z-fought: the pale inner face
            // breaking through the coloured outer one in patches. Measured on
            // 1UBQ, 5 of 201 ribbon pieces have thickness varying from full to
            // exactly zero along their length, and every one of them is a helix
            // meeting its neighbour.
            //
            // A QUAD spans two stations, so it is coincident when BOTH of its
            // ends are - which is the flag the shader actually wants.
            const thinAt = [];
            for (let k = 0; k < ns; k++) {
                thinAt.push(len3(p.Lp[k][0] - p.Lm[k][0], p.Lp[k][1] - p.Lm[k][1],
                    p.Lp[k][2] - p.Lm[k][2]) <= 0.02);
            }
            // BOTH SURFACES, ALWAYS. A sheet has two sides and they carry
            // different colours - the outer keeps the element's, the inner is
            // tinted toward white. What a zero-thickness piece must NOT do is
            // leave them fighting for the same depth; each is simply culled
            // when it is the side turned away, which the shader decides per
            // frame. Merging them into one quad loses the second colour and
            // measured worse.
            const surfaces = [
                [p.Lp, p.Rp, 1],      // +b face
                [p.Lm, p.Rm, 0],      // -b face
                [p.Lp, p.Lm, 1],      // the two width faces; they take the
                [p.Rp, p.Rm, 0],      // same treatment, and vanish at zero
            ];
            // ONE TONE PER PIECE, not per sub-quad. The flat path paints the
            // whole strip as a single path with a colour derived from the
            // piece's AVERAGED frame (bAvg, kAvg, lbAvg, tAvg over its
            // stations), so shading each sub-quad from its own normal disagrees
            // with the reference almost everywhere - which is what the first
            // 73% was. Faces are tagged with their piece so the mean frame can
            // be computed once the geometry is in model space.
            const rich = P0.rich;
            const tintWhite = (c, fr) => ({ r: c.r + (255 - c.r) * fr,
                g: c.g + (255 - c.g) * fr, b: c.b + (255 - c.b) * fr });
            // CAPS: the flat rim at a piece end. Missing entirely until now,
            // so every end was reference-only pixels.
            const capC = (rich && (p.ss === 'E' || p.naRung))
                ? { r: 244, g: 246, b: 240 } : (p.c || { r: 140, g: 160, b: 200 });
            // The outward normal of a start cap is -T and of an end cap +T,
            // which is what the renderer's oT test is checking. Carrying the
            // captured facing lets the mesh orient them once and cull per view.
            const capSlot = p.ci !== undefined && p.ciPalette ? p.ci * 3 : -1;
            const capMode = capSlot < 0 ? 0
                : ((rich && (p.ss === 'E' || p.naRung)) ? 2 : 0);
            // A CAP AT THE ARROW'S SEAM IS NOT AN END, so it must not be
            // outlined. The barbs are cut off the shaft into their own piece,
            // and the piece is capped there like any other - a full-width quad
            // across the base of the arrowhead. Its rim is the diagonal line
            // across the barb base: the inner arrow line, arriving from the cap
            // rather than from the broad faces, which is why suppressing the
            // cross edge on those alone did not remove it.
            //
            // The face is kept and only its INK vetoed. It still closes the
            // solid and still writes depth; noInk kills the whole edge, so the
            // broad faces that share it cannot re-introduce the line either.
            if (p.capStart) {
                faces.push({ res: residueOf(p), q: [p.Lp[0], p.Lm[0], p.Rm[0], p.Rp[0]], c: capC, cap: 1,
                    pal: capSlot,
                    colMode: capMode,
                    noInk: p.seam0 ? 1 : 0,
                    top: 1, kAvg: 0, iMul: 1, nl: -(p.oT ? p.oT[0] : 0) });
            }
            if (p.capEnd) {
                const e = ns - 1;
                faces.push({ res: residueOf(p), q: [p.Lp[e], p.Lm[e], p.Rm[e], p.Rp[e]], c: capC, cap: 1,
                    pal: capSlot,
                    colMode: capMode,
                    noInk: p.seam1 ? 1 : 0,
                    top: 1, kAvg: 0, iMul: 1, nl: (p.oT ? p.oT[e] : 0) });
            }
            const pieceId = pieces++;
            // The two stations either side of an arrow's barb step. The seam is
            // sampled twice, so the step occupies stations 0 and 1 of the piece
            // that starts there (and the last two of the piece that ends there).
            // IS THIS STATION THE ARROW'S BARB STEP? Asked in ABSOLUTE station
            // numbers, because the piece-relative form could not answer it: the
            // step is not always at the start or end of a piece - depending on
            // where the interval's other cuts fall it can be a piece all of its
            // own, and then the pieces either side never knew they touched a
            // seam and drew a cross-section each. That is the double line.
            //
            // The seam occupies two stations, seamA and seamA+1, because the
            // renderer samples that point twice: once at shaft width, once at
            // barb width.


            const seamAbs = p.seamA === undefined ? -1 : p.seamA;
            const stBase = p.st0 || 0;
            const seamSt = (i) => seamAbs >= 0
                && (stBase + i === seamAbs || stBase + i === seamAbs + 1);
            for (let k = 0; k + 1 < ns; k++) {
                for (let si = 0; si < surfaces.length; si++) {
                    const [A, B, top] = surfaces[si];
                    // TWO-TONE HELIX. Richardson hand-coloured the inside of a
                    // spiral pale, and the renderer synthesises that by tinting
                    // the INNER face 0.68 toward white - chosen by concavity,
                    // not by which label the face carries. The inner shadow is
                    // then eased on exactly those faces, or the two would say
                    // the same thing twice and drag the pale face back to mud.
                    const base = p.c || { r: 140, g: 160, b: 200 };
                    const isSide = si >= 2;
                    const canTint = rich && p.ss === 'H' && !p.co;
                    // SHEET EDGES ARE WHITE in the Richardson convention: an
                    // arrow reads as a plate of white card with a coloured
                    // face, and the pale rim is what separates strands where
                    // they overlap. Only the THICKNESS faces change.
                    const edgeWhite = isSide && rich && (p.ss === 'E' || p.naRung);
                    // ...AND ITS HALF WITH IT. A stick face has always read
                    // `ci * 3 + half`; a rib face read `ci * 3` alone, so where
                    // an interval is cut by a colour change both halves
                    // addressed the same texel and the far one drew the near
                    // one's colour. That is why ss mode and per-residue
                    // overrides had to bake instead of look up.
                    const slot = (p.ci !== undefined && p.ciPalette)
                        ? p.ci * 3 + (p.ciHalf || 0)
                        : (palComplete = false, -1);
                    // 🔴 CANDIDACY IS BAKED, THE DECISION IS NOT. Whether a
                    // face CAN take the pale inner tint is topological - a
                    // broad face of an uncoloured Richardson helix - and holds
                    // for as long as the secondary structure does. WHICH of
                    // the two broad faces gets it is geometry, and changes
                    // whenever the ribbon rolls.
                    //
                    // Baking the decision is what put the pale face on the
                    // OUTSIDE of a helix on a held mesh: the instance row
                    // carries the colour, the station fast path never rewrites
                    // that row, and by the second frame of a trajectory frame
                    // 0's answer is wrong. Freezing it harder does not help -
                    // aK, the shade multiplier and the colour were pinned
                    // together and the pale face simply stayed wrong for the
                    // whole playback. So the decision moves to the shader,
                    // where it is taken from THIS frame's aK on both paths.
                    const twoCand = !isSide && rich && p.ss === 'H' && !p.co;
                    const inward = (top ? kAvg : -kAvg) > 0;
                    const twoTone = twoCand && inward;
                    faces.push({ res: residueOf(p),
                        q: [A[k], B[k], B[k + 1], A[k + 1]],
                        // ...and a CANDIDATE's baked colour is the untinted
                        // base, because the shader applies the tint. It is the
                        // fallback for a face whose palette slot the renderer
                        // could not report, and tinting here as well would
                        // apply 0.68 toward white twice.
                        c: edgeWhite ? { r: 244, g: 246, b: 240 }
                            : ((twoTone && !twoCand) ? tintWhite(base, 0.68) : base),
                        // a sheet carries BOTH colours and picks at draw time
                        cIn: canTint ? tintWhite(base, 0.68) : base,
                        cOut: base,
                        // COINCIDENT HERE? That is a fact about a STATION, not
                        // about a quad. A quad that runs from a zero-thickness
                        // helix into a solid loop is coincident at one end and
                        // genuinely two-sided at the other, and asking it as
                        // one question has to be answered wrong at one end:
                        // say yes and half a solid face is culled, say no and
                        // the pale inner face z-fights the coloured outer one
                        // at the thin end - which is the pale sliver along a
                        // helix at the angle where the two faces are within a
                        // depth-buffer step of each other. Asked per station
                        // and interpolated, the cull switches on exactly where
                        // the slab actually closes up.
                        sheetA: (!isSide && thinAt[k]) ? 1 : 0,
                        sheetB: (!isSide && thinAt[k + 1]) ? 1 : 0,
                        canTint: canTint ? 1 : 0,
                        // BACK_INNER_SHADE. A candidate's is decided in the
                        // shader beside its tint, from the same sign, so that
                        // the two can never disagree - which they did when one
                        // was frozen and the other fresh.
                        iMul: (twoTone && !twoCand) ? 0.3 : 1,
                        side: isSide ? 1 : 0,
                        plate: p.naRung ? 1 : 0,
                        // A RICHARDSON SHEET IS OUTLINED ALL THE WAY ROUND.
                        // The default rule inks a ribbon along its rails and
                        // never across it, because a line across a helix
                        // wherever its face rolls edge-on is a true silhouette
                        // of the surface and not a line the reference draws.
                        // A richardson strand is a solid slab and reads as one,
                        // so its ends belong to its outline the same way a base
                        // plate's do - and the other presets keep the sparse
                        // rule, which is what keeps their interiors clean.
                        //
                        // This does NOT put a line at every station: an
                        // interior cross edge has two adjacent faces with the
                        // same normal, so the silhouette test drops it. Only a
                        // real boundary survives, which is the outline.
                        //
                        // ARROWHEADS INCLUDED - excluding them was too blunt.
                        // The one line that must not be drawn is the cross edge
                        // AT THE SEAM, where the barbs meet the shaft: the
                        // interval is cut there, so inking across that boundary
                        // draws a line over the full barb width, which is the
                        // inner arrow line. Everything else on an arrow is real
                        // outline - the shaft's bottom rail, the barb's own
                        // edges, the crease between the broad face and the side
                        // - and excluding the whole piece took all of it with
                        // the one line it was aimed at.
                        // 🔴 AND THIS IS THE LAST LETTER-DEPENDENT THING IN THE
                        // MESH THAT IS NOT PER-FRAME. It decides how many EDGES
                        // a face contributes (see alongOnly), and the edge table
                        // is built once with the mesh - so a residue that stops
                        // being a strand keeps the strand's creases until
                        // something else forces a rebuild.
                        //
                        // Measured on _traj_unfold.pdb, a folding trajectory
                        // whose assignment moves constantly, as the worst fast
                        // step against the same frame rebuilt: 0.1991% of the
                        // frame at a worst channel of 146, against 0.0287% when
                        // the arrowhead was still forcing rebuilds that covered
                        // it. tests/station_unpinned.py is the gate and its bar
                        // is a fraction of what the step itself moves.
                        //
                        // What would remove it: emit every rich ribbon face's
                        // full edge set and suppress the creases per frame from
                        // the piece texture - the trick colMode already uses for
                        // the two-tone and the pale strand side, two lines up.
                        // That roughly doubles the edge table for every
                        // structure, so it is a trade and not a free fix. The
                        // other half of the trade is in tests/PERF_NOTES.md.
                        fullOutline: (rich && p.ss === 'E') ? 1 : 0,
                        // THE 2D USES A SCREEN-SPACE RULE HERE, not a facing
                        // one, and this says where. emitSlabInk is called with
                        // outerOnly = true for a rung, a square loop and every
                        // ribbon outside richardson: keep only the corners whose
                        // projection is EXTREME across the chain, so an interior
                        // crease corner - which is never extreme - draws no
                        // line. The facing test cannot make that guarantee, and
                        // the two disagree near grazing, which is where a base
                        // plate spends most of its time.
                        // ONE RULE, THE REFERENCE'S. cartoon/geom.js passes
                        // emitSlabInk `squareLoop || !rich` for a ribbon and
                        // always `true` for a rung, so this is that expression
                        // rather than an approximation of it.
                        //
                        // Dropping the rung term was tried - letting a plate
                        // take the same rule as a helix or a sheet - to see
                        // whether the extreme test's degeneracy on a broadside
                        // plate was behind the inner lines there. It changed
                        // nothing visible, so it is not that, and the special
                        // case is back because matching the reference is worth
                        // more than a divergence that bought no improvement.
                        outerOnly: (p.squareLoop || !rich || p.naRung) ? 1 : 0,
                        // ...so the seam quad's cross edges are held back -
                        // BOTH of them, which is the part that took a second
                        // look. The seam station is sampled twice (the renderer
                        // pushes arrowU at the end of the shaft's run and again
                        // at the start of the barbs'), so the quad at the seam
                        // is the STEP itself: no length along the chain, and a
                        // width that jumps from shaft to barb. Its near cross
                        // edge is the shaft's cross-section and its far one is
                        // the barb's, and BOTH are interior to the base of the
                        // arrow. Ghosting only the near one left the far one -
                        // the full barb width - which is the inner arrow line.
                        //
                        // Its RAILS are kept, and they are the two shoulders:
                        // each runs from a shaft corner out to a barb corner,
                        // which is the step's own silhouette and the only part
                        // of the base that should be drawn.
                        // ...AND FROM BOTH SIDES, which is the second half of
                        // it. An edge is ghosted per FACE, and the step quad's
                        // far cross edge is shared with the next quad along -
                        // which is an ordinary one and claims it as real, so the
                        // edge survived and still inked. Worse, the step quad's
                        // normal points along the chain, so the two disagree by
                        // ~90 degrees and the crease rule promotes the edge to
                        // "always draw". Ghosting has to cover every face that
                        // touches the two seam stations, not just the step.
                        gA: seamSt(k) ? 1 : 0,
                        gB: seamSt(k + 1) ? 1 : 0,

                        top, kAvg, oT: tAvg, pieceId, surf: si, st: k,
                        // THE PALETTE SLOT, and what was done to it. `c` above
                        // is the base colour after two derivations the shader
                        // can redo: a sheet edge becomes white, a helix's inner
                        // face is tinted 0.68 toward white. Emitting the slot
                        // plus which derivation applies means a new palette
                        // repaints the mesh without rebuilding it.
                        pal: slot,
                        // ...AND ONLY WHEN THERE IS A SLOT TO REDO IT FROM.
                        // `c` above is ALREADY derived - a helix's inner face
                        // is already tinted 0.68 toward white. Where the slot
                        // exists the shader replaces the base with the raw
                        // palette colour first, so its derivation is the only
                        // one. Where it does not - ss mode, or any per-residue
                        // override, both of which report ciPalette false - the
                        // baked colour is all there is, and asking for the
                        // derivation again applied 0.68 twice: 0.898 toward
                        // white, which is the inner face of every helix coming
                        // out visibly too pale in SSE colouring.
                        // 3 = a two-tone CANDIDATE, decided per frame in the
                        // shader. Unlike 1 and 2 it does not need a palette
                        // slot: with no palette the shader tints aBase, which
                        // is why the baked colour above stays untinted.
                        colMode: twoCand ? 3
                            : (slot < 0 ? 0 : (edgeWhite ? 2 : (twoTone ? 1 : 0))),
                        // THE RENDERER'S OWN FRAME at this quad's two stations,
                        // in model space. Its sign is the renderer's, so there
                        // is nothing left to decide.
                        ubA: p.ub && p.ub[k], ubB: p.ub && p.ub[k + 1],
                        waA: p.wa && p.wa[k], waB: p.wa && p.wa[k + 1],
                        tvA: p.tv && p.tv[k], tvB: p.tv && p.tv[k + 1],
                        // sides carry the width-normal pair, faces the b pair;
                        // surf 3 is the -n side, so its dots are negated
                        oB: isSide ? (si === 2 ? nAvg : -nAvg) : bAvg,
                        oLb: isSide ? (si === 2 ? lnAvg : -lnAvg) : lbAvg,
                        // THE CENTRE LINE, not a rail. oT is the dive of the
                        // ribbon's own tangent, and faceLum divides by
                        // (1 - |t|)/0.3 - so near a dive a rail's direction
                        // instead of the centre's swings the convergence factor
                        // several-fold and the tone with it. Measured on one
                        // piece: rail -0.99 against the renderer's -0.929,
                        // which is w = 0.03 against 0.24.
                        tan: [
                            (A[k + 1][0] + B[k + 1][0] - A[k][0] - B[k][0]) / 2,
                            (A[k + 1][1] + B[k + 1][1] - A[k][1] - B[k][1]) / 2,
                            (A[k + 1][2] + B[k + 1][2] - A[k][2] - B[k][2]) / 2,
                        ],
                    });
                }
            }
        } else if (p.kind === 'stickFace' && p.q) {
            // KEEP THE FACES THE RENDERER CULLED. `draw` is false for a face
            // that pointed away AT THE CAPTURE VIEW, and dropping those bakes
            // one camera into the mesh: rotate the resident model and the back
            // of every stick is missing, because it was never uploaded. A
            // resident mesh has to carry the whole solid and cull per frame,
            // which is what the shader does below.
            //
            // Buried faces come along too and cost nothing: they are inside a
            // closed box, so the depth buffer hides them without being asked.
            // THE PRIM'S OWN nl (face normal . LIGHT) IS CARRIED so the
            // normal can be oriented. A quad's winding does not say which way
            // its face points, and for a stick that is fatal rather than
            // cosmetic: the wrong sign makes max(0, n.L) clamp to zero, the
            // knee is never crossed, and the side chain gets no highlight at
            // all - which is exactly how they looked.
            faces.push({ res: residueOf(p), sc: p.sc ? 1 : 0,
                q: p.q, c: p.c || { r: 200, g: 140, b: 60 },
                top: (p.surf === 1) ? 0 : 1,
                kAvg: 0,
                stick: 1,
                stationed: (p.stA && p.stB) ? 1 : 0,
                surf: p.surf,
                // A FLAT STICK IS ONE DOUBLE-SIDED QUAD. At zero thickness -
                // which plain cartoon asks for, because flatness IS its look -
                // the box collapses to a single face with nothing behind it,
                // and the renderer's rule for it is `orient it at the eye`.
                // That is a per-view decision, so it cannot be baked: carried
                // as a flag, the shader redoes it every frame. Without it the
                // stick cull deleted every side chain the moment the model
                // turned past the capture view.
                two: p.two ? 1 : 0, iMul: 1, nl: p.nl,
                // ONE FLAT COLOUR, no light. A contact is drawn as a solid so
                // it can attach to the ribbon and be occluded properly, but it
                // is an annotation and not made of anything - see `unlit` in
                // cartoon/geom.js. Shading it here while the 2D pass leaves
                // it flat is the two renderers disagreeing about what the thing
                // IS, which is the one disagreement that matters.
                unlit: p.unlit ? 1 : 0,
                // THE SQUARE THAT LIES ON THE BACKBONE. Painted like any other
                // face and never outlined: a side chain is part of its residue,
                // not an object standing on it, and a ring of ink around the
                // join draws it as a seam. See scBase in cartoon/geom.js.
                noInk: p.base ? 1 : 0,
                pal: p.ci !== undefined ? p.ci * 3 + (p.half || 0) : -1, colMode: 0,
                tan: [p.q[1][0] - p.q[0][0], p.q[1][1] - p.q[0][1], p.q[1][2] - p.q[0][2]] });
        } else if (p.kind === 'joint' && p.q && p.q.length >= 3) {
            for (let k = 1; k + 1 < p.q.length; k++) {
                faces.push({ res: residueOf(p), sc: p.sc ? 1 : 0,
                    q: [p.q[0], p.q[k], p.q[k + 1], p.q[0]],
                    c: p.c || { r: 200, g: 140, b: 60 }, top: 1, kAvg: 0, stick: 1,
                    stationed: p.pts ? 1 : 0,
                    surf: 6,
                    // A JUNCTION PLATE IS NEVER INKED, because it is not inked
                    // in the 2D pass either - and there the reason is explicit
                    // twice over: a joint prim carries no ink curves at all,
                    // and a leg's end cut is only stroked at a FREE end
                    // (`if (e.end === 0 && !prim.free0) continue`), which a
                    // junction is not. So nothing is drawn where three bonds
                    // meet, and the legs' own sides carry the outline.
                    //
                    // This pass derives its edges from geometry and has no idea
                    // what a free end is, so the plate's boundary - which lies
                    // exactly along the legs' end cuts - came out as strokes
                    // down the sides of the junction. At zero thickness the
                    // plate is double-sided, so those edges are drawn whatever
                    // way the model is turned. Hence lines at every three-way
                    // side-chain branch. noInk vetoes the whole edge, including
                    // where a leg claims the same one.
                    noInk: 1,
                    // the junction plate goes the same way as the legs it
                    // bridges: emitted once and eye-oriented at zero thickness
                    two: p.two ? 1 : 0, iMul: 1,
                    // WITHOUT THIS THE JUNCTION DOES NOT REPAINT. A three-way
                    // side-chain junction is a plate bridging its legs, and a
                    // face with no palette slot keeps whatever colour was baked
                    // when the mesh was built - so recolouring left the plates
                    // behind as wrong-coloured triangles while the legs around
                    // them changed. It takes the slot of the leg it bridges.
                    pal: p.ci !== undefined ? p.ci * 3 + (p.half || 0) : -1,
                    colMode: 0,
                    nl: p.nl,
                    tan: [p.q[k][0] - p.q[0][0], p.q[k][1] - p.q[0][1], p.q[k][2] - p.q[0][2]] });
            }
        } else if (p.kind === 'dot' && p.pA && p.rA > 0) {
            // A LONE ATOM - a metal ion, most often - IS A BALL, and the GPU
            // had no way to draw one: `dot` fell through to the skip list, so
            // every ion was simply absent from the GPU frame while the 2D pass
            // drew it. Measured on 1EHZ, {dot: 9} skipped - six magnesiums and
            // three manganeses, gone; on the 1TF6 zinc fingers, all six zincs.
            //
            // ONE QUAD, TURNED TO FACE THE EYE IN THE VERTEX SHADER, with the
            // circle and its two tones solved in the fragment. A real sphere of
            // facets was tried first and is the wrong drawing: this renderer
            // draws a lone atom as a flat disc with concentric bands (see
            // fillRound), and a lit, smoothly-shaded ball put a piece of a
            // different picture into the frame. It also cost ~50 faces an atom
            // against this one, which is 240 of them on a capsid.
            //
            // The quad is emitted as a SQUARE of the ball's diameter about the
            // centre, in projected space like every other prim, so it
            // unprojects to a square in model space and the mesh's own
            // machinery - bounds, depth range, visibility - all still work on
            // it. The shader keeps only its centre and half-diagonal.
            const R = p.r;                       // pixels, at the capture depth
            const cx = p.pA[0], cy = p.pA[1], cz = p.pA[2];
            faces.push({ res: residueOf(p),
                q: [[cx - R, cy - R, cz], [cx + R, cy - R, cz],
                    [cx + R, cy + R, cz], [cx - R, cy + R, cz]],
                c: p.c || { r: 200, g: 140, b: 60 }, top: 1, kAvg: 0, iMul: 1,
                // the shader shades it as a ball, so the mesh must not shade it
                // as a quad: unlit passes the base colour through untouched
                unlit: 1, disc: 1,
                // ...and the square's own four edges are not an outline. The
                // disc's rim is drawn by the fragment shader, which is the only
                // thing that knows where the circle actually is.
                noInk: 1,
                pal: p.ci !== undefined ? p.ci * 3 : (palComplete = false, -1),
                colMode: 0, tan: [1, 0, 0] });
        } else if (p.kind === 'line' && p.pts && p.pts.length > 1) {
            // A FLAT STROKE - a contact, or a bond with no box. It is not a
            // surface and never was: the renderer draws it as a bright line of
            // its own width, from either side, and that is annotation rather
            // than structure. Carried whole and turned into ink instances once
            // the geometry is in model space.
            // ...WITH THE DEPTH BIAS AND THE ANGSTROM WIDTH, both of which
            // this dropped. A contact's projected z carries a near-surface
            // bias (geom.js: zBias) and the unprojection below takes it back
            // off - except it never arrived, so `zb` was always 0 and the
            // correction was dead code. The bias then unprojects into MODEL
            // space as half an Angstrom toward the eye, along whichever way
            // the view happened to be pointing when the mesh was built, and
            // turns with the structure from then on: the contact sits right
            // until you rotate, and snaps back the next time anything rebuilds
            // the mesh. Which is what "the old contact moves when I add
            // another one" is.
            //
            // wA went the same way, leaving the width to fall back to pixels
            // over the capture's scale - wrong under zoom.
            lines.push({ pts: p.pts, c: p.c || { r: 90, g: 90, b: 90 },
                w: p.w || 1, wA: p.wA, zBias: p.zBias || 0, sel: !!p.sel });
        } else {
            skipped++;                            // tubes, dots, ribStrokes
            skipKinds[p.kind] = (skipKinds[p.kind] || 0) + 1;
        }
    }
    // WHAT THE MESH DOES NOT HOLD, by kind. Anything here is simply absent from
    // the GPU frame, which is how contacts and the round backbone tube went
    // missing without a word.
    window.__gpuSkipped = skipKinds;
    // ...and whether every face could be repainted from the palette. A prim
    // whose colour did NOT come from `colors` - an ss-mode colour, or any
    // per-residue override, which is what a selection is - reports ciPalette
    // false and carries a baked colour instead. The mesh can still draw it; it
    // just cannot RECOLOUR it, so a colour change has to rebuild.
    window.__gpuPaletteComplete = palComplete;
    return { faces, skipped, lines, paletteComplete: palComplete };
}

/* ------------------------------------------------------------------- CPU */

function paintCPU(cv, faces, zMin, zMax) {
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    // painter's algorithm: the faces in the order the renderer sorted them
    for (const f of faces) {
        const t = toneOf(f.q, f.c, zMin, zMax, f.real);
        g.fillStyle = `rgb(${t[0]},${t[1]},${t[2]})`;
        g.beginPath();
        g.moveTo(f.q[0][0], f.q[0][1]);
        for (let i = 1; i < f.q.length; i++) g.lineTo(f.q[i][0], f.q[i][1]);
        g.closePath();
        g.fill();
    }
}

/* ------------------------------------------------------------------- GPU */

// PyMOL'S CLIP, IN THE FRAGMENT.
//
// A slab in camera space: keep what lies between uClipFar and uClipNear along
// view z and discard the rest. Per FRAGMENT, not per face, because that is what
// makes it a CUT - a ribbon crossing the plane is drawn up to it and stops, and
// the interior it exposes is open to the camera. Dropping whole faces instead
// would only remove geometry near the plane, which is hiding, not clipping.
//
// Off is uClipNear <= uClipFar, which no live slab can be (setClipSlab keeps
// them half an Angstrom apart), so one comparison turns the whole thing off.
//
// AND A SOFT EDGE, IF ONE IS ASKED FOR. uClipFade is the width in Angstrom over
// which coverage ramps 1 -> 0 outside each plane; 0 is the knife.
//
// Partial coverage is drawn by DROPPING PIXELS, not by blending: a 4x4 ordered
// dither, so a half-covered fragment keeps half its pixels and those write
// depth like any other. Blended fills would need back-to-front order this path
// does not keep - a ghost in front of the slab would paint over what should
// show through it - and this needs no order at all, is exact against whatever
// is behind it, and at export resolution the pattern is finer than the ink.
const CLIP_GLSL = `
uniform float uClipNear, uClipFar, uClipFade;
// 1 inside the slab, 0 past the fade, a straight ramp between. The mirror of
// the renderer's own clipCoverage - the two are tested against each other.
float clipCover(float z) {
  if (uClipNear <= uClipFar) return 1.0;
  float d = min(uClipNear - z, z - uClipFar);
  if (d >= 0.0) return 1.0;
  if (uClipFade <= 0.0) return 0.0;
  return max(0.0, 1.0 + d / uClipFade);
}
// COVERAGE FROM TWO SOURCES, THROUGH ONE DITHER. The slab's is a function of
// depth; a ghosted residue's is a constant it carries from the vertex stage.
// They compose by taking the smaller - a residue at 30% inside the slab is 30%
// covered, and one outside it is gone either way - and the pattern below is
// unchanged, so a fade costs no second pass and no ordering.
bool clipped(float z, float fade) {
  float c = min(clipCover(z), fade);
  if (c >= 1.0) return false;
  if (c <= 0.0) return true;
  // Bayer 4x4, in SCREEN space so the pattern does not swim as the model turns
  const float BAYER[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0);
  ivec2 pxy = ivec2(gl_FragCoord.xy);
  int bi = (pxy.y - (pxy.y / 4) * 4) * 4 + (pxy.x - (pxy.x / 4) * 4);
  return c < (BAYER[bi] + 0.5) / 16.0;
}
// ...and the old spelling, for every pass that has nothing to fade.
bool clipped(float z) { return clipped(z, 1.0); }
`;

const VS = `#version 300 es
in vec2 aPos; in float aZ; in vec3 aCol;
uniform vec2 uSize; uniform vec2 uZRange;
out vec3 vCol;
out float vCull;      // the shared fragment shader reads it; nothing to cull here
out float vZv;        // view z, for the clip slab in the fragment
out float vFade;      // ...and likewise: this pass has no residue to ghost
// DECLARED BECAUSE THE FRAGMENT SHADER IS SHARED, not because this pass has
// discs. A varying the fragment reads and no vertex shader writes does not
// warn, it fails the LINK - and since both programs are built in one try
// block, the whole GPU path falls back to the 2D one with a single line in the
// console. Every disc lives in the VS3D pass; here they are always off.
out vec2 vDisc;
out float vIsDisc;
void main() {
  vDisc = vec2(0.0);
  vIsDisc = 0.0;
  vec2 ndc = vec2(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0);
  // z grows toward the eye, so NEAR must become SMALL depth for gl.LESS
  float t = (aZ - uZRange.x) / max(1e-6, uZRange.y - uZRange.x);
  gl_Position = vec4(ndc, 1.0 - 2.0 * t, 1.0);
  vCol = aCol;
  vCull = 0.0;
  vZv = aZ;
  vFade = 1.0;
}`;

// RESIDENT GEOMETRY. The mesh is uploaded ONCE in model space and the camera is
// a uniform, which is the whole structural argument for a 3D port: the ribbon
// is a function of coordinates and secondary structure, not of the view, so
// turning it should not rebuild it. Recovering the model mesh from the
// captured primitives is possible because the projection is ORTHOGRAPHIC and
// therefore invertible - see unproject().
//
// The tone is computed here rather than on the CPU, from the rotated face
// normal, because a resident mesh has no CPU pass left to compute it in. This
// is the first piece of shade() actually living in a shader.
// THE RENDERER'S OWN SHADING, ported. Every input faceLum() and faceTone()
// take is a dot product of the ribbon's LOCAL FRAME with either the view
// direction or the fixed light:
//
//   oB  = ub·v     the ±b face's facing        oLb = ub·L   face normal · light
//   oT  = t·v      the tangent's dive          oK  = ub·k   inner-ness, view-FREE
//
// so the frame is all that has to travel. It is recoverable from the face
// itself - ub is the face normal, t runs along the strip - which is why this
// can be done from captured geometry at all. Rotating those two vectors by the
// camera reproduces the dots exactly, and the rest is shade() transcribed.
const VS3D = `#version 300 es
// ONE INSTANCE PER FACE: the quad's four corners and the frames at its two
// ends, with the corner chosen off gl_VertexID. Per-face values are then
// stored once instead of six times - see the emit for what that saved.
in vec3 aC0; in vec3 aC1; in vec3 aC2; in vec3 aC3;
in vec3 aNA; in vec3 aNB; in vec3 aTA; in vec3 aTB;
in vec3 aBase;
// Ten per-face scalars, packed three-to-a-vec4. WebGL2 allows 16 vertex
// attributes; declared singly these wanted 18 and the program simply failed to
// link. They are unpacked into their own names at the top of main, so the rest
// of the shader is unchanged.
in vec4 aFlags0;        // k, top, iMul, stick
in vec4 aFlags1;        // side, cap, sheet, residue
in vec4 aFlags2;        // palette slot, colour mode, -, -
out float vCull;
out float vZv;        // view z, for the clip slab in the fragment
out float vFade;      // this residue's coverage, 1 unless it has been ghosted
// where in a lone atom's disc this corner is, and whether it is one
out vec2 vDisc;
out float vIsDisc;
in vec3 aDots;          // captured oB, oLb, oT - only true at the capture view
in vec3 aFlatN;         // the FACE's own OUTWARD normal, constant over it
in vec3 aFlatShade;     // ...and the normal a FLAT face shades from
uniform mat3 uRot; uniform vec2 uSize; uniform vec2 uZRange; uniform vec2 uShadeRange;
uniform float uScale; uniform vec3 uPaper;
// WHERE THE VIEW IS CENTRED, as an offset from where it was centred when the
// mesh was captured - model space, so it goes in before the rotation. Orient
// moves the centre onto a selection; without this the mesh stays framed on
// whatever it was built around. Zero on every frame that has not moved it.
uniform vec3 uShift;
uniform float uPersp, uFL;      // 0 = orthographic; uFL is the focal length
uniform float uFlatCull;
uniform float uShowRibbon, uShowSticks;
uniform sampler2D uVis;     // one texel per residue: 0 hides it
uniform float uVisW;
uniform float uVisN;    // how many residues the texture actually holds
uniform sampler2D uPal;     // three texels per segment: base, half a, half b
uniform float uPalW;
uniform float uShadeAmt, uInnerShade, uHiGain, uKnee, uDepthFloor, uCel, uExact;
// the STANDARD knee, for sticks - richardson's broad one does not apply to a solid
uniform float uStickKnee;
out vec3 vCol;

const vec3 LIGHT = normalize(vec3(-0.45, 0.6, 0.75));
const float LIGHT_AMB = 0.72, LIGHT_DIFF = 0.28, LIGHT_HI = 0.22;
const float FLAT_TONE = 0.72;

float soft(float v) { return 1.0 + (v - 1.0) * uShadeAmt; }

// CEL. It is on whenever cartoonSmooth is not true, which is the lab's case
// and the plain cartoon's, and it quantises BOTH the facing tone and the
// luminance into 8 bands before they reach shade(). A smooth shader against a
// banded reference disagrees on almost every pixel by a little - which is
// exactly what the first measurement showed.
const float CEL_LEVELS = 8.0;
float quant(float v, float lo, float hi) {
  if (hi - lo < 1e-9) return v;
  float t = clamp((v - lo) / (hi - lo), 0.0, 1.0);
  return lo + (floor(t * (CEL_LEVELS - 1.0) + 0.5) / (CEL_LEVELS - 1.0)) * (hi - lo);
}

float faceTone(float b, float isTop) {
  float a = isTop > 0.5 ? b : -b;
  return soft(0.72 + 0.28 * clamp(a / 0.4, 0.0, 1.0));
}

float faceLum(float lb, float k, float isTop, float a, float t, float iMul,
        float flatCard) {
  float nL = isTop > 0.5 ? lb : -lb;
  // A CARD IS LIT FROM WHICHEVER SIDE YOU SEE. nL is the OUTWARD normal against
  // the light, which is right for an opaque surface - a face turned away from
  // the light does not catch a highlight. A ribbon twists, so its normals sweep
  // through the light and every part of it lights somewhere.
  //
  // A base plate cannot. Every plate in a duplex is normal to the SAME axis, so
  // nL has one sign for all of them at once: point that axis away from the
  // light and not one plate highlights, at any Hilite setting, while their thin
  // sides - whose normals run across the rung - light normally. That is the
  // reported bug, and it is not a slider problem, it is orientation.
  //
  // The plate is a card with the same colour on both faces, so it takes the
  // light two-sided.
  if (flatCard > 0.5) nL = abs(nL);
  float inner = isTop > 0.5 ? k : -k;
  float q = LIGHT_AMB + LIGHT_DIFF * max(0.0, nL);
  float shadowF = inner > 0.0 ? 1.0 - uInnerShade * iMul * min(1.0, inner) : 1.0;
  q *= shadowF;
  // flatCard = a base plate: it never turns edge-on the way a ribbon does, so
  // the convergence damper does not apply. Its normal runs along the helix
  // axis, which is perpendicular to the view for any side-on look at a duplex,
  // and w collapsed to zero there - no modelling and no highlight.
  float w = flatCard > 0.5 ? 1.0
      : min(1.0, max(0.0, a) / 0.35) * min(1.0, max(0.0, 1.0 - abs(t)) / 0.3);
  float LUM_NEUTRAL = LIGHT_AMB + LIGHT_DIFF * 0.5;
  float base = soft(LUM_NEUTRAL + (q - LUM_NEUTRAL) * w);
  if (uHiGain > 0.0 && nL > uKnee) {
    return base + LIGHT_HI * uHiGain * ((nL - uKnee) / (1.0 - uKnee)) * w * shadowF;
  }
  return base;
}

// shade(rgb, near, dim=1, extra=tone, lum)
vec3 shadeCol(vec3 rgb, float near, float extra, float lum) {
  float f = (uDepthFloor + (1.0 - uDepthFloor) * near) * extra;
  float mul = lum < 1.0 ? lum : 1.0;
  float hi = lum > 1.0 ? min(1.0, lum - 1.0) : 0.0;
  vec3 c = (rgb * f + uPaper * (1.0 - f)) * mul;
  return (hi > 0.0 ? c + (255.0 - c) * hi : c) / 255.0;
}

void main() {
  float aK = aFlags0.x, aTop = aFlags0.y, aIMul = aFlags0.z, aStick = aFlags0.w;
  float aSide = aFlags1.x, aCap = aFlags1.y, aRes = aFlags1.w;
  // aFlags2.z packs four flags: 1 = double-sided, 2 = unlit, 4 = base plate,
  // 8 = a lone atom's disc.
  // All per-face booleans, bit-packed into the one spare slot.
  float aPal = aFlags2.x, aColMode = aFlags2.y;
  // 🔴 THE TWO-TONE, DECIDED HERE AND NOT BAKED. aColMode 3 marks a face that
  // CAN take the pale inner tint - a broad face of an uncoloured Richardson
  // helix - and this is where it finds out whether it does. aK is the piece's
  // concavity, and on the station path it is refetched from the piece texture
  // every frame, so this follows the geometry rather than the frame the mesh
  // was built at.
  //
  // BOTH the tint and the inner-shade multiplier come off the one sign, so
  // they cannot disagree. They could before: the colour was baked into the
  // instance row and aK was read fresh beside it, which drew a face tinted
  // pale by the build frame and shaded as the outside by this one.
  float twoNow = (aColMode > 2.5 && (aTop > 0.5 ? aK : -aK) > 0.0) ? 1.0 : 0.0;
  float aIMulE = aColMode > 2.5 ? (twoNow > 0.5 ? 0.3 : 1.0) : aIMul;
  float aTwo = mod(aFlags2.z, 2.0) > 0.5 ? 1.0 : 0.0;
  float aPlate = mod(floor(aFlags2.z / 4.0), 2.0) > 0.5 ? 1.0 : 0.0;
  float aDisc = mod(floor(aFlags2.z / 8.0), 2.0) > 0.5 ? 1.0 : 0.0;
  // BIT 2, not ">= 2". This read the whole field as a magnitude, which was
  // right while it held only bits 1 and 2 (z was 0..3, so z >= 2 meant bit 2).
  // Adding the plate bit made z = 4 for every base plate and the test then
  // called it unlit - which skips the lighting outright, so no plate responded
  // to the Hilite slider at all. Extract the bit.
  float aUnlit = mod(floor(aFlags2.z / 2.0), 2.0) > 0.5 ? 1.0 : 0.0;
  // two triangles over the quad's four corners; 0 and 1 sit at the near
  // station, 2 and 3 at the far one, which is what picks the frame
  // drawn with an index buffer, so gl_VertexID IS the corner (see quadIdx)
  //
  // 🔴 ...BUT WHICH DIAGONAL SPLITS THE QUAD IS DECIDED BY THE GEOMETRY, NOT
  // BY THE LABELS. The index buffer cuts along 0-2. A ribbon frame's sign is a
  // direction, not an orientation - geom.js's loop pass negates a whole element
  // whenever that keeps a loop's twist under 90 degrees, and on a moving
  // structure that decision sits on a knife edge (dp crossing zero between two
  // frames). Negating the frame relabels the corners 0<->1 and 2<->3, so the
  // same four points were cut along the OTHER diagonal: a twisted quad is not
  // planar, so its silhouette moved and its normals blended across a different
  // pair of triangles - a loop's sides trading light and dark from one frame to
  // the next. The SHORTER diagonal names the same two points whichever way the
  // labels run. Rotating the labels by one keeps the winding, and everything
  // below reads the rotated label, so near and far still pick the right frame.
  int corner = gl_VertexID;
  {
    vec3 e02 = aC2 - aC0;
    vec3 e13 = aC3 - aC1;
    if (dot(e02, e02) > dot(e13, e13)) corner = (corner + 1) % 4;
  }
  // coincident at THIS end of the quad - corners 0 and 1 sit at the near
  // station, 2 and 3 at the far one, the same split the frames use. Declared
  // after the corner index because GLSL does not hoist: one line earlier
  // and the program does not link and the whole path falls back silently.
  float aSheet = (corner == 0 || corner == 1) ? aFlags1.z : aFlags2.w;
  vec3 aModel = corner == 0 ? aC0 : (corner == 1 ? aC1 : (corner == 2 ? aC2 : aC3));
  vec3 aNormal = (corner == 0 || corner == 1) ? aNA : aNB;
  vec3 aTangent = (corner == 0 || corner == 1) ? aTA : aTB;
  vec3 v = uRot * (aModel + uShift);
  // A LONE ATOM'S DISC FACES THE EYE, ALWAYS. The mesh is resident, so a flat
  // circle baked at the capture view would foreshorten to an ellipse and then
  // to a line as the model turned. Its four corners are placed here instead,
  // square to the screen about the centre the mesh carries - which is why the
  // quad is stored as a square: its half-diagonal IS the radius, in model
  // units, so the disc follows zoom and perspective like everything else.
  vDisc = vec2(0.0);
  vIsDisc = 0.0;
  if (aDisc > 0.5) {
    vec3 ctrD = (aC0 + aC1 + aC2 + aC3) * 0.25;
    float rD = length(aC0 - ctrD) * 0.70710678;
    vec2 loc = corner == 0 ? vec2(-1.0, -1.0)
        : (corner == 1 ? vec2(1.0, -1.0)
        : (corner == 2 ? vec2(1.0, 1.0) : vec2(-1.0, 1.0)));
    v = uRot * (ctrD + uShift) + vec3(loc * rD, 0.0);
    vDisc = loc;
    vIsDisc = 1.0;
  }
  vZv = v.z;
  // THE RENDERER'S OWN PROJECTION. pe = fl / (fl - z), applied to x and y and
  // not to z - which is what leaves z invertible on the way back in.
  float pe = uPersp > 0.5 ? uFL / max(0.1, uFL - v.z) : 1.0;
  vec2 px = vec2(uSize.x * 0.5 + v.x * uScale * pe, uSize.y * 0.5 - v.y * uScale * pe);
  vec2 ndc = vec2(px.x / uSize.x * 2.0 - 1.0, 1.0 - px.y / uSize.y * 2.0);
  float t01 = (v.z - uZRange.x) / max(1e-6, uZRange.y - uZRange.x);
  gl_Position = vec4(ndc, 1.0 - 2.0 * t01, 1.0);
  // DEPTH AND FADE ARE NOT THE SAME NUMBER, and using one for both is why the
  // Fade slider disagreed with the 2D pass by 84% of the frame.
  //
  // The depth buffer needs a range that CONTAINS every corner, or geometry
  // outside it is clipped - so uZRange is the model's bounding radius, which
  // has the further virtue of not changing as the model turns.
  //
  // The renderer's own 'near' is a different quantity: it normalises over the
  // actual span of PRIM CENTROID depths at this view, and it is one value for
  // the whole prim rather than per corner. So the shading takes its own range,
  // recomputed per frame from the face centroids, and evaluates at the face's
  // own centroid - which is what that near means.
  vec3 ctr = (aC0 + aC1 + aC2 + aC3) * 0.25;
  float cz = (uRot * (ctr + uShift)).z;
  float tShade = (cz - uShadeRange.x) / max(1e-6, uShadeRange.y - uShadeRange.x);

  // SMOOTH OR FLAT, decided here rather than when the mesh was built. uCel is
  // already "not smooth", so the switch needs no new uniform: a smooth face
  // interpolates between its two stations' normals, a flat one takes the
  // single per-face normal - which for a width band is the PIECE mean,
  // because that is what the reference quantises.
  vec3 nSrc = uCel > 0.5 ? aFlatShade : aNormal;
  vec3 ub = normalize(uRot * nSrc);
  // The per-station frame, interpolated. The SHADING reads it; the cull does
  // not - see the piece mean at the aSheet test below.
  vec3 ubTrue = normalize(uRot * aNormal);
  vec3 tg = normalize(uRot * aTangent);         // along the strip
  // THE VIEW VECTOR, which under perspective is per point rather than (0,0,1).
  // Everything the renderer calls a facing term is this dotted with a frame
  // vector, so making it a variable is the whole of the perspective port.
  vec3 vd = uPersp > 0.5
      ? normalize(vec3(-v.x, -v.y, uFL - v.z))
      : vec3(0.0, 0.0, 1.0);
  // A DOUBLE-SIDED FACE HAS NO OUTWARD DIRECTION TO FIND, so the renderer
  // orients it at the eye - which both keeps it lit and makes it always drawn.
  // Its facing is therefore a property of the VIEW, and redoing it here is the
  // whole fix: baked from the capture, a flat side chain was lit from a camera
  // that had moved on and then back-face culled outright.
  if (aTwo > 0.5 && dot(ub, vd) < 0.0) ub = -ub;
  float oB = dot(ub, vd);
  float oT = dot(tg, vd);
  float oLb = dot(ub, LIGHT);
  // THE CONTROL. Recovering the frame from a projected drawing is accurate to
  // about 0.02-0.05 in these dots, which is invisible on its own and lands a
  // face one cel band out when it falls near a boundary. Feeding the
  // renderer's own numbers instead separates "is the shading port right" from
  // "is my capture hack precise". A real port builds the frame in model space
  // and never has this error.
  if (uExact > 0.5 && aStick < 0.5) { oB = aDots.x; oLb = aDots.y; oT = aDots.z; }

  float tone, lum;
  if (aCap > 0.5) {
    // A CAP IS A CROSS-SECTION, and caps only exist in the diving regime where
    // everything converges to neutral - so the renderer gives them exactly
    // that, with no light modelling at all.
    tone = soft(FLAT_TONE);
    lum = soft(LIGHT_AMB + LIGHT_DIFF * 0.5);
  } else if (aSide > 0.5) {
    // THE THICKNESS BAND. Lit by the WIDTH normal rather than the face normal,
    // with no inner shadow and a constant edge tone - it is the white card the
    // coloured face is mounted on, not part of the modelled surface.
    tone = soft(FLAT_TONE);
    lum = faceLum(oLb, 0.0, 1.0, oB, oT, 1.0, 0.0);
    // ...and it BANDS with everything else. This quantisation was missing, so
    // in cel mode the bands stayed continuous while every other surface
    // stepped - the same hole the 2D renderer had in paintSide, in the same
    // place, found by fixing that one and asking what its mirror was here.
    // The bounds are the face bounds with the inner-shadow term at zero,
    // which is what they collapse to at k = 0: a band off the faces' ladder
    // puts a visible step along an edge that should be continuous.
    if (uCel > 0.5) {
      lum = quant(lum, soft(LIGHT_AMB), soft(1.0) + LIGHT_HI * uHiGain);
    }
  } else if (aStick > 0.5) {
    // A STICK IS A SOLID, and takes none of the ribbon's treatment: no facing
    // wash (its side faces are edge-on at every angle and the ramp would
    // bleach exactly the faces that should read as its shaded sides), no
    // inner shadow, and the standard knee rather than richardson's broad one.
    // Only the light decides. Without this a side chain came out flat.
    float nl = oLb;
    float qv = LIGHT_AMB + LIGHT_DIFF * max(0.0, nl);
    // uStickKnee is HI_KNEE, handed in rather than written as 0.55 here. The
    // value is the same; the point is that it is the reference's copy, so it
    // cannot drift the way the outline weight did.
    if (uHiGain > 0.0 && nl > uStickKnee) {
      qv += LIGHT_HI * uHiGain * (nl - uStickKnee) / (1.0 - uStickKnee);
    }
    if (uCel > 0.5) qv = quant(qv, LIGHT_AMB, LIGHT_AMB + LIGHT_DIFF + LIGHT_HI * uHiGain);
    tone = 1.0;
    lum = soft(qv);
  } else {
    float a = aTop > 0.5 ? oB : -oB;
    tone = faceTone(oB, aTop);
    lum = faceLum(oLb, aK, aTop, a, oT, aIMulE, aPlate);
    if (uCel > 0.5) {
      // the same bounds the renderer quantises between, and they track iMul
      tone = quant(tone, soft(FLAT_TONE), 1.0);
      float lo = soft(LIGHT_AMB * (1.0 - uInnerShade * max(0.0, aIMulE)));
      float hi = soft(1.0 + uInnerShade * max(0.0, -aIMulE)) + LIGHT_HI * uHiGain;
      lum = quant(lum, lo, hi);
    }
  }
  // COLOUR COMES FROM A TEXTURE, not from the vertex. aBase is still there
  // as the fallback for anything whose palette slot the renderer could not
  // report, but where the slot exists the colour is looked up - so repainting
  // the whole structure is a texture upload against a mesh that never moves.
  //
  // The two derivations are redone here rather than baked: a sheet edge is
  // white in the Richardson convention, and a helix's inner face is tinted
  // 0.68 toward white. Baking them would have meant a palette entry per
  // DERIVED colour instead of per segment.
  vec3 base = aBase;
  if (uPalW > 0.5 && aPal >= 0.0) {
    int pi = int(aPal + 0.5);
    int pw = int(uPalW);
    base = texelFetch(uPal, ivec2(pi % pw, pi / pw), 0).rgb * 255.0;
  }
  // 3 IS THE PER-FRAME ONE, and it is tested first because it is also
  // greater than 1.5 and 0.5 and would otherwise be read as a white sheet edge.
  if (aColMode > 2.5) {
    if (twoNow > 0.5) base = base + (vec3(255.0) - base) * 0.68;
  }
  else if (aColMode > 1.5) base = vec3(244.0, 246.0, 240.0);
  else if (aColMode > 0.5) base = base + (vec3(255.0) - base) * 0.68;
  // straight through: no light, no depth blend, no cel banding
  vCol = aUnlit > 0.5 ? base / 255.0 : shadeCol(base, tShade, tone, lum);
  // A CAP IS CULLED THE SAME WAY, and for the same reason the stick faces
  // were: the renderer only draws one when its outward normal (the chain
  // tangent) faces the eye, and that is a per-VIEW decision. Emitting caps
  // unconditionally put a face at every piece end that the reference does not
  // draw at that angle.
  // CULLING IS PER FACE, NEVER INTERPOLATED. aFlatN is the face's own normal
  // and is identical at all six of its vertices, so vCull comes out constant
  // and the fragment test cannot cut a face part-way.
  //
  // It used to be computed from the SHADING normal, which is welded per vertex
  // and therefore varies across the face. Where it crossed zero the two
  // coincident faces of a flat sheet were each clipped at a slightly different
  // place, neither covered the seam, and paper showed through - a pale band
  // across the ribbon at a residue boundary.
  vec3 fn = normalize(uRot * aFlatN);
  // SHOW/HIDE IS A UNIFORM, not a rebuild. The mesh holds every face already,
  // so hiding a class is a clip at the vertex stage - no capture, no upload,
  // and no fragment work for what is hidden.
  float show = aStick > 0.5 ? uShowSticks : uShowRibbon;
  // PER-RESIDUE VISIBILITY, read from a texture rather than baked into the
  // mesh. Adding or removing one residue's side chain is then a single texel
  // write - the geometry is already there, it was only being masked.
  // 🔴 THE TEXEL IS A COVERAGE AND NOT A FLAG. It was read as one - anything
  // under a half hid the residue - and every value between is a per-residue
  // OPACITY now, carried to the fragment stage and dropped through the same
  // ordered dither the clip slab already fades with. Zero still hides, which
  // is what every caller of it meant, and 1 still draws solid; nothing about
  // the mesh changes for any value in between, because the geometry was
  // always there and was only ever being masked.
  vFade = 1.0;
  if (show >= 0.5 && uVisW > 0.5) {
    // clamped: an out-of-range texelFetch returns 0, which reads as hidden, so
    // a stray index does not silently delete geometry
    int ri = clamp(int(aRes + 0.5), 0, int(uVisN) - 1);
    int w = int(uVisW);
    float cover = texelFetch(uVis, ivec2(ri % w, ri / w), 0).r;
    if (cover <= 0.0) show = 0.0; else vFade = cover;
  }
  if (show < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // ...and a double-sided face is never culled: there is no back of it to be on.
  vCull = (((aStick > 0.5 && aTwo < 0.5) || aCap > 0.5)
      && dot(fn, vd) < -0.02) ? 1.0 : 0.0;
  // A ZERO-THICKNESS PIECE has its two broad faces at the same depth, so a
  // depth test cannot separate them and the pale inner face breaks through the
  // outer one in patches - the helices that came out "all lighter". They are
  // not fighting if only the side facing the eye is drawn.
  // A zero-thickness piece keeps only the side turned toward the eye, and
  // aFlatN already points OUT of this particular face - so the pair is
  // exactly complementary by construction, rather than by an aTop/oB agreement
  // that per-vertex normals can break.
  // WHICH SIDE OF A ZERO-THICKNESS PIECE TO KEEP, and it has to be decided PER
  // FRAGMENT.
  //
  // A constant per-face normal is too coarse: a flat ribbon that twists through
  // edge-on WITHIN one quad keeps the side its first station faced for the
  // whole quad, while the next quad keeps the other - so the pale inner face
  // breaks through the coloured outer one in patches, on a plain helix with no
  // transition anywhere near it.
  //
  // The interpolated test partitions the quad exactly, and the reason is worth
  // stating: BOTH coincident faces carry the same aNormal - the +b direction -
  // with aTop saying which side each one is. So both compute the SAME oB, cross
  // zero at the same point, and one picks up precisely where the other leaves
  // off. Nothing falls through the gap because there is no gap.
  //
  // ...AND THE SIDE IS CHOSEN PER PIECE, WHICH IS WHAT THE REFERENCE DOES.
  //
  // The interpolated normal partitions a quad exactly where the surface turns
  // over, which sounds right and is not what the 2D pass draws: it paints both
  // faces of a piece back to front, keyed on bAvg - the piece MEAN - so one
  // side wins over the whole piece and a fold shows as a clean edge. Read per
  // fragment, the GPU flipped sides part-way through a piece the reference had
  // not cut, and the pale inner face came through the coloured outer one as a
  // wedge at every helix fold. That is the 6MRR report.
  //
  // aFlatShade is the piece mean for a broad face, and this branch only ever
  // sees broad faces (a side band is never marked thin). Measured over four
  // views each of 6MRR, 1TIM, 1UBQ and 3CHY: 1,047 pixels moved to agreeing
  // with the 2D pass, 149 away from it, and every structure's big-difference
  // count fell.
  //
  // window.__flatCull = true restores the per-face test.
  if (aSheet > 0.5) {
    float oBcull = dot(normalize(uRot * aFlatShade), vd);
    bool away = uFlatCull > 0.5 ? (dot(fn, vd) <= 0.0) : ((aTop > 0.5) != (oBcull > 0.0));
    if (away) vCull = 1.0;
  }
}`;

/**
 * THE SAME SHADER, FED BY STATIONS INSTEAD OF BY CORNERS.
 *
 * A ribbon face is a piece, a station and a surface - tests/station_faces.js
 * asserts that corner for corner - and a station is a model-space frame and two
 * scalars, which tests/cartoon_station.js asserts to 0.0000%. So the corners and
 * the shading frames a face needs can be READ from two stations rather than
 * stored on the face, and the per-frame upload stops being the mesh:
 *
 *     1TIM   648 KB of faces a frame  ->  87 KB of stations
 *
 * 🔴 DERIVED FROM VS3D BY SUBSTITUTION, NOT COPIED. Everything below the corner
 * fetch - the culling, the palette, shade(), the disc path - is two hundred
 * lines that must not fork: a bug fixed in one copy and not the other is a
 * picture that differs by which path drew it, which is the hardest kind of
 * difference to see. Only the ATTRIBUTES change, and the four corners and four
 * frame vectors keep their names as globals, so every line downstream is
 * untouched.
 *
 * 🔴 AND IT IS NOT BIT-IDENTICAL TO VS3D, BY CONSTRUCTION. The shipped path
 * captures corners that geom.js has already PROJECTED and buildMeshPart
 * unprojects them again; this one never leaves model space. The two agree to
 * the accuracy of that round trip and no further, so the gate compares the
 * instance rows with a tolerance - window.__fill under __gpuDiag - rather than
 * by equality.
 */
const VS3D_STATIONS = (() => {
    const src = VS3D;
    // 🔴 EVERY ATTRIBUTE THAT MOVES WITH THE GEOMETRY GOES. The corners, the
    // two ends' frames, the outward normal and the flat-shading normal are all
    // derivable from the two stations and the piece - proved slot by slot in
    // tests/station_corners.py, where nA, nB, tA, tB and the outward normal
    // come out at exactly 0.00e+00 against the rows buildMeshPart uploads.
    // What is left on the face is topology and colour, which do not move.
    // 🔴 MATCHED ON THE CODE, NEVER ON THE COMMENT BESIDE IT. tools/bundle.py
    // strips comments out of the shader literals, so a pattern that included
    // one matched in dev.html and matched nothing in the bundle - and the
    // throw below then fired at load, taking the whole painter down in the
    // built artefact while every source-loaded probe stayed green.
    // tests/bundles.js is what found it, by loading the bundle.
    const drop = [
        'in vec3 aC0; in vec3 aC1; in vec3 aC2; in vec3 aC3;\n'
        + 'in vec3 aNA; in vec3 aNB; in vec3 aTA; in vec3 aTB;',
        'in vec3 aFlatN;',
        'in vec3 aFlatShade;',
        'in vec3 aDots;',
    ];
    let out = src;
    for (const d of drop) {
        if (out.indexOf(d) < 0) {
            // A SUBSTITUTION THAT SILENTLY MATCHES NOTHING IS THE WORST
            // OUTCOME: the program links, reads an undeclared name as zero, and
            // draws an empty or unlit frame that looks like a culling bug.
            throw new Error('VS3D no longer declares verbatim: ' + d.slice(0, 40));
        }
        out = out.replace(d, '');
    }
    // 🔴 ONE LITERAL, AND IT OPENS WITH THE UNIFORMS ON PURPOSE.
    // tools/bundle.py strips comments and indentation out of shader
    // literals, but only from those that ANNOUNCE THEMSELVES as GLSL -
    // a template holding no `uniform`, `void main` or `#version` is not
    // one it will touch. Split into a declaration block and a function
    // block, the second announced nothing and twenty commented lines
    // rode into the bundle; tests/bundles.js counts them and says so.
    const block = `in float aStation;   // the NEAR station of this quad
in float aSurf;      // 0 +b, 1 -b, 2 +w, 3 -w, 4 start cap, 5 end cap
in float aPiece;     // which piece, for the two means below
uniform sampler2D uStations;  // four texels a station
uniform float uStationW;
uniform sampler2D uPieces;    // two texels a piece: nMean, wMean
uniform float uPieceW;
// The names VS3D uses, filled from the stations at the top of main.
vec3 aC0, aC1, aC2, aC3;
vec3 aNA, aNB, aTA, aTB;
vec3 aFlatN, aFlatShade, aDots;
// 🔴 THE PIECE'S CONCAVITY, FRESH. It rides in the instance row as aFlags0.x,
// which on this path is the install frame's while every normal beside it is
// this frame's - and it is a SIGN TEST: faceLum shades a face as the pale INNER
// one when it is positive. Measured over a 15-frame trajectory of 9FOG, 75 of
// 9,424 piece means cross zero, and about 11% sit within 0.05 of it. Frozen
// against fresh normals, those faces shade as the inside of a helix while the
// geometry says they are the outside.
float aKFresh;
// ...and whether this piece is a two-tone CANDIDATE, read from the piece
// texture rather than from the instance row. The row bakes it into colMode,
// and it is a secondary-structure test - see the note beside PP[po + 7].
// (No backticks in here: this is inside a JS template literal.)
float aCandFresh;

vec4 stTexel(int st, int slot) {
  int i = st * 4 + slot;
  int w = int(uStationW);
  return texelFetch(uStations, ivec2(i % w, i / w), 0);
}
vec4 pcTexel(int pc, int slot) {
  int i = pc * 2 + slot;
  int w = int(uPieceW);
  return texelFetch(uPieces, ivec2(i % w, i / w), 0);
}

void buildFromStations() {
  int k = int(aStation + 0.5);
  int surf = int(aSurf + 0.5);
  vec4 a0 = stTexel(k, 0);       vec4 a1 = stTexel(k, 1);
  vec4 a2 = stTexel(k, 2);       vec4 a3 = stTexel(k, 3);
  vec3 midA = a0.xyz; float hwA = a0.w;
  vec3 ubA  = a1.xyz; float htA = a1.w;
  vec3 waA  = a2.xyz; vec3 tvA  = a3.xyz;
  // A CAP IS THE CROSS-SECTION ITSELF, not a swept quad: one station, the four
  // corners in the order facesOf pushes them, and a normal from the winding
  // because a cap is not a rib face and buildMeshPart does not give it a frame.
  if (surf >= 4) {
    if (surf == 6) {
      aC0 = a0.xyz;
      aC1 = a1.xyz;
      aC2 = a2.xyz;
      aC3 = a3.xyz;
      vec3 wn = normalize(cross(aC1 - aC0, aC2 - aC0));
      aNA = wn; aNB = wn; aTA = vec3(0.0); aTB = vec3(0.0);
      aFlatN = wn; aFlatShade = wn; aDots = vec3(0.0);
      aKFresh = pcTexel(int(aPiece + 0.5), 0).w;
      aCandFresh = pcTexel(int(aPiece + 0.5), 1).w;
      return;
    }
    if (surf == 5) {
      aC0 = midA + waA * hwA + ubA * htA;
      aC1 = midA - waA * hwA + ubA * htA;
      aC2 = midA - waA * hwA - ubA * htA;
      aC3 = midA + waA * hwA - ubA * htA;
      aNA = tvA; aNB = tvA; aTA = tvA; aTB = tvA;
      aFlatN = tvA; aFlatShade = tvA; aDots = vec3(0.0);
      aKFresh = pcTexel(int(aPiece + 0.5), 0).w;
      aCandFresh = pcTexel(int(aPiece + 0.5), 1).w;
      return;
    }
    if (surf == 4) {
      aC0 = midA + waA * hwA + ubA * htA;
      aC1 = midA + waA * hwA - ubA * htA;
      aC2 = midA - waA * hwA - ubA * htA;
      aC3 = midA - waA * hwA + ubA * htA;
      vec3 wn = -tvA;
      aNA = wn; aNB = wn; aTA = tvA; aTB = tvA;
      aFlatN = wn; aFlatShade = wn; aDots = vec3(0.0);
      aKFresh = pcTexel(int(aPiece + 0.5), 0).w;
      aCandFresh = pcTexel(int(aPiece + 0.5), 1).w;
      return;
    }
    vec4 b0 = stTexel(k + 1, 0);   vec4 b1 = stTexel(k + 1, 1);
    vec4 b2 = stTexel(k + 1, 2);   vec4 b3 = stTexel(k + 1, 3);
    vec3 midB = b0.xyz; float hwB = b0.w;
    vec3 ubB  = b1.xyz; float htB = b1.w;
    vec3 waB  = b2.xyz; vec3 tvB  = b3.xyz;
    if (surf == 7) {
      aC0 = midA + waA * hwA + ubA * htA;
      aC1 = midA - waA * hwA + ubA * htA;
      aC2 = midB - waB * hwB + ubB * htB;
      aC3 = midB + waB * hwB + ubB * htB;
      aNA = ubA; aNB = ubB; aTA = tvA; aTB = tvB;
      aFlatN = ubA; aFlatShade = ubA; aDots = vec3(0.0);
      aKFresh = pcTexel(int(aPiece + 0.5), 0).w;
      aCandFresh = pcTexel(int(aPiece + 0.5), 1).w;
      return;
    }
    if (surf == 8) {
      aC0 = midA - waA * hwA + ubA * htA;
      aC1 = midA - waA * hwA - ubA * htA;
      aC2 = midB - waB * hwB - ubB * htB;
      aC3 = midB - waB * hwB + ubB * htB;
      aNA = -waA; aNB = -waB; aTA = tvA; aTB = tvB;
      aFlatN = -waA; aFlatShade = -waA; aDots = vec3(0.0);
      aKFresh = pcTexel(int(aPiece + 0.5), 0).w;
      aCandFresh = pcTexel(int(aPiece + 0.5), 1).w;
      return;
    }
    if (surf == 9) {
      aC0 = midA - waA * hwA - ubA * htA;
      aC1 = midA + waA * hwA - ubA * htA;
      aC2 = midB + waB * hwB - ubB * htB;
      aC3 = midB - waB * hwB - ubB * htB;
      aNA = -ubA; aNB = -ubB; aTA = tvA; aTB = tvB;
      aFlatN = -ubA; aFlatShade = -ubA; aDots = vec3(0.0);
      aKFresh = pcTexel(int(aPiece + 0.5), 0).w;
      aCandFresh = pcTexel(int(aPiece + 0.5), 1).w;
      return;
    }
    if (surf == 10) {
      aC0 = midA + waA * hwA - ubA * htA;
      aC1 = midA + waA * hwA + ubA * htA;
      aC2 = midB + waB * hwB + ubB * htB;
      aC3 = midB + waB * hwB - ubB * htB;
      aNA = waA; aNB = waB; aTA = tvA; aTB = tvB;
      aFlatN = waA; aFlatShade = waA; aDots = vec3(0.0);
      aKFresh = pcTexel(int(aPiece + 0.5), 0).w;
      aCandFresh = pcTexel(int(aPiece + 0.5), 1).w;
      return;
    }
    return;
  }
  vec4 b0 = stTexel(k + 1, 0);   vec4 b1 = stTexel(k + 1, 1);
  vec4 b2 = stTexel(k + 1, 2);   vec4 b3 = stTexel(k + 1, 3);
  vec3 midB = b0.xyz; float hwB = b0.w;
  vec3 ubB  = b1.xyz; float htB = b1.w;
  vec3 waB  = b2.xyz; vec3 tvB  = b3.xyz;
  // WHICH TWO OF THE FOUR CORNER CURVES THIS SURFACE RUNS ALONG, as signs on
  // the width and thickness axes. facesOf's table, transcribed:
  //   0: Lp,Rp   1: Lm,Rm   2: Lp,Lm   3: Rp,Rm
  vec2 sA; vec2 sB;
  if (surf == 0)      { sA = vec2( 1.0,  1.0); sB = vec2(-1.0,  1.0); }
  else if (surf == 1) { sA = vec2( 1.0, -1.0); sB = vec2(-1.0, -1.0); }
  else if (surf == 2) { sA = vec2( 1.0,  1.0); sB = vec2( 1.0, -1.0); }
  else                { sA = vec2(-1.0,  1.0); sB = vec2(-1.0, -1.0); }
  // q = [A[k], B[k], B[k+1], A[k+1]] - corners 0 and 1 at the near station,
  // 2 and 3 at the far one, which is the split VS3D's frame pick already uses.
  aC0 = midA + waA * (hwA * sA.x) + ubA * (htA * sA.y);
  aC1 = midA + waA * (hwA * sB.x) + ubA * (htA * sB.y);
  aC2 = midB + waB * (hwB * sB.x) + ubB * (htB * sB.y);
  aC3 = midB + waB * (hwB * sA.x) + ubB * (htB * sA.y);
  bool broad = (surf < 2);
  // 🔴 ONE SIGN, USED TWO WAYS. buildMeshPart's sideSign is -1 on surface 2,
  // and the frame's w is stored NEGATED - R - L runs along -wa - so the shading
  // normal is sideSign * w = -sideSign * wa while the flat normal is
  // sideSign * wMean, which is already in the w convention. Deriving both from
  // one sign got the second flipped: a unit vector exactly 2.0 from the right
  // one, every width band lit from inside the ribbon.
  float sideSign = (surf == 2) ? -1.0 : 1.0;
  aNA = broad ? ubA : (waA * -sideSign);
  aNB = broad ? ubB : (waB * -sideSign);
  aTA = tvA;
  aTB = tvB;
  // The outward normal is the shading normal flipped by which side this is;
  // aFlags0.y is the top flag, read here rather than after main unpacks it.
  aFlatN = (broad && aFlags0.y < 0.5) ? -aNA : aNA;
  int pc = int(aPiece + 0.5);
  vec3 nMean = pcTexel(pc, 0).xyz;
  vec3 wMean = pcTexel(pc, 1).xyz;
  vec3 fShade = broad ? nMean : (wMean * sideSign);
  if (broad && aFlags0.y < 0.5 && aFlags0.w > 0.5) fShade = -fShade;
  aFlatShade = fShade;
  aKFresh = pcTexel(pc, 0).w;
  aCandFresh = pcTexel(pc, 1).w;
  // 🔴 THE CAPTURED DOTS ARE NOT REBUILT, AND uExact IS THE ONLY READER. They
  // are this frame's lighting already dotted at the capture view; the shader
  // computes its own from the frames for every other path. A station table has
  // no capture view to speak of, so uExact must stay off on this path.
  aDots = vec3(0.0);
}
`;
    const mainAt = 'void main() {\n';
    if (out.indexOf(mainAt) < 0) throw new Error('VS3D has no main to enter');
    out = out.replace(mainAt, block + mainAt + '  buildFromStations();\n');
    // ...and aK comes from the piece texture rather than the instance row. It
    // is the one value in aFlags0 that is geometry rather than topology.
    const kLine = 'float aK = aFlags0.x,';
    if (out.indexOf(kLine) < 0) throw new Error('VS3D no longer reads aK from aFlags0.x');
    out = out.replace(kLine, 'float aK = aKFresh,');
    // ...and the two-tone CANDIDACY the same way, for the same reason. The row
    // bakes `colMode` 3 for a Richardson helix's broad faces, and which pieces
    // are helices is the ASSIGNMENT - so on a frame whose letters have drifted
    // since the build, the row names the wrong pieces. The piece texture is
    // rewritten every frame and carries the answer in its spare slot.
    //
    // A SIDE face is never a candidate whatever its piece is (`!isSide` in
    // facesOf), and a piece that has STOPPED being one falls back to 0 - the
    // value the else branch there would have produced, since 1 and 2 both
    // require a palette slot the candidate branch does not take.
    // 🔴 THE ANCHOR IS THE WHOLE DECLARATION, because the substitution is a
    // STATEMENT plus a declaration and the old anchor sat INSIDE one:
    // `float aPal = aFlags2.x, aColMode = aFlags2.y;`. Replacing the second
    // half with anything that declares its own variable produced
    // `float aPal = aFlags2.x, float aCandBits = ...` and the program stopped
    // linking - "0:221: 'float' : syntax error" - which tests/station_shader.py
    // says out loud and every pixel probe downstream reports as a picture that
    // moved by 15%.
    const cLine = 'float aPal = aFlags2.x, aColMode = aFlags2.y;';
    if (out.indexOf(cLine) < 0) {
        throw new Error('VS3D no longer declares aPal and aColMode together');
    }
    // ...and BOTH bits of the slot, taken apart here. Bit 1 is the two-tone
    // candidate, which only a broad face can be; bit 2 is the pale side of a
    // Richardson strand or a nucleic rung, which only a side face can be. A
    // piece that has stopped being either falls back to what the row would have
    // said with no palette slot - 0 - and never to the stale 2 or 3 baked into
    // it, which is the whole point of reading them from the piece texture.
    out = out.replace(cLine,
        'float aCandBits = floor(aCandFresh + 0.5);'
        + ' float aPal = aFlags2.x,'
        + ' aColMode = (mod(aCandBits, 2.0) > 0.5 && aSurf < 1.5) ? 3.0'
        + ' : ((mod(floor(aCandBits / 2.0), 2.0) > 0.5 && aSurf > 1.5) ? 2.0'
        + ' : (aFlags2.y > 1.5 ? 0.0 : aFlags2.y));');
    // 🔴 NO BACKTICK SURVIVES INTO THE SHADER, and this has cost two rounds.
    // The GLSL above lives inside a JS template literal, so a backtick anywhere
    // in it - quoting an attribute name in a comment, which is the natural
    // thing to write - ends the string. The failure arrives as "Unexpected
    // identifier" pointing at a word inside a comment, which reads like
    // anything but what it is. Nothing can check this at runtime, because by
    // then the string has already ended; what the check below can catch is the
    // OTHER half of the same mistake, an unbalanced brace or a lost segment.
    if (out.indexOf('buildFromStations();') < 0 || out.indexOf('void main()') < 0) {
        throw new Error('the station shader lost its entry point in assembly');
    }
    return out;
})();

// GPU HIDDEN-LINE OUTLINE.
//
// The point of difference from the renderer's `zbuf` ink backend, which was
// measured and rejected: that one keeps the analytic pass's shape - ONE binary
// visible/hidden decision per ink segment - and only swaps where the answer
// comes from. Every artefact in PERF_NOTES follows from that collapse, which is
// why supersampling the depth buffer made churn WORSE (4.74 -> 5.49) instead of
// better. You cannot supersample away a decision that was already reduced to
// one bit per segment.
//
// Here there is no query and no segment-level decision. The edge is real
// geometry and the depth test runs per FRAGMENT, so a line slides out from
// behind an occluder pixel by pixel. The failure mode changes from a segment
// blinking to a line stippling where it grazes its own surface, and stippling
// is what the depth bias (and later an ID buffer) is for.
//
// One instanced quad per edge; 6 vertices from gl_VertexID, no quad buffer.
const VSINK = `#version 300 es
precision highp float;
in vec3 aP0; in vec3 aP1; in vec3 aN0; in vec3 aN1; in float aAlways;
in float aEdgeStick;    // bit 1 = belongs to a stick, bit 2 = extreme-corner rule
in float aEdgePal;      // its palette slot, for the Ink tint
// THE COLOUR THE FACE WAS BUILT WITH, and a width multiplier. A slot is not
// always available: a prim whose colour did not come from the palette reports none
// (ss mode, any per-residue override), and the tint then had nothing to tint
// with, so the whole backbone inked black while side chains - which always
// carry a slot - tinted. This is the fallback, and it is also what lets a
// CONTACT ride through this same pass: a contact is an edge with its own colour
// and its own weight that is always drawn.
in vec3 aEdgeCol;
// 0 = an outline, and takes uWidth. Otherwise a stroke width in ANGSTROM,
// which uScale turns into device pixels - so it follows the zoom and the
// device ratio the way the geometry does, and the perspective factor the way
// the 2D pass does.
in float aEdgeW;
// WHOSE RESIDUE THIS EDGE OUTLINES, or -1 for an edge that belongs to none -
// a contact, which is annotation laid across the chain. The same coverage
// texture the fills are tested against, so an outline fades with the fill it
// draws the edge of rather than standing over a ghost at full strength.
in float aEdgeRes;
uniform sampler2D uVis;
uniform float uVisW, uVisN;
out vec3 vInk;
out float vFade;
out float vZv;        // view z, for the clip slab in the fragment
uniform mat3 uRot; uniform vec2 uSize, uZRange, uShadeRange;
uniform float uScale, uWidth, uBias, uPersp, uFL;
uniform vec3 uShift;            // see VS3D - the view centre's move since capture
uniform float uShowRibbon, uShowSticks;
uniform sampler2D uPal;
uniform float uPalW;
// the Ink control: 0 = black, 1 = the element's own colour at 0.7
uniform float uInkTint, uInkBase, uInkFloor, uBiasMax;
// how near zero a cross product counts as a handoff (see pairDraw)
uniform float uHandoff;
uniform vec3 uPaperInk;
vec2 toPx(vec3 v) {
    float pe = uPersp > 0.5 ? uFL / max(0.1, uFL - v.z) : 1.0;
    return vec2(uSize.x * 0.5 + v.x * uScale * pe, uSize.y * 0.5 - v.y * uScale * pe);
}
// facing, against the view vector at that point - (0,0,1) under ortho
bool faces(vec3 n, vec3 at) {
    vec3 vd = uPersp > 0.5 ? normalize(vec3(-at.x, -at.y, uFL - at.z)) : vec3(0.0, 0.0, 1.0);
    return dot(n, vd) > 0.0;
}
void main() {
  vInk = vec3(0.0);          // set on every path: an early return still runs
  // ...and so does this: a varying the fragment reads and a path leaves unset
  // is whatever was in the register.
  vFade = 1.0;
  if (uVisW > 0.5 && aEdgeRes >= 0.0) {
    int w = int(uVisW);
    int ri = clamp(int(aEdgeRes + 0.5), 0, int(uVisN) - 1);
    float cover = texelFetch(uVis, ivec2(ri % w, ri / w), 0).r;
    if (cover <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vFade = cover;
  }
  float aStickBit = mod(aEdgeStick, 2.0) > 0.5 ? 1.0 : 0.0;
  float aOuter = mod(floor(aEdgeStick / 2.0), 2.0) > 0.5 ? 1.0 : 0.0;
  if ((aStickBit > 0.5 ? uShowSticks : uShowRibbon) < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // hidden class: no outline either
    return;
  }
  vec3 v0 = uRot * (aP0 + uShift);
  vec3 v1 = uRot * (aP1 + uShift);
  // THE SILHOUETTE, AND NOTHING ELSE - the renderer's own words for the same
  // rule (cartoon/geom.js, the stick ink block). An edge is drawn iff exactly
  // one of the two faces meeting along it points at the eye. Orthographic, so
  // "points at the eye" is just z > 0.
  //
  // AN INTERIOR CREASE FAILS THIS BY CONSTRUCTION - both its faces are visible -
  // and that is the whole point: it is what guarantees no line is ever drawn
  // across a face. The first cut of this pass had a crease rule that force-drew
  // any edge whose faces disagreed by more than 40 degrees, which marked 3608
  // of 4677 edges always-draw and inked every internal seam between connecting
  // polygons. That is not a heavier outline, it is a different drawing.
  //
  // aAlways: 0 = test the pair, 2 = open boundary edge (one adjacent face, so
  // nothing to disagree with) drawn while that face is turned toward the eye,
  // 5 = the same edge on a DOUBLE-SIDED face, which the renderer orients at the
  // eye and so is never turned away from it; 3 = the bright CORE of a contact,
  // 4 = a contact's ink BORDER, which takes the ordinary ink colour.
  //
  // 5 AND NOT 3, WHICH IS WHAT IT WAS. The double-sided case was added so a
  // flat side chain would keep its outline as the model turns, and it reused
  // the contact core's value - the comment below even recorded both meanings on
  // one line and asserted nothing else reached the pass with it set. So every
  // flat side-chain edge was read as a contact: it took its own colour at full
  // strength, which is precisely the branch written to keep the INK CONTROL
  // away from contacts, so side-chain outlines ignored Ink while the backbone
  // obeyed it. They also skipped the depth fade and lost their corner
  // overshoot. Three symptoms, one overloaded number.
  // The 2D pass strokes a contact twice - g.w + paintInkW in ink, then g.w in
  // the bright colour over it - and without the first one a contact reads as a
  // flat bar rather than a drawn one.
  vec3 r0 = uRot * aN0;
  vec3 r1 = uRot * aN1;
  // Both faces tested at the edge's own midpoint: under perspective the view
  // vector varies over the model, and testing an edge's two faces at two
  // different points would let a straight edge disagree with itself.
  vec3 mid = (v0 + v1) * 0.5;
  bool f0 = faces(r0, mid);
  bool f1 = faces(r1, mid);
  // EITHER FACE, NOT THE FIRST ONE. aAlways = 2 means "this edge is drawn while
  // its surface is turned toward the eye", and with one adjacent face - an open
  // boundary - f0 IS that surface and f1 is a copy of it, so the two readings
  // agree. With TWO faces, which is every crease, testing f0 alone makes the
  // answer depend on which face happened to reach addEdge first.
  //
  // That is not academic: it is why a richardson strand had a line where its
  // top face meets the side and none where the BOTTOM face meets the same side.
  // Both rails exist in the buffer and both are creases at 90 degrees; the top
  // one recorded the +b face first, which faces you, and the bottom one
  // recorded the -b face first, which does not. Same edge kind, opposite
  // outcome, decided by insertion order.
  //
  // A crease is visible when either of the surfaces meeting along it is.
  // THE 2D'S RULE, ported. It keeps the corners whose projection is extreme
  // ACROSS the chain; a corner sits at +/-hw*w +/-ht*b from the centre, so the
  // extreme one is the corner whose two adjacent faces both lean the SAME way
  // along that across-chain direction. Both normals are already here, so the
  // test is their screen-space cross products against the edge sharing a sign -
  // no extra geometry, and it reproduces "interior crease corners are never
  // extreme" exactly, which the facing test cannot.
  vec3 eDir = v1 - v0;
  float c0 = eDir.x * r0.y - eDir.y * r0.x;
  float c1 = eDir.x * r1.y - eDir.y * r1.x;
  // ...AND A HANDOFF COUNTS AS EXTREME. The reference tests each corner at BOTH
  // stations and keeps it if it is extreme at either -
  //     v0[c] >= hi0 || v1[c] >= hi1 || v0[c] <= lo0 || v1[c] <= lo1
  // - which is why its own comment says it "normally keeps 2 corners and keeps
  // 3 across a handoff", where the outer edge passes from one corner to
  // another along a twisting piece.
  //
  // One test for the whole edge cannot see that: it keeps 2 and never 3, so
  // every rail that hands off mid-piece was dropped. A rung twists on its way
  // out of the backbone, so most of them do - measured, the GPU drew 0.81x the
  // reference's ink on 1BNA, missing 6336 pixels of outline.
  //
  // A handoff is exactly where one of the two cross products passes through
  // zero, so a near-zero term is the per-edge shadow of "extreme at one end".
  float m0 = abs(c0), m1 = abs(c1);
  bool handoff = min(m0, m1) <= uHandoff * max(m0, m1);
  // THE EXTREME TEST NEEDS BOTH NORMALS TO HAVE SCREEN EXTENT.
  //
  // c is |eDir| * |r.xy| * sin(angle), so it collapses when a normal projects
  // to nothing - which is precisely what a face pointing AT THE VIEWER does.
  // A base plate seen broadside puts its broad face there, so c for that face
  // is ~0 at all four corners and its SIGN is numerical noise. The product test
  // then decides the outline by coin toss and draws creases: the inner lines.
  //
  // Where the test is meaningless, fall back to the facing rule, which answers
  // this case correctly - visible broad + visible side is a crease and stays
  // unlit; visible side + hidden broad is the silhouette and draws.
  float eL = length(eDir.xy);
  bool usable = min(m0, m1) > 0.15 * max(1e-6, eL);
  bool pairDraw = aOuter > 0.5
      ? (usable ? ((c0 * c1 > 0.0) || handoff) : (f0 != f1))
      : (f0 != f1);
  // aAlways < 0 is a row the LETTER has turned off for this frame - a strip's
  // cross edge whose piece is not a Richardson strand. The row exists so that a
  // residue becoming a strand does not change the edge set; this is what keeps
  // it from drawing until it does. Clipped before any fragment.
  bool draw = (aAlways < -0.5) ? false
      : ((aAlways > 2.5) ? true : ((aAlways > 1.5) ? (f0 || f1) : pairDraw));
  if (!draw) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // clipped, no fragments at all
    return;
  }
  vec2 s0 = toPx(v0);
  vec2 s1 = toPx(v1);
  vec2 d = s1 - s0;
  float L = length(d);
  vec2 dir = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  float peW = uPersp > 0.5 ? uFL / max(0.1, uFL - mid.z) : 1.0;
  // a contact's ink BORDER is its core plus one outline width, which is what
  // the 2D pass strokes underneath it
  // the contact BORDER (4) is its core plus one outline width; the test is
  // bounded because 5 is an ordinary outline and must not collect it
  bool isContact = aAlways > 2.5 && aAlways < 4.5;
  float w = aEdgeW > 0.0
      ? max(0.5, aEdgeW * uScale * peW) + (aAlways > 3.5 && isContact ? uWidth : 0.0)
      : uWidth;
  vec2 perp = vec2(-dir.y, dir.x) * (w * 0.5);
  // drawn with an index buffer, so gl_VertexID IS the corner (see quadIdx)
  int c = gl_VertexID;
  bool far = (c == 1 || c == 2);
  vec2 p = far ? s1 : s0;
  p += (c >= 2) ? perp : -perp;
  // half a width of overshoot at each end, so consecutive edges of one strip
  // meet instead of leaving a notch at every station.
  //
  // NOT ON A STROKE. That overshoot exists because an outline turns corners
  // between segments; a contact does not turn, its pieces are collinear and
  // abut exactly, so butt ends meet with no notch to fill. Extending them
  // instead pushes the contact HALF A WIDTH past each of the two CAs it names -
  // and the width follows the zoom and the perspective, so that overhang
  // breathes as the view moves, which reads as the ends not sitting on the
  // residues. A contact should stop where it stops.
  // ...and only a CONTACT gives up the overshoot. A double-sided edge is an
  // outline like any other: it turns corners between segments, so without the
  // overshoot every station leaves a notch.
  float over = isContact ? 0.0 : (w * 0.5);
  p += dir * (far ? over : -over);
  float zv = far ? v1.z : v0.z;
  // ...and the clip slab reads the same depth this vertex is placed at, so an
  // outline crossing the plane is cut at it rather than dropping whole
  vZv = zv;
  vec2 ndc = vec2(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0);
  float t01 = (zv - uZRange.x) / max(1e-6, uZRange.y - uZRange.x);

  // BIAS SCALED BY WIDTH AND SLOPE, which is what stops the zigzag.
  //
  // The line is a screen-space quad straddling the edge, so half its width lies
  // OVER one of the two faces - at that face's depth, which is why it z-fights
  // at all. How much depth that half spans depends on two things the shader
  // already knows: how wide the line is, and how steeply the face recedes.
  //
  // On a face with normal n, moving one pixel sideways changes view depth by
  // |n.xy| / |n.z| / uScale. A constant bias therefore over-corrects a
  // face-on surface and under-corrects a grazing one, and under-correction
  // eats the quad in a slope-dependent pattern - a line that alternates
  // between drawn and missing along its length, which is the zigzag.
  //
  // The steeper of the two faces is the one to satisfy. |n.z| is floored
  // because a face exactly edge-on wants infinite bias and cannot have it.
  float sl0 = length(r0.xy) / max(0.08, abs(r0.z));
  float sl1 = length(r1.xy) / max(0.08, abs(r1.z));
  float slope = max(sl0, sl1);
  float dz = (w * 0.5 / max(1e-6, uScale)) * slope;   // in view units
  // the depth range maps to 2.0 of clip z, so convert before applying it
  float slopeBias = 2.0 * dz / max(1e-6, uZRange.y - uZRange.x);
  // AND CAP IT. A grazing face recedes arbitrarily fast, so the correction it
  // asks for is unbounded - and a line pushed that far forward stops being
  // hidden by anything, which surfaces interior edges the drawing should not
  // have. Capping the RESULT rather than the slope is what bounds the damage:
  // the cap is in clip depth, so it says directly how far in front of its own
  // surface a line may ever sit.
  slopeBias = min(slopeBias, uBiasMax);
  gl_Position = vec4(ndc, 1.0 - 2.0 * t01 - uBias - slopeBias, 1.0);

  // THE INK COLOUR, ported from inkColor():
  //     f  = inkFloor + (1 - inkFloor) * near        (the same depth fade the
  //                                                   fills get, so a faded
  //                                                   structure does not read
  //                                                   as a dark wireframe over
  //                                                   ghost geometry)
  //     ch = (tint == 0 ? INK_BASE : v * 0.7 * tint) * f + PAPER * (1 - f)
  //
  // Note the black term is DROPPED once the tint is non-zero - it is not a mix
  // between black and the colour, it is the colour scaled by 0.7 * tint. At
  // 0.5 an outline is a dark version of its own element rather than a grey.
  vec3 elem = aEdgeCol;
  if (uPalW > 0.5 && aEdgePal >= 0.0) {
    int pi = int(aEdgePal + 0.5);
    int pw = int(uPalW);
    elem = texelFetch(uPal, ivec2(pi % pw, pi / pw), 0).rgb * 255.0;
  }
  // ...and the ink fades on the SHADING range too, at the edge's own midpoint:
  // its depth key in the 2D pass is the prim's, not the corner's
  float tShade = (((v0.z + v1.z) * 0.5) - uShadeRange.x)
      / max(1e-6, uShadeRange.y - uShadeRange.x);
  // a contact's bright core takes its own colour at full strength; its border,
  // and every ordinary outline, fades toward the paper with depth
  bool core = aAlways > 2.5 && aAlways < 3.5;
  float f = core ? 1.0 : (uInkFloor + (1.0 - uInkFloor) * tShade);
  // A CONTACT IS NOT AN OUTLINE, so the Ink control does not reach it: it is a
  // bright annotation stroke in its own colour, and tinting it toward black -
  // which is what Ink 0 means for an outline - would have deleted it in the
  // one style that draws contacts most. aAlways 3 is the flag; nothing else
  // reaches this pass with it set.
  vec3 ink = core ? aEdgeCol
      : (uInkTint <= 0.0 ? vec3(uInkBase) : elem * 0.7 * uInkTint);
  vInk = (ink * f + uPaperInk * (1.0 - f)) / 255.0;
}`;

/* ======================================================= THE TUBE STYLE
 * A different drawing and a much simpler one. Where the cartoon builds a mesh
 * of ribbon slabs, the tube style is one CAPSULE per segment: the 2D pass
 * strokes a thick round-capped line between two projected positions and fills a
 * disc at each end. So there is nothing to capture and nothing to unproject -
 * the geometry IS the coordinates, and the whole port is one instanced quad per
 * segment with the capsule solved in the fragment shader.
 *
 * WHAT THE GPU DOES DIFFERENTLY, and it is the reason to do this at all: the 2D
 * pass has no depth buffer, so it sorts segments back to front and paints them
 * whole. Two tubes that genuinely cross therefore have to pick a winner, and
 * the loser passes behind at the crossing even where it should emerge in front.
 * Writing gl_FragDepth from the capsule's own surface makes them intersect.
 *
 * WHAT IT DOES NOT DO IS DECIDE THE COLOUR. The tube's shading is screen-space
 * occlusion - every segment darkened by whatever lies in front of it - which is
 * core/mol.js's own calculation, cached and recomputed when a gesture settles
 * rather than per frame. The colour arrives here already shaded, one per
 * segment, and is re-uploaded when that cache is rebuilt. During a drag there is
 * nothing to upload and the frame is one draw call.
 */
const VSTUBE = `#version 300 es
precision highp float;
in vec3 aP0;            // the segment's two ends, MODEL space
in vec3 aP1;
in float aRad;          // its radius in ANGSTROM, so it follows zoom like the rest
in vec3 aTCol;          // colour, already shaded, 0..255
// 1 = this end is a free end of the chain, 0 = the next segment continues it
in float aCapA, aCapB;
// WHAT COLOUR THE BALL AT EACH END IS, packed as r*65536 + g*256 + b. At a
// joint both segments carry the SAME one - the owner's - see buildTube.
in vec2 aJCol;
// 1 = annotation (a contact): the 2D pass excludes these from shading
in float aNoAO;
// THE TWO POSITIONS THIS SEGMENT RUNS BETWEEN, and the per-residue coverage
// texture they index - the same texel the cartoon's fills are tested against,
// read here so a ghosted selection fades the tube too. Averaged over the two
// ends, so a segment between a faded residue and a solid one is half faded
// rather than snapping to whichever end happened to be written first.
in float aResA, aResB;
uniform sampler2D uVis;
uniform float uVisW, uVisN;
out float vFade;
uniform mat3 uRot;
uniform vec2 uSize;
uniform vec2 uZRange;
uniform float uScale, uPersp, uFL;
// WHERE THE VIEW IS CENTRED, as an offset from the centre the instances were
// built about - model space, so it goes in before the rotation. Orient moves
// the centre onto a selection; without this the tube stays framed on the
// coordinate mean it was built around. Zero on every frame that has not
// moved it. Same idea and same name as VS3D's.
uniform vec3 uShift;
// extra radius in DISPLAY pixels, and a depth push, for the outline pass
uniform float uGrowPx, uPushZ, uRatio;
uniform float uDepthCue;   // per-segment depth darkening, the flat cue
out vec2 vA, vB;        // the ends in device pixels
out float vRpx;         // the radius actually DRAWN, in device pixels
// ...and the tube's own radius, which is not the same thing on the outline pass.
// The capsule's depth comes from its surface, and a grown radius bulges further
// toward the eye - by far more than the depth push meant to keep the outline
// behind its own fill, so the outline won everywhere and the whole drawing came
// out at 0.7. The halo is a flat skirt around the TRUE tube, not a fatter tube.
out float vRfill;
out float vZA, vZB;     // view-space depth at each end
out vec3 vTCol;
out vec3 vJColA, vJColB;
out float vCapA, vCapB;
out float vNoAO;
void main() {
  vec3 a = uRot * (aP0 + uShift);
  vec3 b = uRot * (aP1 + uShift);
  float peA = uPersp > 0.5 ? uFL / max(0.1, uFL - a.z) : 1.0;
  float peB = uPersp > 0.5 ? uFL / max(0.1, uFL - b.z) : 1.0;
  vA = vec2(uSize.x * 0.5 + a.x * uScale * peA, uSize.y * 0.5 - a.y * uScale * peA);
  vB = vec2(uSize.x * 0.5 + b.x * uScale * peB, uSize.y * 0.5 - b.y * uScale * peB);
  vZA = a.z; vZB = b.z;
  vCapA = aCapA; vCapB = aCapB; vNoAO = aNoAO;
  // THIS SEGMENT'S COVERAGE, from the two residues it runs between. The same
  // texel VS3D reads, through the same clamp: an out-of-range texelFetch
  // returns 0, which reads as hidden, so a stray index must not delete
  // geometry. A contact is annotation laid across the chain and keeps its own
  // ends, so it is not ghosted with the residues it happens to touch.
  vFade = 1.0;
  if (uVisW > 0.5 && aNoAO < 0.5) {
    int w = int(uVisW);
    int ra = clamp(int(aResA + 0.5), 0, int(uVisN) - 1);
    int rb = clamp(int(aResB + 0.5), 0, int(uVisN) - 1);
    float ca = texelFetch(uVis, ivec2(ra % w, ra / w), 0).r;
    float cb = texelFetch(uVis, ivec2(rb % w, rb / w), 0).r;
    vFade = (ca + cb) * 0.5;
    // ...and a segment with nothing left of it is dropped outright rather than
    // dithered down to no pixels, which is what the fills do at zero.
    if (vFade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  }
  vJColA = vec3(floor(aJCol.x / 65536.0),
      floor(mod(aJCol.x / 256.0, 256.0)), floor(mod(aJCol.x, 256.0))) / 255.0;
  vJColB = vec3(floor(aJCol.y / 65536.0),
      floor(mod(aJCol.y / 256.0, 256.0)), floor(mod(aJCol.y, 256.0))) / 255.0;
  // ONE TONE PER SEGMENT, and that is the point. The style is flat segments
  // with a dark rim, not lit tubes: the shading has to be constant across a
  // capsule or it stops reading as a flat mark. So the depth cue is computed
  // HERE, per instance, from the segment's own midpoint - free, and it cannot
  // vary across the fragment the way a surface normal does.
  //
  // It replaces the 2D pass's screen-space occlusion, which is a better cue and
  // costs ~90% of the frame (9FOG: 67 ms with, 6.8 ms without). This is the
  // cheap half of that idea: things further away are darker.
  float zMid = (a.z + b.z) * 0.5;
  float near01 = clamp((zMid - uZRange.x) / max(1e-6, uZRange.y - uZRange.x), 0.0, 1.0);
  vTCol = (aTCol / 255.0) * (uDepthCue > 0.5 ? (0.74 + 0.26 * near01) : 1.0);
  // THE RADIUS FOLLOWS THE PERSPECTIVE, averaged over the segment, which is
  // what the 2D pass does: it scales the stroke by the mean of its two ends'
  // perspective factors rather than per pixel.
  float pe = (peA + peB) * 0.5;
  vRfill = aRad * uScale * pe;
  vRpx = vRfill + uGrowPx * uRatio;
  // A QUAD THAT COVERS THE CAPSULE: along the segment, extended by the radius
  // at each end so the round caps are inside it, and half a radius wider than
  // the tube on each side.
  vec2 d = vB - vA;
  float L = length(d);
  vec2 t = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  // drawn with an index buffer, so gl_VertexID IS the corner (see quadIdx)
  int c = gl_VertexID;
  float along = (c == 0 || c == 3) ? -vRpx : L + vRpx;
  float across = (c == 0 || c == 1) ? -vRpx : vRpx;
  vec2 p = vA + t * along + n * across;
  vec2 ndc = vec2(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0);
  // A CONSERVATIVE DEPTH FOR THE QUAD, WHICH IS WHAT BUYS BACK EARLY-Z.
  //
  // This used to be 0 - the quad sat at the middle of the depth range and the
  // fragment shader wrote the real depth. Writing gl_FragDepth switches off
  // early depth rejection on every GPU, so at a capsid's depth complexity every
  // layer of every capsule ran the full fragment shader whether it could be
  // seen or not. That is what made the draw 58 ms on 3J3Q.
  //
  // Declaring the fragment depth depth_greater gives the hardware permission
  // to reject against the POLYGON's depth first, and the promise it needs is
  // that the shader's depth is never nearer than this one. So the quad is
  // placed at the nearest point the capsule can reach: the nearer end's axis,
  // plus a radius for the bulge. Every fragment's own zSurf is at or behind it
  // by construction, and uPushZ only ever pushes further back.
  float zNear = max(vZA, vZB) + aRad;
  float tNear = clamp((zNear - uZRange.x) / max(1.0e-6, uZRange.y - uZRange.x),
                      0.0, 1.0);
  gl_Position = vec4(ndc, 1.0 - 2.0 * tNear, 1.0);
}`;

// A FULL-SCREEN TRIANGLE with no attributes at all - gl_VertexID is enough,
// and it keeps the tube's instanced attribute state from having to be torn
// down and rebuilt around the occlusion pass.
const VSQUAD = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// SCREEN-SPACE OCCLUSION, and the reason it exists rather than the CPU pass.
//
// The 2D renderer shades a segment by testing it against every other segment
// in front of it: two nested loops over the visible list, a grid above a size
// threshold. It is the single most expensive thing in the style - on 9FOG it
// is ~90% of the frame - and it grows with the structure, which is the wrong
// direction when the whole point of the GPU path is 3J3Q.
//
// The kernels below are the CPU's, unchanged: a rational stand-in for a
// sigmoid, c^2 / (c^2 + d^2 * 2), summed for shadow and maxed for tint, with
// the same cutoffs derived from the same reference bond lengths. What changes
// is WHAT IS SUMMED OVER. The CPU sums over segments; this sums over samples
// of the depth field the capsules just wrote, so the cost is a function of the
// number of PIXELS and not of the number of segments. Ten thousand segments
// cost exactly what five hundred do.
//
// Two consequences worth naming, because they are visible:
//
//  - It is better at crossings. The CPU compares segment CENTRES, so where one
//    strand passes over another the shadow is attributed to the whole segment
//    and the crossing softens into a general darkening. Sampling the depth
//    field puts the darkening where the strands actually cross, and the two
//    read as two, which is the thing a tube drawing has to get right.
//  - It only sees the front-most surface along each ray, where the CPU counts
//    every segment behind it too. That undercounts burial by a roughly
//    constant factor, which is what uDensity absorbs.
// THE MATCHING RESOLVE. A 4x4 box, which is exactly the period of the
// interleaved rotation above, so every output pixel averages one full set of
// sixteen sample orientations.
//
// It is depth-weighted, and that is not a refinement. A plain box would drag
// the dark band from behind a crossing out across the strand in front of it,
// and that halo is what makes screen-space occlusion look dirty. Weighting each
// tap by how near its depth is to the centre's keeps the average inside one
// surface: smooth along a tube, hard where one passes over another - which is
// the one place the drawing needs an edge.
const FBLUR = `#version 300 es
precision highp float;
uniform sampler2D uAOTex;
uniform sampler2D uZTex;
uniform vec2 uTexel;
out vec2 fragAO;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  float zc = texture(uZTex, uv).r;
  if (zc < -1.0e8) { fragAO = vec2(1.0, 1.0); return; }
  vec2 acc = vec2(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 1; y++) {
    for (int x = -2; x <= 1; x++) {
      vec2 uvk = uv + vec2(float(x), float(y)) * uTexel;
      float zn = texture(uZTex, uvk).r;
      if (zn < -1.0e8) continue;
      float w = exp(-abs(zn - zc) * 1.5);
      acc += texture(uAOTex, uvk).rg * w;
      wsum += w;
    }
  }
  fragAO = wsum > 0.0 ? acc / wsum : texture(uAOTex, uv).rg;
}`;

const FSAO = `#version 300 es
precision highp float;
uniform sampler2D uZTex;
uniform vec2 uTexel;           // 1 / size of the depth texture, in pixels
uniform float uScale;          // device pixels per Angstrom at pe = 1
uniform float uPersp, uFL;
uniform float uShadowCut, uShadowMax;   // Angstrom, from REF_LENGTHS
uniform float uTintCut, uTintMax;
uniform float uStrength;       // the shadow slider
uniform float uIntensity;      // 0.95, the CPU's per-unit darkening
uniform float uDensity;        // segments per square Angstrom, times the gain
uniform float uSelfBias;       // Angstrom; below this a sample is the same tube
out vec2 fragAO;
const int NS = 28;             // burial: a wide disc, area-uniform
const int NT = 10;             // contact: a tight disc, where crossings live
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  float zc = texture(uZTex, uv).r;
  if (zc < -1.0e8) { fragAO = vec2(1.0, 1.0); return; }   // paper
  float pe = uPersp > 0.5 ? uFL / max(0.1, uFL - zc) : 1.0;
  float pxPerA = max(1.0e-6, uScale * pe);
  float sc2 = uShadowCut * uShadowCut;
  float tc2 = uTintCut * uTintCut;
  float shadowSum = 0.0;
  float maxTint = 0.0;
  // BURIAL. Radii as sqrt(i/N) so the taps are uniform per unit AREA, which is
  // what lets one tap stand for a fixed patch of the disc and the whole sum be
  // scaled by a single density.
  float wArea = (3.14159265 * uShadowMax * uShadowMax / float(NS)) * uDensity;
  // INTERLEAVED SAMPLING. Twenty-odd taps is a coarse estimate of the disc
  // however they are placed, and placing them at the SAME angles for every
  // pixel makes the error identical across a neighbourhood - it shows up as
  // blotches and facets that look like shading and are not.
  //
  // A random per-pixel rotation fixes that but replaces it with grain, and
  // grain only averages out if you blur far enough to collect a fair sample of
  // rotations - which a small blur does not. So the rotation is not random: it
  // is the pixel's position in a 4x4 block, giving sixteen evenly spaced
  // angles, arranged so that EVERY 4x4 block contains each one exactly once.
  // The 4x4 blur that follows therefore averages a complete, fair set every
  // time, and the estimate lands at 16 x 28 effective taps for the cost of 28.
  ivec2 ip = ivec2(gl_FragCoord.xy) & 3;
  float rot = float(ip.x + (ip.y << 2)) * (6.2831853 / 16.0);
  for (int i = 0; i < NS; i++) {
    float fi = (float(i) + 0.5) / float(NS);
    float ang = float(i) * 2.39996323 + rot;   // golden angle, so no ring pattern
    float rr = sqrt(fi);
    float dA = rr * uShadowMax;
    vec2 off = vec2(cos(ang), sin(ang)) * dA * pxPerA;
    float zs = texture(uZTex, uv + off * uTexel).r;
    if (zs < -1.0e8) continue;
    float dz = zs - zc;
    if (dz <= uSelfBias) continue;          // behind, or the same tube's bulge
    shadowSum += (sc2 / (sc2 + (dA * dA + dz * dz) * 2.0)) * wArea;
  }
  // CONTACT. The tint cutoff is ~1.9 Angstrom, so this term is only alive
  // within a couple of Angstrom of something in front - which is exactly the
  // pixels beside a crossing. It is a max, not a sum: one occluder is enough.
  for (int i = 0; i < NT; i++) {
    float fi = (float(i) + 0.5) / float(NT);
    float ang = float(i) * 2.39996323 + rot + 1.1;
    float dA = sqrt(fi) * uTintMax;
    vec2 off = vec2(cos(ang), sin(ang)) * dA * pxPerA;
    float zs = texture(uZTex, uv + off * uTexel).r;
    if (zs < -1.0e8) continue;
    if (zs - zc <= uSelfBias) continue;
    maxTint = max(maxTint, tc2 / (tc2 + dA * dA * 2.0));
  }
  shadowSum = min(shadowSum * uStrength, 12.0);   // MAX_SHADOW_SUM
  fragAO = vec2(pow(uIntensity, shadowSum), 1.0 - maxTint * uStrength);
}`;

const FSTUBE = `#version 300 es
__CONSEXT__
precision highp float;
__CONSDECL__
in vec2 vA, vB;
in float vFade;         // this segment's coverage - see VSTUBE
in float vRpx;
in float vRfill;
in float vZA, vZB;
in vec3 vTCol;
in vec3 vJColA, vJColB;
in float vCapA, vCapB;
in float vNoAO;
uniform vec2 uZRange;
uniform float uScale, uPersp, uFL, uPushZ;
${CLIP_GLSL}
// HOW WIDE THE SKIRT IS, in device pixels, and whether there is one at all.
// The vertex shader grows the quad by it; the fragment shader needs it too,
// now that a fragment decides for itself whether it is skirt or fill.
uniform float uGrowPx;
uniform float uSkirtZ;
uniform float uCapZ;
// 1 = a free end keeps its round skirt, 0 = every end is cut square
uniform float uEndCaps;
// the skirt is the fill darkened - the 2D pass's own gap-filler colour
uniform float uDarken;
// 1 = light the capsule per fragment, 0 = flat (the outline skirt)
uniform float uLit;
// THE OCCLUSION, computed on the GPU from a depth prepass rather than on the
// CPU from every pair of segments. uZOnly makes this the prepass itself: the
// shader writes the capsule's view depth in Angstrom instead of a colour.
uniform float uZOnly;
uniform float uUseAO;
uniform vec2 uSizeF;
uniform sampler2D uAOTex;
out vec4 fragColor;
void main() {
  // THE FRAGMENT'S OWN POSITION, TAKEN FROM gl_FragCoord RATHER THAN
  // INTERPOLATED ACROSS THE QUAD.
  //
  // It used to arrive as a varying, which made it a function of the quad's
  // corners: the same pixel on a differently-sized quad interpolates to a
  // last-bit-different position, and since the bulge is sqrt(r^2 - dist^2),
  // whose slope is unbounded at the silhouette, that becomes a LARGE difference
  // in depth right at a tube's edge. The prepass and the draw both write depth
  // and the draw tests LEQUAL against the prepass, so they have to agree - and
  // with a varying the only way to make them agree was to rasterise the same
  // grown quad in both, which had the prepass shading four times the fragments
  // it kept, at a capsid's outline-to-tube ratio.
  //
  // Read from gl_FragCoord it is the pixel centre, exactly, whatever quad
  // carried the fragment there. The two passes agree by construction and the
  // prepass can go back to the tube's own quad. vA/vB measure y downward from
  // the top, gl_FragCoord upward from the bottom.
  vec2 vPx = vec2(gl_FragCoord.x, uSizeF.y - gl_FragCoord.y);
  // distance to the segment, in pixels, and how far along it the nearest point is
  vec2 d = vB - vA;
  float L2 = dot(d, d);
  float tRaw = L2 > 1e-9 ? dot(vPx - vA, d) / L2 : 0.0;
  float t = clamp(tRaw, 0.0, 1.0);
  vec2 q = vA + d * t;
  float dist = length(vPx - q);
  if (dist > vRpx) discard;              // outside the capsule
  // SKIRT OR FILL, DECIDED PER FRAGMENT INSTEAD OF PER PASS.
  //
  // These were two draws over the same instances: one at the grown radius that
  // discarded everything inside the tube, then one at the true radius. Measured
  // on 4UG0 they were the two most expensive things in the frame by a wide
  // margin - 5.1 ms and 6.3 ms of a 13.6 ms GPU frame - because a capsule quad
  // is mostly overdraw and the shader writes gl_FragDepth, which switches off
  // early-Z, so every fragment of every layer runs in full.
  //
  // The two regions are disjoint by construction: the skirt is dist > vRfill
  // and the fill is dist <= it. Nothing needed them in separate passes except
  // the depth ordering, and that is carried by the depth each writes - the
  // skirt at its tube's nearest point, pushed back by uPushZ so its own fill
  // beats it on a tie - which is per fragment and does not care which draw it
  // arrived in. So the grown quad is rasterised ONCE and each fragment picks.
  bool skirt = dist > vRfill;
  // WHICH CAP THIS FRAGMENT IS BEYOND, if any: 2 a joint cap, 1 a free end,
  // 0 a butt cut. Declared out here because the depth block below needs it
  // too, and a GLSL block scope does not reach it.
  float capKind = 0.0;
  if (tRaw < 0.0) capKind = vCapA;
  else if (tRaw > 1.0) capKind = vCapB;
  // WHY THE OUTLINE STOPS SQUARE IN THE MIDDLE OF A CHAIN.
  // Every segment carries its own rim, so a round cap at a joint draws a dark
  // arc BETWEEN consecutive residues and the backbone reads as a string of
  // sausages rather than one tube. A joint is not an end of anything: the next
  // segment starts exactly there. So on the outline pass the halo is cut off
  // flush at any end another segment continues, and the neighbour's halo takes
  // over from the same plane. Only a genuinely free end - a chain terminus, a
  // break - keeps its round cap. The FILL is always round, which is what
  // closes the wedge on the outside of a bend.
  // This is the 2D pass's rule too (shouldRoundEndpoint / the butt-capped gap
  // filler); the GPU had simply been rounding everything.
  if (skirt) {
    // no outline asked for: the grown radius is the true one and there is no
    // skirt to draw
    if (uGrowPx <= 0.0) discard;
    // OUTLINE MODE 'partial' CUTS EVERY END SQUARE. The 2D pass strokes the rim
    // butt-capped along the segment and only adds the round cap at a free end
    // when the mode is 'full'; this path treated anything that was not 'none'
    // as 'full', so partial came out with rounded outline caps at every chain
    // terminus that the 2D pass does not draw.
    if (tRaw < 0.0 || tRaw > 1.0) {
        if (capKind < 0.5) discard;             // butt cut
        // 3 = round fill, no outline cap. See the builder: that is the state
        // cartoonJointCaps = false asks for, and it has to keep the round FILL
        // or the elbow opens up.
        if (capKind > 2.5) discard;
        // 'partial' drops EVERY round outline cap, joint and free end alike -
        // the 2D pass gates both on outlineMode === 'full', in one branch.
        if (uEndCaps < 0.5) discard;
    }
  }
  // THE SURFACE, not the centre line. A tube is round, so the fragment nearest
  // the eye at distance d from the axis stands proud of it by
  // sqrt(r^2 - dist^2) - in PIXELS, which becomes Angstrom by dividing out the
  // same scale that put it there. Without this the whole capsule sits at its
  // axis depth and two crossing tubes meet as a flat seam instead of one
  // passing over the other.
  float zAxis = mix(vZA, vZB, t);
  float pe = uPersp > 0.5 ? uFL / max(0.1, uFL - zAxis) : 1.0;
  // FROM THE TUBE, NOT FROM THE HALO. Clamped so the skirt outside the tube
  // sits at the tube's own rim depth rather than diving behind it.
  float dIn = min(dist, vRfill);
  float bulgePx = sqrt(max(0.0, vRfill * vRfill - dIn * dIn));
  float zSurf = zAxis + bulgePx / max(1e-6, uScale * pe);
  // THE CLIP SLAB CUTS THE SURFACE, NOT THE AXIS. zSurf is where this fragment
  // of the tube actually is in depth, so a capsule crossing the plane is opened
  // at it - a hole with the tube's own rim - which is what clipping into a
  // tube looks like. Cutting on the axis depth would take whole segments.
  if (clipped(zSurf, vFade)) discard;
  // THE OUTLINE IS A SKIRT OUTSIDE THE TUBE, NOT A FATTER TUBE BEHIND IT.
  // This is the whole of what makes a depth buffer behave like the 2D pass's
  // painter, which strokes each segment's rim and then its fill, in depth
  // order, so a rim covers whatever is behind it and is covered by whatever is
  // in front - and is never in a tie, because order decides.
  //
  // A depth buffer has no order, so the geometry has to avoid the tie instead.
  // Two things went wrong before, and they pull in opposite directions:
  //
  //  - Put the skirt at its own surface depth and it wins over its OWN fill,
  //    printing a dark disc over the tube.
  //  - Sink it behind the tube to stop that, and it starts losing to fills that
  //    are behind the tube but in front of the sunk skirt. That does not remove
  //    a tie, it CHOPS THE RIM UP: what should be one continuous outline
  //    survives only in fragments, and because each fragment is butt-cut square
  //    at the joints, two segments meeting at an angle leave two straight
  //    dashes crossing each other. Those are the crosses at the corners. Deeper
  //    sinking just erases more of the rim - measured, the dark pixels fell
  //    steadily and the crosses never went away.
  //
  // Discarding the part of the skirt that lies inside its own fill removes the
  // conflict at its source: there is then no pixel where a segment's outline
  // and its own fill both want to be, so the skirt can sit at the tube's rim
  // depth and win against everything genuinely behind it. Which it does for
  if (skirt) {
    // ...and the skirt carries the depth of the NEAREST point of the tube it
    // belongs to, not the depth of the rim it sits on.
    //
    // This is the part that took two wrong answers to find. The 2D painter
    // decides coverage per SEGMENT: it strokes a rim, fills it, and moves to
    // the next one, so a nearer segment's rim covers a farther segment
    // outright. A depth buffer decides per PIXEL, and the thing it compares
    // against is the far tube's BULGED surface - which stands up to a radius
    // proud of its axis and can therefore poke in front of the near tube's rim
    // even while the near tube is, as a whole, in front. Wherever it does, one
    // pixel of rim is erased. Strung along a segment that is exactly a rim
    // chopped into dashes, and where two segments meet at an angle the two sets
    // of dashes cross - the crosses at the corners.
    //
    // Giving the skirt zAxis + r makes it as near as its own tube ever gets, so
    // it beats everything its own tube beats and the rim comes back in one
    // piece. uPushZ then settles the exact ties (a joint, where both tubes'
    // front surfaces meet at the shared point) in the fill's favour.
    // HOW FAR TOWARD THE EYE THE SKIRT SITS, as a fraction of the tube's
    // radius, and it is the one number that decides whether the outline is
    // right. Too near and a rim punches through tubes that are in front of it,
    // which is ink the 2D pass does not draw; too far and other tubes' bulges
    // beat it and the rim breaks into dashes, which is ink the 2D pass does
    // draw and this one loses.
    // A JOINT CAP SITS AT THE JOINT'S OWN AXIS, not proud of it.
    //
    // The disc is centred on a position two tubes share, so both of their
    // fills bulge up to a full radius in front of it there - and that is
    // exactly what should hide it. At the axis it survives only where neither
    // fill reaches: outside the elbow, which is where the 2D pass's disc
    // survives too. Given the side bands' uSkirtZ it would instead print
    // across the joint, which is the artefact this whole thing has to avoid.
    float sz = (capKind > 1.5) ? uCapZ : uSkirtZ;
    zSurf = zAxis + sz * vRfill / max(1e-6, uScale * pe);
  }
  float t01 = (zSurf - uZRange.x) / max(1e-6, uZRange.y - uZRange.x);
  // NDC z is 1 - 2*t01, the same mapping the other programs put in gl_Position,
  // and the depth buffer wants (z + 1) / 2 - which is 1 - t01. Clamping the NDC
  // value to 0..1 BEFORE that conversion, as this did, throws away the whole
  // near half of the range: every fragment nearer than the midpoint came out at
  // exactly 0.5 and nothing occluded anything correctly.
  //
  // uPushZ moves it AWAY from the eye for the outline pass, so a segment's own
  // fill wins where the two coincide.
  // THE DRAW TESTS LEQUAL AGAINST WHAT THE PREPASS LEFT HERE, so the two have
  // to agree to the last bit. They do, and only because they rasterise the same
  // triangles: vPx is interpolated across the quad, and the same pixel on a
  // differently-sized quad lands on different barycentric weights. That is not
  // a rounding curiosity - the bulge is sqrt(r^2 - dist^2), whose slope is
  // unbounded at the silhouette, so a last-bit difference in vPx becomes a
  // large difference in depth exactly at a tube's edge. Trying to absorb it
  // with a tolerance instead cost every outline in the picture.
  gl_FragDepth = clamp(1.0 - t01 + (skirt ? uPushZ : 0.0), 0.0, 1.0);
  // THE CAPSULE'S OWN NORMAL, which is what the screen-space occlusion was
  // standing in for. The 2D pass has no surface to light, so it fakes depth by
  // darkening each segment by however much lies in front of it - an O(n^2)
  // pass over the whole structure, measured at ~90% of the frame. A capsule
  // HAS a surface: the offset from the axis gives x and y, the bulge gives z,
  // and one dot product does what the occlusion pass was approximating.
  //
  // It is not the same picture. It is a rounder, more literal one - the
  // original was always pseudo-3D - and it costs nothing per frame.
  // THE PREPASS. Same geometry, same depth, but the colour channel carries the
  // surface's view z so the occlusion pass can read a real depth field instead
  // of guessing one from segment centres.
  if (uZOnly > 0.5) { fragColor = vec4(zSurf, 0.0, 0.0, 1.0); return; }
  // THE BALL AT A JOINT IS ONE COLOUR, AND IT IS DECIDED ON THE CPU.
  //
  // Two segments meeting at an atom overlap in a lens, and a depth buffer
  // picks between their surfaces per pixel. Their surfaces cross right there,
  // so the pick flips inside the lens and the seam between two differently
  // coloured segments is a hard diagonal - two bonds that appear to cross in
  // the middle. Arbitrating that by depth was tried twice, by cutting the
  // unowned side out (which exposed the joint cap's rim, since that rim is
  // hidden precisely BY both fills being there) and by pushing it back (which
  // needs to know which end's ball a fragment is in, and a segment pointing at
  // the camera projects both its ends into the same disc).
  //
  // Nothing needs to win. Both segments paint the ball in the OWNER's colour,
  // so whichever surface the depth buffer picks, the colour is the same and
  // there is no seam to place. The geometry is untouched - every fill, every
  // rim, every depth is exactly what it was - and the boundary is the ball's
  // own circle, which is the arc the 2D pass draws.
  vec3 col = vTCol;
  if (!skirt) {
    // a free end (cap 1) keeps its own colour; a joint - owned (2, 3) or not
    // (0) - takes the ball's. Which end is decided by the half of the segment
    // this fragment sits on, which stays meaningful when the two ends land on
    // top of each other on screen.
    if (tRaw < 0.5) {
      if ((vCapA < 0.5 || vCapA > 1.5) && distance(vPx, vA) < vRfill) col = vJColA;
    } else if ((vCapB < 0.5 || vCapB > 1.5) && distance(vPx, vB) < vRfill) {
      col = vJColB;
    }
  }
  // EXACTLY THE 2D PASS'S TWO TERMS, applied to a per-pixel occlusion instead
  // of a per-segment one: whiten by how exposed the pixel is, then darken by
  // how much lies in front of it. Same constants, same order - see the
  // shading block in core/mol.js.
  if (uUseAO > 0.5 && vNoAO < 0.5) {
    vec2 ao = texture(uAOTex, gl_FragCoord.xy / uSizeF).rg;
    col += (1.0 - col) * ((0.50 * ao.g) / 3.0);
    col *= (0.20 + 0.80 * ao.r);
  }
  if (uLit > 0.5 && !skirt) {
    vec2 off = (vPx - q) / max(1e-6, vRfill);
    vec3 nrm = normalize(vec3(off.x, -off.y, bulgePx / max(1e-6, vRfill)));
    const vec3 L = normalize(vec3(-0.45, 0.6, 0.75));
    float dif = max(0.0, dot(nrm, L));
    // ambient floor plus diffuse, then a soft rim so a tube reads as round
    // even where it faces away from the light
    float lum = 0.62 + 0.38 * dif;
    lum += 0.14 * pow(max(0.0, 1.0 - nrm.z), 2.0) * dif;
    col = clamp(col * lum, 0.0, 1.0);
  }
  fragColor = vec4(col * (skirt ? uDarken : 1.0), 1.0);
}`;

// ---- THE PAPER ---------------------------------------------------------
// The pencil grain is not stroke geometry and never was: the 2D renderer builds
// ONE 128 px tile of three-octave value noise, repeats it across the canvas,
// masks it to the structure's alpha and multiplies it down at 0.54. Only the
// middle two steps are the canvas's; on the GPU the mask is free, because a
// fragment only exists where geometry drew, and the multiply is arithmetic.
//
// So this is the whole port: sample the SAME tile at the fragment's canvas
// position and scale the colour by it. It goes in BOTH fragment shaders,
// because the 2D pass grains the finished frame - outline included.
//
// THE GRAIN DOES NOT ZOOM, and here that is not a decision but a consequence:
// gl_FragCoord is in device pixels, so the tile is pinned to the canvas whatever
// the view does. The paper is the medium, not the subject.
const GRAIN_GLSL = `
uniform sampler2D uPaperTex;
uniform vec2 uPaperSize;    // the drawing buffer, in device pixels
uniform float uPencil;      // PENCIL_STRENGTH * amount; 0 is off
uniform float uGrainK;      // GRAIN_SCALE: <1 minifies, so finer
vec3 grainAt(vec3 c) {
  if (uPencil <= 0.001) return c;
  // MATCH THE 2D PATTERN TRANSFORM EXACTLY. It maps pattern space to canvas
  // space as x = k*u + (cx - k*cx), so u = (x - cx)/k + cx, about the canvas
  // centre. The phase is invisible on its own, but the lab diffs this against
  // the 2D frame and a half-tile shift in noise would swamp every real
  // difference. gl_FragCoord.y counts up and canvas y counts down.
  vec2 ctr = uPaperSize * 0.5;
  vec2 p = vec2(gl_FragCoord.x, uPaperSize.y - gl_FragCoord.y);
  vec2 u = (p - ctr) / uGrainK + ctr;
  vec3 g = texture(uPaperTex, u / 128.0).rgb;
  // The canvas does dst*(1-a) + a*dst*src, which is dst * mix(1, src, a) -
  // a multiply that leaves the highlights alone, which is how a pencil lays
  // colour down. Straight multiplication at full strength reads as dirt.
  return c * mix(vec3(1.0), g, uPencil);
}`;

// THE PICTURE ONTO THE CANVAS. blitFramebuffer would be the obvious way and it
// is not available: the context is created with antialias: true, so the default
// framebuffer is multisampled, and blitting a single-sample buffer into one is
// an INVALID_OPERATION - silently, as far as the picture is concerned, which is
// what a blank white frame turned out to be. A textured triangle has no such
// restriction and costs nothing measurable.
const FSCOPY = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 fragColor;
void main() { fragColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

const FSINK = `#version 300 es
precision highp float;
in vec3 vInk; in float vZv; in float vFade; out vec4 fragColor;
${CLIP_GLSL}
${GRAIN_GLSL}
void main() {
  if (clipped(vZv, vFade)) discard;
  fragColor = vec4(grainAt(vInk), 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vCol; in float vCull; in float vZv; in float vFade; out vec4 fragColor;
in vec2 vDisc; in float vIsDisc;
// THE OCCLUSION, BORROWED WHOLE FROM THE TUBE. uZOnly makes this pass the depth
// prepass the shadow is computed from - the same fragment writing its view
// depth in Angstrom instead of a colour - and uAOTex is the answer coming back.
// Nothing in FSAO is about capsules: it reads a depth field and returns how
// buried each pixel is, so the cartoon needs no shader of its own, only its own
// constants (see drawResident).
uniform float uZOnly, uUseAO;
// THE OUTLINE CONTROL, in device pixels, for the one thing this pass outlines
// itself: a lone atom's disc (the ink pass cannot - the circle is not in the
// mesh, only the square around it). Zero means the drawing has no outlines,
// and the ring must go with them.
uniform float uDiscInk;
// how much of the colour the shadow may take where it is fully buried
uniform float uAOAmt;
uniform vec2 uSizeF;
uniform sampler2D uAOTex;
${CLIP_GLSL}
${GRAIN_GLSL}
void main() {
  // the per-frame version of the renderer's STICK_CULL: a face is dropped when
  // it turns away, decided now rather than when the mesh was captured
  if (vCull > 0.5) discard;
  // ...AND THE RESIDUE'S OWN COVERAGE WITH IT. One call, because the slab and
  // the ghost are the same kind of thing: a fraction of the pixels kept. It is
  // dropped here rather than after the prepass on purpose - a ghosted residue
  // that still wrote depth would go on shadowing what shows through it.
  if (clipped(vZv, vFade)) discard;
  // A LONE ATOM: THE QUAD IS A SQUARE AND THE ATOM IS A CIRCLE.
  //
  // Solved here rather than tessellated, and shaded the way the 2D pass shades
  // one - concentric bands stepping toward a centre offset along the light,
  // which is the flat read of a highlight sitting off-centre on a ball. Two
  // steps: this is a drawing, and a smooth gradient reads as a different one.
  // Cut BEFORE the depth prepass returns, or the shadow pass sees the square.
  float discTone = 1.0;
  if (vIsDisc > 0.5) {
    float r = length(vDisc);
    if (r > 1.0) discard;
    // the light, as the 2D pass sees it on the page: view-space x and y, with
    // y up because that is the direction this quad's corners were placed in
    vec2 ls = normalize(vec2(-0.45, 0.6));
    float d = length(vDisc - ls * 0.42);
    discTone = d < 0.62 ? 1.0 : 0.82;
    // ...and its RIM, which the 2D pass strokes as ink. Nothing else can draw
    // it: the square's own edges are vetoed in the mesh, because they are not
    // where the circle is. THIN AND ONLY HALF DARK - the 2D stroke is one
    // outline width on a ball a dozen pixels across, and a heavy ring read as
    // a drawn-on target rather than as the edge of a small round thing.
    // ...A FIXED NUMBER OF PIXELS WIDE, not a fraction of the radius. An
    // outline is a pen, and a pen does not get fatter because the thing it
    // draws is nearer: the 2D pass strokes this ring at the outline width
    // whatever the zoom. As a fraction it looked right at the size an ion
    // is on a whole-structure view and turned into a thick dark band as
    // soon as anyone zoomed in on the metal - which is the whole reason to
    // zoom in on one.
    //
    // fwidth gives how much of the disc one pixel spans, so 1 - k*px is the
    // radius k pixels in from the edge. Clamped because a disc smaller than
    // the pen is all pen otherwise, and one filling the screen would get a
    // hairline that aliases away.
    float px = max(fwidth(vDisc.x), fwidth(vDisc.y));
    float pen = clamp(uDiscInk * px, 0.0, 0.3);
    if (pen > 0.004 && r > 1.0 - pen) discTone = 0.55;
  }
  if (uZOnly > 0.5) { fragColor = vec4(vZv, 0.0, 0.0, 1.0); return; }
  vec3 col = vCol * discTone;
  if (uUseAO > 0.5) {
    // THE SHADOW TERM ONLY. The tube applies two: it whitens by how EXPOSED a
    // pixel is and then darkens by how much lies in front of it, because that
    // pair is what its 2D pass computes and this had to match it. The cartoon's
    // 2D pass has no exposure term to reproduce, and carrying it here made the
    // whole drawing 11 levels LIGHTER with no shadow to show for it: every
    // inked pixel lighter, not one darker, and barely a difference between the
    // crowded places and the bare ones.
    vec2 ao = texture(uAOTex, gl_FragCoord.xy / uSizeF).rg;
    col *= (1.0 - uAOAmt) + uAOAmt * ao.r;
  }
  fragColor = vec4(grainAt(col), 1.0);
}`;

let gl, prog, buf, locPos, locZ, locCol;
let prog3, buf3, resident = null;   // { count, zMin, zMax, scale }
// THE LAST MESH, AND THE ONE BEFORE IT.
//
// A mesh is built for exactly what is on screen, so switching an object off
// and on again asks for two meshes in turn, over and over - and each rebuild
// runs the whole 2D pass and the outline pass again: 1.2 s on a ribosome with
// a peptide beside it, for a change of 68 residues out of 17,618. The
// arrays a build uploads are kept, so coming back to a mesh already built is
// two bufferData calls.
//
// ONE SPARE SLOT, because the thing people actually do is alternate. It is
// held only while the arrays are small enough to be worth holding - a
// ribosome's mesh is 45 MB of floats, and two of those is a real cost to a
// laptop, so past the cap the previous mesh is dropped and the rebuild is
// paid as before.
let lastFill = null;             // what the current build uploaded...
let lastEdges = null;            // ...and its outline, when there is one
// ...AND THE SIZE CAP IS WHAT DECIDES IT, NOT THE OBJECT COUNT.
//
// This used to read "buys nothing at all for a viewer with one object in it,
// which has no eye to switch", and was switched on only past two objects. The
// eye is not the only thing that comes back to a picture already built: side
// chains, the backbone, bases, contacts, arrows, detail - every one of those
// alternates, and every alternation is a signature this slot already holds.
// Measured on 1UBQ, one object, seven toggles:
//
//     as shipped   1 1 1 1 1 1 1     seven rebuilds
//     kept         1 0 0 0 1 0 0     two
//
// The memory argument was real and is handled by MESH_KEEP_MAX_BYTES on its
// own: `hold` below refuses anything over 16 MB, captureMesh returns null
// without lastFill, so a ribosome's 45-67 MB was never held whatever this flag
// said. The object count was a second gate on the same risk that also cost the
// commonest page there is - one structure in a notebook cell - a full rebuild
// on every toggle.
let keepArrays = false;
function setKeepMeshArrays(on) {
    keepArrays = !!on;
    if (!on) { lastFill = null; lastEdges = null; spareMesh = null; meshCache.clear(); }
}
const MESH_CACHE_MAX_BYTES = 128 * 1024 * 1024;
/**
 * ...AND THE SMALLER CAP, for anything held ACROSS builds rather than between
 * two pictures. The spare slot is one mesh, exchanged, and it goes the moment
 * a structure is edited; the ribbon half of a mesh is held while the page
 * lives and is re-examined on every rebuild. 16 MB is a 748-residue protein
 * five times over and a capsid not at all, which is the intent: 1OHF is
 * 1,199,700 faces whose fills alone are 230 MB of floats, its build already
 * peaks at 4,160 MB against a ~4.3 GB limit - 140 MB of headroom - and nobody
 * clicks side chains onto a capsid, they wait twenty seconds for it to draw.
 * The structure that can least afford a held array is the one that benefits
 * from it least. Past the cap the ribbon is rebuilt exactly as it was before
 * the split, which at that size is a rounding error against the capture.
 */
const MESH_KEEP_MAX_BYTES = 16 * 1024 * 1024;
let spareMesh = null;            // { sig, fill, edges, edgeCount, resident, pal }
const meshCache = new Map();     // sig -> mesh, caches recent meshes across focus/selection changes
let progInk, bufInk, edgeCount = 0;
// whether the resident edge buffer holds any contacts - see below
let residentHasContacts = false;
let progTube, bufTube, tubeCount = 0;
let tubeRange = [-1, 1];        // the depth range the capsules are mapped through
let tubeSig = null;             // what the instance buffer was built from
// ...AND THE CENTRE THEY WERE BUILT ABOUT. The instance data is model space
// with this subtracted, and it is deliberately view-independent - so when the
// view centre MOVES, as Orient moves it onto a selection, the difference has
// to reach the shader as a uniform. Without it the tube went on being drawn
// about the coordinate mean: measured on 1UBQ, orienting on residue 9 moved
// the 2D drawing's ink centroid to (217, 434) and left the GPU's at (299,
// 278), which is the whole structure still sitting in the middle.
let tubeCentre = [0, 0, 0];
// THE INSTANCE DATA ITSELF, kept the way the cartoon keeps its mesh: what a
// build produced, so it can be put back without being produced again. See
// captureTube/activateTube.
/* A FRAME MADE OF TWO PAINTERS.
 *
 * Objects carry their own style, so a merge can hold a ribosome drawn as a
 * tube beside a peptide drawn as a ribbon. They are different geometry models
 * and stay different (see docs/GPU_LIFECYCLE.md) - but they draw into the SAME
 * framebuffer with the SAME depth buffer, so interleaving them correctly costs
 * nothing: whoever is nearer wins, per pixel, with no sorting anywhere.
 *
 * Two things have to be arranged for that to be true:
 *
 *   composeKeepFrame - only the FIRST painter of a frame clears; the second
 *     adds to what is there. (The last one blits, and the entries decide.)
 *   composeZ - both painters map view z into the depth buffer as
 *     1 - 2 * (z - zMin) / (zMax - zMin), each from ITS OWN model's range. Two
 *     different ranges are two different depth scales, and the picture would
 *     be sorted by which model a pixel came from. In a composed frame both are
 *     given the union.
 */
let composeKeepFrame = false;   // do not clear: something is already drawn
let composeZ = null;            // the shared depth range, in view space
let tubeLive = null;            // the value currently in bufTube
let spareTube = null;           // ...and the one an eye can come back to
let tubeTouch = null;           // per-position count of drawn segments, reused
let tubeClaim = null;           // ...and which segment owns each joint's cap
let tubeData = null;            // the instance staging array, reused
// ---- GPU TIMING, off unless asked for ----------------------------------
// A WebGL draw call returns as soon as it is QUEUED, so wrapping render() in
// performance.now() times the submit and not the work: 17,000 instances came
// back as 0.28 ms that way. EXT_disjoint_timer_query_webgl2 is the only thing
// that reports what the card actually spent, and it is asynchronous - a
// query's result lands some frames after the pass, so the readback is polled
// and the number reported belongs to an earlier frame. That is fine for a
// steady-state drag, which is what this measures.
//
// One query may be active at a time, so the passes are timed in sequence and
// never nested. window.__gpuTimers turns it on; window.__gpuTimes holds the
// last complete set, in milliseconds.
let timerExt = null, timerOn = false;
const timerPending = [];        // { pass, q }
function tmStart(pass) {
    if (!timerOn) return null;
    if (!timerExt) {
        timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        if (!timerExt) { timerOn = false; return null; }
    }
    const q = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
    return { pass, q };
}
function tmEnd(h) {
    if (!h) return;
    gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    timerPending.push(h);
}
function tmCollect() {
    if (!timerOn || !timerExt) return;
    const out = window.__gpuTimes || (window.__gpuTimes = {});
    for (let i = timerPending.length - 1; i >= 0; i--) {
        const h = timerPending[i];
        if (!gl.getQueryParameter(h.q, gl.QUERY_RESULT_AVAILABLE)) continue;
        const ns = gl.getQueryParameter(h.q, gl.QUERY_RESULT);
        gl.deleteQuery(h.q);
        timerPending.splice(i, 1);
        const ms = ns / 1e6;
        const acc = out[h.pass] || (out[h.pass] = { n: 0, sum: 0, last: 0 });
        acc.n++; acc.sum += ms; acc.last = ms;
        acc.mean = +(acc.sum / acc.n).toFixed(3);
    }
}
let progStations = null;        // VS3D fed by stations; see VS3D_STATIONS
let residentStations = null;    // { buf, stationTex, pieceTex, count, ... }
let residentEdges = null;       // { ed, edSrc } - the outline and its provenance
let edgeRichPreset = false;     // ...and whether it was built in the rich preset
let lastEdgeRefresh = null;     // what refreshEdgesFromStations last did
// The station table's buffers, grown once and written into every frame.
const stationScratch = {
    stations: new Float32Array(0), faceStation: new Float32Array(0),
    faceSurf: new Float32Array(0), facePiece: new Float32Array(0),
    pieces: new Float32Array(0),
};
// 🔴 A UNIQUE NAME, BECAUSE THE BUNDLE IS CONCATENATED. `lastFill` is
// already a top-level name in another file, and two of them are a parse
// error in the built artefact and nothing at all in dev.html.
let stationFillRows = null;     // the instance rows, while stationDraw is on
let stationFillFaces = null;    // ...and the faces they were built from
// HOW MANY FACES THIS FRAME'S STATION TABLE WILL COVER, known before the mesh
// is built because the table is made from the prims and the mesh is not. When
// it equals the ribbon part's face count the station path will draw every one
// of those faces from the station buffer, so their 48-float instance rows are
// built, uploaded and never issued - and can be left out entirely. -1 means
// "no table this frame", which is every frame the station path is off.
let stationCoverCount = -1;
// ...and the table itself, for the build to read its frames out of. Valid only
// within the frame it was made in - stationMeshOf hands back subarrays of a
// scratch it reuses - which is exactly as long as makeResident needs it.
let stationCoverMesh = null;
// -1 is "draw them all", which is every path but a probe's bisect.
let instanceLimit = -1;
const EMPTY_FILL = new Float32Array(0);
// 🔴 MODULE SCOPE, because two functions need it. It was a const inside
// buildMeshPart's edge block and installParts reads it as well now - a
// ReferenceError thrown mid-rebuild, which surfaced as the station table
// failing to install with no reason given, four calls away.
const ED_FLOATS = 20;           // p0, p1, n0, n1, always, stick, pal, col, w, res
// AN EDGE'S PROVENANCE, seven integers a row: the two endpoint corners, the
// two faces whose normals it holds, how many faces are incident, the crease
// cosine it is judged by in millionths, and whether the letter decides it.
const ED_SRC = 7;

// THE FOUR CORNER CURVES AS SIGNS, WORKED OUT ONCE. A corner is a sign on the
// width axis, a sign on the thickness axis, and whether it sits at the near
// station or the far one - and all three are decided by the SURFACE and the
// corner index alone, which is twenty combinations. The per-frame edge refresh
// was deriving them with a chain of branches twice per edge row, 31,376 times
// a frame on 1TIM. Indexed `surf * 4 + idx`; surfaces 4 and up are the caps,
// which sit at the near station whichever corner they are.
const CORNER_SURFS = 16;                   // wider than any surface index in use
const CORNER_SW = new Int8Array(CORNER_SURFS * 4);
const CORNER_SG = new Int8Array(CORNER_SURFS * 4);
const CORNER_DK = new Uint8Array(CORNER_SURFS * 4);  // 1 where the corner is the far station
for (let surf = 0; surf < CORNER_SURFS; surf += 1) {
    for (let idx = 0; idx < 4; idx += 1) {
        let sw = 0; let sg = 0; let dk = 0;
        if (surf === 4) {
            sw = (idx <= 1) ? 1 : -1;
            sg = (idx === 0 || idx === 3) ? 1 : -1;
            dk = 0;
        } else if (surf === 5) {
            sw = (idx === 0 || idx === 3) ? 1 : -1;
            sg = (idx <= 1) ? 1 : -1;
            dk = 0;
        } else if (surf === 6) {
            sw = 0; sg = 0; dk = 0;
        } else if (surf === 7) { // stick +u: [0, 1, 5, 4]
            sw = (idx === 0 || idx === 3) ? 1 : -1;
            sg = 1;
            dk = (idx <= 1) ? 0 : 1;
        } else if (surf === 8) { // stick -v: [1, 2, 6, 5]
            sw = -1;
            sg = (idx === 0 || idx === 3) ? 1 : -1;
            dk = (idx <= 1) ? 0 : 1;
        } else if (surf === 9) { // stick -u: [2, 3, 7, 6]
            sw = (idx === 1 || idx === 2) ? 1 : -1;
            sg = -1;
            dk = (idx <= 1) ? 0 : 1;
        } else if (surf === 10) { // stick +v: [3, 0, 4, 7]
            sw = 1;
            sg = (idx === 1 || idx === 2) ? 1 : -1;
            dk = (idx <= 1) ? 0 : 1;
        } else if (surf === 0) {
            const isA = (idx === 0 || idx === 3);
            sw = isA ? 1 : -1; sg = 1;
            dk = (idx <= 1) ? 0 : 1;
        } else if (surf === 1) {
            const isA = (idx === 0 || idx === 3);
            sw = isA ? 1 : -1; sg = -1;
            dk = (idx <= 1) ? 0 : 1;
        } else if (surf === 2) {
            const isA = (idx === 0 || idx === 3);
            sw = 1; sg = isA ? 1 : -1;
            dk = (idx <= 1) ? 0 : 1;
        } else if (surf === 3) {
            const isA = (idx === 0 || idx === 3);
            sw = -1; sg = isA ? 1 : -1;
            dk = (idx <= 1) ? 0 : 1;
        }
        const at = surf * 4 + idx;
        CORNER_SW[at] = sw; CORNER_SG[at] = sg;
        CORNER_DK[at] = dk;
    }
}

// A FACE'S OUTWARD NORMAL IS A PROPERTY OF THE FACE, not of the edge rows that
// meet there. Two rows an edge and roughly two rows a face meant the same
// normal was derived about four times a frame; it is derived once here and
// read back by index. Kept at module scope and resized, not allocated per
// frame - this runs on every step of a playback.
let edgeNormals = null;         // Float32Array(faces * 3)
let edgeNormalOk = null;        // Uint8Array(faces), 0 for a cap
let oneSided = null;            // Int32Array: rows that are a lone cross edge
let oneSidedAt = null;          // ...and the station each one's cross-section is at
let allRowHead = null;          // station -> first row whose face sits there
let allRowNext = null;
let stationDraw = false;        // off until a caller asks; see setStationDraw
let stationRefusal = null;      // why installStations said no
// 🔴 WHY THIS FRAME DID NOT TAKE THE STATION PATH, and it survives the rebuild
// that follows. stationRefusal and lastStationUpdate are both written and then
// CLEARED by the very rebuild they explain - installStations sets
// stationRefusal = null on the way through - so a probe reading them after the
// frame sees null and concludes nothing happened. That cost a long session on a
// nucleic structure, where every reason came back empty and the answer turned
// out to be a mesh that was never built. This is set once per decline and
// cleared once per frame, at the top, by the only writer that may.
let stationDecline = null;
let lastMeshMissing = null;     // which prims yielded no stations, and why
// 🔴 THE CAPTURE THE STATION PATH ALREADY PAID FOR, kept for the rebuild that
// may follow it.
//
// A step that tries the fast path and is declined captured the frame to find
// that out - stationMeshNow runs captureFrom to get the prims the mapping is
// compared from - and the rebuild below then captured the SAME frame again.
// Measured on _traj_1tim.pdb with the pin off: 59 captures over 29 steps,
// against 29 when the pin makes every step take the path.
//
// A capture is the most expensive thing in a step (7.88 ms of a 12.36 ms step
// unpinned, because without the pin it re-derives the segment list and the
// secondary structure inside), so paying for two is most of the difference
// between a declining step and a taken one.
//
// Held only between those two points and cleared at the top of every frame, so
// it can never describe a frame that is over. The prims are the largest thing
// a build allocates - 541 MB on a 135,780-position assembly - which is why the
// fast path drops this the moment it succeeds rather than holding it for the
// life of the frame.
let heldCapture = null;
// 🔴 AND THE AUTOMATIC TABLE GIVES UP WHERE IT NEVER PAYS.
//
// A trajectory gets the station table without asking, which is worth 1.3x-1.9x
// where the mapping sometimes holds. Where it never holds it is pure cost: the
// table is built on every rebuild and declined on every frame.
//
//     _traj_1tim.pdb   494 positions   14 of 29 steps take it   1.28x
//     _traj_unfold     128             23 of 29                 1.48x
//     _traj_1ehz        76              7 of 7                  1.91x
//     _traj_9fog.pdb  3348              0 of 14                 a wash
//     _traj_syn5000.pdb 5000            0 of 19                 152 ms -> 166
//
// The pattern is SIZE, and it is not a coincidence: the mapping holds only if
// NO residue changes its secondary structure that step, and the chance of that
// falls as the residue count rises. 1TIM changes 1.3 letters of 494 a step and
// often changes none; 9FOG and syn5000 change some every time.
//
// So the rule gives up on a structure the table has NEVER helped: twelve
// declines with not one step taken. Once a single step has been taken it never
// gives up again, whatever follows.
//
// 🔴 CONSECUTIVE DECLINES WAS THE FIRST RULE AND IT MISFIRED. Eight in a row
// looked safe - 1TIM's longest run is two - until tests/station_unpinned.py
// dropped from 23 of 29 steps to none: that file INVALIDATES between steps to
// build a reference frame, and every invalidated rebuild counted as a strike.
// Anything that invalidates does: a colour mode, a slider, a resize. A rule
// that a user's unrelated action can trip is the wrong rule, and "has this
// ever paid" cannot be tripped by anything except the answer being no.
//
// Only the AUTOMATIC table gives up - a slider that asked for it owns it,
// and a decline is not their answer to reverse.
let stationAuto = false;        // the table came from the trajectory rule
let stationTries = 0;           // declines since it did
let stationEverFast = false;    // ...and whether one step has ever been taken
let stationGaveUpFor = null;    // the object it gave up on
const STATION_TRY_LIMIT = 12;
let residentPartSpans = null;   // where each part sits in the buffers
let lastStickRefresh = null;    // why refreshSticksFrom last said no
let lastStationUpdate = null;   // why updateStations last said no
const STATION_ROW = 18;         // aStation, aSurf, aPiece, aBase, three flag vec4s
let stationLinkError = null;    // why it is null, when it is
let quadIdx = null;             // [0,1,2,0,2,3], shared by every quad pass
let progCopy = null;            // the offscreen picture onto the canvas
let progAO = null;              // screen-space occlusion
let progBlur = null;            // ...and its 4x4 depth-aware resolve
let zFbo = null, zTex = null, zRb = null;   // the view-depth prepass target
// THE PICTURE'S OWN TARGET, sharing the prepass's DEPTH renderbuffer - which is
// the whole point of it (see drawTube).
let gFbo = null, cTex = null;
let aoFbo = null, aoTex = null;             // its shadow/tint answer
let aoFbo2 = null, aoTex2 = null;           // ...resolved
let occW = 0, occH = 0;
let occOk = false;              // false = no float render target; draw unshaded
// NO GPU-ONLY THICKNESS. Ribbon asks for thickness 0 and this renderer used to
// floor it at 0.3 A, because a zero-thickness piece has no outward direction and
// every awkward case lived there: normals whose sign means nothing, shared edges
// that are interior with nothing to test, coincident front and back faces.
//
// Those are fixed properly now - a double-sided boundary edge is drawn on its
// own flag, a degenerate face borrows its neighbour's normal - so the floor buys
// nothing and costs the one thing that matters here: the two renderers were
// drawing different geometry for the same setting. Kept as a knob for testing;
// 0 means the GPU builds exactly what the 2D pass builds.
// Where a fully-outlined surface counts a corner as a crease. A slab's broad
// face meets its side at 90 degrees; a ribbon bends a few degrees per station.
// how near zero a cross product counts as an extreme-corner handoff
// OFF, and the widening it controls is degenerate rather than merely too big.
//
// `c = cross_z(eDir, r)` is a normal's component across the edge, and for a
// rail both adjacent normals lie in the plane perpendicular to the chain. Seen
// broadside - the ordinary way to look at a base plate - the BROAD face points
// at the viewer, so its normal projects to nearly nothing on screen and
// min(|c0|,|c1|) is tiny at ALL FOUR corners. The test then reads every corner
// as a handoff and draws every rail, crease included. That is the inner line on
// a plate, and it is why only plates showed it: in richardson a ribbon uses the
// facing rule, so the plates are the only pieces this term reaches.
//
// The sweep is still worth recording, because it says the widening was never
// buying agreement anyway - it traded missing ink for extra ink almost 1:1 and
// the TOTAL disagreement barely moved: 10504 / 10200 / 10122 / 10222 / 10438 /
// 10393 px at 0 / .05 / .10 / .15 / .20 / .35. So switching it off costs some
// back-side outline and removes a line the reference never draws, which is the
// right side of that trade.
//
// A real handoff needs the corner projections at BOTH stations, which is what
// the 2D has and an edge-at-a-time test does not. Overridable as
// renderer.cartoonHandoff to try again.
const HANDOFF_TOL = 0.0;
const RICH_CREASE_DEG = 60;
const RICH_CREASE_COS = Math.cos(RICH_CREASE_DEG * Math.PI / 180);
// ...in the millionths the edge provenance is written in
const RICH_CREASE_M = Math.round(RICH_CREASE_COS * 1e6);
// 0.05 A, AND THE OUTLINE IS WHY. At exactly 0 a ribbon piece has no outward
// direction, so it is carried as one double-sided face - and the silhouette
// rule needs TWO faces to compare, so the edge table came out with no boundary
// edges and no creases at all: 3,422 edges against 6,988, and a drawing with
// almost no lines on it. Measured on 1TIM at the ribbon preset, dark pixels
// against the 2D pass's 14,789:
//
//   floor   dark    ink     mean abs difference from the 2D drawing
//   0       1,049   0.92x   8.60      <- the outline is simply gone
//   0.02    16,004  1.00x   2.98
//   0.05    15,987  1.01x   3.32
//   0.1     15,869  1.03x   4.43
//   0.3     14,621  1.10x   9.79      <- now visibly thicker than flat
//
// 0.02 matches marginally better and 0.05 is the safer of the two: the
// coincidence cull drops a piece to one face when its two surfaces land within
// 0.02 PROJECTED units, and the capture runs at the live zoom, so the thinner
// floor is the one that falls back through the cull first when zoomed out -
// and falling through it is exactly the no-outline case above.
const GPU_RIBBON_THICK = 0.05;
// 0, AND THE EXPERIMENT IS WHY. Giving a richardson helix a hair of real
// thickness was tried against the pale-patch bleed and does not help, because
// the pale patches in that view are not a bleed at all - the 2D reference draws
// them identically, and they are the two-tone underside a richardson helix is
// supposed to have.
//
// Worse, 0.1 is the one value to avoid. The coincidence cull fires when the two
// surfaces are within 0.02 (projected), so a helix at 0 is culled to one face
// and cannot fight itself; at 0.8 the faces are far enough apart for the depth
// buffer to separate them. 0.1 is above the cull and below the precision - both
// faces emitted, a fraction of a pixel apart - which is the z-fight the cull
// exists to prevent. Off by default; the knob stays for trying it again.
const GPU_RICH_HELIX_TH = 0;
let tubeDensity = 0.1;          // visible segments per square Angstrom
// Calibrated against the 2D render of 1TIM, matching the mean and spread of
// the drawn pixels: CPU 175.7 +/- 19.9, this 175.3 +/- 21.0. Overridable per
// renderer as tubeAOGain.
// The occlusion's areal density, in segments per square Angstrom: a constant,
// calibrated against the 2D pass across six structures spanning four orders of
// magnitude in size. See buildTube for the measurements and why it is not
// measured per structure any more.
const TUBE_AO_DENSITY = 0.164;
// The cartoon's own areal weight for the same kernel, and how much of a
// colour the shadow may take where a pixel is fully buried.
//
// Chosen by looking, over a sweep on 1TIM measured against the same view with
// the shadow off. 0.05 is real but barely legible (mean 3.4 levels darker,
// crowded places 1.6 more than bare); 0.4 reads as a shadow but starts to mud
// the colours; the tube's own density lands in between at 10.5 levels, with
// the crowded fifth of the drawing 4 levels darker than the bare fifth. Every
// inked pixel darkens or stays put - the cartoon has no exposure term, so
// nothing here can lighten the drawing.
const CARTOON_AO_DENSITY = 0.164;
const CARTOON_AO_AMOUNT = 0.8;
// WHERE THE OUTLINE SKIRT SITS IN DEPTH, as a fraction of the tube radius
// toward the eye. It was a whole radius - as near as the tube ever gets, chosen
// so a rim would never lose to its own fill - and that is too near: a rim then
// punches through tubes that are in front of it, and along a shared boundary
// the contest with the neighbour's bulge alternates pixel by pixel, which is
// the rim "chopped into dashes" recorded in FSTUBE.
//
// A QUARTER, AND THE REASON IS THE CROSSES AT THE JOINTS.
//
// Two segments that meet SHARE a position, so their axes coincide there. A
// skirt sitting uSkirtZ radii toward the eye therefore beats its neighbour's
// fill wherever that neighbour's bulge is under uSkirtZ * r - a band just
// inside the neighbour's silhouette, which prints as a dash across the joint,
// and two of them meeting is the cross. The band closes as uSkirtZ goes to 0.
//
// Measured on 1TIM at zoom 4, interior ink the 2D pass does not draw against
// rim ink it does:
//
//     uSkirtZ    crosses    missing rim
//        0          209        3139
//        0.25       210        2880
//        0.5        270        2613
//        1.0        511        2419
//
// 0.25 is at the cross floor - indistinguishable from 0 - while keeping some of
// the rim that 0 gives up, so it dominates both ends. A blurred-ink comparison
// against the 2D pass prefers 0.5 by 1-5%, and is ignored here on purpose: it
// is dominated by the antialiasing fringe, which is not fixable at this price,
// and it barely sees a thin interior line, which the eye goes straight to.
//
// It costs nothing: one multiply in the fragment shader, no extra pass.
// cartoonSkirtZ overrides it.
const SKIRT_Z = 0.25;
// ...and where a JOINT cap sits, which is a different question. The disc is
// centred on a position two tubes share, so it has to lose to BOTH of their
// fills, and it has to lose to them everywhere except where the 2D pass's own
// disc survives - outside the elbow, against the background.
//
// At the joint's own axis (0) it still surfaces as a complete ring through
// tubes it should be behind. Sunk two radii it does not, and it costs almost
// nothing to sink it: measured against the 2D pass, extra ink against rim the
// 2D draws and this does not -
//
//                 caps off        capZ -2      capZ -1.4    capZ -1
//     1TIM      206 / 4089     219 / 1401    326 / 1323   407 / 1294
//     1UBQ       82 / 1819      93 /  806    124 /  754   176 /  754
//
// - so -2 buys back two thirds of the missing rim for thirteen pixels of ink.
// Going further only buries the rim again. cartoonCapZ overrides it, and
// cartoonJointCaps = false turns the whole thing off.
const CAP_Z = -2.0;
// ...and the user-facing multiplier on it, now that the density carries the
// calibration itself.
const AO_GAIN = 1.0;

function initGL(cv) {
    gl = cv.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    // No page to report to from a shipping module: the caller gets false and
    // decides what to say about it.
    if (!gl) return false;
    // 🔴 COMPILE EVERYTHING, THEN ASK. `getShaderParameter(COMPILE_STATUS)`
    // and `getProgramParameter(LINK_STATUS)` are the two calls that make a
    // driver finish the work before answering, so querying each shader as it
    // is made serialises eight programs that could have been compiled at once.
    // The queries are all made at the end of this function instead; nothing
    // between here and there depends on an answer, and a failure is reported
    // with the same message from the same logs.
    const pending = [];
    const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        return s;
    };
    // ...and the shaders are kept per program so a link failure can say WHICH
    // of the two did not compile, which is the message the old code gave.
    const shadersOf = new Map();
    const attach = (p, type, src) => {
        const sh = mk(type, src);
        gl.attachShader(p, sh);
        if (!shadersOf.has(p)) shadersOf.set(p, []);
        shadersOf.get(p).push(sh);
        return sh;
    };
    const later = (name, p) => { pending.push([name, p]); return p; };
    const linkFailure = (name, p) => {
        for (const sh of shadersOf.get(p) || []) {
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                return name + ': ' + gl.getShaderInfoLog(sh);
            }
        }
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            return name + ': ' + (gl.getProgramInfoLog(p) || 'link failed with no log');
        }
        return null;
    };
    prog = gl.createProgram();
    attach(prog, gl.VERTEX_SHADER, VS);
    attach(prog, gl.FRAGMENT_SHADER, FS);
    gl.linkProgram(prog); later('prog', prog);
    gl.useProgram(prog);
    buf = gl.createBuffer();
    locPos = gl.getAttribLocation(prog, 'aPos');
    locZ = gl.getAttribLocation(prog, 'aZ');
    locCol = gl.getAttribLocation(prog, 'aCol');
    prog3 = gl.createProgram();
    attach(prog3, gl.VERTEX_SHADER, VS3D);
    attach(prog3, gl.FRAGMENT_SHADER, FS);
    gl.linkProgram(prog3); later('prog3', prog3);
    buf3 = gl.createBuffer();
    // THE STATION PROGRAM, WHICH IS ALLOWED TO FAIL. It is the same shader fed
    // a different way (see VS3D_STATIONS) and nothing draws with it yet, so a
    // driver that will not compile it must not take the whole painter down with
    // it - progStations stays null and the shipped path is untouched. The
    // reason is kept, because "it did not link" with no message is a day lost.
    progStations = null;
    stationLinkError = null;
    // ...and it is still allowed to fail, which is now decided at the end
    // beside every other program's answer - see the loop there.
    const psTry = gl.createProgram();
    attach(psTry, gl.VERTEX_SHADER, VS3D_STATIONS);
    attach(psTry, gl.FRAGMENT_SHADER, FS);
    gl.linkProgram(psTry);
    progStations = psTry;
    // A NEW CONTEXT INVALIDATES EVERY OBJECT THE OLD ONE OWNED. The buffers
    // below are recreated here, but the textures are made lazily and their
    // creators both short-circuit when the handle is already set - so after a
    // renderer switch they were rebound from the dead context and silently did
    // nothing. Clearing the handles is what makes initGL safe to call twice.
    visTex = null; visW = 0; visH = 0; visData = null;
    palTex = null; palW = 0; palH = 0;
    edgeCount = 0;
    residentHasContacts = false;
    progTube = gl.createProgram();
    // EARLY-Z, IF THE DRIVER WILL ALLOW IT. The extension has to be enabled on
    // the context before a shader may #extension it; where it is missing the
    // placeholder becomes nothing and the shader is the ordinary one, correct
    // and slower. The vertex shader's conservative quad depth is harmless
    // either way - it is the true nearest depth of the capsule.
    const consDepth = !!gl.getExtension('EXT_conservative_depth');
    const fsTube = FSTUBE
        .replace('__CONSEXT__', consDepth
            ? '#extension GL_EXT_conservative_depth : enable' : '')
        .replace('__CONSDECL__', consDepth
            ? 'layout (depth_greater) out float gl_FragDepth;' : '');
    attach(progTube, gl.VERTEX_SHADER, VSTUBE);
    attach(progTube, gl.FRAGMENT_SHADER, fsTube);
    gl.linkProgram(progTube); later('progTube', progTube);
    bufTube = gl.createBuffer();
    tubeCount = 0;
    // R32F HAS TO BE ASKED FOR. Float TEXTURES are core in WebGL2, but making
    // one a RENDER target is not - without this extension the prepass
    // framebuffer comes back incomplete and the occlusion silently does
    // nothing, which looks like flat colour rather than like an error.
    occOk = !!gl.getExtension('EXT_color_buffer_float');
    zFbo = null; zTex = null; zRb = null; aoFbo = null; aoTex = null;
    aoFbo2 = null; aoTex2 = null;
    occW = 0; occH = 0;
    progAO = gl.createProgram();
    attach(progAO, gl.VERTEX_SHADER, VSQUAD);
    attach(progAO, gl.FRAGMENT_SHADER, FSAO);
    gl.linkProgram(progAO); later('progAO', progAO);
    progBlur = gl.createProgram();
    attach(progBlur, gl.VERTEX_SHADER, VSQUAD);
    attach(progBlur, gl.FRAGMENT_SHADER, FBLUR);
    gl.linkProgram(progBlur); later('progBlur', progBlur);
    progCopy = gl.createProgram();
    attach(progCopy, gl.VERTEX_SHADER, VSQUAD);
    attach(progCopy, gl.FRAGMENT_SHADER, FSCOPY);
    gl.linkProgram(progCopy); later('progCopy', progCopy);
    progInk = gl.createProgram();
    attach(progInk, gl.VERTEX_SHADER, VSINK);
    attach(progInk, gl.FRAGMENT_SHADER, FSINK);
    gl.linkProgram(progInk); later('progInk', progInk);
    bufInk = gl.createBuffer();
    // SIX VERTICES FROM FOUR CORNERS.
    //
    // Every instanced quad here is two triangles over four corners, and each
    // pass synthesised the six vertices from gl_VertexID - which means the
    // vertex shader runs SIX times per quad, because two of the six carry
    // distinct gl_VertexID values for the same corner and nothing can tell the
    // GPU they are the same point.
    //
    // Drawn through an index buffer, gl_VertexID is the index VALUE, so the two
    // repeats are the same vertex and the post-transform cache serves them. It
    // is four invocations per quad instead of six for one buffer of six bytes.
    // That is worth having because the cartoon draw is GEOMETRY-bound: measured
    // on 4UG0, shrinking the structure to a 144th of its screen area only takes
    // the surface pass from 11.07 ms to 8.15, so the floor is the million
    // vertex invocations and not the fragments.
    quadIdx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
        new Uint8Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

    // NOW ASK. Every program above has been linked; these are the first calls
    // that make the driver finish, and by making them together the eight
    // compiles overlap instead of queueing behind each other's answers.
    for (const [name, p] of pending) {
        const why = linkFailure(name, p);
        if (why) throw new Error(why);
    }
    // ...and the station program's failure is not fatal: it is the same shader
    // fed a different way, nothing draws with it unless it is there, and a
    // driver that will not take it must not take the whole painter down. The
    // reason is kept, because "it did not link" with no message is a day lost.
    const stationWhy = linkFailure('stations', progStations);
    if (stationWhy) { stationLinkError = stationWhy; progStations = null; }
    return true;
}

function paintGPU(cv, faces, zMin, zMax, useDepth) {
    const data = new Float32Array(faces.length * 6 * 6);   // 2 triangles x 6 floats
    let o = 0;
    for (const f of faces) {
        const t = toneOf(f.q, f.c, zMin, zMax, f.real);
        const push = (p) => {
            data[o++] = p[0]; data[o++] = p[1]; data[o++] = p[2];
            data[o++] = t[0] / 255; data[o++] = t[1] / 255; data[o++] = t[2] / 255;
        };
        push(f.q[0]); push(f.q[1]); push(f.q[2]);
        push(f.q[0]); push(f.q[2]); push(f.q[3]);
    }
    gl.viewport(0, 0, cv.width, cv.height);
    // THE CONTROL. Without the depth test WebGL draws in submission order -
    // the painter's algorithm, on the GPU. Diffing the 2D canvas against THAT
    // measures rasterisation alone (fill rules, antialiasing at every face
    // edge); diffing it against the depth-tested pass measures rasterisation
    // AND ordering. The difference between the two is the ordering.
    if (useDepth) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); }
    else gl.disable(gl.DEPTH_TEST);
    // ...and the frame is cleared to the paper, not to white. The GPU canvas is
    // blitted over whatever the app painted, so a white clear paints a white
    // square over a black page.
    clearToPaper();
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 6 * 4;
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(locZ);
    gl.vertexAttribPointer(locZ, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(locCol);
    gl.vertexAttribPointer(locCol, 3, gl.FLOAT, false, stride, 12);
    gl.uniform2f(gl.getUniformLocation(prog, 'uSize'), cv.width, cv.height);
    gl.uniform2f(gl.getUniformLocation(prog, 'uZRange'), zMin, zMax);
    gl.drawArrays(gl.TRIANGLES, 0, faces.length * 6);
}

/* -------------------------------------------------- resident model geometry */

// The primitives come back in SCREEN space. Under an orthographic camera that
// is an affine map and therefore invertible:
//
//     sx = W/2 + x·scale        x = (sx − W/2) / scale
//     sy = H/2 − y·scale   ->   y = (H/2 − sy) / scale
//     sz = z                    z = sz
//
// so the rotated 3D positions can be recovered exactly, and undoing the known
// capture rotation gives model space. That is what lets the mesh live on the
// card while the camera becomes a uniform. It works ONLY under ortho - with
// perspective the divide has thrown information away, and the capture would
// have to move upstream into the geometry builder, which is step two proper.
function unproject(p, scale) {
    // z survives projection untouched, so the perspective factor that scaled x
    // and y is recoverable from it and divides straight back out. Under ortho
    // pe is 1 and this is the old expression exactly.
    //
    // The centre is the CAPTURE viewport's, not the canvas's - the prims were
    // projected about the middle of the wide one.
    const z = p[2];
    const fl = focalLength();
    const pe = isPersp() ? fl / Math.max(0.1, fl - z) : 1;
    const k = scale * pe;
    return [(p[0] - capW / 2) / k, (capH / 2 - p[1]) / k, z];
}

const matT = (m) => [[m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
const matMul = (a, b) => a.map((r, i) => [0, 1, 2].map((j) =>
    r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
// A NEGATED NORMAL, REUSING THE ARRAY WHERE THIS FACE IS THE ONLY THING
// HOLDING IT. `nn` in buildMeshPart starts as a fresh array built from the
// face's own Newell sum, and is REPLACED - not mutated - by `frA.n` or a
// `wSigned` result, both of which are SHARED by every face of the piece:
// negating one of those in place turns the whole strip inside out. `nnOwn`
// carries which of the two it is, so the allocation is paid only when the
// array is somebody else's.
const negOf = (v, own) => {
    if (own) { v[0] = -v[0]; v[1] = -v[1]; v[2] = -v[2]; return v; }
    return [-v[0], -v[1], -v[2]];
};
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const apply = (m, v) => [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
// ...and the same into a caller's array. `apply` returns a fresh three-element
// array, which is right where the answer is kept and pure garbage where it is
// read once and dropped - and in a mesh build it is read once and dropped
// several times per face.
const applyInto = (out, m, v) => {
    const x = v[0]; const y = v[1]; const z = v[2];
    out[0] = m[0][0] * x + m[0][1] * y + m[0][2] * z;
    out[1] = m[1][0] * x + m[1][1] * y + m[1][2] * z;
    out[2] = m[2][0] * x + m[2][1] * y + m[2][2] * z;
    return out;
};
const rotYawPitch = (yawDeg, pitchDeg) => {
    const t = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
    const Ry = [[Math.cos(t), 0, -Math.sin(t)], [0, 1, 0], [Math.sin(t), 0, Math.cos(t)]];
    const Rp = [[1, 0, 0], [0, Math.cos(p), -Math.sin(p)], [0, Math.sin(p), Math.cos(p)]];
    return matMul(Rp, Ry);
};

// THE VIEW IS ONE ACCUMULATED MATRIX, not a pair of Euler angles - the same way
// core/mol.js keeps `viewerState.rotation`. Yaw-and-pitch was fine for
// stepping to a named angle in a measurement, and wrong the moment a person
// dragged it: once pitched, a horizontal drag turns the model about the WORLD y
// axis rather than about the screen's vertical, so the structure rolls under
// the cursor and gimbal-locks looking down the axis.
//
// glRotX and glRotY are byte for byte the app's rotationMatrixX and
// rotationMatrixY, and the accumulation below is its update, so a drag here
// feels like a drag there.
//
// THE COPY STAYS, and it is named differently on purpose. This file is loaded ON
// ITS OWN by four GPU tests, so it cannot reach into core/mol.js for two
// three-line helpers - and sharing the app's NAMES made it the one file in the
// tree whose wrapper was load-bearing for parsing: concatenated into a bundle,
// `rotationMatrixX` was declared twice and the whole thing was a SyntaxError.
// Six duplicated lines under their own names cost less than either fix.
const glRotX = (a) => {
    const c = Math.cos(a), s2 = Math.sin(a);
    return [[1, 0, 0], [0, c, -s2], [0, s2, c]];
};
const glRotY = (a) => {
    const c = Math.cos(a), s2 = Math.sin(a);
    return [[c, 0, s2], [0, 1, 0], [-s2, 0, c]];
};
let viewRot = rotYawPitch(210, 20);
const currentRot = () => viewRot;
// Left-multiplied, which is what makes the increment happen in SCREEN space:
// the new rotation is applied after the accumulated one, so dragging right
// always spins the model about the screen's vertical whatever it has already
// been turned to. Right-multiplying gives the turntable that this replaces.
function rotateView(dx, dy) {
    if (dy !== 0) viewRot = matMul(glRotX(dy * 0.01), viewRot);
    if (dx !== 0) viewRot = matMul(glRotY(dx * 0.01), viewRot);
}
// For a page that still wants to step to a named angle - the lab's yaw slider,
// and every measurement taken through it.
function setViewYawPitch(yawDeg, pitchDeg2) { viewRot = rotYawPitch(yawDeg, pitchDeg2); }

// ZOOM IS A VIEW PARAMETER, so it must not rebuild the mesh. Under an
// orthographic camera zooming scales x and y and leaves depth ordering
// untouched, which is exactly one multiplier on uScale in the shader - the
// resident buffer is unaffected and a zoom costs the same as a rotation.
//
// The MESH IS ALWAYS CAPTURED AT ZOOM 1 for that to hold: `capture` renders
// through the 2D renderer to get its prims, and its `_viewScale` would
// otherwise already carry the zoom, which the shader would then apply a second
// time. `capturing` is the flag that keeps the two apart.
// THE CAMERA. `ortho` is the app's 0..1 slider and the renderer's own test is
// `persp = ortho < 1`, so anything below 1 is a perspective view - and the app
// SHIPS at 0.5. The focal length is viewerState.focalLength.
//
// Perspective was assumed to be out of reach here because the resident mesh is
// recovered by inverting the projection. It is not: `project` returns
// [x, y, z, pe] and carries z through UNCHANGED, so pe = fl / (fl - z) is
// recoverable at every captured point and divides straight back out. What
// perspective really changes is the VIEW VECTOR - (0,0,1) everywhere under
// ortho, normalize(-x, -y, fl - z) per point otherwise - which is what oB, oT
// and oN are dotted against. oLb and oLn use the fixed light and do not move.
// FOCAL LENGTH IS WHERE THE ORTHO SLIDER'S CONTINUITY LIVES. The renderer's own
// test is just `persp = ortho < 1` - a boolean - so the slider does nothing on
// its own, and with a fixed focal length it reads as a two-position switch.
// The app maps it (src/app/main.js):
//
//   baseSize    = object.stdDev * 2.0            // stdDev is the RMS radius
//   multiplier  = 1.5 + (20.0 - 1.5) * ortho     // 1.5 near, 20 far
//   focalLength = baseSize * multiplier
//
// So it scales with the structure - a ribosome and a hexapeptide get the same
// apparent perspective at the same slider value - and approaches orthographic
// as it rises. Reproduced here rather than approximated, because the reference
// renderer is driven by the same number and any disagreement shows up as the
// two projecting differently.
const STD_DEV_MULT = 2.0;
const PERSPECTIVE_MIN_MULT = 1.5;
const PERSPECTIVE_MAX_MULT = 20.0;
let sceneStdDev = 30;
// THE APP'S OWN NUMBER WINS. The focal length is not a free parameter: the
// capture projected through it, so the unprojection has to divide by exactly
// the same one or the model comes back the wrong size - and then the draw
// re-applies a different perspective on top. The app computes it once and
// keeps it on viewerState; the harness has no viewerState and derives it from
// the scene radius, which is where this formula comes from in the first place.
let flOverride = 0;
function setFocalLength(v) {
    flOverride = (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
}
function focalLength() {
    if (flOverride) return flOverride;
    const o = Math.max(0, Math.min(1, orthoAmount()));
    return sceneStdDev * STD_DEV_MULT
        * (PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * o);
}
const isPersp = () => orthoAmount() < 1;
function orthoAmount() { return orthoVal; }
// The view vector at a point, in view space - the renderer's own expression.
function viewVecAt(v) {
    if (!isPersp()) return [0, 0, 1];
    const d = [-v[0], -v[1], focalLength() - v[2]];
    const m = len3(d[0], d[1], d[2]) || 1;
    return [d[0] / m, d[1] / m, d[2] / m];
}

// NOTHING IS CULLED WHILE CAPTURING. The 2D renderer drops what falls outside
// its viewport, which is right for painting a frame and wrong for harvesting
// geometry: the mesh would hold only what was on screen at the capture view,
// and turning it afterwards opens holes where side chains used to be - atoms
// winking in and out as it rotates.
//
// `renderer._noViewCull` (cartoon/geom.js) switches that off at the source,
// which beats capturing into an oversized viewport: no second set of
// dimensions to thread through unproject, and no scale arithmetic to keep in
// step.
// INERTIA, with the app's own numbers (core/mol.js): velocity smoothed at
// 0.5 while dragging, then applied per frame as rotationMatrix*(v * 0.005) and
// damped by 0.95 until it drops under 1e-4.
//
// Whether to run it at all is decided by MEASURED FRAME COST, not by the size
// of the structure - the same call cartoon/geom.js makes for its gesture ink
// degrade, and for the same reason it gives there: a segment count is a bad
// proxy, because it knows nothing about canvas size, detail or the machine. A
// throw that stutters is worse than no throw.
let spinX = 0;
let spinY = 0;
let spinRAF = 0;
const SPIN_SMOOTH = 0.5;
const SPIN_STEP = 0.005;
const SPIN_DAMP = 0.95;
const SPIN_STOP = 0.0001;
const SPIN_BUDGET_MS = 25;

function noteDragVelocity(dx, dy, dtMs) {
    if (!(dtMs > 0)) return;
    spinX = spinX * (1 - SPIN_SMOOTH) + ((dx / dtMs) * 20) * SPIN_SMOOTH;
    spinY = spinY * (1 - SPIN_SMOOTH) + ((dy / dtMs) * 20) * SPIN_SMOOTH;
}

function stopInertia() {
    spinX = 0;
    spinY = 0;
    if (spinRAF) cancelAnimationFrame(spinRAF);
    spinRAF = 0;
}

// ONE STEP, callable on its own. Split out from the loop so the physics can be
// exercised without requestAnimationFrame - which never fires in a backgrounded
// tab, so a test that drives it through the loop proves nothing about the
// damping and everything about whether the window had focus.
// Returns true while the throw is still alive.
function inertiaStep(draw) {
    let moved = false;
    if (Math.abs(spinX) > SPIN_STOP) {
        viewRot = matMul(glRotY(spinX * SPIN_STEP), viewRot);
        spinX *= SPIN_DAMP;
        moved = true;
    } else spinX = 0;
    if (Math.abs(spinY) > SPIN_STOP) {
        viewRot = matMul(glRotX(spinY * SPIN_STEP), viewRot);
        spinY *= SPIN_DAMP;
        moved = true;
    } else spinY = 0;
    if (!moved) return false;
    const cost = draw();
    // Bow out of a throw this machine cannot carry smoothly.
    if (typeof cost === 'number' && cost > SPIN_BUDGET_MS) { stopInertia(); return false; }
    return true;
}

// `draw` repaints and returns how long it took, in ms.
function startInertia(draw) {
    if (spinRAF) cancelAnimationFrame(spinRAF);
    const step = () => {
        spinRAF = 0;
        if (inertiaStep(draw)) spinRAF = requestAnimationFrame(step);
    };
    spinRAF = requestAnimationFrame(step);
}

// SHOW/HIDE, as view state rather than geometry. The mesh always carries both
// classes; these decide what is drawn. Toggling costs one draw.
// PER-RESIDUE VISIBILITY, as a texture the shader samples. One byte per
// residue: adding or removing a side chain is a single texel write against a
// mesh that already holds the geometry - no capture, no upload of vertices.
let visTex = null;
let visW = 0;
let visH = 0;
let visData = null;
// THE PAPER TILE, uploaded once. It comes from the renderer's own paperTile()
// rather than a second noise generator here: the tile is built from
// Math.random(), so an independent copy would give the 2D reference and the GPU
// DIFFERENT paper, and every diff between them would be dominated by noise
// that means nothing. `paperTile` caches on the object it is handed, so the
// 2D renderer and this share one sheet.
//
// A SAMPLER WITH NO TEXTURE BOUND INVALIDATES THE WHOLE DRAW CALL - not just
// the fetch - so this always produces something, white when the tile cannot be
// built, and unit 2 is always bound whether the pencil is on or not.
let paperTex = null;
const paperCache = {};
function ensurePaperTexture() {
    if (paperTex) return paperTex;
    paperTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, paperTex);
    const C = window.py2dmolCartoon;
    const tile = (C && C.paperTile) ? C.paperTile(paperCache) : null;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (tile) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile);
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
            gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    // GRAIN_SCALE is 0.4, so the tile is MINIFIED - 128 texels into 51 pixels.
    // Point sampling that is aliasing, and aliasing on a noise texture shimmers
    // under rotation, which is the one thing paper must not do. The 2D path
    // gets the same filtering free from the browser's pattern minification.
    // ...and NOT by mipmapping it. That was the first attempt and it deletes the
    // effect: the tooth is a ~3 px cluster on a 128 px tile, which GRAIN_SCALE
    // 0.4 lands at about 1.2 screen pixels, so the mip the GPU picks averages
    // exactly the octave the paper is made of. What survives is the tile's MEAN,
    // 232/255, applied uniformly - a flat 5% darkening over the whole drawing
    // and no grain at all, which is precisely how it looked.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return paperTex;
}
// Bind the paper and hand a program the three numbers that place it. `amount`
// is the style's 0..1 pencil; the shader wants it already multiplied by
// PENCIL_STRENGTH, the same 0.54 the canvas puts in globalAlpha.
function bindPaper(prg, cv, amount) {
    const C = window.py2dmolCartoon;
    const K = (C && C.PENCIL) || { STRENGTH: 0.54, GRAIN_SCALE: 0.4 };
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ensurePaperTexture());
    gl.uniform1i(gl.getUniformLocation(prg, 'uPaperTex'), 2);
    gl.uniform2f(gl.getUniformLocation(prg, 'uPaperSize'), cv.width, cv.height);
    gl.uniform1f(gl.getUniformLocation(prg, 'uGrainK'), K.GRAIN_SCALE);
    gl.uniform1f(gl.getUniformLocation(prg, 'uPencil'),
        Math.max(0, Math.min(1, amount || 0)) * K.STRENGTH);
    gl.activeTexture(gl.TEXTURE0);
}

function ensureVisTexture(n) {
    const w = Math.min(4096, Math.max(1, n));
    const h = Math.ceil(n / w) || 1;
    if (visTex && visW === w && visH === h) return;
    visW = w; visH = h;
    visData = new Uint8Array(w * h).fill(255);
    if (!visTex) visTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, visData);
}
// THE EDIT. Show, hide, or GHOST one residue's geometry without touching the
// mesh. The texel is a coverage: 0 hides, 255 draws solid, and everything
// between is dropped through the fragment shader's ordered dither - so an
// opacity is one texel write, no capture and no rebuild. See VS3D.
function setResidueVisible(idx, on) {
    setResidueCover(idx, on ? 255 : 0);
}
function setResidueOpacity(idx, alpha) {
    const a = Math.max(0, Math.min(1, +alpha));
    setResidueCover(idx, Math.round(a * 255));
}
function setResidueCover(idx, v) {
    if (!visData || idx < 0 || idx >= visData.length) return;
    if (visData[idx] === v) return;
    visData[idx] = v;
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, idx % visW, Math.floor(idx / visW), 1, 1,
        gl.RED, gl.UNSIGNED_BYTE, visData.subarray(idx, idx + 1));
}
function setAllResiduesVisible(on) {
    setAllResiduesCover(on ? 255 : 0);
}
function setAllResiduesOpacity(alpha) {
    setAllResiduesCover(Math.round(Math.max(0, Math.min(1, +alpha)) * 255));
}
function setAllResiduesCover(v) {
    if (!visData) return;
    visData.fill(v);
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, visW, visH, gl.RED, gl.UNSIGNED_BYTE, visData);
}

// WHAT THE RENDERER SAYS IS GHOSTED, onto the texture. `residueOpacity` is a
// Map of position index to a number in 0..1, or null for "all solid"; the
// stamp is the renderer's own counter beside the texture's shape, so a rebuild
// (which resizes it and fills it solid) re-applies and a still frame does not.
let visStamp = '';
function applyResidueOpacity(renderer) {
    if (!visData) return;
    // ...FROM THE OBJECTS THAT ARE DRAWN, each in its own numbering - see
    // drawnOpacity in core/mol.js. The fade belongs to the object, so adding
    // another one cannot take it away and loading another cannot inherit it.
    const map = (renderer && typeof renderer.drawnOpacity === 'function')
        ? renderer.drawnOpacity() : null;
    const ver = (renderer && renderer._opacityVersion) || 0;
    const stamp = ver + '|' + visW + 'x' + visH + '|' + (map ? map.size : 0)
        + '|' + (renderer ? renderer.currentObjectName : '');
    if (stamp === visStamp) return;
    visStamp = stamp;
    setAllResiduesCover(255);
    if (!map || !map.size) return;
    for (const [idx, a] of map) setResidueOpacity(idx, a);
}

// THE PALETTE, as a texture. Three texels per segment - its own colour and the
// two half-bond colours element colouring supplies - so repainting the whole
// structure is one upload of a few kilobytes against a mesh that never moves.
let palTex = null;
let palW = 0;
let palH = 0;
function setPalette(cols) {
    if (!gl || !cols) return;
    const n = cols.length;
    const need = n * 3;
    const w = Math.min(4096, Math.max(1, need));
    const h = Math.ceil(need / w) || 1;
    const data = new Uint8Array(w * h * 4);
    const put = (i, c) => {
        if (!c) return;
        data[i * 4] = c.r; data[i * 4 + 1] = c.g; data[i * 4 + 2] = c.b; data[i * 4 + 3] = 255;
    };
    const halves = cols.halves || null;
    for (let i = 0; i < n; i++) {
        put(i * 3, cols[i]);
        const hv = halves && halves[i];
        // absent halves fall back to the segment's own colour, so a face that
        // asks for one always reads something sensible
        put(i * 3 + 1, (hv && hv.a) || cols[i]);
        put(i * 3 + 2, (hv && hv.b) || cols[i]);
    }
    gl.bindTexture(gl.TEXTURE_2D, palTex || (palTex = gl.createTexture()));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (palW !== w || palH !== h) {
        palW = w; palH = h;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
}

let showRibbon = true;
let showSticks = true;
function setVisible(o) {
    if (o.ribbon !== undefined) showRibbon = !!o.ribbon;
    if (o.sticks !== undefined) showSticks = !!o.sticks;
}

// THE VIEW SPAN, as it stands against the view span the mesh was captured under.
//
// The mesh is model-space Angstrom: the capture divided the renderer's view
// scale out and its centre off. Both of those move WITHOUT the geometry
// changing - Orient reframes on a selection by writing viewerState.center and
// viewerState.extent, and the fly-to writes them again every frame - so
// treating them as view parameters is not an optimisation, it is the only way
// the animation can run at all. A rebuild per frame is seconds on the
// structures this path exists for.
//
// viewScaleMul is the ratio of what the live view span fits to against what the
// captured one did - see spanFit - and viewShift is capCentre - liveCentre in
// model space. Both are 1 and zero for the lab, which has no renderer and
// never moves either.
let viewScaleMul = 1;
let viewShift = [0, 0, 0];
let currentModelCenter = [0, 0, 0];
let currentCapCentre = [0, 0, 0];

function modelCenterOf(renderer) {
    const o = (renderer && renderer.objectsData && renderer.objectsData[renderer.currentObjectName]);
    if (o && o.center && o.center.length >= 3) return [o.center[0], o.center[1], o.center[2]];
    if (renderer && renderer._computeViewCentre) {
        const c = renderer._computeViewCentre(o);
        if (c) return [c.x, c.y, c.z];
    }
    return [0, 0, 0];
}

function setViewTransform(mul, shift) {
    viewScaleMul = (typeof mul === 'number' && isFinite(mul) && mul > 0) ? mul : 1;
    viewShift = shift || [0, 0, 0];
}
// device pixels per Angstrom, the one number both draw passes scale by
// ...and NOT a separate zoom term any more: `viewScaleMul` is a ratio of
// half-spans and those carry the zoom, so dividing it out here as well would
// apply it twice.
const drawScale = () => (resident ? resident.scale * viewScaleMul : 1)
    * pixelRatio;
// The depth range travels with the shift: it is measured around the capture's
// centre, and a shift moves every z by the same amount.
const shiftZ = () => {
    const R = currentRot();
    return R[2][0] * viewShift[0] + R[2][1] * viewShift[1] + R[2][2] * viewShift[2];
};

// The clip slab, in view space, straight from the renderer. off = near <= far.
let clipNear = 0, clipFar = 0, clipFade = 0;
function setClipSlab(near, far, fade) {
    clipNear = (typeof near === 'number' && isFinite(near)) ? near : 0;
    clipFar = (typeof far === 'number' && isFinite(far)) ? far : 0;
    clipFade = (typeof fade === 'number' && isFinite(fade) && fade > 0) ? fade : 0;
}
// ...and onto whichever program is about to draw.
function uploadClip(prog) {
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipNear'), clipNear);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipFar'), clipFar);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipFade'), clipFade);
}

let viewZoom = 1;
let capturing = false;
const currentZoom = () => (capturing ? 1 : viewZoom);
function setZoom(z) { viewZoom = Math.max(0.15, Math.min(12, z)); }
// The lab's slider has a range; the app's zoom does not, and clamping it would
// silently disagree with the 2D path at either end.
function setZoomExact(z) { viewZoom = (typeof z === 'number' && z > 0) ? z : 1; }
function zoomBy(f) { setZoom(viewZoom * f); }

// THE KEY LIGHT, used to decide which way a stick's Newell normal should point.
// It was written out inside buildMeshPart's per-face loop, so the array and its
// length were built again for every face in the build.
const LIT_L = [-0.45, 0.6, 0.75];
const LIT_LM = len3(LIT_L[0], LIT_L[1], LIT_L[2]);

// Build the resident buffer once: model-space corners, a model-space face
// normal, and the face's base colour. Shading happens in the shader from then on.

/**
 * ONE HALF OF A MESH: faces in, the arrays a draw needs out. No GL, no
 * globals - which is what lets it be called twice and one of the two answers
 * kept. See makeResident below for why there are two halves at all.
 */
/**
 * @param {boolean} [rowsUnused] this part's 48-float instance rows will not be
 *   drawn - the station buffer supplies them - so the five shading vectors and
 *   the row emit are skipped and the fill comes back empty. See makeResident
 *   for the test that decides it and stationRowsFromFaces for what the station
 *   table reads instead.
 */
function buildMeshPart(faces, scale, prm, lines, rowsUnused, smOffset) {
    const P0 = prm || defaultParams();
    if (P0.ortho !== undefined) setOrtho(P0.ortho);
    // Stage timings, for finding what a build actually spends its time on.
    const MP = (window.__mrPhase = { t0: performance.now(), faces: faces.length });
    const mark = (k) => { MP[k] = +(performance.now() - MP.t0).toFixed(1);
        if (window.__heapProbe) {
            // LIVE bytes, not the garbage a build leaves behind it: window.gc
            // is a silent no-op without --js-flags=--expose-gc, and the heap
            // after a pass is mostly uncollected without one.
            if (window.gc) { window.gc(); window.gc(); }
            MP[k + 'MB'] = Math.round(((performance.memory || {}).usedJSHeapSize || 0) / 1e6);
        } };
    const VR = currentRot();
    const inv = matT(VR);                                 // rotations are orthonormal
    // THE FLAT STROKES, lifted the same way the surfaces are. Each consecutive
    // pair of a polyline becomes one ink instance.
    //
    // ITS WIDTH IS AN ANGSTROM, which is what the renderer says it is:
    // CONTACT_WIDTH is 1.175 A "on the same scale the Line Width control works
    // in", so a contact grows and shrinks with the structure. The prim also
    // carries that width already converted to pixels - but only for the frame
    // it was computed for, with the view scale AND the perspective factor
    // multiplied in. Carrying the pixel number instead, as a multiple of the
    // outline's width, was wrong four ways: it froze the zoom at the capture's,
    // it froze the perspective, it made the Outline slider resize every contact
    // in the picture, and it dragged in the 0.8 fudge that exists for the
    // ribbon's silhouette. uScale already carries the zoom and the device
    // ratio, and pe is per vertex, so the shader needs neither.
    let hasContacts = false;
    const contactEdges = [];
    const dMx = currentCapCentre[0] - currentModelCenter[0];
    const dMy = currentCapCentre[1] - currentModelCenter[1];
    const dMz = currentCapCentre[2] - currentModelCenter[2];
    for (const ln of (lines || [])) {
        // TAKE THE DEPTH BIAS BACK OFF FIRST. A contact's projected points have
        // it added to their z - the 2D pass sorts on that channel and never
        // reads position from it, so the drawn line does not move. Unprojecting
        // from a biased z does move it: the point comes back half an Angstrom
        // toward the eye in MODEL space, along whatever direction the capture
        // happened to be looking, and that offset then turns with the structure
        // - the contact drifting off the two CAs it names as the view rotates.
        const zb = ln.zBias || 0;
        const mp = ln.pts.map((q2) => {
            const v = apply(inv, unproject([q2[0], q2[1], q2[2] - zb], scale));
            return [v[0] + dMx, v[1] + dMy, v[2] + dMz];
        });
        // fall back to the pixel width over the CAPTURE scale if a build of the
        // renderer predates wA - wrong under zoom, but not wildly wrong
        const wA = ln.wA !== undefined ? ln.wA : (ln.w / Math.max(1e-6, scale));
        for (let i2 = 0; i2 + 1 < mp.length; i2++) {
            contactEdges.push({ p0: mp[i2], p1: mp[i2 + 1],
                c: [ln.c.r, ln.c.g, ln.c.b], wA });
        }
    }
    const wSigned = (fr, sgn) => (fr && fr.w
        ? [sgn * fr.w[0], sgn * fr.w[1], sgn * fr.w[2]] : null);
    const normv = (v) => {
        const l = len3(v[0], v[1], v[2]) || 1;
        return [v[0] / l, v[1] / l, v[2] / l];
    };
    // 25 floats of per-vertex data, plus the face's outward normal and the
    // face's flat-shading normal - 31 in all. KEEP THIS IN STEP WITH `stride`
    // and the bind offsets below: a mismatch does not error, it silently
    // reads the wrong attribute, and an unbound one reads (0,0,0).
    const data = rowsUnused ? EMPTY_FILL : new Float32Array(faces.length * 48);
    // 🔴 THE STATION TABLE, WHERE THIS PART IS DRAWN FROM IT. A rib face's
    // outward normal is its station's own frame - `normalOf` in
    // refreshEdgesFromStations derives exactly that, and the fast path has been
    // drawing the outline from it on every frame - so where the table covers
    // this part there is no need to rebuild the piece frames to find it. That
    // takes the whole pieceFrames pass and its rail bookkeeping with it.
    //
    // 🔴 AND THE CHECK TURNS IT OFF, WHICH IS THE POINT. The comparison below
    // needs the piece frames to compare AGAINST, and this is what stops them
    // being built. Measuring with it on compares the station rule against
    // whatever the orientation falls back to with no frames at all - which
    // reported a worst disagreement of 1.79 on a unit vector and cost this
    // change a revert before the mistake was found. With the frames built, the
    // two agree to 0.000 over 70,060 faces.
    // 🔴 AND THE TABLE MAY DESCRIBE MORE THAN THIS PART. It was an equality,
    // which is right while the ribbon is the only stationed part and its faces
    // are the table's first and last. The side chains are stationed too now and
    // sit AFTER the ribbon in it, so what this part needs is a window: `smOff`
    // rows in, `faces.length` long, inside a table that is at least that big.
    const smOff = smOffset || 0;
    const SM = (rowsUnused && stationCoverMesh
        && stationCoverMesh.faceCount >= smOff + faces.length
        && !(typeof window !== 'undefined' && window.__stationNormalCheck))
        ? stationCoverMesh : null;
    /**
     * EVERY FACE'S FOUR MODEL-SPACE CORNERS, IN ONE ARRAY.
     *
     * They used to be five objects a face - an array of four [x,y,z] arrays -
     * held from the normals pass until the centroids at the very end, which is
     * across the two most expensive passes in the build. On 4UG0's 188,738
     * ribbon faces that is the difference between +145 MB (rails and normals
     * together) and 18. Every face is a quad: checked on protein, RNA and a
     * nucleosome, 26,700 / 15,250 / 47,000 faces, all of them four-cornered.
     *
     * Float64, not Float32. The edge table matches two faces by hashing their
     * corners quantised to 1e-3, and the same point computed by two faces
     * agrees to the last bit in double - rounding it to float32 first would
     * make that agreement depend on which side of a boundary the rounding
     * fell, and a missed match is a missed weld: a line drawn across a solid.
     */
    const M = new Float64Array(faces.length * 12);
    const hasM = new Uint8Array(faces.length);
    // THE NEWELL LENGTH, FLAT, because the edge pass asks the same question of
    // the same four corners a second time. As a property on the face it read
    // just as well and cost 3-7 MB of peak live heap on a nucleosome - a
    // hidden-class transition and a properties slot per face against eight
    // bytes here, and this file's ceiling is a capsid.
    const nLenOf = new Float64Array(faces.length);
    // ...and four scratch corners, so the passes that consumed `f._m` keep the
    // shape they were written for.
    const CS = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    // ...and three more for values that are read inside one face's turn of the
    // loop and never kept: the rotated normal the stick rule tests, and the two
    // halves of the tangent's own unprojection.
    const RN = [0, 0, 0]; const TS = [0, 0, 0]; const TV = [0, 0, 0];
    const TX = [1, 0, 0];
    const loadM = (fi) => {
        const b = fi * 12;
        for (let k = 0; k < 4; k++) {
            const c = CS[k]; const o = b + k * 3;
            c[0] = M[o]; c[1] = M[o + 1]; c[2] = M[o + 2];
        }
        return CS;
    };
    const storeM = (fi, m) => {
        const b = fi * 12;
        for (let k = 0; k < 4; k++) {
            const c = m[k]; const o = b + k * 3;
            M[o] = c[0]; M[o + 1] = c[1]; M[o + 2] = c[2];
        }
        hasM[fi] = 1;
    };
    /**
     * `apply(inv, unproject(p, scale))` WITH NOTHING ALLOCATED, straight into
     * the flat store.
     *
     * Every stick face reached the second pass without corners of its own -
     * only surf-0 rib faces are filled in by the rails pass - so it ran
     * `f.q.map((p) => apply(inv, unproject(p, scale)))`: four closures' worth
     * of intermediate, two arrays a corner plus the map's own, about nine
     * allocations per face and 70,362 stick faces on a nucleosome with its
     * side chains out. The arithmetic is the two functions' bodies in their
     * own order, so it is bit-identical; what goes is the garbage.
     */
    const unprojInto = (out, p) => {
        const z = p[2];
        const fl = focalLength();
        const pe = isPersp() ? fl / Math.max(0.1, fl - z) : 1;
        const k = scale * pe;
        const x = (p[0] - capW / 2) / k;
        const y = (capH / 2 - p[1]) / k;
        out[0] = inv[0][0] * x + inv[0][1] * y + inv[0][2] * z + dMx;
        out[1] = inv[1][0] * x + inv[1][1] * y + inv[1][2] * z + dMy;
        out[2] = inv[2][0] * x + inv[2][1] * y + inv[2][2] * z + dMz;
    };
    // ...and the same, landing in the flat store as well as in the scratch.
    const cornersInto = (fi, q) => {
        const b = fi * 12;
        for (let k = 0; k < 4; k++) {
            const c = CS[k]; unprojInto(c, q[k]);
            const o = b + k * 3;
            M[o] = c[0]; M[o + 1] = c[1]; M[o + 2] = c[2];
        }
        hasM[fi] = 1;
        return CS;
    };
    let o = 0;
    let zMin = Infinity, zMax = -Infinity;

    // PASS ONE: A FRAME AT EVERY STATION, not one per piece.
    //
    // The smooth path draws a strip as a gradient whose stops are the
    // per-station tones, so the shading has to vary continuously ALONG the
    // ribbon. Deriving the normal from the width vector while holding the
    // tangent at the piece mean does not do that: consecutive width vectors
    // are nearly parallel, both ends of a quad come out with the same normal,
    // and the strip paints as one flat band per station pair with a step at
    // every face boundary. That is the banding.
    //
    // A station's frame is its own: width from L[k] to R[k], tangent from the
    // centre line through it, normal their cross product. Neighbouring faces
    // then SHARE the frame at the station between them, so the interpolated
    // shading is continuous across the join by construction.
    mark('unprojectFrames');
    const pieceFrame = new Map();
    const pieceRails = new Map();
    for (let fi = 0; fi < faces.length; fi++) {
        const f = faces[fi];
        if (f.pieceId === undefined || f.surf !== 0) continue;
        // KEPT FOR THE NORMALS PASS BELOW, which wants the same four corners in
        // the same space and used to unproject them a second time. It goes into
        // the flat store rather than onto the face: the rails read it here and
        // now, and holding it per face is what cost 76 MB on a ribosome.
        // THE FOUR ARRAYS ARE KEPT - the rails hold them until the piece's
        // frames are built - so they are allocated, but the two intermediates
        // per corner that `apply(inv, unproject(...))` built on the way are
        // not: `unprojInto` writes the answer straight into the one that
        // survives.
        const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let k = 0; k < 4; k++) unprojInto(m[k], f.q[k]);
        storeM(fi, m);
        if (SM) continue;               // the frames come from the table
        let e = pieceRails.get(f.pieceId);
        if (!e) { e = { L: [], R: [], oB: f.oB, kAvg: f.kAvg }; pieceRails.set(f.pieceId, e); }
        e.L[f.st] = m[0]; e.R[f.st] = m[1];          // station k
        e.L[f.st + 1] = m[3]; e.R[f.st + 1] = m[2];  // station k+1
        if (f.ubA && f.waA && f.tvA) {
            if (!e.frames) e.frames = [];
            // BACK OUT OF THE VIEW ROTATION, exactly as the corner positions
            // are. mkRenderer hands the renderer coordinates that are ALREADY
            // turned, so everything it computes - including this frame - comes
            // back in the rotated frame, while the resident mesh is built in
            // the unrotated one. Using them as-is rotates the lighting away
            // from the geometry by the whole view matrix.
            const un = (v) => normv(apply(inv, v));
            // the width normal points centre->L (L is the +n corner), and `w`
            // here is R - L, so it is stored negated
            const neg = (v) => [-v[0], -v[1], -v[2]];
            e.frames[f.st] = { n: un(f.ubA), t: un(f.tvA), w: neg(un(f.waA)) };
            if (f.ubB) {
                e.frames[f.st + 1] = { n: un(f.ubB), t: un(f.tvB), w: neg(un(f.waB)) };
            }
        }
    }
    const cross = (a2, b2) => [a2[1] * b2[2] - a2[2] * b2[1],
        a2[2] * b2[0] - a2[0] * b2[2], a2[0] * b2[1] - a2[1] * b2[0]];
    const sub = (a2, b2) => [a2[0] - b2[0], a2[1] - b2[1], a2[2] - b2[2]];
    const mid = (a2, b2) => [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2, (a2[2] + b2[2]) / 2];
    mark('rails');
    for (const [id, e] of (SM ? [] : pieceRails)) {
        const ns2 = e.L.length;
        const cen = [];
        for (let k = 0; k < ns2; k++) if (e.L[k] && e.R[k]) cen[k] = mid(e.L[k], e.R[k]);
        const frames = [];
        for (let k = 0; k < ns2; k++) {
            if (!e.L[k] || !e.R[k]) continue;
            const prev = cen[k - 1] || cen[k];
            const next = cen[k + 1] || cen[k];
            let t = sub(next, prev);
            if (len3(t[0], t[1], t[2]) < 1e-9) t = [1, 0, 0];
            const w = sub(e.R[k], e.L[k]);
            // `n` is the BROAD face normal (+-b) and `w` the width direction,
            // R MINUS L. Mind the sign: the renderer puts the L rail at +wa
            // (`lp = P(1, 1)`, `rp = P(-1, 1)`) and defines oN as wa . view, so
            // R - L runs along -wa and the L side's OUTWARD direction is minus
            // this vector. Getting that backwards lights each band with its
            // neighbour's value, which is worse than not interpolating at all
            // and is what the first cut of this measured.
            // THE RENDERER'S FRAME IF IT GAVE US ONE. Rebuilding it from the
            // projected rails recovers a direction but not a SIGN - nothing in
            // a drawing says which side of a ribbon was the outside - and each
            // attempt to pin that sign afterwards got a different set of faces
            // wrong. `_frameProbe` asks the renderer for the vector instead.
            const src = e.frames && e.frames[k];
            frames[k] = src
                ? { n: src.n, t: src.t, w: src.w }
                : { n: normv(cross(t, w)), t: normv(t), w: normv(w) };
        }
        // NOTHING TO DECIDE when the frame came from the renderer: its sign is
        // the one every captured dot product was taken against, so it is right
        // by construction. Only a rebuilt frame needs making self-consistent -
        // and a rebuilt frame's overall sign is simply not recoverable from a
        // projected drawing, which is what three failed attempts established.
        if (!e.frames) {
            let ref = null;
            for (let k = 0; k < ns2; k++) if (frames[k]) { ref = frames[k].n; break; }
            if (ref) {
                for (const fr of frames) {
                    if (!fr) continue;
                    if (dotv(fr.n, ref) < 0) fr.n = [-fr.n[0], -fr.n[1], -fr.n[2]];
                }
            }
        }
        // THE PIECE MEAN OUTWARD DIRECTION, for the flat path. The reference
        // quantises ONE value per piece per side; the shader quantises what
        // reaches the fragment. Feed it a per-quad value and the two snap to
        // different bands wherever the quad disagrees with the piece - a
        // difference that simply averaged out before quantisation existed.
        let wm = [0, 0, 0];
        let nm = [0, 0, 0];
        for (const fr of frames) if (fr) { wm[0] += fr.w[0]; wm[1] += fr.w[1]; wm[2] += fr.w[2]; }
        // ...AND THE SAME FOR THE BROAD FACES, which is what this comment was
        // about all along and only the sides ever got. A flat broad face took
        // its own station's normal, so consecutive quads of one piece quantised
        // into different bands and every station boundary came out as a step -
        // the ribbon visibly darker between positions with Smooth off, which is
        // the default in plain cartoon.
        for (const fr of frames) if (fr) { nm[0] += fr.n[0]; nm[1] += fr.n[1]; nm[2] += fr.n[2]; }
        pieceFrame.set(id, { frames, oB: e.oB, wMean: normv(wm), nMean: normv(nm) });
        // the rails for this piece have now become its frames, and the two
        // arrays of corner points behind them are nobody's business after that
        e.L = null; e.R = null; e.frames = null;
    }


    // EDGE TABLE for the outline pass, keyed by the two endpoints so the two
    // faces that share an edge find each other. Quantised to 1e-3 model units:
    // the rails of adjacent strip quads are the SAME computed point, so they
    // agree to floating point, and the quantisation is only insurance.
    const edgeMap = new Map();

    // ...and a NUMERIC version of the same thing, READ OFF THE FLAT STORE BY
    // OFFSET. The edge pass asks for a corner's identity about eight times
    // (four edges, two ends each), and on a structure the size of 9FOG that was
    // half a million template literals built out of three Math.rounds apiece.
    //
    // NOTHING IS CACHED ON THE POINT, and nothing can be: the corners handed
    // around here are a REUSED scratch, so a hash stashed on the array would be
    // the previous face's. Taking the offset rather than an array is what saved
    // the copy INTO that scratch - the twelve doubles of a face were loaded so
    // that six of them could be hashed.
    // 🔴 THE QUANTUM IS A HOISTED LOCAL SO THE HARNESS CAN MOVE IT, and for no
    // other reason. tests/station_edges.py sets `window.__edgeQuantum` to prove
    // that a change of CORNER IDENTITY reaches the arrays it diffs - which is
    // the exact class of change stage 2 of the plan makes, so a harness blind
    // to it would be blind to the thing it exists to check. Read once per
    // build, never per call: this is the innermost read of the edge pass.
    const hashQ = window.__edgeQuantum || 1000;
    const hashAt = (o) => {
        const h = Math.round(M[o] * hashQ) * 73856093
            ^ Math.round(M[o + 1] * hashQ) * 19349663
            ^ Math.round(M[o + 2] * hashQ) * 83492791;
        return h >>> 0;
    };
    // ONE MAP AND A LINKED LIST, not a Map of Maps. An edge is identified by
    // its two endpoint hashes; a single packed number would need 64 bits and
    // collide past 2^53, so the first hash picks a GROUP and the second is
    // searched within it. The groups used to be Maps - about one per edge on a
    // large structure, each a hundred-odd bytes of object to hold two or three
    // numbers. They are chains through an Int32Array now, and a chain is two
    // or three long, so walking it beats hashing again.
    //
    // The ORDER is why it is a chain and not a table: the outline is emitted
    // group by group in first-seen order and, within a group, in insertion
    // order - which is exactly what a Map of Maps yields and what the ink pass
    // (depth mask off, later strokes over earlier) is drawn from.
    // 🔴 SIZED FROM THE FACE COUNT, NOT GROWN FROM 1024. A quad has four edges
    // and neighbours share them, so the edge count lands near twice the face
    // count - which is known here. Starting at 1024 and doubling meant seven
    // reallocations of four arrays on a 46,463-face structure, copying about as
    // much again as the final size and leaving every intermediate for the
    // collector. The growth path is kept: it costs nothing when it never runs,
    // and a structure that beats the estimate must still work.
    // 🔴 2.5, NOT 2, AND THE NUMBER IS MEASURED. A quad has four edges and
    // neighbours share them, so the count lands a little OVER twice the face
    // count - the boundary edges are the ones nobody shares. Measured after the
    // helix stopped being a zero-thickness slab, when its two width bands
    // gained area and the edges that go with them:
    //
    //     1UBQ  2,088 edges / 1,019 faces = 2.049
    //     3CHY  3,656 / 1,795            = 2.037
    //     1AOI 36,618 / 17,552           = 2.087
    //
    // At a factor of 2 every one of those grows once, which tests/load_work.py
    // caught the moment the thickness landed - a reallocation of four arrays
    // of which the largest is megabytes. 2.5 is 20% clear of the worst measured
    // and costs 15 floats and 9 ints per unused slot: 2.6 MB against 2.1 on
    // 1AOI, and the growth path is still there for a shape that beats it.
    let gCap = Math.max(1024, (faces.length * 2.5) | 0);
    let gN = 0;
    let gHead = new Int32Array(gCap);
    let gTail = new Int32Array(gCap);
    const gGrow = () => {
        if (typeof window !== 'undefined') window.__gGrow = (window.__gGrow || 0) + 1;
        gCap *= 2;
        const h2 = new Int32Array(gCap); h2.set(gHead); gHead = h2;
        const t2 = new Int32Array(gCap); t2.set(gTail); gTail = t2;
    };
    // GHOST EDGES. A face may need to be COUNTED along an edge without being
    // allowed to ink it. The cross-strip edges of a rib quad are the case: the
    // reference never runs ink across a ribbon, so a rib face must not create
    // one - but the flat CAP at a piece end lands on exactly those four edges,
    // and if the rib does not register there the cap's rim has one incident
    // face, reads as an open boundary, and is drawn whatever the view. That is
    // the square permanently ruled across the blunt back of every arrow.
    //
    // A ghost contributes its normal and its count and nothing else; an edge
    // with no REAL face is never emitted. So a mid-strip cross edge still has
    // two ghosts and stays invisible, while a cap rim has one real face and one
    // ghost - two normals, and the ordinary silhouette test decides it.
/**
 * AN EDGE IS SEVENTEEN NUMBERS, NOT AN OBJECT.
 *
 * The edge table is the largest allocation in a build - measured on 4UG0,
 * 188,738 ribbon faces: rails +76 MB, normals +69 MB, and the edge pass
 * +120 MB, against a fill of 36. It was one object per edge, nineteen fields
 * apiece, in a Map of Maps; a capsid multiplies that by ten and the build
 * already peaks at 4,160 MB against a ~4.3 GB limit.
 *
 * So the fields live in two flat arrays and the map holds an INDEX. The map
 * itself stays, and so does the ITERATION ORDER - the outline instances are
 * emitted in the order the map yields them, and the ink pass draws with the
 * depth mask off, so a later stroke paints over an earlier one. Reordering
 * them would be a picture change wearing a memory change's clothes.
 */
    const E_F = 15;        // p0(3) p1(3) n0(3) n1(3) col(3)
    // 🔴 FOUR MORE, SO AN EDGE CAN SAY WHERE IT CAME FROM. An endpoint is
    // already an identity - `oa` is fi*12 + corner*3 into the flat corner store
    // - and the two faces that claim an edge are what its two normals are. Kept,
    // the whole instance can be rebuilt from a station table without running the
    // hash and the adjacency again; not kept, the outline is frozen at the frame
    // the mesh was built for. See refreshEdgesFromStations.
    // ...and it is FIVE when nothing will read the other four. eIn is allocated
    // and grown per build, so paying for four numbers a reader who never
    // never turns the table on will never look at is the same tax as edgeSrc below.
    const E_I = stationDraw ? 10 : 6;
    // THE RESIDUE, at the end of whichever layout is in force. Put here rather
    // than in the middle so the station slots keep the indices every reader
    // already uses; one constant, written once and read once. It is what lets
    // the OUTLINE be ghosted with the fill it outlines - see uVis in the ink
    // vertex shader.
    const E_RES = stationDraw ? 9 : 5;
    const EB_TWO = 1; const EB_NOINK = 2; const EB_STICK = 4;
    const EB_FULL = 8; const EB_SEAM = 16; const EB_OUTER = 32;
    const EB_COL = 64; const EB_N0 = 128; const EB_N1 = 256;
    // 🔴 A STRIP'S CROSS EDGE, which is the one edge in the ribbon whose
    // existence follows the LETTER: a Richardson strand draws its creases and a
    // loop does not (`fullOutline`). Marked here so the row can be emitted
    // either way and the decision made per frame, the way the crease test
    // already is - see refreshEdgesFromStations.
    const EB_CROSS = 512;
    // ...and the other half of that question: does anything claim this edge for
    // a reason the letter does NOT decide? A cap shares its rim with the
    // strip's cross edge, and a cap's outline is a property of the chain. An
    // edge with any such claim is never turned off by a letter.
    const EB_ALONG = 1024;
    let eCap = Math.max(1024, (faces.length * 2.5) | 0);   // see gCap
    let eF = new Float32Array(eCap * E_F);
    let eIn = new Int32Array(eCap * E_I);
    // UNSIGNED: the endpoint hashes are `h >>> 0` and half of them are past
    // 2^31. In an Int32Array those come back negative and never compare equal
    // to the number being looked up, so every edge is created fresh - which
    // looks like a working build with twice the outline instances.
    let eHi = new Uint32Array(eCap);       // the second endpoint's hash
    let eNext = new Int32Array(eCap);      // ...and the next edge in its group
    let eN = 0;
    const eGrow = () => {
        // HOW OFTEN THE ESTIMATE WAS BEATEN. Zero on every structure measured;
        // tests/load_work.py fails if it is not, because a reallocation here
        // copies four arrays of which the largest is megabytes.
        if (typeof window !== 'undefined') window.__eGrow = (window.__eGrow || 0) + 1;
        eCap *= 2;
        const f2 = new Float32Array(eCap * E_F); f2.set(eF); eF = f2;
        const i2 = new Int32Array(eCap * E_I); i2.set(eIn); eIn = i2;
        const h2 = new Uint32Array(eCap); h2.set(eHi); eHi = h2;
        const n2 = new Int32Array(eCap); n2.set(eNext); eNext = n2;
    };
    const eSc = window.__scProbe ? {} : null;
    const eOther = window.__scProbe ? {} : null;
    // TWO OFFSETS AND THEIR HASHES, not two corner arrays. The caller has both
    // hashes already - it builds the per-face duplicate key out of them a line
    // above the call - and this recomputed them, six multiplies and three
    // rounds twice over on every edge of every face; and the corners live in
    // the flat store, so an offset is all the endpoint needs to be.
    const addEdge = (oa, ob, ha, hb, nrm, isStick, pal, ghost, two, noInk, col,
        full, seam, outer, sc, cross, res) => {
        if (ha === hb) return;      // the repeated corner of a fan-padded quad
        const lo = ha < hb ? ha : hb;
        const other = ha < hb ? hb : ha;
        let g = edgeMap.get(lo);
        if (g === undefined) {
            g = gN++;
            if (gN > gCap) gGrow();
            gHead[g] = -1; gTail[g] = -1;
            edgeMap.set(lo, g);
        }
        let e;
        for (let x = gHead[g]; x >= 0; x = eNext[x]) {
            if (eHi[x] === other) { e = x; break; }
        }
        if (e === undefined) {
            // TWO SLOTS, NOT AN ARRAY. Only the first two normals are ever
            // kept, and an array per edge is an allocation per edge - about
            // seven million of them on a capsid - to hold at most two things.
            e = eN++;
            if (eN > eCap) eGrow();
            const f0 = e * E_F;
            eF[f0] = M[oa]; eF[f0 + 1] = M[oa + 1]; eF[f0 + 2] = M[oa + 2];
            eF[f0 + 3] = M[ob]; eF[f0 + 4] = M[ob + 1]; eF[f0 + 5] = M[ob + 2];
            const i0 = e * E_I;
            eIn[i0] = 0; eIn[i0 + 1] = 0; eIn[i0 + 2] = 0;
            eIn[i0 + 3] = -1; eIn[i0 + 4] = 0;
            // FROM THE FIRST FACE TO CLAIM THE EDGE, like the colour and the
            // corners above it. An edge between two residues belongs to one of
            // them for this purpose and either reads the same where neither is
            // ghosted, which is every ordinary frame.
            eIn[i0 + E_RES] = (res === undefined) ? -1 : res;
            // ...and WHICH corners these are, from the first face to claim the
            // edge. Both faces pass the same two geometric points; either set
            // recomputes to the same place. Written only when something will
            // read them - see the note on edgeSrc.
            if (stationDraw) {
                eIn[i0 + 5] = oa; eIn[i0 + 6] = ob;
                eIn[i0 + 7] = -1; eIn[i0 + 8] = -1;
            }
            eHi[e] = other; eNext[e] = -1;
            if (gTail[g] < 0) gHead[g] = e; else eNext[gTail[g]] = e;
            gTail[g] = e;
        }
        const eb = e * E_I;
        const ef = e * E_F;
        let bits = eIn[eb + 4];
        if (!ghost) eIn[eb]++;
        if (two && !ghost) bits |= EB_TWO;
        if (noInk) bits |= EB_NOINK;      // any face may veto the whole edge
        if (isStick) bits |= EB_STICK;   // so show/hide can drop its outline too
        // `eSc` IS THE PROBE FLAG, ALREADY READ. Asking `window.__scProbe` here
        // is a global property lookup in the innermost loop of the build - once
        // per incident face per edge, about 280,000 times on a nucleosome.
        if (eSc) { if (sc) eSc[e] = 1; else eOther[e] = 1; }
        if (full && !ghost) bits |= EB_FULL;   // a fully-outlined surface
        // A SEAM CROSS EDGE IS VETOED ON THE EDGE, NOT ON THE FACE, and that is
        // the whole reason this works. The arrow's step is its own two-station
        // piece, so its far cross edge is shared with the NEXT PRIM - which
        // knows nothing about the seam and claimed the edge as real, so a
        // per-face ghost could never remove it. The edge object is looked up by
        // the hash of its two endpoints and is therefore the SAME object for
        // both prims, so a flag set here survives whoever else claims it.
        if (seam) bits |= EB_SEAM;
        if (cross) bits |= EB_CROSS; else bits |= EB_ALONG;
        if (outer && !ghost) bits |= EB_OUTER;

        // AND ITS COLOUR. The Ink control tints an outline toward its own
        // element's colour, so an edge has to know which palette slot it
        // belongs to. The first face to claim the edge lends it one.
        //
        // 🔴 AND THAT IS GEOMETRY, WHICH IS WHY A KEPT TABLE CAN DISAGREE WITH
        // A REBUILT ONE. Which face arrives first depends on which faces are
        // skipped as degenerate, and that moves with the fold. The station path
        // keeps the edge table across frames, so an edge on a colour boundary
        // keeps the slot the BUILD frame's claimant lent it while a rebuild at
        // a later frame lends another. Measured on 1YNE, fast against a rebuild
        // of the same frame: 42 outline rows differ in the slot and 16 in the
        // colour, with every other resource on the card identical, and it is
        // about thirty pixels of the picture.
        //
        // Tying the slot to the face the edge RECORDS was tried and does not
        // help: that face is chosen the same way and frozen the same way. The
        // only thing that would is rebuilding the adjacency, which is the whole
        // cost the path exists to avoid - so this is the same approximation as
        // the kept classification a few lines down, and it is recorded here
        // rather than half-fixed.
        if (eIn[eb + 3] < 0 && pal !== undefined && pal >= 0) eIn[eb + 3] = pal;
        // ...and its colour, for when there is no slot to look up
        if (!(bits & EB_COL) && col && !ghost) {
            bits |= EB_COL;
            eF[ef + 12] = col.r; eF[ef + 13] = col.g; eF[ef + 14] = col.b;
        }
        // and WHICH faces they are, for the ID test
        // COUNT EVERY incident face, keep the first two normals. The count is
        // what decides whether the silhouette rule even applies - see below.
        eIn[eb + 1]++;
        // THE SLOT IS TAKEN WHETHER OR NOT THERE IS A NORMAL TO PUT IN IT.
        // `nCount` is what decides whether an edge is a boundary - fewer than
        // two incident faces - and the object version counted a null normal as
        // an occupant. A typed array cannot hold null, so the PRESENCE is a
        // bit and the count keeps its old meaning; the emit below falls back to
        // (0,0,1) and to a2 exactly as `e.n0 || ...` did.
        const nc = eIn[eb + 2];
        if (nc === 0) {
            if (nrm) {
                eF[ef + 6] = nrm[0]; eF[ef + 7] = nrm[1]; eF[ef + 8] = nrm[2];
                bits |= EB_N0;
            }
            // ...and whose normal it is, so it can be recomputed later.
            if (stationDraw) eIn[eb + 7] = (oa / 12) | 0;
            eIn[eb + 2] = 1;
        } else if (nc === 1) {
            if (nrm) {
                eF[ef + 9] = nrm[0]; eF[ef + 10] = nrm[1]; eF[ef + 11] = nrm[2];
                bits |= EB_N1;
            }
            if (stationDraw) eIn[eb + 8] = (oa / 12) | 0;
            eIn[eb + 2] = 2;
        }
        eIn[eb + 4] = bits;
    };


    pieceRails.clear();
    mark('pieceFrames');
    for (let fi = 0; fi < faces.length; fi++) {
        const f = faces[fi];
        // the rails pass above already did this for every surf-0 rib face
        let m;
        if (hasM[fi]) {
            m = loadM(fi);
        } else if (f.q.length === 4) {
            m = cornersInto(fi, f.q);
        } else {
            // the scratch is four corners wide and `m.length` is read below, so
            // anything else keeps the allocating path rather than being
            // silently truncated to a quad
            m = f.q.map((p) => apply(inv, unproject(p, scale)));
            storeM(fi, m);
        }
        // NEWELL, not a single cross product. A mitred junction is emitted as
        // a triangle fan padded to a quad - [q0, qk, qk+1, q0] - so its fourth
        // corner repeats the first and cross(m1-m0, m3-m0) is exactly zero.
        // A zero normal makes max(0, n.L) clamp, the face falls to flat
        // ambient, and every three-way side-chain junction comes out as dark
        // triangles. Summing over all edges is immune to a repeated vertex.
        let nx = 0; let ny = 0; let nz = 0;
        for (let i2 = 0; i2 < m.length; i2++) {
            const a2 = m[i2];
            const b2 = m[(i2 + 1) % m.length];
            nx += (a2[1] - b2[1]) * (a2[2] + b2[2]);
            ny += (a2[2] - b2[2]) * (a2[0] + b2[0]);
            nz += (a2[0] - b2[0]) * (a2[1] + b2[1]);
        }
        // KEPT FOR THE EDGE PASS, which asked the same question of the same
        // four corners a second time - a four-corner Newell walk and a hypot
        // per face, purely to find out whether the quad has any area.
        const nLen = len3(nx, ny, nz);
        nLenOf[fi] = nLen;
        // 🔴 A RIB FACE'S OUTWARD NORMAL IS ITS STATION'S FRAME, so where the
        // table covers this part it is read rather than rebuilt: broad faces
        // take the face normal, the two width bands the width normal against
        // the side's sign, and `top` says which of a broad pair is outward.
        // The same rule as normalOf in refreshEdgesFromStations, which the fast
        // path has drawn the outline from on every frame.
        //
        // Caps (surf >= 4) and sticks are not stations and fall through to the
        // branches below, which need no frames either.
        if (SM && f.surf !== undefined && f.surf <= 10) {
            const k4 = SM.faceStation[fi + smOff] * 16;
            const st4 = SM.stations;
            const on = [0, 0, 0];
            if (f.surf === 4) {
                on[0] = -st4[k4 + 12]; on[1] = -st4[k4 + 13]; on[2] = -st4[k4 + 14];
            } else if (f.surf === 5) {
                on[0] = st4[k4 + 12]; on[1] = st4[k4 + 13]; on[2] = st4[k4 + 14];
            } else if (f.surf === 6) {
                const v1x = st4[k4 + 4] - st4[k4];
                const v1y = st4[k4 + 5] - st4[k4 + 1];
                const v1z = st4[k4 + 6] - st4[k4 + 2];
                const v2x = st4[k4 + 8] - st4[k4];
                const v2y = st4[k4 + 9] - st4[k4 + 1];
                const v2z = st4[k4 + 10] - st4[k4 + 2];
                const nx = v1y * v2z - v1z * v2y;
                const ny = v1z * v2x - v1x * v2z;
                const nz = v1x * v2y - v1y * v2x;
                const nl = Math.hypot(nx, ny, nz) || 1;
                on[0] = nx / nl; on[1] = ny / nl; on[2] = nz / nl;
            } else if (f.surf === 7) {
                on[0] = st4[k4 + 4]; on[1] = st4[k4 + 5]; on[2] = st4[k4 + 6];
            } else if (f.surf === 8) {
                on[0] = -st4[k4 + 8]; on[1] = -st4[k4 + 9]; on[2] = -st4[k4 + 10];
            } else if (f.surf === 9) {
                on[0] = -st4[k4 + 4]; on[1] = -st4[k4 + 5]; on[2] = -st4[k4 + 6];
            } else if (f.surf === 10) {
                on[0] = st4[k4 + 8]; on[1] = st4[k4 + 9]; on[2] = st4[k4 + 10];
            } else {
                const broad4 = f.surf < 2;
                const sgn4 = (f.surf === 2) ? -1 : 1;
                const top4 = f.top === undefined ? 1 : f.top;
                const flip4 = (broad4 && top4 < 0.5) ? -1 : 1;
                for (let a4 = 0; a4 < 3; a4 += 1) {
                    on[a4] = (broad4 ? st4[k4 + 4 + a4] : -st4[k4 + 8 + a4] * sgn4) * flip4;
                }
            }
            f._outN = on;
            f._inkN = on;
            f._emitOK = 1;
            if (typeof window !== 'undefined') {
                window.__stationNormals = (window.__stationNormals || 0) + 1;
            }
            continue;
        }
        const nl = nLen || 1;
        // OWNED BY THIS FACE until one of the frame branches below hands it a
        // shared one, which is what lets the three flips negate in place.
        let nn = [nx / nl, ny / nl, nz / nl];
        let nnOwn = true;
        // ORIENT IT LIKE ub, and for a rib face use the PIECE's mean frame -
        // the renderer's tone is one value for the whole strip.
        const pf = f.pieceId !== undefined ? pieceFrame.get(f.pieceId) : null;
        const frA = pf && pf.frames ? pf.frames[f.st] : null;
        const frB = pf && pf.frames ? pf.frames[f.st + 1] : null;
        // A SIDE IS A SURFACE TOO. Per-station frames - the whole mechanism
        // smooth shading rides on - were handed only to surf 0 and 1, so with
        // smooth ON the broad faces interpolated and the two thickness bands
        // stayed one flat tone per quad. Same defect as the 2D renderer's
        // missing `cel` branch in paintSide, running the other way: there the
        // sides refused to go flat, here they refuse to go smooth. Both are
        // one routine handling the broad faces and nobody handling the bands.
        //
        // The outward direction is +w on the L side (surf 2) and -w on the R
        // (surf 3), which is exactly the sign `paintSide` passes as `outward`.
        // The shader's side branch hardcodes isTop = 1, so what it wants is
        // the ALREADY-ORIENTED outward normal, not a normal plus a flag.
        const sideSign = f.surf === 2 ? -1 : 1;   // see the frame comment: L is at +wa = -w
        const isRibSide = !f.stick && (f.surf === 2 || f.surf === 3);
        // THE SIGN TRAVELS AS AN ARGUMENT. This was a closure declared inside
        // the loop, so it was allocated once per face in the build - and a
        // stick face never calls it, every use being guarded on `isRibSide`.
        // flat: the piece mean, matching what the reference quantises.
        // ASKED ONLY WHERE IT IS READ - `nFlat` consults it under `isRibSide`
        // - so a nucleosome's 70,362 stick faces were each building a
        // three-element array for it and dropping it unread.
        const wFlat = (!rowsUnused && isRibSide && pf && pf.wMean)
            ? [sideSign * pf.wMean[0], sideSign * pf.wMean[1], sideSign * pf.wMean[2]] : null;
        if (frA && (f.surf === 0 || f.surf === 1)) {
            nn = frA.n; nnOwn = false;
        } else if (isRibSide && wSigned(frA, sideSign)) {
            nn = wSigned(frA, sideSign); nnOwn = false;
        } else if ((f.stick || f.cap) && f.nl !== undefined) {
            // orient it so n.L reproduces the prim's own nl
            const rn = applyInto(RN, VR, nn);
            if (f.cap) {
                // for a cap the carried number is its FACING, so orient by z.
                // THE VIEW VECTOR IS THE CAP'S ALONE and was computed above the
                // branch, so every one of a nucleosome's 70,362 stick faces
                // paid for a rotation and a normalise it never read.
                const vdF = viewVecAt(apply(VR, m[0]));
                if ((dotv(rn, vdF) < 0) !== (f.nl < 0)) nn = negOf(nn, nnOwn);
            } else {
                const dot = (rn[0] * LIT_L[0] + rn[1] * LIT_L[1] + rn[2] * LIT_L[2]) / LIT_LM;
                if ((dot < 0) !== (f.nl < 0)) nn = negOf(nn, nnOwn);
            }
        } else if (f.oB !== undefined && f.oB !== 0) {
            const zAtCapture = dotv(apply(VR, nn), viewVecAt(apply(VR, m[0])));
            if ((zAtCapture < 0) !== (f.oB < 0)) nn = negOf(nn, nnOwn);
        }
        // OUTWARD normals, and it has to be outward or the test is noise. The
        // silhouette rule is "one adjacent face points at the eye and the other
        // does not", which is only meaningful if both normals point OUT of the
        // same solid. The raw winding normal does not: the strip emits its +b
        // and -b faces with the same corner order, so both their Newell normals
        // point the same way, and a rail edge would find its two faces always
        // agreeing.
        //
        // `nn` is already outward for sides, sticks and caps. For the two broad
        // faces it is the +b direction for BOTH, with `top` carrying which side
        // this one is - the same convention the shader reads - so -b is the one
        // that needs flipping.
        const topF = f.top === undefined ? 1 : f.top;
        // NOT `isRibFace` - that is declared 30 lines further down and this is
        // above it. A `const` read before its declaration is a TDZ throw, not
        // undefined, and it takes the whole render with it.
        const broadFace = !f.stick && (f.surf === 0 || f.surf === 1);
        // Edges are built in a SECOND pass (below), because two of the rules
        // need to see every face first: dropping interior face pairs, and
        // knowing a rib face's strip direction.
        f._outN = (broadFace && topF < 0.5) ? [-nn[0], -nn[1], -nn[2]] : nn;
        // SIDE-FACE NORMALS ARE ALREADY OUTWARD - measured, not assumed.
        //
        // It was argued from the winding that one of the pair must be inward:
        //   quad = [A[k], B[k], B[k+1], A[k+1]],  nn ~ (B-A) x (chain step)
        //   surf 2 = [Lp, Lm] and surf 3 = [Rp, Rm] both give -w, on opposite
        //   sides, so one of them should point at the axis.
        // Acting on that put inner lines on every loop and helix. Testing it
        // instead - each side face's centroid against its piece's centroid,
        // over a whole DNA structure - flipped ZERO of 228 side faces. The
        // derivation is wrong somewhere and the normals are fine; the ink and
        // the cull can share them.
        f._inkN = f._outN;
        // 🔴 AND THE SAME NORMAL, DERIVED BOTH WAYS, UNDER THE CHECK FLAG.
        // The station rule is what lets the pieceFrames pass be skipped
        // entirely, so it is compared against the frames it replaces rather
        // than trusted. Reached only with the flag on, which is also what stops
        // SM above from removing the reference.
        if (typeof window !== 'undefined' && window.__stationNormalCheck
            && stationCoverMesh && stationCoverMesh.faceCount === faces.length
            && f.surf !== undefined && f.surf < 4) {
            const D = (window.__stationNormalDiff = window.__stationNormalDiff
                || { faces: 0, worst: 0, at: null });
            const k9 = stationCoverMesh.faceStation[fi] * 16;
            const s9 = stationCoverMesh.stations;
            const br = f.surf < 2;
            const sg9 = (f.surf === 2) ? -1 : 1;
            const tp = f.top === undefined ? 1 : f.top;
            const fl = (br && tp < 0.5) ? -1 : 1;
            D.faces += 1;
            for (let a9 = 0; a9 < 3; a9 += 1) {
                const v9 = (br ? s9[k9 + 4 + a9] : -s9[k9 + 8 + a9] * sg9) * fl;
                const d9 = Math.abs(v9 - f._outN[a9]);
                if (d9 > D.worst) {
                    D.worst = d9;
                    D.at = `face ${fi} surf ${f.surf} station ${k9 / 16}`;
                }
            }
        }
        // (`const c = f.c` stood here, read by nothing before the emit loop
        // reads it off the face again.)
        // The strip tangent, unprojected and unrotated the same way - ASKED
        // ONLY WHERE IT IS READ. `tA` takes `frA.t` for a rib face or a rib
        // side WITH a frame, which is the same condition the first branch
        // here tests, so on all of those the normalise and its array were
        // built and dropped.
        let tt = null;
        if (!(frA && (broadFace || isRibSide))) {
            let tv;
            if (f.tan) {
                TS[0] = f.tan[0] / scale; TS[1] = -f.tan[1] / scale; TS[2] = f.tan[2];
                tv = applyInto(TV, inv, TS);
            } else {
                tv = TX;
            }
            const tl = len3(tv[0], tv[1], tv[2]) || 1;
            tt = [tv[0] / tl, tv[1] / tl, tv[2] / tl];
        }
        // PER-STATION NORMALS. A quad spans two stations - corners 0,1 are the
        // near one and 3,2 the far one - and the ribbon TWISTS between them, so
        // one normal for the whole face throws away exactly the variation the
        // smooth path draws as a gradient. The width vector at each station
        // gives its own frame; the shader then interpolates the shading across
        // the face for free, which is what the 2D renderer is approximating
        // with a two-stop gradient.
        // the frame at each END of the quad; neighbouring faces share these,
        // so the interpolation runs continuously along the whole strip
        // A/B IN ONE SESSION. Reloading between variants let a dropdown reset
        // swap the structure underneath a comparison once already: a reading of
        // 1.4% was a four-atom fixture, not the protein it was being compared
        // against. Switching the variant at runtime removes that whole class
        // of mistake.
        // A flat reference is shaded per PIECE; a smooth one per station. The
        // frame control follows that by default and can still be forced.
        const fm = P0.frame;
        // SMOOTH IS NO LONGER A BUILD-TIME DECISION. Both normals are emitted -
        // the per-station pair that a smooth face interpolates between, and the
        // single per-face one a flat face uses - and the shader picks. It reads
        // uCel, which is already "not smooth", so no new uniform is needed.
        //
        // The flat normal is not simply nA: a broad face takes its own station's
        // frame, while a width band takes the PIECE MEAN, which is what the
        // reference quantises. That difference is why this could not just be
        // dropped in the shader.
        const isRibFace = (f.surf === 0 || f.surf === 1);
        // 🔴 THE FIVE SHADING VECTORS ARE THE ROW'S AND NOTHING ELSE'S. The
        // edge pass reads `_inkN`, which is `_outN` above and is already set;
        // these are read only by the emit, so where the row is never drawn
        // they are never wanted. `nn`'s ORIENTATION still needs the frames -
        // that is what makes `_outN` outward - so the lookups above stay.
        if (!rowsUnused) {
            const nA = isRibFace ? (frA ? frA.n : nn) : (isRibSide ? (wSigned(frA, sideSign) || nn) : nn);
            const nB = isRibFace ? (frB ? frB.n : nA)
                : (isRibSide ? (wSigned(frB, sideSign) || nA) : nA);
            const nFlat = isRibFace ? ((pf && pf.nMean) || nA)
                : (isRibSide ? ((wFlat || wSigned(frA, sideSign)) || nn) : nn);
            const tA = (frA && (isRibFace || isRibSide)) ? frA.t : tt;
            const tB = (frB && (isRibFace || isRibSide)) ? frB.t : tA;
            f._nA = nA; f._nB = nB; f._nFlat = nFlat; f._tA = tA; f._tB = tB;
        }
        // THE FLAG, NOT THE ARRAY. `m` may be the shared scratch by now, so
        // holding it on the face would give every face the last face's
        // corners. The corners are in the flat store; this says they are.
        f._emitOK = 1;
    }

    // THE VERTEX WELD IS GONE. It averaged the normals of every face meeting
    // at a shared position, to hide a discontinuity that no longer exists:
    // pieces disagreed at their shared station only because the frame was
    // REBUILT from the projected rails, with a one-sided tangent over a
    // two-station piece. `_frameProbe` hands over the renderer's own frame,
    // which is continuous across pieces by construction - measured, `welded`
    // and `station` came out identical to the pixel once it was in.
    //
    // Deleting it takes the smoothing-angle threshold and the surface-class
    // keying with it, both of which existed only to stop the averaging from
    // rounding off creases it should not have been touching in the first place.

    // ITS INSTANCE INDEX IS ITS IDENTITY. The fill pass writes gl_InstanceID
    // into an ID buffer, so a face's index in the DRAW - not in this array,
    // which also holds faces that were skipped - is what the outline compares
    // against.
    mark('normals');
    for (let fi = 0; fi < faces.length; fi++) {
        const f = faces[fi];
        if (!f._emitOK) continue;
        // STRAIGHT OUT OF THE FLAT STORE, the only reader of the corners here
        // being the twelve floats copied into the instance row below.
        const mb = fi * 12;
        // 🔴 THE DEPTH RANGE AND THE CORNERS' RELEASE STILL HAPPEN. Where the
        // row is not wanted this loop is only those two things: zMin/zMax is
        // read by the draw whichever buffer the instances come from, and `f.q`
        // is the PRIM's arrays, which the face list would otherwise hold alive
        // through the two most expensive passes in the build.
        if (rowsUnused) {
            for (let qi = 0; qi < f.q.length; qi++) {
                const z = f.q[qi][2];
                if (z < zMin) zMin = z;
                if (z > zMax) zMax = z;
            }
            f.q = null;
            continue;
        }
        const c = f.c;
        const nA = f._nA; const nB = f._nB;
        const tA = f._tA; const tB = f._tB;
        // ONE INSTANCE PER FACE, 48 floats. It used to be six VERTICES of 36
        // floats each - 216 - and of those 36 only the position and the
        // normal/tangent pair differ between a face's corners at all. The other
        // 21 were written six times over.
        //
        // On 9FOG that array was 111 MB, and filling and uploading it was 420 ms
        // of a 894 ms build. Per face it is now 48 floats: the four corners, the
        // two ends' frames, and one copy of everything else. The shader picks a
        // corner off gl_VertexID, which is what the outline pass already does.
        //
        // `aBaseIn` went with it - it was bound and uploaded and never read.
        const fo = f._outN || nA;              // outward normal, for culling
        const nf = f._nFlat || nA;             // flat shading normal
        for (let i = 0; i < 4; i++) {          // the quad's corners
            const q = mb + i * 3;
            data[o++] = M[q]; data[o++] = M[q + 1]; data[o++] = M[q + 2];
        }
        data[o++] = nA[0]; data[o++] = nA[1]; data[o++] = nA[2];
        data[o++] = nB[0]; data[o++] = nB[1]; data[o++] = nB[2];
        data[o++] = tA[0]; data[o++] = tA[1]; data[o++] = tA[2];
        data[o++] = tB[0]; data[o++] = tB[1]; data[o++] = tB[2];
        data[o++] = fo[0]; data[o++] = fo[1]; data[o++] = fo[2];
        data[o++] = nf[0]; data[o++] = nf[1]; data[o++] = nf[2];
        data[o++] = f.oB || 0; data[o++] = f.oLb || 0; data[o++] = f.oT || 0;
        data[o++] = c.r; data[o++] = c.g; data[o++] = c.b;
        // flags0: k, top, iMul, stick
        data[o++] = f.kAvg || 0; data[o++] = f.top === undefined ? 1 : f.top;
        data[o++] = f.iMul === undefined ? 1 : f.iMul;
        data[o++] = f.stick ? 1 : 0;
        // flags1: side, cap, sheet, residue
        data[o++] = f.side ? 1 : 0; data[o++] = f.cap ? 1 : 0;
        data[o++] = f.sheetA ? 1 : 0; data[o++] = f.res || 0;
        // flags2: palette slot, colour mode, double-sided, coincident at the FAR station
        data[o++] = f.pal === undefined ? -1 : f.pal;
        data[o++] = f.colMode || 0;
        data[o++] = (f.two ? 1 : 0) + (f.unlit ? 2 : 0) + (f.plate ? 4 : 0)
            + (f.disc ? 8 : 0);
        data[o++] = f.sheetB ? 1 : 0;
        for (let qi = 0; qi < f.q.length; qi++) {
            const z = f.q[qi][2];
            if (z < zMin) zMin = z;
            if (z > zMax) zMax = z;
        }
        // THE LAST READ OF THE VIEW-SPACE CORNERS, so let them go. They are
        // the PRIM's own arrays - four three-element arrays a face, which the
        // face list keeps alive long after `prims.length = 0` has been called
        // on the assumption that dropping the list drops the geometry. On a
        // ribosome that is 188,738 faces still holding their prim's corners
        // through the two most expensive passes in the build.
        f.q = null;
    }
    // NO UPLOAD HERE. This function builds ONE HALF of a mesh and the halves
    // are concatenated before anything reaches the card - see makeResident.
    mark('facesAndEmit');
    // ---- EDGES, only when something is going to draw them -----------------
    // This is 91% of a build: on 9FOG the edge table costs 519 ms and turning
    // it into instances another 401 ms, against 93 ms for the fills. None of it
    // is wanted unless the outline is on, and the outline is a checkbox.
    //
    // Skipped when it is off. `edgeCount = 0` is what drawInk sees, and the
    // page rebuilds if the outline is switched on later - a build the user
    // asked for by ticking the box, rather than one paid on every structure.
    // ...and the pass runs for the strokes alone when the outline is off: a
    // contact is not an outline and switching the outline off must not delete
    // it. With neither, the whole 91% is skipped exactly as before.
    const wantEdges = !!P0.ink || contactEdges.length > 0;
    const wantOutline = !!P0.ink;
    let partEdges = 0;               // this half's outline instances
    let edUp = null;
    let edSrcUp = null;             // ...and where each of those rows came from
    window.__edgeStats = { edges: 0, faces: faces.length, skipped: !wantEdges };
    if (wantEdges) {
        // ---- EDGES, second pass ------------------------------------------------
        // INTERIOR FACES FIRST. Where two solids are butted together - consecutive
        // bond boxes of a side chain, consecutive ribbon pieces - each contributes
        // its own end cap and the two land on exactly the same four corners. Those
        // caps are inside the joined shape, and their rims are the "extra lines
        // between bonds" and the lines across a helix. The renderer solves the
        // same problem by refusing to emit them ("cap rings are dropped at any atom
        // that carries another bond"); here the faces are already built, so the
        // equivalent is to weld - a quad that appears twice is interior, and both
        // copies drop out along with every edge they would have contributed.
        // A ZERO-THICKNESS PIECE IS NOT AN INTERIOR SEAM, and the weld cannot
        // tell them apart by geometry: both are two coincident quads with
        // opposing normals. The difference is what lies between them - solid
        // for a seam, NOTHING for a flat ribbon, which is one surface with two
        // sides.
        //
        // Richardson gives a helix RICH_TH_REL.H = 0, so this is not a corner
        // case: welding them deleted both faces of every helix in the default
        // preset, the rails contributed no edges, and helices came out with no
        // outline at all while everything around them had one. What the weld
        // must skip is exactly the faces coincident along their WHOLE length -
        // both stations thin - which is what sheetA && sheetB marks. Splitting
        // the old single `sheet` flag into a per-station pair once left this
        // test reading a field that no longer existed, and every helix welded
        // itself away again: the same failure arriving from the other side.
        //
        // The key is order-independent - the sum AND the xor of the corner
        // hashes - so two quads on the same four corners agree however their
        // windings differ, which is what the weld is asking.
        // ---- THE CROSS EDGES NOTHING CAN EMIT ---------------------------
        //
        // A rib quad is [A[k], B[k], B[k+1], A[k+1]], so edges 0-1 and 2-3 run
        // ACROSS the strip. The reference never inks across a ribbon, so a rib
        // face registers them as GHOSTS - counted, never drawn - and they exist
        // solely so the flat CAP at a piece end finds a second normal there.
        //
        // 🔴 AWAY FROM A PIECE END THAT SECOND CLAIMANT IS ANOTHER GHOST, AND
        // AN EDGE WITH NO REAL FACE IS NEVER EMITTED. So the pair is a Map
        // lookup, a chain walk and a dozen writes apiece to produce nothing:
        // half of every rib face's four addEdge calls, about 30,000 of the
        // 70,000 on 1AOI. The table is 42-46% of a ribbon build
        // (tests/edge_phases.py), and this is the half of it that is provably
        // wasted.
        //
        const flatPair = (f) => !!(f.sheetA && f.sheetB);
        // STRAIGHT OUT OF THE FLAT STORE. It took `loadM(fi)`, which copies
        // twelve doubles into the scratch so that four of them can be read
        // back one at a time - once per face, on every face in the build.
        const faceKeyAt = (fi) => {
            let a = 0;
            let b = 1;
            const base = fi * 12;
            for (let k = 0; k < 4; k++) {
                const h = hashAt(base + k * 3);
                a = (a + h) >>> 0; b = (b ^ h) >>> 0;
            }
            return a * 4294967296 + b;     // sum AND xor: order-free, collision-shy
        };
        // A STEP FACE BORROWS ITS NEIGHBOUR'S NORMAL. The arrow's step quad has
        // no area, so the Newell normal computed for it above is noise - and
        // that is why its shoulders had to be forced to draw. Forcing them is
        // wrong in one visible way: it draws the pair on the UNDERSIDE as well,
        // which reads as a stray line under the arrowhead.
        //
        // The step lies in the same plane as the quad next to it on the same
        // surface of the same piece, so that quad's normal is the one it should
        // have had. With a real normal the ordinary facing test applies and each
        // side's shoulders appear only when that side is the one being looked at.
        const normDonor = new Map();
        for (const f of faces) {
            if (f.gA && f.gB) continue;               // the step itself
            if (f.pieceId === undefined || f.surf === undefined) continue;
            // A NUMBER, NOT A STRING. `pieceId` counts up from zero and
            // `surf` is one of four, so pieceId * 16 + surf is injective -
            // and it allocates nothing, where the concatenation built a
            // string for every ribbon face here and another in the walk
            // below. The cheap test goes first, too.
            if (!f._inkN) continue;
            const k2 = f.pieceId * 16 + f.surf;
            if (!normDonor.has(k2)) normDonor.set(k2, f._inkN);
        }
        for (const f of faces) {
            if (!(f.gA && f.gB)) continue;
            const d = normDonor.get(f.pieceId * 16 + f.surf);
            if (d) f._inkN = d;
        }
        // ONE PASS AND ONE LOOKUP. It was a count per key and then a second walk
        // of every face asking the map again - two `Map.get` and a `Map.set` per
        // face on a key that is always past 2^32, so every one of them boxes a
        // double. What the weld actually asks is "has anything else claimed
        // these four corners", and the first claimant's index answers it: the
        // second face to arrive marks them both.
        //
        // Four string keys, an array sort and a join, per face, is what this
        // was before that. The key only has to be order-independent, so the
        // corner hashes are added: addition commutes, which is the whole
        // requirement.
        let nCaps = 0; let nRibs = 0;
        for (const f2 of faces) {
            if (f2.surf === undefined) continue;
            if (f2.surf >= 4) nCaps += 1; else nRibs += 1;
        }
        let nInterior = 0;
        const faceSeen = new Map();
        for (let fi = 0; wantOutline && fi < faces.length; fi++) {
            const f = faces[fi];
            if (!hasM[fi] || flatPair(f)) continue;
            const k = faceKeyAt(fi);
            f._fkey = k;
            const prev = faceSeen.get(k);
            if (prev === undefined) { faceSeen.set(k, fi); continue; }
            const p = faces[prev];
            if (!p._interior) { p._interior = 1; nInterior++; }
            if (!f._interior) { f._interior = 1; nInterior++; }
        }
        // THE EDGES PHASE IS 78-81% OF A RIBBON BUILD, so it is split three
        // ways here: the interior weld, the table, and turning the table into
        // instances. Stage 2 of the edge plan cheapened the KEY and measured
        // as noise - see tests/PERF_NOTES.md - and a phase this large deserves
        // to be profiled rather than guessed at a second time.
        mark('weld');
        if (window.__scProbe) {
            // THE SAME QUESTION THE RIBBON/STICK SPLIT HAD TO ANSWER, asked of
            // the second cut: does the weld ever pair a side-chain face with
            // one of the others?
            const kinds = new Map();
            for (const f of faces) {
                if (f._fkey === undefined || !f._fkey) continue;
                let e = kinds.get(f._fkey);
                if (!e) kinds.set(f._fkey, e = {a: 0, b: 0});
                if (f.sc) e.a++; else e.b++;
            }
            let welds = 0; let mixed = 0;
            for (const e of kinds.values()) {
                if (e.a + e.b < 2) continue;
                welds++;
                if (e.a && e.b) mixed++;
            }
            const P = window.__scProbe;
            P.welds = (P.welds || 0) + welds;
            P.mixedWelds = (P.mixedWelds || 0) + mixed;
            P.scFaces = (P.scFaces || 0) + faces.filter((f) => f.sc).length;
            P.stickFaces = (P.stickFaces || 0) + faces.filter((f) => f.stick).length;
            P.faces = (P.faces || 0) + faces.length;
        }
        const ownKeys = [0, 0, 0, 0, 0, 0, 0, 0];
        for (let fi = 0; wantOutline && fi < faces.length; fi++) {
            const f = faces[fi];
            if (!hasM[fi] || f._interior) continue;
            // THE ARROW'S STEP QUAD BOUNDS NOTHING. Its two stations sit at the
            // SAME point along the chain - the renderer samples the seam twice,
            // once at shaft width and once at barb width - so all four corners
            // are collinear and the quad has zero area. Its Newell normal is
            // therefore meaningless, and "does this face turn toward the eye"
            // is a coin toss: whichever way it lands, the silhouette test can
            // read the two sides as disagreeing and draw the edge. That is the
            // line across the base of the arrowhead, and it survives the crease
            // rule being switched off entirely because it was never a crease.
            //
            // gA and gB both set means both of this quad's stations are seam
            // stations, which only the step quad satisfies.
            //
            // ONLY ITS RAILS SURVIVE, and they are the SHOULDERS - each runs
            // from a shaft corner out to a barb corner, which is the step the
            // arrow's outline has to turn through. Dropping the quad outright
            // took them with it, and the arrowhead and the shaft then closed
            // their own outlines separately: two shapes side by side instead of
            // one arrow. Its two CROSS edges are the shaft's and the barb's
            // cross-sections, which are interior to the base and must not draw.
            //
            // The rails are now TESTED, not forced: the step face borrows a
            // usable normal from its neighbour above, so the ordinary rule can
            // decide. Forcing them drew the underside pair too, which is the
            // stray line beneath the arrowhead.
            const stepQuad = !!(f.gA && f.gB);
            const mBase = fi * 12;
            // A DEGENERATE FACE BOUNDS NOTHING. At zero thickness the two width
            // faces collapse to a line: their quad is [P, P, Q, Q], so the two
            // surviving sides are BOTH the rail P-Q and one face registers the same
            // edge twice. That pushed every rail of every flat ribbon to four
            // incident faces, and the non-manifold rule then dropped it - the
            // helices lost their outline to the fix for the junction triangle
            // rather than to the weld.
            //
            // 🔴 WHICH IS A STATEMENT ABOUT THE WIDTH FACES, AND ONLY THEM. It
            // is the two SIDE faces (surf >= 2) that collapse to a line at zero
            // thickness; a BROAD face at a duplicate station - the arrow's seam,
            // the blunt end's rim - has no longitudinal length either, and a
            // perfectly good cross-section. Dropping those too meant they never
            // registered their cross edges, so the slab on the other side of the
            // boundary had one incident face, counted as a boundary, and drew a
            // line unconditionally. That is the line left across a sheet whose
            // gap has closed: with the face present the cross edges weld,
            // nCount is 2, and the ordinary crease test reads the two parallel
            // normals and says nothing. See tests/sheet_merge.py.
            if ((f.surf === undefined || f.surf >= 2) && nLenOf[fi] < 1e-6) continue;   // zero area, measured above
            // ...and belt and braces: one face may not count one edge twice.
            // FOUR SLOTS, NOT A SET. A quad registers at most four edges, and
            // one Set per face is one allocation per face - a couple of million
            // on a capsid - to hold at most four numbers.
            let ownN = 0;
            // A RIB FACE INKS ALONG THE STRIP ONLY. The reference does not run a
            // face-normal test over a slab at all - it inks the four CORNER CURVES
            // (the rails) and picks, per segment, the two that are extreme
            // perpendicular to the chain's screen direction. What matters for us is
            // the consequence: its ink never runs ACROSS the ribbon, so a strip can
            // not grow an inner line however the surface turns. A quad here is
            // [A[k], B[k], B[k+1], A[k+1]], so edges 0-1 and 2-3 are the cross-strip
            // pair and 1-2 and 3-0 are the rails. Emitting the cross pair drew a
            // line across the helix everywhere its face rolled through edge-on -
            // a true silhouette of the surface, and not a line the reference has.
            // A RUNG IS A STRIP LIKE ANY OTHER, and the reference treats it as
            // one. It used to be exempted here so its ends would ink and a base
            // pair would read as a box rather than as two loose lines - a
            // deliberate deviation, and the source of both differences against
            // the 2D pass: an end line it does not draw, and an asymmetry in
            // which of them survived.
            //
            // cartoon/geom.js inks a rung through emitSlabInk with the LOOP
            // rule (`outerOnly` true - "THE LOOP RULE, so the rung carries no
            // INNER line"), and emitSlabInk only ever emits the four corner
            // rails. So a base plate there is two silhouette lines, no box and
            // no crease. Matching that is what parity means.
            const alongOnly = !f.stick && f.surf !== undefined && f.surf < 4 && !f.fullOutline;
            // TEN OF ADDEDGE'S FIFTEEN ARGUMENTS ARE THE FACE'S, not the
            // edge's, and they were read and coerced inside the loop - so
            // every one of them was fetched four times per face, about 1.6
            // million redundant property loads on a nucleosome.
            const fInkN = f._inkN; const fStick = !!f.stick; const fPal = f.pal;
            const fTwo = !!f.two; const fNoInk = !!f.noInk; const fCol = f.c || null;
            const fFull = !!f.fullOutline; const fOuter = !!f.outerOnly;
            const fSc = !!f.sc;
            // FOUR CORNER HASHES, NOT EIGHT. Edge i2 runs from corner i2 to
            // corner i2+1, so every corner was hashed twice per face - 700,000
            // calls on a nucleosome where 350,000 answer the same questions.
            const h0 = hashAt(mBase); const h1 = hashAt(mBase + 3);
            const h2 = hashAt(mBase + 6); const h3 = hashAt(mBase + 9);
            for (let i2 = 0; i2 < 4; i2++) {
                // the cross-strip pair is registered as a GHOST rather than
                // skipped: it must not ink, but the cap that shares it needs a
                // second normal to be testable at all
                // The cross pair is edges 0-1 (station k) and 2-3 (station
                // k+1); a fully-outlined surface keeps them except at the seam.
                if (stepQuad && (i2 === 0 || i2 === 2)) continue;   // its cross-sections
                const seamCross = (i2 === 0 && f.gA) || (i2 === 2 && f.gB);
                const ghost = alongOnly && (i2 === 0 || i2 === 2);
                // ...and the ones nothing can emit are not registered at all
                const oa = mBase + i2 * 3;
                const ob = mBase + ((i2 + 1) & 3) * 3;
                const ka = i2 === 0 ? h0 : i2 === 1 ? h1 : i2 === 2 ? h2 : h3;
                const kb = i2 === 0 ? h1 : i2 === 1 ? h2 : i2 === 2 ? h3 : h0;
                const ek = ka < kb ? ka * 4294967296 + kb : kb * 4294967296 + ka;
                let dup = false;
                for (let k2 = 0; k2 < ownN; k2++) if (ownKeys[k2] === ek) { dup = true; break; }
                if (dup) continue;
                if (ownN < ownKeys.length) ownKeys[ownN++] = ek;
                // THE COLOUR TRAVELS AS THE FACE'S OWN OBJECT. Only the first
                // face to claim an edge ever reads it, so packing it into a
                // fresh three-element array at every call built about 280,000
                // arrays a build to use a few thousand of them.
                // ...and whether this is the strip's CROSS pair, which is
                // the pair a Richardson strand draws and a loop does not. Only
                // in the Richardson preset: everywhere else a cross edge is
                // never drawn by anything and reviving its row would be rows
                // nobody looks at.
                const crossEdge = !f.stick && P0.rich && (i2 === 0 || i2 === 2)
                    && f.surf !== undefined && f.surf < 4;
                addEdge(oa, ob, ka, kb, fInkN, fStick, fPal, ghost,
                    fTwo, fNoInk, fCol, fFull, seamCross, fOuter, fSc, crossEdge,
                    f.res || 0);
            }
        }

        mark('table');
        // ---- the edge instance buffer: p0, p1, n0, n1, always = 13 floats ----
        if (window.__scProbe) {
            let both = 0;
            for (const k of Object.keys(eSc)) if (eOther[k]) both++;
            const P = window.__scProbe;
            P.edgesBothKinds = (P.edgesBothKinds || 0) + both;
            P.edges = (P.edges || 0) + eN;
        }
        const creaseDeg = P0.creaseDeg;
        const creaseCos = Math.cos(creaseDeg * Math.PI / 180);
        // the fully-outlined surfaces' own threshold
        const richDeg = RICH_CREASE_DEG;
        const richCos = RICH_CREASE_COS;
        // WHICH PRESET THIS MESH WAS BUILT UNDER. The rich crease rule applies
        // to a strand and only in the Richardson preset; the preset cannot
        // change without a rebuild, the letter can, so this is baked and the
        // letter is not.
        edgeRichPreset = !!P0.rich;
        const edgeTotal = eN;
        const edgeFlipFirst = !!window.__edgeFlipFirst;
        const ed = new Float32Array((edgeTotal + contactEdges.length * 2) * ED_FLOATS);
        // ...and its provenance, four integers a row. Only the surface edges
        // have one: a contact is an annotation with its own endpoints and no
        // station behind it, so those rows are left at -1 and the refresh skips
        // them rather than inventing a source.
        // Six a row: the two endpoint corners, the two faces whose normals it
        // holds, how many faces are incident (which decides boundary against
        // crease), and the crease cosine this edge was judged by, in millionths,
        // or -1 where the rule is off. Enough to redo the classification as
        // well as the geometry.
        // 🔴 ONLY WHEN THE STATION PATH IS ON. Six integer writes an edge and an
        // Int32Array the size of the edge table, on every rebuild - and a still
        // structure, which never steps and so never arms the table, would pay
        // all of it for nothing. Measured at 3-5% of a rebuild step, which is
        // exactly the tax a feature has no business levying on people not
        // using it.
        //
        // 🔴 AND THE GATE IS stationDraw. This once named a button instead,
        // which was the wrong switch: the table is
        // the machinery and the pin is a separate promise about the data - see
        // wantStationTable in parts/ui.js, which turns exactly one of the two
        // on. The table arms itself on any trajectory, pinned or not.
        // SEVEN a row now, not six: the last is whether the letter decides
        // this edge - see the note where it is written.
        const edgeSrc = stationDraw
            ? new Int32Array((edgeTotal + contactEdges.length * 2) * ED_SRC).fill(-1)
            : null;
        let so = 0;
        let eo = 0;
        let nBoundary = 0;
        let nCrease = 0;
        let nNonManifold = 0;
        let nGhostOnly = 0;
        // THE MAP'S OWN ORDER, still: it yields edges grouped by their first
        // endpoint, the ink pass draws with the depth mask off so a later
        // stroke paints over an earlier one, and emitting them in index order
        // instead would be a picture change hiding inside a memory change.
        const eA = [0, 0, 0]; const eB = [0, 0, 0];
        for (let g = 0; g < gN; g++) for (let e = gHead[g]; e >= 0; e = eNext[e]) {
            const eb = e * E_I;
            const ef = e * E_F;
            const bits = eIn[eb + 4];
            // no face is allowed to ink here - a mid-strip cross edge, or the
            // ring around a side chain's base, which is vetoed outright
            // 🔴 A CROSS EDGE GETS A ROW EITHER WAY, and which frames draw it
            // is decided per frame. It is the one edge whose existence follows
            // the letter - a Richardson strand draws its creases, a loop does
            // not - and an edge SET that follows the letter is a rebuild every
            // time a strand appears. On a beta protein that is most steps of a
            // trajectory: 4 of 5 on _traj_3ptb.pdb, 9.00 ms a step against
            // 6.30 on the fast path.
            //
            // The rows cost what an extra instance costs and no more: a row
            // that must not draw carries `always` -1 and the vertex shader
            // clips it before it makes a fragment. Measured as an upper bound
            // by drawing them all - 6.90 ms against 6.30 - against the 2.7 ms
            // a rebuild costs on the same trajectory.
            const byLetter = (bits & EB_CROSS) && !(bits & EB_ALONG);
            const revive = !eIn[eb] && byLetter && stationDraw
                && !(bits & EB_NOINK) && !(bits & EB_SEAM) && eIn[eb + 5] >= 0;
            if (!revive && (!eIn[eb] || (bits & EB_NOINK) || (bits & EB_SEAM))) {
                nGhostOnly++; continue;
            }

            if (bits & EB_N0) {
                eA[0] = eF[ef + 6]; eA[1] = eF[ef + 7]; eA[2] = eF[ef + 8];
            } else { eA[0] = 0; eA[1] = 0; eA[2] = 1; }
            if (bits & EB_N1) {
                eB[0] = eF[ef + 9]; eB[1] = eF[ef + 10]; eB[2] = eF[ef + 11];
            } else { eB[0] = eA[0]; eB[1] = eA[1]; eB[2] = eA[2]; }
            const a2 = eA; const b2 = eB;
            // NON-MANIFOLD EDGES ARE JUNCTION INTERIOR, and the silhouette rule is
            // not merely wrong there, it is undefined: "exactly one of the TWO
            // faces meeting along it faces the eye" needs there to be two. Where
            // three side-chain bonds meet, 9 of 33 edges of the fixture have three
            // or four incident faces, and keeping an arbitrary pair of them ran the
            // test on a pair that bounds nothing - which drew a closed triangle
            // around every three-way junction that the reference does not have.
            //
            // Geometrically the count IS the answer: material fills all the way
            // around such an edge, so it cannot lie on the outline. Two faces means
            // a real surface edge, one means an open boundary, three or more means
            // inside the join. The reference reaches the same place from the other
            // side, by testing each edge against the hull of its own box's
            // projected corners and rejecting any that lands inside.
            if (eIn[eb + 1] > 2) { nNonManifold++; continue; }
            // A FLAT STICK'S SHARED EDGE IS A STATION, NOT AN OUTLINE.
            //
            // Ribbon mode asks for zero thickness, so a side-chain bond is a
            // single double-sided quad and consecutive pieces of one run share
            // their cross edge. The 2D pass never inks that edge, and the rule
            // it uses says why in one line: a stick's end edges are stroked only
            // at a FREE end (`if (e.end === 0 && !prim.free0) continue`), and an
            // edge two pieces share is by definition not one.
            //
            // Here the same edge arrives with two real faces, so it fell through
            // to the crease test below - and wherever the run bends or twists,
            // which is most side chains with a branch or a ring, the two quads
            // are not coplanar, the test fires, and the edge is promoted to
            // "always draw". That is the line ACROSS the middle of a side chain.
            // Coplanar runs got away with it, which is why only some residues
            // showed it.
            //
            // The silhouette rule is no better here: both faces are oriented at
            // the eye per frame, so the captured normals' signs are arbitrary
            // and `f0 != f1` is a coin toss. There is nothing to test, because
            // the edge is interior - two pieces of one solid meeting flush.
            if ((bits & EB_STICK) && (bits & EB_TWO) && eIn[eb] > 1) { continue; }
            let always = 0;
            // A BOUNDARY EDGE OF A DOUBLE-SIDED FACE IS ALWAYS DRAWN, and that
            // is not a special case but the same eye-orient rule followed one
            // step further: the face is turned toward the eye every frame, so
            // "draw this edge while its face faces the eye" is a tautology.
            // Left as an ordinary boundary it tested the normal the CAPTURE
            // baked, and every flat side chain kept its fill but lost its
            // outline the moment the model turned past that view.
            if (eIn[eb + 2] < 2) { always = (bits & EB_TWO) ? 5 : 2; nBoundary++; }
            // ...and the harness's second falsification: ONE float of ONE row.
            // The quantum above moves every endpoint and changes the edge SET;
            // this changes a single classification and leaves the set alone,
            // which is what proves the diff is element by element rather than
            // a length or a count comparison. Off in every build but the
            // probe's - see tests/station_edges.py.
            if (edgeFlipFirst && eo === 0) always = always === 2 ? 5 : 2;
            else {
                // |dot| because the two winding normals of a closed pair point
                // opposite ways by construction; the ANGLE between the surfaces is
                // what a crease is, and it is the same either way round.
                const d2 = Math.abs(a2[0] * b2[0] + a2[1] * b2[1] + a2[2] * b2[2]);
                // THE CREASE RULE IS OFF EVERYWHERE EXCEPT A FULLY-OUTLINED
                // SURFACE. Globally it has to be: on a smooth ribbon a crease
                // threshold inks a line wherever the surface bends, which is a
                // line the reference does not draw, so this renderer keeps to
                // the silhouette and nothing else.
                //
                // A richardson strand is the exception, and it is why its
                // "inner" outline was missing. The slab shows a coloured broad
                // face and a pale side face at the same time, and the edge
                // between them is a 90 degree CREASE - both faces turned toward
                // the eye, so the silhouette test says nothing and the two
                // colours met with no line. 60 degrees catches that corner and
                // still ignores the few degrees a ribbon bends between
                // stations.
                const cDeg = (bits & EB_FULL) ? richDeg : creaseDeg;
                const cCos = (bits & EB_FULL) ? richCos : creaseCos;
                if (cDeg < 180 && d2 < cCos) { always = 2; nCrease++; }
            }
            // WHERE THIS INSTANCE CAME FROM, in the same order it is written.
            // Four integers a row: the two endpoint corners, and the two faces
            // whose normals it carries. Enough to rebuild the twelve floats
            // above from a station table without running the hash again.
            // 🔴 AND A REVIVED CROSS EDGE IS OFF UNTIL A FRAME SAYS OTHERWISE.
            // No face inked it at build, so whatever the crease rule just said
            // about it is an answer to a question nobody asked: -1 is the row
            // saying "not this frame", and the vertex shader clips it.
            if (revive) always = -1;
            if (edgeSrc) {
                edgeSrc[so++] = eIn[eb + 5]; edgeSrc[so++] = eIn[eb + 6];
                edgeSrc[so++] = eIn[eb + 7]; edgeSrc[so++] = eIn[eb + 8];
                edgeSrc[so++] = eIn[eb + 2];
                // ...and the crease threshold this edge is judged by, WITHOUT
                // the letter in it.
                //
                // 🔴 THIS USED TO BAKE `(bits & EB_FULL) || byLetter`, and
                // EB_FULL is `rich && ss === 'E'` - a LETTER, decided at build
                // and then frozen. So a residue that was a strand kept the rich
                // 60-degree crease rule for the life of the mesh: it went on
                // drawing a strand's creases after it stopped being a strand,
                // while a fresh build turned the rule off and drew nothing.
                // That is 80 of the 107 outline rows a stepped frame of
                // _traj_3ptb.pdb draws that a rebuild of it does not - the
                // biggest single source of the lines left on a merged sheet.
                //
                // The PLAIN threshold is the look's and does not move; the rich
                // one is a constant. So only the plain one is recorded, and
                // refreshEdgesFromStations picks between them from the letter
                // THIS frame.
                edgeSrc[so++] = creaseDeg < 180 ? Math.round(creaseCos * 1e6) : -1;
                // ...and whether the letter decides it at all. 1 = a strip's
                // cross edge, drawn while its piece is a Richardson strand and
                // clipped otherwise; 0 = an edge whose existence is geometry.
                edgeSrc[so++] = byLetter ? 1 : 0;
            }
            ed[eo++] = eF[ef]; ed[eo++] = eF[ef + 1]; ed[eo++] = eF[ef + 2];
            ed[eo++] = eF[ef + 3]; ed[eo++] = eF[ef + 4]; ed[eo++] = eF[ef + 5];
            ed[eo++] = a2[0]; ed[eo++] = a2[1]; ed[eo++] = a2[2];
            ed[eo++] = b2[0]; ed[eo++] = b2[1]; ed[eo++] = b2[2];
            ed[eo++] = always;
            // bit 1 = stick, bit 2 = use the extreme-corner rule
            ed[eo++] = ((bits & EB_STICK) ? 1 : 0) + ((bits & EB_OUTER) ? 2 : 0);
            ed[eo++] = eIn[eb + 3];
            const hasCol = (bits & EB_COL) !== 0;
            ed[eo++] = hasCol ? eF[ef + 12] : 0;
            ed[eo++] = hasCol ? eF[ef + 13] : 0;
            ed[eo++] = hasCol ? eF[ef + 14] : 0;
            ed[eo++] = 0;              // 0 = take uWidth, the outline's own weight
            ed[eo++] = eIn[eb + E_RES];     // ...and whose residue it outlines
        }
        // ---- CONTACTS ride through the same pass ---------------------------
        // A contact is a flat bright stroke, not a surface: it is drawn from
        // both sides, at its own width, in its own colour, and it is the one
        // thing here that is annotation rather than structure. All of which is
        // an ink instance with aAlways = 3, so it needs no second program - and
        // it gets the depth test and the slope bias for free, which is what
        // makes it pass behind the ribbon where it should.
        // BORDER FIRST, CORE OVER IT. The ink pass writes colour with the
        // depth mask off, so within one draw call the later instance simply
        // paints over the earlier one - which is the same order the 2D pass
        // strokes them in, and the reason neither needs a depth offset.
        const putContact = (c, always, col, w) => {
            ed[eo++] = c.p0[0]; ed[eo++] = c.p0[1]; ed[eo++] = c.p0[2];
            ed[eo++] = c.p1[0]; ed[eo++] = c.p1[1]; ed[eo++] = c.p1[2];
            ed[eo++] = 0; ed[eo++] = 0; ed[eo++] = 1;      // normals: unused
            ed[eo++] = 0; ed[eo++] = 0; ed[eo++] = 1;
            ed[eo++] = always; ed[eo++] = 0; ed[eo++] = -1;   // not a stick, no slot
            ed[eo++] = col[0]; ed[eo++] = col[1]; ed[eo++] = col[2];
            ed[eo++] = w;
            // A CONTACT IS ANNOTATION LAID ACROSS THE CHAIN and is not ghosted
            // with either end: -1 is the row saying "no residue", which the
            // shader reads as full coverage.
            ed[eo++] = -1;
        };
        if (wantOutline) for (const c of contactEdges) putContact(c, 4, c.c, c.wA);
        for (const c of contactEdges) putContact(c, 3, c.c, c.wA);
        // `continue` above leaves the tail of `ed` unwritten, so the instance count
        // is what was actually filled, not the map size
        partEdges = eo / ED_FLOATS;
        // A CONTACT IS NOT AN OUTLINE. It rides through the ink pass because it
        // is a stroke with a depth test, but it is annotation - it has to be
        // drawn whether or not the drawing has outlines. The build already knew
        // that (wantEdges above); the DRAW was gated on the outline alone, so
        // the 3d preset, whose outline width is 0, showed no contacts at all
        // on this path while the 2D pass drew them.
        hasContacts = contactEdges.length > 0;
        edUp = ed.subarray(0, eo);
        edSrcUp = edgeSrc ? edgeSrc.subarray(0, so) : null;
        window.__edgeStats = { edges: partEdges, boundary: nBoundary, crease: nCrease,
            faces: faces.length, interiorDropped: nInterior, nonManifoldDropped: nNonManifold,
            ghostOnly: nGhostOnly,
            // ...and what the TABLE held to produce them, which is where a
            // ribbon build's time actually goes. Free to keep: every one of
            // these is a counter the pass already maintained.
            tableEdges: edgeTotal, groups: gN, caps: nCaps, ribs: nRibs };
    }
    mark('edges');
    // OUTSIDE THE GUARD. The depth range and the diagnostic face list are not
    // the outline's business, and leaving them inside it meant a build with the
    // outline off produced no radius at all - `rad is not defined`, and nothing
    // rendered. Cheap mistake to make when a guard is wrapped around a span
    // rather than around a function.
    //
    // REUSE THE CORNERS ALREADY UNPROJECTED, rather than unprojecting every one
    // a second time just to find the model radius.
    let rad = 0;
    for (let fi = 0; fi < faces.length; fi++) {
        if (!hasM[fi]) continue;
        const b = fi * 12;
        for (let k = 0; k < 4; k++) {
            const o = b + k * 3;
            const d = M[o] * M[o] + M[o + 1] * M[o + 1] + M[o + 2] * M[o + 2];
            if (d > rad) rad = d;          // compare squared, root once
        }
    }
    rad = Math.sqrt(rad);
    // DIAGNOSTICS ONLY, AND OFF BY DEFAULT. This held the entire face array -
    // every face's model-space corners, outward normal and interior flag - on
    // a global for the lifetime of the page, which is a rebuild's whole
    // geometry pinned after it has been uploaded and is no longer needed.
    // Nothing read it. Set window.__gpuDiag before a rebuild to get it back.
    if (window.__gpuDiag) window.__faces = faces;
    mark('buffers');
    // MODEL-SPACE FACE CENTROIDS, for the shading range above. Kept as a flat
    // Float32Array rather than an array of triples: the per-frame loop over it
    // is the only thing in the draw path that is O(faces).
    const cen = new Float32Array(faces.length * 3);
    let ci2 = 0;
    for (let fi = 0; fi < faces.length; fi++) {
        if (!hasM[fi]) { ci2 += 3; continue; }
        const b = fi * 12;
        let ax = 0; let ay = 0; let az = 0;
        for (let k = 0; k < 4; k++) {
            const o = b + k * 3;
            ax += M[o]; ay += M[o + 1]; az += M[o + 2];
        }
        cen[ci2++] = ax * 0.25; cen[ci2++] = ay * 0.25; cen[ci2++] = az * 0.25;
    }
    // the last stage needs an end as much as the others need a start
    mark('end');
    return { count: faces.length, rad, scale, centroids: cen,
        fill: data, edges: edUp, edgeSrc: edSrcUp, edgeCount: partEdges, hasContacts,
        bytes: data.byteLength + (edUp ? edUp.byteLength : 0) };
}

/**
 * TWO HALVES, AND ONLY ONE OF THEM IS EVER REBUILT FOR A SIDE CHAIN.
 *
 * Showing a few side chains APPENDS positions, so every term of the mesh
 * signature moves and the whole cartoon was rebuilt - 8,514 ribbon faces
 * recomputed to draw 182 new stick ones. What made that avoidable is three
 * measurements, all on 4HHB with 400 side chains out:
 *
 *   * the ribbon half does not change. Hashed over its faces' corners and
 *     colours it is byte-identical with the side chains on, off, and on again;
 *   * the weld that removes doubled lines never pairs a stick face with a
 *     ribbon one - 1,295 welds, none mixed;
 *   * and neither does the edge map - 30,119 edges, none claimed by both.
 *
 * So the two halves can be built separately and concatenated. What that COSTS
 * is the draw order: the halves arrive ribbon-then-stick rather than
 * interleaved by depth, and where a stick surface and the ribbon it grows out
 * of land on exactly the same depth, `depthFunc(LESS)` gives the pixel to
 * whichever was drawn first. That moves 260 pixels of 357,604, all of them on
 * seams, none on open ribbon - and the winner at a tie was already arbitrary,
 * being whichever face the depth sort happened to put first.
 *
 * The ribbon half is cached against a HASH OF ITS OWN FACES rather than
 * against the signature. A key assembled from renderer state is a list of
 * terms someone has to keep complete, and this file's history is largely the
 * story of a term going missing; a hash of the thing itself cannot forget one.
 * It costs about a millisecond and it fails safe - a miss rebuilds.
 */
let ribbonPart = null;           // { hash, part }
let otherPart = null;            // ...and the ligands, plates and contacts
/**
 * ...AND IT HAS TO BE CHEAP, or it eats what it saves. The first version
 * mixed every corner of every face through a closure with three multiplies
 * per number and cost 10 ms - as much as the build it was there to skip.
 *
 * This one samples: two of a quad's four corners, its colour's red channel
 * and its residue. Every face is still looked at, so a change anywhere in the
 * ribbon is still seen - what is given up is the ability to tell apart two
 * ribbons that agree on 8,514 faces' sampled fields and differ elsewhere,
 * which is not a thing geometry does. 0.6 ms against 10.
 */
function ribbonHashOf(faces, scale, prm) {
    let h = 2166136261 >>> 0;
    const mix = (v) => {
        const q = Math.round(v * 1000) | 0;
        h ^= q & 255; h = Math.imul(h, 16777619) >>> 0;
        h ^= (q >>> 8) & 255; h = Math.imul(h, 16777619) >>> 0;
        h ^= (q >>> 16) & 255; h = Math.imul(h, 16777619) >>> 0;
    };
    mix(faces.length);
    // Only parameters that actually affect mesh geometry in buildMeshPart.
    // Draw uniforms like inkWidth, shadeAmt, hiGain, etc. must not invalidate the ribbon mesh cache!
    if (prm) {
        if (typeof prm.ortho === 'number') mix(prm.ortho);
        mix(prm.rich ? 1 : 0);
        mix(prm.ink ? 1 : 0);
        if (typeof prm.creaseDeg === 'number') mix(prm.creaseDeg);
        if (prm.frame === 'welded') mix(1); else mix(2);
    }
    const VR = currentRot();
    const inv = matT(VR);
    const dMx = currentCapCentre[0] - currentModelCenter[0];
    const dMy = currentCapCentre[1] - currentModelCenter[1];
    const dMz = currentCapCentre[2] - currentModelCenter[2];
    const fl = focalLength();
    const persp = isPersp();
    const w2 = capW / 2;
    const h2 = capH / 2;
    // ...the inner loop, written out: no closure call, one multiply a number.
    for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        const q = f.q;
        const p0 = q[0];
        const p2 = q[2] || p0;

        const z0 = p0[2];
        const pe0 = persp ? fl / Math.max(0.1, fl - z0) : 1;
        const k0 = scale * pe0;
        const x0 = (p0[0] - w2) / k0;
        const y0 = (h2 - p0[1]) / k0;
        const m0x = inv[0][0] * x0 + inv[0][1] * y0 + inv[0][2] * z0 + dMx;
        const m0y = inv[1][0] * x0 + inv[1][1] * y0 + inv[1][2] * z0 + dMy;
        const m0z = inv[2][0] * x0 + inv[2][1] * y0 + inv[2][2] * z0 + dMz;

        const z2 = p2[2];
        const pe2 = persp ? fl / Math.max(0.1, fl - z2) : 1;
        const k2 = scale * pe2;
        const x2 = (p2[0] - w2) / k2;
        const y2 = (h2 - p2[1]) / k2;
        const m2x = inv[0][0] * x2 + inv[0][1] * y2 + inv[0][2] * z2 + dMx;
        const m2y = inv[1][0] * x2 + inv[1][1] * y2 + inv[1][2] * z2 + dMy;

        h = (Math.imul(h, 31) + ((m0x * 64) | 0)) | 0;
        h = (Math.imul(h, 31) + ((m0y * 64) | 0)) | 0;
        h = (Math.imul(h, 31) + ((m0z * 64) | 0)) | 0;
        h = (Math.imul(h, 31) + ((m2x * 64) | 0)) | 0;
        h = (Math.imul(h, 31) + ((m2y * 64) | 0)) | 0;
        h = (Math.imul(h, 31) + (f.c ? (f.c.r | 0) : 0)) | 0;
        h = (Math.imul(h, 31) + ((f.res || 0) | 0)) | 0;
        h = (Math.imul(h, 31) + (f.two ? 1 : 0)) | 0;
    }
    return h >>> 0;
}

/**
 * THE MESH AS STATIONS AND INDICES, which is what the card would be handed.
 *
 * Two arrays instead of one:
 *
 *   stations  four RGBA texels each - (mid, halfW), (ub, halfT), (wa, -), (tv, -)
 *             in MODEL space. This is the only part that moves when a
 *             trajectory does, and it is what a frame would upload.
 *   faces     two floats each - the near station's GLOBAL index, and which of
 *             the four surfaces. Topology: it does not change while the fold
 *             does not - which is what a trajectory of one molecule is.
 *
 * 🔴 THE ORDER IS facesOf's ORDER, EXACTLY, and it has to be: the flags, the
 * colour and the palette slot stay in the instance row facesOf already builds,
 * so row i of that array and row i of this one must describe the same face. The
 * caps are emitted first for the same reason - facesOf pushes them before the
 * quad loop.
 *
 * 🔴 AND A PRIM WITHOUT A FRAME IS SKIPPED, NOT GUESSED. `ub`, `wa`, `tv` and
 * `half` arrive only when the renderer sets _frameProbe, and `mid` only with
 * _traceProbe. Without them a station cannot be described at all, so this
 * returns null rather than a table with holes in it - a hole would draw as a
 * face collapsed onto the origin, which is a spike through the middle of the
 * structure and reads as a geometry bug rather than a missing input.
 */
function stationMeshOf(prims, trace, rot, centre, rich, liveCentre) {
    // 🔴 WRITTEN INTO TYPED ARRAYS THAT SURVIVE THE FRAME, not pushed into JS
    // ones and copied. A 5,000-residue chain has 34,555 stations, so the plain
    // version pushed 553,000 numbers a frame, then allocated a Float32Array and
    // copied all of them - 12.4% of a step in stationMeshOf and a good part of
    // the 8.2% the garbage collector took beside it. The shape does not change
    // while the topology holds, which is the condition the whole path already
    // requires, so the buffers are grown once and reused.
    const scratch = stationScratch;
    let so = 0; let fo = 0; let po = 0;
    let missing = 0;
    // 🔴 AND WHY, NOT JUST HOW MANY. A prim without a station is a prim whose
    // faces land in the tail, and a tail inside the ribbon part declines the
    // fast path for the WHOLE structure - so "9 missing" is the start of a
    // question and these three counters are the answer to it. Static 1EHZ was
    // diagnosed with exactly this.
    const why = { noFrame: 0, noCentre: 0, badStation: 0 };
    const room = (need) => {
        if (scratch.stations.length < need) {
            const grown = new Float32Array(Math.max(need, scratch.stations.length * 2));
            grown.set(scratch.stations);
            scratch.stations = grown;
        }
    };
    const faceRoom = (need) => {
        if (scratch.faceStation.length < need) {
            const n2 = Math.max(need, scratch.faceStation.length * 2);
            for (const k of ['faceStation', 'faceSurf', 'facePiece']) {
                const grown = new Float32Array(n2);
                grown.set(scratch[k]);
                scratch[k] = grown;
            }
        }
    };
    const pieceRoom = (need) => {
        if (scratch.pieces.length < need) {
            const grown = new Float32Array(Math.max(need, scratch.pieces.length * 2));
            grown.set(scratch.pieces);
            scratch.pieces = grown;
        }
    };
    // 🔴 THE CAPTURE IS IN ROTATED SPACE AND THE MESH IS NOT. geom.js says so
    // where it builds the frame probe - "ROTATED space, like everything else
    // here; the consumer un-rotates" - and buildMeshPart duly un-rotates every
    // frame it reads. A station table that skipped that would bake the view the
    // capture happened at into the geometry: right until the model turns, and
    // then wrong in a way that reads as the lighting coming unstuck rather than
    // as a bad table. The rotation is orthonormal, so its inverse is its
    // transpose.
    // 🔴 THE TRANSPOSE, AND IT IS READ COLUMN-WISE. mol.js's _storeRibbonTrace
    // un-rotates the centre line with m[0][0]*p[0] + m[1][0]*p[1] + ... - the
    // COLUMNS - and the frames have to travel the same way or the table holds a
    // centre line in one space and a frame in another. Written row-wise first,
    // which is the rotation applied FORWARD: every face came out 0.9-3.3 A
    // adrift, evenly across all four surfaces and unfixable by any per-axis
    // scale, which is what a residual rotation looks like and what told us it
    // was one.
    // 🔴 AND THE VIEW CENTRE COMES BACK OFF. _storeRibbonTrace ADDS it when it
    // un-rotates - the trace is for the selection halo, which wants world
    // coordinates - while the mesh buildMeshPart uploads does not carry it. A
    // table built without this is the right geometry about the wrong origin,
    // 30 A out on this structure, and it is a CONSTANT, so it survives every
    // check that looks at shape and none that looks at position.
    const C = centre || { x: 0, y: 0, z: 0 };
    const Cx = C.x !== undefined ? C.x : (C[0] !== undefined ? C[0] : 0);
    const Cy = C.y !== undefined ? C.y : (C[1] !== undefined ? C[1] : 0);
    const Cz = C.z !== undefined ? C.z : (C[2] !== undefined ? C[2] : 0);
    const LC = liveCentre || C;
    const Lx = LC.x !== undefined ? LC.x : (LC[0] !== undefined ? LC[0] : Cx);
    const Ly = LC.y !== undefined ? LC.y : (LC[1] !== undefined ? LC[1] : Cy);
    const Lz = LC.z !== undefined ? LC.z : (LC[2] !== undefined ? LC[2] : Cz);
    const dCx = Lx - Cx;
    const dCy = Ly - Cy;
    const dCz = Lz - Cz;
    const R = rot || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const un = (v) => [
        R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
        R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
        R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
    ];
    let lastSegId = -1;
    let segBaseStation = 0;
    let segPieceId = 0;
    for (const p of prims) {
        if (!p) continue;
        if (p.kind === 'stickFace' && p.stA && p.stB) {
            if (p.segId !== lastSegId) {
                lastSegId = p.segId;
                segBaseStation = so / 16;
                segPieceId = po / 8;
                room(so + 32);
                pieceRoom(po + 8);
                const S = scratch.stations;
                const PP = scratch.pieces;
                const mA = un(p.stA.mid);
                const uA = un(p.stA.ub);
                const wA = un(p.stA.wa);
                const tA = un(p.stA.tv);
                S[so] = mA[0] + dCx; S[so + 1] = mA[1] + dCy; S[so + 2] = mA[2] + dCz;
                S[so + 3] = p.stA.hw;
                S[so + 4] = uA[0]; S[so + 5] = uA[1]; S[so + 6] = uA[2];
                S[so + 7] = p.stA.ht;
                S[so + 8] = wA[0]; S[so + 9] = wA[1]; S[so + 10] = wA[2];
                S[so + 11] = 0;
                S[so + 12] = tA[0]; S[so + 13] = tA[1]; S[so + 14] = tA[2];
                S[so + 15] = 0;
                so += 16;

                const mB = un(p.stB.mid);
                const uB = un(p.stB.ub);
                const wB = un(p.stB.wa);
                const tB = un(p.stB.tv);
                S[so] = mB[0] + dCx; S[so + 1] = mB[1] + dCy; S[so + 2] = mB[2] + dCz;
                S[so + 3] = p.stB.hw;
                S[so + 4] = uB[0]; S[so + 5] = uB[1]; S[so + 6] = uB[2];
                S[so + 7] = p.stB.ht;
                S[so + 8] = wB[0]; S[so + 9] = wB[1]; S[so + 10] = wB[2];
                S[so + 11] = 0;
                S[so + 12] = tB[0]; S[so + 13] = tB[1]; S[so + 14] = tB[2];
                S[so + 15] = 0;
                so += 16;

                const nmx = (uA[0] + uB[0]) * 0.5;
                const nmy = (uA[1] + uB[1]) * 0.5;
                const nmz = (uA[2] + uB[2]) * 0.5;
                const nl = Math.hypot(nmx, nmy, nmz) || 1;
                const wmx = -(wA[0] + wB[0]) * 0.5;
                const wmy = -(wA[1] + wB[1]) * 0.5;
                const wmz = -(wA[2] + wB[2]) * 0.5;
                const wl = Math.hypot(wmx, wmy, wmz) || 1;
                PP[po] = nmx / nl; PP[po + 1] = nmy / nl; PP[po + 2] = nmz / nl;
                PP[po + 3] = 0;
                PP[po + 4] = wmx / wl; PP[po + 5] = wmy / wl; PP[po + 6] = wmz / wl;
                PP[po + 7] = 0;
                po += 8;
            }
            faceRoom(fo + 1);
            scratch.faceStation[fo] = (p.surf === 5) ? segBaseStation + 1 : segBaseStation;
            scratch.faceSurf[fo] = p.surf;
            scratch.facePiece[fo] = segPieceId;
            fo += 1;
            continue;
        }
        if (p.kind === 'joint' && p.pts && p.pts.length >= 3) {
            const pts = p.pts;
            const p0 = un(pts[0]);
            p0[0] += dCx; p0[1] += dCy; p0[2] += dCz;
            for (let k = 1; k + 1 < pts.length; k++) {
                const pk = un(pts[k]);
                pk[0] += dCx; pk[1] += dCy; pk[2] += dCz;
                const pk1 = un(pts[k + 1]);
                pk1[0] += dCx; pk1[1] += dCy; pk1[2] += dCz;

                const jStation = so / 16;
                const jPiece = po / 8;
                room(so + 16);
                pieceRoom(po + 8);
                const S = scratch.stations;
                const PP = scratch.pieces;

                S[so] = p0[0]; S[so + 1] = p0[1]; S[so + 2] = p0[2]; S[so + 3] = 0;
                S[so + 4] = pk[0]; S[so + 5] = pk[1]; S[so + 6] = pk[2]; S[so + 7] = 0;
                S[so + 8] = pk1[0]; S[so + 9] = pk1[1]; S[so + 10] = pk1[2]; S[so + 11] = 0;
                S[so + 12] = p0[0]; S[so + 13] = p0[1]; S[so + 14] = p0[2]; S[so + 15] = 0;
                so += 16;

                const v1x = pk[0] - p0[0]; const v1y = pk[1] - p0[1]; const v1z = pk[2] - p0[2];
                const v2x = pk1[0] - p0[0]; const v2y = pk1[1] - p0[1]; const v2z = pk1[2] - p0[2];
                const nx = v1y * v2z - v1z * v2y;
                const ny = v1z * v2x - v1x * v2z;
                const nz = v1x * v2y - v1y * v2x;
                const nl = Math.hypot(nx, ny, nz) || 1;
                PP[po] = nx / nl; PP[po + 1] = ny / nl; PP[po + 2] = nz / nl;
                PP[po + 3] = 0;
                PP[po + 4] = 0; PP[po + 5] = 0; PP[po + 6] = 0;
                PP[po + 7] = 0;
                po += 8;

                faceRoom(fo + 1);
                scratch.faceStation[fo] = jStation;
                scratch.faceSurf[fo] = 6;
                scratch.facePiece[fo] = jPiece;
                fo += 1;
            }
            continue;
        }
        if (p.kind !== 'rib' || !p.Lp) continue;
        if (!p.ub || !p.wa || !p.tv || !p.half) {
            missing += 1; why.noFrame += 1; continue;
        }
        const ns = p.Lp.length;
        // THE CENTRE LINE COMES FROM THE TRACE, indexed the way
        // tests/cartoon_station.js indexes it: a piece knows which interval it
        // is in and where inside it it starts.
        const nsub = Math.round(1 / p.gsStep);
        const iv = Math.floor(p.gs0 + 1e-9);
        const a0 = Math.round((p.gs0 - iv) * nsub);
        // 🔴 THE TRACE IS THE RENDERER'S _ribbonTrace, ALREADY MODEL SPACE AND
        // ALREADY FLAT. _storeRibbonTrace un-rotates it and adds the view centre
        // back; geom's raw _traceProbe is rotated, and after a render it is
        // empty, because that is the array _storeRibbonTrace consumes.
        // 🔴 ...OR THE PRIM'S OWN, WHEN IT HAS ONE. A base plate is a rib prim
        // but it is not on the backbone curve: its centre line is the straight
        // rung from the ribbon face to the pair centre, and there is no trace
        // entry for it. geom emits those midpoints on the prim instead, in the
        // same space as the frames beside them, so both take the same un().
        // Without this a plate is skipped, lands in the tail the fast path
        // draws from the build frame, and stands still while the backbone
        // animates.
        const ownMid = p.mid;
        const cs = ownMid || (trace && trace[iv]);
        if (!cs || !cs.length) { missing += 1; why.noCentre += 1; continue; }
        const base = so / 16;
        let ok = true;
        for (let k = 0; k < ns; k++) {
            const mi = (a0 + k) * 3;
            const ub = p.ub[k]; const wa = p.wa[k]; const tv = p.tv[k];
            const hf = p.half[k];
            const haveMid = ownMid ? !!ownMid[k] : (mi + 2 < cs.length);
            if (!haveMid || !ub || !wa || !tv || !hf) { ok = false; break; }
            const u = un(ub); const w = un(wa); const t = un(tv);
            room(so + 16);
            const S = scratch.stations;
            // The trace is model space with the view centre added back, so
            // subtracting C leaves un(rotated) relative to C. A prim's own
            // midpoints are un(rotated) relative to the live view centre (Lx,Ly,Lz);
            // adding dC = L - C places them into (coords - C) space, exactly
            // agreeing with the backbone stations when L !== C.
            if (ownMid) {
                const m = un(ownMid[k]);
                S[so] = m[0] + dCx; S[so + 1] = m[1] + dCy; S[so + 2] = m[2] + dCz;
            } else {
                S[so] = cs[mi] - Cx; S[so + 1] = cs[mi + 1] - Cy;
                S[so + 2] = cs[mi + 2] - Cz;
            }
            S[so + 3] = hf[0];
            S[so + 4] = u[0]; S[so + 5] = u[1]; S[so + 6] = u[2]; S[so + 7] = hf[1];
            S[so + 8] = w[0]; S[so + 9] = w[1]; S[so + 10] = w[2];
            // 🔴 THE CONCAVITY, WHICH IS GEOMETRY AND WAS BEING FROZEN. oK is
            // ub . k - how far the +b face points into the local bend - and its
            // piece mean is what decides whether a Richardson helix face is the
            // pale INNER one. It rides in the instance row, so on this path it
            // was the install frame's while every normal beside it was this
            // frame's. Slot 11 was spare.
            S[so + 11] = (p.oK && p.oK[k] !== undefined) ? p.oK[k] : 0;
            S[so + 12] = t[0]; S[so + 13] = t[1]; S[so + 14] = t[2]; S[so + 15] = 0;
            so += 16;
        }
        if (!ok) { so = base * 16; missing += 1; why.badStation += 1; continue; }
        // 🔴 A PIECE THAT DRAWS NOTHING MUST NOT BE IN THE TABLE. One station
        // and no cap yields no quad and no face - it is invisible in the mesh
        // and in every face count - but numbering it shifts every piece and
        // station after it, and then a table that describes the identical
        // picture has a different SHAPE and cannot be written into the textures
        // in place.
        //
        // Measured: on a 30-frame trajectory of 1TIM exactly one frame grows
        // such a piece, and it declined 3 of 33 steps while the face count
        // stayed at 6927 either way. A rule about what is drawn, not about what
        // was captured.
        const yields = (ns > 1) || p.capStart || p.capEnd;
        if (!yields) { so = base * 16; continue; }
        // 🔴 THE PIECE MEANS, WHICH ARE NOT PER STATION AND NOT STATIC. The
        // shader's flat normal is the piece mean of the station normals - the
        // reference quantises one value per piece per side, and feeding it a
        // per-quad value snaps the two into different bands at every station
        // boundary. So they move with the geometry and travel in their own
        // small table, one entry a piece.
        //
        // A PLAIN NORMALISED MEAN, deliberately. buildMeshPart sign-aligns the
        // frames before averaging, but only when the frame probe did NOT supply
        // them - "nothing to decide when the frame came from the renderer: its
        // sign is the one every captured dot product was taken against". This
        // path always has the probe, so that branch never runs.
        //
        // ...and w is MINUS wa: buildMeshPart stores the frame's w negated,
        // because R - L runs along -wa and the L side's outward direction is
        // minus that.
        const pid = po / 8;
        let nmx = 0; let nmy = 0; let nmz = 0;
        let wmx = 0; let wmy = 0; let wmz = 0;
        let kSum = 0;
        const S2 = scratch.stations;
        for (let k = 0; k < ns; k++) {
            const o = (base + k) * 16;
            nmx += S2[o + 4]; nmy += S2[o + 5]; nmz += S2[o + 6];
            wmx -= S2[o + 8]; wmy -= S2[o + 9]; wmz -= S2[o + 10];
            kSum += S2[o + 11];
        }
        const nl = Math.hypot(nmx, nmy, nmz) || 1;
        const wl = Math.hypot(wmx, wmy, wmz) || 1;
        pieceRoom(po + 8);
        const PP = scratch.pieces;
        PP[po] = nmx / nl; PP[po + 1] = nmy / nl; PP[po + 2] = nmz / nl;
        // 🔴 NO HYSTERESIS HERE, AND THAT IS A MEASURED DECISION. The sign of
        // this mean decides the pale inner face of a Richardson helix and it
        // passes through zero - 75 of 9,424 piece means cross it over 15 frames
        // of 9FOG - so holding a marginal crossing looked like the fix for the
        // reported flicker. It is not: with the crossings held, the oscillating
        // pixels went from 0.4182% to 0.4160%, which is nothing. See the note
        // in tests/PERF_NOTES.md for where the flicker actually lives.
        PP[po + 3] = kSum / ns;
        PP[po + 4] = wmx / wl; PP[po + 5] = wmy / wl; PP[po + 6] = wmz / wl;
        // 🔴 AND THE SPARE SLOT CARRIES THE TWO-TONE CANDIDACY, FRESH. The
        // instance row bakes it as `colMode` 3 - facesOf writes
        // `twoCand = !isSide && rich && p.ss === 'H' && !p.co` - and that is a
        // SECONDARY STRUCTURE test, so a frame whose assignment has drifted
        // since the mesh was built draws the last assignment's helices.
        //
        // Invisible today because a change of letter also changes the station
        // count and forces a rebuild. The moment the sampling is made uniform
        // it stops doing that (tests/ss_axis.py) and this is what is left: the
        // measured 0.1376% of _traj_1tim.pdb's frame 2, thirty-two rows of
        // lane 15, which tests/station_unpinned.py catches.
        //
        // It goes here because the piece table is rewritten from the prims on
        // every frame, which is the same reason `aK` is read from slot 3
        // rather than from the row beside it.
        // 🔴 AND THE STRAND'S PALE SIDE FACES RIDE THE SAME SLOT, as bit 2.
        // `edgeWhite = isSide && rich && (p.ss === 'E' || p.naRung)` in facesOf
        // paints a Richardson strand's two side faces 244,246,240 and bakes
        // colMode 2 to say so - and that is a letter, exactly like the helix
        // test above. Once an arrowhead stopped forcing a rebuild, a residue
        // becoming a strand without one left those sides the loop's colour:
        // 0.7565% of _traj_unfold.pdb's frame at a worst channel of 172,
        // measured by tests/station_unpinned.py, against 0.0287% before.
        //
        // One float rather than two because a piece row is eight and both
        // texels are full: bit 1 is the two-tone candidate, bit 2 the pale
        // side, and the shader takes them apart.
        // ...and bit 4 is `fullOutline`: exactly `rich && ss === 'E'`, which is
        // NOT the same test as bit 2 - that one takes a nucleic rung too, and a
        // rung draws no creases. refreshEdgesFromStations reads this one to
        // decide whether a strip's cross edge is drawn this frame.
        PP[po + 7] = ((rich && p.ss === 'H' && !p.co) ? 1 : 0)
            + ((rich && (p.ss === 'E' || p.naRung)) ? 2 : 0)
            + ((rich && p.ss === 'E') ? 4 : 0);
        po += 8;
        // ...the caps first, exactly as facesOf pushes them. A cap is not a
        // swept quad - it is the cross-section itself - so it names its own
        // station and a surface of its own.
        faceRoom(fo + 2 + (ns - 1) * 4);
        const FS = scratch.faceStation; const FU = scratch.faceSurf;
        const FP = scratch.facePiece;
        if (p.capStart) { FS[fo] = base; FU[fo] = 4; FP[fo] = pid; fo += 1; }
        if (p.capEnd) { FS[fo] = base + ns - 1; FU[fo] = 5; FP[fo] = pid; fo += 1; }
        for (let k = 0; k + 1 < ns; k++) {
            for (let si = 0; si < 4; si++) {
                FS[fo] = base + k; FU[fo] = si; FP[fo] = pid; fo += 1;
            }
        }
    }
    if (!fo) return null;
    // Subarrays, not copies: the caller reads them and either uploads or
    // compares, both before the next capture overwrites them.
    return {
        stations: scratch.stations.subarray(0, so),
        stationCount: so / 16,
        faceStation: scratch.faceStation.subarray(0, fo),
        faceSurf: scratch.faceSurf.subarray(0, fo),
        facePiece: scratch.facePiece.subarray(0, fo),
        pieces: scratch.pieces.subarray(0, po),
        pieceCount: po / 8,
        faceCount: fo,
        missing, missingWhy: why,
    };
}

// WHERE THE SLOT SITS IN AN INSTANCE ROW. 48 floats: four corners, six frame
// vectors, the three occlusion dots, the colour, and three flag words - the
// slot is the first float of the third. Keep in step with the emit pass.
const FILL_STRIDE = 48;
const FILL_PAL_AT = 44;

/**
 * THE CONTACT STROKES, AS A KEY, for the part that carries them.
 *
 * A contact is drawn WITH the mesh rather than painted over it - parts/embed.js
 * says so where it reloads the frame instead of merely redrawing - so the part
 * it rides in has to notice when the list changes. Digested rather than
 * stringified because this runs on every build, and a contact is a handful of
 * numbers and a colour.
 */
function linesKeyOf(lines) {
    if (!lines || !lines.length) return 0;
    let h = 2166136261 >>> 0;
    const mix = (v) => {
        const q = Math.round((typeof v === 'number' ? v : 0) * 100) | 0;
        h = Math.imul(h ^ (q & 255), 16777619) >>> 0;
        h = Math.imul(h ^ ((q >>> 8) & 255), 16777619) >>> 0;
        h = Math.imul(h ^ ((q >>> 16) & 255), 16777619) >>> 0;
    };
    mix(lines.length);
    for (const ln of lines) {
        if (!ln) { mix(-1); continue; }
        mix(ln.w); mix(ln.wA); mix(ln.zBias);
        if (ln.c) { mix(ln.c.r); mix(ln.c.g); mix(ln.c.b); }
        const pts = ln.pts || [];
        mix(pts.length);
        for (const p of pts) { if (p) { mix(p[0]); mix(p[1]); mix(p[2]); } }
    }
    return h >>> 0;
}

/**
 * WHICH OF THE THREE PARTS A FACE BELONGS TO. 0 the ribbon, 1 everything else
 * that holds still under a click - ligands, base plates, contacts, lone atoms -
 * and 2 the side chains.
 *
 * 🔴 ONE RULE, IN ONE PLACE, BECAUSE THERE WERE TWO AND THEY DRIFTED. makeResident
 * grouped by `stick` alone and so did refreshSticksFrom, and a lone atom's disc
 * is neither a stick nor the ribbon: it fell into part 0, which the station
 * table is supposed to describe exactly. Nine ions on 1EHZ then took the fast
 * path away from the whole structure, and the second copy of the rule made the
 * first one's fix invisible - refreshSticksFrom went on declining with its own
 * message about the same nine faces.
 *
 * Part 0 must be exactly what stationMeshOf walks, which is `rib` prims. Every
 * face that is not one of those is part of the tail, and the tail is rebuilt.
 */
function faceGroup(f) {
    if (f.disc) return 1;
    if (f.stick) return f.sc ? 2 : 1;
    return 0;
}

function makeResident(faces, scale, prm, lines) {
    const P0 = prm || defaultParams();
    // THREE GROUPS, AND EACH ONE CHANGES FOR ITS OWN REASONS.
    //
    //   ribbon   the backbone. Unchanged by anything a click does.
    //   other    ligands, base plates, contacts. A heme is 2,000 faces on
    //            4HHB and is exactly as unchanged by a side-chain click as
    //            the ribbon is - it was being rebuilt because it happened to
    //            be made of sticks.
    //   side     the side chains, which are what the click changed.
    //
    // The cut between the last two is `sc`, and it comes from cartoon/geom.js
    // rather than being worked out here: the CA-CB bond has one end on the
    // backbone and one in the side-chain map, and classifying by the position
    // index reads it as backbone while the CB-CG bond beside it reads as side
    // chain. Those two share a welded face. Measured with geom's own flag:
    // 0 mixed welds and 0 shared edges on 4HHB, 3PTB and 1EHZ.
    // 🔴 AND A LONE ATOM IS NOT THE RIBBON, however unlike a stick it is.
    //
    // The grouping asked one question - is it a stick? - so a disc, which is
    // neither, fell into the ribbon group. Group 0 is the part the station
    // table describes, and the table is built by walking `rib` prims, which a
    // disc is not: so part 0 held nine more faces than the table did, and
    // refreshSticksFrom declines on exactly that mismatch ("the tail is not
    // just sticks"). Nine magnesium and manganese ions took the whole
    // trajectory fast path away from 1EHZ - every control, every frame - and
    // the decline named the count without naming the cause, which is what
    // stationDecline() was added to fix.
    //
    // A disc belongs with the ligands and the base plates: it is not on the
    // backbone curve, it has no stations, and it IS rebuilt per frame - its
    // quad is emitted in projected space and unprojected, so it has to be.
    // Group 1 is refreshed by refreshSticksFrom, which is where it wanted to be
    // all along.
    const groups = [[], [], []];
    for (const f of faces) groups[faceGroup(f)].push(f);
    // 🔴 WHETHER THE SIDE CHAINS ARE STATIONED IS NEEDED BEFORE THE LOOP, NOT
    // AFTER IT. It used to be read where the parts are concatenated, which is
    // past the point where each part is BUILT - and the build has to know,
    // because a stationed face's outward normal comes from its station's frame
    // rather than from the winding. See the SM offset below.
    const stationedSide = (groups[2].length > 0 && !!groups[2][0].stationed);
    const RB = window.__rebuild || {};
    const t0 = performance.now();

    // ...and the same question for the side chains, asked once: the table has
    // to cover the ribbon AND them, since it describes them in that order.
    const sideRowsUnused = stationedSide && stationDraw
        && stationCoverCount >= groups[0].length + groups[2].length
        && !(typeof window !== 'undefined' && window.__stationRowCheck);
    // ...the two that are worth keeping, each against a hash of its own faces
    const parts = [];
    for (let g = 0; g < 3; g++) {
        const face = groups[g];
        // CONTACTS RIDE WITH `other`: they are strokes rather than faces, and
        // they change when the contacts change, which is not when a side chain
        // does.
        const ln = (g === 1) ? lines : null;
        if (g === 2) {                      // always rebuilt: it is the change
            // 🔴 AND IT IS DRAWN FROM THE STATIONS TOO, SO IT IS BUILT LIKE
            // THEM. stationFillFaces is the ribbon's faces followed by these,
            // so their rows are never issued either - and, more than a saving,
            // it is what puts the station rule in reach of their outward
            // normals. Built from the winding while drawn from the stations,
            // a side chain's outline was derived one way at build and the
            // other on every frame after: 2,299 of 18,304 edge rows carried a
            // different normal from the one a rebuild of the same frame
            // writes, worst 1.997 on a unit vector - two faces' silhouette
            // verdicts flipping, which is 0.126% of the pixels.
            parts.push(buildMeshPart(face, scale, P0, ln,
                sideRowsUnused, sideRowsUnused ? groups[0].length : 0));
            continue;
        }
        const slot = g === 0 ? ribbonPart : otherPart;
        // 🔴 THE RIBBON'S INSTANCE ROWS ARE NOT DRAWN WHEN THE TABLE COVERS IT.
        // drawResident issues part 0 from the station buffer, so the 48 floats
        // a face contributes here are built, uploaded and never read. The test
        // is exact rather than hopeful: the table was made from this frame's
        // prims and says how many faces it describes, and it has to be every
        // one of them - a table covering a prefix leaves the rest to be drawn
        // from these rows.
        // 🔴 AND THE ROW CHECK FORCES THEM TO BE BUILT, or it compares a thing
        // with itself. With the rows skipped, makeResidentStations takes the
        // face-derived path - and the check's "other" derivation is that same
        // path, so it would agree perfectly while proving nothing. The flag is
        // tests/station_rows.py's alone.
        const rowsUnused = (g === 0) && stationDraw
            && stationCoverCount >= face.length && face.length > 0
            && !(typeof window !== 'undefined' && window.__stationRowCheck);
        // ...and the cache is keyed on it, because a part built without its
        // rows must never be handed to a frame that will draw them.
        if (g === 0 && typeof window !== 'undefined') {
            window.__ribbonRowsSkipped = (window.__ribbonRowsSkipped || 0)
                + (rowsUnused ? 1 : 0);
            window.__ribbonRowsBuilt = (window.__ribbonRowsBuilt || 0)
                + (rowsUnused ? 0 : 1);
        }
        const hash = ribbonHashOf(face, scale, P0)
            // 🔴 AND GROUP 1 CARRIES THE CONTACTS, WHICH ARE NOT FACES.
            // `other` is hashed over its own faces - ligands, base plates - and
            // a contact is a STROKE built beside them from `lines`, so adding
            // or removing one moves nothing the hash looks at: the part is
            // handed back from cache and the contact never appears. Measured on
            // tests/embed.py: `lines` reached buildMeshPart 14 times on the
            // one-slot build and 0 times here, and BOTH setContacts and
            // setContacts([]) failed, which is the tell that it is the key
            // rather than the drawing. The mesh cache is innocent - it missed
            // twice across the same call.
            ^ (g === 1 ? linesKeyOf(ln) : 0)
            ^ (rowsUnused ? 0x5bf03635 : 0);
        let part = (slot && slot.hash === hash) ? slot.part : null;
        // REPORTED FROM WHAT HAPPENED, not from the comparison: a probe that
        // reads the slot cannot tell a reuse from a rebuild that happened to
        // leave the same slot behind, and it said "reused" through a mutation
        // that rebuilt every time.
        const cameFromCache = !!part;
        if (g === 0) {
            RB.ribbonReused = cameFromCache;
            if (typeof window !== 'undefined') {
                if (cameFromCache) window.__sidechainBuilds = (window.__sidechainBuilds || 0) + 1;
                else window.__ribbonBuilds = (window.__ribbonBuilds || 0) + 1;
            }
        }
        if (g === 1) RB.otherReused = cameFromCache;
        if (!part) {
            part = buildMeshPart(face, scale, P0, ln, rowsUnused);
            if (g === 0) {
                // the ribbon's own phase record, before the others overwrite
                // it - they share `__mrPhase` and the last one wins, which is
                // the side-chain part with no faces in it.
                //
                // 🔴 KEPT UNCONDITIONALLY, and it used to need __heapProbe.
                // That flag also turns on two window.gc() calls per phase, so
                // asking for the ribbon's phases meant measuring them through
                // a collector - and without it the only record left was the
                // wrong part's. Copying eight numbers costs nothing.
                window.__mrRibbon = Object.assign({}, window.__mrPhase);
                // ...and the edge table's own tally, for the same reason
                window.__edgeStatsRibbon = Object.assign({}, window.__edgeStats);
            }
            const keep = (part.bytes <= MESH_KEEP_MAX_BYTES) ? { hash, part } : null;
            if (g === 0) ribbonPart = keep; else otherPart = keep;
        } else {
            patchPalette(part, face, RB);
        }
        parts.push(part);
    }
    // ...and the ribbon's own faces, for the station rows. The fifteen static
    // floats a station row carries are all facesOf's - the colour and the three
    // flag words - so they can be read off the face instead of lifted out of a
    // 48-float instance row that the station path never draws. Kept only while
    // that path is on, for the same reason stationFillRows is.
    stationFillFaces = stationDraw ? (stationedSide ? groups[0].concat(groups[2]) : groups[0]) : null;
    RB.nRibbon = groups[0].length;
    RB.nOther = groups[1].length;
    RB.nSide = groups[2].length;
    RB.stickMs = +(performance.now() - t0).toFixed(1);
    const orderedParts = stationedSide ? [parts[0], parts[2], parts[1]] : parts;
    return installParts(orderedParts, scale);
}

/**
 * THE SLOTS, PUT BACK. A kept part's fill carries each face's baked colour AND
 * the palette slot it came from, and only the slot moves when a side chain is
 * added - `ci` indexes the segment list and a side-chain bond IS a segment.
 * Rewriting one float per face is too small to measure, and it is what keeps a
 * later colour change (which repaints from the palette without rebuilding)
 * exact.
 *
 * The OUTLINE's slots are not patched: an edge takes its slot from whichever
 * face claimed it first and the build does not record which that was. That is
 * the one approximation here - an outline tint on a couple of faces after a
 * palette change, never a fill and never a shape.
 */
function patchPalette(part, face, RB) {
    let patched = 0;
    for (let i = 0; i < face.length; i++) {
        const want = face[i].pal === undefined ? -1 : face[i].pal;
        const at = i * FILL_STRIDE + FILL_PAL_AT;
        if (part.fill[at] !== want) { part.fill[at] = want; patched++; }
    }
    if (RB) RB.palPatched = (RB.palPatched || 0) + patched;
}

/**
 * THE PARTS, CONCATENATED AND UPLOADED, in the order they are given: ribbon,
 * then the other sticks, then the side chains.
 *
 * That order is not the depth order the prims were sorted into, and where two
 * surfaces land on exactly the same depth `depthFunc(LESS)` gives the pixel to
 * whichever was drawn first. It moves 260 pixels of 357,604 on 4HHB with 400
 * side chains out, every one on a seam, none on open ribbon - and the winner
 * at a tie was already arbitrary. See docs/SELECTION_MARK.md's neighbour, the
 * mesh notes in CLAUDE.md.
 */
function installParts(parts, scale) {
    let nFill = 0; let nEdge = 0; let nCen = 0; let count = 0;
    let rad = 0; let hasContacts = false; let edges = 0;
    let tailRadius = 0;
    for (let gi = 0; gi < parts.length; gi += 1) {
        const p = parts[gi];
        nFill += p.fill.length;
        nEdge += p.edges ? p.edges.length : 0;
        nCen += p.centroids.length;
        count += p.count;
        edges += p.edgeCount;
        if (p.rad > rad) rad = p.rad;
        // ...and the same over everything that is NOT the ribbon, because the
        // station table describes only the ribbon and the depth range has to
        // hold a side chain that reaches further out than the backbone. `gi`
        // counts the parts in faceGroup order, so 0 is the ribbon.
        if (gi > 0 && p.rad > tailRadius) tailRadius = p.rad;
        if (p.hasContacts) hasContacts = true;
    }
    const fill = new Float32Array(nFill);
    const cen = new Float32Array(nCen);
    let fo = 0; let co = 0;
    // 🔴 WHERE EACH PART LANDED, so one of them can be rewritten later without
    // rebuilding the others. The station table moves the ribbon; the sticks -
    // side chains, ligands, contacts - have no stations and are refreshed by
    // rebuilding just their two parts and writing them back over these spans.
    // Recorded here because this is the only place that knows the offsets, and
    // a span is only usable while the part's SIZE is unchanged, which
    // refreshSticksFrom checks before it writes anything.
    residentPartSpans = [];
    let eSpan = 0; let fBase = 0;
    for (const p of parts) {
        residentPartSpans.push({
            fillAt: fo, fillLen: p.fill.length,
            cenAt: co, cenLen: p.centroids.length,
            edgeAt: eSpan, edgeLen: p.edges ? p.edges.length : 0,
            count: p.count, faceBase: fBase,
        });
        eSpan += p.edges ? p.edges.length : 0;
        fBase += p.count;
        fill.set(p.fill, fo); fo += p.fill.length;
        cen.set(p.centroids, co); co += p.centroids.length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf3);
    gl.bufferData(gl.ARRAY_BUFFER, fill, gl.STATIC_DRAW);
    // THE INSTANCE ROWS, FOR A CONSUMER THAT WANTS TO CHECK THEM. Behind the
    // same flag as __faces, because it is the whole mesh - 1.3 MB on a
    // mid-sized protein - and pinning that for the life of the page is what
    // the note on __gpuDiag above is about.
    //
    // 🔴 tests/PERF_NOTES.md SAYS __fillHash AND __edgeHash WERE KEPT. They
    // were not: nothing in src/ has defined either for some time, and two
    // comments in this file were written against them on the strength of that
    // sentence. What is here is the array itself, which is strictly more than
    // a hash and is what a tolerance comparison needs.
    if (window.__gpuDiag) window.__fill = fill;
    // ...and kept for the station path, which needs the row it lifts its flags
    // and colours out of. Only while that path is switched on: it is the whole
    // mesh, 1.3 MB on a mid-sized protein, and pinning it for everyone to hold
    // a copy nobody reads is what the note on __gpuDiag above is about.
    // 🔴 THE RIBBON PART'S OWN ROWS, NOT THE CONCATENATION. This was the
    // combined fill, which worked only because the ribbon is the first part in
    // it - and stops working the moment the ribbon contributes NO rows, which
    // is what happens when the station table covers it. The combined array is
    // then the TAIL's rows, and reading the table's fifteen floats out of them
    // gave a ligand's colour to a ribbon face: 18.2% of the frame on a
    // structure with side chains, and the table refusing on anything with a
    // tail at all. An empty array here now means exactly what it should - the
    // ribbon's rows were never built.
    stationFillRows = stationDraw ? (parts[0] ? parts[0].fill : fill) : null;

    let ed = null;
    let edSrc = null;
    if (nEdge) {
        ed = new Float32Array(nEdge);
        // 🔴 AND THE PROVENANCE WITH IT, WITH THE FACE INDICES SHIFTED. An
        // edge's row names its two corners as fi*12 + corner*3 and its two
        // faces as fi, both counted within the PART - and the parts are
        // concatenated here, so a later part's face 0 is not face 0 of the
        // mesh. Copied without the shift, every edge of the second part would
        // rebuild itself from the first part's geometry.
        edSrc = parts.some((q) => q && q.edgeSrc)
            ? new Int32Array(nEdge / ED_FLOATS * ED_SRC).fill(-1) : null;
        let eo = 0;
        let so = 0;
        let faceBase = 0;
        for (const p of parts) {
            if (p.edges) {
                ed.set(p.edges, eo); eo += p.edges.length;
                if (edSrc && p.edgeSrc) {
                    for (let i = 0; i < p.edgeSrc.length; i += ED_SRC) {
                        const oa = p.edgeSrc[i]; const ob = p.edgeSrc[i + 1];
                        const fa = p.edgeSrc[i + 2]; const fb = p.edgeSrc[i + 3];
                        edSrc[so++] = oa < 0 ? -1 : oa + faceBase * 12;
                        edSrc[so++] = ob < 0 ? -1 : ob + faceBase * 12;
                        edSrc[so++] = fa < 0 ? -1 : fa + faceBase;
                        edSrc[so++] = fb < 0 ? -1 : fb + faceBase;
                        edSrc[so++] = p.edgeSrc[i + 4];
                        edSrc[so++] = p.edgeSrc[i + 5];
                        edSrc[so++] = p.edgeSrc[i + 6];
                    }
                } else if (edSrc) {
                    so += (p.edges.length / ED_FLOATS) * ED_SRC;
                }
            }
            faceBase += p.count;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, bufInk);
        gl.bufferData(gl.ARRAY_BUFFER, ed, gl.STATIC_DRAW);
    }
    // ...kept, so the station path can rewrite the outline without rebuilding
    // the adjacency. Nothing else reads them.
    residentEdges = ed && edSrc ? { ed, edSrc } : null;
    // ...and a COPY of them for the harness, which needs two builds side by
    // side in one process and cannot use these: `residentEdges` is replaced by
    // the next build and `ed` is the very buffer the refresh writes through.
    // Only while the flag is set - it is the whole outline, megabytes on a
    // large structure. See tests/station_edges.py.
    if (window.__edgeCapture) {
        window.__edgeCaptured = ed && edSrc
            ? { ed: Float32Array.from(ed), edSrc: Int32Array.from(edSrc) }
            : null;
        window.__edgeCaptures = (window.__edgeCaptures || 0) + 1;
    }
    // ASKED OF THE WHOLE MESH, not of each part. They are kept and dropped
    // together - a mesh restored with its fills and without its outline is not
    // a mesh - so a fill just under the cap and an outline just over it must
    // not leave one of them pinned for a restore that can never happen.
    const hold = keepArrays
        && (fill.byteLength + (ed ? ed.byteLength : 0)) <= MESH_KEEP_MAX_BYTES;
    lastFill = hold ? fill : null;
    lastEdges = hold ? ed : null;
    edgeCount = edges;
    residentHasContacts = hasContacts;

    if (window.__meshDigest) {
        const rowHash = (arr, stride) => {
            let acc = 0;
            for (let i = 0; i + stride <= arr.length; i += stride) {
                let h = 2166136261 >>> 0;
                for (let k = 0; k < stride; k++) {
                    const q = Math.round(arr[i + k] * 100) | 0;
                    h ^= q & 255; h = Math.imul(h, 16777619) >>> 0;
                    h ^= (q >>> 8) & 255; h = Math.imul(h, 16777619) >>> 0;
                    h ^= (q >>> 16) & 255; h = Math.imul(h, 16777619) >>> 0;
                }
                acc = (acc + h) >>> 0;
            }
            return acc;
        };
        window.__meshDigest = { fill: rowHash(fill, 48), fillN: fill.length / 48,
            edges: ed ? rowHash(ed, 19) : 0, edgeN: ed ? ed.length / 19 : 0 };
    }

    // one texel per residue, sized to the structure
    ensureVisTexture(resMap && resMap.nBase ? resMap.nBase : 1);
    // WHERE THE COLOURS COME FROM is the consumer's business: the harness has a
    // colour-scheme dropdown, the app has a five-level hierarchy it has already
    // resolved. Both hand over a function, and recolour() calls the same one -
    // which is what makes a colour change a texture upload and not a rebuild.
    if (paletteSource) setPalette(paletteSource());
    srCache = null; srKey = '';
    resident = { count, zMin: -rad, zMax: rad, scale, centroids: cen };
    // ...and what of that radius is NOT the ribbon, kept for the correction
    // that follows installStations. The station table describes the ribbon
    // alone, and the depth range still has to hold a side chain that reaches
    // further out than the backbone.
    resident.tailRad = tailRadius;
    return resident;
}

// THE SPAN OF PRIM DEPTHS AT THIS VIEW, which is what the renderer normalises
// its `near` over - min and max of the face centroids' view z. Recomputed every
// frame, because it turns with the model: a loop over three floats per face,
// which is about ten microseconds on 3000 faces and three hundred on 100000.
// Cached on the rotation so a redraw that has not turned pays nothing.
let srCache = null;
let srKey = '';
function shadeRange() {
    if (!resident || !resident.centroids) return [resident ? resident.zMin : -1,
        resident ? resident.zMax : 1];
    const R = viewRot;
    const k = R[2][0] + ',' + R[2][1] + ',' + R[2][2] + ',' + resident.count;
    if (srCache && srKey === k) return srCache;
    const c = resident.centroids;
    const a = R[2][0]; const b = R[2][1]; const d = R[2][2];
    let lo = Infinity; let hi = -Infinity;
    for (let i = 0; i < c.length; i += 3) {
        const z = a * c[i] + b * c[i + 1] + d * c[i + 2];
        if (z < lo) lo = z;
        if (z > hi) hi = z;
    }
    if (!(hi > lo)) { lo = resident.zMin; hi = resident.zMax; }
    srCache = [lo, hi];
    srKey = k;
    return srCache;
}

// THE OCCLUSION ITSELF: a depth field in, a shadow/tint pair out, and a resolve
// that matches the interleaved rotation the sampling uses. Nothing here knows
// what drew the depth - FSAO reads a texture of view depths - which is why the
// tube and the cartoon can share it and differ only in what they hand in.
//
//   scale     device pixels per Angstrom at pe = 1
//   density   the kernel's areal weight, in segments per square Angstrom
//   selfBias  how much nearer a sample must be to count as something ELSE
//   strength  the Shadow control; intensity the per-unit darkening
function runOcclusion(cv, o) {
    // UNITS 4 AND 5, NOT 0 AND 1. The callers leave their own textures bound
    // on the low units - the cartoon reads its visibility map on 0 and its
    // palette on 1 - and this pass ran between those binds and the draw that
    // uses them. On 0 and 1 it left the depth field where the visibility map
    // should be and the raw occlusion where the palette should be: half the
    // drawing turned white and the density knob did nothing, because the damage
    // was in the palette rather than in the shadow.
        gl.bindFramebuffer(gl.FRAMEBUFFER, aoFbo);
        gl.viewport(0, 0, cv.width, cv.height);
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
        gl.useProgram(progAO);
        const ua = (nm, v) => gl.uniform1f(gl.getUniformLocation(progAO, nm), v);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, zTex);
        gl.uniform1i(gl.getUniformLocation(progAO, 'uZTex'), 4);
        gl.uniform2f(gl.getUniformLocation(progAO, 'uTexel'), 1 / cv.width, 1 / cv.height);
        ua('uScale', o.scale);
        ua('uPersp', isPersp() ? 1 : 0);
        ua('uFL', focalLength());
        // The 2D renderer's own numbers: cutoff 2.0 x the reference bond and an
        // offset 2.5 x it for the shadow, 0.5 x / 2.5 x for the tint.
        const refLen = 3.8;
        ua('uShadowCut', refLen * 2.0);
        ua('uShadowMax', refLen * 2.0 + refLen * 2.5);
        ua('uTintCut', refLen * 0.5);
        ua('uTintMax', refLen * 0.5 + refLen * 2.5);
        ua('uStrength', o.strength);
        ua('uIntensity', o.intensity);
        // The areal density the kernel is scaled by: a calibrated constant now
        // rather than a measurement - see buildTube for the six-structure sweep
        // that says the measurement was the thing making structures disagree -
        // with tubeAOGain as the knob on top of it.
        ua('uDensity', o.density);
        // A sample less than about a tube's radius nearer is the SAME tube's
        // own bulge, not something in front of it. Without this every capsule
        // shades its own rim and the flat segments come out looking moulded.
        ua('uSelfBias', o.selfBias);
        const tmA = tmStart('2-ao');
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        tmEnd(tmA);

        // RESOLVE: the 4x4 box that matches the interleaved rotation.
        gl.bindFramebuffer(gl.FRAMEBUFFER, aoFbo2);
        gl.viewport(0, 0, cv.width, cv.height);
        gl.useProgram(progBlur);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, aoTex);
        gl.uniform1i(gl.getUniformLocation(progBlur, 'uAOTex'), 5);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, zTex);
        gl.uniform1i(gl.getUniformLocation(progBlur, 'uZTex'), 4);
        gl.uniform2f(gl.getUniformLocation(progBlur, 'uTexel'), 1 / cv.width, 1 / cv.height);
        const tmB = tmStart('3-blur');
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        tmEnd(tmB);
}

/**
 * THE STATION MESH, ON THE CARD.
 *
 * Two RGBA32F textures and one instance buffer. The buffer is topology and
 * colour - 18 floats a face against the 48 the other path uploads - and it does
 * not move when the structure does; the textures are the geometry, and they are
 * all a new frame has to write.
 *
 * 🔴 THE STATIC ROW IS LIFTED OUT OF THE FILL, DELIBERATELY. Those fifteen
 * floats - the colour, the three flag words - are computed by facesOf and are
 * the same numbers either way, so taking them from the row that already exists
 * makes this a change of ROUTE and not of content: if the picture then differs,
 * it is the geometry path and nothing else. Building them independently would
 * put two suspects in the frame for every pixel that moved.
 *
 * 🔴 AND THE TEXTURE IS WIDER THAN IT IS TALL, WITHIN THE DRIVER'S LIMIT. A
 * station is four texels and a piece two; laid out in one row they would exceed
 * MAX_TEXTURE_SIZE on anything but a small structure, and the failure is a
 * silent black draw rather than an error.
 */
/**
 * THE FIFTEEN STATIC FLOATS OF A STATION ROW, READ OFF THE FACE.
 *
 * makeResidentStations lifts them out of the 48-float instance row, and its
 * comment says why: "they are computed by facesOf and are the same numbers
 * either way, so taking them from the row that already exists makes this a
 * change of ROUTE and not of content". That was the right call while there was
 * nothing to check it against. This is the independent derivation, and
 * tests/station_rows.py is what turns the claim into a gate.
 *
 * It exists because the station path does not draw the 48-float rows at all -
 * they are built, uploaded and never issued for the ribbon - so every geometry
 * pass feeding them is work that only the outline still needs. Deriving the
 * fifteen floats here is the first step of not building them.
 *
 * @param {Array} faces the ribbon part's faces, in the order they were emitted
 * @param {number} rows how many the table covers
 * @returns {Float32Array|null} rows * STATION_ROW floats, the first three
 *   slots left for the caller's station indices
 */
function stationRowsFromFaces(faces, rows) {
    if (!faces || faces.length < rows) return null;
    const out = new Float32Array(rows * STATION_ROW);
    for (let f = 0; f < rows; f += 1) {
        const face = faces[f];
        if (!face) return null;
        const o = f * STATION_ROW;
        const c = face.c || { r: 0, g: 0, b: 0 };
        out[o + 3] = c.r; out[o + 4] = c.g; out[o + 5] = c.b;
        // flags0: k, top, iMul, stick
        out[o + 6] = face.kAvg || 0;
        out[o + 7] = face.top === undefined ? 1 : face.top;
        out[o + 8] = face.iMul === undefined ? 1 : face.iMul;
        out[o + 9] = face.stick ? 1 : 0;
        // flags1: side, cap, sheet, residue
        out[o + 10] = face.side ? 1 : 0;
        out[o + 11] = face.cap ? 1 : 0;
        out[o + 12] = face.sheetA ? 1 : 0;
        out[o + 13] = face.res || 0;
        // flags2: palette slot, colour mode, packed bits, sheet at the far end
        out[o + 14] = face.pal === undefined ? -1 : face.pal;
        out[o + 15] = face.colMode || 0;
        out[o + 16] = (face.two ? 1 : 0) + (face.unlit ? 2 : 0)
            + (face.plate ? 4 : 0) + (face.disc ? 8 : 0);
        out[o + 17] = face.sheetB ? 1 : 0;
    }
    return out;
}

// ONE WAY TO PUT A STATION TEXTURE ON THE CARD. A build allocates one from the
// capture and a restore allocates one from the cached copy, and two copies of
// the filter and wrap settings are two chances for a restored mesh to sample
// its table differently from the mesh it was built beside.
function stationTexture(padded, w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, padded);
    return t;
}

// ====================================================================
// A CACHED MESH HOLDS ITS STATION TABLE AS DATA, NEVER AS GL OBJECTS
//
// A station table is CPU arrays - the mapping, the static rows, the padded
// geometry - plus three GL handles: the row buffer and the station and piece
// textures. The card owns ONE live set of those, and clearResidentStations
// deletes it whenever a new table is installed.
//
// 🔴 captureMesh kept the table with `Object.assign({}, residentStations)`,
// which copied the HANDLES along with the arrays. The very next build deleted
// the objects they named, so every mesh in the cache was holding a table whose
// buffer and textures no longer existed - and a restore handed that table back.
// Every check on the fast path reads the arrays, which were intact, so all of
// them agreed: mapping equal, counts equal, `stale` false. updateStations wrote
// into a deleted texture, which WebGL no-ops without a word, and the draw bound
// objects that were gone. Measured on 1YNE, Hide / Plate / Hide and
// Hide / Show / Hide: the third press takes the station path with
// `live: false`, and the hairpin comes back as two translucent spheres and a
// handful of stray lines. The 2D painter drew every one of those states
// correctly, and a forced invalidate() - which throws both halves away - always
// fixed it, which is how it read as a cache fault for three rounds before the
// handles were checked.
//
// So the cache holds a SNAPSHOT: every field but the handles. A restore makes
// the live set from it, the same way activateMesh already re-uploads the fill
// and the edges from the CPU arrays a mesh keeps - so the card's objects always
// belong to exactly one table, the live one, and there is nothing in the cache
// for a delete to leave dangling. The cost is paid on a mesh EXCHANGE - one
// buffer and two texture uploads of data already in hand - and not on a frame
// step, which never exchanges a mesh.
function stationsSnapshot(t) {
    if (!t) return null;
    const snap = Object.assign({}, t);
    snap.buf = null; snap.stationTex = null; snap.pieceTex = null;
    return snap;
}

// ...and the live set made from one. The pads are COPIED: updateStations writes
// into the live table's pads in place, and the snapshot stays in the cache
// after a restore, so sharing them would let a later frame rewrite a cached
// mesh from under itself.
function activateStations(snap) {
    clearResidentStations();
    if (!gl || !snap || !snap.rows || !snap.stationPad || !snap.piecePad
        || !(snap.stationW > 0) || !(snap.pieceW > 0)) return;
    const live = Object.assign({}, snap);
    live.stationPad = new Float32Array(snap.stationPad);
    live.piecePad = new Float32Array(snap.piecePad);
    live.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, live.buf);
    gl.bufferData(gl.ARRAY_BUFFER, live.rows, gl.STATIC_DRAW);
    live.stationTex = stationTexture(live.stationPad, snap.stationW,
        live.stationPad.length / (snap.stationW * 4));
    live.pieceTex = stationTexture(live.piecePad, snap.pieceW,
        live.piecePad.length / (snap.pieceW * 4));
    residentStations = live;
}

function makeResidentStations(mesh, fill) {
    if (!gl || !mesh || !fill) return null;
    // 🔴 TWO SOURCES FOR FIFTEEN FLOATS, AND THE FILL IS THE OPTIONAL ONE NOW.
    // Where the ribbon's instance rows are not drawn they are not built either,
    // and the fill comes back empty; the same numbers are read off the face.
    // tests/station_rows.py holds the two derivations to zero differing floats
    // over 47,533 rows, which is what makes the choice a matter of route.
    const fromFill = fill.length > 0;
    const rows = fromFill
        ? Math.min(mesh.faceCount, Math.floor(fill.length / 48))
        : mesh.faceCount;
    const data = fromFill ? new Float32Array(rows * STATION_ROW)
        : stationRowsFromFaces(stationFillFaces, rows);
    if (!data) return null;
    for (let f = 0; f < rows; f++) {
        const o = f * STATION_ROW;
        data[o] = mesh.faceStation[f];
        data[o + 1] = mesh.faceSurf[f];
        data[o + 2] = mesh.facePiece[f];
        if (!fromFill) continue;
        const q = f * 48;
        data[o + 3] = fill[q + 33]; data[o + 4] = fill[q + 34]; data[o + 5] = fill[q + 35];
        for (let k = 0; k < 12; k++) data[o + 6 + k] = fill[q + 36 + k];
    }
    // 🔴 THE SAME FIFTEEN FLOATS, DERIVED THE OTHER WAY, AND COMPARED. The row
    // above is lifted out of the instance row on the argument that facesOf
    // computed those numbers and they are the same either way. This is that
    // argument as a measurement: stationRowsFromFaces reads them off the face,
    // and every float has to agree. Off unless asked for - it builds a second
    // table - and tests/station_rows.py is what asks.
    if (typeof window !== 'undefined' && window.__stationRowCheck) {
        const alt = stationRowsFromFaces(stationFillFaces, rows);
        const d = { rows, faces: stationFillFaces ? stationFillFaces.length : -1,
            built: !!alt, diffs: 0, first: null };
        if (alt) {
            for (let f = 0; f < rows && d.diffs < 4096; f += 1) {
                for (let k = 3; k < STATION_ROW; k += 1) {
                    const i = f * STATION_ROW + k;
                    if (data[i] !== alt[i]) {
                        d.diffs += 1;
                        if (!d.first) {
                            d.first = `row ${f} column ${k}: ${data[i]} against ${alt[i]}`;
                        }
                    }
                }
            }
        }
        window.__stationRowDiff = d;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    const maxW = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
    const mkTex = (floats, texels) => {
        const w = Math.min(maxW, Math.max(1, texels));
        const h = Math.ceil(texels / w);
        const padded = new Float32Array(w * h * 4);
        padded.set(floats.subarray(0, Math.min(floats.length, w * h * 4)));
        const t = stationTexture(padded, w, h);
        // ...and KEEP the padded copy. updateStations allocates exactly this
        // array on the first fast frame and holds it from then on, so nothing
        // is added at the peak - what changes is that the two paths leave the
        // same thing behind. Dropped here, `stationPad` was empty on any mesh
        // that had never taken the fast path, which is every mesh a probe
        // builds and reads in one step: tests/ss_axis.py read zero floats of
        // geometry across a letter change and could not tell that from a
        // change that did nothing.
        return { tex: t, w, h, pad: padded };
    };
    const st = mkTex(mesh.stations, mesh.stationCount * 4);
    const pc = mkTex(mesh.pieces, Math.max(1, mesh.pieceCount * 2));
    return {
        buf, count: rows,
        // 🔴 COPIES, NOT THE VIEWS HANDED IN. stationMeshOf writes into buffers
        // it reuses every frame, so keeping its subarrays here would mean the
        // "installed" mapping was overwritten by the next capture - and
        // updateStations would then compare the new mapping against itself and
        // agree with everything, which is the one thing it exists not to do.
        faceStation: new Float32Array(mesh.faceStation),
        facePiece: new Float32Array(mesh.facePiece),
        // ...and the SURFACE, which stationsMatch does not need - a face that
        // kept its station and its piece kept its surface too - but a splice
        // does: it is what says a face at the end of the new list is the same
        // face as the one at the end of the old, rather than a different
        // surface of the same station. See stationSplicePlan.
        faceSurf: new Float32Array(mesh.faceSurf),
        // ...and the static row itself, because the OUTWARD normal an edge
        // carries flips with the face's `top` flag and that flag lives here.
        rows: data,
        stations: new Float32Array(mesh.stations),
        stationTex: st.tex, stationW: st.w, stationPad: st.pad,
        pieceTex: pc.tex, pieceW: pc.w, piecePad: pc.pad,
        stationCount: mesh.stationCount, pieceCount: mesh.pieceCount,
        bytes: data.byteLength + mesh.stations.byteLength + mesh.pieces.byteLength,
    };
}

/**
 * THE STATION TABLE FOR THIS FRAME, captured the way the mesh is.
 *
 * 🔴 THE CAPTURE HAS TO BE captureFrom AND NOT A HAND-ROLLED ONE. It does more
 * than set the probes: it turns off view culling and the clip slab, and it
 * gives flat pieces a real thickness (cartoonGpuRibbonThick, and a richardson
 * helix its own floor) because a zero-thickness solid has no outward direction.
 * A table captured without those describes a slightly different ribbon, and
 * installing one convention while updating in the other drew 8.6% of the pixels
 * differently at worst 224 - a whole silhouette's width of outline, from two
 * captures that both looked correct on their own.
 *
 * So there is one way to build a station table, and this is it.
 */
function stationMeshNow(renderer, w, h, colors) {
    currentModelCenter = modelCenterOf(renderer);
    currentCapCentre = viewSpanOf(renderer).centre;
    // 🔴 THE ROTATED COORDINATES FIRST, AND THIS IS NOT OPTIONAL. The renderer
    // skips its rotation loop whenever it expects the GPU to take the frame, so
    // on a steady frame rotatedCoords belongs to whenever it was last needed -
    // and captureFrom runs the whole 2D renderer, which is built on it. The
    // rebuild path settles this debt before capturing and says so in a comment;
    // the fast path did not, and captured the PREVIOUS frame's geometry. It
    // drew a perfectly good ribbon one step behind: 8.6% of pixels, worst 224,
    // stable to four digits across runs because it was not noise at all.
    if (typeof renderer._ensureRotated === 'function') renderer._ensureRotated();
    // 🔴 THE MESH'S OWN COLOURS BY DEFAULT. captureFrom reads one per position
    // and dereferences it without asking, so a caller with nothing to say about
    // colour has to be given the array the resident mesh was built with rather
    // than null - which crashes inside drawRun, four frames from the call.
    const cap = captureFrom(renderer, w, h, colors || appColors);
    if (!cap || !cap.prims) {
        stationRefusal = 'the capture returned no prims';
        return null;
    }
    // ...kept for the rebuild that may follow this one. See heldCapture.
    // 🔴 AND A PROBE CAN DROP IT, so tests/capture_once.py can watch itself
    // fail: without the held capture the rebuild takes its own, which is the
    // second 2D pass that gate exists to forbid. Off in every build but the
    // probe's.
    heldCapture = window.__noHeldCapture ? null : cap;
    // ...and the centre line lands where every other consumer reads it, so the
    // selection halo follows this frame rather than the last one.
    if (typeof renderer._storeRibbonTrace === 'function') {
        renderer._storeRibbonTrace(cap.trace);
    }
    return stationMeshFrom(renderer, cap);
}

/**
 * THE STATION MESH FROM A CAPTURE SOMEONE ELSE ALREADY PAID FOR.
 *
 * Split out of stationMeshNow so the rebuild path can use it: on the frame that
 * INSTALLS the table there is no fast-path mesh to inherit, and capturing again
 * to build one is the third capture of the same frame. The rebuild has the
 * prims in its hand - this turns them into a table without touching the 2D pass.
 *
 * 🔴 IT DOES NOT STORE THE TRACE. Both callers do that themselves, and doing it
 * here as well would store it twice on the rebuild path.
 */
function stationMeshFrom(renderer, cap, optCentre) {
    const liveC = (typeof renderer._computeViewCentre === 'function'
        ? renderer._computeViewCentre(renderer.objectsData[renderer.currentObjectName])
        : null) || viewSpanOf(renderer).centre;
    const centre = optCentre || (resident && resident.capCentre) || modelCenterOf(renderer);
    const mesh = stationMeshOf(cap.prims, renderer._ribbonTrace || [],
        renderer.viewerState.rotation, centre,
        renderer.cartoonRichardson === true, liveC);
    // ...and THIS FRAME'S drawn positions travel with it. The capture already
    // produced them; without carrying them over, the overlay - halo, picking,
    // Orient - keeps projecting the frame the mesh was built at.
    if (mesh) mesh.pos = cap.pos;
    // ...and the prims themselves, for the parts the station table does NOT
    // describe. stationMeshOf only reads the rib ones and does not consume the
    // array, so the sticks are still in it and refreshSticksFrom rebuilds them
    // from here rather than running a second capture.
    if (mesh) mesh.prims = cap.prims;
    // 🔴 WHY, WHEN IT IS NOTHING. Returning null and leaving the reason unset
    // meant a silent fall-back: the path simply never engaged and the only
    // symptom was that it was not faster. The three ways to get nothing are all
    // different problems.
    if (!mesh) {
        const ribs = cap.prims.filter((q) => q && q.kind === 'rib' && q.Lp).length;
        const trace = renderer._ribbonTrace;
        stationRefusal = `no station table: ${cap.prims.length} prims,`
            + ` ${ribs} of them ribbon, trace ${trace ? trace.length : 'absent'}`
            + ` (coords ${renderer.coords ? renderer.coords.length : 0};`
            + ' the trace is capped at 20000 by _wantRibbonTrace)';
    }
    return mesh;
}

/**
 * Build the station resources and hand them to the draw path.
 *
 * Separate from makeResidentStations so a caller can build a table without
 * installing it - which is what tests/station_corners.py does, and what any
 * comparison of the two paths needs.
 */
function installStations(mesh, fill) {
    clearResidentStations();
    stationRefusal = null;
    // 🔴 THE TABLE HAS TO COVER EVERY FACE THE MESH HOLDS, and on a nucleosome
    // it does not. stationMeshOf walks `rib` prims; base plates, ligands and
    // contacts are the OTHER group and arrive as faces with no station behind
    // them. Drawing 15,216 instances where the mesh holds 17,558 loses the
    // plates - measured on 1AOI as 14.5% of the frame inked against 13.6% - and
    // a path that quietly drops a whole class of geometry is worse than one
    // that declines.
    //
    // Declining is right for now and not forever: makeResident already keeps
    // the three groups apart, so the ribbon can be drawn from stations and the
    // rest from its rows in a second pass. Until that exists, this says no and
    // says why.
    // 🔴 THE TABLE COVERS A PREFIX, NOT NECESSARILY THE WHOLE MESH, and that is
    // the difference between working on real structures and not. stationMeshOf
    // walks `rib` prims; base plates, ligands, contacts and lone atoms are the
    // OTHER groups, and makeResident concatenates them AFTER the ribbon. So the
    // ribbon is instances [0, count) and the rest is [count, resident.count),
    // and drawResident issues one draw for each.
    //
    // Refusing on any mismatch was the first cut, and on a 10,000-residue chain
    // it cost the whole path for ONE face: 139,622 described against 139,623
    // held. A stray lone atom should not decide whether a trajectory animates.
    // ...counted from whichever source the rows will come from. An empty fill
    // means the ribbon's rows were never built (see makeResident), and the face
    // list is then what has to cover the table.
    const rows = (fill && fill.length) ? Math.floor(fill.length / 48)
        : (stationFillFaces ? stationFillFaces.length : 0);
    if (!mesh || !mesh.faceCount || mesh.faceCount > rows) {
        stationRefusal = `the station table describes ${mesh ? mesh.faceCount : 0}`
            + ` faces and the mesh holds ${rows} - it cannot cover more than the`
            + ' mesh, so this is a table for a different structure';
        return false;
    }
    residentStations = makeResidentStations(mesh, fill);
    if (residentStations) residentStations.stale = false;
    // WHICH PRIMS THE TABLE COULD NOT DESCRIBE, kept for the same reason
    // stationDecline is: a prefix that stops short blocks the fast path for the
    // whole structure, and "9 rows in the tail" is not an answer until it says
    // which of the three ways a prim can fail to yield stations it was.
    lastMeshMissing = mesh.missingWhy
        ? Object.assign({ total: mesh.missing }, mesh.missingWhy) : null;
    return !!residentStations;
}

/**
 * THE OUTLINE, MOVED WITH THE STATIONS.
 *
 * The ink pass draws each edge as an instance carrying its two endpoints and
 * its two adjacent faces' normals, all in model space. Every one of those
 * twelve floats is geometry, so on a trajectory they belong to whatever frame
 * the mesh was built for - which is why the fast path used to decline whenever
 * outlines were on: the ribbon moved and its outline stayed, 5.4% of the pixels
 * at a worst channel of 224.
 *
 * The edge pass records where each row came from (see E_I): the two endpoint
 * corners as fi*12 + corner*3, and the two faces whose normals it holds. That
 * is enough to rewrite the twelve floats from a station table without running
 * the hash, the adjacency or the crease test again.
 *
 * 🔴 WHAT IS NOT REDONE IS THE CLASSIFICATION. Whether an edge is a boundary or
 * a crease was decided at build time from the angle between its two faces, and
 * that angle moves a little with the geometry. Recomputing it would let edges
 * appear and disappear between frames, which is a change of topology and
 * exactly what this path exists to avoid; keeping it is the same approximation
 * as keeping the piece cuts. It holds while the fold does - which is the
 * condition the whole path already asks for.
 *
 * 🔴 AND A CONTACT HAS NO SOURCE. Contacts ride through the same instance
 * buffer as annotations with their own endpoints and no face behind them; their
 * provenance is -1 and they are left exactly as they were.
 */
// IS THE PIECE THIS FACE BELONGS TO A RICHARDSON STRAND, THIS FRAME? The piece
// row's spare slot carries the letter-dependent flags, rewritten from the prims
// every frame: bit 1 the two-tone candidate, bit 2 the pale side, bit 4 exactly
// `rich && ss === 'E'`, which is what fullOutline asks.
function pieceIsStrand(mesh, face) {
    if (!mesh || !mesh.facePiece || !mesh.pieces) return false;
    if (!(face >= 0) || face >= mesh.facePiece.length) return false;
    const pid = mesh.facePiece[face];
    if (!(pid >= 0)) return false;
    const at = pid * 8 + 7;
    return at < mesh.pieces.length && (Math.round(mesh.pieces[at]) & 4) !== 0;
}

function refreshEdgesFromStations(mesh) {
    // ...and what it cost, because this pass is a per-frame walk of every edge
    // row and a profile of a step puts a fifth of itself in here. Two clock
    // reads a frame; `lastEdgeRefresh.ms` is where a probe finds it.
    const __t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    lastEdgeRefresh = {why: null, rows: 0, touched: 0, ms: 0};
    if (!gl || !residentEdges || !residentStations || !mesh) {
        lastEdgeRefresh.why = !residentEdges ? 'no residentEdges'
            : !residentStations ? 'no residentStations' : 'no gl or mesh';
        return false;
    }
    const { ed, edSrc } = residentEdges;
    if (!ed || !edSrc) { lastEdgeRefresh.why = 'no ed or edSrc'; return false; }
    const st = mesh.stations;
    const rows = ed.length / ED_FLOATS;
    lastEdgeRefresh.rows = rows;
    if (edSrc.length < rows * ED_SRC) {
        lastEdgeRefresh.why = `edSrc holds ${edSrc.length} for ${rows} rows`;
        return false;
    }
    // The four corner curves, as signs on the width and thickness axes, in the
    // order facesOf pushes them: q = [A[k], B[k], B[k+1], A[k+1]].
    const cornerOf = (face, idx, out) => {
        const surf = mesh.faceSurf[face];
        if (surf === 6) {
            const o = mesh.faceStation[face] * 16 + idx * 4;
            out[0] = st[o];
            out[1] = st[o + 1];
            out[2] = st[o + 2];
            return;
        }
        // ...the signs and which station, straight out of CORNER_SW/SG/DK
        const t = surf * 4 + idx;
        const sw = CORNER_SW[t]; const sg = CORNER_SG[t];
        const o = (mesh.faceStation[face] + CORNER_DK[t]) * 16;
        const hw = st[o + 3]; const ht = st[o + 7];
        out[0] = st[o] + st[o + 8] * hw * sw + st[o + 4] * ht * sg;
        out[1] = st[o + 1] + st[o + 9] * hw * sw + st[o + 5] * ht * sg;
        out[2] = st[o + 2] + st[o + 10] * hw * sw + st[o + 6] * ht * sg;
    };
    // ...and every face's OUTWARD normal, in one pass, before the rows that
    // read them.
    //
    // 🔴 OUTWARD, WHICH IS NOT THE SHADING NORMAL. A broad face's two sides
    // share one ub and are told apart by the `top` flag - the fill shader does
    // exactly this, and an edge carries f._outN, which is the same vector. Left
    // unflipped, half the surface edges hand the silhouette test a normal
    // pointing into the solid: the rule reproduces every POSITION to 3.7e-06 A
    // and still draws the wrong outline, which is why the self-check had to
    // cover the normals too.
    const faceCount = Math.min(residentStations.count,
        mesh.faceSurf.length, mesh.faceStation.length);
    const stationN = residentStations.stationCount || 0;
    if (!edgeNormals || edgeNormalOk.length < faceCount) {
        edgeNormals = new Float32Array(faceCount * 3);
        edgeNormalOk = new Uint8Array(faceCount);
    }
    {
        const srows = residentStations.rows;
        for (let f = 0; f < faceCount; f += 1) {
            const surf = mesh.faceSurf[f];
            const o = mesh.faceStation[f] * 16;
            const b = f * 3;
            if (surf === 4) {
                edgeNormals[b] = -st[o + 12];
                edgeNormals[b + 1] = -st[o + 13];
                edgeNormals[b + 2] = -st[o + 14];
                edgeNormalOk[f] = 1;
                continue;
            }
            if (surf === 5) {
                edgeNormals[b] = st[o + 12];
                edgeNormals[b + 1] = st[o + 13];
                edgeNormals[b + 2] = st[o + 14];
                edgeNormalOk[f] = 1;
                continue;
            }
            if (surf === 6) {
                const v1x = st[o + 4] - st[o];
                const v1y = st[o + 5] - st[o + 1];
                const v1z = st[o + 6] - st[o + 2];
                const v2x = st[o + 8] - st[o];
                const v2y = st[o + 9] - st[o + 1];
                const v2z = st[o + 10] - st[o + 2];
                const nx = v1y * v2z - v1z * v2y;
                const ny = v1z * v2x - v1x * v2z;
                const nz = v1x * v2y - v1y * v2x;
                const nl = Math.hypot(nx, ny, nz) || 1;
                edgeNormals[b] = nx / nl;
                edgeNormals[b + 1] = ny / nl;
                edgeNormals[b + 2] = nz / nl;
                edgeNormalOk[f] = 1;
                continue;
            }
            if (surf === 7) {
                edgeNormals[b] = st[o + 4]; edgeNormals[b + 1] = st[o + 5]; edgeNormals[b + 2] = st[o + 6];
                edgeNormalOk[f] = 1;
                continue;
            }
            if (surf === 8) {
                edgeNormals[b] = -st[o + 8]; edgeNormals[b + 1] = -st[o + 9]; edgeNormals[b + 2] = -st[o + 10];
                edgeNormalOk[f] = 1;
                continue;
            }
            if (surf === 9) {
                edgeNormals[b] = -st[o + 4]; edgeNormals[b + 1] = -st[o + 5]; edgeNormals[b + 2] = -st[o + 6];
                edgeNormalOk[f] = 1;
                continue;
            }
            if (surf === 10) {
                edgeNormals[b] = st[o + 8]; edgeNormals[b + 1] = st[o + 9]; edgeNormals[b + 2] = st[o + 10];
                edgeNormalOk[f] = 1;
                continue;
            }
            if (surf > 10) { edgeNormalOk[f] = 0; continue; }
            const broad = surf < 2;
            const sideSign = (surf === 2) ? -1 : 1;
            const top = srows ? srows[f * STATION_ROW + 7] : 1;
            const flip = (broad && top < 0.5) ? -1 : 1;
            for (let a = 0; a < 3; a += 1) {
                edgeNormals[b + a] = (broad ? st[o + 4 + a] : -st[o + 8 + a] * sideSign) * flip;
            }
            edgeNormalOk[f] = 1;
        }
    }
    const pa = [0, 0, 0]; const pb = [0, 0, 0];
    // WHICH ROWS ARE A STRIP'S CROSS EDGE WITH ONLY ONE FACE BEHIND THEM.
    // Collected here and settled in a second pass, because the question they
    // ask is about the OTHER rows and those are not all written yet.
    if (!oneSided || oneSided.length < rows) {
        oneSided = new Int32Array(rows);
        oneSidedAt = new Int32Array(rows);
        allRowNext = new Int32Array(rows);
    }
    if (!allRowHead || allRowHead.length < stationN + 2) {
        allRowHead = new Int32Array(stationN + 2);
    }
    allRowHead.fill(-1, 0, stationN + 2);
    let oneSidedN = 0;
    let touched = 0;
    let worstMoved = 0;
    let alwaysMoved = 0;
    const selfCheck = (typeof window !== 'undefined') && !!window.__edgeSelfCheck;
    for (let r = 0; r < rows; r += 1) {
        const oa = edSrc[r * ED_SRC];
        if (oa < 0) continue;                       // a contact, not a surface edge
        const ob = edSrc[r * ED_SRC + 1];
        const fa = edSrc[r * ED_SRC + 2];
        const fb = edSrc[r * ED_SRC + 3];
        const nCount = edSrc[r * ED_SRC + 4];
        const cCosM = edSrc[r * ED_SRC + 5];
        const byLetter = edSrc[r * ED_SRC + 6] > 0;
        const faceA = (oa / 12) | 0;
        const faceB = (ob / 12) | 0;
        if (faceA >= faceCount || faceB >= faceCount) continue;
        cornerOf(faceA, ((oa % 12) / 3) | 0, pa);
        cornerOf(faceB, ((ob % 12) / 3) | 0, pb);
        const base = r * ED_FLOATS;
        // 🔴 THE SELF-CHECK IS OFF UNLESS ASKED FOR. `worstMoved` is how far
        // this rule moved what the edge pass had written, and it is only
        // MEANINGFUL at install - refreshed against the very mesh it was built
        // from it must be zero, and on any other frame it is whatever the
        // geometry moved. It was being computed on every row of every frame: six
        // reads, six absolute values and six comparisons a row, 15,688 rows on
        // 1TIM, for a number nothing reads unless a probe asks. `window
        // .__edgeSelfCheck = 1` turns it back on.
        if (selfCheck) {
            for (let a = 0; a < 3; a += 1) {
                const d0 = Math.abs(ed[base + a] - pa[a]);
                const d1 = Math.abs(ed[base + 3 + a] - pb[a]);
                if (d0 > worstMoved) worstMoved = d0;
                if (d1 > worstMoved) worstMoved = d1;
            }
        }
        ed[base] = pa[0]; ed[base + 1] = pa[1]; ed[base + 2] = pa[2];
        ed[base + 3] = pb[0]; ed[base + 4] = pb[1]; ed[base + 5] = pb[2];
        if (fa >= 0 && fa < faceCount && edgeNormalOk[fa]) {
            const b = fa * 3;
            if (selfCheck) {
                for (let a = 0; a < 3; a += 1) {
                    const d = Math.abs(ed[base + 6 + a] - edgeNormals[b + a]);
                    if (d > worstMoved) worstMoved = d;
                }
            }
            ed[base + 6] = edgeNormals[b];
            ed[base + 7] = edgeNormals[b + 1];
            ed[base + 8] = edgeNormals[b + 2];
        }
        if (fb >= 0 && fb < faceCount && edgeNormalOk[fb]) {
            const b = fb * 3;
            if (selfCheck) {
                for (let a = 0; a < 3; a += 1) {
                    const d = Math.abs(ed[base + 9 + a] - edgeNormals[b + a]);
                    if (d > worstMoved) worstMoved = d;
                }
            }
            ed[base + 9] = edgeNormals[b];
            ed[base + 10] = edgeNormals[b + 1];
            ed[base + 11] = edgeNormals[b + 2];
        }
        // 🔴 AND THE CREASE TEST IS REDONE, because the angle between two faces
        // moves with them. A boundary is topological - fewer than two incident
        // faces - and keeps whatever it was given; a crease is an angle, and
        // frozen at the build frame it draws a line where the surfaces have
        // since flattened, or drops one where they have folded. It was 0.0624%
        // of the pixels at a worst channel of 86: a handful of outline segments
        // flickering on and off through an animation.
        //
        // The edge SET does not change - only this flag - so the topology the
        // whole path depends on is untouched.
        // 🔴 AND THE THRESHOLD FOLLOWS THE LETTER, THIS FRAME. A strand's
        // broad face and its pale side meet at 90 degrees and that corner has
        // to be inked; a loop bends a few degrees between stations and must not
        // be. Which rule applies is therefore a question about the letter, and
        // the letter moves - so it is asked here rather than baked. `cCosM` is
        // the look's plain threshold, or -1 where the plain rule is off.
        const richNow = edgeRichPreset
            && ((fa >= 0 && pieceIsStrand(mesh, fa)) || (fb >= 0 && pieceIsStrand(mesh, fb)));
        const cM = richNow ? RICH_CREASE_M : cCosM;
        // 🔴 AND "NO RULE" IS A VERDICT, NOT A REASON TO KEEP THE OLD ONE.
        // This was gated on `cCosM >= 0`, so an edge whose crease rule is off
        // this frame was simply not revisited and kept whatever the build
        // frame decided - which for a residue that WAS a strand is 2, an inked
        // crease, on a loop. The rule being off means there is no crease here;
        // that is 0, and it has to be written.
        if (nCount >= 2) {
            const was = ed[base + 12];
            let now = 0;
            if (cM >= 0) {
                const d2 = Math.abs(ed[base + 6] * ed[base + 9]
                    + ed[base + 7] * ed[base + 10] + ed[base + 8] * ed[base + 11]);
                now = (d2 < cM / 1e6) ? 2 : 0;
            }
            if (was !== now) alwaysMoved += 1;
            ed[base + 12] = now;
        }
        // 🔴 AND A CROSS EDGE IS DECIDED BY THE LETTER, THIS FRAME. A
        // Richardson strand draws the crease between its broad face and its
        // pale side; a loop does not, and used to say so by not having a row at
        // all - so a residue becoming a strand changed the edge SET, which is a
        // rebuild. The row exists either way now and this turns it on and off:
        // -1 is clipped in the vertex shader before it costs a fragment.
        //
        // EITHER piece, because the row is welded from two faces and the bit
        // was OR'd across them at build - a cross edge between a strand's last
        // face and the loop's first belongs to the strand.
        if (byLetter) {
            const strand = (fa >= 0 && pieceIsStrand(mesh, fa))
                || (fb >= 0 && pieceIsStrand(mesh, fb));
            const was2 = ed[base + 12];
            const now2 = strand ? (ed[base + 12] < 0 ? 2 : ed[base + 12]) : -1;
            if (was2 !== now2) alwaysMoved += 1;
            ed[base + 12] = now2;
            // ...and the one-sided ones are looked at again below, once every
            // row's geometry for this frame is written.
            if (nCount < 2) {
                const ia = ((oa % 12) / 3) | 0;
                oneSidedAt[oneSidedN] = mesh.faceStation[faceA]
                    + CORNER_DK[mesh.faceSurf[faceA] * 4 + ia];
                oneSided[oneSidedN++] = r;
            }
        }
        // ...and every row is filed under its face's station, so a lone edge can
        // find whatever else lies where it does without comparing itself
        // against all seven thousand.
        {
            const st0 = mesh.faceStation[faceA];
            if (st0 >= 0 && st0 < stationN) {
                allRowNext[r] = allRowHead[st0]; allRowHead[st0] = r;
            } else { allRowNext[r] = -1; }
        }
        touched += 1;
    }
    // 🔴 A LONE CROSS EDGE ASKS WHETHER THE OTHER SLAB HAS ARRIVED, THIS FRAME.
    //
    // A strip's cross edge gets two incident faces only where the two slabs'
    // corners COINCIDE, because the edge table is keyed by position. A piece
    // boundary normally carries a real gap - measured over every lone cross
    // edge on _traj_3ptb.pdb, the nearest opposing row is 0.08 to 0.73 A away,
    // median 0.25 - so the slab really does step and the line at the shoulder
    // is right. One face means boundary, and a boundary is drawn.
    //
    // The letter can close that gap. When the loop between two strands becomes
    // a strand the two halves land on each other, the surface is continuous,
    // and the line should go - but the verdict was baked at build and the crease
    // test cannot revisit it, being gated on having two faces. That is a line
    // across a merged sheet, at the gap that closed.
    //
    // So ask the build's own question again, against this frame's geometry: is
    // there another row in the same place? Zero against a median of 0.25 A is
    // not a close call, and only the lone cross edges are compared - 240 of
    // 7,016 rows here - so the pass is a few thousand distance tests and no
    // allocation.
    if (oneSidedN > 0) {
        const TOL = 0.02;
        // 🔴 BUCKETED BY STATION, because a pair that coincides is a pair at a
        // piece boundary and the two halves are one station apart - so the
        // candidates for a row at station S are the lone rows at S-1, S and
        // S+1, and never the whole list. Comparing every lone row against every
        // other is 228 of them on _traj_3ptb.pdb and fine; it is quadratic, and
        // the count follows the number of secondary-structure elements, so a
        // thousand-residue cartoon would pay for it.
        for (let x = 0; x < oneSidedN; x += 1) {
            const rx = oneSided[x]; const bx = rx * ED_FLOATS;
            if (ed[bx + 12] < 0) continue;              // already clipped
            const at = oneSidedAt[x];
            let found = false;
            for (let dz = -2; dz <= 2 && !found; dz += 1) {
                const cell = at + dz;
                if (cell < 0 || cell >= stationN) continue;
                for (let ry = allRowHead[cell]; ry >= 0; ry = allRowNext[ry]) {
                if (ry === rx) continue;
                const by = ry * ED_FLOATS;
                // either orientation - the two halves are wound opposite ways
                const s0 = Math.max(
                    Math.abs(ed[bx] - ed[by]), Math.abs(ed[bx + 1] - ed[by + 1]),
                    Math.abs(ed[bx + 2] - ed[by + 2]), Math.abs(ed[bx + 3] - ed[by + 3]),
                    Math.abs(ed[bx + 4] - ed[by + 4]), Math.abs(ed[bx + 5] - ed[by + 5]));
                const s1 = Math.max(
                    Math.abs(ed[bx] - ed[by + 3]), Math.abs(ed[bx + 1] - ed[by + 4]),
                    Math.abs(ed[bx + 2] - ed[by + 5]), Math.abs(ed[bx + 3] - ed[by]),
                    Math.abs(ed[bx + 4] - ed[by + 1]), Math.abs(ed[bx + 5] - ed[by + 2]));
                if (s0 < TOL || s1 < TOL) {
                    ed[bx + 12] = -1; alwaysMoved += 1;
                    found = true; break;
                }
                }
            }
        }
    }
    lastEdgeRefresh.oneSided = oneSidedN;
    lastEdgeRefresh.touched = touched;
    // 🔴 AND HOW FAR IT MOVED WHAT WAS THERE. Refreshed against the very mesh
    // it was built from, this must be zero: the rule reproduces the numbers the
    // edge pass wrote, or it is not the same rule. Any other frame it is
    // whatever the geometry moved, so the check is only meaningful at install -
    // which is exactly where a probe can make it.
    lastEdgeRefresh.worst = worstMoved;
    lastEdgeRefresh.ms = (typeof performance !== 'undefined')
        ? performance.now() - __t0 : 0;
    // ...and how many edges changed class, which at install must be none.
    lastEdgeRefresh.reclassified = alwaysMoved;
    if (!touched) { lastEdgeRefresh.why = 'no row named a source'; return false; }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufInk);
    gl.bufferData(gl.ARRAY_BUFFER, ed, gl.STATIC_DRAW);
    return true;
}

/**
 * NEW GEOMETRY INTO THE SAME TEXTURES, which is the whole point of the exercise.
 *
 * A trajectory step changes where the atoms are and nothing else: the face
 * list, the flags, the colours and the palette are the same, so the instance
 * buffer is untouched and only the two geometry textures are written. That is
 * 35 KB against a 191 KB rebuild on 1UBQ, and no facesOf, no buildMeshPart and
 * no edge table.
 *
 * 🔴 THE SHAPE HAS TO MATCH OR IT IS A DIFFERENT MESH. Same station count, same
 * piece count, same face count - anything else means the topology moved, which
 * is exactly the case a folding trajectory presents, and the
 * caller has to rebuild instead. texSubImage2D into a texture sized for a
 * different structure would draw whatever was left of the old one.
 */
/**
 * DOES THE TABLE STILL DESCRIBE THIS MESH? The comparison half of
 * updateStations, split out because it is PURE and the update is not.
 *
 * 🔴 THE ORDER MATTERS AND IT IS NOT OBVIOUS. refreshSticksFrom runs facesOf
 * and buildMeshPart over every stick in the structure - real work, thousands of
 * rows - and updateStations can refuse afterwards, in which case that work is
 * thrown away and the frame rebuilds anyway. Asking the cheap question first
 * means a structure whose mapping does not hold pays nothing for a path it was
 * never going to take.
 */
/**
 * CAN THIS FRAME'S TABLE BE SPLICED INTO THE LAST ONE'S, AS ONE WINDOW?
 *
 * 🔴 MEASURED, AND THE ANSWER IS USUALLY NO - WHICH IS WHY THIS IS STILL A
 * DIAGNOSTIC AND NOT A PATH. See tests/splice_window.py for the numbers. A
 * step changes several SS runs at once, scattered along the chain, so the
 * first and last changed face are far apart and everything between them falls
 * into one window: on _traj_9fog.pdb the windows are 74-96% of the face list,
 * and on _traj_1tim.pdb they range from 0 faces to 82%. A partial rebuild
 * needs a PIECEWISE decomposition - one window per changed run - which is a
 * different and larger thing, and this is what says so with a number.
 *
 * When the secondary-structure assignment moves a few runs, almost every face
 * keeps its station and its piece and only the ones in those runs change - so
 * the new face list is the old one with a WINDOW replaced and every index after
 * it shifted by a constant. Measured on _traj_9fog.pdb, a step changes a median
 * 22 of 3,348 letters and touches 16 of ~579 runs; on _traj_1tim.pdb a spliced
 * frame was head 6686, window 9, tail 249 of 6944 rows.
 *
 * This decides whether that decomposition exists, and answers null the moment
 * it does not. It compares nothing but the MAPPING - station, surface and piece
 * per face - because that is exactly what stationsMatch refuses on and exactly
 * what the instance buffer holds.
 *
 * @returns {{head:number, prevTo:number, nextTo:number, dStation:number,
 *            dPiece:number}|null} the head is the first face that differs,
 *   prevTo/nextTo the first face of the unchanged tail in each list, and the
 *   two deltas what every tail index shifts by.
 */
let lastSplicePlan = null;

function stationSplicePlan(mesh) {
    if (!residentStations || !mesh) return null;
    const pS = residentStations.faceStation; const nS = mesh.faceStation;
    const pF = residentStations.faceSurf; const nF = mesh.faceSurf;
    const pP = residentStations.facePiece; const nP = mesh.facePiece;
    if (!pS || !nS || !pF || !nF || !pP || !nP) return null;
    const pN = residentStations.count;
    const nN = mesh.faceCount;
    if (!(pN > 0) || !(nN > 0)) return null;

    let head = 0;
    const lim = Math.min(pN, nN);
    while (head < lim && pS[head] === nS[head] && pF[head] === nF[head]
        && pP[head] === nP[head]) head += 1;
    if (head === lim && pN === nN) return null;   // identical: stationsMatch's job

    // 🔴 THE TAIL IS A CONSTANT SHIFT OR IT IS NOT A TAIL. A face after the
    // window keeps its geometry and its surface; what moves is WHICH station
    // and WHICH piece it points at, and that moves by however many stations and
    // pieces the window gained or lost. A tail whose faces shift by different
    // amounts is not a window at all - it is a reordering, and there is nothing
    // to splice.
    let dStation = 0; let dPiece = 0; let tail = 0;
    const room = lim - head;
    while (tail < room) {
        const a = pN - 1 - tail; const b = nN - 1 - tail;
        if (pF[a] !== nF[b]) break;
        const ds = nS[b] - pS[a]; const dp = nP[b] - pP[a];
        if (tail === 0) { dStation = ds; dPiece = dp; }
        else if (ds !== dStation || dp !== dPiece) break;
        tail += 1;
    }
    const plan = { head, prevTo: pN - tail, nextTo: nN - tail, dStation, dPiece,
        prevCount: pN, nextCount: nN };

    // 🔴 THE DECOMPOSITION IS CHECKED, NOT ASSERTED. A plan is only worth
    // anything if replaying it over the OLD mapping reproduces the NEW one
    // exactly - head verbatim, window from the new list, tail shifted by the
    // two deltas - and that is three lines to verify against the arrays both
    // already in hand. A wrong plan is a ribbon made of the wrong slices, which
    // is the fault stationsMatch exists to catch, so it is not left to an
    // argument about how the diff was computed.
    for (let i = 0; i < head; i += 1) {
        if (pS[i] !== nS[i] || pF[i] !== nF[i] || pP[i] !== nP[i]) return null;
    }
    for (let j = 0; j < pN - plan.prevTo; j += 1) {
        const a = pN - 1 - j; const b = nN - 1 - j;
        if (pF[a] !== nF[b] || nS[b] - pS[a] !== dStation
            || nP[b] - pP[a] !== dPiece) return null;
    }
    return plan;
}

function stationsMatch(mesh) {
    lastStationUpdate = null;
    if (!gl || !residentStations || !mesh) { lastStationUpdate = 'no table'; return false; }
    if (mesh.stationCount !== residentStations.stationCount
        || mesh.pieceCount !== residentStations.pieceCount) {
        lastStationUpdate = `${mesh.stationCount}/${mesh.pieceCount} stations and`
            + ` pieces against ${residentStations.stationCount}/`
            + `${residentStations.pieceCount}`;
        return false;
    }
    // 🔴 THE COUNTS AGREEING IS NOT THE MAPPING AGREEING, and that distinction
    // cost two rounds of a probe reporting a fast frame with the wrong picture.
    // geom.js cuts a piece at every ORIENTATION FOLD - where the face or width
    // normal crosses zero - and those follow the geometry, so a cut can MOVE
    // from one station to another while the number of pieces and stations stays
    // exactly the same. The instance buffer still says face f reads station k;
    // it now reads the wrong one, and the frame draws a plausible ribbon made
    // of the wrong slices.
    //
    // Measured on a 30-frame trajectory of 1TIM: frames 4 and 5 matched on
    // every count and drew 7.5% of the pixels differently.
    const a = residentStations.faceStation;
    const b = mesh.faceStation;
    if (!a || !b || a.length !== b.length) {
        lastStationUpdate = `faceStation ${a ? a.length : 'null'} against`
            + ` ${b ? b.length : 'null'}`;
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            lastStationUpdate = `face ${i} of ${a.length} moved from station`
                + ` ${a[i]} to ${b[i]}`;
            return false;
        }
    }
    const pa = residentStations.facePiece;
    const pb = mesh.facePiece;
    for (let i = 0; i < pa.length; i += 1) {
        if (pa[i] !== pb[i]) {
            lastStationUpdate = `face ${i} of ${pa.length} moved from piece`
                + ` ${pa[i]} to ${pb[i]}`;
            return false;
        }
    }
    return true;
}

function updateStations(mesh) {
    if (!stationsMatch(mesh)) return false;
    // 🔴 THE PADDING BUFFER IS KEPT, NOT MADE. A texture row has to be whole, so
    // the data is copied into a w*h*4 array before upload - and allocating that
    // every frame put 8.7% of a step in this one function, plus its share of the
    // collector. It is the same size every frame while the topology holds.
    const put = (tex, w, floats, texels, slot) => {
        const h = Math.ceil(texels / w);
        const need = w * h * 4;
        let padded = residentStations[slot];
        if (!padded || padded.length !== need) {
            padded = new Float32Array(need);
            residentStations[slot] = padded;
        }
        padded.set(floats.subarray(0, Math.min(floats.length, need)));
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, padded);
    };
    put(residentStations.stationTex, residentStations.stationW,
        mesh.stations, mesh.stationCount * 4, 'stationPad');
    put(residentStations.pieceTex, residentStations.pieceW,
        mesh.pieces, Math.max(1, mesh.pieceCount * 2), 'piecePad');
    // ...and, for a probe only, a COPY of what went up. The arrays are
    // subarrays of a scratch buffer that the next capture overwrites, so a
    // reference kept here would compare the next frame with itself - which is
    // the trap residentStations' own comment describes about faceStation.
    if (window.__stationFloatProbe) {
        window.__lastStations = Float32Array.from(mesh.stations);
        window.__lastPieces = Float32Array.from(mesh.pieces);
    }
    // 🔴 A PROBE'S LEVER, AND THE ANSWER IT GAVE. Lane 6 of a station row is
    // `kAvg`, the one float in the row that is geometry rather than topology,
    // and it is written once per BUILD. The station vertex shader is supposed
    // to ignore it - `aK` is substituted for `aKFresh`, read from the piece
    // texture, which IS rewritten every frame. Refreshing lane 6 as well
    // changes nothing, which is what says the substitution reaches every face
    // that reads it; tests/outline_sync.py sets the flag and compares. Kept
    // because the question comes back whenever a lane moves between the row and
    // the piece texture, and it costs one property read a frame while off.
    if (window.__freshKAvg && residentStations.rows && mesh.pieces) {
        const rw = residentStations.rows;
        const pcs = mesh.pieces;
        let moved = 0;
        for (let f = 0; f < residentStations.count; f += 1) {
            const pid = residentStations.facePiece[f];
            const k = pcs[pid * 8 + 3];
            const at = f * STATION_ROW + 6;
            if (rw[at] !== k) { rw[at] = k; moved += 1; }
        }
        if (moved) {
            gl.bindBuffer(gl.ARRAY_BUFFER, residentStations.buf);
            gl.bufferData(gl.ARRAY_BUFFER, rw, gl.DYNAMIC_DRAW);
        }
        window.__freshKAvgMoved = (window.__freshKAvgMoved || 0) + moved;
    }
    // 🔴 AND THE MESH'S BOUNDS MOVE WITH IT. `resident` still holds frame 0's
    // centroids and depth range, and both are read every draw: shadeRange maps
    // depth to shading from the centroids, uZRange from zMin/zMax. Left behind,
    // the whole structure shades as though it were still where it started -
    // 5.4% of the pixels, at a worst channel of 224, from geometry that is
    // otherwise exactly right.
    //
    // The centroids are the four corners averaged, which is the same arithmetic
    // the shader does, on the CPU once a face. srKey is cleared because
    // shadeRange caches on the rotation and the face count, neither of which
    // changes when a trajectory steps.
    // 🔴 >=, NOT ===. This was an equality, so the whole centroid and radius
    // pass was skipped the moment the mesh held anything the table does not
    // describe - which is every structure with a side chain or a ligand
    // showing. The shade range and the depth range then stayed at the build
    // frame, which is the 5.4%-of-pixels fault this comment warns about,
    // reintroduced by the guard meant to protect it. Only the first
    // residentStations.count entries are written here; refreshSticksFrom fills
    // its own spans and reports its own radius, and the two are combined below.
    if (resident && resident.centroids
        && resident.centroids.length >= residentStations.count * 3) {
        // ...and the sticks' own radius, which is computed over geometry this
        // loop never sees. Taking only the ribbon's would shrink the depth
        // range whenever a side chain reaches further out than the backbone.
        const stickRad = (lastStickRefresh && lastStickRefresh.rad) || 0;
        const radius = Math.max(
            stationBoundsInto(mesh, resident.centroids, residentStations.count),
            stickRad);
        resident.zMin = -radius;
        resident.zMax = radius;
        resident.rad = radius;
        srKey = null;
    }
    // ...and the outline moves with the surfaces, or the ribbon steps out of
    // its own edges. See refreshEdgesFromStations for what it can and cannot
    // redo.
    refreshEdgesFromStations(mesh);
    residentStations.stations = new Float32Array(mesh.stations);
    if (window.__edgeTopology) window.__edgeTopologyResult = edgeTopology(mesh);
    residentStations.stale = false;
    return true;
}

/**
 * THE RIBBON'S CENTROIDS AND RADIUS, FROM THE STATION TABLE.
 *
 * 🔴 AND IT IS SHARED WITH THE BUILD FOR A REASON THAT COST AN INVESTIGATION.
 * A build took this from the faces' own corners and a station update took it
 * from the table, and the two agree to about 2.5e-7 - the same 3.7e-06 A the
 * station rule reproduces a corner to. That difference is invisible until you
 * remember what it feeds: uZRange, which maps EVERY vertex's depth. Where two
 * surfaces are coincident - and the two sides of a zero-thickness Richardson
 * helix are exactly that - the depth test picks a different winner, and the
 * reader sees the other side of the slab: the same hue at a different
 * lightness, on a handful of antialiased pixels, on the frames that did not
 * rebuild. tests/outline_sync.py found 8 frames in 20 that way, with every
 * other byte on the card identical.
 *
 * So both paths ask this function, and the answer is the same number.
 */
function stationBoundsInto(mesh, cen, count) {
    {
        const st = mesh.stations;
        let rad = 0;
        for (let f = 0; f < count; f += 1) {
            const k = mesh.faceStation[f];
            const surf = mesh.faceSurf[f];
            const o0 = k * 16;
            if (surf === 6) {
                const c0 = [st[o0], st[o0 + 1], st[o0 + 2]];
                const c1 = [st[o0 + 4], st[o0 + 5], st[o0 + 6]];
                const c2 = [st[o0 + 8], st[o0 + 9], st[o0 + 10]];
                const c3 = [st[o0 + 12], st[o0 + 13], st[o0 + 14]];
                for (let a = 0; a < 3; a += 1) {
                    cen[f * 3 + a] = (c0[a] + c1[a] + c2[a] + c3[a]) * 0.25;
                }
                for (const c of [c0, c1, c2, c3]) {
                    const d = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
                    if (d > rad) rad = d;
                }
                continue;
            }
            const cap = surf === 4 || surf === 5;
            const o1 = cap ? o0 : (k + 1) * 16;
            let sA0; let sA1; let sB0; let sB1;
            if (cap)              { sA0 = 1; sA1 = 1; sB0 = -1; sB1 = -1; }
            else if (surf === 0)  { sA0 = 1; sA1 = 1; sB0 = -1; sB1 = 1; }
            else if (surf === 1)  { sA0 = 1; sA1 = -1; sB0 = -1; sB1 = -1; }
            else if (surf === 2)  { sA0 = 1; sA1 = 1; sB0 = 1; sB1 = -1; }
            else if (surf === 3)  { sA0 = -1; sA1 = 1; sB0 = -1; sB1 = -1; }
            else if (surf === 7)  { sA0 = 1; sA1 = 1; sB0 = -1; sB1 = 1; }
            else if (surf === 8)  { sA0 = -1; sA1 = 1; sB0 = -1; sB1 = -1; }
            else if (surf === 9)  { sA0 = -1; sA1 = -1; sB0 = 1; sB1 = -1; }
            else if (surf === 10) { sA0 = 1; sA1 = -1; sB0 = 1; sB1 = 1; }
            else                  { sA0 = 0; sA1 = 0; sB0 = 0; sB1 = 0; }
            // 🔴 THE RADIUS IS THE FARTHEST CORNER, NOT THE FARTHEST CENTROID
            // COMPONENT. buildMeshPart takes max sqrt(x^2+y^2+z^2) over the
            // corners; a max of |component| over the centroids is a different
            // and smaller number, and it feeds the focal length and the depth
            // range, so the whole frame shades and outlines to a slightly wrong
            // scale. Worth 0.06% of the pixels with outlines on.
            const hwA = st[o0 + 3]; const htA = st[o0 + 7];
            const hwB = st[o1 + 3]; const htB = st[o1 + 7];
            const c0 = [0, 0, 0]; const c1 = [0, 0, 0];
            const c2 = [0, 0, 0]; const c3 = [0, 0, 0];
            for (let a = 0; a < 3; a += 1) {
                const mA = st[o0 + a]; const uA = st[o0 + 4 + a]; const wA = st[o0 + 8 + a];
                const mB = st[o1 + a]; const uB = st[o1 + 4 + a]; const wB = st[o1 + 8 + a];
                c0[a] = mA + wA * hwA * sA0 + uA * htA * sA1;
                c1[a] = mA + wA * hwA * sB0 + uA * htA * sB1;
                c2[a] = mB + wB * hwB * sB0 + uB * htB * sB1;
                c3[a] = mB + wB * hwB * sA0 + uB * htB * sA1;
                cen[f * 3 + a] = (c0[a] + c1[a] + c2[a] + c3[a]) * 0.25;
            }
            for (const c of [c0, c1, c2, c3]) {
                const d = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
                if (d > rad) rad = d;
            }
        }
        return Math.sqrt(rad);
    }
}

/**
 * THE TWO MEASUREMENTS STAGE 2 OF THE EDGE PLAN RESTS ON.
 *
 * The plan replaces the edge table's key - a hash of a corner POSITION - with
 * `station * 4 + variant`, the corner's identity in the station table. Two
 * things have to be true for that to be the same key:
 *
 *   1. NO TWO DISTINCT CORNER IDENTITIES MAY SHARE A POSITION. Where they do,
 *      the position hash welds two faces the integer key would leave apart -
 *      so the integer key would need canonicalising, and that is machinery
 *      worth pricing before it is written. Piece boundaries are the suspect:
 *      a fold cut splits one run into two pieces whose facing stations sit at
 *      the same place.
 *   2. HOW MUCH OF THE ADJACENCY IS STRIP-INTERNAL - an edge shared by two
 *      faces of one piece a station apart, which the topology gives directly -
 *      against found by coincidence. That is what says whether stage 4 can
 *      drop the table or only shrink it.
 *
 * Both are read off the SHIPPED arrays: the station table for the corners, and
 * `edSrc` for the edges, which is the provenance the refresh already draws
 * from. Nothing here is a second implementation of anything - the corner rule
 * is `cornerOf`'s, copied deliberately so that a divergence between them shows
 * up as a coincidence count rather than hiding.
 */
function edgeTopology(mesh) {
    if (!mesh || !residentEdges || !residentStations) return null;
    const st = mesh.stations;
    const FS = mesh.faceStation; const FU = mesh.faceSurf;
    const FP = mesh.facePiece;
    const nF = mesh.faceCount;
    // the corner rule, station and variant - cornerOf's, with the position
    const cornerAt = (face, idx, out) => {
        const k = FS[face]; const surf = FU[face];
        if (surf === 6) {
            const o = k * 16 + idx * 4;
            out[0] = st[o]; out[1] = st[o + 1]; out[2] = st[o + 2];
            return k * 4 + idx;
        }
        const t = surf * 4 + idx;
        const sw = CORNER_SW[t]; const sg = CORNER_SG[t];
        const at = k + CORNER_DK[t];
        const o = at * 16;
        const hw = st[o + 3]; const ht = st[o + 7];
        out[0] = st[o] + st[o + 8] * hw * sw + st[o + 4] * ht * sg;
        out[1] = st[o + 1] + st[o + 9] * hw * sw + st[o + 5] * ht * sg;
        out[2] = st[o + 2] + st[o + 10] * hw * sw + st[o + 6] * ht * sg;
        // the identity: four variants a station, the two signs
        return at * 4 + (sw > 0 ? 0 : 2) + (sg > 0 ? 0 : 1);
    };
    // ...hashed exactly as hashAt does, so this asks the question the edge
    // table actually asks and not a tidier one.
    const p = [0, 0, 0];
    const classes = new Map();       // position hash -> first corner key seen
    const multi = new Map();         // ...and the classes that hold more
    let corners = 0;
    for (let f = 0; f < nF; f += 1) {
        for (let idx = 0; idx < 4; idx += 1) {
            const key = cornerAt(f, idx, p);
            const h = (Math.round(p[0] * 1000) * 73856093
                ^ Math.round(p[1] * 1000) * 19349663
                ^ Math.round(p[2] * 1000) * 83492791) >>> 0;
            corners += 1;
            const had = classes.get(h);
            if (had === undefined) { classes.set(h, key); continue; }
            if (had === key) continue;
            let sset = multi.get(h);
            if (!sset) { sset = new Set([had]); multi.set(h, sset); }
            sset.add(key);
        }
    }
    // ...and WHICH piece each station belongs to, so a coincidence can be told
    // apart from a fold-back inside one piece. A rib face at station k spans k
    // and k+1 and names its own piece, so the faces are the mapping.
    const stationPiece = new Map();
    for (let f = 0; f < nF; f += 1) {
        stationPiece.set(FS[f], FP[f]);
        if (FU[f] < 4) stationPiece.set(FS[f] + 1, FP[f]);
    }
    let crossStation = 0; let crossVariant = 0;
    let crossPiece = 0; let withinPiece = 0;
    for (const sset of multi.values()) {
        const stations = new Set();
        const pieces = new Set();
        for (const key of sset) {
            const k = (key / 4) | 0;
            stations.add(k); pieces.add(stationPiece.get(k));
        }
        if (stations.size > 1) {
            crossStation += 1;
            if (pieces.size > 1) crossPiece += 1; else withinPiece += 1;
        } else crossVariant += 1;
    }

    // ---- and what the edges are made of -------------------------------
    const { edSrc } = residentEdges;
    const rows = residentEdges.ed.length / ED_FLOATS;
    let internal = 0; let boundaryEdge = 0; let other = 0; let contacts = 0;
    for (let r = 0; r < rows; r += 1) {
        const oa = edSrc[r * 6];
        if (oa < 0) { contacts += 1; continue; }
        const fa = edSrc[r * 6 + 2];
        const fb = edSrc[r * 6 + 3];
        if (fa < 0 || fb < 0) { boundaryEdge += 1; continue; }
        // ...and an edge whose faces are past the table is a TAIL edge - a
        // side chain, a ligand, a lone atom. The table covers the ribbon part
        // only, and those faces have no station at all, so they are neither
        // internal nor a failure of the topology.
        if (fa >= nF || fb >= nF) { other += 1; continue; }
        const sameP = FP[fa] === FP[fb];
        const dk = Math.abs(FS[fa] - FS[fb]);
        const rib = FU[fa] < 4 && FU[fb] < 4;
        if (sameP && rib && dk <= 1) internal += 1; else other += 1;
    }
    return {
        faces: nF, corners, classes: classes.size,
        coincident: multi.size, crossStation, crossVariant,
        crossPiece, withinPiece, pieces: mesh.pieceCount,
        stations: mesh.stationCount,
        rows, internal, boundaryEdge, other, contacts,
    };
}

/**
 * THE STICKS, REBUILT AND WRITTEN BACK OVER THEIR OWN SPANS.
 *
 * A station table describes rib prims. Everything else is a stick - side
 * chains, ligands, contacts, lone atoms - and a stick has no station: it is two
 * endpoints and a radius, not a swept slab, so there is nothing for the station
 * shader to interpolate. Those rows used to be issued from the buffer exactly
 * as they were built, which drew them at the frame the mesh was built for:
 * 1.53% of the frame on 1TIM with 74 side chains showing, standing still while
 * the backbone moved.
 *
 * So they are rebuilt, and only they. makeResident keeps three parts - ribbon,
 * other sticks, side chains - and installParts now records where each landed.
 * This runs facesOf and buildMeshPart over the NON-RIB prims alone and writes
 * the two stick parts back over their spans, skipping everything a rebuild
 * would also redo: the ribbon's faces and mesh, the ribbon hash, the edge
 * adjacency and crease pass, and the reallocation of every buffer.
 *
 * 🔴 IT IS ALL-OR-NOTHING, AND IT VALIDATES BEFORE IT WRITES. A span is only
 * usable while the part's size is unchanged; a side chain appearing would move
 * every offset after it. Both parts are built and checked before either is
 * uploaded, so a refusal leaves the buffers exactly as they were and the caller
 * can fall back to a full rebuild with nothing half-written.
 *
 * 🔴 AND THE TABLE MUST COVER EXACTLY THE FIRST PART. The tail is assumed to be
 * the two stick parts and nothing else; if the station table covers fewer faces
 * than part 0 holds - a piece that yielded nothing, a prim with no frame - then
 * leftover ribbon faces are in the tail too, the spans no longer describe what
 * is there, and this declines rather than writing over the wrong rows.
 */
function refreshSticksFrom(prims, scale, prm) {
    lastStickRefresh = { why: null, rows: 0, edges: 0 };
    if (!gl || !resident || !residentPartSpans || residentPartSpans.length < 3) {
        lastStickRefresh.why = 'no part spans';
        return false;
    }
    if (!residentStations || residentStations.count !== residentPartSpans[0].count) {
        lastStickRefresh.why = `stations cover ${residentStations
            ? residentStations.count : 0} faces and the ribbon part holds`
            + ` ${residentPartSpans[0].count} - the tail is not just sticks`;
        return false;
    }
    const P0 = prm || defaultParams();
    const rest = [];
    for (const q of prims) {
        if (q && !(q.kind === 'rib' && q.Lp) && !(q.kind === 'stickFace' && q.stA) && !(q.kind === 'joint' && q.pts)) rest.push(q);
    }
    // consume:false - the caller's prim list is still the station table's
    const built = facesOf(rest, P0, false);
    const groups = [[], [], []];
    for (const f of built.faces) groups[faceGroup(f)].push(f);
    // A face from a non-rib prim that still claims part 0 would belong to the
    // one part this cannot rewrite. faceGroup sends a lone atom's disc to part
    // 1, which is what used to land here, so this is now a guard against a new
    // prim kind rather than an expected outcome - and it still declines rather
    // than writing over the wrong rows.
    if (groups[0].length) {
        lastStickRefresh.why = `${groups[0].length} non-stick faces came from`
            + ' prims the station table does not cover';
        return false;
    }
    const made = [];
    for (let g = 1; g <= 2; g += 1) {
        const span = residentPartSpans[g];
        const part = buildMeshPart(groups[g], scale, P0, g === 1 ? built.lines : null);
        const eLen = part.edges ? part.edges.length : 0;
        if (part.fill.length !== span.fillLen || eLen !== span.edgeLen
            || part.centroids.length !== span.cenLen) {
            lastStickRefresh.why = `part ${g} rebuilt to ${part.fill.length / 48}`
                + ` rows and ${eLen / ED_FLOATS} edges, against`
                + ` ${span.fillLen / 48} and ${span.edgeLen / ED_FLOATS}`;
            return false;
        }
        made.push({ span, part });
    }
    // ...nothing above has written anything. From here it all lands.
    let rad = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf3);
    for (const { span, part } of made) {
        gl.bufferSubData(gl.ARRAY_BUFFER, span.fillAt * 4, part.fill);
        // the shade range is measured off these, so they move with the geometry
        if (resident.centroids && resident.centroids.length >= span.cenAt + span.cenLen) {
            resident.centroids.set(part.centroids, span.cenAt);
        }
        if (part.rad > rad) rad = part.rad;
        lastStickRefresh.rows += part.fill.length / 48;
        // 🔴 THE OUTLINE GOES INTO THE KEPT ARRAY AS WELL AS THE BUFFER.
        // refreshEdgesFromStations rewrites the ribbon's edges in residentEdges.ed
        // and then uploads the WHOLE array - so a stick edge written only to the
        // card is overwritten by the stale copy a moment later, and the side
        // chains keep their old outline while their fills move.
        if (part.edges && part.edges.length) {
            if (residentEdges && residentEdges.ed
                && residentEdges.ed.length >= span.edgeAt + span.edgeLen) {
                residentEdges.ed.set(part.edges, span.edgeAt);
            }
            if (bufInk) {
                gl.bindBuffer(gl.ARRAY_BUFFER, bufInk);
                gl.bufferSubData(gl.ARRAY_BUFFER, span.edgeAt * 4, part.edges);
                gl.bindBuffer(gl.ARRAY_BUFFER, buf3);
            }
            lastStickRefresh.edges += part.edges.length / ED_FLOATS;
        }
    }
    lastStickRefresh.rad = rad;
    return true;
}

/** Drop what the card holds for the station path. */
function clearResidentStations() {
    if (!gl || !residentStations) { residentStations = null; return; }
    if (residentStations.buf) gl.deleteBuffer(residentStations.buf);
    if (residentStations.stationTex) gl.deleteTexture(residentStations.stationTex);
    if (residentStations.pieceTex) gl.deleteTexture(residentStations.pieceTex);
    residentStations = null;
}

/**
 * Turn the station path on or off for the next draw.
 *
 * 🔴 IT IS NOT A PICTURE SETTING AND MUST NOT BECOME ONE. Two paths drawing the
 * same frame is a state for developing and measuring in, not for shipping: the
 * moment a reader can reach it, "which one drew this" becomes a question every
 * bug report has to answer first.
 */
function setStationDraw(on) { stationDraw = !!on; }

/**
 * EVERY UNIFORM OF ONE PROGRAM ONTO ANOTHER, BY ENUMERATION.
 *
 * The station path draws the ribbon and the ordinary path draws whatever the
 * station table does not cover - base plates, ligands, contacts, a lone atom -
 * and both need the same forty-odd uniforms: the rotation, the depth range, the
 * shade range, the palette and visibility samplers, the paper, the clip slab.
 *
 * 🔴 A HAND-WRITTEN LIST IS A LIST THAT DRIFTS. Two of them already did, in this
 * file: uploadClip and bindPaper kept naming prog3 after drawResident was
 * parameterised on its program, and the frame came out with correct geometry
 * and default clip and paper - 7% of pixels moved by 8-32 levels, spread over
 * every face. Asking the program what uniforms it has cannot miss one.
 *
 * gl.getUniform reads driver-side state rather than the framebuffer, so this is
 * not a stall like readPixels; it is a few dozen cheap queries on a path that
 * only runs when a mesh has geometry outside the ribbon.
 */
function mirrorUniforms(src, dst) {
    const n = gl.getProgramParameter(src, gl.ACTIVE_UNIFORMS);
    gl.useProgram(dst);
    for (let i = 0; i < n; i += 1) {
        const info = gl.getActiveUniform(src, i);
        if (!info) continue;
        const name = info.name.replace(/\[0\]$/, '');
        const from = gl.getUniformLocation(src, name);
        const to = gl.getUniformLocation(dst, name);
        if (!from || !to) continue;          // dst may not use it; that is fine
        const v = gl.getUniform(src, from);
        switch (info.type) {
        case gl.FLOAT: gl.uniform1f(to, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(to, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(to, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(to, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(to, false, v); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(to, false, v); break;
        case gl.INT:
        case gl.BOOL:
        case gl.SAMPLER_2D:
        case gl.SAMPLER_CUBE: gl.uniform1i(to, v); break;
        default: break;
        }
    }
}

const capInstances = (n) => (instanceLimit >= 0 ? Math.min(n, instanceLimit) : n);

function drawResident(cv, prm, prmAO) {
    const P0 = prm || defaultParams();
    if (P0.ortho !== undefined) setOrtho(P0.ortho);
    if (!resident) return;              // nothing built yet; the caller builds
    // 🔴 ONE DRAW PATH, TWO WAYS OF FEEDING IT. The station program is the same
    // shader reading its geometry from a texture instead of from the instance
    // row (see VS3D_STATIONS), so everything below - the AO prepass, the ink,
    // the forty-odd uniforms - is identical and must not be forked. Only the
    // program handle and the attribute binding differ.
    // 🔴 AND ONLY WHILE THE TABLE IS CURRENT. A rebuild replaces the mesh and
    // leaves the stations describing the frame before it; drawing from them
    // then puts a correct picture's flags and colours on the previous frame's
    // geometry. Measured at 18.8% of pixels the first time a rebuild followed a
    // decline. The rebuild marks them stale and the draw falls back until a
    // caller installs again.
    const useStations = !!(stationDraw && progStations && residentStations
        && !residentStations.stale);
    const P = useStations ? progStations : prog3;
    // WHICH OF THE TWO PROGRAMS DREW, for a probe. They are different shaders
    // over different buffers, and a frame that falls back to the fill program
    // draws the ribbon from rows the station path does not build.
    if (typeof window !== 'undefined') {
        window.__drawProgram = useStations ? 'stations' : 'fill';
        window.__drawStale = residentStations ? !!residentStations.stale : null;
    }
    gl.useProgram(P);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    if (!composeKeepFrame) {
        clearToPaper();
        gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, useStations ? residentStations.buf : buf3);
    const stride = (useStations ? STATION_ROW : 48) * 4;
    const bound = [];
    const bind = (name, size, off) => {
        const l = gl.getAttribLocation(P, name);
        if (l < 0) return;
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off);
        gl.vertexAttribDivisor(l, 1);      // one set of values per FACE
        bound.push(l);
    };
    if (useStations) {
        // THE ROW IS TOPOLOGY AND COLOUR ONLY - 18 floats where the other is
        // 48, and none of them moves when the structure does.
        bind('aStation', 1, 0); bind('aSurf', 1, 4); bind('aPiece', 1, 8);
        bind('aBase', 3, 12);
        bind('aFlags0', 4, 24); bind('aFlags1', 4, 40); bind('aFlags2', 4, 56);
        // ...and the geometry, on units 4 and 5. Units 0-3 are already spoken
        // for: visibility, palette, and AO's two.
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, residentStations.stationTex);
        gl.uniform1i(gl.getUniformLocation(P, 'uStations'), 4);
        gl.uniform1f(gl.getUniformLocation(P, 'uStationW'), residentStations.stationW);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, residentStations.pieceTex);
        gl.uniform1i(gl.getUniformLocation(P, 'uPieces'), 5);
        gl.uniform1f(gl.getUniformLocation(P, 'uPieceW'), residentStations.pieceW);
        gl.activeTexture(gl.TEXTURE0);
    } else {
        bind('aC0', 3, 0); bind('aC1', 3, 12); bind('aC2', 3, 24); bind('aC3', 3, 36);
        bind('aNA', 3, 48); bind('aNB', 3, 60); bind('aTA', 3, 72); bind('aTB', 3, 84);
        bind('aFlatN', 3, 96); bind('aFlatShade', 3, 108);
        bind('aDots', 3, 120); bind('aBase', 3, 132);
        bind('aFlags0', 4, 144); bind('aFlags1', 4, 160); bind('aFlags2', 4, 176);
    }
    const R = currentRot();
    gl.uniformMatrix3fv(gl.getUniformLocation(P, 'uRot'), false,
        new Float32Array([R[0][0], R[1][0], R[2][0],
            R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]));
    gl.uniform2f(gl.getUniformLocation(P, 'uSize'), cv.width, cv.height);
    const dzprog3 = shiftZ();
    const zr3 = composeZ || [resident.zMin + dzprog3, resident.zMax + dzprog3];
    gl.uniform2f(gl.getUniformLocation(P, 'uZRange'), zr3[0], zr3[1]);
    gl.uniform3f(gl.getUniformLocation(P, 'uShift'),
        viewShift[0], viewShift[1], viewShift[2]);
    const sr = shadeRange();
    // the shade range is measured off the unshifted centroids, and the
    // shader now evaluates a shifted one - so it travels with them
    gl.uniform2f(gl.getUniformLocation(P, 'uShadeRange'), sr[0] + dzprog3, sr[1] + dzprog3);
    gl.uniform1f(gl.getUniformLocation(P, 'uScale'), drawScale());
    uploadClip(P);
    gl.uniform1f(gl.getUniformLocation(P, 'uPersp'), isPersp() ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(P, 'uFL'), focalLength());
    gl.uniform1f(gl.getUniformLocation(P, 'uShowRibbon'), showRibbon ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(P, 'uShowSticks'), showSticks ? 1 : 0);
    // ...and the same outline width the ink pass uses, so a disc's own rim
    // follows the Outline control like every other line in the picture -
    // including all the way to zero, where the drawing has no outlines at all.
    // GATED ON sp.ink, not on the width: inkWidth has a floor (INK_W_MIN) so
    // that a thin outline stays visible, which means it never reaches zero -
    // turning outlines OFF is the `ink` flag, and a disc that kept its ring
    // would be the only outlined thing left in the picture.
    // P0, NOT sp: `const sp = P0` is thirty lines below this, and a const read
    // before its declaration is a TDZ throw rather than undefined - it took the
    // whole GPU path down to the 2D fallback with one line in the console.
    gl.uniform1f(gl.getUniformLocation(P, 'uDiscInk'),
        P0.ink ? P0.inkWidth * pixelRatio : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.uniform1i(gl.getUniformLocation(P, 'uVis'), 0);
    gl.uniform1f(gl.getUniformLocation(P, 'uVisW'), visTex ? visW : 0);
    gl.uniform1f(gl.getUniformLocation(P, 'uVisN'),
        (resMap && resMap.nBase) ? resMap.nBase : 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, palTex);
    gl.uniform1i(gl.getUniformLocation(P, 'uPal'), 1);
    gl.uniform1f(gl.getUniformLocation(P, 'uPalW'), palTex ? palW : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(gl.getUniformLocation(P, 'uFlatCull'), P0.flatCull ? 1 : 0);
    gl.uniform3f(gl.getUniformLocation(P, 'uPaper'), PAPER[0], PAPER[1], PAPER[2]);
    // the same numbers the 2D renderer is using for this preset
    const sp = P0;
    // THE GRAIN. A redraw, never a rebuild - it is a fragment-stage multiply
    // and the mesh knows nothing about it.
    bindPaper(P, cv, sp.pencil);
    const u = (n2, v) => gl.uniform1f(gl.getUniformLocation(P, n2), v);
    u('uShadeAmt', sp.shadeAmt);
    u('uInnerShade', sp.innerShade);
    u('uHiGain', sp.hiGain);
    u('uKnee', sp.knee);
    u('uStickKnee', sp.stickKnee);
    u('uDepthFloor', sp.depthFloor);
    u('uCel', sp.cel);
    u('uExact', sp.exact ? 1 : 0);
    timerOn = (typeof window !== 'undefined' && window.__gpuTimers === true);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdx);

    // ---- OCCLUSION, when it is asked for -------------------------------
    //
    // The tube's three passes, over the cartoon's own fills: the same
    // instances rasterised once with uZOnly to leave a field of view depths,
    // one full-screen pass turning that into a shadow/tint pair, and a resolve
    // that matches its interleaved rotation. FSAO reads a depth field and
    // knows nothing about what drew it, which is why this needs no shader of
    // its own - only its own two constants. See cartoonAOSelfBias.
    const wantAO = !!prmAO && ensureOcc(cv.width, cv.height);
    if (wantAO) {
        const tmZ = tmStart('c0-prepass');
        gl.bindFramebuffer(gl.FRAMEBUFFER, zFbo);
        gl.viewport(0, 0, cv.width, cv.height);
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
        gl.clearColor(-1e9, 0, 0, 1);       // -1e9 is "no surface here"
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        u('uZOnly', 1);
        gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0,
            capInstances(useStations ? residentStations.count : resident.count));
        u('uZOnly', 0);
        tmEnd(tmZ);
        runOcclusion(cv, prmAO);
        // ...AND PUT BACK WHAT WAS BOUND. ensureOcc creates its textures on
        // whatever unit happens to be active, so the very first AO frame - the
        // one that allocates them - left the fill program reading a depth
        // texture as its visibility map: half the drawing came out white, once,
        // and never again. Rebinding both is cheaper than reasoning about it.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, visTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, palTex);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, cv.width, cv.height);
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
        gl.useProgram(P);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, aoTex2);
        gl.uniform1i(gl.getUniformLocation(P, 'uAOTex'), 3);
        gl.uniform2f(gl.getUniformLocation(P, 'uSizeF'), cv.width, cv.height);
    }
    u('uUseAO', wantAO ? 1 : 0);
    u('uAOAmt', wantAO && prmAO ? (typeof prmAO.amount === 'number' ? prmAO.amount : 0.8) : 0);

    const tmS = tmStart('c1-surfaces');
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0,
        capInstances(useStations ? residentStations.count : resident.count));
    tmEnd(tmS);
    // 🔴 AND THE FACES THE TABLE DOES NOT DESCRIBE, from the rows that do.
    // They sit after the ribbon in the concatenation, so this is the ordinary
    // program over the ordinary buffer with every attribute started that many
    // instances in - WebGL2 has no base-instance parameter, so the offset goes
    // on the pointers.
    if (useStations && residentStations.count < resident.count) {
        // 🔴 WHERE THE TAIL ACTUALLY IS, NOT WHERE THE RIBBON'S FACE COUNT SAYS
        // IT SHOULD BE. This was `residentStations.count * 48 * 4`, which is
        // right only while the ribbon occupies the first `count` rows of the
        // combined fill - and that is the one assumption standing between here
        // and not building those rows at all, since the station path never
        // issues them. installParts already records where each part landed;
        // reading the offset it wrote is both more direct and the same number
        // today. The fallback is the old expression, for a mesh installed
        // before the spans existed.
        const restAt = (residentPartSpans && residentPartSpans[1]
            ? residentPartSpans[1].fillAt : residentStations.count * 48) * 4;
        gl.useProgram(prog3);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf3);
        const rest = [];
        const bindRest = (name, size, off) => {
            const l = gl.getAttribLocation(prog3, name);
            if (l < 0) return;
            gl.enableVertexAttribArray(l);
            gl.vertexAttribPointer(l, size, gl.FLOAT, false, 48 * 4, restAt + off);
            gl.vertexAttribDivisor(l, 1);
            rest.push(l);
        };
        bindRest('aC0', 3, 0); bindRest('aC1', 3, 12);
        bindRest('aC2', 3, 24); bindRest('aC3', 3, 36);
        bindRest('aNA', 3, 48); bindRest('aNB', 3, 60);
        bindRest('aTA', 3, 72); bindRest('aTB', 3, 84);
        bindRest('aFlatN', 3, 96); bindRest('aFlatShade', 3, 108);
        bindRest('aDots', 3, 120); bindRest('aBase', 3, 132);
        bindRest('aFlags0', 4, 144); bindRest('aFlags1', 4, 160);
        bindRest('aFlags2', 4, 176);
        // ...the same uniforms, on the other program.
        mirrorUniforms(P, prog3);
        gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0,
            resident.count - residentStations.count);
        // 🔴 AND WHETHER THE RECORDED SPAN WAS ACTUALLY NEEDED. The old
        // expression - the ribbon's face count times the row stride - is right
        // only while the ribbon contributes rows, and it does not when the
        // station table covers it. This counts the frames where the two answers
        // differ, which is exactly the case the span exists for; a gate that
        // never sees it fire is not exercising this at all.
        if (restAt !== residentStations.count * 48 * 4) {
            window.__tailSpanDiffered = (window.__tailSpanDiffered || 0) + 1;
        }
        for (const l of rest) gl.vertexAttribDivisor(l, 0);
        gl.useProgram(P);
    }
    // divisors live on the attribute, not the program: leaving them at 1 makes
    // the next non-instanced draw read one vertex and stretch it over the mesh
    for (const l of bound) gl.vertexAttribDivisor(l, 0);
    if (sp.ink || residentHasContacts) drawInk(cv, sp);
    gl.useProgram(prog);
}

// The outline, over the depth buffer the fills just wrote. Nothing is uploaded
// here - the edge buffer is resident and the view is a uniform, which is the
// structural difference from the analytic pass: that one rebuilds its occluder
// grid every frame (122 ms of 356 on 4UG0) because the grid is in SCREEN space
// and every rotation invalidates it.
function drawInk(cv, prm) {
    const spI = prm || defaultParams();
    if (!edgeCount) return;
    gl.useProgram(progInk);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(false);            // ink must not occlude ink
    gl.bindBuffer(gl.ARRAY_BUFFER, bufInk);
    // ED_FLOATS, not 19 again: this was the second place that knew the edge
    // row's width, and a row that grows has to grow in both or the attributes
    // read from the wrong offsets with nothing to say so.
    const stride = ED_FLOATS * 4;
    const binds = [['aP0', 3, 0], ['aP1', 3, 12], ['aN0', 3, 24],
        ['aN1', 3, 36], ['aAlways', 1, 48], ['aEdgeStick', 1, 52], ['aEdgePal', 1, 56],
        ['aEdgeCol', 3, 60], ['aEdgeW', 1, 72], ['aEdgeRes', 1, 76]];
    for (const [nm, sz, off] of binds) {
        const l = gl.getAttribLocation(progInk, nm);
        if (l < 0) continue;
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, sz, gl.FLOAT, false, stride, off);
        gl.vertexAttribDivisor(l, 1);          // one set of values per EDGE
    }
    const R = currentRot();
    gl.uniformMatrix3fv(gl.getUniformLocation(progInk, 'uRot'), false,
        new Float32Array([R[0][0], R[1][0], R[2][0],
            R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]));
    gl.uniform2f(gl.getUniformLocation(progInk, 'uSize'), cv.width, cv.height);
    const dzprogInk = shiftZ();
    const zrInk = composeZ || [resident.zMin + dzprogInk, resident.zMax + dzprogInk];
    gl.uniform2f(gl.getUniformLocation(progInk, 'uZRange'), zrInk[0], zrInk[1]);
    gl.uniform3f(gl.getUniformLocation(progInk, 'uShift'),
        viewShift[0], viewShift[1], viewShift[2]);
    const srI = shadeRange();
    // the shade range is measured off the unshifted centroids, and the
    // shader now evaluates a shifted one - so it travels with them
    gl.uniform2f(gl.getUniformLocation(progInk, 'uShadeRange'), srI[0] + dzprogInk, srI[1] + dzprogInk);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uScale'), drawScale());
    uploadClip(progInk);
    // THE COVERAGE TEXTURE, as the fills and the tube bind it for themselves.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.uniform1i(gl.getUniformLocation(progInk, 'uVis'), 0);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uVisW'), visTex ? visW : 0);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uVisN'),
        (resMap && resMap.nBase) ? resMap.nBase : 1);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uPersp'), isPersp() ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uFL'), focalLength());
    gl.uniform1f(gl.getUniformLocation(progInk, 'uShowRibbon'), showRibbon ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uShowSticks'), showSticks ? 1 : 0);
    // DISPLAY pixels in, device pixels out - the same ratio the fills go through
    gl.uniform1f(gl.getUniformLocation(progInk, 'uWidth'), spI.inkWidth * pixelRatio);
    // THE MANUAL BIAS IS NOW A TRIM, not the mechanism - see the slope- and
    // width-scaled term in the shader, which does the actual work. It defaults
    // to 0 and barely moves anything: at width 1.6 the outline is 0.8% broken
    // without it and 0.7% with.
    //
    // Kept because it costs nothing and the pixel metric and the eye disagree
    // about outlines, so having the knob is worth more than the tidiness of
    // removing it.
    //
    // A silhouette edge lies exactly ON its own two faces, so with no bias it
    // z-fights them and the line comes apart. Counting ink pixels with fewer
    // than two ink neighbours - the ends of a stroke - shows what that costs:
    //
    //     bias 0      3650 ink px, 63.1% of them broken
    //     bias 0.001  9679          36.2%
    //     bias 0.002 11000          30.0%
    //     bias 0.004 11767          26.8%
    //
    // At zero the outline is not a thin outline, it is a dashed one: two thirds
    // of it is fragments. The whole-image difference cannot see that - a dashed
    // line and a solid one differ by their pixel COUNT, and the dashed one
    // happens to be nearer the reference's - so it reported 24.3% at bias 0
    // against 25.6% at 0.004 and preferred the broken drawing.
    //
    // 0.002 is the knee: most of the continuity, least of the excess ink.
    // THE REAL FIX IS STILL THE ID BUFFER, and this is the argument for it:
    // bias trades continuity against ink the reference does not draw, and an
    // identity test escapes the trade instead of picking a point on it.
    gl.uniform1f(gl.getUniformLocation(progInk, 'uBias'), spI.inkBias);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uInkTint'), spI.outlineTint || 0);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uHandoff'), spI.handoff);
    // THE CAP, and it is a compromise rather than a solution. Measured on 1UBQ
    // at width 1.6, black ink, against the renderer's 9440 ink pixels:
    //
    //     cap 0.0001   12687 px   24.2% broken
    //     cap 0.00025  13812      19.5%
    //     cap 0.0005   15356      13.8%
    //     uncapped     22120       0.8%
    //
    // Loosening it makes the lines solid and surfaces edges the drawing should
    // not have; tightening it removes those and breaks the lines again. There
    // is no setting that does both, because a depth offset cannot tell "in
    // front of my own face" from "in front of something else" - which is the
    // whole of what an ID buffer would fix.
    //
    // 0.004 is chosen for how the drawing LOOKS, not for the pixel metric. More
    // ink than the reference is fine - a solid line reads as a line and a
    // dashed one reads as a fault - and the metric prefers the dashed one
    // because it counts pixels rather than strokes. What the cap protects
    // against is the other failure: an effectively uncapped bias reached ~0.038
    // on grazing faces and surfaced edges that should have stayed hidden, which
    // is a real defect rather than a matter of taste. 0.004 is an order of
    // magnitude below that and leaves the lines about 2% broken.
    gl.uniform1f(gl.getUniformLocation(progInk, 'uBiasMax'),
        spI.biasMax);
    // INK_BASE is 0 on paper and 255 in dark mode
    gl.uniform1f(gl.getUniformLocation(progInk, 'uInkBase'), INK_BASE);
    // inkFloor = 1 - fade * INK_FADE_SCALE, with INK_FADE_SCALE = 0.35
    gl.uniform1f(gl.getUniformLocation(progInk, 'uInkFloor'),
        1 - (1 - (spI.depthFloor === undefined ? 1 : spI.depthFloor)) * 0.35);
    gl.uniform3f(gl.getUniformLocation(progInk, 'uPaperInk'), PAPER[0], PAPER[1], PAPER[2]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, palTex);
    gl.uniform1i(gl.getUniformLocation(progInk, 'uPal'), 1);
    gl.uniform1f(gl.getUniformLocation(progInk, 'uPalW'), palTex ? palW : 0);
    gl.activeTexture(gl.TEXTURE0);
    // the 2D pass grains the FINISHED frame, outline included, so the ink takes
    // the same paper - and takes it from the same tile
    bindPaper(progInk, cv, spI.pencil);
    const tmI = tmStart('c2-ink');
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdx);
    // ...and the probe's clamp reaches the INK too, or a bisect that finds
    // "the difference is there with zero instances drawn" is looking at an
    // outline it never switched off. See tests/outline_sync.py --bisect.
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0,
        capInstances(edgeCount));
    tmEnd(tmI);
    tmCollect();
    // PUT THE DIVISORS BACK. They live on the attribute, not on the program, so
    // leaving them at 1 makes the next non-instanced draw read one vertex and
    // stretch it over the whole mesh - which shows up as the fills vanishing on
    // the frame AFTER the outline is switched off, not the frame it happens on.
    for (const [nm] of binds) {
        const l = gl.getAttribLocation(progInk, nm);
        if (l >= 0) gl.vertexAttribDivisor(l, 0);
    }
    gl.depthMask(true);
}
/* ============================================================== THE APP ENTRY
 * Everything above is the port. This is the one function core/mol.js calls,
 * and its whole job is to answer three questions: what parameters does this
 * renderer imply, has anything changed that the resident mesh cannot absorb,
 * and where does the picture go.
 *
 * WHERE THE PICTURE GOES is an offscreen WebGL canvas, blitted onto the 2D
 * context the app already owns. That keeps the selection halo, the sequence
 * highlight overlay, picking and both exports on exactly the path they are on
 * today - the GPU replaces the DRAW, not the frame.
 *
 * WHAT CHANGED is a signature over everything the mesh is built from. Anything
 * not in it is a redraw: the rotation, the zoom, the ortho slider, shade,
 * highlight, fade, smooth, the pencil, the ink weight and the whole palette.
 * Anything in it rebuilds, which costs one 2D render with the painter switched
 * off - the same work the app was doing every frame before.
 */
// WHAT THE FRAME IS CLEARED TO. Paper on screen - the GPU canvas is blitted
// over whatever the app painted, so a white clear paints a white square over a
// black page - and NOTHING at all for an export asked to be transparent, which
// is what saveImage asks for. Premultiplied alpha, so transparent is (0,0,0,0)
// and not paper-with-zero-alpha.
let clearAlpha = 1;
function setClearAlpha(a) { clearAlpha = (a === 0) ? 0 : 1; }
function clearToPaper() {
    if (clearAlpha === 0) gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(PAPER[0] / 255, PAPER[1] / 255, PAPER[2] / 255, 1);
}
let appCv = null;                  // the offscreen drawing buffer
let appSig = null;                 // what the resident mesh was built from
let appTopoSig = null;             // ...and the same without the coordinates
let appColors = null;              // the palette the app last handed over
// 🔴 A CONTENT DIGEST, WHICH IT SAID IT WAS AND WAS NOT. This held idOf(colors)
// - a serial number handed out per ARRAY OBJECT - so it answered "is this the
// same array?" and never "are these the same colours?". Both clauses of the
// test below were then the same test, and any recolour that allocates a fresh
// array took the expensive branch whatever was in it.
//
// Where the palette is complete that cost a wasted texture upload, which is
// nothing. Where it is NOT - ss mode, or an object carrying explicit colour
// overrides - the else branch is a full rebuild, so re-selecting the mode you
// are already in, or anything else that recomputes colours without changing
// them, rebuilt the entire mesh. Measured on 1UBQ: switching to ss while
// already in ss, one rebuild, with the signature unmoved.
//
// colourKeyOf is the digest the TUBE path has always used for exactly this
// reason, and its own comment says so: "BY CONTENT, so coming back to a picture
// already built is an upload, not a build." The cartoon now asks the same
// question. It is cached per array, so a new array costs one walk and a
// repeated one costs a lookup.
let appColourKey = '';             // colourKeyOf(colors) - by CONTENT
let appPalComplete = true;         // ...and whether recolouring it would do anything
let appPos = null;                 // the drawn positions, model space, xyz triples
/**
 * A capture's drawn positions, un-rotated into model space, in the layout
 * projectPositions reads.
 *
 * 🔴 A FUNCTION BECAUSE TWO PATHS FILL IT AND ONLY ONE USED TO. Everything
 * drawn ON TOP of the canvas - the selection halo, the sequence hover,
 * click-picking, and Orient's framing of a selection - reads
 * renderer.screenX/screenY, which projectPositions writes from this array. The
 * full rebuild filled it and the station fast path did not, so on a trajectory
 * the picture was this frame's and the overlay was the frame the mesh was built
 * at: measured on _traj_1tim.pdb, three steps in, the projections were up to
 * 6.4 px from the plain path's and the picker answered a different residue at 3
 * of 42 sampled points. Selecting and orienting are the two things that look
 * broken when this goes stale, and neither leaves a mark on the mesh, so no
 * gate that compares PICTURES could see it.
 */
function modelPositions(pos) {
    if (!pos || !pos.length) return null;
    const out = new Float64Array(pos.length * 3);
    const mT = matT(currentRot());
    const dMx = currentCapCentre[0] - currentModelCenter[0];
    const dMy = currentCapCentre[1] - currentModelCenter[1];
    const dMz = currentCapCentre[2] - currentModelCenter[2];
    for (let i = 0; i < pos.length; i++) {
        const v = pos[i];
        if (!v) { out[i * 3] = NaN; continue; }
        const mv = apply(mT, [v.x, v.y, v.z]);
        out[i * 3] = mv[0] + dMx; out[i * 3 + 1] = mv[1] + dMy; out[i * 3 + 2] = mv[2] + dMz;
    }
    return out;
}

// The renderer's own properties, in the shape the port reads. Same object the
// harness builds from its controls, so there is one consumer and two producers
// rather than two of each.
// THE REFERENCE'S OWN NUMBERS. Restating them here is what let the outline
// weight drift to 1.45x; anything the 2D module names, this reads rather than
// repeats. Fallbacks are the values it exports today, so an older
// cartoon/geom.js still renders.
function ref() {
    return (window.py2dmolCartoon && window.py2dmolCartoon.SHADING) || {};
}

function paramsFromRenderer(r) {
    const rich = r.cartoonRichardson === true;
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const fade = Math.max(0, Math.min(1, num(Number(r.cartoonFade), 0)));
    const outlineW = num(r.relativeOutlineWidth, 0);
    const inkOn = outlineW > 0 && r.outlineMode !== 'none';
    // the 2D pass's own clamp: real thinning as the drawing shrinks, but growth
    // stops at 1.5x or a drawn line becomes a band
    const zoomW = Math.max(0.35, Math.min(1.5,
        (r.viewerState && r.viewerState.zoom) || 1));
    return {
        rich,
        // WELDED IS THE MEASURED DEFAULT and the only frame mode that ships:
        // `station` and the two forced modes exist so the lab can show what
        // they cost. They measured identically once _frameProbe landed.
        frame: 'welded',
        ink: inkOn,
        creaseDeg: 180,             // no crease rule: the silhouette, and nothing else
        // the interpolated sheet cull, which measured better. The comment in
        // the shader promises window.__flatCull restores the per-face test;
        // it was never wired, so the escape hatch did nothing.
        flatCull: (typeof window !== 'undefined' && window.__flatCull === true),
        exact: false,               // a lab control: feed the renderer's own dots back in
        cel: r.cartoonSmooth === true ? 0.0 : 1.0,
        shadeAmt: num(r.cartoonShade, 1),
        hiGain: num(r.cartoonHighlight, 1),
        innerShade: 0.22,
        knee: rich ? num(ref().RICH_HI_KNEE, 0.25) : num(ref().HI_KNEE, 0.55),
        stickKnee: num(ref().HI_KNEE, 0.55),
        depthFloor: 1 - fade,
        ortho: r.viewerState && r.viewerState.ortho !== undefined
            ? r.viewerState.ortho : 1,
        pencil: r.cartoonPencil !== undefined ? r.cartoonPencil : (rich ? 1 : 0),
        // THE OUTLINE'S WEIGHT IS THE APP'S, in the app's units, and it is a
        // DISPLAY width - the device ratio is applied at the draw with
        // everything else.
        //
        // THE 2D PASS'S OWN WEIGHT, read from it rather than restated.
        // cartoon/geom.js computes
        //   inkW = max(INK_W_MIN * pxScale, outlineW * pxScale * zoomW * INK_W_MUL)
        // and this is the same expression - the device ratio is the only part
        // applied later (uWidth = inkWidth * pixelRatio at the draw).
        //
        // These were 0.8 and 0.2 against the reference's 0.55 and 0.35, so every
        // GPU outline came out 1.45x heavier at the same Outline setting.
        //
        // The zoom term stays: the 2D pass thins its outline as the drawing
        // shrinks and without it the GPU line would stay put while the 2D one
        // moved. It is the ribbon's own THICKNESS fade that was removed, and
        // that one lived entirely in the 2D geometry, so this path inherits its
        // removal through the capture.
        // ...and TIMES THE EXPORT SCALE, which is the other half of the 2D
        // expression: pxScale multiplies both of its terms. On screen it is 1
        // and this is the display width as before; in a 300 dpi export the
        // mesh is captured at the export's size but the ink is not - it is a
        // number of PIXELS, and left at the display value it came out four
        // times too thin, which is most of an outline missing.
        inkWidth: Math.max(num(ref().INK_W_MIN, 0.35),
            outlineW * zoomW * num(ref().INK_W_MUL, 0.55))
            * (r._exportPxScale || 1),
        handoff: num(r.cartoonHandoff, HANDOFF_TOL),
        inkBias: 0.002,
        biasMax: 0.004,
        outlineTint: num(r.cartoonOutlineTint, 0),
    };
}

// CONTACTS ARE GEOMETRY, and an EDIT to one is invisible in a count. Their
// endpoints, weight and colour are baked into the mesh when it is built, so the
// width slider and the colour swatch both need a rebuild to be seen. Shared by
// both signatures rather than written twice.
/**
 * The contacts of EVERY DRAWN OBJECT, as one key.
 *
 * Contacts are drawn as segments of the merged array, so a second object's
 * contact is on screen and has to be able to force a rebuild - taking the
 * current object's alone, editing a contact in the other one changed nothing.
 */
function contactKeyOf(renderer) {
    const names = (renderer && renderer.drawnObjects) ? renderer.drawnObjects()
        : (renderer && renderer.currentObjectName ? [renderer.currentObjectName] : []);
    let a = 0;
    let n = 0;
    for (const nm of names) {
        const o = (renderer.objectsData || {})[nm];
        if (!o || !Array.isArray(o.contacts) || !o.contacts.length) continue;
        n += o.contacts.length;
        for (const c of o.contacts) {
            for (const v of c) {
                const t = typeof v === 'number' ? v : String(v).charCodeAt(0);
                a = ((a * 31) + (t * 1000 | 0)) >>> 0;
            }
        }
    }
    return n ? (n + ':' + a) : 'none';
}

/* WHAT BOTH GEOMETRY KEYS HAVE TO SAY.
 *
 * The cartoon's mesh and the tube's instance buffer are different models built
 * by different code, but the question "is this still the same picture?" has one
 * answer for the part of it neither of them owns: which object, which frame,
 * which coordinate array, which segments, which of them are drawn, which are
 * masked off, how wide the line is, what side chains and contacts were added,
 * what backbone is hidden. Each path used to list those by hand, and the two
 * lists had already drifted - the tube kept the coordinate array by identity
 * while the cartoon kept only its LENGTH, and the cartoon kept the merged
 * source names while the tube kept none. Identity was the WRONG half of that
 * disagreement (see below); both were one edit away from a stale picture.
 *
 * So: one builder, the STRONGER of the two everywhere they disagreed, and each
 * path appends only what is genuinely its own (the cartoon's outline, ribbon
 * and Richardson settings; the tube's colours and instance count).
 *
 * The hidden backbone comes from `backboneHiddenSet()`, which merges every
 * drawn object's set - where the cartoon's own term read `hiddenBackbone` off
 * the CURRENT object alone and would not have noticed a second merged object's
 * backbone being hidden.
 */
function sharedGeometryKey(r, topological) {
    const o = (r.objectsData || {})[r.currentObjectName];
    const bb = r.backboneHiddenSet ? r.backboneHiddenSet()
        : ((o && o.hiddenBackbone) || null);
    return [
        r.currentObjectName,
        // WHAT THE COORDINATE ARRAY HOLDS AND WHAT IS IN IT, in the
        // renderer's own words (core/mol.js:_coordsKey): every drawn object
        // with the frame it is showing, the appended side-chain atoms, and
        // three samples of the coordinates themselves.
        //
        // Not the array's IDENTITY - the merge is rebuilt from scratch
        // whenever the drawn set changes, so switching an object off and back
        // on yields the same picture in a new array, and identity rebuilt the
        // mesh for nothing (measured: 70-80 ms on every eye toggle). Not its
        // LENGTH alone either, which is what the cartoon's key used to keep
        // and cannot see an alignment move the coordinates inside a frame.
        //
        // The same statement the secondary-structure cache asks for, which is
        // the point: three hand-written versions of this list disagreed.
        // (The fallback is for the test harnesses, which build a renderer by
        // hand and have no objects behind it.)
        // 🔴 WITHOUT THE COORDINATES, WHEN ASKED. The trajectory fast path needs
        // to know whether ANYTHING BUT the atoms moved - a colour, an eye, a
        // side chain, the canvas size - because the instance row carries all of
        // those and only the textures are being rewritten. Same key, one term
        // swapped: see parts/multi.js for the pair.
        topological && r._topologyKey ? r._topologyKey()
            : r._coordsKey ? r._coordsKey()
            : (r.currentFrame + '|' + ((r.multiState && r.multiState.enabled
                && r.multiState.sourceNames) ? r.multiState.sourceNames.join(',') : '')
               + '|' + coordsProbe(r.coords)),
        r.segmentIndices && r.segmentIndices.length,
        // THE MASK BY WHAT IS IN IT. It is rebuilt from the objects' own
        // records whenever the drawn set changes, so an identical picture
        // arrives as a different Set - and by identity that rebuilt everything
        // for nothing on every eye toggle.
        setKeyOf(r.visiblePositions),
        // 🔴 LINE WIDTH IS NOT TOPOLOGY EITHER. widthScale = lineWidth / 3 is
        // the RIBBON's own half-width, not just the sticks' - which is why it
        // is in this key at all - and a half-width is slot 3 of a station. It
        // leaves the piece, station and face counts alone at every value:
        // 196/449/1019 on 1UBQ at 1.5, 3, 4.5 and 6, and 234/543/1238 on 1EHZ.
        // See tests/topology_survey.py, which asks the renderer rather than
        // remembering the answer.
        //
        // OUT OF THE TOPOLOGICAL KEY ONLY. It stays in the full signature,
        // because the mesh a repaint would reuse really is different geometry,
        // and it stays in both for the TUBE path - line 7554 calls this
        // function with no topological argument, so that key is unaffected.
        ...(topological ? [] : [r.lineWidth]),
        // per-residue side chains change the segment list
        r.sidechainMap ? r.sidechainMap.size : 0,
        // 🔴 BY CONTENT, LIKE THE MASK ABOVE, AND IT USED TO BE BY IDENTITY.
        // The argument is the mask's, word for word: the app rebuilds its
        // per-object sets whenever the drawn set changes, so an identical
        // picture arrives as a Set with a new identity and the spare mesh is
        // thrown away for a picture it has already built. Measured on two
        // objects, hiding one and showing it again: 0 rebuilds bare, 1 with a
        // hidden backbone in play. tests/rebuild_returns.py.
        (bb && bb.size) ? 'nobb' + setKeyOf(bb) : 'bb',
        // CONTACTS ARE GEOMETRY. Their endpoints, weight and colour are all
        // baked in when the mesh is built - a contact's width is CONTACT_WIDTH
        // times its own stored weight, in Angstrom - so the width slider and
        // the colour swatch both need a rebuild to be seen.
        contactKeyOf(r),
        // 🔴 THE STRAND SET IS NOT IN HERE, and it was for an hour. The
        // outline's edge set is baked per strand face, so a residue that stops
        // being a strand keeps its creases until something rebuilds - and
        // hashing the strand set here forces that rebuild. It was added to stop
        // a reported flicker and it cannot: the same trajectory flickers
        // identically with EVERY FRAME REBUILT, because what moves is the
        // assignment underneath (tests/PERF_NOTES.md has the measurement -
        // 1 to 6 letters a frame on _traj_3ptb.pdb). So the term bought
        // rebuilds and nothing else: 4 of 5 steps on a beta protein, 9.00 ms a
        // step against 6.30.
        //
        // What it bought was exactness between a fast frame and a rebuild of
        // the same frame, and that is not free either: a strand that GROWS
        // keeps the crease at its old boundary, which is a line across the
        // middle of a sheet. That is what the cross edges below are for - the
        // row exists whatever the letter is, and which frames draw it is
        // decided per frame.
    ];
}



// THREE SAMPLES OF A COORDINATE ARRAY. Enough to notice that the geometry
// moved - an alignment moves everything - and cheap enough to ask every frame.
function coordsProbe(co) {
    if (!co || !co.length) return '0';
    const n = co.length;
    let s = '';
    for (const i of [0, n >> 1, n - 1]) {
        const p = co[i];
        if (p) s += (((p.x + p.y * 3 + p.z * 7) * 1000) | 0) + ',';
    }
    return n + ':' + s;
}

// WHAT FORCES A REBUILD. Deliberately generous: a signature that misses
// something shows up as a stale picture, which is far worse than a rebuild that
// was not strictly needed. Colour is the one thing kept OUT of it, because the
// palette is a texture and repainting is an upload against a mesh that never
// moves.
function signatureOf(r, w, h, colors, topological) {
    const o = r.objectsData && r.objectsData[r.currentObjectName];
    return sharedGeometryKey(r, topological).concat([
        // the extent of what is DRAWN - the merge has its own, and the camera
        // scale is built from it
        ((r.drawnStats && r.drawnStats()) || o || {}).maxExtent,
        ...(topological ? [] : [w, h]),
        // 🔴 THICKNESS AND FLATNESS ARE NOT TOPOLOGY, so they are left out of
        // the topological key - the one the station fast path compares.
        //
        // Both move coordinates and the two per-station scalars and nothing
        // else: measured on 1UBQ, 201 ribbon prims, 454 stations and 1019 mesh
        // faces at sheetFlat 0, 0.5 and 1, and the same three numbers at
        // thickness 0, 0.5 and 1.5. A station already carries halfW and halfT -
        // slots 3 and 7 - so this is exactly the update the table exists to do,
        // the same one every trajectory step makes.
        //
        // They stay in the FULL signature, because the mesh a repaint would
        // reuse really is different geometry; what changes is that the station
        // path is now allowed to answer instead of the rebuild.
        //
        // DETAIL IS DIFFERENT and stays in both: it is the subdivision count,
        // so it changes the stations themselves - 325 at detail 2, 454 at 4,
        // 809 at 8 - and no table can be updated across that.
        ...(topological ? [] : [r.cartoonThickness, r.cartoonSheetFlat]),
        // 🔴 AND ANY NEW PER-STATION KNOB BELONGS ON THAT LINE, NOT OUTSIDE
        // THE SIGNATURE ALTOGETHER. A quantity that moves the half-width or
        // half-thickness and nothing else - not the station count, not the
        // piece cuts, not the face list - goes in the full signature and out of
        // the topological one, and the station path then answers it with two
        // texture writes instead of a rebuild. Left out of BOTH, renderApp
        // takes the `sig === appSig` early-out and draws the resident mesh
        // unchanged: measured at 0.000% of pixels across the whole range of the
        // knob, which is what "zero rebuilds" looks like when it means "zero
        // effect". The SS morph was built and removed here; that is the lesson
        // it left. See the SS axis sections in tests/PERF_NOTES.md.
        r.cartoonDetail,
        // 🔴 THE STICK LEVEL OF DETAIL, AND IT IS THE ANSWER IN HERE, NOT THE
        // ZOOM. cartoon/geom.js draws a stick thinner than two pixels as one
        // double-sided quad instead of a six-face box, and that decision is
        // baked into the resident mesh - while the zoom that moves it is a
        // REDRAW and rebuilds nothing (the capture is taken at the live zoom
        // and the draw divides it out again). Left out, a nucleosome built
        // while small stayed flat all the way in, which is the fault the
        // sampling rule in geom.js already refuses by name. A boolean, so a
        // crossing costs exactly one rebuild and zooming inside a regime
        // costs nothing.
        (window.py2dmolCartoon && window.py2dmolCartoon.stickLodFlat
            && typeof r._viewportScale === 'function')
            ? window.py2dmolCartoon.stickLodFlat(r, r._viewportScale(w, h, o))
            : false,
        r.cartoonArrows,
        // 🔴 RICHARDSON STAYS, AND IT IS THE COUNTEREXAMPLE TO THE WHOLE RULE
        // ABOVE. It leaves the piece, station and face counts alone on both a
        // protein and a nucleic chain - 196/449/1019 on 1UBQ, 234/543/1238 on
        // 1EHZ - so it looks exactly like thickness and line width, and
        // tests/topology_survey.py names it on the counts alone.
        //
        // Taking it out was measured and reverted. The station path then drew
        // 1.4975% of the frame differently at a worst channel of 171, against
        // a control effect of 8.7303% and a same-build floor of 0 - it
        // reproduces 17% of its own change wrongly. Richardson is not only a
        // profile: it moves the shading knee, the pale inner face of a helix
        // and the arrow tips, and those are baked per FACE, not per station.
        //
        // Equal counts are necessary and NOT sufficient. That is what
        // tests/station_controls.py is for, and this is the line that proves
        // the file earns its runtime.
        r.cartoonRichardson,
        r.cartoonStyle,
        // NOT colorMode. Colour is a texture: three texels per segment against
        // a mesh that never moves, and putting the mode in here made every
        // scheme change a full rebuild - 45 to 95 ms where the upload is under
        // one. What DOES belong is the half-bond table, because element colour
        // is not a colour at all as far as the geometry is concerned: the
        // RENDERER cuts a bond at its midpoint when the palette carries
        // `halves`, and that happens at capture.
        colors && colors.halves ? 'halves:' + colors.halves.length : 'nohalves',
        // ...and the thing that makes a colour change GEOMETRY. Where an
        // interval's two ends disagree the renderer CUTS it at its midpoint and
        // gives each half its own end's colour, so a single coloured residue
        // runs from the midpoint before it to the midpoint after it. Repainting
        // the old cut structure with new colours would put every transition
        // half a residue late - the loop after a strand coming out
        // strand-coloured - so what causes those cuts is in the signature.
        //
        // 🔴 ONLY AN OVERRIDE DOES. `colorMode === 'ss'` stood here too and
        // does not belong: ss resolves ONE colour per interval, both ends
        // taking ssPal[ssCls], so col === colFar and no cut is added anywhere -
        // 1019 mesh faces and 201 ribbon prims in chain, rainbow and ss alike.
        // What kept it here was that the ss colours were computed INSIDE the
        // draw pass, so a repaint had nothing to upload; resolveSegmentColors
        // answers that without a build and the term goes.
        //
        // An override is per RESIDUE, so ovI and ovN differ across an interval
        // and the cut is real. That one stays.
        (function () {
            // ANY DRAWN OBJECT'S per-position colours, not the current one's:
            // the mesh is captured for the whole picture, and a second
            // object's overrides cut its bonds just as the first one's do.
            const names = r.drawnObjects ? r.drawnObjects() : [r.currentObjectName];
            for (const nm of names) {
                const c = ((r.objectsData || {})[nm] || {}).color;
                if (c && c.type === 'advanced' && c.value
                    && (c.value.position || c.value.chain)) return true;
            }
            return false;
        }()),
        // 🔴 THE OUTLINE IS 91% OF A BUILD AND IS SKIPPED WHEN IT IS OFF, so
        // switching it ON is a rebuild by construction and deliberately so -
        // see wantEdges in buildMeshPart: the edge pass is not paid on every
        // structure for a box nobody ticked.
        //
        // Switching it OFF is not. The edges are already in the buffer and the
        // draw pass already gates on sp.ink, so the whole cost of turning them
        // off is not issuing a draw call - and this term flipping threw the
        // mesh away, so turning them back on paid the 91% a second time. A
        // toggle cost two full rebuilds where it owes at most one.
        //
        // ONE TERM, THEN: does this frame need edges the resident mesh does
        // not have? Off with edges present keeps the key it already had.
        //
        // ...and the MODE is not in here at all any more. 'partial' against
        // 'full' is uEndCaps, a uniform the draw pass sets (see uEndCaps), and
        // the width is another - neither has ever been a reason to rebuild.
        // Only 'none' is, and only in the direction that needs building.
        (((r.relativeOutlineWidth || 0) > 0 && r.outlineMode !== 'none')
            || !!(residentEdges && residentEdges.ed && residentEdges.ed.length)),
        // FORCED SECONDARY STRUCTURE IS GEOMETRY. objectsData[name].sse maps a
        // position to 'H', 'E' or 'C' and wins over the assignment, so editing
        // it turns a loop into a strand - a different ribbon, not a different
        // colour. The 2D pass folds the same digest into its own secKey.
        (window.py2dmolCartoon && window.py2dmolCartoon.sseKey
            ? window.py2dmolCartoon.sseKey(r) : ''),
        // FORCED BASE PAIRING IS GEOMETRY. objectsData[name].pairs maps
        // paired nucleotide indices, which places the rungs and flips the normals.
        (window.py2dmolCartoon && window.py2dmolCartoon.pairsKey
            ? window.py2dmolCartoon.pairsKey(r) : ''),
        // A BASE PLATE IS GEOMETRY, and which residues have one is a per-object
        // set the 2D pass reads while it builds them (baseShown). Nothing else
        // here moves when it changes - a plate is drawn from the ribbon frame,
        // not from a position - so hiding a base rebuilt nothing and the GPU
        // went on drawing the plate from the cached mesh. BY CONTENT: this said
        // "by identity, like the visibility mask", and the mask had already been
        // moved off identity for the reason above - a comment naming a fix that
        // had been superseded, holding the bug it was copied from.
        (() => { const b = r.mergedObjectSet ? r.mergedObjectSet('bases')
            : (o && o.bases); return b ? 'b' + setKeyOf(b) : 'ball'; })(),
        // ELEMENT COLOURS ARE GEOMETRY, for the reason the halves term above
        // gives: a bond whose ends differ is CUT at its midpoint when the mesh
        // is captured. Switching elements off uncuts it, and the halves term
        // cannot see that - it is a length, and the array keeps its length
        // whatever is in it. BY CONTENT, for the reason the backbone term
        // gives: setElementsFor assigns a new Set every time, and so does
        // mergedObjectSet on any change to which objects are drawn.
        (() => { const e = r.mergedObjectSet ? r.mergedObjectSet('elements')
            : (o && o.elements); return e ? 'e' + setKeyOf(e) : 'eall'; })(),
        // THE NUCLEIC TRACE SMOOTHING IS GEOMETRY: it moves the rails, the
        // plates and the rungs together (see smoothNucleicTrace), so switching
        // it rebuilds rather than repaints.
        // 🔴 NA SMOOTH MOVES THE TRACE, NOT THE MAPPING. It leaves the piece,
        // station and face counts alone on a nucleic chain - 234/543/1238 on
        // 1EHZ at both values - which is the same shape of answer thickness
        // and line width give, and a moved trace is exactly what a station's
        // `mid` carries. tests/topology_survey.py names it; the line stands or
        // falls on tests/station_controls.py, because richardson looks
        // identical on the counts and is not carried.
        ...(topological ? [] : [r.naSmooth === false ? 'naraw' : 'nasmooth']),
        r.cartoonBasePlates === false ? 'noplates' : 'plates',
    ]).join('|');
}

// ONE 2D RENDER WITH THE PAINTER SWITCHED OFF. The three hooks are set and
// cleared around it so a renderer that is also being drawn normally is never
// left in probe mode.
function captureFrom(renderer, w, h, colors) {
    // ONE 2D GEOMETRY PASS PER FRAME IS THE CLAIM heldCapture MAKES. Counted,
    // because it is the most expensive thing a fast frame does - the whole
    // ribbon pipeline, assignment and all - and a second one would double it
    // without changing a pixel. tests/capture_once.py divides by frames.
    if (typeof window !== 'undefined') {
        window.__captures2D = (window.__captures2D || 0) + 1;
    }
    const keep = {
        noViewCull: renderer._noViewCull, frameProbe: renderer._frameProbe,
        probeOnly: renderer._probeOnly, primProbe: renderer._primProbe,
        posProbe: renderer._posProbe, traceProbe: renderer._traceProbe,
        pencil: renderer.cartoonPencil, zoom: renderer.viewerState.zoom,
        noFoldCuts: renderer._noFoldCuts,
        thick: renderer.cartoonThickness, hxRel: renderer.cartoonHelixThRel,
        clipNear: renderer.clipNear, clipFar: renderer.clipFar,
    };
    // NOTHING IS CLIPPED WHILE CAPTURING, for the same reason nothing is
    // view-culled: this is harvesting GEOMETRY, not painting a frame. The 2D
    // pass drops whole primitives outside the slab - it cannot cut one - so a
    // mesh built while a clip was on would be missing every piece that straddles
    // a plane, and the shader would then cut what was left. Measured: a mesh
    // rebuilt under a slab drew 40,617 ink pixels where the same slab over a
    // complete mesh drew 41,520, and the missing 2% were exactly the boundary
    // pieces. The shader does the cutting; the mesh holds everything.
    // HOW MANY TIMES THE 2D PASS HAS BEEN RUN TO HARVEST GEOMETRY. This is the
    // expensive half of both a rebuild and a station frame, so "once per frame"
    // is a claim worth being able to check rather than assume.
    const capT0 = (typeof window !== 'undefined') ? performance.now() : 0;
    if (typeof window !== 'undefined') {
        window.__captures = (window.__captures || 0) + 1;
    }
    renderer.clipNear = null;
    renderer.clipFar = null;
    // GIVE THE FLAT PIECES A REAL THICKNESS, on this path only.
    //
    // Ribbon asks for thickness 0 and a richardson helix for exactly 0, and in
    // the 2D pass that is free: it paints polygons and a zero-thickness slab is
    // simply one polygon. This renderer rebuilds a SURFACE, and a piece with no
    // thickness has no outward direction - so it is carried as double-sided and
    // oriented at the eye every frame, which is where the awkward cases live:
    // normals whose sign means nothing, shared edges that are interior with
    // nothing to test, and a front face and a back face at identical depth.
    //
    // A fraction of an Angstrom makes each piece an ordinary closed solid and
    // all of that goes away by construction rather than by special case. Both
    // are floors, so raising Thick past them still does what it says, and both
    // are tunable: cartoonGpuRibbonThick / cartoonGpuHelixTh, either set to 0
    // to get the old geometry back.
    const rich = renderer.cartoonRichardson === true;
    const ribThick = typeof renderer.cartoonGpuRibbonThick === 'number'
        ? renderer.cartoonGpuRibbonThick : GPU_RIBBON_THICK;
    const hxTh = typeof renderer.cartoonGpuHelixTh === 'number'
        ? renderer.cartoonGpuHelixTh : GPU_RICH_HELIX_TH;
    if (rich) {
        if (hxTh > 0) renderer.cartoonHelixThRel = hxTh;
    } else if (ribThick > 0) {
        // 🔴 WHAT THE READER ASKED FOR SURVIVES THE FLOOR, because geom.js's
        // stick rule reads INTENT off this number - see _thickAsAsked there.
        renderer._thickAsAsked = renderer.cartoonThickness;
        renderer.cartoonThickness = Math.max(renderer.cartoonThickness || 0, ribThick);
    }
    // 🔴 AND NO ORIENTATION-FOLD CUTS, ON THIS PATH, ALWAYS.
    //
    // geom.js cuts a ribbon piece wherever the face or width normal crosses
    // zero. That cut is for a PAINTER THAT SORTS: a piece spanning a fold
    // carries its near half's depth key, and the painter then hoists the whole
    // footprint, folded-away part included, over lines plainly in front of it.
    // A depth buffer resolves that per fragment and needs none of it - so on
    // this path the cuts buy nothing, and they cost twice.
    //
    // They cost PRIMS: 201 pieces against 196 on 1UBQ, 1478 against 1454 on
    // 1TIM. And they cost REBUILDS, which is the expensive half: oB and oN
    // follow the geometry, so a cut MOVES when the structure does and the
    // face-to-station mapping moves with it. That is why a flatness drag still
    // rebuilt 2 or 3 times in 8 - at 0.7 the piece count went 201 -> 202 and
    // the station comparison correctly stood down.
    //
    // Measured with the outline ON, which is the case the caveat was about,
    // because a cut is also a piece boundary and piece boundaries are where the
    // outline is drawn: ink 8.77% either way on 1UBQ and 19.27% on 1TIM, and
    // 0.0000% of pixels moved, worst 1 level of 255. See
    // tests/station_foldcuts.py.
    //
    // 🔴 HERE AND NOT ON A BUTTON, which is where it used to be set.
    // This is a renderer flag geom.js reads on BOTH paths, so pinning it there
    // also took the cuts away from the 2D painter - which does sort, and does
    // need them. Set inside the capture and put back in the finally, it reaches
    // the mesh and nothing else.
    //
    // 🔴 AND AN ESCAPE HATCH THAT IS ALSO THE GATE. `_keepFoldCuts` puts them
    // back on this path, and tests/station_foldcuts.py is the reason it exists:
    // without it that probe sets _noFoldCuts, this line overrules it in both
    // arms, and the file compares a picture with itself and reports 0.0000% of
    // pixels moved - a perfect score from measuring nothing, which is the
    // failure mode this repository keeps paying for. With it the comparison is
    // real, and anyone who finds a structure where the cuts matter has a switch
    // rather than a patch.
    renderer._noFoldCuts = renderer._keepFoldCuts !== true;
    renderer._noViewCull = true;
    renderer._frameProbe = true;
    renderer._probeOnly = true;
    renderer._primProbe = null;
    renderer._posProbe = null;        // ...and the DRAWN position of each residue
    // ...AND THE CENTRE LINE BETWEEN THEM, which the selection mark traces so
    // it follows the ribbon's curve rather than chording it.
    //
    // 🔴 ASKED FOR ON EVERY BUILD, NOT ONLY WHEN SOMETHING IS SELECTED. This
    // path captures on a mesh REBUILD and selecting does not rebuild - that is
    // the whole point of the mesh cache - so a probe gated on the selection is
    // asked for at exactly the moments the answer is not wanted, and never at
    // the moment it is. It is recorded whenever the cartoon builds and kept in
    // the pre-rotation space, which is what makes it outlive the rebuild.
    //
    // Capped by size, and the renderer owns the cap: the 2D painter asks the
    // same question on its own path, and one number in two files is the drift
    // this codebase keeps paying for.
    renderer._traceProbe = (renderer._wantRibbonTrace
        && renderer._wantRibbonTrace()) ? null : undefined;
    // CAPTURED AT THE LIVE ZOOM, not at 1. The unprojection divides the view
    // scale back out, and it divides by whatever scale the renderer used - so
    // any zoom works, and everything zoom-INDEPENDENT comes back identical
    // either way.
    //
    // What is not zoom-independent is the ribbon's drawn THICKNESS: it fades
    // with projected size, so a ribbon small on screen really is drawn thinner
    // than the control says. The contact crop reads that thickness, and so does
    // the side-chain attachment. Capturing at zoom 1 while the 2D pass drew at
    // the live zoom therefore had the two renderers disagreeing about where a
    // contact ends - measured 0.24 A at zoom 0.5 on 1UBQ, and nothing at all at
    // zoom 1 and above, where the fade has saturated. Capturing at the zoom
    // being looked at makes the mesh agree with the 2D pass exactly, and the
    // draw divides that zoom out again so turning and zooming stay redraws.
    // ...and never with the grain: it is composited over the finished frame,
    // and there is no finished frame here.
    renderer.cartoonPencil = 0;
    setCapturing(true);
    try {
        window.py2dmolCartoon.render(renderer, nullCtx(w, h), w, h, colors);
        // READ THE PROBES HERE, inside the try. A return expression is
        // evaluated before `finally` runs, and `finally` puts every hook back
        // where it found it - so a caller reading renderer._posProbe afterwards
        // gets the value from BEFORE the capture, which is undefined. The drawn
        // positions were silently never collected, appPos stayed null, and the
        // per-frame re-projection returned immediately: the selection halo and
        // the sequence highlight kept whatever screen coordinates the last 2D
        // render had left, and drifted the moment the model turned.
        // ...and no capZoom: the zoom is inside the half-span the view span
        // multiplier is built from, so recording it here and dividing it out
        // at draw time would apply it twice.
        return { prims: renderer._primProbe || [], scale: renderer._viewScale,
            pos: renderer._posProbe, trace: renderer._traceProbe };
    } finally {
        if (typeof window !== 'undefined') {
            window.__captureMs = (window.__captureMs || 0) + (performance.now() - capT0);
        }
        setCapturing(false);
        renderer._noFoldCuts = keep.noFoldCuts;
        renderer._noViewCull = keep.noViewCull;
        renderer._frameProbe = keep.frameProbe;
        renderer._probeOnly = keep.probeOnly;
        renderer._primProbe = keep.primProbe;
        renderer._traceProbe = keep.traceProbe;
        renderer._posProbe = keep.posProbe;
        renderer.cartoonPencil = keep.pencil;
        renderer.viewerState.zoom = keep.zoom;
        renderer.cartoonThickness = keep.thick;
        renderer._thickAsAsked = undefined;
        renderer.cartoonHelixThRel = keep.hxRel;
        renderer.clipNear = keep.clipNear;
        renderer.clipFar = keep.clipFar;
    }
}

// Force the next render to rebuild. The app calls this when something changed
// that the signature cannot see - a style object replaced wholesale, a new
// structure loaded under the same name.
/**
 * A MESH, AS A VALUE.
 *
 * What a build produces is not one thing: two buffers, the instance count and
 * the depth range, the outline's count, whether every face can be repainted
 * from the palette, the drawn positions everything on top of the canvas is
 * re-projected from, the scene's radius, and the SIZE of the visibility
 * texture - which is per structure, and shrinks. Holding a mesh so it can be
 * put back means holding all of that, and the first version of this held most
 * of it: the visibility texture was left at whatever size the last BUILD chose,
 * so restoring a bigger mesh had every residue past the smaller one's end read
 * as hidden. Its fills vanished and its outline stayed - which is exactly what
 * it looked like.
 *
 * So the mesh is a value now and there is one function that installs one.
 * Build and restore both go through it, and a piece that is not in `capture`
 * cannot be forgotten by one path and not the other: there is only one path.
 */
function captureMesh(sig) {
    if (!sig || !resident || !lastFill) return null;
    return {
        sig,
        fill: lastFill,
        edges: lastEdges,
        edgeCount,
        resident,
        pal: appPalComplete,
        pos: appPos,
        stdDev: sceneStdDev,
        nBase: (resMap && resMap.nBase) || 0,
        scMap: (resMap && resMap.sidechainMap) || null,
        // 🔴 AND THE OUTLINE'S PROVENANCE AND LAYOUT, which are as much part of
        // a mesh as its buffers. `edSrc` is what refreshEdgesFromStations
        // rebuilds every edge row from, and the part spans are where each
        // group's rows landed in them. Neither was kept, so a restored mesh got
        // its own edge BUFFER back and then had it rewritten from the PREVIOUS
        // mesh's provenance - measured on _traj_3ptb.pdb by playing forward and
        // scrolling back to frame 0: the outline came back with 7,684 grey
        // pixels where the same frame drawn forward has 9,442, a fifth of it
        // simply missing.
        edSrc: residentEdges ? residentEdges.edSrc : null,
        edgeRich: edgeRichPreset,
        spans: residentPartSpans,
        // a SNAPSHOT: the arrays without the GL handles - see stationsSnapshot
        residentStations: stationsSnapshot(residentStations),
        hasContacts: residentHasContacts,
        bytes: lastFill.byteLength + (lastEdges ? lastEdges.byteLength : 0),
    };
}

function activateMesh(m) {
    if (!m || !gl || !buf3) return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf3);
    gl.bufferData(gl.ARRAY_BUFFER, m.fill, gl.STATIC_DRAW);
    if (m.edges && bufInk) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bufInk);
        gl.bufferData(gl.ARRAY_BUFFER, m.edges, gl.STATIC_DRAW);
    }
    edgeCount = m.edges ? m.edgeCount : 0;
    // ...and the two things the edge refresh reads, which travel with the mesh
    // they describe. See the note in captureMesh.
    residentEdges = (m.edges && m.edSrc) ? { ed: m.edges, edSrc: m.edSrc } : null;
    edgeRichPreset = !!m.edgeRich;
    residentPartSpans = m.spans || [];
    // 🔴 ALWAYS, AND FROM DATA. This assigned the cached table only when there
    // was one - so a mesh cached without a table left the OUTGOING table in
    // place beside it - and assigned it by reference, handles and all.
    activateStations(m.residentStations);
    residentHasContacts = !!m.hasContacts;
    resident = m.resident;
    appPalComplete = m.pal;
    appPos = m.pos;
    setStdDev(m.stdDev);
    // THE TWO THINGS SIZED BY THE STRUCTURE, not by the view: the residue map
    // a side-chain face is traced back through, and the visibility texture a
    // face is tested against. Both are per mesh and both shrink.
    setResidueMap({ nBase: m.nBase, sidechainMap: m.scMap });
    ensureVisTexture(m.nBase || 1);
    lastFill = m.fill;
    lastEdges = m.edges;
    srCache = null; srKey = '';
    return true;
}

/**
 * THE SPARE SLOT: one mesh, exchanged rather than read.
 *
 * Alternating between two pictures is what an eye is for, so the mesh coming
 * out swaps places with the one going in - a slot that is only ever read
 * leaves every second toggle rebuilding.
 */
function keepMesh(sig) {
    const m = captureMesh(sig);
    if (!m || m.bytes > MESH_CACHE_MAX_BYTES) {
        spareMesh = null;
        return;
    }
    spareMesh = m;
    meshCache.set(sig, m);
    let totalBytes = 0;
    for (const entry of meshCache.values()) totalBytes += entry.bytes;
    while (meshCache.size > 8 || totalBytes > MESH_CACHE_MAX_BYTES) {
        const oldestKey = meshCache.keys().next().value;
        const evicted = meshCache.get(oldestKey);
        totalBytes -= evicted.bytes;
        meshCache.delete(oldestKey);
    }
    if (typeof window !== 'undefined') {
        window.__spareMesh = spareMesh
            ? { sig: spareMesh.sig, bytes: spareMesh.bytes } : null;
    }
}

function restoreMesh(sig) {
    let m = (spareMesh && spareMesh.sig === sig) ? spareMesh : null;
    if (!m && meshCache.has(sig)) {
        m = meshCache.get(sig);
    }
    if (!m) return false;
    // 🔴 AND IT DOES NOT CARRY THE STATION TABLE. The slot holds a mesh -
    // fills, edges, centroids, the residue map - and on the station path the
    // ribbon's GEOMETRY is not in any of those: it is in the station textures,
    // which describe whatever frame was drawn last. So a restore is only half
    // the picture, and the caller must not let it claim the signature until
    // the other half has been written. See the note at the call site.
    keepMesh(appSig);              // the exchange
    spareMesh = m;
    return activateMesh(m);
}

function invalidate() {
    appSig = null; appColourKey = ''; appPalComplete = true; tubeSig = null;
    // ...AND THE SPARE WITH IT. invalidate() means the geometry is no longer
    // what any mesh was built for - a structure edited, a frame replaced - so
    // a mesh kept under a signature that happens to come round again would be
    // the old shape.
    spareMesh = null; meshCache.clear(); lastFill = null; lastEdges = null;
    // THE RIBBON HALF TOO. Its cache is keyed by a hash of its own faces, so
    // reusing it after this would in fact be correct - but invalidate() is
    // also what a probe calls to force a real rebuild, and holding a megabyte
    // of fills for geometry the page has been told to forget is not what
    // "invalidate" means.
    ribbonPart = null;
    otherPart = null;
    spareTube = null; tubeLive = null; tubeCount = 0;
    clearResident();
}

// THE TWO NUMBERS THAT FRAME THE VIEW, read the way the 2D renderer reads
// them (core/mol.js: the scale block, and _computeViewCentre). Orient writes
// both; a pan writes the centre. The fallbacks are the renderer's own.
function viewSpanOf(renderer) {
    // the extent of what is DRAWN - see drawnStats: with several objects
    // merged, the current object's is a fraction of the picture
    const o = (renderer.drawnStats && renderer.drawnStats())
        || (renderer.objectsData && renderer.objectsData[renderer.currentObjectName]);
    let c = renderer.viewerState.center;
    if (!c && renderer._computeViewCentre) c = renderer._computeViewCentre(o);
    // ...AND THE SHAPE. The base scale is not a function of the extent alone
    // any more - see spanFit below - so a view span that reported only the
    // extent could not say whether two of them wanted the same scale.
    // THE HALF-SPAN IS THE VIEW SPAN, and the renderer owns the one answer -
    // see _viewHalfSpan. It already carries the zoom, which is why the
    // multiplier below no longer divides that out separately.
    const half = renderer._viewHalfSpan
        ? renderer._viewHalfSpan(o)
        : { x: extent, y: extent };
    // ...and no `extent`: nothing reads it since the multiplier became a
    // ratio of half-spans, and a view span that reports two sizes is a view span
    // that can report them differently.
    return { centre: c ? [c.x, c.y, c.z] : [0, 0, 0], half };
}

/**
 * What a view span fits to, up to the padding: `min(w / 2hx, h / 2hy)`.
 *
 * A ratio of two of these IS the ratio of the scales they ask for, so the
 * view-span multiplier below is one division. It used to be the extents' ratio
 * times a separate term for the shape times a third for the zoom - three ways
 * for a cached mesh to be drawn at the wrong size, and two of them were.
 */
function spanFit(displayWidth, displayHeight, half) {
    const hx = (half && half.x > 0) ? half.x : 1;
    const hy = (half && half.y > 0) ? half.y : 1;
    return Math.min(displayWidth / (hx * 2), displayHeight / (hy * 2));
}

// THE SAME PROJECTION THE 2D TAIL DOES, from the captured model-space drawn
// positions. Display pixels, because that is the space every consumer of
// screenX/screenY works in.
function projectPositions(renderer, dw, dh) {
    const n = renderer.coords ? renderer.coords.length : 0;
    if (!appPos || !renderer.screenX || renderer.screenX.length < n) return;
    const R = currentRot();
    const persp = isPersp();
    const fl = focalLength();
    // EXACTLY WHAT THE FILLS ARE DRAWN AT, in display pixels: the mesh's scale
    // carries the zoom and the view span it was captured under, and drawScale
    // divides both out and applies the live ones. A halo that used a different
    // scale from the picture it sits on is a halo in the wrong place.
    const sc = drawScale() / pixelRatio;
    const cx = dw / 2;
    const cy = dh / 2;
    renderer.screenFrameId++;
    const fid = renderer.screenFrameId;
    // THE VISIBILITY MASK IS A SET, and the renderer's own test for it is
    // `!mask || mask.has(i)`. Indexing it like an array - which is what this
    // did - returns undefined for EVERY residue, so every one was marked
    // invalid and no screen position was ever written. The arrays then kept
    // whatever the last 2D render left in them: exactly right until the model
    // turned, and steadily wrong afterwards. Precisely the fault this function
    // exists to fix, reintroduced one line below the fix.
    const mask = renderer.visiblePositions;
    // ...and a SELECTED position is projected whether or not it is drawn: the
    // band over it says where the selection is, which is worth most when the
    // thing itself is hidden. See _projectForPicking, which does the same.
    const marked = renderer.selectionInk ? renderer.selectionInk() : renderer.residueSelection;
    const shown = (i) => !mask || (mask.has ? mask.has(i) : !!mask[i])
        || !!(marked && marked.has(i));
    const lw = (renderer.lineWidth || 3.0) * sc;
    for (let i = 0; i < n; i++) {
        const o = i * 3;
        if (o + 2 >= appPos.length || !(appPos[o] === appPos[o])) {
            renderer.screenValid[i] = 0;
            continue;
        }
        if (!shown(i)) { renderer.screenValid[i] = 0; continue; }
        const x = appPos[o] + viewShift[0];
        const y = appPos[o + 1] + viewShift[1];
        const z = appPos[o + 2] + viewShift[2];
        const vx = R[0][0] * x + R[0][1] * y + R[0][2] * z;
        const vy = R[1][0] * x + R[1][1] * y + R[1][2] * z;
        const vz = R[2][0] * x + R[2][1] * y + R[2][2] * z;
        let pe = 1;
        if (persp) {
            const dz = fl - vz;
            if (dz <= 0.1) { renderer.screenValid[i] = 0; continue; }
            pe = fl / dz;
        }
        renderer.screenX[i] = cx + vx * sc * pe;
        renderer.screenY[i] = cy - vy * sc * pe;
        // the renderer's own rule for both radii - see _positionRadiiPx, and
        // the note beside the same call in cartoon/geom.js. wm 0.5 is this
        // line's own `lw * 0.25 * pe`.
        const rr = renderer._positionRadiiPx
            ? renderer._positionRadiiPx(i, lw, 0.5, pe, sc) : null;
        renderer.screenRadius[i] = rr ? rr.pick : Math.max(2, lw * 0.25 * pe);
        if (rr && renderer.screenDrawRadius) renderer.screenDrawRadius[i] = rr.drawn;
        renderer.screenValid[i] = fid;
    }
}

/* The entry itself. Returns true if it drew, false if the caller should fall
 * back to the 2D path - which it must be able to do, because WebGL2 can be
 * absent, the context can be lost, and a shader can fail to link on a driver
 * nobody has tested.
 */
// WHETHER THE PALETTE CHANGED. This used to be a full digest - every colour
// hashed, every frame - on the reasoning that "the app keeps ONE colours array
// and recomputes it in place, so the reference never moves".
//
// That reasoning was wrong about core/mol.js. `this.colors` is only ever
// ASSIGNED, always a fresh array out of _calculateSegmentColors or
// _calculatePlddtColors, and there is no in-place colour edit anywhere in the
// file. So the pointer DOES move whenever the contents change, and identity
// answers the question exactly - which the line below already half-relied on,
// testing `colors !== appColors` beside the digest.
//
// Measured at 320,000 positions the digest was 10.3 ms of a ~20 ms frame,
// walking 300,000 colour objects to conclude that none of them had changed.
// See tubeKeyOf, which makes the same argument at greater length.

// HOW BIG THE DRAWING BUFFER MAY BE, and whether it came out that big.
//
// A canvas larger than the driver's limit does not fail: the drawing buffer is
// CLAMPED and canvas.width goes on reporting what was asked for, so the blit
// would silently scale a small picture up. A 1200 dpi export of a wide viewport
// asks for 16,000 px; a laptop's limit is often 8,192 or 16,384. Where it does
// not fit, this says so and the 2D path draws the export instead - which is
// what it did for every export before this.
function bufferFits(w, h) {
    if (!gl) return true;                 // nothing made yet; the caller inits
    return gl.drawingBufferWidth === w && gl.drawingBufferHeight === h;
}

function renderApp(renderer, ctx, displayWidth, displayHeight, colors, compose) {
    if (!window.py2dmolCartoon || typeof document === 'undefined') return false;
    // ONE PAINTER OF A COMPOSED FRAME, when the caller says so: do not clear
    // what the other one drew, share its depth range, and leave the blit to
    // whoever goes last. See composeKeepFrame.
    composeKeepFrame = !!(compose && compose.keep);
    composeZ = (compose && compose.z) || null;
    // ANY 2D CANVAS, AT ITS OWN SIZE - the screen's, or the one saveImage makes
    // for an export. An SVG context is still the 2D path's: there is no vector
    // to hand back from a raster. See appSizeFor for the rest of the argument.
    if (!ctx || !ctx.canvas || !ctx.drawImage || ctx.getSerializedSvg) return false;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    if (!(w > 0 && h > 0)) return false;
    // 🔴 DO NOT BUILD A MESH FOR A SIZE NOBODY CHOSE.
    //
    // parts/viewport.js sets this while the container measures nothing - the
    // state index.html is in until a structure arrives, because the viewer
    // lives inside a `display: none` parent until then. The canvas size is
    // config.display.size, everything built at it is thrown away when the
    // viewer is shown, and on a large structure that is a whole mesh nobody
    // ever saw.
    //
    // DECLINING, NOT SKIPPING THE FRAME. false is the answer this path gives
    // whenever it cannot help, and the 2D renderer draws instead - so a hidden
    // container still produces pixels, which tests/render_page.py,
    // tests/embed.py and tests/colab.py depend on. What is saved is facesOf,
    // buildMeshPart and the uploads.
    //
    // An embed has no #canvasContainer to measure and is never provisional; an
    // export composes and is exempt.
    if (ctx.canvas.__viewportProvisional && !compose) return false;
    try {
        if (!appCv) {
            appCv = document.createElement('canvas');
            // A LOST CONTEXT IS NOT RECOVERABLE ON THE SAME CANVAS. getContext
            // hands back the same dead object, so initGL "succeeds" and every
            // call after it silently does nothing - the toggle stays on and
            // the acceleration is gone. Drop the canvas instead and build a
            // fresh one, which is what the failure path below does too.
            appCv.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                appCv = null; appSig = null; clearResident(); clearGL();
            });
        }
        const sizeMoved = appCv.width !== w || appCv.height !== h;
        if (sizeMoved) { appCv.width = w; appCv.height = h; }
        // A RESIZE DOES NOT DROP THE CONTEXT, but the first call must make one.
        const hadGl = !!gl;
        if (!gl && !initGL(appCv)) return false;
        // 🔴 AND A RESIZE NO LONGER THROWS THE MESH AWAY. This was
        // `if (fresh) appSig = null` with `fresh` covering a size change, which
        // is what made every drag of a viewer's corner a full rebuild - on a
        // single-frame structure, where there is no station path to absorb it,
        // that is the whole cost of the resize. Nothing in the mesh is a
        // function of the canvas: it is built in model space and drawn through
        // a scale that carries the canvas it was captured on. Only a NEW
        // context has lost its buffers.
        if (!hadGl) appSig = null;
        // ...and the SPARE IS DROPPED, because it holds a mesh captured on the
        // old canvas and the slot is found by SIGNATURE. Come back to a
        // signature that was current before the resize - clear a contact, hide
        // an object and show it again - and the restore hands back that mesh,
        // and the frame drawn from it is not this canvas's frame. Measured
        // through tests/embed.py, which does exactly that: setContacts([]) left
        // a picture that did not match the one before the contacts, every run,
        // and dropping the slot here makes it match every run.
        //
        // 🔴 THE RESIDENT MESH IS KEPT AND THE SPARE IS NOT, which looks
        // inconsistent and is not: the resident one carries capW/capH and the
        // draw's ratio corrects for them (that is what makes a resize a redraw
        // at all), while the spare is a SECOND answer to a question the
        // signature no longer distinguishes. One mesh in the slot cannot be
        // right for two canvases.
        if (sizeMoved) { spareMesh = null; meshCache.clear(); }

        if (!bufferFits(w, h)) return false;
        setRot(renderer.viewerState.rotation);
        setOrtho(renderer.viewerState && renderer.viewerState.ortho);
        setZoomExact((renderer.viewerState && renderer.viewerState.zoom) || 1);
        // DEVICE PIXELS PER CSS PIXEL - and for an export that is 1, not k.
        // The mesh is CAPTURED by running the 2D pass at the export's own size,
        // so the k is already in the geometry; multiplying it in again here
        // drew the structure three times too large in a 300 dpi frame while
        // 96 dpi was pixel-correct. What _exportPxScale still has to do is done
        // where it was always done: inside the capture.
        setPixelRatio(displayWidth > 0 ? w / displayWidth : 1);
        setClearAlpha(renderer.isTransparent ? 0 : 1);
        setFocalLength(renderer.viewerState && renderer.viewerState.focalLength);
        // the clip slab, in the same view space the geometry is drawn in
        setClipSlab(renderer.clipSlabOn && renderer.clipSlabOn() ? renderer.clipNear : 0,
            renderer.clipSlabOn && renderer.clipSlabOn() ? renderer.clipFar : 0,
            renderer.clipFadeWidth ? renderer.clipFadeWidth() : 0);
        // dark mode is the renderer's background, exactly as the 2D pass reads it
        const dark = renderer.backgroundColor === '#000000';
        setPaper(dark ? [0, 0, 0] : [255, 255, 255], dark ? 255 : 0);
        const prm = paramsFromRenderer(renderer);

        // 🔴 THE CANVAS IS THE LAST TERM AND IT IS SEPARABLE, so a frame that
        // differs ONLY by the size of the box can be told apart from one that
        // differs by anything else. Everything else in the key describes the
        // mesh; the size describes the camera.
        const sigBody = signatureOf(renderer, 0, 0, colors);
        const sig = sigBody + '|wh' + w + 'x' + h;
        // ...and if that is all that moved, the mesh already in hand IS this
        // frame's mesh. Adopt the key and fall through to the draw - no
        // rebuild, no station update, nothing to go stale, because nothing
        // about the geometry has changed. tests/resize_reuse.py measures the
        // picture this produces against the same frame rebuilt.
        if (sig !== appSig && resident && appSig
            && String(appSig).slice(0, String(appSig).lastIndexOf('|wh')) === sigBody) {
            appSig = sig;
        }
        // ...and the topology-only key only when something could use it. It is a
        // second full key built from a dozen terms, every frame, and with the
        // station path off nothing ever compares it.
        let topoSig = stationDraw ? signatureOf(renderer, w, h, colors, true) : null;
        // ...AND IS IT THE ONE WE PUT DOWN A MOMENT AGO? Switching an object
        // off and on again alternates between two meshes, and rebuilding each
        // time runs the whole 2D pass and the outline pass for geometry that
        // has not changed. Coming back to a mesh already built is two uploads.
        // WORTH KEEPING A MESH AT ALL? Only where an eye can switch one off
        // and on again, which means more than one object on the page.
        // ...on always: MESH_KEEP_MAX_BYTES is the cap that matters, and a
        // single-object page alternates as much as a multi-object one.
        setKeepMeshArrays(true);
        // 🔴 A TRAJECTORY GETS THE STATION TABLE WITHOUT BEING ASKED, and it
        // is a claim about nothing: where the face-to-station mapping happens
        // to hold, the frame is updated in place; where it does not,
        // stationsMatch says so and the frame rebuilds exactly as it would
        // have.
        //
        // 🔴 AND "THE PICTURE IS THE SAME EITHER WAY" IS NOT ESTABLISHED. This
        // used to say so and cite tests/station_integrated.py - which only ever
        // ran the table BESIDE the removed Keep SSE pin, so the unpinned case
        // it was being credited with was never compared. Run unpinned on
        // _traj_unfold.pdb it reports 0.083% of pixels differing from a rebuild
        // of the same frame, worst channel 223, and the same numbers appear on
        // the commit before Keep SSE was removed. So the auto-enable ships a
        // configuration whose correctness nothing checks. OPEN, and the first
        // thing docs/FRAME_STABILITY.md says to fix.
        //
        // The table is worth having on any trajectory:
        // Interleaved medians of four, both orders:
        //
        //     _traj_1tim.pdb    17.26 ms a step -> 13.45   (14 of 29 steps)
        //     _traj_unfold.pdb   3.88 ms        ->  2.63   (23 of 29)
        //     _traj_1ehz.pdb     5.63 ms        ->  2.94   (7 of 7)
        //
        // A nucleic trajectory never moves its assignment at all, so the
        // mapping holds for every step of it.
        //
        // ONLY EVER SWITCHED ON HERE. Turning it off automatically would undo
        // the slider latch (see wantStationTable in parts/ui.js) and the
        // button; both of those own the off switch, and a single structure
        // still pays nothing until something asks.
        //
        // `renderer._autoStationTable = false` turns this off, and three gates
        // need it: they measure the station path AGAINST a trajectory with no
        // table, and that baseline stops existing the moment this is automatic.
        // A switch is better than each of them reaching for setStationDraw and
        // having it undone on the next frame.
        // ...and a different structure is a fresh question
        if (stationGaveUpFor !== null
            && stationGaveUpFor !== renderer.currentObjectName) {
            stationGaveUpFor = null;
        }
        if (!stationDraw && renderer._autoStationTable !== false
            && stationGaveUpFor !== renderer.currentObjectName) {
            const ob = (renderer.objectsData || {})[renderer.currentObjectName];
            if (ob && ob.frames && ob.frames.length > 1) {
                setStationDraw(true);
                stationAuto = true;
                stationTries = 0;
                stationEverFast = false;
                // 🔴 AND THE TOPOLOGICAL KEY WITH IT, OR THE FIRST FRAME OF A
                // TRAJECTORY COSTS TWO REBUILDS. It is computed above, where
                // stationDraw was still false, so it was null - and the build
                // that follows records a null key. The next frame then finds
                // "there was no previous topological key to compare against"
                // and rebuilds a second time to record one. Two builds at the
                // start of every playback, which is how it was reported:
                // "video still rebuilding at times when first played".
                topoSig = signatureOf(renderer, w, h, colors, true);
            }
        }
        // 🔴 A RESTORED MESH DOES NOT CLAIM THE SIGNATURE WHILE THE STATION
        // TABLE STILL DESCRIBES ANOTHER FRAME. The slot holds the fills, the
        // edges and the centroids; on the station path the ribbon's geometry is
        // in neither - it is in the station textures, and those still hold
        // whatever was drawn last. Claiming the signature here told the station
        // branch below that nothing had changed, so it never wrote them: this
        // frame's rows and flags on the last frame's stations, 10.27% of the
        // picture at a worst channel of 214 on the first wrap of a playback of
        // _traj_1bna.pdb, and once per wrap for as long as the slot was filled.
        //
        // 🔴 AND THE RESTORE ITSELF IS KEPT, which the first version of this
        // fix threw away by declining outright - and tests/rebuild_actions.py
        // caught it: toggling side chains off returns to the picture from two
        // steps ago, and the slot is exactly what makes that a swap rather than
        // a rebuild. Leaving `appSig` alone costs one station update, which is
        // two texture writes, and is what that branch does anyway.
        const restored = sig !== appSig && restoreMesh(sig);
        // ...and the probe's escape hatch, so the gate can put the fault back
        // and watch itself fail. tests/outline_sync.py --stale-restore.
        const stationsOwe = restored && stationDraw && !!residentStations
            && !window.__allowStaleRestore;
        if (restored) {
            if (!stationsOwe) appSig = sig;
            appTopoSig = topoSig;
            appColors = colors;
            appColourKey = colourKeyOf(colors);
            // 🔴 THE PALETTE IS WHAT THE RIBBON RESOLVED, WHERE IT RESOLVED
            // ONE. geom publishes renderer._cartoonPalette in ss mode and under
            // per-residue overrides - the colours it actually drew, indexed the
            // way the texture is - and null everywhere else, where colors is
            // already right. Read through a function so a later repaint picks
            // up whatever the last build resolved rather than a copy taken now.
            setPaletteSource(() => {
                // 🔴 RESOLVED ON DEMAND, so a repaint does not need a build.
                // geom publishes _cartoonPalette while it draws, which is why
                // entering ss mode used to rebuild: the colours only existed
                // after a mesh had been made. resolveSegmentColors answers the
                // same question from the assignment, the palette and each
                // segment's two residues - no geometry - so a colour change
                // into or out of ss is a texture upload like every other one.
                // It returns null for anything but plain ss, and null while an
                // override is in play, which is the case that must rebuild.
                const C = window.py2dmolCartoon;
                const live = (C && C.resolveSegmentColors)
                    ? C.resolveSegmentColors(renderer, appColors) : null;
                // NOT renderer._cartoonPalette as a fallback: it is written
                // by the draw pass and survives a mode change that did not
                // rebuild, so falling back to it repainted ss colours onto a
                // chain frame - 7.84% of the picture, worst channel 152. The
                // resolver answers for every case that needs one, and appColors
                // is the answer when it returns null.
                return live || appColors;
            });
            setDefaultParams(() => paramsFromRenderer(renderer));
            setResidueMap({ nBase: renderer.coords.length,
                sidechainMap: renderer.sidechainMap || null });
            setSize(displayWidth, displayHeight);
            if (typeof renderer._ensureRotated === 'function') renderer._ensureRotated();
            recolour();
        }
        currentModelCenter = modelCenterOf(renderer);
        currentCapCentre = viewSpanOf(renderer).centre;
        let stationFast = false;
        stationDecline = null;
        // ...and the cover count with it: it describes THIS frame's table and
        // a stale one would let a build skip rows that will be drawn.
        stationCoverCount = -1;
        stationCoverMesh = null;
        // never across a frame boundary - see heldCapture
        heldCapture = null;
        // 🔴 AND THE STATION MESH THE FAST PATH BUILT, for the rebuild that may
        // follow. A declining step used to capture the frame THREE times: once
        // for the mapping comparison, once for the rebuild, and once more to
        // reinstall the table afterwards. The third is this one, and the mesh
        // it needs has already been computed - from the same prims, by the same
        // function - a few hundred lines above.
        let stationMeshThisFrame = null;
        // 🔴 THE TRAJECTORY FAST PATH, AND IT ARMS ITSELF.
        // A frame change moves the atoms and nothing else: the face list, the
        // flags, the colours and the palette are all still right, so the mesh
        // does not have to be rebuilt - only the two geometry textures written.
        //
        // 🔴 THIS USED TO SAY "DEAD CODE UNLESS ASKED FOR" AND IT IS NOT TRUE
        // ANY MORE. The auto-switch a hundred lines above turns stationDraw on
        // for any object with more than one frame, so a trajectory takes this
        // path without anyone pressing anything. What is still true is the half
        // that matters: a SINGLE structure never steps, never arms the switch,
        // and pays nothing for any of it.
        // Measured on a 30-frame trajectory of 1TIM: 12.0 ms a step against
        // 4.0, with the picture the same to 0.0002% of pixels
        // (tests/station_frames.py).
        //
        // Three things have to hold, and each of them is a way this would
        // otherwise be wrong:
        //
        //   stationDraw       the table is on - because the object has frames
        //                     and the switch armed itself, or because the
        //                     slider latch or the button asked. Only ever
        //                     turned ON automatically; the off switch belongs
        //                     to the two callers that own it.
        //   topology unchanged  everything but the coordinates is the same. If
        //                     a colour or an eye or the canvas moved, the
        //                     instance row is stale and only a rebuild fixes it.
        //   updateStations    the face-to-station MAPPING survived. geom.js
        //                     cuts at orientation folds, which follow the
        //                     geometry, so a cut can move and the row then
        //                     points at the wrong slice. It compares, and says
        //                     no when it must - and this falls straight through
        //                     to the rebuild below.
        // 🔴 THE OUTLINE MOVES TOO, NOW. It used to be the reason this declined
        // whenever outlines were on - drawInk's instance buffer is edge
        // endpoints and face normals in model space, and nothing updated it, so
        // the ribbon moved and its outline did not: 5.4% of pixels at worst
        // 224. updateStations rewrites those twelve floats a row from the same
        // stations, using the provenance the edge pass records.
        // ...and when it does not match, WHICH TERM moved. A topology key that
        // shifts on a frame change is a rebuild nobody asked for, and the key is
        // a dozen terms joined by a bar - so this names the index rather than
        // leaving a reader to diff two long strings. It found the one that
        // mattered: the segment COUNT, 3336 to 3337 and back, twice a cycle,
        // because one CA-CA pair sat on the connectivity threshold and the
        // trajectory pushed it across.
        if (!stationDraw) {
            stationDecline = 'the station path is off (setStationDraw)';
        } else if (!appTopoSig) {
            stationDecline = 'there was no previous topological key to compare'
                + ' against - the last frame did not leave one';
        }
        if (stationDraw && topoSig !== appTopoSig && appTopoSig) {
            const a = String(appTopoSig).split('|');
            const b = String(topoSig).split('|');
            const at = [];
            for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
                if (a[i] !== b[i]) at.push(`${i}: ${a[i]} -> ${b[i]}`);
            }
            window.__topoMoved = at;
            stationDecline = 'the topological key moved at ' + at.join('; ');
        }
        // 🔴 AND THE TABLE MUST COVER THE WHOLE MESH, NOT A PREFIX OF IT.
        //
        // The table describes rib prims - the backbone and, since base plates
        // were given a frame, the base plates. Everything else is a STICK: side
        // chains, ligands, contacts, lone atoms. Those rows sit after the
        // ribbon in the concatenation and drawResident issues them from the
        // buffer exactly as they were built, which is right on the frame they
        // were built for and wrong on every frame after it. Measured on
        // _traj_1tim.pdb with 74 side chains shown: the steps that took this
        // path drew them 1.53% of the frame out of place, at a worst channel of
        // 224, standing still while the backbone moved.
        //
        // installStations already argued this and then it was not done: "a path
        // that quietly drops a whole class of geometry is worse than one that
        // declines". A stale row is the same fault as a dropped one.
        //
        // Declining costs nothing on the structures this path exists for - a
        // protein or a nucleic trajectory with no side chains showing has a
        // tail of exactly zero rows (6927 of 6927 on 1TIM, 1238 of 1238 on a
        // tRNA, 1795 of 1795 on the unfolding one). It costs the speedup when
        // side chains or ligands are on screen, which is the correct trade
        // until those get a table of their own.
        const tail = resident ? resident.count - (residentStations
            ? residentStations.count : 0) : 0;
        // 🔴 EVERY WAY PAST THIS BRANCH HAS TO HAVE A NAME. The four conditions
        // below are each a decline, and two of them - no resident mesh, no
        // station table - were not named by anything above: a frame that
        // rebuilt for one of those reported "no reason recorded", which is the
        // fault stationDecline was added to fix, one layer further in.
        if (sig !== appSig && !stationDecline) {
            if (!resident) {
                stationDecline = 'there is no resident mesh to update';
            } else if (!residentStations) {
                stationDecline = 'there is no station table: '
                    + (stationRefusal || 'installStations did not run');
            }
        }
        // 🔴 WHY THIS GATE SAID NO, named. A frame that takes neither the
        // station path nor a rebuild draws the PREVIOUS frame's geometry under
        // this frame's coordinates, and the counters for the two paths both
        // read zero - so the reason has to be recorded where the decision is
        // made. See tests/outline_sync.py --play, the first wrap after Play.
        if (typeof window !== 'undefined' && window.__gateProbe) {
            window.__gateWhy = {
                // the two strings themselves, because "they are equal" is not
                // the same fact as "they should have been"
                sigNow: String(sig), sigWas: String(appSig),
                sigSame: sig === appSig,
                noResident: !resident,
                noStations: !residentStations,
                notDrawing: !stationDraw,
                topoMoved: topoSig !== appTopoSig,
            };
        }
        // 🔴 A RESIZE IS A REDRAW FOR THE RIBBON AND NOT YET FOR THE TAIL. The
        // ribbon's stations are model space and the draw's scale carries the
        // canvas the mesh was captured on, so a resized frame reuses them
        // exactly - 0.0000% against the same frame rebuilt on 1UBQ.
        //
        // The tail is rebuilt by refreshSticksFrom, which UNPROJECTS the
        // capture's quads with the scale it is handed - so that scale has to be
        // the one the capture was projected at. `resident.scale` is the mesh's,
        // which is right until the canvas moves. Two other numbers were tried
        // and neither is it: the capture's own `scale` field, which on a GPU
        // frame is the PREVIOUS frame's drawScale (the 2D block that would set
        // it does not run), and the live span fit, which is what the frame is
        // DRAWN at rather than what it was projected at. On 1EHZ's nine ions
        // those read 1.41% and 1.20% of the frame at a worst channel of 255,
        // against 1.92% doing nothing - closer, and not right.
        //
        // So while there is a tail, a canvas change declines and rebuilds. What
        // it needs is the scale the 2D pass actually projected the capture at,
        // recorded by captureFrom rather than inferred here.
        const canvasMoved = !!resident && resident.capW !== undefined
            && (resident.capW !== displayWidth || resident.capH !== displayHeight);
        if (stationDraw && canvasMoved && tail && !stationDecline) {
            stationDecline = `the canvas moved to ${displayWidth}x${displayHeight}`
                + ` and ${tail} rows are a tail, which is rebuilt by unprojecting`
                + " this frame's capture at the MESH's scale and cannot follow";
        }
        if (sig !== appSig && resident && residentStations && stationDraw
            && topoSig === appTopoSig && !(canvasMoved && tail)) {
            const mesh = stationMeshNow(renderer, displayWidth, displayHeight, colors);
            stationMeshThisFrame = mesh;
            // 🔴 AND THE TAIL IS REBUILT BEFORE THE RIBBON IS TOUCHED. The
            // station table describes rib prims; side chains, ligands and
            // contacts have no stations and were being issued from the frame
            // the mesh was built at - 1.53% of the frame on 1TIM with 74 side
            // chains out. refreshSticksFrom rewrites just those two parts.
            //
            // FIRST, because it is the one that can refuse: it validates every
            // span before it writes, so a refusal leaves the buffers untouched
            // and this falls back to a full rebuild with nothing half-applied.
            // updateStations, by contrast, has already rewritten the textures
            // by the time it can tell you it worked.
            lastStickRefresh = null;
            // ...and the cheap question first: if the ribbon's own mapping has
            // moved this frame rebuilds regardless, and rebuilding the sticks
            // on the way to finding that out is pure waste.
            const matched = !!mesh && stationsMatch(mesh);
            // ...and when it did not match, what a splice would have been.
            // Recorded whether or not anything acts on it, so the shape of the
            // decline can be sized before it is relied on.
            lastSplicePlan = matched ? null : stationSplicePlan(mesh);
            if (!mesh) {
                stationDecline = 'the capture produced no mesh: '
                    + (stationRefusal || 'stationMeshOf returned nothing');
            } else if (!matched) {
                stationDecline = 'the station mapping moved: '
                    + (lastStationUpdate || 'no reason recorded');
            }
            const tailOk = !matched || tail <= 0
                || refreshSticksFrom(mesh.prims, resident.scale, prm);
            if (!tailOk) {
                stationRefusal = `${tail} of ${resident.count} rows are not`
                    + ' described by stations, and rebuilding them failed: '
                    + (lastStickRefresh ? lastStickRefresh.why : 'no mesh');
                stationDecline = stationRefusal;
            }
            if (mesh && matched && tailOk && updateStations(mesh)) {
                // 🔴 AND THE OVERLAY MOVES WITH THE PICTURE. Committed only on
                // the branch that actually took the step: on the other one the
                // frame is rebuilt below and fills these itself.
                const np = modelPositions(mesh.pos);
                if (np) { appPos = np; window.__gpuPosCount = mesh.pos.length; }
                appSig = sig;
                appColors = colors;
                // 🔴 AND THE COLOURS ARE UPLOADED, NOT MERELY RECORDED. This
                // assigned `appColourKey = colourKeyOf(colors)` and stopped,
                // which tells the branch below - the one that turns a colour
                // change into three texels per segment - that these colours
                // are already on the card. They are not: `updateStations`
                // rewrites POSITIONS. So a frame whose colours changed while
                // the mesh held still kept the colours of the last real BUILD,
                // and the key said so from then on, permanently.
                //
                // Reported through LocalFold as an AlphaFold 3 fold's pLDDT
                // not reaching the structure. Its sampler frames are written
                // with a ZERO B-factor on purpose and the finished one carries
                // the confidence head's answer, so stepping to the last frame
                // is a colour change over a resident mesh - exactly this. It
                // was invisible during a live fold, where every frame is added
                // and therefore rebuilt, and appeared after a session restore,
                // where the mesh is resident and the station path takes every
                // step. Measured: frame 14 (pLDDT 0) drew the finished frame's
                // green, and only `invalidate()` put the red back.
                const stationKey = colourKeyOf(colors);
                if (stationKey !== appColourKey) {
                    appColourKey = stationKey;
                    if (appPalComplete) {
                        recolour();
                    } else {
                        // Baked colours: the mesh carries them per instance, so
                        // there is no texture to repaint and this frame has to
                        // be built. Same answer the colour-only branch gives.
                        appSig = null;
                        heldCapture = null;
                        return renderApp(renderer, ctx, displayWidth,
                                         displayHeight, colors);
                    }
                }
                stationFast = true;
                stationEverFast = true;   // it paid once; it stays for good
                // ...and the capture goes with it: nothing below will rebuild,
                // and the prims are the largest thing a frame holds.
                heldCapture = null;
                window.__stationFastPath = (window.__stationFastPath || 0) + 1;
            } else {
                window.__stationSlowPath = (window.__stationSlowPath || 0) + 1;
                if (!stationDecline) {
                    stationDecline = 'updateStations refused after the mapping'
                        + ' matched: ' + (lastStationUpdate || 'no reason'
                            + ' recorded');
                }
            }
        }
        // 🔴 A DECLINE ON A STRUCTURE THE TABLE HAS NEVER HELPED. Twelve of
        // those and it stops being offered for this object - see stationTries.
        // Counted here rather than inside the branch above because a frame can
        // decline before it gets that far (no previous key, a mapping that
        // moved), and every one of those is the same answer.
        if (stationAuto && stationDraw && !stationFast && !stationEverFast
            && sig !== appSig) {
            stationTries += 1;
            if (stationTries >= STATION_TRY_LIMIT) {
                stationGaveUpFor = renderer.currentObjectName;
                stationAuto = false;
                stationTries = 0;
                setStationDraw(false);
                clearResidentStations();
                if (typeof window !== 'undefined') {
                    window.__stationGaveUp = (window.__stationGaveUp || 0) + 1;
                }
            }
        }
        // 🔴 IT FALLS THROUGH TO THE ORDINARY ENDING, and does not draw for
        // itself. drawResident and the blit are forty lines below with the AO
        // options and the compose rules beside them; a fast path that returned
        // early would be a second copy of all of that, drifting from the first
        // the moment either is touched. All it does is skip the rebuild.
        if (!stationFast && (sig !== appSig || !resident)) {
            // ...and whatever the station path was holding describes the mesh
            // about to be replaced. See useStations in drawResident.
            if (residentStations) residentStations.stale = true;
            // the mesh about to be replaced goes in the spare slot, so the way
            // back is an upload rather than a build
            keepMesh(appSig);
            // THE ONE THING ON THIS PATH THAT DOES NEED rotatedCoords. The
            // renderer skips its rotation loop when it expects the GPU to take
            // the frame (see _renderToContext), and a steady frame here never
            // touches the array - but a REBUILD does, twice: the scene radius
            // below is measured from it, and captureFrom runs the whole 2D
            // renderer, which is built on it. Settle the debt before either.
            if (typeof renderer._ensureRotated === 'function') renderer._ensureRotated();
            // THE RESIDUE MAP, so a side-chain face knows which residue owns it.
            // The app numbers side-chain positions above the backbone and keeps
            // the mapping on the renderer, which is the same shape the harness
            // builds for itself.
            setResidueMap({ nBase: renderer.coords.length,
                sidechainMap: renderer.sidechainMap || null });
            // DISPLAY pixels, not device: that is the space the 2D renderer
            // projected into and so the space the unprojection has to undo.
            setSize(displayWidth, displayHeight);
            // 🔴 THE PALETTE IS WHAT THE RIBBON RESOLVED, WHERE IT RESOLVED
            // ONE. geom publishes renderer._cartoonPalette in ss mode and under
            // per-residue overrides - the colours it actually drew, indexed the
            // way the texture is - and null everywhere else, where colors is
            // already right. Read through a function so a later repaint picks
            // up whatever the last build resolved rather than a copy taken now.
            setPaletteSource(() => {
                // 🔴 RESOLVED ON DEMAND, so a repaint does not need a build.
                // geom publishes _cartoonPalette while it draws, which is why
                // entering ss mode used to rebuild: the colours only existed
                // after a mesh had been made. resolveSegmentColors answers the
                // same question from the assignment, the palette and each
                // segment's two residues - no geometry - so a colour change
                // into or out of ss is a texture upload like every other one.
                // It returns null for anything but plain ss, and null while an
                // override is in play, which is the case that must rebuild.
                const C = window.py2dmolCartoon;
                const live = (C && C.resolveSegmentColors)
                    ? C.resolveSegmentColors(renderer, appColors) : null;
                // NOT renderer._cartoonPalette as a fallback: it is written
                // by the draw pass and survives a mode change that did not
                // rebuild, so falling back to it repainted ss colours onto a
                // chain frame - 7.84% of the picture, worst channel 152. The
                // resolver answers for every case that needs one, and appColors
                // is the answer when it returns null.
                return live || appColors;
            });
            setDefaultParams(() => paramsFromRenderer(renderer));
            appColors = colors;
            appColourKey = colourKeyOf(colors);
            // THE SCENE'S RADIUS, which is what sets the focal length and so the
            // whole perspective. RMS about the centroid, the renderer's own
            // measure - see focalLength().
            const co = renderer.rotatedCoords;
            let cx = 0; let cy = 0; let cz = 0;
            const n = renderer.coords.length;
            for (let i = 0; i < n; i++) { cx += co[i].x; cy += co[i].y; cz += co[i].z; }
            if (n > 0) { cx /= n; cy /= n; cz /= n; }
            let sq = 0;
            for (let i = 0; i < n; i++) {
                const dx = co[i].x - cx; const dy = co[i].y - cy; const dz = co[i].z - cz;
                sq += dx * dx + dy * dy + dz * dz;
            }
            setStdDev(n > 0 ? Math.sqrt(sq / n) : 30);

            // DISPLAY PIXELS, not device. The capture is a real call into the
            // 2D renderer, and it sizes its projection from the width it is
            // handed: given the device size it centred at 448 instead of 299
            // and computed a scale 1.5x too large, so the unprojection came
            // back with model coordinates that were both offset and oversized -
            // the structure drawn half again too big and off to one side. The
            // ratio is applied ONCE, at the draw, and nowhere else.
            const RB = (window.__rebuild = { t0: performance.now() });
            // LIVE BYTES AT EACH STAGE, and nothing at all when nobody is
            // asking: this is the hot path, and a closure and an object per
            // build to hold numbers no one reads is exactly the kind of cost
            // a diagnostic must not have. `window.gc` needs
            // --js-flags=--expose-gc or the reading is garbage, not retention.
            const hm = window.__heapProbe ? (() => {
                const HS = (window.__heapStages = {});
                return (k, extra) => {
                    if (window.gc) { window.gc(); window.gc(); }
                    HS[k] = Math.round(
                        ((performance.memory || {}).usedJSHeapSize || 0) / 1e6);
                    if (extra !== undefined) HS[k + 'N'] = extra;
                };
            })() : () => {};
            hm('start');
            // 🔴 THE STATION PATH'S CAPTURE, WHERE IT MADE ONE AND WAS THEN
            // DECLINED. Same renderer, same size, same colours, same frame -
            // it is this frame's capture, and capturing again is paying twice
            // for one answer. See heldCapture.
            const reuse = heldCapture;
            heldCapture = null;
            const { prims, scale, pos, trace } = reuse || captureFrom(renderer,
                displayWidth, displayHeight, colors);
            if (typeof window !== 'undefined' && reuse) {
                window.__capturesReused = (window.__capturesReused || 0) + 1;
            }
            // WHERE THE RIBBON RAN, handed straight to the renderer: the
            // capture puts `_traceProbe` back the way it found it, so without
            // this the samples exist for a moment and are dropped. Stored in
            // the pre-rotation space by _storeRibbonTrace, because THIS is the
            // path where the mesh outlives the rotation it was captured at.
            if (trace && renderer._storeRibbonTrace) {
                renderer._storeRibbonTrace(trace);
            }
            hm('afterCapture', prims.length);
            RB.capture = +(performance.now() - RB.t0).toFixed(1);
            if (!prims.length) return false;
            // 🔴 THE STATION TABLE'S MESH, FROM THESE PRIMS, BEFORE facesOf
            // EATS THEM. facesOf(consume) nulls each prim as it reads it and
            // the array is emptied straight after, so this is the last moment
            // the prims exist. Building it here rather than at the install
            // below is what stops a frame with no fast-path mesh - the one that
            // INSTALLS the table - capturing the same frame a second time.
            if (stationDraw && !stationMeshThisFrame) {
                stationMeshThisFrame = stationMeshFrom(renderer, { prims, pos }, currentModelCenter);
            }
            // ...and how many faces it covers, for makeResident to decide with.
            stationCoverCount = (stationDraw && stationMeshThisFrame)
                ? stationMeshThisFrame.faceCount : -1;
            stationCoverMesh = (stationCoverCount >= 0) ? stationMeshThisFrame : null;
            if (window.__stationFloatProbe && stationCoverMesh) {
                window.__lastStations = Float32Array.from(stationCoverMesh.stations);
                window.__lastPieces = Float32Array.from(stationCoverMesh.pieces);
            }
            const { faces, lines, paletteComplete } = facesOf(prims, prm, true);
            // 🔴 THE REBUILD COUNTER, AND THIS IS THE LINE THAT DEFINES ONE.
            // Not "renderApp ran" and not "the signature changed" - a rebuild
            // is the capture turned into faces and a mesh, which is the work
            // the station path exists to skip. dev.html's rebuild light reads
            // this, and tests/station_* divide by it: __labelsHeld and friends
            // accumulate PER BUILD, so a probe dividing by frames instead
            // reports a multiple of the truth, which one of mine did.
            window.__faceBuilds = (window.__faceBuilds || 0) + 1;
            hm('afterFaces', faces.length);
            // DROPPED AS SOON AS THE FACES EXIST. The capture's primitive list
            // is the single largest thing this build allocates - 288,611 prims
            // and 541 MB on a 135,780-position assembly - and nothing reads it
            // again. It stayed reachable through the whole of makeResident
            // simply because the binding was still in scope, so its cost was
            // part of the peak rather than part of a stage. Emptying the array
            // releases every prim the faces did not keep a reference to.
            prims.length = 0;
            hm('primsDropped');
            RB.facesOf = +(performance.now() - RB.t0).toFixed(1);
            makeResident(faces, scale, prm, lines);
            hm('afterMesh');
            // ...and the stage-1 measurement, when a probe asks. Here as well
            // as after a station update, because a structure that never moves
            // never takes that path and would report nothing.
            if (window.__edgeTopology && stationCoverMesh) {
                window.__edgeTopologyResult = edgeTopology(stationCoverMesh);
            }
            RB.total = +(performance.now() - RB.t0).toFixed(1);
            // the mesh's scale already carries the zoom it was captured at, so
            // the draw multiplies by the RATIO rather than by the zoom itself
            if (resident) {
                // ...and the view span, for the same reason: the draw applies
                // the RATIO between this and the live one, so both have to be
                // remembered from the moment the mesh was made.
                const capFr = viewSpanOf(renderer);
                resident.capCentre = currentModelCenter;
                resident.capHalf = capFr.half;
                // ...and the CANVAS the capture was taken on. The draw's ratio
                // is spanFit(live half) over spanFit(captured half), and both
                // were being evaluated at the LIVE canvas - so the canvas size
                // cancelled out of a ratio it belongs in, and a mesh built in
                // one box and drawn in another came out at the wrong scale.
                // Measured on 1UBQ at 706x706 rebuilt and 500x500 reused:
                // 20.09% of the frame, a same-build floor of 0.0000%, and the
                // two pictures the same structure at two sizes. The canvas
                // stayed in the topological key for that reason - resizing
                // rebuilt everything - and this is what that key was standing
                // in for.
                resident.capW = displayWidth;
                resident.capH = displayHeight;
            }
            // THE DRAWN POSITIONS, in model space. Everything on top of the
            // canvas - the selection halo, the sequence hover, click-picking -
            // reads renderer.screenX/screenY, and the 2D pass fills them at the
            // END of a render that the GPU path no longer runs every frame. So
            // the positions are captured once and re-projected per frame, which
            // is exactly what that tail does.
            // a diagnostic, and the one that matters: zero here means the
            // overlay has nothing to project and will silently go stale
            window.__gpuPosCount = pos ? pos.length : 0;
            appPos = modelPositions(pos);
            appSig = sig;
            // ...and what the mesh's TOPOLOGY was, which is what the trajectory
            // fast path above compares against. Recorded here and nowhere else:
            // this is the only place a mesh is actually built.
            appTopoSig = topoSig;
            // CAN THIS MESH BE REPAINTED AT ALL? Only if every face knows which
            // slot of `colors` it took. A prim whose colour did NOT come from
            // the palette - an ss-mode colour, or any per-residue override,
            // which is what a SELECTION is - reports ciPalette false and
            // carries a baked colour instead. Recolouring such a mesh changes
            // nothing, which is exactly how selecting a residue stopped
            // showing: the ribbon kept the colour it was captured with. Where
            // the palette is incomplete a colour change rebuilds instead.
            // 🔴 AND THE STATION TABLE IS REBUILT WITH THE MESH. Without this
            // the path can only ever be installed by hand: a rebuild marks the
            // table stale and nothing puts it back, so the first frame that
            // needs one falls back for good. Costs a second capture, on the
            // path that was already the slow one - and there are none of those
            // in a trajectory once the topology holds.
            if (stationDraw && stationFillRows) {
                // ...from the mesh this frame already built where there is one.
                // It came from the same prims the rebuild above just used - the
                // capture is shared through heldCapture - so it describes this
                // frame's faces, which is exactly what the table has to
                // describe. Only a frame that never tried the fast path
                // captures here.
                const sm = stationMeshThisFrame
                    || stationMeshNow(renderer, displayWidth, displayHeight, colors);
                if (sm) installStations(sm, stationFillRows);
                // 🔴 AND THE RIBBON'S SHARE OF THE DEPTH RANGE IS RETAKEN FROM
                // THE TABLE, because that is where every LATER frame takes it
                // from. The build had it from the faces' own corners and a
                // station update has it from the table; the two agree to the
                // eighth digit, which sounds like nothing until you remember
                // it feeds uZRange and uZRange maps every vertex's depth. Two
                // coincident surfaces - the two sides of a zero-thickness
                // Richardson slab - then resolve differently, and the reader
                // sees the other side of the slab on the frames that did not
                // rebuild. Measured at 8 frames in 20 with every other byte on
                // the card identical: tests/outline_sync.py.
                //
                // 🔴 IT HAS TO BE HERE AND NOT IN makeResident. installStations
                // runs after it, so `residentStations` there is still the
                // PREVIOUS mesh's table and the correction silently used the
                // wrong face count - which is the version of this that changed
                // nothing at all.
                if (sm && resident && residentStations && residentStations.count > 0
                    && resident.centroids
                    && resident.centroids.length >= residentStations.count * 3) {
                    const sr = stationBoundsInto(sm, resident.centroids,
                        residentStations.count);
                    if (sr > 0) {
                        const radius = Math.max(sr, resident.tailRad || 0);
                        resident.zMin = -radius;
                        resident.zMax = radius;
                        resident.rad = radius;
                        srKey = null;
                    }
                }
            }
            appPalComplete = paletteComplete !== false;
            // ...reported, because it decides whether a colour change is an
            // upload or a rebuild, and one baked face out of a hundred
            // thousand is the difference. tests/gpu_recolour.py reads it.
            if (typeof window !== 'undefined') {
                window.__palComplete = appPalComplete;
                // ...and whether this frame's colours split a segment, which is
                // in the signature because a colour boundary is a CUT in the
                // ribbon (geom.js's midCut), not just a different texel.
                window.__lastHalves = (colors && colors.halves)
                    ? colors.halves.length : 0;
                // ...and the signature itself, so a probe can say WHICH term
                // moved rather than that something did. Same trick __topoMoved
                // plays for the topology key.
                window.__lastSig = sig;
                // ...and a short log of them, because two rebuilds inside one
                // animation frame are one sample to anything that polls. The
                // question "why did this rebuild" is always about a PAIR of
                // signatures, so keeping the last few is what makes it
                // answerable at all. Capped: this is a diagnostic, not a record.
                const L = window.__buildLog || (window.__buildLog = []);
                // ...with the size it was built AT, because the signature
                // holds w and h but reading them out of a 31-term string is
                // how a question about size gets answered slowly.
                L.push(sig + '   [' + displayWidth + 'x' + displayHeight + ']');
                if (L.length > 24) L.shift();
            }
        } else {
            // A COLOUR CHANGE IS AN UPLOAD, not a rebuild - three texels per
            // segment against a mesh that never moves.
            const key = colourKeyOf(colors);
            // 🔴 CONTENT, AND NOT ALSO IDENTITY. `|| colors !== appColors` stood
            // here and made the digest pointless: a fresh array with identical
            // colours still took the branch, and under an incomplete palette
            // that is a rebuild of the whole mesh for a picture that does not
            // change. The array is still tracked below, so a later in-place
            // mutation is not missed - what is dropped is treating a new
            // OBJECT as a new COLOUR.
            if (key !== appColourKey) {
                appColors = colors;
                appColourKey = key;
                if (appPalComplete) {
                    recolour();
                } else {
                    // baked colours: the only way to change them is to ask the
                    // renderer for the prims again
                    appSig = null;
                    return renderApp(renderer, ctx, displayWidth, displayHeight, colors);
                }
            } else if (colors !== appColors) {
                // Same colours, new array. Nothing to draw and nothing to
                // rebuild - but hold the array the palette source hands out,
                // or every later frame compares against one that is no longer
                // the renderer's.
                appColors = colors;
            }
        }
        if (!resident) return false;
        // THE VIEW SPAN THIS FRAME, against the view span the mesh carries. On the
        // frame that just rebuilt these are equal, so the multiplier is 1 and
        // the shift is zero; on every frame after an Orient they are not.
        const fr = viewSpanOf(renderer);
        const capC = resident.capCentre || currentModelCenter;
        // 🔴 THE SHAPE AS WELL AS THE SIZE. This was `capExtent / liveExtent`
        // alone, on the reasoning that the base scale is padding*size over
        // 2*extent so the extents divide out exactly - true while the fit was
        // isotropic, and false the moment `_viewportScale` started reading
        // extentAspect. Orient writes a new aspect at the END of its flight,
        // so a viewer that had a cached mesh went on drawing at the shape it
        // was captured under: measured on 1TIM in a 560x300 box, orienting to
        // a selection wanted 8.280 px/A and drew at 6.593, and only a rebuild
        // put it right. Reported as the zoom not animating and needing a
        // resize of the box to catch up.
        // ONE RATIO. The scale a view span asks for is spanFit of its half-span,
        // so what the mesh must be redrawn by is the live one over the captured
        // one - size, shape and zoom together, because the half-span is all
        // three. This was `capExtent / liveExtent` alone (which missed the
        // shape, and drew a reused mesh at 0.796 of the wanted scale after an
        // Orient) and then that times an aspect term (which still missed the
        // zoom).
        // ...and `__ignoreCapCanvas` puts the fault back, for the one probe
        // that has to see it fail: with the captured canvas ignored the
        // denominator is evaluated at the live size again and a reused mesh
        // draws at the wrong scale. A gate whose control cannot be triggered is
        // a gate that passes on an empty comparison.
        const capCanvas = (typeof window !== 'undefined' && window.__ignoreCapCanvas)
            ? [displayWidth, displayHeight]
            : [resident.capW || displayWidth, resident.capH || displayHeight];
        setViewTransform(spanFit(displayWidth, displayHeight, fr.half)
            / spanFit(capCanvas[0], capCanvas[1], resident.capHalf || fr.half),
            [capC[0] - fr.centre[0], capC[1] - fr.centre[1], capC[2] - fr.centre[2]]);
        // ...and tell the renderer what the picture is actually drawn at. A pan
        // converts its drag from pixels to Angstrom with this, and on a GPU
        // frame the 2D block that normally sets it never runs - so without this
        // a pan after an Orient moves by the wrong amount. The tube GPU path
        // sets it for the same reason (core/mol.js).
        renderer._viewScale = drawScale() / pixelRatio;
        // THE CARTOON'S OWN OCCLUSION, when it is asked for. GPU only, and off
        // OFF UNTIL ASKED FOR, renderer.cartoonAO === true. It works and it is
        // calibrated (see CARTOON_AO_DENSITY), but it is a look being invented
        // rather than a pass being ported: the 2D cartoon has no occlusion, so
        // with it on by default the GPU switch would change the drawing.
        //
        // Its two constants are not the tube's. Density is the areal weight of
        // the kernel and a ribbon covers far more Angstrom per drawn thing than
        // a tube does; the self-bias is what stops a surface shading itself, so
        // for a slab it is about half the thickness rather than a tube radius -
        // with a floor, because the ribbon preset's thickness is 0.
        const wantAO = renderer.cartoonAO === true
            && renderer.shadowEnabled !== false
            // ...and never in a composed frame: see the tube's copy of this
            && !(compose && compose.z);
        const aoOpts = wantAO ? {
            scale: drawScale(),
            strength: typeof renderer.shadowStrength === 'number' ? renderer.shadowStrength : 0.5,
            intensity: typeof renderer.shadowIntensity === 'number' ? renderer.shadowIntensity : 0.95,
            density: (typeof renderer.cartoonAODensity === 'number'
                ? renderer.cartoonAODensity : CARTOON_AO_DENSITY),
            selfBias: (typeof renderer.cartoonAOSelfBias === 'number'
                ? renderer.cartoonAOSelfBias
                : Math.max(0.8, (renderer.cartoonThickness || 0) * 0.5 + 0.5)),
            // how much of the colour the shadow may take at its darkest
            amount: (typeof renderer.cartoonAOAmount === 'number'
                ? renderer.cartoonAOAmount : CARTOON_AO_AMOUNT),
        } : null;
        // GHOSTED RESIDUES, WRITTEN INTO THE TEXTURE THE MESH IS ALREADY
        // TESTED AGAINST. Here rather than where the opacity is SET, because
        // the texture belongs to the mesh: ensureVisTexture fills it solid
        // whenever the structure's size changes, so a fade set before a
        // rebuild would be quietly undone. Applying it on the frame, against a
        // stamp, costs one comparison when nothing has moved.
        applyResidueOpacity(renderer);
        drawResident(appCv, prm, aoOpts);
        projectPositions(renderer, displayWidth, displayHeight);
        // ...and onto the canvas the app owns, under whatever transform it is
        // holding, which is why this saves and restores it.
        if (!compose || compose.blit !== false) blitApp(ctx);
        return true;
    } catch (err) {
        // A FAILURE HERE FALLS BACK, it does not break the viewer. The 2D path
        // is still complete and still correct; the GPU is an accelerator.
        if (window.console) window.console.warn('cartoon GPU path unavailable:', err);
        window.__gpuLastError = String((err && err.message) || err);
        appSig = null;
        clearResident();
        clearGL();
        // ...and the CANVAS with it. Keeping it means the next attempt asks a
        // dead context for a new one and gets the dead one back.
        appCv = null;
        return false;
    }
}

/* ------------------------------------------------- the tube instance buffer
 * One instance per drawn segment: its two ends in MODEL space, its radius in
 * Angstrom, and the colour core/mol.js already shaded. Ten floats.
 *
 * NOTHING IS CAPTURED. The cartoon path has to run the 2D renderer to find out
 * where its ribbon goes; a tube segment runs between two positions and that is
 * all it is, so the geometry comes straight off `rotatedCoords` un-rotated -
 * which is just `coords` centred, the same space the ribbon mesh lives in.
 */
/* WHAT FORCES THE INSTANCE BUFFER TO BE REBUILT.
 *
 * IDENTITY, NOT A DIGEST. The first version of this asked signatureOf and
 * hashed the colours, which is what the cartoon path does - and on a large
 * structure that is the frame. Measured at 320,000 positions: colourDigest
 * alone was ~9 ms of a ~20 ms frame, walking 300,000 colour objects to
 * establish that not one of them had changed.
 *
 * It can be answered by pointer comparison instead, and exactly, because
 * core/mol.js never edits any of these in place:
 *
 *  - `colors` is ALWAYS a fresh array out of _calculateSegmentColors /
 *    _calculatePlddtColors; there is no in-place recolour anywhere in the file.
 *  - `visiblePositions` is only ever assigned - null, a new Set, or a freshly
 *    combined one. Never .add/.delete/.clear on the live mask.
 *  - `segmentIndices` is rebuilt into a new array whenever it changes.
 *
 * So a changed pointer means changed contents, and an unchanged pointer means
 * unchanged contents. (The cartoon path's own digest carries a comment saying
 * the app "recomputes it in place, so the reference never moves". That is not
 * true of core/mol.js, and the cartoon path is paying an O(n) hash per frame
 * for the same reason this one was. Left alone here: it feeds a palette upload
 * decision, not a mesh rebuild, and is not this change's business.)
 *
 * What is NOT in the key, deliberately: the canvas size and the view. Every
 * number in an instance is model space - two endpoints in Angstrom, a radius in
 * Angstrom, a colour - so resizing the window does not invalidate one.
 *
 * `renderShadows` is the honest exception: when a caller does ask for the CPU
 * occlusion to be baked in, those numbers change with the view and the buffer
 * has to be rebuilt every frame. Nothing asks for it on this path - the GPU
 * computes its own - but the key must not claim otherwise.
 */
// 🔴 idOf() WAS HERE, AND IT IS GONE ON PURPOSE. It gave each object a stable
// small integer, which is a correct answer to "is this the same object" and the
// wrong question for every caller it had: a signature wants to know whether the
// picture changed, and the app hands it a NEW Set with the same members
// whenever the drawn set changes. Its three remaining callers - the hidden
// backbone, the shown bases and the element colours - all use setKeyOf below
// now, and the last of them was still carrying a comment saying "by identity,
// like the visibility mask" long after the mask itself had been moved off
// identity for exactly this reason.
//
// Left as a note rather than a function so the next hand reaching for an
// identity key finds the argument instead of the tool.

/**
 * WHAT A SET OF POSITIONS CONTAINS, not which object it is.
 *
 * The mask is rebuilt from the objects' own records whenever what is drawn
 * changes, so switching an object off and on again produces a Set with exactly
 * the same members and a different identity. Keyed by identity, the mesh then
 * counts as out of date for a picture it has already built - which is what
 * made every eye toggle a full rebuild even with the mesh kept.
 *
 * Order-independent (a Set has no order worth relying on) and cached against
 * the Set, because this runs on every frame and the walk is O(n): 17,550
 * members is about half a millisecond, once.
 */
const visDigests = new WeakMap();
function setKeyOf(set) {
    if (!set) return 'all';
    let d = visDigests.get(set);
    if (d === undefined) {
        let a = set.size >>> 0;
        let b = 2166136261 >>> 0;
        for (const i of set) {
            a = (a + Math.imul(i | 0, 2654435761)) >>> 0;
            b = (b ^ (i | 0)) >>> 0;
        }
        d = 'v' + set.size + ':' + a.toString(36) + ':' + b.toString(36);
        visDigests.set(set, d);
    }
    return d;
}
/* WHAT A COLOUR ARRAY CONTAINS, cached against the array.
 *
 * The tube's instances carry their own colours, so a recolour is a rebuild -
 * but so was coming BACK to a picture already built, because the app rebuilds
 * the colours from scratch whenever the drawn set changes and identity said
 * "different" about an identical list. Same argument as the visibility mask,
 * and the same answer: ask what is in it, once per array. The walk is O(n) and
 * happens only when a new array appears, not per frame - which is what made
 * hashing it per frame 9 ms of a 20 ms frame at 320,000 positions.
 */
const colourDigests = new WeakMap();
function colourKeyOf(colors) {
    if (!colors || !colors.length) return 'nocol';
    let d = colourDigests.get(colors);
    if (d === undefined) {
        let a = colors.length >>> 0;
        for (let i = 0; i < colors.length; i++) {
            const c = colors[i];
            if (!c) { a = (a * 31 + 7) >>> 0; continue; }
            a = (Math.imul(a, 16777619) ^ (((c.r | 0) << 16) | ((c.g | 0) << 8) | (c.b | 0))) >>> 0;
        }
        d = 'c' + colors.length + ':' + a.toString(36);
        colourDigests.set(colors, d);
    }
    return d;
}
let tubeShadowTick = 0;
function tubeKeyOf(renderer, S) {
    if (S.renderShadows) return 'shaded:' + (++tubeShadowTick);
    return sharedGeometryKey(renderer).concat([
        // COLOUR IS GEOMETRY HERE, unlike the cartoon: an instance carries its
        // own colour, so a recolour is a rebuilt buffer either way and there is
        // no palette texture to repaint instead. By CONTENT (see colourKeyOf),
        // so coming back to a picture already built is an upload, not a build.
        colourKeyOf(S.colors),
        // how many of the ordered segments are actually drawn
        S.count,
    ]).join('|');
}

/* A TUBE IS A VALUE TOO.
 *
 * The cartoon mesh learned this the hard way - a restore that put back the
 * buffers and forgot the visibility texture drew half a structure - and the
 * tube kept the same shape of state loose: an instance buffer, a count, a
 * centre and a density, four module variables set by one function and read by
 * another. There is less of it and it costs less to rebuild, so this is not
 * about speed; it is that "everything a build decides" should be one thing
 * that one function installs, in both paths, so neither can grow a second
 * writer.
 *
 * The scratch array is REUSED between builds, so a captured value has to own a
 * copy - which is also what makes the spare slot honest.
 */
function captureTube(sig) {
    if (!tubeLive) return null;
    return Object.assign({}, tubeLive, { sig });
}

function activateTube(m) {
    if (!m || !gl || !bufTube) return false;
    tubeLive = m;
    tubeCount = m.count;
    tubeCentre = m.centre;
    tubeRange = m.range;
    tubeDensity = m.density;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufTube);
    gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.DYNAMIC_DRAW);
    return m.count > 0;
}

// The same exchange the cartoon's spare slot makes, and for the same reason:
// alternating between two pictures is what an eye is for, so the value coming
// out takes the place of the one going in.
function keepTube(sig) {
    const m = captureTube(sig);
    spareTube = (m && sig && m.bytes <= MESH_CACHE_MAX_BYTES) ? m : null;
    if (typeof window !== 'undefined') {
        window.__spareTube = spareTube
            ? { sig: spareTube.sig, bytes: spareTube.bytes } : null;
    }
}

function restoreTube(sig) {
    if (!spareTube || spareTube.sig !== sig) return false;
    const m = spareTube;
    keepTube(tubeSig);
    return activateTube(m);
}

// ...the two before the residues are the ends' ball colours, and the two after
// them are the POSITIONS the segment runs between - carried so the tube can be
// ghosted the way the cartoon is. See uVis in VSTUBE.
const TUBE_FLOATS = 17;
function buildTube(renderer, S) {
    if (!gl) return false;
    const co = renderer.coords || [];
    const n = co.length;
    const order = S.order || [];
    const cnt = Math.min(S.count === undefined ? order.length : S.count, order.length);
    if (!cnt || !n) { tubeCount = 0; tubeLive = null; return false; }
    // the centre the app subtracts before rotating, so this is the same model
    // space the cartoon mesh lives in
    let cx = 0; let cy = 0; let cz = 0;
    for (let i = 0; i < n; i++) { cx += co[i].x; cy += co[i].y; cz += co[i].z; }
    cx /= n; cy /= n; cz /= n;
    const lw = renderer.lineWidth || 3.0;
    // HOW MANY DRAWN SEGMENTS TOUCH EACH POSITION. An end shared with the next
    // segment is not an end of anything - the chain runs straight through it -
    // and a round outline cap there draws a rim between every pair of residues,
    // which is what makes a backbone read as a string of sausages rather than a
    // tube. The 2D pass has the same rule (shouldRoundEndpoint): the outline is
    // butt-capped along the chain and rounded only where the chain stops.
    // A COUNTER PER POSITION, in a typed array kept between rebuilds rather
    // than a fresh Map. The Map was 2n insertions of boxed integer keys and
    // measured 5.4 ms on 4UG0 against 0.3 for this; the array is cleared by
    // rewriting only the entries this pass touches, so clearing is free too.
    if (!tubeTouch || tubeTouch.length < n) tubeTouch = new Int32Array(n);
    const touch = tubeTouch;
    if (!tubeClaim || tubeClaim.length < n) tubeClaim = new Int32Array(n);
    const claim = tubeClaim;
    const jointCaps = renderer.cartoonJointCaps !== false;
    for (let k = 0; k < cnt; k++) {
        const sg2 = S.segments[order[k]];
        if (!sg2 || sg2.idx1 === undefined) continue;
        touch[sg2.idx1] = 0; touch[sg2.idx2] = 0;
        claim[sg2.idx1] = 0; claim[sg2.idx2] = 0;
    }
    for (let k = 0; k < cnt; k++) {
        const sg2 = S.segments[order[k]];
        // contacts are annotation laid ACROSS the chain, not links in it: they
        // must not turn a real chain terminus into an interior joint, and they
        // keep their own round ends
        if (!sg2 || sg2.idx1 === undefined || sg2.type === 'C') continue;
        touch[sg2.idx1]++;
        touch[sg2.idx2]++;
    }
    // WHICH SEGMENT OWNS EACH JOINT'S BALL: the one that STARTS there.
    //
    // The 2D pass paints along the chain and the LATER segment's cap covers
    // the earlier one, so what shows at a joint is the OUTGOING segment's ball.
    // Claiming on first come gave it to the incoming one instead - the same
    // picture with the two colours the other way round, which is what did not
    // match. Claimed here rather than in the emit below because the incoming
    // segment reaches the position first there and would take it.
    //
    // claim holds the owner's slot as k + 1, so 0 still means unclaimed.
    for (let k = 0; k < cnt; k++) {
        const sg2 = S.segments[order[k]];
        if (!sg2 || sg2.idx1 === undefined || sg2.type === 'C') continue;
        if (touch[sg2.idx1] > 1 && claim[sg2.idx1] === 0) claim[sg2.idx1] = k + 1;
    }
    // ...and a joint where NOTHING starts - two chains meeting head to head -
    // still needs an owner, or both sides give up the ball and the tie is back.
    for (let k = 0; k < cnt; k++) {
        const sg2 = S.segments[order[k]];
        if (!sg2 || sg2.idx1 === undefined || sg2.type === 'C') continue;
        if (touch[sg2.idx2] > 1 && claim[sg2.idx2] === 0) claim[sg2.idx2] = k + 1;
    }
    // EACH SEGMENT'S FINAL COLOUR AND WHERE ITS INSTANCE LANDED, so a joint can
    // be given one colour after the fact. Both are per k, and the emit skips
    // some segments, so the slot is not the loop index.
    const colOf = new Float64Array(cnt);
    const slotOf = new Int32Array(cnt).fill(-1);
    // REUSED. At 30,000 segments this is a 1.5 MB allocation, and it was being
    // made every frame to hold bytes that had not changed.
    const need = cnt * TUBE_FLOATS;
    if (!tubeData || tubeData.length < need) tubeData = new Float32Array(need);
    const data = tubeData;
    let o = 0;
    let count = 0;
    let rad = 0;
    for (let k = 0; k < cnt; k++) {
        const idx = order[k];
        const sg = S.segments[idx];
        if (!sg) continue;
        const i1 = sg.idx1;
        const i2 = sg.idx2;
        if (i1 === undefined || i2 === undefined || i1 >= n || i2 >= n) continue;
        const base = S.colors && S.colors[idx];
        if (!base) continue;
        // THE LOOP'S OWN COLOUR, arrived at the same way: a contact stays bright
        // and flat, everything else is tinted toward white by the occlusion it
        // sits under and then multiplied down by it.
        let r = base.r / 255;
        let g = base.g / 255;
        let b = base.b / 255;
        if (sg.type !== 'C' && S.renderShadows) {
            const tf = (0.50 * S.tints[idx]) / 3;
            r += (1 - r) * tf; g += (1 - g) * tf; b += (1 - b) * tf;
            const sf = 0.20 + 0.80 * S.shadows[idx];
            r *= sf; g *= sf; b *= sf;
        }
        const wm = renderer._calculateSegmentWidthMultiplier
            ? renderer._calculateSegmentWidthMultiplier(S.segData && S.segData[idx], sg) : 1;
        const a = co[i1];
        const c2 = co[i2];
        data[o++] = a.x - cx; data[o++] = a.y - cy; data[o++] = a.z - cz;
        data[o++] = c2.x - cx; data[o++] = c2.y - cy; data[o++] = c2.z - cz;
        data[o++] = Math.max(0.02, lw * wm * 0.5);      // radius, Angstrom
        data[o++] = r * 255; data[o++] = g * 255; data[o++] = b * 255;
        // a free end gets a cap. Written out rather than through a closure
        // built per segment, which is what it was.
        // WHO CARRIES THE CAP AT A JOINT.
        //
        // The 2D pass lays a filled outline disc at every interior joint - for
        // whichever segment is drawn FIRST there - and the neighbours' fills
        // cover all but the outside of the elbow. That rim around every bend is
        // the biggest single difference between the two outlines: 490 of 1TIM's
        // 984 segment ends, 17,353 of 4UG0's 34,896.
        //
        // Letting BOTH segments round at a joint does not reproduce it - they
        // fight, and print the arc across the joint that the butt cut exists to
        // stop (measured: six times the interior marks). Only ONE may carry it.
        //
        // Which one does not matter, and that is what makes this portable. The
        // two share the position, so they would draw the SAME disc - same
        // centre, same radius, same depth - where the 2D pass has to pick the
        // back-most because it paints in order. So the owner is simply the
        // first segment to reach the position here: deterministic, independent
        // of the view, and therefore no reason to rebuild when the model turns.
        //
        // 2 marks a joint cap, 1 a free end. They differ in depth - see uCapZ.
        // ...AND THE CLAIM IS MADE WHETHER OR NOT THE OUTLINE WANTS IT. The
        // owner's round FILL is what closes the elbow now that the other side
        // is cut square there, so a joint always needs an owner; 3 is that
        // owner with no outline arc, which is what cartoonJointCaps = false
        // asks for. Gating the claim itself on the flag left both sides butt-
        // cut and opened a notch at every bend.
        const isC = sg.type === 'C';
        const jointOwn = jointCaps ? 2 : 3;
        let cA = 0, cB = 0;
        if (isC || touch[i1] <= 1) cA = 1;
        else if (claim[i1] === k + 1) cA = jointOwn;
        if (isC || touch[i2] <= 1) cB = 1;
        else if (claim[i2] === k + 1) cB = jointOwn;
        data[o++] = cA;
        data[o++] = cB;
        data[o++] = isC ? 1 : 0;                        // annotation: no shading
        // THE BALL COLOUR AT EACH END, its own for now. A joint's two segments
        // are patched to share the owner's below, once every segment's colour
        // has been worked out - the owner may be a segment this loop has not
        // reached yet, and its colour is not simply its palette entry: the
        // occlusion tint above is per segment.
        const packed = (Math.round(r * 255) * 65536) + (Math.round(g * 255) * 256)
            + Math.round(b * 255);
        colOf[k] = packed;
        slotOf[k] = count;
        data[o++] = packed;
        data[o++] = packed;
        // WHICH TWO RESIDUES THIS SEGMENT RUNS BETWEEN. Both, not one: a
        // segment spanning a ghosted residue and a solid one is half of each,
        // and taking a single end would snap it to whichever end was written.
        data[o++] = i1;
        data[o++] = i2;
        count++;
        const dax = a.x - cx; const day = a.y - cy; const daz = a.z - cz;
        const da = dax * dax + day * day + daz * daz;
        if (da > rad) rad = da;
        const dbx = c2.x - cx; const dby = c2.y - cy; const dbz = c2.z - cz;
        const db = dbx * dbx + dby * dby + dbz * dbz;
        if (db > rad) rad = db;
    }
    // ...AND NOW GIVE EACH JOINT ONE COLOUR. Both segments meeting at an atom
    // paint the ball there in the owner's colour, so the depth buffer's choice
    // between their two surfaces stops being visible: there is no colour
    // boundary inside the lens for it to place. See the fragment shader.
    for (let k = 0; k < cnt; k++) {
        const slot = slotOf[k];
        if (slot < 0) continue;
        const sg2 = S.segments[order[k]];
        if (!sg2 || sg2.type === 'C') continue;
        const at = slot * TUBE_FLOATS;
        const ownA = claim[sg2.idx1] - 1;
        const ownB = claim[sg2.idx2] - 1;
        if (ownA >= 0 && slotOf[ownA] >= 0) data[at + 13] = colOf[ownA];
        if (ownB >= 0 && slotOf[ownB] >= 0) data[at + 14] = colOf[ownB];
    }
    rad = Math.sqrt(rad) + 2;    // room for the capsule's own bulge
    // HOW MANY SEGMENTS PER SQUARE ANGSTROM the occlusion pass should assume.
    // Each of its taps stands for a patch of the sampling disc, and what the
    // CPU sums over that patch is SEGMENTS - so the two only agree if the pass
    // is told the areal density.
    //
    // MEASURED, THIS WAS THE THING MAKING STRUCTURES DISAGREE. It used to be
    // count / (pi * rad^2) with rad the distance to the FARTHEST atom - an
    // extreme, so one long loop set it for the whole structure and the density,
    // which goes as 1/r^2, collapsed for the bulk nowhere near it. On Q5VSL9
    // the farthest CA is 77.9 A out against an RMS radius of 35.7.
    //
    // Replacing the extreme with the RMS radius fixes that much, and measuring
    // what the shader actually NEEDS says to go further. Sweeping the gain
    // against the 2D pass on six structures from 75 to 311,880 segments, the
    // product the shader consumes - density x gain - comes out essentially
    // constant, while the measured density does not:
    //
    //     1UBQ      75 seg   required product 0.173
    //     3CHY     127                        0.160
    //     1TIM     492                        0.181
    //     Q5VSL9   836                        0.187
    //     4UG0  17,448                        0.127
    //     3J3Q 311,880                        0.162
    //
    // 1.5x across the set, against 4.3x for the RMS density and 5.3x for the
    // old one. So the measurement was contributing the variance rather than
    // removing it, and the honest value is a constant. The occlusion estimate
    // already responds to crowding on its own - a tap in a crowded structure
    // hits something nearer - which is presumably why scaling it by crowding
    // a second time overshot.
    //
    // tubeAOGain still multiplies this, so it stays the knob it was.
    // HOW MANY TIMES THE INSTANCE DATA HAS BEEN BUILT, for the probes: a
    // restore that quietly rebuilt would otherwise look identical.
    if (typeof window !== 'undefined') {
        window.__tubeBuilds = (window.__tubeBuilds || 0) + 1;
    }
    // ...and everything this build decided goes in as ONE value. `data` is the
    // scratch array and is written over by the next build, so the value takes
    // a copy of exactly the bytes it uses.
    const bytes = data.slice(0, o);
    return activateTube({
        data: bytes, count, centre: [cx, cy, cz],
        // THE DEPTH RANGE IS A BUILD PRODUCT TOO - it is the scene's own
        // radius, and the capsules are mapped through it. Left out of the
        // value at first, and a restored buffer was then drawn through the
        // range of whatever was built last: same instances, different picture.
        // The probe caught it; the cartoon's version of this exact omission
        // (the visibility texture) reached the app.
        range: [-rad, rad],
        density: TUBE_AO_DENSITY, bytes: bytes.byteLength,
    });
}

/* Two passes, outline then fill, exactly the order the 2D pass strokes them in
 * per segment - only here the depth buffer does the sorting, so all the
 * outlines can go down first and every tube is still outlined against whatever
 * is behind it. The outline is pushed away from the eye so a segment's own fill
 * wins where the two coincide.
 */
function drawTube(cv, renderer, prm) {
    if (!gl || !tubeCount) return false;
    timerOn = (typeof window !== 'undefined' && window.__gpuTimers === true);
    // DEVICE PIXELS PER DISPLAY PIXEL, measured against the display size THIS
    // frame is for. renderer.displayWidth is the screen's, and an export is a
    // different size entirely: read from it, a 300 dpi export scaled the tube
    // by the ratio between the two and drew the structure three times too
    // large. The caller passes the size it is drawing at.
    const dw = (prm && prm.displayWidth > 0 ? prm.displayWidth : 0)
        || renderer.displayWidth || cv.width;
    const ratio = dw > 0 ? cv.width / dw : 1;
    gl.useProgram(progTube);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    if (!composeKeepFrame) {
        clearToPaper();
        gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufTube);
    const stride = TUBE_FLOATS * 4;
    const bound = [];
    const bind = (name, size, off) => {
        const l = gl.getAttribLocation(progTube, name);
        if (l < 0) return;
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off);
        gl.vertexAttribDivisor(l, 1);
        bound.push(l);
    };
    bind('aP0', 3, 0); bind('aP1', 3, 12); bind('aRad', 1, 24); bind('aTCol', 3, 28);
    bind('aCapA', 1, 40); bind('aCapB', 1, 44); bind('aNoAO', 1, 48);
    bind('aJCol', 2, 52);
    bind('aResA', 1, 60); bind('aResB', 1, 64);
    const R = currentRot();
    const u = (nm, v) => gl.uniform1f(gl.getUniformLocation(progTube, nm), v);
    // ...AND THE COVERAGE TEXTURE, which the fills program binds for itself a
    // few hundred lines up. Without it uVisW is 0 here and the tube reads as
    // solid whatever the ghosting says - the shader's own "nothing to fade"
    // path, reached by forgetting rather than by meaning it.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.uniform1i(gl.getUniformLocation(progTube, 'uVis'), 0);
    u('uVisW', visTex ? visW : 0);
    u('uVisN', (resMap && resMap.nBase) ? resMap.nBase : 1);
    gl.uniformMatrix3fv(gl.getUniformLocation(progTube, 'uRot'), false,
        new Float32Array([R[0][0], R[1][0], R[2][0],
            R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]));
    gl.uniform2f(gl.getUniformLocation(progTube, 'uSize'), cv.width, cv.height);
    // THE SHIFT, AND THE DEPTH RANGE THAT TRAVELS WITH IT. The range was
    // measured about the centre the instances were built around, and a shift
    // moves every z by the same amount - the rotated shift's z component.
    const fr = viewSpanOf(renderer);
    const sh = [tubeCentre[0] - fr.centre[0], tubeCentre[1] - fr.centre[1],
        tubeCentre[2] - fr.centre[2]];
    gl.uniform3f(gl.getUniformLocation(progTube, 'uShift'), sh[0], sh[1], sh[2]);
    const Rt = currentRot();
    const dzTube = Rt[2][0] * sh[0] + Rt[2][1] * sh[1] + Rt[2][2] * sh[2];
    const zrTube = composeZ || [tubeRange[0] + dzTube, tubeRange[1] + dzTube];
    gl.uniform2f(gl.getUniformLocation(progTube, 'uZRange'), zrTube[0], zrTube[1]);
    u('uScale', (renderer._viewScale || 1) * ratio);
    uploadClip(progTube);
    u('uPersp', isPersp() ? 1 : 0);
    u('uFL', focalLength());
    u('uRatio', ratio);
    // The depth ramp is a STAND-IN, not an addition. When the real screen-space
    // occlusion is present it is already baked into each instance's colour by
    // buildTube, exactly as the 2D pass bakes it; ramping on top of that would
    // darken the back of the structure twice. It only runs with shadows off.
    u('uDepthCue', 0);
    gl.uniform2f(gl.getUniformLocation(progTube, 'uSizeF'), cv.width, cv.height);

    // THE OUTLINE'S WIDTH, needed before the prepass because the prepass has to
    // rasterise EXACTLY the geometry the draw will (see below).
    const outW = (renderer.outlineMode !== 'none')
        ? Math.max(0, prm.outlineWidthPx || 0) : 0;
    // PASS 0: THE DEPTH PREPASS AND THE OCCLUSION.
    // Same instances, same shader, one uniform different: the colour channel
    // carries view z. Then one full-screen pass turns that depth field into the
    // shadow/tint pair the 2D renderer computes on the CPU by testing every
    // segment against every segment in front of it.
    const wantAO = renderer.shadowEnabled !== false && ensureOcc(cv.width, cv.height);
    // ...AND IN A COMPOSED FRAME IT DRAWS STRAIGHT INTO THE SHARED BUFFER.
    //
    // gFbo is an OPTIMISATION, not the occlusion: it lets the final pass test
    // against the prepass's completed depth buffer (they share the
    // renderbuffer), and the picture is then copied to the canvas. That copy
    // is a plain overwrite, so in a composed frame it wiped whatever the other
    // painter had drawn - which is what took the shadows off the tube when a
    // cartoon object was on screen beside it.
    //
    // The module already handles gFbo being absent ("the draw then goes
    // straight to the canvas"), and the AO texture is sampled either way. So a
    // composed frame takes that path: the occlusion stays, the two painters
    // share one depth buffer, and what is given up is the early rejection -
    // speed, on the structures big enough to notice.
    const useG = !!gFbo && !composeZ;
    if (wantAO) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, zFbo);
        gl.viewport(0, 0, cv.width, cv.height);
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
        // -1e9 is "no surface here". The occlusion pass tests for it rather
        // than trusting a zero, which is a perfectly ordinary depth.
        gl.clearColor(-1e9, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        u('uZOnly', 1); u('uUseAO', 0);
        // THE TUBE'S OWN QUAD - no skirt, so no wasted fragments and a depth
        // field of surfaces only. Its depths still line up with the draw's to
        // the bit, because neither depends on the quad any more.
        u('uZOnly', 1);
        u('uGrowPx', 0); u('uPushZ', 0); u('uSkirtZ', 0); u('uEndCaps', 1);
        u('uCapZ', 0);
        gl.uniform1f(gl.getUniformLocation(progTube, 'uDarken'), 1.0);
        gl.uniform1f(gl.getUniformLocation(progTube, 'uLit'), 0);
        const tmZ = tmStart('1-prepass');
        drawTubeInstances();
        tmEnd(tmZ);

        runOcclusion(cv, {
            scale: (renderer._viewScale || 1) * ratio,
            strength: typeof renderer.shadowStrength === 'number' ? renderer.shadowStrength : 0.5,
            intensity: typeof renderer.shadowIntensity === 'number' ? renderer.shadowIntensity : 0.95,
            density: tubeDensity
                * (typeof renderer.tubeAOGain === 'number' ? renderer.tubeAOGain : AO_GAIN),
            // A sample less than about a tube's radius nearer is the SAME tube's
            // own bulge, not something in front of it. Without this every capsule
            // shades its own rim and the flat segments come out looking moulded.
            selfBias: Math.max(0.6, (renderer.lineWidth || 3) * 0.5 * 1.1),
        });

        gl.useProgram(progTube);
        // INTO THE SHARED-DEPTH TARGET, KEEPING THE PREPASS'S DEPTH.
        //
        // The depth buffer already holds every visible surface, so this draw
        // must not clear it and must not write to it: the test becomes LEQUAL
        // so the surface that produced each stored value is the one admitted,
        // and depthMask stays off so nothing disturbs the answer. Only the
        // colour is cleared.
        //
        // DEPTH WRITES STAY ON, and that is not optional. A skirt sits at its
        // tube's nearest point, in front of the surface the prepass recorded
        // there, and it has to leave that depth behind or the fill it is
        // supposed to outline passes LEQUAL straight over the top of it. Turned
        // off, the picture came back with most of its outlines missing - the
        // one thing about a tube drawing you notice immediately.
        //
        // Writing costs nothing here: the rejection that makes this fast is the
        // hardware testing against a buffer that is already complete, and a
        // fragment that passes writes the depth that was already there.
        gl.bindFramebuffer(gl.FRAMEBUFFER, useG ? gFbo : null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, aoTex2);
        gl.uniform1i(gl.getUniformLocation(progTube, 'uAOTex'), 1);
        gl.viewport(0, 0, cv.width, cv.height);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        if (useG) gl.depthFunc(gl.LEQUAL);
        if (!composeKeepFrame) {
            clearToPaper();
            gl.clear(gl.COLOR_BUFFER_BIT | (useG ? 0 : gl.DEPTH_BUFFER_BIT));
        }
    }
    u('uZOnly', 0);
    u('uUseAO', wantAO ? 1 : 0);
    // Shadows off means FLAT, the same as the 2D pass - not "flat plus a depth
    // ramp of my own invention". The ramp stays available (it was the stand-in
    // while the GPU had no occlusion of its own) but nothing asks for it now
    // unless a caller does.
    u('uDepthCue', renderer.cartoonTubeDepthCue === true && !wantAO ? 1 : 0);
    // THE DRAW: outline and fill in ONE pass over the instances.
    //
    // These were two passes, and they were 86% of the GPU frame on 3J3Q - 63.5
    // ms of outline and 64.0 ms of fill out of 149 ms. They rasterise the same
    // capsules over the same pixels, and the shader now picks skirt or fill per
    // fragment, so the second rasterisation bought nothing but its own cost.
    //
    // The outline's width is the app's own outlineWidth in display pixels and
    // its colour the fill darkened 0.7, both straight off the 2D pass, which
    // calls it the gap filler. uGrowPx is what tells the shader a skirt is
    // wanted at all: at 0 there is no ring outside the tube and the draw is a
    // plain fill.
    u('uGrowPx', outW * 0.5);
    u('uPushZ', 0.0008);
    u('uSkirtZ', typeof renderer.cartoonSkirtZ === 'number'
        ? renderer.cartoonSkirtZ : SKIRT_Z);
    u('uEndCaps', renderer.outlineMode === 'partial' ? 0 : 1);
    u('uCapZ', typeof renderer.cartoonCapZ === 'number' ? renderer.cartoonCapZ : CAP_Z);
    gl.uniform1f(gl.getUniformLocation(progTube, 'uDarken'), 0.7);
    // FLAT BY DEFAULT. Per-fragment cylinder lighting is in the shader and
    // works, but it turns the drawing into shiny rods - a different style, not
    // this one. renderer.cartoonTubeLit = true asks for it.
    gl.uniform1f(gl.getUniformLocation(progTube, 'uLit'),
        renderer.cartoonTubeLit === true ? 1 : 0);
    const tmF = tmStart('4-draw');
    drawTubeInstances();
    tmEnd(tmF);
    // ...and onto the canvas. Colour only: the default framebuffer's depth is
    // nobody's business and blitting it would cost for nothing.
    if (wantAO && useG) {
        const tmC = tmStart('5-copy');
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, cv.width, cv.height);
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(progCopy);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cTex);
        gl.uniform1i(gl.getUniformLocation(progCopy, 'uSrc'), 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.enable(gl.DEPTH_TEST);
        tmEnd(tmC);
        // handed back for the next frame, which starts by clearing the canvas
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
    }
    for (const l of bound) gl.vertexAttribDivisor(l, 0);
    tmCollect();
    return true;
}
// The two offscreen targets, at the drawing buffer's own size. Recreated only
// when that size changes.
//
// IT BORROWS THE ACTIVE TEXTURE UNIT AND MUST GIVE IT BACK. Every texture it
// makes is bound to whatever unit is current, and the unit that is current here
// is the fills program's uVis - so on the frame that allocates these, the
// visibility map became a depth texture, every residue read as hidden, and the
// cartoon's depth prepass came out EMPTY: no depth field, therefore no shadow,
// at any density. It resized on the first AO frame and again on every canvas
// resize, which is exactly the frame anyone looks at.
function ensureOcc(w, h) {
    if (!occOk) return false;
    if (zFbo && occW === w && occH === h) return true;
    const hadBound = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const tex = (fmt, type, internal) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    };
    if (cTex) gl.deleteTexture(cTex);
    if (gFbo) gl.deleteFramebuffer(gFbo);
    cTex = null; gFbo = null;
    if (zTex) gl.deleteTexture(zTex);
    if (aoTex) gl.deleteTexture(aoTex);
    if (aoTex2) gl.deleteTexture(aoTex2);
    if (aoFbo2) gl.deleteFramebuffer(aoFbo2);
    if (zRb) gl.deleteRenderbuffer(zRb);
    if (zFbo) gl.deleteFramebuffer(zFbo);
    if (aoFbo) gl.deleteFramebuffer(aoFbo);
    zTex = tex(gl.RED, gl.FLOAT, gl.R32F);
    aoTex = tex(gl.RG, gl.UNSIGNED_BYTE, gl.RG8);
    aoTex2 = tex(gl.RG, gl.UNSIGNED_BYTE, gl.RG8);
    // A REAL DEPTH BUFFER FOR THE PREPASS. The capsules resolve their own
    // overlaps with gl_FragDepth; without somewhere to write it the nearest
    // surface is whichever segment happened to be drawn last.
    zRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, zRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    zFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, zFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, zTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, zRb);
    const okZ = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    aoFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, aoFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, aoTex, 0);
    const okA = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    aoFbo2 = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, aoFbo2);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, aoTex2, 0);
    const okB = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    // THE PICTURE, WITH THE PREPASS'S DEPTH BUFFER ALREADY IN IT.
    //
    // A renderbuffer can be attached to more than one framebuffer, and that one
    // fact is the optimisation: the prepass leaves zRb holding the depth of
    // every visible surface, so the draw that follows can test against a
    // COMPLETE depth buffer instead of building one as it goes. With the
    // conservative-depth quad in front of it, the hardware then rejects a
    // hidden capsule before its fragment shader runs - all of them, not just
    // the ones that happen to be drawn after their occluder.
    //
    // The cost is that the picture lands in a texture and has to be blitted to
    // the canvas, which is one full-screen copy the GPU does in its sleep.
    cTex = tex(gl.RGBA, gl.UNSIGNED_BYTE, gl.RGBA8);
    gFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, gFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, zRb);
    const okG = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    occW = w; occH = h;
    gl.bindTexture(gl.TEXTURE_2D, hadBound);
    if (!okZ || !okA || !okB) { occOk = false; return false; }
    if (!okG) { gFbo = null; }      // the draw then goes straight to the canvas
    return true;
}

function drawTubeInstances() {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIdx);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, tubeCount);
}

/* The tube style's app entry. Same contract as renderApp: draws into the
 * offscreen WebGL canvas and blits, returns false for anything it cannot do so
 * the 2D path takes the frame instead.
 *
 * The instance buffer is rebuilt when the geometry or the COLOURS change - and
 * for this style the colours are most of it, because they carry the screen-space
 * occlusion core/mol.js computes and caches. That cache is rebuilt when a
 * gesture settles, so during a drag the digest is unchanged and the frame is one
 * uniform and two draw calls.
 */
function renderTubeApp(renderer, ctx, displayWidth, displayHeight, S) {
    if (typeof document === 'undefined') return false;
    const compose = S && S.compose;
    composeKeepFrame = !!(compose && compose.keep);
    composeZ = (compose && compose.z) || null;
    if (!ctx || !ctx.canvas || !ctx.drawImage || ctx.getSerializedSvg) return false;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    if (!(w > 0 && h > 0)) return false;
    try {
        if (!appCv) {
            appCv = document.createElement('canvas');
            appCv.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                appCv = null; appSig = null; tubeSig = null;
                clearResident(); clearGL();
            });
        }
        const fresh = !gl || appCv.width !== w || appCv.height !== h;
        if (appCv.width !== w || appCv.height !== h) { appCv.width = w; appCv.height = h; }
        if (!gl && !initGL(appCv)) return false;
        if (fresh) tubeSig = null;

        if (!bufferFits(w, h)) return false;
        setRot(renderer.viewerState.rotation);
        setOrtho(renderer.viewerState && renderer.viewerState.ortho);
        setFocalLength(renderer.viewerState && renderer.viewerState.focalLength);
        setClearAlpha(renderer.isTransparent ? 0 : 1);
        // the clip slab, in the same view space the geometry is drawn in
        setClipSlab(renderer.clipSlabOn && renderer.clipSlabOn() ? renderer.clipNear : 0,
            renderer.clipSlabOn && renderer.clipSlabOn() ? renderer.clipFar : 0,
            renderer.clipFadeWidth ? renderer.clipFadeWidth() : 0);
        const dark = renderer.backgroundColor === '#000000';
        setPaper(dark ? [0, 0, 0] : [255, 255, 255], dark ? 255 : 0);

        // REBUILT EVERY FRAME, and that is not a compromise. The visible list,
        // the depth order and the occlusion shading are all decided upstream per
        // frame, so there is no view for which last frame's instances are still
        // right. It is one Float32Array of twelve floats per drawn segment - 480 KB
        // at ten thousand segments - against the thousands of arc and stroke
        // calls it replaces.
        // REBUILT WHEN IT CHANGES, NOT EVERY FRAME.
        //
        // It used to be rebuilt every frame, on the reasoning that the visible
        // list, the depth order and the occlusion shading are decided per frame
        // upstream. Two of those three are no longer true and the third never
        // was: the GPU sorts with a depth buffer, it computes its own occlusion
        // from a depth prepass, and the instance data - two model-space
        // endpoints, a radius in Angstrom, a colour and two cap flags - has
        // never contained a single view-dependent number. Turning the model
        // does not change one byte of it.
        //
        // Measured on 4UG0: 18 ms of a 26 ms frame, every frame, to arrive at
        // the buffer that was already there.
        const key = tubeKeyOf(renderer, S);
        if (key !== tubeSig || !tubeCount) {
            // the way back to a picture already built is an upload; only worth
            // holding one where an eye can switch something off and on again
            if (Object.keys(renderer.objectsData || {}).length > 1) {
                if (!restoreTube(key)) { keepTube(tubeSig); }
            } else { spareTube = null; }
            if (!tubeLive || tubeLive.sig !== key) {
                if (!buildTube(renderer, S)) { tubeSig = null; return false; }
            }
            tubeSig = key;
            tubeLive.sig = key;
        }
        if (!tubeCount) return false;
        // THE COVERAGE TEXTURE IS THE CARTOON PATH'S AND THIS PATH NEVER
        // TOUCHED IT. A tube page never called ensureVisTexture, so uVisW was
        // 0 and the shader took its own "nothing to fade" branch - the ghosting
        // reached the tube's shader and was then read out of a texture nobody
        // had sized. Set up here exactly as renderApp does it: the map, the
        // texture, and then what the renderer says is ghosted.
        setResidueMap({ nBase: renderer.coords ? renderer.coords.length : 0,
            sidechainMap: renderer.sidechainMap || null });
        ensureVisTexture(renderer.coords ? renderer.coords.length : 1);
        applyResidueOpacity(renderer);
        if (!drawTube(appCv, renderer,
            { outlineWidthPx: S.outlineWidthPx || 0, hasOcclusion: !!S.renderShadows,
                displayWidth })) return false;
        if (!compose || compose.blit !== false) blitApp(ctx);
        return true;
    } catch (err) {
        if (window.console) window.console.warn('tube GPU path unavailable:', err);
        window.__gpuLastError = String((err && err.message) || err);
        tubeSig = null;
        clearGL();
        appCv = null;
        return false;
    }
}

/* THE OFFSCREEN CANVAS ONTO THE ONE THE APP OWNS, under whatever transform it
 * is holding - which is why this saves and restores it. Exported as well,
 * because a composed frame's last painter may be the one that declined, and
 * the pixels the first one drew still have to reach the page.
 */
function blitApp(ctx) {
    if (!appCv || !ctx || !ctx.drawImage) return false;
    const prev = ctx.getTransform ? ctx.getTransform() : null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(appCv, 0, 0);
    if (prev) ctx.setTransform(prev.a, prev.b, prev.c, prev.d, prev.e, prev.f);
    return true;
}

/* ------------------------------------------------- a context that draws nothing
 * The capture runs the real renderer for its primitives, not for a picture, so
 * it is handed a sink. Every 2D call is a no-op and the few that must return
 * something return the least it will accept.
 */
function nullCtx(w, h) {
    const noop = () => {};
    return new Proxy({}, { get: (t, k) => {
        if (k === 'canvas') return { width: w, height: h };
        if (k === 'getSerializedSvg') return undefined;   // or it takes the SVG path
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'createLinearGradient' || k === 'createRadialGradient') {
            return () => ({ addColorStop: noop });
        }
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return noop;
    }, set: () => true });
}

/* ------------------------------------------------------------ module state
 * Everything the camera needs is module state with a setter rather than a
 * parameter on every call, because the port reads it in a dozen places and
 * threading it through each would have made the extraction from the harness a
 * rewrite instead of a move. The two consumers push their view in and the
 * module never asks where it came from.
 */
function setStdDev(v) { sceneStdDev = v; }
function setCapturing(on) { capturing = !!on; }
function getResident() { return resident; }
function clearResident() { resident = null; }
function hasGL() { return !!gl; }
function clearGL() { gl = null; }
function getShow() { return { ribbon: showRibbon, sticks: showSticks }; }
function isCapturing() { return capturing; }
function setRot(m) { viewRot = m; }
function getZoom() { return viewZoom; }
function getEdgeCount() { return edgeCount; }
// IS WEBGL2 THERE AT ALL? Asked once and remembered - and the probe context is
// handed back immediately. A browser keeps only a dozen or so live WebGL
// contexts and drops the oldest when it runs out, so a probe that leaks one per
// call eventually costs a real renderer its context: the symptom was the GPU
// checkbox quietly disappearing from the panel after a few reloads.
let availCache = null;
function available() {
    if (availCache !== null) return availCache;
    if (typeof document === 'undefined') { availCache = false; return false; }
    try {
        const c = document.createElement('canvas');
        const g = c.getContext('webgl2');
        if (g) {
            const ext = g.getExtension('WEBGL_lose_context');
            if (ext) ext.loseContext();
        }
        availCache = !!g;
    } catch (e) { availCache = false; }
    return availCache;
}

window.py2dmolCartoonGPU = {
    // the app's entry, and the two calls that go with it
    // a build marker, so "is the browser running what I just wrote" is one
    // question with one answer rather than a guess
    build: 'plate-plain-2',
    // WHETHER THE STATION SHADER IS USABLE ON THIS DRIVER, and why not when it
    // is not. Nothing draws with it yet; this is what the gate reads.
    stationProgram: () => ({ linked: !!progStations, error: stationLinkError }),
    stationMeshOf, stationMeshNow, makeResidentStations,
    installStations, updateStations,
    clearResidentStations, setStationDraw,
    stationRefusal: () => stationRefusal,
    edgeRefresh: () => lastEdgeRefresh,
    stickRefresh: () => lastStickRefresh,
    stationUpdate: () => lastStationUpdate,
    // 🔴 WHETHER THERE IS A KEY TO COMPARE AGAINST AT ALL. The fast path needs
    // topoSig === appTopoSig, and a NULL appTopoSig fails that comparison
    // silently - it is not a mismatch, so the "which term moved" diagnostic
    // does not fire either, and a probe sees a rebuild with no reason attached.
    // That cost a session's worth of guessing on a nucleic structure.
    topoSignature: () => appTopoSig,
    // WHY THE LAST FRAME REBUILT, in one string, surviving that rebuild.
    stationDecline: () => stationDecline,
    meshMissing: () => lastMeshMissing,
    // HOW THE MESH IS DIVIDED, which is what decides whether the tail can be
    // refreshed: part 0 must be exactly what the station table describes.
    partSpans: () => (residentPartSpans || []).map((p) => p.count),
    // ...and what the MESH holds, which is the other half of the question: the
    // table covers a prefix, so count against residentCount is the size of the
    // tail that is NOT described by stations.
    residentCount: () => (resident ? resident.count : 0),
    // WHAT A SPLICE WOULD HAVE LOOKED LIKE ON THE LAST FRAME THAT DECLINED.
    // Null when the two tables were identical or could not be decomposed. The
    // mesh itself cannot be exported: stationMeshOf hands back SUBARRAYS of a
    // shared scratch, so it describes the next frame by the time anyone reads
    // it. The plan is a handful of numbers and does not move.
    stationSplice: () => lastSplicePlan,
    stationsResident: () => (residentStations ? {
        count: residentStations.count,
        stations: residentStations.stationCount,
        pieces: residentStations.pieceCount,
        bytes: residentStations.bytes,
        // 🔴 WHETHER THE CARD STILL HAS THE OBJECTS THIS TABLE NAMES. A table is
        // CPU arrays plus three GL handles, and every comparison on the fast path
        // reads the arrays - so a table whose buffer or textures were deleted
        // agrees with everything and draws through objects that no longer exist.
        // WebGL does not throw on that; it no-ops the write and draws garbage.
        live: !!(gl && residentStations.buf && gl.isBuffer(residentStations.buf)
            && gl.isTexture(residentStations.stationTex)
            && gl.isTexture(residentStations.pieceTex)),
        stale: !!residentStations.stale,
    } : null),
    // WHAT THE CARD IS ACTUALLY HOLDING, for a probe that needs to know which
    // half of the fast path is stale. The station textures carry this frame's
    // GEOMETRY and are rewritten per frame; the rows carry the flags and the
    // colour and are written once per BUILD. A frame that draws differently
    // from a rebuild of itself is one or the other, and they want different
    // repairs - see tests/outline_sync.py. Copies, because both are reused.
    // WHAT THE CARD ACTUALLY HOLDS, read back rather than inferred. Every
    // comparison in tests/outline_sync.py so far has been of what was UPLOADED;
    // this is the texture itself, through a framebuffer. Only a probe calls it
    // - a readPixels is a full pipeline stall.
    stationTexels: () => {
        if (!gl || !residentStations) return null;
        const read = (tex, w, texels) => {
            const h = Math.ceil(texels / w);
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D, tex, 0);
            const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
                === gl.FRAMEBUFFER_COMPLETE;
            let out = null;
            if (ok) {
                out = new Float32Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fb);
            return ok ? Array.from(out) : null;
        };
        // ...and the instance BUFFERS, which is the half nothing has compared.
        // `residentStations.rows` is a CPU copy written once at install; the
        // buffer on the card is what the draw reads, and anything that patches
        // it without writing the copy back - a palette patch, a halo, a stick
        // span - is invisible to every comparison made from the copy.
        const readBuf = (b, floats) => {
            if (!b || !(floats > 0)) return null;
            const out = new Float32Array(floats);
            gl.bindBuffer(gl.ARRAY_BUFFER, b);
            gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
            return Array.from(out);
        };
        // ...and the two textures the DRAW samples that nothing above compares:
        // the per-residue visibility map and the PALETTE. The palette is
        // resolved by makeResident on every rebuild - setPalette(paletteSource())
        // - and never by a station update, so its content is whatever the last
        // build worked out. recolour() re-applies the same SOURCE and so cannot
        // show a difference; only reading the texture can.
        const readByte = (tex, w, h) => {
            if (!tex || !(w > 0) || !(h > 0)) return null;
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D, tex, 0);
            const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
                === gl.FRAMEBUFFER_COMPLETE;
            let out = null;
            if (ok) {
                out = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fb);
            return ok ? Array.from(out) : null;
        };
        return {
            palette: readByte(palTex, palW, palH),
            vis: readByte(visTex, visW, visH),
            stations: read(residentStations.stationTex, residentStations.stationW,
                residentStations.stationCount * 4),
            pieces: read(residentStations.pieceTex, residentStations.pieceW,
                Math.max(1, residentStations.pieceCount * 2)),
            rowBuf: readBuf(residentStations.buf,
                residentStations.count * STATION_ROW),
            fillBuf: readBuf(buf3, resident ? resident.count * FILL_STRIDE : 0),
            // 🔴 AND THE OUTLINE BUFFER, which nothing compared for two
            // sessions. The ink pass draws whether or not the outline is
            // switched on - a contact is not an outline - so a probe that set
            // outlineMode off and concluded "it is not the outline" was
            // comparing pictures that both still had one.
            inkBuf: readBuf(bufInk, edgeCount * ED_FLOATS),
            // ...AND HOW WIDE A ROW IS, because a reader that knows it by
            // heart is a third copy of a number that must agree. It was 19 in
            // tests/sheet_merge.py and the row grew to 20 for the outline's
            // residue: the probe strode into the middle of each row and
            // reported 154 outlines drawn across a merged sheet - the fault it
            // exists for, wearing the fix.
            edgeFloats: ED_FLOATS,
            edSrc: residentEdges && residentEdges.edSrc ? Array.from(residentEdges.edSrc) : null,
        };
    },
    // A PROBE'S SCALPEL: write one lane of the station rows and re-upload.
    // tests/outline_sync.py uses it to settle whether the one field that
    // differs between a fast frame and a rebuilt one - lane 6, kAvg - is what
    // the picture is differing over. An earlier attempt wrote the PIECE's k
    // instead of the rebuild's own row values and left a third of the lane
    // still differing, so it proved nothing either way.
    patchStationLane: (lane, values) => {
        if (!gl || !residentStations || !residentStations.rows) return 0;
        const rw = residentStations.rows;
        const n = Math.min(residentStations.count, values.length);
        let moved = 0;
        for (let f = 0; f < n; f += 1) {
            const at = f * STATION_ROW + lane;
            if (rw[at] !== values[f]) { rw[at] = values[f]; moved += 1; }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, residentStations.buf);
        gl.bufferData(gl.ARRAY_BUFFER, rw, gl.DYNAMIC_DRAW);
        return moved;
    },
    // ONE INSTANCE, WHOLE: its eighteen-float row and the sixteen floats of
    // the station it names. A bisect that says "instance 0 is drawn in one arm
    // and not the other" wants exactly this printed side by side.
    instanceDump: (i) => {
        if (!residentStations || !residentStations.rows) return null;
        const rw = residentStations.rows;
        const row = [];
        for (let k = 0; k < STATION_ROW; k += 1) row.push(rw[i * STATION_ROW + k]);
        const pad = residentStations.stationPad;
        const st = [];
        const at = Math.round(row[0]) * 16;
        if (pad) for (let k = 0; k < 16; k += 1) st.push(pad[at + k]);
        return {row, station: st, at: row[0], surf: row[1], piece: row[2]};
    },
    stationLane: (lane) => {
        if (!residentStations || !residentStations.rows) return null;
        const rw = residentStations.rows;
        const out = new Array(residentStations.count);
        for (let f = 0; f < residentStations.count; f += 1) {
            out[f] = rw[f * STATION_ROW + lane];
        }
        return out;
    },
    // THE GL CANVAS ITSELF. Everything drawn by this file lands here and is
    // then BLITTED onto the canvas the app owns, which afterwards carries
    // whatever the 2D painter puts on top - halos, contacts, labels,
    // selection. A probe comparing the app's canvas is comparing both, and a
    // difference in the second looks exactly like a difference in the first.
    glCanvas: () => appCv,
    // THE TEXTURE HANDLES BY NAME, so a probe can say WHICH texture is bound
    // to a unit rather than that some object is. Two arms binding different
    // textures to one unit set the same sampler uniform, so a uniform diff
    // cannot see it - and the first version of the GL recorder filtered
    // bindTexture out of the comparison entirely.
    // ...and the BUFFER handles, for the same reason. A log that prints an
    // object id cannot tell "the station rows" from "a buffer left bound by
    // something else", and the two arms allocate different objects, so ids
    // alone always differ and always look like noise.
    // A CLAMP ON THE INSTANCE COUNT, for a probe that needs to find WHICH
    // instance draws a given patch of pixels. Bisecting on it turns "these
    // thirty pixels differ" into "instance 4,213 differs", which is a face,
    // a station and a row that can be printed side by side.
    setInstanceLimit: (n) => { instanceLimit = (typeof n === 'number') ? n : -1; },
    bufferIds: () => ({
        stationRows: residentStations ? residentStations.buf : null,
        fill: buf3, ink: bufInk,
    }),
    textureIds: () => ({
        station: residentStations ? residentStations.stationTex : null,
        piece: residentStations ? residentStations.pieceTex : null,
        palette: palTex, vis: visTex,
    }),
    stationDump: () => (residentStations ? {
        // ...and the scale the draw actually uses. A rebuilt mesh carries this
        // frame's own scale with a ratio of one; a mesh kept from an earlier
        // frame carries THAT frame's scale and a ratio to correct it. The two
        // are equal in arithmetic and not in floating point, and every vertex
        // is multiplied by the result.
        drawScale: resident ? resident.scale * viewScaleMul : -1,
        // ...and the depth range, which maps every vertex's z. Two coincident
        // faces - the two sides of a zero-thickness slab, which is what a
        // Richardson helix is - are decided by the depth test, so a difference
        // in the last bits here changes WHICH of them the reader sees. Same
        // hue, different lightness, at a handful of pixels.
        // ...and how much of the mesh the table does NOT describe. Everything
        // past it - side chains, ligands, lone atoms, contacts - is refreshed
        // by refreshSticksFrom on a different route from the ribbon, so a
        // difference that lands in a compact blob wants to be told apart from
        // one on the backbone.
        residentCount: resident ? resident.count : -1,
        // ...and how many centroids stand behind the station count, because
        // the depth-range correction reads one against the other.
        centroidLen: (resident && resident.centroids) ? resident.centroids.length : -1,
        tail: resident ? resident.count - residentStations.count : -1,
        zMin: resident ? resident.zMin : -1,
        zMax: resident ? resident.zMax : -1,
        rad: resident ? resident.rad : -1,
        buildScale: resident ? resident.scale : -1,
        scaleMul: viewScaleMul,
        count: residentStations.count,
        stations: residentStations.stationCount,
        pieces: residentStations.pieceCount,
        rows: Array.from(residentStations.rows || []),
        stationPad: Array.from(residentStations.stationPad || []),
        piecePad: Array.from(residentStations.piecePad || []),
        stationsData: residentStations.stations,
        faceStation: Array.from(residentStations.faceStation || []),
        faceSurf: Array.from(residentStations.faceSurf || []),
        facePiece: Array.from(residentStations.facePiece || []),
    } : null),
    render: renderApp, renderTube: renderTubeApp, blit: blitApp,
    invalidate, paramsFromRenderer,
    available, initGL, hasGL, clearGL, setZoomExact,
    setResidueMap, setSize, setPaletteSource, setDefaultParams, setOrtho,
    setPixelRatio, setFocalLength, setPaper, recolour,
    facesOf, makeResident, drawResident, drawInk, nullCtx,
    getResident, clearResident, getEdgeCount,
    getResidentEdges: () => residentEdges,
    setPalette, setResidueVisible, setAllResiduesVisible,
    setResidueOpacity, setAllResiduesOpacity, setVisible, getShow,
    setStdDev, setCapturing, isCapturing, currentZoom, setZoom, zoomBy, getZoom,
    rotateView, setViewYawPitch, currentRot, setRot,
    focalLength, orthoAmount, isPersp, viewVecAt, unproject,
    noteDragVelocity, stopInertia, inertiaStep, startInertia,
    // The measurement harness reaches in for the pieces that only make sense
    // beside it - the CPU painter it compares against, the matrix helpers its
    // fixtures are built with. Not part of the contract with the app.
    __internals: {
        PAPER, toneOf, residueOf, paintCPU, paintGPU,
        matT, matMul, dotv, apply, rotYawPitch,
        rotationMatrixX: glRotX, rotationMatrixY: glRotY,
    },
};
})();
