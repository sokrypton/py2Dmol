// ============================================================================
// src/parts/orient.js
// ---------------------------------
// AI Context: TURNING A STRUCTURE TO FACE THE READER (orientToBestView)
// - The best-view search and the animation that flies the camera there.
// ============================================================================
(function () {
'use strict';

// SIX HUNDRED LINES THAT LIVED IN THE WEB APP FOR NO REASON BUT HISTORY.
//
// Orienting is geometry: it belongs wherever a structure is drawn, which is the
// notebook and an embedded viewer as much as the website. It sat in
// src/app/main.js because of two lines - it read the renderer off the app's
// `viewerApi` and the object name off the app's #objectSelect dropdown - and
// neither of those is anything but a parameter.
//
// It needs the maths in src/io/math.js: bestViewTargetRotation_relaxed_AUTO for
// the search, and rotationAngleBetweenMatrices and lerpRotationMatrix for the
// flight. That file is 6 KB minified and has no other dependencies, which is
// what makes carrying this into an embed cheap.

// ONE FLIGHT PER VIEWER, NOT ONE PER PAGE.
//
// This was a module-level object, so every viewer on the page shared a single
// animation state - and the last one to press Orient took it. The symptom is
// quiet and looks like the feature is broken rather than the state: the
// earlier viewer stops mid-flight at whatever angle it had reached, with
// isOrientAnimating stuck true, so it never finishes and never clears its
// shadow cache. Found on embed.html, where two sections orient as the page
// loads and the first one simply did not zoom.
//
// Held on the renderer, which is the thing a flight belongs to.
// ============================================================================
// THE CAMERA PATH
// ============================================================================
// A flight moves three things: where the camera looks (`centre`), how much it
// takes in (`extent`), and the shape of that (`aspect`). Interpolating each of
// them linearly is the obvious thing and it is why Orient overshot.
//
// 🔴 MAGNIFICATION IS 1 / EXTENT, SO A LINEAR RAMP IN EXTENT IS NOT A LINEAR
// RAMP IN ZOOM. Going 38 A -> 8 A linearly, half the flight is spent between
// 38 and 23 - a magnification change of 1.6x - and the remaining 2.9x arrives
// in the second half. The picture creeps, then rushes. Zoom is MULTIPLICATIVE,
// so the even path is the geometric one:
//
//     e(t) = e0 * (e1 / e0)^t
//
// 🔴 AND A PAN MUST BE EVEN ON THE SCREEN, NOT IN THE MOLECULE. Moving the
// centre linearly while the extent shrinks fivefold means the last frames
// cover five times the screen distance of the first. Together with the zoom
// that reads as the camera swooping out and back - which is what was reported.
//
// Screen speed is (dc/dt) / e, so for it to be constant dc/dt must be
// proportional to e(t). Integrating e0 * k^t gives the pan weight:
//
//     w(t) = (k^t - 1) / (k - 1),   k = e1 / e0
//
// which is the fraction of the pan completed at t. At k = 1 that is 0/0 and
// the answer is t - with no zoom, an even pan already IS even on screen - and
// near 1 the expression is numerically poor, hence the explicit branch.
//
// This is the core of Van Wijk & Nuij's smooth zoom-and-pan, minus the part
// that also chooses the DURATION; the duration here is still the rotation's,
// which is what keeps a flight feeling like one movement rather than two.
// 🔴 AND `zoom` IS PART OF THE MAGNIFICATION, NOT A SEPARATE MOVEMENT.
// _viewportScale returns `baseScale(extent, aspect) * zoom`, and orient ramped
// the zoom LINEARLY to 1.0 while this ramped the extent geometrically. A
// geometric ramp times a linear one is not monotonic: with the reader zoomed
// in at 2.5 and the extent closing on a selection, the product rises, dips and
// rises again - sudden zoom in and out, mid-flight, with each half of the
// camera doing exactly what it was told. Caught by counting writes to
// viewerState during one flight: extent 58, center 58, zoom 57.
//
// Both are multiplicative - a zoom of 2 means twice as big, exactly as half
// the extent does - so both take the geometric path and their quotient, which
// is what the eye sees, is geometric too.
// ...written through core/mol.js's setViewSpan, so the extent and the aspect
// cannot be put down separately or in two conventions. Orient measures a
// radius and a shape; what is STORED is the half-span pair, normalised one way
// for everybody.
// 🔴 `frame` IS A TRAJECTORY FRAME IN THIS PROJECT, NEVER THE VIEWPORT.
// The camera's is a VIEW SPAN. This helper was called `frame` for one
// commit and `const frame = object.frames[currentFrame]`, eighty lines
// below, shadowed it inside the very function that needed it - so the
// call read `frame is not a function`, which is a shadowed binding and
// looks nothing like a missing one. The two meanings had already been
// mixed in `viewSpanOf`, `viewScaleMul` and `setViewTransform` before
// they were renamed.
function setViewSpanFrom(renderer, extent, aspect) {
    setViewSpan(renderer.viewerState, halfSpanOf(extent, aspect));
}

// 🔴 AND WHAT MUST BE EVEN IS THE MAGNIFICATION ITSELF, NOT ITS INGREDIENTS.
//
// The scale is `padding * min(w / ax, h / ay) / (2 * extent) * zoom`. Making
// the extent geometric and the aspect linear makes each INPUT well behaved and
// still leaves the output free to misbehave, because of the `min`: if one axis
// grows while the other shrinks, the term that binds SWAPS part way, and the
// minimum of a rising and a falling function rises and then falls. The picture
// zooms in and back out with every input moving monotonically.
//
// So the magnification is interpolated directly - geometric between the two
// endpoint scales - and the extent is SOLVED to produce it:
//
//     M(t) = M0 * (M1 / M0)^t          and      e(t) = S(a(t)) * zoom(t) / M(t)
//
// where S(a) = min(w / ax, h / ay). At t = 0 that returns e0 exactly and at
// t = 1, e1, so the flight still lands where it was told. **And when the two
// endpoints have the SAME magnification it is constant for the whole flight**
// - a reframing that does not change the zoom no longer animates one, which
// is the case that was reported.
//
// Needs the viewport, which is the one thing here that is not camera state;
// without it this falls back to the geometric extent, which is what it did
// before and is right whenever the aspect is not moving.
function cameraAt(fromHalf, toHalf, fromCentre, toCentre, t, view) {
    const pos = (v, fallback) => ((v > 0) ? v : fallback);
    const h0 = { x: pos(fromHalf.x, 1), y: pos(fromHalf.y, 1) };
    const h1 = { x: pos(toHalf.x, h0.x), y: pos(toHalf.y, h0.y) };
    // THE SHAPE LINEARLY, THE SIZE SOLVED. Interpolating both half-spans
    // geometrically would be the obvious thing and it is not enough: the scale
    // is a `min` of the two terms, so when one axis grows while the other
    // shrinks the binding term swaps part way and the minimum rises and then
    // falls. Interpolating the MAGNIFICATION and solving the size for it is
    // monotonic by construction - and constant when the two ends ask for the
    // same one, which is a reframing that does not zoom.
    const fit = (h) => Math.min((view && view.w > 0 ? view.w : 1) / (2 * h.x),
                                (view && view.h > 0 ? view.h : 1) / (2 * h.y));
    let half;
    if (view && view.w > 0 && view.h > 0) {
        const m0 = fit(h0);
        const m1 = fit(h1);
        // ...the shape at t, then scaled so its fit is the geometric one
        const shape = { x: h0.x + (h1.x - h0.x) * t, y: h0.y + (h1.y - h0.y) * t };
        const want = m0 * Math.pow(m1 / m0, t);
        const k = fit(shape) / want;
        half = { x: shape.x * k, y: shape.y * k };
    } else {
        half = { x: h0.x * Math.pow(h1.x / h0.x, t),
                 y: h0.y * Math.pow(h1.y / h0.y, t) };
    }
    // ...and the pan rides on the size, because screen speed is (dc/dt) / half.
    const s0 = Math.max(h0.x, h0.y);
    const s1 = Math.max(h1.x, h1.y);
    const k2 = s1 / s0;
    // ...1e-6 is where (k^t - 1) / (k - 1) stops being worth computing, not a
    // tolerance on anything physical.
    const w = (Math.abs(k2 - 1) < 1e-6) ? t : (Math.pow(k2, t) - 1) / (k2 - 1);
    const lerp = (a, b, u) => a + (b - a) * u;
    return {
        half,
        centre: (fromCentre && toCentre) ? {
            x: lerp(fromCentre.x, toCentre.x, w),
            y: lerp(fromCentre.y, toCentre.y, w),
            z: lerp(fromCentre.z, toCentre.z, w),
        } : null,
    };
}
if (typeof window !== 'undefined') window.py2dmolCameraAt = cameraAt;

function animOf(renderer) {
    if (!renderer._orientAnim) {
        renderer._orientAnim = {
            active: false,
            startMatrix: null,
            targetMatrix: null,
            startTime: 0,
            duration: 1000
        };
    }
    return renderer._orientAnim;
}

function orientToBestView(renderer, options) {
    if (!renderer) return;
    const rotationAnimation = animOf(renderer);
    const opts = options || {};
    const animate = opts.animate !== false;
    // ...WHICH OBJECT, ASKED OF THE RENDERER. This used to read the app's
    // #objectSelect dropdown, which is the one thing a notebook and an embed do
    // not have - and the only reason 611 lines of geometry lived in the web
    // app's main file.
    const objectName = opts.name || renderer.currentObjectName;
    if (!objectName) return;

    const object = renderer.objectsData[objectName];
    if (!object || !object.frames || object.frames.length === 0) return;

    const currentFrame = renderer.currentFrame || 0;
    const frame = object.frames[currentFrame];
    if (!frame || !frame.coords || frame.coords.length === 0) return;

    // Ensure frame data is loaded into renderer if not already.
    // Through reloadDrawn: with several objects merged, lastRenderedFrame does
    // not track the merge, so loading "the frame" here would throw every other
    // object off the screen on the way to orienting on them.
    if (renderer.coords.length === 0 || renderer.lastRenderedFrame !== currentFrame) {
        renderer.reloadDrawn(true); // Load without render
    }

    // WHAT TO ORIENT ON:
    //   selection INTERSECTED WITH what is visible, or just what is visible
    //   when nothing is selected. A hidden residue is not something you are
    //   looking at, so it cannot pull the view towards itself either way.
    //
    // ASK THE MASK, NOT THE MODEL. This used to read getVisibility().positions,
    // which is the visibility MODEL - and that field is normalised to hold
    // every position whenever the mode is 'default'. Hide a chain (which sets
    // .chains and leaves the mode alone) or drag a PAE box (which sets
    // .paeBoxes and never touches .positions at all) and the field still said
    // "all of them", so the first branch matched and Orient framed the whole
    // structure. renderer.visiblePositions is the composed mask the renderer
    // actually draws from: null means everything is visible, an empty Set
    // means nothing is.
    //
    // residueSelection is a Set, or null when nothing is selected; some paths
    // hand back an array, so normalise before asking for .size
    // WHAT TO ORIENT ON, WHEN THE CALLER SAYS SO. opts.positions is a set
    // handed in - parts/embed.js resolves a selector into it, so v.orient({type:
    // 'L'}) frames the ligand - and it stands in for the live selection rather
    // than adding to it. Without this an embed could only orient on whatever
    // happened to be selected, which for a scripted close-up is the wrong
    // question: it framed the PREVIOUS selection and looked plausible.
    const rawSel = (opts.positions !== undefined && opts.positions !== null)
        ? opts.positions : renderer.residueSelection;
    const picked = rawSel
        ? (rawSel instanceof Set ? rawSel : new Set(rawSel))
        : null;
    const visible = renderer.visiblePositions;   // null = everything
    let selectedPositionIndices = null;          // null = everything

    if (picked && picked.size > 0) {
        selectedPositionIndices = visible
            ? new Set([...picked].filter((i) => visible.has(i)))
            : new Set(picked);
        // A SELECTION THAT IS ENTIRELY HIDDEN is not a request to orient on
        // nothing - it is stale, left behind by whatever was hidden after it
        // was made. Fall back to what is on screen rather than returning with
        // no coordinates and letting the button do nothing.
        if (selectedPositionIndices.size === 0) {
            selectedPositionIndices = visible ? new Set(visible) : null;
        }
    } else if (visible) {
        selectedPositionIndices = new Set(visible);
    }

    // EVERY ATOM OF WHAT WAS PICKED, not one point per residue. A residue is a
    // single position in this model, so orienting on one framed a point; its
    // side-chain atoms and a ligand's other atoms are positions too, and they
    // are what the thing actually occupies. See framingPositions - the
    // selection itself is not touched.
    if (selectedPositionIndices && renderer.framingPositions) {
        selectedPositionIndices = renderer.framingPositions(selectedPositionIndices);
    }

    // THE LIVE COORDINATES, not the stored frame's. A shown side chain is
    // APPENDED to the renderer's array when the frame loads, so its atoms exist
    // at indices past the end of frame.coords, and the stored frame does not
    // have them at all.
    //
    // WHENEVER THERE ARE ANY, not "when there are at least as many as the
    // picker's object has". With several objects on screen the array holds
    // exactly what is DRAWN, which can be far SHORTER than the object the
    // picker names - switch the picker's object off and leave a small one on,
    // and that test failed, so Orient swung the view onto a structure that was
    // not on screen. The array is what is drawn; the frame is the fallback for
    // when nothing is loaded at all.
    const liveCoords = (renderer.coords && renderer.coords.length)
        ? renderer.coords : (frame ? frame.coords : []);
    if (!liveCoords.length) return;
    const xyzAt = (i) => {
        const c = liveCoords[i];
        if (!c) return null;
        return Array.isArray(c) ? c : [c.x, c.y, c.z];
    };

    // Filter coordinates to only selected positions (or use all if no selection)
    let coordsForBestView = [];
    if (selectedPositionIndices && selectedPositionIndices.size > 0) {
        for (const positionIndex of selectedPositionIndices) {
            const c = positionIndex >= 0 ? xyzAt(positionIndex) : null;
            if (c) coordsForBestView.push(c);
        }
    } else {
        // EVERYTHING THAT IS DRAWN, which with nothing selected is the whole
        // array - one object or several, and never an object that is loaded
        // but switched off. This used to fall back to the picker's own frame,
        // which is a different structure the moment its eye is closed.
        for (let i = 0; i < liveCoords.length; i++) {
            const c = xyzAt(i);
            if (c) coordsForBestView.push(c);
        }
    }

    if (coordsForBestView.length === 0) {
        // No coordinates to orient to, return early
        return;
    }

    // Calculate center and extent from selected positions only
    let visibleCenter = null;
    let visibleExtent = null;
    let frameExtent = 0;

    if (coordsForBestView.length > 0) {
        // Calculate center from selected positions
        const sum = [0, 0, 0];
        for (const c of coordsForBestView) {
            sum[0] += c[0];
            sum[1] += c[1];
            sum[2] += c[2];
        }
        visibleCenter = [
            sum[0] / coordsForBestView.length,
            sum[1] / coordsForBestView.length,
            sum[2] / coordsForBestView.length
        ];

        // >>> ORIENT EXTENT BEGIN  (tests/interaction.js lifts this block)
        // Calculate extent from selected positions
        let maxDistSq = 0;
        for (const c of coordsForBestView) {
            const dx = c[0] - visibleCenter[0];
            const dy = c[1] - visibleCenter[1];
            const dz = c[2] - visibleCenter[2];
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > maxDistSq) maxDistSq = distSq;
        }
        // A SINGLE POSITION HAS NO EXTENT, and one residue is a perfectly
        // ordinary thing to orient on - it is the whole point of picking one.
        // Its extent is exactly 0, which is FALSY, so the target-centre branch
        // below was skipped and orienting on one residue quietly did nothing
        // at all. Two adjacent residues are barely better: 1.9 A of extent
        // would ask the renderer for a magnification nothing is legible at.
        //
        // The floor is a residue's own reach - an arginine's tip sits ~7 A from
        // its CA - so orienting on one residue frames that residue and its side
        // chain, drawn or not, with a little of what surrounds it. Anything
        // larger than that reaches the floor on its own and is unaffected.
        const ORIENT_MIN_EXTENT_A = 8;
        visibleExtent = Math.max(Math.sqrt(maxDistSq), ORIENT_MIN_EXTENT_A);
        frameExtent = visibleExtent;

        // <<< ORIENT EXTENT END
        // 🔴 THE PERSPECTIVE IS NOT ORIENT'S TO MOVE, and it was the last
        // thing in here fighting the zoom.
        //
        // `focalLength` came from `object.stdDev * 2 * multiplier` whenever
        // ortho < 1 - which is the DEFAULT (0.5) - and a flight interpolated
        // that stdDev to the framed subset's, recomputed the focal length
        // every frame, and dispatched a synthetic `input` on the ortho slider
        // to make it stick. So an Orient moved the magnification TWICE, by two
        // mechanisms: the scale, and the strength of the perspective.
        // Measured on dev.html flying to a 40-residue selection, scale went
        // 6.81 -> 12.71 while focalLength went 521.5 -> 283.4. Neither
        // overshoots on its own - and the second is DEPTH-DEPENDENT, so near
        // parts of the structure inflate while far parts deflate. Reported as
        // sudden zoom in and out during Orient, and invisible to every
        // measurement of `_viewScale`, which is only the linear term.
        //
        // Perspective strength belongs to the STRUCTURE and to the reader's
        // ortho slider, not to whichever subset is being framed - re-deriving
        // it from a selection makes the slider's meaning drift under the
        // reader. The whole apparatus is gone rather than deferred to the end
        // of the flight: there is nothing left to keep in step with.
    }

    const Rcur = renderer.viewerState.rotation;

    // Get canvas dimensions to determine longest axis
    const canvas = renderer.canvas;
    const canvasWidth = canvas ? (parseInt(canvas.style.width) || canvas.width) : null;
    const canvasHeight = canvas ? (parseInt(canvas.style.height) || canvas.height) : null;

    // Use filtered coordinates (selected positions only) for best view rotation
    const Rtarget = bestViewTargetRotation_relaxed_AUTO(coordsForBestView, Rcur, canvasWidth, canvasHeight);

    // HOW WIDE AND HOW TALL, UNDER THE ROTATION JUST CHOSEN.
    //
    // The renderer fits the structure to a SQUARE of side min(w, h): it sets
    // xProjectedExtent and yProjectedExtent to the same isotropic radius, so a
    // 598x298 viewer drew a rod across 280px of its 598 - laid out correctly,
    // and using 47% of the space. This is the missing half: the extent says
    // HOW BIG and this says HOW IT IS SHAPED, normalised so the longer axis is
    // 1 and today's answer is what an isotropic structure still gets.
    //
    // Measured HERE, once, and stored beside the extent rather than recomputed
    // per frame. Per frame would mean the picture growing and shrinking as the
    // reader drags, and a tumbling trajectory breathing. The cost of settling
    // it once is that the view span belongs to THIS rotation: turn a long
    // structure end-on afterwards and it can overrun the edges, which is what
    // PyMOL's orient does too. Press Orient again to reframe.
    const targetAspect = (() => {
        // 🔴 ABOUT THE CENTRE, NOT THE ORIGIN. The first version took
        // max|x| of the rotated coordinates as written, and a PDB sits
        // wherever its file put it - 1UBQ is centred near (30, 29, 15), so
        // both spans came out dominated by that offset and their ratio meant
        // nothing. It read as ~1:1 for a rod and pushed a globular structure
        // to the edge of the canvas. The synthetic fixture hid it by being
        // centred on its own long axis.
        if (!visibleCenter) return null;
        let hx = 0; let hy = 0;
        for (const c of coordsForBestView) {
            const dx = c[0] - visibleCenter[0];
            const dy = c[1] - visibleCenter[1];
            const dz = c[2] - visibleCenter[2];
            const x = Rtarget[0][0] * dx + Rtarget[0][1] * dy + Rtarget[0][2] * dz;
            const y = Rtarget[1][0] * dx + Rtarget[1][1] * dy + Rtarget[1][2] * dz;
            if (Math.abs(x) > hx) hx = Math.abs(x);
            if (Math.abs(y) > hy) hy = Math.abs(y);
        }
        // NORMALISED TO THE LONGER AXIS, so the longer one keeps exactly the
        // fit it has always had and only the shorter one is given back the
        // room it was not using. That is what makes this safe: the binding
        // axis is untouched, so nothing that fitted before can stop fitting.
        //
        // It is deliberately not `hx / visibleExtent`, which would be the
        // EXACT 2D fit. Two things are left on the table by that choice - the
        // extent is a 3D radius, so a globular structure reserves room for the
        // atom pointing at the camera; and at ortho < 1 the far side of the
        // structure is foreshortened, so the drawn span is smaller than the
        // measured one. Both are worth perhaps 20% more magnification and both
        // need the margin to be worked out in PIXELS against the style's own
        // line width, because fitting the points exactly clips the drawing
        // around them. Measured, not guessed: 1UBQ came out touching the
        // canvas edge on the first attempt at it.
        // 🔴 NORMALISED BY THE EXTENT, WHICH MAKES IT THE EXACT 2D FIT.
        //
        // It used to normalise by max(hx, hy), which gives the longer axis a
        // ratio of exactly 1 - so that axis reserved the whole 3D RADIUS for a
        // span that is only as wide as the projection. That is safe and it is
        // what left a quarter of the canvas unspent: on AF-Q5VSL9 the radius
        // is 77.9 A and the half-spans are 58.0 and 61.2, so both axes
        // reserved 1.27x what they needed and the model filled 0.67 of a 0.90
        // padding. Dividing by the extent instead makes `extent * aspect.x`
        // exactly hx, which is what _viewportScale wants.
        //
        // The comment this replaces was right that the exact fit CLIPS - the
        // ink is wider than the points it is drawn around, and 1UBQ came out
        // touching the edge. That is now paid for where it belongs, in
        // _viewportScale, in the drawing's own half-width rather than by
        // leaving a proportion of the extent unused.
        if (!(visibleExtent > 0) || !(Math.max(hx, hy) > 0)) return null;
        return { x: hx / visibleExtent, y: hy / visibleExtent };
    })();

    const angle = rotationAngleBetweenMatrices(Rcur, Rtarget);
    const deg = angle * 180 / Math.PI;
    // Calculate duration based on rotation angle, with a minimum to ensure completion
    // Use a slightly longer duration to ensure animation completes reliably
    const baseDuration = deg * 12; // Slightly slower (12ms per degree instead of 10)
    const duration = Math.max(400, Math.min(2500, baseDuration)); // Increased min/max for reliability

    // Calculate target center and zoom based on final orientation
    let targetCenter = null;
    let targetExtent = null;
    let targetZoom = renderer.viewerState.zoom;

    // Get canvas dimensions for zoom calculation (already retrieved above, but keep for clarity)
    // canvasWidth and canvasHeight are already available from above

    // `visibleExtent > 0`, not a truthiness test: a zero extent is a real
    // answer (one position), not a missing one, and treating it as missing is
    // what broke orienting on a single residue.
    if (visibleCenter && visibleExtent > 0 && coordsForBestView.length > 0) {
        // Center is the same regardless of rotation (it's a 3D point)
        // Use center and extent calculated from selected positions
        targetCenter = visibleCenter;
        targetExtent = visibleExtent;

        // Calculate zoom adjustment based on final orientation and window dimensions
        // The renderer now accounts for window aspect ratio, so we should set zoom to 1.0
        // to let the renderer calculate the appropriate base scale based on selected positions extent
        targetZoom = 1.0;
    } else {
        // When orienting to all positions, use the current frame's extent instead of object.maxExtent
        // For multi-frame objects, object.maxExtent is across all frames, which can cause
        // a mismatch with the current frame's actual extent, leading to zoom jumps
        // We'll keep zoom the same since the extent should be consistent now
        targetZoom = renderer.viewerState.zoom;

        // Store frame-specific extent for use during animation
        // This ensures the renderer uses the correct extent for the current frame
        if (frameExtent > 0) {
            // Set temporary extent to the current frame's extent
            // This will be used by the renderer instead of object.maxExtent
            targetExtent = frameExtent;
        }
    }

    // STOP THE SPIN - BUT NOT WHEN NOBODY ASKED FOR THE ORIENT.
    //
    // A reader pressing Orient while the structure turns wants it framed and
    // held; carrying on spinning past the angle just chosen makes the button
    // look broken. That is the DELIBERATE orient, and it is what this default
    // is for.
    //
    // The automatic one is the opposite case. Every surface orients itself
    // when the first frame lands - parts/ui.js on the static payload,
    // loadFrames in parts/embed.js - and turning the spin off there defeated
    // `rotate` outright: py2Dmol.view(rotate=True) came up with
    // config.display.rotate true, the constructor set autoRotate from it, the
    // checkbox was ticked from that, and then the opening orient unticked it
    // and dispatched a change. Nothing in the trace looks wrong until this
    // line. Those callers pass keepSpin.
    if (renderer.autoRotate && !opts.keepSpin) {
        renderer.autoRotate = false;
        if (renderer.rotationCheckbox) {
            renderer.rotationCheckbox.checked = false;
            renderer.rotationCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    renderer.spinVelocityX = 0;
    renderer.spinVelocityY = 0;


    // If animate is false, set values directly and render once
    if (!animate) {
        // Set rotation matrix directly
        renderer.viewerState.rotation = Rtarget.map(row => [...row]);

        // Set center and extent directly
        if (targetCenter) {
            renderer.viewerState.center = {
                x: targetCenter[0],
                y: targetCenter[1],
                z: targetCenter[2]
            };
            setViewSpanFrom(renderer, targetExtent, targetAspect);
        } else {
            renderer.viewerState.center = null;
            if (targetExtent !== null && targetExtent !== undefined) {
                setViewSpanFrom(renderer, targetExtent, targetAspect);
            } else {
                setViewSpanFrom(renderer, null, null);
            }
        }

        // Set zoom directly
        renderer.viewerState.zoom = targetZoom;


        // Render once with final state
        // Render once with final state
        renderer.render('main.js: applyBestViewRotation');
        return;
    }

    // Set up animation
    // ...the stepper runs on its own rAF and needs the renderer back
    rotationAnimation.api = { renderer };
    rotationAnimation.startMatrix = Rcur.map(row => [...row]);
    rotationAnimation.targetMatrix = Rtarget.map(row => [...row]);
    rotationAnimation.duration = duration;
    rotationAnimation.startTime = performance.now();
    rotationAnimation.object = object;

    // Set up center and extent interpolation
    if (targetCenter) {
        // Calculate current center if temporaryCenter is not set
        // This prevents jumps when orienting after PAE selection
        let currentCenter = null;
        if (renderer.viewerState.center) {
            currentCenter = {
                x: renderer.viewerState.center.x,
                y: renderer.viewerState.center.y,
                z: renderer.viewerState.center.z
            };
        } else {
            // Calculate center from current frame coordinates (same as renderer does)
            // This ensures smooth animation even when temporaryCenter was null
            const currentCoords = frame.coords;
            if (currentCoords && currentCoords.length > 0) {
                const sum = [0, 0, 0];
                for (const c of currentCoords) {
                    sum[0] += c[0];
                    sum[1] += c[1];
                    sum[2] += c[2];
                }
                currentCenter = {
                    x: sum[0] / currentCoords.length,
                    y: sum[1] / currentCoords.length,
                    z: sum[2] / currentCoords.length
                };
            }
        }

        rotationAnimation.startCenter = currentCenter;
        rotationAnimation.targetCenter = {
            x: targetCenter[0],
            y: targetCenter[1],
            z: targetCenter[2]
        };
    } else {
        rotationAnimation.startCenter = renderer.viewerState.center ? {
            x: renderer.viewerState.center.x,
            y: renderer.viewerState.center.y,
            z: renderer.viewerState.center.z
        } : null;
        rotationAnimation.targetCenter = null;
    }

    // Start animation
    // 🔴 ONE PAIR, CAPTURED ONCE. Both branches recorded the same start
    // extent and the same start aspect - identical code, twice - and the
    // flight then interpolated an extent, a shape and a zoom separately.
    // The view span the renderer actually draws from is one pair of
    // half-spans, and _viewHalfSpan is where it comes from, so the flight
    // starts from what is ON SCREEN rather than from a reconstruction of
    // it.
    //
    // AND THE ZOOM SETTLES AT ONCE. It is the reader's multiplier, not a
    // movement: the span already carries it, so writing the target zoom on
    // the first frame changes how the framing is SPLIT between the two
    // fields and not what is drawn. One fewer thing interpolating, and the
    // geometric-versus-linear fight between them cannot recur.
    rotationAnimation.startHalf = renderer._viewHalfSpan(object);
    renderer.viewerState.zoom = targetZoom;
    rotationAnimation.targetHalf =
        halfSpanOf(targetExtent, targetAspect, targetZoom);

    rotationAnimation.active = true;
    // Set renderer flag to skip shadow/tint updates during orient animation for large systems
    if (renderer) {
        renderer.isOrientAnimating = true;
    }
    // A BIG STRUCTURE JUMPS INSTEAD OF FLYING. A one-second orient is only a
    // fly-to if the frames arrive; at 80 ms each it is twelve of them, which
    // reads as the viewer stalling rather than as a camera move - and it is a
    // second of the most expensive rendering the viewer ever does, for an
    // effect nobody sees. renderer.smoothAnimationOk() is the same test that
    // vetoes inertia: measured frame cost, with a segment count as the floor.
    //
    // Rather than skip the animation, START IT ALREADY FINISHED - wind the
    // clock back by its own duration, so the first frame takes the normal
    // completion path. Every bit of end-of-orient bookkeeping (final rotation,
    // centre, extent, focal length, shadow and tint invalidation) then runs
    // exactly as it always does, in one frame, instead of being duplicated here
    // and drifting out of step with it later.
    if (renderer && renderer.smoothAnimationOk && !renderer.smoothAnimationOk()) {
        rotationAnimation.startTime = performance.now()
            - (rotationAnimation.duration || 0);
    }
    requestAnimationFrame(() => animateRotation(rotationAnimation));
}

function animateRotation(rotationAnimation) {
    const viewerApi = rotationAnimation.api;
    if (!rotationAnimation.active) {
        // Animation ended, clear flag and cache
        if (viewerApi && viewerApi.renderer) {
            const renderer = viewerApi.renderer;
            renderer.isOrientAnimating = false;
            // Clear shadow/tint cache to force recalculation
            renderer.cachedShadows = null;
            renderer.cachedTints = null;
            renderer.lastShadowRotationMatrix = null;
        }
        return;
    }
    if (!viewerApi || !viewerApi.renderer) {
        rotationAnimation.active = false;
    rotationAnimation.startHalf = null;
    rotationAnimation.targetHalf = null;
        // Clear orient animation flag and cache
        if (viewerApi && viewerApi.renderer) {
            const renderer = viewerApi.renderer;
            renderer.isOrientAnimating = false;
            // Clear shadow/tint cache to force recalculation
            renderer.cachedShadows = null;
            renderer.cachedTints = null;
            renderer.lastShadowRotationMatrix = null;
        }
        return;
    }

    const renderer = viewerApi.renderer;
    const now = performance.now();
    const elapsed = now - rotationAnimation.startTime;
    let progress = elapsed / rotationAnimation.duration;

    // Ensure animation completes: if we're very close to the end or past it, force completion
    // This handles timing edge cases and ensures we always reach the target
    if (progress >= 0.99 || elapsed >= rotationAnimation.duration) {
        progress = 1.0; // Force to completion
    }

    if (progress >= 1.0) {
        // Zoom is already set in the interpolation section above
        // Set rotation matrix and other parameters
        renderer.viewerState.rotation = rotationAnimation.targetMatrix;

        if (rotationAnimation.targetCenter) {
            // Vec3 is defined in core/mol.js - access via window or use object literal
            const target = rotationAnimation.targetCenter;
            renderer.viewerState.center = { x: target.x, y: target.y, z: target.z };
            setViewSpan(renderer.viewerState, rotationAnimation.targetHalf
                ? { x: rotationAnimation.targetHalf.x * (renderer.viewerState.zoom || 1),
                    y: rotationAnimation.targetHalf.y * (renderer.viewerState.zoom || 1) }
                : null);
        } else {
            // Clear temporary center if orienting to all positions
            renderer.viewerState.center = null;
            // For multi-frame objects, keep the frame-specific extent to prevent zoom jumps
            // Only clear if we don't            renderer.viewerState.center = null;
            if (rotationAnimation.targetHalf) {
                setViewSpan(renderer.viewerState, {
                    x: rotationAnimation.targetHalf.x * (renderer.viewerState.zoom || 1),
                    y: rotationAnimation.targetHalf.y * (renderer.viewerState.zoom || 1) });
            } else {
                setViewSpan(renderer.viewerState, null);
            }
        }


        // Clear orient animation flag before rendering
        renderer.isOrientAnimating = false;
        // Clear shadow/tint cache to force recalculation with new rotation
        renderer.cachedShadows = null;
        renderer.cachedTints = null;
        renderer.lastShadowRotationMatrix = null;
        // Ensure all parameters are set before rendering
        renderer.render();
        rotationAnimation.active = false;
        // Clear stored values
        rotationAnimation.startCenter = null;
        rotationAnimation.targetCenter = null;
        rotationAnimation.object = null;

        return;
    }

    // Cubic easing - ensure smooth interpolation
    // Clamp progress to [0, 1] to prevent any edge cases
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const eased = clampedProgress < 0.5 ?
        4 * clampedProgress * clampedProgress * clampedProgress :
        1 - Math.pow(-2 * clampedProgress + 2, 3) / 2;

    // If we're at the end, use exact target matrix to avoid any interpolation errors
    if (progress >= 1.0) {
        renderer.viewerState.rotation = rotationAnimation.targetMatrix;
    } else {
        // Use camera controller's internal lerp method (we'll need to add this)
        // For now, use the existing lerpRotationMatrix function
        const lerped = lerpRotationMatrix(
            rotationAnimation.startMatrix,
            rotationAnimation.targetMatrix,
            eased
        );
        renderer.viewerState.rotation = lerped;
    }

    // ...the zoom is cameraAt's now (see its header); all that is left is
    // landing on the target exactly rather than on k^1.
    if (progress >= 1.0 && rotationAnimation.targetZoom !== undefined
        && rotationAnimation.startZoom !== null) {
        renderer.viewerState.zoom = rotationAnimation.targetZoom;
    }


    // ONE CAMERA PATH, COMPUTED ONCE. This was four branches - centre and
    // extent each interpolated separately, an exact-target branch at
    // progress 1, and a fourth that cleared the centre near the end - and each
    // wrote viewerState directly. They disagreed about which fields moved
    // together, which is how the shape came to be assigned only on completion.
    //
    // cameraAt is the whole of the movement now: geometric in the extent,
    // screen-even in the pan, and the aspect carried on the same weight. See
    // its header for why those are the right curves.
    const A = rotationAnimation;
    const goingHome = !A.targetCenter;
    const ownHalf = () => {
        const e = (A.object && A.object.maxExtent > 0) ? A.object.maxExtent : 30.0;
        return { x: e, y: e };
    };
    const startHalf = A.startHalf || ownHalf();
    // ...a flight back to everything has no view span of its own: it is the
    // object's, which is what the viewer falls back to once the temporary one
    // is cleared.
    const targetHalf = A.targetHalf || (goingHome ? ownHalf() : startHalf);

    const at = cameraAt(startHalf, targetHalf, A.startCenter, A.targetCenter,
        eased,
        (() => {
            // the viewport in DISPLAY pixels, the units _viewportScale works in
            const c = renderer.canvas;
            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio)
                || 1;
            return c ? { w: c.width / dpr, h: c.height / dpr } : { w: 0, h: 0 };
        })());

    // ...and back into the two fields, times the zoom, because _viewHalfSpan
    // divides by it on the way out. The zoom has not moved since the flight
    // began, so this is one multiplication and not a second animation.
    const z = (renderer.viewerState.zoom > 0) ? renderer.viewerState.zoom : 1;
    setViewSpan(renderer.viewerState,
        { x: at.half.x * z, y: at.half.y * z });
    if (at.centre) renderer.viewerState.center = at.centre;

    if (progress >= 1.0 && A.targetCenter) {
        // ...land on the target exactly rather than on k^1, which is the same
        // number up to floating point and not worth a reader wondering about.
        renderer.viewerState.center = {
            x: A.targetCenter.x, y: A.targetCenter.y, z: A.targetCenter.z };
        if (A.targetHalf) {
            setViewSpan(renderer.viewerState,
                { x: A.targetHalf.x * z, y: A.targetHalf.y * z });
        }
    }
    // A FLIGHT BACK TO EVERYTHING ENDS WITH NO TEMPORARY VIEW SPAN AT ALL. The
    // centre and the span go back to null so the viewer uses the object's own,
    // which is what "orient to all" means.
    if (goingHome && progress >= 0.99) {
        renderer.viewerState.center = null;
        if (!A.targetHalf) {
            setViewSpan(renderer.viewerState, null);
        }
    }

    renderer.render();
    requestAnimationFrame(() => animateRotation(rotationAnimation));
}
/**
 * A SELECTOR IN, A CAMERA MOVE OUT - orientToBestView with the project's way
 * of naming residues in front of it.
 *
 * ONE OBJECT, TWO NAMESPACES: the selector keys say WHAT to frame and the rest
 * are options, so `orientTo(r, {type: 'L', animate: false})` reads as one
 * thought and there is no key in both lists.
 *
 * This lived in parts/embed.js, where the notebook and the website could not
 * reach it - and the notebook's own copy, written later for what Python asks
 * for, handled only `object`. Written once here it is worth saying why the
 * merge matters: without it `orient({type: 'L'})` is an options object with no
 * recognised key, so it frames whatever happened to be selected at the time.
 * In the ligand example that is the pocket, which looks close enough to a
 * close-up on the ligand to pass.
 */
function orientTo(renderer, request) {
    const o = request || {};
    const opts = {};
    const sel = {};
    for (const k of Object.keys(o)) {
        if (SELECTOR_KEYS.includes(k)) sel[k] = o[k];
        else opts[k] = o[k];
    }
    if (Object.keys(sel).length) {
        opts.positions = positionsFor(renderer, sel);
        // ...and the object it belongs to, which orient reads separately to
        // find the frame whose coordinates it should be measuring.
        if (sel.object) opts.name = sel.object;
    }
    orientToBestView(renderer, opts);
    return renderer;
}

window.py2dmolOrient = { orientToBestView, orientTo };
}());
