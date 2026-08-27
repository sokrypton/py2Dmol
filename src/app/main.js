// ============================================================================
// src/app/main.js
// ---------------
// AI Context: STANDALONE WEB APP LOGIC
// - Entry point for the standalone website version (index.html).
// - Handles file uploads (PDB, CIF, JSON) and URL fetching.
// - Manages global UI state (sidebar, modals, settings).
// - Parses raw file data before sending it to `core/mol.js`.
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
    // outline width, pencil, smooth - live in LOOK_DEFAULTS and are applied by
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
        renderer.render('main.js: refreshEntropyColors');
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
    const cyclicEl = document.getElementById('cyclicCheckbox');

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
            // values do not come from here - they come from LOOK_DEFAULTS, via
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
            cyclic: false
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

    // Store config in py2dmol_configs for core/mol.js to access
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
    if (cyclicEl) {
        cyclicEl.checked = !!window.viewerConfig.rendering.cyclic;
        cyclicEl.addEventListener('change', () => {
            // The renderer normalises window.viewerConfig in place and keeps
            // THAT object as its own this.config, so writing here reaches it.
            if (!window.viewerConfig.rendering) window.viewerConfig.rendering = {};
            window.viewerConfig.rendering.cyclic = cyclicEl.checked;
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
 * Setup example buttons
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

    // Save button (camera). Handled by core/mol.js via setUIControls: it
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
    // Note: colorSelect event listener is handled in core/mol.js initializePy2DmolViewer()
    // We don't need a duplicate listener here

    if (objectSelect) {
        objectSelect.addEventListener('change', showPickedObject);
        objectSelect.addEventListener('change', handleObjectChange);
    }
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

    //
    // CLICK-SELECTION IS THE WEB APP'S. It is off in the renderer by default:
    // the Python path loads core/mol.js and the cartoon plugin and nothing
    // else, so a click there changed a selection with no strip to show it and
    // no panel to act on it. Turned on here, where both exist.
    if (viewerApi?.renderer) viewerApi.renderer.selectionEnabled = true;
    // A REFUSED STYLE SAYS SO. The cartoon build is refused before it can kill
    // the tab (see _cartoonWouldFit), and the renderer warns to the console and
    // puts the dropdown back - which from the outside is a menu that flicks
    // back to Tube on its own. The hook exists so that whoever has a status
    // line can use it; this is that.
    if (viewerApi?.renderer) {
        viewerApi.renderer.onStyleRefused = (fit) => {
            setStatus(`Cartoon needs about ${Number(fit.needMB).toLocaleString()} MB,`
                + ` ${Number(fit.freeMB).toLocaleString()} MB free - staying in tube`, true);
        };
    }


    // Positions the tools act on. In 'default' mode getVisibility() reports
    // every residue as selected, which is the right answer for visibility but
    // the WRONG one here - "colour everything because you have not selected
    // anything" is never what was meant. So an explicit selection is required.

    {
        const withSelection = (fn) => (e) => {
            if (e) e.preventDefault();
            const positions = getActiveSelection();
            if (!positions) return;
            fn(positions);
        };

        // COLOUR: a grid of PyMOL's named colours rather than an OS colour
        // picker, so the choices are the ones a PyMOL user already knows by
        // name. Built from the table core/mol.js exports.
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
        // A PAIR IS TWO BUTTONS AND ONE QUESTION: each says which way it goes,
        // rather than a switch that means "the other one from now". Pressing
        // the button that is already filled is a no-op the same way asking for
        // what you already have is - it runs, and the state comes back the
        // same. The answer is re-read from the structure afterwards, like the
        // switches: an action can be refused (no side-chain atoms, base plates
        // off globally) and the buttons must then show what is drawn rather
        // than what was asked for.
        const onPair = (id, fn) => {
            const pair = document.getElementById(id);
            if (!pair) return;
            const btns = pair.querySelectorAll('.selection-switch-btn');
            btns.forEach((btn, k) => {
                btn.addEventListener('click', withSelection((positions) => {
                    fn(positions, k === 0);
                    updateSelectionToolsState();
                }));
            });
        };
        onToggle('elementsShowToggle', (p2, v) => setSelectionElements(p2, v));
        onPair('mainchainPair', (p2, v) => {
            setSelectionBackbone(p2, v);
            // SHOW MEANS SHOW, whatever was hiding it. The switch alone leaves
            // a residue that the mask excludes - one inside a PAE box's
            // shadow, say - exactly as invisible as it was, and the button
            // then does nothing you can see. Hide is the other way round: the
            // switch is all it needs, and syncSelectionVisibility takes the
            // residue out of the mask only if nothing else of it is drawn.
            if (v) setSelectionVisible(p2, true);
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
        // ALIGN. The dropdown is a MENU OF ACTIONS, not a setting, so it snaps
        // back to its own label as soon as one is chosen - leaving it reading
        // "all to this" would claim a state the app does not hold, and pressing
        // it again would then be a no-op that looks like a repeat.
        const alignSel = document.getElementById('alignSelect');
        if (alignSel) {
            alignSel.addEventListener('change', () => {
                const mode = alignSel.value;
                alignSel.value = '';
                if (mode) runAlign(mode);
            });
        }
        // the protein form of the same control: two states, one switch - and on
        // a ligand row the same switch draws the ligand itself, which is the
        // visibility mask rather than a side chain nothing there owns
        onPair('sidechainPair', (p2, v) => {
            const lig = ligandRowPositions(p2);
            if (lig) { setSelectionVisible(lig, v); return; }
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
        // ...and the two buttons that replace the pair, each with one job
        const onPress = (id, fn) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('click', withSelection((positions) => {
                fn(positions);
                updateSelectionToolsState();
            }));
        };
        onPress('contactAddButton', (p2) => addSelectionContact(p2));
        onPress('contactDeleteButton', (p2) => removeSelectionContact(p2));

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
        // THROUGH THE SETTER - see the note in panels/seq.js. It stores and
        // dispatches exactly as these lines did, and being the one funnel is
        // what lets Focus hang off a selection however it was made.
        if (all) {
            const s = new Set();
            for (let i = 0; i < renderer.coords.length; i++) s.add(i);
            renderer.setResidueSelection(s);
        } else {
            renderer.clearResidueSelection();
        }
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
    // ...AND IT SAYS WHAT LOADED. "Loaded." with the style note appended read
    // as a bare "showing tube", which is an answer to a question nobody asked.
    if (wasShowing && !silent) setStatus(loadSummary());
}


/**
 * WHAT A FINISHED LOAD SAYS, in one line.
 *
 * It used to say "Successfully fetched and loaded 1 object(s) (1 total frame).
 * 313,236 residues - showing tube; pick Cartoon in Style for the ribbon." -
 * four sentences, three of them about the machinery and one telling the user
 * which menu to open. A status line is a receipt, not a manual: what arrived,
 * how big it is, and anything the app decided on its own.
 *
 * @param {string} extra a few words about the MSA, or nothing
 */
function loadSummary(extra) {
    const r = viewerApi?.renderer;
    const name = r && r.currentObjectName;
    const n = (r && r.coords && r.coords.length) || 0;
    const frames = (r && r.objectsData && r.objectsData[name]
        && r.objectsData[name].frames && r.objectsData[name].frames.length) || 1;
    const bits = [];
    if (name) bits.push(name);
    if (n) bits.push(`${n.toLocaleString()} residues`);
    if (frames > 1) bits.push(`${frames} frames`);
    if (extra) bits.push(extra);
    return bits.join(', ') || 'Loaded.';
}


function setStatus(message, isError = false) {
    // A LOAD THAT FAILED IS A LOAD THAT ENDED. Every failure path in the
    // loader reports through here, so this is the one place that reliably
    // catches them all - without it a later slice's percentage overwrites the
    // error message with a claim that the load is still going.
    if (isError && typeof endProgress === 'function') endProgress(true);
    if (styleFallbackNote && !isError) {
        // ONE LINE, so the note joins the message rather than following it as
        // a second sentence.
        message = message ? `${message} - ${styleFallbackNote}` : styleFallbackNote;
    }
    const statusElement = document.getElementById('status-message');
    if (statusElement) {
        // #status-message is what index.html has; the #status fallback below
        // is for a shell that does not carry one.
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
// _switchToObject in core/mol.js), so switching shows the new object's own
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

// ORIENT LIVES IN src/parts/orient.js NOW, because a notebook and an embed
// want it too and it is geometry, not chrome. What stayed here is the app's
// one answer: which renderer.
//
// It used to pass the #objectSelect value as `name`, on the reasoning that
// only this page has that dropdown - viewer.html has one too, and either way
// the value is renderer.currentObjectName, which is what orientToBestView
// falls back to. Where the two CAN differ it was the wrong one: in Multi the
// picker is greyed out and clicking in the strip moves the edited object
// (adoptObjectOfSelection) without touching it, so a stale dropdown value
// aimed the camera at whatever was picked before Multi was pressed.
function applyBestViewRotation(animate = true) {
    if (!viewerApi || !viewerApi.renderer || !window.py2dmolOrient) return;
    window.py2dmolOrient.orientToBestView(viewerApi.renderer, { animate });
}

// ============================================================================
// STRUCTURE PROCESSING
// ============================================================================

// Biounit extraction and application functions are now in src/io/parse.js
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
    // See CRYSTAL_ADDITIVES in src/io/parse.js for what is on the list and, more
    // importantly, what is deliberately not.
    function maybeFilterAdditives(atoms) {
        if (window.viewerConfig?.ui?.filterAdditives === false) return atoms;
        const drop = window.CRYSTAL_ADDITIVES;
        if (!drop || !drop.size) return atoms;
        // ...AND THE IONS THERE ARE HUNDREDS OF. A single magnesium is an
        // active site; 4UG0's 239 are the mortar a ribosome is built with.
        // Counted per RESIDUE, and only for single-atom ones - see
        // CROWD_ION_COUNT in src/io/parse.js.
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
        // convertParsedToFrameData in src/io/parse.js, which groups the same way and
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

            // Use the unified classification functions from src/io/parse.js with connectivity checks
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
        // 4 ms clamped timer. See yieldIfBusy in src/io/parse.js.
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

/**
 * ...AND THE SAME RULE FOR WHAT IS ON SCREEN, which is not the same question
 * once several objects can be drawn at once.
 *
 * The rule below decides from the object being LOADED, because it runs while
 * that object is being switched to and the renderer's arrays still describe
 * the previous one. In Multi that is the wrong structure to ask about: load a
 * ribosome (tube, correctly), load a peptide beside it (cartoon, correctly for
 * the peptide), then show both - and 17,618 positions are drawn as a ribbon
 * because the last thing loaded was small. Measured: an eye toggle there costs
 * 1.2 s on the GPU path and 250 ms on the CPU one, against 50-120 ms for the
 * same pair in tube.
 *
 * So the drawn set gets the same rule, counted off the LIVE array - which by
 * this point is the merge, and is exactly what will be drawn.
 */
function tubeByDefaultForDrawn(r) {
    if (!r || r.cartoonForce || !r.setStyle || !r.positionsOfObjects) return;
    const t = r.positionTypes;
    if (!t || !t.length) return;
    // PER OBJECT, because the style is per object: a ribosome is a tangle as a
    // ribbon whatever it is standing next to, and the peptide beside it is not
    // a tangle whatever IT is standing next to. Counted off the live array, so
    // this is the structure that will actually be drawn.
    let big = 0;
    for (const nm of r.drawnObjects()) {
        const o = r.objectsData[nm];
        // hand-picked stays picked - for this object, or globally from a
        // restored session, which says what it wants
        if (!o || o.styleChosen || r.styleChosen) continue;
        let n = 0;
        for (const i of r.positionsOfObjects([nm])) {
            const ty = t[i];
            if (ty === 'P' || ty === 'D' || ty === 'R') n++;
        }
        if (!n) continue;
        const want = n > BIG_STRUCTURE_RESIDUES ? 'tube' : 'cartoon';
        if (r.styleForObject(nm) === want) continue;
        r.setStyleForObject(nm, want);
        if (want === 'tube') big = Math.max(big, n);
    }
    // ...and the renderer's own style follows the object being EDITED, which
    // is what the Style panel describes and what a single-object frame draws.
    const cur = r.styleForObject(r.currentObjectName);
    if (cur !== r.style) r.setStyle(cur, true);
    if (big) {
        styleFallbackNote = 'showing tube';
        setStatus('');
    }
}

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
        // A NOTE, NOT A LESSON. It used to end "; pick Cartoon in Style for
        // the ribbon", which is the app explaining its own menus on a status
        // line - and it rode along on every load message after it.
        styleFallbackNote = 'showing tube';
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
    styleFallbackNote = `cartoon needs ~${fit.needMB} MB - showing tube`;
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
                // SAME DPR POLICY as core/mol.js's canvas setup, and the two
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

// Sequence viewer is now in panels/seq.js module
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
 * Shared with the MSA panel
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
 * Load an MSA on its own, with no structure.
 *
 * Reachable on index.html: #viewer-container starts display:none and stays
 * that way until something is loaded, so dropping an alignment first lands
 * here. The comments used to attribute this to msa.html, which is gone - and
 * which nearly got this deleted with it.
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

// Initialize the MSA viewer
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
        // NOTHING LOADED YET? #viewer-container starts hidden and is shown on
        // the first structure, so this is how "the page is still empty" is
        // asked. Not a page test, despite what it used to say.
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
        // ...and with nothing loaded, an alignment on its own is allowed:
        // there is no structure for it to be trimmed against yet.
        const viewerContainer = document.getElementById('viewer-container');
        const isViewerHidden = viewerContainer && window.getComputedStyle(viewerContainer).display === 'none';

        if (isViewerHidden && msaFilesToProcess.length === 1) {
            // an alignment on an empty page
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

        setStatus('Load a structure first, or drop a single alignment on its own', true);
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

        setStatus(loadSummary(totalObjectsLoaded > 1
            ? `${totalObjectsLoaded} objects${paeMessage}`
            : (paeMessage ? paeMessage.trim().replace(/[()]/g, '') : '')));
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

                setStatus(loadSummary(objectsLoaded > 1
                    ? `${objectsLoaded} objects${paeMessage}`
                    : (paeMessage ? paeMessage.trim().replace(/[()]/g, '') : '')));

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

