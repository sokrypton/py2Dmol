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

def generate_alpha_helix_on_superhelix(n_residues=50, super_radius=0, super_turns=0):
    """
    Generate alpha helix wrapped around a cylinder (superhelix).
    
    Parameters:
    - n_residues: number of residues
    - super_radius: radius of the superhelix (0 = straight helix)
    - super_turns: number of superhelical turns
    """
    coords = []
    helix_radius = 2.3  # Å from helix axis to CA
    rise_per_residue = 1.5  # Å along helix axis
    rotation_per_residue = 100 * np.pi / 180  # 100 degrees
    
    helix_length = (n_residues - 1) * rise_per_residue
    
    for i in range(n_residues):
        # Alpha helix coordinates
        helix_angle = i * rotation_per_residue
        local_x = helix_radius * np.cos(helix_angle)
        local_y = helix_radius * np.sin(helix_angle)
        z = i * rise_per_residue
        
        if super_radius == 0:
            # Straight helix
            x, y = local_x, local_y
        else:
            # Wrap around superhelix
            super_angle = (z / helix_length) * 2 * np.pi * super_turns
            
            # Transform: local helix coordinates → superhelix
            x = (super_radius + local_x) * np.cos(super_angle) - local_y * np.sin(super_angle)
            y = (super_radius + local_x) * np.sin(super_angle) + local_y * np.cos(super_angle)
        
        coords.append([x, y, z])
    
    return np.array(coords)

# Create initial straight helix
coords = generate_alpha_helix_on_superhelix(100, super_radius=0, super_turns=0)
plddts = np.linspace(50, 95, 100)
chains = ['A'] * 100
atom_types = ['P'] * 100

# Display
viewer = py2Dmol.view()

# Animate: gradually add superhelical twist
# Wrapping around a larger cylinder with increasing turns
for frame in range(1, 21):
    super_radius = 10.0  # Radius of the "pole"
    super_turns = frame * 0.075  # Gradually increase from 0 to 1.5 turns
    twisted_coords = generate_alpha_helix_on_superhelix(
        100, super_radius=super_radius, super_turns=super_turns
    )
    viewer.add(twisted_coords, plddts, chains, atom_types)
```

### Mixed Structure Example

You can create custom visualizations with multiple molecule types:
```python
import numpy as np

def generate_alpha_helix(n_residues, offset=np.array([0, 0, 0])):
    """Generate ideal alpha helix (CA-CA ~3.8 Å)."""
    coords = []
    radius = 2.3
    rise_per_residue = 1.5
    rotation_per_residue = 100 * np.pi / 180
    
    for i in range(n_residues):
        angle = i * rotation_per_residue
        x = radius * np.cos(angle) + offset[0]
        y = radius * np.sin(angle) + offset[1]
        z = i * rise_per_residue + offset[2]
        coords.append([x, y, z])
    return np.array(coords)

def generate_dna_strand(n_bases, offset=np.array([0, 0, 0])):
    """Generate B-DNA backbone (C4'-C4' ~7.0 Å)."""
    coords = []
    radius = 10.0  # Distance from helix axis to C4'
    rise_per_base = 3.4  # B-DNA rise
    rotation_per_base = 36 * np.pi / 180  # 10 bases per turn
    
    for i in range(n_bases):
        angle = i * rotation_per_base
        x = radius * np.cos(angle) + offset[0]
        y = radius * np.sin(angle) + offset[1]
        z = i * rise_per_base + offset[2]
        coords.append([x, y, z])
    return np.array(coords)

def generate_benzene_ring(center):
    """Generate benzene-like small molecule (C-C 1.4 Å)."""
    coords = []
    bond_length = 1.4
    for i in range(6):
        angle = i * np.pi / 3  # 60 degrees between carbons
        x = center[0] + bond_length * np.cos(angle)
        y = center[1] + bond_length * np.sin(angle)
        z = center[2]
        coords.append([x, y, z])
    return np.array(coords)

# Create protein helix
protein_coords = generate_alpha_helix(50, offset=np.array([15, 0, 0]))
protein_plddts = np.full(50, 90.0)
protein_chains = ['A'] * 50
protein_types = ['P'] * 50

# Create DNA strand
dna_coords = generate_dna_strand(30, offset=np.array([-15, 0, 0]))
dna_plddts = np.full(30, 85.0)
dna_chains = ['B'] * 30
dna_types = ['D'] * 30

# Add a small molecule ligand
ligand_coords = generate_benzene_ring(center=np.array([0, 0, 40]))
ligand_plddts = np.full(6, 70.0)
ligand_chains = ['L'] * 6
ligand_types = ['L'] * 6

# Combine all components
all_coords = np.vstack([protein_coords, dna_coords, ligand_coords])
all_plddts = np.concatenate([protein_plddts, ligand_plddts, ligand_plddts])
all_chains = protein_chains + dna_chains + ligand_chains
all_types = protein_types + dna_types + ligand_types

viewer = py2Dmol.view(
    color='chain', 
    size=(600, 600), 
    width=2.5, 
    outline=False
)
viewer.add(all_coords, all_plddts, all_chains, all_types)
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
