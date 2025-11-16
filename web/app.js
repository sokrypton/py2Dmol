// ============================================================================
// APP.JS - Application logic, UI handlers, and initialization
// ============================================================================

// ============================================================================
// GLOBAL STATE
// ============================================================================

let viewerApi = null;
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
    
    // Setup MSA viewer callbacks (after viewerApi is initialized)
    if (window.MSAViewer) {
        window.MSAViewer.setCallbacks({
            getRenderer: () => viewerApi?.renderer || null,
            getObjectSelect: () => document.getElementById('objectSelect'),
            highlightAtom: highlightPosition,
            highlightAtoms: highlightPositions,
            clearHighlight: clearHighlight,
            applySelection: applySelection,
            onMSAFilterChange: (filteredMSAData, chainId) => {
                // Recompute properties when MSA filters change
                // The filtered MSA data needs to have frequencies, entropy, and logOdds recomputed
                if (!viewerApi?.renderer || !chainId || !filteredMSAData) return;
                
                const objectName = viewerApi.renderer.currentObjectName;
                if (!objectName) return;
                
                const obj = viewerApi.renderer.objectsData[objectName];
                if (!obj || !obj.msa) return;
                
                // Recompute properties for filtered MSA data
                // This updates msaData.frequencies, msaData.entropy, msaData.logOdds
                computeMSAProperties(filteredMSAData);
                
                // NOTE: We do NOT overwrite stored msaEntry.msaData with filtered data
                // The stored msaEntry.msaData remains the canonical unfiltered source
                // The viewer maintains its own filtered copy internally
                
                // Invalidate entropy cache since entropy was recalculated
                if (viewerApi.renderer) {
                    viewerApi.renderer.cachedResolvedEntropy = null;
                    viewerApi.renderer.cachedEntropyObjectName = null;
                    viewerApi.renderer.cachedEntropyPositionCount = null;
                }
                
                // If entropy color mode is active, update the renderer and re-render
                if (viewerApi.renderer.colorMode === 'entropy') {
                    // Reload current frame data to update entropy
                    const currentFrameIndex = viewerApi.renderer.currentFrame || 0;
                    viewerApi.renderer._loadFrameData(currentFrameIndex, false); // false = render immediately
                }
            }
        });
    }
    
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
                
                // Also apply selection to MSA viewer
                applySelectionToMSA();
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
    // Sequence view mode dropdown
    const sequenceModeSelect = document.getElementById('sequenceModeSelect');
    
    // Helper function to sync dropdown with current mode
    function updateSequenceModeDropdown() {
        if (sequenceModeSelect && window.SequenceViewer) {
            const currentMode = window.SequenceViewer.getSequenceViewMode ? window.SequenceViewer.getSequenceViewMode() : true;
            sequenceModeSelect.value = currentMode ? 'sequence' : 'chain';
        }
    }
    
    if (sequenceModeSelect && window.SequenceViewer) {
        // Set initial value
        const initialMode = window.SequenceViewer.getSequenceViewMode ? window.SequenceViewer.getSequenceViewMode() : true;
        sequenceModeSelect.value = initialMode ? 'sequence' : 'chain';
        
        // Handle mode change
        sequenceModeSelect.addEventListener('change', (e) => {
            const mode = e.target.value;
            const sequenceMode = mode === 'sequence';
            if (window.SequenceViewer) {
                window.SequenceViewer.setSequenceViewMode(sequenceMode);
            }
            // Always try to rebuild - buildSequenceView() will return early if no data is available
            buildSequenceView();
        });
    }
    
    // Initialize sequence mode to enabled by default
    if (window.SequenceViewer) {
        window.SequenceViewer.setSequenceViewMode(true);
    }
    
    // Initialize dropdown state to reflect default sequence mode
    updateSequenceModeDropdown();
    
    // Expose update function globally for programmatic mode changes
    window.updateSequenceModeDropdown = updateSequenceModeDropdown;
    
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
        
        const totalPositions = frame.coords.length;
        const selection = renderer.getSelection();
        
        // Get selected positions
        let selectedPositions = new Set();
        if (selection && selection.positions && selection.positions.size > 0) {
            selectedPositions = new Set(selection.positions);
        } else if (renderer.visibilityMask !== null && renderer.visibilityMask.size > 0) {
            selectedPositions = new Set(renderer.visibilityMask);
        } else {
            // No selection or all positions visible (default mode)
            selectedPositions = new Set();
            for (let i = 0; i < totalPositions; i++) {
                selectedPositions.add(i);
            }
        }
        
        // Enable only if selection is non-zero and non-full-length
        const hasSelection = selectedPositions.size > 0;
        const isPartialSelection = selectedPositions.size > 0 && selectedPositions.size < totalPositions;
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
        
        // If entropy mode is selected, ensure entropy data is calculated and available
        if (viewerApi?.renderer && viewerApi.renderer.colorMode === 'entropy') {
            ensureEntropyDataAvailable();
        }
    });
    
    // Listen for selection changes (including PAE selections)
    document.addEventListener('py2dmol-selection-change', (e) => {
        // Sync chain pills with selection model
        syncChainPillsToSelection();
        // Update sequence view
        updateSequenceViewSelectionState();
        // Update MSA selection mapping and view
        applySelectionToMSA();
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
    // Check if we're on msa.html (has status-message with different styling) or index.html
    const statusElement = document.getElementById('status-message');
    if (statusElement) {
        // msa.html style
    statusElement.textContent = message;
        statusElement.style.display = 'block';
        statusElement.className = isError ? 'error' : 'info';
        
        // Keep messages visible - do not auto-hide
    } else {
        // index.html style (fallback if status-message doesn't exist)
        const statusElementIndex = document.getElementById('status');
        if (statusElementIndex) {
            statusElementIndex.textContent = message;
            statusElementIndex.className = `mt-4 text-sm font-medium ${
        isError ? 'text-red-700 bg-red-100 border-red-200' : 'text-blue-700 bg-blue-50 border-blue-200'
    } p-2 rounded-lg border`;
            statusElementIndex.classList.remove('hidden');
        }
    }
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
    
    // Selection state is now managed per-object in the renderer's objectSelect change handler
    // Each object maintains its own selection state that is saved/restored automatically
    // No need to reset here - the renderer handles it
    
    // Sync MSA data from batchedObjects to renderer's objectsData if needed
    // This ensures MSA data is available even if it was added after initial load
    if (viewerApi?.renderer) {
        const batchedObj = batchedObjects.find(obj => obj.name === selectedObject);
        const rendererObj = viewerApi.renderer.objectsData[selectedObject];
        if (batchedObj && batchedObj.msa && rendererObj && !rendererObj.msa) {
            rendererObj.msa = batchedObj.msa;
        }
    }
    
    if (viewerApi?.renderer && typeof viewerApi.renderer.updatePAEContainerVisibility === 'function') {
        viewerApi.renderer.updatePAEContainerVisibility();
    }
    
    // Clear preview selection when switching objects
    if (window.SequenceViewer?.clearPreview) window.SequenceViewer.clearPreview();
    
    // Rebuild sequence view for the new object
    buildSequenceView();
    // (no defaulting here — renderer already restored the object's saved selection)
    
    // Update MSA chain selector and container visibility for index.html
    if (window.updateMSAChainSelectorIndex) {
        window.updateMSAChainSelectorIndex();
    }
    if (window.updateMSAContainerVisibility) {
        window.updateMSAContainerVisibility();
    }
    
    // Update entropy option visibility in color menu
    updateEntropyOptionVisibility(selectedObject);
    
    // Note: updateColorMode() is a placeholder, removed to avoid confusion
    // Color mode is managed by the renderer and persists across object changes
}



/**
 * Update entropy option visibility in color select dropdown based on MSA availability
 * @param {string} objectName - Name of the object to check for MSA data
 */
function updateEntropyOptionVisibility(objectName) {
    // If no object name provided, use current object
    if (!objectName && viewerApi?.renderer) {
        objectName = viewerApi.renderer.currentObjectName;
    }
    const colorSelect = document.getElementById('colorSelect');
    if (!colorSelect) return;
    
    // Find entropy option
    const entropyOption = Array.from(colorSelect.options).find(opt => opt.value === 'entropy');
    if (!entropyOption) return; // Option doesn't exist (e.g., in viewer.html)
    
    // Always show entropy option (user can select it, and it will work if MSA data is available)
    entropyOption.style.display = '';
    
    // If entropy is currently selected but MSA is not available, switch to auto
    // Check if MSA data is available for this object
    let hasMSA = false;
    if (viewerApi?.renderer && objectName) {
        const obj = viewerApi.renderer.objectsData[objectName];
        if (obj && obj.msa) {
            // Check various MSA data formats
            if (obj.msa.msasBySequence && obj.msa.chainToSequence && obj.msa.availableChains && obj.msa.availableChains.length > 0) {
                hasMSA = true;
            } else if (obj.msa.chains && obj.msa.availableChains && obj.msa.availableChains.length > 0) {
                hasMSA = true;
            } else if (obj.msa.msaData) {
                hasMSA = true;
            } else if (obj.msa.sequences && obj.msa.sequences.length > 0) {
            hasMSA = true;
        }
    }
    }
    
    // If entropy is selected but MSA is not available, switch to auto
    if (colorSelect.value === 'entropy' && !hasMSA && viewerApi?.renderer) {
        viewerApi.renderer.colorMode = 'auto';
        colorSelect.value = 'auto';
        viewerApi.renderer.colorsNeedUpdate = true;
        viewerApi.renderer.render();
        document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
    }
}

// Expose updateEntropyOptionVisibility globally so it can be called from viewer-mol.js
window.updateEntropyOptionVisibility = updateEntropyOptionVisibility;

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

    // Get current selection to determine which positions to use for orienting
    const selection = renderer.getSelection();
    let selectedPositionIndices = null;
    
    // Determine which positions to use: selected positions if available, otherwise all positions
    if (selection && selection.positions && selection.positions.size > 0) {
        // Use only selected positions
        selectedPositionIndices = selection.positions;
    } else if (selection && selection.selectionMode === 'default' && 
               (!selection.chains || selection.chains.size === 0)) {
        // Default mode with no explicit selection: use all positions
        selectedPositionIndices = null; // Will use all positions
    } else if (selection && selection.chains && selection.chains.size > 0) {
        // Chain-based selection: get all positions in selected chains
        selectedPositionIndices = new Set();
        for (let i = 0; i < frame.coords.length; i++) {
            if (frame.chains && frame.chains[i] && selection.chains.has(frame.chains[i])) {
                selectedPositionIndices.add(i);
            }
        }
        // If no positions found in chains, fall back to all positions
        if (selectedPositionIndices.size === 0) {
            selectedPositionIndices = null;
        }
    } else {
        // No selection or empty selection: use all positions
        selectedPositionIndices = null;
    }

    // Filter coordinates to only selected positions (or use all if no selection)
    let coordsForBestView = [];
    if (selectedPositionIndices && selectedPositionIndices.size > 0) {
        for (const positionIndex of selectedPositionIndices) {
            if (positionIndex >= 0 && positionIndex < frame.coords.length) {
                coordsForBestView.push(frame.coords[positionIndex]);
            }
        }
    } else {
        // No selection or all positions selected: use all coordinates
        coordsForBestView = frame.coords;
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
        visibleExtent = Math.sqrt(maxDistSq);
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
    
    const Rcur = renderer.rotationMatrix;
    
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
    let targetZoom = renderer.zoom;
    
    // Get canvas dimensions for zoom calculation (already retrieved above, but keep for clarity)
    // canvasWidth and canvasHeight are already available from above
    
    if (visibleCenter && visibleExtent && coordsForBestView.length > 0) {
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
            // Clear temporary center if orienting to all positions
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
        // Clear temporary center if orienting to all positions
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
        
        // Group positions by residue to check for structural characteristics
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
        
        // Sort positions by chain and residue_numbers for proper neighbor checking
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
            
            // Use the unified classification functions from utils.js with connectivity checks
            const is_protein = isRealAminoAcid(residue, modresMap, chemCompMap, allResidues);
            const nucleicType = isRealNucleicAcid(residue, modresMap, chemCompMap, allResidues);
            
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
        // IMPORTANT: includeAllResidues=true ensures ALL positions are included to match PAE matrix size
        const originalFrameData = convertParsedToFrameData(models[i], null, null, true);
        
        // Calculate ligand positions using the same robust classification logic
        // This ensures consistency with maybeFilterLigands and catches misclassified ligands
        const modresMap = (typeof window !== 'undefined' && window._lastModresMap) ? window._lastModresMap : null;
        const chemCompMap = (typeof window !== 'undefined' && window._lastChemCompMap) ? window._lastChemCompMap : null;
        
        // Build position map from original model for classification
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
        
        // Map each position in originalFrameData to its corresponding position and check if it's a ligand
        const originalIsLigandPosition = [];
        
        // Cache classification results per position to avoid re-classifying the same position
        const residueClassificationCache = new Map(); // resKey -> {is_protein, nucleicType}
        
        if (originalFrameData.position_types && originalFrameData.position_names && originalFrameData.residue_numbers) {
            for (let idx = 0; idx < originalFrameData.position_types.length; idx++) {
                const positionType = originalFrameData.position_types[idx];
                const resName = originalFrameData.position_names[idx];
                const resSeq = originalFrameData.residue_numbers[idx];
                const chain = originalFrameData.chains ? originalFrameData.chains[idx] : '';
                
                // Find the position in the original model
                const resKey = chain + ':' + resSeq + ':' + resName;
                const residue = originalResidueMap.get(resKey);
                
                if (residue) {
                    // Check cache first to avoid re-classifying the same position
                    let classification = residueClassificationCache.get(resKey);
                    if (!classification) {
                        // Use the same classification logic as maybeFilterLigands (with connectivity checks)
                        const is_protein = isRealAminoAcid(residue, modresMap, chemCompMap, originalAllResidues);
                        const nucleicType = isRealNucleicAcid(residue, modresMap, chemCompMap, originalAllResidues);
                        
                        // Cache the result
                        classification = { is_protein, nucleicType };
                        residueClassificationCache.set(resKey, classification);
                    }
                    
                    // It's a ligand if it's NOT protein AND NOT nucleic acid
                    originalIsLigandPosition.push(!classification.is_protein && classification.nucleicType === null);
                } else {
                    // If we can't find the residue, use the position type as fallback
                    originalIsLigandPosition.push(positionType === 'L');
                }
            }
        } else {
            // Fallback: use position_types if available
            originalIsLigandPosition.push(...(originalFrameData.position_types ? 
                originalFrameData.position_types.map(type => type === 'L') : 
                Array(originalFrameData.coords.length).fill(false)));
        }
        
        // Filter ligands from model
        const model = maybeFilterLigands(models[i]);
        const originalPositionCount = models[i].length;
        const filteredPositionCount = model.length;
        
        // Convert filtered model to get final frame data
        let frameData = convertParsedToFrameData(model);
        if (frameData.coords.length === 0) continue;

        // Store PAE data
        if (paeData) {
            const ignoreLigands = !!(window.viewerConfig && window.viewerConfig.ignoreLigands);
            if (ignoreLigands && originalIsLigandPosition.length > 0) {
                // PAE matrix indices map directly to position indices in originalFrameData
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
            position_types: frameData.position_types ? [...frameData.position_types] : undefined,
            plddts: frameData.plddts ? [...frameData.plddts] : undefined,
            position_names: frameData.position_names ? [...frameData.position_names] : undefined,
            residue_numbers: frameData.residue_numbers ? [...frameData.residue_numbers] : undefined,
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
                // No chain information - use all positions from reference frame
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
                    // No chain information - use all positions
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
            // No chain information - use all positions for centering
            for (let j = 0; j < frame.coords.length; j++) {
                centeringCoords.push(frame.coords[j]);
            }
        }
        
        if (centeringCoords.length > 0) {
            // Compute center of centering chain (or all positions)
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
    const r = viewerApi?.renderer;

    if (!viewerApi || batchedObjects.length === 0) {
        if (viewerContainer) viewerContainer.style.display = 'none';
        setStatus("Ready. Upload a file or fetch an ID.");
        return;
    }

    const snapshot = r ? {
        object: r.currentObjectName,
        frame: (typeof r.currentFrame === 'number') ? r.currentFrame : null
    } : null;

    const existing = new Set(Object.keys(r?.objectsData || {}));
    const newNames = [];

    if (r) r._batchLoading = true;
    
    for (const obj of batchedObjects) {
        if (!obj || !obj.frames || obj.frames.length === 0) continue;

        if (!existing.has(obj.name)) {
            // New object: create and feed frames
            viewerApi.handlePythonNewObject(obj.name);
            newNames.push(obj.name);
            for (const frame of obj.frames) {
                viewerApi.handlePythonUpdate(JSON.stringify(frame), obj.name);
            }
        } else {
            // Existing object: determine if we're replacing or appending
            const have = r.objectsData[obj.name]?.frames?.length || 0;
            const want = obj.frames.length;
            
            // If we're adding frames beyond what exists, append them
            // Otherwise, replace the entire object (e.g., when fetching same PDB)
            if (want > have) {
                // Appending frames to existing object
                for (let i = have; i < want; i++) {
                    viewerApi.handlePythonUpdate(JSON.stringify(obj.frames[i]), obj.name);
                }
            } else {
                // Replacing existing object: clear everything and recreate
                // This handles the case when fetching a PDB with the same name
                // Remove from dropdown first
                if (r.objectSelect) {
                    const option = r.objectSelect.querySelector(`option[value="${obj.name}"]`);
                    if (option) option.remove();
                }
                if (objectSelect) {
                    const option = objectSelect.querySelector(`option[value="${obj.name}"]`);
                    if (option) option.remove();
                }
                
                // Delete the object completely (this clears frames, selection, MSA, sequence, etc.)
                if (r.objectsData[obj.name]) {
                    delete r.objectsData[obj.name];
                }
                
                // Remove from existing set so it's treated as new
                existing.delete(obj.name);
                
                // Recreate as new object
                viewerApi.handlePythonNewObject(obj.name);
                newNames.push(obj.name);
                for (const frame of obj.frames) {
                    viewerApi.handlePythonUpdate(JSON.stringify(frame), obj.name);
                }
            }
        }

        // Set MSA data (replacing any existing MSA)
        if (r && obj.msa && r.objectsData[obj.name]) {
            r.objectsData[obj.name].msa = obj.msa;
        }
    }

    if (r) r._batchLoading = false;

    if (batchedObjects.length > 0) {
        if (viewerContainer) viewerContainer.style.display = 'flex';
        if (topPanelContainer) topPanelContainer.style.display = 'block';
    }

    if (newNames.length > 0) {
        // Show the last new object
        const show = newNames[newNames.length - 1];
        if (r?._switchToObject) r._switchToObject(show);
        if (r?.setFrame) r.setFrame(0);
        if (r?.objectSelect) r.objectSelect.value = show;
        if (objectSelect) objectSelect.value = show;
        if (r?.updatePAEContainerVisibility) r.updatePAEContainerVisibility();
        if (typeof updateObjectNavigationButtons === 'function') updateObjectNavigationButtons();
        if (window.SequenceViewer?.clearPreview) window.SequenceViewer.clearPreview();
        if (typeof buildSequenceView === 'function') buildSequenceView();
        if (window.updateMSAChainSelectorIndex) window.updateMSAChainSelectorIndex();
        if (window.updateMSAContainerVisibility) window.updateMSAContainerVisibility();
        if (r?.updateUIControls) r.updateUIControls();
        if (typeof applyBestViewRotation === 'function') applyBestViewRotation(false);
    } else if (snapshot?.object && r?.objectsData?.[snapshot.object]) {
        // No new objects: restore the previous object/frame
        if (r?._switchToObject) r._switchToObject(snapshot.object);
        if (typeof snapshot.frame === 'number' && r?.setFrame) r.setFrame(snapshot.frame);
        if (r?.render) r.render();
        if (r?.objectSelect) r.objectSelect.value = snapshot.object;
        if (objectSelect) objectSelect.value = snapshot.object;
        if (r?.updatePAEContainerVisibility) r.updatePAEContainerVisibility();
        if (typeof updateObjectNavigationButtons === 'function') updateObjectNavigationButtons();
        if (window.SequenceViewer?.clearPreview) window.SequenceViewer.clearPreview();
        if (typeof buildSequenceView === 'function') buildSequenceView();
        if (window.updateMSAChainSelectorIndex) window.updateMSAChainSelectorIndex();
        if (window.updateMSAContainerVisibility) window.updateMSAContainerVisibility();
    } else {
        setStatus("Error: No valid structures were loaded to display.", true);
        if (viewerContainer) viewerContainer.style.display = 'none';
    }
}


function updateChainSelectionUI() {
  /* [EDIT] This function no longer builds UI (pills). 
     It just sets the default selected state if there is truly no saved selection. */

  const r = viewerApi?.renderer;
  const name = r?.currentObjectName;
  if (!r || !name) return;

  const obj = r.objectsData?.[name];
  if (!obj?.frames?.length) return;

  const ss = r.objectsData?.[name]?.selectionState;
  // Only default if there is truly no user selection saved
  const hasAnySelection =
    ss &&
    (
      ss.selectionMode !== 'default' ||
      (ss.positions && ss.positions.size > 0) ||
      (ss.chains && ss.chains.size > 0) ||
      (ss.paeBoxes && ss.paeBoxes.length > 0)
    );

  if (hasAnySelection) return;

  // Let the renderer compute the correct "all" internally
  if (typeof r.resetToDefault === 'function') {
    r.resetToDefault();
  } else if (typeof r.setSelection === 'function') {
    // Fallback: empty/default request which the renderer normalizes to "all"
    r.setSelection({ selectionMode: 'default', positions: new Set(), chains: new Set() });
  }
}

function setChainResiduesSelected(chain, selected) {
  if (!viewerApi?.renderer) return;
  const current = viewerApi.renderer.getSelection();
  const objectName = viewerApi.renderer.currentObjectName;
  if (!objectName) return;
  
  const obj = viewerApi.renderer.objectsData[objectName];
  if (!obj?.frames?.length) return;
  const frame0 = obj.frames[0];
  if (!frame0?.residue_numbers || !frame0?.chains) return;

  // Get all available chains
  const allChains = new Set(frame0.chains);
  
  // Determine current chain selection
  // If chains.size === 0 and mode is 'default', all chains are selected
  let currentChains = new Set(current.chains);
  if (currentChains.size === 0 && current.selectionMode === 'default') {
    currentChains = new Set(allChains);
  }
  
  const newChains = new Set(currentChains);
  
  // getSelection() now normalizes default mode to have all positions, so we can use it directly
  const newPositions = new Set(current.positions);
  
  if (selected) {
    newChains.add(chain);
    // When selecting a chain, add all positions from that chain
    // This preserves existing position selections from other chains
    for (let i = 0; i < frame0.chains.length; i++) {
      if (frame0.chains[i] === chain) {
        newPositions.add(i); // Add position (Set.add is idempotent, so safe)
      }
    }
  } else {
    newChains.delete(chain);
    // When deselecting a chain, remove all positions from that chain
    // This preserves position selections from other chains
    for (let i = 0; i < frame0.chains.length; i++) {
      if (frame0.chains[i] === chain) {
        newPositions.delete(i);
      }
    }
  }
  
  // Determine selection mode
  // If we have explicit position selections (partial selections), always use 'explicit' mode
  // to preserve the partial selections. Only use 'default' if we have no position selections
  // and all chains are selected.
  const allChainsSelected = newChains.size === allChains.size && 
                            Array.from(newChains).every(c => allChains.has(c));
  const hasPartialSelections = newPositions.size > 0 && 
                               newPositions.size < frame0.chains.length;
  
  // Use explicit mode if we have partial selections OR if not all chains are selected OR if no positions are selected
  // This allows all chains to be deselected (empty chains set with explicit mode)
  const selectionMode = (allChainsSelected && !hasPartialSelections && newPositions.size > 0) ? 'default' : 'explicit';
  
  // If all chains are selected AND no partial selections AND we have positions, use empty chains set with default mode
  // Otherwise, keep explicit chain selection (allows empty chains)
  const chainsToSet = (allChainsSelected && !hasPartialSelections && newPositions.size > 0) ? new Set() : newChains;
  
  viewerApi.renderer.setSelection({ 
    chains: chainsToSet,
    positions: newPositions,
    selectionMode: selectionMode,
    paeBoxes: []  // Clear PAE boxes when editing chain selection
  });
  // Event listener will update UI, no need to call applySelection()
}

/** Alt-click a chain label to toggle selection of all positions in that chain */
function toggleChainResidues(chain) {
    if (!viewerApi?.renderer) return;
    const objectName = viewerApi.renderer.currentObjectName;
    if (!objectName) return;
    const obj = viewerApi.renderer.objectsData[objectName];
    if (!obj?.frames?.length) return;
    const frame = obj.frames[0];
    if (!frame?.chains) return;

    const current = viewerApi.renderer.getSelection();
    const chainPositionIndices = [];
    for (let i = 0; i < frame.chains.length; i++) {
        if (frame.chains[i] === chain) {
            chainPositionIndices.push(i);
        }
    }
    const allSelected = chainPositionIndices.length > 0 && chainPositionIndices.every(positionIndex => current.positions.has(positionIndex));
    
    const newPositions = new Set(current.positions);
    chainPositionIndices.forEach(positionIndex => {
        if (allSelected) newPositions.delete(positionIndex);
        else newPositions.add(positionIndex);
    });
    
    // When toggling positions, we need to update chains to include all chains that have selected positions
    // to prevent the chain filter from hiding positions we just selected
    const newChains = new Set();
    for (const positionIndex of newPositions) {
        const positionChain = frame.chains[positionIndex];
        if (positionChain) {
            newChains.add(positionChain);
        }
    }
    
    // Determine if we have partial selections (not all positions from all chains)
    const hasPartialSelections = newPositions.size > 0 && newPositions.size < frame.chains.length;
    
    viewerApi.renderer.setSelection({ 
        positions: newPositions,
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

function applySelection(previewPositions = null) {
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
  const positionsToUse = previewPositions !== null ? previewPositions : current.positions;

  viewerApi.renderer.setSelection({
    positions: positionsToUse,
    chains: visibleChains
    // Keep current PAE boxes and mode
  });
  
  // Note: updateSequenceViewSelectionState will be called via event listener
}


function highlightPosition(positionIndex) {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedAtom = positionIndex;
        viewerApi.renderer.highlightedAtoms = null; // Clear multi-position highlight
        // Draw highlights on overlay canvas without re-rendering main scene
        if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
            window.SequenceViewer.drawHighlights();
        }
    }
}

function highlightPositions(positionIndices) {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedAtoms = positionIndices instanceof Set ? positionIndices : new Set(positionIndices);
        viewerApi.renderer.highlightedAtom = null; // Clear single position highlight
        // Draw highlights on overlay canvas without re-rendering main scene
        if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
            window.SequenceViewer.drawHighlights();
        }
    }
}

function clearHighlight() {
    if (viewerApi && viewerApi.renderer) {
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
  // Reset to default (show all positions/chains) - this also clears PAE boxes
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
    
    // Hide viewer and top panel
    const viewerContainer = document.getElementById('viewer-container');
    const topPanelContainer = document.getElementById('sequence-viewer-container');
    const msaContainer = document.getElementById('msa-viewer-container');
    const msaView = document.getElementById('msaView');
    
    if (viewerContainer) {
        viewerContainer.style.display = 'none';
    }
    if (topPanelContainer) {
        topPanelContainer.style.display = 'none';
    }
    if (msaContainer) {
        msaContainer.style.display = 'none';
    }
    if (msaView) {
        msaView.classList.add('hidden');
    }
    
    // Clear MSA data
    if (window.MSAViewer && window.MSAViewer.clear) {
        try {
            window.MSAViewer.clear();
        } catch (e) {
            console.error("Failed to clear MSA viewer:", e);
        }
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
        highlightAtom: highlightPosition,
        highlightAtoms: highlightPositions,
        clearHighlight: clearHighlight,
        applySelection: applySelection
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

// MSA viewer callbacks are now set up in initializeApp() after viewerApi is initialized

/**
 * Initialize common MSA viewer UI components (sliders, buttons, checkboxes)
 * Shared between msa.html and index.html
 */
function initializeMSAViewerCommon() {
    const msaContainer = document.getElementById('msa-viewer-container');
    const msaModeSelect = document.getElementById('msaModeSelect');
    const coverageSlider = document.getElementById('coverageSlider');
    const coverageValue = document.getElementById('coverageValue');
    const identitySlider = document.getElementById('identitySlider');
    const identityValue = document.getElementById('identityValue');
    
    // MSA viewer will be shown/hidden based on whether MSA data exists
    // Container starts hidden, will be shown when MSA data is loaded
    
    // Initialize coverage slider
    if (coverageSlider && coverageValue) {
        // Set initial value (75% = 0.75) if MSAViewer is available
        if (window.MSAViewer && window.MSAViewer.getCoverageCutoff) {
            const initialCutoff = window.MSAViewer.getCoverageCutoff();
            coverageSlider.value = Math.round(initialCutoff * 100);
            coverageValue.textContent = Math.round(initialCutoff * 100) + '%';
        } else {
            coverageSlider.value = 75;
            coverageValue.textContent = '75%';
        }
        
        // Update value display and apply filter
        const applyCoverageFilter = () => {
            const value = parseInt(coverageSlider.value);
            coverageValue.textContent = value + '%';
            const cutoff = value / 100;
            if (window.MSAViewer?.setCoverageCutoff) {
                try {
                    window.MSAViewer.setCoverageCutoff(cutoff);
                    if (updateMSASequenceCount) {
                        updateMSASequenceCount();
                    }
                } catch (error) {
                    console.error('Error applying coverage filter:', error);
                }
            }
        };
        
        // Update display during drag
        coverageSlider.addEventListener('input', () => {
            const value = parseInt(coverageSlider.value);
            coverageValue.textContent = value + '%';
        });
        
        // Apply filter when user releases slider
        coverageSlider.addEventListener('mouseup', applyCoverageFilter);
        coverageSlider.addEventListener('touchend', applyCoverageFilter);
        coverageSlider.addEventListener('change', applyCoverageFilter);
    }
    
    // Initialize identity slider
    if (identitySlider && identityValue) {
        // Set initial value (15% = 0.15) if MSAViewer is available
        if (window.MSAViewer && window.MSAViewer.getIdentityCutoff) {
            const initialCutoff = window.MSAViewer.getIdentityCutoff();
            identitySlider.value = Math.round(initialCutoff * 100);
            identityValue.textContent = Math.round(initialCutoff * 100) + '%';
        } else {
            identitySlider.value = 15;
            identityValue.textContent = '15%';
        }
        
        // Update value display and apply filter
        const applyIdentityFilter = () => {
            const value = parseInt(identitySlider.value);
            identityValue.textContent = value + '%';
            const cutoff = value / 100;
            if (window.MSAViewer?.setIdentityCutoff) {
                try {
                    window.MSAViewer.setIdentityCutoff(cutoff);
                    if (updateMSASequenceCount) {
                        updateMSASequenceCount();
                    }
                } catch (error) {
                    console.error('Error applying identity filter:', error);
                }
            }
        };
        
        // Update display during drag
        identitySlider.addEventListener('input', () => {
            const value = parseInt(identitySlider.value);
            identityValue.textContent = value + '%';
        });
        
        // Apply filter when user releases slider
        identitySlider.addEventListener('mouseup', applyIdentityFilter);
        identitySlider.addEventListener('touchend', applyIdentityFilter);
        identitySlider.addEventListener('change', applyIdentityFilter);
    }
    
    // Handle MSA mode dropdown selection
    const msaSortContainer = document.getElementById('msaSortContainer');
    const msaSortCheckbox = document.getElementById('msaSortCheckbox');
    const logoBitScoreContainer = document.getElementById('logoBitScoreContainer');
    const logoBitScoreCheckbox = document.getElementById('logoBitScoreCheckbox');
    const msaSaveContainer = document.getElementById('msaSaveContainer');
    const logoSaveContainer = document.getElementById('logoSaveContainer');
    const pssmSaveContainer = document.getElementById('pssmSaveContainer');
    const msaSaveFastaButton = document.getElementById('msaSaveFastaButton');
    const logoSaveSvgButton = document.getElementById('logoSaveSvgButton');
    const pssmSaveSvgButton = document.getElementById('pssmSaveSvgButton');
    const pssmSaveCsvButton = document.getElementById('pssmSaveCsvButton');
    
    // Set initial button visibility based on default mode (MSA)
    if (msaSaveContainer) {
        msaSaveContainer.style.display = 'flex';
    }
    if (logoSaveContainer) {
        logoSaveContainer.style.display = 'none';
    }
    if (pssmSaveContainer) {
        pssmSaveContainer.style.display = 'none';
    }
    if (msaSortContainer) {
        msaSortContainer.style.display = 'flex'; // Show sort checkbox for MSA mode
    }
    
    if (msaModeSelect && window.MSAViewer) {
        // Set initial value
        const initialMode = window.MSAViewer.getMSAMode ? window.MSAViewer.getMSAMode() : 'msa';
        msaModeSelect.value = initialMode;
        
        // Handle mode change
        msaModeSelect.addEventListener('change', (e) => {
            const mode = e.target.value;
            if (window.MSAViewer) {
                window.MSAViewer.setMSAMode(mode);
            }
            
            // Show/hide sort checkbox for MSA mode
            if (msaSortContainer) {
                msaSortContainer.style.display = (mode === 'msa') ? 'flex' : 'none';
            }
            
            // Show/hide bit-score checkbox for logo mode
            if (logoBitScoreContainer) {
                logoBitScoreContainer.style.display = (mode === 'logo') ? 'flex' : 'none';
            }
            
            // Show/hide save buttons based on mode
            if (msaSaveContainer) {
                msaSaveContainer.style.display = (mode === 'msa') ? 'flex' : 'none';
            }
            if (logoSaveContainer) {
                logoSaveContainer.style.display = (mode === 'logo') ? 'flex' : 'none';
            }
            if (pssmSaveContainer) {
                pssmSaveContainer.style.display = (mode === 'pssm') ? 'flex' : 'none';
            }
        });
        
        // Show/hide bit-score checkbox based on initial mode
        if (logoBitScoreContainer) {
            logoBitScoreContainer.style.display = initialMode === 'logo' ? 'flex' : 'none';
        }
    }
    
    // Wire up save button event listeners
    if (msaSaveFastaButton && window.MSAViewer) {
        msaSaveFastaButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.MSAViewer.saveMSAAsFasta) {
                window.MSAViewer.saveMSAAsFasta();
            }
        });
    }
    
    if (logoSaveSvgButton && window.MSAViewer) {
        logoSaveSvgButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.MSAViewer.saveLogoAsSvg) {
                window.MSAViewer.saveLogoAsSvg();
            }
        });
    }
    
    if (pssmSaveSvgButton && window.MSAViewer) {
        pssmSaveSvgButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.MSAViewer.savePSSMAsSvg) {
                window.MSAViewer.savePSSMAsSvg();
            }
        });
    }
    
    if (pssmSaveCsvButton && window.MSAViewer) {
        pssmSaveCsvButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.MSAViewer.savePSSMAsCsv) {
                window.MSAViewer.savePSSMAsCsv();
            }
        });
    }
    
    if (msaSortCheckbox) {
        msaSortCheckbox.addEventListener('change', (e) => {
            if (window.MSAViewer) {
                window.MSAViewer.setSortSequences(e.target.checked);
            }
        });
    }
    
    // Handle bit-score checkbox
    if (logoBitScoreCheckbox && window.MSAViewer) {
        // Set initial value (checked = true = bit-score mode)
        logoBitScoreCheckbox.checked = window.MSAViewer.getUseBitScore ? window.MSAViewer.getUseBitScore() : true;
        
        // Handle checkbox change
        logoBitScoreCheckbox.addEventListener('change', (e) => {
            const useBitScore = e.target.checked;
            if (window.MSAViewer.setUseBitScore) {
                window.MSAViewer.setUseBitScore(useBitScore);
            }
        });
    }
    
    // Function to update MSA sequence count display
    function updateMSASequenceCount() {
        const sequenceCountEl = document.getElementById('msaSequenceCount');
        if (sequenceCountEl && window.MSAViewer && window.MSAViewer.getSequenceCounts) {
            const counts = window.MSAViewer.getSequenceCounts();
            if (counts && counts.total > 0) {
                sequenceCountEl.textContent = `${counts.filtered} / ${counts.total}`;
            } else {
                sequenceCountEl.textContent = '-';
            }
        }
    }
    
    // Store globally so it can be called from applySelectionToMSA
    window.updateMSASequenceCount = updateMSASequenceCount;
    
    return { updateMSASequenceCount };
}

/**
 * Initialize MSA viewer for msa.html (standalone MSA viewer)
 */
function initializeMSAViewer() {
    const common = initializeMSAViewerCommon();
    const { updateMSASequenceCount } = common;
    
    // Function to update chain selector UI
    // Shows all chains from structure (like viewer-seq), highlights chains with MSAs
    function updateMSAChainSelector() {
        const chainSelectContainer = document.getElementById('msaChainSelectContainer');
        const chainSelect = document.getElementById('msaChainSelect');
        if (!chainSelect || !chainSelectContainer || !viewerApi?.renderer) return;
        
        const objectName = viewerApi.renderer.currentObjectName;
        if (!objectName) {
            chainSelectContainer.style.display = 'none';
            return;
        }
        
        const obj = viewerApi.renderer.objectsData[objectName];
        if (!obj || !obj.frames || obj.frames.length === 0) {
            chainSelectContainer.style.display = 'none';
            return;
        }
        
        // Get all chains from structure (from first frame, like viewer-seq does)
        const firstFrame = obj.frames[0];
        const allChains = new Set();
        if (firstFrame.chains) {
            firstFrame.chains.forEach(chain => {
                if (chain) allChains.add(chain);
            });
        }
        
        if (allChains.size === 0) {
            chainSelectContainer.style.display = 'none';
            return;
        }
        
        // Get chains with MSAs (for highlighting/validation)
        const chainsWithMSA = new Set();
        if (obj.msa) {
            if (obj.msa.availableChains) {
                obj.msa.availableChains.forEach(chain => chainsWithMSA.add(chain));
            }
        }
        
        // Rebuild options if needed (sorted alphabetically, show all chains)
        const currentOptions = Array.from(chainSelect.options).map(opt => opt.value);
        const sortedAllChains = Array.from(allChains).sort();
        const chainsChanged = currentOptions.length !== sortedAllChains.length ||
                             !sortedAllChains.every(chain => currentOptions.includes(chain));
        
        // Preserve current selection before rebuilding
        const preservedValue = chainSelect.value;
        
        if (chainsChanged) {
            chainSelect.innerHTML = '';
            sortedAllChains.forEach(chainId => {
                const option = document.createElement('option');
                option.value = chainId;
                const hasMSA = chainsWithMSA.has(chainId);
                option.textContent = hasMSA ? `${chainId} ✓` : chainId;
                option.disabled = !hasMSA;
                chainSelect.appendChild(option);
            });
        }
        
        // Get current chain from MSA viewer (source of truth)
        const currentChain = window.MSAViewer?.getCurrentChain ? window.MSAViewer.getCurrentChain() : null;
        
        // Update dropdown to match current chain
        if (currentChain && allChains.has(currentChain) && chainsWithMSA.has(currentChain)) {
            chainSelect.value = currentChain;
        } else if (preservedValue && allChains.has(preservedValue) && chainsWithMSA.has(preservedValue)) {
            chainSelect.value = preservedValue;
        } else if (!chainSelect.value || !allChains.has(chainSelect.value) || !chainsWithMSA.has(chainSelect.value)) {
            const firstChainWithMSA = sortedAllChains.find(c => chainsWithMSA.has(c));
            chainSelect.value = firstChainWithMSA || sortedAllChains[0];
        }
        
        chainSelectContainer.style.display = allChains.size > 0 ? 'flex' : 'none';
    }
    
    // Handle MSA chain selector
    const msaChainSelect = document.getElementById('msaChainSelect');
    if (msaChainSelect && window.MSAViewer && viewerApi?.renderer) {
        msaChainSelect.addEventListener('change', (e) => {
            const chainId = e.target.value;
            if (!chainId) return;
            
            const objectName = viewerApi.renderer.currentObjectName;
            if (!objectName) return;
            
            const obj = viewerApi.renderer.objectsData[objectName];
            if (!obj || !obj.msa) return;
            
            if (obj.msa.msasBySequence && obj.msa.chainToSequence) {
                const querySeq = obj.msa.chainToSequence[chainId];
                if (querySeq && obj.msa.msasBySequence[querySeq]) {
                    const {msaData} = obj.msa.msasBySequence[querySeq];
                    loadMSADataIntoViewer(msaData, chainId, objectName);
                    
                    // Apply current object's selection to MSA (refilter based on selection state)
                    applySelectionToMSA();
                    
                    setTimeout(() => {
                        if (msaChainSelect.value !== chainId) {
                            msaChainSelect.value = chainId;
                        }
                    }, 0);
                }
            }
        });
    }
    
    // Set empty callbacks for msa.html (MSA viewer is read-only, doesn't need renderer)
    if (window.MSAViewer) {
        window.MSAViewer.setCallbacks({
            getRenderer: () => null
        });
    }
}

/**
 * Fetch MSA from AlphaFold DB (for msa.html)
 * @param {string} uniprotId - UniProt ID to fetch
 */
async function handleMSAFetch(uniprotId) {
    if (!uniprotId) {
        uniprotId = document.getElementById('fetch-uniprot-id')?.value.trim().toUpperCase();
    }
    
    if (!uniprotId) {
        setStatus('Please enter a UniProt ID', true);
        return;
    }
    
    // Validate UniProt ID format (typically 6 characters, alphanumeric)
    if (!/^[A-Z0-9]{6,10}$/.test(uniprotId)) {
        setStatus('Invalid UniProt ID format. Please enter a valid UniProt ID (e.g., P0A8I3)', true);
        return;
    }
    
    setStatus(`Fetching MSA for ${uniprotId} from AlphaFold DB...`);
    
    const msaUrl = `https://alphafold.ebi.ac.uk/files/msa/AF-${uniprotId}-F1-msa_v6.a3m`;
    
    try {
        const response = await fetch(msaUrl);
        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(`MSA not found for UniProt ID ${uniprotId}. The structure may not be available in AlphaFold DB.`);
            }
            throw new Error(`Failed to fetch MSA (HTTP ${response.status})`);
        }
        
        const msaText = await response.text();
        
        if (!msaText || msaText.trim().length === 0) {
            throw new Error('Empty MSA file received');
        }
        
        // Parse and load the MSA
        if (window.MSAViewer && window.MSAViewer.parseA3M) {
            const msaData = window.MSAViewer.parseA3M(msaText);
            if (msaData && msaData.querySequence) {
                window.MSAViewer.setMSAData(msaData, null);
                setStatus(`Loaded MSA: ${msaData.sequences.length} sequences, length ${msaData.queryLength}`);
                
                // Update sequence count
        const sequenceCountEl = document.getElementById('msaSequenceCount');
        if (sequenceCountEl && window.MSAViewer && window.MSAViewer.getSequenceCounts) {
            const counts = window.MSAViewer.getSequenceCounts();
                    if (counts) {
                        sequenceCountEl.textContent = `${counts.filtered} / ${counts.total}`;
                    }
                }
                
                // Update file name display (if exists)
                const fileNameEl = document.getElementById('file-name');
                if (fileNameEl) {
                    fileNameEl.textContent = `AF-${uniprotId}-F1-msa_v6.a3m`;
                }
                
                // Show MSA viewer container
                const msaContainer = document.getElementById('msa-viewer-container');
                if (msaContainer) {
                    msaContainer.style.display = 'block';
                }
                const msaView = document.getElementById('msaView');
                if (msaView) {
                    msaView.classList.remove('hidden');
                }
            } else {
                setStatus('Failed to parse MSA file', true);
            }
        } else {
            setStatus('MSA Viewer not available', true);
        }
    } catch (error) {
        console.error('Error fetching MSA:', error);
        setStatus(`Error fetching MSA: ${error.message}`, true);
    }
}

/**
 * Handle MSA file upload (for msa.html)
 * @param {File|FileList} fileOrEvent - File object or event with files
 */
async function handleMSAFileUpload(fileOrEvent) {
    let file;
    if (fileOrEvent instanceof File) {
        file = fileOrEvent;
    } else if (fileOrEvent.target && fileOrEvent.target.files) {
        const files = fileOrEvent.target.files;
        if (!files || files.length === 0) return;
        file = files[0];
    } else if (fileOrEvent.files && fileOrEvent.files.length > 0) {
        file = fileOrEvent.files[0];
    } else {
        return;
    }
    
    const fileName = file.name.toLowerCase();
    const isA3M = fileName.endsWith('.a3m');
    const isFasta = fileName.endsWith('.fasta') || fileName.endsWith('.fa') || fileName.endsWith('.fas');
    const isSTO = fileName.endsWith('.sto');
    
    if (!isA3M && !isFasta && !isSTO) {
        setStatus('Please upload an A3M (.a3m), FASTA (.fasta, .fa, .fas), or STO (.sto) file', true);
        return;
    }
    
    // Update file name display (if exists)
    const fileNameEl = document.getElementById('file-name');
    if (fileNameEl) {
        fileNameEl.textContent = file.name;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const msaText = e.target.result;
            
            let msaData = null;
            if (isA3M && window.MSAViewer && window.MSAViewer.parseA3M) {
                msaData = window.MSAViewer.parseA3M(msaText);
            } else if (isFasta && window.MSAViewer && window.MSAViewer.parseFasta) {
                msaData = window.MSAViewer.parseFasta(msaText);
            } else if (isSTO && window.MSAViewer && window.MSAViewer.parseSTO) {
                msaData = window.MSAViewer.parseSTO(msaText);
            }
            
            if (msaData && msaData.querySequence) {
                window.MSAViewer.setMSAData(msaData, null);
                setStatus(`Loaded MSA: ${msaData.sequences.length} sequences, length ${msaData.queryLength}`);
                
                // Update sequence count
                const sequenceCountEl = document.getElementById('msaSequenceCount');
                if (sequenceCountEl && window.MSAViewer && window.MSAViewer.getSequenceCounts) {
                    const counts = window.MSAViewer.getSequenceCounts();
                    if (counts) {
                        sequenceCountEl.textContent = `${counts.filtered} / ${counts.total}`;
                    }
                }
                
                // Show MSA viewer container
                const msaContainer = document.getElementById('msa-viewer-container');
                if (msaContainer) {
                    msaContainer.style.display = 'block';
                }
                const msaView = document.getElementById('msaView');
                if (msaView) {
                    msaView.classList.remove('hidden');
                }
            } else {
                setStatus('Failed to parse MSA file', true);
            }
        } catch (error) {
            console.error('Error loading MSA:', error);
            setStatus('Error loading MSA file: ' + error.message, true);
        }
    };
    reader.onerror = () => {
        setStatus('Error reading file', true);
    };
    reader.readAsText(file);
}

/**
 * Initialize drag and drop for MSA files (for msa.html)
 */
function initMSADragAndDrop() {
    const dragOverlay = document.getElementById('drag-overlay');
    const fileUpload = document.getElementById('file-upload');
    if (!dragOverlay || !fileUpload) return;
    
    let dragCounter = 0;
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    document.body.addEventListener('dragenter', (e) => {
        preventDefaults(e);
        if (dragCounter === 0 && dragOverlay) {
            dragOverlay.style.display = 'flex';
        }
        dragCounter++;
    }, false);
    
    document.body.addEventListener('dragleave', (e) => {
        preventDefaults(e);
        dragCounter--;
        if (dragCounter === 0 || e.relatedTarget === null) {
            if (dragOverlay) {
                dragOverlay.style.display = 'none';
            }
        }
    }, false);
    
    document.body.addEventListener('drop', (e) => {
        preventDefaults(e);
        dragCounter = 0;
        if (dragOverlay) {
            dragOverlay.style.display = 'none';
        }
        
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            const file = files[0];
            const fileName = file.name.toLowerCase();
            const isA3M = fileName.endsWith('.a3m');
            const isFasta = fileName.endsWith('.fasta') || fileName.endsWith('.fa') || fileName.endsWith('.fas');
            const isSTO = fileName.endsWith('.sto');
            
            if (isA3M || isFasta || isSTO) {
                fileUpload.files = files;
                handleMSAFileUpload({ target: { files: files } });
            } else {
                setStatus('Please drop an A3M (.a3m), FASTA (.fasta, .fa, .fas), or STO (.sto) file', true);
            }
        }
    }, false);
    
    document.body.addEventListener('dragover', preventDefaults, false);
}

// Initialize MSA viewer on DOM ready (for msa.html only)
// Check if we're on msa.html by looking for msa.html-specific elements
const isMSAHTML = document.getElementById('fetch-uniprot-id') !== null;
if (isMSAHTML) {
if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initializeMSAViewer();
            
            // Wire up fetch button
            const fetchBtn = document.getElementById('fetch-btn');
            const fetchInput = document.getElementById('fetch-uniprot-id');
            
            if (fetchBtn) {
                fetchBtn.addEventListener('click', () => {
                    handleMSAFetch();
                });
            }
            
            // Allow Enter key to trigger fetch
            if (fetchInput) {
                fetchInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        handleMSAFetch();
                    }
                });
            }
            
            // File upload button
            const uploadButton = document.getElementById('upload-button');
            const fileUpload = document.getElementById('file-upload');
            
            if (uploadButton && fileUpload) {
                uploadButton.addEventListener('click', () => {
                    fileUpload.click();
                });
                
                fileUpload.addEventListener('change', handleMSAFileUpload);
            }
            
            // Initialize drag and drop
            initMSADragAndDrop();
        });
} else {
    initializeMSAViewer();
        
        // Wire up fetch button
        const fetchBtn = document.getElementById('fetch-btn');
        const fetchInput = document.getElementById('fetch-uniprot-id');
        
        if (fetchBtn) {
            fetchBtn.addEventListener('click', () => {
                handleMSAFetch();
            });
        }
        
        // Allow Enter key to trigger fetch
        if (fetchInput) {
            fetchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    handleMSAFetch();
                }
            });
        }
        
        // File upload button
        const uploadButton = document.getElementById('upload-button');
        const fileUpload = document.getElementById('file-upload');
        
        if (uploadButton && fileUpload) {
            uploadButton.addEventListener('click', () => {
                fileUpload.click();
            });
            
            fileUpload.addEventListener('change', handleMSAFileUpload);
        }
        
        // Initialize drag and drop
        initMSADragAndDrop();
    }
}

/**
 * Initialize MSA viewer for index.html (integrated with structure viewer)
 */
function initializeMSAViewerIndex() {
    const common = initializeMSAViewerCommon();
    const { updateMSASequenceCount } = common;
    
    const msaChainSelect = document.getElementById('msaChainSelect');
    const msaView = document.getElementById('msaView');
    const msaContainer = document.getElementById('msa-viewer-container');
    
    // Chain selector for single chain support (first pass)
    if (msaChainSelect && window.MSAViewer && viewerApi?.renderer) {
        // Update chain selector when object changes
        function updateMSAChainSelectorIndex() {
            const objectName = viewerApi.renderer.currentObjectName;
            if (!objectName) {
                msaChainSelect.style.display = 'none';
                return;
            }
            
            const obj = viewerApi.renderer.objectsData[objectName];
            if (!obj || !obj.frames || obj.frames.length === 0) {
                msaChainSelect.style.display = 'none';
                return;
            }
            
            // New sequence-based structure: group chains by MSA sequence (homo-oligomers)
            if (obj.msa && obj.msa.msasBySequence && obj.msa.chainToSequence) {
                // Build chain groups from msaToChains (if available) or from msasBySequence
                const chainGroups = {}; // chainKey -> {chains: [chainId, ...], querySeq: string}
                
                // Use msaToChains if available, otherwise build from msasBySequence
                const msaToChains = obj.msa.msaToChains || {};
                
                if (Object.keys(msaToChains).length > 0) {
                    // Use msaToChains to group chains
                    for (const [querySeq, chains] of Object.entries(msaToChains)) {
                        if (chains && chains.length > 0) {
                            const chainKey = chains.sort().join(''); // e.g., "AC" for chains A and C
                            chainGroups[chainKey] = {
                                chains: chains.sort(),
                                querySeq: querySeq
                            };
                        }
                    }
                } else {
                    // Build from msasBySequence (fallback)
                    for (const [querySeq, msaEntry] of Object.entries(obj.msa.msasBySequence)) {
                        const chainsForMSA = [];
                        for (const [cid, seq] of Object.entries(obj.msa.chainToSequence || {})) {
                            if (seq === querySeq) {
                                chainsForMSA.push(cid);
                            }
                        }
                        if (chainsForMSA.length > 0) {
                            const chainKey = chainsForMSA.sort().join('');
                            chainGroups[chainKey] = {
                                chains: chainsForMSA.sort(),
                                querySeq: querySeq
                            };
                        }
                    }
                }
                
                const chainGroupKeys = Object.keys(chainGroups).sort();
                
                if (chainGroupKeys.length > 1 || (chainGroupKeys.length === 1 && chainGroups[chainGroupKeys[0]].chains.length > 1)) {
                    // Multiple chain groups or single group with multiple chains - show selector
                    msaChainSelect.innerHTML = '';
                    chainGroupKeys.forEach(chainKey => {
                        const option = document.createElement('option');
                        option.value = chainKey;
                        const chains = chainGroups[chainKey].chains;
                        option.textContent = chains.length > 1 ? chains.join('') : chains[0]; // "AC" or "A"
                        msaChainSelect.appendChild(option);
                    });
                    
                    // Set default selection to first group or current chain's group
                    const defaultChain = obj.msa.defaultChain || (obj.msa.availableChains && obj.msa.availableChains[0]);
                    if (defaultChain) {
                        // Find which group contains this chain
                        const selectedGroup = chainGroupKeys.find(key => chainGroups[key].chains.includes(defaultChain));
                        if (selectedGroup) {
                            msaChainSelect.value = selectedGroup;
                        } else {
                            msaChainSelect.value = chainGroupKeys[0];
                        }
                    } else {
                        msaChainSelect.value = chainGroupKeys[0];
                    }
                    
                    msaChainSelect.style.display = 'block';
                } else {
                    // Single chain group with single chain - hide selector
                    msaChainSelect.style.display = 'none';
                }
            } else {
                msaChainSelect.style.display = 'none';
            }
        }
        
        // Handle chain selection change
        msaChainSelect.addEventListener('change', (e) => {
            const chainKey = e.target.value; // Can be "A", "AC", etc.
            if (!chainKey) return;
            
            const objectName = viewerApi.renderer.currentObjectName;
            if (!objectName) return;
            
            const obj = viewerApi.renderer.objectsData[objectName];
            if (!obj || !obj.msa) return;
            
            // New sequence-based structure: chain key represents one or more chains
            if (obj.msa.msasBySequence && obj.msa.chainToSequence) {
                // Get first chain from chain key (all chains in key share same MSA)
                const firstChain = chainKey[0];
                if (firstChain && obj.msa.chainToSequence[firstChain]) {
                    const querySeq = obj.msa.chainToSequence[firstChain];
                    const msaEntry = obj.msa.msasBySequence[querySeq];
                    if (msaEntry) {
                        const {msaData} = msaEntry;
                        // Load MSA for first chain (all chains in key share same MSA)
                        window.MSAViewer.setMSAData(msaData, firstChain);
                        
                        // Update default chain to first chain in the key
                        obj.msa.defaultChain = firstChain;
                        
                        // Update renderer to show entropy for selected chain key
                        const currentFrameIndex = viewerApi.renderer.currentFrame || 0;
                        viewerApi.renderer._loadFrameData(currentFrameIndex, false);
                    }
                }
            }
        });
        
        // Update chain selector when object changes
        // Store update function globally so it can be called from other places
        window.updateMSAChainSelectorIndex = updateMSAChainSelectorIndex;
        
        // Initial update
        updateMSAChainSelectorIndex();
    }
    
    // Show/hide MSA container based on whether MSA data exists and load MSA when switching objects
    function updateMSAContainerVisibility() {
        if (!msaContainer) return;
        
        const objectName = viewerApi?.renderer?.currentObjectName;
        if (!objectName) {
            msaContainer.style.display = 'none';
            if (msaView) {
                msaView.classList.add('hidden');
            }
            return;
        }
        
        const obj = viewerApi.renderer.objectsData[objectName];
        if (!obj) {
            msaContainer.style.display = 'none';
            if (msaView) {
                msaView.classList.add('hidden');
            }
            return;
        }
        
        if (!obj.msa) {
            msaContainer.style.display = 'none';
            if (msaView) {
                msaView.classList.add('hidden');
            }
            return;
        }
        
        // Determine which MSA to load (handle both old and new formats)
        let msaToLoad = null;
        let chainId = null;
        let hasMSA = false;
        
        // New sequence-based structure
        if (obj.msa.msasBySequence && obj.msa.chainToSequence && obj.msa.availableChains) {
            // Use default chain or first available
            const targetChain = obj.msa.defaultChain || 
                               (obj.msa.availableChains.length > 0 ? obj.msa.availableChains[0] : null);
            
            if (targetChain && obj.msa.chainToSequence[targetChain]) {
                const querySeq = obj.msa.chainToSequence[targetChain];
                const msaEntry = obj.msa.msasBySequence[querySeq];
                
                if (msaEntry) {
                    msaToLoad = msaEntry.msaData;
                    chainId = targetChain;
                    hasMSA = !!msaToLoad;
                }
            }
        }
        
        if (hasMSA && msaToLoad && window.MSAViewer) {
            // Show container and view
            msaContainer.style.display = 'block';
            if (msaView) {
                msaView.classList.remove('hidden');
            }
            
            // Force a layout recalculation to ensure container dimensions are available
            void msaContainer.offsetWidth; // Force reflow
            
            // Load MSA data into viewer (this will update the display)
            loadMSADataIntoViewer(msaToLoad, chainId, objectName);
            
            // Apply current object's selection to MSA (refilter based on selection state)
            // This ensures the MSA is filtered correctly when switching objects
            // Selection state is already restored by _switchToObject() before this is called
            applySelectionToMSA();
        } else {
            // Hide MSA container if no MSA for this object
            msaContainer.style.display = 'none';
            if (msaView) {
                msaView.classList.add('hidden');
            }
            
            // Update entropy option visibility (hide it when no MSA)
            updateEntropyOptionVisibility(objectName);
        }
    }
    
    // Update container visibility when object changes
if (viewerApi && viewerApi.renderer) {
        // Store update function globally
        window.updateMSAContainerVisibility = updateMSAContainerVisibility;
        
        // Initial update
        updateMSAContainerVisibility();
    }
    
    // Update sequence count when MSA data is set
    if (window.MSAViewer && window.MSAViewer.setMSAData) {
        const originalSetMSAData = window.MSAViewer.setMSAData;
        // Only wrap if not already wrapped
        if (!originalSetMSAData._indexHtmlWrapped) {
            window.MSAViewer.setMSAData = function(data, chainId) {
                originalSetMSAData.call(this, data, chainId);
                updateMSASequenceCount();
            };
            window.MSAViewer.setMSAData._indexHtmlWrapped = true;
        }
        
        // Initial update
        updateMSASequenceCount();
    }
}

// Initialize MSA viewer for index.html only (not msa.html)
// Check if we're on index.html by looking for index.html-specific elements
const isIndexHTML = document.getElementById('fetch-id') !== null && document.getElementById('fetch-uniprot-id') === null;
if (isIndexHTML) {
if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeMSAViewerIndex);
} else {
        initializeMSAViewerIndex();
    }
}

// MSA viewer callbacks are set up in initializeApp() after viewerApi is initialized

// Wrapper functions that delegate to SequenceViewer module
function buildSequenceView() {
    if (window.SequenceViewer) {
        window.SequenceViewer.buildSequenceView();
    }
}

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

    // Check if PAE and MSA loading are enabled
    const loadPAECheckbox = document.getElementById('loadPAECheckbox');
    const loadMSACheckbox = document.getElementById('loadMSACheckbox');
    const loadPAE = loadPAECheckbox ? loadPAECheckbox.checked : true; // Default to enabled
    const loadMSA = loadMSACheckbox ? loadMSACheckbox.checked : false; // Default to disabled

    if (isAFDB) {
        name = `${fetchId}.cif`;
        structUrl = `https://alphafold.ebi.ac.uk/files/AF-${fetchId}-F1-model_v6.cif`;
        paeUrl = `https://alphafold.ebi.ac.uk/files/AF-${fetchId}-F1-predicted_aligned_error_v6.json`;
        paeEnabled = window.viewerConfig.pae && loadPAE;
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
        if (paeEnabled && paeUrl && loadPAE) {
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
        
        // Auto-download MSA for PDB structures (only if Load MSA is enabled)
        if (isPDB && window.MSAViewer && loadMSA) {
            try {
                setStatus(`Fetching UniProt mappings for ${fetchId}...`);
                
                // Fetch UniProt to PDB mappings from PDBe API
                const siftsMappings = await fetchPDBeMappings(fetchId);
                
                if (Object.keys(siftsMappings).length === 0) {
                    setStatus(
                        `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                        `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                        `Note: No UniProt mappings found for this PDB structure.`
                    );
                } else {
                    // Get the object that was just loaded
                    const objectName = cleanObjectName(name);
                    const renderer = viewerApi?.renderer;
                    
                    if (renderer && renderer.objectsData && renderer.objectsData[objectName]) {
                        const object = renderer.objectsData[objectName];
                        
                        if (object && object.frames && object.frames.length > 0) {
                            // Extract chain sequences from first frame
                            const firstFrame = object.frames[0];
                            const chainSequences = extractChainSequences(firstFrame);
                            
                            if (Object.keys(chainSequences).length > 0) {
                                // Download MSAs for each chain with UniProt mapping
                                const msaDataList = [];
                                const msaPromises = [];
                                
                                // Extract chain sequences with residue number mappings
                                const chainSequencesWithResnums = {};
                                for (let i = 0; i < firstFrame.chains.length; i++) {
                                    const chainId = firstFrame.chains[i];
                                    const positionType = firstFrame.position_types ? firstFrame.position_types[i] : 'P';
                                    
                                    // Keep all polymer residues, even if index is null/missing
                                    if (positionType !== 'P') continue;
                                    
                                    // Sanitize the residue number to a number or null
                                    const rawIndex = firstFrame.residue_numbers ? firstFrame.residue_numbers[i] : null;
                                    const numericIndex = rawIndex == null ? null : Number(rawIndex);
                                    const residueNum = Number.isFinite(numericIndex) ? numericIndex : null;
                                    
                                    if (!chainSequencesWithResnums[chainId]) {
                                        chainSequencesWithResnums[chainId] = {
                                            sequence: '',
                                            residueNumbers: [] // Maps sequence position -> PDB residue number (can be null)
                                        };
                                    }
                                    
                                    const positionName = firstFrame.position_names[i];
                                    const aa = RESIDUE_TO_AA[positionName?.toUpperCase()] || 'X';
                                    chainSequencesWithResnums[chainId].sequence += aa;
                                    chainSequencesWithResnums[chainId].residueNumbers.push(residueNum);
                                }
                                
                                for (const [chainId, siftsMapping] of Object.entries(siftsMappings)) {
                                    if (!siftsMapping.uniprot_id) continue;
                                    
                                    const uniprotId = siftsMapping.uniprot_id;
                                    const chainData = chainSequencesWithResnums[chainId];
                                    
                                    if (!chainData || !chainData.sequence) {
                                        console.warn(`No PDB sequence found for chain ${chainId}`);
                                        continue;
                                    }
                                    
                                    const pdbSequence = chainData.sequence;
                                    const pdbResidueNumbers = chainData.residueNumbers;
                                    
                                    // Download MSA from AlphaFold DB
                                    const msaUrl = `https://alphafold.ebi.ac.uk/files/msa/AF-${uniprotId}-F1-msa_v6.a3m`;
                                    
                                    msaPromises.push(
                                        fetch(msaUrl)
                                            .then(async (msaResponse) => {
                                                if (!msaResponse.ok) {
                                                    if (msaResponse.status === 404) {
                                                        console.warn(`MSA not found for UniProt ID ${uniprotId} (chain ${chainId})`);
                                                        return null;
                                                    }
                                                    throw new Error(`Failed to fetch MSA (HTTP ${msaResponse.status})`);
                                                }
                                                
                                                const msaText = await msaResponse.text();
                                                if (!msaText || msaText.trim().length === 0) {
                                                    console.warn(`Empty MSA file for UniProt ID ${uniprotId} (chain ${chainId})`);
                                                    return null;
                                                }
                                                
                                                // Parse MSA
                                                const msaData = window.MSAViewer.parseA3M(msaText);
                                                
                                                if (!msaData || !msaData.querySequence) {
                                                    console.warn(`Failed to parse MSA for UniProt ID ${uniprotId} (chain ${chainId})`);
                                                    return null;
                                                }
                                                
                                                // Trim/align MSA to match PDB sequence
                                                // Pass residue numbers so we can map correctly
                                                const trimmedMSA = trimMSAToPDB(msaData, pdbSequence, siftsMapping, pdbResidueNumbers);
                                                
                                                return {
                                                    chainId,
                                                    msaData: trimmedMSA,
                                                    filename: `AF-${uniprotId}-F1-msa_v6.a3m`
                                                };
                                            })
                                            .catch((e) => {
                                                console.warn(`Error fetching MSA for chain ${chainId} (UniProt ${uniprotId}):`, e);
                                                return null;
                                            })
                                    );
                                }
                                
                                // Wait for all MSA downloads to complete
                                const msaResults = await Promise.all(msaPromises);
                                
                                // Filter out null results and build msaDataList
                                for (const result of msaResults) {
                                    if (result) {
                                        msaDataList.push({
                                            msaData: result.msaData,
                                            filename: result.filename
                                        });
                                    }
                                }
                                
                                if (msaDataList.length > 0) {
                                    // Match MSAs to chains by sequence
                                    const {chainToMSA, msaToChains} = matchMSAsToChains(msaDataList, chainSequences);
                                    
                                    // Initialize MSA structure for object (sequence-based, supports homo-oligomers)
                                    if (Object.keys(chainToMSA).length > 0) {
                                        // Store MSA data in object (consolidated function)
                                        const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);
                                        
                                        if (msaObj && msaObj.availableChains.length > 0) {
                                            
                                            // Get MSA for default chain
                                            const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                            const {msaData: matchedMSA} = msaObj.msasBySequence[defaultChainSeq];
                                            const firstMatchedChain = msaObj.defaultChain;
                                            
                                            // Also add MSA to batchedObjects for consistency and persistence
                                            const batchedObj = batchedObjects.find(obj => obj.name === objectName);
                                            if (batchedObj) {
                                                batchedObj.msa = {
                                                    msasBySequence: msaObj.msasBySequence,
                                                    chainToSequence: msaObj.chainToSequence,
                                                    availableChains: msaObj.availableChains,
                                                    defaultChain: msaObj.defaultChain,
                                                    msaToChains: msaObj.msaToChains
                                                };
                                            }
                                            
                                            // Show MSA container and view BEFORE loading data (so resize observer gets correct dimensions)
                                            const msaContainer = document.getElementById('msa-viewer-container');
                                            const msaView = document.getElementById('msaView');
                                            if (msaContainer) {
                                                msaContainer.style.display = 'block';
                                            }
                                            if (msaView) {
                                                msaView.classList.remove('hidden');
                                            }
                                            
                                            // Force a layout recalculation to ensure container dimensions are available
                                            if (msaContainer) {
                                                void msaContainer.offsetWidth; // Force reflow
                                            }
                                            
                                            // Load MSA into viewer (consolidated function handles all setup)
                                            loadMSADataIntoViewer(matchedMSA, firstMatchedChain, objectName);
                                            
                                            setStatus(
                                                `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                                                `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                                                `MSA loaded for ${msaObj.availableChains.length} chain(s).`
                                            );
                                        } else {
                                            setStatus(
                                                `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                                                `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                                                `Warning: MSA sequences did not match any chains.`
                                            );
                                        }
                                    } else {
                                        setStatus(
                                            `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                                            `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                                            `Warning: Could not match MSAs to chains.`
                                        );
                                    }
                                } else {
                                    setStatus(
                                        `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                                        `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                                        `Note: No MSAs available for mapped UniProt IDs.`
                                    );
                                }
                            } else {
                                setStatus(
                                    `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                                    `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                                    `Warning: Could not extract chain sequences for MSA matching.`
                                );
                            }
                        }
                    }
                }
            } catch (e) {
                // PDBe mappings or MSA download failed, but structure loaded successfully
                console.warn("PDBe mappings/MSA download failed:", e);
                setStatus(
                    `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                    `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                    `Note: Could not load MSAs (${e.message}).`
                );
            }
        }
        
        // Auto-download MSA for AFDB structures (only if Load MSA is enabled)
        if (isAFDB && window.MSAViewer && loadMSA) {
            try {
                const msaUrl = `https://alphafold.ebi.ac.uk/files/msa/AF-${fetchId}-F1-msa_v6.a3m`;
                setStatus(`Fetching MSA for ${fetchId}...`);
                
                const msaResponse = await fetch(msaUrl);
                if (msaResponse.ok) {
                    const msaText = await msaResponse.text();
                    if (msaText && msaText.trim().length > 0) {
                        // Parse MSA
                        const msaData = window.MSAViewer.parseA3M(msaText);
                        
                        if (msaData && msaData.querySequence) {
                            // Get the object that was just loaded
                            const objectName = cleanObjectName(name);
                            const renderer = viewerApi?.renderer;
                            
                            if (renderer && renderer.objectsData && renderer.objectsData[objectName]) {
                                const object = renderer.objectsData[objectName];
                                
                                if (object && object.frames && object.frames.length > 0) {
                                    // Extract chain sequences from first frame
                                    const firstFrame = object.frames[0];
                                    const chainSequences = extractChainSequences(firstFrame);
                                    
                                    if (Object.keys(chainSequences).length > 0) {
                                        // Match MSA to chains
                                        const msaDataList = [{ msaData, filename: `AF-${fetchId}-F1-msa_v6.a3m` }];
                                        const {chainToMSA, msaToChains} = matchMSAsToChains(msaDataList, chainSequences);
                                        
                                        // Initialize MSA structure for object (sequence-based, supports homo-oligomers)
                                        if (Object.keys(chainToMSA).length > 0) {
                                            // Store MSA data in object (consolidated function)
                                            const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);
                                            
                                            if (msaObj && msaObj.availableChains.length > 0) {
                                                
                                                // Get MSA for default chain
                                                const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                                const {msaData: matchedMSA} = msaObj.msasBySequence[defaultChainSeq];
                                                const firstMatchedChain = msaObj.defaultChain;
                                                
                                                // MSA properties (frequencies, entropy, logOdds) are computed when MSA is loaded
                                                // No need to pre-calculate entropy separately
                                                
                                                // Also add MSA to batchedObjects for consistency and persistence
                                                const batchedObj = batchedObjects.find(obj => obj.name === objectName);
                                                if (batchedObj) {
                                                    batchedObj.msa = {
                                                        msasBySequence: msaObj.msasBySequence,
                                                        chainToSequence: msaObj.chainToSequence,
                                                        availableChains: msaObj.availableChains,
                                                        defaultChain: msaObj.defaultChain,
                                                        msaToChains: msaObj.msaToChains,
                                                        // Entropy is now stored in msaData.entropy, no need for separate entropyByChain
                                                    };
                                                }
                                                
                                                // Show MSA container and view BEFORE loading data (so resize observer gets correct dimensions)
                                                const msaContainer = document.getElementById('msa-viewer-container');
                                                const msaView = document.getElementById('msaView');
                                                if (msaContainer) {
                                                    msaContainer.style.display = 'block';
                                                }
                                                if (msaView) {
                                                    msaView.classList.remove('hidden');
                                                }
                                                
                                                // Force a layout recalculation to ensure container dimensions are available
                                                if (msaContainer) {
                                                    void msaContainer.offsetWidth; // Force reflow
                                                }
                                                
                                                // Load MSA into viewer (this will initialize resize observer with correct dimensions)
                                                window.MSAViewer.setMSAData(matchedMSA, firstMatchedChain);
                                                
                                                // Ensure view is visible after data is set
                                                if (msaView) {
                                                    msaView.classList.remove('hidden');
                                                }
                                                
                                                // Update MSA container visibility to ensure it's shown for current object
                                                if (window.updateMSAContainerVisibility) {
                                                    window.updateMSAContainerVisibility();
                                                }
                                                
                                                // Update chain selector to show available chains
                                                if (window.updateMSAChainSelectorIndex) {
                                                    window.updateMSAChainSelectorIndex();
                                                }
                                                
                                                setStatus(
                                                    `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                                                    `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                                                    `MSA loaded for chain ${firstMatchedChain}.`
                                                );
                                            }
                                        } else {
                                            setStatus(
                                                `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                                                `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                                                `Warning: MSA sequence did not match any chain.`
                                            );
                                        }
                                    } else {
                                        setStatus(
                                            `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                                            `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                                            `Warning: Could not extract chain sequences for MSA matching.`
                                        );
                                    }
                                }
                            }
                        }
                    } else {
                        setStatus(
                            `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                            `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                            `Warning: MSA file was empty.`
                        );
                    }
                } else {
                    // MSA not found, but structure loaded successfully
                    setStatus(
                        `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                        `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                        `Note: MSA not available for this structure.`
                    );
                }
            } catch (e) {
                // MSA download failed, but structure loaded successfully
                console.warn("MSA download failed:", e);
                setStatus(
                    `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
                    `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}). ` +
                    `Note: Could not download MSA (${e.message}).`
                );
            }
        } else {
        setStatus(
            `Successfully fetched and loaded ${tempBatch.length} object(s) ` +
            `(${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}).`
        );
        }

    } catch (e) {
        console.error("Fetch failed:", e);
        setStatus(`Error: Fetch failed for ${fetchId}. ${e.message}.`, true);
    }
}

// ============================================================================
// FILE UPLOAD & BATCH PROCESSING
// ============================================================================

// ============================================================================
// MSA SEQUENCE-BASED MATCHING HELPERS (Global scope for reuse)
// ============================================================================

// Residue name to single-letter amino acid code mapping
const RESIDUE_TO_AA = {
    ALA:'A', ARG:'R', ASN:'N', ASP:'D', CYS:'C', GLU:'E', GLN:'Q', GLY:'G',
    HIS:'H', ILE:'I', LEU:'L', LYS:'K', MET:'M', PHE:'F', PRO:'P', SER:'S',
    THR:'T', TRP:'W', TYR:'Y', VAL:'V', SEC:'U', PYL:'O',
    // common modified residues → canonical letters
    MSE:'M', HSD:'H', HSE:'H', HID:'H', HIE:'H', HIP:'H'
};

// ============================================================================
// ESMFold API support has been moved to app-esmfold.js for future use

// ============================================================================
// MSA UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract chain sequences from frame data
 * @param {Object} frame - Frame data with chains, position_names, residue_numbers
 * @returns {Object} - Map of chainId -> sequence string
 */
function extractChainSequences(frame) {
    if (!frame || !frame.chains || !frame.position_names) {
        return {};
    }
    
    const chainSequences = {};
    const chainPositionData = {}; // chainId -> array of {positionName, residueNum}
    
    // Group positions by chain
    for (let i = 0; i < frame.chains.length; i++) {
        const chainId = frame.chains[i];
        const positionName = frame.position_names[i];
        const residueNum = frame.residue_numbers ? frame.residue_numbers[i] : i;
        const positionType = frame.position_types ? frame.position_types[i] : 'P';
        
        // Only process protein positions (skip ligands, nucleic acids for now)
        if (positionType !== 'P') continue;
        
        if (!chainPositionData[chainId]) {
            chainPositionData[chainId] = [];
        }
        chainPositionData[chainId].push({ positionName, residueNum });
    }
    
    // Convert position names to single-letter codes for each chain
    for (const chainId of Object.keys(chainPositionData)) {
        const positionData = chainPositionData[chainId];
        // Sort by residue number to maintain order
        positionData.sort((a, b) => a.residueNum - b.residueNum);
        
        // Convert to sequence string
        const sequence = positionData.map(p => {
            const positionName = (p.positionName || '').toString().trim().toUpperCase();
            // Handle modified positions - try to get standard name
            let standardPositionName = positionName;
            if (typeof getStandardResidueName === 'function') {
                standardPositionName = getStandardResidueName(positionName).toUpperCase();
            }
            return RESIDUE_TO_AA[standardPositionName] || 'X'; // X for unknown
        }).join('');
        
        if (sequence.length > 0) {
            chainSequences[chainId] = sequence;
        }
    }
    
    return chainSequences;
}

// Expose function globally for renderer to use
window.extractChainSequences = extractChainSequences;

/**
 * Compare two sequences
 * Query sequence has no gaps (removed during MSA parsing)
 * @param {string} msaQuerySequence - Query sequence from MSA (no gaps)
 * @param {string} pdbChainSequence - Sequence from PDB chain (no gaps)
 * @returns {boolean} - True if sequences match
 */
function sequencesMatch(msaQuerySequence, pdbChainSequence) {
    if (!msaQuerySequence || !pdbChainSequence) return false;
    
    // Query sequence has no gaps, so direct comparison
    const msaSequence = msaQuerySequence.toUpperCase();
    const pdbSequence = pdbChainSequence.toUpperCase();
    
    // Exact match
    if (msaSequence === pdbSequence) return true;
    
    // Allow for small differences (e.g., missing terminal residues)
    // Check if one sequence is contained in the other (with some tolerance)
    const minLen = Math.min(msaSequence.length, pdbSequence.length);
    const maxLen = Math.max(msaSequence.length, pdbSequence.length);
    
    // If lengths are very different (>10%), don't match
    if (maxLen > 0 && (maxLen - minLen) / maxLen > 0.1) {
        return false;
    }
    
    // Check if the shorter sequence is contained in the longer one
    if (msaSequence.length <= pdbSequence.length) {
        return pdbSequence.includes(msaSequence);
    } else {
        return msaSequence.includes(pdbSequence);
    }
}

/**
 * Store MSA data in object structure
 * Consolidates all MSA storage logic into a single function
 * @param {Object} object - Object to store MSA data in
 * @param {Object} chainToMSA - Map of chainId -> {msaData}
 * @param {Object} msaToChains - Map of querySequence -> [chainId, ...]
 * @returns {Object} - The msaObj structure that was created/updated
 */
function storeMSADataInObject(object, chainToMSA, msaToChains) {
    if (!object || !chainToMSA || Object.keys(chainToMSA).length === 0) {
        return null;
    }
    
        // Initialize MSA structure if it doesn't exist
        if (!object.msa) {
            object.msa = {
                msasBySequence: {}, // querySequence -> {msaData, chains}
                chainToSequence: {}, // chainId -> querySequence
                availableChains: [],
                defaultChain: null,
                msaToChains: {} // querySequence -> [chainId, ...]
            };
        }
        
        const msaObj = object.msa;
        
        // Store msaToChains mapping
        msaObj.msaToChains = msaToChains;
        
        // Store unique MSAs and map chains
        for (const [chainId, {msaData}] of Object.entries(chainToMSA)) {
            const querySeq = msaData.querySequence.toUpperCase();
            
            // Store MSA by sequence (only one per unique sequence)
            // msaData is stored directly - it remains the canonical unfiltered source
            // (We no longer mutate it, so no deep copy needed)
            if (!msaObj.msasBySequence[querySeq]) {
                msaObj.msasBySequence[querySeq] = { 
                    msaData, 
                    chains: msaToChains[querySeq] || []
                };
            }
        
        // Map chain to sequence
        msaObj.chainToSequence[chainId] = querySeq;
        
        // Add to available chains
        if (!msaObj.availableChains.includes(chainId)) {
            msaObj.availableChains.push(chainId);
        }
    }
    
    // Set default chain (first available)
    if (msaObj.availableChains.length > 0 && !msaObj.defaultChain) {
        msaObj.defaultChain = msaObj.availableChains[0];
    }
    
    return msaObj;
}

/**
 * Load MSA data into the MSA viewer and recompute properties
 * This is a pure function that does NOT mutate stored MSA data.
 * The stored msaEntry.msaData remains the canonical unfiltered source.
 * The viewer maintains its own filtered copy internally.
 * 
 * @param {Object} msaData - MSA data object to load (unfiltered source data)
 * @param {string} chainId - Chain ID to associate with this MSA
 * @param {string} objectName - Name of the object containing this MSA
 * @param {Object} options - Optional configuration
 * @param {boolean} options.updateChainSelector - Whether to update chain selector (default: true)
 * @param {boolean} options.updateEntropyOption - Whether to update entropy option visibility (default: true)
 */
function loadMSADataIntoViewer(msaData, chainId, objectName, options = {}) {
    if (!window.MSAViewer || !msaData) return;
    
    const {
        updateChainSelector = true,
        updateEntropyOption = true
    } = options;
    
    // Load MSA data into viewer
    // NOTE: We do NOT mutate stored msaEntry.msaData - it remains the canonical unfiltered source
    // The viewer maintains its own filtered copy internally
    window.MSAViewer.setMSAData(msaData, chainId);
    
    // Get filtered MSA data and recompute properties based on current filtering
    const filteredMSAData = window.MSAViewer.getMSAData();
    if (filteredMSAData) {
        // Clear existing properties to force recomputation on filtered data
        filteredMSAData.frequencies = null;
        filteredMSAData.entropy = null;
        filteredMSAData.logOdds = null;
        // Compute properties on filtered data
        computeMSAProperties(filteredMSAData);
        
        // NOTE: We do NOT overwrite stored msaEntry.msaData with filtered data
        // The stored msaEntry.msaData remains the canonical unfiltered source
        // The viewer maintains its own filtered copy internally via setMSAData()
        // This ensures the original unfiltered MSA data is always available for copying
    }
    
    // Update chain selector
    if (updateChainSelector && window.updateMSAChainSelectorIndex) {
        window.updateMSAChainSelectorIndex();
    }
    
    // Update entropy option visibility
    if (updateEntropyOption && window.updateEntropyOptionVisibility && objectName) {
        window.updateEntropyOptionVisibility(objectName);
    }
    
    // Update sequence count to reflect the loaded MSA
    if (window.updateMSASequenceCount) {
        window.updateMSASequenceCount();
    }
}

/**
 * Compute and store frequencies, entropy, and logOdds in MSA data
 * These properties are computed once and stored with the MSA for performance
 * @param {Object} msaData - MSA data object
 */
function computeMSAProperties(msaData) {
    if (!msaData || !msaData.sequences || msaData.sequences.length === 0) return;
    
    // Compute frequencies if not already present
    if (!msaData.frequencies) {
        const frequencies = [];
        const queryLength = msaData.queryLength;
        
        for (let pos = 0; pos < queryLength; pos++) {
            const counts = {};
            let total = 0;
            
            for (const seq of msaData.sequences) {
                if (pos < seq.sequence.length) {
                    const aa = seq.sequence[pos].toUpperCase();
                    if (aa !== '-' && aa !== 'X') {
                        counts[aa] = (counts[aa] || 0) + 1;
                        total++;
                    }
                }
            }
            
            const freq = {};
            for (const aa in counts) {
                freq[aa] = counts[aa] / total;
            }
            frequencies.push(freq);
        }
        
        msaData.frequencies = frequencies;
    }
    
    // Compute entropy if not already present
    if (!msaData.entropy) {
        const frequencies = msaData.frequencies;
        if (!frequencies || frequencies.length === 0) return;
        
        const maxEntropy = Math.log2(20); // Maximum entropy for 20 amino acids
        const entropyValues = [];
        
        for (let pos = 0; pos < frequencies.length; pos++) {
            const posFreq = frequencies[pos];
            
            // Calculate Shannon entropy: H = -Σ(p_i * log2(p_i))
            let entropy = 0;
            for (const aa in posFreq) {
                const p = posFreq[aa];
                if (p > 0) {
                    entropy -= p * Math.log2(p);
                }
            }
            
            // Normalize by max entropy (0 to 1 scale)
            const normalizedEntropy = entropy / maxEntropy;
            entropyValues.push(normalizedEntropy);
        }
        
        msaData.entropy = entropyValues;
    }
    
    // logOdds will be computed on-demand when needed for logo view
}

/**
 * Merge multiple MSAs that match the same chain
 * @param {Array} msaDataList - Array of {msaData, filename} objects
 * @returns {Object} - Merged MSA data object
 */
function mergeMSAs(msaDataList) {
    if (!msaDataList || msaDataList.length === 0) return null;
    if (msaDataList.length === 1) {
        // Compute properties for single MSA
        computeMSAProperties(msaDataList[0].msaData);
        return msaDataList[0].msaData;
    }
    
    // Use first MSA as base (preserve query sequence and metadata)
    const baseMSA = msaDataList[0].msaData;
    const mergedMSA = {
        querySequence: baseMSA.querySequence,
        queryLength: baseMSA.queryLength,
        sequences: [...baseMSA.sequences], // Start with first MSA's sequences
        filenames: msaDataList.map(m => m.filename || '').filter(f => f)
    };
    
    // Track unique sequences (by sequence string, case-insensitive, ignoring gaps)
    const sequenceSet = new Set();
    // Add base sequences
    for (const seq of mergedMSA.sequences) {
        const seqKey = (seq.sequence || '').replace(/-/g, '').toUpperCase();
        if (seqKey) {
            sequenceSet.add(seqKey);
        }
    }
    
    // Merge sequences from other MSAs
    for (let i = 1; i < msaDataList.length; i++) {
        const {msaData} = msaDataList[i];
        if (!msaData || !msaData.sequences) continue;
        
        for (const seq of msaData.sequences) {
            const seqKey = (seq.sequence || '').replace(/-/g, '').toUpperCase();
            if (seqKey && !sequenceSet.has(seqKey)) {
                sequenceSet.add(seqKey);
                mergedMSA.sequences.push(seq);
            }
        }
    }
    
    // Compute properties for merged MSA
    computeMSAProperties(mergedMSA);
    
    return mergedMSA;
}

/**
 * Match MSAs to chains by comparing query sequences
 * Merges multiple MSAs that match the same chain
 * @param {Array} msaDataList - Array of {msaData, filename} objects
 * @param {Object} chainSequences - Map of chainId -> sequence string
 * @returns {Object} - Map of chainId -> {msaData} for matched chains, and msaToChains mapping
 */
function matchMSAsToChains(msaDataList, chainSequences) {
    // First, collect all MSAs per chain (before merging)
    const chainToMSAList = {}; // chainId -> [{msaData, filename}, ...]
    const msaToChains = {}; // querySequence -> [chainId, ...]
    
    for (const {msaData, filename} of msaDataList) {
        if (!msaData || !msaData.querySequence) continue;
        
        const msaQuerySequence = msaData.querySequence.toUpperCase();
        
        // Find all chains that match this MSA's query sequence
        const matchedChains = [];
        for (const [chainId, chainSequence] of Object.entries(chainSequences)) {
            if (sequencesMatch(msaQuerySequence, chainSequence)) {
                // Collect MSAs per chain (multiple MSAs can match same chain)
                if (!chainToMSAList[chainId]) {
                    chainToMSAList[chainId] = [];
                }
                chainToMSAList[chainId].push({ msaData, filename });
                matchedChains.push(chainId);
            }
        }
        
        // Store which chains this MSA maps to (before merging)
        if (matchedChains.length > 0) {
            if (!msaToChains[msaQuerySequence]) {
                msaToChains[msaQuerySequence] = [];
            }
            // Add chains that aren't already in the list
            for (const chainId of matchedChains) {
                if (!msaToChains[msaQuerySequence].includes(chainId)) {
                    msaToChains[msaQuerySequence].push(chainId);
                }
            }
        }
    }
    
    // Now merge MSAs for each chain that has multiple MSAs
    const chainToMSA = {}; // chainId -> {msaData}
    for (const [chainId, msaList] of Object.entries(chainToMSAList)) {
        if (msaList.length > 1) {
            // Multiple MSAs for this chain - merge them
            const mergedMSA = mergeMSAs(msaList);
            if (mergedMSA) {
                chainToMSA[chainId] = { msaData: mergedMSA };
            }
        } else if (msaList.length === 1) {
            // Single MSA for this chain - compute properties
            computeMSAProperties(msaList[0].msaData);
            chainToMSA[chainId] = { msaData: msaList[0].msaData };
        }
    }
    
    // Update msaToChains to reflect merged MSAs
    // Group chains by their merged MSA query sequence
    const mergedMsaToChains = {};
    for (const [chainId, {msaData}] of Object.entries(chainToMSA)) {
        const querySeq = msaData.querySequence.toUpperCase(); // Query sequence has no gaps
        if (!mergedMsaToChains[querySeq]) {
            mergedMsaToChains[querySeq] = [];
        }
        if (!mergedMsaToChains[querySeq].includes(chainId)) {
            mergedMsaToChains[querySeq].push(chainId);
        }
    }
    
    return { chainToMSA, msaToChains: mergedMsaToChains };
}


// ============================================================================
// PDBe API MAPPINGS (UniProt to PDB)
// ============================================================================

/**
 * Fetch UniProt to PDB mappings from PDBe API
 * @param {string} pdbId - 4-character PDB ID
 * @returns {Promise<Object>} - Mapping structure: {chain_id: {uniprot_id: str, pdb_to_uniprot: {pdb_resnum: uniprot_resnum}, uniprot_to_pdb: {uniprot_resnum: pdb_resnum}}}
 */
async function fetchPDBeMappings(pdbId) {
    const pdbCode = pdbId.toLowerCase();
    const apiUrl = `https://www.ebi.ac.uk/pdbe/api/mappings/uniprot/${pdbCode}/`;
    
    try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(`PDBe mappings not found for PDB ID ${pdbCode.toUpperCase()}`);
            }
            throw new Error(`Failed to fetch PDBe mappings (HTTP ${response.status})`);
        }
        
        const data = await response.json();
        
        // Parse the response structure
        // Format: {"1ubq": {"UniProt": {"P0CG48": {"mappings": [...]}}}}
        const pdbEntry = data[pdbCode];
        if (!pdbEntry || !pdbEntry.UniProt) {
            return {};
        }
        
        // Check if UniProt object is empty (no mappings available)
        const uniprotEntries = Object.entries(pdbEntry.UniProt);
        if (uniprotEntries.length === 0) {
            return {}; // Empty UniProt object, return empty mappings
        }
        
        const mappings = {};
        
        // Iterate over each UniProt entry
        for (const [uniprotId, uniprotData] of uniprotEntries) {
            if (!uniprotData.mappings || !Array.isArray(uniprotData.mappings)) {
                continue;
            }
            
            // Process each mapping range
            for (const mapping of uniprotData.mappings) {
                const chainId = mapping.chain_id;
                if (!chainId) continue;
                
                // Initialize mapping for this chain if not exists
                // If chain already exists from a different UniProt ID, skip (use first one)
                if (!mappings[chainId]) {
                    mappings[chainId] = {
                        uniprot_id: uniprotId,
                        pdb_to_uniprot: {},
                        uniprot_to_pdb: {}
                    };
                } else if (mappings[chainId].uniprot_id !== uniprotId) {
                    // Chain already mapped to a different UniProt ID, skip this mapping
                    console.warn(`Chain ${chainId} already mapped to ${mappings[chainId].uniprot_id}, skipping ${uniprotId}`);
                    continue;
                }
                
                // Build residue-to-residue mappings from the range
                // Use residue_number (internal PDB numbering) for mapping
                const pdbStart = mapping.start.residue_number;
                const pdbEnd = mapping.end.residue_number;
                const unpStart = mapping.unp_start;
                const unpEnd = mapping.unp_end;
                
                // Validate the range (check for null/undefined, not truthiness, to handle negative numbers)
                if (pdbStart == null || pdbEnd == null || unpStart == null || unpEnd == null) {
                    console.warn(`Invalid mapping range for chain ${chainId}:`, mapping);
                    continue;
                }
                
                // Calculate the length of the mapped region
                const pdbRangeLength = pdbEnd - pdbStart + 1;
                const unpRangeLength = unpEnd - unpStart + 1;
                
                // The ranges should have the same length (1-to-1 mapping)
                // But handle cases where they might differ slightly
                const rangeLength = Math.min(pdbRangeLength, unpRangeLength);
                
                // Create mappings for each residue in the range
                for (let i = 0; i < rangeLength; i++) {
                    const pdbResnum = pdbStart + i;
                    const unpResnum = unpStart + i;
                    
                    // Only add if not already mapped (in case of overlapping ranges)
                    // Prefer earlier mappings if there are conflicts
                    // Use String() to ensure consistent key type (handles negative numbers correctly)
                    const pdbKey = String(pdbResnum);
                    if (!mappings[chainId].pdb_to_uniprot[pdbKey]) {
                        mappings[chainId].pdb_to_uniprot[pdbKey] = unpResnum;
                    }
                    if (!mappings[chainId].uniprot_to_pdb[unpResnum]) {
                        mappings[chainId].uniprot_to_pdb[unpResnum] = pdbResnum;
                    }
                }
            }
        }
        
        return mappings;
    } catch (e) {
        console.error(`Error fetching PDBe mappings for ${pdbCode.toUpperCase()}:`, e);
        throw e;
    }
}

// ============================================================================
// MSA TRIMMING AND ALIGNMENT
// ============================================================================

/**
 * Trim and align MSA to match PDB sequence using SIFTS mappings
 * Handles PDB insertions (positions not in UniProt) by adding gap columns
 * Mutates the first sequence to exactly match the PDB sequence
 * @param {Object} msaData - MSA data object from parseA3M()
 * @param {string} pdbSequence - PDB chain sequence (no gaps)
 * @param {Object} siftsMapping - SIFTS mapping for this chain: {uniprot_id, pdb_to_uniprot, uniprot_to_pdb}
 * @param {Array<number>} pdbResidueNumbers - Array of PDB residue numbers corresponding to each position in pdbSequence
 * @returns {Object} - Trimmed MSA data compatible with parseA3M format
 */
function trimMSAToPDB(msaData, pdbSequence, siftsMapping, pdbResidueNumbers = null) {
    if (!msaData || !msaData.querySequence || !pdbSequence) {
        return msaData; // Return original if invalid input
    }
    
    // Get UniProt sequence from MSA (query sequence has no gaps)
    const uniprotSequence = msaData.querySequence.toUpperCase();
    const pdbSeqUpper = pdbSequence.toUpperCase();
    
    // If sequences already match (after removing gaps), no trimming needed
    if (uniprotSequence === pdbSeqUpper) {
        return msaData;
    }
    
    // Build mapping: PDB sequence position (0-indexed) -> MSA column index
    const pdbToMsaCol = {};
    
    // If we have SIFTS residue mappings, use them for precise alignment
    if (siftsMapping && siftsMapping.pdb_to_uniprot && Object.keys(siftsMapping.pdb_to_uniprot).length > 0) {
        // Map PDB sequence positions to UniProt positions, then to MSA columns
        // First, build UniProt position -> MSA column mapping
        // Query sequence has no gaps, so mapping is one-to-one
        const uniprotToMsaCol = {};
        
        for (let msaCol = 0; msaCol < msaData.querySequence.length; msaCol++) {
            const uniprotPos = msaCol + 1; // 1-indexed UniProt position
            uniprotToMsaCol[uniprotPos] = msaCol;
        }
        
        // Now map PDB sequence positions to MSA columns via UniProt
        // Use pdbResidueNumbers if available, otherwise assume sequential numbering starting from 1
        if (pdbResidueNumbers && pdbResidueNumbers.length === pdbSequence.length) {
            // We have actual PDB residue numbers for each sequence position
            for (let seqIdx = 0; seqIdx < pdbSequence.length; seqIdx++) {
                const pdbResnum = pdbResidueNumbers[seqIdx];
                // Treat missing/non-numeric PDB numbers as "no mapping" (PDB insertion)
                if (pdbResnum == null || (typeof pdbResnum === 'number' && !Number.isFinite(pdbResnum))) {
                    continue; // Will be treated as insertion (gap column)
                }
                // Convert to string for lookup (handles negative numbers correctly)
                const pdbKey = String(pdbResnum);
                const uniprotResnum = siftsMapping.pdb_to_uniprot[pdbKey];
                if (uniprotResnum !== undefined) {
                    const msaCol = uniprotToMsaCol[uniprotResnum];
                    if (msaCol !== undefined) {
                        pdbToMsaCol[seqIdx] = msaCol;
                    }
                }
                // If pdbResnum is not in mapping, it will be treated as an insertion (gap column)
            }
            } else {
            // Fallback: assume PDB residue numbers are sequential starting from 1
            for (const [pdbResnumStr, uniprotResnum] of Object.entries(siftsMapping.pdb_to_uniprot)) {
                const pdbResnum = parseInt(pdbResnumStr);
                if (!isNaN(pdbResnum)) {
                    const pdbIdx = pdbResnum - 1; // Convert to 0-indexed
                    if (pdbIdx >= 0 && pdbIdx < pdbSequence.length) {
                        const msaCol = uniprotToMsaCol[uniprotResnum];
                        if (msaCol !== undefined) {
                            pdbToMsaCol[pdbIdx] = msaCol;
                        }
                    }
                }
            }
        }
    } else {
        // Fallback: simple alignment by matching sequences
        // Try to find where PDB sequence aligns with UniProt sequence
        const pdbInUniprot = uniprotSequence.indexOf(pdbSeqUpper);
        const uniprotInPdb = pdbSeqUpper.indexOf(uniprotSequence);
        
        let msaStartOffset = 0;
        let pdbStartOffset = 0;
        
        if (pdbInUniprot >= 0) {
            // PDB sequence is contained in UniProt sequence
            msaStartOffset = pdbInUniprot;
            pdbStartOffset = 0;
        } else if (uniprotInPdb >= 0) {
            // UniProt sequence is contained in PDB sequence
            msaStartOffset = 0;
            pdbStartOffset = uniprotInPdb;
                } else {
            // Try to align from the start, allowing for small mismatches
            msaStartOffset = 0;
            pdbStartOffset = 0;
        }
        
        // Build mapping for positions that exist in both
        let msaPos = msaStartOffset;
        let pdbPos = pdbStartOffset;
        
        for (let msaCol = 0; msaCol < msaData.querySequence.length && pdbPos < pdbSequence.length; msaCol++) {
            if (msaData.querySequence[msaCol] !== '-') {
                if (msaPos < uniprotSequence.length && pdbPos < pdbSeqUpper.length) {
                    // Match if characters are the same
                    if (uniprotSequence[msaPos] === pdbSeqUpper[pdbPos]) {
                        pdbToMsaCol[pdbPos] = msaCol;
                        pdbPos++;
                    } else if (Math.abs(msaPos - msaStartOffset - (pdbPos - pdbStartOffset)) < 5) {
                        // Allow small offset differences (up to 5 positions)
                        pdbToMsaCol[pdbPos] = msaCol;
                        pdbPos++;
                    }
                }
                msaPos++;
            }
        }
    }
    
    // Build trimmed MSA: iterate through PDB positions in order
    // For each PDB position:
    //   - If mapped to MSA: use that MSA column
    //   - If not mapped (PDB insertion): add gap column
    const trimmedSequences = [];
    const trimmedQuerySequence = [];
    
    // Build trimmed sequences column by column, matching PDB sequence exactly
    for (let pdbIdx = 0; pdbIdx < pdbSequence.length; pdbIdx++) {
        const msaCol = pdbToMsaCol[pdbIdx];
        
        if (msaCol !== undefined && msaCol < msaData.querySequence.length) {
            // This PDB position maps to an MSA column
            // Use the MSA character, but mutate query sequence to match PDB if different
            const msaChar = msaData.querySequence[msaCol];
            // For query sequence, always use PDB character to ensure exact match
            trimmedQuerySequence.push(pdbSequence[pdbIdx]);
            
            // For other sequences, use MSA character (or gap if it's a gap in MSA)
            for (let seqIdx = 0; seqIdx < msaData.sequences.length; seqIdx++) {
                if (!trimmedSequences[seqIdx]) {
                    trimmedSequences[seqIdx] = {
                        ...msaData.sequences[seqIdx],
                        sequence: []
                    };
                }
                const seqChar = (msaCol < msaData.sequences[seqIdx].sequence.length) 
                    ? msaData.sequences[seqIdx].sequence[msaCol] 
                    : '-';
                trimmedSequences[seqIdx].sequence.push(seqChar);
            }
        } else {
            // This PDB position is an insertion (not in UniProt/MSA)
            // Add gap column for all MSA sequences, but use PDB character for query sequence
            trimmedQuerySequence.push(pdbSequence[pdbIdx]);
            
            // Add gaps for all other sequences
            for (let seqIdx = 0; seqIdx < msaData.sequences.length; seqIdx++) {
                if (!trimmedSequences[seqIdx]) {
                    trimmedSequences[seqIdx] = {
                        ...msaData.sequences[seqIdx],
                        sequence: []
                    };
                }
                trimmedSequences[seqIdx].sequence.push('-');
            }
        }
    }
    
    // Convert sequence arrays to strings
    const trimmedSequencesFinal = trimmedSequences.map(seq => ({
        ...seq,
        sequence: seq.sequence.join('')
    }));
    
    // Ensure the query sequence is included in the sequences array
    // The query sequence should match the trimmed query sequence exactly
    const trimmedQuerySeqStr = trimmedQuerySequence.join('');
    const queryIndex = msaData.queryIndex !== undefined ? msaData.queryIndex : 0;
    
    // Update the query sequence in the sequences array to match the trimmed version
    // The query sequence entry should be updated to use the trimmed query sequence
    if (trimmedSequencesFinal.length > 0) {
        if (queryIndex >= 0 && queryIndex < trimmedSequencesFinal.length) {
            // Update the existing query sequence entry at its original index
            trimmedSequencesFinal[queryIndex].sequence = trimmedQuerySeqStr;
        } else {
            // If queryIndex is out of bounds, add query sequence at the beginning
            trimmedSequencesFinal.unshift({
                name: trimmedSequencesFinal[0]?.name?.toLowerCase().includes('query') 
                    ? trimmedSequencesFinal[0].name 
                    : 'query',
                sequence: trimmedQuerySeqStr,
                identity: 1.0,
                coverage: 1.0
            });
        }
    } else {
        // If no sequences, add the query sequence as the only sequence
        trimmedSequencesFinal.push({
            name: 'query',
            sequence: trimmedQuerySeqStr,
            identity: 1.0,
            coverage: 1.0
        });
    }
    
    // Recalculate identity and coverage for all sequences after trimming
    const trimmedQueryLength = trimmedQuerySeqStr.length;
    for (const seq of trimmedSequencesFinal) {
        if (seq.name.toLowerCase().includes('query')) {
            seq.identity = 1.0;
            seq.coverage = 1.0;
        } else {
            // Calculate identity (fraction of matching residues to query)
            let matches = 0;
            let total = 0;
            for (let i = 0; i < seq.sequence.length && i < trimmedQuerySeqStr.length; i++) {
                const c1 = seq.sequence[i].toUpperCase();
                const c2 = trimmedQuerySeqStr[i].toUpperCase();
                if (c1 !== '-' && c1 !== 'X' && c2 !== '-' && c2 !== 'X') {
                    total++;
                    if (c1 === c2) matches++;
                }
            }
            seq.identity = total > 0 ? matches / total : 0;
            
            // Calculate coverage (non-gap positions / query length)
            let nonGapCount = 0;
            for (let i = 0; i < seq.sequence.length; i++) {
                if (seq.sequence[i] !== '-' && seq.sequence[i] !== 'X') {
                    nonGapCount++;
                }
            }
            seq.coverage = trimmedQueryLength > 0 ? nonGapCount / trimmedQueryLength : 0;
        }
    }
    
    // Create trimmed MSA data object
    // Query sequence now exactly matches PDB sequence
    const trimmedMSA = {
        querySequence: trimmedQuerySeqStr,
        queryLength: trimmedQuerySeqStr.length,
        sequences: trimmedSequencesFinal,
        queryIndex: queryIndex >= 0 && queryIndex < trimmedSequencesFinal.length ? queryIndex : 0
    };
    
    return trimmedMSA;
}

// Entropy calculation is handled by computeMSAProperties() and viewer-msa.js's calculateEntropy()
// No need for separate calculateMSAEntropy() function

// Flag to prevent infinite recursion when loading entropy data
let isLoadingEntropyData = false;

/**
 * Ensure entropy data is available for the current object/frame
 * Called when user selects entropy color mode
 * Entropy is now pre-computed and stored in msaData.entropy, so we just need to rebuild the vector
 */
function ensureEntropyDataAvailable() {
    if (!viewerApi?.renderer) return;
    
    // Prevent infinite recursion - if we're already loading entropy data, don't do it again
    if (isLoadingEntropyData) return;
    
    const objectName = viewerApi.renderer.currentObjectName;
    if (!objectName) return;
    
    const obj = viewerApi.renderer.objectsData[objectName];
    if (!obj || !obj.frames || obj.frames.length === 0) return;
    
    const currentFrameIndex = viewerApi.renderer.currentFrame || 0;
    const currentFrame = obj.frames[currentFrameIndex];
    if (!currentFrame) return;
    
    // Check if MSA data exists
    if (!obj.msa || !obj.msa.msasBySequence) {
        // No MSA data available - can't show entropy
        return;
    }
    
    // Set flag to prevent recursion
    isLoadingEntropyData = true;
    
    try {
        // Entropy is pre-computed in msaData.entropy
        // Just reload frame data to rebuild entropy vector using buildEntropyVectorForColoring
        const renderer = viewerApi.renderer;
        renderer._loadFrameData(currentFrameIndex, false); // false = render immediately
    } finally {
        // Reset flag after a short delay to allow the frame data to load
        setTimeout(() => {
            isLoadingEntropyData = false;
        }, 100);
    }
}

// mapEntropyToResiduesFromArray removed - use buildEntropyVectorForColoring() instead
// Entropy is now pre-computed and stored in msaData.entropy, and buildEntropyVectorForColoring
// handles the mapping for all chains at once

/**
 * Build entropy vector for coloring the entire structure
 * Initializes vector with -1 for all positions, then maps MSA entropy to chain positions
 * @param {Object} object - Object data with frames and MSA
 * @param {Object} frame - Frame data with chains, residue_numbers, position_types
 * @returns {Array} - Entropy vector (one value per position, -1 for unmapped)
 */
function buildEntropyVectorForColoring(object, frame) {
    if (!object || !object.msa || !frame || !frame.chains) {
        return null;
    }
    
    // Initialize vector with -1 for all positions (full molecule length)
    const positionCount = frame.chains.length;
    const entropyVector = new Array(positionCount).fill(-1);
    
    // Check if MSA data exists
    if (!object.msa.msasBySequence || !object.msa.chainToSequence) {
        return entropyVector;
    }
    
    // For each chain, get its MSA and map entropy values
    for (const [chainId, querySeq] of Object.entries(object.msa.chainToSequence)) {
        const msaEntry = object.msa.msasBySequence[querySeq];
        if (!msaEntry || !msaEntry.msaData || !msaEntry.msaData.entropy) {
            continue; // No entropy data for this chain's MSA
        }
        
        const msaData = msaEntry.msaData;
        const msaEntropy = msaData.entropy; // Pre-computed entropy array (one per MSA position)
        const msaQuerySequence = msaData.querySequence; // Query sequence has no gaps (removed during parsing)
        
        // Extract chain sequence from structure
        const chainSequences = extractChainSequences(frame);
        const chainSequence = chainSequences[chainId];
        if (!chainSequence) {
            continue; // Chain not found in frame
        }
        
        // Find representative positions for this chain (position_types === 'P')
        const chainPositions = []; // Array of position indices for this chain
        
        for (let i = 0; i < positionCount; i++) {
            if (frame.chains[i] === chainId && frame.position_types && frame.position_types[i] === 'P') {
                chainPositions.push(i);
            }
        }
        
        if (chainPositions.length === 0) {
            continue; // No representative positions found
        }
        
        // Sort positions by residue number to match sequence order
        chainPositions.sort((a, b) => {
            const residueNumA = frame.residue_numbers ? frame.residue_numbers[a] : a;
            const residueNumB = frame.residue_numbers ? frame.residue_numbers[b] : b;
            return residueNumA - residueNumB;
        });
        
        // Map MSA positions to chain positions (one-to-one mapping)
        // Query sequence has no gaps, so mapping is straightforward
        const msaQueryUpper = msaQuerySequence.toUpperCase();
        const chainSeqUpper = chainSequence.toUpperCase();
        const minLength = Math.min(msaQueryUpper.length, chainSeqUpper.length, chainPositions.length, msaEntropy.length);
        
        for (let i = 0; i < minLength; i++) {
            // Check if this MSA position matches the chain sequence position
            if (msaQueryUpper[i] === chainSeqUpper[i]) {
                // Match found - copy entropy value to corresponding position
                const positionIndex = chainPositions[i];
                if (positionIndex < entropyVector.length) {
                    entropyVector[positionIndex] = msaEntropy[i];
                }
            }
        }
    }
    
    return entropyVector;
}

// Expose function globally for renderer to use
window.buildEntropyVectorForColoring = buildEntropyVectorForColoring;

/**
 * Apply current structure selection to MSA viewer
 * Maps structure positions to MSA positions and highlights them in the MSA viewer
 */
function applySelectionToMSA() {
    if (!viewerApi?.renderer || !window.MSAViewer) return;
    
    const renderer = viewerApi.renderer;
    const objectName = renderer.currentObjectName;
    if (!objectName) return;
    
    const obj = renderer.objectsData[objectName];
    if (!obj || !obj.frames || obj.frames.length === 0) return;
    if (!obj.msa || !obj.msa.msasBySequence || !obj.msa.chainToSequence) return;
    
    const frame = obj.frames[renderer.currentFrame >= 0 ? renderer.currentFrame : 0];
    if (!frame || !frame.chains) return;
    
    // Get selected positions
    const selection = renderer.getSelection();
    let selectedPositions = new Set();
    let allSelected = false;
    
    if (selection && selection.positions && selection.positions.size > 0) {
        selectedPositions = new Set(selection.positions);
    } else if (renderer.visibilityMask !== null && renderer.visibilityMask.size > 0) {
        selectedPositions = new Set(renderer.visibilityMask);
        } else {
        // No explicit selection - all positions visible (default mode)
        allSelected = true;
    }
    
    // If all positions are selected, set a flag to indicate no dimming needed
    if (allSelected) {
        window._msaSelectedPositions = null; // null means all selected (no dimming)
        if (window.MSAViewer && window.MSAViewer.updateMSAViewSelectionState) {
            window.MSAViewer.updateMSAViewSelectionState();
            // Update sequence count after filtering
            if (window.updateMSASequenceCount) {
                window.updateMSASequenceCount();
            }
        }
        return;
    }
    
    if (selectedPositions.size === 0) {
        // Empty selection - dim everything
        window._msaSelectedPositions = new Map();
        if (window.MSAViewer && window.MSAViewer.updateMSAViewSelectionState) {
            window.MSAViewer.updateMSAViewSelectionState();
            // Update sequence count after filtering
            if (window.updateMSASequenceCount) {
                window.updateMSASequenceCount();
            }
        }
        return;
    }
    
    // Determine allowed chains
    let allowedChains;
    if (selection && selection.chains && selection.chains.size > 0) {
        allowedChains = selection.chains;
    } else {
        // All chains allowed
        allowedChains = new Set(renderer.chains);
    }
    
    // Map structure positions to MSA positions for each chain
    const msaSelectedPositions = new Map(); // chainId -> Set of MSA position indices
    
    for (const [chainId, querySeq] of Object.entries(obj.msa.chainToSequence)) {
        if (!allowedChains.has(chainId)) continue;
        
        const msaEntry = obj.msa.msasBySequence[querySeq];
        if (!msaEntry || !msaEntry.msaData) continue;
        
        const msaData = msaEntry.msaData;
        const msaQuerySequence = msaData.querySequence; // Query sequence has no gaps (removed during parsing)
        
        // Extract chain sequence from structure
        const chainSequences = extractChainSequences(frame);
        const chainSequence = chainSequences[chainId];
        if (!chainSequence) continue;
        
        // Find representative positions for this chain (position_types === 'P')
        const chainPositions = []; // Array of position indices for this chain
        const positionCount = frame.chains.length;
        
        for (let i = 0; i < positionCount; i++) {
            if (frame.chains[i] === chainId && frame.position_types && frame.position_types[i] === 'P') {
                chainPositions.push(i);
            }
        }
        
        if (chainPositions.length === 0) continue;
        
        // Sort positions by residue number to match sequence order
        chainPositions.sort((a, b) => {
            const residueNumA = frame.residue_numbers ? frame.residue_numbers[a] : a;
            const residueNumB = frame.residue_numbers ? frame.residue_numbers[b] : b;
            return residueNumA - residueNumB;
        });
        
        // Map MSA positions to chain positions (one-to-one mapping)
        // Query sequence has no gaps, so mapping is straightforward
        const msaQueryUpper = msaQuerySequence.toUpperCase();
        const chainSeqUpper = chainSequence.toUpperCase();
        const minLength = Math.min(msaQueryUpper.length, chainSeqUpper.length, chainPositions.length);
        const chainMSASelectedPositions = new Set();
        
        for (let i = 0; i < minLength; i++) {
            // Check if this MSA position matches the chain sequence position
            if (msaQueryUpper[i] === chainSeqUpper[i]) {
                // Match found - check if this structure position is selected
                const positionIndex = chainPositions[i];
                if (selectedPositions.has(positionIndex)) {
                    chainMSASelectedPositions.add(i); // i is the MSA position index
                }
            }
        }
        
        if (chainMSASelectedPositions.size > 0) {
            msaSelectedPositions.set(chainId, chainMSASelectedPositions);
        }
    }
    
    // Store selected MSA positions globally for MSA viewer to use
    // Store even if empty to indicate no selection (for dimming all positions)
    window._msaSelectedPositions = msaSelectedPositions;
    
    // Trigger MSA viewer update
    if (window.MSAViewer && window.MSAViewer.updateMSAViewSelectionState) {
        window.MSAViewer.updateMSAViewSelectionState();
        // Update sequence count after filtering
        if (window.updateMSASequenceCount) {
            window.updateMSASequenceCount();
        }
    }
}

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
        } else if (nameLower.endsWith('.a3m') || 
                   nameLower.endsWith('.fasta') || 
                   nameLower.endsWith('.fa') || 
                   nameLower.endsWith('.fas') || 
                   nameLower.endsWith('.sto')) {
            msaFiles.push(file);
        }
    }
    
    // Helper functions are now in global scope (defined above)
    // Check if PAE and MSA loading are enabled
    const loadPAECheckbox = document.getElementById('loadPAECheckbox');
    const loadMSACheckbox = document.getElementById('loadMSACheckbox');
    const loadPAE = loadPAECheckbox ? loadPAECheckbox.checked : true; // Default to enabled
    const loadMSA = loadMSACheckbox ? loadMSACheckbox.checked : false; // Default to disabled
    
    // Store MSA files for processing after structures are loaded
    // If there are no structure files, always process MSA files (MSA-only mode)
    // Otherwise, only process MSA files if the checkbox is checked
    const msaFilesToProcess = msaFiles.length > 0 && (structureFiles.length === 0 || loadMSA) ? msaFiles : [];

    // Load JSON files and check for state file signature
    const jsonContentsMap = new Map();
    const jsonLoadPromises = jsonFiles.map(jsonFile => new Promise(async (resolve) => {
        try {
            const jsonText = await jsonFile.readAsync("text");
            const jsonObject = JSON.parse(jsonText);
            
            // Check if this is a state file (has objects array)
            if (jsonObject.objects && Array.isArray(jsonObject.objects)) {
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
            
            if (stateData.objects && Array.isArray(stateData.objects)) {
                await loadViewerState(stateData);
                return { objectsLoaded: 0, framesAdded: 0, structureCount: 0, paePairedCount: 0, isTrajectory: false };
            }
        } catch (e) {
            console.error("Failed to load state file:", e);
            setStatus(`Error loading state file: ${e.message}`, true);
            return { objectsLoaded: 0, framesAdded: 0, structureCount: 0, paePairedCount: 0, isTrajectory: false };
        }
    }

    // Handle MSA-only input (no structure files)
    if (structureFiles.length === 0 && msaFilesToProcess.length > 0) {
        // Load MSA files directly without structure matching
        const msaDataList = [];
        
        for (const msaFile of msaFilesToProcess) {
            try {
                const msaText = await msaFile.readAsync("text");
                const fileName = msaFile.name.toLowerCase();
                const isA3M = fileName.endsWith('.a3m');
                const isFasta = fileName.endsWith('.fasta') || fileName.endsWith('.fa') || fileName.endsWith('.fas');
                const isSTO = fileName.endsWith('.sto');
                
                if (!isA3M && !isFasta && !isSTO) {
                    continue; // Skip unsupported MSA formats
                }
                
                let msaData = null;
                
                if (isA3M && window.MSAViewer && window.MSAViewer.parseA3M) {
                    msaData = window.MSAViewer.parseA3M(msaText);
                } else if (isFasta && window.MSAViewer && window.MSAViewer.parseFasta) {
                    msaData = window.MSAViewer.parseFasta(msaText);
                } else if (isSTO && window.MSAViewer && window.MSAViewer.parseSTO) {
                    msaData = window.MSAViewer.parseSTO(msaText);
                }
                
                if (!msaData) {
                    console.error(`Failed to parse MSA file ${msaFile.name}: parser returned null`);
                    setStatus(`Warning: Failed to parse MSA file ${msaFile.name}: No sequences found`, true);
                } else if (!msaData.querySequence) {
                    console.error(`Failed to parse MSA file ${msaFile.name}: No query sequence found`, msaData);
                    setStatus(`Warning: Failed to parse MSA file ${msaFile.name}: No query sequence found`, true);
                } else if (msaData.querySequence.length === 0) {
                    console.error(`Failed to parse MSA file ${msaFile.name}: Query sequence is empty`, msaData);
                    setStatus(`Warning: Failed to parse MSA file ${msaFile.name}: Query sequence is empty`, true);
                } else {
                    msaDataList.push({ msaData, filename: msaFile.name });
                    console.log(`Successfully parsed MSA file ${msaFile.name}: ${msaData.sequences.length} sequences, query length ${msaData.queryLength}`);
                }
            } catch (e) {
                console.error(`Failed to parse MSA file ${msaFile.name}:`, e);
                setStatus(`Warning: Failed to parse MSA file ${msaFile.name}: ${e.message}`, true);
            }
        }
        
        if (msaDataList.length > 0) {
            // Load the first MSA into the viewer
            const firstMSA = msaDataList[0];
            if (window.MSAViewer) {
                // Get the first sequence from MSA (removing gaps)
                // Use sequencesOriginal if available (preserves original order), otherwise use sequences
                // sequences array might be sorted, so sequences[0] might not be the actual first sequence
                let firstSequence = '';
                const sequencesArray = firstMSA.msaData.sequencesOriginal || firstMSA.msaData.sequences;
                
                if (sequencesArray && sequencesArray.length > 0) {
                    // Get the first sequence in original order and remove gaps
                    // This is the actual first sequence in the MSA file
                    const firstSeqWithGaps = sequencesArray[0].sequence;
                    if (firstSeqWithGaps) {
                        firstSequence = firstSeqWithGaps.replace(/-/g, '').toUpperCase();
                    }
                }
                
                // Fallback to querySequence if sequences array is empty or firstSequence is still empty
                if (!firstSequence || firstSequence.length === 0) {
                    if (firstMSA.msaData.querySequence) {
                        // Query sequence has no gaps (removed during parsing)
                        firstSequence = firstMSA.msaData.querySequence.toUpperCase();
                    }
                }
                
                // Ensure we have a valid sequence
                if (!firstSequence || firstSequence.length === 0) {
                    setStatus('Error: Could not extract sequence from MSA', true);
                    return {
                        objectsLoaded: 0,
                        framesAdded: 0,
                        structureCount: 0,
                        paePairedCount: 0,
                        isTrajectory: false
                    };
                }
                
                // Create object name from MSA filename
                const objectName = cleanObjectName(firstMSA.filename.replace(/\.(a3m|fasta|fa|fas|sto)$/i, ''));
                
                // Create helix structure for MSA-only uploads
                // ESMFold API support is available in app-esmfold.js (currently disabled)
                if (viewerApi && viewerApi.renderer && firstSequence.length > 0) {
                    // Map 1-letter codes to 3-letter codes
                    const oneToThree = {
                        'A': 'ALA', 'R': 'ARG', 'N': 'ASN', 'D': 'ASP', 'C': 'CYS', 'E': 'GLU', 'Q': 'GLN', 'G': 'GLY',
                        'H': 'HIS', 'I': 'ILE', 'L': 'LEU', 'K': 'LYS', 'M': 'MET', 'F': 'PHE', 'P': 'PRO', 'S': 'SER',
                        'T': 'THR', 'W': 'TRP', 'Y': 'TYR', 'V': 'VAL', 'U': 'SEC', 'O': 'PYL', 'X': 'UNK'
                    };
                    
                    // Convert sequence to position data
                    const n = firstSequence.length;
                    const coords = [];
                    const plddts = [];
                    const positionNames = [];
                    const chains = [];
                    const residueNumbers = [];
                    const positionTypes = [];
                    
                    // Create dummy coordinates in 3D space (helix structure)
                    // Using the helix function from README: radius=2.3, rise=1.5, rotation=100
                    // This ensures rainbow coloring and other 3D-dependent features work correctly
                    const radius = 2.3; // Helix radius (from README)
                    const rise = 1.5; // Rise per residue along helix axis (from README)
                    const rotation = 100; // Degrees per residue (from README)
                    const rotationRad = rotation * (Math.PI / 180); // Convert to radians
                    
                    for (let i = 0; i < n; i++) {
                        const aa = firstSequence[i];
                        const threeLetter = oneToThree[aa] || 'UNK';
                        
                        // Create helix coordinates following README formula
                        // angles = rotation * (π/180) * i
                        const angle = rotationRad * i;
                        const x = radius * Math.cos(angle);
                        const y = radius * Math.sin(angle);
                        const z = rise * i;
                        
                        // Use nested array format [[x, y, z], [x, y, z], ...] to match convertParsedToFrameData
                        coords.push([x, y, z]);
                        plddts.push(80.0); // Default pLDDT value
                        positionNames.push(threeLetter);
                        chains.push('A');
                        residueNumbers.push(i + 1);
                        positionTypes.push('P'); // Protein
                    }
                    
                    // Create frame data matching convertParsedToFrameData structure
                    const frameData = {
                        coords: coords, // Nested arrays [[x, y, z], ...]
                        plddts: plddts, // Array of pLDDT values
                        position_names: positionNames,
                        chains: chains,
                        residue_numbers: residueNumbers,
                        position_types: positionTypes
                    };
                    
                    // Add frame to renderer
                    viewerApi.renderer.addFrame(frameData, objectName);
                    
                    // Set as current object
                    viewerApi.renderer.currentObjectName = objectName;
                    
                    // Update object selector if it exists
                    if (viewerApi.renderer.objectSelect) {
                        let optionExists = false;
                        for (let i = 0; i < viewerApi.renderer.objectSelect.options.length; i++) {
                            if (viewerApi.renderer.objectSelect.options[i].value === objectName) {
                                optionExists = true;
                                break;
                            }
                        }
                        if (!optionExists) {
                            const option = document.createElement('option');
                            option.value = objectName;
                            option.textContent = objectName;
                            viewerApi.renderer.objectSelect.appendChild(option);
                        }
                        viewerApi.renderer.objectSelect.value = objectName;
                    }
                }
                
                // Hide viewer-container for MSA-only uploads
                const viewerContainer = document.getElementById('viewer-container');
                if (viewerContainer) {
                    viewerContainer.style.display = 'none';
                }
                
                // Hide PAE container (no PAE data for MSA-only)
                const paeContainer = document.getElementById('paeContainer');
                if (paeContainer) {
                    paeContainer.style.display = 'none';
                }
                
                // Show sequence viewer container
                const sequenceContainer = document.getElementById('sequence-viewer-container');
                if (sequenceContainer) {
                    sequenceContainer.style.display = 'block';
                }
                
                // Build sequence view
                if (typeof buildSequenceView === 'function') {
                    buildSequenceView();
                }
                
                // Trigger a render to show the helix
                if (viewerApi.renderer && viewerApi.renderer.render) {
                    viewerApi.renderer.render();
                }
                
                // Load MSA data into MSA viewer
                loadMSADataIntoViewer(firstMSA.msaData, 'A', objectName, { updateChainSelector: false });
                
                // Show MSA viewer container
                const msaContainer = document.getElementById('msa-viewer-container');
                if (msaContainer) {
                    msaContainer.style.display = 'block';
                }
                const msaView = document.getElementById('msaView');
                if (msaView) {
                    msaView.classList.remove('hidden');
                }
                
                // Update sequence count
                const sequenceCountEl = document.getElementById('msaSequenceCount');
                if (sequenceCountEl && window.MSAViewer && window.MSAViewer.getSequenceCounts) {
                    const counts = window.MSAViewer.getSequenceCounts();
                    if (counts) {
                        sequenceCountEl.textContent = `${counts.filtered} / ${counts.total}`;
                    }
                }
                
                if (msaDataList.length === 1) {
                    setStatus(`Loaded MSA: ${firstMSA.msaData.sequences.length} sequences, length ${firstMSA.msaData.queryLength}`);
                } else {
                    setStatus(`Loaded ${msaDataList.length} MSA files. Displaying first MSA: ${firstMSA.msaData.sequences.length} sequences, length ${firstMSA.msaData.queryLength}`);
                }
            } else {
                setStatus('MSA Viewer not available', true);
            }
        } else {
            setStatus('No valid MSA files found. Supported formats: .a3m, .fasta, .fa, .fas, .sto', true);
        }
        
        return {
            objectsLoaded: msaDataList.length > 0 ? 1 : 0,
            framesAdded: msaDataList.length > 0 ? 1 : 0,
            structureCount: 0,
            paePairedCount: 0,
            isTrajectory: false
        };
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
        const bestMatchJson = loadPAE ? getBestJsonMatch(structBaseName, jsonContentsMap) : null;
        
        if (bestMatchJson && loadPAE) {
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

    // Process MSA files AFTER structures are loaded (only if Load MSA is enabled)
    if (msaFilesToProcess.length > 0 && loadMSA) {
        // Get current object name (or use first available)
        const currentObjectName = viewerApi?.renderer?.currentObjectName || 
                                 (viewerApi?.renderer?.objectsData && 
                                  Object.keys(viewerApi.renderer.objectsData).length > 0 ?
                                  Object.keys(viewerApi.renderer.objectsData)[0] : null);
        
        if (currentObjectName && viewerApi?.renderer) {
            const object = viewerApi.renderer.objectsData[currentObjectName];
            if (!object || !object.frames || object.frames.length === 0) {
                setStatus("Warning: MSA files found but no structure loaded. MSA matching skipped.", true);
            } else {
                // Extract chain sequences from first frame
                const firstFrame = object.frames[0];
                const chainSequences = extractChainSequences(firstFrame);
                
                if (Object.keys(chainSequences).length === 0) {
                    setStatus("Warning: Could not extract sequences from structure. MSA matching skipped.", true);
                } else {
                    // Parse all MSA files and extract query sequences
                    const msaDataList = [];
                    
                    for (const msaFile of msaFilesToProcess) {
                        try {
                            const msaText = await msaFile.readAsync("text");
                            const msaData = window.MSAViewer ? window.MSAViewer.parseA3M(msaText) : null;
                            
                            if (msaData && msaData.querySequence) {
                                msaDataList.push({ msaData, filename: msaFile.name });
                            }
                        } catch (e) {
                            console.error(`Failed to parse MSA file ${msaFile.name}:`, e);
                        }
                    }
                    
                    if (msaDataList.length > 0) {
                        // Match MSAs to chains by sequence
                        const {chainToMSA, msaToChains} = matchMSAsToChains(msaDataList, chainSequences);
                        
                        // Store MSA data in object (consolidated function)
                        const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);
                        
                        if (msaObj && msaObj.availableChains.length > 0) {
                            // Load default chain's MSA
                            const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                            if (defaultChainSeq && msaObj.msasBySequence[defaultChainSeq]) {
                                const {msaData} = msaObj.msasBySequence[defaultChainSeq];
                                if (window.MSAViewer) {
                                    loadMSADataIntoViewer(msaData, msaObj.defaultChain, objectName);
                                    setStatus(`Loaded MSAs: ${msaObj.availableChains.length} chain(s) matched to ${Object.keys(msaObj.msasBySequence).length} unique MSA(s)`);
                                }
                            }
                        } else {
                            setStatus("Warning: No chains matched to MSA sequences.", true);
                        }
                    }
                }
            }
        }
    }

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
        
        // Collect all MSA files from all directories (for AF3 structure)
        const allMSAFiles = [];
        for (const [dirPath, fileList] of filesByDirectory.entries()) {
            const msaFilesInDir = fileList.filter(f => {
                const nameLower = f.name.toLowerCase();
                return nameLower.endsWith('.a3m') || 
                       nameLower.endsWith('.fasta') || 
                       nameLower.endsWith('.fa') || 
                       nameLower.endsWith('.fas') || 
                       nameLower.endsWith('.sto');
            });
            allMSAFiles.push(...msaFilesInDir);
        }
        
        // Determine which directories to process (for structure files)
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
        
        // Process each directory separately (structure files)
        let totalObjectsLoaded = 0;
        let totalFramesAdded = 0;
        let totalPaePairedCount = 0;
        let firstObjectName = null; // Track first object name for MSA association
        
        for (const dirPath of directoriesToProcess) {
            const fileList = filesByDirectory.get(dirPath);
            
            // Filter out MSA files from this directory (we'll process them separately)
            const structureFileList = fileList.filter(f => {
                const nameLower = f.name.toLowerCase();
                return !(nameLower.endsWith('.a3m') || 
                        nameLower.endsWith('.fasta') || 
                        nameLower.endsWith('.fa') || 
                        nameLower.endsWith('.fas') || 
                        nameLower.endsWith('.sto'));
            });
            
            // Skip if no structure files in this directory
            if (structureFileList.length === 0) continue;
            
            // Determine group name: use directory name if in subdirectory, otherwise use ZIP filename
            const groupName = dirPath 
                ? cleanObjectName(dirPath.split('/').pop()) // Use folder name
                : cleanObjectName(file.name.replace(/\.zip$/i, '')); // Use ZIP filename for root

            // Check if this directory contains a state file (only check once for root)
            if (dirPath === '') {
                const jsonFiles = structureFileList.filter(f => f.name.toLowerCase().endsWith('.json'));
                if (jsonFiles.length > 0) {
                    // Try to load as state file first
                    try {
                        const jsonText = await jsonFiles[0].readAsync("text");
                        const stateData = JSON.parse(jsonText);
                        if (stateData.objects && Array.isArray(stateData.objects)) {
                            await loadViewerState(stateData);
                            return;
                        }
                    } catch (e) {
                        // Not a state file, continue with normal processing
                    }
                }
            }

            // Process structure files in this directory as a separate object
            const stats = await processFiles(structureFileList, loadAsFrames, groupName);
            
            // Track first object name for MSA association
            if (!firstObjectName && viewerApi?.renderer?.currentObjectName) {
                firstObjectName = viewerApi.renderer.currentObjectName;
            }
            
            totalObjectsLoaded += (stats.isTrajectory ? 1 : stats.objectsLoaded);
            totalFramesAdded += stats.framesAdded;
            totalPaePairedCount += stats.paePairedCount;
        }
        
        // Now process MSA files from all directories and associate with objects
        if (allMSAFiles.length > 0 && viewerApi?.renderer) {
            // Determine which object to associate MSA with
            // Use current object (last processed), or first object if available
            const targetObjectName = viewerApi.renderer.currentObjectName || firstObjectName;
            
            if (targetObjectName) {
                // Check if MSA loading is enabled
                const loadMSACheckbox = document.getElementById('loadMSACheckbox');
                const loadMSA = loadMSACheckbox ? loadMSACheckbox.checked : false; // Default to disabled
                
                // Process MSA files using the same logic as in processFiles (only if Load MSA is enabled)
                if (!loadMSA) {
                    setStatus(`Skipping MSA files (Load MSA is disabled).`, false);
                    return;
                }
                
                // Use sequence-based matching for all MSA files (same as processFiles)
                const object = viewerApi.renderer.objectsData[targetObjectName];
                if (object && object.frames && object.frames.length > 0) {
                    // Extract chain sequences from first frame
                    const firstFrame = object.frames[0];
                    const chainSequences = extractChainSequences(firstFrame);
                    
                    if (Object.keys(chainSequences).length > 0) {
                        // Parse all MSA files and extract query sequences
                        const msaDataList = [];
                        
                        for (const msaFile of allMSAFiles) {
                            try {
                                const msaText = await msaFile.readAsync("text");
                                const msaData = window.MSAViewer ? window.MSAViewer.parseA3M(msaText) : null;
                                
                                if (msaData && msaData.querySequence) {
                                    msaDataList.push({ msaData, filename: msaFile.name });
                                }
                            } catch (e) {
                                console.error(`Failed to parse MSA file ${msaFile.name}:`, e);
                            }
                        }
                        
                        if (msaDataList.length > 0) {
                            // Match MSAs to chains by sequence
                            const {chainToMSA, msaToChains} = matchMSAsToChains(msaDataList, chainSequences);
                            
                            // Store MSA data in object (consolidated function)
                            const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);
                            
                            if (msaObj && msaObj.availableChains.length > 0) {
                                // Load default chain's MSA
                                const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                if (defaultChainSeq && msaObj.msasBySequence[defaultChainSeq]) {
                                    const {msaData} = msaObj.msasBySequence[defaultChainSeq];
                                    if (window.MSAViewer) {
                                        loadMSADataIntoViewer(msaData, msaObj.defaultChain, objectName);
                                        setStatus(`Loaded MSAs: ${msaObj.availableChains.length} chain(s) matched to ${Object.keys(msaObj.msasBySequence).length} unique MSA(s)`);
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // No structure loaded yet - parse first MSA for immediate display
                    const firstMSAFile = allMSAFiles[0];
                    if (firstMSAFile) {
                        try {
                            const msaText = await firstMSAFile.readAsync("text");
                            const msaData = window.MSAViewer ? window.MSAViewer.parseA3M(msaText) : null;
                            if (msaData && window.MSAViewer) {
                                window.MSAViewer.setMSAData(msaData);
                                setStatus(`Loaded MSA from ${firstMSAFile.name}. Load structure to match to chains.`);
                            }
                        } catch (e) {
                            console.error(`Failed to parse MSA file:`, e);
                        }
                    }
                }
            }
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
    for (const field of ['chains', 'position_types']) {
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
                if (frame.position_types) frameData.position_types = frame.position_types;
                if (frame.residue_numbers) frameData.residue_numbers = frame.residue_numbers;
                
                // Map modified residues to standard equivalents (e.g., MSE -> MET)
                if (frame.position_names) {
                    frameData.position_names = frame.position_names.map(resName => {
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
            
            // Add MSA data if it exists
            if (objectData.msa) {
                // Check if it's sequence-based structure (new format for PDB MSAs)
                if (objectData.msa.msasBySequence && objectData.msa.chainToSequence && objectData.msa.availableChains) {
                    // Sequence-based structure: save full structure
                    objToSave.msa = {
                        msasBySequence: {},
                        chainToSequence: objectData.msa.chainToSequence,
                        availableChains: objectData.msa.availableChains || [],
                        defaultChain: objectData.msa.defaultChain || null,
                        msaToChains: objectData.msa.msaToChains || {}
                    };
                    
                    // Save MSA data for each unique sequence
                    for (const [querySeq, msaEntry] of Object.entries(objectData.msa.msasBySequence)) {
                        if (msaEntry && msaEntry.msaData) {
                            objToSave.msa.msasBySequence[querySeq] = {
                                msaData: {
                                    sequences: msaEntry.msaData.sequences,
                                    querySequence: msaEntry.msaData.querySequence,
                                    queryLength: msaEntry.msaData.queryLength,
                                    queryIndex: msaEntry.msaData.queryIndex
                                },
                                chains: msaEntry.chains || []
                            };
                        }
                    }
                }
            }
            
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
        
        // Save MSA state (current chain) - only if MSA data actually exists
        if (window.MSAViewer) {
            // Check if there's actual MSA data in the viewer
            const msaData = window.MSAViewer.getMSAData ? window.MSAViewer.getMSAData() : null;
            // Also check if any objects have MSA data
            const hasObjectMSA = Object.values(renderer.objectsData).some(obj => obj.msa != null);
            
            // Only save msa_chain if there's actual MSA data
            if (msaData || hasObjectMSA) {
            const currentChain = window.MSAViewer.getCurrentChain ? window.MSAViewer.getCurrentChain() : null;
            if (currentChain) {
                viewerState.msa_chain = currentChain;
                }
            }
        }
        
        // Get selection state for ALL objects
        const selectionsByObject = {};
        for (const [objectName, objectData] of Object.entries(renderer.objectsData)) {
            if (objectData.selectionState) {
                selectionsByObject[objectName] = {
                    positions: Array.from(objectData.selectionState.positions),
                    chains: Array.from(objectData.selectionState.chains),
                    pae_boxes: objectData.selectionState.paeBoxes.map(box => ({...box})),
                    selection_mode: objectData.selectionState.selectionMode
                };
            }
        }
        
        // Create state object
        const stateData = {
            objects: objects,
            viewer_state: viewerState,
            selections_by_object: selectionsByObject
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
        // Clear existing objects
        renderer.clearAllObjects();
        
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
                const objPositionTypes = objData.position_types;
                
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
                        position_types: frameData.position_types || objPositionTypes,  // undefined if both missing
                        plddts: frameData.plddts,  // undefined if missing (will use inheritance or default)
                        pae: frameData.pae,  // undefined if missing (will use inheritance or default)
                        position_names: frameData.position_names,  // undefined if missing (will default)
                        residue_numbers: frameData.residue_numbers  // undefined if missing (will default)
                    };
                    
                    renderer.addFrame(resolvedFrame, objData.name);
                }
                
                // Restore playing state
                renderer.isPlaying = wasPlaying;
                
                
                // Store MSA data if present
                if (objData.msa) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    // Check if it's sequence-based structure (new format for PDB MSAs)
                    if (objData.msa.msasBySequence && objData.msa.chainToSequence && objData.msa.availableChains) {
                        // Sequence-based structure: restore full structure
                        renderer.objectsData[objData.name].msa = {
                            msasBySequence: {},
                            chainToSequence: objData.msa.chainToSequence || {},
                            availableChains: objData.msa.availableChains || [],
                            defaultChain: objData.msa.defaultChain || null,
                            msaToChains: objData.msa.msaToChains || {}
                        };
                        
                        // Restore MSA data for each unique sequence
                        for (const [querySeq, msaEntry] of Object.entries(objData.msa.msasBySequence)) {
                            if (msaEntry && msaEntry.msaData) {
                                // Create fresh MSA data object
                                const restoredMSAData = {
                                    sequences: msaEntry.msaData.sequences,
                                    querySequence: msaEntry.msaData.querySequence,
                                    queryLength: msaEntry.msaData.queryLength,
                                    queryIndex: msaEntry.msaData.queryIndex !== undefined ? msaEntry.msaData.queryIndex : 0
                                };
                                
                                // Set sequencesOriginal for filtering (use sequences if not saved)
                                restoredMSAData.sequencesOriginal = msaEntry.msaData.sequencesOriginal || msaEntry.msaData.sequences;
                                
                                renderer.objectsData[objData.name].msa.msasBySequence[querySeq] = {
                                    msaData: restoredMSAData,
                                    chains: msaEntry.chains || []
                                };
                                
                                // Recompute properties (frequencies, entropy, logOdds, positionIndex)
                                if (typeof computeMSAProperties === 'function') {
                                    computeMSAProperties(restoredMSAData);
                                }
                            }
                        }
                    }
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
                const validModes = ['auto', 'chain', 'rainbow', 'plddt', 'entropy'];
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
        
        // Restore selection states for ALL objects BEFORE setting frame
        // This ensures selection states are available when _switchToObject is called
        if (stateData.selections_by_object) {
            // New format: restore all objects' selection states
            for (const [objectName, ss] of Object.entries(stateData.selections_by_object)) {
                if (renderer.objectsData[objectName]) {
                    // Ensure object has selectionState initialized
                    if (!renderer.objectsData[objectName].selectionState) {
                        renderer.objectsData[objectName].selectionState = {
                            positions: new Set(),
                            chains: new Set(),
                            paeBoxes: [],
                            selectionMode: 'default'
                        };
                    }
                    
                    // Restore the saved selection state
                    let positions = new Set();
                    if (ss.positions !== undefined && Array.isArray(ss.positions)) {
                        positions = new Set(ss.positions.filter(a => typeof a === 'number' && a >= 0));
                    }
                    
                    renderer.objectsData[objectName].selectionState = {
                        positions: positions,
                        chains: new Set(ss.chains || []),
                        paeBoxes: ss.pae_boxes || [],
                        selectionMode: ss.selection_mode || 'default'
                    };
                }
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
                
                // Restore the current object's selection to the selectionModel
                // This must happen before setFrame so the selection is applied correctly
                if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]?.selectionState) {
                    renderer._switchToObject(renderer.currentObjectName); // This will restore the selection
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
                        buildSequenceView();
                        // (no defaulting here — renderer already restored the object's saved selection)
                        updateObjectNavigationButtons();
                        
                        // Restore MSA state and load MSA data into viewer
                        const currentObj = renderer.objectsData[renderer.currentObjectName];
                        if (currentObj && currentObj.msa && currentObj.msa.msasBySequence && currentObj.msa.chainToSequence) {
                            // Get the chain to load (from saved state or default)
                            let chainToLoad = null;
                            if (stateData.viewer_state && stateData.viewer_state.msa_chain) {
                                chainToLoad = stateData.viewer_state.msa_chain;
                            } else {
                                chainToLoad = currentObj.msa.defaultChain || currentObj.msa.availableChains[0];
                            }
                            
                            if (chainToLoad && currentObj.msa.chainToSequence[chainToLoad]) {
                                const querySeq = currentObj.msa.chainToSequence[chainToLoad];
                                const msaEntry = currentObj.msa.msasBySequence[querySeq];
                                
                                    if (msaEntry && msaEntry.msaData && window.MSAViewer) {
                                        // Load MSA data into viewer
                                        loadMSADataIntoViewer(msaEntry.msaData, chainToLoad, renderer.currentObjectName);
                                }
                            }
                        }
                        
                        // Trigger object change handler to ensure UI is fully updated
                        if (renderer.objectSelect) {
                            handleObjectChange();
                        }
                        
                        // Ensure MSA container visibility is updated after loading state
                        if (window.updateMSAContainerVisibility) {
                            window.updateMSAContainerVisibility();
                        }
                        
                        // Update entropy option visibility
                        if (window.updateEntropyOptionVisibility) {
                            window.updateEntropyOptionVisibility(renderer.currentObjectName);
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