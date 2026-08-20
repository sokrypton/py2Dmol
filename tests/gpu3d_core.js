/* The GPU cartoon MEASUREMENT HARNESS, shared by gpu3d_lab.html (the numbers)
 * and gpu3d_view.html (the picture).
 *
 * The renderer itself now lives in py2Dmol/resources/viewer-cartoon-gpu.js and
 * ships with the viewer. What is left here is everything that only makes sense
 * beside a test page: loading a fixture or a .cif, building the fake renderer
 * the capture runs through, the colour schemes, the pixel diff, and the one
 * producer that turns this page's controls into the parameter object the module
 * takes. The module is the measured path either way - the app and the lab call
 * the same functions with the same object - which is the point of the split.
 *
 * ids read: preset, smooth, frame, exact, white, sc, ink3d, inkw, inkbias,
 *           inkcrease, view, yaw, pencil, colour, elements, outlineTint
 */
'use strict';

const GPU = window.py2dmolCartoonGPU;
const { facesOf, makeResident, drawResident, initGL, nullCtx, focalLength,
    currentRot, currentZoom, setViewYawPitch, rotYawPitch, rotateView,
    setZoom, zoomBy, setPalette, setVisible, setResidueVisible,
    setAllResiduesVisible, noteDragVelocity, stopInertia, inertiaStep,
    startInertia, recolour, unproject, orthoAmount, isPersp } = GPU;
const { apply, matMul, dotv, rotationMatrixX, rotationMatrixY,
    toneOf, paintCPU, paintGPU, PAPER } = GPU.__internals;

/* ------------------------------------------------------------------ diff */

function diffPanels(a, b, out) {
    const ga = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
    const gb = b.getContext('webgl2') ? readGL(b) : b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    const gd = out.getContext('2d');
    const img = gd.createImageData(out.width, out.height);
    let n = 0;
    for (let i = 0; i < ga.length; i += 4) {
        const d = Math.abs(ga[i] - gb[i]) + Math.abs(ga[i + 1] - gb[i + 1]) + Math.abs(ga[i + 2] - gb[i + 2]);
        const hit = d > 24;
        if (hit) n++;
        img.data[i] = hit ? 220 : 255;
        img.data[i + 1] = hit ? 30 : 255;
        img.data[i + 2] = hit ? 30 : 255;
        img.data[i + 3] = 255;
    }
    gd.putImageData(img, 0, 0);
    return n;
}
// IS THE RASTER DIFFERENCE JUST EDGES? Canvas 2D and WebGL antialias
// differently, so every face boundary disagrees by a pixel or so. That is
// benign - it is not a style change - but a difference INSIDE a face would be.
// Split the count by whether the pixel sits on a colour boundary of the
// reference image.
function edgeSplit(ref, a, b, w, h) {
    let onEdge = 0, inside = 0;
    const at = (x, y) => ((y * w + x) << 2);
    const dif = (i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
        + Math.abs(a[i + 2] - b[i + 2]);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = at(x, y);
            if (dif(i) <= 24) continue;
            let edge = false;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const j = at(x + dx, y + dy);
                if (Math.abs(ref[i] - ref[j]) + Math.abs(ref[i + 1] - ref[j + 1])
                    + Math.abs(ref[i + 2] - ref[j + 2]) > 12) { edge = true; break; }
            }
            if (edge) onEdge++; else inside++;
        }
    }
    return { onEdge, inside };
}

function diffArrays(a, b) {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
            + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
    }
    return n;
}
function readGL(cv) {
    const px = new Uint8Array(cv.width * cv.height * 4);
    const g2 = cv.getContext('webgl2');
    g2.readPixels(0, 0, cv.width, cv.height, g2.RGBA, g2.UNSIGNED_BYTE, px);
    // GL origin is bottom-left; flip to match the 2D canvas
    const out = new Uint8Array(px.length);
    const w = cv.width * 4;
    for (let y = 0; y < cv.height; y++) {
        out.set(px.subarray((cv.height - 1 - y) * w, (cv.height - y) * w), y * w);
    }
    return out;
}

/* --------------------------------------------------- the renderer's own paint */

// EVERY FILL IS FLAT. Counted on a real context: 1359 fills a frame, all of
// them a plain rgb() string - the 284 two-stop gradients go to strokes. So the
// exact colour of every face is available for the asking, and the GPU pass does
// not have to reimplement shade() to be compared fairly against the reference.
// This records each filled polygon with the style it was filled with.
function recordingCtx(cv) {
    const raw = cv.getContext('2d');
    const polys = [];
    let path = null;
    let fillStyle = '#000';
    const handler = {
        get: (t, k) => {
            if (k === 'beginPath') return () => { path = []; return raw.beginPath(); };
            if (k === 'moveTo' || k === 'lineTo') {
                return (x, y) => { if (path) path.push([x, y]); return raw[k](x, y); };
            }
            if (k === 'fill') {
                return (...a) => {
                    if (path && path.length >= 3 && typeof fillStyle === 'string') {
                        polys.push({ p: path.slice(), s: fillStyle });
                    }
                    return raw.fill(...a);
                };
            }
            if (k === '__polys') return polys;
            const v = raw[k];
            return typeof v === 'function' ? v.bind(raw) : v;
        },
        set: (t, k, v) => { if (k === 'fillStyle') fillStyle = v; raw[k] = v; return true; },
    };
    return new Proxy({}, handler);
}

const parseRGB = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (m) { const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2] }; }
    if (s[0] === '#') {
        const h = s.length === 4
            ? s.slice(1).split('').map((c) => parseInt(c + c, 16))
            : [1, 3, 5].map((i) => parseInt(s.substr(i, 2), 16));
        return { r: h[0], g: h[1], b: h[2] };
    }
    return null;
};

// DOES NOT WORK, and is kept switched off as the record of why. Pairing a
// recorded polygon to its face by first vertex matches only ~68% of them,
// because `pathStrip` merges adjacent same-colour quads into ONE path - so a
// recorded polygon is often several faces, and there is no per-face colour in
// the paint stream to capture. Reading the tone out of the renderer therefore
// means porting shade() into the shader, not intercepting the canvas.
//
// Left in because the match RATE is the measurement: it says how much of the
// frame is merged, which is exactly the work a shader port has to reproduce.
function colourFaces(faces, polys, apply) {
    const key = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`;
    const byStart = new Map();
    for (const q of polys) {
        const k = key(q.p[0][0], q.p[0][1]);
        if (!byStart.has(k)) byStart.set(k, []);
        byStart.get(k).push(q);
    }
    let matched = 0;
    for (const f of faces) {
        const cands = byStart.get(key(f.q[0][0], f.q[0][1]));
        if (!cands || !cands.length) continue;
        const c = parseRGB(cands.shift().s);
        if (c) { if (apply) f.real = c; matched++; }
    }
    return matched;
}

/* ------------------------------------------------------------------ driver */

// The cartoon plugin is driven DIRECTLY, the way tests/paint_order_audit.js and
// the perf harnesses do, rather than through initializePy2DmolViewer: the app
// bootstrap wants a page full of controls, and none of them matter here. What
// it needs is a renderer-shaped object and a 2D context to talk to.
const W = 600, H = 600;
const V3 = (x, y, z) => { const a = [x, y, z]; a.x = x; a.y = y; a.z = z; return a; };

// The palette the app shows by default: rainbow along the chain. Flat blue and
// orange were fine while the question was ordering; they are not fine when the
// question is whether the colours match.
function rainbow(t) {
    const h = (1 - Math.min(1, Math.max(0, t))) * 0.66;   // blue -> red
    const f = (n) => {
        const k = (n + h * 6) % 6;
        return Math.round(255 * (1 - Math.max(0, Math.min(1, Math.min(k, 4 - k)))* 0.85));
    };
    return { r: f(5), g: f(3), b: f(1) };
}
function segColors(sc2) {
    // WHITE FIRST. With one flat colour everywhere the only thing left that can
    // disagree is the lighting, which is the thing being ported - a palette
    // difference and a shading difference look identical in a pixel diff.
    if (document.getElementById('white').checked) {
        return sc2.segs.map(() => ({ r: 255, g: 255, b: 255 }));
    }
    const n = Math.max(1, sc2.nBase - 1);
    const owner = (i) => (i < sc2.nBase ? i
        : (sc2.sidechainMap.get(i) ? sc2.sidechainMap.get(i).owner : 0));
    // ELEMENT COLOURING NEEDS NOTHING FROM THE GPU PATH. In the app it is
    // resolved BEFORE the cartoon renderer runs: _materialiseSidechains cuts a
    // bond at its midpoint and gives each half its own atom's colour, so what
    // the renderer receives is an ordinary per-segment colour and what the
    // capture sees is an ordinary prim colour. Anything the 2D renderer can
    // paint, the mesh inherits.
    //
    // Demonstrated here rather than assumed. The four values are copied from
    // viewer-mol.js's ELEMENT_COLORS, which is a static getter on a class that
    // is not exported - so this IS a duplicate, and the original is the one to
    // change. Carbon is deliberately absent there too: it keeps the chain
    // colour, which is what makes the coloured atoms read as exceptions.
    const EL = {
        N: { r: 51, g: 51, b: 255 },
        O: { r: 255, g: 76, b: 76 },
        S: { r: 229, g: 198, b: 64 },
        SE: { r: 240, g: 161, b: 54 },
    };
    // ELEMENT COLOUR TAKES HALF A BOND, and the renderer is what cuts it. A
    // colours array may carry a `halves` side-table - halves[s] = {a, b} - and
    // where it does, the renderer splits that bond at its midpoint and gives
    // the near half `a` and the far half `b` (see the emitSeg loop). So the
    // right thing to supply is the PAIR, not a single colour for the whole
    // segment: an earlier attempt here painted the entire bond with its
    // non-carbon end's colour, which is a bond-length smear where the app
    // draws half of one.
    //
    // Carbon keeps the chain colour, which is what makes the coloured atoms
    // read as exceptions rather than as a second palette.
    const byElement = document.getElementById('elements')
        && document.getElementById('elements').checked;
    // COLOUR MODES, so a colour change is something this page can actually
    // exercise. They are stand-ins for the app's schemes, not ports of them -
    // what matters for the GPU path is only that the palette CHANGES, since it
    // never sees anything but the resulting per-segment colour.
    const mode = (document.getElementById('colour') || {}).value || 'rainbow';
    const CH = ['#4C72B0', '#DD8452', '#55A868', '#C44E52', '#8172B3',
        '#937860', '#DA8BC3', '#8C8C8C', '#CCB974', '#64B5CD'];
    const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16),
        g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
    const chainIds = sc2.chains || null;
    const chainOf = (i) => {
        if (!chainIds) return 0;
        const c = chainIds[Math.min(i, chainIds.length - 1)];
        return typeof c === 'string' ? (c.charCodeAt(0) - 65) : (c | 0);
    };
    const base = (sg) => {
        const i = owner(sg.idx1);
        switch (mode) {
        case 'chain': return hex(CH[Math.abs(chainOf(i)) % CH.length]);
        case 'mono': return { r: 120, g: 150, b: 210 };
        case 'stripe': return (Math.floor(i / 4) % 2)
            ? { r: 210, g: 90, b: 70 } : { r: 240, g: 225, b: 190 };
        case 'depth': { const t = i / Math.max(1, n);
            return { r: Math.round(40 + 200 * t), g: Math.round(60 + 120 * t),
                b: Math.round(200 - 120 * t) }; }
        default: return rainbow(i / n);
        }
    };
    const cols = sc2.segs.map(base);
    if (byElement) {
        const elOf = (i) => {
            const a = sc2.sidechainMap.get(i);
            return a ? (a.el || 'C').toUpperCase() : 'C';
        };
        cols.halves = sc2.segs.map((sg, i) => {
            const ea = elOf(sg.idx1);
            const eb = elOf(sg.idx2);
            const ca = EL[ea];
            const cb = EL[eb];
            if (!ca && !cb) return null;      // both carbon: nothing to split
            // both halves must be present or the renderer will not cut
            return { a: ca || cols[i], b: cb || cols[i] };
        });
    }
    return cols;
}


let scene = null;         // { coords, types, segs, names, colors }
let pitchDeg = 20;        // dragging the GPU canvas moves this and the yaw

function buildScene(fd) {
    const n0 = fd.coords.length;
    const coords = fd.coords.map((c) => V3(c[0], c[1], c[2]));
    const types = (fd.position_types || []).slice();
    const names = (fd.residue_names || fd.position_names || []).slice();
    const segs = [];
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    for (let i = 0; i + 1 < n0; i++) {
        if (fd.chains[i] !== fd.chains[i + 1]) continue;
        const t = types[i];
        if (t !== types[i + 1]) continue;
        const cut = t === 'P' ? 25 : (t === 'D' || t === 'R') ? 56 : 0;
        if (!cut || d2(fd.coords[i], fd.coords[i + 1]) >= cut) continue;
        segs.push({ type: t, idx1: i, idx2: i + 1, origIndex: i });
    }
    // SIDE CHAINS, materialised here. The table stores each atom as
    // coefficients in the local frame of an anchor residue, which is exactly
    // what viewer-mol does on a frame load; localFrame is exported, so the
    // twenty lines are cheaper than borrowing the method off the class.
    const sc = fd.sidechains;
    const sidechainMap = new Map();
    // ON EVERY RESIDUE, which is deliberate - it is what makes the ordering
    // error common enough to measure - and also what makes a 3445-residue
    // structure into 81k faces and a 6-second redraw. Switchable for that
    // reason: without them 9FOG is an ordinary scene again.
    // ALWAYS MATERIALISED, because showing and hiding them is now a uniform and
    // the mesh has to contain what the uniform might reveal. The checkbox that
    // used to gate this is a visibility control; `window.__scGeometry = false`
    // is the way to leave them out of the geometry altogether, which is worth
    // it only on something like 9FOG where they are most of the 62k faces.
    if (sc && sc.pos && sc.pos.length && window.__scGeometry !== false) {
        const localFrame = window.py2dmolCartoon.localFrame;
        const at = (i) => ({ x: fd.coords[i][0], y: fd.coords[i][1], z: fd.coords[i][2] });
        const fr = new Array(9).fill(0);
        const frames = new Map();
        const frameAt = (i) => {
            if (!frames.has(i)) frames.set(i, localFrame(at, n0, i, fr, null) ? fr.slice() : null);
            return frames.get(i);
        };
        const rowIdx = new Map();
        for (let k = 0; k < sc.pos.length; k++) {
            const f = frameAt(sc.frameOf[k]);
            if (!f) continue;
            const o = at(sc.frameOf[k]);
            const cx = sc.coef[k * 3], cy = sc.coef[k * 3 + 1], cz = sc.coef[k * 3 + 2];
            const idx = coords.length;
            coords.push(V3(o.x + f[0] * cx + f[3] * cy + f[6] * cz,
                o.y + f[1] * cx + f[4] * cy + f[7] * cz,
                o.z + f[2] * cx + f[5] * cy + f[8] * cz));
            types.push('L');
            names.push(sc.names[k] || 'X');
            sidechainMap.set(idx, { owner: sc.pos[k], el: sc.elements[k] || 'C' });
            rowIdx.set(k, idx);
        }
        for (let e = 0; e + 1 < sc.bonds.length; e += 2) {
            const a = rowIdx.get(sc.bonds[e]), b = rowIdx.get(sc.bonds[e + 1]);
            if (a !== undefined && b !== undefined) segs.push({ type: 'L', idx1: a, idx2: b, origIndex: a });
        }
        for (const row of (sc.toBackbone || [])) {
            const a = rowIdx.get(row);
            if (a !== undefined) segs.push({ type: 'L', idx1: sc.pos[row], idx2: a, origIndex: a });
        }
    }
    return { coords, types, names, segs, sidechainMap, nBase: n0, chains: fd.chains };
}

// The shader was reading preset defaults while the reference renderer was
// running on its OWN fields - shade 1 against 0.7, highlight 1 against 3 - so
// the two were shading differently before any geometry was involved. One
// function now supplies both.
function styleParams() {
    const el = (id) => document.getElementById(id);
    const preset = document.getElementById('preset').value;
    const rich = preset === 'richardson';
    // Straight off STYLE_DEFAULTS, so the renderer and the shader cannot be
    // configured differently - which is what the first 97.6% turned out to be.
    const P = (window.py2dmolCartoon.STYLE_DEFAULTS || {})[preset] || {};
    // ONE SWITCH FOR BOTH SIDES. The renderer's `cel` is (cartoonSmooth !==
    // true), so smooth and quantisation are the same decision - setting them
    // independently on the two sides is how the shader ended up smooth while
    // the reference was banded, and every pixel disagreed by a little.
    const smoothEl = document.getElementById('smooth');
    // STYLE OVERRIDES, for the coverage harness (gpu3d_styles.html). It drives
    // this page in an iframe rather than re-implementing the port: the GPU core
    // here reads the DOM throughout, so a second copy of it would fork the one
    // implementation that has been measured. Anything the override names wins
    // over the preset; anything it omits behaves exactly as before.
    const OV = window.__styleOverride || {};
    const smooth = OV.smooth !== undefined ? !!OV.smooth
        : (smoothEl ? smoothEl.checked : (P.smooth === true));
    const pick = (k, d) => (OV[k] !== undefined ? OV[k]
        : (P[k] !== undefined ? P[k] : d));
    return {
        rich,
        preset,
        width: pick('width', 3.0),
        thickness: pick('thickness', 0),
        sheetFlat: pick('sheetFlat', 0),
        shadeAmt: pick('shade', 1.0),
        hiGain: pick('highlight', 1.0),
        innerShade: OV.innerShade !== undefined ? OV.innerShade : 0.22,
        knee: rich ? 0.25 : 0.55,
        depthFloor: OV.fade !== undefined ? 1 - OV.fade : 1.0,
        detail: pick('detail', 4),
        ortho: OV.ortho !== undefined ? OV.ortho : 1,
        outlineWidth: pick('outlineWidth', 3),
        outlineTint: (document.getElementById('outlineTint')
            ? +document.getElementById('outlineTint').value : pick('outlineTint', 0)),
        // THE CONTROL WINS OVER THE PRESET, the way outlineTint does. Read
        // only from the preset, a page that pins the grain off - the lab does,
        // with a hidden input, so its numbers are not partly a measurement of
        // noise alignment - was silently overruled by richardson's own
        // pencil 1.0, and every reading came out 56% against a grainless
        // reference. An override still beats both, for the styles harness.
        pencil: OV.pencil !== undefined ? OV.pencil
            : (el('pencil') ? +el('pencil').value : pick('pencil', 0)),
        arrows: OV.arrows !== undefined ? OV.arrows : true,
        // ---- THE RENDER KNOBS ----------------------------------------------
        // Everything below used to be read straight out of the DOM at the point
        // of use, which was right while this was one page: the extraction out
        // of the lab could then be verbatim. It is wrong for a SHIPPING module,
        // which has no page to read - so they join the same object the style
        // travels in, and the producer is the only thing that knows about a
        // document. Anything without a control takes the value the lab settled
        // on, so a page that omits the input still gets the measured default.
        frame: el('frame') ? el('frame').value : 'welded',
        exact: el('exact') ? el('exact').checked : false,
        ink: el('ink3d') ? el('ink3d').checked : false,
        creaseDeg: el('inkcrease') ? +el('inkcrease').value : 180,
        inkWidth: el('inkw') ? +el('inkw').value : 1.6,
        inkBias: el('inkbias') ? +el('inkbias').value : 0.002,
        biasMax: window.__biasMax === undefined ? 0.004 : window.__biasMax,
        flatCull: window.__flatCull === true,
        colorMode: OV.colorMode || 'chain',
        smooth,
        // cel IS "not smooth", on both sides
        cel: smooth ? 0.0 : 1.0,
        presetSmooth: P.smooth === true,
    };
}

function mkRenderer(sc2) {
    const { coords, types, names, segs, sidechainMap } = sc2;
    const n = coords.length;
    let cx = 0, cy = 0, cz = 0;
    for (const c of coords) { cx += c.x; cy += c.y; cz += c.z; }
    cx /= n; cy /= n; cz /= n;
    let ext = 0;
    let sumDistSq = 0;
    for (const c of coords) {
        const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
        ext = Math.max(ext, Math.abs(dx), Math.abs(dy), Math.abs(dz));
        sumDistSq += dx * dx + dy * dy + dz * dz;
    }
    // stdDev exactly as viewer-mol computes it: sqrt(mean squared distance from
    // the centre), i.e. the RMS radius. It sets the focal length, so it has to
    // be this and not the half-extent.
    GPU.setStdDev(n > 0 ? Math.sqrt(sumDistSq / n) : 30);
    // THE SAME MATRIX THE MESH IS BUILT AGAINST. This used to re-derive the
    // rotation from yaw and pitch inline; it agreed with rotYawPitch by
    // construction, and would have silently stopped agreeing the moment the
    // view became a free rotation.
    const VR = currentRot();
    const rot = coords.map((c) => {
        const v = apply(VR, [c.x - cx, c.y - cy, c.z - cz]);
        return V3(v[0], v[1], v[2]);
    });
    const preset = document.getElementById('preset').value;
    const sp = styleParams();
    const rich = sp.rich;
    // SHOW/HIDE FOR THE 2D RENDERER. On the GPU these are uniforms against a
    // mesh that holds everything; the 2D renderer has no such thing, so what it
    // is given has to be filtered instead.
    //
    // Side chains are GENERIC segments, and the generic-segment loop does not
    // consult `visiblePositions` - only backbone intervals do - so the mask
    // cannot hide them and the list has to. The backbone is the opposite case:
    // an empty mask hides it and leaves everything else alone.
    //
    // Never while CAPTURING: the mesh has to contain what a uniform might later
    // reveal, so a capture always takes the whole structure.
    const shown = GPU.getShow();
    const hideSticks = !GPU.isCapturing() && !shown.sticks;
    const hideRibbon = !GPU.isCapturing() && !shown.ribbon;
    const isBackbone = (sg) => sg.type === 'P'
        && sg.idx1 < sc2.nBase && sg.idx2 < sc2.nBase;
    let segsOut = segs;
    if (hideSticks) segsOut = segsOut.filter(isBackbone);
    if (hideRibbon) segsOut = segsOut.filter((sg) => !isBackbone(sg));
    return {
        // NOT an empty `visiblePositions` to hide the backbone. That mask also
        // drives the projection pass, which marks every position it excludes as
        // invalid - so the side chains had nothing to project against and the
        // whole drawing went blank. Filtering the segment list touches only
        // what is drawn.
        visiblePositions: null,
        coords: rot, rotatedCoords: rot, segmentIndices: segsOut, positionTypes: types,
        positionNames: names,
        viewerState: { extent: ext / 1.6, zoom: currentZoom(), ortho: sp.ortho,
            focalLength: focalLength() },
        objectsData: { obj: { maxExtent: ext } }, currentObjectName: 'obj', currentFrame: 0,
        lineWidth: sp.width,
        outlineMode: sp.outlineWidth > 0 ? 'full' : 'none',
        relativeOutlineWidth: sp.outlineWidth,
        cartoonOutlineTint: sp.outlineTint,
        cartoonPencil: sp.pencil,
        cartoonArrows: sp.arrows,
        shadowEnabled: true, cartoonShade: sp.shadeAmt,
        cartoonHighlight: sp.hiGain, colorMode: sp.colorMode,
        cartoonDetail: sp.detail, cartoonRichardson: rich,
        cartoonThickness: sp.thickness,
        cartoonSheetFlat: sp.sheetFlat,
        cartoonSmooth: sp.smooth,      // the same switch the shader reads
        _thicknessUserSet: true,
        sidechainMap, overlayState: { enabled: false }, screenFrameId: 0,
        screenX: new Float64Array(n), screenY: new Float64Array(n),
        screenRadius: new Float64Array(n), screenValid: new Uint8Array(n),
        displayWidth: W, displayHeight: H,
        _calculateSegmentWidthMultiplier: () => 1, _primProbe: null,
    };
}

// A BLANK PAGE IS A BAD ERROR MESSAGE. Opened from the filesystem this cannot
// work - the scripts load, but fetch() of a .cif is blocked cross-origin, so
// everything simply stops. Say so, with the command to fix it.
function fixtureScene(name) {
    const f = FIXTURES[name];
    const coords = f.pts.map((p2) => V3(p2[0], p2[1], p2[2]));
    return {
        coords,
        types: coords.map(() => 'L'),
        names: coords.map(() => 'LIG'),
        segs: f.bonds.map(([a, b]) => ({ type: 'L', idx1: a, idx2: b, origIndex: a })),
        sidechainMap: new Map(),
        nBase: coords.length,
        chains: coords.map(() => 'A'),
    };
}

// Build the resident mesh for the current scene at a given view, and return the
// faces. THE BUILD HALF ONLY - the lab wraps this with a reference render and a
// pixel diff, the viewer just draws what comes out, and neither needs the
// other's half.
// A page that sets the yaw box directly (measurement scripts do) needs the
// matrix stepped with it. Kept here so both pages get it.
function syncViewFromYawBox() {
    const el = document.getElementById('yaw');
    if (el) setViewYawPitch(+el.value, pitchDeg);
}

function buildResident() {
    // LAZY AND IDEMPOTENT. Whether GL was initialised before the first build
    // depended on page boot order, and when it was not the failure surfaced far
    // away as "cannot read bindBuffer of null". Asking here costs a null check
    // and cannot be got wrong by a caller.
    if (!GPU.hasGL()) {
        const cv2 = document.getElementById('gpu');
        if (cv2 && !initGL(cv2)) throw new Error('WebGL2 unavailable');
    }
    // TELL THE MODULE ABOUT THIS PAGE, once per build. It has no document to
    // read: the residue map decides which residue a side-chain face belongs to,
    // the size is the canvas the capture was projected onto, the palette source
    // is what recolour() calls, and the parameter producer is this page's
    // controls. The app registers its own four and calls the same functions.
    GPU.setResidueMap(scene);
    GPU.setSize(W, H);
    GPU.setPaletteSource(() => segColors(scene));
    GPU.setDefaultParams(styleParams);
    const { prims, scale } = capture();
    const prm = styleParams();
    const { faces, lines } = facesOf(prims, prm);
    makeResident(faces, scale, prm, lines);
    return faces;
}

// `refresh` is the PAGE's, not the core's: the lab repaints four panels and a
// diff, the viewer repaints one canvas. Calling it only when it exists is what
// lets a page own its own redraw without the core knowing anything about it.
function afterLoad() {
    if (typeof refresh === 'function') refresh();
}

// The parsed frame data of whatever is loaded, kept so the scene can be rebuilt
// without going back to the network. `buildScene` is where the side-chain
// checkbox is READ, so toggling it has to re-run that - which is why the
// control appeared dead: it was only ever consulted on a structure load.
let lastFrameData = null;

function rebuildScene() {
    if (!lastFrameData) return false;
    scene = buildScene(lastFrameData);
    GPU.clearResident();
    return true;
}

async function load(url) {
    if (url.startsWith('fixture:')) {
        scene = fixtureScene(url.slice(8));
        lastFrameData = null;     // fixtures are built directly, not parsed
        GPU.clearResident();
        afterLoad();
        return;
    }
    document.getElementById('stats').textContent = 'loading ' + url + ' …';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const text = await res.text();
    const parsed = window.parseCIF(text);
    const models = Array.isArray(parsed) ? parsed : (parsed.models || parsed.frames);
    const first = Array.isArray(models[0]) ? models[0] : models;
    lastFrameData = window.convertParsedToFrameData(first);
    scene = buildScene(lastFrameData);
    GPU.clearResident();              // it belongs to the structure that just went
    afterLoad();
}

// One render of the real thing, into a REAL context, recording both the
// primitive list (geometry + depth) and every filled polygon (the colour the
// renderer chose). The grain is off because the pencil path renders offscreen
// and blits, which hides the paint stream entirely.
// WHAT THIS COSTS, measured on 9FOG with side chains everywhere (81 804 faces):
// geometry alone 5.7 s, painting the reference another 0.7 s, and the recording
// proxy another 1.1 s on top. The renderer runs on EVERY redraw because the
// primitives it returns are in screen space - turning the view rebuilds them.
// That is the honest cost of step one being downstream of the 2D renderer, and
// it is the thing a real port removes by keeping the mesh in world space.
//
// So the two avoidable parts are skipped when nothing will read them.
function capture() {
    GPU.setCapturing(true);
    try { return captureInner(); } finally { GPU.setCapturing(false); }
}

function captureInner() {
    const r = mkRenderer(scene);
    r._noViewCull = true;
    r._frameProbe = true;      // model-space ub / wa / tangent per station
    // ...and stop once the prims exist. Only the four-panel comparison needs a
    // painted reference out of this call; the resident path never looks at it.
    r._probeOnly = document.getElementById('view').value === 'resident';
    const colors = segColors(scene);
    r._primProbe = null;
    r.cartoonPencil = 0;
    if (document.getElementById('view').value === 'resident') {
        window.py2dmolCartoon.render(r, nullCtx(W, H), W, H, colors);
        return { prims: r._primProbe || [], polys: [], scale: r._viewScale };
    }
    const ref = document.getElementById('ref');
    ref.getContext('2d').clearRect(0, 0, W, H);
    const rec = recordingCtx(ref);
    window.py2dmolCartoon.render(r, rec, W, H, colors);
    return { prims: r._primProbe || [], polys: rec.__polys, scale: r._viewScale };
}

// EVERY REDRAW GOES THROUGH HERE. Before this existed, changing the structure
// while in resident mode redrew through the non-resident path - so the new
// structure appeared - and then the first drag called drawResident(), which
// still held the PREVIOUS structure's buffer and visibly jumped back to it.
// A stale cache that only shows itself on the next interaction.
