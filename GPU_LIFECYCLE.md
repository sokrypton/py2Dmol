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

1. **One signature vocabulary.** `signatureOf` (cartoon) and `tubeKeyOf` (tube)
   each list, by hand, everything that invalidates geometry. They already
   disagree in small ways. Factor the shared half - object, frame, array
   identity, drawn sources, mask content, backbone-hidden set, contacts, side
   chains - into one builder both call, and leave each path only its own
   additions (the cartoon's outline and Richardson parameters, the tube's line
   width). The SS-key duplication cost a second a frame before anyone noticed;
   this is the same trap with two more copies.

2. **One mesh value for the tube too.** The tube path keeps `bufTube`,
   `tubeSig` and `tubeCount` as three hand-maintained module variables, with no
   `captureMesh`/`activateMesh` and no spare slot. It does not need the speed -
   33 ms - so the reason to do it is that it is the same structure that let the
   visibility texture be forgotten. Do it when the tube next needs a change.

3. **Derived state, filled independently of style.** Anything a reader outside
   the render path consults must be askable and keyed on what it came from.
   `_naPick` is stamped now and the SS assignment is askable; check the rest
   (`_cartoonPair`, `_cartoonLadder`, `_cartoonSheet`) the same way if a
   non-cartoon reader ever appears.

## What must stay green

    python3 tests/gpu_mesh_reuse.py            # 6MRR + 4HHB, in that order
    python3 tests/gpu_mesh_reuse.py 4UG0.cif 6MRR.cif
    python3 tests/gpu_recolour.py              # and with 4UG0.cif
    node tests/smoke.js && node tests/smoke.js py2Dmol/resources/viewer-cartoon.min.js

`gpu_mesh_reuse.py` compares every restored picture with one drawn from a mesh
built for it, PIXEL FOR PIXEL, and checks that picking lands on the same
residues. Its leg order matters and is commented in the file: the picker leg
runs first, smaller structure loaded first, because several things a mesh
carries shrink and a merge leaves them big enough to hide the fault.
