# py2Dmol

A Python library for visualizing protein, DNA, and RNA structures in 2D, designed for Google Colab and Jupyter.

<img width="535" height="344" alt="image" src="https://github.com/user-attachments/assets/81fb0b9e-32a5-4fc7-ac28-921cf52f696e" />

Bonus: [online interactive version](http://py2dmol.solab.org/)  
<a href="https://colab.research.google.com/github/sokrypton/py2Dmol/blob/main/py2Dmol_demo.ipynb" target="_parent"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"/></a>

## Installation
```bash
pip install py2Dmol
# latest experimental
pip install git+https://github.com/sokrypton/py2Dmol.git
```

## Quickstart: core workflow
`py2Dmol` has two modes—decided by when you call `show()`:
- **Static**: `add*()` then `show()` → one self-contained viewer.
- **Live**: `show()` then `add*()` → stream frames/points as you go.

### Load a PDB (static)
```python
import py2Dmol
viewer = py2Dmol.view(size=(600, 600))
viewer.add_pdb('my_protein.pdb', chains=['A', 'B'])
viewer.show()
```

### Live mode wiggle
```python
import numpy as np, time, py2Dmol
viewer = py2Dmol.view(); viewer.show()
for frame in range(60):
    angles = np.linspace(0, 2*np.pi, 20, endpoint=False)
    coords = np.column_stack([np.cos(angles)*15, np.sin(angles)*15, np.sin(frame/5)*3*np.cos(angles)])
    viewer.add(coords, np.full(20, 80), ['A']*20, ['P']*20)
    time.sleep(0.05)
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
    shadow=True, outline='full', width=3.0, ortho=1.0,
    rotate=False, autoplay=False, box=True, controls=True,
    pae=False, pae_size=300, scatter=False, scatter_size=300,
)
viewer.add_pdb("my_complex.cif")
viewer.show()
```

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

## Scatter plot visualization (advanced)
Visualize per-frame 2D data (RMSD vs energy, PCA, etc.) synced to the trajectory. Scatter highlights the current frame and is clickable to jump frames.

**Enable/configure**
```python
viewer = py2Dmol.view(scatter=True, scatter_size=300)  # scatter_size is global; labels/limits are per-object
# Set per-object labels/limits when adding data
viewer.add_pdb("trajectory.pdb", scatter_config={"xlabel": "RMSD (Å)", "ylabel": "Energy (kcal/mol)", "xlim": [0, 10], "ylim": [-150, -90]})
```
Per-object settings (labels/limits) live in the object’s scatterConfig; only `scatter_size` is global.
Supported formats: per-frame list/tuple/dict, CSV with header, or list/NumPy array via `add_pdb()` or `add()`.

**Live per-frame**
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
viewer.add_pdb('trajectory.pdb', scatter='data.csv')  # header supplies labels if present
viewer.show()
```

**Batch add**
```python
# coords: (batch, N, 3), scatter: (batch, 2) or list of pairs
viewer.add(batch_coords, scatter=batch_scatter)
```

### Scatter highlights
- Frame sync, click-to-jump, playback highlight, past/current/future color layers.
- Missing scatter for a frame inherits previous frame’s value.

## Contact restraints (advanced)
Contacts are colored lines between residues; width follows weight.

**File formats (`.cst`)**
- `idx1 idx2 weight [color]` (0-based)  
- `chain1 res1 chain2 res2 weight [color]`

**Add contacts**
```python
viewer = py2Dmol.view()
viewer.add_pdb('structure.pdb')
viewer.add_contacts('contacts.cst')            # last object
viewer.add_contacts('contacts.cst', name="a")  # specific object
viewer.add(coords, plddts, chains, types, contacts='contacts.cst')
```

## Colors (advanced)
Rendering uses a fixed 25% white mix to soften colors (DeepMind palette remains unlightened); there is no user-facing pastel/lightening setting.
Five-level priority: Global (`view(color=...)`) < Object < Frame < Chain < Position.

Semantic modes: `auto`, `chain`, `plddt`, `rainbow`, `entropy`, `deepmind`  
Literal: named, hex, or `{"r":255,"g":0,"b":0}`

```python
viewer = py2Dmol.view(color="plddt")
viewer.add_pdb("protein.pdb")
viewer.set_color("red", chain="A")
viewer.set_color("yellow", position=(0, 20))
viewer.set_color("red", chain="A", position=10, frame=0)
viewer.show()
```

## Super-advanced: custom `add()` payloads
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

## Reference
**Atom codes**: Protein=P (CA), DNA=D (C4'), RNA=R (C4'), Ligand=L (heavy atoms)  
**Bond thresholds**: Protein CA-CA 5.0 Å; DNA/RNA C4'-C4' 7.5 Å; Ligand 2.0 Å  
**Color modes**: `auto`, `rainbow`, `plddt`, `chain`  
**Outline modes**: `none`, `partial`, `full` (default)  
**Formats**: PDB (.pdb), mmCIF (.cif); multi-model files load as frames.
