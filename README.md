# py2Dmol

A Python library for visualizing protein structures in 2D, designed for use in Google Colab and Jupyter environments.

<img width="404" height="349" alt="image" src="https://github.com/user-attachments/assets/874213b7-67d0-4fc9-93ae-ea50160d1f8c" />


## Installation

You can install `py2Dmol` directly from GitHub:

```bash
pip install git+https://github.com/sokrypton/py2Dmol.git
```

## Usage

Here are a few examples of how to use `py2Dmol`.

### Basic Usage

To create a viewer, simply import the package and instantiate the `view` class:

```python
import py2Dmol
viewer = py2Dmol.view()
```

### Loading a Structure from a PDB or CIF File

You can load a structure directly from a PDB or CIF file using the `from_pdb` method. This will automatically extract the C-alpha atoms for proteins and all heavy atoms for ligands. If the file contains multiple models, they will be loaded as an animation.

```python
import py2Dmol
viewer = py2Dmol.view()
viewer.from_pdb('my_protein.pdb')
```

You can also specify which chains to display:

```python
viewer.from_pdb('my_protein.pdb', chains=['A', 'B'])
```

### Manually Adding Data

You can also add data to the viewer using the `add` method. This is useful for visualizing custom trajectories or molecular data.

```python
import numpy as np

# Example data
coords = np.random.rand(100, 3) * 50  # 100 atoms with random coordinates
plddts = np.random.rand(100) * 100    # Random pLDDT scores
chains = ['A'] * 50 + ['B'] * 50      # Two chains
atom_types = ['P'] * 100              # All protein atoms

# Create a viewer and display the initial data
viewer = py2Dmol.view()
viewer.display(coords, plddts, chains, atom_types)

# Update the viewer with new data to create an animation
for _ in range(10):
    new_coords = coords + np.random.rand(100, 3) * 5
    viewer.add(new_coords)
```

## Data Format

The viewer distinguishes between two types of atoms:

*   **P (Protein):** Represents the C-alpha atom of a protein residue.
*   **L (Ligand):** Represents a heavy atom of a non-protein, non-water molecule.

### Chains

Chains are automatically extracted from the PDB or CIF file. When loading a structure, you can choose to display all chains or specify a subset of chains to visualize.
