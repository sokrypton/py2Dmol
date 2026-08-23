# Showing more than one object at a time

The goal: an **Object button** that opens the dropdown into a list — PyMOL's
object panel, or Photoshop's layers. Each row an object, each with its own
visibility, several on screen together for comparison or alignment.

## The overlay already does this

The first draft of this plan proposed compositing: draw each object with the
single-object pipeline, one pass each, no shadow between them. That was the
wrong model, and the codebase already contains the right one.

**Overlay mode merges every frame of a trajectory into ONE coordinate array**
(`_mergeFrameRange`) and remembers where each position came from in
`overlayState.frameIdMap`. That map is then handed to the cartoon as a
**bonding group** — viewer-cartoon.js: *"a residue may only bond within its own
frame"* — so nothing joins across sources, and `assignSecondary` gets
`groups: ovMap` for the same reason.

Several objects at once is the same shape with a different source. Merge the
shown objects' current frames, carry a `sourceIdMap` where the overlay carries
`frameIdMap`, and the existing pipeline draws the lot in one pass.

That answers the shadow question too. With one merged array the occlusion and
the depth sort see everything, so objects DO shade each other, for free and
correctly — no special case, no second depth field. The cartoon casts no
shadows anyway; it is the tube style where this shows, and there it is what
you want.

## What is already per object

Mostly done, much of it this week:

| State | Where it lives |
|---|---|
| rotation, zoom, ortho, centre, extent, frame | `obj.viewerState` |
| clip slab and fade | `obj.viewerState` |
| style and styleChosen | `obj.viewerState` |
| selection, visibility mask | `obj.visibilityState` |
| side chains, bases, elements, contacts | `obj.*` sets |

## The slices

**1. `drawnObjects()`** — one place that answers "which objects does this frame
draw", reading a `shownObjects` set and falling back to the current object.
Names whose objects have been deleted are skipped. *(done)*

**2. `_mergeObjects(names)`**, alongside `_mergeFrameRange` and built the same
way: concatenate coords, plddts, chains, types, names, atoms, elements,
residue numbers and bonds (offset per source), and return a `sourceIdMap`.
*(done)* — with, beyond the plan as written:

- `_resolvedFrame(object, frameIndex)`, the inheritance of plddts, PAE and
  bonds pulled out of `_loadFrameData` so the merge reads a frame the same way
  a plain load does rather than through a second copy of that logic.
- Each object contributes **the frame it is parked on** - `this.currentFrame`
  for the current object, `viewerState.currentFrame` for the rest.
- **PAE is dropped** across two objects and kept for one. There is no such
  matrix across two structures, and indexing one object's rows with merged
  positions is worse than having none.
- **Side tables merged** (`_mergeSidechainTables`). They carry two kinds of
  index - `pos`/`frameOf` are positions, `bonds`/`toBackbone` are rows of the
  table itself - and both are offset. Still per-object: `obj.sidechains`, the
  set of residues switched ON, is read for the current object only, so a
  second object's side chains cannot yet be enabled. That is slice 5's
  expansion.
- A field that arrives the wrong length is filled to the position count, never
  spliced short - one short array slides every later position onto the wrong
  residue.

Still to wire: feed `sourceIdMap` to `assignSecondary` as the bonding group
exactly as the overlay's map is fed, and rebuild when the shown set changes,
not per frame.

**3. Colour per object.** *(done)* - and rather more than colour, because a
merge that is mapped and coloured correctly can still be invisible. What the
browser probe (`tests/multi_object.py`) turned up, in order:

- **`object` colour mode**, what `auto` resolves to whenever more than one is
  merged. Every other scheme gives two structures the same colours as each
  other - by chain both start at chain A, by rainbow both run blue to red -
  and one colour each is the whole point of a comparison. A ligand is grey in
  every other mode; here it says which object it is on.
- **Rainbow ramps per source** (`sourceRainbowScales`, was `frameRainbowScales`),
  so each object runs its own blue-to-red instead of taking a slice of one.
- **`drawnStats()`** - the centre and extent the camera frames on. Left as the
  current object's, the second object is out of shot: the first working merge
  measured as two structures correctly merged, mapped and coloured, with LESS
  ink on screen than one of them alone.
- **`_applyMergedVisibility`** - each object's own mask expanded into merged
  indices. Left alone, the mask of whichever object was current still names
  0..k and everything past it is hidden, which is the second way the same
  picture came out with one structure in it. Chain ids collide across objects,
  so the chain half of a mask is resolved into positions and cleared.
- The selection is dropped when the merge changes; it was a set of indices
  against the array that just went away.

**4. The list UI.** *(done, after 5)* The button opens into an **All** row and
then a row per object - an eye and a name, the whole row a switch - and reads
`1/2` while one object is up, `All` when every one of them is. No swatch and no
current-object marking: this control answers one question, and the second one
moved to the picker beside the sequence strip. See "The model, as shipped".

**ONE OBJECT IS EDITED AT A TIME.** The sequence strip, the panels, the PAE map
and the MSA follow the picked object, and the others are geometry on screen
beside it. That keeps every panel answering one question about one structure,
and it is why the strip's cells carry MERGED indices while its rows are built
from the object's own frame.

**5. Selection and picking, and every other per-object set.** One merged index
space, so picking works unchanged - what it needs is the source map to report
WHICH object was hit. The sets keyed by position index each need the same
offset treatment side chains and visibility have had:

*(done, apart from the selection)* The translators are `ownerOf(i)` (merged
index to object, local index, and that object's own frame), `writeGroups(ps)`
(a selection split into the objects it touches, each in its own numbering),
`mergedObjectSet(field, nullMeans)` (a per-object set read in merged indices,
cached by the identity of the sets behind it) and `localRangeOf(name)`.

| set | where | state |
|---|---|---|
| `obj.sidechains` | which residues show side chains | `shownSidechainSet()` |
| `visibilityState.positions` | the mask | `_applyMergedVisibility` |
| `obj.bases` | nucleic base plates | `mergedObjectSet('bases', 'all')` |
| `obj.elements` | element colouring | `mergedObjectSet('elements', 'all')` |
| `obj.hiddenBackbone` | hidden backbone | `mergedObjectSet(..., 'none')` |
| `obj.sse` | forced secondary structure | `forcedSseFor` via `ownerOf` |
| `obj.contacts` | contacts | resolved inside each object's window |
| `obj.ligandGroups` | which atoms are one ligand | `mergedLigandGroups()` |
| colours (object/frame/chain/position) | `resolveColorHierarchy` | via `ownerOf` |
| `obj.sidechainColor` | per-residue side-chain colour | via `ownerOf` |
| entropy | `entropyForDrawn()` | per object, concatenated |
| `obj.color` position/chain maps | via `writeGroups` on the way in, `ownerOf` on the way out |
| `obj.sidechainColor` | via `writeGroups` |
| `residueSelection` | dropped when the merge changes; `selectionForObject` for an edit |

**The two polarities both had to survive.** `null` means NONE for side chains
and a hidden backbone, and ALL for base plates and element colours - so an
untouched object contributes nothing in the first case and its whole range in
the second, and the merged answer is null only when EVERY shown object is
untouched. Get that wrong and switching one plate off in one object hides
every plate in the other.

**And one that is not an index at all:** setCoords persists the bond list onto
the current object so the next frame can reuse it. A merged list is offsets
into an array of several objects; written there it outlives the merge, and the
next plain load bonds that object's residues to positions that are gone.

**6. The GPU paths.** *(verified for the cartoon)* One resident mesh, keyed by
one signature: a merged array is a single structure as far as they are
concerned, and the GPU picture of two merged objects is the CPU picture
(`tests/multi_object.py` compares them in ONE page load). The tube style is
not verified yet.

## The trade-off, decided

**CONFIRMED: one style for the merge** - *"no need to mix tube vs cartoon
paths."*

**A merged array is drawn by ONE style.** Tube and cartoon cannot both be on
screen under this model. That is the price of the merge, and it buys shadowing,
picking, depth sorting and the GPU paths unchanged.

Per-object style would mean going back to compositing passes, which costs all
four of those. Since the per-object style added this week is about what a
structure opens AS - a ribosome as tube, a peptide as cartoon - and not about
comparing two structures drawn differently, the merge is the better trade.

## What else the merge touched

Found by walking the paths a user actually clicks, not by reading the merge:

- **Copy, Cut and Delete** rewrite one object's frames and renumber everything
  keyed to them. Rather than teach each the merge, `_editOneObject` puts the
  merge DOWN for the edit and picks it up after, with the selection and mask
  translated down with it - and the object a Copy just made added to the shown
  set, because a copy that lands off screen looks like a copy that failed.
- **The sequence strip** builds its rows from the current object's frame but
  now hands out merged indices, so its colours, its selection and its clicks
  land on the right residues. Its ligand groups are offset once, where they are
  read.
- **The PAE map** is one object's matrix: its rows are that object's residues,
  and both directions of the mapping carry the offset.
- **Chain colours** are keyed by SOURCE and chain. Two structures both have a
  chain A, and under the chain scheme they came out the same colour - two
  molecules reading as one. NOT for the overlay, where chain A is the same
  chain in every frame.
- **Auto colour is per object**: a monomer rainbows, a complex colours by
  chain, a predicted model by confidence - what each looks like on its own.
  The flat `object` mode is still there as an explicit choice.
- **`reloadDrawn()`** replaces every `_loadFrameData` call in the app. Reloading
  the frame after a side-chain or contact edit rebuilt the current object alone
  and threw the other objects off the screen.
- **Overlay and the object merge are exclusive both ways**, and the overlay
  button is styled from the state rather than from the toggle, so it cannot sit
  lit over a view that is not overlaid.
- **setCoords does not persist a merged bond list** onto the current object.

## The model, as shipped

Two questions, asked in two places, and the whole design is keeping them apart:

| question | control | state |
|---|---|---|
| which objects are ON SCREEN | the list: an **All** row, then a row per object | `shownObjects`: null, a set, or an EMPTY set |
| which object is being EDITED | the **picker beside the sequence strip** | `currentObjectName` |

`shownObjects` has three states, and the third is the one that is easy to
forget: **null** is the default (the object being edited, on its own), a
**non-empty set** is those objects, and an **empty set** is every object
switched off - an empty canvas, which is a picture the user is allowed to ask
for. A list naming only objects that no longer exist is stale, not a request
for nothing, and falls back to the default.

**One object at a time is the resting state** - chosen with the dropdown, which
is how the viewer has always worked. Loading a second file does not change what
you are looking at and does not merge anything: *"by default unless user clicks
all, the original behavior should remain, one object displayed at a time
selected via dropdown menu."* Showing several is asked for - press **All**, or
light one object's eye, which JOINS it to what is on screen rather than
replacing it. **All is literal**: every object on, or every object off. A
control called All that leaves something behind is a lie.

A single object that is NOT the one being edited is drawn through the merge
machinery with one source - the plain path loads the CURRENT object and would
draw the wrong one - and it is coloured as itself rather than as "object 0 of
one".

The first version tied the two questions together: the shown set meant "the
current object", so picking one in the list took the other off the screen -
*"it's a little confusing, when i click one it hides the other"*. The second
went too far the other way and drew everything by default. What separates them
is the empty set meaning "the edited one" while the LIST is what puts others
up, and the editing question living where the thing it governs is.

**Nothing about the picture changes when the edited object changes.** A switch
normally restores that object's camera, clip, style and visibility mask; under
a merge all four are frozen, because both structures are in front of you and
swinging to one object's saved pose throws the other off the screen. The mask
is not filed under one object either - it covers everything drawn, and each
object's share is recovered from the live mask when the merge is rebuilt.

## The strip is hierarchical: object -> chain -> residue

The sequence viewer builds **one section per object on screen**, each with its
own chain rows, and no heading at all when there is only one - so a single
structure looks exactly as it always has. `buildObjectSection` makes one
section; `sequenceSections` asks `drawnObjects()` which ones to make.

That removed the picker. Which object you are EDITING is answered by where you
click: selecting in a section adopts its object (`adoptObjectOfSelection`), and
the heading of the edited one is marked. The `<select>` stays in the DOM,
hidden, because every other path drives the current object through it - the
renderer's change listener, the prev/next buttons, a restored session.

**With nothing on screen the strip goes quiet** - a note instead of rows, and
its tools disabled. A strip listing residues of a picture that is not there
would select things nobody can see.

## Chain identity is (object, chain), everywhere

Chain ids are unique inside a file and nowhere else. Under a bare id, selecting
chain A of one object selected chain A of the other - *"when I select chain A
in one object, chain A of the other object enabled to selected"*. Every path
that asks "is this position in that chain" now asks `chainKeyAt(i)` /
`chainKeyFor(chain, object)`:

| path | where |
|---|---|
| the visibility mask, both branches | `_composeAndApplyMask` |
| Show all's chain set | `showAll` |
| what the panel writes when it hides | `web/app.js` |
| the strip's chain buttons | `viewer-seq.js` |
| the PAE map's rows | `viewer-pae.js` |
| the palette | `chainIndexMap` |
| the 3D double-click "whole chain" | `viewer-mol.js` |
| the silhouette's chain-break test | `viewer-mol.js` |
| the strip: hit test, hover, label colour, drag, selection | `cellsOfChain` / `chainBoxOf` |
| the head-to-tail test for a cyclic chain | `chainPolymerBounds` |
| the fallback that bonds a chain's ligand atoms | `ligandIndicesByChain` |
| both hover readouts | the object is named when several are drawn |

A SEGMENT's `chainId` stays the bare id, deliberately: it is only ever compared
between segments that SHARE A POSITION, which are in the same object by
construction, and a key among bare ids would read as a different chain at every
joint. The cyclic-chain set is the exception that proves it - it is keyed, and
the rainbow that reads it is keyed too.

`this.chains` stays the bare id - it is what the file said and what the panel
prints. The key is only for questions of identity.

**Inside the strip the same rule holds, through two helpers.** `cellsOfChain`
answers "every position of that chain of that object", read off the LAYOUT -
which carries the object with every cell and speaks the renderer's indices -
and `chainBoxOf` finds the box a chain item was drawn in. Everything
chain-wide goes through one or the other: selecting a chain, hovering its
label, deciding whether the label shows an override colour, dragging across
labels. Each of those was its own instance of the same bug:

- the hit tester found a chain's box *by id*, which is another object's row
  once two are on screen - so every chain A but the first matched nothing and
  a click on it selected nothing at all;
- hovering a chain label lit the first object's chain of that name in 3D;
- the label's override colour walked the current object's frame with raw
  indices, so a second object's label asked about the first one's residues;
- a drag from one object's chain A to another's looked like standing still.

Nothing keeps one section's rows around any more: `chainBoundaries` and
`sortedPositionEntries` are gone from `sequenceCanvasData`, because anything
holding them can answer the wrong object with them.

## The selection, across objects

`residueSelection` is a flat set of MERGED indices, so it can span objects, and
everything that reads or writes it knows which object each index belongs to:

- **Writes** are split per owning object (`writeGroups`): colours, side chains,
  SSE, bases, elements. Nothing lands on the wrong residue.
- **Copy, Cut and Delete** run once per object the selection reaches
  (`objectsInSelection`, `_perObjectEdit`). Copy makes one new object per
  structure it touched and the status line names them; Delete removes from each
  and says so. Taking the edited object's share silently was the alternative,
  and a Cut that leaves half the selection behind is worse than one that
  refuses. The selection is put back before each object's turn - an edit
  consumes it, and the second object was being handed the first one's leavings.
- **The panel** reads `1BBH/A 12-30, 1HVR/A 4-9`, and the count says "in 2
  objects" when it is.
- **A change to what is on screen carries the selection**, as (object, local
  index) pairs: residues of an object that is switched off are dropped, and
  everything else lands where it now lives. Clearing outright meant hiding one
  object threw away a selection made on the one still showing.
- **A canvas click** can select a residue of any drawn object, and Within finds
  neighbours across the join - which is the point of having both on screen.

## The audit, file by file

Every place that reads per-object state or compares chains, checked once and
recorded so the next reader does not have to re-derive it:

| file | what was wrong |
|---|---|
| `viewer-mol.js` | the 3D double-click's whole-chain widening; the silhouette's chain-break test; `chainPolymerBounds` (the head-to-tail test for a cyclic chain); `ligandIndicesByChain` (the fallback that bonds a chain's ligand atoms); the lone-atom ligand-group lookup; the hover readout; six entropy fills |
| `viewer-seq.js` | the hit tester, the hover, the label's override colour, the drag, the whole-chain selection, the ligand groups, and one section's rows kept on `sequenceCanvasData` |
| `viewer-pae.js` | a box's rows landing at raw indices, the reverse mapping, the chain set it writes, the ligand expansion |
| `viewer-cartoon.js` | the base-plate set, the forced-SSE map, the framing extent, the colour-override fast path |
| `viewer-cartoon-gpu.js` | the mesh signature (which objects, the extent, the base and element sets, the per-position colour flag) and the contact cache key |
| `web/app.js` | the panel's element/side-chain/base tallies, the side-chain colour readback, the chain set written when hiding, four entropy fills, Copy/Cut/Delete reporting |
| `viewer-msa.js` | nothing: it maps one object's alignment onto that object's own frame, and `entropyForDrawn` places the result |
| `viewer-scatter.js` | nothing: it holds no position indices |

The rule that came out of it: **anything that identifies a residue, a chain or
a sequence across the merged array carries its object.** The exceptions are
written down where they are - `this.chains` (the file's own id, printed by the
panel), a segment's `chainId` (only ever compared between segments sharing a
position), and an object's own stored sets (its own numbering, translated on
the way in and out).

## Measured

- **Rebuilding the merge** (4UG0 + 6MRR, 17,618 positions, Chrome, tab visible):
  `_mergeObjects` 5.5 ms, the whole `_applyShownObjects` 22 ms - which is what
  a frame step, a side-chain toggle or a contact edit costs in a merged view,
  against 0.2 ms for a plain single-object frame load of the peptide alone.
  Fine for every interactive case; playing an animation of a ribosome with a
  second object up would be strained, and if that ever matters the fix is to
  patch the changed object's slice in place rather than rebuild.
- **The spread-push ceiling**: `out.push(...src)` throws between 100,000 and
  125,000 elements. Both merges concatenate whole per-position arrays and both
  are reachable at that size - a capsid overlaid on itself was already able to
  hit it - so both append element by element now.
