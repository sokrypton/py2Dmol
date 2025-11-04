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
}

function handleObjectChange() {
    const objectSelect = document.getElementById('objectSelect');
    const paeContainer = document.getElementById('paeContainer');
    
    const selectedObject = objectSelect.value;
    if (!selectedObject) return;
    
    const hasPAE = objectsWithPAE.has(selectedObject);
    paeContainer.style.display = hasPAE ? 'block' : 'none';
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

    const Rcur = renderer.rotationMatrix;
    const Rtarget = bestViewTargetRotation_relaxed_AUTO(frame.coords, Rcur);

    const angle = rotationAngleBetweenMatrices(Rcur, Rtarget);
    const deg = angle * 180 / Math.PI;
    const duration = Math.max(300, Math.min(2000, deg * 10));

    rotationAnimation.active = true;
    rotationAnimation.startMatrix = Rcur.map(row => [...row]);
    rotationAnimation.targetMatrix = Rtarget;
    rotationAnimation.duration = duration;
    rotationAnimation.startTime = performance.now();

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
        renderer.render();
        rotationAnimation.active = false;
        return;
    }

    // Cubic easing
    const eased = progress < 0.5 ?
        4 * progress * progress * progress :
        1 - Math.pow(-2 * progress + 2, 3) / 2;

    renderer.rotationMatrix = lerpRotationMatrix(
        rotationAnimation.startMatrix,
        rotationAnimation.targetMatrix,
        eased
    );
    renderer.render();
    requestAnimationFrame(animateRotation);
}

// ============================================================================
// STRUCTURE PROCESSING
// ============================================================================

/**
 * Apply biounit transformations to all models
 * @param {string} text - Original file text
 * @param {Array<Array<object>>} models - Parsed models
 * @param {boolean} isCIF - Whether file is CIF format
 * @returns {Array<Array<object>>} - Models with biounit applied
 */
function applyBiounitToModels(text, models, isCIF) {
    if (isCIF) {
        // For CIF, each model already shares the same assembly info
        // So we just apply the assembly to each model
        return models.map(modelAtoms => {
            const tempText = text; // CIF assembly is file-level
            const assembled = parseFirstBioAssembly(tempText);
            if (assembled && assembled.atoms && assembled.atoms.length > 0) {
                // Map the assembled structure back to this model's atoms
                // For simplicity with CIF multi-models, return as-is
                // (CIF multi-models are rare and complex)
                return modelAtoms;
            }
            return modelAtoms;
        });
    } else {
        // For PDB, extract biounit operations and apply to each model
        const operations = extractPDBBiounitOperations(text);
        if (!operations || operations.length === 0) {
            return models; // No biounit info
        }
        
        return models.map(modelAtoms => {
            return applyBiounitOperationsToModel(modelAtoms, operations);
        });
    }
}

/**
 * Extract biounit operations from PDB REMARK 350
 * @param {string} text - PDB text
 * @returns {Array<object>} - Array of {R, t, chains} operations
 */
function extractPDBBiounitOperations(text) {
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
    
    return ops;
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
        const isCIF = text.substring(0, 1000).includes('data_');
        
        // Parse all models first
        models = isCIF ? parseCIF(text) : parsePDB(text);
        
        if (!models || models.length === 0 || models.every(m => m.length === 0)) {
            throw new Error(`Could not parse any models or atoms from ${name}.`);
        }
        
        // Apply biounit transformation to all models if requested
        if (wantBU && models.length > 0) {
            const assembled = parseFirstBioAssembly(text);
            if (assembled && assembled.atoms && assembled.atoms.length > 0) {
                // If we successfully got biounit for first model, apply same transformation to all models
                if (models.length === 1) {
                    // Single model - just use the assembled version
                    models = [assembled.atoms];
                } else {
                    // Multiple models - apply biounit transformation to each
                    // Extract the transformation from the assembled first model
                    const biounited = applyBiounitToModels(text, models, isCIF);
                    if (biounited && biounited.length > 0) {
                        models = biounited;
                    }
                }
            }
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

    if (totalFrames > 0) {
        viewerContainer.style.display = 'flex';
        if (lastObjectName) {
            setTimeout(() => {
                objectSelect.value = lastObjectName;
                handleObjectChange();
                updateObjectNavigationButtons();
            }, 50);
        }
    } else {
        setStatus("Error: No valid structures were loaded to display.", true);
        viewerContainer.style.display = 'none';
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

    for (const file of files) {
        const nameLower = file.name.toLowerCase();
        if (file.name.startsWith('__MACOSX/') || file.name.startsWith('._')) continue;
        if (nameLower.match(/\.(cif|pdb|ent)$/)) structureFiles.push(file);
        else if (nameLower.endsWith('.json')) jsonFiles.push(file);
    }

    if (structureFiles.length === 0) {
        throw new Error(`No structural files (*.cif, *.pdb, *.ent) found.`);
    }

    // Load JSON files
    const jsonContentsMap = new Map();
    const jsonLoadPromises = jsonFiles.map(jsonFile => new Promise(async (resolve) => {
        try {
            const jsonText = await jsonFile.readAsync("text");
            const jsonObject = JSON.parse(jsonText);
            const jsonBaseName = jsonFile.name.replace(/\.json$/i, '');
            jsonContentsMap.set(jsonBaseName, jsonObject);
        } catch (e) {
            console.warn(`Failed to parse JSON file ${jsonFile.name}:`, e);
        }
        resolve();
    }));

    await Promise.all(jsonLoadPromises);

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
            if (structRankMatch && jsonRankMatch && structRankMatch[1] === jsonRankMatch[1]) {
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

    (async () => {
        if (looseFiles.length > 0) {
            try {
                const stats = await processFiles(looseFiles, loadAsFrames);
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
        }
    })();
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
        if (dragCounter === 0 || e.relatedTarget === null) {
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