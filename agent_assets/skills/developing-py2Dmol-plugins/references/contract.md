# py2Dmol plugin contract (reference)

Condensed from `docs/PLUGINS.md` in the py2Dmol repository, which is authoritative.

## `ctx`, passed to key / bounds / prims / setPayload / dispose

`renderer`, `host`, `instance` (what `init` returned), `name`, `version`, `apiVersion`,
`options`, `payloads` (`[{object, frame, payload, index}]` - only those that apply to what
is drawn now), `frame`, `maxPrims`, `painter` (`'2d'`, `'gpu'` or `'svg'`), `scale`,
`toView(p, objectName?)`, `project(x, y, z)`, and the three helpers below.

`init(host)` runs once per viewer; `host = {renderer, viewerId, requestRender()}`.

## Helpers

| helper | options | notes |
|---|---|---|
| `ctx.line(a, b, {color, width, ink})` | `width` Angstrom, default 0.35 | joints are added for you |
| `ctx.dot(p, {color, radius, ink})` | `radius` Angstrom, default 0.5 | colour baked; recolouring the structure leaves it alone |
| `ctx.tri(a, b, c, {color})` | | opaque, flat-shaded, double-sided, lit by its own normal |

Colour: `[r,g,b]`, `{r,g,b}` or `'#rrggbb'`. Each helper returns `false` and drops the
primitive for a point behind the camera (perspective), a non-finite coordinate, or one more
than 50x the structure's extent (never less than 500 A) from the view centre; the plugin then
shows an error state counting the drops.

## Budget

Defaults 2D 8,000 and GPU 60,000 primitives per plugin per frame
(`window.py2dmolPlugins.caps`, changeable by a host page before a viewer renders). Over the
cap the helper throws `PluginBudgetError`; the plugin draws nothing that frame and says so on
the console, in a badge inside the viewer, and in `py2dmolPlugins.errors(renderer)`. An SVG
export is always the 2D painter and so the 2D cap; it writes the refusal as an XML comment in
the file. Any other exception in `prims` is treated the same way and its partial output is
rolled back.

## Error states

`py2dmolPlugins.rejected` - refusals at registration (`{name, message}`).
`py2dmolPlugins.errors(renderer)` - `[{name, message, painter}]`, painter one of
`'2d'`, `'gpu'`, `'svg'`, or `'load'` for `init` / `setPayload` / `key` / `bounds`.
`register()` returns the definition, the existing one (same name and version), or `null` for
a refusal; it never throws.

## Framing

`bounds(ctx)` becomes a radius about the view centre and floors the FITTED span (per axis),
so the default view and every "orient to everything" frame the plugin. A span set by orient
to a selection, focus, or the app is not floored, so focusing one residue can still zoom
inside a shell drawn around it. A plugin that arrives after the opening orient is framed at
the next orient to everything.

## GPU depth range

Plugin strokes are folded into the GPU's depth range so a shape larger than the structure is
not clipped. The cost: a plugin reaching well past the structure (measured at 2.9x its radius
on 1CRN) moves about 1% of the cartoon's ink on the GPU through depth tie-breaks; inside the
radius it costs nothing.

## State

`save_state` writes payloads under a top-level `plugins` key (only when there are any), and
the website's session file does the same. An unknown plugin in a loaded state is kept
verbatim with one warning.

## Tube style

Both styles draw plugins. The GPU tube draws lines and balls as capsules and hands any frame
with a plugin triangle to the 2D tube.
