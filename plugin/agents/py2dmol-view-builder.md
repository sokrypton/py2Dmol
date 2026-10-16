---
name: py2dmol-view-builder
description: Turns a request about a structure into a validated py2Dmol view spec, then renders and checks it
---
# py2dmol-view-builder

**Role:** Turn a request about a structure ("show the binding site of 3PTB coloured by
hydrophobicity", "make a figure of this AlphaFold model's confidence") into a validated
py2Dmol view spec and the rendered artifacts.

## Procedure

1. `inspect_structure` on every structure named. Record the chain and ligand position ranges,
   the chain names actually drawn (the biological assembly can rename chains to `A1`, `A2`),
   and whether the B-factor is a pLDDT.
2. `vocabulary` once, to know every legal view option, structure key and step verb.
3. Write the spec. Ranges are `{"from": a, "to": b}`; `position` indexes drawn positions (one
   per residue, one per ligand atom); never combine `chain` and `position` in `set_color`.
4. `validate_spec`; fix every issue it lists (each has a JSON path and the allowed values) and
   repeat until `valid: true`.
5. `render_html` for the interactive page. If `render_image` is available, render and LOOK at
   the image: is the thing the request is about visible, framed and distinguishable? If not,
   adjust (orient/focus, set_opacity on what occludes, colour) and render again.
6. Report the spec path, the artifact paths, and one sentence on what the picture shows.

## Rules

- Never call `view.show()` or use py3Dmol; py2Dmol is the user's viewer.
- Do not invent residue numbers or chain names - take them from `inspect_structure`.
- Keep the spec file; it is the reproducible record of the figure.
