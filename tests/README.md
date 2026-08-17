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
| `cartoon_test.html` | Real structures (1YNE, 1UBQ, 1BJP) with ribbon and cartoon side by side. Fetches from RCSB on first run. |
| `na_test.html` | Nucleic acids: B-DNA duplex, tRNA, nucleosome, poly(A)·poly(U), a modified-base complex. Base-pair plates and backbone frames. |
| `ligand_test.html` | Ligand occlusion (4HHB, 3PTB, 1HVR). Generic segments are painted as opaque strokes but are easy to leave out of the ink pass's occluder set, which shows as the backbone outline drawing straight through a ligand. |
| `richardson_test.html` | Richardson preset beside the plain cartoon on four SS compositions (3CHY, 1TIM, 2POR, 1BBH). 1TIM is the control — it is the subject of the original drawing. |
| `ribosome.html` | 4UG0, the large-structure performance case (17,789 positions). Built separately: `python tests/make_ribosome.py`. |

## Assertions — `smoke.js` / `interaction.js`

Unlike the pages above, these assert, and need no browser:

    node tests/smoke.js                                          # source
    node tests/smoke.js py2Dmol/resources/viewer-cartoon.min.js  # bundle
    node tests/interaction.js

`smoke.js` renders synthetic structures through a mock 2D context and checks
properties of what gets painted: closed solids, no inked edge crossing its own
face, junction construction, and the flat-slab and gesture-budget rules. Run it
against the bundle too — a mangler can break what the source proves.
`interaction.js` runs the gesture and animation predicates from `viewer-mol.js`
against a mock canvas.

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
| `_inkMode` | `'grid'` | `'zbuf'` swaps the exact analytic hidden-line test for a depth buffer — faster, but flickers (see PERF_NOTES) |
| `_loopFrame` | transport | `'curvature'` restores the old loop frame (visibly more twist) |
| `_cuts` | `'quarter'` | `'half'` / `'none'` reduce depth-sort granularity |
| `_phase` | — | Set to `{}` before a render to collect build/sort/paint and ink sub-stage timings |
| `_posProbe` / `_sideProbe` / `_arrowProbe` / `_inkTrace` | — | Set to `null` (or `[]` for the traces) before a render to collect drawn positions, frame vectors, arrowhead geometry, or per-segment ink visibility |

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
