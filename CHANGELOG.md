# Changelog

## 2.0.0

280 commits since `v1.6.5`. The major number is not for the size of it — it is
for the five things below that change what existing code does.

### Breaking

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

**Some `view()` defaults moved**: `ortho` 1.0 → 0.5, `outline` `"full"` → `None`,
`width` 3.0 → `None` (the style decides). And `best_view`, `kabsch` and
`align_a_to_b` are gone from `py2Dmol.viewer` — the browser chooses the angle
now, so Python sends the *request* (`align`, `allow_reflection`) rather than the
result.

### New

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
- Element colouring is on by default, and the parser infers an element from the
  atom name when columns 77–78 are blank.

### The interface

- **A Clip control in the notebook and the embed**, and `view.clip()` in Python
  — `parts/clip.js` was in every bundle and only the website could reach it.
  It shows whether it is on, which it previously did not.
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
