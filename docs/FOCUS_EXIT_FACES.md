# Side chains drawn in the wrong place after leaving focus mode

**Status: FIXED.** First by reverting the premise that caused it (`8261f7c`),
then properly in `acc8357`, which rebuilds the mesh about the STRUCTURE rather
than the view centre and keeps the focus-click speedup. Verified on 4HHB,
3PTB, 1EHZ and 1AOI: `focus_faces` clean, `test_absolute_focus` 0/0.

The bisect that found it, done by eye on a server sending `no-store` with the
served bytes hash-checked against each commit, because every automated probe
read green throughout:

```
0719bb3   clean
d723a62   BROKEN     the ribbon starts being kept across a camera move
7c7e677   BROKEN     the centre unpacked correctly - not sufficient
c1b67a5   BROKEN     stations realigned by the delta - not sufficient
8261f7c   clean      reverted
acc8357   clean      rebuilt about the structure
```

See `docs/FOCUS_REBUILD.md` for the premise and what it took to hold it.

Reported from the app, not from a test:

> *"i noticed after going to focus mode, some faces of side chains disappear,
> even when exiting the focus mode, when i show sidechains, the faces disappear
> at certain angle"*

## Reproduce

```
python3 tests/focus_faces.py          # 4HHB, exits 1 against 0e91c82
```

It turns the structure through eight angles and compares each with the **same
angle rebuilt from scratch**. `missing` is ink the rebuild draws that the frame
does not; `extra` is ink the frame draws that the rebuild does not.

## What it measures

Against `0e91c82` — the live build:

```
A. side chains, never focused              0 – 4 px at every angle   (control)
B. just left focus mode, nothing re-shown  3,141 missing / 14,829 extra
C. and now the side chains shown again     ~100 px                   repaired
```

So it is **the exit** that does it, and **any later rebuild repairs it**, which
is why it reads as intermittent from the app: do anything that rebuilds the
mesh and the picture comes back.

## 🔴 NOTHING IS MISSING. THE FACES ARE IN THE WRONG PLACE

This is the part that decides where to look. Measured immediately after the
exit:

| | |
|---|---|
| the side-chain set | 90 residues |
| side-chain faces the frame is carrying | **2,758** |
| side-chain faces a rebuild of the same state draws | **2,758** |

Same count, same set. The faces exist and are drawn — somewhere else. That is
why they read as gone from one angle and doubled from another, and it is why
the report says "at certain angles": nothing is angle-dependent in the fault,
only in which part of the damage the reader happens to be looking at. All eight
angles are equally wrong.

`extra` being five times `missing` says the same thing from the other side: the
frame is putting ink where the rebuild puts none.

## What is ruled out

- **Not the station path being switched on mid-session.** Turning it on by
  hand with no focus mode anywhere near it costs ~100 px. It is the focus round
  trip, not the transition.
- **Not the side-chain set.** 90 residues before and after, and the face counts
  agree exactly.
- **Not entering focus mode, and not re-showing the side chains.** Leg B has
  nothing re-shown by hand and is already broken; leg C re-shows them and
  repairs it.
- **Not angle-dependent.** Eight of eight angles, similar magnitudes.

## Where it probably lives

The mesh is built in a space measured from the CAMERA, not from the structure:
`unproject` returns coordinates relative to the capture's view centre, and an
8 Å pan changes every corner — measured, `python3 tests/scale_indep.py`:

```
at centre:  fill 4052370906  edges 1965219939
panned 8 A: fill 3722347299  edges 3564476453     DIFFERENT
```

(It is scale-invariant; only the centre moves it.) Focus moves the camera, the
exit moves it back, and `viewShift = capCentre - liveCentre` with
`viewScaleMul` is the machinery that is supposed to absorb exactly that. The
question to answer first is **which part is positioned against which camera
after the exit** — the ribbon is now kept across a camera move (`d723a62`,
model-space key) while the side chains are rebuilt, so the two halves of the
mesh can be captured at different cameras and only one `capCentre` is recorded
for the pair.

**The instrument that answers it is a buffer diff, not pixels.** Dump the fill
(and `residentEdges.ed` / `edSrc`) after the exit and after a forced rebuild of
the same state, key the rows by provenance so inserted rows do not shift the
comparison, and report **per lane**. That method found the stationed-stick
normals in `0719bb3` — 2,299 rows on lanes 6–11, worst 1.997 on a unit vector —
in one run, after pixel forensics had said nothing useful for an hour. If the
positions come back off by ONE CONSTANT VECTOR, it is a camera the part was
never told about; that is exactly how the stale outline endpoints read
(`20.171742, 6.902069, 21.476221` on lanes 0–5, zero rows differing on 6–19).

## The second one, not shipped

The capture-stage ribbon bypass in the working tree fails the same probe far
harder — **90,334 – 103,119 px missing at every angle**, against ~3,100 live.
Fix the live one first; they may or may not be the same fault.

## 🔴 THREE WAYS THIS PROBE LIED BEFORE IT TOLD THE TRUTH

Each looked like a result, and the third one is why the first report of this
said the live renderer was clean.

- **A sweep that rebuilds at every angle repairs the mesh as it goes**, so it
  measures the first angle and a healthy mesh for the seven after it. It
  reported one bad angle and seven clean ones. Two passes now: the first never
  rebuilds, the second is the reference.
- **There is no `rotateBy`.** Rotation is a matrix on `viewerState.rotation`,
  and calling a method that does not exist fell through to writing
  `V.rotationY`, which nothing reads — so eight angles were one view eight
  times. **Every row reading identical numbers is the tell**, and the file now
  fails if the control's rows do not differ.
- 🔴 **AND FORCING `setStationDraw(true)` ARRANGES THE ONE STATE WHERE THIS
  DOES NOT HAPPEN.** `renderApp` turns the station path on by itself when focus
  mode is entered (`|| renderer._focusMode`), so a single-frame structure gets
  there with a mesh built WITHOUT stations and the path switched on underneath
  it. Forcing the flag before the first build reported the live renderer clean
  and shipped that verdict. **Drive the route the reader drives; a probe that
  arranges its own conditions measures the arrangement.**

`exitFocusMode` also ANIMATES the camera back, so a shot taken before it lands
compares two cameras and reports tens of thousands of pixels for nothing. The
file waits for the camera to hold still.

## Resolution

### 1. The Live Regression (`0e91c82` -> fixed in `7c7e677`)
Two interrelated defects caused the 3,141 missing / 14,829 extra pixels:
1. **Array unpacking in `ribbonHashOf`**: `centre.x` was accessed on an Array `[c.x, c.y, c.z]` returned by `viewSpanOf(renderer).centre`. `centre.x` evaluated to `undefined`, making `(c0 + undefined) * 512 | 0 = 0` for every face corner and causing all corners to hash to the exact same bucket.
2. **Reusing unstationed `ribbonPart` on the station path**: Single-frame structures start with `stationDraw = false`, so `buildMeshPart` leaves cross edges out (`nGhostOnly = 9,104`) and sets `edgeSrc = null`. When focus mode turns `stationDraw = true` and then exits, `canSkipRibbon` and `makeResident` did not check `part.edgeSrc`. They reused the unstationed ribbon part. On the fast path, `refreshEdgesFromStations` could not refresh the edges (`edSrc` was null). `drawResident` applied `uShift = resident.capCentre - fr.centre` (~26.5 Å), shifting the stale unstationed outline edges into empty space (14.8k extra pixels) while 9.1k cross edges were missing entirely.
- **Fix**: Require `!!ribbonPart.part.edgeSrc` in `makeResident` and `canSkipRibbon`, and correctly unpack `[cx0, cy0, cz0]` in `ribbonHashOf`.

### 2. The Opportunity 1 Ribbon Bypass (`90k-103k px missing` -> fixed)
- **Base station camera misalignment**: When `willSkipRibbon` bypassed ribbon 2D rendering, `stationMeshOf` reused `baseMesh` (`residentStationMesh`). However, `residentStationMesh` held stations relative to `baseMesh.centre` (`C_old` from the focus pocket), whereas newly captured sidechains were relative to `capFr.centre` (`C_new`). Without adjusting the stations, the ribbon stations and sidechain stations were in different coordinate frames.
- **Trace & ligand marks**: Skipping ribbon 2D rendering in `render()` skipped ligand marks.
- **Fix**:
  1. In `src/cartoon/paintgl.js`, shift base stations in `stationMeshOf` by `dx = bCx - Cx`, `dy = bCy - Cy`, `dz = bCz - Cz` to align with the active camera center.
  2. In `src/cartoon/geom.js`, bypass only the ribbon 2D emission inside `drawRun` when `renderer._skipRibbonPrims` is set, preserving trace points and ligand marks.

