// ============================================================================
// src/parts/capture.js
// ----------------------------------
// AI Context: CAPTURE: stills, video, and what the browser will encode
// - What a capture IS: the options the panel remembers, which formats and
//   sizes are actually available, the sink that turns frames into a file, and
//   the three sources - a turn, a drawing, a trajectory.
// - Also saveImage and saveAsSvg, which are the same question without a clock.
// - The PANEL that offers all this is parts/savepanel.js.
// ============================================================================
(function () {
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({
    name: 'capture',
    proto: {
        /**
         * WHAT THE CAPTURE PANEL REMEMBERS, and what it starts at.
         *
         * One object for both outputs. There used to be two - _saveOpts for the
         * image, _videoOpts for a recording - written and defaulted in four
         * places between them, which is how the DPI default came to be 300 in
         * one of them and 300 spelled again in the shift-click path.
         *
         * dpi 200: a 1000 px canvas comes out about 2000 px, which is a figure
         * at column width in print and a file measured in single-digit
         * megabytes. 300 is the right number for a full-page plate and was the
         * wrong one to reach for every time.
         *
         * mbps 12: A BITRATE IS A CEILING, NOT A TARGET, which is the whole
         * reason to be generous with it. Measured on one turn at 1196x1196,
         * 15 fps, asking for N and seeing what the encoder actually spent:
         *
         *      asked   spent   file    SSIM against a 40 Mbps take
         *        2     1.07    261 kB   0.9797
         *        5     2.59    632 kB   0.9894
         *       10     5.04    1.2 MB   0.9967
         *       20     9.8     2.4 MB   0.9993
         *       40     14.7    3.6 MB   -
         *
         * So on flat cartoon colour the encoder stops well short of the
         * allowance and a high ceiling costs nothing; it only spends the bytes
         * where the picture genuinely needs them. 5 was chosen against the 20
         * the three recorders each hard-coded, and it is fine at the size a
         * viewer opens at - but it is thin for an upload master at 2x or 3x,
         * where 5 Mbps over 1196x1196 at 30 fps is 0.12 bits a pixel. Anything
         * bound for a platform is re-encoded on arrival (TikTok, Instagram and
         * YouTube all do), and that second encode is only as good as what it
         * is given, which is the argument for the headroom.
         */

        /** The panel's state, defaults filled in, so every reader agrees. */
        captureOpts() {
            const d = this.constructor.CAPTURE_DEFAULTS;
            return Object.assign({}, d, this._captureOpts || {});
        },

        /**
         * WHICH VIDEO FORMATS THIS PAGE CAN ACTUALLY WRITE.
         *
         * Asked of the browser and of the page, never assumed. WebM is
         * MediaRecorder's own and is always there; MP4 is MediaRecorder's too
         * where the build has an H.264 encoder, which recent Chrome and Safari
         * do and Firefox does not; GIF has no native encoder at all and is
         * offered only where py2dmolGif is loaded - src/io/parse.js, which is
         * index.html and not the notebook. A format that cannot be written must
         * not be in the menu: a recording that fails after the fact has already
         * cost the user the take.
         */
        videoFormats() {
            const ok = (m) => (typeof MediaRecorder !== 'undefined'
                && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
            const out = [];
            const webm = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
                .find(ok);
            if (webm) out.push({ id: 'webm', label: 'WebM', ext: 'webm', mime: webm });
            const mp4 = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4']
                .find(ok);
            if (mp4) out.push({ id: 'mp4', label: 'MP4', ext: 'mp4', mime: mp4 });
            if (typeof window !== 'undefined' && typeof window.py2dmolGif === 'function') {
                out.push({ id: 'gif', label: 'GIF', ext: 'gif', mime: null });
            }
            // A ZIP OF PNGs IS A VIDEO FORMAT TOO - the same frames, written
            // one file each instead of one file for all of them, which is what
            // you want for a figure per timepoint or for handing the frames to
            // an editor rather than a re-encode of them. It was a button of its
            // own on the Image row that only ever wrote a trajectory; as a
            // format it records a turn and a drawing as well, and takes its
            // resolution from the dpi above rather than from a Size menu that
            // would be a second way of saying the same thing.
            if (typeof JSZip !== 'undefined') {
                out.push({ id: 'zip', label: 'Images', ext: 'zip', mime: null });
            }
            return out;
        },

        videoFormatOf(id) {
            const all = this.videoFormats();
            return all.find((f) => f.id === id) || all[0] || null;
        },

        /**
         * THE SIZES A RECORDING CAN BE MADE AT, in real pixels.
         *
         * The old answer to "what resolution is the video" was "whatever the
         * canvas happens to be" - the backing store, which is the panel size
         * times the device pixel ratio and never stated anywhere. It is stated
         * now, and can be multiplied: a frame is re-rendered at the target size
         * rather than scaled up from the screen one, the same way a 300 dpi PNG
         * is, so a 2x recording genuinely resolves more.
         *
         * Even numbers, because H.264 wants both dimensions even and simply
         * fails on a stream that is not. Capped at 4096, the level limit most
         * hardware encoders stop at.
         */
        videoSizes() {
            const c = this.canvas;
            if (!c || !c.width) return [];
            const out = [];
            // SMALLER AS WELL AS LARGER. A half-size recording is a quarter of
            // the pixels and about a quarter of the file - which is what you
            // want for a GIF, for a slide, or for anything going into a
            // message - and there was no way to ask for one: the recording was
            // whatever the canvas happened to be.
            const FRACTION = { 0.25: '1/4', 0.5: '1/2' };
            for (const k of [0.25, 0.5, 1, 2, 4]) {
                const w = 2 * Math.round(c.width * k / 2);
                const h = 2 * Math.round(c.height * k / 2);
                if (w < 64 || h < 64) continue;            // below this it is a thumbnail
                if (k > 1 && (w > 4096 || h > 4096)) break; // the encoder level limit
                // THE MULTIPLIER IS THE LABEL, not the pixels. The info line
                // under the row already says what the file will be - "WebM
                // 598x598 - 6s at 30 fps" - so spelling the same number into
                // the menu said it twice and made the widest control in a
                // 160px panel out of the half that was already there. And a
                // fraction reads as a fraction: "0.25x" is a decimal doing a
                // fraction's job, with an x repeating what the control's own
                // name already says.
                out.push({ scale: k, w, h, label: FRACTION[k] || String(k) });
            }
            return out;
        },

        // A GIF IS NOT A VIDEO FILE and cannot be treated as one: every frame
        // is kept in memory until the palette is known, its delays are whole
        // centiseconds so anything past ~20 fps is a lie, and 256 colours over
        // a megapixel is a slow quantisation and a huge file. These are the
        // limits the panel shows and the sink enforces.

        /**
         * WHERE A RECORDING'S FRAMES GO. One object, three recorders, two very
         * different destinations behind it.
         *
         * The turn, the drawing and the trajectory each drive their own frames
         * for their own reasons and none of them should have to know how a file
         * gets written. They render, then call frame(); at the end they call
         * finish(). What that does - hand a canvas stream to MediaRecorder, or
         * collect pixels for the GIF encoder - is decided here, once, from the
         * panel's options.
         *
         * @param {object} opts - seconds/fps/mbps/container/scale, plus
         *        sourceCanvas to record something other than the live canvas
         *        (the trajectory recorder composites a scatter plot beside it)
         * @returns {object|null} {frame, finish, cancel, width, height, note}
         */
        _makeVideoSink(opts) {
            const o = opts || {};
            const fmt = this.videoFormatOf(o.container);
            if (!fmt) return null;
            const gif = fmt.id === 'gif';
            const zip = fmt.id === 'zip';
            const LIM = this.constructor.GIF_LIMITS;
            const fps = Math.max(5, Math.min(gif ? LIM.maxFps : 60, Number(o.fps) || 30));
            const live = this.canvas;
            const source = o.sourceCanvas || live;
            const dispW = this.displayWidth || parseInt(live.style.width) || live.width;
            const dispH = this.displayHeight || parseInt(live.style.height) || live.height;

            // WHAT SIZE, AND WHETHER THAT NEEDS A SECOND CANVAS AT ALL.
            // Scale 1 with no compositing records the live canvas directly -
            // the path this always took, and the cheapest. Anything else needs
            // its own canvas, and every frame is RE-RENDERED into it at that
            // size rather than blown up from the screen.
            let w = source.width; let h = source.height;
            let note = '';
            if (zip) {
                // THE IMAGE ROW'S DPI, not the video Size: these frames ARE
                // images, and two controls for one resolution is how they come
                // to disagree.
                const k = Math.max(36, Math.min(1200, Number(o.dpi) || 200)) / 96;
                w = Math.max(1, Math.round(dispW * k));
                h = Math.max(1, Math.round(dispH * k));
                const maxPx = 16000;
                if (w > maxPx || h > maxPx) {
                    const f = Math.min(maxPx / w, maxPx / h);
                    w = Math.round(w * f); h = Math.round(h * f);
                }
                note = `, ${Math.round(96 * w / dispW)} dpi`;
            } else if (!o.sourceCanvas) {
                // ...and DOWN as well as up: the clamp used to floor at 1,
                // which silently turned every half-size recording back into a
                // full-size one - the panel said 300x300 and the file came out
                // 598x598.
                const k = Math.max(0.1, Math.min(3, Number(o.scale) || 1));
                w = 2 * Math.round(live.width * k / 2);
                h = 2 * Math.round(live.height * k / 2);
            }
            if (gif) {
                const long = Math.max(w, h);
                if (long > LIM.maxPx) {
                    const f = LIM.maxPx / long;
                    w = 2 * Math.round(w * f / 2); h = 2 * Math.round(h * f / 2);
                    note = ` (GIF capped at ${LIM.maxPx}px)`;
                }
            }
            // A CUT-OUT GIF HAS TO BE RENDERED, not read off the screen: the
            // live canvas has the paper painted into it and every pixel is
            // opaque. So transparency forces the offscreen path even at 1x.
            // A GIF IS ALWAYS CUT OUT. Its transparency is one palette entry
            // rather than an alpha channel, so the edge is a hard cut - but a
            // turn dropped onto a slide or a dark page wants that far more
            // often than it wants a white square around the structure, and the
            // choice was one more control on the widest row in the panel. PNG
            // already exports this way; WebM and MP4 cannot, which is why it
            // is not a question anywhere else either.
            const clear = gif;
            // A zip is always rendered: its frames are PNGs at their own size,
            // and a PNG of the live canvas would be the screen's.
            const offscreen = zip || clear || (w !== source.width || h !== source.height);
            let target = source;
            let octx = null;
            if (offscreen) {
                target = document.createElement('canvas');
                target.width = w; target.height = h;
                octx = target.getContext('2d');
            }
            // Re-render at the target size, exactly as the PNG export does:
            // _exportPxScale keeps the quantities that are PIXELS by definition
            // - outline width, selection ink - the size they are on screen,
            // while everything measured in Angstrom follows the resolution.
            // ONE RENDER PER FRAME, NOT TWO.
            //
            // The recorders used to render to the screen and then, for a scaled
            // recording, render AGAIN into the offscreen canvas - so every
            // frame was drawn twice at two different sizes. On the 2D path that
            // is simply double the work (4HHB: 33 ms + 40 ms a frame). On the
            // GPU path it is worse than double: the mesh cache is keyed on the
            // output size, so alternating 598 px and 1196 px REBUILT THE MESH
            // TWICE A FRAME - 91 ms a frame against about 2 for the same
            // recording at screen size.
            //
            // So the offscreen render is the only one, and the screen is shown
            // a scaled-down copy of it. That is a blit, and it costs nothing
            // next to a render.
            const blit = () => {
                if (!octx || !this.ctx || !this.canvas) return;
                const c = this.ctx;
                c.save();
                c.setTransform(1, 0, 0, 1, 0, 0);
                if (this.isTransparent) c.clearRect(0, 0, this.canvas.width, this.canvas.height);
                else {
                    c.fillStyle = this.backgroundColor || '#ffffff';
                    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
                }
                c.drawImage(target, 0, 0, this.canvas.width, this.canvas.height);
                c.restore();
            };
            const paint = () => {
                if (!octx) return;
                const wasClear = this.isTransparent;
                if (clear) this.isTransparent = true;
                octx.save();
                octx.setTransform(1, 0, 0, 1, 0, 0);
                if (this.isTransparent) octx.clearRect(0, 0, w, h);
                else { octx.fillStyle = this.backgroundColor || '#ffffff'; octx.fillRect(0, 0, w, h); }
                octx.restore();
                const prev = this._exportPxScale;
                this._exportPxScale = w / dispW;
                try { this._renderToContext(octx, w, h); } finally {
                    this._exportPxScale = prev || 1;
                    this.isTransparent = wasClear;
                }
            };

            const rendersItself = !!offscreen;
            if (zip) {
                const store = new JSZip();
                const name = this.currentObjectName || 'viewer';
                let n = 0; let pending = 0; let closed = null;
                const settle = () => {
                    if (!closed || pending) return;
                    const done = closed; closed = null;
                    this._captureStatus(`Zipping ${n} frames...`);
                    store.generateAsync({ type: 'blob' })
                        .then((blob) => done(blob, 'zip'))
                        .catch(() => done(null, 'zip'));
                };
                return {
                    width: w, height: h, fps, note, ext: 'zip', rendersItself,
                    frame: () => {
                        paint(); blit();
                        n++;
                        const at = n;
                        pending++;
                        // toBlob is asynchronous, so the zip cannot be closed
                        // until the last one has come back - hence the count.
                        target.toBlob((blob) => {
                            if (blob) store.file(`${name}_${String(at).padStart(4, '0')}.png`, blob);
                            pending--;
                            settle();
                        }, 'image/png');
                    },
                    cancel: () => { closed = null; },
                    finish: (done) => { closed = done; settle(); },
                };
            }
            if (gif) {
                const shots = [];
                const gctx = octx || source.getContext('2d');
                return {
                    width: w, height: h, fps, note, ext: 'gif', rendersItself,
                    frame: () => {
                        if (shots.length >= LIM.maxFrames) return;
                        if (octx) { paint(); blit(); } else this.render('capture');
                        shots.push(gctx.getImageData(0, 0, w, h).data);
                    },
                    cancel: () => { shots.length = 0; },
                    finish: (done) => {
                        if (!shots.length) { done(null); return; }
                        // Encoding a few hundred megapixels blocks the tab, so
                        // the status line is set BEFORE it starts rather than
                        // after, or the only sign of life is a frozen page.
                        this._captureStatus(`Encoding ${shots.length} GIF frames...`);
                        setTimeout(() => {
                            const blob = window.py2dmolGif(shots, { width: w, height: h,
                                colors: Math.max(8, Math.min(256, Number(o.colors) || 256)),
                                transparent: clear,
                                delayCs: Math.max(2, Math.round(100 / fps)) });
                            shots.length = 0;
                            done(blob, 'gif');
                        }, 0);
                    },
                };
            }

            // MANUAL CAPTURE. captureStream(fps) samples the canvas on its own
            // clock AND accepts requestFrame, so every rendered frame went in
            // twice over: a 6-frame trajectory came out a 12-frame video, twice
            // the length the panel promised. With 0 the stream produces exactly
            // the frames it is handed. Chrome, Firefox and Safari all take it;
            // if one does not, the old behaviour is the fallback.
            let stream;
            try { stream = target.captureStream(0); }
            catch (e) { stream = target.captureStream(fps); }
            const bits = Math.max(1, Math.min(80, Number(o.mbps) || 5)) * 1000000;
            let rec;
            try {
                rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: bits });
            } catch (err) {
                try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
                return null;
            }
            const chunks = [];
            let onDone = null;
            rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
            rec.onstop = () => {
                try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
                if (onDone) {
                    onDone(chunks.length ? new Blob(chunks, { type: fmt.mime }) : null, fmt.ext);
                }
            };
            // STARTED ON THE FIRST FRAME, not before it. A recorder started
            // while the canvas already holds the opening frame captures that
            // state as a frame of its own, so a 6-frame trajectory came out 7
            // frames long - the first one twice.
            let started = false;
            const begin = () => { if (!started) { started = true; rec.start(100); } };
            const track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
            return {
                width: w, height: h, fps, note, ext: fmt.ext, rendersItself,
                frame: () => {
                    // The composite path (a scatter plot beside the structure)
                    // has its own canvas and is drawn by the recorder, so there
                    // is nothing to render here.
                    if (octx) { paint(); blit(); } else if (!o.sourceCanvas) {
                        this.render('capture');
                    }
                    begin();
                    // captureStream samples the canvas on its own clock;
                    // nudging it where supported keeps one rendered frame to
                    // one video frame.
                    if (track && track.requestFrame) {
                        try { track.requestFrame(); } catch (e) { /* optional */ }
                    }
                },
                cancel: () => {
                    onDone = null;
                    try { rec.stop(); } catch (e) { /* already stopped */ }
                },
                finish: (done) => {
                    onDone = done;
                    if (!started) { done(null, fmt.ext); return; }   // nothing was ever handed over
                    // let the last frame land in the stream before closing
                    setTimeout(() => { try { rec.stop(); } catch (e) { /* stopped */ } }, 1000 / fps);
                },
            };
        },

        /**
         * WHAT THESE SETTINGS WILL PRODUCE, in the panel's own words, before
         * anything is written. The Image row shows its pixel size beside the
         * dpi; this says the same for a recording, where the size depends on
         * the format as well as the menu (a GIF is capped, and clamped to 20
         * fps) and nothing else in the row would show it.
         */
        _describeCapture() {
            if (!this._savePanel || this._captureBusy) return;
            const o = this.captureOpts();
            const lines = [];
            // THE IMAGE, in the same box as everything else. Its pixel size
            // used to sit inline on its own row, which is a second place for
            // the kind of thing this box exists to hold - and the row is a
            // format, a dpi and two buttons already.
            const dispW = this.displayWidth
                || parseInt(this.canvas && this.canvas.style.width) || 0;
            const dispH = this.displayHeight
                || parseInt(this.canvas && this.canvas.style.height) || 0;
            if (o.format === 'png') {
                const k = o.dpi / 96;
                lines.push(`PNG ${Math.round(dispW * k)}x${Math.round(dispH * k)}`
                    + ` \u00b7 ${o.dpi} dpi`);
            } else {
                // A VECTOR HAS NEITHER. No pixels to count and no dpi to count
                // them at - it is resolution-independent, which is the reason
                // to pick it - so saying "598x598 at 96 dpi" described a
                // property the file does not have.
                lines.push(`${o.format === 'svgz' ? 'SVG.gz' : 'SVG'} \u00b7 vector`);
            }
            const fmt = this.videoFormatOf(o.container);
            if (!fmt || !this._savePanel.querySelector('#saveVideoFormat')) {
                this._captureStatus(lines.join('\n'));
                return;
            }
            const sizes = this.videoSizes();
            const z = sizes.find((q) => q.scale === Number(o.scale)) || sizes[0];
            const gif = fmt.id === 'gif';
            const zip = fmt.id === 'zip';
            const LIM = this.constructor.GIF_LIMITS;
            const fps = Math.min(o.fps, gif ? LIM.maxFps : 60);
            // Images are sized by the dpi above, not by the Size menu - the
            // line has to say the size the sink will actually use.
            let w = z ? z.w : 0; let h = z ? z.h : 0;
            if (zip) {
                const k = (o.dpi || 200) / 96;
                w = Math.round(dispW * k); h = Math.round(dispH * k);
            }
            if (gif && Math.max(w, h) > LIM.maxPx) {
                const f = LIM.maxPx / Math.max(w, h);
                w = 2 * Math.round(w * f / 2); h = 2 * Math.round(h * f / 2);
            }
            const bits = [`${fmt.label} ${w}x${h}`];
            lines.push('');
            // WHAT THIS COMBINATION WILL ACTUALLY PRODUCE. The four sources
            // differ in who sets the length, so the line has to work it out
            // rather than repeat the boxes: on F and FR the trajectory decides
            // and the seconds are DERIVED (N frames at the chosen rate); on R
            // and RF the seconds decide and the frame count is derived. Saying
            // "6s" over a recording whose length the trajectory fixes is the
            // kind of small lie that makes a panel untrustworthy.
            const obj2 = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const nTraj = (obj2 && obj2.frames) ? obj2.frames.length : 0;
            const src = o.source || '';
            const led = (src === 'F' || src === 'FR') && nTraj > 1;
            if (!zip) {
                const n = led ? nTraj : Math.max(2, Math.round(o.seconds * fps));
                const secs = led ? (nTraj / fps) : o.seconds;
                bits.push(`${n} frames`, `${(Math.round(secs * 10) / 10)}s at ${fps} fps`);
                if (src === 'R' || src === 'FR' || src === 'RF' || src === 'DR') {
                    const t = Math.max(1, Math.min(10, o.rotations || 1));
                    bits.push(`${t} turn${t === 1 ? '' : 's'}`);
                }
                if (src === 'RF' && nTraj > 1) bits.push(`${nTraj} model frames fitted`);
            }
            if (zip) {
                // one per trajectory frame where the trajectory sets the
                // length, and the count where it does not
                const n = led ? `${nTraj} PNGs, one per frame`
                    : `${o.frames || 36} PNGs`;
                bits.push(n, `${o.dpi} dpi`);
            } else if (gif) {
                bits.push(`${o.colors} colours`, 'transparent');
            } else {
                bits.push(`${o.mbps} Mbps`);
            }
            lines[lines.length - 1] = bits.join(' \u00b7 ');
            this._captureStatus(lines.join('\n'));
        },

        /** A job is running: nothing else may start until it is done. */
        _syncCaptureButtons() {
            if (!this._savePanel) return;
            const busy = !!this._captureBusy;
            for (const b of this._savePanel.querySelectorAll('button')) {
                b.disabled = busy;
                b.style.opacity = busy ? '0.45' : '';
            }
        },

        /**
         * EVERYTHING THE CAPTURE PANEL HAS TO SAY, in one line inside it.
         *
         * It used to talk through the page's status line: "Recording
         * rotation... 40%", then "Turn exported to ...", from a panel that had
         * closed itself when the recording started - so the feedback for an
         * action appeared somewhere else, under whatever the loader said last,
         * and on the embedded viewer there is no status line at all. One box,
         * at the foot of the panel that started the job.
         *
         * The page's status line is still written when there is no panel open
         * (the shift-click shortcut, a Python-driven save), because then it is
         * the only place there is.
         */
        _captureStatus(text, isError) {
            this._captureNote = text ? { text, error: !!isError } : null;
            const box = this._savePanel
                && this._savePanel.querySelector('[data-info]');
            if (box) {
                box.textContent = text || '';
                box.style.color = isError ? '#b91c1c' : '#6b7280';
                return;
            }
            if (typeof setStatus === 'function') setStatus(text, !!isError);
        },

        /** One place that turns a finished recording into a file on disk. */
        _deliverVideo(blob, ext, what, detail) {
            this._captureBusy = false;
            // THE PANEL IS STILL OPEN, so the view goes back to being held. The
            // record button lifts the pause to let the recorder drive its own
            // frames, and the recorders hand auto-rotate back when they finish
            // - so the structure started spinning again the moment a recording
            // ended, under a panel whose whole job is to hold it still while
            // the next take is set up.
            if (this._savePanel) this._pauseForSavePanel();
            if (!blob) {
                this._captureStatus('No video data recorded', true);
                return;
            }
            const filename = this._generateFilename(this.currentObjectName, ext);
            this._triggerDownload(blob, filename);
            const mb = (blob.size / 1048576).toFixed(1);
            this._captureStatus(`Saved ${what.toLowerCase()}: ${detail}, ${mb} MB`);
            if (this._savePanel) this._syncCaptureButtons();
        },

        saveImage(opts) {
            const o = opts || {};
            // PNG unless asked otherwise. The panel offers SVG alongside it
            // everywhere except in Draw mode, where the look is made of
            // sub-pixel pencil and translucent stains and PNG is simply what it
            // is (see the panel for the argument).
            const format = o.format || 'png';
            const dpi = Math.max(36, Math.min(1200, Number(o.dpi)
                || this.constructor.CAPTURE_DEFAULTS.dpi));

            const prevTransparent = this.isTransparent;
            this.isTransparent = true;
            const restore = () => {
                this.isTransparent = prevTransparent;
                try { this.render(); } catch (e) { /* view is cosmetic here */ }
            };

            try {
                const canvas = this.canvas;
                if (!canvas) throw new Error('Canvas not found');
                const width = this.displayWidth || parseInt(canvas.style.width) || canvas.width;
                const height = this.displayHeight || parseInt(canvas.style.height) || canvas.height;

                if (format === 'png') {
                    // CSS px are 96 dpi by definition, so the scale IS dpi/96.
                    // Clamped so a stray 4-digit dpi cannot ask for a canvas the
                    // browser refuses to allocate - which fails as a silently
                    // blank image rather than an error.
                    let k = dpi / 96;
                    const maxPx = 16000;
                    if (width * k > maxPx || height * k > maxPx) {
                        k = Math.min(maxPx / width, maxPx / height);
                    }
                    const out = document.createElement('canvas');
                    out.width = Math.max(1, Math.round(width * k));
                    out.height = Math.max(1, Math.round(height * k));
                    const octx = out.getContext('2d');
                    // Render AT the output size rather than scaling a
                    // screen-sized drawing up: the subdivision cap then sees
                    // the real resolution, which is what makes a 300 dpi export
                    // genuinely smoother rather than merely larger.
                    // _exportPxScale tells the renderers how much bigger this
                    // is than the view, so the quantities that are PIXELS by
                    // definition - outline width, selection ink, the thickness
                    // fade's screen-size test - keep the size they have on
                    // screen. Everything else is Angstroms and follows the
                    // resolution by itself.
                    this._exportPxScale = k;
                    try {
                        this._renderToContext(octx, out.width, out.height);
                    } finally {
                        this._exportPxScale = 1;
                    }
                    const objectName = this.currentObjectName;
                    out.toBlob((blob) => {
                        if (!blob) {
                            this._captureStatus('PNG export failed', true);
                            return;
                        }
                        const filename = this._generateFilename(objectName, 'png');
                        this._triggerDownload(blob, filename);
                        this._captureStatus(`Saved PNG: ${out.width}x${out.height}, `
                            + `${Math.round(k * 96)} dpi, `
                            + `${(blob.size / 1048576).toFixed(1)} MB`);
                    }, 'image/png');
                    restore();
                    return;
                }

                if (typeof C2S === 'undefined') throw new Error('canvas2svg library not loaded');
                const svgCtx = new C2S(width, height);
                this._renderToContext(svgCtx, width, height);
                const svgString = svgCtx.getSerializedSvg();
                const objectName = this.currentObjectName;

                if (format === 'svgz' && typeof CompressionStream !== 'undefined') {
                    // .svgz: the same bytes through the browser's native gzip.
                    // Async, so it downloads from the promise; errors fall back
                    // to the plain path rather than losing the export.
                    new Response(
                        new Blob([svgString]).stream()
                            .pipeThrough(new CompressionStream('gzip'))
                    ).blob().then((gz) => {
                        const filename = this._generateFilename(objectName, 'svgz');
                        this._triggerDownload(
                            new Blob([gz], { type: 'image/svg+xml' }), filename);
                        this._captureStatus(`Saved ${filename}`);
                    }).catch(() => this._downloadSvg(svgString, objectName));
                    restore();
                    return;
                }

                this._downloadSvg(svgString, objectName);
                restore();
            } catch (e) {
                restore();
                console.error('Failed to export image:', e);
                this._captureStatus(`Error exporting image: ${e.message}`, true);
            }
        },

        /** Deprecated: kept so existing callers and saved pages keep working. */
        saveAsSvg(compress) {
            this.saveImage({ format: compress ? 'svgz' : 'svg' });
        },

        /**
         * Save panel, opened by the camera button.
         *
         * Built in JS rather than as markup so the standalone HTML export - which
         * ships none of the app's CSS or panels - gets the same menu, and so
         * pages exported before this existed still work. It is inserted IN FLOW
         * under the button's row, the way the Style panel is, rather than
         * floating over the canvas: a floating layer has to be positioned and
         * repositioned against scroll and resize, and gets it wrong the first
         * time it is opened near an edge.
         *
         * The Save button copies its class list from the camera button, so it
         * inherits whatever button styling the host page uses (btn-toggle here,
         * controlButton in the standalone viewer) instead of guessing.
         */
        /**
         * Record ONE FULL TURN as a video that loops seamlessly.
         *
         * The loop is the whole point, so the frames cover [0, 360) and stop one
         * step SHORT of 360: a frame at exactly 360 degrees is the same picture
         * as the frame at 0, and playing both back-to-back stutters on every
         * repeat. With the last frame one step short, wrapping round to the
         * first continues the same constant angular step.
         *
         * Each frame is built as Ry(i * step) * R0 from the ORIGINAL matrix
         * rather than by multiplying the previous frame again, so rounding
         * cannot accumulate and leave the turn a fraction of a degree short of
         * closing - which would show up as a jump exactly once per loop.
         */
        // --- HAND-DRAWN BUILD-UP ------------------------------------------
        // Reveals the picture the way an illustrator builds one: graphite
        // under-drawing first, colour wash over it, ink line last, with the
        // pencil erased at the end. Each layer sweeps N->C along the chain, so
        // the hand follows the molecule rather than wiping across the canvas.
        //
        // The layers OVERLAP in time on purpose. Nobody finishes sketching the
        // whole page before opening the paints - the wash follows a little way
        // behind the pencil, and the pen follows the wash - and that overlap is
        // most of what makes it look like someone working rather than three
        // separate animations played in sequence.
        //
        // All of it is a gate on the normal render (see _drawAnim in
        // cartoon/geom.js): every frame is an ordinary depth-sorted drawing
        // of the part that exists so far, so occlusion stays correct and the
        // final frame is EXACTLY the normal picture, not an approximation of
        // it that happens to look close.
        // WHERE EVERY LAYER IS AT TIME t (0..1 over the run). Pulled out of the
        // animation loop because two things drive it: the live animation, off
        // requestAnimationFrame, and the video recorder, which steps t itself
        // at a fixed frame rate. Both have to produce identical pictures.
        //
        // Phase windows are [start, end] fractions of the run.
        _drawAnimAt(t) {
            // THE PENCIL GETS HALF THE RUN, in one continuous sweep - it is
            // where the drawing is made, and the colour only follows it. The
            // wash starts a beat after the pencil finishes, so the completed
            // line drawing stands on its own for a moment before the colour
            // begins to go over it.
            //
            // The paint dims the graphite under it but never removes it (see
            // the pencil pass in cartoon/geom.js), so these windows decide
            // how long any part of the picture spends as bare pencil before the
            // colour arrives, and nothing after that.
            const SKETCH = [0.00, 0.50];
            const WASH = [0.56, 0.94];
            // ...and then nothing, for the last twentieth of the run: the
            // picture is complete and STILL for a beat before the clock stops,
            // so it reads as finished rather than as cut off.
            //
            // TWO LAYERS, AND NOTHING AFTER THEM. The look this arrives at is
            // watercolour over pencil, so the run has exactly two things to do
            // and then it is done. An earlier version faded a dark outline in
            // at the end and rubbed the pencil out under it - which is how an
            // INKED illustration is made, and it threw away the thing being
            // made on the way there.
            const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1
                : u * u * (3 - 2 * u));       // smoothstep: starts and ends gently
            const span = (w) => ease((t - w[0]) / (w[1] - w[0]));
            // Where each hand has got to, as a fraction of the chain. Nothing
            // else varies over a run: how the pencil and the paint LOOK is the
            // renderer's business (cartoon/geom.js), and none of it changes
            // with time.
            return { sketch: span(SKETCH), wash: span(WASH) };
        },

        animateDrawing(opts) {
            const o = opts || {};
            const ms = Math.max(500, Math.min(60000, Number(o.duration) || 12000));
            if (this._drawAnimRaf) {          // pressed again: skip to the end
                this.stopDrawing();
                return;
            }
            if (!this._canDraw()) return;
            if (this.drawCheckbox) this.drawCheckbox.checked = true;
            // Resuming picks up where the pause left off rather than starting
            // over - the drawing on screen is the one being continued. Pressing
            // Draw while a finished painting is up replays it from blank paper,
            // since `from` defaults to 0.
            const from = Math.max(0, Math.min(1, Number(o.from) || 0));
            const clock = () => (typeof performance !== 'undefined'
                ? performance.now() : Date.now());
            const t0 = clock() - from * ms;
            const step = () => {
                const t = Math.min(1, (clock() - t0) / ms);
                this._drawT = t;
                this._drawAnim = this._drawAnimAt(t);
                this.render('animateDrawing');
                // Finished: the clock stops but the picture stays as it was
                // painted. Draw remains on - it is now what is holding the
                // watercolour on screen - so the save button also goes on
                // offering to record the run.
                if (t >= 1) {
                    if (this._drawAnimRaf) cancelAnimationFrame(this._drawAnimRaf);
                    this._drawAnimRaf = null;
                    this._drawT = 1;
                    return;
                }
                this._drawAnimRaf = requestAnimationFrame(step);
            };
            this._drawAnimRaf = requestAnimationFrame(step);
        },

        // Shared gate: the build-up is a cartoon-style thing.
        _canDraw() {
            if (this.style === 'cartoon') return true;
            const msg = 'The drawing animation needs the cartoon style.';
            if (typeof setStatus === 'function') setStatus(msg, true);
            this.drawMode = false;
            if (this.drawCheckbox) this.drawCheckbox.checked = false;
            this._syncSaveButtonMode();
            return false;
        },

        // Ends the build-up and returns to the ordinary picture. Safe to call
        // at any point - during a drag, on a style change, or from the button.
        stopDrawing() {
            if (this._drawAnimRaf) cancelAnimationFrame(this._drawAnimRaf);
            this._drawAnimRaf = null;
            if (this._drawAnim) {
                this._drawAnim = null;
                this.render('stopDrawing');
            }
        },

        // OPENING THE SAVE PANEL PAUSES WHATEVER IS RUNNING. The panel exists
        // to set up a recording of that very animation, so leaving it running
        // underneath is both distracting and pointless - and for the drawing it
        // was worse than that: a run finishing while the panel was open turned
        // the mode off, which took the panel with it. Frozen, the picture on
        // screen is also a fair preview of what is about to be recorded.
        //
        // Nothing is cancelled here. The drawing keeps its state and its
        // position in the run, so dismissing the panel carries on from where it
        // stopped, while pressing Record restarts it from blank paper.
        _pauseForSavePanel() {
            this._uiPaused = true;
            if (this._drawAnimRaf) {
                cancelAnimationFrame(this._drawAnimRaf);
                this._drawAnimRaf = null;
                this._drawPausedAt = this._drawT || 0;
            } else {
                // Nothing running - either the painting is finished or Draw is
                // off. Marked complete so dismissing the panel does not restart
                // a run from a position left over from an earlier pause.
                this._drawPausedAt = 1;
            }
        },

        _resumeFromSavePanel() {
            if (!this._uiPaused) return;
            this._uiPaused = false;
            // Only a paused-mid-run drawing needs restarting; auto-rotate picks
            // itself up again from the flag alone.
            if (this.drawMode && this._drawAnim && !this._drawRecording
                && this._drawPausedAt < 1) {
                this.animateDrawing({ from: this._drawPausedAt });
            }
        },

        // Auto-rotate goes on and off from several places - the checkbox, a
        // mouse drag, a touch drag - and each has to keep the checkbox AND the
        // save button in step, because that button records a rotation while it
        // is on. Dragging used to set the flag and the checkbox directly, which
        // left the button offering to record a rotation that had stopped.
        _setAutoRotate(on) {
            this.autoRotate = !!on;
            if (this.rotationCheckbox) this.rotationCheckbox.checked = this.autoRotate;
            this._syncSaveButtonMode();
        },

        // Draw is a MODE, like auto-rotate. It stays on after the run finishes,
        // because what it is holding on screen is the painting - the runs, the
        // off-register colour, the whole watercolour. Turning it off is what
        // takes the viewer back to its ordinary picture, and while it is on the
        // save button offers to record the run rather than save an image (see
        // _syncSaveButtonMode), so a recording is always one press away.
        setDrawMode(on) {
            this.drawMode = !!on;
            if (this.drawCheckbox) this.drawCheckbox.checked = this.drawMode;
            if (this.drawMode) {
                if (!this._canDraw()) { this.drawMode = false; return; }
                this._syncSaveButtonMode();
                this.animateDrawing();
            } else {
                this.stopDrawing();
                this._syncSaveButtonMode();
            }
        },

        // Record the build-up to a video file. Reached from the save button,
        // which reads Save Video while Draw is on - the same way auto-rotate
        // turns it into a recorder for a turn.
        //
        // Frames are stepped HERE, on a timer, rather than recorded off the
        // live animation - the same choice saveRotationVideo makes, for the
        // same two reasons. One rendered frame becomes one video frame however
        // slow a frame is to draw, so a big structure records at the same speed
        // as a small one; and setTimeout keeps running in a background tab,
        // where requestAnimationFrame stops dead and would record a still.
        //
        // The curve is _drawAnimAt, exactly as the live animation uses it, so
        // the video is the animation and not a second implementation of it.
        saveDrawingVideo(opts) {
            const o = opts || {};
            const seconds = Math.max(1, Math.min(60, Number(o.seconds) || 12));

            if (typeof MediaRecorder === 'undefined' || !this.canvas
                || !this.canvas.captureStream) {
                this._captureStatus('Video recording is not supported in this browser.', true);
                return;
            }
            if (this.isRecording || this._rotationRecording || this._drawRecording) return;
            if (!this._canDraw()) return;

            this.stopDrawing();               // no live run underneath the recording
            this._drawRecording = true;
            this.canvas.style.pointerEvents = 'none';
            // AND IT CAN TURN WHILE IT DRAWS. If auto-rotate is on, the view
            // makes exactly one revolution over the recording - driven here,
            // per frame, rather than left to auto-rotate's wall clock, for the
            // same reason the frames are: so the file does not depend on how
            // fast this machine happens to render.
            const R0 = this.viewerState.rotation.map((row) => [...row]);
            // ASKED FOR, NOT INFERRED. The panel offers Draw and Draw+Rotate as
            // separate things to record; before that this read whatever
            // auto-rotate happened to be, so which of the two you got was a
            // side effect of a switch somewhere else on the page.
            const turning = (o.spin === undefined) ? !!this.autoRotate : !!o.spin;
            this.autoRotate = false;
            this._drawR0 = R0;
            this._drawWasAuto = turning;

            // the shared sink: format, size and bitrate come from the panel
            const sink = this._makeVideoSink(o);
            if (!sink) {
                this._endDrawingVideo(null);
                this._captureStatus('Failed to start recording.', true);
                return;
            }
            const fps = sink.fps;                 // clamped for GIF - see the turn
            const N = (o.container === 'zip')
                ? Math.max(2, Math.min(600, Number(o.frames) || 36))
                : Math.max(2, Math.round(seconds * fps));
            // A beat of the finished picture at the end, so the file does not
            // stop on the frame the last change landed in.
            const TAIL = Math.round(fps * 0.6);

            let i = 0;
            const tick = () => {
                if (i > N + TAIL) {
                    sink.finish((blob, ext) => {
                        this._endDrawingVideo(null);
                        this._deliverVideo(blob, ext, 'Drawing',
                            `${N + TAIL} frames, ${seconds}s at ${fps}fps, `
                            + `${sink.width}x${sink.height}${sink.note}`);
                    });
                    return;
                }
                // Past N the run is over; the tail frames hold the finished
                // painting, which is where the animation ends on screen too.
                this._drawAnim = this._drawAnimAt(Math.min(1, i / N));
                if (turning) {
                    this.viewerState.rotation = multiplyMatrices(
                        rotationMatrixY((2 * Math.PI * i) / N), R0);
                }
                sink.frame();          // renders, at the size being recorded
                if (i % fps === 0) {
                    this._captureStatus(
                        `Recording drawing... ${Math.round((100 * i) / (N + TAIL))}%`);
                }
                i++;
                this._drawTimer = setTimeout(tick, 1000 / fps);
            };
            tick();
        },

        _endDrawingVideo(stream) {
            // whatever happened, the panel is free again
            this._captureBusy = false;
            if (this._savePanel) this._syncCaptureButtons();
            if (this._drawTimer) { clearTimeout(this._drawTimer); this._drawTimer = null; }
            this._drawRecording = false;
            // Leave the finished painting up, exactly as a live run does.
            this._drawAnim = this.drawMode ? this._drawAnimAt(1) : null;
            this._drawT = 1;
            if (this._drawR0) {
                this.viewerState.rotation = this._drawR0;
                this._drawR0 = null;
            }
            if (this._drawWasAuto) { this.autoRotate = true; this._drawWasAuto = false; }
            if (this.canvas) this.canvas.style.pointerEvents = '';
            if (stream) {
                try { stream.getTracks().forEach((tr) => tr.stop()); } catch (e) { /* gone */ }
            }
            this.render('drawingVideoEnd');
        },

        saveRotationVideo(opts) {
            const o = opts || {};
            const seconds = Math.max(1, Math.min(60, Number(o.seconds) || 6));

            if (typeof MediaRecorder === 'undefined' || !this.canvas || !this.canvas.captureStream) {
                this._captureStatus('Video recording is not supported in this browser.', true);
                return;
            }
            if (this.isRecording || this._rotationRecording) return;

            const R0 = this.viewerState.rotation.map((row) => [...row]);
            const wasAuto = this.autoRotate;
            // Drive the turn ourselves: auto-rotate advances by wall clock, which
            // would make the number of degrees per recorded frame depend on how
            // fast the machine happens to render.
            this.autoRotate = false;
            this._rotationRecording = true;
            this.canvas.style.pointerEvents = 'none';

            // FORMAT, SIZE AND BITRATE ARE THE PANEL'S, not this recorder's:
            // see _makeVideoSink, which all three recorders share.
            const sink = this._makeVideoSink(o);
            if (!sink) {
                this._endRotationVideo(R0, wasAuto, null);
                this._captureStatus('Failed to start recording.', true);
                return;
            }
            // FRAMES FROM THE SINK'S fps, NOT THE PANEL'S. A GIF is clamped to
            // 20 - its delays are whole centiseconds - and counting frames at
            // the asked-for 30 would then stretch one turn into one and a half.
            const fps = sink.fps;
            // A ZIP OF IMAGES IS COUNTED, NOT TIMED: its own control says how
            // many PNGs a turn should come to.
            const N = (o.container === 'zip')
                ? Math.max(2, Math.min(600, Number(o.frames) || 36))
                : Math.max(2, Math.round(seconds * fps));

            // HOW MANY TURNS, over however many frames this recording has.
            const turns = Math.max(1, Math.min(10, Number(o.rotations) || 1));
            const step = (2 * Math.PI * turns) / N;
            // ...AND THE TRAJECTORY, FITTED INTO IT. RF says "turn for this
            // long and play the frames inside that": a trajectory longer than
            // the recording is sampled, a shorter one holds each frame for
            // several video frames. The frame is loaded WITHOUT rendering -
            // the sink renders, once, at the size it is recording.
            const object = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            const nFrames = (o.playFrames && object && object.frames)
                ? object.frames.length : 0;
            let i = 0;
            const tick = () => {
                if (nFrames > 1) {
                    const at = Math.min(nFrames - 1, Math.floor((i * nFrames) / N));
                    if (at !== this.currentFrame) {
                        this.currentFrame = at;
                        this._loadFrameForPlayback(at);
                        this.lastRenderedFrame = at;
                    }
                }
                if (i >= N) {
                    sink.finish((blob, ext) => {
                        this._endRotationVideo(R0, wasAuto, null);
                        this._deliverVideo(blob, ext, 'Turn',
                            `${N} frames, ${seconds}s at ${sink.fps}fps, `
                            + `${turns} turn${turns === 1 ? '' : 's'}`
                            + (nFrames > 1 ? `, ${nFrames} model frames` : '')
                            + `, ${sink.width}x${sink.height}${sink.note}`
                            + ', loops seamlessly');
                    });
                    return;
                }
                this.viewerState.rotation = multiplyMatrices(rotationMatrixY(i * step), R0);
                sink.frame();          // renders, at the size being recorded
                if (i % sink.fps === 0) {
                    this._captureStatus(`Recording turn... ${Math.round((100 * i) / N)}%`);
                }
                i++;
                // setTimeout rather than requestAnimationFrame: the pacing has to
                // hold even when the tab is not the foreground one, and rAF is
                // throttled to a stop there.
                this._rotationTimer = setTimeout(tick, 1000 / fps);
            };
            tick();
        },

        _endRotationVideo(R0, wasAuto, stream) {
            // whatever happened, the panel is free again
            this._captureBusy = false;
            if (this._savePanel) this._syncCaptureButtons();
            if (this._rotationTimer) { clearTimeout(this._rotationTimer); this._rotationTimer = null; }
            this._rotationRecording = false;
            if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ } }
            if (this.canvas) this.canvas.style.pointerEvents = '';
            // put the view back exactly where it was, and hand rotation back
            if (R0) this.viewerState.rotation = R0.map((row) => [...row]);
            this.autoRotate = wasAuto;
            if (this.rotationCheckbox) this.rotationCheckbox.checked = wasAuto;
            this.render();
        },

        /** Keeps the camera button's label and icon fixed as the mode changes. */
        _syncSaveButtonMode() {
            const b = this.saveImageButton;
            if (!b) return;
            // ONE CONTROL, ONE NAME. It used to relabel itself "Save Video"
            // whenever Rotate or Draw was on, and swap its icon - so the same
            // button in the same place meant different things depending on
            // state, next to a record button that meant a third thing. What is
            // offered is decided INSIDE the panel, where the options are
            // visible and can be read; the button is just the way in.
            const video = !!this.autoRotate || !!this.drawMode;
            const span = b.querySelector('span');
            const icon = b.querySelector('i');
            if (icon) {
                icon.classList.add('fa-camera');
                icon.classList.remove('fa-video');
            }
            if (span) {
                let replaced = false;
                span.childNodes.forEach((n) => {
                    if (n.nodeType === 3 && n.textContent.trim()) { n.textContent = 'Capture'; replaced = true; }
                });
                if (!replaced) span.appendChild(document.createTextNode('Capture'));
            }
            // CAPTURE, not Save: the toolbar already has a Save, which writes
            // the session file. Two buttons reading "Save" a few centimetres
            // apart is a coin toss over which one keeps your work.
            b.title = 'Capture an image or a video (shift-click saves a PNG straight away)';
            // A MODE CHANGE CHANGES WHAT CAN BE RECORDED, so the open panel is
            // rebuilt rather than thrown away. Switching Rotate on with Capture
            // already open used to close the panel: the user had turned on the
            // very thing they wanted to record and the panel vanished, so they
            // had to open it again to find the button that had just appeared.
            if (this._savePanel && !this._captureBusy) this._rebuildSavePanel();
        },



        // Generate filename from object name and current timestamp
        _generateFilename(objectName, extension) {
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            let name = objectName || 'viewer';
            name = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
            return `py2dmol_${name}_${timestamp}.${extension}`;
        },

        // Download SVG directly

        _downloadSvg(svgString, objectName) {
            const filename = this._generateFilename(objectName, 'svg');
            const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            this._triggerDownload(blob, filename);
            this._captureStatus(`Saved ${filename}`);
        },

        // Helper to trigger browser download
        _triggerDownload(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },
    },
    statics: {
        get CAPTURE_DEFAULTS() {
            return { format: 'png', dpi: 200,
                seconds: 6, fps: 30, mbps: 12, container: 'webm', scale: 1,
                rotations: 1 };
        },
        get GIF_LIMITS() { return { maxPx: 1024, maxFps: 20, maxFrames: 300 }; },
    },
});
})();