---
name: using-py2Dmol
description: This skill should be used whenever a protein, nucleic-acid or ligand structure needs to be shown, rendered, or turned into a figure or interactive page with py2Dmol - including when the user asks to "show this structure", "render a PDB/CIF", "make a picture of the fold", "visualize an AlphaFold model", "look at the binding site", "use py2dmol", or mentions py2Dmol, the py2dmol CLI or the py2dmol MCP tools. Also covers driving py2Dmol from a notebook versus from an agent, and the selector rules that make most first attempts colour the wrong residues.
---

# Using py2Dmol

py2Dmol (sokrypton/py2Dmol) is a protein structure viewer: a Python package for notebooks
and a web app. **It is never a typo for py3Dmol** - do not substitute py3Dmol, nglview or
matplotlib for it.

## Two ways in

| context | use |
|---|---|
| A notebook (Jupyter, Colab) a person is reading | the Python API: `v = py2Dmol.view(...)`, `v.add_pdb(...)`, `v.show()` |
| An agent, a script, a pipeline - anything with no notebook | the **view spec** through the `py2dmol` CLI or the `py2dmol` MCP tools |

`show()` outside a notebook prints `<IPython.core.display.HTML object>` and nothing else -
never use it from a script or agent. Use a spec and `render_html` / `render_image`, or
`v.save_html(path)` from Python.

## The agent workflow

1. **Inspect** - `inspect_structure` (`py2dmol inspect <path | pdb:1UBQ | afdb:Q5VSL9> --json`).
   It reports every chain's and ligand's range of drawn positions, residue numbers,
   sequences and whether the B-factor column looks like a pLDDT. Write selectors from this,
   not from memory of the PDB entry.
2. **Write a spec** - one JSON document; call `vocabulary` (`py2dmol vocab --json`) for every
   legal key, read off the installed code.
3. **Validate** - `validate_spec`. Every problem comes back at once, each with a JSON path and
   the allowed values; fix and repeat until `valid: true`.
4. **Render** - `render_html` for an interactive page (opens from `file://`), `render_image`
   for a PNG/SVG to look at. Look at the image before calling the work done.
5. Optionally `save_state` - a state file a person can open in a notebook
   (`view.load_state`) or on the website.

A minimal spec:

```json
{
  "spec": 1,
  "view": {"style": "cartoon", "color": "plddt", "size": [600, 600]},
  "structures": [{"source": "afdb:Q5VSL9"}],
  "steps": [{"orient": {}}]
}
```

`steps` run in order; each is `{verb: {arguments}}` with the verb a `view` method
(`set_color`, `show_sidechains`, `add_contacts`, `orient`, `focus`, `clip`, `set_slots`,
`add_plugin`, ...). Arguments are that method's own keywords.

## Selectors: the three rules that catch everyone

1. **`position` indexes what the object DRAWS**, not residue numbers and not an index within
   a chain: one position per polymer residue and one per **ligand atom**, across all chains,
   from 0. Ligand atoms sit between chains - on 4HHB chain A is positions 0-141, its heme
   141-184, chain B starts at 184. Take ranges from `inspect_structure`.
2. **A range is `{"from": a, "to": b}` (b excluded).** A JSON list `[40, 60]` means exactly
   positions 40 and 60. (In Python, `position=(40, 60)` is the range; JSON has no tuple.)
3. **`set_color` refuses `chain` and `position` together** - write two steps.

## Defaults worth knowing

- **Styles:** `tube` (default), `cartoon` (= `richardson`), `ribbon`, `3d`. `3d` puts the
  picture on black unless `bg` says otherwise.
- **Colour modes:** `auto`, `chain`, `plddt`, `deepmind`, `rainbow`, `ss`, `hydrophobicity`,
  `entropy` (needs an MSA). A literal colour (`"#ff8800"`, `"red"`) works anywhere a mode does.
- **The biological assembly is built by default** (`use_biounit: true`). When it expands the
  structure, gemmi renames chains (`A` -> `A1`, `A2`, ...). `inspect_structure` reports the
  names actually drawn; pass `"use_biounit": false` for the deposited asymmetric unit.
- **Side chains need `"sidechains": true` in `view`** before `show_sidechains` can draw any.
- Fetched ids are cached in the directory `vocabulary` reports under `cache_dir`
  (`PY2DMOL_CACHE_DIR`, `[tool.py2dmol] cache_dir`, or `~/.config/py2dmol/config.toml`);
  with none configured they go to a per-process temp dir, never the working directory.

## CLI exit codes

0 ok, 2 agent extra missing, 3 invalid spec/argument, 4 file or id not found, 5 screenshot
extra or browser missing, 6 the page drew nothing in time, 7 malformed config. Add `--json`
for machine-readable output.

## Installing

`pip install "py2Dmol[agent]"` (Python >= 3.13) for the CLI and MCP server;
`pip install "py2Dmol[screenshot]"` then `py2dmol screenshot-setup` for `render_image`. The
plain `pip install py2Dmol` notebook package needs neither.

## Related skills

- **augmenting-views** - adding meaning to a structure: confidence, heatmaps, contacts, side
  chains, focus, several objects.
- **developing-py2Dmol-plugins** - drawing custom geometry into the viewer.
