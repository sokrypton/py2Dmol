// ============================================================================
// PAE (Predicted Aligned Error) RENDERER MODULE
// ============================================================================
// This module provides PAE visualization functionality for py2Dmol.
// It can be loaded conditionally when PAE data is available.

(function() {
    'use strict';

    // ============================================================================
    // COLOR UTILITIES (PAE-specific)
    // ============================================================================
    // HSV to RGB conversion (needed for PAE colors)
    function hsvToRgb(h, s, v) {
        const c = v * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = v - c;
        let r, g, b;
        if (h < 60) {
            r = c; g = x; b = 0;
        } else if (h < 120) {
            r = x; g = c; b = 0;
        } else if (h < 180) {
            r = 0; g = c; b = x;
        } else if (h < 240) {
            r = 0; g = x; b = c;
        } else if (h < 300) {
            r = x; g = 0; b = c;
        } else {
            r = c; g = 0; b = x;
        }
        return {
            r: Math.round((r + m) * 255),
            g: Math.round((g + m) * 255),
            b: Math.round((b + m) * 255)
        };
    }

    // PAE color functions
    function getPAEColor(value) {
        // 0 (blue) to 15 (white) to 30 (red)
        const v = Math.max(0, Math.min(30, (value || 0)));
        
        if (v <= 15.0) {
            // 0 (blue) -> 15 (white)
            // Hue is 240 (blue)
            // Saturation goes from 1.0 down to 0.0
            const norm_blue = v / 15.0; // 0 to 1
            const saturation = 1.0 - norm_blue;
            return hsvToRgb(240, saturation, 1.0);
        } else {
            // 15 (white) -> 30 (red)
            // Hue is 0 (red)
            // Saturation goes from 0.0 up to 1.0
            const norm_red = (v - 15.0) / 15.0; // 0 to 1
            const saturation = norm_red;
            return hsvToRgb(0, saturation, 1.0);
        }
    }
    
    function getPAEColor_Colorblind(value) {
        // 0 (blue) to 15 (white) to 30 (orange)
        const v = Math.max(0, Math.min(30, (value || 0)));
        
        if (v <= 15.0) {
            // 0 (blue) -> 15 (white)
            // Hue is 240 (blue)
            // Saturation goes from 1.0 down to 0.0
            const norm_blue = v / 15.0; // 0 to 1
            const saturation = 1.0 - norm_blue;
            return hsvToRgb(240, saturation, 1.0);
        } else {
            // 15 (white) -> 30 (orange)
            // Hue is 30 (orange)
            // Saturation goes from 0.0 up to 1.0
            const norm_red = (v - 15.0) / 15.0; // 0 to 1
            const saturation = norm_red;
            return hsvToRgb(30, saturation, 1.0); // Use 30 for Orange
        }
    }

    // ============================================================================
    // PAE RENDERER CLASS
    // ============================================================================
    class PAERenderer {
        constructor(canvas, mainRenderer) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.mainRenderer = mainRenderer; // Reference to Pseudo3DRenderer
            
            this.paeData = null;
            // Use canvas internal width for size (canvas may be stretched by CSS)
            // This ensures rendering coordinates match mouse coordinates
            this.size = canvas.width;
            
            this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
            this.isDragging = false;
            this.isAdding = false; // Track if Shift is held for additive selection
            
            // Performance optimization: cache base image and selection state
            this.baseImageData = null; // Cached base PAE image (no selection overlay)
            this.lastSelectionHash = null; // Hash of last selection state to detect changes
            this.renderScheduled = false; // Flag to prevent multiple queued renders
            this.cachedSequencePositions = null; // Cache sequence selected positions
            
            this.setupInteraction();
            
            // Listen for selection changes to re-render PAE with sequence selections
            if (typeof document !== 'undefined') {
                this.selectionChangeHandler = () => {
                    if (this.paeData) {
                        // Invalidate cache when selection changes
                        this.lastSelectionHash = null;
                        this.cachedSequencePositions = null;
                        this.scheduleRender();
                    }
                };
                document.addEventListener('py2dmol-selection-change', this.selectionChangeHandler);
            }
        }
        
        // Schedule render using requestAnimationFrame to throttle
        scheduleRender() {
            if (this.renderScheduled) return;
            this.renderScheduled = true;
            requestAnimationFrame(() => {
                this.renderScheduled = false;
                this.render();
            });
        }

        // Expand ligand positions: if any ligand position is selected, select all positions in that ligand
        // Uses shared utility function for consistent grouping with sequence viewer
        expandLigandPositions(positionIndices) {
            // Use shared utility function if available, otherwise return original selection
            if (typeof expandLigandSelection === 'function' && this.mainRenderer.ligandGroups) {
                return expandLigandSelection(positionIndices, this.mainRenderer.ligandGroups);
            }
            
            // Fallback: return original selection if utility function not available
            return new Set(positionIndices);
        }

        getMousePos(e) {
            const rect = this.canvas.getBoundingClientRect();
            // Support both mouse and touch events
            const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
            const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);
            
            // Get mouse position relative to canvas (in display pixels)
            const displayX = clientX - rect.left;
            const displayY = clientY - rect.top;
            
            // Scale to canvas logical coordinates (canvas may be stretched by CSS)
            // Canvas internal size vs displayed size
            const scaleX = this.canvas.width / rect.width;
            const scaleY = this.canvas.height / rect.height;
            
            return { 
                x: displayX * scaleX, 
                y: displayY * scaleY 
            };
        }
        
        getCellIndices(e) {
            const { x, y } = this.getMousePos(e);
            if (!this.paeData) return { i: -1, j: -1 };
            
            const n = this.paeData.length;
            if (n === 0) return { i: -1, j: -1 };
            
            const cellSize = this.size / n;
            
            const i = Math.floor(y / cellSize);
            const j = Math.floor(x / cellSize);
            
            return { i, j };
        }

        setupInteraction() {
            this.canvas.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return; // Only left click
                if (!this.paeData) return; // No data to select
                
                // Check if Shift is held for additive selection
                this.isAdding = e.shiftKey;
                
                if (!this.isAdding) {
                    // Clear sequence selection when starting a new PAE selection (non-additive)
                    // This ensures only the PAE box selection is active
                    // Skip 3D render during drag - only update sequence/PAE viewers
                    this.mainRenderer.setSelection({ 
                        paeBoxes: [],
                        positions: new Set(),
                        chains: new Set(),
                        selectionMode: 'explicit'
                    }, true); // skip3DRender = true
                }
                // If Shift is held, preserve existing selections and add to them
                
                this.isDragging = true;
                const { i, j } = this.getCellIndices(e);
                this.selection.x1 = j;
                this.selection.y1 = i;
                this.selection.x2 = j;
                this.selection.y2 = i;
                // Invalidate cache when starting new selection
                this.lastSelectionHash = null;
                this.scheduleRender(); // Throttled render
                
                // Add temporary window listeners for drag outside canvas
                const handleMove = (e) => {
                    if (!this.isDragging) return;
                    if (!this.paeData) return;
                    
                    // Get cell indices
                    let cellIndices;
                    try {
                        cellIndices = this.getCellIndices(e);
                    } catch (err) {
                        return; // Mouse outside canvas bounds
                    }
                    const { i, j } = cellIndices;

                    // Clamp selection to canvas bounds
                    const n = this.paeData.length;
                    const newX2 = Math.max(0, Math.min(n - 1, j));
                    const newY2 = Math.max(0, Math.min(n - 1, i));
                    
                    // Only update if selection actually changed
                    if (this.selection.x2 !== newX2 || this.selection.y2 !== newY2) {
                        this.selection.x2 = newX2;
                        this.selection.y2 = newY2;
                        this.scheduleRender();
                    }
                };
                
                const handleUp = (e) => {
                    if (!this.isDragging) return;
                    handleEnd(e);
                    window.removeEventListener('mousemove', handleMove);
                    window.removeEventListener('mouseup', handleUp);
                };
                
                window.addEventListener('mousemove', handleMove);
                window.addEventListener('mouseup', handleUp);
            });
            
            // Define handleEnd before it's used
            const handleEnd = (e) => {
                if (!this.isDragging) return;
                this.isDragging = false;
                
                let i_start = Math.min(this.selection.y1, this.selection.y2);
                let i_end = Math.max(this.selection.y1, this.selection.y2);
                let j_start = Math.min(this.selection.x1, this.selection.x2);
                let j_end = Math.max(this.selection.x1, this.selection.x2);

                // Clamp to valid range
                const n = this.paeData.length;
                if (n === 0 || i_start < 0 || j_start < 0) {
                    this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                    this.render();
                    return;
                }

                // Check for a single-click
                const isClick = (i_start === i_end && j_start === j_end);

                if (isClick) {
                    // Single click: Clear both PAE and sequence selection
                    // Render 3D viewer now that drag is complete
                    this.mainRenderer.setSelection({ 
                        paeBoxes: [],
                        positions: new Set(),
                        chains: new Set(),
                        selectionMode: 'default'
                    }, false); // skip3DRender = false - update 3D viewer
                    // Invalidate PAE cache
                    this.cachedSequencePositions = null;
                    this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                } else {
                    // Create new box
                    const newBox = {
                        i_start: i_start,
                        i_end: i_end,
                        j_start: j_start,
                        j_end: j_end
                    };
                    
                    // Get current selection state
                    const currentSelection = this.mainRenderer.getSelection();
                    const existingBoxes = currentSelection.paeBoxes || [];
                    const existingPositions = currentSelection.positions || new Set();
                    
                    // Convert PAE box to position indices
                    // PAE positions map directly to position indices (one position = one entry in frame data)
                    const newPositions = new Set();
                    
                    // Get position indices from PAE box (i and j ranges)
                    for (let r = i_start; r <= i_end; r++) {
                        if (r >= 0 && r < this.mainRenderer.chains.length) {
                            newPositions.add(r);
                        }
                    }
                    for (let r = j_start; r <= j_end; r++) {
                        if (r >= 0 && r < this.mainRenderer.chains.length) {
                            newPositions.add(r);
                        }
                    }
                    
                    // Expand ligand positions: if any ligand position is selected, select all positions in that ligand
                    const expandedNewPositions = this.expandLigandPositions(newPositions);
                    
                    // If Shift is held, add to existing selection; otherwise replace
                    if (this.isAdding) {
                        // Additive: combine with existing boxes and positions
                        // Also expand any ligand positions in existing selection
                        const expandedExistingPositions = this.expandLigandPositions(existingPositions);
                        const combinedBoxes = [...existingBoxes, newBox];
                        const combinedPositions = new Set([...expandedExistingPositions, ...expandedNewPositions]);
                        
                        // Update chains to include all chains that have selected positions
                        const newChains = new Set();
                        if (this.mainRenderer.chains && this.mainRenderer.chains.length > 0) {
                            for (const positionIdx of combinedPositions) {
                                if (positionIdx >= 0 && positionIdx < this.mainRenderer.chains.length) {
                                    const atomChain = this.mainRenderer.chains[positionIdx];
                                    if (atomChain) {
                                        newChains.add(atomChain);
                                    }
                                }
                            }
                        }
                        
                        // Determine if we have partial selections
                        const totalPositions = this.mainRenderer.chains ? this.mainRenderer.chains.length : 0;
                        const hasPartialSelections = combinedPositions.size > 0 && combinedPositions.size < totalPositions;
                        
                        // Render 3D viewer now that drag is complete
                        this.mainRenderer.setSelection({
                            paeBoxes: combinedBoxes,
                            positions: combinedPositions,
                            chains: newChains, // Include all chains with selected positions
                            selectionMode: hasPartialSelections ? 'explicit' : 'default'
                        }, false); // skip3DRender = false - update 3D viewer
                    } else {
                        // Replace: use only the new box and positions (with ligand expansion)
                        
                        // Update chains to include all chains that have selected positions
                        const newChains = new Set();
                        if (this.mainRenderer.chains && this.mainRenderer.chains.length > 0) {
                            for (const positionIdx of expandedNewPositions) {
                                if (positionIdx >= 0 && positionIdx < this.mainRenderer.chains.length) {
                                    const atomChain = this.mainRenderer.chains[positionIdx];
                                    if (atomChain) {
                                        newChains.add(atomChain);
                                    }
                                }
                            }
                        }
                        
                        // Determine if we have partial selections
                        const totalPositions = this.mainRenderer.chains ? this.mainRenderer.chains.length : 0;
                        const hasPartialSelections = expandedNewPositions.size > 0 && expandedNewPositions.size < totalPositions;
                        
                        // Render 3D viewer now that drag is complete
                        this.mainRenderer.setSelection({
                            paeBoxes: [newBox],
                            positions: expandedNewPositions,
                            chains: newChains, // Include all chains with selected positions
                            selectionMode: hasPartialSelections ? 'explicit' : 'default'
                        }, false); // skip3DRender = false - update 3D viewer
                    }
                    
                    // Invalidate PAE cache so colors update immediately
                    this.cachedSequencePositions = null;
                }
                
                this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                // Invalidate cache after selection change
                this.lastSelectionHash = null;
                this.cachedSequencePositions = null;
                this.scheduleRender(); // Throttled render
            };
            
            // Canvas-bound mouseup (fallback, but window listener handles it)
            this.canvas.addEventListener('mouseup', handleEnd);
            
            // Touch event handlers for mobile devices
            this.canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length !== 1) return; // Only single touch
                if (!this.paeData) return; // No data to select
                e.preventDefault(); // Prevent scrolling
                
                // Check if Shift is held for additive selection (not available on touch)
                this.isAdding = false;
                
                // Clear sequence selection when starting a new PAE selection
                // Skip 3D render during drag - only update sequence/PAE viewers
                this.mainRenderer.setSelection({ 
                    paeBoxes: [],
                    positions: new Set(),
                    chains: new Set(),
                    selectionMode: 'explicit'
                }, true); // skip3DRender = true
                
                this.isDragging = true;
                const { i, j } = this.getCellIndices(e);
                this.selection.x1 = j;
                this.selection.y1 = i;
                this.selection.x2 = j;
                this.selection.y2 = i;
                // Invalidate cache when starting new selection
                this.lastSelectionHash = null;
                this.scheduleRender(); // Throttled render
                
                // Add temporary window listeners for touch drag outside canvas
                const handleTouchMove = (e) => {
                    if (!this.isDragging) return;
                    if (!this.paeData) return;
                    if (e.touches.length !== 1) return;
                    e.preventDefault();
                    
                    // Get cell indices
                    let cellIndices;
                    try {
                        cellIndices = this.getCellIndices(e.touches[0]);
                    } catch (err) {
                        return; // Touch outside canvas bounds
                    }
                    const { i, j } = cellIndices;

                    // Clamp selection to canvas bounds
                    const n = this.paeData.length;
                    const newX2 = Math.max(0, Math.min(n - 1, j));
                    const newY2 = Math.max(0, Math.min(n - 1, i));
                    
                    // Only update if selection actually changed
                    if (this.selection.x2 !== newX2 || this.selection.y2 !== newY2) {
                        this.selection.x2 = newX2;
                        this.selection.y2 = newY2;
                        this.scheduleRender();
                    }
                };
                
                const handleTouchEnd = (e) => {
                    if (!this.isDragging) return;
                    e.preventDefault();
                    handleEnd(e);
                    window.removeEventListener('touchmove', handleTouchMove);
                    window.removeEventListener('touchend', handleTouchEnd);
                    window.removeEventListener('touchcancel', handleTouchCancel);
                };
                
                const handleTouchCancel = (e) => {
                    if (!this.isDragging) return;
                    e.preventDefault();
                    this.isDragging = false;
                    this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                    this.render();
                    window.removeEventListener('touchmove', handleTouchMove);
                    window.removeEventListener('touchend', handleTouchEnd);
                    window.removeEventListener('touchcancel', handleTouchCancel);
                };
                
                window.addEventListener('touchmove', handleTouchMove, { passive: false });
                window.addEventListener('touchend', handleTouchEnd, { passive: false });
                window.addEventListener('touchcancel', handleTouchCancel, { passive: false });
            });
        }

        setData(paeData) {
            // Only clear selection if data actually changed (not just same data on new frame)
            // For most structures, PAE data is the same across frames, so preserve selection
            const dataChanged = this.paeData !== paeData && 
                (this.paeData === null || paeData === null || 
                 (this.paeData.length !== paeData.length));
            
            // If data structure changed, clear selection
            if (dataChanged) {
                this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                // [PATCH] Check unified model
                if (this.mainRenderer.selectionModel.paeBoxes.length > 0) {
                     this.mainRenderer.setResidueVisibility(null);
                }
            }
            
            this.paeData = paeData;
            
            // Invalidate cache when data changes (or on any frame change for color updates)
            this.baseImageData = null;
            this.lastSelectionHash = null;
            this.cachedSequencePositions = null;
            this.render();
        }

        // Helper function to compute which PAE positions are selected from sequence space
        // Returns a Set of PAE matrix indices (0-based) that correspond to selected positions/chains
        // Only returns positions for explicit selections (not default "all" state)
        getSequenceSelectedPAEPositions() {
            const selectedPositions = new Set();
            const renderer = this.mainRenderer;
            
            if (!this.paeData || this.paeData.length === 0) {
                return selectedPositions;
            }
            
            const selectionModel = renderer.selectionModel;
            const hasPositionSelection = selectionModel.positions && selectionModel.positions.size > 0;
            const hasChainSelection = selectionModel.chains && selectionModel.chains.size > 0;
            const mode = selectionModel.selectionMode || 'default';
            
            // Only return positions for explicit selections
            // In default mode with no explicit selection, return empty (show all at full brightness)
            if (mode === 'default') {
                // In default mode, only highlight if there's an explicit position selection
                // (not just "all chains" which is the default)
                if (!hasPositionSelection) {
                    return selectedPositions; // No explicit selection = show all
                }
            }
            
            // If no sequence selection, return empty set
            if (!hasPositionSelection && !hasChainSelection) {
                return selectedPositions;
            }
            
            // Determine allowed chains
            let allowedChains;
            if (hasChainSelection) {
                allowedChains = selectionModel.chains;
            } else {
                // All chains allowed
                allowedChains = new Set(renderer.chains);
            }
            
            // Map sequence selections to PAE positions
            // PAE positions map directly to position indices (one position = one entry in frame data)
            const n = this.paeData.length;
            for (let r = 0; r < n; r++) {
                // PAE position r corresponds to position index r
                if (r >= renderer.chains.length) continue;
                
                const chain = renderer.chains[r];
                
                // Check if this PAE position is selected
                const chainMatches = allowedChains.has(chain);
                const positionMatches = !hasPositionSelection || selectionModel.positions.has(r);
                
                if (chainMatches && positionMatches) {
                    selectedPositions.add(r);
                }
            }
            
            return selectedPositions;
        }

        // Helper function to check if a cell (i, j) is in any selected box
        // Visual symmetry is handled in rendering, but selection boxes are not symmetric internally
        isCellSelected(i, j, boxes, previewBox = null, sequenceSelectedPositions = null) {
            // Check active boxes (non-symmetric - only check if (i,j) is in the box)
            for (const box of boxes) {
                const i_start = Math.min(box.i_start, box.i_end);
                const i_end = Math.max(box.i_start, box.i_end);
                const j_start = Math.min(box.j_start, box.j_end);
                const j_end = Math.max(box.j_start, box.j_end);
                
                // Check if (i, j) is directly in this box
                const inBox = (i >= i_start && i <= i_end && j >= j_start && j <= j_end);
                
                if (inBox) {
                    return true;
                }
            }
            
            // Check preview box if dragging (non-symmetric)
            if (previewBox) {
                const i_start = Math.min(previewBox.y1, previewBox.y2);
                const i_end = Math.max(previewBox.y1, previewBox.y2);
                const j_start = Math.min(previewBox.x1, previewBox.x2);
                const j_end = Math.max(previewBox.x1, previewBox.x2);
                
                const inBox = (i >= i_start && i <= i_end && j >= j_start && j <= j_end);
                
                if (inBox) {
                    return true;
                }
            }
            
            // Check if cell is in a sequence-selected region
            // Only highlight cells where BOTH i AND j are in selected positions
            // This shows only the specific interactions between selected positions
            if (sequenceSelectedPositions && sequenceSelectedPositions.size > 0) {
                // Both row i and column j must be selected
                if (sequenceSelectedPositions.has(i) && sequenceSelectedPositions.has(j)) {
                    return true;
                }
            }
            
            return false;
        }

        render() {
            this.ctx.clearRect(0, 0, this.size, this.size);
            
            if (!this.paeData || this.paeData.length === 0) {
                this.ctx.fillStyle = '#f9f9f9';
                this.ctx.fillRect(0, 0, this.size, this.size);
                this.ctx.fillStyle = '#999';
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                this.ctx.font = '14px sans-serif';
                this.ctx.fillText('No PAE Data', this.size / 2, this.size / 2);
                return;
            }

            const n = this.paeData.length;
            if (n === 0) return;
            
            const cellSize = this.size / n;
            
            // Get active boxes and preview box
            const activeBoxes = this.mainRenderer.selectionModel.paeBoxes || [];
            const previewBox = (this.isDragging && this.selection.x1 !== -1) ? this.selection : null;
            
            // Cache sequence-selected PAE positions (only recompute if selection changed)
            if (this.cachedSequencePositions === null) {
                this.cachedSequencePositions = this.getSequenceSelectedPAEPositions();
            }
            const sequenceSelectedPositions = this.cachedSequencePositions;
            
            // Check selection mode
            const mode = this.mainRenderer.selectionModel?.selectionMode || 'default';
            
            // Determine if we should dim non-selected cells
            // - If there's an active selection (boxes or sequence), dim non-selected
            // - If in explicit mode with no selection, dim everything (nothing selected)
            // - If in default mode with no selection, show everything at full brightness
            const hasActiveSelection = activeBoxes.length > 0 || previewBox !== null || sequenceSelectedPositions.size > 0;
            const hasSelection = hasActiveSelection || (mode === 'explicit' && !hasActiveSelection);
            
            // Dim factor for non-selected cells (0.0 = fully dim, 1.0 = no dimming)
            const dimFactor = 0.3; // Non-selected cells will be 30% of original brightness
            
            // Use createImageData for faster rendering
            const imageData = this.ctx.createImageData(this.size, this.size);
            const data = imageData.data;
            const paeFunc = this.mainRenderer.colorblindMode ? getPAEColor_Colorblind : getPAEColor;
            
            for (let i = 0; i < n; i++) { // y
                for (let j = 0; j < n; j++) { // x
                    const value = this.paeData[i][j];
                    let { r, g, b } = paeFunc(value);
                    
                    // Check if this cell is selected (or if nothing is selected, show all)
                    const isSelected = !hasSelection || this.isCellSelected(i, j, activeBoxes, previewBox, sequenceSelectedPositions);
                    
                    // Dim non-selected cells by mixing with white
                    if (!isSelected) {
                        // Mix with white: dimmed = original * dimFactor + white * (1 - dimFactor)
                        r = Math.round(r * dimFactor + 255 * (1 - dimFactor));
                        g = Math.round(g * dimFactor + 255 * (1 - dimFactor));
                        b = Math.round(b * dimFactor + 255 * (1 - dimFactor));
                    }
                    
                    // Fill all pixels in the cell
                    const startX = Math.floor(j * cellSize);
                    const endX = Math.floor((j + 1) * cellSize);
                    const startY = Math.floor(i * cellSize);
                    const endY = Math.floor((i + 1) * cellSize);

                    for (let y = startY; y < endY && y < this.size; y++) {
                        for (let x = startX; x < endX && x < this.size; x++) {
                            const idx = (y * this.size + x) * 4;
                            data[idx]     = r;
                            data[idx + 1] = g;
                            data[idx + 2] = b;
                            data[idx + 3] = 255; // alpha
                        }
                    }
                }
            }
            this.ctx.putImageData(imageData, 0, 0);
            
            // Draw selection boxes around selected regions
            this._drawSelectionBoxes(activeBoxes, previewBox, n, cellSize);
            
            // Draw chain boundary lines
            this._drawChainBoundaries(n, cellSize);
        }
        
        // Helper to draw selection boxes around selected regions
        _drawSelectionBoxes(activeBoxes, previewBox, n, cellSize) {
            this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)'; // Black box
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([]);
            
            // Draw active boxes
            for (const box of activeBoxes) {
                const i_start = Math.min(box.i_start, box.i_end);
                const i_end = Math.max(box.i_start, box.i_end);
                const j_start = Math.min(box.j_start, box.j_end);
                const j_end = Math.max(box.j_start, box.j_end);
                
                const x1 = Math.floor(j_start * cellSize);
                const y1 = Math.floor(i_start * cellSize);
                const x2 = Math.floor((j_end + 1) * cellSize);
                const y2 = Math.floor((i_end + 1) * cellSize);
                
                this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            }
            
            // Draw preview box if dragging
            if (previewBox && previewBox.x1 !== -1) {
                const i_start = Math.min(previewBox.y1, previewBox.y2);
                const i_end = Math.max(previewBox.y1, previewBox.y2);
                const j_start = Math.min(previewBox.x1, previewBox.x2);
                const j_end = Math.max(previewBox.x1, previewBox.x2);
                
                const x1 = Math.floor(j_start * cellSize);
                const y1 = Math.floor(i_start * cellSize);
                const x2 = Math.floor((j_end + 1) * cellSize);
                const y2 = Math.floor((i_end + 1) * cellSize);
                
                // Dashed line for preview
                this.ctx.setLineDash([5, 5]);
                this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'; // Lighter black for preview
                this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                this.ctx.setLineDash([]);
            }
        }
        
        // Helper to draw chain boundary lines in PAE plot
        _drawChainBoundaries(n, cellSize) {
            const renderer = this.mainRenderer;
            if (!renderer.chains || renderer.chains.length === 0) return;
            
            const boundaries = new Set(); // Set of PAE positions where chain changes
            
            // Find chain boundaries
            // PAE positions map directly to position indices (one position = one entry in frame data)
            for (let r = 0; r < n - 1 && r < renderer.chains.length - 1; r++) {
                const chain1 = renderer.chains[r];
                const chain2 = renderer.chains[r + 1];
                
                if (chain1 !== chain2) {
                    // Chain boundary at position r+1 (draw line before this position)
                    boundaries.add(r + 1);
                }
            }
            
            if (boundaries.size === 0) return; // No boundaries to draw
            
            // Draw vertical and horizontal lines at chain boundaries
            this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)'; // More visible black lines
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([]); // Solid lines
            
            for (const pos of boundaries) {
                const coord = Math.floor(pos * cellSize);
                
                // Vertical line
                this.ctx.beginPath();
                this.ctx.moveTo(coord, 0);
                this.ctx.lineTo(coord, this.size);
                this.ctx.stroke();
                
                // Horizontal line
                this.ctx.beginPath();
                this.ctx.moveTo(0, coord);
                this.ctx.lineTo(this.size, coord);
                this.ctx.stroke();
            }
        }
    }

    // Export PAERenderer to global scope
    window.PAERenderer = PAERenderer;
    window.getPAEColor = getPAEColor;
    window.getPAEColor_Colorblind = getPAEColor_Colorblind;

})();

