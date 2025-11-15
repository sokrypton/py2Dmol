// ============================================================================
// SEQUENCE VIEWER MODULE
// ============================================================================
// This module provides sequence viewer functionality for py2Dmol.
// It can be used in both web and Python interfaces.
// Now uses canvas-based rendering for improved performance.

(function() {
    'use strict';

    // ============================================================================
    // CONSTANTS
    // ============================================================================
    const CHAR_WIDTH = 10; // Monospace character width (matches MSA mode)
    
    // Helper to get DPI multiplier - use unified utility from utils.js
    function getDPIMultiplier() {
        if (typeof window !== 'undefined' && typeof window.getDPIMultiplier === 'function') {
            return window.getDPIMultiplier();
        }
        // Fallback if utils.js not loaded
        if (typeof window !== 'undefined' && window.canvasDPR !== undefined) {
            return window.canvasDPR;
        }
        return Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 1.5);
    }

    // ============================================================================
    // INTERNAL STATE
    // ============================================================================
    let sequenceCanvasData = null; // Canvas-based structure: { canvas, ctx, allPositionData, chainBoundaries, layout, mode }
    let lastSequenceFrameIndex = -1; // Track which frame the sequence view is showing
    let sequenceViewMode = true;  // Default: show sequence (enabled by default)
    let lastSequenceUpdateHash = null;
    let renderScheduled = false; // Flag to prevent multiple queued renders
    
    // Callbacks for integration with host application
    let callbacks = {
        getRenderer: null,           // () => renderer instance
        getObjectSelect: null,        // () => objectSelect element
        toggleChainPositions: null,    // (chain) => void
        setChainPositionsSelected: null, // (chain, selected) => void
        applySelection: null,         // (previewPositions) => void
        getPreviewSelectionSet: null, // () => Set | null
        setPreviewSelectionSet: null  // (Set | null) => void
    };

    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================
    
    // Check if sequence differs between frames
    function sequencesDiffer(frame1, frame2) {
        if (!frame1 || !frame2) return true;
        
        // Check coords length first (base requirement)
        const n1 = frame1.coords ? frame1.coords.length : 0;
        const n2 = frame2.coords ? frame2.coords.length : 0;
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
        // Get DPI multiplier - should match what was used to set up the canvas
        const dpiMultiplier = getDPIMultiplier();
        // Canvas internal size is dpiMultiplier * display size, but context is scaled, so we want display pixels
        const scaleX = (canvas.width / dpiMultiplier) / rect.width;
        const scaleY = (canvas.height / dpiMultiplier) / rect.height;
        
        return { 
            x: displayX * scaleX, 
            y: displayY * scaleY 
        };
    }

    // Find position at canvas position
    function getPositionAtCanvasPosition(x, y, layout) {
        if (!layout || !layout.positions) return null;
        
        for (const pos of layout.positions) {
            if (x >= pos.x && x < pos.x + pos.width && y >= pos.y && y < pos.y + pos.height) {
                return pos; // Return position object with positionData
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
        const positionLigandItems = items.filter(item => item.type === 'position' || item.type === 'ligand');
        const chainItems = items.filter(item => item.type === 'chain');
        
        // Priority 1: Check position/ligand items first (exact bounds)
        // These should take precedence over chain items in sequence mode
        for (const item of positionLigandItems) {
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
    function drawPositionCharOnCanvas(ctx, letter, x, y, width, height, color, isSelected, dimFactor) {
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
        ctx.font = '10px monospace'; // Matches MSA mode font size
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
        
        const { canvas, ctx, allPositionData, chainBoundaries, layout, sortedPositionEntries } = sequenceCanvasData;
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Get selection state - use selectionModel directly to avoid expensive getSelection() copy
        const selectionModel = renderer.selectionModel;
        const previewSelectionSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
        
        // Determine visible positions using unified helper
        const visiblePositions = window.getVisiblePositions(renderer, previewSelectionSet);
        
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
        if (layout.positions && allPositionData) {
            // Get renderer's getPositionColor function for dynamic color computation
            const hasGetPositionColor = renderer?.getPositionColor;
            
            for (const pos of layout.positions) {
                const positionData = pos.positionData;
                if (!positionData) continue;
                
                // Compute color dynamically based on current renderer state
                let color = {r: 128, g: 128, b: 128}; // Default fallback grey
                
                if (positionData.positionIndex === -1) {
                    // Gap markers (missing positions) use stored light grey color
                    color = positionData.color || {r: 240, g: 240, b: 240};
                } else if (positionData.isLigandToken && positionData.positionIndices && positionData.positionIndices.length > 0) {
                    // For ligand tokens, use first position's color
                    const firstPositionIndex = positionData.positionIndices[0];
                    if (hasGetPositionColor && !Number.isNaN(firstPositionIndex) && firstPositionIndex >= 0) {
                        color = renderer.getPositionColor(firstPositionIndex);
                    }
                } else if (positionData.positionIndex >= 0) {
                    // For regular positions, use position's color
                    if (hasGetPositionColor && !Number.isNaN(positionData.positionIndex)) {
                        color = renderer.getPositionColor(positionData.positionIndex);
                    }
                }
                
                // Check if this is a ligand token (has positionIndices array)
                if (positionData.isLigandToken && positionData.positionIndices) {
                    // For ligand tokens, check if any position in the ligand is selected
                    const isSelected = positionData.positionIndices.some(positionIndex => visiblePositions.has(positionIndex));
                    
                    drawLigandTokenOnCanvas(
                        ctx,
                        positionData.ligandName || 'LIG',
                        pos.x,
                        pos.y,
                        pos.width,
                        pos.height,
                        color,
                        isSelected,
                        dimFactor
                    );
                } else if (positionData.positionIndex === -1) {
                    // Gap marker (missing positions) - always draw as "-"
                    drawPositionCharOnCanvas(
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
                } else if (positionData.positionIndex >= 0) {
                    // Regular position character
                    const isSelected = visiblePositions.has(positionData.positionIndex);
                    
                    drawPositionCharOnCanvas(
                        ctx,
                        positionData.letter,
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
        const n = currentFrame.coords ? currentFrame.coords.length : 0;
        if (n === 0) return;
        
        const positionNames = currentFrame.position_names || [];
        const positionIndex = currentFrame.position_index || [];
        const chains = currentFrame.chains || [];
        const position_types = currentFrame.position_types || [];
        
        // Check if position names are available - if not, we can't group ligands with names
        const hasPositionNames = positionNames && positionNames.length === n;
        
        // Create one entry per position (one position = one position, no collapsing)
        // Default to chain 'A', position name 'UNK', sequential position index, and type 'P' (protein)
        const positionEntries = [];
        for (let i = 0; i < n; i++) {
            positionEntries.push({
                chain: (chains && chains.length > i && chains[i]) ? chains[i] : 'A',
                resName: (positionNames && positionNames.length > i && positionNames[i]) ? positionNames[i] : 'UNK',
                resSeq: (positionIndex && positionIndex.length > i && positionIndex[i] != null) ? positionIndex[i] : (i + 1),
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
            const chainPositions = sortedPositionEntries.slice(boundary.startIndex, boundary.endIndex + 1);
            const chainPositionNames = chainPositions.map(p => p.resName);
            chainSequenceTypes[boundary.chain] = detectSequenceType(chainPositionNames);
        }
        
        // Helper function to get position letter based on chain's sequence type
        // Use unified positionToLetter function from utils.js
        const getPositionLetter = (position) => {
            const chainType = chainSequenceTypes[position.chain] || 'protein';
            const positionName = position.resName || '';
            return window.positionToLetter(positionName, chainType);
        };

        // Canvas rendering settings
        const charWidth = CHAR_WIDTH; // Use constant for consistency with MSA viewer
        const charHeight = 20; // Line height (matches MSA SEQUENCE_ROW_HEIGHT)
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
        const allPositionData = [];
        
        // Calculate layout positions
        const layout = {
            charWidth,
            charHeight,
            spacing,
            chainButtonWidth,
            charsPerLine,
            chainLabelPositions: [],
            positions: [],
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
                                // This ensures ligands are grouped even when position_index/position_name are missing
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
                        type: 'position',
                        position: position
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
                    if (currentX + itemWidth > containerWidth - spacing) {
                        currentX = lineStartX;
                        lineY += charHeight; // No extra spacing between wrapped lines in same chain
                        maxLineY = Math.max(maxLineY, lineY);
                    }
                    
                    // Add spacing/gaps between items
                    if (prevItem) {
                        const prevResSeq = prevItem.type === 'ligand' ? prevItem.resSeq : prevItem.position.resSeq;
                        const prevPositionType = prevItem.type === 'ligand' ? 'L' : prevItem.position.positionType;
                        const currResSeq = item.type === 'ligand' ? item.resSeq : item.position.resSeq;
                        const currPositionType = item.type === 'ligand' ? 'L' : item.position.positionType;
                        
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
                            // Add gap characters for missing positions
                            const numMissingPositions = resSeqDiff - 1;
                            for (let g = 0; g < numMissingPositions; g++) {
                                // Check wrap
                                if (currentX + charWidth > containerWidth - spacing) {
                                    currentX = lineStartX;
                                    lineY += charHeight; // No extra spacing between wrapped lines in same chain
                                    maxLineY = Math.max(maxLineY, lineY);
                                }
                                
                                layout.positions.push({
                                    positionData: {
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
                    if (currentX + itemWidth > containerWidth - spacing) {
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
                        allPositionData.push(ligandTokenData);
                        
                        // Store position
                        layout.positions.push({
                            positionData: ligandTokenData,
                            x: currentX,
                            y: lineY,
                            width: itemWidth,
                            height: charHeight
                        });
                    } else {
                        // Regular position
                        const position = item.position;
                        const letter = getPositionLetter(position);
                        
                        // Store position data (color will be computed dynamically at render time)
                        const positionData = {
                            positionIndex: position.positionIndex,
                            letter,
                            resSeq: position.resSeq,
                            chain: position.chain,
                            resName: position.resName
                        };
                        allPositionData.push(positionData);
                        
                        // Store position
                        layout.positions.push({
                            positionData,
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
                        lastResSeq = item.position.resSeq;
                        lastPositionType = item.position.positionType;
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
            for (const positionPos of layout.positions) {
                const positionData = positionPos.positionData;
                let positionIndices;
                let type;
                
                if (positionData.isLigandToken && positionData.positionIndices) {
                    type = 'ligand';
                    positionIndices = positionData.positionIndices;
                } else if (positionData.positionIndex >= 0) {
                    type = 'position';
                    positionIndices = [positionData.positionIndex];
                } else {
                    continue; // Skip invalid items
                }
                
                layout.selectableItems.push({
                    type: type,
                    id: type === 'ligand' 
                        ? `ligand-${positionData.positionIndices[0]}` 
                        : `position-${positionData.positionIndex}`,
                    positionIndices: positionIndices,
                    positionData: positionData,
                    bounds: {
                        x: positionPos.x,
                        y: positionPos.y,
                        width: positionPos.width,
                        height: positionPos.height
                    },
                    index: itemIndex++
                });
            }
        }
        
        // Get actual container width to fill it completely
        const actualContainerRect = sequenceViewEl ? sequenceViewEl.getBoundingClientRect() : null;
        const displayWidth = actualContainerRect && actualContainerRect.width > 0 ? actualContainerRect.width : containerWidth;
        
        // Restrict visible height to 32 lines of characters
        const maxVisibleHeight = 32 * charHeight + spacing; // 32 lines + spacing
        const fullHeight = currentY; // Full content height
        
        // Append canvas first so container width is available
        sequenceViewEl.appendChild(canvas);
        
        // Set display size (CSS pixels) - canvas is full height
        // Set width to 100% first so we can get the actual rendered width
        canvas.style.width = '100%';
        canvas.style.height = fullHeight + 'px';
        
        // Get actual rendered width after setting style to 100%
        const actualRenderedWidth = canvas.getBoundingClientRect().width || displayWidth;
        
        // Get DPI multiplier - use same as main renderer for consistency
        const dpiMultiplier = getDPIMultiplier();
        
        // Set canvas internal dimensions using same DPI multiplier as main renderer
        // Use unified helper function with preserveWidthStyle and preserveHeightStyle to keep the styles we just set
        const ctx = window.setupHighDPICanvas(canvas, actualRenderedWidth, fullHeight, dpiMultiplier, { 
            preserveWidthStyle: true,
            preserveHeightStyle: true 
        });
        
        // Restrict container height to 32 lines and enable scrolling if needed
        if (fullHeight > maxVisibleHeight) {
            sequenceViewEl.style.overflowY = 'auto';
            sequenceViewEl.style.maxHeight = maxVisibleHeight + 'px';
        } else {
            sequenceViewEl.style.overflowY = 'visible';
            sequenceViewEl.style.maxHeight = 'none';
        }
        
        // Store structure
        sequenceCanvasData = {
            canvas,
            ctx,
            allPositionData,
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
        const dragState = { 
            isDragging: false, 
            dragStartItem: null, // Selectable item where drag started
            dragEndItemIndex: -1, // Index of current end item
            hasMoved: false, 
            dragUnselectMode: false, 
            initialSelectionState: new Set()
        };
        
        const { canvas, allPositionData, chainBoundaries, sortedPositionEntries, layout } = sequenceCanvasData;
        
        // Remove old event listeners by cloning the canvas
        const newCanvas = canvas.cloneNode(false);
        // Preserve canvas dimensions and styles before replacing
        const dpiMultiplier = getDPIMultiplier();
        const displayWidth = canvas.width / dpiMultiplier;
        const displayHeight = canvas.height / dpiMultiplier;
        const canvasStyleWidth = canvas.style.width;
        const canvasStyleHeight = canvas.style.height;
        canvas.parentNode.replaceChild(newCanvas, canvas);
        sequenceCanvasData.canvas = newCanvas;
        // Apply DPI multiplier scaling using unified helper, preserving original styles
        sequenceCanvasData.ctx = window.setupHighDPICanvas(newCanvas, displayWidth, displayHeight, dpiMultiplier, {
            preserveWidthStyle: true,
            preserveHeightStyle: true
        });
        // Restore original styles
        newCanvas.style.width = canvasStyleWidth;
        newCanvas.style.height = canvasStyleHeight;
        
        // Mouse down handler - using unified selectable items
        newCanvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left click
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const selectedItem = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            
            if (!selectedItem) return;
            
            // Handle chain items in both sequence mode and chain mode (toggle on click, no drag)
            if (selectedItem.type === 'chain') {
                const chainId = selectedItem.chainId;
                const current = renderer?.getSelection();
                const isSelected = current?.chains?.has(chainId) || 
                    (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
                if (e.altKey && callbacks.toggleChainPositions) {
                    callbacks.toggleChainPositions(chainId);
                } else if (callbacks.setChainPositionsSelected) {
                    callbacks.setChainPositionsSelected(chainId, !isSelected);
                }
                lastSequenceUpdateHash = null;
                scheduleRender();
                return;
            }
            
            // For all other items (position, ligand), enable drag
            const current = renderer?.getSelection();
            
            // Determine if item is initially selected
            // (Chain items are handled above with toggle on click, so this is only for position/ligand)
            let isInitiallySelected = false;
            // For position/ligand, check if all positions are selected
            // In default mode with empty positions, all positions are considered selected
            if (current?.selectionMode === 'default' && (!current?.positions || current.positions.size === 0)) {
                isInitiallySelected = true;
            } else {
                isInitiallySelected = selectedItem.positionIndices.length > 0 && 
                    selectedItem.positionIndices.every(positionIndex => current?.positions?.has(positionIndex));
            }
            
            dragState.isDragging = true;
            dragState.hasMoved = false;
            dragState.dragStartItem = selectedItem;
            dragState.dragEndItemIndex = selectedItem.index;
            dragState.dragUnselectMode = isInitiallySelected;
            // Capture initial selection state
            // If in default mode with empty positions, all positions are selected
            let initialPositions = new Set(current?.positions || []);
            if (current?.selectionMode === 'default' && initialPositions.size === 0) {
                // In default mode with empty positions, all positions are selected
                // Populate with all positions from the frame
                const objectName = renderer?.currentObjectName;
                const obj = renderer?.objectsData?.[objectName];
                const frame = obj?.frames?.[0];
                if (frame?.chains) {
                    for (let i = 0; i < frame.chains.length; i++) {
                        initialPositions.add(i);
                    }
                }
            }
            dragState.initialSelectionState = initialPositions;
            
            // Add temporary window listeners for drag outside canvas
            const handleMove = (e) => handleDragMove(e, newCanvas);
            const handleUp = () => {
                handleMouseUp();
                window.removeEventListener('mousemove', handleMove);
                window.removeEventListener('mouseup', handleUp);
            };
            window.addEventListener('mousemove', handleMove);
            window.addEventListener('mouseup', handleUp);
        });
        
        // Unified selection computation from item range
        const computeSelectionFromItemRange = (startItemIndex, endItemIndex, selectableItems, initialSelection, unselectMode) => {
            const [min, max] = [Math.min(startItemIndex, endItemIndex), Math.max(startItemIndex, endItemIndex)];
            const newPositions = new Set(initialSelection);
            
            for (let i = min; i <= max; i++) {
                const item = selectableItems[i];
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
        
        // Helper function to handle drag logic (can be called from canvas or window listeners)
        const handleDragMove = (e, canvas) => {
            if (!dragState.isDragging) return;
            if (!sequenceCanvasData || sequenceCanvasData.canvas !== canvas) return;
            
            const pos = getCanvasPositionFromMouse(e, canvas);
            const selectedItem = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            
            // Handle drag selection using unified items
            if (selectedItem && dragState.dragStartItem) {
                const startItem = dragState.dragStartItem;
                const endItem = selectedItem;
                
                // Only update if we moved to a different item
                if (endItem.index !== dragState.dragEndItemIndex) {
                    dragState.dragEndItemIndex = endItem.index;
                    dragState.hasMoved = true;
                    
                    // Compute selection from item range
                    const newPositions = computeSelectionFromItemRange(
                        startItem.index,
                        endItem.index,
                        layout.selectableItems,
                        dragState.initialSelectionState,
                        dragState.dragUnselectMode
                    );
                    
                    if (callbacks.setPreviewSelectionSet) callbacks.setPreviewSelectionSet(newPositions);
                    lastSequenceUpdateHash = null;
                    scheduleRender();
                    // Don't apply selection during drag - wait until mouseup to reduce lag
                }
            }
        };
        
        // Mouse move handler - attach to canvas, not window, to avoid firing when mouse moves over mol viewer
        newCanvas.addEventListener('mousemove', (e) => {
            if (!sequenceCanvasData || sequenceCanvasData.canvas !== newCanvas) return;
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const chainLabelPos = getChainLabelAtCanvasPosition(pos.x, pos.y, layout);
            const positionPos = getPositionAtCanvasPosition(pos.x, pos.y, layout);
            
            if (!dragState.isDragging) {
                return;
            }
            
            // Handle drag selection - use unified handler for position/ligand drags
            // Chain buttons now toggle on click in both modes, so only handle position/ligand drags
            if (positionPos && positionPos.positionData) {
                // Use unified handler for position/ligand drags
                handleDragMove(e, newCanvas);
            }
        });
        
        const handleMouseUp = () => {
            const previewSelectionSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
            
            if (dragState.hasMoved && previewSelectionSet) {
                // User dragged - apply the drag selection
                const objectName = renderer.currentObjectName;
                const obj = renderer.objectsData[objectName];
                const frame = obj?.frames?.[0];
                const newChains = new Set();
                if (frame?.chains) {
                    for (const positionIndex of previewSelectionSet) {
                        const positionChain = frame.chains[positionIndex];
                        if (positionChain) {
                            newChains.add(positionChain);
                        }
                    }
                }
                
                // Determine if we have partial selections
                const totalPositions = frame?.chains?.length || 0;
                const hasPartialSelections = previewSelectionSet.size > 0 && previewSelectionSet.size < totalPositions;
                // Allow all chains to be deselected - use explicit mode when chains are empty or when we have partial selections
                const allChains = new Set(frame.chains);
                const allChainsSelected = newChains.size === allChains.size && 
                                        Array.from(newChains).every(c => allChains.has(c));
                // Use explicit mode if we have partial selections, or if not all chains are selected, or if no positions are selected
                const selectionMode = (allChainsSelected && !hasPartialSelections && previewSelectionSet.size > 0) ? 'default' : 'explicit';
                // If all chains are selected AND no partial selections AND we have positions, use empty chains set with default mode
                // Otherwise, keep explicit chain selection (allows empty chains)
                const chainsToSet = (allChainsSelected && !hasPartialSelections && previewSelectionSet.size > 0) ? new Set() : newChains;
                
                // Clear PAE boxes when finishing drag selection
                renderer.setSelection({ 
                    positions: previewSelectionSet,
                    chains: chainsToSet,
                    selectionMode: selectionMode,
                    paeBoxes: [] 
                });
            } else if (dragState.isDragging && !dragState.hasMoved && dragState.dragStartItem) {
                // User clicked (no drag) - toggle the item
                const item = dragState.dragStartItem;
                const current = renderer?.getSelection();
                const newPositions = new Set(current?.positions || []);
                
                // Only handle if item has positionIndices (ligand or position)
                if (!item.positionIndices || item.positionIndices.length === 0) {
                    dragState.isDragging = false;
                    return;
                }
                
                // Toggle all positions in the item
                item.positionIndices.forEach(positionIndex => {
                    if (newPositions.has(positionIndex)) {
                        newPositions.delete(positionIndex);
                    } else {
                        newPositions.add(positionIndex);
                    }
                });
                
                // Update chains to include all chains that have selected positions
                const objectName = renderer.currentObjectName;
                const obj = renderer.objectsData[objectName];
                const frame = obj?.frames?.[0];
                const newChains = new Set();
                if (frame?.chains) {
                    for (const positionIndex of newPositions) {
                        const positionChain = frame.chains[positionIndex];
                        if (positionChain) {
                            newChains.add(positionChain);
                        }
                    }
                }
                
                // Determine if we have partial selections
                const totalPositions = frame?.chains?.length || 0;
                const hasPartialSelections = newPositions.size > 0 && newPositions.size < totalPositions;
                const allChains = new Set(frame.chains);
                const allChainsSelected = newChains.size === allChains.size && 
                                        Array.from(newChains).every(c => allChains.has(c));
                const selectionMode = (allChainsSelected && !hasPartialSelections && newPositions.size > 0) ? 'default' : 'explicit';
                const chainsToSet = (allChainsSelected && !hasPartialSelections && newPositions.size > 0) ? new Set() : newChains;
                
                renderer.setSelection({ 
                    positions: newPositions,
                    chains: chainsToSet,
                    selectionMode: selectionMode,
                    paeBoxes: [] 
                });
            }
            if (callbacks.setPreviewSelectionSet) callbacks.setPreviewSelectionSet(null);
            dragState.isDragging = false;
            dragState.dragStartItem = null;
            dragState.dragEndItemIndex = -1;
            dragState.hasMoved = false;
            dragState.dragUnselectMode = false;
            dragState.initialSelectionState = new Set();
            // Force update to reflect changes
            lastSequenceUpdateHash = null;
            scheduleRender();
        };

        newCanvas.addEventListener('mouseup', handleMouseUp);
        newCanvas.addEventListener('mouseleave', () => {
            handleMouseUp();
        });
        
        // Touch event handlers for mobile devices - using unified selectable items
        newCanvas.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return; // Only single touch
            e.preventDefault(); // Prevent scrolling
            
            const touch = e.touches[0];
            const pos = getCanvasPositionFromMouse(touch, newCanvas);
            const selectedItem = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            
            if (!selectedItem) return;
            
            // Handle chain items in sequence mode (toggle on tap, no drag)
            if (selectedItem.type === 'chain' && sequenceViewMode) {
                const chainId = selectedItem.chainId;
                const current = renderer?.getSelection();
                const isSelected = current?.chains?.has(chainId) || 
                    (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
                if (callbacks.setChainPositionsSelected) {
                    callbacks.setChainPositionsSelected(chainId, !isSelected);
                }
                lastSequenceUpdateHash = null;
                scheduleRender();
                return;
            }
            
            // For all other items (chain in chain mode, position, ligand), enable drag
            const current = renderer?.getSelection();
            
            // Determine if item is initially selected
            let isInitiallySelected = false;
            if (selectedItem.type === 'chain') {
                isInitiallySelected = current?.chains?.has(selectedItem.chainId) || 
                    (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
            } else {
                // For position/ligand, check if all positions are selected
                // In default mode with empty positions, all positions are considered selected
                if (current?.selectionMode === 'default' && (!current?.positions || current.positions.size === 0)) {
                    isInitiallySelected = true;
                } else {
                    isInitiallySelected = selectedItem.positionIndices.length > 0 && 
                        selectedItem.positionIndices.every(positionIndex => current?.positions?.has(positionIndex));
                }
            }
            
            dragState.isDragging = true;
            dragState.hasMoved = false;
            dragState.dragStartItem = selectedItem;
            dragState.dragEndItemIndex = selectedItem.index;
            dragState.dragUnselectMode = isInitiallySelected;
            // Capture initial selection state
            // If in default mode with empty positions, all positions are selected
            let initialPositions = new Set(current?.positions || []);
            if (current?.selectionMode === 'default' && initialPositions.size === 0) {
                // In default mode with empty positions, all positions are selected
                // Populate with all positions from the frame
                const objectName = renderer?.currentObjectName;
                const obj = renderer?.objectsData?.[objectName];
                const frame = obj?.frames?.[0];
                if (frame?.chains) {
                    for (let i = 0; i < frame.chains.length; i++) {
                        initialPositions.add(i);
                    }
                }
            }
            dragState.initialSelectionState = initialPositions;
            
            // Add temporary window listeners for touch drag outside canvas
            const handleTouchMove = (e) => {
                if (e.touches.length !== 1) return;
                e.preventDefault();
                const touch = e.touches[0];
                handleDragMove(touch, newCanvas);
            };
            const handleTouchEnd = (e) => {
                e.preventDefault();
                handleMouseUp();
                window.removeEventListener('touchmove', handleTouchMove);
                window.removeEventListener('touchend', handleTouchEnd);
                window.removeEventListener('touchcancel', handleTouchCancel);
            };
            const handleTouchCancel = (e) => {
                e.preventDefault();
                handleMouseUp();
                window.removeEventListener('touchmove', handleTouchMove);
                window.removeEventListener('touchend', handleTouchEnd);
                window.removeEventListener('touchcancel', handleTouchCancel);
            };
            window.addEventListener('touchmove', handleTouchMove, { passive: false });
            window.addEventListener('touchend', handleTouchEnd, { passive: false });
            window.addEventListener('touchcancel', handleTouchCancel, { passive: false });
            
            // Handle tap (no drag) - toggle selection immediately
            if (selectedItem.type === 'ligand' || (selectedItem.type === 'position' && selectedItem.positionIndices.length === 1)) {
                const newPositions = new Set(current?.positions || []);
                selectedItem.positionIndices.forEach(positionIndex => {
                    if (newPositions.has(positionIndex)) {
                        newPositions.delete(positionIndex);
                    } else {
                        newPositions.add(positionIndex);
                    }
                });
                
                // Update chains to include all chains that have selected positions
                const objectName = renderer.currentObjectName;
                const obj = renderer.objectsData[objectName];
                const frame = obj?.frames?.[0];
                const newChains = new Set();
                if (frame?.chains) {
                    for (const positionIndex of newPositions) {
                        const positionChain = frame.chains[positionIndex];
                        if (positionChain) {
                            newChains.add(positionChain);
                        }
                    }
                }
                
                // Determine if we have partial selections
                const totalPositions = frame?.chains?.length || 0;
                const hasPartialSelections = newPositions.size > 0 && newPositions.size < totalPositions;
                const allChains = new Set(frame.chains);
                const allChainsSelected = newChains.size === allChains.size && 
                                        Array.from(newChains).every(c => allChains.has(c));
                const selectionMode = (allChainsSelected && !hasPartialSelections && newPositions.size > 0) ? 'default' : 'explicit';
                const chainsToSet = (allChainsSelected && !hasPartialSelections && newPositions.size > 0) ? new Set() : newChains;
                
                renderer.setSelection({ 
                    positions: newPositions,
                    chains: chainsToSet,
                    selectionMode: selectionMode,
                    paeBoxes: [] 
                });
                lastSequenceUpdateHash = null;
                scheduleRender();
            }
        });
        
        // Touch move handler removed - using window listeners for drag instead
        // Old handler code removed - unified system handles drag via window listeners
        
        // Touch end/cancel handlers - window listeners handle cleanup, but keep these as fallback
        newCanvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            handleMouseUp();
        });
        
        newCanvas.addEventListener('touchcancel', (e) => {
            e.preventDefault();
            handleMouseUp();
        });
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
        const previewSelectionSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
        
        // Use unified helper
        const visiblePositions = window.getVisiblePositions(renderer, previewSelectionSet);

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
    // PUBLIC API
    // ============================================================================
    
    window.SequenceViewer = {
        // Initialize callbacks
        setCallbacks: function(cb) {
            callbacks = Object.assign({}, callbacks, cb);
        },
        
        // Main functions
        buildSequenceView: buildSequenceView,
        updateSequenceViewColors: updateSequenceViewColors,
        updateSequenceViewSelectionState: updateSequenceViewSelectionState,
        
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
        }
    };

})();
