# The WebGL2 cartoon renderer — where this stands

The GPU path is no longer a prototype in `tests/`. It ships as
`src/cartoon/paintgl.js`, the app can switch to it from the
Style panel, and `py2Dmol.view(gpu=True)` turns it on from Python.

`GPU3D_NOTES.md` is the long record of WHY each rule is what it is, and is worth
reading before changing any of them — most were arrived at by measuring, and
several look wrong until you know what they fixed. This file is the shorter
question: what exists, what works, what is half-done, and how to check any of it.

## The files

| file | what it is |
|---|--:|
| `src/cartoon/paintgl.js` | **the renderer.** Shaders, capture, `facesOf`, `makeResident`, the outline, the paper, the palette and visibility textures, and the app entry. Ships with the viewer. |
| `tests/gpu3d_core.js` | the **harness**: fixtures, `.cif` loading, the fake renderer the capture runs through, the colour schemes, the pixel diff, and the producer that turns a test page's controls into the parameter object. |
| `tests/gpu3d_lab.html` | the measurement harness: reference panel, pixel diff, 36-view sweep. For numbers. |
| `tests/gpu3d_view.html` | the plain viewer: one canvas, a renderer selector, the style controls. For looking. |

**Parameters arrive as an object, never read from a document.** The harness
builds that object from its controls (`styleParams`), the app builds it from the
renderer's own properties (`paramsFromRenderer`). One consumer, two producers —
which is what lets the lab measure the path the app actually runs.

## Run it

    cd <repo root> && python3 -m http.server 8080
    open http://localhost:8080/index.html                 # the app; Style -> GPU
    open http://localhost:8080/tests/gpu3d_view.html      # look at it
    open http://localhost:8080/tests/gpu3d_lab.html       # measure it

**Hard-reload (cmd+shift+R) after editing a `.js` under `py2Dmol/resources/`.**
A query string on the page URL does not re-fetch the scripts, and you will test
the previous build against the current markup. This has cost an hour twice.

## Changes to the SHIPPING 2D renderer

`cartoon/geom.js` has three opt-in hooks, all default off, all no-ops unless
asked for:

| hook | what it does | why |
|---|---|---|
| `_frameProbe` | emits each station's frame (`ub`, width normal, tangent) in MODEL space, plus each prim's palette slot | a projected drawing gives a frame's direction but **not its sign**; three attempts to recover it from captured data each got a different set of faces wrong |
| `_noViewCull` | keeps primitives outside the viewport | dropping them is right for painting a frame, wrong for harvesting geometry |
| `_probeOnly` | returns from `render()` once the prims exist | everything after is a frame nobody looks at |

...plus three additive facts on the prims, which a consumer that re-lights the
geometry needs and a painter does not: `two` (a flat stick face is
double-sided), `base` (the square that lies on the backbone), and `paperTile` /
`PENCIL` exported so the grain is the SAME SHEET on both paths.

One behaviour change, in both renderers: **the ring where a side chain meets the
backbone is no longer inked.** A side chain is part of its residue, not an
object standing on it, and a ring of ink draws the join as a seam; it also makes
a box poking slightly through the ribbon far less conspicuous.
`renderer.cartoonBaseInk = true` restores it.

## What works

Fills, outline, colour, per-residue editing, the pencil, and the whole style
surface, on both the test pages and the app.

**Nothing rebuilds the mesh except geometry.** In the app the rebuild signature
covers the object, the frame, the visibility mask, and every geometry control.
Everything else is a redraw:

| control | mechanism | measured |
|---|---|--:|
| rotation, zoom | a uniform | 1UBQ 0.6 ms, 1TIM 2.1 ms |
| colour scheme | palette texture, 3 texels per segment | 1–4 ms, was 45–95 ms |
| shade, highlight, fade, smooth, ortho, pencil, ink weight and tint | uniforms | free |
| show/hide backbone or side chains | uniform + vertex clip | free |
| one residue's side chain | `setResidueVisible` — one texel | below timer resolution |

Element colouring DOES rebuild, and must: element colour takes half a bond, and
the 2D renderer cuts the bond when the palette carries a `halves` table — that
happens at capture, not at palette upload. The signature watches `halves`, not
`colorMode`.

**Rotation, 1TIM (494 residues), app, cartoon: 127.7 ms/frame → 2.1 ms/frame.**

Export is always the 2D path, by construction: PNG renders into a fresh canvas
(`ctx.canvas !== renderer.canvas`) and SVG has `getSerializedSvg`; the GPU entry
declines both and returns false, and `_renderToContext` falls through.

## The TUBE style on the GPU

A second, much simpler renderer in the same module, and a separate entry:
`py2dmolCartoonGPU.renderTube`. Same `useGPU` flag, same fall-back contract.

The tube style is one CAPSULE per segment - the 2D pass strokes a thick
round-capped line between two projected positions - so there is **nothing to
capture and nothing to unproject**: the geometry is the coordinates. One
instanced quad per segment, ten floats, and the capsule solved as a screen-space
SDF in the fragment shader.

**What it does better than the 2D pass**: writes `gl_FragDepth` from the
capsule's own surface, so two tubes that cross actually intersect. The 2D pass
has no depth buffer, sorts back to front and paints each segment whole, so a
crossing has to pick a winner.

**What it does NOT do is decide the colour.** The tube's shading is screen-space
occlusion - each segment darkened by everything in front of it - which is
core/mol.js's own calculation. The hook therefore sits immediately before the
stroking loop, NOT earlier, and receives `{order, count, segments, segData,
colors, shadows, tints, renderShadows, outlineWidthPx}`. Hooked earlier it read
the unshaded `colors` and lost the style's whole look.

Measured, 1UBQ tube against the 2D pass: **5.8% of painted pixels differ, mean
channel error 2.3/255** - far closer than the cartoon's 15.8%, which is what a
port of simple geometry with borrowed colour should look like.

Speed is the weak part: 2.7x on 1UBQ (0.96 -> 0.35 ms) but only **1.5x on 1TIM**
(5.59 -> 3.70 ms). The stroking was never the whole frame; the visible list, the
depth sort and the per-frame instance rebuild remain. The instance buffer is
rebuilt every frame because the occlusion shading is per frame. The available
win is to hook BEFORE the sort and cull - the depth buffer makes both redundant -
and to split the buffer so only the colour re-uploads. Not done.

### Three bugs it took to get the outline right

Worth reading before touching the two passes, because each looked like the same
symptom - "no outline" - and had a different cause.

1. **The depth mapping.** `clamp(1.0 - 2.0*t01, 0, 1) * 0.5 + 0.5` clamps the
   NDC value BEFORE converting it, throwing away the whole near half: every
   fragment nearer than the midpoint came out at exactly 0.5. It is
   `clamp(1.0 - t01 + push, 0, 1)`.
2. **`uDarken` was declared and never used.** A `str.replace` matched nothing
   and said nothing, so the outline drew at FULL brightness - the same colour as
   the fill, just a bigger radius, hence invisible. Second silent no-op of this
   kind in one session; assert that every replace landed.
3. **The outline must take its depth from the TRUE tube radius.** Growing the
   radius grows the bulge `sqrt(r^2 - d^2)`, which pulls the outline toward the
   eye by far more than the 0.0008 push meant to keep it behind its own fill -
   so the outline won everywhere and the whole drawing came out at 0.7. The halo
   is a flat skirt around the true tube, not a fatter tube: the shader carries
   `vRfill` alongside `vRpx` and clamps `dist` to it.

### Reading the build in the browser

`py2dmolCartoonGPU.build` is a version marker. "Is the browser running what I
just wrote" came up twice and cost real time both times. **A hard reload is not
enough** - it does not reliably revalidate the sub-resources. Navigate with a
cache-busting query on the PAGE url (`index.html?v=<timestamp>`) and check the
marker before believing any result.

## Numbers to check against

Lab, 1UBQ, welded frames, side chains on, yaw 210, fills only, `d > 24`:

| preset | smooth | differ | mean error |
|---|---|--:|--:|
| richardson | on | **15.8%** | 6.0 |
| richardson | off | 19.6% | 6.4 |
| cartoon | on | 16.4% | 7.4 |
| cartoon | off | 21.5% | 7.9 |

If a change moves these, it moved the shading. The outline is deliberately NOT
tuned to this metric — see below.

## Defaults, and the ones that are judgement calls

    line width  relativeOutlineWidth * zoomW * 0.8    ink bias 0.002
    slope-bias cap 0.004                              frame: welded

The 0.8 is the one number chosen by eye rather than derived: the GPU inks a
per-edge silhouette where the reference picks two corner curves per segment, so
it lays down about a quarter more ink at the same nominal width. **The outline
is tuned for how it looks, not for the pixel metric**, and the two disagree — a
solid line reads as a line, a dashed one reads as a fault, and the metric
prefers the dashed one because it counts pixels rather than strokes.

Bias is scaled by line width AND surface slope. That is what stopped the outline
zigzagging: a black outline at width 1.6 went from **63% broken strokes to
0.8%** with no manual bias at all.

## Rules that took a bug to find

- **A double-sided face is oriented at the eye, every frame.** At zero thickness
  a stick box collapses to one quad with nothing behind it, and the renderer's
  rule for it is "point it at the eye" — a per-VIEW decision. Baked at capture,
  every side chain vanished as the model turned past that view. Carried as
  `aTwo`; the cull skips them and the boundary-edge ink is unconditional.
- **The sheet cull must not read the shading normal.** Which side of a
  zero-thickness ribbon faces the eye is geometry. Read through the FLAT normal
  it is constant across the quad, and the pale inner face breaks through the
  coloured outer one in patches — a per-face cull by the back door, visible only
  with Smooth off.
- **A flat broad face takes the PIECE MEAN normal**, like the width bands
  already did. Its own station's normal put consecutive quads in different cel
  bands and made every station boundary a visible step.
- **Depth and fade are not the same number.** The depth buffer needs a range
  containing every corner; the renderer's `near` normalises over the span of
  prim CENTROID depths at this view. One range for both put the Fade slider 84%
  of the frame away from the 2D pass.
- **Ghost edges.** A rib face must not ink across a ribbon, but the cap at a
  piece end lands on exactly those edges; registered as ghosts they contribute a
  normal and a count and no ink, so the cap rim is silhouette-tested instead of
  drawn unconditionally.
- **Capture at DISPLAY size, apply the device ratio once, at the draw.** Handed
  the device size the 2D renderer centres and scales for it, and the structure
  comes back half again too big and off to one side.
- **The app's own focal length wins.** The capture projected through it, so the
  unprojection must divide by the same one.

## Open, in the order I would take them

1. **The 15.8% residual** on 1UBQ smooth-on. Biggest quality gap, unmoved.
2. **The outline draws ~25% more ink than the reference.** A RULE difference
   about which edges get drawn, not a depth epsilon.
3. **Draw animation** (sketch + wash). The wash is mostly uniforms.
4. **Per-residue side-chain edits in the app** still go through a rebuild: the
   mechanism exists (`setResidueVisible`) but the app changes the segment list,
   which the signature sees.

## Do not redo these

- **The ID buffer.** Built, measured, reverted: it landed between the two depth
  settings rather than beating both.
- **The vertex-normal weld.** Deleted once `_frameProbe` landed; `welded` and
  `station` measure identically.
- **Reconstructing the frame from projected rails.** Direction yes, sign no.
- **Mipmapping the paper tile.** The tooth is ~1.2 screen pixels, so the mip
  averages away exactly the octave the paper is made of and leaves a flat 5%
  darkening.

- `renderer.visiblePositions` is a **Set**, and the renderer's own test is
  `!mask || mask.has(i)`. Indexing it like an array returns undefined for every
  residue, so every one is skipped - silently, because the consumer arrays then
  just keep their previous contents.
- A `return` expression is evaluated BEFORE `finally`. A probe hook restored in
  `finally` must be read inside the `try`, or the caller gets the pre-capture
  value.
- GLSL has no hoisting: a `bool` used one line above its declaration fails to
  link, and the whole draw silently falls back. `window.__gpuLastError` carries
  the compiler message.

## Traps this cost real time to find

- A backtick inside a GLSL comment terminates the template literal. Twice.
- `gl.clear()` is INVALID_OPERATION on a framebuffer mixing colour and integer
  attachments.
- A sampler with no texture bound invalidates the **whole draw call**.
- Ten per-face scalars wanted 18 vertex attributes against WebGL2's 16; they are
  packed three-to-a-vec4. The current layout uses 15.
- A WebGL2 probe that leaks its context costs a real renderer its context after
  a dozen or so — the symptom was the GPU checkbox quietly disappearing.
- `syncStylePanel` drives visibility through `hidden`; an inline `display:none`
  either fights it or wins forever.
- `document.hidden` makes `requestAnimationFrame` never fire and inflates frame
  times ~9x.
- `str.replace` with an assertion on the count is NOT proof an edit landed where
  it matters when one logical change spans four sites.

## The measurement lesson, which is the main one

**Order matters when both paths write the same array.** The screen-position
port was "verified" at 0.00 px by rendering the 2D path and then the GPU path
and comparing `renderer.screenX` - which measures the 2D path's own output
twice and passes whether or not the GPU wrote anything. It did not: two
separate bugs meant nothing was ever written. Measure the GPU frame FIRST, and
prefer an assertion that fails when the mechanism is deleted - `tests/smoke.js`
36 does this for the renderer's half of the contract.


The pixel diff cannot referee an outline or a seam. It scored a DASHED outline
better than a solid one, and it scored two culls identically when one of them
left 95 of 710 shared stations showing the pale face against the dark. Every
outline and seam question in this file was settled by eye first and a targeted
probe second — never by the percentage.
