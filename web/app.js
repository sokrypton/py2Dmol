// ============================================================================
// APP.JS - Application logic, UI handlers, and initialization
// ============================================================================

// ============================================================================
// GLOBAL STATE
// ============================================================================

let viewerApi = null;
let objectsWithPAE = new Set();
let batchedObjects = [];
// Removed selectedResiduesSet - now using renderer.selectionModel as single source of truth
let previewSelectionSet = null;       // NEW: live drag preview selection (temporary during drag)


// Rotation animation state
let rotationAnimation = {
    active: false,
    startMatrix: null,
    targetMatrix: null,
    startTime: 0,
    duration: 1000
};

// Constants
const FIXED_WIDTH = 600;
const FIXED_HEIGHT = 600;
const PAE_PLOT_SIZE = 300;

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    // Initialize viewer config
    initializeViewerConfig();
    
    // Setup canvas dimensions
    setupCanvasDimensions();
    
    // Initialize the renderer
    try {
        const viewerContainer = document.getElementById('viewer-container');
        initializePy2DmolViewer(viewerContainer);
    } catch (e) {
        console.error("Failed to initialize viewer:", e);
        setStatus("Error: Failed to initialize viewer. See console.", true);
        return;
    }
    
    // Get viewer API reference
    viewerApi = window.py2dmol_viewers[window.viewerConfig.viewer_id];
    
    // Setup all event listeners
    setupEventListeners();
    
    // Initialize drag and drop
    initDragAndDrop();
    
    // Set initial state
    const paeCanvas = document.getElementById('paeCanvas');
    if (paeCanvas) {
        paeCanvas.style.display = 'none';
    }
    setStatus("Ready. Upload a file or fetch an ID.");
}

function initializeViewerConfig() {
    // Get DOM elements for config sync
    const biounitEl = document.getElementById('biounitCheckbox');
    const ignoreLigandsEl = document.getElementById('ignoreLigandsCheckbox');
    
    // Initialize global viewer config
    window.viewerConfig = {
        size: [FIXED_WIDTH, FIXED_HEIGHT],
        pae_size: [PAE_PLOT_SIZE, PAE_PLOT_SIZE],
        color: "auto",
        shadow: true,
        outline: true,
        width: 3.0,
        ortho: 0.5, // Normalized 0-1 range (0.5 = 50% toward orthographic)
        rotate: false,
        controls: true,
        autoplay: false,
        box: true,
        pastel: 0.25,
        pae: true,
        colorblind: false,
        viewer_id: "standalone-viewer-1",
        biounit: true,
        ignoreLigands: true
    };
    
    // Sync UI with config
    if (biounitEl) biounitEl.checked = !!window.viewerConfig.biounit;
    if (ignoreLigandsEl) ignoreLigandsEl.checked = !!window.viewerConfig.ignoreLigands;
    
    // Wire change listeners
    if (biounitEl) {
        biounitEl.addEventListener('change', () => {
            window.viewerConfig.biounit = biounitEl.checked;
        });
    }
    
    if (ignoreLigandsEl) {
        ignoreLigandsEl.addEventListener('change', () => {
            window.viewerConfig.ignoreLigands = ignoreLigandsEl.checked;
        });
    }
}

function setupCanvasDimensions() {
    const canvasContainer = document.getElementById('canvasContainer');
    const canvas = document.getElementById('canvas');
    const viewerColumn = document.getElementById('viewerColumn');
    
    canvasContainer.style.width = `${FIXED_WIDTH}px`;
    canvasContainer.style.height = `${FIXED_HEIGHT}px`;
    canvas.width = FIXED_WIDTH;
    canvas.height = FIXED_HEIGHT;
    viewerColumn.style.minWidth = `${FIXED_WIDTH}px`;
}

function setupEventListeners() {
    // Fetch button
    document.getElementById('fetch-btn').addEventListener('click', handleFetch);
    
    // Upload button
    const uploadButton = document.getElementById('upload-button');
    const fileUploadInput = document.getElementById('file-upload');
    uploadButton.addEventListener('click', () => fileUploadInput.click());
    fileUploadInput.addEventListener('change', handleFileUpload);
    
    // Example buttons
    const exampleButton1 = document.getElementById('example-button-1');
    if (exampleButton1) {
        exampleButton1.addEventListener('click', () => {
            const fetchIdInput = document.getElementById('fetch-id');
            fetchIdInput.value = 'A0JNW5';
            handleFetch();
        });
    }
    
    const exampleButton2 = document.getElementById('example-button-2');
    if (exampleButton2) {
        exampleButton2.addEventListener('click', () => {
            const fetchIdInput = document.getElementById('fetch-id');
            fetchIdInput.value = '1YNE';
            handleFetch();
        });
    }
    
    // Save state button
    const saveStateButton = document.getElementById('saveStateButton');
    if (saveStateButton) {
        saveStateButton.addEventListener('click', saveViewerState);
    }
    
    // Save SVG button (camera button)
    const saveSvgButton = document.getElementById('saveSvgButton');
    if (saveSvgButton) {
        saveSvgButton.addEventListener('click', saveViewerAsSvg);
    }
    
    // Navigation buttons
    const orientToggle = document.getElementById('orientToggle');
    const prevObjectButton = document.getElementById('prevObjectButton');
    const nextObjectButton = document.getElementById('nextObjectButton');
    
    if (orientToggle) {
        // Handle click on the label/span (not the hidden checkbox)
        const orientSpan = orientToggle.querySelector('span');
        if (orientSpan) {
            orientSpan.addEventListener('click', (e) => {
                e.preventDefault();
                applyBestViewRotation();
            });
        }
    }
    if (prevObjectButton) prevObjectButton.addEventListener('click', gotoPreviousObject);
    if (nextObjectButton) nextObjectButton.addEventListener('click', gotoNextObject);
    
    // Object and color select
    const objectSelect = document.getElementById('objectSelect');
    // Note: colorSelect event listener is handled in viewer.js initializePy2DmolViewer()
    // We don't need a duplicate listener here
    
    if (objectSelect) objectSelect.addEventListener('change', handleObjectChange);

    // Attach sequence controls
    const sequenceView = document.getElementById('sequenceView');
    const selectAllBtn = document.getElementById('selectAllResidues');
    const clearAllBtn  = document.getElementById('clearAllResidues');
    const sequenceActions = document.querySelector('.sequence-actions');
    
    // Sequence panel is always visible now
    if (sequenceView) {
      sequenceView.classList.remove('hidden');
      const container = document.getElementById('top-panel-container');
      if (container) {
        container.classList.remove('collapsed');
      }
      if (sequenceActions) {
        sequenceActions.style.display = 'flex';
      }
    }
    // Sequence view mode toggle button
    const toggleSequenceModeBtn = document.getElementById('toggleSequenceMode');
    
    if (toggleSequenceModeBtn) {
        toggleSequenceModeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            sequenceViewMode = !sequenceViewMode;
            updateSequenceModeButton();
            // Always try to rebuild - buildSequenceView() will return early if no data is available
            buildSequenceView();
        });
    }
    
    function updateSequenceModeButton() {
        if (toggleSequenceModeBtn) {
            // Set fixed width to prevent button size change when text changes
            // Use a reasonable fixed width that accommodates both "Sequence" and "Chain"
            if (!toggleSequenceModeBtn.style.minWidth) {
                toggleSequenceModeBtn.style.minWidth = '100px'; // Fixed min width for both texts
            }
            if (sequenceViewMode) {
                toggleSequenceModeBtn.classList.add('active');
                toggleSequenceModeBtn.textContent = 'Chain'; // Show "Chain" when sequence is visible
            } else {
                toggleSequenceModeBtn.classList.remove('active');
                toggleSequenceModeBtn.textContent = 'Sequence'; // Show "Sequence" when only chains are visible
            }
        }
    }
    
    // Initialize button state
    updateSequenceModeButton();
    
    if (selectAllBtn) selectAllBtn.addEventListener('click', (e) => { e.preventDefault(); selectAllResidues(); });
    if (clearAllBtn)  clearAllBtn.addEventListener('click', (e) => { e.preventDefault(); clearAllResidues(); });

    // Clear all objects button
    const clearAllButton = document.getElementById('clearAllButton');
    if (clearAllButton) {
        clearAllButton.addEventListener('click', (e) => {
            e.preventDefault();
            clearAllObjects();
        });
    }


    // Listen for the custom event dispatched by the renderer when color settings change
    document.addEventListener('py2dmol-color-change', () => {
        // Update colors in sequence view when color mode changes
        updateSequenceViewColors();
        updateSequenceViewSelectionState();
    });
    
    // Listen for selection changes (including PAE selections)
    document.addEventListener('py2dmol-selection-change', (e) => {
        // Sync chain pills with selection model
        syncChainPillsToSelection();
        // Update sequence view
        updateSequenceViewSelectionState();
    });
    
    // Update navigation button states
    updateObjectNavigationButtons();
}

// ============================================================================
// UI HELPER FUNCTIONS
// ============================================================================

function setStatus(message, isError = false) {
    const statusElement = document.getElementById('status-message');
    statusElement.textContent = message;
    statusElement.className = `mt-4 text-sm font-medium ${
        isError ? 'text-red-700 bg-red-100 border-red-200' : 'text-blue-700 bg-blue-50 border-blue-200'
    } p-2 rounded-lg border`;
    statusElement.classList.remove('hidden');
}

function gotoPreviousObject() {
    const objectSelect = document.getElementById('objectSelect');
    if (!objectSelect || objectSelect.options.length === 0) return;
    
    const currentIndex = objectSelect.selectedIndex;
    const newIndex = currentIndex > 0 ? currentIndex - 1 : objectSelect.options.length - 1;
    objectSelect.selectedIndex = newIndex;
    objectSelect.dispatchEvent(new Event('change'));
}

function gotoNextObject() {
    const objectSelect = document.getElementById('objectSelect');
    if (!objectSelect || objectSelect.options.length === 0) return;
    
    const currentIndex = objectSelect.selectedIndex;
    const newIndex = currentIndex < objectSelect.options.length - 1 ? currentIndex + 1 : 0;
    objectSelect.selectedIndex = newIndex;
    objectSelect.dispatchEvent(new Event('change'));
}

function updateObjectNavigationButtons() {
    const objectSelect = document.getElementById('objectSelect');
    const prevButton = document.getElementById('prevObjectButton');
    const nextButton = document.getElementById('nextObjectButton');
    
    if (!objectSelect || !prevButton || !nextButton) return;
    
    const shouldDisable = objectSelect.options.length <= 1;
    prevButton.disabled = shouldDisable;
    nextButton.disabled = shouldDisable;
    
    // Add greyed-out class for visual feedback
    if (shouldDisable) {
        prevButton.classList.add('greyed-out');
        nextButton.classList.add('greyed-out');
    } else {
        prevButton.classList.remove('greyed-out');
        nextButton.classList.remove('greyed-out');
    }
}

function handleObjectChange() {
    const objectSelect = document.getElementById('objectSelect');
    const paeCanvas = document.getElementById('paeCanvas');
    const paeContainer = document.getElementById('paeContainer');
    
    const selectedObject = objectSelect.value;
    if (!selectedObject) return;
    
    // Clear selection when switching objects (selection is per-object)
    // The renderer's objectSelect change handler already calls resetToDefault(),
    // but we ensure it here as well for safety
    if (viewerApi?.renderer && viewerApi.renderer.currentObjectName !== selectedObject) {
        viewerApi.renderer.resetToDefault();
    }
    
    const hasPAE = objectsWithPAE.has(selectedObject);
    
    // Show/hide both container and canvas based on PAE data availability
    if (paeContainer) {
        paeContainer.style.display = hasPAE ? 'flex' : 'none';
    }
    if (paeCanvas) {
        paeCanvas.style.display = hasPAE ? 'block' : 'none';
    }
    
    // Rebuild sequence view for the new object
    buildSequenceView();
    updateChainSelectionUI();
    
    // Note: updateColorMode() is a placeholder, removed to avoid confusion
    // Color mode is managed by the renderer and persists across object changes
}

function updateColorMode() {
    // Placeholder for future color mode updates
    // Can be extended to sync with viewer color settings
}

// ============================================================================
// BEST VIEW ROTATION ANIMATION
// ============================================================================

function applyBestViewRotation(animate = true) {
    if (!viewerApi || !viewerApi.renderer) return;
    const renderer = viewerApi.renderer;
    
    const objectSelect = document.getElementById('objectSelect');
    const objectName = objectSelect ? objectSelect.value : null;
    if (!objectName) return;
    
    const object = renderer.objectsData[objectName];
    if (!object || !object.frames || object.frames.length === 0) return;

    const currentFrame = renderer.currentFrame || 0;
    const frame = object.frames[currentFrame];
    if (!frame || !frame.coords || frame.coords.length === 0) return;
    
    // Ensure frame data is loaded into renderer if not already
    if (renderer.coords.length === 0 || renderer.lastRenderedFrame !== currentFrame) {
        renderer._loadFrameData(currentFrame, true); // Load without render
    }

    // Get current selection to determine which atoms to use for orienting
    const selection = renderer.getSelection();
    let selectedAtomIndices = null;
    
    // Determine which atoms to use: selected atoms if available, otherwise all atoms
    if (selection && selection.atoms && selection.atoms.size > 0) {
        // Use only selected atoms
        selectedAtomIndices = selection.atoms;
    } else if (selection && selection.selectionMode === 'default' && 
               (!selection.chains || selection.chains.size === 0)) {
        // Default mode with no explicit selection: use all atoms
        selectedAtomIndices = null; // Will use all atoms
    } else if (selection && selection.chains && selection.chains.size > 0) {
        // Chain-based selection: get all atoms in selected chains
        selectedAtomIndices = new Set();
        for (let i = 0; i < frame.coords.length; i++) {
            if (frame.chains && frame.chains[i] && selection.chains.has(frame.chains[i])) {
                selectedAtomIndices.add(i);
            }
        }
        // If no atoms found in chains, fall back to all atoms
        if (selectedAtomIndices.size === 0) {
            selectedAtomIndices = null;
        }
    } else {
        // No selection or empty selection: use all atoms
        selectedAtomIndices = null;
    }

    // Filter coordinates to only selected atoms (or use all if no selection)
    let coordsForBestView = [];
    if (selectedAtomIndices && selectedAtomIndices.size > 0) {
        for (const atomIdx of selectedAtomIndices) {
            if (atomIdx >= 0 && atomIdx < frame.coords.length) {
                coordsForBestView.push(frame.coords[atomIdx]);
            }
        }
    } else {
        // No selection or all atoms selected: use all coordinates
        coordsForBestView = frame.coords;
    }

    if (coordsForBestView.length === 0) {
        // No coordinates to orient to, return early
        return;
    }

    // Calculate center and extent from selected atoms only
    let visibleCenter = null;
    let visibleExtent = null;
    let frameExtent = 0;
    
    if (coordsForBestView.length > 0) {
        // Calculate center from selected atoms
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
        
        // Calculate extent from selected atoms
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
        visibleExtent = Math.sqrt(maxDistSq);
        frameExtent = visibleExtent;
        
        // Calculate standard deviation for selected atoms
        const selectedAtomsStdDev = coordsForBestView.length > 0 ? Math.sqrt(sumDistSq / coordsForBestView.length) : 0;
        
        // Store stdDev for animation
        rotationAnimation.visibleStdDev = selectedAtomsStdDev;
        rotationAnimation.originalStdDev = selectedAtomsStdDev;
    } else {
        // No coordinates, clear stdDev animation data
        rotationAnimation.visibleStdDev = null;
        rotationAnimation.originalStdDev = null;
    }
    const Rcur = renderer.rotationMatrix;
    
    // Get canvas dimensions to determine longest axis
    const canvas = renderer.canvas;
    const canvasWidth = canvas ? (parseInt(canvas.style.width) || canvas.width) : null;
    const canvasHeight = canvas ? (parseInt(canvas.style.height) || canvas.height) : null;
    
    // Use filtered coordinates (selected atoms only) for best view rotation
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
    let targetZoom = renderer.zoom;
    
    // Get canvas dimensions for zoom calculation (already retrieved above, but keep for clarity)
    // canvasWidth and canvasHeight are already available from above
    
    if (visibleCenter && visibleExtent && coordsForBestView.length > 0) {
        // Center is the same regardless of rotation (it's a 3D point)
        // Use center and extent calculated from selected atoms
        targetCenter = visibleCenter;
        targetExtent = visibleExtent;
        
        // Calculate zoom adjustment based on final orientation and window dimensions
        // The renderer now accounts for window aspect ratio, so we should set zoom to 1.0
        // to let the renderer calculate the appropriate base scale based on selected atoms extent
        targetZoom = 1.0;
    } else {
        // When orienting to all atoms, use the current frame's extent instead of object.maxExtent
        // For multi-frame objects, object.maxExtent is across all frames, which can cause
        // a mismatch with the current frame's actual extent, leading to zoom jumps
        // We'll keep zoom the same since the extent should be consistent now
        targetZoom = renderer.zoom;
        
        // Store frame-specific extent for use during animation
        // This ensures the renderer uses the correct extent for the current frame
        if (frameExtent > 0) {
            // Set temporary extent to the current frame's extent
            // This will be used by the renderer instead of object.maxExtent
            targetExtent = frameExtent;
        }
    }

    // Stop auto-rotation if active
    if (renderer.autoRotate) {
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
        renderer.rotationMatrix = Rtarget.map(row => [...row]);
        
        // Set center and extent directly
        if (targetCenter) {
            renderer.temporaryCenter = {
                x: targetCenter[0],
                y: targetCenter[1],
                z: targetCenter[2]
            };
            renderer.temporaryExtent = targetExtent;
        } else {
            renderer.temporaryCenter = null;
            if (targetExtent !== null && targetExtent !== undefined) {
                renderer.temporaryExtent = targetExtent;
            } else {
                renderer.temporaryExtent = null;
            }
        }
        
        // Set zoom directly
        renderer.zoom = targetZoom;
        
        // Update stdDev if needed
        if (rotationAnimation.visibleStdDev !== null && rotationAnimation.visibleStdDev !== undefined) {
            object.stdDev = rotationAnimation.visibleStdDev;
            // Update focal length if perspective is enabled
            if (renderer.orthoSlider && renderer.perspectiveEnabled) {
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
        renderer.render();
        return;
    }
    
    // Set up animation
    rotationAnimation.startMatrix = Rcur.map(row => [...row]);
    rotationAnimation.targetMatrix = Rtarget.map(row => [...row]);
    rotationAnimation.startZoom = renderer.zoom;
    rotationAnimation.targetZoom = targetZoom;
    rotationAnimation.duration = duration;
    rotationAnimation.startTime = performance.now();
    rotationAnimation.object = object;
    
    // Set up center and extent interpolation
    if (targetCenter) {
        // Calculate current center if temporaryCenter is not set
        // This prevents jumps when orienting after PAE selection
        let currentCenter = null;
        if (renderer.temporaryCenter) {
            currentCenter = {
                x: renderer.temporaryCenter.x,
                y: renderer.temporaryCenter.y,
                z: renderer.temporaryCenter.z
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
        rotationAnimation.startExtent = renderer.temporaryExtent !== null && renderer.temporaryExtent !== undefined
            ? renderer.temporaryExtent
            : (object.maxExtent || frameExtent);
        rotationAnimation.targetExtent = targetExtent;
    } else {
        rotationAnimation.startCenter = renderer.temporaryCenter ? {
            x: renderer.temporaryCenter.x,
            y: renderer.temporaryCenter.y,
            z: renderer.temporaryCenter.z
        } : null;
        rotationAnimation.targetCenter = null;
        // When temporaryExtent is null, renderer uses object.maxExtent, so we should use that as startExtent
        // This prevents jumps when transitioning from null (using maxExtent) to frameExtent
        rotationAnimation.startExtent = renderer.temporaryExtent !== null && renderer.temporaryExtent !== undefined
            ? renderer.temporaryExtent
            : (object.maxExtent || frameExtent);
        // For multi-frame objects, use frame-specific extent to prevent zoom jumps
        rotationAnimation.targetExtent = targetExtent; // Will be frameExtent if set above
    }
    
    // Start animation
    rotationAnimation.active = true;
    requestAnimationFrame(animateRotation);
}

function animateRotation() {
    if (!rotationAnimation.active) return;
    if (!viewerApi || !viewerApi.renderer) {
        rotationAnimation.active = false;
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
        renderer.rotationMatrix = rotationAnimation.targetMatrix;
        
        if (rotationAnimation.targetCenter) {
            // Vec3 is defined in viewer.js - access via window or use object literal
            const target = rotationAnimation.targetCenter;
            renderer.temporaryCenter = { x: target.x, y: target.y, z: target.z };
            renderer.temporaryExtent = rotationAnimation.targetExtent;
        } else {
            // Clear temporary center if orienting to all atoms
            renderer.temporaryCenter = null;
            // For multi-frame objects, keep the frame-specific extent to prevent zoom jumps
            // Only clear if we don't have a frame-specific extent
            if (rotationAnimation.targetExtent !== null && rotationAnimation.targetExtent !== undefined) {
                renderer.temporaryExtent = rotationAnimation.targetExtent;
            } else {
                renderer.temporaryExtent = null;
            }
        }
        
        // Set final stdDev to visible subset's stdDev if it was modified during animation
        if (rotationAnimation.object && rotationAnimation.visibleStdDev !== null && rotationAnimation.visibleStdDev !== undefined) {
            rotationAnimation.object.stdDev = rotationAnimation.visibleStdDev;
            // Update focal length directly to avoid triggering a render via ortho slider
            // This prevents zoom recalculation during animation completion
            if (renderer.orthoSlider && renderer.perspectiveEnabled) {
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
        renderer.rotationMatrix = rotationAnimation.targetMatrix;
    } else {
        // Use camera controller's internal lerp method (we'll need to add this)
        // For now, use the existing lerpRotationMatrix function
        const lerped = lerpRotationMatrix(
            rotationAnimation.startMatrix,
            rotationAnimation.targetMatrix,
            eased
        );
        renderer.rotationMatrix = lerped;
    }
    
    // Interpolate zoom during animation - use same easing for consistency
    // Ensure we reach exactly the target value to prevent jumps
    if (rotationAnimation.targetZoom !== undefined && rotationAnimation.startZoom !== null) {
        if (progress >= 1.0) {
            // At completion, use exact target value
            renderer.zoom = rotationAnimation.targetZoom;
        } else {
            // During animation, interpolate smoothly
            const t = eased; // Use same eased value for smooth zoom interpolation
            renderer.zoom = rotationAnimation.startZoom + (rotationAnimation.targetZoom - rotationAnimation.startZoom) * t;
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
        if (renderer.orthoSlider && renderer.perspectiveEnabled) {
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
            renderer.temporaryCenter = {
                x: rotationAnimation.targetCenter.x,
                y: rotationAnimation.targetCenter.y,
                z: rotationAnimation.targetCenter.z
            };
            if (rotationAnimation.targetExtent !== null && rotationAnimation.targetExtent !== undefined) {
                renderer.temporaryExtent = rotationAnimation.targetExtent;
            }
        } else {
            const t = eased; // Use same eased value for smooth interpolation
            // Smoothly interpolate from start center to target center
            renderer.temporaryCenter = {
                x: rotationAnimation.startCenter.x + (rotationAnimation.targetCenter.x - rotationAnimation.startCenter.x) * t,
                y: rotationAnimation.startCenter.y + (rotationAnimation.targetCenter.y - rotationAnimation.startCenter.y) * t,
                z: rotationAnimation.startCenter.z + (rotationAnimation.targetCenter.z - rotationAnimation.startCenter.z) * t
            };
            // Interpolate extent as well for smooth zoom animation
            if (rotationAnimation.targetExtent !== null && rotationAnimation.targetExtent !== undefined) {
                renderer.temporaryExtent = rotationAnimation.startExtent + (rotationAnimation.targetExtent - rotationAnimation.startExtent) * t;
            } else {
                renderer.temporaryExtent = rotationAnimation.startExtent;
            }
        }
    } else {
        // Interpolate extent even when clearing center (for smooth transition back to all atoms)
        // For multi-frame objects, we keep the frame-specific extent to prevent zoom jumps
        if (rotationAnimation.targetExtent !== null && rotationAnimation.targetExtent !== undefined) {
            // We have a frame-specific extent, interpolate to it and keep it
            const t = eased;
            // Always use startExtent as the starting point, not renderer.temporaryExtent
            // This prevents jumps when camera.extent is null or different
            const startExtent = rotationAnimation.startExtent !== null && rotationAnimation.startExtent !== undefined
                ? rotationAnimation.startExtent
                : (rotationAnimation.object && rotationAnimation.object.maxExtent) || 30.0;
            renderer.temporaryExtent = startExtent + (rotationAnimation.targetExtent - startExtent) * t;
        } else {
            // No frame-specific extent, use object.maxExtent
            const t = eased;
            // Always use startExtent as the starting point, not renderer.temporaryExtent
            const startExtent = rotationAnimation.startExtent !== null && rotationAnimation.startExtent !== undefined
                ? rotationAnimation.startExtent
                : (rotationAnimation.object && rotationAnimation.object.maxExtent) || 30.0;
            const targetExtent = (rotationAnimation.object && rotationAnimation.object.maxExtent) || 30.0;
            renderer.temporaryExtent = startExtent + (targetExtent - startExtent) * t;
        }
        // Clear temporary center if orienting to all atoms
        if (progress >= 0.99) { // Only clear at the very end
            renderer.temporaryCenter = null;
            // For multi-frame objects, keep the frame-specific extent to prevent zoom jumps
            // Only clear if we don't have a frame-specific extent
            if (rotationAnimation.targetExtent === null || rotationAnimation.targetExtent === undefined) {
                renderer.temporaryExtent = null;
            }
            // Otherwise, keep extent set to the frame-specific extent
        }
    }
    
    renderer.render();
    requestAnimationFrame(animateRotation);
}

// ============================================================================
// STRUCTURE PROCESSING
// ============================================================================

/**
 * Extract biounit operations from PDB or CIF file (once for all models)
 * @param {string} text - File text
 * @param {boolean} isCIF - Whether file is CIF format
 * @returns {Array<object>|null} - Array of {R, t, chains} operations or null
 */
function extractBiounitOperations(text, isCIF) {
    if (isCIF) {
        return extractCIFBiounitOperations(text);
    } else {
        return extractPDBBiounitOperations(text);
    }
}

/**
 * Extract biounit operations from CIF file
 * @param {string} text - CIF text
 * @returns {Array<object>|null} - Array of operations or null
 */

function extractCIFBiounitOperations(text) {
    // Fast-negative: require both loops to be present
    if (!/_pdbx_struct_assembly_gen\./.test(text) || !/_pdbx_struct_oper_list\./.test(text)) {
        return null;
    }

    const loops = parseMinimalCIF_light(text);
    const getLoop = (name) => loops.find(([cols]) => cols.includes(name));

    const asmL = getLoop('_pdbx_struct_assembly_gen.assembly_id');
    const operL = getLoop('_pdbx_struct_oper_list.id');

    if (!asmL) return null;

    // Build operator map {id -> {R,t}}
    const opMap = new Map();
    if (operL) {
        const opCols = operL[0];
        const opRows = operL[1];
        const o = (n) => opCols.indexOf(n);
        for (const r of opRows) {
            const id = (r[o('_pdbx_struct_oper_list.id')] || '').toString();
            const R = [
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][1]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][2]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[1][3]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][1]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][2]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[2][3]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][1]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][2]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.matrix[3][3]')])
            ];
            const t = [
                parseFloat(r[o('_pdbx_struct_oper_list.vector[1]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.vector[2]')]),
                parseFloat(r[o('_pdbx_struct_oper_list.vector[3]')])
            ];
            if (Number.isFinite(R[0])) opMap.set(id, { R, t });
        }
    }
    if (opMap.size === 0) {
        opMap.set('1', { R: [1,0,0, 0,1,0, 0,0,1], t: [0,0,0] });
    }

    // Helpers to compose sequences of operators: Rb*Ra, tb + Rb*ta
    function mulR(Rb, Ra) {
        return [
            Rb[0]*Ra[0] + Rb[1]*Ra[3] + Rb[2]*Ra[6],
            Rb[0]*Ra[1] + Rb[1]*Ra[4] + Rb[2]*Ra[7],
            Rb[0]*Ra[2] + Rb[1]*Ra[5] + Rb[2]*Ra[8],
            Rb[3]*Ra[0] + Rb[4]*Ra[3] + Rb[5]*Ra[6],
            Rb[3]*Ra[1] + Rb[4]*Ra[4] + Rb[5]*Ra[7],
            Rb[3]*Ra[2] + Rb[4]*Ra[5] + Rb[5]*Ra[8],
            Rb[6]*Ra[0] + Rb[7]*Ra[3] + Rb[8]*Ra[6],
            Rb[6]*Ra[1] + Rb[7]*Ra[4] + Rb[8]*Ra[7],
            Rb[6]*Ra[2] + Rb[7]*Ra[5] + Rb[8]*Ra[8],
        ];
    }
    function mulRt(R, t) {
        return [
            R[0]*t[0] + R[1]*t[1] + R[2]*t[2],
            R[3]*t[0] + R[4]*t[1] + R[5]*t[2],
            R[6]*t[0] + R[7]*t[1] + R[8]*t[2],
        ];
    }
    function composeSeq(seq) {
        // Apply operators left-to-right: x' = O_n(...O_2(O_1(x))...)
        let R = [1,0,0, 0,1,0, 0,0,1];
        let t = [0,0,0];
        for (const id of seq) {
            const op = opMap.get(id) || opMap.get('1');
            const Rb = op.R, tb = op.t;
            // new = Rb * (R*x + t) + tb = (Rb*R) x + (Rb*t + tb)
            const R_new = mulR(Rb, R);
            const Rt = mulRt(Rb, t);
            const t_new = [Rt[0] + tb[0], Rt[1] + tb[1], Rt[2] + tb[2]];
            R = R_new;
            t = t_new;
        }
        return { R, t };
    }

    // Choose assembly 1 (or fall back to first row)
    const a = (n) => asmL[0].indexOf(n);
    let candidates = asmL[1].filter(r => (r[a('_pdbx_struct_assembly_gen.assembly_id')] || '') === '1');
    if (candidates.length === 0 && asmL[1].length > 0) candidates = [asmL[1][0]];
    if (candidates.length === 0) return null;

    const chainSet = new Set();
    const operations = [];
    const seenRT = new Set();

    for (const r of candidates) {
        const asymList = (r[a('_pdbx_struct_assembly_gen.asym_id_list')] ||
            r[a('_pdbx_struct_assembly_gen.oper_asym_id_list')] || '').toString();
        const asymIds = asymList.split(',').map(s => s.trim()).filter(Boolean);
        asymIds.forEach(c => chainSet.add(c));

        const operExpr = (r[a('_pdbx_struct_assembly_gen.oper_expression')] || '').toString();
        const seqs = (operExpr && typeof expandOperExpr_light === 'function')
            ? expandOperExpr_light(operExpr) : [['1']];

        for (const seq of seqs) {
            const { R, t } = composeSeq(seq);
            const key = R.map(v => Number.isFinite(v)? v.toFixed(6) : 'nan').join(',') + '|' +
                        t.map(v => Number.isFinite(v)? v.toFixed(6) : 'nan').join(',');
            if (!seenRT.has(key)) {
                seenRT.add(key);
                operations.push({ id: seq.join('*') || '1', R, t, chains: [] });
            }
        }
    }

    const chains = [...chainSet];
    operations.forEach(op => op.chains = chains);
    return operations.length > 0 ? operations : null;
}

/**

 * Extract biounit operations from PDB REMARK 350
 * @param {string} text - PDB text
 * @returns {Array<object>} - Array of {R, t, chains} operations
 */
/**
 * Extract biounit operations from PDB REMARK 350
 * @param {string} text - PDB text
 * @returns {Array<object>|null} - Array of {R, t, chains} operations or null if none found
 */
function extractPDBBiounitOperations(text) {
    // Fast-negative: no REMARK 350? no biounit.
    if (!/REMARK 350/.test(text)) return null;
    const lines = text.split(/\r?\n/);

    let inTargetBio = false;
    const targetBioId = 1;
    const chains = new Set();
    const opRows = {};
    
    for (const L of lines) {
        if (!L.startsWith('REMARK 350')) continue;
        
        if (/REMARK 350\s+BIOMOLECULE:\s*(\d+)/.test(L)) {
            const id = parseInt(L.match(/REMARK 350\s+BIOMOLECULE:\s*(\d+)/)[1], 10);
            inTargetBio = (id === targetBioId);
            continue;
        }
        
        if (!inTargetBio) continue;
        
        if (/:/.test(L) && /(APPLY THE FOLLOWING TO|AND|ALSO)\s+CHAIN[S]?:/i.test(L)) {
            const after = L.split(':')[1] || '';
            after.split(/[, ]+/)
                .map(s => s.replace(/[^A-Za-z0-9]/g, '').trim())
                .filter(Boolean)
                .forEach(c => chains.add(c));
            continue;
        }
        
        if (/REMARK 350\s+BIOMT[123]/.test(L)) {
            const rowChar = L.substring(18, 19);
            const rowNum = parseInt(rowChar, 10);
            const opIdx = parseInt(L.substring(19, 24), 10);
            if (!(rowNum >= 1 && rowNum <= 3) || isNaN(opIdx)) continue;
            
            const a1 = parseFloat(L.substring(23, 33));
            const a2 = parseFloat(L.substring(33, 43));
            const a3 = parseFloat(L.substring(43, 53));
            const t = parseFloat(L.substring(53, 68));
            if ([a1, a2, a3, t].some(v => Number.isNaN(v))) continue;
            
            const row = [a1, a2, a3, t];
            opRows[opIdx] = opRows[opIdx] || [null, null, null];
            opRows[opIdx][rowNum - 1] = row;
        }
    }
    
    const ops = [];
    Object.keys(opRows).forEach(k => {
        const r = opRows[k];
        if (r[0] && r[1] && r[2]) {
            const R = [
                r[0][0], r[0][1], r[0][2],
                r[1][0], r[1][1], r[1][2],
                r[2][0], r[2][1], r[2][2]
            ];
            const t = [r[0][3], r[1][3], r[2][3]];
            ops.push({ id: String(k), R, t, chains: [...chains] });
        }
    });
    
    return ops.length > 0 ? ops : null;
}

/**
 * Apply biounit operations to a single model
 * @param {Array<object>} atoms - Model atoms
 * @param {Array<object>} operations - Biounit operations
 * @returns {Array<object>} - Assembled atoms
 */
function applyBiounitOperationsToModel(atoms, operations) {
    if (operations.length === 0) return atoms;
    
    // Get chains from operations, or use all chains if none specified
    let targetChains = new Set();
    operations.forEach(op => {
        if (op.chains && op.chains.length > 0) {
            op.chains.forEach(c => targetChains.add(c));
        }
    });
    
    if (targetChains.size === 0) {
        // No chains specified, use all
        atoms.forEach(a => {
            if (a.chain) targetChains.add(a.chain);
        });
    }
    
    const out = [];
    for (const op of operations) {
        for (const atom of atoms) {
            if (targetChains.size === 0 || targetChains.has(atom.chain)) {
                const transformed = {
                    ...atom,
                    x: op.R[0] * atom.x + op.R[1] * atom.y + op.R[2] * atom.z + op.t[0],
                    y: op.R[3] * atom.x + op.R[4] * atom.y + op.R[5] * atom.z + op.t[1],
                    z: op.R[6] * atom.x + op.R[7] * atom.y + op.R[8] * atom.z + op.t[2],
                    chain: (op.id === '1') ? 
                        String(atom.chain || '') : 
                        (String(atom.chain || '') + '|' + op.id)
                };
                out.push(transformed);
            }
        }
    }
    
    return out.length > 0 ? out : atoms;
}

function processStructureToTempBatch(text, name, paeData, targetObjectName, tempBatch) {
    let models;
    
    try {
        const wantBU = !!(window.viewerConfig && window.viewerConfig.biounit);
        const isCIF = /^\s*data_/m.test(text) || /_atom_site\./.test(text);
        
        // Parse all models first
        models = isCIF ? parseCIF(text) : parsePDB(text);
        
        if (!models || models.length === 0 || models.every(m => m.length === 0)) {
            throw new Error(`Could not parse any models or atoms from ${name}.`);
        }
        
        // Apply biounit transformation to all models if requested
        if (wantBU && models.length > 0) {
            const startTime = performance.now();
            
            // Fast-negative: only scan for BU if the file hints it's present
const hasBiounitHints = isCIF
    ? /_pdbx_struct_(assembly_gen|oper_list)\./.test(text)
    : /REMARK 350/.test(text);
// Extract operations ONCE for all models
const operations = hasBiounitHints ? extractBiounitOperations(text, isCIF) : null;

            
            if (operations && operations.length > 0) {
                // Apply operations to each model
                models = models.map(modelAtoms => 
                    applyBiounitOperationsToModel(modelAtoms, operations)
                );
                const elapsed = performance.now() - startTime;
            }
            // If no operations found, models stay as-is (no transformation needed)
        }
    } catch (e) {
        console.error("Parsing failed:", e);
        setStatus(`Error: ${e.message}`, true);
        return 0;
    }

    let framesAdded = 0;
    const loadAsFramesCheckbox = document.getElementById('loadAsFramesCheckbox');
    const alignFramesCheckbox = document.getElementById('alignFramesCheckbox');
    const isLoadAsFrames = loadAsFramesCheckbox ? loadAsFramesCheckbox.checked : false;
    const shouldAlign = alignFramesCheckbox ? alignFramesCheckbox.checked : false;

    // Check if object with same name already exists in tempBatch or batchedObjects
    // If it exists, replace it instead of creating a duplicate
    
    let targetObject = tempBatch.find(obj => obj.name === targetObjectName) || null;
    if (!targetObject) {
        // Also check in existing batchedObjects
        const existingIndex = batchedObjects.findIndex(obj => obj.name === targetObjectName);
        if (existingIndex >= 0) {
            // If loading as frames, we want to add to existing object, not replace
            // If not loading as frames, remove existing object to replace with new data
            if (!isLoadAsFrames) {
                batchedObjects.splice(existingIndex, 1);
            }
        }
        targetObject = { name: targetObjectName, frames: [] };
        tempBatch.push(targetObject);
    } else {
        // Object already exists in tempBatch
        // Only clear frames if we're NOT loading as frames (i.e., replacing, not adding)
        if (!isLoadAsFrames) {
            targetObject.frames = [];
            targetObject.hasPAE = false;
        }
        // If loading as frames, keep existing frames and append new ones
    }

    const isTrajectory = (loadAsFramesCheckbox.checked ||
        targetObject.frames.length > 0 ||
        models.length > 1);

    function maybeFilterLigands(atoms) {
        const ignore = !!(window.viewerConfig && window.viewerConfig.ignoreLigands);
        if (!ignore) return atoms;
        
        const proteinResidues = new Set([
            "ALA", "ARG", "ASN", "ASP", "CYS", "GLU", "GLN", "GLY", "HIS", "ILE",
            "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL", "SEC", "PYL"
        ]);
        const nucleicResidues = new Set([
            "A", "C", "G", "U", "T", "DA", "DC", "DG", "DT", "RA", "RC", "RG", "RU"
        ]);
        
        // Group atoms by residue to check for structural characteristics
        const residueMap = new Map();
        for (const atom of atoms) {
            if (!atom) continue;
            const resKey = `${atom.chain}:${atom.resSeq}:${atom.resName}`;
            if (!residueMap.has(resKey)) {
                residueMap.set(resKey, {
                    resName: atom.resName,
                    record: atom.record,
                    atoms: []
                });
            }
            residueMap.get(resKey).atoms.push(atom);
        }
        
        // Check if a residue is a modified standard residue (has backbone atoms)
        function isModifiedStandardResidue(residue) {
            if (residue.record === 'HETATM') {
                const hasCA = residue.atoms.some(a => a.atomName === 'CA');
                const hasC4 = residue.atoms.some(a => a.atomName === "C4'" || a.atomName === "C4*");
                return hasCA || hasC4;
            }
            return false;
        }
        
        return atoms.filter(a => {
            if (!a) return false;
            if (a.record !== 'HETATM') return true;
            if (proteinResidues.has(a.resName) || nucleicResidues.has(a.resName)) return true;
            
            // For HETATM: include if it has backbone atoms (modified residue) or as ligand
            const resKey = `${a.chain}:${a.resSeq}:${a.resName}`;
            const residue = residueMap.get(resKey);
            if (residue && isModifiedStandardResidue(residue)) return true;
            
            // HETATM without backbone atoms are kept as ligands (not filtered)
            return true;
        });
    }

    // ========================================================================
    // STEP 1: Load all frames into memory
    // ========================================================================
    const rawFrames = [];
    for (let i = 0; i < models.length; i++) {
        if (!loadAsFramesCheckbox.checked && i > 0) {
            const modelObjectName = `${targetObjectName}_model_${i + 1}`;
            targetObject = tempBatch.find(obj => obj.name === modelObjectName) || null;
            if (!targetObject) {
                targetObject = { name: modelObjectName, frames: [] };
                tempBatch.push(targetObject);
            }
        }

        // First, convert original model to identify which positions are ligands
        // This is needed to filter PAE matrix correctly
        const originalFrameData = convertParsedToFrameData(models[i]);
        const isLigandPosition = originalFrameData.atom_types ? 
            originalFrameData.atom_types.map(type => type === 'L') : 
            Array(originalFrameData.coords.length).fill(false);
        
        // Filter ligands from model
        const model = maybeFilterLigands(models[i]);
        let frameData = convertParsedToFrameData(model);
        if (frameData.coords.length === 0) continue;

        // Store PAE data
        if (paeData) {
            const ignoreLigands = !!(window.viewerConfig && window.viewerConfig.ignoreLigands);
            if (ignoreLigands && isLigandPosition.length > 0) {
                const filteredPae = [];
                for (let rowIdx = 0; rowIdx < paeData.length; rowIdx++) {
                    if (!isLigandPosition[rowIdx]) {
                        const filteredRow = [];
                        for (let colIdx = 0; colIdx < paeData[rowIdx].length; colIdx++) {
                            if (!isLigandPosition[colIdx]) {
                                filteredRow.push(paeData[rowIdx][colIdx]);
                            }
                        }
                        filteredPae.push(filteredRow);
                    }
                }
                frameData.pae = filteredPae;
            } else {
                frameData.pae = paeData.map(row => [...row]);
            }
            targetObject.hasPAE = true;
        } else {
            frameData.pae = null;
        }

        // Deep copy frame data
        rawFrames.push({
            coords: frameData.coords.map(c => [...c]),
            chains: frameData.chains ? [...frameData.chains] : undefined,
            atom_types: frameData.atom_types ? [...frameData.atom_types] : undefined,
            plddts: frameData.plddts ? [...frameData.plddts] : undefined,
            residues: frameData.residues ? [...frameData.residues] : undefined,
            residue_index: frameData.residue_index ? [...frameData.residue_index] : undefined,
            pae: frameData.pae
        });
    }

    if (rawFrames.length === 0) {
        setStatus(`Warning: Found models, but no backbone atoms in ${name}.`, true);
        return 0;
    }

    // ========================================================================
    // STEP 2: Align each new frame to the first frame (if alignment is enabled)
    // ========================================================================
    // When loading as frames, targetObject.frames already contains previous frames
    // We need to align new frames (rawFrames) to the first frame in targetObject.frames
    if (isTrajectory && shouldAlign) {
        // Determine reference frame: first frame in targetObject (if exists) or first in rawFrames
        const referenceFrames = targetObject.frames.length > 0 ? targetObject.frames : rawFrames;
        const firstFrame = referenceFrames[0];
        
        if (firstFrame && rawFrames.length > 0) {
            // Determine which chain to use for alignment (use first available chain from reference frame)
            let alignmentChainId = null;
            if (firstFrame.chains && firstFrame.chains.length > 0) {
                // Find first non-empty chain ID
                for (let j = 0; j < firstFrame.chains.length; j++) {
                    const chainId = firstFrame.chains[j];
                    if (chainId && chainId.trim() !== '') {
                        alignmentChainId = chainId;
                        break;
                    }
                }
            }
            
            // Extract alignment coordinates from reference frame (first frame)
            const firstFrameAlignCoords = [];
            if (alignmentChainId !== null) {
                for (let j = 0; j < firstFrame.coords.length; j++) {
                    if (firstFrame.chains && firstFrame.chains[j] === alignmentChainId) {
                        firstFrameAlignCoords.push([...firstFrame.coords[j]]); // Copy array
                    }
                }
            } else {
                // No chain information - use all atoms from reference frame
                for (let j = 0; j < firstFrame.coords.length; j++) {
                    firstFrameAlignCoords.push([...firstFrame.coords[j]]); // Copy array
                }
            }
            
            // Align each new frame in rawFrames to the reference frame
            for (let i = 0; i < rawFrames.length; i++) {
                const currFrame = rawFrames[i];
                
                // Extract alignment coordinates from current frame
                const currFrameAlignCoords = [];
                if (alignmentChainId !== null) {
                    for (let j = 0; j < currFrame.coords.length; j++) {
                        if (currFrame.chains && currFrame.chains[j] === alignmentChainId) {
                            currFrameAlignCoords.push([...currFrame.coords[j]]); // Copy array
                        }
                    }
                } else {
                    // No chain information - use all atoms
                    for (let j = 0; j < currFrame.coords.length; j++) {
                        currFrameAlignCoords.push([...currFrame.coords[j]]); // Copy array
                    }
                }
                
                // Only align if we have matching coordinate counts
                if (firstFrameAlignCoords.length > 0 && 
                    currFrameAlignCoords.length > 0 && 
                    firstFrameAlignCoords.length === currFrameAlignCoords.length) {
                    try {
                        // Align current frame to reference frame
                        const alignedCoords = align_a_to_b(
                            currFrame.coords,           // All coordinates of current frame
                            currFrameAlignCoords,       // Alignment subset of current frame
                            firstFrameAlignCoords       // Alignment subset of reference frame
                        );
                        
                        // Update all coordinates in the frame
                        for (let k = 0; k < currFrame.coords.length; k++) {
                            currFrame.coords[k][0] = alignedCoords[k][0];
                            currFrame.coords[k][1] = alignedCoords[k][1];
                            currFrame.coords[k][2] = alignedCoords[k][2];
                        }
                    } catch (e) {
                        console.error(`Alignment failed for frame ${targetObject.frames.length + i + 1} of ${targetObjectName}:`, e);
                        setStatus(
                            `Warning: Alignment failed for frame ${targetObject.frames.length + i + 1} in ${targetObjectName}. See console.`,
                            true
                        );
                    }
                } else if (firstFrameAlignCoords.length !== currFrameAlignCoords.length) {
                    // Chain length mismatch - log warning
                    console.warn(
                        `Alignment skipped for frame ${targetObject.frames.length + i + 1} of ${targetObjectName}: ` +
                        `chain length mismatch (reference: ${firstFrameAlignCoords.length}, frame: ${currFrameAlignCoords.length})`
                    );
                }
            }
        }
    }

    // ========================================================================
    // STEP 3: Center each frame based on first available chain
    // ========================================================================
    // Determine which chain to use for centering
    let centeringChainId = null;
    if (rawFrames.length > 0 && rawFrames[0].chains && rawFrames[0].chains.length > 0) {
        // Find first non-empty chain ID
        for (let j = 0; j < rawFrames[0].chains.length; j++) {
            const chainId = rawFrames[0].chains[j];
            if (chainId && chainId.trim() !== '') {
                centeringChainId = chainId;
                break;
            }
        }
    }
    
    for (let i = 0; i < rawFrames.length; i++) {
        const frame = rawFrames[i];
        
        // Extract centering chain coordinates
        const centeringCoords = [];
        if (centeringChainId !== null) {
            for (let j = 0; j < frame.coords.length; j++) {
                if (frame.chains && frame.chains[j] === centeringChainId) {
                    centeringCoords.push(frame.coords[j]);
                }
            }
        } else {
            // No chain information - use all atoms for centering
            for (let j = 0; j < frame.coords.length; j++) {
                centeringCoords.push(frame.coords[j]);
            }
        }
        
        if (centeringCoords.length > 0) {
            // Compute center of centering chain (or all atoms)
            const center = [0, 0, 0];
            for (const coord of centeringCoords) {
                center[0] += coord[0];
                center[1] += coord[1];
                center[2] += coord[2];
            }
            center[0] /= centeringCoords.length;
            center[1] /= centeringCoords.length;
            center[2] /= centeringCoords.length;
            
            // Subtract center from all coordinates
            for (const coord of frame.coords) {
                coord[0] -= center[0];
                coord[1] -= center[1];
                coord[2] -= center[2];
            }
        }
    }

    // ========================================================================
    // STEP 4: Add processed frames to targetObject
    // ========================================================================
    for (const rawFrame of rawFrames) {
        targetObject.frames.push(rawFrame);
        framesAdded++;
    }

    if (framesAdded === 0) {
        setStatus(`Warning: Found models, but no backbone atoms in ${name}.`, true);
    }

    return framesAdded;
}

function updateViewerFromGlobalBatch() {
    const viewerContainer = document.getElementById('viewer-container');
    const topPanelContainer = document.getElementById('top-panel-container');
    const objectSelect = document.getElementById('objectSelect');
    
    viewerApi.handlePythonClearAll();
    objectsWithPAE = new Set();
    objectSelect.innerHTML = '';

    if (!viewerApi || batchedObjects.length === 0) {
        viewerContainer.style.display = 'none';
        setStatus("Ready. Upload a file or fetch an ID.");
        return;
    }

    let totalFrames = 0;
    let lastObjectName = null;

    for (const obj of batchedObjects) {
        if (obj.frames.length > 0) {
            viewerApi.handlePythonNewObject(obj.name);
            lastObjectName = obj.name;
            for (const frame of obj.frames) {
                viewerApi.handlePythonUpdate(JSON.stringify(frame), obj.name);
                totalFrames++;
            }
            if (obj.hasPAE) objectsWithPAE.add(obj.name);
        }
    }
    
    if (batchedObjects.length > 0) {
        viewerContainer.style.display = 'flex';
        topPanelContainer.style.display = 'block';
        
        if (lastObjectName) {
            // Set object directly in renderer first
            if (viewerApi && viewerApi.renderer) {
                viewerApi.renderer.currentObjectName = lastObjectName;
                // Set frame data without rendering - just load the data
                const object = viewerApi.renderer.objectsData[lastObjectName];
                if (object && object.frames.length > 0) {
                    viewerApi.renderer.currentFrame = 0;
                    viewerApi.renderer._loadFrameData(0, true); // Load without render
                    viewerApi.renderer.lastRenderedFrame = 0;
                }
            }
            
            // Now set the select value (this will trigger change event, but we've already set everything up)
            objectSelect.value = lastObjectName;
            handleObjectChange();
            updateObjectNavigationButtons();
            buildSequenceView();
            updateChainSelectionUI(); // This sets up default selection and calls applySelection
            
            // Update UI controls
            if (viewerApi && viewerApi.renderer) {
                viewerApi.renderer.updateUIControls();
            }
            
            // Auto-orient to the newly loaded object (no animation for initial load)
            // This will render after orient is complete
            if (viewerApi && viewerApi.renderer && viewerApi.renderer.currentObjectName === lastObjectName) {
                const object = viewerApi.renderer.objectsData[lastObjectName];
                if (object && object.frames.length > 0) {
                    applyBestViewRotation(false); // Skip animation for initial orient, renders after
                }
            }
        }
    } else {
        setStatus("Error: No valid structures were loaded to display.", true);
        viewerContainer.style.display = 'none';
    }
}


function updateChainSelectionUI() {
  /* [EDIT] This function no longer builds UI (pills). 
     It just sets the default selected state. */

  const objectName = viewerApi?.renderer?.currentObjectName;
  if (!objectName || !viewerApi?.renderer) return;

  const obj = viewerApi.renderer.objectsData[objectName];
  if (!obj?.frames?.length) return;
  const frame0 = obj.frames[0];
  if (!frame0?.residue_index || !frame0?.chains) return;

  // Select all by default using renderer API (use atoms, not residues)
  const allAtoms = new Set();
  const allChains = new Set();
  for (let i = 0; i < frame0.chains.length; i++) {
    allAtoms.add(i); // One atom = one position
    allChains.add(frame0.chains[i]);
  }

  viewerApi.renderer.setSelection({
    atoms: allAtoms,
    chains: allChains,
    selectionMode: 'default'
  });
}

function setChainResiduesSelected(chain, selected) {
  if (!viewerApi?.renderer) return;
  const current = viewerApi.renderer.getSelection();
  const objectName = viewerApi.renderer.currentObjectName;
  if (!objectName) return;
  
  const obj = viewerApi.renderer.objectsData[objectName];
  if (!obj?.frames?.length) return;
  const frame0 = obj.frames[0];
  if (!frame0?.residue_index || !frame0?.chains) return;

  // Get all available chains
  const allChains = new Set(frame0.chains);
  
  // Determine current chain selection
  // If chains.size === 0 and mode is 'default', all chains are selected
  let currentChains = new Set(current.chains);
  if (currentChains.size === 0 && current.selectionMode === 'default') {
    currentChains = new Set(allChains);
  }
  
  const newChains = new Set(currentChains);
  
  // Preserve existing atom selections, but add/remove atoms when toggling chains
  const newAtoms = new Set(current.atoms);
  
  if (selected) {
    newChains.add(chain);
    // When selecting a chain, add all atoms from that chain
    // This preserves existing atom selections from other chains
    for (let i = 0; i < frame0.chains.length; i++) {
      if (frame0.chains[i] === chain) {
        newAtoms.add(i); // Add atom (Set.add is idempotent, so safe)
      }
    }
  } else {
    newChains.delete(chain);
    // When deselecting a chain, remove all atoms from that chain
    // This preserves atom selections from other chains
    for (let i = 0; i < frame0.chains.length; i++) {
      if (frame0.chains[i] === chain) {
        newAtoms.delete(i);
      }
    }
  }
  
  // Determine selection mode
  // If we have explicit atom selections (partial selections), always use 'explicit' mode
  // to preserve the partial selections. Only use 'default' if we have no atom selections
  // and all chains are selected.
  const allChainsSelected = newChains.size === allChains.size && 
                            Array.from(newChains).every(c => allChains.has(c));
  const hasPartialSelections = newAtoms.size > 0 && 
                               newAtoms.size < frame0.chains.length;
  
  // Use explicit mode if we have partial selections OR if not all chains are selected
  const selectionMode = (allChainsSelected && !hasPartialSelections) ? 'default' : 'explicit';
  
  // If all chains are selected AND no partial selections, use empty chains set with default mode
  // Otherwise, keep explicit chain selection to preserve partial atom selections
  const chainsToSet = (allChainsSelected && !hasPartialSelections) ? new Set() : newChains;
  
  viewerApi.renderer.setSelection({ 
    chains: chainsToSet,
    atoms: newAtoms, // Preserve existing atom selections
    selectionMode: selectionMode,
    paeBoxes: []  // Clear PAE boxes when editing chain selection
  });
  // Event listener will update UI, no need to call applySelection()
}

/** Alt-click a chain label to toggle selection of all atoms in that chain */
function toggleChainResidues(chain) {
    if (!viewerApi?.renderer) return;
    const objectName = viewerApi.renderer.currentObjectName;
    if (!objectName) return;
    const obj = viewerApi.renderer.objectsData[objectName];
    if (!obj?.frames?.length) return;
    const frame = obj.frames[0];
    if (!frame?.chains) return;

    const current = viewerApi.renderer.getSelection();
    const chainAtomIndices = [];
    for (let i = 0; i < frame.chains.length; i++) {
        if (frame.chains[i] === chain) {
            chainAtomIndices.push(i);
        }
    }
    const allSelected = chainAtomIndices.length > 0 && chainAtomIndices.every(atomIdx => current.atoms.has(atomIdx));
    
    const newAtoms = new Set(current.atoms);
    chainAtomIndices.forEach(atomIdx => {
        if (allSelected) newAtoms.delete(atomIdx);
        else newAtoms.add(atomIdx);
    });
    
    // When toggling atoms, we need to update chains to include all chains that have selected atoms
    // to prevent the chain filter from hiding atoms we just selected
    const newChains = new Set();
    for (const atomIdx of newAtoms) {
        const atomChain = frame.chains[atomIdx];
        if (atomChain) {
            newChains.add(atomChain);
        }
    }
    
    // Determine if we have partial selections (not all atoms from all chains)
    const hasPartialSelections = newAtoms.size > 0 && newAtoms.size < frame.chains.length;
    
    viewerApi.renderer.setSelection({ 
        atoms: newAtoms,
        chains: newChains,
        selectionMode: hasPartialSelections ? 'explicit' : 'default',
        paeBoxes: []  // Clear PAE boxes when editing sequence
    });
}

// [NEW] This function updates the chain buttons and sequence view
// based on the renderer's selection model
function syncChainPillsToSelection() {
    // Chain buttons are now HTML elements, update them via updateSequenceViewSelectionState
    if (sequenceHTMLData) {
        lastSequenceUpdateHash = null; // Force redraw
        updateSequenceViewSelectionState();
    }
}

function applySelection(previewAtoms = null) {
  if (!viewerApi || !viewerApi.renderer) return;

  const objectName = viewerApi.renderer.currentObjectName;
  if (!objectName) {
    if (viewerApi.renderer.resetSelection) {
      viewerApi.renderer.resetSelection();
    } else {
    viewerApi.renderer.visibilityMask = null;
    viewerApi.renderer.render();
    }
    return;
  }

  // Get current selection
  const current = viewerApi.renderer.getSelection();
  
  // Get visible chains from selection model (chain buttons are now on canvas)
  let visibleChains = current?.chains || new Set();
  // If in default mode with no explicit chains, all chains are visible
  if (current?.selectionMode === 'default' && (!current.chains || current.chains.size === 0)) {
    // Get all chains from renderer
    if (viewerApi.renderer.chains) {
      visibleChains = new Set(viewerApi.renderer.chains);
    }
  }

  // Use preview selection if provided, otherwise use current selection
  const atomsToUse = previewAtoms !== null ? previewAtoms : current.atoms;

  viewerApi.renderer.setSelection({
    atoms: atomsToUse,
    chains: visibleChains
    // Keep current PAE boxes and mode
  });
  
  // Note: updateSequenceViewSelectionState will be called via event listener
}


function highlightResidue(chain, residueIndex) {
    // Legacy function - use highlightAtom instead
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedResidue = { chain, residueIndex };
        viewerApi.renderer.highlightedAtom = null; // Clear atom highlight when using legacy
        viewerApi.renderer.render();
    }
}

function highlightAtom(atomIndex) {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedAtom = atomIndex;
        viewerApi.renderer.highlightedAtoms = null; // Clear multi-atom highlight
        viewerApi.renderer.highlightedResidue = null; // Clear legacy highlight
        viewerApi.renderer.render();
    }
}

function highlightAtoms(atomIndices) {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedAtoms = atomIndices instanceof Set ? atomIndices : new Set(atomIndices);
        viewerApi.renderer.highlightedAtom = null; // Clear single atom highlight
        viewerApi.renderer.highlightedResidue = null; // Clear legacy highlight
        viewerApi.renderer.render();
    }
}

function clearHighlight() {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedResidue = null;
        viewerApi.renderer.highlightedAtom = null;
        viewerApi.renderer.highlightedAtoms = null;
        viewerApi.renderer.render();
    }
}

function selectAllResidues() {
  if (!viewerApi?.renderer) return;
  // Reset to default (all residues/chains) - this also clears PAE boxes
  viewerApi.renderer.resetToDefault();
  // UI will update via event listener
}

function clearAllResidues() {
  if (!viewerApi?.renderer) return;
  // Use renderer's clearSelection method
  viewerApi.renderer.clearSelection();
  // UI will update via event listener
}

function clearAllObjects() {
    // Clear all batched objects
    batchedObjects = [];
    
    // Clear PAE tracking
    objectsWithPAE = new Set();
    
    // Hide viewer and top panel
    const viewerContainer = document.getElementById('viewer-container');
    const topPanelContainer = document.getElementById('top-panel-container');
    if (viewerContainer) {
        viewerContainer.style.display = 'none';
    }
    if (topPanelContainer) {
        topPanelContainer.style.display = 'none';
    }
    
    // Use viewer's comprehensive reset method
    if (viewerApi && viewerApi.handlePythonResetAll) {
        try {
            viewerApi.handlePythonResetAll();
            // Reset status message
            setStatus("Ready. Upload a file or fetch an ID.");
        } catch (e) {
            console.error("Failed to reset viewer:", e);
            setStatus("Error: Failed to reset viewer. See console.", true);
        }
    } else if (viewerApi && viewerApi.renderer) {
        // Fallback: use renderer method directly
        try {
            viewerApi.renderer.resetAll();
            // Reset status message
            setStatus("Ready. Upload a file or fetch an ID.");
        } catch (e) {
            console.error("Failed to reset viewer:", e);
            setStatus("Error: Failed to reset viewer. See console.", true);
        }
    } else {
        // No viewer initialized yet, just reset status
        setStatus("Ready. Upload a file or fetch an ID.");
    }
}

// HTML-based sequence renderer data
let sequenceHTMLData = null; // Unified structure: { unifiedContainer, allResidues, chainBoundaries, charsPerLine, mode, sideChainButtons }

// Sequence view mode state
// If false: show only chain labels (inline)
// If true: show both chain labels (inline) and sequence
let sequenceViewMode = false;  // Default: show only chain labels

function buildSequenceView() {
    const sequenceViewEl = document.getElementById('sequenceView');
    if (!sequenceViewEl) return;

    // Clear cache when rebuilding
    cachedSequenceSpans = null;
    lastSequenceUpdateHash = null;
    sequenceHTMLData = null;

    sequenceViewEl.innerHTML = '';

    // Get object name from dropdown first, fallback to renderer's currentObjectName
    const objectSelect = document.getElementById('objectSelect');
    const objectName = objectSelect?.value || viewerApi?.renderer?.currentObjectName;
    if (!objectName || !viewerApi?.renderer) return;

    const object = viewerApi.renderer.objectsData[objectName];
    if (!object || !object.frames || object.frames.length === 0) return;

    const firstFrame = object.frames[0];
    if (!firstFrame || !firstFrame.residues) return;

    const { residues, residue_index, chains, atom_types } = firstFrame;

    // Create one entry per atom (one atom = one position, no collapsing)
    const atomEntries = [];
    for (let i = 0; i < residues.length; i++) {
        atomEntries.push({
            chain: chains[i],
            resName: residues[i],
            resSeq: residue_index[i],
            atomIndex: i, // Direct atom index
            atomType: atom_types && atom_types[i] ? atom_types[i] : 'P' // Store atom type
        });
    }

    // Sort by chain, then by atom index (maintains order within chain) - UNIFIED ORDER
    const sortedAtomEntries = atomEntries.sort((a, b) => {
        if (a.chain < b.chain) return -1;
        if (a.chain > b.chain) return 1;
        return a.atomIndex - b.atomIndex;
    });
    
    // Track chain boundaries for unified sequence
    const chainBoundaries = [];
    let currentChain = null;
    let chainStart = 0;
    for (let i = 0; i < sortedAtomEntries.length; i++) {
        if (sortedAtomEntries[i].chain !== currentChain) {
            if (currentChain !== null) {
                chainBoundaries.push({
                    chain: currentChain,
                    startIndex: chainStart,
                    endIndex: i - 1
                });
            }
            currentChain = sortedAtomEntries[i].chain;
            chainStart = i;
        }
    }
    // Add last chain
    if (currentChain !== null) {
        chainBoundaries.push({
            chain: currentChain,
            startIndex: chainStart,
            endIndex: sortedAtomEntries.length - 1
        });
    }

    // Protein amino acid mapping (3-letter to 1-letter)
    const threeToOne = {
        'ALA':'A', 'ARG':'R', 'ASN':'N', 'ASP':'D', 'CYS':'C', 'GLU':'E', 'GLN':'Q', 'GLY':'G', 'HIS':'H', 'ILE':'I',
        'LEU':'L', 'LYS':'K', 'MET':'M', 'PHE':'F', 'PRO':'P', 'SER':'S', 'THR':'T', 'TRP':'W', 'TYR':'Y', 'VAL':'V',
        'SEC':'U', 'PYL':'O'
    };

    // DNA nucleotide mapping
    const dnaMapping = {
        'DA':'A', 'DT':'T', 'DC':'C', 'DG':'G',
        'A':'A', 'T':'T', 'C':'C', 'G':'G',  // Alternative naming
        'ADE':'A', 'THY':'T', 'CYT':'C', 'GUA':'G'  // Alternative naming
    };
    
    // RNA nucleotide mapping
    const rnaMapping = {
        'A':'A', 'U':'U', 'C':'C', 'G':'G',
        'RA':'A', 'RU':'U', 'RC':'C', 'RG':'G',  // Alternative naming
        'ADE':'A', 'URA':'U', 'CYT':'C', 'GUA':'G',  // Alternative naming
        'URI':'U', 'UMP':'U', 'URD':'U',  // Uridine variations
        'RURA':'U', 'RURI':'U'  // More RNA uracil variations
    };
    
    // Detect sequence type based on residue names
    const detectSequenceType = (residues) => {
        if (residues.length === 0) return 'protein';
        
        let dnaCount = 0;
        let rnaCount = 0;
        let proteinCount = 0;
        
        // First pass: check for unambiguous indicators (U = RNA, T/DT = DNA)
        let hasU = false;
        let hasT = false;
        
        for (const resName of residues) {
            const upperResName = (resName || '').toString().trim().toUpperCase();
            
            // RNA-specific: U is RNA-only
            if (upperResName === 'U' || upperResName.startsWith('RU') || upperResName.includes('URI') || upperResName.includes('URA')) {
                hasU = true;
                rnaCount++;
            }
            // DNA-specific: T or DT is DNA-only
            else if (upperResName === 'T' || upperResName === 'DT' || upperResName.startsWith('DT')) {
                hasT = true;
                dnaCount++;
            }
            // Check mappings (A, C, G are in both)
            else if (dnaMapping[upperResName]) {
                dnaCount++;
            }
            else if (rnaMapping[upperResName]) {
                rnaCount++;
            }
            // Check protein
            else if (threeToOne[upperResName]) {
                proteinCount++;
            }
        }
        
        // If we found U (RNA-specific) and no T, it's definitely RNA
        if (hasU && !hasT) {
            return 'rna';
        }
        // If we found T/DT (DNA-specific) and no U, it's DNA
        if (hasT && !hasU) {
            return 'dna';
        }
        
        // Otherwise, determine type based on majority
        if (dnaCount > rnaCount && dnaCount > proteinCount) {
            return 'dna';
        } else if (rnaCount > dnaCount && rnaCount > proteinCount) {
            return 'rna';
        } else {
            return 'protein';
        }
    };
    
    // Build chain-to-sequence-type mapping for unified sequence
    const chainSequenceTypes = {};
    for (const boundary of chainBoundaries) {
        const chainResidues = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
        const chainResidueNames = chainResidues.map(r => r.resName);
        chainSequenceTypes[boundary.chain] = detectSequenceType(chainResidueNames);
    }
    
    // Helper function to get residue letter based on chain's sequence type
    const getResidueLetter = (atom) => {
        const chainType = chainSequenceTypes[atom.chain] || 'protein';
        const upper = (atom.resName || '').toString().trim().toUpperCase();
        
        if (chainType === 'dna') {
            return dnaMapping[upper] || 'N';
        } else if (chainType === 'rna') {
            if (rnaMapping[upper]) return rnaMapping[upper];
            if (upper === 'U') return 'U';
            if (upper.includes('U') || upper.includes('URI') || upper.includes('URA')) return 'U';
            if (upper.includes('A') && !upper.includes('D')) return 'A';
            if (upper.includes('C') && !upper.includes('D')) return 'C';
            if (upper.includes('G') && !upper.includes('D')) return 'G';
            return 'N';
        } else {
            return threeToOne[upper] || 'X';
        }
    };
    
    // Helper function to create inline chain label
    const createChainLabel = (chainId, atomIndex, fixedWidth) => {
        const label = document.createElement('span');
        label.className = 'chain-label';
        label.textContent = chainId;
        label.dataset.chain = chainId;
        label.dataset.atomIndex = atomIndex;
        label.style.display = 'block'; // Use block to avoid inline alignment issues
        label.style.width = fixedWidth + 'px'; // Fixed width for all buttons
        label.style.boxSizing = 'border-box';
        label.style.borderBottom = '1px solid transparent'; // Always reserve border space to prevent jumping
        label.style.height = charHeight + 'px'; // Same height as sequence characters (border included in height)
        label.style.textAlign = 'center';
        label.style.lineHeight = (charHeight - 1) + 'px'; // Line height excludes border (1px)
        label.style.fontSize = '12px';
        label.style.fontFamily = 'monospace';
        label.style.cursor = 'pointer';
        label.style.userSelect = 'none';
        label.style.padding = '0 ' + Math.round(10 * 2 / 3) + 'px'; // Scaled horizontal padding (2/3 of original)
        label.style.margin = '0'; // No margins
        
        // Get chain color and apply
        const chainColor = renderer?.getChainColorForChainId?.(chainId) || {r: 128, g: 128, b: 128};
        const current = viewerApi?.renderer?.getSelection();
        const isSelected = current?.chains?.has(chainId) || 
            (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
        
        if (isSelected) {
            label.style.backgroundColor = `rgb(${chainColor.r}, ${chainColor.g}, ${chainColor.b})`;
            // Calculate contrast color
            const luminance = (0.299 * chainColor.r + 0.587 * chainColor.g + 0.114 * chainColor.b) / 255;
            label.style.color = luminance > 0.5 ? '#000000' : '#ffffff';
            label.style.borderBottom = '1px solid #000000'; // Add black border when selected
        } else {
            // Dim unselected chains
            const dimmed = {
                r: Math.round(chainColor.r * 0.3 + 255 * 0.7),
                g: Math.round(chainColor.g * 0.3 + 255 * 0.7),
                b: Math.round(chainColor.b * 0.3 + 255 * 0.7)
            };
            label.style.backgroundColor = `rgb(${dimmed.r}, ${dimmed.g}, ${dimmed.b})`;
            label.style.color = '#000000';
            label.style.borderBottom = '1px solid transparent'; // Keep border space to prevent jumping
        }
        
        // Click handler (only in sequence mode - in chain mode, drag selection is handled by table mousedown)
        if (sequenceViewMode) {
            label.addEventListener('click', (e) => {
                const current = viewerApi?.renderer?.getSelection();
                const isSelected = current?.chains?.has(chainId) || 
                    (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
                if (e.altKey) {
                    toggleChainResidues(chainId);
                } else {
                    setChainResiduesSelected(chainId, !isSelected);
                }
                lastSequenceUpdateHash = null;
                updateSequenceViewSelectionState();
            });
        }
        
        return label;
    };

    // HTML text rendering settings
    const charWidth = 10; // Monospace character width
    const charHeight = 14; // Line height
    
    // Chain button uses same dimensions as sequence characters
    // Find the maximum chain ID length to make all buttons the same size
    const maxChainIdLength = Math.max(...chainBoundaries.map(b => b.chain.length), 3);
    const chainButtonWidth = (charWidth * maxChainIdLength + 20) * 2 / 3; // Fixed width for all buttons (2/3 of original size)
    
    // Calculate dynamic line breaks based on container width
    const containerWidth = sequenceViewEl ? sequenceViewEl.offsetWidth || 900 : 900;
    const sequenceWidth = containerWidth;
    const charsPerLine = Math.floor(sequenceWidth / charWidth);

    const fragment = document.createDocumentFragment();
    const renderer = viewerApi?.renderer;
    const hasGetAtomColor = renderer?.getAtomColor;
    
    // Create table for sequence display
    const table = document.createElement('table');
    table.style.borderCollapse = 'separate'; // Use separate to allow border-spacing
    table.style.borderSpacing = '4px'; // 4px spacing in all directions (rows and columns)
    table.style.width = '100%';
    table.style.fontFamily = 'monospace';
    table.style.fontSize = '12px';
    table.style.verticalAlign = 'top'; // Align table to top
    
    // Store all residue elements
    const allResidues = [];
    
    if (sequenceViewMode) {
        // SEQUENCE MODE: One row per chain
        // <tr><td>chain</td><td>sequence</td></tr>
        
        for (const boundary of chainBoundaries) {
            const chainId = boundary.chain;
            const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
            
            const row = document.createElement('tr');
            row.style.verticalAlign = 'top'; // Align row to top
            row.style.margin = '0';
            row.style.padding = '0';
            
            // Chain label cell
            const chainCell = document.createElement('td');
            chainCell.style.verticalAlign = 'top';
            chainCell.style.padding = '0';
            chainCell.style.margin = '0';
            chainCell.style.border = 'none';
            // Set width to match actual button width (button width + scaled padding)
            const actualButtonWidth = chainButtonWidth + Math.round(4 * 2 / 3); // Button width + scaled padding (2/3 of original)
            chainCell.style.width = actualButtonWidth + 'px';
            const chainLabel = createChainLabel(chainId, chainAtoms[0].atomIndex, chainButtonWidth);
            chainCell.appendChild(chainLabel);
            row.appendChild(chainCell);
            
            // Sequence cell
            const seqCell = document.createElement('td');
            seqCell.style.verticalAlign = 'top';
            seqCell.style.padding = '0';
            seqCell.style.margin = '0';
            seqCell.style.border = 'none';
            seqCell.style.cursor = 'crosshair';
            seqCell.style.display = 'flex';
            seqCell.style.flexWrap = 'wrap';
            seqCell.style.gap = '0';
            seqCell.style.lineHeight = charHeight + 'px'; // Set line height on container
            seqCell.style.alignItems = 'flex-start'; // Align items to top
            seqCell.style.alignContent = 'flex-start'; // Align wrapped lines to top
            seqCell.style.width = '100%'; // Ensure cell takes full width for proper wrapping
            
            // Build sequence for this chain
            let charCount = 0;
            let lastResSeq = null;
            let lastAtomType = null;
            
            for (let i = 0; i < chainAtoms.length; i++) {
                const atom = chainAtoms[i];
                
                // Add spacing/gaps (same logic as before)
                if (i > 0) {
                    const prevAtom = chainAtoms[i - 1];
                    const atomTypeChanged = prevAtom.atomType !== atom.atomType;
                    const ligandResSeqChanged = atom.atomType === 'L' && prevAtom.atomType === 'L' && prevAtom.resSeq !== atom.resSeq;
                    const sameAtomType = prevAtom.atomType === atom.atomType;
                    const resSeqDiff = atom.resSeq - prevAtom.resSeq;
                    const resSeqChanged = atom.resSeq !== prevAtom.resSeq;
                    const isChainBreak = sameAtomType && 
                                         resSeqChanged &&
                                         (prevAtom.atomType === 'P' || prevAtom.atomType === 'D' || prevAtom.atomType === 'R') &&
                                         resSeqDiff > 1;
                    
                    if (atomTypeChanged || ligandResSeqChanged) {
                        const spacer = document.createElement('span');
                        spacer.style.display = 'inline-block';
                        spacer.style.width = charWidth + 'px';
                        spacer.style.height = charHeight + 'px';
                        seqCell.appendChild(spacer);
                    } else if (isChainBreak) {
                        const numMissingResidues = resSeqDiff - 1;
                        for (let g = 0; g < numMissingResidues; g++) {
                            const gapSpan = document.createElement('span');
                            gapSpan.className = 'residue-char';
                            gapSpan.textContent = '-';
                            gapSpan.style.display = 'inline-block';
                            gapSpan.style.width = charWidth + 'px';
                            gapSpan.style.height = charHeight + 'px';
                            gapSpan.style.textAlign = 'center';
                            gapSpan.style.lineHeight = charHeight + 'px';
                            gapSpan.style.verticalAlign = 'middle';
                            gapSpan.style.color = '#666666';
                            gapSpan.style.backgroundColor = '#f0f0f0';
                            gapSpan.style.userSelect = 'none';
                            gapSpan.style.boxSizing = 'border-box';
                            gapSpan.style.borderBottom = 'none';
                            seqCell.appendChild(gapSpan);
                            charCount++;
                            // Let flexbox handle wrapping automatically - no manual line breaks
                        }
                    }
                }
                
                // Update tracking
                lastResSeq = atom.resSeq;
                lastAtomType = atom.atomType;
                
                // Get letter and color
                const letter = getResidueLetter(atom);
                let color = { r: 80, g: 80, b: 80 };
                if (hasGetAtomColor && !Number.isNaN(atom.atomIndex)) {
                    color = renderer.getAtomColor(atom.atomIndex);
                }
                
                // Create atom span
                const span = document.createElement('span');
                span.className = 'residue-char';
                span.textContent = letter;
                span.dataset.atomIndex = atom.atomIndex;
                span.style.display = 'inline-block';
                span.style.width = charWidth + 'px';
                span.style.height = charHeight + 'px';
                span.style.textAlign = 'center';
                span.style.lineHeight = charHeight + 'px'; // Match height exactly
                span.style.verticalAlign = 'top'; // Align to top to avoid extra space
                span.style.color = '#000000';
                span.style.backgroundColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
                span.style.userSelect = 'none';
                span.style.boxSizing = 'border-box';
                span.style.borderBottom = 'none';
                span.style.margin = '0'; // Remove any default margins
                span.style.padding = '0'; // Remove any default padding
                
                seqCell.appendChild(span);
                charCount++;
                // Let flexbox handle wrapping automatically - no manual line breaks
                
                allResidues.push({
                    element: span,
                    atomIndex: atom.atomIndex,
                    letter,
                    color,
                    resSeq: atom.resSeq,
                    chain: atom.chain
                });
            }
            
            row.appendChild(seqCell);
            table.appendChild(row);
        }
    } else {
        // CHAIN MODE: Inline chain buttons that wrap, with drag selection support
        // Simple flex container with chain labels as inline elements
        
        const row = document.createElement('tr');
        const chainCell = document.createElement('td');
        chainCell.style.verticalAlign = 'top';
        chainCell.style.padding = '0';
        chainCell.style.margin = '0';
        chainCell.style.border = 'none';
        chainCell.style.cursor = 'crosshair'; // Enable drag selection
        chainCell.style.display = 'flex';
        chainCell.style.flexWrap = 'wrap';
        chainCell.style.gap = '4px'; // Small gap between chain buttons
        chainCell.style.alignItems = 'flex-start';
        chainCell.style.alignContent = 'flex-start';
        chainCell.colSpan = 2; // Span both columns (chain and sequence)
        
        // Add chain labels as inline elements
        for (const boundary of chainBoundaries) {
            const chainId = boundary.chain;
            const chainLabel = createChainLabel(chainId, sortedAtomEntries[boundary.startIndex].atomIndex, chainButtonWidth);
            // Make chain labels selectable for drag selection
            chainLabel.style.cursor = 'crosshair';
            chainLabel.dataset.selectable = 'true'; // Mark as selectable for drag selection
            chainCell.appendChild(chainLabel);
        }
        
        row.appendChild(chainCell);
        table.appendChild(row);
    }
    
    fragment.appendChild(table);
    
    sequenceViewEl.appendChild(fragment);
    
    // Store structure
    sequenceHTMLData = {
        table,
        unifiedContainer: table, // For compatibility with event handlers
        allResidues: sequenceViewMode ? allResidues : [], // Only store residues if sequence is shown
        chainBoundaries,
        sortedAtomEntries, // Store for chain mode drag selection
        charsPerLine,
        mode: sequenceViewMode
    };
    
    // Setup HTML event handlers
    setupHTMLSequenceEvents();
    
    updateSequenceViewSelectionState();
}

// HTML-based sequence event handlers using event delegation

function setupHTMLSequenceEvents() {
    if (!sequenceHTMLData) return;
    
    // Store drag state (shared across all chains)
    const dragState = { isDragging: false, dragStart: null, dragEnd: null, hasMoved: false, dragUnselectMode: false };
    
    const { table, allResidues, chainBoundaries, sortedAtomEntries } = sequenceHTMLData;
    
    // Table event delegation (works for both sequence and chain cells)
    table.addEventListener('mousedown', (e) => {
        // In chain mode, allow drag selection on chain labels
        // In sequence mode, chain labels have their own click handlers (toggle chain)
        if (e.target.classList.contains('chain-label')) {
            if (sequenceViewMode) {
                // In sequence mode, chain labels toggle chain selection (existing behavior)
                return; // Let the click handler in createChainLabel handle it
            } else {
                // In chain mode, enable drag selection on chain labels
                const chainLabel = e.target;
                const chainId = chainLabel.dataset.chain;
                const atomIndexStr = chainLabel.dataset.atomIndex;
                
                if (!atomIndexStr) return;
                const atomIndex = parseInt(atomIndexStr);
                if (isNaN(atomIndex)) return;
                
                // Find the chain boundary to get all atoms in this chain
                const boundary = chainBoundaries.find(b => b.chain === chainId);
                if (!boundary) return;
                
                // Get all atoms in this chain
                const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                if (chainAtoms.length === 0) return;
                
                dragState.isDragging = true;
                dragState.hasMoved = false;
                dragState.dragStart = chainAtoms[0];
                dragState.dragEnd = chainAtoms[chainAtoms.length - 1];
                
                const current = viewerApi?.renderer?.getSelection();
                // Determine drag mode: if chain is selected, we're in unselect mode
                dragState.dragUnselectMode = current?.chains?.has(chainId) || 
                    (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
                
                // Don't toggle immediately - wait to see if user drags or just clicks
                // The toggle will happen in mouseup if hasMoved is false
                return;
            }
        }
        
        const span = e.target.closest('.residue-char');
        if (!span) return;
        
        const atomIndexStr = span.dataset.atomIndex;
        if (atomIndexStr === undefined || atomIndexStr === null) return;
        const atomIndex = parseInt(atomIndexStr);
        if (isNaN(atomIndex)) return;
        
        const residue = allResidues.find(r => r.atomIndex === atomIndex);
        if (!residue) return;
        
        dragState.isDragging = true;
        dragState.hasMoved = false;
        dragState.dragStart = residue;
        dragState.dragEnd = residue;
        
        const current = viewerApi?.renderer?.getSelection();
        dragState.dragUnselectMode = current?.atoms?.has(atomIndex) || false;
        
        // Toggle single atom on click
        const newAtoms = new Set(current?.atoms || []);
        if (newAtoms.has(atomIndex)) {
            newAtoms.delete(atomIndex);
        } else {
            newAtoms.add(atomIndex);
        }
        
        // Update chains to include all chains that have selected atoms
        const objectName = viewerApi.renderer.currentObjectName;
        const obj = viewerApi.renderer.objectsData[objectName];
        const frame = obj?.frames?.[0];
        const newChains = new Set();
        if (frame?.chains) {
            for (const atomIdx of newAtoms) {
                const atomChain = frame.chains[atomIdx];
                if (atomChain) {
                    newChains.add(atomChain);
                }
            }
        }
        
        // Determine if we have partial selections
        const totalAtoms = frame?.chains?.length || 0;
        const hasPartialSelections = newAtoms.size > 0 && newAtoms.size < totalAtoms;
        
        // Clear PAE boxes when editing sequence selection
        // (sequence selection is already reflected in PAE via colors)
        viewerApi.renderer.setSelection({ 
            atoms: newAtoms,
            chains: newChains,
            selectionMode: hasPartialSelections ? 'explicit' : 'default',
            paeBoxes: [] 
        });
        // Force update to reflect changes
        lastSequenceUpdateHash = null;
        updateSequenceViewSelectionState();
    });
    
    table.addEventListener('mousemove', (e) => {
        const span = e.target.closest('.residue-char');
        const chainLabel = e.target.closest('.chain-label');
        
        if (!dragState.isDragging) {
            if (span) {
                const atomIndexStr = span.dataset.atomIndex;
                if (atomIndexStr !== undefined && atomIndexStr !== null) {
                    const atomIndex = parseInt(atomIndexStr);
                    if (!isNaN(atomIndex)) {
                        // Use atom index directly for highlighting (works for ligands too)
                        highlightAtom(atomIndex);
                    }
                }
            } else if (chainLabel && !sequenceViewMode) {
                // In chain mode, highlight entire chain on hover
                const chainId = chainLabel.dataset.chain;
                const boundary = chainBoundaries.find(b => b.chain === chainId);
                if (boundary) {
                    const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                    if (chainAtoms.length > 0) {
                        const atomIndices = new Set(chainAtoms.map(a => a.atomIndex));
                        highlightAtoms(atomIndices);
                    }
                }
            } else {
                clearHighlight();
            }
            return;
        }
        
        // Handle drag selection
        if (span) {
            const atomIndexStr = span.dataset.atomIndex;
            if (atomIndexStr === undefined || atomIndexStr === null) return;
            const atomIndex = parseInt(atomIndexStr);
            if (isNaN(atomIndex)) return;
            
            const residue = allResidues.find(r => r.atomIndex === atomIndex);
            if (residue && residue !== dragState.dragEnd) {
                dragState.dragEnd = residue;
                const startIdx = allResidues.findIndex(r => r.atomIndex === dragState.dragStart.atomIndex);
                const endIdx = allResidues.findIndex(r => r.atomIndex === dragState.dragEnd.atomIndex);
                if (startIdx !== -1 && endIdx !== -1) {
                    dragState.hasMoved = true;
                    const [min, max] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
                    const current = viewerApi?.renderer?.getSelection();
                    const newAtoms = new Set(current?.atoms || []);
                    for (let i = min; i <= max; i++) {
                        const res = allResidues[i];
                        if (dragState.dragUnselectMode) {
                            newAtoms.delete(res.atomIndex);
                        } else {
                            newAtoms.add(res.atomIndex);
                        }
                    }
                    previewSelectionSet = newAtoms;
                    lastSequenceUpdateHash = null;
                    updateSequenceViewSelectionState();
                    // Update 3D viewer in real-time during drag
                    applySelection(previewSelectionSet);
                }
            }
        } else if (chainLabel && !sequenceViewMode) {
            // In chain mode, handle drag over chain labels
            const chainId = chainLabel.dataset.chain;
            const boundary = chainBoundaries.find(b => b.chain === chainId);
            if (!boundary) return;
            
            const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
            if (chainAtoms.length === 0) return;
            
            // Find the end chain atom
            const endAtom = chainAtoms[chainAtoms.length - 1];
            if (endAtom && endAtom !== dragState.dragEnd) {
                dragState.dragEnd = endAtom;
                dragState.hasMoved = true;
                
                // Get all atoms from start to end (including all chains in between)
                const startChainId = dragState.dragStart.chain;
                const startBoundary = chainBoundaries.find(b => b.chain === startChainId);
                const endBoundary = boundary;
                
                if (startBoundary && endBoundary) {
                    const startBoundaryIdx = chainBoundaries.findIndex(b => b.chain === startChainId);
                    const endBoundaryIdx = chainBoundaries.findIndex(b => b.chain === chainId);
                    const [minBoundary, maxBoundary] = [Math.min(startBoundaryIdx, endBoundaryIdx), Math.max(startBoundaryIdx, endBoundaryIdx)];
                    
                    const currentSelection = viewerApi?.renderer?.getSelection();
                    const newAtoms = new Set(currentSelection?.atoms || []);
                    
                    // Add all atoms from all chains in the drag range
                    for (let bIdx = minBoundary; bIdx <= maxBoundary; bIdx++) {
                        const b = chainBoundaries[bIdx];
                        const atomsInChain = sortedAtomEntries.slice(b.startIndex, b.endIndex + 1);
                        for (const atom of atomsInChain) {
                            if (dragState.dragUnselectMode) {
                                newAtoms.delete(atom.atomIndex);
                            } else {
                                newAtoms.add(atom.atomIndex);
                            }
                        }
                    }
                    
                    previewSelectionSet = newAtoms;
                    lastSequenceUpdateHash = null;
                    updateSequenceViewSelectionState();
                    
                    // Update 3D viewer in real-time during drag
                    // Calculate chains from selected atoms
                    const objectName = viewerApi.renderer.currentObjectName;
                    const obj = viewerApi.renderer.objectsData[objectName];
                    const frame = obj?.frames?.[0];
                    const newChains = new Set();
                    if (frame?.chains) {
                        for (const atomIdx of newAtoms) {
                            const atomChain = frame.chains[atomIdx];
                            if (atomChain) {
                                newChains.add(atomChain);
                            }
                        }
                    }
                    
                    // Update selection in real-time during drag
                    viewerApi.renderer.setSelection({
                        atoms: newAtoms,
                        chains: newChains,
                        selectionMode: currentSelection?.selectionMode || 'explicit',
                        paeBoxes: currentSelection?.paeBoxes || []
                    });
                }
            }
        }
    });
    
    const handleMouseUp = () => {
        if (dragState.hasMoved && previewSelectionSet) {
            // User dragged - apply the drag selection
            // Update chains to include all chains that have selected atoms
            const objectName = viewerApi.renderer.currentObjectName;
            const obj = viewerApi.renderer.objectsData[objectName];
            const frame = obj?.frames?.[0];
            const newChains = new Set();
            if (frame?.chains) {
                for (const atomIdx of previewSelectionSet) {
                    const atomChain = frame.chains[atomIdx];
                    if (atomChain) {
                        newChains.add(atomChain);
                    }
                }
            }
            
            // Determine if we have partial selections
            const totalAtoms = frame?.chains?.length || 0;
            const hasPartialSelections = previewSelectionSet.size > 0 && previewSelectionSet.size < totalAtoms;
            
            // Clear PAE boxes when finishing drag selection
            // (sequence selection is already reflected in PAE via colors)
            viewerApi.renderer.setSelection({ 
                atoms: previewSelectionSet,
                chains: newChains,
                selectionMode: hasPartialSelections ? 'explicit' : 'default',
                paeBoxes: [] 
            });
        } else if (dragState.isDragging && !sequenceViewMode && dragState.dragStart && dragState.dragStart.chain) {
            // User clicked (no drag) on a chain label in chain mode - toggle that chain
            const chainId = dragState.dragStart.chain;
            const boundary = chainBoundaries.find(b => b.chain === chainId);
            if (boundary) {
                const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                const current = viewerApi?.renderer?.getSelection();
                const newAtoms = new Set(current?.atoms || []);
                const allChainAtomsSelected = chainAtoms.every(a => newAtoms.has(a.atomIndex));
                
                if (allChainAtomsSelected) {
                    // Deselect all atoms in chain
                    chainAtoms.forEach(a => newAtoms.delete(a.atomIndex));
                } else {
                    // Select all atoms in chain
                    chainAtoms.forEach(a => newAtoms.add(a.atomIndex));
                }
                
                // Update chains to include all chains that have selected atoms
                const objectName = viewerApi.renderer.currentObjectName;
                const obj = viewerApi.renderer.objectsData[objectName];
                const frame = obj?.frames?.[0];
                const newChains = new Set();
                if (frame?.chains) {
                    for (const atomIdx of newAtoms) {
                        const atomChain = frame.chains[atomIdx];
                        if (atomChain) {
                            newChains.add(atomChain);
                        }
                    }
                }
                
                // Determine if we have partial selections
                const totalAtoms = frame?.chains?.length || 0;
                const hasPartialSelections = newAtoms.size > 0 && newAtoms.size < totalAtoms;
                
                viewerApi.renderer.setSelection({ 
                    atoms: newAtoms,
                    chains: newChains,
                    selectionMode: hasPartialSelections ? 'explicit' : 'default',
                    paeBoxes: [] 
                });
            }
        }
        previewSelectionSet = null;
        dragState.isDragging = false;
        dragState.dragStart = null;
        dragState.dragEnd = null;
        dragState.hasMoved = false;
        dragState.dragUnselectMode = false;
        // Force update to reflect changes
        lastSequenceUpdateHash = null;
        updateSequenceViewSelectionState();
    };

    table.addEventListener('mouseup', handleMouseUp);
    table.addEventListener('mouseleave', () => {
        handleMouseUp();
        clearHighlight();
    });
    
    // Touch event handlers for mobile devices
    const getTouchTarget = (e) => {
        const touch = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches[0];
        const element = document.elementFromPoint(touch.clientX, touch.clientY);
        return element ? element.closest('.residue-char') : null;
    };
    
    table.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return; // Only single touch
        e.preventDefault(); // Prevent scrolling
        
        const span = getTouchTarget(e);
        if (!span) return;
        
        const atomIndexStr = span.dataset.atomIndex;
        if (atomIndexStr === undefined || atomIndexStr === null) return;
        const atomIndex = parseInt(atomIndexStr);
        if (isNaN(atomIndex)) return;
        
        const residue = allResidues.find(r => r.atomIndex === atomIndex);
        if (!residue) return;
        
        dragState.isDragging = true;
        dragState.hasMoved = false;
        dragState.dragStart = residue;
        dragState.dragEnd = residue;
        
        const current = viewerApi?.renderer?.getSelection();
        dragState.dragUnselectMode = current?.atoms?.has(atomIndex) || false;
        
        // Toggle single atom on tap
        const newAtoms = new Set(current?.atoms || []);
        if (newAtoms.has(atomIndex)) {
            newAtoms.delete(atomIndex);
        } else {
            newAtoms.add(atomIndex);
        }
        
        // Update chains to include all chains that have selected atoms
        const objectName = viewerApi.renderer.currentObjectName;
        const obj = viewerApi.renderer.objectsData[objectName];
        const frame = obj?.frames?.[0];
        const newChains = new Set();
        if (frame?.chains) {
            for (const atomIdx of newAtoms) {
                const atomChain = frame.chains[atomIdx];
                if (atomChain) {
                    newChains.add(atomChain);
                }
            }
        }
        
        // Determine if we have partial selections
        const totalAtoms = frame?.chains?.length || 0;
        const hasPartialSelections = newAtoms.size > 0 && newAtoms.size < totalAtoms;
        
        // Clear PAE boxes when editing sequence selection
        viewerApi.renderer.setSelection({ 
            atoms: newAtoms,
            chains: newChains,
            selectionMode: hasPartialSelections ? 'explicit' : 'default',
            paeBoxes: [] 
        });
        // Force update to reflect changes
        lastSequenceUpdateHash = null;
        updateSequenceViewSelectionState();
    });
    
    table.addEventListener('touchmove', (e) => {
        if (!dragState.isDragging) return;
        if (e.touches.length !== 1) return;
        e.preventDefault(); // Prevent scrolling
        
        const span = getTouchTarget(e);
        if (span) {
            const atomIndexStr = span.dataset.atomIndex;
            if (atomIndexStr === undefined || atomIndexStr === null) return;
            const atomIndex = parseInt(atomIndexStr);
            if (isNaN(atomIndex)) return;
            
            const residue = allResidues.find(r => r.atomIndex === atomIndex);
            if (residue && residue !== dragState.dragEnd) {
                dragState.dragEnd = residue;
                const startIdx = allResidues.findIndex(r => r.atomIndex === dragState.dragStart.atomIndex);
                const endIdx = allResidues.findIndex(r => r.atomIndex === dragState.dragEnd.atomIndex);
                if (startIdx !== -1 && endIdx !== -1) {
                    dragState.hasMoved = true;
                    const [min, max] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
                    const current = viewerApi?.renderer?.getSelection();
                    const newAtoms = new Set(current?.atoms || []);
                    for (let i = min; i <= max; i++) {
                        const res = allResidues[i];
                        if (dragState.dragUnselectMode) {
                            newAtoms.delete(res.atomIndex);
                        } else {
                            newAtoms.add(res.atomIndex);
                        }
                    }
                    previewSelectionSet = newAtoms;
                    lastSequenceUpdateHash = null;
                    updateSequenceViewSelectionState();
                }
            }
        }
    });
    
    table.addEventListener('touchend', (e) => {
        e.preventDefault();
        handleMouseUp();
    });
    
    table.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        handleMouseUp();
    });
}

// Cache for sequence view spans to avoid repeated DOM queries
let cachedSequenceSpans = null;
let lastSequenceUpdateHash = null;

// Update colors in sequence view when color mode changes
function updateSequenceViewColors() {
  if (!sequenceHTMLData || !viewerApi?.renderer) return;
  
  const renderer = viewerApi.renderer;
  const hasGetAtomColor = renderer?.getAtomColor;
  
  // Update colors for all residues in unified structure
  if (sequenceHTMLData.allResidues) {
    for (const res of sequenceHTMLData.allResidues) {
      if (hasGetAtomColor && !Number.isNaN(res.atomIndex)) {
        res.color = renderer.getAtomColor(res.atomIndex);
        // Update element background color
        res.element.style.backgroundColor = `rgb(${res.color.r}, ${res.color.g}, ${res.color.b})`;
      }
    }
  }
  
  // Invalidate hash to force redraw with new colors
  lastSequenceUpdateHash = null;
}

function updateSequenceViewSelectionState() {
  if (!sequenceHTMLData) return;

  // Determine what's actually visible from the unified model or visibilityMask
  // Use previewSelectionSet during drag for live feedback
  let visibleAtoms = new Set();
  
  if (previewSelectionSet && previewSelectionSet.size > 0) {
    // During drag, use preview selection for live feedback (already atom indices)
    visibleAtoms = new Set(previewSelectionSet);
  } else if (viewerApi?.renderer) {
    const renderer = viewerApi.renderer;
    
    // Use atoms directly from selection model
    if (renderer.selectionModel && renderer.selectionModel.atoms && renderer.selectionModel.atoms.size > 0) {
      visibleAtoms = new Set(renderer.selectionModel.atoms);
    } else if (renderer.visibilityMask === null) {
      // null mask means all atoms are visible (default mode)
      const n = renderer.coords ? renderer.coords.length : 0;
      for (let i = 0; i < n; i++) {
        visibleAtoms.add(i);
      }
    } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
      // Non-empty Set means some atoms are visible
      visibleAtoms = new Set(renderer.visibilityMask);
    }
  }

  // Create hash to detect if selection actually changed
  // Include previewSelectionSet in hash to ensure live feedback during drag
  const renderer = viewerApi?.renderer;
  const previewHash = previewSelectionSet ? previewSelectionSet.size : 0;
  const currentHash = visibleAtoms.size + previewHash + (renderer?.visibilityMask === null ? 'all' : 'some');
  if (currentHash === lastSequenceUpdateHash && !previewSelectionSet) {
    return; // No change, skip update (unless we have preview selection for live feedback)
  }
  lastSequenceUpdateHash = currentHash;

  // Update HTML elements with selection state
  const dimFactor = 0.3; // Same as PAE plot - dim unselected to 30% brightness
  const { allResidues, table } = sequenceHTMLData;
  
  // Update residue background colors and borders (only if sequence is shown)
  if (allResidues && allResidues.length > 0) {
    for (const res of allResidues) {
      let r = res.color.r;
      let g = res.color.g;
      let b = res.color.b;
      const isVisible = visibleAtoms.has(res.atomIndex);
      
      if (!isVisible) {
        // Unselected: dim by mixing with white (similar to PAE plot)
        r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
        g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
        b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
        // Remove border for unselected positions
        res.element.style.borderBottom = 'none';
      } else {
        // Selected: use full color (already has pastel applied via getAtomColor)
        // Add black underline (1px bottom border) for visible positions
        res.element.style.borderBottom = '1px solid #000000';
      }
      res.element.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    }
  }
  
  // Update chain labels (always shown, in table cells)
  if (table) {
    const current = viewerApi?.renderer?.getSelection();
    const renderer = viewerApi?.renderer;
    
    const chainLabels = table.querySelectorAll('.chain-label');
    for (const label of chainLabels) {
      const chainId = label.dataset.chain;
      if (!chainId) continue;
      
      const isSelected = current?.chains?.has(chainId) || 
          (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
      
      const chainColor = renderer?.getChainColorForChainId?.(chainId) || {r: 128, g: 128, b: 128};
      
      if (isSelected) {
        label.style.backgroundColor = `rgb(${chainColor.r}, ${chainColor.g}, ${chainColor.b})`;
        const luminance = (0.299 * chainColor.r + 0.587 * chainColor.g + 0.114 * chainColor.b) / 255;
        label.style.color = luminance > 0.5 ? '#000000' : '#ffffff';
        label.style.borderBottom = '1px solid #000000'; // Add black border when selected
      } else {
        const dimmed = {
          r: Math.round(chainColor.r * 0.3 + 255 * 0.7),
          g: Math.round(chainColor.g * 0.3 + 255 * 0.7),
          b: Math.round(chainColor.b * 0.3 + 255 * 0.7)
        };
        label.style.backgroundColor = `rgb(${dimmed.r}, ${dimmed.g}, ${dimmed.b})`;
        label.style.color = '#000000';
        label.style.borderBottom = '1px solid transparent'; // Keep border space to prevent jumping
      }
    }
  }
}

// Removed setupDragToSelect - replaced by canvas-based sequence rendering (setupCanvasSequenceEvents)

// ============================================================================
// FETCH LOGIC
// ============================================================================

async function handleFetch() {
    const tempBatch = [];
    const fetchId = document.getElementById('fetch-id').value.trim().toUpperCase();
    
    if (!fetchId) {
        setStatus("Please enter a PDB or UniProt ID.", true);
        return;
    }

    setStatus(`Fetching ${fetchId} data...`);

    const isPDB = fetchId.length === 4;
    const isAFDB = !isPDB;

    let structUrl, paeUrl, name, paeEnabled;

    if (isAFDB) {
        name = `${fetchId}.cif`;
        structUrl = `https://alphafold.ebi.ac.uk/files/AF-${fetchId}-F1-model_v6.cif`;
        paeUrl = `https://alphafold.ebi.ac.uk/files/AF-${fetchId}-F1-predicted_aligned_error_v6.json`;
        paeEnabled = window.viewerConfig.pae;
    } else {
        name = `${fetchId}.cif`;
        structUrl = `https://files.rcsb.org/download/${fetchId}.cif`;
        paeUrl = null;
        paeEnabled = false;
    }

    try {
        const structResponse = await fetch(structUrl);
        if (!structResponse.ok) {
            throw new Error(`Failed to fetch structure (HTTP ${structResponse.status})`);
        }
        const structText = await structResponse.text();

        let paeData = null;
        if (paeEnabled && paeUrl) {
            try {
                const paeResponse = await fetch(paeUrl);
                if (paeResponse.ok) {
                    const paeJson = await paeResponse.json();
                    paeData = extractPaeFromJSON(paeJson);
                } else {
                    console.warn(`PAE data not found (HTTP ${paeResponse.status}).`);
                }
            } catch (e) {
                console.warn("Could not fetch PAE data:", e.message);
            }
        }

        const framesAdded = processStructureToTempBatch(
            structText,
            name,
            paeData,
            cleanObjectName(name),
            tempBatch
        );
        
        batchedObjects.push(...tempBatch);
        updateViewerFromGlobalBatch();
        
        setStatus(
            `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
            `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}).`
        );

    } catch (e) {
        console.error("Fetch failed:", e);
        setStatus(`Error: Fetch failed for ${fetchId}. ${e.message}.`, true);
    }
}

// ============================================================================
// FILE UPLOAD & BATCH PROCESSING
// ============================================================================

async function processFiles(files, loadAsFrames, groupName = null) {
    const tempBatch = [];
    let overallTotalFramesAdded = 0;
    let paePairedCount = 0;

    const structureFiles = [];
    const jsonFiles = [];
    const stateFiles = [];

    // First pass: identify state files
    for (const file of files) {
        const nameLower = file.name.toLowerCase();
        if (file.name.startsWith('__MACOSX/') || file.name.startsWith('._')) continue;
        
        // Check for state file extension
        if (nameLower.endsWith('.py2dmol.json')) {
            stateFiles.push(file);
        } else if (nameLower.endsWith('.json')) {
            jsonFiles.push(file);
        } else if (nameLower.match(/\.(cif|pdb|ent)$/)) {
            structureFiles.push(file);
        }
    }

    // Load JSON files and check for state file signature
    const jsonContentsMap = new Map();
    const jsonLoadPromises = jsonFiles.map(jsonFile => new Promise(async (resolve) => {
        try {
            const jsonText = await jsonFile.readAsync("text");
            const jsonObject = JSON.parse(jsonText);
            
            // Check if this is a state file
            if (jsonObject.py2dmol_version) {
                stateFiles.push(jsonFile);
            } else {
                // Regular PAE JSON file
                const jsonBaseName = jsonFile.name.replace(/\.json$/i, '');
                jsonContentsMap.set(jsonBaseName, jsonObject);
            }
        } catch (e) {
            console.warn(`Failed to parse JSON file ${jsonFile.name}:`, e);
        }
        resolve();
    }));

    await Promise.all(jsonLoadPromises);

    // If we found state files, load them and return early
    if (stateFiles.length > 0) {
        // Load the first state file (if multiple, use the first one)
        try {
            const stateFile = stateFiles[0];
            const jsonText = await stateFile.readAsync("text");
            const stateData = JSON.parse(jsonText);
            
            if (stateData.py2dmol_version) {
                await loadViewerState(stateData);
                return { objectsLoaded: 0, framesAdded: 0, structureCount: 0, paePairedCount: 0, isTrajectory: false };
            }
        } catch (e) {
            console.error("Failed to load state file:", e);
            setStatus(`Error loading state file: ${e.message}`, true);
            return { objectsLoaded: 0, framesAdded: 0, structureCount: 0, paePairedCount: 0, isTrajectory: false };
        }
    }

    // Continue with normal file processing if no state files
    if (structureFiles.length === 0) {
        throw new Error(`No structural files (*.cif, *.pdb, *.ent) found.`);
    }

    // Match JSON to structures
    function getBestJsonMatch(structBaseName, jsonMap) {
        let bestMatch = null;
        let bestScore = 0;

        const partsA = structBaseName.split(/[-_]/);

        for (const [jsonBaseName, paeJson] of jsonMap.entries()) {
            const partsB = jsonBaseName.split(/[-_]/);
            let score = 0;
            while (score < partsA.length && score < partsB.length &&
                partsA[score] === partsB[score]) score++;

            const nameHintScore = (jsonBaseName.includes("pae") ||
                jsonBaseName.includes("full_data") ||
                jsonBaseName.includes("scores") ||
                jsonBaseName.includes("aligned_error")) ? 1 : 0;

            const structModelMatch = structBaseName.match(/_model_(\d+)$/i);
            const structModelNum = structModelMatch ? structModelMatch[1] : null;

            let modelNumBonus = 0;
            if (structModelNum !== null) {
                const jsonModelMatch = jsonBaseName.match(/_(?:full_data|data|model|pae)_(\d+)$/i);
                if (jsonModelMatch && jsonModelMatch[1] === structModelNum) {
                    modelNumBonus = 100;
                }
            }

            const structRankMatch = structBaseName.match(/_rank_(\d+)_/i);
            const jsonRankMatch = jsonBaseName.match(/_rank_(\d+)_/i);

            let rankBonus = 0;
            if (structRankMatch && jsonRankMatch && structRankMatch[1] === structRankMatch[1]) {
                rankBonus = 100;
                const structInternalModel = structBaseName.match(/_model_(\d+)_/i);
                const jsonInternalModel = jsonBaseName.match(/_model_(\d+)_/i);
                if (structInternalModel && jsonInternalModel &&
                    structInternalModel[1] === jsonInternalModel[1]) {
                    rankBonus += 50;
                }
                const structSeed = structBaseName.match(/_seed_(\d+)/i);
                const jsonSeed = jsonBaseName.match(/_seed_(\d+)/i);
                if (structSeed && jsonSeed && structSeed[1] === jsonSeed[1]) {
                    rankBonus += 25;
                }
            }

            const finalScore = score + nameHintScore + modelNumBonus + rankBonus;

            if (finalScore > bestScore) {
                // Don't warn when checking candidates - only warn on final extraction
                const paeMatrix = extractPaeFromJSON(paeJson, false);
                if (paeMatrix) {
                    bestScore = finalScore;
                    bestMatch = paeJson;
                }
            }
        }
        return bestScore > 0 ? bestMatch : null;
    }

    // Process structure files
    for (const structFile of structureFiles) {
        let paeData = null;
        const structBaseName = structFile.name.replace(/\.(cif|pdb|ent)$/i, '');
        const bestMatchJson = getBestJsonMatch(structBaseName, jsonContentsMap);
        
        if (bestMatchJson) {
            paeData = extractPaeFromJSON(bestMatchJson);
            if (paeData) paePairedCount++;
        }

        const text = await structFile.readAsync("text");

        const trajectoryObjectName = loadAsFrames && structureFiles.length > 1 ?
            (groupName || cleanObjectName(structureFiles[0].name)) :
            structBaseName;

        const framesAdded = processStructureToTempBatch(
            text,
            structFile.name,
            paeData,
            trajectoryObjectName,
            tempBatch
        );
        overallTotalFramesAdded += framesAdded;
    }

    if (tempBatch.length > 0) batchedObjects.push(...tempBatch);
    updateViewerFromGlobalBatch();

    return {
        objectsLoaded: tempBatch.length,
        framesAdded: overallTotalFramesAdded,
        paePairedCount,
        structureCount: structureFiles.length,
        isTrajectory: loadAsFrames && structureFiles.length > 1
    };
}

async function handleZipUpload(file, loadAsFrames) {
    setStatus(`Unzipping ${file.name} and collecting data...`);
    
    try {
        const zip = new JSZip();
        const content = await zip.loadAsync(file);

        const fileList = [];
        content.forEach((relativePath, zipEntry) => {
            if (relativePath.startsWith('__MACOSX/') ||
                relativePath.startsWith('._') ||
                zipEntry.dir) return;
            fileList.push({
                name: relativePath,
                readAsync: (type) => zipEntry.async(type)
            });
        });

        // Check if this is a state file zip (contains a .json file with py2dmol_version)
        const jsonFiles = fileList.filter(f => f.name.toLowerCase().endsWith('.json'));
        if (jsonFiles.length > 0) {
            // Try to load as state file first
            try {
                const jsonText = await jsonFiles[0].readAsync("text");
                const stateData = JSON.parse(jsonText);
                if (stateData.py2dmol_version) {
                    await loadViewerState(stateData);
                    return;
                }
            } catch (e) {
                // Not a state file, continue with normal processing
            }
        }

        const stats = await processFiles(fileList, loadAsFrames, cleanObjectName(file.name));

        const objectsLoaded = stats.isTrajectory ? 1 : stats.objectsLoaded;
        const paeMessage = stats.paePairedCount > 0 ?
            ` (${stats.paePairedCount}/${stats.structureCount} PAE matrices paired)` : '';

        setStatus(
            `Successfully loaded ${objectsLoaded} new object(s) from ${file.name} ` +
            `(${stats.framesAdded} total frame${stats.framesAdded !== 1 ? 's' : ''}${paeMessage}).`
        );
    } catch (e) {
        console.error("ZIP processing failed:", e);
        setStatus(`Error processing ZIP file: ${file.name}. ${e.message}`, true);
    }
}

function handleFileUpload(event) {
    const files = event.target.files ||
        (event.dataTransfer ? event.dataTransfer.files : null);
    if (!files || files.length === 0) return;

    const loadAsFramesCheckbox = document.getElementById('loadAsFramesCheckbox');
    const loadAsFrames = loadAsFramesCheckbox.checked;

    const zipFiles = [];
    const looseFiles = [];

    for (const file of files) {
        if (file.name.toLowerCase().endsWith('.zip')) {
            zipFiles.push(file);
        } else {
            looseFiles.push({
                name: file.name,
                readAsync: (type) => file.text()
            });
        }
    }

    setStatus(`Processing ${files.length} selected files...`);

    if (zipFiles.length > 0) {
        handleZipUpload(zipFiles[0], loadAsFrames);
        if (zipFiles.length > 1) {
            setStatus(`Loaded ${zipFiles[0].name}. Please upload one ZIP at a time.`, true);
        }
        return;
    }

    if (looseFiles.length > 0) {
        (async () => {
            try {
                const stats = await processFiles(looseFiles, loadAsFrames);
                
                // If processFiles returned early due to state file, stats will indicate it
                if (stats.objectsLoaded === 0 && stats.framesAdded === 0 && 
                    looseFiles.some(f => f.name.toLowerCase().endsWith('.py2dmol.json') || 
                                       f.name.toLowerCase().endsWith('.json'))) {
                    // State file was loaded, status already set by loadViewerState
                    return;
                }
                
                const objectsLoaded = stats.isTrajectory ? 1 : stats.objectsLoaded;
                const sourceName = looseFiles.length > 1 ?
                    `${looseFiles.length} files` : looseFiles[0].name;
                const paeMessage = stats.paePairedCount > 0 ?
                    ` (${stats.paePairedCount}/${stats.structureCount} PAE matrices paired)` : '';
                
                setStatus(
                    `Successfully loaded ${objectsLoaded} new object(s) from ${sourceName} ` +
                    `(${stats.framesAdded} total frame${stats.framesAdded !== 1 ? 's' : ''}${paeMessage}).`
                );
            } catch (e) {
                console.error("Loose file processing failed:", e);
                setStatus(`Error processing loose files: ${e.message}`, true);
            }
        })();
    }
}

// ============================================================================
// DRAG AND DROP
// ============================================================================

function initDragAndDrop() {
    const globalDropOverlay = document.getElementById('global-drop-overlay');
    const fileUploadInput = document.getElementById('file-upload');
    let dragCounter = 0;

    document.body.addEventListener('dragenter', (e) => {
        preventDefaults(e);
        if (dragCounter === 0) {
            globalDropOverlay.style.display = 'flex';
        }
        dragCounter++;
    }, false);

    document.body.addEventListener('dragleave', (e) => {
        preventDefaults(e);
        dragCounter--;
        if (dragCounter === 0 || e.relatedTargEt === null) {
            globalDropOverlay.style.display = 'none';
        }
    }, false);

    document.body.addEventListener('drop', (e) => {
        preventDefaults(e);
        dragCounter = 0;
        globalDropOverlay.style.display = 'none';
        const dt = e.dataTransfer;
        if (dt.files.length > 0) {
            handleFileUpload({ target: { files: dt.files } });
        }
    }, false);

    document.body.addEventListener('dragover', preventDefaults, false);
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

// ============================================================================
// SAVE/LOAD STATE
// ============================================================================

function saveViewerState() {
    if (!viewerApi || !viewerApi.renderer) {
        setStatus("Error: No viewer data to save.", true);
        return;
    }
    
    const renderer = viewerApi.renderer;
    
    try {
        // Collect all objects
        const objects = [];
        for (const [objectName, objectData] of Object.entries(renderer.objectsData)) {
            const frames = [];
            for (const frame of objectData.frames) {
                const frameData = {};
                
                // Round coordinates to 2 decimal places
                if (frame.coords) {
                    frameData.coords = frame.coords.map(coord => 
                        coord.map(c => Math.round(c * 100) / 100)
                    );
                }
                
                // Round pLDDT to integers
                if (frame.plddts) {
                    frameData.plddts = frame.plddts.map(p => Math.round(p));
                }
                
                // Copy other fields as-is (omit null/undefined)
                if (frame.chains) frameData.chains = frame.chains;
                if (frame.atom_types) frameData.atom_types = frame.atom_types;
                if (frame.residues) frameData.residues = frame.residues;
                if (frame.residue_index) frameData.residue_index = frame.residue_index;
                
                // Round PAE to 1 decimal place
                if (frame.pae) {
                    frameData.pae = frame.pae.map(row => 
                        row.map(val => Math.round(val * 10) / 10)
                    );
                }
                
                frames.push(frameData);
            }
            
            objects.push({
                name: objectName,
                frames: frames,
                hasPAE: objectData.hasPAE || false
            });
        }
        
        // Get viewer state
        const orthoSlider = document.getElementById('orthoSlider');
        const orthoSliderValue = orthoSlider ? parseFloat(orthoSlider.value) : 0.5;
        
        const viewerState = {
            current_object_name: renderer.currentObjectName,
            current_frame: renderer.currentFrame,
            rotation_matrix: renderer.rotationMatrix,
            zoom: renderer.zoom,
            color_mode: renderer.colorMode || 'auto',
            line_width: renderer.lineWidth || 3.0,
            shadow_enabled: renderer.shadowEnabled !== false,
            outline_enabled: renderer.outlineEnabled !== false,
            colorblind_mode: renderer.colorblindMode || false,
            pastel_level: renderer.pastelLevel || 0.25,
            perspective_enabled: renderer.perspectiveEnabled || false,
            ortho_slider_value: orthoSliderValue, // Save the normalized slider value (0.0-1.0)
            animation_speed: renderer.animationSpeed || 100
        };
        
        // Get selection state
        const selection = renderer.getSelection();
        const selectionState = {
            atoms: Array.from(selection.atoms),
            chains: Array.from(selection.chains),
            pae_boxes: selection.paeBoxes.map(box => ({...box})),
            selection_mode: selection.selectionMode
        };
        
        // Create state object
        const stateData = {
            py2dmol_version: "1.0",
            objects: objects,
            viewer_state: viewerState,
            selection_state: selectionState
        };
        
        // Create filename with timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const jsonFilename = `py2dmol_state_${timestamp}.json`;
        const zipFilename = `py2dmol_state_${timestamp}.zip`;
        
        // Create JSON string
        const jsonString = JSON.stringify(stateData, null, 2);
        
        // Check if JSZip is available
        if (typeof JSZip !== 'undefined') {
            // Create zip file
            const zip = new JSZip();
            zip.file(jsonFilename, jsonString);
            
            // Generate zip blob with lower compression (level 1 = faster, less compression)
            zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } })
                .then((blob) => {
                    // Download zip file
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = zipFilename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    
                    setStatus(`State saved to ${zipFilename}`);
                })
                .catch((error) => {
                    console.error("Failed to create zip file:", error);
                    // Fallback to JSON download
                    const blob = new Blob([jsonString], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = jsonFilename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    setStatus(`State saved to ${jsonFilename} (zip failed, saved as JSON)`);
                });
        } else {
            // Fallback to JSON download if JSZip not available
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = jsonFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStatus(`State saved to ${jsonFilename}`);
        }
    } catch (e) {
        console.error("Failed to save state:", e);
        setStatus(`Error saving state: ${e.message}`, true);
    }
}

// ============================================================================
// SVG EXPORT
// ============================================================================

// Helper function to get SVG string from renderer
function getViewerSvgString() {
    if (!viewerApi || !viewerApi.renderer) {
        throw new Error("No viewer data available");
    }
    
    const renderer = viewerApi.renderer;
    const canvas = renderer.canvas;
    
    if (!canvas) {
        throw new Error("Canvas not found");
    }
    
    // Check if C2S (canvas2svg) is available
    if (typeof C2S === 'undefined') {
        throw new Error("canvas2svg library not loaded");
    }
    
    // Get canvas dimensions
    const width = canvas.width;
    const height = canvas.height;
    
    // Create SVG context using canvas2svg
    const svgCtx = new C2S(width, height);
    
    // Store original context
    const originalCtx = renderer.ctx;
    
    // Temporarily replace the renderer's context with SVG context
    renderer.ctx = svgCtx;
    
    // Re-render the scene to the SVG context
    renderer.render();
    
    // Get the SVG string
    const svgString = svgCtx.getSerializedSvg();
    
    // Restore original context
    renderer.ctx = originalCtx;
    
    // Re-render to canvas to restore display
    renderer.render();
    
    return svgString;
}

function saveViewerAsSvg() {
    try {
        const svgString = getViewerSvgString();
        const renderer = viewerApi.renderer;
        
        // Create filename with object name and timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        
        // Get object name and sanitize it for filename
        let objectName = renderer.currentObjectName || 'viewer';
        // Sanitize object name: remove invalid filename characters
        objectName = objectName.replace(/[^a-zA-Z0-9_-]/g, '_');
        // Limit length to avoid overly long filenames
        if (objectName.length > 50) {
            objectName = objectName.substring(0, 50);
        }
        
        const svgFilename = `py2dmol_${objectName}_${timestamp}.svg`;
        
        // Download the SVG file
        const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = svgFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        setStatus(`SVG exported to ${svgFilename}`);
    } catch (e) {
        console.error("Failed to export SVG:", e);
        setStatus(`Error exporting SVG: ${e.message}`, true);
    }
}

async function loadViewerState(stateData) {
    if (!viewerApi || !viewerApi.renderer) {
        setStatus("Error: Viewer not initialized.", true);
        return;
    }
    
    const renderer = viewerApi.renderer;
    
    try {
        // Validate version
        if (stateData.py2dmol_version && stateData.py2dmol_version !== "1.0") {
            console.warn(`State file version ${stateData.py2dmol_version} may not be fully compatible.`);
        }
        
        // Clear existing objects
        renderer.clearAllObjects();
        objectsWithPAE.clear();
        
        // Ensure viewer container is visible
        const viewerContainer = document.getElementById('viewer-container');
        const topPanelContainer = document.getElementById('top-panel-container');
        if (viewerContainer) viewerContainer.style.display = 'flex';
        if (topPanelContainer) topPanelContainer.style.display = 'block';
        
        // Restore objects
        if (stateData.objects && Array.isArray(stateData.objects) && stateData.objects.length > 0) {
            for (const objData of stateData.objects) {
                if (!objData.name || !objData.frames || !Array.isArray(objData.frames) || objData.frames.length === 0) {
                    console.warn("Skipping invalid object in state file:", objData);
                    continue;
                }
                
                renderer.addObject(objData.name);
                
                // Temporarily disable auto frame setting during batch load
                const wasPlaying = renderer.isPlaying;
                renderer.isPlaying = true; // Prevent setFrame from being called during addFrame
                
                for (const frameData of objData.frames) {
                    renderer.addFrame(frameData, objData.name);
                }
                
                // Restore playing state
                renderer.isPlaying = wasPlaying;
                
                // Check if any frame has PAE data (more reliable than just hasPAE flag)
                let hasPAEData = objData.hasPAE || false;
                if (!hasPAEData && objData.frames && objData.frames.length > 0) {
                    // Check if any frame actually has PAE data
                    hasPAEData = objData.frames.some(frame => frame.pae && Array.isArray(frame.pae) && frame.pae.length > 0);
                }
                
                if (hasPAEData) {
                    objectsWithPAE.add(objData.name);
                }
            }
        } else {
            setStatus("Error: No valid objects found in state file.", true);
            return;
        }
        
        // Restore viewer state
        if (stateData.viewer_state) {
            const vs = stateData.viewer_state;
            
            // Set current object first (before setting frame)
            if (vs.current_object_name && renderer.objectsData[vs.current_object_name]) {
                renderer.currentObjectName = vs.current_object_name;
                if (renderer.objectSelect) {
                    renderer.objectSelect.value = vs.current_object_name;
                }
            } else if (stateData.objects && stateData.objects.length > 0) {
                // Fallback to first object if saved object doesn't exist
                const firstObjName = stateData.objects[0].name;
                renderer.currentObjectName = firstObjName;
                if (renderer.objectSelect) {
                    renderer.objectSelect.value = firstObjName;
                }
            }
            
            // Restore rotation
            if (vs.rotation_matrix && Array.isArray(vs.rotation_matrix)) {
                renderer.rotationMatrix = vs.rotation_matrix;
            }
            
            // Restore zoom
            if (typeof vs.zoom === 'number') {
                renderer.zoom = vs.zoom;
            }
            
            // Restore color mode
            if (vs.color_mode) {
                const validModes = ['auto', 'chain', 'rainbow', 'plddt'];
                if (validModes.includes(vs.color_mode)) {
                    renderer.colorMode = vs.color_mode;
                    const colorSelect = document.getElementById('colorSelect');
                    if (colorSelect) {
                        colorSelect.value = vs.color_mode;
                        renderer.colorsNeedUpdate = true;
                        renderer.plddtColorsNeedUpdate = true;
                        renderer.render();
                    }
                }
            }
            
            // Restore line width
            if (typeof vs.line_width === 'number') {
                renderer.lineWidth = vs.line_width;
                const lineWidthSlider = document.getElementById('lineWidthSlider');
                if (lineWidthSlider) {
                    lineWidthSlider.value = vs.line_width;
                    lineWidthSlider.dispatchEvent(new Event('input'));
                }
            }
            
            // Restore shadow
            if (typeof vs.shadow_enabled === 'boolean') {
                renderer.shadowEnabled = vs.shadow_enabled;
                const shadowCheckbox = document.getElementById('shadowEnabledCheckbox');
                if (shadowCheckbox) {
                    shadowCheckbox.checked = vs.shadow_enabled;
                    shadowCheckbox.dispatchEvent(new Event('change'));
                }
            }
            
            // Restore outline
            if (typeof vs.outline_enabled === 'boolean') {
                renderer.outlineEnabled = vs.outline_enabled;
                const outlineCheckbox = document.getElementById('outlineEnabledCheckbox');
                if (outlineCheckbox) {
                    outlineCheckbox.checked = vs.outline_enabled;
                    outlineCheckbox.dispatchEvent(new Event('change'));
                }
            }
            
            // Restore colorblind mode
            if (typeof vs.colorblind_mode === 'boolean') {
                renderer.colorblindMode = vs.colorblind_mode;
                const colorblindCheckbox = document.getElementById('colorblindCheckbox');
                if (colorblindCheckbox) {
                    colorblindCheckbox.checked = vs.colorblind_mode;
                    colorblindCheckbox.dispatchEvent(new Event('change'));
                }
            }
            
            // Restore pastel level
            if (typeof vs.pastel_level === 'number') {
                renderer.pastelLevel = vs.pastel_level;
            }
            
            // Restore ortho slider value (this will set perspective_enabled and focal_length correctly)
            if (typeof vs.ortho_slider_value === 'number') {
                const orthoSlider = document.getElementById('orthoSlider');
                if (orthoSlider) {
                    let normalizedValue = vs.ortho_slider_value;
                    
                    // Handle old state files that saved 50-200 range
                    if (normalizedValue > 1.0) {
                        // Old format: convert 50-200 to 0-1
                        normalizedValue = (normalizedValue - 50) / 150;
                    }
                    
                    // Clamp value to valid range (0.0-1.0)
                    normalizedValue = Math.max(0.0, Math.min(1.0, normalizedValue));
                    orthoSlider.value = normalizedValue;
                    // Trigger input event to update perspective_enabled and focal_length
                    orthoSlider.dispatchEvent(new Event('input'));
                }
            } else if (typeof vs.focal_length === 'number') {
                // Fallback for very old state files that saved focal_length
                const orthoSlider = document.getElementById('orthoSlider');
                if (orthoSlider) {
                    // Try to reverse-calculate slider value from focal_length
                    // This is approximate, but better than nothing
                    const object = renderer.currentObjectName ? renderer.objectsData[renderer.currentObjectName] : null;
                    const maxExtent = (object && object.maxExtent > 0) ? object.maxExtent : 30.0;
                    const multiplier = vs.focal_length / maxExtent;
                    
                    let normalizedValue = 0.5; // default
                    if (multiplier >= 20.0) {
                        // Orthographic mode
                        normalizedValue = 1.0;
                    } else if (multiplier >= 1.5) {
                        // Perspective mode - reverse the calculation
                        normalizedValue = (multiplier - 1.5) / (20.0 - 1.5);
                    }
                    
                    normalizedValue = Math.max(0.0, Math.min(1.0, normalizedValue));
                    orthoSlider.value = normalizedValue;
                    orthoSlider.dispatchEvent(new Event('input'));
                }
            }
            
            // Restore animation speed
            if (typeof vs.animation_speed === 'number') {
                renderer.animationSpeed = vs.animation_speed;
            }
        }
        
        // Set frame (this triggers render and PAE update)
        // Use setTimeout to ensure objects are fully loaded and DOM is ready
        setTimeout(() => {
            try {
                // Ensure we have a valid current object
                if (!renderer.currentObjectName && stateData.objects && stateData.objects.length > 0) {
                    const firstObjName = stateData.objects[0].name;
                    renderer.currentObjectName = firstObjName;
                    if (renderer.objectSelect) {
                        renderer.objectSelect.value = firstObjName;
                    }
                }
                
                // Verify object exists before setting frame
                if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                    const obj = renderer.objectsData[renderer.currentObjectName];
                    if (obj.frames && obj.frames.length > 0) {
                        if (stateData.viewer_state) {
                            const vs = stateData.viewer_state;
                            const targetFrame = (typeof vs.current_frame === 'number' && vs.current_frame >= 0 && vs.current_frame < obj.frames.length) 
                                ? vs.current_frame 
                                : 0;
                            renderer.setFrame(targetFrame);
                        } else {
                            renderer.setFrame(0);
                        }
                        
                        // Explicitly ensure PAE data is set if available
                        // (setFrame should handle this, but we verify here)
                        if (renderer.paeRenderer && obj.frames && obj.frames.length > 0) {
                            const currentFrameIndex = renderer.currentFrame >= 0 ? renderer.currentFrame : 0;
                            const currentFrameData = obj.frames[currentFrameIndex];
                            if (currentFrameData && currentFrameData.pae) {
                                renderer.paeRenderer.setData(currentFrameData.pae);
                            }
                        }
                        
                        // Rebuild sequence view and update UI first
                        // (These may reset selection, so we restore it after)
                        buildSequenceView();
                        updateChainSelectionUI();
                        updateObjectNavigationButtons();
                        
                        // Trigger object change handler to ensure UI is fully updated
                        if (renderer.objectSelect) {
                            handleObjectChange();
                        }
                        
                        // Restore selection state AFTER all UI updates
                        // (This must be last to avoid being overwritten by updateChainSelectionUI)
                        if (stateData.selection_state) {
                            const ss = stateData.selection_state;
                            
                            // Only support atoms format (no backward compatibility)
                            // If atoms is missing or invalid, default to empty Set (will show nothing)
                            let atoms = new Set();
                            if (ss.atoms !== undefined && Array.isArray(ss.atoms)) {
                                // New format: atoms array
                                atoms = new Set(ss.atoms.filter(a => typeof a === 'number' && a >= 0));
                            }
                            // If atoms is missing or invalid, atoms remains empty Set
                            
                            const selectionPatch = {
                                atoms: atoms,
                                chains: new Set(ss.chains || []),
                                paeBoxes: ss.pae_boxes || [],
                                selectionMode: ss.selection_mode || 'default'
                            };
                            renderer.setSelection(selectionPatch);
                        }
                        
                        // Force a render to ensure everything is displayed
                        renderer.render();
                        
                        setStatus("State loaded successfully.");
                    } else {
                        setStatus("Error: Object has no frames.", true);
                    }
                } else {
                    setStatus("Error: Could not set current object.", true);
                    console.error("Current object:", renderer.currentObjectName, "Available objects:", Object.keys(renderer.objectsData));
                }
            } catch (e) {
                console.error("Error in setTimeout during state load:", e);
                setStatus(`Error loading state: ${e.message}`, true);
            }
        }, 100);
    } catch (e) {
        console.error("Failed to load state:", e);
        setStatus(`Error loading state: ${e.message}`, true);
    }
}

// Expose saveViewerState globally for Python interface compatibility
window.saveViewerState = saveViewerState;