# py2Dmol

Protein structure viewer. Python package for notebooks, and a web app.
Classic `<script>` files sharing one global scope — no modules, no bundler.
Source is split by role; delivery is merged per application (`tools/bundle.py`).

**`src/` is every source file. `py2Dmol/resources/` is only what the wheel
ships** — `viewer.html` and the built bundles. That split used to be
`web/` versus `py2Dmol/resources/`, and it had stopped meaning anything: the
most widely shared file in the project (`math.js`, in all four bundles) lived
under `web/`, while `panels/seq.js` and `panels/msa.js` — used by the website
alone — sat under the Python package. Directory told you nothing about audience.
`python3 tools/bundle.py show` prints who actually gets what.

## File map

One row per file, and what it owns. A file that does not fit its row has grown
something that belongs somewhere else. `python3 tools/bundle.py show` prints the
same list with load order and targets.

### The renderer core

| file | owns |
|---|---|
| `core/mol.js` | the renderer proper: the data model, camera, gestures, picking, selection and visibility, colour resolution, the tube style, and the frame loop. Also `installMolParts`, which puts the parts below onto the prototype. |
| `parts/multi.js` | several objects as one: the merge, and the arithmetic for reading a merged index back to the object it came from. |
| `parts/ui.js` | `wireViewerUI` — the once-per-viewer bootstrap: canvas, controls, initial data, the public API, and the notebook's live-update channels. Not a part; a plain function. |
| `parts/capture.js` | what a capture is: formats, sizes, sinks, `saveImage`, `saveAsSvg`. |
| `parts/savepanel.js` | the Save panel's DOM. Built fresh on every open. |
| `parts/clip.js` | the camera-space slab. |
| `parts/orient.js` | the best-view search and the flight to it. Was 611 lines inside `src/app/main.js`; needs `src/io/math.js`. |
| `parts/panel.js` | the Style panel's rows, as data — `buildStylePanel` builds the DOM. **One copy**; both pages mount it and skin it with their own CSS. |
| `parts/viewport.js` | `setupViewport` — find the canvas, size it for the display, keep it sized. The one thing both entry points share. |
| `parts/embed.js` | the selector (`positionsFor`), `window.py2Dmol.show` and `wireEmbedUI` — a viewer on a bare canvas, and the JS API on top of it. `core/mol.js` picks between the two wirers on `config.embed`, which `show` sets from whether `controls`/`play` were asked for: with them it is `wireViewerUI` and the notebook's own panel in a scoped shell, without them a canvas and nothing else. |
| `parts/shadow.js` | which segments darken which. |
| `parts/align.js` | the renderer's side of TM-align; the transform lives on the object and is applied on the way out. |
| `core/objstate.js` | `OBJECT_STATE` — every per-object field keyed by position index — plus the per-frame ligand cache. |
| `core/svg.js` | `window.C2S`, the SVG export context. Optional. |

### The cartoon: one geometry, two painters

| file | owns |
|---|---|
| `cartoon/geom.js` | secondary structure, sheet frames, profiles, sticks, base plates — and `render()`, which builds the primitive list. Publishes `window.py2dmolCartoonShared`, the 36 names the 2D painter needs. |
| `cartoon/paint2d.js` | prims → canvas: hidden-line ink, joints, halos, grain, wash. |
| `cartoon/paintgl.js` | prims → WebGL2 → raster. **Neither painter needs the other.** |
| `align/align.js` | TM-align, vendored from `../foldjs` between generated markers. |

### Panels, all optional

`panels/pae.js` (`window.PAE`) · `panels/seq.js` (`window.SEQ`) ·
`panels/msa.js` (`window.MSA`) · `panels/scatter.js` (`window.ScatterPlotViewer`)

### Parsing and the web app

| file | owns |
|---|---|
| `src/io/parse.js` | PDB/mmCIF → a frame. No DOM, no dependencies. What an embed needs. |
| `src/io/math.js` | Kabsch, best-view, and a self-contained 3x3 SVD. No dependencies. |
| `src/io/gif.js` | GIF89a, for the capture sink. |
| `src/app/` | the browser UI. Not used by the notebook. |

### The two pages

`index.html` is what **py2dmol.solab.org** serves, and it loads exactly two
scripts: `align/align.js`, which can never be concatenated, and
`bundles/py2Dmol.web.min.js`. `dev.html` is the same page with the bundle expanded into
its twenty-six loose sources — edit-and-reload with real line numbers — and it
is **generated**: `bundle.py build` writes it and `check` fails if it is not
what regeneration produces, so the two cannot drift in markup.

`embed.html` is the third page and it is the embed's documentation — which
makes it the embed's specification: `tests/embed.py` reads the calls out of it
and checks each one against a running viewer.

**Each section is one complete program**, run once at load and printed beside
the viewer it made, so the code shown cannot drift from the code that ran —
there is no second copy. Each introduces exactly one thing the section before
it did not. What the probe checks of the page itself is small because of that:
every section printed code, none of it threw, no viewer overruns the code box
beneath it, and no verb or selector key named in a sample is one the API does
not have. The page also keeps `window.__pageErrors` from its first statement,
because a throw during its own setup happens before any listener a test can
attach — one dead line at the end of its script threw on every load through a
full green run.

Browser probes serve `dev.html`, so they test the working tree. One,
`tests/multi_object.py`, deliberately serves `index.html`, so the artefact the
public downloads is exercised on every run.

### Python and tooling

| file | owns |
|---|---|
| `py2Dmol/viewer.py` | the Python API and the generated HTML, which **inlines** its JavaScript. |
| `tools/bundle.py` | **the manifest.** Every other file list is derived from it. |
| `tools/free_vars.js` | what a line range reads but does not declare. |
| `tools/extract_part.py` | cut a run of methods into a part file. |
| `tests/lift.js` | how the node tests find shipped code across files, at any indent. |
| `tests/paint_trace.js` | the drawing, as a diffable digest. |

## Rules

- **No file over ~2,500 lines. No function over ~400.** Still failing, and this
  list is the work queue:

  | lines | file | | lines | function |
  |---|---|---|---|---|
  | 11,514 | `core/mol.js` | | 2,449 | `cartoon/paint2d.js` `paintPrims()` |
  | 10,418 | `cartoon/geom.js` | | 1,912 | `cartoon/geom.js` `render()` |
  | 8,432 | `app/ (total)` | | 1,901 | `cartoon/geom.js` `drawRun()` |
  | 5,848 | `cartoon/paintgl.js` | | 1,718 | `parts/ui.js` `wireViewerUI()` |
  | 5,312 | `panels/msa.js` | | 1,473 | `cartoon/geom.js` `drawSticks()` |
  | 3,372 | `io/parse.js` | | 1,084 | `cartoon/geom.js` `mergeBondRuns()` |

  `render()` was 5,238 and is 1,912; `drawRun` and `drawSticks` are what came
  out of it, and both are still over the rule. `paintPrims` is the largest
  single function in the tree now. `setCoords` is 828 and no longer in the
  first six.

- **Two kinds of file, and the difference is load-bearing.**

  *Wrapped* files are an IIFE with `'use strict'`, publishing one global
  (`window.py2dmolCartoon`, `window.PAE`, a push onto `py2dmolMolParts`).
  Everything inside is private. Their body sits at column zero — the wrapper is
  a boundary, not an indent level.

  *Global-scope* files declare at column zero and those declarations **are** the
  interface: `core/mol.js`'s `initializePy2DmolViewer` and the vocabulary,
  `core/objstate.js`'s `OBJECT_STATE`, `src/io/parse.js`'s parsers, `src/app/*`.
  Four files read `OBJECT_STATE`; wrapping it would hide it.

  Do not "fix" this into consistency in either direction. Unwrap the wrapped and
  the bundle stops parsing — `cartoon/geom.js` declares the shading vocabulary
  that `cartoon/paint2d.js` destructures, and concatenated bare that is
  `SyntaxError: Identifier 'BACK_INNER_SHADE' has already been declared`. Wrap
  the unwrapped and the cross-file calls stop resolving. Bundling makes the
  wrappers matter MORE, not less: concatenation is exactly when one shared scope
  becomes unavoidable.

- **One list.** Adding or moving a JS file means editing `tools/bundle.py` and
  nothing else — `index.html` does not name sources any more, and `dev.html`
  is generated; `python3 tools/bundle.py check` names every consumer that has
  not caught up. It is in the node lane, so it fails in seconds.
- **`align/align.js` is never concatenated or inlined.** It starts its Worker
  by having the worker `importScripts` *itself*, found through
  `document.currentScript.src`. Without a URL of its own that lookup returns
  `''` and TM-align runs on the main thread — seconds of frozen page, no error.
- **ONE NOTEBOOK BUNDLE, WITH BOTH PAINTERS, AND `gpu` IS A RUNTIME SETTING.**
  There were three — GPU, 2D, and a cartoon-less tube — and the reason was
  never the download: the notebook library is **inlined into the .ipynb once
  per `show()` cell**, so every kilobyte was paid again for every viewer.
  Sharing pays it once for the document, and the reason for three narrow
  builds went with it. **There is no flag and it is always on**: in Jupyter one
  document means the borrower finds the library already loaded and the channel
  is never used; in Colab the channel carries it. Eight viewers go from
  3,872 KB to 645.
- 🔴 **A PROBE'S "NO" IS NOT AN ANSWER.** Python also pings the page at each
  `show()` to see whether anything is lending, and this read
  `can_borrow = seen if seen is not None else flag` — so ONE unanswered ping
  meant "nothing is lending" and every cell wrote its own copy. It shipped that
  way and a notebook came out at 4 MB with the saving switched on. A False from
  a probe cannot be told apart from a question that never arrived: `eval_js`
  runs in whatever context Colab gives it, and that it reaches the OUTPUT
  frames' channel was assumed, not measured — the transport was proved between
  two outputs, which is a different link. The probe is a CONFIRMATION now: a
  True lets a fresh kernel borrow from a page that still has a lender, and
  anything else falls back to what this kernel wrote, which involves no browser
  and cannot fail quietly.

  The second painter costs **26 KB** (paint2d minifies to 25 against paintgl's
  71; it is 81% comment) and buys back everything that was traded away for it:
  `gpu=False` reaches the 2D painter at runtime rather than selecting a different file,
  a machine with no WebGL2 has something to fall back on, and **the cartoon can
  export an SVG** — which needs the 2D painter, because a raster has no vector
  to give. A notebook mixing the two used to carry 429 + 384 KB of two
  libraries that could not serve each other; now it carries 455 once.

  `core/mol.js` derives `useGPU` from what is loaded — with both present it
  takes `config.rendering.gpu`, which is what the website has always done.
  **The embeds still ship one painter each** (`py2Dmol.embed.min.js` WebGL2,
  `py2Dmol.embed.cpu.min.js` 2D and SVG-capable): they are served over HTTP and
  gzipped, so the trade there is a download and not a document.
- 🔴 **A preset name reaches the cartoon in two steps, and the order is the
  whole thing.** `setPreset` assigns `style = 'cartoon'` but does none of the
  work of *arriving* there, so calling it from tube leaves every field saying
  cartoon while the canvas still shows the tube. Setting `stylePreset` and
  falling through does not work either: the path short-circuits on
  `_recallStyleSettings`, which restores the *remembered* preset and returns.
  `setStyle` therefore enters the cartoon by the normal route first, then
  switches preset. Both failures leave the state correct and the picture wrong.
- 🔴 **A look carries its page, and neither path that skips `setPreset` knew
  it.** `3d` is solid shaded geometry drawn to be seen on black, and
  `_applyLookBackground` says so — but it runs from `setStyle` and `setPreset`
  only. Two ways past it, both shipping solid geometry on white paper: a viewer
  built from a **config** calls neither, so `py2Dmol.show({style: '3d'})` and
  `py2Dmol.view(style='3d')` came up white (`viewer.py` had worked around this
  in Python; the rule lives in `normalizeConfig` now, so both get it from one
  place, and an explicit `bg` still wins); and `backgroundColor` is **not** in
  `STYLE_SETTINGS` — it belongs to the look, and `cartoon` holds three looks —
  so the `_recallStyleSettings` short cut above returned without restoring it.
  Black was a first-visit-only effect: 3d, tube, 3d again left it white, on the
  website dropdown as much as anywhere.
- **A control belongs to whichever painter can honour it, and the panel is
  built after that is settled.** `Draw` is the 2D painter's — `_gpuWillTake`
  returns false while `drawMode` is on, because the pencil, the wash and the
  grain have no WebGL2 port — so on a GPU-only build ticking it asked for a
  painter that is not in the download. `needs2d` on the ITEM drops it;
  dropping the ROW would take Smooth, Arrows, Colorblind and Dark with it.
  `_canDraw` refuses by name as the backstop for `setDrawMode()` from code.
  Same question the Save panel asks before offering SVG.
- **A CONTROL THE SHARED PANEL SHOWS AND ONE SHELL WIRES IS WORSE THAN NO
  CONTROL.** `parts/panel.js` is one table and every shell mounts it, so a row
  added for the website appears in the notebook and the embed too — on screen,
  unseeded and inert. Cyclic was the fourth: it came up UNTICKED while
  `cyclic` was true and the ring was closed, and clicking it did
  nothing. Orient, Clip and Draw were the first three. Wiring lives in
  `parts/ui.js` beside the others now. The ring is closed in `setCoords`, not
  in `render`, so the handler has to `reloadDrawn()` — a repaint changes
  nothing, the same trap the side-chain and contact toggles hit.
- **Three shells carry the same controls, and Orient was in two of them.**
  The website's lives in `index.html` and `app/main.js` wires it; the embed
  grew its own in `parts/embed.js`; `py2Dmol/resources/viewer.html` — the page
  a notebook cell actually shows — had neither, on a note claiming only
  `index.html` has an `#objectSelect` to say which object. It has one too. It
  is wired in `parts/ui.js` now, from the markup both shells carry, and the
  embed's own listener went with it — wiring it twice flew the camera twice.
- **The Style panel is data, in `parts/panel.js`, and is BUILT at runtime.**
  It used to be two hundred lines of markup in `index.html` and again in
  `viewer.html`, under a note saying to edit both — which had already been
  missed three times over (a Bases toggle only the notebook had, a Cyclic
  toggle only the web app had, and a whole colour option and ordering that
  differed). `ui.js` mounts it **early**, before anything reaches for a control
  inside it; a page that ships its own panel keeps it. The tests read the table
  through `tests/lift.js`'s `panelRows()` / `panelItems()` rather than scanning
  HTML.
- **One flat list of styles at the API; a (style, preset) pair inside.**
  `tube`, `richardson`, `ribbon`, `3d` is what Python, the embed and the Style
  dropdown all take. `resolveStyleName` in `core/mol.js` is the only place that
  turns a name into the pair, and `normalizeConfig` and `setStyle` both use it.
  Keep the split internally — a style is a draw path, a preset is a cartoon
  profile, and `setPreset` only makes sense for one of them — but do not put it
  back in front of a caller: `cartoon` was never a look on its own, and two
  fields that must agree are two fields that can disagree.
- 🔴 **THE STATIC PAYLOAD IS BUILT FIELD BY FIELD TOO, and it dropped
  `align`.** Same shape of fault as `normalizeConfig` below: `_display_viewer`
  assembles a `light_frame` key by key, so a key it does not name is a key it
  throws away — and it named every one but the request to superpose. Since the
  fitting moved to the browser the payload carries the REQUEST, not the result,
  so dropping it means "leave every frame where its file put it". `align=True`
  is the DEFAULT, and `add()` then `show()` is the ordinary way to use the
  library, so a trajectory simply did not superpose — while `show()` then
  `add()` did, because the live path sends the frame dict whole. A helix and
  the same helix turned 90 degrees came out 7.07 A apart instead of 0.
  `parts/ui.js`'s static loader rebuilds the frame field by field as well and
  had to be told separately; **both ends** are needed and each fails silently
  on its own. Checked in `tests/minimal_input.py`, which loads one object that
  asks for alignment and one that refuses it — a single object cannot tell
  "aligned" from "the frames were never moved".
- **The browser owns the viewing geometry now.** `best_view` and `kabsch` both
  left `viewer.py`: the angle is chosen by `parts/orient.js` when the first
  frame lands, and each frame is superposed on the one before it in
  `addFrame` — the single funnel a static payload, a streamed frame and an
  embed's own `addFrame` all arrive through. What Python sends is the
  **request** (`align`, `allow_reflection`), not the result. Both were in numpy
  only because the JS side had no SVD before `svd3` replaced numeric.js.
- **THREE SURFACES, ONE TRANSLATION, and the translation is the part that
  drifts.** The website, the notebook and the embed all turn a selector into an
  action, and the action is the renderer's - so the translation must be the
  renderer's too. `renderer.clipTo(sel)` (`parts/clip.js`) and
  `py2dmolOrient.orientTo(renderer, request)` (`parts/orient.js`) are the two,
  and each replaced two or three near-copies: the clip translation was written
  out in `parts/embed.js` and again in `parts/ui.js`, and only ONE of them
  re-synced the Clip button, so a notebook's button and its slab could disagree
  about whether clipping was on. `orientTo` merges selector keys and options in
  one object (`{type: 'L', animate: false}`) — the embed had that and the
  notebook's later copy handled `object` alone. Python sends exactly that
  merged object, so nothing unpacks it on arrival.
- 🔴 **The one-object picker hide is a rule about what the ROW CONTAINS, and
  testing the class instead passed everything while being wrong.**
  `updateUIControls` hides `objectSelect.closest('.toggle-item')` when the row
  holds nothing but the picker and its label. The first version tested only the
  class — and `index.html`'s row is `.toggle-item object-row`, so it hid the
  website's Multi and prev/next buttons too. Every test passed, because a line
  a few below in the same function forces `#objectRow` back to `flex`: two
  lines fighting over one element, with the accident winning. The rule now sits
  AFTER that line so one thing decides, which is also what makes the mutation
  visible — `tests/multi_object.py` drives index.html's picker down to one
  option and requires the row to stay. It is re-asked on every update rather
  than decided at load.
- **`multi=True` and `view.show_objects()` are the OBJECT question; `overlay`
  is the FRAME one.** Both reach `setShownObjects`, the renderer's own setter,
  which is what keeps `_framedObjects` — assigning `shownObjects` and calling
  `_applyShownObjects` by hand skips it and the camera never widens. Python
  resolves "all of them" itself, at the moment of the call, so what travels is
  always an explicit list; `multi=True` is resolved in `_display_viewer`,
  because the objects it names do not exist until something has been added.
- **`view.orient()` is an ACTION, not a state.** `clip` and `shown_objects` are
  diffed against what was last sent and skipped when unchanged; the same
  `orient()` asked for twice means fly there twice, so it is queued and cleared
  on send. `tests/config.js` reads the live viewer block's keys off BOTH sides
  and names any that one packs and the other drops.
- 🔴 **`_is_live` MEANS TWO THINGS AND THE GRID WANTED ONE OF THEM.** "Do not
  show yourself" and "you are on the page, so every add() is an incremental
  update" travelled on one flag, and `Grid.view()` set it to get the first —
  so each `add()` during collection emitted an update for a viewer that did
  not exist yet. Four viewers came to twenty-eight outputs, twenty of them
  from one NMR ensemble; they are empty `<script style="display:none">`
  elements, which is why the symptom is white space rather than anything
  visible. `_managed` is the first meaning alone; `_mark_published()` — the
  bookkeeping lifted out of `show()`'s static branch — is where live begins,
  and `Grid.show()` calls it so a later `add()` still lands. `tests/grid.py`
  counts outputs, which is the whole of the fault and needs no browser.
- 🔴 **THE OPENING ORIENT STOPPED THE SPIN, so `rotate=True` never turned.**
  Every surface orients itself when the first frame lands — `parts/ui.js` on
  the static payload, `loadFrames` in `parts/embed.js` — and
  `orientToBestView` switched `autoRotate` off unconditionally. The reasoning
  is right for the BUTTON: a reader who presses Orient while the structure
  turns wants it framed and held, not spun past the angle just chosen. Nobody
  presses the automatic one. `py2Dmol.view(rotate=True)` came up with
  `config.display.rotate` true, `autoRotate` true from the constructor, the
  checkbox ticked from that — and then the opening orient unticked it and
  dispatched a `change`. Nothing in the trace looks wrong until that line.
  The two automatic callers pass `keepSpin`; the deliberate ones do not.
- **A capability in the bundle that no interface reaches is not shipped.**
  `parts/clip.js` is in every build and only `index.html` could get to it: the
  website had a Clip panel, the embed had `v.clip(sel)`, the notebook had
  neither an API nor a button. `view.clip(name=, chain=, position=)` and a Clip
  button in both shells close it. The slab is the VIEWER'S, not an object's —
  it belongs to the camera and survives switching objects — so it travels
  top-level in the config on the static path (`normalizeConfig` carries an
  unknown top-level key untouched) and as `viewer` beside `frames` and `meta`
  on the live one. It could not ride in the per-object metadata map at all.
  Applied AFTER the orientation, because depth is measured along the view.
- 🔴 **THE SCOPING GOES BOTH WAYS, and only one way was defended.** Every
  selector in `parts/embed.js`'s `SHELL_CSS` is prefixed `#${id}` so the shell
  cannot take a host page's dropdowns — and nothing stopped the host page taking
  the shell's. `embed.html` styles a bare `button` element, as any page may:
  13px font, fatter padding, and `margin: 0 .3rem .4rem 0`. The shell states
  height and padding, so those held; **margin did not**. Orient and Clip are
  buttons and took 4.8px on the right and 6.4px underneath, Rotate is a label
  and took none — so the row spaced unevenly and the column stood 13px taller,
  **on that page only**, which is why every measurement of a bare test page said
  it was fine. The shell resets `margin`, `box-sizing` and `font-family` on its
  own controls now. `tests/embed.py` measures the real page: no stray margins
  inside `#rightPanelContainer`, and the gap between buttons equal to the gap
  between rows.
- **ON IS ON, HOWEVER THE BUTTON SPELLS IT.** A latch says `aria-pressed`
  (Clip); a button that opens a panel says `aria-expanded` (Style, Capture).
  Both mean "this is on" to a reader and both wear the same skin — so the rule
  is keyed on the STATE, never on a button's id. `viewer.html` and
  `parts/embed.js` both wrote `#styleToggle[aria-expanded="true"]`, and Capture
  therefore opened its panel unlit: two panels, one cue, no way to tell which
  was up. `index.html` had it right (`.btn-toggle[aria-expanded="true"]`),
  which is the three-shells rule below arriving for the third time. Measured as
  a COLOUR in `tests/minimal_input.py` and `tests/embed.py` — the attribute was
  already being set correctly, so reading it back passes against the bug.
- **THREE SHELLS, THREE STYLESHEETS, AND A MEASUREMENT IS THE ONLY WAY TO TELL
  THEM APART.** `index.html` + `src/app/style.css`, `viewer.html`'s own sheet,
  and `parts/embed.js`'s `SHELL_CSS` all draw the same controls. Every reported
  "uneven spacing" this session was in a shell I was not measuring — the
  screenshots were of the embed while I measured the notebook. Measure the one
  that was reported, and measure the CLOSED state as well as the open one.
  Three things that cost a round each and are not visible in the source:
  **a `height` on a base rule beats padding** (trimming padding under it does
  nothing); **an empty flex child still takes its gap** — `#stylePanelMount`
  holds the hidden style panel and put 3px under the last control that nothing
  above it had, which `display: contents` removes; and **`box-sizing` set with
  a descendant selector misses the element itself** — `.py2dmol-viewer-instance
  *` left the instance, the header and the sequence strip as content-box, so
  three blocks with the same stated width had three different right edges.
- 🔴 **A STORED PAE BOX IS IN RESIDUES; THE MASK IS DRAWN IN CELLS.** Three
  crossings, not two: `cellsToResidues` on the way out of a drag,
  `residueToCell` for the sequence highlight — and `render()`, which lays the
  mask out at `this.size / this.n` per CELL while `visibilityModel.paeBoxes`
  holds RESIDUES. The same numbers only while the matrix is one cell per
  residue, so on a resampled one the rectangle came out at the wrong place and
  the wrong size: a selection that lights a different region from the one
  dragged. Found by a reader, not by the suite, because the two crossings that
  WERE covered are arithmetic and the third is a drawing. It is measured on the
  CANVAS now — two renders and the pixels that did not change — because every
  arithmetic check agrees with the bug.
- **`n` WAS THE MATRIX SIDE AND THE RESIDUE COUNT, and a resampled PAE makes
  them different numbers.** `panels/pae.js` used `this.n` for the cell grid,
  for the hit-test, AND as the residue index handed to `setVisibility` — fine
  while the matrix was one cell per residue. `viewer.py` now resamples anything
  wider than `pae.size` (the panel is an n×n image scaled into that many
  pixels, so the browser was discarding the detail on every frame anyway), and
  `pae_n` travels beside the matrix. `cellsToResidues` and `residueToCell` are
  the two crossings, both the identity when nothing was resampled. Getting the
  scaling wrong selects the wrong part of the structure while the plot looks
  perfectly right — `tests/minimal_input.py` drags the whole plot and requires
  every residue back, which is what an off-by-one in the block end loses.
- 🔴 **`_gpuWillDraw` WAS A GUESS THAT BECAME AN ANSWER.** The CPU occlusion
  pass is skipped when the GPU is going to draw, because the GPU computes its
  own — and the question was asked of the renderer's STATE, with a comment
  saying being wrong costs a repaint and never a wrong picture. True while it
  only chose WHEN to work; not true once it gated work the fallback needs.
  `_gpuWillTake(ctx)` correctly refuses an SVG context (`ctx.getSerializedSvg`)
  so the export takes the 2D path — with a pass that had been skipped on the
  GPU's behalf. **gpu + tube + svg exported a flat tube.** `_gpuWillDraw(ctx)`
  applies the same refusal now. Measured in `tests/minimal_input.py` by
  exporting twice, shadows on and off: identical is the bug. NOT by mean
  darkness — occlusion carries a TINT as well as a shade, so the mean moves
  either way by structure; the count of distinct stroke colours does not
  (46 shaded against 2).
- **AND A TEST THAT SLICES FROM `indexOf('name() {')` FAILS WHEN THE METHOD
  GAINS AN ARGUMENT** — which is exactly when it changed. `tests/interaction.js`
  did that to `_gpuWillDraw` and reported a bug against the commit that fixed
  one. `L.method(name)` finds it whatever its arguments are.
- 🔴 **THE BOX IS THE FRAME AND `bg` IS THE PAPER, and turning the frame off
  repainted the paper.** `parts/ui.js`'s `box` branch set
  `canvas.style.background = 'transparent'` AFTER the requested colour had been
  seeded, and called `setClearColor(true)` so the renderer would not paint one
  either — so `bg` did nothing whenever `box` was false. `py2Dmol.grid`
  defaults `box` to FALSE, which is why it read as "bg does not work in a
  grid". White cannot be told apart from "not asked for", so it keeps the old
  behaviour; any other colour is a request. The seeding also read
  `=== '#000000'` from inside the Dark toggle's block, so it was not "show the
  background" but "show it if it is black" — true of the Python API, which
  takes only white or black, and not of the renderer it was written against.
  **Check the ELEMENT'S background as well as the painted pixel**: the renderer
  clears the buffer and the CSS colours the element, and a test on the pixel
  alone let two separate mutations through.
- 🔴 **THE PAGE HAS TO BE THE RIGHT HEIGHT BEFORE ANY SCRIPT RUNS, because
  that is when Colab measures it.** `viewer.html`'s stylesheet gives
  `#canvasContainer` 600x600 and `parts/viewport.js` corrects it — so the
  markup alone is 648px for a 300px viewer. Colab inserts output HTML with
  `innerHTML`, which never executes a script, and sizes the output iframe from
  what it measures in that window: a 2x2 grid of 300px viewers is ~1,220px of
  unsized markup, and the frame kept ~1,000px around a 644px page. That is the
  white space under a grid, and it is gone on reopen because the measurement
  happens again after the scripts have run — which is why every measurement of
  a settled page said the layout was perfect. `viewer.py` substitutes the size
  as an INLINE STYLE (ids repeat across viewers on one page, so a
  `#canvasContainer {…}` rule would apply to all of them) and RAISES if the
  token is gone, because falling back to 600 is the bug. `tests/python_multi.py`
  sets the markup with `innerHTML` and measures — the same state, reproduced.
- 🔴 **THE SHARED LIBRARY WAS KEYED BY PATH, so a re-run cell could borrow a
  library older than the payload it was writing.** A notebook is re-run cell by
  cell: the cell holding the library can be from an earlier build than the cell
  now asking for one, and today's payload handed to yesterday's renderer DRAWS
  — silently missing whatever the two versions disagree about. The PAE moving
  to base64 is what made it visible: an empty plot on a page where everything
  else looked right. `_share_key` is the path plus a hash of the bundle's
  CONTENT (not `__version__` — a rebuilt bundle keeps the version), so a
  borrower whose key is not on the page inlines its own copy, which is the
  behaviour that was always there for "nobody is lending". Checked
  BEHAVIOURALLY in `tests/grid.py`: a text scan of `viewer.py` passes against
  a `_share_key` that returns the path anyway.
- 🔴 **A WIRE FORMAT HAS TWO ENDS AND `isValid` IS ONE OF THEM.** The PAE now
  travels base64 — N² numbers inlined into an `.ipynb` is the biggest thing a
  payload ever carries, and one 837×837 matrix was 72% of the demo notebook
  (3,048 KB as a JSON list of scaled ints against 912 as base64 of the same
  bytes; compact `json.dumps` separators took the file 4.32 MB → 2.03). The
  decoder went into `setData`, and the panel still came up empty: EVERY read of
  `frame.pae` in `panels/pae.js` goes through `isValid`, which knew an Array, a
  typed array and an index-keyed object, and answered false for a string. The
  payload carried the matrix and nothing said a word. Checked in
  `tests/minimal_input.py` as VALUES from an ASYMMETRIC matrix, not as a
  length: an undecoded base64 string has a length, and the square root of it is
  still a number, so the panel would have drawn a plausible square of nonsense
  and every "is there a matrix" check would have passed.
- **Subsystems are optional and guarded.** `if (window.PAE)`, `if (window.MSA)`,
  `typeof C2S === 'undefined'`. A build without one loses a feature, not a page.
- **Prove a move changed nothing.** `node tests/paint_trace.js` digests every
  call the painter makes. Run it before and after; `--show NAME` diffs a stream.
  **It covers the CARTOON only** — it evaluates `cartoon/geom.js` and
  `cartoon/paint2d.js` and nothing else, so it says nothing about `core/mol.js`.
  A tube-path refactor is proved by the browser probes instead: `pick_empty`,
  `selection_panel` and `multi_object` caught a `ReferenceError` in
  `_drawFrame` that paint_trace had just reported clean.

  **And an op stream cannot see the GPU harvest.** `_frameProbe` changes prim
  FIELDS, not canvas calls, so every fixture digests identically with it on —
  the duplicate-digest guard correctly refuses a fixture for it. It is checked
  separately, on the prims, because extracting the base plates left a dangling
  `hasColorOverrides` in exactly that branch: every nucleic example went blank
  and the trace still said eleven fixtures unchanged.
- 🔴 **THIS FILE IS AN IIFE, SO MODULE SCOPE IS BRACE DEPTH ONE.** Its
  declarations sit at column zero because the wrapper is a boundary, not an
  indent level — so **indentation cannot tell you what is free**. Classify by
  brace depth. Of the 25 names that looked module-scope in `render()`'s run
  loop, 24 were; `emitSlabInk` is written flush left at depth TWO, inside
  `render()`, and the extraction shipped without it. `paint_trace` said
  `emitSlabInk is not defined` in one line — the argument for running it
  before the browser rather than after.
- **`render()` IS DOWN TO 1,912, and the way it was cut is the pattern.**
  `drawSticks` took 1,463 lines - side chains, ligands, contacts, and the
  ribbon-surface geometry they meet the backbone on. Three measurements made it
  a mechanical move rather than a rewrite: `free_vars.js` named 40 free names,
  **13 of which are module-scope in the same file and need no passing**, which
  it cannot tell you - classify them before believing the number; nothing in the
  range is REASSIGNED, checked rather than assumed, so a context object is safe
  and the arrays it writes into are mutated in place; and the boundary is the
  `});` of `mergeBondRuns`, which was one line further than it looked and cost a
  parse error. Proved by `paint_trace`: 11 fixtures, 15,905 ops, byte-identical
  before and after. `drawRun` then took the run loop's BODY, 1,888 lines, and
  needed two things a straight move does not: the single `continue` at the
  body's own level becomes `return` (the other 23 belong to inner loops), and
  `naSlabHalfT` is LOOP-CARRIED — a nucleic run records what its slab came out
  as, the rest of that run reads it back, and so does the code after the loop —
  so it lives on the context and is deliberately not destructured. What is left
  is `drawSticks` (1,473) and `mergeBondRuns` (1,084), both already top-level.
- **Check before you cut.** `node tools/free_vars.js <file> <from> <to>` lists
  what a range closes over. Anything in *must handle* has to be hoisted, passed
  or recomputed first. **It is a heuristic and wrong in both directions**: it
  missed `hasColorOverrides`, read inside a nested object literal, and the cut
  shipped a `ReferenceError` that only the browser saw; and it invented `e` for
  a block that never mentions it, which threw at the call site the moment the
  name was dutifully passed. Read its answer, then run the browser.

## Traps

- **The class is still inside a factory.** `initializePy2DmolViewer` wraps
  `class Pseudo3DRenderer`, so anything declared *in* the factory is invisible
  to a sibling file. The pure vocabulary — `Vec3`, `hexToRgb`, `DEFAULT_CONFIG`,
  the colour tables, the drawing constants — was hoisted to module scope for
  exactly this reason and IS visible. Check with `tools/free_vars.js` rather
  than guessing; it is what the part files were cut against.
- **A part file must load before the first viewer is created.** `installMolParts`
  seals the queue after the first install and throws by name if a part arrives
  late, so this fails loudly — but only at runtime.
- 🔴 **The notebook PREPENDS its scripts**, so `viewer.py`'s document order is
  the REVERSE of the order its reads appear in. Reading a file *after* another
  puts it *before* it in the page. This bit once already: the 2D painter was
  read after the geometry and so loaded before it, threw on its own guard,
  never registered, and the cartoon silently drew nothing. Only
  `tests/minimal_input.py` builds through `_display_viewer`, so it is the only
  probe that catches this.
- **`py2dmol_lib_loaded` is listened for and never dispatched** (`viewer.py`).
  The notebook works only because the script is prepended synchronously, so
  the branch that waits for it has never run — and a fallback that only runs
  once something has already gone wrong is the one that must not fail quietly.
  It is a bounded poll now, two seconds, then a console error by name; the
  event still has no dispatcher and the listener is gone.
- **`py2dmol_scatter_loaded` was dispatched on `document` and listened for on
  `window`** — `new Event()` does not bubble, so it never arrived. Listened
  for on `document` now. It was masked by load order: the panel is in the
  bundle, so `ScatterPlotViewer` is already there and the other branch runs.
- 🔴 **THE LIVE UPDATE HAS TWO METADATA APPLIERS AND THEY HAD DRIFTED.**
  `applyMetadataToObject` serves `handleReplaceFrame`; `handleIncrementalStateUpdate`
  had its own field-by-field copy, and `sse` was added to the first and never
  the second — so `set_sse()` on a LIVE viewer wrote the map in Python, packed
  it into the update, sent it, and had it dropped on arrival, while the same
  call through `show()` worked because the static path reads it. One applier
  now; the only thing left inline is the scatter refresh, which needs to know
  which object is on screen.
- 🔴 **SETTING AND UNSETTING WERE NOT THE SAME PATH, so nothing could be
  taken off.** `_send_incremental_update` builds its metadata from the fields
  that are **not None**, and compares that against what it last sent — so a
  colour removed, a contact list emptied or an SSE override cleared simply
  stopped appearing. It was never unequal to anything, never packed, and the
  viewer went on drawing it for the life of the session. The whole comparison
  was skipped outright when the last field went, because the block sat under
  `if current_metadata:` and an empty dict is false — exactly the moment there
  is most to say. Removals travel as an explicit `None` now, and
  `applyMetadataToObject` reads **the key, not the value's truth**:
  present-and-null clears, absent leaves alone. Python could not express the
  removal either — `set_color(None)` returned on `_normalize_color`,
  `add_contacts([])` warned and refused — so `None`/`[]` is the spelling, and
  for `set_color` it reaches exactly as far as the selector that set it: the
  object, one chain, some positions, or one frame. `frame_colors` is
  **authoritative** rather than a patch, because a frame missing from the map
  is a frame whose colour came off.
- 🔴 **A FRAME IS SENT ONCE, so anything set on it afterwards must travel
  as metadata or not at all.** `_sent_frame_count` sees to the once, and
  `set_color(..., frame=N)` writes into the frame — so on a live viewer the
  call updated Python, emitted nothing the browser could use, and was silently
  lost. Frame colours ride with the other per-object metadata now, as
  `frame_colors`, keyed by frame index.
- **The custom-event bus is `document`-scoped**, so two viewers on one page
  cross-talk: `py2dmol-color-change`, `-frame-change`, `-visibility-change`,
  `-residue-selection-change`.
- 🔴 **COLAB PUTS EVERY CELL OUTPUT IN ITS OWN IFRAME, so the notebook's
  live path has a bridge in Jupyter that it does not have there.** `show()` then
  `add()` works in Jupyter because everything is one document: the script an
  `add()` writes finds `window.py2dmol_viewers[vid]` beside it and calls it. In
  Colab that call finds nothing and the mailbox `<script>` node is in a document
  no `MutationObserver` of ours watches, so **BroadcastChannel is the only thing
  carrying a frame**. It does not retain, and it had no handshake: `viewerReady`
  was sent by `parts/ui.js` and listened for by NOBODY, so an update cell that
  posted before the viewer's iframe opened its channel lost its frames for good.
  On a REOPEN that is the ordinary case rather than a corner — every output
  iframe loads at once and the viewer's is half a megabyte against an update
  cell's kilobyte. The update cells answer the announcement now. And the replay
  arrives in whatever order the iframes ran, while **`seq` is a watermark** that
  discards anything below its high mark, so the viewer holds what lands inside
  an 800 ms window and applies it sorted — it cannot wait for a gap to fill
  instead, because `_emit_to_output` spends a `seq` of its own on each
  `display_id` and three `add()` calls are 1, 3, 5. `tests/colab.py` runs all
  three arrival orders, and neuters `BroadcastChannel` to prove it is measuring
  that path and no other.
- **`persistence=False` cannot survive a reopen, and that is the mode, not a
  bug.** It is one mailbox cell, overwritten, holding only the last unsent
  delta — so a reopened notebook replays one frame where `persistence=True`,
  which writes a cell per `add()`, replays the trajectory.
- 🔴 **THE PER-FIELD CACHES ARE THE RENDERER'S, NOT THE OBJECT'S.**
  `_setDataField` falls back to the last array it saw whenever a frame does not
  carry one, which is right WITHIN an object — a trajectory writes `chains` on
  frame 0 and omits them after — and wrong the moment the object changes. The
  only guard was `length === n`, so **two objects of the same length inherited
  each other's**: switch from a 60-residue two-chain complex to a 60-residue
  model that carries no chains, and it is drawn as two chains, split at a break
  that is not in it. All seven fields do it — `plddts`, `chains`,
  `positionTypes`, `positionNames`, `residueNumbers`, `positionAtoms`,
  `positionElements`. `setCoords` drops the caches when
  `_dataCacheObject !== currentObjectName`, and that check lives THERE rather
  than inside `_setDataField` because the seven calls share the decision: the
  first would flip the owner and the other six would then read the stale arrays
  as if they belonged.
  **Only one route reaches it.** The merge builds its own arrays
  (`fill(frame.chains, () => Array(n).fill('A'))`), and so does
  `setShownObjects` even for a single object — so neither ever asks the caches
  anything, and a test written through either passes with the fix removed. The
  route that inherits is `_switchToObject` then `setFrame`, which is what the
  object picker calls. `tests/python_page.py` builds two equal-length objects
  for this and switches between them **before** its merge step.
- **One selector, and it lives in `core/mol.js`.** `positionsFor` turns
  `'B'` / `[3,4,5]` / `{object,chain,positions,range,residues,type,near,not}`
  into a Set of position indices. It began in `parts/embed.js`, which put the
  project's one way of naming residues inside a file the notebook and the
  website do not load; at module scope in `core/mol.js` a contact ENDPOINT can
  use it too — an address is just a selector that must resolve to exactly one
  position, which is what stopped it growing `residue`/`position` beside the
  grammar's `residues`/`positions`. `select`, `hide`, `show`, `showSidechains`,
  `clip`, `orient` and `setColor` all take it, and so does a contact endpoint.
  The pairs are RELATIVE: `select`/`unselect` and `show`/`hide` add to and
  subtract from what is selected or visible now, and with no argument a
  selector means everything — which is why `unselect()` clears and needs no
  special case.
  `type` and `near` are the renderer's own machinery with no way in from
  outside until now — the per-position type it draws from, and
  `residuesWithin`, the gridded atom-to-atom search behind the app's Find
  interactions. `not` is an OPERAND, and the two verbs are the two OPERATIONS — subtract
  from what is showing, add back to it. Both are relative, which is the one
  thing inversion cannot express; every absolute answer is `resetVisibility()`
  then a `hide`. There was a `showOnly` and `not` made it a composition of
  those two, so it went. There were four spellings before and no two agreed — which is
  most of why the API was hard to hold, and how `setVisibility` came to be
  documented backwards. **`positions` and `residues` are different numbers that
  both look like integers**: an index into what is drawn, against what the file
  calls the residue. The renderer keeps its own `setVisibility` — the set that
  STAYS, plus a mode whose empty case means "unset" — and the three verbs exist
  so nobody has to hold that.
- 🔴 **The biological assembly was never built from an mmCIF, and the website
  asks for one by default.** `extractCIFBiounitOperations` had two faults in a
  row. It called `parseMinimalCIF_light(text)` with no `keepPrefixes`, and that
  function returns an empty list when it is not told what to seek — so every
  caller without cached loops got `null`. And it read the assembly only as a
  `loop_`, while **a file with ONE assembly writes it as key-value items**,
  which is the common case; the parser skips those blocks and says so where it
  does. `index.html`'s Load Biounit box is checked, so the website has been
  asking all along and drawing the asymmetric unit. Fixing it makes 2OMF load
  as the trimer it is, which is why `tests/align_objects.py` now turns the box
  off — it measures an alignment, against figures computed on the deposited
  chains. **All three surfaces build it by default now**, and two things had to
  be true first: `viewer.py` built the assembly from `structure[0]` alone, so
  an NMR ensemble kept one model of six; and `gemmi.make_assembly` RENAMES the
  chains it copies, so a monomer whose assembly is one copy came back with
  chain `A` as `A1` and every contact, colour and selection naming a chain
  stopped resolving. It is skipped when it would not expand the structure,
  compared by atom count.
- 🔴 **A selection does not redraw itself, and clicking does not make one.**
  Two separate defaults, both owned by whoever can show the result, and an
  embed left at either looks broken. `setResidueSelection` changes the field,
  dispatches `-residue-selection-change` and stops — correct in the web app,
  where the panel is listening and redraws as part of rebuilding itself, and a
  silent halo everywhere else: the pick lands, the canvas keeps the old
  picture, and the next rotate brings the halo in with it. And
  `selectionEnabled` is **false** in the renderer, so a click picks nothing at
  all. `parts/embed.js` turns the flag on and wraps the renderer's own two
  methods — wraps, rather than subscribing, because the bus above would fire
  once per viewer on the page.
- **A contact between two objects is the VIEWER's, not either object's.**
  `renderer.crossContacts`, with both ends written as addresses
  (`{object, chain, residue}`) — because an object's own contacts resolve
  inside that object's slice of the merged array, so a pair with one end in
  each could not be written at all. Filed on one of the two it would also
  vanish whenever that one was hidden, with its other end still on screen.
  Object-level contacts travel through `OBJECT_STATE`; the viewer's list is
  carried separately, as `viewer_state.cross_contacts`, and is cleared by
  `clearAllObjects` — it is not an object's, so neither the save nor the clear
  reached it for free, and both had to be told. Its ends are addresses rather
  than indices, which is what lets it survive the round trip unchanged.
- 🔴 **`_struct_conn` is not all connectivity.** It carries `covale`, `disulf`,
  `hydrog` and `metalc`, and a metal COORDINATION record is not a bond: drawing
  it as a stick invents rings. 7P1E declares Ca 506 chelated by both
  carboxylate oxygens of the ligand K99, and those two sticks plus the
  carboxylate's own close a four-ring that reads as a solid triangle. `metalc`
  is excluded; bringing it back means drawing it AS coordination, on its own
  layer. It was also only ever half-drawn — its protein-side ends name atoms
  (`ASP OD1`) and a protein residue contributes only its CA, so those resolved
  to nothing.
- **A lone atom's radius is PYMOL'S NUMBER, not a principle.**
  `loneAtomRadiusA` (`cartoon/geom.js`) is PyMOL's `ElementTable` from
  `layer2/AtomInfo.cpp` — Bondi where Bondi reaches, **1.80 for everything
  else**, which is most of the metals. The published vdW sets disagree wildly
  above argon, so the one that matters is the one the reader has on screen
  beside this: two rounds of "the calcium is the wrong size" were Alvarez's
  2.31 (too big) and a Shannon ionic 1.00 (too small) against PyMOL's 1.80.
  `tests/interaction.js` checks the whole column, because an ordering plus a
  bound is what let 1.00 through.
- **ONE LIST OF THE PER-FRAME FIELDS PER SIDE, and a test that they agree.**
  `viewer.py`'s `FRAME_INHERITED` / `FRAME_ALWAYS` and `parts/ui.js`'s
  `STATIC_FRAME_FIELDS` replace two hand-written runs of `if`s that had
  disagreed three times over. `tests/config.js` reads both out of the source
  and names any field one side sends and the other drops. Adding a field is
  adding a name to each list. The payload is byte-identical across the change,
  checked by generating it from the committed `viewer.py` and the new one.
- 🔴 **THE STATIC LOADER DROPPED THE PER-ATOM COLUMNS, so element
  colouring was dead in every notebook.** Third field the same rebuild has
  thrown away — `parts/ui.js` names each frame field one by one and never named
  `position_atoms` or `position_elements`, which Python sends and only a LIGAND
  fills. `hasElementsFor()` answered false on the whole notebook path while the
  feature worked perfectly on the website. **`align` and these were found the
  same way**: counting the field names on each side of the payload and reading
  off which were missing — viewer.py's `light_frame` names 15, `ui.js` named 12.
- **The atom name and the element are two things, and 3PTB proves it.**
  `ATOM 2 C CA . ILE` is the alpha carbon — element `C`, atom name `CA`.
  `HETATM 1630 CA CA . CA` is the calcium ion — element `CA`, atom name `CA`.
  Same name, different elements, in one file, which is why the format carries
  an element column and why it cannot be inferred from the name.
- **Element colouring is ON by default — the opposite of side chains.** Absent
  means ALL for `elements` and NONE for `sidechains`. It only ever applies to
  atoms that have an element to read: ligand atoms and drawn side chains. And
  the parser INFERS an element from the atom name when columns 77-78 are blank,
  so blanks are harmless and **garbage is not** — `embed.html`'s own trimmed
  trypsin had the atom serial there, every atom parsed as element `"16"`, and
  the ligand drew in one flat colour while the feature worked perfectly on
  nothing.
- 🔴 **A prim's fields are dropped in silence when the GPU repacks it.**
  `paintgl.js` turns the 2D painter's prims into mesh input, and its `line`
  case copied `pts`, `c`, `w` and `sel` — losing `zBias` and `wA`. Both were
  read downstream, so both failed as a default rather than as an error: `zb`
  was always 0, which made the `- zb` correction beside it dead code, and the
  contact's near-surface bias unprojected into MODEL space as half an Angstrom
  toward the eye — along whichever way the view happened to be pointing when
  the mesh was built. It then turned with the structure. The symptom is that a
  contact is right until you rotate and snaps back the next time anything
  rebuilds the mesh, which reads as *"the old contact moves when I add a new
  one"*. Only the GPU cartoon; only after a rotation that changes DEPTH, so a
  spin about the view axis hides it completely.
- **The GPU reads the renderer as a wide untyped record** — 13 methods and ~55
  fields, with no interface declaration anywhere. Moving a field off the
  instance breaks it silently.
- 🔴 **`normalizeConfig` rebuilds `rendering` field by field, so a key it does
  not name is thrown away.** `gpu` was missing for as long as the flag
  existed — `py2Dmol.view(gpu=True)` turned nothing on — and `shade` with it.
  The carry-over loop does not save you: it walks *top-level* keys, and
  `rendering` is already in `knownKeys`. The web app hides this class of bug
  by assigning `renderer.useGPU` straight from its checkbox. `tests/config.js`
  reads the keys out of `viewer.py` and checks each one arrives.
- 🔴 **A package_data ENTRY THAT MATCHES NOTHING IS SILENT.** setuptools ships
  nothing for it and reports nothing about it, and `tests/packaging.py` could
  not see it either: `shipped_by_setup()` expands the globs against the disk,
  so a dead entry contributes nothing and every check downstream sees a set
  that simply does not mention it. Two entries outlived the bundles they named
  when the three notebook builds became one. Locally the setuptools-scm plugin
  sweeps every tracked file into the wheel and covers for it, so the omission
  would first have appeared in a release. The entries are now checked AS
  WRITTEN, before expansion, which is the only point at which they exist.
- **A comment that names a file is a pointer, and pointers rot.** The split
  left 236 mentions of renamed files behind, including one in
  `tools/extract_part.py` that still *wrote* its output to a dead path.
  `python3 tests/paths.py` checks every path named in every tracked text file.
- **A text scan matches prose.** Several tests find code with `indexOf`. One
  matched the phrase `static get ELEMENT_COLORS()` written in a *comment*;
  another matched `_extractSelection` when it wanted `extractSelection`. Prefer
  `tests/lift.js`, which finds a definition by shape.

## Tests

`zsh tests/run.sh` — about 40 seconds, three lanes: `node` (fast, no browser),
`ui` (headless Chrome probes, parallel), `gpu` (serial, they measure time).

Every assertion should be verified by breaking the code and watching it fail.
A third of one early batch passed while asserting nothing.
