# GPU depth prototype — step one, measured

Question: **if the cartoon were rendered by a real 3D pipeline, how much of the
drawing would actually change?**

Not "how fast" in the first instance — though it is timed below, and the 1.28×
in `PERF_NOTES.md` turns out to be the ceiling for swapping the painter, not for
a 3D port.
The reason to want a depth buffer here is correctness: the painter sorts whole
bodies by one depth key, which is why a side chain can land on top of a ribbon
that is genuinely in front of it. `PAINT_ORDER.md` records six attempts to fix
that by choosing better keys; none improved both error directions.

    python3 -m http.server 8080
    open http://localhost:8080/tests/gpu3d_lab.html

## The experiment

One variable, isolated. Both panels draw the **same faces** — taken from the
renderer's own `_primProbe` primitive list, so geometry, colour and the tone
function are identical by construction — and differ only in how depth is
resolved:

| | |
|---|---|
| left | painter's algorithm: the faces in the order the renderer sorted them |
| right | WebGL2 with a depth buffer |

A third pass draws the same faces on the GPU **with the depth test off**, so
WebGL rasterises in submission order. That is the control that separates two
things which would otherwise be confounded:

- 2D canvas vs GPU-without-depth = **rasterisation** (fill rules, antialiasing)
- GPU-without-depth vs GPU-with-depth = **ordering**, and nothing else

## Result

1UBQ, richardson preset, side chains on every residue, 600×600, swept over 36
views at 10° of yaw:

| | mean px | share of canvas |
|---|--:|--:|
| **ordering** | **674** | **0.19%** (worst 1012, 0.28%, at yaw 90°) |
| rasterisation | 13590 | 3.8% |
| — of which on a colour boundary | 13497 | 99.3% of it |
| — of which inside a face | 56 | 0.016% |

**Two things follow.**

1. **Moving to a depth buffer changes about 0.2% of the drawing** — and those
   are precisely the pixels the painter got wrong. The style does not move.
2. **The canvas-vs-GPU rasterisation difference is antialiasing and nothing
   else**: 99.3% of it sits on a colour boundary, and 56 pixels per frame land
   inside a face. A GPU renderer is not going to *look* different for reasons
   of rasterisation.

The honest reading: the depth buffer is worth having for correctness, and it is
a small visual change, not a redesign. It does not by itself justify a rewrite —
it justifies a *fill* pipeline on the GPU with everything else held fixed.

## Is it faster?

The fill stage, timed in the same lab (median of 15, after warm-up, with a
1-pixel `readPixels` after each GPU draw so the timing waits for the pipeline
rather than for the queue):

| structure | faces | canvas 2D | GPU, upload each frame | GPU, geometry resident |
|---|--:|--:|--:|--:|
| 1UBQ | 1 841 | 5.6 ms | 3.7 ms (1.5×) | — |
| 9FOG | 81 806 | 81.8 ms | 22.5 ms (3.6×) | **1.8–3.1 ms (26–45×)** |

The resident figure varies run to run, so it was checked rather than taken:
drawing the same 163 612-triangle buffer 1, 4 and 16 times per timed iteration
costs 3.11, 4.40 and 10.22 ms, i.e. **0.47 ms of marginal rasterisation per
draw** on top of ~2.6 ms of fixed cost (clear, submission, and 0.22 ms of the
`readPixels` sync itself). The work is real and the GPU is nowhere near
saturated at this size.

Three things to read out of that, in order of importance.

**The 45× is the interesting number, and it is not the frame.** It is the fill
rasterisation alone, with the mesh already on the card. Fills are about a
quarter of a real frame (`PERF_NOTES.md`), so replacing only them is the 1.28×
ceiling measured there — and this lab agrees, because 22.5 ms of the 3.6× case
is upload.

**What makes the 45× reachable is that the geometry is view-independent.**
Slab rails, pairing, base frames and plates are functions of coordinates and
secondary structure, not of the camera; `PERF_NOTES.md` classifies them that way
already. A 3D port uploads the mesh once per structure and a rotation becomes a
uniform. That removes the per-frame geometry rebuild (18% of a frame) as well as
the fills (25%) and the shading (5%) — about half the frame going to near zero,
where today's painter-replacement ceiling only touches the fills.

**So "how much faster" depends entirely on the ink**, which is the remaining
33% and stays on the CPU unless step three lands. Fills + geometry + shading on
GPU with the analytic ink kept: roughly 1.9× and a correct depth order. Ink on
GPU as well: a different regime, and the ribosome becomes interactive.

None of this changes the earlier conclusion that speed is the weaker argument —
but it does correct its scale. The 1.28× figure is the ceiling for *swapping the
painter*, not for a 3D port.

## Using it

Serve from the repo root and open `/tests/gpu3d_lab.html`. A server is needed
because a `file://` page is an opaque origin, so fetching the `.cif` beside it
is a cross-origin request the browser refuses — nothing here is remote, it is
the security model. Opened from disk the page says so and offers a file chooser,
which works because picking a file grants access explicitly.

`show` has **two** entries, and it had three until one of them was found to be
lying. The removed `GPU only, big` drew through the ordering experiment's
program — which carries a deliberately matched stand-in tone, not the ported
shading — so every shading fix in this file was invisible in the one mode whose
name suggested it was the GPU renderer. What remains:

- **the GPU render (drag to turn)** — the resident path, the actual subject of
  this file. Everything below is in here and only here.
- **ordering experiment (four panels)** — the step-one comparison. Both of its
  canvases share one stand-in tone *on purpose*, so the only variable between
  them is depth resolution. Its panel titles now say so.

**The 2D renderer cannot be switched off** in the four-panel mode: it is what
builds the faces, and step one is deliberately downstream of it so the two
panels are comparable. The resident path does have its own geometry stage.

Every preset reaches the same shader; measured after the collapse, ribbon plus
side chains against the reference:

| structure | preset | differ | mean err |
|---|---|---|---|
| 1UBQ | richardson | 26.6% | 8.9 |
| 1UBQ | 3d | 28.3% | 10.0 |
| 1UBQ | cartoon | 32.4% | 10.0 |
| three-way fixture | richardson | 1.4% | 0.7 |
| benzene fixture | 3d | 1.9% | 0.8 |

The fixtures are essentially exact; the protein residual is the ribbon path,
which is the subject of "What the residual is, and what it is not" below.

## Resident geometry — the same scene, interactive

The projection is orthographic, so it is invertible: the primitives come back in
screen space but `x = (sx − W/2)/scale`, `y = (H/2 − sy)/scale`, `z = sz`
recovers the rotated 3D positions exactly, and undoing the known capture
rotation gives model space. So the mesh can be uploaded **once** and the camera
becomes a `mat3` uniform, with the tone computed in the vertex shader from the
rotated face normal.

`show → GPU only, mesh resident` does that. Measured on 9FOG with side chains on
every residue — **81 804 faces**, the heaviest thing in the lab:

| | |
|---|--:|
| 2D renderer, per view (what step one pays every redraw) | **6 515 ms** |
| unproject + build the resident buffer, once | 581 ms |
| first GPU draw | **0.9 ms** |
| drag frame thereafter | **~0.1 ms** CPU-side, 0.47 ms marginal on the GPU |

The 2D renderer runs **once**, at load. Turning the structure after that does not
touch it. This is the structural argument for a 3D port made concrete: the
ribbon is a function of coordinates and secondary structure, not of the camera,
so rotating it should never rebuild it — and today it does, on every frame.

A stale-cache bug lived here and is worth the warning: changing the structure
while resident redrew through the *non-resident* path, so the new structure
appeared — and then the first drag called `drawResident()`, which still held the
previous structure's buffer and visibly jumped back to it. Anything that changes
the mesh (structure, preset, the side-chain toggle) now clears `resident` and
every redraw goes through one `refresh()` that honours the current mode.

Two honest limits on that number. The 6.5 s is inflated by the fixture (side
chains on all 3 445 residues is not a view anyone asks for; the toggle turns
them off). And the invertibility trick works **only under ortho** — with
perspective the divide has thrown information away, and the capture has to move
upstream into the geometry builder, which is step two proper.

## Step two: the shading, ported

`shade()`, `faceTone()` and `faceLum()` are now in the vertex shader with the
renderer's own constants, and the base colours are the app's rainbow palette
rather than the lab's flat blue and orange. `show → GPU only, mesh resident`
puts the real renderer beside it.

**The port is exact.** Verified at the level that matters, on the largest rib
face: the renderer's formula, computed by hand from that piece's captured
`oB/oK/oLb/oT`, gives `rgb(45,209,255)`; the pixel the renderer actually painted
there is `rgb(45,209,255)`. So the transcription, the constants and the cel
quantisation are right.

Three things had to be got right to reach that, each found by measuring rather
than by reading:

- **The uniforms have to be the renderer's, not the preset's.** The shader was
  using richardson's shade 0.7 and highlight 3.0 while the reference renderer
  ran on its own fields at 1.0 and 1.0 — so the two shaded differently before
  any geometry was involved. 97.6% → 73%.
- **A stick is not a ribbon.** It takes no facing wash (`tone = 1`), no inner
  shadow and the standard 0.55 knee rather than richardson's broad 0.25 — a
  solid keeps its full tone and lets the light alone decide. Without this every
  side chain came out flat, which is exactly what it looked like.
- **The inner face of a richardson helix is tinted 0.68 toward white**, chosen
  by concavity rather than by which label the face carries, with the inner
  shadow eased on those same faces (`BACK_INNER_SHADE`).

## Match it in white first

The right way to test this, and not the one I started with. On a white base the
colour is roughly `255 x mul`, so a 5% luminance error shows as 13/255; on a
saturated blue the same error is 2/255 and passes any threshold. **White is the
strict test and colour flatters** - which is why the colour numbers below are
better than the white ones and mean less.

`white` and the preset dropdown drive both the renderer and the shader from
`LOOK_DEFAULTS`, so the two cannot be configured differently.

| preset | white | agree | differ on edge | differ inside | bias |
|---|---|--:|--:|--:|--:|
| 3d | yes | 60.9% | 16.4% | 22.6% | −2.3 |
| 3d | no | 69.9% | 15.4% | 14.8% | −1.2 |
| richardson | yes | 56.3% | 16.9% | 26.8% | −4.1 |
| richardson | no | 66.6% | 17.4% | 16.0% | +2.0 |
| cartoon | yes | 56.8% | 14.8% | 28.4% | +3.0 |

Getting from 51% differing-inside to 22% took four fixes, each identified by a
measurement rather than by reading:

- **Turn the cel quantisation off in the shader.** Every preset that matters is
  `smooth: true` anyway, and banding actively misled: a face whose recovered
  frame was 0.02 out landed a whole 8-level band away, so an input error of no
  visual consequence read as a large pixel error.
- **Orient a stick's normal.** A quad's winding does not say which way its face
  points, and for a stick that is fatal rather than cosmetic - the wrong sign
  makes `max(0, n·L)` clamp to zero, the knee is never crossed, and the side
  chain gets no highlight at all. This alone swung the signed bias from
  **−17.3 to −1.6**: the systematic darkening was all side chains.
- **Per-station normals.** A quad spans two stations and the ribbon twists
  between them, so one normal per face throws away exactly the variation the
  smooth path draws as a gradient.
- **The thickness band is not part of the modelled surface.** It takes
  `SHEET_EDGE_RGB` on richardson strands, a constant `edgeTone()`, and is lit by
  the WIDTH normal with no inner shadow - the white card the coloured face is
  mounted on. Caps are the same card at a fixed neutral luminance, and were not
  being emitted at all.

## Start small: the stick fixtures

Debugging a junction on a whole protein is hopeless. The lab's structure
dropdown now carries the three small cases from `tests/make_stick_test.py`, at
the same coordinates, so anything found here is findable on that page too.

They found a real bug immediately — **dark triangles at every three-way
side-chain junction**. A mitred junction is emitted as a triangle fan padded to
a quad, `[q0, qk, qk+1, q0]`, so its fourth corner repeats the first and
`cross(m1 - m0, m3 - m0)` is exactly **zero**. A zero normal makes
`max(0, n·L)` clamp, the face falls to flat ambient, and the junction fills
come out dark. Summing over all edges (Newell) is immune to a repeated vertex.

With that fixed, the isolated cases are essentially exact:

| fixture | primitives | differ | mean channel error |
|---|---|--:|--:|
| benzene | 36 stick faces, no joints | 1.9% | 0.8/255 |
| three-way | 18 stick faces + **2 joints** | 1.5% | 0.7/255 |
| tetrahedral | 24 stick faces + **8 joints** | 0.9% | 0.3/255 |

Those residuals are edge antialiasing; side by side the two panels are
indistinguishable, mitre and highlight included.

They found a second one as soon as the mesh was rotated: **the back of every
stick was missing**. The renderer culls a face that points away
(`draw: o[fi] > -STICK_CULL`), and that decision is made at the CAPTURE view -
so dropping those faces bakes one camera into a mesh that is supposed to be
view-independent. A resident mesh has to carry the whole solid and cull per
frame, which the fragment shader now does. Buried faces come along too and cost
nothing: they are inside a closed box, so the depth buffer hides them without
being asked.

Checked by rotating the resident tetrahedron and counting painted pixels
against the reference at the same view: **0.998-0.999 of them at every yaw from
0 to 300 degrees**, where before the fix the back simply had holes in it.

This is the sharpest example of the capture approach's one real limitation.
Anything the 2D renderer decides *per view* - culling, and the interval
culling that drops offscreen geometry - is frozen into the captured mesh. A
real port builds from coordinates and never inherits a camera.

**This decomposes the remaining whole-protein error.** Sticks and junctions are
verified correct in isolation, so the ~22% differing inside faces on
3d + white is in the RIBBON path — not in the side chains, and not in the
shading model, which these fixtures exercise end to end.

## Richardson: a zero-thickness helix has two coincident faces

Reported as "some helices painted all lighter". The cause is specific to this
preset: `RICH_TH_REL = { H: 0 }` gives a helix **no thickness**, so its +b and
-b faces occupy the same plane. They carry different colours - the outer keeps
the element's, the inner is tinted 0.68 toward white - and the painter's
algorithm separates them by draw order, so the outer one always wins.

A depth buffer cannot separate them at all. They z-fight, the pale inner face
breaks through the outer one in patches, and a helix reads as washed out.

**The fix is not to merge them.** That was the first thing tried and it is
wrong: a sheet has two surfaces with two colours, and collapsing them into one
double-sided quad loses that and measured worse (36.2% against 35.9%). Keeping
both and culling whichever side is turned away removes the fight instead:

| richardson, 1UBQ | merged | two faces, one culled |
|---|--:|--:|
| colour, ribbon only | 36.2% (err 15.0) | **30.5%** (err 9.8) |
| colour + side chains | 30.1% (err 12.0) | **26.6%** (err 8.9) |
| white | 46.4% | 46.4% |

White is unchanged, which is the check that this is the right explanation:
with one colour everywhere the tint cannot differ, so a fix about *which
coloured face you see* must do nothing there.

## A measurement discipline this file had to learn twice

**Numbers from different moments in a session are not comparable.** Two wrong
conclusions came out of ignoring that, both caught by the person reading over
my shoulder rather than by me:

- A per-station frame change "improved 33.8% to 1.4%". It had not: a page
  reload reset the structure dropdown to its first entry, which had just become
  a four-atom fixture, so the two numbers were different scenes. Same trap the
  ordering diff had earlier when the reference went stale after a drag.
- I then called the per-station change a regression, because 40.4% looked worse
  than a 22.6% recorded earlier. But that earlier figure came from a different
  configuration AND a different build - side chains on, before caps, side faces
  and the per-view culling existed. The lab had moved underneath the number.

So the lab now switches variants **at runtime** (`frame`, `white`, `exact`)
rather than by editing and reloading, and any comparison worth reporting is
measured back to back in one session. Done that way:

| 1UBQ, 3d, white, ribbon only | differ | mean error |
|---|--:|--:|
| per-station frames | **40.4%** | 11.5 |
| piece-mean frame | 49.1% | 13.0 |

Per-station is better, and it is also the only one of the two that can produce
the smooth gradient the preset asks for - the piece mean paints one tone per
station pair, which reads as banding across the ribbon.

Current baseline, all measured in one session with per-station frames:

| preset | white | side chains | differ | mean error |
|---|---|---|--:|--:|
| 3d | yes | yes | 36.8% | 10.0 |
| 3d | yes | no | 40.4% | 11.5 |
| 3d | no | yes | 28.3% | 10.0 |

The stick fixtures remain at 0.9-1.9%, so the ribbon path is where all of this
lives.

## What the residual is, and what it is not

Against the real renderer at the same view, fills only:

| | agree | differ on an edge | differ inside a face |
|---|--:|--:|--:|
| frame recovered from the projection | 30.6% | 25.2% | 44.1% |
| the renderer's own dot products fed in | 37.9% | 25.1% | **37.0%** |

The second row is the control: feeding the shader the captured dots instead of
recovering them isolates "is the shading port right" from "is my capture hack
precise". It accounts for 7 points, and the mechanism is visible in a single
face — the shader's luminance came out 1.124 against the renderer's 1.032,
which is **exactly one cel band**. Recovering a frame from a projected drawing
is good to about 0.02–0.05 in these dots, invisible on its own, and enough to
land a face one band out when it falls near a boundary. **A real port never has
this error**: it builds the frame in model space and never projects it away.

The remaining ~37% is not mysterious, it is unported paths. Each is a specific
branch of the painter this prototype does not implement:

- **cap faces** (`capStart` / `capEnd`) are not emitted at all, so every piece
  end is reference-only pixels
- **arrowheads**, **base plates**, **tubes**, **dots** and **lines** likewise
- **the strand light edge** — richardson gives strands the only light edge in
  the drawing, and the width faces are not treated
- the **smooth/gradient** path, when `cartoonSmooth` is on

None of those is evidence against the approach; they are the rest of the work.
The thing worth taking from this section is that the shading model itself
transcribes exactly, and that the errors that remain each have a name.

## What this run does NOT cover

- **Tubes, base plates, dots and lines** are skipped; only quad faces come
  through (`rib` sub-quads, `stickFace`, `joint`). The panel prints the skipped
  count so the number can never be quietly partial — on richardson with side
  chains it is 0, because loops are drawn as profiled strips rather than tubes.
- **The tone function is a stand-in**, not the renderer's `shade()`. It is a
  lambert term off the face normal plus a depth fade, applied identically to
  both panels. That is deliberate for step one — it holds shading constant so
  the measurement is about ordering — but it means this says nothing yet about
  whether a shader can reproduce the real look.
- **The ink is absent.** It is the part of the style most at risk, and it is the
  whole of step two.

## A shortcut that does not work — capturing the colours instead of porting them

Worth recording, because it looks like it should work and it would have saved
the whole shading port.

Counted on a real 2D context (grain off — the pencil path renders offscreen and
blits, so with it on the paint stream is invisible from outside): **1359 fills a
frame, every one of them flat**, plus 284 two-stop gradients that go to strokes,
and 1320 strokes. Flat per-face colour means the exact tone of every face ought
to be recoverable by recording the canvas, with no need to reimplement
`shade()`.

It is not. Pairing each recorded polygon to its face by first vertex matches
only **67%** of them, because `pathStrip` merges adjacent same-colour quads into
a single path — one recorded polygon is several faces, and the per-face colour
simply is not in the stream. Turning the partial match on inflates the ordering
figure to 13.7%, which is an artifact of the 33% of faces left with a
stand-in tone, not a result.

The pairing code is still in the lab, switched **off**, because the match rate
is itself the measurement: it says a third of the frame is merged, and that is
work a shader port has to reproduce (or deliberately not — a shader has no
reason to merge).

## Step two, and how to judge it

Compare the **real renderer output** against a GPU render styled to match.
Because of the merging above, that means genuinely porting `shade()` — the depth
fade, the highlight toward paper, the 8-band cel option — into a fragment
shader, rather than lifting colours off the canvas. Then composite the vector
ink over it unchanged and multiply the paper tile, and diff against the
reference over the same 36 views.

Whatever remains after ordering (0.19%) and edge antialiasing (3.8%, benign) is
the **shading gap**, and that single number answers "can a shader reproduce this
style".

Step three is the outline itself, and it is the one that decides the question.
Extract true mesh silhouettes on the GPU — an edge is drawn iff exactly one of
its two adjacent faces is front-facing, which is the rule the ligand-stick ink
already uses — and draw them as extruded camera-facing quads, depth-tested. That
is **not** the `_inkMode='zbuf'` experiment: that one sampled a CPU-extracted
line against a rasterised buffer at discrete points, and its 5–12% pixel
disagreement and 2× flicker are quantisation of *visibility sampling*. A
silhouette drawn as geometry has continuous depth and is occluded by
construction. Post-process depth/normal edge detection would reintroduce
exactly the flicker; do not use it.

## Costs that are not pixels

Recorded here because they will decide this, not the diff numbers:

- **SVG/SVGZ export** (`saveImage({format:'svg'})`) rides the canvas path. A GPU
  renderer cannot emit it. Keeping it means keeping the 2D renderer alive, and
  `PERF_NOTES.md` already records an export silently drifting from the screen.
- **The whole test strategy is a mock 2D context.** The ink trace, the
  paint-stream hash, `paint_order_audit.js` and the smoke suites all drive
  `ctx` in Node. None of that survives a shader pipeline; verification becomes
  browser pixel diffs, which are slower and noisier. Given how many wrong
  conclusions in this project have come from harnesses rather than code, treat
  that as a first-class cost.
- **Zero-thickness ribbons.** Richardson helices are flat sheets
  (`RICH_TH_REL = { H: 0 }`). A silhouette is defined on a solid; a degenerate
  one has none. Either give them small real thickness — which changes the look
  being mimicked — or special-case two-sided surfaces.

## Smooth was half-applied on both sides, in opposite directions

Reported from the screen, twice, and both reports were the same defect wearing
different clothes: **one routine handles the broad faces and nobody handles the
thickness bands.**

**The 2D renderer** (`viewer-cartoon.js`, the `rib` branch). `paintFace` opens
with `if (cel) { ...pathStrip; return; }`; `paintSide` had no `cel` branch at
all. With smooth off the faces went flat and the two thickness bands kept their
per-station linear gradients - one surface of every loop still airbrushed
inside an otherwise banded drawing. What hid it was the constant `sideLumAt`
sitting beside the gradient code with a comment saying the sides are solid in
practice: true when written, false once both call sites started passing a
non-zero `outward`. Fixed, and pinned by smoke test 35, which asserts on
GRADIENT COUNT (0 with smooth off) and checks the smooth-on control first so a
fixture that never reaches the smooth path cannot pass by drawing nothing.

**The shader** (`gpu3d_lab.html`). Per-station frames were handed out under
`f.surf === 0 || f.surf === 1` - the broad faces - so with smooth ON the bands
took one frame per quad and stayed flat. Fixing it turned up two more bugs on
the same surfaces:

- **The sign.** `w` is built as `R - L`, but the renderer puts the L rail at
  `+wa` (`lp = P(1, 1)`, `rp = P(-1, 1)`) and defines `oN` as `wa . view`. So
  `R - L` runs along `-wa` and the L side's outward direction is *minus* that
  vector. The first cut had it backwards and measured WORSE than no fix at all
  (richardson smooth 26.6% -> 29.9%): each band was lit with its neighbour's
  value. The tell was that FLAT mode regressed too, which an interpolation
  change cannot cause.
- **The old orientation was meaningless.** Before this, a side face took the
  quad's Newell normal oriented by comparing its z against `f.oB` - a
  *broad-face* quantity - so the bands took an effectively arbitrary sign per
  piece. This is why flat mode improves as much as smooth does.
- **`exact inputs` lied on a quarter of the surfaces.** A band is lit by the
  WIDTH normal, so its exact dots are the renderer's `oN`/`oLn`, not
  `oB`/`oLb`. The control that exists to separate "port wrong" from "capture
  imprecise" was itself wrong on every side face.

1UBQ, ribbon + side chains, before -> after:

| preset | before | after |
|---|---|---|
| richardson smooth | 26.6% (8.9) | **20.9% (7.0)** |
| richardson flat | 33.1% (9.8) | **28.4% (8.2)** |
| 3d smooth | 28.3% (10.0) | **18.1% (6.4)** |
| 3d flat | 35.1% (10.9) | **25.9% (7.6)** |
| richardson white | 46.4% | **25.3% (5.4)** |

The stick fixtures are unchanged at 1.4% and 1.9%, which is the control: they
have no ribbon, so nothing about them should move.

### One sub-decision that measures worse and is not explained

The shader's side branch also had no `quant`, so once the renderer started
banding its bands the shader still did not. Adding it costs 0.4pp (richardson)
to 1.2pp (3d) in flat mode. It was kept anyway, and this is the reasoning:

- Replicating both formulas over 402 captured side surfaces and diffing them
  gives **worst absolute difference 0.0** - with exact inputs the shader's
  quantised side lum IS the renderer's, to the bit. `CEL_LEVELS` is 8 on both
  sides with the same rounding, and `edgeTone()` is literally `soft(FLAT_TONE)`.
- So a metric that prefers the un-quantised version is preferring a value that
  is provably not the reference's. That is not enough reason to ship a shader
  known to be wrong.

What was ruled out: stale script cache (the page was confirmed running the
fixed, unminified source), quantisation granularity (feeding the piece mean
instead of the per-quad value gained 0.1pp), and a tone-constant mismatch.
Distinct-colour counting cannot referee it - depth fade varies per piece and
antialiasing dominates (29.4k colours flat vs 34.8k smooth on the same view).

**The contradiction is still open**: turning the side quant on can only change
side pixels, those pixels become provably exact, and the pixel count gets
worse. The next step is the visibility-aware per-face probe this file has
wanted twice now - scoring only the pixels a given face actually owns, instead
of a whole-canvas difference in which one surface's improvement can be masked
by its neighbours' coverage.

## The outline on the GPU — and yes, it is fast

`show → the GPU render`, `outline` on. One instanced quad per edge, 6 vertices
from `gl_VertexID`, silhouette decided in the vertex shader, visibility decided
by the depth buffer per FRAGMENT.

### Speed

1TIM, 600x600, same view, interleaved, min of 5:

| | ms |
|---|--:|
| CPU frame, no outline | 72.5 |
| CPU frame, outline on | 129.3 |
| **CPU ink pass** | **56.8** (44% of the frame) |
| GPU fills only | 0.015 |
| GPU fills + outline | 0.027 |
| **GPU ink pass** | **0.013** |

Roughly **4000x**. Two structural reasons, and neither is "the GPU is faster at
arithmetic":

- The analytic pass rebuilds its occluder grid every frame because the grid is
  in SCREEN space, so every rotation invalidates it - 122 ms of 356 on 4UG0.
  The edge buffer is in MODEL space, uploaded once; a rotation is a uniform.
- Visibility is not computed at all. It is a side effect of the depth test that
  the fills already wrote.

Scaling is nearly flat over the range measured: 1UBQ 2927 faces / 3842 edges
costs 0.008 ms, 1TIM 17585 / 21776 costs 0.013 ms. Six times the geometry for
1.6x the time - it is still dominated by fixed overhead at this size.

Caveat on method: these were taken with `document.hidden` true. Both sides were,
so the comparison is like for like, and the CPU figure agrees in magnitude with
the independent numbers in PERF_NOTES - but a factor of two either way is not
established. A 4000x ratio survives that.

### Getting the rule right cost four tries

Each one drew lines the reference does not have, and each was found by looking
rather than by the pixel metric:

1. **A crease rule.** The first cut force-drew any edge whose faces disagreed by
   more than 40 degrees: 3608 of 4677 edges marked always-draw, every internal
   seam inked. The renderer's own comment is the specification - "INK: THE
   SILHOUETTE, AND NOTHING ELSE... an interior crease fails that test by
   construction, so no line can ever cross a face." There is no crease rule.
   The control survives, defaulting to 180 = off, only to show what it costs.
2. **Winding normals instead of outward normals.** A silhouette test means "one
   adjacent face points at the eye and the other does not", which is meaningless
   unless both normals point out of the same solid. The strip emits its +b and
   -b faces with the same corner order, so their Newell normals agree and a rail
   edge never fired. `nn` is already outward everywhere except the -b face,
   which `top` identifies.
3. **Cross-strip edges.** The reference does not run a face-normal test over a
   slab at all: it inks the four CORNER CURVES and picks, per segment, the two
   that are extreme perpendicular to the chain's screen direction - so its ink
   runs ALONG a ribbon and never across it. A generic silhouette test does draw
   across, wherever the face rolls through edge-on, and that is a real
   silhouette of the surface but not a line this drawing has. Rib faces now
   contribute their two rail edges only.

Plus one that was not a rule but a weld: consecutive bond boxes and consecutive
ribbon pieces each contribute their own end cap, on exactly the same four
corners. Those caps are interior. A quad that appears twice is dropped along
with both copies (1UBQ 382 faces, 1TIM 3048).

### The fourth rule error: non-manifold edges

The three-way junction drew a closed triangle around itself that the reference
does not have, and side chains kept short lines at bond boundaries. Both were
the same thing, and it is not a silhouette question at all.

**9 of the 33 edges of the three-way fixture have more than two incident faces**
- six have three, three have four. The edge table kept the first two normals it
  saw and ran the silhouette test on that pair. But "exactly one of the TWO
  faces meeting along this edge points at the eye" is not merely wrong when
  there are four faces, it is undefined: the arbitrary pair bounds nothing.

The count is itself the answer. Where three bonds meet, material fills all the
way around the shared edge, so it cannot lie on the outline of anything:

| incident faces | meaning | rule |
|---|---|---|
| 1 | open boundary | draw while that face faces the eye |
| 2 | a real surface edge | the silhouette test |
| 3 or more | inside the join | never drawn |

The renderer arrives at the same place from the opposite direction - it tests
each edge against the convex hull of its own box's projected corners and rejects
any that lands inside, because "a junction solved out of plane" can pass the
face test for an edge sitting well within the shape. Adjacency needs no hull and
no per-box grouping.

Dropped: 9 of 33 edges on the fixture, 486 of 3842 on 1UBQ. The fixture with
BOTH sides inked then matches at **1.8% (err 0.7)** - the same level as the
fills-only comparison, i.e. the outline agrees with the reference to within
antialiasing. On 1UBQ the pixel metric barely moves (30.8% -> 30.5%) while the
drawing is visibly correct, which is this file's recurring lesson about which
of the two to trust.

### The fifth: a zero-thickness ribbon is not an interior seam

Helices came out with no outline at all while everything around them had one.
`RICH_TH_REL = { H: 0, E: 1.0, C: 1.0 }` - richardson gives a helix ZERO
thickness - so this was not a corner case, it was every helix in the signature
preset.

Two independent causes, and the first fix exposed the second:

1. **The weld ate them.** At zero thickness the +b and -b faces sit on exactly
   the same four corners, which is indistinguishable by geometry from two solids
   butted together. It is not the same thing: a seam has material between the
   two faces and a flat ribbon has NOTHING - it is one surface with two sides.
   `sheet` already marks exactly this pair, so the weld skips it.
2. **The degenerate side face double-counted the rail.** With the faces restored,
   `interiorDropped` fell by 128 and `nonManifoldDropped` rose by exactly 128 -
   the rails were surviving the weld only to be dropped by the junction rule. At
   zero thickness a width face collapses to a line: its quad is [P, P, Q, Q], so
   both of its surviving sides are the SAME rail P-Q and one face registered one
   edge twice. Every flat rail reached four incident faces and looked like a
   junction. Faces of zero area now contribute nothing, and no face may count an
   edge twice.

With both fixed the rail has exactly two incident faces, the +b and -b sides of
the same surface, whose outward normals are exactly opposed - so the silhouette
test is true from every angle, which is right: a zero-thickness ribbon shows its
edge whichever side you are on.

### What is still wrong: the depth epsilon

A residue remains: a silhouette edge lies exactly ON its own two faces. A silhouette edge lies exactly ON its own two faces, so with no
bias it z-fights its own surface and stipples away: dark pixels go 11039 at bias
0.004 to 3124 at bias 0. But a bias big enough to stop that is also big enough
to pull an interior cap rim through the box it is sitting inside - and boxes
DO simply overlap wherever a junction is not coplanar, by design.

That is the same trade PERF_NOTES already recorded for the zbuf backend
("fidelity and flicker trade off; neither reaches the analytic path"), arrived
at from the opposite direction. It has a real fix, and it is not a better
epsilon: render a face or solid ID alongside the depth, and draw an ink fragment
only where the visible ID belongs to one of the edge's own two faces. An
interior rim is then rejected because the ID visible there is the neighbouring
box, and a genuine silhouette needs no bias at all because it is not being
compared against itself. Integer identity, no epsilon to tune.

## Smooth shading: the frames were never the problem

The ribbon still read as flat facets with smooth on, even though per-station
normals were reaching the shader (506 of 506 broad faces, 470 of them with the
two ends genuinely differing). The banding ran ACROSS the ribbon, one tone per
quad, which is the signature of neighbouring quads disagreeing rather than of
no interpolation.

**149 of 1UBQ's 201 ribbon pieces carry only two stations.** A piece frame is
built from a one-sided difference over that piece's own centres, so with two
stations both ends get the SAME tangent - and two pieces meeting at a shared
station disagree about it. Almost every quad boundary is a piece boundary, so
almost every quad boundary steps. Interpolating harder inside a quad cannot fix
a discontinuity at its edge.

Reconstructing the true tangent needs to know which piece follows which, and the
captured prims do not say. **Welding the vertex normals needs no connectivity:**
consecutive pieces compute the same point for the station they share, so keying
the average on POSITION welds them for free - the same trick the edge table
already uses. `frame → weld vertex normals`, now the default.

Three things the weld has to respect, each found by it going wrong:

- **A smoothing angle (50 degrees).** Welding every shared station rounds off
  the folds as well - a ribbon doubling back, the step into an arrowhead - and
  the reference keeps those sharp. Past the threshold a face keeps its own
  normal.
- **Sticks and caps are excluded.** They are solids with genuinely flat faces
  and the reference paints them one tone per face. Confirmed by the fixtures
  not moving at all: benzene 1.8%, three-way 1.4%, identical in both modes.
- **THE TWO BROAD FACES SHARE ONE KEY.** This one is not cosmetic. Both carry
  the +b direction as their normal, with `aTop` saying which side this face is,
  and that is what makes the sheet cull `(aTop > 0.5) != (oB > 0.0)` exactly
  complementary - one of the pair drawn, never both. Keyed separately, a
  zero-thickness helix got two independently averaged normals that were no
  longer exactly opposed, the test began selecting both or neither, and the two
  coincident quads z-fought: the pale inner face bleeding through the coloured
  outer one. The width faces stay apart, since surf 2 carries -w and surf 3 +w
  and averaging those cancels.

### The metric disagrees, again

| | station | welded |
|---|--:|--:|
| 1UBQ yaw 210 | 20.9% | 25.9% |
| 1UBQ yaw 300 | 18.8% | 20.4% |
| 1BBH | 31.9% | 34.6% |

Welded measures worse everywhere and looks right everywhere - the ribbons carry
a continuous gradient like the reference instead of banding into quads. The
trade is real rather than a measurement artefact: a per-station frame is the
better estimate AT each station, while the average is a smooth but biased blend
of two estimates that disagree. What the metric cannot see is that one error is
structural (banding, which the eye reads as a different material) and the other
is a small uniform bias.

Both modes are kept on the `frame` control so this stays checkable. It is the
sixth time in this file that the pixel count and the drawing have disagreed, and
the sixth time the drawing was right.

## Atoms winking in and out was the viewport cull, not the frame

Turning a resident mesh a long way from the view it was built at left holes -
side chains present after a rebuild and absent before it. This was first put
down to face orientation being resolved at build time, which is a real effect
and was the wrong answer: it accounted for a fraction of it.

The renderer culls primitives that fall outside its viewport (`cullSeg`,
viewer-cartoon.js, plus the matching test on the generic-segment path). That is
right for painting a frame and wrong for HARVESTING geometry - the mesh then
holds only what was on screen at the capture view, and every rotation opens a
hole where the frame happened not to look.

`renderer._noViewCull` switches it off at the source, and the capture sets it.
Measured on 1UBQ, geometry present only after a rebuild:

| rotation from the build view | before | after |
|---|--:|--:|
| 160 deg yaw, 80 deg pitch | 891 px (0.49%) | **11 px (0.01%)** |
| 90 deg yaw | - | **56 px (0.03%)** |

The flag defaults to false, so nothing in the app changes; smoke is 35/35 on
both the source and the minified build.

The residue that is left is the baked orientation, now visible at its true size
rather than hidden inside a larger effect. An earlier attempt to solve this by
capturing into a viewport 2.5x larger with the extent scaled to match worked,
but needed a second set of dimensions threaded through `unproject` and kept the
scale arithmetic in step by hand - the flag is the same fix without any of that.

## Helix faces turning inside-out: one decision per ribbon, not one per piece

Reported as faces pointing the wrong way after a rotation, corrected by anything
that forced a rebuild, and then wrong again on DIFFERENT faces after the next
rotation. That last part is the diagnosis: a rebuild was re-deciding, and
re-deciding badly.

Each piece resolved "which way is +b" on its own by matching its frame against
the facing the renderer had captured for it:

    const flipAll = e.oB !== 0 && (zc < 0) !== (e.oB < 0);

`oB` is the piece's facing AT THE BUILD VIEW - a view-dependent answer to a
view-independent question. Where a piece lay near edge-on when the mesh was
built its oB is near zero and that comparison is a coin toss. Those pieces came
out inside-out (a helix showing its pale inner face outward), and rebuilding
tossed every coin again, so the wrong ones moved around.

Pieces meeting at a station are the same surface and have to agree, so the sign
is now settled in three steps:

1. orient each piece consistently WITHIN itself - no view involved;
2. propagate agreement between pieces that SHARE a station, which collapses a
   whole ribbon into one connected component with a single free sign;
3. spend the captured facing ONCE per component, on its strongest sample - the
   piece nearest face-on, whose |oB| is largest and whose reading is therefore
   the least ambiguous available.

N coin tosses of varying quality become one well-conditioned decision.

Measured on 1BBH, a helical bundle - rotate a long way, then rebuild at that
view and diff:

| | before | after |
|---|--:|--:|
| rotate 120/60, rebuild | pixels moved | **0.00%** |
| rotate 200/-40, rebuild | pixels moved | **0.00%** |

A rebuild now changes nothing, which is the property that was missing: the mesh
no longer carries a decision that belongs to the camera.

It also improved the match rather than merely stabilising it - **1UBQ 19.0% ->
16.7%** (err 6.8 -> 6.1) - because the coin toss was producing wrong
orientations at the build view too, not only away from it.

## Stop rebuilding what the renderer already has: `_frameProbe`

Four attempts to pin the sign of a ribbon's face normal, each wrong in a
different way, and the mistake was upstream of all of them.

The mesh is recovered by unprojecting the drawn corners, and the frame was
rebuilt from those rails as `cross(tangent, width)`. That recovers the frame's
DIRECTION but not its SIGN - nothing in a projected drawing says which side of a
ribbon was the outside - so every version needed a second step to decide it:

| attempt | how it decided | how it failed |
|---|---|---|
| per piece, from `oB` | match the captured facing at the build view | `oB ~ 0` on an edge-on piece is a coin toss: wrong faces scattered through a helix, and a rebuild re-tossed them |
| per ribbon, from `oB` | propagate agreement, spend one facing sample per component | the same coin, now flipping a whole helix at once |
| per piece, from rebuilt curvature | reconstruct `kv` off the centre line, match `sign(n . kv)` to `oK` | 1UBQ 41.9%, 1BBH 42.5%. Reconstructed curvature is not the renderer's |
| **ask the renderer** | `_frameProbe` emits `ub`, the width normal and the tangent in MODEL space | **exact** |

`evalSlab` has all three vectors in model space and immediately dots them with
the eye and the light. Everything a consumer receives is therefore a frame with
one view baked in. Emitting the frame itself is a few lines, off by default.

Verified by round trip: unrotate the probe vectors into model space, rotate them
back, dot with the eye - **worst error 0.00000 against the renderer's own oB,
oN and oT over 454 stations.**

Two things fell out of it:

- **The vertex weld became a no-op.** `welded` and `station` now measure
  identically (22.7% each at the time), because pieces sharing a station now
  agree exactly. The weld was only ever hiding the reconstruction's one-sided
  tangent error - see the section above, which is now a workaround for a bug
  that no longer exists.
- **Rebuilding after a large rotation changes nothing: 0.00%.** The mesh no
  longer carries any decision belonging to the camera.

Mind the frame the vectors arrive in: `mkRenderer` hands the renderer
coordinates that are ALREADY rotated, so the probe returns view-space vectors
and they need `inv` applied exactly as the corner positions do. Skipping that
rotates the lighting away from the geometry by the whole view matrix - 95.5%.

### Correction: that comparison was invalid

The table below was measured against an attribute that was never bound. The
edits meant to add `aFlatN` - the buffer allocation, the per-vertex write, the
stride, the `bind` call - **silently did not apply**; only the shader half did.
An unbound attribute reads (0,0,0), so `normalize(uRot * aFlatN)` is NaN, every
comparison against it is false, and the per-face cull was not being tested at
all. Worse, the same NaN sat in the stick and cap cull, so back faces of side
chains went unculled for that whole stretch.

Wired properly, the two culls measure the SAME: 1UBQ 15.8% either way, 1BBH 24.0
against 24.1. So the per-face version is free, and it is now the default,
because it does fix the pale seam. The reasoning in the original entry - that
the renderer decides per station and a constant cannot express a mid-face swap -
is sound in principle and simply is not what those numbers showed.

The lesson is procedural: `str.replace` with an assertion on the count is not
proof an edit landed where it matters, when one logical change spans four sites.
Three separate patches failed this way in this file, each leaving a half-applied
change that measured as a real effect.

### The original (invalid) entry

The pale seam across a flat sheet at a residue boundary was diagnosed as the
cull being interpolated: `vCull` is computed per vertex, so where the shading
normal crossed zero the two coincident sides were each clipped in a slightly
different place and paper showed through. Deciding it from a constant per-face
normal removes the seam by construction, and measures far worse:

| | per-face cull | interpolated (kept) |
|---|--:|--:|
| 1UBQ | 22.7% (10.6) | **15.8% (6.0)** |
| 1BBH | 39.1% (18.2) | **24.0% (8.5)** |

The reference does not decide per piece either - it draws per STATION, and a
piece twisting through edge-on genuinely swaps sides part way along. One normal
for the whole face cannot say that, so the cull goes coarse exactly where the
ribbon turns. The seam is the smaller error. `window.__flatCull = true`
re-measures the per-face version.

Both figures are the best recorded: 1UBQ 16.7% -> **15.8%**, 1BBH 25.8% ->
**24.0%**.

## Smooth stopped being a build-time decision

With the frame coming from `_frameProbe`, the vertex weld was doing nothing -
`welded` and `station` measured identically - so it is deleted, and the
smoothing-angle threshold and surface-class keying go with it. Both existed only
to stop the averaging from rounding off creases it should not have been touching.

What remained of `smooth` was a choice of which normals to emit. The mesh now
carries BOTH - the per-station pair a smooth face interpolates between, and the
single per-face normal a flat one uses - and the shader picks off `uCel`, which
already means "not smooth", so no new uniform was needed.

The flat normal is not simply the first station's: a broad face takes its own
station's frame while a width band takes the PIECE MEAN, which is what the
reference quantises. That difference is why this could not just be moved into
the shader without carrying a second attribute.

Measured: toggling smooth without rebuilding differs from a rebuild by **0%**,
while smooth and flat differ from each other by 11.4% - so it is a real change,
applied for the price of one draw. On 9FOG that is a 1.7 s rebuild replaced by a
sub-millisecond redraw.

## The ID buffer: built, measured, REVERTED

The argument for it was clean. A depth offset cannot tell "in front of my own
face" from "in front of something else", so every setting trades broken lines
against lines leaking through geometry. Comparing face IDENTITY answers exactly
that question, so the outline should need no epsilon at all.

It is implemented - `ID test` on both pages, off by default. Fills render into a
framebuffer with a second, integer attachment holding which surface is visible
at each pixel; the colour is blitted to the canvas; the outline is then drawn
with the depth test DISABLED, keeping a fragment only where the surface showing
through is one of the edge's own two surfaces, or empty paper. Paper has to be
allowed or the line could never lie outside the silhouette it draws.

Measured on 1UBQ, black ink, width 1.6, against the renderer's 9440 ink pixels:

| | ink px | broken |
|---|--:|--:|
| depth, bias cap 0.00025 | 13812 | 19.5% |
| depth, uncapped | 22120 | 0.8% |
| **ID test, zero bias** | 18135 | **9.7%** |

Better than the tight-capped depth path on breakage and worse than the loose one,
at an ink count between the two. It did NOT deliver what it promised: reported
by eye, a per-width bias is still wanted to stop the lines looking jagged, and
overlapping lines are still visible at that point.

Three bugs on the way, all instructive:

- **`gl.clear()` is INVALID_OPERATION** on a framebuffer whose attachments are
  not all the same class, and this one mixes colour with integer. The clear
  failed silently, the ID texture read 0 everywhere, 0 means "empty paper" which
  the test allows, and every edge drew over everything: 206k ink pixels. Clear
  each buffer by type instead.
- **A sampler with no texture bound invalidates the whole DRAW CALL**, not just
  the fetch. With the ID path switched off and nothing bound to the usampler,
  the outline stopped drawing entirely - a feature broken by a change that was
  not supposed to be active. Bind it either way.
- **"No face" must not encode as 0**, because the ID buffer clears to 0 and that
  is what paper looks like. Edges with only one adjacent face matched paper and
  drew everywhere.

Grouping IDs per PIECE rather than per quad - so a line straddling into the next
quad of its own strip is not rejected - moved it 9.9% to 9.7%. That says the
residual is not what I assumed, and I did not find what it is.

Also worth knowing: `brokenPct` cannot referee this. It counts stroke ends, and
a line CORRECTLY clipped by an occluder has ends too - so it scores honest
hidden-line removal and z-fighting stipple the same way. The uncapped depth
path's 0.8% is partly just under-clipping.

**Removed.** It measured between the two depth settings rather than beating
both, and by eye it still wanted a per-width bias and still showed overlapping
lines - so it was carrying an FBO, a second attachment, a blit, an extra
fragment shader and two floats per edge for no gain anyone could see. The three
WebGL bugs above are the part worth keeping; the mechanism is not.

What did work on the jaggedness is the slope- and width-scaled bias, which
stayed. If anyone revisits this, the open question is not the epsilon: it is
that the GPU draws about 25% more ink than the reference at any setting, which
is a rule difference about WHICH edges get drawn.

## The pale face breaking through the dark one, twice over

Two separate causes, both reported by eye and both invisible to the pixel diff.

**1. Flatness was decided per PIECE.** `flatSheet` asked whether every station of
a piece was zero-thickness, and a piece running from a helix (richardson gives it
thickness 0) into a loop (full thickness) is not - so neither of its two
coincident faces was culled at the flat end and they z-fought. Measured on 1UBQ,
5 of 201 ribbon pieces have thickness varying from full to exactly zero along
their length, and every one is a helix meeting its neighbour. A QUAD spans two
stations, so it is coincident when BOTH of its ends are; that is the flag the
shader wants, and it is now computed per quad.

**1b. ...and per QUAD was still too coarse.** A quad that SPANS the transition
is thin at one end and solid at the other, so one flag has to be wrong at one
end: say coincident and half a genuinely two-sided face is culled, say not and
the pair at the thin end z-fights. It said not. Measured on 1UBQ richardson: of
330 broad faces, 64 have both stations thin, 256 have neither, and **10 are
mixed, across exactly the 5 transition pieces named above**. Those 10 kept an
exactly-coincident pair with no cull, at helix ends - a sliver of pale showing
through the dark at the angle where the depth difference falls below one
depth-buffer step, and nowhere else. Coincidence is a fact about a STATION, so
it is carried per station (sheetA/sheetB) and interpolated; the cull now
switches on exactly where the slab closes up. The benchmark improved on all
four configurations, which is what removing a fight looks like rather than
trading one error for another.

**2. The cull was decided per FACE**, which is too coarse - and this is the
helix-to-HELIX case, with no transition anywhere near it. `aFlatN` is constant
over a quad, so a flat ribbon twisting through edge-on keeps whichever side its
first station faced for the whole quad, while the piece next to it keeps the
other. Counting pairs of flat quads that share a station and disagree about
which side to draw: **95 of 710, 13.4%** - every one a seam where pale meets
dark mid-ribbon.

**2b. ...and it must not read the SHADING normal.** With Smooth off the shader
takes the flat per-face normal, and reading the cull through it makes the test
constant across the quad again - a per-face cull by the back door, and the
reason the bleed came back in plain cartoon (the default) long after both fixes
above. The cull reads the per-station normal unconditionally now; only the
shading follows uCel.

The interpolated test has neither problem, and the reason it partitions exactly
is worth stating, because it is why the "seam" once blamed on it was really
something else: BOTH coincident faces carry the same aNormal - the +b direction
- with aTop saying which side each is. They therefore compute the SAME oB, cross
zero at the same point, and one picks up precisely where the other leaves off.
Across a piece boundary the frame is the renderer's own, so oB is continuous
there too.

Both culls measure identically (1UBQ 15.8%, 1BBH 24.0 against 24.1). The pixel
diff cannot see a seam: swapping which of two nearly-equal tones covers a patch
barely moves a pixel count. Only the eye and a targeted probe found it.


## The tube path at capsid scale: 149 ms to 26 ms

Measured on an M2 (ANGLE Metal), 598 px canvas, steady state during a drag,
per-pass GPU time from `EXT_disjoint_timer_query_webgl2`. 3J3Q is the HIV
capsid, 311,880 drawn segments; 4UG0 is the ribosome, 17,448.

| pass | 3J3Q before | 3J3Q after | 4UG0 before | 4UG0 after |
| --- | --- | --- | --- | --- |
| depth prepass | 15.6 | 11.7 | 1.39 | 1.35 |
| occlusion | 5.5 | 1.0 | 0.64 | 0.58 |
| resolve | 0.4 | 0.2 | 0.20 | 0.28 |
| outline | 63.5 | — | 5.12 | — |
| fill / draw | 64.0 | 12.6 | 6.25 | 1.27 |
| copy to canvas | — | 0.4 | — | 0.17 |
| **total** | **149** | **25.9** | **13.6** | **3.65** |

**MEASURE THE GPU, NOT THE SUBMIT.** `performance.now()` around `render()`
reported 0.28 ms for the 13.6 ms frame above, and 0.06 ms for the 149 ms one -
a draw call returns when it is queued. Every number here comes from a
`TIME_ELAPSED_EXT` query. `window.__gpuTimers = true` turns them on and
`window.__gpuTimes` collects them, per pass, in milliseconds. Only one query
may be active at a time, so the passes are timed in sequence and there is no
`total` query - it is the sum. The results land a few frames after the pass.

Three changes, and the order matters: each one only pays because of the one
before it.

**1. One pass instead of two.** The outline pass drew every instance at a grown
radius and discarded each fragment inside the tube; the fill pass then drew
them all again. The two regions are disjoint (`dist > vRfill` is the skirt), so
a fragment can decide for itself, and the depth each writes carries the
ordering that two passes used to. 3J3Q: 127.5 ms becomes 57.8 ms.

**2. Early-Z, bought with a conservative depth.** Writing `gl_FragDepth`
switches off early depth rejection everywhere, so at a capsid's depth
complexity every layer of every capsule shaded in full. The quad now carries
the capsule's nearest possible depth - the nearer end's axis plus a radius -
and the fragment depth is declared `depth_greater` under
`EXT_conservative_depth`, which lets the hardware reject against the polygon
first. Where the extension is missing the shader is the ordinary one and the
quad depth is simply true and unused. 3J3Q draw: 57.8 -> 30.8 ms, and **not one
pixel changes**, which is the check that the bound really is conservative.

**3. The draw reuses the prepass's depth buffer.** A renderbuffer can be
attached to two framebuffers. The prepass already leaves a complete depth
buffer behind, so the draw renders into a colour target sharing that attachment
and tests LEQUAL against it - and now rejects *every* hidden capsule, not only
the ones drawn after their occluder. 3J3Q draw: 30.8 -> 12.6 ms.

### Three things step 3 cost, each found by looking at the picture

- **Depth writes have to stay ON.** A skirt sits in front of the surface the
  prepass recorded there and must leave that depth behind, or the fill it is
  supposed to outline passes LEQUAL straight over the top of it. With
  `depthMask(false)` the frame came back with most of its outlines missing.
  Writing costs nothing: the rejection comes from testing against an
  already-complete buffer, and a passing fragment writes what was there.
- **`vPx` comes from `gl_FragCoord`, not from a varying.** As a varying it was
  a function of the quad's corners, so the prepass and the draw - whose quads
  differ by the outline width - disagreed in the last bit. That is not a
  rounding curiosity: the bulge is `sqrt(r^2 - dist^2)`, whose slope is
  unbounded at the silhouette, so a last-bit difference in position becomes a
  large difference in depth exactly at a tube's edge. Absorbing it with a
  tolerance cost every outline in the picture and left white speckle.
  `gl_FragCoord` is the pixel centre whatever quad carried the fragment there,
  so the two agree by construction - and the prepass can then go back to the
  tube's own quad, a quarter of the fragments at a capsid's outline-to-tube
  ratio.
- **The copy is a textured triangle, not `blitFramebuffer`.** The context asks
  for `antialias: true`, so the default framebuffer is multisampled, and
  blitting a single-sample buffer into one is an `INVALID_OPERATION`. It
  presents as a blank white frame.

### Measured and rejected: sampling the depth buffer instead of an R32F copy

The prepass writes the view depth twice - once as depth, once as an R32F colour
for the occlusion to read - and dropping the colour attachment takes a quarter
off it (4UG0 1.71 -> 1.29 ms, measured by masking colour writes). Doing it
properly, with a `DEPTH_COMPONENT24` texture sampled by the occlusion and
reconstructed through `zRange`, made **everything else slower**: blur 0.36 ->
1.20, occlusion 0.59 -> 1.05, draw 1.18 -> 1.82, copy 0.19 -> 1.24, for a net
4.09 -> 6.47 ms. Apple's GPU compresses depth, and sampling a depth texture
that is simultaneously a depth attachment forces it to decompress. The
redundant R32F copy is the cheaper arrangement. Reverted.

### Still on the table

- The draw's quad is grown by the outline width, which is a fixed number of
  pixels, so at capsid zoom - where a tube is about a pixel across - the quad
  is many times the tube's own area. Measured at ribosome scale the outline is
  23% of the draw (1.24 vs 0.95 ms with `relativeOutlineWidth` 0); at capsid
  scale it will be a larger share. Thinning or dropping the outline below some
  drawn radius is the biggest remaining win and is a change to how the drawing
  LOOKS, so it is a decision rather than an optimisation.
- Prepass and draw are each a full rasterisation of every capsule and are now
  94% of the frame. Below that lies LOD - fewer, fatter segments when a tube is
  sub-pixel - which is a bigger change than anything above.

### The occlusion's density was measured, and the measurement was the error

Reported as: on Q5VSL9 "the depth isn't really taking hold for shadow because
the long loop is taking over". It was, and the mechanism is that `tubeDensity`
was `count / (pi * rad^2)` with `rad` the distance to the FARTHEST atom. That
is an EXTREME, so one extended loop sets it for the whole structure, and the
density - which goes as 1/r^2 - collapses for the bulk that is nowhere near it.
Q5VSL9's farthest CA is 77.9 A out; its RMS radius is 35.7.

Swapping the extreme for the RMS radius (the standard deviation of the
positions about their centre) fixes the shape dependence. Sweeping
`tubeAOGain` against the 2D pass and reading off the gain that matches it:

| | max radius | RMS radius |
| --- | --- | --- |
| spread of required gain | 0.66 - 4.65 (**7.1x**) | 0.55 - 0.92 (**1.7x**) |

But the shader only ever sees the PRODUCT `density * gain`, and asking what that
product has to be says to go further - it is essentially a constant:

| structure | segments | required product |
| --- | --- | --- |
| 1UBQ | 75 | 0.173 |
| 3CHY | 127 | 0.160 |
| 1TIM | 492 | 0.181 |
| Q5VSL9 | 836 | 0.187 |
| 4UG0 | 17,448 | 0.127 |
| 3J3Q | 311,880 | 0.162 |

1.5x across four orders of magnitude in size, against 4.3x for the RMS density
and 5.3x for the measured one. **The measurement was contributing the variance
rather than removing it.** The occlusion estimate already responds to crowding
on its own - a tap in a crowded structure hits something nearer - so scaling it
by crowding a second time overshot. `TUBE_AO_DENSITY = 0.164`, `AO_GAIN = 1.0`,
and `tubeAOGain` remains the knob.

Mean luminance over structure pixels, GPU against the 2D pass:

| structure | 2D | was (shipped gain 2.0) | now |
| --- | --- | --- | --- |
| 1UBQ | 169.5 | 177.3 (+7.9) | 170.4 (+0.9) |
| 3CHY | 173.2 | 171.9 (-1.2) | 173.6 (+0.4) |
| 1TIM | 175.7 | 174.6 (-1.1) | 177.9 (+2.2) |
| Q5VSL9 | 158.4 | 166.8 (+8.3) | 160.7 (+2.3) |
| 4UG0 | 167.7 | 146.4 (**-21.2**) | 164.8 (-2.8) |

Worst error 2.8 of 255. The ribosome is the surprise: it was over-shadowed by
21 levels and nobody had noticed, because the only structures anyone checked
were the compact ones the gain happened to suit.

The old rationale for measuring - "what makes a sparse structure and a dense one
shade alike" - was reasonable and wrong, and it survived because it was never
checked against more than one size of structure. Sweep at least one tiny, one
compact, one extended and one enormous before believing any calibration here.

### Measured and rejected: the same estimator on the 2D side

The two renderers share the kernel - `c^2 / (c^2 + d^2 * 2)`, the same cutoffs
off the same reference bond length - but sum it over different things. The 2D
pass sums over every PAIR of segments; the GPU sums over samples of a depth
field scaled by an areal density. So their levels agree by calibration rather
than by construction, and the obvious tidy-up is to give the 2D pass the GPU's
estimator, still evaluated once per segment so the flat-per-capsule style and
SVG export are unaffected.

Built, and it worked: agreement with the GPU went from within 2.8 levels to
within 1.9, with the spread across structures down to 0.6. **Dropped anyway**,
for two reasons found only by measuring.

**It is not faster.** Median 2D frame, pairwise against field: 1UBQ 0.9 -> 1.2
ms, 3CHY 1.8 -> 1.7, 1TIM 3.5 -> 2.7, Q5VSL9 10.0 -> 4.4, 4UG0 66.0 -> 56.4. A
tiny structure LOSES - building the field costs more than 75 segments' worth of
pairs - and the ribosome's 56 ms is stroking capsules, not occlusion. The
"occlusion is ~90% of a 2D frame" figure in PERF_NOTES.md does not hold at
these sizes.

**It flickers under rotation.** Mean frame-to-frame luminance change over ten
0.3-degree steps on 1TIM: pairwise 2.41, GPU 2.44, field **3.04** - and a
number that size understates it, because the answer is one flat tone per
capsule, so every jump is a whole capsule changing shade at once.

The flicker is NOT tap quantisation. Replacing nearest-cell sampling with
bilinear interpolation plus coverage weighting - which makes both the sampled
depth and the empty-to-occupied transition continuous as a tap moves - measured
3.047 against 3.044. No change whatsoever. What moves between frames is the
FIELD ITSELF: which cells a segment splats into changes as the structure turns,
and at a cell size the tube can barely resolve, that reshuffles what every tap
sees. Fixing it properly means a field fine enough that splatting is stable,
which is the per-pixel field the GPU already has and the 2D path cannot afford.

Temporal history would hide it, and was considered: blend each segment's shadow
with the previous frame's. It buys nothing here - the change is not a speedup,
so smoothing it only preserves a like-for-like result at the cost of lag during
exactly the motion that shows the problem, plus invalidation on every colour,
visibility and structure change, plus a rendering that depends on what was
drawn before it, which an export must not.

The levels already agree to within 2.8 through the calibrated
`TUBE_AO_DENSITY`, so what this would have bought is agreement by construction
instead of by tuning - a maintenance property, not a visible one, and not worth
a flicker.

### The outline: mostly antialiasing, and one free half-radius

Reported as the GPU outline still differing from the 2D pass - "some parts
missing, some lines added that aren't needed". Both are true and they have
different causes, and only one of them is worth paying for.

**Most of it is antialiasing, not geometry.** 1TIM at zoom 2.2, ink measured as
how much darker a pixel is than the median of its neighbourhood:

| | total ink mass | px at depth>10 | >22 | >40 |
| --- | --- | --- | --- | --- |
| 2D | 677,715 | 20,419 | 14,558 | 5,485 |
| GPU | 641,992 | 13,839 | 12,346 | 9,819 |

The same amount of ink to within 5%, spread differently: the canvas feathers
its strokes, so its rim is wide and soft, while the GPU's rim boundary is a
`discard` threshold and comes out narrow and hard. Counting "ink pixels" makes
that look like 5,500 missing pixels; it is a fringe, and it is why the GPU's
lines read as broken where the 2D's read as drawn.

MSAA is not the missing ingredient, which is worth recording because it looks
like the obvious answer: routing the draw back to the multisampled default
framebuffer instead of the single-sample gFbo changed nothing (missing 5,561
against 5,507). Multisampling cannot smooth an edge defined by `discard` -
coverage is decided per fragment, not per sample. Fixing it properly means
supersampling (4x the fragment cost) or alpha-to-coverage with an MSAA depth
target, which the prepass shares and would therefore pay for too. That is a
real cost for a fringe, so it is not being paid.

**The part that was free: the skirt sat a whole radius toward the eye.** That
was chosen so a rim could never lose to its own fill, and it is too near - the
rim punches through tubes in front of it, and along a boundary shared with a
neighbour the contest with that neighbour's bulge alternates pixel by pixel,
which is the rim "chopped into dashes" from FSTUBE and shows as ink the 2D pass
does not draw.

Swept against the 2D pass on the difference in BLURRED ink maps - blurring
makes the metric blind to the antialiasing fringe above, without which the
measurement just re-finds the fringe:

| | 0 | 0.25 | **0.5** | 0.75 | 1.0 |
| --- | --- | --- | --- | --- | --- |
| 1TIM zoom 2.2 | 1.0592 | 1.0397 | **1.0255** | 1.0310 | 1.0499 |
| 1TIM zoom 9 | 0.3300 | 0.3169 | **0.3005** | 0.3048 | 0.3293 |
| 3CHY | 0.6089 | 0.5949 | **0.5817** | 0.5935 | 0.6247 |
| 1UBQ | 0.4747 | 0.4505 | **0.4381** | 0.4460 | 0.4638 |
| 4UG0 | 2.1126 | 2.0926 | 2.0756 | **2.0639** | 2.0652 |

...and then reported as still showing crosses at the joints, which sent this
back for a second look. The blurred metric is nearly blind to a thin interior
line, and that is what a cross is.

**Why a joint crosses.** Two segments that meet SHARE a position, so their axes
coincide there. A skirt sitting `uSkirtZ` radii toward the eye beats its
neighbour's fill wherever that neighbour's bulge is under `uSkirtZ * r` - a
band just inside the neighbour's silhouette, printing as a dash across the
joint, and two of them meeting is the cross. The band closes as `uSkirtZ` goes
to zero. Counting interior ink the 2D pass does not draw against rim ink it
does, 1TIM at zoom 4:

| uSkirtZ | crosses | missing rim |
| --- | --- | --- |
| 0 | 209 | 3139 |
| **0.25** | **210** | 2880 |
| 0.5 | 270 | 2613 |
| 1.0 | 511 | 2419 |

`SKIRT_Z = 0.25`: at the cross floor - indistinguishable from 0 - while keeping
some of the rim that 0 gives up, so it dominates both ends. The blurred metric
prefers 0.5 by 1-5% and is overruled, because it is dominated by the
antialiasing fringe, which is not fixable at this price, while the crosses are
what someone actually notices. One multiply, no extra pass; 4UG0 frame time
unchanged.

### Reading the two outline implementations against each other

What the code says, after the pixels had been looked at. The 2D rim is
`viewer-mol.js`'s two-step draw - a butt-capped stroke of
`lineWidth + outlineWidth` under a round-capped stroke of `lineWidth` - and the
GPU's is the skirt, `vRfill < dist <= vRfill + uGrowPx`, butt-cut where the
chain continues.

**These agree and were checked:** the outer radius (`(lw + outW) / 2` against
`vRfill + uGrowPx`), the colour (fill x 0.7 both, after occlusion), the
perspective term (`fl/z` against `uFL/(uFL - z)`, the same quantity), the
width's dependence on zoom (both are Angstrom x view scale), where the butt cut
falls, and that the fill keeps round caps in both.

**Four places they differ:**

1. **The relevance filter on the cap rule.** `shouldRoundEndpoint` counts only
   segments of the SAME TYPE and SAME CHAIN (or, for a ligand, only other
   ligands); `buildTube`'s `touch` counts every drawn non-contact segment at a
   position. So where a chain terminus shares its position with a segment of
   another type, the 2D rounds the cap and the GPU does not. Real, and small -
   it reaches termini and cross-type junctions only. Fixing it needs a count
   per position PER CLASS, and the per-position counter it would replace is
   already the thing that measured 5.4 ms against 0.3 on 4UG0 when it was a
   Map, so it is not obviously free. Left alone.

2. **"Lowest render order rounds".** When several relevant segments meet,
   `shouldRoundEndpoint` still returns true for whichever is drawn FIRST, so
   the 2D lays a filled outline circle at every interior joint and the
   neighbours' fills cover all but the outside of the elbow. That is the rim on
   the outside of every bend, and it is most of the red in the overlays. The
   GPU has no render order to appeal to - it has a depth buffer - and porting
   it by keeping the round skirt at joints measures WORSE at every skirt depth:
   1.37 at 0.5, 1.19 at 0.25, 1.08 even at 0, against 1.03 for the butt cut.
   The skirt prints an arc across the joint instead of being covered, which is
   the "string of sausages" the butt cut was introduced for. A faithful port
   would need the cap flag to depend on the view, which means rebuilding the
   instance buffer every frame. Not portable at this price.

3. **outlineMode 'partial' was treated as 'full'** - FIXED. The 2D adds the
   round endpoint circle only when the mode is `full`; the GPU tested
   `!== 'none'` and kept its round skirt at free ends either way, so partial
   drew rounded outline caps at every chain terminus that the 2D does not.
   `uEndCaps` cuts every end square in partial. Full mode is bit-identical
   after the change (1.0255226 either side).

4. **Zero-length segments.** The 2D rounds them unconditionally; the GPU
   derives the flag from `touch` like any other segment. Not chased.

**How big is (2)?** Both rules were computed side by side in the page - the 2D's
own `segmentEndpointFlags` as it left them, against `touch` recomputed exactly
as `buildTube` does it - and counted:

| | segment ends | capped by both | 2D only | GPU only |
| --- | --- | --- | --- | --- |
| 1TIM | 984 | 4 | **490** | 0 |
| 4UG0 | 34,896 | 192 | **17,353** | 0 |

One end per joint, which is the whole of rule 2, and the GPU never caps where
the 2D does not. The ends capped by BOTH are the genuinely free ones - 1TIM has
exactly four, its two chain termini.

**The genuinely free caps are fine.** Ink mass within a 14 px disc of each of
1TIM's four free ends, GPU against 2D: 3,689/5,076, 3,459/3,698, 4,142/4,150,
3,452/3,600 - 89% overall, and three of the four inside 7%. The shortfall is
the antialiasing fringe again, not a missing rim.

**Rule 2 retested with the right metrics, after the blurred one was caught out
by the crosses.** Rounding at joints and letting depth cover it:

| | crosses | missing rim |
| --- | --- | --- |
| butt cut, uSkirtZ 0.25 (shipped) | **210** | 2,880 |
| round at joints, uSkirtZ 0 | 1,328 | 1,322 |
| round at joints, uSkirtZ 0.1 | 1,494 | 1,186 |
| round at joints, uSkirtZ 0.25 | 2,137 | 902 |

It does recover more than half the missing rim, and it costs six times the
interior marks to do it - the sausage arcs, which are the artefact anyone
notices. The earlier verdict stands; only now it stands on a metric that can
see the thing being traded away.

### Joint caps, ported after all

Rule 2 above - the 2D pass rounding the outline cap at every interior joint -
was twice written off as unportable. It is portable; both earlier attempts were
just the naive version of it.

**One owner per joint.** Letting both segments round is what fights and prints
an arc across the joint. Only one may carry the disc - and which one does not
matter, which is the part that makes this work here. The two share the
position, so they would draw the SAME disc: same centre, same radius, same
depth. The 2D pass has to pick the back-most only because it paints in order.
So the owner is the first segment to reach the position in `buildTube` -
deterministic, independent of the view, and therefore nothing to rebuild when
the model turns. `claim[]` beside `touch[]`, one extra Int32Array, at rebuild
time only.

**A joint cap gets its own depth.** At the joint's axis it still surfaces as a
complete RING through tubes it belongs behind - the disc reaches a radius past
the tube on every side, and wherever nothing covers that annulus it draws.
Sinking it two radii puts it behind anything near enough to matter, so it
survives only where the 2D pass's disc survives: outside the elbow, against the
background.

Extra ink against rim the 2D draws and the GPU does not, 1TIM at zoom 2.2 and
1UBQ at 2.0:

| | caps off | capZ -2 | capZ -1.4 | capZ -1 |
| --- | --- | --- | --- | --- |
| 1TIM | 206 / 4089 | **219 / 1401** | 326 / 1323 | 407 / 1294 |
| 1UBQ | 82 / 1819 | **93 / 806** | 124 / 754 | 176 / 754 |

Two thirds of the missing rim, for thirteen pixels of ink. `CAP_Z = -2.0`;
`cartoonCapZ` overrides it and `cartoonJointCaps = false` turns it off.

**It is free.** 4UG0's draw pass over 31 timed frames: 51.7 and 50.4 ms with
the caps against 54.8 and 54.5 without - inside the run-to-run spread, and if
anything faster, since a cap fragment fails early-Z at once.

**A trap worth recording.** The first version declared `capKind` inside the
skirt's discard block and read it in the depth block, which is a different GLSL
scope. The shader failed to link, the GPU declined the frame, and the 2D pass
drew it - WITHOUT shading, because `_gpuWillTake` had already told it to skip
the occlusion. So it presented as a perfect outline with the shading missing,
which is a very convincing way to be shown your own reference render and told
it is the new one. Check `__gpuLastError` before believing a GPU result that
looks too good, and treat "the outline got better AND something unrelated
broke" as the signature of a silent fallback.

## Cartoon: the draw is geometry-bound, and six vertices per quad were four

The cartoon path's steady-state frame cost 12.1 ms of GPU on 4UG0 - surfaces
8.27, ink 3.87 - against the tube's 4.1 ms on the same structure. The CPU
submit reads 1 ms, so none of this is visible without a timer query.

**It is geometry-bound, not fragment-bound**, and that is what decided the fix.
Shrinking the drawing to a 144th of its screen area moves the surface pass from
11.07 ms (zoom 3) to 8.15 (zoom 0.25) - so the floor is not the fragments, it
is 167,817 instances x 6 vertices = a million vertex invocations. The tube's
depth-prepass trick would have made this WORSE: it would add a second geometry
pass to a pass that is already geometry-limited.

Every instanced quad here is two triangles over four corners, and each pass
synthesised its six vertices from `gl_VertexID` through `ids[6] = {0,1,2,0,2,3}`.
That runs the vertex shader SIX times per quad: two of the six carry distinct
`gl_VertexID` values for the same corner, and nothing can tell the GPU they are
the same point. Drawn through a six-byte index buffer, `gl_VertexID` is the
index VALUE, the two repeats are the same vertex, and the post-transform cache
serves them.

| 4UG0, GPU ms | before | after |
| --- | --- | --- |
| cartoon surfaces | 8.27 | **2.60** |
| cartoon ink | 3.87 | **1.98** |
| **cartoon total** | **12.14** | **4.58** |

2.7x, against the 1.5x that six-invocations-to-four predicts - the cache is
evidently saving more than the arithmetic. 1TIM's whole frame is now 0.51 ms.
The same buffer is used by the tube, where it changes nothing measurable
because that pass is fragment-bound.

**Pixel check, and why it had to be done on the tube.** The tube is
bit-identical across the change: 0 of 357,604 pixels differ. The cartoon cannot
be checked this way at all - two page loads of IDENTICAL code differ in 162,575
pixels with a maximum of 40, and the before/after pair differs in 162,718 with
a maximum of 39. Cross-load comparison measures the cartoon's own
non-determinism and nothing else. The tube exercises the same index buffer and
the same corner mapping, so it is the honest place to prove the mechanism.

### What the rebuild costs, and what did NOT help

A cartoon rebuild is ~770 ms on 4UG0 and runs on load, on any geometry slider
(width, thickness, sheet flat, detail - all in `signatureOf`), on a visibility
change and on a canvas resize. Colour is NOT in the signature; it goes through
the palette texture without a rebuild.

| stage | ms | |
| --- | --- | --- |
| capture | 174 | 23% |
| edges | ~320 | 43% |
| normals | 75 | |
| rails, facesAndEmit, pieceFrames, buffers | ~105 | |

Turning the outline off takes the whole rebuild to ~390 ms, which both confirms
the edge stage is half of it and is a usable workaround on huge structures.

**Two micro-optimisations of the edge stage measured as nothing and were
reverted**: replacing its Map-of-Maps and per-edge object with an open-addressed
typed-array table, and removing the `new Set()` allocated per face (167,000 of
them). Over 14 rebuilds, warm samples only, minimum / median: HEAD 676 / 772 ms,
both changes 685 / 752 ms. The minima are identical and the medians sit well
inside a +-15% spread. This is the class of change PERF_NOTES already warns
gives nothing in Chrome, and the warning was right again. Measure the minimum
of many warm samples here; a single rebuild is worthless as a signal.

### Cartoon at capsid scale: it cannot fit, and now it says so

Reported as a crash when loading 3J3Q in cartoon mode with the GPU on. It is
not a leak or a GPU fault - it is arithmetic.

A cartoon build materialises prims, one object per FACE and an edge table all
at once. Measured, that is **20,261 bytes per position**: a 4UG0 build takes the
heap from 118 MB to 457 MB for 17,544 positions. 3J3Q is 313,236 positions, so
it asks for **6.0 GB** on top of the ~1.9 GB the loaded structure already
occupies, against a 4,192 MB heap limit.

Heap at each step, capsid, before the guard:

| | MB |
| --- | --- |
| fetched | 239 |
| loaded | 1,872 |
| tube drawn | 1,983 |
| cartoon | tab dies |

It does not degrade, it dies, and a structure that took sixteen seconds to load
dies with it. So `setStyle('cartoon')` now asks `_cartoonWouldFit()` first and
refuses the switch rather than the tab: 20 kB x positions against
`jsHeapSizeLimit - usedJSHeapSize`, with a 0.8 margin because the build's peak
is above its residue. `performance.memory` is Chrome-only; without it the test
falls back to a flat 120,000-position cap. `renderer.cartoonForce = true`
bypasses it.

Capsid now reports `{ok: false, positions: 313236, needMB: 6052, freeMB: 2198}`
and stays in tube; 4UG0 reports `{ok: true, needMB: 339, freeMB: 3758}` and
switches as before, its measured build cost 314 MB against the 339 estimate.

**This is a ceiling, not a fix.** Making the cartoon reach capsid scale means
not holding the three intermediates at once - prims, the per-face objects and
the edge table - which is the streaming rebuild that the edge-stage profile
also points at. Until then the honest number is ~120k positions in a 4 GB heap,
less if the structure itself is large.
