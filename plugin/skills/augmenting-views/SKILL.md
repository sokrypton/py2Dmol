---
name: augmenting-views
description: This skill should be used when a py2Dmol view of a structure needs to carry more than the fold - when the user asks to "colour by pLDDT/confidence", "show the PAE", "add a contact map / heatmap", "show contacts / restraints / interactions", "show side chains at the interface", "highlight the binding site", "focus on the ligand", "compare two models / overlay structures", "colour by hydrophobicity", or to make a figure that explains a prediction, a design or a binding mode. Assumes the using-py2Dmol workflow (inspect, spec, validate, render).
---
# Augmenting py2Dmol views

Each augmentation below is a spec fragment. Always start from `inspect_structure` for
position ranges, validate the spec, and render an image to check the result reads.

## Confidence (predicted structures)

- Colour: `"view": {"color": "plddt"}` (or `"deepmind"` for AlphaFold's four bands). Only
  meaningful when `inspect_structure` says `b_factor_may_be_plddt: true`; on a crystal
  structure the B-factor is not a confidence.
- PAE: `"view": {"pae": true}`. For `afdb:` sources it is fetched; for a file give
  `"pae": "path/to/pae.json"` on the structure.
- The pLDDT trace as its own panel: `"view": {"plddt": true}`.

## Heatmaps (any residue x residue matrix)

Turn the panel on with `"view": {"heatmap": true}` and pass matrices on the structure:

```json
{"source": "model.cif",
 "maps": {"contact": {"data": [[...L x L...]], "vmin": 0, "vmax": 1,
                      "colors": ["#ffffff", "#253494"], "xlabel": "Residue", "ylabel": "Residue"}}}
```

A bare matrix takes the built-in scale for its key (`pae` 0-31.875 A blue-white-red,
`contact` 0-1 white to indigo); any other key gets grey unless it states `colors`. A box
dragged on any map selects the same residues. `set_slots` chooses which slot shows what:
`{"set_slots": {"views": ["structure", "contact"]}}`, or `{"views": ["pae"], "count": 1}` for
one box with tabs.

## Contacts and restraints

```json
{"add_contacts": {"contacts": [[10, 50, 1.0], ["A", 10, "B", 50, 0.5, "#ff0000"]]}}
```

By position index `[i, j, weight, colour?]` or by chain and residue number
`[chainA, resA, chainB, resB, weight, colour?]`. It REPLACES the object's contacts; an empty
list clears them. A contact is a line between two positions - to colour one residue use
`set_color`.

## Side chains and binding sites

```json
"view": {"sidechains": true},
"steps": [
  {"show_sidechains": {"position": {"from": 55, "to": 65}}},
  {"focus": {"chain": "C", "position": 0}}
]
```

`sidechains: true` in `view` is required or there are no atoms to draw. `show_sidechains` /
`hide_sidechains` are relative (add / take away) and run in order. `focus` frames one residue
or ligand with its neighbourhood (side chains of residues within the cutoff) without rotating;
`orient` turns the structure to face the reader and frames a selection; `clip` cuts a slab as
deep as a selection.

## Colour that answers a question

- `set_color` with a literal or a mode, scoped by `name`, `chain` or `position` (not chain and
  position together). Later steps override earlier ones where they overlap.
- `"hydrophobicity"` (Kyte-Doolittle, five bands, grey for non-protein) shows a buried core or
  an exposed patch.
- `"ss"` colours by secondary structure.
- `set_opacity` fades residues so what is behind them shows through - the fix for a side chain
  hidden inside the fold, which no camera angle reveals.

## Several structures

Add several structures; each is an object named for its file (or `name`). They are superposed
on load (`"align": true` default). `{"show_objects": {}}` draws them all at once,
`{"show_objects": {"names": ["apo", "holo"]}}` a subset. Trajectories (multi-model files) share
one timeline; a shorter object HOLDS its last frame by default (`set_frame_policy` with
`"loop"` or `"stretch"` when that is what the data means).

## Check the picture

Render with `render_image` and look at it: an augmentation that is drawn but hidden (behind the
fold, off-frame, the same colour as its neighbour) is the common failure, and only the image
shows it. Re-orient or focus, fade what occludes, and render again.
