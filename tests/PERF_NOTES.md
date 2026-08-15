# Cartoon rendering performance — measured findings

Everything here is measured, not estimated. Reproduce with `tests/bench.js`
and the scratchpad probes. Sizes are synthetic
protein chains from `tests/make_bench.py` unless stated.

## Where the time goes (10000 residues, full quality)

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

## Harness hazards (both cost real time here)

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
- Cheaper and worth doing first: **LOD** — drop stations for small/distant
  elements. With the paint ceiling at 1.23x and the ink pass at ~28% of a real
  frame, detail reduction remains the only lever measured to move the whole
  frame: 0.5 → 0.15 already gives 1.7x. It attacks `stations × surfaces`
  directly and reduces what a GPU port would need to upload.

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
  `inkQueries`, `inkScans`).
- `tests/make_ribosome.py` — regenerates the 4UG0 page, which was previously
  built ad hoc and could not be reproduced after a source change.
