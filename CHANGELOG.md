# Changelog

## 2.0.0

280 commits since `v1.6.5`. The major number is not for the size of it — it is
for the five things below that change what existing code does.

### Breaking

**`position_atoms` is gone.** `add()`, `replace()` and the payload no longer
take or carry a ligand atom's NAME. It was produced by both parsers, copied
through every field-by-field rebuilder and stored on the renderer, and read by
nothing — 2.7 KB a frame on 4HHB, 574 of whose 748 entries were blank, paid
again per frame per viewer in a notebook. `position_elements` stays and now
does two jobs: colour by element, and the per-pair bond thresholds. Passing
`position_atoms=` is now a `TypeError` rather than a silent no-op.

**Biological assemblies are built by default.** `add_pdb`, `from_pdb` and
`from_afdb` all took `use_biounit=False`; they take `use_biounit=True` now, and
the website and the embed do the same. A multimeric entry loads as the multimer
it is. Two consequences worth knowing before you upgrade:

- **The chains are renamed.** `gemmi.make_assembly` renames every chain it
  copies, so chain `A` comes back as `A1 A2 A3`. Any `set_color(..., chain='A')`
  or `add_contacts([['A', 10, 'A', 20, 1.0]])` against such an entry stops
  resolving — silently, because a selector that matches nothing is not an error.
  Pass `use_biounit=False` to keep the deposited chains.
- It is skipped when it would not expand the structure, compared by atom count,
  so a monomer is unaffected.

The reason it was off is that it never worked from an mmCIF:
`extractCIFBiounitOperations` asked the parser for loops without telling it what
to seek, and read the assembly only as a `loop_` when a file with one assembly
writes it as key-value items. The website's Load Biounit box has been ticked all
along and drawing the asymmetric unit.

**`set_color(chain=..., position=...)` together now raises.** It used to colour
the whole chain *and* those positions — a union — while the selector everywhere
else in py2Dmol reads the same pair as an intersection. Rather than let one word
mean two things, the combination is refused by name and the error says which
spelling you want. Either key alone is unchanged.

**Metal coordination is no longer drawn as a bond.** `_struct_conn` carries
`covale`, `disulf`, `hydrog` and `metalc`, and a coordination record is not a
bond: 7P1E declares Ca 506 chelated by both carboxylate oxygens of the ligand
K99, and those two sticks plus the carboxylate's own close a four-ring that
reads as a solid triangle. `metalc` is excluded.

**Lone-atom radii follow PyMOL.** `loneAtomRadiusA` is PyMOL's `ElementTable` —
Bondi where Bondi reaches, 1.80 for everything else. Eight elements change size,
calcium most visibly (2.31 → 1.80).

**`detect_cyclic` is now `cyclic`.** It was the only argument on `view()` named
for an action; everything else there names a state (`box`, `rotate`, `overlay`,
`multi`, `gpu`, `shadow`, `arrows`), and the toggle it drives is labelled
Cyclic. The verb-named family — `use_biounit`, `load_ligands`,
`filter_additives`, `ignore_ligands`, `allow_reflection` — all sit on the
loaders and describe a one-off instruction; this is a live setting. The config
key is `rendering.cyclic` and the checkbox is `#cyclicCheckbox`, with no alias:
a state file written before 2.0.0 loses that one setting on load and the toggle
comes back at its default.

**Some `view()` defaults moved**: `ortho` 1.0 → 0.5, `outline` `"full"` → `None`,
`width` 3.0 → `None` (the style decides). And `best_view`, `kabsch` and
`align_a_to_b` are gone from `py2Dmol.viewer` — the browser chooses the angle
now, so Python sends the *request* (`align`, `allow_reflection`) rather than the
result.

### New

- **`view.show_sidechains()` / `view.hide_sidechains()`** — name the residues
  whose side chains are drawn, with the same selector as `clip` and `focus`.
  Relative, both of them: `show_sidechains(chain="A")` then
  `hide_sidechains(position=45)` is chain A without residue 45, and with
  nothing named either means every residue. Needs `view(sidechains=True)`,
  which is what carries the atoms; without it there is nothing to draw and the
  call says so. The verb itself moved out of `parts/embed.js` into
  `parts/sidechains.js`, so all three shells have it — the embed's JS API could
  draw a side chain and a notebook could not ask at all.
- **`view(style=...)`** — one flat list: `tube`, `richardson`, `ribbon`, `3d`,
  with `preset`, `smooth`, `thickness`, `sheet_flat`, `pencil`, `arrows`,
  `base_plates`, `detail`, `fade`, `highlight`, `outline_tint`, `shade`, `bg`
  and `ss_palette` beside it.
- **`view(gpu=...)`** — WebGL2 by default; `gpu=False` inlines the 2D painter
  instead, which is 46 KB smaller and the only build that can save an SVG. A
  notebook cannot fall back at runtime, so this chooses which bundle is written
  into the cell.
- **One notebook bundle, and `gpu` is a runtime setting again.** There were
  three — WebGL2, 2D, and a cartoon-less tube — because the library is inlined
  into the `.ipynb` once per `show()` cell. Sharing pays it once per document,
  so the notebook now ships both painters for 26 KB more: `gpu=False` reaches
  the 2D painter without a different file, a machine with no WebGL2 has a
  fallback, and **the cartoon can export an SVG from a notebook**. The embeds
  still ship one painter each — they are gzipped over HTTP, a different trade.
- **A PAE travels as base64, and the payload is written without spaces.** A
  PAE is N² numbers and it is inlined into the `.ipynb`: one 837×837 matrix was
  **72% of the demo notebook**. It is stored as a `Uint8Array` at 1/8 Å either
  way — that part is unchanged — but writing it as a JSON list of the scaled
  integers costs three characters and a comma each, where base64 of the same
  bytes costs 1.33. With compact JSON separators beside it (a megabyte of
  numbers was paying one space per element), the demo notebook goes from
  **4.32 MB to 2.03 MB**. Lossless, and `setData` still takes the three forms
  it always did, so an older payload still draws.

    | AF-Q5VSL9, 837×837 | |
    |---|---|
    | list of ints, `", "` separators | 3,048 KB |
    | …compact separators | 2,364 KB |
    | base64 of the bytes | 912 KB |
    | …resampled to the panel's 300px | **120 KB** |

- **A PAE carries no more resolution than the panel can draw.** The plot is an
  n×n image scaled into a canvas of `pae_size` pixels — 300 by default — so
  above that the browser was already throwing the detail away on every frame,
  and an 837-row matrix gave each residue 0.36 of a pixel. Doing the resample
  once, in Python, is the same picture. With the two changes above the demo
  notebook goes **4.32 MB → 1.22 MB**.

    The matrix side and the residue count are two numbers now, and `pae_n`
    carries the second: a box dragged on the plot is a range of *residues*
    handed to `setVisibility`, so it is scaled back out on the way. Selection
    edges on a resampled matrix land on a block of residues rather than one —
    on a plot where a residue was already a third of a pixel.

- **The notebook library is shared between cells where it can be.** Each
  `show()` used to write ~450 KB into its own output, because Colab gives every
  cell output its own iframe — ten viewers was 4.5 MB of `.ipynb`. The first
  viewer of a session now writes it and offers it on a `BroadcastChannel`;
  later ones ask, and keep a copy so they can lend to the next. Two viewers go
  from ~950 KB to ~505; ten from 4.5 MB to ~700 KB.

  There is no flag, and it is always on. In Jupyter every output shares one
  document, so a borrower finds the library already there and the channel is
  never used; in Colab the outputs are separate frames and the channel carries
  it. Eight viewers: **3,872 KB down to 645**.

  Python also pings the page at each `show()`, and a positive answer lets a
  fresh kernel borrow from a page that still has a lender. A negative one is
  ignored — it cannot be told apart from a question that never arrived.

  Re-running the cell that carries the library makes it carry the library
  again. Re-running a cell replaces its output, so the copy went with it while
  the kernel still believed it had lent one — the next viewer asked a lender
  that no longer existed and came up as an error box. A cell that creates
  several viewers is one execution, so a grid still writes the library once.

  The library is offered under a key that includes a **hash of its content**, so
  a cell can only borrow a library that matches the payload it is writing. A
  notebook is re-run cell by cell, and the cell holding the library can be from
  an older build than the cell now asking; today's payload handed to
  yesterday's renderer draws, silently missing whatever the two disagree about.
  A borrower that finds no matching lender inlines its own copy.
- **`view.focus(name=, chain=, position=, cutoff=)`**, a **Focus** button
  beside Style and `v.focus(sel)` on the embed — click a residue or a
  ligand and see what it is doing. Four things at once, each replaced by the
  next call: the residue is selected, the side chains of everything within 5 Å
  are drawn and the last focus's are taken away, the camera moves in, and a
  slab is cut around it. **It does not turn the structure** — only the centre
  and the zoom move, so focusing from one residue to the next walks through a
  structure rather than spinning it, which is the difference between this and
  `orient()`. Every step is an existing verb (`residuesWithin`, the object's
  side-chain set, `autoClip`); `parts/focus.js` is the composition, so all
  three shells get it from one place.

  A click in the **sequence strip** focuses too — it wrote the selection field
  directly and so went past everything hanging off a selection; it uses the
  renderer's setter now, as does Select all.

  The camera **moves over about a third of a second** rather than jumping, and
  clicking the background comes back out — an empty selection is the same
  signal the mode already reads, so the way back needs no second control.

  Side chains in a notebook need `view(sidechains=True)` — see below.
- **`view(sidechains=True)`** — a notebook can draw side chains. The payload
  carried one position per residue and nothing else, so `showSidechains`, the
  side-chain half of Focus, and any side-chain-to-side-chain measurement were
  web-only. Python now sends the raw atoms and the browser builds the table
  with the same code the website uses — `buildSidechainTable`, cut out of
  `src/io/parse.js` into `src/io/sidechains.js` so the notebook can have the
  chemistry (8.7 KB) without the parser (36 KB).

  **Off by default, and the reason is the payload.** Side-chain atoms are
  coordinates, so every frame carries its own: a 251-residue design goes from
  9.0 KB a frame to 37.2 — six frames is 54 KB against 223, and a hundred would
  be 2.8 MB inlined into the `.ipynb`. It is a viewer-wide setting rather than
  a per-load one because the table is per frame with no inheritance; mixing
  would make side chains appear and vanish as you step through frames.
- **`view.clip(name=, chain=, position=)`**, and a Clip button in the notebook
  and embed shells. `parts/clip.js` was in every bundle already — the slab, the
  tracking and the per-frame refit — and only the website could reach any of it.
  The depth is the selection's own depth along the view, so to cut deeper, clip
  to less; `clip()` with nothing turns it off.
- **`view(multi=True)` and `view.show_objects(...)`** — several objects in one
  picture, which is a different question from `overlay=True` (every FRAME of
  one object). The renderer has drawn several at once since the website grew
  its Multi button and the embed has exposed it as `v.showObjects()`; Python
  had no way to ask. `show_objects()` with no argument means every object
  loaded, resolved in Python at the moment of the call.
- **`view.orient(name=, chain=, position=, animate=)`** — turn the camera onto
  a selection. A viewer already does this once, unprompted, when the first
  frame lands; this is for afterwards.
- **`set_sse(sse, name=, chain=, position=)`** — force a region to helix, strand
  or coil, or pass `None` to return it to the automatic assignment.
- **Structural alignment** — TM-align, vendored from foldjs, running in a worker.
- **Cross-object contacts** — a contact whose two ends are in different objects.
- **An embeddable build**: `py2Dmol.embed.min.js` (453 KB, WebGL2) and
  `py2Dmol.embed.cpu.min.js` (414 KB, 2D and SVG-capable), documented by
  `embed.html`, with one selector grammar shared with the Python API.

### Fixed

- **The PAE plot's selection box is drawn where the selection is.** A stored
  box is in residues and the canvas is laid out in cells, and only the mask had
  been converted — the black outline multiplied residue indices by a cell
  width, so on a matrix resampled for the panel (which happens in a notebook,
  above `pae.size`) it framed a region 1.2× out from the region it was
  highlighting. The chain boundary lines had the same fault from the other
  side, walking cells while indexing residues. `render()` converts once and
  hands cells to both.
- **Focus is a mode with one focus at a time.** Four things it got wrong:
  loading a structure, or anything else that emptied the selection, handed the
  Sele dropdown back to Highlight while the Focus button stayed lit; a click in
  the sequence strip ADDED to the focus rather than moving it, so each click
  focused the union and walked the camera to the centroid of everything ever
  clicked; switching objects and coming back parked you at the pocket you had
  focused with nothing marked, since the camera is per object and the selection
  was not; and merging objects left one structure's slab cutting through
  another. Clear All drops the mode too, rather than carrying a snapshot of
  objects that no longer exist into the next structure.
- **Anything that can be set can now be unset.** `set_color(None)`,
  `add_contacts([])` and `add_bonds([])` clear, and for `set_color` the clear
  reaches exactly as far as the selector that set it — the object, one chain,
  some positions, or one frame. Previously `set_color(None)` returned silently
  and `add_contacts([])` warned and refused, so a colour or a contact could be
  put on and never taken off.
- **The live path works in Colab.** Colab renders every cell output in its own
  iframe, so a later `add()` cannot reach the viewer directly and
  `BroadcastChannel` is the only bridge. It does not retain, and there was no
  handshake — `viewerReady` was posted by the viewer and listened for by nobody
  — so on a notebook **reopen** the update cells routinely posted before the
  viewer's channel existed and their frames were lost. They answer the
  announcement now, and because the replay arrives in whatever order the iframes
  ran, the viewer holds it briefly and applies it sorted.
- **`align=True` actually superposes a trajectory loaded with `add()` then
  `show()`.** The fitting moved to the browser, so the payload carries the
  request rather than the result — and `_display_viewer` builds its frames
  field by field and never named it, as did the static loader on the other
  side. Both ends were dropping it, each silently. `show()` then `add()` was
  unaffected, because the live path sends the frame whole. A helix and the same
  helix turned 90 degrees came out 7.07 A apart instead of 0.
- **`set_sse()` and `set_color(frame=N)` reached a live viewer at all.** The
  first was dropped on arrival by a second, drifted copy of the metadata
  applier; the second had no route, because a frame is delivered once.
- **The wheel ships what `viewer.py` opens.** `package_data` omitted the GPU
  renderer, which `viewer.py` reads unconditionally — a `FileNotFoundError` on
  the first `show()`, in the wheel only.
- 🔴 **Orient uses the whole canvas.** The best-view search already reads the
  window's aspect and lays the long axis along the long side; the framing then
  fitted the result into a square of side `min(width, height)`, so a 600×300
  viewer drew an elongated structure across 47% of its width. It now measures
  the shape under the rotation it chose. The same rod fills **94%**; a globular
  structure in the same window goes from ~50% to 99% of its height.

  The framing belongs to that rotation — turning a long structure end-on
  afterwards can push it past the edge, as in PyMOL. Press Orient again to
  reframe.
- 🔴 **An SVG of the tube kept its shading with the GPU on.** The CPU occlusion
  pass is skipped when the GPU is going to draw — it computes its own — but the
  question was asked of the renderer's state rather than of the context, and an
  SVG context is one the GPU refuses. So the export took the 2D path with a
  pass that had been skipped on its behalf, and `gpu` + `tube` + SVG came out
  flat.
- 🔴 **`bg` did nothing whenever `box` was off.** The box is the frame and `bg`
  is the paper: turning the frame off set the canvas background to transparent
  *after* the requested colour had been put on it, and told the renderer to
  clear transparent too. `py2Dmol.grid` defaults `box` to False, so
  `g.view(bg="black")` came out on white. White still means "not asked for" and
  still floats on the page, which is what `box=False` is for; any other colour
  is honoured. **`grid(bg=...)`** is a grid-wide default now, beside `size`,
  `controls` and `box`.
- **No white space under a viewer in Colab.** The stylesheet gave the canvas
  box 600×600 and a script corrected it, so the markup alone was 648px for a
  300px viewer. Colab inserts output HTML with `innerHTML` — which never runs a
  script — and sizes the output iframe from what it measures in that window: a
  2×2 grid of 300px viewers is ~1,220px of unsized markup, and the frame kept
  ~1,000px around a 644px page. The size is in the markup now.
- **A grid emits one output, not twenty-eight.** `Grid.view()` said "do not
  show yourself" by setting `_is_live` — and that flag also means "you are on
  the page, so send updates". The grid has not been emitted yet, so every
  `add()` during collection wrote an update addressed to a viewer that did not
  exist: four viewers came to twenty-seven of them, twenty from a single NMR
  ensemble, each an empty output element and together a band of white space
  under the cell. `_managed` says the first thing alone, and `Grid.show()`
  marks the viewers published afterwards — so an `add()` *after* the grid still
  reaches the viewer beside it, which is the one thing the old flag got right.
- **`rotate=True` turns the structure.** It reached the config, the
  constructor and the Rotate checkbox, and was then switched off by the
  viewer's own opening orient — which stopped the spin unconditionally, on the
  reasoning that a reader pressing Orient wants the view held. Nobody presses
  the automatic one. It passes `keepSpin` now; a deliberate Orient still stops
  the turn. Affected the notebook and the embed alike.
- **`py2dmol_scatter_loaded`** was dispatched on `document` and listened for on
  `window`; a bare `Event` does not bubble.
- An NMR ensemble kept one model of six when an assembly was built.
- A contact drifted when the view rotated: the GPU repack dropped `zBias` and
  `wA` from a line primitive, so the near-surface bias was applied in model
  space along whichever way the view happened to be pointing.
- 🔴 **A ribose-bearing cofactor is a ligand, not a nucleotide.** `add_pdb`
  promoted any residue carrying `C4'` + `O4'` + `C1'` to a nucleotide — a rule
  written for modified bases inside an RNA chain, which also caught SAM, SAH,
  ATP, NAD and FAD. Such a ligand collapsed onto a single position at its `C4'`
  and drew as one sphere, in every frame of a trajectory. The rule now applies
  only inside a chain that holds nucleic acid. The website was never affected:
  its parser asks a stricter question.
- Element colouring is on by default, and the parser infers an element from the
  atom name when columns 77–78 are blank.

### The interface

- **A Clip control in the notebook and the embed**, and `view.clip()` in Python
  — `parts/clip.js` was in every bundle and only the website could reach it.
  It shows whether it is on, which it previously did not.
- **The Cyclic toggle works outside the website.** The shared Style panel put
  it on screen in the notebook and the embed, where nothing wired it: it came
  up unticked while `cyclic` was true and the ring was closed, and
  clicking it did nothing.
- **An Orient control in the notebook.** The website and the embed both had one.
- **Draw is not offered where no 2D painter can honour it**, and SVG export of
  the cartoon is refused rather than writing an empty file. The tube exports a
  vector on every build, because it is stroked by the core rather than by a
  painter.
- **Capture lights up while its panel is open**, like Style beside it and Clip
  above it. The open cue in the notebook and embed shells was written as
  `#styleToggle[aria-expanded="true"]` — one button by name — so Capture put
  its panel up with its own button unlit and nothing said which of the two
  panels you had. Both shells key it on the state now, as `index.html` always
  did, and a latch (`aria-pressed`) and an open panel (`aria-expanded`) wear
  one skin.
- **A more compact viewer menu** in the notebook and the embed: one control
  height for the whole viewer, stated once, and one spacing rhythm. The column
  is 88px closed against 106, and an embed keeps its own spacing in a host page
  that styles bare elements.
- **The website is compacted and aligned**: the header block is 122px against
  161, the page is 79px shorter, and every block shares its edges — header,
  viewer row, sequence strip, control panel, PAE and scatter.
- **The object picker is not shown when there is one object** — where the
  picker is all its row holds, which is the notebook's shell and the embed's.
  The website keeps its row: there the picker sits beside Multi and the
  prev/next buttons, which stay useful with one object.
- **Chain mode in the sequence strip shows the selection.** It showed nothing
  at all, while the same click lit the structure.

**The selection mark follows the ribbon.** It joined consecutive residues with
a straight line, and a cartoon helix is a ribbon spiralling *through* those
residues — so the mark chorded the thing it was marking, by more than twice its
own width. `cartoon/geom.js` hands back the centre line it actually drew and
the mark traces that: on 4HHB's longest helix the path is 328 px against 295.8
of chords, which is the arc-over-chord ratio of a helical step. A tube is
unchanged, because a tube *is* the straight lines between its residues.

**Focus is a mode with a door at each end.** Entering remembers the selection,
every object's side chains, the slab and the camera's centre and zoom, then
clears the decorations so the session starts from the structure rather than
from whatever was left on screen — and focuses a selection that is already
there, since pressing Focus with something picked is asking to look at it
closer. Leaving puts it all back. Two things it deliberately does not take
back: an angle you turned to while inside (focus never rotates, so if it moved,
you moved it) and a selection mark you chose in there. The mark goes to
**Outline** while the mode is on, which is what that option was built for, and
the selection panel stays out of the way.

**How a selection is marked is a setting.** A `Sele` dropdown in the Style
panel, beside `Color` — **Highlight**, **Outline**, **None** — in the website,
the notebook and the embed alike. Highlight is the translucent band this has always drawn and
stays the default. Outline draws the same band and punches its middle out, so a
thin line traces the residue and the geometry inside is untouched: over a
yellow chain, where the band is a blot with the answer somewhere inside it,
that is the difference between marking a residue and covering it. None draws
nothing.

`docs/SELECTION_MARK.md` has the six treatments this was chosen from, with the
pictures and the constants, and the measurements that say the choice costs
nothing — 0.02 ms between the cheapest and the dearest, on an operation that
runs in a tenth of a millisecond.

### Faster

**A side-chain click costs half what it did.** (And half of that again: see
the three-part mesh below.) Showing side chains appends
positions, which changed every term of the GPU mesh signature and rebuilt the
whole cartoon — 8,514 ribbon faces recomputed to draw 182 new stick ones. The
mesh is built in two halves now, ribbon and sticks, concatenated into one
buffer so the draw path is untouched, and the ribbon half is reused whenever
its own faces are unchanged. On 4HHB with 40 side chains, toggled eight times:
**62 ms a click to 32.5**. It applies to every way side chains change — the
Style panel toggle, `showSidechains` from the embed, `view(sidechains=True)`,
a contact, and Focus, which is the one that does it most often.

The mesh is three parts now — the ribbon, the ligands and contacts, and the
side chains — and a click rebuilds only the last: on 4HHB that is 198 faces
instead of 10,336, taking the stick work from 12 ms to 2.5 and the whole click
to a **31 ms median**. A heme is 1,822 faces and was being rebuilt on every
side-chain click purely because it is made of sticks.

What it costs is 260 pixels of 357,604, all of them where a stick surface meets
the ribbon it grows out of: the halves arrive ribbon-then-stick rather than
interleaved by depth, and a tie under `depthFunc(LESS)` goes to whoever drew
first. The winner there was already arbitrary. Indistinguishable at 6x.

**A large structure allocates about half the garbage it used to.** The prim
list is dropped as it is read rather than one pass later, the per-edge objects
and per-face corner arrays are flat typed arrays, and the edge table's Map of
Maps is one map and a chain. On a ribosome the live peak in a build is 288 MB
against 259, and the heap as V8 actually lets it grow went from ~450 MB to
214-436. Nothing about the mesh changed: verified by an order-independent
digest of the fill and the outline, identical across five structures, because
two runs of the same code differ in a third of their pixels on this path and
images cannot settle the question.

### Internal

One translation per surface, not three. A selector becomes a slab in
`renderer.clipTo` and a camera move in `py2dmolOrient.orientTo`, and the
website, the notebook and the embed all call those - each had grown its own
copy, and the copies had already diverged over whether the Clip button gets
re-synced.

The JavaScript is 26 source files under `src/`, merged per target by
`tools/bundle.py` — one manifest, from which every other file list is derived.
`dev.html` is generated from it and `bundle.py check` fails if it has drifted.
The suite is three lanes and about 40 seconds: node checks, headless-Chrome
probes, and GPU probes that run alone because they measure time.

## 1.6.5 and earlier

See the commit history.
