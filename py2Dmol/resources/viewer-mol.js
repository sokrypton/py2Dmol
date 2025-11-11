// ============================================================================
// GLOBAL REGISTRY
// ============================================================================
// Global registry for all viewer instances
if (!window.py2dmol_viewers) {
    window.py2dmol_viewers = {};
}

// ============================================================================
// SIMPLE CANVAS2SVG FOR PY2DMOL
// ============================================================================
// Minimal canvas2svg implementation for py2Dmol viewer.
// Only supports: lines (moveTo/lineTo/stroke), circles (arc/fill), rectangles (fillRect)

(function() {
    'use strict';

    function SimpleCanvas2SVG(width, height) {
        this.width = width;
        this.height = height;
        this.strokeStyle = '#000000';
        this.fillStyle = '#000000';
        this.lineWidth = 1;
        this.lineCap = 'butt';
        this.currentPath = null;
        this.operations = [];
    }

    // Path operations
    SimpleCanvas2SVG.prototype.beginPath = function() {
        this.currentPath = [];
    };
    
    SimpleCanvas2SVG.prototype.moveTo = function(x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'M', x: x, y: y });
    };
    
    SimpleCanvas2SVG.prototype.lineTo = function(x, y) {
        if (!this.currentPath) this.beginPath();
        this.currentPath.push({ type: 'L', x: x, y: y });
    };
    
    SimpleCanvas2SVG.prototype.arc = function(x, y, radius, startAngle, endAngle) {
        if (!this.currentPath) this.beginPath();
        // py2Dmol only uses full circles (0 to 2π)
        this.currentPath.push({ type: 'CIRCLE', x: x, y: y, radius: radius });
    };

    // Drawing operations
    SimpleCanvas2SVG.prototype.stroke = function() {
        if (!this.currentPath || this.currentPath.length === 0) return;
        
        let pathData = '';
        for (let i = 0; i < this.currentPath.length; i++) {
            const cmd = this.currentPath[i];
            if (cmd.type === 'M') pathData += `M ${cmd.x} ${cmd.y} `;
            else if (cmd.type === 'L') pathData += `L ${cmd.x} ${cmd.y} `;
        }
        
        this.operations.push({
            type: 'stroke',
            pathData: pathData.trim(),
            strokeStyle: this.strokeStyle,
            lineWidth: this.lineWidth,
            lineCap: this.lineCap
        });
        this.currentPath = null;
    };
    
    SimpleCanvas2SVG.prototype.fill = function() {
        if (!this.currentPath || this.currentPath.length === 0) return;
        
        // Check if single full circle (atoms)
        if (this.currentPath.length === 1 && this.currentPath[0].type === 'CIRCLE') {
            const c = this.currentPath[0];
            this.operations.push({
                type: 'circle',
                x: c.x,
                y: c.y,
                radius: c.radius,
                fillStyle: this.fillStyle
            });
        } else {
            // Path fill (shouldn't happen in py2Dmol, but handle it)
            let pathData = '';
            for (let i = 0; i < this.currentPath.length; i++) {
                const cmd = this.currentPath[i];
                if (cmd.type === 'M') pathData += `M ${cmd.x} ${cmd.y} `;
                else if (cmd.type === 'L') pathData += `L ${cmd.x} ${cmd.y} `;
            }
            this.operations.push({
                type: 'fill',
                pathData: pathData.trim(),
                fillStyle: this.fillStyle
            });
        }
        this.currentPath = null;
    };
    
    SimpleCanvas2SVG.prototype.fillRect = function(x, y, w, h) {
        this.operations.push({
            type: 'rect',
            x: x, y: y, width: w, height: h,
            fillStyle: this.fillStyle
        });
    };
    
    SimpleCanvas2SVG.prototype.clearRect = function() {
        // Ignore - we add white background in SVG
    };

    // Stub methods (not used in rendering)
    SimpleCanvas2SVG.prototype.save = function() {};
    SimpleCanvas2SVG.prototype.restore = function() {};
    SimpleCanvas2SVG.prototype.scale = function() {};
    SimpleCanvas2SVG.prototype.setTransform = function() {};
    SimpleCanvas2SVG.prototype.translate = function() {};
    SimpleCanvas2SVG.prototype.rotate = function() {};

    // Color conversion: rgb(r,g,b) -> #rrggbb
    function rgbToHex(color) {
        if (!color || color.startsWith('#')) return color || '#000000';
        const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (m) {
            const r = parseInt(m[1]).toString(16).padStart(2, '0');
            const g = parseInt(m[2]).toString(16).padStart(2, '0');
            const b = parseInt(m[3]).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        }
        return color;
    }

    // Generate SVG
    SimpleCanvas2SVG.prototype.getSerializedSvg = function() {
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">\n`;
        svg += `  <rect width="${this.width}" height="${this.height}" fill="#ffffff"/>\n`;
        
        for (let i = 0; i < this.operations.length; i++) {
            const op = this.operations[i];
            if (op.type === 'rect') {
                svg += `  <rect x="${op.x}" y="${op.y}" width="${op.width}" height="${op.height}" fill="${rgbToHex(op.fillStyle)}"/>\n`;
            } else if (op.type === 'circle') {
                svg += `  <circle cx="${op.x}" cy="${op.y}" r="${op.radius}" fill="${rgbToHex(op.fillStyle)}"/>\n`;
            } else if (op.type === 'stroke') {
                const cap = op.lineCap === 'round' ? 'round' : 'butt';
                svg += `  <path d="${op.pathData}" stroke="${rgbToHex(op.strokeStyle)}" stroke-width="${op.lineWidth}" stroke-linecap="${cap}" fill="none"/>\n`;
            } else if (op.type === 'fill') {
                svg += `  <path d="${op.pathData}" fill="${rgbToHex(op.fillStyle)}"/>\n`;
            }
        }
        svg += '</svg>';
        return svg;
    };

    // Export as C2S for compatibility with existing code
    if (typeof window !== 'undefined') {
        window.C2S = SimpleCanvas2SVG;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = SimpleCanvas2SVG;
    }

})();

// ============================================================================
// VIEWER INITIALIZATION
// ============================================================================

/**
 * Initializes a py2dmol viewer instance within a specific container.
 * All logic is scoped to this container.
 * @param {HTMLElement} containerElement The root <div> element for this viewer.
 */
function initializePy2DmolViewer(containerElement) {
    
    // Helper function to normalize ortho value from old (50-200) or new (0-1) format
    function normalizeOrthoValue(value) {
        if (typeof value !== 'number') return 1.0; // Default
        if (value >= 50 && value <= 200) {
            // Old format: convert 50-200 to 0-1
            return (value - 50) / 150;
        }
        if (value >= 0 && value <= 1) {
            // New format: already normalized
            return value;
        }
        return 0.5; // Default if out of range
    }

    // ============================================================================
    // VECTOR MATH
    // ============================================================================
    class Vec3 {
        constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
        add(v) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
        sub(v) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
        mul(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
        dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
        length() { return Math.sqrt(this.dot(this)); }
        distanceTo(v) { return this.sub(v).length(); }
        distanceToSq(v) { const s = this.sub(v); return s.dot(s); }
        normalize() { 
            const len = this.length(); 
            return len > 0 ? this.mul(1 / len) : new Vec3(0, 0, 1); 
        }
    }
    function rotationMatrixX(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [[1,0,0], [0,c,-s], [0,s,c]]; }
    function rotationMatrixY(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [[c,0,s], [0,1,0], [-s,0,c]]; }
    function multiplyMatrices(a, b) { const r = [[0,0,0],[0,0,0],[0,0,0]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j]; return r; }
    function applyMatrix(m, v) { return new Vec3(m[0][0]*v.x + m[0][1]*v.y + m[0][2]*v.z, m[1][0]*v.x + m[1][1]*v.y + m[1][2]*v.z, m[2][0]*v.x + m[2][1]*v.y + m[2][2]*v.z); }
    function sigmoid(x) { return 0.5 + x / (2 * (1 + Math.abs(x))); }
    // ============================================================================
    // COLOR UTILITIES
    // ============================================================================
    const pymolColors = ["#33ff33","#00ffff","#ff33cc","#ffff00","#ff9999","#e5e5e5","#7f7fff","#ff7f00","#7fff7f","#199999","#ff007f","#ffdd5e","#8c3f99","#b2b2b2","#007fff","#c4b200","#8cb266","#00bfbf","#b27f7f","#fcd1a5","#ff7f7f","#ffbfdd","#7fffff","#ffff7f","#00ff7f","#337fcc","#d8337f","#bfff3f","#ff7fff","#d8d8ff","#3fffbf","#b78c4c","#339933","#66b2b2","#ba8c84","#84bf00","#b24c66","#7f7f7f","#3f3fa5","#a5512b"];
    const colorblindSafeChainColors = ["#4e79a7", "#f28e2c", "#e15759", "#76b7b2", "#59a14f", "#edc949", "#af7aa1", "#ff9da7", "#9c755f", "#bab0ab"]; // Tableau 10
    function hexToRgb(hex) { if (!hex || typeof hex !== 'string') { return {r: 128, g: 128, b: 128}; } const r = parseInt(hex.slice(1,3), 16); const g = parseInt(hex.slice(3,5), 16); const b = parseInt(hex.slice(5,7), 16); return {r, g, b}; }
    function hsvToRgb(h, s, v) { const c = v * s; const x = c * (1 - Math.abs((h / 60) % 2 - 1)); const m = v - c; let r, g, b; if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; } return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }; }
    
    // N-term (blue) to C-term (red)
    function getRainbowColor(value, min, max) { 
        if (max - min < 1e-6) return hsvToRgb(240, 1.0, 1.0); // Default to blue
        let normalized = (value - min) / (max - min); 
        normalized = Math.max(0, Math.min(1, normalized)); 
        const hue = 240 * (1 - normalized); // 0 -> 240 (blue), 1 -> 0 (red)
        return hsvToRgb(hue, 1.0, 1.0); 
    }

    // 50 (red) to 90 (blue)
    function getPlddtRainbowColor(value, min, max) {
        if (max - min < 1e-6) return hsvToRgb(0, 1.0, 1.0); // Default to red
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        const hue = 240 * normalized; // 0 -> 0 (red), 1 -> 240 (blue)
        return hsvToRgb(hue, 1.0, 1.0);
    }

    // Cividis-like: N-term (blue) to C-term (yellow)
    function getRainbowColor_Colorblind(value, min, max) {
        if (max - min < 1e-6) return hsvToRgb(240, 1.0, 1.0); // Default to blue
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        // Interpolate hue from 240 (Blue) down to 60 (Yellow)
        const hue = 240 - normalized * 180;
        return hsvToRgb(hue, 1.0, 1.0);
    }
    
    // Cividis-like: 50 (yellow) to 90 (blue)
    function getPlddtRainbowColor_Colorblind(value, min, max) {
        if (max - min < 1e-6) return hsvToRgb(60, 1.0, 1.0); // Default to yellow
        let normalized = (value - min) / (max - min);
        normalized = Math.max(0, Math.min(1, normalized));
        // Interpolate hue from 60 (Yellow) to 240 (Blue)
        const hue = 60 + normalized * 180;
        return hsvToRgb(hue, 1.0, 1.0);
    }
    
    function getPlddtColor(plddt) { return getPlddtRainbowColor(plddt, 50, 90); }
    function getPlddtColor_Colorblind(plddt) { return getPlddtRainbowColor_Colorblind(plddt, 50, 90); }

    function getChainColor(chainIndex) { if (chainIndex < 0) chainIndex = 0; return hexToRgb(pymolColors[chainIndex % pymolColors.length]); }
    
    // PAE color functions moved to viewer-pae.js
    // Use window.getPAEColor and window.getPAEColor_Colorblind if available

    // ============================================================================
    // PSEUDO-3D RENDERER
    // ============================================================================
    class Pseudo3DRenderer {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            
            // Store screen positions of atoms for fast highlight drawing
            // Array of {x, y, radius} for each atom index, updated during render()
            // Used by sequence viewer to draw highlights on overlay canvas
            this.atomScreenPositions = null;
            
            // Unified cutoff for performance optimizations (inertia, caching, grid-based shadows)
            this.LARGE_MOLECULE_CUTOFF = 1000;
            
            // Store display dimensions (CSS size) for calculations
            // Internal resolution is scaled by devicePixelRatio, but we work in display pixels
            // Initialize cached dimensions (will be updated on resize)
            this.displayWidth = parseInt(canvas.style.width) || canvas.width;
            this.displayHeight = parseInt(canvas.style.height) || canvas.height;
            
            // Get config from Python
            // This relies on window.viewerConfig being available globally
            const config = window.viewerConfig || { 
                size: [300, 300], 
                pae_size: 300,
                color: "rainbow", 
                shadow: true, 
                outline: true,
                width: 3.0,
                rotate: false,
                controls: true,
                autoplay: false,
                box: true,
                pastel: 0.25,
                pae: false,
                colorblind: false
            };

            // Current render state
            this.coords = []; // This is now an array of Vec3 objects
            this.plddts = [];
            this.chains = [];
            this.atomTypes = [];
            
            // Viewer state - Color mode: auto, chain, rainbow, or plddt
            const validModes = ['auto', 'chain', 'rainbow', 'plddt'];
            this.colorMode = (config.color && validModes.includes(config.color)) ? config.color : 'auto';
            // Ensure it's always valid
            if (!this.colorMode || !validModes.includes(this.colorMode)) {
                this.colorMode = 'auto';
            }
            
            // What 'auto' resolves to (calculated when data loads)
            this.resolvedAutoColor = 'rainbow';
            this.rotationMatrix = [[1,0,0],[0,1,0],[0,0,1]];
            this.zoom = 1.0;
            this.lineWidth = (typeof config.width === 'number') ? config.width : 3.0;
            this.shadowIntensity = 0.95;
            // Perspective/orthographic projection state
            this.perspectiveEnabled = false; // false = orthographic, true = perspective
            this.focalLength = 200.0; // Will be set by ortho slider based on object size
            
            // Temporary center and extent for orienting to visible atoms
            this.temporaryCenter = null;
            this.temporaryExtent = null;
            
            // Set defaults from config, with fallback
            this.shadowEnabled = (typeof config.shadow === 'boolean') ? config.shadow : true;
            // Outline mode: 'none', 'partial', or 'full'
            if (typeof config.outline === 'string' && ['none', 'partial', 'full'].includes(config.outline)) {
                this.outlineMode = config.outline;
            } else if (typeof config.outline === 'boolean') {
                // Legacy boolean support: true -> 'full', false -> 'none'
                this.outlineMode = config.outline ? 'full' : 'none';
            } else {
                this.outlineMode = 'full'; // Default to full
            }
            this.pastelLevel = (typeof config.pastel === 'number') ? config.pastel : 0.25;
            this.colorblindMode = (typeof config.colorblind === 'boolean') ? config.colorblind : false;
            
            this.isTransparent = false; // Default to white background
            
            // Performance
            this.chainRainbowScales = {};
            this.perChainIndices = [];
            this.chainIndexMap = new Map(); // Initialize chain index map
            this.ligandOnlyChains = new Set(); // Chains that contain only ligands (no P/D/R atoms)
            this.rotatedCoords = []; 
            this.segmentIndices = []; 
            this.segData = []; 
            this.colors = []; 
            this.plddtColors = [];
            // Flags to track when color arrays need recalculation
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;

            // Animation & State
            this.objectsData = {};
            this.currentObjectName = null;
            this.previousObjectName = null; // Track previous object to detect changes
            this.currentFrame = -1;
            
            // Cache segment indices per frame (bonds don't change within a frame)
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesFrame = -1;
            this.cachedSegmentIndicesObjectName = null;
            
            // Playback
            this.isPlaying = false;
            this.animationSpeed = 100; // ms per frame
            this.frameAdvanceTimer = null; // Independent timer for frame advancement
            this.lastRenderedFrame = -1; // Track what frame was last rendered
            this.recordingFrameSequence = null; // Timeout ID for sequential recording
            
            // Interaction state
            this.isDragging = false; // Used for selection preview
            this.autoRotate = (typeof config.rotate === 'boolean') ? config.rotate : false;             
            this.autoplay = (typeof config.autoplay === 'boolean') ? config.autoplay : false;
            
            // Inertia
            this.spinVelocityX = 0;
            this.spinVelocityY = 0;
            this.lastDragTime = 0;
            this.lastDragX = 0;
            this.lastDragY = 0;
            this.zoomTimeout = null; // Timeout for clearing zoom flag
            
            // Touch
            this.initialPinchDistance = 0;

            // Track slider interaction
            this.isSliderDragging = false;
            
            // PAE and Visibility
            this.paeRenderer = null;
            this.visibilityMask = null; // Set of atom indices to *show*
            this.highlightedAtom = null; // To store atom index for highlighting
            this.highlightedAtoms = null; // To store Set of atom indices for highlighting multiple atoms

            // [PATCH] Unified selection model (sequence/chain + PAE)
            // atoms: Set of atom indices (0, 1, 2, ...) - one atom = one position
            // chains: Set of chain IDs (empty => all chains)
            // paeBoxes: Array of selection rectangles in PAE position space {i_start,i_end,j_start,j_end}
            // selectionMode: 'default' = empty selection means "show all" (initial state)
            //                'explicit' = empty selection means "show nothing" (user cleared)
            this.selectionModel = {
                atoms: new Set(), // Atom indices: 0, 1, 2, ... (one atom = one position)
                chains: new Set(),
                paeBoxes: [],
                selectionMode: 'default' // Start in default mode (show all)
            };

            // Ligand groups: Map of ligand group keys to arrays of atom indices
            // Computed when frame data is loaded, used by sequence and PAE viewers
            this.ligandGroups = new Map();

            // UI elements
            this.playButton = null;
            this.recordButton = null;
            this.saveSvgButton = null;
            this.frameSlider = null;
            this.frameCounter = null;
            this.objectSelect = null;
            this.controlsContainer = null;
            this.speedSelect = null;
            this.rotationCheckbox = null;
            this.lineWidthSlider = null;
            this.shadowEnabledCheckbox = null; 
            this.outlineModeButton = null; // Button that cycles through outline modes (index.html)
            this.outlineModeSelect = null; // Dropdown for outline modes (viewer.html)
            this.colorblindCheckbox = null;
            this.orthoSlider = null;
            
            // Recording state
            this.isRecording = false;
            this.mediaRecorder = null;
            this.recordedChunks = [];
            this.recordingStream = null;
            this.recordingEndFrame = 0;
            
            // Cache shadow/tint arrays during dragging for performance
            this.cachedShadows = null;
            this.cachedTints = null;
            this.isZooming = false; // Track zoom state to skip shadow recalculation

            this.setupInteraction();
        }

        setClearColor(isTransparent) {
            this.isTransparent = isTransparent;
            this.render(); // Re-render with new clear color
        }
        
        // [PATCH] --- Unified Selection API ---
        setSelection(patch) {
            if (!patch) return;
            if (patch.atoms !== undefined) {
                const a = patch.atoms;
                this.selectionModel.atoms = (a instanceof Set) ? new Set(a) : new Set(Array.from(a || []));
            }
            if (patch.chains !== undefined) {
                const c = patch.chains;
                this.selectionModel.chains = (c instanceof Set) ? new Set(c) : new Set(Array.from(c || []));
            }
            if (patch.paeBoxes !== undefined) {
                if (patch.paeBoxes === 'clear' || patch.paeBoxes === null) {
                    this.selectionModel.paeBoxes = [];
                } else if (Array.isArray(patch.paeBoxes)) {
                    this.selectionModel.paeBoxes = patch.paeBoxes.map(b => ({
                        i_start: Math.max(0, Math.floor(b.i_start ?? 0)),
                        i_end:   Math.max(0, Math.floor(b.i_end   ?? 0)),
                        j_start: Math.max(0, Math.floor(b.j_start ?? 0)),
                        j_end:   Math.max(0, Math.floor(b.j_end   ?? 0))
                    }));
                }
            }
            if (patch.selectionMode !== undefined) {
                this.selectionModel.selectionMode = patch.selectionMode;
            }
            this._composeAndApplyMask();
        }

        getSelection() {
            const m = this.selectionModel;
            return {
                atoms: new Set(m.atoms),
                chains: new Set(m.chains),
                paeBoxes: m.paeBoxes.map(b => ({...b})),
                selectionMode: m.selectionMode
            };
        }

        resetSelection() {
            this.selectionModel = { 
                atoms: new Set(), 
                chains: new Set(), 
                paeBoxes: [],
                selectionMode: 'default'
            };
            this._composeAndApplyMask();
        }

        // Reset to default state: show all atoms
        resetToDefault() {
            const n = this.coords ? this.coords.length : 0;
            if (n === 0) {
                this.resetSelection();
                return;
            }
            
            // Select all atoms (one atom = one position)
            const allAtoms = new Set();
            for (let i = 0; i < n; i++) {
                allAtoms.add(i);
            }
            
            // Select all chains
            const allChains = new Set(this.chains);
            
            // Clear PAE boxes when resetting to default (select all)
            this.setSelection({
                atoms: allAtoms,
                chains: allChains,
                paeBoxes: [],
                selectionMode: 'default'
            });
        }

        // Clear all selections: show nothing (explicit mode)
        clearSelection() {
            this.setSelection({
                atoms: new Set(),
                chains: new Set(),
                paeBoxes: [],
                selectionMode: 'explicit'
            });
        }

        _composeAndApplyMask() {
            const n = this.coords ? this.coords.length : 0;
            if (n === 0) {
                this.visibilityMask = null;
                this.render();
                return;
            }

            // (1) Atom/Chain contribution
            // Always compute atom selection - it works together with PAE via UNION
            let allowedChains;
            if (this.selectionModel.chains && this.selectionModel.chains.size > 0) {
                allowedChains = this.selectionModel.chains;
            } else {
                // All chains
                allowedChains = new Set(this.chains);
            }

            let seqAtoms = null;
            if ((this.selectionModel.atoms && this.selectionModel.atoms.size > 0) ||
                (this.selectionModel.chains && this.selectionModel.chains.size > 0)) {
                seqAtoms = new Set();
                for (let i = 0; i < n; i++) {
                    const ch = this.chains[i];
                    if (!allowedChains.has(ch)) continue;
                    // If atoms are explicitly selected, check if this atom is in the set
                    // If no atoms selected but chains are, include all atoms in allowed chains
                    if (this.selectionModel.atoms.size === 0 || this.selectionModel.atoms.has(i)) {
                        seqAtoms.add(i);
                    }
                }
            }

            // (2) PAE contribution: expand i/j ranges into atom indices
            // PAE boxes are in PAE position space (0, 1, 2, ... for PAE matrix)
            // If PAE data exists, it maps PAE positions to atom indices
            // For now, assume PAE positions directly map to atom indices (0, 1, 2, ...)
            // PAE may only cover subset of atoms (e.g., only polymer)
            // Handled by mapping PAE positions directly to atom indices
            let paeAtoms = null;
            if (this.selectionModel.paeBoxes && this.selectionModel.paeBoxes.length > 0) {
                paeAtoms = new Set();
                for (const box of this.selectionModel.paeBoxes) {
                    const i0 = Math.max(0, Math.min(n - 1, Math.min(box.i_start, box.i_end)));
                    const i1 = Math.max(0, Math.min(n - 1, Math.max(box.i_start, box.i_end)));
                    const j0 = Math.max(0, Math.min(n - 1, Math.min(box.j_start, box.j_end)));
                    const j1 = Math.max(0, Math.min(n - 1, Math.max(box.j_start, box.j_end)));
                    // PAE positions map directly to atom indices (one atom = one position)
                    for (let r = i0; r <= i1; r++) { 
                        if (r < n) paeAtoms.add(r); 
                    }
                    for (let r = j0; r <= j1; r++) { 
                        if (r < n) paeAtoms.add(r); 
                    }
                }
            }

            // (3) Combine via UNION
            let combined = null;
            if (seqAtoms && paeAtoms) {
                combined = new Set(seqAtoms);
                for (const a of paeAtoms) combined.add(a);
            } else {
                combined = seqAtoms || paeAtoms;
            }

            // (4) Apply based on selection mode
            const mode = this.selectionModel.selectionMode || 'default';
            if (combined && combined.size > 0) {
                // We have some selection - use it
                this.visibilityMask = combined;
            } else {
                // No selection computed
                if (mode === 'default') {
                    // Default mode: empty selection means "show all"
                    this.visibilityMask = null;
                } else {
                    // Explicit mode: empty selection means "show nothing"
                    this.visibilityMask = new Set(); // Empty set = nothing visible
                }
            }
            
            this.render();
            
            // Dispatch event to notify UI of selection change
            if (typeof document !== 'undefined') {
                try {
                    document.dispatchEvent(new CustomEvent('py2dmol-selection-change', {
                        detail: { 
                            hasSelection: this.visibilityMask !== null && this.visibilityMask.size > 0,
                            selectionModel: {
                                atoms: Array.from(this.selectionModel.atoms),
                                chains: Array.from(this.selectionModel.chains),
                                paeBoxes: this.selectionModel.paeBoxes.map(b => ({...b})),
                                selectionMode: this.selectionModel.selectionMode
                            }
                        }
                    }));
                } catch (e) {
                    console.warn('Failed to dispatch selection change event:', e);
                }
            }
        }
        // [END PATCH]
        
        // --- PAE / Visibility ---
        setPAERenderer(paeRenderer) {
            this.paeRenderer = paeRenderer;
        }
        
        // [PATCH] Re-routed setResidueVisibility to use the new unified selection model
        setResidueVisibility(selection) {
            if (selection === null) {
                // Clear only PAE contribution; leave sequence/chain selections intact
                this.setSelection({ paeBoxes: 'clear' });
            } else {
                const { i_start, i_end, j_start, j_end } = selection;
                this.setSelection({ paeBoxes: [{ i_start, i_end, j_start, j_end }] });
            }
        }
        // [END PATCH]
        
        _applyPastel(rgb) {
            if (this.pastelLevel <= 0) {
                return rgb;
            }
            // Apply pastel transformation (mix with white)
            const mix = this.pastelLevel; 
            return {
                r: Math.round(rgb.r * (1 - mix) + 255 * mix),
                g: Math.round(rgb.g * (1 - mix) + 255 * mix),
                b: Math.round(rgb.b * (1 - mix) + 255 * mix)
            };
        }

        setupInteraction() {
            // Add inertia logic
            this.canvas.addEventListener('mousedown', (e) => {
                // Only start dragging if we clicked directly on the canvas
                if (e.target !== this.canvas) return;
                
                this.isDragging = true;
                this.spinVelocityX = 0;
                this.spinVelocityY = 0;
                this.lastDragX = e.clientX;
                this.lastDragY = e.clientY;
                this.lastDragTime = performance.now();
                if (this.autoRotate) {
                    this.autoRotate = false;
                    if (this.rotationCheckbox) this.rotationCheckbox.checked = false;
                }
            });

            window.addEventListener('mousemove', (e) => {
                if (!this.isDragging) return;
                
                // Stop canvas drag if interacting with controls (cache tagName check)
                const tagName = e.target.tagName;
                if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'BUTTON') {
                    this.isDragging = false;
                    return;
                }
                
                const now = performance.now();
                const timeDelta = now - this.lastDragTime;

                const dx = e.clientX - this.lastDragX;
                const dy = e.clientY - this.lastDragY;

                // Only update rotation if there's actual movement
                if (dy !== 0 || dx !== 0) {
                    if (dy !== 0) { 
                        const rot = rotationMatrixX(dy * 0.01); 
                        this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); 
                    }
                    if (dx !== 0) { 
                        const rot = rotationMatrixY(dx * 0.01); 
                        this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); 
                    }
                } else {
                    return; // No movement, skip render
                }

                // Store velocity for inertia (disabled for large molecules based on visible segments)
                const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                const totalSegmentCount = object && object.frames && object.frames[this.currentFrame] 
                    ? (this.segmentIndices ? this.segmentIndices.length : 0)
                    : 0;
                // Count visible segments for inertia determination
                let visibleSegmentCount = totalSegmentCount;
                if (this.visibilityMask && this.segmentIndices) {
                    visibleSegmentCount = 0;
                    for (let i = 0; i < this.segmentIndices.length; i++) {
                        const seg = this.segmentIndices[i];
                        if (this.visibilityMask.has(seg.idx1) && this.visibilityMask.has(seg.idx2)) {
                            visibleSegmentCount++;
                        }
                    }
                }
                const enableInertia = visibleSegmentCount <= this.LARGE_MOLECULE_CUTOFF;
                
                if (enableInertia && timeDelta > 0) {
                    // Weighted average to smooth out jerky movements
                    const smoothing = 0.5;
                    this.spinVelocityX = (this.spinVelocityX * (1-smoothing)) + ((dx / timeDelta * 20) * smoothing);
                    this.spinVelocityY = (this.spinVelocityY * (1-smoothing)) + ((dy / timeDelta * 20) * smoothing);
                } else {
                    // Disable inertia for large objects
                    this.spinVelocityX = 0;
                    this.spinVelocityY = 0;
                }

                this.lastDragX = e.clientX;
                this.lastDragY = e.clientY;
                this.lastDragTime = now;
                
                this.render(); 
            });
            
            window.addEventListener('mouseup', () => {
                if (!this.isDragging) return;
                this.isDragging = false;
                
                // For large molecules, immediately recalculate shadows
                // since inertia is disabled and rotation has stopped
                const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                const segmentCount = object && this.segmentIndices ? this.segmentIndices.length : 0;
                const isLargeMolecule = segmentCount > this.LARGE_MOLECULE_CUTOFF;
                
                if (isLargeMolecule) {
                    // Clear shadow cache to force recalculation on next render
                    this.cachedShadows = null;
                    this.cachedTints = null;
                    // Render immediately with fresh shadows
                    this.render();
                } else {
                    // For small proteins, clear cache but let inertia handle the render
                    this.cachedShadows = null;
                    this.cachedTints = null;
                }
                
                // Restart animate loop after dragging ends
                requestAnimationFrame(() => this.animate());
                
                const now = performance.now();
                const timeDelta = now - this.lastDragTime;
                
                if (timeDelta > 100) { // If drag was too slow, or just a click
                    this.spinVelocityX = 0;
                    this.spinVelocityY = 0;
                }
                // Else, the velocity from the last mousemove is used by the animate loop
            });

            this.canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                this.isZooming = true;
                this.zoom *= (1 - e.deltaY * 0.001);
                this.zoom = Math.max(0.1, Math.min(5, this.zoom));
                this.render();
                // Clear zoom flag after a short delay to allow render to complete
                clearTimeout(this.zoomTimeout);
                this.zoomTimeout = setTimeout(() => {
                    this.isZooming = false;
                }, 100);
            }, { passive: false });


            // Touch Listeners
            
            this.canvas.addEventListener('touchstart', (e) => {
                e.preventDefault(); // Prevent page scroll
                
                if (e.touches.length === 1) {
                    // Start of a drag
                    this.isDragging = true;
                    this.spinVelocityX = 0;
                    this.spinVelocityY = 0;
                    this.lastDragX = e.touches[0].clientX;
                    this.lastDragY = e.touches[0].clientY;
                    this.lastDragTime = performance.now();
                    if (this.autoRotate) {
                        this.autoRotate = false;
                        if (this.rotationCheckbox) this.rotationCheckbox.checked = false;
                    }
                } else if (e.touches.length === 2) {
                    // Start of a pinch-zoom
                    this.isDragging = false; // Stop dragging
                    this.initialPinchDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
                }
            }, { passive: false });
            
            this.canvas.addEventListener('touchmove', (e) => {
                e.preventDefault(); // Prevent page scroll

                if (e.touches.length === 1 && this.isDragging) {
                    // Rotation/Drag
                    const now = performance.now();
                    const timeDelta = now - this.lastDragTime;
                    const touch = e.touches[0];

                    const dx = touch.clientX - this.lastDragX;
                    const dy = touch.clientY - this.lastDragY;
                    
                    if (dy !== 0) { const rot = rotationMatrixX(dy * 0.01); this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); }
                    if (dx !== 0) { const rot = rotationMatrixY(dx * 0.01); this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); }

                    // Store velocity for inertia (disabled for large molecules based on visible segments)
                    const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                    const totalSegmentCount = object && object.frames && object.frames[this.currentFrame] 
                        ? (this.segmentIndices ? this.segmentIndices.length : 0)
                        : 0;
                    // Count visible segments for inertia determination
                    let visibleSegmentCount = totalSegmentCount;
                    if (this.visibilityMask && this.segmentIndices) {
                        visibleSegmentCount = 0;
                        for (let i = 0; i < this.segmentIndices.length; i++) {
                            const seg = this.segmentIndices[i];
                            if (this.visibilityMask.has(seg.idx1) && this.visibilityMask.has(seg.idx2)) {
                                visibleSegmentCount++;
                            }
                        }
                    }
                    const enableInertia = visibleSegmentCount <= this.LARGE_MOLECULE_CUTOFF;
                    
                    if (enableInertia && timeDelta > 0) {
                        const smoothing = 0.5;
                        this.spinVelocityX = (this.spinVelocityX * (1-smoothing)) + ((dx / timeDelta * 20) * smoothing);
                        this.spinVelocityY = (this.spinVelocityY * (1-smoothing)) + ((dy / timeDelta * 20) * smoothing);
                    } else {
                        // Disable inertia for large objects
                        this.spinVelocityX = 0;
                        this.spinVelocityY = 0;
                    }

                    this.lastDragX = touch.clientX;
                    this.lastDragY = touch.clientY;
                    this.lastDragTime = now;
                    
                    this.render(); 
                } else if (e.touches.length === 2) {
                    // Zoom/Pinch
                    if (this.initialPinchDistance <= 0) return; // Not initialized
                    
                    this.isZooming = true;
                    const currentPinchDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
                    const scale = currentPinchDistance / this.initialPinchDistance;
                    
                    this.zoom *= scale;
                    this.zoom = Math.max(0.1, Math.min(5, this.zoom));
                    this.render();
                    
                    // Reset for next move event
                    this.initialPinchDistance = currentPinchDistance;
                    
                    // Clear zoom flag after a short delay
                    clearTimeout(this.zoomTimeout);
                    this.zoomTimeout = setTimeout(() => {
                        this.isZooming = false;
                    }, 100);
                }
            }, { passive: false });
            
            this.canvas.addEventListener('touchend', (e) => {
                // Handle inertia for drag
                if (e.touches.length === 0 && this.isDragging) {
                    this.isDragging = false;
                    
                    // For large molecules (based on visible segments), immediately recalculate shadows
                    // since inertia is disabled and rotation has stopped
                    const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                    const totalSegmentCount = object && this.segmentIndices ? this.segmentIndices.length : 0;
                    // Count visible segments
                    let visibleSegmentCount = totalSegmentCount;
                    if (this.visibilityMask && this.segmentIndices) {
                        visibleSegmentCount = 0;
                        for (let i = 0; i < this.segmentIndices.length; i++) {
                            const seg = this.segmentIndices[i];
                            if (this.visibilityMask.has(seg.idx1) && this.visibilityMask.has(seg.idx2)) {
                                visibleSegmentCount++;
                            }
                        }
                    }
                    const isLargeMolecule = visibleSegmentCount > this.LARGE_MOLECULE_CUTOFF;
                    
                    if (isLargeMolecule) {
                        // Clear shadow cache to force recalculation on next render
                        this.cachedShadows = null;
                        this.cachedTints = null;
                        // Render immediately with fresh shadows
                        this.render();
                    } else {
                        // For small proteins, clear cache but let inertia handle the render
                        this.cachedShadows = null;
                        this.cachedTints = null;
                    }
                    
                    // Restart animate loop after dragging ends (needed for inertia and auto-rotation)
                    requestAnimationFrame(() => this.animate());
                    
                    const now = performance.now();
                    const timeDelta = now - this.lastDragTime;
                    
                    if (timeDelta > 100) { // If drag was too slow, or just a tap
                        this.spinVelocityX = 0;
                        this.spinVelocityY = 0;
                    }
                    // Else, the velocity from the last touchmove is used by the animate loop
                }
                
                // Handle end of pinch
                if (e.touches.length < 2) {
                    this.initialPinchDistance = 0;
                }
                
                // If all touches are up, reset dragging
                if (e.touches.length === 0) {
                    this.isDragging = false;
                    // Restart animation loop if it was stopped
                    requestAnimationFrame(() => this.animate());
                }
            });
            
            this.canvas.addEventListener('touchcancel', (e) => {
                // Handle touch cancellation (e.g., system gesture interference)
                if (this.isDragging) {
                    this.isDragging = false;
                    // Restart animation loop
                    requestAnimationFrame(() => this.animate());
                }
                this.initialPinchDistance = 0;
            });
        }
        
        getTouchDistance(touch1, touch2) {
            const dx = touch1.clientX - touch2.clientX;
            const dy = touch1.clientY - touch2.clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        // Set UI controls from main script
        setUIControls(controlsContainer, playButton, recordButton, saveSvgButton, frameSlider, frameCounter, objectSelect, speedSelect, rotationCheckbox, lineWidthSlider, shadowEnabledCheckbox, outlineModeButton, outlineModeSelect, colorblindCheckbox, orthoSlider) {
            this.controlsContainer = controlsContainer;
            this.playButton = playButton;
            this.recordButton = recordButton;
            this.saveSvgButton = saveSvgButton;
            this.frameSlider = frameSlider;
            this.frameCounter = frameCounter;
            this.objectSelect = objectSelect;
            this.speedSelect = speedSelect;
            this.rotationCheckbox = rotationCheckbox;
            this.lineWidthSlider = lineWidthSlider;
            this.shadowEnabledCheckbox = shadowEnabledCheckbox; 
            this.outlineModeButton = outlineModeButton;
            this.outlineModeSelect = outlineModeSelect;
            this.colorblindCheckbox = colorblindCheckbox;
            this.orthoSlider = orthoSlider;
            this.lineWidth = parseFloat(this.lineWidthSlider.value); // Read default from slider
            this.autoRotate = this.rotationCheckbox.checked; // Read default from checkbox

            // Bind all event listeners
            this.playButton.addEventListener('click', () => {
                this.togglePlay();
            });
            
            if (this.recordButton) {
                this.recordButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleRecording();
                });
            } else {
                console.warn("Record button not found - recording will not be available");
            }
            
            if (this.saveSvgButton) {
                this.saveSvgButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.saveAsSvg();
                });
            }

            if (this.objectSelect) {
                this.objectSelect.addEventListener('change', () => {
                    this.stopAnimation();
                    const newObjectName = this.objectSelect.value;
                    // Skip if already on this object (e.g., during initial load)
                    if (this.currentObjectName === newObjectName) {
                        return;
                    }
                    // Track object change for selection reset
                    this.previousObjectName = this.currentObjectName;
                    // Clear selection when switching objects (selection is per-object)
                    this.clearSelection();
                    this.currentObjectName = newObjectName;
                    this.setFrame(0);
                    // setFrame will call resetToDefault() after loading new object data
                    
                    // Update PAE container visibility based on current object
                    this.updatePAEContainerVisibility();
                });
            }

            this.speedSelect.addEventListener('change', (e) => {
                const wasPlaying = this.isPlaying;
                this.animationSpeed = parseInt(e.target.value);
                
                // If animation is playing, restart timer with new speed
                if (wasPlaying) {
                    this.stopAnimation();
                    this.startAnimation();
                }
            });

            this.rotationCheckbox.addEventListener('change', (e) => {
                this.autoRotate = e.target.checked;
                // Stop inertia if user clicks auto-rotate
                this.spinVelocityX = 0;
                this.spinVelocityY = 0;
            });

            this.lineWidthSlider.addEventListener('input', (e) => {
                this.lineWidth = parseFloat(e.target.value);
                if (!this.isPlaying) {
                    this.render();
                }
            });

            // Ortho slider: controls perspective/orthographic projection
            // Value range: 0.0 (strongest perspective) to 1.0 (full orthographic)
            if (this.orthoSlider) {
                // Constants for perspective focal length calculation
                const PERSPECTIVE_MIN_MULT = 1.5;  // Closest camera (strongest perspective)
                const PERSPECTIVE_MAX_MULT = 20.0; // Farthest camera (weakest perspective)
                const STD_DEV_MULT = 2.0;           // Use stdDev * 2.0 as base size measure
                const DEFAULT_SIZE = 30.0;         // Fallback if no object loaded
                
                this.orthoSlider.addEventListener('input', (e) => {
                    const normalizedValue = parseFloat(e.target.value);
                    
                    // Get object size using standard deviation from center
                    const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                    let baseSize = DEFAULT_SIZE;
                    if (object && object.stdDev > 0) {
                        // Use standard deviation * 3.0 as the base size measure
                        baseSize = object.stdDev * STD_DEV_MULT;
                    } else if (object && object.maxExtent > 0) {
                        // Fallback to maxExtent if stdDev not available
                        baseSize = object.maxExtent;
                    }

                    if (normalizedValue >= 1.0) {
                        // Orthographic mode: no perspective
                        this.perspectiveEnabled = false;
                        this.focalLength = baseSize * PERSPECTIVE_MAX_MULT;
                    } else {
                        // Perspective mode: interpolate focal length based on slider value
                        const multiplier = PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * normalizedValue;
                        this.perspectiveEnabled = true;
                        this.focalLength = baseSize * multiplier;
                    }
                    
                    if (!this.isPlaying) {
                        this.render();
                    }
                });
            }


            if (this.shadowEnabledCheckbox) {
                this.shadowEnabledCheckbox.addEventListener('change', (e) => {
                    this.shadowEnabled = e.target.checked;
                    this.render();
                });
            }

            if (this.outlineModeButton) {
                // Button mode (index.html) - cycles through modes
                this.outlineModeButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    // Cycle through modes: none -> partial -> full -> none
                    if (this.outlineMode === 'none') {
                        this.outlineMode = 'partial';
                    } else if (this.outlineMode === 'partial') {
                        this.outlineMode = 'full';
                    } else { // full
                        this.outlineMode = 'none';
                    }
                    this.updateOutlineButtonStyle();
                    this.render();
                });
                // Initialize button style
                this.updateOutlineButtonStyle();
            } else if (this.outlineModeSelect) {
                // Dropdown mode (viewer.html) - already handled in initialization
                this.outlineModeSelect.value = this.outlineMode || 'full';
            }
            
            if (this.colorblindCheckbox) {
                this.colorblindCheckbox.addEventListener('change', (e) => {
                    this.colorblindMode = e.target.checked;
                    // Mark colors as needing update - will be recalculated on next render
                    this.colorsNeedUpdate = true;
                    this.plddtColorsNeedUpdate = true;
                    // Re-render main canvas
                    this.render();
                    // Dispatch event to notify sequence viewer
                    document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
                    // Re-render PAE canvas
                    if (this.paeRenderer) {
                        this.paeRenderer.render();
                    }
                });
            }
            

            // Prevent canvas drag from interfering with slider
            const handleSliderChange = (e) => {
                this.stopAnimation();
                this.setFrame(parseInt(e.target.value));
            };

            // Track when user is interacting with slider
            this.frameSlider.addEventListener('mousedown', (e) => {
                this.isDragging = false;
                this.isSliderDragging = true;
                e.stopPropagation();
            });
            
            this.frameSlider.addEventListener('mouseup', (e) => {
                this.isSliderDragging = false;
            });
            
            // Also clear on window mouseup in case user releases outside slider
            window.addEventListener('mouseup', () => {
                this.isSliderDragging = false;
            });
            
            this.frameSlider.addEventListener('input', handleSliderChange);
            this.frameSlider.addEventListener('change', handleSliderChange);
            
            // Also prevent canvas drag when interacting with other controls
            const allControls = [this.playButton, this.objectSelect, this.speedSelect,
                                 this.rotationCheckbox, this.lineWidthSlider, 
                                 this.shadowEnabledCheckbox, this.outlineModeButton, this.outlineModeSelect,
                                 this.colorblindCheckbox, this.orthoSlider];
            allControls.forEach(control => {
                if (control) {
                    control.addEventListener('mousedown', (e) => {
                        this.isDragging = false;
                        e.stopPropagation();
                    });
                }
            });
        }

        // Add a new object
        addObject(name) {
            this.stopAnimation();
            
            // If object with same name already exists, clear it instead of creating duplicate
            const objectExists = this.objectsData[name] !== undefined;
            if (objectExists) {
                // Clear existing object data
                this.objectsData[name].frames = [];
                this.objectsData[name].maxExtent = 0;
                this.objectsData[name].stdDev = 0;
                this.objectsData[name].globalCenterSum = new Vec3(0,0,0);
                this.objectsData[name].totalAtoms = 0;
            } else {
                // Create new object
                this.objectsData[name] = { maxExtent: 0, stdDev: 0, frames: [], globalCenterSum: new Vec3(0,0,0), totalAtoms: 0 };
                
                // Add to dropdown only if option doesn't already exist
                if (this.objectSelect) {
                    const existingOption = Array.from(this.objectSelect.options).find(opt => opt.value === name);
                    if (!existingOption) {
                        const option = document.createElement('option');
                        option.value = name;
                        option.textContent = name;
                        this.objectSelect.appendChild(option);
                    }
                }
            }
            
            this.currentObjectName = name;
            this.currentFrame = -1;
            this.lastRenderedFrame = -1; // Reset frame tracking on object change
            
            // Clear segment indices cache when object changes
            this.cachedSegmentIndices = null;
            this.cachedSegmentIndicesFrame = -1;
            this.cachedSegmentIndicesObjectName = null;
            
            if (this.objectSelect) {
                this.objectSelect.value = name;
            }

            this.setFrame(-1);
        }

        // Add a frame (data is raw parsed JSON)
        addFrame(data, objectName) {
            
            let targetObjectName = objectName;
            if (!targetObjectName) {
                console.warn("addFrame called without objectName, using current view.");
                targetObjectName = this.currentObjectName;
            }
            
            if (!targetObjectName) {
                // This can happen if addFrame is called before new_obj
                console.warn("addFrame: No object active. Creating '0'.");
                this.addObject("0");
                targetObjectName = "0";
            }
            
            if (!this.objectsData[targetObjectName]) {
                 console.error(`addFrame: Object '${targetObjectName}' does not exist.`);
                 console.warn(`addFrame: Object '${targetObjectName}' not found. Creating it.`);
                 this.addObject(targetObjectName);
            }

            const object = this.objectsData[targetObjectName];
            object.frames.push(data);

            // Set view to this object
            if (this.currentObjectName !== targetObjectName) {
                this.stopAnimation(); // Stop if playing on another obj
                this.currentObjectName = targetObjectName;
                this.lastRenderedFrame = -1; // Reset frame tracking on object change
                if (this.objectSelect) {
                    this.objectSelect.value = targetObjectName;
                }
            }

            // Update global center sum and count (from all atoms for viewing)
            let frameSum = new Vec3(0,0,0);
            let frameAtoms = 0;
            if (data && data.coords) {
                frameAtoms = data.coords.length;
                for (let i = 0; i < data.coords.length; i++) {
                    const c = data.coords[i];
                    frameSum = frameSum.add(new Vec3(c[0], c[1], c[2]));
                }
                object.globalCenterSum = object.globalCenterSum.add(frameSum);
                object.totalAtoms += frameAtoms;
            }
            
            const globalCenter = (object.totalAtoms > 0) ? object.globalCenterSum.mul(1 / object.totalAtoms) : new Vec3(0,0,0);

            // Recalculate maxExtent and standard deviation for all frames using the new global center
            let maxDistSq = 0;
            let sumDistSq = 0;
            let atomCount = 0;
            for (const frame of object.frames) {
                if (frame && frame.coords) {
                    for (let i = 0; i < frame.coords.length; i++) {
                        const c = frame.coords[i];
                        const coordVec = new Vec3(c[0], c[1], c[2]);
                        const centeredCoord = coordVec.sub(globalCenter);
                        const distSq = centeredCoord.dot(centeredCoord);
                        if (distSq > maxDistSq) maxDistSq = distSq;
                        sumDistSq += distSq;
                        atomCount++;
                    }
                }
            }
            object.maxExtent = Math.sqrt(maxDistSq);
            // Calculate standard deviation: sqrt(mean of squared distances)
            object.stdDev = atomCount > 0 ? Math.sqrt(sumDistSq / atomCount) : 0;

            if (!this.isPlaying) {
                this.setFrame(object.frames.length - 1);
            }
            this.updateUIControls();
            
            // Update PAE container visibility when frames are added
            this.updatePAEContainerVisibility();
            
            // If this is the first frame being loaded, we need to
            // Recalculate focal length if perspective is enabled and object size changed
            if (object.frames.length === 1 && this.perspectiveEnabled && this.orthoSlider) {
                this.orthoSlider.dispatchEvent(new Event('input'));
            }

            // Handle autoplay
            if (this.autoplay && !this.isPlaying && this.currentObjectName) {
                // Check if the current object now has multiple frames
                const obj = this.objectsData[this.currentObjectName];
                if (obj && obj.frames.length > 1) {
                    this.startAnimation();
                }
            }
        }

        // Extract current selection to a new object
        extractSelection() {
            // Check if we have a current object and frame
            if (!this.currentObjectName) {
                console.warn("No object loaded. Cannot extract selection.");
                return;
            }

            const object = this.objectsData[this.currentObjectName];
            if (!object || !object.frames || object.frames.length === 0) {
                console.warn("No frames available. Cannot extract selection.");
                return;
            }

            // Use first frame to determine selection (selection is frame-independent)
            const firstFrame = object.frames[0];
            if (!firstFrame || !firstFrame.coords) {
                console.warn("First frame has no coordinates. Cannot extract selection.");
                return;
            }

            // Get selected atoms (selection is frame-independent, so use first frame to determine indices)
            let selectedAtoms = new Set();
            
            // Check selectionModel first (explicit selection)
            if (this.selectionModel && this.selectionModel.atoms && this.selectionModel.atoms.size > 0) {
                selectedAtoms = new Set(this.selectionModel.atoms);
            } else if (this.visibilityMask !== null && this.visibilityMask.size > 0) {
                // Use visibilityMask if available
                selectedAtoms = new Set(this.visibilityMask);
            } else {
                // No selection - all atoms visible (could extract all, but warn user)
                console.warn("No selection found. All atoms are visible. Extracting all atoms.");
                // Extract all atoms
                for (let i = 0; i < firstFrame.coords.length; i++) {
                    selectedAtoms.add(i);
                }
            }

            if (selectedAtoms.size === 0) {
                console.warn("Selection is empty. Cannot extract.");
                return;
            }

            // Convert to sorted array for consistent ordering
            const selectedIndices = Array.from(selectedAtoms).sort((a, b) => a - b);

            // Generate object name with chain ranges: name_A1-100_B10-20 or name_A_B (if entire chains)
            const baseName = this.currentObjectName;
            
            // Group selected atoms by chain and find residue ranges (use first frame for naming)
            const chainRanges = new Map(); // chain -> {min, max, selectedCount, totalCount}
            
            // First, count total atoms per chain in original frame
            const chainTotalCounts = new Map(); // chain -> total atom count
            if (firstFrame.chains) {
                for (let i = 0; i < firstFrame.chains.length; i++) {
                    const chain = firstFrame.chains[i];
                    chainTotalCounts.set(chain, (chainTotalCounts.get(chain) || 0) + 1);
                }
            }
            
            // Then, count selected atoms per chain and find ranges
            const chainSelectedCounts = new Map(); // chain -> selected atom count
            if (firstFrame.chains && firstFrame.residue_index) {
                for (const idx of selectedIndices) {
                    if (idx < firstFrame.chains.length && idx < firstFrame.residue_index.length) {
                        const chain = firstFrame.chains[idx];
                        const resIdx = firstFrame.residue_index[idx];
                        
                        chainSelectedCounts.set(chain, (chainSelectedCounts.get(chain) || 0) + 1);
                        
                        if (!chainRanges.has(chain)) {
                            chainRanges.set(chain, { min: resIdx, max: resIdx });
                        } else {
                            const range = chainRanges.get(chain);
                            range.min = Math.min(range.min, resIdx);
                            range.max = Math.max(range.max, resIdx);
                        }
                    }
                }
            }
            
            // Build name with chain ranges (or just chain IDs if entire chains are selected)
            let extractName = baseName;
            if (chainRanges.size > 0) {
                const chainParts = [];
                // Sort chains for consistent ordering
                const sortedChains = Array.from(chainRanges.keys()).sort();
                for (const chain of sortedChains) {
                    const range = chainRanges.get(chain);
                    const selectedCount = chainSelectedCounts.get(chain) || 0;
                    const totalCount = chainTotalCounts.get(chain) || 0;
                    
                    // If entire chain is selected, just use chain ID
                    if (selectedCount === totalCount && totalCount > 0) {
                        chainParts.push(chain);
                    } else {
                        // Partial selection, use range format
                        chainParts.push(`${chain}${range.min}-${range.max}`);
                    }
                }
                extractName = `${baseName}_${chainParts.join('_')}`;
            } else {
                // Fallback if no chain/residue info
                extractName = `${baseName}_extracted`;
            }
            
            // Ensure unique name
            let originalExtractName = extractName;
            let extractCounter = 1;
            while (this.objectsData[extractName] !== undefined) {
                extractName = `${originalExtractName}_${extractCounter}`;
                extractCounter++;
            }

            // Create new object
            this.addObject(extractName);

            // Extract all frames, not just the current one
            for (let frameIndex = 0; frameIndex < object.frames.length; frameIndex++) {
                const frame = object.frames[frameIndex];
                if (!frame || !frame.coords) {
                    continue; // Skip invalid frames
                }

                // Extract frame data for selected atoms
                const extractedFrame = {
                    coords: [],
                    chains: frame.chains ? [] : undefined,
                    plddts: frame.plddts ? [] : undefined,
                    atom_types: frame.atom_types ? [] : undefined,
                    residues: frame.residues ? [] : undefined,
                    residue_index: frame.residue_index ? [] : undefined,
                    pae: undefined // Will be handled separately
                };

                // Extract data for each selected atom
                for (const idx of selectedIndices) {
                    if (idx >= 0 && idx < frame.coords.length) {
                        extractedFrame.coords.push(frame.coords[idx]);
                        
                        if (frame.chains && idx < frame.chains.length) {
                            extractedFrame.chains.push(frame.chains[idx]);
                        }
                        if (frame.plddts && idx < frame.plddts.length) {
                            extractedFrame.plddts.push(frame.plddts[idx]);
                        }
                        if (frame.atom_types && idx < frame.atom_types.length) {
                            extractedFrame.atom_types.push(frame.atom_types[idx]);
                        }
                        if (frame.residues && idx < frame.residues.length) {
                            extractedFrame.residues.push(frame.residues[idx]);
                        }
                        if (frame.residue_index && idx < frame.residue_index.length) {
                            extractedFrame.residue_index.push(frame.residue_index[idx]);
                        }
                    }
                }

                // Filter PAE matrix if present (copy PAE for all frames if available)
                if (frame.pae && Array.isArray(frame.pae) && frame.pae.length > 0) {
                    // Create new PAE matrix with only selected positions
                    const newPAE = [];
                    for (let i = 0; i < selectedIndices.length; i++) {
                        const row = [];
                        for (let j = 0; j < selectedIndices.length; j++) {
                            const originalI = selectedIndices[i];
                            const originalJ = selectedIndices[j];
                            if (originalI < frame.pae.length && originalJ < frame.pae[originalI].length) {
                                row.push(frame.pae[originalI][originalJ]);
                            } else {
                                row.push(0); // Default value if out of bounds
                            }
                        }
                        newPAE.push(row);
                    }
                    extractedFrame.pae = newPAE;
                }

                // Add extracted frame to new object
                this.addFrame(extractedFrame, extractName);
            }

            // Reset selection to show all atoms in extracted object
            this.setSelection({
                atoms: new Set(),
                chains: new Set(),
                paeBoxes: [],
                selectionMode: 'default'
            });

            // Update UI controls to reflect new object
            this.updateUIControls();

            // Update PAE container visibility
            this.updatePAEContainerVisibility();

            // Force sequence viewer to rebuild for the new object
            if (typeof window !== 'undefined' && window.SequenceViewer && window.SequenceViewer.buildSequenceView) {
                // Clear sequence viewer cache to force rebuild
                if (window.SequenceViewer.clear) {
                    window.SequenceViewer.clear();
                }
                // Rebuild sequence view for the new extracted object
                window.SequenceViewer.buildSequenceView();
            }

            // Trigger object change event to ensure all UI updates
            if (this.objectSelect) {
                this.objectSelect.dispatchEvent(new Event('change'));
            }

            console.log(`Extracted ${selectedIndices.length} atoms from ${object.frames.length} frame(s) to new object: ${extractName}`);
        }

        // Set the current frame and render it
        setFrame(frameIndex) {
            frameIndex = parseInt(frameIndex);
            
            // Handle clearing the canvas based on transparency
            const clearCanvas = () => {
                // Use cached display dimensions
                const displayWidth = this.displayWidth;
                const displayHeight = this.displayHeight;
                if (this.isTransparent) {
                    this.ctx.clearRect(0, 0, displayWidth, displayHeight);
                } else {
                    this.ctx.fillStyle = '#ffffff';
                    this.ctx.fillRect(0, 0, displayWidth, displayHeight);
                }
            };
            
            // Handle null object name
            if (!this.currentObjectName) {
                this.currentFrame = -1;
                this.coords = [];
                clearCanvas();
                if (this.paeRenderer) { this.paeRenderer.setData(null); }
                this.updateUIControls();
                // Prevent "spinning wheel" on reload
                this.setUIEnabled(true); 
                return;
            }

            const object = this.objectsData[this.currentObjectName];
            if (!object || frameIndex < 0 || frameIndex >= object.frames.length) {
                this.currentFrame = -1;
                this.coords = [];
                clearCanvas();
                if (this.paeRenderer) { this.paeRenderer.setData(null); }
                this.updateUIControls();
                this.setUIEnabled(true); // Enable, even if frame is invalid (so user can change obj)
                return;
            }

            this.currentFrame = frameIndex;
            
            // Load frame data and render immediately for manual frame changes (e.g., slider)
            this._loadFrameData(frameIndex, true); // Load without render
            this.render(); // Render once
            this.lastRenderedFrame = frameIndex;
            
            // Update PAE container visibility
            this.updatePAEContainerVisibility();
            
            this.setUIEnabled(true); // Make sure controls are enabled
        }
        
        // Check if PAE data is valid
        _isValidPAE(pae) {
            return pae && Array.isArray(pae) && pae.length > 0;
        }
        
        // Find PAE container with fallback logic
        _findPAEContainer() {
            if (this.paeContainer) return this.paeContainer;
            
            if (this.canvas && this.canvas.parentElement) {
                const mainContainer = this.canvas.parentElement.closest('#mainContainer');
                if (mainContainer) {
                    this.paeContainer = mainContainer.querySelector('#paeContainer');
                    if (this.paeContainer) return this.paeContainer;
                }
            }
            
            this.paeContainer = document.querySelector('#paeContainer');
            return this.paeContainer;
        }
        
        // Check if an object has PAE data (can be called with object name or uses current object)
        objectHasPAE(objectName = null) {
            const name = objectName || this.currentObjectName;
            if (!name || !this.objectsData[name]) return false;
            
            const object = this.objectsData[name];
            if (!object.frames || object.frames.length === 0) return false;
            
            // Check if any frame has valid PAE data
            return object.frames.some(frame => this._isValidPAE(frame.pae));
        }
        
        // Update PAE container visibility based on current object's PAE data
        updatePAEContainerVisibility() {
            const paeContainer = this._findPAEContainer();
            if (!paeContainer) return;
            
            const hasPAE = this.objectHasPAE();
            paeContainer.style.display = hasPAE ? 'flex' : 'none';
            
            const paeCanvas = paeContainer.querySelector('#paeCanvas');
            if (paeCanvas) {
                paeCanvas.style.display = hasPAE ? 'block' : 'none';
            }
        }

        // Update outline button style based on current mode
        updateOutlineButtonStyle() {
            if (!this.outlineModeButton) return;
            
            // Get the inner span element (the actual styled element)
            const spanElement = this.outlineModeButton.querySelector('span');
            if (!spanElement) return;
            
            // Remove all mode classes from button
            this.outlineModeButton.classList.remove('outline-none', 'outline-partial', 'outline-full');
            
            // Reset all inline styles first (on the span, not the button)
            spanElement.style.backgroundColor = '';
            spanElement.style.border = '';
            spanElement.style.color = '';
            spanElement.style.fontWeight = '';
            spanElement.style.transition = 'none'; // Disable animations
            
            // Apply appropriate class and style based on mode
            // All modes use grey background, only border style differs
            if (this.outlineMode === 'none') {
                this.outlineModeButton.classList.add('outline-none');
                spanElement.style.backgroundColor = '#e5e7eb'; // light grey background
                spanElement.style.border = '3px solid #e5e7eb'; // match background color to make border invisible
                spanElement.style.color = '#000000';
                spanElement.style.fontWeight = '500';
            } else if (this.outlineMode === 'partial') {
                this.outlineModeButton.classList.add('outline-partial');
                spanElement.style.backgroundColor = '#e5e7eb'; // grey background
                spanElement.style.border = '3px dashed #000000';
                spanElement.style.color = '#000000';
                spanElement.style.fontWeight = '500';
            } else { // full
                this.outlineModeButton.classList.add('outline-full');
                spanElement.style.backgroundColor = '#e5e7eb'; // grey background
                spanElement.style.border = '3px solid #000000';
                spanElement.style.color = '#000000';
                spanElement.style.fontWeight = '500';
            }
        }

        // Update UI element states (e.g., disabled)
        setUIEnabled(enabled) {
             this.playButton.disabled = !enabled;
             this.frameSlider.disabled = !enabled;
             if (this.objectSelect) this.objectSelect.disabled = !enabled;
             this.speedSelect.disabled = !enabled;
             this.rotationCheckbox.disabled = !enabled;
             this.lineWidthSlider.disabled = !enabled;
             if (this.shadowEnabledCheckbox) this.shadowEnabledCheckbox.disabled = !enabled;
             if (this.outlineModeButton) this.outlineModeButton.disabled = !enabled;
             if (this.outlineModeSelect) this.outlineModeSelect.disabled = !enabled;
             if (this.colorblindCheckbox) this.colorblindCheckbox.disabled = !enabled;
             if (this.orthoSlider) this.orthoSlider.disabled = !enabled;
             this.canvas.style.cursor = enabled ? 'grab' : 'wait';
        }

        // Update the text/slider values
        updateUIControls() {
            if (!this.playButton) return;

            // Handle null object
            const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
            const total = object ? object.frames.length : 0;
            const current = Math.max(0, this.currentFrame) + 1;

            // Check config.controls before showing
            const config = window.viewerConfig || {};
            if (total <= 1 || !config.controls) {
                this.controlsContainer.style.display = 'none';
            } else {
                this.controlsContainer.style.display = 'flex';
            }
            
            // Get container element from canvas (for finding parent containers)
            const containerElement = this.canvas ? this.canvas.closest('.py2dmol-container') || 
                this.canvas.parentElement?.closest('#mainContainer')?.parentElement : null;
            
            // Count number of objects
            const objectCount = Object.keys(this.objectsData).length;
            
            // Handle object selection dropdown visibility
            if (this.objectSelect) {
                // Hide object dropdown if only 1 object
                const objectSelectParent = this.objectSelect.closest('.toggle-item') || 
                                          this.objectSelect.parentElement;
                if (objectSelectParent) {
                    objectSelectParent.style.display = (objectCount <= 1) ? 'none' : 'flex';
                }
                
                // Also handle container visibility (for backward compatibility)
                if (containerElement) {
                    const mainControlsContainer = containerElement.querySelector('#mainControlsContainer');
                    const objectContainer = containerElement.querySelector('#objectContainer');
                    
                    // Prioritize new structure, then old structure
                    // Don't hide styleAppearanceContainer as it contains other controls in index.html
                    const containerToShow = mainControlsContainer || objectContainer;
                    if (containerToShow) {
                        // Always show if controls are enabled (regardless of number of objects)
                        containerToShow.style.display = config.controls ? 'flex' : 'none';
                    }
                }
            }

            this.frameSlider.max = Math.max(0, total - 1);
            
            // Don't update slider value while user is dragging it
            if (!this.isSliderDragging) {
                this.frameSlider.value = this.currentFrame;
            }
            
            this.frameCounter.textContent = `Frame: ${total > 0 ? current : 0} / ${total}`;
            // Update play button - use icons if available (web version), otherwise use text (Colab)
            if (this.playButton) {
                const hasIcon = this.playButton.querySelector('i');
                if (hasIcon) {
                    // Web version with Font Awesome - use icons
                    this.playButton.innerHTML = this.isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
                } else {
                    // Colab version without Font Awesome - use text
                    this.playButton.textContent = this.isPlaying ? 'Pause' : 'Play';
                }
            }
            
            // Update record button
            if (this.recordButton) {
                const span = this.recordButton.querySelector('span');
                if (span) {
                    if (this.isRecording) {
                        span.innerHTML = '<i class="fa-solid fa-stop"></i>';
                        span.style.background = '#ef4444';
                        span.style.color = '#fff';
                    } else {
                        span.innerHTML = '<i class="fa-solid fa-video"></i>';
                        span.style.background = '#e5e7eb';
                        span.style.color = '#374151';
                    }
                }
                const canRecord = this.currentObjectName && 
                    this.objectsData[this.currentObjectName] && 
                    this.objectsData[this.currentObjectName].frames.length >= 2;
                this.recordButton.disabled = !canRecord;
                
                // Hide record button if only 1 frame
                // Try to find .toggle-item parent first (viewer.html structure)
                const recordButtonParent = this.recordButton.closest('.toggle-item');
                if (recordButtonParent) {
                    // viewer.html: hide the toggle-item container
                    recordButtonParent.style.display = (total <= 1) ? 'none' : 'flex';
                } else {
                    // index.html: hide the button itself (it's in a toolbar row with other buttons)
                    this.recordButton.style.display = (total <= 1) ? 'none' : '';
                }
            }
        }

        // Toggle play/pause
        togglePlay() {
            if (this.isPlaying) {
                this.stopAnimation();
            } else {
                // Ensure we're not in a recording state when starting normal playback
                if (this.isRecording) {
                    console.warn("Cannot start playback while recording");
                    return;
                }
                this.startAnimation();
            }
        }

        // Start playback
        startAnimation() {
            // Check for null
            if (!this.currentObjectName) return;
            const object = this.objectsData[this.currentObjectName];
            if (!object || object.frames.length < 2) return;

            // If we're at the last frame and not recording, reset to first frame for looping
            if (!this.isRecording && this.currentFrame >= object.frames.length - 1) {
                this.currentFrame = 0;
                this._loadFrameData(0, true); // Load without render
            }

            this.isPlaying = true;
            
            // Start independent timer for frame advancement
            if (this.frameAdvanceTimer) {
                clearInterval(this.frameAdvanceTimer);
            }
            
            this.frameAdvanceTimer = setInterval(() => {
                if (this.isPlaying && this.currentObjectName) {
                    // Skip if recording (recording uses its own sequential method)
                    if (this.isRecording) {
                        return; // Recording handles its own frame advancement
                    }
                    
                    const obj = this.objectsData[this.currentObjectName];
                    if (obj && obj.frames.length > 1) {
                        let nextFrame = this.currentFrame + 1;
                        
                        // Normal playback - loop
                        if (nextFrame >= obj.frames.length) {
                            nextFrame = 0;
                        }
                        
                        // Update the frame index - render loop will pick it up
                        this.currentFrame = nextFrame;
                        this._loadFrameData(nextFrame, true); // Load without render
                        this.updateUIControls(); // Update slider
                    } else {
                        this.stopAnimation();
                    }
                }
            }, this.animationSpeed);
            
            this.updateUIControls();
        }

        // Stop playback
        stopAnimation() {
            this.isPlaying = false;
            
            // Clear frame advancement timer
            if (this.frameAdvanceTimer) {
                clearInterval(this.frameAdvanceTimer);
                this.frameAdvanceTimer = null;
            }
            
            // Clear recording sequence if active
            if (this.recordingFrameSequence) {
                clearTimeout(this.recordingFrameSequence);
                this.recordingFrameSequence = null;
            }
            
            this.updateUIControls();
        }
        
        // Sequential frame recording (ensures all frames are captured)
        recordFrameSequence() {
            if (!this.isRecording) return;
            
            const object = this.objectsData[this.currentObjectName];
            if (!object) {
                this.stopRecording();
                return;
            }
            
            const currentFrame = this.currentFrame;
            
            // Check if we've reached the end
            if (currentFrame > this.recordingEndFrame) {
                this.stopRecording();
                return;
            }
            
            // Load and render current frame
            this._loadFrameData(currentFrame, true); // Load without render
            this.render();
            this.lastRenderedFrame = currentFrame;
            this.updateUIControls();
            
            // Wait for frame to be captured, then advance
            // Use requestAnimationFrame to ensure render is complete
            requestAnimationFrame(() => {
                // Give MediaRecorder time to capture (MediaRecorder captures at 30fps = ~33ms per frame)
                // Use animationSpeed or minimum 50ms to ensure capture
                const captureDelay = Math.max(50, this.animationSpeed);
                
                this.recordingFrameSequence = setTimeout(() => {
                    // Advance to next frame
                    this.currentFrame = currentFrame + 1;
                    // Recursively record next frame
                    this.recordFrameSequence();
                }, captureDelay);
            });
        }
        
        // Toggle recording
        toggleRecording() {
            if (this.isRecording) {
                this.stopRecording();
            } else {
                this.startRecording();
            }
        }
        
        // Start recording animation
        startRecording() {
            // Check if we have frames to record
            if (!this.currentObjectName) {
                console.warn("Cannot record: No object loaded");
                return;
            }
            
            const object = this.objectsData[this.currentObjectName];
            if (!object || object.frames.length < 2) {
                console.warn("Cannot record: Need at least 2 frames");
                return;
            }
            
            // Check if MediaRecorder is supported
            if (typeof MediaRecorder === 'undefined' || !this.canvas.captureStream) {
                console.error("Recording not supported in this browser");
                alert("Video recording is not supported in this browser. Please use Chrome, Edge, or Firefox.");
                return;
            }
            
            // Stop any existing animation first
            this.stopAnimation();
            
            // Clean up any existing recording state first
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                try {
                    this.mediaRecorder.stop();
                } catch (e) {
                    console.warn("Error stopping existing recorder:", e);
                }
            }
            this._stopRecordingTracks();
            this.mediaRecorder = null;
            this.recordedChunks = [];
            
            // Set recording state
            this.isRecording = true;
            this.recordingEndFrame = object.frames.length - 1;
            
            // Disable interaction during recording
            this.isDragging = false; // Stop any active drag
            this.spinVelocityX = 0; // Stop inertia
            this.spinVelocityY = 0; // Stop inertia
            // Temporarily disable drag by preventing mousedown
            this.canvas.style.pointerEvents = 'none'; // Disable all mouse interaction
            
            // Capture stream from canvas at 30fps for smooth playback
            const fps = 30;
            this.recordingStream = this.canvas.captureStream(fps);
            
            // Set up MediaRecorder with very low compression (very high quality)
            const options = {
                mimeType: 'video/webm;codecs=vp9', // VP9 for better quality
                videoBitsPerSecond: 20000000 // 20 Mbps for very high quality (very low compression)
            };
            
            // Fallback to VP8 if VP9 not supported
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm;codecs=vp8';
                options.videoBitsPerSecond = 15000000; // 15 Mbps for VP8
            }
            
            // Fallback to default if neither supported
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm';
                options.videoBitsPerSecond = 15000000;
            }
            
            try {
                this.mediaRecorder = new MediaRecorder(this.recordingStream, options);
                
                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        this.recordedChunks.push(event.data);
                    }
                };
                
                this.mediaRecorder.onstop = () => {
                    this.finishRecording();
                };
                
                this.mediaRecorder.onerror = (event) => {
                    console.error("MediaRecorder error:", event.error);
                    this.isRecording = false;
                    this.updateUIControls();
                    alert("Recording error: " + event.error.message);
                };
                
                // Start recording
                this.mediaRecorder.start(100); // Collect data every 100ms
                
                // Stop any existing animation first
                this.stopAnimation();
                
                // Go to first frame (this will render frame 0)
                this.setFrame(0);
                
                // Start sequential recording (don't use startAnimation)
                // Wait a moment for MediaRecorder to start capturing
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        // Start sequential frame recording
                        this.recordFrameSequence();
                    });
                });
                
            } catch (error) {
                console.error("Failed to start recording:", error);
                this.isRecording = false;
                this.updateUIControls();
                alert("Failed to start recording: " + error.message);
            }
        }
        
        // Stop recording
        stopRecording() {
            if (!this.isRecording) {
                return;
            }
            
            // Stop sequential recording
            if (this.recordingFrameSequence) {
                clearTimeout(this.recordingFrameSequence);
                this.recordingFrameSequence = null;
            }
            
            // Re-enable interaction
            this.canvas.style.pointerEvents = 'auto'; // Re-enable mouse interaction
            
            // Stop animation (this also clears interval timer)
            this.stopAnimation();
            
            // Stop MediaRecorder
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
            
            // Stop stream
            this._stopRecordingTracks();
        }
        
        // Finish recording and download file
        finishRecording() {
            if (this.recordedChunks.length === 0) {
                console.warn("No video data recorded");
                this.isRecording = false;
                this.mediaRecorder = null;
                if (this.recordingStream) {
                    this.recordingStream.getTracks().forEach(track => track.stop());
                    this.recordingStream = null;
                }
                // Ensure animation is stopped and state is clean
                this.stopAnimation();
                this.updateUIControls();
                return;
            }
            
            // Create blob from recorded chunks
            const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
            
            // Create download link
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `py2dmol_animation_${this.currentObjectName || 'recording'}_${Date.now()}.webm`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            // Clean up
            URL.revokeObjectURL(url);
            
            // Clean up all recording state
            this.recordedChunks = [];
            this.isRecording = false;
            this.mediaRecorder = null;
            this._stopRecordingTracks();
            
            // Ensure animation is fully stopped and state is clean
            this.stopAnimation();
            
            this.updateUIControls();
        }

        // Clear all objects
        clearAllObjects() {
            this.stopAnimation();
            
            // Reset data
            this.objectsData = {};
            this.currentObjectName = null;
            
            // Reset object dropdown
            if (this.objectSelect) {
                this.objectSelect.innerHTML = ''; // Clear all options
            }
            
            // Clear PAE
            if (this.paeRenderer) {
                this.paeRenderer.setData(null);
            }
            
            // Set to empty frame, which clears canvas and updates UI
            this.setFrame(-1);
        }
        
        // Comprehensive reset method - resets all controls and state to defaults
        resetAll() {
            // Stop all active operations
            if (this.isPlaying) {
                this.stopAnimation();
            }
            if (this.isRecording) {
                this.stopRecording();
            }
            
            // Clear all objects
            this.clearAllObjects();
            
            // Reset camera to initial state
            this.rotationMatrix = [[1,0,0],[0,1,0],[0,0,1]];
            this.zoom = 1.0;
            this.perspectiveEnabled = false;
            this.focalLength = 200.0;
            this.temporaryCenter = null;
            this.temporaryExtent = null;
            this.isDragging = false;
            this.spinVelocityX = 0;
            this.spinVelocityY = 0;
            
            // Reset renderer state to defaults
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;
            this.shadowEnabled = true;
            this.outlineMode = 'full';
            this.autoRotate = false;
            this.colorblindMode = false;
            this.lineWidth = 3.0;
            this.animationSpeed = 100;
            this.currentFrame = -1;
            this.lastRenderedFrame = -1;
            if (this.shadowEnabledCheckbox) {
                this.shadowEnabledCheckbox.checked = true;
            }
            if (this.outlineModeButton) {
                this.outlineMode = 'full';
                this.updateOutlineButtonStyle();
            } else if (this.outlineModeSelect) {
                this.outlineMode = 'full';
                this.outlineModeSelect.value = 'full';
            }
            if (this.rotationCheckbox) {
                this.rotationCheckbox.checked = false;
            }
            if (this.colorblindCheckbox) {
                this.colorblindCheckbox.checked = false;
            }
            if (this.lineWidthSlider) {
                this.lineWidthSlider.value = '3.0';
            }
            if (this.orthoSlider) {
                this.orthoSlider.value = '1.0';
                // Update camera perspective - trigger input event to update camera
                this.orthoSlider.dispatchEvent(new Event('input'));
            }
            if (this.frameSlider) {
                this.frameSlider.value = '0';
                this.frameSlider.max = '0';
            }
            if (this.frameCounter) {
                this.frameCounter.textContent = 'Frame: 0/0';
            }
            if (this.playButton) {
                this.playButton.textContent = '▶';
            }
            if (this.recordButton) {
                this.recordButton.classList.remove('btn-toggle');
                this.recordButton.disabled = false;
            }
            
            // Clear selection
            this.clearSelection();
            
            // Update UI controls
            this.updateUIControls();
            
            // Trigger render to show empty state
            this.render();
        }

        _loadDataIntoRenderer(data, skipRender = false) {
            try {
                if (data && data.coords && data.coords.length > 0) {
                    const coords = data.coords.map(c => new Vec3(c[0], c[1], c[2]));
                    // Pass other data fields directly, allowing them to be undefined
                    this.setCoords(
                        coords,
                        data.plddts,
                        data.chains,
                        data.atom_types,
                        (data.pae && data.pae.length > 0),
                        data.residues,
                        data.residue_index,
                        skipRender
                    );
                }
            } catch (e) {
                console.error("Failed to load data into renderer:", e);
            }
        }

        setCoords(coords, plddts, chains, atomTypes, hasPAE = false, residues, residue_index, skipRender = false) {
            this.coords = coords;
            const n = this.coords.length;
            
            // Ensure colorMode is valid
            const validModes = ['auto', 'chain', 'rainbow', 'plddt'];
            if (!this.colorMode || !validModes.includes(this.colorMode)) {
                this.colorMode = 'auto';
            }
            
            // Mark colors as needing update when coordinates change
            this.colorsNeedUpdate = true;
            this.plddtColorsNeedUpdate = true;

            // --- Handle Defaults for Missing Data ---
            this.plddts = (plddts && plddts.length === n) ? plddts : Array(n).fill(50.0);
            this.chains = (chains && chains.length === n) ? chains : Array(n).fill('A');
            this.atomTypes = (atomTypes && atomTypes.length === n) ? atomTypes : Array(n).fill('P');
            this.residues = (residues && residues.length === n) ? residues : Array(n).fill('UNK');
            this.residue_index = (residue_index && residue_index.length === n) ? residue_index : Array.from({length: n}, (_, i) => i + 1);

            // Calculate what 'auto' should resolve to
            // Priority: plddt (if PAE present) > chain (if multi-chain) > rainbow
            const uniqueChains = new Set(this.chains);
            if (hasPAE) {
                this.resolvedAutoColor = 'plddt';
            } else if (uniqueChains.size > 1) {
                this.resolvedAutoColor = 'chain';
            } else {
                this.resolvedAutoColor = 'rainbow';
            }

            // Sync dropdown to renderer's colorMode (if dropdown exists)
            if (this.colorSelect && this.colorMode) {
                if (this.colorSelect.value !== this.colorMode) {
                    this.colorSelect.value = this.colorMode;
                }
            }

            // Create the definitive chain index map for this dataset.
            this.chainIndexMap = new Map();
            // Track which chains contain only ligands (no P/D/R atoms)
            this.ligandOnlyChains = new Set();
            if (this.chains.length > 0) {
                // Use a sorted list of unique chain IDs to ensure a consistent order
                const sortedUniqueChains = [...uniqueChains].sort();
                for (const chainId of sortedUniqueChains) {
                    if (chainId && !this.chainIndexMap.has(chainId)) {
                        this.chainIndexMap.set(chainId, this.chainIndexMap.size);
                    }
                }
                
                // Check each chain to see if it contains only ligands
                for (const chainId of sortedUniqueChains) {
                    let hasNonLigand = false;
                    for (let i = 0; i < n; i++) {
                        if (this.chains[i] === chainId) {
                            const type = this.atomTypes[i];
                            if (type === 'P' || type === 'D' || type === 'R') {
                                hasNonLigand = true;
                                break;
                            }
                        }
                    }
                    // If chain has no P/D/R atoms, it's ligand-only
                    if (!hasNonLigand) {
                        this.ligandOnlyChains.add(chainId);
                    }
                }
            }

            // No longer need polymerAtomIndices - all atoms are treated the same
            // (One atom = one position, no distinction between polymer/ligand)

            // Pre-calculate per-chain indices for rainbow coloring (N-to-C)
            // Include ligands in ligand-only chains for rainbow coloring
            this.perChainIndices = new Array(n);
            const chainIndices = {}; // Temporary tracker
            for (let i = 0; i < n; i++) {
                const type = this.atomTypes[i];
                const chainId = this.chains[i] || 'A';
                const isLigandOnlyChain = this.ligandOnlyChains.has(chainId);
                
                if (type === 'P' || type === 'D' || type === 'R' || (type === 'L' && isLigandOnlyChain)) {
                    if (chainIndices[chainId] === undefined) {
                        chainIndices[chainId] = 0;
                    }
                    this.perChainIndices[i] = chainIndices[chainId];
                    chainIndices[chainId]++;
                } else {
                    this.perChainIndices[i] = 0; // Default for ligands in mixed chains
                }
            }

            // Pre-calculate rainbow scales
            // Include ligands in ligand-only chains for rainbow coloring
            this.chainRainbowScales = {};
            for (let i = 0; i < this.atomTypes.length; i++) {
                const type = this.atomTypes[i];
                const chainId = this.chains[i] || 'A';
                const isLigandOnlyChain = this.ligandOnlyChains.has(chainId);
                
                if (type === 'P' || type === 'D' || type === 'R' || (type === 'L' && isLigandOnlyChain)) {
                    if (!this.chainRainbowScales[chainId]) { 
                        this.chainRainbowScales[chainId] = { min: Infinity, max: -Infinity }; 
                    }
                    const colorIndex = this.perChainIndices[i]; 
                    const scale = this.chainRainbowScales[chainId];
                    scale.min = Math.min(scale.min, colorIndex);
                    scale.max = Math.max(scale.max, colorIndex);
                }
            }

            // Compute ligand groups using shared utility function
            // This groups ligands by chain, residue_index, and residue_name (if available)
            if (typeof groupLigandAtoms === 'function') {
                this.ligandGroups = groupLigandAtoms(
                    this.chains,
                    this.atomTypes,
                    this.residue_index,
                    this.residues
                );
            } else {
                // Fallback: empty map if utility function not available
                this.ligandGroups = new Map();
            }
            
            // Pre-allocate rotatedCoords array
            if (this.rotatedCoords.length !== n) {
                this.rotatedCoords = Array.from({ length: n }, () => new Vec3(0, 0, 0));
            }

            // Check if we can reuse cached segment indices (bonds don't change within a frame)
            const canUseCache = this.cachedSegmentIndices !== null &&
                                this.cachedSegmentIndicesFrame === this.currentFrame &&
                                this.cachedSegmentIndicesObjectName === this.currentObjectName &&
                                this.cachedSegmentIndices.length > 0;
            
            if (canUseCache) {
                // Reuse cached segment indices (deep copy to avoid mutation)
                this.segmentIndices = this.cachedSegmentIndices.map(seg => ({ ...seg }));
            } else {
                // Generate Segment Definitions ONCE
                this.segmentIndices = [];
            const proteinChainbreak = 5.0;
            const nucleicChainbreak = 7.5;
            const ligandBondCutoff = 2.0;
            const proteinChainbreakSq = proteinChainbreak * proteinChainbreak;
            const nucleicChainbreakSq = nucleicChainbreak * nucleicChainbreak;
            const ligandBondCutoffSq = ligandBondCutoff * ligandBondCutoff;
            
            let firstPolymerIndex = -1;
            let lastPolymerIndex = -1;
            const ligandIndicesByChain = new Map(); // Group ligands by chain
            
            // Helper function to check if atom type is polymer (for rendering only)
            const isPolymer = (type) => (type === 'P' || type === 'D' || type === 'R');
            const isPolymerArr = this.atomTypes.map(isPolymer);
            
            const getChainbreakDistSq = (type1, type2) => {
                if ((type1 === 'D' || type1 === 'R') && (type2 === 'D' || type2 === 'R')) {
                    return nucleicChainbreakSq;
                }
                return proteinChainbreakSq;
            };
            
            for (let i = 0; i < n; i++) {
                if (isPolymerArr[i]) {
                    const type = this.atomTypes[i];
                    if (firstPolymerIndex === -1) { firstPolymerIndex = i; }
                    lastPolymerIndex = i;
                    
                    if (i < n - 1) {
                        if (isPolymerArr[i+1]) {
                            const type1 = type;
                            const type2 = this.atomTypes[i+1];
                            const samePolymerType = (type1 === type2) || 
                                ((type1 === 'D' || type1 === 'R') && (type2 === 'D' || type2 === 'R'));
                            
                            if (samePolymerType && this.chains[i] === this.chains[i+1]) {
                                const start = this.coords[i];
                                const end = this.coords[i+1];
                                const distSq = start.distanceToSq(end);
                                const chainbreakDistSq = getChainbreakDistSq(type1, type2);
                                
                                if (distSq < chainbreakDistSq) {
                                    this.segmentIndices.push({ 
                                        idx1: i, 
                                        idx2: i+1, 
                                        colorIndex: this.perChainIndices[i], 
                                        origIndex: i, 
                                        chainId: this.chains[i] || 'A',
                                        type: type1,
                                        len: Math.sqrt(distSq)
                                    });
                                }
                            }
                        }
                    }
                } else if (this.atomTypes[i] === 'L') {
                    // Group ligand indices by chain
                    const chainId = this.chains[i] || 'A';
                    if (!ligandIndicesByChain.has(chainId)) {
                        ligandIndicesByChain.set(chainId, []);
                    }
                    ligandIndicesByChain.get(chainId).push(i);
                }
            }

            if (firstPolymerIndex !== -1 && lastPolymerIndex !== -1 && firstPolymerIndex !== lastPolymerIndex) {
                const firstChainId = this.chains[firstPolymerIndex] || 'A';
                const lastChainId = this.chains[lastPolymerIndex] || 'A';
                
                if (firstChainId === lastChainId && isPolymerArr[firstPolymerIndex] && isPolymerArr[lastPolymerIndex]) {
                    const type1 = this.atomTypes[firstPolymerIndex];
                    const type2 = this.atomTypes[lastPolymerIndex];
                    const samePolymerType = (type1 === type2) || 
                        ((type1 === 'D' || type1 === 'R') && (type2 === 'D' || type2 === 'R'));
                    
                    if (samePolymerType) {
                        const start = this.coords[firstPolymerIndex];
                        const end = this.coords[lastPolymerIndex];
                        const distSq = start.distanceToSq(end);
                        const chainbreakDistSq = getChainbreakDistSq(type1, type2);
                        
                        if (distSq < chainbreakDistSq) {
                            this.segmentIndices.push({ 
                                idx1: firstPolymerIndex, 
                                idx2: lastPolymerIndex,
                                colorIndex: this.perChainIndices[firstPolymerIndex],
                                origIndex: firstPolymerIndex, 
                                chainId: firstChainId,
                                type: type1,
                                len: Math.sqrt(distSq)
                            });
                        }
                    }
                }
            }

            // Compute ligand bonds
            // If ligand groups are available, only compute distances within each group
            // Otherwise, fall back to computing distances within each chain
            if (this.ligandGroups && this.ligandGroups.size > 0) {
                // Use ligand groups: only compute distances within each group
                for (const [groupKey, ligandAtomIndices] of this.ligandGroups.entries()) {
                    // Compute pairwise distances only within this ligand group
                    for (let i = 0; i < ligandAtomIndices.length; i++) {
                        for (let j = i + 1; j < ligandAtomIndices.length; j++) {
                            const idx1 = ligandAtomIndices[i];
                            const idx2 = ligandAtomIndices[j];
                            
                            // Skip if indices are out of bounds
                            if (idx1 < 0 || idx1 >= this.coords.length || 
                                idx2 < 0 || idx2 >= this.coords.length) {
                                continue;
                            }
                            
                            const start = this.coords[idx1];
                            const end = this.coords[idx2];
                            const distSq = start.distanceToSq(end);
                            if (distSq < ligandBondCutoffSq) {
                                const chainId = this.chains[idx1] || 'A';
                                this.segmentIndices.push({ 
                                    idx1: idx1, 
                                    idx2: idx2,
                                    colorIndex: 0, 
                                    origIndex: idx1, 
                                    chainId: chainId,
                                    type: 'L',
                                    len: Math.sqrt(distSq)
                                });
                            }
                        }
                    }
                }
            } else {
                // Fallback: iterate over each chain's ligands separately (old behavior)
                for (const [chainId, ligandIndices] of ligandIndicesByChain.entries()) {
                    for (let i = 0; i < ligandIndices.length; i++) {
                        for (let j = i + 1; j < ligandIndices.length; j++) {
                            const idx1 = ligandIndices[i];
                            const idx2 = ligandIndices[j];
                            
                            // All atoms here are guaranteed to be in the same chain (chainId)
                            
                            const start = this.coords[idx1];
                            const end = this.coords[idx2];
                            const distSq = start.distanceToSq(end);
                            if (distSq < ligandBondCutoffSq) {
                                 this.segmentIndices.push({ 
                                     idx1: idx1, 
                                     idx2: idx2,
                                     colorIndex: 0, 
                                     origIndex: idx1, 
                                     chainId: chainId, // Use the chainId from the map key
                                     type: 'L',
                                     len: Math.sqrt(distSq)
                                });
                            }
                        }
                    }
                }
            }
            
            // Find all disconnected atoms (any type) that don't appear in any segment
            // and add them as zero-length segments (will render as circles)
            const atomsInSegments = new Set();
            for (const segInfo of this.segmentIndices) {
                atomsInSegments.add(segInfo.idx1);
                atomsInSegments.add(segInfo.idx2);
            }
            
            // Add all disconnected atoms as zero-length segments
            for (let i = 0; i < this.coords.length; i++) {
                if (!atomsInSegments.has(i)) {
                    // This atom is disconnected - add as zero-length segment
                    const atomType = this.atomTypes[i] || 'P';
                    const chainId = this.chains[i] || 'A';
                    const colorIndex = this.perChainIndices[i] || 0;
                    
                    this.segmentIndices.push({
                        idx1: i,
                        idx2: i, // Same index = zero-length segment (will render as circle)
                        colorIndex: colorIndex,
                        origIndex: i,
                        chainId: chainId,
                        type: atomType,
                        len: 0 // Zero length indicates disconnected atom
                    });
                }
            }
            
                // Cache the calculated segment indices for this frame
                this.cachedSegmentIndices = this.segmentIndices.map(seg => ({ ...seg }));
                this.cachedSegmentIndicesFrame = this.currentFrame;
                this.cachedSegmentIndicesObjectName = this.currentObjectName;
            }
            
            // Pre-allocate segData array
            const m = this.segmentIndices.length;
            if (this.segData.length !== m) {
                this.segData = Array.from({ length: m }, () => ({
                    x: 0, y: 0, z: 0, len: 0, zVal: 0, gx: -1, gy: -1
                }));
            }
            
            // Pre-calculate colors ONCE (if not plddt)
            this.colors = this._calculateSegmentColors();
            this.colorsNeedUpdate = false;
            
            // Pre-calculate pLDDT colors
            this.plddtColors = this._calculatePlddtColors();
            this.plddtColorsNeedUpdate = false;


            // Trigger first render (unless skipRender is true)
            if (!skipRender) {
                this.render();
            }
        
            // [PATCH] Apply initial mask
            this._composeAndApplyMask();
            
            // Dispatch event to notify sequence viewer that colors have changed (e.g., when frame changes)
            document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        }
        
        // Load frame data without rendering (for decoupled animation)
        _loadFrameData(frameIndex, skipRender = false) {
            if (!this.currentObjectName) return;
            const object = this.objectsData[this.currentObjectName];
            if (!object || frameIndex < 0 || frameIndex >= object.frames.length) {
                return;
            }
            
            const data = object.frames[frameIndex];
            
            // Load 3D data (with skipRender option)
            this._loadDataIntoRenderer(data, skipRender);
            
            // Load PAE data
            if (this.paeRenderer) {
                this.paeRenderer.setData(data.pae || null);
            }
            
            // Reset selection to default (show all) when loading a new object's frame
            // Check if object actually changed (not just frame change within same object)
            const objectChanged = this.previousObjectName !== null && 
                                  this.previousObjectName !== this.currentObjectName;
            
            if (objectChanged) {
                // Object changed: reset to default (show all atoms of new object)
                this.resetToDefault();
                this.previousObjectName = this.currentObjectName; // Update tracking
            } else if (this.selectionModel.selectionMode === 'explicit' && 
                       this.selectionModel.atoms.size === 0) {
                // Selection was explicitly cleared, reset to default
                this.resetToDefault();
            }
            
            // Update UI controls (but don't render yet)
            this.updateUIControls();
        }

        _getEffectiveColorMode() {
            const validModes = ['auto', 'chain', 'rainbow', 'plddt'];
            if (!this.colorMode || !validModes.includes(this.colorMode)) {
                this.colorMode = 'auto';
            }
            
            // If 'auto', resolve to the calculated mode
            if (this.colorMode === 'auto') {
                return this.resolvedAutoColor || 'rainbow';
            }
            
            return this.colorMode;
        }

        getAtomColor(atomIndex) {
            if (atomIndex < 0 || atomIndex >= this.coords.length) {
                return this._applyPastel({ r: 128, g: 128, b: 128 }); // Default grey
            }

            const effectiveColorMode = this._getEffectiveColorMode();
            const type = (this.atomTypes && atomIndex < this.atomTypes.length) ? this.atomTypes[atomIndex] : undefined;
            let color;

            // Ligands should always be grey in chain and rainbow modes (not plddt)
            const isLigand = type === 'L';

            if (effectiveColorMode === 'plddt') {
                const plddtFunc = this.colorblindMode ? getPlddtColor_Colorblind : getPlddtColor;
                const plddt = (this.plddts[atomIndex] !== null && this.plddts[atomIndex] !== undefined) ? this.plddts[atomIndex] : 50;
                color = plddtFunc(plddt);
            } else if (effectiveColorMode === 'chain') {
                const chainId = this.chains[atomIndex] || 'A';
                if (isLigand && !this.ligandOnlyChains.has(chainId)) {
                    // Ligands in chains with P/D/R atoms are grey
                    color = { r: 128, g: 128, b: 128 };
                } else {
                    // Regular atoms, or ligands in ligand-only chains, get chain color
                    if (this.chainIndexMap && this.chainIndexMap.has(chainId)) {
                        const chainIndex = this.chainIndexMap.get(chainId);
                        const colorArray = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
                        const hex = colorArray[chainIndex % colorArray.length];
                        color = hexToRgb(hex);
                    } else {
                        // Fallback: use a default color if chainIndexMap is not initialized
                        const colorArray = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
                        const hex = colorArray[0]; // Use first color as default
                        color = hexToRgb(hex);
                    }
                }
            } else { // rainbow
                if (isLigand) {
                    // All ligands are grey in rainbow mode
                    color = { r: 128, g: 128, b: 128 };
                } else {
                    // Regular atoms get rainbow color
                    const chainId = this.chains[atomIndex] || 'A';
                    const scale = this.chainRainbowScales && this.chainRainbowScales[chainId];
                    const rainbowFunc = this.colorblindMode ? getRainbowColor_Colorblind : getRainbowColor;
                    if (scale && scale.min !== Infinity && scale.max !== -Infinity) {
                        const colorIndex = this.perChainIndices && atomIndex < this.perChainIndices.length ? this.perChainIndices[atomIndex] : 0;
                        color = rainbowFunc(colorIndex, scale.min, scale.max);
                    } else {
                        // Fallback: if scale not found, use a default rainbow based on colorIndex
                        const colorIndex = (this.perChainIndices && atomIndex < this.perChainIndices.length ? this.perChainIndices[atomIndex] : 0) || 0;
                        color = rainbowFunc(colorIndex, 0, Math.max(1, colorIndex));
                    }
                }
            }

            return this._applyPastel(color);
        }
        
        // Get chain color for a given chain ID (for UI elements like sequence viewer)
        getChainColorForChainId(chainId) {
            if (!this.chainIndexMap || !chainId) {
                return {r: 128, g: 128, b: 128}; // Default gray
            }
            const chainIndex = this.chainIndexMap.get(chainId) || 0;
            const colorArray = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
            const hex = colorArray[chainIndex % colorArray.length];
            return hexToRgb(hex);
        }
        
        // Calculate segment colors (chain or rainbow)
        // Uses getAtomColor() as single source of truth for all color logic
        _calculateSegmentColors() {
            const m = this.segmentIndices.length;
            if (m === 0) return [];

            // Use getAtomColor() for each segment - ensures consistency and eliminates duplicate logic
            return this.segmentIndices.map(segInfo => {
                const atomIndex = segInfo.origIndex;
                // getAtomColor() already handles all color modes, ligands, ligand-only chains, pastel, etc.
                return this.getAtomColor(atomIndex);
            });
        }

        // Calculate pLDDT colors
        _calculatePlddtColors() {
            const m = this.segmentIndices.length;
            if (m === 0) return [];
            
            const colors = new Array(m);
            
            const plddtFunc = this.colorblindMode ? getPlddtColor_Colorblind : getPlddtColor;
            
            for (let i = 0; i < m; i++) {
                const segInfo = this.segmentIndices[i];
                const atomIdx = segInfo.origIndex;
                const type = segInfo.type;
                let color;
                
                if (type === 'L') {
                    const plddt1 = (this.plddts[atomIdx] !== null && this.plddts[atomIdx] !== undefined) ? this.plddts[atomIdx] : 50;
                    color = plddtFunc(plddt1); // Use selected plddt function
                } else {
                    const plddt1 = (this.plddts[atomIdx] !== null && this.plddts[atomIdx] !== undefined) ? this.plddts[atomIdx] : 50;
                    const plddt2_idx = (segInfo.idx2 < this.coords.length) ? segInfo.idx2 : segInfo.idx1;
                    const plddt2 = (this.plddts[plddt2_idx] !== null && this.plddts[plddt2_idx] !== undefined) ? this.plddts[plddt2_idx] : 50;
                    color = plddtFunc((plddt1 + plddt2) / 2); // Use selected plddt function
                }
                colors[i] = this._applyPastel(color);
            }
            return colors;
        }

        // Helper function for shadow calculation
        /**
         * Calculates the shadow and tint contribution for a pair of segments.
         * @param {object} s1 - The segment being shaded (further back).
         * @param {object} s2 - The segment casting the shadow (further forward).
         * @returns {{shadow: number, tint: number}}
         */
        _calculateShadowTint(s1, s2) {
            // Cache segment lengths
            const len1 = s1.len;
            const len2 = s2.len;
            const avgLen = (len1 + len2) * 0.5;
            const shadow_cutoff = avgLen * 2.0;
            const tint_cutoff = avgLen * 0.5;
            const max_cutoff = shadow_cutoff + 10.0;
            const max_cutoff_sq = max_cutoff * max_cutoff;
            
            // Use properties from the segment data objects
            const dx_dist = s1.x - s2.x;
            const dy_dist = s1.y - s2.y;
            
            const dist2D_sq = dx_dist * dx_dist + dy_dist * dy_dist;
            
            // Early exit: if 2D distance is too large, no shadow or tint
            if (dist2D_sq > max_cutoff_sq) {
                return { shadow: 0, tint: 0 };
            }
            
            let shadow = 0;
            let tint = 0;
            
            const dz = s1.z - s2.z;
            const dist3D_sq = dist2D_sq + dz * dz;
            
            // Only calculate shadow if 3D distance is within cutoff
            if (dist3D_sq < max_cutoff_sq) {
                const dist3D = Math.sqrt(dist3D_sq);
                shadow = sigmoid(shadow_cutoff - dist3D);
            }
            
            // Only calculate tint if 2D distance is within cutoff
            const tint_max_cutoff = tint_cutoff + 10.0;
            const tint_max_cutoff_sq = tint_max_cutoff * tint_max_cutoff;
            
            if (dist2D_sq < tint_max_cutoff_sq) {
                const dist2D = Math.sqrt(dist2D_sq);
                tint = sigmoid(tint_cutoff - dist2D);
            }

            return { shadow, tint };
        }


        // Helper method to stop recording tracks
        _stopRecordingTracks() {
            if (this.recordingStream) {
                this.recordingStream.getTracks().forEach(track => track.stop());
                this.recordingStream = null;
            }
        }
        
        // Update cached canvas dimensions (call on resize)
        _updateCanvasDimensions() {
            this.displayWidth = parseInt(this.canvas.style.width) || this.canvas.width;
            this.displayHeight = parseInt(this.canvas.style.height) || this.canvas.height;
            
            // Update highlight overlay canvas size to match (managed by sequence viewer)
            if (window.SequenceViewer && window.SequenceViewer.updateHighlightOverlaySize) {
                window.SequenceViewer.updateHighlightOverlaySize();
            }
        }
        
        // RENDER (Core drawing logic)
        render() {
            this._renderToContext(this.ctx, this.displayWidth, this.displayHeight);
        }
        
        // Core rendering logic - can render to any context (canvas, SVG, etc.)
        _renderToContext(ctx, displayWidth, displayHeight) {
            // Use clearRect or fillRect based on transparency
            if (this.isTransparent) {
                ctx.clearRect(0, 0, displayWidth, displayHeight);
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, displayWidth, displayHeight);
            }
            
            // Check segment length
            if (this.coords.length === 0 || this.segmentIndices.length === 0 || !this.currentObjectName) return;

            const object = this.objectsData[this.currentObjectName];
            if (!object) {
                console.warn("Render called but object data is missing.");
                return;
            }

            // Use temporary center if set (for orienting to visible atoms), otherwise use global center
            const globalCenter = (object && object.totalAtoms > 0) ? object.globalCenterSum.mul(1 / object.totalAtoms) : new Vec3(0,0,0);
            const c = this.temporaryCenter || globalCenter;
            
            // Update pre-allocated rotatedCoords
            const m = this.rotationMatrix;
            for (let i = 0; i < this.coords.length; i++) {
                const v = this.coords[i];
                const subX = v.x - c.x, subY = v.y - c.y, subZ = v.z - c.z;
                const out = this.rotatedCoords[i];
                out.x = m[0][0]*subX + m[0][1]*subY + m[0][2]*subZ;
                out.y = m[1][0]*subX + m[1][1]*subY + m[1][2]*subZ;
                out.z = m[2][0]*subX + m[2][1]*subY + m[2][2]*subZ;
            }
            const rotated = this.rotatedCoords;
            
            // Segment generation is now just data lookup
            const n = this.segmentIndices.length;
            const segments = this.segmentIndices; // Use the pre-calculated segment definitions
            
            const effectiveColorMode = this._getEffectiveColorMode();
            
            // Select pre-calculated color array
            let colors;
            if (effectiveColorMode === 'plddt') {
                if (!this.plddtColors || this.plddtColors.length !== n || this.plddtColorsNeedUpdate) {
                    this.plddtColors = this._calculatePlddtColors();
                    this.plddtColorsNeedUpdate = false;
                }
                colors = this.plddtColors;
            } else {
                if (!this.colors || this.colors.length !== n || this.colorsNeedUpdate) {
                    this.colors = this._calculateSegmentColors();
                    this.colorsNeedUpdate = false;
                }
                colors = this.colors;
            }
            
            // Safety check: ensure color arrays match segment count
            if (!colors || colors.length !== n) {
                console.warn("Color array mismatch, recalculating.");
                this.colors = this._calculateSegmentColors();
                this.plddtColors = this._calculatePlddtColors();
                this.colorsNeedUpdate = false;
                this.plddtColorsNeedUpdate = false;
                colors = (effectiveColorMode === 'plddt') ? this.plddtColors : this.colors;
                if (colors.length !== n) {
                     console.error("Color array mismatch even after recalculation. Aborting render.");
                     return; // Still bad, abort render
                }
            }
            
            // Get visibility mask early to build visible segment list
            const visibilityMask = this.visibilityMask;
            
            // Build list of visible segment indices early - this is the key optimization
            // A segment is visible if both atoms are visible (or no mask = all visible)
            const visibleSegmentIndices = [];
            for (let i = 0; i < n; i++) {
                const segInfo = segments[i];
                if (!visibilityMask || (visibilityMask.has(segInfo.idx1) && visibilityMask.has(segInfo.idx2))) {
                    visibleSegmentIndices.push(i);
                }
            }
            const numVisibleSegments = visibleSegmentIndices.length;
            
            // Combine Z-value/norm and update segData
            // Only calculate z-values for visible segments to avoid unnecessary computation
            const zValues = new Float32Array(n);
            let zMin = Infinity;
            let zMax = -Infinity;
            // Also track min/max from actual atom positions (for outline width calculation)
            let zMinAtoms = Infinity;
            let zMaxAtoms = -Infinity;
            const segData = this.segData; // Use pre-allocated array

            // Only calculate z-values and segData for visible segments
            for (let i = 0; i < numVisibleSegments; i++) {
                const segIdx = visibleSegmentIndices[i];
                const segInfo = segments[segIdx];
                const start = rotated[segInfo.idx1];
                const end = rotated[segInfo.idx2];
                
                const midX = (start.x + end.x) * 0.5;
                const midY = (start.y + end.y) * 0.5;
                const midZ = (start.z + end.z) * 0.5;
                const z = midZ; // zValue is just midZ
                
                zValues[segIdx] = z;
                if (z < zMin) zMin = z;
                if (z > zMax) zMax = z;
                
                // Track atom z-coordinates for outline calculation
                if (start.z < zMinAtoms) zMinAtoms = start.z;
                if (start.z > zMaxAtoms) zMaxAtoms = start.z;
                if (end.z < zMinAtoms) zMinAtoms = end.z;
                if (end.z > zMaxAtoms) zMaxAtoms = end.z;
                
                // Update pre-allocated segData object
                const s = segData[segIdx];
                s.x = midX;
                s.y = midY;
                s.z = midZ;
                s.len = segInfo.len; // Use pre-calculated length
                s.zVal = z;
                // gx/gy are reset in shadow logic
            }
            
            const zNorm = new Float32Array(n);
            
            // Count visible atoms for performance mode determination
            let numVisibleAtoms;
            if (!visibilityMask) {
                // All atoms are visible
                numVisibleAtoms = this.coords.length;
            } else {
                // Count atoms in visibility mask
                numVisibleAtoms = visibilityMask.size;
            }
            
            // Collect z-values from visible segments only (for depth calculation)
            const visibleZValues = [];
            for (let i = 0; i < numVisibleSegments; i++) {
                const segIdx = visibleSegmentIndices[i];
                visibleZValues.push(zValues[segIdx]);
            }
            
            // Calculate mean and std only from visible segments
            const numVisible = visibleZValues.length;
            let zSum = 0;
            for (let i = 0; i < numVisible; i++) {
                zSum += visibleZValues[i];
            }
            const zMean = numVisible > 0 ? zSum / numVisible : 0;
            
            // Calculate standard deviation from visible segments only
            let varianceSum = 0;
            for (let i = 0; i < numVisible; i++) {
                const diff = visibleZValues[i] - zMean;
                varianceSum += diff * diff;
            }
            const zVariance = numVisible > 0 ? varianceSum / numVisible : 0;
            const zStd = Math.sqrt(zVariance);
            
            // Map using std: zMean - 2*std → 0, zMean + 2*std → 1
            // Formula: zNorm = (z - (zMean - 2*std)) / (4*std)
            // Only normalize visible segments to avoid unnecessary computation
            if (zStd > 1e-6) {
                const zFront = zMean - 2.0 * zStd; // 2 std below mean (front)
                const zBack = zMean + 2.0 * zStd;  // 2 std above mean (back)
                const zRangeStd = 4.0 * zStd;  // Range is 4*std
                
                // Only normalize visible segments
                for (let i = 0; i < numVisibleSegments; i++) {
                    const segIdx = visibleSegmentIndices[i];
                    // Map zMean - 2*std to 0, zMean + 2*std to 1
                    zNorm[segIdx] = (zValues[segIdx] - zFront) / zRangeStd;
                    // Clamp to [0, 1] for values outside ±2 std
                    zNorm[segIdx] = Math.max(0, Math.min(1, zNorm[segIdx]));
                }
            } else {
                // Fallback: if std is too small, use min/max approach
                const zRange = zMax - zMin;
                if (zRange > 1e-6) {
                    // Only normalize visible segments
                    for (let i = 0; i < numVisibleSegments; i++) {
                        const segIdx = visibleSegmentIndices[i];
                        zNorm[segIdx] = (zValues[segIdx] - zMin) / zRange;
                    }
                } else {
                    // Only set visible segments to 0.5
                    for (let i = 0; i < numVisibleSegments; i++) {
                        const segIdx = visibleSegmentIndices[i];
                        zNorm[segIdx] = 0.5;
                    }
                }
            }
            
            const renderShadows = this.shadowEnabled;
            const maxExtent = (object && object.maxExtent > 0) ? object.maxExtent : 30.0;

            const shadows = new Float32Array(n);
            const tints = new Float32Array(n);
            
            // Initialize shadows and tints to default values (no shadow, no tint)
            // This ensures non-visible segments have correct defaults
            shadows.fill(1.0);
            tints.fill(1.0);
            
            // Only sort visible segments - major performance improvement
            const visibleOrder = visibleSegmentIndices
                .map(i => ({ idx: i, z: zValues[i] }))
                .sort((a, b) => a.z - b.z)
                .map(item => item.idx);
            
            // Keep full order array for compatibility (but only visible segments will be used)
            // NOTE: This array should NOT be used for calculations - use visibleOrder instead
            // zValues for non-visible segments are uninitialized (0), so sorting is incorrect
            const order = Array.from({length: n}, (_, i) => i).sort((a, b) => zValues[a] - zValues[b]);
            
            // visibilityMask already declared above for depth calculation
            
            // Determine fast/slow mode based on visible atoms (not total segments)
            // Fast mode: skip expensive operations when many visible atoms
            // Slow mode: full quality rendering when few visible atoms
            const isFastMode = numVisibleAtoms > this.LARGE_MOLECULE_CUTOFF;
            const isLargeMolecule = n > this.LARGE_MOLECULE_CUTOFF;
            
            // For fast mode (many visible atoms), skip expensive shadow calculations during dragging or zooming - use cached
            // During zoom, shadows don't change, so reuse cached values
            // During drag, use cached for performance, but recalculate after drag stops
            const skipShadowCalc = isFastMode && (this.isDragging || this.isZooming) && this.cachedShadows && this.cachedShadows.length === n;
            
            if (renderShadows && !skipShadowCalc) {
                // Use fast mode threshold based on visible atoms, not total segments
                if (!isFastMode) {
                    // Only process visible segments in outer loop
                    for (let i_idx = visibleOrder.length - 1; i_idx >= 0; i_idx--) {
                        const i = visibleOrder[i_idx]; 
                        let shadowSum = 0;
                        let maxTint = 0;
                        const s1 = segData[i];
                        const segInfoI = segments[i]; // Cache segment info

                        // Only check visible segments (already filtered)
                        for (let j_idx = i_idx + 1; j_idx < visibleOrder.length; j_idx++) {
                            const j = visibleOrder[j_idx];
                            
                            // Early exit: if maxTint is already 1.0, no need to check for more tint
                            if (maxTint >= 1.0 && shadowSum > 50) {
                                break; // Shadow sum is high enough, tint is maxed, skip remaining segments
                            }
                            
                            const s2 = segData[j];
                            
                            // Call helper function
                            const { shadow, tint } = this._calculateShadowTint(s1, s2);
                            shadowSum += shadow;
                            maxTint = Math.max(maxTint, tint);
                        }
                        shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                        tints[i] = 1 - maxTint;
                    }
                } else { // Fast mode: many visible atoms, use grid-based optimization
                    let GRID_DIM = Math.ceil(Math.sqrt(numVisibleSegments / 10)); 
                    GRID_DIM = Math.max(10, Math.min(100, GRID_DIM)); 
                    
                    const gridSize = GRID_DIM * GRID_DIM;
                    const grid = Array.from({ length: gridSize }, () => []);
                    
                    const gridMin = -maxExtent - 1.0;
                    const gridRange = (maxExtent + 1.0) * 2;
                    const gridCellSize = gridRange / GRID_DIM;
                    
                    if (gridCellSize > 1e-6) {
                        const invCellSize = 1.0 / gridCellSize; 
                        
                        // Only calculate grid positions for visible segments
                        for (let i = 0; i < numVisibleSegments; i++) {
                            const segIdx = visibleSegmentIndices[i];
                            const s = segData[segIdx];
                            const gx = Math.floor((s.x - gridMin) * invCellSize);
                            const gy = Math.floor((s.y - gridMin) * invCellSize);
                            
                            if (gx >= 0 && gx < GRID_DIM && gy >= 0 && gy < GRID_DIM) {
                                s.gx = gx;
                                s.gy = gy;
                            } else {
                                s.gx = -1; // Mark as outside grid
                                s.gy = -1;
                            }
                        }
                        
                        // Populate grid with all visible segments BEFORE calculating shadows
                        // This ensures segments in front are already in the grid when we process segments behind them
                        for (let i = 0; i < numVisibleSegments; i++) {
                            const segIdx = visibleSegmentIndices[i];
                            const s = segData[segIdx];
                            if (s.gx >= 0 && s.gy >= 0) {
                                const gridIndex = s.gx + s.gy * GRID_DIM;
                                grid[gridIndex].push(segIdx);
                            }
                        }
                        
                        // Only process visible segments in outer loop
                        for (let i_idx = visibleOrder.length - 1; i_idx >= 0; i_idx--) {
                            const i = visibleOrder[i_idx]; 
                            let shadowSum = 0;
                            let maxTint = 0;
                            const s1 = segData[i];
                            const gx1 = s1.gx;
                            const gy1 = s1.gy;

                            if (gx1 < 0) { 
                                shadows[i] = 1.0;
                                tints[i] = 1.0;
                                continue; 
                            }

                            for (let dy = -1; dy <= 1; dy++) {
                                const gy2 = gy1 + dy;
                                if (gy2 < 0 || gy2 >= GRID_DIM) continue;
                                const rowOffset = gy2 * GRID_DIM;
                                
                                for (let dx = -1; dx <= 1; dx++) {
                                    const gx2 = gx1 + dx;
                                    if (gx2 < 0 || gx2 >= GRID_DIM) continue;
                                    
                                    const gridIndex = gx2 + rowOffset;
                                    const cell = grid[gridIndex];
                                    const cellLen = cell.length;
                                    
                                    for (let k = 0; k < cellLen; k++) {
                                        const j = cell[k]; 
                                        // Only visible segments are in the grid, so no visibility check needed
                                        const s2 = segData[j];
                                        
                                        // CRITICAL: Only check segments that are in FRONT of i (closer to camera)
                                        // Segment j casts shadow on i only if j.z > i.z (j is in front)
                                        if (s2.z <= s1.z) {
                                            continue; // Skip segments that are behind or at same depth
                                        }
                                        
                                        // Call helper function
                                        const { shadow, tint } = this._calculateShadowTint(s1, s2);
                                        shadowSum += shadow;
                                        maxTint = Math.max(maxTint, tint);
                                    }
                                }
                            }
                            
                            shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                            tints[i] = 1 - maxTint;
                        }
                    } else {
                         shadows.fill(1.0);
                         tints.fill(1.0);
                    }
                }
                
                // Cache shadows/tints only for large molecules during dragging/zooming
                if (isLargeMolecule && !this.isDragging && !this.isZooming) {
                    this.cachedShadows = new Float32Array(shadows);
                    this.cachedTints = new Float32Array(tints);
                } else if (!isLargeMolecule) {
                    // Small molecules: don't cache, always recalculate
                    this.cachedShadows = null;
                    this.cachedTints = null;
                }
            } else if (skipShadowCalc) {
                // Use cached shadows during dragging/zooming for large molecules only
                shadows.set(this.cachedShadows);
                tints.set(this.cachedTints);
            } else {
                // Shadows disabled - use defaults (no shadows/tints)
                shadows.fill(1.0);
                tints.fill(1.0);
            }
            
            // dataRange is just the molecule's extent in Angstroms
            // Use temporary extent if set (for orienting to visible atoms), otherwise use object's maxExtent
            const effectiveExtent = this.temporaryExtent || maxExtent;
            const dataRange = (effectiveExtent * 2) || 1.0; // fallback to 1.0 to avoid div by zero
            
            // Calculate scale based on window dimensions and aspect ratio
            // Project the structure extent to screen space considering the rotation
            // The rotation matrix rows represent screen axes: R[0] = x-axis, R[1] = y-axis
            
            // Calculate projected extent in screen space (x and y directions)
            // The extent vector in 3D space, when rotated, projects to screen space
            // We approximate by using the rotation matrix rows to project the extent
            // For a roughly spherical extent, we can use the diagonal of the bounding box
            // But for better accuracy with oriented structures, we calculate projected extents
            
            // Project extent to x-axis (screen width direction)
            // The x screen axis direction is R[0], which is a unit vector
            // For a spherical extent, the projection is just the extent itself
            // But we need to account for the actual 3D extent distribution
            // Since rotation matrix rows are orthonormal, we can use the extent directly
            // but we need to consider how the 3D bounding box projects to 2D
            // Approximate by using the extent scaled by the axis alignment
            const xProjectedExtent = effectiveExtent;
            const yProjectedExtent = effectiveExtent;
            
            // Calculate scale needed for each dimension
            // We want the structure to fit within the viewport with some padding
            const padding = 0.9; // Use 90% of viewport to leave some margin
            let scaleX = (displayWidth * padding) / (xProjectedExtent * 2);
            let scaleY = (displayHeight * padding) / (yProjectedExtent * 2);
            
            // Account for perspective projection if enabled
            // In perspective mode, apparent size depends on z-depth relative to focal length
            if (this.perspectiveEnabled && this.focalLength > 0) {
                // Estimate average z-depth at the center of the structure
                // For a structure centered at origin after rotation, z-depth is approximately 0
                // But we need to account for the structure's extent in z-direction
                // Use the center z-depth as reference (structure is centered, so center z ≈ 0)
                const centerZ = 0;
                const avgZ = centerZ; // Average z-depth for perspective calculation
                
                // Perspective scale factor: focalLength / (focalLength - z)
                // For z near 0, this is approximately 1.0
                const perspectiveScale = this.focalLength / (this.focalLength - avgZ);
                
                // Adjust base scale to account for perspective
                // Perspective makes objects appear larger when closer, so we need to scale down
                // to compensate and ensure the structure fits in the viewport
                scaleX /= perspectiveScale;
                scaleY /= perspectiveScale;
            }
            
            // Use the minimum scale to ensure structure fits in both dimensions
            // This accounts for window aspect ratio
            const baseScale = Math.min(scaleX, scaleY);
            
            // Apply zoom multiplier
            const scale = baseScale * this.zoom; 
            
            // baseLineWidth is this.lineWidth (in Angstroms) converted to pixels
            const baseLineWidthPixels = this.lineWidth * scale;

            const centerX = displayWidth / 2;
            const centerY = displayHeight / 2;

            // ====================================================================
            // DETECT OUTER ENDPOINTS - For rounded edges on outer segments
            // ====================================================================
            // Build a map of atom connections to identify outer endpoints
            // Only count connections for visible segments
            const atomConnections = new Map();
            for (let i = 0; i < numVisibleSegments; i++) {
                const segIdx = visibleSegmentIndices[i];
                const segInfo = segments[segIdx];
                // Count how many times each atom appears as an endpoint
                atomConnections.set(segInfo.idx1, (atomConnections.get(segInfo.idx1) || 0) + 1);
                atomConnections.set(segInfo.idx2, (atomConnections.get(segInfo.idx2) || 0) + 1);
            }
            
            // Identify outer endpoints (atoms that appear only once - terminal atoms)
            const outerEndpoints = new Set();
            for (const [atomIdx, count] of atomConnections.entries()) {
                if (count === 1) {
                    outerEndpoints.add(atomIdx);
                }
            }
            
            // Build a map of atom index -> list of segment indices that use that atom as an endpoint
            // This helps us detect if an endpoint is covered by another segment
            // Only add visible segments to the map
            const atomToSegments = new Map();
            for (let i = 0; i < numVisibleSegments; i++) {
                const segIdx = visibleSegmentIndices[i];
                const segInfo = segments[segIdx];
                if (!atomToSegments.has(segInfo.idx1)) {
                    atomToSegments.set(segInfo.idx1, []);
                }
                atomToSegments.get(segInfo.idx1).push(segIdx);
                
                if (segInfo.idx1 !== segInfo.idx2) {
                    // Only add idx2 if it's different from idx1 (not zero-sized)
                    if (!atomToSegments.has(segInfo.idx2)) {
                        atomToSegments.set(segInfo.idx2, []);
                    }
                    atomToSegments.get(segInfo.idx2).push(segIdx);
                }
            }
            
            // Build a map from segment index to its position in the render order
            // Segments later in order are closer to camera (rendered on top)
            // Only map visible segments since we only draw visible ones and atomToSegments only contains visible segments
            const segmentOrderMap = new Map();
            for (let orderIdx = 0; orderIdx < visibleOrder.length; orderIdx++) {
                segmentOrderMap.set(visibleOrder[orderIdx], orderIdx);
            }
            
            // ====================================================================
            // OPTIMIZED DRAWING LOOP - Reduced property changes and string ops
            // ====================================================================
            // Track last canvas properties to avoid redundant changes
            let lastStrokeStyle = null;
            let lastLineWidth = null;
            let lastLineCap = null;
            
            const setCanvasProps = (strokeStyle, lineWidth, lineCap) => {
                if (strokeStyle !== lastStrokeStyle) {
                    ctx.strokeStyle = strokeStyle;
                    lastStrokeStyle = strokeStyle;
                }
                if (lineWidth !== lastLineWidth) {
                    ctx.lineWidth = lineWidth;
                    lastLineWidth = lineWidth;
                }
                if (lineCap !== lastLineCap) {
                    ctx.lineCap = lineCap;
                    lastLineCap = lineCap;
                }
            };
            
            // Only iterate over visible segments - no need for visibility check inside loop
            for (const idx of visibleOrder) {
                // --- 1. COMMON CALCULATIONS (Do these ONCE) ---
                const segInfo = segments[idx];

                // Color Calculation
                let { r, g, b } = colors[idx];
                r /= 255; g /= 255; b /= 255;

                // Cache zNorm value
                const zNormVal = zNorm[idx];

                if (renderShadows) {
                    const tintFactor = (0.50 * zNormVal + 0.50 * tints[idx]) / 3;
                    r = r + (1 - r) * tintFactor;
                    g = g + (1 - g) * tintFactor;
                    b = b + (1 - b) * tintFactor;
                    const shadowFactor = 0.20 + 0.25 * zNormVal + 0.55 * shadows[idx];
                    r *= shadowFactor; g *= shadowFactor; b *= shadowFactor;
                } else {
                    const depthFactor = 0.70 + 0.30 * zNormVal;
                    r *= depthFactor; g *= depthFactor; b *= depthFactor;
                }
                
                // Projection
                const start = rotated[segInfo.idx1];
                const end = rotated[segInfo.idx2];

                let x1, y1, x2, y2;
                let perspectiveScale1 = 1.0;
                let perspectiveScale2 = 1.0;

                if (this.perspectiveEnabled) {
                    const z1 = this.focalLength - start.z;
                    const z2 = this.focalLength - end.z;

                    if (z1 < 0.01 || z2 < 0.01) {
                        continue;
                    }

                    perspectiveScale1 = this.focalLength / z1;
                    perspectiveScale2 = this.focalLength / z2;

                    x1 = centerX + (start.x * scale * perspectiveScale1);
                    y1 = centerY - (start.y * scale * perspectiveScale1);
                    x2 = centerX + (end.x * scale * perspectiveScale2);
                    y2 = centerY - (end.y * scale * perspectiveScale2);
                } else {
                    // Orthographic projection
                    x1 = centerX + start.x * scale;
                    y1 = centerY - start.y * scale;
                    x2 = centerX + end.x * scale;
                    y2 = centerY - end.y * scale;
                }

                // Width Calculation (use ternary for faster lookup)
                const type = segInfo.type;
                const widthMultiplier = (type === 'L') ? (0.4 * 2 / 3) : ((type === 'D' || type === 'R') ? 1.6 : 1.0);
                let currentLineWidth = baseLineWidthPixels * widthMultiplier;

                if (this.perspectiveEnabled) {
                    const avgPerspectiveScale = (perspectiveScale1 + perspectiveScale2) / 2;
                    currentLineWidth *= avgPerspectiveScale;
                }
                
                currentLineWidth = Math.max(0.5, currentLineWidth);

                // --- 2. CONDITIONAL DRAWING ---
                const r_int = r * 255 | 0;
                const g_int = g * 255 | 0;
                const b_int = b * 255 | 0;
                const color = `rgb(${r_int},${g_int},${b_int})`;
                
                // Determine if this segment has outer endpoints (not touching other atoms at start/end)
                // For zero-sized segments, mark both sides as outer endpoints
                // For multi-way junctions: only the segment rendered first (furthest back) should have rounded caps
                const isZeroSized = segInfo.idx1 === segInfo.idx2;
                const currentOrderIdx = segmentOrderMap.get(idx);
                
                // Helper function to check if this segment should have rounded caps at a junction
                // Returns true if: outer endpoint OR this is the first segment (furthest back) at a multi-way junction
                const shouldRoundEndpoint = (atomIdx) => {
                    // Zero-sized segments always round
                    if (isZeroSized) return true;
                    
                    // Outer endpoints (terminal atoms) always round
                    if (outerEndpoints.has(atomIdx)) return true;
                    
                    // Check if this is a multi-way junction (3+ segments meet here)
                    const segmentsUsingAtom = atomToSegments.get(atomIdx) || [];
                    if (segmentsUsingAtom.length <= 1) {
                        // Only this segment uses this atom, so it's outer
                        return true;
                    }
                    
                    // Multi-way junction: find the segment with the lowest order index (rendered first, furthest back)
                    let lowestOrderIdx = currentOrderIdx;
                    for (const otherSegIdx of segmentsUsingAtom) {
                        const otherOrderIdx = segmentOrderMap.get(otherSegIdx);
                        if (otherOrderIdx !== undefined && otherOrderIdx < lowestOrderIdx) {
                            lowestOrderIdx = otherOrderIdx;
                        }
                    }
                    
                    // Only round if this segment is the one rendered first (furthest back)
                    return currentOrderIdx === lowestOrderIdx;
                };
                
                // Check if start endpoint should be rounded
                const hasOuterStart = shouldRoundEndpoint(segInfo.idx1);
                
                // Check if end endpoint should be rounded
                const hasOuterEnd = shouldRoundEndpoint(segInfo.idx2);
                
                if (this.outlineMode === 'none') {
                    // --- 1-STEP DRAW (No Outline) ---
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(color, currentLineWidth, 'round');
                    ctx.stroke();
                } else if (this.outlineMode === 'partial') {
                    // --- 2-STEP DRAW (Partial Outline) - Background segment with butt caps only (no rounded caps) ---
                    const gapFillerColor = `rgb(${r_int * 0.7 | 0},${g_int * 0.7 | 0},${b_int * 0.7 | 0})`;
                    const totalOutlineWidth = currentLineWidth + 3.0;

                    // Pass 1: Gap filler outline (3px larger than main line) with butt caps only
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(gapFillerColor, totalOutlineWidth, 'butt');
                    ctx.stroke();
                    
                    // No rounded caps in partial mode

                    // Pass 2: Main colored line (always round caps)
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(color, currentLineWidth, 'round');
                    ctx.stroke();
                } else { // this.outlineMode === 'full'
                    // --- 2-STEP DRAW (Full Outline) - Background segment with rounded caps at outer endpoints ---
                    const gapFillerColor = `rgb(${r_int * 0.7 | 0},${g_int * 0.7 | 0},${b_int * 0.7 | 0})`;
                    const totalOutlineWidth = currentLineWidth + 3.0;

                    // Pass 1: Gap filler outline (3px larger than main line)
                    // Draw line with butt caps, then add rounded caps manually at outer endpoints
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(gapFillerColor, totalOutlineWidth, 'butt');
                    ctx.stroke();
                    
                    // Add rounded caps at outer endpoints
                    const outlineRadius = totalOutlineWidth / 2;
                    if (hasOuterStart) {
                        ctx.beginPath();
                        ctx.arc(x1, y1, outlineRadius, 0, Math.PI * 2);
                        ctx.fillStyle = gapFillerColor;
                        ctx.fill();
                    }
                    if (hasOuterEnd) {
                        ctx.beginPath();
                        ctx.arc(x2, y2, outlineRadius, 0, Math.PI * 2);
                        ctx.fillStyle = gapFillerColor;
                        ctx.fill();
                    }

                    // Pass 2: Main colored line (always round caps)
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    setCanvasProps(color, currentLineWidth, 'round');
                    ctx.stroke();
                }
            }
            // ====================================================================
            // END OF REFACTORED LOOP
            // ====================================================================

            // ====================================================================
            // STORE ATOM SCREEN POSITIONS for fast highlight drawing
            // ====================================================================
            // Store screen positions of all atoms for overlay highlight drawing
            // This allows us to draw highlights without re-rendering the entire scene
            const numAtoms = rotated.length;
            this.atomScreenPositions = new Array(numAtoms);
            
            for (let atomIdx = 0; atomIdx < numAtoms; atomIdx++) {
                if (atomIdx < rotated.length && rotated[atomIdx]) {
                    const atom = rotated[atomIdx];
                    let x, y, radius;
                    
                    // Get atom type to determine appropriate line width multiplier
                    let widthMultiplier = 1.0;
                    if (this.atomTypes && atomIdx < this.atomTypes.length) {
                        const type = this.atomTypes[atomIdx];
                        if (type === 'L') {
                            widthMultiplier = 0.4 * 2 / 3; // Ligands are thinner
                        } else if (type === 'D' || type === 'R') {
                            widthMultiplier = 1.6; // DNA/RNA are thicker
                        }
                    }
                    let atomLineWidth = baseLineWidthPixels * widthMultiplier;
                    
                    if (this.perspectiveEnabled) {
                        const z = this.focalLength - atom.z;
                        if (z < 0.01) {
                            // Behind camera, mark as invalid
                            this.atomScreenPositions[atomIdx] = null;
                            continue;
                        } else {
                            const perspectiveScale = this.focalLength / z;
                            x = centerX + (atom.x * scale * perspectiveScale);
                            y = centerY - (atom.y * scale * perspectiveScale);
                            atomLineWidth *= perspectiveScale;
                            radius = Math.max(2, atomLineWidth * 0.5);
                        }
                    } else {
                        // Orthographic projection
                        x = centerX + atom.x * scale;
                        y = centerY - atom.y * scale;
                        radius = Math.max(2, atomLineWidth * 0.5);
                    }
                    
                    this.atomScreenPositions[atomIdx] = { x, y, radius };
                } else {
                    this.atomScreenPositions[atomIdx] = null;
                }
            }
            
            // Draw highlights on overlay canvas (doesn't require full render)
            // Highlight overlay is now managed by sequence viewer
            if (window.SequenceViewer && window.SequenceViewer.drawHighlights) {
                window.SequenceViewer.drawHighlights();
            }
        }

        // Main animation loop
        animate() {
            // Skip all work if dragging (mousemove handler calls render directly)
            if (this.isDragging) {
                // Don't schedule another frame - mousemove will call render directly
                return;
            }
            
            const now = performance.now();
            let needsRender = false;

            // 1. Handle inertia/spin - disabled during recording and for large molecules
            if (!this.isRecording) {
                // Check if object is large (disable inertia for performance based on visible segments)
                const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                const totalSegmentCount = object && this.segmentIndices ? this.segmentIndices.length : 0;
                // Count visible segments for inertia determination
                let visibleSegmentCount = totalSegmentCount;
                if (this.visibilityMask && this.segmentIndices) {
                    visibleSegmentCount = 0;
                    for (let i = 0; i < this.segmentIndices.length; i++) {
                        const seg = this.segmentIndices[i];
                        if (this.visibilityMask.has(seg.idx1) && this.visibilityMask.has(seg.idx2)) {
                            visibleSegmentCount++;
                        }
                    }
                }
                const enableInertia = visibleSegmentCount <= this.LARGE_MOLECULE_CUTOFF;
                
                if (enableInertia) {
                    const INERTIA_THRESHOLD = 0.0001; // Stop when velocity is below this
                    
                    if (Math.abs(this.spinVelocityX) > INERTIA_THRESHOLD) {
                        const rot = rotationMatrixY(this.spinVelocityX * 0.005);
                        this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                        this.spinVelocityX *= 0.95; // Damping
                        needsRender = true;
                    } else {
                        this.spinVelocityX = 0;
                    }

                    if (Math.abs(this.spinVelocityY) > INERTIA_THRESHOLD) {
                        const rot = rotationMatrixX(this.spinVelocityY * 0.005);
                        this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                        this.spinVelocityY *= 0.95; // Damping
                        needsRender = true;
                    } else {
                        this.spinVelocityY = 0;
                    }
                } else {
                    // Disable inertia for large objects
                    this.spinVelocityX = 0;
                    this.spinVelocityY = 0;
                }
            }

            // 2. Handle auto-rotate
            if (this.autoRotate && this.spinVelocityX === 0 && this.spinVelocityY === 0) {
                const rot = rotationMatrixY(0.005); // Constant rotation speed
                this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                needsRender = true;
            }

            // 3. Check if frame changed (decoupled frame advancement)
            const currentFrame = this.currentFrame;
            const previousFrame = this.lastRenderedFrame;
            if (previousFrame !== currentFrame && this.currentObjectName) {
                // Frame changed - ensure data is loaded (may have been loaded by timer)
                const object = this.objectsData[this.currentObjectName];
                if (object && object.frames[currentFrame]) {
                    // Data should already be loaded by _loadFrameData in timer
                    // But ensure it's loaded if somehow it wasn't
                    if (this.coords.length === 0 || this.lastRenderedFrame === -1) {
                        this._loadFrameData(currentFrame, true); // Load without render
                    }
                    needsRender = true;
                }
            }

            // 4. Final render if needed
            if (needsRender) {
                this.render();
                if (previousFrame !== currentFrame) {
                    this.lastRenderedFrame = currentFrame;
                }
            }

            // 5. Loop
            requestAnimationFrame(() => this.animate());
        }
        
        // Save as SVG
        saveAsSvg() {
            try {
                if (typeof C2S === 'undefined') {
                    throw new Error("canvas2svg library not loaded");
                }
                
                const canvas = this.canvas;
                if (!canvas) {
                    throw new Error("Canvas not found");
                }
                
                // Get display dimensions
                const width = this.displayWidth || parseInt(canvas.style.width) || canvas.width;
                const height = this.displayHeight || parseInt(canvas.style.height) || canvas.height;
                
                // Create SVG context and render directly to it - no context switching needed!
                const svgCtx = new C2S(width, height);
                this._renderToContext(svgCtx, width, height);
                
                // Get SVG string and download
                const svgString = svgCtx.getSerializedSvg();
                this._downloadSvg(svgString, this.currentObjectName);
            } catch (e) {
                console.error("Failed to export SVG:", e);
                const errorMsg = `Error exporting SVG: ${e.message}`;
                if (typeof setStatus === 'function') {
                    setStatus(errorMsg, true);
                } else {
                    alert(errorMsg);
                }
            }
        }
        
        // Helper method to download SVG file
        _downloadSvg(svgString, objectName) {
            // Create filename with object name and timestamp
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            
            // Sanitize object name for filename
            let name = objectName || 'viewer';
            name = name.replace(/[^a-zA-Z0-9_-]/g, '_');
            if (name.length > 50) {
                name = name.substring(0, 50);
            }
            
            const svgFilename = `py2dmol_${name}_${timestamp}.svg`;
            
            // Download the SVG file
            const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = svgFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            // Use setStatus if available (index.html), otherwise console.log (viewer.html)
            if (typeof setStatus === 'function') {
                setStatus(`SVG exported to ${svgFilename}`);
            } else {
                console.log(`SVG exported to ${svgFilename}`);
            }
        }
    }
    
    // ============================================================================
    // PAE RENDERER
    // ============================================================================
    // PAERenderer class moved to viewer-pae.js
    // Use window.PAERenderer if available (loaded from viewer-pae.js)

    // ============================================================================
    // MAIN APP & COLAB COMMUNICATION
    // ============================================================================

    // 1. Get config from Python
    // This relies on window.viewerConfig being available globally
            const config = window.viewerConfig || { 
                size: [300, 300], 
                pae_size: 300,
                color: "auto", 
                shadow: true, 
                outline: true,
                width: 3.0,
                rotate: false,
                controls: true,
                autoplay: false,
                box: true,
                pastel: 0.25,
                pae: false,
                colorblind: false
            };

    // 2. Setup Canvas with high-DPI scaling for crisp rendering
    const canvas = containerElement.querySelector('#canvas');
    if (!canvas) {
        console.error("py2dmol: Could not find #canvas element in container.");
        return;
    }
    
    // Get device pixel ratio for high-DPI displays
    // Use devicePixelRatio for native scaling, capped at 1.5x for performance
    // Can be overridden with window.canvasDPR
    const currentDPR = window.canvasDPR !== undefined ? window.canvasDPR : Math.min(window.devicePixelRatio || 1, 1.5);
    
    // Store display dimensions as constants - these never change
    const displayWidth = config.size[0];
    const displayHeight = config.size[1];
    // pae_size is now a single integer (backward compatible: if array/tuple, use first value)
    const paeSize = Array.isArray(config.pae_size) || (typeof config.pae_size === 'object' && config.pae_size.length !== undefined) 
        ? config.pae_size[0] 
        : config.pae_size;
    const paeDisplayWidth = paeSize;
    const paeDisplayHeight = paeSize;
    
    // Initialize canvas with DPI scaling (before renderer creation)
    canvas.width = displayWidth * currentDPR;
    canvas.height = displayHeight * currentDPR;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';
    
    // Scale the context to match the internal resolution
    const ctx = canvas.getContext('2d');
    ctx.scale(currentDPR, currentDPR);
    
    const viewerColumn = containerElement.querySelector('#viewerColumn');
    
    // We no longer set a fixed width on viewerColumn, to allow resizing.

    // 3. Create renderer
    const renderer = new Pseudo3DRenderer(canvas);
    
    // ADDED: ResizeObserver to handle canvas resizing
    const canvasContainer = containerElement.querySelector('#canvasContainer');
    if (canvasContainer && window.ResizeObserver) {
        const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                // Get new dimensions from the container
                let newWidth = entry.contentRect.width;
                let newHeight = entry.contentRect.height;

                // Ensure non-zero dimensions which can break canvas
                newWidth = Math.max(newWidth, 1);
                newHeight = Math.max(newHeight, 1);

                // Only update if display size actually changed
                const currentDisplayWidth = parseInt(canvas.style.width) || displayWidth;
                const currentDisplayHeight = parseInt(canvas.style.height) || displayHeight;
                
                if (Math.abs(newWidth - currentDisplayWidth) > 1 || 
                    Math.abs(newHeight - currentDisplayHeight) > 1) {
                    // Update canvas resolution with high-DPI scaling
                    const internalWidth = newWidth * currentDPR;
                    const internalHeight = newHeight * currentDPR;
                    
                    canvas.width = internalWidth;
                    canvas.height = internalHeight;
                    canvas.style.width = newWidth + 'px';
                    canvas.style.height = newHeight + 'px';
                    
                    // Scale context to match internal resolution
                    const ctx = canvas.getContext('2d');
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.scale(currentDPR, currentDPR);
                    
                    // Update cached dimensions in renderer
                    renderer._updateCanvasDimensions();

                    // Re-render the scene
                    renderer.render();
                }
            }
        });

        // Start observing the canvas container
        resizeObserver.observe(canvasContainer);
    } else if (!window.ResizeObserver) {
        console.warn("py2dmol: ResizeObserver not supported. Canvas resizing will not work.");
    }
    
    // 4. Setup PAE Renderer (if enabled and PAE module is loaded)
    if (config.pae && window.PAERenderer) {
        try {
            const paeContainer = containerElement.querySelector('#paeContainer');
            const paeCanvas = containerElement.querySelector('#paeCanvas');
            if (!paeContainer || !paeCanvas) {
                console.warn("PAE container or canvas not found");
            } else {
                renderer.paeContainer = paeContainer;
                paeContainer.style.display = 'none';
                
                // Function to update PAE canvas size based on container
                const updatePAECanvasSize = () => {
                    const containerRect = paeContainer.getBoundingClientRect();
                    const paeContainerWidth = containerRect.width || 340;
                    const paeContainerHeight = containerRect.height || paeContainerWidth;
                    
                    // Set canvas size to match container
                    paeCanvas.width = paeContainerWidth;
                    paeCanvas.height = paeContainerHeight;
                    
                    // Use 100% to fill container
                    paeCanvas.style.width = '100%';
                    paeCanvas.style.height = '100%';
                    
                    // Update context
                    const paeCtx = paeCanvas.getContext('2d');
                    paeCtx.setTransform(1, 0, 0, 1, 0, 0);
                    
                    // Update PAE renderer size if it exists
                    if (renderer.paeRenderer) {
                        renderer.paeRenderer.size = paeContainerWidth;
                        renderer.paeRenderer.scheduleRender();
                    }
                    
                    return paeContainerWidth;
                };
                
                // Set initial size (will be updated when container is visible)
                updatePAECanvasSize();
                
                // Update size when container becomes visible (in case it was hidden)
                requestAnimationFrame(() => {
                    updatePAECanvasSize();
                    
                    const paeRenderer = new window.PAERenderer(paeCanvas, renderer);
                    const containerRect = paeContainer.getBoundingClientRect();
                    paeRenderer.size = containerRect.width || 340;
                    renderer.setPAERenderer(paeRenderer);
                    // If static data was already loaded, set PAE data for current frame
                    if (renderer.currentObjectName && renderer.objectsData[renderer.currentObjectName]) {
                        const object = renderer.objectsData[renderer.currentObjectName];
                        if (object.frames && object.frames.length > 0 && renderer.currentFrame >= 0) {
                            const currentFrame = object.frames[renderer.currentFrame];
                            if (currentFrame && currentFrame.pae) {
                                paeRenderer.setData(currentFrame.pae);
                            }
                        }
                    }
                    renderer.updatePAEContainerVisibility();
                });
            }
        } catch (e) {
            console.error("Failed to initialize PAE renderer:", e);
        }
    } else if (config.pae && !window.PAERenderer) {
        console.warn("PAE is enabled but viewer-pae.js is not loaded. PAE functionality will not be available.");
    }
    
    // 5. Setup general controls
    const colorSelect = containerElement.querySelector('#colorSelect');
    
    // Initialize color mode
    const validModes = ['auto', 'chain', 'rainbow', 'plddt'];
    if (!renderer.colorMode || !validModes.includes(renderer.colorMode)) {
        renderer.colorMode = (config.color && validModes.includes(config.color)) ? config.color : 'auto';
    }
    // Sync dropdown to renderer's colorMode
    if (colorSelect && renderer.colorMode) {
        colorSelect.value = renderer.colorMode;
    }
    
    colorSelect.addEventListener('change', (e) => {
        const selectedMode = e.target.value;
        const validModes = ['auto', 'chain', 'rainbow', 'plddt'];
        
        if (validModes.includes(selectedMode)) {
            renderer.colorMode = selectedMode;
            renderer.colorsNeedUpdate = true;
            renderer.plddtColorsNeedUpdate = true;
            renderer.render();
            document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        } else {
            // Invalid mode - reset dropdown to current colorMode
            colorSelect.value = renderer.colorMode || 'auto';
        }
    });
    
    // Store reference to colorSelect in renderer for syncing
    renderer.colorSelect = colorSelect;
    
    // Setup shadowEnabledCheckbox
    const shadowEnabledCheckbox = containerElement.querySelector('#shadowEnabledCheckbox'); 
    shadowEnabledCheckbox.checked = renderer.shadowEnabled; // Set default from renderer
    
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
    const controlsContainer = containerElement.querySelector('#controlsContainer');
    const playButton = containerElement.querySelector('#playButton');
    // recordButton and saveSvgButton might be in containerElement or in document (web app vs embedded)
    const recordButton = containerElement.querySelector('#recordButton') || document.querySelector('#recordButton');
    const saveSvgButton = containerElement.querySelector('#saveSvgButton') || document.querySelector('#saveSvgButton');
    const frameSlider = containerElement.querySelector('#frameSlider');
    const frameCounter = containerElement.querySelector('#frameCounter');
    // objectSelect is now in the sequence header, query from document
    const objectSelect = document.querySelector('#objectSelect');
    const speedSelect = containerElement.querySelector('#speedSelect');
    const rotationCheckbox = containerElement.querySelector('#rotationCheckbox');
    const lineWidthSlider = containerElement.querySelector('#lineWidthSlider');
    const orthoSlider = containerElement.querySelector('#orthoSlider');

    
    // Set defaults for width, rotate, and pastel
    lineWidthSlider.value = renderer.lineWidth;
    rotationCheckbox.checked = renderer.autoRotate;

    // Pass ALL controls to the renderer
    renderer.setUIControls(
        controlsContainer, playButton, recordButton, saveSvgButton,
        frameSlider, frameCounter, objectSelect,
        speedSelect, rotationCheckbox, lineWidthSlider,
        shadowEnabledCheckbox, outlineModeButton, outlineModeSelect,
        colorblindCheckbox, orthoSlider
    );
    
    // Setup save state button (for Python interface only - web interface handles it in app.js)
    // Only add listener if we're in Python interface (no window.saveViewerState exists yet)
    const saveStateButton = containerElement.querySelector('#saveStateButton');
    if (saveStateButton && typeof window.saveViewerState !== 'function') {
        saveStateButton.addEventListener('click', () => {
            // For Python interface, use view.save_state(filepath) method
            alert("Save state: Use the Python method view.save_state(filepath) to save the current state.");
        });
    }
    
    // Set ortho slider from config
    if (config.ortho !== undefined && orthoSlider) {
        orthoSlider.value = normalizeOrthoValue(config.ortho);
        // The slider's input event will be triggered after data loads to set the correct focalLength
    }
    


    // Handle new UI config options
    if (!config.controls) {
        const rightPanel = containerElement.querySelector('#rightPanelContainer');
        if (rightPanel) rightPanel.style.display = 'none';
        // controlsContainer is handled by updateUIControls
    }

    // Handle box
    if (!config.box) {
        const canvasCont = containerElement.querySelector('#canvasContainer');
        if (canvasCont) {
            canvasCont.style.border = 'none';
            canvasCont.style.background = 'transparent';
        }
        if (canvas) canvas.style.background = 'transparent';
        
        // Also update PAE canvas if it exists
        if (config.pae) {
            const paeCanvas = containerElement.querySelector('#paeCanvas');
            if(paeCanvas) {
                paeCanvas.style.border = 'none';
                paeCanvas.style.background = 'transparent';
            }
        }
        
        renderer.setClearColor(true); 
    }

    // 7. Add function for Python to call (for new frames)
    // These are now locally scoped consts, not on window
    const handlePythonUpdate = (jsonData, objectName) => {
        try {
            const data = JSON.parse(jsonData);
            // Pass name to addFrame
            renderer.addFrame(data, objectName);
        } catch (e) {
            console.error("Failed to parse JSON from Python:", e);
        }
    };

    // 8. Add function for Python to start a new object
    const handlePythonNewObject = (name) => {
        renderer.addObject(name);
    };

    // 9. Add function for Python to clear everything
    const handlePythonClearAll = () => {
        renderer.clearAllObjects();
    };
    
    // 9b. Add function to reset all controls and state
    const handlePythonResetAll = () => {
        renderer.resetAll();
    };
    
    // 10. Add function for Python to set color mode (e.g., for from_afdb)
    const handlePythonSetColor = (colorMode) => {
        if (colorSelect) {
            colorSelect.value = colorMode;
            // Manually trigger the change event
            colorSelect.dispatchEvent(new Event('change'));
        }
    };


    // 11. Load initial data
    if (window.staticObjectData && window.staticObjectData.length > 0) {
        // === STATIC MODE (from show()) ===
        try {
            for (const obj of window.staticObjectData) {
                if (obj.name && obj.frames && obj.frames.length > 0) {
                    
                    const staticChains = obj.chains; // Might be undefined
                    const staticAtomTypes = obj.atom_types; // Might be undefined
                    
                    for (let i = 0; i < obj.frames.length; i++) {
                        const lightFrame = obj.frames[i];
                        
                        // Re-construct the full frame data, keys might be undefined
                        const fullFrameData = {
                            coords: lightFrame.coords,
                            plddts: lightFrame.plddts,
                            pae: lightFrame.pae,
                            chains: staticChains,
                            atom_types: staticAtomTypes,
                            residues: lightFrame.residues,
                            residue_index: lightFrame.residue_index
                        };
                        
                        renderer.addFrame(fullFrameData, obj.name);
                    }
                }
            }
            // Set view to the first frame of the first object
            if (window.staticObjectData.length > 0) {
                renderer.currentObjectName = window.staticObjectData[0].name;
                renderer.objectSelect.value = window.staticObjectData[0].name;
                renderer.setFrame(0);
                // Update PAE container visibility after initial load
                // Use requestAnimationFrame to ensure PAE renderer is initialized
                requestAnimationFrame(() => {
                    renderer.updatePAEContainerVisibility();
                });
            }
        } catch (error) {
            console.error("Error loading static object data:", error);
            renderer.setFrame(-1); // Start empty on error
        }
        
    } else if (window.proteinData && window.proteinData.coords && window.proteinData.coords.length > 0) {
        // === HYBRID MODE (first frame) ===
        try {
            // Load the single, statically-injected frame into "0"
            renderer.addFrame(window.proteinData, "0"); 
        } catch (error) {
            console.error("Error loading initial data:", error);
            renderer.setFrame(-1);
        }
    } else {
        // === EMPTY DYNAMIC MODE ===
        // No initial data, start with an empty canvas.
        renderer.setFrame(-1);
    }
    
    // After data load, trigger ortho slider to set correct initial focal length
    if (orthoSlider) {
        orthoSlider.dispatchEvent(new Event('input'));
    }


    // 12. Start the main animation loop
    renderer.animate();
    
    // 13. Expose Public API
    const viewer_id = config.viewer_id;
    if (viewer_id) {
        window.py2dmol_viewers[viewer_id] = {
            handlePythonUpdate,
            handlePythonNewObject,
            handlePythonClearAll,
            handlePythonResetAll,
            handlePythonSetColor,
            renderer // Expose the renderer instance for external access
        };
    } else {
        console.error("py2dmol: viewer_id not found in config. Cannot register API.");
    }

} // <-- End of initializePy2DmolViewer