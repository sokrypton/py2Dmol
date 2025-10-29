<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Protein Pseudo-3D Viewer</title>
    <style>
        * { box-sizing: border-box; }
        /* Remove all margins for a clean embed */
        body {
            margin: 0;
            padding: 0;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #fff;
            text-align: left; /* Aligns the container to the left */
        }
        #mainContainer {
            display: inline-block; /* Makes the container wrap content */
            text-align: left;
        }
        #canvasContainer {
            /* This is the stylized "box" */
            display: inline-block;
            position: relative;
            border: 1px solid #ddd;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }
        #canvas {
            background: #ffffff;
            cursor: grab;
            display: block;
        }
        #canvas:active {
            cursor: grabbing;
        }

        /* Style for the floating dropdown */
        #colorSelect {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 10;
            font-size: 12px;
            padding: 4px 8px;
            border: 1px solid #ccc;
            border-radius: 4px;
            background-color: rgba(255, 255, 255, 0.8);
            -webkit-appearance: none;
            -moz-appearance: none;
            appearance: none;
            cursor: pointer;
            background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%2Mxmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23444444%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.6-3.6%205.4-7.8%205.4-12.8%200-5-1.8-9.2-5.4-12.8z%22%2F%3E%3C%2Fsvg%3E');
            background-repeat: no-repeat;
            background-position: right 8px top 50%;
            background-size: 8px auto;
            padding-right: 28px;
        }
        #colorSelect:focus {
            outline: none;
            border-color: #007bff;
        }

        /* Style for shadow toggle */
        #shadowToggle {
            position: absolute;
            top: 10px;
            left: 10px;
            z-index: 10;
            font-size: 12px;
            color: #333;
            background-color: rgba(255, 255, 255, 0.8);
            padding: 4px 8px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        #shadowToggle label { cursor: pointer; }
        #shadowCheckbox { cursor: pointer; margin: 0; }

        /* Animation Controls Container */
        #controlsContainer {
            padding: 10px 10px 0 10px; /* Reduced bottom padding */
            text-align: left;
            width: 100%;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            font-size: 12px;
        }
        /* NEW: Trajectory Controls Container */
        #trajectoryContainer {
            padding: 5px 10px 10px 10px; /* Top padding 5px */
            width: 100%;
            font-size: 12px;
        }
        .controlButton { /* NEW: Shared button style */
            padding: 5px 10px;
            border-radius: 4px;
            border: 1px solid #ccc;
            background: #f0f0f0;
            cursor: pointer;
            min-width: 60px;
            font-size: 12px;
            vertical-align: middle;
            margin-right: 5px;
        }
        .controlButton:disabled {
            cursor: not-allowed;
            background: #eee;
            color: #999;
        }
        #frameSlider {
            width: 300px;
            margin: 0 10px;
            vertical-align: middle;
        }
        #frameCounter {
            color: #333;
            vertical-align: middle;
            min-width: 80px;
            display: inline-block;
        }
        /* NEW: Trajectory Select */
        #trajectorySelect {
            font-size: 12px;
            padding: 4px 8px;
            border: 1px solid #ccc;
            border-radius: 4px;
            vertical-align: middle;
            margin-left: 5px;
        }
        #trajectorySelect:disabled {
             cursor: not-allowed;
            background: #eee;
        }
        #trajectoryLabel {
            vertical-align: middle;
        }

    </style>
</head>
<body>
    <!-- Main container to hold viewer and controls -->
    <div id="mainContainer">
        <!-- The canvas and dropdown are now siblings in the container -->
        <div id="canvasContainer">
            <canvas id="canvas"></canvas>
            <!-- Shadow Toggle Checkbox -->
            <div id="shadowToggle">
                <input type="checkbox" id="shadowCheckbox" checked>
                <label for="shadowCheckbox">Shadow</label>
            </div>
            <!-- Floating Dropdown Menu -->
            <select id="colorSelect">
                <option value="plddt">pLDDT</option>
                <option value="rainbow">Rainbow</option>
                <option value="chain">Chain</option>
            </select>
        </div>

        <!-- Animation Controls -->
        <div id="controlsContainer">
            <button id="playButton" class="controlButton">Play</button>
            <input type="range" id="frameSlider" min="0" max="0" value="0">
            <span id="frameCounter">Frame: 0 / 0</span>
        </div>
        <!-- NEW Trajectory Controls -->
        <div id="trajectoryContainer">
            <span id="trajectoryLabel">Trajectory:</span>
            <select id="trajectorySelect">
                <option value="default">0</option>
            </select>
            <button id="saveVideoButton" class="controlButton">Save Video</button> <!-- MOVED -->
        </div>
    </div>

    <!--
      This single point will be replaced by the Python script
      with viewer config AND initial data.
    -->
    <!-- DATA_INJECTION_POINT -->

    <script>
        // ============================================================================
        // VECTOR MATH (Unchanged)
        // ============================================================================
        class Vec3 {
            constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
            add(v) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
            sub(v) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
            mul(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
            dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
            length() { return Math.sqrt(this.dot(this)); }
            distanceTo(v) { return this.sub(v).length(); }
        }
        function rotationMatrixX(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [[1,0,0], [0,c,-s], [0,s,c]]; }
        function rotationMatrixY(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [[c,0,s], [0,1,0], [-s,0,c]]; }
        function multiplyMatrices(a, b) { const r = [[0,0,0],[0,0,0],[0,0,0]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j]; return r; }
        function applyMatrix(m, v) { return new Vec3(m[0][0]*v.x + m[0][1]*v.y + m[0][2]*v.z, m[1][0]*v.x + m[1][1]*v.y + m[1][2]*v.z, m[2][0]*v.x + m[2][1]*v.y + m[2][2]*v.z); }
        function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

        // ============================================================================
        // COLOR UTILITIES (Unchanged)
        // ============================================================================
        const pymolColors = ["#33ff33","#00ffff","#ff33cc","#ffff00","#ff9999","#e5e5e5","#7f7fff","#ff7f00","#7fff7f","#199999","#ff007f","#ffdd5e","#8c3f99","#b2b2b2","#007fff","#c4b200","#8cb266","#00bfbf","#b27f7f","#fcd1a5","#ff7f7f","#ffbfdd","#7fffff","#ffff7f","#00ff7f","#337fcc","#d8337f","#bfff3f","#ff7fff","#d8d8ff","#3fffbf","#b78c4c","#339933","#66b2b2","#ba8c84","#84bf00","#b24c66","#7f7f7f","#3f3fa5","#a5512b"];
        function hexToRgb(hex) { if (!hex || typeof hex !== 'string') { return {r: 128, g: 128, b: 128}; } const r = parseInt(hex.slice(1,3), 16); const g = parseInt(hex.slice(3,5), 16); const b = parseInt(hex.slice(5,7), 16); return {r, g, b}; }
        function hsvToRgb(h, s, v) { const c = v * s; const x = c * (1 - Math.abs((h / 60) % 2 - 1)); const m = v - c; let r, g, b; if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; } return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }; }
        function getRainbowColor(value, min, max) { if (max - min < 1e-6) return hsvToRgb(0, 1.0, 1.0); let normalized = (value - min) / (max - min); normalized = Math.max(0, Math.min(1, normalized)); const hue = 240 * normalized; return hsvToRgb(hue, 1.0, 1.0); }
        function getPlddtColor(plddt) { return getRainbowColor(plddt, 50, 90); }
        function getChainColor(chainIndex) { if (chainIndex < 0) chainIndex = 0; return hexToRgb(pymolColors[chainIndex % pymolColors.length]); }

        // ============================================================================
        // DEMO STRUCTURE GENERATOR (Unchanged)
        // ============================================================================
        function generateProteinCurve(n) { const coords = []; const plddts = []; const chains = []; const atomTypes = []; let angle = 0, z = 0; const numProtein = n - 10; for (let i = 0; i < n; i++) { const t = i / n; chains.push(i < n / 2 ? 'A' : 'B'); if (i >= numProtein) { atomTypes.push('L'); plddts.push(75.0); const protEnd = coords[numProtein - 1] || new Vec3(0,0,0); const lt = (i - numProtein) / 10.0; const lx = protEnd.x + 5 + lt * 5 * Math.cos(lt * 20); const ly = protEnd.y + 5 + lt * 5 * Math.sin(lt * 20); const lz = protEnd.z - 3 + lt * 3; coords.push(new Vec3(lx, ly, lz)); } else { atomTypes.push('P'); plddts.push((Math.sin(t * Math.PI * 6) * 0.5 + 0.5) * 50 + 40); const freq = 2 + Math.sin(t * Math.PI * 2) * 1.5; angle += 0.3 * freq; const radius = 15 + 10 * Math.sin(t * Math.PI * 4); const x = radius * Math.cos(angle); const y = radius * Math.sin(angle); z += 0.5 + 0.3 * Math.sin(t * Math.PI * 8); coords.push(new Vec3(x, y, z)); } } return {coords, plddts, chains, atomTypes}; }

        // ============================================================================
        // PSEUDO-3D RENDERER (Updated for Video Recording & Global Zoom)
        // ============================================================================
        class Pseudo3DRenderer {
            constructor(canvas) {
                this.canvas = canvas;
                this.ctx = canvas.getContext('2d');
                // Current render state
                this.coords = [];
                this.plddts = [];
                this.chains = [];
                this.atomTypes = [];
                // Viewer state
                this.colorMode = 'plddt';
                this.rotationMatrix = [[1,0,0],[0,1,0],[0,0,1]];
                this.zoom = 1.0;
                this.lineWidth = 3.0;
                this.shadowIntensity = 0.95;
                this.shadowEnabled = true;
                // REMOVED: this.fixedBounds = null;
                // Performance
                this.lastFrameTime = performance.now();
                this.fps = 0;
                this.drawTime = 0;
                this.numSegments = 0;
                this.chainRainbowScales = {};

                // Animation & Trajectory state
                // MODIFIED: Added globalCenterSum and totalAtoms
                this.trajectoriesData = { "default": { maxExtent: 0, frames: [], globalCenterSum: new Vec3(0,0,0), totalAtoms: 0 } };
                this.currentTrajectoryName = "default";
                this.currentFrame = -1;
                this.isPlaying = false;
                this.animationHandle = null;

                // UI elements
                this.playButton = null;
                this.saveVideoButton = null; // NEW
                this.frameSlider = null;
                this.frameCounter = null;
                this.trajectorySelect = null;

                // NEW: Video recording
                this.mediaRecorder = null;
                this.recordedChunks = [];
                this.isRecording = false;

                this.setupInteraction();
            }

            setupInteraction() {
                let isDragging = false;
                let lastX, lastY;
                this.canvas.addEventListener('mousedown', (e) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
                window.addEventListener('mousemove', (e) => {
                    if (!isDragging || this.isRecording) return; // Don't rotate while recording
                    const dx = e.clientX - lastX; const dy = e.clientY - lastY;
                    if (dy !== 0) { const rot = rotationMatrixX(dy * 0.01); this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); }
                    if (dx !== 0) { const rot = rotationMatrixY(dx * 0.01); this.rotationMatrix = multiplyMatrices(rot, this.rotationMatrix); }
                    lastX = e.clientX; lastY = e.clientY;
                    this.render();
                });
                window.addEventListener('mouseup', () => isDragging = false);
                this.canvas.addEventListener('wheel', (e) => {
                    if (this.isRecording) return; // Don't zoom while recording
                    e.preventDefault();
                    this.zoom *= (1 - e.deltaY * 0.001);
                    this.zoom = Math.max(0.1, Math.min(5, this.zoom));
                    this.render();
                }, { passive: false });
            }

            // Set UI controls from main script
            setUIControls(playButton, saveVideoButton, frameSlider, frameCounter, trajectorySelect) {
                this.playButton = playButton;
                this.saveVideoButton = saveVideoButton; // NEW
                this.frameSlider = frameSlider;
                this.frameCounter = frameCounter;
                this.trajectorySelect = trajectorySelect;

                // Add listener for trajectory changes
                this.trajectorySelect.addEventListener('change', () => {
                    this.stopAnimation();
                    this.currentTrajectoryName = this.trajectorySelect.value;
                    this.setFrame(0);
                });

                // NEW: Add listener for save video
                this.saveVideoButton.addEventListener('click', () => {
                    this.saveAnimationAsVideo();
                });
            }

            // Add a new trajectory
            addTrajectory(name) {
                this.stopAnimation();
                // MODIFIED: Added globalCenterSum and totalAtoms
                this.trajectoriesData[name] = { maxExtent: 0, frames: [], globalCenterSum: new Vec3(0,0,0), totalAtoms: 0 };
                this.currentTrajectoryName = name;
                this.currentFrame = -1;

                // Add to dropdown
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                this.trajectorySelect.appendChild(option);
                // Select it
                this.trajectorySelect.value = name;

                this.updateUIControls();
            }

            // Add a frame (data is raw parsed JSON)
            addFrame(data) {
                // MODIFIED: This function is completely updated
                if (!this.currentTrajectoryName) {
                    this.currentTrajectoryName = "default";
                }
                if (!this.trajectoriesData[this.currentTrajectoryName]) {
                    this.trajectoriesData[this.currentTrajectoryName] = { maxExtent: 0, frames: [], globalCenterSum: new Vec3(0,0,0), totalAtoms: 0 };
                }

                const trajectory = this.trajectoriesData[this.currentTrajectoryName];
                trajectory.frames.push(data);

                // --- NEW: Update global center sum and count ---
                let frameSum = new Vec3(0,0,0);
                let frameAtoms = 0;
                if (data && data.coords) {
                    frameAtoms = data.coords.length;
                    for (const c of data.coords) {
                        frameSum = frameSum.add(new Vec3(c[0], c[1], c[2]));
                    }
                    trajectory.globalCenterSum = trajectory.globalCenterSum.add(frameSum);
                    trajectory.totalAtoms += frameAtoms;
                }
                
                // --- NEW: Calculate current global center ---
                const globalCenter = (trajectory.totalAtoms > 0) ? trajectory.globalCenterSum.mul(1 / trajectory.totalAtoms) : new Vec3(0,0,0);

                // --- NEW: Recalculate maxExtent for *all* frames using the *new* global center ---
                // This is inefficient, but necessary as the center shifts
                let maxDistSq = 0;
                for (const frame of trajectory.frames) {
                    if (frame && frame.coords) {
                        for (const c of frame.coords) {
                            const coordVec = new Vec3(c[0], c[1], c[2]);
                            const centeredCoord = coordVec.sub(globalCenter);
                            const distSq = centeredCoord.dot(centeredCoord); // x*x + y*y + z*z
                            if (distSq > maxDistSq) maxDistSq = distSq;
                        }
                    }
                }
                trajectory.maxExtent = Math.sqrt(maxDistSq); // Update maxExtent

                if (!this.isPlaying && !this.isRecording) { // Don't jump if recording
                    this.setFrame(trajectory.frames.length - 1);
                }
                this.updateUIControls();
            }

            // Set the current frame and render it
            setFrame(frameIndex) {
                frameIndex = parseInt(frameIndex);
                if (!this.currentTrajectoryName) return;

                const trajectory = this.trajectoriesData[this.currentTrajectoryName]; // MODIFIED
                if (!trajectory || frameIndex < 0 || frameIndex >= trajectory.frames.length) { // MODIFIED
                    this.currentFrame = -1;
                    this.ctx.fillStyle = '#ffffff';
                    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                    this.updateUIControls();
                    return;
                }

                this.currentFrame = frameIndex;
                const data = trajectory.frames[frameIndex]; // MODIFIED
                this._loadDataIntoRenderer(data); // This calls render()
                this.updateUIControls();
            }

            // NEW: Update UI element states (e.g., disabled)
            setUIEnabled(enabled) {
                 this.playButton.disabled = !enabled;
                 this.saveVideoButton.disabled = !enabled;
                 this.frameSlider.disabled = !enabled;
                 this.trajectorySelect.disabled = !enabled;
                 this.canvas.style.cursor = enabled ? 'grab' : 'wait';
            }

            // Update the text/slider values
            updateUIControls() {
                if (!this.playButton) return; // UI not ready

                const trajectory = this.trajectoriesData[this.currentTrajectoryName]; // MODIFIED
                const total = trajectory ? trajectory.frames.length : 0; // MODIFIED
                const current = Math.max(0, this.currentFrame) + 1; // 1-based index

                this.frameSlider.max = Math.max(0, total - 1);
                this.frameSlider.value = this.currentFrame;
                this.frameCounter.textContent = `Frame: ${total > 0 ? current : 0} / ${total}`;

                // Update button text
                if (this.isRecording) {
                    this.playButton.textContent = 'Pause';
                    this.saveVideoButton.textContent = 'Recording...';
                } else {
                    this.playButton.textContent = this.isPlaying ? 'Pause' : 'Play';
                    this.saveVideoButton.textContent = 'Save Video';
                }
            }

            // Toggle play/pause
            togglePlay() {
                if (this.isRecording) return; // Don't toggle play while recording
                if (this.isPlaying) {
                    this.stopAnimation();
                } else {
                    this.startAnimation();
                }
            }

            // Start the animation loop
            startAnimation() {
                if (this.isRecording) return; // Can't start if already recording
                const trajectory = this.trajectoriesData[this.currentTrajectoryName]; // MODIFIED
                if (!trajectory || trajectory.frames.length < 2) return; // MODIFIED

                this.isPlaying = true;
                this.updateUIControls();

                const animateStep = () => {
                    if (!this.isPlaying) return;
                    const currentTrajectory = this.trajectoriesData[this.currentTrajectoryName]; // MODIFIED
                    if (!currentTrajectory) {
                        this.stopAnimation();
                        return;
                    }
                    let nextFrame = this.currentFrame + 1;
                    if (nextFrame >= currentTrajectory.frames.length) { // MODIFIED
                        nextFrame = 0; // Loop back to start
                    }
                    this.setFrame(nextFrame);
                    this.animationHandle = setTimeout(animateStep, 100); // 10 fps
                };
                animateStep();
            }

            // Stop the animation loop
            stopAnimation() {
                this.isPlaying = false;
                if (this.animationHandle) {
                    clearTimeout(this.animationHandle);
                }
                this.animationHandle = null;
                this.updateUIControls();
            }

            // NEW: Save animation as video
            saveAnimationAsVideo() {
                if (this.isRecording) return; // Already recording
                this.stopAnimation(); // Stop playback

                const trajectory = this.trajectoriesData[this.currentTrajectoryName]; // MODIFIED
                if (!trajectory || trajectory.frames.length < 2) { // MODIFIED
                    alert("Not enough frames to record.");
                    return;
                }
                if (typeof MediaRecorder === "undefined") {
                    alert("Video recording is not supported in this browser.");
                    return;
                }

                this.isRecording = true;
                this.setUIEnabled(false); // Disable UI
                this.updateUIControls();

                const stream = this.canvas.captureStream(10); // 10 fps, matches player
                this.mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });
                this.recordedChunks = [];

                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        this.recordedChunks.push(event.data);
                    }
                };

                this.mediaRecorder.onstop = () => {
                    const blob = new Blob(this.recordedChunks, { type: "video/webm" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    document.body.appendChild(a);
                    a.style = "display: none";
                    a.href = url;
                    a.download = `trajectory_${this.currentTrajectoryName}.webm`;
                    a.click();
                    window.URL.revokeObjectURL(url);

                    // Reset state
                    this.isRecording = false;
                    this.recordedChunks = [];
                    this.mediaRecorder = null;
                    this.setUIEnabled(true); // Re-enable UI
                    this.setFrame(this.currentFrame); // Redraw last frame
                    this.updateUIControls();
                };

                this.mediaRecorder.start();

                // Go to first frame and start recording loop
                this.setFrame(0);

                let recordingFrame = 0;
                const recordStep = () => {
                    if (!this.isRecording) return;

                    recordingFrame++;
                    if (recordingFrame < trajectory.frames.length) { // MODIFIED
                        this.setFrame(recordingFrame);
                        // Use requestAnimationFrame to ensure canvas is drawn before next step
                        requestAnimationFrame(recordStep);
                    } else {
                        // We have rendered the last frame, stop recording
                        this.mediaRecorder.stop();
                    }
                };

                // Start the loop after a short delay to let frame 0 render
                requestAnimationFrame(recordStep);
            }


            // RENAMED: from updateData to _loadDataIntoRenderer
            _loadDataIntoRenderer(data) {
                try {
                    if (data && data.coords && data.coords.length > 0) {
                        const coords = data.coords.map(c => new Vec3(c[0], c[1], c[2]));
                        const plddts = data.plddts || [];
                        const chains = data.chains || [];
                        const atomTypes = data.atom_types || [];
                        this.setCoords(coords, plddts, chains, atomTypes);
                    }
                } catch (e) {
                    console.error("Failed to load data into renderer:", e);
                }
                this.render();
            }

            // This function is now internal, called by _loadDataIntoRenderer
            setCoords(coords, plddts = [], chains = [], atomTypes = []) {
                // MODIFIED: Removed centering and bounds calculation
                this.coords = coords;
                this.plddts = plddts;
                this.chains = chains;
                this.atomTypes = atomTypes;

                if (this.plddts.length !== this.coords.length) { this.plddts = Array(this.coords.length).fill(50.0); }
                if (this.chains.length !== this.coords.length) { this.chains = Array(this.coords.length).fill('A'); }
                if (this.atomTypes.length !== this.coords.length) { this.atomTypes = Array(this.coords.length).fill('P'); }

                this.chainRainbowScales = {};
                for (let i = 0; i < this.atomTypes.length; i++) {
                    if (this.atomTypes[i] === 'P') {
                        const chainId = this.chains[i] || 'A';
                        if (!this.chainRainbowScales[chainId]) { this.chainRainbowScales[chainId] = { min: Infinity, max: -Infinity }; }
                        const colorIndex = this.coords.length - 1 - i;
                        const scale = this.chainRainbowScales[chainId];
                        scale.min = Math.min(scale.min, colorIndex);
                        scale.max = Math.max(scale.max, colorIndex);
                    }
                }
                // REMOVED: this.centerCoords();
                // REMOVED: this.calculateFixedBounds();
            }

            // REMOVED: centerCoords() function
            // REMOVED: calculateFixedBounds() function

            // RENDER: This function is unchanged.
            render() {
                const startTime = performance.now();
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                if (this.coords.length === 0) return;

                // --- NEW: Get global center ---
                const trajectory = this.trajectoriesData[this.currentTrajectoryName];
                const globalCenter = (trajectory && trajectory.totalAtoms > 0) ? trajectory.globalCenterSum.mul(1 / trajectory.totalAtoms) : new Vec3(0,0,0);

                const rotated = this.coords.map(v => applyMatrix(this.rotationMatrix, v.sub(globalCenter)));
                const segments = [];
                const proteinChainbreak = 5.0;
                const ligandBondCutoff = 2.0;
                let firstProteinIndex = -1;
                let lastProteinIndex = -1;
                const ligandIndices = [];

                for (let i = 0; i < rotated.length; i++) {
                    if (this.atomTypes[i] === 'L') {
                        ligandIndices.push(i);
                        continue;
                    }
                    if (firstProteinIndex === -1) { firstProteinIndex = i; }
                    lastProteinIndex = i;
                    if (i < rotated.length - 1) {
                        const type1 = this.atomTypes[i];
                        const type2 = this.atomTypes[i+1];
                        if (type1 === 'P' && type2 === 'P') {
                            const start = rotated[i];
                            const end = rotated[i+1];
                            const dist = start.distanceTo(end);
                            if (dist < proteinChainbreak) {
                                segments.push({ start, end, mid: start.add(end).mul(0.5), length: dist, colorIndex: rotated.length - 1 - i, origIndex: i, chainId: this.chains[i] || 'A' });
                            }
                        }
                    }
                }

                if (firstProteinIndex !== -1 && lastProteinIndex !== -1 && firstProteinIndex !== lastProteinIndex) {
                    const firstProteinChainId = this.chains[firstProteinIndex] || 'A';
                    const lastProteinChainId = this.chains[lastProteinIndex] || 'A';
                    if (firstProteinChainId === lastProteinChainId) {
                        const start = rotated[firstProteinIndex];
                        const end = rotated[lastProteinIndex];
                        const dist = start.distanceTo(end);
                        if (dist < proteinChainbreak) {
                            segments.push({ start, end, mid: start.add(end).mul(0.5), length: dist, colorIndex: this.chainRainbowScales[firstProteinChainId]?.min || 0, origIndex: firstProteinIndex, chainId: firstProteinChainId });
                        }
                    }
                }

                for (let i = 0; i < ligandIndices.length; i++) {
                    for (let j = i + 1; j < ligandIndices.length; j++) {
                        const idx1 = ligandIndices[i];
                        const idx2 = ligandIndices[j];
                        const start = rotated[idx1];
                        const end = rotated[idx2];
                        const dist = start.distanceTo(end);
                        if (dist < ligandBondCutoff) {
                             segments.push({ start, end, mid: start.add(end).mul(0.5), length: dist, colorIndex: 0, origIndex: idx1, chainId: this.chains[idx1] || 'A' });
                        }
                    }
                }

                this.numSegments = segments.length;
                if (segments.length === 0) return;

                const grey = {r: 128, g: 128, b: 128};
                const colors = segments.map(seg => {
                    const i = seg.origIndex;
                    const type = this.atomTypes[i];
                    if (type === 'L') {
                        if (this.colorMode === 'plddt') {
                            const plddt1 = (this.plddts[i] !== null && this.plddts[i] !== undefined) ? this.plddts[i] : 50;
                            return getPlddtColor(plddt1);
                        }
                        return grey;
                    }
                    if (this.colorMode === 'plddt') {
                        const plddt1 = (this.plddts[i] !== null && this.plddts[i] !== undefined) ? this.plddts[i] : 50;
                        const plddt2_idx = (seg.origIndex + 1 < this.coords.length) ? seg.origIndex + 1 : seg.origIndex;
                        const plddt2 = (this.plddts[plddt2_idx] !== null && this.plddts[plddt2_idx] !== undefined) ? this.plddts[plddt2_idx] : 50;
                        return getPlddtColor((plddt1 + plddt2) / 2);
                    }
                    else if (this.colorMode === 'chain') {
                        if (this.chains.length === 0) return getChainColor(0);
                        const chainId = this.chains[i] || 'A';
                        const uniqueChains = [...new Set(this.chains)];
                        const chainIndex = uniqueChains.indexOf(chainId);
                        return getChainColor(chainIndex >= 0 ? chainIndex : 0);
                    }
                    else {
                        const scale = this.chainRainbowScales[seg.chainId];
                        if (scale) { return getRainbowColor(seg.colorIndex, scale.min, scale.max); }
                        else { return grey; }
                    }
                });

                const zValues = segments.map(s => (s.start.z + s.end.z) / 2);
                const zMin = Math.min(...zValues);
                const zMax = Math.max(...zValues);
                const zNorm = zValues.map(z => zMax - zMin > 1e-6 ? (z - zMin) / (zMax - zMin) : 0);
                const n = segments.length;
                const shadows = new Float32Array(n);
                const tints = new Float32Array(n);

                if (this.shadowEnabled) {
                    for (let i = 0; i < n; i++) {
                        let shadowSum = 0; let maxTint = 0;
                        const seg1 = segments[i];
                        for (let j = 0; j < n; j++) {
                            if (i === j) continue;
                            const seg2 = segments[j];
                            if (zValues[i] >= zValues[j]) continue;
                            const avgLen = (seg1.length + seg2.length) / 2;
                            const shadow_cutoff = avgLen * 2.0;
                            const tint_cutoff = avgLen / 2.0;
                            const max_cutoff = shadow_cutoff + 10.0;
                            const dx = seg1.mid.x - seg2.mid.x; if (Math.abs(dx) > max_cutoff) continue;
                            const dy = seg1.mid.y - seg2.mid.y; if (Math.abs(dy) > max_cutoff) continue;
                            const dist2D = Math.sqrt(dx*dx + dy*dy); if (dist2D > max_cutoff) continue;
                            const dist3D = seg1.mid.distanceTo(seg2.mid);
                            if (dist3D < max_cutoff) { shadowSum += sigmoid(shadow_cutoff - dist3D); }
                            if (dist2D < tint_cutoff + 10.0) { maxTint = Math.max(maxTint, sigmoid(tint_cutoff - dist2D)); }
                        }
                        shadows[i] = Math.pow(this.shadowIntensity, shadowSum);
                        tints[i] = 1 - maxTint;
                    }
                } else {
                    shadows.fill(1.0);
                    tints.fill(1.0);
                }

                const order = Array.from({length: n}, (_, i) => i).sort((a, b) => zValues[a] - zValues[b]);
                
                // MODIFIED: Get dataRange from trajectory's maxExtent
                // const trajectory = this.trajectoriesData[this.currentTrajectoryName]; // Already defined above
                // Use 30.0 as a fallback if extent is 0 (e.g., single atom or no data)
                const maxExtent = (trajectory && trajectory.maxExtent > 0) ? trajectory.maxExtent : 30.0;
                const dataRange = (maxExtent * 2) + this.lineWidth * 2;
                
                const canvasSize = Math.min(this.canvas.width, this.canvas.height);
                const scale = (canvasSize / dataRange) * this.zoom;
                const pyFigWidthPixels = 480.0;
                const pyPixelsPerData = pyFigWidthPixels / dataRange;
                const baseLineWidthPixels = (this.lineWidth * pyPixelsPerData) * this.zoom;
                const centerX = this.canvas.width / 2;
                const centerY = this.canvas.height / 2;

                for (const idx of order) {
                    const seg = segments[idx];
                    let {r, g, b} = colors[idx];
                    r /= 255; g /= 255; b /= 255;
                    const tintFactor = (0.50 * zNorm[idx] + 0.50 * tints[idx]) / 3;
                    r = r + (1 - r) * tintFactor;
                    g = g + (1 - g) * tintFactor;
                    b = b + (1 - b) * tintFactor;
                    const shadowFactor = 0.20 + 0.25 * zNorm[idx] + 0.55 * shadows[idx];
                    r *= shadowFactor; g *= shadowFactor; b *= shadowFactor;
                    const color = `rgb(${r*255|0},${g*255|0},${b*255|0})`;
                    const x1 = centerX + seg.start.x * scale; const y1 = centerY - seg.start.y * scale;
                    const x2 = centerX + seg.end.x * scale; const y2 = centerY - seg.end.y * scale;
                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    this.ctx.strokeStyle = color;
                    const type = this.atomTypes[seg.origIndex];
                    this.ctx.lineWidth = (type === 'L') ? (baseLineWidthPixels / 2) : baseLineWidthPixels;
                    this.ctx.lineCap = 'round';
                    this.ctx.stroke();
                }

                this.drawTime = performance.now() - startTime;
                this.updateFPS();
            }

            updateFPS() {
                const now = performance.now();
                const delta = now - this.lastFrameTime;
                this.fps = Math.round(1000 / delta);
                this.lastFrameTime = now;
            }

            animate() {
                // This is the original empty animate function.
                // We are using setTimeout for our own animation loop, so this is fine.
                requestAnimationFrame(() => this.animate());
            }
        }

        // ============================================================================
        // MAIN APP & COLAB COMMUNICATION (Updated for Video Recording)
        // ============================================================================

        // 1. Get config from Python
        const config = window.viewerConfig || { size: [800, 600], color: "plddt" };

        // 2. Setup Canvas
        const canvas = document.getElementById('canvas');
        canvas.width = config.size[0];
        canvas.height = config.size[1];
        // Set the width of the controls container to match the canvas
        document.getElementById('mainContainer').style.width = `${config.size[0]}px`;
        document.getElementById('frameSlider').style.width = `${config.size[0] - 220}px`; // Adjusted for button move


        // 3. Create renderer
        window.renderer = new Pseudo3DRenderer(canvas);
        window.renderer.colorMode = config.color;

        // 4. Setup original dropdowns
        const colorSelect = document.getElementById('colorSelect');
        colorSelect.value = config.color;
        colorSelect.addEventListener('change', (e) => {
            window.renderer.colorMode = e.target.value;
            window.renderer.render();
        });
        const shadowCheckbox = document.getElementById('shadowCheckbox');
        shadowCheckbox.checked = window.renderer.shadowEnabled;
        shadowCheckbox.addEventListener('change', (e) => {
            window.renderer.shadowEnabled = e.target.checked;
            window.renderer.render();
        });

        // 5. NEW: Setup animation and trajectory controls
        const playButton = document.getElementById('playButton');
        const saveVideoButton = document.getElementById('saveVideoButton'); // NEW
        const frameSlider = document.getElementById('frameSlider');
        const frameCounter = document.getElementById('frameCounter');
        const trajectorySelect = document.getElementById('trajectorySelect');

        // Pass ALL controls to the renderer
        window.renderer.setUIControls(playButton, saveVideoButton, frameSlider, frameCounter, trajectorySelect);

        playButton.addEventListener('click', () => {
            window.renderer.togglePlay();
        });

        frameSlider.addEventListener('input', (e) => {
            window.renderer.stopAnimation(); // Stop playing if user scrubs
            window.renderer.setFrame(e.target.value);
        });

        // 6. Add function for Python to call (for new frames)
        /**
         * @param {string} jsonData A JSON string containing {coords, plddts, chains, atom_types}
         */
        window.handlePythonUpdate = (jsonData) => {
            console.log("Received update from Python");
            try {
                const data = JSON.parse(jsonData);
                window.renderer.addFrame(data); // Add frame to current trajectory
            } catch (e) {
                console.error("Failed to parse JSON from Python:", e);
            }
        };

        // 7. NEW: Add function for Python to start a new trajectory
        window.handlePythonNewTrajectory = (name) => {
            console.log("Received new trajectory from Python:", name);
            window.renderer.addTrajectory(name);
        };

        // 8. Load initial data
        try {
            if (window.proteinData && window.proteinData.coords && window.proteinData.coords.length > 0) {
                // Add the initial data to the "default" trajectory
                window.renderer.addFrame(window.proteinData);
            } else {
                // Fallback to demo structure
                const {coords, plddts, chains, atomTypes} = generateProteinCurve(100);
                const demoData = {
                    coords: coords.map(c => [c.x, c.y, c.z]),
                    plddts: plddts,
                    chains: chains,
                    atom_types: atomTypes
                };
                window.renderer.addFrame(demoData);
            }
        } catch (error) {
            console.error("Error loading initial data:", error);
            const {coords, plddts, chains, atomTypes} = generateProteinCurve(100);
            const demoData = { coords: coords.map(c => [c.x, c.y, c.z]), plddts: plddts, chains: chains, atom_types: atomTypes };
            window.renderer.addFrame(demoData);
        }

        // 9. Initial render and start animation loop
        // setFrame() (called by addFrame) already handles the first render
        window.renderer.animate(); // Keep this as it was

    </script>
</body>
</html>
