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
  instead, which is 92 KB smaller and the only build that can save an SVG. A
  notebook cannot fall back at runtime, so this chooses which bundle is written
  into the cell.
- **`set_sse(sse, name=, chain=, position=)`** — force a region to helix, strand
  or coil, or pass `None` to return it to the automatic assignment.
- **Structural alignment** — TM-align, vendored from foldjs, running in a worker.
- **Cross-object contacts** — a contact whose two ends are in different objects.
- **An embeddable build**: `py2Dmol.embed.min.js` (495 KB, WebGL2) and
  `py2Dmol.embed.cpu.min.js` (408 KB, 2D and SVG-capable), documented by
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
- **`py2dmol_scatter_loaded`** was dispatched on `document` and listened for on
  `window`; a bare `Event` does not bubble.
- An NMR ensemble kept one model of six when an assembly was built.
- A contact drifted when the view rotated: the GPU repack dropped `zBias` and
  `wA` from a line primitive, so the near-surface bias was applied in model
  space along whichever way the view happened to be pointing.
- Element colouring is on by default, and the parser infers an element from the
  atom name when columns 77–78 are blank.

### Internal

The JavaScript is 26 source files under `src/`, merged per target by
`tools/bundle.py` — one manifest, from which every other file list is derived.
`dev.html` is generated from it and `bundle.py check` fails if it has drifted.
The suite is three lanes and about 40 seconds: node checks, headless-Chrome
probes, and GPU probes that run alone because they measure time.

## 1.6.5 and earlier

See the commit history.
