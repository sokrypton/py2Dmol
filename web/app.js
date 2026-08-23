// ============================================================================
// web/app.js
// ----------
// AI Context: STANDALONE WEB APP LOGIC
// - Entry point for the standalone website version (index.html).
// - Handles file uploads (PDB, CIF, JSON) and URL fetching.
// - Manages global UI state (sidebar, modals, settings).
// - Parses raw file data before sending it to `viewer-mol.js`.
// - NOT used in the Python/Jupyter environment.
// ============================================================================
// APP.JS - Application logic, UI handlers, and initialization
// ============================================================================

// ============================================================================
// GLOBAL STATE
// ============================================================================

let viewerApi = null;
let pendingObjects = [];
let scatterViewer = null;

// Helper function to check if PAE data is valid
function isValidPAE(pae) {
    return pae && ((Array.isArray(pae) && pae.length > 0) || (pae.buffer && pae.length > 0));
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
const DEFAULT_MSA_COVERAGE = 0.75;
const DEFAULT_MSA_IDENTITY = 0.15;

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('viewer-container')) {
        initializeApp();
    }
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

    // OPEN ON RICHARDSON. config.rendering.style only picks the draw path; the
    // values that make a preset look like itself - thickness, tint, highlight,
    // outline width, pencil, smooth - live in STYLE_DEFAULTS and are applied by
    // setPreset. The constructor does not call it (the Python path sends those
    // values itself), and the deferred py2dmol_cartoon_loaded route does not
    // help here: the plugin is already loaded by DOMContentLoaded, so that
    // event has long since fired. Without this line the page draws a cartoon
    // wearing tube's sliders.
    if (viewerApi?.renderer?.setPreset) viewerApi.renderer.setPreset('richardson');

    // USE GPU: the rendering backend, for both styles. Hidden entirely where
    // WebGL2 is absent - a control that cannot do anything is worse than none -
    // and the renderer falls back to the 2D path by itself for anything the GPU
    // declines, so this is only ever a request.
    (() => {
        const cb = document.getElementById('useGpuCheckbox');
        if (!cb) return;
        const G = window.py2dmolCartoonGPU;
        if (!G || !G.available()) {
            const row = document.getElementById('useGpuRow');
            if (row && row.remove) row.remove();
            return;
        }
        const apply = () => {
            const r = viewerApi && viewerApi.renderer;
            if (!r) return;
            r.useGPU = cb.checked;
            // the mesh was built from state that may have moved on while this
            // was off, so ask for a fresh one rather than trusting it
            G.invalidate();
            r.render('useGpuCheckbox');
        };
        cb.addEventListener('change', apply);
        apply();
    })();

    // Setup MSA viewer callbacks (after viewerApi is initialized)
    if (window.MSA) {
        window.MSA.setCallbacks({
            getRenderer: () => viewerApi?.renderer || null,
            getObjectSelect: () => document.getElementById('objectSelect'),
            applySelection: applySelection,
            onMSAFilterChange: (filteredMSAData, chainId) => {
                // Recompute properties when MSA filters change
                if (!viewerApi?.renderer || !chainId || !filteredMSAData) return;

                const objectName = viewerApi.renderer.currentObjectName;
                if (!objectName) return;

                const obj = viewerApi.renderer.objectsData[objectName];
                if (!obj || !obj.msa) return;

                // Clear properties to force recomputation with filtered data
                filteredMSAData.frequencies = null;
                filteredMSAData.entropy = null;
                filteredMSAData.logOdds = null;

                // Recompute properties (frequencies and entropy) from filtered MSA
                MSA.computeMSAProperties(filteredMSAData);

                // Apply filters to all MSAs (will reuse computed entropy for active chain)
                const { coverageCutoff, identityCutoff } = getCurrentMSAFilters();
                applyFiltersToAllMSAs(objectName, {
                    coverageCutoff,
                    identityCutoff,
                    activeChainId: chainId,
                    activeFilteredMSAData: filteredMSAData
                });

                // Refresh entropy colors for all chains
                refreshEntropyColors();
            }
        });
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

function refreshEntropyColors() {
    if (!viewerApi?.renderer) {
        return;
    }

    const renderer = viewerApi.renderer;

    // Always map entropy to structure when MSA data is available
    // This ensures the entropy dropdown option becomes visible
    if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName] && window.MSA) {
        // ...for everything DRAWN, not one object: one object's alignment laid
        // over a merged array colours the second structure by the first one's
        // conservation. See entropyForDrawn.
        renderer.entropy = renderer.entropyForDrawn
            ? renderer.entropyForDrawn()
            : window.MSA.mapEntropyToStructure(renderer.objectsData[renderer.currentObjectName], renderer.currentFrame >= 0 ? renderer.currentFrame : 0);
        if (renderer._updateEntropyOptionVisibility) renderer._updateEntropyOptionVisibility();
    }

    // Only re-render and update colors if entropy mode is active
    if (renderer.colorMode === 'entropy') {
        renderer.colors = null;
        renderer.colorsNeedUpdate = true;
        renderer.render('app.js: refreshEntropyColors');
        document.dispatchEvent(new CustomEvent('py2dmol-color-change'));

        if (typeof updateColors === 'function') {
            window.SEQ?.updateColors();
        }
    }
}

function getCurrentMSAFilters() {
    const coverage = typeof window.MSA?.getCoverageCutoff === 'function'
        ? window.MSA.getCoverageCutoff()
        : DEFAULT_MSA_COVERAGE;
    const identity = typeof window.MSA?.getIdentityCutoff === 'function'
        ? window.MSA.getIdentityCutoff()
        : DEFAULT_MSA_IDENTITY;
    return {
        coverageCutoff: Number.isFinite(coverage) ? coverage : DEFAULT_MSA_COVERAGE,
        identityCutoff: Number.isFinite(identity) ? identity : DEFAULT_MSA_IDENTITY
    };
}

/**
 * Apply filters to all MSAs in an object and update their entropy
 * Uses MSA.applyFiltersToMSA to avoid code duplication
 * @param {string} objectName - Name of the object
 * @param {Object} options - Configuration options
 */
function applyFiltersToAllMSAs(objectName, options = {}) {
    if (!viewerApi?.renderer || !objectName || !window.MSA?.applyFiltersToMSA) return;
    const obj = viewerApi.renderer.objectsData[objectName];
    if (!obj || !obj.msa || !obj.msa.msasBySequence) return;

    const {
        coverageCutoff = DEFAULT_MSA_COVERAGE,
        identityCutoff = DEFAULT_MSA_IDENTITY,
        activeChainId = null,
        activeFilteredMSAData = null
    } = options;

    const activeQuerySeq = activeChainId && obj.msa.chainToSequence
        ? obj.msa.chainToSequence[activeChainId]
        : null;
    const activeEntropy = activeFilteredMSAData?.entropy;
    const activeFreqs = activeFilteredMSAData?.frequencies;

    // Short-circuit if only one unique MSA and we already have its entropy
    const uniqueMSAs = Object.keys(obj.msa.msasBySequence);
    if (uniqueMSAs.length === 1 && activeQuerySeq && activeEntropy) {
        const msaEntry = obj.msa.msasBySequence[uniqueMSAs[0]];
        if (msaEntry?.msaData) {
            msaEntry.msaData.entropy = activeEntropy;
            // the frequencies THOSE came from, or the object carries the
            // filtered entropy beside the unfiltered counts - see the note
            // further down, where the same pairing is kept
            if (activeFreqs) msaEntry.msaData.frequencies = activeFreqs;
        }
        return;
    }

    for (const [querySeq, msaEntry] of Object.entries(obj.msa.msasBySequence)) {
        const sourceData = msaEntry.msaData;
        if (!sourceData) continue;

        // Reuse entropy from active chain if it matches
        if (activeQuerySeq && querySeq === activeQuerySeq && activeEntropy) {
            sourceData.entropy = activeEntropy;
            continue;
        }

        // Apply filters using MSA's method (avoids code duplication)
        const filteredMSA = window.MSA.applyFiltersToMSA(sourceData, coverageCutoff, identityCutoff);
        if (!filteredMSA) continue;

        // Compute entropy from filtered sequences
        MSA.computeMSAProperties(filteredMSA);

        if (filteredMSA.entropy) {
            sourceData.entropy = filteredMSA.entropy;
        } else {
            delete sourceData.entropy;
        }
        // ...AND THE FREQUENCIES THEY CAME FROM. The entropy here is over the
        // FILTERED alignment, while sourceData.frequencies were computed over
        // every sequence in the file when the MSA was merged - two numbers on
        // one object describing two different alignments. The logo and the PSSM
        // read the frequencies (setMSA copies them into the displayed MSA), so
        // the picture disagreed with the colours the structure was wearing:
        // measured on AF-P0A8I3, column 173 read E = 0.9438 over 12,021
        // sequences while the entropy beside it was over the 10,613 that passed
        // the filters, where E is 0.9754.
        if (filteredMSA.frequencies) {
            sourceData.frequencies = filteredMSA.frequencies;
        } else {
            delete sourceData.frequencies;
        }
    }
}

function initializeViewerConfig() {
    // Get DOM elements for config sync
    const biounitEl = document.getElementById('biounitCheckbox');
    const loadLigandsEl = document.getElementById('loadLigandsCheckbox');
    const detectCyclicEl = document.getElementById('detectCyclicCheckbox');

    // Initialize global viewer config (nested structure matching Python)
    window.viewerConfig = {
        display: {
            size: [FIXED_WIDTH, FIXED_HEIGHT],
            rotate: false,
            autoplay: false,
            controls: true,
            box: true
        },
        rendering: {
            shadow: true,
            outline: "full",  // "none", "partial", or "full"
            width: 3.0,
            // The web app opens on the Richardson cartoon. The concrete slider
            // values do not come from here - they come from STYLE_DEFAULTS, via
            // the setPreset call in initializeApp - so this names the look and
            // the table supplies it. Python still opens on tube.
            style: "cartoon",
            preset: "richardson",
            ortho: 0.5,  // Normalized 0-1 range (1.0 = full orthographic)
            // OFF here, though the renderer's own default (and Python's) is on.
            // The test is a distance one - a chain's first and last residue
            // within the chain-break cutoff - so a linear chain whose termini
            // happen to fold together passes it, and gets a bond drawn where
            // there is none plus a rainbow ramp wrapped right round, which
            // paints its N and C ends the same colour. Python is scripted by
            // someone who knows what they loaded; the web app takes whatever is
            // dropped on it, so here it is asked for.
            detect_cyclic: false
        },
        color: {
            mode: "auto",
            colorblind: false
        },
        pae: {
            enabled: true,
            size: PAE_PLOT_SIZE
        },
        scatter: {
            enabled: false,
            size: 340,
            xlabel: null,
            ylabel: null,
            xlim: null,
            ylim: null
        },
        overlay: {
            enabled: false
        },
        // Web app specific settings (not part of Python config)
        ui: {
            biounit: true,
            // ON BY DEFAULT, like the biological unit beside it. A ligand is
            // usually the reason the structure is being looked at, and leaving
            // it out silently reads as the file not having one.
            loadLigands: true,
            filterAdditives: true
        },
        viewer_id: "standalone-viewer-1"
    };

    // Store config in py2dmol_configs for viewer-mol.js to access
    if (!window.py2dmol_configs) {
        window.py2dmol_configs = {};
    }
    window.py2dmol_configs[window.viewerConfig.viewer_id] = window.viewerConfig;

    // Helper to sync config changes to py2dmol_configs
    window.syncViewerConfig = function () {
        if (window.viewerConfig && window.viewerConfig.viewer_id) {
            window.py2dmol_configs[window.viewerConfig.viewer_id] = window.viewerConfig;
        }
    };

    // Sync UI with config
    if (biounitEl) {
        biounitEl.checked = window.viewerConfig.ui.biounit;
    }
    // THE OPTIONS FOLD AWAY. They are defaults, and a default that is right
    // does not need to be on screen - but it does need to be one click away,
    // so the button says whether it is open both in its caret and in
    // aria-expanded.
    const optBtn = document.getElementById('fetchOptionsButton');
    const optPanel = document.getElementById('fetchOptions');
    if (optBtn && optPanel) {
        optBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const open = optPanel.hidden;
            optPanel.hidden = !open;
            optBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
    }
    const filterAddEl = document.getElementById('filterAdditivesCheckbox');
    if (filterAddEl) {
        filterAddEl.checked = window.viewerConfig.ui.filterAdditives !== false;
        filterAddEl.addEventListener('change', () => {
            window.viewerConfig.ui.filterAdditives = filterAddEl.checked;
        });
    }
    if (loadLigandsEl) {
        loadLigandsEl.checked = window.viewerConfig.ui.loadLigands;
    } // Wire change listeners
    if (biounitEl) {
        biounitEl.addEventListener('change', () => {
            window.viewerConfig.ui.biounit = biounitEl.checked;
        });
    }

    if (loadLigandsEl) {
        loadLigandsEl.addEventListener('change', () => {
            window.viewerConfig.ui.loadLigands = loadLigandsEl.checked;
        });
    }

    // DETECT CYCLIC is not a load option, though it sits among them: nothing is
    // re-fetched and nothing is re-parsed, so it applies to what is ALREADY on
    // screen rather than only to the next structure. Its neighbours here are
    // load-time by necessity - you cannot add a biounit you did not download -
    // and this one has no such excuse, so flipping it shows the answer.
    //
    // The ring is closed in setCoords, not in render, so a repaint alone would
    // change nothing at all: the frame has to be reloaded. Same trap the
    // side-chain and contact toggles hit.
    if (detectCyclicEl) {
        detectCyclicEl.checked = !!window.viewerConfig.rendering.detect_cyclic;
        detectCyclicEl.addEventListener('change', () => {
            // The renderer normalises window.viewerConfig in place and keeps
            // THAT object as its own this.config, so writing here reaches it.
            if (!window.viewerConfig.rendering) window.viewerConfig.rendering = {};
            window.viewerConfig.rendering.detect_cyclic = detectCyclicEl.checked;
            if (window.syncViewerConfig) window.syncViewerConfig();
            const renderer = viewerApi?.renderer;
            if (!renderer || !renderer.currentObjectName) return;
            if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
            renderer.cachedSegmentIndices = null;
            // ...of whatever is DRAWN, which may be several objects
            if (renderer.reloadDrawn) renderer.reloadDrawn();
            renderer.render('detect cyclic');
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

/**
 * Handle example button click - generic function that works for any example button
 * @param {string} value - The ID/value to set in the input field
 */
function handleExampleButtonClick(value) {
    // Detect which page we're on
    const fetchIdInput = document.getElementById('fetch-id');
    const fetchUniprotInput = document.getElementById('fetch-uniprot-id');
    const isMSAPage = fetchUniprotInput !== null;

    // Determine which input field and handler to use
    const inputField = isMSAPage ? fetchUniprotInput : fetchIdInput;
    const handler = isMSAPage ? handleMSAFetch : handleFetch;

    if (inputField && value) {
        inputField.value = value;
        handler();
    }
}

/**
 * Setup example buttons - unified for both index.html and msa.html
 * Buttons should have data-example-value attribute with the ID to fetch
 */
function setupExampleButtons() {
    // Find all buttons with data-example-value attribute
    const exampleButtons = document.querySelectorAll('[data-example-value]');

    exampleButtons.forEach(button => {
        const value = button.getAttribute('data-example-value');
        if (value) {
            button.addEventListener('click', () => {
                handleExampleButtonClick(value);
            });
        }
    });
}

function getMSACanvasContainers() {
    return Array.from(document.querySelectorAll('.msa-canvas'));
}

function showMSACanvasContainers() {
    getMSACanvasContainers().forEach(container => {
        container.style.display = 'block';
        container.style.visibility = 'visible';
    });
}

function removeMSACanvasContainers() {
    const containers = getMSACanvasContainers();
    containers.forEach(container => {
        // Remove resize observers if they exist
        if (container.resizeObserver) {
            container.resizeObserver.disconnect();
        }
        // Remove from DOM
        if (container.parentElement) {
            container.parentElement.removeChild(container);
        }
    });
}

function clearMSAState() {
    // Remove containers from DOM to prevent accumulation
    removeMSACanvasContainers();
    // Clear MSA viewer internal state (this will also clear canvas data references)
    if (window.MSA?.clear) {
        try {
            window.MSA.clear();
        } catch (err) {
            console.warn('MSA Viewer clear failed:', err);
        }
    }
    const sequenceCountEl = document.getElementById('msaSequenceCount');
    if (sequenceCountEl) {
        sequenceCountEl.textContent = '-';
    }
}

function setupEventListeners() {
    // Fetch button
    document.getElementById('fetch-btn').addEventListener('click', handleFetch);

    // Upload button
    const uploadButton = document.getElementById('upload-button');
    const fileUploadInput = document.getElementById('file-upload');
    uploadButton.addEventListener('click', () => fileUploadInput.click());
    fileUploadInput.addEventListener('change', handleFileUpload);

    // Example buttons (unified)
    setupExampleButtons();

    // Save state button (main save button at top-right)
    const saveStateButton = document.getElementById('saveStateButton');
    if (saveStateButton) {
        saveStateButton.addEventListener('click', saveViewerState);
    }

    // Save button (camera). Handled by viewer-mol.js via setUIControls: it
    // opens the Save panel, which is now the ONE way to make a still or a
    // video. The separate record button it used to sit beside is gone.

    // Copy selection button (moved to sequence actions)
    const copySelectionButton = document.getElementById('copySelectionButton');
    if (copySelectionButton) {
        copySelectionButton.addEventListener('click', () => {
            const r = viewerApi?.renderer;
            if (!r || !r.extractSelection) {
                console.warn("Copy selection feature not available");
                return;
            }
            // A SELECTION CAN REACH SEVERAL OBJECTS, and Copy makes one new
            // object per object it touched - so it says which, rather than
            // leaving the user to find out that two appeared.
            const made = r.extractSelection();
            const names = Array.isArray(made) ? made : (made ? [made] : []);
            if (names.length > 1) {
                setStatus(`Copied into ${names.join(' and ')}`
                    + ' - one object per structure the selection reached.');
            }
            applySelectionToMSA();
        });
    }

    // CUT: the copy Copy makes, minus the residues from where they came. The
    // renderer owns the order (see cutSelection - the two halves cannot simply
    // be pressed in sequence); this reports what happened, because a cut that
    // silently did nothing looks exactly like a copy that did.
    const cutSelectionButton = document.getElementById('cutSelectionButton');
    if (cutSelectionButton) {
        cutSelectionButton.addEventListener('click', () => {
            const r = viewerApi?.renderer;
            if (!r || !r.cutSelection) return;
            const made = r.cutSelection();
            if (!made) {
                setStatus('Select something first, then Cut moves it into a new object.');
                return;
            }
            // ...one new object per structure the selection reached, named
            setStatus(`Cut ${made.removed} residue${made.removed === 1 ? '' : 's'}`
                + ` into ${made.name}. Reload the file to get them back.`);
            if (window.SEQ?.buildViewDeferred || window.SEQ?.buildView) {
                (window.SEQ.buildViewDeferred || window.SEQ.buildView)();
            }
            applySelectionToMSA();
        });
    }

    // DELETE, beside Copy in the panel's corner. The renderer does the work;
    // this only reports what happened, since a delete that silently did nothing
    // (an empty selection, or one covering everything) is worse than a refusal.
    const deleteSelectionButton = document.getElementById('deleteSelectionButton');
    if (deleteSelectionButton) {
        deleteSelectionButton.addEventListener('click', () => {
            const r = viewerApi?.renderer;
            if (!r || !r.deleteSelection) return;
            const gone = r.residueSelection ? r.residueSelection.size : 0;
            // ...from every object the selection reached, which the count
            // already covers and the message says when it is more than one
            const across = r.objectsInSelection ? r.objectsInSelection() : [];
            if (r.deleteSelection()) {
                setStatus(`Deleted ${gone} residue${gone === 1 ? '' : 's'}`
                    + (across.length > 1 ? ` from ${across.join(' and ')}` : '')
                    + '. Reload the file to get them back.');
                if (window.SEQ?.buildViewDeferred || window.SEQ?.buildView) {
                    (window.SEQ.buildViewDeferred || window.SEQ.buildView)();
                }
                applySelectionToMSA();
            }
        });
    }

    // Navigation buttons
    const orientToggle = document.getElementById('orientToggle');
    const prevObjectButton = document.getElementById('prevObjectButton');
    const nextObjectButton = document.getElementById('nextObjectButton');

    // CLIP. The renderer owns the planes and what they do; this is the panel
    // that sets them. Closing the panel is what commits, so Clip reads as a
    // mode rather than as an action - which is what it is.
    setupClipPanel();

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
    // Hand-drawn build-up, beside Colorblind and Dark. Unchecking it (or
    // touching the structure) skips to the finished picture, so it is never
    // something you have to wait out.
    const drawCheckbox = document.getElementById('drawCheckbox');
    if (drawCheckbox) {
        drawCheckbox.addEventListener('change', () => {
            if (!renderer) return;
            renderer.drawCheckbox = drawCheckbox;
            renderer.setDrawMode(drawCheckbox.checked);
        });
    }
    if (prevObjectButton) prevObjectButton.addEventListener('click', gotoPreviousObject);
    if (nextObjectButton) nextObjectButton.addEventListener('click', gotoNextObject);

    // Object and color select
    const objectSelect = document.getElementById('objectSelect');
    // Note: colorSelect event listener is handled in viewer-mol.js initializePy2DmolViewer()
    // We don't need a duplicate listener here

    if (objectSelect) objectSelect.addEventListener('change', handleObjectChange);
    attachObjectList();

    // Attach sequence controls
    const sequenceView = document.getElementById('sequenceView');
    const selectAllBtn = document.getElementById('selectAllResidues'); // Button ID kept for compatibility, but shows "Show all"
    const clearAllBtn = document.getElementById('clearAllResidues'); // Button ID kept for compatibility, but shows "Hide all"
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
        if (sequenceModeSelect && window.SEQ) {
            const currentMode = window.SEQ.getMode ? window.SEQ.getMode() : true;
            sequenceModeSelect.value = currentMode ? 'sequence' : 'chain';
        }
    }

    if (sequenceModeSelect && window.SEQ) {
        // Set initial value
        const initialMode = window.SEQ.getMode ? window.SEQ.getMode() : true;
        sequenceModeSelect.value = initialMode ? 'sequence' : 'chain';

        // Handle mode change
        sequenceModeSelect.addEventListener('change', (e) => {
            const mode = e.target.value;
            const sequenceMode = mode === 'sequence';
            if (window.SEQ) {
                window.SEQ.setMode(sequenceMode);
            }
            // Always try to rebuild - window.SEQ?.buildView() will return early if no data is available
            window.SEQ?.buildView();
        });
    }

    // Initialize sequence mode to enabled by default
    if (window.SEQ) {
        window.SEQ.setMode(true);
    }

    // Initialize dropdown state to reflect default sequence mode
    updateSequenceModeDropdown();

    // Expose update function globally for programmatic mode changes
    window.updateSequenceModeDropdown = updateSequenceModeDropdown;

    // Monitor frame changes to update sequence view and scatter plot during animation
    let lastCheckedFrame = -1;
    function checkFrameChange() {
        if (viewerApi?.renderer) {
            const renderer = viewerApi.renderer;
            const currentFrame = renderer.currentFrame;
            if (currentFrame !== lastCheckedFrame && currentFrame >= 0) {
                lastCheckedFrame = currentFrame;

                // Dispatch frame change event for scatter plot and other listeners
                document.dispatchEvent(new CustomEvent('py2dmol-frame-change', {
                    detail: { frameIndex: currentFrame }
                }));

                // Check if sequence view needs updating
                const objectName = renderer.currentObjectName;
                if (objectName && renderer.objectsData[objectName]) {
                    const object = renderer.objectsData[objectName];
                    if (object.frames && object.frames.length > currentFrame) {
                        // Rebuild sequence view if sequence changed
                        window.SEQ?.buildView();
                    }
                }
            }
        }
        requestAnimationFrame(checkFrameChange);
    }
    // Start monitoring frame changes
    requestAnimationFrame(checkFrameChange);

    // ---- SELECTION TOOLS -------------------------------------------------
    // Colour / secondary structure / visibility applied to the residues the
    // user has selected in the sequence view. The selection model already
    // exists (renderer.getVisibility); until now its only consumer was
    // visibility, so these hang off the same source of truth.

    // Positions the tools act on. In 'default' mode getVisibility() reports
    // every residue as selected, which is the right answer for visibility but
    // the WRONG one here - "colour everything because you have not selected
    // anything" is never what was meant. So an explicit selection is required.
    function getActiveSelection() {
        const renderer = viewerApi?.renderer;
        if (!renderer || !renderer.currentObjectName) return null;
        // A drag records a selection and leaves visibility alone, so the
        // selection - not the visible set - is what the tools act on.
        const t = renderer.residueSelection;
        return (t && t.size) ? Array.from(t) : null;
    }

    // Write into the object's existing colour structure, in the SAME shape
    // Python's set_color(position=...) produces: {type:'advanced', value:
    // {position:{idx: colour}}}. One representation means a colour set here is
    // indistinguishable from one set in Python, saves with the object, and is
    // understood by resolveColorHierarchy without any new code path.
    function setSelectionColor(positions, color) {
        const renderer = viewerApi?.renderer;
        if (!renderer) return;
        // EACH OBJECT'S OWN MAP, IN ITS OWN NUMBERING. A selection can reach
        // two objects when several are on screen, and the colour is stored
        // against the object - so writing merged indices into the current one
        // would colour its residues instead of the ones that were picked.
        const groups = renderer.writeGroups
            ? renderer.writeGroups(positions)
            : [{ object: renderer.objectsData?.[renderer.currentObjectName],
                positions: Array.from(positions) }];
        for (const g of groups) {
            const obj = g.object;
            if (!obj) continue;
            let value = {};
            if (obj.color && obj.color.type === 'advanced' && obj.color.value) {
                value = obj.color.value;
            } else if (obj.color && obj.color.type === 'mode') {
                // preserve an object-wide mode as the base the overrides sit on
                value = { object: obj.color.value };
            } else if (obj.color && obj.color.type === 'literal') {
                value = { object: obj.color.value };
            }
            if (!value.position) value.position = {};
            for (const i of g.positions) {
                if (color === null) delete value.position[i];
                else value.position[i] = color;
            }
            if (Object.keys(value.position).length === 0) delete value.position;
            obj.color = Object.keys(value).length ? { type: 'advanced', value } : null;
        }
        renderer.colorsNeedUpdate = true;
        renderer.plddtColorsNeedUpdate = true;
        document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        renderer.render('selection colour');
    }

    // SIDE-CHAIN COLOUR, kept apart from `color` and keyed by RESIDUE.
    //
    // It cannot go in the ordinary position colour map: side-chain atoms are
    // positions only while they are being drawn, and their indices are handed
    // out afresh every time the set changes, so a colour stored against one
    // would come back pointing at a different atom. The residue index is the
    // stable name for "this side chain", so that is what it is stored under,
    // and the renderer resolves an atom's colour through its owner.
    //
    // Unset means FOLLOW THE RESIDUE, which is why this is a separate map
    // rather than a copy of the residue's colour taken at the time: recolour
    // the main chain and side chains that were never given their own colour
    // come along, which is what you would expect of a part of the same residue.
    function setSelectionSidechainColor(positions, color) {
        const renderer = viewerApi?.renderer;
        if (!renderer) return;
        // ...per owning object and in its numbering, like the residue colours
        for (const g of (renderer.writeGroups ? renderer.writeGroups(positions)
            : [{ object: renderer.objectsData?.[renderer.currentObjectName],
                positions: Array.from(positions) }])) {
            const obj = g.object;
            if (!obj) continue;
            const map = obj.sidechainColor ? { ...obj.sidechainColor } : {};
            for (const i of g.positions) {
                if (color === null) delete map[i];
                else map[i] = color;
            }
            obj.sidechainColor = Object.keys(map).length ? map : null;
        }
        renderer.colorsNeedUpdate = true;
        renderer.plddtColorsNeedUpdate = true;
        document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        renderer.render('selection sidechain colour');
    }

    // Secondary structure override. Lives on the renderer as a plain
    // index -> letter map; viewer-cartoon.js applies it to BOTH the geometry
    // and the colour pass, and its contents are part of the SS cache key so an
    // edit invalidates cleanly.
    function setSelectionSse(positions, letter) {
        const renderer = viewerApi?.renderer;
        if (!renderer) return;
        // Stored on the OBJECT as `sse`, exactly where set_color puts `color`
        // and where Python's set_sse writes. It used to live on the renderer,
        // which meant it was not object-scoped: its position indices would be
        // reinterpreted against whatever object became current. Written per
        // owning object for the same reason, now that a selection can reach
        // more than one of them at a time.
        for (const g of (renderer.writeGroups ? renderer.writeGroups(positions)
            : [{ object: renderer.objectsData?.[renderer.currentObjectName],
                positions: Array.from(positions) }])) {
            const obj = g.object;
            if (!obj) continue;
            const ov = obj.sse ? { ...obj.sse } : {};
            for (const i of g.positions) {
                if (letter === null) delete ov[i];
                else ov[i] = letter;
            }
            obj.sse = Object.keys(ov).length ? ov : null;
        }
        // the ribbon profile is built from sec, so the cached geometry has to go
        if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
        renderer.colorsNeedUpdate = true;
        document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        renderer.render('selection structure');
    }

    // CONTACTS, between exactly two residues. Stored on the object as
    // `contacts`, which already existed and is already saved and restored - the
    // renderer turns each entry into a segment of type 'C'. Written in the
    // CHAIN + RESIDUE form rather than as position indices: indices are a
    // property of the current frame's arrays, and a copied sub-structure
    // renumbers them, while a chain and residue number name the same pair
    // whatever happens to the arrays.
    //
    // A contact is a line between a PAIR, so all of this needs exactly two
    // residues; the row is not offered otherwise.
    const contactKeyOf = (positions) => {
        const renderer = viewerApi?.renderer;
        if (!renderer || !renderer.chains || positions.length !== 2) return null;
        const [a, b] = positions;
        const rn = renderer.residueNumbers;
        if (!rn || rn[a] === undefined || rn[b] === undefined) return null;
        return [renderer.chains[a], rn[a], renderer.chains[b], rn[b]];
    };
    /**
     * WHICH OBJECT A CONTACT BELONGS TO - and null when the pair spans two.
     *
     * A contact is stored on an object as a pair of chain+residue references,
     * and the renderer resolves it among THAT object's positions. A pair with
     * one end in each of two structures has nowhere to live: stored on either
     * one, the other end resolves to nothing and the line never appears. The
     * panel refuses it out loud instead - see the contact row.
     */
    const contactOwnerOf = (positions) => {
        const renderer = viewerApi?.renderer;
        if (!renderer || !positions || positions.length !== 2) return null;
        if (!renderer.ownerOf) return renderer.currentObjectName;
        const a = renderer.ownerOf(positions[0]);
        const b = renderer.ownerOf(positions[1]);
        const an = a ? a.name : renderer.currentObjectName;
        const bn = b ? b.name : renderer.currentObjectName;
        return (an && an === bn) ? an : null;
    };
    /** ...and the pair in that object's own numbering, for the index form. */
    const contactLocalPair = (positions) => {
        const renderer = viewerApi?.renderer;
        if (!renderer || !renderer.ownerOf) return positions;
        return positions.map((i) => {
            const o = renderer.ownerOf(i);
            return o ? o.local : i;
        });
    };
    // Does this stored contact name that pair? Either way round: a contact has
    // no direction, and the user may have selected the two in any order.
    //
    // BOTH STORED FORMS. parseContactsFile writes the same entries the panel
    // does, and it has two: "A 10 B 50 0.5" and the bare-index "10 50 0.5".
    // Understanding only the first made a file written in indices invisible
    // here - clicking the pair offered Add and made a duplicate, while Remove,
    // colour and width all failed to find it. The panel keeps WRITING the chain
    // form, which survives renumbering; it just has to read both.
    const contactMatches = (c, key, positions) => {
        if (!Array.isArray(c) || c.length < 3) return false;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
            if (!positions || positions.length !== 2) return false;
            // ...IN THE OBJECT'S OWN NUMBERING. The stored indices are that
            // object's; the positions handed in are the renderer's, and with
            // several objects merged those are not the same numbers.
            const [p1, p2] = contactLocalPair(positions);
            return (c[0] === p1 && c[1] === p2) || (c[0] === p2 && c[1] === p1);
        }
        if (c.length < 4 || typeof c[0] !== 'string') return false;
        return (c[0] === key[0] && c[1] === key[1] && c[2] === key[2] && c[3] === key[3])
            || (c[0] === key[2] && c[1] === key[3] && c[2] === key[0] && c[3] === key[1]);
    };
    // WHERE THE WEIGHT AND COLOUR SIT depends on the form. "A 10 B 50 0.5 red"
    // puts them at 4 and 5; the bare-index "10 50 0.5 red" at 2 and 3. Reading
    // both forms and then writing to the chain form's slots would have put a
    // colour where the index form keeps nothing and left a hole behind it.
    const contactSlots = (c) => ((typeof c[0] === 'number' && typeof c[1] === 'number')
        ? { w: 2, col: 3 } : { w: 4, col: 5 });
    const findContact = (positions) => {
        const renderer = viewerApi?.renderer;
        const owner = contactOwnerOf(positions);
        const obj = owner ? renderer?.objectsData?.[owner] : null;
        const key = contactKeyOf(positions);
        if (!obj || !key || !Array.isArray(obj.contacts)) return null;
        const i = obj.contacts.findIndex((c) => contactMatches(c, key, positions));
        return i < 0 ? null : { obj, key, i };
    };
    const commitContacts = (renderer, obj, contacts) => {
        obj.contacts = contacts.length ? contacts : null;
        // A RELOAD, not a repaint. Contacts become segments, and the segment
        // list - contact block included - is built inside setCoords, not inside
        // render. Invalidating the cache and repainting therefore changes
        // nothing at all: the contact is stored correctly, resolves correctly,
        // and never appears. Same trap the side-chain toggle hit.
        if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
        if (renderer.reloadDrawn) renderer.reloadDrawn();
        renderer.render('selection contact');
        if (window.updateSelectionToolsState) window.updateSelectionToolsState();
    };
    function addSelectionContact(positions) {
        const renderer = viewerApi?.renderer;
        const owner = contactOwnerOf(positions);
        if (!owner) {
            setStatus('A contact joins two residues of ONE structure - these are'
                + ' in different objects, and there is nowhere to store it.');
            return;
        }
        const obj = renderer?.objectsData?.[owner];
        const key = contactKeyOf(positions);
        if (!obj || !key) return;
        const contacts = Array.isArray(obj.contacts) ? obj.contacts.slice() : [];
        if (contacts.some((c) => contactMatches(c, key, positions))) return;  // already there
        // Weight 1, and no colour - which the renderer draws as its default
        // yellow. Left off rather than written in, so a contact that was never
        // given a colour keeps following that default if it ever changes.
        contacts.push([key[0], key[1], key[2], key[3], 1.0]);
        commitContacts(renderer, obj, contacts);
    }
    function removeSelectionContact(positions) {
        const found = findContact(positions);
        if (!found) return;
        const contacts = found.obj.contacts.slice();
        contacts.splice(found.i, 1);
        commitContacts(viewerApi.renderer, found.obj, contacts);
    }
    // The stored colour is an {r,g,b} object, which is what the segment builder
    // reads straight through as contactColor.
    function setSelectionContactColor(positions, hex) {
        const found = findContact(positions);
        if (!found) return;
        const contacts = found.obj.contacts.slice();
        const c = contacts[found.i].slice();
        const sl = contactSlots(c);
        c[sl.w] = typeof c[sl.w] === 'number' ? c[sl.w] : 1.0;
        if (hex === null) c.length = sl.col;
        else {
            c[sl.col] = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16),
                b: parseInt(hex.slice(5, 7), 16) };
        }
        contacts[found.i] = c;
        commitContacts(viewerApi.renderer, found.obj, contacts);
    }

    // Per-contact WIDTH, which is the entry's existing weight slot - the
    // renderer already scales a contact's stroke by contactWeight, so this
    // needs nothing new in the drawing, only a control.
    function setSelectionContactWidth(positions, w) {
        const found = findContact(positions);
        if (!found) return;
        const contacts = found.obj.contacts.slice();
        const c = contacts[found.i].slice();
        c[contactSlots(c).w] = w;
        contacts[found.i] = c;
        commitContacts(viewerApi.renderer, found.obj, contacts);
    }

    // SIDE CHAINS, per residue. Stored on the OBJECT as `sidechains`, a Set of
    // position indices, exactly where `color` and `sse` live and for the same
    // reason: position indices only mean anything against the object they were
    // set on, so putting this on the renderer would reinterpret them the moment
    // another object became current.
    //
    // Nothing is computed here. The atoms were captured at load
    // (buildSidechainTable in utils.js), so this only ever writes down WHICH
    // residues; a structure with no side-chain data simply draws nothing.
    function setSelectionSidechains(positions, on) {
        const renderer = viewerApi?.renderer;
        if (!renderer) return;
        if (on && !renderer.sidechains) {
            setStatus('No side-chain atoms in this structure (a backbone-only model has none).');
            return;
        }
        let changed = false;
        // per owning object, in its own numbering - see writeGroups
        for (const g of (renderer.writeGroups ? renderer.writeGroups(positions)
            : [{ object: renderer.objectsData?.[renderer.currentObjectName],
                positions: Array.from(positions) }])) {
            const obj = g.object;
            if (!obj) continue;
            const cur = obj.sidechains instanceof Set ? new Set(obj.sidechains) : new Set();
            let mine = false;
            for (const i of g.positions) {
                if (on ? !cur.has(i) : cur.has(i)) mine = true;
                if (on) cur.add(i); else cur.delete(i);
            }
            if (!mine) continue;
            changed = true;
            obj.sidechains = cur.size ? cur : null;
        }
        if (!changed) return;               // nothing to redraw for
        // The atoms become real positions, so this is a RELOAD, not a repaint:
        // _materialiseSidechains runs inside the frame load and nothing shorter
        // than that rebuilds the coordinate array it appends to.
        if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
        renderer.reloadDrawn();
        renderer.render('selection sidechains');
    }

    // WHAT THE TOGGLES SHOW. Each reflects the selection it applies to, so a
    // press is never a guess about the current state - which the +/- pairs it
    // replaced could not do at all: a selection already showing its side chains
    // looked exactly like one that was not.
    //
    // THREE STATES, because a selection is a set. All of it has the thing, none
    // of it does, or some does - and "some" is neither, so it reads
    // indeterminate rather than picking a side. Clicking an indeterminate box
    // checks it, so the mixture resolves by turning everything on.
    // IS THIS ROW ABOUT A LIGAND? A ligand atom is a position of the file's
    // own: it owns no side chain and has no base plate, so a selection made
    // only of them reaches the side-chain row for one reason - its elements -
    // and every control on that row then means the LIGAND rather than a side
    // chain nothing in the selection has. One definition, read by the panel and
    // by the handlers behind it, so the row and its controls cannot disagree
    // about which of the two it is.
    //
    // A MIXED selection is a side-chain row. Renaming the row the moment one
    // ligand atom joined a dozen residues would take the side-chain controls
    // away from the residues that do have them.
    function ligandRowPositions(positions) {
        const renderer = viewerApi?.renderer;
        if (!renderer || !positions || !positions.length) return null;
        const t = renderer.positionTypes || [];
        const owners = renderer.sidechainOwners ? renderer.sidechainOwners() : null;
        const map = renderer.sidechainMap;
        const lig = [];
        for (const i of positions) {
            if (owners && owners.has(i)) return null;      // a residue with a side chain
            if (t[i] === 'D' || t[i] === 'R') return null; // a nucleotide has a plate
            // ...and an APPENDED side-chain atom is type 'L' too, but it
            // belongs to a residue and is switched with it
            if (t[i] === 'L' && !(map && map.has(i))) lig.push(i);
        }
        return lig.length ? lig : null;
    }

    // ALL, NONE OR SOME of these positions drawn, read off the visibility mask
    // - null there means everything is visible, which is the state a structure
    // nobody has hidden anything in is in.
    function visibleState(positions) {
        const renderer = viewerApi?.renderer;
        const vis = renderer && renderer.visiblePositions;
        if (!vis) return true;
        let on = 0;
        for (const i of positions) if (vis.has(i)) on++;
        if (!on) return false;
        return on === positions.length ? true : null;
    }

    // WHAT THE SSE MENU SAYS. Four states - forced to helix, to sheet, to loop,
    // or left to the assignment - and Mixed where the selection disagrees,
    // which is a state and not a letter, so it is shown and cannot be picked.
    //
    // The DSSP entry carries the automatic answer in its label where the
    // drawing already knows it ("DSSP (Helix)"), which is the difference
    // between a state that says nothing and one that says what you are looking
    // at. Not computed for it: see assignedSseFor.
    function syncSseSelect(sel, renderer, picked) {
        const forced = renderer.forcedSseFor ? renderer.forcedSseFor(picked) : 'none';
        const auto = renderer.assignedSseFor ? renderer.assignedSseFor(picked) : '';
        const NAME = { H: 'Helix', E: 'Sheet', C: 'Loop' };
        sel.value = forced === 'none' ? 'dssp' : forced;
        const dssp = sel.querySelector('option[value="dssp"]');
        if (dssp) {
            dssp.textContent = (forced === 'none' && NAME[auto])
                ? `DSSP (${NAME[auto]})` : 'DSSP';
        }
        // ...and the tooltip is where forced and assigned are told apart: the
        // menu shows one letter either way, and which of the two it is decides
        // whether the drawing will change under you when the model does.
        sel.title = forced === '' ? 'The selected residues have different structures'
            : (forced === 'none'
                ? (NAME[auto] ? `${NAME[auto]}, from the DSSP assignment`
                    : 'Structure from the DSSP assignment')
                : `Forced to ${NAME[forced] || forced}`);
    }

    function syncSelectionToggles(picked, none) {
        const renderer = viewerApi?.renderer;
        const obj = renderer?.objectsData?.[renderer.currentObjectName];
        const list = picked || [];
        const set = (id, state) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.indeterminate = state === null;
            el.checked = state === true;
        };
        // how many of `of` are in `have`; `null` means the set is absent, which
        // for bases and elements means ALL and for side chains means NONE
        const tally = (of, have, absentIsAll) => {
            if (!of.length) return false;
            const n = of.filter((i) => (have ? have.has(i) : absentIsAll)).length;
            if (n === 0) return false;
            if (n === of.length) return true;
            return null;
        };
        if (none || !renderer || !obj) {
            for (const id of ['elementsShowToggle', 'mainchainShowToggle',
                'sidechainShowToggle', 'contactShowToggle', 'plateShowToggle']) {
                set(id, false);
            }
            return;
        }
        // ...and only positions that still EXIST. A selection outlives the
        // coordinate array it was made against - a click can land on a
        // side-chain atom, and hiding side chains takes that atom away - so a
        // stale index would be tallied as "not visible" and read as mixed.
        // The renderer prunes them; this is the second lock on the same door.
        const nPos = renderer.coords ? renderer.coords.length : Infinity;
        const live = list.filter((i) => i < nPos);
        // ...AND AS RESIDUES, because that is what every question on this panel
        // is about.
        //
        // Showing a side chain APPENDS its atoms to the coordinate array as
        // positions of their own, carrying their residue's chain - so selecting
        // the chain again picks up the atoms as well as the residues. On 1YNE
        // that is 31 residues and 347 atoms, and an atom answers each of these
        // questions for ITSELF: it has no side chain of its own, so the row
        // read 31 full against 347 none and came back Mixed. The controls were
        // right about the selection and wrong about the structure - and it
        // only happened once the atoms existed, which is to say immediately
        // after using the control that made them.
        const scMapT = renderer.sidechainMap;
        const res = scMapT && scMapT.size
            ? [...new Set(live.map((i) => {
                const e = scMapT.get(i);
                return e ? e.owner : i;
            }))]
            : live;
        const owners = renderer.sidechainOwners ? renderer.sidechainOwners() : null;
        const scAble = owners ? live.filter((i) => owners.has(i)) : [];
        const t = renderer.positionTypes || [];
        // ELEMENTS ARE NOT ONLY A SIDE-CHAIN THING. A ligand atom is a position
        // of its own and carries its own element, so it can be coloured by it
        // with no side chain anywhere in the selection - which is why this is
        // tallied over the renderer's element owners rather than over scAble.
        const elOwners = renderer.elementOwners ? renderer.elementOwners() : owners;
        const elAble = elOwners ? live.filter((i) => elOwners.has(i)) : [];
        const ligEl = !!(elOwners && live.some((i) => t[i] === 'L' && elOwners.has(i)));
        // ...the set in MERGED indices, like the positions being tallied: read
        // off the object it would be that object's own numbering, and every
        // object after the first would answer for the wrong residues.
        set('elementsShowToggle', tally(elAble,
            renderer.mergedObjectSet ? renderer.mergedObjectSet('elements', 'all')
                : (obj.elements instanceof Set ? obj.elements : null), true));
        // ...and whether any of it is a nucleotide, which is the renderer's own
        // question rather than a second copy of the type test
        const hasNuc = !!(renderer.hasBasesFor && renderer.hasBasesFor(live));
        // THE SIDE-CHAIN MODE, read back per residue and shown only when the
        // whole selection agrees. Plate is offered only where the selection has
        // nucleotides - a protein has no such thing, and an option that does
        // nothing is worse than one that is not there.
        // HOW THE SELECTION'S SIDE CHAINS ARE DRAWN, read back per residue and
        // shown only where the whole selection agrees. One answer, two controls
        // that can show it: a switch where there are two states and a menu
        // where there are three.
        // ...both in MERGED indices - see shownSidechainSet and mergedObjectSet
        const scSet = renderer.shownSidechainSet ? renderer.shownSidechainSet()
            : (obj.sidechains instanceof Set ? obj.sidechains : null);
        const bSet = renderer.mergedObjectSet ? renderer.mergedObjectSet('bases', 'all')
            : (obj.bases instanceof Set ? obj.bases : null);
        const modeOf = (i) => {
            if (scSet && scSet.has(i)) return 'full';
            const isNuc = t[i] === 'D' || t[i] === 'R';
            if (isNuc && (!bSet || bSet.has(i))) return 'plate';
            return 'none';
        };
        const modes = new Set(res.map(modeOf));
        const mode = modes.size === 1 ? [...modes][0] : '';
        const scSel = document.getElementById('plateShowToggle');
        const scTog = document.getElementById('sidechainShowToggle');
        // WHICH OF THE TWO IS ON THE ROW. A protein side chain is drawn or it
        // is not; only a nucleotide has the plate as well, and only there is a
        // menu worth reading. Never both - two controls for one question is
        // what this row stopped being.
        // BY ITS LABEL, NOT ITS CHECKBOX. The input is invisible on its own -
        // absolutely positioned at zero opacity, with the label carrying the
        // word - so hiding it left "Show" on the row beside the menu that had
        // replaced it. The select IS its own visible element and hides itself.
        // ...and on a LIGAND row the switch stays, meaning the ligand itself:
        // drawn or not drawn, which is the same two states a protein side chain
        // has. The menu never appears there - a ligand has no plate.
        // SHOW FIRST, ALWAYS, AND THE STYLE AFTER IT.
        //
        // Every row on this panel answers "is this drawn" with a Show switch,
        // and the side-chain row answered it with a three-way menu instead
        // wherever the selection had a nucleotide - so the same question had
        // two shapes depending on what you had picked, and None hid inside a
        // list where every other row has a switch. The switch is the question
        // now; the menu is the second question, WHICH WAY, and it appears
        // beside it only where there is a choice to make - a nucleotide, which
        // can be a plate or its real atoms. A protein side chain and a ligand
        // have one way of being drawn, so they have no menu.
        const ligPos = ligandRowPositions(live);
        const ligShown = ligPos ? visibleState(ligPos) : false;
        const scNothing = !scAble.length && !hasNuc;
        if (scTog) {
            const wrapTog = scTog.closest ? scTog.closest('label') : null;
            (wrapTog || scTog).hidden = scNothing && !ligPos;
            set('sidechainShowToggle', ligPos ? ligShown
                : (mode === '' ? null : mode !== 'none'));
        }
        if (scSel) {
            // ...and the Plate switch only while something IS drawn: a way of
            // drawing a thing that is not drawn is a control for nothing. By
            // its LABEL, which is what carries the word - the checkbox is
            // invisible on its own.
            const wrapPlate = scSel.closest ? scSel.closest('label') : null;
            (wrapPlate || scSel).hidden = !hasNuc || mode === 'none' || mode === '';
            // ON MEANS PLATE, off means the real atoms. Left alone while
            // nothing is drawn, so the answer survives a switch off and on:
            // pick atoms, hide them, show them again, and they are still atoms.
            if (mode === 'plate' || mode === 'full') {
                scSel.checked = mode === 'plate';
                scSel.indeterminate = false;
            } else if (mode === '') {
                scSel.indeterminate = true;
            }
        }
        // ELEMENT COLOURS ARE A PROPERTY OF ATOMS, so the control only makes
        // sense while there are atoms drawn. On None there is nothing to
        // colour, and a plate is one flat shape with no elements in it - the
        // toggle sat there in both, doing nothing a user could see. Hidden by
        // its LABEL, which is what carries the text: hiding the checkbox alone
        // leaves "Elements" on the row with no control.
        // A LIGAND'S ELEMENTS FOLLOW ITS OWN SHOW, for the same reason a side
        // chain's follow Full: there is nothing to colour while nothing is
        // drawn. Hidden while the ligand is off, and while the selection is
        // half on, where the switch has no one answer to show.
        const elTog = document.getElementById('elementsShowToggle');
        if (elTog) {
            const wrap = elTog.closest ? elTog.closest('label') : null;
            (wrap || elTog).hidden = ligPos
                ? (ligShown !== true || !ligEl) : mode !== 'full';
        }
        // WHAT THE ROW IS CALLED. "Side chains" over a ligand's own controls
        // names something the selection has not got - and the swatch means the
        // ligand's colour there, which is why it stays: see the picker's own
        // dispatch on ligandRowPositions.
        const scRowEl = document.getElementById('sidechainRow');
        if (scRowEl) {
            const lbl = scRowEl.querySelector('.selection-panel-label');
            if (lbl) lbl.textContent = ligPos ? 'Ligand' : 'Side chains';
            const swatch = scRowEl.querySelector('.selection-color-wrap');
            if (swatch) swatch.hidden = false;
            // ...and what the two controls SAY they do, since what they do
            // changed with the row. A tooltip promising side chains over a
            // ligand is the same wrong label as the row's own name was.
            const tip = (el, text) => { if (el) el.title = text; };
            tip(document.getElementById('scColorButton'), ligPos
                ? 'Colour the selected ligand'
                : 'Colour the selected side chains');
            tip(scTog && scTog.closest ? scTog.closest('label') : null, ligPos
                ? 'Draw the selected ligand'
                : 'Draw side chains for the selected residues');
        }

        // MAIN CHAIN IS THE BACKBONE, which a ligand has not got: its Show
        // switches a backbone that is not drawn there either way, and its
        // swatch is the same colour the Ligand row's own swatch sets. So the
        // whole row goes for a ligand rather than sitting there as a duplicate
        // and a no-op.
        const mcRow = document.getElementById('mainchainRow');
        if (mcRow) mcRow.hidden = !!ligPos;
        // The set names what is HIDDEN, so a position in it is a toggle that
        // is off.
        const hidBB = renderer.backboneHiddenSet ? renderer.backboneHiddenSet() : null;
        // ...over residues too: an appended atom is not a backbone position, so
        // it is never in the hidden set, and a chain whose backbone is hidden
        // read as Mixed as soon as its side chains were drawn.
        set('mainchainShowToggle', !hidBB ? true
            : (res.every((i) => !hidBB.has(i)) ? true
                : (res.every((i) => hidBB.has(i)) ? false : null)));
        set('contactShowToggle', list.length === 2 && !!findContact(list));
    }

    // Element colours, per residue. A pure repaint - the atoms and bonds are
    // already there, only what colour a bond's halves take changes.
    function setSelectionElements(positions, on) {
        const renderer = viewerApi?.renderer;
        if (!renderer || !renderer.setElementsFor) return;
        if (!renderer.setElementsFor(positions, on)) return;   // nothing to redraw
        renderer.render('selection elements');
    }

    // HOW A SELECTION'S SIDE CHAINS ARE DRAWN: none, the nucleic plate, or the
    // real atoms. One control, because the three are alternatives - a pair of
    // toggles cannot say "one or the other", and with the plate on its own row
    // the panel had two rows called Side chain.
    function setSelectionSidechainMode(positions, mode) {
        const renderer = viewerApi?.renderer;
        if (!renderer) return;
        const t = renderer.positionTypes || [];
        const nuc = positions.filter((i) => t[i] === 'D' || t[i] === 'R');
        // the plate is nucleic only; a protein asked for it gets nothing drawn
        // rather than a control that silently does something else
        if (mode === 'plate' && !nuc.length) {
            setStatus('Only nucleotides have a base plate.');
            updateSelectionToolsState();
            return;
        }
        if (nuc.length && renderer.setBasesFor) {
            renderer.setBasesFor(nuc, mode === 'plate');
        }
        // ...and the atoms, which are a frame RELOAD rather than a repaint
        setSelectionSidechains(positions, mode === 'full');
        syncSelectionVisibility(positions);
        renderer.render('selection side chain mode');
    }

    // A RESIDUE WITH NOTHING DRAWN IS HIDDEN, and one with any part drawn is
    // not. The panel used to carry a Show toggle for the whole residue beside
    // the per-part ones, which is a third thing to keep consistent with the
    // other two; composing it means the mask always agrees with the picture,
    // and Orient, the clip and picking all read the mask.
    function syncSelectionVisibility(positions) {
        const renderer = viewerApi?.renderer;
        const obj = renderer?.objectsData?.[renderer.currentObjectName];
        if (!renderer || !obj) return;
        const t = renderer.positionTypes || [];
        const hidBB = renderer.backboneHiddenSet ? renderer.backboneHiddenSet() : null;
        // ...in merged indices, like the positions this walks
        const sc = renderer.shownSidechainSet ? renderer.shownSidechainSet()
            : (obj.sidechains instanceof Set ? obj.sidechains : null);
        const bases = renderer.mergedObjectSet ? renderer.mergedObjectSet('bases', 'all')
            : (obj.bases instanceof Set ? obj.bases : null);
        const drawsSomething = (i) => {
            if (!hidBB || !hidBB.has(i)) return true;              // backbone drawn
            if (sc && sc.has(i)) return true;                      // real atoms
            const isNuc = t[i] === 'D' || t[i] === 'R';
            if (isNuc && (!bases || bases.has(i))) return true;    // plate
            return false;
        };
        // ...AND THEIR ATOMS WITH THEM. A shown side chain is APPENDED to the
        // coordinate array, and the mask is a set of position indices - so a
        // residue marked visible without its atoms leaves them out of it, and
        // the side chain the user just asked for is not drawn. They inherit
        // their owner's visibility at materialisation; this keeps that true
        // afterwards.
        // ...the renderer's own rule, not a third copy of it - see
        // withSidechainAtoms
        const withAtoms = (list) => (renderer.withSidechainAtoms
            ? [...renderer.withSidechainAtoms(new Set(list))] : list);
        const show = []; const hide = [];
        for (const i of positions) (drawsSomething(i) ? show : hide).push(i);
        if (hide.length) setSelectionVisible(withAtoms(hide), false, false);
        if (show.length) setSelectionVisible(withAtoms(show), true, false);
    }

    // WITHIN N ANGSTROM OF WHAT IS SELECTED, atom to atom. The renderer does
    // the search (see residuesWithin); this is the button, and the reporting -
    // a shell that found nothing has to say so, or it reads as a dead control.
    // How near counts as an interaction, side chain to side chain. 5 A is a
    // contact shell: a hydrogen bond is under 3.5 and a salt bridge under 4,
    // and past about 6 the answer is everything in the neighbourhood.
    const INTERACTION_CUTOFF_A = 5;

    function selectNearby(cutoff, sidechainsOnly) {
        const renderer = viewerApi?.renderer;
        if (!renderer || !renderer.residuesWithin) return;
        const sel = renderer.residueSelection;
        const seed = sel ? (sel instanceof Set ? sel : new Set(sel)) : null;
        if (!seed || !seed.size) {
            setStatus('Select something first, then Within finds what is near it.');
            return;
        }
        const what = sidechainsOnly ? 'side chain to side chain' : 'atom to atom';
        const found = renderer.residuesWithin(seed, cutoff, { sidechainsOnly });
        const added = found.size - seed.size;
        if (!added) {
            // A SIDE-CHAIN SEARCH CAN FIND NOTHING FOR TWO REASONS, and they are
            // not the same news: nothing near enough, or nothing to measure -
            // a glycine, or a structure whose side chains were never captured.
            if (sidechainsOnly && renderer.hasSidechainsFor
                && !renderer.hasSidechainsFor([...seed])) {
                setStatus('Nothing selected has a side chain to measure from.');
                return;
            }
            setStatus(`Nothing else within ${cutoff} \u00c5 (${what}).`);
            return;
        }
        renderer.setResidueSelection(found);
        setStatus(`${added} more residue${added === 1 ? '' : 's'} within ${cutoff} \u00c5`
            + ` ${what} - ${found.size} selected.`);
    }

    // THE BACKBONE OF THE SELECTED RESIDUES. Not the same question as hiding
    // them: hiding takes the side chain too, and this leaves it. Stored on the
    // OBJECT beside `sidechains` and `bases`, and a pure DRAWING change - the
    // positions are all still there, so this is a repaint (the GPU recaptures,
    // because prims that are not built cannot be in a mesh).
    function setSelectionBackbone(positions, on) {
        const renderer = viewerApi?.renderer;
        if (!renderer || !renderer.setBackboneHiddenFor) return;
        if (!renderer.setBackboneHiddenFor(positions, !on)) return;
        renderer.render('selection backbone');
    }

    // VISIBILITY. Two things make this less obvious than it looks:
    // (1) visiblePositions is a SET of visible position indices, not a per-residue
    //     byte array, and null means "everything is visible";
    // (2) setVisibility OWNS it - it recomputes visiblePositions from the selection
    //     (viewer-mol.js) - so writing renderer.visiblePositions directly works
    //     until the next selection change silently undoes it.
    // So visibility is expressed as a selection, and set through setVisibility.
    function setSelectionVisible(positions, visible, exclusive) {
        const renderer = viewerApi?.renderer;
        if (!renderer || !renderer.coords) return;
        const n = renderer.coords.length;
        const inRange = positions.filter((i) => i >= 0 && i < n);
        let next;
        if (exclusive) {
            next = new Set(inRange);
        } else {
            const cur = renderer.visiblePositions;
            next = cur ? new Set(cur)
                : new Set(Array.from({ length: n }, (_, i) => i));
            for (const i of inRange) {
                if (visible) next.add(i); else next.delete(i);
            }
        }
        // Chains must be derived from the surviving positions, not left alone.
        // An empty chain set means "all chains" under the default mode but
        // "no chains" under explicit - so switching to explicit while leaving
        // chains empty made every chain label render as unselected even though
        // most of the structure was still visible.
        // BY (OBJECT, CHAIN) - see chainKeyAt. A bare id is chain A of every
        // object on screen, so hiding one object's chain A hid the other's.
        const chains = new Set();
        if (renderer.chains) {
            for (const i of next) {
                const c = renderer.chainKeyAt ? renderer.chainKeyAt(i) : renderer.chains[i];
                if (c) chains.add(c);
            }
        }
        renderer.setVisibility({ positions: next, chains, visibilityMode: 'explicit' });
        if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
        renderer.render('selection visibility');
    }

    // The restyling tools only mean anything with something selected, so the
    // panel they live in is hidden outright rather than shown inert. They are
    // disabled as well as hidden - a hidden control is still focusable by
    // keyboard, and `disabled` is what actually takes it out of the tab order.
    //
    // CLICK-SELECTION IS THE WEB APP'S. It is off in the renderer by default:
    // the Python path loads viewer-mol.js and the cartoon plugin and nothing
    // else, so a click there changed a selection with no strip to show it and
    // no panel to act on it. Turned on here, where both exist.
    if (viewerApi?.renderer) viewerApi.renderer.selectionEnabled = true;

    function updateSelectionToolsState() {
        const tools = document.getElementById('selectionTools');
        if (!tools) return;
        const picked = getActiveSelection();
        const none = picked === null;
        // THE PANEL IS THE STATE. It appears with a selection and goes away
        // without one, so there is never a row of controls that do nothing.
        // The old arrangement kept them visible but greyed, on the argument
        // that hiding them left no hint they existed - but they now live in
        // their own panel beside the structure, and a panel sliding in is a
        // louder cue than five buttons changing opacity in a header.
        const panel = document.getElementById('selectionPanel');
        if (panel) panel.hidden = none;
        // HOW MANY, AND ACROSS HOW MANY OBJECTS - and no more than that. The
        // count changes what pressing a button does, so it earns its place;
        // the residue ranges beside it ("A 11-13, 20-21; B 5, 7") did not. In
        // a 340px panel they were set small, ran past the edge of the head and
        // were cut short, and the tooltip that held the rest is not something
        // anybody hovers a header for. The strip below shows what is selected,
        // in the place made for showing it.
        const count = document.getElementById('selectionPanelCount');
        if (count) {
            if (none) {
                count.textContent = '';
                count.title = '';
            } else {
                const r = viewerApi?.renderer;
                const across = (r && r.objectsInSelection) ? r.objectsInSelection() : [];
                count.textContent = `${picked.length} residue${picked.length === 1 ? '' : 's'}`
                    + (across.length > 1 ? ` in ${across.length} objects` : '');
                count.title = '';
            }
        }
        // A contact is a line between a PAIR: nothing to draw for one residue or
        // for five, so the row is offered only for exactly two. Within it the
        // toggle's STATE says whether the pair is joined - which is what the
        // Add/Remove pair could only say by which of the two was showing.
        const contactRow = document.getElementById('contactRow');
        const pair = !none && picked.length === 2;
        if (contactRow) contactRow.hidden = !pair;
        if (pair) {
            const found = findContact(picked);
            const has = !!found;
            const swatch = document.getElementById('contactColorButton');
            // nothing to colour or size until there is a contact
            if (swatch) swatch.parentElement.hidden = !has;
            const wSlider = document.getElementById('contactWidthSlider');
            if (wSlider) {
                wSlider.hidden = !has;
                if (has) {
                    const entry = found.obj.contacts[found.i];
                    const w = entry && entry[contactSlots(entry).w];
                    wSlider.value = typeof w === 'number' ? w : 1;
                }
            }
        }
        syncSelectionToggles(picked, none);
        // The side-chain row is offered only when there is something to show:
        // glycine has no side chain, nor does any residue in a backbone-only
        // model, and a control that cannot do anything is worse than no
        // control. A NUCLEOTIDE HAS ONE NOW - its base, in the same table -
        // so the row appears for it too and its Plate option with it.
        const scRow = document.getElementById('sidechainRow');
        if (scRow) {
            const renderer = viewerApi?.renderer;
            // hasElementsFor, not hasSidechainsFor: it answers yes for every
            // residue with a side chain AND for a ligand atom that knows its
            // element, which is the other reason this row has something to do.
            scRow.hidden = none || !renderer || !renderer.hasElementsFor
                || !renderer.hasElementsFor(picked);
        }
        // Elements rides that same row rather than gating itself: it colours
        // the atoms the row draws, so wherever there are none it is already
        // gone with them.
        //
        // SSE on the same rule, from the protein side. Secondary structure is
        // a property of a protein backbone: a nucleotide is never assigned a
        // letter, so on a DNA or RNA selection this menu offered four states
        // and did nothing whichever was picked. It hides rather than
        // disabling, because the row it sits on is about the main chain and
        // stays useful - a greyed control there reads as something broken.
        // ...AND THE LINE ONLY MEANS ANYTHING WITH SOMETHING ABOVE IT. Both
        // property rows can go at once - a ligand takes the main chain row
        // away, and a selection with no elements to colour takes the other -
        // and a divider at the top of the panel is a rule under nothing.
        const divider = document.getElementById('selActionDivider');
        if (divider) {
            const scR = document.getElementById('sidechainRow');
            const mcR = document.getElementById('mainchainRow');
            divider.hidden = none
                || ((!scR || scR.hidden) && (!mcR || mcR.hidden));
        }
        const ssHide = document.getElementById('selSsSelect');
        if (ssHide) {
            const renderer = viewerApi?.renderer;
            ssHide.hidden = none || !renderer || !renderer.hasSseFor
                || !renderer.hasSseFor(picked);
            if (!ssHide.hidden) syncSseSelect(ssHide, renderer, picked);
        }
        tools.classList.toggle('disabled', none);
        // Also set the real disabled property, not just the class: hiding the
        // panel takes it off the screen but leaves its buttons in the tab
        // order, and `disabled` is what removes them from it.
        // INPUT is in that list because the +/- buttons became checkboxes: a
        // selector naming only buttons and selects stopped covering the show
        // toggles the moment they stopped being buttons.
        for (const el of tools.querySelectorAll('button, select, input')) el.disabled = none;
        // Unselect lives outside that group because it does not need a
        // selection to be discoverable - but it does need one to do anything,
        // so it follows the same state. Select all stays enabled either way.
        const unselectBtn = document.getElementById('clearAllResidues');
        if (unselectBtn) unselectBtn.disabled = none;
        // The swatches show the SELECTION's colour rather than the last colour
        // picked, so they are refreshed from the same place the enabled state
        // is and never go stale.
        if (window.refreshSelectionSwatches) window.refreshSelectionSwatches();
    }
    window.updateSelectionToolsState = updateSelectionToolsState;

    {
        const withSelection = (fn) => (e) => {
            if (e) e.preventDefault();
            const positions = getActiveSelection();
            if (!positions) return;
            fn(positions);
        };

        // COLOUR: a grid of PyMOL's named colours rather than an OS colour
        // picker, so the choices are the ones a PyMOL user already knows by
        // name. Built from the table viewer-mol.js exports.
        //
        // ONE implementation, two pickers - main chain and side chains colour
        // independently, and a second copy of this would drift from the first.
        // `apply` says where the colour goes; `current` says what the swatch
        // should show.
        const colorPickers = [];
        const wireColorPicker = ({ btnId, menuId, swatchId, apply, current }) => {
            const btn = document.getElementById(btnId);
            const menu = document.getElementById(menuId);
            const swatch = document.getElementById(swatchId);
            if (!btn || !menu) return;
            // Rebuilt each time the menu opens: the palette is the CHAIN colour
            // set, which swaps wholesale with colourblind mode.
            const buildSwatches = () => {
                menu.textContent = '';
                // AUTO: clears the override so the residues fall back to whatever
                // the colour mode says - chain, rainbow, pLDDT, SS palette. Not a
                // colour, so it gets its own row rather than a swatch that would
                // have to pretend to be one.
                const autoRow = document.createElement('div');
                autoRow.className = 'selection-color-row';
                const autoBtn = document.createElement('button');
                autoBtn.type = 'button';
                autoBtn.className = 'selection-color-auto';
                autoBtn.textContent = 'Auto (default colour)';
                autoBtn.title = 'Remove the colour override and follow the colour mode';
                autoBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    menu.hidden = true;
                    const positions = getActiveSelection();
                    if (positions) apply(positions, null);
                    refresh();
                });
                autoRow.appendChild(autoBtn);
                menu.appendChild(autoRow);

                const groups = (window.py2dmol_paletteColors
                    ? window.py2dmol_paletteColors(!!viewerApi?.renderer?.colorblindMode)
                    : []);
                for (const group of groups) {
                    const row = document.createElement('div');
                    row.className = 'selection-color-row';
                    for (const hex of group) {
                        const cell = document.createElement('button');
                        cell.type = 'button';
                        cell.className = 'selection-color-cell';
                        cell.style.background = hex;
                        cell.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            menu.hidden = true;
                            const positions = getActiveSelection();
                            if (positions) apply(positions, hex);
                            refresh();
                        });
                        row.appendChild(cell);
                    }
                    menu.appendChild(row);
                }
            };
            // THE SWATCH SHOWS THE SELECTION, not the last colour picked. A
            // remembered colour is a statement about the tool; what you want to
            // know when you click a residue is what colour THAT residue is. A
            // mixed selection shows the first, since one square cannot show two.
            const refresh = () => {
                if (!swatch) return;
                const positions = getActiveSelection();
                const hex = positions && positions.length ? current(positions) : null;
                swatch.style.background = hex || 'transparent';
                swatch.classList.toggle('is-empty', !hex);
            };
            buildSwatches();
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // rebuilt on open: the chain palette swaps with colourblind mode
                buildSwatches();
                const wasHidden = menu.hidden;
                // only one grid open at a time - two overlapping popups in a
                // 340px panel is unreadable
                for (const other of document.querySelectorAll('.selection-color-menu')) {
                    other.hidden = true;
                }
                menu.hidden = !wasHidden;
            });
            document.addEventListener('click', (e) => {
                if (!menu.hidden && !menu.contains(e.target)
                    && e.target !== btn && !btn.contains(e.target)) {
                    menu.hidden = true;
                }
            });
            colorPickers.push(refresh);
            refresh();
        };

        // What colour a residue is RIGHT NOW, as the renderer resolves it -
        // override, colour mode, palette and all - so the swatch matches the
        // pixels rather than a setting.
        const rgbToHex = (c) => (c && c.r !== undefined)
            ? '#' + [c.r, c.g, c.b].map((v) => {
                const n = Math.max(0, Math.min(255, Math.round(v > 1 ? v : v * 255)));
                return n.toString(16).padStart(2, '0');
            }).join('')
            : null;
        const mainChainColorOf = (positions) => {
            const renderer = viewerApi?.renderer;
            if (!renderer || !renderer.getAtomColor) return null;
            return rgbToHex(renderer.getAtomColor(positions[0]));
        };

        wireColorPicker({
            btnId: 'selColorButton', menuId: 'selColorMenu', swatchId: 'selColorSwatch',
            apply: setSelectionColor, current: mainChainColorOf,
        });
        wireColorPicker({
            btnId: 'scColorButton', menuId: 'scColorMenu', swatchId: 'scColorSwatch',
            // ON A LIGAND ROW THIS IS THE LIGAND'S COLOUR. A side-chain colour
            // is stored against the OWNING residue, and a ligand atom has none
            // - so the side-chain path silently does nothing there, which is
            // what a swatch on that row would have looked like. The ordinary
            // per-position colour is the one that means anything for a ligand.
            apply: (positions, hex) => {
                const lig = ligandRowPositions(positions);
                if (lig) setSelectionColor(lig, hex);
                else setSelectionSidechainColor(positions, hex);
            },
            // an unset side chain follows its residue, so that is what it shows
            current: (positions) => {
                const renderer = viewerApi?.renderer;
                const lig = ligandRowPositions(positions);
                if (lig) return mainChainColorOf(lig);
                // ...from the object that OWNS the residue, in its own
                // numbering: the map is per object and the index is merged.
                const o = renderer?.ownerOf ? renderer.ownerOf(positions[0]) : null;
                const obj = renderer?.objectsData?.[
                    o ? o.name : renderer.currentObjectName];
                const at = o ? o.local : positions[0];
                const own = obj && obj.sidechainColor && obj.sidechainColor[at];
                return own || mainChainColorOf(positions);
            },
        });
        wireColorPicker({
            btnId: 'contactColorButton', menuId: 'contactColorMenu',
            swatchId: 'contactColorSwatch',
            apply: setSelectionContactColor,
            // a contact with no colour of its own draws in the default yellow,
            // so that is what the swatch shows rather than nothing
            current: (positions) => {
                const found = findContact(positions);
                if (!found) return null;
                const c = found.obj.contacts[found.i];
                const col = c && c[contactSlots(c).col];
                return (col && col.r !== undefined)
                    ? rgbToHex(col) : '#ffff00';
            },
        });
        window.refreshSelectionSwatches = () => { for (const f of colorPickers) f(); };

        const ssSelect = document.getElementById('selSsSelect');
        if (ssSelect) {
            ssSelect.addEventListener('change', withSelection((positions) => {
                const v = ssSelect.value;
                // DSSP is the one that UNFORCES: null takes the override off
                // and the assignment decides again.
                if (v) setSelectionSse(positions, v === 'dssp' ? null : v);
                // ...and then the menu is read back off the structure, like
                // every other control here, rather than reset to a placeholder
                updateSelectionToolsState();
            }));
        }
        const on = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', withSelection(fn));
        };
        // ONE visibility button. Which way it goes is read off the structure,
        // not remembered: if any of the selection is currently hidden the press
        // shows it, otherwise it hides it. That makes "show what I picked" the
        // behaviour for a selection that is partly hidden, which is what a user
        // reaching for this after a Hide actually wants.
        {
            const ws = document.getElementById('contactWidthSlider');
            if (ws) {
                // `input`, not `change`: the contact should follow the drag.
                // Redrawing per event is affordable here - one contact is a
                // handful of prims - where a residue-level control would not be.
                ws.addEventListener('input', () => {
                    const positions = getActiveSelection();
                    if (positions) setSelectionContactWidth(positions, +ws.value);
                });
            }
        }
        // A TOGGLE CARRIES ITS OWN DIRECTION. `on` fires on click and the
        // handler decided the direction; these fire on change and take it from
        // the box, so the control and what it does cannot disagree.
        //
        // A MIXED selection - some of it has the thing, some does not - is
        // shown indeterminate, and the browser's first click on an
        // indeterminate box checks it. So the click resolves the mixture by
        // turning everything ON, which is the useful direction: it is what
        // "show what I picked" means when half of it already is.
        const onToggle = (id, fn) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', withSelection((positions) => {
                fn(positions, el.checked);
                // ...and re-read the state from the structure, not from the
                // box: an action can be refused (no side-chain atoms, base
                // plates switched off globally) and the toggle must then go
                // back to what is actually drawn rather than sit on a lie.
                updateSelectionToolsState();
            }));
        };
        onToggle('elementsShowToggle', (p2, v) => setSelectionElements(p2, v));
        onToggle('mainchainShowToggle', (p2, v) => {
            setSelectionBackbone(p2, v);
            syncSelectionVisibility(p2);
        });
        // FIND INTERACTIONS: one button, no settings. 5 A side chain to side
        // chain is the question people actually ask of a binding site, and the
        // any-atom half of the pair it replaces was mostly backbone running
        // past whatever it folds against.
        const nearBtn = document.getElementById('selectNearby');
        if (nearBtn) {
            nearBtn.addEventListener('click', (e) => {
                e.preventDefault();
                selectNearby(INTERACTION_CUTOFF_A, true);
            });
        }
        // the protein form of the same control: two states, one switch - and on
        // a ligand row the same switch draws the ligand itself, which is the
        // visibility mask rather than a side chain nothing there owns
        onToggle('sidechainShowToggle', (p2, v) => {
            const lig = ligandRowPositions(p2);
            if (lig) { setSelectionVisible(lig, v, false); return; }
            // SHOW MEANS "DRAWN", AND THE MENU SAYS HOW. Switching on a
            // nucleotide brings back whichever way it was last drawn - the
            // plate unless the menu says otherwise - rather than jumping to the
            // atoms, which is not what a plain Show should decide.
            const r = viewerApi?.renderer;
            const plate = document.getElementById('plateShowToggle');
            const nuc = !!(r && r.hasBasesFor && r.hasBasesFor(p2));
            const style = nuc ? ((plate && !plate.checked) ? 'full' : 'plate') : 'full';
            setSelectionSidechainMode(p2, v ? style : 'none');
        });
        // PLATE OR ATOMS, for a nucleotide that is being drawn at all. Show
        // owns whether; this owns which.
        onToggle('plateShowToggle', (p2, v) => {
            setSelectionSidechainMode(p2, v ? 'plate' : 'full');
        });
        onToggle('contactShowToggle', (p2, v) => (v
            ? addSelectionContact(p2) : removeSelectionContact(p2)));

        // Every surface that draws the selection listens here, so a change made
        // on ANY of them shows on all the others. The sequence strip used to be
        // missing: it redrew itself when IT cleared the selection, so clearing
        // from the 3D canvas left its yellow box behind.
        document.addEventListener('py2dmol-residue-selection-change', () => {
            updateSelectionToolsState();
            // the selection is outlined by the renderer's own ink pass, so the
            // structure has to be redrawn when the selection changes
            if (viewerApi?.renderer) viewerApi.renderer.render('selection outline');
            // the strip draws the yellow box round the selected run
            if (window.SEQ?.updateColors) window.SEQ.updateColors();
            // the MSA dims to the selection, so it follows the same signal
            applySelectionToMSA();
        });
        updateSelectionToolsState();
    }

    // Select all / Unselect act on the SELECTION, not on visibility. Visibility
    // is still reachable - Select all then Show - but it is no longer a
    // separate pair of controls, which kept implying that selecting and showing
    // were the same act.
    const setWholeSelection = (all) => {
        const renderer = viewerApi?.renderer;
        if (!renderer || !renderer.coords) return;
        if (all) {
            const s = new Set();
            for (let i = 0; i < renderer.coords.length; i++) s.add(i);
            renderer.residueSelection = s;
        } else {
            renderer.residueSelection = null;
        }
        document.dispatchEvent(new CustomEvent('py2dmol-residue-selection-change'));
        if (window.SEQ?.updateColors) window.SEQ.updateColors();
        renderer.render(all ? 'select all' : 'unselect');
    };
    if (selectAllBtn) selectAllBtn.addEventListener('click', (e) => { e.preventDefault(); setWholeSelection(true); });
    if (clearAllBtn) clearAllBtn.addEventListener('click', (e) => { e.preventDefault(); setWholeSelection(false); });

    // INVERT: everything that is not selected now.
    //
    // Over what is on screen, not over every position the object holds - a
    // residue the clip has cut away or a chain that is hidden is not something
    // the viewer is offering, and sweeping it into the selection by pressing a
    // button is how a selection comes to contain things nobody can see. With
    // nothing selected this is Select all, which is the sensible reading of
    // "invert nothing".
    const invertBtn = document.getElementById('invertSelection');
    if (invertBtn) {
        invertBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const renderer = viewerApi?.renderer;
            if (!renderer || !renderer.coords) return;
            const cur = renderer.residueSelection;
            const visible = renderer.visiblePositions;
            const next = new Set();
            for (let i = 0; i < renderer.coords.length; i++) {
                if (cur && cur.has(i)) continue;
                if (visible && !visible.has(i)) continue;
                if (renderer._pickable && !renderer._pickable(i)) continue;
                next.add(i);
            }
            renderer.setResidueSelection(next);
            if (window.SEQ?.updateColors) window.SEQ.updateColors();
            renderer.render('invert selection');
        });
    }

    // Update copy selection button state when selection changes
    // Copy's enabled state is handled with the rest of the selection tools
    // (updateSelectionToolsState): it acts on the selection like they do. It
    // used to have its own rule - enabled only when the selection was a PARTIAL
    // subset of the visible set - which was a Show-mode notion and, kept
    // alongside the group's state, would have fought it and left Copy stuck.

    // Clear all objects button
    const clearAllButton = document.getElementById('clearAllButton');
    if (clearAllButton) {
        clearAllButton.addEventListener('click', (e) => {
            e.preventDefault();
            clearAllObjects();
        });
    }


    // Listen for the custom event dispatched by the renderer when color settings change
    // the strip's header names the frame, so it follows the frame
    document.addEventListener('py2dmol-frame-change', updateFrameNameLabel);
    document.addEventListener('py2dmol-color-change', () => {
        // Update colors in sequence view when color mode changes
        window.SEQ?.updateColors();
        window.SEQ?.updateSelection();
        // Update PAE viewer colors when color mode changes
        if (viewerApi?.renderer?.paeRenderer) {
            viewerApi.renderer.paeRenderer.render();
        }
    });

    // Listen for selection changes (including PAE selections)
    document.addEventListener('py2dmol-visibility-change', (e) => {
        // Sync chain pills with selection model
        syncChainPillsToSelection();
        // Update sequence view
        window.SEQ?.updateSelection();
        // Update MSA selection mapping and view
        applySelectionToMSA();
    });

    // Update navigation button states
    updateObjectNavigationButtons();
}

// ============================================================================
// UI HELPER FUNCTIONS
// ============================================================================

// WHICH STEP THE LOAD IS ON - and nothing more precise than that.
//
// There was a percentage here, weighted per stage and driven by the parser's
// real position in the file. It was honest and it was not worth its keep: the
// weights were guesses for every structure except the one they were measured
// on, and a number that jumps 20% and then sits still tells you less than the
// word "Building positions" does.
//
// The reporting exists at all only because the loader runs in slices - without
// a yield there is no moment between "started" and "finished" at which the
// browser could paint anything, and the line would never change.
//
// Nothing is shown for a load that finishes quickly. A word that flashes up and
// vanishes reads as a glitch, and under this it is most loads.
const STAGE_REVEAL_MS = 250;
let stageShown = 0;
// Set when a load has to change the style out from under the user; see
// dropToTubeIfCartoonWontFit.
let styleFallbackNote = '';
let stageRevealTimer = 0;
let stageLabel = '';

function beginProgress() {
    // ...and take it off the screen with it. The note is sticky so the messages
    // that follow it in ITS load cannot bury it; leaving it up through the next
    // load would have it describing a structure that is no longer there - and a
    // quick load writes nothing over it, so nothing else would clear it.
    if (styleFallbackNote) {
        const el = document.getElementById('status-message');
        if (el && el.textContent.indexOf(styleFallbackNote) >= 0) el.textContent = '';
    }
    styleFallbackNote = '';
    stageLabel = '';
    stageShown = 0;
    if (stageRevealTimer) clearTimeout(stageRevealTimer);
    stageRevealTimer = setTimeout(() => {
        stageRevealTimer = 0;
        stageShown = 1;
        paintStage();
    }, STAGE_REVEAL_MS);
}

function paintStage() {
    if (!stageShown || !stageLabel) return;
    setStatus(`${stageLabel}...`);
}

/** Name the step the load has reached. Repeats are free. */
function setStage(label) {
    if (!label || label === stageLabel) return;
    stageLabel = label;
    paintStage();
}

function endProgress(silent = false) {
    if (stageRevealTimer) { clearTimeout(stageRevealTimer); stageRevealTimer = 0; }
    const wasShowing = stageShown && stageLabel;
    stageShown = 0;
    stageLabel = '';
    // THE LAST STEP MUST NOT BE THE LAST WORD. The final stage - setCoords and
    // the first render - runs with the main thread pinned, so the last thing
    // painted is whatever step had been reached before it started. Not every
    // caller writes its own result line afterwards, and the ones that do write
    // it after this returns, so leaving "Drawing..." on screen would strand a
    // finished load looking stuck. silent is for setStatus, which is about to
    // write the real message itself.
    if (wasShowing && !silent) setStatus('Loaded.');
}


function setStatus(message, isError = false) {
    // A LOAD THAT FAILED IS A LOAD THAT ENDED. Every failure path in the
    // loader reports through here, so this is the one place that reliably
    // catches them all - without it a later slice's percentage overwrites the
    // error message with a claim that the load is still going.
    if (isError && typeof endProgress === 'function') endProgress(true);
    // Check if we're on msa.html (has status-message with different styling) or index.html
    if (styleFallbackNote && !isError) {
        message = message ? `${message} ${styleFallbackNote}` : styleFallbackNote;
    }
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
            statusElementIndex.className = `mt-4 text-sm font-medium ${isError ? 'text-red-700 bg-red-100 border-red-200' : 'text-blue-700 bg-blue-50 border-blue-200'
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


// ============================================================================
// THE OBJECT LIST
// ============================================================================
// ONE QUESTION: which objects are on screen.
//
// ONE OBJECT AT A TIME IS THE RESTING STATE, chosen with the dropdown in the
// sequence header - which is how the viewer has always worked, and loading a
// second file must not change it. Showing several is something the user asks
// for: press All, or light an eye in the list. All is literal - every object
// on, or every object off, and an empty canvas is a picture you are allowed to
// ask for.
//
// The list used to answer a second question too - which object is CURRENT, the
// one Copy, Delete, the side-chain toggles and the sequence strip act on - and
// with the shown set meaning "the current object", picking one in the list took
// the other off the screen: "when I click one it hides the other". That
// question belongs to the picker, where the thing it governs is visible.

function objectListEls() {
    return {
        btn: document.getElementById('objectListButton'),
        list: document.getElementById('objectList'),
        select: document.getElementById('objectSelect'),
    };
}

/** Which objects are drawn right now, as a Set the rows can be built from. */
function shownObjectSet(renderer) {
    return new Set(renderer.drawnObjects ? renderer.drawnObjects() : []);
}

/**
 * The Object colour mode is only offered when there is more than one object on
 * screen. With one, it colours everything the same - a scheme with no meaning,
 * which is worse than an absent one. Switched back to Auto if it was showing
 * when the second object went away.
 */
function syncObjectColorOption() {
    const renderer = viewerApi?.renderer;
    const sel = document.getElementById('colorSelect');
    if (!renderer || !sel) return;
    const opt = sel.querySelector('option[value="object"]');
    if (!opt) return;
    const many = (renderer.drawnObjects ? renderer.drawnObjects().length : 1) > 1;
    opt.hidden = !many;
    if (!many && sel.value === 'object') {
        sel.value = 'auto';
        sel.dispatchEvent(new Event('change'));
    }
}

/**
 * IS THE VIEWER IN MULTI MODE? The renderer's shown set answers it: null is
 * the resting state - one object on screen, the one the picker names, which is
 * how this viewer has always worked - and a Set is Multi, whatever is in it.
 * Nothing else records the mode, so it cannot disagree with the picture, and a
 * restored session comes back in the mode it was saved in.
 */
function objectMultiOn(renderer) {
    const r = renderer || viewerApi?.renderer;
    return !!(r && r.shownObjects instanceof Set);
}

/**
 * The button is a MODE, not a menu: pressed means Multi. The count is in the
 * list below it, which is open whenever Multi is on, so the face stays the one
 * word.
 */
function syncObjectListButton() {
    const { btn, list, select } = objectListEls();
    const renderer = viewerApi?.renderer;
    if (!btn || !renderer) return;
    const on = objectMultiOn(renderer);
    const total = Object.keys(renderer.objectsData || {}).length;
    const shown = renderer.drawnObjects ? renderer.drawnObjects().length : 1;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-on', on);
    btn.title = on
        ? `${shown} of ${total} objects on screen - click to go back to one`
        : 'Show several objects at once';
    if (list) list.hidden = !on;
    // THE PICKER IS THE OTHER MODE'S CONTROL. With several objects on screen
    // the eyes say what is drawn and clicking in the sequence strip says what
    // is edited, so a picker that still named one object would be claiming a
    // job it no longer has.
    if (select) {
        select.disabled = on;
        select.title = on
            ? 'In Multi the eyes choose what is on screen; click in the sequence to choose what you are editing'
            : 'Which object to show and edit';
    }
}

function renderObjectList() {
    const { btn, list } = objectListEls();
    const renderer = viewerApi?.renderer;
    if (!list || !btn || !renderer) return;
    syncObjectListButton();
    if (list.hidden) return;

    const names = Object.keys(renderer.objectsData || {});
    const shown = shownObjectSet(renderer);
    list.innerHTML = '';

    for (const name of names) {
        const on = shown.has(name);
        const row = document.createElement('div');
        row.className = 'object-list-row' + (on ? '' : ' is-hidden');
        row.title = on ? 'Hide this object' : 'Show this object';

        const eye = document.createElement('span');
        eye.className = 'object-list-eye';
        eye.innerHTML = on
            ? '<i class="fa-regular fa-eye"></i>'
            : '<i class="fa-regular fa-eye-slash"></i>';

        const label = document.createElement('span');
        label.className = 'object-list-name';
        label.textContent = name;

        // ONLY THE EYE SWITCHES IT. The name is a name: with the picker gone
        // from this list, a row that toggled anywhere along its length was one
        // stray click away from taking a structure off the screen.
        eye.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleObjectShown(name);
        });

        row.appendChild(eye);
        row.appendChild(label);
        list.appendChild(row);
    }
}

/**
 * WHAT FOLLOWS A CHANGE TO WHAT IS ON SCREEN.
 *
 * The strip is one section per drawn object, so it is rebuilt - it is not a
 * repaint: the sections, their rows and their cells all change. The colour
 * mode, the button and the picker follow too.
 */
function afterShownObjectsChange() {
    syncObjectColorOption();
    syncObjectListButton();
    renderObjectList();
    const seq = window.SEQ;
    if (seq && (seq.buildViewDeferred || seq.buildView)) {
        (seq.buildViewDeferred || seq.buildView)();
    }
    updateFrameNameLabel();
}

/** Show or hide one object. Only reachable in Multi, where the eyes decide. */
function toggleObjectShown(name) {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.setShownObjects) return;
    const shown = shownObjectSet(renderer);
    if (shown.has(name)) shown.delete(name);
    else shown.add(name);
    // ...including down to nothing: an empty list is an empty canvas, and the
    // objects are all still there to be switched back on.
    renderer.setShownObjects(Array.from(shown));
    afterShownObjectsChange();
}

/**
 * MULTI ON AND OFF.
 *
 * On, it opens on exactly what was already on screen - the object the picker
 * names - so pressing the button changes the picture not at all until an eye
 * is clicked. Off, the shown set is dropped entirely rather than trimmed to
 * one name: null is the resting state, and an object loaded later becomes the
 * one on screen the way it always did.
 */
function toggleObjectMulti() {
    const renderer = viewerApi?.renderer;
    if (!renderer || !renderer.setShownObjects) return;
    if (objectMultiOn(renderer)) {
        renderer.setShownObjects(null);
    } else {
        const cur = renderer.currentObjectName;
        renderer.setShownObjects(cur ? [cur] : []);
    }
    afterShownObjectsChange();
}

function attachObjectList() {
    const { btn, select } = objectListEls();
    if (!btn || !select) return;
    btn.addEventListener('click', toggleObjectMulti);
    // WHAT IS ON SCREEN CAN CHANGE WITHOUT A CLICK IN THIS LIST - a restored
    // session, a Copy, the Python API - and so can which object is being
    // edited. Both labels follow the renderer rather than the buttons.
    document.addEventListener('py2dmol-color-change', () => {
        syncObjectColorOption();
        syncObjectListButton();
        // ...and the rows themselves, which show which objects are on screen
        renderObjectList();
        updateFrameNameLabel();
    });
    // OBJECTS ARE ADDED, RENAMED AND REMOVED FROM A DOZEN PLACES - a load, a
    // Copy, a Cut, a session restore - and every one of them goes through the
    // select's options. Watching those is one hook instead of a dozen, and it
    // cannot be forgotten by the next path that adds an object.
    if (typeof MutationObserver === 'function') {
        new MutationObserver(() => renderObjectList())
            .observe(select, { childList: true });
    }
    select.addEventListener('change', () => renderObjectList());
}

function handleObjectChange() {
    // a different object is a different set of frames, and frame 0 of the new
    // one may be the same INDEX as the old - so no frame-change event fires
    setTimeout(updateFrameNameLabel, 0);
    // ...and a different object has its own clip, which the panel has to show
    setTimeout(syncClipPanelToObject, 0);
    const objectSelect = document.getElementById('objectSelect');

    const selectedObject = objectSelect.value;
    if (!selectedObject) return;

    // Selection state is now managed per-object in the renderer's objectSelect change handler
    // Each object maintains its own selection state that is saved/restored automatically
    // No need to reset here - the renderer handles it

    // Sync MSA data from pendingObjects to renderer's objectsData if needed
    // This ensures MSA data is available even if it was added after initial load
    if (viewerApi?.renderer) {
        const pendingObj = pendingObjects.find(obj => obj.name === selectedObject);
        const rendererObj = viewerApi.renderer.objectsData[selectedObject];
        if (pendingObj && pendingObj.msa && rendererObj && !rendererObj.msa) {
            rendererObj.msa = pendingObj.msa;
        }
    }

    // After MSA is synced, remap entropy if MSA data now exists
    if (viewerApi?.renderer && selectedObject) {
        const rendererObj = viewerApi.renderer.objectsData[selectedObject];
        if (rendererObj && rendererObj.msa && rendererObj.msa.msasBySequence && rendererObj.msa.chainToSequence) {
            if (selectedObject && window.MSA) {
                // ...for everything DRAWN - see entropyForDrawn
                viewerApi.renderer.entropy = viewerApi.renderer.entropyForDrawn
                    ? viewerApi.renderer.entropyForDrawn()
                    : window.MSA.mapEntropyToStructure(rendererObj, viewerApi.renderer.currentFrame >= 0 ? viewerApi.renderer.currentFrame : 0);
                if (viewerApi.renderer._updateEntropyOptionVisibility) viewerApi.renderer._updateEntropyOptionVisibility();
            }
        }
    }

    if (viewerApi?.renderer && typeof viewerApi.renderer.updatePAEContainerVisibility === 'function') {
        viewerApi.renderer.updatePAEContainerVisibility();
    }

    // Clear preview selection when switching objects
    if (window.SEQ?.clearPreview) window.SEQ.clearPreview();

    // Rebuild sequence view for the new object
    window.SEQ?.buildView();
    // (no defaulting here — renderer already restored the object's saved selection)

    // Update MSA chain selector and container visibility for index.html
    if (window.updateMSAChainSelectorIndex) {
        window.updateMSAChainSelectorIndex();
    }
    if (window.updateMSAContainerVisibility) {
        window.updateMSAContainerVisibility();
    }

    refreshEntropyColors();
}




// ============================================================================
// BEST VIEW ROTATION ANIMATION
// ============================================================================

// PyMOL's clip, as ONE control: two handles on a single track, Far on the left
// and Near on the right. They cannot cross - the renderer keeps them half an
// Angstrom apart - so the range always names a slab that exists.
//
// The travel is the structure's reach plus half of it at either end, so a
// handle can be pushed right through (drawing nothing, a legible mistake) or
// pulled clear of it (cutting nothing).
// The RANGE is what this object can span - its rest state, which is the reach
// of the structure - and the VALUES are where the planes currently are. Taking
// the range from the current slab instead shrinks the track every time it is
// refilled: after switching away from a clipped object and back, the handles
// could not be pulled out past the cut they were already at.
// THE TRACK IS THE STRUCTURE'S DEPTH IN THIS VIEW, so moving a knob cuts
// something straight away. The ENDS mean off - a knob at its limit stores the
// rest state (a radius) rather than this number, so parking it there cuts
// nothing however the structure is then turned. See clipViewExtent.
function fillClipPanel() {
    const r = viewerApi?.renderer;
    if (!r) return;
    const view = r.clipViewExtent();
    const rest = r.clipSlabDefault();
    if (!view || !rest) return;
    const span = view.near - view.far;
    const lo = view.far;
    const hi = view.near;
    const at = { clipNear: r.clipSlabOn() ? r.clipNear : rest.near,
        clipFar: r.clipSlabOn() ? r.clipFar : rest.far };
    for (const id of ['clipNear', 'clipFar']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.min = lo.toFixed(2);
        el.max = hi.toFixed(2);
        el.step = Math.max(0.05, span / 400).toFixed(3);
        // a plane parked beyond the structure shows as a knob at the end
        el.value = Math.max(lo, Math.min(hi, at[id])).toFixed(2);
    }
    // ...and the soft edge, which rides with the object like the planes do
    // the control is a PERCENTAGE and the renderer a fraction; one conversion,
    // here and at the listener, rather than a slider reading 0.15
    const fade = document.getElementById('clipFadeSlider');
    if (fade) {
        fade.value = String(Math.round(
            100 * (typeof r.clipFade === 'number' ? r.clipFade : 0)));
    }
    syncFadeEnabled();
    showClipValues();
}

// A SOFT EDGE NEEDS AN EDGE. Clip opens with both planes parked at the rest
// state - a radius, which holds the whole structure from any angle - so nothing
// is outside the slab and a fade has nothing to fade: the knob moved and the
// picture did not, which reads as a broken control rather than as an honest
// nothing. It stays disabled until a plane is actually cutting.
function clipCuts() {
    const r = viewerApi?.renderer;
    if (!r || !r.clipSlabOn()) return false;
    const view = r.clipViewExtent();
    if (!view) return false;
    const EPS = 1e-6;
    return r.clipNear < view.near - EPS || r.clipFar > view.far + EPS;
}

function syncFadeEnabled() {
    const fade = document.getElementById('clipFadeSlider');
    if (!fade) return;
    const dead = !clipCuts();
    fade.disabled = dead;
    fade.style.opacity = dead ? '0.4' : '';
    fade.title = dead
        ? 'Nothing is being clipped yet - move a knob in, and Fade softens the cut'
        : 'Soft edge: how far outside each plane the drawing fades out instead of '
            + 'stopping. 0 is a hard cut.';
}

// The blue bar between the knobs. No figures beside it: where the knobs are is
// the answer, and Angstrom along the camera's own depth is not a number anyone
// reads off a slider.
function showClipValues() {
    const r = viewerApi?.renderer;
    if (!r) return;
    const bar = document.getElementById('clipSpan');
    const near = document.getElementById('clipNear');
    const far = document.getElementById('clipFar');
    if (!bar || !near || !far || !r.clipSlabOn()) return;
    const lo = parseFloat(near.min); const hi = parseFloat(near.max);
    const at = (v) => Math.max(0, Math.min(100, 100 * (v - lo) / Math.max(1e-6, hi - lo)));
    // from the KNOBS, which are clamped into the track - a plane parked out at
    // the rest state belongs at the end of the bar, not off it
    const l = at(parseFloat(far.value));
    const rgt = at(parseFloat(near.value));
    bar.style.left = l.toFixed(2) + '%';
    bar.style.width = Math.max(0, rgt - l).toFixed(2) + '%';
}

// THE PANEL FOLLOWS THE OBJECT. The slab rides with the object (see
// _switchToObject in viewer-mol.js), so switching shows the new object's own
// clip - and an object that has never been clipped gets the rest state, which
// cuts nothing, rather than the previous object's Angstrom.
function syncClipPanelToObject() {
    const panel = document.getElementById('clipPanel');
    const cb = document.getElementById('clipCheckbox');
    const r = viewerApi?.renderer;
    if (!r || !cb || !panel || panel.hidden) return;
    const slab = r.clipSlabOn()
        ? { near: r.clipNear, far: r.clipFar }
        : r.clipSlabDefault();
    if (!slab) { cb.checked = false; panel.hidden = true; r.clipEditing = false; return; }
    r.clipEditing = true;
    r.setClipSlab(slab.near, slab.far);
    fillClipPanel();
}

function setupClipPanel() {
    const cb = document.getElementById('clipCheckbox');
    const panel = document.getElementById('clipPanel');
    if (!cb) return;
    const push = () => {
        const r = viewerApi?.renderer;
        const near = document.getElementById('clipNear');
        const far = document.getElementById('clipFar');
        if (!r || !near || !far) return;
        // A KNOB AT ITS END MEANS NO PLANE ON THAT SIDE. The track spans what
        // is in front of you now; the rest state spans the structure from any
        // angle. Storing the track's end would mean a slab tight to this view,
        // which starts cutting the moment you turn - the fault that put the
        // rest state on a radius in the first place.
        const rest = r.clipSlabDefault() || { near: parseFloat(near.value), far: parseFloat(far.value) };
        // WITHIN ONE STEP OF THE END IS AT THE END. The value is quantised to
        // the step, so a knob dragged all the way to the right lands on 12.637
        // against a maximum of 12.65 and an exact test never fires - which put
        // the plane a step inside the structure and started cutting the moment
        // it was turned.
        const step = parseFloat(near.step) || 0;
        const nz = parseFloat(near.value) >= parseFloat(near.max) - step
            ? rest.near : parseFloat(near.value);
        const fz = parseFloat(far.value) <= parseFloat(far.min) + step
            ? rest.far : parseFloat(far.value);
        r.setClipSlab(nz, fz);
        // the renderer keeps the two apart rather than letting them cross, so
        // read back what it took - clamped into the track, since a plane parked
        // out at the rest state has no position on it
        near.value = Math.max(parseFloat(near.min),
            Math.min(parseFloat(near.max), r.clipNear)).toFixed(2);
        far.value = Math.max(parseFloat(far.min),
            Math.min(parseFloat(far.max), r.clipFar)).toFixed(2);
        syncFadeEnabled();
        showClipValues();
    };
    for (const id of ['clipNear', 'clipFar']) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', push);
    }
    // THE SOFT EDGE IS A FRACTION OF THE SLAB, not an Angstrom count: the same
    // setting then reads the same on a peptide and on a ribosome, and it does
    // not have to be re-set every time the planes move.
    const fadeEl = document.getElementById('clipFadeSlider');
    if (fadeEl) {
        fadeEl.addEventListener('input', () => {
            const r = viewerApi?.renderer;
            if (r && r.setClipFade) r.setClipFade(parseFloat(fadeEl.value) / 100);
        });
    }
    // AUTO: THE SLAB THE SELECTION ASKS FOR, and the rest state when there is
    // no selection to ask. It replaces Reset rather than joining it - with
    // nothing picked the two are the same answer, and a cut is nearly always
    // wanted around something rather than at a depth chosen by dragging.
    const auto = document.getElementById('clipAutoButton');
    if (auto) {
        auto.addEventListener('click', (e) => {
            e.preventDefault();
            const r = viewerApi?.renderer;
            if (!r || !r.autoClip) return;
            // ...and it KEEPS the slab on the selection as the model turns -
            // see _refreshAutoClip. Pressing it again at another angle used to
            // give a different answer, because the cut had stayed where the
            // selection had been.
            if (!r.autoClip()) return;
            fillClipPanel();
        });
    }
    // THE BUTTON PUTS THE PANEL AWAY, IT DOES NOT UNDO THE CUT. Switching Clip
    // off leaves the slab where it was set - which is the point of setting it.
    cb.addEventListener('change', () => {
        const r = viewerApi?.renderer;
        if (!r || !r.setClipSlab) { cb.checked = false; return; }
        if (!cb.checked) {
            r.clipEditing = false;
            if (panel) panel.hidden = true;
            return;
        }
        // A slab needs something to cut: with nothing loaded the renderer has
        // no reach to offer, and the control must not claim otherwise.
        const slab = r.clipSlabOn()
            ? { near: r.clipNear, far: r.clipFar }     // reopening: as it was left
            : r.clipSlabDefault();
        if (!slab) { cb.checked = false; return; }
        r.clipEditing = true;
        r.setClipSlab(slab.near, slab.far);
        if (panel) panel.hidden = false;
        fillClipPanel();
    });
}

// WHICH FILE THE CURRENT FRAME CAME FROM, in the sequence strip's header.
// Frames carry a name only when they were loaded from separate files (or from a
// multi-model file); anything else leaves the label empty rather than inventing
// one.
function updateFrameNameLabel() {
    const el = document.getElementById('frameNameLabel');
    if (!el) return;
    const r = viewerApi?.renderer;
    const obj = r && r.objectsData ? r.objectsData[r.currentObjectName] : null;
    const frames = obj && obj.frames;
    if (!frames || !frames.length) { el.textContent = ''; return; }
    // ...and only where there is more than one FRAME, since for a single
    // structure the object picker beside it already says the same word - and
    // with several objects it says it too, which is why the object name is not
    // repeated here.
    const i = (typeof r.currentFrame === 'number' && r.currentFrame >= 0) ? r.currentFrame : 0;
    const f = frames[i];
    el.textContent = (frames.length > 1 && f && f.name) ? f.name : '';
    el.title = el.textContent;
}

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
    const rawSel = renderer.residueSelection;
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
    // at indices past the end of frame.coords - and the guard below then
    // dropped every one of them, which is the expansion above doing nothing at
    // all. The two agree on every base position; only the tail differs.
    const liveCoords = (renderer.coords && renderer.coords.length >= frame.coords.length)
        ? renderer.coords : frame.coords;
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
    } else if (renderer.multiState && renderer.multiState.enabled) {
        // EVERYTHING THAT IS DRAWN, not everything in the current object. With
        // several objects merged, `frame` is one of them - orienting on it
        // alone swings the view onto that structure and leaves the others
        // wherever they land, which is not what Orient with nothing selected
        // is asking for.
        for (let i = 0; i < liveCoords.length; i++) {
            const c = xyzAt(i);
            if (c) coordsForBestView.push(c);
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
        renderer.render('app.js: applyBestViewRotation');
        return;
    }

    // Set up animation
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
        renderer.viewerState.rotation = rotationAnimation.targetMatrix;

        if (rotationAnimation.targetCenter) {
            // Vec3 is defined in viewer-mol.js - access via window or use object literal
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
    requestAnimationFrame(animateRotation);
}

// ============================================================================
// STRUCTURE PROCESSING
// ============================================================================

// Biounit extraction and application functions are now in utils.js
// Using unified functions: extractBiounitOperations, applyBiounitOperationsToAtoms


/**
 * Convert color name or hex/rgba string to RGB object
 * @param {string} colorStr - Color string (name, hex, or rgba)
 * @returns {{r: number, g: number, b: number}|null} RGB object or null if invalid
 */
function parseContactColor(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;

    const colorLower = colorStr.toLowerCase().trim();

    // Common color names
    const colorNames = {
        'red': { r: 255, g: 0, b: 0 },
        'green': { r: 0, g: 255, b: 0 },
        'blue': { r: 0, g: 0, b: 255 },
        'yellow': { r: 255, g: 255, b: 0 },
        'orange': { r: 255, g: 165, b: 0 },
        'purple': { r: 128, g: 0, b: 128 },
        'cyan': { r: 0, g: 255, b: 255 },
        'magenta': { r: 255, g: 0, b: 255 },
        'pink': { r: 255, g: 192, b: 203 },
        'brown': { r: 165, g: 42, b: 42 },
        'black': { r: 0, g: 0, b: 0 },
        'white': { r: 255, g: 255, b: 255 },
        'gray': { r: 128, g: 128, b: 128 },
        'grey': { r: 128, g: 128, b: 128 }
    };

    if (colorNames[colorLower]) {
        return colorNames[colorLower];
    }

    // Hex color (#ff0000 or ff0000)
    if (colorStr.startsWith('#') || /^[0-9a-fA-F]{6}$/.test(colorStr)) {
        const hex = colorStr.startsWith('#') ? colorStr.slice(1) : colorStr;
        if (hex.length === 6) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
                return { r, g, b };
            }
        }
    }

    // RGBA format: rgba(255, 0, 0, 0.8) or rgb(255, 0, 0)
    const rgbaMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
    if (rgbaMatch) {
        const r = parseInt(rgbaMatch[1], 10);
        const g = parseInt(rgbaMatch[2], 10);
        const b = parseInt(rgbaMatch[3], 10);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
            return { r, g, b };
        }
    }

    return null;
}

function parseContactsFile(text) {
    const contacts = [];
    const lines = text.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and comment lines (starting with #)
        if (!trimmed || trimmed.startsWith('#')) continue;

        const parts = trimmed.split(/\s+/);

        // Position indices format: "10 50 1.0" or "10 50 1.0 red" (weight is required)
        if (parts.length >= 3) {
            const idx1 = parseInt(parts[0], 10);
            const idx2 = parseInt(parts[1], 10);
            const weight = parseFloat(parts[2]);

            if (!isNaN(idx1) && !isNaN(idx2) && !isNaN(weight) && weight > 0) {
                const contact = [idx1, idx2, weight];
                // Optional color (4th part)
                if (parts.length >= 4) {
                    const color = parseContactColor(parts.slice(3).join(' ')); // Join in case color has spaces
                    if (color) {
                        contact.push(color);
                    }
                }
                contacts.push(contact);
                continue;
            }
        }

        // Chain + residue format: "A 10 B 50 0.5" or "A 10 B 50 0.5 yellow" (weight is required)
        if (parts.length >= 5) {
            const chain1 = parts[0];
            const res1 = parseInt(parts[1], 10);
            const chain2 = parts[2];
            const res2 = parseInt(parts[3], 10);
            const weight = parseFloat(parts[4]);

            if (!isNaN(res1) && !isNaN(res2) && !isNaN(weight) && weight > 0) {
                const contact = [chain1, res1, chain2, res2, weight];
                // Optional color (6th part)
                if (parts.length >= 6) {
                    const color = parseContactColor(parts.slice(5).join(' ')); // Join in case color has spaces
                    if (color) {
                        contact.push(color);
                    }
                }
                contacts.push(contact);
            }
        }
    }

    return contacts;
}

async function addMetadataToExistingObject({ msaFiles, jsonFiles, contactFiles, loadMSA, loadPAE }) {
    if (!viewerApi || !viewerApi.renderer) {
        setStatus("No viewer available. Please load a structure first.", true);
        return { objectsLoaded: 0, framesAdded: 0, structureCount: 0, paePairedCount: 0, isTrajectory: false };
    }

    const renderer = viewerApi.renderer;
    const objectSelect = document.getElementById('objectSelect');
    const currentObjectName = objectSelect && objectSelect.value ? objectSelect.value : renderer.currentObjectName;

    if (!currentObjectName || !renderer.objectsData[currentObjectName]) {
        setStatus("No object selected. Please load a structure first.", true);
        return { objectsLoaded: 0, framesAdded: 0, structureCount: 0, paePairedCount: 0, isTrajectory: false };
    }

    const object = renderer.objectsData[currentObjectName];
    let metadataAdded = [];

    // Process PAE files
    if (loadPAE && jsonFiles.length > 0) {
        for (const jsonFile of jsonFiles) {
            try {
                const jsonText = await jsonFile.readAsync("text");
                const jsonObject = JSON.parse(jsonText);

                if (!jsonObject.objects) {
                    const paeData = extractPaeFromJSON(jsonObject);
                    if (paeData) {
                        for (const frame of object.frames) {
                            frame.pae = paeData;
                        }
                        const currentFrame = renderer.currentFrame;
                        renderer.setFrame(currentFrame);
                        metadataAdded.push(`PAE from ${jsonFile.name}`);
                    }
                }
            } catch (e) {
                console.warn(`Failed to process PAE file ${jsonFile.name}:`, e);
            }
        }
    }

    // Process MSA files
    if (loadMSA && msaFiles.length > 0) {
        const chainSequences = MSA.extractSequences(object.frames[0]);
        const msaDataList = [];

        for (const msaFile of msaFiles) {
            try {
                const msaText = await msaFile.readAsync("text");
                const fileName = msaFile.name.toLowerCase();
                const isA3M = fileName.endsWith('.a3m');
                const isFasta = fileName.endsWith('.fasta') || fileName.endsWith('.fa') || fileName.endsWith('.fas');
                const isSTO = fileName.endsWith('.sto');

                if (!isA3M && !isFasta && !isSTO) continue;

                let msaData = null;
                if (isA3M && window.MSA && window.MSA.parseA3M) {
                    msaData = window.MSA.parseA3M(msaText);
                } else if (isFasta && window.MSA && window.MSA.parseFasta) {
                    msaData = window.MSA.parseFasta(msaText);
                } else if (isSTO && window.MSA && window.MSA.parseSTO) {
                    msaData = window.MSA.parseSTO(msaText);
                }

                if (msaData && msaData.querySequence) {
                    msaDataList.push({ msaData, filename: msaFile.name });
                }
            } catch (e) {
                console.warn(`Failed to process MSA file ${msaFile.name}:`, e);
            }
        }

        if (msaDataList.length > 0) {
            const { chainToMSA, msaToChains } = matchMSAsToChains(msaDataList, chainSequences);
            const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);

            if (msaObj && msaObj.availableChains.length > 0) {
                const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                if (defaultChainSeq && msaObj.msasBySequence[defaultChainSeq]) {
                    const { msaData } = msaObj.msasBySequence[defaultChainSeq];
                    if (window.MSA) {
                        loadMSADataIntoViewer(msaData, msaObj.defaultChain, currentObjectName);
                        metadataAdded.push(`MSA for ${msaObj.availableChains.length} chain(s)`);
                    }
                }
            }
        }
    }

    // Process contact files
    if (contactFiles.length > 0) {
        for (const contactFile of contactFiles) {
            try {
                const text = await contactFile.readAsync("text");
                const contacts = parseContactsFile(text);

                if (contacts.length > 0) {
                    // Clear any existing contacts and replace with new ones
                    object.contacts = contacts;
                    // Invalidate segment cache so contacts are regenerated
                    renderer.cachedSegmentIndices = null;
                    const currentFrame = renderer.currentFrame;
                    renderer.setFrame(currentFrame);
                    metadataAdded.push(`${contacts.length} contact(s) from ${contactFile.name}`);
                } else {
                    const errorMsg = `Warning: No valid contacts found in ${contactFile.name}. Expected format: "0 30 1.0" or "A 10 B 50 0.5" (weight required). Optional color: "0 30 1.0 red" or "A 10 B 50 0.5 yellow". Lines starting with # are comments.`;
                    setStatus(errorMsg, true);
                }
            } catch (e) {
                setStatus(`Error processing contacts file ${contactFile.name}: ${e.message}`, true);
            }
        }
    }

    if (metadataAdded.length > 0) {
        setStatus(`Added to ${currentObjectName}: ${metadataAdded.join(', ')}`);
    } else {
        setStatus("No metadata could be added to the current object.", true);
    }

    return { objectsLoaded: 0, framesAdded: 0, structureCount: 0, paePairedCount: 0, isTrajectory: false };
}

async function buildPendingObject(text, name, paeData, targetObjectName, tempBatch, chainFilter) {
    let models;
    let modresMap = null;
    let chemCompMap = null;
    let cachedLoops = null;
    let conectMap = null;
    let structConn = null;
    let chemCompBondMap = null;

    try {
        const wantBU = !!(window.viewerConfig && window.viewerConfig.ui?.biounit);
        const isCIF = /^\s*data_/m.test(text) || /_atom_site\./.test(text);


        // Parse all models first
        let parseResult;

        if (isCIF) {
            setStage('Reading metadata');
            await yieldToBrowser();
            setStage('Reading atoms');
            parseResult = await parseCIFAsync(text);
            models = parseResult.models;
            cachedLoops = parseResult.loops;
            chemCompMap = parseResult.chemCompMap;
            structConn = parseResult.structConn;
            chemCompBondMap = parseResult.chemCompBondMap;
        } else {
            parseResult = parsePDB(text);
            models = parseResult.models;
            modresMap = parseResult.modresMap;
            conectMap = parseResult.conectMap;
        }

        if (!models || models.length === 0 || models.every(m => m.length === 0)) {
            throw new Error(`Could not parse any models or atoms from ${name}.`);
        }

        // CHAIN SELECTION, applied before anything downstream sees the atoms -
        // ahead of the biounit expansion in particular, so asking for one chain
        // of an assembly does not first build every copy of every chain and
        // then throw most of it away.
        if (chainFilter && chainFilter.length) {
            const exact = new Set(chainFilter);
            const loose = new Set(chainFilter.map((c) => c.toUpperCase()));
            const keep = (a) => {
                const ch = a && a.chain;
                if (ch === undefined || ch === null) return false;
                return exact.has(ch) || loose.has(String(ch).toUpperCase());
            };
            const filtered = models.map((m) => m.filter(keep));
            if (filtered.every((m) => m.length === 0)) {
                const present = [...new Set(models.flat()
                    .map((a) => a && a.chain).filter((c) => c !== undefined && c !== null))];
                throw new Error(`No chain ${chainFilter.join(', ')} in this entry. `
                    + `Chains present: ${present.join(', ') || 'none'}.`);
            }
            models = filtered;
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
    const shouldAlign = alignFramesCheckbox ? alignFramesCheckbox.checked : false;

    // Check if object with same name already exists in tempBatch or pendingObjects
    // If it exists in tempBatch (current upload batch), reuse it to accumulate frames
    // If it exists in pendingObjects (from previous upload), replace it
    const existingTempIndex = tempBatch.findIndex(obj => obj.name === targetObjectName);
    let targetObject;

    if (existingTempIndex >= 0) {
        // Reuse existing object from current batch to accumulate frames
        targetObject = tempBatch[existingTempIndex];
    } else {
        // Check if object exists in pendingObjects (from previous upload) and remove it
        const existingGlobalIndex = pendingObjects.findIndex(obj => obj.name === targetObjectName);
        if (existingGlobalIndex >= 0) {
            pendingObjects.splice(existingGlobalIndex, 1);
        }

        // Create new object and add to tempBatch
        targetObject = { name: targetObjectName, frames: [] };
        tempBatch.push(targetObject);
    }

    const isTrajectory = (loadAsFramesCheckbox.checked ||
        targetObject.frames.length > 0 ||
        models.length > 1);

    // WHAT THE CRYSTAL BROUGHT, DROPPED BEFORE ANYTHING SEES IT. A buffer salt
    // or a cryoprotectant is a real residue in the file and not a part of the
    // molecule; drawn beside the one ligand that matters it has the same
    // weight. Filtered at the ATOM list, like the ligand switch below it, so
    // nothing downstream - positions, bonds, the sequence panel, picking -
    // ever learns they were there. Switch it off and they all come back.
    // See CRYSTAL_ADDITIVES in web/utils.js for what is on the list and, more
    // importantly, what is deliberately not.
    function maybeFilterAdditives(atoms) {
        if (window.viewerConfig?.ui?.filterAdditives === false) return atoms;
        const drop = window.CRYSTAL_ADDITIVES;
        if (!drop || !drop.size) return atoms;
        // ...AND THE IONS THERE ARE HUNDREDS OF. A single magnesium is an
        // active site; 4UG0's 239 are the mortar a ribosome is built with.
        // Counted per RESIDUE, and only for single-atom ones - see
        // CROWD_ION_COUNT in web/utils.js.
        const crowd = window.CROWD_ION_COUNT || 20;
        const per = new Map();          // code -> { res, mono }
        let runKey = null; let runCode = null; let runLen = 0;
        const flush = () => {
            if (runCode === null) return;
            let e = per.get(runCode);
            if (!e) { e = { res: 0, mono: true }; per.set(runCode, e); }
            e.res++;
            if (runLen > 1) e.mono = false;
        };
        for (const a of atoms) {
            if (!a || a.record !== 'HETATM') continue;
            const key = a.chain + ':' + a.resSeq + ':' + a.resName;
            if (key !== runKey) { flush(); runKey = key; runCode = a.resName; runLen = 0; }
            runLen++;
        }
        flush();
        const crowded = new Set();
        for (const [code, e] of per) {
            if (e.mono && e.res > crowd) crowded.add(code);
        }
        let n = 0;
        const kept = atoms.filter((a) => {
            if (!a || a.record !== 'HETATM') return true;
            if (!drop.has(a.resName) && !crowded.has(a.resName)) return true;
            n++;
            return false;
        });
        return n ? kept : atoms;
    }

    function maybeFilterLigands(atoms) {
        const shouldLoadLigands = window.viewerConfig?.ui?.loadLigands ?? false;
        if (shouldLoadLigands) return atoms;

        // Use modresMap and chemCompMap from parent scope (from parse results)
        // Group positions by residue to check for structural characteristics
        const residueMap = new Map();
        // Grouped by RUN, not by rebuilding the key for every atom - see
        // convertParsedToFrameData in utils.js, which groups the same way and
        // explains why.
        let runChain = null, runSeq = null, runName = null, residue = null;
        for (const atom of atoms) {
            if (!atom) continue;
            if (residue === null || atom.chain !== runChain
                || atom.resSeq !== runSeq || atom.resName !== runName) {
                const resKey = `${atom.chain}:${atom.resSeq}:${atom.resName}`;
                residue = residueMap.get(resKey);
                if (!residue) {
                    residue = {
                        resName: atom.resName,
                        record: atom.record,
                        chain: atom.chain,
                        resSeq: atom.resSeq,
                        atoms: []
                    };
                    residueMap.set(resKey, residue);
                }
                runChain = atom.chain; runSeq = atom.resSeq; runName = atom.resName;
            }
            residue.atoms.push(atom);
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
    let previousBonds = undefined; // Track bonds for change detection
    for (let i = 0; i < models.length; i++) {
        if (!loadAsFramesCheckbox.checked && i > 0) {
            const modelObjectName = `${targetObjectName}_model_${i + 1}`;
            targetObject = tempBatch.find(obj => obj.name === modelObjectName) || null;
            if (!targetObject) {
                targetObject = { name: modelObjectName, frames: [] };
                tempBatch.push(targetObject);
            }
        }

        // ONLY THE PAE NEEDS THIS, so only build it when there is a PAE.
        //
        // Everything down to the end of this block exists to produce
        // originalIsLigandPosition, and that is read in exactly one place -
        // the `if (paeData)` branch below - to line a PAE matrix up with the
        // positions it was computed for. Building it unconditionally means a
        // SECOND full convertParsedToFrameData over every atom, plus a residue
        // map and a per-position classification, for every structure whether
        // it has a PAE or not.
        //
        // On 3J3Q that is 2.7 s of a 13 s load: convertParsedToFrameData
        // measured 5.5 s across both call sites against 2.8 s for the one that
        // feeds the drawing.
        let originalFrameData = null;
        const originalIsLigandPosition = [];
        if (paeData) {
            // Convert original model to identify which positions are ligands
            // This is needed to filter PAE matrix correctly
            // We need to identify ligands in the ORIGINAL model to map PAE positions correctly
            // IMPORTANT: includeAllResidues=true ensures ALL positions are included to match PAE matrix size
            originalFrameData = convertParsedToFrameData(models[i], modresMap, chemCompMap, true, conectMap, structConn, chemCompBondMap);

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
        }

        // Filter ligands from model
        setStage('Grouping residues');
        // ...but only where there is something to wait for: a trajectory runs
        // this loop once per model, and a model can be 0.1 ms of work against a
        // 4 ms clamped timer. See yieldIfBusy in utils.js.
        await yieldIfBusy();
        const model = maybeFilterLigands(maybeFilterAdditives(models[i]));

        // Convert parsed atoms to frame data
        // Pass conectMap (PDB) and structConn (CIF) for bond resolution
        setStage('Building positions');
        await yieldIfBusy();
        let frameData = await convertParsedToFrameDataAsync(
            model,
            modresMap,
            chemCompMap,
            false, // includeAllResidues = false (normal mode)
            conectMap,
            structConn,
            chemCompBondMap
        );
        setStage('Preparing frames');
        if (frameData.coords.length === 0) continue;

        // Store PAE data
        if (paeData) {
            // Check if ligands should be filtered (loadLigands=false means ignoreLigands=true)
            const loadLigands = window.viewerConfig && window.viewerConfig.ui?.loadLigands !== undefined
                ? window.viewerConfig.ui.loadLigands
                : true; // Default to loading ligands
            const ignoreLigands = !loadLigands;

            if (ignoreLigands && originalIsLigandPosition.length > 0) {
                // PAE matrix indices map directly to position indices in originalFrameData
                // We need to filter out ligand positions from the PAE matrix

                // Count total ligands identified

                // Determine dimensions
                const isFlat = !!paeData.buffer;
                const n = isFlat ? Math.sqrt(paeData.length) : paeData.length;
                const m = originalIsLigandPosition.length;

                // First, check if PAE size matches originalFrameData size
                if (n === m) {
                    // Sizes match - PAE includes all positions, filter out ligands
                    frameData.pae = filterPAEForLigands(paeData, originalIsLigandPosition);
                } else if (n < m) {
                    // PAE is smaller - it might already exclude ligands, but we need to verify
                    // Count how many ligands are in the first n positions
                    let ligandCountInPAERange = 0;
                    for (let i = 0; i < n; i++) {
                        if (originalIsLigandPosition[i]) {
                            ligandCountInPAERange++;
                        }
                    }

                    if (ligandCountInPAERange > 0) {
                        // PAE includes some ligands in its range, filter them out
                        // Create a truncated ligand position array for the PAE range
                        const truncatedLigandPositions = originalIsLigandPosition.slice(0, n);
                        frameData.pae = filterPAEForLigands(paeData, truncatedLigandPositions);
                    } else {
                        // No ligands in PAE range - PAE already excludes ligands, use as-is
                        frameData.pae = isFlat ? paeData.slice() : paeData.map(row => [...row]);
                    }
                } else {
                    // PAE is larger - truncate to match originalFrameData size, then filter
                    console.warn(`PAE matrix size (${n}) is larger than frame data size (${m}). Truncating and filtering...`);

                    if (isFlat) {
                        // Truncate flat array to m x m
                        const truncated = new paeData.constructor(m * m);
                        for (let i = 0; i < m; i++) {
                            for (let j = 0; j < m; j++) {
                                truncated[i * m + j] = paeData[i * n + j];
                            }
                        }
                        frameData.pae = filterPAEForLigands(truncated, originalIsLigandPosition);
                    } else {
                        const truncatedPae = paeData.slice(0, m).map(row =>
                            row.slice(0, m)
                        );
                        frameData.pae = filterPAEForLigands(truncatedPae, originalIsLigandPosition);
                    }
                }
            } else {
                frameData.pae = (paeData && paeData.buffer) ? paeData.slice() : paeData.map(row => [...row]);
            }
        } else {
            frameData.pae = null;
        }

        // Extract ligand bonds from the model (per-frame with change detection)
        // Only include bonds in frameObj if they differ from previous frame
        let bonds = undefined;

        // Check if explicit bonds were already parsed and returned in frameData
        if (frameData.bonds && frameData.bonds.length > 0) {
            // This frame has explicit bonds defined
            bonds = frameData.bonds;
        } else if (i === 0) {
            // Only compute fallback bonds for frame 0 (will be inherited by other frames)
            const hasLigands = frameData.position_types && frameData.position_types.some(type => type === 'L');

            if (hasLigands) {
                // Fallback: Extract bonds using distance-based method
                const extractedBonds = extractLigandBondsFromAtoms(model, frameData);
                if (extractedBonds && extractedBonds.length > 0) {
                    bonds = extractedBonds;
                }
            }
            // If no ligands, silently skip bond extraction
        }
        // For frames > 0 without explicit bonds: undefined = inherit from frame 0 in viewer

        // Deep copy frame data
        const frameObj = {
            coords: frameData.coords.map(c => [...c]),
            chains: frameData.chains ? [...frameData.chains] : undefined,
            position_types: frameData.position_types ? [...frameData.position_types] : undefined,
            plddts: frameData.plddts ? [...frameData.plddts] : undefined,
            position_names: frameData.position_names ? [...frameData.position_names] : undefined,
            // A LIGAND ATOM'S OWN NAME AND ELEMENT, present only where the file
            // had a ligand in it. The element is what colour-by-element reads;
            // the name is what the atom is called.
            position_atoms: frameData.position_atoms ? [...frameData.position_atoms] : undefined,
            position_elements: frameData.position_elements ? [...frameData.position_elements] : undefined,
            residue_numbers: frameData.residue_numbers ? [...frameData.residue_numbers] : undefined,
            pae: frameData.pae,
            // Carried by REFERENCE, not copied. This is a read-only table of
            // typed arrays, rebuilt from scratch on every parse and never
            // mutated, so copying it would double the memory to no end. It has
            // to be listed here at all because this object is assembled field by
            // field - anything not named is silently dropped, which is how side
            // chains came to be captured, stored and then lost before the
            // renderer ever saw them.
            //
            // Coefficients are relative to the residue's own backbone frame, so
            // the re-centring that happens to coords below does not touch them.
            sidechains: frameData.sidechains,
            // WHERE THIS FRAME CAME FROM. Loading a folder of predictions as
            // frames used to lose which file each one was: the object took one
            // name and the frames were numbered. The strip shows this beside
            // the frame counter, so a frame you are looking at can be named.
            // A multi-model file adds the model's own number, since the file
            // name alone would say the same thing for every frame in it.
            name: models.length > 1 ? `${name} #${i + 1}` : name
        };

        // Only include bond data if it differs from previous frame (optimization)
        // Compare current bonds with previous frame's bonds
        const bondsChanged = (i === 0) || // Always include for first frame
            (bonds !== undefined && bonds !== previousBonds);

        if (bondsChanged && bonds !== undefined) {
            frameObj.bonds = bonds;
        }
        // If bonds haven't changed, omit from frameObj - viewer will inherit

        // Track bonds for next iteration
        if (bonds !== undefined) {
            previousBonds = bonds;
        }

        rawFrames.push(frameObj);
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
            // WHICH CHAIN TO ALIGN ON. The Align chain field, when it names one
            // the structure has; otherwise the first chain in the reference
            // frame, which is what this always did.
            //
            // A name that is not there is SAID, not silently ignored: asking to
            // align on B and getting A without being told is the kind of thing
            // that is only noticed much later, in a figure.
            let alignmentChainId = null;
            const wanted = (document.getElementById('alignChainInput')?.value || '').trim();
            if (wanted && firstFrame.chains) {
                if (firstFrame.chains.includes(wanted)) {
                    alignmentChainId = wanted;
                } else {
                    // ...case-insensitively too, since chain ids are usually
                    // typed in whatever case is to hand
                    const hit = firstFrame.chains.find((c) => c
                        && c.toUpperCase() === wanted.toUpperCase());
                    if (hit) alignmentChainId = hit;
                }
                if (alignmentChainId === null) {
                    setStatus(`No chain "${wanted}" in ${targetObjectName} - aligning on `
                        + `the first chain instead.`, true);
                }
            }
            if (alignmentChainId === null
                && firstFrame.chains && firstFrame.chains.length > 0) {
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
    // ...BUT NOT EACH FRAME SEPARATELY WHEN THEY HAVE JUST BEEN ALIGNED.
    //
    // Centring subtracts a frame's own centroid, which is a TRANSLATION - and
    // an alignment is a rotation AND a translation. Doing this per frame after
    // aligning throws the alignment's half away and puts every frame back on
    // its own centre, so the superposition survives only where the two happen
    // to coincide. Measured on a two-chain fixture aligned on chain B: the
    // frame moved 14.8 A after the alignment placed it, and chain B came out
    // 14.9 A from where it was aligned to - the whole of the error.
    //
    // Aligned frames are already in the reference's frame of reference, so they
    // are shifted TOGETHER by one offset: the reference's, which is zero once
    // the object holds a centred frame already. Unaligned trajectories keep the
    // old per-frame centring, which is what removes their drift.
    const alignedTogether = isTrajectory && shouldAlign;
    let sharedOffset = null;
    // WHERE THE OBJECT SITS IS THE FILE'S BUSINESS.
    //
    // Every frame used to be moved so that its first chain's centroid was at
    // the origin, which is an alignment by another name: two structures loaded
    // as two objects came up stacked on each other whatever their coordinates
    // said, and a complex split across two files lost the one thing the files
    // agreed on. Align Frames is for FRAMES - it says so - and adding an
    // object is not adding a frame.
    //
    // What the centring is still for is DRIFT: frame 30 of a trajectory that
    // has wandered off is put back beside frame 0. So the offsets are relative
    // now - measured from the frame this object already holds, or from the
    // first of the batch - and the first frame of a new object is not moved at
    // all. The renderer frames the camera on each object's own centre
    // (_recomputeObjectStats), so a structure far from the origin is drawn
    // exactly as before.
    let referenceCentre = null;
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

    // The centroid of one frame over the centring chain, or over everything
    // when there is no chain information - the same reckoning the loop below
    // does, needed once more for the reference frame.
    function centroidOfFrame(frame, chainId) {
        if (!frame || !frame.coords || !frame.coords.length) return null;
        let n = 0; const c = [0, 0, 0];
        for (let j = 0; j < frame.coords.length; j++) {
            if (chainId !== null && frame.chains && frame.chains[j] !== chainId) continue;
            c[0] += frame.coords[j][0];
            c[1] += frame.coords[j][1];
            c[2] += frame.coords[j][2];
            n++;
        }
        if (!n) return null;
        return [c[0] / n, c[1] / n, c[2] / n];
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
            let center = [0, 0, 0];
            for (const coord of centeringCoords) {
                center[0] += coord[0];
                center[1] += coord[1];
                center[2] += coord[2];
            }
            center[0] /= centeringCoords.length;
            center[1] /= centeringCoords.length;
            center[2] /= centeringCoords.length;

            // WHAT THIS FRAME IS MEASURED AGAINST: the object's first frame
            // when it has one, otherwise the first frame of this batch, which
            // therefore does not move.
            if (referenceCentre === null) {
                const ref = targetObject.frames.length > 0
                    ? targetObject.frames[0] : rawFrames[0];
                referenceCentre = centroidOfFrame(ref, centeringChainId) || center;
            }
            if (alignedTogether) {
                // Aligned frames are already in the reference's frame of
                // reference - the rotation and the translation both - so there
                // is nothing left to take off them.
                if (sharedOffset === null) sharedOffset = [0, 0, 0];
                center = sharedOffset;
            } else {
                center = [center[0] - referenceCentre[0],
                    center[1] - referenceCentre[1],
                    center[2] - referenceCentre[2]];
            }

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

// THE PAGE OPENS ON CARTOON, so a structure can arrive that the cartoon build
// cannot survive - a capsid asks for gigabytes of prims and takes the tab with
// it. setStyle refuses that switch, but nothing refuses a structure loaded into
// a viewer already in cartoon, which before the default changed could not
// happen. Same test setStyle uses, same escape hatch (renderer.cartoonForce).
// TUBE IS THE DEFAULT PAST TWO THOUSAND RESIDUES.
//
// Not the same rule as dropToTubeIfCartoonWontFit below, which is about a
// cartoon that cannot be BUILT - tens of thousands of positions and a heap
// that will not hold them. This one is about what is worth looking at: past
// a couple of thousand residues the ribbon is a tangle at any zoom that fits
// it on screen, it costs several times a tube to draw, and the first thing to
// do with it is turn it down. Starting there and letting the user reach for
// the cartoon is the better of the two wrong-by-default choices.
//
// It was a thousand, which took the cartoon away from structures that still
// read perfectly well as one - a ribosomal subunit is a tangle, a couple of
// ordinary chains is not.
//
// ONLY WHILE NOBODY HAS CHOSEN. Picking a style in the Style panel sets
// renderer.styleChosen, and a restored session sets it too - a saved view says
// what it wants. Without that, loading a second structure would undo a choice
// made after the first.
const BIG_STRUCTURE_RESIDUES = 2000;

function tubeByDefaultIfBig(r, objectName) {
    // A HAND-PICKED STYLE IS STICKY AND AN AUTOMATIC ONE IS NOT. Choosing in
    // the Style panel sets styleChosen, and from then on this rule keeps out
    // of the way for every object - a stated preference is a preference. What
    // the rule decides on its own belongs to the structure it decided about.
    if (!r || r.styleChosen || r.cartoonForce) return;
    if (!r.setStyle) return;
    // COUNTED OFF THE FRAME, not off the renderer. This runs while the object
    // is being switched to, and renderer.positionTypes is still the PREVIOUS
    // object's at that point - empty on the first load, so the rule read every
    // structure as nothing and never fired. Measured on 1AOI: 0 types against
    // the frame's 1,097.
    const obj = r.objectsData && r.objectsData[objectName];
    const frame = obj && obj.frames && obj.frames[0];
    if (!frame) return;
    // RESIDUES, not positions: a position is a residue for protein and nucleic
    // acid, but a ligand contributes one per atom and side chains append more,
    // so counting coordinates would put a 300-residue structure with a big
    // ligand over the line. A frame with no types at all is all backbone.
    const t = frame.position_types;
    let n = 0;
    if (t && t.length) {
        for (let i = 0; i < t.length; i++) {
            if (t[i] === 'P' || t[i] === 'D' || t[i] === 'R') n++;
        }
    } else {
        n = (frame.coords && frame.coords.length) || 0;
    }
    // BOTH WAYS, which is the whole of it. This used to return unless the
    // renderer was already on cartoon, so the first big structure switched it
    // to tube and every structure after it stayed there however small: load a
    // ribosome, fetch a peptide, get a tube. The decision is about the
    // structure being loaded, so it has to be able to answer either way.
    const want = n > BIG_STRUCTURE_RESIDUES ? 'tube' : 'cartoon';
    if (r.style === want) return;
    r.setStyle(want);
    if (want === 'tube') {
        styleFallbackNote = `${n.toLocaleString()} residues - showing tube;`
            + ' pick Cartoon in Style for the ribbon.';
        setStatus('');
    }
}

function dropToTubeIfCartoonWontFit(r) {
    if (!r || r.style !== 'cartoon' || r.cartoonForce) return;
    if (!r._cartoonWouldFit || !r.setStyle) return;
    const fit = r._cartoonWouldFit();
    if (fit.ok) return;
    r.setStyle('tube');
    // STICKY, because this happens mid-load and the messages that come after it
    // - "Loaded.", the fetch summary, an MSA result - would each bury it. It
    // rides along on whatever the load ends up saying, and the next load clears
    // it. Silently changing what the user is looking at is not an option.
    styleFallbackNote = `Too large for the cartoon style `
        + `(${fit.positions.toLocaleString()} positions need about ${fit.needMB} MB); `
        + `showing tube.`;
    setStatus('');
}

function applyPendingObjects() {
    const viewerContainer = document.getElementById('viewer-container');
    const topPanelContainer = document.getElementById('sequence-viewer-container');
    const objectSelect = document.getElementById('objectSelect');
    const r = viewerApi?.renderer;

    if (!viewerApi || pendingObjects.length === 0) {
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

    for (const obj of pendingObjects) {
        if (!obj || !obj.frames || obj.frames.length === 0) continue;

        // ...AND ONLY THE ONES THIS LOAD BROUGHT. `pendingObjects` accumulates
        // across loads and is only emptied by Clear All, so this loop rebuilt
        // EVERY object already in the viewer on every load - dropping what each
        // one remembered: its hidden backbone, its side chains, its bases, its
        // forced SSE, its colours, its contacts. Colour a residue, load a
        // second file, and the colour was gone.
        //
        // An object already put into the renderer is left alone. A re-FETCH
        // replaces its pending entry with a fresh one (see the splice where a
        // batch is queued), so it is unmarked and IS rebuilt - which is what
        // "always replace to avoid mixing data" was for.
        if (obj._appliedToRenderer && existing.has(obj.name)) {
            newNames.push(obj.name);
            continue;
        }

        // Always replace objects with the same name to avoid mixing data
        if (existing.has(obj.name)) {
            if (r.objectSelect) {
                const option = r.objectSelect.querySelector(`option[value="${obj.name}"]`);
                if (option) option.remove();
            }
            if (objectSelect) {
                const option = objectSelect.querySelector(`option[value="${obj.name}"]`);
                if (option) option.remove();
            }
            if (r.objectsData[obj.name]) {
                delete r.objectsData[obj.name];
            }
            existing.delete(obj.name);
        }

        // Create and feed frames (new or replaced)
        r.addObject(obj.name);
        obj._appliedToRenderer = true;
        newNames.push(obj.name);
        for (const frame of obj.frames) {
            r.addFrame(frame, obj.name);
        }

        // Set MSA data (replacing any existing MSA)
        if (r && obj.msa && r.objectsData[obj.name]) {
            r.objectsData[obj.name].msa = obj.msa;
        }

        // Set contacts data (replacing any existing contacts)
        if (r && obj.contacts && r.objectsData[obj.name]) {
            r.objectsData[obj.name].contacts = obj.contacts;
            // Invalidate segment cache so contacts are regenerated
            r.cachedSegmentIndices = null;
            // Trigger re-render to show contacts
            if (r.currentObjectName === obj.name) {
                const currentFrame = r.currentFrame;
                r.setFrame(currentFrame);
            }
        }
    }

    if (pendingObjects.length > 0) {
        // Ensure canvas dimensions are set before showing container to prevent ResizeObserver render
        const canvasContainer = viewerContainer?.querySelector('#canvasContainer');
        const canvas = viewerContainer?.querySelector('#canvas');
        if (canvasContainer && canvas && r) {
            // Set explicit dimensions to prevent ResizeObserver from detecting a size change
            const computed = window.getComputedStyle(canvasContainer);
            const width = parseInt(computed.width) || 600;
            const height = parseInt(computed.height) || 600;
            if (width > 0 && height > 0) {
                canvas.style.width = width + 'px';
                canvas.style.height = height + 'px';
                // SAME DPR POLICY as viewer-mol.js's canvas setup, and the two
                // must stay in step or the app sizes for one resolution and the
                // renderer draws at another.
                //
                // THE 1.5x CAP IS GONE. It bought performance by drawing fewer
                // pixels than the display has - on a 2x screen a 598px canvas
                // got an 897px backing store and the result was resampled up,
                // which is exactly the softness it looks like. That trade was
                // worth making when every frame was a full canvas repaint; it
                // is the wrong way round now that the GPU path draws a frame in
                // a couple of milliseconds and paint is not the bottleneck.
                // window.canvasDPR still overrides, so window.canvasDPR = 1.5
                // puts the old behaviour back without a rebuild.
                const dpr = window.canvasDPR !== undefined
                    ? window.canvasDPR : (window.devicePixelRatio || 1);
                canvas.width = width * dpr;
                canvas.height = height * dpr;
                const ctx = canvas.getContext('2d');
                ctx.scale(dpr, dpr);
                r._updateCanvasDimensions?.();
            }
        }
        if (viewerContainer) viewerContainer.style.display = 'flex';
        if (topPanelContainer) topPanelContainer.style.display = 'block';
    }

    if (r) r._batchLoading = false;

    if (newNames.length > 0) {
        // Show the last new object
        const show = newNames[newNames.length - 1];
        if (r?._switchToObject) r._switchToObject(show);
        tubeByDefaultIfBig(r, show);
        dropToTubeIfCartoonWontFit(r);
        // a new object is a new depth range, and loading one does not go
        // through the object dropdown's change event
        setTimeout(syncClipPanelToObject, 0);
        if (r?.objectSelect) r.objectSelect.value = show;
        if (objectSelect) objectSelect.value = show;
        if (r?.updatePAEContainerVisibility) r.updatePAEContainerVisibility();
        if (r?.updateScatterContainerVisibility) r.updateScatterContainerVisibility();
        if (typeof updateObjectNavigationButtons === 'function') updateObjectNavigationButtons();
        if (window.SEQ?.clearPreview) window.SEQ.clearPreview();
        // Re-run the Ortho slider now the object is in and switched to. Focal
        // length is scaled by the object's size, which is only known once it is
        // loaded, and the switch above restores that object's own viewerState -
        // so this has to come last or it gets overwritten.
        if (r?.orthoSlider) r.orthoSlider.dispatchEvent(new Event('input'));
        if (typeof buildView === 'function') (window.SEQ?.buildViewDeferred || window.SEQ?.buildView)?.();
        if (window.updateMSAChainSelectorIndex) window.updateMSAChainSelectorIndex();
        if (window.updateMSAContainerVisibility) window.updateMSAContainerVisibility();
        if (r?.updateUIControls) r.updateUIControls();
        updateFrameNameLabel();

        // Load frame and apply best view rotation WITHOUT intermediate renders
        if (r?.setFrame) {
            r.setFrame(0, true); // Load frame, skip intermediate render
        }
        if (typeof applyBestViewRotation === 'function') applyBestViewRotation(false); // Will render once
    } else if (snapshot?.object && r?.objectsData?.[snapshot.object]) {
        // No new objects: restore the previous object/frame
        if (r?._switchToObject) r._switchToObject(snapshot.object);
        if (typeof snapshot.frame === 'number' && r?.setFrame) r.setFrame(snapshot.frame);
        if (r?.render) r.render();
        if (r?.objectSelect) r.objectSelect.value = snapshot.object;
        if (objectSelect) objectSelect.value = snapshot.object;
        if (r?.updatePAEContainerVisibility) r.updatePAEContainerVisibility();
        if (typeof updateObjectNavigationButtons === 'function') updateObjectNavigationButtons();
        if (window.SEQ?.clearPreview) window.SEQ.clearPreview();
        if (typeof buildView === 'function') (window.SEQ?.buildViewDeferred || window.SEQ?.buildView)?.();
        if (window.updateMSAChainSelectorIndex) window.updateMSAChainSelectorIndex();
        if (window.updateMSAContainerVisibility) window.updateMSAContainerVisibility();
    } else {
        setStatus("Error: No valid structures were loaded to display.", true);
        if (viewerContainer) viewerContainer.style.display = 'none';
    }
}

// This function updates the chain buttons and sequence view
// based on the renderer's selection model
function syncChainPillsToSelection() {
    // Chain buttons and sequence are now drawn on canvas, update via updateSelection
    // The function will check internally if canvas data exists
    window.SEQ?.updateSelection();
}

function applySelection(previewPositions = null) {
    if (!viewerApi || !viewerApi.renderer) return;

    const objectName = viewerApi.renderer.currentObjectName;
    if (!objectName) {
        if (viewerApi.renderer.resetVisibility) {
            viewerApi.renderer.resetVisibility();
        } else {
            viewerApi.renderer.visiblePositions = null;
            viewerApi.renderer.render();
        }
        return;
    }

    // Get current selection
    const current = viewerApi.renderer.getVisibility();

    // Get visible chains from selection model (chain buttons are now on canvas)
    let visibleChains = current?.chains || new Set();
    // If in default mode with no explicit chains, all chains are visible
    if (current?.visibilityMode === 'default' && (!current.chains || current.chains.size === 0)) {
        // Get all chains from renderer
        if (viewerApi.renderer.chains) {
            visibleChains = new Set(viewerApi.renderer.chains);
        }
    }

    // Use preview selection if provided, otherwise use current selection
    const positionsToUse = previewPositions !== null ? previewPositions : current.positions;

    viewerApi.renderer.setVisibility({
        positions: positionsToUse,
        chains: visibleChains
        // Keep current PAE boxes and mode
    });

    // the selection tools act on this selection, so their enabled state
    // follows it - this is the one place every selection change passes through
    if (window.updateSelectionToolsState) window.updateSelectionToolsState();

    // Note: updateSelection will be called via event listener
}


function clearAllObjects() {
    // Clear all batched objects
    pendingObjects = [];

    // Clear PAE tracking

    // Hide viewer and top panel
    const viewerContainer = document.getElementById('viewer-container');
    const topPanelContainer = document.getElementById('sequence-viewer-container');
    const msaContainer = document.getElementById('msa-buttons');
    if (viewerContainer) {
        viewerContainer.style.display = 'none';
    }
    if (topPanelContainer) {
        topPanelContainer.style.display = 'none';
    }
    if (msaContainer) {
        msaContainer.style.display = 'none';
    }

    // Clear MSA data
    if (window.MSA && window.MSA.clear) {
        try {
            window.MSA.clear();
        } catch (e) {
            console.error("Failed to clear MSA viewer:", e);
        }
    }

    // Use viewer's comprehensive reset method
    if (viewerApi && viewerApi.renderer) {
        try {
            viewerApi.renderer.resetAll();
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
if (window.SEQ) {
    window.SEQ.setCallbacks({
        getRenderer: () => viewerApi?.renderer || null,
        getObjectSelect: () => document.getElementById('objectSelect'),
        applySelection: applySelection
    });
}

// MSA viewer callbacks are now set up in initializeApp() after viewerApi is initialized

/**
 * Initialize common MSA viewer UI components (sliders, buttons, checkboxes)
 * Shared between msa.html and index.html
 */
function initializeMSACommon() {
    const msaContainer = document.getElementById('msa-buttons');
    const msaModeSelect = document.getElementById('msaModeSelect');
    const coverageSlider = document.getElementById('coverageSlider');
    const coverageValue = document.getElementById('coverageValue');
    const identitySlider = document.getElementById('identitySlider');
    const identityValue = document.getElementById('identityValue');

    // MSA viewer will be shown/hidden based on whether MSA data exists
    // Container starts hidden, will be shown when MSA data is loaded

    // Initialize coverage slider
    if (coverageSlider && coverageValue) {
        // Set initial value (75% = 0.75) if MSA is available
        if (window.MSA && window.MSA.getCoverageCutoff) {
            const initialCutoff = window.MSA.getCoverageCutoff();
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
            if (window.MSA?.setCoverageCutoff) {
                try {
                    window.MSA.setCoverageCutoff(cutoff);
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
        // Set initial value (15% = 0.15) if MSA is available
        if (window.MSA && window.MSA.getIdentityCutoff) {
            const initialCutoff = window.MSA.getIdentityCutoff();
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
            if (window.MSA?.setIdentityCutoff) {
                try {
                    window.MSA.setIdentityCutoff(cutoff);
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

    if (msaModeSelect && window.MSA) {
        // Set initial value
        const initialMode = window.MSA.getMSAMode ? window.MSA.getMSAMode() : 'msa';
        msaModeSelect.value = initialMode;

        // Handle mode change
        msaModeSelect.addEventListener('change', (e) => {
            const mode = e.target.value;
            if (window.MSA) {
                window.MSA.setMSAMode(mode);
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
    if (msaSaveFastaButton && window.MSA) {
        msaSaveFastaButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.MSA.saveMSAAsFasta) {
                window.MSA.saveMSAAsFasta();
            }
        });
    }

    if (logoSaveSvgButton && window.MSA) {
        logoSaveSvgButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.MSA.saveLogoAsSvg) {
                window.MSA.saveLogoAsSvg();
            }
        });
    }

    if (pssmSaveSvgButton && window.MSA) {
        pssmSaveSvgButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.MSA.savePSSMAsSvg) {
                window.MSA.savePSSMAsSvg();
            }
        });
    }

    if (pssmSaveCsvButton && window.MSA) {
        pssmSaveCsvButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.MSA.savePSSMAsCsv) {
                window.MSA.savePSSMAsCsv();
            }
        });
    }

    if (msaSortCheckbox) {
        msaSortCheckbox.addEventListener('change', (e) => {
            if (window.MSA) {
                window.MSA.setSortSequences(e.target.checked);
            }
        });
    }

    // Handle bit-score checkbox
    if (logoBitScoreCheckbox && window.MSA) {
        // Set initial value (checked = true = bit-score mode)
        logoBitScoreCheckbox.checked = window.MSA.getUseBitScore ? window.MSA.getUseBitScore() : true;

        // Handle checkbox change
        logoBitScoreCheckbox.addEventListener('change', (e) => {
            const useBitScore = e.target.checked;
            if (window.MSA.setUseBitScore) {
                window.MSA.setUseBitScore(useBitScore);
            }
        });
    }

    // Function to update MSA sequence count display
    function updateMSASequenceCount() {
        const sequenceCountEl = document.getElementById('msaSequenceCount');
        if (sequenceCountEl && window.MSA && window.MSA.getSequenceCounts) {
            const counts = window.MSA.getSequenceCounts();
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

// Standalone MSA viewer initialization removed - now uses unified code path with index.html

/**
 * Load standalone MSA file (for msa.html when no structure is loaded)
 * @param {File} file - MSA file to load
 */
async function loadStandaloneMSA(file) {
    const fileName = file.name.toLowerCase();
    const isA3M = fileName.endsWith('.a3m');
    const isFasta = fileName.endsWith('.fasta') || fileName.endsWith('.fa') || fileName.endsWith('.fas');
    const isSTO = fileName.endsWith('.sto');

    if (!isA3M && !isFasta && !isSTO) {
        setStatus('Please upload an A3M (.a3m), FASTA (.fasta, .fa, .fas), or STO (.sto) file', true);
        return;
    }

    try {
        // Use readAsync method from file wrapper
        const msaText = await file.readAsync('text');

        let msaData = null;
        if (isA3M && window.MSA && window.MSA.parseA3M) {
            msaData = window.MSA.parseA3M(msaText);
        } else if (isFasta && window.MSA && window.MSA.parseFasta) {
            msaData = window.MSA.parseFasta(msaText);
        } else if (isSTO && window.MSA && window.MSA.parseSTO) {
            msaData = window.MSA.parseSTO(msaText);
        }

        if (msaData && msaData.querySequence) {
            window.MSA.setMSAData(msaData, null);
            setStatus(`Loaded MSA: ${msaData.sequences.length} sequences, length ${msaData.queryLength}`);

            // Update sequence count
            const sequenceCountEl = document.getElementById('msaSequenceCount');
            if (sequenceCountEl && window.MSA && window.MSA.getSequenceCounts) {
                const counts = window.MSA.getSequenceCounts();
                if (counts) {
                    sequenceCountEl.textContent = `${counts.filtered} / ${counts.total}`;
                }
            }

            // Show MSA viewer container
            const msaContainer = document.getElementById('msa-buttons');
            if (msaContainer) {
                msaContainer.style.display = 'block';
            }
            showMSACanvasContainers();
        } else {
            setStatus('Failed to parse MSA file', true);
            throw new Error('Failed to parse MSA file');
        }
    } catch (error) {
        console.error('Error loading MSA:', error);
        setStatus('Error loading MSA file: ' + error.message, true);
        throw error;
    }
}

/**
 * Fetch MSA from AlphaFold DB by UniProt ID
 * @param {string} uniprotId - UniProt ID
 * @param {string} originalId - Original ID (for error messages)
 * @returns {Promise<string>} - MSA text content
 */
async function fetchMSAFromAlphaFold(uniprotId, originalId = null) {
    setStatus(`Fetching MSA for ${uniprotId} from AlphaFold DB...`);

    const msaUrl = `https://alphafold.ebi.ac.uk/files/msa/AF-${uniprotId}-F1-msa_v6.a3m`;

    const response = await fetch(msaUrl);
    if (!response.ok) {
        if (response.status === 404) {
            const idDisplay = originalId ? `PDB ${originalId} (UniProt ${uniprotId})` : `UniProt ID ${uniprotId}`;
            throw new Error(`MSA not found for ${idDisplay}. The structure may not be available in AlphaFold DB.`);
        }
        throw new Error(`Failed to fetch MSA (HTTP ${response.status})`);
    }

    const msaText = await response.text();

    if (!msaText || msaText.trim().length === 0) {
        throw new Error('Empty MSA file received');
    }

    return msaText;
}

// loadMSADataIntoViewerStandalone removed - using unified code path

// handleMSAFetch removed - using unified handleFetch code path

// handleMSAFileUpload removed - using unified file upload code path

// initMSADragAndDrop removed - using unified drag and drop code path

// setupMSAPageEventListeners removed - using unified event listeners from index.html code path

// MSA viewer initialization is now unified with index.html
// No separate path needed for msa.html

/**
 * Initialize MSA viewer for index.html (integrated with structure viewer)
 */
function initializeMSAIndex() {
    const common = initializeMSACommon();
    const { updateMSASequenceCount } = common;

    const msaChainSelect = document.getElementById('msaChainSelect');
    const msaContainer = document.getElementById('msa-buttons');

    // Chain selector for single chain support (first pass)
    if (msaChainSelect && window.MSA && viewerApi?.renderer) {
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
                        const { msaData } = msaEntry;
                        // Load MSA for first chain (all chains in key share same MSA)
                        window.MSA.setMSAData(msaData, firstChain);

                        // Update default chain to first chain in the key
                        obj.msa.defaultChain = firstChain;

                        // Update renderer for selected chain key
                        viewerApi.renderer.reloadDrawn();
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
            return;
        }

        const obj = viewerApi.renderer.objectsData[objectName];
        if (!obj) {
            msaContainer.style.display = 'none';
            clearMSAState();
            return;
        }

        if (!obj.msa) {
            msaContainer.style.display = 'none';
            clearMSAState();
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

        if (hasMSA && msaToLoad && window.MSA) {
            // Show container and view
            // Clear any existing MSA viewer state/DOM to avoid stale canvases or modes
            clearMSAState();
            msaContainer.style.display = 'block';

            // Force a layout recalculation to ensure container dimensions are available
            void msaContainer.offsetWidth; // Force reflow

            // Load MSA data into viewer (this will update the display)
            loadMSADataIntoViewer(msaToLoad, chainId, objectName);

            // Apply current object's selection to MSA (refilter based on selection state)
            // This ensures the MSA is filtered correctly when switching objects
            // Selection state is already restored by _switchToObject() before this is called
            applySelectionToMSA();

            // Remap entropy if entropy mode is active (after MSA is loaded)
            refreshEntropyColors();
        } else {
            // Hide MSA container if no MSA for this object
            msaContainer.style.display = 'none';
            clearMSAState();

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
    if (window.MSA && window.MSA.setMSAData) {
        const originalSetMSAData = window.MSA.setMSAData;
        // Only wrap if not already wrapped
        if (!originalSetMSAData._indexHtmlWrapped) {
            window.MSA.setMSAData = function (data, chainId) {
                originalSetMSAData.call(this, data, chainId);
                updateMSASequenceCount();
            };
            window.MSA.setMSAData._indexHtmlWrapped = true;
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
        document.addEventListener('DOMContentLoaded', initializeMSAIndex);
    } else {
        initializeMSAIndex();
    }
}

// MSA viewer callbacks are set up in initializeApp() after viewerApi is initialized

// ============================================================================
// FETCH LOGIC
// ============================================================================

/**
 * Split a fetch box entry into a structure ID and an optional chain selection.
 *
 *   1TIM        -> { id: '1TIM', chains: null }      whole structure
 *   1timA       -> { id: '1TIM', chains: ['A'] }
 *   1TIM_A      -> { id: '1TIM', chains: ['A'] }
 *   1tim_AB     -> { id: '1TIM', chains: ['A','B'] } one chain per character
 *   1tim:A,B    -> { id: '1TIM', chains: ['A','B'] } commas for multi-character IDs
 *   Q5VSL9      -> { id: 'Q5VSL9', chains: null }    UniProt, untouched
 *
 * Only a classic four-character PDB ID takes a chain suffix, and those start
 * with a DIGIT. That is what keeps a UniProt accession from being read as a PDB
 * ID plus chains - without it Q5VSL9 parses as 'Q5VS' chains L,9 and fetches the
 * wrong thing entirely.
 *
 * Chain IDs keep the case the user typed, because a PDB chain can be lower case
 * ('a' and 'A' are different chains in some entries); matching is tried
 * case-sensitively first and only then loosened.
 */
function parseFetchId(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/^([0-9][A-Za-z0-9]{3})[._:\-\s]*([A-Za-z0-9,]*)$/);
    if (!m) return { id: s.toUpperCase(), chains: null };
    const suffix = m[2] || '';
    if (!suffix) return { id: m[1].toUpperCase(), chains: null };
    const chains = suffix.indexOf(',') >= 0
        ? suffix.split(',').map((c) => c.trim()).filter(Boolean)
        : suffix.split('');
    return { id: m[1].toUpperCase(), chains: chains.length ? chains : null };
}

async function handleFetch() {
    const tempBatch = [];
    const parsedId = parseFetchId(document.getElementById('fetch-id').value);
    const fetchId = parsedId.id;
    const chainFilter = parsedId.chains;

    if (!fetchId) {
        setStatus("Please enter a PDB or UniProt ID.", true);
        return;
    }

    setStatus(chainFilter
        ? `Fetching ${fetchId} chain${chainFilter.length > 1 ? 's' : ''} `
            + `${chainFilter.join(', ')}...`
        : `Fetching ${fetchId} data...`);

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
        paeEnabled = window.viewerConfig.pae?.enabled && loadPAE;
    } else {
        // keep the selection in the object name so 1TIM and 1TIM_A can sit side
        // by side in the object list
        name = chainFilter ? `${fetchId}_${chainFilter.join('')}.cif` : `${fetchId}.cif`;
        structUrl = `https://files.rcsb.org/download/${fetchId}.cif`;
        paeUrl = null;
        paeEnabled = false;
    }

    beginProgress();
    try {
        const structResponse = await fetch(structUrl);
        if (!structResponse.ok) {
            throw new Error(`Failed to fetch structure (HTTP ${structResponse.status})`);
        }
        // READ THROUGH, so the download stage is measured too. The
        // server usually says how long the body is; when it does not, there is
        // no honest fraction to report and the stage just names itself.
        setStage('Downloading');
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

        const framesAdded = await buildPendingObject(
            structText,
            name,
            paeData,
            cleanObjectName(name),
            tempBatch,
            chainFilter
        );

        // Nothing parsed: buildPendingObject has already put the reason on
        // screen (an unknown chain, say). Stop here so the success lines below
        // cannot overwrite it with "loaded 0 object(s)", which reads like the
        // fetch worked and hides what actually went wrong.
        if (!framesAdded || tempBatch.length === 0) return;

        pendingObjects.push(...tempBatch);
        setStage('Drawing');
        await yieldToBrowser();
        applyPendingObjects();
        endProgress();

        // Auto-download MSA for PDB structures (only if Load MSA is enabled)
        if (isPDB && window.MSA && loadMSA) {
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
                            const chainSequences = MSA.extractSequences(firstFrame);

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

                                    // Download MSA from AlphaFold DB (using shared function)
                                    msaPromises.push(
                                        fetchMSAFromAlphaFold(uniprotId)
                                            .then(async (msaText) => {
                                                if (!msaText || msaText.trim().length === 0) {
                                                    console.warn(`Empty MSA file for UniProt ID ${uniprotId} (chain ${chainId})`);
                                                    return null;
                                                }

                                                // Parse MSA
                                                const msaData = window.MSA.parseA3M(msaText);

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
                                    const { chainToMSA, msaToChains } = matchMSAsToChains(msaDataList, chainSequences);

                                    // Initialize MSA structure for object (sequence-based, supports homo-oligomers)
                                    if (Object.keys(chainToMSA).length > 0) {
                                        // Store MSA data in object (consolidated function)
                                        const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);

                                        if (msaObj && msaObj.availableChains.length > 0) {

                                            // Get MSA for default chain
                                            const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                            const { msaData: matchedMSA } = msaObj.msasBySequence[defaultChainSeq];
                                            const firstMatchedChain = msaObj.defaultChain;

                                            // Also add MSA to pendingObjects for consistency and persistence
                                            const pendingObj = pendingObjects.find(obj => obj.name === objectName);
                                            if (pendingObj) {
                                                pendingObj.msa = {
                                                    msasBySequence: msaObj.msasBySequence,
                                                    chainToSequence: msaObj.chainToSequence,
                                                    availableChains: msaObj.availableChains,
                                                    defaultChain: msaObj.defaultChain,
                                                    msaToChains: msaObj.msaToChains
                                                };
                                            }

                                            // Show MSA container and view BEFORE loading data
                                            const msaContainer = document.getElementById('msa-buttons');
                                            if (msaContainer) {
                                                msaContainer.style.display = 'block';
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
        if (isAFDB && window.MSA && loadMSA) {
            try {
                const msaUrl = `https://alphafold.ebi.ac.uk/files/msa/AF-${fetchId}-F1-msa_v6.a3m`;
                setStatus(`Fetching MSA for ${fetchId}...`);

                const msaResponse = await fetch(msaUrl);
                if (msaResponse.ok) {
                    const msaText = await msaResponse.text();
                    if (msaText && msaText.trim().length > 0) {
                        // Parse MSA
                        const msaData = window.MSA.parseA3M(msaText);

                        if (msaData && msaData.querySequence) {
                            // Get the object that was just loaded
                            const objectName = cleanObjectName(name);
                            const renderer = viewerApi?.renderer;

                            if (renderer && renderer.objectsData && renderer.objectsData[objectName]) {
                                const object = renderer.objectsData[objectName];

                                if (object && object.frames && object.frames.length > 0) {
                                    // Extract chain sequences from first frame
                                    const firstFrame = object.frames[0];
                                    const chainSequences = MSA.extractSequences(firstFrame);

                                    if (Object.keys(chainSequences).length > 0) {
                                        // Match MSA to chains
                                        const msaDataList = [{ msaData, filename: `AF-${fetchId}-F1-msa_v6.a3m` }];
                                        const { chainToMSA, msaToChains } = matchMSAsToChains(msaDataList, chainSequences);

                                        // Initialize MSA structure for object (sequence-based, supports homo-oligomers)
                                        if (Object.keys(chainToMSA).length > 0) {
                                            // Store MSA data in object (consolidated function)
                                            const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);

                                            if (msaObj && msaObj.availableChains.length > 0) {

                                                // Get MSA for default chain
                                                const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                                const { msaData: matchedMSA } = msaObj.msasBySequence[defaultChainSeq];
                                                const firstMatchedChain = msaObj.defaultChain;

                                                // MSA properties (frequencies, logOdds) are computed when MSA is loaded

                                                // Also add MSA to pendingObjects for consistency and persistence
                                                const pendingObj = pendingObjects.find(obj => obj.name === objectName);
                                                if (pendingObj) {
                                                    pendingObj.msa = {
                                                        msasBySequence: msaObj.msasBySequence,
                                                        chainToSequence: msaObj.chainToSequence,
                                                        availableChains: msaObj.availableChains,
                                                        defaultChain: msaObj.defaultChain,
                                                        msaToChains: msaObj.msaToChains,
                                                    };
                                                }

                                                // Show MSA container and view BEFORE loading data
                                                const msaContainer = document.getElementById('msa-buttons');
                                                if (msaContainer) {
                                                    msaContainer.style.display = 'block';
                                                }

                                                // Force a layout recalculation to ensure container dimensions are available
                                                if (msaContainer) {
                                                    void msaContainer.offsetWidth; // Force reflow
                                                }

                                                // Load MSA into viewer
                                                window.MSA.setMSAData(matchedMSA, firstMatchedChain);

                                                // Map entropy from MSA
                                                if (viewerApi?.renderer && objectName) {
                                                    if (objectName && viewerApi.renderer.objectsData[objectName] && window.MSA) {
                                                        // ...for everything drawn - see entropyForDrawn
                                                        viewerApi.renderer.entropy = viewerApi.renderer.entropyForDrawn
                                                            ? viewerApi.renderer.entropyForDrawn()
                                                            : window.MSA.mapEntropyToStructure(viewerApi.renderer.objectsData[objectName], viewerApi.renderer.currentFrame >= 0 ? viewerApi.renderer.currentFrame : 0);
                                                        if (viewerApi.renderer._updateEntropyOptionVisibility) viewerApi.renderer._updateEntropyOptionVisibility();
                                                    }
                                                }

                                                // Ensure view is visible after data is set

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
    for (const [chainId, { msaData }] of Object.entries(chainToMSA)) {
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
 */
function loadMSADataIntoViewer(msaData, chainId, objectName, options = {}) {
    if (!window.MSA || !msaData) return;

    const {
        updateChainSelector = true
    } = options;

    // Load MSA data into viewer
    // NOTE: We do NOT mutate stored msaEntry.msaData - it remains the canonical unfiltered source
    // The viewer maintains its own filtered copy internally
    window.MSA.setMSAData(msaData, chainId);

    // Get filtered MSA data and recompute properties based on current filtering
    const filteredMSAData = window.MSA.getMSAData();
    if (filteredMSAData) {
        // Clear existing properties to force recomputation on filtered data
        filteredMSAData.frequencies = null;
        filteredMSAData.entropy = null;
        filteredMSAData.logOdds = null;
        // Compute properties
        MSA.computeMSAProperties(filteredMSAData);
    }

    // Update chain selector
    if (updateChainSelector && window.updateMSAChainSelectorIndex) {
        window.updateMSAChainSelectorIndex();
    }

    // Update sequence count to reflect the loaded MSA
    if (window.updateMSASequenceCount) {
        window.updateMSASequenceCount();
    }
    showMSACanvasContainers();

    // Apply filters to all MSAs (will update entropy for all chains)
    // This is deferred until needed - only computes entropy for other MSAs if they exist
    if (objectName && filteredMSAData) {
        const { coverageCutoff, identityCutoff } = getCurrentMSAFilters();
        applyFiltersToAllMSAs(objectName, {
            coverageCutoff,
            identityCutoff,
            activeChainId: chainId,
            activeFilteredMSAData: filteredMSAData
        });
    }

    // Ensure entropy colors stay in sync when new MSA data is loaded
    refreshEntropyColors();
}

/**
 * Compute and store frequencies and logOdds in MSA data
 * These properties are computed once and stored with the MSA for performance
 * @param {Object} msaData - MSA data object
 * @param {Array<boolean>} selectionMask - Optional mask indicating which positions to include (for dim mode)
 */


/**
 * Merge multiple MSAs that match the same chain
 * @param {Array} msaDataList - Array of {msaData, filename} objects
 * @returns {Object} - Merged MSA data object
 */
function mergeMSAs(msaDataList) {
    if (!msaDataList || msaDataList.length === 0) return null;
    if (msaDataList.length === 1) {
        // Compute properties for single MSA
        MSA.computeMSAProperties(msaDataList[0].msaData);
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
        const { msaData } = msaDataList[i];
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
    MSA.computeMSAProperties(mergedMSA);

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

    for (const { msaData, filename } of msaDataList) {
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
            MSA.computeMSAProperties(msaList[0].msaData);
            chainToMSA[chainId] = { msaData: msaList[0].msaData };
        }
    }

    // Update msaToChains to reflect merged MSAs
    // Group chains by their merged MSA query sequence
    const mergedMsaToChains = {};
    for (const [chainId, { msaData }] of Object.entries(chainToMSA)) {
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
 * @returns {Promise<Object>} - Mapping structure: {struct_asym_id: {uniprot_id: str, pdb_to_uniprot: {pdb_resnum: uniprot_resnum}, uniprot_to_pdb: {uniprot_resnum: pdb_resnum}}}
 *                              Uses struct_asym_id (mmCIF chain ID) not chain_id (author chain ID)
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
                // Use struct_asym_id for mmCIF chain identifiers (not chain_id which is author chain ID)
                const chainId = mapping.struct_asym_id;
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


/**
 * Apply current structure selection to MSA viewer
 * Maps structure positions to MSA positions and highlights them in the MSA viewer
 */
function applySelectionToMSA() {
    if (!viewerApi?.renderer || !window.MSA) return;

    const renderer = viewerApi.renderer;
    const objectName = renderer.currentObjectName;
    if (!objectName) return;

    const obj = renderer.objectsData[objectName];
    if (!obj || !obj.frames || obj.frames.length === 0) return;
    if (!obj.msa || !obj.msa.msasBySequence || !obj.msa.chainToSequence) return;

    const frame = obj.frames[renderer.currentFrame >= 0 ? renderer.currentFrame : 0];
    if (!frame || !frame.chains) return;

    // Get selected positions
    // The RESIDUE SELECTION, not visibility. This used to read the visibility
    // set, which worked only while a drag in the sequence view still set what
    // was visible. Now that selecting and showing are separate acts, sourcing
    // from visibility meant the MSA dimmed to whatever happened to be on screen
    // and ignored the selection entirely.
    // ...and in THIS OBJECT'S numbering: the MSA maps its columns onto the
    // object's own frame, while the selection is against whatever is loaded,
    // which with several objects merged is not the same array.
    const own = renderer.selectionForObject
        ? renderer.selectionForObject(objectName) : renderer.residueSelection;
    const selectedPositions = (own && own.size > 0) ? new Set(own) : new Set();

    // Nothing selected means nothing to point at, so no dimming - NOT "dim
    // everything", which is what an empty explicit visibility selection used to
    // mean here (it stood for Hide All).
    if (selectedPositions.size === 0) {
        obj.msa.selectedPositions = null; // null means all selected (no dimming)
        if (window.MSA && window.MSA.updateMSAViewSelectionState) {
            window.MSA.updateMSAViewSelectionState();
        }
        return;
    }

    // Determine allowed chains: the ones the SELECTION touches.
    //
    // This read `selection.chains`, and there is no `selection` here - the
    // variable went when this stopped sourcing from visibility (see the note
    // above) and the line was left behind. It threw a ReferenceError every time
    // a selection existed, which is every time this function has anything to
    // do, so the MSA never dimmed to the selection at all.
    let allowedChains = new Set();
    for (const i of selectedPositions) {
        const c = renderer.chains && renderer.chains[i];
        if (c) allowedChains.add(c);
    }
    if (allowedChains.size === 0) allowedChains = new Set(renderer.chains);

    // Map structure positions to MSA positions for each chain
    const msaSelectedPositions = new Map(); // chainId -> Set of MSA position indices

    for (const [chainId, querySeq] of Object.entries(obj.msa.chainToSequence)) {
        if (!allowedChains.has(chainId)) continue;

        const msaEntry = obj.msa.msasBySequence[querySeq];
        if (!msaEntry || !msaEntry.msaData) continue;

        const msaData = msaEntry.msaData;
        const msaQuerySequence = msaData.querySequence; // Query sequence has no gaps (removed during parsing)

        // Extract chain sequence from structure
        const chainSequences = MSA.extractSequences(frame);
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

    // Store selected MSA positions in object's MSA state (per-object storage)
    // Store even if empty to indicate no selection (for dimming all positions)
    obj.msa.selectedPositions = msaSelectedPositions;

    // Trigger MSA viewer update (only updates visual dimming, no filtering)
    if (window.MSA && window.MSA.updateMSAViewSelectionState) {
        window.MSA.updateMSAViewSelectionState();
    }
}

async function processFiles(files, loadAsFrames, groupName = null) {
    beginProgress();
    const tempBatch = [];
    let overallTotalFramesAdded = 0;
    let paePairedCount = 0;

    const structureFiles = [];
    const jsonFiles = [];
    const stateFiles = [];
    const msaFiles = [];
    const contactFiles = [];

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
        } else if (nameLower.endsWith('.cst')) {
            contactFiles.push(file);
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


    // Pre-extract all JSON files in parallel to avoid sequential decompression bottleneck
    let jsonFileDataArray = [];
    if (jsonFiles.length > 0) {
        const jsonFileDataPromises = jsonFiles.map(async (jsonFile) => {
            try {
                const jsonText = await jsonFile.readAsync("text");
                return { file: jsonFile, text: jsonText, error: null };
            } catch (e) {
                console.warn(`Failed to read JSON file ${jsonFile.name}:`, e);
                return { file: jsonFile, text: null, error: e };
            }
        });

        jsonFileDataArray = await Promise.all(jsonFileDataPromises);
    }

    // Now process all the extracted files in parallel
    const jsonContentsMap = new Map();
    const jsonLoadPromises = jsonFileDataArray.map(({ file: jsonFile, text: jsonText, error }) => new Promise(async (resolve) => {
        if (error || !jsonText) {
            resolve();
            return;
        }

        try {
            // Try fast PAE extraction first (avoids parsing entire JSON)
            const fastPae = fastExtractPaeFromText(jsonText);

            if (fastPae) {
                // Successfully extracted PAE directly, store it
                const jsonBaseName = jsonFile.name.replace(/\.json$/i, '');
                // Store as a minimal object with just the PAE data
                // Note: fastPae is now a Uint8Array
                jsonContentsMap.set(jsonBaseName, { data: fastPae, is_pae_extracted: true });
            } else {
                // Fall back to full JSON parse (for state files or non-PAE JSONs)
                const jsonObject = JSON.parse(jsonText);

                // Check if this is a state file (has objects array)
                if (jsonObject.objects && Array.isArray(jsonObject.objects)) {
                    stateFiles.push(jsonFile);
                } else {
                    // Regular PAE JSON file
                    const jsonBaseName = jsonFile.name.replace(/\.json$/i, '');
                    jsonContentsMap.set(jsonBaseName, jsonObject);
                }
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

    // Handle metadata-only uploads (no structure files) - check BEFORE MSA-only
    if (structureFiles.length === 0) {
        // Check if we're on msa.html (viewer hidden) - if so, skip metadata-to-existing check
        const viewerContainer = document.getElementById('viewer-container');
        const isViewerHidden = viewerContainer && window.getComputedStyle(viewerContainer).display === 'none';

        const hasMetadata = (loadMSA && msaFiles.length > 0) ||
            (loadPAE && jsonFiles.length > 0) ||
            contactFiles.length > 0;

        if (hasMetadata && !isViewerHidden) {
            // Add metadata to existing object (only on index.html where structures exist)
            const result = await addMetadataToExistingObject({
                msaFiles: loadMSA ? msaFiles : [],
                jsonFiles: loadPAE ? jsonFiles : [],
                contactFiles,
                loadMSA,
                loadPAE
            });
            return result;
        }
    }

    // Handle MSA-only input (no structure files)
    if (structureFiles.length === 0 && msaFilesToProcess.length > 0) {
        // Check if viewer is hidden (msa.html) - if so, allow MSA-only uploads
        const viewerContainer = document.getElementById('viewer-container');
        const isViewerHidden = viewerContainer && window.getComputedStyle(viewerContainer).display === 'none';

        if (isViewerHidden && msaFilesToProcess.length === 1) {
            // Load MSA-only for msa.html
            const msaFile = msaFilesToProcess[0];
            await loadStandaloneMSA(msaFile);
            return {
                objectsLoaded: 0,
                framesAdded: 0,
                structureCount: 0,
                paePairedCount: 0,
                isTrajectory: false
            };
        }

        setStatus('MSA-only uploads are not supported on this page. Please use msa.html for standalone MSAs.', true);
        return {
            objectsLoaded: 0,
            framesAdded: 0,
            structureCount: 0,
            paePairedCount: 0,
            isTrajectory: false
        };
    }

    // If we get here and still no structure files, throw error
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

            if (structRankMatch && jsonRankMatch && structRankMatch[1] === jsonRankMatch[1]) {
                modelNumBonus += 50;
            }

            const totalScore = score * 10 + nameHintScore + modelNumBonus;

            if (totalScore > bestScore) {
                // Check if it looks like PAE data without expensive flattening
                // We just check for existence of keys here
                let hasPae = false;
                if (paeJson.pae || paeJson.predicted_aligned_error) hasPae = true;
                else if (Array.isArray(paeJson) && paeJson.length > 0 && paeJson[0].predicted_aligned_error) hasPae = true;

                if (hasPae) {
                    bestScore = totalScore;
                    bestMatch = paeJson;
                }
            }
        }

        return bestMatch;
    }

    // Process structure files
    for (const file of structureFiles) {
        try {
            const text = await file.readAsync("text");

            const baseName = cleanObjectName(file.name);

            // Find matching PAE data
            const paeJson = getBestJsonMatch(baseName, jsonContentsMap);

            let paeData = null;
            if (paeJson) {
                // If it's already a Uint8Array (from worker or optimized path), use it directly
                if (paeJson instanceof Uint8Array) {
                    paeData = paeJson;
                } else {
                    // Otherwise extract it
                    paeData = extractPaeFromJSON(paeJson);
                }
                if (paeData) paePairedCount++;
            }

            const trajectoryObjectName = loadAsFrames && structureFiles.length > 1 ?
                (groupName || cleanObjectName(structureFiles[0].name)) :
                baseName;

            const framesAdded = await buildPendingObject(
                text,
                file.name,
                paeData,
                trajectoryObjectName,
                tempBatch
            );

            overallTotalFramesAdded += framesAdded;
        } catch (e) {
            console.error(`Error processing file ${file.name}:`, e);
            setStatus(`Error processing ${file.name}: ${e.message}`, true);
        }
    }

    // Process contact files and add to objects
    if (contactFiles.length > 0) {
        for (const contactFile of contactFiles) {
            try {
                const text = await contactFile.readAsync("text");
                const contacts = parseContactsFile(text);

                if (contacts.length > 0) {
                    // Try to match contact file to structure by name
                    const contactBaseName = contactFile.name.replace(/\.cst$/i, '').toLowerCase();
                    const matchingObject = tempBatch.find(obj => {
                        const objNameLower = obj.name.toLowerCase();
                        return objNameLower.includes(contactBaseName) ||
                            contactBaseName.includes(objNameLower) ||
                            structureFiles.some(sf => {
                                const sfBase = sf.name.replace(/\.(cif|pdb|ent)$/i, '').toLowerCase();
                                return contactBaseName.includes(sfBase) || sfBase.includes(contactBaseName);
                            });
                    });

                    if (matchingObject) {
                        // Clear any existing contacts and replace with new ones
                        matchingObject.contacts = contacts;
                    } else if (tempBatch.length > 0) {
                        // If no match, add to last object
                        const lastObject = tempBatch[tempBatch.length - 1];
                        lastObject.contacts = contacts;
                    }

                    // Note: Cache will be invalidated when applyPendingObjects() processes the object
                }
            } catch (e) {
                setStatus(`Error processing contacts file ${contactFile.name}: ${e.message}`, true);
            }
        }
    }

    if (tempBatch.length > 0) pendingObjects.push(...tempBatch);
    setStage('Drawing');
    await yieldToBrowser();
    applyPendingObjects();
    endProgress();

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
                const chainSequences = MSA.extractSequences(firstFrame);

                if (Object.keys(chainSequences).length === 0) {
                    setStatus("Warning: Could not extract sequences from structure. MSA matching skipped.", true);
                } else {
                    // Parse all MSA files and extract query sequences
                    const msaDataList = [];

                    for (const msaFile of msaFilesToProcess) {
                        try {
                            const msaText = await msaFile.readAsync("text");
                            const msaData = window.MSA ? window.MSA.parseA3M(msaText) : null;

                            if (msaData && msaData.querySequence) {
                                msaDataList.push({ msaData, filename: msaFile.name });
                            }
                        } catch (e) {
                            console.error(`Failed to parse MSA file ${msaFile.name}:`, e);
                        }
                    }

                    if (msaDataList.length > 0) {
                        // Match MSAs to chains by sequence
                        const { chainToMSA, msaToChains } = matchMSAsToChains(msaDataList, chainSequences);

                        // Store MSA data in object (consolidated function)
                        const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);

                        if (msaObj && msaObj.availableChains.length > 0) {
                            // Load default chain's MSA
                            const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                            if (defaultChainSeq && msaObj.msasBySequence[defaultChainSeq]) {
                                const { msaData } = msaObj.msasBySequence[defaultChainSeq];
                                if (window.MSA) {
                                    loadMSADataIntoViewer(msaData, msaObj.defaultChain, currentObjectName);
                                    setStatus(`Loaded MSAs: ${msaObj.availableChains.length} chain(s) matched to ${Object.keys(msaObj.msasBySequence).length} unique MSA(s)`);

                                    // Map entropy from MSA
                                    if (viewerApi?.renderer && currentObjectName) {
                                        if (currentObjectName && viewerApi.renderer.objectsData[currentObjectName] && window.MSA) {
                                            // ...for everything DRAWN - see entropyForDrawn
                                            viewerApi.renderer.entropy = viewerApi.renderer.entropyForDrawn
                                                ? viewerApi.renderer.entropyForDrawn()
                                                : window.MSA.mapEntropyToStructure(viewerApi.renderer.objectsData[currentObjectName], viewerApi.renderer.currentFrame >= 0 ? viewerApi.renderer.currentFrame : 0);
                                            if (viewerApi.renderer._updateEntropyOptionVisibility) viewerApi.renderer._updateEntropyOptionVisibility();
                                        }
                                    }

                                    // Update MSA container visibility and chain selector
                                    if (window.updateMSAContainerVisibility) {
                                        window.updateMSAContainerVisibility();
                                    }
                                    if (window.updateMSAChainSelectorIndex) {
                                        window.updateMSAChainSelectorIndex();
                                    }
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
                const loadMSA = loadMSACheckbox ? loadMSACheckbox.checked : false;

                // Skip MSA loading if checkbox is disabled
                if (!loadMSA) {
                    // Continue to next section without loading MSAs
                } else {

                    // Use sequence-based matching for all MSA files (same as processFiles)
                    const object = viewerApi.renderer.objectsData[targetObjectName];
                    if (object && object.frames && object.frames.length > 0) {
                        // Extract chain sequences from first frame
                        const firstFrame = object.frames[0];
                        const chainSequences = MSA.extractSequences(firstFrame);

                        if (Object.keys(chainSequences).length > 0) {
                            // Parse all MSA files and extract query sequences
                            const msaDataList = [];

                            for (const msaFile of allMSAFiles) {
                                try {
                                    const msaText = await msaFile.readAsync("text");
                                    const msaData = window.MSA ? window.MSA.parseA3M(msaText) : null;

                                    if (msaData && msaData.querySequence) {
                                        msaDataList.push({ msaData, filename: msaFile.name });
                                    }
                                } catch (e) {
                                    console.error(`Failed to parse MSA file ${msaFile.name}:`, e);
                                }
                            }

                            if (msaDataList.length > 0) {
                                // Match MSAs to chains by sequence
                                const { chainToMSA, msaToChains } = matchMSAsToChains(msaDataList, chainSequences);

                                // Store MSA data in object (consolidated function)
                                const msaObj = storeMSADataInObject(object, chainToMSA, msaToChains);

                                if (msaObj && msaObj.availableChains.length > 0) {
                                    // Load default chain's MSA
                                    const defaultChainSeq = msaObj.chainToSequence[msaObj.defaultChain];
                                    if (defaultChainSeq && msaObj.msasBySequence[defaultChainSeq]) {
                                        const { msaData } = msaObj.msasBySequence[defaultChainSeq];
                                        if (window.MSA) {
                                            loadMSADataIntoViewer(msaData, msaObj.defaultChain, targetObjectName);
                                            setStatus(`Loaded MSAs: ${msaObj.availableChains.length} chain(s) matched to ${Object.keys(msaObj.msasBySequence).length} unique MSA(s)`);

                                            // Update MSA container visibility and chain selector
                                            if (window.updateMSAContainerVisibility) {
                                                window.updateMSAContainerVisibility();
                                            }
                                            if (window.updateMSAChainSelectorIndex) {
                                                window.updateMSAChainSelectorIndex();
                                            }
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
                                const msaData = window.MSA ? window.MSA.parseA3M(msaText) : null;
                                if (msaData && window.MSA) {
                                    window.MSA.setMSAData(msaData);
                                    setStatus(`Loaded MSA from ${firstMSAFile.name}. Load structure to match to chains.`);
                                }
                            } catch (e) {
                                console.error(`Failed to parse MSA file:`, e);
                            }
                        }
                    }
                }
            } // Close else block for loadMSA check
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
    const csvFiles = [];

    for (const file of files) {
        if (file.name.toLowerCase().endsWith('.zip')) {
            zipFiles.push(file);
        } else if (file.name.toLowerCase().endsWith('.csv')) {
            csvFiles.push(file);
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

                // Process CSV files after structure files are loaded
                if (csvFiles.length > 0) {
                    processCSVFiles(csvFiles);
                }
            } catch (e) {
                console.error("Loose file processing failed:", e);
                setStatus(`Error processing loose files: ${e.message}`, true);
            }
        })();
    } else if (csvFiles.length > 0) {
        // Only CSV files uploaded, process them directly
        processCSVFiles(csvFiles);
    }
}

// Process CSV files for scatter plot
function processCSVFiles(csvFiles) {
    if (csvFiles.length === 0) return;

    // Process first CSV file (ignore additional ones)
    const csvFile = csvFiles[0];
    const reader = new FileReader();

    reader.onload = (e) => {
        try {
            const csvText = e.target.result;
            parseAndLoadScatterData(csvText);

            if (csvFiles.length > 1) {
                setStatus(`Loaded scatter data from ${csvFile.name}. Additional CSV files ignored.`);
            } else {
                setStatus(`Loaded scatter data from ${csvFile.name}`);
            }
        } catch (error) {
            console.error("Error loading CSV:", error);
            setStatus(`Error loading CSV: ${error.message}`, true);
        }
    };

    reader.readAsText(csvFile);
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
// SCATTER PLOT HANDLING
// ============================================================================

function parseAndLoadScatterData(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
        throw new Error("CSV must have at least a header row and one data row");
    }

    // Parse header (first row)
    const header = lines[0].split(',').map(h => h.trim());
    if (header.length < 2) {
        throw new Error("CSV must have at least 2 columns");
    }

    const xLabel = header[0];
    const yLabel = header[1];

    // Parse data rows
    const xData = [];
    const yData = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        if (values.length < 2) continue;

        const x = parseFloat(values[0]);
        const y = parseFloat(values[1]);

        if (!isNaN(x) && !isNaN(y)) {
            xData.push(x);
            yData.push(y);
        }
    }

    if (xData.length === 0) {
        throw new Error("No valid data points found in CSV");
    }

    // Create or update scatter viewer
    const scatterCanvas = document.getElementById('scatterCanvas');
    if (!scatterCanvas) {
        throw new Error("Scatter canvas not found");
    }
    const scatterContainer = document.getElementById('scatterContainer');

    // Apply sizing consistent with viewer-mol scatter setup and attach ResizeObserver
    const scatterDisplaySize = (window.viewerConfig?.scatter?.size) || 300;
    const currentDPR = Math.min(window.devicePixelRatio || 1, 1.5);
    const scatterDPR = Math.max(2, currentDPR * 2);
    const showBox = window.viewerConfig?.display?.box !== false;

    const applyScatterSize = (w, h) => {
        const borderAdjust = 2; // account for 1px border on container
        const innerW = Math.max(10, w - borderAdjust);
        const innerH = Math.max(10, h - borderAdjust);
        scatterCanvas.width = innerW * scatterDPR;
        scatterCanvas.height = innerH * scatterDPR;
        scatterCanvas.style.width = `${innerW}px`;
        scatterCanvas.style.height = `${innerH}px`;
        if (scatterViewer) {
            scatterViewer.render();
        }
    };

    applyScatterSize(scatterDisplaySize, scatterDisplaySize);

    if (scatterContainer) {
        scatterContainer.style.width = `${scatterDisplaySize}px`;
        scatterContainer.style.height = `${scatterDisplaySize}px`;
        scatterContainer.style.padding = '0px';
        scatterContainer.style.display = 'flex';
        scatterContainer.classList.add('scatter-container');
        if (!showBox) {
            scatterContainer.classList.add('box-off');
        } else {
            scatterContainer.classList.remove('box-off');
        }

        if (window.ResizeObserver && !scatterContainer._scatterResizeObserver) {
            let lastW = scatterDisplaySize;
            let lastH = scatterDisplaySize;
            const observer = new ResizeObserver(entries => {
                if (!entries || entries.length === 0) return;
                const rect = entries[0].contentRect || {};
                const newW = Math.max(rect.width || scatterDisplaySize, 1);
                const newH = Math.max(rect.height || scatterDisplaySize, 1);
                if (Math.abs(newW - lastW) < 0.5 && Math.abs(newH - lastH) < 0.5) return;
                lastW = newW;
                lastH = newH;
                applyScatterSize(newW, newH);
            });
            observer.observe(scatterContainer);
            scatterContainer._scatterResizeObserver = observer;
        }
    }

    if (!scatterViewer && viewerApi?.renderer) {
        scatterViewer = new ScatterPlotViewer(scatterCanvas, viewerApi.renderer);
        // CRITICAL: Register scatter renderer with main renderer for recording
        viewerApi.renderer.setScatterRenderer(scatterViewer);
    }

    if (scatterViewer) {
        scatterViewer.setData(xData, yData, xLabel, yLabel);
        scatterCanvas.style.display = 'block';

        // Show scatter container if hidden
        if (scatterContainer) {
            scatterContainer.style.display = 'block';
        }

        // IMPORTANT: Store scatter data in frames (matching Python interface)
        // This ensures scatter data is saved when saving state
        if (viewerApi?.renderer?.currentObjectName) {
            const currentObj = viewerApi.renderer.objectsData[viewerApi.renderer.currentObjectName];
            if (currentObj && currentObj.frames) {
                // Store scatter data in each frame as [x, y]
                for (let i = 0; i < currentObj.frames.length && i < xData.length; i++) {
                    currentObj.frames[i].scatter = [xData[i], yData[i]];
                }

                // Store scatter labels in object-specific config (camelCase)
                if (!currentObj.scatterConfig) {
                    currentObj.scatterConfig = {};
                }
                currentObj.scatterConfig.xlabel = xLabel;
                currentObj.scatterConfig.ylabel = yLabel;

                // Immediately refresh scatter plot with stored metadata/data
                if (viewerApi.renderer.scatterRenderer) {
                    viewerApi.renderer.updateScatterData(viewerApi.renderer.currentObjectName);
                }
            } else {
                console.warn('[SCATTER CSV] Cannot store - currentObj or frames missing:', {
                    currentObj: !!currentObj,
                    frames: currentObj?.frames?.length
                });
            }
        }

        // Note: Scatter visibility is now controlled per-object based on actual data
        // No need to set global scatter.enabled = true here
    }
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
    for (const field of ['chains', 'position_types', 'bonds']) {
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
                // the file this frame came from, so a reloaded session can still
                // say which one you are looking at
                if (frame.name) frameData.name = frame.name;
                if (frame.position_types) frameData.position_types = frame.position_types;
                if (frame.residue_numbers) frameData.residue_numbers = frame.residue_numbers;
                if (frame.position_atoms) frameData.position_atoms = frame.position_atoms;
                if (frame.position_elements) frameData.position_elements = frame.position_elements;
                if (frame.bonds) frameData.bonds = frame.bonds;
                if (frame.scatter) frameData.scatter = frame.scatter;
                if (frame.color) frameData.color = frame.color;

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

                // Handle PAE data (Uint8Array, flattened array, or 2D array)
                if (frame.pae) {
                    if (frame.pae instanceof Uint8Array) {
                        // Convert Uint8Array to regular array for JSON serialization
                        // It is already flattened and scaled (0-255)
                        frameData.pae = Array.from(frame.pae);
                    } else if (Array.isArray(frame.pae) && frame.pae.length > 0 && typeof frame.pae[0] === 'number') {
                        // Already a flattened array (e.g. from Python or loaded state)
                        frameData.pae = frame.pae;
                    } else if (Array.isArray(frame.pae) && frame.pae.length > 0 && Array.isArray(frame.pae[0])) {
                        // Legacy 2D array - round to 1 decimal place
                        frameData.pae = frame.pae.map(row =>
                            row.map(val => Math.round(val * 10) / 10)
                        );
                    }
                }

                // SIDE CHAINS - the WHOLE table, so a reloaded session can turn
                // one on that was not showing when it was saved. Trimmed rather
                // than cut down: see trimSidechainTable.
                if (frame.sidechains && typeof trimSidechainTable === 'function') {
                    const trimmed = trimSidechainTable(frame.sidechains);
                    if (trimmed) frameData.sidechains = trimmed;
                }

                frameDataList.push(frameData);
            }

            // Detect redundant fields (same across all frames)
            const redundant = detectRedundantFields(frameDataList);

            // Remove redundant fields from frames (only if identical)
            const frames = [];
            for (const frameData of frameDataList) {
                const cleanedFrame = { ...frameData };
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
                hasPAE: checkObjectHasPAE({ frames: frames })
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

            // Add contacts data if it exists
            if (objectData.contacts && Array.isArray(objectData.contacts) && objectData.contacts.length > 0) {
                objToSave.contacts = objectData.contacts;
            }

            // Add scatter config if it exists (camelCase internal)
            const scatterCfg = objectData.scatterConfig;
            if (scatterCfg) {
                objToSave.scatter_config = scatterCfg;
            }

            // Which residues show a side chain, and any colour of their own.
            // A Set does not survive JSON, so it goes as an array.
            if (objectData.sidechains && objectData.sidechains.size) {
                objToSave.sidechains = Array.from(objectData.sidechains);
            }
            // Which nucleotides show a base plate. Saved whenever the set
            // EXISTS, empty included: an empty set means "none", which is a
            // real choice and the opposite of the absent-means-all default. The
            // side-chain line above can test `.size` because there null and
            // empty mean the same thing there; here they do not.
            if (objectData.bases instanceof Set) {
                objToSave.bases = Array.from(objectData.bases);
            }
            // ...and which residues show element colours. Same rule: saved
            // whenever the set EXISTS, empty included, because absent means all.
            if (objectData.elements instanceof Set) {
                objToSave.elements = Array.from(objectData.elements);
            }
            // ...and whose backbone is hidden. Absent means none, so this one
            // is only worth writing when there is something in it.
            if (objectData.hiddenBackbone instanceof Set
                && objectData.hiddenBackbone.size) {
                objToSave.hidden_backbone = Array.from(objectData.hiddenBackbone);
            }
            if (objectData.sidechainColor) {
                objToSave.sidechain_color = objectData.sidechainColor;
            }

            // Add color overrides if they exist
            if (objectData.color) {
                objToSave.color = objectData.color;
            }
            // secondary structure travels with the object, like colour
            if (objectData.sse) {
                objToSave.sse = objectData.sse;
            }

            // Add per-object viewerState if it exists
            if (objectData.viewerState) {
                // If this is the current object, use the live viewerState to ensure it's up-to-date
                // (The one in objectsData is only updated when switching AWAY from the object)
                const isCurrent = objectName === renderer.currentObjectName;
                const sourceState = isCurrent ? renderer.viewerState : objectData.viewerState;

                // THE CLIP AND THE STYLE LIVE ON THE RENDERER while an object
                // is the current one, and in its stored viewerState the rest
                // of the time - _switchToObject moves them across. Saving only
                // the fields that live in viewerState both times lost them:
                // a session came back unclipped, and every object came back in
                // whatever style the session as a whole was saved in.
                const held = isCurrent ? renderer : sourceState;
                objToSave.viewerState = {
                    rotation: sourceState.rotation,
                    zoom: sourceState.zoom,
                    ortho: sourceState.ortho,
                    focalLength: sourceState.focalLength,
                    center: sourceState.center,
                    extent: sourceState.extent,
                    currentFrame: sourceState.currentFrame,
                    clipNear: held.clipNear !== undefined ? held.clipNear : null,
                    clipFar: held.clipFar !== undefined ? held.clipFar : null,
                    clipFade: held.clipFade,
                    style: held.style || null,
                    styleChosen: !!held.styleChosen
                };
            }

            objects.push(objToSave);
        }

        // Get viewer state
        const orthoSlider = document.getElementById('orthoSlider');
        const orthoSliderValue = orthoSlider ? parseFloat(orthoSlider.value) : 0.5;

        // Get detect_cyclic from config
        const detectCyclic = (window.viewerConfig && typeof window.viewerConfig.rendering?.detect_cyclic === 'boolean')
            ? window.viewerConfig.rendering.detect_cyclic
            : true;

        const viewerState = {
            current_object_name: renderer.currentObjectName,
            // WHICH OBJECTS WERE ON SCREEN. Null is the default - the object
            // being edited, alone - and is not restored as anything, so a
            // session saved that way opens exactly as it always has. An array
            // is what the user chose, including an empty one.
            shown_objects: (renderer.shownObjects instanceof Set)
                ? Array.from(renderer.shownObjects) : null,
            current_frame: renderer.viewerState.currentFrame,  // From viewerState, not global
            rotation_matrix: renderer.viewerState.rotation,
            zoom: renderer.viewerState.zoom,
            ortho: renderer.viewerState.ortho,  // 0-1; below 1 means perspective
            focal_length: renderer.viewerState.focalLength,  // NEW
            center: renderer.viewerState.center,  // NEW - for orient to selection
            extent: renderer.viewerState.extent,  // NEW - for orient to selection
            color_mode: renderer.colorMode || 'auto',
            // the SSE palette is a separate axis from the colour MODE:
            // restoring mode 'ss' without it put the ribbon back on the
            // default palette whatever had been picked
            ss_palette: renderer.ssPalette || 'pymol',
            line_width: renderer.lineWidth || 3.0,
            shadow_enabled: renderer.shadowEnabled !== false,
            shade: renderer.cartoonShade !== undefined ? renderer.cartoonShade : 1,
            outline_mode: renderer.outlineMode || 'full',
            colorblind_mode: renderer.colorblindMode || false,
            detect_cyclic: detectCyclic,
            ortho_slider_value: orthoSliderValue, // Save the normalized slider value (0.0-1.0)
            animation_speed: renderer.animationSpeed || 100,
            // Render style and its controls. These live on the renderer, not in
            // window.viewerConfig (which only ever holds the values the viewer
            // STARTED with), so saving the config alone would reload a session
            // as whatever style it was first opened in.
            style: renderer.style || 'tube',
            // the preset is a separate axis from the style ('cartoon' can be
            // showing richardson or 3d values), and applying one overwrites
            // the sliders - so it is restored BEFORE them, like style
            preset: renderer.stylePreset || 'richardson',
            thickness: renderer.cartoonThickness,
            detail: renderer.cartoonDetail,
            smooth: renderer.cartoonSmooth === true,
            use_gpu: renderer.useGPU === true,
            arrows: renderer.cartoonArrows !== false,
            sheet_flat: renderer.cartoonSheetFlat,
            pencil: renderer.cartoonPencil,
            highlight: renderer.cartoonHighlight,
            outline_tint: renderer.cartoonOutlineTint
        };

        // Save MSA state (current chain) - only if MSA data actually exists
        if (window.MSA) {
            // Check if there's actual MSA data in the viewer
            const msaData = window.MSA.getMSAData ? window.MSA.getMSAData() : null;
            // Also check if any objects have MSA data
            const hasObjectMSA = Object.values(renderer.objectsData).some(obj => obj.msa != null);

            // Only save msa_chain if there's actual MSA data
            if (msaData || hasObjectMSA) {
                const currentChain = window.MSA.getCurrentChain ? window.MSA.getCurrentChain() : null;
                if (currentChain) {
                    viewerState.msa_chain = currentChain;
                }
            }
        }

        // Get selection state for ALL objects
        const selectionsByObject = {};
        for (const [objectName, objectData] of Object.entries(renderer.objectsData)) {
            if (objectData.visibilityState) {
                selectionsByObject[objectName] = {
                    positions: Array.from(objectData.visibilityState.positions),
                    chains: Array.from(objectData.visibilityState.chains),
                    pae_boxes: objectData.visibilityState.paeBoxes.map(box => ({ ...box })),
                    selection_mode: objectData.visibilityState.visibilityMode
                };
            }
        }

        // Create state object
        // THE CONFIG IS BROUGHT UP TO DATE BEFORE IT IS WRITTEN.
        //
        // window.viewerConfig holds the values the viewer STARTED with, and
        // saving it as-is put a stale copy of every render setting in the file
        // beside the live one: a session showing a cartoon recorded
        // `config.rendering.style: "tube"` next to `viewer_state.style:
        // "cartoon"`, which reads as a bug in the file and is the first thing
        // anyone opening it notices.
        //
        // It cannot simply be dropped: py2Dmol/viewer.py does
        // `self.config = state_data["config"]` when it loads a state, so a
        // session opened in Python takes its whole configuration from here.
        // Made to AGREE instead - one set of values, written twice for two
        // readers, rather than two sets that disagree.
        const savedConfig = window.viewerConfig
            ? JSON.parse(JSON.stringify(window.viewerConfig)) : {};
        savedConfig.rendering = { ...(savedConfig.rendering || {}),
            style: viewerState.style,
            preset: viewerState.preset,
            thickness: viewerState.thickness,
            detail: viewerState.detail,
            smooth: viewerState.smooth,
            arrows: viewerState.arrows,
            sheet_flat: viewerState.sheet_flat,
            pencil: viewerState.pencil,
            highlight: viewerState.highlight,
            outline_tint: viewerState.outline_tint,
            outline: viewerState.outline_mode,
            width: viewerState.line_width,
            shade: viewerState.shade,
            shadow: viewerState.shadow_enabled,
            ortho: viewerState.ortho_slider_value,
        };
        savedConfig.color = { ...(savedConfig.color || {}),
            mode: viewerState.color_mode,
            colorblind: viewerState.colorblind_mode,
        };

        const stateData = {
            version: "2.0",  // Version for nested config format
            config: savedConfig,
            objects: objects,
            // `current_object` is what py2Dmol/viewer.py reads; the web reads
            // viewer_state.current_object_name. Both are written so a file
            // saved here opens in Python on the right object - the two sides
            // claimed the same version "2.0" while disagreeing about the
            // envelope, so neither could open the other's files properly.
            current_object: renderer.currentObjectName || null,
            viewer_state: viewerState,
            selections_by_object: selectionsByObject
        };

        // Create filename with timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const jsonFilename = `py2dmol_state_${timestamp}.json`;

        // NOT PRETTY-PRINTED. Two-space indentation on a session file is
        // between two and four times the payload, and nothing reads these by
        // hand: the app parses them back, and at this size no editor opens one
        // anyway. Measured on 7Y7A - 305,004 positions, 1,065,107 side-chain
        // rows - the indentation alone was 153 MB of a 212 MB file.
        const jsonString = JSON.stringify(stateData);

        // Download JSON file
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
    } catch (e) {
        console.error("Failed to save state:", e);
        setStatus(`Error saving state: ${e.message}`, true);
    }
}

// ============================================================================
// SVG EXPORT
// ============================================================================
// Image export is now handled by renderer.saveImage() in viewer-mol.js
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
                const objBonds = objData.bonds;
                const objScatterConfig = objData.scatter_config;

                renderer.addObject(objData.name);

                // Restore scatter config at object level
                if (objScatterConfig) {
                    renderer.objectsData[objData.name].scatterConfig = objScatterConfig;
                }

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
                        scatter: frameData.scatter,  // undefined if missing (will use inheritance or default)
                        position_names: frameData.position_names,  // undefined if missing (will default)
                        position_atoms: frameData.position_atoms,  // ligands only; undefined elsewhere
                        position_elements: frameData.position_elements,
                        residue_numbers: frameData.residue_numbers,  // undefined if missing (will default)
                        bonds: frameData.bonds || objBonds,  // undefined if both missing
                        // The THIRD field-by-field frame build in this codebase
                        // (frameObj on load, extractedFrame on copy, this one on
                        // restore), and side chains have been dropped by two of
                        // them already. JSON has no typed arrays, so the numeric
                        // columns come back plain and are put back into shape.
                        sidechains: reviveSidechainTable(frameData.sidechains),
                        // ...and which file it came from, or a restored session
                        // knows the frames' names no better than before they
                        // were kept - which is the fault this comment warns of,
                        // one field along.
                        name: frameData.name,
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

                                // Recompute properties (frequencies, logOdds, positionIndex)
                                if (window.MSA && typeof window.MSA.computeMSAProperties === 'function') {
                                    window.MSA.computeMSAProperties(restoredMSAData);
                                }
                            }
                        }
                    }
                }

                // Store contacts data if present
                if (objData.contacts && Array.isArray(objData.contacts) && objData.contacts.length > 0) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    renderer.objectsData[objData.name].contacts = objData.contacts;
                    // Invalidate segment cache so contacts will be regenerated when object is displayed
                    renderer.cachedSegmentIndices = null;
                }

                // Restore color overrides if present
                if (objData.color) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    renderer.objectsData[objData.name].color = objData.color;
                }

                // ... and secondary structure, which lives beside it
                if (objData.sse) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    renderer.objectsData[objData.name].sse = objData.sse;
                }

                // ... and which residues were showing a side chain. Back to a
                // Set: everything downstream asks it .has(). Only the residues
                // whose ATOMS were saved can be shown, and the panel already
                // reflects that on its own - hasSidechainsFor finds nothing for
                // the others, so the Side chains row is simply not offered.
                if (objData.sidechains && objData.sidechains.length) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    renderer.objectsData[objData.name].sidechains = new Set(objData.sidechains);
                }
                // ...and the bases, where an empty array is meaningful: it
                // says every plate was hidden, which absent does not.
                if (Array.isArray(objData.elements)) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    renderer.objectsData[objData.name].elements = new Set(objData.elements);
                }
                if (Array.isArray(objData.bases)) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    renderer.objectsData[objData.name].bases = new Set(objData.bases);
                }
                if (Array.isArray(objData.hidden_backbone)) {
                    renderer.objectsData[objData.name].hiddenBackbone
                        = new Set(objData.hidden_backbone);
                }
                if (objData.sidechain_color) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    renderer.objectsData[objData.name].sidechainColor = objData.sidechain_color;
                }

                // Restore per-object viewerState if present
                if (objData.viewerState) {
                    if (!renderer.objectsData[objData.name]) {
                        renderer.objectsData[objData.name] = {};
                    }
                    const vs = objData.viewerState;
                    renderer.objectsData[objData.name].viewerState = {
                        rotation: vs.rotation,
                        zoom: vs.zoom,
                        ortho: vs.ortho,
                        focalLength: vs.focalLength,
                        center: vs.center,
                        extent: vs.extent,
                        currentFrame: vs.currentFrame,
                        // ...and what _switchToObject moves on and off the
                        // renderer. Absent in a session saved before these were
                        // written, which reads as "never set" - the same thing
                        // an object that has never been clipped says.
                        clipNear: (typeof vs.clipNear === 'number') ? vs.clipNear : null,
                        clipFar: (typeof vs.clipFar === 'number') ? vs.clipFar : null,
                        clipFade: vs.clipFade,
                        style: vs.style || null,
                        styleChosen: !!vs.styleChosen
                    };
                }
            }
        } else {
            setStatus("Error: No valid objects found in state file.", true);
            return;
        }

        // Restore config (v2.0 nested format)
        if (stateData.config) {
            // Merge saved config with current config (preserving ui settings)
            if (stateData.config.scatter) {
                window.viewerConfig.scatter = {
                    enabled: stateData.config.scatter.enabled || false,
                    size: stateData.config.scatter.size || 300,
                    xlabel: stateData.config.scatter.xlabel || null,
                    ylabel: stateData.config.scatter.ylabel || null,
                    xlim: stateData.config.scatter.xlim || null,
                    ylim: stateData.config.scatter.ylim || null
                };
            }
            if (stateData.config.pae) {
                window.viewerConfig.pae = {
                    enabled: stateData.config.pae.enabled !== false,
                    size: stateData.config.pae.size || 300
                };
            }
            // Other config sections can be restored here if needed

            // Sync restored config to py2dmol_configs
            window.syncViewerConfig();
        }

        // Re-initialize scatter plot if scatter data exists and is enabled
        if (window.viewerConfig?.scatter?.enabled) {
            const scatterCanvas = document.getElementById('scatterCanvas');
            if (scatterCanvas && renderer.currentObjectName) {
                const currentObj = renderer.objectsData[renderer.currentObjectName];
                if (currentObj && currentObj.frames && currentObj.frames.length > 0) {
                    // Collect scatter data from frames
                    const xData = [];
                    const yData = [];

                    for (const frame of currentObj.frames) {
                        if (frame.scatter && Array.isArray(frame.scatter) && frame.scatter.length === 2) {
                            xData.push(frame.scatter[0]);
                            yData.push(frame.scatter[1]);
                        } else {
                            // Frame has no scatter data - use NaN or previous value
                            xData.push(NaN);
                            yData.push(NaN);
                        }
                    }

                    // Initialize scatter viewer if we have data
                    if (xData.some(x => !isNaN(x))) {
                        if (!scatterViewer) {
                            scatterViewer = new ScatterPlotViewer(scatterCanvas, renderer);
                        }

                        // Get labels from object-specific config (camelCase, fallback to legacy)
                        const cfg = currentObj.scatterConfig || {};
                        const xlabel = cfg.xlabel || 'X';
                        const ylabel = cfg.ylabel || 'Y';
                        const xlim = cfg.xlim || null;
                        const ylim = cfg.ylim || null;

                        scatterViewer.setData(xData, yData, xlabel, ylabel);

                        // Apply limits if provided
                        if (xlim && Array.isArray(xlim) && xlim.length === 2) {
                            scatterViewer.xMin = xlim[0];
                            scatterViewer.xMax = xlim[1];
                        }
                        if (ylim && Array.isArray(ylim) && ylim.length === 2) {
                            scatterViewer.yMin = ylim[0];
                            scatterViewer.yMax = ylim[1];
                        }

                        scatterViewer.render();

                        // Show scatter container
                        const scatterContainer = document.getElementById('scatterContainer');
                        if (scatterContainer) {
                            scatterContainer.style.display = 'block';
                        }
                        scatterCanvas.style.display = 'block';
                    }
                }
            }
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
                renderer.viewerState.rotation = vs.rotation_matrix;
            }

            // Restore zoom
            if (typeof vs.zoom === 'number') {
                renderer.viewerState.zoom = vs.zoom;
            }

            // Restore currentFrame to viewerState (and keep global in sync)
            if (typeof vs.current_frame === 'number') {
                renderer.viewerState.currentFrame = vs.current_frame;
                renderer.currentFrame = vs.current_frame;
            }

            // Restore the ortho value (the slider below overrides it when saved).
            // `perspective_enabled` is what older saves carry; false meant fully
            // orthographic, true meant some perspective without recording how
            // much, so it lands on the default.
            if (typeof vs.ortho === 'number') {
                renderer.viewerState.ortho = vs.ortho;
            } else if (typeof vs.perspective_enabled === 'boolean') {
                renderer.viewerState.ortho = vs.perspective_enabled ? 0.5 : 1;
            }

            // Restore focal length (will be overridden by ortho slider if present)
            if (typeof vs.focal_length === 'number') {
                renderer.viewerState.focalLength = vs.focal_length;
            }

            // Restore center (from orient to selection)
            if (vs.center !== undefined && vs.center !== null) {
                renderer.viewerState.center = vs.center;
            }

            // Restore extent (from orient to selection)
            if (typeof vs.extent === 'number') {
                renderer.viewerState.extent = vs.extent;
            }

            // Restore render style BEFORE the individual controls: setStyle
            // applies that style's preset, which would otherwise overwrite the
            // values restored below.
            if (typeof vs.style === 'string' && vs.style !== renderer.style) {
                renderer.styleChosen = true;   // a saved view says what it wants
                renderer.setStyle(vs.style);   // no-ops on an unknown/unloaded style
                // setStyle syncs the dropdown itself. Assigning renderer.style
                // here used to leave the select BLANK, because 'richardson' was
                // a style value with no matching option; richardson is a preset
                // now, but letting setStyle own the dropdown is still right.
            }
            if (typeof vs.preset === 'string'
                && vs.preset !== renderer.stylePreset
                && typeof renderer.setPreset === 'function') {
                renderer.setPreset(vs.preset);   // warns and no-ops on a bad name
            }
            // Cartoon controls. Each is only restored when present, so a state
            // file written before these existed keeps the style's own defaults.
            const restoreCartoon = (key, prop, id, kind) => {
                const v = vs[key];
                if (kind === 'bool' ? typeof v !== 'boolean' : typeof v !== 'number') return;
                renderer[prop] = v;
                const el = document.getElementById(id);
                if (!el) return;
                if (kind === 'bool') el.checked = v; else el.value = v;
            };
            restoreCartoon('thickness', 'cartoonThickness', 'thicknessSlider');
            restoreCartoon('detail', 'cartoonDetail', 'detailSlider');
            restoreCartoon('sheet_flat', 'cartoonSheetFlat', 'sheetFlatSlider');
            restoreCartoon('pencil', 'cartoonPencil', 'pencilSlider');
            restoreCartoon('highlight', 'cartoonHighlight', 'highlightSlider');
            restoreCartoon('outline_tint', 'cartoonOutlineTint', 'outlineTintSlider');
            restoreCartoon('shade', 'cartoonShade', 'shadeSlider');
            restoreCartoon('smooth', 'cartoonSmooth', 'smoothCheckbox', 'bool');
            restoreCartoon('use_gpu', 'useGPU', 'useGpuCheckbox', 'bool');
            restoreCartoon('arrows', 'cartoonArrows', 'arrowsCheckbox', 'bool');

            // Restore color mode
            if (vs.color_mode) {
                // Registry lookup, not a hardcoded list: plugin modes such as
                // 'ss' (viewer-cartoon.js) are valid too, and were being
                // silently dropped on load.
                const validModes = getAllValidColorModes();
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

            // Restore the SSE palette. After colour mode, because the palette
            // row only shows while the mode is 'ss', and the panel sync reads
            // both. Validated against the plugin's own table so an unknown name
            // from an older state file cannot leave the renderer pointing at a
            // palette that does not exist.
            if (typeof vs.ss_palette === 'string') {
                const table = window.py2dmolCartoon
                    && window.py2dmolCartoon.SS_PALETTES;
                if (table && table[vs.ss_palette]) {
                    renderer.ssPalette = vs.ss_palette;
                    renderer.colorsNeedUpdate = true;
                    renderer.plddtColorsNeedUpdate = true;
                    if (renderer._syncStylePanel) renderer._syncStylePanel();
                    document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
                    renderer.render('ss_palette restore');
                }
            }

            // Restore line width. NO SYNTHETIC EVENT - the same shape as
            // restoreCartoon() above, and for a reason that bit: the slider's
            // handler records a real drag as this style's chosen width
            // (_widthByStyle), after which the style's own profile width no
            // longer applies. Dispatching one here would make every load look
            // like a choice. Setting the property and the element directly is
            // what every other restored control does.
            if (typeof vs.line_width === 'number') {
                renderer.lineWidth = vs.line_width;
                const lineWidthSlider = document.getElementById('lineWidthSlider');
                if (lineWidthSlider) lineWidthSlider.value = vs.line_width;
            }

            // Restore shadow
            if (typeof vs.shadow_enabled === 'boolean') {
                renderer.shadowEnabled = vs.shadow_enabled;
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

            // Restore detect_cyclic - check both Python config format and web viewer_state format
            let detectCyclicValue = true; // default
            if (stateData.config && typeof stateData.config.rendering?.detect_cyclic === 'boolean') {
                // Python format: config.rendering.detect_cyclic
                detectCyclicValue = stateData.config.rendering.detect_cyclic;
            } else if (typeof vs.detect_cyclic === 'boolean') {
                // Web format: viewer_state.detect_cyclic
                detectCyclicValue = vs.detect_cyclic;
            }
            // Update global config so it's used when rendering
            if (window.viewerConfig) {
                if (!window.viewerConfig.rendering) {
                    window.viewerConfig.rendering = {};
                }
                window.viewerConfig.rendering.detect_cyclic = detectCyclicValue;
            }
            // ...and the toggle that shows it, or the panel claims one thing
            // while the drawing does another. Set directly rather than by
            // dispatching 'change': the handler reloads the frame, which the
            // restore is in the middle of doing anyway.
            const detectCyclicEl = document.getElementById('detectCyclicCheckbox');
            if (detectCyclicEl) detectCyclicEl.checked = detectCyclicValue;
            // Invalidate segment cache to trigger rebuild with new setting
            renderer.cachedSegmentIndices = null;

            // Restore the ortho slider, which sets viewerState.ortho and a focal
            // length scaled to this object (the slider is the single writer)
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
                    // Trigger input to apply ortho + focal length
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
                    // Ensure object has visibilityState initialized
                    if (!renderer.objectsData[objectName].visibilityState) {
                        renderer.objectsData[objectName].visibilityState = {
                            positions: new Set(),
                            chains: new Set(),
                            paeBoxes: [],
                            visibilityMode: 'default'
                        };
                    }

                    // Restore the saved selection state
                    let positions = new Set();
                    if (ss.positions !== undefined && Array.isArray(ss.positions)) {
                        positions = new Set(ss.positions.filter(a => typeof a === 'number' && a >= 0));
                    }

                    renderer.objectsData[objectName].visibilityState = {
                        positions: positions,
                        chains: new Set(ss.chains || []),
                        paeBoxes: ss.pae_boxes || [],
                        visibilityMode: ss.selection_mode || 'default'
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

                // Restore the current object's selection to the visibilityModel
                // This must happen before setFrame so the selection is applied correctly
                if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]?.visibilityState) {
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

                        // ...AND THE OBJECTS THAT WERE ON SCREEN WITH IT.
                        // After setFrame, because the merge is built from the
                        // frame each object is parked on and the current one's
                        // is only settled here. Names whose objects did not
                        // come back are dropped by setShownObjects.
                        // ...INCLUDING AN EMPTY ONE, which is every object
                        // switched off. Null - the default - is not written at
                        // all, so an older session restores as it always did.
                        const shownSaved = stateData.viewer_state
                            && stateData.viewer_state.shown_objects;
                        if (Array.isArray(shownSaved) && renderer.setShownObjects) {
                            renderer.setShownObjects(shownSaved);
                        }

                        // Explicitly ensure PAE data is set if available
                        // (setFrame should handle this, but we verify here).
                        // ...through the rule about WHOSE matrix it is: taking
                        // it off the object this loop happens to have ended on
                        // put another object's matrix in the panel the moment
                        // a restored session drew more than one.
                        if (window.PAE && window.PAE.syncToDrawn) {
                            window.PAE.syncToDrawn(renderer);
                        }

                        // Update scatter visibility for current object
                        if (renderer.updateScatterContainerVisibility) {
                            renderer.updateScatterContainerVisibility();
                        }

                        // Rebuild sequence view and update UI first
                        window.SEQ?.buildView();
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

                                if (msaEntry && msaEntry.msaData && window.MSA) {
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
