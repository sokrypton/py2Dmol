# py2Dmol

A Python library for visualizing protein, DNA, and RNA structures in 2D, designed for use in Google Colab and Jupyter environments.

<img width="462" height="349" alt="image" src="https://github.com/user-attachments/assets/3b52d584-1d7e-45cc-a620-77377f0a0c01" />

Bonus: [online interactive version](http://py2dmol.solab.org/)


## Installation
```bash
pip install py2Dmol
```
### For latest experimental build
```bash
pip install git+https://github.com/sokrypton/py2Dmol.git
```

## Basic Usage
<a href="https://colab.research.google.com/github/sokrypton/py2Dmol/blob/main/py2Dmol_demo.ipynb" target="_parent"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"/></a>

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
    size=(300, 300),     # canvas size (width, height)
    color='auto',        # color mode: ["auto","rainbow","chain","plddt"]
    pastel=0.25,         # lighten the colors
    colorblind=False,    # use colorbind friendly colors
    shadow=True,         # show shadow
    outline='full',      # outline mode: ["none","partial","full"]
    width=3.0,           # line width
    ortho=1.0,          # orthographic projection (0.0=perspective, 1.0=orthographic)
    rotate=False,        # auto-rotation
    autoplay=False,      # auto-play (if trajectory or multiple models)
    box=True,           # show box around molecule
    controls=True,      # show controls
    pae=False,          # show pae
    pae_size=300,       # set pae canvas size (single integer for square canvas)
)

viewer.add_pdb("my_complex.cif")
viewer.show()
```


---

## Helper functions

### Example: Load structure from PDB w/ ensemble
```python
import py2Dmol
py2Dmol.view(autoplay=True).from_pdb('1YNE')
```

### Example: Load biounit from PDB
```python
import py2Dmol
py2Dmol.view(rotate=True).from_pdb('1BJP', use_biounit=True, ignore_ligands=True)
```

### Example: Load structure from PDB w/ multiple chains + DNA
```python
import py2Dmol
py2Dmol.view().from_pdb('9D2J')
```

### Example: Load structure from AlphaFold DB, show pAE
```python
import py2Dmol
py2Dmol.view(pae=True).from_afdb('Q5VSL9')
```

---

## Advanced: Static vs. Live Mode

`py2Dmol` has two modes, determined by *when* you call `viewer.show()`.

### Mode 1: Static Mode

You call `add()` or `add_pdb()` first to load all your data, and then call `show()` at the end.

* **Workflow:** `viewer.add*()` ➔ `viewer.show()`
* **Result:** Creates a single, 100% persistent viewer that contains all your data.

### Mode 2: Live (Dynamic) Mode

This mode is for live, dynamic updates (e.g., in a loop). You call `show()` *before* you add any data.

* **Workflow:** `viewer.show()` ➔ `viewer.add*()`
* **Result:** `show()` creates an empty, live viewer. Subsequent `add()` calls send data to it one by one.

#### Live Mode Example (Wiggle Animation)

This example only works when run in a notebook. It will dynamically add frames to the viewer one at a time.

```python
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
    viewer.add(coords, plddts, chains, atom_types)

    # Wait a bit
    time.sleep(0.1)
```

---

## Contact Restraints

You can visualize contact restraints (e.g., from experimental data or predictions) as colored lines connecting specific residues in your structure.

### Contact File Format (`.cst`)

Contact files support two formats:

1. **Position indices** (zero-based): `idx1 idx2 weight [color]`
2. **Chain + residue**: `chain1 res1 chain2 res2 weight [color]`

Lines starting with `#` are treated as comments and ignored.

**Examples:**
```
# Contact file example
10 50 1.0
20 60 0.5 red
A 10 B 50 1.0 yellow
A 20 B 60 0.8 #3b82f6
```

- **Weight**: Required float value (defaults to 1.0). Controls the line width of the contact.
- **Color**: Optional. Can be:
  - Color name: `red`, `yellow`, `blue`, etc.
  - Hex code: `#3b82f6`, `#ff0000`
  - RGB: `rgb(255, 0, 0)`
  - Default: Yellow if not specified

### Adding Contacts

#### Method 1: Using `add_contacts()`

Add contacts to the most recently added object:

```python
viewer = py2Dmol.view()
viewer.add_pdb('structure.pdb')
viewer.add_contacts('contacts.cst')  # Adds to last object
viewer.show()
```

Add contacts to a specific named object:

```python
viewer.new_obj("protein1")
viewer.add_pdb('protein1.pdb')
viewer.new_obj("protein2")
viewer.add_pdb('protein2.pdb')
viewer.add_contacts('contacts.cst', name="protein1")  # Adds to protein1
viewer.show()
```

Add contacts programmatically:

```python
contacts = [
    [10, 50, 1.0],  # Position indices: idx1, idx2, weight
    ["A", 10, "B", 50, 0.5, {"r": 255, "g": 0, "b": 0}]  # Chain format with color
]
viewer.add_contacts(contacts)
viewer.show()
```

#### Method 2: Using `contacts` Parameter

Add contacts when loading a structure:

```python
viewer = py2Dmol.view()
viewer.add_pdb('structure.pdb', contacts='contacts.cst')
viewer.show()
```

Add contacts when adding coordinates:

```python
viewer = py2Dmol.view()
viewer.add(coords, plddts, chains, types, contacts='contacts.cst')
viewer.show()
```

### Example: Visualizing Predicted Contacts

```python
import py2Dmol

viewer = py2Dmol.view()
viewer.add_pdb('predicted_structure.pdb', contacts='predicted_contacts.cst')
viewer.show()
```

Contacts will appear as colored lines connecting the specified residues, with line width proportional to the weight value.

---

### Example: Mixed Structure (Protein, DNA, Ligand)

You can manually add coordinates for different molecule types (P, D, R, L).

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

viewer = py2Dmol.view((400,300),rotate=True)
viewer.add(coords, plddts, chains, types)
viewer.show()
```
---

## Saving and Loading Viewer State

You can save the entire viewer state (including all loaded structures, configurations, and viewer settings) to a JSON file and restore it later. This is useful for:
- Sharing exact visualizations with collaborators
- Saving work for later analysis
- Creating reproducible figures

### Saving State

Save the current viewer state to a JSON file:

```python
import py2Dmol

# Create and configure viewer
viewer = py2Dmol.view(size=(600, 600), shadow=True, depth=True)
viewer.add_pdb('protein.pdb')
viewer.show()

# Save the complete state
viewer.save_state('my_visualization.json')
```

The state file includes:
- All loaded structures and their coordinates
- Current viewer settings (color mode, line width, shadows, etc.)
- MSA data (if loaded)
- Contact restraints (if added)
- Current frame and object selection

### Loading State

Restore a saved state into a new viewer:

```python
import py2Dmol

# Create new viewer and load saved state
viewer = py2Dmol.view()
viewer.load_state('my_visualization.json')

# Display the restored viewer
viewer.show()
```

**Note:** After calling `load_state()`, you must call `show()` to display the viewer.

### Complete Save/Load Example

```python
import py2Dmol

# Session 1: Create and save
viewer_old = py2Dmol.view(size=(600, 600))
viewer_old.add_pdb('protein.pdb')
viewer_old.show()
viewer_old.save_state('tmp.json')

# Session 2: Load and continue
viewer = py2Dmol.view()
viewer.load_state('tmp.json')
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

### Outline Modes

The viewer supports three outline rendering modes:

- **none**: No outline is drawn around segments
- **partial**: Outline is drawn with butt caps only (no rounded caps at outer endpoints)
- **full** (default): Outline is drawn with rounded caps at outer endpoints for a complete cartoon appearance

The outline mode can be set via the `outline` parameter in the `view()` constructor, or toggled using the outline button in the control panel.

### Supported File Formats

- PDB (.pdb)
- mmCIF (.cif)

Both formats support multi-model files, which are loaded as frames in a single trajectory.
