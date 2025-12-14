// ============================================================================
// py2Dmol/resources/viewer-pae.js
// -------------------------------
// AI Context: PAE MATRIX VISUALIZATION
// - Renders the Predicted Aligned Error (PAE) heatmap.
// - Handles interactive cross-referencing with the 3D viewer.
// - Manages PAE-specific color schemes (DeepMind, etc.).
// ============================================================================
// PAE (Predicted Aligned Error) RENDERER MODULE
// ============================================================================
// This module provides PAE visualization functionality for py2Dmol.
// It can be loaded conditionally when PAE data is available.

(function () {
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
    function getPAEColor(value, colorblind = false) {
        // 0 (blue) to 15 (white) to 30 (red/orange)
        const v = Math.max(0, Math.min(30, (value || 0)));

        if (v <= 15.0) {
            // 0 (blue) -> 15 (white)
            // Hue is 240 (blue)
            // Saturation goes from 1.0 down to 0.0
            const norm_blue = v / 15.0; // 0 to 1
            const saturation = 1.0 - norm_blue;
            return hsvToRgb(240, saturation, 1.0);
        } else {
            // 15 (white) -> 30 (red or orange for colorblind)
            const norm_red = (v - 15.0) / 15.0; // 0 to 1
            const saturation = norm_red;
            const hue = colorblind ? 30 : 0; // Orange for colorblind, red for normal
            return hsvToRgb(hue, saturation, 1.0);
        }
    }

    function getPAEColor_DeepMind(value) {
        // DeepMind green gradient: 0 (dark green) to 30 (very light green)
        // Green gradient is already colorblind-safe, no variant needed
        const v = Math.max(0, Math.min(30, (value || 0)));
        const t = v / 30.0; // 0 to 1

        // Interpolate between dark green and very light green
        const r = Math.round(5 + (225 - 5) * t);
        const g = Math.round(113 + (243 - 113) * t);
        const b = Math.round(47 + (220 - 47) * t);

        return { r, g, b };
    }

    // ============================================================================
    // PAE RENDERER CLASS
    // ============================================================================
    class PAERenderer {
        constructor(canvas, mainRenderer) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d', { alpha: false }); // Optimize for opaque canvas
            this.mainRenderer = mainRenderer; // Reference to Pseudo3DRenderer

            this.paeData = null;
            this.n = 0; // Matrix dimension

            // Use canvas internal width for size (canvas may be stretched by CSS)
            // This ensures rendering coordinates match mouse coordinates
            this.size = canvas.width;

            this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
            this.isDragging = false;
            this.isAdding = false; // Track if Shift is held for additive selection

            // Performance optimization: cache base image and selection state
            this.baseCanvas = null; // Offscreen canvas for base heatmap
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

                // Listen for color mode changes to re-render PAE with new color scheme
                this.colorChangeHandler = () => {
                    if (this.paeData) {
                        // Invalidate base image cache to force regeneration with new colors
                        this.baseCanvas = null;
                        this.scheduleRender();
                    }
                };
                document.addEventListener('py2dmol-color-change', this.colorChangeHandler);
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

        // Expand ligand positions
        expandLigandPositions(positionIndices) {
            if (typeof expandLigandSelection === 'function') {
                const currentObject = this.mainRenderer.objectsData[this.mainRenderer.currentObjectName];
                if (currentObject?.ligandGroups) {
                    return expandLigandSelection(positionIndices, currentObject.ligandGroups);
                }
            }
            return new Set(positionIndices);
        }

        getMousePos(e) {
            const rect = this.canvas.getBoundingClientRect();
            // Support both mouse and touch events
            const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
            const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);

            const displayX = clientX - rect.left;
            const displayY = clientY - rect.top;

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
            const n = this.n;
            if (n === 0) return { i: -1, j: -1 };
            const cellSize = this.size / n;
            const i = Math.floor(y / cellSize);
            const j = Math.floor(x / cellSize);
            return { i, j };
        }

        setupInteraction() {
            this.canvas.addEventListener('mousedown', (e) => {
                if (e.button !== 0 || !this.paeData) return;
                this.isAdding = e.shiftKey;
                if (!this.isAdding) {
                    this.mainRenderer.setSelection({
                        paeBoxes: [], positions: new Set(), chains: new Set(), selectionMode: 'explicit'
                    }, true);
                }
                this.isDragging = true;
                const { i, j } = this.getCellIndices(e);
                this.selection.x1 = j; this.selection.y1 = i;
                this.selection.x2 = j; this.selection.y2 = i;
                this.lastSelectionHash = null;
                this.scheduleRender();

                const handleMove = (e) => {
                    if (!this.isDragging || !this.paeData) return;
                    let cellIndices;
                    try { cellIndices = this.getCellIndices(e); } catch (err) { return; }
                    const { i, j } = cellIndices;
                    const n = this.n;
                    const newX2 = Math.max(0, Math.min(n - 1, j));
                    const newY2 = Math.max(0, Math.min(n - 1, i));
                    if (this.selection.x2 !== newX2 || this.selection.y2 !== newY2) {
                        this.selection.x2 = newX2; this.selection.y2 = newY2;
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

            const handleEnd = (e) => {
                if (!this.isDragging) return;
                this.isDragging = false;
                let i_start = Math.min(this.selection.y1, this.selection.y2);
                let i_end = Math.max(this.selection.y1, this.selection.y2);
                let j_start = Math.min(this.selection.x1, this.selection.x2);
                let j_end = Math.max(this.selection.x1, this.selection.x2);
                const n = this.n;
                if (n === 0 || i_start < 0 || j_start < 0) {
                    this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                    this.render();
                    return;
                }
                const isClick = (i_start === i_end && j_start === j_end);
                if (isClick) {
                    this.mainRenderer.setSelection({
                        paeBoxes: [], positions: new Set(), chains: new Set(), selectionMode: 'default'
                    }, false);
                    this.cachedSequencePositions = null;
                    this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                } else {
                    const newBox = { i_start, i_end, j_start, j_end };
                    const currentSelection = this.mainRenderer.getSelection();
                    const existingBoxes = currentSelection.paeBoxes || [];
                    const existingPositions = currentSelection.positions || new Set();
                    const newPositions = new Set();
                    for (let r = i_start; r <= i_end; r++) if (r >= 0 && r < this.mainRenderer.chains.length) newPositions.add(r);
                    for (let r = j_start; r <= j_end; r++) if (r >= 0 && r < this.mainRenderer.chains.length) newPositions.add(r);
                    const expandedNewPositions = this.expandLigandPositions(newPositions);

                    if (this.isAdding) {
                        const expandedExistingPositions = this.expandLigandPositions(existingPositions);
                        const combinedBoxes = [...existingBoxes, newBox];
                        const combinedPositions = new Set([...expandedExistingPositions, ...expandedNewPositions]);
                        const newChains = new Set();
                        if (this.mainRenderer.chains) {
                            for (const pos of combinedPositions) {
                                if (pos >= 0 && pos < this.mainRenderer.chains.length) newChains.add(this.mainRenderer.chains[pos]);
                            }
                        }
                        const hasPartialSelections = combinedPositions.size > 0 && combinedPositions.size < (this.mainRenderer.chains?.length || 0);
                        this.mainRenderer.setSelection({
                            paeBoxes: combinedBoxes, positions: combinedPositions, chains: newChains,
                            selectionMode: hasPartialSelections ? 'explicit' : 'default'
                        }, false);
                    } else {
                        const newChains = new Set();
                        if (this.mainRenderer.chains) {
                            for (const pos of expandedNewPositions) {
                                if (pos >= 0 && pos < this.mainRenderer.chains.length) newChains.add(this.mainRenderer.chains[pos]);
                            }
                        }
                        const hasPartialSelections = expandedNewPositions.size > 0 && expandedNewPositions.size < (this.mainRenderer.chains?.length || 0);
                        this.mainRenderer.setSelection({
                            paeBoxes: [newBox], positions: expandedNewPositions, chains: newChains,
                            selectionMode: hasPartialSelections ? 'explicit' : 'default'
                        }, false);
                    }
                    this.cachedSequencePositions = null;
                }
                this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                this.lastSelectionHash = null;
                this.cachedSequencePositions = null;
                this.scheduleRender();
            };

            this.canvas.addEventListener('mouseup', handleEnd);
            // Touch handling omitted for brevity but should be preserved if copied from original
            this.canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length !== 1 || !this.paeData) return;
                e.preventDefault();
                this.isAdding = false;
                this.mainRenderer.setSelection({ paeBoxes: [], positions: new Set(), chains: new Set(), selectionMode: 'explicit' }, true);
                this.isDragging = true;
                const { i, j } = this.getCellIndices(e);
                this.selection.x1 = j; this.selection.y1 = i;
                this.selection.x2 = j; this.selection.y2 = i;
                this.lastSelectionHash = null;
                this.scheduleRender();

                const handleTouchMove = (e) => {
                    if (!this.isDragging || !this.paeData || e.touches.length !== 1) return;
                    e.preventDefault();
                    let cellIndices;
                    try { cellIndices = this.getCellIndices(e.touches[0]); } catch (err) { return; }
                    const { i, j } = cellIndices;
                    const n = this.n;
                    const newX2 = Math.max(0, Math.min(n - 1, j));
                    const newY2 = Math.max(0, Math.min(n - 1, i));
                    if (this.selection.x2 !== newX2 || this.selection.y2 !== newY2) {
                        this.selection.x2 = newX2; this.selection.y2 = newY2;
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
            if (this.paeData === paeData) return;
            try {
                if (paeData && typeof paeData === 'object' && !Array.isArray(paeData) && !(paeData instanceof Uint8Array)) {
                    console.warn("PAE data is an object, converting to array (slow!)");
                    if (paeData.predicted_aligned_error) paeData = paeData.predicted_aligned_error;
                }
                if (paeData) {
                    if (paeData instanceof Uint8Array) {
                        this.paeData = paeData;
                        this.n = Math.round(Math.sqrt(paeData.length));
                    } else if (Array.isArray(paeData)) {
                        if (paeData.length > 0 && Array.isArray(paeData[0])) {
                            const n = paeData.length;
                            this.n = n;
                            const flattened = new Uint8Array(n * n);
                            for (let i = 0; i < n; i++) {
                                const row = paeData[i];
                                for (let j = 0; j < n; j++) {
                                    let val = Math.round(row[j] * 8);
                                    if (val > 255) val = 255;
                                    if (val < 0) val = 0;
                                    flattened[i * n + j] = val;
                                }
                            }
                            this.paeData = flattened;
                        } else {
                            this.paeData = new Uint8Array(paeData);
                            this.n = Math.round(Math.sqrt(paeData.length));
                        }
                    } else {
                        console.error("Invalid PAE data type:", typeof paeData);
                        this.paeData = null;
                        this.n = 0;
                    }
                } else {
                    this.paeData = null;
                    this.n = 0;
                }

                if (this.n > 0 && this.n * this.n !== this.paeData.length) {
                    console.warn(`PAE data length(${this.paeData.length}) is not a perfect square. inferred N = ${this.n}`);
                }
                this.lastSelectionHash = null;
                this.cachedSequencePositions = null;
                if (this.n > 0 && this.paeData) {
                    this._generateBaseImage();
                } else {
                    this.baseCanvas = null;
                }
                this.scheduleRender();
            } finally { }
        }

        getSequenceSelectedPAEPositions() {
            const selectedPositions = new Set();
            const renderer = this.mainRenderer;
            if (!this.paeData || this.n === 0) return selectedPositions;
            const selectionModel = renderer.selectionModel;
            const hasPositionSelection = selectionModel.positions && selectionModel.positions.size > 0;
            const hasChainSelection = selectionModel.chains && selectionModel.chains.size > 0;
            const mode = selectionModel.selectionMode || 'default';
            if (mode === 'default') {
                if (!hasPositionSelection) return selectedPositions;
            }
            if (!hasPositionSelection && !hasChainSelection) return selectedPositions;
            let allowedChains = hasChainSelection ? selectionModel.chains : new Set(renderer.chains);
            const n = this.n;
            for (let r = 0; r < n; r++) {
                if (r >= renderer.chains.length) continue;
                const chain = renderer.chains[r];
                if (allowedChains.has(chain) && (!hasPositionSelection || selectionModel.positions.has(r))) {
                    selectedPositions.add(r);
                }
            }
            return selectedPositions;
        }

        _generateBaseImage() {
            if (!this.paeData || this.n === 0) {
                this.baseCanvas = null;
                return;
            }
            const n = this.n;
            const offscreen = document.createElement('canvas');
            offscreen.width = n;
            offscreen.height = n;
            const ctx = offscreen.getContext('2d', { alpha: false });
            const imageData = ctx.createImageData(n, n);
            const data32 = new Uint32Array(imageData.data.buffer);
            const mainColorMode = this.mainRenderer && this.mainRenderer._getEffectiveColorMode ? this.mainRenderer._getEffectiveColorMode() : 'auto';
            const colorblind = this.mainRenderer?.colorblindMode || false;
            const colorMap = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                const value = i / 8.0;
                const { r, g, b } = (mainColorMode === 'deepmind') ? getPAEColor_DeepMind(value) : getPAEColor(value, colorblind);
                colorMap[i] = (255 << 24) | (b << 16) | (g << 8) | r;
            }
            const len = n * n;
            const paeData = this.paeData;
            for (let i = 0; i < len; i++) {
                data32[i] = colorMap[paeData[i]];
            }
            ctx.putImageData(imageData, 0, 0);
            this.baseCanvas = offscreen;
        }

        render() {
            this.ctx.clearRect(0, 0, this.size, this.size);
            if (!this.paeData || this.n === 0) {
                this.ctx.fillStyle = '#f9f9f9';
                this.ctx.fillRect(0, 0, this.size, this.size);
                this.ctx.fillStyle = '#999';
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                this.ctx.font = '14px sans-serif';
                this.ctx.fillText('No PAE Data', this.size / 2, this.size / 2);
                return;
            }
            const n = this.n;
            if (!this.baseCanvas) this._generateBaseImage();
            if (this.baseCanvas) {
                this.ctx.imageSmoothingEnabled = false;
                this.ctx.drawImage(this.baseCanvas, 0, 0, this.size, this.size);
            }

            const activeBoxes = this.mainRenderer.selectionModel.paeBoxes || [];
            const previewBox = (this.isDragging && this.selection.x1 !== -1) ? this.selection : null;
            if (this.cachedSequencePositions === null) this.cachedSequencePositions = this.getSequenceSelectedPAEPositions();
            const sequenceSelectedPositions = this.cachedSequencePositions;
            const mode = this.mainRenderer.selectionModel?.selectionMode || 'default';
            const hasSelection = activeBoxes.length > 0 || previewBox !== null || sequenceSelectedPositions.size > 0 || (mode === 'explicit');

            if (hasSelection) {
                const cellSize = this.size / n;
                const maskCanvas = document.createElement('canvas');
                maskCanvas.width = this.size;
                maskCanvas.height = this.size;
                const maskCtx = maskCanvas.getContext('2d');
                maskCtx.fillStyle = 'white';
                const drawMaskRegion = (i_start, i_end, j_start, j_end) => {
                    const x = Math.floor(j_start * cellSize);
                    const y = Math.floor(i_start * cellSize);
                    const w = Math.ceil((j_end - j_start + 1) * cellSize);
                    const h = Math.ceil((i_end - i_start + 1) * cellSize);
                    maskCtx.fillRect(x, y, w, h);
                };
                for (const box of activeBoxes) {
                    const i_start = Math.min(box.i_start, box.i_end);
                    const i_end = Math.max(box.i_start, box.i_end);
                    const j_start = Math.min(box.j_start, box.j_end);
                    const j_end = Math.max(box.j_start, box.j_end);
                    drawMaskRegion(i_start, i_end, j_start, j_end);
                }
                if (previewBox && previewBox.x1 !== -1) {
                    const i_start = Math.min(previewBox.y1, previewBox.y2);
                    const i_end = Math.max(previewBox.y1, previewBox.y2);
                    const j_start = Math.min(previewBox.x1, previewBox.x2);
                    const j_end = Math.max(previewBox.x1, previewBox.x2);
                    drawMaskRegion(i_start, i_end, j_start, j_end);
                }
                if (sequenceSelectedPositions.size > 0) {
                    const sortedPos = Array.from(sequenceSelectedPositions).sort((a, b) => a - b);
                    const ranges = [];
                    if (sortedPos.length > 0) {
                        let start = sortedPos[0], prev = sortedPos[0];
                        for (let i = 1; i < sortedPos.length; i++) {
                            if (sortedPos[i] !== prev + 1) {
                                ranges.push([start, prev]);
                                start = sortedPos[i];
                            }
                            prev = sortedPos[i];
                        }
                        ranges.push([start, prev]);
                    }
                    for (const r1 of ranges) {
                        for (const r2 of ranges) {
                            drawMaskRegion(r1[0], r1[1], r2[0], r2[1]);
                        }
                    }
                }
                const overlayCanvas = document.createElement('canvas');
                overlayCanvas.width = this.size;
                overlayCanvas.height = this.size;
                const overlayCtx = overlayCanvas.getContext('2d');
                overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                overlayCtx.fillRect(0, 0, this.size, this.size);
                overlayCtx.globalCompositeOperation = 'destination-out';
                overlayCtx.drawImage(maskCanvas, 0, 0);
                this.ctx.drawImage(overlayCanvas, 0, 0);
            }

            // 4. Draw selection boxes (outlines)
            this._drawSelectionBoxes(activeBoxes, previewBox, n, this.size / n);

            // 5. Draw chain boundary lines
            this._drawChainBoundaries(n, this.size / n);
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

            this.ctx.beginPath();
            for (const pos of boundaries) {
                const coord = Math.floor(pos * cellSize);

                // Vertical line
                this.ctx.moveTo(coord, 0);
                this.ctx.lineTo(coord, this.size);

                // Horizontal line
                this.ctx.moveTo(0, coord);
                this.ctx.lineTo(this.size, coord);
            }
            this.ctx.stroke();
        }
    }

    // ============================================================================
    // PAE NAMESPACE
    // ============================================================================
    const PAE = {
        Renderer: PAERenderer,

        // Check if PAE data is valid (Uint8Array or Array or Array-like)
        isValid: function (pae) {
            if (!pae) return false;
            if ((Array.isArray(pae) && pae.length > 0) || (pae.buffer && pae.length > 0)) return true;
            if (typeof pae === 'object' && typeof pae.length !== 'number') {
                const keys = Object.keys(pae);
                return keys.length > 0 && !isNaN(parseInt(keys[0]));
            }
            return false;
        },

        // Resolve PAE data for a frame (handles inheritance and backward search)
        resolveData: function (object, frameIndex) {
            if (!object || !object.frames || frameIndex < 0 || frameIndex >= object.frames.length) return null;
            const currentFrame = object.frames[frameIndex];

            // Check current frame
            if (this.isValid(currentFrame.pae)) return currentFrame.pae;

            // Use object-level tracking cache if available
            if (object._lastPaeFrame >= 0 && object._lastPaeFrame < frameIndex) {
                if (this.isValid(object.frames[object._lastPaeFrame].pae)) {
                    return object.frames[object._lastPaeFrame].pae;
                }
            }

            // Search backward
            for (let i = frameIndex - 1; i >= 0; i--) {
                if (this.isValid(object.frames[i].pae)) {
                    // Update cache for next time
                    object._lastPaeFrame = i;
                    return object.frames[i].pae;
                }
            }
            return null;
        },

        // Check if object has any PAE data
        hasData: function (object) {
            if (!object || !object.frames) return false;
            // Optimistic check: check first frame or iterate
            return object.frames.some(f => this.isValid(f.pae));
        },

        // Update PAE renderer with data for the specified frame
        updateFrame: function (renderer, object, frameIndex) {
            if (!renderer.paeRenderer) return;
            const paeData = this.resolveData(object, frameIndex);
            renderer.paeRenderer.setData(paeData);
            this.updateVisibility(renderer);
        },

        // Update PAE container visibility
        updateVisibility: function (renderer) {
            // Find container if not cached
            if (!renderer.paeContainer) {
                if (renderer.canvas && renderer.canvas.parentElement) {
                    const main = renderer.canvas.parentElement.closest('#mainContainer');
                    renderer.paeContainer = main ? main.querySelector('#paeContainer') : document.querySelector('#paeContainer');
                }
            }
            const container = renderer.paeContainer;
            if (!container) return; // Should we warn?

            // Determine visibility
            // We use renderer.objectHasPAE() logic here effectively
            // But we need to know if the CURRENT object has PAE

            // Re-implement objectHasPAE logic here using local helpers
            const name = renderer.currentObjectName;
            const object = renderer.objectsData[name];
            const hasPAE = object ? this.hasData(object) : false;

            container.style.display = hasPAE ? 'flex' : 'none';
            const canvas = container.querySelector('#paeCanvas');
            if (canvas) canvas.style.display = hasPAE ? 'block' : 'none';
        },

        // Initialization logic for viewer-mol.js to call
        initialize: function (renderer, containerElement, config) {
            if (!config.pae?.enabled) return;

            try {
                // Find PAE container and canvas
                // Try finding within containerElement first to support multiple viewers
                let paeContainer = containerElement.querySelector('#paeContainer');

                // Fallback for grid/standalone if not nested
                if (!paeContainer) {
                    const mainWithId = containerElement.closest('#mainContainer');
                    if (mainWithId) paeContainer = mainWithId.querySelector('#paeContainer');
                }

                if (!paeContainer) {
                    // Last resort document query
                    paeContainer = document.querySelector('#paeContainer');
                }

                if (!paeContainer) return; // Can't initialize

                const paeCanvas = paeContainer.querySelector('#paeCanvas');
                if (!paeCanvas) return;

                renderer.paeContainer = paeContainer;
                paeContainer.style.display = 'none';

                const updateSize = () => {
                    const rect = paeContainer.getBoundingClientRect();
                    const width = rect.width || 340;

                    // Critical: Update canvas backing store size
                    paeCanvas.width = width;
                    paeCanvas.height = width;

                    // Update canvas CSS size
                    paeCanvas.style.width = '100%';
                    paeCanvas.style.height = '100%';

                    if (renderer.paeRenderer) {
                        renderer.paeRenderer.size = width;
                        renderer.paeRenderer.scheduleRender();
                    }
                };

                // Create renderer
                const paeRenderer = new PAERenderer(paeCanvas, renderer);
                renderer.setPAERenderer(paeRenderer);

                // Set initial size
                updateSize();

                // If static data loaded, set data
                if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                    const object = renderer.objectsData[renderer.currentObjectName];
                    // Use renderer.currentFrame or 0
                    const frameIdx = renderer.currentFrame >= 0 ? renderer.currentFrame : 0;
                    this.updateFrame(renderer, object, frameIdx);
                }

                this.updateVisibility(renderer);

            } catch (e) {
                console.error("Failed to initialize PAE renderer:", e);
            }
        }
    };

    // Expose Global
    window.PAE = PAE;
    window.PAERenderer = PAERenderer; // Keep for legacy
    // Fire event
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('py2dmol_pae_loaded'));
    }

})();
