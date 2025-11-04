// --- GLOBAL STATE FOR ALIGNMENT ---
// This holds the coordinates of the first frame's Chain A, used as the reference target.
let referenceChainACoords = null; // preserved baseline for alignment (append mode)

document.addEventListener('DOMContentLoaded', () => {

    let objectsWithPAE = new Set(); 
    let viewerApi = null; 
    let statusElement = document.getElementById('status-message');
    let paeContainer = document.getElementById('paeContainer');
    let objectSelect = document.getElementById('objectSelect');
    let colorSelect = document.getElementById('colorSelect');
    let frameSlider = document.getElementById('frameSlider');
    const viewerContainer = document.getElementById('viewer-container');
    const canvasContainer = document.getElementById('canvasContainer');
    const canvas = document.getElementById('canvas');
    const viewerColumn = document.getElementById('viewerColumn');
    
    // NEW UI ELEMENTS
    const loadAsFramesCheckbox = document.getElementById('loadAsFramesCheckbox');
    const alignFramesCheckbox = document.getElementById('alignFramesCheckbox'); // New checkbox
    
    const fileUploadInput = document.getElementById('file-upload');
    const uploadButton = document.getElementById('upload-button');
    const globalDropOverlay = document.getElementById('global-drop-overlay');

    // --- GLOBAL BATCH STORAGE ---
    // Stores all collected data (old and new)
    let batchedObjects = [];


    // UPDATED Constants:
    const FIXED_WIDTH = 600; 
    const FIXED_HEIGHT = 600;
    const PAE_PLOT_SIZE = 300; 
    
    // --- KABSCH ALIGNMENT FUNCTIONS (Verified Working) ---
    
    function calculateMean(coords) {
        let sum = [0, 0, 0];
        for (const c of coords) {
            sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        }
        return [sum[0] / coords.length, sum[1] / coords.length, sum[2] / coords.length];
    }

    /**
     * Calculates the optimal rotation matrix R to align A onto B.
     * @param {Array<Array<number>>} A Centroid-centered source (N x 3)
     * @param {Array<Array<number>>} B Centroid-centered target (N x 3)
     * @returns {Array<Array<number>>} Optimal rotation matrix (3 x 3)
     */
    function kabsch(A, B) {
        // H = A.T @ B (Covariance matrix)
        const H = numeric.dot(numeric.transpose(A), B);

        // SVD of H: H = U * S * V.T
        const svd = numeric.svd(H);
        const U = svd.U; // U (3 x 3)
        const V = svd.V; // V (3 x 3)
        const Vt = numeric.transpose(V); // V.T (3 x 3)

        // D is a diagonal matrix to handle reflections
        let D = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ];
        
        const det = numeric.det(numeric.dot(U, Vt));

        if (det < 0) {
            D[2][2] = -1;
        }

        // R = U @ D @ V.T (Verified working for numeric.js H = A.T @ B)
        return numeric.dot(U, numeric.dot(D, Vt));
    }

    /**
     * Aligns full coordinate set A onto reference B based on the alignment
     * calculated using the first chain's coordinates.
     * @param {Array<Array<number>>} fullCoordsA Full coordinates of the source frame
     * @param {Array<Array<number>>} alignCoordsA Coordinates of Chain A in source frame
     * @param {Array<Array<number>>} alignCoordsB Coordinates of Chain A in reference frame
     * @returns {Array<Array<number>>} Aligned full coordinates (N x 3)
     */
    function align_a_to_b(fullCoordsA, alignCoordsA, alignCoordsB) {
        
        // 1. Calculate centroids
        // [FIX] Calculate meanAlignA once. This is the correct pivot for the source.
        const meanAlignA = calculateMean(alignCoordsA);
        const meanAlignB = calculateMean(alignCoordsB); // Target centroid

        // 2. Centroid-center the alignment sets
        // [FIX] Use the pre-calculated meanAlignA
        const centAlignA = alignCoordsA.map(c => [c[0] - meanAlignA[0], c[1] - meanAlignA[1], c[2] - meanAlignA[2]]);
        const centAlignB = alignCoordsB.map(c => [c[0] - meanAlignB[0], c[1] - meanAlignB[1], c[2] - meanAlignB[2]]);
        
        // 3. Compute optimal rotation matrix (R) based on centered Chain A coords
        const R = kabsch(centAlignA, centAlignB);

        // 4. Apply rotation to the full source coordinates (A)
        // [FIX] Center full A by the *same mean* (meanAlignA)
        const centFullA = fullCoordsA.map(c => [c[0] - meanAlignA[0], c[1] - meanAlignA[1], c[2] - meanAlignA[2]]);
        const rotatedFullA = numeric.dot(centFullA, R);

        // 5. Apply translation (translate back by the target's centroid)
        return rotatedFullA.map(c => [c[0] + meanAlignB[0], c[1] + meanAlignB[1], c[2] + meanAlignB[2]]);
    }

    // --- Model Parsing Functions (omitted for brevity) ---
    function parsePDB(text) {
        const models = [];
        let currentModelAtoms = [];
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith('MODEL')) {
                if (currentModelAtoms.length > 0) { models.push(currentModelAtoms); }
                currentModelAtoms = []; 
            }
            if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
                currentModelAtoms.push({
                    record: line.substring(0, 6).trim(), atomName: line.substring(12, 16).trim(),
                    resName: line.substring(17, 20).trim(), chain: line.substring(21, 22).trim(),
                    resSeq: parseInt(line.substring(22, 26)), x: parseFloat(line.substring(30, 38)),
                    y: parseFloat(line.substring(38, 46)), z: parseFloat(line.substring(46, 54)),
                    b: parseFloat(line.substring(60, 66)), element: line.substring(76, 78).trim()
                });
            }
            if (line.startsWith('ENDMDL')) {
                if (currentModelAtoms.length > 0) { models.push(currentModelAtoms); currentModelAtoms = []; }
            }
        }
        if (currentModelAtoms.length > 0) { models.push(currentModelAtoms); }
        if (models.length === 0 && currentModelAtoms.length > 0) { models.push(currentModelAtoms); }
        return models;
    }

    function parseCIF(text) {
        const modelMap = new Map(); 
        const lines = text.split('\n');
        let atomSiteLoop = false;
        const headers = [];
        const headerMap = {};
        let modelIDKey = null; 
        let modelID = 1;

        for (const line of lines) {
            if (line.startsWith('_atom_site.')) {
                const header = line.trim();
                headerMap[header] = headers.length;
                headers.push(header);
                if (header.includes('model_no') || header.includes('pdbx_PDB_model_num')) { modelIDKey = header; }
            } else if (headers.length > 0 && (line.startsWith('loop_') || line.startsWith('#'))) { break; }
        }
        
        for (const line of lines) {
            if (line.startsWith('_atom_site.')) { atomSiteLoop = true; } 
            else if (atomSiteLoop && line.startsWith('#')) { atomSiteLoop = false; } 
            else if (atomSiteLoop && !line.startsWith(';')) {
                const values = line.match(/(?:[^\s"']+|"([^"]*)"|'([^']*)')+/g);
                if (!values || values.length < headers.length) continue;
                
                const getString = (key) => values[headerMap[key]] || '?';
                const getFloat = (key) => parseFloat(values[headerMap[key]]) || 0.0;
                const getInt = (key) => parseInt(values[headerMap[key]]) || 0;

                const atomNameRaw = getString('_atom_site.label_atom_id');
                let atomName = atomNameRaw;
                if (atomName.length > 1 && atomName.startsWith("'") && atomName.endsWith("'")) { atomName = atomName.substring(1, atomName.length - 1); } 
                else if (atomName.length > 1 && atomName.startsWith('"') && atomName.endsWith('"')) { atomName = atomName.substring(1, atomName.length - 1); }
                
                const atom = {
                    record: getString('_atom_site.group_PDB'), atomName: atomName, 
                    resName: getString('_atom_site.label_comp_id'), chain: getString('_atom_site.auth_asym_id'),
                    resSeq: getInt('_atom_site.auth_seq_id'), x: getFloat('_atom_site.Cartn_x'),
                    y: getFloat('_atom_site.Cartn_y'), z: getFloat('_atom_site.Cartn_z'),
                    b: getFloat('_atom_site.B_iso_or_equiv'), element: getString('_atom_site.type_symbol')
                };

                if (modelIDKey) { modelID = getInt(modelIDKey); }
                
                if (!modelMap.has(modelID)) { modelMap.set(modelID, []); }
                modelMap.get(modelID).push(atom);
            }
        }
        
        return Array.from(modelMap.keys()).sort((a, b) => a - b).map(id => modelMap.get(id));
    }

    function convertParsedToFrameData(atoms) {
        const coords = []; const plddts = []; const atom_chains = []; const atom_types = [];
        const rna_bases = ['A', 'C','G', 'U', 'RA', 'RC', 'RG', 'RU'];
        const proteinResidues = new Set(["ALA", "ARG", "ASN", "ASP", "CYS", "GLU", "GLN", "GLY", "HIS", "ILE", "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL"]);
        const nucleicResidues = new Set(["A", "C", "G", "U", "T", "DA", "DC", "DG", "DT", "RA", "RC", "RG", "RU"]);
        const residues = new Map();
        for (const atom of atoms) {
            if (atom.resName === 'HOH') continue;
            const resKey = `${atom.chain}:${atom.resSeq}:${atom.resName}`;
            if (!residues.has(resKey)) { residues.set(resKey, { atoms: [], resName: atom.resName, chain: atom.chain, record: atom.record }); }
            residues.get(resKey).atoms.push(atom);
        }
        for (const [resKey, residue] of residues.entries()) {
            const is_protein = proteinResidues.has(residue.resName);
            const is_nucleic = nucleicResidues.has(residue.resName);
            if (is_protein) {
                const ca = residue.atoms.find(a => a.atomName === 'CA');
                if (ca) { coords.push([ca.x, ca.y, ca.z]); plddts.push(ca.b); atom_chains.push(ca.chain); atom_types.push('P'); }
            } else if (is_nucleic) {
                let c4_atom = residue.atoms.find(a => a.atomName === "C4'" || a.atomName === "C4*");
                if (c4_atom) {
                    coords.push([c4_atom.x, c4_atom.y, c4_atom.z]); plddts.push(c4_atom.b); atom_chains.push(c4_atom.chain);
                    atom_types.push(rna_bases.includes(residue.resName) || residue.resName.startsWith('R') ? 'R' : 'D');
                }
            } else if (residue.record === 'HETATM') {
                for (const atom of residue.atoms) {
                    if (atom.element !== 'H' && atom.element !== 'D') { 
                        coords.push([atom.x, atom.y, atom.z]); plddts.push(atom.b); atom_chains.push(atom.chain); atom_types.push('L');
                    }
                }
            }
        }
        return { coords, plddts, chains: atom_chains, atom_types };
    }

    // --- App Main Logic ---

    function setStatus(message, isError = false) {
        statusElement.textContent = message;
        statusElement.className = `mt-4 text-sm font-medium ${isError ? 'text-red-700 bg-red-100 border-red-200' : 'text-blue-700 bg-blue-50 border-blue-200'} p-2 rounded-lg border`;
        statusElement.classList.remove('hidden');
    }
    
    function cleanObjectName(name) {
        return name.replace(/\.(cif|pdb|ent|zip)$/i, '');
    }
    
    /**
     * Finds the PAE matrix in a JSON object, regardless of the key.
     * @param {object} paeJson The parsed JSON object.
     * @returns {Array<Array<number>> | null} The PAE matrix or null.
     */
    function extractPaeFromJSON(paeJson) {
        if (!paeJson) return null;

        // 1. Check known keys first
        if (paeJson.pae && Array.isArray(paeJson.pae)) {
            return paeJson.pae;
        }
        if (paeJson.predicted_aligned_error && Array.isArray(paeJson.predicted_aligned_error)) {
            return paeJson.predicted_aligned_error;
        }
        // Handle common AFDB format: JSON is an array containing an object
        if (Array.isArray(paeJson) && paeJson.length > 0 && paeJson[0].predicted_aligned_error) {
            return paeJson[0].predicted_aligned_error;
        }

        // 2. --- FIX: Removed generic heuristic that detects decoy matrices ---
        
        console.warn("Could not find any *known* PAE matrix (pae, predicted_aligned_error) in the JSON file.");
        return null;
    }


    /**
     * Processes a single structure model and saves data to a temporary batch array.
     * @param {string} text - The PDB/CIF content.
     * @param {string} name - The file name/name of the model.
     * @param {Array<Array<number>>} paeData - PAE matrix (optional).
     * @param {string} targetObjectName - The name of the object to push frames to (e.g., zip name or file name).
     * @param {Array<Object>} tempBatch - The temporary array to store the processed objects.
     */
    function processStructureToTempBatch(text, name, paeData, targetObjectName, tempBatch) {
        
        let models;
        try {
            const isCIF = text.substring(0, 1000).includes('data_'); 
            models = isCIF ? parseCIF(text) : parsePDB(text);
            
            if (!models || models.length === 0 || models.every(m => m.length === 0)) { 
                throw new Error(`Could not parse any models or atoms from ${name}.`); 
            }
        } catch (e) {
            console.error("Parsing failed:", e);
            setStatus(`Error: ${e.message}`, true); 
            return 0;
        }
        
        let framesAdded = 0;
        
        // Find or create the target object
        let targetObject = null;
        for (const obj of tempBatch) {
            if (obj.name === targetObjectName) {
                targetObject = obj;
                break;
            }
        }
        if (!targetObject) {
            targetObject = { name: targetObjectName, frames: [] };
            tempBatch.push(targetObject);
        }
        
        // Check if this is a trajectory object being loaded into frames
        const isTrajectory = (loadAsFramesCheckbox.checked || targetObject.frames.length > 0 || models.length > 1);
        const shouldAlign = alignFramesCheckbox.checked;

        
        for (let i = 0; i < models.length; i++) {
            // --- NEW: LOGIC FOR SPLITTING MODELS ---
            // If "Load as Frames" is OFF and this file has multiple models,
            // we create new objects for models 2...N
            if (!loadAsFramesCheckbox.checked && i > 0) {
                const modelObjectName = `${targetObjectName}_model_${i+1}`;
                targetObject = null; // Find or create a new object
                for (const obj of tempBatch) {
                    if (obj.name === modelObjectName) {
                        targetObject = obj;
                        break;
                    }
                }
                if (!targetObject) {
                    targetObject = { name: modelObjectName, frames: [] };
                    tempBatch.push(targetObject);
                }
            }
            // --- END NEW LOGIC ---
            
            const model = models[i];
            let frameData = convertParsedToFrameData(model);
            if (frameData.coords.length === 0) { continue; }

            // --- ALIGNMENT LOGIC START ---
            if (isTrajectory && shouldAlign) {
                const sourceChainACoords = [];
                for(let j = 0; j < frameData.coords.length; j++) {
                    if (frameData.chains[j] === 'A') {
                        sourceChainACoords.push(frameData.coords[j]);
                    }
                }

                if (targetObject.frames.length === 0 && i === 0) {
                    referenceChainACoords = sourceChainACoords;
                } else if (referenceChainACoords && sourceChainACoords.length > 0 && sourceChainACoords.length === referenceChainACoords.length) {
                    try {
                        frameData.coords = align_a_to_b(frameData.coords, sourceChainACoords, referenceChainACoords);
                    } catch (e) {
                        console.error(`Alignment failed for frame ${i} of ${targetObjectName}:`, e);
                        setStatus(`Warning: Alignment failed for a frame in ${targetObjectName}. See console.`, true);
                    }
                }
            }
            // --- ALIGNMENT LOGIC END ---
            
            // --- PAE ASSIGNMENT (Corrected) ---
            // The paeData is associated with the *file*, so all models (frames) 
            // extracted from this single file get the same PAE matrix.
            if (paeData) {
                // --- FIX: Deep copy the PAE matrix ---
                frameData.pae = paeData.map(row => [...row]); 
                targetObject.hasPAE = true;
            } else {
                frameData.pae = null;
            }
            // --- END PAE FIX ---

            targetObject.frames.push(frameData);
            framesAdded++;
        }

        if (framesAdded === 0) { 
            setStatus(`Warning: Found models, but no backbone atoms in ${name}.`, true); 
        }
        
        return framesAdded;
    }
    
    /**
     * Finalizes the load: clears the viewer's screen, re-injects ALL global data, and updates UI.
     */
    function updateViewerFromGlobalBatch() {
         
         viewerApi.handlePythonClearAll(); // Clear the visualization pane
         
         objectsWithPAE = new Set(); // Reset PAE tracking
         objectSelect.innerHTML = ''; // Clear object dropdown UI
         
         if (!viewerApi || batchedObjects.length === 0) {
             viewerContainer.style.display = 'none';
             setStatus("Ready. Upload a file or fetch an ID.");
             return;
         }
         
         let totalFrames = 0;
         let lastObjectName = null; // Changed to lastObjectName for accurate selection

         for (const obj of batchedObjects) {
             if (obj.frames.length > 0) {
                 // 1. Create the object in the viewer
                 viewerApi.handlePythonNewObject(obj.name);
                 // Use the name of the *last* object added as the default selection
                 lastObjectName = obj.name; 
                 
                 // 2. Add all collected frames
                 for (const frame of obj.frames) {
                     viewerApi.handlePythonUpdate(JSON.stringify(frame), obj.name);
                     totalFrames++;
                 }
                 
                 // 3. Update local PAE tracking
                 if (obj.hasPAE) {
                     objectsWithPAE.add(obj.name);
                 } 
             }
         }
         
         if (totalFrames > 0) {
             viewerContainer.style.display = 'flex';
             
             // Set the viewer to the last object loaded
             if (lastObjectName) {
                // Small delay to ensure py2dmol.js has populated the options
                setTimeout(() => {
                    objectSelect.value = lastObjectName;
                    // Trigger change to set PAE visibility and update controls
                    handleObjectChange();
                }, 50); // 50ms delay
             }
             
             // The status message is handled below in the fetch/upload functions for accuracy.
         } else {
             setStatus("Error: No valid structures were loaded to display.", true);
             viewerContainer.style.display = 'none';
         }
    }
    
    // --- Fetch Logic (Now Appends) ---
    async function handleFetch() {
        // --- FIX: Reset global state for a new load operation ---
        // (append mode) do not clear batchedObjects here; keep prior objects
        // (append mode) keep referenceChainACoords to preserve alignment baseline
        
        // Temporary storage for this operation
        const tempBatch = []; 
        
        const fetchId = document.getElementById('fetch-id').value.trim().toUpperCase();
        if (!fetchId) { setStatus("Please enter a PDB or UniProt ID.", true); return; }

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
            name = `${fetchId}.cif`; structUrl = `https://files.rcsb.org/download/${fetchId}.cif`;
            paeUrl = null; paeEnabled = false;
        }

        try {
            const structResponse = await fetch(structUrl);
            if (!structResponse.ok) { throw new Error(`Failed to fetch structure (HTTP ${structResponse.status})`); }
            const structText = await structResponse.text();
            
            let paeData = null;
            if (paeEnabled && paeUrl) {
                try {
                    const paeResponse = await fetch(paeUrl);
                    if (paeResponse.ok) {
                        const paeJson = await paeResponse.json();
                        // --- FIX: Use generic PAE extractor ---
                        paeData = extractPaeFromJSON(paeJson);
                    } else { console.warn(`PAE data not found (HTTP ${paeResponse.status}).`); }
                } catch (e) {
                    console.warn("Could not fetch PAE data:", e.message);
                }
            }
            
            // Process to temporary batch. 
            // NOTE: processStructureToTempBatch now internally respects the align/frame toggles
            const framesAdded = processStructureToTempBatch(structText, name, paeData, cleanObjectName(name), tempBatch);
            
            // --- FIX: Set global batch, don't append ---
            batchedObjects.push(...tempBatch);
            
            updateViewerFromGlobalBatch();
            
            // Display status based on THIS operation
            // The number of *objects* is tempBatch.length
            // The number of *frames* is framesAdded
            setStatus(`Successfully fetched and loaded ${tempBatch.length} object(s) (${framesAdded} total frame${framesAdded !== 1 ? 's' : ''}).`);

        } catch (e) {
            console.error("Fetch failed:", e); 
            setStatus(`Error: Fetch failed for ${fetchId}. ${e.message}.`, true); 
        }
    }

    /**
     * NEW: Refactored master processing function.
     * Takes a list of file-like objects and processes them.
     * @param {Array<object>} files - Array of { name: string, readAsync: (type) => Promise<string> }
     * @param {boolean} loadAsFrames - From the checkbox
     * @param {string} [groupName] - Optional name for the group (e.g., zip file name)
     * @returns {Promise<object>} Stats about the processed files.
     */
    async function processFiles(files, loadAsFrames, groupName = null) {
        
        const tempBatch = []; // Local batch for this operation
        let overallTotalFramesAdded = 0;
        let paePairedCount = 0; // Track successful PAE pairings

        // 1. Separate Structures and JSONs
        const structureFiles = [];
        const jsonFiles = [];

        for (const file of files) {
            const nameLower = file.name.toLowerCase();
            // Skip junk files (macOS metadata)
            if (file.name.startsWith('__MACOSX/') || file.name.startsWith('._')) {
                continue; 
            }
            if (nameLower.match(/\.(cif|pdb|ent)$/)) {
                structureFiles.push(file);
            } else if (nameLower.endsWith('.json')) {
                jsonFiles.push(file);
            }
        }
        
        if (structureFiles.length === 0) {
            throw new Error(`No structural files (*.cif, *.pdb, *.ent) found.`);
        }

        // 2. Load all JSON contents into a Map for easy lookup
        const jsonContentsMap = new Map(); // Key: jsonBaseName, Value: parsed JSON object
        
        const jsonLoadPromises = jsonFiles.map(jsonFile => {
            return new Promise(async (resolve) => {
                try {
                    const jsonText = await jsonFile.readAsync("text");
                    const jsonObject = JSON.parse(jsonText);
                    const jsonBaseName = jsonFile.name.replace(/\.json$/i, '');
                    jsonContentsMap.set(jsonBaseName, jsonObject);
                } catch (e) {
                    console.warn(`Failed to parse JSON file ${jsonFile.name}:`, e);
                }
                resolve();
            });
        });
        
        // --- Robust PAE Matching Function ---
        function getBestJsonMatch(structBaseName, jsonMap) {
            let bestMatch = null;
            let bestScore = 0;
            
            const partsA = structBaseName.split(/[-_]/);

            for (const [jsonBaseName, paeJson] of jsonMap.entries()) {
                const partsB = jsonBaseName.split(/[-_]/);
                let score = 0;
                while(score < partsA.length && score < partsB.length && partsA[score] === partsB[score]) {
                    score++;
                }
                
                // Prioritize matches that hint at being PAE files
                const nameHintScore = (jsonBaseName.includes("pae") || jsonBaseName.includes("full_data") || jsonBaseName.includes("scores") || jsonBaseName.includes("aligned_error")) ? 1 : 0;
                
                // AlphaFold3 Server: Check if the model numbers match (at end of filename)
                // Pattern: fold_2025_09_27_17_51_model_0.cif <-> fold_2025_09_27_17_51_full_data_0.json
                const structModelMatch = structBaseName.match(/_model_(\d+)$/i);
                const structModelNum = structModelMatch ? structModelMatch[1] : null;

                let modelNumBonus = 0;
                if (structModelNum !== null) {
                    const jsonModelMatch = jsonBaseName.match(/_(?:full_data|data|model|pae)_(\d+)$/i);
                    if (jsonModelMatch && jsonModelMatch[1] === structModelNum) {
                        modelNumBonus = 100; // Large bonus for exact model number match
                    }
                }
                
                // ColabFold: Check if rank numbers match (embedded in filename)
                // Pattern: test_unrelaxed_rank_001_alphafold2_model_5.pdb <-> test_scores_rank_001_alphafold2_model_5.json
                const structRankMatch = structBaseName.match(/_rank_(\d+)_/i);
                const jsonRankMatch = jsonBaseName.match(/_rank_(\d+)_/i);
                
                let rankBonus = 0;
                if (structRankMatch && jsonRankMatch && structRankMatch[1] === jsonRankMatch[1]) {
                    rankBonus = 100; // Large bonus for exact rank match (ColabFold)
                    
                    // Additional bonus: Check if model numbers also match within the filename
                    // Pattern: _model_5_ or _model_5_seed_
                    const structInternalModel = structBaseName.match(/_model_(\d+)_/i);
                    const jsonInternalModel = jsonBaseName.match(/_model_(\d+)_/i);
                    if (structInternalModel && jsonInternalModel && structInternalModel[1] === jsonInternalModel[1]) {
                        rankBonus += 50; // Extra bonus for matching internal model numbers
                    }
                    
                    // Additional bonus: Check if seed numbers also match
                    const structSeed = structBaseName.match(/_seed_(\d+)/i);
                    const jsonSeed = jsonBaseName.match(/_seed_(\d+)/i);
                    if (structSeed && jsonSeed && structSeed[1] === jsonSeed[1]) {
                        rankBonus += 25; // Extra bonus for matching seed numbers
                    }
                }
                
                const finalScore = score + nameHintScore + modelNumBonus + rankBonus;

                // Check content only if the score is higher than the current best score
                if (finalScore > bestScore) {
                    const paeMatrix = extractPaeFromJSON(paeJson);
                    if (paeMatrix) { // Only accept if it actually has a PAE matrix
                        bestScore = finalScore;
                        bestMatch = paeJson;
                    }
                }
            }
            return bestScore > 0 ? bestMatch : null; 
        }

        // 3. Process Structures after all JSONs are loaded
        await Promise.all(jsonLoadPromises);

        // --- FIX: Use sequential loop to prevent race conditions ---
        for (const structFile of structureFiles) {
            let paeData = null;
            const structBaseName = structFile.name.replace(/\.(cif|pdb|ent)$/i, '');
            
            const bestMatchJson = getBestJsonMatch(structBaseName, jsonContentsMap);
            
            if (bestMatchJson) {
                paeData = extractPaeFromJSON(bestMatchJson);
                if (paeData) paePairedCount++;
            }

            // Read the structure file
            const text = await structFile.readAsync("text");
            
            // --- Grouping Logic ---
            const trajectoryObjectName = loadAsFrames && structureFiles.length > 1
                ? (groupName || cleanObjectName(structureFiles[0].name)) // Group all into first file's name or zip name
                : structBaseName; // Unique name per object
            
            const framesAdded = processStructureToTempBatch(
                text, 
                structFile.name, 
                paeData, 
                trajectoryObjectName, 
                tempBatch // Use the local tempBatch
            ); 
            overallTotalFramesAdded += framesAdded;
        }

        // 4. Final step: Append processed PDB/CIF data to global list
        if (tempBatch.length > 0) {
            // --- FIX: Set global batch, don't append ---
            batchedObjects.push(...tempBatch);
        }
        
        updateViewerFromGlobalBatch();
        
        // 5. Return stats for status message
        return {
            objectsLoaded: tempBatch.length, 
            framesAdded: overallTotalFramesAdded,
            paePairedCount: paePairedCount, // Pass the count
            structureCount: structureFiles.length, // Pass the total structure count
            isTrajectory: loadAsFrames && structureFiles.length > 1
        };
    }


    // --- ZIP Upload Handler (Now Appends) ---
    async function handleZipUpload(file, loadAsFrames) {
        // --- FIX: Reload data, don't append ---
        // (append mode) do not clear batchedObjects here; keep prior objects
        // (append mode) keep referenceChainACoords to preserve alignment baseline
        
        setStatus(`Unzipping ${file.name} and collecting data...`);
        
        try {
            const zip = new JSZip();
            const content = await zip.loadAsync(file);
            
            const fileList = [];
            content.forEach((relativePath, zipEntry) => {
                // Skip junk files and directories
                if (relativePath.startsWith('__MACOSX/') || relativePath.startsWith('._') || zipEntry.dir) {
                    return; 
                }
                fileList.push({
                    name: relativePath,
                    readAsync: (type) => zipEntry.async(type) // "text"
                });
            });

            // --- Use the MASTER processing function ---
            const stats = await processFiles(fileList, loadAsFrames, cleanObjectName(file.name));
            
            // Display status based on THIS operation
            const objectsLoaded = stats.isTrajectory ? 1 : stats.objectsLoaded;
            
            // VERBOSE STATUS: Report on paired files
            const paeMessage = stats.paePairedCount > 0 ? ` (${stats.paePairedCount}/${stats.structureCount} PAE matrices paired)` : '';
            
            setStatus(`Successfully loaded ${objectsLoaded} new object(s) from ${file.name} (${stats.framesAdded} total frame${stats.framesAdded !== 1 ? 's' : ''}${paeMessage}).`);

        } catch (e) {
            console.error("ZIP processing failed:", e);
            setStatus(`Error processing ZIP file: ${file.name}. ${e.message}`, true);
        }
    }


    function handleFileUpload(event) {
        
        const files = event.target.files || (event.dataTransfer ? event.dataTransfer.files : null);
        
        if (!files || files.length === 0) return;
        
        // --- FIX: Reload data, don't append ---
        // (append mode) do not clear batchedObjects here; keep prior objects
        // (append mode) keep referenceChainACoords to preserve alignment baseline

        const loadAsFrames = loadAsFramesCheckbox.checked;

        // 1. Separate ZIPs from loose files
        const zipFiles = [];
        const looseFiles = []; // PDB, CIF, JSON

        for (const file of files) {
            if (file.name.toLowerCase().endsWith('.zip')) {
                zipFiles.push(file);
            } else {
                looseFiles.push({
                    name: file.name,
                    readAsync: (type) => file.text() // Standard File API
                });
            }
        }
        
        setStatus(`Processing ${files.length} selected files...`);

        // 2. Process all ZIPs individually
        // (Only process one zip at a time for simplicity)
        if (zipFiles.length > 0) {
            handleZipUpload(zipFiles[0], loadAsFrames);
            if (zipFiles.length > 1) {
                setStatus(`Loaded ${zipFiles[0].name}. Please upload one ZIP at a time.`, true);
            }
            return; // Stop processing, ZIP handler will do the rest
        }
        
        // 3. Process all loose files as a single group
        (async () => {
            if (looseFiles.length > 0) {
                try {
                    const stats = await processFiles(looseFiles, loadAsFrames);
                    
                    // Display status for the loose files batch
                    const objectsLoaded = stats.isTrajectory ? 1 : stats.objectsLoaded;
                    const sourceName = looseFiles.length > 1 ? `${looseFiles.length} files` : looseFiles[0].name;
                    
                    // VERBOSE STATUS: Report on paired files
                    const paeMessage = stats.paePairedCount > 0 ? ` (${stats.paePairedCount}/${stats.structureCount} PAE matrices paired)` : '';

                    setStatus(`Successfully loaded ${objectsLoaded} new object(s) from ${sourceName} (${stats.framesAdded} total frame${stats.framesAdded !== 1 ? 's' : ''}${paeMessage}).`);
                
                } catch (e) {
                     console.error("Loose file processing failed:", e);
                     setStatus(`Error processing loose files: ${e.message}`, true);
                }
            }
        })();
    }
    
    function updateColorMode() {
         // This function is a placeholder.
         // The py2dmol.js library handles the 'change' event on #colorSelect
         // and updates its internal state automatically.
         // We keep this here in case we need to add logic later.
    }
    
    function handleObjectChange() {
         const selectedObject = objectSelect.value;
         if (!selectedObject) return; // Exit if no object is selected
         
         // Find the PAE status locally
         const hasPAE = objectsWithPAE.has(selectedObject);
         
         // 1. Manage PAE visibility
         paeContainer.style.display = hasPAE ? 'block' : 'none';
         
         // 2. Update Color Mode based on user's dropdown choice
         // This is handled by py2dmol.js, but we can call our placeholder
         updateColorMode();
    }

    // --- Initialization Functions (omitted for brevity) ---
    function initDragAndDrop() {
        const dropArea = document.getElementById('drop-area');
        const fileUploadInput = document.getElementById('file-upload');

        // Link button to hidden file input
        uploadButton.addEventListener('click', () => {
            fileUploadInput.click();
        });
        
        // Trigger file handler when hidden input changes
        fileUploadInput.addEventListener('change', handleFileUpload);
        
        // 2. Global drag/drop events (for the whole page)
        let dragCounter = 0; // Counter to handle nested dragenter/dragleave events

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
            // Check if drag event is leaving the window or an immediate child
            if (dragCounter === 0 || e.relatedTarget === null) { 
                globalDropOverlay.style.display = 'none';
            }
        }, false);
        
        // Reset on drop (must be on document.body for wide area drop)
        document.body.addEventListener('drop', (e) => {
            preventDefaults(e);
            dragCounter = 0;
            globalDropOverlay.style.display = 'none';
            
            const dt = e.dataTransfer;
            if (dt.files.length > 0) {
                // Pass files to the main upload handler
                handleFileUpload({ target: { files: dt.files } });
            }
        }, false);
        
        document.body.addEventListener('dragover', preventDefaults, false);

    }

    function preventDefaults (e) {
      e.preventDefault();
      e.stopPropagation();
    }


    function initApp() {
        console.log("DOM is ready. Initializing app...");

        // UPDATED to use new constants
        window.viewerConfig = { 
            size: [FIXED_WIDTH, FIXED_HEIGHT],
            pae_size: [PAE_PLOT_SIZE, PAE_PLOT_SIZE],
            color: "auto", shadow: true, outline: true, width: 3.0,
            rotate: false, controls: true, autoplay: false, box: true,
            pastel: 0.25, pae: true, colorblind: false, viewer_id: "standalone-viewer-1" 
        };
        
        canvasContainer.style.width = `${FIXED_WIDTH}px`;
        canvasContainer.style.height = `${FIXED_HEIGHT}px`;
        canvas.width = FIXED_WIDTH;
        canvas.height = FIXED_HEIGHT;
        viewerColumn.style.minWidth = `${FIXED_WIDTH}px`;


        try {
            initializePy2DmolViewer(viewerContainer);
        } catch (e) {
            console.error("Failed to initialize viewer:", e);
            setStatus("Error: Failed to initialize viewer. See console.", true);
            return;
        }

        viewerApi = window.py2dmol_viewers[window.viewerConfig.viewer_id];
        
        document.getElementById('fetch-btn').addEventListener('click', handleFetch);
        
        // Centralize logic calls
        objectSelect.addEventListener('change', handleObjectChange);
        colorSelect.addEventListener('change', updateColorMode); 
        
        initDragAndDrop(); 
        
        paeContainer.style.display = 'none';
        setStatus("Ready. Upload a file or fetch an ID.");
    }

    const rendererScript = document.getElementById('py2dmol-renderer');
    if (rendererScript && typeof initializePy2DmolViewer === 'function') {
        initApp();
    } else if (rendererScript) {
         rendererScript.onload = initApp;
    }

});