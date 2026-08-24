// ============================================================================
// src/io/gif.js
// ----------
// AI Context: GIF89a ENCODER (window.py2dmolGif)
// - Palette, LZW, and the file itself. Used by the capture sink when the
//   chosen video format is Animated GIF.
// - Neither maths nor parsing, which is why it is not in either: it landed in
//   src/io/parse.js because that was where loose functions went.
// ============================================================================
// ============================================================================
// GIF89a ENCODER
// ============================================================================
//
// WRITTEN HERE RATHER THAN LOADED. Every other export the viewer makes is
// produced by the browser - PNG by toBlob, WebM and MP4 by MediaRecorder, SVG
// by the canvas2svg port that already lives inside core/mol.js - and GIF is
// the one format with no native encoder behind it. A CDN library would be the
// obvious answer on this page, but the NOTEBOOK viewer loads nothing but
// py2Dmol's own resources, and a capture panel whose options depend on which
// page you are on is only honest if the missing one is genuinely missing.
// So this is the gate: src/io/parse.js is loaded by index.html and by nothing the
// notebook emits, and the panel offers GIF exactly where window.py2dmolGif is.
//
// The output is a normal animated GIF: one global palette, LZW-compressed
// frames, a NETSCAPE2.0 block for looping.

/**
 * Median cut down to `max` colours, over a sample of the pixels.
 *
 * A drawing here is a few flat cartoon colours plus paper grain, which is
 * hundreds of near-white shades - so a fixed cube palette spends most of itself
 * on colours the picture does not contain and quantises the grain into visible
 * banding. Median cut spends the palette where the pixels are.
 *
 * @param {Array<Uint8ClampedArray>} frames - RGBA pixel buffers
 * @param {number} max - palette size, at most 256
 * @returns {Array<Array<number>>} [r,g,b] entries
 */
function gifPalette(frames, max, alphaFloor) {
    // One sample every few pixels, over every frame: an animation that changes
    // colour part way through (a drawing filling in, a trajectory) must not be
    // quantised to the first frame's palette.
    const pts = [];
    const stride = Math.max(1, Math.floor(
        (frames.length * frames[0].length / 4) / 24000)) * 4;
    const floor = alphaFloor || 0;
    for (const f of frames) {
        for (let i = 0; i < f.length; i += stride) {
            // Pixels that are about to become the transparent index are not
            // colours: sampling them spends most of a 256-entry table on the
            // one shade nobody will see.
            if (f[i + 3] < floor) continue;
            pts.push([f[i], f[i + 1], f[i + 2]]);
        }
    }
    if (!pts.length) return [[0, 0, 0]];
    let boxes = [pts];
    while (boxes.length < max) {
        // split the box with the widest channel - the one costing the most error
        let bi = -1; let bw = -1; let ch = 0;
        for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            if (b.length < 2) continue;
            for (let c = 0; c < 3; c++) {
                let lo = 255; let hi = 0;
                for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
                if (hi - lo > bw) { bw = hi - lo; bi = i; ch = c; }
            }
        }
        if (bi < 0 || bw <= 0) break;
        const box = boxes[bi];
        box.sort((a, b) => a[ch] - b[ch]);
        const mid = box.length >> 1;
        boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
    }
    return boxes.filter((b) => b.length).map((b) => {
        let r = 0; let g = 0; let bl = 0;
        for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
        return [Math.round(r / b.length), Math.round(g / b.length),
            Math.round(bl / b.length)];
    });
}

/** LZW, as the GIF spec defines it: variable code width, clear and end codes. */
function gifLzw(indices, minCodeSize) {
    const out = [];
    let cur = 0; let bits = 0;
    const put = (code, width) => {
        cur |= code << bits;
        bits += width;
        while (bits >= 8) { out.push(cur & 255); cur >>= 8; bits -= 8; }
    };
    const CLEAR = 1 << minCodeSize;
    const END = CLEAR + 1;
    let dict = new Map();
    let next = END + 1;
    let width = minCodeSize + 1;
    const reset = () => { dict = new Map(); next = END + 1; width = minCodeSize + 1; };
    put(CLEAR, width);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = prefix * 4096 + k;
        const found = dict.get(key);
        if (found !== undefined) { prefix = found; continue; }
        put(prefix, width);
        dict.set(key, next);
        if (next === (1 << width) && width < 12) width++;
        next++;
        if (next >= 4095) { put(CLEAR, width); reset(); }
        prefix = k;
    }
    put(prefix, width);
    put(END, width);
    if (bits > 0) out.push(cur & 255);
    return out;
}

/**
 * Encode RGBA frames as one animated GIF.
 *
 * @param {Array<Uint8ClampedArray>} frames - one RGBA buffer per frame
 * @param {object} opts - {width, height, delayCs, loop}
 * @returns {Blob} image/gif
 */
function py2dmolGif(frames, opts) {
    const { width, height } = opts;
    const delay = Math.max(2, Math.round(opts.delayCs || 4));
    // TRANSPARENCY IN A GIF IS ONE PALETTE ENTRY, not an alpha channel: a pixel
    // is either that entry or it is opaque. So the cut is binary - anything
    // under half alpha becomes the transparent index - and the antialiased rim
    // of a stroke lands on one side or the other rather than fading. That is
    // the format, not a shortcut; it is also why the frames must not stack, so
    // each one is written with disposal 2 (restore to background) instead of
    // being painted over the one before.
    const clear = !!opts.transparent;
    // FEWER COLOURS IS A SMALLER FILE, and a cartoon has few to begin with:
    // 64 is usually indistinguishable here and about half the bytes.
    const want = Math.max(2, Math.min(clear ? 255 : 256, opts.colors || 256));
    const pal = gifPalette(frames, want, clear ? 128 : 0);
    // A GIF colour table is a power of two, padded with black. With
    // transparency on, the LAST entry is the transparent one and nothing else
    // may quantise to it.
    const TR = clear ? pal.length : -1;
    let bits = 1;
    while ((1 << bits) < pal.length + (clear ? 1 : 0)) bits++;
    const size = 1 << bits;

    // NEAREST COLOUR, CACHED. The cache is what makes this usable: a frame is
    // a million pixels over a few thousand distinct colours, so all but the
    // first occurrence of each is a map lookup instead of 256 distance tests.
    const cache = new Map();
    const nearest = (r, g, b) => {
        const key = (r << 16) | (g << 8) | b;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        let best = 0; let bd = Infinity;
        for (let i = 0; i < pal.length; i++) {
            const dr = r - pal[i][0]; const dg = g - pal[i][1]; const db = b - pal[i][2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bd) { bd = d; best = i; }
        }
        cache.set(key, best);
        return best;
    };

    const bytes = [];
    const push = (...v) => bytes.push(...v);
    const short = (n) => push(n & 255, (n >> 8) & 255);
    const str = (s) => { for (let i = 0; i < s.length; i++) push(s.charCodeAt(i)); };

    str('GIF89a');
    short(width); short(height);
    push(0x80 | ((bits - 1) & 7), 0, 0);      // global table, its size, no background
    for (let i = 0; i < size; i++) {
        const c = pal[i] || [0, 0, 0];
        push(c[0], c[1], c[2]);
    }
    // NETSCAPE2.0: the only way to say "loop forever" in a GIF
    push(0x21, 0xFF, 11); str('NETSCAPE2.0'); push(3, 1, 0, 0, 0);

    const minCode = Math.max(2, bits);
    for (const f of frames) {
        // graphic control: disposal 2 and the transparent flag when the frames
        // are cut out, plain "leave it there" when they are not
        push(0x21, 0xF9, 4, clear ? 0x09 : 0);
        short(delay); push(clear ? TR : 0, 0);
        push(0x2C); short(0); short(0); short(width); short(height); push(0);
        const idx = new Uint8Array(width * height);
        for (let i = 0, p = 0; i < f.length; i += 4, p++) {
            idx[p] = (clear && f[i + 3] < 128) ? TR
                : nearest(f[i], f[i + 1], f[i + 2]);
        }
        push(minCode);
        const data = gifLzw(idx, minCode);
        for (let i = 0; i < data.length; i += 255) {
            const chunk = data.slice(i, i + 255);
            push(chunk.length, ...chunk);
        }
        push(0);
    }
    push(0x3B);
    return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

if (typeof window !== 'undefined') {
    window.py2dmolGif = py2dmolGif;
}
