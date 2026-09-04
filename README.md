# py2Dmol

A Python library for visualizing protein, DNA, and RNA structures in 2D, designed for Google Colab and Jupyter.

<img width="905" height="391" alt="image" src="https://github.com/user-attachments/assets/9eaf329f-e8ab-4338-be62-f5878aa25f96" />



Bonus: [online interactive version](http://py2dmol.solab.org/)  
<a href="https://colab.research.google.com/github/sokrypton/py2Dmol/blob/main/py2Dmol_demo.ipynb" target="_parent"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"/></a>

## Installation
```bash
pip install py2Dmol
```
### latest experimental
```bash
pip install git+https://github.com/sokrypton/py2Dmol.git
```

### Requirements
A browser with **WebGL2**, which every current browser has. The notebook draws
on the GPU: turning and zooming cost one draw call rather than a full repaint,
which is what makes a large structure usable — 26 ms a frame on a 313,000-atom
capsid, against 840 ms without it.

## Quickstart: core workflow
`py2Dmol` has two modes—decided by when you call `show()`:
- **Static**: `add*()` then `show()` → one self-contained viewer.
- **Live**: `show()` then `add*()` → stream frames/points as you go.

### Load a PDB (static)
```python
import py2Dmol
viewer = py2Dmol.view()
viewer.add_pdb('6MRR')
viewer.show()
```

### Load a PDB (live)
#### cell #1
```python
import py2Dmol
viewer = py2Dmol.view()
viewer.show()
```
#### cell #2
```python
viewer.add_pdb('6MRR')
```

### Helpful loading shortcuts
```python
py2Dmol.view(autoplay=True).from_pdb('1YNE')                        # ensemble
py2Dmol.view(rotate=True).from_pdb('1BJP', use_biounit=True)        # biounit
py2Dmol.view().from_pdb('9D2J')                                     # multi-chain
py2Dmol.view(pae=True).from_afdb('Q5VSL9')                          # AlphaFold + pAE
```

### Basic viewer options
```python
viewer = py2Dmol.view(
    size=(300, 300), color='auto', colorblind=False,
    style='tube',  # or 'cartoon' for secondary-structure cartoons
    shadow=True, outline='full', width=3.0, ortho=1.0,
    rotate=False, autoplay=False, box=True, controls=True,
)
viewer.add_pdb("my_complex.cif")
viewer.show()
```

### Render styles
Four styles, switchable live from the Style dropdown:
- **`tube`** (default) — the classic py2Dmol smooth backbone trace.
- **`richardson`** — the hand-drawn look of Jane Richardson's protein drawings: flat wide helices, thick arrowheaded strands with white card edges, and coloured-pencil paper grain.
- **`ribbon`** — plain flat cartoon: twisted ribbons for helices, arrowhead plates for strands, thin tubes for loops, and none of the above.
- **`3d`** — solid shaded geometry, on a black background. Pass `bg=` to override.

The last three are all cartoons, and each is a starting point that loads into
the normal controls — the sliders stay live for tweaking under any of them.
`style="cartoon"` still works and means `richardson`.

```python
py2Dmol.view(style='richardson').from_pdb('1A3N', use_biounit=True)
py2Dmol.view(style='richardson', color='ss').from_pdb('1TIM')
py2Dmol.view(style='ribbon').from_pdb('1TIM')                      # plain cartoon
py2Dmol.view(style='3d').from_pdb('1TIM')                          # solid, on black
py2Dmol.view(style='richardson', pencil=0, sheet_flat=0).from_pdb('1TIM')
```

An explicit argument always wins over the style's own defaults. Both styles work on C-alpha-only models — the backbone, its secondary structure, and where nucleic
bases point are all rebuilt from the trace, with nothing per-residue stored or
shipped. `tests/README.md` has the accuracy numbers.

#### Cartoon options
All are `view()` arguments and all have a slider in the panel:

| | |
| --- | --- |
| `thickness` | slab thickness in Å (`0` = flat ribbons). Tapers off as you zoom out. |
| `width` | overall ribbon scale |
| `shade` | 0–1, how much directional modelling: `0` is flat colour, `1` full light and inner shadow |
| `highlight` | specular band, *not* scaled by `shade` — so `shade=0, highlight=2` is flat colour with a highlight on top |
| `detail` | 2–8 subdivisions per residue. Exactly this, at every canvas size, zoom and structure size. |
| `arrows` | arrowhead on each strand's C-terminal end (default on) |
| `sheet_flat` | 0–1, damps the β-pleat and smooths loops |
| `pencil` | 0–1, coloured-pencil paper grain, on the structure only |
| `outline` | width in pixels; fractional values are real, and it thins to a hairline before `0` turns it off |

`color='ss'` colours by secondary structure, with the palette set by `ss_palette`
or the SSE dropdown: `pymol` (default) or `jmol`. It works with any style.

**SVG and PNG export** reproduce all of this, grain and gradients included.

#### Draw
**Draw** (in the Style panel) builds the picture up the way an illustrator makes
one: a pencil line first, then colour over it, slightly off register. It ends on
watercolour over pencil and stays there; turning it off returns the ordinary
picture, pressing it again replays from blank paper. The view stays live while it
draws. Cartoon style only.

#### Saving
The camera button writes a PNG or SVG. PNG takes a DPI — 300 dpi on a 600px view
renders at 1875x1875 rather than scaling up — and the background is always
transparent. Shift-click skips the panel.

With **Rotate** or **Draw** on, the same button records a video instead: one
seamless full turn, or the drawing being made.
A GIF's background is transparent by default; the **Bg** menu beside the format
sets it to the paper colour instead, for a player that shows transparency as
black.

**A folder of them, without clicking a thousand times.** Open
[`render.html`](render.html), drop the structures onto it, set the look once
against a live preview and press *Render all* — every picture comes back as one
zip. Nothing is uploaded: the files are read in the browser and the zip is built
there, so it works offline and on structures you cannot send anywhere.

From your own code it is `renderer.toImage({format, dpi})`, which renders
exactly what the camera button renders and hands back the bytes instead of
starting a download.

#### Getting around
**Moving the view.** Drag to rotate, scroll to zoom, middle-drag or
Cmd/Ctrl-drag to pan, as in PyMOL. Panning moves the rotation centre, so
rotation and zoom keep working about the point you dragged to.

**Aiming the camera from Python.** A viewer turns to face the reader once, by
itself, when the first frame lands. `orient` asks for it again — after a
colour, after a clip, after the reader has spun it somewhere unhelpful.

```python
viewer.orient()                    # best view of what is on screen
viewer.orient(chain="B")           # ...of chain B
viewer.orient(position=(40, 60))   # ...of a loop, close up
viewer.orient(chain="B", animate=False)   # jump instead of flying
```

It orients on **what you can see**: a hidden residue cannot pull the view
towards itself. The Orient button in the viewer, on the website and in an
embed all run the same search.

**Side chains.** A notebook payload carries one position per residue, which is
all the tube and the cartoon need. `py2Dmol.view(sidechains=True)` carries the
side-chain atoms as well, so they can be drawn and so `focus` can measure side
chain to side chain. It costs about four times the coordinates **per frame**
(a 251-residue design: 9.0 KB a frame becomes 37.2), so it is off by default
and worth thinking about before loading a long trajectory.

**Focusing on one thing.** `focus` is the click-and-look-at-it move: it selects
the residue or ligand, draws the side chains of everything within 5 Å of it,
moves the camera in, and cuts a slab around it. The next `focus` replaces all
four, so you can walk from one residue to the next without side chains piling
up behind you.

```python
viewer.focus(chain="C", position=0)   # a ligand and its pocket
viewer.focus(position=(40, 41))       # one residue, close up
viewer.focus()                        # back out again
```

**It does not turn the structure** — only the centre and the zoom move, so you
keep your bearings. That is the difference between `focus` and `orient`. The
camera glides rather than jumping.

The **Focus** button beside Style does the same thing on every click: press it,
click a residue or a ligand, click the next one, and click the background to
come back out.

**Cutting into it.** `clip` keeps a slab as deep as a selection and holds it
there as the structure turns — so to cut deeper, clip to less.

```python
viewer.clip(position=(40, 60))   # a slab over residues 40–59
viewer.clip(chain="B")           # ...as deep as chain B
viewer.clip()                    # off
```

The depth is the selection's own depth along the view; there is no thickness to
set, and the renderer refits it every frame. The Clip button does the same
thing to whatever is selected.

**Bonds in a ligand.** Most files do not list them — mmCIF's `_struct_conn`
carries the exceptions, not the ordinary bonds inside a residue — so they are
derived from distance, per pair of elements: S–S out to 2.4 Å, C–O to 1.65,
C–I to 2.4. Pass `position_elements` with your coordinates and that table is
used; without it every pair falls back to one number, `cutoffs["ligand_bond"]`
(2.0 Å), which misses a disulfide at 2.05 and joins an O···O contact at 1.9.

```python
viewer.add(xyz, position_types=['L'] * 4,
           position_elements=['S', 'S', 'O', 'O'])
viewer.add(xyz, bonds=[[0, 1]])          # ...or say so outright
```

Setting `cutoffs={"ligand_bond": 2.2}` still means that number for every pair,
as it always did. Note the element is not the atom name — in 3PTB `CA` is both
the alpha carbon and the calcium ion — and only the element travels: an atom's
name was carried everywhere and read by nothing, so it was dropped.

**The selection panel.** The website's own, in a notebook: click a residue and it
slides in beside the viewer.

```python
viewer = py2Dmol.view(selection=True)
viewer.add_pdb('3PTB.cif')
```

Colour (a PyMOL palette or a scheme, on the main chain and the side chains
separately), Show/Hide per part, element colours, base plates, a
secondary-structure override, contacts between a pair, Find interactions, and
Copy / Cut / Delete. Every one of those was already in the library; until now
only the web app had a control that reached them.

One flag for the panel and for the click, because they are one decision: a click
that changes a selection with nothing to show it, act on it or clear it is worse
than no click, which is why picking is off in a notebook by default. *Align* is
the one row that does not travel — it needs `align/align.js`, which cannot be
inlined, so the row hides itself.

**Showing side chains.** `focus` draws a neighbourhood's for you; to name them
yourself, ask.

```python
viewer = py2Dmol.view(sidechains=True)   # carries the atoms — see below
viewer.add_pdb('3PTB.cif')
viewer.show_sidechains(position=(40, 60))
viewer.hide_sidechains(position=45)      # ...all but that one
viewer.hide_sidechains()                 # off again
```

Both are relative — `show` adds to what is drawn and `hide` takes away, and with
nothing named either means every residue. `view(sidechains=True)` is what makes
it possible at all: side-chain atoms are coordinates, so they are a per-frame
cost (a 251-residue design goes from 9.0 KB a frame to 37.2) and they are not
sent unless you ask. Without them there is nothing to draw and the call says so.

**Fetching a chain.** The fetch box takes a chain suffix: `1timA`, `1TIM_A`,
`1tim_AB` (one chain per character) or `1tim:A,B` (commas for multi-character
chain IDs). Only four-character PDB IDs take a suffix, which keeps a UniProt
accession like `Q5VSL9` from being read as an ID plus chains.

## Layouts & multiple objects

### Compare trajectories
```python
viewer = py2Dmol.view()
viewer.add_pdb('simulation1.pdb', name="sim1")
viewer.add_pdb('simulation2.pdb', name="sim2")  # creates a new object
viewer.show()  # switch via dropdown
```

### Several objects at once
The dropdown shows one object at a time. To put two structures in the same
picture — the same thing the website's **Multi** button does — ask for it:

```python
viewer = py2Dmol.view(multi=True)      # every object, including later ones
viewer.add_pdb('apo.pdb',  name="apo")
viewer.add_pdb('holo.pdb', name="holo")
viewer.show()
```

or name a set after the fact:

```python
viewer.show_objects()                  # every object loaded
viewer.show_objects(["apo", "holo"])   # those two
viewer.show_objects("apo")             # back to one
```

The camera widens once to take in whatever is newly on screen. `multi=True` is
a standing instruction — an object added later joins the picture — and naming a
set replaces it. Note this is a different question from `overlay=True`, which
shows every **frame** of one object.

The picker is hidden while there is only one object to pick.

### Grid gallery
The grid carries `size`, `controls`, `box` and `bg` as defaults for every
viewer in it, and any `g.view(...)` can override them.

```python
with py2Dmol.grid(cols=2, size=(300, 300), bg="black") as g:
    g.view().from_pdb('1YNE')
    g.view().from_pdb('1BJP')
    g.view().from_pdb('9D2J')
    g.view().from_pdb('2BEG')
```

## Scatter plot
Visualize per-frame 2D data (RMSD vs energy, PCA, etc.) synced to the trajectory. Scatter highlights the current frame and is clickable to jump frames.

```python
# Trajectory with scatter points
viewer = py2Dmol.view(scatter=True, scatter_size=300)
viewer.add_pdb(
    "trajectory.pdb",
    scatter=trajectory_scatter_points,  # list/array of [x, y] per frame (or path to CSV with x,y; first row used as labels if present)
    scatter_config={"xlabel": "RMSD (Å)", "ylabel": "Energy (kcal/mol)", "xlim": [0, 10], "ylim": [-150, -90]},
)
viewer.show()
```

**CSV with trajectory**
```python
viewer = py2Dmol.view(scatter=True)
viewer.add_pdb('trajectory.pdb', scatter='data.csv')  # header used to set axis labels
viewer.show()
```

**Data sources**
- Array/list: per-frame `scatter=[x, y]` (list/tuple/dict) or a 2-column array with one row per frame.
- CSV file: two numeric columns; optional header row sets `xlabel`, `ylabel`. Example:
  ```
  RMSD,Energy
  1.2,-150.3
  1.4,-149.8
  1.6,-149.1
  ```

## Put a structure on your own web page

No Python, no build step — one script tag and one call:

```html
<div id="mol" style="width:400px;height:400px"></div>
<script src="https://py2dmol.solab.org/py2Dmol/resources/bundles/py2Dmol.embed.min.js"></script>
<script>
  fetch('https://files.rcsb.org/download/1UBQ.pdb')
      .then((r) => r.text())
      .then((text) => {
          const v = py2Dmol.show('mol', text);
          v.setStyle('cartoon');
      });
</script>
```

`show()` works out whether it was handed a PDB or an mmCIF by looking at it and
returns the viewer. Beyond `setStyle` and `setFrame` you get `setColor` (a mode,
or any colour on a chain, a list of positions or a range), `setContacts`
(lines between residues, weighted and coloured), `showObjects` (two structures
in one picture) and `select`. Pass `controls: true` for the same Style panel the
notebook has, and the frame strip appears by itself for a multi-model file.

Two bundles, differing only in the painter:

| file | size | |
| --- | --- | --- |
| `py2Dmol.embed.min.js` | 512 KB | WebGL2. Fast on large structures. |
| `py2Dmol.embed.cpu.min.js` | 467 KB | 2D canvas. No WebGL2 needed, and it can export SVG. |

Neither carries the control panel, the save UI or the side panels; for those,
load the full application. Neither falls back to the other — each has one
painter and nothing behind it.

**[Live demo and full API →](https://py2dmol.solab.org/embed.html)**

# Advanced

## Contact restraints
Contacts are colored lines between residues; width follows weight.

**File formats (`.cst`)**
- `idx1 idx2 weight [color]` (0-based)  
- `chain1 res1 chain2 res2 weight [color]`

**Data sources**
- Array/list: list/array of `[idx1, idx2, weight]` or `[idx1, idx2, weight, {r,g,b}]` (0-based indices).
- File: `.cst` text file, one contact per line (formats above).

**Add contacts**
```python
viewer = py2Dmol.view()
viewer.add_pdb('structure.pdb', contacts='contacts.cst')
viewer.show()
```

## Colors
Rendering uses a fixed 25% white mix to soften colors (DeepMind palette remains unlightened); there is no user-facing pastel/lightening setting.
Five-level priority: Global (`view(color=...)`) < Object < Frame < Chain < Position.

Semantic modes: `auto`, `chain`, `plddt`, `rainbow`, `entropy`, `deepmind`  
Literal: named, hex, or `{"r":255,"g":0,"b":0}`

**How to target colors**
- Position: `set_color("red", position=10)` or `position=(start, end)`
- Chain: `set_color("red", chain="A")`
- Frame: `add(..., color="rainbow")` on a single frame
- Object: `set_color({"type": "mode", "value": "plddt"}, name="obj1")`
- Global: `view(color="chain")`

```python
viewer = py2Dmol.view(color="plddt")
viewer.add_pdb("protein.pdb")
viewer.set_color("red", chain="A")
viewer.set_color("yellow", position=(0, 20))
viewer.set_color("red", chain="A", position=10, frame=0)
viewer.show()
```

An explicit colour always beats a mode. Setting one residue red keeps it red under
`plddt`, `chain`, `rainbow` or an SSE palette — the mode only decides the colour of
residues you have not spoken for.

## Secondary structure overrides
The automatic assignment is good but not infallible, and a figure sometimes wants a
region drawn a particular way regardless. `set_sse` forces it, and is the same override
the web interface's **SSE** control writes:

```python
viewer.set_sse("H", position=(20, 35))   # force 20-34 to helix
viewer.set_sse("E", chain="B")           # all of chain B as strand
viewer.set_sse(None, position=(20, 35))  # clear - back to automatic
```

`"H"` helix, `"E"` strand, `"C"` loop, `None` to clear. Stored on the object as
`sse`, beside `color`, and keyed by position index - so like a colour override it
belongs to that object's numbering.

## Selecting in the web interface
Drag across the sequence strip to select residues, or click a chain label to select the
whole chain; a yellow outline marks the selection in both the strip and the structure.
Clicking empty space clears it. Selecting never changes what is visible — showing and
hiding are separate, explicit actions.

The tools then act on that selection: **Colour** (the chain colour palette plus
white/grey/black, and *Auto* to drop back to the colour mode), **SSE**
(helix/sheet/loop/auto),
**Show** / **Hide**, and **Copy**, which extracts the selection into a new object.
`Select all` and `Unselect` are next to them. Everything here writes the same
structures `set_color` and `set_sse` write from Python, so a session set up either way
looks the same.

# Super Advanced

## custom `add()` payloads
Build mixed systems (protein/DNA/ligand) with explicit atom types.
```python
import numpy as np, py2Dmol
def helix(n, radius=2.3, rise=1.5, rotation=100):
    angles = np.radians(rotation) * np.arange(n)
    return np.column_stack([radius*np.cos(angles), radius*np.sin(angles), rise*np.arange(n)])

protein = helix(50); protein[:,0] += 15
dna = helix(30, radius=10, rise=3.4, rotation=36); dna[:,0] -= 15
angles = np.linspace(0, 2*np.pi, 6, endpoint=False)
ligand = np.column_stack([1.4*np.cos(angles), 1.4*np.sin(angles), np.full(6, 40)])

coords = np.vstack([protein, dna, ligand])
plddts = np.concatenate([np.full(50, 90), np.full(30, 85), np.full(6, 70)])
chains = ['A']*50 + ['B']*30 + ['L']*6
types = ['P']*50 + ['D']*30 + ['L']*6

viewer = py2Dmol.view((400,300), rotate=True)
viewer.add(coords, plddts, chains, types)
viewer.show()
```

## Live mode wiggle
```python
import numpy as np
viewer = py2Dmol.view(autoplay=True)
viewer.show()
angles = np.linspace(0, 2 * np.pi, 20, endpoint=False)
for frame in range(60):
    coords = np.column_stack([
        4 * np.sin(2 * angles + frame * 4 * np.pi/60),
        12 * np.cos(angles + frame * np.pi/60),
        12 * np.sin(angles + frame * np.pi/60)
    ])
    viewer.add(coords)
```

## Saving and loading
Save or restore full viewer state (structures, settings, MSA, contacts, frame/object selection).
```python
viewer = py2Dmol.view(size=(600, 600), shadow=True)
viewer.add_pdb('protein.pdb'); viewer.show()
viewer.save_state('my_visualization.json')

viewer2 = py2Dmol.view()
viewer2.load_state('my_visualization.json')
viewer2.show()
```



## Super Advanced

### `replace()`


```python
viewer = py2Dmol.view()
viewer.show()
viewer.add(coords1)  # Cell #1
viewer.add(coords2)  # Cell #2
viewer.replace(coords3)  # Updates Cell #2, replaces last frame
```

### `persistence`

Control output cell behavior with the `persistence` parameter:
- `viewer.view(persistence=True)`: Default - Building trajectories, want visible history
- `viewer.view(persistence=False)`: Animations, temporary viz, avoid notebook bloat

## Reference
**Atom codes**: Protein=P (CA), DNA=D (C4'), RNA=R (C4'), Ligand=L (heavy atoms)  
**Bond thresholds**: Protein CA-CA 5.0 Å; DNA/RNA C4'-C4' 7.5 Å; Ligand 2.0 Å  
**Color modes**: `auto`, `rainbow`, `plddt`, `chain`, `ss`, `entropy`, `deepmind`  
**Styles**: `tube` (default), `richardson`, `ribbon`, `3d`  
**SSE palettes**: `pymol` (default), `jmol`  
**Outline modes**: `none`, `partial`, `full` (default)  
**Formats**: PDB (.pdb), mmCIF (.cif); multi-model files load as frames.
