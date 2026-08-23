# The GPU mesh lifecycle, and what is left to unify

Written down mid-work so the next session can pick it up without the
conversation. Everything here is measured on this machine (ANGLE Metal, M2),
headless Chrome, with `tests/gpu_mesh_reuse.py` and the probes named below.

## Where things stand

There are two geometry models and they should stay two:

| 4UG0 + 6MRR, 17,618 positions, one merge | tube | cartoon |
|---|---|---|
| rotate, repaint | 21-34 ms | 20-34 ms |
| hide or show one object | 33-50 ms | 1,100 ms first, **50-80 ms** reused |
| first build | ~30 ms | 1,150 ms (capture 380, faces 50, buffers 740) |

The tube is cheap because it is a different model - one instance per segment,
no faces, no welds, no silhouette. Folding it into the cartoon's pipeline would
import that cost onto exactly the structures the tube exists for. **Do not
unify the geometry or the painters.**

What HAS cost us is the duplicated lifecycle around them. Three bugs this
week, all the same shape - two paths, one of which quietly owns shared state:

  * two SS cache keys built in two places, and the colour path's left the
    merged objects out, so it never matched the mesh the drawing had just
    filled and recomputed a full assignment every frame;
  * the selection panel read a cache only the CARTOON pass fills, so in tube it
    said "DSSP" with no structure named;
  * `_naPick` was written by the cartoon pass and stayed clickable in tube, at
    the rotation the cartoon drew it.

## Done

  * **A mesh is a value.** `captureMesh()` takes everything a build produces -
    both buffers, both counts, `resident`, the palette-complete flag, the drawn
    positions, the scene radius, the residue map and the visibility texture's
    SIZE - and `activateMesh()` installs it. Build and restore go through the
    same installer, which is what makes "the restore forgot one thing"
    structurally impossible. It was not: the first version forgot the
    visibility texture, which is sized per structure and shrinks, and a
    restored bigger mesh had every residue past the smaller one's end read as
    hidden (fills gone, outline intact - reported from the app before the probe
    existed).
  * **One spare slot, exchanged.** Alternating between two pictures is what an
    eye is for, so the mesh coming out swaps places with the one going in. Held
    only where more than one object is loaded, and only under
    `MESH_CACHE_MAX_BYTES` (a ribosome's mesh is 45-67 MB of floats).
  * **The visibility mask is keyed by CONTENT** in both signatures
    (`visKeyOf`), because the mask is rebuilt from the objects' own records
    whenever the drawn set changes and an identical picture used to arrive as a
    different object.
  * **The SS assignment is askable** (`py2dmolCartoon.secondaryFor`), computed
    on a miss rather than scavenged from whichever cache a render happened to
    fill.

## Next: unify the lifecycle (not the geometry)

**All three steps are done** (2026-08-23). What follows is the record of what
each one was and what it turned up.

1. ~~**One signature vocabulary.**~~ DONE. `sharedGeometryKey(r)` holds the
   half neither path owns - object, what the coordinate array HOLDS, a content
   probe over it, segment count, mask content, line width, side chains, hidden
   backbone, contacts - and `signatureOf`/`tubeKeyOf` each `concat` only their
   own (the cartoon's canvas, extent, ribbon, outline, Richardson, plates,
   bases, elements, forced SSE; the tube's colours and instance count).

   Two things came out of merging the lists, both from the halves disagreeing:

   * The tube kept the coordinate array **by identity** and the cartoon kept
     only its **length**. Identity is the wrong answer - the merge is rebuilt
     from scratch whenever the drawn set changes, so an eye toggle brings back
     the same picture in a new array. Taking the tube's half made every toggle
     rebuild (70-80 ms). Both now ask `_arrayKey()`, the statement viewer-mol.js
     already keeps of what the array holds, and the toggles fell to **3-8 ms**
     from the 50-80 ms the spare slot had got them to.
   * Neither half could see coordinates MOVE inside a frame - same objects,
     same frame, same length - which is what an alignment does. Three samples
     (`coordsProbe`) stand in for the content. `gpu_mesh_reuse.py` now moves
     half the positions and insists the mesh rebuilds; with the probe replaced
     by the old length term it draws the old shape and the check fails.
   * The cartoon's hidden-backbone term read `hiddenBackbone` off the CURRENT
     object, so a second merged object's hidden backbone would not have
     rebuilt anything. The shared term asks `backboneHiddenSet()`, which merges.

2. ~~**One mesh value for the tube too.**~~ DONE. `captureTube`/`activateTube`
   install everything a tube build decides - the instance data (a COPY: the
   scratch array is reused), the count, the centre, the depth range and the
   occlusion density - and `keepTube`/`restoreTube` give it the same exchanged
   spare slot, held only where more than one object is loaded. Assembling the
   value immediately found the piece that was already loose: the DEPTH RANGE,
   which buildTube set on its own, so a restored buffer was drawn through the
   range of whatever had been built last. `tests/gpu_tube_reuse.py` caught it,
   which is the cartoon's visibility-texture bug found before a user saw it.

   For the slot to ever hit, the tube's colours had to be keyed by CONTENT
   (`colourKeyOf`, cached against the array) rather than by identity - the app
   rebuilds the colour array from scratch whenever the drawn set changes.
   Toggling one object of a two-object merge in tube style: 33-50 ms -> 2-4 ms.

3. ~~**Derived state, filled independently of style.**~~ Checked. The three
   cartoon caches (`_cartoonPair`, `_cartoonLadder`, `_cartoonSheet`) have no
   reader outside viewer-cartoon.js, `_naPick` carries the frame it was drawn
   for, and the SS assignment is askable - so nothing outside the render path
   depends on which painter ran.

   What did come out of the check: `secCacheKey` was a THIRD hand-written list
   of what the coordinates are, and the weakest - it could not see a coordinate
   swap at all, which is why `_invalidateSegmentCache` reaches in and clears
   those caches by hand. All three now ask `renderer._coordsKey()`
   (viewer-mol.js), which is `_arrayKey()` - the statement the renderer already
   keeps of what the array holds - plus three samples of the coordinates. The
   hand-clearing stays: it also covers the other direction, the array unchanged
   and something derived from it not.

## What must stay green

    python3 tests/gpu_mesh_reuse.py            # 6MRR + 4HHB, in that order
    python3 tests/gpu_tube_reuse.py            # the same, in tube style
    python3 tests/gpu_mesh_reuse.py 4UG0.cif 6MRR.cif
    python3 tests/gpu_recolour.py              # and with 4UG0.cif
    node tests/smoke.js && node tests/smoke.js py2Dmol/resources/viewer-cartoon.min.js

`gpu_mesh_reuse.py` compares every restored picture with one drawn from a mesh
built for it, PIXEL FOR PIXEL, and checks that picking lands on the same
residues. Its leg order matters and is commented in the file: the picker leg
runs first, smaller structure loaded first, because several things a mesh
carries shrink and a merge leaves them big enough to hide the fault.
