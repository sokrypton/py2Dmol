# Showing more than one object at a time

The goal: an **Object button** that opens the dropdown into a list, PyMOL's
object panel or Photoshop's layers — each row an object, each with its own
visibility, several of them on screen together for comparison or alignment.
**No shadow between objects**, which is not a limitation to apologise for: it
is what makes the whole thing tractable, because each object can then be drawn
by the existing single-object pipeline and composited.

## What already moved

Per-object state is the precondition, and most of it is done:

| State | Where it lives |
|---|---|
| rotation, zoom, ortho, centre, extent, frame | `obj.viewerState` |
| clip slab and fade | `obj.viewerState` (travels on switch) |
| **style and styleChosen** | `obj.viewerState` |
| selection, visibility mask | `obj.visibilityState` |
| side chains, bases, elements, contacts | `obj.*` sets |
| colour scheme | per object already |

Width is per STYLE rather than per object (`_widthByStyle`), which is right:
it is the same drawing question whatever is being drawn.

## What still assumes one object

1. **The renderer's arrays are the current object's.** `this.coords`,
   `segmentIndices`, `rotatedCoords`, `screenX/Y`, `colors`, the shadow and
   segment caches - all singular, all rebuilt by `_loadFrameData` when the
   object changes. Measured: 23-40 ms for 4UG0, ~1 ms for 6MRR.
2. **One cache slot.** `cachedSegmentIndices` is keyed by
   `cachedSegmentIndicesObjectName`, so two objects drawn alternately thrash
   it - the reason a naive draw-each-in-turn loop would be slow rather than
   wrong.
3. **`_renderToContext` clears the canvas** and then draws the current object,
   so it cannot be called twice for one frame.
4. **The GPU paths hold one resident structure**: the cartoon mesh under one
   `signatureOf`, the tube under one `tubeSig`. Two objects means two meshes or
   a rebuild per object per frame, and a rebuild is 18 ms of a 26 ms frame on a
   capsid.
5. **Picking and the halo** index by position alone. With several objects on
   screen a hit is (object, position).

## The slices

**1. A seam in the render path.** Lift the canvas clear out of
`_renderToContext` into `render`, and give the renderer a `shownObjects` set
that is `{currentObjectName}` for now. No behaviour change - this is the line
everything else hangs off. *(done)*

**2. Per-object draw state.** The arrays and caches in (1) and (2) become a
record per object, swapped by reference rather than rebuilt. This is the real
work and the only slice that is hard: everything reading `this.coords` has to
read the active record instead. Until it exists, drawing N objects costs N
frame loads per frame.

**3. The list UI.** Object becomes a button; the dropdown becomes rows with an
eye per row and the active object highlighted. Ships only once 2 is in - a
visibility control that does not change the picture is worse than no control.

**4. The GPU paths.** Either a resident mesh per object (memory) or fall back
to the 2D path while more than one object is shown (simple, and honest: the
GPU exists for one huge structure, and comparison work is usually small ones).
Decide with a measurement, not in advance.

**5. Picking, selection and the halo** become (object, position). The panels
already act on "the active object", so most of this is plumbing an object name
through `pickResidueAt` and friends.

## What does not change

Shadows and occlusion stay **within** an object. Cross-object shading would
need one merged depth field, which is the merged-scene design this plan
deliberately avoids - and it is also not wanted: two structures compared
side by side should not darken each other.
