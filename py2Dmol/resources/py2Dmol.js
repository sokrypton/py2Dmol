// ============================================================================
// GLOBAL REGISTRY
// ============================================================================
// Global registry for all viewer instances
if (!window.py2dmol_viewers) {
    window.py2dmol_viewers = {};
}

/**
 * Initializes a py2dmol viewer instance within a specific container.
 * All logic is scoped to this container.
 * @param {HTMLElement} containerElement The root <div> element for this viewer.
 */
function initializePy2DmolViewer(containerElement) {
    
    // Helper function to normalize ortho value from old (50-200) or new (0-1) format
    function normalizeOrthoValue(value) {
        if (typeof value !== 'number') return 0.5; // Default
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
    // PSEUDO-3D RENDERER
    // ============================================================================
    class Pseudo3DRenderer {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            
            // Get config from Python
            // This relies on window.viewerConfig being available globally
            const config = window.viewerConfig || { 
                size: [300, 300], 
                pae_size: [300, 300],
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

            // Current render state
            this.coords = []; // This is now an array of Vec3 objects
            this.plddts = [];
            this.chains = [];
            this.atomTypes = [];
            
            // Viewer state
            this.colorMode = config.color; // Set initial color from config
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
            this.outlineEnabled = (typeof config.outline === 'boolean') ? config.outline : true;
            this.pastelLevel = (typeof config.pastel === 'number') ? config.pastel : 0.25;
            this.colorblindMode = (typeof config.colorblind === 'boolean') ? config.colorblind : false;
            
            this.isTransparent = false; // Default to white background
            this.resolvedAutoColor = 'rainbow'; // Default 'auto' to rainbow
            
            // Performance
            this.chainRainbowScales = {};
            this.perChainIndices = [];
            this.rotatedCoords = []; 
            this.segmentIndices = []; 
            this.segData = []; 
            this.colors = []; 
            this.plddtColors = []; 

            // Animation & State
            this.objectsData = {};
            this.currentObjectName = null;
            this.currentFrame = -1;
            
            // Playback
            this.isPlaying = false;
            this.animationSpeed = 100; // ms per frame
            this.lastFrameAdvanceTime = 0;
            
            // Interaction
            this.isDragging = false;
            this.autoRotate = (typeof config.rotate === 'boolean') ? config.rotate : false;             
            this.autoplay = (typeof config.autoplay === 'boolean') ? config.autoplay : false; 

            // Perspective mode (for testing - change these values!)
            // this.perspectiveEnabled = true; // Set to true to enable perspective
            // this.focalLength = 200; // Smaller = more dramatic perspective (try 300-800)
            
            // Inertia
            this.spinVelocityX = 0;
            this.spinVelocityY = 0;
            this.lastDragTime = 0;
            this.lastDragX = 0;
            this.lastDragY = 0;
            
            // Touch
            this.initialPinchDistance = 0;

            // Track slider interaction
            this.isSliderDragging = false;
            
            // PAE and Visibility
            this.paeRenderer = null;
            this.visibilityMask = null; // Set of atom indices to *show*
            this.polymerAtomIndices = []; // Map residue index -> atom index
            this.highlightedResidue = null; // To store { chain, residueIndex }

            // [PATCH] Unified selection model (sequence/chain + PAE)
            // residues: Set of 'CHAIN:RESSEQ' strings (explicit sequence/chain picks)
            // chains: Set of chain IDs (empty => all chains)
            // paeBoxes: Array of selection rectangles in residue-index space {i_start,i_end,j_start,j_end}
            // selectionMode: 'default' = empty selection means "show all" (initial state)
            //                'explicit' = empty selection means "show nothing" (user cleared)
            this.selectionModel = {
                residues: new Set(),
                chains: new Set(),
                paeBoxes: [],
                selectionMode: 'default' // Start in default mode (show all)
            };

            // UI elements
            this.playButton = null;
            this.recordButton = null;
            this.frameSlider = null;
            this.frameCounter = null;
            this.objectSelect = null;
            this.controlsContainer = null;
            this.speedSelect = null;
            this.rotationCheckbox = null;
            this.lineWidthSlider = null;
            this.shadowEnabledCheckbox = null; 
            this.outlineEnabledCheckbox = null; 
            this.colorblindCheckbox = null;
            this.orthoSlider = null;
            
            // Recording state
            this.isRecording = false;
            this.mediaRecorder = null;
            this.recordedChunks = [];
            this.recordingStream = null;
            this.recordingEndFrame = 0;

            this.setupInteraction();
        }

        setClearColor(isTransparent) {
            this.isTransparent = isTransparent;
            this.render(); // Re-render with new clear color
        }
        
        // [PATCH] --- Unified Selection API ---
        setSelection(patch) {
            if (!patch) return;
            if (patch.residues !== undefined) {
                const r = patch.residues;
                this.selectionModel.residues = (r instanceof Set) ? new Set(r) : new Set(Array.from(r || []));
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
                residues: new Set(m.residues),
                chains: new Set(m.chains),
                paeBoxes: m.paeBoxes.map(b => ({...b})),
                selectionMode: m.selectionMode
            };
        }

        resetSelection() {
            this.selectionModel = { 
                residues: new Set(), 
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
            
            // Select all residues
            const allResidues = new Set();
            for (let i = 0; i < n; i++) {
                const ch = this.chains[i];
                const rid = `${ch}:${this.residue_index[i]}`;
                allResidues.add(rid);
            }
            
            // Select all chains
            const allChains = new Set(this.chains);
            
            // Clear PAE boxes when resetting to default (select all)
            this.setSelection({
                residues: allResidues,
                chains: allChains,
                paeBoxes: [],
                selectionMode: 'default'
            });
        }

        // Clear all selections: show nothing (explicit mode)
        clearSelection() {
            this.setSelection({
                residues: new Set(),
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

            // (1) Sequence/Chain contribution
            // Always compute sequence selection - it works together with PAE via UNION
            let allowedChains;
            if (this.selectionModel.chains && this.selectionModel.chains.size > 0) {
                allowedChains = this.selectionModel.chains;
            } else {
                // All chains
                allowedChains = new Set(this.chains);
            }

            let seqAtoms = null;
            if ((this.selectionModel.residues && this.selectionModel.residues.size > 0) ||
                (this.selectionModel.chains && this.selectionModel.chains.size > 0)) {
                seqAtoms = new Set();
                for (let i = 0; i < n; i++) {
                    const ch = this.chains[i];
                    if (!allowedChains.has(ch)) continue;
                    const rid = `${ch}:${this.residue_index[i]}`;
                    if (this.selectionModel.residues.size === 0 || this.selectionModel.residues.has(rid)) {
                        seqAtoms.add(i);
                    }
                }
            }

            // (2) PAE contribution: expand i/j ranges into polymer residue atoms
            let paeAtoms = null;
            if (this.selectionModel.paeBoxes && this.selectionModel.paeBoxes.length > 0 && Array.isArray(this.polymerAtomIndices)) {
                paeAtoms = new Set();
                const L = this.polymerAtomIndices.length;
                for (const box of this.selectionModel.paeBoxes) {
                    const i0 = Math.max(0, Math.min(L - 1, Math.min(box.i_start, box.i_end)));
                    const i1 = Math.max(0, Math.min(L - 1, Math.max(box.i_start, box.i_end)));
                    const j0 = Math.max(0, Math.min(L - 1, Math.min(box.j_start, box.j_end)));
                    const j1 = Math.max(0, Math.min(L - 1, Math.max(box.j_start, box.j_end)));
                    for (let r = i0; r <= i1; r++) { paeAtoms.add(this.polymerAtomIndices[r]); }
                    for (let r = j0; r <= j1; r++) { paeAtoms.add(this.polymerAtomIndices[r]); }
                }
                // Include all ligands when PAE selection is active (runtime only; parse-time ignore_ligand takes precedence)
                for (let i = 0; i < n; i++) { 
                    if (this.atomTypes[i] === 'L') {
                        paeAtoms.add(i);
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
                                residues: Array.from(this.selectionModel.residues),
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

        getTouchDistance(touch1, touch2) {
            const dx = touch1.clientX - touch2.clientX;
            const dy = touch1.clientY - touch2.clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }
        
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
                
                // Stop canvas drag if interacting with controls
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') {
                    this.isDragging = false;
                    return;
                }
                
                const now = performance.now();
                const timeDelta = now - this.lastDragTime;

                const dx = e.clientX - this.lastDragX;
                const dy = e.clientY - this.lastDragY;
                
                if (dy !== 0) { const rot = rotationMatrixX(dy * 0.01); this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); }
                if (dx !== 0) { const rot = rotationMatrixY(dx * 0.01); this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); }

                // Store velocity for inertia
                if (timeDelta > 0) {
                    // Weighted average to smooth out jerky movements
                    const smoothing = 0.5;
                    this.spinVelocityX = (this.spinVelocityX * (1-smoothing)) + ((dx / timeDelta * 20) * smoothing);
                    this.spinVelocityY = (this.spinVelocityY * (1-smoothing)) + ((dy / timeDelta * 20) * smoothing);
                }

                this.lastDragX = e.clientX;
                this.lastDragY = e.clientY;
                this.lastDragTime = now;
                
                this.render(); 
            });
            
            window.addEventListener('mouseup', () => {
                this.isDragging = false;
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
                this.zoom *= (1 - e.deltaY * 0.001);
                this.zoom = Math.max(0.1, Math.min(5, this.zoom));
                this.render();
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

                    // Store velocity for inertia
                    if (timeDelta > 0) {
                        const smoothing = 0.5;
                        this.spinVelocityX = (this.spinVelocityX * (1-smoothing)) + ((dx / timeDelta * 20) * smoothing);
                        this.spinVelocityY = (this.spinVelocityY * (1-smoothing)) + ((dy / timeDelta * 20) * smoothing);
                    }

                    this.lastDragX = touch.clientX;
                    this.lastDragY = touch.clientY;
                    this.lastDragTime = now;
                    
                    this.render(); 
                } else if (e.touches.length === 2) {
                    // Zoom/Pinch
                    if (this.initialPinchDistance <= 0) return; // Not initialized
                    
                    const currentPinchDistance = this.getTouchDistance(e.touches[0], e.touches[1]);
                    const scale = currentPinchDistance / this.initialPinchDistance;
                    
                    this.zoom *= scale;
                    this.zoom = Math.max(0.1, Math.min(5, this.zoom));
                    this.render();
                    
                    // Reset for next move event
                    this.initialPinchDistance = currentPinchDistance;
                }
            }, { passive: false });
            
            this.canvas.addEventListener('touchend', (e) => {
                // Handle inertia for drag
                if (e.touches.length === 0 && this.isDragging) {
                    this.isDragging = false;
                    const now = performance.now();
                    const timeDelta = now - this.lastDragTime;
                    
                    if (timeDelta > 100) { // If drag was too slow, or just a tap
                        this.spinVelocityX = 0;
                        this.spinVelocityY = 0;
                    }
                }
                
                // Handle end of pinch
                if (e.touches.length < 2) {
                    this.initialPinchDistance = 0;
                }
                
                // If all touches are up, reset dragging
                if (e.touches.length === 0) {
                    this.isDragging = false;
                }
            });
        }

        // Set UI controls from main script
        setUIControls(controlsContainer, playButton, recordButton, frameSlider, frameCounter, objectSelect, speedSelect, rotationCheckbox, lineWidthSlider, shadowEnabledCheckbox, outlineEnabledCheckbox, colorblindCheckbox, orthoSlider) {
            this.controlsContainer = controlsContainer;
            this.playButton = playButton;
            this.recordButton = recordButton;
            this.frameSlider = frameSlider;
            this.frameCounter = frameCounter;
            this.objectSelect = objectSelect;
            this.speedSelect = speedSelect;
            this.rotationCheckbox = rotationCheckbox;
            this.lineWidthSlider = lineWidthSlider;
            this.shadowEnabledCheckbox = shadowEnabledCheckbox; 
            this.outlineEnabledCheckbox = outlineEnabledCheckbox;
            this.colorblindCheckbox = colorblindCheckbox;
            this.orthoSlider = orthoSlider;
            
            this.lineWidth = parseFloat(this.lineWidthSlider.value); // Read default from slider
            this.autoRotate = this.rotationCheckbox.checked; // Read default from checkbox

            // Bind all event listeners
            this.playButton.addEventListener('click', () => {
                this.togglePlay();
            });
            
            if (this.recordButton) {
                this.recordButton.addEventListener('click', () => {
                    this.toggleRecording();
                });
            }

            if (this.objectSelect) {
                this.objectSelect.addEventListener('change', () => {
                    this.stopAnimation();
                    this.currentObjectName = this.objectSelect.value;
                    this.setFrame(0);
                });
            }

            this.speedSelect.addEventListener('change', (e) => {
                this.animationSpeed = parseInt(e.target.value);
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
                        this.focalLength = baseSize * PERSPECTIVE_MAX_MULT; // Not used, but set for consistency
                    } else {
                        // Perspective mode: interpolate focal length based on slider value
                        this.perspectiveEnabled = true;
                        const multiplier = PERSPECTIVE_MIN_MULT + (PERSPECTIVE_MAX_MULT - PERSPECTIVE_MIN_MULT) * normalizedValue;
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

            if (this.outlineEnabledCheckbox) {
                this.outlineEnabledCheckbox.addEventListener('change', (e) => {
                    this.outlineEnabled = e.target.checked;
                    this.render();
                });
            }
            
            if (this.colorblindCheckbox) {
                this.colorblindCheckbox.addEventListener('change', (e) => {
                    this.colorblindMode = e.target.checked;
                    // Recalculate all colors
                    this.colors = this._calculateSegmentColors();
                    this.plddtColors = this._calculatePlddtColors();
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
                                 this.shadowEnabledCheckbox, this.outlineEnabledCheckbox,
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
            this.objectsData[name] = { maxExtent: 0, stdDev: 0, frames: [], globalCenterSum: new Vec3(0,0,0), totalAtoms: 0 };
            this.currentObjectName = name;
            this.currentFrame = -1;

            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            if (this.objectSelect) {
                this.objectSelect.appendChild(option);
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
                if (this.objectSelect) {
                    this.objectSelect.value = targetObjectName;
                }
            }

            // Update global center sum and count
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

        // Set the current frame and render it
        setFrame(frameIndex) {
            frameIndex = parseInt(frameIndex);
            
            // Handle clearing the canvas based on transparency
            const clearCanvas = () => {
                if (this.isTransparent) {
                    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                } else {
                    this.ctx.fillStyle = '#ffffff';
                    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
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
            const data = object.frames[frameIndex];
            
            // Load 3D data
            this._loadDataIntoRenderer(data); // This calls render()
            
            // Load PAE data
            if (this.paeRenderer) {
                this.paeRenderer.setData(data.pae || null);
            }
            
            this.updateUIControls(); // Update slider value
            this.setUIEnabled(true); // Make sure controls are enabled
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
             if (this.outlineEnabledCheckbox) this.outlineEnabledCheckbox.disabled = !enabled;
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
            
            // Handle object selection dropdown visibility
            if (this.objectSelect) {
                // Find the objectContainer relative to the main container
                const objectContainer = containerElement.querySelector('#objectContainer');
                if (objectContainer) {
                    // Always show if controls are enabled (regardless of number of objects)
                    objectContainer.style.display = config.controls ? 'flex' : 'none';
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
                this.recordButton.disabled = !this.currentObjectName || 
                    !this.objectsData[this.currentObjectName] || 
                    this.objectsData[this.currentObjectName].frames.length < 2;
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
                this.setFrame(0);
            }

            this.isPlaying = true;
            // Set timing to allow immediate frame advance on next animation loop
            // Use a time far enough in the past to ensure immediate advancement
            this.lastFrameAdvanceTime = performance.now() - (this.animationSpeed * 2); // Set to 2x animation speed in the past
            this.updateUIControls();
        }

        // Stop playback
        stopAnimation() {
            this.isPlaying = false;
            this.updateUIControls();
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
            if (this.recordingStream) {
                this.recordingStream.getTracks().forEach(track => track.stop());
                this.recordingStream = null;
            }
            this.mediaRecorder = null;
            this.recordedChunks = [];
            
            // Set recording state
            this.isRecording = true;
            this.recordingEndFrame = object.frames.length - 1;
            
            // Capture stream from canvas at 30fps for smooth playback
            const fps = 30;
            this.recordingStream = this.canvas.captureStream(fps);
            
            // Set up MediaRecorder with low compression (high quality)
            const options = {
                mimeType: 'video/webm;codecs=vp9', // VP9 for better quality
                videoBitsPerSecond: 8000000 // 8 Mbps for high quality (low compression)
            };
            
            // Fallback to VP8 if VP9 not supported
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm;codecs=vp8';
                options.videoBitsPerSecond = 5000000; // 5 Mbps for VP8
            }
            
            // Fallback to default if neither supported
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options.mimeType = 'video/webm';
                options.videoBitsPerSecond = 5000000;
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
                
                // Use requestAnimationFrame to ensure state is set before next animation loop iteration
                requestAnimationFrame(() => {
                    // Start animation - set timing so first frame advances immediately
                    const now = performance.now();
                    this.lastFrameAdvanceTime = now - (this.animationSpeed * 2); // Set to 2x animation speed in the past
                    this.isPlaying = true; // Set this AFTER setting lastFrameAdvanceTime
                    this.updateUIControls();
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
            if (!this.isRecording || !this.mediaRecorder) {
                return;
            }
            
            // Stop animation
            this.stopAnimation();
            
            // Stop MediaRecorder
            if (this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
            
            // Stop stream
            if (this.recordingStream) {
                this.recordingStream.getTracks().forEach(track => track.stop());
                this.recordingStream = null;
            }
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
            if (this.recordingStream) {
                this.recordingStream.getTracks().forEach(track => track.stop());
                this.recordingStream = null;
            }
            
            // Ensure animation is fully stopped and state is clean
            this.stopAnimation();
            
            // Reset animation timing - set to a time in the past so next play starts immediately
            this.lastFrameAdvanceTime = performance.now() - this.animationSpeed - 1;
            
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

        _loadDataIntoRenderer(data) {
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
                        data.residue_index
                    );
                }
            } catch (e) {
                console.error("Failed to load data into renderer:", e);
            }
        }

        setCoords(coords, plddts, chains, atomTypes, hasPAE = false, residues, residue_index) {
            this.coords = coords;
            const n = this.coords.length;

            // --- Handle Defaults for Missing Data ---
            this.plddts = (plddts && plddts.length === n) ? plddts : Array(n).fill(50.0);
            this.chains = (chains && chains.length === n) ? chains : Array(n).fill('A');
            this.atomTypes = (atomTypes && atomTypes.length === n) ? atomTypes : Array(n).fill('P');
            this.residues = (residues && residues.length === n) ? residues : Array(n).fill('UNK');
            this.residue_index = (residue_index && residue_index.length === n) ? residue_index : Array.from({length: n}, (_, i) => i + 1);

            // "auto" logic:
            // Priority: plddt (if PAE present) > chain (if multi-chain) > rainbow
            const uniqueChains = new Set(this.chains);
            if (hasPAE) {
                this.resolvedAutoColor = 'plddt';
            } else if (this.chains && uniqueChains.size > 1) {
                this.resolvedAutoColor = 'chain';
            } else {
                this.resolvedAutoColor = 'rainbow';
            }

            // Create the definitive chain index map for this dataset.
            this.chainIndexMap = new Map();
            if (this.chains.length > 0) {
                // Use a sorted list of unique chain IDs to ensure a consistent order
                const sortedUniqueChains = [...uniqueChains].sort();
                for (const chainId of sortedUniqueChains) {
                    if (chainId && !this.chainIndexMap.has(chainId)) {
                        this.chainIndexMap.set(chainId, this.chainIndexMap.size);
                    }
                }
            }

            // Map polymer atoms to residue indices for PAE selection
            this.polymerAtomIndices = [];
            const isPolymer = (type) => (type === 'P' || type === 'D' || type === 'R');
            for (let i = 0; i < n; i++) {
                if (isPolymer(this.atomTypes[i])) {
                    this.polymerAtomIndices.push(i);
                }
            }

            // Pre-calculate per-chain indices for rainbow coloring (N-to-C)
            this.perChainIndices = new Array(n);
            const chainIndices = {}; // Temporary tracker
            for (let i = 0; i < n; i++) {
                const type = this.atomTypes[i];
                if (type === 'P' || type === 'D' || type === 'R') {
                    const chainId = this.chains[i] || 'A';
                    if (chainIndices[chainId] === undefined) {
                        chainIndices[chainId] = 0;
                    }
                    this.perChainIndices[i] = chainIndices[chainId];
                    chainIndices[chainId]++;
                } else {
                    this.perChainIndices[i] = 0; // Default for ligands
                }
            }

            // Pre-calculate rainbow scales
            this.chainRainbowScales = {};
            for (let i = 0; i < this.atomTypes.length; i++) {
                const type = this.atomTypes[i];
                if (type === 'P' || type === 'D' || type === 'R') {
                    const chainId = this.chains[i] || 'A';
                    if (!this.chainRainbowScales[chainId]) { 
                        this.chainRainbowScales[chainId] = { min: Infinity, max: -Infinity }; 
                    }
                    const colorIndex = this.perChainIndices[i]; 
                    const scale = this.chainRainbowScales[chainId];
                    scale.min = Math.min(scale.min, colorIndex);
                    scale.max = Math.max(scale.max, colorIndex);
                }
            }
            
            // Pre-allocate rotatedCoords array
            if (this.rotatedCoords.length !== n) {
                this.rotatedCoords = Array.from({ length: n }, () => new Vec3(0, 0, 0));
            }

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

            // Iterate over each chain's ligands separately
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
            
            // Pre-allocate segData array
            const m = this.segmentIndices.length;
            if (this.segData.length !== m) {
                this.segData = Array.from({ length: m }, () => ({
                    x: 0, y: 0, z: 0, len: 0, zVal: 0, gx: -1, gy: -1
                }));
            }
            
            // Pre-calculate colors ONCE (if not plddt)
            this.colors = this._calculateSegmentColors();
            
            // Pre-calculate pLDDT colors
            this.plddtColors = this._calculatePlddtColors();


            // Trigger first render
            this.render(); 
        
            // [PATCH] Apply initial mask
            this._composeAndApplyMask();
            
            // Dispatch event to notify sequence viewer that colors have changed (e.g., when frame changes)
            document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
        }

        getAtomColor(atomIndex) {
            if (atomIndex < 0 || atomIndex >= this.coords.length) {
                return this._applyPastel({ r: 128, g: 128, b: 128 }); // Default grey
            }

            let effectiveColorMode = this.colorMode;
            if (effectiveColorMode === 'auto') {
                effectiveColorMode = this.resolvedAutoColor || 'rainbow';
            }

            const type = this.atomTypes[atomIndex];
            let color;

            if (effectiveColorMode === 'plddt') {
                const plddtFunc = this.colorblindMode ? getPlddtColor_Colorblind : getPlddtColor;
                const plddt = (this.plddts[atomIndex] !== null && this.plddts[atomIndex] !== undefined) ? this.plddts[atomIndex] : 50;
                color = plddtFunc(plddt);
            } else {
                 if (type === 'L') {
                    color = { r: 128, g: 128, b: 128 }; // Ligands are grey
                } else if (effectiveColorMode === 'chain') {
                    const chainId = this.chains[atomIndex] || 'A';
                    const chainIndex = this.chainIndexMap.get(chainId) || 0;
                    const colorArray = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
                    const hex = colorArray[chainIndex % colorArray.length];
                    color = hexToRgb(hex);
                } else { // rainbow
                    const chainId = this.chains[atomIndex] || 'A';
                    const scale = this.chainRainbowScales[chainId];
                    const rainbowFunc = this.colorblindMode ? getRainbowColor_Colorblind : getRainbowColor;
                    if (scale) {
                        const colorIndex = this.perChainIndices[atomIndex];
                        color = rainbowFunc(colorIndex, scale.min, scale.max);
                    } else {
                        color = { r: 128, g: 128, b: 128 };
                    }
                }
            }

            return this._applyPastel(color);
        }
        
        // Calculate segment colors (chain or rainbow)
        _calculateSegmentColors() {
            const m = this.segmentIndices.length;
            if (m === 0) return [];

            let effectiveColorMode = this.colorMode;
            if (effectiveColorMode === 'auto') {
                effectiveColorMode = this.resolvedAutoColor || 'rainbow';
            }

            const rainbowFunc = this.colorblindMode ? getRainbowColor_Colorblind : getRainbowColor;
            const chainColors = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
            const grey = {r: 128, g: 128, b: 128};

            return this.segmentIndices.map(segInfo => {
                let color;
                const i = segInfo.origIndex;
                const type = segInfo.type;

                if (type === 'L') {
                    color = grey;
                } else if (effectiveColorMode === 'chain') {
                    const chainId = this.chains[i] || 'A';
                    const chainIndex = this.chainIndexMap.get(chainId) || 0;
                    const hex = chainColors[chainIndex % chainColors.length];
                    color = hexToRgb(hex);
                } else { // 'rainbow' or other modes
                    const scale = this.chainRainbowScales[segInfo.chainId];
                    if (scale) {
                        color = rainbowFunc(segInfo.colorIndex, scale.min, scale.max);
                    } else {
                        color = grey;
                    }
                }
                return this._applyPastel(color);
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
            const avgLen = (s1.len + s2.len) * 0.5;
            const shadow_cutoff = avgLen * 2.0;
            const tint_cutoff = avgLen * 0.5;
            const max_cutoff = shadow_cutoff + 10.0;
            
            // Use properties from the segment data objects
            const dx_dist = s1.x - s2.x;
            const dy_dist = s1.y - s2.y;
            
            const dist2D_sq = dx_dist * dx_dist + dy_dist * dy_dist;
            const max_cutoff_sq = max_cutoff * max_cutoff;
            
            let shadow = 0;
            let tint = 0;

            if (dist2D_sq > max_cutoff_sq) {
                return { shadow: 0, tint: 0 };
            }
            
            const dz = s1.z - s2.z;
            const dist3D_sq = dist2D_sq + dz * dz;
            
            if (dist3D_sq < max_cutoff_sq) {
                const dist3D = Math.sqrt(dist3D_sq);
                shadow = sigmoid(shadow_cutoff - dist3D);
            }
            
            const tint_max_cutoff = tint_cutoff + 10.0;
            const tint_max_cutoff_sq = tint_max_cutoff * tint_max_cutoff;
            
            if (dist2D_sq < tint_max_cutoff_sq) {
                const dist2D = Math.sqrt(dist2D_sq);
                tint = sigmoid(tint_cutoff - dist2D);
            }

            return { shadow, tint };
        }


        // RENDER (Core drawing logic)
        render() {
            const startTime = performance.now();
            // Use clearRect or fillRect based on transparency
            if (this.isTransparent) {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            } else {
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            }
            
            // Check segment length
            if (this.coords.length === 0 || this.segmentIndices.length === 0 || !this.currentObjectName) return;

            const object = this.objectsData[this.currentObjectName];
            if (!object) {
                console.warn("Render called but object data is missing.");
                return;
            }

            const globalCenter = (object && object.totalAtoms > 0) ? object.globalCenterSum.mul(1 / object.totalAtoms) : new Vec3(0,0,0);
            
            // Use temporary center if set (for orienting to visible atoms), otherwise use global center
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
            
            // Resolve effective color mode
            let effectiveColorMode = this.colorMode;
            if (effectiveColorMode === 'auto') {
                effectiveColorMode = this.resolvedAutoColor || 'rainbow';
            }
            
            // Select pre-calculated color array
            let colors;
            if (effectiveColorMode === 'plddt') {
                if (!this.plddtColors || this.plddtColors.length !== n) {
                    this.plddtColors = this._calculatePlddtColors();
                }
                colors = this.plddtColors;
            } else {
                if (!this.colors || this.colors.length !== n) {
                    this.colors = this._calculateSegmentColors();
                }
                colors = this.colors;
            }
            if (!colors || colors.length !== n) { // Safety check
                console.warn("Color array mismatch, recalculating.");
                this.colors = this._calculateSegmentColors();
                this.plddtColors = this._calculatePlddtColors();
                colors = (effectiveColorMode === 'plddt') ? this.plddtColors : this.colors;
                if (colors.length !== n) {
                     console.error("Color array mismatch even after recalculation. Aborting render.");
                     return; // Still bad, abort render
                }
            }
            
            // Combine Z-value/norm and update segData
            const zValues = new Float32Array(n);
            let zMin = Infinity;
            let zMax = -Infinity;
            const segData = this.segData; // Use pre-allocated array

            for (let i = 0; i < n; i++) {
                const segInfo = segments[i];
                const start = rotated[segInfo.idx1];
                const end = rotated[segInfo.idx2];


                
                const midX = (start.x + end.x) * 0.5;
                const midY = (start.y + end.y) * 0.5;
                const midZ = (start.z + end.z) * 0.5;
                const z = midZ; // zValue is just midZ
                
                zValues[i] = z;
                if (z < zMin) zMin = z;
                if (z > zMax) zMax = z;
                
                // Update pre-allocated segData object
                const s = segData[i];
                s.x = midX;
                s.y = midY;
                s.z = midZ;
                s.len = segInfo.len; // Use pre-calculated length
                s.zVal = z;
                // gx/gy are reset in shadow logic
            }
            
            const zNorm = new Float32Array(n);
            const zRange = zMax - zMin;
            if (zRange > 1e-6) {
                for (let i = 0; i < n; i++) {
                    zNorm[i] = (zValues[i] - zMin) / zRange;
                }
            } else {
                zNorm.fill(0);
            }
            
            const renderShadows = this.shadowEnabled;
            const maxExtent = (object && object.maxExtent > 0) ? object.maxExtent : 30.0;

            const shadows = new Float32Array(n);
            const tints = new Float32Array(n);
            const order = Array.from({length: n}, (_, i) => i).sort((a, b) => zValues[a] - zValues[b]);
            
            const visibilityMask = this.visibilityMask; // Cache for performance

            if (renderShadows) {
                if (n <= 1000) {
                    for (let i_idx = n - 1; i_idx >= 0; i_idx--) {
                        const i = order[i_idx]; 
                        let shadowSum = 0;
                        let maxTint = 0;
                        const s1 = segData[i];

                        for (let j_idx = i_idx + 1; j_idx < n; j_idx++) {
                            const j = order[j_idx];
                            if (visibilityMask) {
                                const segInfoJ = segments[j];
                                if (!visibilityMask.has(segInfoJ.idx1) || !visibilityMask.has(segInfoJ.idx2)) {
                                    continue; // This segment is hidden, it can't cast a shadow
                                }
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
                } else { // n > 1000
                    let GRID_DIM = Math.ceil(Math.sqrt(n / 10)); 
                    GRID_DIM = Math.max(10, Math.min(100, GRID_DIM)); 
                    
                    const gridSize = GRID_DIM * GRID_DIM;
                    const grid = Array.from({ length: gridSize }, () => []);
                    
                    const gridMin = -maxExtent - 1.0;
                    const gridRange = (maxExtent + 1.0) * 2;
                    const gridCellSize = gridRange / GRID_DIM;
                    
                    if (gridCellSize > 1e-6) {
                        const invCellSize = 1.0 / gridCellSize; 
                        
                        for (let i = 0; i < n; i++) {
                            const s = segData[i];
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
                        
                        for (let i_idx = n - 1; i_idx >= 0; i_idx--) {
                            const i = order[i_idx]; 
                            let shadowSum = 0;
                            let maxTint = 0;
                            const s1 = segData[i];
                            const segInfoI = segments[i]; // Get segment info for visibility check
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
                                        // Visibility check is implicitly handled
                                        // because only visible segments are pushed to the grid
                                        const s2 = segData[j];
                                        
                                        // Call helper function
                                        const { shadow, tint } = this._calculateShadowTint(s1, s2);
                                        shadowSum += shadow;
                                        maxTint = Math.max(maxTint, tint);
                                    }
                                }
                            }
                            
                            shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                            tints[i] = 1 - maxTint;

                            const gridIndex = gx1 + gy1 * GRID_DIM;
                            // Only add segment to grid if it's visible
                            if (!visibilityMask || (visibilityMask.has(segInfoI.idx1) && visibilityMask.has(segInfoI.idx2))) {
                                grid[gridIndex].push(i);
                            }
                        }
                    } else {
                         shadows.fill(1.0);
                         tints.fill(1.0);
                    }
                }
            }
             else {
                shadows.fill(1.0);
                tints.fill(1.0);
            }
            
            // dataRange is just the molecule's extent in Angstroms
            // Use temporary extent if set (for orienting to visible atoms), otherwise use object's maxExtent
            const effectiveExtent = this.temporaryExtent || maxExtent;
            const dataRange = (effectiveExtent * 2) || 1.0; // fallback to 1.0 to avoid div by zero
            const canvasSize = Math.min(this.canvas.width, this.canvas.height);
            
            // scale is pixels per Angstrom
            const scale = (canvasSize / dataRange) * this.zoom; 
            
            // baseLineWidth is this.lineWidth (in Angstroms) converted to pixels
            const baseLineWidthPixels = this.lineWidth * scale;

            const centerX = this.canvas.width / 2;
            const centerY = this.canvas.height / 2;

            // ====================================================================
            // OPTIMIZED DRAWING LOOP - Reduced property changes and string ops
            // ====================================================================
            // Track last canvas properties to avoid redundant changes
            let lastStrokeStyle = null;
            let lastLineWidth = null;
            let lastLineCap = null;
            
            const setCanvasProps = (strokeStyle, lineWidth, lineCap) => {
                if (strokeStyle !== lastStrokeStyle) {
                    this.ctx.strokeStyle = strokeStyle;
                    lastStrokeStyle = strokeStyle;
                }
                if (lineWidth !== lastLineWidth) {
                    this.ctx.lineWidth = lineWidth;
                    lastLineWidth = lineWidth;
                }
                if (lineCap !== lastLineCap) {
                    this.ctx.lineCap = lineCap;
                    lastLineCap = lineCap;
                }
            };
            
            for (const idx of order) {
                // --- 1. COMMON CALCULATIONS (Do these ONCE) ---
                const segInfo = segments[idx];

                // Visibility Check
                if (visibilityMask && (!visibilityMask.has(segInfo.idx1) || !visibilityMask.has(segInfo.idx2))) {
                    continue;
                }

                // Color Calculation
                let { r, g, b } = colors[idx];
                r /= 255; g /= 255; b /= 255;

                if (renderShadows) {
                    const tintFactor = (0.50 * zNorm[idx] + 0.50 * tints[idx]) / 3;
                    r = r + (1 - r) * tintFactor;
                    g = g + (1 - g) * tintFactor;
                    b = b + (1 - b) * tintFactor;
                    const shadowFactor = 0.20 + 0.25 * zNorm[idx] + 0.55 * shadows[idx];
                    r *= shadowFactor; g *= shadowFactor; b *= shadowFactor;
                } else {
                    const depthFactor = 0.70 + 0.30 * zNorm[idx];
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

                // Width Calculation
                const type = segInfo.type;
                let widthMultiplier = 1.0;
                if (type === 'L') {
                    widthMultiplier = 0.4;
                } else if (type === 'D' || type === 'R') {
                    widthMultiplier = 1.6;
                }
                let currentLineWidth = baseLineWidthPixels * widthMultiplier;

                if (this.perspectiveEnabled) {
                    const avgPerspectiveScale = (perspectiveScale1 + perspectiveScale2) / 2;
                    currentLineWidth *= avgPerspectiveScale;
                }
                
                currentLineWidth = Math.max(0.5, currentLineWidth);

                // --- 2. CONDITIONAL DRAWING ---
                if (this.outlineEnabled) {
                    // --- 2-STEP DRAW (Outline) - Fixes gaps ---
                    const r_int = r * 255 | 0;
                    const g_int = g * 255 | 0;
                    const b_int = b * 255 | 0;
                    const color = `rgb(${r_int},${g_int},${b_int})`;
                    const gapFillerColor = `rgb(${r_int * 0.7 | 0},${g_int * 0.7 | 0},${b_int * 0.7 | 0})`;
                    const totalOutlineWidth = currentLineWidth + 4.0;

                    // Pass 1: Gap filler outline (butt caps)
                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    setCanvasProps(gapFillerColor, totalOutlineWidth, 'butt');
                    this.ctx.stroke();

                    // Pass 2: Main colored line (round caps)
                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    setCanvasProps(color, currentLineWidth, 'round');
                    this.ctx.stroke();

                } else {
                    // --- 1-STEP DRAW (No Outline) ---
                    const color = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;

                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    setCanvasProps(color, currentLineWidth, 'round');
                    this.ctx.stroke();
                }
            }
            // ====================================================================
            // END OF REFACTORED LOOP
            // ====================================================================

            // ====================================================================
            // HIGHLIGHTING PASS - Draw yellow circles at atom positions
            // ====================================================================
            if (this.highlightedResidue) {
                // Find all atoms that belong to the highlighted residue
                const highlightedAtoms = new Set();
                for (let i = 0; i < this.coords.length; i++) {
                    if (this.chains && this.residue_index && 
                        i < this.chains.length && i < this.residue_index.length) {
                        if (this.chains[i] === this.highlightedResidue.chain &&
                            this.residue_index[i] === this.highlightedResidue.residueIndex) {
                            highlightedAtoms.add(i);
                        }
                    }
                }
                
                // Draw yellow circles at highlighted atom positions
                this.ctx.fillStyle = 'rgba(255, 255, 0, 0.8)'; // Bright yellow for highlight
                this.ctx.strokeStyle = 'rgba(255, 255, 0, 1.0)'; // Yellow border
                this.ctx.lineWidth = 1;
                
                for (const atomIdx of highlightedAtoms) {
                    if (visibilityMask && !visibilityMask.has(atomIdx)) {
                        continue;
                    }
                    
                    const atom = rotated[atomIdx];
                    let x, y;
                    let perspectiveScale = 1.0;
                    
                    if (this.perspectiveEnabled) {
                        const z = this.focalLength - atom.z;
                        if (z < 0.01) continue;
                        perspectiveScale = this.focalLength / z;
                        x = centerX + (atom.x * scale * perspectiveScale);
                        y = centerY - (atom.y * scale * perspectiveScale);
                    } else {
                        x = centerX + atom.x * scale;
                        y = centerY - atom.y * scale;
                    }
                    
                    // Calculate circle radius to match original line width
                    // Original line width was: baseLineWidthPixels * widthMultiplier * 1.5
                    // For circles, use radius = lineWidth / 2 to match visual thickness
                    // Use default widthMultiplier of 1.0 (can be adjusted if needed)
                    const widthMultiplier = 1.0;
                    let circleRadius = (baseLineWidthPixels * widthMultiplier * 1.5) / 2;
                    if (this.perspectiveEnabled) {
                        circleRadius *= perspectiveScale;
                    }
                    circleRadius = Math.max(2, circleRadius); // Minimum radius for visibility
                    
                    // Draw circle at atom position
                    this.ctx.beginPath();
                    this.ctx.arc(x, y, circleRadius, 0, Math.PI * 2);
                    this.ctx.fill();
                    this.ctx.stroke();
                }
            }
        }

        // Main animation loop
        animate() {
            const now = performance.now();
            let needsRender = false;

            // 1. Handle inertia/spin
            if (!this.isDragging) {
                if (Math.abs(this.spinVelocityX) > 0.0001) {
                    const rot = rotationMatrixY(this.spinVelocityX * 0.005);
                    this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                    this.spinVelocityX *= 0.95; // Damping
                    needsRender = true;
                } else {
                    this.spinVelocityX = 0;
                }

                if (Math.abs(this.spinVelocityY) > 0.0001) {
                    const rot = rotationMatrixX(this.spinVelocityY * 0.005);
                    this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                    this.spinVelocityY *= 0.95; // Damping
                    needsRender = true;
                } else {
                    this.spinVelocityY = 0;
                }
            }

            // 2. Handle auto-rotate
            if (this.autoRotate && !this.isDragging && this.spinVelocityX === 0 && this.spinVelocityY === 0) {
                const rot = rotationMatrixY(0.005); // Constant rotation speed
                this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix);
                needsRender = true;
            }

            // 3. Handle frame playback
            if (this.isPlaying) {
                // Check for null
                if (this.currentObjectName) {
                    const object = this.objectsData[this.currentObjectName];
                    if (object && object.frames.length > 0) {
                        // Check if enough time has passed since last frame advance
                        const timeSinceLastFrame = now - this.lastFrameAdvanceTime;
                        if (timeSinceLastFrame > this.animationSpeed) {
                            let nextFrame = this.currentFrame + 1;
                            
                            // If recording, stop at the last frame
                            if (this.isRecording) {
                                if (nextFrame > this.recordingEndFrame) {
                                    // Finished recording - stop
                                    this.stopRecording();
                                    needsRender = false;
                                    // Don't return here - let the animation loop continue
                                    // so it can keep running for future play/record operations
                                } else {
                                    this.setFrame(nextFrame); // This calls render()
                                    this.lastFrameAdvanceTime = now;
                                    needsRender = false; // setFrame() already called render()
                                }
                            } else {
                                // Normal playback - loop
                                if (nextFrame >= object.frames.length) {
                                    nextFrame = 0;
                                }
                                this.setFrame(nextFrame); // This calls render()
                                this.lastFrameAdvanceTime = now;
                                needsRender = false; // setFrame() already called render()
                            }
                        }
                    } else {
                        this.stopAnimation();
                    }
                }
            }

            // 4. Final render if needed
            if (needsRender) {
                this.render();
            }

            // 5. Loop
            requestAnimationFrame(() => this.animate());
        }
    }
    
    // ============================================================================
    // PAE RENDERER
    // ============================================================================
    class PAERenderer {
        constructor(canvas, mainRenderer) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.mainRenderer = mainRenderer; // Reference to Pseudo3DRenderer
            
            this.paeData = null;
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

        getMousePos(e) {
            const rect = this.canvas.getBoundingClientRect();
            // Support both mouse and touch events
            const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : e.changedTouches[0].clientX);
            const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY);
            
            // Account for any CSS scaling: scale mouse coordinates to match canvas resolution
            const scaleX = this.canvas.width / rect.width;
            const scaleY = this.canvas.height / rect.height;
            
            return { 
                x: (clientX - rect.left) * scaleX, 
                y: (clientY - rect.top) * scaleY 
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
                    this.mainRenderer.setSelection({ 
                        paeBoxes: [],
                        residues: new Set(),
                        chains: new Set(),
                        selectionMode: 'explicit'
                    });
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
            });
            
            window.addEventListener('mousemove', (e) => {
                if (!this.isDragging) return;
                if (!this.paeData) return; // No data to select
                
                // Get cell indices - handle case where mouse might be outside canvas
                let cellIndices;
                try {
                    cellIndices = this.getCellIndices(e);
                } catch (err) {
                    return; // Mouse outside canvas, ignore
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
                    this.scheduleRender(); // Throttled render
                }
            });
            
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
                    this.mainRenderer.setSelection({ 
                        paeBoxes: [],
                        residues: new Set(),
                        chains: new Set(),
                        selectionMode: 'default'
                    });
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
                    const existingResidues = currentSelection.residues || new Set();
                    
                    // Convert PAE box to residue IDs
                    const newResidues = new Set();
                    const renderer = this.mainRenderer;
                    
                    // Get residue positions from PAE box (i and j ranges)
                    for (let r = i_start; r <= i_end; r++) {
                        const atomIdx = renderer.polymerAtomIndices[r];
                        if (atomIdx >= 0 && atomIdx < renderer.chains.length) {
                            const chain = renderer.chains[atomIdx];
                            const residueIndex = renderer.residue_index[atomIdx];
                            newResidues.add(`${chain}:${residueIndex}`);
                        }
                    }
                    for (let r = j_start; r <= j_end; r++) {
                        const atomIdx = renderer.polymerAtomIndices[r];
                        if (atomIdx >= 0 && atomIdx < renderer.chains.length) {
                            const chain = renderer.chains[atomIdx];
                            const residueIndex = renderer.residue_index[atomIdx];
                            newResidues.add(`${chain}:${residueIndex}`);
                        }
                    }
                    
                    // If Shift is held, add to existing selection; otherwise replace
                    if (this.isAdding) {
                        // Additive: combine with existing boxes and residues
                        const combinedBoxes = [...existingBoxes, newBox];
                        const combinedResidues = new Set([...existingResidues, ...newResidues]);
                        
                        this.mainRenderer.setSelection({
                            paeBoxes: combinedBoxes,
                            residues: combinedResidues,
                            chains: new Set(), // Clear chain selection when PAE sets residues
                            selectionMode: 'explicit'
                        });
                    } else {
                        // Replace: use only the new box and residues
                        this.mainRenderer.setSelection({
                            paeBoxes: [newBox],
                            residues: newResidues,
                            chains: new Set(), // Clear chain selection when PAE sets residues
                            selectionMode: 'explicit'
                        });
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
            
            window.addEventListener('mouseup', handleEnd);
            
            // Touch event handlers for mobile devices
            this.canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length !== 1) return; // Only single touch
                if (!this.paeData) return; // No data to select
                e.preventDefault(); // Prevent scrolling
                
                // Check if Shift is held for additive selection (not available on touch)
                this.isAdding = false;
                
                // Clear sequence selection when starting a new PAE selection
                this.mainRenderer.setSelection({ 
                    paeBoxes: [],
                    residues: new Set(),
                    chains: new Set(),
                    selectionMode: 'explicit'
                });
                
                this.isDragging = true;
                const { i, j } = this.getCellIndices(e);
                this.selection.x1 = j;
                this.selection.y1 = i;
                this.selection.x2 = j;
                this.selection.y2 = i;
                // Invalidate cache when starting new selection
                this.lastSelectionHash = null;
                this.scheduleRender(); // Throttled render
            });
            
            window.addEventListener('touchmove', (e) => {
                if (!this.isDragging) return;
                if (!this.paeData) return; // No data to select
                if (e.touches.length !== 1) return;
                e.preventDefault(); // Prevent scrolling
                
                // Get cell indices - handle case where touch might be outside canvas
                let cellIndices;
                try {
                    cellIndices = this.getCellIndices(e);
                } catch (err) {
                    return; // Touch outside canvas, ignore
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
                    this.scheduleRender(); // Throttled render
                }
            });
            
            window.addEventListener('touchend', handleEnd);
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
        // Returns a Set of PAE matrix indices (0-based) that correspond to selected residues/chains
        // Only returns positions for explicit selections (not default "all" state)
        getSequenceSelectedPAEPositions() {
            const selectedPositions = new Set();
            const renderer = this.mainRenderer;
            
            if (!renderer.polymerAtomIndices || renderer.polymerAtomIndices.length === 0) {
                return selectedPositions;
            }
            
            const selectionModel = renderer.selectionModel;
            const hasResidueSelection = selectionModel.residues && selectionModel.residues.size > 0;
            const hasChainSelection = selectionModel.chains && selectionModel.chains.size > 0;
            const mode = selectionModel.selectionMode || 'default';
            
            // Only return positions for explicit selections
            // In default mode with no explicit selection, return empty (show all at full brightness)
            if (mode === 'default') {
                // In default mode, only highlight if there's an explicit residue selection
                // (not just "all chains" which is the default)
                if (!hasResidueSelection) {
                    return selectedPositions; // No explicit selection = show all
                }
            }
            
            // If no sequence selection, return empty set
            if (!hasResidueSelection && !hasChainSelection) {
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
            // polymerAtomIndices[r] gives the atom index for PAE position r
            for (let r = 0; r < renderer.polymerAtomIndices.length; r++) {
                const atomIdx = renderer.polymerAtomIndices[r];
                if (atomIdx < 0 || atomIdx >= renderer.chains.length) continue;
                
                const chain = renderer.chains[atomIdx];
                const residueIndex = renderer.residue_index[atomIdx];
                const residueId = `${chain}:${residueIndex}`;
                
                // Check if this PAE position is selected
                const chainMatches = allowedChains.has(chain);
                const residueMatches = !hasResidueSelection || selectionModel.residues.has(residueId);
                
                if (chainMatches && residueMatches) {
                    selectedPositions.add(r);
                }
            }
            
            return selectedPositions;
        }

        // Helper function to check if a cell (i, j) is in any selected box
        // Note: Visual symmetry is handled in rendering, but selection boxes are NOT symmetric internally
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
            // This shows only the specific interactions between selected residues
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
            if (!renderer.polymerAtomIndices || renderer.polymerAtomIndices.length === 0) return;
            if (!renderer.chains || renderer.chains.length === 0) return;
            
            const boundaries = new Set(); // Set of PAE positions where chain changes
            
            // Find chain boundaries in polymerAtomIndices
            // polymerAtomIndices maps PAE position -> atom index
            for (let r = 0; r < renderer.polymerAtomIndices.length - 1; r++) {
                const atomIdx1 = renderer.polymerAtomIndices[r];
                const atomIdx2 = renderer.polymerAtomIndices[r + 1];
                
                // Check if both atom indices are valid
                if (atomIdx1 >= 0 && atomIdx1 < renderer.chains.length &&
                    atomIdx2 >= 0 && atomIdx2 < renderer.chains.length) {
                    const chain1 = renderer.chains[atomIdx1];
                    const chain2 = renderer.chains[atomIdx2];
                    
                    if (chain1 !== chain2) {
                        // Chain boundary at position r+1 (draw line before this position)
                        boundaries.add(r + 1);
                    }
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

    <!-- ============================================================================
    <!-- MAIN APP & COLAB COMMUNICATION
    <!-- ============================================================================

    <!-- 1. Get config from Python
    <!-- This relies on window.viewerConfig being available globally
    const config = window.viewerConfig || { 
        size: [300, 300], 
        pae_size: [300, 300],
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

    // 2. Setup Canvas
    const canvas = containerElement.querySelector('#canvas');
    if (!canvas) {
        console.error("py2dmol: Could not find #canvas element in container.");
        return;
    }
    canvas.width = config.size[0];
    canvas.height = config.size[1];
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

                // 1. Update canvas resolution. This is the critical step
                // to prevent stretching/blurring.
                if (canvas.width !== newWidth || canvas.height !== newHeight) {
                    canvas.width = newWidth;
                    canvas.height = newHeight;

                    // 2. Re-render the scene
                    renderer.render();
                }
            }
        });

        // Start observing the canvas container
        resizeObserver.observe(canvasContainer);
    } else if (!window.ResizeObserver) {
        console.warn("py2dmol: ResizeObserver not supported. Canvas resizing will not work.");
    }
    
    // 4. Setup PAE Renderer (if enabled)
    if (config.pae) {
        try {
            const paeCanvas = containerElement.querySelector('#paeCanvas');
            // Set canvas size from config
            paeCanvas.width = config.pae_size[0];
            paeCanvas.height = config.pae_size[1];
            paeCanvas.style.display = 'block';
            
            const paeRenderer = new PAERenderer(paeCanvas, renderer); 
            renderer.setPAERenderer(paeRenderer);
        } catch (e) {
            console.error("Failed to initialize PAE renderer:", e);
        }
    }
    
    // 5. Setup general controls
    const colorSelect = containerElement.querySelector('#colorSelect');
    
    colorSelect.value = config.color; // Set dropdown value from config
    
    colorSelect.addEventListener('change', (e) => {
        renderer.colorMode = e.target.value;
        renderer.colors = renderer._calculateSegmentColors();
        renderer.render();
        // Dispatch a custom event to notify external listeners (like the sequence viewer)
        document.dispatchEvent(new CustomEvent('py2dmol-color-change'));
    });
    
    // Setup shadowEnabledCheckbox
    const shadowEnabledCheckbox = containerElement.querySelector('#shadowEnabledCheckbox'); 
    shadowEnabledCheckbox.checked = renderer.shadowEnabled; // Set default from renderer
    
    // Setup outlineEnabledCheckbox
    const outlineEnabledCheckbox = containerElement.querySelector('#outlineEnabledCheckbox'); 
    outlineEnabledCheckbox.checked = renderer.outlineEnabled; // Set default from renderer
    
    // Setup colorblindCheckbox
    const colorblindCheckbox = containerElement.querySelector('#colorblindCheckbox');
    colorblindCheckbox.checked = renderer.colorblindMode; // Set default from renderer
    
    // 6. Setup animation and object controls
    const controlsContainer = containerElement.querySelector('#controlsContainer');
    const playButton = containerElement.querySelector('#playButton');
    const recordButton = containerElement.querySelector('#recordButton');
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
        controlsContainer, playButton, recordButton,
        frameSlider, frameCounter, objectSelect,
        speedSelect, rotationCheckbox, lineWidthSlider,
        shadowEnabledCheckbox, outlineEnabledCheckbox,
        colorblindCheckbox, orthoSlider
    );
    
    // Setup save state button (for Python interface only - web interface handles it in app.js)
    // Only add listener if we're in Python interface (no window.saveViewerState exists yet)
    const saveStateButton = containerElement.querySelector('#saveStateButton');
    if (saveStateButton && typeof window.saveViewerState !== 'function') {
        saveStateButton.addEventListener('click', () => {
            // For Python interface, we'll need to expose this through the API
            // For now, just log a message
            console.log("Save state functionality is available in the web interface. For Python interface, use view.save_state(filepath) method.");
            alert("Save state: Use the Python method view.save_state(filepath) to save the current state.");
        });
    }
    
    // Set ortho slider from config
    if (config.ortho !== undefined && orthoSlider) {
        orthoSlider.value = normalizeOrthoValue(config.ortho);
        // Note: The slider's input event will be triggered after data loads
        // to set the correct focalLength based on maxExtent
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
    
    // 10. Add function for Python to set color mode (e.g., for from_afdb)
    const handlePythonSetColor = (colorMode) => {
        if (colorSelect) {
            colorSelect.value = colorMode;
            // Manually trigger the change event
            colorSelect.dispatchEvent(new Event('change'));
        }
    };


    <!-- 11. Load initial data
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
            <!-- Set view to the first frame of the first object
            if (window.staticObjectData.length > 0) {
                renderer.currentObjectName = window.staticObjectData[0].name;
                renderer.objectSelect.value = window.staticObjectData[0].name;
                renderer.setFrame(0);
            }
        } catch (error) {
            console.error("Error loading static object data:", error);
            renderer.setFrame(-1); <!-- Start empty on error
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


    <!-- 12. Start the main animation loop
    renderer.animate();
    
    <!-- 13. Expose Public API
    const viewer_id = config.viewer_id;
    if (viewer_id) {
        window.py2dmol_viewers[viewer_id] = {
            handlePythonUpdate,
            handlePythonNewObject,
            handlePythonClearAll,
            handlePythonSetColor,
            renderer // Expose the renderer instance for external access
        };
    } else {
        console.error("py2dmol: viewer_id not found in config. Cannot register API.");
    }

} // <-- End of initializePy2DmolViewer