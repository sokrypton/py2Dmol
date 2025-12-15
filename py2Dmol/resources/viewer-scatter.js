// ============================================================================
// web/viewer-scatter.js
// -------------------------------
// AI Context: SCATTER PLOT VISUALIZATION
// - Renders scatter plots with frame-based data (RMSD, energy, PCA, etc.)
// - Highlights current frame during animation
// - Allows clicking points to jump to frames
// - Supports CSV upload with custom axis labels
// ============================================================================

(function () {
    'use strict';

    // ============================================================================
    // SCATTER PLOT VIEWER CLASS
    // ============================================================================
    class ScatterPlotViewer {
        constructor(canvas, mainRenderer) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d', { alpha: true });
            this.mainRenderer = mainRenderer; // Reference to Pseudo3DRenderer

            // Scale factor for high-DPI rendering
            this.scale = this.canvas.width / parseFloat(getComputedStyle(this.canvas).width);

            this.xData = null;  // Array of x values (one per frame)
            this.yData = null;  // Array of y values (one per frame)
            this.xLabel = 'X';  // X-axis label
            this.yLabel = 'Y';  // Y-axis label

            this.xMin = 0;
            this.xMax = 1;
            this.yMin = 0;
            this.yMax = 1;

            // Padding for axis labels (scaled)
            this.paddingLeft = 55 * this.scale;   // Y-axis labels and ticks
            this.paddingRight = 20 * this.scale;  // Prevent label cutoff
            this.paddingTop = 16 * this.scale;    // Prevent label cutoff
            this.paddingBottom = 60 * this.scale; // X-axis labels and ticks
            this.plotWidth = 0;
            this.plotHeight = 0;

            this.hoveredIndex = -1; // Index of hovered point
            this.currentFrameIndex = -1; // Currently displayed frame

            this.setupInteraction();

            // Listen for frame changes from main viewer
            if (typeof document !== 'undefined') {
                this.frameChangeHandler = (e) => {
                    if (e.detail && e.detail.frameIndex !== undefined) {
                        this.currentFrameIndex = e.detail.frameIndex;
                        this.render();
                    }
                };
                document.addEventListener('py2dmol-frame-change', this.frameChangeHandler);
            }
        }

        setData(xData, yData, xLabel = 'X', yLabel = 'Y') {
            this.xData = xData;
            this.yData = yData;
            this.xLabel = xLabel;
            this.yLabel = yLabel;

            if (!xData || !yData || xData.length === 0 || yData.length === 0) {
                this.xMin = 0;
                this.xMax = 1;
                this.yMin = 0;
                this.yMax = 1;
                return;
            }

            // Calculate data ranges with 5% padding
            this.xMin = Math.min(...xData);
            this.xMax = Math.max(...xData);
            this.yMin = Math.min(...yData);
            this.yMax = Math.max(...yData);

            const xRange = this.xMax - this.xMin;
            const yRange = this.yMax - this.yMin;

            // Add 5% padding on each side
            if (xRange > 0) {
                this.xMin -= xRange * 0.05;
                this.xMax += xRange * 0.05;
            } else {
                this.xMin -= 0.5;
                this.xMax += 0.5;
            }

            if (yRange > 0) {
                this.yMin -= yRange * 0.05;
                this.yMax += yRange * 0.05;
            } else {
                this.yMin -= 0.5;
                this.yMax += 0.5;
            }

            // Initialize at frame 0
            this.currentFrameIndex = 0;

            this.render(true); // Force recalculation when data changes
        }

        addPoint(x, y) {
            // Add a new point to the scatter plot (for dynamic frame addition)
            if (!this.xData || !this.yData) {
                this.xData = [];
                this.yData = [];
            }

            this.xData.push(x);
            this.yData.push(y);

            // Update ranges if needed
            if (this.xData.length === 1) {
                // First point - initialize ranges with padding
                this.xMin = x - 0.5;
                this.xMax = x + 0.5;
                this.yMin = y - 0.5;
                this.yMax = y + 0.5;
            } else {
                // Check if new point is outside current range
                const needsUpdate = x < this.xMin || x > this.xMax || y < this.yMin || y > this.yMax;

                if (needsUpdate) {
                    // Recalculate ranges from all data
                    const xMin = Math.min(...this.xData);
                    const xMax = Math.max(...this.xData);
                    const yMin = Math.min(...this.yData);
                    const yMax = Math.max(...this.yData);

                    const xRange = xMax - xMin;
                    const yRange = yMax - yMin;

                    // Add 5% padding on each side
                    if (xRange > 0) {
                        this.xMin = xMin - xRange * 0.05;
                        this.xMax = xMax + xRange * 0.05;
                    } else {
                        this.xMin = xMin - 0.5;
                        this.xMax = xMax + 0.5;
                    }

                    if (yRange > 0) {
                        this.yMin = yMin - yRange * 0.05;
                        this.yMax = yMax + yRange * 0.05;
                    } else {
                        this.yMin = yMin - 0.5;
                        this.yMax = yMax + 0.5;
                    }
                }
            }

            this.render(true); // Force recalculation when adding points (data changed)
        }

        // Convert data coordinates to canvas coordinates
        dataToCanvas(x, y) {
            const canvasX = this.paddingLeft + ((x - this.xMin) / (this.xMax - this.xMin)) * this.plotWidth;
            const canvasY = this.canvas.height - this.paddingBottom - ((y - this.yMin) / (this.yMax - this.yMin)) * this.plotHeight;
            return { x: canvasX, y: canvasY };
        }

        // Convert canvas coordinates to data coordinates
        canvasToData(canvasX, canvasY) {
            const x = this.xMin + ((canvasX - this.paddingLeft) / this.plotWidth) * (this.xMax - this.xMin);
            const y = this.yMin + ((this.canvas.height - this.paddingBottom - canvasY) / this.plotHeight) * (this.yMax - this.yMin);
            return { x, y };
        }

        // Find nearest point to mouse position
        findNearestPoint(mouseX, mouseY) {
            if (!this.xData || !this.yData || this.xData.length === 0) return -1;

            let minDist = Infinity;
            let nearestIndex = -1;
            const threshold = 12 * this.sizeUnit; // pixels (scaled with canvas)

            for (let i = 0; i < this.xData.length; i++) {
                const pos = this.dataToCanvas(this.xData[i], this.yData[i]);
                const dx = pos.x - mouseX;
                const dy = pos.y - mouseY;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < minDist && dist < threshold) {
                    minDist = dist;
                    nearestIndex = i;
                }
            }

            return nearestIndex;
        }

        getMousePos(e) {
            const rect = this.canvas.getBoundingClientRect();
            const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
            const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);

            return {
                x: (clientX - rect.left) * this.scale,
                y: (clientY - rect.top) * this.scale
            };
        }

        setupInteraction() {
            // Mouse move for hover
            this.canvas.addEventListener('mousemove', (e) => {
                const { x, y } = this.getMousePos(e);
                const nearestIndex = this.findNearestPoint(x, y);

                if (nearestIndex !== this.hoveredIndex) {
                    this.hoveredIndex = nearestIndex;
                    this.render();

                    // Update cursor
                    this.canvas.style.cursor = nearestIndex >= 0 ? 'pointer' : 'default';
                }
            });

            // Mouse leave
            this.canvas.addEventListener('mouseleave', () => {
                if (this.hoveredIndex >= 0) {
                    this.hoveredIndex = -1;
                    this.render();
                }
                this.canvas.style.cursor = 'default';
            });

            // Click to jump to frame
            this.canvas.addEventListener('click', (e) => {
                const { x, y } = this.getMousePos(e);
                const nearestIndex = this.findNearestPoint(x, y);

                if (nearestIndex >= 0 && this.mainRenderer) {
                    // Jump to this frame in the main viewer
                    this.mainRenderer.setFrame(nearestIndex);
                }
            });
        }

        // Compute a responsive unit that scales with CSS size and DPI
        getSizeUnit() {
            const rect = this.canvas.getBoundingClientRect
                ? this.canvas.getBoundingClientRect()
                : { width: this.canvas.width / this.scale, height: this.canvas.height / this.scale };
            const cssMin = Math.max(Math.min(rect.width, rect.height), 60); // guard very small
            const base = cssMin / 320; // grow with canvas CSS size
            const clamped = Math.min(Math.max(base, 0.7), 1.6); // avoid extremes
            return this.scale * clamped;
        }

        render(forceRecalculate = false) {
            const ctx = this.ctx;
            const width = this.canvas.width;
            const height = this.canvas.height;

            // Responsive sizing (only recalculate if forced or not yet calculated)
            if (forceRecalculate || this.sizeUnit === undefined) {
                this.sizeUnit = this.getSizeUnit();
            }

            // Precompute ticks for layout metrics
            const tickFont = 12 * this.sizeUnit;
            const labelFont = 16 * this.sizeUnit;
            const xTicks = this.getNiceTicks(this.xMin, this.xMax, 5);
            const yTicks = this.getNiceTicks(this.yMin, this.yMax, 5);

            // Update paddings based on actual text metrics to avoid overlaps (only if forced or not yet calculated)
            if (forceRecalculate || this.plotWidth === undefined) {
                this.computeDynamicPadding(ctx, this.sizeUnit, tickFont, labelFont, xTicks, yTicks);
                this.plotWidth = width - this.paddingLeft - this.paddingRight;
                this.plotHeight = height - this.paddingTop - this.paddingBottom;
            }

            // Recalculate plot dimensions if not done above
            if (!forceRecalculate && this.plotWidth !== undefined) {
                this.plotWidth = width - this.paddingLeft - this.paddingRight;
                this.plotHeight = height - this.paddingTop - this.paddingBottom;
            }

            // Clear canvas
            ctx.clearRect(0, 0, width, height);

            // Draw background
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);

            // Draw axes
            this.drawAxes(xTicks, yTicks, this.sizeUnit, tickFont, labelFont);

            // Draw data points
            if (this.xData && this.yData && this.xData.length > 0) {
                this.drawPoints();
            }
        }

        computeDynamicPadding(ctx, sizeUnit, tickFont, labelFont, xTicks, yTicks) {
            const measureHeight = (text, fallbackSize) => {
                const metrics = ctx.measureText(text);
                const ascent = metrics.actualBoundingBoxAscent || fallbackSize * 0.7;
                const descent = metrics.actualBoundingBoxDescent || fallbackSize * 0.3;
                return {
                    width: metrics.width,
                    height: ascent + descent
                };
            };

            const tickMarkLen = 4 * sizeUnit;
            const tickLabelGap = 4 * sizeUnit;
            const labelGap = 8 * sizeUnit;
            const minPadding = 10 * sizeUnit;

            ctx.save();
            ctx.font = `${tickFont}px sans-serif`;

            // Measure tick labels
            const formatTick = (value) => this.formatTickNumber(value);
            const xTickLabels = xTicks.map(formatTick);
            const yTickLabels = yTicks.map(formatTick);

            const xTickHeight = measureHeight('0', tickFont).height;
            const maxXTickWidth = xTickLabels.length > 0 ? Math.max(...xTickLabels.map(l => measureHeight(l, tickFont).width)) : tickFont;
            const maxYTickWidth = yTickLabels.length > 0 ? Math.max(...yTickLabels.map(l => measureHeight(l, tickFont).width)) : tickFont;

            ctx.font = `${labelFont}px sans-serif`;
            const xLabelMetrics = measureHeight(this.xLabel || 'X', labelFont);
            const yLabelMetrics = measureHeight(this.yLabel || 'Y', labelFont);

            // Store metrics for later placement
            this.textMetrics = {
                tickMarkLen,
                tickLabelGap,
                labelGap,
                xTickHeight,
                maxXTickWidth,
                maxYTickWidth,
                xLabelHeight: xLabelMetrics.height,
                yLabelWidth: yLabelMetrics.width,
                yLabelHeight: yLabelMetrics.height
            };

            // Padding calculations to prevent overlaps/cutoffs
            this.paddingBottom = Math.max(
                tickMarkLen + tickLabelGap + xTickHeight + labelGap + xLabelMetrics.height,
                30 * this.scale
            );
            // For rotated Y label, its height is the horizontal extent after rotation
            const yLabelHorizontal = yLabelMetrics.height;
            this.paddingLeft = Math.max(
                tickMarkLen + tickLabelGap + maxYTickWidth + labelGap + yLabelHorizontal,
                40 * this.scale
            );
            this.paddingRight = Math.max(
                minPadding + tickMarkLen + tickLabelGap + maxXTickWidth / 2,
                20 * this.scale
            );
            this.paddingTop = Math.max(
                minPadding + xTickHeight / 2,
                16 * this.scale
            );

            ctx.restore();
        }

        drawAxes(xTicks, yTicks, sizeUnit, tickFont, labelFont) {
            const ctx = this.ctx;
            const width = this.canvas.width;
            const height = this.canvas.height;

            // Fallback if metrics are missing
            const metrics = this.textMetrics || {
                tickMarkLen: 4 * sizeUnit,
                tickLabelGap: 4 * sizeUnit,
                labelGap: 8 * sizeUnit,
                xTickHeight: tickFont,
                xLabelHeight: labelFont,
                yLabelWidth: labelFont,
                maxYTickWidth: tickFont
            };

            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2 * this.scale;
            ctx.fillStyle = '#333';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `${tickFont}px sans-serif`;

            // X-axis
            ctx.beginPath();
            ctx.moveTo(this.paddingLeft, height - this.paddingBottom);
            ctx.lineTo(width - this.paddingRight, height - this.paddingBottom);
            ctx.stroke();

            // Y-axis
            ctx.beginPath();
            ctx.moveTo(this.paddingLeft, this.paddingTop);
            ctx.lineTo(this.paddingLeft, height - this.paddingBottom);
            ctx.stroke();

            // X-axis label (positioned relative to bottom padding)
            ctx.font = `${labelFont}px sans-serif`;
            const xLabelY = height - this.paddingBottom +
                metrics.tickMarkLen +
                metrics.tickLabelGap +
                metrics.xTickHeight +
                metrics.labelGap +
                (metrics.xLabelHeight || labelFont) / 2;
            ctx.fillText(this.xLabel, this.paddingLeft + this.plotWidth / 2, xLabelY);

            // Y-axis label (rotated, positioned relative to left padding)
            ctx.save();
            const yLabelOffset = metrics.tickMarkLen + metrics.tickLabelGap + metrics.maxYTickWidth + metrics.labelGap;
            ctx.translate(this.paddingLeft - yLabelOffset, this.paddingTop + this.plotHeight / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(this.yLabel, 0, 0);
            ctx.restore();

            // Draw tick marks and labels
            this.drawTicks(xTicks, yTicks, sizeUnit, tickFont);
        }

        // Generate nice tick values (round numbers)
        getNiceTicks(min, max, targetCount = 5) {
            const range = max - min;
            if (range === 0) return [min];

            const roughStep = range / targetCount;

            // Calculate order of magnitude
            const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
            const normalizedStep = roughStep / magnitude;

            // Round to nice step (1, 2, 5)
            let niceStep;
            if (normalizedStep <= 1) {
                niceStep = 1;
            } else if (normalizedStep <= 2) {
                niceStep = 2;
            } else if (normalizedStep <= 5) {
                niceStep = 5;
            } else {
                niceStep = 10;
            }

            const step = niceStep * magnitude;

            // Generate tick values using index-based approach to avoid floating point errors
            const startIndex = Math.ceil(min / step);
            const endIndex = Math.floor(max / step);
            const ticks = [];

            for (let i = startIndex; i <= endIndex; i++) {
                ticks.push(i * step);
            }

            return ticks;
        }

        formatTickNumber(value) {
            // Handle zero
            if (value === 0) return '0';

            const absValue = Math.abs(value);
            let formatted;

            // Use K/M notation for large numbers
            if (absValue >= 1000000) {
                formatted = (value / 1000000).toFixed(1).replace(/\.?0+$/, '') + 'M';
            } else if (absValue >= 1000) {
                formatted = (value / 1000).toFixed(1).replace(/\.?0+$/, '') + 'k';
            } else if (absValue >= 100) {
                formatted = value.toFixed(0);
            } else if (absValue >= 1) {
                formatted = value.toFixed(1).replace(/\.?0+$/, '');
            } else if (absValue >= 0.01) {
                formatted = value.toFixed(2).replace(/\.?0+$/, '');
            } else {
                formatted = value.toFixed(3).replace(/\.?0+$/, '');
            }

            return formatted;
        }

        drawTicks(xTicks, yTicks, sizeUnit, tickFont) {
            const ctx = this.ctx;
            const height = this.canvas.height;

            ctx.font = `${tickFont}px sans-serif`;
            ctx.fillStyle = '#666';
            ctx.strokeStyle = '#999';
            ctx.lineWidth = 1 * sizeUnit;

            // X-axis ticks
            for (const x of xTicks) {
                const pos = this.dataToCanvas(x, this.yMin);

                // Tick mark
                ctx.beginPath();
                ctx.moveTo(pos.x, height - this.paddingBottom);
                ctx.lineTo(pos.x, height - this.paddingBottom + 4 * sizeUnit);
                ctx.stroke();

                // Label
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(this.formatTickNumber(x), pos.x, height - this.paddingBottom + 6 * sizeUnit);
            }

            // Y-axis ticks
            for (const y of yTicks) {
                const pos = this.dataToCanvas(this.xMin, y);

                // Tick mark
                ctx.beginPath();
                ctx.moveTo(this.paddingLeft - 4 * sizeUnit, pos.y);
                ctx.lineTo(this.paddingLeft, pos.y);
                ctx.stroke();

                // Label
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(this.formatTickNumber(y), this.paddingLeft - 6 * sizeUnit, pos.y);
            }
        }

        drawPoints() {
            const ctx = this.ctx;
            const radius = 4 * this.sizeUnit; // Same size for all dots

            // Helper function to draw a single point
            const drawPoint = (i, fillColor) => {
                const pos = this.dataToCanvas(this.xData[i], this.yData[i]);
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, radius, 0, 2 * Math.PI);
                ctx.fillStyle = fillColor;
                ctx.fill();
            };

            // First pass: draw all normal points in reverse order (later dots under earlier dots)
            for (let i = this.xData.length - 1; i >= 0; i--) {
                const isCurrentFrame = (i === this.currentFrameIndex);
                const isHovered = (i === this.hoveredIndex);

                // Skip if this will be drawn on top later
                if (isCurrentFrame || isHovered) continue;

                // Determine color based on position relative to current frame
                let color;
                if (this.currentFrameIndex >= 0 && i > this.currentFrameIndex) {
                    color = '#bfdbfe'; // Light blue for future dots
                } else {
                    color = '#3b82f6'; // Normal blue for past/current dots
                }

                drawPoint(i, color);
            }

            // Second pass: draw hovered point on top
            if (this.hoveredIndex >= 0 && this.hoveredIndex !== this.currentFrameIndex) {
                drawPoint(this.hoveredIndex, '#60a5fa'); // Light blue highlight
            }

            // Third pass: draw current frame point on top (highest priority)
            if (this.currentFrameIndex >= 0) {
                const pos = this.dataToCanvas(this.xData[this.currentFrameIndex], this.yData[this.currentFrameIndex]);
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, radius, 0, 2 * Math.PI);
                ctx.fillStyle = '#fbbf24'; // Yellow/gold fill
                ctx.fill();
                ctx.strokeStyle = '#f59e0b'; // Darker yellow/orange outline
                ctx.lineWidth = 2 * this.scale;
                ctx.stroke();
            }
        }

        destroy() {
            if (this.frameChangeHandler) {
                document.removeEventListener('py2dmol-frame-change', this.frameChangeHandler);
            }
        }
    }

    // ============================================================================
    // EXPORT
    // ============================================================================
    // Export to global scope
    window.ScatterPlotViewer = ScatterPlotViewer;

    // Dispatch load event for initialization
    if (typeof document !== 'undefined') {
        document.dispatchEvent(new Event('py2dmol_scatter_loaded'));
    }

})();
