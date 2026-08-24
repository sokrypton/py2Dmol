// ============================================================================
// src/cartoon/paint2d.js
// ------------------------------------
// AI Context: PRIMS TO PIXELS (window.py2dmolCartoonPaint)
// - The 2D painter: hidden-line ink, joints, halos, the paper grain and the
//   watercolour wash. It receives the primitive list cartoon/geom.js built
//   and turns it into canvas calls.
// - THE OTHER PAINTER IS cartoon/paintgl.js, which takes the same list and
//   rasterises it with WebGL2. Neither needs the other; both need the
//   geometry.
// ============================================================================
// `window` and not the self/this dance align/align.js uses: that file has to
// run inside a Worker, this one never does, and cartoon/geom.js publishes on
// window. Reading a different global from the one the other half writes is
// invisible in a browser, where they are the same object, and breaks the moment
// anything loads these outside one - which the node paint trace does.
(function () {
'use strict';
const V = window.py2dmolCartoonShared;
if (!V) throw new Error("cartoon/paint2d.js loaded before cartoon/geom.js"
    + " - it reads the shading vocabulary from there");
const {
    BACK_INNER_SHADE, CEL_LEVELS, GRAIN_SCALE, HI_KNEE, INNER_SHADE,
    LIGAND_MODEL, LIGHT, LIGHT_AMB, LIGHT_DIFF, LIGHT_HI,
    LOOP_DIM, OUTLINE_CSS, PENCIL_STRENGTH, RICH_HI_KNEE, RICH_INNER_TINT,
    SHADE_W_FULL, SHADE_W_MIN, SHEET_EDGE_RGB, SKETCH_ALPHA, SKETCH_BANDS,
    SKETCH_CSS, SKETCH_ERASE_U, SKETCH_PX, SKETCH_UNDER, SKETCH_WOBBLE_PX,
    SS, WASH_BLEED_ALPHA, WASH_BLEED_PX, WASH_OFF_X, WASH_OFF_Y,
    WASH_SMEAR_FRAC, inkColor, paperTile, rgbCss, shade,
    tintWhite,
} = V;

/**
 * PRIMS TO PIXELS: the hidden-line ink pass, the joints, the halos and the
 * grain. Reads nothing the handoff above does not carry.
 */
function paintPrims(S) {
    // ...and ctx on its own, because the painter REASSIGNS it: the frame is
    // built on an offscreen canvas when there is a grain or a wash to
    // composite, and `ctx = realCtx` swaps back before the last pass. A
    // const destructure made that "Assignment to constant variable", which
    // the paint trace never saw - none of its nine fixtures ask for a grain
    // - and four browser probes did.
    let ctx = S.ctx;
    const {
        renderer, displayWidth, displayHeight, colors, SELECTION_INK_WIDTH, _t0,
        anim, at, baseLineWidthPixels, cacheRebuilt, chainU, edgeTone,
        fl, inkCurves, inkW, inkWanted, jointMinOrder, lightOn,
        nearOf, offCv, outlineW, paintInkW, painter, pencilWanted,
        perfectInk, persp, prims, project, pxScale, realCtx,
        rich, rotated, scale, sketchMax, sketchSegs, sketching,
        soft, strokePath, wobble, n, vis,
    } = S;
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

window.py2dmolCartoonPaint = paintPrims;
})();