# Cartoon renderer test pages

Visual test harness for the `style="cartoon"` renderer (`py2Dmol/resources/viewer-cartoon.js`).
These are eyeball tests, not assertions — they exist because the cartoon
failures that matter (paint order, silhouette breaks, tone pops) are things you
see, not things you can easily assert.

```bash
python tests/build.py --serve     # build all pages, serve on http://localhost:8931
python tests/build.py             # build only, into tests/out/
```

Needs `numpy` and `ipython` (py2Dmol imports IPython at module load), so run it
from an environment that has them — a bare system `python3` will fail on
`ModuleNotFoundError: No module named 'IPython'`.

Each page inlines the viewer JS at build time, so **rebuild after every edit to
`viewer-*.js`** — a stale page is indistinguishable from a fix that did nothing.
`build.py` runs against the working tree (it puts the repo root on `sys.path`),
so it picks up `viewer-cartoon.js` directly; the `.min.js` bundle is only used
by the packaged Python path.

| Page | What it isolates |
| --- | --- |
| `box_test.html` | Slab ladder: one box (2 res), a straight beam (4 res, tests joints without curvature), a minimal 3-residue curve, and a 6-residue helix piece. Forces secondary structure via `renderer._forceSec`, so it exercises slab geometry with nothing else in the scene. |
| `helix_big.html` | Ideal 12-residue alpha helix. Smallest case that shows a full winding. |
| `helix_test.html` | Ideal 30-residue alpha helix on a 900px canvas. The main case for thickness-band paint order — the ribbon twists ~100°/residue, so every winding sweeps the width normal through the viewer. |
| `paint_order_lab.html` | Standalone, dependency-free ribbon/side-chain sorting lab. Compares the shipped body-centroid order, global per-surface order, one depth-sorted shared seam rail, adaptive ribbon and stick tiling, triangle primitives, and a triangle z-buffer reference. Includes two stress presets, independent tile sweeps, and a ribbon×stick error grid. Open this source file directly; `build.py` does not generate it. |
| `cartoon_test.html` | Real structures (1YNE, 1UBQ, 1BJP) with ribbon and cartoon side by side. Fetches from RCSB on first run. |
| `na_test.html` | Nucleic acids: B-DNA duplex, tRNA, nucleosome, poly(A)·poly(U), a modified-base complex. Base-pair plates and backbone frames. |
| `ligand_test.html` | Ligand occlusion (4HHB, 3PTB, 1HVR). Generic segments are painted as opaque strokes but are easy to leave out of the ink pass's occluder set, which shows as the backbone outline drawing straight through a ligand. |
| `richardson_test.html` | Richardson preset beside the plain cartoon on four SS compositions (3CHY, 1TIM, 2POR, 1BBH). 1TIM is the control — it is the subject of the original drawing. |
| `ribosome.html` | 4UG0, the large-structure performance case (17,789 positions). Built separately: `python tests/make_ribosome.py`. |

## Assertions — `smoke.js` / `interaction.js` / `sequence.js` / `copy_selection.js`

Unlike the pages above, these assert, and need no browser:

    node tests/smoke.js                                          # source
    node tests/smoke.js py2Dmol/resources/viewer-cartoon.min.js  # bundle
    node tests/interaction.js
    node tests/sequence.js
    node tests/copy_selection.js

`smoke.js` renders synthetic structures through a mock 2D context and checks
properties of what gets painted: closed solids, no inked edge crossing its own
face, junction construction, side chains following a flattened backbone, and
the flat-slab and gesture-budget rules. Run it against the bundle too — a
mangler can break what the source proves.
`interaction.js` runs the gesture and animation predicates from `viewer-mol.js`
against a mock canvas, plus `_materialiseSidechains`, side-chain picking, and
orient's centre/extent arithmetic from `web/app.js` — all lifted out of the
source text rather than reimplemented.

`sequence.js` drives the sequence strip's input layer through a DOM stub:
synthetic clicks, drags, taps and scrollbar drags against `viewer-seq.js`, with
the selection read back off the renderer. **Every shared behaviour is asserted
through BOTH pointer types**, which is the point of the file — the strip used
to carry two independent copies of the selection logic, and the touch copy was
the older one, so a tap on a chain label toggled that chain's *visibility*
while a click toggled its *selection*, dragging across chain labels worked only
with a mouse, and the scrollbar could not be touched at all (a phone has no
wheel event, so a long sequence had nothing below the first screenful
reachable). Two structural tests keep that from coming back: neither pointer
listener may name the selection helpers directly, and no listener may be
registered under a name that cannot fire — both handlers had been sitting
disabled by an `__DISABLED` suffix on their event name for long enough that the
live copies drifted.

`tests/gpu_bench.py` reports **per-pass GPU time for the tube path** on the real
GPU, from the shell:

    python3 tests/gpu_bench.py 4UG0.cif
    python3 tests/gpu_bench.py 3J3Q.cif --frames 16 --png /tmp/capsid.png

Use it for any change to `drawTube`. Timing `render()` with `performance.now()`
does NOT work - a draw call returns when it is queued, and the submit read
0.28 ms for a frame the GPU spent 13.6 ms on. The numbers come from
`EXT_disjoint_timer_query_webgl2`, which the renderer emits whenever
`window.__gpuTimers` is set, into `window.__gpuTimes`. The script prints which
renderer produced them: a software rasteriser has the opposite vertex/fragment
balance and its timings do not transfer. See the tube section of
`GPU3D_NOTES.md` for the current baseline.

`tests/multi_object.py` drives **several objects on screen at once** through a
real browser - the merge, the list UI, and everything a merged view can get
wrong:

    python3 tests/multi_object.py 1BBH.cif 1HVR.cif
    python3 tests/multi_object.py 1BBH.cif 1EHZ.cif --png /tmp/multi.png

It loads two structures, shows one, then both, and checks that the source map
covers every position, that **no segment joins two objects** (a bond across the
gap between two structures looks like a long bond, not like a bug), that the
picture gained ink, that no colour is shared across the join, that hiding
residues of the second object leaves the first untouched and stores the set in
the second object's OWN numbering, that Orient leaves nothing off canvas, that
a pick where the second object is drawn reports the second object, that Auto
clip cuts without emptying, and that the GPU picture is the CPU picture - in
BOTH styles, and all inside ONE page load, because the paper grain is reseeded
per load. Then it presses the Object button and clicks the eye, like a user.

It also drives the strip both ways (sequence and chain mode), clicks chain A in
every section, checks ligands collapse to one token per ligand in every
section, edits a selection that reaches BOTH objects (Copy makes one object per
structure, Delete takes one residue from each), switches everything off and
back on, and saves the whole session and loads it into a cleared viewer to see
each object's own sets come back on the right object.

Exit status is the test result; the printout is the evidence. Run it for any
change to the merge, to per-object state, or to the sequence strip's indices -
and run it over several PAIRS: two of its checks were wrong rather than the
code, and only a pair of monomers and a pair that overlaps in space showed it.

`copy_selection.js` covers what **Copy** carries onto the new object. A frame
is extracted position by position and has its own coverage; this is the
per-object display state beside it — which positions show a side chain or a
base, their colours, the forced secondary structure, and the contacts between
them. All of it is keyed by position index, none of it used to be carried at
all, so copying a posed selection returned a bare backbone. The last test in
the file walks `web/app.js` and `viewer-mol.js` for per-object keys that
`_remapObjectState` does not name, and fails on any it finds — that is how
`sse` and `color` were discovered to be missing too.

**A copy can also be too small to hold a side chain.** Coefficients live in a
local frame built from the residue before and the two after (`localFrame`'s
`1 <= i <= n-3` guard, plus an unbroken chain through them), so a copy of one
residue can build no frame anywhere and every atom was dropped at draw time —
the table came across intact and nothing appeared. Measured on 1TIM before the
fix: one residue gave 3 table rows and **0** atoms, four residues gave 11 rows
and 4 atoms, two runs of three gave 13 rows and 5 atoms. The rows are now taken
back to a world offset and re-expressed in whatever frame the copy can build,
or kept as a world offset with anchor `-1` where it can build none.
`interaction.js` asserts the copied atoms land on the same coordinates they had
in the original, for selections of 1, 2, 3 and 4 residues and for one with a
gap in it.

Two traps in the harness itself, both of which made assertions pass vacuously
before they were fixed:

- **`cloneNode` must copy the canvas width.** `setupCanvasSequenceEvents` clears
  old listeners by cloning the canvas; a stub clone with `width` 0 makes
  `getCanvasPositionFromMouse` scale every coordinate to zero, which puts every
  click on the scrollbar and selects nothing, forever.
- **`scrollTop` survives a rebuild.** A scroll test that only dragged one way
  passed or failed on whatever ran before it. Drive both ends inside the test.

Orient's floor is worth knowing about: a single position has extent **0**, which
is falsy, so the branch that sets the target centre was skipped and orienting on
one residue silently did nothing. The extent is floored at 8 Å — a residue's own
reach, an arginine's tip sitting ~7 Å from its CA — so one residue frames itself
and its side chain rather than asking for a magnification nothing is legible at.
Anything bigger clears the floor on its own and is untouched.

## GPU renderer — `gpu3d_view.html` (look) and `gpu3d_lab.html` (measure)

**Start with `GPU3D_HANDOFF.md`**: what exists, what works, what is half-done,
and the numbers to check a change against. `GPU3D_NOTES.md` is the long record
of why each rule is what it is — worth reading before changing one, since most
look wrong until you know what they fixed.

    python3 -m http.server 8080
    open http://localhost:8080/tests/gpu3d_view.html

**`gpu3d_view.html`** is the plain one: a single canvas, a `renderer` dropdown
(WebGL2 or the 2D renderer), a structure picker, and the style controls the app
has. No comparison and no metric — pick a renderer, change a setting, look. The
frame time is printed under the canvas, which is where the difference shows:
1UBQ at 640px reads 47 ms on the 2D renderer and 0.3 ms on WebGL2, because a
drag on the GPU turns a mesh that is already resident and rebuilds nothing.

Throw it and it coasts, with the app's own numbers: velocity smoothed at 0.5
while dragging, applied per frame as `rotationMatrix*(v * 0.005)`, damped by
0.95 until it falls under 1e-4. Whether to run it is decided by MEASURED frame
cost rather than by the size of the structure — the same call
`viewer-cartoon.js` makes for its gesture ink degrade, and for the reason it
gives there: a segment count knows nothing about canvas size, detail, or the
machine.

`inertiaStep()` is split out of the rAF loop so the physics can be driven
directly. That is not a convenience: `requestAnimationFrame` never fires in a
backgrounded tab, so a test that goes through the loop measures whether the
window had focus and nothing else.

Most controls do NOT rebuild the mesh. It holds model-space geometry, and
everything about the camera and the light arrives at the shader as a uniform, so
`ortho`, `shade`, `highlight` and `fade` cost one draw — measured against a
rebuild at the same setting, all four differ by **0.000%**. Ortho is the
surprising one: `unproject` inverts `project` exactly, perspective factor
included, so the geometry it recovers does not depend on the projection in force
when it was captured. `smooth` joined them once the mesh started carrying BOTH normals — the
per-station pair a smooth face interpolates between and the single per-face one
a flat face uses — with the shader choosing off `uCel`; toggling it without a
rebuild differs from a rebuild by 0%. Only the geometry controls now move the
mesh (thickness 18.1%).

**Show/hide does not either.** The mesh carries every face and tags each with
its class, so hiding the backbone or the side chains is a uniform and a clip at
the vertex stage — measured on 1UBQ, all four combinations reuse the mesh and
cost 0.6 ms. Side chains are therefore ALWAYS materialised
(`window.__scGeometry = false` leaves them out of the geometry altogether, worth
it only on something like 9FOG where they are most of the 62k faces).

Note the two pages want opposite things from that checkbox. In the viewer it is
visibility. In the lab it must change the SCENE, because hiding side chains on
the GPU while the reference still paints them does not measure anything — it
reports the side chains as error (1BBH 24.1% → 52.5%). The lab rebuilds.

**Nor does adding or removing an individual side chain.** Every face carries the
residue it belongs to, and a one-byte-per-residue texture says which residues
are drawn — so `setResidueVisible(i, on)` is a single texel write against a mesh
that already holds the geometry. Measured on 1UBQ: below timer resolution,
against 67 ms for the rebuild it replaces. `setAllResiduesVisible(on)` resets it.
A side chain can only be revealed if the mesh contains it, which is why they are
always materialised.

**The Ink control is ported.** `cartoonOutlineTint` mixes an outline between
black and the element's own colour at 0.7 — and it is not a mix: past zero the
black term is dropped entirely, so at 0.5 a line is a dark version of its own
element rather than a grey. `inkColor()`'s depth fade came with it. The presets
set it (richardson 0.8, the others 0), and matching improves as it rises —
1UBQ 25.6% at tint 0 to 20.5% at 1 — because a tinted line sits closer to the
fill it borders, so a misplaced one costs less.

Set the SAME tint on both sides when measuring. The lab's reference had it
pinned at 0 from when the shader could only draw black, which compared a tinted
outline against a black one and called the difference error.

**Bias is tied to line width and surface slope**, which is what stops the
outline zigzagging. The line is a screen-space quad straddling the edge, so half
its width lies OVER one of the two faces, at that face's depth — which is why it
z-fights at all. How much depth that half spans depends on the line's width and
on how steeply the face recedes (`|n.xy| / |n.z|`), both of which the shader
already has. A constant bias over-corrects a face-on surface and
under-corrects a grazing one, and under-correction eats the quad in a
slope-dependent pattern: a line that alternates between drawn and missing along
its length. Reported by eye as a zigzag.

Scaled, it is essentially solved. Counting ink pixels with fewer than two ink
neighbours — the ends of a stroke — a black outline at width 1.6 goes from
**63% broken to 0.8%**, with the manual bias at zero. The manual bias is a trim
now: 0.8% without it, 0.7% with.

**The outline is tuned for how it LOOKS, not for the pixel metric**, which is a
deliberate choice and worth stating because the two disagree. More ink than the
reference is fine: a solid line reads as a line, a dashed one reads as a fault,
and the metric prefers the dashed one because it counts pixels rather than
strokes. The one thing the cap still protects against is a genuine defect rather
than a matter of taste — an effectively uncapped bias reached ~0.038 on grazing
faces and surfaced edges that should have stayed hidden.

Defaults: line width 1.6, manual bias 0.002, slope-bias cap 0.004, ink tint from
the preset. The knobs, in the order worth reaching for: `ink w` sets the weight,
`bias` trims continuity, and the cap (`window.__biasMax`) bounds how far a line
may sit in front of its own surface — raise it for solider lines, lower it if
hidden edges start showing.

Note the fills-only comparison is unaffected by any of this and stays the honest
measure of the SHADING port: 15.8% on 1UBQ.

The trade itself, for reference (1UBQ, ink tint 0.8):

| line width | pixel match | broken |
|---|--:|--:|
| 1.2 | **18.0%** | 58.6% |
| 1.4 | 20.2% | 34.0% |
| 1.6 | 23.2% | **11.7%** |

A thinner line is nearer the reference by pixel count and more broken; a wider
one is solid and over-inks. The default is 1.6, chosen for the drawing rather
than the number — the same call as the bias itself.

**The old fixed-bias note**, kept because the reasoning was wrong in an
instructive way: It was added
to stop a silhouette z-fighting its own surface, but measured against the
renderer it only makes the match worse — 1UBQ 24.3% at bias 0, 25.6% at 0.004 —
because the ink it admits is largely ink the reference does not draw. At zero
bias the GPU still lays down 11843 ink pixels against the reference's 9440, so
**the remaining outline error is not the depth epsilon**: it is a rule
difference about which edges get drawn. An ID buffer would remove the epsilon
and leave that 25% untouched.

**A new GL context invalidates every object the old one owned.** Switching
renderer replaces the canvas, and the textures are created lazily by functions
that short-circuit on an existing handle — so they were rebound from the dead
context and silently did nothing, which showed up as the outline vanishing on
the way back to WebGL2. `initGL` clears the handles.

**The outline is most of a build, so it is only built when it is on.** Staged
timings on 9FOG put the edge table and its instance buffer at 471 ms against
511 ms for everything else — and the outline is a checkbox. Skipping it takes a
9FOG build from 1672 ms to 1201 ms; ticking the box rebuilds, which is a cost
the user just asked for. `window.__mrPhase` carries the stage timings.

**One instance per face, not six vertices.** Of the 36 floats a vertex carried,
only the position and the normal/tangent pair differ between a face's corners —
the other 21 were written six times over. Per face it is now 48 floats: four
corners, two frames, one copy of the rest, with the corner picked off
`gl_VertexID`. On 9FOG the vertex array went from **111 MB to 25 MB**.

Watch the attribute budget when adding to it. Ten per-face scalars declared
singly wanted 18 vertex attributes against WebGL2's 16, and the program simply
fails to link with "too many attributes" — they are packed three-to-a-vec4 and
unpacked on the shader's first three lines.

**Building is faster too**, by not doing work nobody wanted:

| | before | after |
|---|--:|--:|
| 1UBQ capture | 44 ms | 9.8 ms |
| 1UBQ `makeResident` | 26 ms | 14.5 ms |
| 9FOG `makeResident` | 1409 ms | 894 ms |

Three things did it. `renderer._probeOnly` returns from the render as soon as
the primitives exist — a consumer harvesting geometry has everything it came for
by then, and the paint and ink that follow are a frame nobody looks at. The
model radius was re-unprojecting every corner a second time, when the loop above
had already stored them. And the edge table keyed on template literals built
from three `Math.round`s per corner, about half a million of them on 9FOG; it
now hashes to a number and caches that on the point.

The viewer has a `colour` dropdown (rainbow, by chain, one colour, stripes,
gradient) so a colour change is something to measure rather than talk about.
Each mode moves 85–89% of painted pixels, and the note under the canvas prints
what the change cost — currently 45 ms on 1UBQ, which is the number a fast path
has to beat.

**Element colour takes HALF a bond**, and the renderer is what cuts it: a
colours array may carry a `halves` side-table, `halves[s] = {a, b}`, and where
it does the renderer splits that bond at its midpoint and gives the near half
`a`, the far half `b`. Supplying the PAIR is the whole of it — an earlier
attempt here painted the entire segment with its non-carbon end's colour, a
bond-length smear where the app draws half of one. On 1UBQ, 78 segments carry
halves and 468 primitives come back painted an element colour.

**A LIGAND ATOM CARRIES ITS OWN ELEMENT.** Element colour reads
`sidechainMap` for an appended side-chain atom, and a ligand atom is not in it —
it is a position of the file's own — so ligands were left out of colour-by-
element entirely until `position_atoms` and `position_elements` were captured
beside `position_names`. They are blank at every position that stands for a
whole residue (an alpha carbon, a C4'), and the element comes from the FILE'S
OWN COLUMN: a ligand atom called `CL` is chlorine in one file and a carbon in
another, and haem names four nitrogens NA, NB, NC and ND, so a two-letter guess
off the name would invent a sodium. Where the column is silent the first letter
is taken and nothing more. The switch is per atom for a ligand and per residue
for a side chain (`elementOwners`), and the selection row renames itself
*Ligand* when that is all it has on it. Measured on 3PTB: 94 pixels change when
the benzamidine's two nitrogens are switched off, restoring exactly, CPU and GPU
alike — the GPU only because the element set is in the mesh signature, since
cutting a bond at its midpoint is geometry.

**Colour does not rebuild either.** Every primitive reports the palette SLOT it
took (`ci`, plus `half` for the two half-bond colours element colouring
supplies), the mesh stores that slot per face, and the colours themselves live
in a texture — three texels per segment. Changing scheme is one upload of a few
kilobytes and a redraw: **0.2–2.1 ms against 45 ms for the rebuild it replaces,
and pixel-identical to it (0%).**

The two derived colours are redone in the shader rather than baked — a sheet
edge is white, a helix's inner face is tinted 0.68 toward white — because baking
them would need a palette entry per derived colour instead of per segment.

Two things this cost:

- **Every prim kind has to report a slot.** The junction plates of a three-way
  side chain did not, so they kept the colour baked at build time and stayed
  behind as wrong-coloured triangles while the legs around them changed. 117 of
  1UBQ's 2947 faces were in that state (110 junction, 7 rib cap) and it showed
  as a 0.7% residual against a rebuild; with them tagged it is 0%.
- **The attribute limit.** Ten per-face scalars declared singly wanted 18 vertex
  attributes against WebGL2's 16, and the program simply fails to link with
  "too many attributes". They are packed three-to-a-vec4 and unpacked into the
  same names on the shader's first three lines. On 9FOG that is the difference between a
sub-millisecond redraw and a 1.7 s rebuild.

Rotation is the app's, not a yaw/pitch pair: `rotateView` accumulates the same
screen-space increments `viewer-mol.js` does (`dx`/`dy` scaled by 0.01, left
multiplied onto the accumulated matrix), so a drag here behaves like a drag in
index.html — no roll creeping in once the model is pitched, and no gimbal lock
looking down the axis. The lab's yaw slider still steps to a named angle through
`setViewYawPitch`, which is how the measurements in `GPU3D_NOTES.md` were taken.

Note the canvas is REPLACED when the renderer changes. A canvas keeps the first
context type it is ever given, so one element cannot serve `getContext('2d')`
and WebGL2 both — a reference captured at startup goes on pointing at the
detached one, where `getContext('2d')` returns null.

**`gpu3d_core.js`** holds the GPU path both pages use — shaders, capture,
`facesOf`, `buildResident`, the outline pass. It is lifted out of the lab rather
than reimplemented: every rule in it was arrived at by measuring against the
renderer, and a second copy would drift silently. It reads its settings from DOM
ids (`preset`, `smooth`, `frame`, `ink3d`, …), so a page that does not show one
supplies a hidden input carrying the default.

## GPU depth prototype — `gpu3d_lab.html`

    python3 -m http.server 8080
    open http://localhost:8080/tests/gpu3d_lab.html

Answers "how much of the drawing changes if depth is resolved per pixel instead
of by sorting bodies". Both panels draw the SAME faces off the renderer's own
primitive list with the same tone function; only the depth resolution differs, and
a third no-depth GPU pass separates rasterisation from ordering. Measured over 36
views of 1UBQ: **ordering 674 px (0.19%)**, rasterisation 13590 px of which 99.3%
is antialiasing on a colour boundary and 56 px land inside a face. Findings and
the costs that are not pixels are in `GPU3D_NOTES.md`.

## Paint order — `paint_order_audit.js`

    CARTOON=py2Dmol/resources/viewer-cartoon.js node tests/paint_order_audit.js
    CARTOON=... SC_ALL=1 node tests/paint_order_audit.js     # a side chain per residue

**Nothing else in this repo measures paint order**, which is why every failure
in it has been found by eye. This rasterises every face the painter emits and,
at each covered pixel, compares the face that ENDS UP on top with the face that
actually IS on top, over 200 view directions. Errors are bucketed: side chain
over ribbon, ribbon over side chain, ribbon over ribbon.

Baselines it must reproduce, or it is broken: **94047** wrong pixels for the
shipped renderer with `SC_ALL=1`, **16085** with one side chain.

Three things it gets right that earlier versions of it did not, all of which
produced confidently wrong answers first:

- the painter's order INSIDE a rib prim — surfaces by facing, then stations in
  chain order. Giving them one order measures the harness's tie-break instead,
  and reported 100% of errors in the wrong category.
- **a single side chain cannot show ribbon-over-side-chain at all** — there is
  nothing for the ribbon to wrongly hide. Use `SC_ALL=1` before believing that
  category.
- clipped geometry still counts toward the truth while being excluded from what
  was painted, so erasing something that should have been visible scores as the
  error it is rather than as a perfect frame.

`paint_order_bench.js` and `paint_order_lab.html` sit alongside it and explore
approaches the audit does not: width tiling, a shared seam rail, triangle
primitives and a triangle z-buffer reference. Both are **standalone models** —
they reimplement the geometry rather than driving the renderer — so their
numbers are internally comparable and not comparable with the audit's. Width
tiling is the only approach measured anywhere that improves both side-chain
error categories at once.

The full history — six approaches, what each measured, and why each failed — is
in `PAINT_ORDER.md` at the repo root. The work itself is on the `paint-order/*` branches.

## Side-chain clearance — `bleed.py`

Analytic, no renderer and no pixels: does a side chain's solid actually
intersect the ribbon slab? Rotation-invariant, so it is asked once per
thickness. Yields the closed form for when the bond clears the ribbon,
`1.53·μ − halfT ≥ 0.25·√(1−μ²)`, whose predicted onsets match measurement to
about 0.15 of thickness. Distinct from paint order: where the solids genuinely
overlap, no paint order is correct.

## Side chains — `sidechain_chain.js`

    node tests/sidechain_chain.js            # every .cif in the repo root
    node tests/sidechain_chain.js 6MRR.cif

Off by default and per residue: one position per residue is what makes this
renderer fast, so side chains are drawn only where the user asks for them
(index.html, **Side chains** in the selection tools; `objectsData[name].sidechains`,
a Set of position indices, alongside `color` and `sse`).

Four hops, and the test walks all four because the failure was in the middle of
them:

1. **Capture** — `buildSidechainTable` (`web/utils.js`), at load, because that
   is the only moment the atoms exist. **One conformer per residue, the first**:
   a residue modelled in two positions writes each atom twice, and taking both
   gives a side chain with two of every atom, bonded to each other by the
   distance rule into a tangle that is not any real conformer. First-wins by
   atom *name* rather than by reading the alt-loc column — it needs nothing from
   the parser and it matches what the backbone already does (`residue.caAtom` is
   the first CA seen), so the side chain comes from the same conformer as the
   position it hangs off. 3CHY, 6MRR, 2POR and 9FOG all carry alternates, so the
   corpus run covers this on real data.

   **Bonds come from the chemistry, not the coordinates.** A side chain's
   connectivity is a property of the amino acid, so `PROTEIN_SIDECHAIN_BONDS`
   names the real bonds for the 20 standard residues (plus MSE), and
   `SIDECHAIN_ATOM_ALIASES` covers the names that moved between PDB v2 and v3 —
   isoleucine's terminal carbon is `CD` in v2 and `CD1` in v3. Symmetric pairs
   that merely swap between files (ASP `OD1`/`OD2`, PHE `CD1`/`CD2`) need no
   alias: both bond to the same parent, so which is which changes nothing.

   The distance rule survives only as a **fallback** for residues not in the
   table. It could not be the primary: measured over 25,946 atoms,
   over-coordination stays flat to a 2.10 Å cutoff then breaks sharply — 3 at
   1.90, 6 at 2.10, **109 at 2.20**, 3004 at 2.40 — while 4HHB has *real* bonds
   out at 2.2 Å and one arginine `NE`–`CZ` at 2.97 Å. No single threshold
   separates those. Where the fallback does run, a still-detached fragment is
   offered one shortest link (≤2.35 Å) before being dropped; where the table
   runs there is no repair, because a gap there means an atom the file never
   modelled and bridging it would draw a bond that does not exist.

   Four checks per structure, each catching a different failure: **the bonds
   equal the table exactly** (that the table is applied, and that aliases fire),
   **no over-coordinated atom**, **no more than 0.2% of atoms dropped** (0.00%
   today), and globally **under 1% of bonds longer than 2.0 Å** (0.088% today).
   That last one is the only *independent* evidence the table is chemically
   right — everything else compares the code against the same table it is
   testing. Adding a bogus `SER CA–OG` moves it to 1.35% and fails.

   The alias map needed a fixture of its own: every structure here is modern
   mmCIF, so deleting the ILE alias changed nothing and nothing noticed. The
   test now renames `CD1`→`CD` in 1UBQ's isoleucines and asserts the atom count
   is unchanged.

   **The PDB path was never exercised either** — every structure in the repo is
   mmCIF, so the whole capture only ever ran through `parseCIF`. The test now
   writes 1UBQ and 4HHB out as PDB, parses them with `parsePDB`, and requires
   the side-chain tables to match atom for atom and bond for bond. Twice each,
   with and without the element column: columns 77-78 of an ATOM record are
   optional and older files leave them blank, so **hydrogens are identified by
   name when the column is silent** (`H…`, and v2's count-first `1HB`). Standard
   residues shrugged that off on their own — the connectivity table never names
   a hydrogen, so one attaches to nothing and is dropped — but the distance
   fallback bonded and drew them. No hydrogens are drawn in either path.

   Also: the frame arrays keep one CA per residue
   and the file text is not retained. Stored **as coefficients in each residue's
   backbone frame**, never as world coordinates, using the renderer's own
   exported `localFrame` so capture and reconstruction cannot drift apart.
2. **Carry** — frames are built field by field, so anything not named is
   dropped in silence. This has happened twice: `web/app.js`'s `frameObj` (side
   chains captured, stored, copied past, never reaching the renderer — reported
   as *"No side-chain atoms in this structure"* on 6MRR, which has 354) and
   `viewer-mol.js`'s `extractedFrame` (a copied sub-structure with none at all).
   Neither failed loudly; both just produced a structure that had none. The test
   lifts `frameObj` out of `app.js` and *executes* it, and checks both literals
   by name — a rename fails the test rather than quietly stopping covering
   anything.

   A copy also has to **renumber**: the table is keyed by position index.
   `_remapSidechains` rewrites it, keeping a row only when both its residue and
   its anchor survive — the coefficients live in the anchor's frame, so without
   that residue there is no frame to rebuild them in. A residue on the edge of a
   selection can therefore come across without its side chain, which is honest;
   re-anchoring to a frame the coefficients were never measured against would
   point it somewhere arbitrary.
3. **Materialise** — `_materialiseSidechains` (`viewer-mol.js`) turns the
   switched-on residues into ordinary `'L'` positions with explicit bonds, i.e.
   into a ligand. Both styles then draw them, depth-sort them and pick them with
   no new code — but a side chain is **not** a ligand for *width*:
   `TYPE_BASELINES['L']` is a deliberately thin 0.4, since a ligand is a guest
   that should not out-weigh the chain it sits in, and at that weight a side
   chain came out as a hairline hanging off a full-width backbone. That is what
   "side chains do not work in tube mode" looked like — they were drawn all
   along, just too faint to read. They also **cast no shadow on the backbone**
   (`_shadowPairExcluded`): a thin stick sitting right against the chain would
   print a hard little shadow on it, and the eye reads that as the backbone
   being dented rather than the side chain being in front. The backbone still
   shades *them*, which is the direction that carries depth. Contacts were
   already excluded the same way and for the same reason — they are drawn on
   the structure rather than being part of it — and the two rules now share one
   copy instead of a duplicated test at each of the two call sites.
   In the **cartoon** they are ligand sticks, and a stick leaves through the
   ribbon's *face* rather than out of its middle — the same construction a base
   plate uses, and for the same reason: *"a rung runs from its own ribbon's FACE
   to the centre of the pair, so it never crosses either backbone it connects"*.
   Starting at the CA put the stick inside the slab, the two solids
   interpenetrated, and no paint order was right for both — seen along a sheet
   the side chains printed over the backbone. Which of the two faces is chosen
   by where the side chain actually is; a fixed sign sends half of them out
   through the back. The offset is the slab's half-thickness and no more, so the
   box straddles the surface and the joint looks attached; the overlap costs
   nothing, since the hidden-line pass removes whatever ends up inside.

   **The bond keeps its own axis; the backbone cuts it.** An earlier version
   moved this end out to the surface, which is a shift along the face normal —
   *sideways to the bond* — so the stick stopped being collinear with the CA–CB
   bond it represents and leant off it by the slab's half-thickness. What
   happens physically is that the bond runs all the way to the CA and the slab
   takes a slice off the end, so only the cutting plane is recorded and the end
   point stays where the atom is. Where the slice falls then depends on the
   thickness, which is right — a thicker ribbon swallows more of the bond.
   Measured: the cut walks **0.06 → 0.77 Å** along a 1.9 Å bond as thickness
   goes 0.3 → 1.2, staying exactly in-plane throughout. Both halves are
   asserted: a version that moves the endpoint instead passes the in-plane check
   and fails the thickness one.

   And neither of those is enough while the joint still has a **lid**. The CA
   end is the first bond of its run, so the cap logic counted it as an open end
   and painted the cross-section — a square face with its own silhouette, drawn
   on top of the surface the stick had just been placed and rolled onto. It is
   buried in the ribbon, so it is now flagged buried, exactly like the internal
   joints that flag already covers. Its test points the side chain **away** from
   the viewer on purpose: that turns the start cap toward the viewer, which is
   the only case where it is drawn at all — pointing it forward, backface
   culling removes it anyway and the test would pass without testing anything.

   The last piece is the cap's **corners**. A stick's end section is
   perpendicular to the *stick*, which where it meets the ribbon is the wrong
   plane: unless the side chain leaves exactly along the face normal, that cap
   digs into the surface on one side and lifts off it on the other, and no
   amount of placing or rolling makes the edge sit flat. What lies flat is a
   section in the *ribbon's* plane, so the four corners are slid along the bond
   until they reach it — an oblique cut, the same thing a mitred junction does
   to a leg. Corner spread along the face normal: **0.31 Å → 0.000**.

   **Which surface it leaves through.** A slab is not a plane: it has two
   *faces* at the half-thickness and two *sides* at the half-width, and a side
   chain leaves through whichever one it points at. Cutting every stick against
   the face is very nearly right and catastrophically wrong in the gap. Over
   21,274 CA–CB bonds, residues leaving edge-on (>80° from the face normal):

   | helix | strand | coil |
   |---|---|---|
   | 0 of 7,607 | 2 of 4,581 | **9.5%**, min 0.0004 |

   A helix and a strand *fix* the ribbon's roll, so their side chains genuinely
   come out of the faces. A loop's roll is a free choice made for smoothness, so
   the side chain points wherever it likes relative to it. Edge-on, the corner
   slide `(offset)/(d·n)` runs away — measured at **0.37/|d·n| Å**, which at the
   observed minimum is **1009 Å**. Those were long lines drawn across the
   structure, reported on Q5VSL9 and reproducible on 1TIM.

   The fix is a **ray/slab exit**: run out from the CA along the bond and take
   whichever surface it reaches first, `halfT/|d·n|` against `halfW/|d·s|`.
   Worst corner travel over the corpus goes **236.6 Å → 1.0 Å**, zero boxes over
   5 Å at any thickness.

   Two wrong answers were measured before that one, and both are pinned by the
   test because both look plausible:

   * **Turn the ribbon to face the side chain.** Since side chains are captured
     for every residue, CB is available — but the CB axis swings a median
     **57°** (p90 83°) between consecutive loop residues against **18°** for the
     frame in use. The ribbon would tumble through every loop. Its job is to be
     smooth; reading the right surface off it costs it nothing.
   * **Take the better-*conditioned* plane** — the one the bond meets most
     squarely. This fixes the runaway and breaks helices: a helix ribbon is ~3×
     wider than thick and its side chains leave at a median 50° to the face
     normal, so `|d·s|` routinely beats `|d·n|` on a bond that plainly exits the
     *face*. Cutting those against the side moves the joint out to the ribbon's
     edge and the flush contact is gone — which is what it looked like on
     screen. The exit test weighs the angle against how far each surface
     actually is, and puts **99.7–100%** of helix residues back on the face.

   **No angle cutoff** survives from the earlier version — there was a 0.35
   floor on `|axis·normal|`, and the sliver it feared is now prevented by
   picking the right surface rather than by refusing to cut. What remains is a
   divide-by-zero guard plus one backstop expressed in the quantity that
   actually breaks: **no corner may travel past the bond it is cutting**. It
   catches the residual case where the bond runs along the *chain* and meets
   neither surface squarely. There, and only there, the cut is declined and the
   cap suppressed; everywhere else the cap lies *in* the ribbon and is drawn,
   because it is the square on the backbone and dropping it leaves the box open.

   A known, accepted cosmetic limit: the joint lands at a median 0.40 and p90
   **0.85** of the way to its surface's edge, and a loop is only 0.42 Å
   half-wide against the stick's 0.25 Å half-width — so on a loop the stick
   overhangs by ~0.19 Å at p90. Containing it fully would need loops as wide as
   helices (1.67 Å), so it stays.

   **Contacts run CA to CA and the ribbon crops them.** A contact is stored
   between two residues, so it was drawn CA to CA with nothing removed — and a
   CA is the *centre* of the slab, so both ends began buried in the ribbon they
   point at. Identical fault to the side chains', identical symptom: line and
   slab interpenetrate, no paint order is right for both, and the contact reads
   as passing *through* the backbone rather than touching it.

   The line keeps its full CA-to-CA axis and each end is cut back to where it
   leaves the slab — the same thing the backbone does to a side chain, but flat:
   one stroke, no box, no end face to make flush. Cropping along its own
   direction cannot tilt it off the two residues it names.

   **Where the crop falls reads both thickness and width**, because the slab has
   both: the exit is the nearer of `halfT/|d·n|` and `halfW/|d·s|`, bounded by
   the residue's own half-step along the chain. That third axis is needed here
   and not for side chains — a CA–CB bond never runs along the chain, but a
   contact between *i* and *i+4* in a helix very nearly does, and would meet
   neither face nor side squarely. The half-step is taken from the **nearer**
   neighbour and capped at `SS.chainMax / 2`: the `pB − pA` span is the obvious
   source and is wrong at a chain break, where one "neighbour" is not one, the
   span reads tens of Ångström, and the crop reached **10.4 Å**.

   Crop per end, 3,907 contacts:

   | thickness | median | p90 | max | hits the 80% guard |
   |---|---|---|---|---|
   | 0.6 | 0.71 Å | 1.60 | 2.76 | 0 |
   | 0.9 | 0.98 Å | 1.90 | 2.76 | 0 |
   | 1.4 | 1.26 Å | 1.94 | 2.76 | 0 |

   Two designs were built and rejected before this one, and both are pinned by
   the test because both look reasonable:

   * **Anchor each end at the surface point straight out from the CA.** Puts
     every joint in the same place — the wander below goes to zero — but the
     line then no longer points at its partner, each end being displaced by up
     to the ribbon's half-extent, about 23° of bearing over a 6 Å contact. A
     contact's whole job is to say *which two residues*, so the bearing wins.
   * **Restrict a helix to its two faces**, to stop the attachment jumping
     between surfaces. That was measured under the anchor design (27% of helix
     ends were landing on an edge) and does **not** survive cropping: a line
     that genuinely leaves through the edge has no face to be cropped at, so
     `halfT/|d·n|` runs away — >50 Å at 90° off the face normal, 2.59 Å at 80°
     against a true 1.32 Å, and past 80° the guard clamps and eats the contact.

   The attachment point does therefore still slide with the direction to the
   partner — that is inherent in staying collinear, since a ray from the centre
   of a box exits wherever it hits. Measured as a fraction of the way from the
   centre of a surface to its rim: helix face exits median 0.49, sheet 0.37,
   loop 0.46. It is the accepted cost of the line pointing where it says.

   The guard that remains: two residues can sit closer than their two
   half-ribbons, and the crops would then cross and draw the line backwards, so
   both are scaled back together past 80% of the length.

   Its test mutates four ways — no crop, a fixed inset, a crop that reads only
   thickness and not width, and an end anchored sideways instead of cropped —
   and all four fail. Two fixture notes, each of which cost a false pass:
   the strand is **tilted out of the screen plane**, because a flat strand's
   side vector points nearly along the view axis and the sideways displacement
   that distinguishes an anchor from a crop then projects to under a third of a
   pixel; and the thickness check is made **at 0.9 only**, because below that
   the ribbon's thickness fades with projected size (`thickZoom`) and
   `crop == thickness/2` stops holding — a first draft asserted it at 0.4 and
   failed on the fade rather than on the crop.

   **A contact sorts on its near surface, and the ink pass agrees.** It is drawn
   flat but stands for something with thickness, so what should sort is the
   surface facing the viewer: `zBias = max(0, CONTACT_TUBE_R − thickness/2)`,
   which lets a contact win against a thin ribbon and lose to one that genuinely
   stands proud of it.

   That bias lives **in the depth channel** of the projected points, not on the
   sort key. `project()` returns `[x, y, z, pe]` with `z` the world depth in
   Ångström, and that third slot is what the painter sorts on *and* what the ink
   pass registers as an occluder — via `addCapsule` / `cap2`, which take the
   stroke's full **width** but read depth off the centre line. Biasing only the
   sort key, as an earlier version did, left the two modelling different solids:
   the painter drew the contact over a ribbon while the ink pass still believed
   the ribbon was in front, so the ribbon's outline showed through the contact.
   It also missed short contacts entirely — the bias sat inside the subdivision
   branch, and a contact under one segment long never entered it.

   Testing this has a trap of its own: a contact between two **residues** is also
   anchored onto their ribbon surfaces, and that displacement has a depth
   component that reads as bias. The measurement is made on a **ligand-to-ligand**
   contact, which has no ribbon to anchor on, so the only difference left is the
   bias. Three mutations fail: sort-key-only (the original bug), no bias, and a
   bias that ignores ribbon thickness.

   **A helix offers its two faces and not its edges; everything else offers
   every surface.** Letting the exit test roam all four made the attachment jump
   around a single helix — on 1TIM 27% of helix ends landed on an *edge*, and an
   edge sits at the half-**width** rather than the half-thickness, 1.3 Å against
   0.45, so the anchor moved a median 1.38 Å (max 2.60) between one partner and
   the next on the **same residue**.

   | | anchor spread across partners | edge use |
   |---|---|---|
   | helix | 1.38 → **0.90 Å** (max 2.60 → 0.90) | 27% → **0%** |
   | sheet | 1.19 Å, unchanged | 27%, unchanged |
   | loop | 0.84 Å, unchanged | 48%, unchanged |

   The residual 0.90 Å on a helix is exactly twice the half-thickness — it is
   the two faces, and it is meant to be there. Which face a contact leaves by
   says whether its partner sits inside the bundle or outside it, so both stay
   available and only the edges are removed. A **strand keeps its edges** for
   the same kind of reason: it genuinely has two sides, its residues alternate
   between them, and side-by-side strands in a sheet are exactly where an edge
   attachment is the truthful one.

   Its tests mutate five ways in total — no anchoring, trim-along-the-line (the
   design it replaced), a fixed inset ignoring which surface was chosen, a helix
   allowed its edges back, and a helix pinned to a single face — and all five
   fail.

   A fixture note that cost a pass: the helix bearings must be built from the
   **side vector the renderer actually chose**, not from an arbitrary basis
   perpendicular to the tangent. A first draft used the latter, none of its four
   bearings happened to point edge-ward, and the edges-back mutation sailed
   through. The load-bearing assertion is that the anchor sits the *same*
   distance out whatever direction the partner is in; under the trim that
   distance ran 0.45 Å to 1.40 Å between a square and a 50° approach.

   One fixture note: the strand is **tilted out of the screen plane** first. A
   flat strand's side vector points nearly along the view axis, so a side offset
   projects to under half a pixel and reads as *smaller* than the face one —
   the canvas, not the geometry, and it failed the test for the wrong reason
   until the tilt went in.

## Debug knobs

The renderer reads several overrides off the renderer instance, all settable
from the console (`window.py2dmol_viewers[id].renderer`):

| Knob | Default | Effect |
| --- | --- | --- |
| `_forceSec` | — | Force a secondary-structure string (`'HHHH'`) instead of assigning from geometry |
| `_cullEps` | `0.12` | Backface-cull margin; raise to see surfaces that are normally culled |
| `_capT` | `0.85` | Threshold for filling the interior cross-section cap |
| `_innerShade` | `0.22` | Depth of the concave-side shadow on wide faces |
| `_quality` | `'perfect'` | `'fast'` selects the cheap painter ink. There is no automatic gesture downgrade: it changed the drawing mid-drag and snapped back on release, which reads as the render breaking |
| `_noViewCull` | `false` | Keeps primitives that fall outside the viewport. Dropping them is right for painting a frame and wrong for HARVESTING geometry: a consumer that re-uses the primitives at other views gets a model with holes wherever that frame happened to look |
| `_inkMode` | `'grid'` | `'zbuf'` swaps the exact analytic hidden-line test for a depth buffer — faster, but flickers (see PERF_NOTES) |
| `_loopFrame` | transport | `'curvature'` restores the old loop frame (visibly more twist) |
| `_cuts` | `'quarter'` | `'half'` / `'none'` reduce depth-sort granularity |
| `_phase` | — | Set to `{}` before a render to collect build/sort/paint and ink sub-stage timings |
| `_posProbe` / `_sideProbe` / `_arrowProbe` / `_inkTrace` | — | Set to `null` (or `[]` for the traces) before a render to collect drawn positions, frame vectors, arrowhead geometry, or per-segment ink visibility |
| `_primProbe` | — | Set to `null` before a render to collect the primitive list. Each carries `gs0`/`gsStep` — its position along the backbone in residues — which is what makes a colour boundary measurable in residue units rather than pixels |

## Selection feedback

The selection used to be inked into the primitives and depth-sorted with them,
which meant a selected residue on the far side of the molecule was covered by
everything in front of it — exactly the case you need it for. It is now painted
as a **translucent yellow band over the finished frame** (`_paintSelectionHalo`,
`viewer-mol.js`) and is never occluded.

Drawn *inside* the render rather than on the sequence viewer's DOM overlay,
which was the other candidate: that overlay is a separate canvas, skipped during
drags, has to be kept in size-sync with the main one, and is not part of a saved
image. One composited pass at the end gives the live view, gestures and exports
the same answer.

**The band follows what is actually connected**, and the two parts differ. A
backbone is a linear chain, so consecutive residues of the same chain join up —
never across a gap in the selection or a chain boundary. A **side chain is a
tree**: a leucine branches at CG, and its atoms are appended positions whose
index order says nothing about which are bonded. Joining those by index would
draw a CD1–CD2 bond that does not exist and run a band from the last atom of one
residue's side chain into the next through empty space, so side-chain atoms are
joined along their **bonds** — the same connectivity the sticks are drawn from.

**One path, stroked once.** A translucent colour composites per draw call, so
anything drawn twice darkens where it overlaps: a selected stretch would come
out banded light and dark residue by residue and every branch point would show
as a blot. That is also why an isolated atom is a zero-length segment rather
than a filled arc — with a round cap it draws the same circle, but inside the
same path and the same single stroke.

A residue not projected this frame draws nothing. Colour and width are
`SELECTION_HALO_CSS` / `SELECTION_HALO_PX`.

**Live during a drag.** A sequence drag only commits on mouseup, so the band
used to sit still until you let go. Committing on every mousemove is not the
fix — that is a full re-render of the molecule per pointer event, fine on a
peptide and hopeless on a ribosome. The molecule does not change during such a
drag, only which residues are marked, so `beginSelectionPreview` snapshots the
finished frame once and each `updateSelectionPreview` is that image blitted back
plus one halo pass: **cost independent of structure size**. Any real render
calls `_invalidateSelectionPreview`, so a rotation or frame step mid-drag cannot
leave a stale picture behind. `setLocalPreview` in `viewer-seq.js` is the single
funnel every drag path goes through — residues, chains and touch — so it is
hooked once there.

## Click-selection

Off in the renderer by default, turned on by `web/app.js`. The Python path loads
`viewer-mol.js` and the cartoon plugin and nothing else — no sequence strip, no
selection panel — so a click there changed a selection with no way to see it,
act on it, or clear it except by clicking the background again. Selection is
done in Python by scripting, which does not go through the mouse. The switch is
owned by whoever can actually show the result.

Both entry points are gated: the double-click chain-select and the mouse-up
pick. The test anchors on the code that *mutates* the selection rather than on
the listener registration — there is more than one `mouseup` listener, so
searching for the registration found the wrong one and passed with the real
handler ungated.

## Saved state

Two writers, one format. Both sides wrote `"version": "2.0"` while disagreeing
about what was in it — `py2Dmol/viewer.py` wrote `current_object`, the web wrote
`viewer_state` and `selections_by_object`, and neither read the other's — so a
file saved by one opened in the other with its settings quietly reset. The
envelope is the union now, and each side reads what it understands.
`selections_by_object` stays web-only: Python has no selection model.

**The config was written stale.** `window.viewerConfig` holds the values the
viewer *started* with, so saving it verbatim put a stale copy of every render
setting beside the live one — a session showing a cartoon recorded
`config.rendering.style: "tube"` next to `viewer_state.style: "cartoon"`, which
reads as a bug in the file and is the first thing anyone opening it notices. It
cannot simply be dropped: `viewer.py` does `self.config = state_data["config"]`
when it loads a state, so a session opened in Python takes its whole
configuration from there. The two are made to **agree** instead — one set of
values written twice for two readers, rather than two sets that disagree — and
Python now prefers `viewer_state` where it says anything, so an older file still
comes back on what it was showing.

The camera stays asymmetric and that is not a bug: `DEFAULT_CONFIG` has no
rotation or zoom, so Python has none to record. What it can supply is the render
settings, which is what stops a Python-saved session opening as a grey tube.

## Contacts

Already existed on the object as `contacts`, already saved and restored; the
renderer turns each entry into a segment of type `'C'`. The GUI now writes them:
select **exactly two** residues and a Contact row appears with a colour, a width
and **+** / **−**. Those glyphs, and the swatch buttons, carry no text, so each
needs an explicit `aria-label` — a lone `+` names no action, and `title` is only
a fallback for an accessible name. `interaction.js` checks every one of them. A contact is a line between a pair, so the row is not offered for one
residue or for five.

Written in the **chain + residue** form, `[chain1, res1, chain2, res2, weight,
color?]`, not as position indices — indices belong to the current frame's arrays
and a copied sub-structure renumbers them, while a chain and residue number name
the same pair whatever happens to the arrays. Colour is stored as an `{r,g,b}`
object, which is what the segment builder reads through as `contactColor`;
clearing it drops back to the default yellow rather than removing the contact.

**Both stored forms are read.** `parseContactsFile` writes the same entries the
panel does, and it has two: `A 10 B 50 0.5` and the bare-index `10 50 0.5`. The
panel understood only the first, so a contacts file written in indices was
invisible to it — clicking the pair offered Add and made a duplicate, while
Remove, colour and width all failed to find it. It still *writes* the chain
form, which survives renumbering; it just reads both. The weight and colour sit
at different slots in the two forms (`4`/`5` against `2`/`3`), so `contactSlots`
answers that rather than each setter assuming.

A contact has no direction, so the reversed pair is the same contact — matching
both ways is what stops a second Add duplicating one, and what lets Remove find
it whichever order the two were picked in. Add and Remove are each offered only
when they would do something, which between them also says whether the pair is
already joined.

**Width is per contact, and the Line Width control does not reach it.** That
control sets how heavy the *backbone* is drawn; a contact is an annotation over
the structure rather than part of it, and one that grew and shrank with the
backbone stopped reading as a separate mark — the same reason a ligand keeps its
own, and **the same width in both styles** — `CONTACT_WIDTH` in
`viewer-cartoon.js` and `CONTACT_WIDTH_A` in `viewer-mol.js`, which
`interaction.js` checks against each other, since a contact that changes weight
when you switch style is the one thing this exists to stop. The value is **half** what
tube used to draw at its widest: the Line Width slider tops out at 4.7,
`TYPE_BASELINES` gives a contact half of that (2.35), and half again is 1.175.
That is what a weight of 1.0 means — full width for a contact — and the
per-contact slider only takes it down from there. Tube divides it back out
of the Line Width the caller multiplies by, which is how the control stops
reaching it there too.

It is **in Ångström**, like every other width here. That last
part matters: these are all `something * scale` with scale in pixels per
Ångström, and substituting a bare constant for `baseLineWidthPixels` drops the
conversion, leaving the contact a couple of *raw* pixels wide at any zoom. That
is what "too thin even at maximum" looked like — 2.5 px at zoom 1, 2 and 4
alike, against 15 px doubling with zoom once fixed. For reference the ribbon's
own half-widths (`SS_HALF_A`) are 0.42 Å for a loop and 1.3 for a helix. What sizes an individual
contact is the `weight` slot its stored entry already had, which the renderer
was already scaling the stroke by; the panel just exposes it as a narrow slider,
after the colour and the +/− button.

**Full width is the maximum.** The slider runs 0.15–1, so it only takes a
contact *down* from the width it is drawn at rather than letting it grow past
it — an annotation that can outweigh the structure it annotates is not useful.
`CONTACT_WIDTH` is what 1 means.

**Cut into pieces for depth, in the cartoon only.** A contact joins two
residues anywhere in the structure, so as one prim it carries a single depth key
across the whole span and sorts as though it were all at its midpoint — passing
in front of what it should go behind and behind what it should cross in front
of. Same reason a base plate is cut: *"as one quad a rung carries a single sort
key across ~7 Å"*, and a contact reaches much further. Measured on a contact
running through the backbone from +14 to −14: as one prim, **50%** of it sorts
on the wrong side; cut at `CONTACT_SEG_A` = 2 Å (capped at 24 pieces), **2%** —
the piece at the crossing. Stations are interpolated in 3D and projected one by
one, not interpolated on screen: under perspective those are different curves,
and depth is the whole point. The tube path is untouched and still draws one
stroke.

**And it sorts by its near surface, not its centre line.** A contact is drawn as
a line but stands for something with thickness, and the case that matters is one
joining two parts at the *same* depth — two strands of a flat sheet above all —
where the centre lines coincide and the order is a coin toss. It is keyed
`CONTACT_TUBE_R` nearer, **unless the ribbon is thicker**: a slab has a near
surface too, and once it stands proud of the contact's it genuinely is in front
and should cover it. So the bias is the difference of the two radii, clamped at
zero — never negative, which would push the contact behind where it actually is.
The same bias applies to every piece, so the ordering *along* the contact is
untouched.

No fixture had a contact in it before this, which is how the first version
shipped a crash — `'line'` prims carry `joints`, read by the ink pass to decide
where to cap, and the pieces had none. The slots are POSITIONAL — `[0]` is the start point,
`[1]` the end — and getting that wrong capped the last piece at its *start*,
which is an internal cut and shows as a dark tick across the contact at some
angles. Internal cuts get **no** cap at all: a cap fills the gap an angled joint
leaves, and a contact is a straight line.

**Clicking the contact selects the pair it joins.** `pickResidueAt` already
tested contact segments — it has to, or the line would not be clickable at all —
but it attributes the hit to the nearer *end*, so a click selected one of the
two residues and the fact that it was a contact was discarded. The winning
segment is now recorded and `pickGroupAt` widens it. Only when the contact is
what was actually hit: a click on a residue that happens to end a contact is a
click on the residue, which the existing depth/distance test has already
decided. And it is cleared on every pick — a stale value would widen a *later*
click on an endpoint to a contact the user is no longer pointing at, which takes
some contriving to observe and is why the first version of that test could not
fail.

**Every change RELOADS the frame.** Contacts become segments, and the segment
list — contact block included — is built inside `setCoords`, not inside
`render`. Invalidating the cache and repainting therefore changes nothing at
all: the contact is stored correctly, resolves correctly, and never appears.
That shipped once, and the tests missed it because they checked the two halves
separately — that the GUI writes chain+residue, and that the renderer turns
contacts into segments — without ever checking that one reaches the other. There
is now a test for the write/read round trip and one for the reload.

## Per-residue colour

A colour belongs to a residue, but a ribbon interval spans two, and the two
disagreed about what to do with that. `colors[segIdx]` is `getAtomColor(idx1)` —
a segment takes its **first** residue's colour — so colouring residue 10 painted
10→11 and left 9→10 alone: a band the right width but half a residue late,
sitting *between* residues rather than around the one picked. The ss-palette
path had the opposite fault, taking an override from *either* end, which painted
both neighbouring intervals and made one residue read as two.

Both ends are resolved separately now, and where they differ the interval is cut
at its midpoint so each half takes its own end's colour. Stations are integers,
so an odd subdivision count has none exactly at `u = 0.5` and the boundary lands
on the nearest — measured centre error 0.00 residues at detail 2, 0.17 at
detail 4, 0.10 at detail 8, against a constant **0.50** before.

The whole path is gated on the object actually carrying overrides, so a
structure with none is untouched: the paint stream over 40 structures is
byte-identical to before the change. Tube runs still break at interval
granularity rather than mid-interval — loops are drawn as merged polylines with
one colour each, and splitting those is a separate job.

## Benchmark

    python tests/make_bench.py                 # build tests/out/bench.html
    node tests/bench.js [--quick]              # time every config x length

One viewer per chain length (50 -> 10000 residues) on a synthetic trace.
`bench.js` drives `renderer.render()` directly, so the numbers are the draw
stage only; each cell is a median after warmup. Needs playwright — if it is not
installed in the repo, run with `NODE_PATH=/path/to/node_modules`.

See `PERF_NOTES.md` for the phase breakdown, the cost equation
(`fills ≈ stations × surfaces`), and the optimisations that did NOT work.

## Ligand sticks — `junction_math.py`

    python tests/junction_math.py

A ligand bond is drawn as a box, and the derivation is worked in stages, each
checked numerically. Where bonds meet, the geometry decides between three cases:

* **mitred** — adjacent legs share the corner where their side faces cross, at
  `d = h·cot(θ/2)`, and the polygon left in the middle is filled above and
  below. There is deliberately no coplanarity test: real ligands pucker, and a
  junction that comes out slightly odd beats one that falls apart. Where it
  genuinely cannot be solved the corner determinant goes to zero and it declines
  on its own.
* **swept** — a run of atoms each carrying two sticks (a propionate, a vinyl) is
  one path. Mitring it bond by bond pins the roll to each local plane, and along
  a zig-zag those planes swing. One section per station, shared by both bonds,
  frees the roll: worst twist per bond on a haem 38° -> 18°.
* **overlapping** — anything else. A tetrahedral centre has no plane, so there
  is no above and below to fill; the boxes interpenetrate and the hidden-line
  pass removes what is inside.

An sp3 centre gets a collar instead — see `junction_sp3.py`, which derives it in
the same staged way.

Smoke tests 9-11 are the executable form: no inked edge inside its own box, the
box is closed, and no side goes missing under perspective. Test 11 has to run
with `ortho: 0` — the culling bug it guards lives in a branch the orthographic
default never executes.

## Secondary structure — `ss_bench.py` / `ss_bench.js`

    pip install pydssp
    python tests/ss_bench.py --build     # DSSP ground truth -> tests/out/ss_truth.json
    node tests/ss_bench.js               # Q3 + confusion vs pydssp
    node tests/ss_bench.js --per-chain   # worst chains
    node tests/ss_tune.js                # sweep the thresholds

Scores the renderer's assignment against real DSSP over 151 native chains /
16,749 residues from `natives.zip`. The shipped assignment runs DSSP itself on a
backbone rebuilt from the C-alpha trace; the superseded CA-only pipeline is
scored alongside it, as are the ablations of each choice.

Both sides must see the same residue list — pydssp needs all four backbone
atoms, so residues missing any are dropped and the trace is built from the
survivors. `ss_bench.js` calls the renderer's exported `assignSecondary`, so it
cannot score a stale reimplementation.

Current: **Q3 89.76%** (recall: helix 91.8%, strand 92.6%, coil 86.1%); the
CA-only pipeline scores 85.31%, its strands running about a residue short at
each end. Quote the *shipped* row — the ablations printed below it score higher
on Q3 alone.

## Cyclic peptides — `cyclic_bench.py` / `cyclic_bench.js`

    pip install pydssp
    python tests/cyclic_bench.py --build   # fetch + DSSP -> tests/out/cyclic_truth.json
    node tests/cyclic_bench.js             # overall and seam-only Q3
    node tests/cyclic_bench.js --per-chain # which chains moved

A head-to-tail cyclic peptide has no terminus, but every assigner here walks the
chain by index, so the closure is invisible and an element spanning it is cut in
two. Measured over 24 cyclic chains / 1,079 residues: cyclotides,
theta-defensins, and the AS-48 bacteriocins, whose seam sits mid-helix.

The reference cannot be plain DSSP, which would bake the same bug into the
truth: each chain is assigned under two rotations of its residue order and
merged, keeping every residue from the rotation where it sits furthest from the
artificial break. Read the **seam** column — most of a cyclic peptide is nowhere
near its closure and drowns the effect.

| at 4 residues each side | overall Q3 | seam Q3 |
| --- | --- | --- |
| walked as a linear chain | 82.1% | 51.0% |
| told the run is cyclic | **88.7%** | **87.0%** |

14 of 24 chains improve, none regress. The report also measures the ribbon
frame, where a sign flip at the closure makes the strip cross itself: worst
interval 178° -> **128°**, intervals over 90° 22 -> **1**. The last line is a
control — a ring has no canonical first residue, so cutting it elsewhere must
give the same answer. Currently **63/75 cuts** reproduce exactly.

## Sheet frames — `sheet_bench.py` / `sheet_bench.js`

    python tests/sheet_bench.py --build   # natives.zip -> tests/out/sheet_truth.json
    python tests/sheet_bench.py --fit     # refit PEPTIDE_TABLE, print it
    node tests/sheet_bench.js             # score the strand frames
    node tests/sheet_bench.js --sweep     # try other relaxation settings

`--fit` fits the table the backbone rebuild reads, on half the chains, reporting
the other half: C to 0.21 Å rms, N to 0.17 Å, C=O direction to 8.8°. Paste its
output back into `viewer-cartoon.js` as `PEPTIDE_TABLE`.

`sheet_bench.js` scores strand frames in degrees over real H-bonded ladders:
**partner face** (do neighbouring strands stack edge to edge) and **strand
twist** (how far the face rolls between consecutive residues). Current
**22.2°** and **11.3°**, against 38.8° and 21.3° for the curvature frames these
replaced. Partner face is at its floor — the sheets themselves twist 20°.

## Nucleic base frames — `na_table.py` / `na_bench.js`

    python tests/na_table.py --build   # fetch/parse ~90 structures -> tests/out/na_truth.json
    python tests/na_table.py --fit     # refit NA_BASE_TABLE, print it, score held out
    node tests/na_bench.js             # score the predictor the renderer ships

py2Dmol keeps one atom per nucleotide (the C4'), so where a base points is
predicted from the trace. `--fit` fits on half the chains and reports the other
half; paste its output back as `NA_BASE_TABLE`.

Current: direction **17.5°** median (p90 77°), normal 17.6°, coverage 99.9% of
16,748 nucleotides over 153 chains. The tail is physical, not a fitting limit — a base can sit anti or syn on an
identical backbone — which is why the renderer widens its pairing gate, flips
bases that point away from their partner, and caps the per-residue twist.

`na_bench.py` is the older benchmark of the ribbon face and carries its own
replica of the frame construction, so it can drift from the renderer.

## Nucleic pair axis — `na_axis.js`

    node tests/na_axis.js              # needs tests/out/na_truth.json (above)

Every base plate hangs off one vector, the pair axis: the pair plane is normal
to it, so an axis d degrees wrong tilts the plate by d degrees. Scored against
the true base-plane normals, taking the worse of a pair's two bases.

The report splits stem-interior pairs from stem ends, which is where they
differ: at the end of a helix the fitting window runs off the stem into a loop.
Current, 98 chains / 4697 pairs: **13.0°** median overall, 11.3° interior,
15.6° at the ends.

## Nucleic rail frame — `na_frame.js`

    node tests/na_frame.js                                       # source
    node tests/na_frame.js py2Dmol/resources/viewer-cartoon.min.js

The pair axis above decides where a plate lies; this scores the frame the
backbone rail itself is swept along, read back from `_naFrame` after a render:

* **aim** — angle between the rail's face axis and the direction to its
  pairing partner. A paired residue solves its side against that direction, so
  this is 0 by construction and the row is there to catch it stopping.
* **twist** — signed rotation of the side about the tangent, step to step,
  inside a stem. A duplex really turns, so read the **spread** and the
  reversals: a step that goes backward is the frame jumping, which is what
  reads as a wavy, bumpy duplex.
* **partner** — how far apart the two rails' side vectors sit. Expect ~82°.
  The rails wind at ~59° to the helix axis, so their tangents are nowhere near
  antiparallel and the two sides cannot coincide; what they share is each
  aiming at the other.

Current, 153 chains / 16,748 residues: aim **0.0°**, twist stdev **8.7°** with
**4.1%** reversals, rung turn 46.0° median. Against the frame this replaced:
aim 17.6° median / 49.5° p90, twist stdev 28.9°, reversals 22.2%.

**Run it against the bundle too.** The packaged Python path loads
`viewer-cartoon.min.js`, and a bundle committed without being rebuilt scores
exactly like the code it was meant to replace — which is how a shipped fix
came to be source-only for a day.
