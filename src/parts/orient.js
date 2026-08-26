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

        // Calculate extent from selected positions
        let maxDistSq = 0;
        let sumDistSq = 0;
        for (const c of coordsForBestView) {
            const dx = c[0] - visibleCenter[0];
            const dy = c[1] - visibleCenter[1];
            const dz = c[2] - visibleCenter[2];
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > maxDistSq) maxDistSq = distSq;
            sumDistSq += distSq;
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

        // Calculate standard deviation for selected positions
        const selectedPositionsStdDev = coordsForBestView.length > 0 ? Math.sqrt(sumDistSq / coordsForBestView.length) : 0;

        // Store stdDev for animation
        rotationAnimation.visibleStdDev = selectedPositionsStdDev;
        rotationAnimation.originalStdDev = selectedPositionsStdDev;
    } else {
        // No coordinates, clear stdDev animation data
        rotationAnimation.visibleStdDev = null;
        rotationAnimation.originalStdDev = null;
    }

    const Rcur = renderer.viewerState.rotation;

    // Get canvas dimensions to determine longest axis
    const canvas = renderer.canvas;
    const canvasWidth = canvas ? (parseInt(canvas.style.width) || canvas.width) : null;
    const canvasHeight = canvas ? (parseInt(canvas.style.height) || canvas.height) : null;

    // Use filtered coordinates (selected positions only) for best view rotation
    const Rtarget = bestViewTargetRotation_relaxed_AUTO(coordsForBestView, Rcur, canvasWidth, canvasHeight);

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
            renderer.viewerState.extent = targetExtent;
        } else {
            renderer.viewerState.center = null;
            if (targetExtent !== null && targetExtent !== undefined) {
                renderer.viewerState.extent = targetExtent;
            } else {
                renderer.viewerState.extent = null;
            }
        }

        // Set zoom directly
        renderer.viewerState.zoom = targetZoom;

        // Update stdDev if needed
        if (rotationAnimation.visibleStdDev !== null && rotationAnimation.visibleStdDev !== undefined) {
            object.stdDev = rotationAnimation.visibleStdDev;
            // Update focal length if perspective is enabled
            if (renderer.orthoSlider && renderer.viewerState.ortho < 1) {
                const STD_DEV_MULT = 2.0;
                const PERSPECTIVE_MIN_MULT = 1.5;
                const PERSPECTIVE_MAX_MULT = 20.0;
                const normalizedValue = parseFloat(renderer.orthoSlider.value);

                if (normalizedValue < 1.0) {
                    const baseSize = object.stdDev * STD_DEV_MULT;
                    const multiplier = PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * normalizedValue;
                    renderer.focalLength = baseSize * multiplier;
                }
            }
        }

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
    rotationAnimation.startZoom = renderer.viewerState.zoom;
    rotationAnimation.targetZoom = targetZoom;
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
        // When temporaryExtent is null, renderer uses object.maxExtent, so we should use that as startExtent
        // This prevents jumps when transitioning from null (using maxExtent) to visibleExtent
        rotationAnimation.startExtent = renderer.viewerState.extent !== null && renderer.viewerState.extent !== undefined
            ? renderer.viewerState.extent
            : (object.maxExtent || frameExtent);
        rotationAnimation.targetExtent = targetExtent;
    } else {
        rotationAnimation.startCenter = renderer.viewerState.center ? {
            x: renderer.viewerState.center.x,
            y: renderer.viewerState.center.y,
            z: renderer.viewerState.center.z
        } : null;
        rotationAnimation.targetCenter = null;
        // When temporaryExtent is null, renderer uses object.maxExtent, so we should use that as startExtent
        // This prevents jumps when transitioning from null (using maxExtent) to frameExtent
        rotationAnimation.startExtent = renderer.viewerState.extent !== null && renderer.viewerState.extent !== undefined
            ? renderer.viewerState.extent
            : (object.maxExtent || frameExtent);
        // For multi-frame objects, use frame-specific extent to prevent zoom jumps
        rotationAnimation.targetExtent = targetExtent; // Will be frameExtent if set above
    }

    // Start animation
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
            renderer.viewerState.extent = rotationAnimation.targetExtent;
        } else {
            // Clear temporary center if orienting to all positions
            renderer.viewerState.center = null;
            // For multi-frame objects, keep the frame-specific extent to prevent zoom jumps
            // Only clear if we don't            renderer.viewerState.center = null;
            if (rotationAnimation.targetExtent !== null && rotationAnimation.targetExtent !== undefined) {
                renderer.viewerState.extent = rotationAnimation.targetExtent;
            } else {
                renderer.viewerState.extent = null;
            }
        }

        // Set final stdDev to visible subset's stdDev if it was modified during animation
        if (rotationAnimation.object && rotationAnimation.visibleStdDev !== null && rotationAnimation.visibleStdDev !== undefined) {
            rotationAnimation.object.stdDev = rotationAnimation.visibleStdDev;
            // Update focal length directly to avoid triggering a render via ortho slider
            // This prevents zoom recalculation during animation completion
            if (renderer.orthoSlider && renderer.viewerState.ortho < 1) {
                const STD_DEV_MULT = 2.0;
                const PERSPECTIVE_MIN_MULT = 1.5;
                const PERSPECTIVE_MAX_MULT = 20.0;
                const normalizedValue = parseFloat(renderer.orthoSlider.value);

                if (normalizedValue < 1.0) {
                    const baseSize = rotationAnimation.object.stdDev * STD_DEV_MULT;
                    const multiplier = PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * normalizedValue;
                    renderer.focalLength = baseSize * multiplier;
                }
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
        rotationAnimation.startExtent = null;
        rotationAnimation.targetExtent = null;
        rotationAnimation.startZoom = null;
        rotationAnimation.targetZoom = null;
        rotationAnimation.object = null;
        rotationAnimation.visibleStdDev = null;
        rotationAnimation.originalStdDev = null;
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

    // Interpolate zoom during animation - use same easing for consistency
    // Ensure we reach exactly the target value to prevent jumps
    if (rotationAnimation.targetZoom !== undefined && rotationAnimation.startZoom !== null) {
        if (progress >= 1.0) {
            // At completion, use exact target value
            renderer.viewerState.zoom = rotationAnimation.targetZoom;
        } else {
            // During animation, interpolate smoothly
            const t = eased; // Use same eased value for smooth zoom interpolation
            renderer.viewerState.zoom = rotationAnimation.startZoom + (rotationAnimation.targetZoom - rotationAnimation.startZoom) * t;
        }
    }

    // Interpolate stdDev during animation if visible subset exists
    // This affects ortho focal length calculation, so we update it smoothly
    if (rotationAnimation.object && rotationAnimation.visibleStdDev !== null && rotationAnimation.visibleStdDev !== undefined &&
        rotationAnimation.originalStdDev !== null && rotationAnimation.originalStdDev !== undefined) {
        const t = eased;
        // Interpolate stdDev from original to visible subset's stdDev
        rotationAnimation.object.stdDev = rotationAnimation.originalStdDev +
            (rotationAnimation.visibleStdDev - rotationAnimation.originalStdDev) * t;

        // Update focal length smoothly during animation to coordinate with stdDev changes
        // This ensures ortho/perspective settings stay in sync with the structure size
        if (renderer.orthoSlider && renderer.viewerState.ortho < 1) {
            const STD_DEV_MULT = 2.0;
            const PERSPECTIVE_MIN_MULT = 1.5;
            const PERSPECTIVE_MAX_MULT = 20.0;
            const normalizedValue = parseFloat(renderer.orthoSlider.value);

            if (normalizedValue < 1.0) {
                const baseSize = rotationAnimation.object.stdDev * STD_DEV_MULT;
                const multiplier = PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * normalizedValue;
                renderer.focalLength = baseSize * multiplier;
            }
        }

        // Trigger ortho slider update to recalculate focal length with new stdDev
        // This ensures the slider's internal state is updated
        const orthoSlider = document.getElementById('orthoSlider');
        if (orthoSlider) {
            orthoSlider.dispatchEvent(new Event('input'));
        }
    }

    // Interpolate center and extent during animation - use same easing for consistency
    if (rotationAnimation.targetCenter && rotationAnimation.startCenter) {
        // If at completion, use exact target values to avoid any rounding errors
        if (progress >= 1.0) {
            renderer.viewerState.center = {
                x: rotationAnimation.targetCenter.x,
                y: rotationAnimation.targetCenter.y,
                z: rotationAnimation.targetCenter.z
            };
            if (rotationAnimation.targetExtent !== null && rotationAnimation.targetExtent !== undefined) {
                renderer.viewerState.extent = rotationAnimation.targetExtent;
            }
        } else {
            const t = eased; // Use same eased value for smooth interpolation
            // Smoothly interpolate from start center to target center
            renderer.viewerState.center = {
                x: rotationAnimation.startCenter.x + (rotationAnimation.targetCenter.x - rotationAnimation.startCenter.x) * t,
                y: rotationAnimation.startCenter.y + (rotationAnimation.targetCenter.y - rotationAnimation.startCenter.y) * t,
                z: rotationAnimation.startCenter.z + (rotationAnimation.targetCenter.z - rotationAnimation.startCenter.z) * t
            };
            // Interpolate extent as well for smooth zoom animation
            if (rotationAnimation.targetExtent !== null && rotationAnimation.targetExtent !== undefined) {
                renderer.viewerState.extent = rotationAnimation.startExtent + (rotationAnimation.targetExtent - rotationAnimation.startExtent) * t;
            } else {
                renderer.viewerState.extent = rotationAnimation.startExtent;
            }
        }
    } else {
        // Interpolate extent even when clearing center (for smooth transition back to all positions)
        // For multi-frame objects, we keep the frame-specific extent to prevent zoom jumps
        if (rotationAnimation.targetExtent !== null && rotationAnimation.targetExtent !== undefined) {
            // We have a frame-specific extent, interpolate to it and keep it
            const t = eased;
            // Always use startExtent as the starting point, not renderer.temporaryExtent
            // This prevents jumps when camera.extent is null or different
            const startExtent = rotationAnimation.startExtent !== null && rotationAnimation.startExtent !== undefined
                ? rotationAnimation.startExtent
                : (rotationAnimation.object && rotationAnimation.object.maxExtent) || 30.0;
            renderer.viewerState.extent = startExtent + (rotationAnimation.targetExtent - startExtent) * t;
        } else {
            // No frame-specific extent, use object.maxExtent
            const t = eased;
            // Always use startExtent as the starting point, not renderer.temporaryExtent
            const startExtent = rotationAnimation.startExtent !== null && rotationAnimation.startExtent !== undefined
                ? rotationAnimation.startExtent
                : (rotationAnimation.object && rotationAnimation.object.maxExtent) || 30.0;
            const targetExtent = (rotationAnimation.object && rotationAnimation.object.maxExtent) || 30.0;
            renderer.viewerState.extent = startExtent + (targetExtent - startExtent) * t;
        }
        // Clear temporary center if orienting to all positions
        if (progress >= 0.99) { // Only clear at the very end
            renderer.viewerState.center = null;
            // For multi-frame objects, keep the frame-specific extent to prevent zoom jumps
            // Only clear if we don't have a frame-specific extent
            if (rotationAnimation.targetExtent === null || rotationAnimation.targetExtent === undefined) {
                renderer.viewerState.extent = null;
            }
            // Otherwise, keep extent set to the frame-specific extent
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
