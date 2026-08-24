// ============================================================================
// src/app/scatter.js
// ------------------
// AI Context: THE SCATTER PANEL'S DATA
// - Parsing a CSV of per-residue values and handing it to the scatter viewer.
// ============================================================================
// ============================================================================
// SCATTER PLOT HANDLING
// ============================================================================

function parseAndLoadScatterData(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
        throw new Error("CSV must have at least a header row and one data row");
    }

    // Parse header (first row)
    const header = lines[0].split(',').map(h => h.trim());
    if (header.length < 2) {
        throw new Error("CSV must have at least 2 columns");
    }

    const xLabel = header[0];
    const yLabel = header[1];

    // Parse data rows
    const xData = [];
    const yData = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        if (values.length < 2) continue;

        const x = parseFloat(values[0]);
        const y = parseFloat(values[1]);

        if (!isNaN(x) && !isNaN(y)) {
            xData.push(x);
            yData.push(y);
        }
    }

    if (xData.length === 0) {
        throw new Error("No valid data points found in CSV");
    }

    // Create or update scatter viewer
    const scatterCanvas = document.getElementById('scatterCanvas');
    if (!scatterCanvas) {
        throw new Error("Scatter canvas not found");
    }
    const scatterContainer = document.getElementById('scatterContainer');

    // Apply sizing consistent with viewer-mol scatter setup and attach ResizeObserver
    const scatterDisplaySize = (window.viewerConfig?.scatter?.size) || 300;
    const currentDPR = Math.min(window.devicePixelRatio || 1, 1.5);
    const scatterDPR = Math.max(2, currentDPR * 2);
    const showBox = window.viewerConfig?.display?.box !== false;

    const applyScatterSize = (w, h) => {
        const borderAdjust = 2; // account for 1px border on container
        const innerW = Math.max(10, w - borderAdjust);
        const innerH = Math.max(10, h - borderAdjust);
        scatterCanvas.width = innerW * scatterDPR;
        scatterCanvas.height = innerH * scatterDPR;
        scatterCanvas.style.width = `${innerW}px`;
        scatterCanvas.style.height = `${innerH}px`;
        if (scatterViewer) {
            scatterViewer.render();
        }
    };

    applyScatterSize(scatterDisplaySize, scatterDisplaySize);

    if (scatterContainer) {
        scatterContainer.style.width = `${scatterDisplaySize}px`;
        scatterContainer.style.height = `${scatterDisplaySize}px`;
        scatterContainer.style.padding = '0px';
        scatterContainer.style.display = 'flex';
        scatterContainer.classList.add('scatter-container');
        if (!showBox) {
            scatterContainer.classList.add('box-off');
        } else {
            scatterContainer.classList.remove('box-off');
        }

        if (window.ResizeObserver && !scatterContainer._scatterResizeObserver) {
            let lastW = scatterDisplaySize;
            let lastH = scatterDisplaySize;
            const observer = new ResizeObserver(entries => {
                if (!entries || entries.length === 0) return;
                const rect = entries[0].contentRect || {};
                const newW = Math.max(rect.width || scatterDisplaySize, 1);
                const newH = Math.max(rect.height || scatterDisplaySize, 1);
                if (Math.abs(newW - lastW) < 0.5 && Math.abs(newH - lastH) < 0.5) return;
                lastW = newW;
                lastH = newH;
                applyScatterSize(newW, newH);
            });
            observer.observe(scatterContainer);
            scatterContainer._scatterResizeObserver = observer;
        }
    }

    if (!scatterViewer && viewerApi?.renderer) {
        scatterViewer = new ScatterPlotViewer(scatterCanvas, viewerApi.renderer);
        // CRITICAL: Register scatter renderer with main renderer for recording
        viewerApi.renderer.setScatterRenderer(scatterViewer);
    }

    if (scatterViewer) {
        scatterViewer.setData(xData, yData, xLabel, yLabel);
        scatterCanvas.style.display = 'block';

        // Show scatter container if hidden
        if (scatterContainer) {
            scatterContainer.style.display = 'block';
        }

        // IMPORTANT: Store scatter data in frames (matching Python interface)
        // This ensures scatter data is saved when saving state
        if (viewerApi?.renderer?.currentObjectName) {
            const currentObj = viewerApi.renderer.objectsData[viewerApi.renderer.currentObjectName];
            if (currentObj && currentObj.frames) {
                // Store scatter data in each frame as [x, y]
                for (let i = 0; i < currentObj.frames.length && i < xData.length; i++) {
                    currentObj.frames[i].scatter = [xData[i], yData[i]];
                }

                // Store scatter labels in object-specific config (camelCase)
                if (!currentObj.scatterConfig) {
                    currentObj.scatterConfig = {};
                }
                currentObj.scatterConfig.xlabel = xLabel;
                currentObj.scatterConfig.ylabel = yLabel;

                // Immediately refresh scatter plot with stored metadata/data
                if (viewerApi.renderer.scatterRenderer) {
                    viewerApi.renderer.updateScatterData(viewerApi.renderer.currentObjectName);
                }
            } else {
                console.warn('[SCATTER CSV] Cannot store - currentObj or frames missing:', {
                    currentObj: !!currentObj,
                    frames: currentObj?.frames?.length
                });
            }
        }

        // Note: Scatter visibility is now controlled per-object based on actual data
        // No need to set global scatter.enabled = true here
    }
}

