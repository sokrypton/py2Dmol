// ============================================================================
// src/app/session.js
// ------------------
// AI Context: SAVING AND RESTORING A SESSION
// - saveViewerState writes everything the page is currently showing into one
//   JSON blob; loadViewerState puts it back, object by object.
// - The second half was filed under "SVG EXPORT", a banner left behind when the
//   export moved into the renderer. It is loadViewerState.
// ============================================================================
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
                if (frame.position_elements) frameData.position_elements = frame.position_elements;
                if (frame.bonds) frameData.bonds = frame.bonds;
                if (frame.scatter) frameData.scatter = frame.scatter;
                if (frame.color) frameData.color = frame.color;

                // Map modified residues to standard equivalents (e.g., MSE -> MET)
                if (frame.position_names) {
                    frameData.position_names = frame.position_names.map(resName => {
                        // Use getStandardResidueName from src/io/parse.js if available
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

            // Add scatter config if it exists (camelCase internal)
            const scatterCfg = objectData.scatterConfig;
            if (scatterCfg) {
                objToSave.scatter_config = scatterCfg;
            }

            // EVERY PIECE OF PER-OBJECT STATE KEYED BY POSITION, from the
            // one list that names them (OBJECT_STATE in core/mol.js). This
            // was seven near-identical blocks, each with its own rule about
            // when an empty value still has to be written - and the rule is
            // not the same for all of them: a set whose absence means ALL has
            // to go out even when it is EMPTY, because empty means "none of
            // them" and leaving it out means "all of them". The list carries
            // that, so this does not have to remember it.
            if (renderer.objectStateToJSON) {
                Object.assign(objToSave, renderer.objectStateToJSON(objectData));
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
                    extentAspect: sourceState.extentAspect,
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

        // Get cyclic from config
        const cyclic = (window.viewerConfig && typeof window.viewerConfig.rendering?.cyclic === 'boolean')
            ? window.viewerConfig.rendering.cyclic
            : true;

        const viewerState = {
            current_object_name: renderer.currentObjectName,
            // CONTACTS THAT BELONG TO NO ONE OBJECT. An object's own travel
            // with it through OBJECT_STATE; these join two objects and live on
            // the viewer, so nothing was carrying them and a session lost them
            // silently - the structures came back and the lines between them
            // did not. Their ends are addresses ({object, chain, residues})
            // rather than indices, so they survive the round trip as written.
            cross_contacts: (renderer.crossContacts && renderer.crossContacts.length)
                ? renderer.crossContacts : undefined,
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
            // ...AND THE SHAPE BESIDE THE SIZE. The extent is a radius and
            // extentAspect is how it is shaped; the scale needs both, so a
            // session that saved one drew at a different magnification when it
            // came back. It used to be harmless: the aspect was normalised so
            // the binding axis was exactly 1, and losing it changed nothing on
            // that axis. Normalised by the extent it is below 1 on BOTH, so
            // dropping it shrinks the restored picture by the whole reserve -
            // measured as 56,582 pixels of ink against 82,545.
            extent_aspect: renderer.viewerState.extentAspect,
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
            cyclic: cyclic,
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
// Image export is now handled by renderer.saveImage() in core/mol.js
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

                // ...AND EVERY PIECE OF PER-OBJECT STATE KEYED BY POSITION,
                // from the same list that saved it (OBJECT_STATE). Seven
                // blocks each testing a differently-shaped emptiness, and one
                // of them - the bases - had to accept an EMPTY array where the
                // others rejected it.
                if (!renderer.objectsData[objData.name]) {
                    renderer.objectsData[objData.name] = {};
                }
                if (renderer.objectStateFromJSON) {
                    renderer.objectStateFromJSON(
                        renderer.objectsData[objData.name], objData);
                }
                // ...and contacts need the segment cache dropped, since they
                // are drawn as segments and the cache was built without them
                if (objData.contacts && objData.contacts.length) {
                    renderer.cachedSegmentIndices = null;
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
                        extentAspect: vs.extentAspect,
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

            // ...the viewer's own contacts, before the frames are built: they
            // become segments inside setCoords, so setting them afterwards
            // stores them correctly and draws nothing until the next reload.
            if (Array.isArray(vs.cross_contacts)) {
                renderer.crossContacts = vs.cross_contacts;
            }

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

            // ...saved under either spelling: the viewer block uses the
            // snake_case wire name, an object's held state the camel one.
            // ...and the pair put down together, through the one writer, so a
            // restored session cannot end up with a size from the file and a
            // shape from whatever was on screen.
            const savedAspect = vs.extent_aspect || vs.extentAspect;
            if (typeof vs.extent === 'number' && vs.extent > 0) {
                setViewSpan(renderer.viewerState,
                    halfSpanOf(vs.extent, savedAspect));
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
                // 'ss' (cartoon/geom.js) are valid too, and were being
                // silently dropped on load.
                const validModes = getAllValidColorModes();
                if (validModes.includes(vs.color_mode)) {
                    renderer.colorMode = vs.color_mode;
                    const colorSelect = document.getElementById('colorSelect');
                    if (colorSelect) {
                        // ...and the SSE modes carry their palette in the
                        // value, so the helper decides what to show
                        colorSelect.value = renderer._colorSelectValue
                            ? renderer._colorSelectValue() : vs.color_mode;
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

            // Restore cyclic - check both Python config format and web viewer_state format
            let cyclicValue = true; // default
            if (stateData.config && typeof stateData.config.rendering?.cyclic === 'boolean') {
                // Python format: config.rendering.cyclic
                cyclicValue = stateData.config.rendering.cyclic;
            } else if (typeof vs.cyclic === 'boolean') {
                // Web format: viewer_state.cyclic
                cyclicValue = vs.cyclic;
            }
            // Update global config so it's used when rendering
            if (window.viewerConfig) {
                if (!window.viewerConfig.rendering) {
                    window.viewerConfig.rendering = {};
                }
                window.viewerConfig.rendering.cyclic = cyclicValue;
            }
            // ...and the toggle that shows it, or the panel claims one thing
            // while the drawing does another. Set directly rather than by
            // dispatching 'change': the handler reloads the frame, which the
            // restore is in the middle of doing anyway.
            const cyclicEl = document.getElementById('cyclicCheckbox');
            if (cyclicEl) cyclicEl.checked = cyclicValue;
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

                        // ...AND THE SAVED CAMERA HAS THE LAST WORD. Objects
                        // arrive one at a time, and each arrival rebuilds the
                        // merge of everything loaded so far - which frames on
                        // what it finds, because every object in a restored
                        // session is new to this renderer. By the time the
                        // shown set is applied the centre and extent from the
                        // file are long gone. They are cheap to put back, and
                        // this is the one place that knows they are the answer.
                        const savedView = stateData.viewer_state;
                        if (savedView) {
                            if (savedView.center) {
                                renderer.viewerState.center = savedView.center;
                            }
                            const va = savedView.extentAspect
                                || savedView.extent_aspect;
                            if (typeof savedView.extent === 'number'
                                && savedView.extent > 0) {
                                setViewSpan(renderer.viewerState,
                                    halfSpanOf(savedView.extent, va));
                            }
                            renderer.render('restored view');
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
