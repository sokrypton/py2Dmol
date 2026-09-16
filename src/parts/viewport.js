// ============================================================================
// src/parts/viewport.js
// -----------------------------------
// AI Context: A CANVAS AT THE RIGHT SIZE (setupViewport)
// - The one thing every entry point needs before it can make a renderer: find
//   the canvas, scale it for the display, and keep it that size as the box
//   around it changes. Shared by wireViewerUI and the embed, which agree about
//   nothing else.
// ============================================================================

/**
 * Find the canvas in a container and size it for this display.
 *
 * Returns null - having said why - when there is no canvas, because every
 * caller's next line would dereference it.
 *
 * `attach(renderer)` starts the ResizeObserver. It is separate because the
 * observer's callback needs the renderer, and the renderer's constructor needs
 * the sized canvas: the two cannot be set up in one step.
 */
function setupViewport(containerElement, config) {
    const canvas = containerElement.querySelector('#canvas');
    if (!canvas) {
        console.error('py2dmol: Could not find #canvas element in container.');
        return null;
    }

    // UNCAPPED, and window.canvasDPR still overrides. The 1.5x cap this used to
    // carry traded sharpness for paint cost, which stopped being the right
    // trade when the GPU path took over the drawing.
    const dpr = window.canvasDPR !== undefined
        ? window.canvasDPR : (window.devicePixelRatio || 1);

    // ...and the box the canvas sits in, which is what actually resizes. The
    // notebook's markup has all three; an embed has none of them, and the page
    // still works - it simply does not follow its container.
    const canvasContainer = containerElement.querySelector('#canvasContainer');
    const viewerWrapper = containerElement.querySelector('#viewerWrapper');

    // ====================================================================
    // 🔴 AN INLINE WIDTH IS A WIDTH NO STYLESHEET CAN OVERRIDE, AND THAT IS
    // WHY THIS PAGE COULD NOT BE MADE RESPONSIVE IN CSS.
    //
    // `canvasContainer.style.width = ...` is an inline style. No media
    // query, no container query and no amount of specificity beats one -
    // only `!important` does. So every responsive rule written against
    // #canvasContainer lost to an attribute this function had already set,
    // and the failure looks like a media query that is not matching.
    //
    // A page that sizes its own viewer SAYS SO, on the container, and then
    // this writes nothing and CSS owns the box. The ResizeObserver below
    // needs no change at all - it already reads the container's measured
    // size and drives the canvas from it, which is exactly what a fluid
    // layout wants.
    //
    // OPT-IN, BECAUSE THE NOTEBOOK NEEDS THE OPPOSITE AND NEEDS IT IN THE
    // MARKUP. viewer.py substitutes the size as an inline style and RAISES
    // if the token is gone - Colab inserts output HTML with innerHTML,
    // which never runs a script, and sizes its output iframe from what it
    // measures in that window. Take the inline size away there and the
    // measurement falls back to the stylesheet's 600x600, which is the
    // white space under a grid that rule exists to prevent.
    // ====================================================================
    const cssSized = !!(canvasContainer && canvasContainer.dataset
        && canvasContainer.dataset.autosize === 'css');
    // A BARE EMBED FOLLOWS ITS HOST. py2Dmol.show on a plain element, with no
    // width or height asked for, sized the canvas from the element ONCE and
    // never again: a host whose box is fluid (a game filling the window, a
    // panel the user drags) was left with a canvas of the old size until it
    // rebuilt the viewer itself. The shell has #canvasContainer for the
    // observer to watch; a bare canvas has the host element, which is what
    // config.display.follow says to watch (parts/embed.js sets it when no
    // size was given). Measured and applied exactly as the container is.
    const followHost = !canvasContainer && !!config.display?.follow;
    const followed = cssSized ? canvasContainer : followHost ? containerElement : null;

    // WHAT THE BOX ACTUALLY IS when CSS owns it, falling back to the config
    // when it cannot be measured - a container inside a `display: none`
    // parent measures 0, which is the state index.html starts in. The
    // observer corrects it the moment the viewer is shown.
    const asked = [config.display?.size[0] || 300, config.display?.size[1] || 300];
    // 🔴 IS THIS A MEASUREMENT OR A GUESS? One definition, used three times: for
    // the size below, for the flag the renderer reads, and by the observer.
    //
    // index.html keeps the viewer inside a `display: none` parent until a
    // structure arrives, so the container measures 0 for the whole of that and
    // `asked` is config.display.size - a number nobody chose for this page.
    // Everything built at it is thrown away when the viewer is shown.
    const boxIsReal = (b) => !!(b && b.width >= 1 && b.height >= 1);
    const box = cssSized ? canvasContainer.getBoundingClientRect() : null;
    const width = (box && box.width >= 1) ? box.width : asked[0];
    const height = (box && box.height >= 1) ? box.height : asked[1];

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    // ON THE CANVAS, NOT ON THE RENDERER, because of WHEN each exists: the
    // renderer is not built yet and `attach` runs after it has already drawn.
    // The canvas element is the one thing both sides hold, and paintgl is
    // handed its 2D context, so it reads this with no plumbing at all.
    canvas.__viewportProvisional = !!(cssSized && !boxIsReal(box));
    // ...and it is cleared by a REAL measurement and nothing else. The observer
    // fires while the viewer is still hidden - contentRect 0, clamped to 1 -
    // and clearing on that would put the flag down before the size it exists
    // for has arrived.
    const markReal = (b) => {
        if (boxIsReal(b)) canvas.__viewportProvisional = false;
    };

    if (canvasContainer && !cssSized) {
        canvasContainer.style.width = width + 'px';
        canvasContainer.style.height = height + 'px';
        if (viewerWrapper) viewerWrapper.style.width = width + 'px';
    }

    // 🔴 MEASURE AND APPLY, IN ONE PLACE, BECAUSE IT HAPPENS THREE TIMES.
    //
    // The size was decided once above, then again by the ResizeObserver, with
    // the two bodies written out separately - and the first of them runs before
    // ui.js has built the style and selection panels, which are most of the
    // shell's width. So the canvas was measured against an unfinished DOM,
    // everything drawn at that size, and everything built again when the panels
    // landed and the observer noticed. On 1UBQ that is the two mesh builds a
    // page load costs, at 100x600 and then 706x706; on a large structure it is
    // a whole mesh nobody ever saw.
    //
    // `settle()` is the same measurement, exported so the caller can take it
    // once the DOM it is measuring is actually complete. It returns whether
    // anything moved, so a caller that has not drawn yet can stay silent.
    const applySize = (newWidth, newHeight) => {
        canvas.width = newWidth * dpr;
        canvas.height = newHeight * dpr;
        canvas.style.width = newWidth + 'px';
        canvas.style.height = newHeight + 'px';
        if (viewerWrapper) viewerWrapper.style.width = newWidth + 'px';
        const c = canvas.getContext('2d');
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.scale(dpr, dpr);
    };
    let lastWidth = width;
    let lastHeight = height;
    // 🔴 A HOST'S BOX CONTAINS THE CANVAS, SO FOLLOWING IT WHOLE FEEDS BACK.
    // #canvasContainer is a box of its own whose size the page sets, and the
    // canvas fills it - no loop. A bare host is not: its height is whatever its
    // contents come to, the canvas among them, so "make the canvas the height of
    // its host" reads its own answer back. With anything else inside the host -
    // a caption, a toolbar, one div - each pass added that thing's height to the
    // canvas, the host grew by the same amount, and round it went: measured, a
    // 60px block took a 152px canvas to 2,312px in under a second, with Chrome
    // logging "ResizeObserver loop completed with undelivered notifications".
    //
    // What the canvas may have is the space LEFT: the host's content box, less
    // everything else in it, less the canvas's own margins - which is exactly
    // the canvas's current height when it is the only thing there, so the
    // measurement is a fixed point and the loop cannot start. A host with a
    // height of its own still hands over what it has, which is the case this
    // follow exists for.
    const px = (v) => parseFloat(v) || 0;
    const outerHeight = (el, s) => (el.getBoundingClientRect().height
        + px(s.marginTop) + px(s.marginBottom));
    const hostBox = () => {
        const s = getComputedStyle(followed);
        const w2 = followed.clientWidth - px(s.paddingLeft) - px(s.paddingRight);
        let h2 = followed.clientHeight - px(s.paddingTop) - px(s.paddingBottom);
        for (const child of followed.children) {
            // the canvas is what is being sized, and the GPU painter's layer is
            // out of flow under it (cartoon/paintgl.js, direct presentation)
            if (child === canvas || child.hasAttribute('data-py2dmol-layer')) continue;
            const cs = getComputedStyle(child);
            if (cs.position === 'absolute' || cs.position === 'fixed') continue;
            h2 -= outerHeight(child, cs);
        }
        const cs = getComputedStyle(canvas);
        h2 -= px(cs.marginTop) + px(cs.marginBottom);
        return [w2, h2];
    };
    const measure = () => {
        if (!followed) return null;
        if (followHost) {
            const b = hostBox();
            if (!(b[0] >= 1 && b[1] >= 1)) return null;
            return b;
        }
        const r = followed.getBoundingClientRect();
        if (!(r.width >= 1 && r.height >= 1)) return null;
        return [r.width, r.height];
    };
    // ...and the same 0.5px guard the observer uses: sub-pixel jitter is not a
    // resize, and treating it as one rebuilds on every frame a layout settles.
    const moved = (w2, h2) => Math.abs(w2 - lastWidth) >= 0.5
        || Math.abs(h2 - lastHeight) >= 0.5;
    const settle = (renderer) => {
        const m = measure();
        if (m) markReal({ width: m[0], height: m[1] });
        if (!m || !moved(m[0], m[1])) return false;
        lastWidth = m[0]; lastHeight = m[1];
        applySize(m[0], m[1]);
        if (renderer && renderer._updateCanvasDimensions) {
            renderer._updateCanvasDimensions();
        }
        return true;
    };

    const attach = (renderer) => {
        if (!canvasContainer && !followed) return;
        if (!window.ResizeObserver) {
            console.warn('py2dmol: ResizeObserver not supported.'
                + ' Canvas resizing will not work.');
            return;
        }
        const observer = new ResizeObserver((entries) => {
            if (!entries || entries.length === 0) return;
            markReal(entries[0].contentRect);
            // ...and a followed HOST is asked what is left rather than how big
            // it is, which is the same question `measure` answers and the one
            // that does not feed the canvas its own size back - see hostBox.
            const m = followHost ? measure() : null;
            if (followHost && !m) return;
            const newWidth = Math.max(m ? m[0] : entries[0].contentRect.width, 1);
            const newHeight = Math.max(m ? m[1] : entries[0].contentRect.height, 1);
            if (!moved(newWidth, newHeight)) return;
            lastWidth = newWidth;
            lastHeight = newHeight;
            applySize(newWidth, newHeight);
            renderer._updateCanvasDimensions();
            renderer.render('ResizeObserver');
        });
        observer.observe(followed || canvasContainer);
    };

    installFullscreen(containerElement, canvasContainer);

    return { canvas, ctx, dpr, width, height, attach, settle };
}

// ============================================================================
// FULL SCREEN: the viewer, its panels and the sequence strip, and nothing else
// ----------------------------------------------------------------------------
// The button is built HERE rather than written into index.html, because the
// same markup would then have to be written into viewer.html and the embed's
// shell as well - the mistake the style panel was rescued from, which had
// already gone wrong in both directions before anyone noticed. One place
// builds it, every shell gets it.
//
// 🔴 AND THE SKIN TRAVELS WITH IT, for the same reason parts/panel.js ships
// its own stylesheet. A rule added to src/app/style.css dresses the website and
// leaves the notebook with a button that works and a layout that does not.
// ============================================================================

const FS_CLASS = 'py2dmol-fs';
const FS_CSS = `
/* The element that actually goes full screen. It holds the viewer instance and
   the sequence strip; everything else in the page is hidden while it is up. */
.${FS_CLASS} {
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    height: 100%;
    width: 100%;
    padding: 8px;
    overflow: auto;
    background: var(--color-bg, #f9fafb);
}
/* 🔴 AND THE PAGE WIDTH COMES OFF, which is the thing that actually makes the
   molecule bigger. .page-width is a flat width:948px, and it is on the
   element that goes full screen AND on the sequence strip inside it - so
   without this the canvas sat at 600px on a 1600px screen with the row already
   full, and every flex rule above it was correct and had nothing to
   distribute. */
.${FS_CLASS}, .${FS_CLASS} .page-width { width: 100%; max-width: none; }
/* The viewer takes the room the strip does not want. min-height: 0 is what
   lets a flex child shrink below its content - without it the canvas keeps its
   600px and the strip is pushed off the bottom. */
/* ...and the viewer instance states its own 948px too (600 canvas + 8 + 340
   panel), so that comes off as well. Between them, .page-width and this were
   the whole reason a 1600px screen still drew a 600px molecule. */
.${FS_CLASS} > .py2dmol-viewer-instance {
    flex: 1 1 auto;
    min-height: 0;
    width: auto;
    max-width: none;
    /* 🔴 AND THE AUTO MARGINS COME OFF, which is the one that cost the most to
       find. .py2dmol-viewer-instance is margin:0 auto to centre the column
       on the page, and an auto margin in the cross axis SUPPRESSES a flex
       item's stretch - so the box kept its content width, width:auto and all,
       and every rule inside it had nothing to fill. getComputedStyle is no help
       here either: width reports the USED value, so the box reads 948px
       whichever rule won. */
    margin: 0;
}
/* #viewer-container is given display:flex INLINE by the JS that reveals it, so
   #mainContainer is a flex ITEM and sizes to its content - 948px, whatever the
   screen is. It has to grow instead. */
.${FS_CLASS} .py2dmol-viewer-instance #mainContainer,
.${FS_CLASS} #mainContainer {
    height: 100%;
    align-items: stretch;
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
}
/* 🔴 WHATEVER WRAPS THE CANVAS, NOT ONE SHELL'S NAME FOR IT. This named
   #viewerColumn, which is index.html's id and index.html's alone: the notebook
   calls the same box #viewerWrapper, so the rule matched nothing there and the
   canvas filled the height and not the width - 570x852 on a 1440x900 screen,
   against 1188x608 on the website. The :has() form says what is meant and
   survives a third shell; the two ids are named after it so that a browser
   without :has() still lays the two we ship out correctly. */
.${FS_CLASS} *:has(> #canvasContainer) { flex: 1 1 auto; min-width: 0; min-height: 0; }
.${FS_CLASS} #viewerColumn,
.${FS_CLASS} #viewerWrapper { flex: 1 1 auto; min-width: 0; min-height: 0; }
/* 🔴 !important, AND ONLY HERE. #canvasContainer carries resize:both, so a
   reader who has dragged its corner has an INLINE width and height on it, and
   nothing but !important beats those. Scoped to the full-screen class, so the
   moment it is dropped the reader's own size is back untouched. */
.${FS_CLASS} #canvasContainer {
    /* 🔴 display: block, AND THAT IS THE WHOLE TRICK. The box is an
       inline-block, so width:auto shrink-wraps it to the canvas inside it -
       and the canvas only resizes when the ResizeObserver sees the BOX change,
       which it never does. The container has to take its width from the column
       instead, and then the canvas follows it. Measured: 600x590 before this
       line, 1182x724 after, on a 1600x900 screen. */
    display: block;
    align-self: stretch;
    width: auto !important;
    height: auto !important;
    flex: 1 1 auto;
    min-height: 0;
    resize: none;
}
.${FS_CLASS} #canvasContainer .resize-handle { display: none; }
.${FS_CLASS} > .sequence-section-container { flex: 0 0 auto; max-height: 40%; margin: 0; }

/* The button itself, in the corner of the canvas box. */
.py2dmol-fs-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 5;
    width: 26px;
    height: 26px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 1px solid var(--color-gray-200, #e5e7eb);
    border-radius: var(--btn-radius, 6px);
    background: rgba(255, 255, 255, 0.82);
    color: var(--color-gray-600, #4b5563);
    font-size: 13px;
    line-height: 1;
    /* 🔴 ALWAYS VISIBLE, NOT ON HOVER. It was revealed by hovering the canvas,
       which hides the one control that is not reachable any other way: nothing
       else on the page says full screen exists, and a reader on a touch screen
       has no hover at all. It is small and it sits over the paper margin rather
       than over the molecule, so it costs nothing to leave up. */
    transition: background 120ms ease, color 120ms ease;
}
.py2dmol-fs-btn:hover { background: #fff; color: var(--color-gray-800, #1f2937); }
`;

function fsStyleOnce() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('py2dmol-fs-css')) return;
    const st = document.createElement('style');
    st.id = 'py2dmol-fs-css';
    st.textContent = FS_CSS;
    document.head.appendChild(st);
}

/**
 * WHAT GOES FULL SCREEN. The viewer instance and the sequence strip are
 * SIBLINGS on the website - neither contains the other - so the element that
 * goes full screen is their parent, and its other children are hidden while it
 * is up. Where there is no strip beside the viewer (the notebook, the embed)
 * the viewer instance goes on its own, which is the whole of what is there.
 */
function fsTargetOf(viewer) {
    const parent = viewer && viewer.parentElement;
    if (!parent) return { target: viewer, hide: [] };
    const strip = parent.querySelector(':scope > .sequence-section-container');
    if (!strip) return { target: viewer, hide: [] };
    const keep = new Set([viewer, strip]);
    // ...and everything else the parent holds: the topbar, the upload box, the
    // MSA buttons. Hidden by inline display, remembered so it goes back.
    const hide = Array.prototype.filter.call(parent.children, (c) => !keep.has(c));
    return { target: parent, hide };
}

function installFullscreen(containerElement, canvasContainer) {
    if (typeof document === 'undefined' || !canvasContainer) return;
    if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) return;
    if (canvasContainer.querySelector('.py2dmol-fs-btn')) return;
    fsStyleOnce();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'py2dmol-fs-btn';
    btn.title = 'Full screen (Esc to leave)';
    btn.setAttribute('aria-label', 'Full screen');
    // A glyph, not an icon font: index.html loads Font Awesome and the notebook
    // does not, and a button whose label is an empty <i> is an invisible button.
    btn.textContent = '\u26F6';
    canvasContainer.appendChild(btn);

    const viewer = containerElement
        && (containerElement.closest ? containerElement.closest('.py2dmol-viewer-instance') : null);
    let hidden = [];

    const enter = () => {
        const { target, hide } = fsTargetOf(viewer || containerElement);
        if (!target) return;
        hidden = hide.map((el) => ({ el, was: el.style.display }));
        for (const h of hidden) h.el.style.display = 'none';
        target.classList.add(FS_CLASS);
        const req = target.requestFullscreen || target.webkitRequestFullscreen;
        if (req) {
            const p = req.call(target);
            if (p && p.catch) p.catch(() => leave());
        }
    };
    const leave = () => {
        for (const h of hidden) h.el.style.display = h.was;
        hidden = [];
        document.querySelectorAll('.' + FS_CLASS)
            .forEach((el) => el.classList.remove(FS_CLASS));
    };
    btn.addEventListener('click', () => {
        const on = document.fullscreenElement || document.webkitFullscreenElement;
        if (on) {
            const ex = document.exitFullscreen || document.webkitExitFullscreen;
            if (ex) ex.call(document);
        } else {
            enter();
        }
    });
    // 🔴 THE EXIT IS THE EVENT, NOT THE BUTTON. Escape and the browser's own
    // chrome leave full screen without going near this button, so the tidy-up
    // hangs off the event - which fires for every way out, the button included.
    document.addEventListener('fullscreenchange', () => {
        const on = document.fullscreenElement || document.webkitFullscreenElement;
        btn.textContent = on ? '\u2716' : '\u26F6';
        btn.title = on ? 'Leave full screen (Esc)' : 'Full screen (Esc to leave)';
        if (!on) leave();
    });
}
