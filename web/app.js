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
    
    // Setup MSA viewer callbacks (after viewerApi is initialized)
    if (window.MSAViewer) {
        window.MSAViewer.setCallbacks({
            getRenderer: () => viewerApi?.renderer || null,
            getObjectSelect: () => document.getElementById('objectSelect'),
            highlightAtom: highlightPosition,
            highlightAtoms: highlightPositions,
            clearHighlight: clearHighlight,
            applySelection: applySelection,
            getPreviewSelectionSet: () => previewSelectionSet,
            setPreviewSelectionSet: (set) => { previewSelectionSet = set; },
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
                
                // Update the stored MSA data with recomputed properties
                // Find the MSA entry for this chain and update it
                if (obj.msa.msasBySequence && obj.msa.chainToSequence) {
                    const querySeq = obj.msa.chainToSequence[chainId];
                    if (querySeq && obj.msa.msasBySequence[querySeq]) {
                        // Update the stored MSA data with filtered data (which now has recomputed properties)
                        obj.msa.msasBySequence[querySeq].msaData = filteredMSAData;
                    }
                }
                
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
    
    // Clear selection when switching objects (selection is per-object)
    // The renderer's objectSelect change handler already calls resetToDefault(),
    // but we ensure it here as well for safety
    if (viewerApi?.renderer && viewerApi.renderer.currentObjectName !== selectedObject) {
        viewerApi.renderer.resetToDefault();
    }
    
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
    } else {
        // Fallback: use objectsWithPAE Set (for backward compatibility)
        updatePAEContainerVisibilityFallback(selectedObject);
    }
    
    // Rebuild sequence view for the new object
    buildSequenceView();
    updateChainSelectionUI();
    
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
        
        // Sort positions by chain and position_index for proper neighbor checking
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
            
            // Find position index in allResidues array
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
        
        // Build position index map to avoid expensive findIndex calls
        const residueIndexMap = new Map(); // resKey -> positionIndex
        for (let i = 0; i < originalAllResidues.length; i++) {
            const residue = originalAllResidues[i];
            const resKey = residue.chain + ':' + residue.resSeq + ':' + residue.resName;
            residueIndexMap.set(resKey, i);
        }
        
        // Cache classification results per position to avoid re-classifying the same position
        const residueClassificationCache = new Map(); // resKey -> {is_protein, nucleicType}
        
        if (originalFrameData.position_types && originalFrameData.position_names && originalFrameData.position_index) {
            for (let idx = 0; idx < originalFrameData.position_types.length; idx++) {
                const positionType = originalFrameData.position_types[idx];
                const resName = originalFrameData.position_names[idx];
                const resSeq = originalFrameData.position_index[idx];
                const chain = originalFrameData.chains ? originalFrameData.chains[idx] : '';
                
                // Find the position in the original model
                const resKey = chain + ':' + resSeq + ':' + resName;
                const residue = originalResidueMap.get(resKey);
                
                if (residue) {
                    // Check cache first to avoid re-classifying the same position
                    let classification = residueClassificationCache.get(resKey);
                    if (!classification) {
                        // Get position index from map (much faster than findIndex)
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
            position_index: frameData.position_index ? [...frameData.position_index] : undefined,
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
            
            // Preserve MSA data from batchedObjects to renderer's objectsData
            // This ensures MSA data is available when switching between objects
            if (obj.msa && viewerApi?.renderer && viewerApi.renderer.objectsData[obj.name]) {
                viewerApi.renderer.objectsData[obj.name].msa = obj.msa;
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
            
            // Update MSA chain selector and container visibility
            if (window.updateMSAChainSelectorIndex) {
                window.updateMSAChainSelectorIndex();
            }
            if (window.updateMSAContainerVisibility) {
                window.updateMSAContainerVisibility();
            }
            
            // Update entropy option visibility in color menu
            updateEntropyOptionVisibility(lastObjectName);
            
            // Skip updateChainSelectionUI during initial load - setSelection is expensive
            // The renderer already defaults to showing all positions, so we don't need to explicitly set it
            // We'll let it default naturally, or set it after the first render
            // Defer updateChainSelectionUI - it's expensive and not needed for initial display
            // The structure will render with default "all positions visible" state
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
  if (!frame0?.position_index || !frame0?.chains) return;

  // Optimize: Use more efficient Set construction
  // Instead of adding one by one, build chains Set first, then positions
  const allChains = new Set(frame0.chains);
  
  // For positions, if we're selecting all, we can use a more efficient approach
  // Check if selection is already "all" (default mode with no explicit positions)
  const currentSelection = viewerApi.renderer.getSelection();
  const isAlreadyAll = currentSelection.selectionMode === 'default' && 
                       currentSelection.positions.size === 0 &&
                       (currentSelection.chains.size === 0 || 
                        currentSelection.chains.size === allChains.size);
  
  if (isAlreadyAll) {
    // Already in default "all" state, no need to update
    return;
  }

  // Select all by default using renderer API (use positions, not residues)
  // Optimize: Build Set more efficiently
  const n = frame0.chains.length;
  const allPositions = new Set();
  // Pre-allocate Set capacity hint (not standard JS, but helps some engines)
  for (let i = 0; i < n; i++) {
    allPositions.add(i); // One position per entry in frame data
  }

  viewerApi.renderer.setSelection({
    positions: allPositions,
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
  if (!frame0?.position_index || !frame0?.chains) return;

  // Get all available chains
  const allChains = new Set(frame0.chains);
  
  // Determine current chain selection
  // If chains.size === 0 and mode is 'default', all chains are selected
  let currentChains = new Set(current.chains);
  if (currentChains.size === 0 && current.selectionMode === 'default') {
    currentChains = new Set(allChains);
  }
  
  const newChains = new Set(currentChains);
  
  // Preserve existing position selections, but add/remove positions when toggling chains
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


function highlightResidue(chain, residueIndex) {
    // Legacy function - use highlightAtom instead
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedResidue = { chain, residueIndex };
        viewerApi.renderer.highlightedAtom = null; // Clear position highlight when using legacy
        viewerApi.renderer.render();
    }
}

function highlightPosition(positionIndex) {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedAtom = positionIndex;
        viewerApi.renderer.highlightedAtoms = null; // Clear multi-position highlight
        viewerApi.renderer.highlightedResidue = null; // Clear legacy highlight
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
        highlightAtom: highlightPosition,
        highlightAtoms: highlightPositions,
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

// MSA viewer callbacks are now set up in initializeApp() after viewerApi is initialized

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
                updateMSASequenceCount();
            }
        });
        
        // Also handle touch events for mobile
        coverageSlider.addEventListener('touchend', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewCoverageCutoff) {
                window.MSAViewer.applyPreviewCoverageCutoff();
                isDragging = false;
                updateMSASequenceCount();
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
                updateMSASequenceCount();
            }
        });
        
        // Also handle touch events for mobile
        identitySlider.addEventListener('touchend', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewIdentityCutoff) {
                window.MSAViewer.applyPreviewIdentityCutoff();
                isDragging = false;
                updateMSASequenceCount();
            }
        });
    }
    
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
            // New sequence-based structure
            if (obj.msa.availableChains) {
                obj.msa.availableChains.forEach(chain => chainsWithMSA.add(chain));
            }
            // Legacy structure
            else if (obj.msa.chains) {
                Object.keys(obj.msa.chains).forEach(chain => chainsWithMSA.add(chain));
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
                // Add indicator for chains with MSAs
                const hasMSA = chainsWithMSA.has(chainId);
                option.textContent = hasMSA ? `${chainId} ✓` : chainId;
                option.disabled = !hasMSA; // Disable chains without MSAs
                chainSelect.appendChild(option);
            });
        }
        
        // Get current chain from MSA viewer (source of truth)
        const currentChain = window.MSAViewer?.getCurrentChain ? window.MSAViewer.getCurrentChain() : null;
        
        // Update dropdown to match current chain
        // Priority: 1) currentChain from MSA viewer, 2) preserved value (if valid), 3) fallback
        if (currentChain && allChains.has(currentChain) && chainsWithMSA.has(currentChain)) {
            chainSelect.value = currentChain;
        } else if (preservedValue && allChains.has(preservedValue) && chainsWithMSA.has(preservedValue)) {
            // Preserve the value if it's still valid (user just selected it)
            chainSelect.value = preservedValue;
        } else if (!chainSelect.value || !allChains.has(chainSelect.value) || !chainsWithMSA.has(chainSelect.value)) {
            // Fallback: use first chain with MSA, or first chain if none have MSA
            const firstChainWithMSA = sortedAllChains.find(c => chainsWithMSA.has(c));
            chainSelect.value = firstChainWithMSA || sortedAllChains[0];
        }
        
        // Show selector if we have chains (even if only one, for consistency with viewer-seq)
        chainSelectContainer.style.display = allChains.size > 0 ? 'flex' : 'none';
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
            
            // New sequence-based structure
            if (obj.msa.msasBySequence && obj.msa.chainToSequence) {
                const querySeq = obj.msa.chainToSequence[chainId];
                if (querySeq && obj.msa.msasBySequence[querySeq]) {
                    const {msaData, type} = obj.msa.msasBySequence[querySeq];
                    window.MSAViewer.setMSAData(msaData, chainId, type);
                    
                    // Get filtered MSA data and recompute properties based on current filtering
                    const filteredMSAData = window.MSAViewer.getMSAData();
                    if (filteredMSAData) {
                        // Clear existing properties to force recomputation on filtered data
                        filteredMSAData.frequencies = null;
                        filteredMSAData.entropy = null;
                        filteredMSAData.logOdds = null;
                        // Compute properties on filtered data
                        computeMSAProperties(filteredMSAData);
                        // Update stored MSA data with filtered data and recomputed properties
                        obj.msa.msasBySequence[querySeq].msaData = filteredMSAData;
                    }
                    
                    // Update entropy option visibility after MSA is loaded
                    updateEntropyOptionVisibility(objectName);
                    
                    // Ensure dropdown value is set correctly after setMSAData
                    // (setMSAData wrapper will call updateMSAChainSelector, but we want to ensure value persists)
                    setTimeout(() => {
                        if (msaChainSelect.value !== chainId) {
                            msaChainSelect.value = chainId;
                        }
                    }, 0);
                }
            }
            // Legacy per-chain structure
            else if (obj.msa.chains && obj.msa.chains[chainId]) {
                const chainMSA = obj.msa.chains[chainId];
                const msaData = chainMSA.unpaired || chainMSA.paired;
                const type = chainMSA.unpaired ? 'unpaired' : 'paired';
                if (msaData) {
                    window.MSAViewer.setMSAData(msaData, chainId, type);
                    // Ensure dropdown value is set correctly after setMSAData
                    setTimeout(() => {
                        if (msaChainSelect.value !== chainId) {
                            msaChainSelect.value = chainId;
                        }
                    }, 0);
                }
            }
        });
    }
    
    // Handle bit-score checkbox (already declared above, just add event listener)
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
        
        // Determine type from filename (unpaired or paired)
        const type = uniprotId.toLowerCase().includes('paired') ? 'paired' : 'unpaired';
        
        // Parse and load the MSA
        if (window.MSAViewer && window.MSAViewer.parseA3M) {
            const msaData = window.MSAViewer.parseA3M(msaText, type);
            if (msaData && msaData.querySequence) {
                window.MSAViewer.setMSAData(msaData, null, type);
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
            // Determine type from filename (unpaired or paired)
            const type = file.name.toLowerCase().includes('paired') ? 'paired' : 'unpaired';
            
            let msaData = null;
            if (isA3M && window.MSAViewer && window.MSAViewer.parseA3M) {
                msaData = window.MSAViewer.parseA3M(msaText, type);
            } else if (isFasta && window.MSAViewer && window.MSAViewer.parseFasta) {
                msaData = window.MSAViewer.parseFasta(msaText, type);
            } else if (isSTO && window.MSAViewer && window.MSAViewer.parseSTO) {
                msaData = window.MSAViewer.parseSTO(msaText, type);
            }
            
            if (msaData && msaData.querySequence) {
                window.MSAViewer.setMSAData(msaData, null, type);
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

// Simplified MSA initialization for index.html
function initializeMSAViewerIndex() {
    const msaChainSelect = document.getElementById('msaChainSelect');
    const msaView = document.getElementById('msaView');
    const msaContainer = document.getElementById('msa-viewer-container');
    const msaModeSelect = document.getElementById('msaModeSelect');
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
    
    // Mode selector
    if (msaModeSelect && window.MSAViewer) {
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
    }
    
    // Sort checkbox
    if (msaSortCheckbox && window.MSAViewer) {
        msaSortCheckbox.addEventListener('change', (e) => {
            if (window.MSAViewer) {
                window.MSAViewer.setSortSequences(e.target.checked);
            }
        });
    }
    
    // Bit-score checkbox
    if (logoBitScoreCheckbox && window.MSAViewer) {
        logoBitScoreCheckbox.addEventListener('change', (e) => {
            if (window.MSAViewer) {
                window.MSAViewer.setUseBitScore(e.target.checked);
            }
        });
    }
    
    // Save button handlers
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
            }
            // Legacy format: single chain support
            else if (obj.msa && obj.msa.chainId) {
                const firstFrame = obj.frames[0];
                const allChains = new Set();
                if (firstFrame.chains) {
                    firstFrame.chains.forEach(chain => {
                        if (chain) allChains.add(chain);
                    });
                }
                
                if (allChains.size > 1) {
                    // Multiple chains - show selector but only allow selecting the chain with MSA
                    msaChainSelect.innerHTML = '';
                    const sortedChains = Array.from(allChains).sort();
                    sortedChains.forEach(chainId => {
                        const option = document.createElement('option');
                        option.value = chainId;
                        option.textContent = chainId === obj.msa.chainId ? `${chainId} ✓` : chainId;
                        option.disabled = chainId !== obj.msa.chainId; // Only allow selecting chain with MSA
                        msaChainSelect.appendChild(option);
                    });
                    msaChainSelect.value = obj.msa.chainId;
                    msaChainSelect.style.display = 'block';
                } else {
                    // Single chain - hide selector
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
                        const {msaData, type} = msaEntry;
                        // Load MSA for first chain (all chains in key share same MSA)
                        window.MSAViewer.setMSAData(msaData, firstChain, type);
                        
                        // Update default chain to first chain in the key
                        obj.msa.defaultChain = firstChain;
                        
                        // Update renderer to show entropy for selected chain key
                        const currentFrameIndex = viewerApi.renderer.currentFrame || 0;
                        viewerApi.renderer._loadFrameData(currentFrameIndex, false);
                    }
                }
            }
            // Legacy format: single chain
            else if (obj.msa.chainId === chainKey && obj.msa.msaData) {
                // Reload MSA for this chain
                window.MSAViewer.setMSAData(obj.msa.msaData, chainKey, obj.msa.type);
                
                // Ensure properties are computed for this MSA
                computeMSAProperties(obj.msa.msaData);
                
                // Invalidate entropy cache and reload frame data
                if (viewerApi.renderer) {
                    viewerApi.renderer.cachedResolvedEntropy = null;
                    viewerApi.renderer.cachedEntropyObjectName = null;
                    viewerApi.renderer.cachedEntropyPositionCount = null;
                }
                
                // Update renderer
                const currentFrameIndex = viewerApi.renderer.currentFrame || 0;
                viewerApi.renderer._loadFrameData(currentFrameIndex, false);
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
        let type = 'unpaired';
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
                    type = msaEntry.type;
                    hasMSA = !!msaToLoad;
                }
            }
        }
        // Legacy per-chain structure (backward compatibility)
        else if (obj.msa.chains && obj.msa.availableChains && obj.msa.availableChains.length > 0) {
            const targetChain = obj.msa.defaultChain || obj.msa.availableChains[obj.msa.availableChains.length - 1];
            
            if (targetChain && obj.msa.chains[targetChain]) {
                const chainMSA = obj.msa.chains[targetChain];
                msaToLoad = chainMSA.unpaired || chainMSA.paired;
                chainId = targetChain;
                type = chainMSA.unpaired ? 'unpaired' : 'paired';
                hasMSA = !!msaToLoad;
            }
        }
        // Legacy format (single MSA per object)
        else if (obj.msa.msaData) {
            msaToLoad = obj.msa.msaData;
            chainId = obj.msa.chainId || null;
            type = obj.msa.type || 'unpaired';
            hasMSA = true;
        }
        // Legacy format (sequences array)
        else if (obj.msa.sequences && obj.msa.sequences.length > 0) {
            msaToLoad = obj.msa;
            hasMSA = true;
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
            window.MSAViewer.setMSAData(msaToLoad, chainId, type);
            
            // Get filtered MSA data and recompute properties based on current filtering
            const filteredMSAData = window.MSAViewer.getMSAData();
            if (filteredMSAData && obj && obj.msa) {
                // Clear existing properties to force recomputation on filtered data
                filteredMSAData.frequencies = null;
                filteredMSAData.entropy = null;
                filteredMSAData.logOdds = null;
                // Compute properties on filtered data
                computeMSAProperties(filteredMSAData);
                
                // Update stored MSA data with filtered data and recomputed properties
                if (obj.msa.msasBySequence && obj.msa.chainToSequence && chainId) {
                    const querySeq = obj.msa.chainToSequence[chainId];
                    if (querySeq && obj.msa.msasBySequence[querySeq]) {
                        obj.msa.msasBySequence[querySeq].msaData = filteredMSAData;
                    }
                } else if (obj.msa.msaData) {
                    // Legacy format
                    obj.msa.msaData = filteredMSAData;
                }
            }
            
            // Update entropy option visibility after MSA is loaded
            updateEntropyOptionVisibility(objectName);
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
    
    // Coverage slider
    const coverageSlider = document.getElementById('coverageSlider');
    const coverageValue = document.getElementById('coverageValue');
    
    if (coverageSlider && coverageValue && window.MSAViewer) {
        const initialCutoff = window.MSAViewer.getCoverageCutoff ? window.MSAViewer.getCoverageCutoff() : 0.75;
        coverageSlider.value = Math.round(initialCutoff * 100);
        coverageValue.textContent = Math.round(initialCutoff * 100) + '%';
        
        let isDragging = false;
        
        coverageSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            coverageValue.textContent = value + '%';
            const cutoff = value / 100;
            if (window.MSAViewer && window.MSAViewer.setPreviewCoverageCutoff) {
                window.MSAViewer.setPreviewCoverageCutoff(cutoff);
            }
            isDragging = true;
        });
        
        coverageSlider.addEventListener('mouseup', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewCoverageCutoff) {
                window.MSAViewer.applyPreviewCoverageCutoff();
                isDragging = false;
        updateMSASequenceCount();
    }
        });
        
        coverageSlider.addEventListener('touchend', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewCoverageCutoff) {
                window.MSAViewer.applyPreviewCoverageCutoff();
                isDragging = false;
                updateMSASequenceCount();
            }
        });
    }
    
    // Identity slider
    const identitySlider = document.getElementById('identitySlider');
    const identityValue = document.getElementById('identityValue');
    
    if (identitySlider && identityValue && window.MSAViewer) {
        const initialCutoff = window.MSAViewer.getIdentityCutoff ? window.MSAViewer.getIdentityCutoff() : 0.15;
        identitySlider.value = Math.round(initialCutoff * 100);
        identityValue.textContent = Math.round(initialCutoff * 100) + '%';
        
        let isDragging = false;
        
        identitySlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            identityValue.textContent = value + '%';
            const cutoff = value / 100;
            if (window.MSAViewer && window.MSAViewer.setPreviewIdentityCutoff) {
                window.MSAViewer.setPreviewIdentityCutoff(cutoff);
            }
            isDragging = true;
        });
        
        identitySlider.addEventListener('mouseup', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewIdentityCutoff) {
                window.MSAViewer.applyPreviewIdentityCutoff();
                isDragging = false;
                updateMSASequenceCount();
            }
        });
        
        identitySlider.addEventListener('touchend', () => {
            if (isDragging && window.MSAViewer && window.MSAViewer.applyPreviewIdentityCutoff) {
                window.MSAViewer.applyPreviewIdentityCutoff();
                isDragging = false;
                updateMSASequenceCount();
            }
        });
    }
    
    // Update sequence count when MSA data is set
    if (window.MSAViewer && window.MSAViewer.setMSAData) {
        const originalSetMSAData = window.MSAViewer.setMSAData;
        // Only wrap if not already wrapped
        if (!originalSetMSAData._indexHtmlWrapped) {
            window.MSAViewer.setMSAData = function(data, chainId, type) {
                originalSetMSAData.call(this, data, chainId, type);
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

// Set up MSA viewer callbacks after viewer is initialized
function setupMSAViewerCallbacks() {
    if (window.MSAViewer && viewerApi?.renderer) {
        window.MSAViewer.setCallbacks({
            getRenderer: () => viewerApi.renderer
        });
    }
}

// Set up callbacks when viewer is ready
if (viewerApi && viewerApi.renderer) {
    setupMSAViewerCallbacks();
} else {
    // Wait for viewer to be initialized
    setTimeout(() => {
        setupMSAViewerCallbacks();
    }, 500);
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

    // Check if PAE and MSA loading are enabled
    const loadPAECheckbox = document.getElementById('loadPAECheckbox');
    const loadMSACheckbox = document.getElementById('loadMSACheckbox');
    const loadPAE = loadPAECheckbox ? loadPAECheckbox.checked : true; // Default to enabled
    const loadMSA = loadMSACheckbox ? loadMSACheckbox.checked : true; // Default to enabled

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
                                    
                                    // Sanitize the index to a number or null
                                    const rawIndex = firstFrame.position_index ? firstFrame.position_index[i] : null;
                                    const numericIndex = rawIndex == null ? null : Number(rawIndex);
                                    const positionIndex = Number.isFinite(numericIndex) ? numericIndex : null;
                                    
                                    if (!chainSequencesWithResnums[chainId]) {
                                        chainSequencesWithResnums[chainId] = {
                                            sequence: '',
                                            residueNumbers: [] // Maps sequence position -> PDB residue number (can be null)
                                        };
                                    }
                                    
                                    const positionName = firstFrame.position_names[i];
                                    const aa = RESIDUE_TO_AA[positionName?.toUpperCase()] || 'X';
                                    chainSequencesWithResnums[chainId].sequence += aa;
                                    chainSequencesWithResnums[chainId].residueNumbers.push(positionIndex);
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
                                                const msaData = window.MSAViewer.parseA3M(msaText, 'unpaired');
                                                
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
                                                    type: 'unpaired',
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
                                            type: result.type,
                                            filename: result.filename
                                        });
                                    }
                                }
                                
                                if (msaDataList.length > 0) {
                                    // Match MSAs to chains by sequence
                                    const {chainToMSA, msaToChains} = matchMSAsToChains(msaDataList, chainSequences);
                                    
                                    // Initialize MSA structure for object (sequence-based, supports homo-oligomers)
                                    if (Object.keys(chainToMSA).length > 0) {
                                        // Initialize MSA structure
                                        if (!object.msa) {
                                            object.msa = {
                                                msasBySequence: {},
                                                chainToSequence: {},
                                                availableChains: [],
                                                defaultChain: null,
                                                msaToChains: {}
                                            };
                                        }
                                        
                                        const msaObj = object.msa;
                                        
                                        // Store msaToChains mapping
                                        msaObj.msaToChains = msaToChains;
                                        
                                        // Store unique MSAs and map chains
                                        for (const [chainId, {msaData, type}] of Object.entries(chainToMSA)) {
                                            const querySeqNoGaps = msaData.querySequence.replace(/-/g, '').toUpperCase();
                                            
                                            // Store MSA by sequence (only one per unique sequence)
                                            if (!msaObj.msasBySequence[querySeqNoGaps]) {
                                                msaObj.msasBySequence[querySeqNoGaps] = { 
                                                    msaData, 
                                                    type,
                                                    chains: msaToChains[querySeqNoGaps] || []
                                                };
                                            }
                                            
                                            // Map chain to sequence
                                            msaObj.chainToSequence[chainId] = querySeqNoGaps;
                                            
                                            // Add to available chains
                                            if (!msaObj.availableChains.includes(chainId)) {
                                                msaObj.availableChains.push(chainId);
                                            }
                                        }
                                        
                                        // Set default chain (first available)
                                        if (msaObj.availableChains.length > 0) {
                                            msaObj.defaultChain = msaObj.availableChains[0];
                                            
                                            // Get MSA for default chain
                                            const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                            const {msaData: matchedMSA, type} = msaObj.msasBySequence[defaultChainSeq];
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
                                            
                                            // Load MSA into viewer (this will initialize resize observer with correct dimensions)
                                            window.MSAViewer.setMSAData(matchedMSA, firstMatchedChain, type);
                                            
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
                        const msaData = window.MSAViewer.parseA3M(msaText, 'unpaired');
                        
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
                                        const msaDataList = [{ msaData, type: 'unpaired', filename: `AF-${fetchId}-F1-msa_v6.a3m` }];
                                        const {chainToMSA, msaToChains} = matchMSAsToChains(msaDataList, chainSequences);
                                        
                                        // Initialize MSA structure for object (sequence-based, supports homo-oligomers)
                                        if (Object.keys(chainToMSA).length > 0) {
                                            // Initialize MSA structure
                                            if (!object.msa) {
                                                object.msa = {
                                                    msasBySequence: {},
                                                    chainToSequence: {},
                                                    availableChains: [],
                                                    defaultChain: null,
                                                    msaToChains: {}
                                                };
                                            }
                                            
                                            const msaObj = object.msa;
                                            
                                            // Store msaToChains mapping
                                            msaObj.msaToChains = msaToChains;
                                            
                                            // Store unique MSAs and map chains
                                            for (const [chainId, {msaData, type}] of Object.entries(chainToMSA)) {
                                                const querySeqNoGaps = msaData.querySequence.replace(/-/g, '').toUpperCase();
                                                
                                                // Store MSA by sequence (only one per unique sequence)
                                                if (!msaObj.msasBySequence[querySeqNoGaps]) {
                                                    msaObj.msasBySequence[querySeqNoGaps] = { 
                                                        msaData, 
                                                        type,
                                                        chains: msaToChains[querySeqNoGaps] || []
                                                    };
                                                }
                                                
                                                // Map chain to sequence
                                                msaObj.chainToSequence[chainId] = querySeqNoGaps;
                                                
                                                // Add to available chains
                                                if (!msaObj.availableChains.includes(chainId)) {
                                                    msaObj.availableChains.push(chainId);
                                                }
                                            }
                                            
                                            // Set default chain (first available)
                                            if (msaObj.availableChains.length > 0) {
                                                msaObj.defaultChain = msaObj.availableChains[0];
                                                
                                                // Get MSA for default chain
                                                const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                                const {msaData: matchedMSA, type} = msaObj.msasBySequence[defaultChainSeq];
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
                                                window.MSAViewer.setMSAData(matchedMSA, firstMatchedChain, type);
                                                
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

/**
 * Extract sequence for each chain from frame data
 * @param {Object} frame - Frame data with position_names, chains, position_index, position_types
 * @returns {Object} - Map of chainId -> sequence string
 */
function extractChainSequences(frame) {
    if (!frame || !frame.chains || !frame.position_names) {
        return {};
    }
    
    const chainSequences = {};
    const chainPositionData = {}; // chainId -> array of {positionName, positionIndex}
    
    // Group positions by chain
    for (let i = 0; i < frame.chains.length; i++) {
        const chainId = frame.chains[i];
        const positionName = frame.position_names[i];
        const positionIndex = frame.position_index ? frame.position_index[i] : i;
        const positionType = frame.position_types ? frame.position_types[i] : 'P';
        
        // Only process protein positions (skip ligands, nucleic acids for now)
        if (positionType !== 'P') continue;
        
        if (!chainPositionData[chainId]) {
            chainPositionData[chainId] = [];
        }
        chainPositionData[chainId].push({ positionName, positionIndex });
    }
    
    // Convert position names to single-letter codes for each chain
    for (const chainId of Object.keys(chainPositionData)) {
        const positionData = chainPositionData[chainId];
        // Sort by position index to maintain order
        positionData.sort((a, b) => a.positionIndex - b.positionIndex);
        
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
 * Compare two sequences, allowing for gaps in MSA query sequence
 * Removes gaps from MSA query sequence and compares with PDB chain sequence
 * @param {string} msaQuerySequence - Query sequence from MSA (may contain gaps '-')
 * @param {string} pdbChainSequence - Sequence from PDB chain (no gaps)
 * @returns {boolean} - True if sequences match (after removing gaps from MSA)
 */
function sequencesMatch(msaQuerySequence, pdbChainSequence) {
    if (!msaQuerySequence || !pdbChainSequence) return false;
    
    // Remove gaps from MSA query sequence
    const msaSequenceNoGaps = msaQuerySequence.replace(/-/g, '').toUpperCase();
    const pdbSequence = pdbChainSequence.toUpperCase();
    
    // Exact match
    if (msaSequenceNoGaps === pdbSequence) return true;
    
    // Allow for small differences (e.g., missing terminal residues)
    // Check if one sequence is contained in the other (with some tolerance)
    const minLen = Math.min(msaSequenceNoGaps.length, pdbSequence.length);
    const maxLen = Math.max(msaQuerySequence.length, pdbChainSequence.length);
    
    // If lengths are very different (>10%), don't match
    if (maxLen > 0 && (maxLen - minLen) / maxLen > 0.1) {
        return false;
    }
    
    // Check if the shorter sequence is contained in the longer one
    if (msaSequenceNoGaps.length <= pdbSequence.length) {
        return pdbSequence.includes(msaSequenceNoGaps);
    } else {
        return msaSequenceNoGaps.includes(pdbSequence);
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
 * @param {Array} msaDataList - Array of {msaData, type, filename} objects
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
        type: baseMSA.type || msaDataList[0].type,
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
 * @param {Array} msaDataList - Array of {msaData, type, filename} objects
 * @param {Object} chainSequences - Map of chainId -> sequence string
 * @returns {Object} - Map of chainId -> {msaData, type} for matched chains, and msaToChains mapping
 */
function matchMSAsToChains(msaDataList, chainSequences) {
    // First, collect all MSAs per chain (before merging)
    const chainToMSAList = {}; // chainId -> [{msaData, type, filename}, ...]
    const msaToChains = {}; // querySequence (no gaps) -> [chainId, ...]
    
    for (const {msaData, type, filename} of msaDataList) {
        if (!msaData || !msaData.querySequence) continue;
        
        const msaQuerySequence = msaData.querySequence.replace(/-/g, '').toUpperCase();
        
        // Find all chains that match this MSA's query sequence
        const matchedChains = [];
        for (const [chainId, chainSequence] of Object.entries(chainSequences)) {
            if (sequencesMatch(msaQuerySequence, chainSequence)) {
                // Collect MSAs per chain (multiple MSAs can match same chain)
                if (!chainToMSAList[chainId]) {
                    chainToMSAList[chainId] = [];
                }
                chainToMSAList[chainId].push({ msaData, type, filename });
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
    const chainToMSA = {}; // chainId -> {msaData, type}
    for (const [chainId, msaList] of Object.entries(chainToMSAList)) {
        if (msaList.length > 1) {
            // Multiple MSAs for this chain - merge them
            const mergedMSA = mergeMSAs(msaList);
            if (mergedMSA) {
                chainToMSA[chainId] = { msaData: mergedMSA, type: msaList[0].type };
            }
        } else if (msaList.length === 1) {
            // Single MSA for this chain - compute properties
            computeMSAProperties(msaList[0].msaData);
            chainToMSA[chainId] = { msaData: msaList[0].msaData, type: msaList[0].type };
        }
    }
    
    // Update msaToChains to reflect merged MSAs
    // Group chains by their merged MSA query sequence
    const mergedMsaToChains = {};
    for (const [chainId, {msaData}] of Object.entries(chainToMSA)) {
        const querySeq = msaData.querySequence.replace(/-/g, '').toUpperCase();
        if (!mergedMsaToChains[querySeq]) {
            mergedMsaToChains[querySeq] = [];
        }
        if (!mergedMsaToChains[querySeq].includes(chainId)) {
            mergedMsaToChains[querySeq].push(chainId);
        }
    }
    
    return { chainToMSA, msaToChains: mergedMsaToChains };
}

// Helper function to detect if MSA file is paired or unpaired
function detectMSAType(filename) {
    const nameLower = filename.toLowerCase();
    if (nameLower.includes('_paired_msa_')) {
        return 'paired';
    } else if (nameLower.includes('_unpaired_msa_')) {
        return 'unpaired';
    }
    return 'unpaired'; // Default
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
    
    // Get UniProt sequence from MSA (query sequence, remove gaps)
    const uniprotSequence = msaData.querySequence.replace(/-/g, '').toUpperCase();
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
        const uniprotToMsaCol = {};
        let msaPos = 0; // Position in UniProt sequence (without gaps)
        
        for (let msaCol = 0; msaCol < msaData.querySequence.length; msaCol++) {
            if (msaData.querySequence[msaCol] !== '-') {
                const uniprotPos = msaPos + 1; // 1-indexed UniProt position
                uniprotToMsaCol[uniprotPos] = msaCol;
                msaPos++;
            }
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
                header: trimmedSequencesFinal[0]?.header?.toLowerCase().includes('query') 
                    ? trimmedSequencesFinal[0].header 
                    : 'query',
                sequence: trimmedQuerySeqStr,
                isPaired: false,
                similarity: 100,
                coverage: 100
            });
        }
    } else {
        // If no sequences, add the query sequence as the only sequence
        trimmedSequencesFinal.push({
            header: 'query',
            sequence: trimmedQuerySeqStr,
            isPaired: false,
            similarity: 100,
            coverage: 100
        });
    }
    
    // Create trimmed MSA data object
    // Query sequence now exactly matches PDB sequence
    const trimmedMSA = {
        querySequence: trimmedQuerySeqStr,
        queryLength: trimmedQuerySeqStr.length,
        sequences: trimmedSequencesFinal,
        queryIndex: queryIndex >= 0 && queryIndex < trimmedSequencesFinal.length ? queryIndex : 0,
        type: msaData.type || 'unpaired'
    };
    
    return trimmedMSA;
}

/**
 * Calculate Shannon entropy for each position in MSA
 * Now uses the unified calculation from MSAViewer (same as logo/PSSM) when available
 * @param {Object} msaData - MSA data object from parseA3M()
 * @returns {Array} - Array of entropy values (one per MSA position)
 */
function calculateMSAEntropy(msaData) {
    if (!msaData || !msaData.sequences || msaData.sequences.length === 0) {
        return [];
    }
    
    // Try to use unified entropy calculation from MSAViewer if available
    // This ensures consistency with logo/PSSM calculations (uses same frequency calculation)
    if (window.MSAViewer && window.MSAViewer.calculateEntropy) {
        // Check if MSAViewer has the same data loaded
        const viewerMSA = window.MSAViewer.getMSAData();
        if (viewerMSA && viewerMSA.querySequence === msaData.querySequence && 
            viewerMSA.sequences.length === msaData.sequences.length) {
            try {
                return window.MSAViewer.calculateEntropy();
            } catch (e) {
                console.warn('Failed to use MSAViewer entropy calculation, falling back to direct method:', e);
            }
        }
    }
    
    // Fallback: direct calculation (for initial load before MSAViewer is set up, or if data doesn't match)
    // This uses the same formula but calculates frequencies directly
    const queryLength = msaData.queryLength;
    const entropyValues = [];
    
    // Standard 20 amino acids
    const aminoAcids = 'ACDEFGHIKLMNPQRSTVWY';
    const maxEntropy = Math.log2(20); // Maximum entropy for 20 amino acids
    
    // Calculate entropy for each position
    for (let pos = 0; pos < queryLength; pos++) {
        // Count amino acid frequencies at this position (ignore gaps and lowercase)
        const counts = {};
        let totalCount = 0;
        
        for (const seq of msaData.sequences) {
            if (seq.sequence && pos < seq.sequence.length) {
                const aa = seq.sequence[pos].toUpperCase();
                // Only count standard amino acids (ignore gaps '-', lowercase insertions, and non-standard)
                if (aminoAcids.includes(aa)) {
                    counts[aa] = (counts[aa] || 0) + 1;
                    totalCount++;
                }
            }
        }
        
        // Calculate Shannon entropy: H = -Σ(p_i * log2(p_i))
        let entropy = 0;
        if (totalCount > 0) {
            for (const aa of Object.keys(counts)) {
                const p = counts[aa] / totalCount;
                if (p > 0) {
                    entropy -= p * Math.log2(p);
                }
            }
        }
        
        // Normalize by max entropy (0 to 1 scale)
        const normalizedEntropy = totalCount > 0 ? entropy / maxEntropy : 0;
        entropyValues.push(normalizedEntropy);
    }
    
    return entropyValues;
}

// mapEntropyToResidues removed - use buildEntropyVectorForColoring() instead
// Entropy is now pre-computed and stored in msaData.entropy

// precalculateEntropyForObject removed - entropy is now computed once when MSA is loaded
// and stored in msaData.entropy. Use buildEntropyVectorForColoring() to build the vector for coloring.

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
 * @param {Object} frame - Frame data with chains, position_index, position_types
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
        const msaQuerySequence = msaData.querySequence; // May contain gaps
        
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
        
        // Sort positions by position index to match sequence order
        chainPositions.sort((a, b) => {
            const indexA = frame.position_index ? frame.position_index[a] : a;
            const indexB = frame.position_index ? frame.position_index[b] : b;
            return indexA - indexB;
        });
        
        // Map MSA positions to chain positions (one-to-one mapping)
        // Walk through MSA query sequence and match to chain sequence
        let msaPos = 0; // Position in MSA entropy array (skipping gaps)
        let chainSeqIdx = 0; // Position in chain sequence
        const msaQueryUpper = msaQuerySequence.toUpperCase();
        const chainSeqUpper = chainSequence.toUpperCase();
        
        for (let i = 0; i < msaQueryUpper.length && chainSeqIdx < chainPositions.length; i++) {
            const msaChar = msaQueryUpper[i];
            
            if (msaChar === '-') {
                // Gap in MSA - skip this position (don't increment msaPos)
                continue;
            }
            
            // Check if this MSA position matches the current chain sequence position
            if (chainSeqIdx < chainSeqUpper.length && msaChar === chainSeqUpper[chainSeqIdx]) {
                // Match found - copy entropy value to corresponding position
                if (msaPos < msaEntropy.length) {
                    const positionIndex = chainPositions[chainSeqIdx];
                    if (positionIndex < entropyVector.length) {
                        entropyVector[positionIndex] = msaEntropy[msaPos];
                    }
                }
                chainSeqIdx++;
                msaPos++; // Only increment msaPos when we process a non-gap character
                        } else {
                // Mismatch - still increment msaPos to stay in sync
                msaPos++;
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
    
    if (selection && selection.positions && selection.positions.size > 0) {
        selectedPositions = new Set(selection.positions);
    } else if (renderer.visibilityMask !== null && renderer.visibilityMask.size > 0) {
        selectedPositions = new Set(renderer.visibilityMask);
        } else {
        // No selection - all positions visible (default mode)
        return; // Don't apply selection if everything is selected
    }
    
    if (selectedPositions.size === 0) return;
    
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
        const msaQuerySequence = msaData.querySequence; // May contain gaps
        
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
        
        // Sort positions by position index to match sequence order
        chainPositions.sort((a, b) => {
            const indexA = frame.position_index ? frame.position_index[a] : a;
            const indexB = frame.position_index ? frame.position_index[b] : b;
            return indexA - indexB;
        });
        
        // Map MSA positions to chain positions (one-to-one mapping)
        // Walk through MSA query sequence and match to chain sequence
        let msaPos = 0; // Position in MSA (skipping gaps)
        let chainSeqIdx = 0; // Position in chain sequence
        const msaQueryUpper = msaQuerySequence.toUpperCase();
        const chainSeqUpper = chainSequence.toUpperCase();
        const chainMSASelectedPositions = new Set();
        
        for (let i = 0; i < msaQueryUpper.length && chainSeqIdx < chainPositions.length; i++) {
            const msaChar = msaQueryUpper[i];
            
            if (msaChar === '-') {
                // Gap in MSA - skip this position (don't increment msaPos)
                continue;
            }
            
            // Check if this MSA position matches the current chain sequence position
            if (chainSeqIdx < chainSeqUpper.length && msaChar === chainSeqUpper[chainSeqIdx]) {
                // Match found - check if this structure position is selected
                const positionIndex = chainPositions[chainSeqIdx];
                if (selectedPositions.has(positionIndex)) {
                    chainMSASelectedPositions.add(msaPos);
                }
                chainSeqIdx++;
                msaPos++; // Only increment msaPos when we process a non-gap character
            } else {
                // Mismatch - still increment msaPos to stay in sync
                msaPos++;
            }
        }
        
        if (chainMSASelectedPositions.size > 0) {
            msaSelectedPositions.set(chainId, chainMSASelectedPositions);
        }
    }
    
    // Store selected MSA positions globally for MSA viewer to use
    if (msaSelectedPositions.size > 0) {
        window._msaSelectedPositions = msaSelectedPositions;
        
        // Trigger MSA viewer update by calling updateMSAViewSelectionState if it exists
        // For now, we'll store the selection and the MSA viewer can check it when rendering
        // This requires modification to the MSA viewer to actually highlight the positions
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
    const loadMSA = loadMSACheckbox ? loadMSACheckbox.checked : true; // Default to enabled
    
    // Store MSA files for processing after structures are loaded
    const msaFilesToProcess = msaFiles.length > 0 && loadMSA ? msaFiles : [];

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
                
                const type = detectMSAType(msaFile.name);
                let msaData = null;
                
                if (isA3M && window.MSAViewer && window.MSAViewer.parseA3M) {
                    msaData = window.MSAViewer.parseA3M(msaText, type);
                } else if (isFasta && window.MSAViewer && window.MSAViewer.parseFasta) {
                    msaData = window.MSAViewer.parseFasta(msaText, type);
                } else if (isSTO && window.MSAViewer && window.MSAViewer.parseSTO) {
                    msaData = window.MSAViewer.parseSTO(msaText, type);
                }
                
                if (msaData && msaData.querySequence) {
                    msaDataList.push({ msaData, type, filename: msaFile.name });
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
                window.MSAViewer.setMSAData(firstMSA.msaData, null, firstMSA.type);
                
                // Get filtered MSA data and recompute properties
                const filteredMSAData = window.MSAViewer.getMSAData();
                if (filteredMSAData) {
                    // Clear existing properties to force recomputation on filtered data
                    filteredMSAData.frequencies = null;
                    filteredMSAData.entropy = null;
                    filteredMSAData.logOdds = null;
                    // Compute properties on filtered data
                    computeMSAProperties(filteredMSAData);
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
            objectsLoaded: 0,
            framesAdded: 0,
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
                            const type = detectMSAType(msaFile.name);
                            const msaData = window.MSAViewer ? window.MSAViewer.parseA3M(msaText, type) : null;
                            
                            if (msaData && msaData.querySequence) {
                                msaDataList.push({ msaData, type, filename: msaFile.name });
                            }
                        } catch (e) {
                            console.error(`Failed to parse MSA file ${msaFile.name}:`, e);
                        }
                    }
                    
                    if (msaDataList.length > 0) {
                        // Match MSAs to chains by sequence
                        const {chainToMSA, msaToChains} = matchMSAsToChains(msaDataList, chainSequences);
                        
                        // Initialize MSA structure for object
                        if (!object.msa) {
                            object.msa = {
                                // Store one MSA per unique query sequence
                                msasBySequence: {}, // querySequence (no gaps) -> {msaData, type, chains}
                                // Map chains to query sequences
                                chainToSequence: {}, // chainId -> querySequence (no gaps)
                                // All chains that have MSAs
                                availableChains: [],
                                defaultChain: null,
                                // Map MSA query sequences to chains (for homo-oligomer grouping)
                                msaToChains: {} // querySequence (no gaps) -> [chainId, ...]
                            };
                        }
                        
                        const msaObj = object.msa;
                        
                        // Store msaToChains mapping
                        msaObj.msaToChains = msaToChains;
                        
                        // Store unique MSAs and map chains
                        for (const [chainId, {msaData, type}] of Object.entries(chainToMSA)) {
                            const querySeqNoGaps = msaData.querySequence.replace(/-/g, '').toUpperCase();
                            
                            // Store MSA by sequence (only one per unique sequence)
                            if (!msaObj.msasBySequence[querySeqNoGaps]) {
                                msaObj.msasBySequence[querySeqNoGaps] = { 
                                    msaData, 
                                    type,
                                    chains: msaToChains[querySeqNoGaps] || []
                                };
                            }
                            
                            // Map chain to sequence
                            msaObj.chainToSequence[chainId] = querySeqNoGaps;
                            
                            // Add to available chains
                            if (!msaObj.availableChains.includes(chainId)) {
                                msaObj.availableChains.push(chainId);
                            }
                        }
                        
                        // Set default chain (first available, or first chain with MSA)
                        if (msaObj.availableChains.length > 0) {
                            msaObj.defaultChain = msaObj.availableChains[0];
                            
                            // Load default chain's MSA
                            const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                            if (defaultChainSeq && msaObj.msasBySequence[defaultChainSeq]) {
                                const {msaData, type} = msaObj.msasBySequence[defaultChainSeq];
                                if (window.MSAViewer) {
                                    window.MSAViewer.setMSAData(msaData, msaObj.defaultChain, type);
                                    
                                    // Get filtered MSA data and recompute properties based on current filtering
                                    const filteredMSAData = window.MSAViewer.getMSAData();
                                    if (filteredMSAData) {
                                        // Clear existing properties to force recomputation on filtered data
                                        filteredMSAData.frequencies = null;
                                        filteredMSAData.entropy = null;
                                        filteredMSAData.logOdds = null;
                                        // Compute properties on filtered data
                                        computeMSAProperties(filteredMSAData);
                                        // Update stored MSA data with filtered data and recomputed properties
                                        msaObj.msasBySequence[defaultChainSeq].msaData = filteredMSAData;
                                    }
                                    
                                    // Update chain selector to show available chains
                                    if (window.updateMSAChainSelectorIndex) {
                                        window.updateMSAChainSelectorIndex();
                                    }
                                    
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
                        if (stateData.py2dmol_version) {
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
                const loadMSA = loadMSACheckbox ? loadMSACheckbox.checked : true; // Default to enabled
                
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
                                const type = detectMSAType(msaFile.name);
                                const msaData = window.MSAViewer ? window.MSAViewer.parseA3M(msaText, type) : null;
                                
                                if (msaData && msaData.querySequence) {
                                    msaDataList.push({ msaData, type, filename: msaFile.name });
                                }
                            } catch (e) {
                                console.error(`Failed to parse MSA file ${msaFile.name}:`, e);
                            }
                        }
                        
                        if (msaDataList.length > 0) {
                            // Match MSAs to chains by sequence
                            const {chainToMSA, msaToChains} = matchMSAsToChains(msaDataList, chainSequences);
                            
                            // Initialize MSA structure for object
                            if (!object.msa) {
                                object.msa = {
                                    msasBySequence: {},
                                    chainToSequence: {},
                                    availableChains: [],
                                    defaultChain: null,
                                    msaToChains: {}
                                };
                            }
                            
                            const msaObj = object.msa;
                            
                            // Store msaToChains mapping
                            msaObj.msaToChains = msaToChains;
                            
                            // Store unique MSAs and map chains
                            for (const [chainId, {msaData, type}] of Object.entries(chainToMSA)) {
                                const querySeqNoGaps = msaData.querySequence.replace(/-/g, '').toUpperCase();
                                
                                // Store MSA by sequence (only one per unique sequence)
                                if (!msaObj.msasBySequence[querySeqNoGaps]) {
                                    msaObj.msasBySequence[querySeqNoGaps] = { 
                                        msaData, 
                                        type,
                                        chains: msaToChains[querySeqNoGaps] || []
                                    };
                                }
                                
                                // Map chain to sequence
                                msaObj.chainToSequence[chainId] = querySeqNoGaps;
                                
                                // Add to available chains
                                if (!msaObj.availableChains.includes(chainId)) {
                                    msaObj.availableChains.push(chainId);
                                }
                            }
                            
                            // Set default chain (first available)
                            if (msaObj.availableChains.length > 0) {
                                msaObj.defaultChain = msaObj.availableChains[0];
                                
                                // Load default chain's MSA
                                const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                if (defaultChainSeq && msaObj.msasBySequence[defaultChainSeq]) {
                                    const {msaData, type} = msaObj.msasBySequence[defaultChainSeq];
                                    if (window.MSAViewer) {
                                        window.MSAViewer.setMSAData(msaData, msaObj.defaultChain, type);
                                        
                                        // Get filtered MSA data and recompute properties based on current filtering
                                        const filteredMSAData = window.MSAViewer.getMSAData();
                                        if (filteredMSAData) {
                                            // Clear existing properties to force recomputation on filtered data
                                            filteredMSAData.frequencies = null;
                                            filteredMSAData.entropy = null;
                                            filteredMSAData.logOdds = null;
                                            // Compute properties on filtered data
                                            computeMSAProperties(filteredMSAData);
                                            // Update stored MSA data with filtered data and recomputed properties
                                            msaObj.msasBySequence[defaultChainSeq].msaData = filteredMSAData;
                                        }
                                        
                                        // Update chain selector to show available chains
                                        if (window.updateMSAChainSelectorIndex) {
                                            window.updateMSAChainSelectorIndex();
                                        }
                                        
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
                            const type = detectMSAType(firstMSAFile.name);
                            const msaData = window.MSAViewer ? window.MSAViewer.parseA3M(msaText, type) : null;
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
                if (frame.position_index) frameData.position_index = frame.position_index;
                
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
            if (object.msa) {
                // Check if it's per-chain structure (AF3 format)
                if (object.msa.chains && object.msa.availableChains && object.msa.availableChains.length > 0) {
                    // Per-chain structure: save full structure
                    objToSave.msa = {
                        chains: {},
                        defaultChain: object.msa.defaultChain || null,
                        availableChains: object.msa.availableChains || []
                    };
                    
                    // Save MSA data for each chain
                    for (const chainId of object.msa.availableChains) {
                        if (object.msa.chains[chainId]) {
                            objToSave.msa.chains[chainId] = {};
                            if (object.msa.chains[chainId].unpaired) {
                                objToSave.msa.chains[chainId].unpaired = {
                                    sequences: object.msa.chains[chainId].unpaired.sequences,
                                    querySequence: object.msa.chains[chainId].unpaired.querySequence,
                                    queryLength: object.msa.chains[chainId].unpaired.queryLength
                                };
                            }
                            if (object.msa.chains[chainId].paired) {
                                objToSave.msa.chains[chainId].paired = {
                                    sequences: object.msa.chains[chainId].paired.sequences,
                                    querySequence: object.msa.chains[chainId].paired.querySequence,
                                    queryLength: object.msa.chains[chainId].paired.queryLength
                                };
                            }
                        }
                    }
                } else {
                    // Legacy format: save as single MSA
                    objToSave.msa = {
                        sequences: object.msa.sequences,
                        querySequence: object.msa.querySequence,
                        queryLength: object.msa.queryLength
                    };
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
        
        // Save MSA state (current chain and type)
        if (window.MSAViewer) {
            const currentChain = window.MSAViewer.getCurrentChain ? window.MSAViewer.getCurrentChain() : null;
            const currentMSAType = window.MSAViewer.getCurrentMSAType ? window.MSAViewer.getCurrentMSAType() : 'unpaired';
            if (currentChain) {
                viewerState.msa_chain = currentChain;
                viewerState.msa_type = currentMSAType;
            }
        }
        
        // Get selection state
        const selection = renderer.getSelection();
        const selectionState = {
            positions: Array.from(selection.positions),
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
                        position_index: frameData.position_index  // undefined if missing (will default)
                    };
                    
                    renderer.addFrame(resolvedFrame, objData.name);
                }
                
                // Restore playing state
                renderer.isPlaying = wasPlaying;
                
                // Check if object has PAE data (checks frames directly)
                if (checkObjectHasPAE(objData)) {
                    objectsWithPAE.add(objData.name);
                }
                
                // Store MSA data if present
                if (objData.msa) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    // Check if it's per-chain structure (AF3 format)
                    if (objData.msa.chains && objData.msa.availableChains) {
                        // Per-chain structure
                        renderer.objectsData[objData.name].msa = {
                            chains: {},
                            defaultChain: objData.msa.defaultChain || null,
                            availableChains: objData.msa.availableChains || []
                        };
                        
                        // Restore MSA data for each chain
                        for (const chainId of objData.msa.availableChains) {
                            if (objData.msa.chains[chainId]) {
                                renderer.objectsData[objData.name].msa.chains[chainId] = {};
                                if (objData.msa.chains[chainId].unpaired) {
                                    renderer.objectsData[objData.name].msa.chains[chainId].unpaired = objData.msa.chains[chainId].unpaired;
                                }
                                if (objData.msa.chains[chainId].paired) {
                                    renderer.objectsData[objData.name].msa.chains[chainId].paired = objData.msa.chains[chainId].paired;
                                }
                            }
                        }
                    } else {
                        // Legacy format (single MSA per object)
                        renderer.objectsData[objData.name].msa = objData.msa;
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
                        
                        // Restore MSA state (chain and type) if available
                        if (stateData.viewer_state) {
                            const vs = stateData.viewer_state;
                            if (vs.msa_chain && window.MSAViewer && window.MSAViewer.setChain) {
                                window.MSAViewer.setChain(vs.msa_chain);
                                if (vs.msa_type && window.MSAViewer.setMSAType) {
                                    window.MSAViewer.setMSAType(vs.msa_type);
                                }
                            }
                        }
                        
                        // Trigger object change handler to ensure UI is fully updated
                        if (renderer.objectSelect) {
                            handleObjectChange();
                        }
                        
                        // Restore selection state AFTER all UI updates
                        // (This must be last to avoid being overwritten by updateChainSelectionUI)
                        if (stateData.selection_state) {
                            const ss = stateData.selection_state;
                            
                            // Only support positions format (no backward compatibility)
                            // If positions is missing or invalid, default to empty Set (will show nothing)
                            let positions = new Set();
                            if (ss.positions !== undefined && Array.isArray(ss.positions)) {
                                // New format: positions array
                                positions = new Set(ss.positions.filter(a => typeof a === 'number' && a >= 0));
                            } else if (ss.atoms !== undefined && Array.isArray(ss.atoms)) {
                                // Legacy format: atoms array (for backward compatibility during transition)
                                positions = new Set(ss.atoms.filter(a => typeof a === 'number' && a >= 0));
                            }
                            // If positions is missing or invalid, positions remains empty Set
                            
                            const selectionPatch = {
                                positions: positions,
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