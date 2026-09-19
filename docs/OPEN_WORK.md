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

## 6. Colour is a residue's, and every mode still draws it half a residue late

The cartoon already centres colour on the residue - `geom.js` cuts an interval
at its midpoint and colours each half from its own end (`twoTone`, `colFar`) -
but ONLY under per-residue overrides or in ss mode. Every colour MODE (pLDDT,
hydrophobicity, chain, rainbow, entropy) falls back to `colFar = col`, so the
whole interval takes its first residue's colour and the drawing is half a
residue downstream of the data. `resolveSegmentColors` returns early for the
same reason (`if (!ssMode && !hasOv) return null`).

The GPU palette already holds three texels a segment (whole, near half, far
half) and the 2D painter shares the pieces, so no shader work is needed.

**The design decision, if this is picked up:** cut EVERY interval at its
midpoint, not only where the two ends differ. A cut that appears only when
colours differ makes the geometry depend on the colour, so changing colour mode
becomes a rebuild instead of a texture upload. Cutting always keeps the topology
colour-independent, at the cost of more pieces - unmeasured. Tube would need the
same treatment separately (split each capsule at its midpoint).

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
