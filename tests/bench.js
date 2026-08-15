/* Render-time benchmark. Requires tests/out/bench.html (python tests/make_bench.py).
 *
 *   node tests/bench.js            # full sweep
 *   node tests/bench.js --quick    # fewer reps
 *
 * Times renderer.render() directly rather than driving the GUI, so the numbers
 * are the draw stage and nothing else. Each cell is the median of REPS timed
 * renders after WARMUP untimed ones; median because the first renders after a
 * settings change pay cache-invalidation costs that are not representative of
 * steady-state interaction (dragging, animation).
 */
const { chromium } = require('playwright');
const path = require('path');

const PAGE = 'file://' + path.resolve(__dirname, 'out/bench.html');
const QUICK = process.argv.includes('--quick');
const WARMUP = QUICK ? 2 : 3;
const REPS = QUICK ? 5 : 9;
const BUDGET_MS = 16.7;          // one frame at 60fps

// Each config is applied to the renderer before timing.
const CONFIGS = [
    { name: 'ribbon (old)', style: 'ribbon' },
    { name: 'cartoon d=1', style: 'cartoon', cartoonDetail: 1 },
    { name: 'cartoon d=4 (default)', style: 'cartoon', cartoonDetail: 4 },
            { name: 'cartoon d=4 thick=0.5', style: 'cartoon', cartoonDetail: 4, cartoonThickness: 0.5 },
    { name: 'cartoon d=4 cel', style: 'cartoon', cartoonDetail: 4, cartoonCel: true },
    { name: 'cartoon d=4 no outline', style: 'cartoon', cartoonDetail: 4, outlineMode: 'none' },
];

const BASE = {   // reset before each config so settings do not leak between cells
    style: 'cartoon', cartoonDetail: 4, cartoonThickness: 0, cartoonCel: false,
    cartoonCelLevels: 4, cartoonHighlight: 1.8, cartoonOutlineTint: 0,
    outlineMode: 'full', relativeOutlineWidth: 3.0, shadowEnabled: true,
};

const fmt = (v) => (v === null ? '  --  ' : v.toFixed(1).padStart(6));

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewportSize: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // 'load' can exceed 30s: the page paints every viewer once on init, and the
    // 10000-residue cartoon alone is a long frame. Wait on the registry instead.
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(
        () => window.py2dmol_viewers && Object.keys(window.py2dmol_viewers).length >= 8,
        null, { timeout: 120000 });
    await page.waitForTimeout(3000);

    const lengths = await page.evaluate(() => {
        // map each viewer id to the residue count of the object it holds
        const out = [];
        for (const [id, v] of Object.entries(window.py2dmol_viewers)) {
            const r = v.renderer;
            const n = (r && r.coords) ? r.coords.length : 0;
            if (n) out.push({ id, n });
        }
        return out.sort((a, b) => a.n - b.n);
    });
    console.log('viewers found:', lengths.map((l) => l.n).join(', '));
    if (!lengths.length) { console.log('no viewers with coords'); await browser.close(); return; }

    const results = {};
    for (const cfg of CONFIGS) {
        results[cfg.name] = {};
        for (const { id, n } of lengths) {
            const ms = await page.evaluate(async ({ id, cfg, BASE, WARMUP, REPS }) => {
                const r = window.py2dmol_viewers[id].renderer;
                Object.assign(r, BASE);
                // Pin full quality. Renders here are back-to-back, so the
                // renderer's gesture detection (idle gap under 150 ms) would
                // otherwise treat every one as part of a drag and silently
                // measure the DOWNGRADED path - which is not what this table
                // claims to report. Drag cost is measured separately.
                r._quality = 'perfect';
                for (const [k, v] of Object.entries(cfg)) if (k !== 'name') r[k] = v;
                if (r._invalidateShadowCache) r._invalidateShadowCache();
                if (r._invalidateSegmentCache) r._invalidateSegmentCache();
                for (let i = 0; i < WARMUP; i++) r.render('bench-warmup');
                const t = [];
                for (let i = 0; i < REPS; i++) {
                    const t0 = performance.now();
                    r.render('bench');
                    t.push(performance.now() - t0);
                }
                t.sort((a, b) => a - b);
                return t[Math.floor(t.length / 2)];
            }, { id, cfg, BASE, WARMUP, REPS });
            results[cfg.name][n] = ms;
            process.stdout.write('.');
        }
    }
    process.stdout.write('\n\n');

    const ns = lengths.map((l) => l.n);
    const w = Math.max(...CONFIGS.map((c) => c.name.length));
    console.log('median render time, ms   (' + REPS + ' reps, ' + WARMUP + ' warmup)\n');
    console.log('config'.padEnd(w) + ' | ' + ns.map((n) => String(n).padStart(6)).join(' '));
    console.log('-'.repeat(w) + '-+-' + ns.map(() => '------').join('-'));
    for (const cfg of CONFIGS) {
        console.log(cfg.name.padEnd(w) + ' | '
            + ns.map((n) => fmt(results[cfg.name][n])).join(' '));
    }

    console.log('\nlargest n still under ' + BUDGET_MS + ' ms (60fps):');
    for (const cfg of CONFIGS) {
        const ok = ns.filter((n) => results[cfg.name][n] !== null && results[cfg.name][n] < BUDGET_MS);
        console.log('  ' + cfg.name.padEnd(w) + ' ' + (ok.length ? ok[ok.length - 1] : '< ' + ns[0]));
    }

    // scaling exponent between the two largest sizes actually measured
    console.log('\nscaling (log-log slope, last two sizes):');
    for (const cfg of CONFIGS) {
        const a = ns[ns.length - 2], b = ns[ns.length - 1];
        const ta = results[cfg.name][a], tb = results[cfg.name][b];
        const slope = (ta && tb) ? Math.log(tb / ta) / Math.log(b / a) : null;
        console.log('  ' + cfg.name.padEnd(w) + ' ' + (slope === null ? '--' : slope.toFixed(2)));
    }

    console.log('\npageerrors:', errors.length ? errors.slice(0, 5) : 'none');
    await browser.close();
})();
