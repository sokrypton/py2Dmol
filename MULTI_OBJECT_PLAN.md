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
Feed it to `assignSecondary` as the bonding group exactly as the overlay's map
is fed. Rebuilt when the shown set changes, not per frame.

**3. Colour per object.** The overlay picks ONE auto colour for the whole merge.
Several objects want one scheme each, so the colour pass needs the source map
where it currently has a single mode.

**4. The list UI.** Object becomes a button; the dropdown becomes rows with an
eye per row and the active object highlighted. Ships with 2 and 3, not before:
a visibility control that does not change the picture is worse than none.

**5. Selection and picking.** One merged index space, so picking works
unchanged - what it needs is the source map to report WHICH object was hit, and
the per-object selections expanded into merged indices. The overlay already
does that expansion for frames (see the `frameOffsets` block).

**6. The GPU paths.** One resident mesh, keyed by one signature. A merged array
is a single structure as far as they are concerned, so it should just work -
verify, and expect a rebuild whenever the shown set changes.

## The trade-off to decide

**A merged array is drawn by ONE style.** Tube and cartoon cannot both be on
screen under this model. That is the price of the merge, and it buys shadowing,
picking, depth sorting and the GPU paths unchanged.

Per-object style would mean going back to compositing passes, which costs all
four of those. Since the per-object style added this week is about what a
structure opens AS - a ribosome as tube, a peptide as cartoon - and not about
comparing two structures drawn differently, the merge looks like the better
trade. Worth confirming before slice 2 is built.
