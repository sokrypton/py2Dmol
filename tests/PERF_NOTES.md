# Cartoon rendering performance — measured findings

Everything here is measured, not estimated. Reproduce with `tests/bench.js`
and the scratchpad probes. Sizes are synthetic
protein chains from `tests/make_bench.py` unless stated.

## Where the time goes (10000 residues, full quality)

> Earlier era, synthetic chains. For a real structure measured in Chrome, see
> "Where a real frame actually goes" below — the shares are quite different.

| phase | ms | share |
|---|--:|--:|
| build (JS geometry) | 187 | 27% |
| sort | 6 | 1% |
| paint (canvas) | 502 | 72% |

Paint issues **262,506 draw calls** per frame at ~1.9 µs each
(136,419 `fill` + 126,087 `stroke`), i.e. **4.2 fills per primitive**, each with
a different tone by construction.

## The real cost equation

    fills ≈ stations × surfaces

NOT primitives. Cutting a strip into pieces regroups stations; it does not
change how many sub-quads get filled.

Only two levers move it:
- **Detail** (stations per residue) — 0.5 → 0.15 gives 1.7×
- **Surfaces** — dropping the outline (1 of ~5 passes) gives ~2.5×

## Things tried that did NOT work — do not retry without new information

| attempt | result | why |
|---|--:|---|
| remove `fillQuadSafe` seam stroke | ~7% | stroke is cheap next to its fill; reintroduces AA seams |
| batch consecutive same-colour fills | n/a | avg run length 1.25–1.69; draw order is depth order, which does not correlate with colour |
| cel shading to collapse colours | 1.15× | collapses 39k → 4.6k distinct colours, but repeats are not adjacent so cannot be merged. (Its real gain is `pathStrip`: 136k → 97k fills) |
| memoise `shade()` | 0% (slightly worse) | key computation + Map probe ≈ cost of building the string |
| reduce cuts (quarter → none) | 6% | halves prims (32.8k → 16.2k) but stations are unchanged |
| WebGL2 batched painter (hybrid) | 1.6× | removes rasterization only; CPU still rebuilds and marshals every quad every frame |
| structure-of-arrays for the occluder store (typed arrays + counting sort) | 1.45× in Node, **nothing in Chrome** | REVERTED. 85k short-lived objects a frame are nearly free in Chrome — young-generation allocation is a pointer bump and they all die immediately. See "Node's V8 is not Chrome's V8" below; this is the trap that cost the most time here |

## What is shipped

- ~~**Drag downgrade** above 3000 residues~~ — REMOVED. It was worth 3.5× on
  synthetic and 2.5× on 4UG0, but it dropped the outline and clamped detail
  *while dragging* and restored them on release. A drawing that changes as you
  move it reads as a bug, not as an adaptation, so the whole mechanism
  (`_fastAbove`, `DRAG_DETAIL`, the debounced re-render) is gone.
  `renderer._quality = 'fast'` still selects cheap ink explicitly.
- **Adaptive ink-grid pitch** sized from occluder count (was fixed `CELL=24`,
  which put 4284 occluders in each of 34 occupied cells and made the ink pass
  scale ~n^1.8). 4.6× at 10000, output pixel-identical.
- **Painter seam**: `renderer.cartoonPainter` with
  `quad(x0,y0,x1,y1,x2,y2,x3,y3, fill, stroke, lineWidth)` plus optional
  `begin`/`end`. Verified: a custom backend receives every quad (30,798 on a
  2500-residue structure) and reproduces the frame pixel-identically. Routes
  `fillQuadSafe` only — tubes, plate outlines, the ink pass, dots and lines
  still talk to `ctx` directly.

Two bugs found here, both latent because the code path never ran:
- fast-ink path threw `col is not defined` (out-of-scope variable)
- gesture detection measured from render *start*, so a 700 ms frame always
  exceeded the 150 ms window — the downgrade could never fire on the structures
  that needed it. Fixed to end-to-start, and later removed with the rest of the
  downgrade.

## Current numbers

| | ribbon | cartoon | (former drag path) |
|---|--:|--:|--:|
| 10000 synthetic | 16.8 ms | ~1050 ms | ~190 ms |
| **4UG0** (17,789 pos, 5,869 nucleic) | **28 ms** | **1397 ms** | **564 ms** |

The third column is what the removed drag downgrade achieved. It is kept as the
measure of what a future optimisation would have to match WITHOUT changing the
drawing — that was the reason it went.

4UG0 parses in 0.4 s, finds 1598 base pairs, renders correctly.

## The paint backend has a hard ceiling of 1.23x — measured

Replace `painter.quad()` with a no-op, removing ALL quad rasterisation, and
time what is left. That is the best any paint backend can ever do — GPU,
WebGPU, anything.

| n | full | painter.quad no-op | ceiling |
|--:|--:|--:|--:|
| 500 | 32.3 | 26.7 | 1.21x |
| 2500 | 215.6 | 151.1 | 1.43x |
| 10000 | 1154.6 | 937.9 | **1.23x** |

With the outline off the ceiling rises to 1.74x, which is why the earlier
WebGL2 prototype measured 1.6x — it was benchmarked with `outlineMode:'none'`.
In the DEFAULT configuration a perfect GPU painter is worth 23%.

**This retires the GPU-painter idea.** The fills are not the bottleneck.

## Where the time actually goes: the ink pass

> Earlier era. Still the right shape - the query loop dominates the ink pass -
> but for current per-stage numbers on a real structure in Chrome see "Where a
> real frame actually goes" below. Two things in this section have since been
> re-tested and did NOT reproduce as levers: the cell pitch (swept 2-24, the
> curve is flat) and any rewrite of the grid's data layout.

| n | total | ink | ink % | grid build | grid sort | query | stroke |
|--:|--:|--:|--:|--:|--:|--:|--:|
| 500 | 34 | 13 | 39% | 2 | 4 | 7 | ~0 |
| 2500 | 201 | 83 | 41% | 14 | 6 | 63 | ~0 |
| 10000 | 1093 | 606 | **55%** | 66 | 25 | **515** | ~0 |

The query loop is the single largest line item in the whole renderer, and it
scales badly: **68.5 M occluder scans for 271 k queries at 10000 residues —
253 scans per query**, rising with n (29 → 79 → 76 → 150 → 253 across
500..10000).

The adaptive cell pitch did not fix this, it relocated it. Cells are sorted
far-to-near and the loop breaks at the first occluder that is not nearer — but
in a dense structure most surfaces genuinely ARE nearer, so the break never
fires and each query walks its entire cell list.

Note the ink share is much lower on REAL structures (4UG0 28%, nucleic set
30%) than on synthetic chains (55%), because the synthetic benchmark renders
sub-pixel-thin ribbons where ink dominates. **Use real structures to size any
ink optimisation.**

## Depth-buffer occlusion — implemented, works, NOT default

`renderer._inkMode = 'zbuf'` rasterises every occluder into a Float32 depth
buffer once, making each visibility query a single array lookup instead of a
253-occluder scan. Occluder collection, the ink curves and the vector output
are all unchanged, so SVG export is unaffected.

It does what it claims:

| | ink pass | total frame |
|---|--:|--:|
| 4UG0 | 356 → 143 ms | 1290 → 1074 (1.20x) |
| nucleic 3503 | 68 → 27 ms | 223 → 197 (1.13x) |
| synthetic 10000 | 606 → 61 ms | 1093 → 579 (1.86x) |

**Why it is off by default** — a depth buffer answers at pixel resolution where
the analytic test answers exactly at the query point:

- 5–12% of drawn pixels differ from the analytic render.
- Outline segments flip visible/hidden **2x as often** between nearly identical
  views (churn 3.9–4.7 vs grid's 1.9–2.0 per 1000 segments per 0.02°). This is
  directly visible as flickering outlines while dragging.
- Since the gesture downgrade was removed, the ink pass runs on every frame, so
  this optimisation now applies while dragging too — but so does its flicker,
  and a wrong outline is more noticeable than a slower one.

Tuning attempts, all measured, none sufficient:

| attempt | result |
|---|---|
| slope-scaled bias (min depth over the pixel) | essential — without it outlines drop out everywhere (15% → 5% pixel diff) |
| bias multiplier k = 0,1,2,4,8 | churn improves to k=4 then flattens, but pixel fidelity gets *worse* (7% → 12%). Fidelity and flicker trade off; neither reaches the analytic path |
| bilinear depth sampling | no change (churn 4.74 → 4.90) |
| 2x / 3x supersampled depth buffer | slightly WORSE (4.74 → 5.48 → 5.49) |

The last two are the informative ones: the error is not sample position and not
resolution, so it cannot be filtered or supersampled away. It is that the
buffer keeps only the NEAREST surface per pixel, while the analytic test
considers every surface at an exact point.

An exact hybrid is possible — use the depth buffer as a conservative filter and
fall back to the analytic query only in the ambiguous depth band — but it still
needs the grid built (122 ms of the 356 ms on 4UG0), so it caps out near 1.1x
end to end. Not worth the complexity.

## Node's V8 is not Chrome's V8 — measure allocation-heavy code in the browser

The most expensive lesson in this file. An occluder-grid rewrite (flat typed
arrays plus one counting sort, in place of one object per occluder, a JS array
per cell and a comparator sort per cell) measured **1.45× on the ink pass and
1.27× on the frame** in the Node harness, over 20 structure/view cases, with
the ink trace bit-identical throughout.

In Chrome the same change is **neutral to slightly negative**. Interleaved
A/B/C in one page load (hot-swapping the plugin between timed batches, so the
renderer, the structure and the machine state are identical), 1VQ8, outline on,
gesture degrade off, min of 9:

| | collect | cell build | query | frame |
|---|--:|--:|--:|--:|
| existing (objects + per-cell arrays) | 17.4–17.7 | 18.4–18.9 | 40.0–40.8 | 235–241 |
| rewrite (SoA + counting sort) | 18.0–18.3 | 23.6–24.5 | 36–52 | 241–247 |

The collection pass Node measured at ~40 ms costs **8.8 ms** in Chrome for the
same frame. Chrome's young-generation allocation and escape analysis simply eat
the pattern the rewrite existed to remove, and the counting sort is *worse*
than thousands of small stable sorts there.

**The rewrite was reverted.** What survives is `tests/smoke.js`'s pitch
test (below) and this warning.

Corollaries, all measured the same way:

- `wrapIdx` split into two closures by `cyclic` instead of branching inside:
  17 ms of a 313 ms frame in Node, **nothing** in Chrome.
- Cell index by reciprocal multiply instead of division: nothing in either.
- Inlining `shade()`'s per-channel `ch` closure: nothing in either (Chrome and
  Node both escape-analyse it away).
- Moving the four cell-span floor-and-clamps out of the per-occluder emitter
  into a tight pass over the boxes: 34 ms in Node, nothing in Chrome.

Use Node for **correctness oracles**, which is what it is good for — the ink
trace and the paint-stream hash below are exact and fast there. Take every
timing decision in the browser.

## The oracles

Two, both cheap, both used to prove the reverted rewrite was output-identical
before it was thrown away for being pointless:

- `renderer._inkTrace = []` — one bit per ink segment, deterministic order.
- **paint-stream hash** — a recording ctx that hashes every drawing call and
  style assignment in order, at full precision (28.9k ops on 1TIM, 306k on
  1VQ8). Nothing is rounded, so it catches arithmetic reordering, which is
  exactly what a "surely equivalent" rewrite risks.

Run both over five structures × four views (two rotations, a zoom, a
perspective setting). A change that claims to be a pure optimisation must not
move a single bit of either.

`tests/smoke.js` guards the grid itself with one implementation-independent
test: **the ink trace must be identical at cell pitches 3, 7 and 24.** The grid
is an accelerator, so the pitch may change how fast an answer is reached and
never the answer. It catches an unsorted cell list and an occluder that misses
a cell it covers, and it was mutation-confirmed against both the old and the
new implementation. One caveat found while writing it: the invariant genuinely
fails for **off-canvas** query points, because the grid covers
`ceil(W / CELL) · CELL` pixels — so the fixture stays inside the canvas.

## Where a real frame actually goes (Chrome 151, measured)

1VQ8 (6655 positions), 598 CSS px at dpr 2, cartoon, outline on, gesture
degrade off, min of 9 renders:

| | ms | share |
|---|--:|--:|
| geometry build | 45 | 18% |
| ink pass | 81 | 33% |
| rest of the paint loop (JS) | ~73 | 29% |
| canvas rasterisation | ~50 | 20% |
| **frame** | **249** | |

Canvas share measured by no-op'ing every `CanvasRenderingContext2D` drawing
method: 232 → 182 ms, i.e. **a perfect painter is worth 1.28×** — the 1.23×
from the older measurement, confirmed in Chrome on a real structure. The GPU
painter stays retired.

Outline off is 249 → 157 ms (1.6×), which is a user control, not an
optimisation.

Ablated in Chrome by hot-swapping short-circuited builds between timed
batches in one page load (1VQ8, same view, min of 9):

| removed | frame | costs |
|---|--:|--:|
| nothing | 233–246 | |
| `shade()` returns a constant string | 222–233 | shading, arithmetic and string both, **≈12 ms (5%)** |
| `painter.quad` returns immediately | 180–182 | every routed fill, path building included, **≈52–64 ms (25%)** |

So the frame divides roughly into fills 25%, ink 33%, geometry 18%, shading 5%,
and a diffuse remainder. Nothing left is a soft target: the fills are already
merged by `pathStrip`, the shading is 5%, and the ink pass is near the floor
for an exact analytic test.

**The detail lever is gone, and the notes above are stale about it.** At
fit-to-view on a large structure, `cartoonDetail` 4, 2 and 1 all produce
16658 primitives and the same frame time: the auto-subdivision cap
(`subCapCur`, sized from pixels per residue) has already clamped to `MIN_SUB`,
so there is nothing left for the detail control to remove. It only bites
zoomed in — at zoom 4, detail 4 → 1 is 121 → 100 ms — which is where frames
are cheap anyway. Any future LOD work has to beat what the pixel cap already
does, not the raw detail setting.

## WASM: measured, and not the thing to do

- WASM cannot draw. Every quad still crosses into JS for `ctx.fill()`, and a
  perfect painter is 1.28×.
- Inside the part it could own, the code is not losing to JS on arithmetic. The
  Node profile said it was, twice, and Chrome disagreed both times.
- The remaining JS cost is diffuse: no hot line survives in the geometry loop
  once `wrapIdx` is discounted, and the ink query loop is already near the
  floor for an exact analytic test.

If the goal is a responsive UI rather than a faster frame, the honest next step
is **not blocking on it** — OffscreenCanvas in a worker — rather than making
the same work go faster.

## Harness hazards (both cost real time here)

- **A mock ctx that answers every property with a function selects the SVG
  path.** `svgStrips` is `!!ctx.getSerializedSvg && !!ctx.createLinearGradient`,
  so a permissive Proxy context makes it true and the renderer runs the SVG
  depth-cull that the screen never runs — one profile had 36% of the frame in
  a function the canvas path does not call. Return `undefined` for
  `getSerializedSvg`.
- **Coordinates must be Vec3-like, with `.x`/`.y`/`.z`.** Passing plain
  `[x, y, z]` arrays makes the hydrogen-bond search bin every residue under
  `"NaN,NaN,NaN"`, so secondary-structure assignment goes quadratic: 36 seconds
  for the first frame of a 7000-residue structure, entirely an artifact.
  `tests/paint_order_audit.js` sidesteps this only because `_forceSec` skips
  the assignment.
- **Test pages bundle the minified build.** `tests/out/*.html` embed
  `viewer-cartoon.min.js`. After editing the source you must re-run terser AND
  regenerate the pages, or you are measuring the old renderer. Two rounds of
  results were invalidated this way — including a "pixel-identical" correctness
  result that was vacuous because the ink pass was not running at all.
- **The third render after a settings change differs from the first two** (a
  cache fills once). Warm up with 3 renders before capturing a reference image,
  or a same-vs-same comparison reports ~29% differing pixels.
- `_quality = 'perfect'` in the harnesses is now a no-op (kept because it is
  harmless): with the gesture downgrade removed, every frame is full quality.

## Why a full GPU port is the next thing

Written before the ink-pass rewrite above; the ink numbers quoted here are the
old ones (that pass is now 2× faster), but the argument about the outline is
unchanged and is still the thing to settle first.

The 1.6× hybrid is not the ceiling. The renderer recomputes **everything** per
frame because rotation is applied CPU-side, yet almost all the expensive work is
view-independent:

| | view-dependent? |
|---|---|
| slab rails (Lp/Lm/Rp/Rm, 3D) | no — function of coords + SS |
| pairing, base frames, plates | no — already cached on unrotated coords |
| projection | yes → vertex shader |
| tone/luminance vs eye | yes → fragment shader |
| backface culling | yes → native |
| depth ordering | yes → depth buffer |

Build the 3D geometry once, upload it, and a rotation becomes one uniform update
plus one draw call. That targets the whole ~1100 ms, not the 72% paint slice.

Notes for that work:
- **The outline is the hard part, and the depth-buffer experiment above is the
  warning.** A GPU determines visibility at pixel resolution; this renderer's
  outline is a VECTOR pass whose visibility is currently decided exactly at each
  query point. Moving that decision to any pixel-resolution buffer — CPU or GPU
  — reproduces the measured artifacts: ~2x the segment flicker and 5–12% pixel
  disagreement, and neither supersampling nor filtering removes it. Any GPU
  design must either keep the analytic ink test on the CPU (in which case the
  ink pass, ~28% of a real frame, does not speed up at all) or accept flickering
  outlines. Settle this before writing shaders.
- No depth buffer is strictly needed if quads are submitted in sorted order — a
  GPU rasterises primitives in order. A depth buffer would retire the
  painter's-algorithm problems this file works around (interpenetrating rungs,
  outline ordering) but see the point above about the ink pass.
- Canvas and WebGL cannot share one canvas; render to an offscreen GL canvas and
  `drawImage` it, or move everything to GPU.
- **SVG export must keep working** — it rides the canvas path via
  `SimpleCanvas2SVG`. Keep shading CPU-side and shared, or exports silently
  drift from the screen. Add a test that renders both and compares.
- ~~Cheaper and worth doing first: **LOD**~~ — SUPERSEDED. The auto-subdivision
  cap already does this: at fit-to-view on a large structure the detail control
  changes neither the primitive count nor the frame time, because `subCapCur`
  has clamped to `MIN_SUB` from pixels per residue. See "Where a real frame
  actually goes" above. LOD work now has to beat the pixel cap, not the raw
  detail setting.

Prototype: `tests/gpu_prototype.js` (WebGL2 painter, one draw call, in
submission order, colour parsed from the `rgb()` string with a memo). Remember
its 1.6x was measured with the outline OFF; at default settings the ceiling for
that whole approach is 1.23x.

## Tools added for this work

- `renderer._inkMode` — `'grid'` (default, exact) or `'zbuf'` (depth buffer).
- `renderer._inkBias`, `_inkSample`, `_inkSS` — zbuf tuning knobs.
- `renderer._inkTrace` — set to `[]` before a render to collect one bit per ink
  segment in deterministic order. Diffing two traces across a tiny rotation is
  the only reliable flicker metric; a pixel diff is swamped by the geometry's
  own motion.
- `renderer._phase` — set to `{}` to collect build/sort/paint plus ink
  sub-stage timings (`inkStart`, `inkGrid`, `inkSorted`, `inkStroke`, `inkEnd`,
  `inkQueries`, `inkScans`, `inkCell`, `inkCells`, `inkOccRefs`).
- `tests/make_ribosome.py` — regenerates the 4UG0 page, which was previously
  built ad hoc and could not be reproduced after a source change.

## Where the time is now (Aug 2026, after the GPU work)

Rendering is no longer the expensive part of this app. On an M2, 598 px:

| | tube frame | cartoon frame | load to first picture |
| --- | --- | --- | --- |
| 1TIM (492 seg) | ~0.3 ms | 0.51 ms | 70 ms |
| 4UG0 (17.4k seg) | 4.1 ms | 4.6 ms | 1.1 s |
| 3J3Q (312k seg) | ~26 ms | - | **15.6 s** |

**Loading a capsid is now the slowest thing in the product by two orders of
magnitude.** 3J3Q is 242 MB of text and 2.4M atoms, and the 15.6 s splits four
ways, none of them a silver bullet:

| stage | ms | share |
| --- | --- | --- |
| parse, including biounit expansion | 2,823 | 18% |
| frame loop: `convertParsedToFrameData` | 2,344 | 15% |
| frame loop: everything else | 3,685 | 24% |
| align and centre | 62 | - |
| `applyPendingObjects` (i.e. `addFrame` per frame) | 4,723 | 30% |
| first render | 1,911 | 12% |

Every one of those is a pass over 2.4M atoms or 313k positions. Parse is
already the *cheapest* of the big four, having been worked over once - which is
worth knowing before optimising it again, as the obvious target.

**How to reproduce this without touching the source.** The top-level split
needs no instrumentation at all: `parseCIF`, `buildPendingObject` and
`applyPendingObjects` are script-scope globals, so wrapping them from the page
times each. Only the split *inside* the frame loop needed temporary marks, and
those were reverted.

    const o = window.buildPendingObject; let ms = 0;
    window.buildPendingObject = function () {
        const a = performance.now();
        try { return o.apply(this, arguments); } finally { ms += performance.now() - a; }
    };

**What would actually move it** is the columnar atom model - the same
conclusion the parser work reached from the other end. Four separate passes
each walk 2.4M atom OBJECTS; the parse builds them, `convertParsedToFrameData`
reads them into typed arrays, and the rest re-walks them for residue grouping
and bonds. Whether that is worth doing is a design decision about the interface
between `web/utils.js`, `web/app.js` and `viewer-mol.js`, not an optimisation.

### The first thing the loader profile found: setCoords was quadratic

`setCoords` cost 3.6 s of a capsid's 16 s load - 11.5 microseconds per
position - and all of it was one loop asking, for every CHAIN, whether any
position in it carries a polymer type:

    for (const chainId of sortedUniqueChains)      // C
        for (let i = 0; i < n; i++)                // x N
            if (this.chains[i] === chainId) ...

3J3Q is 1,356 chains and 313,236 positions: **425 million string
comparisons**. The question is per POSITION, not per chain - walk the
positions once, note the chain of each polymer one, and any chain not noted
is ligand-only. O(n + chains), same answer.

| | before | after |
| --- | --- | --- |
| `setCoords` | 3,590 ms | **355 ms** |
| `setFrame` | 3,648 ms | 411 ms |
| `applyPendingObjects` | 5,862 ms | 2,534 ms |
| 3J3Q load to first picture | 16.5 s | **13.2 s** |
| 4UG0 load to first picture | 1.10 s | 0.94 s |

Verified equivalent where it actually matters: with ligands loaded, 4HHB has
6 ligand-only chains, 1HVR 1 and 3PTB 2, and the one-pass version finds the
same sets. Note the first check ran with ligands OFF - which is the default -
and every structure reported zero ligand-only chains, so it proved nothing.
A test of this needs ligands on.

**Why it hid for so long**: the cost is quadratic in CHAINS, and almost
everything has a handful. 4UG0's 81 chains cost 160 ms of its 1.1 s load and
looked like ordinary work. Only a capsid, with more than a thousand chains,
makes it the largest single item in the profile.

### ...and the second: the frame loop converted every model twice

`convertParsedToFrameData` measured 5.5 s on a capsid, against 2.8 s for the
call that feeds the drawing. It has two call sites, and the first one converts
the model AGAIN with `includeAllResidues=true`, then builds a residue map over
every atom and classifies every position.

All of that exists to produce one array, `originalIsLigandPosition`, which is
read in exactly one place: the `if (paeData)` branch, to line a PAE matrix up
with the positions it was computed for. It was being built for every structure
whether it had a PAE or not - and most do not.

Guarding the block on `paeData` takes `buildPendingObject` from 9,284 ms to
6,500 on 3J3Q.

**Testing it needed a structure with ligands AND a PAE**, which is not a
combination that occurs naturally: AlphaFold models carry a PAE and no ligands,
PDB entries carry ligands and no PAE. Pairing 4HHB with a synthetic 801x801 PAE
whose values vary with both indices, and loading with ligands ON so the filter
actually runs, gives 748 positions and 641,601 PAE bytes with checksum
3083556608 - identical before and after. A test that skips the ligands
checkbox proves nothing here, the same trap as the ligand-only chains above.

### Where the capsid load stands

| stage | before | now |
| --- | --- | --- |
| parse | 2,855 | 2,910 |
| frame loop (build minus parse) | 6,181 | 3,382 |
| `applyPendingObjects` | 4,723 | 2,299 |
| first render | 1,911 | 1,978 |
| **total** | **16.5 s** | **8.6 s** |

4UG0 goes 1.10 s to 0.69 s. Both wins were algorithmic and neither needed the
columnar rewrite: one loop that was quadratic in chains, and one whole pass
that did not need to run. Profile before restructuring.

### ...and the third: chem_comp_bond walked every residue to find nothing

`convertParsedToFrameData` was 3.3 s on a capsid, and 2.06 s of it was the
`chemCompBondMap` pass. It walks every residue in the structure and, for each
bond that residue's component defines, builds three template literals to look
two atoms up by name in `atomIdToIndex`.

A protein residue contributes exactly ONE position - its CA. A nucleic one
contributes its C4'. So both ends of an INTRA-residue bond can never be found
for either, and the pass spends its time proving that: on 3J3Q, 313,236
residues x ~15 bonds = 4.7 million lookups and 14 million strings, producing
nothing.

Only a ligand puts more than one atom in `coords`, so only a ligand can carry
one of these bonds. Collecting those residues as they are built and iterating
that list gives the same bonds over a handful of residues instead of all of
them: `buildPendingObject` 6,469 -> 4,316 ms.

Verified with ligands ON, comparing an order-independent checksum of the bond
list before and after: 4HHB 200 bonds / 3140046280, 3PTB 9 / 2820525387,
1HVR 52 / 1448305941, 1AOI 0. Identical.

### The capsid load, end to end

| stage | at the start | now |
| --- | --- | --- |
| fetch | 477 | 387 |
| parse | 2,855 | 2,854 |
| frame loop (build minus parse) | 6,181 | 1,327 |
| `applyPendingObjects` | 4,723 | 2,328 |
| first render | 1,911 | 1,863 |
| **total** | **16.5 s** | **6.5 s** |

4UG0 goes 1.10 s to 0.42 s. **2.5x on the capsid and none of it was the
columnar rewrite** that was the plan going in: one loop quadratic in chains,
one whole pass that only a PAE needs, and one pass that could not produce a
result for 99% of what it iterated. Parse is now the largest single stage and
is the one part that has already been optimised once.
