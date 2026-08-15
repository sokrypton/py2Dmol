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

`make_bench.py` emits one viewer per chain length (50 -> 10000 residues) holding
a synthetic helix/loop trace. `bench.js` drives `renderer.render()` directly
through `window.py2dmol_viewers[<id>].renderer`, so the numbers are the draw
stage only. Each cell is a median over repeated renders after warmup.

Needs playwright; if it is not installed in the repo, run with
`NODE_PATH=/path/to/node_modules node tests/bench.js`.

## Nucleic frame benchmark

    python tests/na_bench.py                      # score at the shipped default
    python tests/na_bench.py --sweep              # across tracking gains
    python tests/na_bench.py --target base+sign   # compare alternatives

Scores the derived backbone frame against ground truth the viewer never sees:
the angle between the ribbon's face normal and `C4' -> base centroid`, taken
from ring atoms in full-atom structures. Lower is better.

Use this rather than the `facing%` column, which only checks the SIGN of a dot
product against the partner's C4'. It read 100% while every face sat ~40 deg off
the base, and the partner reference is itself unreliable where pairing is weak
(true base agrees with partner: 100% on B-DNA, 98% tRNA, only 83% on 2R8S).

The frame construction is a REPLICA of viewer-cartoon.js, not the renderer
itself; if the two ever diverge the facing numbers here and in the browser will
disagree.

## Secondary-structure benchmark

    pip install pydssp
    python tests/ss_bench.py --build     # DSSP ground truth -> tests/out/ss_truth.json
    node tests/ss_bench.js               # Q3 + confusion vs pydssp
    node tests/ss_bench.js --per-chain   # worst chains
    node tests/ss_tune.js                # sweep the thresholds

Scores the renderer's secondary structure against real DSSP over 151 native
chains / 16,749 residues from `natives.zip` in the repo root. The shipped
assignment runs DSSP itself - hydrogen-bond energies, turns and bridges, gated on
backbone dihedrals as in PyMOL's `dss` - on a backbone rebuilt from the C-alpha
trace. The superseded CA-only assignment (TM-align's `make_sec`, plus smoothing,
strand pruning and hysteresis extension) is still scored alongside it, as are the
ablations of each choice in the shipped one.

Both sides must see the SAME residue list: pydssp needs all four backbone atoms,
so residues missing any are dropped, and the CA trace handed to the renderer is
built from exactly the survivors. Scoring a different index set silently
invalidates everything.

`ss_bench.js` loads `viewer-cartoon.js` directly and calls its exported
`assignSecondary` (and `makeSec`/`smoothSec`/`extendSec` for the old pipeline),
so unlike `na_bench.py` it can never score a stale reimplementation.

Current: **Q3 90.0%** (helix recall 92%, strand 94%, coil 86%) for DSSP on the rebuilt
backbone; the superseded C-alpha-only pipeline scores 85.3% (helix 93%, strand 72%).
The ablations printed alongside show what each choice costs.
The old note, still true of that pipeline: its strands run
about a residue short of DSSP at each end; that is a limit of the CA-only
feature, not of the thresholds — see the note in `viewer-cartoon.js` above
`maxGrowE`.

## Sheet frames — `sheet_bench.py` / `sheet_bench.js`

    python tests/sheet_bench.py --build   # natives.zip -> tests/out/sheet_truth.json
    python tests/sheet_bench.py --fit     # refit PEPTIDE_TABLE, print it
    node tests/sheet_bench.js             # score the strand frames
    node tests/sheet_bench.js --sweep     # try other relaxation settings

`--fit` fits the table the backbone rebuild reads (C and N offsets in a local
frame, binned PULCHRA-style) on half the chains and reports the other half: C to
0.21 Å rms, N to 0.17 Å, the C=O direction to 8.8°. Paste its output back into
`viewer-cartoon.js` to regenerate `PEPTIDE_TABLE`.

`sheet_bench.js` scores the strand frames in degrees, over residues of real
H-bonded ladders: **partner face** (how far apart the ribbon faces of two paired
residues are — "do neighbouring strands stack edge to edge") and **strand twist**
(how far the face rolls between consecutive residues). Current: **22.2°** and
**11.3°**, against 38.8° and 21.3° for the C-alpha curvature frames these
replaced. The partner-face figure is at its floor — the sheets themselves twist
20.0° between paired residues, given each ribbon's face is perpendicular to its
own strand.

## Nucleic base frames — `na_table.py` / `na_bench.js`

    python tests/na_table.py --build   # fetch/parse ~90 structures -> tests/out/na_truth.json
    python tests/na_table.py --fit     # refit NA_BASE_TABLE, print it, score held out
    node tests/na_bench.js             # score the predictor the renderer ships

py2Dmol keeps one atom per nucleotide (the C4'), so where a base points is
predicted from the trace, exactly as the peptide backbone is. `--fit` fits on
half the chains and reports the other half; paste its output back into
`viewer-cartoon.js` as `NA_BASE_TABLE`.

Current: direction **16.7°** median (p90 69°), normal 16.6° (p90 62°), coverage
99.9% of nucleotides. The tail is physical rather than a fitting limit — a base
can sit anti or syn on an identical backbone — which is why the renderer widens
its pairing gate, flips bases that point away from their partner, and caps the
per-residue ribbon twist. `na_bench.py` is the older benchmark of the ribbon
face and carries its own replica of the frame construction.

## Performance

See `PERF_NOTES.md` — measured phase breakdown, the cost equation
(`fills ≈ stations × surfaces`), and a table of optimisations that were tried
and did NOT work, so they are not retried.
