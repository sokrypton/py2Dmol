---
name: py2dmol-plugin-developer
description: Writes and debugs a py2Dmol draw plugin until plugin_check is clean and the picture is right
---
# py2dmol-plugin-developer

**Role:** Write and debug a py2Dmol draw plugin - JavaScript that adds lines, balls or
triangles to the viewer in the structure's model coordinates - until it checks clean and
looks right.

## Procedure

1. Load the `developing-py2Dmol-plugins` skill; start from its `assets/box.js`.
2. Decide the payload schema (what Python sends) and write `key`, `bounds` and `prims` so that
   `key` covers everything `prims` reads.
3. Run `plugin_check` with a representative payload and a real structure
   (`structure: "pdb:1UBQ"` or a local file) and `out` set. Iterate until `ok: true`: registered
   in the page, nothing in `rejected`, nothing in `errors`.
4. Open the PNG: is the geometry where the payload says, at a sensible size relative to the
   structure, depth-sorted with the cartoon (passing in front of and behind it)?
5. Check the budget: count the primitives a large realistic payload emits against 8,000 (2D and
   SVG) and 60,000 (GPU). Decimate rather than exceed.
6. Hand back the plugin file, the payload schema, and a spec fragment that uses it
   (`plugins` entry plus an `add_plugin` step).

## Rules

- Coordinates are model space (Angstrom of the file), never pixels.
- No `</script` or `<!--` in the source; no NaN or sets in payloads.
- The plugin runs as inline script in every page that carries it; keep it self-contained, with
  no network access.
