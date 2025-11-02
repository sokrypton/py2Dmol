# py2Dmol

A Python library for visualizing protein, DNA, and RNA structures in 2D, designed for use in Google Colab and Jupyter environments.

<img width="462" height="349" alt="image" src="https://github.com/user-attachments/assets/3b52d584-1d7e-45cc-a620-77377f0a0c01" />

## Installation
```bash
pip install py2Dmol
```

## Basic Usage

### Example: Loading a PDB File

This will load the PDB, including all its models as frames, and display it.

```python
import py2Dmol

# 1. Create a viewer object
viewer = py2Dmol.view(size=(600, 600))

# 2. Add pdb
viewer.add_pdb('my_protein.pdb', chains=['A', 'B'])

# 3. Show the final, static viewer
viewer.show()

```

### Example: Comparing Multiple Trajectories

You can add multiple PDB files as separate, switchable trajectories.

```python
import py2Dmol

viewer = py2Dmol.view()
# Load first trajectory
viewer.add_pdb('simulation1.pdb')

# Start a new trajectory
viewer.add_pdb('simulation2.pdb', new_obj=True)

# Use the dropdown to switch between "0" and "1"
viewer.show()
```

### Example: Customizing the View

You can pass several options to the `view` constructor.

```python
import py2Dmol

viewer = py2Dmol.view(
    size=(300, 300),     # Set canvas size (width, height)
    color='auto',        # Set initial color mode: ["auto","rainbow","chain","plddt"]
    pastel=0.25,         # Lighten the colors
    colorblind=False,    # Use colorbind friendly colors
    shadow=True,         # Enable shadows by default
    outline=True,        # Enable outlines by default
    width=3.0,           # Set initial line width
    rotate=False,        # Enable auto-rotation
    autoplay=False,      # Enable auto-play (if trajectory or multiple models)
    hide_box=False,      # hide box around molecule
    hide_controls=False, # hide all controls
    show_pae=False,      # enable pae
    pae_size=False,      # set pae canvas size (width, height)
)

viewer.add_pdb("my_complex.cif")
viewer.show()
```


---

## Helper functions

### Example: Load structure from PDB w/ ensemble
```python
import py2Dmol
py2Dmol.view().from_pdb('1YNE')
```

### Example: Load biounit from PDB
```python
import py2Dmol
py2Dmol.view().from_pdb('1BJP', use_biounit=True, ignore_ligands=True)
```

### Example: Load structure from PDB w/ multiple chains + DNA
```python
import py2Dmol
py2Dmol.view().from_pdb('9D2J')
```

### Example: Load structure from AlphaFold DB, show pAE
```python
import py2Dmol
py2Dmol.view(show_pae=True).from_afdb('Q5VSL9')
```

---

## Advanced: Static vs. Live Mode

`py2Dmol` has two modes, determined by *when* you call `viewer.show()`.

### Mode 1: Static Mode

You call `add()` or `add_pdb()` first to load all your data, and then call `show()` at the end.

* **Workflow:** `viewer.add*()` ➔ `viewer.show()`
* **Result:** Creates a single, 100% persistent viewer that contains all your data. This is ideal for saving, sharing, and reloading notebooks.

### Mode 2: Live (Dynamic) Mode

This mode is for live, dynamic updates (e.g., in a loop). You call `show()` *before* you add any data.

* **Workflow:** `viewer.show()` ➔ `viewer.add*()`
* **Result:** `show()` creates an empty, live viewer. Subsequent `add()` calls send data to it one by one.
* **Warning:** This mode is **not persistent**. The viewer will be blank when you close and reopen the notebook, as the data is not saved.

#### Live Mode Example (Wiggle Animation)

This example only works when run in a notebook. It will dynamically add frames to the viewer one at a time.

```python
import py2Dmol
import numpy as np
import time

# Define the wiggle function
def circle_morph(n=20, wave=0):
    """n points, constant ~3.8Å bonds, wavy deformation."""
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

# 1. Create the viewer object
viewer = py2Dmol.view()

# 2. Show the viewer *before* adding data to enter "Live Mode"
viewer.show()

# 3. Now, add frames in a loop
for frame in range(60):
    w = np.sin(frame * np.pi / 15)
    coords = circle_morph(20, w)
    plddts = np.full((20,), 80.0)
    chains = ['A'] * 20
    atom_types = ['P'] * 20
    
    # Send the new frame to the live viewer
    viewer.add(coords, plddts, chains, atom_types, 
               new_traj=(frame == 0)) # Start a new traj on frame 0
    
    # Wait a bit so you can see the animation
    time.sleep(0.1)
```

---

### Example: Mixed Structure (Protein, DNA, Ligand)

You can manually add coordinates for different molecule types (P, D, R, L).

```python
import py2Dmol
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

# Show the final static viewer
viewer.show()
```
---

## Reference

### Atom Types and Representative Atoms

| Molecule Type | Atom Type Code | Representative Atom | Purpose |
|---------------|----------------|---------------------|---------|
| Protein | P | CA (C-alpha) | Backbone trace |
| DNA | D | C4' (sugar carbon) | Backbone trace |
| RNA | R | C4' (sugar carbon) | Backbone trace |
| Ligand | L | All heavy atoms | Full structure |

### Distance Thresholds

The viewer uses different distance thresholds for creating bonds:

- Protein (CA-CA): 5.0 Å
- DNA/RNA (C4'-C4'): 7.5 Å
- Ligand bonds: 2.0 Å

### Color Modes

The viewer supports multiple coloring schemes:

- **auto** (default): Automatically chooses 'chain' if multiple chains are present, otherwise 'rainbow'.
- **rainbow**: Colors atoms sequentially from N-terminus to C-terminus (or 5' to 3' for nucleic acids)
- **plddt**: Colors based on B-factor/pLDDT scores (useful for AlphaFold predictions)
- **chain**: Each chain receives a distinct color

### Supported File Formats

- PDB (.pdb)
- mmCIF (.cif)

Both formats support multi-model files, which are loaded as frames in a single trajectory.
