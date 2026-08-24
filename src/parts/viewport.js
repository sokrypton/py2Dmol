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
    const width = config.display?.size[0] || 300;
    const height = config.display?.size[1] || 300;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // ...and the box the canvas sits in, which is what actually resizes. The
    // notebook's markup has all three; an embed has none of them, and the page
    // still works - it simply does not follow its container.
    const canvasContainer = containerElement.querySelector('#canvasContainer');
    const viewerWrapper = containerElement.querySelector('#viewerWrapper');
    if (canvasContainer) {
        canvasContainer.style.width = width + 'px';
        canvasContainer.style.height = height + 'px';
        if (viewerWrapper) viewerWrapper.style.width = width + 'px';
    }

    const attach = (renderer) => {
        if (!canvasContainer) return;
        if (!window.ResizeObserver) {
            console.warn('py2dmol: ResizeObserver not supported.'
                + ' Canvas resizing will not work.');
            return;
        }
        let lastWidth = width;
        let lastHeight = height;
        const observer = new ResizeObserver((entries) => {
            if (!entries || entries.length === 0) return;
            const newWidth = Math.max(entries[0].contentRect.width, 1);
            const newHeight = Math.max(entries[0].contentRect.height, 1);
            // ...sub-pixel jitter is not a resize, and treating it as one
            // rebuilds the projection on every frame the layout settles for.
            if (Math.abs(newWidth - lastWidth) < 0.5
                && Math.abs(newHeight - lastHeight) < 0.5) return;
            lastWidth = newWidth;
            lastHeight = newHeight;

            canvas.width = newWidth * dpr;
            canvas.height = newHeight * dpr;
            canvas.style.width = newWidth + 'px';
            canvas.style.height = newHeight + 'px';
            if (viewerWrapper) viewerWrapper.style.width = newWidth + 'px';

            const c = canvas.getContext('2d');
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.scale(dpr, dpr);

            renderer._updateCanvasDimensions();
            renderer.render('ResizeObserver');
        });
        observer.observe(canvasContainer);
    };

    return { canvas, ctx, dpr, width, height, attach };
}
