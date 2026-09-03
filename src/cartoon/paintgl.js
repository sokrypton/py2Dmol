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
                    const slot = (p.ci !== undefined && p.ciPalette) ? p.ci * 3
                        : (palComplete = false, -1);
                    const inward = (top ? kAvg : -kAvg) > 0;
                    const twoTone = !isSide && inward && rich && p.ss === 'H' && !p.co;
                    faces.push({ res: residueOf(p),
                        q: [A[k], B[k], B[k + 1], A[k + 1]],
                        c: edgeWhite ? { r: 244, g: 246, b: 240 }
                            : (twoTone ? tintWhite(base, 0.68) : base),
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
                        iMul: twoTone ? 0.3 : 1,          // BACK_INNER_SHADE
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
                        colMode: slot < 0 ? 0 : (edgeWhite ? 2 : (twoTone ? 1 : 0)),
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
                q: p.q, c: p.c || { r: 200, g: 140, b: 60 }, top: 1, kAvg: 0,
                // A FLAT STICK IS ONE DOUBLE-SIDED QUAD. At zero thickness -
                // which plain cartoon asks for, because flatness IS its look -
                // the box collapses to a single face with nothing behind it,
                // and the renderer's rule for it is `orient it at the eye`.
                // That is a per-view decision, so it cannot be baked: carried
                // as a flag, the shader redoes it every frame. Without it the
                // stick cull deleted every side chain the moment the model
                // turned past the capture view.
                stick: 1, two: p.two ? 1 : 0, iMul: 1, nl: p.nl,
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
bool clipped(float z) {
  float c = clipCover(z);
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
`;

const VS = `#version 300 es
in vec2 aPos; in float aZ; in vec3 aCol;
uniform vec2 uSize; uniform vec2 uZRange;
out vec3 vCol;
out float vCull;      // the shared fragment shader reads it; nothing to cull here
out float vZv;        // view z, for the clip slab in the fragment
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
  int corner = gl_VertexID;
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
    lum = faceLum(oLb, aK, aTop, a, oT, aIMul, aPlate);
    if (uCel > 0.5) {
      // the same bounds the renderer quantises between, and they track iMul
      tone = quant(tone, soft(FLAT_TONE), 1.0);
      float lo = soft(LIGHT_AMB * (1.0 - uInnerShade * max(0.0, aIMul)));
      float hi = soft(1.0 + uInnerShade * max(0.0, -aIMul)) + LIGHT_HI * uHiGain;
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
  if (aColMode > 1.5) base = vec3(244.0, 246.0, 240.0);
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
  if (show >= 0.5 && uVisW > 0.5) {
    // clamped: an out-of-range texelFetch returns 0, which reads as hidden, so
    // a stray index does not silently delete geometry
    int ri = clamp(int(aRes + 0.5), 0, int(uVisN) - 1);
    int w = int(uVisW);
    if (texelFetch(uVis, ivec2(ri % w, ri / w), 0).r < 0.5) show = 0.0;
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
out vec3 vInk;
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
  bool draw = (aAlways > 2.5) ? true : ((aAlways > 1.5) ? (f0 || f1) : pairDraw);
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
  if (clipped(zSurf)) discard;
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
in vec3 vInk; in float vZv; out vec4 fragColor;
${CLIP_GLSL}
${GRAIN_GLSL}
void main() {
  if (clipped(vZv)) discard;
  fragColor = vec4(grainAt(vInk), 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vCol; in float vCull; in float vZv; out vec4 fragColor;
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
  if (clipped(vZv)) discard;
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
// ...AND ONLY WHERE THERE IS SOMETHING TO GO BACK TO. Holding a mesh's arrays
// after they have been uploaded costs their size in JS heap - 45 to 67 MB for
// a ribosome - and buys nothing at all for a viewer with one object in it,
// which has no eye to switch. It is switched on from renderApp when the page
// has more than one object loaded.
let keepArrays = false;
function setKeepMeshArrays(on) {
    keepArrays = !!on;
    if (!on) { lastFill = null; lastEdges = null; spareMesh = null; }
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
    const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    buf = gl.createBuffer();
    locPos = gl.getAttribLocation(prog, 'aPos');
    locZ = gl.getAttribLocation(prog, 'aZ');
    locCol = gl.getAttribLocation(prog, 'aCol');
    prog3 = gl.createProgram();
    gl.attachShader(prog3, mk(gl.VERTEX_SHADER, VS3D));
    gl.attachShader(prog3, mk(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog3);
    if (!gl.getProgramParameter(prog3, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog3));
    buf3 = gl.createBuffer();
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
    gl.attachShader(progTube, mk(gl.VERTEX_SHADER, VSTUBE));
    gl.attachShader(progTube, mk(gl.FRAGMENT_SHADER, fsTube));
    gl.linkProgram(progTube);
    if (!gl.getProgramParameter(progTube, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(progTube));
    }
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
    gl.attachShader(progAO, mk(gl.VERTEX_SHADER, VSQUAD));
    gl.attachShader(progAO, mk(gl.FRAGMENT_SHADER, FSAO));
    gl.linkProgram(progAO);
    if (!gl.getProgramParameter(progAO, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(progAO));
    progBlur = gl.createProgram();
    gl.attachShader(progBlur, mk(gl.VERTEX_SHADER, VSQUAD));
    gl.attachShader(progBlur, mk(gl.FRAGMENT_SHADER, FBLUR));
    gl.linkProgram(progBlur);
    if (!gl.getProgramParameter(progBlur, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(progBlur));
    progCopy = gl.createProgram();
    gl.attachShader(progCopy, mk(gl.VERTEX_SHADER, VSQUAD));
    gl.attachShader(progCopy, mk(gl.FRAGMENT_SHADER, FSCOPY));
    gl.linkProgram(progCopy);
    if (!gl.getProgramParameter(progCopy, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(progCopy));
    progInk = gl.createProgram();
    gl.attachShader(progInk, mk(gl.VERTEX_SHADER, VSINK));
    gl.attachShader(progInk, mk(gl.FRAGMENT_SHADER, FSINK));
    gl.linkProgram(progInk);
    if (!gl.getProgramParameter(progInk, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(progInk));
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
// THE EDIT. Show or hide one residue's geometry without touching the mesh.
function setResidueVisible(idx, on) {
    if (!visData || idx < 0 || idx >= visData.length) return;
    const v = on ? 255 : 0;
    if (visData[idx] === v) return;
    visData[idx] = v;
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, idx % visW, Math.floor(idx / visW), 1, 1,
        gl.RED, gl.UNSIGNED_BYTE, visData.subarray(idx, idx + 1));
}
function setAllResiduesVisible(on) {
    if (!visData) return;
    visData.fill(on ? 255 : 0);
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, visW, visH, gl.RED, gl.UNSIGNED_BYTE, visData);
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
function buildMeshPart(faces, scale, prm, lines) {
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
    for (const ln of (lines || [])) {
        // TAKE THE DEPTH BIAS BACK OFF FIRST. A contact's projected points have
        // it added to their z - the 2D pass sorts on that channel and never
        // reads position from it, so the drawn line does not move. Unprojecting
        // from a biased z does move it: the point comes back half an Angstrom
        // toward the eye in MODEL space, along whatever direction the capture
        // happened to be looking, and that offset then turns with the structure
        // - the contact drifting off the two CAs it names as the view rotates.
        const zb = ln.zBias || 0;
        const mp = ln.pts.map((q2) => apply(inv,
            unproject([q2[0], q2[1], q2[2] - zb], scale)));
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
    const data = new Float32Array(faces.length * 48);
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
        out[0] = inv[0][0] * x + inv[0][1] * y + inv[0][2] * z;
        out[1] = inv[1][0] * x + inv[1][1] * y + inv[1][2] * z;
        out[2] = inv[2][0] * x + inv[2][1] * y + inv[2][2] * z;
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
    for (const [id, e] of pieceRails) {
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
    const hashAt = (o) => {
        const h = Math.round(M[o] * 1000) * 73856093
            ^ Math.round(M[o + 1] * 1000) * 19349663
            ^ Math.round(M[o + 2] * 1000) * 83492791;
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
    let gCap = 1024;
    let gN = 0;
    let gHead = new Int32Array(gCap);
    let gTail = new Int32Array(gCap);
    const gGrow = () => {
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
    const E_I = 5;         // real, count, nCount, pal, bits
    const EB_TWO = 1; const EB_NOINK = 2; const EB_STICK = 4;
    const EB_FULL = 8; const EB_SEAM = 16; const EB_OUTER = 32;
    const EB_COL = 64; const EB_N0 = 128; const EB_N1 = 256;
    let eCap = 1024;
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
        full, seam, outer, sc) => {
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
        if (outer && !ghost) bits |= EB_OUTER;

        // AND ITS COLOUR. The Ink control tints an outline toward its own
        // element's colour, so an edge has to know which palette slot it
        // belongs to. The first face to claim the edge lends it one.
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
            eIn[eb + 2] = 1;
        } else if (nc === 1) {
            if (nrm) {
                eF[ef + 9] = nrm[0]; eF[ef + 10] = nrm[1]; eF[ef + 11] = nrm[2];
                bits |= EB_N1;
            }
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
        const isRibSide = (f.surf === 2 || f.surf === 3);
        // THE SIGN TRAVELS AS AN ARGUMENT. This was a closure declared inside
        // the loop, so it was allocated once per face in the build - and a
        // stick face never calls it, every use being guarded on `isRibSide`.
        // flat: the piece mean, matching what the reference quantises.
        // ASKED ONLY WHERE IT IS READ - `nFlat` consults it under `isRibSide`
        // - so a nucleosome's 70,362 stick faces were each building a
        // three-element array for it and dropping it unread.
        const wFlat = (isRibSide && pf && pf.wMean)
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
        const broadFace = (f.surf === 0 || f.surf === 1);
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
        const nA = isRibFace ? (frA ? frA.n : nn) : (isRibSide ? (wSigned(frA, sideSign) || nn) : nn);
        const nB = isRibFace ? (frB ? frB.n : nA)
            : (isRibSide ? (wSigned(frB, sideSign) || nA) : nA);
        const nFlat = isRibFace ? ((pf && pf.nMean) || nA)
            : (isRibSide ? ((wFlat || wSigned(frA, sideSign)) || nn) : nn);
        const tA = (frA && (isRibFace || isRibSide)) ? frA.t : tt;
        const tB = (frB && (isRibFace || isRibSide)) ? frB.t : tA;
        f._nA = nA; f._nB = nB; f._nFlat = nFlat; f._tA = tA; f._tB = tB;
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
    let edUp = null;                 // ...and the floats behind them
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
            if (nLenOf[fi] < 1e-6) continue;   // zero area, measured above
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
            const alongOnly = f.surf !== undefined && f.surf < 4 && !f.fullOutline;
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
                addEdge(oa, ob, ka, kb, fInkN, fStick, fPal, ghost,
                    fTwo, fNoInk, fCol, fFull, seamCross, fOuter, fSc);
            }
        }

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
        const edgeTotal = eN;
        const ED_FLOATS = 19;      // p0, p1, n0, n1, always, stick, pal, col, w
        const ed = new Float32Array((edgeTotal + contactEdges.length * 2) * ED_FLOATS);
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
            if (!eIn[eb] || (bits & EB_NOINK) || (bits & EB_SEAM)) {
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
        window.__edgeStats = { edges: partEdges, boundary: nBoundary, crease: nCrease,
            faces: faces.length, interiorDropped: nInterior, nonManifoldDropped: nNonManifold,
            ghostOnly: nGhostOnly };
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
        fill: data, edges: edUp, edgeCount: partEdges, hasContacts,
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
    mix(scale);
    mix(faces.length);
    // ...AND THE PARAMETERS, because thickness, the outline and the crease
    // angle all change what a ribbon face becomes without moving one corner.
    try { for (const k of Object.keys(prm || {})) {
        const v = prm[k];
        if (typeof v === 'number') mix(v);
        else if (typeof v === 'boolean') mix(v ? 1 : 2);
    } } catch (e) { mix(-1); }
    // ...the inner loop, written out: no closure call, one multiply a number.
    for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        const q = f.q;
        const a = q[0]; const b = q[2] || a;
        h = (Math.imul(h, 31) + ((a[0] * 512) | 0)) | 0;
        h = (Math.imul(h, 31) + ((a[1] * 512) | 0)) | 0;
        h = (Math.imul(h, 31) + ((a[2] * 512) | 0)) | 0;
        h = (Math.imul(h, 31) + ((b[0] * 512) | 0)) | 0;
        h = (Math.imul(h, 31) + ((b[1] * 512) | 0)) | 0;
        h = (Math.imul(h, 31) + (f.c ? (f.c.r | 0) : 0)) | 0;
        h = (Math.imul(h, 31) + ((f.res || 0) | 0)) | 0;
        h = (Math.imul(h, 31) + (f.two ? 1 : 0)) | 0;
        // NOT THE PALETTE SLOT. It is the one thing about a ribbon face that a
        // side chain DOES move: `ci` is an index into the segment list, side
        // chain bonds are segments, and two of 8,514 ribbon faces on 4HHB come
        // out one block further along. Hashing it would miss the cache for
        // every side-chain change on the strength of two numbers - so it is
        // left out here and PATCHED on reuse instead, which is exact for the
        // fills. See makeResident.
    }
    return h >>> 0;
}

// WHERE THE SLOT SITS IN AN INSTANCE ROW. 48 floats: four corners, six frame
// vectors, the three occlusion dots, the colour, and three flag words - the
// slot is the first float of the third. Keep in step with the emit pass.
const FILL_STRIDE = 48;
const FILL_PAL_AT = 44;

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
    const groups = [[], [], []];
    for (const f of faces) groups[f.stick ? (f.sc ? 2 : 1) : 0].push(f);
    const RB = window.__rebuild || {};
    const t0 = performance.now();

    // ...the two that are worth keeping, each against a hash of its own faces
    const parts = [];
    for (let g = 0; g < 3; g++) {
        const face = groups[g];
        // CONTACTS RIDE WITH `other`: they are strokes rather than faces, and
        // they change when the contacts change, which is not when a side chain
        // does.
        const ln = (g === 1) ? lines : null;
        if (g === 2) {                      // always rebuilt: it is the change
            parts.push(buildMeshPart(face, scale, P0, ln));
            continue;
        }
        const slot = g === 0 ? ribbonPart : otherPart;
        const hash = ribbonHashOf(face, scale, P0);
        let part = (slot && slot.hash === hash) ? slot.part : null;
        // REPORTED FROM WHAT HAPPENED, not from the comparison: a probe that
        // reads the slot cannot tell a reuse from a rebuild that happened to
        // leave the same slot behind, and it said "reused" through a mutation
        // that rebuilt every time.
        const cameFromCache = !!part;
        if (g === 0) RB.ribbonReused = cameFromCache;
        if (g === 1) RB.otherReused = cameFromCache;
        if (!part) {
            part = buildMeshPart(face, scale, P0, ln);
            if (g === 0 && window.__heapProbe) {
                // the ribbon's own phase record, before the others overwrite
                // it - they share `__mrPhase` and the last one wins
                window.__mrRibbon = Object.assign({}, window.__mrPhase);
            }
            const keep = (part.bytes <= MESH_KEEP_MAX_BYTES) ? { hash, part } : null;
            if (g === 0) ribbonPart = keep; else otherPart = keep;
        } else {
            patchPalette(part, face, RB);
        }
        parts.push(part);
    }
    RB.nRibbon = groups[0].length;
    RB.nOther = groups[1].length;
    RB.nSide = groups[2].length;
    RB.stickMs = +(performance.now() - t0).toFixed(1);
    return installParts(parts, scale);
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
    for (const p of parts) {
        nFill += p.fill.length;
        nEdge += p.edges ? p.edges.length : 0;
        nCen += p.centroids.length;
        count += p.count;
        edges += p.edgeCount;
        if (p.rad > rad) rad = p.rad;
        if (p.hasContacts) hasContacts = true;
    }
    const fill = new Float32Array(nFill);
    const cen = new Float32Array(nCen);
    let fo = 0; let co = 0;
    for (const p of parts) {
        fill.set(p.fill, fo); fo += p.fill.length;
        cen.set(p.centroids, co); co += p.centroids.length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf3);
    gl.bufferData(gl.ARRAY_BUFFER, fill, gl.STATIC_DRAW);

    let ed = null;
    if (nEdge) {
        ed = new Float32Array(nEdge);
        let eo = 0;
        for (const p of parts) {
            if (!p.edges) continue;
            ed.set(p.edges, eo); eo += p.edges.length;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, bufInk);
        gl.bufferData(gl.ARRAY_BUFFER, ed, gl.STATIC_DRAW);
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

function drawResident(cv, prm, prmAO) {
    const P0 = prm || defaultParams();
    if (P0.ortho !== undefined) setOrtho(P0.ortho);
    if (!resident) return;              // nothing built yet; the caller builds
    gl.useProgram(prog3);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    if (!composeKeepFrame) {
        clearToPaper();
        gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf3);
    const stride = 48 * 4;
    const bound = [];
    const bind = (name, size, off) => {
        const l = gl.getAttribLocation(prog3, name);
        if (l < 0) return;
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off);
        gl.vertexAttribDivisor(l, 1);      // one set of values per FACE
        bound.push(l);
    };
    bind('aC0', 3, 0); bind('aC1', 3, 12); bind('aC2', 3, 24); bind('aC3', 3, 36);
    bind('aNA', 3, 48); bind('aNB', 3, 60); bind('aTA', 3, 72); bind('aTB', 3, 84);
    bind('aFlatN', 3, 96); bind('aFlatShade', 3, 108);
    bind('aDots', 3, 120); bind('aBase', 3, 132);
    bind('aFlags0', 4, 144); bind('aFlags1', 4, 160); bind('aFlags2', 4, 176);
    const R = currentRot();
    gl.uniformMatrix3fv(gl.getUniformLocation(prog3, 'uRot'), false,
        new Float32Array([R[0][0], R[1][0], R[2][0],
            R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]));
    gl.uniform2f(gl.getUniformLocation(prog3, 'uSize'), cv.width, cv.height);
    const dzprog3 = shiftZ();
    const zr3 = composeZ || [resident.zMin + dzprog3, resident.zMax + dzprog3];
    gl.uniform2f(gl.getUniformLocation(prog3, 'uZRange'), zr3[0], zr3[1]);
    gl.uniform3f(gl.getUniformLocation(prog3, 'uShift'),
        viewShift[0], viewShift[1], viewShift[2]);
    const sr = shadeRange();
    // the shade range is measured off the unshifted centroids, and the
    // shader now evaluates a shifted one - so it travels with them
    gl.uniform2f(gl.getUniformLocation(prog3, 'uShadeRange'), sr[0] + dzprog3, sr[1] + dzprog3);
    gl.uniform1f(gl.getUniformLocation(prog3, 'uScale'), drawScale());
    uploadClip(prog3);
    gl.uniform1f(gl.getUniformLocation(prog3, 'uPersp'), isPersp() ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog3, 'uFL'), focalLength());
    gl.uniform1f(gl.getUniformLocation(prog3, 'uShowRibbon'), showRibbon ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog3, 'uShowSticks'), showSticks ? 1 : 0);
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
    gl.uniform1f(gl.getUniformLocation(prog3, 'uDiscInk'),
        P0.ink ? P0.inkWidth * pixelRatio : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, visTex);
    gl.uniform1i(gl.getUniformLocation(prog3, 'uVis'), 0);
    gl.uniform1f(gl.getUniformLocation(prog3, 'uVisW'), visTex ? visW : 0);
    gl.uniform1f(gl.getUniformLocation(prog3, 'uVisN'),
        (resMap && resMap.nBase) ? resMap.nBase : 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, palTex);
    gl.uniform1i(gl.getUniformLocation(prog3, 'uPal'), 1);
    gl.uniform1f(gl.getUniformLocation(prog3, 'uPalW'), palTex ? palW : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(gl.getUniformLocation(prog3, 'uFlatCull'), P0.flatCull ? 1 : 0);
    gl.uniform3f(gl.getUniformLocation(prog3, 'uPaper'), PAPER[0], PAPER[1], PAPER[2]);
    // the same numbers the 2D renderer is using for this preset
    const sp = P0;
    // THE GRAIN. A redraw, never a rebuild - it is a fragment-stage multiply
    // and the mesh knows nothing about it.
    bindPaper(prog3, cv, sp.pencil);
    const u = (n2, v) => gl.uniform1f(gl.getUniformLocation(prog3, n2), v);
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
        gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, resident.count);
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
        gl.useProgram(prog3);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, aoTex2);
        gl.uniform1i(gl.getUniformLocation(prog3, 'uAOTex'), 3);
        gl.uniform2f(gl.getUniformLocation(prog3, 'uSizeF'), cv.width, cv.height);
    }
    u('uUseAO', wantAO ? 1 : 0);
    u('uAOAmt', wantAO && prmAO ? (typeof prmAO.amount === 'number' ? prmAO.amount : 0.8) : 0);

    const tmS = tmStart('c1-surfaces');
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, resident.count);
    tmEnd(tmS);
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
    const stride = 19 * 4;
    const binds = [['aP0', 3, 0], ['aP1', 3, 12], ['aN0', 3, 24],
        ['aN1', 3, 36], ['aAlways', 1, 48], ['aEdgeStick', 1, 52], ['aEdgePal', 1, 56],
        ['aEdgeCol', 3, 60], ['aEdgeW', 1, 72]];
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
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, edgeCount);
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
let appColors = null;              // the palette the app last handed over
let appColourKey = '';             // ...and a digest of it, since it is mutated in place
let appPalComplete = true;         // ...and whether recolouring it would do anything
let appPos = null;                 // the drawn positions, model space, xyz triples

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
function sharedGeometryKey(r) {
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
        r._coordsKey ? r._coordsKey()
            : (r.currentFrame + '|' + ((r.multiState && r.multiState.enabled
                && r.multiState.sourceNames) ? r.multiState.sourceNames.join(',') : '')
               + '|' + coordsProbe(r.coords)),
        r.segmentIndices && r.segmentIndices.length,
        // THE MASK BY WHAT IS IN IT. It is rebuilt from the objects' own
        // records whenever the drawn set changes, so an identical picture
        // arrives as a different Set - and by identity that rebuilt everything
        // for nothing on every eye toggle.
        visKeyOf(r.visiblePositions),
        r.lineWidth,
        // per-residue side chains change the segment list
        r.sidechainMap ? r.sidechainMap.size : 0,
        (bb && bb.size) ? 'nobb' + idOf(bb) + ':' + bb.size : 'bb',
        // CONTACTS ARE GEOMETRY. Their endpoints, weight and colour are all
        // baked in when the mesh is built - a contact's width is CONTACT_WIDTH
        // times its own stored weight, in Angstrom - so the width slider and
        // the colour swatch both need a rebuild to be seen.
        contactKeyOf(r),
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
function signatureOf(r, w, h, colors) {
    const o = r.objectsData && r.objectsData[r.currentObjectName];
    return sharedGeometryKey(r).concat([
        // the extent of what is DRAWN - the merge has its own, and the camera
        // scale is built from it
        ((r.drawnStats && r.drawnStats()) || o || {}).maxExtent, w, h,
        r.cartoonThickness, r.cartoonSheetFlat, r.cartoonDetail,
        r.cartoonArrows, r.cartoonRichardson, r.cartoonStyle,
        // NOT colorMode. Colour is a texture: three texels per segment against
        // a mesh that never moves, and putting the mode in here made every
        // scheme change a full rebuild - 45 to 95 ms where the upload is under
        // one. What DOES belong is the half-bond table, because element colour
        // is not a colour at all as far as the geometry is concerned: the
        // RENDERER cuts a bond at its midpoint when the palette carries
        // `halves`, and that happens at capture.
        colors && colors.halves ? 'halves:' + colors.halves.length : 'nohalves',
        // ...and the two things that make a colour change GEOMETRY. Where an
        // interval's two ends disagree the renderer CUTS it at its midpoint and
        // gives each half its own end's colour, so a single coloured residue
        // runs from the midpoint before it to the midpoint after it. That only
        // happens in ss mode or where the object carries explicit overrides -
        // and repainting the old cut structure with the new colours puts every
        // transition half a residue late, which is the loop after a strand
        // coming out strand-coloured. Both are in the signature, so entering
        // either rebuilds; rainbow to chain and back still repaints.
        (r._getEffectiveColorMode ? r._getEffectiveColorMode() : r.colorMode) === 'ss',
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
        // the outline is 91% of a build and is skipped when it is off, so
        // switching it on is a rebuild by construction
        r.outlineMode, (r.relativeOutlineWidth || 0) > 0,
        // FORCED SECONDARY STRUCTURE IS GEOMETRY. objectsData[name].sse maps a
        // position to 'H', 'E' or 'C' and wins over the assignment, so editing
        // it turns a loop into a strand - a different ribbon, not a different
        // colour. The 2D pass folds the same digest into its own secKey.
        (window.py2dmolCartoon && window.py2dmolCartoon.sseKey
            ? window.py2dmolCartoon.sseKey(r) : ''),
        // A BASE PLATE IS GEOMETRY, and which residues have one is a per-object
        // set the 2D pass reads while it builds them (baseShown). Nothing else
        // here moves when it changes - a plate is drawn from the ribbon frame,
        // not from a position - so hiding a base rebuilt nothing and the GPU
        // went on drawing the plate from the cached mesh. By identity, like the
        // visibility mask: setBasesFor assigns a new Set every time.
        (() => { const b = r.mergedObjectSet ? r.mergedObjectSet('bases')
            : (o && o.bases); return b ? 'b' + idOf(b) + ':' + b.size : 'ball'; })(),
        // ELEMENT COLOURS ARE GEOMETRY, for the reason the halves term above
        // gives: a bond whose ends differ is CUT at its midpoint when the mesh
        // is captured. Switching elements off uncuts it, and the halves term
        // cannot see that - it is a length, and the array keeps its length
        // whatever is in it. By identity, like the plates: setElementsFor
        // assigns a new Set every time.
        (() => { const e = r.mergedObjectSet ? r.mergedObjectSet('elements')
            : (o && o.elements); return e ? 'e' + idOf(e) + ':' + e.size : 'eall'; })(),
        // THE NUCLEIC TRACE SMOOTHING IS GEOMETRY: it moves the rails, the
        // plates and the rungs together (see smoothNucleicTrace), so switching
        // it rebuilds rather than repaints.
        r.naSmooth === false ? 'naraw' : 'nasmooth',
        r.cartoonBasePlates === false ? 'noplates' : 'plates',
    ]).join('|');
}

// ONE 2D RENDER WITH THE PAINTER SWITCHED OFF. The three hooks are set and
// cleared around it so a renderer that is also being drawn normally is never
// left in probe mode.
function captureFrom(renderer, w, h, colors) {
    const keep = {
        noViewCull: renderer._noViewCull, frameProbe: renderer._frameProbe,
        probeOnly: renderer._probeOnly, primProbe: renderer._primProbe,
        posProbe: renderer._posProbe, traceProbe: renderer._traceProbe,
        pencil: renderer.cartoonPencil, zoom: renderer.viewerState.zoom,
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
        setCapturing(false);
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
    spareMesh = (m && m.bytes <= MESH_CACHE_MAX_BYTES) ? m : null;
    if (typeof window !== 'undefined') {
        window.__spareMesh = spareMesh
            ? { sig: spareMesh.sig, bytes: spareMesh.bytes } : null;
    }
}

function restoreMesh(sig) {
    if (!spareMesh || spareMesh.sig !== sig) return false;
    const m = spareMesh;
    keepMesh(appSig);              // the exchange
    return activateMesh(m);
}

function invalidate() {
    appSig = null; appColourKey = ''; appPalComplete = true; tubeSig = null;
    // ...AND THE SPARE WITH IT. invalidate() means the geometry is no longer
    // what any mesh was built for - a structure edited, a frame replaced - so
    // a mesh kept under a signature that happens to come round again would be
    // the old shape.
    spareMesh = null; lastFill = null; lastEdges = null;
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
        const fresh = !gl || appCv.width !== w || appCv.height !== h;
        if (appCv.width !== w || appCv.height !== h) {
            appCv.width = w; appCv.height = h;
        }
        // A RESIZE DOES NOT DROP THE CONTEXT, but the first call must make one.
        if (!gl && !initGL(appCv)) return false;
        if (fresh) appSig = null;

        if (!bufferFits(w, h)) return false;
        setRot(renderer.viewerState.rotation);
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

        const sig = signatureOf(renderer, w, h, colors);
        // ...AND IS IT THE ONE WE PUT DOWN A MOMENT AGO? Switching an object
        // off and on again alternates between two meshes, and rebuilding each
        // time runs the whole 2D pass and the outline pass for geometry that
        // has not changed. Coming back to a mesh already built is two uploads.
        // WORTH KEEPING A MESH AT ALL? Only where an eye can switch one off
        // and on again, which means more than one object on the page.
        setKeepMeshArrays(Object.keys(renderer.objectsData || {}).length > 1);
        if (sig !== appSig && restoreMesh(sig)) {
            appSig = sig;
            appColors = colors;
            appColourKey = idOf(colors);
            setPaletteSource(() => appColors);
            setDefaultParams(() => paramsFromRenderer(renderer));
            setResidueMap({ nBase: renderer.coords.length,
                sidechainMap: renderer.sidechainMap || null });
            setSize(displayWidth, displayHeight);
            if (typeof renderer._ensureRotated === 'function') renderer._ensureRotated();
            recolour();
        }
        if (sig !== appSig || !resident) {
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
            setPaletteSource(() => appColors);
            setDefaultParams(() => paramsFromRenderer(renderer));
            appColors = colors;
            appColourKey = idOf(colors);
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
            const { prims, scale, pos, trace } = captureFrom(renderer,
                displayWidth, displayHeight, colors);
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
            const { faces, lines, paletteComplete } = facesOf(prims, prm, true);
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
            RB.total = +(performance.now() - RB.t0).toFixed(1);
            // the mesh's scale already carries the zoom it was captured at, so
            // the draw multiplies by the RATIO rather than by the zoom itself
            if (resident) {
                // ...and the view span, for the same reason: the draw applies
                // the RATIO between this and the live one, so both have to be
                // remembered from the moment the mesh was made.
                const capFr = viewSpanOf(renderer);
                resident.capCentre = capFr.centre;
                resident.capHalf = capFr.half;
            }
            // THE DRAWN POSITIONS, in model space. Everything on top of the
            // canvas - the selection halo, the sequence hover, click-picking -
            // reads renderer.screenX/screenY, and the 2D pass fills them at the
            // END of a render that the GPU path no longer runs every frame. So
            // the positions are captured once and re-projected per frame, which
            // is exactly what that tail does.
            appPos = null;
            const pp = pos;
            // a diagnostic, and the one that matters: zero here means the
            // overlay has nothing to project and will silently go stale
            window.__gpuPosCount = pp ? pp.length : 0;
            if (pp && pp.length) {
                appPos = new Float64Array(pp.length * 3);
                for (let i = 0; i < pp.length; i++) {
                    const v = pp[i];
                    if (!v) { appPos[i * 3] = NaN; continue; }
                    const mv = apply(matT(currentRot()), [v.x, v.y, v.z]);
                    appPos[i * 3] = mv[0]; appPos[i * 3 + 1] = mv[1]; appPos[i * 3 + 2] = mv[2];
                }
            }
            appSig = sig;
            // CAN THIS MESH BE REPAINTED AT ALL? Only if every face knows which
            // slot of `colors` it took. A prim whose colour did NOT come from
            // the palette - an ss-mode colour, or any per-residue override,
            // which is what a SELECTION is - reports ciPalette false and
            // carries a baked colour instead. Recolouring such a mesh changes
            // nothing, which is exactly how selecting a residue stopped
            // showing: the ribbon kept the colour it was captured with. Where
            // the palette is incomplete a colour change rebuilds instead.
            appPalComplete = paletteComplete !== false;
            // ...reported, because it decides whether a colour change is an
            // upload or a rebuild, and one baked face out of a hundred
            // thousand is the difference. tests/gpu_recolour.py reads it.
            if (typeof window !== 'undefined') window.__palComplete = appPalComplete;
        } else {
            // A COLOUR CHANGE IS AN UPLOAD, not a rebuild - three texels per
            // segment against a mesh that never moves.
            const key = idOf(colors);
            if (key !== appColourKey || colors !== appColors) {
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
            }
        }
        if (!resident) return false;
        // THE VIEW SPAN THIS FRAME, against the view span the mesh carries. On the
        // frame that just rebuilt these are equal, so the multiplier is 1 and
        // the shift is zero; on every frame after an Orient they are not.
        const fr = viewSpanOf(renderer);
        const capC = resident.capCentre || fr.centre;
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
        setViewTransform(spanFit(displayWidth, displayHeight, fr.half)
            / spanFit(displayWidth, displayHeight, resident.capHalf || fr.half),
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
const objIds = new WeakMap();
let objIdNext = 1;
// A stable small integer per object, held weakly so keeping the id does not
// keep the array alive - and per object rather than "did it change since last
// time", so two viewers sharing this module do not invalidate each other.
function idOf(v) {
    if (!v) return 0;
    let id = objIds.get(v);
    if (id === undefined) { id = objIdNext++; objIds.set(v, id); }
    return id;
}

/**
 * WHAT A VISIBILITY MASK CONTAINS, not which object it is.
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
function visKeyOf(set) {
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

const TUBE_FLOATS = 15;      // ...the last two are the ends' ball colours
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
    const R = currentRot();
    const u = (nm, v) => gl.uniform1f(gl.getUniformLocation(progTube, nm), v);
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
    render: renderApp, renderTube: renderTubeApp, blit: blitApp,
    invalidate, paramsFromRenderer,
    available, initGL, hasGL, clearGL, setZoomExact,
    setResidueMap, setSize, setPaletteSource, setDefaultParams, setOrtho,
    setPixelRatio, setFocalLength, setPaper, recolour,
    facesOf, makeResident, drawResident, drawInk, nullCtx,
    getResident, clearResident, getEdgeCount,
    setPalette, setResidueVisible, setAllResiduesVisible, setVisible, getShow,
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
