// ============================================================================
// src/parts/embed.js
// --------------------------------
// AI Context: A STRUCTURE ON SOMEONE ELSE'S PAGE (window.py2Dmol.show)
// - The whole public surface of the embed builds: give it an element and the
//   text of a PDB or mmCIF file, get a viewer you can rotate.
// ============================================================================
(function () {
'use strict';

// WHY THIS IS NOT parts/ui.js WITH THE PANEL SWITCHED OFF.
//
// wireViewerUI looks up FORTY-TWO controls by id - #colorSelect, #frameSlider,
// #shadowSlider and the rest - and wires each one. That is not a feature an
// embed declines; it is markup an embed does not have, and against a bare
// container the first addEventListener throws. Guarding forty-two lookups would
// leave the panel's thousand lines in every embed download to do nothing.
//
// So the two entry points share what they actually share - setupViewport, which
// is the canvas and its sizing - and nothing else. What is left here is small
// enough to read in one sitting, which is the point of an embed.

/** Wire a bare container: canvas, renderer, animation loop, registry. */
function wireEmbedUI(containerElement, viewerId, Pseudo3DRenderer) {
    // ...normalised HERE, not inherited. wireViewerUI normalises its own config
    // and writes window.viewerConfig on the way past; nothing does it before
    // either wirer runs, so reading that global gave undefined and the first
    // `config.display` threw inside setupViewport.
    const raw = (window.py2dmol_configs || {})[viewerId] || window.viewerConfig || {};
    const config = normalizeConfig(raw);
    config.viewer_id = viewerId;
    window.viewerConfig = config;
    const viewport = setupViewport(containerElement, config);
    if (!viewport) return;

    const renderer = new Pseudo3DRenderer(viewport.canvas, config);
    renderer.viewerId = viewerId;
    viewport.attach(renderer);
    renderer.animate();

    // The same registry the notebook and the web app use, so anything that
    // knows how to find a viewer can find this one too.
    window.py2dmol_viewers = window.py2dmol_viewers || {};
    window.py2dmol_viewers[viewerId] = { renderer };
}

// ...at global scope, because core/mol.js calls it by name from inside the
// factory and this file is an IIFE.
window.wireEmbedUI = wireEmbedUI;

let seq = 0;

/**
 * Put a structure on the page.
 *
 *     const v = py2Dmol.show(document.getElementById('mol'), cifText);
 *     v.setStyle('cartoon');
 *
 * `target` is any element; the canvas is created inside it. `text` is the
 * contents of a .pdb or .cif file - the format is decided by looking at it,
 * not by an argument, because a caller who fetched a URL often does not know.
 * `options` are viewer config keys, and `width`/`height` as a shorthand for
 * display.size.
 *
 * Returns the renderer, with the calls in attach() on top of it - `load`,
 * `setColor`, `setContacts`, `showObjects`, `select` and `orient`.
 *
 * Three of the options are this function's own rather than the renderer's, and
 * all three turn something ON that is off underneath: `controls`/`play` for the
 * chrome, `orient` for the best view on load, `select` for click-to-pick.
 * Pass `false` to any of them to get the bare behaviour back.
 */
function show(target, text, options) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) throw new Error('py2Dmol.show: no such element: ' + target);
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('py2Dmol.show: needs the text of a PDB or mmCIF file');
    }
    const opts = options || {};

    const id = el.id || ('py2dmol_embed_' + (++seq));
    el.id = id;
    // THE CANVAS IS OURS TO MAKE, and it is looked up by id inside the
    // container - so a second embed on the same page would find the first
    // one's canvas if the id were global. It is scoped by querySelector on
    // the container, which is why the id can repeat.
    // PARSED BEFORE ANYTHING IS BUILT, because how many frames there are
    // decides what to build. Once, not twice: the frames go on to load()
    // rather than the text being read again.
    const frames = framesFromText(text, opts);

    // ...with chrome, that means the notebook's own markup and wiring; without
    // it, a bare canvas and nothing else.
    //
    // A TRAJECTORY BRINGS ITS OWN STRIP. `play` was opt-in, so an NMR ensemble
    // in a plain embed had six models and no way to reach five of them - the
    // caller had to know to ask, having already handed us the file that says
    // so. It is on when there is more than one frame and off when there is
    // one, which is the rule the renderer already applies to showing the strip
    // once it exists; this just stops the strip being absent in the first
    // place. `play: false` still means never.
    const wantsPlay = opts.play !== undefined
        ? !!opts.play : frames.length > 1;
    const wantsChrome = !!(opts.controls || wantsPlay);
    if (wantsChrome) {
        installShell(el, id);
    } else {
        el.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'canvas';
        canvas.style.display = 'block';
        canvas.style.touchAction = 'none';
        // `box` MEANS THE SAME THING HERE AS EVERYWHERE ELSE. It is Python's
        // view(box=...) and the notebook's, and wireViewerUI honours it by
        // taking the border off #canvasContainer - which a bare canvas has no
        // such thing as, so the flag quietly did nothing on this path and
        // every page wanting a frame drew its own. embed.html had a
        // .canvas-box rule for exactly that.
        //
        // border-box so the frame comes out of the size asked for rather than
        // being added to it, which is what the shell does too: a 300 px box
        // holds a 298 px drawing either way.
        if (opts.box !== false && opts.display?.box !== false) {
            canvas.style.boxSizing = 'border-box';
            canvas.style.border = '1px solid #ddd';
            canvas.style.borderRadius = '8px';
        }
        el.appendChild(canvas);
    }

    const width = opts.width || el.clientWidth || 400;
    const height = opts.height || el.clientHeight || 400;
    // NO gpu OPTION. Each embed bundle carries exactly one painter -
    // py2Dmol.embed.min.js the WebGL2 one, py2Dmol.embed.cpu.min.js the 2D one - so which draws
    // is settled by the script tag, and the renderer works it out from what is
    // loaded. A flag here could only ever agree with the bundle or throw.
    const rendering = Object.assign({}, opts.rendering);
    if (opts.gpu !== undefined || rendering.gpu !== undefined) {
        throw new Error('py2Dmol.show: there is no gpu option - the bundle'
            + ' decides. Load py2Dmol.embed.min.js for WebGL2 or py2Dmol.embed.cpu.min.js for'
            + ' the 2D painter.');
    }
    if (opts.style) rendering.style = opts.style;

    // `embed: true` picks the bare wirer in core/mol.js. With chrome we want the
    // OTHER one - wireViewerUI, the same forty controls the notebook gets -
    // which is the whole point of asking for it.
    const config = Object.assign({}, opts, {
        embed: !wantsChrome,
        viewer_id: id,
        rendering,
        display: Object.assign({}, opts.display, {
            size: [width, height],
            // ONE FLAG, TWO JOBS, and it has to be true for either. The
            // renderer reads display.controls to decide whether to show the
            // play strip (core/mol.js) and parts/ui.js reads the same field to
            // decide whether to show the Style panel - so setting it from the
            // play intent alone took the panel away from a single-frame
            // controls:true embed. Which of the two the caller actually asked
            // for is settled below, by hiding the panel when they did not.
            controls: !!(opts.controls || wantsPlay),
        }),
        // THE PANEL AND THE CLICK, one key, AND IT HAS TO BE IN THE CONFIG.
        // `renderer.selectionEnabled = opts.select !== false` below is the same
        // decision, but it runs AFTER the viewer is built - and parts/ui.js
        // mounts the selection panel during that build, on this flag. Set only
        // there, an embed with chrome came up with picking on and no panel to
        // show what was picked.
        //
        // 🔴 `opts.controls`, NOT `wantsChrome`. The two differ for a PLAY-ONLY
        // embed: `wantsChrome` is also true when `play` was asked for, because
        // the play strip lives in the same shell - and the line below then
        // HIDES the whole control column, which is where the panel goes. So a
        // play-only embed mounted a selection panel into a hidden box, and
        // being in the document was enough to do damage: the panel is looked up
        // by id, so the FIRST one on the page is the one every click drove.
        // Measured on embed.html, where clicking the controls example opened
        // the play example's invisible panel five sections up.
        //
        // A bare canvas still PICKS - the halo paints on it and select() is on
        // the API - and has nowhere to put a panel, which is the same split.
        selection: { enabled: !!opts.controls && opts.select !== false },
    });
    delete config.width;
    delete config.height;

    window.py2dmol_configs = window.py2dmol_configs || {};
    window.py2dmol_configs[id] = config;
    initializePy2DmolViewer(el, id);

    const entry = (window.py2dmol_viewers || {})[id];
    if (!entry) throw new Error('py2Dmol.show: the viewer did not start');
    const renderer = entry.renderer;
    attach(renderer);
    // ...the Style panel only when asked; the play strip is part of the shell
    // and the renderer hides it itself when there is nothing to play.
    if (wantsChrome && !opts.controls) {
        const col = el.querySelector('#rightPanelContainer');
        if (col) col.hidden = true;
    }
    // Orient is wired by wireViewerUI, from viewer.html's markup and this
    // shell's alike - it used to be wired HERE, on the reasoning that only
    // index.html has an #objectSelect to ask which object. viewer.html has one
    // too, so that was never the difference and the notebook was simply
    // missing the button. Wiring it in both places fired the flight twice.
    // CLICKING PICKS A RESIDUE, which the renderer keeps off by default and an
    // embed wants on.
    //
    // The default is false for the NOTEBOOK's sake, and the reason is written
    // beside it: viewer.py's page has no sequence strip and no selection panel,
    // so a click there changed a selection with no way to see it, act on it or
    // clear it. None of that holds here. The halo paints on the canvas itself,
    // clicking the background clears, and select() and orient() are on the API
    // - a picked residue is something an embed can both show and use.
    //
    // So the switch follows the same rule it always did: it belongs to whoever
    // can show the result. That is now this entry point too.
    renderer.selectionEnabled = opts.select !== false;
    loadFrames(renderer, frames, opts.name || 'structure', opts.orient !== false);
    return renderer;
}

// --- the optional chrome ----------------------------------------------------
//
// THE REAL PANEL, NOT AN IMITATION. The first version of this built its own two
// dropdowns and its own play strip, which meant a third place that had to be
// kept in step with what the controls actually do - the mistake the panel
// itself had just been rescued from.
//
// So an embed that asks for controls gets the markup the notebook has, mounts
// parts/panel.js into it exactly as viewer.html does, and is wired by
// wireViewerUI - the same function, the same forty controls, the same
// behaviour. What this file supplies is the shell and a stylesheet, because a
// page we do not own cannot be given viewer.html's: forty-nine of its rules are
// bare `select`, `.btn`, `input[type=range]`, and they would restyle the host.
// Everything here is scoped under the container.

const SHELL = (id) => `
<div id="viewerWrapper">
  <div id="canvasContainer"><canvas id="canvas"></canvas></div>
  <div id="controlsContainer">
    <button id="playButton" class="controlButton">&#9654;</button>
    <input type="range" id="frameSlider" min="0" max="0" value="0">
    <span id="frameCounter">0 / 0</span>
    <button id="speedButton" class="controlButton" title="Playback speed">1x</button>
  </div>
</div>
<div id="rightPanelContainer">
  <div class="control-group">
    <div class="btn-row auto">
      <!-- ORIENT IS AN ACTION AND ROTATE IS A STATE, and they are written
           differently here for that reason: a <button> you press against a
           checkbox that stays down. index.html draws Orient as a fake toggle to
           line the toolbar up, and it has to reach past the checkbox to the
           <span> to stop the browser latching it - a workaround for markup
           chosen for looks. The grid row lines these two up anyway. -->
      <button id="orientButton" class="controlButton"
              title="Orient to best view">Orient</button>
      <!-- Focus beside Orient: the two camera moves a CLICK makes, where
           Rotate runs on its own. -->
      <button id="focusButton" class="controlButton" aria-pressed="false"
              title="Click a residue or ligand to draw its neighbours' side chains, move in on it and clip around it. Click the background to come back out.">Focus</button>
      <label class="controlButton btn-toggle" title="Toggle auto-rotation">
        <input type="checkbox" id="rotationCheckbox"><span>Rotate</span>
      </label>
    </div>
    <div class="btn-row auto">
      <button id="styleToggle" class="controlButton" aria-expanded="false"
              aria-controls="stylePanel" title="Render style and its settings">Style</button>
      <!-- Clip is a toggle here and a panel on the website - see viewer.html.
           parts/clip.js is in every bundle, so this is reachable everywhere
           the shell is; it was only ever unreachable for want of a control. -->
      <button id="clipButton" class="controlButton"
              title="Clip to the selection (press again to clear)">Clip</button>
      <!-- CAPTURE, not Save. index.html has called it that for a while - it
           writes an image or a video, and the word Save is already taken there
           by #saveStateButton, which writes the session. viewer.html still said
           Save, which is the same two-copies drift the panel had. -->
      <button id="saveImageButton" class="controlButton"
              aria-expanded="false" aria-controls="savePanel"
              title="Capture an image or a video">Capture</button>
    </div>
    <div id="stylePanelMount"></div>
    <div id="selectionPanelMount"></div>
  </div>
</div>`;

// SCOPED TO THE CONTAINER, every rule. `#${id}` in front of each selector is
// what makes this safe to inject into someone else's page - viewer.html's
// stylesheet says `select { ... }` and would take their dropdowns with it.
const SHELL_CSS = (id) => `
/* WRAPS WHEN THERE IS NO ROOM. The panel column is a fixed 190px and the
   canvas is whatever the caller asked for, so on a container narrower than the
   two together the panel stuck out of the side of the host page's layout.
   Wrapping puts it under the canvas instead. */
#${id} { display: flex; flex-direction: row; align-items: flex-start;
  flex-wrap: wrap; gap: 12px;
  font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
#${id} * { box-sizing: border-box; }
#${id} #viewerWrapper { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
#${id} #canvasContainer { border: 1px solid #ddd; border-radius: 10px; overflow: hidden;
  background: #fff; position: relative; }
#${id} #canvas { display: block; cursor: grab; touch-action: none; }
#${id} #canvas:active { cursor: grabbing; }
#${id} #controlsContainer { display: flex; align-items: center; gap: 4px; padding: 0 2px; }
#${id} #frameSlider { flex: 1 1 120px; min-width: 90px; margin: 0; }
#${id} #frameCounter { color: #374151; min-width: 46px; }
/* THE WIDGET STAYS INSIDE THE BOX IT WAS GIVEN. The Style panel is built
   closed and is 469px tall open - taller than most viewers - so on a container
   with a fixed height it simply hung out of the bottom and over whatever the
   host page had put below. max-height:100% does the right thing BOTH ways:
   against a fixed-height host it clamps and the column scrolls; against an
   auto-height one the percentage has nothing to resolve against, counts as
   none, and the host grows to fit as it should. */
/* COMPACT: measured, not guessed - see viewer.html, whose numbers these
   mirror. The panel is the whole menu in an embed. */
#${id} #rightPanelContainer { display: flex; flex-direction: column; gap: 3px;
  width: 190px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 4px;
  background: #f9fafb; flex: 0 0 auto; max-height: 100%; overflow-y: auto; }
#${id} .control-group { display: flex; flex-direction: column; gap: 3px; }
/* THE HOST PAGE'S RULES REACH IN, AND THIS IS WHERE THEY STOP.
   Every selector here is scoped so the shell cannot take a host page's
   dropdowns - but the traffic goes both ways, and nothing defended the other
   direction. embed.html styles a bare button element (as any page may): a
   13px font, fatter padding, and a margin of 0 .3rem .4rem 0. Backticks are
   not available in this note - SHELL_CSS is itself a template literal, and a
   pair of them here ended the string and stopped the bundle parsing. The
   shell states height and
   padding, so those held - and MARGIN did not. Orient and Clip are buttons
   and took 4.8px on the right and 6.4px underneath; Rotate is a label and
   took none, so the row came out unevenly spaced and the column 13px taller.
   Reset what we do not set, scoped, so an embed looks the same in any page. */
#${id} button, #${id} select, #${id} input, #${id} label {
  margin: 0; box-sizing: border-box; font-family: inherit; }
/* ONE CONTROL HEIGHT, scoped to this viewer - see viewer.html. Five rules
   used to repeat the number and had drifted to three. */
#${id} { --ctl-h: 24px; --ctl-h-sm: 22px; }
#${id} select, #${id} .controlButton { font-size: 12px; padding: 3px 6px; height: var(--ctl-h);
  border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; color: #374151;
  cursor: pointer; font-family: inherit; }
#${id} .controlButton { min-width: 40px; display: inline-flex; align-items: center;
  justify-content: center; white-space: nowrap; font-weight: 500; }
#${id} .controlButton:hover:not(:disabled) { background: #f3f4f6; }
#${id} #styleToggle { width: 100%; }
/* ON IS ON, however the button spells it - Clip latches (aria-pressed), Style
   and Capture open a panel (aria-expanded). Keyed on the state, not on one
   button's id, which is what left Capture unlit with its panel open. */
#${id} .controlButton[aria-pressed="true"],
#${id} .controlButton[aria-expanded="true"] { background: #e5e7eb; border-color: #d1d5db; }
#${id} .btn-row { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 3px; }
#${id} .btn-toggle { padding: 0; border: none; background: transparent; display: block; }
#${id} .btn-toggle input[type="checkbox"] { position: absolute; opacity: 0; width: 0; height: 0; }
/* The face is the LOOK; the SIZE belongs to the context - see viewer.html,
   whose two contexts these mirror. Declaring a height here and overriding it
   below is two rules arguing over one number. */
#${id} .btn-toggle input[type="checkbox"] + span { display: block;
  border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; text-align: center;
  font-weight: 500; cursor: pointer; box-sizing: border-box; }
#${id} .btn-toggle input[type="checkbox"]:checked + span { background: #e5e7eb;
  border-color: #d1d5db; }
#${id} .btn-row .btn-toggle input[type="checkbox"] + span {
  height: var(--ctl-h); line-height: 16px; padding: 3px 6px; }
#${id} #stylePanel .btn-toggle input[type="checkbox"] + span {
  height: var(--ctl-h-sm); line-height: 16px; padding: 2px; }
/* The mount is not a box - see viewer.html. */
#${id} #stylePanelMount { display: contents; }
#${id} #stylePanel { display: flex; flex-direction: column; gap: 3px; padding: 5px;
  border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
#${id} #stylePanel .toggle-item { display: flex; flex-wrap: wrap; align-items: center;
  gap: 5px; min-height: 16px; }
#${id} #stylePanel .half { flex: 1 1 100%; min-width: 0; display: flex;
  align-items: center; gap: 5px; }
#${id} #stylePanel label:not(.btn-toggle) { width: 52px; flex-shrink: 0;
  font-weight: 500; color: #6b7280; }
#${id} #stylePanel select { flex: 1 1 0; min-width: 0; height: var(--ctl-h); padding: 0 4px; }
#${id} #stylePanel input[type="range"] { flex: 1 1 0; min-width: 0; margin: 0; }
#${id} #stylePanel .btn-toggle { flex: 1 1 62px; min-width: 0; }
#${id} #stylePanel .toggle-item select ~ .btn-toggle { flex: 1 1 100%; }
#${id} [hidden] { display: none !important; }
#${id} input[type="range"] { -webkit-appearance: none; appearance: none; background: transparent;
  cursor: pointer; padding: 0; }
#${id} input[type="range"]::-webkit-slider-runnable-track { height: 5px; background: #e5e7eb;
  border-radius: 3px; }
#${id} input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
  width: 13px; height: 13px; border-radius: 50%; background: #3b82f6; border: 2px solid #fff;
  margin-top: -4px; }
`;

/** Put the shell and its stylesheet into the container, once. */
function installShell(el, id) {
    if (!document.getElementById('py2dmol-embed-css-' + id)) {
        const style = document.createElement('style');
        style.id = 'py2dmol-embed-css-' + id;
        style.textContent = SHELL_CSS(id);
        document.head.appendChild(style);
    }
    el.innerHTML = SHELL(id);
}

/** [a, b) as a list, which is what Python's (start, end) tuple means. */
function rangeOf(a, b) {
    const out = [];
    for (let i = a; i < b; i++) out.push(i);
    return out;
}

/**
 * The calls an embed needs that the renderer does not offer in one piece.
 *
 * These are not sugar. Each wraps a sequence that is easy to get wrong and
 * silently wrong when you do - which is exactly what happened to the first
 * version of embed.html, where four of its buttons changed nothing.
 */
function attach(renderer) {
    renderer.load = (text, name, orient) => load(renderer, text, name, orient);

    /**
     * Colour part of the structure, the way Python's set_color does.
     *
     *     v.setColor('plddt')                    // a mode, for everything
     *     v.setColor('red', {chain: 'A'})
     *     v.setColor('red', {positions: [0, 1, 2]})
     *     v.setColor('red', {range: [0, 20]})    // 0..19, like Python's tuple
     *
     * An explicit colour always beats a mode: a residue set red stays red under
     * plddt or rainbow, and the mode only decides the ones nobody spoke for.
     *
     * SETTING renderer.colorMode IS NOT ENOUGH for the mode case. The colours
     * are cached behind two separate flags, and without them the mode changes
     * and the picture does not - the panel's dropdown has always done all three
     * steps, so nothing inside the app noticed the field alone is inert.
     *
     * The per-position form is written onto the OBJECT as
     * {type: 'advanced', value: {chain: {...}, position: {...}}}, keyed by
     * position index - so it belongs to that object's numbering, and it MERGES
     * with what is already there rather than replacing it.
     */
    renderer.setColor = (colour, where) => {
        if (typeof where === 'string') where = { chain: where };
        else if (Array.isArray(where) || where instanceof Set) {
            where = { positions: where };
        }
        const targeted = where && SELECTOR_KEYS.some((k) => k !== 'object'
            && where[k] !== undefined);
        if (!targeted) {
            const valid = typeof getAllValidColorModes === 'function'
                ? getAllValidColorModes() : [];
            if (valid.length && !valid.includes(colour)) {
                throw new Error(`py2Dmol: unknown colour mode ${JSON.stringify(colour)}`
                    + ` - expected one of ${valid.join(', ')}, or a colour with a`
                    + ' {chain}, {positions} or {range} saying where to put it');
            }
            renderer.colorMode = colour;
        } else {
            const name = where.object || renderer.currentObjectName;
            const object = renderer.objectsData[name];
            if (!object) throw new Error(`py2Dmol.setColor: no object ${name}`);
            const prev = (object.color && object.color.type === 'advanced')
                ? object.color.value : {};
            const next = Object.assign({}, prev);
            // A WHOLE CHAIN KEEPS THE CHAIN SPELLING, which is not the same
            // thing as the positions it resolves to today: the renderer stores
            // it by chain id and re-resolves it, so it survives a frame whose
            // numbering differs. Resolving it here would freeze it. Anything
            // narrower than a chain has no such spelling and goes by position.
            const chainOnly = where.chain !== undefined
                && SELECTOR_KEYS.every((k) => k === 'chain' || k === 'object'
                    || where[k] === undefined);
            if (chainOnly) {
                next.chain = Object.assign({}, next.chain);
                for (const c of [].concat(where.chain)) next.chain[c] = colour;
            } else {
                // ...WRITTEN IN THE OBJECT'S OWN NUMBERING, which is what the
                // renderer reads this table in. positionsFor answers in merged
                // indices, so the window comes back off.
                const win = (where.object && renderer.localRangeOf)
                    ? renderer.localRangeOf(where.object) : { off: 0 };
                next.position = Object.assign({}, next.position);
                for (const i of positionsFor(renderer, where)) {
                    next.position[i - win.off] = colour;
                }
            }
            object.color = { type: 'advanced', value: next };
        }
        renderer.colorsNeedUpdate = true;
        renderer.plddtColorsNeedUpdate = true;
        renderer.render('py2Dmol.setColor');
        return renderer;
    };

    /**
     * Lines between residues, with a weight that sets the width.
     *
     *     v.setContacts([[10, 40, 1.0],
     *                    [12, 44, 0.5, {r: 255, g: 0, b: 0}]]);
     *     v.setContacts([['A', 12, 'B', 34, 1.0]]);   // by chain and residue
     *     v.setContacts([[{object: 'A', residues: [12]},
     *                     {object: 'B', residues: [34]}, 1.0]]);  // ACROSS two
     *
     * Two spellings, both understood by the renderer: [i, j, weight, colour?]
     * with 0-based position indices, and
     * [chain1, res1, chain2, res2, weight, colour?]. The weight is a fraction
     * of the full contact width, so 0.5 draws half as thick; the colour is
     * {r, g, b} and defaults to the renderer's own contact colour.
     */
    renderer.setContacts = (contacts, name) => {
        // WHICH LIST IS DECIDED BY THE ENDPOINTS, not by an extra argument.
        // A contact written with ADDRESSES - a selector naming one residue - can
        // have its two ends in different structures, so it belongs to no
        // object and goes on the viewer's own list. Bare indices are an
        // object's own numbering and go on that object, as they always have.
        const addressed = (contacts || []).some((c) => c
            && ((c[0] && typeof c[0] === 'object') || (c[1] && typeof c[1] === 'object')));
        if (addressed) {
            if (name) {
                throw new Error('py2Dmol.setContacts: contacts written with'
                    + ' {object, chain, residue} ends belong to the viewer, not'
                    + ` to one object - drop the "${name}" argument`);
            }
            renderer.crossContacts = contacts || [];
            renderer._invalidateSegmentCache();
            renderer.setFrame(renderer.currentFrame < 0 ? 0 : renderer.currentFrame);
            renderer.render('py2Dmol.setContacts');
            return renderer;
        }
        const on = name || renderer.currentObjectName;
        const object = renderer.objectsData[on];
        if (!object) throw new Error(`py2Dmol.setContacts: no object ${on}`);
        object.contacts = contacts || null;
        // ...contact lines are built WITH the segments, not painted over them,
        // so the frame has to be reloaded rather than merely redrawn.
        renderer.setFrame(renderer.currentFrame < 0 ? 0 : renderer.currentFrame);
        renderer.render('py2Dmol.setContacts');
        return renderer;
    };

    /**
     * Which objects are on screen - several structures in one viewer.
     *
     *     v.load(second, 'B');
     *     v.showObjects(['A', 'B']);
     *
     * load() makes what it loads the CURRENT object, and on its own that is the
     * only one drawn. Naming a set here is what puts two structures in the same
     * picture; the camera widens once to take them both in.
     */
    renderer.showObjects = (names) => {
        // THE RENDERER'S OWN SETTER, not the field and the rebuild by hand.
        // This assigned shownObjects and called _applyShownObjects directly,
        // which skipped setShownObjects - and setShownObjects is what keeps
        // _framedObjects, the record of which objects the CAMERA has already
        // accommodated. With that never updated, the reframe inside
        // _applyShownObjects saw nothing new and left the view framed on
        // whichever object was last loaded: both structures drawn, one of them
        // half out of shot.
        renderer.setShownObjects(names || Object.keys(renderer.objectsData));
        return renderer;
    };

    // A SELECTION REDRAWS THE CANVAS, WHOEVER MADE IT.
    //
    // setResidueSelection and clearResidueSelection change the field, dispatch
    // py2dmol-residue-selection-change and stop. That is not an oversight in
    // the renderer: in the web app the panel is listening and redraws as part
    // of rebuilding itself, so a render here would be a second one.
    //
    // In an embed nobody is listening, and the effect was a halo that appeared
    // LATE - the pick landed, the canvas kept the old picture, and the next
    // rotate or zoom brought the halo in with it. Every click looked ignored
    // until you moved the structure. (An earlier check here missed this: it
    // compared the canvas against a frame from several steps back rather than
    // against the one immediately before the click, so any difference at all
    // read as a repaint.)
    //
    // WRAPPED, NOT EVENT-SUBSCRIBED. The bus is document-scoped, so a listener
    // would fire once per viewer on the page for a selection made in any one of
    // them. This is the renderer's own pair of methods, so it redraws exactly
    // the canvas whose selection changed - and it catches every route in: the
    // click, shift-click, double-click-for-a-chain and the background clear all
    // go through these two, as does select() below.
    for (const m of ['setResidueSelection', 'clearResidueSelection']) {
        const base = renderer[m].bind(renderer);
        renderer[m] = (...a) => {
            base(...a);
            renderer.render('py2Dmol.' + m);
        };
    }

    /**
     * Highlight residues, and stop highlighting them.
     *
     *     v.select('B')                       // add the chain
     *     v.select({residues: [12, 13]})      // ...and two more residues
     *     v.unselect({residues: [12]})        // ...less one
     *     v.unselect()                        // clear
     *
     * RELATIVE, LIKE hide AND show, and for the same reason: these are two
     * operations on a set - add and subtract - and a caller who wants to
     * replace outright says unselect() first. It used to replace, which made
     * `select` the only verb on this object that ignored what was already
     * there, and left no way at all to extend a selection from code - while
     * the CANVAS could, since shift-click has always added to one.
     *
     * With no argument a selector means everything, so unselect() clears and
     * select() takes the lot; neither needs a special case.
     */
    const editSelection = (sel, add) => {
        const next = new Set(renderer.residueSelection || []);
        for (const i of positionsFor(renderer, sel)) {
            if (add) next.add(i); else next.delete(i);
        }
        renderer.setResidueSelection(next);
        return renderer;
    };
    renderer.select = (sel) => editSelection(sel, true);
    renderer.unselect = (sel) => editSelection(sel, false);

    // WHAT IS DRAWN, AS THREE VERBS INSTEAD OF AN INVERTED PATCH.
    //
    // setVisibility takes the set that STAYS - so hiding a chain meant passing
    // the other ones, and an empty set means "unset" and shows everything
    // unless you also say visibilityMode:'explicit'. Both of those are real and
    // neither is guessable; embed.html documented the first one backwards for
    // as long as it had a reference, and the demo button labelled "hide chain
    // B" drew chain B alone.
    //
    // hide and show say what they do. This is the web app's own model -
    // parts/selectpanel.js setSelectionVisible - which starts from what is visible
    // now, adds or removes, DERIVES THE CHAIN SET from what survives, and
    // switches to the explicit mode. The chain derivation is not optional: an
    // empty chain set means "all chains" under the default mode and "no chains"
    // under explicit, so leaving it alone made every chain label read as
    // unselected while most of the structure was still on screen.
    const visibleNow = () => (renderer.visiblePositions
        ? new Set(renderer.visiblePositions)
        : new Set(rangeOf(0, (renderer.coords || []).length)));
    const applyVisible = (next) => {
        const chains = new Set();
        for (const i of next) {
            const c = renderer.chainKeyAt ? renderer.chainKeyAt(i)
                : (renderer.chains || [])[i];
            if (c) chains.add(c);
        }
        renderer.setVisibility({ positions: next, chains,
            visibilityMode: 'explicit' });
        if (renderer._invalidateSegmentCache) renderer._invalidateSegmentCache();
        renderer.render('py2Dmol.visibility');
        return renderer;
    };

    // NO find(). It resolved a selector and handed back the Set without
    // touching anything, and the argument for it was that every other verb
    // ACTS, so there was no way to ask a question. That argument did not
    // survive contact with the page: the only caller was a console button
    // demonstrating find itself, and the answer it gave - position indices -
    // is the one currency an embed's user does not think in. Checking a
    // selector is v.select(sel) and looking, which is what every section here
    // already does.
    //
    // positionsFor is still there and still shared; it just is not a verb.

    /** Take these off the screen, leaving the rest. */
    renderer.hide = (sel) => {
        const next = visibleNow();
        for (const i of positionsFor(renderer, sel)) next.delete(i);
        return applyVisible(next);
    };

    /** Put these back, keeping whatever else is already shown. */
    renderer.show = (sel) => {
        const next = visibleNow();
        for (const i of positionsFor(renderer, sel)) next.add(i);
        return applyVisible(next);
    };

    // SIDE CHAINS, PER RESIDUE, AND NOT HERE ANY MORE. showSidechains and
    // hideSidechains were written out in this file, which put them out of
    // reach of the notebook: view(sidechains=True) could carry the atoms and
    // nothing could ask for them to be drawn. They are prototype methods now
    // (parts/sidechains.js), so `v.showSidechains(sel)` still answers on the
    // embed - the renderer IS the embed's API object - and view.show_sidechains()
    // reaches the same code. Nothing to wire here; this note is the pointer.

    /**
     * ELEMENT COLOURS, which are ON already and this turns off.
     *
     *     v.hideElements({type: 'L'});   // the ligand in one flat colour
     *     v.showElements();              // ...and back
     *
     * The opposite default to side chains, and deliberately: a ligand's atoms
     * and a drawn side chain are read by their elements, so an object nobody
     * has touched has them everywhere. Only those atoms have an element to
     * colour by - a C-alpha trace has none, and nothing happens.
     *
     * The renderer's own setElementsFor takes raw position indices, which is
     * the one thing on this object that is not a selector; this is that call
     * with the grammar in front of it.
     */
    const setElements = (sel, on) => {
        if (!renderer.setElementsFor) return renderer;
        if (!renderer.setElementsFor([...positionsFor(renderer, sel)], on)) {
            return renderer;              // nothing of ours has elements
        }
        renderer._invalidateSegmentCache();
        renderer.reloadDrawn();
        renderer.render('py2Dmol.elements');
        return renderer;
    };
    renderer.showElements = (sel) => setElements(sel, true);
    renderer.hideElements = (sel) => setElements(sel, false);

    /**
     * A SLAB THROUGH WHAT YOU NAMED, so a pocket is not buried under the front
     * of the protein.
     *
     *     v.clip({within: {of: {type: 'L'}, angstroms: 6}});
     *     v.clip();     // off
     *
     * autoClip is the renderer's, and it TRACKS: the slab is remembered as
     * model coordinates and re-projected each frame, so it stays over the same
     * residues as the structure turns rather than cutting a fixed depth.
     */
    renderer.clip = (sel) => renderer.clipTo(sel);

    // NO showOnly. It was here, and {not: sel} made it sugar: draw only x is
    // resetVisibility() then hide({not: x}). Two verbs are the two operations
    // that inversion cannot express - subtract from what is showing, and add
    // back to it - and a third that is a composition of them is one more name
    // to document, keep in step and get wrong.

    /**
     * Turn the structure to face the reader.
     *
     *     v.orient()                       // fly there over a second
     *     v.orient({animate: false})       // jump
     *     v.orient({name: 'B'})            // frame that object, not the current one
     *
     * The search is parts/orient.js's, the same one the website's Orient button
     * and the notebook's first frame use, and it orients on WHAT YOU CAN SEE:
     * the selection intersected with the visible set, or the visible set when
     * nothing is selected.
     *
     * A viewer already does this once, unprompted, when the first object lands.
     * This is for afterwards - after select(), after showObjects(), after the
     * reader has spun it somewhere unhelpful.
     */
    /**
     * Look at one residue or ligand and what it is doing.
     *
     *     v.focus({type: 'L'});                 // the ligand and its pocket
     *     v.focus({chain: 'A', residues: [42]});
     *     v.focus();                            // back out again
     *
     * Selects it, draws the side chains of everything within 5 A (taking the
     * last focus's away), moves in on the neighbourhood and cuts a slab round
     * it. IT DOES NOT TURN THE STRUCTURE - only the centre and the zoom move,
     * so focusing from one residue to the next walks through a structure
     * rather than spinning it. That is the difference between this and
     * orient().
     */
    renderer.focus = (sel, opts) => {
        if (typeof renderer.focusOn !== 'function') {
            throw new Error('py2Dmol.focus: parts/focus.js is not loaded');
        }
        if (sel === undefined || sel === null) renderer.clearFocus();
        else renderer.focusOn(sel, opts);
        return renderer;
    };

    renderer.orient = (options) => {
        // ...NOT SILENTLY NOTHING. The module is in both embed bundles, so the
        // only way here is a hand-assembled script list, and a button that does
        // nothing is a worse answer than a sentence saying which file is missing.
        if (!window.py2dmolOrient) {
            throw new Error('py2Dmol.orient: parts/orient.js is not loaded');
        }
        // The selector/options merge is orientTo's - see parts/orient.js.
        return window.py2dmolOrient.orientTo(renderer, options);
    };
}

/**
 * Parse text and hand every model in it to the renderer under `name`.
 *
 * TWO THINGS THE RENDERER'S OWN CALLS DO NOT DO, and the reference documents
 * this as "put another structure up, OR REPLACE THE CURRENT ONE", so both are
 * load's to arrange.
 *
 * A NAME, ALWAYS. `v.load(text)` with no name reached addObject(undefined),
 * which made an object keyed "undefined" and left currentObjectName undefined -
 * falsy, so addFrame then took its own emergency branch and made a THIRD object
 * called "0" to put the structure in. Three objects, two console warnings and
 * the picture in the one nothing else refers to.
 *
 * AND A REPLACEMENT, NOT AN APPEND. addObject returns early when the object
 * already has frames - by design, so a re-fetch does not throw away what is
 * loaded - and addFrame then appends, so loading a different structure under a
 * name in use made it frame 2 of a "trajectory" of two unrelated molecules.
 * src/app/objects.js hits the same wall and answers it the same way: delete the
 * entry first, under the comment "always replace objects with the same name to
 * avoid mixing data".
 */
function load(renderer, text, name, orient, opts) {
    return loadFrames(renderer, framesFromText(text, opts), name, orient);
}

/** ...and the same once the text has already been read. */
function loadFrames(renderer, frames, name, orient) {
    const on = name || renderer.currentObjectName || 'structure';
    if (renderer.objectsData[on]) delete renderer.objectsData[on];
    renderer.addObject(on);
    // EVERY MODEL, NOT THE FIRST. This took only models[0], so a multi-model
    // PDB - an NMR ensemble, a trajectory, anything with MODEL records - loaded
    // as a single frame and the viewer reported "frame 1 of 1". Nothing failed;
    // five sixths of the file was simply dropped.
    for (const f of frames) renderer.addFrame(f, on);
    renderer.setFrame(0);
    // ...AND TURNED TO FACE THE READER. Every other entry point does this and
    // the embed did not: a structure came up in whatever frame its file was
    // deposited in - for most PDB entries an arbitrary crystal setting - with
    // the rotation matrix reading as the identity.
    //
    // It was not an oversight in one place so much as a branch nobody came
    // through. The orient in parts/ui.js sits in the STATIC-PAYLOAD path, the
    // objects viewer.py writes into the config; show() does not go that way, it
    // feeds the renderer here.
    //
    // EVERY OBJECT, NOT JUST THE FIRST, which is what the website does -
    // app/main.js calls applyBestViewRotation(false) for each newly applied
    // object. The camera is per-object anyway (addObject gives each its own
    // viewerState), so a second structure was arriving at the identity while
    // the first sat correctly oriented, and the reader's view of the first is
    // not disturbed either way.
    //
    // NOT ANIMATED, for ui.js's reason: the viewer has only just appeared, and
    // something that opens mid-flight reads as a bug rather than a flourish.
    if (orient !== false && window.py2dmolOrient) {
        window.py2dmolOrient.orientToBestView(
            renderer, { animate: false, name: on, keepSpin: true });
        // ...AND THE CAMERA NOW ACCOUNTS FOR THIS OBJECT AND NOTHING ELSE.
        //
        // _framedObjects is the renderer's record of what the current framing
        // takes in, and _applyShownObjects widens only for a name missing from
        // it. Every array build ADDS to that record, so two structures loaded
        // one after the other - each framed alone, on its own orient - both
        // ended up marked as accounted for. Showing them together then widened
        // nothing and left the second half out of shot.
        //
        // Reset here rather than in the record's own keeper, because this is
        // the one place that KNOWS the camera was just pointed at a single
        // object. Doing it there instead made hiding an object forget it, so
        // switching an eye back on re-framed - which is the behaviour that
        // record exists to prevent.
        if (renderer._framedObjects) renderer._framedObjects = new Set([on]);
    }
    renderer.render('py2Dmol.show');
    return renderer;
}

/**
 * Text to frames, one per model, format decided by looking.
 *
 * mmCIF is declared by `data_` on its first meaningful line, and anything else
 * is read as PDB - which is what the web app's own sniffing does. The
 * seven-argument converter behind this is the parser's internal shape and is
 * not something an embed should have to know.
 */
function framesFromText(text, opts) {
    const isCIF = /^\s*(#.*\n)*\s*data_/i.test(text.slice(0, 4096));
    const p = isCIF ? parseCIF(text) : parsePDB(text);
    if (!p.models || !p.models.length) {
        throw new Error(isCIF
            ? 'py2Dmol: that mmCIF has no atom records'
            : 'py2Dmol: that PDB has no ATOM or HETATM records');
    }
    // THE BIOLOGICAL ASSEMBLY, when asked for. A crystal structure's file holds
    // the asymmetric unit, which for anything symmetric is a fraction of the
    // real molecule - one sixtieth of a capsid, one protomer of a trimer - plus
    // the operations that build the rest. src/io/parse.js knows how to read and
    // apply them, and the web app and viewer.py both do; an embed could not
    // ask, and quietly drew the fragment.
    let models = p.models;
    // ON UNLESS REFUSED, which is what the website has always asked for and
    // what the molecule actually is. A file with no assembly records is drawn
    // exactly as it is, so the cost of the default is a regex that finds
    // nothing.
    if (!opts || opts.biounit !== false) {
        // ...a cheap negative first, because most files have no assembly at all
        // and finding that out should not cost a scan of the whole thing.
        const hints = isCIF
            ? /_pdbx_struct_(assembly_gen|oper_list)\./.test(text)
            : /REMARK 350/.test(text);
        const ops = hints ? extractBiounitOperations(text, isCIF) : null;
        if (ops && ops.length) {
            models = models.map((m) => applyBiounitOperationsToAtoms(m, ops));
        }
    }
    return models.map((model) => convertParsedToFrameData(
        model, p.modresMap, isCIF ? p.chemCompMap : null, false,
        p.conectMap, isCIF ? p.structConn : null,
        isCIF ? p.chemCompBondMap : null));
}

/** The first model only, for a caller assembling frames itself. */
function frameFromText(text) {
    return framesFromText(text)[0];
}

/**
 * A structure by id, as text. `1UBQ` from the PDB, anything else from
 * AlphaFold.
 *
 *     const text = await py2Dmol.fetch('1UBQ');
 *     py2Dmol.show('mol', text);
 *
 * SEPARATE FROM show, AND RETURNING TEXT, on purpose. show() is synchronous and
 * cannot fail halfway; a download is neither - it is offline, or the id is
 * wrong, or the server is slow - and folding it in would make every caller
 * await a viewer that might never arrive. This way the failure is yours to
 * catch and show() is unchanged.
 *
 * What it saves you is the one piece of knowledge worth sharing: which archive
 * an id belongs to, and the URL it lives at. Those URLs are somebody else's and
 * they move - AlphaFold's model files have been v4 and are now v6 - so having
 * one copy rather than one per page is the point.
 */
async function fetchStructure(id) {
    const key = String(id || '').trim();
    if (!key) throw new Error('py2Dmol.fetch: needs a PDB or UniProt id');
    // FOUR CHARACTERS IS A PDB ENTRY, which is the rule the web app uses and
    // the one the archives themselves imply: a UniProt accession is six or ten.
    const url = key.length === 4
        ? `https://files.rcsb.org/download/${key.toUpperCase()}.cif`
        : `https://alphafold.ebi.ac.uk/files/AF-${key.toUpperCase()}-F1-model_v6.cif`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`py2Dmol.fetch: ${key} came back ${res.status}`
            + ` ${res.statusText} from ${url}`);
    }
    return res.text();
}

// THE HYDROPATHY BANDS ARE PART OF THE API because a page that colours by
// hydropathy needs a LEGEND, and building one means knowing the five colours
// and what they are called. Reading them off a picture, or copying the table
// into the host page, is how a legend comes to disagree with the viewer beside
// it. `[{ min, hex, label }]`, most hydrophobic first.
/**
 * Superpose one set of coordinates onto another, and hand back the result.
 *
 * Kabsch has been in every bundle since the browser took the viewing geometry
 * over from numpy, and `addFrame` uses it - but only on ITSELF, frame to frame,
 * when a frame asks with `align: true`. A caller who wants to know where a
 * structure WOULD sit had no way to ask, which is the same shape of gap as the
 * side chains and the slab before it: the capability shipped, the door did not.
 *
 * FIT ON A SUBSET, APPLY TO EVERYTHING, because that is the case that cannot be
 * done from outside. Two structures of the same molecule rarely have the same
 * atom list - a point mutation changes one residue's side chain - so the fit is
 * computed from the atoms they share (the alpha carbons, usually) and the
 * transform is applied to all of `mobile`. With no subset the two must be the
 * same length and every point is used.
 *
 *     py2Dmol.superpose(mobile, reference)
 *     py2Dmol.superpose(mobile, reference, {from: caM, to: caR})
 *
 * @param {Array<Array<number>>} mobile the coordinates to move
 * @param {Array<Array<number>>} reference the coordinates to land on
 * @param {{from?: number[], to?: number[], reflection?: boolean}} [options]
 *     `from`/`to` are INDEX arrays - into `mobile` and `reference` - naming the
 *     points the fit is computed from. They must be the same length as each
 *     other, and both must be given or neither.
 * @returns {Array<Array<number>>} a new array; `mobile` is not touched.
 */
function superpose(mobile, reference, options) {
    const opts = options || {};
    if (!Array.isArray(mobile) || !Array.isArray(reference)
        || !mobile.length || !reference.length) {
        throw new Error('py2Dmol.superpose: two non-empty coordinate lists are'
            + ' needed');
    }
    const hasFrom = opts.from !== undefined;
    const hasTo = opts.to !== undefined;
    if (hasFrom !== hasTo) {
        throw new Error('py2Dmol.superpose: `from` and `to` name the points the'
            + ' fit is computed from and go together - got only '
            + (hasFrom ? '`from`' : '`to`'));
    }
    let fitM = mobile;
    let fitR = reference;
    if (hasFrom) {
        if (opts.from.length !== opts.to.length) {
            throw new Error('py2Dmol.superpose: `from` names ' + opts.from.length
                + ' points and `to` names ' + opts.to.length
                + ' - a fit pairs them off, so they must match');
        }
        // ...AND AN INDEX THAT IS NOT THERE IS AN ERROR, not an undefined that
        // reaches the arithmetic and comes back NaN for every atom. A silently
        // NaN structure draws as nothing at all.
        const pick = (coords, idx, which) => idx.map((i) => {
            const p = coords[i];
            if (!p) {
                throw new Error(`py2Dmol.superpose: \`${which}\` names index ${i},`
                    + ` which that list of ${coords.length} does not have`);
            }
            return p;
        });
        fitM = pick(mobile, opts.from, 'from');
        fitR = pick(reference, opts.to, 'to');
    } else if (mobile.length !== reference.length) {
        throw new Error('py2Dmol.superpose: with no `from`/`to` every point is'
            + ` paired off, so the lists must be the same length - got ${mobile.length}`
            + ` and ${reference.length}`);
    }
    if (fitM.length < 3) {
        throw new Error('py2Dmol.superpose: a rotation needs at least three'
            + ` points to be determined - got ${fitM.length}`);
    }
    return align_a_to_b(mobile, fitM, fitR, opts.reflection === true);
}

window.py2Dmol = { show, fetch: fetchStructure, frameFromText, framesFromText, superpose,
    version: 1 };

// A GETTER, BECAUSE THIS FILE LOADS BEFORE core/mol.js. HYDROPHOBICITY_BANDS
// is a module-scope `const` there, so at the moment this line runs it is in
// its temporal dead zone - and a `const` in TDZ makes even `typeof` throw, so
// the usual guard is no guard at all. Read on access and mol.js has long since
// been evaluated.
//
// A COPY EACH TIME, so a host page sorting or pushing onto what it gets back
// cannot edit the table the viewer draws from.
Object.defineProperty(window.py2Dmol, 'hydrophobicityBands', {
    enumerable: true,
    get() { return HYDROPHOBICITY_BANDS.map((b) => Object.assign({}, b)); },
});
}());
