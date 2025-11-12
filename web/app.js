// ============================================================================
// APP.JS - Application logic, UI handlers, and initialization
// ============================================================================

// ============================================================================
// GLOBAL STATE
// ============================================================================

let viewerApi = null;
let objectsWithPAE = new Set(); // Fallback for backward compatibility
let batchedObjects = [];

// Helper function to check if PAE data is valid
function isValidPAE(pae) {
    return pae && Array.isArray(pae) && pae.length > 0;
}

// Helper function to check if object data has PAE (checks frames directly)
function checkObjectHasPAE(objData) {
    if (!objData || !objData.frames || objData.frames.length === 0) return false;
    return objData.frames.some(frame => isValidPAE(frame.pae));
}
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
    
    // Initialize highlight overlay after viewer is created
    if (viewerApi?.renderer && window.SequenceViewer && window.SequenceViewer.drawHighlights) {
        // Trigger initialization by calling drawHighlights (which will initialize if needed)
        const renderer = viewerApi.renderer;
        if (renderer.canvas) {
            window.SequenceViewer.drawHighlights();
        }
    }
    
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
        ortho: 1.0, // Normalized 0-1 range (1.0 = full orthographic)
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
    // Save SVG button is now handled by viewer-mol.js via setUIControls (same as Record button)
    // No need to set up listener here - renderer handles it
    
    // Copy selection button (moved to sequence actions)
    const copySelectionButton = document.getElementById('copySelectionButton');
    if (copySelectionButton) {
        copySelectionButton.addEventListener('click', () => {
            if (viewerApi && viewerApi.renderer && viewerApi.renderer.extractSelection) {
                viewerApi.renderer.extractSelection();
            } else {
                console.warn("Copy selection feature not available");
            }
        });
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
    // Note: colorSelect event listener is handled in viewer-mol.js initializePy2DmolViewer()
    // We don't need a duplicate listener here
    
    if (objectSelect) objectSelect.addEventListener('change', handleObjectChange);

    // Attach sequence controls
    const sequenceView = document.getElementById('sequenceView');
    const selectAllBtn = document.getElementById('selectAllResidues'); // Button ID kept for compatibility, but shows "Show all"
    const clearAllBtn  = document.getElementById('clearAllResidues'); // Button ID kept for compatibility, but shows "Hide all"
    const sequenceActions = document.querySelector('.sequence-actions');
    
    // Sequence panel is always visible now
    if (sequenceView) {
      sequenceView.classList.remove('hidden');
      const container = document.getElementById('sequence-viewer-container');
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
            // Toggle sequence view mode using module
            if (window.SequenceViewer) {
                const newMode = !window.SequenceViewer.getSequenceViewMode();
                window.SequenceViewer.setSequenceViewMode(newMode);
            }
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
            // Only change the text, no color changes
            const currentMode = window.SequenceViewer ? window.SequenceViewer.getSequenceViewMode() : false;
            if (currentMode) {
                toggleSequenceModeBtn.textContent = 'Chain'; // Show "Chain" when sequence is visible
            } else {
                toggleSequenceModeBtn.textContent = 'Sequence'; // Show "Sequence" when only chains are visible
            }
        }
    }
    
    // Initialize sequence mode to enabled by default
    if (window.SequenceViewer) {
        window.SequenceViewer.setSequenceViewMode(true);
    }
    
    // Initialize button state to reflect default sequence mode
    updateSequenceModeButton();
    
    // Monitor frame changes to update sequence view during animation
    let lastCheckedFrame = -1;
    function checkFrameChange() {
        if (viewerApi?.renderer) {
            const renderer = viewerApi.renderer;
            const currentFrame = renderer.currentFrame;
            if (currentFrame !== lastCheckedFrame && currentFrame >= 0) {
                lastCheckedFrame = currentFrame;
                // Check if sequence view needs updating
                const objectName = renderer.currentObjectName;
                if (objectName && renderer.objectsData[objectName]) {
                    const object = renderer.objectsData[objectName];
                    if (object.frames && object.frames.length > currentFrame) {
                        // Rebuild sequence view if sequence changed
                        buildSequenceView();
                    }
                }
            }
        }
        requestAnimationFrame(checkFrameChange);
    }
    // Start monitoring frame changes
    requestAnimationFrame(checkFrameChange);
    
    if (selectAllBtn) selectAllBtn.addEventListener('click', (e) => { e.preventDefault(); showAllResidues(); });
    if (clearAllBtn)  clearAllBtn.addEventListener('click', (e) => { e.preventDefault(); hideAllResidues(); });
    
    // Update copy selection button state when selection changes
    function updateCopySelectionButtonState() {
        const copyBtn = document.getElementById('copySelectionButton');
        if (!copyBtn || !viewerApi?.renderer) return;
        
        const renderer = viewerApi.renderer;
        const objectName = renderer.currentObjectName;
        if (!objectName) {
            copyBtn.disabled = true;
            return;
        }
        
        const object = renderer.objectsData[objectName];
        if (!object || !object.frames || object.frames.length === 0) {
            copyBtn.disabled = true;
            return;
        }
        
        const frame = object.frames[renderer.currentFrame >= 0 ? renderer.currentFrame : 0];
        if (!frame || !frame.coords) {
            copyBtn.disabled = true;
            return;
        }
        
        const totalAtoms = frame.coords.length;
        const selection = renderer.getSelection();
        
        // Get selected atoms
        let selectedAtoms = new Set();
        if (selection && selection.atoms && selection.atoms.size > 0) {
            selectedAtoms = new Set(selection.atoms);
        } else if (renderer.visibilityMask !== null && renderer.visibilityMask.size > 0) {
            selectedAtoms = new Set(renderer.visibilityMask);
        } else {
            // No selection or all atoms visible (default mode)
            selectedAtoms = new Set();
            for (let i = 0; i < totalAtoms; i++) {
                selectedAtoms.add(i);
            }
        }
        
        // Enable only if selection is non-zero and non-full-length
        const hasSelection = selectedAtoms.size > 0;
        const isPartialSelection = selectedAtoms.size > 0 && selectedAtoms.size < totalAtoms;
        copyBtn.disabled = !(hasSelection && isPartialSelection);
    }
    
    // Update button state on selection changes
    // Listen for selection change events (add listener globally, will work after viewer is initialized)
    document.addEventListener('py2dmol-selection-change', updateCopySelectionButtonState);
    
    // Also update on object/frame changes (set up after viewer is initialized)
    function setupCopyButtonStateUpdates() {
        if (viewerApi && viewerApi.renderer) {
            if (viewerApi.renderer.objectSelect) {
                viewerApi.renderer.objectSelect.addEventListener('change', updateCopySelectionButtonState);
            }
            // Also update when frame changes
            const frameSlider = document.getElementById('frameSlider');
            if (frameSlider) {
                frameSlider.addEventListener('input', updateCopySelectionButtonState);
                frameSlider.addEventListener('change', updateCopySelectionButtonState);
            }
        }
    }
    
    // Set up after viewer is initialized
    setTimeout(() => {
        setupCopyButtonStateUpdates();
        updateCopySelectionButtonState();
    }, 200);

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
        // Update MSA view
        if (window.MSAViewer && window.MSAViewer.updateMSAViewSelectionState) {
            window.MSAViewer.updateMSAViewSelectionState();
        }
    });
    
    // Update navigation button states
    updateObjectNavigationButtons();
    
    // Depth toggle
    const depthCheckbox = document.getElementById('depthCheckbox');
    if (depthCheckbox) {
        depthCheckbox.addEventListener('change', (e) => {
            if (viewerApi && viewerApi.renderer) {
                viewerApi.renderer.depthEnabled = e.target.checked;
                viewerApi.renderer.render();
            }
        });
    }
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
    
    const selectedObject = objectSelect.value;
    if (!selectedObject) return;
    
    // Clear selection when switching objects (selection is per-object)
    // The renderer's objectSelect change handler already calls resetToDefault(),
    // but we ensure it here as well for safety
    if (viewerApi?.renderer && viewerApi.renderer.currentObjectName !== selectedObject) {
        viewerApi.renderer.resetToDefault();
    }
    
    if (viewerApi?.renderer && typeof viewerApi.renderer.updatePAEContainerVisibility === 'function') {
        viewerApi.renderer.updatePAEContainerVisibility();
    } else {
        // Fallback: use objectsWithPAE Set (for backward compatibility)
        updatePAEContainerVisibilityFallback(selectedObject);
    }
    
    // Rebuild sequence view for the new object
    buildSequenceView();
    updateChainSelectionUI();
    
    // Note: updateColorMode() is a placeholder, removed to avoid confusion
    // Color mode is managed by the renderer and persists across object changes
}

// Fallback PAE container visibility update (for backward compatibility)
function updatePAEContainerVisibilityFallback(objectName) {
    const paeCanvas = document.getElementById('paeCanvas');
    const paeContainer = document.getElementById('paeContainer');
    const hasPAE = objectsWithPAE.has(objectName);
    
    if (paeContainer) {
        paeContainer.style.display = hasPAE ? 'flex' : 'none';
    }
    if (paeCanvas) {
        paeCanvas.style.display = hasPAE ? 'block' : 'none';
    }
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
    // Set renderer flag to skip shadow/tint updates during orient animation for large systems
    if (renderer) {
        renderer.isOrientAnimating = true;
    }
    requestAnimationFrame(animateRotation);
}

function animateRotation() {
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
        renderer.rotationMatrix = rotationAnimation.targetMatrix;
        
        if (rotationAnimation.targetCenter) {
            // Vec3 is defined in viewer-mol.js - access via window or use object literal
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

// Biounit extraction and application functions are now in utils.js
// Using unified functions: extractBiounitOperations, applyBiounitOperationsToAtoms

// Legacy function stubs removed - use utils.js functions directly

function processStructureToTempBatch(text, name, paeData, targetObjectName, tempBatch) {
    let models;
    try {
        const wantBU = !!(window.viewerConfig && window.viewerConfig.biounit);
        const isCIF = /^\s*data_/m.test(text) || /_atom_site\./.test(text);
        
        
        // Parse all models first
        let parseResult;
        let cachedLoops = null;
        if (isCIF) {
            models = parseCIF(text);
            // Get cached loops from parseCIF result (attached as _cachedLoops property)
            cachedLoops = models._cachedLoops || window._lastCIFLoops || null;
        } else {
            parseResult = parsePDB(text);
            models = parseResult.models;
        }
        
        if (!models || models.length === 0 || models.every(m => m.length === 0)) {
            throw new Error(`Could not parse any models or atoms from ${name}.`);
        }
        
        // Apply biounit transformation to all models if requested
        if (wantBU && models.length > 0) {
            
            // Fast-negative: only scan for BU if the file hints it's present
            const hasBiounitHints = isCIF
                ? /_pdbx_struct_(assembly_gen|oper_list)\./.test(text)
                : /REMARK 350/.test(text);
            
            // Extract operations ONCE for all models using unified function
            // Pass cached loops to avoid re-parsing
            const operations = hasBiounitHints ? extractBiounitOperations(text, isCIF, cachedLoops) : null;
            if (hasBiounitHints) {
            }

            if (operations && operations.length > 0) {
                // Apply operations to each model using unified function
                models = models.map(modelAtoms => 
                    applyBiounitOperationsToAtoms(modelAtoms, operations)
                );
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
        }
        // If loading as frames, keep existing frames and append new ones
    }

    const isTrajectory = (loadAsFramesCheckbox.checked ||
        targetObject.frames.length > 0 ||
        models.length > 1);

    function maybeFilterLigands(atoms) {
        const ignore = !!(window.viewerConfig && window.viewerConfig.ignoreLigands);
        if (!ignore) return atoms;
        
        
        // Get MODRES and chemCompMap from global storage (set by parsePDB/parseCIF)
        const modresMap = (typeof window !== 'undefined' && window._lastModresMap) ? window._lastModresMap : null;
        const chemCompMap = (typeof window !== 'undefined' && window._lastChemCompMap) ? window._lastChemCompMap : null;
        
        // Group atoms by residue to check for structural characteristics
        const residueMap = new Map();
        for (const atom of atoms) {
            if (!atom) continue;
            const resKey = `${atom.chain}:${atom.resSeq}:${atom.resName}`;
            if (!residueMap.has(resKey)) {
                residueMap.set(resKey, {
                    resName: atom.resName,
                    record: atom.record,
                    chain: atom.chain,
                    resSeq: atom.resSeq,
                    atoms: []
                });
            }
            residueMap.get(resKey).atoms.push(atom);
        }
        
        // Convert residueMap to array for connectivity checks
        const allResidues = Array.from(residueMap.values());
        
        // Sort residues by chain and resSeq for proper neighbor checking
        allResidues.sort((a, b) => {
            if (a.chain !== b.chain) {
                return a.chain.localeCompare(b.chain);
            }
            return a.resSeq - b.resSeq;
        });
        
        // Use the same classification logic as convertParsedToFrameData
        // to ensure consistency (with connectivity checks)
        const result = atoms.filter(a => {
            if (!a) return false;
            // ATOM records are always kept (standard protein/nucleic)
            if (a.record !== 'HETATM') return true;
            
            // For HETATM: check if it's a real amino acid or nucleic acid
            const resKey = `${a.chain}:${a.resSeq}:${a.resName}`;
            const residue = residueMap.get(resKey);
            if (!residue) return false;
            
            // Find residue index in allResidues array
            const residueIndex = allResidues.findIndex(r => 
                r.chain === residue.chain && r.resSeq === residue.resSeq && r.resName === residue.resName
            );
            
            // Use the unified classification functions from utils.js with connectivity checks
            const is_protein = isRealAminoAcid(residue, modresMap, chemCompMap, allResidues, residueIndex);
            const nucleicType = isRealNucleicAcid(residue, modresMap, chemCompMap, allResidues, residueIndex);
            
            // Keep if it's a real protein or nucleic acid, filter out if it's a ligand
            return is_protein || (nucleicType !== null);
        });
        
        
        return result;
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

        // Convert original model to identify which positions are ligands
        // This is needed to filter PAE matrix correctly
        // We need to identify ligands in the ORIGINAL model to map PAE positions correctly
        // IMPORTANT: includeAllResidues=true ensures ALL residues are included to match PAE matrix size
        const originalFrameData = convertParsedToFrameData(models[i], null, null, true);
        
        // Calculate ligand positions using the same robust classification logic
        // This ensures consistency with maybeFilterLigands and catches misclassified ligands
        const modresMap = (typeof window !== 'undefined' && window._lastModresMap) ? window._lastModresMap : null;
        const chemCompMap = (typeof window !== 'undefined' && window._lastChemCompMap) ? window._lastChemCompMap : null;
        
        // Build residue map from original model for classification
        const originalResidueMap = new Map();
        for (const atom of models[i]) {
            if (!atom || atom.resName === 'HOH') continue;
            const resKey = `${atom.chain}:${atom.resSeq}:${atom.resName}`;
            if (!originalResidueMap.has(resKey)) {
                originalResidueMap.set(resKey, {
                    resName: atom.resName,
                    record: atom.record,
                    chain: atom.chain,
                    resSeq: atom.resSeq,
                    atoms: []
                });
            }
            originalResidueMap.get(resKey).atoms.push(atom);
        }
        
        // Convert to array for connectivity checks
        const originalAllResidues = Array.from(originalResidueMap.values());
        originalAllResidues.sort((a, b) => {
            if (a.chain !== b.chain) {
                return a.chain.localeCompare(b.chain);
            }
            return a.resSeq - b.resSeq;
        });
        
        // Map each position in originalFrameData to its residue and check if it's a ligand
        const originalIsLigandPosition = [];
        
        // Build residue index map to avoid expensive findIndex calls
        const residueIndexMap = new Map(); // resKey -> residueIndex
        for (let i = 0; i < originalAllResidues.length; i++) {
            const residue = originalAllResidues[i];
            const resKey = residue.chain + ':' + residue.resSeq + ':' + residue.resName;
            residueIndexMap.set(resKey, i);
        }
        
        // Cache classification results per residue to avoid re-classifying the same residue
        const residueClassificationCache = new Map(); // resKey -> {is_protein, nucleicType}
        
        if (originalFrameData.atom_types && originalFrameData.residues && originalFrameData.residue_index) {
            for (let idx = 0; idx < originalFrameData.atom_types.length; idx++) {
                const atomType = originalFrameData.atom_types[idx];
                const resName = originalFrameData.residues[idx];
                const resSeq = originalFrameData.residue_index[idx];
                const chain = originalFrameData.chains ? originalFrameData.chains[idx] : '';
                
                // Find the residue in the original model
                const resKey = chain + ':' + resSeq + ':' + resName;
                const residue = originalResidueMap.get(resKey);
                
                if (residue) {
                    // Check cache first to avoid re-classifying the same residue
                    let classification = residueClassificationCache.get(resKey);
                    if (!classification) {
                        // Get residue index from map (much faster than findIndex)
                        const residueIndex = residueIndexMap.get(resKey);
                        
                        // Use the same classification logic as maybeFilterLigands (with connectivity checks)
                        // Note: We pass originalAllResidues and residueIndex for connectivity checks
                        const is_protein = isRealAminoAcid(residue, modresMap, chemCompMap, originalAllResidues, residueIndex !== undefined ? residueIndex : -1);
                        const nucleicType = isRealNucleicAcid(residue, modresMap, chemCompMap, originalAllResidues, residueIndex !== undefined ? residueIndex : -1);
                        
                        // Cache the result
                        classification = { is_protein, nucleicType };
                        residueClassificationCache.set(resKey, classification);
                    }
                    
                    // It's a ligand if it's NOT protein AND NOT nucleic acid
                    originalIsLigandPosition.push(!classification.is_protein && classification.nucleicType === null);
                } else {
                    // If we can't find the residue, use the atom type as fallback
                    originalIsLigandPosition.push(atomType === 'L');
                }
            }
        } else {
            // Fallback: use atom_types if available
            originalIsLigandPosition.push(...(originalFrameData.atom_types ? 
                originalFrameData.atom_types.map(type => type === 'L') : 
                Array(originalFrameData.coords.length).fill(false)));
        }
        
        // Filter ligands from model
        const model = maybeFilterLigands(models[i]);
        const originalAtomCount = models[i].length;
        const filteredAtomCount = model.length;
        
        // Convert filtered model to get final frame data
        let frameData = convertParsedToFrameData(model);
        if (frameData.coords.length === 0) continue;

        // Store PAE data
        if (paeData) {
            const ignoreLigands = !!(window.viewerConfig && window.viewerConfig.ignoreLigands);
            if (ignoreLigands && originalIsLigandPosition.length > 0) {
                // PAE matrix indices map directly to atom indices in originalFrameData
                // We need to filter out ligand positions from the PAE matrix
                
                // Count total ligands identified
                const totalLigands = originalIsLigandPosition.filter(x => x).length;
                
                // First, check if PAE size matches originalFrameData size
                if (paeData.length === originalIsLigandPosition.length) {
                    // Sizes match - PAE includes all positions, filter out ligands
                    frameData.pae = filterPAEForLigands(paeData, originalIsLigandPosition);
                    if (totalLigands > 0) {
                        console.log(`Filtered ${totalLigands} ligand positions from PAE matrix (size ${paeData.length} -> ${frameData.pae.length})`);
                    }
                } else if (paeData.length < originalIsLigandPosition.length) {
                    // PAE is smaller - it might already exclude ligands, but we need to verify
                    // Count how many ligands are in the first paeData.length positions
                    let ligandCountInPAERange = 0;
                    for (let i = 0; i < paeData.length; i++) {
                        if (originalIsLigandPosition[i]) {
                            ligandCountInPAERange++;
                        }
                    }
                    
                    if (ligandCountInPAERange > 0) {
                        // PAE includes some ligands in its range, filter them out
                        // Create a truncated ligand position array for the PAE range
                        const truncatedLigandPositions = originalIsLigandPosition.slice(0, paeData.length);
                        frameData.pae = filterPAEForLigands(paeData, truncatedLigandPositions);
                        console.log(`Filtered ${ligandCountInPAERange} ligand positions from PAE matrix (size ${paeData.length} -> ${frameData.pae.length})`);
                    } else {
                        // No ligands in PAE range - PAE already excludes ligands, use as-is
                        frameData.pae = paeData.map(row => [...row]);
                        if (totalLigands > 0) {
                            console.log(`PAE matrix (size ${paeData.length}) already excludes ${totalLigands} ligands found in structure`);
                        }
                    }
                } else {
                    // PAE is larger - truncate to match originalFrameData size, then filter
                    console.warn(`PAE matrix size (${paeData.length}) is larger than frame data size (${originalIsLigandPosition.length}). Truncating and filtering...`);
                    const truncatedPae = paeData.slice(0, originalIsLigandPosition.length).map(row => 
                        row.slice(0, originalIsLigandPosition.length)
                    );
                    frameData.pae = filterPAEForLigands(truncatedPae, originalIsLigandPosition);
                }
            } else {
                frameData.pae = paeData.map(row => [...row]);
            }
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
    const topPanelContainer = document.getElementById('sequence-viewer-container');
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

    // Enable batch loading mode to skip renders during addFrame
    if (viewerApi?.renderer) {
        viewerApi.renderer._batchLoading = true;
    }
    
    for (const obj of batchedObjects) {
        if (obj.frames.length > 0) {
            viewerApi.handlePythonNewObject(obj.name);
            
            lastObjectName = obj.name;
            
            let jsonStringifyTime = 0;
            let updateTime = 0;
            for (const frame of obj.frames) {
                const stringifyStart = performance.now();
                const frameJson = JSON.stringify(frame);
                const stringifyEnd = performance.now();
                jsonStringifyTime += (stringifyEnd - stringifyStart);
                
                const updateStart = performance.now();
                viewerApi.handlePythonUpdate(frameJson, obj.name);
                const updateEnd = performance.now();
                updateTime += (updateEnd - updateStart);
                
                totalFrames++;
            }
            
            // Update objectsWithPAE Set (fallback for backward compatibility)
            if (checkObjectHasPAE(obj)) {
                objectsWithPAE.add(obj.name);
            }
        }
    }
    
    // Disable batch loading mode
    if (viewerApi?.renderer) {
        viewerApi.renderer._batchLoading = false;
    }
    
    if (viewerApi?.renderer && typeof viewerApi.renderer.updatePAEContainerVisibility === 'function') {
        viewerApi.renderer.updatePAEContainerVisibility();
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
                    viewerApi.renderer.lastRenderedFrame = -1; // Mark as needing render
                }
            }
            
            // Now set the select value (this will trigger change event, but we've already set everything up)
            objectSelect.value = lastObjectName;
            
            // Skip handleObjectChange during initial load - we'll do the work directly
            // handleObjectChange() does: resetToDefault(), updatePAEContainerVisibility(), buildSequenceView(), updateChainSelectionUI()
            // But we've already loaded the frame data, so we can skip resetToDefault and do the rest directly
            
            // Only update PAE visibility (resetToDefault is not needed for initial load)
            if (viewerApi?.renderer && typeof viewerApi.renderer.updatePAEContainerVisibility === 'function') {
                viewerApi.renderer.updatePAEContainerVisibility();
            }
            
            
            updateObjectNavigationButtons();
            
            buildSequenceView();
            
            // Skip updateChainSelectionUI during initial load - setSelection is expensive
            // The renderer already defaults to showing all atoms, so we don't need to explicitly set it
            // We'll let it default naturally, or set it after the first render
            // Defer updateChainSelectionUI - it's expensive and not needed for initial display
            // The structure will render with default "all atoms visible" state
            // We can call it later if needed, or skip it entirely since default is "all"
            // updateChainSelectionUI(); // Skip during initial load for performance
            
            
            // Update UI controls first
            if (viewerApi && viewerApi.renderer) {
                viewerApi.renderer.updateUIControls();
            }
            
            // Auto-orient to the newly loaded object (no animation for initial load)
            // This will render after orient is complete
            // We do this BEFORE the initial render so the structure appears in the correct orientation
            if (viewerApi && viewerApi.renderer && viewerApi.renderer.currentObjectName === lastObjectName) {
                const object = viewerApi.renderer.objectsData[lastObjectName];
                if (object && object.frames.length > 0) {
                    applyBestViewRotation(false); // Skip animation for initial orient, renders after
                }
            }
            
            // Render once at the end (after orientation is complete)
            // applyBestViewRotation already renders, but we ensure it's rendered here too
            if (viewerApi && viewerApi.renderer && viewerApi.renderer.currentObjectName === lastObjectName) {
                const object = viewerApi.renderer.objectsData[lastObjectName];
                if (object && object.frames.length > 0 && viewerApi.renderer.lastRenderedFrame !== viewerApi.renderer.currentFrame) {
                    viewerApi.renderer.render();
                    viewerApi.renderer.lastRenderedFrame = viewerApi.renderer.currentFrame;
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

  // Optimize: Use more efficient Set construction
  // Instead of adding one by one, build chains Set first, then atoms
  const allChains = new Set(frame0.chains);
  
  // For atoms, if we're selecting all, we can use a more efficient approach
  // Check if selection is already "all" (default mode with no explicit atoms)
  const currentSelection = viewerApi.renderer.getSelection();
  const isAlreadyAll = currentSelection.selectionMode === 'default' && 
                       currentSelection.atoms.size === 0 &&
                       (currentSelection.chains.size === 0 || 
                        currentSelection.chains.size === allChains.size);
  
  if (isAlreadyAll) {
    // Already in default "all" state, no need to update
    return;
  }

  // Select all by default using renderer API (use atoms, not residues)
  // Optimize: Build Set more efficiently
  const n = frame0.chains.length;
  const allAtoms = new Set();
  // Pre-allocate Set capacity hint (not standard JS, but helps some engines)
  for (let i = 0; i < n; i++) {
    allAtoms.add(i); // One atom = one position
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
  
  // Use explicit mode if we have partial selections OR if not all chains are selected OR if no atoms are selected
  // This allows all chains to be deselected (empty chains set with explicit mode)
  const selectionMode = (allChainsSelected && !hasPartialSelections && newAtoms.size > 0) ? 'default' : 'explicit';
  
  // If all chains are selected AND no partial selections AND we have atoms, use empty chains set with default mode
  // Otherwise, keep explicit chain selection (allows empty chains)
  const chainsToSet = (allChainsSelected && !hasPartialSelections && newAtoms.size > 0) ? new Set() : newChains;
  
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
    // Chain buttons and sequence are now drawn on canvas, update via updateSequenceViewSelectionState
    // The function will check internally if canvas data exists
    updateSequenceViewSelectionState();
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
        // Draw highlights on overlay canvas without re-rendering main scene
        if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
            window.SequenceViewer.drawHighlights();
        }
    }
}

function highlightAtoms(atomIndices) {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedAtoms = atomIndices instanceof Set ? atomIndices : new Set(atomIndices);
        viewerApi.renderer.highlightedAtom = null; // Clear single atom highlight
        viewerApi.renderer.highlightedResidue = null; // Clear legacy highlight
        // Draw highlights on overlay canvas without re-rendering main scene
        if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
            window.SequenceViewer.drawHighlights();
        }
    }
}

function clearHighlight() {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedResidue = null;
        viewerApi.renderer.highlightedAtom = null;
        viewerApi.renderer.highlightedAtoms = null;
        // Clear highlights on overlay canvas without re-rendering main scene
        if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
            window.SequenceViewer.drawHighlights();
        }
    }
}

function showAllResidues() {
  if (!viewerApi?.renderer) return;
  // Reset to default (show all residues/chains) - this also clears PAE boxes
  viewerApi.renderer.resetToDefault();
  // UI will update via event listener
}

function hideAllResidues() {
  if (!viewerApi?.renderer) return;
  // Use renderer's clearSelection method to hide all
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
    const topPanelContainer = document.getElementById('sequence-viewer-container');
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

// Sequence viewer is now in viewer-seq.js module
// Set up callbacks to connect module to web app functions
if (window.SequenceViewer) {
    window.SequenceViewer.setCallbacks({
        getRenderer: () => viewerApi?.renderer || null,
        getObjectSelect: () => document.getElementById('objectSelect'),
        toggleChainResidues: toggleChainResidues,
        setChainResiduesSelected: setChainResiduesSelected,
        highlightAtom: highlightAtom,
        highlightAtoms: highlightAtoms,
        clearHighlight: clearHighlight,
        applySelection: applySelection,
        getPreviewSelectionSet: () => previewSelectionSet,
        setPreviewSelectionSet: (set) => { previewSelectionSet = set; }
    });
    
    // Initialize highlight overlay after viewer is created
    // This will be called after initializePy2DmolViewer completes
    function initializeHighlightOverlayIfNeeded() {
        if (viewerApi?.renderer && window.SequenceViewer && window.SequenceViewer.drawHighlights) {
            // Trigger initialization by calling drawHighlights (which will initialize if needed)
            // But first make sure we have a renderer with canvas
            const renderer = viewerApi.renderer;
            if (renderer.canvas) {
                // Force initialization by calling the internal function
                // We'll do this by calling drawHighlights which will lazy-init
                window.SequenceViewer.drawHighlights();
            }
        }
    }
    
    // Initialize overlay when viewer is ready
    if (viewerApi?.renderer) {
        initializeHighlightOverlayIfNeeded();
    }
}

// MSA viewer initialization
if (window.MSAViewer) {
    window.MSAViewer.setCallbacks({
        getRenderer: () => viewerApi?.renderer || null,
        getObjectSelect: () => document.getElementById('objectSelect'),
        highlightAtom: highlightAtom,
        highlightAtoms: highlightAtoms,
        clearHighlight: clearHighlight,
        applySelection: applySelection,
        getPreviewSelectionSet: () => previewSelectionSet,
        setPreviewSelectionSet: (set) => { previewSelectionSet = set; }
    });
}

// MSA viewer controls - simplified (no show/hide, just mode toggle)
// Expose functions globally for use in other parts of the codebase
window.MSAViewerControls = {
    isVisible: function() {
        const msaView = document.getElementById('msaView');
        if (!msaView) return false;
        return !msaView.classList.contains('hidden');
    },
    
    show: function() {
        const msaContainer = document.getElementById('msa-viewer-container');
        
        // Ensure container is visible
        if (msaContainer) {
            msaContainer.style.setProperty('display', 'block', 'important');
        }
        
        // Show and rebuild the view
        const msaView = document.getElementById('msaView');
        if (msaView) {
            msaView.classList.remove('hidden');
            
            // Rebuild view if MSA data exists
            if (window.MSAViewer) {
                const currentMode = window.MSAViewer.getMSAMode ? window.MSAViewer.getMSAMode() : 'msa';
                window.MSAViewer.setMSAMode(currentMode);
            }
        }
    },
    
    hide: function() {
        const msaContainer = document.getElementById('msa-viewer-container');
        
        // Keep container visible (so header/button remains visible)
        if (msaContainer) {
            msaContainer.style.setProperty('display', 'block', 'important');
        }
        
        // Hide and clear the view content only
        const msaView = document.getElementById('msaView');
        if (msaView) {
            msaView.classList.add('hidden');
            msaView.innerHTML = ''; // Clear rendered content
        }
    }
};

function initializeMSAViewer() {
    const msaContainer = document.getElementById('msa-viewer-container');
    const msaModeSelect = document.getElementById('msaModeSelect');
    const coverageSlider = document.getElementById('coverageSlider');
    const coverageValue = document.getElementById('coverageValue');
    const identitySlider = document.getElementById('identitySlider');
    const identityValue = document.getElementById('identityValue');
    
    // MSA viewer will be shown/hidden based on whether MSA data exists
    // Container starts hidden, will be shown when MSA data is loaded
    
    // Initialize coverage slider
    if (coverageSlider && coverageValue && window.MSAViewer) {
        // Set initial value (75% = 0.75)
        const initialCutoff = window.MSAViewer.getCoverageCutoff ? window.MSAViewer.getCoverageCutoff() : 0.75;
        coverageSlider.value = Math.round(initialCutoff * 100);
        coverageValue.textContent = Math.round(initialCutoff * 100) + '%';
        
        let isDragging = false;
        
        // Update preview value during drag
        coverageSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            coverageValue.textContent = value + '%';
            const cutoff = value / 100;
            if (window.MSAViewer && window.MSAViewer.setPreviewCoverageCutoff) {
                window.MSAViewer.setPreviewCoverageCutoff(cutoff);
            }
            isDragging = true;
        });
        
        // Apply on mouseup
        coverageSlider.addEventListener('mouseup', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewCoverageCutoff) {
                window.MSAViewer.applyPreviewCoverageCutoff();
                isDragging = false;
            }
        });
        
        // Also handle touch events for mobile
        coverageSlider.addEventListener('touchend', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewCoverageCutoff) {
                window.MSAViewer.applyPreviewCoverageCutoff();
                isDragging = false;
            }
        });
    }
    
    // Initialize identity slider
    if (identitySlider && identityValue && window.MSAViewer) {
        // Set initial value (15% = 0.15)
        const initialCutoff = window.MSAViewer.getIdentityCutoff ? window.MSAViewer.getIdentityCutoff() : 0.15;
        identitySlider.value = Math.round(initialCutoff * 100);
        identityValue.textContent = Math.round(initialCutoff * 100) + '%';
        
        let isDragging = false;
        
        // Update preview value during drag
        identitySlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            identityValue.textContent = value + '%';
            const cutoff = value / 100;
            if (window.MSAViewer && window.MSAViewer.setPreviewIdentityCutoff) {
                window.MSAViewer.setPreviewIdentityCutoff(cutoff);
            }
            isDragging = true;
        });
        
        // Apply on mouseup
        identitySlider.addEventListener('mouseup', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewIdentityCutoff) {
                window.MSAViewer.applyPreviewIdentityCutoff();
                isDragging = false;
            }
        });
        
        // Also handle touch events for mobile
        identitySlider.addEventListener('touchend', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewIdentityCutoff) {
                window.MSAViewer.applyPreviewIdentityCutoff();
                isDragging = false;
            }
        });
    }
    
    // Handle MSA mode dropdown selection
    if (msaModeSelect && window.MSAViewer) {
        // Set initial value
        const initialMode = window.MSAViewer.getMSAMode ? window.MSAViewer.getMSAMode() : 'msa';
        msaModeSelect.value = initialMode;
        
        // Handle mode change
        msaModeSelect.addEventListener('change', (e) => {
            const newMode = e.target.value;
            window.MSAViewer.setMSAMode(newMode);
        });
    }
}

// Initialize MSA viewer on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeMSAViewer);
} else {
    initializeMSAViewer();
}

// Wrapper functions that delegate to SequenceViewer module
function buildSequenceView() {
    if (window.SequenceViewer) {
        window.SequenceViewer.buildSequenceView();
    }
}

// Old sequence viewer code removed - now in viewer-seq.js module

// HTML-based sequence event handlers using event delegation
// Now handled by viewer-seq.js module

// Sequence viewer functions now in viewer-seq.js module
// Wrapper functions for backward compatibility
function updateSequenceViewColors() {
    if (window.SequenceViewer) {
        window.SequenceViewer.updateSequenceViewColors();
    }
}

function updateSequenceViewSelectionState() {
    if (window.SequenceViewer) {
        window.SequenceViewer.updateSequenceViewSelectionState();
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

        // Download MSA for AlphaFold DB predictions (non-blocking, in background)
        if (isAFDB && window.MSAViewer) {
            // Skip MSA download if running from file:// protocol (CORS won't work)
            if (window.location.protocol === 'file:') {
                console.warn("MSA download skipped: CORS not available when running from file:// protocol. Please use a web server (http:// or https://).");
            } else {
                // Don't await - let it load in background while structure is displayed
                (async () => {
                    const msaUrl = `https://alphafold.ebi.ac.uk/files/msa/AF-${fetchId}-F1-msa_v6.a3m`;
                    
                    // Use custom proxy if available (e.g., your own server with CORS headers)
                    // Set window.msaProxyUrl to your proxy endpoint, e.g., '/api/msa-proxy?url='
                    const customProxy = window.msaProxyUrl;
                    
                    let msaText = null;
                    
                    // Try direct fetch first (fastest if CORS allows)
                    try {
                        const directResponse = await fetch(msaUrl);
                        if (directResponse.ok) {
                            msaText = await directResponse.text();
                        }
                    } catch (e) {
                        // Direct fetch failed (likely CORS), try proxies
                        console.log("Direct MSA fetch failed, trying proxy...");
                        
                        // Try custom proxy first if configured
                        if (customProxy && !msaText) {
                            try {
                                const proxyResponse = await fetch(`${customProxy}${encodeURIComponent(msaUrl)}`);
                                if (proxyResponse.ok) {
                                    msaText = await proxyResponse.text();
                                    console.log("MSA loaded via custom proxy");
                                }
                            } catch (proxyError) {
                                console.warn("Custom proxy failed:", proxyError.message);
                            }
                        }
                        
                        // Fallback to public proxy
                        if (!msaText) {
                            try {
                                const publicProxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(msaUrl)}`;
                                const proxyResponse = await fetch(publicProxyUrl);
                                if (proxyResponse.ok) {
                                    const proxyData = await proxyResponse.json();
                                    msaText = proxyData.contents;
                                    console.log("MSA loaded via public CORS proxy");
                                }
                            } catch (proxyError) {
                                console.warn("Public proxy also failed:", proxyError.message);
                            }
                        }
                    }
                    
                    // Parse and load MSA if we got the data
                    if (msaText) {
                        try {
                            const msaData = window.MSAViewer.parseA3M(msaText);
                            if (msaData) {
                                window.MSAViewer.setMSAData(msaData);
                                console.log(`MSA loaded from AlphaFold DB (${msaData.sequences.length} sequences)`);
                            }
                        } catch (parseError) {
                            console.warn("Could not parse MSA data:", parseError.message);
                        }
                    } else {
                        console.warn("Could not fetch MSA data from any source");
                    }
                })();
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
    const msaFiles = [];

    // First pass: identify state files and MSA files
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
        } else if (nameLower.endsWith('.a3m')) {
            msaFiles.push(file);
        }
    }
    
    // Process MSA files
    if (msaFiles.length > 0) {
        for (const msaFile of msaFiles) {
            try {
                const msaText = await msaFile.readAsync("text");
                        const msaData = window.MSAViewer ? window.MSAViewer.parseA3M(msaText) : null;
                        if (msaData && window.MSAViewer) {
                            window.MSAViewer.setMSAData(msaData);
                            // Container will be shown automatically by setMSAData
                            setStatus(`Loaded MSA from ${msaFile.name} (${msaData.sequences.length} sequences)`);
                        }
            } catch (e) {
                console.error(`Failed to parse MSA file ${msaFile.name}:`, e);
                setStatus(`Error parsing MSA file ${msaFile.name}: ${e.message}`, true);
            }
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

        // Group files by directory (folder)
        // Key: directory path (empty string for root), Value: array of files in that directory
        const filesByDirectory = new Map();
        
        content.forEach((relativePath, zipEntry) => {
            if (relativePath.startsWith('__MACOSX/') ||
                relativePath.startsWith('._') ||
                zipEntry.dir) return;
            
            const normalizedPath = relativePath.replace(/^\/+|\/+$/g, ''); // Remove leading/trailing slashes
            const fileName = normalizedPath.split('/').pop(); // Get just the filename
            
            // Check if it's a structural, JSON, or MSA file by extension
            const nameLower = fileName.toLowerCase();
            if (!nameLower.match(/\.(cif|pdb|ent|json|a3m)$/)) {
                // Not a structural, JSON, or MSA file, skip it
                return;
            }
            
            // Determine directory path (empty string for root)
            const dirPath = normalizedPath.includes('/') 
                ? normalizedPath.substring(0, normalizedPath.lastIndexOf('/'))
                : ''; // Root directory
            
            const fileEntry = {
                name: fileName, // Use just the filename, not the full path
                readAsync: (type) => zipEntry.async(type)
            };
            
            // Group by directory
            if (!filesByDirectory.has(dirPath)) {
                filesByDirectory.set(dirPath, []);
            }
            filesByDirectory.get(dirPath).push(fileEntry);
        });
        
        // If no files found, throw error
        if (filesByDirectory.size === 0) {
            throw new Error(`No structural files (*.cif, *.pdb, *.ent) found.`);
        }
        
        // Determine which directories to process
        // Only go to subdirectories if no files found in root
        const rootFiles = filesByDirectory.get('');
        const directoriesToProcess = [];
        
        if (rootFiles && rootFiles.length > 0) {
            // Root has files, only process root
            directoriesToProcess.push('');
        } else {
            // Root has no files, process all subdirectories
            const subdirs = Array.from(filesByDirectory.keys()).filter(path => path !== '').sort();
            directoriesToProcess.push(...subdirs);
        }
        
        // If still no directories to process, throw error
        if (directoriesToProcess.length === 0) {
            throw new Error(`No structural files (*.cif, *.pdb, *.ent) found.`);
        }
        
        // Process each directory separately
        let totalObjectsLoaded = 0;
        let totalFramesAdded = 0;
        let totalPaePairedCount = 0;
        
        for (const dirPath of directoriesToProcess) {
            const fileList = filesByDirectory.get(dirPath);
            
            // Determine group name: use directory name if in subdirectory, otherwise use ZIP filename
            const groupName = dirPath 
                ? cleanObjectName(dirPath.split('/').pop()) // Use folder name
                : cleanObjectName(file.name.replace(/\.zip$/i, '')); // Use ZIP filename for root

            // Check if this directory contains a state file (only check once for root)
            if (dirPath === '') {
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
            }

            // Process files in this directory as a separate object
            const stats = await processFiles(fileList, loadAsFrames, groupName);
            
            totalObjectsLoaded += (stats.isTrajectory ? 1 : stats.objectsLoaded);
            totalFramesAdded += stats.framesAdded;
            totalPaePairedCount += stats.paePairedCount;
        }

        // Update status with totals
        const paeMessage = totalPaePairedCount > 0 ?
            ` (${totalPaePairedCount} PAE matrices paired)` : '';

        setStatus(
            `Successfully loaded ${totalObjectsLoaded} new object(s) from ${file.name} ` +
            `(${totalFramesAdded} total frame${totalFramesAdded !== 1 ? 's' : ''}${paeMessage}).`
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

function detectRedundantFields(frames) {
    /**
     * Detect fields that are identical across all frames.
     * Returns object with field_name: value for redundant fields.
     */
    if (!frames || frames.length === 0) return {};
    
    const redundant = {};
    for (const field of ['chains', 'atom_types']) {
        // Find first non-null value
        let firstValue = null;
        for (const frame of frames) {
            if (frame[field] != null) {
                firstValue = frame[field];
                break;
            }
        }
        
        if (firstValue == null) continue;
        
        // Check if all frames have same value (or null/undefined)
        const allSame = frames.every(f => 
            f[field] == null || JSON.stringify(f[field]) === JSON.stringify(firstValue)
        );
        
        if (allSame) {
            redundant[field] = firstValue;
        }
    }
    
    return redundant;
}

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
            const frameDataList = [];
            
            // Collect all frame data
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
                if (frame.residue_index) frameData.residue_index = frame.residue_index;
                
                // Map modified residues to standard equivalents (e.g., MSE -> MET)
                if (frame.residues) {
                    frameData.residues = frame.residues.map(resName => {
                        // Use getStandardResidueName from utils.js if available
                        if (typeof getStandardResidueName === 'function') {
                            return getStandardResidueName(resName);
                        }
                        return resName; // Fallback if function not available
                    });
                }
                
                // Round PAE to 1 decimal place
                if (frame.pae) {
                    frameData.pae = frame.pae.map(row => 
                        row.map(val => Math.round(val * 10) / 10)
                    );
                }
                
                frameDataList.push(frameData);
            }
            
            // Detect redundant fields (same across all frames)
            const redundant = detectRedundantFields(frameDataList);
            
            // Remove redundant fields from frames (only if identical)
            const frames = [];
            for (const frameData of frameDataList) {
                const cleanedFrame = {...frameData};
                for (const field in redundant) {
                    if (cleanedFrame[field] != null && 
                        JSON.stringify(cleanedFrame[field]) === JSON.stringify(redundant[field])) {
                        delete cleanedFrame[field];
                    }
                }
                frames.push(cleanedFrame);
            }
            
            // Create object with redundant fields at object level
            const objToSave = {
                name: objectName,
                frames: frames,
                hasPAE: checkObjectHasPAE({frames: frames})
            };
            // Add redundant fields to object level (only if detected)
            Object.assign(objToSave, redundant);
            
            objects.push(objToSave);
        }
        
        // Get viewer state
        const orthoSlider = document.getElementById('orthoSlider');
        const orthoSliderValue = orthoSlider ? parseFloat(orthoSlider.value) : 1.0;
        
        const viewerState = {
            current_object_name: renderer.currentObjectName,
            current_frame: renderer.currentFrame,
            rotation_matrix: renderer.rotationMatrix,
            zoom: renderer.zoom,
            color_mode: renderer.colorMode || 'auto',
            line_width: renderer.lineWidth || 3.0,
            shadow_enabled: renderer.shadowEnabled !== false,
            depth_enabled: renderer.depthEnabled !== false,
            outline_mode: renderer.outlineMode || 'full',
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
            py2dmol_version: "2.0",
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
// SVG export is now handled by renderer.saveAsSvg() in viewer-mol.js
// The renderer automatically detects if setStatus() is available (index.html) 
// or uses console.log/alert (viewer.html)

async function loadViewerState(stateData) {
    if (!viewerApi || !viewerApi.renderer) {
        setStatus("Error: Viewer not initialized.", true);
        return;
    }
    
    const renderer = viewerApi.renderer;
    
    try {
        // Validate version
        const version = stateData.py2dmol_version || "2.0";
        if (version !== "2.0") {
            console.warn(`State file version ${version} may not be fully compatible. Expected 2.0.`);
        }
        
        // Clear existing objects
        renderer.clearAllObjects();
        objectsWithPAE.clear();
        
        // Ensure viewer container is visible
        const viewerContainer = document.getElementById('viewer-container');
        const topPanelContainer = document.getElementById('sequence-viewer-container');
        if (viewerContainer) viewerContainer.style.display = 'flex';
        if (topPanelContainer) topPanelContainer.style.display = 'block';
        
        // Restore objects
        if (stateData.objects && Array.isArray(stateData.objects) && stateData.objects.length > 0) {
            for (const objData of stateData.objects) {
                if (!objData.name || !objData.frames || !Array.isArray(objData.frames) || objData.frames.length === 0) {
                    console.warn("Skipping invalid object in state file:", objData);
                    continue;
                }
                
                // Get object-level defaults (may be undefined)
                const objChains = objData.chains;
                const objAtomTypes = objData.atom_types;
                
                renderer.addObject(objData.name);
                
                // Temporarily disable auto frame setting during batch load
                const wasPlaying = renderer.isPlaying;
                renderer.isPlaying = true; // Prevent setFrame from being called during addFrame
                
                for (const frameData of objData.frames) {
                    // Robust resolution: frame-level > object-level > undefined (will use defaults)
                    if (!frameData.coords || frameData.coords.length === 0) {
                        console.warn("Skipping frame with no coordinates");
                        continue;
                    }
                    
                    // Resolve with fallbacks (undefined will trigger defaults in addFrame/setCoords)
                    const resolvedFrame = {
                        coords: frameData.coords,
                        chains: frameData.chains || objChains,  // undefined if both missing
                        atom_types: frameData.atom_types || objAtomTypes,  // undefined if both missing
                        plddts: frameData.plddts,  // undefined if missing (will use inheritance or default)
                        pae: frameData.pae,  // undefined if missing (will use inheritance or default)
                        residues: frameData.residues,  // undefined if missing (will default)
                        residue_index: frameData.residue_index  // undefined if missing (will default)
                    };
                    
                    renderer.addFrame(resolvedFrame, objData.name);
                }
                
                // Restore playing state
                renderer.isPlaying = wasPlaying;
                
                // Check if object has PAE data (checks frames directly)
                if (checkObjectHasPAE(objData)) {
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
            
            // Restore depth
            if (typeof vs.depth_enabled === 'boolean') {
                renderer.depthEnabled = vs.depth_enabled;
                const depthCheckbox = document.getElementById('depthCheckbox');
                if (depthCheckbox) {
                    depthCheckbox.checked = vs.depth_enabled;
                    depthCheckbox.dispatchEvent(new Event('change'));
                }
            }
            
            // Restore outline mode
            if (typeof vs.outline_mode === 'string' && ['none', 'partial', 'full'].includes(vs.outline_mode)) {
                renderer.outlineMode = vs.outline_mode;
                renderer.updateOutlineButtonStyle();
            } else if (typeof vs.outline_enabled === 'boolean') {
                // Legacy boolean support
                renderer.outlineMode = vs.outline_enabled ? 'full' : 'none';
                renderer.updateOutlineButtonStyle();
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