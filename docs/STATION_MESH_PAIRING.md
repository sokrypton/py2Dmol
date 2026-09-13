# A restored mesh and the station table it is drawn from

**Status: DIAGNOSED, NOT FIXED.** Reproduces today on `main`. This is the note
so the diagnosis is not lost between landing the three-way side-chain control
and doing the fix properly.

## Reproduce

Load 1YNE (a 31-nucleotide RNA hairpin, 20 models). On the side-chain row press
**Hide**, then **Plate**, then **Hide** — or **Hide, Show, Hide**. The hairpin
comes back as two large translucent spheres and a handful of stray lines.

```
python3 tests/... (no probe yet; scratch harness pressed the real buttons)
```

It is **not** new. It reproduces at `eefdd66` through the control that shipped
before the three-way one (a Show/Hide pair with a Plate checkbox), so it is
live on the website today.

## What it is not

- **Not the outline.** Forcing `cartoonInk = false` changes nothing; the wrong
  shapes are in the fill.
- **Not the selection mark.** Clearing the selection leaves them.
- **Not the geometry.** The 2D painter draws the same state correctly at every
  step, which is what says the mesh rather than the capture.
- **Not a missing invalidate in the panel.** Every count agrees.

## What it is

The GPU state for a cartoon is TWO HALVES:

| | holds |
|---|---|
| the mesh | fill, edges, centroids, residue map, part spans |
| the station textures | the ribbon's actual geometry |

On the station path `rowsUnused` is true, so the ribbon's instance rows are
never built and **every corner the card sees comes from the station table**.
`restoreMesh`'s own comment says the slot is half the picture.

`captureMesh` does store the table with the mesh:

```js
residentStations: residentStations ? Object.assign({}, residentStations) : null,
```

but that is a SHALLOW copy. The mapping arrays — `faceStation`, `faceSurf`,
`facePiece` — are restored correctly. `stationTex`, `pieceTex` and `buf` are
**shared by reference across every cached mesh**, and `updateStations` uploads
into those same textures in place.

So a restored mesh comes back with the RIGHT MAPPING and the WRONG CONTENTS.

Measured on the third press of Hide/Plate/Hide:

```
meshFaces 482   tableCount 482   tableLen 482   residentCount 482
```

Everything agrees, because everything that is compared is the mapping.
`stationsMatch` walks `faceStation`/`facePiece` and finds them equal — it is
comparing the new table against the RESIDENT table, on the assumption that the
resident table describes the resident mesh, and a Tier-1 restore has just
swapped the mesh out from under it. The press-1 mesh (482 faces, no plates) is
drawn through textures holding press-2's geometry (658 faces, with plates).

The sequence matters because a restore is what pairs them:

```
press 1  Hide    482 faces   rebuild
press 2  Plate   658 faces   rebuild
press 3  Hide    482 faces   RESTORED from the Tier-1 cache -> wrong contents
```

## Why the checks do not catch it

Every guard is PAIRWISE and every one compares the mapping:

- `installStations` compares counts, and allows a smaller table as a PREFIX —
  right when the tail is ligands or contacts, silent when the ribbon shrank.
- `stationsMatch` compares table against table, not table against MESH.
- `stationSplicePlan` verifies its plan by replaying it, and is sound; it is
  simply not reached.

Nothing compares WHICH CAPTURE each half came from.

## The fix, and what it must not cost

Make the two halves one value: a mesh and the station table it was built from
are cached, restored and stamped together, so a table describing another mesh
is unrepresentable rather than caught.

**It must not slow the fast path.** The point of the station table is that a
step is a texture upload rather than a rebuild. The baseline to hold, measured
before any of this:

```
1TIM trajectory, 20 steps, side chains off : 0 ribbon rebuilds, 19 station steps
1TIM trajectory, 20 steps, side chains on  : 0 ribbon rebuilds, 19 station steps
1EHZ trajectory, 12 steps, either way      : 3 ribbon rebuilds,  8 station steps
```

Two candidate mechanisms, and the choice is a measurement rather than an
argument:

1. **Give each cached mesh its own station textures.** No per-frame cost; costs
   GPU memory, bounded by the existing `MESH_CACHE_MAX_BYTES` and 8-entry cap.
2. **Re-upload the contents on restore.** Free in memory; costs one texture
   upload of data already in hand - the same operation a frame step performs,
   and no capture and no rebuild.

🔴 **AND `invalidate()` IS NOT THE FIX.** Calling
`py2dmolCartoonGPU.invalidate()` from `setBasesFor` and `_setSidechains` does
make the pictures correct - it was written, measured and removed - because it
works by never letting the pairing happen. That is rebuilding to avoid a wrong
update, which is the thing the station path exists to stop doing, and it covers
only the two doors that happen to have been found: a focus click, a session
restore and an eye toggle can pair the same halves.

## Unrelated, found on the way

`tests/station_integrated.py` FAILS on `main` and is **not in `tests/run.sh`**,
which is why every green suite misses it. Its counts are healthy - the path is
taken 22/33 with 0 rebuilds - and what it reports is that the station path
measures SLOWER than a plain rebuild on these small trajectories (13.60 ms
against 6.90 on `_traj_1tim.pdb`), and that `_traj_unfold.pdb` draws 0.124% of
its pixels differently from the same frame rebuilt. That last one is the thing
`docs/FRAME_STABILITY.md` already names as shipping unchecked.
