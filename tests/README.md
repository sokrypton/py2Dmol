# Cartoon renderer test pages

Visual test harness for the `style="cartoon"` renderer (`py2Dmol/resources/viewer-cartoon.js`).
These are eyeball tests, not assertions — they exist because the cartoon
failures that matter (paint order, silhouette breaks, tone pops) are things you
see, not things you can easily assert.

```bash
python tests/build.py --serve     # build all pages, serve on http://localhost:8931
python tests/build.py             # build only, into tests/out/
```

Needs `numpy` and `ipython` (py2Dmol imports IPython at module load), so run it
from an environment that has them — a bare system `python3` will fail on
`ModuleNotFoundError: No module named 'IPython'`.

Each page inlines the viewer JS at build time, so **rebuild after every edit to
`viewer-*.js`** — a stale page is indistinguishable from a fix that did nothing.
`build.py` runs against the working tree (it puts the repo root on `sys.path`),
so it picks up `viewer-cartoon.js` directly; the `.min.js` bundle is only used
by the packaged Python path.

| Page | What it isolates |
| --- | --- |
| `box_test.html` | Slab ladder: one box (2 res), a straight beam (4 res, tests joints without curvature), a minimal 3-residue curve, and a 6-residue helix piece. Forces secondary structure via `renderer._forceSec`, so it exercises slab geometry with nothing else in the scene. |
| `helix_big.html` | Ideal 12-residue alpha helix. Smallest case that shows a full winding. |
| `helix_test.html` | Ideal 30-residue alpha helix on a 900px canvas. The main case for thickness-band paint order — the ribbon twists ~100°/residue, so every winding sweeps the width normal through the viewer. |
| `cartoon_test.html` | Real structures (1YNE, 1UBQ, 1BJP) with ribbon and cartoon side by side. Fetches from RCSB on first run. |
| `na_test.html` | Nucleic acids: B-DNA duplex, tRNA, nucleosome, poly(A)·poly(U), a modified-base complex. Base-pair plates and backbone frames. |
| `ligand_test.html` | Ligand occlusion (4HHB, 3PTB, 1HVR). Generic segments are painted as opaque strokes but are easy to leave out of the ink pass's occluder set, which shows as the backbone outline drawing straight through a ligand. |
| `richardson_test.html` | Richardson preset beside the plain cartoon on four SS compositions (3CHY, 1TIM, 2POR, 1BBH). 1TIM is the control — it is the subject of the original drawing. |
| `ribosome.html` | 4UG0, the large-structure performance case (17,789 positions). Built separately: `python tests/make_ribosome.py`. |

## Assertions — `smoke.js` / `interaction.js`

Unlike the pages above, these assert, and need no browser:

    node tests/smoke.js                                          # source
    node tests/smoke.js py2Dmol/resources/viewer-cartoon.min.js  # bundle
    node tests/interaction.js

`smoke.js` renders synthetic structures through a mock 2D context and checks
properties of what gets painted: closed solids, no inked edge crossing its own
face, junction construction, side chains following a flattened backbone, and
the flat-slab and gesture-budget rules. Run it against the bundle too — a
mangler can break what the source proves.
`interaction.js` runs the gesture and animation predicates from `viewer-mol.js`
against a mock canvas, plus `_materialiseSidechains`, side-chain picking, and
orient's centre/extent arithmetic from `web/app.js` — all lifted out of the
source text rather than reimplemented.

Orient's floor is worth knowing about: a single position has extent **0**, which
is falsy, so the branch that sets the target centre was skipped and orienting on
one residue silently did nothing. The extent is floored at 8 Å — a residue's own
reach, an arginine's tip sitting ~7 Å from its CA — so one residue frames itself
and its side chain rather than asking for a magnification nothing is legible at.
Anything bigger clears the floor on its own and is untouched.

## Side chains — `sidechain_chain.js`

    node tests/sidechain_chain.js            # every .cif in the repo root
    node tests/sidechain_chain.js 6MRR.cif

Off by default and per residue: one position per residue is what makes this
renderer fast, so side chains are drawn only where the user asks for them
(index.html, **Side chains** in the selection tools; `objectsData[name].sidechains`,
a Set of position indices, alongside `color` and `sse`).

Four hops, and the test walks all four because the failure was in the middle of
them:

1. **Capture** — `buildSidechainTable` (`web/utils.js`), at load, because that
   is the only moment the atoms exist. **One conformer per residue, the first**:
   a residue modelled in two positions writes each atom twice, and taking both
   gives a side chain with two of every atom, bonded to each other by the
   distance rule into a tangle that is not any real conformer. First-wins by
   atom *name* rather than by reading the alt-loc column — it needs nothing from
   the parser and it matches what the backbone already does (`residue.caAtom` is
   the first CA seen), so the side chain comes from the same conformer as the
   position it hangs off. 3CHY, 6MRR, 2POR and 9FOG all carry alternates, so the
   corpus run covers this on real data.

   **Bonds come from the chemistry, not the coordinates.** A side chain's
   connectivity is a property of the amino acid, so `PROTEIN_SIDECHAIN_BONDS`
   names the real bonds for the 20 standard residues (plus MSE), and
   `SIDECHAIN_ATOM_ALIASES` covers the names that moved between PDB v2 and v3 —
   isoleucine's terminal carbon is `CD` in v2 and `CD1` in v3. Symmetric pairs
   that merely swap between files (ASP `OD1`/`OD2`, PHE `CD1`/`CD2`) need no
   alias: both bond to the same parent, so which is which changes nothing.

   The distance rule survives only as a **fallback** for residues not in the
   table. It could not be the primary: measured over 25,946 atoms,
   over-coordination stays flat to a 2.10 Å cutoff then breaks sharply — 3 at
   1.90, 6 at 2.10, **109 at 2.20**, 3004 at 2.40 — while 4HHB has *real* bonds
   out at 2.2 Å and one arginine `NE`–`CZ` at 2.97 Å. No single threshold
   separates those. Where the fallback does run, a still-detached fragment is
   offered one shortest link (≤2.35 Å) before being dropped; where the table
   runs there is no repair, because a gap there means an atom the file never
   modelled and bridging it would draw a bond that does not exist.

   Four checks per structure, each catching a different failure: **the bonds
   equal the table exactly** (that the table is applied, and that aliases fire),
   **no over-coordinated atom**, **no more than 0.2% of atoms dropped** (0.00%
   today), and globally **under 1% of bonds longer than 2.0 Å** (0.088% today).
   That last one is the only *independent* evidence the table is chemically
   right — everything else compares the code against the same table it is
   testing. Adding a bogus `SER CA–OG` moves it to 1.35% and fails.

   The alias map needed a fixture of its own: every structure here is modern
   mmCIF, so deleting the ILE alias changed nothing and nothing noticed. The
   test now renames `CD1`→`CD` in 1UBQ's isoleucines and asserts the atom count
   is unchanged.

   **The PDB path was never exercised either** — every structure in the repo is
   mmCIF, so the whole capture only ever ran through `parseCIF`. The test now
   writes 1UBQ and 4HHB out as PDB, parses them with `parsePDB`, and requires
   the side-chain tables to match atom for atom and bond for bond. Twice each,
   with and without the element column: columns 77-78 of an ATOM record are
   optional and older files leave them blank, so **hydrogens are identified by
   name when the column is silent** (`H…`, and v2's count-first `1HB`). Standard
   residues shrugged that off on their own — the connectivity table never names
   a hydrogen, so one attaches to nothing and is dropped — but the distance
   fallback bonded and drew them. No hydrogens are drawn in either path.

   Also: the frame arrays keep one CA per residue
   and the file text is not retained. Stored **as coefficients in each residue's
   backbone frame**, never as world coordinates, using the renderer's own
   exported `localFrame` so capture and reconstruction cannot drift apart.
2. **Carry** — frames are built field by field, so anything not named is
   dropped in silence. This has happened twice: `web/app.js`'s `frameObj` (side
   chains captured, stored, copied past, never reaching the renderer — reported
   as *"No side-chain atoms in this structure"* on 6MRR, which has 354) and
   `viewer-mol.js`'s `extractedFrame` (a copied sub-structure with none at all).
   Neither failed loudly; both just produced a structure that had none. The test
   lifts `frameObj` out of `app.js` and *executes* it, and checks both literals
   by name — a rename fails the test rather than quietly stopping covering
   anything.

   A copy also has to **renumber**: the table is keyed by position index.
   `_remapSidechains` rewrites it, keeping a row only when both its residue and
   its anchor survive — the coefficients live in the anchor's frame, so without
   that residue there is no frame to rebuild them in. A residue on the edge of a
   selection can therefore come across without its side chain, which is honest;
   re-anchoring to a frame the coefficients were never measured against would
   point it somewhere arbitrary.
3. **Materialise** — `_materialiseSidechains` (`viewer-mol.js`) turns the
   switched-on residues into ordinary `'L'` positions with explicit bonds, i.e.
   into a ligand. Both styles then draw them, depth-sort them and pick them with
   no new code — but a side chain is **not** a ligand for *width*:
   `TYPE_BASELINES['L']` is a deliberately thin 0.4, since a ligand is a guest
   that should not out-weigh the chain it sits in, and at that weight a side
   chain came out as a hairline hanging off a full-width backbone. That is what
   "side chains do not work in tube mode" looked like — they were drawn all
   along, just too faint to read. They also **cast no shadow on the backbone**
   (`_shadowPairExcluded`): a thin stick sitting right against the chain would
   print a hard little shadow on it, and the eye reads that as the backbone
   being dented rather than the side chain being in front. The backbone still
   shades *them*, which is the direction that carries depth. Contacts were
   already excluded the same way and for the same reason — they are drawn on
   the structure rather than being part of it — and the two rules now share one
   copy instead of a duplicated test at each of the two call sites.
   In the **cartoon** they are ligand sticks, and a stick leaves through the
   ribbon's *face* rather than out of its middle — the same construction a base
   plate uses, and for the same reason: *"a rung runs from its own ribbon's FACE
   to the centre of the pair, so it never crosses either backbone it connects"*.
   Starting at the CA put the stick inside the slab, the two solids
   interpenetrated, and no paint order was right for both — seen along a sheet
   the side chains printed over the backbone. Which of the two faces is chosen
   by where the side chain actually is; a fixed sign sends half of them out
   through the back. The offset is the slab's half-thickness and no more, so the
   box straddles the surface and the joint looks attached; the overlap costs
   nothing, since the hidden-line pass removes whatever ends up inside.

   **The bond keeps its own axis; the backbone cuts it.** An earlier version
   moved this end out to the surface, which is a shift along the face normal —
   *sideways to the bond* — so the stick stopped being collinear with the CA–CB
   bond it represents and leant off it by the slab's half-thickness. What
   happens physically is that the bond runs all the way to the CA and the slab
   takes a slice off the end, so only the cutting plane is recorded and the end
   point stays where the atom is. Where the slice falls then depends on the
   thickness, which is right — a thicker ribbon swallows more of the bond.
   Measured: the cut walks **0.06 → 0.77 Å** along a 1.9 Å bond as thickness
   goes 0.3 → 1.2, staying exactly in-plane throughout. Both halves are
   asserted: a version that moves the endpoint instead passes the in-plane check
   and fails the thickness one.

   And neither of those is enough while the joint still has a **lid**. The CA
   end is the first bond of its run, so the cap logic counted it as an open end
   and painted the cross-section — a square face with its own silhouette, drawn
   on top of the surface the stick had just been placed and rolled onto. It is
   buried in the ribbon, so it is now flagged buried, exactly like the internal
   joints that flag already covers. Its test points the side chain **away** from
   the viewer on purpose: that turns the start cap toward the viewer, which is
   the only case where it is drawn at all — pointing it forward, backface
   culling removes it anyway and the test would pass without testing anything.

   The last piece is the cap's **corners**. A stick's end section is
   perpendicular to the *stick*, which where it meets the ribbon is the wrong
   plane: unless the side chain leaves exactly along the face normal, that cap
   digs into the surface on one side and lifts off it on the other, and no
   amount of placing or rolling makes the edge sit flat. What lies flat is a
   section in the *ribbon's* plane, so the four corners are slid along the bond
   until they reach it — an oblique cut, the same thing a mitred junction does
   to a leg. Corner spread along the face normal: **0.31 Å → 0.000**.

   **Which surface it leaves through.** A slab is not a plane: it has two
   *faces* at the half-thickness and two *sides* at the half-width, and a side
   chain leaves through whichever one it points at. Cutting every stick against
   the face is very nearly right and catastrophically wrong in the gap. Over
   21,274 CA–CB bonds, residues leaving edge-on (>80° from the face normal):

   | helix | strand | coil |
   |---|---|---|
   | 0 of 7,607 | 2 of 4,581 | **9.5%**, min 0.0004 |

   A helix and a strand *fix* the ribbon's roll, so their side chains genuinely
   come out of the faces. A loop's roll is a free choice made for smoothness, so
   the side chain points wherever it likes relative to it. Edge-on, the corner
   slide `(offset)/(d·n)` runs away — measured at **0.37/|d·n| Å**, which at the
   observed minimum is **1009 Å**. Those were long lines drawn across the
   structure, reported on Q5VSL9 and reproducible on 1TIM.

   The fix is a **ray/slab exit**: run out from the CA along the bond and take
   whichever surface it reaches first, `halfT/|d·n|` against `halfW/|d·s|`.
   Worst corner travel over the corpus goes **236.6 Å → 1.0 Å**, zero boxes over
   5 Å at any thickness.

   Two wrong answers were measured before that one, and both are pinned by the
   test because both look plausible:

   * **Turn the ribbon to face the side chain.** Since side chains are captured
     for every residue, CB is available — but the CB axis swings a median
     **57°** (p90 83°) between consecutive loop residues against **18°** for the
     frame in use. The ribbon would tumble through every loop. Its job is to be
     smooth; reading the right surface off it costs it nothing.
   * **Take the better-*conditioned* plane** — the one the bond meets most
     squarely. This fixes the runaway and breaks helices: a helix ribbon is ~3×
     wider than thick and its side chains leave at a median 50° to the face
     normal, so `|d·s|` routinely beats `|d·n|` on a bond that plainly exits the
     *face*. Cutting those against the side moves the joint out to the ribbon's
     edge and the flush contact is gone — which is what it looked like on
     screen. The exit test weighs the angle against how far each surface
     actually is, and puts **99.7–100%** of helix residues back on the face.

   **No angle cutoff** survives from the earlier version — there was a 0.35
   floor on `|axis·normal|`, and the sliver it feared is now prevented by
   picking the right surface rather than by refusing to cut. What remains is a
   divide-by-zero guard plus one backstop expressed in the quantity that
   actually breaks: **no corner may travel past the bond it is cutting**. It
   catches the residual case where the bond runs along the *chain* and meets
   neither surface squarely. There, and only there, the cut is declined and the
   cap suppressed; everywhere else the cap lies *in* the ribbon and is drawn,
   because it is the square on the backbone and dropping it leaves the box open.

   A known, accepted cosmetic limit: the joint lands at a median 0.40 and p90
   **0.85** of the way to its surface's edge, and a loop is only 0.42 Å
   half-wide against the stick's 0.25 Å half-width — so on a loop the stick
   overhangs by ~0.19 Å at p90. Containing it fully would need loops as wide as
   helices (1.67 Å), so it stays.

   **Contacts meet the ribbon the same way, but flat.** A contact is stored
   between two residues, so it was drawn CA to CA — and a CA is the *centre* of
   the slab, so both ends began buried in the ribbon they point at. Identical
   fault, identical symptom: the line and the slab interpenetrate, no paint
   order is right for both, and the contact reads as passing *through* the
   backbone rather than touching it.

   A side chain fixes this by having the slab cut its end square. A contact is
   drawn **flat** — one stroke, no box, no end face — so there is nothing to cut
   and nothing to make flush. It is **trimmed along its own axis** instead,
   which moves two points, adds no geometry, and cannot tilt the line off the
   two residues it names. `ribbonSlabAt` is shared by both paths so the frame is
   built once.

   The exit uses **all three axes**, unlike the side-chain case. A CA–CB bond
   never runs along the chain, but a contact between *i* and *i+4* in a helix
   very nearly does, and then it meets neither face nor side squarely and both
   distances run away; the residue's own half-step bounds it, so the line leaves
   through the end of this residue's slice of ribbon.

   That half-step is taken from the **nearer neighbour**, capped at
   `SS.chainMax / 2`. The obvious source — the `pB − pA` span already in hand —
   is wrong at a chain break, where one "neighbour" is not one: the span reads
   tens of Ångström and the trim reached **10.4 Å**, starting the contact well
   outside the ribbon. Measured over 3,907 contacts, before → after:

   | | median | p90 | p99 | max |
   |---|---|---|---|---|
   | trim per end (Å) | 0.98 | 1.62 → 1.90 | 1.89 → 2.11 | **10.42 → 2.76** |

   Both trims together take a median 28% of the line; the guard that stops them
   eating it (they are scaled back together past 80%) fires **0 of 3,907**. Exit
   surface at the default thickness: face 3,725, side 3,335, end-of-slice 754.

   **The stroke has width**, so putting its centre on the surface still leaves
   one edge of the end buried and the other short of it wherever the line
   arrives obliquely. A face exit is pushed out by a further
   `halfWidth / tan(angle)` — the flat-stroke equivalent of the oblique end face
   a side chain's box gets cut. Straight out of the face that term is zero and
   nothing moves; at 50° it is most of an Ångström.

   **Faces only**, and the cot is capped at `CONTACT_FLUSH_MAX_COT` = 2.0
   (26.6° to the surface), past which a flat end is a long ellipse no single
   push along the axis can seat. The stroke is treated as *round* rather than as
   a screen-facing ribbon: which way its width lies depends on the camera, and a
   trim that changed as you rotated would be worse than a slightly generous one.

   What the push costs, same 3,907 contacts, without → with:

   | | median | p90 | max |
   |---|---|---|---|
   | trim per end (Å) | 0.98 → 1.35 | 1.90 → 2.30 | 2.76 → 3.54 |
   | both trims / length | 0.28 → 0.38 | 0.53 → 0.58 | 0.65 → 0.93 |
   | hits the 80% guard | 0 → 33 | | (0.84%) |

   The push itself is a median 0.68 Å over the 3,725 face exits, capped at 1.18.

   Its test mutates six ways — no trim, a constant inset, trimming a ligand end
   that has no ribbon, moving the end sideways instead of along the axis, no
   width push, and a push applied to every surface — and all six fail. Two are
   load-bearing and nothing else catches them: *a thicker ribbon must trim more*
   (a constant inset passes everything else), and the **edge** ratio, checked as
   72° against 90° so the ribbon's half-width cancels and the expectation
   carries no shipped constant.

   Three measurement traps here, all of which produced a passing test that
   checked nothing:

   * a side chain aimed at a *guessed* normal leaves nearly along the surface,
     so the cut has almost no effect and the numbers match with and without it.
     The test runs **two passes**, the first only to read the ribbon's frame.
   * a prim's own corners are **projected** — screen pixels. Comparing them to
     an Ångström position reads ~379 "Å" at every angle, normal ones included,
     which looks exactly like a blow-up and is really the canvas. World-space
     corners come from `_stickProbe`. That false reading then produced a *second*
     wrong conclusion — a distance bound was removed as never-firing, on a
     follow-up measurement reporting the cut "well behaved down to
     `|axis·normal|` = 0.002". The real law is 0.37/|d·n| Å, so 0.002 is 185 Å;
     the measurement had sampled bonds whose offset happened to be tiny. A
     travel bound is back.
   * a side-plane cut and a *declined* cut both leave the end square's normal
     along the bond, so asserting on that **direction** cannot tell the fix from
     either bug. The first draft of the surface test passed under all three
     mutations for this reason. The square's perpendicular **offset** separates
     them: at the half-thickness (face), at the half-width (side), or on the CA
     itself (declined, drawn perpendicular).

   Stick thickness **caps at `LIGAND_TH_MAX` = 0.5 Å**. A stick is 0.3 Å wide,
   so past that it stops reading as a stick and becomes a square rod as deep as
   it is wide, while the ribbon is still thickening usefully. The control still
   reaches them below the cap — a flat preset must still flatten them — and the
   backbone carries on past it. `SIDECHAIN_WIDTH` is 0.5 — heavier than a
   ligand, lighter than the chain they hang off — stated on the same scale as
   `TYPE_BASELINES` rather than as a multiplier on the ligand's 0.4, so retuning
   the ligand width cannot silently drag side chains with it. They are **appended, never inserted**, so every position index
   already in use — selections, colour and sse overrides, PAE rows, the sequence
   strip — keeps its meaning.

   Appending has three consequences that are invisible from everywhere except
   the screen, and each one shipped as a bug before it was covered:
   - the visibility set is *not* empty in the default "show everything" mode —
     it is filled with every index that existed at the time, so the new atoms
     have to be added to it or they are built, sorted, and then filtered out;
   - the segment cache keys on frame and object name, neither of which moves
     when a side chain is toggled, so it has to be invalidated by hand;
   - **every per-position array has to grow together.** `setCoords` feeds
     `plddts`, `chains`, `position_types`, `position_names` and
     `residue_numbers` through `_setDataField`, which *silently* replaces an
     array whose length does not match the coordinate count with a default —
     no warning, no error. Missing `plddts` that way filled every position with
     50, the low-confidence band, and an AlphaFold model turned entirely red the
     moment a side chain was shown. Adding a sixth array to `_setDataField`
     means adding it to `_materialiseSidechains` too;
   - **`setCoords` persists the bond list onto the object**
     (`objectsData[name].bonds = bonds`) and `_loadFrameData` reads it back, so
     a pass that appends to whatever it is handed appends to the *previous*
     pass's list. Hiding leaves those bonds behind harmlessly — they are out of
     range and skipped — and showing again brings them back into range pointing
     at **different** atoms. That was the show/hide/show corruption. The strip
     is exact rather than a guess: a frame's own bonds cannot reference a
     position the frame does not have, so anything touching an index at or past
     the base count came from a previous pass.
4. **Leave them alone** — the cartoon moves its backbone after that (sheet
   projection, flattening) and side chains deliberately do **not** follow.
   Flattening takes the pleat out of a strand so the ribbon reads cleanly, but
   the pleat decides which *face* of the sheet each side chain points at, and
   consecutive residues alternate. Rebuilding a side chain in the flattened
   frame turns it away from where the molecule puts it: measured on 1TIM, a
   median of **73°** and a maximum of **154°** — side chains on the wrong face.
   The cost of not following is a visible offset between a flattened strand and
   its side chains, the flattening distance itself, median 1.2 Å and at most
   2.1 Å. The ribbon is an abstraction and can be idealised; the atoms are the
   measurement and cannot. Nothing outside a strand moves either way.

Capture round-trips to 3e-7 Å.

**Being ligand positions is an implementation detail, and must not leak into
what a click means.** `pickGroupAt` maps a side-chain atom back to its residue,
so clicking a leucine's side chain selects the leucine and the sequence strip
highlights it — falling through to the ligand branch would select loose atoms,
which have no row in the strip, and the click would appear to do nothing.
Highlighting goes the other way through `selectionInk()`: `residueSelection`
stays residues only (the strip maps its entries to rows, the tools act on them
one residue at a time, and the side-chain toggle asks whether its own set
contains them), and both styles ink from the expanded set instead, so a residue
and the sticks growing out of it are outlined as one thing however the selection
was made. `interaction.js` covers both directions.

Cost: `convertParsedToFrameData` 0.8 → 1.4 ms on 1TIM, a 57 KB table beside a
12 KB coordinate array. Nothing reads it until a residue is switched on.

**Saved sessions carry the WHOLE table**, not just the residues that were
showing. Storing only those made a smaller file and a session you could not
change your mind in: reload it and no other residue could ever be turned on,
because its atoms were never written down and the file they came from is gone.
Being able to enable one later is most of the point of the control.

Trimmed instead, by `trimSidechainTable`: `names` and `elements` are dropped —
nothing reads them to *draw*, they exist so the connectivity table can be
applied at capture, which has already happened — and coefficients round to
0.01 Å, far finer than a side chain drawn a few pixels wide. That takes 1TIM's
table from 145 KB to **56 KB**, against 11 KB of coordinates, per frame. That
ratio is the price of the feature. `reviveSidechainTable` puts the numeric
columns back into typed arrays on load, and
`objectsData[name].sidechains` / `.sidechainColor` go alongside.

The CA is **not** in the table. It is already a drawn position, so a copy would
put two coincident positions on top of each other — a fifth of the table, 534 of
2618 atoms on 4HHB — with the CA–CB bond drawn to the duplicate rather than to
the backbone. The atoms that bond to it are listed in `toBackbone` and joined to
the owning position itself.

**Colour** is keyed by RESIDUE (`objectsData[name].sidechainColor`), never by
atom: side-chain atoms are positions only while they are drawn and their indices
are reissued whenever the set changes, so a colour stored against one would come
back on another. Unset means *follow the residue*, so recolouring a main chain
carries its side chains with it unless they were given a colour of their own —
`getColorOverride` and `getAtomColor` both resolve through the owner.

## Debug knobs

The renderer reads several overrides off the renderer instance, all settable
from the console (`window.py2dmol_viewers[id].renderer`):

| Knob | Default | Effect |
| --- | --- | --- |
| `_forceSec` | — | Force a secondary-structure string (`'HHHH'`) instead of assigning from geometry |
| `_cullEps` | `0.12` | Backface-cull margin; raise to see surfaces that are normally culled |
| `_capT` | `0.85` | Threshold for filling the interior cross-section cap |
| `_innerShade` | `0.22` | Depth of the concave-side shadow on wide faces |
| `_quality` | `'perfect'` | `'fast'` selects the cheap painter ink. There is no automatic gesture downgrade: it changed the drawing mid-drag and snapped back on release, which reads as the render breaking |
| `_inkMode` | `'grid'` | `'zbuf'` swaps the exact analytic hidden-line test for a depth buffer — faster, but flickers (see PERF_NOTES) |
| `_loopFrame` | transport | `'curvature'` restores the old loop frame (visibly more twist) |
| `_cuts` | `'quarter'` | `'half'` / `'none'` reduce depth-sort granularity |
| `_phase` | — | Set to `{}` before a render to collect build/sort/paint and ink sub-stage timings |
| `_posProbe` / `_sideProbe` / `_arrowProbe` / `_inkTrace` | — | Set to `null` (or `[]` for the traces) before a render to collect drawn positions, frame vectors, arrowhead geometry, or per-segment ink visibility |
| `_primProbe` | — | Set to `null` before a render to collect the primitive list. Each carries `gs0`/`gsStep` — its position along the backbone in residues — which is what makes a colour boundary measurable in residue units rather than pixels |

## Selection feedback

The selection used to be inked into the primitives and depth-sorted with them,
which meant a selected residue on the far side of the molecule was covered by
everything in front of it — exactly the case you need it for. It is now painted
as a **translucent yellow band over the finished frame** (`_paintSelectionHalo`,
`viewer-mol.js`) and is never occluded.

Drawn *inside* the render rather than on the sequence viewer's DOM overlay,
which was the other candidate: that overlay is a separate canvas, skipped during
drags, has to be kept in size-sync with the main one, and is not part of a saved
image. One composited pass at the end gives the live view, gestures and exports
the same answer.

**The band follows what is actually connected**, and the two parts differ. A
backbone is a linear chain, so consecutive residues of the same chain join up —
never across a gap in the selection or a chain boundary. A **side chain is a
tree**: a leucine branches at CG, and its atoms are appended positions whose
index order says nothing about which are bonded. Joining those by index would
draw a CD1–CD2 bond that does not exist and run a band from the last atom of one
residue's side chain into the next through empty space, so side-chain atoms are
joined along their **bonds** — the same connectivity the sticks are drawn from.

**One path, stroked once.** A translucent colour composites per draw call, so
anything drawn twice darkens where it overlaps: a selected stretch would come
out banded light and dark residue by residue and every branch point would show
as a blot. That is also why an isolated atom is a zero-length segment rather
than a filled arc — with a round cap it draws the same circle, but inside the
same path and the same single stroke.

A residue not projected this frame draws nothing. Colour and width are
`SELECTION_HALO_CSS` / `SELECTION_HALO_PX`.

**Live during a drag.** A sequence drag only commits on mouseup, so the band
used to sit still until you let go. Committing on every mousemove is not the
fix — that is a full re-render of the molecule per pointer event, fine on a
peptide and hopeless on a ribosome. The molecule does not change during such a
drag, only which residues are marked, so `beginSelectionPreview` snapshots the
finished frame once and each `updateSelectionPreview` is that image blitted back
plus one halo pass: **cost independent of structure size**. Any real render
calls `_invalidateSelectionPreview`, so a rotation or frame step mid-drag cannot
leave a stale picture behind. `setLocalPreview` in `viewer-seq.js` is the single
funnel every drag path goes through — residues, chains and touch — so it is
hooked once there.

## Click-selection

Off in the renderer by default, turned on by `web/app.js`. The Python path loads
`viewer-mol.js` and the cartoon plugin and nothing else — no sequence strip, no
selection panel — so a click there changed a selection with no way to see it,
act on it, or clear it except by clicking the background again. Selection is
done in Python by scripting, which does not go through the mouse. The switch is
owned by whoever can actually show the result.

Both entry points are gated: the double-click chain-select and the mouse-up
pick. The test anchors on the code that *mutates* the selection rather than on
the listener registration — there is more than one `mouseup` listener, so
searching for the registration found the wrong one and passed with the real
handler ungated.

## Saved state

Two writers, one format. Both sides wrote `"version": "2.0"` while disagreeing
about what was in it — `py2Dmol/viewer.py` wrote `current_object`, the web wrote
`viewer_state` and `selections_by_object`, and neither read the other's — so a
file saved by one opened in the other with its settings quietly reset. The
envelope is the union now, and each side reads what it understands.
`selections_by_object` stays web-only: Python has no selection model.

**The config was written stale.** `window.viewerConfig` holds the values the
viewer *started* with, so saving it verbatim put a stale copy of every render
setting beside the live one — a session showing a cartoon recorded
`config.rendering.style: "tube"` next to `viewer_state.style: "cartoon"`, which
reads as a bug in the file and is the first thing anyone opening it notices. It
cannot simply be dropped: `viewer.py` does `self.config = state_data["config"]`
when it loads a state, so a session opened in Python takes its whole
configuration from there. The two are made to **agree** instead — one set of
values written twice for two readers, rather than two sets that disagree — and
Python now prefers `viewer_state` where it says anything, so an older file still
comes back on what it was showing.

The camera stays asymmetric and that is not a bug: `DEFAULT_CONFIG` has no
rotation or zoom, so Python has none to record. What it can supply is the render
settings, which is what stops a Python-saved session opening as a grey tube.

## Contacts

Already existed on the object as `contacts`, already saved and restored; the
renderer turns each entry into a segment of type `'C'`. The GUI now writes them:
select **exactly two** residues and a Contact row appears with a colour, a width
and **+** / **−**. Those glyphs, and the swatch buttons, carry no text, so each
needs an explicit `aria-label` — a lone `+` names no action, and `title` is only
a fallback for an accessible name. `interaction.js` checks every one of them. A contact is a line between a pair, so the row is not offered for one
residue or for five.

Written in the **chain + residue** form, `[chain1, res1, chain2, res2, weight,
color?]`, not as position indices — indices belong to the current frame's arrays
and a copied sub-structure renumbers them, while a chain and residue number name
the same pair whatever happens to the arrays. Colour is stored as an `{r,g,b}`
object, which is what the segment builder reads through as `contactColor`;
clearing it drops back to the default yellow rather than removing the contact.

**Both stored forms are read.** `parseContactsFile` writes the same entries the
panel does, and it has two: `A 10 B 50 0.5` and the bare-index `10 50 0.5`. The
panel understood only the first, so a contacts file written in indices was
invisible to it — clicking the pair offered Add and made a duplicate, while
Remove, colour and width all failed to find it. It still *writes* the chain
form, which survives renumbering; it just reads both. The weight and colour sit
at different slots in the two forms (`4`/`5` against `2`/`3`), so `contactSlots`
answers that rather than each setter assuming.

A contact has no direction, so the reversed pair is the same contact — matching
both ways is what stops a second Add duplicating one, and what lets Remove find
it whichever order the two were picked in. Add and Remove are each offered only
when they would do something, which between them also says whether the pair is
already joined.

**Width is per contact, and the Line Width control does not reach it.** That
control sets how heavy the *backbone* is drawn; a contact is an annotation over
the structure rather than part of it, and one that grew and shrank with the
backbone stopped reading as a separate mark — the same reason a ligand keeps its
own, and **the same width in both styles** — `CONTACT_WIDTH` in
`viewer-cartoon.js` and `CONTACT_WIDTH_A` in `viewer-mol.js`, which
`interaction.js` checks against each other, since a contact that changes weight
when you switch style is the one thing this exists to stop. The value is **half** what
tube used to draw at its widest: the Line Width slider tops out at 4.7,
`TYPE_BASELINES` gives a contact half of that (2.35), and half again is 1.175.
That is what a weight of 1.0 means — full width for a contact — and the
per-contact slider only takes it down from there. Tube divides it back out
of the Line Width the caller multiplies by, which is how the control stops
reaching it there too.

It is **in Ångström**, like every other width here. That last
part matters: these are all `something * scale` with scale in pixels per
Ångström, and substituting a bare constant for `baseLineWidthPixels` drops the
conversion, leaving the contact a couple of *raw* pixels wide at any zoom. That
is what "too thin even at maximum" looked like — 2.5 px at zoom 1, 2 and 4
alike, against 15 px doubling with zoom once fixed. For reference the ribbon's
own half-widths (`SS_HALF_A`) are 0.42 Å for a loop and 1.3 for a helix. What sizes an individual
contact is the `weight` slot its stored entry already had, which the renderer
was already scaling the stroke by; the panel just exposes it as a narrow slider,
after the colour and the +/− button.

**Full width is the maximum.** The slider runs 0.15–1, so it only takes a
contact *down* from the width it is drawn at rather than letting it grow past
it — an annotation that can outweigh the structure it annotates is not useful.
`CONTACT_WIDTH` is what 1 means.

**Cut into pieces for depth, in the cartoon only.** A contact joins two
residues anywhere in the structure, so as one prim it carries a single depth key
across the whole span and sorts as though it were all at its midpoint — passing
in front of what it should go behind and behind what it should cross in front
of. Same reason a base plate is cut: *"as one quad a rung carries a single sort
key across ~7 Å"*, and a contact reaches much further. Measured on a contact
running through the backbone from +14 to −14: as one prim, **50%** of it sorts
on the wrong side; cut at `CONTACT_SEG_A` = 2 Å (capped at 24 pieces), **2%** —
the piece at the crossing. Stations are interpolated in 3D and projected one by
one, not interpolated on screen: under perspective those are different curves,
and depth is the whole point. The tube path is untouched and still draws one
stroke.

**And it sorts by its near surface, not its centre line.** A contact is drawn as
a line but stands for something with thickness, and the case that matters is one
joining two parts at the *same* depth — two strands of a flat sheet above all —
where the centre lines coincide and the order is a coin toss. It is keyed
`CONTACT_TUBE_R` nearer, **unless the ribbon is thicker**: a slab has a near
surface too, and once it stands proud of the contact's it genuinely is in front
and should cover it. So the bias is the difference of the two radii, clamped at
zero — never negative, which would push the contact behind where it actually is.
The same bias applies to every piece, so the ordering *along* the contact is
untouched.

No fixture had a contact in it before this, which is how the first version
shipped a crash — `'line'` prims carry `joints`, read by the ink pass to decide
where to cap, and the pieces had none. The slots are POSITIONAL — `[0]` is the start point,
`[1]` the end — and getting that wrong capped the last piece at its *start*,
which is an internal cut and shows as a dark tick across the contact at some
angles. Internal cuts get **no** cap at all: a cap fills the gap an angled joint
leaves, and a contact is a straight line.

**Clicking the contact selects the pair it joins.** `pickResidueAt` already
tested contact segments — it has to, or the line would not be clickable at all —
but it attributes the hit to the nearer *end*, so a click selected one of the
two residues and the fact that it was a contact was discarded. The winning
segment is now recorded and `pickGroupAt` widens it. Only when the contact is
what was actually hit: a click on a residue that happens to end a contact is a
click on the residue, which the existing depth/distance test has already
decided. And it is cleared on every pick — a stale value would widen a *later*
click on an endpoint to a contact the user is no longer pointing at, which takes
some contriving to observe and is why the first version of that test could not
fail.

**Every change RELOADS the frame.** Contacts become segments, and the segment
list — contact block included — is built inside `setCoords`, not inside
`render`. Invalidating the cache and repainting therefore changes nothing at
all: the contact is stored correctly, resolves correctly, and never appears.
That shipped once, and the tests missed it because they checked the two halves
separately — that the GUI writes chain+residue, and that the renderer turns
contacts into segments — without ever checking that one reaches the other. There
is now a test for the write/read round trip and one for the reload.

## Per-residue colour

A colour belongs to a residue, but a ribbon interval spans two, and the two
disagreed about what to do with that. `colors[segIdx]` is `getAtomColor(idx1)` —
a segment takes its **first** residue's colour — so colouring residue 10 painted
10→11 and left 9→10 alone: a band the right width but half a residue late,
sitting *between* residues rather than around the one picked. The ss-palette
path had the opposite fault, taking an override from *either* end, which painted
both neighbouring intervals and made one residue read as two.

Both ends are resolved separately now, and where they differ the interval is cut
at its midpoint so each half takes its own end's colour. Stations are integers,
so an odd subdivision count has none exactly at `u = 0.5` and the boundary lands
on the nearest — measured centre error 0.00 residues at detail 2, 0.17 at
detail 4, 0.10 at detail 8, against a constant **0.50** before.

The whole path is gated on the object actually carrying overrides, so a
structure with none is untouched: the paint stream over 40 structures is
byte-identical to before the change. Tube runs still break at interval
granularity rather than mid-interval — loops are drawn as merged polylines with
one colour each, and splitting those is a separate job.

## Benchmark

    python tests/make_bench.py                 # build tests/out/bench.html
    node tests/bench.js [--quick]              # time every config x length

One viewer per chain length (50 -> 10000 residues) on a synthetic trace.
`bench.js` drives `renderer.render()` directly, so the numbers are the draw
stage only; each cell is a median after warmup. Needs playwright — if it is not
installed in the repo, run with `NODE_PATH=/path/to/node_modules`.

See `PERF_NOTES.md` for the phase breakdown, the cost equation
(`fills ≈ stations × surfaces`), and the optimisations that did NOT work.

## Ligand sticks — `junction_math.py`

    python tests/junction_math.py

A ligand bond is drawn as a box, and the derivation is worked in stages, each
checked numerically. Where bonds meet, the geometry decides between three cases:

* **mitred** — adjacent legs share the corner where their side faces cross, at
  `d = h·cot(θ/2)`, and the polygon left in the middle is filled above and
  below. There is deliberately no coplanarity test: real ligands pucker, and a
  junction that comes out slightly odd beats one that falls apart. Where it
  genuinely cannot be solved the corner determinant goes to zero and it declines
  on its own.
* **swept** — a run of atoms each carrying two sticks (a propionate, a vinyl) is
  one path. Mitring it bond by bond pins the roll to each local plane, and along
  a zig-zag those planes swing. One section per station, shared by both bonds,
  frees the roll: worst twist per bond on a haem 38° -> 18°.
* **overlapping** — anything else. A tetrahedral centre has no plane, so there
  is no above and below to fill; the boxes interpenetrate and the hidden-line
  pass removes what is inside.

An sp3 centre gets a collar instead — see `junction_sp3.py`, which derives it in
the same staged way.

Smoke tests 9-11 are the executable form: no inked edge inside its own box, the
box is closed, and no side goes missing under perspective. Test 11 has to run
with `ortho: 0` — the culling bug it guards lives in a branch the orthographic
default never executes.

## Secondary structure — `ss_bench.py` / `ss_bench.js`

    pip install pydssp
    python tests/ss_bench.py --build     # DSSP ground truth -> tests/out/ss_truth.json
    node tests/ss_bench.js               # Q3 + confusion vs pydssp
    node tests/ss_bench.js --per-chain   # worst chains
    node tests/ss_tune.js                # sweep the thresholds

Scores the renderer's assignment against real DSSP over 151 native chains /
16,749 residues from `natives.zip`. The shipped assignment runs DSSP itself on a
backbone rebuilt from the C-alpha trace; the superseded CA-only pipeline is
scored alongside it, as are the ablations of each choice.

Both sides must see the same residue list — pydssp needs all four backbone
atoms, so residues missing any are dropped and the trace is built from the
survivors. `ss_bench.js` calls the renderer's exported `assignSecondary`, so it
cannot score a stale reimplementation.

Current: **Q3 89.76%** (recall: helix 91.8%, strand 92.6%, coil 86.1%); the
CA-only pipeline scores 85.31%, its strands running about a residue short at
each end. Quote the *shipped* row — the ablations printed below it score higher
on Q3 alone.

## Cyclic peptides — `cyclic_bench.py` / `cyclic_bench.js`

    pip install pydssp
    python tests/cyclic_bench.py --build   # fetch + DSSP -> tests/out/cyclic_truth.json
    node tests/cyclic_bench.js             # overall and seam-only Q3
    node tests/cyclic_bench.js --per-chain # which chains moved

A head-to-tail cyclic peptide has no terminus, but every assigner here walks the
chain by index, so the closure is invisible and an element spanning it is cut in
two. Measured over 24 cyclic chains / 1,079 residues: cyclotides,
theta-defensins, and the AS-48 bacteriocins, whose seam sits mid-helix.

The reference cannot be plain DSSP, which would bake the same bug into the
truth: each chain is assigned under two rotations of its residue order and
merged, keeping every residue from the rotation where it sits furthest from the
artificial break. Read the **seam** column — most of a cyclic peptide is nowhere
near its closure and drowns the effect.

| at 4 residues each side | overall Q3 | seam Q3 |
| --- | --- | --- |
| walked as a linear chain | 82.1% | 51.0% |
| told the run is cyclic | **88.7%** | **87.0%** |

14 of 24 chains improve, none regress. The report also measures the ribbon
frame, where a sign flip at the closure makes the strip cross itself: worst
interval 178° -> **128°**, intervals over 90° 22 -> **1**. The last line is a
control — a ring has no canonical first residue, so cutting it elsewhere must
give the same answer. Currently **63/75 cuts** reproduce exactly.

## Sheet frames — `sheet_bench.py` / `sheet_bench.js`

    python tests/sheet_bench.py --build   # natives.zip -> tests/out/sheet_truth.json
    python tests/sheet_bench.py --fit     # refit PEPTIDE_TABLE, print it
    node tests/sheet_bench.js             # score the strand frames
    node tests/sheet_bench.js --sweep     # try other relaxation settings

`--fit` fits the table the backbone rebuild reads, on half the chains, reporting
the other half: C to 0.21 Å rms, N to 0.17 Å, C=O direction to 8.8°. Paste its
output back into `viewer-cartoon.js` as `PEPTIDE_TABLE`.

`sheet_bench.js` scores strand frames in degrees over real H-bonded ladders:
**partner face** (do neighbouring strands stack edge to edge) and **strand
twist** (how far the face rolls between consecutive residues). Current
**22.2°** and **11.3°**, against 38.8° and 21.3° for the curvature frames these
replaced. Partner face is at its floor — the sheets themselves twist 20°.

## Nucleic base frames — `na_table.py` / `na_bench.js`

    python tests/na_table.py --build   # fetch/parse ~90 structures -> tests/out/na_truth.json
    python tests/na_table.py --fit     # refit NA_BASE_TABLE, print it, score held out
    node tests/na_bench.js             # score the predictor the renderer ships

py2Dmol keeps one atom per nucleotide (the C4'), so where a base points is
predicted from the trace. `--fit` fits on half the chains and reports the other
half; paste its output back as `NA_BASE_TABLE`.

Current: direction **17.5°** median (p90 77°), normal 17.6°, coverage 99.9% of
16,748 nucleotides over 153 chains. The tail is physical, not a fitting limit — a base can sit anti or syn on an
identical backbone — which is why the renderer widens its pairing gate, flips
bases that point away from their partner, and caps the per-residue twist.

`na_bench.py` is the older benchmark of the ribbon face and carries its own
replica of the frame construction, so it can drift from the renderer.

## Nucleic pair axis — `na_axis.js`

    node tests/na_axis.js              # needs tests/out/na_truth.json (above)

Every base plate hangs off one vector, the pair axis: the pair plane is normal
to it, so an axis d degrees wrong tilts the plate by d degrees. Scored against
the true base-plane normals, taking the worse of a pair's two bases.

The report splits stem-interior pairs from stem ends, which is where they
differ: at the end of a helix the fitting window runs off the stem into a loop.
Current, 98 chains / 4697 pairs: **13.0°** median overall, 11.3° interior,
15.6° at the ends.

## Nucleic rail frame — `na_frame.js`

    node tests/na_frame.js                                       # source
    node tests/na_frame.js py2Dmol/resources/viewer-cartoon.min.js

The pair axis above decides where a plate lies; this scores the frame the
backbone rail itself is swept along, read back from `_naFrame` after a render:

* **aim** — angle between the rail's face axis and the direction to its
  pairing partner. A paired residue solves its side against that direction, so
  this is 0 by construction and the row is there to catch it stopping.
* **twist** — signed rotation of the side about the tangent, step to step,
  inside a stem. A duplex really turns, so read the **spread** and the
  reversals: a step that goes backward is the frame jumping, which is what
  reads as a wavy, bumpy duplex.
* **partner** — how far apart the two rails' side vectors sit. Expect ~82°.
  The rails wind at ~59° to the helix axis, so their tangents are nowhere near
  antiparallel and the two sides cannot coincide; what they share is each
  aiming at the other.

Current, 153 chains / 16,748 residues: aim **0.0°**, twist stdev **8.7°** with
**4.1%** reversals, rung turn 46.0° median. Against the frame this replaced:
aim 17.6° median / 49.5° p90, twist stdev 28.9°, reversals 22.2%.

**Run it against the bundle too.** The packaged Python path loads
`viewer-cartoon.min.js`, and a bundle committed without being rebuilt scores
exactly like the code it was meant to replace — which is how a shipped fix
came to be source-only for a day.
