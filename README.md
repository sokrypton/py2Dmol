# py2Dmol

A Python library for visualizing protein, DNA, and RNA structures in 2D, designed for use in Google Colab and Jupyter environments.

<img width="535" height="344" alt="image" src="https://github.com/user-attachments/assets/81fb0b9e-32a5-4fc7-ac28-921cf52f696e" />




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

### Example: Scatter + Structure (live)

Add a per-frame 2D point alongside the molecular frames. The scatter plot plays in sync with the viewer, supports sizing, and inherits the box/controls styling. [See detailed scatter plot documentation below](#scatter-plot-visualization).

```python
import py2Dmol, numpy as np
viewer = py2Dmol.view(scatter={"xlabel": "PC1", "ylabel": "PC2", "size": 300})
viewer.show()  # live mode
for _ in range(100):
    viewer.add(np.random.rand(200, 3) * 200, scatter=[np.random.rand(), np.random.rand()])
```

### Example: Comparing Multiple Trajectories

You can add multiple PDB files as separate, switchable trajectories. When you provide a different name, a new object is automatically created:

```python
import py2Dmol

viewer = py2Dmol.view()
# Load first trajectory
viewer.add_pdb('simulation1.pdb', name="sim1")

# Start a new trajectory (automatic new object via different name)
viewer.add_pdb('simulation2.pdb', name="sim2")

# Use the dropdown to switch between "sim1" and "sim2"
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
    ortho=1.0,           # orthographic projection (0.0=perspective, 1.0=orthographic)
    rotate=False,        # auto-rotation
    autoplay=False,      # auto-play (if trajectory or multiple models)
    box=True,            # show box around molecule
    controls=True,       # show controls
    pae=False,           # show pae
    pae_size=300,        # set pae canvas size (single integer for square canvas)
    scatter=False,       # show scatter plot (or dict with xlabel, ylabel, xlim, ylim, size)
    scatter_size=300,    # set scatter canvas size (if scatter=True)
)

viewer.add_pdb("my_complex.cif")
viewer.show()
```

### Example: Grid Layout

Display multiple structures in a grid layout for easy comparison:

```python
import py2Dmol

# Simple 2x2 gallery
with py2Dmol.grid(cols=2, size=(300, 300)) as g:
    g.view().from_pdb('1YNE')
    g.view().from_pdb('1BJP')
    g.view().from_pdb('9D2J')
    g.view().from_pdb('2BEG')
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
py2Dmol.view(rotate=True).from_pdb('1BJP', use_biounit=True, load_ligands=False)
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

## Scatter Plot Visualization

Visualize 2D data (e.g., RMSD vs Energy, PC1 vs PC2) synchronized with your molecular trajectory. Each frame in the trajectory can have an associated scatter point, and the scatter plot highlights the current frame during animation.

### Configuration

Enable scatter plots when creating the viewer:

```python
import py2Dmol

# Basic: use defaults
viewer = py2Dmol.view(scatter=True)

# Advanced: customize labels and limits
viewer = py2Dmol.view(scatter={
    "xlabel": "RMSD (Å)",
    "ylabel": "Energy (kcal/mol)",
    "xlim": [0, 10],      # Optional: [min, max] or None for auto
    "ylim": [-150, -90],  # Optional: [min, max] or None for auto
    "size": 300           # Canvas size in pixels (default: 300)
})
```

**Configuration Options:**
- `xlabel`: X-axis label (default: "X")
- `ylabel`: Y-axis label (default: "Y")
- `xlim`: X-axis limits `[min, max]` or `None` for auto-scaling
- `ylim`: Y-axis limits `[min, max]` or `None` for auto-scaling
- `size`: Canvas size in pixels (default: 300)

### Adding Scatter Data

#### Method 1: Per-Frame with `add()`

Add scatter data point-by-point in live mode:

```python
viewer = py2Dmol.view(scatter={"xlabel": "RMSD", "ylabel": "Energy"})
viewer.show()  # Live mode

for coords, rmsd, energy in trajectory:
    viewer.add(coords, scatter=[rmsd, energy])
```

**Supported Formats:**
```python
viewer.add(coords, scatter=[x, y])              # List
viewer.add(coords, scatter=(x, y))              # Tuple
viewer.add(coords, scatter={"x": x, "y": y})   # Dict
```

#### Method 2: CSV File with `add_pdb()`

Load scatter data from a CSV file when loading a PDB:

```python
viewer = py2Dmol.view(scatter=True)
viewer.add_pdb('trajectory.pdb', scatter='data.csv')
viewer.show()
```

**CSV Format:**
```csv
RMSD (Å),Energy (kcal/mol)
1.5,-120.5
2.1,-118.3
2.8,-115.2
3.2,-112.8
```

- **First row**: Header with xlabel and ylabel (automatically applied to plot)
- **Subsequent rows**: Numeric x,y data pairs (one per model/frame)

The CSV file must have exactly as many data rows as there are models/frames in the PDB file.

#### Method 3: List/Array with `add_pdb()`

Provide scatter data as a list or NumPy array:

```python
import numpy as np

scatter_data = [[1.5, -120.5], [2.1, -118.3], [2.8, -115.2]]
viewer = py2Dmol.view(scatter=True)
viewer.add_pdb('trajectory.pdb', scatter=scatter_data)
viewer.show()
```

**Supported Formats:**
- List of lists: `[[x1, y1], [x2, y2], ...]`
- List of tuples: `[(x1, y1), (x2, y2), ...]`
- NumPy array: `np.array([[x1, y1], [x2, y2], ...])`

### Complete Examples

#### Example 1: MD Trajectory Analysis

```python
import py2Dmol
import numpy as np

# Load trajectory with RMSD vs energy scatter plot
viewer = py2Dmol.view(
    scatter={
        "xlabel": "RMSD from native (Å)",
        "ylabel": "Total Energy (kcal/mol)",
        "xlim": [0, 8],
        "ylim": [-150, -80]
    },
    autoplay=True
)

# Load from CSV file
viewer.add_pdb('md_trajectory.pdb', scatter='md_analysis.csv')
viewer.show()
```

#### Example 2: PCA Visualization

```python
import py2Dmol
import numpy as np

# Generate PCA trajectory
viewer = py2Dmol.view(scatter={"xlabel": "PC1", "ylabel": "PC2", "size": 350})
viewer.show()  # Live mode

# Simulate PCA trajectory
for i in range(100):
    coords = generate_coords(i)  # Your coordinate generation
    pc1 = np.cos(i * 0.1) * 5
    pc2 = np.sin(i * 0.1) * 3
    viewer.add(coords, scatter=[pc1, pc2])
```

#### Example 3: Multi-Trajectory Comparison

```python
import py2Dmol

viewer = py2Dmol.view(scatter=True)

# First trajectory
viewer.add_pdb('simulation1.pdb',
               scatter='sim1_data.csv',
               name="sim1")

# Second trajectory
viewer.add_pdb('simulation2.pdb',
               scatter='sim2_data.csv',
               name="sim2")

viewer.show()
# Use dropdown to switch between trajectories
```

### Interactive Features

- **Frame Synchronization**: The scatter plot highlights the current frame in gold/yellow
- **Click Navigation**: Click any scatter point to jump to that frame in the 3D viewer
- **Animation**: During playback, the highlighted point moves through the scatter plot
- **Visual Layers**: Past frames (blue), current frame (gold), future frames (light blue)

### Frame Inheritance

If you omit scatter data for a frame, it inherits from the previous frame (similar to `plddts`, `chains`, etc.):

```python
viewer = py2Dmol.view(scatter=True)
viewer.show()

viewer.add(coords1, scatter=[1.0, -120])  # Frame 0: point at (1.0, -120)
viewer.add(coords2)                        # Frame 1: inherits (1.0, -120)
viewer.add(coords3, scatter=[2.0, -115])  # Frame 2: new point at (2.0, -115)
```

This is useful for trajectories where scatter values don't change every frame.

### Notes

- Scatter data is per-frame (one point per frame), unlike PAE which is per-object
- If `scatter=False` or not specified in `view()`, scatter data in `add()` calls is ignored
- Scatter plots use hardware-accelerated 2D canvas rendering for smooth performance
- The scatter canvas is DPI-aware and scales properly on high-resolution displays

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
viewer = py2Dmol.view(size=(600, 600), shadow=True)
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

## Colors

Colors are resolved through a **5-level hierarchy**. Higher levels override lower levels:

### Color Hierarchy (Priority Order)

| Level | How to Set | Scope | Specificity |
|-------|-----------|-------|-------------|
| 1️⃣ **Global** | `view(color="...")` | All objects | Lowest |
| 2️⃣ **Object** | `set_color("...")` or `set_color("...", name="obj")` | Single object | — |
| 3️⃣ **Frame** | `add(..., color="...")` | Single frame | — |
| 4️⃣ **Chain** | Advanced dict key `"chain"` | Single chain | — |
| 5️⃣ **Position** | Advanced dict key `"position"` | Single atom | Highest |

### Supported Color Values

**Color modes** (semantic): `"auto"`, `"chain"`, `"plddt"`, `"rainbow"`, `"entropy"`, `"deepmind"`

**Literal colors**:
- Named: `"red"`, `"blue"`, `"green"`, etc.
- Hex: `"#ff0000"`, `"#00ff00"`
- RGB: `{"r": 255, "g": 0, "b": 0}`

---

### Quick Examples

```python
# Color entire structure
viewer.set_color("plddt")

# Color specific chain
viewer.set_color("red", chain="A")

# Color specific positions
viewer.set_color("blue", position=10)              # Single position
viewer.set_color("green", position=[5, 10, 15])    # Multiple positions
viewer.set_color("yellow", position=(0, 20))       # Range: positions 0-19

# Combine conditions
viewer.set_color("red", chain="A", position=10, frame=0)
```

---

### Usage Examples (Simplest to Most Complex)

#### Level 1️⃣: Global Color (Simplest)
```python
# Single line: applies to everything unless overridden
viewer = py2Dmol.view(color="plddt")
viewer.add_pdb("protein.pdb")
viewer.show()
```

#### Level 2️⃣: Object Color Override
```python
viewer = py2Dmol.view(color="plddt")
viewer.add_pdb("protein1.pdb")
viewer.add_pdb("protein2.pdb", name="obj2")
# Override just protein2
viewer.set_color("chain", name="obj2")
viewer.show()
```

Or color the last added object without specifying name:
```python
viewer = py2Dmol.view(color="plddt")
viewer.add_pdb("protein1.pdb")
viewer.add_pdb("protein2.pdb", name="obj2")
viewer.set_color("chain")  # Colors obj2 (last added)
viewer.show()
```

#### Level 3️⃣: Frame Color (Multiple Models)
```python
viewer = py2Dmol.view()
viewer.add_pdb("simulation.pdb", color="plddt")  # Frame 1: plddt coloring
# .pdb with multiple models loads each as a separate frame
# Each frame can have its own color in live mode
viewer.show()
```

#### Level 4️⃣: Chain Colors
```python
viewer = py2Dmol.view()
viewer.add_pdb("protein.pdb")

# Simple: color one chain
viewer.set_color("red", chain="A")

# Multiple chains
viewer.set_color({"A": "red", "B": "blue", "C": "green"}, chain=True)

viewer.show()
```

#### Level 5️⃣: Position Colors
```python
viewer = py2Dmol.view()
viewer.add_pdb("protein.pdb")

# Single position
viewer.set_color("yellow", position=10)

# Multiple positions
viewer.set_color("red", position=[5, 10, 15, 20])

# Range of positions
viewer.set_color("blue", position=(10, 30))  # Positions 10-29

viewer.show()
```

#### Advanced: Combining Parameters
```python
viewer = py2Dmol.view()
viewer.add_pdb("protein.pdb")

# Color chain A red, except positions 5-10 which are blue
viewer.set_color("red", chain="A")
viewer.set_color("blue", position=(5, 10))

# In multi-frame structures, color specific frame
viewer.set_color("green", chain="B", frame=0)

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
