# py2Dmol embed API (reference)

Condensed from `embed.html`, which is the specification (`tests/embed.py` reads its code
samples and checks every call against a running viewer).

## Module functions

| call | does |
|---|---|
| `py2Dmol.show(target, text, options)` | build a viewer in `target` from PDB/mmCIF text; returns it |
| `py2Dmol.fetch(id)` | promise of a structure's text: 4 chars -> RCSB, else AlphaFold DB. Rejects on a bad id |
| `py2Dmol.frameFromText(text)` | one frame object from a file's text |
| `py2Dmol.framesFromText(text)` | every model in a file as frames |
| `py2Dmol.superpose(mobile, reference, {from, to})` | Kabsch fit computed on the index arrays `from`/`to` (e.g. alpha carbons), applied to every point of `mobile`. Works when the two differ in length (a mutant on its parent). A bad index throws |
| `py2Dmol.hydrophobicityBands` | the five Kyte-Doolittle bands, for a legend |

## Looking

| call | does |
|---|---|
| `v.setStyle(name)` | `tube`, `richardson`, `ribbon`, `3d` |
| `v.setColor(colour, sel?)` | a mode for everything, or a colour on part of it; colours accumulate until a mode is set again |
| `v.orient(sel?)` | frame that, the selection, or everything visible; `{animate: false}` jumps |
| `v.clip(sel)` | a slab as deep as the selection, refitted as it turns; `v.clip()` turns it off |
| `v.render(reason)` | redraw (the verbs above already do) |
| `v.toImage({format, dpi, transparent, dataUrl})` | promise of `{blob, format, width, height, dpi, text, dataUrl?}`; `svg` needs the 2D painter (the cpu bundle) |

## Selecting and visibility

| call | does |
|---|---|
| `v.select(sel)` / `v.unselect(sel)` | add to / take from the selection; `unselect()` clears |
| `v.hide(sel)` / `v.show(sel)` | subtract from / add to what is drawn |
| `v.resetVisibility()` | draw everything; `resetVisibility()` then `hide({not: sel})` shows only `sel` |
| `v.showSidechains(sel)` / `v.hideSidechains(sel)` | draw / remove side-chain atoms (relative) |
| `v.setSidechainColor(colour, sel?)` | a colour or a mode for the side chains alone; `null` follows the residue again. Only the carbon skeleton changes - O stays red, N blue |
| `v.showElements(sel)` / `v.hideElements(sel)` | element colouring of atoms (on by default for ligands and drawn side chains) |
| `v.setVisibility(patch)` / `v.getVisibility()` | the lower level under hide/show; prefer those |

## Structures and frames

| call | does |
|---|---|
| `v.load(text, name)` | another structure under its own name; loading over a name replaces it |
| `v.showObjects(names)` | which structures are drawn together |
| `v.setFrame(i)` | step to a frame |
| `v.addFrame(frame, name)` | append a frame (a trajectory) |
| `v.replaceFrame(frame, name?)` | replace the LAST frame - for animation; the count never moves |
| `v.addObject(name)` | an empty object to add frames to |
| `v.resetAll()` | back to an empty viewer |
| `v.setSlots(['pae', 'structure'])` | what each slot shows (structure, a map key, scatter) |

## Contacts

`v.setContacts(list, name?)` replaces; an empty list clears. Within one object an end is a
position or a chain-and-residue pair:

```js
v.setContacts([[5, 60, 1.0], [10, 40, 0.4, {r: 255, g: 0, b: 0}]]);
v.setContacts([['A', 12, 'B', 34, 1.0]]);
```

An end written as a one-residue selector may be in a different structure; such a contact
belongs to the viewer, so pass no name:

```js
v.setContacts([[{object: 'ubiquitin', residues: [10]}, {object: 'copy', residues: [40]}, 1.0]]);
```

## A heatmap beside the structure

```html
<div id="v"></div>
<div id="heatmapContainer"><canvas id="heatmapCanvas"></canvas></div>
<script>
  const v = py2Dmol.show('v', text, {controls: true, heatmap: {enabled: true}});
  // put a matrix on the frame: frame.maps = {contact: {data: [[...]], vmin: 0, vmax: 1}}
</script>
```

`embed.html` section 16 computes a contact map from the drawn alpha carbons and attaches it
with `replaceFrame`.

## The full app's doors (`py2Dmol.full.min.js`)

- `py2dmolLoadFiles(files, loadAsFrames, groupName)` - ingestion with virtual files
  `{name, readAsync}`; the extension decides the kind (`.pdb`/`.cif` structure, `.json` PAE
  paired by basename, `.a3m`/`.fasta` alignment, `.cst` contacts).
- `py2dmolReadyMessage` - replaces the idle status line.
- Host the parts of `index.html`'s markup whose features are wanted; each panel needs its own
  elements.
