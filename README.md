# py2Dmol

A Python library for visualizing protein, DNA, and RNA structures in 2D, designed for use in Google Colab and Jupyter environments.

<img width="462" height="349" alt="image" src="https://github.com/user-attachments/assets/3b52d584-1d7e-45cc-a620-77377f0a0c01" />


## Installation
```bash
pip install py2Dmol
```

## Usage

Here are a few examples of how to use py2Dmol.

### Initializing the Viewer

You can initialize the viewer with several options:
```python
import py2Dmol

# Default viewer
viewer = py2Dmol.view()

# Customized viewer
viewer = py2Dmol.view(
    size=(600, 600),   # Set canvas size (width, height)
    color='chain',     # Set initial color mode
    shadow=True,       # Enable shadows by default
    outline=True,      # Enable outlines by default
    width=3.0,         # Set initial line width
    rotate=False       # Disable auto-rotation by default
)
```

### Loading a Structure from a PDB or CIF File

You can load a structure directly from a PDB or CIF file using the `from_pdb` method. This will automatically extract:

- C-alpha atoms for proteins
- C4' atoms for DNA and RNA
- All heavy atoms for ligands

If the file contains multiple models, they will be loaded as an animation.
```python
import py2Dmol
viewer = py2Dmol.view()
viewer.add_pdb('my_protein.pdb')
```

You can also specify which chains to display:
```python
viewer.add_pdb('my_protein.pdb', chains=['A', 'B'])
```

### Manually Adding Data

You can also add data to the viewer using the `add` method. This is useful for visualizing custom trajectories or molecular data.
```python
import numpy as np

def circle_morph(n=20, wave=0):
    """n points, constant ~3.8Å bonds, wavy deformation."""
    # Target bond length
    bond = 3.8
    perimeter = n * bond
    radius = perimeter / (2 * np.pi)
    
    angles = np.linspace(0, 2*np.pi, n, endpoint=False)
    r = radius * (1 + wave * 0.2 * np.sin(4 * angles))
    
    return np.column_stack([
        r * np.cos(angles),
        r * np.sin(angles),
        wave * 3 * np.cos(angles)
    ])

# Animate
viewer = py2Dmol.view()
for frame in range(30):
    w = np.sin(frame * np.pi / 15)
    viewer.add(circle_morph(20, w), np.full((20,),80.0), ['A']*20, ['P']*20)
```

### Mixed Structure Example

You can create custom visualizations with multiple molecule types:
```python
import numpy as np

def helix(n, radius=2.3, rise=1.5, rotation=100):
    """Generate helical coordinates."""
    angles = np.radians(rotation) * np.arange(n)
    return np.column_stack([
        radius * np.cos(angles),
        radius * np.sin(angles),
        rise * np.arange(n)
    ])

# Protein helix (50 residues)
protein = helix(50)
protein[:, 0] += 15  # offset x

# DNA strand (30 bases)
dna = helix(30, radius=10, rise=3.4, rotation=36)
dna[:, 0] -= 15  # offset x

# Ligand ring (6 atoms)
angles = np.linspace(0, 2*np.pi, 6, endpoint=False)
ligand = np.column_stack([
    1.4 * np.cos(angles),
    1.4 * np.sin(angles),
    np.full(6, 40)
])

# Combine everything (86 atoms total)
coords = np.vstack([protein, dna, ligand])
plddts = np.concatenate([np.full(50, 90), np.full(30, 85), np.full(6, 70)])
chains = ['A']*50 + ['B']*30 + ['L']*6
types = ['P']*50 + ['D']*30 + ['L']*6

viewer = py2Dmol.view(color='chain', size=(600, 600), width=2.5, outline=False)
viewer.add(coords, plddts, chains, types)
```

## Atom Types and Representative Atoms

| Molecule Type | Atom Type Code | Representative Atom | Purpose |
|---------------|----------------|---------------------|---------|
| Protein | P | CA (C-alpha) | Backbone trace |
| DNA | D | C4' (sugar carbon) | Backbone trace |
| RNA | R | C4' (sugar carbon) | Backbone trace |
| Ligand | L | All heavy atoms | Full structure |

## Distance Thresholds

The viewer uses different distance thresholds for creating bonds:

- Protein (CA-CA): 5.0 Å
- DNA/RNA (C4'-C4'): 7.5 Å
- Ligand bonds: 2.0 Å

These thresholds are optimized for their respective molecular structures and ensure proper connectivity visualization.

## Chains

Chains are automatically extracted from the PDB or CIF file. When loading a structure, you can choose to display all chains or specify a subset of chains to visualize.

## Color Modes

The viewer supports multiple coloring schemes:

- **auto** (default): Automatically chooses 'chain' if multiple chains are present, otherwise 'rainbow'.
- **rainbow**: Colors atoms sequentially from N-terminus to C-terminus (or 5' to 3' for nucleic acids)
- **plddt**: Colors based on B-factor/pLDDT scores (useful for AlphaFold predictions)
- **chain**: Each chain receives a distinct color
```python
# Use pLDDT coloring
viewer = py2Dmol.view(color='plddt')
viewer.add_pdb('alphafold_prediction.pdb')

# Use chain coloring
viewer = py2Dmol.view(color='chain')
viewer.add_pdb('multi_chain_complex.pdb')
```

## Features

- Interactive 3D-style visualization with rotation and zoom
- Animation support for trajectories and multiple models
- Automatic structure detection for proteins, DNA, and RNA
- Multiple color schemes (auto, rainbow, pLDDT, chain)
- Ligand visualization with automatic bond detection
- Toggleable effects for depth perception (shadow, outline)
- Adjustable line width
- Real-time auto-rotation (toggleable)
- Trajectory management for comparing multiple simulations

## Supported File Formats

- PDB (.pdb)
- mmCIF (.cif)

Both formats support multi-model files for animation playback.

## Examples

### Comparing Multiple Trajectories
```python
# Load first trajectory
viewer = py2Dmol.view()
viewer.add_pdb('simulation1.pdb')

# Start a new trajectory
viewer.add_pdb('simulation2.pdb', new_traj=True)

# Use the dropdown to switch between trajectories
```

## Requirements

- Python 3.6+
- NumPy
- gemmi (for PDB/CIF parsing)
- IPython (for display in notebooks)
