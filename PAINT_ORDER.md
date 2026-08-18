# Ribbon vs side-chain paint order in the py2Dmol cartoon renderer

A handoff brief. One bug, six measured attempts, none applied. Each is recorded
with the measurement that killed it, so nobody spends a day rediscovering why.

## Status

**Nothing is applied.** The tree is at `2c9f670` and green (32 smoke source and
bundle, 54 interaction, 23 structures, benchmarks unchanged). Every attempt
below is recorded with its measurement so nobody spends a day rediscovering why
it fails.

Three stashes hold the work, newest first:

| stash | what it is |
|---|---|
| `stash@{0}` | side-chain clamp + `_scClamp` knob + 3 paint-order tests. **The best measured result**, §3.6 |
| `stash@{1}` | rib surface-split (per-surface, then near/far). Caused 4 visual regressions, §3.3–3.4 |
| `stash@{2}` | contact trapezoid ends + an earlier sort experiment |

Two changes were deliberately **kept** in the working tree because they are
unrelated bug fixes, not paint-order work: `tests/make_test_html.py`,
`make_na_test.py` and `make_richardson_test.py` passed `style="ribbon"` and
`style="richardson"`, but `style` only accepts `"tube"` or `"cartoon"` and
raises otherwise — `richardson` is a **preset**, not a style. Those pages could
not have been generated. Plus one `tests/README.md` line for
`paint_order_lab.html`.

## The scoreboard

Wrong pixels over 200 view directions, ideal α-helix, thickness 0.75, a side
chain on **every** residue. "Wrong" = the face that ends up on top is not the
face that is actually on top, measured on the finished drawing.

| approach | total | chain over ribbon | ribbon over chain | verdict |
|---|---|---|---|---|
| **shipped (do nothing)** | 94047 | 71724 | 11540 | the baseline |
| `zSort + halfT` | — | — | — | no-op at default thickness, §3.1 |
| piece keyed at its nearest face | 55284\* | 9\* | — | wrecks ribbon-vs-ribbon, §3.2 |
| rib split per surface | 1972\* | 1096\* | — | dark line down every helix edge, §3.3 |
| rib split near/far | — | — | — | traded the categories, broke the outline, §3.4 |
| **side-chain clamp** | **85587** | 55398 | 19395 | best measured; `stash@{0}`, §3.6 |
| clip the side chain | 209473 | 52635 | **119207** | erases visible geometry, §3.7 |

\* measured on the single-side-chain fixture, which cannot show
ribbon-over-side-chain at all — see **Fixtures** below. Not comparable with the
rows around them; that mistake is exactly why the near/far split looked good for
an afternoon.

**No approach improved both categories.** Every one moves error between them —
except width tiling, which has evidence but only in a standalone model (§6).
That is the central finding.

---

Everything below is measured, not inferred. Where a number appears, the harness
that produced it is named in **Reproducing the measurements**.

---

## 1. The renderer, in one page

`py2Dmol/resources/viewer-cartoon.js` (~11,400 lines) draws protein cartoons to
a 2D canvas. There is no depth buffer for the fills. It is a **painter's
algorithm**: everything drawable is pushed onto a `prims` array, each prim
carries a scalar depth key `z`, and the whole array is sorted once —

```js
prims.sort((a, b) => a.z - b.z);          // viewer-cartoon.js:8851
```

— then drawn in that order. Larger `z` is nearer the viewer, so later painters
win. `project()` returns `[screenX, screenY, z, pe]` where **`z` is raw world
depth in Ångström**, not a scaled or normalised value.

Two kinds of prim matter here.

**`rib`** — a piece of ribbon. Built at `viewer-cartoon.js:5868`. A piece is a
**slab**: a twisted box with two wide faces, two thin edge bands ("thickness
bands"), and end caps. It carries the projected corners of its cross-section at
each station in four parallel arrays `Lp`, `Lm`, `Rp`, `Rm` (left/right ×
plus/minus the face normal). Its key is the mean depth of every corner of the
whole piece:

```js
const zSort = zSeg / (e0 - a0 + 1);       // the piece's CENTROID
```

**`stickFace`** — one face of one bond of a side chain or ligand, built at
`viewer-cartoon.js:6868`. Its key is the mean of **that face's own four
corners**:

```js
z: zf / 4,                                // the face's SURFACE
```

So the two kinds key on different things: a `rib` on a **body's centroid**, a
`stickFace` on a **surface**.

### Piece size

At the default `cartoonDetail: 4`, `nsub = 4` stations per residue interval, and
`renderer._cuts` defaults to `'quarter'`, which makes `cutSet = [0,1,2,3,4]` —
**every sub-quad is already its own prim**, about a quarter of a residue, ~1.07 Å
of arc on an α-helix. Cutting further along the chain is not available at default
detail; that axis is already maximal. Pieces are additionally cut wherever the
face or width normal changes sign (an orientation fold).

### Relevant dimensions (α-helix, default settings)

| quantity | value |
|---|---|
| half-width `halfW` | `SS_HALF_A.H` = **1.3 Å** × width slider |
| half-thickness `halfT` | thickness slider ÷ 2, **0 to 0.75 Å** (slider max 1.5) |
| piece arc length | ~1.07 Å |
| side-chain stick half-width | `LIGAND_STICK_H * (LIGAND_WIDTH/3)` = **0.25 Å** |
| CA–CB bond | 1.53 Å |

**The width is the largest extent by far** — 2.6 Å across, versus ~1.07 Å along
the chain and ≤1.5 Å thick. Remember this; it is the crux.

---

## 2. The bug

Reported from the drawing, at **yaw −19°, pitch −75°** — looking nearly down the
helix axis, which is where a piece presents its *width* to the eye.

A side chain was painted **over a ribbon that is genuinely in front of it**.

### Root cause

A body has no single depth. A piece keyed at its centroid claims to be up to its
own **half-width — 1.3 Å — further away than its near face actually is**. A side
chain lying in that gap keys nearer than the piece and wins the sort, even though
the piece's near surface is in front of it.

A `stickFace` never had this problem: it keys at one surface, so its key is
honest. The asymmetry is the bug. Confirmed at the reported view: 50 wrong pixels,
up to 0.74 Å deep, **100% of them side-chain-over-ribbon**; ribbon-over-ribbon was
zero there.

### The metric used throughout

Every face the painter emits is rasterised. At each covered pixel, compare **the
face that ends up on top** (highest draw order) with **the face that actually is
on top** (greatest interpolated depth). A pixel where they differ is a pixel drawn
in the wrong order. This is a property of the finished drawing, so a key that is
self-consistently wrong cannot fool it.

Errors are then bucketed: `chain>rib` (a side chain painted over a nearer ribbon),
`rib>chain`, `rib>rib`.

---

## 3. What was tried

Fixture unless stated: ideal α-helix (2.3 Å radius, 100°/residue, 1.5 Å rise),
thickness 0.75, side chain leaving at 60° off the face normal, 200 view
directions spread over the sphere. Roll about the view axis is not sampled — it
changes neither depth nor overlap.

### 3.1 `zSort + halfT` — lift the ribbon by its half-thickness

Rejected. Across the thickness slider's real range it does nothing you can see:
identical at 0 and 0.3, **slightly worse** at 0.75, better only at 1.5. At the
default thickness of 0 it is a strict no-op (`halfT` is 0). It removes **2 of the
50** wrong pixels at the reported view.

Wrong quantity: looking down the axis the piece's depth extent is its *width*,
not its thickness.

### 3.2 Key the whole piece at its nearest face

Rejected. Kills the reported bug almost completely (`chain>rib` 3010 → **9** over
200 views) and **detonates ribbon-vs-ribbon**: 13014 → 54823, total 16085 →
55284. This is exactly the `zMax` row of a mis-ordering table already recorded in
the source: for ribbon-against-ribbon the centroid is measurably the best key
(0.71% mis-ordered pairs vs 0.85%). Hoisting a piece's near face drags its *far*
surfaces along with it.

### 3.3 One prim per surface

Best sort of anything tried, and **a worse drawing**.

| keying | total | chain>rib | rib>rib |
|---|---|---|---|
| centroid (shipped) | 16085 | 3010 | 13014 |
| centroid + halfT | 13919 | 801 | 13021 |
| piece's nearest face | 55284 | 9 | 54823 |
| **per surface** | **1972** | 1096 | **817** |

Then the user reported dark lines along every helix edge. Cause:

**Within a piece the surfaces must paint in FACING order, not depth order.**
Neighbouring surfaces of one piece overlap by about a pixel — `fillQuadSafe`
(`:9386`) strokes every sub-quad at `lineWidth 1`, and `CULL_EPS` (`:9588`,
default 0.12) deliberately keeps turned-away surfaces drawing. In that band the
last painter wins. Which one *should* win is decided by facing: at the silhouette
the two surfaces' mean depths are within a fraction of an Ångström and the
comparison flips on noise, while the facing comparison stays firm. A thickness
band is lit at a **constant neutral value, darker than a lit face**, so every flip
reads as a dark line down the edge of the helix.

The renderer had always done this correctly, in a block that sorted a piece's six
surfaces by how much each outward direction points at the eye
(`surfaces.sort(...)`, `:10051`). Splitting per surface promoted that sort into
the global one and destroyed it: **29% of seam-capable pairs inverted.**

Two repairs were tried and both fail:

- **A tiebreak band** (`z += EPS * facing`). The inversions are *not* near-ties:
  29% at eps 0, still 15% at 0.8 Å, and widening it far enough to catch them
  destroys the global sort (39588 wrong pixels at 2.0 Å).
- **Permuting the piece's depth values into facing order.** Restores facing order
  perfectly (0 inversions) but undoes the fix — the near face stops keying at its
  own depth and `chain>rib` at the reported view goes straight back from 0 to 48.

### 3.4 Near side / far side — two prims per piece

A seam is only visible between two surfaces that **both** face the eye. Put those
in one prim, where facing settles their order internally exactly as before; put
the turned-away ones in the other prim, which paints first because it genuinely is
behind. Key each group at the mean depth of its own surfaces.

Result: **0 seam inversions** in 56,640 pairs, and the reported bug reduced from
50 wrong pixels at 0.74 Å to 14 at 0.23 Å.

Then two more failures appeared.

**(a) It trades one error category for the other.** Measured on a fixture with a
side chain on **every** residue — a single-side-chain fixture structurally cannot
show a ribbon covering a *different* residue's side chain, which is why earlier
runs reported `rib>chain` as zero:

| mix | total wrong | chain>rib | rib>chain |
|---|---|---|---|
| one body (shipped) | 94047 | 71724 | **11540** |
| 0.25 | 83623 | 62294 | 20543 |
| 0.50 | 75063 | 50112 | 24160 |
| 0.60 | 69771 | 43563 | 25417 |
| 1.00 | **61101** | 23768 | 36506 |

where `mix` blends the key from the piece centroid (0) to the group's own surface
mean (1). **There is no value where both categories beat one-body keying.** Total
falls monotonically; `rib>chain` rises monotonically. A middle value is the worst
of both: at 0.6 the original bug is essentially back (32 px, 0.79 Å) *and* the new
one is already present.

**(b) The outline moved out from under the fills.** Ribbon outlines are separate
`ribStroke` prims keyed at their own nearest point plus a fixed up-bias
(`:8180`):

```js
const bias = 0.3 * widthScale;            // 0.3 Å at default width
prims.push({ kind: 'ribStroke', pts: cp, z: zq + bias, ... });   // :8200
```

That 0.3 Å was tuned against fills that all sat at the piece centroid. Splitting
moves fills apart by a **measured 1.095 Å mean near/far gap** — over three times
the bias — so a turned-away face's outline now paints over its own fill.

### 3.5 Bookkeeping that any splitting approach must handle

Several passes walk `prims` and register **a whole slab per rib prim** they meet.
Duplicating rib prims duplicates their effect:

- the ink occluder registration,
- the z-buffer occluder pass,
- the ink-grid cell sizing (which counts occluders to choose a cell size),
- the animation wash — painted twice, it is **twice as dark**.

The experiment handled this with an `sfMain` flag: exactly one prim per piece
carries it, and those four passes skip the rest. `registerJoint` (`:4165`) must
likewise fire once per piece, not once per prim.

---

### 3.6 The side-chain clamp — best measured, `stash@{0}`

Seven lines in the `stickFace` builder, no change to the `rib` prim:

```js
let zKey = zf / 4;                                 // the face's own mean depth
if (scClamp && bd.rollN && bd.rollP && bd.rollN.length > 2
    && bd.rollN[2] < -0.05) {                      // it left through a turned-away face
    const rootZ = bd.rollP.z !== undefined
        ? bd.rollP.z : (bd.va ? bd.va.z : zKey);   // depth of the point it left through
    zKey = Math.min(zKey, rootZ);                  // ...so it cannot key nearer than that
}
```

**The idea is to stop asking the depth keys a question they cannot answer.**
Which side of the ribbon a side chain is on is already known exactly: `rollN`
is the outward normal of the surface it leaves through, so `rollN[2]` is how
much that surface faces the viewer. Negative means it went out the back. That is
a fact about the geometry, not a comparison to get right.

`Math.min` — it can only push a face further away, never nearer. Only the **root
bond** carries `rollN`/`rollP` (they are set where exactly one end of a bond is
a side-chain atom), so the rest of the side chain sorts on its own honest depth.

**94047 → 85587**: chain-over-ribbon down 23%, ribbon-over-chain up 68%. With a
*single* side chain it is strictly free (3010 → 928, the other category
unchanged at 61); the cost only exists once the ribbon has other side chains to
hide.

Two constants were **swept out** rather than tuned:

- *How far to push.* A bare `1.2` was tried, then the residue's own half-width
  (which at least follows the Width slider). The sweep says the push is wasted
  motion — 0 → 85587, 0.3×halfW → 89640, 1.0×halfW → 92631, while the error it
  targets barely moves. The whole effect is the clamp.
- *The facing threshold.* −0.05 is the optimum; tightening trades the two
  categories back roughly 1:1 (−0.5 → 93084).

Exposed as `renderer._scClamp` alongside `_cuts` and `_inkCell`, because whether
the trade is worth it is a judgement about the drawing.

### 3.7 Clipping the side chain instead of sorting it — the best idea that fails

The obvious move, and the one worth documenting hardest because it looks right:
don't sort the side chain against the ribbon it grows from, **cut it**. Where
that ribbon covers it, don't draw it; then no key has to arbitrate.

It is supported by a real measurement. Attributing every remaining
chain-over-ribbon pixel to a residue: **100% were against the side chain's own
residue's ribbon**, none against a neighbour, none elsewhere in the fold. So a
purely local clip ought to be sufficient.

Implemented — record the two sub-quads meeting each CA, hand them to the stick's
faces, and in the painter build a clip path of the canvas rect plus each surface
quad wound the other way (nonzero fill leaves the complement of their union).

**It is more than twice as bad as doing nothing: 209473 wrong pixels, with
ribbon-over-side-chain at 119207 and a worst error of 10.93 Å.** Whole side
chains vanish behind ribbon they are well in front of.

The reason is that a clip is a *footprint* test, and the question is a *depth*
question. Cutting against the piece's screen footprint removes the stick
wherever that piece is — including where the stick has come round in front of
it. Cutting only where the piece is genuinely nearer is per-pixel, which is the
one thing a painter's algorithm cannot ask.

**Anyone retrying this should note it was measured wrong the first time**, and
the wrong measurement said it was the best result of the day (60908, both
categories beating baseline). See **Fixtures and harness traps**.

## 4. Constraints any solution must satisfy

1. **Ribbon vs ribbon wants the centroid.** Measured best; already recorded in a
   table in the source.
2. **Ribbon vs side chain wants the near surface.** That is the reported bug.
3. **Within a piece, order is by facing, not depth** — or helix edges go dark.
4. **The outline must move with the fills.** Its 0.3 Å bias assumes fills sit at
   the piece centroid.
5. **Occluders, wash and joints are per piece**, not per prim.
6. Cost is acceptable but not free: the near/far split doubled prim count
   (44 → 76 per frame on a helix) and cost +18% build+sort at 400 residues, +29%
   at 1200 (node, mock context — real canvas painting dilutes this).
7. No regressions in: `tests/smoke.js` (32), `tests/interaction.js` (54),
   `tests/sidechain_chain.js` (23 structures), `ss_bench` Q3 89.76%, `sheet_bench`
   22.2/11.3, `na_frame` 4.1%.

Constraints 1 and 2 are the heart of it: **a single scalar per body cannot serve
both**, because against a stick a piece wants its near surface and against another
piece it wants its centroid.

---

## 5. Where the remaining error lives

After the near/far split the dominant residual is **the width**. A ribbon surface
spans 2.6 Å across, and one scalar key stands for all of it, so wherever a side
chain overlaps one *end* of a surface the key is describing the middle. Cuts along
the chain are already maximal at default detail. Nothing has been tried on this
axis.

That points at splitting a surface **down its length** — but note this is a change
to the fill path (`paintFace` / `paintSide` draw full-width strips), not a keying
tweak, and it must carry the ink pass with it.

---

## 6. Width tiling — the one direction with evidence behind it

§5 says the residual is dominated by a ribbon surface spanning 2.6 Å of width
while one scalar key stands for all of it. `tests/paint_order_bench.js` tests
that directly, by tiling ribbon and stick **across their width** and keying each
tile. It is a **standalone model, not the renderer** — it reimplements the
geometry — so its numbers are internally comparable and NOT comparable with the
rest of this document. On its own baseline, 200 views, a side chain on every
residue:

| approach | total | chain over ribbon | ribbon over chain | ribbon over ribbon |
|---|---|---|---|---|
| centroid (shipped) | 618996 | 488025 | 93222 | 62 |
| near/far split | 481079 | 234608 | 210226 | 62 |
| per-surface | 431675 | 217291 | 177676 | 118 |
| width tiling R2 S1 | 296210 | 146180 | 102690 | 5221 |
| width tiling R4 S2 | 240211 | 87347 | 122029 | 5997 |
| **width tiling R4 S4** | **151985** | **52194** | **81133** | 6067 |

**This is the only approach measured anywhere that improves BOTH side-chain
categories** — chain-over-ribbon down 89%, ribbon-over-chain down 13%. Every
keying scheme in §3 moves error between them. It costs ribbon-vs-ribbon (62 →
6067, still small in absolute terms) and R×S tiles per piece.

Two cautions before anyone believes it:

- The fixture is the bench's own, and part A uses a **single** side chain, where
  ribbon-over-side-chain is structurally ~0 — the "0 px" rows there mean less
  than they look. Part C is the one to read.
- It has not been tried in the renderer, where tiling means splitting the strip
  fill and carrying the ink pass with it — the two things that made §3.3–3.4
  fail. §4 lists what that has to respect.

Twenty-nine one-off scripts that produced these bench numbers were moved out of
the repo to the session scratchpad (`repo-scratch/`) rather than deleted; the
bench and the lab supersede them.

`tests/paint_order_lab.html` is the interactive companion: it compares the
shipped order, per-surface, a shared seam rail, adaptive tiling, triangle
primitives and a triangle **z-buffer reference**, with tile sweeps and a
ribbon×stick error grid. Open the file directly; `build.py` does not generate
it.

## 6b. Directions still unexplored

## 7. Reproducing the measurements, and the traps

`scratchpad/audit.js` is the one to trust. It was rewritten from scratch after
three earlier harnesses gave confidently wrong answers, it is self-contained (no
`eval`, no patching another script), and it **reproduces both known baselines
exactly** — 94047 for the shipped build, 85587 for the clamp. Run it as
`CARTOON=<path> [SC_ALL=1] node audit.js`.

### Fixtures decide what you can see

- **A single side chain cannot show ribbon-over-side-chain.** With one stick
  there is nothing for the ribbon to wrongly hide, so that whole error category
  reads as ~0 no matter what you do. `SC_ALL=1` puts one on every residue. Half
  the wrong turns below trace to a number measured on the one-stick fixture.
- **A side chain aimed straight out of the face never exercises the rule.** It
  is cleanly front- or back-facing and the sort gets it right anyway. The
  failure needs it leaving at an angle — 60° off the face normal reproduces it.
- **The canvas size is part of the fixture.** Thickness fades with projected
  size (`thickZoom`), so a small canvas quietly thins the slab and the geometry
  under test stops being the geometry that failed.
- **Rotate about the structure's centre**, not the origin. Same angles about a
  different origin is a different view and does not reproduce.

### Harness traps, each caught only by a deliberate control

- **Giving every face of a prim the same order measures the harness's own
  tie-break.** A first version did, and reported 100% of errors in the wrong
  category. The painter's real order inside a rib prim is: surfaces by facing,
  then stations in chain order.
- **A harness that reads a prim field the build does not have audits nothing.**
  Expanding ribbon prims through a field belonging to a different experiment
  found zero ribbon faces and reported 0% for the error it existed to detect.
  Two separate conclusions were drawn from that zero before it was caught.
  **Assert the face counts before reporting a rate.**
- **Skipping clipped pixels entirely hides the only failure a clip can have.**
  A clipped face must still count toward the TRUTH — it really is at that depth
  — while being excluded from what was PAINTED. Skipping both made erasing
  visible geometry score as a perfect frame, and turned the worst idea of the
  day into the apparent best.
- **Attributing every clip region to every face** erased most of the side chains
  and produced 213066 phantom errors.
- **A geometry audit that skips pairs as "intersecting" reports 0.00%
  vacuously.** Flush-cut geometry *touches* by construction; distinguish
  tangency from penetration with a signed clearance, not a boolean.

### The same failure on the test side

An assertion that "some ribbon prim keys nearer than the first stick face" is
true of any helix from any angle — it passed with the rule under test deleted.
**Mutate the renderer and watch the test fail before believing it.** Of the
paint-order tests written this session, several passed under mutations until the
fixture was corrected; one asserted nothing at all because it read `part.sfSet`
where `part` was `{o, g}` and a `|| []` swallowed it.

## 8. Separate finding: geometric interpenetration

Distinct from paint order, and worth not confusing with it. A side chain leaves
the ribbon's face at `exit = halfT/μ`, where `μ` is the cosine of its angle off
the face normal. Its far atom then stands `1.53μ − halfT` above the surface and
carries the stick's own square section, whose corner reaches
`0.25·√(1−μ²)` back toward it. The bond clears the ribbon iff

```
1.53·μ − halfT  ≥  0.25·√(1−μ²)
```

Predicted onsets match measured ones to about 0.15 of thickness. At 0–40° off the
face normal there is no interpenetration anywhere on the slider; at 60° it starts
at thickness 0.93, at 70° at 0.43. Where the solids genuinely overlap, **no paint
order is correct** and no sorting change can help.

Not measured: where real side chains fall on that angle axis. Ideal geometry puts
an α-helix CB near 40°, which would make this a rare edge case — but that is a
derivation, not a measurement.

---

## 9. Claims that did not survive re-measurement

An earlier draft of this document reported a landed fix — "surface-aware exit
anchoring" — with a table showing the reported view going 194 wrong pixels to 0
and ribbon-vs-ribbon dropping 90%, from 13014 to 1339. It is recorded here as a
correction rather than deleted, because the same traps are waiting for the next
person.

**What was actually true.** The core idea was right and is §3.6: use the sign of
`rollN[2]` — which side of the ribbon the side chain leaves through — instead of
a depth comparison. It survives, in `stash@{0}`.

**What did not.**

- **"Ribbon-vs-ribbon down 90%."** A change to how *side-chain* faces are keyed
  cannot move ribbon-against-ribbon ordering at all; those prims are untouched.
  Re-measured, it does not: 10742 → 10753, unchanged within noise.
- **"0 wrong pixels at the reported view."** Measured with a harness that
  expanded ribbon prims through a field the build did not have, so it audited
  **zero ribbon faces** and reported a confident zero for exactly the error it
  was built to detect. Corrected, that view goes 50 → 48 — the rule helps in
  aggregate but barely at that specific angle, because most of the error there
  comes from side chains whose roots face *forward*, which the rule never
  touches.
- **The per-segment taper** (`w = 1 - k/K`) gave sub-segments of ONE bond
  different artificial depths, so a stick sorted against itself: 29 wrong pixels
  at the reported view. `rollN`/`rollP` are only ever set on the root bond, so
  the taper was subdividing within a single stick.
- **The forced `K >= 2`** that existed to give the taper something to taper over
  reached a subdivision path unreachable without twist and threw on a null frame
  at **thickness 0 — the slider's default**. Any structure with side chains was
  a dead viewer.
- **A front-facing push** (`+0.6μ`) appears in that write-up but not in the code.

None of this argues against the approach; §3.6 is the cleaned-up version of it
and is the best result measured. It argues for mutating the renderer and
watching the test fail before believing a number.
