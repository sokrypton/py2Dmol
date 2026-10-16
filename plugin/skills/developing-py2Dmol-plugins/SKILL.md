---
name: developing-py2Dmol-plugins
description: This skill should be used when writing, debugging or reviewing a py2Dmol draw plugin - JavaScript that draws extra geometry (lines, balls, triangles) into a py2Dmol viewer alongside the cartoon - or when the user asks to "write a py2Dmol plugin", "draw a box/grid/arrow/mesh/density in py2Dmol", "add custom geometry to the viewer", "register_plugin", "add_plugin", "set_plugin_option", or reports a plugin that draws nothing, is clipped, or shows an error badge.
---
# Developing py2Dmol draw plugins

A py2Dmol plugin is a named JavaScript module that returns primitives - lines, dots
(balls) and triangles - in the structure's own model coordinates. The viewer depth-sorts
them with the cartoon in both painters (2D canvas and WebGL2), includes them in PNG and
SVG exports, and carries their payloads through `save_state` / `load_state`. Python only
transports a JSON payload; the plugin defines its meaning.

`py2dmol` is the user's viewer (sokrypton/py2Dmol), never a typo for py3Dmol.

## The two halves

**JavaScript** registers a definition on `window.py2dmolPlugins`, working whether it runs
before or after the library:

```js
(function () {
  var P = window.py2dmolPlugins = window.py2dmolPlugins || {list: [], pending: []};
  var def = {
    name: "mine", version: "1", apiVersion: 1,
    options: {shown: true},          // defaults; a viewer's options merge over them
    key(ctx)    { /* everything that changes prims() - the GPU rebuilds only when it moves */ },
    bounds(ctx) { /* {min:[x,y,z], max:[x,y,z]} in MODEL space, or null - joins fit-to-view */ },
    prims(ctx)  { /* ctx.line(a, b, {color, width}) / ctx.dot(p, {color, radius}) / ctx.tri(a, b, c, {color}) */ },
    // optional: init(host), setPayload(ctx), dispose(ctx)
  };
  if (P.register) P.register(def); else P.pending.push(def);
})();
```

**Python** registers the source once and gives a viewer payloads:

```python
py2Dmol.register_plugin("mine", open("mine.js").read(), version="1")
v = py2Dmol.view()
v.add_pdb("4HHB.cif")
v.add_plugin("mine", {"points": [[0, 0, 0], [10, 0, 0]]}, object=None, frame=None)
v.set_plugin_option("mine", "shown", False)
```

In a view spec (the agent surface) the same thing is
`"plugins": [{"name": "mine", "source": "mine.js", "version": "1"}]` plus a step
`{"add_plugin": {"name": "mine", "payload": {...}}}`.

## Workflow

1. Copy `assets/box.js` as a starting point: it shows `key`, `bounds` and `prims`
   reading `ctx.payloads` and `ctx.options`.
2. Iterate with the plugin check, which runs Python's registration rules and then draws
   the plugin into a real structure in headless Chromium and reports the registry's own
   state:
   ```
   py2dmol plugin-check mine.js mine --payload '{"min":[0,0,0],"max":[10,10,10]}' \
       --structure pdb:1UBQ --out mine.png --json
   ```
   (MCP: the `plugin_check` tool.) `ok: true` needs `registered_in_page`, no `rejected`
   and no `errors`. Look at `mine.png`.
3. Build the real view with a spec and `render_image` to see it in context.

## Rules that are easy to get wrong

- **Coordinates are model space** - the file's Angstrom, not screen pixels. Use
  `inspect_structure` or the coordinates themselves for scale; `ctx.toView(p)` maps a point
  when needed.
- **`key()` must cover everything `prims()` reads.** The GPU bakes plugin prims into its
  mesh and rebuilds only when the combined key moves; a missing term means a change that
  never appears on the GPU painter while the 2D painter shows it.
- **The budget throws, it does not truncate:** 8,000 primitives per plugin per frame on
  2D (and every SVG export), 60,000 on the GPU. One over drops the whole plugin for that
  frame with an error badge; draw less, or decimate.
- **Non-finite or absurd coordinates drop that primitive** (NaN, Infinity, or more than 50x
  the structure's extent from the view centre). `bounds()` is held to the same rule.
- **Source text may not contain `</script` or `<!--`** - `register_plugin` refuses it. Write
  `"<\/script>"`. Payloads need no escaping; NaN and sets in a payload are refused.
- **Names** match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`.
- **A payload lives on the viewer, not an object**; `object=` / `frame=` only choose where it
  applies. A plugin draws in a viewer only where that viewer has a payload for it.
- **Re-registering the same name** with new code or a new version replaces it (`dispose` is
  called on the old one). Do not rely on `dispose` for per-viewer cleanup.
- **No sandbox.** Plugin JavaScript is inline script in the page, like the core.
- Prims are `noInk` by default (no dark outline); pass `ink: true` to a helper for one.

## Additional resources

- **`references/contract.md`** - the full `ctx` object, helper options, error states,
  framing and the GPU depth-range coupling.
- **`assets/box.js`** - a complete plugin, checked clean with plugin_check.
- In a py2Dmol checkout, `docs/PLUGINS.md` is the authoritative design document and
  `tests/plugin_seam.js`, `tests/plugin_state.py`, `tests/plugin_browser.py` are its tests.
