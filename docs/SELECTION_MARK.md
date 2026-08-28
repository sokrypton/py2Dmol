# The selection mark — six treatments, three of them shipped

**Status: SHIPPED as a setting.** `selectionMark` is the `Sele` dropdown in
the Style panel, beside `Color` — **highlight**, **outline**, **none** — wired
once in `parts/ui.js` and so present in all three shells. The default is the
highlight, which is what this always was.

The complaint that started it: **in focus mode the highlight is too intense**.
The answer turned out not to be a better constant but a choice, because the
right mark depends on the structure and the colour scheme: over a yellow chain
the highlight is a blot with the answer inside it, and over a pale one it
reads perfectly well.

This file keeps the whole search — including the two treatments that were
rejected and the three that did not ship — so the next person tuning it starts
from measurements rather than from taste. The options table below is still the
menu: any row of it is two constants away.

## What ships today

`core/mol.js`:

```js
const SELECTION_HALO_CSS = 'rgba(255, 255, 0, 0.45)';
const SELECTION_HALO_SOLID_CSS = 'rgb(255, 255, 0)';
const SELECTION_HALO_ALPHA = 0.45;
const SELECTION_HALO_GAIN = 1.3;
```

A translucent band, 1.3× the drawn radius, painted over the finished frame by
`_paintSelectionHalo`. It covers the residue it marks - which is the whole of
the complaint, and also why it has to be pale. Over a
yellow chain — which chain colouring will hand you sooner or later, and 4HHB's
A chain is yellow — it reads as a blot with the answer somewhere inside it.

## The six, with their exact constants

Rendered from one focus click on 4HHB residue 40, same camera, cropped 300 px
square at 2×. The pictures are at
<https://claude.ai/code/artifact/f469436f-7587-419b-92e7-16e29114f4fb>.

| # | name | colour | alpha | ring px | verdict |
|---|---|---|---|---|---|
| 1 | Highlight | `255,255,0` | 0.45 | — (filled) | **ships** as `highlight` |
| 2 | Amber ring | `255,190,0` | 0.85 | 2.5 | **worse** — a highlighter |
| 3 | Amber, faint | `255,190,0` | 0.40 | 1.4 | quiet, still warm |
| 4 | Ink | `40,42,55` | 0.45 | 1.4 | **ships** as `outline` |
| 5 | Ink, hairline | `40,42,55` | 0.30 | 1.2 | very faint |
| 6 | Graphite | `120,125,140` | 0.55 | 1.2 | neutral, mid-weight |

Rows 3, 5 and 6 are `SELECTION_OUTLINE_LIGHT` / `_ALPHA` / `_PX` in
`core/mol.js` and nothing else — the outline's shape is the same for all of
them.

Two more were drawn and rejected before the shortlist: a **white glow**
(`255,255,255` at 0.62) washes the residue out — it hides what it marks worse
than the yellow does; and **no mark at all**, relying on the focus zoom and the
side chains to say where you are, which is genuinely ambiguous — with a dozen
side chains out, nothing says which one you clicked.

## How a ring is drawn

The band is a fat stroke along the selection's path. To make a ring, stroke it,
then stroke it again two ring-widths narrower with `globalCompositeOperation =
'destination-out'`: what is left is the rim, and the geometry inside is
untouched. That is what lets the mark be thin without disappearing — the
highlight has to be pale *because* it covers things, and a rim does not.

Three things that have to come with it:

- **The scratch layer becomes unconditional.** It was skipped when the
  selection had a single width group; `destination-out` against the finished
  frame would erase the drawing, so the punch needs a layer of its own.
- **Two callers cannot punch and must fall back to the highlight.** An SVG export
  (`ctx.getSerializedSvg`) — `destination-out` is meaningless in a vector
  context and compositing a raster layer would put a bitmap in the file, which
  is the one thing an SVG export exists not to do. And a context with no
  document behind it: the node harnesses hand in a recording mock, where
  `createElement` answers and `getContext` does not.
- **A dark ring must follow the paper.** The `3d` preset draws on black and an
  ink line there is invisible — worse than loud, because nothing tells the
  reader a selection exists. Light on dark, dark on white, the rule the hover
  readout already follows (`HOVER_TEXT_LIGHT_CSS` / `_DARK_CSS`).

And **the gain changes with the shape**: 1.3 for a band, 1.0 for a ring. A band
reads at its outer edge and a ring at its inner one, so the number that puts a
highlight's edge in the right place leaves an outline standing off what it
traces.

## What it costs — nothing worth weighing

`_paintSelectionHalo` timed over 60 spinning frames, 4HHB:

| selection | highlight | outline | difference |
|---|---|---|---|
| 1 residue | 0.095 ms | 0.112 ms | +0.017 |
| 26 residues + side chains | 0.278 ms | 0.297 ms | +0.019 |
| 700 residues | 0.495 ms | 0.620 ms | +0.125 |

0.02 ms on a normal selection is 0.1% of a 60 fps frame. **Between the six
treatments there is no difference at all** — a colour, an alpha and a thickness
are values, not work.

Two costs that were expected and are not there. The full-canvas layer clear and
composite does *not* scale the way it looks: measured at 1,196×1,196 device
pixels, four times the area, the number is unchanged at 0.112 ms — canvas 2D is
GPU-backed and fill rate is not where this lives. The second stroke pass only
shows on a large selection (700 residues, +25% of an operation still under a
millisecond). If it ever mattered the fix is to clip the layer work to the
selection's bounding box, and at these numbers there is nothing to buy.

## The probe

`tests/selection_mark.py` asserts the property rather than the pixels, which is
what survives a change of taste. One leg per mark: the highlight must cover
the residue, the outline must not, `none` must draw nothing at all. For the
outline:

- the pixels **at** the selected residue are unchanged — nothing painted over
  it;
- pixels **near** it did change — there is a mark at all. Without this every
  other check passes for a halo that draws nothing;
- and the change is **local**, not smeared across the canvas.

Mutated three ways, one per mark: ignoring `outline` and always highlighting fails
the outline leg (25 of 25 pixels at the residue change), ignoring `none` fails
its leg (189 pixels drawn where none were asked for), and turning the punch
into `source-over` fails the outline leg the same way the first mutation does.
Both painters are checked for the outline, because the mark is laid over
whatever drew the frame — they report identical numbers, which is a fact about
the halo and not a bug in the probe.

`tests/interaction.js` takes the band proportion from `SELECTION_HALO_GAIN`
rather than writing `2.3` out, so a change of taste does not read as a broken
rule. What it still asks is that the band is a proportion **at every size**,
which is the thing that was genuinely wrong once.

## Focus wears the outline

The mode switches `selectionMark` to `outline` on entry — it is the case the
outline was built for, since focus moves in on one residue and the highlight
lays a band over exactly that.

It puts the reader's choice back **when the mode ends**, not on every
`clearFocus`: inside the mode that is the way out of one *focus* rather than
out of the mode. Restoring there took the outline off and left the mode running
with the reader's mark on, and anything that empties the selection reaches it —
loading a structure does, so the Sele dropdown dropped to Highlight while Focus
stayed lit. The guard is `!this._focusMode`, which needs no argument because
`exitFocusMode` clears the flag before it restores.

It does NOT put it back if the reader changed the mark themselves while inside
(`selectionMark === 'outline'` is the test): that is a preference, not
something the mode borrowed. `parts/ui.js` installs `_syncSelectionMark` so the
dropdown follows. See the focus entry in CLAUDE.md for the rest of the mode's
borrow-and-return rule.

## The mark follows the ribbon

**Fixed.** `cartoon/geom.js` records the drawn centre line — `_traceProbe`,
filled in the one loop that walks an interval's stations, about five points per
residue — and the halo strokes that instead of joining residues with straight
lines. On 4HHB's longest helix the path is **328 px against 295.8 of chords**,
which is the arc-over-chord ratio of a helical step; on a tube it is exactly
the chords, because a tube *is* those straight lines.

It is the drawing's own curve rather than a second smoothing: the ribbon uses a
helix-exact Hermite stencil for helices, Catmull-Rom for loops and one-sided
stencils at run ends, and any reimplementation would have been wrong on the
first structure that took the other branch.

Four things that looked like the answer and were not:

- **`_posProbe` is not the ribbon.** One point per residue, equal to the atoms
  for helices and coil, 2.11 Å away for strands on 1TIM because a sheet's
  pleat is flattened for drawing. Following it fixes sheets and does nothing
  for a helix.
- **The corners `evalSlab` returns are projected**, so averaging them gives a
  screen point rather than a centre line. The centre is `q0`, the Hermite point
  itself, handed back on `cnr.mid`.
- **The samples are in rotated space, and the GPU runs geom only on a rebuild**
  — so a trace kept that way is the last rebuild's picture. It is stored before
  the rotation and the centring, and re-rotated at use.
- **The halo cannot borrow the projection parameters**: on a cached GPU cartoon
  frame neither projection routine runs, and the positions are last frame's,
  still stamped valid because nothing moved. It builds them from the viewer
  state.

🔴 **The trace is not dropped on invalidation**, and it was: toggling Cyclic
invalidates *after* the rebuild that would have refilled it, so the trace went
to null and nothing asked for another — every helix back to chords, for good.
A build refills it and a build happens exactly when the ribbon changes. What it
does need is a style gate, since it outlives a build on purpose.

## Not wired to the config

`selectionMark` is a runtime control only: it is not in `normalizeConfig`'s
`rendering` block and there is no `view(selection_mark=...)`. Adding one means
the usual three places — `viewer.py`, `normalizeConfig` (which rebuilds
`rendering` FIELD BY FIELD, so a key it does not name is a key it throws away)
and `tests/config.js`, which reads the keys out of both sides and names any one
side drops.
