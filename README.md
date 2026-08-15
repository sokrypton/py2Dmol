# py2Dmol

A Python library for visualizing protein, DNA, and RNA structures in 2D, designed for Google Colab and Jupyter.

<img width="535" height="344" alt="image" src="https://github.com/user-attachments/assets/81fb0b9e-32a5-4fc7-ac28-921cf52f696e" />

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
Two styles are available (switchable live via the Style dropdown in the controls):
- **`tube`** (default) — the classic py2Dmol smooth backbone trace.
- **`cartoon`** — secondary-structure cartoon: twisted ribbons for helices, plates with arrowheads for strands, thin tubes for loops, with outlines.

The cartoon style carries named **presets** (the Preset dropdown, or `preset=` from Python) — starting points whose values load into the normal controls, which stay live for tweaking:
- **`ribbon`** (the default) — plain cartoon: smooth off, no slab thickness, ink on. The neutral starting point.
- **`richardson`** — the hand-drawn convention of Jane Richardson's protein drawings: flat wide helices, thick β-strands carrying arrowheads and white card edges, thin loops, and coloured-pencil paper grain. See below.
- **`3d`** — solid shaded geometry: thickness 1.0, no outline, smooth shading, flat sheets. Also switches the page to a black background, which is what that look is for; pass `bg=` explicitly to override.

Both cartoon styles work on C-alpha-only models, because the backbone is rebuilt from the trace: the local geometry is binned PULCHRA-style and the peptide C and N read out of a fitted table (C to 0.21 Å rms, N to 0.17 Å). Everything else follows from that backbone:

- **Secondary structure** is real DSSP — hydrogen-bond energies, turns and bridges — run on the rebuilt backbone. Measured against DSSP on the true backbones of 151 native chains: **Q3 90.0%** with **94.0% strand recall**, against 85.3% / 72.4% for the C-alpha-only assignment it replaces. Backbone dihedrals gate the assignment the way PyMOL's `dss` does, and ladders are extended by one rung where φ/ψ allows: strict DSSP boundaries score a higher Q3 (91.3%) but only 86.9% strand recall, and a strand drawn as a loop is the more visible error in a cartoon.
- **Which way a strand faces** comes from the sheet itself: the bridge partners give the ladders, and each strand residue's ribbon normal is fitted to a patch of the sheet spanning its own neighbourhood and its partners', then relaxed along the strand and across the rungs. The angle between the ribbon faces of two paired residues drops from 38.9° to 21.2° — which is the floor, since the sheets themselves twist 20.0° between paired residues.
- **Nucleic bases** work the same way from the C4′ trace: where a base points, and the plane it lies in, come from a fitted table (16.7° median, 99.9% coverage). This one has a real tail — a base can sit *anti* or *syn* on an identical backbone and the trace cannot tell which — so the base-pair test is widened, a base pointing away from its partner is flipped once pairing is known, and the ribbon's twist per residue is capped. Against files that do carry the geometry, B-DNA and tRNA pair identically; tertiary RNA differs on a handful of pairs.

Nothing per-residue is stored or shipped for either polymer — the trace is the input. See `tests/README.md`.

```python
py2Dmol.view(style='cartoon').from_pdb('4HHB', use_biounit=True)   # preset='richardson'
py2Dmol.view(preset='richardson').from_pdb('1TIM')
py2Dmol.view(style='cartoon', preset='3d').from_pdb('1TIM')        # solid, on black
py2Dmol.view(style='cartoon', thickness=0).from_pdb('4HHB')   # flat ribbons
```

#### Richardson preset

`preset='richardson'` is not a separate renderer — it is the cartoon draw path with a preset that changes the *profile* along the chain, so everything below is reachable from the plain cartoon too.

```python
py2Dmol.view(preset='richardson', color='ss').from_pdb('1TIM')
```

What the preset changes, and why:

| | Richardson | cartoon | rationale |
| --- | --- | --- | --- |
| helix thickness | ~0 (flat) | uniform | a helix is a paper streamer coiling in space; thickness fights the coil |
| strand thickness | full | uniform | the sheet has to read as a slab you could stack |
| loop section | square at the defaults | narrow | the loop reads as the same card seen end-on; width and thickness are separate controls, and the default width is calibrated so the section comes out square |
| sheet edges | white | element colour | the pale rim is what separates strands where they overlap |
| `sheet_flat` | `1.0` | `0.0` | real strands pleat; the drawings show them flat |
| `pencil` | `1.0` | `0.0` | paper grain |
| `outline_tint` | `0.8` | `0.0` | outlines are a dark tint of the element colour, not black |
| `highlight` | `3.0` | `1.8` | a stronger specular band |
| `width` | `2.0` | `3.0` | overall scale |
| `smooth` | on | off | Richardson shades smoothly; the grain supplies the texture |
| `shade` | `0.7` | `1.0` | pencil on paper models more lightly than a rendered solid |

A preset is a starting point, not a lock: the sliders stay live showing its values. Everything is also settable from Python, and an explicit argument always wins over the preset:

```python
py2Dmol.view(preset='richardson', pencil=0, sheet_flat=0)   # no grain, natural pleat
```

#### Shared cartoon options

`thickness` (Ångströms, default `0` for cartoon, `0.7` for Richardson) sets slab thickness; `thickness=0` draws flat single-sheet ribbons. On the `Thick:` slider.

`shade` (0–1, default `1.0`; `0.7` for Richardson) sets how much directional modelling is applied: `0` is flat colour, `1` is full light and inner shadow. `highlight` is a separate control and is **not** scaled by it, so `shade=0, highlight=2` gives flat colour with a specular band still on top. Paired with `Hilite:` in the panel, since the two split the lighting between them.

The `Outline:` slider is a width in **pixels**, and fractional values are real: it thins smoothly all the way down to a hairline before `0` turns the outline off. (It used to clamp, so the bottom half of the slider all drew alike and the outline appeared to snap off rather than fade.)

`detail` (integer 2–8, default `4`) sets subdivisions per residue, on the `Detail:` slider. It is an upper bound: the renderer never samples finer than the output can show (see *Subdivision follows the output* below), so at normal zoom the setting is what you get and cost is roughly linear in it, while a structure drawn small quietly uses less. Lower is deliberately faceted and proportionally faster; 6–8 give the smoothest curves for a still frame. 2 is the geometric floor — below it a helix cannot represent its own coil.

`arrows` (default `True`) draws an arrowhead on the C-terminal end of each β-strand, half a Cα–Cα step long, and squares off the N-terminal end. `arrows=False` lets strands flow continuously out of their loops at both ends.

`sheet_flat` (0–1) damps the β-pleat and smooths loops; `pencil` (0–1) adds coloured-pencil paper grain, applied to the structure only and never to the background.

Element edges are always lit directionally, so a thickness band reads as a rounded section rather than a flat facet. This used to be a `loop_round` slider, but its only useful setting was full — anything less just reintroduced the facets it exists to remove.

**Loops are drawn with their outer lines only.** Any slab seen at an angle shows three lines: the two silhouette edges, and the crease where its visible wide face meets its visible side face. On a helix or a strand that crease is worth drawing — it is what separates a wide face from a thin edge. On a loop, whose section is square, it runs a hair inside the silhouette and reads as a doubled line, so it is left to shading instead. This covers the stub joining a loop to a helix as well, which is drawn at loop width even though it takes the helix's colour.

`color='ss'` colours by secondary structure. The palette is picked by `ss_palette` / the SSE dropdown: `pymol` (default: red helices, yellow strands, green loops), `jmol`, or the Jane Richardson schemes `jr1` (blue/green) and `jr2` (the 1981 hand-coloured drawings). It works with any style.

**Subdivision follows the output.** Curves are subdivided only as finely as the output can
show - about one station every 3 pixels - so a small domain at normal zoom draws at the full
Detail setting while a large complex, whose residues are a few pixels each, quietly draws fewer.
It applies to exports too, at *their* resolution rather than the screen's. There is no
"maximum detail" export option because there is nothing for it to buy.

**Thickness fades out as you zoom out.** A ribbon edge is only readable while it is a few pixels
wide; below that it stops reading as depth and becomes a grey fringe along every ribbon. So
thickness is scaled by how big the band would be *on screen* and reaches exactly zero — flat
ribbons — once it would fall under a pixel. Large complexes are therefore flat at default zoom,
which is where their edges were illegible anyway. This is for legibility, not speed: a flat
ribbon actually issues slightly *more* canvas operations than the slab, because the slab path
merges faces the flat path emits separately.

**Image export** (the camera button) reproduces all of this, including the pencil grain (as an
`feTurbulence` filter) and gradient shading. Pick SVG, compressed SVG, or PNG; PNG takes a DPI,
where 300 dpi on a 600px view gives 1875x1875. A PNG is rendered *at* that size rather than
scaled up afterwards, so a higher DPI buys genuinely finer curves, not just more pixels — while
the settings that are in **pixels** rather than Ångströms (outline width, selection ink, the
zoom test behind the thickness fade) are scaled to keep the proportions you see on screen. A
300 dpi export is the view you were looking at, drawn larger and more finely; it is not a
different picture with hairline outlines. Exports go out on a **transparent** background
whatever the viewer is set to, so a figure drops into a document without a baked-in white or
black rectangle behind it.

**Moving the view.** Drag to rotate, scroll to zoom, and **middle-drag or Cmd/Ctrl-drag to pan**,
as in PyMOL. A pan moves the rotation centre rather than the picture, so dragging the structure
to the left leaves the centre off to its right - rotation, zoom and ortho all keep working about
that point, which is what makes panning useful for studying one end of a long molecule.

**Recording a rotation.** With auto-rotate on, the camera button becomes **Save Video** and
records one full turn as a webm that loops seamlessly: the frames cover 0-360 degrees and stop
one step short of 360, so wrapping back to the first frame continues the same angular step
instead of repeating a frame.

**Fetching a chain.** The fetch box takes a chain suffix as well as a plain ID: `1timA`,
`1TIM_A`, `1tim_AB` (one chain per character) or `1tim:A,B` (commas for multi-character chain
IDs). Only four-character PDB IDs take a suffix — they start with a digit, which is what keeps a
UniProt accession like `Q5VSL9` from being read as an ID plus chains.

## Layouts & multiple objects

### Compare trajectories
```python
viewer = py2Dmol.view()
viewer.add_pdb('simulation1.pdb', name="sim1")
viewer.add_pdb('simulation2.pdb', name="sim2")  # creates a new object
viewer.show()  # switch via dropdown
```

### Grid gallery
```python
with py2Dmol.grid(cols=2, size=(300, 300)) as g:
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
**Styles**: `tube`, `cartoon`, `richardson`  
**Cartoon presets**: `richardson` (default), `ribbon`, `3d`  
**SSE palettes**: `pymol` (default), `jmol`, `jr1`, `jr2`  
**Outline modes**: `none`, `partial`, `full` (default)  
**Formats**: PDB (.pdb), mmCIF (.cif); multi-model files load as frames.
