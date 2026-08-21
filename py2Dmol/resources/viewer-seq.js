// ============================================================================
// py2Dmol/resources/viewer-seq.js
// -------------------------------
// AI Context: SEQUENCE VIEWER
// - Renders the protein/nucleotide sequence.
// - Handles sequence-structure interaction (hover, click).
// - Supports virtual scrolling for large sequences.
// ============================================================================
// SEQUENCE VIEWER MODULE
// ============================================================================
// This module provides sequence viewer functionality for py2Dmol.
// It can be used in both web and Python interfaces.
// Now uses canvas-based rendering for improved performance.

(function () {
    'use strict';

    // ============================================================================
    // INTERNAL STATE
    // ============================================================================
    let sequenceCanvasData = null; // Canvas-based structure: { canvas, ctx, allResidueData, chainBoundaries, layout, mode }
    let lastSequenceFrameIndex = -1; // Track which frame the sequence view is showing
    let sequenceViewMode = true;  // Default: show sequence (enabled by default)
    let lastSequenceUpdateHash = null;
    let renderScheduled = false; // Flag to prevent multiple queued renders
    // HOVER IS THE RENDERER'S, NOT OURS. This module used to own a second
    // canvas over the molecule and paint the hover marks and their tooltip on
    // it, on its own schedule - which is how they went out of step with the
    // picture underneath (see _paintOverlays in viewer-mol.js). It now reports
    // what is hovered and the renderer draws it in the same frame as the
    // molecule. These two are kept only so a change to one does not clear the
    // other: the strip sets the marks, the 3D canvas sets the readout.
    let hoverAtoms = null;         // Set of position indices, or null
    let hoveredResidueInfo = null; // { chain, resName, resSeq } for the readout

    // Virtual scrolling state
    let scrollTop = 0;
    let scrollLeft = 0;
    const SCROLLBAR_WIDTH = 15;
    const SCROLLBAR_PADDING = 2;
    const SCROLLBAR_TRACK_COLOR = '#f0f0f0';
    const SCROLLBAR_THUMB_COLOR = '#b0b0b0';
    const SCROLLBAR_THUMB_COLOR_NO_SCROLL = '#d0d0d0';

    // Per-object preview state (single source of truth for preview during drag)
    const previewByObject = new Map();

    // Callbacks for integration with host application
    let callbacks = {
        getRenderer: null,           // () => renderer instance
        getObjectSelect: null,        // () => objectSelect element
        // no highlight callbacks: hover goes straight to renderer.setHover,
        // which paints it with the frame
        applyResidueSelection: null          // (previewPositions) => void
    };

    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================

    // Get current object name from renderer
    // A drag in the sequence strip picks a SELECTION - a set of residues the
    // tools act on - and never changes what is visible. Visibility is its own
    // explicit action (the Show / Hide buttons, and Show all / Hide all).
    //
    // These used to be the same thing: a drag set the visible set, so selecting
    // a region in order to recolour it hid the rest of the structure. That is
    // why selection and visibility are now separate, the way they are in PyMOL.

    function getCurrentObjectName() {
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        return renderer?.currentObjectName || null;
    }

    // Get preview selection for current object
    function getLocalPreview() {
        const name = getCurrentObjectName();
        return name ? (previewByObject.get(name) || null) : null;
    }

    // Set preview selection for current object.
    //
    // ALSO pushes it to the 3D view, live. A drag only commits on mouseup, so
    // the band in the viewer used to sit still until you let go; the renderer
    // shows a preview for the cost of a blit (it snapshots the finished frame
    // and repaints just the halo), so this is cheap enough to do on every
    // pointer move regardless of how big the structure is. Every drag path -
    // residues, chains, touch - goes through here, so hooking it once covers
    // all of them.
    function setLocalPreview(setOrNull) {
        const name = getCurrentObjectName();
        if (!name) return;
        if (setOrNull && setOrNull.size > 0) {
            // Store a copy to avoid external mutation
            previewByObject.set(name, new Set(setOrNull));
        } else {
            previewByObject.delete(name);
        }
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer || !renderer.updateSelectionPreview) return;
        if (setOrNull && setOrNull.size > 0) {
            renderer.updateSelectionPreview(setOrNull);
        } else {
            // cleared: hand the view back to the committed selection. The
            // caller that clears is either committing (a render follows) or
            // cancelling (this restores it), so a repaint here is the safe end.
            const wasLive = renderer._previewLive;
            renderer.endSelectionPreview();
            if (wasLive) renderer.render('selection preview end');
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

        // Adjust Y coordinate for scroll offset
        const adjustedY = y + scrollTop;

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
                adjustedY >= bounds.y && adjustedY < bounds.y + bounds.height) {
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
                        adjustedY >= chainPos.y && adjustedY < chainPos.y + chainPos.height) {
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
                        adjustedY >= chainPos.y && adjustedY < chainPos.y + chainPos.height) {
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

    // Draw scrollbars (vertical only for sequence viewer)
    function drawScrollbars(ctx, canvasWidth, canvasHeight, scrollableAreaHeight, fullContentHeight) {
        if (!sequenceCanvasData) return;

        // Vertical scrollbar dimensions
        const maxScrollTop = Math.max(0, fullContentHeight - scrollableAreaHeight);
        const scrollRatio = maxScrollTop > 0 ? scrollTop / maxScrollTop : 0;
        const thumbHeight = Math.max(20, (scrollableAreaHeight / fullContentHeight) * scrollableAreaHeight);
        const thumbY = scrollRatio * (scrollableAreaHeight - thumbHeight);
        const vScrollbarX = canvasWidth - SCROLLBAR_WIDTH;

        // Draw vertical scrollbar track
        ctx.fillStyle = SCROLLBAR_TRACK_COLOR;
        ctx.fillRect(vScrollbarX, 0, SCROLLBAR_WIDTH, scrollableAreaHeight);

        // Draw vertical scrollbar thumb
        if (maxScrollTop > 0) {
            ctx.fillStyle = SCROLLBAR_THUMB_COLOR;
            ctx.fillRect(vScrollbarX + SCROLLBAR_PADDING, thumbY,
                SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2, thumbHeight);
        } else {
            // No scrolling needed - show disabled thumb
            ctx.fillStyle = SCROLLBAR_THUMB_COLOR_NO_SCROLL;
            ctx.fillRect(vScrollbarX + SCROLLBAR_PADDING, 0,
                SCROLLBAR_WIDTH - SCROLLBAR_PADDING * 2, scrollableAreaHeight);
        }
    }

    // Main canvas rendering function
    function renderSequenceCanvas() {
        if (!sequenceCanvasData) return;

        const { canvas, ctx, allResidueData, chainBoundaries, layout, sortedPositionEntries } = sequenceCanvasData;
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer) return;

        // Calculate logical dimensions (accounting for DPI multiplier)
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;
        const logicalWidth = canvas.width / dpiMultiplier;
        const logicalHeight = canvas.height / dpiMultiplier;

        // Calculate scrollable area
        const fullContentHeight = layout.fullContentHeight || logicalHeight;
        const scrollableAreaHeight = logicalHeight; // Scrollbar is on the right side, not adding to height
        const maxScrollTop = Math.max(0, fullContentHeight - scrollableAreaHeight);

        // Clamp scrollTop to valid range
        scrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop));

        // Clear canvas
        ctx.clearRect(0, 0, logicalWidth, logicalHeight);

        // Get selection state - use visibilityModel directly to avoid expensive getVisibility() copy
        const visibilityModel = renderer.visibilityModel;
        const previewSelectionSet = getLocalPreview();

        // The drag preview describes a SELECTION, not a visibility change, so it
        // must not feed the dim/undim path - letting it through made the
        // structure appear to vanish while dragging out a region to recolour.
        // It is drawn as the selection outline instead.
        const stylePreview = previewSelectionSet;
        const visibilityPreview = null;

        // Determine visible positions - avoid unnecessary Set copies
        let visiblePositions;
        if (visibilityPreview && visibilityPreview.size > 0) {
            // Use preview selection directly (already a Set, no need to copy)
            visiblePositions = visibilityPreview;
        } else {
            if (visibilityModel && visibilityModel.positions && visibilityModel.positions.size > 0) {
                // Use visibilityModel directly (no copy needed for read-only access)
                visiblePositions = visibilityModel.positions;
            } else if (renderer.visiblePositions === null) {
                // All positions visible - create Set only if needed (lazy)
                const n = renderer.coords ? renderer.coords.length : 0;
                visiblePositions = new Set();
                for (let i = 0; i < n; i++) {
                    visiblePositions.add(i);
                }
            } else if (renderer.visiblePositions && renderer.visiblePositions.size > 0) {
                // Use visiblePositions directly (no copy needed for read-only access)
                visiblePositions = renderer.visiblePositions;
            } else {
                visiblePositions = new Set();
            }
        }

        const dimFactor = 0.3; // Same as PAE plot

        // Draw chain labels (with virtual scrolling)
        if (layout.chainLabelPositions) {
            // Chain labels show VISIBILITY, and only visibility. A drag preview
            // describes the pending SELECTION now, so it must not touch these -
            // this block used to rewrite chainSelection from the preview and
            // force 'explicit', which made every chain outside the drag render
            // as unselected. Dragging one chain appeared to fade all the others.
            // The pending selection is shown by the yellow box instead.
            const chainSelection = visibilityModel?.chains;
            const visibilityMode = visibilityModel?.visibilityMode;
            const frameChains = renderer.objectsData?.[renderer.currentObjectName]
                ?.frames?.[0]?.chains || null;

            // Only render chains that are visible in the current scroll position
            for (const chainPos of layout.chainLabelPositions) {
                const yOffset = chainPos.y - scrollTop;

                // Skip if chain is outside visible area
                if (yOffset + chainPos.height < 0 || yOffset > scrollableAreaHeight) {
                    continue;
                }

                const chainId = chainPos.chainId;
                const isSelected = chainSelection?.has(chainId) ||
                    (visibilityMode === 'default' && (!chainSelection || chainSelection.size === 0));
                // If the WHOLE chain carries the same explicit colour, the label
                // shows that instead of the chain palette entry - otherwise
                // recolouring a chain left its label advertising a colour the
                // structure no longer uses.
                let chainColor = renderer?.getChainColorForChainId?.(chainId)
                    || { r: 128, g: 128, b: 128 };
                if (renderer?.getColorOverride && frameChains) {
                    let uniform = null;
                    let all = true;
                    for (let i = 0; i < frameChains.length && all; i++) {
                        if (frameChains[i] !== chainId) continue;
                        const ov = renderer.getColorOverride(i);
                        if (!ov) { all = false; break; }
                        if (uniform === null) uniform = ov;
                        else if (ov.r !== uniform.r || ov.g !== uniform.g
                            || ov.b !== uniform.b) { all = false; }
                    }
                    if (all && uniform) chainColor = uniform;
                }

                drawChainLabelOnCanvas(
                    ctx,
                    chainId,
                    chainPos.x,
                    yOffset,
                    chainPos.width,
                    chainPos.height,
                    isSelected,
                    chainColor,
                    layout.charHeight
                );
            }
        }

        // Draw position characters and ligand tokens (with virtual scrolling)
        if (layout.residuePositions && allResidueData) {
            // Get renderer's getAtomColor function for dynamic color computation
            const hasGetAtomColor = renderer?.getAtomColor;
            // Cache effective color mode to avoid redundant lookups in the loop
            const effectiveColorMode = renderer?._getEffectiveColorMode?.() || 'auto';

            for (const pos of layout.residuePositions) {
                const yOffset = pos.y - scrollTop;

                // Skip if residue is outside visible area
                if (yOffset + pos.height < 0 || yOffset > scrollableAreaHeight) {
                    continue;
                }

                const residueData = pos.residueData;
                if (!residueData) continue;

                // Compute color dynamically based on current renderer state
                let color = { r: 128, g: 128, b: 128 }; // Default fallback grey

                if (residueData.positionIndex === -1) {
                    // Gap markers (missing positions) use stored light grey color
                    color = residueData.color || { r: 240, g: 240, b: 240 };
                } else if (residueData.isLigandToken && residueData.positionIndices && residueData.positionIndices.length > 0) {
                    // For ligand tokens, use first position's color
                    const firstPositionIndex = residueData.positionIndices[0];
                    if (hasGetAtomColor && !Number.isNaN(firstPositionIndex) && firstPositionIndex >= 0) {
                        color = renderer.getAtomColor(firstPositionIndex, effectiveColorMode);
                    }
                } else if (residueData.positionIndex >= 0) {
                    // For regular positions, use position's color
                    if (hasGetAtomColor && !Number.isNaN(residueData.positionIndex)) {
                        color = renderer.getAtomColor(residueData.positionIndex, effectiveColorMode);
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
                        yOffset,
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
                        yOffset,
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
                        yOffset,
                        pos.width,
                        pos.height,
                        color,
                        isSelected,
                        dimFactor
                    );
                }
            }

            // STYLE TARGET OUTLINE. Drawn as a box around each contiguous run
            // rather than per residue, so a targeted stretch reads as one
            // region. Deliberately a different visual vocabulary from the
            // dim/undim used for visibility - a style target and a visibility
            // selection must never look alike.
            // during a drag the outline tracks the pending range, so the box
            // follows the cursor instead of only appearing on release
            const target = (stylePreview && stylePreview.size) ? stylePreview
                : renderer?.residueSelection;
            if (target && target.size) {
                const rects = new Map();
                for (const pos of layout.residuePositions) {
                    const rd = pos.residueData;
                    if (!rd) continue;
                    // A LIGAND TOKEN is one cell standing for several atoms, so
                    // it carries positionIndices (plural) and no positionIndex -
                    // keying only off the singular skipped ligands entirely and
                    // a selected ligand got no box.
                    const idxs = (rd.isLigandToken && rd.positionIndices
                        && rd.positionIndices.length)
                        ? rd.positionIndices
                        : (rd.positionIndex >= 0 ? [rd.positionIndex] : []);
                    if (!idxs.some((i) => target.has(i))) continue;
                    const yOffset = pos.y - scrollTop;
                    if (yOffset + pos.height < 0 || yOffset > scrollableAreaHeight) continue;
                    // keyed by the token's FIRST index so run adjacency still
                    // works against neighbouring residues
                    rects.set(idxs[0], { x: pos.x, y: yOffset, w: pos.width, h: pos.height });
                }
                if (rects.size) {
                    // Collect the run edges once, then stroke them TWICE: a dark
                    // casing first, the yellow on top. The strip is rainbow /
                    // chain coloured, so a plain yellow line disappears wherever
                    // it crosses a yellow-green residue; the casing makes the box
                    // read against any residue colour underneath.
                    const edges = [];
                    for (const [idx, r] of rects) {
                        // An edge is drawn only where the run actually ends.
                        // Adjacency is decided GEOMETRICALLY as well as by
                        // index, so a run that wraps to the next line is closed
                        // off at both ends instead of drawing a stray edge
                        // across the strip.
                        const prev = rects.get(idx - 1);
                        const next = rects.get(idx + 1);
                        const joinsPrev = prev && prev.y === r.y
                            && Math.abs(prev.x + prev.w - r.x) < 0.5;
                        const joinsNext = next && next.y === r.y
                            && Math.abs(r.x + r.w - next.x) < 0.5;
                        const x0 = r.x + 0.5, y0 = r.y + 0.5;
                        const x1 = r.x + r.w - 0.5, y1 = r.y + r.h - 0.5;
                        edges.push([x0, y0, x1, y0]);            // top
                        edges.push([x0, y1, x1, y1]);            // bottom
                        if (!joinsPrev) edges.push([x0, y0, x0, y1]);
                        if (!joinsNext) edges.push([x1, y0, x1, y1]);
                    }
                    ctx.save();
                    ctx.lineCap = 'square';
                    const strokeEdges = (style, width) => {
                        ctx.strokeStyle = style;
                        ctx.lineWidth = width;
                        ctx.beginPath();
                        for (const [ax, ay, bx, by] of edges) {
                            ctx.moveTo(ax, ay);
                            ctx.lineTo(bx, by);
                        }
                        ctx.stroke();
                    };
                    strokeEdges('rgba(17, 24, 39, 0.85)', 4);
                    strokeEdges('#ffd400', 2);
                    ctx.restore();
                }
            }

            // CHAIN LABELS get the same box when the whole chain is selected.
            // In chain mode the strip shows labels rather than residues, so
            // without this a chain click selected the chain and nothing on
            // screen said so.
            if (target && target.size && layout.chainLabelPositions) {
                const obj = renderer.objectsData[renderer.currentObjectName];
                const chains = obj?.frames?.[0]?.chains;
                if (chains) {
                    const total = new Map();
                    const picked = new Map();
                    for (let i = 0; i < chains.length; i++) {
                        const c = chains[i];
                        total.set(c, (total.get(c) || 0) + 1);
                        if (target.has(i)) picked.set(c, (picked.get(c) || 0) + 1);
                    }
                    const boxes = layout.chainLabelPositions.filter((cp) => {
                        const t = total.get(cp.chainId) || 0;
                        return t > 0 && picked.get(cp.chainId) === t;
                    });
                    if (boxes.length) {
                        ctx.save();
                        ctx.lineCap = 'square';
                        const strokeBoxes = (style, width) => {
                            ctx.strokeStyle = style;
                            ctx.lineWidth = width;
                            ctx.beginPath();
                            for (const cp of boxes) {
                                const y = cp.y - scrollTop;
                                if (y + cp.height < 0 || y > scrollableAreaHeight) continue;
                                ctx.rect(cp.x + 0.5, y + 0.5, cp.width - 1, cp.height - 1);
                            }
                            ctx.stroke();
                        };
                        strokeBoxes('rgba(17, 24, 39, 0.85)', 4);
                        strokeBoxes('#ffd400', 2);
                        ctx.restore();
                    }
                }
            }
        }

        // Draw scrollbar
        drawScrollbars(ctx, logicalWidth, logicalHeight, scrollableAreaHeight, fullContentHeight);

        // Draw hover highlight if needed (will be handled in event handlers)
    }

    // ============================================================================
    // MAIN SEQUENCE VIEWER FUNCTIONS
    // ============================================================================

    // THE PICTURE FIRST, THE SEQUENCE A FRAME LATER.
    //
    // Building the view lays out one entry per residue - a layout record, a
    // residue record and a selectable item each - and on a 313,000-residue
    // capsid that is 214 ms. It runs from _switchToObject, which is on the
    // path between "the coordinates are ready" and "something is on screen",
    // so the whole of it is spent with a blank canvas up.
    //
    // Nothing the structure canvas draws reads any of it, so it can wait. Two
    // frames: the first lets the render that follows the switch actually
    // paint, the second runs the build. Requests coalesce, and a synchronous
    // buildView in between is harmless - it caches on the frame it built from
    // and the deferred call returns early.
    let deferredBuild = 0;
    function buildSequenceViewDeferred() {
        if (typeof requestAnimationFrame !== 'function') { buildSequenceView(); return; }
        if (deferredBuild) return;
        deferredBuild = requestAnimationFrame(() => {
            requestAnimationFrame(() => { deferredBuild = 0; buildSequenceView(); });
        });
    }

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
            'ALA': 'A', 'ARG': 'R', 'ASN': 'N', 'ASP': 'D', 'CYS': 'C', 'GLU': 'E', 'GLN': 'Q', 'GLY': 'G', 'HIS': 'H', 'ILE': 'I',
            'LEU': 'L', 'LYS': 'K', 'MET': 'M', 'PHE': 'F', 'PRO': 'P', 'SER': 'S', 'THR': 'T', 'TRP': 'W', 'TYR': 'Y', 'VAL': 'V',
            'SEC': 'U', 'PYL': 'O',
            // modified and D-amino acids resolve to their parent's letter, the
            // same way gemmi's one_letter_code does; without these a D-peptide
            // reads as a row of X in the sequence panel
            'MSE': 'M', 'HSD': 'H', 'HSE': 'H', 'HID': 'H', 'HIE': 'H', 'HIP': 'H',
            'DAL': 'A', 'DAR': 'R', 'DSG': 'N', 'DAS': 'D', 'DCY': 'C',
            'DGN': 'Q', 'DGL': 'E', 'DHI': 'H', 'DIL': 'I', 'DLE': 'L',
            'DLY': 'K', 'MED': 'M', 'DPN': 'F', 'DPR': 'P', 'DSN': 'S',
            'DTH': 'T', 'DTR': 'W', 'DTY': 'Y', 'DVA': 'V'
        };

        // DNA nucleotide mapping
        const dnaMapping = {
            'DA': 'A', 'DT': 'T', 'DC': 'C', 'DG': 'G',
            'A': 'A', 'T': 'T', 'C': 'C', 'G': 'G',  // Alternative naming
            'ADE': 'A', 'THY': 'T', 'CYT': 'C', 'GUA': 'G'  // Alternative naming
        };

        // RNA nucleotide mapping
        const rnaMapping = {
            'A': 'A', 'U': 'U', 'C': 'C', 'G': 'G',
            'RA': 'A', 'RU': 'U', 'RC': 'C', 'RG': 'G',  // Alternative naming
            'ADE': 'A', 'URA': 'U', 'CYT': 'C', 'GUA': 'G',  // Alternative naming
            'URI': 'U', 'UMP': 'U', 'URD': 'U',  // Uridine variations
            'RURA': 'U', 'RURI': 'U'  // More RNA uracil variations
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
            // Get ligand groups from renderer (computed using shared utility)
            const currentObject = renderer?.objectsData?.[renderer.currentObjectName];
            const ligandGroups = currentObject?.ligandGroups || new Map();

            // Reverse map: position index -> ligand group key.
            //
            // BUILT ONCE, not once per chain. It does not depend on the chain,
            // and rebuilding it inside the loop below is quadratic in exactly
            // the case that hurts: 7Y7A has 6,390 chains and about 207,000
            // ligand positions, which is 1.3 billion Map writes and a minute
            // and a half of a frozen tab, all to produce the same map 6,390
            // times. processedLigandGroups stays inside the loop - that one is
            // genuinely per-chain.
            const positionToLigandGroup = new Map();
            for (const [groupKey, positionIndicesInGroup] of ligandGroups) {
                for (const positionIndex of positionIndicesInGroup) {
                    positionToLigandGroup.set(positionIndex, groupKey);
                }
            }

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
                                        color: { r: 240, g: 240, b: 240 },
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

        // Calculate visible area dimensions
        const maxVisibleLines = 32; // Maximum number of lines to show at once (same as before)
        const maxVisibleHeight = maxVisibleLines * charHeight + spacing;
        const fullContentHeight = currentY; // Full content height (actual total)

        // Store fullContentHeight in layout for later use
        layout.fullContentHeight = fullContentHeight;
        layout.scrollbarWidth = SCROLLBAR_WIDTH;

        // Canvas dimensions: visible area + scrollbar space
        // Add SCROLLBAR_WIDTH to width to prevent scrollbar from overlapping content
        const logicalWidth = sequenceWidth + SCROLLBAR_WIDTH;
        const logicalHeight = Math.min(fullContentHeight, maxVisibleHeight);

        // Set canvas internal dimensions to achieve 200 DPI (pixels per inch)
        // Standard web DPI is 96, so 200 DPI = 200/96 ≈ 2.083x multiplier
        const targetDPI = 200;
        const standardDPI = 96;
        const dpiMultiplier = targetDPI / standardDPI;

        // Canvas logical size is fixed to visible area (not full content)
        canvas.width = logicalWidth * dpiMultiplier;
        canvas.height = logicalHeight * dpiMultiplier;

        // Set display size (CSS pixels) - canvas is fixed visible size
        canvas.style.width = '100%';
        canvas.style.height = logicalHeight + 'px';

        // Remove native scrolling - we'll use custom scrollbar
        sequenceViewEl.style.overflowY = 'visible';
        sequenceViewEl.style.maxHeight = 'none';

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

        // One gesture's worth of state, whichever pointer opened it. The
        // field list is the whole of it - endChainId used to be added on the
        // fly, which left the block below describing four fields that no
        // longer existed and none of the ones that did.
        const dragState = {
            active: false,           // has the press turned into a drag?
            startItem: null,         // item the press landed on
            endItemIndex: -1,        // item the drag currently ends on
            endChainId: null,        // ...or chain, when dragging the chain strip
            initialPositions: null,  // the selection before the press
            unselectMode: false,     // started on a selected item, so this drag removes
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

        // Mouse wheel scrolling
        newCanvas.addEventListener('wheel', (e) => {
            e.preventDefault();

            const fullContentHeight = layout.fullContentHeight || 0;
            const logicalHeight = newCanvas.height / dpiMultiplier;
            const scrollableAreaHeight = logicalHeight;
            const maxScrollTop = Math.max(0, fullContentHeight - scrollableAreaHeight);

            // Vertical scrolling
            const delta = e.deltaY;
            scrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop + delta));

            scheduleRender();
        }, { passive: false });

        // Helper: Apply selection to renderer
        const applyResidueSelection = (positions) => {
            const objectName = renderer.currentObjectName;
            const obj = renderer.objectsData[objectName];
            const frame = obj?.frames?.[0];
            if (!frame) return;

            // Record the selection and stop. Deliberately does NOT call
            // setVisibility - that is what recomputes visiblePositions, and a
            // selection must not change what is on screen.
            // Empty clears rather than storing an empty set, so every consumer
            // can test the selection with a simple truthiness check.
            renderer.residueSelection = (positions && positions.size)
                ? new Set(positions) : null;
            scheduleRender();
            document.dispatchEvent(new CustomEvent('py2dmol-residue-selection-change'));
            return;

        };

        // Every position belonging to a chain, for click-a-chain-label.
        const positionsOfChain = (chainId) => {
            const obj = renderer.objectsData[renderer.currentObjectName];
            const frame = obj?.frames?.[0];
            const out = new Set();
            if (frame?.chains) {
                for (let i = 0; i < frame.chains.length; i++) {
                    if (frame.chains[i] === chainId) out.add(i);
                }
            }
            return out;
        };

        // What a click/drag toggles AGAINST. This has to follow the intent:
        // in 'style' the baseline is the style target, in 'show' it is the
        // visible set. Using the visible set for both was the bug - with
        // everything visible, the baseline was every residue, so the clicked
        // item counted as already-selected, unselectMode came out true, and a
        // drag SUBTRACTED its range from the whole structure. The committed
        // target was the exact inverse of what had been dragged over.
        const baselinePositions = () => {
            return renderer?.residueSelection ? new Set(renderer.residueSelection) : new Set();
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
                if (residueData.isLigandToken && residueData.positionIndices) {
                    // the whole ligand marks as one thing
                    setHoverAtoms(new Set(residueData.positionIndices));
                    hoveredResidueInfo = {
                        chain: residueData.chain,
                        resName: residueData.ligandName || residueData.resName,
                        resSeq: residueData.resSeq
                    };
                } else if (residueData.positionIndex >= 0) {
                    setHoverAtoms(new Set([residueData.positionIndex]));
                    // Store hovered position info for tooltip
                    hoveredResidueInfo = {
                        chain: residueData.chain,
                        resName: residueData.resName,
                        resSeq: residueData.resSeq
                    };
                } else {
                    setHoverAtoms(null);
                    hoveredResidueInfo = null;
                }
            } else if (chainLabelPos) {
                // In both sequence mode and chain mode, highlight entire chain on hover over chain button
                const chainId = chainLabelPos.chainId;
                const boundary = chainBoundaries.find(b => b.chain === chainId);
                if (boundary) {
                    const chainPositions = sortedPositionEntries.slice(boundary.startIndex, boundary.endIndex + 1);
                    if (chainPositions.length > 0) {
                        setHoverAtoms(new Set(chainPositions.map(a => a.positionIndex)));
                    }
                }
                // Clear tooltip when hovering over chain button (in both modes)
                hoveredResidueInfo = null;
            } else {
                setHoverAtoms(null);
                hoveredResidueInfo = null; // Clear tooltip when not hovering over position
            }
            pushHover();
        });

        newCanvas.addEventListener('mouseup', () => {
            // Cleanup handled by window listener
        });
        newCanvas.addEventListener('mouseleave', () => {
            // Clear hover state when mouse leaves
            setHoverAtoms(null);
            hoveredResidueInfo = null;
            pushHover();
        });

        // Touch event handlers - same logic as mouse handlers

        // === Unified selection handlers (press → optional drag → release) ===
        // Applies to chain, sequence, and ligand. Chain toggles on release (no drag),
        // sequence/ligand preview during drag; commit on release.
        // ---- ONE GESTURE PATH FOR MOUSE AND TOUCH ---------------------------
        //
        // These used to be two independent handlers with two copies of the
        // selection logic, and the touch copy was the older of the two: a tap
        // on a chain label toggled that chain's VISIBILITY (the pre-selection
        // behaviour) while a click on desktop toggled its SELECTION, dragging
        // across chain labels did nothing, and the scrollbar - the only way to
        // reach a long sequence, since a phone has no wheel event - could not
        // be touched at all. Any behaviour added to one path silently skipped
        // the other.
        //
        // So there is one path now. A gesture is opened with a canvas position
        // and the modifier state, and is driven by moveTo/finish; the mouse and
        // touch listeners below do nothing but translate their own events into
        // those three calls. A new behaviour cannot land on one pointer type
        // only, because there is only one place to put it.

        // Where a range extends FROM: the last item committed by a plain click
        // or drag, plus the selection as it stood once that click had landed.
        // A shift-click is `anchorBase + the span from the anchor`, so
        // stretching the same range shorter SHRINKS it instead of leaving the
        // longer one behind - which is what every list in every file manager
        // does, and the only version in which the anchor is observable at all.
        let anchorItem = null;
        let anchorBase = new Set();

        // Called wherever a plain gesture commits.
        const setAnchor = (item) => {
            anchorItem = item;
            anchorBase = new Set(renderer.residueSelection || []);
        };

        const chainOrder = () => (layout.chainLabelPositions || []).map((c) => c.chainId);

        // Union of every chain from a to b in label order, inclusive.
        const chainRangePositions = (chainA, chainB) => {
            const order = chainOrder();
            const i0 = order.indexOf(chainA);
            const i1 = order.indexOf(chainB);
            const picked = new Set();
            if (i0 < 0 || i1 < 0) return picked;
            for (let k = Math.min(i0, i1); k <= Math.max(i0, i1); k++) {
                for (const i of positionsOfChain(order[k])) picked.add(i);
            }
            return picked;
        };

        // SHIFT EXTENDS, it does not toggle. Two chain items extend over the
        // chain strip; two residue items extend over the item list. A mixed
        // pair has no meaningful span between them - in sequence mode the item
        // list runs every chain label first and then every residue, so the
        // indices between a chain and a residue sweep up unrelated chains -
        // and falls back to plain toggle rather than selecting something the
        // user cannot see the shape of.
        const shiftExtend = (item) => {
            if (!anchorItem) return null;
            const base = new Set(anchorBase);
            if (anchorItem.type === 'chain' && item.type === 'chain') {
                const picked = chainRangePositions(anchorItem.chainId, item.chainId);
                for (const i of base) picked.add(i);
                return picked;
            }
            if (anchorItem.type !== 'chain' && item.type !== 'chain') {
                return computeSelectionFromRange(anchorItem.index, item.index, base, false);
            }
            return null;
        };

        // Double click/tap takes the whole chain the item belongs to. Chains
        // are the one grouping the strip already draws, so this is the gesture
        // people reach for after clicking one residue of a long chain.
        //
        // It does NOT apply to a chain label, where a single click already
        // takes the whole chain: there, re-selecting on the second click would
        // undo the toggle-off that a quick second click is asking for, so a
        // chain label that is clicked twice in a hurry would stick on.
        const chainIdOfItem = (item) => {
            if (!item) return null;
            if (item.type === 'chain') return item.chainId;
            const rd = item.residueData;
            if (rd && rd.chain) return rd.chain;
            const obj = renderer.objectsData[renderer.currentObjectName];
            const frame = obj?.frames?.[0];
            const first = item.positionIndices && item.positionIndices[0];
            return (frame?.chains && first !== undefined) ? frame.chains[first] : null;
        };

        const selectWholeChain = (item, additive) => {
            const chainId = chainIdOfItem(item);
            if (!chainId) return;
            const all = positionsOfChain(chainId);
            if (additive) for (const i of baselinePositions()) all.add(i);
            applyResidueSelection(all);
            setAnchor(item);
            setLocalPreview(null);
            lastSequenceUpdateHash = null;
            scheduleRender();
        };

        // Scrollbar drag, shared. `finish` is a no-op for it; the caller just
        // stops feeding it positions.
        const beginScrollDrag = (pos) => {
            const logicalHeight = newCanvas.height / dpiMultiplier;
            const fullContentHeight = layout.fullContentHeight || 0;
            const maxScrollTop = Math.max(0, fullContentHeight - logicalHeight);
            if (maxScrollTop <= 0) return { moveTo() {}, finish() {} };
            const seek = (p) => {
                const ratio = Math.max(0, Math.min(1, p.y / logicalHeight));
                scrollTop = Math.max(0, Math.min(maxScrollTop, ratio * fullContentHeight));
                scheduleRender();
            };
            seek(pos);
            return { moveTo: seek, finish() {} };
        };

        const onScrollbar = (pos) => {
            const logicalWidth = newCanvas.width / dpiMultiplier;
            const logicalHeight = newCanvas.height / dpiMultiplier;
            return pos.x >= logicalWidth - SCROLLBAR_WIDTH && pos.y <= logicalHeight;
        };

        // Open a gesture at `pos`. Returns null when there is nothing under it
        // and the click has already been dealt with (clearing the selection).
        const beginGesture = (pos, shiftKey) => {
            if (onScrollbar(pos)) return beginScrollDrag(pos);

            const item = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            if (!item) {
                // Clicking empty space clears the STYLE TARGET, the way clicking
                // the background deselects in PyMOL. Only in style intent: in
                // show intent the selection is the visible set, and an empty
                // explicit selection means "show nothing" - clicking a gap would
                // blank the structure.
                if (renderer?.residueSelection) {
                    renderer.residueSelection = null;
                    anchorItem = null;
                    anchorBase = new Set();
                    lastSequenceUpdateHash = null;
                    scheduleRender();
                    document.dispatchEvent(new CustomEvent('py2dmol-residue-selection-change'));
                }
                return null;
            }

            // A shift-click is a click, not a drag: it commits its span at once
            // and opens no gesture, so a wobbling finger cannot turn it into a
            // freehand range from the wrong end.
            if (shiftKey) {
                const extended = shiftExtend(item);
                if (extended) {
                    applyResidueSelection(extended);
                    setLocalPreview(null);
                    lastSequenceUpdateHash = null;
                    scheduleRender();
                    return null;
                }
            }

            const currentPositions = baselinePositions();
            dragState.active = false;
            dragState.startItem = item;
            dragState.endItemIndex = item.index;
            dragState.endChainId = null;
            dragState.initialPositions = new Set(currentPositions);
            dragState.unselectMode = !!(item.positionIndices && item.positionIndices.length > 0
                && item.positionIndices.every((pi) => currentPositions.has(pi)));

            if (item.type !== 'chain') {
                setLocalPreview(computeSelectionFromRange(
                    item.index, item.index, dragState.initialPositions, dragState.unselectMode
                ));
                lastSequenceUpdateHash = null;
                scheduleRender();
            }

            const moveTo = (dragPos) => {
                const over = getSelectableItemAtPosition(dragPos.x, dragPos.y, layout, sequenceViewMode);
                if (!over) return;

                if (item.type === 'chain') {
                    // DRAG ACROSS CHAINS. In chain mode the strip is a row of
                    // chain blocks, so dragging over them is the natural way to
                    // pick several - previously only a single click worked and a
                    // drag did nothing at all.
                    if (over.type !== 'chain') return;
                    dragState.active = true;
                    if (over.chainId === dragState.endChainId) return;
                    dragState.endChainId = over.chainId;
                    setLocalPreview(chainRangePositions(item.chainId, over.chainId));
                    lastSequenceUpdateHash = null;
                    scheduleRender();
                    return;
                }

                dragState.active = true;
                if (over.index === dragState.endItemIndex) return;
                dragState.endItemIndex = over.index;
                setLocalPreview(computeSelectionFromRange(
                    dragState.startItem.index, over.index,
                    dragState.initialPositions, dragState.unselectMode
                ));
                lastSequenceUpdateHash = null;
                scheduleRender();
            };

            const finish = (endPos) => {
                const startItem = dragState.startItem;
                if (startItem?.type === 'chain') {
                    // a drag across chain blocks commits its preview; a plain
                    // click falls through to the single-chain toggle
                    const dragged = getLocalPreview();
                    if (dragState.active && dragged && dragged.size) {
                        applyResidueSelection(dragged);
                        setAnchor(startItem);
                    } else {
                        const over = endPos
                            ? getSelectableItemAtPosition(endPos.x, endPos.y, layout, sequenceViewMode)
                            : null;
                        if (over && over.type === 'chain' && over.chainId === startItem.chainId) {
                            // Select the WHOLE chain. Clicking it again clears
                            // it, so the label toggles rather than only ever
                            // adding.
                            const all = positionsOfChain(over.chainId);
                            const cur = renderer.residueSelection;
                            const already = all.size > 0 && cur
                                && [...all].every((i) => cur.has(i));
                            applyResidueSelection(already ? new Set() : all);
                            setAnchor(startItem);
                        }
                    }
                } else if (startItem) {
                    const previewSet = getLocalPreview();
                    if (dragState.active && previewSet) applyResidueSelection(previewSet);
                    else applyResidueSelection(toggleItemPositions(startItem, dragState.initialPositions));
                    setAnchor(startItem);
                }

                setLocalPreview(null);
                dragState.active = false;
                dragState.startItem = null;
                dragState.endItemIndex = -1;
                dragState.endChainId = null;
                dragState.initialPositions = null;
                lastSequenceUpdateHash = null;
                scheduleRender();
            };

            return { moveTo, finish };
        };

        newCanvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            if (onScrollbar(pos)) e.preventDefault();
            const gesture = beginGesture(pos, e.shiftKey);
            if (!gesture) return;

            const handleMove = (ev) => {
                const buttons = ev.buttons !== undefined ? ev.buttons : (ev.which || 0);
                if (!(buttons & 1)) return;
                gesture.moveTo(getCanvasPositionFromMouse(ev, newCanvas));
            };
            const handleUp = (ev) => {
                window.removeEventListener('mousemove', handleMove);
                window.removeEventListener('mouseup', handleUp);
                gesture.finish(getCanvasPositionFromMouse(ev, newCanvas));
            };
            window.addEventListener('mousemove', handleMove);
            window.addEventListener('mouseup', handleUp);
        });

        // Whole chain on a double click. The two clicks underneath it have
        // already toggled the item on and back off, so the selection this
        // replaces is the one the user started with.
        newCanvas.addEventListener('dblclick', (e) => {
            const pos = getCanvasPositionFromMouse(e, newCanvas);
            if (onScrollbar(pos)) return;
            const item = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
            if (!item || item.type === 'chain') return;
            e.preventDefault();
            selectWholeChain(item, e.shiftKey);
        });

        // Double TAP is the same gesture. There is no dblclick on a phone, so
        // it is measured here: two taps close together in time and place.
        let lastTapAt = 0;
        let lastTapPos = null;
        const DOUBLE_TAP_MS = 320;
        const DOUBLE_TAP_PX = 24;

        newCanvas.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const pos = getCanvasPositionFromMouse(e.touches[0], newCanvas);

            const now = (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
            const isDoubleTap = lastTapPos
                && (now - lastTapAt) < DOUBLE_TAP_MS
                && Math.abs(pos.x - lastTapPos.x) < DOUBLE_TAP_PX
                && Math.abs(pos.y - lastTapPos.y) < DOUBLE_TAP_PX;
            lastTapAt = now;
            lastTapPos = pos;

            if (isDoubleTap && !onScrollbar(pos)) {
                const item = getSelectableItemAtPosition(pos.x, pos.y, layout, sequenceViewMode);
                if (item && item.type !== 'chain') {
                    e.preventDefault();
                    lastTapAt = 0;
                    lastTapPos = null;
                    selectWholeChain(item, false);
                    return;
                }
            }

            e.preventDefault();
            const gesture = beginGesture(pos, false);
            if (!gesture) return;

            const handleMove = (ev) => {
                if (ev.touches.length !== 1) return;
                ev.preventDefault();
                gesture.moveTo(getCanvasPositionFromMouse(ev.touches[0], newCanvas));
            };
            const handleEnd = (ev) => {
                ev.preventDefault();
                window.removeEventListener('touchmove', handleMove);
                window.removeEventListener('touchend', handleEnd);
                window.removeEventListener('touchcancel', handleEnd);
                const t = (ev.changedTouches && ev.changedTouches[0]) || null;
                gesture.finish(t ? getCanvasPositionFromMouse(t, newCanvas) : null);
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

        // Determine what's actually visible from the unified model or visiblePositions
        // Use previewSelectionSet during drag for live feedback
        let visiblePositions = new Set();

        const previewSelectionSet = getLocalPreview();

        if (previewSelectionSet && previewSelectionSet.size > 0) {
            // During drag, use preview selection for live feedback (already position indices)
            visiblePositions = new Set(previewSelectionSet);
        } else {
            // Use positions directly from selection model
            if (renderer.visibilityModel && renderer.visibilityModel.positions && renderer.visibilityModel.positions.size > 0) {
                visiblePositions = new Set(renderer.visibilityModel.positions);
            } else if (renderer.visiblePositions === null) {
                // null mask means all positions are visible (default mode)
                const n = renderer.coords ? renderer.coords.length : 0;
                for (let i = 0; i < n; i++) {
                    visiblePositions.add(i);
                }
            } else if (renderer.visiblePositions && renderer.visiblePositions.size > 0) {
                // Non-empty Set means some positions are visible
                visiblePositions = new Set(renderer.visiblePositions);
            }
        }

        // Create hash to detect if selection actually changed
        // Include previewSelectionSet in hash to ensure live feedback during drag
        const previewHash = previewSelectionSet ? previewSelectionSet.size : 0;
        const currentHash = visiblePositions.size + previewHash + (renderer?.visiblePositions === null ? 'all' : 'some');
        if (currentHash === lastSequenceUpdateHash && !previewSelectionSet) {
            return; // No change, skip update (unless we have preview selection for live feedback)
        }
        lastSequenceUpdateHash = currentHash;

        // Trigger canvas redraw
        scheduleRender();
    }

    // ============================================================================
    // HOVER
    // ============================================================================

    // Hand the renderer what is hovered; it paints it with the frame.
    function pushHover() {
        const renderer = callbacks.getRenderer ? callbacks.getRenderer() : null;
        if (!renderer || !renderer.setHover) return;
        const i = hoveredResidueInfo;
        renderer.setHover(hoverAtoms, i ? {
            lines: [`Chain: ${i.chain}`, `Residue: ${i.resName}`, `Index: ${i.resSeq}`],
        } : null);
    }

    function setHoverAtoms(atoms) {
        hoverAtoms = (atoms && atoms.size) ? atoms : null;
    }

    // ============================================================================
    // PUBLIC API
    // ============================================================================

    window.SEQ = {
        // Initialize callbacks
        setCallbacks: function (cb) {
            callbacks = Object.assign({}, callbacks, cb);
        },

        // Main functions
        buildView: buildSequenceView,
        buildViewDeferred: buildSequenceViewDeferred,
        updateColors: updateSequenceViewColors,
        updateSelection: updateSequenceViewSelectionState,

        // HOVERING THE 3D VIEW USES THE SAME READOUT as hovering the sequence -
        // one box, wherever the pointer is, rather than two that could drift
        // apart. The renderer calls this; this module owns the text, the
        // renderer draws it. Pass null to clear.
        setHoveredResidue: function (info) {
            hoveredResidueInfo = info || null;
            pushHover();
        },

        // WHICH POSITIONS ARE MARKED. The marks and the readout are set
        // separately - the strip sets marks while the 3D canvas sets the
        // readout - so each is its own call and neither clears the other.
        setHoverAtoms: function (atoms) {
            setHoverAtoms(atoms);
            pushHover();
        },

        // State management
        setMode: function (mode) {
            sequenceViewMode = mode;
        },

        getMode: function () {
            return sequenceViewMode;
        },

        // Clear state
        clear: function () {
            sequenceCanvasData = null;
            lastSequenceFrameIndex = -1;
            lastSequenceUpdateHash = null;
        },

        // Clear preview for current object
        clearPreview: function () {
            setLocalPreview(null);
            lastSequenceUpdateHash = null;
            scheduleRender();
        }
    };

})();
