# Cartoon rendering performance — measured findings


## The two rebuilds on first load

Noticed from the dev rebuild light: loading one object flashes `R x2`. Both are
real and the first one is wasted. `window.__buildLog` keeps the signature of
each build, and diffing the two names it in one line:

    term 12:  '100' -> '706'      the canvas width
    term 13:  '600' -> '706'      the canvas height
    term 17:  'true' -> 'false'   stickLodFlat, which is a function of the size

Nothing else in 31 terms moves - same structure, same colours, same topology.
The mesh is built at one canvas size and immediately rebuilt at another.

**And src/parts/viewport.js already says why**: "a container inside a
`display: none` parent measures 0, which is the state index.html starts in. The
observer corrects it the moment the viewer is shown." So the first build happens
at the fallback size from `config.display.size` while the container cannot be
measured, and the ResizeObserver then delivers the real size and forces a
rebuild. The first mesh is never seen.

🔴 **AND THE MESH IS NOT SIZE-INDEPENDENT, WHICH KILLS THE ELEGANT VERSION OF
THE FIX.** The tempting repair is to stop treating canvas size as geometry: the
mesh is model space, `drawResident` already carries the scale as a view
parameter, and `viewScaleMul` is literally `spanFit(live) / spanFit(captured)`
with `spanFit` a function of this width and height. That reasoning is wrong, and
the picture says so. Two changes were made and both reverted:

- taking `w, h` out of `signatureOf`. On its own this changed nothing
  measurable: a resize still rebuilt, because
- `const fresh = !gl || appCv.width !== w || appCv.height !== h; if (fresh)
  appSig = null;` throws the signature away on ANY canvas size change, so a
  resize rebuilds with the key identical either side of it. Narrowing that to
  "the context is new", which is what the comment beside it already claims
  ("A RESIZE DOES NOT DROP THE CONTEXT"), does make a resize cost 0 rebuilds.

And then the frame is **10.42% of pixels wrong** against one rebuilt at the new
size, worst channel 223, ink 8.33% -> 9.82% - the structure drawn too large.
`viewScaleMul` does not fully correct a resize, so a rebuild on resize is
CORRECT and the two lines above are load-bearing. Reverted.

What is left of the original question: the second build on load is forced by
`stickLodFlat`, which is a genuine size-dependent geometry term (flat sticks
against round), flipping between the fallback size and the real one. It is the
bogus first size that is the fault, not the term.

🔴 **AND IT IS NOT ALWAYS TWO.** Measured repeatedly, the same page load costs 0
extra builds or 2 depending on whether the ResizeObserver fires before or after
the first render. Anything measuring this has to run it several times.

**FIXED, and the shape of it is: decline the BUILD, not the frame.**
`parts/viewport.js` is the only thing that knows whether the box was measured or
guessed, so it says so on the canvas element - `__viewportProvisional` - and
`renderApp` returns false while it is set. Returning false is the answer that
path already gives whenever it cannot help, so the 2D renderer draws instead and
a hidden container still produces pixels: tests/render_page.py, tests/embed.py
and tests/colab.py all pass. What is skipped is facesOf, buildMeshPart and the
uploads - the expensive half, and the half that was being thrown away.

    1UBQ, page load        before   after
      mesh builds            2        1

🔴 **AND THREE THINGS ABOUT IT WERE WRONG BEFORE THEY WERE RIGHT**, each caught
by measuring rather than reasoning:

- **The flag on the renderer.** `attach(renderer)` runs after the renderer has
  already drawn once, which is the frame this exists to stop. It goes on the
  CANVAS, which both sides hold and which paintgl already has through its 2D
  context.
- **Clearing it in the observer.** The ResizeObserver fires while the viewer is
  still hidden - contentRect 0, clamped to 1 - so clearing on any callback put
  the flag down before the real size arrived, and the fix changed nothing at
  all. `boxIsReal` is now the single definition, used for the initial size, the
  flag and the observer.
- **"The layout has settled by the time ui.js finishes."** It has not. The
  container measures 0 for the whole life of the page until a structure is
  loaded, because index.html keeps the viewer inside a `display: none` parent
  until then. Measured at script, DOMContentLoaded, load, two animation frames
  and 600 ms: 0 every time.

The `settle()` refactor that came out of the second attempt is kept: measuring
and applying a size was written out twice, once at setup and once in the
observer, and the observer's copy is now the only one. `ui.js` calls it after
the panels are mounted, which is free and correct even though it is not what
fixed this.

## Every style-panel control, and which of them rebuild

Measured with the rebuild counter on 1UBQ, each control driven through its own
handler (there is no applyX() - the events are the mechanism):

**Free - a uniform or a texture upload, no mesh touched:**
colour scheme, ortho, shade, shadow, highlight, outline width, outline tint,
pencil, base plates, elements, selection mark, SSE palette, contact width, and
the style switch itself. Fourteen of eighteen.

**Rebuild — but two of them only because they were asked the wrong question:**

Thickness and flatness move coordinates and the two per-station scalars and
nothing else. Measured on 1UBQ: **201 ribbon prims, 454 stations, 1019 mesh
faces** at sheetFlat 0, 0.5 and 1, and the same three numbers at thickness 0,
0.5 and 1.5. A station already carries halfW and halfT in slots 3 and 7, so this
is exactly the update the station table exists to make - the same one every
trajectory step makes. They were in the TOPOLOGICAL key, which is what the
station path compares, so it refused and the frame rebuilt.

Out of that key, on `_traj_1tim.pdb` with Keep SSE on:

| | rebuilds | fast path | against a rebuild |
|---|--:|--:|---|
| sheetFlat 1 -> 0 | **0** | 1 | 0.0022% of pixels |
| sheetFlat 0 -> 0.5 | **0** | 1 | 0.0002% |
| thickness 0.7 -> 1.4 | **0** | 1 | exact |
| thickness 1.4 -> 0.2 | 1 | 0 | exact - it crossed the stick LOD |

🔴 **THICKNESS STILL REBUILDS ACROSS ZERO, AND SHOULD.** `stickLodFlat` flips
there - flat sticks against round - and that is different geometry, not a
scalar. It is the only thickness change that rebuilds.

~~🔴 **AND THIS ONLY HELPS WHILE KEEP SSE IS ON.**~~ It did when this was
written. Touching either slider now asks for the station table on its own
(`wantStationTable` in parts/ui.js), so a single structure gets it too - the
first change builds the table and every one after is a station update. The
table costs 3-5% on a mesh build (15.2 ms against 16.0 at 494 residues, 79.1
against 81.4 at 2,500), which is why it is earned by the gesture rather than
paid by everyone.

**Rebuild, and these have to:**

| control | signature term | why |
|---|---|---|
| detail | `cartoonDetail` | the subdivision count - 325 stations at detail 2, 454 at 4, 809 at 8, and no table survives that |
| arrows | `cartoonArrows` | 196 pieces against 186 on 1UBQ |
| base plates | `cartoonBasePlates` | 234 pieces against 150 on 1EHZ |
| richardson | `cartoonRichardson` | see below - it is the interesting one |

~~| line width | `r.lineWidth` |~~ **NOT ANY MORE, AND THE OLD REASON WAS
RIGHT.** `widthScale = lineWidth / 3` really is the ribbon's own half-width and
not just the sticks' - which is why it was in the key - but a half-width is
slot 3 of a station. It leaves the piece, station and face counts alone at
every value (196/449/1019 on 1UBQ at 1.5, 3, 4.5 and 6) and the station path
reproduces a 6.4779% change with a 0.0002% error. `naSmooth` went the same way:
0.0000% error on a 9.1356% effect.

🔴 **RICHARDSON LOOKS EXACTLY LIKE THOSE TWO AND IS NOT.** It leaves the counts
alone on both a protein and a nucleic chain, so counting alone nominates it.
Taken out of the key it drew 1.4975% of the frame differently at a worst
channel of 171 against an 8.7303% effect - 17% of its own change wrong -
because it moves the shading knee, a helix's pale inner face and the arrow
tips, and those are baked per FACE. **Equal counts are necessary and not
sufficient**, and that is the whole reason there are two files rather than one:

- `tests/topology_survey.py` asks whether the counts move, and knows when a
  control is INERT on the structure in front of it (base plates do nothing to a
  protein, sheet flat nothing to a nucleic chain).
- `tests/station_controls.py` asks whether the station path draws what a
  rebuild draws, judging the error against the CONTROL'S OWN EFFECT rather than
  a fixed pixel threshold - no fixed number can tell a stale ribbon from one
  antialiased edge pixel, and picking one that lets the current answer through
  is how a gate stops being a gate.

Both are re-runnable, which the prose above this line was not: it listed
thickness and sheet flat as controls that "have to" rebuild for two commits
after they had stopped having to.

### The SSE controls, and why entering ss colour mode still rebuilds

There are three things called SSE and they cost different amounts:

| | rebuilds | |
|---|--:|---|
| the ss PALETTE (`ss:pymol` -> `ss:default`) | **0** | since the palette carries the resolved colour |
| the ASSIGNMENT method (`selSsSelect`) | **0** | when it does not change the assignment |
| a per-residue SSE override | **1** | a residue changing from coil to helix IS a different ribbon |
| entering / leaving ss colour mode | **1** | and this one was tried |

**FIXED, on the second attempt.** `resolveSegmentColors` answers "what colour is
this segment" from the SS assignment (`secForColor`, already cached), the
palette, and each segment's two residues (`segmentIndices[k].idx1/idx2`) - none
of which is geometry. The draw pass READS it instead of computing its own, so
there is one answer with two callers, and the repaint path can call it with no
build. `colorMode === 'ss'` leaves the mesh signature.

| | before | after |
|---|--:|--:|
| entering ss | 1 rebuild | **0** |
| leaving ss | 1 | **0** |
| ss palette change | 0 | 0 |
| a per-residue override | 1 | 1 - it really does cut |

Every one verified against a mesh rebuilt for that exact state: 0 pixels
different, in both directions and with an override in play.

🔴 **AND THE FIRST ATTEMPT WAS WRONG IN A WAY WORTH KEEPING WRITTEN DOWN.**
The argument looked solid. `colorMode === 'ss'` sits in the mesh signature to
catch colour-driven CUTS - where an interval's two ends disagree it is cut at
the midpoint - and ss resolves ONE colour per interval, both ends taking
`ssPal[ssCls]`, so `col === colFar`, `twoTone` is false and ss adds no cut
anywhere. The prim counts agree: 201 in chain, 201 in rainbow, 201 in ss.

Dropping the term alone made it free and drew the wrong picture: **0.67% of
pixels entering ss and 7.84% coming back**. The cause was not the cut set and
not the faces - it was that the ss colours were computed INSIDE the draw pass,
so a repaint had nothing to upload and fell back to the chain colours. Which is
to say the term was guarding a data dependency, not a geometric one, and the fix
was to remove the dependency rather than the term.

🔴 **AND THEN A STALE SECOND SOURCE OF THE SAME ANSWER.** With ss resolved
up front, LEAVING ss was still 7.84% wrong: the palette source fell back to
`renderer._cartoonPalette`, which the draw pass writes and which still held the
ss colours. Resolving overrides in the same function - so that field is never
consulted on the repaint path - is what finished it. Two places holding one
answer is the fault this whole exercise keeps rediscovering.

🔴 **AND ALWAYS CUTTING IS NOT THE ANSWER EITHER.** Making the geometry
independent of the colouring by cutting every interval at its midpoint costs
**251 prims against 207** on 1UBQ - 21% more pieces, and the faces and outline
edges that go with them, on every structure forever, to save one rebuild on one
control.

🔴 **BUT A DRAG IS ONE REBUILD PER INPUT EVENT, AND THAT IS AVOIDABLE.** A slider
fires `input` on every step, and each one rebuilds:

| dragging | input events | rebuilds |
|---|--:|--:|
| thickness | 12 | **12** |
| line width | 12 | **12** |
| detail | 12 | 7 (it quantises, so some steps repeat a value) |

On 1UBQ that is a few hundred milliseconds of wasted work per drag; on a
structure this path exists for it is seconds, and the slider does not move until
they are over. Nothing coalesces: N state changes in a frame are N synchronous
renders.

**Fixed**: `renderer.renderSoon(reason)` coalesces to one render per animation
frame, and the four geometry sliders use it.

| dragging | input events | before | after |
|---|--:|--:|--:|
| thickness | 12 | 12 | **1** |
| line width | 12 | 12 | **1** |
| detail | 12 | 7 | **1** |

The last event always lands - a frame is scheduled whenever none is pending and
the callback reads the most recent value - and the probe checks it: after each
drag the slider's value and the renderer's agree exactly (detail 8, thickness
1.5, width 4.7).

🔴 **AND `render()` ITSELF STAYS SYNCHRONOUS.** Making the common path async is
the tempting version and it would be much worse: dozens of probes call
`render()` and read pixels on the next line, and they are right to. `renderSoon`
is opt-in, used only by handlers that fire in bursts.

🔴 **AND THE MEASUREMENT ORDER MATTERS AGAIN.** `styleSelect` has to run LAST.
Set to `tube` first and the cartoon path stops running, so every control after
it reports 0 rebuilds - which this probe did, twice, before the style each row
ran under was recorded beside the count.

## Why some colour switches rebuild and most do not

Colour lives in a palette texture - three texels a segment, base and two halves
- so a colour change should be an upload against a mesh that never moves. On
1UBQ, measured with the rebuild counter (`tests/colour_repaint.py`):

| switching to | rebuilds | palette complete | signature |
|---|--:|---|---|
| chain, rainbow, plddt, hydrophobicity, deepmind | **0** | yes | unchanged |
| `ss` | 1 | **no** | `22: false -> true` |
| `ss` again, already in it | **1** | no | **unchanged** |
| leaving `ss` | 1 | yes | `22: true -> false` |
| a per-residue override | 1 | **no** | `23: false -> true` |
| any switch while overridden | **1** | no | **unchanged** |

**The ordinary modes are free.** Five of them, and back again, without touching
the mesh.

**Two things break it, and both are one fact:** the colour did not come from the
palette, so `appPalComplete` is false - and renderApp's colour branch says what
follows plainly, `the only way to change them is to ask the renderer for the
prims again`.

- **`ss` mode.** `colorMode === 'ss'` is a term in the mesh signature, because an
  SS colour boundary is a CUT in the ribbon and not just a different texel. So
  entering costs a rebuild and leaving costs another. The row that matters is
  the third: switching to `ss` while ALREADY in `ss` rebuilds with the signature
  unmoved, which is the palette being incomplete rather than the geometry
  differing.
- **A per-residue or per-chain override.** geom.js sets `ciPalette` false when
  `hasColorOverrides`, so every ribbon face is baked. Setting one rebuilds, and
  then **every colour switch rebuilds for as long as it is in place** - which is
  the one worth knowing, because nothing on screen says the viewer is in that
  state.

🔴 **AND THE ORDER OF A MEASUREMENT LIKE THIS IS LOAD-BEARING.** Leaving `ss`
rebuilds as well as entering it, so whichever mode is listed after `ss` collects
that rebuild and looks guilty. The first run of this had plddt after ss and
reported **plddt as a rebuilding mode**. It is not: 0 before and 0 after. Two
other wrong answers came first - that `colors.halves` was the trigger (it is 75
under every mode, constant) and that the built-in modes were all free (they
looked free because the probe set `colorMode` without `colorsNeedUpdate`, so
nothing happened at all). `window.__lastSig` is in the page for this: it names
which signature term moved instead of leaving a reader to diff two long strings.


## Connectivity from geometry, on coordinates that are not a molecule yet

A sampler trajectory is the case every distance-based rule in this viewer is
worst at, and `tests/make_traj.py` now builds both tracks of one. A step carries
two coordinate sets - the noisy x_t and the model's estimate of the clean
structure, x0 - and they fail in OPPOSITE directions:

    python3 tests/make_traj.py 3CHY.cif --diffusion --models=16
    python3 tests/make_traj.py 3CHY.cif --collapsed --models=16

🔴 **x_t SHATTERS.** Karras schedule, sigma 40 A down to 0.05. At step 0 all 127
consecutive CA-CA distances are over the 5.0 A chainbreak, so every one is cut:

| step | segments | ribbon prims |
|---|--:|--:|
| 0-3 | 128 | **0** |
| 8 | 101 | 73 |
| 9 | **91** | 136 |
| 11 | 111 | 234 |
| 15 | 127 | 382 |

Ten distinct segment counts in sixteen steps, and not even monotonic - 91, then
95, then 111. The first four steps draw no cartoon at all, just 128 loose atoms.
Every step changes the topology, so every cache is discarded and every frame is
a full rebuild. Keep SSE cannot help: it pins from frame 0, and here frame 0 is
the worst frame there will ever be.

🔴 **x0 COLLAPSES, and the backbone survives it.** The chainbreak test is between
CONSECUTIVE positions only, already gated on chain and source, so a tight blob
does not over-bond it: the segment count is 127 at every step. What moves is the
ribbon - 268 prims down to 87 - and that is legitimate, because a blob really
has no secondary structure and the fold really is appearing.

🔴 **BUT THE ALL-PAIRS RULES DO OVER-BOND, AND IT DOES NOT TAKE A SAMPLER.**
Measured on `_traj_3ptb.pdb` - trypsin, six disulfides, an ORDINARY breathing
trajectory at 0.45 A - with side chains shown:

| step | segments | disulfides | ribbon prims | stick prims |
|---|--:|--:|--:|--:|
| 2 | 1002 | 4 | 546 | 6216 |
| 3 | 1002 | 4 | 541 | 6210 |
| 4 | 1004 | **6** | 545 | 6222 |
| 5 | 1003 | **5** | 542 | 6240 |

The disulfide test is a raw 2.5 A distance over every pair of SG atoms with no
hysteresis. A real S-S is 2.05 A, and a 0.45 A breath is enough to carry it
past 2.5 - so the count takes **four distinct values in six frames**, losing
real bonds and finding them again, and the segment list, the ribbon and the
sticks all move with it.

### Step one: the file's own disulfides, and why they never arrived

`_struct_conn` carries `disulf` rows and core/mol.js's comment says they are
useless because "they name atoms - chain:seq:SG - and a protein's positions are
one per residue, so the lookup finds no SG". **That comment is correct and
complete**, and the fix is one line: look the same residue up by CA, which is
the position a protein residue always has.

🔴 **I FIRST DIAGNOSED THIS AS A LABEL/AUTH MISMATCH AND THAT WAS WRONG.** 3PTB's
first disulfide is label_seq_id 7 and auth_seq_id 22, and `getCol` prefers
label, so it looked like the lookup was using the wrong numbering. It is not:
`atomIdToIndex` is keyed the same way getCol reads, and on 3PTB its CA keys run
`A:1:CA` to `A:223:CA` - label - while auth runs 22 to 245. Resolving against
auth therefore finds a DIFFERENT RESIDUE rather than none, because `A:22:CA`
exists and is simply not the one the record meant. Five of six "resolved" that
way and every one was wrong; the sixth failed only because auth 232 is past the
end of the label numbering, which is the one that made the mistake visible.

Shipped for one commit, and it was worse than doing nothing: those five pairs
landed on non-cysteines, no SG was found under them, and **every disulfide
disappeared from the drawing**. tests/disulfides.py now asserts the pairs land
on two CYS residues, which is the check that catches a lookup resolving to the
wrong place while still returning a number.

Fixed in src/io/parse.js: `disulf` rows are resolved to a pair of RESIDUES
through CA, with the same ids the atom lookup beside them uses. **6 disulf rows
in, 6 residue pairs out, all CYS-CYS**, and the drawing takes all six from the
file rather than from a distance.

It is ALL OF THEM OR NONE: `_materialiseSidechains` uses a declared set whole -
supplementing it from the geometry would put the flicker straight back - so a
set missing one entry is worse than no set at all, and any row that fails to
resolve suppresses the whole declaration and leaves the distance rule in place.

The path is live end to end: file -> parse -> `object.disulfideResidues` ->
`_materialiseSidechains` -> six bonds drawn. I spent three rounds hunting a
"missing seam" that was not missing - a scratch probe was reporting 0 while a
clean one reported the right number on the same build, and the probe was wrong.
The lesson is the cheap one: when two measurements disagree, suspect the newer
instrument before the code.

### And the same for a PDB: SSBOND

Every fixture in `tests/` is a multi-model PDB, and there was no SSBOND reader -
so none of them could declare a disulfide and all of them fell back to the
distance rule. `parsePDB` now reads SSBOND into the same shape a CIF
`_struct_conn` row has, so both formats resolve by one rule downstream, and
`make_traj.py` writes the source's disulfides into every fixture it emits.

A PDB has no label/auth split: its residue number IS what `atomIdToIndex` is
keyed by, so these need no id gymnastics - which is also why `make_traj` writes
them in AUTH numbering, to match the ATOM records beside them.

| `_traj_3ptb.pdb`, six frames | disulfides drawn |
|---|--:|
| before | **[5, 3, 4, 4, 6, 5]** - four distinct |
| after | **[6, 6, 6, 6, 6, 6]** - one |

🔴 **AND IT DID NOT FIX THE TOPOLOGY CHURN, WHICH IS WORTH SAYING.** The
motivating chain was: a flickering bond changes the segment list, which changes
the ribbon, which forces a rebuild. The bond half is fixed and the ribbon half
is not - with side chains shown on the same trajectory the prim count still
moves, 526 to 520. That is the same unexplained instability that blocks the
station fast path (see the stick-refresh section), and disulfides were not its
cause. One less candidate, not a fix.

🔴 **AND A SCRATCH PROBE LIED ABOUT ALL OF THIS, TWICE.** A `/tmp` probe reported
`declared: 0` and an unchanged 3-to-6 count while a clean one reported 6 and a
flat six, on the identical build - which sent me hunting a "missing seam"
between the frame data and the object for three rounds. There was no seam; the
probe was wrong. Both numbers in the table above come from
`tests/disulfides.py`, which is in the repository and is run against the
previous commit to check it can still fail.

### And the backbone: a break is a gap in the numbering

`renderer.sequenceConnectivity = true`, or `config.cutoffs.chainbreak =
'sequence'`. Residue i bonds to i+1 when they are consecutive in the chain;
where either residue number is missing that pair falls back to the distance
test, per pair, so a file with no usable numbering is not bonded into one line.

| `_traj_diffusion_3chy.pdb`, 16 steps | segments | ribbon prims |
|---|--:|--:|
| distance | 91..128, **10 distinct** | 0..383, and **0 for the first four steps** |
| sequence | **127, constant** | 269..383, drawing from step 0 |

The ribbon count still moves under sequence mode and that is correct: the fold
really is appearing, so the secondary structure really does change. What no
longer moves is the CONNECTIVITY, which is what every cache is keyed on.

🔴 **AND IT CHANGES WELL-RESOLVED STRUCTURES TOO, WHICH IS THE DECISION.** On
1TIM the two rules differ by two segments, one per chain: residue 3 is
unmodelled in both, and the CAs flanking the gap are 3.83 A apart - inside the
5.0 A line. The distance rule draws the ribbon straight through the missing
residue; sequence mode breaks there, which is what the file says. Most crystal
structures have unmodelled loops, so this is a visible change to most drawings.
It is defensible - PyMOL breaks there too - but it is a change, so the flag is
opt-in until that is chosen deliberately.

tests/sequence_connectivity.py asserts all three: sequence mode is stable on the
diffusion fixture, the distance rule is UNSTABLE on it (or the fixture is not
exercising the fault and a passing first arm proves nothing), and on a calm
structure every segment the two rules disagree about is one the numbering
explains - counted from the data, not assumed. "The two must agree" was the
first version of that last check and it was simply wrong.

**The fix is that connectivity is chemistry, not geometry.** A disulfide is in
the file - mmCIF's `_struct_conn` carries `disulf` explicitly - and where it is
not, it should be decided once rather than re-derived from a threshold every
frame. The backbone is the same argument one level up: residue i bonds to i+1
because they are consecutive in a chain, and the 5.0 A test exists to catch a
break that the residue NUMBERING already names. `config.cutoffs.protein_bond`
is the hook.

That would be right at every frame with nothing pinned - which is strictly
better than what Keep SSE does, and removes the caveat on its own commit that
pinning "IS WRONG ON A FOLDING TRAJECTORY".

🔴 **AND THE SIDE-CHAIN TABLE ALREADY WORKS THIS WAY**, which is the precedent:
`src/io/sidechains.js` stores each atom in its residue's own backbone frame and
takes its bonds from the residue's chemistry. Its own comment scopes it to
"REPAIR, FALLBACK RESIDUES ONLY". Promoting that from fallback to the source of
connectivity is a smaller job than building anything new, and it changes nothing
for well-resolved structures, where the two agree.

Everything here is measured, not estimated. Reproduce with `tests/bench.js`
and the scratchpad probes. Sizes are synthetic
protein chains from `tests/make_bench.py` unless stated.

## Where the time goes (10000 residues, full quality)

> Earlier era, synthetic chains. For a real structure measured in Chrome, see
> "Where a real frame actually goes" below — the shares are quite different.

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
| structure-of-arrays for the occluder store (typed arrays + counting sort) | 1.45× in Node, **nothing in Chrome** | REVERTED. 85k short-lived objects a frame are nearly free in Chrome — young-generation allocation is a pointer bump and they all die immediately. See "Node's V8 is not Chrome's V8" below; this is the trap that cost the most time here |

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

> Earlier era. Still the right shape - the query loop dominates the ink pass -
> but for current per-stage numbers on a real structure in Chrome see "Where a
> real frame actually goes" below. Two things in this section have since been
> re-tested and did NOT reproduce as levers: the cell pitch (swept 2-24, the
> curve is flat) and any rewrite of the grid's data layout.

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

## Node's V8 is not Chrome's V8 — measure allocation-heavy code in the browser

The most expensive lesson in this file. An occluder-grid rewrite (flat typed
arrays plus one counting sort, in place of one object per occluder, a JS array
per cell and a comparator sort per cell) measured **1.45× on the ink pass and
1.27× on the frame** in the Node harness, over 20 structure/view cases, with
the ink trace bit-identical throughout.

In Chrome the same change is **neutral to slightly negative**. Interleaved
A/B/C in one page load (hot-swapping the plugin between timed batches, so the
renderer, the structure and the machine state are identical), 1VQ8, outline on,
gesture degrade off, min of 9:

| | collect | cell build | query | frame |
|---|--:|--:|--:|--:|
| existing (objects + per-cell arrays) | 17.4–17.7 | 18.4–18.9 | 40.0–40.8 | 235–241 |
| rewrite (SoA + counting sort) | 18.0–18.3 | 23.6–24.5 | 36–52 | 241–247 |

The collection pass Node measured at ~40 ms costs **8.8 ms** in Chrome for the
same frame. Chrome's young-generation allocation and escape analysis simply eat
the pattern the rewrite existed to remove, and the counting sort is *worse*
than thousands of small stable sorts there.

**The rewrite was reverted.** What survives is `tests/smoke.js`'s pitch
test (below) and this warning.

Corollaries, all measured the same way:

- `wrapIdx` split into two closures by `cyclic` instead of branching inside:
  17 ms of a 313 ms frame in Node, **nothing** in Chrome.
- Cell index by reciprocal multiply instead of division: nothing in either.
- Inlining `shade()`'s per-channel `ch` closure: nothing in either (Chrome and
  Node both escape-analyse it away).
- Moving the four cell-span floor-and-clamps out of the per-occluder emitter
  into a tight pass over the boxes: 34 ms in Node, nothing in Chrome.

Use Node for **correctness oracles**, which is what it is good for — the ink
trace and the paint-stream hash below are exact and fast there. Take every
timing decision in the browser.

## The oracles

Two, both cheap, both used to prove the reverted rewrite was output-identical
before it was thrown away for being pointless:

- `renderer._inkTrace = []` — one bit per ink segment, deterministic order.
- **paint-stream hash** — a recording ctx that hashes every drawing call and
  style assignment in order, at full precision (28.9k ops on 1TIM, 306k on
  1VQ8). Nothing is rounded, so it catches arithmetic reordering, which is
  exactly what a "surely equivalent" rewrite risks.

Run both over five structures × four views (two rotations, a zoom, a
perspective setting). A change that claims to be a pure optimisation must not
move a single bit of either.

`tests/smoke.js` guards the grid itself with one implementation-independent
test: **the ink trace must be identical at cell pitches 3, 7 and 24.** The grid
is an accelerator, so the pitch may change how fast an answer is reached and
never the answer. It catches an unsorted cell list and an occluder that misses
a cell it covers, and it was mutation-confirmed against both the old and the
new implementation. One caveat found while writing it: the invariant genuinely
fails for **off-canvas** query points, because the grid covers
`ceil(W / CELL) · CELL` pixels — so the fixture stays inside the canvas.

## Where a real frame actually goes (Chrome 151, measured)

1VQ8 (6655 positions), 598 CSS px at dpr 2, cartoon, outline on, gesture
degrade off, min of 9 renders:

| | ms | share |
|---|--:|--:|
| geometry build | 45 | 18% |
| ink pass | 81 | 33% |
| rest of the paint loop (JS) | ~73 | 29% |
| canvas rasterisation | ~50 | 20% |
| **frame** | **249** | |

Canvas share measured by no-op'ing every `CanvasRenderingContext2D` drawing
method: 232 → 182 ms, i.e. **a perfect painter is worth 1.28×** — the 1.23×
from the older measurement, confirmed in Chrome on a real structure. The GPU
painter stays retired.

Outline off is 249 → 157 ms (1.6×), which is a user control, not an
optimisation.

Ablated in Chrome by hot-swapping short-circuited builds between timed
batches in one page load (1VQ8, same view, min of 9):

| removed | frame | costs |
|---|--:|--:|
| nothing | 233–246 | |
| `shade()` returns a constant string | 222–233 | shading, arithmetic and string both, **≈12 ms (5%)** |
| `painter.quad` returns immediately | 180–182 | every routed fill, path building included, **≈52–64 ms (25%)** |

So the frame divides roughly into fills 25%, ink 33%, geometry 18%, shading 5%,
and a diffuse remainder. Nothing left is a soft target: the fills are already
merged by `pathStrip`, the shading is 5%, and the ink pass is near the floor
for an exact analytic test.

**The detail lever is gone, and the notes above are stale about it.** At
fit-to-view on a large structure, `cartoonDetail` 4, 2 and 1 all produce
16658 primitives and the same frame time: the auto-subdivision cap
(`subCapCur`, sized from pixels per residue) has already clamped to `MIN_SUB`,
so there is nothing left for the detail control to remove. It only bites
zoomed in — at zoom 4, detail 4 → 1 is 121 → 100 ms — which is where frames
are cheap anyway. Any future LOD work has to beat what the pixel cap already
does, not the raw detail setting.

## WASM: measured, and not the thing to do

- WASM cannot draw. Every quad still crosses into JS for `ctx.fill()`, and a
  perfect painter is 1.28×.
- Inside the part it could own, the code is not losing to JS on arithmetic. The
  Node profile said it was, twice, and Chrome disagreed both times.
- The remaining JS cost is diffuse: no hot line survives in the geometry loop
  once `wrapIdx` is discounted, and the ink query loop is already near the
  floor for an exact analytic test.

If the goal is a responsive UI rather than a faster frame, the honest next step
is **not blocking on it** — OffscreenCanvas in a worker — rather than making
the same work go faster.

## Harness hazards (both cost real time here)

- **A mock ctx that answers every property with a function selects the SVG
  path.** `svgStrips` is `!!ctx.getSerializedSvg && !!ctx.createLinearGradient`,
  so a permissive Proxy context makes it true and the renderer runs the SVG
  depth-cull that the screen never runs — one profile had 36% of the frame in
  a function the canvas path does not call. Return `undefined` for
  `getSerializedSvg`.
- **Coordinates must be Vec3-like, with `.x`/`.y`/`.z`.** Passing plain
  `[x, y, z]` arrays makes the hydrogen-bond search bin every residue under
  `"NaN,NaN,NaN"`, so secondary-structure assignment goes quadratic: 36 seconds
  for the first frame of a 7000-residue structure, entirely an artifact.
  `tests/paint_order_audit.js` sidesteps this only because `_forceSec` skips
  the assignment.
- **Test pages bundle the minified build.** `tests/out/*.html` embed
  `bundles/py2Dmol.notebook.min.js`. After editing the source you must re-run terser AND
  regenerate the pages, or you are measuring the old renderer. Two rounds of
  results were invalidated this way — including a "pixel-identical" correctness
  result that was vacuous because the ink pass was not running at all.
- **The third render after a settings change differs from the first two** (a
  cache fills once). Warm up with 3 renders before capturing a reference image,
  or a same-vs-same comparison reports ~29% differing pixels.
- `_quality = 'perfect'` in the harnesses is now a no-op (kept because it is
  harmless): with the gesture downgrade removed, every frame is full quality.

## Why a full GPU port is the next thing

Written before the ink-pass rewrite above; the ink numbers quoted here are the
old ones (that pass is now 2× faster), but the argument about the outline is
unchanged and is still the thing to settle first.

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
- ~~Cheaper and worth doing first: **LOD**~~ — SUPERSEDED. The auto-subdivision
  cap already does this: at fit-to-view on a large structure the detail control
  changes neither the primitive count nor the frame time, because `subCapCur`
  has clamped to `MIN_SUB` from pixels per residue. See "Where a real frame
  actually goes" above. LOD work now has to beat the pixel cap, not the raw
  detail setting.

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
  `inkQueries`, `inkScans`, `inkCell`, `inkCells`, `inkOccRefs`).
- `tests/make_ribosome.py` — regenerates the 4UG0 page, which was previously
  built ad hoc and could not be reproduced after a source change.

## Where the time is now (Aug 2026, after the GPU work)

Rendering is no longer the expensive part of this app. On an M2, 598 px:

| | tube frame | cartoon frame | load to first picture |
| --- | --- | --- | --- |
| 1TIM (492 seg) | ~0.3 ms | 0.51 ms | 70 ms |
| 4UG0 (17.4k seg) | 4.1 ms | 4.6 ms | 1.1 s |
| 3J3Q (312k seg) | ~26 ms | - | **15.6 s** |

**Loading a capsid is now the slowest thing in the product by two orders of
magnitude.** 3J3Q is 242 MB of text and 2.4M atoms, and the 15.6 s splits four
ways, none of them a silver bullet:

| stage | ms | share |
| --- | --- | --- |
| parse, including biounit expansion | 2,823 | 18% |
| frame loop: `convertParsedToFrameData` | 2,344 | 15% |
| frame loop: everything else | 3,685 | 24% |
| align and centre | 62 | - |
| `applyPendingObjects` (i.e. `addFrame` per frame) | 4,723 | 30% |
| first render | 1,911 | 12% |

Every one of those is a pass over 2.4M atoms or 313k positions. Parse is
already the *cheapest* of the big four, having been worked over once - which is
worth knowing before optimising it again, as the obvious target.

**How to reproduce this without touching the source.** The top-level split
needs no instrumentation at all: `parseCIF`, `buildPendingObject` and
`applyPendingObjects` are script-scope globals, so wrapping them from the page
times each. Only the split *inside* the frame loop needed temporary marks, and
those were reverted.

    const o = window.buildPendingObject; let ms = 0;
    window.buildPendingObject = function () {
        const a = performance.now();
        try { return o.apply(this, arguments); } finally { ms += performance.now() - a; }
    };

**CORRECTION - dropping N/C/O is NOT lossless.** An earlier note here reasoned
that since the renderer holds C-alphas and nothing else, the backbone N, C and
O atoms are parsed and discarded, so a parse-time filter would be free. Two
things were wrong with that. The pixel test behind it ran on 3J3Q, whose
residues are all standard, so it could not have detected the failure; and
`isRealAminoAcid` falls back to a connectivity check -

    residue.atoms.some(a => a.atomName === 'N')
        && residue.atoms.some(a => a.atomName === 'CA')
        && residue.atoms.some(a => a.atomName === 'C')

- for any residue NOT in STANDARD_AMINO_ACIDS.

**And the cartoon's PULCHRA reconstruction does not rescue it**, which is the
tempting objection: the renderer does rebuild C, N and O from the C-alpha
trace, and that is exactly why CA-only input DRAWS correctly. But the
reconstruction answers "where is this residue's backbone", and the classifier
is asking "is this thing a residue at all". Reconstruction presupposes the
answer to the second question, so it cannot supply it.

Measured, by renaming five residues of 4HHB chain A to an unknown code XYZ and
loading with ligands on:

| | positions | types | the XYZ residues |
| --- | --- | --- | --- |
| N/C present | 748 | P 574, L 174 | classified P |
| N/C stripped | 743 | P 569, L 174 | **gone entirely** |

They are not even demoted to ligands - they disappear, and every bond index
after them shifts. The saving was 1.1 s of a 16.5 s load and is a smaller share
of a 6.5 s one; it is not worth a filter that has to know which atoms each
classifier reads.

**What would actually move it** is the columnar atom model - the same
conclusion the parser work reached from the other end. Four separate passes
each walk 2.4M atom OBJECTS; the parse builds them, `convertParsedToFrameData`
reads them into typed arrays, and the rest re-walks them for residue grouping
and bonds. Whether that is worth doing is a design decision about the interface
between `src/io/parse.js`, `src/app/` and `core/mol.js`, not an optimisation.

### The first thing the loader profile found: setCoords was quadratic

`setCoords` cost 3.6 s of a capsid's 16 s load - 11.5 microseconds per
position - and all of it was one loop asking, for every CHAIN, whether any
position in it carries a polymer type:

    for (const chainId of sortedUniqueChains)      // C
        for (let i = 0; i < n; i++)                // x N
            if (this.chains[i] === chainId) ...

3J3Q is 1,356 chains and 313,236 positions: **425 million string
comparisons**. The question is per POSITION, not per chain - walk the
positions once, note the chain of each polymer one, and any chain not noted
is ligand-only. O(n + chains), same answer.

| | before | after |
| --- | --- | --- |
| `setCoords` | 3,590 ms | **355 ms** |
| `setFrame` | 3,648 ms | 411 ms |
| `applyPendingObjects` | 5,862 ms | 2,534 ms |
| 3J3Q load to first picture | 16.5 s | **13.2 s** |
| 4UG0 load to first picture | 1.10 s | 0.94 s |

Verified equivalent where it actually matters: with ligands loaded, 4HHB has
6 ligand-only chains, 1HVR 1 and 3PTB 2, and the one-pass version finds the
same sets. Note the first check ran with ligands OFF - which is the default -
and every structure reported zero ligand-only chains, so it proved nothing.
A test of this needs ligands on.

**Why it hid for so long**: the cost is quadratic in CHAINS, and almost
everything has a handful. 4UG0's 81 chains cost 160 ms of its 1.1 s load and
looked like ordinary work. Only a capsid, with more than a thousand chains,
makes it the largest single item in the profile.

### ...and the second: the frame loop converted every model twice

`convertParsedToFrameData` measured 5.5 s on a capsid, against 2.8 s for the
call that feeds the drawing. It has two call sites, and the first one converts
the model AGAIN with `includeAllResidues=true`, then builds a residue map over
every atom and classifies every position.

All of that exists to produce one array, `originalIsLigandPosition`, which is
read in exactly one place: the `if (paeData)` branch, to line a PAE matrix up
with the positions it was computed for. It was being built for every structure
whether it had a PAE or not - and most do not.

Guarding the block on `paeData` takes `buildPendingObject` from 9,284 ms to
6,500 on 3J3Q.

**Testing it needed a structure with ligands AND a PAE**, which is not a
combination that occurs naturally: AlphaFold models carry a PAE and no ligands,
PDB entries carry ligands and no PAE. Pairing 4HHB with a synthetic 801x801 PAE
whose values vary with both indices, and loading with ligands ON so the filter
actually runs, gives 748 positions and 641,601 PAE bytes with checksum
3083556608 - identical before and after. A test that skips the ligands
checkbox proves nothing here, the same trap as the ligand-only chains above.

### Where the capsid load stands

| stage | before | now |
| --- | --- | --- |
| parse | 2,855 | 2,910 |
| frame loop (build minus parse) | 6,181 | 3,382 |
| `applyPendingObjects` | 4,723 | 2,299 |
| first render | 1,911 | 1,978 |
| **total** | **16.5 s** | **8.6 s** |

4UG0 goes 1.10 s to 0.69 s. Both wins were algorithmic and neither needed the
columnar rewrite: one loop that was quadratic in chains, and one whole pass
that did not need to run. Profile before restructuring.

### ...and the third: chem_comp_bond walked every residue to find nothing

`convertParsedToFrameData` was 3.3 s on a capsid, and 2.06 s of it was the
`chemCompBondMap` pass. It walks every residue in the structure and, for each
bond that residue's component defines, builds three template literals to look
two atoms up by name in `atomIdToIndex`.

A protein residue contributes exactly ONE position - its CA. A nucleic one
contributes its C4'. So both ends of an INTRA-residue bond can never be found
for either, and the pass spends its time proving that: on 3J3Q, 313,236
residues x ~15 bonds = 4.7 million lookups and 14 million strings, producing
nothing.

Only a ligand puts more than one atom in `coords`, so only a ligand can carry
one of these bonds. Collecting those residues as they are built and iterating
that list gives the same bonds over a handful of residues instead of all of
them: `buildPendingObject` 6,469 -> 4,316 ms.

Verified with ligands ON, comparing an order-independent checksum of the bond
list before and after: 4HHB 200 bonds / 3140046280, 3PTB 9 / 2820525387,
1HVR 52 / 1448305941, 1AOI 0. Identical.

### The capsid load, end to end

| stage | at the start | now |
| --- | --- | --- |
| fetch | 477 | 387 |
| parse | 2,855 | 2,854 |
| frame loop (build minus parse) | 6,181 | 1,327 |
| `applyPendingObjects` | 4,723 | 2,328 |
| first render | 1,911 | 1,863 |
| **total** | **16.5 s** | **6.5 s** |

4UG0 goes 1.10 s to 0.42 s. **2.5x on the capsid and none of it was the
columnar rewrite** that was the plan going in: one loop quadratic in chains,
one whole pass that only a PAE needs, and one pass that could not produce a
result for 99% of what it iterated. Parse is now the largest single stage and
is the one part that has already been optimised once.

### The safe version of the N/C/O filter, and what it is actually worth

The correction above rules out an unconditional filter. A CONDITIONAL one is
safe, and the condition is the same guard that made the unconditional version
wrong: `isRealAminoAcid` only falls back to looking for N/CA/C atoms for a
residue NOT in `STANDARD_AMINO_ACIDS`. For a standard residue it returns at the
name test and never reads an atom.

For a standard residue, then, N/C/O/OXT are read by nothing:

- the classifier short-circuits on the name;
- `buildSidechainTable` already drops every backbone atom but CA
  (`PROTEIN_BACKBONE_ATOMS` minus CA);
- only its CA reaches `coords`, so nothing addressed by atom index -
  `struct_conn`, `chem_comp_bond`, `atomIdToIndex` - could resolve to one.

So `parseCIF` skips them, gated on the residue name. Verified identical:
positions and segments on 3J3Q and 4UG0; bond count and an order-independent
checksum on 4HHB (200 / 3140046280), 3PTB, 1HVR and 1AOI; the side-chain table
on 4HHB (7 keys, 18,406 values, checksum 2535756989); and the XYZ case that
broke the unconditional version still classifies as protein.

**It is worth 0.56 s of a 6.5 s load, not the 38.6% the atom count suggests**,
and where the time goes is the interesting part:

| | before | after |
| --- | --- | --- |
| parse | 2,854 | 2,781 |
| buildPendingObject | 4,181 | 3,821 |
| applyPendingObjects | 2,328 | 2,129 |

Dropping 38.6% of the atoms takes 73 ms off the PARSE. Nearly all the saving is
downstream, in the passes that walk the atoms afterwards. The parse is
dominated by scanning the text - `readCIFCols` visits every line whatever it
decides to do with it - not by building the objects. Anyone hoping to make the
parse itself faster should attack the scan, not the allocation.

### Telling the scanner early, and what that revealed about the parse

The filter above ran AFTER `readCIFCols` had read all 21 columns of `_atom_site`,
to throw the row away. It only needs two columns - the atom name and the
residue name - and both sit near the front, so the scanner now takes the test
and aborts the row at column 6, returning -1. Parse 2,781 -> 2,655 ms.

That number is the interesting part. Skipping ~15 columns on 38.6% of 2.4M rows
saved 126 ms, which puts the WHOLE column scan at about 450 ms of a 2.65 s
parse. Splitting it further:

| | ms |
| --- | --- |
| `parseMinimalCIF_light` (the pre-scan for metadata loops) | 1,274 |
| header, atom loop and everything after | 1,414 |

**Half the parse is the pre-scan**, which walks the entire 242 MB file to find
`struct_conn`, `chem_comp`, `chem_comp_bond` and the assembly operators - all
tiny - and pays for `_atom_site` twice: once in `text.split(/\r?\n/)`, which
allocates a string per line for 2.4 million lines, and again counting tokens on
every skipped row.

**Do not "fix" the token counting by advancing a line at a time.** That was
tried earlier in this session and 4UG0 came back with 42 loops instead of 40: a
row shorter than its header continues onto the next line, the reading path
swallows the continuation and the skipping path did not, so a loop with
continued rows split in two. The count is what keeps the two paths walking in
step. Making the pre-scan cheap means not materialising the lines at all -
walking the flat text with a cursor, the way the atom loop already does - which
is a real change to that function, not a tweak to this branch.

### The cursor pre-scan, and where the capsid load actually goes now

The pre-scan was rewritten to do exactly that - walk the flat text with a
cursor, materialising no lines - and the token counting on skipped rows moved
out of `readCIFCols` into a dedicated `countCIFTokens`, which drops the want
mask, the output array and the early-abort hook that a count does not need.
The counting itself stays, for the 42-loops reason above.

    3J3Q pre-scan  1,450 -> 806 ms
    3J3Q parse     2,655 -> 2,152 ms

One trap on the way in, worth naming because it failed silently: folding case
with `c | 32` corrupts `_`, which is 95 and folds to 127. Every CIF keyword
this function looks for ends in an underscore, so `loop_` never matched and
the function cheerfully returned zero loops for every file on earth. Fold both
sides or neither.

With that done, 3J3Q (242 MB, 2.4M atoms, 313k positions) breaks down as:

| stage | ms |
| --- | --- |
| pre-scan (`parseMinimalCIF_light`) | 810 |
| metadata loops + `_atom_site` header | 185 |
| atom row loop | 1,153 |
| &nbsp;&nbsp;- of which tokenising | ~908 |
| &nbsp;&nbsp;- of which building atom objects | ~270 |
| `maybeFilterLigands` | 141 |
| `convertParsedToFrameData` | ~490 |
| &nbsp;&nbsp;- residue grouping | 114 |
| &nbsp;&nbsp;- sort + nucleic resolution | 35 |
| &nbsp;&nbsp;- classification loop | 149 |
| &nbsp;&nbsp;- `buildSidechainTable` | 185 |
| rest of `processFiles` | ~640 |
| `applyPendingObjects` | 632 |

Two things were measured and found NOT to be the problem, which is worth
recording so nobody spends the afternoon on them:

- **`localeCompare` in the residue sort.** It looks like the classic mistake -
  a locale-aware comparison inside a sort over 313,000 items - and it costs
  **17 ms**. The residues arrive very nearly sorted and there are only a few
  hundred distinct chains.
- **The `hasFrame` pre-pass in `buildSidechainTable`**, which calls `localFrame`
  once per residue: **9 ms**. All 290 ms of that function was the per-residue
  loop underneath it, and specifically its allocations.

The two wins that followed both came from not allocating:

- Atoms arrive in residue order, so grouping them by comparing three fields
  against the previous atom avoids building and hashing `chain:seq:resName`
  1.5 million times. The map stays for the atoms that interrupt a run.
  `maybeFilterLigands` 215 -> 141, grouping 179 -> 114.
- `buildSidechainTable` allocated ten containers per residue - two Sets, a Map,
  an array per atom, a stack per walk - about three million objects for the
  capsid. Hoisted into typed-array scratch that grows to the largest residue
  and is then only cleared: 290 -> 185 ms.

**Verify loader changes with the signature harness, ligands ON.** A hash over
every coordinate, chain, type, residue name and number, the whole side-chain
table and the bond list. With ligands off the bond list is empty and the check
is close to vacuous - that mistake has been made twice in this codebase.

### Slicing the load, and how to tell whether a progress bar is real

A bar is not a UI feature. The first attempt at one appeared and sat still,
because the load was a single synchronous block: there was no moment between
"started" and "finished" at which the browser could paint. Making the bar
honest meant making the loader yield, which meant `parseCIF` and
`convertParsedToFrameData` became generators - drained whole by the
synchronous entry points (both node tests included), or a slice at a time by
an async drainer.

**Measure what reached the screen, not what you assigned.** Sampling
`bar.style.width` from a `setInterval` is worthless twice over: the attribute
changes whether or not anything is painted, AND a high-priority continuation
starves timers, so the sampler goes quiet exactly when the interesting thing
is happening. That made a working yield look broken. Sample inside
`requestAnimationFrame` and count DISTINCT values - a rAF callback runs when
the browser is about to produce a frame.

With that instrument, 242 MB capsid, through the real fetch button:

| yield | visible steps | total |
| --- | --- | --- |
| none (one block) | 1 | - |
| MessageChannel, 8 MB slices | last 700 ms painted nothing; stalls at 81% | 3,125 ms |
| scheduler.yield, 8 MB slices | 17 | 3,125 ms |
| setTimeout, 12 MB slices | 34 | 3,225 ms |
| setTimeout, 3 MB slices | 47 | 3,650 ms |

`MessageChannel` is the usual trick for dodging the ~4 ms timer clamp and it
is the wrong tool here - postMessage tasks are serviced ahead of both timers
and rendering. `scheduler.yield` continues at high priority and throttles
rendering to ~18 fps no matter how fine the slices are. The plain timer is the
one that lets a frame through; the slice size then buys steps at a known price,
because a frame on this page costs around 11 ms.

Also: the bar must be seen to FINISH. The last stage - setCoords and the first
render - runs with the main thread pinned, so the last value anyone can see is
whatever was painted before it began, around 80%, and then the bar is hidden.
Stall-then-vanish reads as death, not arrival.

### 7Y7A, and why a capsid never showed the worst bug in the loader

`isResidueConnected` looks for the residues in the same chain within two of
its own number - four candidates at most - and used to find them by walking
the whole residue list. A standard amino acid never calls it, so 3J3Q, which
is standard residues nearly all the way down, ran clean at 313,000 residues.

7Y7A has 8,830 non-standard residues (3,540 UNK, 2,988 PEB, and a long tail of
pigments and lipids) among 309,602, and every one of them asks - once in
`maybeFilterLigands` and again in `convertParsedToFrameData`. Billions of
comparisons, landing as a fifteen-second frozen block with the progress line
stopped on "Grouping residues".

    7Y7A, ligands off   32,270 -> 3,899 ms
    worst frozen block  14,832 -> 611 ms

The lesson for the next one of these: a structure being LARGE is not what
finds quadratic behaviour in this loader, because the fast paths are keyed on
residues being standard. A structure being UNUSUAL is. Keep a file like 7Y7A
in the bench set alongside a capsid; they exercise different code.

### Ligands ON for a structure this size: two more of the same bug

7Y7A with ligands enabled is 511,958 positions, 223,276 bonds, ~8,800 ligand
groups and 6,390 chains. Both remaining cliffs were per-ligand scans of a
whole-structure list, exactly like isResidueConnected:

- **`fileKnowsIt`** (core/mol.js, inside setCoords) walked every bond in the
  structure to decide whether the file already describes ONE ligand's
  connectivity. Two billion comparisons. Now every bond is looked at once and
  charged to the group both its ends sit in - the same question from the other
  side.
- **The sequence view** rebuilt its position -> ligand-group reverse map inside
  the per-chain loop, though it does not depend on the chain: 6,390 chains x
  207,000 ligand positions = 1.3 billion Map writes to produce the same map
  6,390 times.

| | before | after |
| --- | --- | --- |
| processFiles | 17,342 ms | 3,489 ms |
| sequence build | ~97,000 ms | 327 ms |

**And a correction worth keeping, about the harness rather than the code.**
That 97 s was first reported as a "first render". It was not: `render()`
measures 0 ms on this structure. The harness timed `r.render()` together with
a `setTimeout(300)` wait, and what actually ran during the wait was the
deferred sequence build. Any figure that brackets a wait is measuring
everything the event loop chose to do in it. Time the call, not the window.

### The cartoon build's memory, and what is actually left

The capsid could not enter cartoon mode. Three findings, in the order they
mattered.

**A diagnostic global was holding every face forever.** `makeResident` ended
with `window.__faces = faces`, added during the GPU port and read by nothing -
not the app, not the tests, not the benchmark harnesses. It pinned each face's
four model-space corners, its outward normal and its interior flag for the life
of the page, after the geometry had been uploaded.

    cartoon build, GPU on   10,017 -> 317 bytes per position retained

**Measure live data only after a real collection.** The 20 kB/position the
memory guard was built on was garbage: `window.gc` is a silent no-op unless
Chrome is started with `--js-flags=--expose-gc`, and without it the heap after
a build is mostly uncollected. With a real collection the same build retains
163 bytes per position. The guard now names the PEAK, which is the number that
actually kills a tab, and says so.

**Verify a rendering change on geometry, not on pixels - here, pixels cannot
be measured at all.** Three runs of the SAME build gave ink counts of 660, 503
and 486 while canvas size, zoom, extent, face count and edge count were
identical every time. A WebGL canvas without `preserveDrawingBuffer` has been
cleared by the time `drawImage` runs. Pinning the camera does not help. The
usable check is the edge stage's own output: faces and edges per structure.

Where the build stands, on 1OHF (135,780 positions, 1,199,700 faces):

| stage | time | heap after |
| --- | --- | --- |
| capture (288,611 2D prims) | 2,180 ms | 147 -> 699 MB |
| facesOf | 250 ms | -> 1,078 MB |
| rails | 320 ms | -> 1,558 MB |
| normals | 540 ms | -> 2,026 MB |
| facesAndEmit | 1,050 ms | -> 2,042 MB |
| edges | 2,600 ms | -> 2,007 MB |
| buffers | 130 ms | -> 2,020 MB |

The capsid does build now, with `cartoonForce`: 20.8 s, peak 4,160 MB against
a ~4.3 GB limit, and then it DRAWS at 11-18 ms a frame. The guard still refuses
it and that is right - 140 MB of headroom is not a margin.

**Two things that measured as nothing, so nobody need retry them:**

- Replacing the edge table's inner Map-per-vertex (about 600,000 Maps) with
  flat arrays: 7,220-7,584 ms against 7,288-7,466, peak unchanged. Reverted.
- The Detail control has no headroom left at this scale. detail 1, 2 and 4 all
  produce exactly 1,199,700 faces, because the screen-space subdivision cap has
  already driven stations to MIN_SUB.

**And one that settles the direction.** Forcing a full collection between every
stage costs 25% more time and takes the peak from 2,050 MB to 1,697 MB - only
17%. So the peak is LIVE data, not collectable garbage, and slicing the rebuild
to let V8 breathe cannot fix it. 12.5 kB per position is genuinely alive at the
worst moment.

That leaves two levers, and only two: make fewer faces (the structure is 8.8
faces per position, which for a capsid is 2.7 M faces for a 600 px image - 0.06
px per residue), or never hold them all at once (build, upload and discard per
chain).

### The interaction paths, and the one that was actually broken

Nothing here had ever been timed. Swept on 7Y7A (305,004 positions, 1,792
chains) with the GPU confirmed to have drawn:

| | |
| --- | --- |
| render, rotate, zoom | 0 ms |
| colour mode change | 0-44 ms |
| select a chain / 5,000 residues | 12-17 ms |
| showAll | 67 ms |
| side chains on / off | 365 / 280 ms |
| setFrame (same frame) | 214 ms |
| SEQ buildView | 154 ms |

All healthy. The side-chain toggles and setFrame cost what a full setCoords
costs, which is what they do.

**But the first run of that sweep read 740 ms for render, 1,854 ms for rotate
and 1,900 ms for showAll**, and it was the 2D fallback: the GPU had not been
available in that run. `useGPU` is a REQUEST, not a fact. Timing a frame
without knowing which path drew it measures nothing, so
`renderer.gpuDrewLastFrame` now records it - set by both branches, since the
cartoon delegation and the tube path reach the GPU by different routes.

Those 2D numbers are also worth keeping as the answer to "what does a user
without WebGL2 get on a large structure": about 0.7-2 s per interaction.

### Session files were three quarters whitespace

`saveViewerState` wrote `JSON.stringify(state, null, 2)`.

    1TIM     330,741 ->      81,145 bytes
    4HHB     431,868 ->     106,309
    1AOI     633,260 ->     158,286
    7Y7A 211,932,481 ->  61,652,330

Verified by round trip - save, load the file back the way a dropped file
arrives, hash the restored state - identical to HEAD's restored state. Note a
round trip is NOT lossless in either version: coordinates are rounded on save
and MSE is normalised to MET, so the restored state differs from the loaded
one by design. The test is that it differs by the same amount as before.

**Loading a session is the fast path, and measure it COLD.** Timed in the same
page that had just parsed the 274 MB CIF, a session load read 7.3 s and looked
slower than re-parsing the original. It is not - that page was under heap
pressure with a major collection pending. Each in its own fresh page, 7Y7A,
same 305,004 positions:

| | fetch | processFiles | until coords exist |
| --- | --- | --- | --- |
| 7Y7A.cif (274 MB) | 390 ms | 3,100 ms | 3,100 ms |
| session (61.6 MB) | 130 ms | 170 ms | 810 ms |

So a session restores in 0.94 s against 3.5 s for the file it came from, about
4x. Note `processFiles` returns at 170 ms while the coordinates do not exist
until 810 ms - the state loader applies asynchronously, so anything timing a
session load has to wait for the object rather than for the call.

**What is left in a session, if anyone wants to go further.** On 7Y7A the 57 MB
payload is 43.7 MB of side-chain table: coef 17.6, bonds 10.8, pos 6.7,
frameOf 6.7, toBackbone 1.9. Two columns are nearly free to remove and both
need a format version:

- `frameOf` equals `pos` for 99.5% of rows (1,060,359 of 1,065,107; 4UG0 is
  99.0%), so only the exceptions need storing.
- `pos` runs 3.8 rows deep on average (282,055 runs for 1,065,107 rows), so it
  run-length encodes about 4:1.

Together roughly 20% of the file. `coef` and `bonds` are the larger half and
would need real encoding, not just de-duplication.

### Chunking the cartoon mesh build: the design is sound, the cheap routes are not

Chunking by CHAIN is exact, and this is the evidence:

- **The interior weld never spans chains.** Coincident quads, hashed the way
  the build hashes them (0.001 A): 0 cross-chain on 4HHB, 1AOI and 9FOG. So a
  per-chunk weld is the same weld.
- **Edges DO span chains** - 49 on 1AOI, 5 on 9FOG, 0 on 4HHB - and they are
  real, not an artefact of attributing a piece to a chain by flooring its
  fractional residue index: the pieces involved are 89-109 residues apart, and
  the count of cross-chain edges between ADJACENT residues, which is what a
  boundary mislabelling would produce, is zero. So the edge table has to stay
  GLOBAL. That is fine - it already is, and it is what makes chunking exact
  rather than approximate.
- Component analysis agrees the geometry decomposes: the largest connected
  component of the piece graph is 1.4-11% of faces. But almost no component is
  a contiguous range of pieceIds, so the partition cannot be derived cheaply
  from the prim stream - it has to come from chain identity.

**The prize**, from the LIVE heap after each stage on 1OHF (1,199,700 faces,
full collection between stages):

| stage | live | added |
| --- | --- | --- |
| after facesOf | 891 MB | faces + fill buffer |
| rails | 1,154 | +263 |
| normals | 1,395 | +274 |
| edges | 2,049 | +651 |

Chunking moves faces, rails and normals off the peak; the fill buffer and the
edge table stay. 2,049 -> about 880 MB, and the capsid with it.

**Everything cheaper than that has now been tried and measured as nothing.**
Recorded so nobody repeats them:

| attempt | result |
| --- | --- |
| Release each prim as facesOf consumes it | live peak 1,697 -> 1,697. The prims are already dead before the peak. |
| `pieceFrame.clear()` before the edge stage | 1,395 -> 1,395 at normals. The frames are reachable from the FACES; clearing the map frees nothing. |
| Flat arrays instead of ~600k per-vertex Maps | 7,220-7,584 ms vs 7,288-7,466. No change either way. |
| Stop allocating `[r,g,b]` per addEdge call (~4.8 M arrays) | peak 2,039 vs 2,040 MB, time unchanged. |

The memory is genuinely live and genuinely needed until the end of the build.
The only lever left is not holding all of it at once.

**And there is now an instrument for attempting it**: `__fillHash` and
`__edgeHash` pin both GPU buffers bit-for-bit, which face and edge counts do
not, and which the pixels cannot.

### Chunking the cartoon mesh build: it does not work, and here is why

Built it, measured it, reverted it. The scaffolding was sound and bit-identical
at every step - a runChunk boundary, a chunk-driven makeResident, grown output
buffers - and the thing it exists to enable is wrong.

**The interior weld is global, and not in a way chunks can respect.** It drops
a quad that appears twice, which is how two butted solids lose the caps buried
between them. Chunking makes each chunk weld only against itself. Measured on
3IZG, a 60-copy assembly, 888,000 faces:

| | interior faces dropped | edges emitted |
| --- | --- | --- |
| whole | 74,415 | 861,656 |
| chunked by chain | 3,216 | 857,873 |
| cut in stream order | 4,106 | 857,837 |

Around 3,800 edges that should have welded away get drawn. Those are the extra
lines across a helix and between bonds that the weld exists to remove. Raising
the chunk size past the whole structure restores 74,415 and 861,656 exactly,
so it is the chunking and not the grouping.

**The assumption that failed** was that coincident quads never span chains. On
single-copy structures they never do - 0 on 4HHB, 1AOI and 9FOG, which is what
the design was built on. A biounit expansion is a different animal: the copies
weld against each other, and no partition by chain can see both halves.

**Chunks must also be whole chains, and chains are not contiguous in the prim
stream.** Cutting where the chain key changes still splits a chain whose prims
arrive in two runs. Gathering by chain fixes that and reorders the emission,
which is a permutation of the fill buffer - harmless in itself, since it can
only change which of two exactly coincident faces wins the depth test, and
those are the faces the weld drops - but it does not save the weld either.

**The exact version costs more than it saves.** A first pass computing only the
global face-key counts would make the weld right, but it has to rebuild every
face, so the prims must survive both passes - and the prims are 552 MB of the
2,049 MB peak. That leaves about 23%, against roughly 55% for the version that
breaks the weld, and 23% does not get a capsid in.

So the remaining lever really is the other one: make fewer faces.

Kept from the attempt: __fillHash and __edgeHash, which pin both instance
buffers bit-for-bit. They caught the emission reordering and the broken weld,
and neither was visible in face counts or in pixels.

🔴 **AND THEY ARE GONE.** Nothing in `src/` has defined either for some time -
searched, not assumed - so the paragraph above describes an instrument this
repository does not have, and two comments in `cartoon/paintgl.js` were written
against it on the strength of that sentence before anyone checked. What exists
now is `window.__fill` under `__gpuDiag`: the instance array itself, which is
strictly more than a hash and is what a comparison with a tolerance needs. A
note that outlives its subject is worse than no note.

## An animation frame, and what a trajectory rebuilds for nothing

Measured with `tests/anim_profile.py`, which drives Chrome over CDP and reads a
sampling profile — after two earlier probes that hooked global names by guess
and produced confident tables of zeros. Trajectories from
`tests/make_traj.py`: one structure under a smooth low-frequency breathing
displacement, so the fold provably does not change.

**1TIM, 494 positions, 120 steps, `gpuDrewLastFrame=True`: 17.5 ms a step.**
`__rebuild` reports `ribbonReused=false` on every step — 6923 ribbon primitives
rebuilt each frame — and `otherReused=true`.

| self time | | topology or geometry? |
|---|--:|---|
| `buildMeshPart` | 25.9% | both — positions yes, face list and layout no |
| `addEdge` + `eGrow` | 8.2% | **topology**: face adjacency does not move |
| `assignSecondaryOpen` + `assignSecondary` + `buildSheetFramesOpen` + `predictBackbone` | 12.0% | **topology** |
| `ribbonHashOf` + `hashAt` | 6.2% | the reuse check itself, which always misses here |
| `facesOf` + `drawRun` + `render` + `evalSlab` | 12.5% | geometry (the 2D capture) |
| `makeResident` + `installParts` | 6.1% | geometry (upload) |
| garbage collector | 4.3% | |
| `updateSize` **[panels/heatmap.js]** | 1.7% | should not run during animation at all |

🔴 **A redraw with every cache hot is 0.1 ms and issues zero `ctx.fill`.** With
the GPU painter drawing, essentially the whole per-frame CPU cost is rebuild.
The "geometry build 18% / paint 72%" table at the top of this file is from the
2D-canvas era and that ratio has inverted.

### What was taken: `renderer.stableTopology`

The three caches on `secCacheKey` — the assignment, the base pairing, the sheet
frames — answer questions about *which residues these are*, not where they sit,
and `_coordsKey` names the frame, so a trajectory recomputes all three for every
one. `parts/multi.js:_topologyKey` is the same statement without the frame and
without the coordinate samples; `renderer.stableTopology = true` selects it.
Gated by `tests/stable_topology.py`.

| | off | on | |
|---|--:|--:|--:|
| 1TIM, 494 pos | 20.2 ms | 16.9 | **1.19x** |
| 1AOI, 1097 pos (protein + DNA) | 41.1, 41.7 | 34.8, 35.5 | **1.18x** |

🔴 **AND THE ASSIGNMENT IS NOT CONSTANT EVEN WHEN THE FOLD IS.** This was the
surprise, and it is why the gate does not test for equality. On a trajectory
whose fold cannot change, the recomputed assignment still takes **15 distinct
values over 30 frames**, differing from frame 0's by up to 2.43% of residues
(12 of 494, mean 1.79%) — a helix end moving in and out by a residue as the
backbone breathes. So the option does change the picture, slightly, and it also
removes that flicker. A folding trajectory sits at **64%** disagreement, a
factor of 26 away, which is what makes the threshold an easy call and the
opt-in mandatory: kept across a fold that really changes, it draws the first
frame's helices on the last frame's coordinates.

### What is left, in order of size

- **`buildMeshPart` at 25.9%.** Only positions and normals move; the face list,
  the index buffer and the palette do not. Rewriting positions in place against
  a kept part is the next increment.
- **The edge pass at 8.2%.** Boundary edges are adjacency and cannot change;
  creases are an angle between faces and can, slightly. Splitting discovery from
  emission is the work.
- **The hash at 6.2%.** `ribbonHashOf` exists to notice the mesh did *not*
  change. During a trajectory it never hits, so it is pure overhead — but it is
  what makes dragging cheap, so it cannot simply be skipped.
- **The real prize is not any of these.** Upload per-residue frames and let a
  vertex shader sweep the cross-section, and a frame becomes O(residues)
  uploaded rather than O(vertices) rebuilt, approaching the 0.1 ms a hot redraw
  already costs. That is a rewrite of the ribbon surface generation.

### Harness hazards found here (a third and a fourth for the list above)

- **`window.__mrPhase` cannot be read from outside.** The side-chain group
  (`g === 2`) is always rebuilt even when empty and writes its marks last, so a
  reader always gets the zero-face build: `faces=0` and every phase at 0. The
  ribbon's own marks are in `__mrRibbon`, and only when `window.__heapProbe` is
  set.
- **`setFrame(n)` on the frame that is already current is a no-op**, the mesh
  signature does not move, the GPU redraws the resident mesh, and the draw stage
  that fills `_cartoonSec` never runs. A probe that steps to frame 0 from frame
  0 reads `null` and calls it a disagreement.

## The station path: a trajectory frame without a mesh rebuild

A frame change rebuilt the whole mesh - capture, `facesOf`, `buildMeshPart`, the
edge table, 1.3 MB of instance rows - because every cache derived from the
coordinates keys on the frame. It does not have to. Two facts, each pinned by
its own gate:

- **A station is a frame and two scalars.** `Lp = mid + wa*halfW + ub*halfT` and
  the other three corners likewise, exact to 0.0000% with controls at 756%,
  1456% and 7566% (`tests/cartoon_station.js`). Eleven floats place the corners;
  fourteen shade them too, because the tangent is wanted as well.
- **A face is a piece, a station and a surface.** `q = [A[k], B[k], B[k+1],
  A[k+1]]` over the four surfaces, plus two caps - asserted corner for corner
  against `facesOf` over five fixtures, zero mismatched, three controls failing
  at 49.7%, 99.3% and 99.3% (`tests/station_faces.js`).

So the geometry is a texture and the face list is a buffer that does not move.

| | per frame |
|---|--:|
| 1UBQ | 191 KB of faces rebuilt → **25 KB** of stations uploaded |
| 1TIM | 648 KB → **87 KB** |

Each station's frame is already copied onto **4.3-4.4 faces** in the shipped
row, which is the redundancy this removes. `nA`, `nB`, `tA`, `tB` and the
outward normal come out at **exactly 0.00e+00** against the uploaded rows,
because `buildMeshPart` reads them from `pf.frames[f.st]` and `facesOf` fills
that from the station's own `ub`, `wa` and `tv`.

### What it measures

🔴 **AND THE FRAME IS NOT BIT-REPRODUCIBLE ON THIS MACHINE, WHICH SHAPES EVERY
COMPARISON HERE.** Two runs of the identical commit, with the camera pinned to a
fixed rotation, zoom, extent and focal length, give different pixel hashes -
sometimes with an ink count identical to the pixel. Measured as 32x32 block
means, that run-to-run noise is **3.1 to 4.0 levels out of 255**. So a digest
comparison across two checkouts measures the noise and nothing else, and every
before/after claim below is a block-mean difference read against that floor.

The check that matters most: **the default path draws what it did before any of
this**. Six structures, camera pinned, HEAD against the commit the work started
from:

| | noise, same commit | before vs after | ink |
|---|--:|--:|--:|
| 1UBQ | 3.31 | 3.20 | identical |
| 3CHY | 3.78 | 2.88 | identical |
| 4HHB | 3.16 | 4.47 | identical |
| 1TIM | 3.06 | 4.16 | 0.025% |
| 1EHZ | 3.47 | 3.76 | 0.080% |
| 1AOI | 3.98 | 4.24 | 0.143% |

Every difference is inside the same-commit envelope and three of the six match
ink exactly.

Pixel comparison against the shipped path, same view, same frame:

| | |
|---|--:|
| 1UBQ / 1TIM / 3CHY | **0.0000%** of pixels moved, worst channel 0-1 |
| a turned view, as the control | 13-36% moved |

And stepping a trajectory, through `renderApp` itself:

| | outline on (the default) | outline off |
|---|--:|--:|
| shipped step | 12.4-13.0 ms | 9.0-11.1 |
| station step | **4.2-6.0** | **3.7-4.7** |
| | **2.1-3.0x**, median 2.95 | **2.4-2.8x** |
| fast path taken | 33 of 33 | 33 of 33 |
| picture | 0.0018%, worst 62 | 0.0002%, worst 31 |

🔴 **A RANGE, BECAUSE ONE RUN IS NOT A MEASUREMENT HERE.** Three runs of the
identical build gave 2.95x, 2.12x and 2.95x at this size. Quoting the best of
them - which an earlier version of this file did, at 3.20x - is not a number
anyone can reproduce.

### Where a station step goes, and what is left

Profiled at 5,000 residues over 40 steps, all taken, none rebuilt:

| | |
|---|--:|
| `drawRun` - the capture | 25.5% |
| garbage collector | 8.0% |
| `stationMeshOf` - building the table | 8.0% |
| `updateStations` - centroids and upload | 7.8% |
| `evalSlab` - the spline itself | 5.5% |
| `refreshEdgesFromStations` + `cornerOf` + `normalOf` | ~11% |
| `_storeRibbonTrace` | 5.4% |
| `render` (geom) | 5.4% |

🔴 **`evalSlab` IS 5.5% AND `drawRun` IS 25.5%.** The spline evaluation - the
part a station actually needs - is cheap. The other twenty points are corners,
lighting dots, piece cutting and slicing eleven arrays per piece, none of which
this path reads: it takes the frames and throws the rest away. A stations-only
mode in `geom.js` is where the next factor is, and that profile is the argument
for it.

Two allocations were removed after profiling and both were worth about the same:
`stationMeshOf` pushed 553,000 numbers into JS arrays and copied them into a
fresh `Float32Array` every frame (12.4% → 8.0%), and the texture upload built a
fresh padded array every frame (8.7% → off the list). The shapes do not change
while the topology holds, so both are grown once and reused.

🔴 **AND THE MAPPING HAD TO BE COPIED WHEN IT WAS.** `makeResidentStations` kept
the subarrays it was handed, which are views into the reused buffer - so the
"installed" mapping was overwritten by the next capture, and `updateStations`
compared the new mapping against itself and agreed with everything. That is the
one thing it exists not to do.

### At size

Synthetic chains from `tests/make_traj.py --n=`, cartoon forced, outlines on,
median of a stepped trajectory:

| residues | shipped step | station step | | stations |
|--:|--:|--:|--:|--:|
| 494 | 12.4-13.0 ms | 4.2-6.0 | 2.1-3.0x | 3,207 |
| 2,500 | 100.6 | 28.5 | 3.53x | 17,294 |
| 5,000 | 176.5 | 50.7 | 3.48x | 34,555 |
| 10,000 | 344-401 | **73-77** | 4.47-5.19x | 64,712 |

The fast path is taken on every step at every size; nothing rebuilds.

🔴 **BUT THE APP DOES NOT DRAW A CARTOON AT THAT SIZE.** `LARGE_MOLECULE_CUTOFF`
is 1,000 segments, above which the style switches to tube - and a 10,000-residue
tube steps in **7.7-9.2 ms** without any of this. So "will a 10,000-residue
protein animate" is yes, and not because of the station path. What the station
path changes is whether one can be animated *as a cartoon*: 340 ms a step is
unusable, 75 ms is about 13 fps, and playback's own timer is 100 ms - so it
keeps up at 1x and is still heavy to scrub.

### What it costs the path that does not use it

Nothing, now - but it did, and only asking the question found it. The edge pass
records six integers a row so an edge can be rebuilt from stations, the edge
slot grew from five ints to nine, and `renderApp` built a second signature every
frame. All three were paid on **every rebuild**, including for a reader who
never presses Keep SSE:

| default path, cartoon | baseline | with the tax | gated |
|---|--:|--:|--:|
| 494 residues | 15.2 ms | 16.0 | 14.5 |
| 2,500 residues | 79.1 | 81.4 | 79.8 |

Medians of three to five runs, consistent in direction at both sizes. All of it
is behind `stationDraw` now, `E_I` included - the slot is five ints again when
nothing will read the other four - and afterwards the medians overlap with
baseline (14.1-15.2 against 14.6-15.7).

🔴 **AND GATING IT BROKE THE GPU PATH FOR ONE BUILD.** `edgeSrc.subarray` on a
null - it is no longer allocated when the path is off - throws inside the
capture, and the GPU declines **silently**, which is its design. The step went
from 81 ms to 640 and `gpuDrewLastFrame` to false. On a path built to fall back
rather than fail, the number to read is the flag and not the time.

### The hitch that was left, and what it turned out to be

A periodic lag remained once everything above was working - not at the wrap,
where it looked like it was, but at two frames in fifteen, every cycle, at
180-250 ms against 25. The fast path was not declining there; it was not being
attempted, because the topology signature had moved. Which term, once
`renderApp` was made to say: **the segment count, 3336 -> 3337 -> 3336**.

Connectivity between protein alpha carbons is a distance test at 5.0 A **with no
hysteresis**, so a pair sitting near it crosses back and forth as the structure
breathes. That is not a molecule making and breaking a bond, and it costs twice
over: the ribbon visibly breaks and rejoins, and the face list changes, so every
cache keyed on the geometry is discarded and the frame rebuilds.

Keep SSE already claims these frames are one molecule moving. If that is true
the bond list is a property of the molecule and not of the frame, so the segment
cache outlives the frame under the same flag - checked on the object name and
the position count, which are the things that would make the indices mean
something else. `tests/stable_topology.py` drives a fixture with one bond
straddling the threshold: **loose [58, 59], pinned [59]**.

    9FOG, the flickering amplitude, cartoon at 4x     8.1 fps -> 25.3   3.14x

before which the same trajectory needed its motion damped to demonstrate
anything, because two rebuilds a cycle were most of what remained.

### The two-tone helix flickers, and it is not this path's doing

Reported as "with Keep SSE on, the outside of a helix goes light". Measured by
looking for pixels that OSCILLATE - differ from both neighbouring frames while
the neighbours agree, which is what separates flicker from a ribbon simply
moving:

| | oscillating pixels | worst |
|---|--:|--:|
| shipped path | 0.4153% | 220 |
| Keep SSE | 0.4182% | 166 |

**The same flicker, on both paths.** What Keep SSE changes is that the animation
runs at 25 fps instead of 8, so the reader sees the frames it was previously
losing in the choppiness.

🔴 **AND THE THING BLOCKING IT WAS KEEP SSE THROWING AWAY ITS OWN PIN.**

With side chains shown the ribbon's prim count moved frame to frame - 1456,
1452, 1460 - on a trajectory whose backbone is not moving relative to itself, so
the station table refused every step. Ruled out first, each by measurement: the
topology key (byte-identical every frame), the segment list (774), the bond list
(281), disulfides (0 on this structure), and view culling (`_noViewCull` gives
the identical sequence).

Diffing the prims between two frames named it in one go: three intervals moved
**C -> H** and a fourth resubdivided. The secondary structure was being
reassigned every frame while Keep SSE claimed to be holding it.

`_invalidateSegmentCache` clears `_cartoonSec` outright, and its own comment
says why: the ordinary key is object|frame|n, which cannot catch a coordinate
swap. Under `stableTopology` the key is `_topologyKey()` instead - object, drawn
set, side-chain count, position count, and deliberately NOT the frame, which is
what pinning means. A key that strong does not need the blanket clear, and the
blanket clear destroys it. It mattered because `_materialiseSidechains` ends by
calling it and runs EVERY FRAME - side-chain indices are reissued each time, so
it cannot be skipped.

So the caches are kept when `stableTopology === true` and cleared as before
otherwise. Anything that genuinely changes the topology changes the key and
misses on it, which is the check they already carry.

| `_traj_1tim.pdb`, side chains shown | | |
|---|--:|--:|
| ribbon prims, two frames | 1452 -> 1460 | **1456 -> 1456** |
| intervals whose piece count differs | 4 | **0** |
| fast path taken, 5 steps | 0 | **5** |
| against the same frame rebuilt | - | 0.0002% of pixels |

**And that is what makes the stick refresh reachable.** With the mapping holding,
`refreshSticksFrom` rebuilds its 2,254 rows and 2,608 edges per step and the
frame is exact. The two halves only work together: the refresh without this fix
never ran, and this fix without the refresh would have drawn the side chains
from the build frame.

🔴 **AND THE STICKS NOW HAVE A REFRESH, WHICH IS NOT YET REACHABLE.**
`refreshSticksFrom` rebuilds the two stick parts - side chains, and ligands and
contacts - from the fresh prims and writes them back over the spans
`installParts` records, skipping everything else a rebuild would redo: the
ribbon's faces and mesh, the ribbon hash, the edge adjacency and crease pass,
and the reallocation of every buffer. It validates every span before it writes
anything, so a refusal leaves the buffers untouched. Measured working on 1TIM
with 74 side chains out: **2,254 rows and 2,608 edges rebuilt, and the frame
exact against a rebuild.**

🔴 **BUT THE RIBBON'S OWN MAPPING DOES NOT HOLD WHEN SIDE CHAINS ARE SHOWN, AND
THAT IS A SEPARATE FAULT.** With side chains out, the ribbon's prim and station
counts move frame to frame on a trajectory whose backbone is not moving
relative to itself:

| frame | ribbon prims | stations | sticks |
|---|--:|--:|--:|
| 0 | 1456 | 3183 | 2260 |
| 1 | **1452** | **3177** | 2260 |
| 2 | **1460** | **3189** | 2260 |
| 3 | 1460 | 3189 | 2260 |
| 4 | 1460 | 3189 | **2254** |

With side chains OFF the same trajectory is 1456 / 3183 on every frame. So the
station table refuses first and the stick refresh never runs.

**What it is not**, each ruled out by measurement rather than by reading:

- the secondary-structure assignment - the topology key is byte-identical on
  every frame (`frames|_traj_1tim|sc74|763`)
- the segment list - 774 on every frame
- the bond list - 281 on every frame
- disulfides - 0, and the S-S test was the strongest candidate, being a raw
  distance threshold with no hysteresis exactly like the CA-CA one
- view culling - `renderer._noViewCull = true` gives the identical sequence

So something in the ribbon's own emission varies with the geometry only when
side chains are present. That is the next thing to find, and until it is found
Keep SSE with side chains showing rebuilds every frame - correct, and no faster
than not using it.

🔴 **AND THE FOURTH: EVERYTHING THAT IS NOT A RIB PRIM WAS DRAWN FROM A STALE
ROW.** The station table describes rib prims - the backbone, and now the base
plates. Everything else is a STICK: side chains, ligands, contacts, lone atoms.
Those rows sit after the ribbon in the concatenation and `drawResident` issues
them from the buffer exactly as they were built, which is right on the frame
they were built for and wrong on every frame after it.

Measured on `_traj_1tim.pdb` with 74 side chains showing, against the same frame
rebuilt: **1.53% of the frame, worst channel 226** - the side chains standing
still while the backbone moved.

The fix is to DECLINE, which is what `installStations` argued for in the first
place - "a path that quietly drops a whole class of geometry is worse than one
that declines" - and a stale row is the same fault as a dropped one. The path
now requires the table to cover the whole mesh, not a prefix of it.

**And that is cheap because the tail is normally empty**, which is only true
since the plates were fixed:

| | table covers | tail |
|---|--:|--:|
| `_traj_1tim.pdb` | 6927 of 6927 | 0 |
| `_traj_1ehz.pdb` (tRNA) | 1238 of 1238 | 0 |
| `_traj_unfold.pdb` | 1795 of 1795 | 0 |
| 1TIM with 74 side chains | 6927 of 9187 | **2260** |

So a trajectory of backbone - which is what this path exists for - is untouched
and still takes the fast path at 2.6x. The moment a side chain or a ligand is on
screen it is a rebuild per frame, correct and slow, until sticks get a table of
their own. tests/station_sidechains.py holds both halves: the picture must be
exact with side chains on, and the tail must stay empty without them, because a
rule this blunt is only acceptable while that is true.

🔴 **AND THE THIRD: BASE PLATES WERE NOT IN THE STATION TABLE AT ALL.** Reported
as "for dna/rna, the base pair plates should also move with the animation when
SSE is frozen", which is exactly what was happening - the backbone animated and
the base pairs stood still.

A base plate IS a rib prim - it says so in geom.js, `naRung: true`, "it IS a rib,
and is drawn as one" - so `stationMeshOf` walks it like any other. It then drops
it, because a prim with no `ub`/`wa`/`tv`/`half` is skipped. Those come from the
FRAME PROBE, and the frame probe lives in `evalSlab`, which a rung never reaches:
a rung's centre line is straight, so it has its own emitter with no Hermite step.
Measured on a tRNA: 153 ribbon prims, every one framed; **84 base plates, not one
of them framed**. All 84 fell into the tail that `drawResident` issues from the
build-frame rows.

Two things had to be added, and the second is the one that is easy to miss:

- the frame itself - and the offset direction, NOT the face normal. A station is
  `corner = mid +- wa * halfW +- ub * halfT` with ub a unit vector, and the
  rung's corners are built from `of`, which equals the face normal everywhere
  except the first station: there the joint with the backbone takes the
  thickness offset IN THE FACE PLANE, so `of` is shorter than unit. Emitting the
  face normal would square up an end that is deliberately oblique. Normalising
  `of` and scaling halfT by what was removed reproduces `of * th` exactly.
- **its own centre line.** A backbone piece finds its midpoints in the
  renderer's `_ribbonTrace`, indexed by `gs0`. A rung is not on that curve and
  has no entry in it, so it carries its own midpoints on the prim. They are in
  the same space as the frames, so both take the same `un()` - and note the
  trace has the view centre added back by `_storeRibbonTrace` while these never
  had it, which is why one is shifted by C and the other is not.

| `_traj_1ehz.pdb` | fast path vs the same frame rebuilt | cost |
|---|--:|--:|
| before | **2.4818%** of pixels, worst 224 | 8.50 ms against 3.50 (**0.37x** - slower) |
| after | 0.0002%, worst 33 | 2.60 ms against 4.90 (1.88x) |

It got FASTER as well as correct, and for the same reason: 84 prims moved out of
the second draw call and into the table.

🔴 **AND NO PROTEIN TRAJECTORY COULD HAVE CAUGHT IT.** station_integrated now
runs a nucleic arm. Note its own guard had to change too - it waited for
`coords.length > 30`, and a B-DNA duplex is 24 nucleotides, so on exactly the
structures the nucleic arm exists for the probe timed out rather than failing.

🔴 **AND THE SECOND ONE: THE OVERLAY DID NOT FOLLOW THE FAST PATH.** Reported as
"selection and orient seem broken with keep sse".

The selection halo, the sequence hover, click-picking and Orient's framing of a
selection all read `renderer.screenX/screenY`, which `projectPositions` writes
from `appPos` - a captured set of drawn positions in model space. `appPos` was
filled by the full rebuild and by the mesh-restore path, and **not** by the
station fast path. So under Keep SSE the picture was this frame's and the
overlay was the frame the mesh was built at, drifting further apart every step.

Measured on `_traj_1tim.pdb`, five steps in, against the same state rebuilt with
Keep SSE still on:

| | overlay drift | picker |
|---|--:|--:|
| before | **3.95 px in x, 4.41 px in y** | wrong at 6 of 62 points |
| after | 0.000 px | 0 |

The fix is three lines: `stationMeshNow` already runs a capture, so this frame's
positions are in its hand - they travel with the mesh and are committed on the
branch that took the step. `modelPositions` is now the one place that converts
them, instead of the rebuild doing it inline.

🔴 **AND NO GATE THAT COMPARES PICTURES COULD HAVE CAUGHT IT.** The mesh, the
fills and the outline were all correct throughout -
tests/station_integrated.py reads 0.0018% against a rebuild while this is
happening, because nothing about a stale overlay reaches a pixel the GPU draws.
It is in the arrays the app draws ON TOP. tests/station_overlay.py is the gate,
and it compares against **the same state rebuilt**, not against the plain path:
Keep SSE pins the secondary structure, a residue held as helix is smoothed onto
a different centre line from the same residue redrawn as coil, so the drawn
positions genuinely differ between the modes and always will. Against the plain
path this reads 1-9 px whether the bug is there or not.

🔴 **AND THE ANSWER, AFTER FIVE WRONG ONES, IS THAT THE TWO-TONE WAS BAKED AND
HAD TO BE COMPUTED.** Everything above chases the STABILITY of the sign. That
was the wrong question. The fault reported - "the outside of the helix becomes
light" - is not a sign that wobbles, it is a sign that is CORRECT AT FRAME 0 AND
NEVER ASKED AGAIN.

The two-tone colour, and the inner-shade multiplier beside it, are baked into
the instance row by facesOf. The station fast path never rewrites that row -
that is the whole point of it - so under Keep SSE the pale face stays on
whichever side frame 0 put it while the ribbon rolls out from under it. On
`_traj_unfold.pdb` the C-terminal helix is visibly pale on the OUTSIDE by frame
1. Every fix above made this worse, because every one of them froze the decision
harder; pinning aK to match the frozen colour made the two agree on the wrong
answer.

The fix is to bake CANDIDACY, which is topological, and decide per frame in the
shader, which is geometry:

- `colMode = 3` marks a broad face of an uncoloured Richardson helix. It holds
  for as long as the secondary structure does, which under Keep SSE is the whole
  trajectory.
- The vertex shader computes `twoNow` from THIS frame's aK and the face's top
  flag, and takes both the tint and the inner-shade multiplier off that one
  sign, so the two can never disagree again.
- The baked colour of a candidate stays UNTINTED, because the shader tints it.

Measured with tests/station_integrated.py, the fast path against a rebuild of
the same frame:

| | before | after |
|---|--:|--:|
| `_traj_1tim.pdb`, breathing | 0.0018% | 0.0018% |
| `_traj_unfold.pdb`, unfolding | **5.56%** | **0.0044%** |

🔴 **AND THE GATE COULD ALWAYS HAVE CAUGHT IT - IT WAS POINTED AT TOO GENTLE A
TRAJECTORY.** station_integrated compares the fast path against a rebuild of the
same frame, which is exactly the right question, and it ran only on a structure
that BREATHES. A stale per-piece decision does not show there: the concavities
barely move, so frame 0's answer stays right and the gate reads four decimal
places of agreement. It now runs on both, and the unfolding arm fails by 5.56%
against the shipped code of the previous commit.

🔴 **THE OSCILLATING-PIXEL COUNT BELOW IS NOT AN INSTRUMENT FOR THIS, AND
EVERYTHING MEASURED WITH IT SHOULD BE READ IN THAT LIGHT.** It counts pixels
that differ from both neighbouring frames while the neighbours agree, which is
the right definition. What it does NOT separate is a face changing SHADE from a
thin dark line MOVING: a one-pixel outline sliding half a pixel over a breathing
structure darkens and lightens a pixel exactly the same way.

The experiment that settles it: force every ribbon edge to draw, always, with no
silhouette test at all. If the count were dominated by draw decisions flickering,
removing every decision would collapse it. It goes the other way -

| | oscillating |
|---|--:|
| the shipped rules | 0.4171% |
| **every edge always drawn** | **0.6742%** |
| no outline at all | 0.1967% |

- so the outline's whole 0.22 pp contribution is ink MOVING, and more ink is
more of it. The count cannot see a decision flicker underneath that, and five
changes measured against it all came back "no change" for that reason rather
than because nothing changed.

**A per-decision flip count is the instrument** - `/tmp/kflip.py`'s 75 of 9,424
piece means crossing zero, or the equivalent for an edge. Pixels are the wrong
unit for a question about labels.

🔴 **AND IT IS NOT ONE CAUSE.** Turning things off one at a time, with Keep SSE
on and the fast path confirmed taken (8 of 8 frames, 0 rebuilt):

| | oscillating |
|---|--:|
| everything on | 0.4182% |
| outline off | 0.1972% |
| Richardson off | 0.3286% |

So the outline is about **half** of it, the Richardson two-tone about a fifth,
and a fifth remains with both off. These are independent per-frame sign tests -
the silhouette rule, the coincident-face cull, the crease angle, the two-tone's
`inward` - each on a geometric quantity that can sit near zero, none with any
hysteresis. They are computed identically on both paths, which is why both
measure the same.

🔴 **AND TWO PLAUSIBLE FIXES WERE MEASURED AND REJECTED.** The two-tone's `kAvg`
is a piece mean of `ub . k`; a helix twists about 100 degrees a residue, so the
face normal sweeps through the concavity direction and the mean is a small
residual - 75 of 9,424 cross zero over 15 frames, 11% sit within 0.05.

- **Widening the average** over neighbouring pieces makes it *worse*: 75
  crossings become 104 over three pieces and 118 over eight. Neighbouring
  pieces genuinely differ, so it is not a narrow window.
- **Hysteresis on the crossing** - hold a marginal flip until it is decisive -
  moved the oscillating pixels from 0.4182% to 0.4160%. Nothing. It was written
  and then removed rather than left in on the strength of the argument.

🔴 **AND THE CONTINUOUS SILHOUETTE WAS WRITTEN, MEASURED AND REVERTED.** The
principled repair for the outline half: `f0 != f1` is a sign test on
dot(normal, view), and the silhouette is BY DEFINITION where that dot is zero,
so the rule's input is exactly zero precisely where the rule is applied. The old
code answers yes or no and throws the quad off-screen for no, so a marginal edge
appears and vanishes at full width. Replaced with a weight that is 1 outside a
band either side of tangency and ramps to 0 through it, spent on the edge's
WIDTH - the context is created with `antialias: true`, so a sub-pixel width
resolves as partial coverage and the fade is real. The `usable` cut at 0.15,
which swaps one rule for the other mid-trajectory, became a ramp over 0.10-0.20
for the same reason.

| band | oscillating |
|---|--:|
| shipped (a step) | 0.4171% |
| +/- 3.5 degrees | 0.4124% |
| +/- 11 degrees | 0.4017% |
| +/- 30 degrees | 0.3855% |

Reverted. Not because the argument is wrong - it is the right shape, and it is
pixel-identical for every edge outside the band - but because the only
instrument that could speak to it is the one disqualified above, and a change to
the shipped outline needs better evidence than an argument. The diff is small
and this paragraph is enough to write it again against a decision-flip counter.

🔴 **AND FITTING THE HELIX AXIS INSTEAD IS TWICE AS BAD.** The obvious
principled repair - stop deciding inner-ness from a three-point second
difference, fit a line through seven CA positions and take the perpendicular
from the interval's midpoint to it - was written and measured on the same
trajectory:

| k from | pieces flipping sign over 15 frames |
|---|--:|
| the three-point second difference (shipped) | **75** of 9,424 |
| a PCA axis fit over 7 residues | **175** |

Oscillating pixels went 0.4153% to 0.4138% with the outline on and 0.1972% to
0.2083% with it off - which is to say nothing, in both directions. A window
wide enough to average the coordinate noise down is also wide enough to span a
bend, and then the fitted axis is the unstable quantity instead. Reverted.

Under Keep SSE the two-tone COLOUR cannot flicker at all: it is baked into the
instance row, which the fast path does not rebuild. Whatever oscillates is
computed in the shader from this frame's geometry, every frame, on both paths.

Fixing it is real rendering work on several independent decisions, with visible
consequences for the shipped drawing. `/tmp`-style probes are no use for it; the
instrument is the oscillation count above, and 0.415% is the number to beat.

### How it is switched on

**Keep SSE**, the button in the frame strip. The three settings move together on
purpose - pin the assignment, drop the orientation-fold cuts, take the station
path - because each is useless without the others: pinned with the cuts in, a
third of steps still rebuild; the cuts out without the pinning, the station count
follows the assignment and no step can reuse the table. Pressing it installs the
table, and any later rebuild rebuilds it, so nothing is driven by hand.

Off by default, and it has to be: pinning the assignment is a claim about the
data. On a folding trajectory it draws the first frame's helices on the last
frame's coordinates - 64% of residues assigned wrong, measured.

### 🔴 The face list is not purely topological, and that is the ceiling

`geom.js` cuts a piece at every **orientation fold** - where the face or width
normal crosses zero - so a cut moves when the geometry does. Keep SSE pins the
assignment and cannot pin that.

- With the fold cuts: 11 of 33 steps on 1TIM had to rebuild, 8 of 33 on 3CHY.
- Without them: **0 of 33**, and the step goes 5.80 → 4.00 ms.

Dropping them costs nothing on the GPU, measured rather than argued: the cuts
exist so a *painter* can sort pieces by depth, and a depth buffer resolves that
per fragment. 1UBQ 201 pieces → 196, 1TIM 1478 → 1454, ink unchanged to two
decimals, **0.0000% of pixels moved, worst 1 and 2** - the antialiasing least
significant bit. The outline survives because a piece boundary that is not a
geometric edge produces two coincident faces, and the silhouette rule needs one
facing the eye and one not.

🔴 **And the counts agreeing is not the mapping agreeing.** A cut can move from
one station to another leaving the piece and station counts identical - frames 4
and 5 of the 1TIM trajectory do - while the instance buffer still says face *f*
reads station *k*. It draws a plausible ribbon made of the wrong slices: 7.5% of
pixels, worst 216, with every count matching. `updateStations` compares the
whole mapping.

### The outline moves with it

It did not, at first, and that was the whole of the remainder: **5.4% of pixels
at worst 224 with outlines on, against 0.0002% at worst 31 with them off** - a
contrast that identified the cause rather than leaving it to be guessed at.

An edge instance is twelve floats of geometry: two endpoints and the two
adjacent faces' normals, all in model space. An endpoint is already an identity
in the edge pass - `oa` is `fi*12 + corner*3` - and the two faces are what its
normals are, so the edge pass records six integers a row and
`refreshEdgesFromStations` rewrites the twelve floats without running the hash,
the adjacency or the crease test again. Refreshed against the mesh it was built
from, it reproduces those floats to **3.7e-06 A** - the same round-trip
precision as the fill.

Three things had to be right and only the first was obvious:

- **The outward normal is not the shading normal.** A broad face's two sides
  share one `ub` and are told apart by the `top` flag. Every position matched to
  3.7e-06 A with half the normals pointing into the solid, which is why the
  self-check had to cover the normals too.
- **The crease class is redone, the boundary class is not.** A boundary is
  topological - fewer than two incident faces; a crease is an angle, and frozen
  at the build frame it draws a line where the surfaces have since flattened. On
  a constant-fold trajectory it turns out **no edge changes class** (measured, 0
  of 6292), so this bought nothing here and is there for the case where it does.
- **The radius is the farthest CORNER, not the farthest centroid component.**
  `buildMeshPart` takes `max sqrt(x^2+y^2+z^2)` over the corners; a max of
  `|component|` over the centroids is a different, smaller number, and it feeds
  the focal length and the depth range. That one line was **0.0624% of the
  pixels down to 0.0018%**.

### What it does not do yet

**Anything that is not a rib prim** is drawn from its rows, in a second pass.
Base plates, ligands, contacts and lone atoms have no station behind them, and
`makeResident` concatenates them after the ribbon - so the ribbon is instances
`[0, count)` and the rest is `[count, resident.count)`. Refusing on any mismatch
was the first cut and it was far too brittle: on a 10,000-residue chain it cost
the whole path for **one face**, 139,622 described against 139,623 held. 1AOI -
protein, DNA and base plates - now draws through it at **0.0002% of pixels
moved, worst 13**.

The two programs are kept in step by `mirrorUniforms`, which enumerates the
source program's active uniforms and copies each one, rather than by a second
hand-written list. There have already been two of those in this file, and both
drifted.

### Traps this cost (all four found by a gate, none by reading)

- **The capture reads the previous frame.** `captureFrom` runs the 2D renderer,
  which is built on `rotatedCoords`, and the renderer skips its rotation loop
  whenever it expects the GPU to take the frame. 8.6% of pixels, stable to four
  digits across runs - which is what said it was not noise.
- **Two captures, two conventions.** A hand-rolled capture skips the GPU
  thickness floors `captureFrom` applies. Installed one way and updated the
  other: 8.6% of pixels at worst 224.
- **The mesh's bounds stay behind.** `shadeRange` maps depth to shading off
  `resident.centroids`, and its cache keys on the rotation and the face count -
  neither of which moves when a trajectory steps.
- **A rebuild leaves the table describing the mesh it replaced**, and drawing
  from it puts the right flags and colours on the previous frame's geometry:
  18.8% of pixels.
- **GLSL comments containing backticks**, twice, inside the JS template literal
  that carries the shader. It ends the string, and the failure arrives as
  "Unexpected identifier" pointing at a word in a comment.
- **`tools/bundle.py` only strips shader literals that announce themselves**, so
  a GLSL block holding no `uniform`, `void main` or `#version` shipped twenty
  commented lines - and then the substitution that builds the station shader
  matched nothing in that same bundle, because its patterns included the
  comments the stripper had just removed. The painter threw at load in the built
  artefact while every source-loaded probe stayed green. `tests/bundles.js` is
  the only thing that could have seen either.

## Rebuilds that were not needed, and the five gates that now say so

A sweep for work the renderer was doing twice. Each finding is small on its own
and they share one shape: something that is not geometry sitting in a key that
means geometry, or a caller asking for a frame that was already coming.

| what | was | is |
|---|--:|--:|
| sheetFlat drag, 8 steps, single structure | 8 rebuilds | **0** |
| thickness drag, 8 steps | 8 | **2** (both stickLodFlat crossings) |
| outline on, then off | 2 rebuilds | **1** (only on owes it) |
| a tRNA, every control and every frame | rebuild | **fast path** |
| coming back to a picture already built | rebuild | **restored** |
| one side-chain click | 2 renders | **1** |
| sheetFlat drag on 1AOI | 173.9 ms | **117.7** |

**The orientation-fold cuts are for a painter that sorts.** geom.js cuts a
piece wherever the face or width normal crosses zero, so the 2D painter can
give each piece an honest depth key. A depth buffer needs none of it, and the
cuts move when the structure does - which is what stopped a slider or a frame
reusing its face list. Dropped inside `captureFrom`, so they reach the mesh and
nothing else: the 2D painter keeps them, which it must, being a painter that
sorts. Costs 0.0000%-0.0327% of the frame depending on structure - see
`tests/station_foldcuts.py`, which measures the same-build floor beside it
because one structure alone says 0.0000% and invites the wrong conclusion.

**Nine ions took the fast path away from a whole tRNA.** `makeResident` splits
the mesh into the ribbon, the things that hold still, and the side chains, and
the station table has to describe part 0 EXACTLY. The split asked "is this a
stick?", and a lone atom's disc is neither a stick nor the ribbon, so six
magnesiums and three manganeses landed in part 0 and `refreshSticksFrom`
declined for the whole structure. `faceGroup()` is now one rule in one place -
it was two, and fixing only the first moved the decline from one line to the
other without changing a thing.

**Three sets were keyed by identity.** The hidden backbone, the shown bases and
the element colours used `idOf()`, and the app builds a NEW Set with the same
members whenever the drawn set changes - so an identical picture threw the
spare mesh away. Already found and fixed twice before, for the visibility mask
and the colour array; two of the three carried a comment saying "by identity,
like the visibility mask" long after the mask had been moved off identity for
this exact reason. `idOf` is deleted, with a note where it was.

**reloadDrawn() renders unless told not to**, so "reload, then render" draws
twice. Five callers, including `_setSidechains`. The mesh was built only once -
the second render reused it - so no rebuild counter could see this, and it
needed its own question.

**A control that changes the LOOK must not drop the segment cache.**
`_invalidateSegmentCache` throws away which residues form segments, the cyclic
chains, the SS assignment and the base pairing; its key is object, frame, count
and overlay, and mentions the look nowhere. The sheet-flat slider called it
anyway ("strand geometry changes, so cached segment geometry is stale" - the
first half true, the second not following) and so did the arrows checkbox. On
1AOI: 173.9 ms against 117.7 for a drag, 418.6 against 377.8 for eight arrow
toggles, both pictures identical to the last channel.

### What was measured and deliberately left alone

- **The remaining sliders render synchronously, one draw per input event.**
  Eight uniform changes on 1AOI cost 16.7 ms in total, about 2 ms each: a
  uniform draws from the resident mesh and captures nothing. Coalescing them
  buys nothing.
- **Loading is already clean**: one build for the first structure, none for the
  style switch, one for the second, none idle.
- **The TUBE path is clean.** Every measurement above is in cartoon, so the
  same survey was run in tube style: rotate, zoom, select, hover, shade,
  outline on and off, fade, smooth, highlight, pencil, both clips and ortho all
  cost **0 tube builds**. Side chains cost 1 each, which is geometry, and a
  colour change costs 1, which is by design - a tube instance carries its own
  colour, so there is no palette texture to repaint instead and a recolour is a
  rebuilt buffer either way (see `tubeKeyOf`). Not added to the suite: a second
  style doubles the runtime of a survey that found nothing.
- **The segment cache has the mesh's old shape and is not worth fixing.** One
  slot, keyed on the coords array by identity, so alternating always misses -
  and it misses on every side-chain toggle. It costs 0.7-2.3 ms at 2,267
  positions. The expensive half, the SS assignment at 7.4 ms per 1,103
  positions, is already spared: it lives inside the capture, so a frame that
  restores its mesh never runs it. A second slot would be a staleness risk
  taken for a millisecond.
- **The side-chain toggle already reuses the ribbon part.** It looked like it
  did not, twice, and both times the probe was at fault - the row before it had
  changed a build PARAMETER, which is in `ribbonHashOf`. Order matters in these
  files, which is now the third time that has been true here.

### The gates

| file | question |
|---|---|
| `topology_survey.py` | does this control move the piece, station and face counts? |
| `station_controls.py` | does the station path draw what a rebuild draws, per control? |
| `rebuild_actions.py` | what does a session - turn, zoom, select, toggle - cost in rebuilds? |
| `rebuild_returns.py` | is a picture already built handed back? |
| `render_counts.py` | one action, one render? |

🔴 **AND `stationDecline()` IS WHY THEY ARE USEFUL.** `stationRefusal` and
`lastStationUpdate` are both written and then CLEARED by the rebuild they
explain - `installStations` sets the first to null on its way through - so a
probe reading them afterwards sees null and concludes nothing happened. An hour
went into a nucleic structure whose every reason came back empty; the answer
was a mesh that was never built. `stationDecline()` is set once per decline and
cleared once per frame by the only writer that may, and names all seven ways.
Read it in the same tick as the frame you are asking about: the next render
clears it.


## The per-event and per-frame work, on a structure big enough to notice

The sweep above was about mesh REBUILDS. This one is about the two things that
happen far more often than a rebuild - a mouse move and a drawn frame - and
both of them were walking the whole structure. Measured on 1M4X, a capsid of
2,081,520 positions, which the app draws as a tube.

| | was | is |
|---|--:|--:|
| 100 mousemove events over the structure | 3,897 ms | **34.6 ms** |
| one hover pick | 44.3 ms | **0.366 ms** |
| rotating with five residues selected | 70.87 ms a frame | **5.52 ms** |
| rotating with nothing selected | 0.13 ms a frame | unchanged |

**Picking was a scan of every segment and every position**, run on every mouse
move to keep the sequence panel's hover readout current - a readout the handler
then discards unchanged, since it only acts when the picked residue CHANGES.
`_pickIndex` is a uniform grid over the canvas with each item inserted into
every cell its own pick radius reaches, so a query is one cell lookup.

🔴 **AND IT IS EARNED BY THE SECOND PICK OF A PROJECTION.** The index is keyed
on `screenFrameId`, which bumps on every drawn frame, and building it walks the
structure: 146 ms on the capsid against 44 ms for the scan. Hovering while the
view auto-rotates gives exactly one pick per projection, so an unconditional
index would build, use it once and throw it away - three times slower than
before. `tests/pick_index.py` asserts 0 builds while the view moves and 1 while
it is still, as well as answering identically to the scan at every one of
10,800 points.

**The selection halo projected everything to place a handful of marks.**
`_projectMarks` does the same arithmetic - through the shared `_rotateAt` and
`_projectAt`, so there is no second copy - for the marks alone, and leaves
`_pickPending` and `_rotPending` standing so a later CLICK still gets the whole
structure projected. A frame pays for the marks; a click pays for the
structure.

🔴 **ONLY THE TUBE PATH WAS PAYING IT.** The GPU tube frame leaves an IOU
rather than a projection; the cartoon path projects inside paintgl as part of
drawing. The first version of `tests/halo_partial.py` ran in cartoon style and
reported "mark projections 0" on every structure, which is the gate working and
a fact about the two paths worth having before believing any number here.

### Measured and left alone, again

- **The cartoon path's own per-frame projection.** `projectPositions` walks
  every position on every cartoon frame, but the app picks tube above
  LARGE_MOLECULE_CUTOFF, so cartoon is bounded to about a thousand segments in
  practice: 9FOG at 3,559 positions is 0.74 ms a frame with nothing selected
  and 0.46 with a selection.
- **Playback.** On a 5,000-residue, 20-frame trajectory in tube style: a redraw
  is 0.36 ms with zero rebuilds of anything, and a frame step is 6.68 ms of
  which 1.4 ms is the segment list. A frame change genuinely needs new
  coordinates and a new instance buffer.
- **A rotation drag with nothing selected** does 0 rotations, 0 projections, 0
  captures and 0 builds, at 0.13-0.46 ms a frame. The GPU path is model space
  with the camera in a uniform, and it behaves like it.


## Loading a capsid: 14.4 seconds to 11.6

1M4X is 960 KB of CIF that the biological assembly expands to 2,081,520
positions. Profiling the load (Profiler.start around processFiles, self time by
function) found three things doing work twice or doing it per position, and two
that looked like findings and were not.

| | was | is |
|---|--:|--:|
| load, end to end | 14,343 / 14,465 ms | **11,496 / 11,642 / 12,127** |
| sequence-panel entries materialised | 4,163,040 | **2,081,520** |
| `_composeAndApplyMask` | 599 ms | **0** |
| `primed` | 651 ms | **142** |
| garbage collector | 2,530 ms | out of the top twenty |

**The sequence panel built itself twice.** `checkFrameChange` calls
buildSequenceView directly while buildSequenceViewDeferred has queued one, and
the queued build then rebuilds the identical view. A direct build cancels the
pending one now - which first required storing the INNER animation-frame handle,
since the deferred build was a nested pair with only the outer id kept and
nothing could cancel it once the outer had fired.

**A set naming every position, built to mean "all of them".**
`_composeAndApplyMask` already knows that null is everything and is worth
reaching; it reached it by building two 2,081,520-entry sets first, because
`setVisibility` normalises default mode by filling `positions` with every
index, so an untouched object arrives at `_visibleForObject` with a full set.
That function answers null now where the record already covers the span, and
answers before building anything. An overlay deliberately does not take the
exit: `positions` is in frame 0's numbering while the span covers every frame.

**A regex per atom name.** `primed` normalises the PDB v2 asterisk spelling
(C1* against C1'), is called several times per atom while the side-chain table
is built, and `String.replace` allocates and scans whether or not there is
anything to replace. `indexOf` first.

### The two that were not findings

- **The sequence panel's SORT.** A comparison sort with a string comparator
  over two million objects, and the obvious culprit. 176 ms of a 14-second
  load. Measuring it first is what avoided a day's care for nothing - and its
  entry COUNT is what identified the double build.
- **`getAllValidColorModes`.** 208 ms, called about two million times. Two ways
  to make it cheaper measured 537 ms and 318 ms - the module-scope frozen list
  is slower per call than letting V8 allocate two small literals, and hoisting
  it out of the string test made it run where no spec exists at all. Reverted
  to exactly what it was, with the numbers written above it.

🔴 **A WHOLE-LOAD MEDIAN OF THREE CANNOT SEE 200 MS IN 12 SECONDS.** The spread
between three runs is ~160 ms, and a median of three said the colour-modes
change had HELPED by 194 ms while the profile said it was three times worse.
Time the suspect, not the session.


## Partial rebuilds: what already exists, what pays, and what does not

Asked directly: can a frame be PARTLY rebuilt, as a hybrid for when Keep SSE is
off? Three kinds of partial rebuild already exist -

- **per part.** `makeResident` splits the mesh into the ribbon, the things that
  hold still (ligands, base plates, contacts, lone atoms) and the side chains,
  each kept against a hash of its own faces. A side-chain toggle reuses the
  ribbon's 1019 faces and rebuilds 114.
- **the tail in place.** `refreshSticksFrom` rewrites parts 1 and 2 over their
  recorded spans while the ribbon is updated from stations.
- **the ribbon in place.** The station table, which is what Keep SSE builds.

**What the hybrid needed was not more machinery but less asking.** Keep SSE does
two things: it builds the table, and it PINS the secondary structure. The pin is
a claim about the data and can be wrong; the table is a claim about nothing,
because `stationsMatch` compares the whole face-to-station and face-to-piece
mapping and declines exactly when it must. So the table is on for any object
with more than one frame:

    _traj_1tim.pdb    17.26 ms a step -> 13.45   (14 of 29 steps take it)
    _traj_unfold.pdb   3.88 ms        ->  2.63   (23 of 29)
    _traj_1ehz.pdb     5.63 ms        ->  2.94   (7 of 7)

Keep SSE still buys the rest - 4.10, 1.26, 2.16 ms - by making every step take
it. A nucleic trajectory never moves its assignment, so it gets the whole
benefit with none of the promise.

### Why not rebuild only the pieces that changed

Measured per piece, consecutive frames, pin off, on 1TIM:

| steps | changed pieces of ~1454 | |
|---|---|---|
| 17 of 29 | 0 | nothing to do - these are the ones now taken |
| 6 | 4-7 | 0.28-0.62% |
| 4 | 32-55 | 2.3-3.9% |
| 2 | 127-149 | 9-10.75% |

Few, and **scattered**: the two big steps change pieces spanning [115..1451] and
[115..1455], which is 92% of the buffer. The instance buffer is a flat
concatenation, so "rebuild from the first changed piece to the end" rebuilds
almost all of it, and a scattered per-piece update needs the piece-to-row
mapping to be stable - which is precisely what is not stable when the station
counts move (3177/1452 against 3183/1456). Per-piece slack in the buffer would
buy it, at the cost of a layout that every consumer of the row spans would have
to learn.

🔴 **AND `setFrame` DREW EVERY FRAME TWICE**, which was worth more than any of
this and was found while chasing it. `_composeAndApplyMask` renders unless told
not to, and it was being handed the caller's skipRender rather than `true` - so
"render once unless skipped" was two renders per step of every animation. It
also cleared `stationDecline` between the rebuild and the read, so every
declining step reported "no reason recorded" and the measurement above was
impossible until it was fixed.


## What a rebuild is made of, and whether a PARTIAL one is possible

Asked directly: can a build be partly reused rather than redone? Measured on
_traj_1tim.pdb, 494 positions, 6,919 ribbon faces, medians of eight rebuilds:

| phase | ms | |
|---|--:|---|
| capture (the 2D pass harvesting prims) | 9.2 | 49% |
| facesOf | 1.2 | |
| buildMeshPart: rails, pieceFrames, normals, facesAndEmit | 3.9 | |
| **buildMeshPart: edges (weld, adjacency, crease)** | **5.9** | **32%** |
| buffers, end | 0.1 | |
| **total** | **18.7** | |

The capture must run - the coordinates are new. The EDGE pass is the reusable
one: which faces share an edge and which edges are creases is a property of the
TOPOLOGY, not of where the atoms are, and the fast path already relies on that
(`refreshEdgesFromStations` rewrites edge coordinates without redoing the
adjacency, and says so).

🔴 **AND THE CHANGES ARE LOCAL, WHICH I FIRST GOT WRONG.** Comparing per-piece
station counts INDEX BY INDEX says an insertion early in the chain changes
everything after it, and that reads as "scattered across 92% of the buffer" -
which is a fact about numbering, not about the mesh. As a common prefix and
suffix, over 29 steps of 1TIM with the pin off:

| steps | edit |
|---|---|
| 17 | nothing at all |
| 7 | one window of 0.14%-0.48% of pieces (`at 991: 7 -> 3`) |
| 5 | a wide window, because TWO distant places changed and it spans between |

So a partial rebuild is possible in principle: diff the piece shapes into runs,
rebuild the changed pieces, and shift the unchanged tail - whose rows carry
station INDICES, so a shift is one integer per row rather than a rebuild. Seven
of 29 steps need a single window; all twelve need a proper multi-run diff.

### Hysteresis on the assignment: measured, and it does not work

The declines are caused by very little movement - 38 letter changes over 30
frames, 1.3 a step of 494, and only 19 positions ever change at all, 11 of
which end on the letter they started with. That looks like flicker worth
damping, and it is not:

| rule | steps with an identical assignment | frames whose picture would change |
|---|---|---|
| today | 14 of 29 | - |
| hold a new letter 2 frames | 15 | 15 of 30 |
| hold 3 frames | 16 | 24 of 30 |

One or two steps bought, for a different picture on half to four-fifths of the
frames. Delaying a change does not make consecutive assignments equal; it moves
when they differ. Not done, and written down so the idea is not had twice.


## A partial rebuild: the arithmetic is validated, the window rule is the finding

Prototyped offline before touching the renderer. For each step of
_traj_1tim.pdb with the pin off, take the previous frame's station rows, splice
in the new frame's rows for the changed window, shift the tail's station and
piece indices, and compare the result with the rows a full rebuild produces -
float by float, all 18 columns times ~6,900 rows.

**It works** - on that frame. The head/window/tail decomposition is real and
frame 7 is head 6686, window 9, tail 249 of 6944 rows.

🔴 **AND OVER A WHOLE TRAJECTORY THE WINDOWS ARE NOT SMALL, WHICH THAT ONE
FRAME HID.** Measured later with `tests/splice_window.py`, which computes the
same decomposition on every declining step:

    _traj_1tim.pdb, 15 declining steps, window as a share of 6,930 faces
    0, 0, 0.1%, 0.1%, 0.2%, 0.2%, 6.4%, 7.9%, 9.5%, 16%, 29%, 61%, 65%, 82%

    _traj_9fog.pdb, 10 declining steps, of 46,463 faces
    64%, 74%, 74%, 74%, 87%, 88%, 93%, 96%, 96%, 96%

A step moves SEVERAL runs at once - a median 16 of ~579 on 9FOG - scattered
along the chain, and each shifts the indices after it by its own amount. One
window therefore swallows everything between the first and last change. The
splice below is sound; it is the SHAPE of the change that is not one window.
See the section at the end of this file for what the piecewise version needs.

🔴 **COLUMN 6 IS EXCLUDED FROM THE COMPARISON, AND THAT IS SOUND.** It is
fill[q+36] = aFlags0.x = aK, the piece concavity, and the station shader does
not read it: buildFromStations assigns `aKFresh = pcTexel(aPiece, 0).w` and
rewrites `float aK = aKFresh`, precisely because the row's copy is the install
frame's while every normal beside it is this frame's. It differs on ~6,300 rows
a step and cannot reach a pixel on this path.

🔴 **AND THE WINDOW MUST FOLLOW THE SS RUNS, NOT A MARGIN IN PIECES.** With the
window widened to whole pieces plus a fixed pad:

    pad 0 pieces    16 of 28 steps exact
    pad 2           19
    pad 4           27
    pad 8           28
    pad 16          28

Eight looks like an answer and is not. The columns that still differ at pad 2
are `sheet` (aFlags1.z), `colour mode` (aFlags2.y), `residue` (aFlags1.w) and
the face colour (fill[33..35]) - every one of them a consequence of the
SECONDARY STRUCTURE assignment. A letter changing at one residue changes the
sheet flag and the colour of the whole RUN it belongs to, and a helix is 10-20
residues where a piece is a fraction of one. pad 8 satisfied that by luck on
this trajectory.

So the rule is: diff the assignment (494 letters, cheap), expand each changed
position to its whole run, map the runs to piece ranges, and rebuild those.

### What is left, and why it is not done here

The splice proves the ARITHMETIC. The saving needs the other half - emitting
faces for a piece subset - which buildMeshPart is not factored for, and whose
edge pass welds across piece boundaries so a subset needs one piece of context
either side and a face-index fixup for every edge after the window. That is a
large change to the most intricate code here, and its failure mode is a
plausible ribbon made of the wrong slices.

### The arithmetic, after the double capture was removed

Doing this sum is what found the double capture, which was worth more than the
partial rebuild and cost a fraction of the effort. _traj_1tim.pdb, 29 steps,
14 of which take the fast path unpinned and 15 of which rebuild:

    a capture                        5.57 ms   (of which the SS assignment 2.41)
    facesOf + buildMeshPart          9.5
    a fast step    = capture + stations + draw          ~6.6
    a rebuild step = capture + faces + build + draw    ~15.1
    average = (14 x 6.6 + 15 x 15.1) / 29             = 11.0   (measured 11.02)

A perfect partial rebuild turns a rebuild step into a fast step plus the
window, so ~7.0:

    average = (14 x 6.6 + 15 x 7.0) / 29              = 6.8

| | ms a step | what is left |
|---|--:|---|
| unpinned today | 11.0 | |
| + a partial rebuild | ~6.8 | the SS assignment, 2.4 |
| pinned (Keep SSE) | ~4.2 | |

So it is worth about 4 ms a step, 38%, on this trajectory - and the remaining
gap to Keep SSE is the assignment, which the pin avoids by asserting it does
not change.

🔴 **AND IT IS WORTH NOTHING ON THE OTHER TWO.** _traj_unfold.pdb is 2.36 ms a
step unpinned against 1.69 pinned - a 0.67 ms gap in total - and _traj_1ehz.pdb
takes the fast path on 7 of 7 steps already, so there are no declining steps to
make cheaper. The value is concentrated on structures whose secondary structure
moves often, which is the case the pin is wrong for.


## One capture a step, taken or declined

A capture runs the whole 2D pass to harvest prims, and it is the most expensive
thing in a step - more so unpinned, where it re-derives the segment list and the
secondary structure inside it. A declining step was paying for three, all
describing the same frame: the mapping comparison, the rebuild, and the table
reinstall afterwards.

    captures over 29 steps   59  ->  29
    capture                7.88 ms a step  ->  5.57
    a step                13.09 ms         ->  11.02

The third had a comment saying it "costs a second capture, on the path that was
already the slow one - and there are none of those in a trajectory once the
topology holds". True while the table only existed under Keep SSE, where the
topology does hold; false the moment a trajectory started getting the table
unpinned, where 15 of 29 steps decline.

`heldCapture` carries the first to the second and is dropped the instant the
fast path succeeds - the prims are the largest thing a frame allocates - and
cleared at the top of every frame so it can never describe a frame that is over.
The third takes the mesh the first already built; the frame that INSTALLS the
table has no such mesh, so it builds one from the rebuild's own prims before
facesOf(consume) nulls them.


## Two panels doing a frame's work with nothing new to say

Both found by a sampling profile of a trajectory being stepped
(`tests/anim_profile.py`), and both the same shape: a guard that could not fire.

**The heatmap.** `setMaps` returns early on a set it already holds, but the test
needs an ENTRY to compare identities with, and an empty set has none. Most
structures carry no PAE and no contact map, so on most structures the guard
never fired: every frame step ran `_selectMap`, `_loadMatrix(null)` and a full
relayout - which reads `clientWidth`, a forced layout, and assigns
`canvas.width`, a reallocation and a clear - for a panel that is not on screen.

    _traj_1tim.pdb, 30 steps    60 relayouts, 60 selects, 60 loads, 0.23 ms a step
    with the empty-set guard     0, 0, 0

Sixty over thirty because `setFrame` asks twice, from `_loadFrameData` and from
its own end. The duplicate is left standing - with the guard it is free.

**The sequence strip**, which is worse, because its guard had never fired at
all. The four lines that clear the cache ran ABOVE the test, and one of them
nulls `sequenceCanvasData` - the first half of the test's own condition. So
every call rebuilt from nothing: a new canvas, a new layout, every cell
re-measured, the scroll position lost. It could not have worked where it stood
in any case, `innerHTML = ''` having already removed the canvas it would keep.
And the key included the FRAME NUMBER, so even alive it would have rebuilt on
every step of a trajectory to draw letter for letter the strip it replaced.

    _traj_1tim.pdb, 494 residues, 30 steps    1.29 ms a step, 30 rebuilds
    keyed on content, clear moved after       0.25 ms,         0

🔴 **AND THE WIDTH IS PART OF THE KEY, WHICH THE DEAD GUARD WAS HIDING.** The
layout divides the container's width into characters per line, so the same
letters in a narrower box are a different strip - and while the guard was dead
every resize rebuilt by accident. With it alive and the width missing,
`tests/mobile_layout.py` fails at 0.78x, 1.40x and 2.57x horizontal stretch: the
old bitmap across the new box. A dead guard hides every input nobody put in its
key, and turning one back on is where they all arrive at once.

`tests/panel_idle.py` gates both, each arm falsified by putting the fault back.

### Memoising the GL uniform locations: measured, and worth nothing

`src/cartoon/paintgl.js` looks up 62 uniform and 33 attribute locations by NAME
on every cartoon frame (51 and 8 on a tube one), and a location cannot move for
the life of a linked program. A `WeakMap` keyed on the program takes both counts
to zero. It buys nothing:

    1UBQ, 1500 renders, alternated    memo 0.775, 0.786, 0.738 ms a frame
                                      base 0.758, 0.771, 0.749

The memoised arm is a hair SLOWER at the median, which is drift; the honest
reading is that Chrome's own WebGL layer already answers these for free. Not
kept.

🔴 **AND THE 8.8% THAT SENT ME LOOKING WAS A 68-SAMPLE PROFILE.** `(program)`
was 92% of the samples in the same run. A share of a profile that short is not
a measurement - take the count if the count is the claim, and time the arms
interleaved if the time is.


## A cartoon load: 526 ms to 306, and none of it was the parser

Measured on 1AOI (1103 residues) with a CPU profile of `processFiles` through
to the first drawn frame, arms alternated three times each. Three findings,
all of them work done at a size or a moment that nothing could see.

| | ms |
|---|--:|
| before | 526.2, 536.7, 513.4 |
| one settle per batch | 437.7, 440.5, 440.1 |
| + no draw at a provisional size | 333.6, 337.4, 343.2 |
| + the shader queries batched | 314.2, 304.8, 310.3 |

**Two settle draws for one file.** `_switchToObject` holds every render until
the next animation frame and then draws once - "one draw per switch". A load
makes TWO switches, `addObject`'s and the one `applyPendingObjects` makes for
the object it decided to show, so two callbacks were queued, both fired in the
same frame, and the first painted a complete picture the second overwrote. One
settle per batch; the tail is re-bound so the focus recall belongs to the last
switch and reads that switch's own `mergedMask` - a closure and not saved
arguments, because `mergedMask` is declared below the point where the settle is
armed.

**And the canvas it painted into was 100x100.** index.html keeps the viewer
inside a `display: none` parent until a structure arrives, so viewport.js sizes
the canvas from `config.display.size` and marks it `__viewportProvisional`.
`renderApp` has declined that canvas since it was written - "do not build a mesh
for a size nobody chose" - which left the 2D painter drawing the whole structure
there instead, at a seventh of the final width, discarded one frame later. The
same rule now holds `render()` itself. Only index.html sets the flag (`cssSized`
is opt-in markup), so an embed and the notebook still draw.

**And initGL asked each shader whether it had compiled before making the next
one.** `getShaderParameter(COMPILE_STATUS)` and `getProgramParameter(LINK_STATUS)`
are the calls that make a driver finish before answering, so eight programs that
could have compiled at once compiled in turn. Linked first, asked at the end. It
also improved the error: the shaders are kept per program, so a failure names
the program and which of its two shaders, with the driver's log.

🔴 **9FOG IS 238 -> 230 ms AND THAT IS NOT A DISAPPOINTMENT.** At 3,559 residues
the page picks tube, which was never the expensive path. The win is the cartoon
one, and it grows with the residue count for exactly the reason the waste did.

### The trap that cost four runs

An edit that provably reached the server and provably was not in the page. The
cause is not the module cache the top of this file warns about: **a probe that
raises never reaches its `chrome.kill()`, and the orphaned browser goes on
listening on its debugging port.** The next run's Popen cannot bind it,
`/json/list` answers from the OLD browser, and `Page.navigate` drives that one -
same URL, same server, and a cache filled before the edit. A `fetch()` from
inside that very page returned the new text, which is what made it so confusing.

`cdp.launch` now `pkill`s on the profile directory before starting, which is
unique per probe and so touches nothing else.

### The H-bond search, and why the grid will not give more

`assignSecondaryOpen`'s hydrogen-bond pass is the assignment, and the
assignment is 13% of a trajectory step on a 3,348-residue structure. It took a
`Math.sqrt` to REJECT a pair: the grid is 9 A cells over 27 of them, a 27 A box
against a 5.5 A bond, so nearly every candidate fails that first test and each
was paying a root to find out. Squared comparison, root only for survivors.

    _traj_9fog.pdb, alternated, two runs each
    H-bond pass   12.65, 12.16 ms a step  ->  10.73, 9.69
    assignment    15.92, 15.72            ->  13.90, 13.09

Byte-identical: the SS digest is unchanged on 1UBQ, 3CHY, 1AOI, 1EHZ and 2POR.
And worth nothing below about a thousand residues - 1AOI 8.03 -> 7.80 ms, 2POR
2.77 -> 2.83, both drift. The win is in the candidate COUNT.

🔴 **AND THE OBVIOUS NEXT STEP DOES NOT PAY, SO DO NOT SPEND A SESSION ON IT.**
An H-bond needs CA-CA within about 9.4 A - 2.4 from a carbonyl O to its own CA,
5.5 across the bond, 1.5 from the amide N to its CA - so whatever the cell size,
the neighbourhood must cover that. The candidate box is 28.2 A a side at 9 A
cells, 23.5 at 4.7 with a 5x5x5 scan, 21.9 at 3.13 with 7x7x7, against a floor
of 18.8 for the true sphere: at most 2.4x, for a rising per-cell cost, and every
one of those is a change to WHICH PAIRS ARE CONSIDERED and so to the answer.
Pruning whole cells by distance does nothing at all - with 9 A cells the far
corner cell's nearest point is 7.8 A away, inside any bound that is safe.

### Measured and left alone in this pass

- **A recolour.** 0.37 ms at 1,103 residues and 4.59 ms at 29,220 (`_colorForMode`
  31%, `resolveColorHierarchy` 13%, `getAtomColor` 11%). It is a click, not a
  frame. `hexToRgb` parses three substrings per position and looked like an easy
  memo; at the size where it would matter the colour modes that dominate do not
  call it.
- **A style switch.** 0.20 ms - the mesh for both styles is already kept.
- **Rotating.** 0.14 ms a frame on 1AOI.
- **An idle page.** Zero renders and zero of every counter over three seconds.
- **The sequence strip's entries.** 494 objects a step on 1TIM and 3,348 on
  9FOG, built only to be hashed - but 0.26 and 1.05 ms a step, against 20 and
  123. A two-phase pass that hashes the frame arrays without materialising the
  entries would remove it; it is not worth the restructure at these numbers.


## Sizing the partial rebuild properly, and what it is really worth

The previous note said the partial rebuild is worth 38% on _traj_1tim.pdb and
"nothing on the other two". Both halves are still true and the conclusion drawn
from them was too narrow: the two others were _traj_unfold.pdb and
_traj_1ehz.pdb, and neither is the case the feature exists for. On
_traj_9fog.pdb, forced to cartoon, a step is 124 ms and EVERY step rebuilds.

    step cost, split by which path it took (tests/station_frames.py's question,
    measured per step)

    _traj_1tim.pdb   fast path   14 steps    7.23 ms   capture 3.94, ss 1.87
                     rebuild     16 steps   21.41 ms   capture 5.89, ss 2.70
    _traj_9fog.pdb   rebuild     30 steps  123.89 ms   capture 36.33, ss 12.67

Why 9FOG never takes the fast path, from `stationDecline()` over the eleven
steps before the automatic table gives up: **nine of eleven are "the station
mapping moved"**, seven of those being the station and piece COUNTS (20963/9402
against 20969/9404) and two a single face sliding between neighbouring stations.
One is the segment count flickering 3336 -> 3337, and one is the first step,
which has no previous key.

So the blocker is the secondary-structure assignment drifting - and the drift is
tiny:

    _traj_9fog.pdb, per step: median 22 of 3,348 letters change (0.66%),
    touching a median 16 of ~579 RUNS (2.8%)

A partial rebuild would therefore rebuild about 3% of the pieces on the
structure where a rebuild costs 75 ms, which is where the 2x lives. 1TIM's 38%
is the small version of the same number.

🔴 **BUT THE PAGE DOES NOT DRAW 9FOG AS A CARTOON.** Above
LARGE_MOLECULE_CUTOFF (1,000 segments) the app picks tube on its own, and a tube
step is 1.8 ms. The 124 ms case is reached by setting Cartoon by hand on a
3,348-residue structure - which is exactly what tests/demo_keep_sse.py tells you
to do, so it is a supported path and not a straw man, but it is not the default
one. The partial rebuild is worth 38% on the trajectories the page draws as
cartoons by itself.

### The corner skip, sized and dropped

The other named target was the corner arrays a fast step pays for and does not
read. Sized: a fast step on 1TIM is 7.23 ms of which the capture is 3.94, and
the capture's SS assignment is 1.87 of that - so the whole of the rest of the
capture is ~2 ms, and the corners are a part of it. `project` is 0.7% of a step
in a sampling profile, so the four projections a station are not the cost; the
ELEVEN ARRAYS A PIECE are, and that is an allocation problem rather than a
corner problem. Not worth a two-phase capture. What is worth doing, if anything
here is, is `drawRun`'s arrays-of-three-arrays - one pair per residue per
capture - as flat typed arrays.


## Two paths, one assignment - a correctness fault a perf gate found

`tests/colour_cache.py` was written to check that a cached colour array equals a
freshly computed one. It reported the `ss` arm disagreeing on 6 of 6 steps, and
did so with the cache stashed as well, so it was not the cache's doing.

`secForColor` carries a comment saying it makes "the same call the draw stage
makes, so the colours cannot disagree with the geometry: colouring from a
different pipeline used to tint the last residue of every helix as coil while
the ribbon drew it as helix". It was not making the same call. The draw stage
passes `groups` - which positions may bond to which - and `links`, which
residues the file says are one polymer. The colour path passed neither.

    letters where the ribbon and the colour disagreed

    2POR    1,164 residues, 24 chains        3   (300 C/E, 601 C/E, 902 C/E)
    1AOI    1,103 residues, 16 chains        2   (474 C/H, 477 H/C)
    _traj_1tim.pdb in OVERLAY, 14,820    2,548
    1UBQ, 3CHY, 4HHB, 1EHZ                   0

The porin's three are at chain ends, where a missing `links` lets the search
reach into the next chain. The overlay's 2,548 are what a missing `groups` does:
thirty superimposed copies of one molecule bonding to each other.

🔴 **THE COMMENT WAS RIGHT AND THE CODE HAD DRIFTED FROM IT.** The failure it
describes is the one that came back, in the same file, under the paragraph
warning about it. A claim in a comment is not a gate - `tests/ss_agree.py` is.

🔴 **AND A GATE WRITTEN FOR ONE THING FOUND ANOTHER.** This is the second time
in two passes: the arithmetic for the partial rebuild found the double capture,
which was worth more than the rebuild; a cache-verification gate found a
five-year-old colouring fault. Write the check that compares two paths, even
when you only mean to speed one of them up.

### The colour cache, and the two things that made its first version do nothing

    a tube step on _traj_9fog.pdb - the style the page picks at that size -
    alternated, three runs each
    1.79, 1.80, 1.79 ms   against   2.15, 1.87, 2.02

No colour mode reads a coordinate, so a frame step recomputed an identical
array: 11 of 12 steps byte-identical, 1.1 ms a step at 3,348 positions.
`_segmentColourKey` keys on what the colours DO read and answers null - compute
them - for anything it cannot be sure of.

🔴 **THE FIRST VERSION KEPT NOTHING AT ALL, TWICE OVER.** It bailed on "are
there any custom colour modes?", and cartoon/geom.js registers `ss` on load, on
every page, for every structure - so the answer was always yes. It is the mode
IN USE that must be asked. And then `_setDataField` built a fresh default array
per frame for any field the frames do not carry, so one of the six arrays
compared by identity was new on every step. Both had to go before the key
matched once.

🔴 **AND THE POLARITY IS THE WHOLE SAFETY ARGUMENT.** setCoords reads
`colorsNeedUpdate` BEFORE it sets it, so a flag raised by the colourblind
toggle, an element edit, a mode switch or a reset is honoured exactly as it was,
and a new site that raises it is hard by default. The key only ever suppresses
the invalidation setCoords itself just made. A cache whose invalidation is an
allow-list of inputs would be the failure this file has recorded twice.


## Where a cartoon mesh build actually goes, and two micro-hoists that do not pay

`window.__mrRibbon` carries the ribbon part's phase marks (`__mrPhase` is
overwritten by the parts that follow it, the last of which usually has no faces
at all - read the wrong one and every number is zero). Median of 20 builds,
_traj_9fog.pdb forced to cartoon, 46,463 faces:

| phase | ms |
|---|--:|
| edges | 26.1 |
| normals | 14.4 |
| rails (the unprojection) | 7.7 |
| facesAndEmit | 4.5 |
| pieceFrames | 3.0 |
| buffers + end | 1.3 |
| **total** | **58.9** |

So the edge pass is 44% of a build, and a build is ~60% of a 124 ms step.

**Pre-sizing the edge tables** from the face count is worth ~7% of that phase
(24.40 -> 22.60 ms median of 60, three pairs, direction never inverting) and
takes 108 array reallocations over nine builds to zero. Kept.

**Hoisting `focalLength()` and `isPersp()` out of `unprojInto`** is not worth
anything measurable, and it removes 185,852 calls of each on this structure.
Three pairs on the `rails` phase: 6.30/7.30 against 8.40/6.30 - the arms
overlap and the direction inverts. V8 inlines both. Not kept.

🔴 **THAT IS THE SECOND MICRO-HOIST THIS SESSION TO MEASURE AS NOTHING**, after
memoising the GL uniform locations. The pattern is the same both times: a count
that looks alarming (185,852 calls, 95 driver queries a frame) attached to work
the engine already elides. **Count first if the count is the claim; time the
arms interleaved if the time is - and on a 124 ms operation this machine cannot
resolve 2 ms whatever you do, so measure the PHASE.**

### And a note on measuring phases at all

`tests/anim_profile.py` on a large structure profiles the TUBE path, because
above LARGE_MOLECULE_CUTOFF the app picks tube on its own and the probe does not
override it. A cartoon profile of 9FOG needs the style set explicitly; without
that the top of the profile is `buildTube` and the numbers are 2 ms a step, not
124.


## Loading a capsid, second look: where 12 seconds goes

1M4X, 2,081,520 positions, drawn as tube. Sampling profile of `processFiles`
through to the first drawn frame:

| | share | ~ms |
|---|--:|--:|
| convertParsedToFrameDataSteps | 19.6% | 2,500 |
| garbage collector | 13.8% | 1,800 |
| **the sequence strip** | **13.8%** | **1,800** |
| buildSidechainTable | 8.7% | 1,100 |
| setCoords | 7.2% | 900 |
| applyBiounitOperationsToAtoms | 3.4% | 440 |
| getAllValidColorModes | 1.8% | 230 |

Two of those were this session's own doing or reach, and both are fixed:

**The strip's content hash** walked every entry's chain, residue name, number,
index and type character by character - 2,081,520 entries - and `mix`/`mixStr`
alone were 3.7% of the load. It is four array identities and two numbers now,
asked BEFORE the sections are built rather than after, so the entries are not
materialised at all on a match. 13087/12909 ms -> 12448/12536.

**`getAllValidColorModes` was called 2,077,432 times**, once per position, each
call building three arrays. `_getEffectiveColorMode(atIndex)` asks for the list
on every call. Cached against the custom table's identity and key count.

🔴 **AND THE COUNT IS THE ONLY HONEST CLAIM FOR THE SECOND ONE.** Six million
allocations removed and the 12-second load cannot resolve them: 11567/12062
against 11888/11447, overlapping, direction inverting. It shows on a recolour of
1CWP, where the calls are dense - median 4.81 -> 4.56 ms over three pairs.

### Three micro-optimisations, and what separates the one that paid

| | removed | measured |
|---|---|---|
| memoising the GL uniform locations | 95 driver queries a frame | nothing; arms inverted |
| hoisting focalLength()/isPersp() out of unprojInto | 185,852 calls of each | nothing; arms inverted |
| caching the colour-mode list | 6M array allocations | ~5% of a recolour, consistent |

The two that bought nothing removed CALLS to work V8 inlines. The one that paid
removed ALLOCATION. That is the rule worth carrying: **a count of calls is not a
cost; a count of allocations sometimes is - and neither is a measurement.** On
an operation this machine drifts 5% across, only a phase or a dense inner loop
can resolve a change worth 5%.

🔴 **AND buildSidechainTable IS CALLED ONCE, WHICH IS THE ANSWER TO THE OBVIOUS
QUESTION.** Its 1.1 s is one pass over 2M positions building local frames for
side-chain atoms that are switched off. Deferring it to first use would need the
raw atoms kept, which is the memory it saves. Not attempted; recorded so the
next person prices it before starting.

### A fourth: open addressing for the edge table, also not worth it

`buildMeshPart`'s edge table is a `Map` keyed by one endpoint hash, looked up
about four times a face - 186,000 times on a 46,463-face structure - with a
well-mixed uint32 key and an integer value. That is the textbook case for two
typed arrays and linear probing, sized from the face count so it never rehashes.

    the edges phase, median of 60 builds, three pairs
    base    23.60, 24.50, 22.40 ms
    table   21.10, 22.70, 23.30

Median 23.60 -> 22.70, and the third pair inverts. V8's Map on integer keys is
already close enough that a custom table cannot be told apart from drift here.
Not kept.

🔴 **SO THE TALLY IS THREE OF FOUR.** Removing calls to work V8 inlines: worth
nothing, twice. Replacing a general structure with a specialised one where the
general one was already good: worth nothing. Removing ALLOCATION: worth about 5%
where the calls are dense, and invisible where they are not. Four attempts is
enough of a pattern to write down as a rule rather than rediscover:

**Before optimising anything in this file, ask which of the four it is. If the
answer is "it removes calls", stop.**

What did pay this session, every time, was removing WHOLE PASSES: a draw that
nothing saw, a rebuild of an array identical to the one it replaced, a hash over
two million entries answering a question four identities answer. Those are 10%
to 100% of the thing they remove, and they show up on a clock that drifts 5%.


## The capsid load, third look: 12.9 s to 9.9

1M4X, 2,081,520 positions. Three passes over this load in one session:

| | ms |
|---|--:|
| at the start | 12,898 |
| the strip's key made O(1) | 12,449 |
| the side-chain table into typed arrays | 11,141 |
| the polymer atom-id keys skipped | 9,873 |

**The side-chain table was built twice.** `pos`, `frameOf`, `coef`, `bonds`,
`toBackbone` and `onBackbone` were filled by push into JS arrays and then handed
to `new Int32Array(pos)` and friends - so every one of 8,033,760 rows was built
once as a JS array element and again as a typed one, the first copy thrown away.
`coef` alone reached 24,101,280 numbers, about 190 MB of backing store, copied
into a 96 MB Float32Array and discarded. Written straight into growable typed
arrays now; the table is byte-identical on six structures.

**Two million atom-id keys were built for a map nothing read.** `atomIdToIndex`
is keyed `chain:seq:atomName`, and its polymer half is read only by struct_conn.
On 1M4X: 2,081,520 sets, ZERO gets. The condition is a parameter, known before
the loop, so the polymer branches skip it and the ligand branch - which the
chem_comp pass and extractLigandBondsFromAtoms do read - still writes.

🔴 **AND THE MEASUREMENT RULED OUT THE OBVIOUS CHANGE FIRST, TWICE.** The
side-chain table's pre-pass that decides which residues can carry a frame is 68
ms of 2.1 s, so halving its localFrame calls - the first thing that looks
expensive - is worth nothing. And a size cap on the table was the second idea,
until the count showed 8 million real rows on a structure whose author had
already optimised this function *for* the capsid case.

### What was priced and NOT done

**Reusing the Vec3 array across frames.** `_loadDataIntoRenderer` builds
2,081,520 `new Vec3` per load. Mutating them in place instead would break two
caches that key on `this.coords` IDENTITY - `cachedSegmentIndicesCoords ===
this.coords` and the pick cache's `hit.arr === this.coords` - so the segment
list and the projection would be reused across frames that moved. Handing back a
NEW array of REUSED Vec3 objects keeps both caches honest, but then the saving
only appears on the second frame onward, which on a one-frame capsid is nothing.

**The strip's layout objects.** `residuePositions` and `allResidueData` are two
objects per residue - 4.2 million on a capsid - pushed in the same order at three
sites, so index i of one is index i of the other. Merging them into one object
carrying its own x/y/width/height would halve that, and it is about twenty read
sites across the drawing and the hit testing. Priced at maybe 0.5 s of a 10 s
load, and not taken: the risk is a hit-test that lands on the wrong cell, which
no gate here would notice as loudly as it should.


## The partial rebuild, after measuring it: what it actually needs

The go-ahead was given and the first thing built was the instrument, which is
what changed the plan. `stationSplicePlan` computes the head/window/tail
decomposition on every declining step and verifies it by replay; the sizes are
in `tests/splice_window.py` and in the correction above. One window is the wrong
shape: on 9FOG it is 74-96% of the mesh on every step.

**What the piecewise version needs, in order.**

1. **Diff the ASSIGNMENT, not the face mapping.** The renderer holds
   `_cartoonSec` for the frame it drew; keeping the previous one gives a diff of
   494 or 3,348 letters. Expand each changed position to its whole RUN - a
   letter changing at one residue changes the sheet flag and the colour of the
   whole run, which is what pad-in-pieces got wrong the first time.
2. **Map runs to piece ranges to face ranges.** `facePiece` is monotone along
   the chain, so a run is a contiguous piece range and a piece range is a
   contiguous face range. That gives one window per changed run.
3. **Build the mesh for a face SUBSET.** This is the part `buildMeshPart` is not
   factored for, and the phase table says why it is not just the row emit: the
   edge pass is 26.1 ms of a 58.9 ms build and it needs `M`, the unprojected
   corners, which the rails pass fills - so a subset build is rails, normals and
   edges over the window plus one piece of context either side.
4. **Splice the edge buffer, with a face-index fixup.** Edge rows reference
   faces by offset into the flat store; every edge after a window shifts.

🔴 **AND THE GEOMETRY IS NOT THE REASON FOR ANY OF THIS.** On a trajectory step
every face's geometry moves, and the station path already handles that: the
geometry lives in the textures and `refreshEdgesFromStations` re-derives the
outline from them. What a partial rebuild has to fix is only the TOPOLOGY -
which faces exist, which station each points at, which edges exist - in the runs
that changed. That is the useful thing this measurement clarified.

### What it is worth, with the real numbers

    _traj_1tim.pdb   fast path   14 steps    7.23 ms
                     rebuild     16 steps   21.41 ms   of which facesOf +
                                                       buildMeshPart ~9.5

A piecewise rebuild that touches ~3% of the pieces takes a rebuild step to about
a fast step plus the window, so ~13.7 ms, and the average step from 14.8 to
about 10.3 - a 30% win on the trajectories the page draws as cartoons by itself.
Not the 2x the single-frame sample suggested, and the work is four items above
rather than one.


## A better target than the partial rebuild: the ribbon's instance rows are never drawn

Chasing the partial rebuild turned up something larger. **With the station path
on, the 48-float instance rows for the ribbon are built, uploaded, and never
issued** - `drawResident` takes part 0's instances from the station buffer. So
every geometry pass that exists to fill them is work only the OUTLINE still
needs.

What each pass of a 58.9 ms build (46,463 faces) is actually for:

| pass | ms | feeds |
|---|--:|---|
| edges | 26.1 | the outline. Needs `M`, so it needs rails. |
| normals | 14.4 | the 48-float rows, and `f._inkN` for the edge pass |
| rails (unprojection) | 7.7 | `M`, which the edge hashes read |
| facesAndEmit | 4.5 | the 48-float rows **only** |
| pieceFrames | 3.0 | normals |
| buffers + end | 1.3 | the upload |

**Step one is done**: `stationRowsFromFaces` derives the fifteen static floats a
station row carries from the face rather than from the instance row, and
`tests/station_rows.py` holds the two derivations to zero differing floats over
47,533 rows. That removes the station table's dependency on `fill`.

**Step two is done, and it was smaller than the tracing promised.** The rows
are not built when the table covers the ribbon: the emit loop keeps only the
depth range and the release of the prim's corners, the five shading vectors are
not derived, and the part's fill comes back empty.

    _traj_1tim.pdb, the ribbon build, median of 40, three pairs
    facesAndEmit   0.60 ms -> 0.10
    total          6.50, 6.40, 7.30  ->  5.20, 5.90, 5.10      (20%)

    a step, 150 steps, 73 on the fast path either way
    12.03, 12.18, 12.41 ms  ->  10.22, 11.65, 11.73            (4-5%)

🔴 **AND IT IS 20% OF THE BUILD RATHER THAN 40% BECAUSE `nn`'s ORIENTATION
NEEDS THE FRAMES.** `_outN` is `frA.n` for a rib face and the edge pass reads it
as `_inkN`, so `pieceFrames` and the per-face frame lookups stay. Only the five
vectors that feed the ROW go. Sourcing the orientation from the station table -
`normalOf` already derives exactly that - would take `pieceFrames` and the
lookups with it, and is the next step.

🔴 **AND THE TWO THINGS THAT HAD TO MOVE WITH IT WERE BOTH FOUND BY A GATE.**
`stationFillRows` was the CONCATENATED fill, which worked only because the
ribbon is the first part in it; with the ribbon contributing nothing the array
starts with the tail's rows and the table read a ligand's colour into a ribbon
face - 18.2% of the frame. And `drawResident` derived the tail's offset from the
ribbon's face count rather than reading the span `installParts` recorded.
Neither was visible from reading; both failed loudly the first time they ran.

### The original step two, kept for the record

It needed two things together:

1. **The rebuild path must end in `refreshEdgesFromStations`**, as the fast path
   already does. Then edge geometry comes from one source on both paths - the
   station table - rather than from the mesh on one and the stations on the
   other. They agree to 3.7e-06 A, which is that function's own self-check, and
   `tests/station_pixels.py` already compares the two paths' pixels.
2. **Then the normals pass can be skipped for part 0.** Its outputs are the
   48-float rows (not drawn) and `f._inkN` (overwritten by the refresh). That is
   14.4 ms of 58.9, on every declining step.

🔴 **AND THE TWO CANNOT BE SPLIT.** Skipping normals without the refresh leaves
the outline reading whatever `_inkN` was never set to; doing the refresh without
skipping normals just adds a pass. Land them in one commit or not at all.

🔴 **AND THE BLOCKER IS THE BUFFER LAYOUT, NOT THE NORMALS.** Traced, so the
next attempt starts past it. The emit loop reads `f._nA`, `f._nB`, `f._tA`,
`f._tB`, `f._nFlat` and `f._outN` off the face, so skipping the pass that sets
them throws rather than producing a wrong row - which means skipping normals
means skipping the EMIT, which means part 0 contributes no rows to the combined
instance buffer. And the rest hangs off that:

- `installParts` concatenates the three parts' fills and records `fillAt` /
  `fillLen` per part; the tail parts' offsets move if part 0's is empty.
- `drawResident` issues part 0 from the station buffer and the tail from
  `resident.buf` at an offset computed from those spans.
- An edge row names its faces "counted within the PART", and `installParts`
  shifts them as it concatenates.
- `refreshSticksFrom` writes the tail's rows back over their own spans.

So step two is really: give part 0 a zero-length fill span and make those four
agree about it. That is a contained change - four places that already share one
notion of a span - but it is not a two-line one, and half of it does not work.

The cheap-looking alternative, writing a zero vector into the six normal fields
instead of deriving them, keeps the layout but leaves the edge pass reading
zeros for its crease and donor rules. The crease is redone by the refresh and
the edge SET is positional, so it would probably be identical - and "probably
identical" about the outline, verified only by comparing pixels, is the
two-suspects situation this file's own note warns about. Do the span.

🔴 **AND THE STEP FACE IS THE CASE TO WATCH.** `normDonor` makes a zero-area
arrow-step quad borrow its neighbour's normal, because its own Newell normal is
noise. `normalOf` derives from the STATION frame instead, which is well defined
there - so the refresh replaces a donated normal with a derived one. The fast
path already does exactly this on every frame and `station_pixels` passes, so
they agree in practice; it is still the first thing to look at if an outline
appears under an arrowhead.

### Why this beats the partial rebuild

It is a whole rebuild, computed with fewer passes - so there is no window, no
alignment, no index fixup, and none of the "plausible ribbon made of the wrong
slices" risk class that `stationsMatch` exists to catch. It applies to EVERY
declining step rather than only the ones whose change is confined. And it is
verifiable the way this repo likes: the same picture, from a build that did
less, with `station_pixels` and `station_corners` unchanged.


## Step three: sourcing the outward normal from the station table. TAKEN, after a wrong revert

The obvious continuation of step two: a rib face's outward normal is its
station's own frame - `refreshEdgesFromStations`'s `normalOf` derives exactly
that, and the fast path has been drawing the outline from it on every frame - so
where the table covers the part, the `pieceFrames` pass and its rail bookkeeping
should not be needed at all.

It was built, and it is fast:

    _traj_1tim.pdb, the ribbon build, median of 40, two pairs
    rails         0.70, 0.80 ms  ->  0.20, 0.30
    pieceFrames   0.30, 0.40     ->  0.10, 0.00
    normals       1.20, 1.20     ->  0.60, 0.60
    TOTAL         5.60, 5.40     ->  3.90, 3.70          (a further 31%)

    a step, 150 steps, 73 on the fast path either way
    11.87, 10.69, 11.58 ms  ->  9.91, 10.66, 10.15

**And every pixel gate passed.** `station_pixels`, `station_corners`,
`station_sidechains`, and the whole gpu, ui and node lanes.

🔴 **AND THEN A CHECK REPORTED THE TWO DERIVATIONS DISAGREEING BY 1.79 ON A
UNIT VECTOR, AND IT WAS THE CHECK THAT WAS WRONG.** Reverted on that number,
then reinstated when a standalone diagnostic - one that did NOT disable the
piece frames - reported the two agreeing exactly over 70,060 faces on 1TIM,
1AOI and 1EHZ.

The mistake: the comparison ran with the skip ACTIVE. The piece frames it was
comparing against had never been built, so the "frame" side was whatever the
orientation falls back to with no frames at all. The 1.79 was the distance
between the station rule and a fallback, measured with a straight face.

    with the skip active   worst 1.79   (comparing against nothing)
    with the frames built  worst 2.98e-08 over 1,236 faces on 1TIM
                           worst 0       over 70,060 on three structures

So the check turns the skip OFF, exactly as the row check turns the row skip
off, and for exactly the same reason.

🔴 **THAT IS THREE TIMES IN ONE SESSION, AND IT IS ALWAYS THE SAME SHAPE.** A
gate that compares two derivations, run in a configuration where one of them is
the other. `station_rows.py` would have compared the face derivation with
itself; `station_pixels` compares the station path with a rebuild, and would
have agreed perfectly with both sides taking the station normal; and this one
compared against a reference it had just disabled. **Before trusting a
comparison, ask what the other side would be if the change were wrong.** If the
answer is "the same thing", the gate is decoration.

### The combined result

    _traj_1tim.pdb          ribbon build      a step
    before both steps       6.50 ms           12.18 ms
    rows not built          5.20              11.65
    piece frames not built  3.80              10.41


## The edge pass, after the first two steps: where it stands and what it needs

With the rows and the piece frames gone, the ribbon build on 1TIM is 3.70 ms and
**the edge pass is 2.40 of it**. Everything else is small: normals 0.70, rails
0.20, facesAndEmit 0.10, pieceFrames 0.00.

A step profile of the same trajectory, after both steps:

| | share |
|---|--:|
| buildMeshPart (the edge loops are inline in it) | 13.6% |
| drawRun - the capture's geometry | 11.3% |
| assignSecondaryOpen | 10.2% |
| addEdge | 6.7% |
| ribbonHashOf | 4.0% |
| garbage collector | 3.9% |
| facesOf | 3.7% |
| makeResident | 3.7% |

So the build is no longer the dominant thing in a step: the capture and the
secondary-structure assignment are its equals.

### Hashing each corner once instead of twice: measured, no win

Both halves of the edge pass ask for a face's four corner identities - the weld
builds an order-free key out of them, the emission walks the four edges between
them - and each hashed them again: eight rounds of three `Math.round`s and three
multiplies per face where four would do. Computing them once into a
`Uint32Array` and reading both from it:

    the edges phase, median of 40 builds, three pairs
    base   2.80, 2.70, 2.80 ms
    once   3.20, 2.60, 2.60

Median 2.80 -> 2.60 with the first pair inverted, and the TOTAL went the wrong
way (4.10 flat against 4.10, 4.90, 4.60). The 111 KB array and the extra pass
over every face cost about what the saved hashes did. Not kept - the fifth
instance of this session's rule, and the fourth time removing CALLS bought
nothing.

# PLAN: the edge pass from station topology

Its cost is DISCOVERY. The adjacency between faces is found by hashing corner
POSITIONS and looking those hashes up in a table, about four times a face. For a
ribbon that adjacency is already known: a strip quad's rails are shared with its
neighbours in the same piece, and `refreshEdgesFromStations` proves the corners
are a pure function of `(station, surface, corner index)`. So the edge set is
derivable from the station topology without hashing a single position - and
without `M`, which takes the rails unprojection with it.

## What the design rests on, already established

`cornerOf` in refreshEdgesFromStations is the corner rule, and it reproduces
every position to 3.7e-06 A - its own self-check says so, and the fast path has
drawn from it on every frame for as long as the path has existed:

    cap (surf >= 4)  station = k,            sw = idx<=1 ? 1 : -1
                                             sg = (idx==0||idx==3) ? 1 : -1
    else             station = idx<=1 ? k : k+1,  isA = (idx==0||idx==3)
      surf 0         sw = isA ? 1 : -1,      sg =  1
      surf 1         sw = isA ? 1 : -1,      sg = -1
      surf 2         sw =  1,                sg = isA ? 1 : -1
      surf 3         sw = -1,                sg = isA ? 1 : -1

So a corner's identity is `(station, sw, sg)` - four variants a station - and a
key is `station * 4 + variant`.

The layout to keep in mind: `ED_FLOATS = 19`; an edge row's provenance is
`edSrc[r*6 + 0..5] = oa, ob, fa, fb, nCount, cCosM`, with `faceA = (oa/12)|0`
and `cornerIdx = ((oa % 12) / 3) | 0`. `hashAt` quantises positions to 1e-3.

## Stage 0 - the harness, before any derivation

`tests/station_edges.py`. Build the edge arrays BOTH ways in one process and
diff `ed` and `edSrc` element by element, the way tests/station_rows.py diffs
the station rows. Two rules, both learned the hard way in this session:

  * **The check flag forces the old route to still run.** station_rows and the
    normals check both do this now; the one time it was forgotten, a 1.79
    disagreement was measured against a reference that had been disabled and a
    correct change was reverted on it.
  * **Diff in ORDER, not as a set.** The outline is emitted group by group in
    first-seen order with the depth mask off, so later strokes paint over
    earlier ones. A key change reorders `gN++` and can change which stroke wins
    without changing the edge set at all. A set comparison would miss it.

Falsify by flipping one edge flag and by perturbing one endpoint.

### Stage 0, done - and it found the reason it exists

`tests/station_edges.py`. Both falsifications fire, and the floor is **exactly
0 differing elements of either array** over two builds of the same arm on all
three structures, so this build is bit-deterministic and every difference below
is attributable.

The reason the plan insisted on an IN-ORDER diff was a guess. It is not:

    structure   quantum arm (1e-3 -> 1e-1)          rows
    1UBQ        10,742 floats of ed differ,         1164 -> 1164, A PERMUTATION
    1EHZ        11,809                              1244 -> 1244, A PERMUTATION
    1AOI       132,375                             14408 -> 14406

Coarsening the corner key on the two smaller structures changed **no edge at
all** - the same 1,164 rows, reordered. A set comparison would have called that
identical, and the ink pass draws with the depth mask off, so the order is which
stroke survives. That is exactly the failure stage 2 can cause and it is now
the failure this harness is proven to catch.

The flip arm moves **exactly one float** - row 0, lane 12, `always` 0 -> 2 - and
nothing in `edSrc`, so the diff is element by element and the provenance is
independent of the instance it describes.

## Stage 1 - measure the two facts the design rests on

Cheap, and either could kill stage 2 before it is written.

  1. **Do two distinct stations ever produce a coincident corner?** Count
     corner-hash classes holding corners from more than one station index. Fold
     cuts at piece boundaries are the suspect. Zero means the integer key needs
     no canonicalisation; otherwise price that first - it is ~3,200 station
     hashes against 27,720 corner ones, so still a win, but extra machinery.
  2. **What fraction of edges are strip-internal** - shared by two faces of one
     piece at adjacent stations - against discovered by coincidence? That says
     how much of the hash table survives stage 4.

### Stage 1, done - and it moves stage 2 and kills most of stage 4's doubt

Both measurements are in `tests/station_edges.py`, computed by `edgeTopology`
in paintgl.js off the shipped station table and the shipped `edSrc`.

**(1) Coincident corners are real, pervasive, and ENTIRELY piece boundaries.**

    structure  corners  position classes  hold >1 identity  across pieces  within a station
    1UBQ         4,076        930                602             600              2
    1EHZ         4,952      1,396                776             776              0
    1AOI        70,208     15,135             10,021           9,973             48

Not one coincidence anywhere is between two stations of the SAME piece, so the
suspect named in the plan - a fold cut - is the whole of it, and so is every
ordinary piece boundary beside it. Consecutive pieces' facing stations are two
station entries at one place, and the position hash welds their faces today.
An integer `station * 4 + variant` would not: every piece junction's rails would
become one-faced boundaries and grow an outline the drawing does not have.

**So stage 2 needs a canonicalisation, and it is cheap.** It is a STATION-level
dedupe - one hash per station, not four per face:

    1UBQ    449 stations against 4,076 corner hashes     9.1x fewer
    1EHZ    543            against 4,952                 9.1x
    1AOI  8,162            against 70,208                8.6x

**And the `within a station` column is a second rule, in the other direction.**
Two variants of ONE station landing on one point is a degenerate cross-section -
zero thickness collapses the two width faces onto their shared rail - and the
hash welds those too, through `if (ha === hb) return` at the top of `addEdge`.
An integer key would tell them apart and emit an edge the hash suppresses. 48 of
them on 1AOI. That is the same degeneracy the comment above `nLenOf[fi] < 1e-6`
describes, and getting it wrong is how the helices lost their outline once.

**(2) The adjacency is almost entirely strip-internal.**

    structure   internal   other   one-faced   internal share
    1UBQ             948     176          40        81.4%
    1EHZ           1,236       8           0        99.4%
    1AOI          13,864     384         160        96.2%

Stage 4 - emitting strip-internal adjacency straight from the topology and
keeping the table only for the leftovers - would leave the table carrying 1-19%
of what it carries now. That is the stage with the most in it, and stage 1 was
supposed to be able to kill it. It does the opposite.

### Stage 2, taken and REVERTED - and it disproves the plan's premise

Written, proven correct, measured, reverted. `stationCornerHashes` +
`faceCornerHashes` in paintgl.js hashed every corner the ribbon has ONCE -
`stationCount * 4`, 32,648 on 1AOI - and both consumers, the interior weld and
the edge table, read the four numbers a face out of that instead of running
eight position hashes. 140,416 hashes became 32,648.

It stored the HASH rather than an `at * 4 + variant` index, deliberately, so
that the keys kept their numbering and the arrays could be compared element for
element. They were: **0 differing floats on 1UBQ and 1EHZ**, and on 1AOI 66
floats of `ed` and 22 of `edSrc` which the harness reports as an exact
PERMUTATION - a handful of class labels moved, so three or four rows landed in a
different group. Zero pixels moved on all three, against a zero floor.

**And it is worth nothing.** Five interleaved runs of the edges phase:

    1.07x   0.99x   0.90x   1.00x   1.14x

That is this machine's noise. It also allocates a `Uint32Array(faces * 4)` per
build - 280 KB on 1AOI, 3 MB on a capsid - so break-even is a loss. Reverted.

**Why, and it is the useful part.** `tests/edge_phases.py` splits the edges
phase three ways (the marks are kept - they are what settled this):

    1AOI, 17,552 ribbon faces    weld 1.90   table 5.10   emit 0.90   of 12.20
    _traj_1tim.pdb, 6,927        weld 0.80   table 2.10   emit 0.30   of  4.60

The TABLE is 42-46% of a ribbon build. The key it is looked up by is not the
cost; the lookups are - a `Map.get`, sometimes a `Map.set`, and a chain walk,
about four an edge. Cheapening the key was always going to be free at best,
and the plan said so in its own stopping rule without noticing it applied here:
*removing CALLS does not pay and removing WHOLE PASSES does.*

So stage 3 as written is off the table too - `rails` is 0.70 ms of 12.20 on
1AOI and `pieceFrames` is already 0.00 - and what is left is stage 4, which
stage 1 said was the one with substance: **96.2% of 1AOI's edges are
strip-internal**, and every one of those is a Map lookup and a chain walk
spent rediscovering something the topology already knows.

## Stage 2 - corner identity as an integer (as planned, before it was measured)

Replace `hashAt(position)` with the key above, **canonicalised per stage 1**:
a station is first mapped to the lowest station index sharing its position (one
hash per station), and the degenerate within-a-station collapse is kept by
testing the two corners for coincidence the way `ha === hb` does now. **Keep the
same hash table and the same flag logic**; only the key changes. Smallest change that removes 27,720
float-triple hashes a build, and the harness proves the arrays identical.

## Stage 3 - drop `M` from the edge pass

With integer keys, `M` is read only for the build-frame endpoints in
`ed[base..5]` and for `nLenOf`'s zero-area test. Derive the endpoints through
`cornerOf` and the area test from the station widths. Then the rails
unprojection goes for the covered part - the last big pass that is not the edge
table itself.

### Stage 4, taken and REVERTED - and the plan's premise is wrong

Two versions, both proven correct, both worth nothing.

**What the pass is actually made of**, measured with `tests/edge_phases.py` and
the counters it prints, on 1AOI's ribbon part:

    17,512 rib faces and ZERO caps
    27,064 table edges in 11,768 groups, from 54,964 addEdge calls
    14,408 emitted rows - and 12,656 edges held NOTHING BUT GHOSTS

The pieces are one span each - 3,784 pieces over 8,162 stations - and they
share their end stations, so the strip runs on continuously and no cap is ever
drawn between two of them. Every cross edge is therefore claimed by two ghosts,
one from each side, and emits nothing. **Forty-six per cent of the table is
edges that cannot be drawn.**

The second version skips them: only a cap, a fully outlined rib face or a
non-rib face ever claims a cross edge as real, so their corners go in a Set and
a ghost whose two endpoints are not in it is never registered. Exact, and the
harness says so - every emitted row present exactly once, an exact permutation
of the unskipped route (a ghost creates a GROUP even when it emits nothing, so
a real edge sharing its first endpoint moves later), and **zero pixels moved
against a zero floor** on 1UBQ, 1EHZ and 1AOI.

It removes **26,272 of 54,964 calls and 12,496 of 27,064 entries** on 1AOI.
It buys:

    table phase   1.06x   1.06x   1.04x   1.07x   (four runs)
    whole part    0.96x   1.01x   1.00x   1.07x   (nothing)

A CPU profile agrees and explains it: `addEdge`'s self time goes 7.2% of a step
to 4.2%, which is the 48% of calls removed - and that is all it was ever worth.

**So the premise of this whole plan is wrong.** It assumed the edge pass's cost
is DISCOVERY - the hashing and the table. Stage 2 removed 78% of the hashing and
measured as noise; stage 4 removed 48% of the table and measured as noise. What
is left in the 5.2 ms is the per-face loop itself: about a dozen property reads
off a face object with a dozen optional fields, four hashes, and the loop, at
roughly 300 ns a face. The next thing to try is the FACE REPRESENTATION - the
faces are plain objects and the reads are probably megamorphic - and that is a
change to everything that builds one, not to the edge pass.

What is kept from all of it: the `weld` and `table` marks, the table's own
counters, `tests/edge_phases.py`, `edgeTopology`, and `tests/station_edges.py`.

## Stage 4 - adjacency without the table (as planned, before it was measured)

A strip quad's rails are shared with its neighbours at station k+-1 in the same
piece. Emit those directly and keep the table for the leftovers: piece
boundaries, caps, seams. Only if stage 1(2) says the table is still carrying
most of the work.

## Stopping rules

  * Stage 1(1) finds cross-station coincidence -> price canonicalisation before
    writing stage 2.
  * The harness cannot run both routes in one process -> **stop**. The change is
    not verifiable and this is the wrong code to ship on a pixel diff.
  * Any stage measuring under ~10% of the edges phase -> revert and record. Five
    micro-attempts have bought nothing this session; the rule is that removing
    CALLS does not pay and removing WHOLE PASSES does.

## What it is worth

Edges is 2.40 ms of a 3.70 ms ribbon build on 1TIM, and buildMeshPart plus
addEdge are 20% of a step. Removing most of the pass is roughly 1.5-2 ms of a
10.4 ms step, 15-19%, and proportionally more on a large forced-cartoon
structure where the pass was 26 ms.


## REPORTED: the outline and the surface go out of step on some frames

Reported from use: "sometimes the outline and render go out of sync in some
frames as you play frame to frame". `tests/outline_sync.py` reproduces it and
narrows it, and it is NOT the outline.

WHAT IT DOES. Two whole passes over the same frames: the play, start to finish,
untouched; then each frame from scratch with the mesh invalidated. A frame the
fast path drew correctly is pixel-identical to the frame drawn from a rebuild.
Plus a FLOOR - the same frame rendered twice on the same path, no invalidation -
which is **0.0000% on every frame**, so the renderer is deterministic and every
difference below is attributable.

    _traj_1tim.pdb, cartoon    8 of 20 frames differ from a rebuild of themselves
                               worst 202 of 255, over 0.0002% - 0.0050% of the frame

**Every differing frame is one the play did not rebuild, and every frame it did
rebuild agrees exactly.** Twenty for twenty on that correlation.

What it is not, each ruled out by measurement rather than by reading:

  * **not the outline** - the same 8 frames, the same magnitudes, with
    `outlineMode` off;
  * **not the colour** - the same 8 frames with a fixed per-chain colour, so a
    baked SS colour is not it;
  * **not the station geometry** - the station floats and the piece floats that
    went to the card are BIT-IDENTICAL between the two paths, and so is the
    face-to-station mapping;
  * **not the instance rows** - they differ in exactly one lane of eighteen,
    lane 6, which is `kAvg`; the station vertex shader substitutes `aK` for
    `aKFresh` off the piece texture, and refreshing lane 6 by hand changes not
    one pixel, which confirms it;
  * **not the draw scale** - `resident.scale * viewScaleMul` is the same double
    on both paths;
  * **not nondeterminism** - the floor above.

The differing pixels are ANTIALIASED EDGE pixels: same hue, different lightness,
one side pale where the other is covered. That is coverage, not shading.

### One real fault found on the way, and fixed

The depth range came from two different sources. A build took
`resident.zMin/zMax` from the faces' own view-space corners; a station update
took it from the station table. The two agree to about **2.5e-7** - the same
3.7e-06 A the station rule reproduces a corner to - and it feeds `uZRange`,
which maps every vertex's depth. Measured on frame 12 of `_traj_1tim.pdb`:

    build   -38.63473655020278
    fast    -38.63473680476858

`stationBoundsInto` is now the one source, asked by both paths, and the two
print the same double. 🔴 It has to be called AFTER `installStations`, not
inside `makeResident`: `installStations` runs later, so `residentStations` there
is still the PREVIOUS mesh's table - the first version of this fix used the
wrong face count and changed nothing at all.

**And it was not the cause.** The eight frames are unchanged with the ranges
equalised. Kept because two sources for one bound is a fault whether or not it
is this one, and the four station gates pass with it.

### Where to pick it up

Everything the card holds has now been compared and is identical. What has not
been compared is what the DRAW does with it - the uniforms other than the three
above, the depth offsets `dzprog3`/`dzprogInk`, and `shadeRange`'s cache. The
probe has the hooks: `stationDump()` returns the rows, the pads, the mapping,
the scale and the depth range, and `__stationFloatProbe` copies the station and
piece floats actually uploaded.

🔴 AND IT IS NOT WIRED INTO tests/run.sh, because it fails. Wire it in when it
passes, or the suite stops meaning anything.


### ...and under REAL playback it is bigger, and the report was right

`tests/outline_sync.py --play` presses the button instead of looping
`setFrame`, takes each frame a few animation ticks AFTER the counter moves -
the counter advances on a `setInterval` in `startAnimation` and the picture is
drawn by `animate()`, so a capture taken the instant the counter changes is
racing the render - and wraps `render()` to record what the app itself did.

On `_traj_1bna.pdb`, 24 frames, default speed:

    frame  20   0.0000% moved   renders=2 fast=2 slow=0 builds=0
    frame  21   0.0000%         renders=2 fast=2 slow=0 builds=0
    frame  22   0.0000%         renders=2 fast=2 slow=0 builds=0
    frame  23   0.0000%         renders=2 fast=1 slow=0 builds=0
    frame   0  10.2731% moved, worst 215 of 255   renders=3 fast=1 slow=0 builds=0

**One frame in every playback cycle is ten per cent wrong**, and the trace says
why in its own numbers: three `render()` calls for that frame, ONE of which
updated any geometry, and **not one rebuild in the whole cycle**. The other two
renders hit the `sig !== appSig` early-out and drew the mesh exactly as it was.

So the reported shape - "rendering is skipped for some frames, while the
outline is always updated" - is right in kind. A render that finds the
signature unchanged draws the resident mesh untouched, and the station table
carries a mesh whose TOPOLOGY was decided at whatever frame last rebuilt:
`stationsMatch` compares counts, not the assignment behind them, so 24 frames
of updating can accumulate without one rebuild and the wrap frame is where it
shows.

Once in that run a frame was also literally the previous frame's picture
(`0.0000%` against the frame before it, 1.82% against its own). It did not
reproduce on the next run, so it is a race rather than the standing fault -
worth keeping in mind, not worth chasing before the 10% one.

**Where to start.** `animate()` records `lastRenderedFrame = currentFrame`
whether or not anything was drawn for it, so a frame that rendered nothing is
marked done and never revisited. And the station path has no bound on how long
it may carry a mesh: twenty-four consecutive updates with no rebuild is a lot
of trust in a count comparison. Either would be a defensible first move; the
second is the one the 10% is coming from.


### 1YNE, scrubbing by hand - the same fault, bigger, and it is the SURFACE

Reported: scrolling frames back and forth by hand on 1YNE shows the outline and
the structure out of step. 1YNE is a 20-model NMR ensemble, so it needs no
synthetic trajectory. `python3 tests/outline_sync.py 1YNE.cif`:

    frames differing from a rebuild of the same frame: 5 of 20
      frame  2   0.0002%  worst  27   box 1x1
      frame  5   0.0012%  worst   7   box 8x7
      frame  8   0.0183%  worst 201   box 28x31
      frame  9   0.0158%  worst 144   box 26x31
      frame 18   0.0175%  worst 113   box 28x26

Bigger than 1TIM's by two orders of magnitude, and it is a COMPACT PATCH -
about thirty pixels square, in the same region of the picture on all three -
rather than scattered singles.

🔴 **AND IT IS THE FILL, NOT THE OUTLINE.** The same five frames, the same
magnitudes, with `outlineMode` off. What reads as an outline out of step is the
SURFACE under a correct outline: the sampled pixels are the same hue at a
different lightness, one arm consistently lighter, so it is shading rather than
coverage.

What has been eliminated on this structure, each by measurement:

  * the outline (above), and the two-tone colour - the same patches survive a
    flat per-chain colour;
  * the tail: 1YNE has **none**, `tail=0 of 538`, so `refreshSticksFrom` and
    its separate edge write are not involved;
  * the instance rows: they differ in lane 6 alone, `kAvg`, and identically on
    frames that differ and frames that do not - the station shader substitutes
    that lane and refreshing it by hand moves no pixel;
  * the station floats, the piece floats, the face mapping, the draw scale and
    the depth range - all bit-identical between the two arms;
  * the texture PADDING, the last state difference between a freshly created
    texture and one updated with texSubImage2D: zeroing it changed nothing, and
    the fill was reverted rather than kept unmeasured;
  * nondeterminism: two renders of one frame on one path differ by 0.0000% on
    every frame.

So every byte the card holds is the same and the picture is not, on the frames
the app did not rebuild. What has NOT been compared is what the draw does with
it - the remaining uniforms, the depth offsets, and `shadeRange`'s cache, which
is keyed on the rotation and the face count and so can survive a rebuild that
changed the centroids under it. That cache is the next thing to look at, and it
is the right shape for the symptom: it feeds lightness, not geometry.


### The draw itself is identical, and a second probe cannot reproduce the first

`tests/draw_diff.py` wraps `WebGL2RenderingContext.prototype` and records every
`uniform*` and every draw call the context receives, then diffs the two arms in
order. On 1YNE frame 8:

    68 GL calls on the fast frame, 68 on the rebuilt one
    the two draws are identical, call for call

🔴 IT HAS TO BE UNIFORMS AND DRAWS ONLY. A rebuild also CREATES textures, so
its `bindTexture` calls outnumber the fast frame's and every later call is
offset - the first version reported the sequences as differing from call zero
and said nothing at all.

So: identical data, identical uniforms, identical draw calls - and
`outline_sync` still reports 0.0183% of the picture moved at a worst channel of
201 on that frame.

🔴 **AND THE TWO PROBES DISAGREE, WHICH IS ITSELF THE FINDING.** draw_diff
reports 0% on frame 8 by every comparison it makes: the fast frame against a
rebuild, against a rebuild reached by rebuilding every frame in sequence, and
after a bare `recolour()`. It was made to arrive the way the report does - two
full laps of the ensemble, then one step at a time, stopping one frame short so
the captured render is the FIRST render of that frame - and still 0%.

The outline_sync result is not a timing artefact: the settle before each shot
was swept at 2, 8 and 20 animation ticks and it is **5 of 20 on all three**,
the same five frames every run.

So one probe reproduces it deterministically and the other cannot, and the
difference between them is not yet understood. That is where this stands. The
next move is to make draw_diff's arm A byte-identical to outline_sync's pass A
- the floor pass that precedes it renders every frame twice, and that is the
largest remaining difference - rather than to keep proposing mechanisms for a
fault whose reproduction is not yet pinned down.

**What has NOT been established, and should not be claimed:** that the fault is
in the station fast path at all. Every input to the draw has now been compared
and found identical.


### Three more eliminations, and the differing frames MOVE

Added to `tests/outline_sync.py`, all on 1YNE with the outline off:

  * **a second render of the same frame** draws the identical wrong picture, so
    it is persistent state and not an ordering slip between update and draw;
  * **`recolour()`** - the one call a rebuild makes and a station update does
    not - changes nothing, so the palette is not stale;
  * **the REBUILD FLOOR**: two rebuilds of one frame differ by 0.0000%. Both
    arms are individually deterministic and they still disagree. This control
    was missing and should not have been - it is the same shape as the three
    gates in this session that compared a change against itself;
  * **the textures and the buffers read back OFF THE CARD** with `readPixels`
    and `getBufferSubData`, not inferred from what was uploaded: station texels
    0 differing, piece texels 0, fill buffer 0, and the station row buffer
    differing in lane 6 alone - the same lane the CPU copy differs in;
  * **lane 6 patched with the rebuild's own values, inside an unbroken walk**:
    360 faces written, and the picture does not move by a single pixel. An
    earlier attempt wrote the piece's `k` instead and left a third of the lane
    differing, so it proved nothing; this one settles it. **kAvg is innocent.**
  * **the GL canvas alone**, rather than the app's canvas with the 2D painter's
    halos and contacts over it: still 5 of 20. The difference is in the GL
    output.

🔴 **AND THE DIFFERING FRAMES ARE NOT THE SAME FRAMES.** Walking the ensemble a
second time, from a rebuild at frame 0 and with no rebuild after it, the frames
that differ are **1, 2, 3 and 5** where the first walk gave **2, 5, 8, 9 and
18** - and frame 5 differs by 0.0375% on one walk and 0.0012% on the other.

So this is not a property of a frame. It is a property of the WALK: how many
station updates have accumulated, and where the last rebuild was. Which is also
why `tests/draw_diff.py` sees 0% - it re-approaches the frame after a rebuild,
and one step back and forward is enough to erase it.

**The hypothesis that fits all of it**, and the next thing to test: a target
that is not cleared on the fast path. The GL inputs are identical, the output is
not, and the differing pixels are localised patches that move with the
PREVIOUS frame's geometry - which is what a depth or occlusion buffer carrying
the last frame's contents would do, and nothing about the resident state would
show it. `drawResident` has a depth prepass and a shared-depth compose path;
both are worth reading with this in mind.


### The state audit is COMPLETE, and it comes up empty

Everything the draw reads has now been compared between a fast frame and a
rebuild of the same frame, on 1YNE, with the outline off and shooting the GL
canvas rather than the app's:

    station texels (readPixels)          0 differing
    piece texels                         0
    palette texture                      0
    visibility texture                   0
    station instance buffer (getBufferSubData)  lane 6 only - and proven inert
    fill buffer                          0
    program                              the same one, both arms
    every GL call, arguments compared    IDENTICAL, 149 calls each

That last line is the whole audit in one: the recorder wraps
`WebGL2RenderingContext.prototype` and logs `uniform*`, the draws, every
`vertexAttrib*`, `bindBuffer`, `bindTexture`, `bindFramebuffer`, `enable`,
`disable`, `depthFunc`, `depthMask`, `cullFace`, `frontFace`, `colorMask`,
`polygonOffset`, `depthRange`, `scissor`, `blendEquation`, `blendFuncSeparate`,
`pixelStorei`, `clear`, `clearColor`, `clearDepth` and `viewport`. Once object
identities are stripped - a rebuild makes new buffers, so ids differ by
construction - **every call's arguments match**.

Three more things ruled out along the way:

  * **the app's own render loop.** `animate()` redraws whenever
    `lastRenderedFrame` differs from `currentFrame`, and a direct `r.render()`
    does not update that - so every explicit render in the probe was followed
    by a second one from the loop, and the shot showed THAT render. Claiming
    the frame (`lastRenderedFrame = currentFrame`) after each render makes no
    difference: 5 of 20 either way.
  * **the zero-thickness tie.** A Richardson helix is drawn at zero thickness,
    so its two broad faces are coincident and which one survives is a depth
    tie. Giving the slab a thickness makes it WORSE, not better - 5 of 20 at
    0, **10 at 0.5, 14 at 1.0** - so the difference is not that tie; it scales
    with how much slab surface there is.
  * **object identity.** Two rebuilds, each creating fresh buffers and
    textures, agree to 0.0000%. So identical content in a different allocation
    draws identically, and the tie-breaks are deterministic.

🔴 **AND THE FAST WALK IS NOT REPRODUCIBLE.** Two walks that both start from a
rebuild at frame 0 and step with no rebuild after it differ at DIFFERENT
frames: 2, 5, 8, 9, 18 on one and 1, 2, 3, 5 on the other, with frame 5 at
0.0375% on one and 0.0012% on the other. Yet each individual frame is stable
under a repeat render (floor 0.0000%). So something accumulates across the walk
that is not any of the state above and is not the same twice.

That pair of facts - every input identical, and the walk not reproducible - do
not sit together, and one of them is being measured wrongly. Resolving THAT is
the next step, not another hypothesis about which field is stale.


### The bisect finds nothing, and that is the most useful result yet

`--bisect` clamps the instance count (`setInstanceLimit`) and halves it to find
which instance draws the differing pixels. To do that it walks to the frame
under its own control: invalidate at frame 0, step to the frame, draw; then
rebuild the same frame and draw. Its first measurement is the whole-mesh
comparison, and on 1YNE frame 8 - the frame `outline_sync` reports at 0.0183%
with a worst channel of 201 - it reads:

    538 instances, whole-mesh difference 0.0000%

**Under a walk that starts from a rebuild at frame 0, there is no difference at
all.** That is the third independent probe to say so: `draw_diff` says 0% by
every comparison it makes, the in-pass-B re-approach says 0.0000%, and now the
bisect.

What is different about the walk that DOES show it: `outline_sync`'s pass A
does not begin with a rebuild. It follows the floor pass, which ends at frame
19, so pass A carries a mesh built at whatever frame last rebuilt and steps
away from it. Every probe that begins its walk with a rebuild at frame 0 sees
nothing.

🔴 **SO THE WEIGHT OF THE EVIDENCE HAS MOVED.** The state audit found every
input identical because, in the conditions the bisect and draw_diff create,
the two arms genuinely are identical - and the difference `outline_sync`
reports comes from its own sequencing, not from the station path. That is not
yet proven, but it is now the more likely reading, and it explains the
contradiction that has been sitting here for two sessions: *every input
identical* and *the walk not reproducible* are both true because the thing
being measured is the probe's pass structure.

**What that does NOT explain**, and what is still open: the user's report is
real and was made from the app, not from a probe; and the playback measurement
on `_traj_1bna.pdb` - one frame a cycle ten per cent wrong, with three renders
and no rebuild - came from pressing the actual Play button with the app driving
itself. That one does not depend on pass A's sequencing at all, and it is the
one to carry forward.


## FIXED: the mesh cache handed back a mesh against another frame's stations

`restoreMesh` takes a mesh out of the spare slot when its signature comes round
again, and `activateMesh` puts it back: the fill buffer, the ink buffer,
`resident`, the palette flag, the positions, the residue map, the visibility
texture. **It does not put back the station table** - and on the station path
that table is where the ribbon's geometry is actually read from.

So a restore left this frame's rows and flags on the LAST frame's stations, and
because the restore also sets `appSig`, the station update that would have
fixed it was then skipped as "nothing changed".

**How it was caught.** `tests/outline_sync.py --play` presses the actual Play
button, captures each frame a few animation ticks after the counter moves, and
wraps `render()` to record what the app did. On `_traj_1bna.pdb`:

    frame  23   0.0000%   renders=1 fast=1 builds=0
    frame   0  10.2775% moved, worst 214 of 255   renders=2 fast=0 builds=0

Zero fast-path updates and zero rebuilds on that frame, with the coordinates
already frame 0's - and a station checksum still reading frame 23's. The gate
that named it prints the reason the branch declined:

    frame   0  ... gate[sigSame]
        sig now _traj_1bna|frames|_traj_1bna#0|...
        sig was _traj_1bna|frames|_traj_1bna#0|...

Both naming frame 0, on a frame nothing had updated for frame 0. The only other
writer of `appSig` is the restore.

**The fix**: a restored mesh does not claim the signature while the station
table still describes another frame. The restore happens; `appSig` is left
alone; the station branch below then sees a frame it has not written and writes
it. One station update, which is two texture writes.

🔴 **AND THE FIRST VERSION OF THIS FIX WAS WRONG, WHICH tests/rebuild_actions.py
CAUGHT.** It declined the restore outright whenever a station table existed -
and the slot is exactly what makes "toggle side chains off" a swap rather than a
rebuild, so that probe failed with *side chains off rebuilt the mesh 1 time(s) -
it returns to the picture from two steps ago, which the spare mesh is holding*.
The mesh cache and the station path both work; what could not be allowed is the
restore silencing the update.

**Why scrubbing by hand is the way to see it.** Walking forward visits every
frame once and never returns, so it never asks the cache for one. Dragging the
slider back and forth revisits frames, and a signature that comes round again is
exactly the slot's key. Measured on 1YNE: the scrub hits that path
(`declined=1`) where the forward walk never does (`restores=0 declined=0`).

Every frame 0 across four playback cycles is now 0.0000%, and no frame draws the
previous frame's picture.

### What is left, and why it is not a bug

The residual is 0.0002%-0.02% of the picture - about thirty pixels - at colour
boundaries. `--bisect` clamps the instance count and halves it; with the ink
clamped too, zero instances gives 0.0000% and one instance gives 0.0054%, so it
is the OUTLINE. Reading the ink buffer off the card: 4,960 of 10,336 floats
differ, and the lanes say what they are - the endpoints and normals by about
2e-7, which is the 3.7e-06 A the station rule reproduces a corner to, and **42
rows with a different palette slot, 16 with a different colour**.

That slot is lent by the first face to claim the edge, and which face arrives
first depends on which faces are degenerate this frame. The station path keeps
the edge table across frames, so an edge on a colour boundary keeps the build
frame's answer where a rebuild lends another. Tying the slot to the face the
edge records was tried and does not help - that face is chosen the same way and
frozen the same way. The only thing that would is rebuilding the adjacency,
which is the cost the path exists to avoid. It is the same approximation as the
kept crease classification, and it is recorded in `addEdge`.

So `tests/outline_sync.py` fails above **0.5% of the picture** and reports below
it. Falsified both ways: `--stale-restore` puts the fault back and the gate
fails at 10.2775%.


## Another pass, after the restore fix: where a trajectory step goes now

`tests/against_baseline.py`, this tree against `origin/main`, Keep SSE off:

    step   17.30 -> 12.00 ms   1.44x
    build  17.30 -> 14.00 ms   1.24x    the same work, done faster
    load     446 ->    348 ms  1.28x    1AOI to a drawn cartoon

...and the step splits: **a step that rebuilds is 14.00 ms, one that reuses the
mesh is 6.40**. Twenty-three of forty steps rebuild on this trajectory.

A CPU profile of the same run, by self time:

    13.4%  buildMeshPart      6.0%  addEdge          2.8%  makeResident
    11.2%  assignSecondaryOpen 5.5%  (gc)            2.4%  stationBoundsInto
     9.7%  drawRun             3.7%  ribbonHashOf    2.0%  stationMeshOf
                               3.5%  facesOf         3.0%  _storeRibbonTrace

**The 6.40 ms is almost all the CAPTURE**, and that is not waste: a fast frame
needs this frame's stations, the stations come from the prims, and the prims
come from the 2D geometry pass. `drawRun` runs BEFORE the `_probeOnly` return
in geom.js - it generates the runs rather than painting them - so its 9.7% is
the geometry, not the painter.

Three things were checked and are NOT silly:

  * **`_storeRibbonTrace`** (3.0%) looked like a round trip - it un-rotates the
    centre line and `stationMeshOf` subtracts the view centre straight back
    off. Only the CENTRE round-trips; the un-rotation is wanted by both readers
    (the picker across frames, and the station table this frame). Not waste.
  * **the capture running twice** on a frame that both updates the stations and
    rebuilds. It does not - `heldCapture` is doing its job - and there is now a
    gate saying so, because a second one would double a rebuilding frame
    without changing a pixel. `tests/capture_once.py`, falsified with
    `--drop-held`.
  * **the tube path's spare slot**, which is the same shape as the mesh cache
    that had the restore bug. `restoreTube` restores `tubeLive`, `tubeCount`
    and the buffer and then sets `tubeSig` - there is no second half to leave
    behind. Clean.

What is left on a trajectory is the capture, and removing it means computing
the ribbon's centre line and frames without the 2D pass - a redesign, not a
tidy-up. `assignSecondaryOpen` at 11.2% is the largest single piece of it, and
it is recomputed every frame ON PURPOSE: a folding trajectory needs it, and
`stableTopology` is the reader stating that theirs is not.


# PLAN: secondary structure as an AXIS, not a rebuild

Asked from outside: could the secondary structure be MORPHED rather than
rebuilt - "the loops are already essentially the same as helices", so give the
shape another axis and interpolate along it. It turns out to be one constant
away from true, and the measurement is short.

## What SS actually controls

Two scalars per station:

    SS_HALF_A   = { H: 1.3,    E: 1.1, C: 0.42 }   half-width
    RICH_TH_REL = { H: 0,      E: 1.0, C: 1.0  }   thickness, x the Thick slider

Both are the station table's `hw` (slot 3) and `ht` (slot 7), and the station
table is **rewritten from the prims on every frame**. So the SHAPE half of an SS
change is already a per-frame quantity: it costs nothing to move it, and an
interpolated value is as cheap as an assigned one.

What forces the rebuild is TOPOLOGY - the station, piece and face counts that
`stationsMatch` compares. Measured on 1UBQ by forcing one residue's letter
through the `sse` override and reading `stationsResident()`:

    as assigned            stations 449  pieces 196  faces 1019
    one residue H -> C     stations 446  pieces 194  faces 1015
    one residue H -> E     stations 446  pieces 194  faces 1016
    whole run H -> C       stations 416  pieces 174  faces  975

**One letter moves three stations, two pieces and four faces**, and every one of
those is a rebuild.

## Why, and it is one constant

A helix and a loop are sampled at different rates by different code paths:

    HELIX_SUB = 8    subdivisions per residue for a helix
    SHEET_SUB = 6    ...for a flat strand
    SUB       = 6    ...for a loop

`subFloor(base) = max(2, round(base * detailCur))`, and Detail sets `detailCur`.
So a helix residue carries more stations than a loop residue, and changing a
letter changes the count.

**Make the sampling uniform and the topology stops moving.** Measured, one
constant changed each way:

    HELIX_SUB 8 -> 6 (everything at the loop's rate)
      as assigned  stations 395  pieces 160  faces 947
      one -> C     +0  +0  +0
      whole run    +0  +0  +0
      one -> E     +0  +0  +1

    SUB and SHEET_SUB 6 -> 8 (everything at the helix's rate)
      as assigned  stations 605  pieces 300  faces 1227
      one -> C     +0  +0  +0
      whole run    +0  +0  +0
      one -> E     +0  +0  +1

**Zero. An SS change becomes a pure station update** - two numbers a station,
already uploaded every frame - and the letter can therefore hold any value
between H and C, which is the morph.

## What the +1 face is

The strand's ARROWHEAD: a step quad at the barb. It is the one piece of
geometry an SS letter adds rather than resizes. Emit it always, degenerate
(barb width equal to the shaft) where the residue is not a strand, and the barb
width becomes a third station scalar - so the arrow grows out of the ribbon
instead of appearing.

## What it costs, and the choice

    everything at the loop's rate   449 -> 395 stations   -12%
    everything at the helix's rate  449 -> 605 stations   +35%

The first is cheaper and coarsens helices, which is what `HELIX_SUB = 8` exists
to prevent - a helix turns about 100 degrees per residue and the comment above
`MIN_SUB` says a single sample per residue collapses it to a zigzag. The second
keeps every helix exactly as it is drawn now and pays 35% more stations on the
rest of the chain.

🔴 **AND NEITHER IS FREE OF THE 2D PAINTER.** This geometry is shared: the
same prims feed the 2D cartoon, so changing the sampling changes the shipped
drawing on both paths. It has to be gated on pixels, not on counts - the
station gates in this suite compare a picture against a rebuild, and what this
needs is a picture against the CURRENT sampling.

## What it would be worth

The blocker it removes is the one measured on _traj_9fog.pdb: **nine of eleven
declines are "the station mapping moved"**, seven of those being the station and
piece counts (20963/9402 against 20969/9404) - which is exactly the drift this
makes impossible. A step there is 124 ms and every step rebuilds. On the
trajectories the page draws as cartoons by itself it is the 38% the partial
rebuild was scoped for, without the partial rebuild: no splice, no windows, no
index shifting, because nothing moves.

And it is strictly better than the partial rebuild for the reported case,
because the pieces themselves stop changing rather than being patched.

## The order to do it in

 1. **A pixel gate for the sampling**, before anything: the current drawing at
    the current constants against itself, on a protein, a sheet-rich structure
    and a nucleic chain. Without it every step below is unmeasurable.
 2. **Uniform sampling**, one constant, behind a flag. Measure the pixels and
    the station count on the three.
 3. **The arrow always emitted, degenerate off-strand.** That is the +1, and it
    is the only face-count term left.
 4. **Assert the invariance**: force every letter through the `sse` override on
    a fixture and require the counts not to move. That is the gate the whole
    idea rests on and it is three lines of the probe already written for this
    measurement.
 5. **Only then the axis**: let the assignment produce a fractional letter and
    interpolate `hw`, `ht` and the barb. The renderer needs no new concept - it
    is reading two floats it already reads.


## Starting with helices and loops, and the helix's zero thickness

Two steers from outside: do the HELIX/LOOP merge first and leave sheets, which
have an arrowhead, for later; and "depth of 0 for helicals can complicate
things, maybe default that to 1.0". Both are measured here.

### Helix and loop: one constant, and it is SHEET_SUB

`tests/ss_axis.py` forces letters through the `sse` override and reads the
counts off the installed table. At the shipped constants, on 1UBQ and 3CHY:

    one helix residue -> C     stations -3   pieces -2   faces -4
    a whole helix run -> C     stations -33  pieces -22  faces -44
    one loop residue  -> H     stations +3   pieces +2   faces +4
    one helix residue -> E     stations -3   pieces -2   faces -3

🔴 **AND THE LOOP'S CONSTANT IS NOT `SUB`.** Raising `SUB` 6 -> 8 changes
nothing at all - the deltas are identical - because a loop goes through the same
branch as a strand: `subFloor(t0 === 'H' ? HELIX_SUB : (FLAT_SHEETS ? SHEET_SUB
: 2))`. `SUB` is a different path. **`SHEET_SUB` is the loop's rate**, and
raising that one constant 6 -> 8 gives:

    one helix residue -> C     +0  +0  +0
    a whole helix run -> C     +0  +0  +0
    one helix residue -> E     +0  +0  +1     <- the arrowhead, as expected

So the helix/loop pair is ONE CONSTANT from being an axis, and the sheet's
residue is exactly the arrow the steer set aside.

### What it costs

    everything at the helix's rate (SHEET_SUB 8)   449 -> 605 stations   +35%
    everything at the loop's rate  (HELIX_SUB 6)   449 -> 395           -12%

    the picture, SHEET_SUB 6 -> 8:
      1UBQ  7.015% of pixels moved, worst 204
      3CHY 18.753%                  worst 218
      1AOI 11.807%                  worst 134

🔴 **AND MOST OF THAT IS THE PIECES, NOT THE SHAPE.** Pieces go 196 -> 300 on
1UBQ, +53%, because a piece is cut where a surface turns over and there are more
subdivisions to cut at. The centre line is the same curve sampled finer; what
moves is the outline's segmentation. That points at a third option nobody has
measured: raise the sampling AND cut fewer pieces, which
`tests/station_foldcuts.py` already prices at 0.0000%-0.0327% for the cuts it
knows about.

### The helix's zero thickness

`RICH_TH_REL = { H: 0, E: 1.0, C: 1.0 }`. A Richardson helix is drawn at zero
thickness, so its two broad faces are COINCIDENT and its two width bands have no
area. That is the degeneracy behind:

  * the interior weld's `flatPair` exemption - welding coincident quads would
    delete both faces of every helix, which it once did;
  * the coincident broad pair the depth test has to break a tie on;
  * `nLenOf < 1e-6`, the zero-area face skip;
  * and, for an axis, a singularity in the middle of the interpolation.

**It does NOT touch the topology.** Measured at 0.05, 0.12, 0.35 and 1.0, the
counts are 449/196/1019 every time - identical to zero. So this is independent
of the sampling question and can land on its own.

**But it is not a small look change at any value:**

    helix thickness   1UBQ            3CHY
    0.05              6.572%  w147    18.093%  w164
    0.12              6.893%  w208    19.312%  w207
    0.35              7.034%  w212    20.392%  w222
    1.0               7.379%  w219    23.131%  w222

Even 0.05 moves 6.6% and 18%. The face COUNT does not change - the width bands
are already there - they are simply zero-area today, and any thickness at all
gives every helix two visible side faces and the outlines that go with them.
There is no "small floor" that keeps the flat look: the cliff is at zero.

So it is a real trade, not a free repair: a cleaner geometry - no coincident
pair, no weld exemption, no singularity in the axis - against the flat helix
that is what the Richardson preset IS.


## The helix/loop merge: it works, it is not enough, and the gate said so

`SHEET_SUB` 6 -> 8 - one constant - makes an H <-> C flip move **+0 stations,
+0 pieces, +0 faces**, whole runs included (`tests/ss_axis.py
--require-invariance`). And it pays:

    rebuilds on _traj_1tim.pdb   23 of 40  ->  15 of 40
    a step                       12.00 ms  ->   8.90     1.80x against origin/main
    a step that rebuilds         14.00     ->  16.30     (+35% stations to build)
    a 1AOI load                    348     ->    380

A third of the rebuilds gone, and the step a quarter faster despite each
remaining rebuild costing more.

🔴 **AND IT DRAWS A STALE PICTURE.** `tests/station_unpinned.py`:

    _traj_1tim.pdb: an unpinned fast step drew 0.1529% of the frame
    differently from the same frame rebuilt, at a worst of 134

That is the invariance turning against itself. With the counts held still,
`stationsMatch` says "the same mesh" across a change of LETTER - and the letters
drive data baked into the instance row at build time:

  * the colour, and the palette slot it is looked up by;
  * `fullOutline`, which is `rich && ss === 'E'` - a Richardson strand is
    outlined all the way round and a loop is not;
  * the two-tone helix flag;
  * `sheetA` / `sheetB`, and the arrowhead's step quads.

The WIDTHS follow the frame because they are station data. None of the above
does. So the fast path drew this frame's shape with the last assignment's
flags, which is precisely the fault class the station path exists not to have.

**Reverted.** `SHEET_SUB` is 6 again, and the constant carries the whole story.

🔴 **AND station_foldcuts FAILED TOO, WHICH IS ITS OWN FINDING.** At the raised
rate the fold cuts stop changing the piece count at all - 300 with them and 300
without - so that gate's premise ("the flag has to do something") no longer
holds. Something else is already cutting where they would. Worth understanding
before the sampling is raised again, because it says the piece structure at
nsub 8 is not the piece structure at 6 with more samples.

### What it needs before it can go back to 8

Not more invariance - that part is done. The SS-dependent per-face data has to
follow the frame the way `hw` and `ht` already do. Two routes, and the first is
much cheaper:

 1. **Let the station path notice a letter change and REFRESH rather than
    rebuild.** The colour and the slot are a palette texture upload -
    `recolour()` - which is the one call a rebuild makes that a station update
    does not. `sseKey` is already in the rebuild signature, so the letters are
    already visible at the seam. This covers the colour half.
 2. **Move the remaining flags into the station row**, which is rewritten every
    frame: `fullOutline`, the two-tone flag, `sheetA`/`sheetB`. They are one
    float each and the row has room. That covers the geometry half - and it is
    the same move that makes the letter an AXIS rather than a switch, because
    a flag read per frame can hold a fraction.

Only then is the letter interpolable, which is what the whole idea was for.


## The second obstacle: the CENTRE LINE moves too, and the old gate could not see it

With the sampling made uniform and the two-tone candidacy read fresh, the
remaining gate to fall was `tests/cartoon_station.js`, which has carried this
assertion since long before any of this:

    pinning the secondary structure moved the ribbon CENTRE by 0.3367 A.
    A helix and a loop are supposed to differ only in profile; if the centre
    line moves too, an SS change cannot be morphed and has to be rebuilt

🔴 **AND IT READ 0.0000 A BEFORE, FOR THE WRONG REASON.** The comparison walks
the two centre lines station by station, and where the counts DIFFER it falls
back to comparing the endpoints alone - which always match, because "the ends of
an interval are the same two points however densely it is sampled". A helix is
sampled at 8 and a loop at 6, so the counts always differed and the test never
looked at the interior. Make them equal and it does:

    SHEET_SUB 6 (shipped)   centre moves 0.0000 A   (endpoints only)
    SHEET_SUB 8             centre moves 0.3367 A   (every station)

So the 0.0000 was the sampling hiding the answer, and the answer is that a helix
and a loop **do not share a centre line**: the helix branch uses helix-exact
tangents (a two-term stencil) and everything else uses Catmull-Rom, and over the
same residues those differ by a third of an Angstrom.

### What that means for the axis

Two obstacles, not one, and only the first is solved:

 1. **The sampling.** One constant, `SHEET_SUB` 6 -> 8, and an H <-> C flip
    moves +0 stations, +0 pieces, +0 faces. Done and measured.
 2. **The tangent construction.** The centre line jumps 0.34 A when a letter
    changes. To interpolate a letter you have to interpolate the CURVE, which
    means blending the helix-exact stencil with Catmull-Rom by the letter's
    fractional value - not a constant, a change to how the centre line is built.

That second one is not a blocker on the idea; it is the shape of the work. And
it is worth knowing that a morph would look better for it: a helix that becomes
a loop would have its centre line travel rather than jump.

### What was kept from the attempt

`SHEET_SUB` is 6 again and the constant carries the whole story. Kept:

  * **the two-tone candidacy in the piece table.** `facesOf` bakes it into
    `colMode` as a test on `p.ss`, so a frame whose assignment drifted since the
    build drew the last assignment's helices. Invisible today only because a
    letter change also changes the station count and forces a rebuild - it is
    latent, and it is one float in a slot that was already spare and already
    rewritten every frame. The shader reads it beside `aKFresh`, which is there
    for exactly the same reason.
  * **the fold-cut counters**, and both gates that used the piece count as a
    proxy for them now assert the property itself: the mesh build must not scan
    for fold cuts, and the arm that asks for them must. At the shipped sampling
    the proxy still works; at a finer one it does not, and a gate that cannot
    tell "the flag never arrived" from "it arrived and found nothing" is not a
    gate.


## AND IT WORKS: the axis is the PROFILE, not the letter

"It doesn't need to be exactly the same, some variations are fine" - which
reframes the whole thing, because the two obstacles above are both properties of
changing the LETTER:

  * the sampling: a helix is sampled at HELIX_SUB and everything else at
    SHEET_SUB, so the letter changes how many stations a residue carries;
  * the centre line: a helix's tangents come from a two-term stencil and a
    loop's from Catmull-Rom, so the letter moves the curve by 0.34 A.

**Neither applies if the letter stays put and only the PROFILE moves.** A letter
chooses two numbers - a half-width and a thickness ratio - and nothing else in
the ribbon's construction reads it. So `ssMorph` interpolates those two toward
the loop's values and leaves the letter alone.

    window.py2dmolSsMorph = { H: 0.5 };   // helices, half way to a loop

🔴 **AND THE FIRST VERSION OF THIS CLAIM WAS FALSE, WHICH A READER SPOTTED FROM
THE PICTURES.** "Zero rebuilds, identical topology, and the picture changes at
every step" - the first two were true and the third was not. Measured after the
fact, the two ends of that strip differ by **0.000% of pixels, worst 0**. The
morph was in geom.js and never reached the card, because it was in no signature:
`renderApp` compared `sig` with `appSig`, found them equal, took the early-out
and drew the resident mesh unchanged. Zero rebuilds meant zero effect.

The repair is one entry in `signatureOf`, in the same list as
`cartoonThickness` and `cartoonSheetFlat` and for the identical reason - it
moves the per-station half-width and half-thickness and nothing else, so it
belongs in the full signature and NOT in the topological one, and the station
path answers it with two texture writes instead of a rebuild.

Measured again on `_traj_1tim.pdb`, station table installed, **no invalidate
between steps**:

    morph 0     stations 3183  pieces 1456  faces 6927   mesh rebuilds: 0
    morph 0.25  ...same...                               mesh rebuilds: 0
    morph 0.5   ...same...                               mesh rebuilds: 0
    morph 0.75  ...same...                               mesh rebuilds: 0
    morph 1     ...same...                               mesh rebuilds: 0

    the picture, against morph 0:  4.296%  6.132%  7.447%  8.439%

**Zero rebuilds, identical topology, and now the picture really does move** -
monotonically, the helices narrowing from flat ribbons to thin loops. The widths
ride the station table, which is rewritten from the prims every frame anyway, so
the axis costs one multiply per station per frame and nothing else.

🔴 **AND A FULL-FRAME SCREENSHOT IS THE WRONG INSTRUMENT FOR IT.** At the zoom a
whole protein is drawn at, the change is a few pixels of ribbon width and the
strip reads as five identical pictures - which is exactly how the false version
above survived being looked at. The demo magnifies 2.4x on the middle of the
frame, and a pixel diff between panels is what says whether anything happened at
all.

🔴 **IT IS OFF UNLESS SET.** `ssMorphOf` returns 0 when the global is null and
the callers take the unmodified value, so the shipped drawing is untouched -
`tests/station_pixels.py` and the node lane say so.

### What this does and does not buy

It does NOT eliminate the rebuild when the ASSIGNMENT drifts on a trajectory -
that is still a change of letter, and still the two obstacles above. What it
buys is the thing that was asked for: a continuous control over how helical a
helix looks, at no cost, which is also the missing half of a real morph. When
the letter itself becomes interpolable - uniform sampling plus a blended tangent
stencil - this is what it will drive.


## The step where a helix meets a loop, measured

Reported from use: a cut point between a helix residue and a loop residue -
"shouldn't it be continuous?" - and noted as pre-existing, which it is.

**It is a width STEP at a shared station, not a positional gap.** Two pieces
that meet do meet: they share the station exactly (that is the cross-piece
coincidence stage 1 of the edge plan measured, 9,973 of 10,021 classes). What
they do not share is the PROFILE. Reading the station table back off the card on
1BBH:

    1,886 stations, 902 places where two or more pieces meet,
    12 of them with different profiles

    half-width jumps 0.06 -> 0.967 A   (an arrow tip against a helix)
    half-width jumps 0.35 -> 1.1   A   (a loop against a strand)
    half-width jumps 1.1  -> 1.65  A   (a strand against its own arrow barb)

Twelve, on a structure with about that many secondary-structure boundaries. So
essentially every boundary steps, by up to 0.9 A of half-width - 1.8 A of ribbon
- in the space of nothing.

🔴 **AND NOTHING FILLS THE STEP, BECAUSE THERE ARE NO CAPS.** The ribbon part
emits **zero cap faces** (`tests/edge_phases.py` prints it: "3,912 rib, 0 cap").
Between two pieces of equal width that is right - the surfaces join and a cap
there would be interior, and the weld would drop it anyway. Where the widths
differ it leaves the wider piece's side ending in mid-air.

Confirmed two ways. The morph: with helices at a loop's width the helix-side
steps leave the list, because both sides then agree. And a picture - a
24-residue CA trace, 14 residues forced helical through the `sse` override and
10 straight, magnified on the junction - where the wide ribbon visibly stops
dead against the thin one.

### What a fix would be

 1. **Taper the width across the boundary interval**, so the two pieces evaluate
    the same half-width at the station they share. That is what makes it
    continuous, and it is what most cartoon renderers do. The cost is that a
    helix no longer holds full width to its last residue - the taper has to
    live somewhere, and either the helix gives up half of it or the loop
    widens.
 2. **Emit a cap at a width-mismatched junction.** Keeps the hard shoulder and
    fills it, so the ribbon is closed rather than open. Cheaper to reason about
    and it does not move any existing surface, but it is a step with a lid
    rather than a continuous ribbon.

Option 1 is the one the report asks for. Neither is started, and either changes
the shipped drawing everywhere a letter changes, so both want a pixel gate
before a line is written.


## ONE RIBBON PATH: pretend everything is a helix, and let the profile differ

The idea from outside: build every letter the same way and let a loop differ
only in width, thickness and the inner/outer colouring. It is right, and the
whole difference turned out to be `t0 === 'H'` in exactly two places - the
sampling and the tangent stencil. Everything downstream was already shared.

Both obstacles fall at once:

    with two paths                     with one
    H <-> C moves 3 stations,          +0 stations, +0 pieces, +0 faces
      2 pieces, 4 faces                  (whole runs included)
    the centre line moves 0.3367 A     0.0000 A

🔴 **AND THE 0.0000 IS A REAL ONE NOW.** `tests/cartoon_station.js` compares the
two centre lines station by station and falls back to the ENDPOINTS where the
counts differ - which always match. With two paths the counts always differed,
so it never looked at the interior and read 0.0000 for the wrong reason. With
one path the counts match, it compares everything, and it still reads 0.0000.

### What it costs, and what it gives back

    stations   1UBQ 449 -> 605   3CHY 823 -> 1,021
    pixels     1UBQ 7.799%  3CHY 21.220%  1AOI 12.506%

Everything is sampled at `HELIX_SUB` now. But the pixels are not a
degradation: the loops were the coarsely sampled ones, and side by side the
loops stop FACETING - the polygonal kinks along a coil are gone - while the
helices and the strands do not move. The helix-exact stencil is a smoothing
filter fitted to 100 degrees a residue; on a straight run it is very nearly
linear, which is why the strands are untouched.

    a step        16.10 -> 10.40 ms   1.55x against origin/main
    rebuilds      15 of 40, where origin/main rebuilds 40 of 40
    a rebuild     16.10 -> 17.10      (the extra stations)
    a 1AOI load      451 ->    349

All three lanes green.

### What is still open

  * **The width step at a boundary.** One path does not fix it - the widths
    still differ per letter, so two pieces still meet with different profiles
    and nothing caps the difference. But a taper is now WRITEABLE, because both
    sides are built the same way and share their station exactly.
  * **The arrowhead**, which is still one face a strand adds rather than
    resizes: `H -> E` moves +0 stations, +0 pieces and +1 face.
  * **The letter is still discrete.** Making it fractional now needs only the
    profile to interpolate, which `ssMorph` already does - what it does not yet
    do is come from the assignment rather than from a control.


## Does a helix/loop flip still rebuild? Measured: 10 of 15 do

With one ribbon path the counts hold still across a letter - that is what
`tests/ss_axis.py --require-invariance` asserts, forcing letters through the
`sse` override on a static structure. It does NOT follow that a trajectory whose
assignment drifts stops rebuilding, and it does not:

    _traj_1tim.pdb, 29 steps
      10 rebuilt
      15 steps where the assignment changed - of those, 10 rebuilt

🔴 **AND THE REASON IS THE THIRD MEMBER OF THE SAME FAMILY.** `stationDecline`
names it, read at the moment of the decision:

    the station mapping moved: face 5419 of 7951 moved from station 2690 to 2691
    the station mapping moved: face   69 of 7951 moved from station   32 to   34
    the station mapping moved: 3952/1968 stations and pieces against 3951/1968

The COUNTS are invariant and the MAPPING is not. A piece is cut at a
secondary-structure boundary, so when a residue flips, the boundary moves, the
faces after it are renumbered by a station or two, and `stationsMatch` - which
compares `faceStation` element by element, not just its length - correctly
refuses. Sometimes the station count moves by one as well (3952 against 3951),
which is the same cause a level up.

🔴 **AND READING THE DECISION IS ITSELF A TRAP, TWICE OVER.** `setFrame` renders,
so a probe that renders again and then asks has already lost the answer: both
`stationDecline()` and the gate flags then describe the state the SECOND render
left, and every step reports `sigSame` - the decision after it was made. The
reading has to be taken between `setFrame` and anything else. The first two
versions of this measurement said "10x no reason recorded" and "10x sigSame",
which are both wrong and both plausible.

### The next step, and it follows from the same idea

**Do not cut pieces at a secondary-structure boundary.** The cut exists because
a piece carries averaged frames and per-piece flags, and because the 2D painter
sorts by piece - but with one construction for every letter and the flags
already moving to per-frame data (the two-tone candidacy is in the piece table
now), the reason has thinned. Cut at chain breaks and at genuine geometry, and a
letter change moves no boundary, renumbers no face, and `stationsMatch` has
nothing to refuse.

That would be the last of the three: sampling (done), tangents (done), piece
cuts (open).


## "Don't cut pieces at SS boundaries" - measured first, and it is already true

Asked for directly, and the right move was to check the premise before writing
it. `tests/ss_axis.py` now compares what `stationsMatch` actually compares -
`faceStation` and `facePiece` ELEMENT BY ELEMENT, not just their lengths,
because a mapping that keeps its totals and renumbers underneath still refuses.
With one ribbon path, on 1UBQ:

    one helix residue -> C     +0 +0 +0    0 faces changed station, 0 changed piece
    a whole helix run  -> C    +0 +0 +0    0 / 0
    helix run grown by one     +0 +0 +0    0 / 0
    helix run shrunk by one    +0 +0 +0    0 / 0
    one helix residue -> E     +0 +0 +1    (lengths differ - the arrowhead)

🔴 **AND THE RUN-BOUNDARY ARMS ARE THE ONES THAT MATTER.** The first version of
this test flipped a residue in the MIDDLE of a run, deliberately - and a
trajectory does not do that. An assignment drifts at the ENDS: a helix gains or
loses its last residue, and everything decided per run moves with it. Growing
and shrinking a run reads +0 too.

So there is no piece cut at a helix/loop boundary to remove. The work asked for
is already done, by the one-path change.

### What the trajectory's remaining rebuilds actually are

`_traj_1tim.pdb`, 29 steps, with the decision read between `setFrame` and
anything else:

    10 rebuilt, all of them assignment-only - the segment list never moved
     9 of the 10 involved a STRAND letter (C->E or E->C)
     1 did not (H->C)
     5 steps changed the assignment and did NOT rebuild -
       and their letters are exactly C->H and H->C

**Helix and loop are free now.** Five of the six steps that only moved H and C
took the fast path. What rebuilds is the strand, and the reason is the one thing
`ss_axis` still reports as moving: the ARROWHEAD, a face a letter creates
rather than resizes.

That was set aside at the start of this - "then we can think about sheets (that
have an arrow)" - and it is now the whole of what is left. Emitting the arrow
always, degenerate off-strand, so its barb width becomes a third station
scalar, would make `C <-> E` as free as `C <-> H` is.


## The prediction, tested: a helical bundle animates almost without rebuilding

If helix and loop are free and the strand is not, then a structure with no
strands should animate with essentially no rebuilds. `_traj_1bbh.pdb` - a
four-helix bundle, 20 models, breathing at 0.25 A:

    19 steps, 3 rebuilt
      1  the first frame, which has no previous key to compare against
      2  the station mapping moved: 2082/1040 against 2084/1040

    steps where the assignment changed: 2, and BOTH of them rebuilt
    the letters on those steps: C->E and E->C

**Sixteen of nineteen steps changed nothing and rebuilt nothing.** The two that
did are the same fault as everywhere else - a strand letter appearing and
vanishing - and the third is the first frame.

🔴 **AND "A HELICAL BUNDLE" DOES NOT MEAN "NO E EVER".** The assignment finds a
transient strand as the structure breathes: two frames out of twenty on a
protein with no sheet in it. So the arrowhead is not a sheet-protein problem
that a helix-only viewer can ignore - it reaches any structure whose assignment
is recomputed per frame, which is every trajectory.

Against _traj_1tim.pdb, a TIM barrel with eight strands, for contrast: 29 steps,
10 rebuilt, nine of them a strand letter.


## Sheets as flat wide loops, and the arrow as an add-on: what the arrow costs

The idea from outside: treat a sheet as just a flat wide loop - the same
construction as everything else, which it now is - and think of the arrowhead
as an ADD-ON rather than part of the ribbon.

**The premise is measured and it holds.** Turning arrows off with
`renderer.cartoonArrows = false`:

    _traj_1tim.pdb, 29 steps
      arrows on    10 rebuilt   (nine of them a strand letter)
      arrows off    0 rebuilt   - and all 15 assignment changes went through
                                  the fast path

So the arrow is the SOLE remaining cause. A sheet's shape is already free; a
sheet's arrow is not.

### What an arrow costs, and it depends on the sampling parity

    Detail 3 (odd nsub)   arrows add +60 stations, +30 pieces, +135 faces
    Detail 4 (even)                  +15,          +0,          +75
    Detail 8 (even)                  +15,          +0,          +75

The head is half a CA-CA step long, so at an EVEN subdivision count it starts on
a station that already exists and adds no piece; at an odd one it does not and
splits a piece as well. What is left at even sampling is **one station and five
faces per arrow** - fifteen arrows on 1TIM.

🔴 **AND THE SEAM CUT IS NOT THE COST.** The barb's hard back edge is
`cutSet.push(seamIdx)`, and dropping it changes nothing at all: 3951/1968/7951
either way, 10 rebuilds either way. The cost is the interval SPLIT the head
needs, not the cut that shapes it.

### Three ways to make it topology-free, with what each costs

 1. **Always emit the arrow, degenerate off-strand**, so its barb width becomes
    a third station scalar beside `hw` and `ht`. Airtight and morphable. But
    the candidate positions are secondary-structure run ENDS, which are
    themselves a function of the letter - so it has to be every RESIDUE:
    +500 stations and +2,500 faces on 1TIM, **+13% and +32%**.
 2. **Move the arrows into the tail**, the part `refreshSticksFrom` rewrites
    per frame outside the station table. Attractive until you look:
    that refresh writes back over spans it validates first, so a changing
    arrow count changes the span sizes and it refuses - which is a rebuild
    again.
 3. **Give the arrow's existence hysteresis** - a letter has to hold for
    several frames before an arrow appears or goes. Does not make it free,
    makes it RARE, and it is aimed straight at what was measured: the two
    frames in twenty on a helix bundle where a transient strand appears and
    vanishes. It is also the same medicine the assignment's own flicker wants
    (see the note on the segment count oscillating 3336 -> 3337).

Option 1 is the principled one and costs a third of the face count. Option 3 is
cheap, is not a lie about the geometry, and removes most of the rebuilds that
actually happen. Neither is started.


## The arrow is already a user option, and it is the rebuild switch

Asked for an option to enable arrows. There is one and there has been: **Arrows**
in the cartoon controls, `renderer.cartoonArrows`, on by default. What was
missing is that nobody could know what it now decides.

Driven through the checkbox itself rather than the field, on `_traj_1tim.pdb`:

    arrows on   29 steps, 10 rebuilt; 15 steps changed the assignment
    arrows off  29 steps,  0 rebuilt; 15 steps changed the assignment

Both arms see the same four transitions - C->E, C->H, E->C, H->C - and with the
arrowheads off not one of them costs a rebuild. The tooltip says so now, because
"arrowheads on the C-terminal end of each beta strand" gives no hint that it is
the difference between a trajectory that rebuilds and one that does not.

`tests/arrow_rebuilds.py` is the gate, and it runs BOTH arms in one page:

  * with arrows ON something must rebuild, or the zero in the other arm is not
    attributable to the arrowhead - it would read the same if the station path
    had simply given up;
  * with arrows OFF nothing may, which is the claim;
  * and the assignment must actually change in both arms, or neither number is
    about anything.

## The morph slider is gone, and what it proved is not

The temporary **Morph** control, `window.py2dmolSsMorph` and the two mixes it
drove in `cartoon/geom.js` are removed. It was built to look at, it was looked
at, and a control with no serialisation, no Python API and no preset behind it
is a thing the config, the session and the archive would each eventually have to
learn about for a demonstration that is over.

🔴 **WHAT IT PROVED IS IN THE RIBBON, NOT IN THE SLIDER, SO NONE OF IT LEAVES
WITH IT.** The finding was never the interpolation - it was that a letter picks
a PROFILE and nothing else: a half-width and a thickness ratio, both per station,
both rewritten from the prims every frame. The station count, the piece cuts and
the face list do not read the letter. That is why one ribbon path could replace
two, and why `tests/ss_axis.py` measures **+0 stations, +0 pieces, +0 faces and
0 mapping changes** for a helix becoming a loop. Those numbers are the result;
the slider was only how it was first seen.

The two comments that carried the reasoning were rewritten rather than deleted,
in `cartoon/geom.js` beside `halfW` and in `paintgl.js` inside `signatureOf` -
the second one now states the general rule the morph was one instance of: **a
knob that moves only per-station geometry belongs in the full signature and out
of the topological one.** Put it in the topological key and it rebuilds for
nothing; leave it out of both and `renderApp` takes the `sig === appSig`
early-out and the picture does not move at all, which is what cost a first
measurement of the morph its meaning - five values, 0.000% of pixels, and "zero
rebuilds" that meant zero effect.

What is unchanged by the removal: the one ribbon path, the helix's 0.2 thickness
ratio, `tests/ss_axis.py`, `tests/arrow_rebuilds.py`, and the fact that the
arrowhead is the only remaining reason a trajectory rebuilds.

## A cleanup round, and the one thing it actually found

Four sweeps, three of which found nothing, which is worth recording so nobody
runs them again for a while:

  * **Dead top-level names in `src/`**: one, `applyInverseTransform` in
    `align/align.js`, and it is inside the `>>> GENERATED` block that is a copy
    of the TM-align port. Deleting it would diverge from its generator. Left.
  * **Flags a probe sets that the source never reads**: two, both dead writes
    rather than broken probes - `__oneRibbonPath` in `ss_axis.py`, left over
    from when the ribbon had two paths, and `__hashBisect` in
    `gpu_mesh_reuse.py`. Everything else a probe sets is either read by the
    source or its own scaffolding.
  * **`tests/out`, 143 MB**: a download cache - 89 MB of it is `pdb/` - and
    gitignored. Not cruft; deleting it costs re-downloads.
  * **Duplicated blocks in `src/`**: the survivors are `panels/msa.js` and
    `align/align.js`, both pre-existing and both algorithmic. Not this round's
    business.

🔴 **WHAT IT DID FIND WAS A GATE THAT COULD NOT FAIL, AND A PROBE SURFACE THAT
WAS EMPTY.** `tests/ss_axis.py` was in no lane of `run.sh`, and its assertion
was behind `--require-invariance` because the counts really did move when it was
written. Both were stale. Put a second sampling rate back into `geom.js` - the
exact regression the file exists for - and it printed `+3 stations, +2 pieces,
+4 faces` and **exited 0**.

Making it assert needed a new witness, because "something moved" cannot be
evidence when holding everything still is the property. The station pad - the
per-station half-width and half-thickness - is the right one: it is exactly what
a letter is allowed to change. It read **zero floats moved**, and the reason was
in the renderer rather than the probe:

    installStations -> mkTex built the padded texture copy and dropped it
    updateStations  -> put() keeps it, as residentStations.stationPad

So `stationPad` was empty on any mesh that had never taken the fast path, which
is every mesh a probe builds and reads in one step. `installStations` keeps it
now - the same array `updateStations` would have allocated on the first fast
frame, so nothing is added at the peak, and the fast path reuses it instead of
allocating. Both paths leave the same thing behind.

Falsified twice: green as shipped, exit 1 with the second sampling rate back.

🔴 **AND THE SUITE HAD OUTGROWN ITS OWN MAP.** Sixty-nine of about ninety probes
were named nowhere in `tests/README.md`. `tests/index.py` generates one line per
probe from its docstring with the lane `run.sh` runs it in, and `--check` is in
the node lane. Twenty-four read `tool`; all twenty-four are benches, fitting
scripts or by-hand demonstrations, so nothing else is stranded.

The rule this leaves: **a probe outside every lane is a probe nobody runs, and a
gate whose assertion is behind a flag is a gate that is off.** Both were true
here at once, of the same file.

## The arrowhead stops costing a rebuild

After the ribbon got one construction for every letter, the arrowhead was the
only thing left that a change of secondary structure could CREATE rather than
resize - and so the only reason a trajectory whose assignment drifts still
rebuilt: 10 of 29 steps on `_traj_1tim.pdb`, against 0 with arrows off.

It was two things, not one, and the second was invisible until the first was
fixed:

| what | steps rebuilt, 29 |
|---|---:|
| as it was | 10 |
| the seam's second sample paid for out of the interval's own budget | 8 |
| ...and the strand's blunt start made a width ramp | **1** (the first step, which has no previous key) |

🔴 **THE SEAM.** An arrowhead samples its interval's seam TWICE - once at shaft
width, once at barb width - so the step across the barbs is perpendicular rather
than slanting over a sub-interval. That second sample was ADDED to the interval:
`nsub + 2` stations where every other interval has `nsub + 1`. A station is
topology. Reallocating instead of adding - the shaft and the barb divide the
same budget, and the duplicate comes out of it - leaves the count fixed whatever
the letter is, at the cost of one chord of arc resolution in the one interval
that carries a head.

🔴 **AND THE ODD SAMPLE GOES TO THE BARB, WHICH IS BACKWARDS FROM THE OBVIOUS
ARGUMENT.** The barb's edges are a linear taper, so two stations describe them
exactly and the shaft "should" take the remainder. The centre line under the
barb is the strand's, though, and a chord is a chord wherever it falls. Measured
on 1UBQ, as the worst centre-curve movement in an interval that gains a head:

    shaft takes the remainder (round)   0.2151 A
    barb takes the remainder  (floor)   0.1146 A

and the whole-frame difference against `origin/main`'s drawing halves with it,
0.592% of the pixels to 0.337%.

🔴 **THE BLUNT START, WHICH WAS A CAP FACE.** A strand begins at full width
rather than ramping up to it, so its first cross-section is a real rim and got a
flat end face - "without it you see straight into the hollow back of the sheet
at its N-terminus". A cap is a FACE, and a face that appears when a residue
becomes a strand is a rebuild.

The rim is made the way the barb step is made instead: **the station at u = 0 is
duplicated**, one copy holding the previous residue's profile and one the
strand's, and the zero-length band between them IS the end. Its four trapezoids
close it - the two side faces are the end wall proper, spanning the width step
over the full thickness - so there is nothing hollow left and nothing for a cap
to close. Out of the interval's own budget, like the seam, so the station count
does not move.

🔴 **AND A RAMP WAS TRIED FIRST, AND LOOKED WRONG.** Ramping the width into the
strand over a quarter of a residue also removes the step and the cap, and it is
one line rather than twenty. But a blunt end is *blunt*: at the default Detail
the chamfer is 0.95 A of visible diagonal, and side by side against the shipped
drawing it reads as a strand that has been sliced at an angle. Asked for, and
right: **the C-terminal box shape is part of what an arrow IS.** The duplicate
costs one chord of arc resolution in that interval and keeps the square end
exactly.

🔴 **AND THE THRESHOLD FOR IT WAS WRONG AT THE FLOOR, WHICH IS WHERE IT SHOWED.**
The duplicate was gated at three sub-intervals, so **Detail 2 fell through to
the ramp and drew the chamfer at the one setting where it is most visible** -
0.964% of the frame - while the stations to do it properly were already there.
The arithmetic is stations, not a guess: with `seg = nsub - dups` the rim wants
`seg >= 1` (its duplicate sits at u = 0, so `[0, 0, 1]` is a complete
blunt-ended interval and three stations is enough) and the seam wants `seg >= 2`
(it sits in the middle and needs a shaft and a barb). Thresholds: 2 for the rim
alone, 4 for an interval carrying both.

**What is still not free at Detail 2 is the HEAD.** Three stations cannot hold
`0, seam, seam, 1`, so a strand appearing there still adds stations - measured
on 1UBQ as +5 stations, +2 pieces, +12 faces, which `tests/ss_axis.py
--detail=2` prints. Two ways out were considered and neither taken: drop the
seam's duplicate at that detail, which slants the arrow's back edge at the one
setting where it is most visible; or let the head take the whole interval, which
makes it a full residue long and jumps when the Detail slider moves. A rebuild
on a strand appearing at the lowest detail is the cheaper of the three.

🔴 **AND ss_axis HAD NEVER MADE AN ARROWHEAD.** Its `-> E` arm flips ONE residue,
and `isArrowInterval` wants `sec[j]` and `sec[j+1]` both `'E'` - so a
single-residue strand has no head, and the file measured the arrowhead by never
creating one. Every `+1 face` it reported for `-> E` was the blunt end's cap,
not the head. There is a `three helix residues -> E` arm now, which gives a
head, a shaft, a blunt start and a tip: **+0 stations, +0 pieces, +0 faces at
the shipped Detail.**

### The variant that was built, measured and not taken

Uniform sampling everywhere, with the arrowhead expressed ENTIRELY in widths -
no duplicate at the seam at all, the step realised as whatever slant one
sub-interval gives. It is the purest form of "a letter is a profile": the centre
curve then matches to **0.0000 A station for station**, with no exemption
anywhere, and the code loses a branch.

What it costs is the arrow's back edge. The shoulder steps 0.55 A sideways over
one sub-interval, which at the default Detail of 4 is 0.95 A along the curve -
about 60 degrees off perpendicular, a dart rather than an arrow - and it sharpens
with the Detail slider, which is not a property a drawing should have. Kept the
square shoulder; the numbers for both are here so nobody has to build it twice.

### What the letter still moved once the arrowhead did not

Two things, both found by tests/station_unpinned.py the moment the rebuilds that
were covering them stopped happening. Both are per-face data baked at build time
from `p.ss`, and the first had a fix pattern already in the file - the two-tone
candidacy, which rides the piece texture as `aCandFresh`.

🔴 **THE PALE SIDE OF A RICHARDSON STRAND.**
`edgeWhite = isSide && rich && (p.ss === 'E' || p.naRung)` paints a strand's two
side faces 244,246,240 and bakes `colMode` 2 to say so. A residue becoming a
strand without a rebuild left those sides the loop's colour. The piece row's
spare slot now carries BOTH letters as a bitfield - bit 1 the two-tone
candidate, bit 2 the pale side - because a piece row is eight floats and both
texels were full, and the shader takes them apart.

🔴 **AND THE OUTLINE'S EDGE SET, WHICH IS STILL BAKED.**
`fullOutline: rich && p.ss === 'E'` decides how many EDGES a face contributes,
and the edge table is built once with the mesh. A residue that stops being a
strand keeps the strand's creases until something else rebuilds. Measured on
`_traj_unfold.pdb` as the worst fast step against the same frame rebuilt:

    with the arrowhead still forcing rebuilds      0.0287%  (worst 112)
    with it free, pale sides baked                 0.7565%  (worst 172)
    with the pale sides carried per frame          0.1991%  (worst 146)

🔴 **AND 0.1991% WAS SHIPPED FOR AN HOUR AND WAS WRONG, because the number does
not say what it looks like.** It is under the gate's bar - a fraction of what a
step itself moves, and a step moves 35% of this frame - so it read as a blemish
worth trading for the rebuilds. It is not a blemish. The stale lines are
*outlines*, and the assignment drifts from frame to frame, so during playback
they switch on and off: reported from the other side of the room as "the outline
is flickering on/off", which is the first thing an eye finds. **A wrong line that
holds still and a wrong line that blinks are not the same defect at the same
percentage.**

So the strand SET is in the topological key: an E flip rebuilds, an H <-> C flip
- most of what an assignment does as a structure breathes - stays free, and
outside the Richardson preset the rule does not apply at all. Back to 0.0287% on
`_traj_unfold.pdb` and 0.0100% on `_traj_1tim.pdb`, and the first differing fast
step is **13 pixels**.

**What would remove the rebuild** is emitting every rich ribbon face's full edge
set and suppressing the creases per frame from the piece texture, the way
colMode now works. That roughly doubles the edge table for every structure, so
it is a trade rather than a fix, and it would take the arrow checkbox's rebuild
with it - the seam's ink flags are baked the same way.

🔴 **AND ONE MEASUREMENT IN FOUR WAS CONTAMINATED, because a shader that does
not link fails SILENTLY as a pixel difference.** The colMode substitution is
spliced into the vertex shader by string replacement, and the anchor was half of
a declaration:

    float aPal = aFlags2.x, aColMode = aFlags2.y;

Replacing the second half with anything that declares its own variable yields
`float aPal = aFlags2.x, float aCandBits = ...` and the program stops linking:
`0:221: 'float' : syntax error`. tests/station_shader.py says exactly that, and
it is the only probe that does. Everything downstream reported a PICTURE that
had moved - station_integrated at 15-20% of pixels, station_pixels dead - and,
worse, three probes in between reported plausible numbers taken through a broken
path: the 0.3493% above was first measured that way, and so was a "0.0471%"
that looked like a fix. **Run tests/station_shader.py first when a station
number moves in a way that surprises you**; it is two seconds and it is the only
one that can tell "the shader is gone" from "the picture changed".

### What the gates say now

  * `tests/ss_axis.py`: every arm is +0 stations, +0 pieces, +0 faces with the
    mapping unchanged - **including `-> E`, which used to be exempt**. The
    exemption is gone, because its reason is.
  * `tests/arrow_rebuilds.py`: inverted. It used to REQUIRE a rebuild with
    arrows on, or the other arm's zero was unattributable; now the two arms must
    rebuild the SAME number of times - today zero each - and the witness that
    the head is drawn at all is that they hold the same number of station floats
    with different values in them.
  * `tests/cartoon_station.js`: its centre-line leg compared station k with
    station k, which asks two questions at once - is it the same curve, and is
    it sampled in the same places. Only the first is the invariant. It measures
    point-to-polyline distance now, both ways, and exempts intervals within the
    window that decides an interval's own sampling: **i-1 to i+2**. Forward
    because `isArrowInterval` reads `sec[j]`, `sec[j+1]` and `sec[j+2]` - the
    head sits on a strand's LAST interval; backward because the rim sits on its
    FIRST, which is a question about the residue before it. Both bounds were
    found by widening: a two-residue window left 0.2043 A "unexplained" that was
    an arrow appearing two residues along, and a three-residue one left 0.0683 A
    that was a strand starting one residue back.
  * `tests/topology_survey.py`: `arrows` joins `richardson` in PROVEN_EXCEPTIONS,
    with its number. Taking `cartoonArrows` out of the topological key was
    measured through tests/station_controls.py: **0.0325% of pixels wrong at a
    worst of 138 against a 1.2078% effect, 2.7% of its own change**. The
    arrowhead's GEOMETRY is per-frame now; the INK flags that go with it -
    seam0/seam1/seamA, which say "do not draw a line across the shaft here" -
    are baked with the edge table, so toggling the checkbox without a rebuild
    leaves the inner arrow line.
  * `tests/station_rows.py` and `tests/splice_window.py` both failed for the
    same reason and it was not a regression: **they waited for rebuilds that no
    longer happen.** station_rows read the two derivations out of whatever build
    fell out of stepping a trajectory, and now none does, so it asks for one.
    splice_window counted the first step - which rebuilds because there is no
    previous key - as a decline, then failed because a decline that cannot have
    a plan had none; it excludes that step now and says "not exercised" rather
    than failing, and names what would exercise it: a trajectory whose
    CONNECTIVITY flickers, not one whose letters do.
  * `tests/paint_trace.json` re-recorded: only the three strand fixtures moved
    (E, hairpin, E-rich), about twenty ops each. Helices and nucleic acids draw
    the same stream they did.

🔴 **AND THE PICTURE COMPARISON NEEDED A SEEDED PAPER.** Two runs of the
IDENTICAL tree differ by **17.86% of the frame at a worst channel of 40**,
because the cartoon's tooth tile is built from `Math.random()` once per page
load (`geom.js`, `mkOctave`). Any before/after screenshot comparison has to
override `Math.random` with a fixed generator before the page loads, or it is
comparing paper. With that done, two runs differ by 0 pixels and the whole
change under test reads **0.604% of the frame** against `origin/main` - more than the ramp's 0.337%, because the rim is now drawn by the
band's own faces rather than by a cap face with its own colour and its
own ink rule.

## A beta protein rebuilds every step, and the fix is on a branch

`_traj_3ptb.pdb` - trypsin, a beta barrel - rebuilds **4 of 5 steps** during
playback, and every one of them is `strandKeyOf`: on a structure made of
strands, the strand SET moves whenever the assignment breathes. The key is there
because the outline's edge set is baked (see the flicker section above), so this
is the price of that fix, and on a beta protein it is most of the frames:

    _traj_3ptb.pdb   9.00 ms a step   against 6.30 on the fast path   (1.43x)

🔴 **THE REAL REPAIR IS SMALL AND IT ALMOST WORKS.** A strip's cross edge - the
one a Richardson strand draws and a loop does not - is ALREADY registered for
every face: `addEdge` takes it as a GHOST rather than skipping it, because the
cap that shares it needs a second normal. What the letter changes is only
whether that edge gets a ROW. So: give it a row either way, and let
`refreshEdgesFromStations` turn it on and off per frame from the piece texture -
which is the same function that already redoes the crease test every frame, for
the same reason ("a handful of outline segments flickering on and off through an
animation"). `always` -1 is clipped in the ink vertex shader before it costs a
fragment.

Measured, on the branch `wip/per-frame-outline`:

| | before | after |
|---|---:|---:|
| rebuilds in 5 steps, 3PTB | 4 | **0** |
| a step | 9.00 ms | **5.80** |
| edge rows, 3PTB | 4490 | 7024 (+56%) |
| fast frame against the same frame rebuilt | - | 0.0004% |

**The extra rows cost nothing measurable.** The upper bound was taken by drawing
every cross edge for real - 6.90 ms against 6.30 - and clipped rows come in
under that, at 5.80.

🔴 **AND IT IS NOT ON THE BRANCH BECAUSE OF A WRAP.** `tests/outline_sync.py`
fails on `_traj_1bna.pdb`: the first pass through the frames is exact (0.0002%)
and **every frame after the wrap differs by 2.34%** at a worst channel of 224,
over a box covering most of the picture. A nucleic structure has no strands, so
every revived row should sit at -1 and draw nothing; the wrap is doing something
else and it is not understood. Two things were already found and fixed along the
way, and the third is whatever this is:

  * an edge claimed by a CAP as well as by a strip's cross pair must never be
    turned off by a letter - the cap's outline is a property of the chain. That
    is `EB_ALONG`, and without it `_traj_1ehz.pdb` went 0.0004% to 0.0084%;
  * a cross edge is judged by the RICH crease threshold whether or not a face
    inked it at build, because the frame that turns it on is a frame where its
    piece is a strand.

The branch carries the code and the numbers. What it needs is the wrap
understood - `tests/outline_sync.py --play` exists for exactly that case and was
written when the first wrap fault was found.

## The flicker is the ASSIGNMENT, not the cache

Reported three times and chased through three different caching fixes, each of
which was real and none of which stopped it. The measurement that settles it
rebuilds the mesh **from scratch on every frame**, so no cache, no station
table, no reuse of anything is involved:

    _traj_3ptb.pdb, every frame invalidated and rebuilt

    frame  0   E residues  84   arrowheads 18   letters changed 0   outline edges 4490
    frame  1   E residues  82   arrowheads 18   letters changed 2   outline edges 4452
    frame  2   E residues  83   arrowheads 18   letters changed 3   outline edges 4474
    frame  3   E residues  83   arrowheads 18   letters changed 3   outline edges 4474
    frame  4   E residues  84   arrowheads 18   letters changed 1   outline edges 4490
    frame  5   E residues  83   arrowheads 18   letters changed 6   outline edges 4468

**The outline gains and loses up to 38 edges a frame with the mesh rebuilt every
time.** One to six residues change letter per frame as the structure breathes by
0.3 A, and each one that enters or leaves a strand takes its creases with it.
That is the flicker, and the renderer is drawing it faithfully.

🔴 **WHICH MAKES `strandKeyOf` A REBUILD THAT BUYS NOTHING IT WAS MEANT TO BUY.**
It was added to stop the flicker by forcing the fast path to agree with a
rebuild - and the rebuild flickers too. It is still right for CORRECTNESS (a
reused mesh with a stale edge set draws a strand's creases on a loop), but the
flicker it was aimed at was never in the cache. On a beta protein it costs 4
rebuilds in 5 steps for a picture that flickers either way.

🔴 **AND EVERY OTHER FIX AIMED AT IT WAS AIMED AT THE WRONG THING.** The
per-frame cross edges on `wip/per-frame-outline`, the strand set in the key, and
removing the creases altogether all change WHERE the flicker comes from and none
of them can remove it, because the letters underneath are moving.

**What would actually fix it** is stability in the assignment itself. `SS` in
cartoon/geom.js already has `extMode: 'hyst'`, but that is hysteresis in SPACE -
growing a run into its neighbours - and what a trajectory needs is hysteresis in
TIME: a residue keeps last frame's letter unless the new evidence clears the
threshold by a margin. The scoring harness for it exists (`tests/ss_bench.js`,
against pydssp), which is what makes it a change that can be made honestly
rather than tuned by eye.

**What exists today** is the Keep SSE button, which pins the assignment across
frames outright. It is the right answer for a trajectory of one molecule moving,
and it is opt-in because it is wrong for a folding one.

## The outline follows the letter, and the wrap bug was somewhere else entirely

`wip/per-frame-outline` was parked because `tests/outline_sync.py` failed on
`_traj_1bna.pdb`: the first pass through the frames was exact and every frame
AFTER THE WRAP differed by 2.34%. The branch was not wrong. **The wrap was a
different bug, on main, which the branch was sitting on top of**: `activateMesh`
restored a mesh's edge buffer and left `residentEdges` - the `{ed, edSrc}` pair
the per-frame edge refresh works from - pointing at whatever mesh was resident
before. A wrap revisits a frame, a revisit restores, and the restored frame then
had its outline rewritten from another frame's provenance.

Fixed on main as its own thing (`tests/frame_revisit.py`), and the branch's work
applied on top of it passes `outline_sync` first time.

**So the letter now decides the outline per frame, and no longer decides the
edge SET.** A strip's cross edge - the one a Richardson strand draws and a loop
does not - gets a row whether or not its piece is a strand today, and
`refreshEdgesFromStations` turns it on and off from the piece texture's bit 4.
`always` of -1 is clipped in the ink vertex shader before it costs a fragment.

What that buys, all measured:

  * **no rebuild when a strand appears or grows.** `_traj_3ptb.pdb`, a beta
    barrel whose assignment moves every frame: 4 rebuilds in 5 steps -> 0.
  * **no line left behind where a strand used to end.** That was the report -
    "a line appears where the original separation was" - and it is the stale
    crease of the old boundary. On a fast step against the same frame rebuilt,
    **0 of the differing pixels are grey** now; the 76 that remain are coloured,
    which is the shading residual that predates all of this.
  * and the rows cost nothing measurable per FRAME: 5.80 ms a step against 6.30
    with the strand set in the key, with +56% edge rows on 3PTB.

🔴 **WHAT THEY DO COST IS THE BUILD, AND IT IS WORTH KNOWING.** Measured on
1AOI by turning the revival off and on, in the `table` phase of a rebuild -
which is where the rows are emitted: **7.1 ms against 10.3**. So a rebuild pays
about +3 ms on a 19,748-face structure for an outline that never rebuilds
again. Rebuilds were the thing being removed, so this is the right side of the
trade; the number is here so the next person does not have to rediscover which
phase moved.

Two gates had to learn that rebuilds are rare now, and neither was a regression:
`dev_rebuild_light` compared Keep SSE against the ordinary path on their build
counts, and both are zero - it tests the light's actual contract instead, on a
rebuild it asks for; `capture_once` needs a frame that captures AND builds, and
asks for one the same way.

## One mesh in the spare slot cannot be right for two canvases

The resize win - a size change adopts the mesh in hand instead of rebuilding -
broke `tests/embed.py`, deterministically, on an assertion that looks unrelated:
`setContacts([])` no longer put the picture back to what it was before the
contacts. 2 runs of 2 failed; 3 of 3 pass with the fix.

The spare mesh slot is found by SIGNATURE. Adding a contact changes the key and
rebuilds, which puts the pre-contact mesh in the slot; taking it away returns the
key to what it was, and the slot hands that mesh back. That is the whole point of
the slot and it was right - until a resize stopped rebuilding, at which point the
slot could be holding a mesh captured on a different canvas, and any key that
came round again restored it.

`spareMesh = null` on a size change. The RESIDENT mesh is kept, which looks
inconsistent and is not: it carries `capW/capH` and the draw's ratio corrects for
them - that is what makes a resize a redraw at all - while the spare is a second
answer to a question the signature no longer distinguishes.

🔴 **AND THE GATE FOR IT IS `embed.py`, WHERE IT WAS FOUND.** An arm was written
into `resize_reuse.py` to reproduce it and could not: within one size the spare
is current, and the sequence that matters needs the key to leave and return
ACROSS the resize, which is what the embed page's layout does by itself. A check
that cannot fail was removed rather than kept for the look of it.

🔴 **AND IT TOOK FOUR WRONG BISECTS TO FIND, BECAUSE embed.py TESTS THE BUNDLE.**
Reverting `src/cartoon/paintgl.js` and re-running it proves nothing - the probe
loads `py2Dmol/resources/bundles/py2Dmol.embed.min.js`, which is only rebuilt by
`tools/bundle.py build` (the node lane does it). Three reverts in a row "failed
to fix" a bug they had not touched. Check out the BUNDLE at a commit, or rebuild
after editing, or measure nothing.

## A night on the hot paths: what moved, and what measured as nothing

Four wins, five rejections. The rejections are here because each one looked
obviously right and cost an hour to disprove.

### What moved

| | before | after |
|---|---:|---:|
| the SS assignment, 151 chains | 226 ms | **136 ms** (1.66x) |
| a cartoon step, 1TIM (min of 3 interleaved rounds) | 6.3 ms | **5.7 ms** |
| a tube step, _traj_9fog.pdb | 1.92 ms | **1.46 ms** (1.3x) |
| the edge refresh, per frame on 1TIM | 1.200 ms | 1.100 ms |

  * **The hydrogen-bond search** was nine tenths of the assignment and a Map of
    arrays. Counting sort instead - count per cell, prefix-sum, fill one
    Int32Array - and the three x-neighbours become ONE contiguous run. 176 ms to
    88. `dihedral` lost its four per-call array arguments and its three len3
    calls. Proved identical by digesting the assignment of all 151 chains.

  * **The chain tables** - `_chainColorKeys`, `chainIndexMap`,
    `perChainIndices`, the rainbow scales - are not a function of the
    coordinates and were rebuilt on every setCoords, which is every frame. Keyed
    on their inputs by identity now. With them, `new Set(this.chains)`, which
    existed to answer "is there more than one chain".

  * **The sequence panel** added every index of the structure to a Set to find
    out how many there were, on every frame, and read the set for its `size`
    and nothing else.

  * **The edge refresh's self-check** - six reads, six absolute values and six
    comparisons a row - is only meaningful at install and ran on every row of
    every frame.

### What measured as nothing, and is not in the tree

  * **A smaller H-bond cell.** The energy test is O...N at 5.5 A and the grid is
    9 A, which looks like four fifths of the candidates wasted. The grid is on
    C-ALPHAS: over the 151 chains, the longest alpha separation of an accepted
    bond is **8.502 A**, so a cell below that stops guaranteeing the pair is
    among the 27 neighbours. At 7.0 the assignment is identical and at 6.5 it is
    not - and the identical one is luck, not a bound.

  * **Skipping the corner projection on a station-only capture.** Measured first
    as 1.7 ms of a 7 ms step, which is why it looked like the prize of the
    night. Interleaved four rounds instead of measured once: **5.1 -> 4.8 ms**,
    and allocating four arrays without projecting costs the same as projecting -
    so it is the allocation, not the arithmetic, and the win is 6% for a change
    that runs through the capture path. Not taken.

  * **A sign table for `cornerOf`**, replacing four branches: 1.200 ms either
    way. The loop is memory-bound on a 16-float-strided station table, not
    branch-bound.

  * **Hoisting the four corner arrays out of `stationBoundsInto`** (39,000
    allocations a frame): 0.200 ms either way. V8 stack-allocates what does not
    escape.

  * **Inlining the four distances in the bond energy test**: no change. The
    13.7% the profile attributed to `len3` is in the amide and dihedral passes,
    not there.

  * **Deferring the per-piece array slices.** A rib piece slices FIFTEEN arrays
    out of its run's - about 2,000 pieces on 1TIM, so 30,000 array allocations
    a frame - and the station path reads five of them. A node micro-benchmark
    of exactly that shape says **1.12 ms a frame**, which would be a fifth of
    the step. Built it: the piece carries a window (`src`, `srcAt`, `ns`) and
    `pieceArrays` cuts the other ten on demand, so a frame that never rebuilds
    never cuts them. Interleaved three rounds: **5.8 ms before, 6.2 after** -
    slower. The slicing is not what the micro-benchmark measures in place, and
    the extra fields change the prim's shape for every other read of it.
    Reverted. Third time tonight that an allocation win did not survive contact
    with V8.

🔴 **AND THIS MACHINE MAKES A SINGLE MEASUREMENT WORTHLESS.** The same
configuration timed back to back read **7.1 ms and 5.3 ms** - a third of the
number - which is how the corner projection came to look like a 1.7 ms win.
Every number above is a minimum over interleaved rounds, and the two node-level
ones are minima of three runs in both orders.


## The load, on a capsid: 1.63x to the first picture

`1M4X.cif` is 1,680 assembly operations over the asymmetric unit - 10,115,280
atoms, 2,081,520 drawn positions - and it is the case where every per-atom and
per-residue cost in the load path is visible at once. Measured with a probe that
watches the canvas for its first non-white pixel, three loads an arm:

| | first ink | settled |
|---|---:|---:|
| before | 8931 / 9180 / 9175 ms | 9249 / 9519 / 9494 ms |
| after  | 5472 / 5537 / 5548 ms | 6732 / 6854 / 6868 ms |
|        | **1.63x** | **1.37x** |

Note the first row: the picture used to arrive 300 ms before the load finished.
Nine seconds of blank canvas, and then everything at once.

Four changes, in the order they were found.

**The sequence strip was in front of the picture.** `checkFrameChange` is an
animation-frame watcher and it built the strip directly; a build inside a rAF
callback runs before the browser can paint, so the first picture waited 1.9 s
for a panel that nothing drawn depends on. It goes through `buildViewDeferred`
now - which stays synchronous whenever the strip would not rebuild, so a
playback step is unchanged. `tests/load_work.py` gates the provenance: no build
may come from `checkFrameChange`.

**The side-chain table, 1.33x** (1365 / 1419 / 1404 ms -> 1017 / 1058 / 1070,
`window.__sidechainMs`). `primed` was called three times per atom where once
does; the backbone test asked a dictionary per emitted row for an answer only
proline has; `join`, `grow` and `rowIdx` were declared inside the residue loop,
which is three closures per residue and 939,000 of them here, beside two fresh
arrays. The frame is also computed once per residue instead of twice - that one
measured nothing on its own and is kept for being half the work, not for a
speedup it did not give.

**The nucleic question, 1.10x on the conversion** (2979 / 3190 / 3164 ms ->
2717 / 2868 / 2851, `window.__convertMs`). Every residue was asked both whether
it is an amino acid and whether it is a nucleotide, and the branches take
protein first - so on a capsid with no nucleic acid in it, 2 million
connectivity walks were discarded.

**The assembly expansion, 1.26x** (1020 / 1075 / 1020 ms -> 807 / 826 / 808,
`window.__biounitMs`). The copy's chain name is a function of the chain and the
operation, and it was rebuilt per atom: eight million string concatenations
producing a few dozen distinct strings. One map per operation.

🔴 **AND TWO OBVIOUS REPAIRS MEASURED NOTHING OR WORSE.** `rowIdx` is 113 ms
and looks like the hashing candidate; one reused Map, cleared per residue, cost
1161 / 1245 / 1246 ms against the scan's 1017 / 1058 / 1070 - hashing fourteen
strings to save scanning them does not pay at fourteen. And
`maybeFilterAdditives` builds a 10-million-element array to decide it has
dropped nothing; counting first measured 149 / 158 ms against 170, which is
inside the spread. The passes over ten million atoms are the cost there, not the
array, and the change was reverted rather than kept for looking right.

**Each arm is three loads and the arms were run back to back**, because this
machine drifts: the same configuration measured 8931 and 9180 ms in consecutive
runs. Single numbers from this probe mean nothing.
