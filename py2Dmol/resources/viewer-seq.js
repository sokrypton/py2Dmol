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
    
    // Callbacks for integration with host application
    let callbacks = {
        getRenderer: null,           // () => renderer instance
        getObjectSelect: null,        // () => objectSelect element
        toggleChainResidues: null,    // (chain) => void
        setChainResiduesSelected: null, // (chain, selected) => void
        highlightAtom: null,          // (atomIndex) => void
        highlightAtoms: null,         // (atomIndices) => void
        clearHighlight: null,        // () => void
        applySelection: null,         // (previewAtoms) => void
        getPreviewSelectionSet: null, // () => Set | null
        setPreviewSelectionSet: null  // (Set | null) => void
    };

    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================
    
    // Check if sequence differs between frames
    function sequencesDiffer(frame1, frame2) {
        if (!frame1 || !frame2) return true;
        if (!frame1.residues || !frame2.residues) return true;
        if (frame1.residues.length !== frame2.residues.length) return true;
        
        // Check if residues, chains, or atom_types differ
        for (let i = 0; i < frame1.residues.length; i++) {
            if (frame1.residues[i] !== frame2.residues[i]) return true;
            if (frame1.chains && frame2.chains && frame1.chains[i] !== frame2.chains[i]) return true;
            if (frame1.atom_types && frame2.atom_types && frame1.atom_types[i] !== frame2.atom_types[i]) return true;
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

    // Find residue at canvas position
    function getResidueAtCanvasPosition(x, y, layout) {
        if (!layout || !layout.residuePositions) return null;
        
        for (const pos of layout.residuePositions) {
            if (x >= pos.x && x < pos.x + pos.width && y >= pos.y && y < pos.y + pos.height) {
                return pos.residueData;
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

    // Draw residue character on canvas
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

    // Main canvas rendering function
    function renderSequenceCanvas() {
        if (!sequenceCanvasData) return;
        
        const { canvas, ctx, allResidueData, chainBoundaries, layout, sortedAtomEntries } = sequenceCanvasData;
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Get selection state
        const current = renderer.getSelection();
        const previewSelectionSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
        
        // Determine visible atoms
        let visibleAtoms = new Set();
        if (previewSelectionSet && previewSelectionSet.size > 0) {
            visibleAtoms = new Set(previewSelectionSet);
        } else {
            if (renderer.selectionModel && renderer.selectionModel.atoms && renderer.selectionModel.atoms.size > 0) {
                visibleAtoms = new Set(renderer.selectionModel.atoms);
            } else if (renderer.visibilityMask === null) {
                const n = renderer.coords ? renderer.coords.length : 0;
                for (let i = 0; i < n; i++) {
                    visibleAtoms.add(i);
                }
            } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                visibleAtoms = new Set(renderer.visibilityMask);
            }
        }
        
        const dimFactor = 0.3; // Same as PAE plot
        
        // Draw chain labels
        if (layout.chainLabelPositions) {
            for (const chainPos of layout.chainLabelPositions) {
                const chainId = chainPos.chainId;
                const isSelected = current?.chains?.has(chainId) || 
                    (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
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
        
        // Draw residue characters
        if (layout.residuePositions && allResidueData) {
            for (const pos of layout.residuePositions) {
                const residueData = pos.residueData;
                if (!residueData) continue;
                
                const isSelected = visibleAtoms.has(residueData.atomIndex);
                const color = residueData.color || {r: 80, g: 80, b: 80};
                
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
        if (!currentFrame || !currentFrame.residues) return;

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

        const { residues, residue_index, chains, atom_types } = currentFrame;

        // Create one entry per atom (one atom = one position, no collapsing)
        const atomEntries = [];
        for (let i = 0; i < residues.length; i++) {
            atomEntries.push({
                chain: chains[i],
                resName: residues[i],
                resSeq: residue_index[i],
                atomIndex: i, // Direct atom index
                atomType: atom_types && atom_types[i] ? atom_types[i] : 'P' // Store atom type
            });
        }

        // Sort by chain, then by atom index (maintains order within chain) - UNIFIED ORDER
        const sortedAtomEntries = atomEntries.sort((a, b) => {
            if (a.chain < b.chain) return -1;
            if (a.chain > b.chain) return 1;
            return a.atomIndex - b.atomIndex;
        });
        
        // Track chain boundaries for unified sequence
        const chainBoundaries = [];
        let currentChain = null;
        let chainStart = 0;
        for (let i = 0; i < sortedAtomEntries.length; i++) {
            if (sortedAtomEntries[i].chain !== currentChain) {
                if (currentChain !== null) {
                    chainBoundaries.push({
                        chain: currentChain,
                        startIndex: chainStart,
                        endIndex: i - 1
                    });
                }
                currentChain = sortedAtomEntries[i].chain;
                chainStart = i;
            }
        }
        // Add last chain
        if (currentChain !== null) {
            chainBoundaries.push({
                chain: currentChain,
                startIndex: chainStart,
                endIndex: sortedAtomEntries.length - 1
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
        
        // Build chain-to-sequence-type mapping for unified sequence
        const chainSequenceTypes = {};
        for (const boundary of chainBoundaries) {
            const chainResidues = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
            const chainResidueNames = chainResidues.map(r => r.resName);
            chainSequenceTypes[boundary.chain] = detectSequenceType(chainResidueNames);
        }
        
        // Helper function to get residue letter based on chain's sequence type
        const getResidueLetter = (atom) => {
            const chainType = chainSequenceTypes[atom.chain] || 'protein';
            let upper = (atom.resName || '').toString().trim().toUpperCase();
            
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
        
        const hasGetAtomColor = renderer?.getAtomColor;
        
        // Store all residue data (not elements)
        const allResidueData = [];
        
        // Calculate layout positions
        const layout = {
            charWidth,
            charHeight,
            spacing,
            chainButtonWidth,
            charsPerLine,
            chainLabelPositions: [],
            residuePositions: []
        };
        
        let currentY = spacing;
        let maxWidth = 0;
        
        if (sequenceViewMode) {
            // SEQUENCE MODE: One row per chain
            for (const boundary of chainBoundaries) {
                const chainId = boundary.chain;
                const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                
                // Chain label position
                const chainLabelX = spacing;
                const chainLabelY = currentY;
                const actualButtonWidth = chainButtonWidth + Math.round(4 * 2 / 3);
                const chainLabelHeight = charHeight;
                
                layout.chainLabelPositions.push({
                    chainId,
                    atomIndex: chainAtoms[0].atomIndex,
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
                let lastAtomType = null;
                
                for (let i = 0; i < chainAtoms.length; i++) {
                    const atom = chainAtoms[i];
                    
                    // Check if we need to wrap
                    if (currentX + charWidth > containerWidth - spacing) {
                        currentX = lineStartX;
                        lineY += charHeight; // No extra spacing between wrapped lines in same chain
                        maxLineY = Math.max(maxLineY, lineY);
                    }
                    
                    // Add spacing/gaps (same logic as before)
                    if (i > 0) {
                        const prevAtom = chainAtoms[i - 1];
                        const atomTypeChanged = prevAtom.atomType !== atom.atomType;
                        const ligandResSeqChanged = atom.atomType === 'L' && prevAtom.atomType === 'L' && prevAtom.resSeq !== atom.resSeq;
                        const sameAtomType = prevAtom.atomType === atom.atomType;
                        const resSeqDiff = atom.resSeq - prevAtom.resSeq;
                        const resSeqChanged = atom.resSeq !== prevAtom.resSeq;
                        const isChainBreak = sameAtomType && 
                                             resSeqChanged &&
                                             (prevAtom.atomType === 'P' || prevAtom.atomType === 'D' || prevAtom.atomType === 'R') &&
                                             resSeqDiff > 1;
                        
                        if (atomTypeChanged || ligandResSeqChanged) {
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
                                        atomIndex: -1, // Gap marker
                                        letter: '-',
                                        color: {r: 240, g: 240, b: 240},
                                        resSeq: prevAtom.resSeq + g + 1,
                                        chain: atom.chain
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
                    
                    // Check wrap before adding residue
                    if (currentX + charWidth > containerWidth - spacing) {
                        currentX = lineStartX;
                        lineY += charHeight; // No extra spacing between wrapped lines in same chain
                        maxLineY = Math.max(maxLineY, lineY);
                    }
                    
                    // Get letter and color
                    const letter = getResidueLetter(atom);
                    let color = { r: 80, g: 80, b: 80 };
                    if (hasGetAtomColor && !Number.isNaN(atom.atomIndex)) {
                        color = renderer.getAtomColor(atom.atomIndex);
                    }
                    
                    // Store residue data
                    const residueData = {
                        atomIndex: atom.atomIndex,
                        letter,
                        color,
                        resSeq: atom.resSeq,
                        chain: atom.chain,
                        resName: atom.resName // Store residue name for tooltip
                    };
                    allResidueData.push(residueData);
                    
                    // Store position
                    layout.residuePositions.push({
                        residueData,
                        x: currentX,
                        y: lineY,
                        width: charWidth,
                        height: charHeight
                    });
                    
                    currentX += charWidth;
                    lastResSeq = atom.resSeq;
                    lastAtomType = atom.atomType;
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
                    atomIndex: sortedAtomEntries[boundary.startIndex].atomIndex,
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
        
        // Get actual container width to fill it completely
        const actualContainerRect = sequenceViewEl ? sequenceViewEl.getBoundingClientRect() : null;
        const displayWidth = actualContainerRect && actualContainerRect.width > 0 ? actualContainerRect.width : containerWidth;
        const displayHeight = currentY;
        
        // Set canvas internal dimensions to achieve 200 DPI (pixels per inch)
        // Standard web DPI is 96, so 200 DPI = 200/96 ≈ 2.083x multiplier
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        
        canvas.width = displayWidth * dpiMultiplier;
        canvas.height = displayHeight * dpiMultiplier;
        
        // Set display size (CSS pixels)
        canvas.style.width = '100%';
        canvas.style.height = displayHeight + 'px';
        
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
            sortedAtomEntries,
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
        const dragState = { isDragging: false, dragStart: null, dragEnd: null, hasMoved: false, dragUnselectMode: false, initialSelectionState: new Set() };
        
        const { canvas, allResidueData, chainBoundaries, sortedAtomEntries, layout } = sequenceCanvasData;
        
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
        
        // Mouse down handler
        newCanvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left click
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const chainLabelPos = getChainLabelAtCanvasPosition(pos.x, pos.y, layout);
            const residuePos = getResidueAtCanvasPosition(pos.x, pos.y, layout);
            
            if (chainLabelPos) {
                if (sequenceViewMode) {
                    // In sequence mode, chain labels toggle chain selection
                    const chainId = chainLabelPos.chainId;
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
                } else {
                    // In chain mode, enable drag selection on chain labels
                    const chainId = chainLabelPos.chainId;
                    const boundary = chainBoundaries.find(b => b.chain === chainId);
                    if (!boundary) return;
                    
                    const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                    if (chainAtoms.length === 0) return;
                    
                    dragState.isDragging = true;
                    dragState.hasMoved = false;
                    dragState.dragStart = chainAtoms[0];
                    dragState.dragEnd = chainAtoms[chainAtoms.length - 1];
                    
                    const current = renderer?.getSelection();
                    const isInitiallySelected = current?.chains?.has(chainId) || 
                        (current?.selectionMode === 'default' && (!current?.chains || current.chains.size === 0));
                    dragState.dragUnselectMode = isInitiallySelected;
                    // Store initial selection state for toggling during drag
                    dragState.initialSelectionState = new Set(current?.atoms || []);
                    return;
                }
            }
            
            if (residuePos && residuePos.atomIndex >= 0) {
                const atomIndex = residuePos.atomIndex;
                const residueData = allResidueData.find(r => r.atomIndex === atomIndex);
                if (!residueData) return;
                
                dragState.isDragging = true;
                dragState.hasMoved = false;
                dragState.dragStart = residueData;
                dragState.dragEnd = residueData;
                
                const current = renderer?.getSelection();
                const isInitiallySelected = current?.atoms?.has(atomIndex) || false;
                dragState.dragUnselectMode = isInitiallySelected;
                // Store initial selection state for toggling during drag
                dragState.initialSelectionState = new Set(current?.atoms || []);
                
                // Toggle single atom on click
                const newAtoms = new Set(current?.atoms || []);
                if (newAtoms.has(atomIndex)) {
                    newAtoms.delete(atomIndex);
                } else {
                    newAtoms.add(atomIndex);
                }
                
                // Update chains to include all chains that have selected atoms
                const objectName = renderer.currentObjectName;
                const obj = renderer.objectsData[objectName];
                const frame = obj?.frames?.[0];
                const newChains = new Set();
                if (frame?.chains) {
                    for (const atomIdx of newAtoms) {
                        const atomChain = frame.chains[atomIdx];
                        if (atomChain) {
                            newChains.add(atomChain);
                        }
                    }
                }
                
                // Determine if we have partial selections
                const totalAtoms = frame?.chains?.length || 0;
                const hasPartialSelections = newAtoms.size > 0 && newAtoms.size < totalAtoms;
                
                // Clear PAE boxes when editing sequence selection
                renderer.setSelection({ 
                    atoms: newAtoms,
                    chains: newChains,
                    selectionMode: hasPartialSelections ? 'explicit' : 'default',
                    paeBoxes: [] 
                });
                // Force update to reflect changes
                lastSequenceUpdateHash = null;
                scheduleRender();
            }
        });
        
        // Mouse move handler - attach to canvas, not window, to avoid firing when mouse moves over mol viewer
        newCanvas.addEventListener('mousemove', (e) => {
            if (!sequenceCanvasData || sequenceCanvasData.canvas !== newCanvas) return;
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const chainLabelPos = getChainLabelAtCanvasPosition(pos.x, pos.y, layout);
            const residuePos = getResidueAtCanvasPosition(pos.x, pos.y, layout);
            
            if (!dragState.isDragging) {
                if (residuePos && residuePos.atomIndex >= 0 && callbacks.highlightAtom) {
                    callbacks.highlightAtom(residuePos.atomIndex);
                    // Store hovered residue info for tooltip
                    const residueData = sequenceCanvasData.allResidueData.find(r => r.atomIndex === residuePos.atomIndex);
                    if (residueData) {
                        hoveredResidueInfo = {
                            chain: residueData.chain,
                            resName: residueData.resName,
                            resSeq: residueData.resSeq
                        };
                    } else {
                        hoveredResidueInfo = null;
                    }
                } else if (chainLabelPos && !sequenceViewMode && callbacks.highlightAtoms) {
                    // In chain mode, highlight entire chain on hover
                    const chainId = chainLabelPos.chainId;
                    const boundary = chainBoundaries.find(b => b.chain === chainId);
                    if (boundary) {
                        const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                        if (chainAtoms.length > 0) {
                            const atomIndices = new Set(chainAtoms.map(a => a.atomIndex));
                            callbacks.highlightAtoms(atomIndices);
                        }
                    }
                    hoveredResidueInfo = null; // Clear tooltip in chain mode
                } else {
                    if (callbacks.clearHighlight) callbacks.clearHighlight();
                    hoveredResidueInfo = null; // Clear tooltip when not hovering over residue
                }
                // Trigger highlight redraw to show tooltip
                if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
                    window.SequenceViewer.drawHighlights();
                }
                return;
            }
            
            // Handle drag selection
            if (residuePos && residuePos.atomIndex >= 0) {
                const atomIndex = residuePos.atomIndex;
                const residueData = sequenceCanvasData.allResidueData.find(r => r.atomIndex === atomIndex);
                if (residueData && residueData !== dragState.dragEnd) {
                    dragState.dragEnd = residueData;
                    const startIdx = sequenceCanvasData.allResidueData.findIndex(r => r.atomIndex === dragState.dragStart.atomIndex);
                    const endIdx = sequenceCanvasData.allResidueData.findIndex(r => r.atomIndex === dragState.dragEnd.atomIndex);
                    if (startIdx !== -1 && endIdx !== -1) {
                        dragState.hasMoved = true;
                        const [min, max] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
                        // Start from initial selection state, not current selection
                        const newAtoms = new Set(dragState.initialSelectionState);
                        for (let i = min; i <= max; i++) {
                            const res = allResidueData[i];
                            // Toggle items in the drag range to match the initial drag mode
                            // If we started in unselect mode, we remove items; if select mode, we add items
                            if (dragState.dragUnselectMode) {
                                newAtoms.delete(res.atomIndex);
                            } else {
                                newAtoms.add(res.atomIndex);
                            }
                        }
                        if (callbacks.setPreviewSelectionSet) callbacks.setPreviewSelectionSet(newAtoms);
                        lastSequenceUpdateHash = null;
                        scheduleRender();
                        // Update 3D viewer in real-time during drag
                        if (callbacks.applySelection) callbacks.applySelection(newAtoms);
                    }
                }
            } else if (chainLabelPos && !sequenceViewMode) {
                // In chain mode, handle drag over chain labels
                const chainId = chainLabelPos.chainId;
                const boundary = chainBoundaries.find(b => b.chain === chainId);
                if (!boundary) return;
                
                const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                if (chainAtoms.length === 0) return;
                
                // Find the end chain atom
                const endAtom = chainAtoms[chainAtoms.length - 1];
                if (endAtom && endAtom !== dragState.dragEnd) {
                    dragState.dragEnd = endAtom;
                    dragState.hasMoved = true;
                    
                    // Get all atoms from start to end (including all chains in between)
                    const startChainId = dragState.dragStart.chain;
                    const startBoundary = chainBoundaries.find(b => b.chain === startChainId);
                    const endBoundary = boundary;
                    
                    if (startBoundary && endBoundary) {
                        const startBoundaryIdx = chainBoundaries.findIndex(b => b.chain === startChainId);
                        const endBoundaryIdx = chainBoundaries.findIndex(b => b.chain === chainId);
                        const [minBoundary, maxBoundary] = [Math.min(startBoundaryIdx, endBoundaryIdx), Math.max(startBoundaryIdx, endBoundaryIdx)];
                        
                        // Start from initial selection state, not current selection
                        const newAtoms = new Set(dragState.initialSelectionState);
                        
                        // Add all atoms from all chains in the drag range
                        for (let bIdx = minBoundary; bIdx <= maxBoundary; bIdx++) {
                            const b = chainBoundaries[bIdx];
                            const atomsInChain = sortedAtomEntries.slice(b.startIndex, b.endIndex + 1);
                            for (const atom of atomsInChain) {
                                // Toggle items in the drag range to match the initial drag mode
                                if (dragState.dragUnselectMode) {
                                    newAtoms.delete(atom.atomIndex);
                                } else {
                                    newAtoms.add(atom.atomIndex);
                                }
                            }
                        }
                        
                        if (callbacks.setPreviewSelectionSet) callbacks.setPreviewSelectionSet(newAtoms);
                        lastSequenceUpdateHash = null;
                        scheduleRender();
                        
                        // Update 3D viewer in real-time during drag
                        const objectName = renderer.currentObjectName;
                        const obj = renderer.objectsData[objectName];
                        const frame = obj?.frames?.[0];
                        const newChains = new Set();
                        if (frame?.chains) {
                            for (const atomIdx of newAtoms) {
                                const atomChain = frame.chains[atomIdx];
                                if (atomChain) {
                                    newChains.add(atomChain);
                                }
                            }
                        }
                        
                        // Update selection in real-time during drag
                        renderer.setSelection({
                            atoms: newAtoms,
                            chains: newChains,
                            selectionMode: currentSelection?.selectionMode || 'explicit',
                            paeBoxes: currentSelection?.paeBoxes || []
                        });
                    }
                }
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
                    for (const atomIdx of previewSelectionSet) {
                        const atomChain = frame.chains[atomIdx];
                        if (atomChain) {
                            newChains.add(atomChain);
                        }
                    }
                }
                
                // Determine if we have partial selections
                const totalAtoms = frame?.chains?.length || 0;
                const hasPartialSelections = previewSelectionSet.size > 0 && previewSelectionSet.size < totalAtoms;
                
                // Clear PAE boxes when finishing drag selection
                renderer.setSelection({ 
                    atoms: previewSelectionSet,
                    chains: newChains,
                    selectionMode: hasPartialSelections ? 'explicit' : 'default',
                    paeBoxes: [] 
                });
            } else if (dragState.isDragging && !sequenceViewMode && dragState.dragStart && dragState.dragStart.chain) {
                // User clicked (no drag) on a chain label in chain mode - toggle that chain
                const chainId = dragState.dragStart.chain;
                const boundary = chainBoundaries.find(b => b.chain === chainId);
                if (boundary) {
                    const chainAtoms = sortedAtomEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                    const current = renderer?.getSelection();
                    const newAtoms = new Set(current?.atoms || []);
                    const allChainAtomsSelected = chainAtoms.every(a => newAtoms.has(a.atomIndex));
                    
                    if (allChainAtomsSelected) {
                        // Deselect all atoms in chain
                        chainAtoms.forEach(a => newAtoms.delete(a.atomIndex));
                    } else {
                        // Select all atoms in chain
                        chainAtoms.forEach(a => newAtoms.add(a.atomIndex));
                    }
                    
                    // Update chains to include all chains that have selected atoms
                    const objectName = renderer.currentObjectName;
                    const obj = renderer.objectsData[objectName];
                    const frame = obj?.frames?.[0];
                    const newChains = new Set();
                    if (frame?.chains) {
                        for (const atomIdx of newAtoms) {
                            const atomChain = frame.chains[atomIdx];
                            if (atomChain) {
                                newChains.add(atomChain);
                            }
                        }
                    }
                    
                    // Determine if we have partial selections
                    const totalAtoms = frame?.chains?.length || 0;
                    const hasPartialSelections = newAtoms.size > 0 && newAtoms.size < totalAtoms;
                    
                    renderer.setSelection({ 
                        atoms: newAtoms,
                        chains: newChains,
                        selectionMode: hasPartialSelections ? 'explicit' : 'default',
                        paeBoxes: [] 
                    });
                }
            }
            if (callbacks.setPreviewSelectionSet) callbacks.setPreviewSelectionSet(null);
            dragState.isDragging = false;
            dragState.dragStart = null;
            dragState.dragEnd = null;
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
            if (callbacks.clearHighlight) callbacks.clearHighlight();
            hoveredResidueInfo = null; // Clear tooltip when mouse leaves sequence canvas
            // Trigger highlight redraw to clear tooltip
            if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
                window.SequenceViewer.drawHighlights();
            }
        });
        
        // Touch event handlers for mobile devices
        newCanvas.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return; // Only single touch
            e.preventDefault(); // Prevent scrolling
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const residuePos = getResidueAtCanvasPosition(pos.x, pos.y, layout);
            
            if (residuePos && residuePos.atomIndex >= 0) {
                const atomIndex = residuePos.atomIndex;
                const residueData = allResidueData.find(r => r.atomIndex === atomIndex);
                if (!residueData) return;
                
                dragState.isDragging = true;
                dragState.hasMoved = false;
                dragState.dragStart = residueData;
                dragState.dragEnd = residueData;
                
                const current = renderer?.getSelection();
                const isInitiallySelected = current?.atoms?.has(atomIndex) || false;
                dragState.dragUnselectMode = isInitiallySelected;
                // Store initial selection state for toggling during drag
                dragState.initialSelectionState = new Set(current?.atoms || []);
                
                // Toggle single atom on tap
                const newAtoms = new Set(current?.atoms || []);
                if (newAtoms.has(atomIndex)) {
                    newAtoms.delete(atomIndex);
                } else {
                    newAtoms.add(atomIndex);
                }
                
                // Update chains to include all chains that have selected atoms
                const objectName = renderer.currentObjectName;
                const obj = renderer.objectsData[objectName];
                const frame = obj?.frames?.[0];
                const newChains = new Set();
                if (frame?.chains) {
                    for (const atomIdx of newAtoms) {
                        const atomChain = frame.chains[atomIdx];
                        if (atomChain) {
                            newChains.add(atomChain);
                        }
                    }
                }
                
                // Determine if we have partial selections
                const totalAtoms = frame?.chains?.length || 0;
                const hasPartialSelections = newAtoms.size > 0 && newAtoms.size < totalAtoms;
                
                // Clear PAE boxes when editing sequence selection
                renderer.setSelection({ 
                    atoms: newAtoms,
                    chains: newChains,
                    selectionMode: hasPartialSelections ? 'explicit' : 'default',
                    paeBoxes: [] 
                });
                // Force update to reflect changes
                lastSequenceUpdateHash = null;
                scheduleRender();
            }
        });
        
        // Touch move handler - attach to canvas, not window, to avoid firing when touching elsewhere
        newCanvas.addEventListener('touchmove', (e) => {
            if (!sequenceCanvasData || sequenceCanvasData.canvas !== newCanvas) return;
            if (!dragState.isDragging) return;
            if (e.touches.length !== 1) return;
            e.preventDefault(); // Prevent scrolling
            
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            const residuePos = getResidueAtCanvasPosition(pos.x, pos.y, layout);
            
            if (residuePos && residuePos.atomIndex >= 0) {
                const atomIndex = residuePos.atomIndex;
                const residueData = allResidueData.find(r => r.atomIndex === atomIndex);
                if (residueData && residueData !== dragState.dragEnd) {
                    dragState.dragEnd = residueData;
                    const startIdx = allResidueData.findIndex(r => r.atomIndex === dragState.dragStart.atomIndex);
                    const endIdx = allResidueData.findIndex(r => r.atomIndex === dragState.dragEnd.atomIndex);
                    if (startIdx !== -1 && endIdx !== -1) {
                        dragState.hasMoved = true;
                        const [min, max] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
                        // Start from initial selection state, not current selection
                        const newAtoms = new Set(dragState.initialSelectionState);
                        for (let i = min; i <= max; i++) {
                            const res = allResidueData[i];
                            // Toggle items in the drag range to match the initial drag mode
                            if (dragState.dragUnselectMode) {
                                newAtoms.delete(res.atomIndex);
                            } else {
                                newAtoms.add(res.atomIndex);
                            }
                        }
                        if (callbacks.setPreviewSelectionSet) callbacks.setPreviewSelectionSet(newAtoms);
                        lastSequenceUpdateHash = null;
                        scheduleRender();
                    }
                }
            }
        });
        
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
    function updateSequenceViewColors() {
        if (!sequenceCanvasData) return;
        
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;
        
        const hasGetAtomColor = renderer?.getAtomColor;
        
        // Update colors for all residues
        if (sequenceCanvasData.allResidueData) {
            for (const residueData of sequenceCanvasData.allResidueData) {
                if (hasGetAtomColor && !Number.isNaN(residueData.atomIndex)) {
                    residueData.color = renderer.getAtomColor(residueData.atomIndex);
                }
            }
        }
        
        // Invalidate hash to force redraw with new colors
        lastSequenceUpdateHash = null;
        scheduleRender();
    }

    function updateSequenceViewSelectionState() {
        if (!sequenceCanvasData) return;

        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;

        // Determine what's actually visible from the unified model or visibilityMask
        // Use previewSelectionSet during drag for live feedback
        let visibleAtoms = new Set();
        
        const previewSelectionSet = callbacks.getPreviewSelectionSet ? callbacks.getPreviewSelectionSet() : null;
        
        if (previewSelectionSet && previewSelectionSet.size > 0) {
            // During drag, use preview selection for live feedback (already atom indices)
            visibleAtoms = new Set(previewSelectionSet);
        } else {
            // Use atoms directly from selection model
            if (renderer.selectionModel && renderer.selectionModel.atoms && renderer.selectionModel.atoms.size > 0) {
                visibleAtoms = new Set(renderer.selectionModel.atoms);
            } else if (renderer.visibilityMask === null) {
                // null mask means all atoms are visible (default mode)
                const n = renderer.coords ? renderer.coords.length : 0;
                for (let i = 0; i < n; i++) {
                    visibleAtoms.add(i);
                }
            } else if (renderer.visibilityMask && renderer.visibilityMask.size > 0) {
                // Non-empty Set means some atoms are visible
                visibleAtoms = new Set(renderer.visibilityMask);
            }
        }

        // Create hash to detect if selection actually changed
        // Include previewSelectionSet in hash to ensure live feedback during drag
        const previewHash = previewSelectionSet ? previewSelectionSet.size : 0;
        const currentHash = visibleAtoms.size + previewHash + (renderer?.visibilityMask === null ? 'all' : 'some');
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
        
        // Initialize overlay if it doesn't exist yet
        if (!highlightOverlayCanvas || !highlightOverlayCtx) {
            initializeHighlightOverlay();
            // If still not created, return early
            if (!highlightOverlayCanvas || !highlightOverlayCtx) {
                return;
            }
        }
        
        if (!renderer.atomScreenPositions) {
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
        
        // Highlight multiple atoms if specified (preferred method)
        if (renderer.highlightedAtoms !== null && renderer.highlightedAtoms instanceof Set && renderer.highlightedAtoms.size > 0) {
            for (const atomIdx of renderer.highlightedAtoms) {
                if (atomIdx >= 0 && atomIdx < renderer.atomScreenPositions.length) {
                    const pos = renderer.atomScreenPositions[atomIdx];
                    if (pos) {
                        highlightOverlayCtx.beginPath();
                        highlightOverlayCtx.arc(pos.x, pos.y, pos.radius, 0, Math.PI * 2);
                        highlightOverlayCtx.fill();
                        highlightOverlayCtx.stroke();
                    }
                }
            }
        } else if (renderer.highlightedAtom !== null && renderer.highlightedAtom !== undefined && typeof renderer.highlightedAtom === 'number') {
            const atomIdx = renderer.highlightedAtom;
            if (atomIdx >= 0 && atomIdx < renderer.atomScreenPositions.length) {
                const pos = renderer.atomScreenPositions[atomIdx];
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
        }
    };

})();
