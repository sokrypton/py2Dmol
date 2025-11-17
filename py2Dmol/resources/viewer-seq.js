// ============================================================================
// SEQUENCE VIEWER MODULE
// ============================================================================
// This module provides sequence viewer functionality for py2Dmol.
// It can be used in both web and Python interfaces.
// Now uses canvas-based rendering for improved performance.

(function() {
    'use strict';

    // ============================================================================
    // INTERNAL STATE
    // ============================================================================
    let sequenceCanvasData = null; // Canvas-based structure: { canvas, ctx, allResidueData, chainBoundaries, layout, mode }
    let lastSequenceFrameIndex = -1; // Track which frame the sequence view is showing
    let sequenceViewMode = true;  // Default: show sequence (enabled by default)
    let lastSequenceUpdateHash = null;
    let renderScheduled = false; // Flag to prevent multiple queued renders
    let highlightOverlayCanvas = null; // Overlay canvas for drawing highlights on main viewer
    let highlightOverlayCtx = null;
    let hoveredResidueInfo = null; // { chain, resName, resSeq } for tooltip display
    
    // Per-object preview state (single source of truth for preview during drag)
    const previewByObject = new Map();
    
    // Callbacks for integration with host application
    let callbacks = {
        getRenderer: null,           // () => renderer instance
        getObjectSelect: null,        // () => objectSelect element
        toggleChainResidues: null,    // (chain) => void
        setChainResiduesSelected: null, // (chain, selected) => void
        highlightAtom: null,          // (positionIndex) => void
        highlightAtoms: null,         // (positionIndices) => void
        clearHighlight: null,        // () => void
        applySelection: null          // (previewPositions) => void
    };

    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================
    
    // Get current object name from renderer
    function getCurrentObjectName() {
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        return renderer?.currentObjectName || null;
    }
    
    // Get preview selection for current object
    function getLocalPreview() {
        const name = getCurrentObjectName();
        return name ? (previewByObject.get(name) || null) : null;
    }
    
    // Set preview selection for current object
    function setLocalPreview(setOrNull) {
        const name = getCurrentObjectName();
        if (!name) return;
        if (setOrNull && setOrNull.size > 0) {
            // Store a copy to avoid external mutation
            previewByObject.set(name, new Set(setOrNull));
        } else {
            previewByObject.delete(name);
        }
    }
    
    // Check if sequence differs between frames
    function sequencesDiffer(frame1, frame2) {
        if (!frame1 || !frame2) return true;
        
        // Check number of positions: prefer position_names or chains length, fallback to coords.length / 3
        function getPositionCount(frame) {
            if (frame.position_names && frame.position_names.length > 0) {
                return frame.position_names.length;
            } else if (frame.chains && frame.chains.length > 0) {
                return frame.chains.length;
            } else if (frame.coords) {
                // coords is flat array [x, y, z, ...], so divide by 3
                return Math.floor(frame.coords.length / 3);
            }
            return 0;
        }
        
        const n1 = getPositionCount(frame1);
        const n2 = getPositionCount(frame2);
        if (n1 !== n2) return true;
        if (n1 === 0) return false; // Both empty, consider same
        
        // Check if position_names differ (if available)
        const positionNames1 = frame1.position_names || [];
        const positionNames2 = frame2.position_names || [];
        if (positionNames1.length > 0 && positionNames2.length > 0) {
            for (let i = 0; i < Math.min(positionNames1.length, positionNames2.length, n1); i++) {
                if (positionNames1[i] !== positionNames2[i]) return true;
            }
        }
        
        // Check if chains differ (if available)
        const chains1 = frame1.chains || [];
        const chains2 = frame2.chains || [];
        if (chains1.length > 0 && chains2.length > 0) {
            for (let i = 0; i < Math.min(chains1.length, chains2.length, n1); i++) {
                if (chains1[i] !== chains2[i]) return true;
            }
        }
        
        // Check if position_types differ (if available)
        const position_types1 = frame1.position_types || [];
        const position_types2 = frame2.position_types || [];
        if (position_types1.length > 0 && position_types2.length > 0) {
            for (let i = 0; i < Math.min(position_types1.length, position_types2.length, n1); i++) {
                if (position_types1[i] !== position_types2[i]) return true;
            }
        }
        
        return false;
    }

    // Schedule render using requestAnimationFrame to throttle
    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            renderSequenceCanvas();
        });
    }

    // Get mouse/touch position relative to canvas
    function getCanvasPositionFromMouse(e, canvas) {
        const rect = canvas.getBoundingClientRect();
        // Support both mouse and touch events
        const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
        const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);
        
        // Get mouse position relative to canvas (in display pixels)
        const displayX = clientX - rect.left;
        const displayY = clientY - rect.top;
        
        // Scale to canvas logical coordinates (accounting for DPI multiplier)
        // Calculate DPI multiplier (200 DPI / 96 DPI standard)
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        // Canvas internal size is dpiMultiplier * display size, but context is scaled, so we want display pixels
        const scaleX = (canvas.width / dpiMultiplier) / rect.width;
        const scaleY = (canvas.height / dpiMultiplier) / rect.height;
        
        return { 
            x: displayX * scaleX, 
            y: displayY * scaleY 
        };
    }

    // Find position at canvas position
    function getResidueAtCanvasPosition(x, y, layout) {
        if (!layout || !layout.residuePositions) return null;
        
        for (const pos of layout.residuePositions) {
            if (x >= pos.x && x < pos.x + pos.width && y >= pos.y && y < pos.y + pos.height) {
                return pos; // Return position object with residueData
            }
        }
        return null;
    }

    // Find chain label at canvas position
    function getChainLabelAtCanvasPosition(x, y, layout) {
        if (!layout || !layout.chainLabelPositions) return null;
        
        for (const pos of layout.chainLabelPositions) {
            if (x >= pos.x && x < pos.x + pos.width && y >= pos.y && y < pos.y + pos.height) {
                return pos;
            }
        }
        return null;
    }
    
    // Unified detection function for all selectable items
    function getSelectableItemAtPosition(x, y, layout, sequenceViewMode) {
        if (!layout || !layout.selectableItems) return null;
        
        // Filter items based on mode
        let items = layout.selectableItems;
        if (!sequenceViewMode) {
            // In chain mode, only chain items are selectable
            items = items.filter(item => item.type === 'chain');
        }
        
        // Separate items by type for priority checking
        const residueLigandItems = items.filter(item => item.type === 'residue' || item.type === 'ligand');
        const chainItems = items.filter(item => item.type === 'chain');
        
        // Priority 1: Check position/ligand items first (exact bounds)
        // These should take precedence over chain items in sequence mode
        for (const item of residueLigandItems) {
            const bounds = item.bounds;
            if (x >= bounds.x && x < bounds.x + bounds.width &&
                y >= bounds.y && y < bounds.y + bounds.height) {
                return item;
            }
        }
        
        // Priority 2: Check chain items
        // In sequence mode, only match if clicking in the actual chain button area
        // In chain mode, match if both X and Y are within button bounds (preserve column position)
        for (const item of chainItems) {
            const bounds = item.bounds;
            
            if (sequenceViewMode) {
                // In sequence mode, only match chain button if clicking in button area
                // Use chainLabelPositions to get actual button bounds
                const chainPos = layout.chainLabelPositions?.find(p => p.chainId === item.chainId);
                if (chainPos) {
                    if (x >= chainPos.x && x < chainPos.x + chainPos.width &&
                        y >= chainPos.y && y < chainPos.y + chainPos.height) {
                        return item;
                    }
                }
            } else {
                // In chain mode, check if BOTH X and Y are within button bounds
                // This preserves column position when dragging vertically between rows
                // Use chainLabelPositions to get actual button bounds (not full row)
                const chainPos = layout.chainLabelPositions?.find(p => p.chainId === item.chainId);
                if (chainPos) {
                    if (x >= chainPos.x && x < chainPos.x + chainPos.width &&
                        y >= chainPos.y && y < chainPos.y + chainPos.height) {
                        return item;
                    }
                }
            }
        }
        
        return null;
    }

    // ============================================================================
    // CANVAS RENDERING FUNCTIONS
    // ============================================================================

    // Draw chain label on canvas
    function drawChainLabelOnCanvas(ctx, chainId, x, y, width, height, isSelected, chainColor, charHeight) {
        // Draw background
        let bgColor;
        let textColor;
        
        if (isSelected) {
            bgColor = `rgb(${chainColor.r}, ${chainColor.g}, ${chainColor.b})`;
            // Calculate contrast color
            const luminance = (0.299 * chainColor.r + 0.587 * chainColor.g + 0.114 * chainColor.b) / 255;
            textColor = luminance > 0.5 ? '#000000' : '#ffffff';
        } else {
            // Dim unselected chains
            const dimmed = {
                r: Math.round(chainColor.r * 0.3 + 255 * 0.7),
                g: Math.round(chainColor.g * 0.3 + 255 * 0.7),
                b: Math.round(chainColor.b * 0.3 + 255 * 0.7)
            };
            bgColor = `rgb(${dimmed.r}, ${dimmed.g}, ${dimmed.b})`;
            textColor = '#000000';
        }
        
        ctx.fillStyle = bgColor;
        ctx.fillRect(x, y, width, height);
        
        // Draw text
        ctx.fillStyle = textColor;
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(chainId, x + width / 2, y + height / 2);
        
        // Draw border if selected
        if (isSelected) {
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y + height);
            ctx.lineTo(x + width, y + height);
            ctx.stroke();
        }
    }

    // Draw position character on canvas
    function drawResidueCharOnCanvas(ctx, letter, x, y, width, height, color, isSelected, dimFactor) {
        // Apply dimming if not selected
        let r = color.r;
        let g = color.g;
        let b = color.b;
        
        if (!isSelected) {
            r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
            g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
            b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
        }
        
        // Draw background
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(x, y, width, height);
        
        // Draw text
        ctx.fillStyle = '#000000';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, x + width / 2, y + height / 2);
        
        // Draw border if selected
        if (isSelected) {
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y + height);
            ctx.lineTo(x + width, y + height);
            ctx.stroke();
        }
    }

    // Draw ligand token on canvas (collapsed ligand representation)
    function drawLigandTokenOnCanvas(ctx, ligandName, x, y, width, height, color, isSelected, dimFactor) {
        // Apply dimming if not selected
        let r = color.r;
        let g = color.g;
        let b = color.b;
        
        if (!isSelected) {
            r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
            g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
            b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
        }
        
        // Draw background
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(x, y, width, height);
        
        // Draw text (smaller font, truncated to fit in 2 char widths)
        ctx.fillStyle = '#000000';
        ctx.font = '9px monospace'; // Smaller font for ligand name
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Truncate ligand name to fit in 2 character widths (approximately 20px)
        const maxLength = 8; // Approximate max chars that fit in 2 char widths with smaller font
        const displayName = ligandName.length > maxLength ? ligandName.substring(0, maxLength - 1) + '…' : ligandName;
        ctx.fillText(displayName, x + width / 2, y + height / 2);
        
        // Draw border if selected
        if (isSelected) {
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y + height);
            ctx.lineTo(x + width, y + height);
            ctx.stroke();
        }
    }

    // Main canvas rendering function
    function renderSequenceCanvas() {
        if (!sequenceCanvasData) return;
        
        const { canvas, ctx, allResidueData, chainBoundaries, layout, sortedPositionEntries } = sequenceCanvasData;
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Get selection state - use selectionModel directly to avoid expensive getSelection() copy
        const selectionModel = renderer.selectionModel;
        const previewSelectionSet = getLocalPreview();
        
        // Determine visible positions - avoid unnecessary Set copies
        let visiblePositions;
        if (previewSelectionSet && previewSelectionSet.size > 0) {
            // Use preview selection directly (already a Set, no need to copy)
            visiblePositions = previewSelectionSet;
        } else {
            if (selectionModel && selectionModel.positions && selectionModel.positions.size > 0) {
                // Use selectionModel directly (no copy needed for read-only access)
                visiblePositions = selectionModel.positions;
            } else if (renderer.visibilityMask === null) {
                // All positions visible - create Set only if needed (lazy)
                const n = renderer.coords ? renderer.coords.length : 0;
                visiblePositions = new Set();
                for (let i = 0; i < n; i++) {
                    visiblePositions.add(i);
                }
            } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                // Use visibilityMask directly (no copy needed for read-only access)
                visiblePositions = renderer.visibilityMask;
            } else {
                visiblePositions = new Set();
            }
        }
        
        const dimFactor = 0.3; // Same as PAE plot
        
        // Draw chain labels
        if (layout.chainLabelPositions) {
            // During drag, compute chain selection from preview positions
            let chainSelection = selectionModel?.chains;
            let selectionMode = selectionModel?.selectionMode;
            
            // Check if we're in a drag operation (previewSelectionSet exists, even if empty Set)
            const isDragging = previewSelectionSet !== null;
            
            if (isDragging) {
                // Compute chains from preview positions during drag (even if previewSelectionSet is empty)
                const objectName = renderer.currentObjectName;
                const obj = renderer.objectsData[objectName];
                const frame = obj?.frames?.[0];
                const previewChains = new Set();
                if (frame?.chains && previewSelectionSet) {
                    // previewSelectionSet can be empty Set (unselect case) or have positions (select case)
                    for (const positionIndex of previewSelectionSet) {
                        const positionChain = frame.chains[positionIndex];
                        if (positionChain) {
                            previewChains.add(positionChain);
                        }
                    }
                }
                // Use preview chains for visual feedback during drag
                // If previewSelectionSet is empty, previewChains will be empty (all chains unselected)
                chainSelection = previewChains;
                // Determine selection mode based on preview
                const totalPositions = frame?.chains?.length || 0;
                const hasPartialSelections = previewSelectionSet.size > 0 && previewSelectionSet.size < totalPositions;
                const allChains = new Set(frame?.chains || []);
                const allChainsSelected = previewChains.size === allChains.size && 
                                        Array.from(previewChains).every(c => allChains.has(c));
                selectionMode = (allChainsSelected && !hasPartialSelections && previewSelectionSet.size > 0) ? 'default' : 'explicit';
            }
            
            for (const chainPos of layout.chainLabelPositions) {
                const chainId = chainPos.chainId;
                const isSelected = chainSelection?.has(chainId) || 
                    (selectionMode === 'default' && (!chainSelection || chainSelection.size === 0));
                const chainColor = renderer?.getChainColorForChainId?.(chainId) || {r: 128, g: 128, b: 128};
                
                drawChainLabelOnCanvas(
                    ctx,
                    chainId,
                    chainPos.x,
                    chainPos.y,
                    chainPos.width,
                    chainPos.height,
                    isSelected,
                    chainColor,
                    layout.charHeight
                );
            }
        }
        
        // Draw position characters and ligand tokens
        if (layout.residuePositions && allResidueData) {
            // Get renderer's getAtomColor function for dynamic color computation
            const hasGetAtomColor = renderer?.getAtomColor;
            
            for (const pos of layout.residuePositions) {
                const residueData = pos.residueData;
                if (!residueData) continue;
                
                // Compute color dynamically based on current renderer state
                let color = {r: 128, g: 128, b: 128}; // Default fallback grey
                
                if (residueData.positionIndex === -1) {
                    // Gap markers (missing positions) use stored light grey color
                    color = residueData.color || {r: 240, g: 240, b: 240};
                } else if (residueData.isLigandToken && residueData.positionIndices && residueData.positionIndices.length > 0) {
                    // For ligand tokens, use first position's color
                    const firstPositionIndex = residueData.positionIndices[0];
                    if (hasGetAtomColor && !Number.isNaN(firstPositionIndex) && firstPositionIndex >= 0) {
                        color = renderer.getAtomColor(firstPositionIndex);
                    }
                } else if (residueData.positionIndex >= 0) {
                    // For regular positions, use position's color
                    if (hasGetAtomColor && !Number.isNaN(residueData.positionIndex)) {
                        color = renderer.getAtomColor(residueData.positionIndex);
                    }
                }
                
                // Check if this is a ligand token (has positionIndices array)
                if (residueData.isLigandToken && residueData.positionIndices) {
                    // For ligand tokens, check if any position in the ligand is selected
                    const isSelected = residueData.positionIndices.some(positionIndex => visiblePositions.has(positionIndex));
                    
                    drawLigandTokenOnCanvas(
                        ctx,
                        residueData.ligandName || 'LIG',
                        pos.x,
                        pos.y,
                        pos.width,
                        pos.height,
                        color,
                        isSelected,
                        dimFactor
                    );
                } else if (residueData.positionIndex === -1) {
                    // Gap marker (missing positions) - always draw as "-"
                    drawResidueCharOnCanvas(
                        ctx,
                        '-', // Always use "-" for gaps
                        pos.x,
                        pos.y,
                        pos.width,
                        pos.height,
                        color,
                        false, // Gaps are never selected
                        dimFactor
                    );
                } else if (residueData.positionIndex >= 0) {
                    // Regular position character
                    const isSelected = visiblePositions.has(residueData.positionIndex);
                    
                    drawResidueCharOnCanvas(
                        ctx,
                        residueData.letter,
                        pos.x,
                        pos.y,
                        pos.width,
                        pos.height,
                        color,
                        isSelected,
                        dimFactor
                    );
                }
            }
        }
        
        // Draw hover highlight if needed (will be handled in event handlers)
    }

    // ============================================================================
    // MAIN SEQUENCE VIEWER FUNCTIONS
    // ============================================================================
    
    function buildSequenceView() {
        const sequenceViewEl = document.getElementById('sequenceView');
        if (!sequenceViewEl) return;

        // Clear cache when rebuilding
        lastSequenceUpdateHash = null;
        sequenceCanvasData = null;

        sequenceViewEl.innerHTML = '';

        // Get renderer instance
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;

        // Get object name from dropdown first, fallback to renderer's currentObjectName
        const objectSelect = callbacks.getObjectSelect ? callbacks.getObjectSelect() : null;
        const objectName = objectSelect?.value || renderer?.currentObjectName;
        if (!objectName || !renderer) return;

        const object = renderer.objectsData[objectName];
        if (!object || !object.frames || object.frames.length === 0) return;

        // Use current frame instead of always first frame (for animation support)
        const currentFrameIndex = renderer.currentFrame >= 0 ? renderer.currentFrame : 0;
        const currentFrame = object.frames[currentFrameIndex];
        if (!currentFrame || !currentFrame.coords || currentFrame.coords.length === 0) return;

        // Check if sequence actually changed - only rebuild if it did
        const lastFrame = lastSequenceFrameIndex >= 0 && lastSequenceFrameIndex < object.frames.length 
            ? object.frames[lastSequenceFrameIndex] 
            : null;
        
        // Only rebuild if sequence changed or this is first build
        if (lastFrame && !sequencesDiffer(currentFrame, lastFrame) && sequenceCanvasData) {
            // Sequence hasn't changed, just update colors and selection
            updateSequenceViewColors();
            updateSequenceViewSelectionState();
            lastSequenceFrameIndex = currentFrameIndex;
            return;
        }

        lastSequenceFrameIndex = currentFrameIndex;

        // Get data with fallbacks for missing information
        // coords is a flat array [x, y, z, x, y, z, ...], so we need to divide by 3
        // Or better yet, use the length of position_names or chains if available
        const positionNames = currentFrame.position_names || [];
        const residueNumbers = currentFrame.residue_numbers || [];
        const chains = currentFrame.chains || [];
        const position_types = currentFrame.position_types || [];
        
        // Determine number of positions: prefer position_names or chains length, fallback to coords.length / 3
        let n = 0;
        if (positionNames.length > 0) {
            n = positionNames.length;
        } else if (chains.length > 0) {
            n = chains.length;
        } else if (currentFrame.coords) {
            // coords is flat array [x, y, z, ...], so divide by 3
            n = Math.floor(currentFrame.coords.length / 3);
        }
        
        if (n === 0) return;
        
        
        // Check if position names are available - if not, we can't group ligands with names
        const hasPositionNames = positionNames && positionNames.length === n;
        
        // Create one entry per position (one position = one position, no collapsing)
        // Default to chain 'A', position name 'UNK', sequential position index, and type 'P' (protein)
        const positionEntries = [];
        for (let i = 0; i < n; i++) {
            positionEntries.push({
                chain: (chains && chains.length > i && chains[i]) ? chains[i] : 'A',
                resName: (positionNames && positionNames.length > i && positionNames[i]) ? positionNames[i] : 'UNK',
                resSeq: (residueNumbers && residueNumbers.length > i && residueNumbers[i] != null) ? residueNumbers[i] : (i + 1),
                positionIndex: i, // Direct position index
                positionType: (position_types && position_types.length > i && position_types[i]) ? position_types[i] : 'P' // Default to protein
            });
        }

        // Sort by chain, then by position index (maintains order within chain) - UNIFIED ORDER
        const sortedPositionEntries = positionEntries.sort((a, b) => {
            if (a.chain < b.chain) return -1;
            if (a.chain > b.chain) return 1;
            return a.positionIndex - b.positionIndex;
        });
        
        // Track chain boundaries for unified sequence
        const chainBoundaries = [];
        let currentChain = null;
        let chainStart = 0;
        for (let i = 0; i < sortedPositionEntries.length; i++) {
            if (sortedPositionEntries[i].chain !== currentChain) {
                if (currentChain !== null) {
                    chainBoundaries.push({
                        chain: currentChain,
                        startIndex: chainStart,
                        endIndex: i - 1
                    });
                }
                currentChain = sortedPositionEntries[i].chain;
                chainStart = i;
            }
        }
        // Add last chain
        if (currentChain !== null) {
            chainBoundaries.push({
                chain: currentChain,
                startIndex: chainStart,
                endIndex: sortedPositionEntries.length - 1
            });
        }

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
        
        // Detect sequence type based on position names
        const detectSequenceType = (positionNames) => {
            if (positionNames.length === 0) return 'protein';
            
            let dnaCount = 0;
            let rnaCount = 0;
            let proteinCount = 0;
            
            // First pass: check for unambiguous indicators (U = RNA, T/DT = DNA)
            let hasU = false;
            let hasT = false;
            
            for (const resName of positionNames) {
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
        
        // Build chain-to-sequence-type mapping for unified sequence
        const chainSequenceTypes = {};
        for (const boundary of chainBoundaries) {
            const chainResidues = sortedPositionEntries.slice(boundary.startIndex, boundary.endIndex + 1);
            const chainResidueNames = chainResidues.map(r => r.resName);
            chainSequenceTypes[boundary.chain] = detectSequenceType(chainResidueNames);
        }
        
        // Helper function to get position letter based on chain's sequence type
        const getPositionLetter = (position) => {
            const chainType = chainSequenceTypes[position.chain] || 'protein';
            let upper = (position.resName || '').toString().trim().toUpperCase();
            
            // Map modified residues to standard equivalents (e.g., MSE -> MET)
            // Use getStandardResidueName if available (from utils.js), otherwise use local mapping
            if (typeof getStandardResidueName === 'function') {
                upper = getStandardResidueName(upper).toUpperCase();
            } else {
                // Fallback: local mapping for common modifications
                const modifiedToStandard = {
                    'MSE': 'MET', 'PTR': 'TYR', 'SEP': 'SER', 'TPO': 'THR',
                    'FME': 'MET', 'HYP': 'PRO', 'PCA': 'GLU', 'ALY': 'LYS',
                    '5MDA': 'DA', '5MDC': 'DC', '5MDG': 'DG',
                    'M6A': 'A', 'M5C': 'C', 'M7G': 'G', 'PSU': 'U'
                };
                if (modifiedToStandard[upper]) {
                    upper = modifiedToStandard[upper];
                }
            }
            
            if (chainType === 'dna') {
                return dnaMapping[upper] || 'N';
            } else if (chainType === 'rna') {
                if (rnaMapping[upper]) return rnaMapping[upper];
                if (upper === 'U') return 'U';
                if (upper.includes('U') || upper.includes('URI') || upper.includes('URA')) return 'U';
                if (upper.includes('A') && !upper.includes('D')) return 'A';
                if (upper.includes('C') && !upper.includes('D')) return 'C';
                if (upper.includes('G') && !upper.includes('D')) return 'G';
                return 'N';
            } else {
                return threeToOne[upper] || 'X';
            }
        };

        // Canvas rendering settings
        const charWidth = 10; // Monospace character width
        const charHeight = 14; // Line height
        const spacing = 4; // Spacing between elements
        
        // Chain button uses same dimensions as sequence characters
        // Find the maximum chain ID length to make all buttons the same size
        const maxChainIdLength = Math.max(...chainBoundaries.map(b => b.chain.length), 3);
        const chainButtonWidth = (charWidth * maxChainIdLength + 20) * 2 / 3; // Fixed width for all buttons (2/3 of original size)
        
        // Calculate dynamic line breaks based on container width
        // Get actual container width to fill it completely
        const containerRect = sequenceViewEl ? sequenceViewEl.getBoundingClientRect() : null;
        // Use actual measured width, or fallback to calculated width if not available
        const sequenceContainerWidth = 948; // Known container width from HTML
        const containerBoxPadding = 12; // --container-padding from CSS
        const availableWidth = sequenceContainerWidth - (containerBoxPadding * 2); // 924px
        const containerWidth = containerRect && containerRect.width > 0 ? containerRect.width : availableWidth;
        const sequenceWidth = containerWidth;
        const charsPerLine = Math.floor(sequenceWidth / charWidth);

        // Create canvas element
        const canvas = document.createElement('canvas');
        canvas.id = 'sequenceCanvas';
        canvas.style.cursor = 'crosshair';
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        
        // Store all position data (not elements)
        const allResidueData = [];
        
        // Calculate layout positions
        const layout = {
            charWidth,
            charHeight,
            spacing,
            chainButtonWidth,
            charsPerLine,
            chainLabelPositions: [],
            residuePositions: [],
            selectableItems: [] // Unified selectable items array
        };
        
        let currentY = spacing;
        let maxWidth = 0;
        
        if (sequenceViewMode) {
            // SEQUENCE MODE: One row per chain
            for (const boundary of chainBoundaries) {
                const chainId = boundary.chain;
                const chainPositions = sortedPositionEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                
                // Chain label position
                const chainLabelX = spacing;
                const chainLabelY = currentY;
                const actualButtonWidth = chainButtonWidth + Math.round(4 * 2 / 3);
                const chainLabelHeight = charHeight;
                
                layout.chainLabelPositions.push({
                    chainId,
                    positionIndex: chainPositions[0].positionIndex,
                    x: chainLabelX,
                    y: chainLabelY,
                    width: actualButtonWidth,
                    height: chainLabelHeight
                });
                
                // Sequence positions
                let currentX = chainLabelX + actualButtonWidth + spacing;
                let lineStartX = currentX;
                let lineY = currentY;
                let maxLineY = lineY; // Track maximum Y for this chain
                
                let lastResSeq = null;
                let lastPositionType = null;
                const ligandTokenWidth = charWidth * 2; // Ligand tokens take 2 character widths
                
                // Get ligand groups from renderer (computed using shared utility)
                const ligandGroups = renderer?.ligandGroups || new Map();
                
                // Create reverse map: position index -> ligand group key (for quick lookup)
                const positionToLigandGroup = new Map();
                for (const [groupKey, positionIndicesInGroup] of ligandGroups) {
                    for (const positionIndex of positionIndicesInGroup) {
                        positionToLigandGroup.set(positionIndex, groupKey);
                    }
                }
                
                // Track which ligand groups we've already processed
                const processedLigandGroups = new Set();
                
                // Group positions into display items (regular positions or ligand tokens)
                const displayItems = [];
                let i = 0;
                while (i < chainPositions.length) {
                    const position = chainPositions[i];
                    
                    // Check if this position belongs to a ligand group
                    const ligandGroupKey = positionToLigandGroup.get(position.positionIndex);
                    
                    if (ligandGroupKey && !processedLigandGroups.has(ligandGroupKey)) {
                        // This position is part of a ligand group - create ligand token
                        const ligandPositionIndices = ligandGroups.get(ligandGroupKey);
                        if (ligandPositionIndices && ligandPositionIndices.length > 0) {
                            // Find the first position of this ligand group in chainPositions (for ordering)
                            let firstPositionInChain = null;
                            let firstPositionIdxInChain = -1;
                            for (let j = 0; j < chainPositions.length; j++) {
                                if (ligandPositionIndices.includes(chainPositions[j].positionIndex)) {
                                    firstPositionInChain = chainPositions[j];
                                    firstPositionIdxInChain = chainPositions[j].positionIndex;
                                    break;
                                }
                            }
                            
                            if (firstPositionInChain) {
                                // Create ligand token even if position name is missing (use fallback name)
                                // This ensures ligands are grouped even when residue_numbers/position_names are missing
                                const ligandResName = (hasPositionNames && firstPositionInChain.resName && firstPositionInChain.resName !== 'UNK') 
                                    ? firstPositionInChain.resName 
                                    : 'LIG'; // Fallback name for ligands without position names
                                
                                // Create ligand token (color will be computed dynamically at render time)
                                displayItems.push({
                                    type: 'ligand',
                                    resSeq: firstPositionInChain.resSeq,
                                    resName: ligandResName,
                                    positionIndices: ligandPositionIndices,
                                    chain: firstPositionInChain.chain
                                });
                                
                                // Mark this ligand group as processed
                                processedLigandGroups.add(ligandGroupKey);
                                
                                // Skip all positions in this ligand group
                                while (i < chainPositions.length && ligandPositionIndices.includes(chainPositions[i].positionIndex)) {
                                    i++;
                                }
                                continue;
                            }
                        }
                    }
                    
                    // Regular position (ligands with grouping are handled above)
                    displayItems.push({
                        type: 'atom',
                        atom: position
                    });
                    i++;
                }
                
                // Now render display items
                for (let itemIdx = 0; itemIdx < displayItems.length; itemIdx++) {
                    const item = displayItems[itemIdx];
                    const prevItem = itemIdx > 0 ? displayItems[itemIdx - 1] : null;
                    
                    // Determine width for this item
                    const itemWidth = item.type === 'ligand' ? ligandTokenWidth : charWidth;
                    
                    // Check if we need to wrap
                    if (currentX + itemWidth > sequenceWidth - spacing) {
                        currentX = lineStartX;
                        lineY += charHeight; // No extra spacing between wrapped lines in same chain
                        maxLineY = Math.max(maxLineY, lineY);
                    }
                    
                    // Add spacing/gaps between items
                    if (prevItem) {
                        const prevResSeq = prevItem.type === 'ligand' ? prevItem.resSeq : prevItem.atom.resSeq;
                        const prevPositionType = prevItem.type === 'ligand' ? 'L' : prevItem.atom.positionType;
                        const currResSeq = item.type === 'ligand' ? item.resSeq : item.atom.resSeq;
                        const currPositionType = item.type === 'ligand' ? 'L' : item.atom.positionType;
                        
                        const positionTypeChanged = prevPositionType !== currPositionType;
                        const ligandResSeqChanged = currPositionType === 'L' && prevPositionType === 'L' && prevResSeq !== currResSeq;
                        const samePositionType = prevPositionType === currPositionType;
                        const resSeqDiff = currResSeq - prevResSeq;
                        const resSeqChanged = prevResSeq !== currResSeq;
                        const isChainBreak = samePositionType && 
                                             resSeqChanged &&
                                             (prevPositionType === 'P' || prevPositionType === 'D' || prevPositionType === 'R') &&
                                             resSeqDiff > 1;
                        
                        if (positionTypeChanged || ligandResSeqChanged) {
                            // Add spacer
                            currentX += charWidth;
                        } else if (isChainBreak) {
                            // Add gap characters
                            const numMissingResidues = resSeqDiff - 1;
                            for (let g = 0; g < numMissingResidues; g++) {
                                // Check wrap
                                if (currentX + charWidth > containerWidth - spacing) {
                                    currentX = lineStartX;
                                    lineY += charHeight; // No extra spacing between wrapped lines in same chain
                                    maxLineY = Math.max(maxLineY, lineY);
                                }
                                
                                layout.residuePositions.push({
                                    residueData: {
                                        positionIndex: -1, // Gap marker
                                        letter: '-',
                                        color: {r: 240, g: 240, b: 240},
                                        resSeq: prevResSeq + g + 1,
                                        chain: item.chain
                                    },
                                    x: currentX,
                                    y: lineY,
                                    width: charWidth,
                                    height: charHeight
                                });
                                currentX += charWidth;
                            }
                        }
                    }
                    
                    // Check wrap before adding item
                    if (currentX + itemWidth > sequenceWidth - spacing) {
                        currentX = lineStartX;
                        lineY += charHeight; // No extra spacing between wrapped lines in same chain
                        maxLineY = Math.max(maxLineY, lineY);
                    }
                    
                    if (item.type === 'ligand') {
                        // Create ligand token data (color will be computed dynamically at render time)
                        const ligandTokenData = {
                            isLigandToken: true,
                            positionIndices: item.positionIndices,
                            ligandName: item.resName,
                            resSeq: item.resSeq,
                            chain: item.chain,
                            resName: item.resName
                        };
                        allResidueData.push(ligandTokenData);
                        
                        // Store position
                        layout.residuePositions.push({
                            residueData: ligandTokenData,
                            x: currentX,
                            y: lineY,
                            width: itemWidth,
                            height: charHeight
                        });
                    } else {
                        // Regular position
                        const atom = item.atom;
                        const letter = getPositionLetter(atom);
                        
                        // Store position data (color will be computed dynamically at render time)
                        const residueData = {
                            positionIndex: atom.positionIndex,
                            letter,
                            resSeq: atom.resSeq,
                            chain: atom.chain,
                            resName: atom.resName // Store position name for tooltip
                        };
                        allResidueData.push(residueData);
                        
                        // Store position
                        layout.residuePositions.push({
                            residueData,
                            x: currentX,
                            y: lineY,
                            width: itemWidth,
                            height: charHeight
                        });
                    }
                    
                    currentX += itemWidth;
                    if (item.type === 'ligand') {
                        lastResSeq = item.resSeq;
                        lastPositionType = 'L';
                    } else {
                        lastResSeq = item.atom.resSeq;
                        lastPositionType = item.atom.positionType;
                    }
                }
                
                // Update currentY for next chain (use maxLineY to account for wrapping)
                currentY = maxLineY + charHeight + spacing;
                maxWidth = Math.max(maxWidth, currentX);
            }
        } else {
            // CHAIN MODE: Inline chain labels that wrap
            let currentX = spacing;
            let lineStartX = spacing;
            let lineY = currentY;
            
            for (const boundary of chainBoundaries) {
                const chainId = boundary.chain;
                const actualButtonWidth = chainButtonWidth + Math.round(4 * 2 / 3);
                
                // Check if we need to wrap
                if (currentX + actualButtonWidth > containerWidth - spacing) {
                    currentX = lineStartX;
                    lineY += charHeight + spacing;
                }
                
                layout.chainLabelPositions.push({
                    chainId,
                    positionIndex: sortedPositionEntries[boundary.startIndex].positionIndex,
                    x: currentX,
                    y: lineY,
                    width: actualButtonWidth,
                    height: charHeight
                });
                
                currentX += actualButtonWidth + spacing;
                maxWidth = Math.max(maxWidth, currentX);
            }
            
            currentY = lineY + charHeight + spacing;
        }
        
        // Build unified selectableItems array
        let itemIndex = 0;
        
        // Add chain items (one per chain)
        for (const chainPos of layout.chainLabelPositions) {
            const chainId = chainPos.chainId;
            const boundary = chainBoundaries.find(b => b.chain === chainId);
            if (boundary) {
                const chainPositions = sortedPositionEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                const positionIndices = chainPositions.map(a => a.positionIndex);
                
                // For chain items, expand hit box to full row height to eliminate gaps
                // Find the row height (next chain's Y - this chain's Y, or end of canvas)
                let rowHeight = chainPos.height;
                if (sequenceViewMode) {
                    // In sequence mode, each chain is one row
                    // Find next chain's Y position
                    let nextChainY = Infinity;
                    for (const nextChainPos of layout.chainLabelPositions) {
                        if (nextChainPos.y > chainPos.y) {
                            nextChainY = Math.min(nextChainY, nextChainPos.y);
                        }
                    }
                    if (nextChainY !== Infinity) {
                        rowHeight = nextChainY - chainPos.y;
                    } else {
                        // Last chain - use charHeight as minimum
                        rowHeight = Math.max(charHeight, rowHeight);
                    }
                }
                
                layout.selectableItems.push({
                    type: 'chain',
                    id: `chain-${chainId}`,
                    chainId: chainId,
                    positionIndices: positionIndices,
                    bounds: {
                        x: chainPos.x,
                        y: chainPos.y,
                        width: chainPos.width,
                        height: rowHeight // Full row height to eliminate gaps
                    },
                    index: itemIndex++
                });
            }
        }
        
        // Add position and ligand items (only in sequence mode, or if we want them in chain mode too)
        if (sequenceViewMode) {
            for (const residuePos of layout.residuePositions) {
                const residueData = residuePos.residueData;
                let positionIndices;
                let type;
                
                if (residueData.isLigandToken && residueData.positionIndices) {
                    type = 'ligand';
                    positionIndices = residueData.positionIndices;
                } else if (residueData.positionIndex >= 0) {
                    type = 'residue';
                    positionIndices = [residueData.positionIndex];
                } else {
                    continue; // Skip invalid items
                }
                
                layout.selectableItems.push({
                    type: type,
                    id: type === 'ligand' 
                        ? `ligand-${residueData.positionIndices[0]}` 
                        : `residue-${residueData.positionIndex}`,
                    positionIndices: positionIndices,
                    residueData: residueData,
                    bounds: {
                        x: residuePos.x,
                        y: residuePos.y,
                        width: residuePos.width,
                        height: residuePos.height
                    },
                    index: itemIndex++
                });
            }
        }
        
        // Restrict visible height to 32 lines of characters
        const maxVisibleHeight = 32 * charHeight + spacing; // 32 lines + spacing
        const fullHeight = currentY; // Full content height
        
        // Set canvas internal dimensions to achieve 200 DPI (pixels per inch)
        // Standard web DPI is 96, so 200 DPI = 200/96 ≈ 2.083x multiplier
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        
        // Canvas should be full height to render all content
        canvas.width = sequenceWidth * dpiMultiplier;
        canvas.height = fullHeight * dpiMultiplier;
        
        // Set display size (CSS pixels) - canvas is full height
        canvas.style.width = '100%';
        canvas.style.height = fullHeight + 'px';
        
        // Restrict container height to 32 lines and enable scrolling if needed
        if (fullHeight > maxVisibleHeight) {
            sequenceViewEl.style.overflowY = 'auto';
            sequenceViewEl.style.maxHeight = maxVisibleHeight + 'px';
        } else {
            sequenceViewEl.style.overflowY = 'visible';
            sequenceViewEl.style.maxHeight = 'none';
        }
        
        const ctx = canvas.getContext('2d');
        
        // Scale context by DPI multiplier to account for high-resolution canvas
        ctx.scale(dpiMultiplier, dpiMultiplier);
        
        sequenceViewEl.appendChild(canvas);
        
        // Store structure
        sequenceCanvasData = {
            canvas,
            ctx,
            allResidueData,
            chainBoundaries,
            sortedPositionEntries,
            layout,
            mode: sequenceViewMode
        };
        
        // Setup canvas event handlers
        setupCanvasSequenceEvents();
        
        // Initial render
        renderSequenceCanvas();
    }

    // Canvas-based sequence event handlers
    function setupCanvasSequenceEvents() {
        if (!sequenceCanvasData) return;
        
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;
        
        // Store drag state (shared across all chains)
        // initialSelectionState: tracks the selection state at drag start
        // dragUnselectMode: true if we started on a selected item (unselect mode), false if we started on unselected (select mode)
        // dragStartItem: the selectable item where drag started (unified system)
        // dragEndItemIndex: the index of the selectable item where drag currently ends
        // Simple drag state
        const dragState = { 
            active: false,           // Is a drag operation active?
            startItem: null,         // Item where drag started
            endItemIndex: -1,        // Current end item index
            initialPositions: null,  // Selection state before drag started
            unselectMode: false      // true = unselecting, false = selecting
        };
        
        const { canvas, allResidueData, chainBoundaries, sortedPositionEntries, layout } = sequenceCanvasData;
        
        // Remove old event listeners by cloning the canvas
        const newCanvas = canvas.cloneNode(false);
        canvas.parentNode.replaceChild(newCanvas, canvas);
        sequenceCanvasData.canvas = newCanvas;
        sequenceCanvasData.ctx = newCanvas.getContext('2d');
        // Apply DPI multiplier scaling to match the canvas resolution (200 DPI)
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        sequenceCanvasData.ctx.scale(dpiMultiplier, dpiMultiplier);
        
        // Helper: Apply selection to renderer
        const applySelection = (positions) => {
            const objectName = renderer.currentObjectName;
            const obj = renderer.objectsData[objectName];
            const frame = obj?.frames?.[0];
            if (!frame) return;
            
            const newChains = new Set();
            if (frame.chains) {
                for (const positionIndex of positions) {
                    const positionChain = frame.chains[positionIndex];
                    if (positionChain) {
                        newChains.add(positionChain);
                    }
                }
            }
            
            const totalPositions = frame.chains?.length || 0;
            const hasPartialSelections = positions.size > 0 && positions.size < totalPositions;
            const allChains = new Set(frame.chains);
            const allChainsSelected = newChains.size === allChains.size && 
                                    Array.from(newChains).every(c => allChains.has(c));
            const selectionMode = (allChainsSelected && !hasPartialSelections && positions.size > 0) ? 'default' : 'explicit';
            const chainsToSet = (allChainsSelected && !hasPartialSelections && positions.size > 0) ? new Set() : newChains;
            
            renderer.setSelection({ 
                positions: positions,
                chains: chainsToSet,
                selectionMode: selectionMode,
                paeBoxes: [] 
            });
        };
        
        // Helper: Toggle positions in an item
        const toggleItemPositions = (item, currentPositions) => {
            const newPositions = new Set(currentPositions);
            if (item.positionIndices && item.positionIndices.length > 0) {
                item.positionIndices.forEach(positionIndex => {
                    if (newPositions.has(positionIndex)) {
                        newPositions.delete(positionIndex);
                    } else {
                        newPositions.add(positionIndex);
                    }
                });
            }
            return newPositions;
        };
        
        // Helper: Compute selection from item range
        const computeSelectionFromRange = (startIndex, endIndex, basePositions, unselectMode) => {
            const [min, max] = [Math.min(startIndex, endIndex), Math.max(startIndex, endIndex)];
            const newPositions = new Set(basePositions);
            
            for (let i = min; i <= max; i++) {
                const item = layout.selectableItems[i];
                if (item && item.positionIndices) {
                    item.positionIndices.forEach(positionIndex => {
                        if (unselectMode) {
                            newPositions.delete(positionIndex);
                        } else {
                            newPositions.add(positionIndex);
                        }
                    });
                }
            }
            
            return newPositions;
        };
        
        // Mouse down handler
        newCanvas.addEventListener('mousedown__DISABLED', (e) => {
            if (e.button !== 0) return;
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const item = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            if (!item) return;
            
            // Chain buttons: toggle immediately, no drag
            if (item.type === 'chain') {
                const chainId = item.chainId;
                const current = renderer?.getSelection();
                const isSelected = current?.chains?.has(chainId) || 
                    (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
                if (e.altKey && callbacks.toggleChainResidues) {
                    callbacks.toggleChainResidues(chainId);
                } else if (callbacks.setChainResiduesSelected) {
                    callbacks.setChainResiduesSelected(chainId, !isSelected);
                }
                lastSequenceUpdateHash = null;
                scheduleRender();
                return;
            }
            
            // Position/ligand: toggle immediately, then set up for potential drag
            const current = renderer?.getSelection();
            const currentPositions = current?.positions || new Set();
            
            // Toggle immediately
            const toggledPositions = toggleItemPositions(item, currentPositions);
            applySelection(toggledPositions);
            lastSequenceUpdateHash = null;
            scheduleRender();
            
            // Set up drag state (using toggled state as baseline)
            const wasSelected = item.positionIndices.length > 0 && 
                item.positionIndices.every(pi => currentPositions.has(pi));
            dragState.active = false;
            dragState.startItem = item;
            dragState.endItemIndex = item.index;
            dragState.initialPositions = new Set(toggledPositions);
            dragState.unselectMode = !wasSelected; // After toggle, mode is flipped
            
            // Set up window listeners for drag
            const handleMove = (e) => {
                if (!dragState.startItem) return;
                
                // Check if button still pressed
                const buttons = e.buttons !== undefined ? e.buttons : (e.which || 0);
                if (!(buttons & 1)) return;
                
                const dragPos = getCanvasPositionFromMouse(e, newCanvas);
                const endItem = getSelectableItemAtPosition(dragPos.x, dragPos.y, layout, sequenceViewMode);
                
                if (endItem && endItem.index !== dragState.startItem.index) {
                    // Moved to different item - start/continue drag
                    dragState.active = true;
                    
                    if (endItem.index !== dragState.endItemIndex) {
                        dragState.endItemIndex = endItem.index;
                        
                        // Compute preview selection
                        const previewPositions = computeSelectionFromRange(
                            dragState.startItem.index,
                            endItem.index,
                            dragState.initialPositions,
                            dragState.unselectMode
                        );
                        
                        if (callbacks.setPreviewSelectionSet) {
                            callbacks.setPreviewSelectionSet(previewPositions);
                        }
                        lastSequenceUpdateHash = null;
                        scheduleRender();
                    }
                }
            };
            
            const handleUp = () => {
                const previewSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
                
                // If drag happened, apply the drag selection
                if (dragState.active && previewSet) {
                    applySelection(previewSet);
                }
                // Otherwise, toggle was already applied on mousedown
                
                // Cleanup
                if (callbacks.setPreviewSelectionSet) callbacks.setPreviewSelectionSet(null);
                dragState.active = false;
                dragState.startItem = null;
                dragState.endItemIndex = -1;
                dragState.initialPositions = null;
                lastSequenceUpdateHash = null;
                scheduleRender();
                
                window.removeEventListener('mousemove', handleMove);
                window.removeEventListener('mouseup', handleUp);
            };
            
            window.addEventListener('mousemove', handleMove);
            window.addEventListener('mouseup', handleUp);
        });
        
        // Mouse move handler - only handle hover
        newCanvas.addEventListener('mousemove', (e) => {
            if (!sequenceCanvasData || sequenceCanvasData.canvas !== newCanvas) return;
            
            // Don't handle hover during drag
            if (dragState.active) return;
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const chainLabelPos = getChainLabelAtCanvasPosition(pos.x, pos.y, layout);
            const residuePos = getResidueAtCanvasPosition(pos.x, pos.y, layout);
            
            if (residuePos && residuePos.residueData) {
                const residueData = residuePos.residueData;
                if (residueData.isLigandToken && residueData.positionIndices && callbacks.highlightAtoms) {
                    // Highlight all positions in ligand
                    callbacks.highlightAtoms(new Set(residueData.positionIndices));
                    hoveredResidueInfo = {
                        chain: residueData.chain,
                        resName: residueData.ligandName || residueData.resName,
                        resSeq: residueData.resSeq
                    };
                } else if (residueData.positionIndex >= 0 && callbacks.highlightAtom) {
                    callbacks.highlightAtom(residueData.positionIndex);
                    // Store hovered position info for tooltip
                    hoveredResidueInfo = {
                        chain: residueData.chain,
                        resName: residueData.resName,
                        resSeq: residueData.resSeq
                    };
                } else {
                    hoveredResidueInfo = null;
                }
            } else if (chainLabelPos && callbacks.highlightAtoms) {
                // In both sequence mode and chain mode, highlight entire chain on hover over chain button
                const chainId = chainLabelPos.chainId;
                const boundary = chainBoundaries.find(b => b.chain === chainId);
                if (boundary) {
                    const chainPositions = sortedPositionEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                    if (chainPositions.length > 0) {
                        const positionIndices = new Set(chainPositions.map(a => a.positionIndex));
                        callbacks.highlightAtoms(positionIndices);
                    }
                }
                // Clear tooltip when hovering over chain button (in both modes)
                hoveredResidueInfo = null;
            } else {
                if (callbacks.clearHighlight) callbacks.clearHighlight();
                hoveredResidueInfo = null; // Clear tooltip when not hovering over position
            }
            // Trigger highlight redraw to show tooltip
            if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
                window.SequenceViewer.drawHighlights();
            }
        });
        
        newCanvas.addEventListener('mouseup', () => {
            // Cleanup handled by window listener
        });
        newCanvas.addEventListener('mouseleave', () => {
            // Clear hover state when mouse leaves
            if (callbacks.clearHighlight) callbacks.clearHighlight();
            hoveredResidueInfo = null;
            if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
                window.SequenceViewer.drawHighlights();
            }
        });
        
        // Touch event handlers - same logic as mouse handlers
        newCanvas.addEventListener('touchstart__DISABLED', (e) => {
            if (e.touches.length !== 1) return;
            e.preventDefault();
            
            const touch = e.touches[0];
            const pos = getCanvasPositionFromMouse(touch, newCanvas);
            const item = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            if (!item) return;
            
            // Chain buttons: toggle immediately, no drag
            if (item.type === 'chain') {
                const chainId = item.chainId;
                const current = renderer?.getSelection();
                const isSelected = current?.chains?.has(chainId) || 
                    (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
                if (callbacks.setChainResiduesSelected) {
                    callbacks.setChainResiduesSelected(chainId, !isSelected);
                }
                lastSequenceUpdateHash = null;
                scheduleRender();
                return;
            }
            
            // Position/ligand: toggle immediately, then set up for potential drag
            const current = renderer?.getSelection();
            const currentPositions = current?.positions || new Set();
            
            // Toggle immediately
            const toggledPositions = toggleItemPositions(item, currentPositions);
            applySelection(toggledPositions);
            lastSequenceUpdateHash = null;
            scheduleRender();
            
            // Set up drag state (using toggled state as baseline)
            const wasSelected = item.positionIndices.length > 0 && 
                item.positionIndices.every(pi => currentPositions.has(pi));
            dragState.active = false;
            dragState.startItem = item;
            dragState.endItemIndex = item.index;
            dragState.initialPositions = new Set(toggledPositions);
            dragState.unselectMode = !wasSelected; // After toggle, mode is flipped
            
            // Set up window listeners for drag
            const handleMove = (e) => {
                if (e.touches.length !== 1) return;
                e.preventDefault();
                if (!dragState.startItem) return;
                
                const dragTouch = e.touches[0];
                const dragPos = getCanvasPositionFromMouse(dragTouch, newCanvas);
                const endItem = getSelectableItemAtPosition(dragPos.x, dragPos.y, layout, sequenceViewMode);
                
                if (endItem && endItem.index !== dragState.startItem.index) {
                    // Moved to different item - start/continue drag
                    dragState.active = true;
                    
                    if (endItem.index !== dragState.endItemIndex) {
                        dragState.endItemIndex = endItem.index;
                        
                        // Compute preview selection
                        const previewPositions = computeSelectionFromRange(
                            dragState.startItem.index,
                            endItem.index,
                            dragState.initialPositions,
                            dragState.unselectMode
                        );
                        
                        if (callbacks.setPreviewSelectionSet) {
                            callbacks.setPreviewSelectionSet(previewPositions);
                        }
                        lastSequenceUpdateHash = null;
                        scheduleRender();
                    }
                }
            };
            
            const handleEnd = (e) => {
                e.preventDefault();
                const previewSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
                
                // If drag happened, apply the drag selection
                if (dragState.active && previewSet) {
                    applySelection(previewSet);
                }
                // Otherwise, toggle was already applied on touchstart
                
                // Cleanup
                if (callbacks.setPreviewSelectionSet) callbacks.setPreviewSelectionSet(null);
                dragState.active = false;
                dragState.startItem = null;
                dragState.endItemIndex = -1;
                dragState.initialPositions = null;
                lastSequenceUpdateHash = null;
                scheduleRender();
                
                window.removeEventListener('touchmove', handleMove);
                window.removeEventListener('touchend', handleEnd);
                window.removeEventListener('touchcancel', handleEnd);
            };
            
            window.addEventListener('touchmove', handleMove, { passive: false });
            window.addEventListener('touchend', handleEnd, { passive: false });
            window.addEventListener('touchcancel', handleEnd, { passive: false });
        });
        
        // === Unified selection handlers (press → optional drag → release) ===
        // Applies to chain, sequence, and ligand. Chain toggles on release (no drag),
        // sequence/ligand preview during drag; commit on release.
        newCanvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;

            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const item = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            if (!item) return;

            const current = renderer?.getSelection();
            const currentPositions = current?.positions || new Set();

            dragState.active = false;
            dragState.startItem = item;
            dragState.endItemIndex = item.index;
            dragState.initialPositions = new Set(currentPositions);
            dragState.unselectMode = !!(item.positionIndices && item.positionIndices.length > 0 &&
                item.positionIndices.every(pi => currentPositions.has(pi)));

            if (item.type !== 'chain') {
                const preview = computeSelectionFromRange(
                    item.index, item.index, dragState.initialPositions, dragState.unselectMode
                );
                setLocalPreview(preview);
                lastSequenceUpdateHash = null;
                scheduleRender();
            }

            const handleMove = (ev) => {
                const buttons = ev.buttons !== undefined ? ev.buttons : (ev.which || 0);
                if (!(buttons & 1)) return;

                const dragPos = getCanvasPositionFromMouse(ev, newCanvas);
                const over = getSelectableItemAtPosition(dragPos.x, dragPos.y, layout, sequenceViewMode);
                if (!over) return;

                if (item.type === 'chain') return; // chains don't support drag range; toggle on release only

                dragState.active = true;
                if (over.index !== dragState.endItemIndex) {
                    dragState.endItemIndex = over.index;

                    const preview = computeSelectionFromRange(
                        dragState.startItem.index,
                        over.index,
                        dragState.initialPositions,
                        dragState.unselectMode
                    );
                    setLocalPreview(preview);
                    lastSequenceUpdateHash = null;
                    scheduleRender();
                }
            };

            const handleUp = (ev) => {
                window.removeEventListener('mousemove', handleMove);
                window.removeEventListener('mouseup', handleUp);

                if (dragState.startItem?.type === 'chain') {
                    const upPos = getCanvasPositionFromMouse(ev, newCanvas);
                    const over = getSelectableItemAtPosition(upPos.x, upPos.y, layout, sequenceViewMode);
                    if (over && over.type === 'chain' && over.chainId === dragState.startItem.chainId) {
                        const chainId = over.chainId;
                        const sel = renderer?.getSelection();
                        const isSelected = sel?.chains?.has(chainId) ||
                            (sel?.selectionMode === 'default' && (!sel?.chains || sel.chains.size === 0));
                        if (ev.altKey && callbacks.toggleChainResidues) {
                            callbacks.toggleChainResidues(chainId);
                        } else if (callbacks.setChainResiduesSelected) {
                            callbacks.setChainResiduesSelected(chainId, !isSelected);
                        }
                    }
                } else {
                    const previewSet = getLocalPreview();
                    if (dragState.active && previewSet) {
                        applySelection(previewSet);
                    } else {
                        const toggled = toggleItemPositions(dragState.startItem, dragState.initialPositions);
                        applySelection(toggled);
                    }
                }

                setLocalPreview(null);
                dragState.active = false;
                dragState.startItem = null;
                dragState.endItemIndex = -1;
                dragState.initialPositions = null;
                lastSequenceUpdateHash = null;
                scheduleRender();
            };

            window.addEventListener('mousemove', handleMove);
            window.addEventListener('mouseup', handleUp);
        });

        newCanvas.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            e.preventDefault();

            const touch = e.touches[0];
            const pos = getCanvasPositionFromMouse(touch, newCanvas);
            const item = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            if (!item) return;

            const current = renderer?.getSelection();
            const currentPositions = current?.positions || new Set();

            dragState.active = false;
            dragState.startItem = item;
            dragState.endItemIndex = item.index;
            dragState.initialPositions = new Set(currentPositions);
            dragState.unselectMode = !!(item.positionIndices && item.positionIndices.length > 0 &&
                item.positionIndices.every(pi => currentPositions.has(pi)));

            if (item.type !== 'chain') {
                const preview = computeSelectionFromRange(
                    item.index, item.index, dragState.initialPositions, dragState.unselectMode
                );
                setLocalPreview(preview);
                lastSequenceUpdateHash = null;
                scheduleRender();
            }

            const handleMove = (ev) => {
                if (ev.touches.length !== 1) return;
                ev.preventDefault();
                const t = ev.touches[0];

                const dragPos = getCanvasPositionFromMouse(t, newCanvas);
                const over = getSelectableItemAtPosition(dragPos.x, dragPos.y, layout, sequenceViewMode);
                if (!over) return;
                if (item.type === 'chain') return; // no drag for chains

                dragState.active = true;
                if (over.index !== dragState.endItemIndex) {
                    dragState.endItemIndex = over.index;
                    const preview = computeSelectionFromRange(
                        dragState.startItem.index,
                        over.index,
                        dragState.initialPositions,
                        dragState.unselectMode
                    );
                    setLocalPreview(preview);
                    lastSequenceUpdateHash = null;
                    scheduleRender();
                }
            };

            const handleEnd = (ev) => {
                ev.preventDefault();

                if (dragState.startItem?.type === 'chain') {
                    const changedTouch = (ev.changedTouches && ev.changedTouches[0]) || null;
                    if (changedTouch) {
                        const upPos = getCanvasPositionFromMouse(changedTouch, newCanvas);
                        const over = getSelectableItemAtPosition(upPos.x, upPos.y, layout, sequenceViewMode);
                        if (over && over.type === 'chain' && over.chainId === dragState.startItem.chainId) {
                            const chainId = over.chainId;
                            const sel = renderer?.getSelection();
                            const isSelected = sel?.chains?.has(chainId) ||
                                (sel?.selectionMode === 'default' && (!sel?.chains || sel.chains.size === 0));
                            if (callbacks.setChainResiduesSelected) {
                                callbacks.setChainResiduesSelected(chainId, !isSelected);
                            }
                        }
                    }
                } else {
                    const previewSet = getLocalPreview();
                    if (dragState.active && previewSet) {
                        applySelection(previewSet);
                    } else {
                        const toggled = toggleItemPositions(dragState.startItem, dragState.initialPositions);
                        applySelection(toggled);
                    }
                }

                setLocalPreview(null);
                dragState.active = false;
                dragState.startItem = null;
                dragState.endItemIndex = -1;
                dragState.initialPositions = null;
                lastSequenceUpdateHash = null;
                scheduleRender();

                window.removeEventListener('touchmove', handleMove);
                window.removeEventListener('touchend', handleEnd);
                window.removeEventListener('touchcancel', handleEnd);
            };

            window.addEventListener('touchmove', handleMove, { passive: false });
            window.addEventListener('touchend', handleEnd, { passive: false });
            window.addEventListener('touchcancel', handleEnd, { passive: false });
        });
        // === End unified selection handlers ===
    }

    // Update colors in sequence view when color mode changes
    // Colors are now computed dynamically in renderSequenceCanvas(), so we just need to trigger a re-render
    function updateSequenceViewColors() {
        if (!sequenceCanvasData) return;
        
        // Invalidate hash to force redraw with new colors (computed dynamically)
        lastSequenceUpdateHash = null;
        scheduleRender();
    }

    function updateSequenceViewSelectionState() {
        if (!sequenceCanvasData) return;

        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;

        // Determine what's actually visible from the unified model or visibilityMask
        // Use previewSelectionSet during drag for live feedback
        let visiblePositions = new Set();
        
        const previewSelectionSet = getLocalPreview();
        
        if (previewSelectionSet && previewSelectionSet.size > 0) {
            // During drag, use preview selection for live feedback (already position indices)
            visiblePositions = new Set(previewSelectionSet);
        } else {
            // Use positions directly from selection model
            if (renderer.selectionModel && renderer.selectionModel.positions && renderer.selectionModel.positions.size > 0) {
                visiblePositions = new Set(renderer.selectionModel.positions);
            } else if (renderer.visibilityMask === null) {
                // null mask means all positions are visible (default mode)
                const n = renderer.coords ? renderer.coords.length : 0;
                for (let i = 0; i < n; i++) {
                    visiblePositions.add(i);
                }
            } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                // Non-empty Set means some positions are visible
                visiblePositions = new Set(renderer.visibilityMask);
            }
        }

        // Create hash to detect if selection actually changed
        // Include previewSelectionSet in hash to ensure live feedback during drag
        const previewHash = previewSelectionSet ? previewSelectionSet.size : 0;
        const currentHash = visiblePositions.size + previewHash + (renderer?.visibilityMask === null ? 'all' : 'some');
        if (currentHash === lastSequenceUpdateHash && !previewSelectionSet) {
            return; // No change, skip update (unless we have preview selection for live feedback)
        }
        lastSequenceUpdateHash = currentHash;

        // Trigger canvas redraw
        scheduleRender();
    }

    // ============================================================================
    // HIGHLIGHT OVERLAY MANAGEMENT
    // ============================================================================
    
    // Initialize highlight overlay canvas (positioned over main molecule viewer)
    function initializeHighlightOverlay() {
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer || !renderer.canvas) return;
        
        // Remove existing overlay if it exists
        if (highlightOverlayCanvas && highlightOverlayCanvas.parentElement) {
            highlightOverlayCanvas.parentElement.removeChild(highlightOverlayCanvas);
        }
        
        // Create highlight overlay canvas that sits on top of main canvas
        highlightOverlayCanvas = document.createElement('canvas');
        highlightOverlayCanvas.id = 'highlightOverlay';
        highlightOverlayCanvas.style.position = 'absolute';
        highlightOverlayCanvas.style.pointerEvents = 'none'; // Allow mouse events to pass through
        highlightOverlayCanvas.style.zIndex = '10';
        highlightOverlayCanvas.style.left = '0';
        highlightOverlayCanvas.style.top = '0';
        
        // Position it relative to the canvas container
        const container = renderer.canvas.parentElement;
        if (container) {
            container.style.position = 'relative';
            container.appendChild(highlightOverlayCanvas);
        }
        
        highlightOverlayCtx = highlightOverlayCanvas.getContext('2d');
        
        // Update overlay canvas size to match main canvas
        updateHighlightOverlaySize();
    }
    
    // Update highlight overlay canvas size and position to match main canvas
    function updateHighlightOverlaySize() {
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer || !highlightOverlayCanvas || !highlightOverlayCtx || !renderer.canvas) return;
        
        const displayWidth = renderer.displayWidth || renderer.canvas.width;
        const displayHeight = renderer.displayHeight || renderer.canvas.height;
        
        // Set canvas size
        highlightOverlayCanvas.width = displayWidth;
        highlightOverlayCanvas.height = displayHeight;
        highlightOverlayCanvas.style.width = displayWidth + 'px';
        highlightOverlayCanvas.style.height = displayHeight + 'px';
        
        // Position overlay to match main canvas position within container
        // Get the main canvas position relative to its container
        const mainCanvas = renderer.canvas;
        const container = mainCanvas.parentElement;
        if (container) {
            const containerRect = container.getBoundingClientRect();
            const canvasRect = mainCanvas.getBoundingClientRect();
            
            // Calculate offset of canvas within container
            const offsetLeft = canvasRect.left - containerRect.left;
            const offsetTop = canvasRect.top - containerRect.top;
            
            highlightOverlayCanvas.style.left = offsetLeft + 'px';
            highlightOverlayCanvas.style.top = offsetTop + 'px';
        }
    }
    
    // Draw highlights on overlay canvas without re-rendering main scene
    function drawHighlights() {
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer || !renderer.canvas) {
            return;
        }
        
        // Skip drawing highlights during dragging to prevent interference with drag operations
        if (renderer.isDragging) {
            return;
        }
        
        // Initialize overlay if it doesn't exist yet
        if (!highlightOverlayCanvas || !highlightOverlayCtx) {
            initializeHighlightOverlay();
            // If still not created, return early
            if (!highlightOverlayCanvas || !highlightOverlayCtx) {
                return;
            }
        }
        
        if (!renderer.positionScreenPositions) {
            return;
        }
        
        // Update overlay canvas size to match main canvas
        updateHighlightOverlaySize();
        
        // Clear overlay canvas
        const displayWidth = renderer.displayWidth || renderer.canvas.width;
        const displayHeight = renderer.displayHeight || renderer.canvas.height;
        highlightOverlayCtx.clearRect(0, 0, displayWidth, displayHeight);
        
        // Draw highlights if any
        const highlightFillStyle = 'rgba(255, 255, 0, 0.8)'; // Bright yellow for highlight
        const highlightStrokeStyle = 'rgba(255, 255, 0, 1.0)'; // Yellow border
        const highlightLineWidth = 1;
        
        highlightOverlayCtx.fillStyle = highlightFillStyle;
        highlightOverlayCtx.strokeStyle = highlightStrokeStyle;
        highlightOverlayCtx.lineWidth = highlightLineWidth;
        
        // Highlight multiple positions if specified (preferred method)
        if (renderer.highlightedAtoms !== null && renderer.highlightedAtoms instanceof Set && renderer.highlightedAtoms.size > 0) {
            for (const positionIndex of renderer.highlightedAtoms) {
                if (positionIndex >= 0 && positionIndex < renderer.positionScreenPositions.length) {
                    const pos = renderer.positionScreenPositions[positionIndex];
                    if (pos) {
                        highlightOverlayCtx.beginPath();
                        highlightOverlayCtx.arc(pos.x, pos.y, pos.radius, 0, Math.PI * 2);
                        highlightOverlayCtx.fill();
                        highlightOverlayCtx.stroke();
                    }
                }
            }
        } else if (renderer.highlightedAtom !== null && renderer.highlightedAtom !== undefined && typeof renderer.highlightedAtom === 'number') {
            const positionIndex = renderer.highlightedAtom;
            if (positionIndex >= 0 && positionIndex < renderer.positionScreenPositions.length) {
                const pos = renderer.positionScreenPositions[positionIndex];
                if (pos) {
                    highlightOverlayCtx.beginPath();
                    highlightOverlayCtx.arc(pos.x, pos.y, pos.radius, 0, Math.PI * 2);
                    highlightOverlayCtx.fill();
                    highlightOverlayCtx.stroke();
                }
            }
        }
        
        // Draw tooltip in bottom right corner if hovering over sequence
        if (hoveredResidueInfo) {
            const padding = 10;
            const fontSize = 14;
            const lineHeight = 18;
            const textColor = 'rgba(255, 255, 255, 0.95)';
            const bgColor = 'rgba(0, 0, 0, 0.75)';
            const cornerRadius = 4;
            
            highlightOverlayCtx.font = `${fontSize}px monospace`;
            highlightOverlayCtx.textAlign = 'right';
            highlightOverlayCtx.textBaseline = 'bottom';
            
            // Build tooltip text
            const lines = [
                `Chain: ${hoveredResidueInfo.chain}`,
                `Residue: ${hoveredResidueInfo.resName}`,
                `Index: ${hoveredResidueInfo.resSeq}`
            ];
            
            // Measure text to size background
            const textMetrics = lines.map(line => highlightOverlayCtx.measureText(line));
            const maxWidth = Math.max(...textMetrics.map(m => m.width));
            const totalHeight = lines.length * lineHeight;
            const bgPadding = 8;
            const bgWidth = maxWidth + bgPadding * 2;
            const bgHeight = totalHeight + bgPadding * 2;
            
            // Position in bottom right corner
            const x = displayWidth - padding;
            const y = displayHeight - padding;
            
            // Draw background with rounded corners
            highlightOverlayCtx.fillStyle = bgColor;
            highlightOverlayCtx.beginPath();
            highlightOverlayCtx.moveTo(x - bgWidth + cornerRadius, y - bgHeight);
            highlightOverlayCtx.arcTo(x - bgWidth, y - bgHeight, x - bgWidth, y - bgHeight + cornerRadius, cornerRadius);
            highlightOverlayCtx.lineTo(x - bgWidth, y - cornerRadius);
            highlightOverlayCtx.arcTo(x - bgWidth, y, x - bgWidth + cornerRadius, y, cornerRadius);
            highlightOverlayCtx.lineTo(x - cornerRadius, y);
            highlightOverlayCtx.arcTo(x, y, x, y - cornerRadius, cornerRadius);
            highlightOverlayCtx.lineTo(x, y - bgHeight + cornerRadius);
            highlightOverlayCtx.arcTo(x, y - bgHeight, x - cornerRadius, y - bgHeight, cornerRadius);
            highlightOverlayCtx.closePath();
            highlightOverlayCtx.fill();
            
            // Draw text
            highlightOverlayCtx.fillStyle = textColor;
            lines.forEach((line, i) => {
                highlightOverlayCtx.fillText(line, x - bgPadding, y - bgPadding - (lines.length - 1 - i) * lineHeight);
            });
        }
    }

    // ============================================================================
    // PUBLIC API
    // ============================================================================
    
    window.SequenceViewer = {
        // Initialize callbacks
        setCallbacks: function(cb) {
            callbacks = Object.assign({}, callbacks, cb);
            // Try to initialize highlight overlay when callbacks are set
            // (will be re-initialized when renderer becomes available if not ready yet)
            if (cb.getRenderer) {
                const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
                if (renderer && renderer.canvas) {
                    initializeHighlightOverlay();
                }
            }
        },
        
        // Main functions
        buildSequenceView: buildSequenceView,
        updateSequenceViewColors: updateSequenceViewColors,
        updateSequenceViewSelectionState: updateSequenceViewSelectionState,
        
        // Highlight overlay functions
        drawHighlights: drawHighlights,
        updateHighlightOverlaySize: updateHighlightOverlaySize,
        
        // State management
        setSequenceViewMode: function(mode) {
            sequenceViewMode = mode;
        },
        
        getSequenceViewMode: function() {
            return sequenceViewMode;
        },
        
        // Clear state
        clear: function() {
            sequenceCanvasData = null;
            lastSequenceFrameIndex = -1;
            lastSequenceUpdateHash = null;
        },
        
        // Clear preview for current object
        clearPreview: function() {
            setLocalPreview(null);
            lastSequenceUpdateHash = null;
            scheduleRender();
        }
    };

})();
