// ============================================================================
// src/parts/ui.js
// -----------------------------
// AI Context: WIRING ONE VIEWER TO ITS CONTAINER (wireViewerUI)
// - Everything after the class is built: find the canvas, size it for the
//   device pixel ratio, create the renderer, hang every control in the
//   container off it, load whatever data the page arrived with, and publish
//   the public API on window.py2dmol_viewers.
// - Also the live-update channels the notebook drives: the DOM mailbox its
//   MutationObserver watches, the BroadcastChannel for cross-cell updates, and
//   the incremental/replace-frame handlers.
// - NOT a part file. These are not class methods; it is the procedural
//   bootstrap that runs once per viewer, so it is a plain function that
//   initializePy2DmolViewer calls.
// ============================================================================
// viewerId is ASSIGNED here (`viewerId = resolvedViewerId`). As a parameter
// that assignment is local, which is what it always effectively was: this block
// ran last in the factory and nothing read the outer binding afterwards.
// THE PER-FRAME FIELDS THE STATIC PAYLOAD CARRIES, and which of them an OBJECT
// can answer for when a frame does not.
//
// viewer.py holds the other half of this list, as FRAME_INHERITED and
// FRAME_ALWAYS, and tests/config.js checks the two still name the same things.
// They did not, three times: `align`, `allow_reflection`, `position_atoms` and
// `position_elements` were each sent by Python and dropped here, and every one
// of them was a feature that quietly did not happen - a trajectory that never
// superposed, and element colouring that never coloured. Adding a field is
// adding a row here and a name there.
//
// `coords` is not in the list because it is not optional; it is set first and
// a frame without it never reaches this loop.
const STATIC_FRAME_FIELDS = [
    ['chains', 'chains'],
    ['position_types', 'position_types'],
    ['bonds', 'bonds'],
    ['plddts', null],
    ['pae', null],
    ['position_names', null],
    ['residue_numbers', null],
    ['position_atoms', null],
    ['position_elements', null],
    ['color', null],
    ['scatter', null],
    ['align', null],
    ['allow_reflection', null],
];

function wireViewerUI(containerElement, viewerId, Pseudo3DRenderer) {
// ============================================================================
// PAE RENDERER
// ============================================================================
// PAERenderer class moved to panels/pae.js
// Use window.PAERenderer if available (loaded from panels/pae.js)

// ============================================================================
// MAIN APP & COLAB COMMUNICATION
// ============================================================================

// 1. Get config - check viewer-specific config first (Python), then global (web app)
const baseConfig = window.viewerConfig || {};
const initialViewerId = viewerId || baseConfig.viewer_id || containerElement?.id || null;
const registryConfig = initialViewerId && window.py2dmol_configs ? window.py2dmol_configs[initialViewerId] : null;
const config = normalizeConfig(registryConfig || baseConfig);

// Resolve viewerId even when caller omits the second argument (standalone web app)
const resolvedViewerId = viewerId
    || config.viewer_id
    || containerElement?.id
    || `py2dmol_${Math.random().toString(36).slice(2, 10)}`;
config.viewer_id = resolvedViewerId;
viewerId = resolvedViewerId;

// Persist normalized config for any downstream consumers
window.viewerConfig = config;

// 2. The canvas, sized for this display - and 3. the renderer that draws on
// it. The sizing lives in parts/viewport.js because the embed needs exactly
// that much and none of the panel below.
const viewport = setupViewport(containerElement, config);
if (!viewport) return;
const { canvas, ctx, dpr: currentDPR, width: displayWidth, height: displayHeight } = viewport;

const renderer = new Pseudo3DRenderer(canvas, config);
renderer.viewerId = viewerId;  // Store viewerId for config access
viewport.attach(renderer);

// THE STYLE PANEL IS BUILT, NOT WRITTEN OUT - and built HERE, before anything
// below reaches for a control inside it. Both pages used to carry the same two
// hundred lines of markup under a note saying to edit both, and had already
// drifted apart; parts/panel.js is the one copy now.
//
// The order matters and cost an hour: inserting it further down, next to the
// Style button that opens it, left `colorSelect` null two hundred lines earlier
// and wireViewerUI died on an unguarded addEventListener - reported as
// "Failed to initialize viewer" with no viewer and no clue.
//
// A page that still ships its own panel keeps it, so a hand-made shell is safe.
// WHERE IT GOES IS THE PAGE'S BUSINESS, and it says so with an empty
// #stylePanelMount. Deriving the spot from the Style button does not work: the
// two pages put that button in different containers - a .btn-row grid in one, a
// .toolbar-row flex in the other - so the panel landed inside a toolbar and
// rendered 111px wide with zero-width sliders.
if (!containerElement.querySelector('#stylePanel') && window.py2dmolPanel) {
    const mount = containerElement.querySelector('#stylePanelMount');
    if (mount) mount.appendChild(window.py2dmolPanel.buildStylePanel());
}

// 4. Setup PAE Renderer (if enabled)
// 4. Setup PAE Renderer (if enabled)
if (config.pae?.enabled) {
    // Initialize immediately if PAE script is loaded
    const initPAE = () => {
        if (window.PAE && window.PAE.initialize) {
            window.PAE.initialize(renderer, containerElement, config);
        }
    };

    if (window.PAE) {
        initPAE();
    } else {
        // Wait for script
        window.addEventListener('py2dmol_pae_loaded', initPAE, { once: true });
    }
}

// Initialize scatter plot if enabled
if (config.scatter && config.scatter.enabled) {
    try {
        const scatterContainer = containerElement.querySelector('#scatterContainer');
        const scatterCanvas = containerElement.querySelector('#scatterCanvas');

        if (scatterContainer && scatterCanvas) {
            // Apply size using the same pattern as the main viewer
            const scatterDisplaySize = config.scatter?.size || config.scatter_size || 300;
            const scatterDPR = Math.max(2, currentDPR * 2); // keep sharper DPI but mirror naming
            const showBox = config.display?.box !== false;

            // Intrinsic size (DPI scaled) + CSS size (display pixels)
            const borderAdjust = 2; // 1px border on each side
            const cssScatterSize = Math.max(10, scatterDisplaySize - borderAdjust);
            scatterCanvas.width = cssScatterSize * scatterDPR;
            scatterCanvas.height = cssScatterSize * scatterDPR;
            scatterCanvas.style.width = `${cssScatterSize}px`;
            scatterCanvas.style.height = `${cssScatterSize}px`;
            scatterCanvas.style.margin = '0px';

            // Container sizing mirrors main viewer containers
            scatterContainer.style.display = 'flex';
            scatterContainer.style.width = `${scatterDisplaySize}px`;
            scatterContainer.style.height = `${scatterDisplaySize}px`;
            scatterContainer.style.padding = '0px';

            // Box styling via CSS classes (kept unchanged)
            scatterContainer.classList.toggle('scatter-container', true);
            scatterContainer.classList.toggle('box-off', !showBox);

            // Mirror main viewer: observe container resizes and resize canvas accordingly
            if (scatterContainer && window.ResizeObserver) {
                let lastWidth = scatterDisplaySize;
                let lastHeight = scatterDisplaySize;
                const resizeObserver = new ResizeObserver(entries => {
                    if (!entries || entries.length === 0) return;
                    const rect = entries[0].contentRect || {};
                    const newWidth = Math.max(rect.width || scatterDisplaySize, 1);
                    const newHeight = Math.max(rect.height || scatterDisplaySize, 1);

                    if (Math.abs(newWidth - lastWidth) < 0.5 && Math.abs(newHeight - lastHeight) < 0.5) {
                        return;
                    }
                    lastWidth = newWidth;
                    lastHeight = newHeight;

                    const innerW = Math.max(10, newWidth - borderAdjust);
                    const innerH = Math.max(10, newHeight - borderAdjust);
                    scatterCanvas.width = innerW * scatterDPR;
                    scatterCanvas.height = innerH * scatterDPR;
                    scatterCanvas.style.width = `${innerW}px`;
                    scatterCanvas.style.height = `${innerH}px`;

                    if (renderer.scatterRenderer) {
                        renderer.scatterRenderer.render();
                    }
                });
                resizeObserver.observe(scatterContainer);
            } else if (!window.ResizeObserver) {
                console.warn("py2dmol: ResizeObserver not supported. Scatter resizing will not work.");
            }

            // Function to initialize scatter renderer
            const initializeScatterRenderer = () => {
                if (!window.ScatterPlotViewer) {
                    return;
                }

                const scatterRenderer = new window.ScatterPlotViewer(scatterCanvas, renderer);
                renderer.setScatterRenderer(scatterRenderer);

                // Initialize with empty data (labels will be set when object metadata is available)
                scatterRenderer.setData([], [], 'X', 'Y');

                // Apply scatter_config from current object if it exists
                if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                    const obj = renderer.objectsData[renderer.currentObjectName];
                    if (obj.scatterConfig) {
                        const cfg = obj.scatterConfig;
                        const xlabel = cfg.xlabel || 'X';
                        const ylabel = cfg.ylabel || 'Y';
                        scatterRenderer.setData([], [], xlabel, ylabel);

                        // Apply limits if provided
                        if (cfg.xlim && Array.isArray(cfg.xlim) && cfg.xlim.length === 2) {
                            scatterRenderer.xMin = cfg.xlim[0];
                            scatterRenderer.xMax = cfg.xlim[1];
                        }
                        if (cfg.ylim && Array.isArray(cfg.ylim) && cfg.ylim.length === 2) {
                            scatterRenderer.yMin = cfg.ylim[0];
                            scatterRenderer.yMax = cfg.ylim[1];
                        }
                        scatterRenderer.render(true);
                    }
                }

                // Collect scatter data from ALL frames in current object
                if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                    const object = renderer.objectsData[renderer.currentObjectName];
                    const frames = object.frames || [];

                    // Get labels from object metadata
                    const cfg = object.scatterConfig || {};
                    const xlabel = cfg.xlabel || 'X';
                    const ylabel = cfg.ylabel || 'Y';
                    const xlim = cfg.xlim || null;
                    const ylim = cfg.ylim || null;


                    if (frames.length > 0) {
                        const xData = [];
                        const yData = [];

                        // Iterate through all frames to collect scatter points
                        let lastScatter = null;
                        for (let i = 0; i < frames.length; i++) {
                            const frame = frames[i];

                            // Resolve scatter with inheritance (like plddts, chains)
                            const scatterPoint = frame.scatter !== undefined ? frame.scatter : lastScatter;

                            if (scatterPoint && Array.isArray(scatterPoint) && scatterPoint.length === 2) {
                                xData.push(scatterPoint[0]);
                                yData.push(scatterPoint[1]);
                                lastScatter = scatterPoint;
                            } else {
                                // Frame has no scatter point - use NaN for gap
                                xData.push(NaN);
                                yData.push(NaN);
                            }
                        }

                        // Set accumulated data to scatter renderer
                        if (xData.length > 0) {
                            scatterRenderer.setData(xData, yData, xlabel, ylabel);

                            // Apply limits if provided
                            if (xlim && Array.isArray(xlim) && xlim.length === 2) {
                                scatterRenderer.xMin = xlim[0];
                                scatterRenderer.xMax = xlim[1];
                            }
                            if (ylim && Array.isArray(ylim) && ylim.length === 2) {
                                scatterRenderer.yMin = ylim[0];
                                scatterRenderer.yMax = ylim[1];
                            }

                            scatterRenderer.render();

                            // Show scatter container
                            scatterContainer.style.display = 'flex';
                        }
                    } else {
                        // No frames yet, but apply labels if scatter_config exists
                        scatterRenderer.setData([], [], xlabel, ylabel);

                        // Apply limits if provided
                        if (xlim && Array.isArray(xlim) && xlim.length === 2) {
                            scatterRenderer.xMin = xlim[0];
                            scatterRenderer.xMax = xlim[1];
                        }
                        if (ylim && Array.isArray(ylim) && ylim.length === 2) {
                            scatterRenderer.yMin = ylim[0];
                            scatterRenderer.yMax = ylim[1];
                        }

                        scatterRenderer.render(true);
                    }
                }
            };

            // Try to initialize immediately (offline mode) or wait for scatter script load event
            requestAnimationFrame(() => {
                if (window.ScatterPlotViewer) {
                    initializeScatterRenderer();
                } else {
                    // Wait for scatter script to load (online mode).
                    // ON `document`, WHICH IS WHERE IT IS SENT. panels/scatter.js
                    // does document.dispatchEvent(new Event(...)) and a bare
                    // Event does not bubble, so a window listener never heard
                    // it. Load order has masked this: the panel is in the
                    // bundle, so ScatterPlotViewer is already there and the
                    // branch above is the one that runs. It stops being masked
                    // the moment the panel arrives any other way.
                    document.addEventListener('py2dmol_scatter_loaded', initializeScatterRenderer, { once: true });
                }
            });
        }
    } catch (e) {
        console.error("Failed to initialize scatter renderer:", e);
    }
}

// 5. Setup general controls
const colorSelect = containerElement.querySelector('#colorSelect');

// Initialize color mode
let validModes = getAllValidColorModes();
if (!renderer.colorMode || !validModes.includes(renderer.colorMode)) {
    renderer.colorMode = (config.color?.mode && validModes.includes(config.color.mode)) ? config.color.mode : 'auto';
}
// Sync dropdown to renderer's colorMode
if (colorSelect && renderer.colorMode) {
    colorSelect.value = renderer.colorMode;
}
// Palette for the 'ss' colour mode (config.color.ss_palette / the SSE
// dropdown). Unset = cartoon/geom.js's default palette.
if (config.color?.ss_palette) renderer.ssPalette = config.color.ss_palette;

colorSelect.addEventListener('change', (e) => {
    const selectedMode = e.target.value;
    const validModes = getAllValidColorModes();

    if (validModes.includes(selectedMode)) {
        renderer.colorMode = selectedMode;
        renderer.colorsNeedUpdate = true;
        renderer.plddtColorsNeedUpdate = true;

        // Map entropy to structure if entropy mode is selected
        if (selectedMode === 'entropy' && renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName] && window.MSA) {
            renderer.entropy = renderer.entropyForDrawn
                ? renderer.entropyForDrawn()
                : window.MSA.mapEntropyToStructure(renderer.objectsData[renderer.currentObjectName], renderer.currentFrame >= 0 ? renderer.currentFrame : 0);
            renderer._updateEntropyOptionVisibility();
        } else {
            // Clear entropy when switching away from entropy mode
            renderer.entropy = undefined;
        }

        renderer.render();
        document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        // the SSE palette row only shows while the mode is 'ss'
        if (renderer._syncStylePanel) renderer._syncStylePanel();
    } else {
        // Invalid mode - reset dropdown to current colorMode
        colorSelect.value = renderer.colorMode || 'auto';
    }
});

// Store reference to colorSelect in renderer for syncing
renderer.colorSelect = colorSelect;

// SSE palette picker (optional container, inside the Style panel): a
// CUSTOM dropdown, because a native <select> cannot colour its options.
// The closed button shows the CURRENT palette as C H E N L colour chips
// (coil, helix, strand, nucleic, ligand - each letter on its own palette
// colour) plus the name; opening it lists every palette the same way.
// Built from py2dmolCartoon.SS_PALETTES so the preview cannot drift from
// what the renderer draws. Row visibility is handled by syncStylePanel
// via data-needs-ss.
const ssPaletteBox = containerElement.querySelector('#ssPaletteButtons');
if (ssPaletteBox) {
    const PAL_NAMES = { pymol: 'PyMOL', jmol: 'Jmol' };
    const fillRow = (el, key, pal, caret) => {
        el.textContent = '';
        for (const cls of ['C', 'H', 'E', 'N', 'L']) {
            const c = pal[cls];
            const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
            const chip = document.createElement('span');
            chip.textContent = cls;
            chip.style.cssText = 'display:inline-block;width:14px;'
                + 'text-align:center;border-radius:3px;font-size:10px;'
                + 'font-weight:600;line-height:14px;flex-shrink:0;'
                + 'border:1px solid rgba(0,0,0,0.12);'
                + `background:rgb(${c.r},${c.g},${c.b});`
                + `color:${lum > 160 ? '#1f2937' : '#ffffff'};`;
            el.appendChild(chip);
        }
        const nm = document.createElement('span');
        nm.textContent = PAL_NAMES[key] || key;
        nm.style.cssText = 'font-size:11px;color:#6b7280;margin-left:3px;'
            + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
            + 'flex:1 1 0;min-width:0;text-align:left;';
        el.appendChild(nm);
        if (caret) {
            const cv = document.createElement('span');
            cv.textContent = '\u25be';
            cv.style.cssText = 'font-size:10px;color:#6b7280;flex-shrink:0;';
            el.appendChild(cv);
        }
    };
    const buildSsPalette = () => {
        const table = window.py2dmolCartoon && window.py2dmolCartoon.SS_PALETTES;
        if (!table) return;
        ssPaletteBox.textContent = '';
        ssPaletteBox.style.position = 'relative';
        const rowCss = 'display:flex;align-items:center;gap:2px;width:100%;'
            + 'justify-content:flex-start;padding:2px 4px;height:24px;min-width:0;';
        const closed = document.createElement('button');
        closed.type = 'button';
        closed.className = 'controlButton';
        closed.style.cssText = rowCss;
        closed.title = 'SSE palette - C coil, H helix, E strand, N nucleic, L ligand';
        // MATCH THE SIBLING DROPDOWNS: copy the box (border, radius,
        // height, font) from the page's own Style select, so the closed
        // state looks like one of them on any page without hardcoding
        // either page's dimensions here.
        const refSel = containerElement.querySelector('#styleSelect');
        let menuRadius = '6px';
        if (refSel) {
            const cs = refSel.ownerDocument.defaultView.getComputedStyle(refSel);
            closed.style.border = cs.border;
            closed.style.borderRadius = cs.borderRadius;
            closed.style.height = cs.height;
            closed.style.fontSize = cs.fontSize;
            closed.style.background = '#ffffff';
            menuRadius = cs.borderRadius;
        }
        const menu = document.createElement('div');
        menu.hidden = true;
        // sized to CONTENT and anchored to the right edge: constrained
        // to the box width the chip rows overflowed the narrow widget
        // panel; as an overlay the menu may spread left over the panel.
        menu.style.cssText = 'position:absolute;top:100%;right:0;left:auto;'
            + 'width:max-content;'
            + 'margin-top:2px;background:#ffffff;border:1px solid #d1d5db;'
            + 'box-shadow:0 4px 12px rgba(0,0,0,0.15);'
            + 'display:flex;flex-direction:column;gap:2px;padding:3px;'
            + 'z-index:1000;';
        menu.style.borderRadius = menuRadius;
        const syncClosed = () => {
            const cur = renderer.ssPalette || 'pymol';
            fillRow(closed, cur, table[cur] || table.pymol, true);
            menu.querySelectorAll('.ssPalOption').forEach((b) => {
                const on = b.dataset.palette === cur;
                b.style.background = on ? '#e5e7eb' : '#ffffff';
            });
        };
        for (const key of Object.keys(table)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'controlButton ssPalOption';
            btn.dataset.palette = key;
            btn.title = (PAL_NAMES[key] || key)
                + ' - C coil, H helix, E strand, N nucleic, L ligand';
            btn.style.cssText = rowCss + 'border:none;';
            fillRow(btn, key, table[key], false);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                renderer.ssPalette = key;
                menu.hidden = true;
                syncClosed();
                renderer.colorsNeedUpdate = true;
                renderer.plddtColorsNeedUpdate = true;
                renderer.render('ssPalette');
                // The sequence view and the PAE plot colour their residues
                // through the same per-residue colour function, so a palette
                // swap changes them too - but they only find out through
                // this event, which the colour-MODE dropdown dispatches and
                // this handler used to skip. Result: the ribbon recoloured
                // and the sequence stayed on the old palette.
                document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
            });
            menu.appendChild(btn);
        }
        closed.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.hidden = !menu.hidden;
        });
        // close on any click outside this widget
        containerElement.ownerDocument.addEventListener('click', (e) => {
            if (!menu.hidden && !ssPaletteBox.contains(e.target)) menu.hidden = true;
        });
        ssPaletteBox.appendChild(closed);
        ssPaletteBox.appendChild(menu);
        syncClosed();
        // Expose it so ANY programmatic change to renderer.ssPalette (state
        // restore, a preset, the Python API) can refresh the closed chip.
        // Without this the ribbon recoloured while the dropdown kept
        // showing the previous palette.
        renderer._syncSsPaletteChip = syncClosed;
    };
    if (window.py2dmolCartoon) buildSsPalette();
    else window.addEventListener('py2dmol_cartoon_loaded', buildSsPalette, { once: true });
}

// ONE STYLE DROPDOWN: tube, and the three cartoons by name.
//
// The renderer keeps a style (which draw path) and a preset (which cartoon
// profile) apart, because they are different questions. The dropdown does not:
// "Cartoon" was never a look on its own - picking it meant Richardson - and two
// controls that have to agree are two controls that can disagree.
const styleSelect = containerElement.querySelector('#styleSelect');
// ...the pair, read back as the one name that stands for it
const uiStyleOf = () => (renderer.style === 'cartoon'
    ? (renderer.stylePreset || 'richardson') : 'tube');
if (styleSelect) {
    styleSelect.value = uiStyleOf();
    styleSelect.addEventListener('change', (e) => {
        // PICKED BY HAND, and remembered as such: the loader chooses tube
        // over cartoon for a large structure, and it must not go on
        // choosing for someone who has said what they want.
        renderer.styleChosen = true;
        // setStyle takes any of the four names and does the preset switch
        // itself where one is implied.
        renderer.setStyle(e.target.value);
        // ...and rejects a style whose file is not loaded, so re-sync
        if (styleSelect.value !== uiStyleOf()) styleSelect.value = uiStyleOf();
        syncStylePanel();
    });
    renderer.styleSelect = styleSelect;
}

// Setup the collapsible Style panel - optional. It holds the render
// controls; rows tagged data-style="ribbon|cartoon" appear only under that
// style (untagged rows are shared). Both markup and panel are optional, so
// every lookup below is null-guarded.
const styleToggle = containerElement.querySelector('#styleToggle');
const stylePanel = containerElement.querySelector('#stylePanel');

// HOW WIDE THE WIDTH CONTROL GOES, PER STYLE.
//
// A tube is a solid stroke and keeps reading as one when it fattens, so it
// goes to 5.0; the cartoon keeps the 4.7 the control has always had.
//
// The ceiling is deliberately modest, because the two renderers agree less
// well the wider the stroke gets. Measured on 1TIM, GPU against the 2D
// pass, mean absolute difference per pixel: 3.40 at width 2, 3.41 at 3,
// 3.85 at 4, 4.14 at 5. The visible part is the outlines: as capsules
// overlap more, the GPU keeps fewer of them than the 2D pass does (thin
// dark pixels at width 5: 7,233 against 9,913), so a wide tube reads as a
// smoother mass there and as a drawn one here. None of that is new - the
// same gap is in the pre-GPU-optimisation build at the default width - it
// just grows with the control, which is reason enough not to open the
// control very far.
//
// The VALUE comes down with the ceiling when the style changes. A slider
// pinned at its maximum while the renderer holds a larger number is a
// control that lies about the drawing, which is the same failure the
// LOOK_DEFAULTS table exists to prevent. Width is remembered per style
// now (_widthByStyle), so a tube at 5 no longer walks into a cartoon whose
// slider stops at 4.7 - this stays as the guard for a width arriving from
// anywhere else, a restored session among them.
const WIDTH_MAX = { tube: 5.0, cartoon: 4.7 };

function syncStylePanel() {
    const style = renderer.style || 'tube';
    if (!stylePanel) return;
    const widthSlider = stylePanel.querySelector('#lineWidthSlider');
    if (widthSlider) {
        const cap = WIDTH_MAX[style] || WIDTH_MAX.cartoon;
        widthSlider.max = String(cap);
        if (renderer.lineWidth > cap) {
            renderer.lineWidth = cap;
            widthSlider.value = String(cap);
        }
    }
    Array.prototype.forEach.call(stylePanel.children, (row) => {
        row.hidden = false;
    });
    stylePanel.querySelectorAll('[data-style]').forEach((el) => {
        const want = el.getAttribute('data-style');
        // Rows may name several styles, space separated.
        const wanted = want ? want.split(/\s+/) : null;
        const show = !wanted || wanted.includes(style);
        el.hidden = !show;
    });
    // Both panels pair half-cells per row (same DOM); collapse a row once
    // every tagged cell in it is hidden, so no empty rows are left behind.
    // Rows with untagged children (Width/Outline) never auto-collapse.
    stylePanel.querySelectorAll('.toggle-item').forEach((row) => {
        const cells = row.querySelectorAll(':scope > [data-style]');
        if (!cells.length || cells.length !== row.children.length) return;
        row.hidden = Array.prototype.every.call(cells, (c) => c.hidden);
    });
    // The SSE palette row exists only while colouring by secondary
    // structure.
    const ssOn = (renderer._getEffectiveColorMode
        ? renderer._getEffectiveColorMode() : renderer.colorMode) === 'ss';
    stylePanel.querySelectorAll('[data-needs-ss]').forEach((el) => {
        if (!ssOn) el.hidden = true;
    });
    // ...and the one dropdown shows whichever of the four is live
    if (styleSelect) styleSelect.value = uiStyleOf();
}

if (styleToggle && stylePanel) {
    styleToggle.addEventListener('click', () => {
        const open = stylePanel.hidden;
        stylePanel.hidden = !open;
        styleToggle.setAttribute('aria-expanded', String(open));
    });
}
// Exposed so setStyle() can re-filter the rows when called programmatically.
// Push renderer values onto the preset sliders. Registered here because
// this is where the slider elements are in scope; called by
// _applyLookDefaults on every style switch.
renderer._syncStyleControls = () => {
    const set = (el, v) => { if (el && v !== undefined) el.value = v; };
    set(lineWidthSlider, renderer.lineWidth);
    set(thicknessSlider, renderer.cartoonThickness);
    set(highlightSlider, renderer.cartoonHighlight);
    set(outlineTintSlider, renderer.cartoonOutlineTint);
    set(sheetFlatSlider, renderer.cartoonSheetFlat);
    set(pencilSlider, renderer.cartoonPencil);
    if (smoothCheckbox) smoothCheckbox.checked = renderer.cartoonSmooth === true;
    // queried at call time: these elements are set up after this closure
    // is defined, and a lookup here can never hit a TDZ.
    const qs = (id) => containerElement.querySelector(id);
    set(qs('#outlineWidthSlider'), renderer.relativeOutlineWidth);
    set(qs('#detailSlider'), renderer.cartoonDetail);
    set(qs('#shadeSlider'), renderer.cartoonShade);
    const arrowsCb = qs('#arrowsCheckbox');
    if (arrowsCb) arrowsCb.checked = renderer.cartoonArrows !== false;
    if (renderer._syncSsPaletteChip) renderer._syncSsPaletteChip();

};

renderer._syncStylePanel = syncStylePanel;
syncStylePanel();

// ---- Slider value readouts (calibration aid) --------------------------
// Every range input gets a small bubble above its thumb naming the option
// and showing its exact value, on hover and throughout a drag. Purely
// additive: the bubble is position:fixed so it costs no layout, and it
// never writes to the control.
// One bubble and one document listener per DOCUMENT, not per viewer: a page
// can host many viewers and nothing here is ever torn down, so a per-viewer
// node plus a per-viewer document listener would accumulate.
const sliderDoc = containerElement.ownerDocument;
if (!sliderDoc.__py2dmolReadout) {
    sliderDoc.__py2dmolReadout = { el: null, dragging: null };
}
const readout = sliderDoc.__py2dmolReadout;

function readoutBubble() {
    let readoutEl = readout.el;
    if (readoutEl && readoutEl.isConnected) return readoutEl;
    readoutEl = sliderDoc.createElement('div');
    readout.el = readoutEl;
    readoutEl.id = 'sliderReadout';
    readoutEl.style.cssText = [
        'position:fixed', 'z-index:2147483000', 'pointer-events:none',
        'background:#111827', 'color:#f9fafb', 'font-size:11px',
        'font-family:inherit', 'font-weight:500', 'line-height:1',
        'padding:4px 6px', 'border-radius:4px', 'white-space:nowrap',
        'box-shadow:0 1px 4px rgba(0,0,0,0.3)', 'display:none',
    ].join(';');
    sliderDoc.body.appendChild(readoutEl);
    return readoutEl;
}

function readoutName(slider) {
    // Scoped to this viewer: a page can host several viewers, and their
    // control ids repeat, so a document-wide lookup could match a sibling.
    const lab = slider.id && containerElement.querySelector(`label[for="${slider.id}"]`);
    const raw = (lab && lab.textContent) || slider.getAttribute('aria-label') || slider.id || '';
    return raw.trim().replace(/:$/, '');
}

function readoutText(slider) {
    // Decimal places follow the step, so 0.05 shows 0.55 and 1 shows 3.
    const step = parseFloat(slider.step);
    const dp = Number.isFinite(step) && step > 0 && step < 1
        ? (String(step).split('.')[1] || '').length : 0;
    return `${readoutName(slider)}: ${parseFloat(slider.value).toFixed(dp)}`;
}

function showReadout(slider) {
    const el = readoutBubble();
    el.textContent = readoutText(slider);
    el.style.display = 'block';
    // The thumb centre travels the track width minus one thumb width.
    const r = slider.getBoundingClientRect();
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const frac = max > min ? (parseFloat(slider.value) - min) / (max - min) : 0;
    const THUMB = 14;
    const x = r.left + THUMB / 2 + (r.width - THUMB) * frac;
    const b = el.getBoundingClientRect();
    el.style.left = `${Math.round(Math.max(2, x - b.width / 2))}px`;
    el.style.top = `${Math.round(r.top - b.height - 6)}px`;
}

function hideReadout() {
    if (readout.el) readout.el.style.display = 'none';
}

containerElement.querySelectorAll('input[type="range"]').forEach((slider) => {
    if (slider.id === 'frameSlider') return;   // already has its own counter
    slider.addEventListener('pointerenter', () => { if (!readout.dragging) showReadout(slider); });
    slider.addEventListener('pointerleave', () => { if (!readout.dragging) hideReadout(); });
    slider.addEventListener('pointerdown', () => { readout.dragging = slider; showReadout(slider); });
    slider.addEventListener('input', () => {
        if (readout.dragging === slider || slider.matches(':hover')) showReadout(slider);
    });
});
// Drags routinely end outside the track, so the release is caught on the
// document - once per document, shared by every viewer on the page.
if (!readout.bound) {
    readout.bound = true;
    sliderDoc.addEventListener('pointerup', () => {
        if (!readout.dragging) return;
        const s = readout.dragging;
        readout.dragging = null;
        if (!s.matches(':hover') && readout.el) readout.el.style.display = 'none';
    });
}

// Dark background toggle: black page, white ink, fade toward black.
const darkCheckbox = containerElement.querySelector('#darkCheckbox');
if (darkCheckbox) {
    darkCheckbox.checked = renderer.backgroundColor === '#000000';
    darkCheckbox.addEventListener('change', (e) => {
        renderer.backgroundColor = e.target.checked ? '#000000' : '#ffffff';
        if (renderer.canvas) renderer.canvas.style.background = renderer.backgroundColor;
        renderer.render('darkCheckbox');
    });
    // seed the canvas css background to match the config
    if (renderer.canvas && renderer.backgroundColor === '#000000') {
        renderer.canvas.style.background = renderer.backgroundColor;
    }
}

// Setup the Shade toggle (cartoon directional shading)


// Setup outline control - can be either a button (index.html) or dropdown (viewer.html)
const outlineModeButton = containerElement.querySelector('#outlineModeButton');
const outlineModeSelect = containerElement.querySelector('#outlineModeSelect');

if (outlineModeButton) {
    // Button mode (index.html) - style will be set by updateOutlineButtonStyle() in setUIControls
} else if (outlineModeSelect) {
    // Dropdown mode (viewer.html)
    outlineModeSelect.value = renderer.outlineMode || 'full';
    outlineModeSelect.addEventListener('change', (e) => {
        renderer.outlineMode = e.target.value;
        renderer.render();
    });
}

// Setup colorblindCheckbox
const colorblindCheckbox = containerElement.querySelector('#colorblindCheckbox');
colorblindCheckbox.checked = renderer.colorblindMode; // Set default from renderer

// 6. Setup animation and object controls
// ...DECLARED, at last. This was the one control never fetched here: it was
// passed to setUIControls as a bare `controlsContainer`, which nothing in the
// repo declares, and resolved through the browser's legacy named access on
// window - <div id="controlsContainer"> quietly becomes window.controlsContainer.
// It therefore ignored containerElement entirely, so two viewers on one page
// both drove the FIRST one's strip, and a page without the id killed
// wireViewerUI with a ReferenceError from a line that reads like a local.
const controlsContainer = containerElement.querySelector('#controlsContainer');
const playButton = containerElement.querySelector('#playButton');
const overlayButton = containerElement.querySelector('#overlayButton');
// All buttons are within containerElement in both div and iframe modes
const recordButton = containerElement.querySelector('#recordButton');
// #saveSvgButton is the old id; still accepted so previously exported
// standalone HTML keeps working.
const saveImageButton = containerElement.querySelector('#saveImageButton')
    || containerElement.querySelector('#saveSvgButton');
const frameSlider = containerElement.querySelector('#frameSlider');
const frameCounter = containerElement.querySelector('#frameCounter');
// WHICH OBJECT IS BEING EDITED - the picker beside the sequence strip. It
// sits in the sequence panel, which is a sibling of the viewer container
// rather than inside it, so the container query comes back empty and the
// renderer would have no picker at all: no options, no change listener,
// and no way to switch objects. Falls back to the document, and stays
// container-first so two viewers on one page keep their own.
// ...and only when there is EXACTLY ONE on the page. Several viewers can
// share a document - see the grid - and a fallback that takes the first
// match would hand this renderer another viewer's picker, so both would
// drive the same one.
const objectSelect = containerElement.querySelector('#objectSelect')
    || (function () {
        const doc = containerElement.ownerDocument || document;
        const all = doc.querySelectorAll('#objectSelect');
        return all.length === 1 ? all[0] : null;
    }());
const speedButton = containerElement.querySelector('#speedButton');
const rotationCheckbox = containerElement.querySelector('#rotationCheckbox');
const lineWidthSlider = containerElement.querySelector('#lineWidthSlider');
const outlineWidthSlider = containerElement.querySelector('#outlineWidthSlider');
const orthoSlider = containerElement.querySelector('#orthoSlider');
const shadowSlider = containerElement.querySelector('#shadowSlider');
const thicknessSlider = containerElement.querySelector('#thicknessSlider');
const detailSlider = containerElement.querySelector('#detailSlider');
const sheetFlatSlider = containerElement.querySelector('#sheetFlatSlider');
const pencilSlider = containerElement.querySelector('#pencilSlider');


// Set defaults for width, rotation, and shadow
if (lineWidthSlider) lineWidthSlider.value = renderer.lineWidth;
if (thicknessSlider) {
    thicknessSlider.value = renderer.cartoonThickness !== undefined
        ? renderer.cartoonThickness : 0;
    thicknessSlider.addEventListener('input', (e) => {
        renderer.cartoonThickness = parseFloat(e.target.value);
        // Same rule as the Width slider: only a real gesture takes the
        // control over. Nothing dispatches a synthetic 'input' at this
        // slider today, but the two latches are siblings and drifted once
        // already - the guard makes that impossible rather than lucky.
        if (e.isTrusted) renderer._thicknessUserSet = true;
        renderer.render('thicknessSlider');
    });
}
if (pencilSlider) {
    pencilSlider.value = renderer.cartoonPencil;
    pencilSlider.addEventListener('input', (e) => {
        renderer.cartoonPencil = parseFloat(e.target.value);
        renderer.render('pencilSlider');
    });
}
if (sheetFlatSlider) {
    sheetFlatSlider.value = renderer.cartoonSheetFlat;
    sheetFlatSlider.addEventListener('input', (e) => {
        renderer.cartoonSheetFlat = parseFloat(e.target.value);
        // strand geometry changes, so cached segment geometry is stale
        if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
        renderer.render('sheetFlatSlider');
    });
}
const shadeSlider = containerElement.querySelector('#shadeSlider');
if (shadeSlider) {
    renderer.shadeSlider = shadeSlider;
    shadeSlider.value = renderer.cartoonShade !== undefined ? renderer.cartoonShade : 1;
    shadeSlider.addEventListener('input', (e) => {
        renderer.cartoonShade = parseFloat(e.target.value);
        renderer.render('shadeSlider');
    });
}
if (detailSlider) {
    detailSlider.value = renderer.cartoonDetail !== undefined
        ? renderer.cartoonDetail : 4;
    detailSlider.addEventListener('input', (e) => {
        renderer.cartoonDetail = parseInt(e.target.value, 10);
        renderer.render('detailSlider');
    });
}
const smoothCheckbox = containerElement.querySelector('#smoothCheckbox');
const arrowsCheckbox = containerElement.querySelector('#arrowsCheckbox');
if (arrowsCheckbox) {
    arrowsCheckbox.checked = renderer.cartoonArrows !== false;
    arrowsCheckbox.addEventListener('change', (e) => {
        renderer.cartoonArrows = e.target.checked;
        if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
        renderer.render('arrowsCheckbox');
    });
}
// Bases toggle: DNA/RNA base plates (the rungs of a duplex) on/off.
const basePlatesCheckbox = containerElement.querySelector('#basePlatesCheckbox');
if (basePlatesCheckbox) {
    basePlatesCheckbox.checked = renderer.cartoonBasePlates !== false;
    basePlatesCheckbox.addEventListener('change', (e) => {
        renderer.cartoonBasePlates = e.target.checked;
        renderer.render('basePlatesCheckbox');
    });
}
if (smoothCheckbox) {
    smoothCheckbox.checked = renderer.cartoonSmooth === true;
    smoothCheckbox.addEventListener('change', (e) => {
        renderer.cartoonSmooth = e.target.checked;
        syncStylePanel();
        renderer.render('smoothCheckbox');
    });
}
// NO GPU CONTROL HERE. `useGPU` is a rendering BACKEND and applies to
// both styles, so the Style panel was the wrong home for it: tagged for one
// style it was hidden in the other, and tagged for both it was still sitting
// among the things that change what the picture IS. The web app owns the
// control now (index.html's Use GPU, wired in src/app/) and Python owns
// the flag (view(gpu=True) -> config.rendering.gpu). This file just reads it.
const highlightSlider = containerElement.querySelector('#highlightSlider');
if (highlightSlider) {
    highlightSlider.value = renderer.cartoonHighlight !== undefined
        ? renderer.cartoonHighlight : 1.8;
    highlightSlider.addEventListener('input', (e) => {
        renderer.cartoonHighlight = parseFloat(e.target.value);
        renderer.render('highlightSlider');
    });
}
const outlineTintSlider = containerElement.querySelector('#outlineTintSlider');
if (outlineTintSlider) {
    outlineTintSlider.value = renderer.cartoonOutlineTint || 0;
    outlineTintSlider.addEventListener('input', (e) => {
        renderer.cartoonOutlineTint = parseFloat(e.target.value);
        renderer.render('outlineTintSlider');
    });
}

// outline/shadow are OFF at slider zero, so seed each from the live state
if (outlineWidthSlider) {
    // ?? not ||: an outline deliberately set to 0 is not an unset one, and
    // || turned it back on at the default. Reachable through the 3d preset,
    // whose outlineWidth IS 0 - _applyLookDefaults only forces outlineMode
    // to 'none' when there is no mode control, so with one present the width
    // sat at 0 while this put 1.0 on the slider.
    outlineWidthSlider.value = renderer.outlineMode === 'none'
        ? 0 : (renderer.relativeOutlineWidth ?? 3.0);
}
if (shadowSlider) {
    shadowSlider.value = renderer.shadowEnabled === false
        ? 0 : (renderer.shadowStrength || 0.5);
}
rotationCheckbox.checked = renderer.autoRotate;

// ORIENT, FOR EVERY SURFACE THAT MOUNTS THIS PANEL. The notebook had no such
// control at all - the website's lives in index.html and app/main.js wires it,
// and the embed had grown its own copy in parts/embed.js on the reasoning that
// only index.html has an #objectSelect to say WHICH object. viewer.html has one
// too, so that was never the difference; the notebook was simply missing a
// button. Wired here, both shells get it from one place.
//
// parts/orient.js is optional like every other subsystem, so the control goes
// away with it rather than throwing when pressed.
const orientButton = containerElement.querySelector('#orientButton');
if (orientButton) {
    if (!window.py2dmolOrient) {
        orientButton.hidden = true;
    } else {
        orientButton.addEventListener('click', () => {
            window.py2dmolOrient.orientToBestView(renderer, { animate: true });
        });
    }
}

// THE SLAB PYTHON ASKED FOR, from either path. `null` turns it off; a selector
// is resolved here rather than in Python, because positionsFor is the project's
// one way of naming residues and translating it twice is two ways.
const applyClipSelector = (sel) => {
    // ...THE RENDERER'S OWN, in parts/clip.js. This was four lines written out
    // here and four more in parts/embed.js, and only this copy re-synced the
    // Clip button. A build without parts/clip.js has no clipTo and this is a
    // feature that is simply absent, not an error.
    if (typeof renderer.clipTo === 'function') renderer.clipTo(sel);
};
renderer._applyClipSelector = applyClipSelector;

// WHICH OBJECTS ARE ON SCREEN, asked for from Python - the renderer's own
// setter and nothing else. setShownObjects is what keeps _framedObjects, the
// record of which objects the camera has already accommodated; assigning
// shownObjects and rebuilding by hand skips it and the view never widens onto
// the second structure. parts/embed.js's showObjects() calls the same setter.
//
// Python sends an EXPLICIT LIST - show_objects() resolves "all of them" in
// Python, at the moment of the call - so there is no second spelling of "all"
// for the two sides to disagree about.
const applyShownObjects = (names) => {
    if (typeof renderer.setShownObjects === 'function') {
        renderer.setShownObjects(names);
    }
};

// AND WHERE THE CAMERA LOOKS FROM. Same shape as the clip request: a selector
// in the JS selector's own words, or an empty object for "the best view of
// whatever is on screen". The search is parts/orient.js's, the one the first
// frame already runs unprompted - this is the caller asking for it again,
// after a selection or after several objects went up.
const applyOrientRequest = (request) => {
    // ...AND THE SAME ONE THE EMBED'S v.orient() CALLS, which is why Python
    // sends the selector and the options merged into one object: it is the
    // shape orientTo already took, so nothing here has to unpack it.
    if (window.py2dmolOrient) window.py2dmolOrient.orientTo(renderer, request);
};
renderer._applyOrientRequest = applyOrientRequest;

// CLIP, the same way. parts/clip.js is in every bundle - the slab, the
// tracking and the refit all ship to the notebook and to both embeds - and
// none of it was reachable from either, because the only control was
// index.html's panel and the only API was the embed's v.clip(). Shipping the
// code without a way to it is the whole of what was wrong.
//
// A toggle rather than that panel: the panel exists on the website to set a
// mode and commit it on close, and there is nothing to set here. The depth is
// the SELECTION'S depth, which the renderer refits every frame, so pressing it
// twice is the whole interface.
const clipButton = containerElement.querySelector('#clipButton');
if (clipButton) {
    if (typeof renderer.autoClip !== 'function') {
        clipButton.hidden = true;          // a build without parts/clip.js
    } else {
        const syncClip = () => {
            const on = renderer.clipSlabOn && renderer.clipSlabOn();
            clipButton.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        syncClip();
        clipButton.addEventListener('click', () => {
            if (renderer.clipSlabOn && renderer.clipSlabOn()) {
                renderer.setClipSlab(null, null);
            } else {
                // WHAT IS SELECTED, or everything when nothing is - and that
                // is autoClip's OWN default, which index.html's Auto button
                // has always used. This read renderer.residueSelection and
                // passed it in, which is the same answer by a worse route:
                // clipSlabForSelection prefers selectionInk() where there is
                // one, so the copy could clip to a different set of residues
                // than the button on the website clips to.
                //
                // Clipping to the whole structure is not a no-op - it is the
                // structure's own depth, the honest answer to "clip to what I
                // can see", and it leaves the picture alone.
                renderer.autoClip();
            }
            syncClip();
            renderer.render('clipButton');
        });
        // ...and the button follows the slab however it was changed - the API,
        // a style change, a reset - rather than only what it did itself.
        renderer._syncClipButton = syncClip;
    }
}

// Hand-drawn build-up. A checkbox rather than a plain button so it takes
// the same pressed skin as Colorblind and Dark beside it, and so it reads
// as ON while the drawing is being made. The renderer clears it when the
// animation finishes or is interrupted, which is why it holds the element.
const drawCheckbox = containerElement.querySelector('#drawCheckbox');
if (drawCheckbox) {
    renderer.drawCheckbox = drawCheckbox;
    drawCheckbox.checked = false;
    drawCheckbox.addEventListener('change', () => {
        renderer.setDrawMode(drawCheckbox.checked);
    });
}

// Pass ALL controls to the renderer
renderer.setUIControls(
    controlsContainer, playButton, overlayButton, recordButton, saveImageButton,
    frameSlider, frameCounter, objectSelect,
    speedButton, rotationCheckbox, lineWidthSlider, outlineWidthSlider,
    outlineModeButton, outlineModeSelect,
    colorblindCheckbox, orthoSlider, shadowSlider
);

// Setup save state button (for Python interface only - web interface handles it in src/app/session.js)
// Only add listener if we're in Python interface (no window.saveViewerState exists yet)
const saveStateButton = containerElement.querySelector('#saveStateButton');
if (saveStateButton && typeof window.saveViewerState !== 'function') {
    saveStateButton.addEventListener('click', () => {
        // For Python interface, use view.save_state(filepath) method
        alert("Save state: Use the Python method view.save_state(filepath) to save the current state.");
    });
}

// Set ortho slider from config
if (config.rendering?.ortho !== undefined && orthoSlider) {
    orthoSlider.value = normalizeOrthoValue(config.rendering.ortho);
    // The slider's input event will be triggered after data loads to set the correct focalLength
}





// Handle new UI config options
if (!config.display?.controls) {
    const rightPanel = containerElement.querySelector('#rightPanelContainer');
    if (rightPanel) rightPanel.style.display = 'none';
    // controlsContainer is handled by updateUIControls
}

// Handle box
if (!config.display?.box) {
    const canvasCont = containerElement.querySelector('#canvasContainer');
    if (canvasCont) {
        canvasCont.style.border = 'none';
        canvasCont.style.background = 'transparent';
    }
    if (canvas) canvas.style.background = 'transparent';

    // Also update PAE canvas if it exists
    if (config.pae?.enabled) {
        const paeCanvas = containerElement.querySelector('#paeCanvas');
        if (paeCanvas) {
            paeCanvas.style.border = 'none';
            paeCanvas.style.background = 'transparent';
        }
    }

    renderer.setClearColor(true);
}

// Snapshot persistence (sessionStorage)
let lastIncrementalSeq = -1;

// 7. Load initial data
if ((window.py2dmol_staticData && window.py2dmol_staticData[viewerId]) && (window.py2dmol_staticData[viewerId]).length > 0) {
    // === STATIC MODE (from show()) ===
    try {
        for (const obj of (window.py2dmol_staticData && window.py2dmol_staticData[viewerId])) {
            // Create object even if no frames (for metadata like scatter_config)
            if (obj.name) {
                // Ensure object exists in objectsData
                if (!renderer.objectsData[obj.name]) {
                    renderer.addObject(obj.name);
                }

                // Store scatter config IMMEDIATELY after creating object
                if (obj.scatter_config) {
                    renderer.objectsData[obj.name].scatterConfig = obj.scatter_config;
                }
            }

            if (obj.name && obj.frames && obj.frames.length > 0) {

                // WHAT THE OBJECT SAYS when a frame does not. Only three
                // fields have one, and they are named in STATIC_FRAME_FIELDS.
                const staticLevel = {
                    chains: obj.chains,
                    position_types: obj.position_types,
                    bonds: obj.bonds,
                };
                const staticContacts = obj.contacts; // Might be undefined

                for (let i = 0; i < obj.frames.length; i++) {
                    const lightFrame = obj.frames[i];

                    // Robust resolution: frame-level > object-level > undefined (will use defaults)
                    const n = lightFrame.coords ? lightFrame.coords.length : 0;

                    // Re-construct the full frame data with proper inheritance
                    // ONE LIST, and the object-level fallbacks beside it -
                    // see STATIC_FRAME_FIELDS. This was a hand-written run of
                    // `name: lightFrame.name || undefined` lines, and what that
                    // shape cost was not the length: a field left out of the
                    // run is a field thrown away in silence. Three were.
                    // `align` and `allow_reflection` meant a trajectory loaded
                    // with add() then show() never superposed, and the two
                    // per-atom columns meant element colouring - on by default
                    // - did nothing at all in a notebook. Both worked on every
                    // other path, which is why neither showed up as an error.
                    const fullFrameData = { coords: lightFrame.coords };
                    for (const [key, fallback] of STATIC_FRAME_FIELDS) {
                        fullFrameData[key] = lightFrame[key]
                            || (fallback ? staticLevel[fallback] : undefined)
                            || undefined;
                    }

                    renderer.addFrame(fullFrameData, obj.name);
                }

                // Store contacts at object level if present
                if (staticContacts) {
                    const object = renderer.objectsData[obj.name];
                    if (object) {
                        object.contacts = staticContacts;
                        // Invalidate segment cache to ensure contacts are included in next render
                        renderer._invalidateSegmentCache();
                    }
                }

                // Store color overrides at object level if present
                if (obj.color) {
                    if (renderer.objectsData[obj.name]) {
                        renderer.objectsData[obj.name].color = obj.color;
                        // Invalidate segment cache to ensure new colors are applied
                        renderer._invalidateSegmentCache();
                    }
                }

                // ... and secondary structure (Python's set_sse). The static
                // path is what a notebook/Colab cell renders from, so an
                // override set before show() only survives if it is read back
                // here, exactly like color.
                if (obj.sse && renderer.objectsData[obj.name]) {
                    renderer.objectsData[obj.name].sse = obj.sse;
                    renderer._invalidateSegmentCache();
                }

                // Store rotation matrix and center for view transform if present
                if (obj.rotation_matrix && obj.center) {
                    if (renderer.objectsData[obj.name]) {
                        renderer.objectsData[obj.name].rotation_matrix = obj.rotation_matrix;
                        renderer.objectsData[obj.name].center = obj.center;

                        // Invalidate shadow cache since rotation affects shadows
                        renderer.cachedShadows = null;
                        renderer.lastShadowRotationMatrix = null;
                    }
                }
            }
        }
        // Set view to the first frame of the first object
        if ((window.py2dmol_staticData && window.py2dmol_staticData[viewerId]) && window.py2dmol_staticData[viewerId].length > 0) {
            renderer.currentObjectName = (window.py2dmol_staticData && window.py2dmol_staticData[viewerId])[0].name;
            renderer.objectSelect.value = (window.py2dmol_staticData && window.py2dmol_staticData[viewerId])[0].name;

            // Populate entropy data from MSA if available
            const firstObjectName = (window.py2dmol_staticData && window.py2dmol_staticData[viewerId])[0].name;
            if (renderer.objectsData[firstObjectName]?.msa?.msasBySequence &&
                renderer.objectsData[firstObjectName]?.msa?.chainToSequence && window.MSA) {
                // ...through the one path, which answers for everything
                // drawn - here that is this object, and it stays right the
                // day a static page shows two.
                renderer.entropy = renderer.entropyForDrawn();
                renderer._updateEntropyOptionVisibility();
            }

            // In overlay mode, DON'T call setFrame - it would load individual frame data
            // Instead, just render the merged data that's already been loaded via auto-enable
            if (renderer.overlayState.enabled) {
                renderer.currentFrame = 0;
                renderer.render('staticLoad-overlay');
            } else {
                renderer.setFrame(0);
            }
            // ...AND TURN IT TO FACE THE READER, which Python used to do.
            //
            // best_view() ran in viewer.py with numpy and shipped a matrix in
            // the payload, because the JS side had no SVD without numeric.js -
            // a CDN script on every page. svd3 in src/io/math.js replaced that, so
            // the search runs here now and there is one implementation of it
            // rather than two that could disagree.
            //
            // Not animated: the viewer has only just appeared, and a cell that
            // opens mid-flight looks like a bug rather than a flourish.
            //
            // ...OF WHAT IS ON SCREEN, so which objects those are is settled
            // first. Several structures reframe the camera between them, and
            // orienting before that framed one of them and then widened away
            // from the answer.
            if (config.shown_objects) applyShownObjects(config.shown_objects);
            if (window.py2dmolOrient && !renderer.objectsData[
                    renderer.currentObjectName]?.rotation_matrix) {
                window.py2dmolOrient.orientToBestView(renderer, {animate: false});
            }
            // AN ASKED-FOR ORIENTATION REPLACES THE AUTOMATIC ONE. It runs
            // after it rather than instead of it because the automatic pass is
            // skipped for an object that carries its own rotation, and a
            // caller who said orient() means it either way.
            if (config.orient) applyOrientRequest(config.orient);
            // ...AND THE SLAB, AFTER THE ORIENTATION. The depth is measured
            // along the view, so fitting it before the camera has been turned
            // measures it down the wrong axis. It rides in the config because
            // it is the viewer's rather than any object's - see viewer.py's
            // _display_viewer.
            if (config.clip) applyClipSelector(config.clip);
            // Update PAE container visibility after initial load
            // Use requestAnimationFrame to ensure PAE renderer is initialized
            requestAnimationFrame(() => {
                if (window.PAE) {
                    window.PAE.syncToDrawn(renderer);
                }

                // Update scatter with newly loaded config
                if (renderer.scatterRenderer) {
                    renderer.updateScatterData(renderer.currentObjectName);
                }

                renderer.updateScatterContainerVisibility();
            });
        }
    } catch (error) {
        console.error("Error loading static object data:", error);
        renderer.setFrame(-1); // Start empty on error
    }

} else if ((window.py2dmol_proteinData && window.py2dmol_proteinData[viewerId]) && (window.py2dmol_proteinData[viewerId]).coords && (window.py2dmol_proteinData[viewerId]).coords.length > 0) {
    // === HYBRID MODE (first frame) ===
    try {
        // Load the single, statically-injected frame into "0"
        renderer.addFrame((window.py2dmol_proteinData && window.py2dmol_proteinData[viewerId]), "0");
    } catch (error) {
        console.error("Error loading initial data:", error);
        renderer.setFrame(-1);
    }
} else {
    // === EMPTY DYNAMIC MODE ===
    // No initial data, start with an empty canvas.
    renderer.setFrame(-1);
}

// Update scatter visibility after initial load (handles empty objects with scatter_config)
if (renderer.scatterRenderer) {
    renderer.updateScatterContainerVisibility();
}

// After data load, trigger ortho slider to set correct initial focal length
if (orthoSlider) {
    orthoSlider.dispatchEvent(new Event('input'));
}


// 12. Start the main animation loop
renderer.animate();

// 12b. Handle incremental state updates from Python (memory-efficient)

/**
 * Helper: Apply metadata fields to an object.
 * 
 * Centralizes metadata application logic shared by both handleIncrementalStateUpdate
 * and handleReplaceFrame.
 *
 * @param {Object} obj - Object data to update
 * @param {Object} meta - Metadata fields (color, contacts, bonds, scatter_config)
 * @returns {boolean} True if rerender is needed
 */
const applyMetadataToObject = (obj, meta) => {
    if (!obj || !meta) return false;

    let needsRerender = false;

    // THE KEY IS THE MESSAGE, NOT THE VALUE'S TRUTH. Python sends only what
    // changed, and a field it has REMOVED travels as an explicit null - so
    // `if (meta.color)` read a colour being taken off as nothing to do, and
    // the viewer went on showing it for the life of the session. Present-and-
    // null clears; absent leaves alone.
    if ('color' in meta) {
        obj.color = meta.color || null;
        needsRerender = true;
    }
    if ('contacts' in meta) {
        obj.contacts = meta.contacts || null;
        needsRerender = true;
    }
    if ('bonds' in meta) {
        obj.bonds = meta.bonds || null;
        needsRerender = true;
    }
    // Secondary structure (Python's set_sse), keyed by position index like
    // `color`. The cartoon's SS cache key is derived from this map, so
    // replacing it invalidates the cached assignment and geometry by itself.
    if ('sse' in meta) {
        obj.sse = meta.sse || null;
        needsRerender = true;
    }

    // A FRAME'S OWN COLOUR, set after that frame was already delivered.
    // `color` above is the object's; set_color(..., frame=N) writes the
    // frame's, and the frame is only ever sent once - _sent_frame_count sees
    // to that - so there was no way for the change to travel and the call did
    // nothing at all on a live viewer. Keyed by frame index, as Python's map
    // is; JSON makes the key a string.
    //
    // The map is AUTHORITATIVE rather than a patch: Python sends every frame
    // that has a colour, so a frame missing from it is a frame whose colour
    // was taken off, and merging would make that one uncleared.
    if ('frame_colors' in meta) {
        const want = meta.frame_colors || {};
        (obj.frames || []).forEach((f, i) => {
            const col = want[String(i)] || null;
            if (f.color !== col) { f.color = col; needsRerender = true; }
        });
    }

    // Scatter config doesn't trigger rerender (handled separately)
    if ('scatter_config' in meta) {
        obj.scatterConfig = meta.scatter_config || null;
    }

    return needsRerender;
};

const handleIncrementalStateUpdate = (newFramesByObject, changedMetadataByObject, seq = null, viewerBlock = null) => {
    /**
     * Processes incremental updates sent from Python.
     * Python only sends NEW frames and CHANGED metadata to minimize data transfer.
     *
     * @param {Object} newFramesByObject - {"objectName": [newFrame1, newFrame2, ...]}
     * @param {Object} changedMetadataByObject - {"objectName": {color, contacts, bonds, ...}}
     * @param {number|null} seq - Optional sequence number for de-duplication
     */

    if (typeof seq === 'number') {
        if (seq <= lastIncrementalSeq) return;
        lastIncrementalSeq = seq;
    }

    // Create objects if they don't exist yet
    const newlyCreatedObjects = new Set();

    if (newFramesByObject) {
        for (const objectName of Object.keys(newFramesByObject)) {
            if (!renderer.objectsData[objectName]) {
                renderer.addObject(objectName);
                newlyCreatedObjects.add(objectName);
            }
        }
    }

    // Ensure objects exist when only metadata (e.g., scatter_config) arrives
    if (changedMetadataByObject) {
        for (const objectName of Object.keys(changedMetadataByObject)) {
            if (!renderer.objectsData[objectName]) {
                renderer.addObject(objectName);
                newlyCreatedObjects.add(objectName);
            }
        }
    }

    // Add new frames to each object
    if (newFramesByObject) {
        for (const [objectName, newFrames] of Object.entries(newFramesByObject)) {
            if (!newFrames || newFrames.length === 0) continue;

            // Python sends only NEW frames, so we just append them all
            for (const frame of newFrames) {
                try {
                    renderer.addFrame(frame, objectName);
                } catch (e) {
                    console.error(`Error adding frame to '${objectName}':`, e);
                }
            }
        }

        // Invalidate shadow cache since new frames may have different geometry
        renderer._invalidateShadowCache();
        renderer.lastShadowRotationMatrix = null;

        // Update UI once after all frames added
        renderer.updateUIControls();

        // Update PAE container visibility once at end
        if (window.PAE) {
            window.PAE.syncToDrawn(renderer);
        }

        // Update scatter plot if frames were added (may have scatter data)
        if (renderer.scatterRenderer && renderer.currentObjectName) {
            renderer.updateScatterData(renderer.currentObjectName);
            renderer.updateScatterContainerVisibility();
        }

        // Update UI controls to show/hide play button based on frame count
        renderer.updateUIControls();

        // Trigger render to update shadows and display new frame
        if (!renderer.isPlaying) {
            renderer.render('handleIncrementalStateUpdate');
        }
    }

    // Apply changed metadata fields
    if (changedMetadataByObject) {
        let needsRerender = false;

        for (const [objectName, changedFields] of Object.entries(changedMetadataByObject)) {
            const obj = renderer.objectsData[objectName];
            if (!obj) continue;

            // ONE APPLIER, shared with handleReplaceFrame. This was a second
            // copy of the same field list and the two had already drifted:
            // `sse` was added to that one and never to this one, so set_sse()
            // on a LIVE viewer wrote the map in Python, packed it into the
            // update, sent it, and had it dropped on arrival - while the same
            // call through show() worked, because the static path reads it.
            if (applyMetadataToObject(obj, changedFields)) needsRerender = true;

            // ...and the one thing the shared applier cannot do, because it
            // does not know which object is on screen
            if (changedFields.scatter_config
                    && objectName === renderer.currentObjectName
                    && renderer.scatterRenderer) {
                renderer.updateScatterData(objectName);
                renderer.updateScatterContainerVisibility();
            }

            // Only apply rotation/center for newly created objects
            if (newlyCreatedObjects.has(objectName)) {
                if (changedFields.rotation_matrix && obj.viewerState) {
                    obj.viewerState.rotation = changedFields.rotation_matrix;
                    needsRerender = true;
                }
                if (changedFields.center && obj.viewerState) {
                    obj.viewerState.center = changedFields.center;
                    needsRerender = true;
                }
            }
        }

        // Invalidate caches and re-render if metadata changed
        if (needsRerender) {
            renderer._invalidateSegmentCache();
            renderer.setFrame(renderer.currentFrame);
        }
    }

    // ...AND WHAT IS THE VIEWER'S RATHER THAN AN OBJECT'S. Last, because a slab
    // is fitted to residues and those residues have to be loaded first. The key
    // is read rather than its value's truth: `{clip: null}` is Python turning
    // the slab OFF, and an absent block is Python not mentioning it.
    if (viewerBlock && 'shown_objects' in viewerBlock) {
        applyShownObjects(viewerBlock.shown_objects);
    }
    if (viewerBlock && 'clip' in viewerBlock) {
        applyClipSelector(viewerBlock.clip);
    }
    // ...AND THE ORIENTATION LAST, because it frames what is on screen and the
    // line above may have just changed that. Unlike the other two this is an
    // ACTION rather than a state: it carries a nonce so the same request asked
    // for twice arrives twice, where an unchanged clip is not resent at all.
    if (viewerBlock && viewerBlock.orient) {
        applyOrientRequest(viewerBlock.orient);
    }
};

// 12c. Handle replace-frame updates (overwrite latest frame)
/**
 * Handle replace-frame updates from Python replace() calls.
 *
 * Always replaces the LAST frame (or adds if no frames exist).
 *
 * @param {Object} frame - Frame data to replace with (coords, plddts, chains, etc.)
 * @param {Object} [meta={}] - Metadata (color, contacts, bonds, scatter_config)
 * @param {string|null} [objectName=null] - Target object name (defaults to current)
 * @param {number|null} [seq=null] - Sequence number for deduplication
 *
 * Behavior:
 *   - Removes LAST frame and adds new one
 *   - If no frames exist, simply adds the new frame
 *   - Builds trajectory incrementally as replace() is called
 *
 * Frame Processing:
 *   - Uses renderer.addFrame() to ensure proper validation and data processing
 *   - Updates _lastPlddtFrame and _lastPaeFrame tracking correctly
 *   - Maintains shadow cache invalidation
 *
 * @see handleIncrementalStateUpdate For add() operations (always appends)
 */
const handleReplaceFrame = (frame, meta = {}, objectName = null, seq = null) => {
    if (typeof seq === 'number') {
        if (seq <= lastIncrementalSeq) return;
        lastIncrementalSeq = seq;
    }

    const objName = objectName || renderer.currentObjectName || Object.keys(renderer.objectsData)[0] || '0';

    if (!renderer.objectsData[objName]) {
        renderer.addObject(objName);
    }
    const obj = renderer.objectsData[objName];

    // Replace last frame (or add if no frames exist)
    if (obj.frames && obj.frames.length > 0) {
        // Remove the last frame
        obj.frames.pop();

        // Adjust pLDDT/PAE tracking indices if they point to the removed frame
        if (obj._lastPlddtFrame >= obj.frames.length) {
            obj._lastPlddtFrame = obj.frames.length - 1;
        }
        if (obj._lastPaeFrame >= obj.frames.length) {
            obj._lastPaeFrame = obj.frames.length - 1;
        }
    }
    // Add new frame properly using addFrame() to ensure correct processing
    renderer.addFrame(frame, objName);


    // Apply metadata using helper
    applyMetadataToObject(obj, meta);


    renderer._invalidateShadowCache();
    renderer.lastShadowRotationMatrix = null;

    if (renderer.currentObjectName === objName) {
        if (renderer.scatterRenderer) {
            renderer.updateScatterData(objName);
            renderer.updateScatterContainerVisibility();
        }
        // replace() swaps coordinates while object, frame index and length
        // all stay the same, so the cartoon caches must be cleared by hand:
        // their key cannot see the difference.
        renderer._invalidateSegmentCache();
        renderer.setFrame(obj.frames.length > 0 ? obj.frames.length - 1 : 0);
    }
};

// 12c. Mailbox-based incremental delivery (single-slot, overwrite-only)
const mailboxId = `py2dmol_live_${viewerId}`;
let mailboxSeq = -1;

const processMailbox = () => {
    const node = document.getElementById(mailboxId);
    if (!node) return;

    const raw = node.textContent || '';
    if (!raw.trim()) return;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch (e) {
        console.error('py2Dmol mailbox JSON parse error', e);
        return;
    }

    const seq = typeof payload.seq === 'number' ? payload.seq : -1;
    if (seq <= mailboxSeq) return;
    mailboxSeq = seq;

    const frames = payload.frames || payload.new_frames || {};
    const meta = payload.meta || payload.changed_meta || {};
    handleIncrementalStateUpdate(frames, meta, seq);
};

const mailboxObserver = new MutationObserver(() => processMailbox());

const startMailboxObserver = () => {
    const node = document.getElementById(mailboxId);
    if (!node) return false;
    mailboxObserver.disconnect();
    mailboxObserver.observe(node, { characterData: true, childList: true });
    processMailbox();
    return true;
};

// Observe document for mailbox creation/replacement (update_display swaps the node)
const mailboxRootObserver = new MutationObserver(() => {
    startMailboxObserver();
});
mailboxRootObserver.observe(document.body, { childList: true, subtree: true });

// Kick off once in case mailbox already exists
startMailboxObserver();

// 13. Expose Public API
// Use viewerId parameter passed to function
if (viewerId) {
    window.py2dmol_viewers[viewerId] = {
        handleIncrementalStateUpdate, // Primary: Memory-efficient incremental state updates
        handleReplaceFrame,
        renderer // Expose the renderer instance for external access
    };

    // BroadcastChannel for cross-iframe communication.
    //
    // COLAB PUTS EVERY CELL OUTPUT IN ITS OWN IFRAME, so the object registered
    // just above is invisible to the script an add() writes and the direct call
    // in it does nothing. This channel is the only way the two meet.
    try {
        const channel = new BroadcastChannel(`py2dmol_${viewerId}`);
        const thisInstanceId = 'viewer_' + Math.random().toString(36).substring(2, 15);

        // THE REPLAY WINDOW. BroadcastChannel does not retain: a cell output
        // that posted its frames before this viewer's channel was open lost
        // them for good. On a notebook REOPEN that is the normal case, not an
        // edge - every output iframe loads at once and the viewer's is half a
        // megabyte against an update cell's kilobyte.
        //
        // So the viewer announces itself and the update cells post again (see
        // _send_incremental_update in viewer.py). They arrive in whatever order
        // the iframes happen to run, and `seq` is a WATERMARK - an early frame
        // arriving after a later one is discarded as stale, which would drop
        // most of a trajectory. During the window they are therefore held and
        // applied in seq order. Outside it nothing is held and a live stream
        // pays nothing: in Jupyter the direct call has already applied the
        // update by the time its broadcast copy arrives, and seq dedups it.
        //
        // The sequence numbers are NOT contiguous - _emit_to_output spends one
        // of its own on each display_id, so a run of add() calls is 1, 3, 5 -
        // so this cannot wait for a gap to fill. It waits for the window.
        const REPLAY_MS = 800;
        let replayUntil = 0;
        let replayHeld = [];
        let replayTimer = null;
        const drainReplay = () => {
            replayTimer = null;
            const held = replayHeld.sort((a, b) => a.seq - b.seq);
            replayHeld = [];
            for (const m of held) m.apply();
        };
        const deliver = (seq, apply) => {
            const now = performance.now();
            if (now >= replayUntil) { apply(); return; }
            replayHeld.push({ seq: typeof seq === 'number' ? seq : -1, apply });
            if (!replayTimer) replayTimer = setTimeout(drainReplay, replayUntil - now);
        };

        // Announce, and hold whatever the announcement shakes loose
        replayUntil = performance.now() + REPLAY_MS;
        channel.postMessage({
            operation: 'viewerReady',
            sourceInstanceId: thisInstanceId
        });

        channel.onmessage = (event) => {
            const { operation, args, sourceInstanceId, seq } = event.data;

            // Ignore messages from this viewer instance (avoid echo)
            if (sourceInstanceId === thisInstanceId) return;

            if (operation === 'incrementalStateUpdate') {
                // Unpack new frames and changed metadata from args
                // ...and the viewer-level block, which older cell outputs
                // replayed from a saved notebook simply do not carry.
                const [newFramesByObject, changedMetadataByObject, viewerBlock] = args;
                deliver(seq, () => handleIncrementalStateUpdate(
                    newFramesByObject, changedMetadataByObject, seq,
                    viewerBlock || null));
            } else if (operation === 'replaceFrame') {
                const [frame, metaArg, objectName] = args;  // persistence no longer needed
                deliver(seq, () => handleReplaceFrame(frame, metaArg, objectName, seq));
            }
        };
    } catch (e) {
        // BroadcastChannel not supported
    }

} else {
    console.error("py2dmol: viewer_id not found in config. Cannot register API.");
}
}
