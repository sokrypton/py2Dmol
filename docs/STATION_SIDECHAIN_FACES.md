# A side-chain face goes missing when an object has more than one frame

**Status: FIXED, with the fast path kept.** The elbow-notch regression found
alongside it was a different defect and is shipped separately (`cbdda19`).

**THE FAULT WAS THE NORMAL, NOT THE CORNERS.** `VS3D_STATIONS` took a stick
face's outward and shading normals from the SECTION'S OWN FRAME VECTOR - `ub`
for the +u side, `wa` for the +v one, the tangent for a cap - and that is the
face normal only while the section is PERPENDICULAR to the bond. A stick's
routinely is not: a mitred junction and the flush cut where a side chain meets
the backbone both slide the four corners along the bond, which tilts `ub` and
`wa` out of the faces they are supposed to stand on while the faces themselves
do not move. `buildMeshPart` never used the axis for a stick - `f.stick` takes
the Newell sum over the face's own four corners - so the two derivations
disagreed by whatever the cut's obliquity is.

The cull is `dot(fn, vd) < -0.02`, so a face seen near edge-on is decided by a
few hundredths, and one side face of the ILE arm was kept by the build and
culled by the stations. **`stickFaceN` (GLSL) and `stickFaceNormalInto` (JS)
are that Newell sum over the corners the station rule already reconstructs**,
with the axis choosing only the sign - so the shader, `buildMeshPart`'s SM
block and `refreshEdgesFromStations` now answer with one number, which is the
remedy `stationBoundsInto` already carries.

Measured on the reproducer below, all three arms in ONE page load at 700x700:

| | ink | vs the one-frame render | vs the station path off |
|---|---:|---:|---:|
| one frame | 48,333 | - | 304 px |
| **25 frames, station path ON** | **48,324** | **9 px (304 px differ)** | **0 px** |
| 25 frames, station path off | 48,324 | 9 px (304 px differ) | - |

The 304 px between the two OBJECTS is the irreducible difference the doc
already records (`stdDev`/`maxExtent` differ between a 1-frame and a 25-frame
object); against the station-path-off control of the SAME object the fast path
is now **pixel-identical**. **The fast path is kept**: `__drawProgram` reads
`stations`, and 24 trajectory steps rebuild 0 times. `tests/station_frames.py`
reads 3.10 ms a step against a 3.00 ms baseline - inside its own noise.

**`tests/station_stick_faces.py` is the gate**, on a tracked-recipe fixture
rather than the states below (which are gitignored): `_traj_3ptb.pdb` with
every side chain shown, three cameras, three frames each, the station draw
against a forced rebuild of the same frame - worst 4 px of 357,604, and it
asserts WHICH program drew each arm so the two cannot both be the same path.
Three mutations, each caught: the shader's outward normal (14,124 px), the
shader's shading normals (12,337 px) and the JS rule behind the outline
(2,810 px).

Everything below is the diagnosis as it stood, kept for the eleven mechanisms
it rules out.

🔴 **AND A THIRTEENTH WAS RULED OUT ON THE WAY**: the section reconstruction
itself. `stationOfSec` (`cartoon/geom.js`) stores a quad as `mid`, `wa*hw`,
`ub*ht`, which can only express a PARALLELOGRAM - and a mitre slides each
corner along the bond by its own amount, so the obvious suspicion is that the
section is not one. Measured over all 11 stationed segments of the reproducer,
both ends: worst corner error **4.4e-16 A**. The corners were always exact.

Reported from the app, repeatedly, over several sessions:

> *"faces are still being lost, and I wonder now if the regression happened
> when we added the element support"* ... *"one clue if you open just the final
> structure it's fine, it's only when you open as multiple frames something
> goes out of wack, like the frames are not correctly defined."*

That clue is the whole diagnosis: **the trigger is the frame COUNT, not the
geometry.**

🔴 **THE GOAL WAS TO KEEP THE FAST PATH.** Disabling the station path cures the
symptom and is not a fix - it is only used below as the control that proves
where the fault is. It is kept: the fixed path still rebuilds nothing on a
step.

## The reproducer

Two states, the same molecule, the same frame, the same camera:

| file | what it is |
|---|---|
| `py2dmol_state_2026-09-20T14-23-38.json` | the reader's own save: PRO+ILE fragment, 10 drawn positions (2 backbone + 8 side-chain atoms), **25 frames**, opened on frame 24, extent 4.22 (very close), GPU, richardson, thickness 0.7 |
| `py2dmol_state_ONEFRAME.json` | the same file with `objects[0].frames` sliced to `[frames[-1]]` and `current_frame` set to 0 |

Regenerate the second with:

```python
import json, copy
d = json.load(open('py2dmol_state_2026-09-20T14-23-38.json'))
one = copy.deepcopy(d)
one['objects'][0]['frames'] = [copy.deepcopy(d['objects'][0]['frames'][-1])]
one['viewer_state']['current_frame'] = 0
json.dump(one, open('py2dmol_state_ONEFRAME.json', 'w'))
```

🔴 **DO NOT BUILD THE ONE-FRAME CASE BY COPYING A FRAME IN THE PAGE.** A frame
carries a `sidechains` table and a `JSON.parse(JSON.stringify(frame))` round
trip flattens it: the object then draws 2 positions instead of 10, a backbone
with no side chains, and every measurement taken through it is a measurement
of nothing. Slice the FILE and load it through the session loader, which is
the same serialisation the app writes.

## What it looks like

At the saved camera, the ILE arm is a solid bar with a dark side face running
its length in the one-frame render; in the 25-frame render that side face is
**gone** and the arm reads as a pale flat plate with a narrower silhouette.
The reader's screenshot and a render of their own saved camera match
bend-for-bend.

## The measurement

Load each state, go to the last frame, size the canvas to 700x700, render,
and count inked pixels (compose the direct-present layer UNDER the canvas -
see `probe_js.HELPERS`; reading the canvas alone misses the drawing).

| | ink | vs the one-frame render |
|---|---:|---:|
| one frame | 48,333 | - |
| one frame, loaded a second time | 48,333 | **0 px** |
| **25 frames** | **47,278** | **1,073 px** |
| 25 frames, `renderer._autoStationTable = false` | 48,324 | **27 px** |

The second row is the control that makes the rest admissible: this file's own
rule is that GPU pixels are not comparable across page loads, and here they
are - two loads of the same state agree exactly. The 25-frame figure
reproduces to the pixel on repeat loads.

The missing ink is **one contiguous blob**, not a speckle: clustered in five
adjacent 100px cells, with identical ink bounding boxes (same width, same
height, same corners) in both renders - so it is not a shift, a scale or a
projection difference.

## Where the fault is

**The trigger** is `paintgl.js` ~9345:

```js
if (ob && ob.frames && ob.frames.length > 1) {
    setStationDraw(true);
```

Any object with more than one frame turns the station path on. With it on,
`rowsUnused` / `sideRowsUnused` (~5860, ~5899) deliberately skip BUILDING the
48-float instance rows for the ribbon and for the stationed side chains,
because `drawResident` issues those parts from the station buffer instead.

**So the two renders differ only in which derivation draws those faces**, and
the station one loses a stick face.

## What it is NOT - all measured on this reproducer, do not re-run

| | |
|---|---|
| the coordinates | identical, worst delta **0.000 A** |
| the bond graph | 10 positions, 10 segments, 9 bonds, identical |
| the faces `geom.js` emits | identical: **66 emitted, 25 drawn, 22 culled, 19 buried**, face orientations equal to 3 decimals |
| the camera | same scale (70.318), extent, zoom, thickness, detail |
| the projection | pinning `stdDev` AND `maxExtent` to the one-frame values moves it 1073 -> **1049 px** |
| the per-frame update | `stationRefusal`, `stickRefresh`, `stationUpdate`, `edgeRefresh` are **all null** - nothing stepped; the fault is in the BUILD-with-stationDraw and the DRAW |
| a face lost at pack time | no: **86 faces, 86 rows, 32 stations, 0 invalid station indices**, identical `surf` histogram both ways |
| the instance rows | `window.__stationRowCheck = true` forces them to be built and changes **nothing** (47,278) |
| `wFlat` (the one normal computed differently when rows are skipped, ~4400) | forcing it on changes **nothing**; it is guarded on `isRibSide` and the lost face is a STICK face |
| a `surf` the station shader has no case for | no: the shader handles 4..10 (its comment saying "0..5" is stale) and no face carries `surf > 10` |
| the stick LOD | 9 bonds, **0 flat**, section 0.25x0.25 |
| the cull and `buried` | disabling either changes **0 px** |
| element colouring | elements on vs off: **23 px** of 1.03M |
| the mitre ax-ward fallback | **0 hits** over 24 rotations |
| drag matrix drift | 720 incremental multiplies: orthonormality 3e-14, **0 px** lost |

## What is left, and the next step

The station shader (`VS3D_STATIONS`) reconstructs each face's four corners
from `(aStation, aSurf, aPiece)` and the station texture. `buildMeshPart`
writes the same face's corners from the prim. **Those two derivations
disagree for at least one stick face**, and the face is near edge-on, so the
disagreement costs the whole face rather than a few pixels.

The codebase already records this exact class of fault for OUTLINES, a few
lines from the code in question (`paintgl.js` ~5870): *"Built from the winding
while drawn from the stations, a side chain's outline was derived one way at
build and the other on every frame after: 2,299 of 18,304 edge rows carried a
different normal."* This is the fill-face version of it.

**Do this**: replicate the station program's corner reconstruction in JS for
these 86 faces - the formulas are in `VS3D_STATIONS`, one branch per `surf`,
4..10 for sticks - and diff against the corners `buildMeshPart` writes for the
same face. That names the face and the surface. Then make the two derivations
ask the same function, which is the remedy the ribbon's centroids already got
(`paintgl.js` ~7410: *"So both paths ask this function, and the answer is the
same number"*).

`window.py2dmolCartoonGPU.setInstanceLimit(k)` draws only the first k
instances and is useful here, but note the two modes do not share a draw
order, so a per-index comparison across modes attributes ink to the wrong
face.

## Why the suite did not catch it

`tests/station_rows.py` passes (77,620 rows, 0 differing floats). It compares
the STATIC FLOATS of the rows, on 1UBQ, 1AOI, 1EHZ and `_traj_1tim` - **none
of them with stationed side chains** - while the draw takes its geometry from
the station buffer. Its normals check covered **1,536 of 12,480** faces.

A gate for this belongs beside it: the reproducer pair above, asserting that a
multi-frame object draws its last frame the same as that frame alone.
