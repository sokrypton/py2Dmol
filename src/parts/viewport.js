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
    const measure = () => {
        if (!canvasContainer || !cssSized) return null;
        const r = canvasContainer.getBoundingClientRect();
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
        if (!canvasContainer) return;
        if (!window.ResizeObserver) {
            console.warn('py2dmol: ResizeObserver not supported.'
                + ' Canvas resizing will not work.');
            return;
        }
        const observer = new ResizeObserver((entries) => {
            if (!entries || entries.length === 0) return;
            markReal(entries[0].contentRect);
            const newWidth = Math.max(entries[0].contentRect.width, 1);
            const newHeight = Math.max(entries[0].contentRect.height, 1);
            if (!moved(newWidth, newHeight)) return;
            lastWidth = newWidth;
            lastHeight = newHeight;
            applySize(newWidth, newHeight);
            renderer._updateCanvasDimensions();
            renderer.render('ResizeObserver');
        });
        observer.observe(canvasContainer);
    };

    return { canvas, ctx, dpr, width, height, attach, settle };
}
