# Plugins: a supported way to draw things that are not residues

A plugin is a named piece of JavaScript that returns lines, balls and triangles, plus a JSON payload
Python hands it. The renderer draws them with the cartoon, depth-sorted with it, in both painters, in
PNG and SVG exports, and through `save_state` / `load_state`. This document is the contract and the
evidence for it: what exists, what it promises, what it costs, and what was not checked.

This change is the core: the registry, the seam in `cartoon/geom.js`, both painters' support, the
Python API, the state round trip, the per-painter primitive budget and the fit-to-view floor. It
ships no plugin of its own. Section 12 lists what is not here.

## 1. Why

A host library that draws free-energy isosurfaces around a protein needs geometry that is not a
residue: a shell per level, labelled site markers, contacts from a marker to a residue. py2Dmol had no
supported way to add it. What a host could do before, measured before this change (1CRN,
`preset="richardson"`, `sidechains=True`, real Chromium via WebGL2):

| route | result |
|---|---|
| markers as `position_types='L'` atoms in the protein's object | draws, coloured per position, focus and side chains coexist, marker-to-residue lines via `add_contacts` |
| marker size | **fixed by element**: a lone atom's radius is its full vdW radius (`src/cartoon/geom.js` `loneAtomRadiusA`); smallest is H at 1.2 A. There is no per-marker radius argument |
| points closer than ~2 A | grow sticks: bonds are derived by distance |
| `set_opacity` on markers | a 4x4 ordered **dither**, not alpha; at 0.35 it reads as a grey moire hatch, and a nearer sphere still hides a farther one |
| density as a point cloud | credible only at ~60-100 solid, sparse points; ~200 already occludes the protein, 1000 buries it |
| extra per-object payload through `save_state` | **dropped**: `save_state` is a whitelist for objects; an unknown key is gone after `load_state` |

So a density view needs the renderer's help. This is the smallest supported surface that gives it,
and it is not specific to density.

## 2. What exists, and the seam

- **`window.py2dmolPlugins`** (`src/parts/plugins.js`) is the registry. It is **not** a viewer-mol
  part. Those (`window.py2dmolMolParts`, `installMolParts` in `src/core/mol.js`) copy methods onto the
  renderer prototype, nothing calls them from `render()`, and the queue is **sealed by the first
  viewer** (`parts.push` throws afterwards) while the notebook prepends scripts, so load order there is
  reversed. A plugin has to be able to register at any time, so the registry is a plain object created
  if absent on both sides.
- **The primitive list** is built inside `render()` (`src/cartoon/geom.js`, `const prims = []`) from
  `rib`, `line`, `tube`, `stickFace`, `ribStroke`, `joint`, `dot`. Both painters draw that one list
  (`paint2d.js` to a canvas, `paintgl.js` to WebGL2), z-sorted. There is **no triangle primitive** and
  no alpha blending. The GPU painter reaches the list through `_probeOnly`: it sets it, `render()`
  returns at the sort, and `facesOf` turns the prims into a mesh that is drawn from a camera uniform
  until the signature changes.
- **The seam** is one call in `geom.js`'s `render()`, after the depth range and before the
  backbone-hide and clip-slab filters, the sort and the `_primProbe` export. It appends the plugins'
  prims to the list, so the z-order is shared, the clip slab culls them like everything else, and the
  GPU path sees them. With no plugin it is one property read.
- **Capture** (`src/parts/capture.js`, `src/core/svg.js`) draws from the same list, so a plugin's
  geometry is in PNG and SVG exports without further work.
- **Registration and inlining**: `MODULES` in `tools/bundle.py` is the manifest (the registry is in
  every bundle); `viewer.py` inlines the built bundle into the page, and a registered plugin's source
  beside it.

## 3. Requirements, and where each is met

The numbering is the proposal's. The requirement between R4 and R6 (Style-panel rows and a legend) is
a follow-up, see section 12.

| | requirement | as built |
|---|---|---|
| R1 | a plugin contributes geometry both painters draw, depth-sorted with the cartoon, and captured | `collect()` at the seam in `geom.js`; `tests/plugin_seam.js` (2D, depth sort) and `tests/plugin_browser.py` (both painters, PNG and SVG capture) |
| R2 | registration at any time; late registration must not throw | the registry is created if absent on both sides; a definition parked before the bundle is adopted by it; `register()` after a viewer is up binds and redraws it |
| R3 | data from Python, in the page, through `save_state` / `load_state`; unknown plugins kept verbatim with a warning | viewer-level `state["plugins"]`; one warning per load naming every unknown name; `tests/plugin_state.py` |
| R4 | zero change with no plugin | no-plugin `to_html()` and `save_state()` are byte-identical to before; the paint trace is unchanged (section 4) |
| R6 | `apiVersion` checked, with a message | `register()` compares with `PLUGIN_API_VERSION` (1) and refuses by name, with both versions and what to do; a missing `apiVersion` is refused too. **A refusal never throws**, wherever it happens (a direct call, or a definition parked before the bundle, where a throw would kill the whole bundle): it is recorded in `py2dmolPlugins.rejected`, said once on the console, and `register()` returns `null` |
| R7 | geometry budgeted, refused loudly | `ctx.maxPrims` per painter; overrunning **throws** (section 7) |

## 4. The guarantee: nothing changes without a plugin

- A viewer with no plugin writes the **same bytes** as before: `to_html()` and `save_state()` are
  identical to what they were before this change, and nothing about plugins appears in either. `tests/plugin_state.py
  --golden DIR` compares them with a golden recorded from a tree that has no plugin work
  (`--write-golden`, see `tests/README.md`); bare, it prints SKIP for that comparison.
- The drawing is unchanged: `node tests/paint_trace.js` reports the same digest as before this change, 11
  fixtures and 26,703 ops, checked against a baseline recorded with `--save` from the tree without it. An empty
  registry, a registry whose plugin the viewer has no payload for, and a plugin that emits nothing all
  draw byte-identically to no registry (`tests/plugin_seam.js`).
- The GPU signature gains one term, `window.py2dmolPlugins.key(r)`, which is `''` for a viewer with
  no plugin, so it is the signature it was.
- What it does cost is bundle size: section 10.

## 5. The API as built

### Python

```python
py2Dmol.register_plugin(name, js_source, version=None)   # external JS, inlined per page
v = py2Dmol.view(...)
v.add_plugin(name, payload, object=None, frame=None, options=None,
             version=None, api_version=None)              # chainable
v.set_plugin_option(name, key, value)
```

- `payload` is anything `json.dumps` takes. **NaN and sets are refused at the call**, not in the page,
  and the payload is **copied** at add time. Every argument is checked before anything is stored, so a
  refusal leaves no half-made entry.
- The payload lives on the **viewer** (`view._plugins`, `state["plugins"]`), never on an object: the
  object whitelist in `save_state` drops an unknown per-object key (`tests/plugin_state.py` keeps that
  as a control).
- `object` binds it to an object by name (as `add_contacts` does); `frame` to a frame; `None` means
  "whatever is drawn". `options` merge over earlier ones.
- It is sent with `show()`, and **a viewer already on the page is sent what changed**: `add_plugin` and
  `set_plugin_option` on a live viewer go out as an incremental update, under `viewer.plugins`, as
  `{name: entry}` for the plugins that changed. An entry whose payloads the page already holds carries
  no `payloads` key and the browser keeps its own, so changing an option does not re-send a mesh; one
  whose payloads only GREW carries the new ones and `payloads_from`, the count the page already holds,
  so a loop of `add_plugin` calls costs each call its own payload and not every payload before it
  (with `persistence=True` that is also the size of the notebook). Applying a tail is idempotent, so a
  Colab reopen that replays it lands on the same list; a page holding fewer than `payloads_from` keeps
  what it has, draws the tail, and warns. A plugin whose JavaScript the page has not had - the first
  time, or after `register_plugin` was given new code - carries it as `source`, run in the viewer's own
  document: in Colab every output is its own iframe, so a `<script>` beside the update would run in
  the wrong one. `register_plugin` knows no viewers, so new code reaches a live one with that plugin's
  next `add_plugin` or `set_plugin_option`. Every `<` in that update is escaped, as on the static path.
  With `persistence=True` a plugin update is a cell of its own and `replace()` does not overwrite it
  (it rewrites the last cell that carried a FRAME), so a reopen replays every tail; with
  `persistence=False` the one mailbox cell holds only the last update, so a reopen has the static
  payloads and that update's tail - the mode, as for frames. (`_plugin_delta` in `viewer.py`,
  `applyPluginBlock` in `parts/ui.js`.)
- Both styles draw plugins - see section 7b for how the tube does it.
- Names match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}` (they become an HTML attribute and a state-file key).

### Trust model

A plugin's JavaScript is **inline script in the HTML page the reader opens**, exactly like the core.
There is no sandbox and none is promised: open a page with a plugin only as you would open one with
any other script. It is inlined once per page, for every viewer that carries a payload for that name,
in every bundle mode (inline, external, shared library).

A source containing `</script` (any case) or `<!--` is **refused with `ValueError`**, not escaped:
escaping is only safe inside a string and `register_plugin` cannot know where in the code it is. Write
`"<\/script>"` or `"<" + "!--"`. The *payload* needs no such care: every `<` in it is written as the
six-character escape `<`, which JSON and JavaScript both read back as `<`.

### JavaScript

```js
(function () {
  // works whether it runs before or after the viewer library
  var P = window.py2dmolPlugins = window.py2dmolPlugins || {list: [], pending: []};
  var def = {
    name: "mine", version: "1", apiVersion: 1,
    options: {shown: true},                 // defaults; the viewer's options go over them
    init(host)      { /* once per viewer; host = {renderer, viewerId, requestRender()} */ },
    setPayload(ctx) { /* the viewer's payloads arrived, or changed */ },
    key(ctx)        { return "..." },       // anything that would change what prims() emits
    bounds(ctx)     { return {min: [x,y,z], max: [x,y,z]} },   // MODEL space, or null
    prims(ctx)      { /* draw with ctx.line / ctx.dot / ctx.tri */ },
    dispose(ctx)    {},
  };
  if (P.register) P.register(def); else P.pending.push(def);
})();
```

`prims(ctx)` is called inside `render()`, after the depth range and before the filters and the sort.
**A plugin draws in a viewer only where that viewer has a payload for it** (or JavaScript called
`P.setPayload(renderer, name, data)`); a plugin registered on a page with three viewers costs the
other two nothing.

`ctx` holds `renderer`, `host`, `instance` (what `init` returned), `name`, `version`, `apiVersion`,
`options`, `payloads` (`[{object, frame, payload, index}]`, only those that apply to what is drawn
now), `frame`, `maxPrims`, `painter` (`'2d'`, `'gpu'` or `'svg'`), `scale`, `toView(p, objectName?)`,
`project(x,y,z)`, and three helpers, so a plugin never hand-builds a prim:

| helper | emits | notes |
|---|---|---|
| `ctx.line(a, b, {color, width, ink})` | `kind:'line'` with `pts`, `z`, `w`, `wA`, `c`, `flat:true`, `joints`, `noInk` | `width` in Angstrom, default 0.35. `joints` is required: a line without it throws in `paint2d` at ink time (`tests/plugin_seam.js` keeps that as a control) |
| `ctx.dot(p, {color, radius, ink})` | `kind:'dot'` with `x1,y1,z`, `r`, `rA`, `c`, `noInk` | `radius` in Angstrom, default 0.5. On the GPU a plugin dot has **no palette slot and needs none**: its colour is baked (`pal: -1`), so recolouring the structure leaves it alone and does not flip `__gpuPaletteComplete` (which would turn every recolour of the structure into a rebuild) |
| `ctx.tri(a, b, c, {color})` | the existing `joint` prim with `q:[A,B,C]`, `nl`, `two:true` | opaque, flat-shaded, double-sided, lit by its own normal (`nl`; the GPU drops `unlit`) |

Points are **model space** (the coordinates of the file). `toView` maps them through the object's
`alignTransform`, its own rotation and the viewer's, the same arithmetic `_rotateAt` does for a
position (`core/mol.js` `_viewInto`, one copy; `_modelToView` is its door). Colour is `[r,g,b]`,
`{r,g,b}` or `'#rrggbb'`. Plugin prims are **`noInk` by default** (no dark rim; `ink: true` brings
one): on the GPU the border instance is skipped, and in `paint2d` the ink stroke is skipped and the
occluder grids use the extent actually painted.

**Near plane.** Under perspective, a point behind the camera or within 0.1 A of it makes its
primitive return `false` and be dropped whole. Near-plane clipping is not done.

**Non-finite and absurd coordinates.** `ctx.line/dot/tri` return `false` and drop the primitive when
a coordinate is NaN or infinite, or lies more than **50x the structure's extent (never less than 500
A)** from the view centre. A finite `1e30` is as bad for the GPU depth range as `Infinity`: it would
stretch the range until the cartoon collapsed into one depth step. Nothing non-finite reaches a
painter. The plugin still draws the rest of the frame and is put in an error state that counts what it
dropped ("5 primitives dropped: a coordinate was not finite, or lay more than 1500 A from the view
centre"). `bounds()` is held to the same rule: a box with such a corner is ignored, and is an error.
The reach limit is not configurable, since a setting that could raise it would hand the hazard back.

**Depth.** A plugin's triangle or ball can lie outside the structure's depth span, which is what the
2D painter normalises `near` over. `near` is **clamped to 0..1 for plugin prims** (as the GPU clamps
`near01`), so with depth fade they stay inside their colour ramp instead of extrapolating past it.

**`register()`** returns the registered definition, the existing one (same name, version and code,
idempotent), or `null` for a refusal; it does not throw. A different version, or different code
under the same version, replaces the old one, with a console warning.

**`init` runs once per viewer.** A payload arriving later - a live `add_plugin`, `setPayload`, a
session appended onto the viewer - calls `setPayload` on the instance already there; only a
replacement (above) or a session that REPLACES the scene disposes it and calls `init` again.

**The registry is idempotent to a second evaluation.** `py2dmolPlugins.__impl` marks the real
implementation and the state (`__core`: which viewers exist, what they hold) lives on the registry
object, so a second notebook cell that carries its own copy of the library changes nothing and runs
`init` once per viewer. The guard is `__impl >= IMPL`: a page can carry bundles of different ages, the
same or a newer registry wins, and an older bundle loaded afterwards cannot downgrade it. An older (or
no) registry is taken over: its registered plugins are kept, its per-viewer state is started afresh,
and a viewer re-attaches on its next question.

**`dispose`** is called on a plugin being **replaced**: same name, and a new version OR new code under
the same version (an author edits the plugin and runs the cell again without bumping it - keeping the
first copy drew the old code with nothing to say so). The last registration wins, for every viewer on
the page; an identical copy, one inline script per viewer, is still no event. A viewer has no
teardown hook to call it from, so a plugin must not rely on `dispose` for cleanup when a viewer goes
away.

**`key()`** is how the GPU finds out a plugin moved. The registry's combined key folds, per plugin:
its name and version, a revision counter, the viewer's options, which payloads apply to this frame,
and the plugin's own `key(ctx)`; and the GPU primitive cap. It goes into `sharedGeometryKey` in
`paintgl.js`, so into both the full and the topological signature. It does **not** contain error
states: those are a fact about one painter, and an SVG export that overran must not make the next GPU
frame look like a different mesh.

## 6. Framing: `bounds()`, and a floor under the fitted span

`bounds(ctx)` joins the fit-to-view. The registry turns the box into a radius about the view centre
(the same at every rotation, or the picture would zoom as it turned), and `_viewHalfSpan` never lets
the **fitted** span be smaller than it. It only grows the span, and the reader's zoom still divides
it.

**The floor applies to the fit, not to a span somebody set.** Orient, focus and the app write a tight
target through `setViewSpan` (`viewerState.extent`). Flooring that at the plugin's radius would stop a
focus on one residue from zooming closer than a shell drawn around it. So `_viewHalfSpan` applies the
floor only while `viewerState.extent` is unset, and the span an **orient to everything** writes
(`parts/orient.js`; the opening orient of every viewer is one) carries the floor itself, widened by how
far the centre moves. A selection is not everything and gets the tight span it asked for; "orient to
all" frames the plugin again.

**The floor is per axis** (`floorViewSpan` in `orient.js`). A span is stored as `(extent, aspect)`:
`extent * aspect.x` and `extent * aspect.y` are the two half-spans, the stored aspect normalised so its
larger part is 1. Raising the extent alone raises the long axis by the same factor as the short one:
for an elongated structure (aspect 0.053 : 1) a 45 A floor on the short axis would push the long one
to 852 A, 19x what is needed. So each half-span is raised to the floor and written back as (larger,
ratio); the representation is unchanged, and a span that already holds the floor is returned as it was.

Consequences. A plugin that arrives after the opening orient is framed at the next orient to
everything, not at once. `parts/multi.js` reframes without the floor (`setViewSpan(..., maxExtent)` on
an object switch, on leaving multi and on a merge), which drops the plugin floor until the next orient
to everything.

## 7. The budget: THROW, not truncate

Defaults: **2D 8,000 and GPU 60,000** primitives per plugin per frame. `window.py2dmolPlugins.caps`
can be changed by the host before a viewer renders, and the GPU cap is part of the key (a changed cap
is a different mesh). A plugin that emits one more throws `PluginBudgetError` from the helper;
`collect()` catches it and **drops that plugin for the frame, nothing of it, not a truncated 8,000**,
then says so: on the console (once per viewer), in a one-line badge inside the viewer's own box, and in
`py2dmolPlugins.errors(renderer)`. The state clears on the next frame that fits, and other plugins are
unaffected. A plugin that throws for any other reason gets the same treatment and adds nothing: its
earlier prims in that frame are rolled back. A truncated wireframe is a picture that is wrong and looks
right; that is why it throws. The message names the plugin, the cap, both painters' caps and what to
do.

**One cap and one error state per painter.** `errors()` entries carry `painter`: `'2d'`, `'gpu'`,
`'svg'`, or `'load'` for `init` / `setPayload` / `key` / `bounds`. The GPU harvests geometry under
`_probeOnly`. An **SVG export is always the 2D painter** whatever painter the viewer has, so it is held
to the **2D cap**: a 10,008-line shell the GPU draws is over it. An export cannot show a badge, so it
says so **in the file**, as an XML comment `<!-- py2dmol plugin <name> not drawn: <message> -->`
(`C2S.comment`; `--`, `<`, `>` and the characters XML 1.0 forbids are removed from the message so the
file stays valid), and once on the console. A raster export through the 2D painter (PNG on a 2D viewer)
has no annotation layer and uses the same cap as the screen, where the badge shows it.

## 7b. The tube draws plugins too

The tube never reaches `geom.js`'s `render()`, where the cartoon collects plugins, and it is the DEFAULT
style - so it has its own two doors, one per painter, and the plugin cannot tell them apart.

- **The 2D tube** (`_tubePluginPrims` and `_paintTubeSegments` in `core/mol.js`) asks the same
  `collect` for the same projected prims, with this style's own projection, sorts them far to near and
  lays each one down in the segment loop before the first segment nearer than it: the painter's
  algorithm, extended to pieces the structure did not make. A line is a round stroke on a rim darkened
  0.7 (the tube's own gap filler) when `ink` is asked for, a ball a disc, a triangle a flat fill lit by
  its own normal (`0.72 + 0.28 * nl`, the cartoon's split).
- **The GPU tube** (`buildTube` in `cartoon/paintgl.js`) holds model-space capsules - two endpoints, a
  radius, a colour - rotated by a uniform. A plugin's line IS one and its ball is one of zero length, so
  `py2dmolPlugins.collectModel` runs the plugin into model space (the object's alignment applied, as
  `renderer.coords` has it, and nothing else) and they join the instance buffer: free round ends,
  residue -1, the annotation slot set so they are flat and unshaded like a contact, and 2 there where
  the plugin asked for no ink, which gives the capsule a skirt of NO WIDTH (`VSTUBE`). Not dropping it:
  the outline and the fill are one pass that picks per fragment, and an instance dropped from it leaves
  the depth prepass's surface with nothing drawn over it - a paper-white hole where the line should be.
  The instances depend on no view, so turning the model rebuilds nothing; the plugins' key is in
  `sharedGeometryKey`, so a changed option or payload does.
- **A triangle has no capsule to be.** `collectModel` counts them, and a frame whose plugins emit one is
  handed to the 2D tube, which draws all three kinds; the refusal is remembered against the key so a
  turning model does not ask again every frame. The cost is the 2D tube's speed for as long as the
  triangles are there.
- **Their reach does not join the GPU tube's depth range**, unlike the cartoon's (section 8). The tube
  writes `gl_FragDepth` clamped into that range, so a piece beyond the structure's depth sorts to the
  front or the back of it, which is the right order against the structure, and is never cut off;
  widening the range would only spend the structure's own depth precision. Measured: removing the fold
  draws a cube 2.9x the structure's radius exactly as before, so it is not there.
- **In a composed frame** - two objects in two styles, drawn into one depth buffer - the cartoon half
  draws the plugins and the tube half does not, or they would be drawn twice (`S.compose`, which is in
  the tube's key for that reason). Read, not measured: no probe composes a frame with a plugin.

`tests/plugin_browser.py` drives both painters in the tube: drawn, an option off and on, the rim, a
triangle (and the GPU giving the frame up for it, and taking it back), the structure hiding the cube
edges behind it, a cube larger than the structure, and on the GPU a rotation with no rebuild.

The caps are a decision, not a limit found by measurement. Measured while choosing them (not in the
suite): the 2D painter was still interactive at about 7,700 lines (43 ms median JavaScript per
frame), and the GPU mesh took 46,000 lines through one build. Neither was measured on a real GPU.

## 8. The GPU depth range, and what folding a plugin into it costs the cartoon

`resident.zMin/zMax` is `+-rad`, sized from the faces' corners. A line reaching past it is clipped in
NDC depth, so a shell larger than the structure loses its near and far sides. `buildMeshPart` therefore
folds a **plugin** stroke's model-space extent into `rad` (`lineRad2`, gated on `ln.plugin`: a contact
joins two residues and lies inside, and must not start to matter); it reaches `tailRad` through
`part.rad`. `tests/plugin_browser.py` checks it against the 2D painter, which has no depth range: a
cube larger than the structure covers the same pixels on both (1CRN: GPU 6,442 px, 2D 6,304 px), and
with the fold removed the GPU draws 3,055 against the 2D painter's 6,308.

The fold has a price on the cartoon. Measured once (1CRN, Richardson, GPU, one 0.4 A stroke, no
`bounds` so the fit is unchanged, fold on versus off in the same page; off twice differs by 0 px;
pixels within 4 px of the stroke excluded; about 50,800 ink px):

| stroke at | cartoon px changed | max channel delta |
|---|---|---|
| R = 3 A (inside the structure) | 6 | 91 |
| R = 14 A (at the structure's radius) | 0 | 0 |
| R = 40 A (2.9x the radius) | 610 (1.2% of ink px) | 127 |

On the 2D painter the same three radii change 20, 0 and 0. The 610 are scattered single pixels along
ribbon edges and a patch where two coincident surfaces overlap: a 2.9x wider depth range changes
tie-breaks. The range only grows when a plugin stroke actually reaches past the structure, only on the
GPU, and only in viewers that have a plugin. A separate depth range for plugin geometry would cost a
second pass for something that is speckle at ties.

Two further per-stroke facts live in the same place. `noInk` is part of what a GPU line is: the
group-1 mesh part is cached under `ribbonHashOf(face) ^ linesKeyOf(lines)`, and `linesKeyOf` mixes
`noInk` and `plugin` (only when set, so a contact's hash is what it was); without them, flipping `ink`
with unchanged geometry hands back the cached part with the old rim in it. And a plugin's triangles
and balls belong to NO residue: they carry residue -1, and the fill shader skips the coverage texture
for a negative residue, as the edge shader always has for plugin lines. That texture is per-residue
OPACITY (`set_opacity`); before this, a GPU face clamped -1-less ids into it, so fading residue 0 out
faded the plugin's ball with it on the GPU and not on the 2D painter. `tests/plugin_browser.py` fades
residue 0 and requires the ball to stay, on both painters.

## 9. State

`save_state` gains a top-level `plugins` only when there is something:

```json
"plugins": {"mine": {"version": "1", "apiVersion": 1,
  "options": {"shown": true},
  "payloads": [{"object": "crn", "frame": 0, "payload": {}}]}}
```

It round-trips through `load_state` then `save_state`. A name the loading process has not registered
is kept **verbatim** and warned about once (one warning naming every unknown name), because a state
file is a document and loading it in a session that lacks a plugin must not destroy that plugin's
data. In the page the payloads are `window.py2dmol_plugins['<id>']`, a sibling of `py2dmol_configs`,
written only when the viewer has any.

The website's session file carries the same top-level key, so a file opens on either side.
`py2dmolPlugins.snapshot(renderer)` is what `buildViewerState` writes (null, and no key, for a viewer
with none) and `py2dmolPlugins.restore(renderer, map, {replace, rename})` is what `loadViewerState`
reads back: a replacing load replaces the payloads - a file with none leaves none - and an append adds
the file's beside what is there, with a payload bound to an object following that object to the name
the append gave it.

## 10. Costs

Bundle sizes, built with `python3 tools/bundle.py build` (terser 5.51.2). The same toolchain rebuilds
the tree before this change byte-identical to its committed bundles, so these deltas are this change only.
Raw bytes, and `gzip -9 -n`:

| bundle | raw bytes | delta | gzip -9 bytes | delta |
|---|---|---|---|---|
| notebook | 654,099 -> 667,819 | +13,720 (+2.10%) | 208,526 -> 213,823 | +5,297 (+2.54%) |
| web | 889,516 -> 903,236 | +13,720 (+1.54%) | 277,195 -> 282,486 | +5,291 (+1.91%) |
| embed | 664,186 -> 677,388 | +13,202 (+1.99%) | 212,082 -> 216,967 | +4,885 (+2.30%) |
| embed.cpu | 568,082 -> 581,479 | +13,397 (+2.36%) | 180,408 -> 185,380 | +4,972 (+2.76%) |
| full | 907,579 -> 921,298 | +13,719 (+1.51%) | 283,452 -> 288,595 | +5,143 (+1.81%) |

The registry, the seam and the painter changes cost about 13.7 KB raw and about 5 KB gzipped per
bundle. That is a cost in size, not a promise of "free when unused": the guarantee in section 4 is
about behaviour and output bytes. The notebook bundle is inlined into the `.ipynb` once per `show()`
cell when the library is not shared, so the registry is paid there once per cell.

## 11. What is not established

- **The cost on a real GPU.** Everything ran through SwiftShader. The GPU-side numbers are relative
  (mesh rebuild, edge-instance count), not frame times.
- **Browser probes outside Linux.** `tests/plugin_browser.py` launches through `tests/cdp.py` on a
  Mac and through `PY2DMOL_CHROME` elsewhere; it was run on Linux and Chromium only.
- **Several objects, and an alignment, in a browser.** The arithmetic is tested (`_modelToView` with an
  `alignTransform` against `_transformedFrame`), and `ctx.toView(p, objectName)` picks the object; no
  browser page drew a plugin over two aligned objects.
- **Colab's own frontend.** `tests/colab.py` reproduces its shape - one iframe per cell output, one
  origin, BroadcastChannel the only bridge, iframes loading in either order - and a plugin added after
  `show()` arrives there with its source, registers in the VIEWER's document and draws. Colab's sandbox
  attributes and CSP are not reproduced (its frontend is not open source); a CSP that forbade inline
  script would refuse the injected source, and nothing here would know.
- **A composed frame with a plugin** (two objects, two styles): read, not measured (section 7b).
- **A notebook with the library borrowed over a BroadcastChannel** (Colab). The plugin script does not
  care whether it runs before the library; the three orders are tested in a page, not through a real
  borrow.
- **GPU-browser coverage of `tri`, `dot` and `bounds`.** The browser probe draws lines and one ball;
  triangles and bounds are node-tested only.

## 12. Follow-ups, not built

| | needs |
|---|---|
| Style-panel rows and a legend for a plugin | `rows()` / `legend()` in the definition and a mount in `parts/panel.js`, touching no DOM outside the viewer |
| `cover` / translucency | a real blend pass in `paintgl.js` |
| removing a plugin on a live viewer | the live block sends changed entries only; a removal would travel as `None` (see the set/unset trap in `CLAUDE.md`) once there is a `remove_plugin` |
| triangles on the GPU tube | a triangle instance type in `buildTube`; today such a frame goes to the 2D tube |
| a separate depth range for plugin geometry | only if the speckle in section 8 matters; it costs a second pass |
| multi-object in a browser | a probe with two aligned objects |
| `remove_plugin`, and what repeated `add_plugin` means | payloads accumulate today; decide replace, append or keyed |
| `_viewInto` timing | `_rotateAt` now goes through it; it is bit-for-bit equal but was not timed on a large structure |
| station / trajectory playback | a plugin whose key moves with the frame rebuilds the mesh per frame; not measured |
| a viewer teardown hook | so `dispose` has somewhere to be called from |

Not proposed: picking or selection of plugin geometry, a plugin marketplace, and any change to how
residues are drawn.

## 13. Tests

Run the node checks with `tests/run.sh node`; the browser probes need Chromium (`tests/README.md`).

| file | lane | claim |
|---|---|---|
| `tests/plugin_seam.js` | node | registry, seam and `paint2d` without a browser: nothing changes without a plugin, colour and depth order reach the canvas, the prim schema, the `apiVersion` messages, registration in every order, the budget (exactly the cap passes, one over draws nothing), a throwing plugin rolls back, the key moves with options / payload / frame, `bounds` and the per-axis floor, `noInk`, `_modelToView` equals `_rotateAt` and applies `alignTransform`, non-finite and absurd coordinates, one cap per painter and the SVG comment, `collectModel` (the tube's model-space capsules), `linesKeyOf` |
| `tests/plugin_state.py` | node | the round trip, unknown names kept and warned about once, a no-plugin page and state file byte-identical to the tree before this change (`--golden`), the page script and its escaping, per-page inlining, validation of every `add_plugin` argument |
| `tests/plugin_browser.py` | gpu | a wireframe in both painters and in PNG / SVG capture, a rotation without a GPU rebuild, the key moving the picture through a rebuild, a cube larger than the structure not clipped, the ball keeping the structure's cheap recolour, three registration orders, the `ink` toggle, a tight fit on both axes, 10,008 strokes with an SVG export that carries the comment, and all of it again in the TUBE on both painters (section 7b) |
| `tests/colab.py` | ui | a plugin added after `show()` reaches a viewer in another iframe, with its source, in either load order |
| `tests/bundles.js` | node | every bundle carries `py2dmolPlugins` |
