# A focus click rebuilds the ribbon — the clean slate

**Status: REVERTED, AND THE PROBLEM IS OPEN AGAIN.** This file briefly said
SOLVED. It was not: the change shipped, drew side chains in the wrong place
after a visit to focus mode, survived three separate fixes, and was taken out
in `8261f7c`. `src/cartoon/paintgl.js` and `geom.js` are back at `0719bb3`, the
focus click costs its ~28-52 ms of mesh rebuild again, and everything below
about the problem and its measurements still stands.

🔴 **THE PREMISE IS WHAT FAILED, NOT THE THREE BUGS FOUND IN IT.** The mesh is
built in a space measured from the CAMERA. It survives a ZOOM exactly - proved
twice, bit-identical digests - and it does NOT survive a PAN: `tests/scale_indep.py`
measures an 8 A pan changing every corner, fill `4052370906` -> `3722347299`.
That measurement was taken, seen, and talked past, on the reasoning that
`viewShift = capCentre - liveCentre` would absorb it. It does not, because a
KEPT ribbon and a freshly BUILT side-chain part then sit against two different
cameras with one `capCentre` recorded for the pair.

So the way to have this is to build the mesh about the **structure** rather
than about the view centre, and let the camera be a uniform the way the
rotation already is. Patching `capCentre` after the fact was tried three times
(`7c7e677`, `c1b67a5`, and the `installStations` coverage gate) and cured
nothing.

🔴 **AND NO PROBE IN THIS REPO CAN SEE THAT CLASS OF FAULT.** `focus_faces`,
`focus_pixels`, `ribbon_bypass` and `scale_indep` all compare a frame against
THE SAME FRAME REBUILT - and a bad cache key produces a consistently wrong
answer that a rebuild reproduces faithfully, so the difference is zero while
the picture is wrong. All four reported green throughout. The fault was found
by a reader looking at the screen, and confirmed by a by-hand bisect. **Before
this is attempted again, write something ABSOLUTE** - same camera, same state,
before and after - and make sure its control cannot be the thing being
measured, which is where the first attempt at one went wrong.

## The problem, stated without a solution in it

A focus click changes the side chains and moves the camera. The side chains are
new geometry and have to be built. The ribbon is not — it is the same 9,128
faces before and after — and it is rebuilt anyway, on every click.

Measured on 4HHB, 748 positions, station path on (`python3 tests/focus_cost.py`):

```
enter focus mode   builds 1  ribbonReused=False  nRib=9128  capture 17.9  total 52.0 ms
focus click 1      builds 1  ribbonReused=False  nRib=9128  capture 11.0  total 28.4
focus click 2      builds 1  ribbonReused=False  nRib=9128  capture 14.3  total 45.9
focus click 3      builds 1  ribbonReused=False  nRib=9128  capture 11.8  total 29.9
background click   builds 1  ribbonReused=False  nRib=9128  capture 12.6  total 43.4
```

A plain zoom, a plain `autoClip` and side-chains-off each cost **0 builds**, so
none of those is the cause on its own.

## Why: the key is taken in the space the camera moves

`ribbonHashOf(faces, scale, prm)` did `mix(scale)` and then hashed each face's
`f.q` **as it stands, which is projected**. A focus flight moves the capture
scale on every frame it lands a build on:

```
9.827 → 10.883 → 11.272 → 11.669 → 12.412 → 12.888 → 13.315
   with the face count constant at 9128 and the key different every time
```

The `pOnly` term — face count plus every build parameter — is **constant**
across all of them, so it is the corners and nothing else.

## The mesh was never scale-dependent, only the key was

`python3 tests/scale_indep.py` builds the mesh at two zooms and digests it:

| | fill | edges |
|---|---|---|
| zoom 1.0 | 3498732323 (10,952 rows) | 438750288 |
| zoom 1.6 | 3498732323 (10,952 rows) | 438750288 |

Bit-identical, with the station path OFF so the ribbon's own 48-float rows are
built rather than skipped — which matters, because with them skipped the fill
digest covers only the sticks and says nothing about the part in question.

**But it IS pan-dependent.** The same probe pans the centre 8 Å:

```
at centre:  fill 4052370906  edges 1965219939
panned 8 A: fill 3722347299  edges 3564476453     DIFFERENT
```

`unproject` measures from the capture viewport's middle, so the mesh lives in a
space centred on the camera. A focus click moves both the zoom and the centre.

## What the patch does, and how far it gets

`ribbonHashOf` takes the capture centre and hashes **model-space** corners —
unproject written out inline so it allocates nothing, plus the centre — and it
does that **only where `rowsUnused`**, i.e. where the part's own rows are
neither built nor drawn and every corner the card sees comes from the station
table. Everywhere else the key is exactly what it was, because there the corners
in the part ARE the drawn geometry and a camera move really does change them.

The side-chain part is given `rowsUnused` too (its rows were being built and
never issued), and `makeResident` passes the centre down.

Result, same probe:

```
enter focus mode   ribbonReused=True   total 52.0 → 32.5 ms
focus click 1      ribbonReused=True   total 28.4 → 21.7
focus click 2      ribbonReused=True   total 45.9 → 17.3
focus click 3      ribbonReused=True   total 29.8 → 36.8
background click   ribbonReused=True   total 41.6 → 15.1
```

## What blocks it: the outline, and only the outline

`python3 tests/focus_pixels.py` clicks four times and compares each frame with
the same state rebuilt:

| | outline ON | outline OFF |
|---|---|---|
| committed (`0719bb3`) | reused=False, 0% | reused=False, 0% |
| with the WIP patch | reused=True, **2.4 – 4.8%** | reused=True, **0.0000%** |
| with stationMesh `p.sc` fix | reused=True, **0.0000%** | reused=True, **0.0000%** |

So the reused ribbon's geometry, colours, fills and outlines are **exact**.

The root cause for the 2.4–4.8% outline difference was found with a per-lane diff
of `residentEdges.ed`: all 18,256 ribbon edge rows differed by the exact same
constant `(dx, dy, dz)` vector across all endpoints:
`dx = 20.171742, dy = 6.902069, dz = 21.476221` (lanes 0–5 only; lanes 6–19 had 0
differing rows). This was the camera pan shift between the capture centre and the
current frame.

`refreshEdgesFromStations(mesh)` was supposed to rewrite those endpoints, but had
appeared to move the number by zero because `installStations` was refusing to
install: `stationMeshOf` stationed ligand sticks and joints (which belong to
`groups[1]`, the non-stationed tail) into `scratch.faceStation` (11,050 faces),
exceeding `stationFillFaces.length` (9,228 faces). Guarding `stickFace` and `joint`
in `stationMeshOf` with `p.sc` ensures that only side chains enter the station table,
allowing `installStations` to install and run `refreshEdgesFromStations` cleanly.

## Three traps, each of which cost a round

🔴 **A SETTLED CAMERA CANNOT SEE THIS.** `focusOn` ANIMATES, so the one build a
click costs is taken mid-flight. Wait for the flight to land and **both trees
reuse the ribbon**, because consecutive builds then share a camera — the probe
reported identical numbers for the committed tree and for three different
versions of the patch, which is the measurement saying it is not measuring
anything. `focusOn(sel, {animate: false})` jumps instead: the camera is static
when the shot is taken and has still MOVED since the previous build, which is
the case the key has to handle. The control is the committed tree, which must
read `reused=False`.

🔴 **AND THE FIRST VERSION OF THAT PROBE READ 7.9% ON AN ARM THAT REUSED
NOTHING.** It shot the canvas a few frames into the flight and rebuilt a few
frames later — two different cameras. A control arm that should read zero and
reads 7.9% is the probe telling you to fix the probe.

🔴 **AND THE SLAB IS INNOCENT.** The first diagnosis here was that `autoClip`
invalidates the ribbon, on the evidence of one arm where `{clip: false}` reused
it. It does not: that arm reused because its build happened to land at the
previous build's scale. `autoClip` on its own costs 0 builds, and the capture
already nulls the slab deliberately (a mesh built under a slab is missing every
piece that straddles a plane; the shader does the cutting). Trace the key, not
the feature.

## What is already there and did not need building

`viewScaleMul` and `viewShift` (`capCentre - liveCentre`) already exist and are
applied at draw time, so a mesh captured at one camera and drawn at another is
already handled — that machinery is not the obstacle and does not need writing.

## Unrelated, found on the way

`__meshDigest` strides the edge buffer at 19 while `ED_FLOATS` is 20, so the row
counts it prints are meaningless (`21044.21 rows`). It still detects change,
being a rolling hash, but the two should be in step.

## The probes

| file | asks |
|---|---|
| `tests/focus_cost.py` | what each focus action rebuilds, with the cache key traced |
| `tests/focus_pixels.py` | does a reused click draw what a rebuild draws — with the outline-off arm that separates fill from outline |
| `tests/scale_indep.py` | is the mesh the same mesh at two zooms, and across a pan |

None of them is in `tests/run.sh`'s lists: they are instruments for this
question, not assertions about today's tree. `focus_pixels.py` is the one to
promote to a real probe if this ships, with the committed tree as its control.
