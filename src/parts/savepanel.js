// ============================================================================
// src/parts/savepanel.js
// ------------------------------------
// AI Context: THE CAPTURE PANEL (a part of Pseudo3DRenderer)
// - The Save panel's DOM: two blocks - a still and a video - and a line that
//   says what they will make. Built FRESH on every open, because everything it
//   shows is read off the viewer at that moment: which sources can be recorded,
//   how big the canvas is, what the browser will encode.
// - Pure UI. Nothing here decides what a capture IS; that is parts/capture.js.
// - _buildSavePanel alone is 689 lines, which is the next thing to break up.
// ============================================================================
(function () {
'use strict';
(window.py2dmolMolParts = window.py2dmolMolParts || []).push({
    name: 'savepanel',
    proto: {
        /**
         * THE CAPTURE PANEL: two blocks and a line that says what they will
         * make. A grid of name, settings, button:
         *
         *   Img  Type[PNG] DPI[200]                          [Save]
         *   ------------------------------------------------------
         *   Vid  Type[WebM] Rec[FR]                           [ ● ]
         *        Sec[6] FPS[30] Rot[1] Mbps[12] Size[1]
         *   ------------------------------------------------------
         *   PNG 1246x1246 - 200 dpi
         *   WebM 598x598 - 20 frames - 2s at 10 fps - 1 turn - 12 Mbps
         *
         * WHAT CHANGED AND WHY. It used to be one row per OUTPUT, each ending
         * in its own button and each carrying its own copy of the settings - so
         * the frame rate for a turn and the frame rate for a drawing were
         * different controls holding the same number, the trajectory row had no
         * settings at all (30 fps and 20 Mbps, decided in the recorder and
         * shown nowhere), and nothing anywhere said what resolution any of it
         * came out at.
         *
         * WHAT IS OFFERED IS WHAT CAN BE MADE. Formats are asked of the browser
         * and of the page (videoFormats), sizes of the canvas (videoSizes), and
         * a source appears only where there is something to record: a turn
         * needs Rotate, a drawing needs Draw, frames need a trajectory. With
         * none of them there is no video row at all.
         *
         * WHICH CONTROLS SHOW follows from one question - who decides how long
         * the recording is (see the sources) - and from the format. See
         * syncVideo; the info line describes the answer rather than repeating
         * the boxes.
         */
        _toggleSaveImagePanel(anchorEl) {
            // OPEN MEANS BUILT, FRESH. The panel used to be built once and then
            // shown and hidden, so everything it reads off the viewer - which
            // sources can be recorded, how big the canvas is, whether the
            // object has frames - was whatever was true the first time it was
            // opened. Loading a trajectory with the panel already made left it
            // with no Frames button until the mode happened to change and threw
            // it away. It is a dozen elements; building it is free.
            if (this._savePanel) {
                this._savePanel.remove();
                this._savePanel = null;
                if (anchorEl) anchorEl.setAttribute('aria-expanded', 'false');
                this._resumeFromSavePanel();
                return;
            }
            this._saveAnchor = anchorEl || this._saveAnchor;
            this._buildSavePanel(this._saveAnchor);
        },

        /**
         * Same panel, same options, current numbers - see
         * _updateCanvasDimensions.
         *
         * @param {boolean} fresh - drop whatever the line was saying. A resize
         *        changes every size in it, so a result from before the resize
         *        ("Saved ... 3738x3738") is describing a file made at a size
         *        the panel no longer offers.
         */
        _rebuildSavePanel(fresh) {
            if (!this._savePanel) return;
            // A RESULT SURVIVES THE REBUILD, A DESCRIPTION DOES NOT. "Saved
            // turn: ... 0.1 MB" is news and has to stay; "WebM 598x598" is a
            // description of settings against a canvas that has just changed
            // size, and restoring it would put the old numbers back over the
            // new ones the rebuild exists to produce.
            const note = fresh ? null : this._captureNote;
            const keep = note && !/^(WebM|MP4|GIF|PNG|SVG|Images)\b.*\u00b7/.test(note.text);
            this._savePanel.remove();
            this._savePanel = null;
            this._buildSavePanel(this._saveAnchor);
            if (keep) this._captureStatus(note.text, note.error);
        },

        _buildSavePanel(anchorEl) {
            const obj = this.currentObjectName
                ? this.objectsData[this.currentObjectName] : null;
            // WHAT THERE IS TO RECORD, INCLUDING THE COMBINATIONS. A
            // trajectory can play while the view turns, and a drawing can build
            // up while it turns - the recorders could always do both, but the
            // panel had one button per source and no way to say "both", so the
            // combination depended on whether Rotate happened to be on when you
            // pressed Frames. It is a choice now, and pressing record cannot
            // mean two things.
            // FOUR WAYS TO PUT A TRAJECTORY AND A TURN IN ONE FILE, and the
            // difference between them is WHO DECIDES HOW LONG IT IS:
            //
            //   F    the frames, played once, not turning. The trajectory
            //        decides: N frames at the chosen rate.
            //   R    a turn on the spot. You decide, in seconds.
            //   FR   frames-led. Every frame is played, once, and the rotation
            //        is fitted into however long that takes.
            //   RF   rotation-led. The turn runs for the seconds you asked for
            //        and the whole trajectory is fitted into it - so a long
            //        trajectory is sampled and a short one holds frames.
            //
            // Which controls are worth showing follows straight from that
            // column: Sec means something only where YOU set the length, so it
            // is offered for R and RF and derived for the other two.
            const spin = !!this.autoRotate;
            const hasFrames = !!(obj && obj.frames && obj.frames.length > 1);
            const sources = [];
            if (hasFrames) {
                sources.push({ id: 'F', label: 'F', spin: false, timed: false,
                    title: 'frames once' });
            }
            if (hasFrames && spin) {
                sources.push({ id: 'FR', label: 'FR', spin: true, timed: false,
                    title: 'frames once, turning' });
                sources.push({ id: 'RF', label: 'RF', spin: true, timed: true,
                    title: 'timed turn, frames fitted in' });
            }
            if (this.drawMode) {
                sources.push({ id: 'D', label: 'D', spin: false, timed: true,
                    title: 'the drawing' });
            }
            if (this.drawMode && spin) {
                sources.push({ id: 'DR', label: 'DR', spin: true, timed: true,
                    title: 'the drawing, turning' });
            }
            if (spin) {
                sources.push({ id: 'R', label: 'R', spin: true, timed: true,
                    title: 'a turn' });
            }
            // A running animation is paused while the panel is up, so what is
            // saved is the frame that was on screen when it was opened.
            if (sources.length) this._pauseForSavePanel();
            const opts = this.captureOpts();
            const formats = this.videoFormats();
            const sizes = this.videoSizes();

            // SVG is offered on the plain panel but never with a drawing up. A
            // vector file of a normal cartoon is the better artifact; a vector
            // file of the drawing is not, since that look is a pencil line a
            // fraction of a pixel wide, paint sitting off register and
            // translucent stains.
            //
            // ...AND NEVER WITHOUT THE 2D PAINTER. A vector file is drawn by
            // replaying the primitives into an SVG context, and the GPU refuses
            // an export context by design - it has a raster and nothing to hand
            // back. The notebook and embed bundles ship cartoon/paintgl.js
            // alone, so there the option would produce an empty file; the
            // website ships both painters and keeps it. The tube style is drawn
            // by _drawFrame in core/mol.js and needs no cartoon painter at all.
            const canVector = this.style !== 'cartoon'
                || typeof window.py2dmolCartoonPaint === 'function';
            const svgOk = !this.drawMode && canVector;

            // WRAPS. The embedded viewer's panel is 180px wide and the
            // standalone page's column is wider; a row that wraps fits both,
            // where a fixed layout has to pick one and hang out of the other.
            // ONE ROW PER SUBJECT, WRAPPING FREELY. The embedded viewer's
            // panel is 180px wide and the standalone page's column is three
            // times that: a row that wraps fits both, and the controls simply
            // take a second line where they have to. What must NOT be here is
            // anything that forces a break - a spacer with flex-grow pushed the
            // camera button to the right edge, which in the narrow panel meant
            // a line of its own with nothing on it.
            // THE SETTINGS AREA IS A GRID TOO, of equal cells. As a wrapping
            // flex line the pairs packed edge to edge at whatever width each
            // happened to be, so nothing lined up with anything above it and a
            // row of six controls read as a paragraph. Equal cells put every
            // field in a column.
            const ROW = 'display:grid; align-items:center; gap:6px;'
                + ' grid-template-columns:repeat(auto-fill, minmax(84px, 1fr));'
                + ' min-width:0;';
            // THE PAGE'S OWN BUTTON, WHERE THE PAGE HAS ONE.
            //
            // These were styled inline because the two pages skin their
            // buttons differently and one class renders invisible on the
            // other - but that left Save and Turn as the only controls in the
            // viewer that do not look like the buttons beside them, which is
            // exactly what a button should not do. So the skin is LOOKED UP:
            // index.html has .btn.btn-grey.btn-small, the notebook viewer has
            // .controlButton. A page with neither keeps the inline style.
            const skin = ['btn btn-grey btn-small', 'controlButton'].find((c) => {
                try {
                    return !!document.querySelector('.' + c.trim().split(/\s+/).join('.'));
                } catch (e) { return false; }
            }) || '';

            // ONE SIZE FOR EVERY CONTROL, AND THE PAGE DECIDES WHAT IT IS.
            //
            // This was a hardcoded 28, under a note saying that both pages'
            // buttons were 28 too - which was true when it was written and
            // stopped being true the moment the notebook's buttons went to 24.
            // A number copied from somewhere else is a number that goes stale
            // silently: the Capture panel's selects stood 4px taller than the
            // Style panel's, in a column 180px wide where that reads as two
            // different kinds of control.
            //
            // So it is MEASURED off the skin found above, which is the same
            // lookup the buttons already use. 28 remains the answer for a page
            // with no CSS at all - the standalone HTML export ships none, and
            // every control in it is inline-styled for exactly that reason.
            // MEASURED OFF THE ANCHOR, which is the Capture button this panel
            // is opening from and is therefore visible by definition. Querying
            // for the skin class instead finds #playButton first, and that is
            // display:none whenever the object has one frame - a measured
            // height of zero, which the guard below caught and turned back into
            // the stale 28 it was meant to replace.
            const H = (() => {
                const h = anchorEl ? Math.round(anchorEl.getBoundingClientRect().height) : 0;
                return (h >= 16 && h <= 48) ? h : 28;
            })();
            // BOX-SIZING, or a field told to fill its cell overflows it by its
            // own padding and border: 100% plus 12px of padding and 2px of
            // frame stuck 14px out of a 160px panel.
            const FIELD = `height:${H}px; font-size:12px; padding:0 4px;`
                + ' border:1px solid #d1d5db; border-radius:6px; background:#fff;'
                + ' box-sizing:border-box; flex:0 1 auto; min-width:0; max-width:100%;';
            const NUM = FIELD + ' width:52px; padding:0 6px;';
            const CAP = 'font-size:12px; color:#6b7280; flex:0 0 auto;';
            // SHORT NAMES, because the column costs the same on every row and
            // the settings beside them are what needs the width: "Image" and
            // "Video" spent 18px of a 160px panel saying what "Img" and "Vid"
            // say.
            const NAME = 'font-size:12px; font-weight:600; color:#374151;'
                + ' flex:0 0 auto; min-width:28px;';
            const BTN = `flex:0 0 auto; padding:0 8px; height:${H}px; line-height:1;`
                + ' cursor:pointer; font-size:12px; border:1px solid #d1d5db;'
                + ' border-radius:6px; background:#fff; box-sizing:border-box;';
            const button = (text, title) => {
                // Only the layout is ours when the page has a skin: its height,
                // padding, border and hover are the page's business, and
                // repeating them here is how two buttons come to disagree.
                const b = el('button',
                    (skin ? 'min-width:0;' : BTN) + ' width:100%; box-sizing:border-box;', text);
                b.type = 'button';
                if (skin) b.className = skin;
                if (title) b.title = title;
                return b;
            };

            const p = document.createElement('div');
            p.id = 'savePanel';
            // A GRID, THREE COLUMNS: what the row is, what it is set to, and
            // the button that does it. Everything used to be one wrapping line
            // per row, so the button sat wherever the settings left it - at the
            // end of the line, halfway along, or on a line of its own - and
            // the two rows lined up with each other only by accident. The
            // action column is fixed at the right, so Save and the record dot
            // are always in the same place, on top of each other, whatever is
            // showing between.
            // THE SAME RHYTHM AS EVERYTHING ELSE IN THE COLUMN. This box had
            // its own numbers - 8px of padding against the style panel's 5, a
            // 6px top margin on top of the container's own 3px gap, and 6px
            // between rows against 3 - so it read as a different piece of
            // furniture sitting in the same drawer. Inline, because this panel
            // has to survive a page with no CSS at all (the standalone HTML
            // export ships none), so the numbers are repeated here rather than
            // inherited - but they are the same numbers.
            //
            // No top margin: the container spaces its children with a gap, and
            // a margin on top of that is the gap counted twice. Where there is
            // no gap the panel simply sits against the button that opened it,
            // which is what "expands in place" means.
            p.style.cssText = 'display:grid;'
                + ' grid-template-columns:auto minmax(0,1fr) auto;'
                + ' gap:3px 6px; align-items:center;'
                + ' box-sizing:border-box; max-width:100%;'
                + ' border:1px solid #e5e7eb; border-radius:8px; background:#fff;'
                + ' padding:5px;';

            const el = (tag, css, text) => {
                const n = document.createElement(tag);
                if (css) n.style.cssText = css;
                if (text !== undefined) n.textContent = text;
                return n;
            };
            // HOW WIDE THE PANEL WILL BE, before it is in the page. Three
            // columns fit the standalone page's 300px column and do not fit
            // the embedded viewer's 160px one - name and button take 94 of it
            // between them and leave the settings 40px, which is narrower than
            // one field. So a narrow panel puts the name and the button on one
            // line and the settings across the whole width underneath.
            // ...AND WHICH OF THE TWO SHAPES IT TAKES IS MEASURED, not guessed.
            // Three columns fit the standalone page's 300px column and do not
            // fit the embedded viewer's 160px one: name and button take 94 of
            // it between them and leave the settings 40px, narrower than one
            // field. So the rows are BUILT first and PLACED after the panel is
            // in the page and its width is a fact - three across where there is
            // room, and name-and-button over settings where there is not.
            const blocks = [];

            const row = (name) => {
                const nameEl = el('span', NAME, name);
                const controls = el('div', ROW);
                // ONE WIDTH FOR BOTH BUTTONS. Save is a word and the record
                // button is a dot, so left to themselves they were 45px and
                // 28px in a column of their own - two different buttons in the
                // same place, one above the other, not lining up with each
                // other. The column stretches them to its width, which is the
                // wider of the two.
                const action = el('div', 'display:grid; gap:6px; align-items:center;'
                    + ' justify-items:stretch;');
                blocks.push({ kind: 'row', nameEl, controls, action });
                // `appendChild` on the row still means "another control", which
                // is what every caller wants; the button column is asked for
                // by name.
                controls.action = action;
                controls.nameEl = nameEl;
                return controls;
            };
            const menu = (id, items, value, tip) => {
                const sel = el('select', FIELD);
                sel.id = id;
                if (tip) sel.title = tip;
                for (const it of items) {
                    const o = document.createElement('option');
                    o.value = String(it.value);
                    o.textContent = it.label;
                    sel.appendChild(o);
                }
                sel.value = String(value);
                return sel;
            };
            // A LABEL AND ITS FIELD ARE ONE THING. The row wraps - it has to,
            // in a 160px panel - and a bare label followed by a bare input is
            // two wrappable items, so a line break landed between them and left
            // "FPS" hanging at the end of one line with its box at the start of
            // the next. Each pair goes in a nowrap group, which wraps whole.
            // SHOWING A PAIR PUTS ITS GRID BACK. `style.display = ''` removes
            // the inline declaration - and the inline declaration is where
            // `display:grid` lives, so hiding a pair and showing it again left
            // it a plain block: the label and the field became inline
            // siblings, the field kept its width:100%, and it hung its own
            // label's width out of the panel. That is the 10-19px of overflow
            // in a 160px panel, and it appeared only after a format change.
            const show = (node, on) => {
                if (node) node.style.display = on ? 'grid' : 'none';
            };
            const pair = (labelText, forId, control, tip) => {
                const g = el('span', 'display:grid; align-items:center; gap:5px;'
                    + ' grid-template-columns:34px minmax(0,1fr);'
                    + ' min-width:0; white-space:nowrap;');
                if (labelText) {
                    const lab = el('label', CAP, labelText);
                    lab.setAttribute('for', forId);
                    if (tip) lab.title = tip;
                    g.appendChild(lab);
                } else {
                    g.style.gridTemplateColumns = 'minmax(0,1fr)';
                }
                control.style.width = '100%';
                g.appendChild(control);
                return g;
            };
            const num = (id, label, value, min, max, tip) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.id = id; inp.min = min; inp.max = max;
                inp.step = '1'; inp.value = value;
                if (tip) inp.title = tip;
                return [pair(label, id, inp, tip), inp];
            };

            // ---- IMAGE -------------------------------------------------
            // Declared with the row it belongs to: this is used while the row
            // is built, and a `let` further down the function is a temporal
            // dead zone - the panel threw before it appeared at all.
            let dpiBox = null;
            const imgRow = row('Img');
            // PNG AND SVG. The gzipped SVG went from the menu: it is the same
            // file through a compressor, every tool that opens an .svgz opens
            // an .svg, and it was a third of the width of the widest control on
            // the row for a choice nobody has to make. saveImage still writes
            // one if it is asked for by name.
            const fmtSel = menu('saveFormatSelect', svgOk
                ? [{ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG' }]
                : [{ value: 'png', label: 'PNG' }],
            (svgOk && opts.format !== 'svgz') ? opts.format : 'png', 'Image format');
            // EVERY CONTROL SAYS WHAT IT IS. A bare menu reading "PNG" is
            // only obvious while you already know what the row does, and a
            // captioned pair is also the same SHAPE as every other pair, which
            // is what makes the columns line up.
            imgRow.appendChild(pair('Type', 'saveFormatSelect', fmtSel));
            // DPI AS A LIST, not a spinner. The useful values are a short list
            // - screen, a figure, a plate - and typing 250 into a spinner is a
            // decision nobody has a reason to make. 200 is the default: a
            // 1000px canvas comes out about 2000px, which is a figure at column
            // width in print.
            const dpiSel = menu('saveDpiInput', [
                { value: 96, label: '96' }, { value: 150, label: '150' },
                { value: 200, label: '200' }, { value: 300, label: '300' },
                { value: 600, label: '600' },
            ], opts.dpi, 'Image resolution (96 = screen)');
            dpiBox = pair('DPI', 'saveDpiInput', dpiSel);
            imgRow.appendChild(dpiBox);
            // A WORD, NOT A GLYPH. The camera and the card-index emoji were
            // small, low-contrast and rendered differently on every platform -
            // and being the only pictures in a panel of words, they read as
            // decoration rather than as the buttons that do the thing.
            const okBtn = button('Save', 'Save an image');
            imgRow.action.appendChild(okBtn);
            // EVERY FRAME AS FILES IS A VIDEO FORMAT, not a button here - see
            // videoFormats. It writes the same frames the recorders drive, so
            // it belongs where the other formats are, and it records a turn or
            // a drawing as well as a trajectory now.

            const syncImg = () => {
                show(dpiBox, fmtSel.value === 'png');
                this._describeCapture();
            };
            fmtSel.addEventListener('change', syncImg);
            dpiSel.addEventListener('change', syncImg);
            syncImg();
            // ...and the dpi is the Images format's size, so the video line
            // has to follow it as well
            dpiSel.addEventListener('change', () => { if (vFmt) commit(); });

            // ---- VIDEO -------------------------------------------------
            // A LINE BETWEEN THE TWO. They are different outputs with different
            // buttons, and stacked without a break the panel read as one list
            // of controls where the Image row's dpi looked like it might apply
            // to the recording underneath it.
            const rule = () => {
                const hr = el('div', 'height:1px; background:#e5e7eb; margin:1px 0;');
                blocks.push({ kind: 'span', el: hr });
            };
            let vFmt = null; let secIn = null; let fpsIn = null;
            let mbpsIn = null; let sizeSel = null; let colorsSel = null;
            let framesIn = null; let colorsBox = null; let sizeBox = null;
            let bgSel = null; let bgBox = null;
            let srcSel = null; let rotIn = null;
            let vFmtBox = null; let srcBox = null;
            // ...assigned with the video row, called from the record row too:
            // what the count control means depends on WHICH source is picked.
            let syncVideo = () => {};
            let videoRow = null;
            if (sources.length && formats.length) {
                rule();
                const vRow = row('Vid');
                videoRow = vRow;
                vFmt = menu('saveVideoFormat', formats.map((f) => (
                    { value: f.id, label: f.label })), opts.container, 'Video format');
                vFmtBox = pair('Type', 'saveVideoFormat', vFmt);
                vRow.appendChild(vFmtBox);
                const [secL, sec] = num('saveSecondsInput', 'Sec', opts.seconds, 1, 60,
                    'Length in seconds');
                vRow.appendChild(secL); secIn = sec;
                const [fpsL, fps] = num('saveFpsInput', 'FPS', opts.fps, 5, 60,
                    'Frames per second');
                vRow.appendChild(fpsL); fpsIn = fps;
                // IMAGES ARE COUNTED, NOT TIMED. A zip of PNGs has no duration
                // and no frame rate - what you want to say is how many of them
                // - so Sec and FPS give way to one number. On the trajectory
                // source even that is decided for you: one PNG per frame.
                const [frL, fr] = num('saveFrameCount', 'Count', opts.frames || 36,
                    2, 600, 'How many images');
                vRow.appendChild(frL); framesIn = fr;
                // HOW MANY TURNS. One is the usual answer, but a trajectory
                // fitted into a single revolution can be too slow to read - two
                // or three turns over the same frames give the eye a second
                // look at every angle.
                const [rotL, rot] = num('saveRotations', 'Rot', opts.rotations || 1,
                    1, 10, 'Full turns');
                vRow.appendChild(rotL); rotIn = rot;
                const [mbL, mb] = num('saveMbpsInput', 'Mbps', opts.mbps, 1, 80,
                    'Bitrate ceiling');
                vRow.appendChild(mbL); mbpsIn = mb;
                // GIF'S OWN CONTROLS, and only where GIF can be written at
                // all: on the notebook page there is no encoder, so these are
                // not hidden controls, they are absent ones.
                // A GIF is a palette, not a bitrate: the size of the file is
                // decided by how many colours it is allowed and how many
                // pixels, so those are the two things to offer - and Mbps,
                // which means nothing here, goes away rather than sitting
                // greyed out pretending to be part of the format.
                const gifOk = formats.some((f) => f.id === 'gif');
                if (gifOk) {
                // ...NAMED LIKE THE REST OF THE ROW. Sec, FPS, Mbps and Size
                // all say what they are in front of the value; "256 col"
                // repeated the unit inside every option instead, which is the
                // only control on the row that spelled itself out four times.
                colorsSel = menu('saveGifColors', [
                    { value: 256, label: '256' },
                    { value: 128, label: '128' },
                    { value: 64, label: '64' },
                    { value: 32, label: '32' },
                ], opts.colors || 256, 'GIF palette size');
                colorsBox = pair('Color', 'saveGifColors', colorsSel);
                vRow.appendChild(colorsBox);
                // ...AND WHETHER THE PAPER COMES WITH IT. A GIF's transparency
                // is one palette entry, so the edge is a hard cut - right over
                // a slide or a dark page, wrong over a busy one, where a matte
                // that matches the background reads better than a fringe. A
                // menu rather than a checkbox so it sits in the row like Sec,
                // FPS and Color, which all say what they are in front of a
                // value.
                bgSel = menu('saveGifBg', [
                    { value: 1, label: 'clear' },
                    { value: 0, label: 'paper' },
                ], opts.transparent === false ? 0 : 1,
                'Cut the GIF out, or matte it onto the background colour');
                bgBox = pair('Bg', 'saveGifBg', bgSel);
                vRow.appendChild(bgBox);
                }
                if (sizes.length) {
                    // ...WITH ITS NAME IN FRONT OF IT, like Sec and FPS. "1x"
                    // on its own is a multiplier of nothing stated.
                    sizeSel = menu('saveVideoSize', sizes.map((z) => (
                        { value: z.scale, label: z.label })), opts.scale,
                    'Recording size');
                    sizeBox = pair('Size', 'saveVideoSize', sizeSel);
                    vRow.appendChild(sizeBox);
                }
                syncVideo = () => {
                    const gif = vFmt.value === 'gif';
                    const zip = vFmt.value === 'zip';
                    const LIM = this.constructor.GIF_LIMITS;
                    // IMAGES TAKE THEIR SIZE FROM THE DPI ABOVE, so the Size
                    // menu goes: two controls for one resolution is how they
                    // come to disagree. There is no bitrate in a PNG either.
                    show(sizeBox, !zip);
                    // ONE ROW, TWO FORMATS, and only the controls that mean
                    // something for the one that is picked. What is shared -
                    // how long, how fast, how big - stays put, so switching
                    // format does not move the rest of the row about.
                    show(mbL, !(gif || zip));
                    // ...and the frame rate is the one control every source
                    // needs: it is how fast the file plays, whoever decided how
                    // many frames there are. Images have no rate at all.
                    show(fpsL, !zip);
                    // THE COUNT IS FOR A TURN OR A DRAWING, which have no
                    // frames of their own to follow - it says how many PNGs to
                    // write over one revolution. A trajectory HAS frames, and
                    // then the answer is one image per frame and there is
                    // nothing to ask. Reading it off the picked source rather
                    // than off the list is the difference between "Frames: 36"
                    // sitting beside a Frames recording, saying something that
                    // is not true of it, and not being there at all.
                    const pickedId = srcSel ? srcSel.value : (sources[0] || {}).id;
                    const src = sources.find((x) => x.id === pickedId) || sources[0] || {};
                    // SEC IS ONLY A CONTROL WHERE YOU SET THE LENGTH. On F and
                    // FR the trajectory does: the file is N frames long at the
                    // rate you chose, and a seconds box there would be a number
                    // that either does nothing or silently drops frames.
                    const timed = !!src.timed;
                    show(secL, timed && !zip);
                    // ...and a rotation count only where something rotates
                    const turns = !!src.spin;
                    show(rotL, turns);
                    // THE IMAGE COUNT is for a recording with no frames of its
                    // own to follow - a turn or a drawing. A trajectory has
                    // them, and then the answer is one image per frame.
                    const counted = zip && (pickedId === 'R' || pickedId === 'D'
                        || pickedId === 'DR');
                    show(frL, counted);
                    show(colorsBox, gif);
                    // ...only for the format that has the choice: WebM and MP4
                    // cannot be transparent and a zip of PNGs always is.
                    show(bgBox, gif);
                    // A GIF'S LIMITS ARE APPLIED TO THE CONTROLS, not just to
                    // the recording. The sink clamps either way, but a panel
                    // reading 30 fps and 1194x1194 over a file that came out
                    // 20 fps and 1024 wide is the panel lying about what it is
                    // about to make. Whole-centisecond delays are what cap the
                    // rate; memory is what caps the size, since every frame is
                    // held until the palette is known.
                    fpsIn.max = gif ? LIM.maxFps : 60;
                    if (gif && Number(fpsIn.value) > LIM.maxFps) fpsIn.value = LIM.maxFps;
                    if (sizeSel) {
                        let fallback = null;
                        for (const opt of sizeSel.options) {
                            const z = sizes.find((q) => String(q.scale) === opt.value);
                            const tooBig = gif && z && Math.max(z.w, z.h) > LIM.maxPx;
                            opt.disabled = !!tooBig;
                            if (!tooBig) fallback = opt.value;
                        }
                        const cur = sizeSel.selectedOptions[0];
                        if (cur && cur.disabled && fallback !== null) sizeSel.value = fallback;
                    }
                };
                if (sizeSel) sizeSel.addEventListener('change', syncVideo);
                fpsIn.addEventListener('change', syncVideo);
                vFmt.addEventListener('change', syncVideo);
                syncVideo();
            }

            // ---- RECORD ------------------------------------------------
            const commit = () => {
                this._captureOpts = Object.assign(this.captureOpts(), readVideo(), {
                    format: fmtSel.value, dpi: Number(dpiSel.value) || 200,
                });
                this._describeCapture();
            };
            // WHAT THE CONTROLS SAY, AND WHAT WAS ALREADY SET FOR THE REST.
            //
            // A control that is not on the row has no value to read, and the
            // fallbacks used to be written out here as numbers - which meant a
            // panel opened with nothing recordable (no video row at all) wrote
            // those numbers over the settings: the bitrate came back 5 where
            // the default is 12, because 5 was the literal in this function.
            // Read from the stored options instead, so an absent control
            // leaves its setting alone.
            const readVideo = () => {
                const was = this.captureOpts();
                return {
                seconds: secIn ? Number(secIn.value) || was.seconds : was.seconds,
                fps: fpsIn ? Number(fpsIn.value) || was.fps : was.fps,
                mbps: mbpsIn ? Number(mbpsIn.value) || was.mbps : was.mbps,
                container: vFmt ? vFmt.value : was.container,
                scale: sizeSel ? Number(sizeSel.value) || was.scale : was.scale,
                colors: colorsSel ? Number(colorsSel.value) || was.colors : was.colors,
                // the Images format renders at the Image row's resolution, and
                // is counted rather than timed
                dpi: Number(dpiSel.value) || was.dpi,
                frames: framesIn ? Number(framesIn.value) || was.frames : was.frames,
                rotations: rotIn ? Number(rotIn.value) || was.rotations : was.rotations,
                // ...and an absent control leaves the setting alone, which is
                // why this reads `was` rather than a literal true.
                transparent: bgSel ? bgSel.value !== '0' : was.transparent,
                // WHICH OF THE FOUR, so the description can work out who sets
                // the length. It used to be written only when record was
                // pressed, so until then the line described the last thing
                // recorded rather than the thing on the row.
                //
                // ...AND ONLY WHERE THERE WAS A CHOICE. With one source there
                // is no menu, and writing that single option down made it look
                // chosen: open the panel with Rotate off and the only source is
                // F, so switching Rotate on afterwards kept F instead of
                // landing on FR, which is what having both on means.
                source: srcSel ? srcSel.value : (was.source || ''),
                };
            };
            // WRITTEN BACK ON EVERY CHANGE, not read at the moment a button is
            // pressed. The panel is rebuilt whenever the canvas is resized (see
            // _updateCanvasDimensions), and a value that lived only in the DOM
            // would be lost with it - so it lives in _captureOpts and the DOM
            // is filled from there.
            for (const c of [fmtSel, dpiSel, vFmt, secIn, fpsIn, mbpsIn, sizeSel,
                colorsSel, bgSel, framesIn, rotIn]) {
                if (c) c.addEventListener('change', commit);
            }
            commit();

            // NO SECOND NAME FOR THE SAME THING. This row used to be called
            // Record, under a row called Video, which read as two subjects;
            // it is the same one - the settings above, the button that uses
            // them here - so the block is named once and this row lines its
            // buttons up under them. With nothing recordable it is the only
            // video row there is, and then it does say Video.
            // THE RECORD BUTTONS GO ON THE VIDEO ROW, at the end of the
            // controls they use. They had a row of their own called Record,
            // which is a second name for one subject and, in a panel of
            // wrapping rows, a line break nobody asked for. The row wraps on
            // its own when it has to, and the button follows the settings
            // instead of sitting under them.
            // NO ROW WHERE THERE IS NOTHING TO RECORD. A Vid row whose only
            // content is "you cannot" is a rule, a name and a sentence spent
            // on an absence - and the panel is rebuilt whenever Rotate or Draw
            // is switched on or a trajectory arrives, so the row appears the
            // moment it can do something. The exception is a browser with no
            // recorder at all: video is missing there for a reason worth
            // saying, since nothing the user does will bring it back.
            const recRow = videoRow || (!formats.length
                ? (() => { rule(); return row('Vid'); })() : null);
            if (!recRow) {
                // nothing to record - the row is not there at all
            } else if (!formats.length) {
                recRow.appendChild(el('span', CAP, 'No video recorder in this browser'));
            } else {
                // ONE BUTTON, AND A MENU WHERE THERE IS A CHOICE. A row of
                // buttons reading "Rotate", "Frames", "Draw+Rotate" is a row of
                // sentences; the button is the verb and belongs to the row's
                // controls, so what to record joins them as one more menu and
                // the button is the red dot it always wanted to be.
                if (sources.length > 1) {
                    // BOTH, WHEN BOTH ARE ON. Switching Rotate on with a
                    // trajectory loaded is a request to see it turning, so the
                    // combination is what record means unless something else
                    // was picked.
                    const preferred = sources.find((x) => x.id === 'FR')
                        || sources.find((x) => x.id === 'DR') || sources[0];
                    const want = sources.some((x) => x.id === opts.source)
                        ? opts.source : preferred.id;
                    srcSel = menu('saveVideoSource', sources.map((x) => (
                        { value: x.id, label: x.label })), want, 'What to record');
                    // NEXT TO THE FORMAT, at the head of the row, because these
                    // two are the controls that decide which of the others are
                    // there at all. Appended at the end - where it was built -
                    // it sat AFTER the controls it governs, so picking a source
                    // moved the very menu you had just used: hiding Sec pulls
                    // everything to its right two fields leftwards. The two
                    // choosers stay put now and only the tail rearranges.
                    srcBox = pair('Rec', 'saveVideoSource', srcSel);
                    recRow.insertBefore(srcBox, vFmtBox ? vFmtBox.nextSibling : null);
                }
                const recBtn = button('\u25CF', '');
                recBtn.dataset.rec = '1';
                recBtn.style.color = '#ef4444';
                const pick = () => sources.find((x) => x.id
                    === (srcSel ? srcSel.value : sources[0].id)) || sources[0];
                const syncRec = () => {
                    const src = pick();
                    recBtn.title = 'Record ' + (src.title || src.label);
                };
                if (srcSel) {
                    srcSel.addEventListener('change', syncRec);
                    // ...and the row follows the source, and so does what the
                    // panel remembers: without the commit the description went
                    // on describing whichever source was last RECORDED, so
                    // picking F still read "1 turn" from the FR before it.
                    srcSel.addEventListener('change', () => { syncVideo(); commit(); });
                }
                syncRec();
                recBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    if (this._captureBusy) return;
                    // EVERY FAILURE HAS TO COME BACK HERE. Marking the panel
                    // busy and then throwing on the way to the recorder leaves
                    // every button disabled with no recording running and
                    // nothing said - which is how a one-word mistake in the
                    // sink (a missing `const zip`) read as "Capture, Rotate,
                    // Turn does not record" and as "the GIF path is broken",
                    // both at once, for the rest of the session.
                    try {
                        const src = pick();
                        const vo = Object.assign(readVideo(), { spin: src.spin });
                        this._captureOpts = Object.assign(this.captureOpts(), vo,
                            { source: src.id });
                        // THE PANEL STAYS UP while it records. It used to close
                        // itself, which put the progress and the result
                        // somewhere the user was no longer looking - and left
                        // no way to see that anything was happening at all.
                        // The recorders drive their own frames, so the pause
                        // the panel put on is lifted without resuming anything.
                        this._uiPaused = false;
                        this._captureBusy = true;
                        this._syncCaptureButtons();
                        this._captureStatus('Recording...');
                        // Recording a drawing RESTARTS it from blank paper, so
                        // pressing record part way through a run still gives a
                        // whole one. A turn has no beginning, so it does not.
                        if (src.id === 'D' || src.id === 'DR') this.saveDrawingVideo(vo);
                        else if (src.id === 'R' || src.id === 'RF') {
                            // RF is the turn, with the trajectory fitted into
                            // it - the rotation recorder already drives its own
                            // frames on a clock, which is exactly what "fit the
                            // frames into this many seconds" needs.
                            this.saveRotationVideo(Object.assign({}, vo,
                                { playFrames: src.id === 'RF' }));
                        } else this.toggleRecording(vo);
                    } catch (err) {
                        this._captureBusy = false;
                        this._syncCaptureButtons();
                        this._captureStatus('Could not record: ' + err.message, true);
                        throw err;      // ...and still say so in the console
                    }
                });
                // ...AND THE DOT SITS WITH THEM, not at the end of the row.
                // At the end it was the one control that moved every time: the
                // fields to its left appear and disappear with the source and
                // the format, so it slid about and, in a narrow panel, hopped
                // between lines - and it is the one control you aim at. Format,
                // source, go: the three that are always there, always in the
                // same place, with the settings they govern behind them.
                recRow.action.appendChild(recBtn);
            }

            okBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const io = { format: fmtSel.value, dpi: Number(dpiSel.value) || 200 };
                this._captureOpts = Object.assign(this.captureOpts(), io);
                this.saveImage(io);
            });

            // ...AND ONE LINE THAT SAYS WHAT IS HAPPENING. Everything the
            // capture path has to say goes here - what these settings will
            // produce, how far a recording has got, what was written - instead
            // of into the page's status line, which is somewhere else, under
            // whatever the loader said last, and does not exist at all in the
            // embedded viewer.
            // ...BEHIND A LINE OF ITS OWN. It describes both outputs and it
            // reports whatever was last written, so sitting flush under the
            // Video row it read as another of that row's readouts - a size for
            // the recording rather than a size for the image above it too.
            rule();
            const info = el('div', 'font-size:11px; color:#6b7280; line-height:1.35;'
                + ' overflow-wrap:anywhere; min-width:0; white-space:pre-line;');
            info.dataset.info = '1';
            blocks.push({ kind: 'span', el: info });

            // ONE PASS OVER THE BLOCKS, in the shape the width allows.
            const place = (narrow) => {
                while (p.firstChild) p.removeChild(p.firstChild);
                for (const b of blocks) {
                    if (b.kind === 'span') {
                        b.el.style.gridColumn = '1 / -1';
                        p.appendChild(b.el);
                        continue;
                    }
                    if (narrow) {
                        b.controls.style.gridColumn = '1 / -1';
                        p.appendChild(b.nameEl);
                        p.appendChild(el('span', ''));   // the empty middle cell
                        p.appendChild(b.action);
                        p.appendChild(b.controls);
                    } else {
                        b.controls.style.gridColumn = '';
                        p.appendChild(b.nameEl);
                        p.appendChild(b.controls);
                        p.appendChild(b.action);
                    }
                }
            };
            place(false);

            const anchorRow = (anchorEl && (anchorEl.closest('.toolbar-row')
                || anchorEl.parentElement))
                || (this.controlsContainer || document.body);
            anchorRow.insertAdjacentElement('afterend', p);
            // ...and now its width is a fact rather than a guess
            if (p.clientWidth && p.clientWidth < 260) place(true);
            this._savePanel = p;
            if (anchorEl) {
                anchorEl.setAttribute('aria-controls', 'savePanel');
                anchorEl.setAttribute('aria-expanded', 'true');
            }
            // ...and only now, with the panel installed, can it be written to
            syncVideo();
            this._syncCaptureButtons();
            this._describeCapture();
        },
    },
});
})();