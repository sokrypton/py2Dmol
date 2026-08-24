// ============================================================================
// src/app/fetch.js
// ----------------
// AI Context: FETCHING A STRUCTURE BY ID
// - RCSB, AlphaFold and PDBe: work out what an identifier means, pull the
//   coordinates, and pair whatever PAE or MSA came with them.
// ============================================================================
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
                        loadSummary('no UniProt mapping')
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
                                                loadSummary(`MSA on ${msaObj.availableChains.length} chain(s)`)
                                            );
                                        } else {
                                            setStatus(
                                                loadSummary('MSA matched no chain')
                                            );
                                        }
                                    } else {
                                        setStatus(
                                            loadSummary('MSA matched no chain')
                                        );
                                    }
                                } else {
                                    setStatus(
                                        loadSummary('no MSA available')
                                    );
                                }
                            } else {
                                setStatus(
                                    loadSummary('no chain sequences for MSA')
                                );
                            }
                        }
                    }
                }
            } catch (e) {
                // PDBe mappings or MSA download failed, but structure loaded successfully
                console.warn("PDBe mappings/MSA download failed:", e);
                setStatus(
                    loadSummary(`MSA failed: ${e.message}`)
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
                                                    loadSummary(`MSA on chain ${firstMatchedChain}`)
                                                );
                                            }
                                        } else {
                                            setStatus(
                                                loadSummary('MSA matched no chain')
                                            );
                                        }
                                    } else {
                                        setStatus(
                                            loadSummary('no chain sequences for MSA')
                                        );
                                    }
                                }
                            }
                        }
                    } else {
                        setStatus(
                            loadSummary('MSA file empty')
                        );
                    }
                } else {
                    // MSA not found, but structure loaded successfully
                    setStatus(
                        loadSummary('no MSA')
                    );
                }
            } catch (e) {
                // MSA download failed, but structure loaded successfully
                console.warn("MSA download failed:", e);
                setStatus(
                    loadSummary('Note: Could not download MSA (${e.messag')
                );
            }
        } else {
            setStatus(loadSummary());
        }

    } catch (e) {
        console.error("Fetch failed:", e);
        setStatus(`Error: Fetch failed for ${fetchId}. ${e.message}.`, true);
    }
}

