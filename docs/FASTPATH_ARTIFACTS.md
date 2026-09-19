# Fast-path artefacts during playback

A brief for whoever picks this up, human or agent. It covers the problem, what
has been measured, what is fixed and what is not, and the instruments. Read
`CLAUDE.md` first for the project rules; this file assumes them.

## The contract

A trajectory step on the GPU painter does not rebuild the mesh. The **station
fast path** (`src/cartoon/paintgl.js`: `stationsMatch`, `updateStations`,
`refreshEdgesFromStations`) keeps everything the **build** produced (faces,
pieces, the edge table that the outline is drawn from, per-face flags) and
rewrites only the station geometry (a model-space frame plus half-width and
half-thickness per station). The build frame is whichever frame last rebuilt.

**The contract is: a frame drawn on the fast path must look like a fresh build
of the same frame.** Every bug below breaks it. The picture is right after a
rebuild, which is why a reloaded session "fixes" it: loading builds at the
saved frame.

**The constraint from the user: the fix is not a rebuild.** Declining the step
(forcing a build) is the cheap way out. The whole point of the path is that a
secondary-structure letter changing costs no build. A fix that declines was
written for problem 1 and rejected: it cost 3 rebuilds over 24 steps. Keep the
topology the build made and make the per-frame pass answer correctly.

## Problem 1: a line across a strand where it used to be broken (FIXED)

**Report.** An AlphaFold 3 fold played in LocalFold at Detail 4. A strand that
was broken in an earlier frame (`EEC...` / `ECE`) and whole in a later one
(`EEE`) shows a thin outline stroke across the strand at the old break,
through the broad face and the side. It appears only while playing; a rebuild
or a reloaded session does not show it.

**Cause, measured.** The edge table is keyed by corner POSITION. Where the
ribbon has no thickness at a station (a flat point, the first copy of a
duplicated station), the top face's corner and the bottom face's coincide. The
build then files them as ONE edge with two faces. Later frames give the
station its thickness back, but the row still names both faces: its endpoints
come from one face, its two normals are roughly perpendicular, and the
shader's silhouette test (`aAlways == 0`, `f0 != f1`) draws it. It was found
by bisecting over outline rows (see the instruments below): switching off one
row, #893 (face 449, surf 1, at station 112, and face 452, surf 0, at station
113), removed every extra dark pixel.

**Fix, uncommitted, in the working tree.** `clipOpenWelds` (paintgl.js),
called from `refreshEdgesFromStations`. It collects once per edge table the
rows whose two faces are on OPPOSITE surfaces: 0/1 top/bottom, 2/3 the two
sides, and the stick pairs 7/9 and 8/10. Each frame, it checks that the second
face still has corners at the row's two endpoints, and sets `aAlways = -1` for
the frame when it doesn't. The main refresh loop rewrites every two-face row's
flag first, so a row comes back by itself when the station collapses again.
`stationCornerInto` is the corner arithmetic, shared with the refresh.

**Test: `tests/weld_open.py`**, in the gpu lane. The two frames are inline
(alpha carbons only) with the saved rotation. It builds at the broken frame,
steps on the fast path, and counts pixels DARKER than a fresh build: 27 with
the fix, 153 with the call removed; the bound is 70. It also asserts the step
did not rebuild.

**Still to do for problem 1:**
- The neighbouring probes pass (`sheet_merge`, `station_ligand`,
  `station_sidechains`, `gpu_mesh_reuse`, `station_frames`, `station_corners`,
  `station_pixels`, `arrow_rebuilds`, `ss_axis`, `multi_step`, `station_rows`,
  `smoke`, `paint_trace`). The FULL suite has not been run.
- **Residual: 20 to 60 darker pixels per step, from any build frame.** They sit
  at arrow ends: the top strand's end draws a small notch in the fast frame. The
  earlier assumption was tie-break noise. That is unproven: bisect the rows the
  same way and see whether one class of row accounts for them.
- Is "opposite surfaces" the whole class? A row welded across a station that
  had zero WIDTH at build (sides 2/3) is covered. A weld between a cap (surf
  4/5) and a broad face is not, and neither is the reverse: a station
  collapsing where the build had thickness, which gives two lone rows that now
  coincide. `refreshEdgesFromStations` already clips lone cross edges that land
  on each other; along edges may not be covered.

## Problem 1b: side chains cost a rebuild on every step (FIXED)

Not the reported fault, but what every attempt to measure the reported fault
ran into, and a performance bug in its own right: with side chains shown, 20 of
24 steps rebuilt - *"the station mapping moved: 948/496 stations and pieces
against 950/498"*. The RIBBON was constant (464/232 with side chains hidden,
930 faces with them shown); the sticks moved.

**Cause.** Two rules in `cartoon/geom.js` asked the DRAWN FRAME a question whose
answer is topology:

  * **how many pieces a stick is cut into** - cut until no piece twisted more
    than 18 degrees, and twist is measured per frame;
  * **whether a junction is mitred** - "no leg is cut back more than 0.35 of its
    length", also per frame. A mitred junction emits two shared end polygons; an
    abandoned one emits none. The stations were exactly 904 plus the number of
    mitred junctions, which swung 38 to 56 frame to frame.

**Fix.** The twist term is gone (a contact's pitch and the even count for a
two-coloured bond stay - both constant), and a deep cut is CLAMPED at 0.35
rather than abandoning the junction. Topology now follows the bond graph, which
no frame can move: 976 stations, 2,318 faces, 74 mitred junctions, identical on
all 25 frames, and **0 rebuilds on every pass**.

**Cost, measured** (A/B against the twist rule restored, full rotations at three
frames): most angles pixel-identical, worst single angle 132 px of 357,604. The
old rule's own note said it fired on 15 bonds of 791.

**Two memo-based fixes were written first and removed**: pinning K per bond, and
making the run-merge decision sticky. Both only converge - 17 to 18 rebuilds a
pass, three passes, never settling - because a memo that grows is still a
topology change. Do not retry them; make the rule frame-independent instead.

**Test: `tests/stick_topology.py`**, gpu lane. The counts hold over a
trajectory's frames, two passes rebuild nothing, the last step matches a
rebuild of itself, and the number of mitred junctions holds. Mutating the twist
term back fails it (4 shapes, 4 then 1 rebuilds). 🔴 Mutating the junction
abandon back does NOT fail it on any tracked fixture - no junction in them
crosses 0.35 - so that half rests on the session measurement above.

## Problem 1c: nucleic base pairing followed the drawn frame (FIXED)

Found by the survey below, in the same class as 1b. Which base pairs with which
was predicted from the drawn frame's coordinates and cached on `secKey`, which
HOLDS THE COORDINATES - and a base plate is emitted per PAIR, so the prim list
and the station mapping followed the prediction.

**Two places had to change**, and either alone does nothing:

1. `cartoon/geom.js` - the pair cache is keyed on the object, its position count
   and any forced pairing, never the coordinates.
2. `core/mol.js` - the blanket cache clear beside `_cartoonSec` no longer nulls
   `_cartoonPair`. `_materialiseSidechains` calls that clear EVERY FRAME, so
   with side chains showing the pairing was re-predicted per frame however
   strong its key was. The paragraph above that clear already records this
   exact trap for the removed Keep-SSE mode; it is the same one.

Measured on `_traj_1ehz.pdb`, positions and bonds identical on every frame:
42, 42, 42, 36, 40, 40 pairs and 3 of 9 steps rebuilt, now **42 on every frame
and 0 rebuilds**, with side chains shown or hidden.

**What it costs**: an RNA that FOLDS keeps the pairing predicted for the frame
that filled the cache until something changes the object or the position count.
`renderer._cartoonPairKey = null` asks for it again.

## Problem 1d: a ligand refused the whole tail, twice over (FIXED)

Reported as full rebuilds frame to frame with a ligand on screen, on an AF3
fold whose 43-atom ligand is still diffusing. Two separate faults, both in
`refreshSticksFrom`, and the second only reachable once the first was fixed.

**The geometry the tail is built from was unprojected at the wrong scale.** The
tail - ligands, base plates, contacts - has no stations, so it is rebuilt from
THIS frame's prims, and `unproject` divides by the scale that projected them.
It was handed `resident.scale`, the scale of the BUILD, so every tail
coordinate came out multiplied by live/built: identical at the zoom the mesh
was built at and wrong at every other. **11,218 of 498,436 pixels against a
rebuild at zoom 3, 14,111 at 3.5, 51 at zoom 1** - reported as distortion after
zooming in, playing, and zooming out, which is exactly the sequence that steps
frames at a zoom the mesh was not built at. `mesh.capScale` is what the capture
already recorded.

**And with side chains up the mesh is in the other ORDER.** The parts are
ribbon, SIDE CHAINS, other when the side chains are stationed and ribbon,
other, side chains when they are not, so a span index means two different
parts. The guard read span 0 as the whole station-covered prefix and spans 1
and 2 as the sticks to rebuild - true only of the second order - so with both a
ligand and side chains on screen it refused every frame
(*"stations cover 2702 faces and the ribbon part holds 930"*), and after twelve
refusals `stationTries` gave the object up: `setStationDraw(false)`, and the
rest of the trajectory on rebuilds with the decline reading "the station path
is off". **25 of 25 steps, now 2 of 25** - the two left are the junction gates
in `docs/OPEN_WORK.md` 11.

**And the order travels with a CACHED mesh**, or a restore is read with the
last build's: hide the side chains and show them again and the third step
restores the first mesh while the flag says otherwise. Exactly one rebuild,
because the refusal rebuilds and that build sets the flag right.

🔴 **NO TRACKED FIXTURE COULD SEE ANY OF IT**, because `tests/make_traj.py`
wrote `ATOM` for every row of its source: 3PTB's benzamidine came back as nine
protein residues and the tail was EMPTY in every trajectory, `[3554, 0, 0]`.
One column (the source's own `group_PDB`) gives it 10 ligand positions and
1HVR 46. `tests/station_ligand.py` legs 4, 5 and 6 are the gates, each
asserting its own part spans first so it cannot pass by measuring nothing.

## Problem 1e: two junction rules still ask the frame (OPEN, measured)

The mitre's corner pairing and a run station's shared section were both decided
per frame and are now decided by rule (CLAUDE.md has the numbers). What is left
is a four-leg centre's planarity test and the run walk itself - see
`docs/OPEN_WORK.md` 11, which has the measurement and the shape of the fix.

## Problem 3: the fast path draws side-chain STICKS differently from a rebuild (OPEN)

🔴 **EXPOSED BY 1b, NOT CAUSED BY IT.** Until side-chain topology stopped
following the frame, every step with side chains shown rebuilt - so the fast
path's own drawing of those sticks was never reached. Now it is:

| | last step against a rebuild of the same frame |
|---|---|
| `_traj_1ehz.pdb`, side chains shown | **6,612 px of 357,604** |
| the same, side chains hidden | **0** |
| `_traj_3ptb.pdb`, side chains shown | 33 px |

All of it is the sticks: hide them and the two drawings are exactly equal, so
the ribbon and the base plates follow the stations perfectly.
`refreshSticksFrom` is NOT refusing - it rewrites the stick rows and reports no
reason - so the rows are being written and still do not match a build.

`tests/stick_topology.py` asserts the picture with side chains HIDDEN and
reports the number with them shown, so the gap is visible on every run rather
than buried.

**Where to start**: compare the stick part's FACES between a fast step and a
rebuild of the same frame (`__meshDigest`, or the per-part face hashes), not
pixels - that says whether the rows hold the wrong numbers or the right numbers
in the wrong place. `tests/station_sidechains.py` covers the same ground for
proteins and passes, so the difference is worth reading first.

## Problem 2: side-chain faces disappear during playback (NOT REPRODUCED)

**Report, verbatim:** "im seeing lots of faces of the sidechains disappearing
as I play through the animation. Also something we had fixed many many
sessions ago, even on the reloaded sessions." Same fold and same session file
as problem 1.

**The report is about ROTATING, not stepping.** Load the session, go to the
last frame, show side chains, and turn the model: faces appear and disappear.
Rotation rebuilds nothing (measured: 0 builds over a full 360), so this is what
the RESIDENT mesh draws, and a rebuild cannot cure it.

**Known:**
- The rebuild storm that made this hard to see is fixed - see problem 1b.
- **GPU rebuilds match the 2D painter** on all 25 frames to within 800-1,300
  antialiasing pixels, flat, with no frame losing a chunk.
- **Over a full rotation** (24 angles, GPU against the 2D painter) the
  difference is a flat 700-1,800 px with no spikes. Either both painters lose
  the same faces - they share `geom.js`, so that is likely - or the paper test
  used is too blunt. Compare the two painters' FACE LISTS, not their pixels.
- **It is not coarse segmentation.** Rendering each angle at 4 degrees per
  segment against the shipped rule: 16 of 18 angles pixel-identical. The twist
  rule's own comment claims it prevents "faces disappearing on twisted bonds at
  certain angles"; on this structure it was not doing that. (That rule has since
  been removed for problem 1b, with the same measurement behind it.)
- "Even on the reloaded sessions" suggests a fault that a build does not cure,
  unlike problem 1. The suspects are what a BUILD decides from the current
  frame and keeps:
  - the stick level of detail (`STICK_FLAT_PX`, `stickLodFlat`: a stick
    thinner than 2 px becomes one double-sided quad, and that choice is in
    `signatureOf`);
  - the side-chain station spans (`refreshSticksFrom`);
  - per-face culling or winding flags;
  - the 2D painter's culling, if the user was on CPU. f480c1b changed arrow
    culling in `paint2d.js`; side chains should not be affected, but that is
    unverified.
- Reproduce it at the reader's own size: these measurements ran at a 598 px
  canvas and the report is from a full-window viewer.

**First steps:**
1. Rotate one frame and compare the FACE LIST a build emits at each angle -
   `__meshDigest`, or the face counts per part - rather than pixels. A face
   that is present but drawn transparent, culled, or wound backwards is
   invisible to a pixel diff against a painter that does the same thing.
2. Ask whether the faces are missing or merely unlit: read `_stickProbe` for
   the bonds involved and check their normals against the view.
3. Rule the painter in or out: repeat with `r.useGPU = false`.

## Where else the same trap lives

**`docs/DRAW_GRAPH.md` is the plan that comes out of this section**: one graph
per structure, geometry per frame, in the order the steps are worth doing.

The class is: **a graph (what is connected to what, what pairs with what) is
re-derived from the drawn frame, and the mesh's counts follow it.** Surveyed
over the tracked trajectories, 10 frames each, side chains off and on, counting
distinct (stations, pieces, faces) shapes and rebuilt steps:

| fixture | ribbon | with side chains |
|---|---|---|
| `_traj_3ptb.pdb` | 1 shape, 0 rebuilds | 1 shape, 0 rebuilds |
| `_traj_1hvr.pdb` | 1 shape, 0 rebuilds | 1 shape, 0 rebuilds |
| `_traj_unfold.pdb` | 1 shape, 0 rebuilds | 5 shapes, 4 rebuilds |
| `_traj_1ehz.pdb` (RNA) | **3 shapes, 3 rebuilds** | 3 shapes, 3 rebuilds |

🔴 **AND THAT SURVEY WAS RUN ON FIXTURES WITH NO LIGAND IN THEM** - the writer
flattened every HETATM to an ATOM, so what this table calls the ligand case was
a protein. Problem 1d is what lived in that gap. The fixtures carry their
ligands now (3PTB 10 positions, 1HVR 46, 1EHZ's 9 ions), and the table above
has not been re-measured with them: `tests/stick_topology.py` and
`tests/station_ligand.py` assert the same property on every run instead.

- **THE BACKBONE IS ALREADY CLEAN.** A structure that unfolds completely draws
  one shape for all ten frames: the letters move and the stations do not, which
  is what the arrowhead work bought (`dupSeam` and its note in this file). No
  work to do.
- ✅ **NUCLEIC BASE PAIRING WAS THE NEXT ONE, AND IT IS FIXED** - see problem
  1c below. What follows is how it was found.
- 🔴 **NUCLEIC BASE PAIRING, AS MEASURED:** Which
  base pairs with which is predicted from the drawn frame's coordinates and
  cached on `secKey`, so it is re-predicted as a trajectory moves - and a plate
  is emitted per pair. Measured on `_traj_1ehz.pdb` with the positions and
  bonds IDENTICAL on every frame (76 and 75): **42, 42, 42, 36, 40, 40 pairs**,
  with the stations tracking them exactly - 768, 768, 768, 744, 760, 760.
  Frames 4 and 5 agree on the count and disagree on WHICH pairs, so even a
  count check would not have caught it; the mapping moves.
  The fix has the same shape as the stick one: a pair graph belongs to the
  MOLECULE, not to the frame, so predict it once per object and let the
  geometry follow.
- **BONDS BY DISTANCE ARE LATENT.** A structure with no CONECT gets its bonds
  from `bondMaxFor` per frame, so a pair crossing the cutoff changes the graph
  and the mesh with it. It did not fire on `_traj_1hvr.pdb` (0 rebuilds), and
  it is one moving ligand away from firing. Same answer: derive the graph once.
- **AND `_traj_unfold.pdb` WITH SIDE CHAINS IS NOT AN INSTANCE.** Its positions
  really do change between frames (597 -> 587, and the segments with them), so
  those frames are different structures and rebuilding them is right. Check the
  position count before filing a rebuild as a bug.
- 🔴 **AND SOME REBUILDS RECORD NO REASON.** In several arms above
  `stationDecline()` came back **null** on a step that rebuilt, so a survey
  cannot attribute it. Anything that rebuilds without writing that string is a
  hole in the instrument; fix it before the next hunt.
  🔴 **AND HALF OF THOSE NULLS WERE THE INSTRUMENT, NOT THE CODE.**
  `stationDecline` is reset at the top of every render and a step renders more
  than once, so a probe reading it after a settle reads whatever the LAST
  render left - usually nothing, because that one took the early-out. Hook
  `renderer.render` and read the reason immediately after each call. Two
  sessions went looking for a path nobody could account for before this was
  understood.

## The fixture

The user's session, **not tracked**:
`~/Downloads/py2dmol_state_2026-09-18T14-50-48.json` (2.2 MB). It is one
object `af3_1`, 25 frames, 59 positions, side-chain tables in every frame,
Detail 4, `richardson`, pencil 1, pLDDT colour. Frames 1 and 19 are the pair
for problem 1: build at 1, step to 19, zoom 2.5, the saved rotation. It is not
copied into the repo - pass the absolute path, from a worktree too. Both tests
above carry their own fixtures instead: `weld_open.py` holds those two frames
inline, `stick_topology.py` uses `_traj_3ptb.pdb`, which `tests/make_traj.py`
builds.

Problem 1d came from a second, also untracked session -
`~/Downloads/py2dmol_state_2026-09-19T13-44-16.json`, two objects, `af3_2`
being 59 protein positions and a 43-atom ligand over 25 frames. Its numbers
are quoted above; what is tracked is `tests/station_ligand.py`, which asks the
same questions of `_traj_3ptb.pdb` now that the fixture has a ligand in it.

## Instruments

| what | how |
|---|---|
| fast vs fresh, every build frame | `python3 tools/fastpath_replay.py SESSION [--base=all\|N] [--zoom=2.5] [--sidechains] [--detail=N] [--pencil=0] [--port=N]` - reports `darker` (an extra stroke) and `missing` (a lost face or line) per step, skips and counts steps that rebuilt with their decline reason, saves the worst pair of PNGs |
| the regression | `python3 tests/weld_open.py` |
| forced-letter merge, rows only | `python3 tests/sheet_merge.py [--detail=N]` - blind to problem 1, see traps |
| why a step rebuilt | `py2dmolCartoonGPU.stationDecline()`, and `window.__faceBuilds` counts builds |
| force a build | `py2dmolCartoonGPU.invalidate()` then `render()` |
| the outline rows the card holds | `py2dmolCartoonGPU.stationTexels()`: `inkBuf` (`edgeFloats` per row: p0, p1, n0, n1, `aAlways` at 12, `aEdgeStick` at 13 where bit 2 is outer) and `edSrc` (7 per row: corner offset A, B, face of normal 0, face of normal 1, nCount, crease cos, byLetter) |
| read pixels | `probe_js.HELPERS` turns direct presentation off (`setDirectPresent(false)`), so `canvas.getContext('2d').getImageData` holds the picture |

**Row bisection** found problem 1's row and is the general method for "which
outline row is wrong". Add a temporary hook at the end of
`refreshEdgesFromStations`, just before `if (!touched)`:

```js
if (window.__killRows) for (const kr of window.__killRows) ed[kr * ED_FLOATS + 12] = -1;
```

Then, in one page: take a fresh reference, and for a candidate set S rebuild
at the base frame, step with `__killRows = S`, and count the darker pixels.
Halve S towards whichever half removes them. About 12 rounds for 7,000 rows.
Remove the hook afterwards.

## Traps that cost this investigation time

- **Rebuilding between steps hides the fault.** A replay that invalidates after
  every comparison keeps the mesh one frame old. Take all the fast frames first
  from ONE build, and only then build each frame fresh.
- **The BASE frame decides whether the fault shows at all.** Built at 0, this
  fold showed nothing; built at 1, every later frame drew the line. Use
  `--base=all`.
- **A forced letter string is not a real trajectory.** `_forceSec` breaking a
  strand in the middle of a straight run (the `sheet_merge` fixture) never
  collapses a station, so it passes on problem 1. Real frames change geometry
  and letters together.
- **Count by direction.** An extra stroke only darkens; noise goes both ways.
  All-differences put the bug at 92 against 62 for the fix; darker-only gives
  153 against 27.
- **Turn the pencil off** (`r.cartoonPencil = 0`) and compare within one page
  load: the grain reseeds per load and the GPU is not pixel-stable across
  loads.
- **Zoom in.** At 1x the line is a few dozen pixels in a 598 px canvas.
- **`dev.html` is the working tree.** `index.html` and LocalFold load built
  bundles, so run `python3 tools/bundle.py build` before measuring a change
  there.
- **Parallel probes collide.** Each probe binds fixed ports and a fixed
  `/tmp` profile. Agents running side by side need distinct `--port` values,
  and must not share a machine with `tests/run.sh` (see "a suite run sharing
  the machine" in `CLAUDE.md`). Kill `Google Chrome --headless` before a run
  whose result matters.
- **Mutate to prove a test.** Every assertion is checked by removing the fix
  and watching it fail. `weld_open` was first written with a margin (92 vs 62)
  that was not a test.

## Splitting it across agents

These are independent and can run in separate worktrees, each with its own
ports:

1. **Verify problem 1:** run the neighbouring probes and the suite, and settle
   whether the residual 20-60 px is noise or a second row class (bisect it).
2. **Why side chains rebuild with no reason:** trace the 22 null-decline
   rebuilds to the code that declines without writing `stationDecline`, and
   say whether the side-chain part can take the fast path.
3. **Reproduce problem 2:** find the settings under which side-chain faces
   vanish (GPU/CPU, zoom across the flat-stick threshold, all side chains vs
   focus), reduce them to a fixture, and write the failing test before any fix.
4. **Close the class:** enumerate the build-time decisions that depend on
   frame geometry and survive in the resident mesh (welds, lone edges, flat
   sticks, crease flags, per-face flags), and for each say whether the
   per-frame pass re-asks it. Problem 1 was one of these; problem 2 is likely
   another.

What each should hand back: the numbers, the images, a mutation-verified test,
and whether the fix keeps the step off a rebuild.


## Dead end: the station shader's flat normal from the quad's own diagonals

`buildFromStations` gives a stick face its culling normal from the SECTION
FRAME - `tvA`, `ubA`, `waA` and their negatives - which is analytic and exact
for a box side, while `buildMeshPart` derives the same face's normal from the
corners. Deriving it in the shader too (`cross(aC3 - aC1, aC2 - aC0)`, falling
back to the frame vector where the quad is degenerate) is the obvious way to
make the two paths agree on what faces the eye, and problem 3 above is a
disagreement between those two paths.

**It measures as nothing.** Fast frame against a rebuild of itself, with side
chains shown, on the last frame of four tracked trajectories and again through
ten turns of the structure:

| | with the quad normal | with the frame vector |
|---|---|---|
| `_traj_3ptb.pdb`, turning | 43 / 31 px | 45 / 32 px |
| `_traj_1ehz.pdb`, turning | 10,022 / 10,007 px | 10,021 / 10,013 px |
| four fixtures, fixed camera | 43 / 6,395 / 4,501 / 9 | 43 / 6,400 / 4,497 / 9 |

So it is neither the cause of problem 3 nor a fix for it, and it is not in the
tree. Note that it would not make the two paths agree anyway: the CPU normal is
Newell over all four corners and this is the diagonals' cross product, which
part company on exactly the non-planar faces that would make the question
interesting.
