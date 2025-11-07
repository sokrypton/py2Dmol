// ============================================================================
// APP.JS - Application logic, UI handlers, and initialization
// ============================================================================

// ============================================================================
// GLOBAL STATE
// ============================================================================

let referenceChainACoords = null; // Baseline for alignment (append mode)
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
    console.log("DOM is ready. Initializing app...");
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
    const paeContainer = document.getElementById('paeContainer');
    paeContainer.style.display = 'none';
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
            console.debug('[UI] biounit =', window.viewerConfig.biounit);
        });
    }
    
    if (ignoreLigandsEl) {
        ignoreLigandsEl.addEventListener('change', () => {
            window.viewerConfig.ignoreLigands = ignoreLigandsEl.checked;
            console.debug('[UI] ignoreLigands =', window.viewerConfig.ignoreLigands);
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
    
    // Navigation buttons
    const orientButton = document.getElementById('orientButton');
    const prevObjectButton = document.getElementById('prevObjectButton');
    const nextObjectButton = document.getElementById('nextObjectButton');
    
    if (orientButton) orientButton.addEventListener('click', applyBestViewRotation);
    if (prevObjectButton) prevObjectButton.addEventListener('click', gotoPreviousObject);
    if (nextObjectButton) nextObjectButton.addEventListener('click', gotoNextObject);
    
    // Object and color select
    const objectSelect = document.getElementById('objectSelect');
    const colorSelect = document.getElementById('colorSelect');
    
    if (objectSelect) objectSelect.addEventListener('change', handleObjectChange);
    if (colorSelect) colorSelect.addEventListener('change', updateColorMode);

    // Attach sequence controls
    const seqToggle = document.getElementById('sequenceToggle');
    const sequenceView = document.getElementById('sequenceView');
    const selectAllBtn = document.getElementById('selectAllResidues');
    const clearAllBtn  = document.getElementById('clearAllResidues');

    if (seqToggle && sequenceView) {
      const container = document.getElementById('top-panel-container');
      const sequenceHeader = document.getElementById('sequenceHeader');
      const actionButtons = document.querySelectorAll('.sequence-action-btn');
      
      // Set initial collapsed state
      if (container) {
        container.classList.add('collapsed');
      }
      // Hide action buttons initially
      actionButtons.forEach(btn => btn.style.display = 'none');
      
      const toggleSequence = (ev) => {
        if (ev) {
          ev.stopPropagation(); // Prevent event from bubbling to header
          // Ignore clicks on action buttons
        if (ev.target.closest('#selectAllResidues') || ev.target.closest('#clearAllResidues')) return;
        }
        const expanded = seqToggle.getAttribute('aria-expanded') === 'true';
        seqToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        const chevron = seqToggle.querySelector('.chevron');
        if (chevron) {
          chevron.textContent = expanded ? '▸' : '▾';
        }
        if (expanded) {
          sequenceView.classList.add('hidden');
          if (container) container.classList.add('collapsed');
          // Hide action buttons when collapsed
          actionButtons.forEach(btn => btn.style.display = 'none');
        } else {
          sequenceView.classList.remove('hidden');
          if (container) container.classList.remove('collapsed');
          // Show action buttons when expanded
          actionButtons.forEach(btn => btn.style.display = '');
        }
      };
      
      // Make entire header clickable (for areas outside the button)
      if (sequenceHeader) {
        sequenceHeader.addEventListener('click', (ev) => {
          // Only handle clicks if they're not on the button or action buttons
          if (!ev.target.closest('#sequenceToggle') && 
              !ev.target.closest('#selectAllResidues') && 
              !ev.target.closest('#clearAllResidues')) {
            toggleSequence(ev);
          }
        });
        sequenceHeader.style.cursor = 'pointer';
      }
      
      // Make button clickable - clicks on children (chevron, title) will bubble up
      seqToggle.addEventListener('click', toggleSequence);
      
      // Ensure chevron and title are clickable (pointer-events should allow clicks to bubble)
      const chevron = seqToggle.querySelector('.chevron');
      const title = seqToggle.querySelector('.sequence-title');
      if (chevron) {
        chevron.style.pointerEvents = 'auto';
        chevron.style.cursor = 'pointer';
      }
      if (title) {
        title.style.pointerEvents = 'auto';
        title.style.cursor = 'pointer';
      }
    }
    if (selectAllBtn) selectAllBtn.addEventListener('click', (e) => { e.preventDefault(); selectAllResidues(); });
    if (clearAllBtn)  clearAllBtn.addEventListener('click', (e) => { e.preventDefault(); clearAllResidues(); });


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
    const paeContainer = document.getElementById('paeContainer');
    
    const selectedObject = objectSelect.value;
    if (!selectedObject) return;
    
    const hasPAE = objectsWithPAE.has(selectedObject);
    paeContainer.style.display = hasPAE ? 'block' : 'none';
    
    // Rebuild sequence view for the new object
    buildSequenceView();
    updateChainSelectionUI();
    
    updateColorMode();
}

function updateColorMode() {
    // Placeholder for future color mode updates
    // Can be extended to sync with viewer color settings
}

// ============================================================================
// BEST VIEW ROTATION ANIMATION
// ============================================================================

function applyBestViewRotation() {
    if (!viewerApi || !viewerApi.renderer) return;
    const renderer = viewerApi.renderer;

    const objectSelect = document.getElementById('objectSelect');
    const objectName = objectSelect ? objectSelect.value : null;
    if (!objectName) return;
    
    const object = renderer.objectsData[objectName];
    if (!object || !object.frames || object.frames.length === 0) return;

    const currentFrame = renderer.currentFrame || 0;
    const frame = object.frames[currentFrame];
    if (!frame || !frame.coords) return;

    // Get visible coordinates based on visibilityMask
    let visibleCoords = frame.coords;
    let visibleCenter = null;
    let visibleExtent = null;
    
    if (renderer.visibilityMask !== null && renderer.visibilityMask.size > 0) {
        // Filter to only visible atoms
        visibleCoords = [];
        for (const atomIdx of renderer.visibilityMask) {
            if (atomIdx >= 0 && atomIdx < frame.coords.length) {
                visibleCoords.push(frame.coords[atomIdx]);
            }
        }
        
        if (visibleCoords.length === 0) {
            // No visible atoms, use all coordinates
            visibleCoords = frame.coords;
        } else {
            // Calculate center from visible coordinates
            const sum = [0, 0, 0];
            for (const c of visibleCoords) {
                sum[0] += c[0];
                sum[1] += c[1];
                sum[2] += c[2];
            }
            visibleCenter = [
                sum[0] / visibleCoords.length,
                sum[1] / visibleCoords.length,
                sum[2] / visibleCoords.length
            ];
            
            // Calculate extent and standard deviation from visible coordinates
            let maxDistSq = 0;
            let sumDistSq = 0;
            for (const c of visibleCoords) {
                const dx = c[0] - visibleCenter[0];
                const dy = c[1] - visibleCenter[1];
                const dz = c[2] - visibleCenter[2];
                const distSq = dx * dx + dy * dy + dz * dz;
                if (distSq > maxDistSq) maxDistSq = distSq;
                sumDistSq += distSq;
            }
            visibleExtent = Math.sqrt(maxDistSq);
            // Calculate standard deviation for visible subset
            const visibleStdDev = visibleCoords.length > 0 ? Math.sqrt(sumDistSq / visibleCoords.length) : 0;
            
            // Store visible stdDev and original stdDev for animation
            rotationAnimation.visibleStdDev = visibleStdDev;
            rotationAnimation.originalStdDev = object.stdDev || 0;
        }
    } else {
        // No visible subset, clear stdDev animation data
        rotationAnimation.visibleStdDev = null;
        rotationAnimation.originalStdDev = null;
    }
    
    // If we have visible coordinates, use them for best view
    const coordsForBestView = visibleCoords.length > 0 ? visibleCoords : frame.coords;
    const Rcur = renderer.rotationMatrix;
    const Rtarget = bestViewTargetRotation_relaxed_AUTO(coordsForBestView, Rcur);

    const angle = rotationAngleBetweenMatrices(Rcur, Rtarget);
    const deg = angle * 180 / Math.PI;
    const duration = Math.max(300, Math.min(2000, deg * 10));

    // Calculate target center and zoom based on final orientation
    let targetCenter = null;
    let targetExtent = null;
    let targetZoom = renderer.zoom;
    
    if (visibleCenter && visibleExtent && visibleCoords.length > 0) {
        // Center is the same regardless of rotation (it's a 3D point)
        targetCenter = visibleCenter;
        targetExtent = visibleExtent;
        
        // Calculate zoom adjustment based on final orientation
        // When temporaryExtent is set, the renderer uses it in the scale calculation:
        // scale = (canvasSize / (temporaryExtent * 2)) * zoom
        // So if we set temporaryExtent to visibleExtent, the scale is already larger.
        // We should keep zoom at 1.0 (base zoom) when using temporaryExtent to avoid double-scaling.
        targetZoom = 1.0;
    } else {
        // When orienting to all atoms, reset zoom to base level (1.0) or keep current if reasonable
        // Don't change zoom when there's no selection
        targetZoom = renderer.zoom;
    }

    rotationAnimation.active = true;
    rotationAnimation.startMatrix = Rcur.map(row => [...row]);
    rotationAnimation.targetMatrix = Rtarget;
    rotationAnimation.duration = duration;
    rotationAnimation.startTime = performance.now();
    
    // Store start and target values for interpolation
    // Calculate start center (either existing temporary center or global center)
    let startCenter = null;
    if (renderer.temporaryCenter) {
        startCenter = { x: renderer.temporaryCenter.x, y: renderer.temporaryCenter.y, z: renderer.temporaryCenter.z };
    } else {
        // Calculate global center once at start
        const globalCenter = (object && object.totalAtoms > 0 && object.globalCenterSum) ? 
            { 
                x: object.globalCenterSum.x / object.totalAtoms,
                y: object.globalCenterSum.y / object.totalAtoms,
                z: object.globalCenterSum.z / object.totalAtoms
            } : { x: 0, y: 0, z: 0 };
        startCenter = globalCenter;
    }
    
    rotationAnimation.startCenter = startCenter;
    rotationAnimation.targetCenter = targetCenter ? 
        { x: targetCenter[0], y: targetCenter[1], z: targetCenter[2] } : null;
    rotationAnimation.startExtent = renderer.temporaryExtent || (object && object.maxExtent) || 30.0;
    rotationAnimation.targetExtent = targetExtent;
    rotationAnimation.startZoom = renderer.zoom;
    rotationAnimation.targetZoom = targetZoom;
    rotationAnimation.object = object;

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

    if (progress >= 1.0) {
        renderer.rotationMatrix = rotationAnimation.targetMatrix;
        
        // Set final zoom and center values
        if (rotationAnimation.targetZoom !== undefined) {
            renderer.zoom = rotationAnimation.targetZoom;
        }
        
        if (rotationAnimation.targetCenter) {
            renderer.temporaryCenter = rotationAnimation.targetCenter;
            renderer.temporaryExtent = rotationAnimation.targetExtent;
        } else {
            // Clear temporary center/extent if orienting to all atoms
            renderer.temporaryCenter = null;
            renderer.temporaryExtent = null;
        }
        
        // Set final stdDev to visible subset's stdDev if it was modified during animation
        if (rotationAnimation.object && rotationAnimation.visibleStdDev !== null && rotationAnimation.visibleStdDev !== undefined) {
            rotationAnimation.object.stdDev = rotationAnimation.visibleStdDev;
            // Trigger ortho slider update to recalculate focal length with final stdDev
            const orthoSlider = document.getElementById('orthoSlider');
            if (orthoSlider) {
                orthoSlider.dispatchEvent(new Event('input'));
            }
        }
        
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
    const eased = progress < 0.5 ?
        4 * progress * progress * progress :
        1 - Math.pow(-2 * progress + 2, 3) / 2;

    renderer.rotationMatrix = lerpRotationMatrix(
        rotationAnimation.startMatrix,
        rotationAnimation.targetMatrix,
        eased
    );
    
    // Interpolate zoom during animation - use same easing for consistency
    if (rotationAnimation.targetZoom !== undefined) {
        const t = eased; // Use same eased value for smooth zoom interpolation
        renderer.zoom = rotationAnimation.startZoom + (rotationAnimation.targetZoom - rotationAnimation.startZoom) * t;
    }
    
    // Interpolate stdDev during animation if visible subset exists
    if (rotationAnimation.object && rotationAnimation.visibleStdDev !== null && rotationAnimation.visibleStdDev !== undefined && 
        rotationAnimation.originalStdDev !== null && rotationAnimation.originalStdDev !== undefined) {
        const t = eased;
        // Interpolate stdDev from original to visible subset's stdDev
        rotationAnimation.object.stdDev = rotationAnimation.originalStdDev + 
            (rotationAnimation.visibleStdDev - rotationAnimation.originalStdDev) * t;
        
        // Trigger ortho slider update to recalculate focal length with new stdDev
        const orthoSlider = document.getElementById('orthoSlider');
        if (orthoSlider) {
            orthoSlider.dispatchEvent(new Event('input'));
        }
    }
    
    // Interpolate center and extent during animation - use same easing for consistency
    if (rotationAnimation.targetCenter && rotationAnimation.startCenter) {
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
    } else {
        // Interpolate extent even when clearing center (for smooth transition back to all atoms)
        if (rotationAnimation.targetExtent === null || rotationAnimation.targetExtent === undefined) {
            const t = eased;
            const currentExtent = renderer.temporaryExtent || rotationAnimation.startExtent;
            const targetExtent = (rotationAnimation.object && rotationAnimation.object.maxExtent) || 30.0;
            renderer.temporaryExtent = currentExtent + (targetExtent - currentExtent) * t;
        }
        // Clear temporary center if orienting to all atoms
        if (progress >= 0.99) { // Only clear at the very end
            renderer.temporaryCenter = null;
            renderer.temporaryExtent = null;
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
                console.debug(`[Biounit] Found ${operations.length} operations, applying to ${models.length} models...`);
                // Apply operations to each model
                models = models.map(modelAtoms => 
                    applyBiounitOperationsToModel(modelAtoms, operations)
                );
                const elapsed = performance.now() - startTime;
                console.debug(`[Biounit] Applied transformations in ${elapsed.toFixed(1)}ms`);
            } else {
                console.debug('[Biounit] No biounit operations found, using asymmetric unit');
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

    let targetObject = tempBatch.find(obj => obj.name === targetObjectName) || null;
    if (!targetObject) {
        targetObject = { name: targetObjectName, frames: [] };
        tempBatch.push(targetObject);
    }

    const isTrajectory = (loadAsFramesCheckbox.checked ||
        targetObject.frames.length > 0 ||
        models.length > 1);
    const shouldAlign = alignFramesCheckbox.checked;

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
        
        return atoms.filter(a => a && (
            a.record !== 'HETATM' ||
            proteinResidues.has(a.resName) ||
            nucleicResidues.has(a.resName)
        ));
    }

    for (let i = 0; i < models.length; i++) {
        if (!loadAsFramesCheckbox.checked && i > 0) {
            const modelObjectName = `${targetObjectName}_model_${i + 1}`;
            targetObject = tempBatch.find(obj => obj.name === modelObjectName) || null;
            if (!targetObject) {
                targetObject = { name: modelObjectName, frames: [] };
                tempBatch.push(targetObject);
            }
        }

        const model = maybeFilterLigands(models[i]);
        let frameData = convertParsedToFrameData(model);
        if (frameData.coords.length === 0) continue;

        if (isTrajectory && shouldAlign) {
            const sourceChainACoords = [];
            for (let j = 0; j < frameData.coords.length; j++) {
                if (frameData.chains[j] === 'A') {
                    sourceChainACoords.push(frameData.coords[j]);
                }
            }

            if (targetObject.frames.length === 0 && i === 0) {
                referenceChainACoords = sourceChainACoords;
            } else if (referenceChainACoords &&
                sourceChainACoords.length > 0 &&
                sourceChainACoords.length === referenceChainACoords.length) {
                try {
                    frameData.coords = align_a_to_b(
                        frameData.coords,
                        sourceChainACoords,
                        referenceChainACoords
                    );
                } catch (e) {
                    console.error(`Alignment failed for frame ${i} of ${targetObjectName}:`, e);
                    setStatus(
                        `Warning: Alignment failed for a frame in ${targetObjectName}. See console.`,
                        true
                    );
                }
            }
        }

        if (paeData) {
            frameData.pae = paeData.map(row => [...row]);
            targetObject.hasPAE = true;
        } else {
            frameData.pae = null;
        }

        targetObject.frames.push(frameData);
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
            setTimeout(() => {
                objectSelect.value = lastObjectName;
                handleObjectChange();
                updateObjectNavigationButtons();
                buildSequenceView();
                updateChainSelectionUI(); // This sets up default selection and calls applySelection
            }, 50);
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

  // Select all by default using renderer API
  const allResidues = new Set();
  const allChains = new Set();
  for (let i = 0; i < frame0.residue_index.length; i++) {
    const chain = frame0.chains[i];
    const resSeq = frame0.residue_index[i];
    allResidues.add(`${chain}:${resSeq}`);
    allChains.add(chain);
  }

  viewerApi.renderer.setSelection({
    residues: allResidues,
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
  const newResidues = new Set(current.residues);
  
  if (selected) {
    newChains.add(chain);
    // When selecting a chain, add all residues in that chain
  for (let i = 0; i < frame0.residue_index.length; i++) {
    if (frame0.chains[i] === chain) {
      const id = `${chain}:${frame0.residue_index[i]}`;
        newResidues.add(id);
      }
    }
  } else {
    newChains.delete(chain);
    // When unselecting a chain, remove all residues in that chain
    for (const residueId of Array.from(newResidues)) {
      if (residueId.startsWith(`${chain}:`)) {
        newResidues.delete(residueId);
      }
    }
  }
  
  // If all chains are selected, we can use empty set with default mode
  // Otherwise, use explicit chain selection
  const selectionMode = (newChains.size === allChains.size && 
                         Array.from(newChains).every(c => allChains.has(c))) 
                         ? 'default' : 'explicit';
  
  viewerApi.renderer.setSelection({ 
    chains: newChains.size === allChains.size ? new Set() : newChains,
    residues: newResidues,
    selectionMode: selectionMode,
    paeBoxes: []  // Clear PAE boxes when editing chain selection
  });
  // Event listener will update UI, no need to call applySelection()
}

/** Alt-click a chain label to toggle selection of all residues in that chain */
function toggleChainResidues(chain) {
    if (!viewerApi?.renderer) return;
    const objectName = viewerApi.renderer.currentObjectName;
    if (!objectName) return;
    const obj = viewerApi.renderer.objectsData[objectName];
    if (!obj?.frames?.length) return;
    const frame = obj.frames[0];
    if (!frame?.residue_index || !frame?.chains) return;

    const current = viewerApi.renderer.getSelection();
    const ids = [];
    for (let i = 0; i < frame.residue_index.length; i++) {
        if (frame.chains[i] === chain) {
            ids.push(`${chain}:${frame.residue_index[i]}`);
        }
    }
    const allSelected = ids.every(id => current.residues.has(id));
    
    const newResidues = new Set(current.residues);
    ids.forEach(id => {
        if (allSelected) newResidues.delete(id);
        else newResidues.add(id);
    });
    
    viewerApi.renderer.setSelection({ 
        residues: newResidues,
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

function applySelection(previewResidues = null) {
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
  const residuesToUse = previewResidues !== null ? previewResidues : current.residues;

  viewerApi.renderer.setSelection({
    residues: residuesToUse,
    chains: visibleChains
    // Keep current PAE boxes and mode
  });
  
  // Note: updateSequenceViewSelectionState will be called via event listener
}


function highlightResidue(chain, residueIndex) {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedResidue = { chain, residueIndex };
        viewerApi.renderer.render();
    }
}

function clearHighlight() {
    if (viewerApi && viewerApi.renderer) {
        viewerApi.renderer.highlightedResidue = null;
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

// HTML-based sequence renderer data
let sequenceHTMLData = null; // { chain: { container, residues: [{element, id, resSeq, chain, atomIndex, color}] } }

function buildSequenceView() {
    const sequenceViewEl = document.getElementById('sequenceView');
    if (!sequenceViewEl) return;

    // Clear cache when rebuilding
    cachedSequenceSpans = null;
    lastSequenceUpdateHash = null;
    sequenceHTMLData = {};

    sequenceViewEl.innerHTML = '';

    // Get object name from dropdown first, fallback to renderer's currentObjectName
    const objectSelect = document.getElementById('objectSelect');
    const objectName = objectSelect?.value || viewerApi?.renderer?.currentObjectName;
    if (!objectName || !viewerApi?.renderer) return;

    const object = viewerApi.renderer.objectsData[objectName];
    if (!object || !object.frames || object.frames.length === 0) return;

    const firstFrame = object.frames[0];
    if (!firstFrame || !firstFrame.residues) return;

    const { residues, residue_index, chains } = firstFrame;

    // Use Set for faster lookups
    const seen = new Set();
    const uniqueResidues = [];
    for (let i = 0; i < residues.length; i++) {
        const key = `${chains[i]}:${residue_index[i]}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueResidues.push({
                chain: chains[i],
                resName: residues[i],
                resSeq: residue_index[i],
                atomIndex: i
            });
        }
    }

    const sortedUniqueResidues = uniqueResidues.sort((a, b) => {
        if (a.chain < b.chain) return -1;
        if (a.chain > b.chain) return 1;
        return a.resSeq - b.resSeq;
    });

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
    
    // Group by chain
    const chainsData = {};
    for (const res of sortedUniqueResidues) {
        if (!chainsData[res.chain]) {
            chainsData[res.chain] = [];
        }
        chainsData[res.chain].push(res);
    }
    
    // Helper function to get residue letter based on sequence type
    const getResidueLetterForChain = (chainResidues) => {
        // Detect sequence type for this specific chain
        const chainResidueNames = chainResidues.map(r => r.resName);
        const chainType = detectSequenceType(chainResidueNames);
        
        // Return appropriate mapping function
        if (chainType === 'dna') {
            return (resName) => {
                const upper = (resName || '').toString().trim().toUpperCase();
                return dnaMapping[upper] || 'N';
            };
        } else if (chainType === 'rna') {
            return (resName) => {
                const upper = (resName || '').toString().trim().toUpperCase();
                // Check exact match first
                if (rnaMapping[upper]) {
                    return rnaMapping[upper];
                }
                // Special case: if it's exactly 'U', return 'U' (should be in mapping, but just in case)
                if (upper === 'U') {
                    return 'U';
                }
                // Fallback: check if it contains U, URI, or URA for uracil
                if (upper.includes('U') || upper.includes('URI') || upper.includes('URA')) {
                    return 'U';
                }
                // Fallback: check if it contains A, C, or G (but not D for DNA)
                if (upper.includes('A') && !upper.includes('D')) {
                    return 'A';
                }
                if (upper.includes('C') && !upper.includes('D')) {
                    return 'C';
                }
                if (upper.includes('G') && !upper.includes('D')) {
                    return 'G';
                }
                return 'N';
            };
        } else {
            return (resName) => {
                const upper = (resName || '').toString().trim().toUpperCase();
                return threeToOne[upper] || 'X';
            };
        }
    };

    // HTML text rendering settings
    const charWidth = 10; // Monospace character width
    const charHeight = 14; // Line height
    
    // Chain button uses same dimensions as sequence characters
    const maxChainIdLength = 3; // Most chain IDs are 1-2 chars, but some like "A|2" are longer
    const chainButtonWidth = charWidth * maxChainIdLength;
    
    // Calculate dynamic line breaks based on container width (accounting for chain button column)
    const containerWidth = sequenceViewEl ? sequenceViewEl.offsetWidth || 900 : 900;
    const sequenceWidth = containerWidth - chainButtonWidth - 4; // Subtract button column width and gap
    const charsPerLine = Math.floor(sequenceWidth / charWidth);

    const fragment = document.createDocumentFragment();
    const renderer = viewerApi?.renderer;
    const hasGetAtomColor = renderer?.getAtomColor;

    for (const [chain, chainResidues] of Object.entries(chainsData)) {
        // Create chain container with two columns: chain button and sequence
        const chainContainer = document.createElement('div');
        chainContainer.className = 'chain-container';
        chainContainer.style.display = 'flex';
        chainContainer.style.flexDirection = 'row';
        chainContainer.style.alignItems = 'flex-start';
        chainContainer.style.gap = '4px';
        
        // Create chain button column
        const chainButtonColumn = document.createElement('div');
        chainButtonColumn.className = 'chain-button-column';
        chainButtonColumn.style.width = chainButtonWidth + 'px';
        chainButtonColumn.style.flexShrink = '0';
        
        // Create chain button as HTML element
        const chainButton = document.createElement('span');
        chainButton.className = 'chain-button';
        chainButton.textContent = chain;
        chainButton.style.display = 'inline-block';
        chainButton.style.width = chainButtonWidth + 'px';
        chainButton.style.height = charHeight + 'px';
        chainButton.style.textAlign = 'center';
        chainButton.style.lineHeight = charHeight + 'px';
        chainButton.style.fontSize = '12px';
        chainButton.style.fontFamily = 'monospace';
        chainButton.style.cursor = 'pointer';
        chainButton.style.userSelect = 'none';
        chainButton.style.verticalAlign = 'top';
        
        // Set initial button state
        const current = viewerApi?.renderer?.getSelection();
        const allChainsSelected = current?.chains?.has(chain) || 
            (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
        if (allChainsSelected) {
            chainButton.style.backgroundColor = '#10b981';
            chainButton.style.color = '#ffffff';
        } else {
            chainButton.style.backgroundColor = '#e5e7eb';
            chainButton.style.color = '#000000';
        }
        
        chainButtonColumn.appendChild(chainButton);
        
        // Create sequence container for this chain
        const sequenceContainer = document.createElement('div');
        sequenceContainer.className = 'sequence-text-container';
        sequenceContainer.style.display = 'flex';
        sequenceContainer.style.flexWrap = 'wrap';
        sequenceContainer.style.fontFamily = 'monospace';
        sequenceContainer.style.fontSize = '12px';
        sequenceContainer.style.lineHeight = charHeight + 'px';
        sequenceContainer.style.cursor = 'crosshair';
        sequenceContainer.style.gap = '0';
        sequenceContainer.style.flex = '1';
        
        // Store residue elements
        const residueElements = [];
        
        // Get the appropriate mapping function for this chain
        const getResidueLetter = getResidueLetterForChain(chainResidues);
        
        // Create HTML spans for each residue
        for (let i = 0; i < chainResidues.length; i++) {
            const res = chainResidues[i];
            // Get letter using the mapping function (handles trimming and fallbacks internally)
            const letter = getResidueLetter(res.resName);
            const id = `${res.chain}:${res.resSeq}`;
            
            // Get color for this residue
    let color = { r: 80, g: 80, b: 80 };
            if (hasGetAtomColor && !Number.isNaN(res.atomIndex)) {
                color = renderer.getAtomColor(res.atomIndex);
            }
            
            // Create span element for this residue
            const span = document.createElement('span');
            span.className = 'residue-char';
            span.textContent = letter;
            span.dataset.residueId = id;
            span.style.display = 'inline-block';
            span.style.width = charWidth + 'px';
            span.style.height = charHeight + 'px';
            span.style.textAlign = 'center';
            span.style.lineHeight = charHeight + 'px';
            span.style.color = '#000000';
            span.style.backgroundColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
            span.style.userSelect = 'none';
            
            // Add line break after charsPerLine characters
            if ((i + 1) % charsPerLine === 0 && i < chainResidues.length - 1) {
                const br = document.createElement('br');
                sequenceContainer.appendChild(br);
            }
            
            sequenceContainer.appendChild(span);
            
            residueElements.push({
                element: span,
                id,
                letter,
                color,
                resSeq: res.resSeq,
                chain: res.chain,
                atomIndex: res.atomIndex
            });
        }
        
        chainContainer.appendChild(chainButtonColumn);
        chainContainer.appendChild(sequenceContainer);
        fragment.appendChild(chainContainer);
        
        sequenceHTMLData[chain] = {
            container: chainContainer,
            sequenceContainer: sequenceContainer,
            chainButton: chainButton,
            residues: residueElements,
            charsPerLine
        };
    }
    
    sequenceViewEl.appendChild(fragment);
    
    // Setup HTML event handlers
    setupHTMLSequenceEvents();
    
    updateSequenceViewSelectionState();
}

// HTML-based sequence event handlers using event delegation

function setupHTMLSequenceEvents() {
    if (!sequenceHTMLData) return;
    
    // Store drag state (shared across all chains)
    const dragState = { isDragging: false, dragStart: null, dragEnd: null, hasMoved: false, dragUnselectMode: false };
    
    // Setup event handlers for each chain
    for (const [chain, chainData] of Object.entries(sequenceHTMLData)) {
        const { sequenceContainer, chainButton, residues } = chainData;
        
        // Chain button click handler
        chainButton.addEventListener('click', (e) => {
            const current = viewerApi?.renderer?.getSelection();
            const isSelected = current?.chains?.has(chain) || 
                (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
            
            if (e.altKey) {
              toggleChainResidues(chain);
    } else {
                setChainResiduesSelected(chain, !isSelected);
            }
            // Force update to reflect changes
            lastSequenceUpdateHash = null;
            updateSequenceViewSelectionState();
        });
        
        // Sequence container event delegation
        sequenceContainer.addEventListener('mousedown', (e) => {
            const span = e.target.closest('.residue-char');
            if (!span) return;
            
            const residueId = span.dataset.residueId;
            const residue = residues.find(r => r.id === residueId);
            if (!residue) return;
            
            dragState.isDragging = true;
            dragState.hasMoved = false;
            dragState.dragStart = residue;
            dragState.dragEnd = residue;
            
            const current = viewerApi?.renderer?.getSelection();
            dragState.dragUnselectMode = current?.residues?.has(residueId) || false;
            
            // Toggle single residue on click
            const newResidues = new Set(current?.residues || []);
            if (newResidues.has(residueId)) {
                newResidues.delete(residueId);
            } else {
                newResidues.add(residueId);
            }
            // Clear PAE boxes when editing sequence selection
            // (sequence selection is already reflected in PAE via colors)
            viewerApi.renderer.setSelection({ 
                residues: newResidues, 
                paeBoxes: [] 
            });
            // Force update to reflect changes
            lastSequenceUpdateHash = null;
            updateSequenceViewSelectionState();
        });
        
        sequenceContainer.addEventListener('mousemove', (e) => {
            const span = e.target.closest('.residue-char');
            if (!dragState.isDragging) {
                if (span) {
                    const residueId = span.dataset.residueId;
                    const residue = residues.find(r => r.id === residueId);
                    if (residue) {
                        highlightResidue(residue.chain, residue.resSeq);
                    }
                }
                return;
            }
            
            if (span) {
                const residueId = span.dataset.residueId;
                const residue = residues.find(r => r.id === residueId);
                if (residue && residue !== dragState.dragEnd) {
                    dragState.dragEnd = residue;
                    const startIdx = residues.indexOf(dragState.dragStart);
                    const endIdx = residues.indexOf(dragState.dragEnd);
                    if (startIdx !== -1 && endIdx !== -1) {
                        dragState.hasMoved = true;
                        const [min, max] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
                        const current = viewerApi?.renderer?.getSelection();
                        const newResidues = new Set(current?.residues || []);
                        for (let i = min; i <= max; i++) {
                            const res = residues[i];
                            if (dragState.dragUnselectMode) {
                                newResidues.delete(res.id);
                            } else {
                                newResidues.add(res.id);
                            }
                        }
                        previewSelectionSet = newResidues;
                        lastSequenceUpdateHash = null;
                        updateSequenceViewSelectionState();
                    }
              }
          }
      });
        
        const handleMouseUp = () => {
            if (dragState.hasMoved && previewSelectionSet) {
                // Clear PAE boxes when finishing drag selection
                // (sequence selection is already reflected in PAE via colors)
                viewerApi.renderer.setSelection({ 
                    residues: previewSelectionSet, 
                    paeBoxes: [] 
                });
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

        sequenceContainer.addEventListener('mouseup', handleMouseUp);
        sequenceContainer.addEventListener('mouseleave', () => {
            handleMouseUp();
            clearHighlight();
        });
    }
}

// Cache for sequence view spans to avoid repeated DOM queries
let cachedSequenceSpans = null;
let lastSequenceUpdateHash = null;

// Update colors in sequence view when color mode changes
function updateSequenceViewColors() {
  if (!sequenceHTMLData || !viewerApi?.renderer) return;
  
  const renderer = viewerApi.renderer;
  const hasGetAtomColor = renderer?.getAtomColor;
  
  // Update colors for all residues
  for (const [chain, chainData] of Object.entries(sequenceHTMLData)) {
    for (const res of chainData.residues) {
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
  let visibleResidues = new Set();
  
  if (previewSelectionSet && previewSelectionSet.size > 0) {
    // During drag, use preview selection for live feedback
    visibleResidues = new Set(previewSelectionSet);
  } else if (viewerApi?.renderer) {
    const renderer = viewerApi.renderer;
    
    // Check if we have a unified selection model
    if (renderer.selectionModel && renderer.chains && renderer.residue_index) {
      if (renderer.visibilityMask === null) {
        // null mask means all atoms are visible (default mode)
        for (let i = 0; i < renderer.chains.length && i < renderer.residue_index.length; i++) {
          const id = `${renderer.chains[i]}:${renderer.residue_index[i]}`;
          visibleResidues.add(id);
        }
      } else if (renderer.visibilityMask.size > 0) {
        // Non-empty Set means some atoms are visible
        for (const atomIdx of renderer.visibilityMask) {
          if (atomIdx < renderer.chains.length && atomIdx < renderer.residue_index.length) {
            const id = `${renderer.chains[atomIdx]}:${renderer.residue_index[atomIdx]}`;
            visibleResidues.add(id);
          }
        }
      }
    } else {
      visibleResidues = new Set(previewSelectionSet || []);
    }
  } else {
    visibleResidues = new Set(previewSelectionSet || []);
  }

  // Create hash to detect if selection actually changed
  // Include previewSelectionSet in hash to ensure live feedback during drag
  const renderer = viewerApi?.renderer;
  const previewHash = previewSelectionSet ? previewSelectionSet.size : 0;
  const currentHash = visibleResidues.size + previewHash + (renderer?.visibilityMask === null ? 'all' : 'some');
  if (currentHash === lastSequenceUpdateHash && !previewSelectionSet) {
    return; // No change, skip update (unless we have preview selection for live feedback)
  }
  lastSequenceUpdateHash = currentHash;

  // Update HTML elements with selection state
  const dimFactor = 0.3; // Same as PAE plot - dim unselected to 30% brightness
  for (const [chain, chainData] of Object.entries(sequenceHTMLData)) {
    const { residues, chainButton } = chainData;
    
    // Update residue background colors
    for (const res of residues) {
      let r = res.color.r;
      let g = res.color.g;
      let b = res.color.b;
      
      if (!visibleResidues.has(res.id)) {
        // Unselected: dim by mixing with white (similar to PAE plot)
        r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
        g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
        b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
      }
      // Selected: use full color (already has pastel applied via getAtomColor)
      res.element.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    }
    
    // Update chain button state
    const current = viewerApi?.renderer?.getSelection();
    const allChainsSelected = current?.chains?.has(chain) || 
        (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
    
    if (allChainsSelected) {
      chainButton.style.backgroundColor = '#10b981';
      chainButton.style.color = '#ffffff';
    } else {
      chainButton.style.backgroundColor = '#e5e7eb';
      chainButton.style.color = '#000000';
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
                const paeMatrix = extractPaeFromJSON(paeJson);
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
            residues: Array.from(selection.residues),
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
            
            // Generate zip blob
            zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
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
                
                if (objData.hasPAE) {
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
                renderer.colorMode = vs.color_mode;
                const colorSelect = document.getElementById('colorSelect');
                if (colorSelect) {
                    colorSelect.value = vs.color_mode;
                    colorSelect.dispatchEvent(new Event('change'));
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
                        
                        // Restore selection state after frame is set
                        if (stateData.selection_state) {
                            const ss = stateData.selection_state;
                            const selectionPatch = {
                                residues: new Set(ss.residues || []),
                                chains: new Set(ss.chains || []),
                                paeBoxes: ss.pae_boxes || [],
                                selectionMode: ss.selection_mode || 'default'
                            };
                            renderer.setSelection(selectionPatch);
                        }
                        
                        // Rebuild sequence view and update UI
                        buildSequenceView();
                        updateChainSelectionUI();
                        updateObjectNavigationButtons();
                        
                        // Trigger object change handler to ensure UI is fully updated
                        if (renderer.objectSelect) {
                            handleObjectChange();
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