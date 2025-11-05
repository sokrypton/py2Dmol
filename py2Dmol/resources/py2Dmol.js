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
            this.perspectiveEnabled = false; // false = orthographic, true = perspective
            
            // Set default focalLength, but it will be overridden by the
            // slider logic if perspective is enabled.
            this.focalLength = (typeof config.ortho === 'number') ? config.ortho : 200.0;
            // Check config if ortho slider should start in perspective mode
            if (typeof config.ortho === 'number' && config.ortho < 195) {
                this.perspectiveEnabled = true;
                // Note: We can't set the *correct* focalLength here,
                // because we don't know maxExtent yet. The slider's
                // first input event will fix this.
            }
            
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

            // UI elements
            this.playButton = null;
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

            this.setupInteraction();
        }

        setClearColor(isTransparent) {
            this.isTransparent = isTransparent;
            this.render(); // Re-render with new clear color
        }
        
        // --- PAE / Visibility ---
        setPAERenderer(paeRenderer) {
            this.paeRenderer = paeRenderer;
        }
        
        setResidueVisibility(selection) {
            if (selection === null) {
                this.visibilityMask = null;
            } else {
                const { i_start, i_end, j_start, j_end } = selection;
                this.visibilityMask = new Set();
                
                // Add all ligands
                for (let i = 0; i < this.atomTypes.length; i++) {
                    if (this.atomTypes[i] === 'L') {
                        this.visibilityMask.add(i);
                    }
                }
                
                // Add selected residues (mapping from residue index to atom index)
                for (let res_idx = i_start; res_idx <= i_end; res_idx++) {
                    if (res_idx < this.polymerAtomIndices.length) {
                        this.visibilityMask.add(this.polymerAtomIndices[res_idx]);
                    }
                }
                for (let res_idx = j_start; res_idx <= j_end; res_idx++) {
                    if (res_idx < this.polymerAtomIndices.length) {
                        this.visibilityMask.add(this.polymerAtomIndices[res_idx]);
                    }
                }
            }
            this.render(); // Trigger re-render of 3D view
        }

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
        setUIControls(controlsContainer, playButton, frameSlider, frameCounter, objectSelect, speedSelect, rotationCheckbox, lineWidthSlider, shadowEnabledCheckbox, outlineEnabledCheckbox, colorblindCheckbox, orthoSlider) {
            this.controlsContainer = controlsContainer;
            this.playButton = playButton;
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

            this.objectSelect.addEventListener('change', () => {
                this.stopAnimation();
                this.currentObjectName = this.objectSelect.value;
                this.setFrame(0);
            });

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

            // *** UPDATED ORTHO SLIDER LOGIC ***
            if (this.orthoSlider) {
                this.orthoSlider.addEventListener('input', (e) => {
                    const sliderVal = parseFloat(e.target.value); // This is 50 to 200

                    // 1. Get the current object's maxExtent (your "object size")
                    const object = this.currentObjectName ? this.objectsData[this.currentObjectName] : null;
                    const maxExtent = (object && object.maxExtent > 0) ? object.maxExtent : 30.0;

                    // 2. Check if we are in "ortho" mode (the toggle part is good)
                    if (sliderVal >= 195) {
                        this.perspectiveEnabled = false;
                        // We can also reset focalLength to a default, though it's not used
                        this.focalLength = maxExtent * 20.0; // Set to a "far away" value
                    } else {
                        this.perspectiveEnabled = true;

                        // 3. Re-map the slider (50-195) to a sensible multiplier.
                        //    We want 50 (strongest perspective) to be "close"
                        //    and 195 (weakest) to be "far away".
                        
                        // Normalize the perspective part of the slider (50-195) to a 0.0-1.0 range
                        const normalizedFactor = (sliderVal - 50) / (195 - 50); // 0.0 (strong) to 1.0 (weak)

                        // 4. Interpolate between a "close" and "far" multiplier for maxExtent.
                        //    minMult *must* be > 1.0 to prevent clipping.
                        //    The clipping happens if focalLength < start.z.
                        //    The max start.z is maxExtent. So focalLength *must* be > maxExtent.
                        const minMult = 1.5; // Closest camera: focalLength = 1.5 * maxExtent
                        const maxMult = 20.0; // Farthest camera: focalLength = 20.0 * maxExtent
                        
                        const multiplier = minMult + (maxMult - minMult) * normalizedFactor;

                        // 5. Set focalLength relative to object size
                        this.focalLength = maxExtent * multiplier;
                    }
                    
                    if (!this.isPlaying) {
                        this.render();
                    }
                });
            }
            // *** END UPDATED LOGIC ***

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
            this.objectsData[name] = { maxExtent: 0, frames: [], globalCenterSum: new Vec3(0,0,0), totalAtoms: 0 };
            this.currentObjectName = name;
            this.currentFrame = -1;

            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            this.objectSelect.appendChild(option);
            this.objectSelect.value = name;

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
                this.objectSelect.value = targetObjectName;
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

            // Recalculate maxExtent for all frames using the new global center
            let maxDistSq = 0;
            for (const frame of object.frames) {
                if (frame && frame.coords) {
                    for (let i = 0; i < frame.coords.length; i++) {
                        const c = frame.coords[i];
                        const coordVec = new Vec3(c[0], c[1], c[2]);
                        const centeredCoord = coordVec.sub(globalCenter);
                        const distSq = centeredCoord.dot(centeredCoord);
                        if (distSq > maxDistSq) maxDistSq = distSq;
                    }
                }
            }
            object.maxExtent = Math.sqrt(maxDistSq);

            if (!this.isPlaying) {
                this.setFrame(object.frames.length - 1);
            }
            this.updateUIControls();
            
            // If this is the first frame being loaded, we need to
            // potentially update the focalLength if we're in perspective mode.
            if (object.frames.length === 1 && this.perspectiveEnabled && this.orthoSlider) {
                 // Trigger a "change" on the orthoSlider to recalculate
                 // focalLength with the new maxExtent.
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
             this.objectSelect.disabled = !enabled;
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
                const totalObjects = this.objectSelect.options.length;
                // Find the objectContainer relative to the main container
                const objectContainer = containerElement.querySelector('#objectContainer');
                if (objectContainer) {
                    // Show if more than 1 object AND controls are not hidden
                    objectContainer.style.display = (totalObjects > 1 && config.controls) ? 'flex' : 'none';
                }
            }

            this.frameSlider.max = Math.max(0, total - 1);
            
            // Don't update slider value while user is dragging it
            if (!this.isSliderDragging) {
                this.frameSlider.value = this.currentFrame;
            }
            
            this.frameCounter.textContent = `Frame: ${total > 0 ? current : 0} / ${total}`;
            this.playButton.textContent = this.isPlaying ? 'Pause' : 'Play';
        }

        // Toggle play/pause
        togglePlay() {
            if (this.isPlaying) {
                this.stopAnimation();
            } else {
                this.startAnimation();
            }
        }

        // Start playback
        startAnimation() {
            // Check for null
            if (!this.currentObjectName) return;
            const object = this.objectsData[this.currentObjectName];
            if (!object || object.frames.length < 2) return;

            this.isPlaying = true;
            this.lastFrameAdvanceTime = performance.now(); // Set start time
            this.updateUIControls();
        }

        // Stop playback
        stopAnimation() {
            this.isPlaying = false;
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
                    const plddts = data.plddts || [];
                    const chains = data.chains || [];
                    const atomTypes = data.atom_types || [];
                    const hasPAE = data.pae && data.pae.length > 0;
                    this.setCoords(coords, plddts, chains, atomTypes, hasPAE);
                }
            } catch (e) {
                console.error("Failed to load data into renderer:", e);
            }
        }

        setCoords(coords, plddts = [], chains = [], atomTypes = [], hasPAE = false) {
            this.coords = coords;
            this.plddts = plddts;
            this.chains = chains;
            this.atomTypes = atomTypes;
            
            // "auto" logic:
            // Always calculate what 'auto' *should* be
            // Priority: plddt (if PAE present) > chain (if multi-chain) > rainbow
            if (hasPAE) {
                this.resolvedAutoColor = 'plddt';
            } else if (this.chains && this.chains.length > 0) {
                const uniqueChains = new Set(this.chains.filter(c => c && c.trim()));
                this.resolvedAutoColor = (uniqueChains.size > 1) ? 'chain' : 'rainbow';
            } else {
                this.resolvedAutoColor = 'rainbow';
            }
            
            const n = this.coords.length;

            // Handle defaults
            if (this.plddts.length !== n) { this.plddts = Array(n).fill(50.0); }
            if (this.chains.length !== n) { this.chains = Array(n).fill('A'); }
            if (this.atomTypes.length !== n) { this.atomTypes = Array(n).fill('P'); }
            
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
        }
        
        // Calculate segment colors (chain or rainbow)
        _calculateSegmentColors() {
            const n = this.coords.length;
            const m = this.segmentIndices.length;
            
            let effectiveColorMode = this.colorMode;
            if (effectiveColorMode === 'auto') {
                effectiveColorMode = this.resolvedAutoColor || 'rainbow';
            }
            
            const chainIndexMap = new Map();
            if (effectiveColorMode === 'chain' && this.chains.length > 0) {
                for (const chainId of this.chains) {
                    if (chainId && !chainIndexMap.has(chainId)) {
                        chainIndexMap.set(chainId, chainIndexMap.size);
                    }
                }
            }
            
            const rainbowFunc = this.colorblindMode ? getRainbowColor_Colorblind : getRainbowColor;
            
            return this.segmentIndices.map(segInfo => {
                const grey = {r: 128, g: 128, b: 128};
                let color;
                const i = segInfo.origIndex;
                const type = segInfo.type;
                
                if (type === 'L') {
                    // Ligands are grey unless in plddt mode
                    color = grey;
                }
                // plddt mode is handled in render()
                else if (effectiveColorMode === 'chain') {
                    const chainId = this.chains[i] || 'A';
                    const chainIndex = chainIndexMap.get(chainId) || 0;
                    
                    const colorArray = this.colorblindMode ? colorblindSafeChainColors : pymolColors;
                    const hex = colorArray[chainIndex % colorArray.length];
                    color = hexToRgb(hex);
                }
                else { // rainbow
                    const scale = this.chainRainbowScales[segInfo.chainId];
                    if (scale) { 
                        // Use the selected rainbow function
                        color = rainbowFunc(segInfo.colorIndex, scale.min, scale.max); 
                    }
                    else { color = grey; }
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
            
            // Update pre-allocated rotatedCoords
            const m = this.rotationMatrix;
            const c = globalCenter;
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
            const dataRange = (maxExtent * 2) || 1.0; // fallback to 1.0 to avoid div by zero
            const canvasSize = Math.min(this.canvas.width, this.canvas.height);
            
            // scale is pixels per Angstrom
            const scale = (canvasSize / dataRange) * this.zoom; 
            
            // baseLineWidth is this.lineWidth (in Angstroms) converted to pixels
            const baseLineWidthPixels = this.lineWidth * scale;

            const centerX = this.canvas.width / 2;
            const centerY = this.canvas.height / 2;

            // ====================================================================
            // REFACTORED DRAWING LOOP
            // ====================================================================
            // This loop draws the main line, and if outlining is on,
            // it also draws the 'butt' capped gap-filler just before it.
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

                    if (z1 < 0.01 || z2 < 0.01) { // Clipping check
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
                
                // Ensure minimum line width to be visible
                currentLineWidth = Math.max(0.5, currentLineWidth);


                // --- 2. CONDITIONAL DRAWING ---

                if (this.outlineEnabled) {
                    // --- 3-STEP DRAW (Outline) - Fixes gaps ---
                    
                    // Calculate colors needed for outline mode
                    const r_int = r * 255 | 0;
                    const g_int = g * 255 | 0;
                    const b_int = b * 255 | 0;
                    const color = `rgb(${r_int},${g_int},${b_int})`;
                    const darkenFactor = 0.7;
                    const gapFillerColor = `rgb(${r_int * darkenFactor | 0}, ${g_int * darkenFactor | 0}, ${b_int * darkenFactor | 0})`;
                    
                    // Outline width is 2px on each side
                    const totalOutlineWidth = currentLineWidth + (2.0 * 2); 

                    // Pass 1: The "gap filler" outline
                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    this.ctx.strokeStyle = gapFillerColor;
                    this.ctx.lineWidth = totalOutlineWidth;
                    this.ctx.lineCap = 'butt'; // 'butt' cap fills gaps between segments
                    this.ctx.stroke();

                    // Pass 2: The main colored line
                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    this.ctx.strokeStyle = color;
                    this.ctx.lineWidth = currentLineWidth;
                    this.ctx.lineCap = 'round';
                    this.ctx.stroke();

                } else {
                    // --- 1-STEP DRAW (No Outline) ---
                    
                    // Calculate color needed for non-outline mode
                    const color = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;

                    // Single Pass: The main colored line
                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    this.ctx.strokeStyle = color;
                    this.ctx.lineWidth = currentLineWidth;
                    this.ctx.lineCap = 'round';
                    this.ctx.stroke();
                }
            }
            // ====================================================================
            // END OF REFACTORED LOOP
            // ====================================================================
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
                if (now - this.lastFrameAdvanceTime > this.animationSpeed && this.currentObjectName) {
                    const object = this.objectsData[this.currentObjectName];
                    if (object && object.frames.length > 0) {
                        let nextFrame = this.currentFrame + 1;
                        if (nextFrame >= object.frames.length) {
                            nextFrame = 0;
                        }
                        this.setFrame(nextFrame); // This calls render()
                        this.lastFrameAdvanceTime = now;
                        needsRender = false; // setFrame() already called render()
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
            
            this.setupInteraction();
        }

        getMousePos(e) {
            const rect = this.canvas.getBoundingClientRect();
            return { 
                x: e.clientX - rect.left, 
                y: e.clientY - rect.top 
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
                
                this.isDragging = true;
                const { i, j } = this.getCellIndices(e);
                this.selection.x1 = j;
                this.selection.y1 = i;
                this.selection.x2 = j;
                this.selection.y2 = i;
                this.render(); // Re-render to show start of selection
            });
            
            window.addEventListener('mousemove', (e) => {
                if (!this.isDragging) return;
                
                const { i, j } = this.getCellIndices(e);

                // Clamp selection to canvas bounds
                const n = this.paeData.length;
                this.selection.x2 = Math.max(0, Math.min(n - 1, j));
                this.selection.y2 = Math.max(0, Math.min(n - 1, i));
                
                this.render(); // Re-render to show selection box
            });
            
            window.addEventListener('mouseup', (e) => {
                if (!this.isDragging) return;
                this.isDragging = false;
                
                const i_start = Math.min(this.selection.y1, this.selection.y2);
                const i_end = Math.max(this.selection.y1, this.selection.y2);
                const j_start = Math.min(this.selection.x1, this.selection.x2);
                const j_end = Math.max(this.selection.x1, this.selection.x2);
                
                if (i_start < 0 || j_start < 0) { // Dragged off canvas
                     this.mainRenderer.setResidueVisibility(null);
                     this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                     this.render();
                     return;
                }

                // Check for a single-click
                const isClick = (i_start === i_end && j_start === j_end);
                
                if (isClick && this.mainRenderer.visibilityMask) {
                    // Clicked, and something is already selected -> Clear selection
                    this.mainRenderer.setResidueVisibility(null);
                    this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
                } else {
                    // New selection (drag or first click)
                    this.mainRenderer.setResidueVisibility({ i_start, i_end, j_start, j_end });
                }
                
                this.render(); // Re-render PAE (with or without selection box)
            });
        }

        setData(paeData) {
            this.paeData = paeData;
            // Clear selection when data changes
            this.selection = { x1: -1, y1: -1, x2: -1, y2: -1 };
            if (this.mainRenderer.visibilityMask) {
                 this.mainRenderer.setResidueVisibility(null);
            }
            this.render();
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
            
            // Use createImageData for faster rendering
            const imageData = this.ctx.createImageData(this.size, this.size);
            const data = imageData.data;
            
            for (let i = 0; i < n; i++) { // y
                for (let j = 0; j < n; j++) { // x
                    const value = this.paeData[i][j];
                    const paeFunc = this.mainRenderer.colorblindMode ? getPAEColor_Colorblind : getPAEColor;
                    const { r, g, b } = paeFunc(value);
                    
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
            
            // Draw selection box if one is active or being drawn
            if ((this.mainRenderer.visibilityMask || this.isDragging) && this.selection.x1 !== -1) {
                 const i_start = Math.min(this.selection.y1, this.selection.y2);
                 const i_end = Math.max(this.selection.y1, this.selection.y2);
                 const j_start = Math.min(this.selection.x1, this.selection.x2);
                 const j_end = Math.max(this.selection.x1, this.selection.x2);
                 
                 if (i_start < 0 || j_start < 0) return; // Invalid selection

                 const x = j_start * cellSize;
                 const y = i_start * cellSize;
                 const w = (j_end - j_start + 1) * cellSize;
                 const h = (i_end - i_start + 1) * cellSize;
                 
                 this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
                 this.ctx.lineWidth = 4;
                 this.ctx.strokeRect(x, y, w, h);
                 
                 this.ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
                 this.ctx.lineWidth = 2;
                 this.ctx.strokeRect(x, y, w, h);
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
            const paeContainer = containerElement.querySelector('#paeContainer');
            paeContainer.style.display = 'block';
            const paeCanvas = containerElement.querySelector('#paeCanvas');
            // Set canvas size from config
            paeCanvas.width = config.pae_size[0];
            paeCanvas.height = config.pae_size[1];
            
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
    const frameSlider = containerElement.querySelector('#frameSlider');
    const frameCounter = containerElement.querySelector('#frameCounter');
    const objectSelect = containerElement.querySelector('#objectSelect');
    const speedSelect = containerElement.querySelector('#speedSelect');
    const rotationCheckbox = containerElement.querySelector('#rotationCheckbox');
    const lineWidthSlider = containerElement.querySelector('#lineWidthSlider');
    const orthoSlider = containerElement.querySelector('#orthoSlider');

    
    // Set defaults for width, rotate, and pastel
    lineWidthSlider.value = renderer.lineWidth;
    rotationCheckbox.checked = renderer.autoRotate;

    // Pass ALL controls to the renderer
    renderer.setUIControls(
        controlsContainer, playButton, 
        frameSlider, frameCounter, objectSelect,
        speedSelect, rotationCheckbox, lineWidthSlider,
        shadowEnabledCheckbox, outlineEnabledCheckbox,
        colorblindCheckbox, orthoSlider
    );
    
    // Set ortho slider from config
    if (config.ortho && orthoSlider) {
        orthoSlider.value = config.ortho;
        // Trigger the input event to set the initial
        // focalLength correctly based on maxExtent (if available).
        // We do this *after* loading data.
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
        
        // Also update PAE container if it exists
        if (config.pae) {
            const paeCont = containerElement.querySelector('#paeContainer');
            if(paeCont) {
                paeCont.style.border = 'none';
                paeCont.style.background = 'transparent';
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
        <!-- === STATIC MODE (from show()) ===
        try {
            <!-- Loop over all objects (NEW STRUCTURE)
            for (const obj of window.staticObjectData) {
                if (obj.name && obj.frames && obj.frames.length > 0) {
                    
                    // Get the static data from the *object* level
                    const staticChains = obj.chains;
                    const staticAtomTypes = obj.atom_types;
                    
                    // Loop through the "light" frames
                    for (let i = 0; i < obj.frames.length; i++) {
                        const lightFrame = obj.frames[i]; // This only has coords/plddts/pae
                        
                        // Re-construct the full frame data expected by addFrame
                        const fullFrameData = {
                            coords: lightFrame.coords,
                            plddts: lightFrame.plddts,
                            pae: lightFrame.pae, // PAE is per-frame
                            chains: staticChains,
                            atom_types: staticAtomTypes
                        };
                        
                        // Pass the re-hydrated frame to the renderer
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