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

## 8. Detail 2 arrowheads: shipped, and what it cost

Not open - recorded so the trade is not re-litigated. At the geometric floor an
interval has three stations and an arrowhead wanted five of its own, so a
residue joining the end of a strand moved the topology and every such animation
frame rebuilt (**60 of 79** replayed fight steps at Detail 2, against 0 at
Detail 3). The seam now takes a station the interval already has: **0 of 79**.
What it costs is the barbs at Detail 2 ALONE - the head tapers to a point, since
a square back edge needs two stations at one place and there is no third to
spare. Looked at side by side and chosen deliberately. `tests/ss_axis.py
--detail=2` is the gate and runs in `tests/run.sh`.

---

## 9. protein_fighter vendors py2Dmol by hand

`../protein_fighter/vendor/py2Dmol.embed.min.js` is a copy of this repo's embed
bundle, updated by hand when the game needs a fix. Anything that changes the
embed bundle's behaviour should ask whether that copy needs refreshing: a
py2Dmol deploy does not touch it, and the game can sit on a bundle that is
older - or newer - than what the site serves. It was last refreshed at
`3e670c2` and this repo has moved on since, so check before assuming the two
agree.
