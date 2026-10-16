---
name: embedding-py2Dmol
description: This skill should be used when putting a py2Dmol viewer on a web page with no Python - when the user asks to "embed a structure in a web page", "add a protein viewer to my site/app", "use py2Dmol from JavaScript", "py2Dmol.show", "which py2Dmol bundle", "show a PAE/heatmap on my page", "animate a structure in the browser", or is wiring py2Dmol into a host app (LocalFold-style) with its own markup. Covers bundle choice, the show() options, the selector grammar, the panels' markup requirements and the traps that make an embed draw nothing.
---
# Embedding py2Dmol in a web page

py2Dmol's embed API is one script tag and one call. No Python and no build step:

```html
<div id="mol" style="width:400px;height:400px"></div>
<script src="https://py2dmol.solab.org/py2Dmol/resources/bundles/py2Dmol.embed.min.js"></script>
<script>
  py2Dmol.fetch('1UBQ').then((text) => {
    const v = py2Dmol.show('mol', text, {style: 'richardson', color: 'chain'});
    v.orient({chain: 'A'});
  });
</script>
```

`py2Dmol.show(target, text, options)` creates the canvas inside `target` (an element or its
id), detects mmCIF vs PDB from the text, and returns the viewer. `py2Dmol.fetch(id)` returns
a structure's text: four characters go to the PDB, anything else to AlphaFold DB.
`assets/minimal.html` is a complete page to copy.

## Choose the bundle first

| file | painter | pick it when |
|---|---|---|
| `py2Dmol.embed.min.js` | WebGL2 | the default; large structures stay smooth |
| `py2Dmol.embed.cpu.min.js` | 2D canvas | no WebGL2, or SVG export is needed |
| `py2Dmol.full.min.js` | both, plus the whole web app | the page wants the app's sequence strip, MSA, sessions, file ingestion or TM-align |

- **Neither embed bundle falls back to the other.** The WebGL2 build on a browser without
  WebGL2 draws nothing and says so on the console. There is no `gpu` option - passing one
  throws; the file decides the painter.
- **`full` needs two script tags:** `align/align.js` is loaded separately (as `index.html`
  does) because no bundle contains it; every alignment method throws until it is loaded.

## Options to `show`

`width`, `height` (default: the element's size), `style` (`tube` default, `richardson`,
`ribbon`, `3d`), `color` (`auto`, `chain`, `rainbow`, `plddt`, `deepmind`, `ss`,
`hydrophobicity`), `bg` (`3d` defaults to black), `box`, `name`, `biounit` (default true -
build the biological assembly), `orient` (default true), `select` (click picks a residue),
`controls` (the Style panel), `play` (frame strip; on by itself for multi-model files).
Anything else is viewer configuration: `detail` (2-8), `shadow`, `outline`, `ortho`,
`colorblind`, `rotate`, `autoplay`, `cyclic`, `heatmap: {enabled: true}`.

## The selector (one grammar for every verb)

`'B'` a chain; `[3, 4, 5]` positions; or an object whose keys narrow each other:
`{chain}`, `{positions}`, `{range: [a, b]}` (half open), `{residues}` (the file's numbering),
`{type: 'L'|'P'|'N'}`, `{near: sel}` (within 5 A, atom to atom), `{angstroms}`, `{object}`,
`{not: sel}`. `{chain: 'B', residues: [12]}` is one residue. An unknown key throws.

**Positions are not residue numbers.** A position counts from zero across everything drawn
(one per residue, one per ligand atom); a residue number is the file's. Both are integers and
nothing warns when one is passed for the other. Prefer `{chain, residues}` when the file's
numbering is what is known.

## Common verbs

`v.setStyle(name)`, `v.setColor(colour, sel?)` (colours accumulate until a mode is set again),
`v.orient(sel?)`, `v.clip(sel)` / `v.clip()`, `v.select(sel)` / `v.unselect(sel)`,
`v.hide(sel)` / `v.show(sel)` / `v.resetVisibility()`, `v.showSidechains(sel)` /
`v.hideSidechains(sel)`, `v.setSidechainColor(colour, sel?)`, `v.setContacts(list, name?)`,
`v.load(text, name)`, `v.showObjects(names)`, `v.setFrame(i)`, `v.toImage({format, dpi})`.
Full table and the animation and alignment calls: `references/api.md`.

## Traps

- **Panels need the host's markup.** A panel finds its own elements and does nothing until
  they exist: the heatmap wants `#heatmapContainer` holding `#heatmapCanvas` (the older
  `#paeContainer` / `#paeCanvas` still work). Put panel markup BESIDE the viewer's element,
  never inside - `show()` replaces its container's children. And `controls: true` is what
  mounts panels at all on the embed path.
- **Two viewers on one page:** the PAE/heatmap panel scopes to its container; the full app's
  sequence strip and MSA look elements up on `document`, so two of those would find each
  other's.
- **Animate with `replaceFrame`, not `addFrame`.** Morphing between conformations by appending
  frames fills the play bar with steps that are not frames of anything. Parse once with
  `py2Dmol.framesFromText`, then `v.replaceFrame(frame)` per step: the frame count never moves
  and the camera stays put.
- **Elements need element columns.** Element colouring of ligands and side chains reads PDB
  columns 77-78; garbage there (e.g. a serial number) colours every atom one flat colour.
- **A host stylesheet can reach the viewer's controls.** The shell scopes its own CSS, but a
  page rule on bare `button` still applies margins; style the page's own buttons by class.

## Additional resources

- **`references/api.md`** - the complete verb table, frames and animation, `superpose`,
  contacts across structures, and the full-app doors (`py2dmolLoadFiles`).
- **`assets/minimal.html`** - a working page.
- `https://py2dmol.solab.org/embed.html` - every call above, running; in a checkout,
  `embed.html` is the specification `tests/embed.py` checks.
