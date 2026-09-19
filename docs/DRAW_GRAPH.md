# One graph per structure, and geometry per frame

A plan and its results. Steps 1 and 2 are DONE, steps 3 and 4 were measured and
turned out not to be faults, and step 5 is optional (see each). It says what to
build, in what order, what each step must measure before it counts as done, and
which roads are already known to be dead.

🔴 **The one fault still open is problem 3 in `docs/FASTPATH_ARTIFACTS.md`** -
the fast path draws side-chain STICKS differently from a rebuild - and nothing
in this plan fixes it.

## The rule this is all one instance of

**Anything that decides how many faces, stations or pieces the mesh has belongs
to the STRUCTURE. Anything that decides where they are belongs to the FRAME.**

The station fast path holds a mesh across a trajectory step and rewrites only
station geometry. It can only do that while the counts and the face-to-station
mapping hold. So every rule that answers a counting question from the drawn
frame's coordinates costs a rebuild the moment the molecule moves - and worse,
the rebuild hides whatever the fast path would have got wrong, so faults queue
up behind it invisibly (that is how problem 3 stayed hidden; see below).

Measured this session, 25-frame AlphaFold 3 fold, all side chains shown:

| | before | after the two rules landed |
|---|---|---|
| steps that rebuilt | 20 of 24 | **0** |
| distinct (stations, pieces, faces) | 17 over 25 frames | **1** |

and over the tracked trajectories (`_traj_3ptb`, `_traj_1hvr`, `_traj_1ehz`,
`_traj_1bna`), both arms: **1 shape, 0 rebuilds**.

## Where the answers live today

| derivation | keyed on | frame-independent? |
|---|---|---|
| nucleic base pairing (`_cartoonPair`) | `_topologyKey()` + forced pairs | yes - landed |
| stick segment count `K` | nothing; recomputed per frame | yes, by rule - landed |
| junction mitring (`cutOk`) | nothing; recomputed per frame | yes, by rule - landed |
| which corner a mitred leg welds to its neighbour | nothing; was a nearest-of-four search | yes, by rule (the junction's handedness) - landed |
| a run station's shared section | nothing; was three geometric exits | yes, by rule (always emitted, narrowed where it would overreach) - landed |
| a four-leg centre: mitre or collar (`tilt > 0.50`) | nothing; recomputed per frame | **no** - open, `docs/OPEN_WORK.md` 11 |
| which bonds form one run (`throughPair`) | nothing; recomputed per frame | **no** - open, same entry |
| bond graph from distance (`bondMaxFor`) | the object, via `segmentCacheHolds` | yes - measured, step 4 |
| run merging (`mergeBondRuns`, `sameStyle`) | per frame, on COLOUR | in principle no; measured as not moving counts, step 3 |
| SS letters (`_cartoonSec`), ladders, sheet frames | `secKey`, which holds the coordinates | **deliberately not** |
| flat-stick LOD (`stickLodFlat`) | the zoom, and it is in `signatureOf` | no, and correctly so |

`parts/multi.js: _topologyKey()` already exists and already names the right
things - drawn objects, merged/overlay, materialised side-chain count, array
length, and **not the frame**. `cartoon/paintgl.js: signatureOf` already uses
it. What is missing is that the per-structure derivations do not hang off it.

## What to build

`renderer._drawGraph`, one object per drawn structure:

```
{
  key,          // _topologyKey() + the forced-pairing signature
  bonds,        // which positions are bonded, and each bond's kind
  deg, inc,     // the adjacency the junction and run code already builds
  pairOf,       // nucleic base pairing (moves out of _cartoonPair)
  seg,          // per bond: how many pieces it is cut into
  junction,     // per atom: mitred or not, and the path through a 3-way atom
  runs,         // which bonds form one swept run
}
```

Built once when the key misses; read by `drawSticks`, `mergeBondRuns` and the
nucleic plate pass; **never** consulted for where anything is - that stays a
per-frame computation from the coordinates.

Three things fall out of having one of them:

1. **One place to clear.** The trap that ate the pairing fix was
   `_materialiseSidechains` calling a blanket cache clear EVERY frame (it
   reissues side-chain indices, so it cannot be skipped). A graph keyed on
   `_topologyKey()` is dropped when the key changes and never by a frame. The
   note above that clear in `core/mol.js` already records this for the removed
   Keep-SSE mode; pairing was its other victim and was still being cleared.
2. **One invariant to assert.** If the graph key has not changed, the station
   mapping MUST match. Today a mismatch is a decline nobody reads - and some
   rebuilds record no reason at all (`stationDecline()` came back null in
   several survey arms). With the invariant, that becomes a loud failure.
3. **One test.** The counts hold across frames, for every tracked trajectory,
   both arms - one probe instead of a check per feature.

## Steps, in order, each with what it must measure

### 1. Point the pairing at `_topologyKey()`, and audit the blanket clear — DONE

Replace the ad-hoc key (object + position count + forced signature) with
`_topologyKey()` + forced signature. Then read every field that clear nulls and
ask of each: is this frame-independent? `_cartoonSec`, `_cartoonLadder`,
`_cartoonSheet` and `_ssColorSec` follow the fold and must keep being cleared;
anything else must not be there.

**Done.** `_cartoonPairKey` is `_topologyKey()` plus the forced-pairing
signature (a stub renderer, which the node harnesses hand `geom.js`, falls back
to the object name and position count). The audit's answer: the four fields the
clear still nulls - `_cartoonSec`, `_cartoonLadder`, `_cartoonSheet`,
`_ssColorSec` - are ALL keyed on `secKey`, which holds the coordinates, so they
follow the fold by design and for them the clear is load-bearing against a live
`replace()` under an unchanged object|frame|n. Pairing was the only
frame-independent one in the block. Mutating the clear to take `_cartoonPair`
again fails the guard below: 3 shapes, 4 pairings, 3 then 2 rebuilds.

### 2. The generalised guard — DONE

Extend `tests/stick_topology.py` (or a sibling) to walk every tracked
trajectory, both arms, asserting one shape and zero rebuilds. It replaces
per-feature checks and guards anything added later.

**Done.** `tests/stick_topology.py` walks four tracked trajectories - a protein
with a ligand and disulfides, an RNA, a DNA duplex, a ligand-heavy protein -
with side chains hidden and shown, in **16 seconds**. All four: one shape, zero
rebuilds on both passes. Mutating the twist rule back fails it on `_traj_3ptb`
(4 shapes) AND `_traj_1hvr` (2 shapes); mutating the pairing clear back fails it
on `_traj_1ehz`. 🔴 The junction rule is still NOT observable on any tracked
fixture - no junction in them crosses 0.35 - and the docstring says so.
`showSidechains` is tolerated when it throws, because a C-alpha trace has none
and its topology is still worth asking about.

### 3. Take colour out of run merging — MEASURED, NOT AN INSTANCE

`sameStyle` compares `p.c.r/g/b`, so in principle a run splits differently as a
pLDDT colour changes. **Measured, and it does not.** Two models of 3PTB with
IDENTICAL coordinates and different B-factors, drawn in `plddt` with side chains
shown: the drawn colours differ (two distinct signatures over 1,003 segments,
which is the control - without it "no change" would just mean the mode never
took) and the topology is the same shape on both frames, 0 rebuilds.

Why: a run is a chain of degree-2 atoms, which inside one residue share a
residue colour, so a colour boundary rarely lands INSIDE a run. Do not spend a
refactor on this without first producing a fixture where it moves. The generator
for the one above is four lines - take a frame, rewrite column 61-66.

### 4. Derive the bond graph once — ALREADY TRUE

**Already frame-independent, measured.** A two-model fixture whose ligand S-S
pair is 1.90 A apart in one frame and 9.00 A apart in the other draws the SAME
bond list on both - identical signature over the segments, 8 either way - so the
graph is derived once and reused. `canUseCache` / `segmentCacheHolds` in
`core/mol.js` is that cache, and it holds ACROSS frames.

🔴 **The consequence is the design's, and it is worth knowing**: a bond that
breaks during a trajectory keeps its stick until something re-derives the
segments. That is the same trade every entry here makes - the graph belongs to
the molecule - but nobody had written it down, and a reader watching a ligand
dissociate will notice it.

### 5. Hoist `K`, junctions and runs into the table — OPTIONAL NOW

🔴 **Steps 3 and 4 turned out not to be faults, so this step is no longer
holding anything up.** The rules are frame-independent and the guard proves it
on four fixtures; what is left here is structure and cost - recomputing per
frame what cannot change - not correctness. Weigh it against problem 3 below,
which IS a fault and has a measurement waiting.

The big one, and only worth doing after 1-4. The rules are already
frame-independent, so this is mostly mechanical, and it also stops recomputing
per frame what cannot change - `drawSticks` and `mergeBondRuns` are 1,473 and
1,084 lines, both already over this project's function-length rule, so the cut
should make them smaller rather than larger.

**Done when**: the picture is unchanged (`paint_trace` 11 fixtures byte
identical, `__meshDigest` identical across four structures x three cameras),
the counts still hold, and a rebuild is measurably cheaper - report the capture
and mesh halves separately, since `total - mesh` carries both halves' noise.

## What must NOT move into the graph

- **SS letters.** They follow the fold, and the arrowhead work already made the
  stations independent of them (`dupSeam`). A structure that unfolds completely
  draws one shape over ten frames today; pinning letters would be a promise the
  caller cannot verify, which is why Keep SSE was removed.
- **Colours.** Per frame by design (pLDDT is per frame). Step 3 removes colour
  from a TOPOLOGY decision; it does not pin the colour.
- **Anything camera-dependent.** The flat-stick LOD follows the zoom and is in
  `signatureOf`, where a crossing costs exactly one rebuild.

## Dead roads - do not re-measure these

- 🔴 **A memo that GROWS is not a fix.** Pinning `K` per bond at what the first
  frame asked for, and making the run-merge decision sticky, were both written
  and measured: **17-18 rebuilds a pass, three passes, never settling**. A
  quantity that converges is still moving, and every move is a rebuild.
- 🔴 **Declining the step is not a fix** for a per-frame decision: it is a
  rebuild by another name. Measured for the weld bug at 3 rebuilds over 24
  steps before it was replaced.
- 🔴 **The twist rule was not buying what it claimed.** Its comment says it
  prevents "faces disappearing on twisted bonds at certain angles"; A/B against
  it restored, full rotations at three frames, leaves most angles pixel
  identical and the worst single angle 132 px of 357,604. Removing it is what
  made `K` frame-independent.
- **`na_axis.js` fails with "no pairs scored" on an untouched tree.** Not in
  `run.sh`; a rotted bench, like `na_frame.js` once was. Not caused by this
  work, and not evidence about it.

## The fault this will not fix, and must not hide

🔴 **Problem 3 (`docs/FASTPATH_ARTIFACTS.md`): with side chains shown, a fast
step draws them differently from a rebuild** - 6,612 px of 357,604 on
`_traj_1ehz.pdb`, 33 px on `_traj_3ptb.pdb`, and EXACTLY 0 with side chains
hidden. `refreshSticksFrom` is not refusing; it rewrites the rows and they
still do not match.

It was unreachable until side chains stopped forcing a rebuild on every step,
so it is not a regression - it is a fault this work uncovered, and it is the
closest thing measured so far to the reported "side-chain faces appearing and
disappearing". Fix it FIRST if the reported bug is the priority; the plan above
is about cost and about not hiding faults, not about that picture.
