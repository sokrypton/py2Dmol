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

**4. The list UI.** *(done, after 5)* Object is a button; pressing it opens the
dropdown out into a row per object with an eye, a swatch and the current object
marked. The dropdown stays - hidden while the list is open - because it is what
every other path drives the current object through.

**ONE OBJECT IS THE MAIN ONE.** The row's NAME makes an object current; its eye
says whether it is drawn. Everything else - the sequence strip, the panels, the
edits, the PAE map, the MSA - follows the current object, and the others are
extra geometry on screen. That keeps every panel answering one question about
one structure, and it is why the strip's cells now carry MERGED indices while
its rows are built from the object's own frame.

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
