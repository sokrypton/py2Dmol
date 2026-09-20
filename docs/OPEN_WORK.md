# Open work, and what has already been ruled out

Written 2026-09-16. Each entry is something a session STOPPED on rather than
finished: what it is, what was measured, what was ruled out and would be wasted
effort to re-measure, and what the next step would be. The point is that the
next attempt starts where the last one ended.

Nothing here is a bug report against a fix that shipped; where a fix did ship
the entry says so and records what it cost.

---

## 1. Loops trade light and dark under small motion, and it is NOT the fast path

**Reported** from protein_fighter: "minor movements are causing the sides of the
loop to flicker, as far as which side is lighter and which is darker", more
pronounced in the `3d` preset. Still unexplained.

**Ruled out - do not re-measure these:**

| ruled out | how |
|---|---|
| the station fast path | on the game's own recorded frames, replayed one by one, the station path draws what a full rebuild draws: **0 px different** in `3d`, 1-4 px in `richardson`, over 120 frames, at one draw per frame |
| a cached/stale mesh | the same frames rebuilt every frame flicker identically - `?station=0` in the game, and `setStationDraw(false)` in a replay |
| the ribbon frame's SIGN | `geom.js`'s loop pass flips a whole element when `dp` crosses zero, which happens constantly on a moving structure - but drawing everything with every side vector negated moves **202 px** in `3d` and 86 in `richardson` against 0 for the same frame rebuilt twice, and those pixels are specks on helix silhouettes. Fixed anyway (`d856487`, the shorter-diagonal cut): a negation now moves **0 px** |
| the diagonal cut being the cause | after that fix, replaying the same 160 game frames gives 189,361 flickering pixels against 189,518 before - the same picture |

**What is actually measured:** on replayed game frames, pixels that differ from
BOTH neighbouring frames while those two agree - the oscillation test - run at a
median of ~450 a step and up to ~3,000 mid-fight, on both paths equally.

**Not yet done, and the next step:** nobody has identified what those pixels
ARE. The way to do it is to take the worst step, crop the oscillating region and
LOOK at the three frames, rather than reasoning about mechanisms. Two candidates
are already known to exist and neither has been confirmed as the reported
effect:

  * residues flickering between loop and helix/strand as a fighter unfolds -
    the assignment drifts frame to frame and the renderer draws it faithfully
    (`docs/FRAME_STABILITY.md` is the standing account of that);
  * a loop having no intrinsic face: the twist a loop takes is a choice between
    two nearly equal options, and small motion can switch it.

**Two fixes were sketched and neither was tried:** give loops a square section
in the looks where they are flat, so a flip has nothing to show (a loop whose
thickness equals its width has no observable face - `richardson` is nearly
there already); or remember the previous frame's choice and only change it when
the new one is clearly better, which puts frame-to-frame state in the renderer -
see `docs/FRAME_STABILITY.md` on why that promise is hard to keep honest.

**How to reproduce the measurement.** Drive the real page, record what it hands
to `replaceFrame` for ~160 frames mid-fight, then replay those frames twice -
once on the station path, once with `invalidate()` before each - reading the
canvas each time. The comparison must be between the SAME frames; a fresh fight
is a different motion and proves nothing.

---

## 2. `tests/station_integrated.py` fails, and is in no lane

It is not named in `tests/run.sh`, so no green run has ever covered it. Its
counts are healthy (the path is taken 22 of 33 steps with 0 rebuilds); what it
reports is that

  * the station path measures SLOWER than a plain rebuild on small
    trajectories - 13.60 ms against 6.90 on `_traj_1tim.pdb`; and
  * `_traj_unfold.pdb` draws **0.124% of its pixels** differently from the same
    frame rebuilt, which `docs/FRAME_STABILITY.md` already names as shipping
    unchecked.

Either fix it and put it in the gpu lane, or decide the two claims are not
claims any more and say so in the file. Leaving a failing probe outside the
suite is the state this repository has burned a session on before.

---

## 3. Most of the suite tests the OLD draw path

The GPU painter presents on its own canvas layered under the viewer's by
default (`cartoon/paintgl.js`, direct presentation). `tests/probe_js.py`'s
shared HELPERS call `setDirectPresent(false)`, so every probe that carries them
reads the drawing the old way - the blit - and the shipped default is exercised
only by `tests/gpu_direct.py` and the five probes that compose the two canvases
(`colab`, `embed`, `export_html`, `python_opacity`, `render_page`).

That gap is how the layer came to be placed once and never re-placed: a page
that moved the canvas without a redraw left the picture behind (70 px on the
website), and no probe moved a layout. `gpu_direct.py` now has a leg that
inserts a block above the canvas and requires the layer to follow - but the
coverage question is wider than that one leg. Worth either giving the helpers a
composing reader (so probes measure what a reader sees whichever path draws) or
running a second pass of the ui lane with the default on.

---

## 4. The ui lane starves itself

Eight probes in one run failed with `page error: no result posted` and every one
passed when run alone. `JOBS` is already down from 6 to 2 because the GL layer
under every canvas made six unrunnable. The failures move around between runs,
which is the tell.

Until it is fixed, a failing ui probe means "run it alone before believing it".
`JOBS=1 zsh tests/run.sh` is the unambiguous run and is slower.

---

## 5. The 2D painter is still sign-dependent

`d856487` made the GPU cut every ribbon quad along its shorter diagonal, so the
picture no longer depends on which way a ribbon frame points: negating every
side vector moves 0 px. The 2D painter still moves **10 px** (`3d`) and **29 px**
(`richardson`) under the same negation. It draws prims rather than a mesh, so
the fix does not carry over. Cosmetic, on specks; recorded so the next person
measuring sign-dependence knows which painter it lives in.

---

## 6. The round tube still draws a colour half a residue late

The RIBBON was fixed in `49ff0a6`: every interval is cut at a midpoint it
already had (the depth sort quarters them), each piece takes its own residue's
colour, and the palette slot names the half unconditionally - so the geometry
no longer depends on the colours and a mode change stays a texture upload.
`tests/colour_centre.py` is the gate. It cost nothing: identical face counts on
every structure measured, timings inside the harness floor.

WHAT IS LEFT IS THE ROUND TUBE, in two places - `flushTubeRun` in
`cartoon/geom.js`, which is what the default cartoon draws its loops with, and
the tube STYLE in `core/mol.js`. There a run of consecutive intervals sharing a
colour is merged into ONE polyline prim, so a colour boundary can only fall on
an interval end. Centring means re-keying the runs on RESIDUES with knots at
the midpoints: a run would start at the midpoint before its first residue and
end at the midpoint after its last.

Not obviously more expensive - in a per-residue mode every run is one residue
long either way, so what changes is where the run's ends are, not how many
there are - but it is a change to the run merging rather than to a couple of
expressions, and the tube style is a second, separate copy of the same idea.

## 6b. The first Style drag on a still structure still costs one build

The station fast path is armed automatically only for a TRAJECTORY
(`frames.length > 1` in cartoon/paintgl.js); a still structure gets a table
only when something calls `wantStationTable()`, which the Thickness, Flat and
Width sliders do. So the FIRST move of the first such slider pays a full
rebuild - the mesh was built with the path off, so it left neither a table nor
a topological key - and every move after it is free. Reported twice.

**ARMING EVERY STRUCTURE IS THE FIX, AND IT IS FREE OR BETTER.** Dropping the
gate to `>= 1` removes that build entirely: 34 of 38 panel controls then
rebuild nothing at all, Width included. And it makes builds CHEAPER, because
where the path is armed the ribbon's 48-float instance rows are not built at
all - the table carries the same geometry in 18. Counterbalanced, minimum of
eleven, on the GPU:

    1UBQ  2.1 -> 1.8 ms      4HHB  19.4 -> 17.4 ms
    1TIM 12.6 -> 11.1 ms     1AOI  39.6 -> 34.8 ms

**IT IS BLOCKED BY THE SIDE-CHAIN ARTEFACT IN `docs/FASTPATH_ARTIFACTS.md`,
and that was measured rather than feared.** Armed everywhere,
`tests/gpu_recolour.py` fails with *"after showing side chains, a repaint
differs from what a rebuild draws"* and `tests/gpu_mesh_reuse.py` fails on
three side-chain toggles with *"the picture differs from a fresh build"*.
Those are the open defect, reached by the ordinary interactive case instead of
by a trajectory. Checked against the other suspect: the failures are the
ARMING, not the restoreMesh refusal added in `fa2463b` - taking that refusal
back out leaves both probes failing in exactly the same way.

So the order is: fix the side-chain half of the station path first, then drop
the gate. Two probe harnesses also need `_autoStationTable = false` when it
happens, and they are worth writing down because both look like renderer bugs
from the outside:

  * `tests/station_corners.py` compares the station table against `__fill`,
    the instance rows - which an armed build does not produce, so it reads
    "1202 faces built against 0 instance rows".
  * `tests/topology_survey.py` forces `invalidate()` at every value, so the
    path never goes fast; twelve of those and the GIVE-UP counter switches the
    path off for the object and clears the table. `_autoStationTable = false`
    does not stop that today - the give-up tests `stationAuto` alone and would
    have to test the flag too.

---

## 7. Focus mode and nucleotides

Suggested and never confirmed: in focus mode, hide base plates by default and
show the SIDE CHAINS of nucleotides that interact. Nothing was implemented; the
mode's entry/exit snapshot rules in `CLAUDE.md` are what any attempt has to
respect.

---

## 8. Detail 2 arrowheads: shipped, and it no longer costs the barbs

Not open - recorded so the trade is not re-litigated. At the geometric floor an
interval has three stations and an arrowhead wanted five of its own, so a
residue joining the end of a strand moved the topology and every such animation
frame rebuilt (**60 of 79** replayed fight steps at Detail 2, against 0 at
Detail 3). The head now spends a station the interval already has: **0 of 79**.
It first did that by MOVING the seam onto a station, which left no duplicate
to stand the barbs up and drew a spearpoint; it now DUPLICATES the station at
u = 0, the rim's own trick, and keeps its square back edge at the same count.
`tests/ss_axis.py --detail=2` is the topology gate and `tests/ss_arrow_shape.py`
the shape gate; both run in `tests/run.sh`.

---

## 9. protein_fighter vendors py2Dmol by hand

`../protein_fighter/vendor/py2Dmol.embed.min.js` is a copy of this repo's embed
bundle, updated by hand when the game needs a fix. Anything that changes the
embed bundle's behaviour should ask whether that copy needs refreshing: a
py2Dmol deploy does not touch it, and the game can sit on a bundle that is
older - or newer - than what the site serves. It was last refreshed at
`3e670c2` and this repo has moved on since, so check before assuming the two
agree.

---

## 10. A session loaded over another one keeps some of the first one's camera

Found while writing `tests/arrow_faces_2d.py`, and not chased. Four saved views
loaded one after another into ONE page, through `loadViewerState`, drew the
third one with **12,477** inked pixels; the same state loaded into a fresh page
drew **32,242**. The loader clears first, so something camera-shaped - the zoom,
the extent, or the framed-objects set - survives that clear. The test sidesteps
it with one page load per view, which is also what a reader opening a file sees;
anything that restores several sessions into one live viewer (LocalFold's run
history is the obvious candidate) should check it before trusting a restore.

---

## 11. Two junction gates still decide a ligand's face count from the frame

The mitre's corner pairing and a run station's shared section both stopped
being frame decisions (the CLAUDE.md entry beside the twist clamp has the
numbers: the reported fold went from 9 of 9 steps rebuilding to 0 of 9). Over
the WHOLE 25-frame trajectory two steps still rebuild, and they are two more
gates of the same family, both in `mergeBondRuns` / the junction pass of
`cartoon/geom.js`:

  * **`if (!collarBd && legs.length > 3) { ...; if (tilt > 0.50) continue; }`** -
    a four-leg centre is mitred when its legs stand around the axis and handed
    to the collar path when they do not, and a noise frame moved one junction
    across that line: `tilt4: 1` on frame 15 and not on 14 or 16, which is four
    faces (444 -> 440 -> 444) and a refusal at each crossing.
  * **the run walk itself** - ten stations reached the section code on every
    frame but eleven on frame 15, so which bonds are one RUN moved too
    (`throughPair` picks an atom's two continuing bonds).

🔴 **AND THE FIXTURE BUILT FOR THE OTHER TWO RULES IS WHERE THESE WOULD SHOW.**
`_traj_patho_3chy.pdb` carries a three-leg junction with one leg swinging
through 60 degrees of azimuth; the four-leg planarity gate does not fire on it
(three legs, not four) and its run decomposition holds. If either of these is
picked up, extend that ligand - a fourth leg crossing the 0.50 tilt, or a run
whose `throughPair` choice changes - rather than starting a new fixture: the
`CONECT` pinning it already has is the hard part.

Both are answers about the MOLECULE - is this centre planar or tetrahedral,
which bonds are one chain - being recomputed from each frame's coordinates. The
shape of the fix is the one `_cartoonPairKey` already uses for base pairing:
compute it once and cache it on the object and its position count, never on the
coordinates. What that costs is the same thing it costs there - a ligand that
genuinely changes hybridisation mid-trajectory keeps the answer it was given -
and it is not obviously worth 2 rebuilds in 24 on a trajectory whose early
frames are noise. Measured, not fixed.

---

## 12. Fractional secondary structure — parked on `sse-fractional`

A letter is a threshold crossed, and a residue sitting on the threshold crosses
it back and forth as a structure moves. Measured on `_traj_3ptb.pdb`: **one
residue flipping is 2,700–4,900 px of a ~28,000 px step**, arriving in a single
frame while the coordinates drift smoothly. On `_traj_unfold.pdb`, 20 flips are
22,366 px of a 124,738 px step.

The branch holds a working implementation: `assignSecondaryOpen` returns a
POSTERIOR over {H, E, C} per residue — a three-state chain over the evidence
the DSSP tests already compute, forward–backward, O(3n) — and the ribbon draws
the mixture (`halfW`, `halfT` and the ss colour are all
`sum p(class) x profile(class)`). **It does not decide the letters**, so every
reader of `sec` sees what it always saw.

Why it is parked rather than merged:

  * **A dial nobody has chosen.** Sharpening the posterior makes static widths
    faithful and makes flips step more. Both ends measured — flips move 0.23
    (3PTB) / 0.62 (1TIM) unsharpened against 0.27 / 0.83 sharpened, where a
    bare letter flip moves 2.00; p(the letter's own class) on static
    structures is 0.79–0.84 against 0.83–0.87.
  * **It changes static pictures**, not only trajectories: 17 of 233 residues
    on 3PTB are partial.
  * `tests/paint_trace.js`'s eleven fixtures move, because the node harness's
    stub renderer picks the posterior up like any other renderer. Re-baselining
    them is a decision about shipping.
  * No gate of its own, no CLAUDE.md entry.

What was RULED OUT on the way, so nobody pays for it twice:

  * **A margin below the threshold is not enough.** The first version graded
    only the evidence that PASSED (`conf`), which cannot see a partner
    leaving: a fading bond drops out of the set rather than weakening, so of
    119 flips across three trajectories only 39 had a margin on either side.
    That is what the posterior is for.
  * **Raising the transition persistence alone makes it worse** — coil is the
    longest run in any protein, so a stronger persistence prior mostly
    strengthens coil: 0.98 took p(E) on 1UBQ from 0.69 to 0.35.
  * **A dihedral gate that multiplies to zero inside its own band** is a second
    threshold wearing a ramp's clothes; it halved every strand.
  * **A ladder EXTENSION carries no hydrogen bonds** — that is its whole point
    — so it must contribute its spacing comfort as evidence or the ends of
    every short strand come out mostly coil.
  * **Colour must be capped, not ramped with the shape.** Taken all the way, a
    marginal helix end arrives in the loop's green and reads as a loop, which
    is louder than the width it is drawn at. `SS_COL_BLEND = 0.35`, chosen by
    looking at five settings in one page load.

---

## 13. A zoom on a huge structure is half rate, and it is the PRODUCT of the
two sizes — not a regression

**Reported as** "somehow predeploy felt faster, especially on 3J3Y, like the
zoom in and out now feels a little laggy", after `e915167` went out.

**It is not a regression.** Measured with `scratchpad/zoomcast.py` (below),
three counterbalanced pairs of the shipped tree against `f480c1b` — the
commit before the deploy — on 3J3Y (271,425 positions) in a 1996x1996 canvas:
the page misses 18 vsyncs out of ~119 on BOTH trees, the presented-frame
median is 18.7-19.0 ms against 18.4-19.3, and **0 mesh builds** happen during
the gesture on either. Nothing measurable moved.

### Where the frame actually goes, and the levers, all measured

The main thread is **idle**: `render()` costs 0.1-0.6 ms a frame on 3J3Y at
1996x1996, `__faceBuilds` and `__tubeBuilds` both move ZERO over a two-second
zoom, and the drawn style there is the tube, whose instance buffer carries no
view-dependent number. So every millisecond of the 25 is the card's, and the
only question is what to stop asking it for. Each arm below is one page load
with one thing changed, against a baseline taken the same way
(`scratchpad/zoomlevers.py`, which installs its switch in `<head>` because the
GL context is made once and cannot be re-made):

| 3J3Y, 271,425 positions, 998px box | presented frame, median |
|---|---|
| baseline (dpr 2, MSAA on, outline 3) | 25.6 ms |
| outline off | 21.8 ms (-16%) |
| the GL context without `antialias: true` | 22.5 ms (-12%) |
| **the backing store at dpr 1 instead of 2** | **16.7 ms, 0 frames over 20** |

So it is fill, and the lever that reaches it is **resolution**: a quarter of
the pixels is a flat 60 fps with room to spare. The shape of the fix is the
standard one - render at a reduced scale WHILE a gesture is in flight and
restore it on settle - and two things are already in place for it:
`window.canvasDPR` is read by `parts/viewport.js`, and a size change is a
redraw rather than a rebuild on both GPU paths (`tests/resize_reuse.py`, and
measured again here for the tube: 0 instance builds across a resize).

**What it would cost is ~40 ms per switch**, twice a gesture, and that is NOT
a mesh rebuild: measured on 3J3Y, halving and restoring the canvas costs
36-45 ms with `__tubeBuilds` at 0 either way. It is the GL drawing buffer and
the occlusion framebuffers being reallocated at four million pixels. A
reduced-scale buffer kept alive beside the full one would avoid it; nothing
here tried that.

### The gesture scale: built, measured, looked at, and switched off again

It works, and it is **not in the tree** - reverted at the reader's word ("lets
disable it for now"), with everything needed to put it back written here.

What it was: while a drag or a zoom is in flight AND the card is over budget,
the GPU layer is drawn at half resolution and the compositor stretches it over
its box (`gestureScaleOf` in both `renderApp` and `renderTubeApp`, scaling the
`w, h` the GL canvas is sized to; `blitApp` stretching to the canvas rather
than drawing 1:1; `_gestureScale()` in `core/mol.js` beside `_frameOverBudget`,
released in `render()` and restored through the existing `_scheduleSettle`).
The viewer's own canvas is never scaled, so the overlays stay sharp over a
softer structure.

| 3J3Y, 271,425 positions at 1996x1996 | before | with it |
|---|---|---|
| page frames over 33 ms, over a 2 s zoom | 18 of 119 | **0 of 134** |
| presented frame, median / p90 | 18.7 / 31.0 ms | **16.7 / 18.1** |
| the card's own time per frame | 18.4 ms | 11.9 |

**The restored frame is byte-identical to the full-resolution one** in the same
page load (0.00 mean, which is the control that makes the rest mean anything).

🔴 **AND THE INTERVAL BETWEEN `render()` CALLS CANNOT SEE THE PROBLEM.** The
first version compared it and could never fire: requestAnimationFrame goes on
running at 60 Hz while the compositor presents at 30, so the page's own clock
reads a steady 16.7 ms through a gesture that is visibly half rate. What
reports the truth is `EXT_disjoint_timer_query_webgl2` - available in Chrome
here, asynchronous, so the number belongs to a frame or two back, which is
right for a steady gesture. The cheapest of the last five, the rule
`_frameOverBudget` already uses; null where the extension is absent, and an
unknown cost is not evidence of a slow one.

🔴 **AND IT HAS TO BE A LATCH.** Dropping the scale makes the frames fast,
which is exactly the evidence for putting it back, so a rule asked fresh every
frame oscillates - and every crossing reallocates the drawing buffer and the
occlusion framebuffers.

**What it costs, which is why it is worth a second look before shipping:**

  * **A cartoon's outline goes thin and soft** at half scale - a change of
    LOOK, not just blur (`scratchpad/scale/gesture_scale.png`, which is the
    same camera at both scales in one page load). A 748-residue cartoon never
    trips the budget, so it would not see this; a large one would.
  * **A hitch at each end of the gesture**: 57 ms at the start and 188 ms at
    the settle, measured in the screencast - the buffers being reallocated at
    four million pixels, not a rebuild. Keeping both sizes' buffers alive
    would remove it; not tried.
  * The cost ring has to be cleared when the buffer size changes, or a cost
    measured at one size decides the other.

🔴 **AND A CHANGE TO THE TUBE'S RESIZE PATH WAS WRITTEN, MEASURED AS A NO-OP
AND REMOVED.** `renderTubeApp` nulls `tubeSig` when the canvas size moves,
which reads exactly like the fault the cartoon path above it already fixed
("A RESIZE NO LONGER THROWS THE MESH AWAY") - and it is not one: the very
next block restores the buffer by value when `tubeLive.sig === key`, so the
null costs a lookup and no build. Measured both ways on 3J3Y: **0 instance
builds and 36-45 ms either way.** A gate written for it passed against its own
mutation, which is what said so.
*Two probe faults cost a round each on the way, both the same shape - the
window being measured contained the control. The build counter was read AFTER
the forced-rebuild arm, and the counter was started AFTER waiting for the new
canvas size, by which time the viewport's own observer had already served the
resize on its own frame.*

**What IS true is that the gesture runs at half rate, and neither size causes
it alone:**

| | canvas 1196x1196 | canvas 1996x1996 |
|---|---|---|
| 1AOI, 1,103 positions | 60 fps | **60 fps** |
| 3J3Y, 271,425 positions | **60 fps** | 30 fps, 50-58 ms hitches |

So it is not pixel-bound and it is not geometry-bound: it is the per-frame
GPU draw of a quarter-million positions' worth of instances over four million
pixels. A zoom rebuilds nothing — the mesh is resident, `__faceBuilds` does
not move — so the lever is the draw, which is the one thing the station fast
path does not touch. Untried: culling, or a detail drop while a gesture is in
flight (which the Detail slider already does by hand, and which the file
refuses to make automatic elsewhere, because a drawing that depends on
something invisible in the controls is a design decision).

**The instrument.** `scratchpad/zoomcast.py` films a real zoom:

    python3 scratchpad/zoomcast.py 3J3Y.cif --hz=120 --n=240 --size=1000

A **headed** Chrome under `Page.startScreencast`, the same catch that found
the heatmap's black frame and for the same reason — headless composites
through SwiftShader, so what it says about smoothness is about SwiftShader.
Real `Input.dispatchMouseEvent` wheels, because a scripted wheel is not
trusted and this measures the whole path. Two clocks, and both are needed:
the page's own rAF timestamps say what the MAIN THREAD managed, the
screencast deltas say what was PRESENTED, and a gap in one without the other
says which half to look at. Three things it cost:

  * 🔴 **`ws.call()` drops events** — it reads until it sees its own id and
    bins the rest — so nothing may call it while the screencast runs. The
    capture pumps `recv()` itself and matches replies by id.
  * 🔴 **The wheel rate is the frame rate when it is below 60 Hz.** At the
    obvious 30 Hz every presented interval is 33 ms and the page looks
    exactly half rate on a structure that is perfectly smooth. Drive the
    wheels FASTER than the display.
  * 🔴 **The full-screen button needs a trusted click**, so `--size` writes
    `#canvasContainer`'s box instead and lets `setupViewport`'s
    ResizeObserver do the rest. Measured at the default 598px box, every
    structure tried is a flat 60 fps and the report is invisible.
