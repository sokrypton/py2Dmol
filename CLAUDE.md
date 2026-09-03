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
| `parts/panel.js` | the Style panel's rows AND the Selection panel's, as data — `buildStylePanel` / `buildSelectionPanel` build the DOM. **One copy**, mounted by all three shells. The Style panel is skinned per page; the Selection panel carries its own stylesheet (`selectionPanelCSS`), because forty-six rules could not be written out three times. |
| `parts/selectpanel.js` | what the Selection panel DOES: colour, secondary structure, side chains, elements, bases, contacts, visibility, Find interactions, Align — plus the state readers it syncs from, and `wireSelectionPanel`. Was the web app's own file. Reaches its shell through `py2dmolSelectionHost({renderer, setStatus, afterChange})`. |
| `parts/viewport.js` | `setupViewport` — find the canvas, size it for the display, keep it sized. The one thing both entry points share. |
| `parts/embed.js` | the selector (`positionsFor`), `window.py2Dmol.show` and `wireEmbedUI` — a viewer on a bare canvas, and the JS API on top of it. `core/mol.js` picks between the two wirers on `config.embed`, which `show` sets from whether `controls`/`play` were asked for: with them it is `wireViewerUI` and the notebook's own panel in a scoped shell, without them a canvas and nothing else. |
| `parts/sidechains.js` | which residues show theirs — `showSidechains`/`hideSidechains`, the relative pair. Was written out in `parts/embed.js`, so only the embed's JS API could reach it. And what colour they are: `setSidechainColor`. |
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
| `src/io/bonds.js` | what counts as a bond, by element pair. Read by `parse.js` and by `core/mol.js`'s distance fallback — one answer to one question. |
| `src/io/gif.js` | GIF89a, for the capture sink. |
| `src/app/` | the browser UI. Not used by the notebook. |

### A fifth bundle: `full`

`bundles/py2Dmol.full.min.js` is **the website plus the embed API** - set for
set it is `web` and ONE module more, `parts/embed.js`. 755 KB against web's
737, so the embed half costs 18 KB: everything it needs was already in the page
for the app. For a host that wants the app's own ingestion and panels AND to
call `py2Dmol.show` / `frameFromText` / `framesFromText` / `superpose` itself -
LocalFold hands a prediction to the first and morphs conformations with the
second (`framesFromText` parses the walk once, then `replaceFrame` steps it,
which is the rule on animations against trajectories).

🔴 **THE BUNDLE IS THE EASY HALF, AND HERE IT IS THE WHOLE APP'S MARKUP.** Each
panel finds its own DOM and does nothing at all until it exists:
`#paeContainer` + `#paeCanvas`, `#scatterContainer` + `#scatterCanvas`,
`#sequence-viewer-container` + `#sequenceView`, and eight controls for the MSA -
and `src/app/` looks the website's controls up the same way. Loading this over a
bare canvas buys a bigger download and the same picture; the host is hosting
`index.html`'s markup, or the parts of it whose features it wants. Panel markup
sits BESIDE the viewer, never inside it - `show()` replaces its container's
children, which is how the first attempt at this threw `getContext of null`.

**`controls: true` IS WHAT MOUNTS THEM** on the embed path. `parts/ui.js` calls
`window.PAE.initialize` when `config.pae.enabled`, and the embed only reaches
`wireViewerUI` when chrome was asked for; with `embed: true` it takes
`wireEmbedUI`, which mounts nothing. Measured working:
`py2Dmol.show(el, text, {controls: true, pae: {enabled: true}})` against
AF-Q5VSL9's 837x837 matrix gives `renderer.paeRenderer` and a drawn plot.

🔴 **AND THE STRIP AND THE MSA ARE `document`-SCOPED** - `getElementById`, not
`container.querySelector` - so two of them on one page find each other's. The
PAE panel scopes to the container and falls back to document, which is the
pattern the other two need before an embed can honestly have more than one.

**THE HOST'S TWO DOORS INTO THE APP**, both in `src/app/main.js`:
`py2dmolLoadFiles(files, loadAsFrames, groupName)` IS `processFiles`, which
already took VIRTUAL files - `{name, readAsync}`, because a ZIP entry is not a
File either - so a page hands over a structure it computed in memory rather
than wrapping it in a File and replaying a change event on a hidden input. The
extension decides what a file IS, so the caller names its files rather than
declaring their kinds. And `py2dmolReadyMessage` replaces "Ready. Upload a file
or fetch an ID", which names two controls a host page may not have; it is read
at call time, because the message is set again on every clear.

🔴 **AND IT CARRIES `mol-align`, SO THE PAGE LOADS `align/align.js` ITSELF** -
exactly as `index.html` does, and for the reason no bundle may contain it: it
finds its own URL through `document.currentScript.src` to start its Worker, so
concatenated it has none and TM-align silently runs on the main thread. Every
method `mol-align` adds throws until that second script is loaded. This is the
one bundle whose page needs two `<script>` tags, and they are `index.html`'s two.

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
  | 11,882 | `core/mol.js` | | 2,449 | `cartoon/paint2d.js` `paintPrims()` |
  | 10,548 | `cartoon/geom.js` | | 1,926 | `cartoon/geom.js` `render()` |
  | 8,443 | `app/ (total)` | | 1,917 | `cartoon/geom.js` `drawRun()` |
  | 6,368 | `cartoon/paintgl.js` | | 1,487 | `cartoon/geom.js` `drawSticks()` |
  | 5,312 | `panels/msa.js` | | 1,087 | `cartoon/geom.js` `mergeBondRuns()` |
  | 2,878 | `io/parse.js` | | 1,052 | `cartoon/paintgl.js` `buildMeshPart()` |

  `buildMeshPart` is the old `makeResident` under its new name and it was
  always this size - the split gave it a name that says it builds ONE HALF, and
  a caller small enough to read, but the 1,018 lines are unchanged and still
  over the rule. `parts/ui.js`'s `wireViewerUI()` has dropped off this list.
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

- 🔴 **AND `tests/lift.js`'s `UTILS` IS DERIVED FROM IT NOW.** That list is
  what a node test evaluates as "the utilities", and a `src/io` file left out
  of it is a declaration missing from the blob while its callers are in it -
  green until a test reaches the line. `src/io/bonds.js` was out of it for six
  commits: evaluating the list left `bondMaxFor` undefined while `parse.js`
  called it. `bundle.py check` compares the two lists now, so the third time
  this happens it is a failure rather than a discovery.
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
- 🔴 **FOCUS IS A MODE WITH A DOOR AT EACH END, and the snapshot is taken at
  the DOOR.** It used to be taken on the first CLICK, which is a different
  moment and a different picture: enter the mode, click once, click away, and
  you were back at what the first click happened to find rather than at what
  you had before pressing the button. `enterFocusMode` records the lot -
  selection, every object's side chains, the slab, and the camera's centre and
  zoom - and then CLEARS the decorations, because a mode that starts from the
  reader's leftovers cannot be told from one that drew them: side chains turned
  on by hand look exactly like the mode's, and a slab from before cuts the
  neighbourhood the mode is about to move to. `exitFocusMode` puts back what
  still means anything - see the rule below on what a snapshot is measured
  against, which is why the camera can come back WIDER and the slab may not
  come back at all.
  🔴 **EXCEPT THE ROTATION, WHICH IS NOT THE MODE'S TO GIVE BACK.** Focus never
  turns the camera, so an angle that moved was moved by the READER - to see the
  pocket from the other side, which is half the reason to be in there - and
  snapping it away on the way out throws out the one thing they chose. It is
  not in the snapshot at all. The camera is not reset on the way IN either: the
  first click moves in from where the reader was standing.
  **THE MARK GOES TO `outline` WHILE THE MODE IS ON**, and back after. Focus
  draws the neighbourhood around the residue you clicked and moves in on it,
  and the default mark is a translucent band laid OVER that residue - a blot in
  the middle of the one thing you are looking at. It rides the same rule as the
  rotation, from the other side: focus BORROWED the mark, so focus gives it
  back - unless the reader picked one themselves while in there, which is a
  choice about how they want selections marked and not something the mode
  borrowed. The test is `selectionMark === 'outline'` on the way out: still
  wearing the mode's own, so put the reader's back. `parts/ui.js` installs
  `_syncSelectionMark` so the Sele dropdown follows the renderer as well as
  driving it - a control showing something the viewer is not doing is worse
  than no control, which is a rule this file already has three instances of.
  🔴 **AND A SELECTION ALREADY THERE IS AN INTENT, NOT A LEFTOVER.** Side
  chains and a slab are decorations somebody turned on and forgot; a selection
  says "this is what I am looking at", and pressing Focus with one is asking to
  look at it CLOSER, not to pick it again - so entering focuses it straight
  away, where entering with nothing selected moves nothing at all. That seed
  focus has to set `_focusBusy` around itself: `focusOn` sets the selection and
  `parts/ui.js` WRAPS that setter to trigger a focus, so without the guard
  entering focuses, which selects, which focuses.
  Inside the mode `clearFocus` is the way out of one FOCUS, not out of the
  mode - a click on the background zooms out and leaves you ready for the next
  click - so it restores the entry snapshot and KEEPS it. Outside the mode
  (the JS API calling `focusOn` directly) the first focus still records and
  `clearFocus` still consumes it, which is what that verb has always done.
  **And the selection panel stays away while the mode is on**: there is always
  a selection in focus - the residue just clicked - so the panel would slide in
  and sit there, with buttons acting on what is really the mode's bookmark.
  🔴 **THE MARK COMES BACK WHEN THE MODE ENDS, NOT WHEN A FOCUS DOES.**
  `_focusRestore` handed it back on every `clearFocus` - and inside the mode
  `clearFocus` is the way out of one FOCUS, not out of the mode. So anything
  that empties the selection took the outline off and left the mode running
  with the reader's mark on: **loading a structure is exactly that**, it clears
  the selection, `parts/ui.js` reads an empty selection as the background
  gesture, and the Sele dropdown dropped to Highlight while Focus stayed lit.
  `_focusMode` is already false by the time `exitFocusMode` restores, so the
  guard is `!this._focusMode` and needs no argument.
  🔴 **AND THE MODE REMEMBERS ONE FOCUS PER OBJECT.** A switch drops the
  residue selection - the indices belong to the object being left - while the
  CAMERA is per object already (`obj.viewerState`), so leaving a focused object
  and coming back parked the reader at the pocket they had focused with nothing
  marked, no side chains and no slab: the camera remembered and nothing else
  did. `_focusByObject` is written on the way out of an object and replayed on
  the way in, from `_switchToObject`'s settle frame - which is where the
  caller has finally loaded the frames. **AFTER that frame's draw, never
  instead of it**: the first version returned early when it recalled, on the
  reasoning that `focusOn` draws anyway, and `tests/interaction.js`'s rule that
  a switch releases its hold WITH a draw caught it. The memory is the MODE'S
  and dies with it, and **an empty selection CLEARS that object's slot** -
  which is the whole of "a dismissed focus stays dismissed", because a
  background click leaves the selection empty and the switch stores what it
  finds. That fell out of a mutation: a separate `_focusSwitching` flag and a
  delete in `clearFocus` were written first, and mutating the delete away
  changed nothing, because the empty store already said it.
  🔴 **AND WHAT IS RESTORED IS ONLY MEANINGFUL AGAINST THE PICTURE IT WAS
  MEASURED ON.** The snapshot records `drawn` - the object names - and two of
  its fields are checked against it. The CAMERA is widened to fit when the
  picture changed (below). The SLAB is dropped: it is a near and a far along
  the view, and put back onto a different set of objects it cuts somewhere
  arbitrary and can take the whole structure with it. There is no widening a
  slab, and the Clip button follows it off, so nothing is silently wrong.
  Everything else in the snapshot - side chains per object, the selection, the
  mark - is about residues rather than about space, and travels unchanged.
  🔴 **AND THE CAMERA IT GIVES BACK MUST SHOW WHAT IS DRAWN.** The entry
  snapshot is a camera measured on the picture that was there when Focus was
  pressed, and the picture can change under it - an eye toggle adds an object
  and deliberately does NOT re-frame ("things appear and disappear where they
  are", `parts/multi.js`, and `tests/multi_object.py` asks for it). So a click
  on the background restored a camera built for one object into a scene of
  several, again and again, with Orient the only way out: **stuck zoomed out**.
  `_focusRestore` widens to `_currentExtent()` when the snapshot no longer
  covers the picture - **and only when the DRAWN SET CHANGED**, which the
  snapshot records as `drawn`. Comparing extents alone is wrong twice over:
  materialising side chains grows the drawn extent by a few Angstrom without
  changing the picture, so `clearFocus` handed back 36 where it had borrowed 33
  and `tests/cut_ligands.py` said so; and the reader's own framing is theirs
  however wide it is. *Two of my three attempts at this rule broke a test that
  was right: re-framing on any toggle (the eye rule) and widening on any extent
  difference (the mode's contract). The condition is "the picture changed", not
  "the numbers differ".*
  🔴 **AND CHANGING WHAT IS ON SCREEN DROPS THE FOCUS - THE MODE'S ONLY.**
  `view.focus()` and the embed's `v.focus(sel)` call `focusOn` without ever
  entering the mode, and `focus()` then `show_objects()` is two instructions of
  which both were asked for, so the clear is guarded on `_focusMode`. What it
  drops is a focus a READER made by clicking, whose picture then changed under
  them. It lives inside `setShownObjects` - the one setter every route goes through, so the Multi
  button, `show_objects()` and `multi=True` all get it. A focus is a
  NEIGHBOURHOOD measured against the picture it was made in: merge a second
  structure in and the slab, cut to one residue's depth in the first, slices
  through the one that has just arrived, while the camera sits in a pocket that
  is now a corner of a bigger scene. Reported as two objects with different
  focuses merged together. The MODE stays on - the reader did not leave it -
  and the per-object memories go, because they name residues of a picture that
  no longer exists. What comes back is the mode's ENTRY baseline, which is not
  necessarily empty: the mode restores what it FOUND, so a test has to compare
  against that baseline rather than against nothing.
  🔴 **AND A SIDE-CHAIN ATOM IS ITS RESIDUE, in the neighbourhood as well as
  under a click.** Showing side chains APPENDS their atoms as real positions,
  so `residuesWithin` can return one - only when some are already out, which
  inside the mode is the restored baseline - and it was filed in the object's
  side-chain set as a residue to draw: `4HHB:748` on a 748-residue structure,
  six neighbours where the same focus finds five from a clean start.
  Self-correcting and invisible, and still not a residue; `focusOn` maps them
  through `sidechainMap` to their owner, the rule `_wholeThingAt` already
  applies to a click.
  🔴 **AND NONE OF IT EXISTS WHILE OBJECTS ARE MERGED.** There the switch does
  not drop the selection - the indices are the merged array's and mean the same
  thing whichever object is edited - and the strip SETS the edited object from
  where you clicked, so a recall would replace the selection that ASKED for the
  switch. Both hooks take `mergedMask` and answer false. The two guards cover
  different crossings: RECALL is the one a single session can hit, because a
  set stored in an object's own numbering becomes wrong the moment Multi is
  turned on; REMEMBER matters after Multi is turned OFF again, and the
  recall's range check only catches the out-of-range half of that. The renderer TRANSLATES a
  live selection when Multi goes on - residue 10 of the second object becomes
  10 + its offset, 758 on 4HHB + 1UBQ - which is exactly what a stored set
  cannot do for itself, and why a stored one must never be replayed across
  that boundary. (The focus itself is dropped on that transition anyway, by
  the rule above; the guards are what stop a memory outliving it.)
  🔴 **AND THE SEQUENCE STRIP MEANS SOMETHING ELSE INSIDE THE MODE.** The strip
  BUILDS a selection - click to add, click again to take away, drag for a range
  - and a canvas click in focus REPLACES. `baselinePositions` in
  `panels/seq.js` is "what does this gesture toggle against", and it answers
  the standing selection - so a strip click ADDED to the focus instead of
  moving it, and each click focused the UNION: three clicks on 4HHB took the
  side chains 5 -> 14 -> 23 and walked the camera to the centroid of
  everything ever clicked. In the mode the baseline is EMPTY. The way to look
  at two things at once is to leave.
  🔴 **AND CLEAR ALL DROPS THE MODE, from inside `clearAllObjects`.** The
  entry snapshot names objects that are about to stop existing, and a latch
  that outlives the clear puts the NEXT structure straight into a mode nobody
  asked for, wearing the last session's mark - reported as "leftovers from
  focus after Clear All". `_resetFocusState()` forgets the mode without
  restoring anything, because there is nothing left to restore it onto; the one
  thing it does give back is the MARK, which focus borrowed from the reader
  rather than from the structure. It lives in `clearAllObjects` rather than in
  `resetAll` or in `app/main.js` so all three shells get it, and the Focus
  button follows through `_syncFocusButton`, the same hook `_syncClipButton`
  and `_syncSelectionMark` use.
  *That leg's first assertion was wrong and the code was right*: it expected
  the mark back at `highlight`, and got `none` - which is what the reader had
  chosen before entering. Clear All resets the STRUCTURE; a mark is a
  preference, and the only thing owed is what focus took.
  `tests/focus_mode.py` builds a deliberately messy state (a selection, side
  chains on OTHER residues, a slab, a turned camera, a zoom), enters BOTH ways
  - with that selection and with none - turns the view while inside, and
  leaves. Mutated eight ways, each caught: not clearing the side chains on
  entry, restoring nothing on exit, leaving the panel visible, restoring the
  rotation, not focusing the selection that was already there, not switching
  the mark to an outline, not syncing the dropdown to it, and restoring the
  mark over a choice the reader made inside the mode.
- **FOCUS IS A COMPOSITION, AND THAT IS WHY IT IS ONE FILE.**
  `parts/focus.js`'s `focusOn(sel)` is `residuesWithin` + the object's
  side-chain set + `viewerState.center/extent` + `autoClip`, and `clearFocus`
  puts all four back from a record written on the FIRST focus only — writing it
  on every focus would make "leave the mode" restore the last neighbourhood
  instead of what was there before it. **It does not rotate**: only the centre
  and the zoom move, so clicking from residue to residue walks through a
  structure rather than spinning it, which is the whole difference between it
  and Orient.
  🔴 **THE SELECTION IS ANNOUNCED BEFORE THE STRUCTURE CHANGES, and that is
  worth 22 ms a click.** `setResidueSelection` dispatches on DOCUMENT and the
  listeners — the sequence strip, the selection panel — rebuild against
  whatever is there when they hear it. Materialising side chains APPENDS
  positions, so announcing afterwards made them all rebuild against a
  structure that had just changed under them: the same call is 0.2 ms on a
  stable structure and 47.8 right after that change, and a cold focus click
  went from 69.8 ms to 48.3 when the order was swapped. Safe in this order
  because the new positions are APPENDED, so every index the selection names
  still means the same residue. What is LEFT is one redraw of geometry that
  genuinely changed — 7.5 ms on 1UBQ, 33.5 on 4HHB — the same cost as showing
  side chains by any other route. `residuesWithin`, the interaction search
  everyone suspects first, is 0.2 ms at BOTH sizes: it is gridded, and it is
  not the lag.
  The mode is a toggle in `parts/panel.js` wired once in
  `parts/ui.js`, which WRAPS `setResidueSelection` rather than listening for
  `py2dmol-residue-selection-change` — that bus is document-scoped and would
  fire once per viewer on the page — and guards against `focusOn`'s own call to
  it. 🔴 **ONE FUNNEL, OR THE STRIP STAYS DEAD.** `panels/seq.js` wrote
  `renderer.residueSelection` directly and dispatched the change event itself —
  the same two lines as `setResidueSelection`, in a second place — so a click
  in the sequence strip went straight past the wrap and only the canvas
  transported you. `app/main.js`'s Select all did it too. Both call the setter
  now, and `tests/interaction.js` fails on a direct write to that field.
  BOTH ways out, because a click on the background calls
  `clearResidueSelection`, NOT `setResidueSelection` with an empty set. Wrapping
  only the setter left the way back working for a test that called the setter
  and dead for the gesture a reader makes.
  **The side chains need a table**, which a notebook has only with
  `view(sidechains=True)` — see the rule below.
- 🔴 **AND THE FOURTH COPY WAS IN `src/parts/selectpanel.js`.** Moving the verb to
  the renderer removed the embed's copy and gave the notebook and Python one;
  the website's own - the same `writeGroups` walk, the same
  `_invalidateSegmentCache`, the same `reloadDrawn` - was left where it was
  because it worked. It calls `renderer._setSidechains` now, keeping only the
  DECISION that is the panel's (it says "no side-chain atoms" in the status bar
  where the verb throws). `positionsFor` takes a Set, so what the panel holds
  is what the verb wants. `tests/interaction.js` fails if that file stops
  calling the verb or starts writing `obj.sidechains` again, and names the two
  files that may write it: `parts/sidechains.js` and `parts/focus.js`, which
  borrows and gives back.
- 🔴 **AND SIDE CHAINS WERE THE SAME FAULT ONE STEP WORSE: the DATA had a
  door and the VERB did not.** `view(sidechains=True)` carried each residue's
  atoms into every notebook payload — the per-frame cost, 9.0 KB to 37.2 on a
  251-residue design — and the only thing that could draw one was `focus()`,
  which picks the residues itself. `showSidechains` was written out in
  `parts/embed.js`, so the embed's JS API had it and the notebook had no way to
  ask at all. It is `parts/sidechains.js` now, a renderer method like `clipTo`
  and `orientTo` before it, and `view.show_sidechains()` /
  `hide_sidechains()` is the Python door. **They are RELATIVE and travel as an
  ORDERED LIST**, not a resolved set: show adds, hide subtracts, and with no
  selector either means every residue — so the state IS the sequence, and
  replaying it is what reproduces it. Python sends only the requests past a
  watermark on the live path and the whole list on the static one, which is
  what makes a reopened notebook come back with the same side chains out.
  `hide_sidechains()` with nothing named truncates the list, because nothing
  before a reset can still be showing — that is what keeps it bounded.
- 🔴 **A COLOUR MODE AT POSITION LEVEL WAS ALWAYS LEGAL AND NOTHING COULD SAY
  ONE.** `resolveColorHierarchy`'s `applySpec` reads a string naming a mode as
  a MODE at every level it walks — object, chain, frame, position — and
  `setSelectionColor` stores whatever it is handed, so the whole capability was
  one dropdown away. The selection panel's colour menus offer the schemes now
  as well as the swatches, which is what lets the backbone answer one question
  while a pocket's side chains answer another: `chain` on the residues and
  `hydrophobicity` on their side chains draws `#66ff66` and `#187bd1` on one
  picture. Both pickers get it; the CONTACT picker does not — a contact is one
  line between two residues and no scheme says what colour that line should be,
  so it keeps the Auto button the other two gave up.
  **AUTO IS THE DROPDOWN'S FIRST ENTRY AND IT IS A CLEAR, not the `auto`
  MODE.** They are different: the mode resolves the global scheme AT this
  position, the entry leaves the position with no opinion so an object-wide
  colour still reaches it. Two controls reading Auto a few pixels apart is a
  coin toss over which one you want, so the button went where the list arrived.
  **THE LIST IS READ OFF `#colorSelect`**, not kept here — which inherits the
  panel's hidden-until-useful decision for free: `object` means nothing with
  one structure and `entropy` nothing without an MSA, and both stay out of the
  picker because they are already hidden there.
  🔴 **AND `ss:pymol` IS THE ONE COMPOSITE VALUE THAT LIST CARRIES**, the mode
  plus the viewer-wide `ssPalette`. Stored at a position it is not a mode name,
  so `applySpec` files it as a LITERAL and the residues draw `hexToRgb` grey.
  Splitting it the way `parts/ui.js` does is no better here, because the
  palette belongs to the VIEWER: picking Jmol for four residues would repaint
  every sheet on the page. Both options collapse to one `ss` — the picker
  chooses the scheme, the panel chooses the palette.
  🔴 **AND `buildSwatches` RUNS ONCE AT WIRE TIME, BEFORE ANYTHING IS
  SELECTED.** The first version seeded the dropdown with `currentMode()` and no
  argument, which read `positions[0]` of undefined and threw inside
  `setupEventListeners` — taking every control wired after it with it.
  `tests/selection_panel.py` reported it as a panel that never opened and rows
  measuring 0px, which is what a throw halfway through the wiring looks like
  from the outside.
  Measured in that probe: the scheme is stored, it changes pixels, reopening
  the menu READS IT BACK, Auto clears it and returns the picture to where it
  started, and the two schemes resolve to two different colours. *The swatch
  assertion's first version checked only that it was not blank — which passes
  against a swatch that quietly fell back to the main chain, because the
  fallback is also a colour. It compares against the side chain's drawn colour
  now.*
- 🔴 **AN ANIMATION IS NOT A TRAJECTORY, AND `replaceFrame` IS THE DIFFERENCE.**
  Walking a structure from one conformation to another by APPENDING the
  intermediates is the obvious way and it is wrong twice: the play bar fills
  with steps that are not frames of anything, and the viewer has to be REBUILT
  to be rid of them - which loses the camera and re-runs every piece of wiring
  hung off it. `parts/ui.js`'s `handleReplaceFrame` has done it properly since
  the notebook's live path existed - pop, then `addFrame`, so the count never
  moves - and a BroadcastChannel was the only way in. It is
  `renderer.replaceFrame(frame, object)` now and ui.js calls it, so there is
  one copy of the pop and an embed can animate.
  **THE LAST FRAME, not an arbitrary index**: `addFrame` pushes, and it is
  where the alignment against the previous frame and the pLDDT/PAE tracking
  live, so replacing a frame in the middle means taking `addFrame` apart. The
  trackers are pulled back before the re-add, because between the pop and the
  push they name a frame that does not exist.
  Measured driving fourteen morph steps into a three-frame viewer: the count
  reads `[3]` throughout, the drawn structure travels 8.5 A, the last step
  lands on the frame's original coordinates to within 0, and the neighbouring
  frames are untouched. **A count check alone would pass against a call that
  did nothing**, so the travel is asserted beside it.
- **KABSCH IS A FUNCTION NOW, NOT ONLY A SIDE EFFECT OF `addFrame`.** The fit
  has been in every bundle since the browser took the viewing geometry over
  from numpy, and the only way to reach it was to ask a FRAME to align itself
  to the one before it — same shape of gap as the slab and the side chains.
  `py2Dmol.superpose(mobile, reference, {from, to})` is the door.
  **IT FITS ON A SUBSET AND MOVES EVERYTHING**, which is the case `addFrame`
  cannot do at all: that path refuses two frames of different lengths, and two
  structures of the same molecule routinely differ — a point mutation changes
  one residue's atom list. `from`/`to` are INDEX arrays naming the points the
  fit is computed from (the alpha carbons), and the transform still applies to
  every point of `mobile`, which is what lets a caller superpose a mutant on
  its parent. A bad index throws rather than reaching the arithmetic as
  `undefined`: a fit on NaN returns NaN for every atom, and a NaN structure
  draws as nothing at all.
- 🔴 **A MIXED BOND HAS TWO HALVES AND THE OVERRIDE BRANCH JUMPED PAST THE
  LINE THAT SAYS SO — IN pLDDT MODE ONLY.** A bond between a carbon and a
  heteroatom is drawn as two halves: the carbon end takes the residue's colour,
  the far end takes its element's. `_calculateSegmentColors` reaches that
  assignment by FALLING THROUGH; `_calculatePlddtColors` reaches it by not
  jumping, and its override branch did `colors[i] = ov; continue;` — with `hp`
  already computed on the line above and simply unused. So any explicit colour
  on a side chain flattened its mixed bonds to one colour in `plddt` and
  `deepmind` and nowhere else: **the oxygen lost its red and the nitrogen its
  blue**, exactly where an AlphaFold viewer lives.
  Reported against `setSidechainColor`, which is what makes it reachable on
  every side chain at once — but `setColor` on a residue did the same thing and
  always had. **The MODE is the axis, not the verb**, which is why every
  measurement in `chain` mode said the feature was fine.
  🔴 **AND `getAtomColor` RETURNING THE RESIDUE'S COLOUR FOR A NITROGEN IS NOT
  THE BUG — IT IS THE CONTRACT.** It looks like one: ask it about an appended
  oxygen with a side-chain colour set and it answers hydropathy blue rather
  than CPK red, because `_sidechainColorOf` is consulted first and answers for
  every atom of the residue whatever its element. But that answer is the BASE
  the half-bond logic composes with — `halves = {a: h.a || base, b: h.b ||
  base}` — so the non-element end has something to be. Make `getAtomColor`
  return the element colour and the CARBON half of every mixed bond turns red
  too, which breaks the path that was working. The element is a layer applied
  per bond-half, not a property of the position colour.
  *Measured on the segment ARRAY, not on pixels: shading moves every drawn
  colour off its table value, and pLDDT's own ramp overlaps the element reds,
  so a pixel count near `#ff4c4c` cannot tell oxygen from low confidence. Two
  rounds of pixel forensics said "no bug" before the array said `halves: null`.
  The sulfur count was worse than useless — S gold (229,198,64) and the
  hydrophobic band (242,201,76) are 13 apart, so a tolerance of 40 counted each
  as the other and the number moved when nothing about it had.*
- 🔴 **A SIDE CHAIN CAN CARRY ITS OWN COLOUR, AND FOR YEARS ONE FILE COULD SAY
  SO.** `obj.sidechainColor` — keyed by RESIDUE, because a side-chain atom is a
  position only while it is drawn and its index is reissued whenever the set
  changes — has been read by `core/mol.js` since the selection panel was
  written, and `src/parts/selectpanel.js` was the only thing that could write it.
  The storage, the resolution and the merge remapping were all there; the
  embed and the notebook had no door. `setSidechainColor(colour, sel)` in
  `parts/sidechains.js` is the verb, beside `showSidechains`, and the website's
  own walk calls it — the FIFTH copy to come home this way, after clip, orient,
  focus and the side-chain set itself.
  **UNSET MEANS FOLLOW THE RESIDUE**, which is the whole reason it is a
  separate map rather than a colour copied at the time: recolour a main chain
  and the side chains nobody spoke for come along, and the ones that were given
  a colour stay. That is what lets a backbone say `plddt` while its side chains
  say `hydrophobicity` — two questions on one picture, and there is no other
  way to ask both.
  **AND A MODE IS STORED AS A MODE.** The map holds a hex OR a mode name, and
  `_sidechainColorOf` resolves the name at DRAW time. Freezing it at set time
  would be harmless for hydropathy, which is a fact about the residue's
  identity, and wrong for every other mode: pLDDT is per frame, rainbow follows
  the chain scale. It resolves through **`_colorForMode`**, which is the tail
  of `getAtomColor` extracted so it has a caller — going in by `getAtomColor`
  lets the residue's own explicit colour beat the mode, which is exactly the
  thing a side-chain mode is being asked to differ from.
  **ONLY THE CARBON SKELETON MOVES**: element colouring resolves FIRST and
  returns null for carbon and for a bond's midpoint, so oxygen stays red and
  sulfur stays gold. PyMOL's behaviour, and `hideElements(sel)` is the flat
  colour.
  Measured on the CANVAS in `tests/embed.py`, **against the same side chains
  uncoloured** — the first version compared them against the bare backbone,
  which scores `showSidechains` and says nothing about the colour: two
  mutations that stopped it reaching a pixel walked straight through, because
  the atoms had still appeared. The pair that differs in one thing is coloured
  against cleared, and it doubles as the check that unset means follow the
  residue.
- **`hydrophobicity` IS A COLOUR MODE, NOT A SIDE-CHAIN FEATURE.** Kyte &
  Doolittle 1982, by three-letter residue name — which is what a structure
  carries, where a sequence is not — in **five buckets rather than a ramp**: a
  gradient over twenty residues reads as twenty slightly different colours,
  which is a picture you cannot name anything in, and the whole reason to
  colour by hydropathy is to point at a band. Orange to blue, so there is no
  second colourblind table. **What the scale does not name is GREY, not the
  neutral band** — a nucleotide and a ligand have no hydropathy, and the middle
  colour would say "neither hydrophobic nor hydrophilic", which is an answer.
  `MSE` is a methionine, because the connectivity table already knows it and a
  selenomethionine-phased model would otherwise be the one thing on screen
  drawn grey. `py2Dmol.hydrophobicityBands` publishes the five for a legend —
  a host page copying the table into itself is how a legend comes to disagree
  with the viewer beside it — and it is a GETTER, because `parts/embed.js`
  loads BEFORE `core/mol.js` and a `const` in its temporal dead zone makes even
  `typeof` throw.
- 🔴 **THE SELECTION PANEL WAS THE LARGEST CAPABILITY ONE PAGE COULD REACH.**
  Two hundred lines of markup in `index.html`, forty-six rules in
  `src/app/style.css`, a thousand lines of verbs under `src/app/` and
  five hundred of wiring inside `src/app/main.js` — and every one of those
  verbs was already in the notebook and the embed's download. Same shape as
  clip, orient, focus, the side-chain set and its colour, five sizes larger.
  It is `parts/panel.js`'s rows and `parts/selectpanel.js`'s verbs now, mounted
  by `parts/ui.js`, and `py2Dmol.view(selection=True)` /
  `py2Dmol.show(el, text, {controls: true})` are the two new doors. **44 KB**
  on the notebook bundle, which a document pays once.
  **ONE KEY FOR THE PANEL AND THE CLICK.** `selection.enabled` is read twice —
  by the constructor for `selectionEnabled`, and by `parts/ui.js` for whether
  to mount — because they are one decision: a click that changes a selection
  with nothing to show, act on or clear it is worse than no click, which is why
  picking was off in a notebook at all, and a panel that can never open is the
  "control the shared panel shows and no shell wires" fault by another route.
  Two flags is how those come apart. **Off by default**, because turning it on
  changes what a click does in every notebook that exists.
  🔴 **AND THE SKIN HAD TO TRAVEL WITH IT, WHICH THE STYLE PANEL'S DID NOT.**
  That panel is "one panel, two skins" and it works because it is a handful of
  rules per shell. This one is forty-six, and left in `src/app/style.css` a
  notebook got correct markup, working verbs and a column of browser-default
  buttons. `SELECTION_PANEL_CSS` carries them with a `SCOPE` token every
  selector sits under, so the embed can confine them to its container the way
  `SHELL_CSS` does and a page that owns its document passes nothing.
  Three things that were invisible until measured in the shells themselves:
  - 🔴 **EVERY `var()` NEEDS ITS FALLBACK.** `--btn-radius`, `--color-gray-300`
    and six others are declared on `:root` in `src/app/style.css`, a hundred
    lines above the rules that used them; the other two shells declare none, and
    an unresolved `var()` is not a default — it is an INVALID declaration,
    dropped. The Show/Hide switch came out with no border, no radius and
    `height: auto`: a browser-default button wearing the right class.
  - 🔴 **AND THE PANEL STATES ITS OWN `line-height`.** `viewer.py` wraps every
    notebook viewer in `line-height: 0` — right for a div holding a canvas,
    since an inline-block leaves a text gap under it — and it INHERITS. Every
    row caption came out 74px wide and ZERO high: controls with no names, in
    the notebook only, while the width said the stylesheet had arrived.
  - 🔴 **AND THE SCOPE IS `CSS.escape`d, BECAUSE A NOTEBOOK'S ID IS A UUID.**
    `#3f2b1c…` is not a valid selector, so every rule under it is dropped — and
    a uuid4 begins with a digit about six times in ten, so the same code drew a
    correct panel or a bare one at random. `tests/selection_shells.py` passed
    twice and failed on the third run against unchanged code; it pins an id
    beginning with a digit now, so the hard case is the only case.
  🔴 **AND THE ICONS ARE INLINE SVG.** Copy, Cut and Delete were
  `<i class="fa-solid …">`, and `index.html` is the only shell that loads Font
  Awesome — an icon button whose glyph does not load is an empty square that
  deletes things. `tests/selection_panel.py` already had that rule and checked
  it as a FONT FAMILY, which is the one spelling of it that cannot travel; it
  measures the drawn mark now.
  **What does NOT travel: `runAlign`**, which needs `align/align.js`, and that
  file can never be in a bundle. The row is built everywhere and `syncAlignRow`
  hides it when `window.Align` is absent — the same shape as `needs2d` dropping
  Draw from a GPU-only build.
  `tests/selection_shells.py` drives the two shells that never had it — the
  page `_display_viewer` writes, and a bare host page calling `show()` with
  `controls: true` — and mutating away the stylesheet, the fallbacks, the
  line-height, the escape, the icons' contents, the width ceiling, the mount
  gate and the wiring call each fail it.
  🔴 **AND IT IS A SECTION, NOT A CARD, IN EVERY SHELL BUT THE WEBSITE.**
  Reported as *"it still appears as a separate panel"*. On `index.html` it has a
  ~340px column of its own beside the structure, among other boxes that look the
  same — the PAE plot, the scatter — so a card is right. In the notebook's 180px
  control column and the embed's 190px one the same card was a bordered white
  box INSIDE a bordered white box: two frames around one stack of controls. The
  shared skin is the COLUMN form — full width, no border, no ground, and a
  hairline above to say a new group starts, which is the device the panel
  already uses between its properties and its actions — and it is at **zero
  specificity**, so `.container-box` (0,1,0) wins. **What puts the card back is
  that class**, which `buildSelectionPanel` has always emitted and only
  `index.html` defines; a `.selection-panel` rule was written in
  `src/app/style.css` for it and **measured as a no-op**, so it is not there.
  Dropping padding also gave the rows their width back: the notebook's main-chain
  row went 88px to 58.
  🔴 **AND IT WAS STILL WEARING THE CARD'S METRICS IN A CONTROL COLUMN.**
  Reported as *"the buttons are not on the same row, and the style differs from
  the others"* — one cause, two symptoms. The panel is sized for its 340px card;
  `viewer.html`'s column is **180px** and the embed's **190**, and beside their
  own controls it was wrong on every count:

  | | the shell's | the panel's |
  |---|---|---|
  | row caption | 52px | 74px |
  | select / button | 24px high | 26px |
  | toggle face | 22px high | 26px |

  So a row could not fit and broke wherever it happened to — a caption and a
  lone swatch on one line with the switch on the next, and the main-chain row on
  **three**. **A 180px column cannot hold a caption, a swatch, a Show/Hide pair
  and a select side by side; that is arithmetic, not styling.** The caption takes
  the whole first line and the controls share the second, which uses the width
  and reads as a labelled group: every row is now **45px, one line of controls**,
  at the shell's own 24px.
  **A CONTAINER QUERY, NOT A PER-SHELL COPY.** The constraint is the panel's own
  width, so that is what is asked — one rule, no numbers duplicated into
  `viewer.html` and `parts/embed.js` to fall out of step, and it is right for a
  shell nobody has written yet. The website's 322px content is over the 260px
  breakpoint, so its card is untouched, measured.
  🔴 **AND THE BLOCK MUST BE LAST IN THE STYLESHEET.** Its declarations are the
  same specificity as the ones they replace, so ORDER is the only thing deciding
  them. Written where it first went — above those rules — the heights took
  (nothing else set those) and the caption width and switch height did not: half
  a restyle, looking exactly like a container query that was not matching.
  **What is load-bearing is the padding and the swatch width, measured.** A
  `flex: 0 1 auto` on the pair was written first on the reasoning that a control
  which would rather wrap than lose four pixels is the problem; **removing it
  again changed nothing**, because with the caption on its own line the controls
  already fit. It is not there. Mutating the button padding or the swatch width
  back to the card's values does break the main-chain row, which is what keeps
  those two honest.
  🔴 **AND THE PROBE'S OWN `labelWidth == 74` ASSERTION FAILED AGAINST THE FIX.**
  It was there to prove the stylesheet had arrived; 74 is the CARD's number, and
  in a column the caption is full width by design. It asks for full width now,
  which proves the same thing — an unstyled span sizes to its text, about 59px.
  🔴 **AND THE HEAD SAYS NOTHING ABOUT THE SELECTION NOW.** The count ("3
  residues") was the last thing left there after the residue ranges came out,
  and it went for the same reason: the sequence strip below already shows what
  is selected, in the place made for showing it, and a number over the top of
  that is a second answer to a question nobody asked twice. The element stays
  and is left EMPTY — the head's flex layout uses it as the stretching middle
  between the title and the three actions.
  🔴 **AND THE SIDE-CHAIN ROW SPENT FOUR ROUNDS ON A GAP THAT WAS NOT A GAP.**
  A nucleotide showing its real ATOMS carries five things — caption, swatch,
  Show/Hide, Plate, Elem — and the row wrapped. Three fixes came and went: Elem
  alone falling to a second line was the report; giving Plate and Elem a line of
  their own read as two answers to one question; welding all three into one
  segmented strip read as **partial buttons**, because a group with a single
  border leaves its members flat and they stop looking like controls.
  **THE ROW WAS 46px WIDER THAN IT LOOKED.** A toggle is a `<label>` whose
  visible face is the `span` inside it — the checkbox is invisible — and the
  label carried `padding: 0 10px`, which is space OUTSIDE the button that still
  belongs to it. Two of those plus the row's gap is **25px of air between two
  buttons 46 and 45 wide**, and the box measures 66 while the thing you can see
  measures 46. A `min-width: 54px` did the same on the other side, padding a
  46px button out with nothing in the extra 8. With both gone the row has 46px
  to spare, every gap is the row's own 4px, and **the caption and the paddings
  went back to what they were** — all three had been trimmed to buy pixels the
  row never actually needed.
  🔴 **AND THE PANEL IS 152px WHERE IT WAS 193, from the same discovery.** The
  caption had been given a line of its own on every row in a narrow column,
  because a caption, a swatch and a Show/Hide pair did not fit 170px — and they
  did not fit only because of that phantom padding. Inline again, at a fixed
  66px (what the widest caption needs: "Side chains" is 59px in `viewer.html`'s
  font and 65 in the embed's), every two-control row is ONE line of 24px.
  **The last pixel comes from the row gap, 4 to 3**: 66 + 3 + 24 + 3 + 73 = 169
  in a 170px row, and at a 4px gap it is 171 and wraps. Rows with THREE controls
  beside the caption — the main chain's SSE menu, a nucleotide's Plate — still
  take two lines, and no styling changes that at 180px.
  🔴 **AND A CONTAINER QUERY CANNOT STYLE ITS OWN CONTAINER.** The panel's `gap`
  and `padding` were written into that block to save another 4px and measured as
  no change at all: `container-type` on `.selection-panel` makes it a container
  for its DESCENDANTS, so a rule for `.selection-panel` inside `@container`
  matches nothing. Every rule around it took, which is what made it look like a
  value being overridden rather than a selector matching nothing.
  🔴 **AND NO TEST COULD HAVE FOUND IT, because they all measured the BOX.**
  The gap a reader sees is between the coloured rectangles, and those differed
  from the flex row's gap by 20px. `tests/selection_panel.py` measures the FACE
  now — `faceX`/`faceRight` — and requires the gaps to be small AND equal:
  equality is the tell that nothing is carrying padding of its own. It is
  guarded on the three being on one line, because off it an x is a distance to
  something on another row and reports `-251px` beside the real failure.
  🔴 **AND FORTY-TWO LOOKUPS WERE `document`-SCOPED, which is the third time.**
  The strip and the MSA already are. `embed.html` holds two viewers with chrome,
  and `getElementById` answers with the first in document order — so a click in
  the controls example opened the PLAY example's panel five sections up the page
  while its own stayed shut. From the reader's seat, **clicking did nothing**.
  `byId` scopes to the viewer's container and falls back to the document.
  **A ROOT NAMED AT WIRE TIME IS NOT THE FIX** — it only changes which viewer
  wins, the last built instead of the first in the document, and neither is the
  one that was clicked. Each panel CLAIMS the host from a **capturing** listener
  on its own container, so by the time a control's handler runs the host answers
  for the viewer being touched; capture also covers controls built later, which
  the colour cells are. The `-residue-selection-change` bus is dispatched on
  `document` and travels through no container, so its listener claims explicitly.
  🔴 **AND THE PLAY-ONLY EMBED WAS MOUNTING ONE INTO A HIDDEN COLUMN.**
  `selection.enabled` was `wantsChrome`, which is true when `play` was asked for
  — and `parts/embed.js` then HIDES the control column, because the play strip
  is in the same shell. The panel was invisible and still first in the document,
  which is the whole of the damage above. It follows `opts.controls` now, the
  same thing that decides whether the Style panel is visible.
  🔴 **AND A RAW BACKTICK IN `SELECTION_PANEL_CSS` PARSES.** The literal holds
  forty-six commented rules, and a comment quoting a class name in backticks —
  the way every comment in this project does — ENDS the template literal; what
  follows is read as JavaScript, so the file is valid and `node -c` passes,
  while loading it throws `ReferenceError: box is not defined` and the panel has
  no stylesheet at all. **Three times.** `tests/bundles.js` now EVALUATES
  `parts/panel.js` and asks its stylesheet for a length, a substituted scope and
  the section rule — the bundle-level "threw while loading" check already caught
  it, but said only `box is not defined`.
  🔴 **AND THE PROBE'S FIRST LAYOUT ASSERTIONS WERE MEASURING THE CONTAINER.**
  It asked whether the rows wrapped, and both new shells fail that while being
  perfectly right: the panel has its own ~340px column in `index.html` and gets
  180px in `viewer.html`, 190 in the embed, where every row of those shells'
  own controls wraps too. What was actually lost is a COMPUTED STYLE — a
  fixed-width caption, a rounded switch, a swatch with a size — and none of
  those depends on how wide the column is. The panel does need a ceiling
  (`max-width: 100%`) or its stated 340px hangs out of both.

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
- **ONE PANEL, ONE CONTROL HEIGHT, AND THE WEBSITE WAS THE ODD ONE OUT.** The
  Style panel's dropdowns ran at **28px** on the website and **24** (`--ctl-h`)
  in the notebook and the embed, and its toggles at **30** - `--btn-height`,
  which is the toolbar's height and right for Orient and Capture, targets you
  hit, and too tall for a row of settings. All of it is 24 now, measured rather
  than eyeballed: three dropdowns at `1 1 0%`, height 24, font 12, padding
  `0 8px`.
  Two things were making them differ and neither was visible in the markup.
  **`#colorSelect` carried a rule it shared with `#objectSelect`** - 14px text,
  `width: 170px`, `flex-shrink: 0` - and the panel override fixed the height and
  the font but not the width or the shrink, so Color refused to give ground
  while Sele beside it did. It takes the panel's own rule now, and the hover and
  focus states that only IT had were promoted to every control in the panel
  rather than dropped from it. **And the SSE palette is a `<button>`, not a
  `<select>`** - it shows five colour chips - which `viewer.html` and
  `parts/embed.js` both handle by styling `select, .controlButton` together.
  The website styled only the selects, and `parts/ui.js` then stated the row's
  height and padding INLINE (24px, `2px 4px` - the notebook's metrics), which no
  stylesheet can correct. It copies the reference select's padding and height
  along with its border and font now, so it matches whatever shell it is in.
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
- 🔴 **A STORED PAE BOX IS IN RESIDUES; EVERYTHING ON THAT CANVAS IS DRAWN IN
  CELLS - AND THERE ARE FIVE CROSSINGS, NOT THREE.** The entry below found
  three and fixed the drawing that was reported; the same box is drawn TWICE
  and the panel rules chain lines from a third walk, and neither was told.
  `_drawSelectionBoxes` multiplied residue indices by a cell width, so the
  black rectangle framed a region 1.2x out from the highlight it was framing
  on a 360-residue matrix resampled to 300 - reported as "the box showing the
  selection is not matching selection", from a notebook, which is the only
  place a resample happens. `_drawChainBoundaries` walked `n` CELLS while
  indexing the chain array by RESIDUE, so it missed every chain past cell 300
  and ruled the ones it found at the wrong column. `render()` converts ONCE
  now and hands cells to both drawings, which is the only shape of fix that
  stops a sixth appearing.
  **The probe that covered this measured the MASK, and the mask was right** -
  the two drawings are a few lines apart and only one had been checked. The
  outline is measured as the pixels that got DARKER (the overlay only
  lightens) and the chain line as a spike against its own neighbours (a
  gradient has none), both on the canvas, for the reason below.
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
- 🔴 **THE BEST-VIEW SEARCH READS THE CANVAS ASPECT AND THE FRAMING DID NOT.**
  `xProjectedExtent` and `yProjectedExtent` were both the isotropic radius, so
  the structure was fitted into a SQUARE of side `min(w, h)` whatever the
  window was: a 598x298 viewer laid a rod along its long side, correctly, and
  then drew it across 280 of its 598 pixels. `extentAspect` is the other half —
  the shape, measured ONCE by `parts/orient.js` under the rotation it chose,
  normalised so the longer axis is 1, and stored beside the extent. Absent, it
  is 1:1 and the arithmetic is what it always was.
  - **Measured about the CENTRE, not the origin.** The first version took
    `max|x|` of the rotated coordinates as written, and a PDB sits wherever
    its file put it — both spans came out dominated by that offset. The
    synthetic rod hid it by being centred on its own long axis; an off-origin
    globular fixture is in the probe for that reason.
  - **Once, not per frame.** Per frame means the picture growing and shrinking
    under a drag and a tumbling trajectory breathing. The cost is that the
    framing belongs to that rotation: turn a long structure end-on afterwards
    and it can overrun the edge. Orient reframes it, which is what PyMOL does.
  - **It spends the margin the isotropic fit used to leave.** The ink is wider
    than the positions it is drawn around, so a fit that is exact on the points
    clips the drawing — 1UBQ came out touching the canvas edge on the first
    attempt at the exact 2D fit. The probe asserts nothing touches an edge.
- **THE VIEW SPAN HAS ONE READER, ONE WRITER AND ONE CONVERSION.**
  `_viewHalfSpan()` reads it, `setViewSpan()` writes it, and `halfSpanOf(extent,
  aspect, zoom)` is the multiplication between the fields a caller MEASURES in
  and the pair everything else works in. That last one was written out six
  times - twice in orient (jump and flight), twice in focus (the move and the
  snapshot restore), twice in the session restore - and `extent * aspect.x`
  now appears exactly once in the tree.
  🔴 **AND THE NODE HARNESSES HAVE HAD TO LEARN ABOUT A NEW CALLEE THREE TIMES
  RUNNING**: `_viewportScale` when geom.js started asking for it, `_viewHalfSpan`
  when _viewportScale started, and `halfSpanOf` when both did. `tests/smoke.js`
  and `tests/paint_trace.js` hand `cartoon/geom.js` a stub renderer, so every
  hop the shipped code takes has to be lifted with it. **Lift it, never
  reimplement it** - a fixture that did this arithmetic itself would be exactly
  the second convention the whole exercise removed.
- **AND THE FLIGHT CARRIES TWO NUMBERS NOW, NOT SIX.** `rotationAnimation` held
  `startExtent`/`targetExtent`, `startAspect`/`targetAspect` and
  `startZoom`/`targetZoom`, interpolated three ways, with the start pair
  captured by fifteen IDENTICAL lines in both branches of the setup. It is
  `startHalf`/`targetHalf` - the view span the renderer actually draws from,
  read once from `_viewHalfSpan()`, which means a flight begins at what is ON
  SCREEN rather than at a reconstruction of it.
  **THE ZOOM SETTLES ON THE FIRST FRAME AND IS NOT ANIMATED.** It is the
  reader's multiplier, not a movement, and the span already carries it - so
  writing the target zoom at once changes how the framing is SPLIT between the
  two stored fields and not what is drawn. One fewer thing interpolating, and
  the geometric-versus-linear fight between zoom and extent cannot recur.
  🔴 **HOISTING THE CAPTURE ABOVE THE BRANCH BROKE IT, AND THE CHECK SAID SO IN
  ONE LINE.** The duplicated block reads `targetExtent`, `targetAspect` and
  `targetZoom`, which the branch below it had not finished computing - so the
  flight left and returned to the same view span: `span 0, strays outside its
  endpoints by 8.298`. It belongs AFTER the branch, where the target locals are
  final. *Two lines of duplication would have been the lesser evil; the check
  is what made the hoist safe to attempt at all.*
- 🔴 **`rendering.ortho` WAS NORMALISED, DOCUMENTED THREE TIMES, AND READ BY
  NOTHING.** `viewerState.ortho` was seeded `this.orthoSlider ?
  parseFloat(this.orthoSlider.value) : 1` in FOUR places - so an embed and a
  notebook, neither of which has that slider, were always orthographic whatever
  the config said, while `normalizeConfig` carried the key, `viewer.py`'s
  signature documented `ortho=0.5` and `embed.html` offered it. Same family as
  the `gpu` and `shade` keys, except that this one was promised on three
  surfaces at once.
  `_orthoSetting()` answers it in one place - the slider where there is one,
  the config where there is not.
  **AND THE FOCAL LENGTH HAD TO FOLLOW, or the setting is only half wired.**
  It is `stdDev * 2 * mult(ortho)` and only the SLIDER'S handler ever computed
  it, so a config asking for perspective would have got the 200 default: a
  camera at a distance with no relation to the structure in front of it. It is
  recomputed in `addFrame`, beside `_recomputeObjectStats`, because that is
  where stdDev becomes known - and the arithmetic is `focalLengthFor()` now,
  which the slider calls too.
  🔴 **"EXPLICITLY PROVIDED" WAS NOT AVAILABLE AS A GET-OUT.** The safe-looking
  fix is to honour the key only when a caller passes it, leaving defaults
  alone - and `viewer.py` has `ortho=0.5` as a DEFAULT ARGUMENT that it sends
  unconditionally, so every notebook would have counted as explicit. There was
  no version of this that changed no pictures; it was a decision, not a
  refactor, and it was taken deliberately: **every embed and notebook is now
  perspective 0.5 by default**, which is what the documentation always said.
  Measured in `tests/embed.py` as THREE SETTINGS, THREE PICTURES - reading the
  field back passes against a value that is stored and never projected with.
- 🔴 **`frame` IS A TRAJECTORY FRAME. THE VIEWPORT'S IS A VIEW SPAN.** The word
  was doing both jobs - `frameScaleMul`, `framingOf`, `setFraming`, "the
  framing" in a dozen comments - beside `object.frames[currentFrame]`, which is
  the thing this project animates. A helper called `frame()` in
  `parts/orient.js` was shadowed eighty lines later by
  `const frame = object.frames[currentFrame]` INSIDE the function that needed
  it, and the call read `frame is not a function` - a shadowed binding, which
  looks nothing like a missing one and sends you hunting for a load-order
  problem. `setViewSpan`, `_viewHalfSpan`, `viewSpanOf`, `viewScaleMul`,
  `setViewTransform`, `spanFit`. **`frameExtent` in orient.js keeps its name**,
  because it really is the current trajectory frame's extent - the rule is
  about which meaning, not about the letters.
- 🔴 **`extent`, `extentAspect` AND `zoom` ARE FOUR NUMBERS THAT PRODUCE TWO,
  AND THE SLACK BETWEEN THEM IS WHERE EVERY CAMERA BUG IN THIS FILE LIVED.**
  The scale is `padding * min(w / 2hx, h / 2hy)` where `hx = extent *
  aspect.x`, and dividing by `zoom` is the same as multiplying the scale by it
  - so the whole framing is ONE PAIR of half-spans in Angstrom, and four fields
  were spelling it. `renderer._framingHalfSpan()` is that pair, and the places
  that used to combine the fields themselves ask it instead.
  The bugs it makes inexpressible, all of them from this session: orient and
  focus normalising the aspect differently; the aspect assigned on completion
  while the extent interpolated; a session saving the extent and not the
  aspect; a cached mesh dividing out the size and not the shape; a linear zoom
  ramp against a geometric extent.
  **THE GPU MULTIPLIER IS NOW ONE DIVISION.** `frameScaleMul` was
  `capExtent / liveExtent`, then that times a shape term, and it still missed
  the zoom - three ways for a reused mesh to be drawn at the wrong size and two
  of them were. It is `spanFit(live) / spanFit(captured)` now, and
  `resident.capAspect`, `resident.capZoom` and the whole `viewZoom / capZoom`
  term are gone with it: the half-span carries all three, so dividing the zoom
  out again would apply it twice.
  **PROVED BY CHANGING NOTHING.** `paint_trace` reports eleven fixtures
  byte-identical, the cached-mesh ratio is 1.0000000000000002, and a flight
  measures 4.239 -> 12.537 exactly as it did before. A step that unifies
  representations must be measurable as a no-op or it is a rewrite wearing a
  refactor's clothes.
  🔴 **AND THE NODE HARNESSES LIFT WHAT THE RENDERER CALLS, so a method that
  gains a sibling breaks them.** `tests/smoke.js` and `tests/paint_trace.js`
  hand `cartoon/geom.js` a stub renderer and lift `_viewportScale` out of the
  source; it now calls `_framingHalfSpan`, and both had to lift that too. Same
  failure as when geom.js first started asking the renderer for its scale at
  all - the fixture must grow whatever the shipped code reaches for, and
  lifting rather than reimplementing is what keeps one answer.
  **What is NOT unified, deliberately**: rotation, centre, and the projection
  pair (`ortho` + `focalLength`) are different quantities and stay apart. Only
  the framing triple collapses.
- 🔴 **THERE WERE THREE MAGNIFICATION CONTROLS AND ORIENT ANIMATED ALL OF
  THEM.** `_viewportScale` returns `baseScale(extent, aspect) * zoom`, and
  under perspective the picture is scaled AGAIN by `focalLength / (focalLength
  - z)`. A flight moved every one: the extent, the zoom (linearly, to 1.0), and
  the focal length - which came from `object.stdDev * 2 * multiplier` and was
  re-derived every frame from a stdDev interpolated toward the framed subset's.
  Reported as sudden zoom in and out during Orient.
  **THE FOCAL LENGTH IS THE ONE THAT MATTERED, and it is gone.** Measured on
  dev.html flying to a 40-residue selection: scale 6.81 -> 12.71 while
  focalLength 521.5 -> 283.4. Neither overshoots alone, and the second is
  DEPTH-DEPENDENT - near parts of the structure inflate while far parts deflate,
  which is what "sudden zoom in and out" is. Perspective strength belongs to the
  structure and to the reader's ortho slider, not to whichever subset is being
  framed; re-deriving it from a selection makes the slider's meaning drift.
  Removed outright rather than deferred to the end of the flight - there is
  nothing left to keep in step with. `focalLength` now reads 521.5 for the whole
  flight.
  **AND THE ZOOM JOINED THE GEOMETRIC PATH**, because a geometric ramp times a
  linear one is not monotonic. Honest note: measured, this one is worth almost
  nothing on its own (overshoot 0.06 against 0.02) - it is right because
  magnification is multiplicative, not because it fixed the report.
  🔴 **AND EVERY MEASUREMENT I TOOK FOR THREE ROUNDS WAS IN THE WRONG SHELL.**
  `viewerState.ortho` is seeded ONLY from the ortho slider (four places, all
  `this.orthoSlider ? parseFloat(...) : 1`), so **an embed and a notebook are
  always orthographic** and `py2Dmol.show({rendering: {ortho: 0.5}})` does
  nothing - `normalizeConfig` carries the key and nothing reads it. Every probe
  I wrote used the embed, where the term I was hunting is switched off, and
  they all came back clean. The website has the slider and defaults to 0.5.
  **Measure the shell that was reported.** (The config gap is still there and
  is deliberately not fixed: reading it would flip every embed and notebook
  from orthographic to perspective, which is a change to every existing
  picture.)
  🔴 **AND `renderer.focalLength` IS NOT `renderer.viewerState.focalLength`.**
  Orient wrote the first; the projection reads the second. Those writes did
  nothing on their own and the effect arrived through a synthetic
  `orthoSlider.dispatchEvent(new Event('input'))`, which recomputes the real
  one. A probe reading the wrong field showed 521.5 -> 283.4 before and 0.0
  after, and 0.0 was the field being unwritten rather than the perspective
  being broken.
- 🔴 **A FLIGHT IS ONE MOVEMENT, AND INTERPOLATING ITS PARTS SEPARATELY IS WHY
  ORIENT OVERSHOT.** `animateRotation` had four branches writing
  `viewerState` directly - centre and extent each on their own linear ramp, an
  exact-target branch at progress 1, and a fourth clearing the centre near the
  end. They disagreed about which fields move together, which is how the aspect
  came to be assigned only on completion. `cameraAt(from, to, t)` is the whole
  of it now, and the maths is the point:
  **MAGNIFICATION IS 1 / EXTENT, so a linear ramp in extent is not a linear
  ramp in zoom.** 38 A to 8 A linearly spends half the flight going 38 -> 23,
  which is 1.6x, and delivers the remaining 2.9x in the second half - the
  picture creeps, then rushes. Zoom is multiplicative, so the even path is
  geometric: `e(t) = e0 * (e1 / e0)^t`.
  **AND A PAN MUST BE EVEN ON THE SCREEN, NOT IN THE MOLECULE.** Moving the
  centre linearly while the extent shrinks fivefold makes the last frames cover
  five times the screen distance of the first; with the zoom on top, that reads
  as the camera swooping out and back. Screen speed is `(dc/dt) / e`, so
  `dc/dt` must be proportional to `e(t)`, and integrating gives the pan weight
  `w(t) = (k^t - 1) / (k - 1)` with `k = e1 / e0`. At `k = 1` it is 0/0 and the
  answer is `t`; near 1 it is numerically poor, hence the explicit branch.
  This is the core of Van Wijk & Nuij's smooth zoom-and-pan, without the part
  that also chooses the DURATION - that stays the rotation's, which is what
  keeps a flight feeling like one movement rather than two.
  **MEASURED AS TWO RATIOS, because the easing modulates both and neither is
  constant on its own.** The per-frame magnification RATIO comes out 1.04
  across a flight (geometric), and the pan measured in SCREEN units against the
  zoom measured in LOG units keeps step to 1.1 over the middle 60% - the ends
  are excluded because both go to zero there and their quotient is 0/0.
  🔴 **AND `extentAspect` MUST MEAN ONE THING.** `parts/orient.js` normalises
  it by the extent (the exact fit) and `parts/focus.js` was left normalising by
  `max(hx, hy)` - so a focus handed the viewer an aspect a fifth looser than an
  orient's and moving between them stepped. One convention, in both.
- 🔴 **A FLOOR ON THE EXTENT THAT DOES NOT ALSO FLOOR THE SHAPE IS NOT A
  FLOOR.** `focusCamera` clamps the extent to `FOCUS_MIN_EXTENT_A` (8 A) so
  that every focused residue is drawn at the same magnification - and measured
  the aspect RAW, from the neighbourhood's own blob, which at that size is
  noise. Three consecutive clicks gave `(0.431, 1)`, `(1, 0.861)`, `(1, 0.874)`;
  the scale is `min(w / ax, h / ay) / (2 * extent)`, so that noise went straight
  into the magnification and **the zoom swung 10-15% on every click while the
  extent never moved off 8**. Reported as clicking from side chain to side
  chain zooming in, moving, and zooming back out. The half-spans take the same
  floor now, so a neighbourhood smaller than it comes out isotropic - which is
  what it IS, since what gets framed is the floor's sphere and not the residue -
  and continuous across the boundary, because a half-span at exactly the floor
  is unchanged by the max().
  **THE INVARIANT IS `scale x extent`, NOT THE SCALE.** Neighbourhoods really
  do differ in size and a bigger one SHOULD draw smaller; what must not vary is
  the rest. Measured across four clicks: `143, 143, 143` after, against
  `143, 166, 164` before. `tests/focus_mode.py` asserts it on SINGLE residues -
  the gesture that was reported - and deliberately not on a RUN of them, which
  is a chain segment and genuinely elongated. *The first version of that check
  used runs and failed against correct code.*
  🔴 **AND THE OVERSHOOT I WENT LOOKING FOR WAS NOT THERE.** "Zooms in, moves,
  then zooms back out" reads as a camera that overshoots, and the obvious
  suspect is interpolating `min()` of two terms - so I measured the path per
  frame and found it monotonic on every move, overshoot exactly 0. The wobble
  was BETWEEN clicks, not within one. A step check would not have found it
  either: the swing arrives smoothly. **Measure the thing that was described,
  not the mechanism you suspect.**
- 🔴 **THE SCALE IS A FUNCTION OF TWO THINGS AND ONLY ONE OF THEM WAS MOVING.**
  Once `_viewportScale` read `extentAspect`, the drawn size depended on the
  extent AND the shape - and three separate places were still treating the
  aspect as something you assign rather than something you travel through.
  Each was invisible before the aspect mattered, and each surfaced the moment
  it did.
  **(1) THE CACHED MESH.** `cartoon/paintgl.js` draws a resident mesh at
  `capExtent / liveExtent`, on the reasoning that the base scale is
  padding*size over 2*extent so the extents divide out exactly - true while
  the fit was isotropic. `aspectSpan` is the rest of it, and `resident.capAspect`
  is what it is measured against. Measured on 1TIM in a 560x300 box: orienting
  to a selection wanted 8.280 px/A and drew at 6.593, and only a rebuild put it
  right. **Reported as the zoom not animating and needing the box resized.**
  **(2) THE ORIENT FLIGHT.** `extent` was interpolated in every branch and
  `extentAspect` was assigned on COMPLETION, so the flight rotated smoothly and
  the size stepped onto its final value. Measured: the biggest single-frame
  step was 2.409 of a 6.536 span and it was the LAST frame; interpolated, the
  final step is 0.002 and the biggest has moved to the middle where an eased
  curve is steepest. **Reported as "it would first rotate then JUMP to new
  size".**
  **(3) THE FOCUS MOVE.** `focusMoveTo` lerped the centre and the extent and
  SNAPPED the aspect, under a comment saying the shape belongs to the target
  and lerping it would make the picture "breathe sideways". **Nothing here
  scales anisotropically** - the aspect only decides which side of the viewport
  binds, and what comes out is a single isotropic scale - so the snap was a
  step in the ZOOM, on every click, because every neighbourhood has a different
  shape. Measured: 44%, 32% and 15% of the whole change in one frame, against a
  uniform 10-13% once interpolated. **Reported as an abrupt zoom in and out on
  each click on a side chain.**
  **A NULL ASPECT INTERPOLATES AS {1, 1}**, in all three, because absent means
  isotropic - a step to or from "unset" is still a step.
  🔴 **AND A TEST THAT WAITED ON `!!extentAspect` WAS WAITING FOR THE WRONG
  THING.** `tests/python_multi.py` used it as a proxy for "the flight has
  landed", which was sound while the aspect was assigned once on completion and
  wrong the moment the flight started interpolating it: non-null on the FIRST
  frame, so the measurement landed 300 ms into a flight and reported the rod at
  6% of the width. It waits for the aspect to SETTLE now - the same value twice,
  a few frames apart - which needs no internals and cannot rot the same way.
  *The fix for a jump broke the test's idea of "arrived", not the framing.*
  **The regression checks measure a SHAPE, not a number**: the biggest
  single-frame step as a share of the whole change, with the easing's own
  steepest frame (about a sixth over a twenty-frame flight) as the yardstick.
  And each needs **a wide box** - on a near-square canvas the same side binds
  whatever the aspect is, so the first version of the framing check passed
  against the bug it was written for.
- 🔴 **THERE WERE THREE PLACES COMPUTING THE VIEW SCALE, AND THE THIRD WAS THE
  ONE THE CARTOON DRAWS THROUGH.** The GPU tube path computes its own (it never
  reaches the 2D block), the 2D block computed the same padding, extent and
  `min()` a thousand lines later - and `cartoon/geom.js` kept a third, which is
  the one every cartoon actually runs. The aspect fix was written into the
  second and measured as NO CHANGE AT ALL on the default build; consolidating
  the first two left the third still saying
  `min(w, h) * 0.9 / (2 * extent)` - the same extent on BOTH axes, which is the
  isotropic fit `extentAspect` exists to replace.
  So the aspect was measured by `parts/orient.js`, stored on the viewer state,
  read by `_viewportScale`, and then not used by the style that draws.
  **Reported as Orient zooming out too much**, and measured on a 520x360
  viewer: 1UBQ occupied **0.48 of the canvas and now occupies 0.69**, 1TIM
  0.61 -> 0.87, 6MRR 0.52 -> 0.74. 4HHB does not move, correctly - its aspect
  is 0.99:1, so there was nothing to give back.
  `_viewportScale` is the only place with the formula now and has three
  callers. **The change cannot clip, by construction**: with `aspect` absent it
  is arithmetically what it was (which is why `paint_trace` reports eleven
  fixtures unchanged), and where an aspect exists the binding axis keeps its
  own term while the other's grows - `xE >= hx` and `yE >= hy` always, since
  the extent is a 3D radius and no projection exceeds it.
  🔴 **AND `cartoon/geom.js` NOW NEEDS A RENDERER METHOD, which the node
  harnesses do not stub.** `tests/smoke.js` and `tests/paint_trace.js` hand it
  a plain object; they lift `_viewportScale` out of the source with
  `lift.js` rather than writing a second copy into the fixture, which is the
  whole point. `_viewportScale` guards `this.drawnStats` for the same reason -
  the copy it replaced in geom.js did.
  **What is still on the table is the 3D radius itself.** `visibleExtent` is
  the distance to the farthest atom from the CENTROID, not the projected
  half-span, so a globular structure reserves room for the atom pointing at the
  camera: 1UBQ uses 0.69 of a 0.90 padding, so about a quarter of the allowed
  span is still unspent. `parts/orient.js` says so in its own comment and
  declines it deliberately - the exact 2D fit CLIPPED 1UBQ, because the ink is
  wider than the points it is drawn around, and spending it needs the margin
  worked out in PIXELS against the style's own line width. Not attempted here.
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
- 🔴 **RE-RUNNING A CELL REPLACES ITS OUTPUT, and the lender lives in one.**
  Run a cell that makes a viewer, then run it again: the first output carried
  the library, the second replaces it — and `_LENT_BUNDLE` still says this
  kernel lent one, so the new viewer writes a request to borrow from something
  that is gone. Two seconds of polling and an error box telling the reader to
  re-run the cell that carries the library. It IS that cell, so the advice
  cannot work and nothing short of a kernel restart recovers.
  Python cannot see an output being cleared, but it CAN see that it is running
  in the same cell as the lend and in a LATER EXECUTION — `_cell_identity()`
  reads `cellId` (JupyterLab) or `colab.cell_id` from the kernel's parent
  header, and `_LENT_WHERE` records it. A cell that makes several viewers is
  ONE execution, so a grid still lends once and borrows the rest. Where the id
  cannot be read the behaviour is exactly what it was.
  **Not by believing the page's `False`** — that is the veto rule below, and it
  is still unmeasured in Colab. This needs no browser at all.
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
- **THE SIDE-CHAIN TABLE IS COEFFICIENTS, AND IT IS BUILT IN ONE PLACE.**
  `buildSidechainTable` stores each atom in its residue's OWN BACKBONE FRAME
  (using the cartoon's `localFrame`), which is what makes a side chain follow
  the backbone through a trajectory, an alignment and a re-centring. It lived
  in `src/io/parse.js`, which the notebook does not ship — the notebook parses
  in Python — so `view(sidechains=True)` sends RAW ATOMS and `parts/ui.js`
  builds the table on arrival. Porting the geometry to Python was the
  alternative and is the same mistake that had a SAM cofactor drawing as one
  sphere: two parsers, one question.
  It moved into `src/io/sidechains.js` rather than dragging the whole parser
  in — 8.7 KB against 36 — and the cut was clean: `free_vars.js` reported the
  range closing over NOTHING, so it moved verbatim. `tests/lift.js`'s `UTILS`
  is the list that has to learn about a split like that, and it says so.
  **The atoms are per frame** — they are coordinates — so the flag is a
  viewer-wide one and off by default: 9.0 KB a frame becomes 37.2 on a
  251-residue design.
- **THE MESH IS TWO HALVES NOW, AND ONLY THE STICKS ARE REBUILT FOR A SIDE
  CHAIN.** Showing side chains APPENDS positions, so every term of
  `sharedGeometryKey` moves and the whole cartoon was rebuilt — 8,514 ribbon
  faces recomputed to draw 182 new stick ones. `buildMeshPart` builds one half,
  `makeResident` calls it twice and `installParts` concatenates them into one
  buffer, so the draw path is untouched. Measured on 4HHB, 40 side chains
  toggled eight times: **median 71.7 ms → 37.3**.

  Three measurements made the split legal, all on 4HHB with 400 side chains:
  the ribbon half does not change (hashed over its faces' corners and colours:
  identical with the side chains on, off, and on again); the weld that removes
  doubled lines never pairs a stick face with a ribbon one (1,295 welds, none
  mixed); and neither does the edge map (30,119 edges, none claimed by both).
  Without the last two the halves could not be built separately at all.

  🔴 **WHAT IT COSTS IS 260 PIXELS, AND THEY ARE ALL ON SEAMS.** The halves
  arrive ribbon-then-stick rather than interleaved by depth, and the draw is
  `drawElementsInstanced` under `depthFunc(LESS)` — so where a stick surface
  and the ribbon it grows out of land on exactly the same depth, the pixel goes
  to whichever was drawn first. 260 of 357,604 with 400 side chains out (77
  with 9), max channel delta 57, none on open ribbon, indistinguishable at 6x.
  The tie-winner was already arbitrary: whichever face the depth sort put
  first. It scales with the number of SEAMS and nothing else.

  🔴 **THE CACHE IS A HASH OF THE FACES, NOT A KEY BUILT FROM STATE.** A key
  assembled from renderer terms is a list someone has to keep complete, and
  most of the entries in this file are a term that went missing. A hash of the
  thing itself cannot forget one, and it fails safe — a miss rebuilds. It has
  to be CHEAP: the first version mixed every corner through a closure with
  three multiplies a number and cost **10 ms**, as much as the build it was
  skipping. Sampling two corners, the red channel and the residue, with the
  loop written out, is **0.9 ms**.

  🔴 **AND THE PALETTE SLOT IS THE ONE THING A SIDE CHAIN MOVES.** `ci` indexes
  the segment list and a side-chain bond IS a segment, so two ribbon faces of
  8,514 come out one block along. Hashing it would miss the cache on every
  side-chain change on the strength of two numbers; it is left OUT of the hash
  and PATCHED into the reused fill instead — one float per face, 8,514 writes,
  too small to measure. Invisible until something repaints from the palette
  WITHOUT rebuilding, which is exactly what a colour-scheme change does, so it
  is measured there: `tests/gpu_recolour.py` shows side chains, repaints, and
  requires the result to equal a forced rebuild. The OUTLINE's slots are not
  patched — an edge takes its slot from whichever face claimed it first and the
  build does not record which — and that is the one approximation in here: an
  outline tint on those two faces after a palette change, never a fill.

  What is left is the other half of the bill, and no mesh-side design reaches
  it: **the capture is ~25 of the ~37 ms**. `captureFrom` sets `_probeOnly` and
  runs `cartoon/geom.js` for its prims, so a side-chain click still rebuilds
  every ribbon PRIM to throw all but the sticks away. That is the same
  two-halves idea one level upstream, against a run loop whose state is carried
  residue to residue.

  *When measuring any of this, force `py2dmolCartoonGPU.invalidate()`: without
  it the GPU reuses its resident mesh, `geom.js` never runs, and two cache hits
  compare identical and prove nothing.*
- 🔴 **PIXELS CANNOT BE COMPARED ACROSS PAGE LOADS ON THE GPU PATH.** Two runs
  of the SAME code differ in **110,800 of 357,604 pixels** on 4HHB - a fine
  speckle over every surface, max delta 40 - so a before/after image comparison
  between two browser launches measures the machine and not the change. It read
  exactly like a real regression: a broad subtle shift, the right shape, the
  wrong conclusion. Within ONE page load an A/B is sound (that is how the seam
  pixels were measured, with a control pair that agreed exactly). Across loads,
  compare a DIGEST: `window.__meshDigest = 1` before a build fills it with
  per-instance hashes of the fill and the outline, SUMMED rather than chained so
  it is order-independent - the two halves are concatenated in a different order
  from the one a single build emitted, and that reordering is deliberate.
- **THE EDGE TABLE IS THE BIGGEST ALLOCATION IN A BUILD, and it was one object
  per edge.** Measured on 4UG0, 188,738 ribbon faces: rails +76 MB, normals
  +69 MB, edges **+120 MB**, against a fill of 36. The fields live in two flat
  arrays now and the Map holds an INDEX; peak on that structure went **488 to
  390 MB**, with the mesh digest identical. What did NOT change is the Map and
  its ITERATION ORDER: the outline instances are emitted in the order the map
  yields them and the ink pass draws with the depth mask off, so a later stroke
  paints over an earlier one - reordering them would be a picture change
  wearing a memory change's clothes. Two details a typed array cannot express
  and both are load-bearing: `nCount` counted a NULL normal as an occupant (it
  decides what is a boundary edge), and `e.n0 || [0,0,1]` / `e.n1 || a2` are
  fallbacks for one - so presence is a bit and the count keeps its meaning.
- 🔴 **WHERE A BUILD'S MEMORY GOES - AND WHICH PEAK YOU ARE READING.**
  `window.__heapProbe = 1` fills `__mrPhase` and the stage marks with live
  bytes (and `__mrRibbon`, which is the RIBBON half's copy of `__mrPhase` -
  the two halves share it and the stick half, being second, wins, so the
  interesting one is the invisible one) (it calls `window.gc`, which needs `--js-flags=--expose-gc` or it is a
  silent no-op and the reading is mostly garbage). There are TWO numbers and
  they move independently, which cost a round of wrong claims:

  | | 4UG0, 188,738 faces |
  |---|---|
  | LIVE peak, collected at every mark | **288 MB -> 259** |
  | the heap as V8 actually lets it grow | ~450 MB -> 214-436, run to run |
  | live after the build returns | 26 MB either way - nothing is retained |

  The live peak is the one that decides whether a capsid fits, and it sits in
  the MESH BUILD - so the changes that cut allocation VOLUME (dropping each
  prim as it is read, which halves the garbage) barely move it, while the ones
  that cut what is alive at the edge pass do. Read the wrong one and a 10%
  change reports as 50%. What is left at the peak is the edge arrays, the
  outline's instance buffer, the fill, and the face OBJECTS - the last of those
  means facesOf emitting into typed arrays, which is a different size of job.
- **AND GIVING A FACE ITS FINAL SHAPE AT CREATION measured as WORSE.** A face
  gains about ten properties after it is built - the normals, the tangents, the
  ink normal, the weld key - which is the classic argument for pre-declaring
  them so V8 stops transitioning the hidden class. Measured: **no memory change
  at all** (154/161 MB against 154/148, and 259 at the peak either way) and
  **950-1,000 ms against 748-818**. Writing ten extra fields on 188,738 faces
  costs more than the transitions did.
- **TWO THINGS THAT MEASURED AS NOTHING in the edge pass, so nobody retries
  them.** Replacing the group lookup - a Map keyed by a 32-bit hash, where half
  the keys are past 2^31 and so are not SMIs - with an open-addressed table
  over typed arrays: **733/777/733 ms against 721/738/752, and 259 MB against
  259**. The boxing that argument rests on is real and costs nothing here. And
  presizing the edge arrays instead of doubling them: the doubling copies are
  not where the time is either.
- **THE MESH IS THREE PARTS, AND A SIDE-CHAIN CLICK REBUILDS ONE OF THEM.**
  Ribbon, then the other sticks (ligands, base plates, contacts), then the side
  chains. A heme is 1,822 faces on 4HHB and is exactly as unchanged by a
  side-chain click as the backbone is; it was being rebuilt because it happened
  to be made of sticks. The stick work is **12 ms to 2.5**, and a click on
  4HHB with 40 side chains is **62 ms to 31** counting everything.
  🔴 **THE CUT COMES FROM `cartoon/geom.js`, WHICH KNOWS WHAT IT DREW.** The
  CA-CB bond has one end on the backbone and one in the side-chain map, so
  `has(a) || has(b)` puts it with the side chains where it belongs; classifying
  in `paintgl.js` by the position index - `min(a, b)`, which is the CA - reads
  that bond as an ordinary stick, and then **thirty attachment faces sit in the
  `other` part whose hash moves on every side-chain change, so the whole 1,852
  faces rebuild and 2.5 ms goes back to 5.4**. Correctness survives it, because
  the cache is keyed by a hash of the faces themselves; what it costs is the
  caching. `tests/gpu_mesh_reuse.py` asserts BOTH kept parts came from cache
  after a side-chain change, and the index classifier fails it.
  🔴 **AN EARLIER NOTE HERE SAID THIS SPLIT BROKE 50 OF 702 WELDS. IT DOES
  NOT.** That measurement came from a classifier that read `p.gs0` on a stick
  face, which most of them do not carry - so nearly every side-chain face
  counted as `other` and the mixed welds were the classifier's, not the
  geometry's. With geom's own flag: **0 mixed welds and 0 shared edges** on
  4HHB, 3PTB and 1EHZ. The lesson is the one this file keeps relearning - a
  measurement through a guess measures the guess.
  **And a reuse flag must report what HAPPENED**, not what a slot says: the
  first version compared the cache slot to the hash, which reads "reused"
  through a mutation that rebuilt every time.
- **THE SELECTION MARK IS A SETTING: `highlight`, `outline`, `none`.** The
  `Sele` dropdown beside `Color`, wired once in `parts/ui.js` so it reaches all
  three shells - and
  it belongs there rather than under Focus because the mark is on EVERY
  selection (a sequence-strip drag, Select all, a click in any mode), and a
  setting hidden inside one mode is findable only from inside it. It also keeps
  Focus a one-click latch instead of a button that means two things.
  `docs/SELECTION_MARK.md` is the tuning menu: six treatments drawn side by
  side, the two rejected before the shortlist, and the costs - **0.02 ms
  between the cheapest and the dearest**, which is 0.1% of a frame, so this is
  a taste decision and nothing else.
  🔴 **AN OUTLINE PUNCHES ITS MIDDLE OUT, and three things come with that.**
  The band is stroked and then stroked again two ring-widths narrower with
  `destination-out`, so the geometry inside is untouched - which is what lets
  it be thin without vanishing, where the highlight has to be pale for the
  opposite reason. (1) The scratch layer becomes unconditional for it:
  `destination-out` against the finished frame would erase the DRAWING. (2)
  Two callers cannot punch and fall back to the highlight whatever the setting
  says - an SVG export, where the operation is meaningless and a raster layer
  would put a BITMAP in the file, and a context with no document behind it,
  where `createElement` answers and `getContext` does not. (3) A dark mark must
  follow the paper, because an ink line on the `3d` preset's black says nothing
  is selected at all - worse than saying it loudly, which is how this started.
  **And the gain belongs to the SHAPE**: 1.3 for a band, which reads at its
  outer edge, 1.0 for a ring, which reads at its inner one. `tests/interaction.js`
  takes the proportion from `SELECTION_HALO_GAIN` rather than writing `2.3`
  out, so a change of taste does not read as a broken rule; what it still asks
  is that the band is a proportion AT EVERY SIZE, which is the thing that was
  genuinely wrong once.
- 🔴 **THE SELECTION MARK FOLLOWS THE RIBBON, BECAUSE THE RIBBON HANDS IT THE
  CURVE.** The band joined consecutive residues with a straight line, and a
  cartoon helix is a ribbon spiralling THROUGH those residues - so the mark
  chorded the thing it was marking: measured on 4HHB's longest helix, the
  traced path is **328 px against 295.8 of chords**, and the sagitta between
  two steps is 17-22 px against a band 9.2 px wide.
  `cartoon/geom.js` records where it actually ran - `_traceProbe`, filled in
  the one loop that walks an interval's stations, about five points a residue -
  and `_paintSelectionHalo` strokes THAT. Not a second smoothing to keep in
  step with the first: the curve is a helix-exact Hermite stencil for helices
  and Catmull-Rom for loops, with one-sided stencils at run ends, and a
  reimplementation would have been wrong on the first structure that used the
  other branch.
  Four things this cost, each of which looked like the answer for a while:
  **(1)** `_posProbe` is NOT the ribbon - it is one point per residue, equal to
  the atoms for helices and coil and 2.11 A away for STRANDS on 1TIM, which are
  flattened. Following it fixes sheets and does nothing for the complaint.
  **(2)** The four corners `evalSlab` returns are PROJECTED - paintgl
  unprojects them to build its mesh - so averaging them gives a screen point,
  not a centre line. The centre is `q0`, the Hermite point itself, handed back
  on `cnr.mid` so the eleven indices that array is read by do not move.
  **(3)** The samples are in ROTATED space and the GPU runs geom only on a mesh
  REBUILD, so a trace kept in that space is the last rebuild's picture. It is
  stored the way the coordinates are - before the user rotation and the
  centring - and re-rotated at use. Feeding it to `_projectForPicking` instead
  put the PICKER on stale geometry: `tests/multi_object.py` went to "nothing
  was pickable even while drawn".
  **(4)** The halo cannot borrow the projection parameters from either
  projection routine, because on a cached GPU cartoon frame NEITHER runs - the
  positions are last frame's, still stamped valid because nothing moved. It
  builds them from the viewer state, where every term already lives.
  🔴 **AND THE TRACE MUST NOT BE DROPPED ON INVALIDATION.** It was, on the
  reasoning that a curve through the segments goes stale with them - and
  toggling Cyclic invalidates AFTER the rebuild that would have refilled it, so
  the trace went to null and nothing ever asked for another: every helix went
  back to chords and stayed there. A cartoon BUILD refills it and a build
  happens exactly when the ribbon changes, so between two builds it is the same
  ribbon. What the trace DOES need is a gate on the style, because it outlives
  a build on purpose: a tube IS the straight lines between its residues.
  `tests/selection_mark.py` measures the stroked path against the chords -
  1.11x on a helix, exactly 1.00 on a tube, and again after a Cyclic toggle.
- 🔴 **THE DEPTH SORT IS THE PAINTER'S, AND THE GPU IS NOT A PAINTER.**
  `prims.sort((a, b) => a.z - b.z)` is what makes a 2D canvas draw a solid - no
  depth buffer, so the order IS the occlusion - and it is the single hottest
  line in a build. The GPU has a depth buffer, and `installParts` concatenates
  the mesh as ribbon, then other sticks, then side chains, so the order is
  thrown away before anything reaches the card anyway. Skipped when
  `_probeOnly` is set, which is what `captureFrom` sets to harvest geometry
  rather than paint: **11-13%** off a build (1AOI with every side chain out,
  295.8 ms to 256.5 on the minimum of twelve; 1TIM 61.5 to 54.5).
  **TWO THIRDS OF THE COST IS PAID BY THE CODE DOWNSTREAM.** The line's own
  profile is 32 ms of 450; removing it saves more than that, because `sort`
  permutes an array of POINTERS to objects allocated in emission order, so
  `facesOf` and the weld then walk the heap at random instead of forwards.
  A line profile cannot show that, and a faster sort would not recover it.
  **WHAT IT COSTS IS TIE-BREAKS.** Face and edge counts are IDENTICAL either
  way (87,920 and 95,936) - the geometry is the same, and what moves is which
  of two coincident surfaces claimed a welded edge first: 2,401 of 498,436
  pixels, max channel delta 57, a diffuse speckle and nothing structural, the
  two pictures indistinguishable side by side. Same trade and same magnitude as
  the three-part mesh split above (260 of 357,604, max delta 57), where the
  tie-winner was already arbitrary too. `paint_trace` is unchanged, because the
  2D painter still sorts.
  🔴 **AND THE MEASUREMENT WAS WRONG THREE TIMES BEFORE IT WAS RIGHT.** Each
  failure is a different trap and all three are cheap to repeat:
  - **A NODE PROFILE IS NOT A CHROME PROFILE.** Node put `hashPt` at 18.2%
    self, the hottest function in the build, and `focalLength` - recomputed per
    corner by `unproject`, 350,000 times, genuinely invariant - at 5.4%. Both
    were fixed (Math.imul, and a cached focal length), both verified
    bit-identical through `__meshDigest` under three cameras, and both measured
    as NOTHING in Chrome: inside a +/-8% run-to-run band, one paired run
    slower. In a Chrome profile `hashPt` is **1.8%**. Reverted. The engine that
    draws the picture is the only one whose profile is evidence.
  - **AN A/B THAT ALWAYS RUNS A FIRST IS NOT AN A/B.** The harness did
    `sorted` then `unsorted` in every pair, so `sorted` always paid the
    collection for the previous iteration's garbage: it reported **25.7%**.
    Alternating the order and it reported **-2.5%**. Neither is the answer.
  - **AND THE MEDIAN IS THE WRONG STATISTIC HERE.** Noise only ever makes a
    build slower, so the cheapest run is the one paying for the work alone -
    the rule `_lastInkedMs` already uses. On the minimum of twelve
    counterbalanced runs the answer is 11-13%, and it holds at p25 and the
    median too (331 -> 273, 373 -> 290).
  **THE COST MODEL SAID THERE WAS NOTHING ELSE OF THIS KIND LEFT, AND IT WAS
  WRONG.** A build is a flat ~3 microseconds per face at every size measured -
  17,558 faces at 3.06, 87,920 at 3.09, 21,630 at 2.70 - so there is no hot
  spot and no quadratic term, and I concluded from that that every remaining
  win was fewer faces or fewer rebuilds rather than faster code. A flat cost
  per face says the work SCALES linearly; it says nothing about how much work
  each face is doing. The entry below took a quarter off it. `tools`: the
  Chrome profiler is reachable over CDP with `tests/cdp.py`, and
  `positionTicks` is what gives the line-level view.

- 🔴 **A MESH BUILD SPENT A QUARTER OF ITSELF ON GARBAGE AND ON ANSWERS IT
  ALREADY HAD.** `cartoon/paintgl.js`'s `buildMeshPart` is **25-34% faster**
  with the picture bit-for-bit unchanged - measured counterbalanced, minimum of
  nine or twelve builds, against `git show HEAD:` of the same file:

  | | mesh build | whole rebuild |
  |---|---|---|
  | 1AOI + every side chain (87,920 faces) | 138.2 -> 101.7 ms | 222.0 -> 189.8 |
  | 4HHB + side chains | 42.0 -> 31.2 | 70.4 -> 59.0 |
  | 1EHZ + side chains (RNA) | 20.4 -> 13.7 | 37.0 -> 28.0 |
  | 1TIM, ribbon only | 11.1 -> 7.3 | 16.8 -> 11.3 |

  Nothing here is a new idea. Every one of them is the file doing something
  twice, or building an object to throw it away, and they are worth naming
  because each looked like nothing:
  - 🔴 **THE FLAT STORE HAD ONE ENTRANCE AND FOUR EXITS.** The model corners
    live in `M`, a `Float64Array`, and everything that wanted them called
    `loadM(fi)` - twelve doubles copied into a scratch so that three or four of
    them could be read back. The fill emit, the weld key and the whole edge
    pass do that once per face. They take an OFFSET now; `addEdge` takes two,
    rather than two corner arrays. **Only the rails pass still gets arrays**,
    because it keeps them.
  - 🔴 **AND ONLY SURF-0 RIB FACES WERE PUT IN IT BY THE RAILS PASS**, so every
    stick face arrived at the frames loop with nothing and ran
    `f.q.map((p) => apply(inv, unproject(p, scale)))` - a closure, four map
    slots and two arrays a corner, about nine allocations, on 70,362 faces.
    `unprojInto` is those two functions' bodies in their own order writing
    straight into `M`: bit-identical, no garbage.
  - 🔴 **A VIEW VECTOR THAT ONLY A CAP READS WAS COMPUTED ABOVE THE BRANCH.**
    `viewVecAt(apply(VR, m[0]))` sat one line above `if (f.cap)` and every
    stick face in the build paid for a rotation and a normalise it never
    looked at.
  - 🔴 **THE WELD ASKED THE MAP TWICE.** A count per key, then a second walk of
    every face asking `faceSeen.get(f._fkey) < 2` - two gets and a set per
    face, on a key that is always past 2^32 and so boxes a double every time.
    What the weld asks is "has anything else claimed these four corners", and
    the first claimant's INDEX answers it: the second face to arrive marks them
    both. One pass, one lookup, and the second walk is gone.
  - 🔴 **THE EDGE PASS RECOMPUTED THE NEWELL NORMAL TO ASK IF IT WAS ZERO** -
    the frames loop had already computed it from the same four corners - and
    `addEdge` recomputed both endpoint hashes that its caller had just built
    the duplicate key from.
  - **And four things allocated per face to be dropped in the same iteration**:
    the key light `[-0.45, 0.6, 0.75]` and its length, written out INSIDE the
    loop; a `wOf` closure that captures the side sign and that a stick face
    never calls; `apply(VR, nn)`; and the tangent's own unprojection. Constants
    hoisted, sign passed as an argument, scratches for the two transients.
  🔴 **AND THE ONE THAT LOOKED BEST MEASURED AS NOTHING, AGAIN.** The edge
  hashes are `h >>> 0` and half are past 2^31, so as map keys and as
  `Uint32Array` reads every one is a boxed double; `x | 0` is a bijection on 32
  bits, so signing both the stored value and the query changes no identity and
  makes them all Smis. Digest identical, **104.8 ms against 105.5** - inside
  the noise. Reverted, because it reintroduces exactly the trap the array's own
  comment warns about (store signed, look up unsigned, and no edge ever
  matches) for nothing. Same answer as the open-addressed group table already
  recorded above: the boxing is real and it costs nothing here.
  🔴 **AND A FLAT ARRAY BEAT A PROPERTY, MEASURED ON THE HEAP.** The Newell
  length kept for the edge pass went on the face first. It read identically and
  cost **3-7 MB of peak live heap** on 1AOI - a hidden-class transition and a
  properties slot per face - against eight bytes in a `Float64Array`, which
  brings the peak back to within a megabyte of where it was (95-96 -> 96-97).
  This file's ceiling is a capsid; see the entry above on which peak to read
  and why `window.gc` needs `--js-flags=--expose-gc`.
  **PROVED BY `__meshDigest`, NOT BY PIXELS.** Twelve digests - four structures
  x three cameras - identical before and after, at every step; GPU pixels are
  not comparable across page loads. The suite is green, and the two node
  harnesses do not load this file at all, which is exactly why the digest is
  the check.

- 🔴 **THE CAPTURE WAS BUILDING AN OUTLINE FOR A FRAME NOBODY PAINTS.** The
  mesh build got 25-34% faster (the entry above) and that made `captureFrom`
  the larger half of a rebuild - so the profile moved to `cartoon/geom.js`,
  where it had never been looked at. The capture is **23-31% faster** with the
  mesh digest unchanged under three cameras on four structures:

  | | capture | whole rebuild |
  |---|---|---|
  | 1AOI + every side chain (87,920 faces) | 74.3 -> 51.1 ms | 191.3 -> 171.0 |
  | 4HHB + side chains | 22.8 -> 17.6 | 62.7 -> 55.0 |
  | 1EHZ + side chains (RNA) | 11.4 -> 8.2 | 27.9 -> 23.3 |
  | 1TIM, ribbon only | 3.0 -> 2.1 | 11.8 -> 10.7 |

  🔴 **AN INK CURVE IS THE PAINTER'S, AND THE HARVEST THROWS EVERY ONE AWAY.**
  `captureFrom` sets `_probeOnly` and returns at the geometry seam with the
  prims; `inkCurves` is read PAST that seam, by `paintPrims`. The GPU builds
  its own outline from the faces' edges (`addEdge`), so not one of those curves
  had a reader - and building them is not cheap: every stick takes the convex
  hull of its eight projected corners and tests both ends of every candidate
  edge against it, and the ribbon and the base plates each emit a slab
  outline. `hullPts` and `insideBy` alone were 9.9 ms/build on 1AOI.
  **`inkKept` is the narrower question** - will anything ever look at the
  answer - and `inkWanted` stays what it always was, what the READER asked
  for, which is what `_inkRan` reports and what `paintPrims` is handed.
  **THREE THINGS STILL READ THE CURVES BEFORE THE SEAM** and each keeps them:
  the FAST ink path, which turns them into `ribStroke` prims (reachable
  through `renderer._quality = 'fast'`, which is what `perfectInk` is false
  for) - miss that one and a fast-mode GPU frame silently loses its outline;
  `_dumpCand`; and `_stickProbe`, which `tests/smoke.js` fills from inside the
  ink block itself. Worth **23%** of the capture on 1AOI, on its own.
  🔴 **AND `emitSeg` ALLOCATED SIX ARRAYS PER TRIANGLE.** It is called once per
  SEGMENT of every bond, and per face it built `f.q.map((vi) => W[vi])` (a
  closure and a four-slot array) to read four corners it could have indexed;
  then a list of three-corner arrays destructured back apart one line later,
  plus two more for the edge vectors. The face's corners are INDICES into `W`,
  so the three loops read them through `f.q`. The eye-ray middle and the
  solid's centre also summed the same eight corners in two separate passes -
  and they are **not the same point**, one dividing by a literal 8 and the
  other by `W.length`, which part company the moment a bond is a TUBE rather
  than a box, so the sum is shared and the two divisions are not. Plus the
  section tables looked up per segment rather than per bond, the side-chain
  question asked once per FACE when it reads only `bd.a`/`bd.b`, and a `p0`,
  `p1` pair declared and never used. Worth **5-6%** of the capture on
  proteins and **23%** on 1EHZ, where base plates and nucleotide sticks make
  this the dominant loop.
  🔴 **AND THE TWO HAD TO BE MEASURED APART, because the first A/B could not
  tell them apart.** `total - mesh` carries BOTH halves' noise, and it reported
  the second change as +2.2% on one structure and +15% on another while the
  MESH column - which `geom.js` cannot touch and whose digest was proven
  identical - moved 2.5% and 6.0%. A control that is supposed to read zero and
  reads 6% is the measurement telling you it is not evidence. `RB.capture` was
  already recorded and is the half being changed: timed directly, the mesh
  control comes back at -1.0 / 0.0 / +2.2 / +1.3% and the capture deltas are
  real. **Measure the thing you changed, not the difference of two things you
  did not.**
  Proved by `__meshDigest` (12 digests, four structures x three cameras,
  identical at every step), by `paint_trace` (11 fixtures, 20,619 ops
  unchanged - though note it has **no stick fixture**, so it says nothing about
  `emitSeg`; the digests are what cover that) and by `tests/smoke.js`, which
  drives the stick geometry through `_stickProbe`. Peak live heap 96-97 -> 95-96 MB.

- 🔴 **AN ARRAY LITERAL WRITTEN INSIDE A PER-BOND LOOP IS AN ALLOCATION PER
  BOND, AND THERE WERE ELEVEN OF THEM.** Both halves of a rebuild got faster
  again - **9 to 19% off the whole thing** - with the mesh digest unchanged
  under three cameras on four structures, and not one of the changes is an
  idea. Every one is the same shape: a value that depends on nothing the loop
  varies, built fresh anyway.

  | | capture | mesh | whole rebuild |
  |---|---|---|---|
  | 1AOI + every side chain (87,920 faces) | 48.3 -> 43.4 ms | 102.2 -> 89.4 | 170.7 -> 155.0 |
  | 4HHB + side chains | 17.7 -> 16.5 | 31.1 -> 27.6 | 53.2 -> 47.9 |
  | 1EHZ + side chains (RNA) | 8.2 -> 6.0 | 13.9 -> 12.1 | 24.2 -> 19.5 |
  | 1TIM + side chains | 12.9 -> 10.9 | 22.4 -> 18.0 | 37.9 -> 32.8 |

  🔴 **`for (const [a, b] of [[x, y], [y, x]])` IS THREE ARRAYS, AN ITERATOR
  AND TWO DESTRUCTURINGS TO SAY "BOTH ENDS".** `stickFrame` ran it for every
  bond in the structure and it was the second-hottest line in the function.
  The same literal-as-a-loop appears five more times in the stick pipeline -
  the mitre's four corner signs, the seam station's, the shared-corner search's
  two corner pairs, the run walk's forwards-then-backwards - and each is now an
  index loop over a module-scope constant. `e1`/`e2`/`pick` in the same
  function became scalars: `e2` existed only to be read three ways in the
  neighbour loop.
  🔴 **AND `ringTables` CACHED THE FACES AND THE EDGES AND NOT THE RING.**
  `stickBox` built the unit section inside an IIFE on every call - a closure
  and n arrays per bond - for a table that depends on nothing but n. It is
  `RT.ring` now, and `squareAt` walks it rather than `.map`ping a destructuring
  closure over it.
  🔴 **AND THE TWO `Float64Array`s emitSeg ALLOCATES ARE PER SEGMENT.** A typed
  array costs more to allocate than a plain one, they hold six slots, and every
  slot is written before it is read - so they are module scratch. (They were
  introduced by the round before this one, which replaced two `push` loops with
  indexed writes: a fix that traded a growth for an allocation.)

  On the GPU side the same rule found four more:
  - 🔴 **TEN OF `addEdge`'s FIFTEEN ARGUMENTS ARE THE FACE'S, NOT THE EDGE'S**,
    and they were read and coerced inside the four-edge loop - `!!f.stick`,
    `!!f.two`, `f.c || null` and seven others, fetched four times per face,
    about 1.6 million redundant property loads on a nucleosome.
  - 🔴 **AND EVERY CORNER WAS HASHED TWICE.** Edge `i` runs from corner `i` to
    corner `i+1`, so `hashAt` was called eight times per face to answer four
    questions: 700,000 calls where 350,000 do. `hashAt` 6.3 -> 4.1 ms.
  - 🔴 **AND THE NORMAL-DONOR KEY WAS A STRING.** `f.pieceId + ':' + f.surf`,
    built for every ribbon face in one walk and again in the next. `pieceId`
    counts up from zero and `surf` is one of four, so `pieceId * 16 + surf` is
    injective and allocates nothing. The cheap test (`f._inkN`) now goes before
    the Map lookup rather than after it.
  - 🔴 **AND `wFlat` AND `tt` WERE BUILT FOR EVERY FACE AND READ BY SOME.**
    `wFlat` is consulted under `isRibSide` and `tt` only where `tA` does not
    take `frA.t` - which is the same condition the branch above it tests - so a
    nucleosome's 70,362 stick faces each built a three-element array for the
    first, and every rib face built one for the second. Same fault as the
    view vector hoisted out of the cap branch two rounds ago.
  The Newell accumulator is three scalars rather than a three-element array,
  and the three normal flips negate **in place** where the array is the face's
  own - which is what `nnOwn` says. `nn` starts as a fresh array built from the
  face's own sum and is REPLACED, not mutated, by `frA.n` or a `wSigned`
  result: **both of those are shared by every face of the piece**, and negating
  one in place turns the whole strip inside out.
  **WHAT WAS NOT ATTEMPTED, AND WHY.** The three hottest single lines left are
  `edgeMap.get`/`set` in `addEdge` (8.2 ms) and `faceSeen.get` (4.2) - JS Maps
  keyed by doubles past 2^32. This file already records TWO measurements of
  exactly that: an open-addressed table over typed arrays, and Smi-signing the
  keys, both null results in Chrome. A third attempt would be re-measuring a
  recorded answer.
  Proved by `__meshDigest` - 12 digests, four structures x three cameras,
  identical after every one of the four edit batches - by `paint_trace` (11
  fixtures, 20,619 ops unchanged) and by `tests/smoke.js`'s `_stickProbe`.
  Peak live heap 95-96 -> 96 MB.
  🔴 **AND `--also` EXISTS ON THE A/B HARNESS BECAUSE A CHANGE ACROSS TWO FILES
  CANNOT BE MEASURED ONE FILE AT A TIME.** Swapping only `geom.js` leaves
  `paintgl.js`'s win in BOTH arms, so each half reports against a tree that
  already has the other half in it - the capture read -16.3% alone and -10.1%
  in the honest pairing. Both arms swap both files now.

- **AND THE SUITE'S FLAKES WERE ALL ONE THING: A CAP THAT FIRES DURING SETUP.**
  Three probes crossed a threshold on load rather than on a fault, and each
  reported the half-built page as a broken one. `tests/mobile_layout.py` loads
  `index.html` at FIVE viewport widths and resizes at three more - 6.7 s alone,
  killed at thirty in a lane running six browsers - and said the sequence strip
  was "924 logical px in a 0px box", which is a measurement taken before the
  layout settled. It has its own `probe_cap` entry now, the third after
  `embed`, `colab` and `focus_mode`, and the note there says what the three
  share. `tests/multi_object.py` compared the GPU ink count against the CPU
  one at **5%** when the two painters legitimately differ by 4.8%: three runs
  of the UNCHANGED tree gave 4.89 / 4.99 / **5.01%**, so it failed about one
  run in three on nothing at all. 10% now, and the sibling tube check has
  always allowed 20%. **A bound 0.2% above the measured value is a bound that
  fails on noise** - and the way to tell that from a regression is to run the
  old tree, which is what turned "my change moved the picture" into "the mean
  moved 0.1% inside a 0.2% spread".
  🔴 **`tests/cut_ligands.py` HAS THE SAME SHAPE AND IS NOT FIXED.** Its
  `moving` sample polls `_focusAnim` on a 40 ms `setTimeout` against a ~330 ms
  flight, so a stalled tab hands control back after the flight has LANDED and
  the probe reports "it jumped". Its own comment records this having been
  tuned once already, from frame-counting to polling. The race-free form is to
  sample from **rAF**, because the flight is itself driven by rAF - starve one
  and you starve the other, so every frame the camera actually drew is seen.
  Not done here.

- **THE LIGANDS ARE NOT WORTH CACHING, MEASURED.** The mesh stopped rebuilding
  them (three parts, above) and the obvious next step is to stop the CAPTURE
  rebuilding their prims too. It buys **about 3 ms of a 27 ms click**: same
  click on 4HHB with 40 side chains, hemes shown 27.2 and 29.1 ms, hemes hidden
  25.7 and 24.3 - and hiding them really does remove the work, 174 atoms and
  1,822 stick faces down to zero. Nor could a prim cache collect even that
  where it matters: prims are in PROJECTED space and a focus click moves the
  camera on every frame of its flight, so the cache would miss throughout and
  hit only once the camera settles, which is when nothing rebuilds anyway. What
  is left of the click is the ribbon's own geometry - the run loop, the setup
  and the sort - and that needs a model-space prim pipeline, not a cache.
  🔴 **AND THE FIRST VERSION OF THAT MEASUREMENT WAS WORTHLESS**, in the same
  way as the reuse flag one commit earlier: it called `renderer.hide()`, which
  is the EMBED's API and does not exist on the app path, and then reported
  "ligands hidden" from its own argument rather than from what happened. The
  face counts were identical either way and the answer looked like 0.9 ms. A
  flag that says what was ASKED FOR is not evidence; the control here is the
  face count, and it is what turned a null result into a real one.
- 🔴 **`bonds` IS WHAT A FILE SAID; `segmentIndices` IS WHAT IS DRAWN. ANYTHING
  ASKING WHAT IS CONNECTED READS THE SEGMENTS.**
  The selection mark joined a ligand's atoms along `this.bonds`, under a
  comment claiming it used "the same connectivity the sticks themselves are
  drawn from" - which was true on the website and false in a notebook.
  `src/io/parse.js` derives ligand bonds; `viewer.py` only ever passes bonds a
  caller supplied BY HAND, so an ordinary ligand arrives with none and the
  renderer falls back to distance for the STICKS ("No bonds - will use distance
  calculation", `setCoords`). The mark had no fallback: every atom came out as
  an isolated position, and an isolated position is drawn as a zero-length
  segment with a round cap - **a ring around each atom instead of a band along
  the bonds**. Reported from a notebook; 3PTB's benzamidine has ten bonds in
  the segment list and none in `this.bonds`.
  Reading the segments fixed the website too, quietly: it marked **9 of the 10**
  bonds there, because the file's list and the drawn segments are not the same
  answer even when both exist.
  The segment builder is the ONE place that should read `bonds` - it is an
  input there, combined with distance and with what is drawn. Everything
  downstream asks the builder's output. `tests/minimal_input.py` is the home
  for this because it is the notebook path: four atoms in a line 1.5 A apart,
  three bonds, six path points - eight would be a hair per atom, which is the
  bug's own signature.
- 🔴 **THE SEQUENCE STRIP'S SCROLL WAS O(CELLS) PER CHAIN LABEL PER FRAME.**
  Reported as "slow to scroll" on 7Y7A - 511,631 positions, 309,416 cells - and
  it was **84 ms a wheel notch**, five frames. Not where anyone would look:
  the cell loops are virtual-scrolled already and cost 1.8 ms. It was
  `cellsOfChain`, which SCANS every cell of the layout, called once per chain
  label ON SCREEN, on every frame, to ask whether that chain carries one
  uniform colour override. Twenty labels x 309,416 cells x 60 Hz. The index is
  built once and cached on the layout object (`__chainCells`, non-enumerable so
  nothing serialising a layout picks it up): **84 ms -> 16.6**, which is the
  frame wait itself, and the labels section 70.6 ms -> 0.3.
  **The bisection I wrote first was the wrong fix and I measured it as such**:
  `residuePositions` is ordered by y (0 out of order in 309,416), so the
  visible rows are a contiguous slice and the two cell loops now start and stop
  there rather than walking everything - correct, kept, and worth about 2 ms of
  the 84. The instrumentation is what found the real one, and the marks were
  off by one section until I read them properly: a mark pushed BEFORE a section
  attributes its delta to the section BEFORE it.
  🔴 **AND A CACHED INDEX MUST ANSWER WHAT THE SCAN ANSWERED.** The scan took a
  cell with no `object` whatever object was asked for, so a chain holding both
  kinds cannot be served by one lookup; those chains are remembered and fall
  back to the scan. A subset would have been a silently wrong colour on one
  label.
- 🔴 **THE MSA IS VIEW-ONLY, AND THE DIMMING WAS A HUNDRED AND FIFTY-SEVEN
  LINES.** It followed the structure's selection: pick one residue and every
  column but that one greyed out. `applySelectionToMSA` did the mapping —
  per chain, and global columns for a paired alignment, because chain B's
  residue 3 is column `blockB.start + 3` — and all of it existed to change some
  pixels' opacity. **That is not what an alignment is for**: depth, coverage,
  conservation and the block-diagonal staircase are statements about the WHOLE
  alignment, and dimming most of it to whatever was last clicked takes the
  picture away at the moment you are reading it, with no way to say no — any
  click anywhere, canvas or strip, redimmed it. The function now writes `null`
  and nothing else. **`null`, NOT an empty Map**: `buildSelectionMask` reads the
  first as "no dimming" and the second as "dim everything", which was Hide All's
  answer.
  **WHAT DOES NOT CHANGE IS WHAT THE SELECTION IS FOR.** It still marks the
  structure, still fills the selection panel, and Copy / Cut / Delete still act
  on it — including `MSA.extractSubset`, which carries a cut alignment into the
  object a Copy makes and is driven by `selectedIndices` from `core/mol.js`, not
  by any of this. Every call site stays: after a Cut the residues have
  renumbered and the MSA has to be told, and "nothing is dimmed" is the right
  thing to tell it. `computeColumnMap` stays too — the tick row still needs it,
  and `tests/msa_paired.js` still checks the arithmetic.
  🔴 **AND THE PIXEL CONTROL WRITTEN FOR THIS CANNOT FAIL.**
  `tests/msa_paired_ui.py` measures the COVERAGE view, deliberately — it is the
  only one that shows the whole alignment at rest — and the coverage view never
  read the selection mask, so it did not dim before the change either. Forcing
  the "dim everything" state moves it by ZERO pixels. The stored field is the
  whole check; the ink pair is printed as context and asserts nothing, which is
  said out loud there rather than left looking like a control.

- 🔴 **A PAIRED MSA IS ONE ALIGNMENT WHOSE QUERY IS SEVERAL CHAINS, AND THE
  MATCHER COULD NOT SEE ONE.** `matchMSAsToChains` asks whether an alignment's
  query is a chain, and `sequencesMatch` refuses anything more than 10% off that
  chain's length - so a multimer alignment, whose query is A+B concatenated,
  matched nothing and was dropped without a word. The only way to show one was
  to cut it into per-chain pieces, which throws away the whole statement it
  makes: row *s* is one organism ACROSS the chains, and that lives on the
  boundary. `splitQueryIntoChainBlocks` (`src/app/main.js`) is the second
  question, asked only when the first finds nothing, and it anchors each chain
  with `indexOf` **from a moving cursor** - a homodimer's two identical chains
  both anchor at column zero without it, and the second block comes out empty.
  The blocks travel ON the alignment as `msaData.chainBlocks`, so every view
  that is handed a `displayedMSA` knows, and nothing has to ask the object.
  🔴 **AND COVERAGE AND IDENTITY ARE MEASURED OVER THE BLOCKS A ROW OCCUPIES.**
  Half a paired alignment's rows are UNPAIRED by construction - one chain's
  homolog with the other chain's columns all gaps - so measured over the whole
  width every one of them scores at most 0.5 on a two-chain query, and the
  website's coverage slider **defaults to 0.75**. The block-diagonal staircase
  that is the entire reason to look at a paired MSA would be filtered away
  before it was drawn. Scored over its own blocks a row scores what it would
  have scored in that chain's own alignment, which is what makes the filter mean
  the same thing either side of the split. `scoringMaskFor` is the one funnel,
  and the masks are cached by occupancy PATTERN - three of them for two chains,
  against ten thousand rows.
  **AND PAIRING IS THE FIRST SORT KEY, IDENTITY THE SECOND.** The two rules pull
  against each other: score an unpaired row over its own chain and it can beat
  every paired row on identity, which interleaves the groups into a speckle. The
  slab has to stay above the staircase or the picture says nothing.
  🔴 **AND A FILTERED COPY IS REBUILT FIELD BY FIELD**, so `computeFilteredMSA`
  and `applyFiltersToMSA` each had to be told about `chainBlocks` - the same
  shape of fault as `normalizeConfig` and `light_frame`. A copy that forgets is
  a paired MSA with no boundaries drawn, full-width scores, and its unpaired
  rows deleted on the very next pass.
  🔴 **AND THE SELECTED COLUMNS ARE GLOBAL, FILED PER CHAIN.**
  `applySelectionToMSA` turns a structure position into column *i* of that
  chain's alignment; a paired alignment has ONE column axis, so chain B's
  residue 3 is column `blockB.start + 3`. The sets are still keyed by chain -
  which is what lets `buildSelectionMask` consume them with the `has(pos)` it
  always used - but they hold global columns. Block-local numbers under a chain
  key light up the FIRST chain's columns: the same integers meaning two
  different places. `MSA.computeColumnMap` is that walk, and it is the THIRD
  copy of it in the tree and the first one shared - the other two are
  `computePositionToResidueMapping` (the tick row) and the per-chain loop this
  sits in front of.
  **AND THE PICKER NAMES THE ALIGNMENT, NOT THE CHAINS.** Its option value was
  the chain letters, which stop being unique the moment a paired alignment
  exists: a homodimer's per-chain MSA and its paired one both cover A and B, so
  one silently replaced the other in the group map and the dropdown offered a
  single option for two different pictures.
  🔴 **AND `showMSACanvasContainers` IS NOT WHAT SHOWS THE MSA.** It shows the
  `.msa-canvas` boxes; `#msa-buttons` - the section holding the header, the
  filters, the picker AND those boxes - is `display: none` in the markup, and
  only `updateMSAContainerVisibility` turns it on. `addMetadataToExistingObject`
  never called it, so an alignment added to an existing object was parsed,
  stored, built, drawn and invisible. Never seen through the file input, which
  reaches a different branch that does call it - and always the case through
  `py2dmolLoadFiles`, which is the door a host page adds one through.
  `tests/msa_paired.js` has the arithmetic against fixtures in node (the split,
  the block-aware scores, the column map, six mutations); `tests/msa_paired_ui.py`
  builds an alignment IN THE PAGE from 1TIM's own chain sequences - a homodimer,
  the hard case for the anchor - and measures the boundary as **pixels of the
  rule's own colour in the coverage view**, which is the one view that always
  shows the whole alignment: the MSA view is 10px a column and scrolled, so on
  247+247 the boundary sits a thousand pixels off the right edge at rest.

- 🔴 **A PAIRED VIEW IS THE PAIRED ROWS, AND THE REST HAS TO GO SOMEWHERE
  FIRST.** An unpaired row of a two-chain alignment is half a row - one chain's
  homolog with the other chain's columns gapped - so in the coverage plot it is
  a block-diagonal staircase under the thing the reader came to look at, and in
  the conservation it is depth that says nothing about the interface. The view
  answers "which organisms have both chains"; those rows do not answer it.
  `pairedRowsOnly` drops them, and a row counts as paired when it occupies more
  than ONE block, which on three chains includes a row that has two of them.
  **THE CONDITION ON DROPPING THEM IS THAT THEY ARE STILL REACHABLE.** For an
  AF3 download they are: the same four files register each chain's own
  alignment beside the paired one. A single CONCATENATED file - what a ColabFold
  complex search returns, and what LocalFold hands over - is the only thing its
  object has, so showing the paired rows alone would put the rest of the depth
  nowhere, and it is most of it: a few hundred paired rows over thousands of
  unpaired ones. `splitByChainBlocks` cuts each block back into an ordinary
  per-chain alignment, which is where that depth goes and what the conservation
  is measured on. Measured on a real AF3 job: 3,227 combined rows become **929
  in the paired view**, with 2,792 and 1,026 in the two per-chain views.
  **A HOMO-OLIGOMER LOSES NOTHING**, because its merge is dense - every row is
  already paired. The real 8,076-row search for one is 8,076 rows in the paired
  view.
- 🔴 **THE CHAIN LETTER AND THE RESIDUE NUMBERS SHARE ONE 15px ROW.** The letter
  was drawn 3px past the boundary and landed on whatever tick fell there, which
  is most boundaries - a block starts on a round number about as often as
  anywhere else, and the FIRST block's letter sits at column 0, where tick "1"
  always is. `chainLabelPlacements` measures the letters' boxes and
  `drawTickMarks` skips a number whose text would fall inside one. Dimming or
  nudging the number would be two things in one place by another name; the
  letter wins because a number can be inferred from its neighbours and "which
  chain am I looking at" cannot. One answer, read twice - the tick row asks so
  it can leave the space, the label pass asks so it can draw in it - because two
  copies of that arithmetic drift by a pixel and the gap closes again.
  Measured in `tests/msa_paired_ui.py` as pixels of number ink inside the
  letter's clear box: **39 before, 0 after**, with the ink elsewhere in the row
  as the control so "none" cannot mean "no ticks were drawn".

- 🔴 **THE ALPHAFOLD 3 SERVER SHIPS ITS PAIRING AS FOUR FILES AND THEY ARE NOT
  ROW-ALIGNED.** A download carries `<job>_paired_msa_chains_a.a3m` and
  `..._unpaired_msa_chains_a.a3m`, one pair per chain, and the obvious reading -
  row *s* of one chain's paired file is row *s* of the other's - is wrong:
  measured on a real two-chain job they are **1,849 and 933 rows** and their
  species differ from the first row down. They are the raw all-seqs searches;
  the pairing is in the HEADERS and is done at featurisation. Read as four
  ordinary alignments, which is what happened before, a download comes up as two
  per-chain MSAs and the pairing it carries is simply lost.
  `MSA.combinePairedAlignments` builds the concatenated alignment the way
  `alphafold3/model/msa_pairing.py: create_paired_features` builds its features,
  and **four of its rules each change the picture**: a species needs to appear in
  at least TWO chains, not all of them (on three chains the third gets gap
  columns); within a species rows pair in file order, cropped to the smallest
  number of hits any chain that has it contributed, at most **600**
  (AlphaFold's `max_paired_sequence_per_species`); species in more chains rank
  first; and inside that, rows rank by the **product** of their positions in
  each chain's own file, so a pair near the top of both beats one near the top of
  a single alignment.
  🔴 **AND THE SPECIES IS THE UNIPROT ENTRY NAME, NOT `OX=`.**
  `msa_features.extract_species_ids` reads the mnemonic out of
  `sp|P56422|MOAE_HELPY` and gets `HELPY`; `OX=` is the numeric taxon and splits
  STRAINS - 85962, 102617 and 210 are three ids for one Helicobacter pylori - so
  pairing on it found 514 "species" and 910 pairs where the entry name finds
  fewer species and **928** deeper pairs. A viewer that pairs differently from
  the model draws an alignment nothing was folded from. `OX=`/`TaxID=` stays as
  a fallback for headers with no entry name and is never consulted when one is
  there.
  **AND THE UNPAIRED BLOCK IS DEDUPLICATED AGAINST THE PAIRED ONE**
  (`deduplicate_unpaired_sequences`), because the two files are two searches and
  they overlap: 539 rows of that job are in both. A row of a PAIRED file whose
  species pairs with nothing is kept, in the unpaired block - it was found by a
  real search, and dropping what a file contains is worse than a row appearing
  twice.
  🔴 **AND COPIES OF ONE CHAIN ARE NOT SEPARATE CHAINS.** A homo-oligomer has no
  pair search - there is nothing to pair - so the four files are two, and
  spreading their rows into one block with gaps in the other would claim the
  copies had different homologs and leave the alignment with no paired rows at
  all. Parts that share an alignment OBJECT are copies and their rows fill every
  block of the group, which is `_merge_homomers_dense_msa` by another name. The
  identity test has to count BOTH-ABSENT as the same, or the case it exists for
  - no paired file - is exactly the case it misses.
  **Only files named the server's way are combined.** Two alignments a reader
  happens to upload for two chains are not paired on a guess: pairing rows that
  were never searched as a pair invents a picture rather than showing one. The
  chain of a file is decided by matching its query against the structure, not by
  the `chains_x` in its name - the same way every other alignment here finds its
  chain, so the two cannot disagree.
  🔴 **AND `defaultChain` CANNOT SAY WHICH VIEW OPENS.** It names a CHAIN, and a
  chain with its own alignment resolves through `chainToSequence` to that one -
  so the paired view sat in the dropdown while the per-chain view opened, which
  is a view nobody sees. `msa.defaultQuery` names the ALIGNMENT, and the initial
  load and the picker both prefer it.

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
- 🔴 **A REBUILD OF THE SEQUENCE STRIP DESTROYS THE CANVAS THE POINTER IS OVER,
  SO NO `mouseleave` EVER ARRIVES.** The hover is a set of position indices -
  `hoverAtoms` here, `renderer.highlightedAtoms` there - and the ONLY thing
  that ever took it back was a mousemove or a mouseleave on that canvas.
  `buildSequenceView` empties the container, so after a Copy the last hover
  stayed lit over residues that had come to mean something else: copy a
  selection, move the pointer up to a chain label, and part of the old one is
  still marked. Reported as "an echo of past positions".
  `forgetPositionState()` drops both sets and TELLS THE RENDERER - a module
  that forgets while the picture does not is the same bug with fewer symptoms.
  **From the REBUILD, not just from `clear()`**: Cut rebuilds without clearing
  (`app/main.js`), and the deferred build is two frames late, so it forgets at
  SCHEDULE time - the canvas standing in that window still has its listeners
  and its own layout. The drag preview goes with it: `previewByObject` is keyed
  by object NAME, which survives a Cut renumbering the object it names.
  *The layout cache added the same day (`__chainCells`) was the first suspect
  and is innocent: `buildSequenceView` builds a fresh layout object literal, so
  the cache dies with the layout it hangs off. Worth stating, because a cache
  hung off a REUSED object would have been exactly this bug.*
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
- 🔴 **A RIBOSE IS NOT A NUCLEOTIDE ON ITS OWN, and `viewer.py` promoted one.**
  `_parse_model` reads a residue gemmi does not flag as nucleic as a nucleotide
  when it carries `C4'` + `O4'` + `C1'` — written for 1EHZ's modified bases,
  which are tabulated without the flag and were dropping out of the chain. SAM,
  SAH, ATP, NAD and FAD carry a ribose too, so a cofactor was promoted and
  collapsed onto a SINGLE position at its `C4'`: twenty-seven atoms drawn as
  one sphere, and a trajectory that looked like it could not recognise its own
  ligand because every frame was that same sphere. What separates the two is
  the company the residue keeps, so the test is gated on the chain holding
  nucleic acid at all.
  **`src/io/parse.js` had it right all along** — it wants a KNOWN nucleic
  residue plus connectivity — so the same file loaded correctly on the website
  and as a sphere in a notebook. Two parsers, one question, and only one of
  them asked it properly; `tests/parse_ligand.py` now asks both fixtures of the
  Python one.
- 🔴 **`_struct_conn` is not all connectivity.** It carries `covale`, `disulf`,
  `hydrog` and `metalc`, and a metal COORDINATION record is not a bond: drawing
  it as a stick invents rings. 7P1E declares Ca 506 chelated by both
  carboxylate oxygens of the ligand K99, and those two sticks plus the
  carboxylate's own close a four-ring that reads as a solid triangle. `metalc`
  is excluded; bringing it back means drawing it AS coordination, on its own
  layer. It was also only ever half-drawn — its protein-side ends name atoms
  (`ASP OD1`) and a protein residue contributes only its CA, so those resolved
  to nothing.
- 🔴 **THE GPU FLOORS `cartoonThickness` BEFORE `geom.js` READS IT, AND ONE RULE
  ASKS THAT VALUE A QUESTION ABOUT INTENT.** `paintgl.js` raises it to
  `GPU_RIBBON_THICK` (0.05 A) so every ribbon piece is a closed solid, then puts
  it back after the capture. Meanwhile the STICK rule asks `thickness === 0` to
  decide that a preset wants FLAT side chains - plain cartoon (`ribbon`) sets 0
  because flatness IS its look, and it is the one preset value that reaches a
  side chain. Floored to 0.05 that test is false, so every side chain took
  `LIGAND_TH_DEFAULT` (0.5): **fat 3D side chains standing in flat ribbons**, on
  the GPU only, and only until the Thickness slider was DRAGGED - a drag sets
  `_thicknessUserSet`, whose branch reads the value directly. Reported exactly
  that way, and the "moving the slider fixes it" is the tell: two branches of
  one expression, one reading a floored value and one not.
  `renderer._thickAsAsked` carries what the reader asked for across the floor
  and the stick rule reads that. **A floor applied to a shared field is a
  different VALUE for everyone downstream, and a rule that reads intent from a
  number cannot be given a corrected one.**
  *How it was found, after twenty combinations of pixel comparison said "no
  bug": comparing two frames that were BOTH wrong. The reader's own comparison
  (drag the slider) was the missing axis - forcing `_thicknessUserSet` and
  diffing changed 26,714 pixels, all of them side chains, against a rebuild
  noise floor of ZERO. Then a `defineProperty` setter on the field caught the
  0.05 write with its stack. Screenshots of both painters are what made it
  visible at all: the 2D one drew thin sticks, the GPU fat ones, same state.*
  `tests/gpu_stick_flat.py` drives the reader's route and requires the untouched
  picture to equal the one you get with the choice recorded, byte for byte, with
  a control at 0.5 so "identical" cannot mean "nothing drawn".
  🔴 **AND "DID THE READER ASK FOR THIS" IS A COMPARISON, NOT STATE.** It was
  `_thicknessUserSet`, one latch for all three presets - so a drag in `3d` said
  the reader owned thickness in `ribbon` too and put solid side chains back in
  flat ribbons. The fix for THAT was a per-look memory of dragged values, which
  worked and brought a recorder, an `isTrusted` rule, a session key and three
  places to lose it - **more machinery than the question deserves**, as the
  reader said. `thicknessIsChosen(renderer)` in `cartoon/geom.js` compares the
  value with the LOOK'S OWN DEFAULT, which is the whole of it: a look asks for
  one number and anything else came from a person. Switching replaces the value
  with the new look's, so the leak is impossible by construction rather than by
  bookkeeping, and there is nothing to save, restore or record. Dragging to
  exactly the default reads as "not chosen", which is the one case where it
  cannot matter.
  **`thicknessAsked()` is the other half**: two rules read a stick's thickness -
  is it the reader's, and how thick - and the GPU floor reached one of them and
  not the other. One helper now, and a mutation of it fails both cases.
  *That the whole apparatus came out was the reader asking "seems kind of
  over-engineered?" - it was, by exactly one feature I had added unasked
  (remembering a dragged value per look, copied from `_widthByStyle`). The bug
  needed the comparison; the memory was mine.*
  *And the unit test caught ME, not the code: it asserted `3d` asks for 0.5,
  which I had written into three comments. It asks for 1.0.*
- **THE COLOUR PICKER IS PyMOL'S COLOURS, ORGANISED AS PyMOL ORGANISES THEM:
  one row per family.** `PYMOL_COLOR_FAMILIES` in `core/mol.js` is nine rows -
  reds, greens, blues, yellows, magentas, cyans, oranges, tints, grays - taken
  from `all_colors_list` in PyMOL's `modules/pymol/menu.py` with the values
  from `reg_named_color` in `layer1/Color.cpp`, and the greys from its own
  `grey<NN> = NN/99` loop. `src/app/main.js` already drew one `<div>` per row,
  so the rows ARE the layout and nothing there changed.
  It used to be the CHAIN CYCLE - the 40 colours PyMOL hands to chains, in the
  order it hands them, which is deliberately unlike itself from one entry to
  the next so that neighbours contrast. Exactly right as a chain palette, and
  it is still one; as a grid to pick from it was confetti, and finding a darker
  red meant reading all 43 squares. **Two lists answering two questions.**
  The first cell of each row is that family's own primary, which is what makes
  the left column read as red/green/blue. Colourblind mode keeps its own
  categorical list - reorganising that by hue would be organising the thing it
  exists not to depend on.
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
- 🔴 **A LIGAND'S BONDS ARE JUDGED PER ELEMENT PAIR, FROM ONE TABLE, AND THERE
  USED TO BE TWO ANSWERS.** `src/io/parse.js` had the table; `core/mol.js`'s
  distance fallback - which is what runs when a file carried no bonds, so the
  whole notebook path, since `viewer.py` forwards only bonds a caller supplied
  by hand - used ONE number for every pair, `cutoffs.ligand_bond`, 2.0 A.
  `src/io/bonds.js` is the table now and both read it.
  **Measured, the two rules agree exactly on every ligand in the fixtures**
  (3PTB, 4HHB, 1HVR, 1EHZ, 2R8S - 243 ligand atoms, zero disagreements), and
  that is not luck: a bond between C, N, O, P or S is 1.2-1.8 A and the nearest
  non-bonded contact is 2.2 or more, so 2.0 sits in the gap. What it gets wrong
  is outside that band - **S-S at 2.05** (a disulfide drawn as two loose
  spheres), **C-I at 2.14**, C-Br at 1.94 which is inside 2.0 by 0.06. The
  reason to share it is not today's pictures; it is that one question had two
  answers and which you got depended on whether you were on the website.
  **AND IT COSTS NOTHING, MEASURED ON THE WORST CASE.** The prefilter had to
  widen from 2.0 to the table's largest entry (3.0) or a long bond would be
  dropped before its own rule was asked - 3.4x the candidate volume, each
  candidate then building a key string. On 7Y7A (511,631 positions, **206,884
  ligand atoms**) the segment rebuild is ~475 ms with the table and ~483 flat,
  and the two produce the SAME 526,177 segments. The pair of numbers is
  order-dependent - whichever runs second is 20% faster, 507/415 one way and
  444/552 the other - so a single A/B here reports warm-up as a result. Run it
  both ways round.
  **No fixture exercises the halogen rows**: scanning every HETATM element in
  all 30 `.cif` files finds no F, Br, I or Se, and `C-CL` at 2.0 is what the
  default already gave. The new rows change no picture in the corpus, which is
  the point - they are for the ligands the corpus does not have.
  **AND WITHOUT ELEMENTS IT IS EXACTLY WHAT IT WAS.** Handing raw coordinates
  to `add()` gives a ligand with no elements at all - the array is blanks, not
  null - and `bondMaxFor` answers the caller's own flat cutoff for a blank, so
  every pair takes 2.0 A: four atoms 1.5 A apart still come out as three bonds,
  and the atom still gets its default grey. That is the behaviour there was
  before there was a table, which is the only acceptable answer for a fallback.
  `tests/minimal_input.py` carries the case beside the S-S one; removing the
  blank fallback leaves four lone atoms and no bonds.
  🔴 **AND THE PYTHON DEFAULT WAS A VALUE THE RENDERER COULD NOT TELL FROM A
  CHOICE.** `viewer.py`'s config carried `"ligand_bond": 2.0`, so "the caller
  pinned a number" was true on every notebook and the table never ran on the
  one path it was written for. It is `None` there now - the renderer decides -
  and a number still means that number for every pair. Checked in
  `tests/minimal_input.py` with a ligand where the two rules disagree in BOTH
  directions: S-S at 2.05 (a bond the flat rule misses) and O-O at 1.9 (a
  contact it draws). Pinning the default back flips the answer to exactly its
  inverse - the O pair bonded, the disulfide two lone dots.
- 🔴 **CONECT IS FIXED-WIDTH AND THE PARTNER FIELDS WERE READ ONE COLUMN LATE.**
  The record is the name in 1-6, this atom's serial in 7-11, then up to four
  partners in 12-16, 17-21, 22-26, 27-31. `src/io/parse.js` took the partners
  from column 13, and `trim()` covered for it up to 9,999 atoms: a field is
  RIGHT-justified, so a four-digit serial sits with a space in front and reading
  one column late gives the same number with a space after. At five digits there
  is no padding left - `12346` written at 11..16 reads as `23461`, the leading
  digit dropped and the first digit of the next partner picked up.
  **Not a silent drop.** Measured: serial 10000's partner comes back as **1**,
  which in a real structure is an atom that EXISTS and is somewhere else, so a
  stick is drawn across the picture. Every structure past 9,999 atoms, which is
  most of the ones large enough to carry CONECT at all. Nothing covered CONECT
  before; `tests/interaction.js` now reads it at four digits (the case that
  masked it, as the control), at five, and with all four partner fields on one
  line - the fourth of which a one-column slip pushes past column 31 entirely.
  Found from the other side: LocalFold's AF3 ligands.
- 🔴 **THE ATOM NAME IS GONE FROM THE WIRE; THE ELEMENT STAYS.**
  `position_atoms` was produced by both parsers, copied through the merge, the
  extract, the session save and the side-chain append, stored by
  `_setDataField` - and **read by nothing**. `this.positionAtoms` had no reader
  at all: the side-chain path that needs atom identity uses `sidechainMap`,
  which carries its own record. 21 mentions in `src/` and 11 in `viewer.py`,
  every one of them transport. It cost 2.7 KB a frame on 4HHB, 574 of whose
  748 entries were `""`, and a notebook pays that per frame per viewer.
  What it is NOT is redundant with the element - see the entry below, which is
  why removing it endangers neither colour nor bonding. Bring it back only with
  a reader: labels, or `{atom: "OD1"}` in the selector grammar.
  🔴 **AND ITS GATE WAS THE ELEMENTS' GATE, IN BOTH PARSERS.**
  `src/io/parse.js` attached the element array only `if (anyAtomNames)`, and
  `viewer.py` wrote `position_elements if any(position_atoms)`. A file that
  named no atoms but declared elements would have lost both - and a naive
  removal of the names takes the elements with it. Each now asks about the
  array it is gating.
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

🔴 **AN EMPTY TEST FILE PASSES, AND `open(p, 'w')` EMPTIES ONE BEFORE IT
WRITES.** A patch script whose `write()` threw left `tests/interaction.js` at
zero bytes; node exited 0 with no output and the suite reported
`node interaction: ok`. The rule that a crash must not read as a pass is
already in `tests/run.sh`; this is its other half — silence is not a pass
either. Build the new text, assert it differs, and only then open the file for
writing.
