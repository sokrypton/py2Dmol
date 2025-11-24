# py2Dmol Technical Architecture & Function Reference

**A comprehensive guide to understanding the Python interface (viewer.py) and JavaScript interface (index.html, app.js, utils.js) for the py2Dmol molecular structure viewer.**

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture & Design Patterns](#architecture--design-patterns)
3. [File Structure & Modules](#file-structure--modules)
4. [Python Interface - viewer.py](#python-interface---viewerpy)
5. [JavaScript Interface - app.js & utils.js](#javascript-interface---appjs--utilsjs)
6. [Data Flow & Integration](#data-flow--integration)
7. [Key Algorithms](#key-algorithms)
8. [Function Call Graphs](#function-call-graphs)
9. [Data Structures & Message Protocol](#data-structures--message-protocol)

---

## System Overview

### Purpose

py2Dmol consists of two distinct but related components:

1.  **Python Package** (`py2Dmol`): A Jupyter-compatible library for visualizing molecular structures. It generates a self-contained HTML/JS widget that uses `viewer-mol.js` for rendering.
2.  **Standalone Web App** (`web/`): A full-featured web application (hosted at `index.html`) that wraps the rendering engine with a file upload interface, MSA viewer, and other web-specific features.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Jupyter Notebook / Python                   │
│  ┌──────────────┐                                               │
│  │  view class  │  (viewer.py)                                  │
│  │              │                                               │
│  │ • add()      │                                               │
│  │ • show()     │ ──── Generates HTML/JS Widget ──────────┐     │
│  └──────────────┘                                         │     │
└───────────────────────────────────────────────────────────│─────┘
                                                            │
┌───────────────────────────────────────────────────────────▼─────┐
│                     Browser / Widget Output                     │
│                                                                 │
│  ┌──────────────────────┐       ┌────────────────────────────┐  │
│  │  viewer.html         │       │  py2Dmol Resources         │  │
│  │  (Container)         │       │                            │  │
│  │                      │ uses  │ • viewer-mol.js (Renderer) │  │
│  │ ┌──────────────────┐ │ ────► │ • viewer-pae.js (PAE)      │  │
│  │ │ Canvas (Pseudo-3D)│ │       │ • viewer-seq.js (Seq)      │  │
│  │ └──────────────────┘ │       │ • viewer-msa.js (MSA)      │  │
│  └──────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     Standalone Web App (index.html)             │
│                                                                 │
│  ┌──────────────────────┐       ┌────────────────────────────┐  │
│  │  web/app.js          │ uses  │  py2Dmol Resources         │  │
│  │  (App Logic)         │ ────► │  (Shared Renderers)        │  │
│  └──────────────────────┘       └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Mode System (Python)

py2Dmol supports two operational modes:

#### Static Mode
```
viewer.add()  →  viewer.add()  →  viewer.show()
     ↓              ↓                  ↓
  Add data    Add more data      Display (all data at once)
```
- All data is added BEFORE calling `.show()`
- Data is serialized to JSON and embedded in HTML template
- Viewer renders complete snapshot (no live updates)

#### Live Mode
```
viewer.show()  →  viewer.add()  →  viewer.add()
     ↓              ↓                  ↓
Display empty  Send message      Update in real-time
```
- `.show()` called BEFORE adding data
- Creates empty viewer that waits for data
- Subsequent `.add()` calls send JavaScript messages
- Viewer dynamically updates as data arrives

---

## Architecture & Design Patterns

### Python Design (viewer.py)

**Pattern**: Data-Centric Object-Oriented Design

| Aspect | Implementation |
|--------|----------------|
| **Core Abstraction** | `view` class manages molecular data |
| **State Management** | Two-level hierarchy: objects → frames |
| **Alignment Strategy** | Automatic (best view on first frame, then relative alignment) |
| **Serialization** | JSON via Python's `json.dumps()` |
| **External Libraries** | `gemmi` for molecular I/O, `numpy` for math |
| **Display Backend** | IPython.display for Jupyter integration |

**Key State Variables**:
```python
self.objects = []                # List of object dicts
self._current_object_data = None # List of frame dicts for current object
self._is_live = False            # True if show() called before add()
self._coords = None              # Nx3 numpy array (alignment reference)
self._plddts = None              # N-length array (pLDDT scores)
self._chains = None              # List of chain IDs
self._position_types = None      # List of position types (P/D/R/L)
self._pae = None                 # LxL PAE matrix
```



### JavaScript Design (app.js + utils.js)

**Pattern**: Event-Driven Functional Design with Global State

| Aspect | Implementation |
|--------|----------------|
| **Core Abstraction** | Global `window.py2dmol_viewers` dictionary |
| **State Management** | DOM state + `window.viewerConfig` + renderer state |
| **Event Handling** | Multiple addEventListener() calls for UI controls |
| **Rendering Pipeline** | 2D Canvas API (Pseudo3DRenderer) → Screen |
| **SVG Export** | Canvas2SVG converter for saving as vector graphics |
| **External Libraries** | numeric.js for SVD/Kabsch, jszip for file parsing |
| **Module Pattern** | Separate concerns into viewer-*.js modules |

**Global State**:
```javascript
window.viewerApi          // Reference to renderer API
window.viewerConfig       // Configuration object (mirrored from Python)
window.py2dmol_viewers    // All instantiated viewer instances
window.staticObjectData   // Data injected from Python (static mode)
window.proteinData        // Current frame data (dynamic mode)
```

---

## File Structure & Modules

### Code Organization

```
py2Dmol-gamma/
├── py2Dmol/
│   ├── viewer.py                 # Main Python interface (1,700 lines)
│   └── resources/                # CORE RUNTIME RESOURCES (Used by both Widget and Web App)
│       ├── viewer.html           # HTML template for widget
│       ├── viewer-mol.js         # 3D rendering engine (Pseudo3DRenderer)
│       ├── viewer-pae.js         # PAE visualization
│       ├── viewer-seq.js         # Sequence display
│       └── viewer-msa.js         # MSA alignment viewer
├── web/                          # STANDALONE WEB APP
│   ├── app.js                    # Application logic (UI, File I/O)
│   ├── utils.js                  # Math utilities
│   └── style.css                 # Web app styling
├── index.html                    # Main web interface entry point
├── msa.html                      # MSA-focused interface
└── setup.py                      # Python package setup
```

### Module Dependencies

```
┌─────────────────────┐
│  viewer-mol.js      │ ◄── Core Renderer
└──────────▲──────────┘
           │
           ├─ Used by: py2Dmol Widget (viewer.html)
           │
           └─ Used by: Web App (index.html + app.js)

┌─────────────────────┐
│  web/app.js         │ ◄── Web App Logic
└──────────┬──────────┘
           │
           ├─ Manages UI (buttons, sliders, file upload)
           │
           └─ Calls viewer-mol.js for rendering
```

---

## Python Interface - viewer.py

### Core Class: `view`

The main class that manages all molecular structure data and Jupyter display.

#### Constructor: `__init__(...)`

**Signature**:
```python
def __init__(self,
    size=(300,300),           # Canvas size (width, height)
    controls=True,            # Show control UI
    box=True,                 # Show bounding box
    color="auto",             # Color mode: "auto", "plddt", "chain", "rainbow", "entropy", "deepmind"
    colorblind=False,         # Use colorblind-safe palette
    pastel=0.25,              # Pastel color saturation (0.0 - 1.0)
    shadow=True,              # Enable shadow rendering
    depth=False,              # Enable depth-based coloring
    outline="full",           # Outline mode: "none", "partial", "full"
    width=3.0,                # Line width (2.0 - 4.7)
    ortho=1.0,                # Orthographic projection (0.0 = perspective, 1.0 = orthographic)
    rotate=False,             # Auto-rotate
    autoplay=False,           # Auto-play animation
    pae=False,                # Show PAE matrix
    pae_size=300,             # PAE heatmap size
    reuse_js=False,           # Reuse JS from previous viewer (optimization)
    overlay=False             # Overlay all frames (merge into single view)
):
```

**Purpose**: Initializes a new viewer instance with configuration.

**New Features**:
- **Overlay Mode** (`overlay=True`): Renders all frames of an object simultaneously. Useful for visualizing ensembles or trajectories in a single static view.

**Implementation Details**:
- Creates unique `viewer_id` using `uuid.uuid4()`
- Stores all parameters in `self.config` dict
- Initializes empty object/frame lists
- Sets up alignment reference state variables

---

### Data Addition Functions

#### Function: `add(coords, plddts, chains, ...)`

**Signature** (simplified):
```python
def add(self,
    coords,                   # Nx3 numpy array of atomic positions
    plddts=None,              # N-length array of pLDDT scores
    chains=None,              # N-length list of chain identifiers
    position_types=None,      # N-length list of types: P/D/R/L
    pae=None,                 # LxL PAE matrix
    name=None,                # Object name (creates new object if name differs from current)
    align=True,               # Auto-align to previous frame?
    position_names=None,      # N-length list of residue names (ALA, GLY, etc.)
    residue_numbers=None,     # N-length list of PDB sequence numbers
    atom_types=None,          # (Deprecated) alias for position_types
    contacts=None,            # Contact restraints (.cst file or list)
    bonds=None,               # Explicit bond definitions [[idx1, idx2], ...]
    color=None                # Color override
):
```

**New Features**:
- **Explicit Bonds** (`bonds`): Allows defining custom connectivity. If provided, the renderer uses these bonds instead of distance-based heuristics. Format: List of integer pairs `[[atom_idx_1, atom_idx_2], ...]`.

**Purpose**: Adds a frame of coordinate data to the current object.

**Key Logic**:
1. **Alignment** (if `align=True`):
   - First frame: Apply `best_view()` rotation
   - Subsequent frames: Align to first frame using `align_a_to_b()`

2. **Serialization** via `_get_data_dict()`:
   - Rounds coordinates to 2 decimals
   - Scales pLDDT to integers
   - Compresses PAE matrix (scales to 0-255 for Uint8Array)

3. **Object Management**:
   - Auto-create object if needed via `new_obj()`
   - Append frame to `_current_object_data` list

4. **Live Mode** (if `self._is_live`):
   - Send JavaScript message via `_send_message()`
   - Type: `"py2DmolUpdate"`

**Called By**: User code, `add_pdb()`, `from_pdb()`, `from_afdb()`

**Calls**: `_update()`, `_get_data_dict()`, `new_obj()`, `_send_message()`

---

#### Function: `add_pdb(filepath, chains, new_obj, ...)`

**Signature**:
```python
def add_pdb(self,
    filepath,                 # Path to .pdb or .cif file
    chains=None,              # List of chain IDs to load (None = all)
    name=None,                # Object name (creates new object if name differs from current)
    paes=None,                # List of PAE matrices (one per model)
    align=True,               # Auto-align?
    use_biounit=False,        # Load biological assembly?
    biounit_name="1",         # Which biounit assembly?
    ignore_ligands=False,     # Skip ligand atoms?
    contacts=None,            # Contact restraints
    color=None                # Color override
):
```

**Purpose**: Load structure from PDB/CIF file and add to viewer.

**Process**:
1. Load file with `gemmi.read_structure(filepath)`
2. Handle biounit assembly (if requested):
   - Get assembly by name from `structure.assemblies`
   - Use `gemmi.make_assembly()` to generate coordinates
   - Fall back to ASU if biounit fails
3. Parse each model via `_parse_model()`
4. Call `add()` for each model as a frame

**Called By**: User code, `from_pdb()`

**Calls**: `gemmi.read_structure()`, `gemmi.make_assembly()`, `_parse_model()`, `add()`

---

#### Function: `_parse_model(model, chains_filter, ignore_ligands)`

**Signature**:
```python
def _parse_model(self,
    model,                    # gemmi.Model object
    chains_filter,            # List of chain IDs to extract (None = all)
    ignore_ligands=False      # Skip non-protein/DNA/RNA atoms?
):
```

**Returns**:
```python
(coords, plddts, position_chains, position_types, position_names, residue_numbers)
```

**Purpose**: Extract coordinates and metadata from a PDB/CIF model.

**Logic**:
```
For each chain in model:
  If chains_filter and chain not in filter: skip

  For each residue in chain:
    If residue is water (HOH): skip

    If protein (amino acid):
      Extract CA atom → position_type = 'P'

    Elif nucleic acid (DNA/RNA):
      Extract C4'/C4* atom
      Determine if RNA ('R') or DNA ('D') → position_type

    Else (ligand):
      If not ignore_ligands:
        For each non-hydrogen atom:
          Add atom → position_type = 'L'

    Store: [coord, pLDDT, chain, type, name, residue_number]
```

**Called By**: `add_pdb()`

**Calls**: None (uses gemmi API)

---

### Remote Data Sources

#### Function: `from_pdb(pdb_id, chains, ...)`

**Signature**:
```python
def from_pdb(self,
    pdb_id,                   # 4-char PDB code or filepath
    chains=None,
    name=None,                # Auto-generated from pdb_id if None
    align=True,               # Auto-align to best view (default: True)
    # ... other parameters (use_biounit, biounit_name, ignore_ligands, contacts, color)
):
```

**Process**:
1. Check if `pdb_id` is valid filepath
2. If 4-char code: download from RCSB via `_get_filepath_from_pdb_id()`
   - URL: `https://files.rcsb.org/download/{code}.cif`
   - Cache locally
3. Call `add_pdb(filepath)`
4. Auto-call `show()` if not already live

**Called By**: User code

**Calls**: `_get_filepath_from_pdb_id()`, `add_pdb()`, `show()`

---

#### Function: `from_afdb(uniprot_id, chains, ...)`

**Signature**:
```python
def from_afdb(self,
    uniprot_id,               # UniProt accession code (e.g., "P0A8I3")
    # ... other parameters
):
```

**Process**:
1. Download structure from AlphaFold DB via `_get_filepath_from_afdb_id()`
   - URL: `https://alphafold.ebi.ac.uk/files/AF-{code}-F1-model_v6.cif`
2. If PAE enabled: download PAE matrix
   - URL: `https://alphafold.ebi.ac.uk/files/AF-{code}-F1-predicted_aligned_error_v6.json`
   - Parse via `_parse_pae_json()`
3. Call `add_pdb(filepath, paes=[pae_matrix])`
4. Auto-call `show()`

**Called By**: User code

**Calls**: `_get_filepath_from_afdb_id()`, `_parse_pae_json()`, `add_pdb()`, `show()`

---

### Alignment & Geometry Functions

#### Function: `kabsch(a, b, return_v=False)` (Module-level)

**Signature**:
```python
def kabsch(a, b, return_v=False):
    # a, b: Nx3 numpy arrays (centered coordinates)
    # return_v: if True, return rotation matrix; if False, return rotation directly
```

**Purpose**: Compute optimal rotation matrix using Kabsch algorithm.

**Algorithm**:
```
Input: centered point clouds a, b (both Nx3)

1. Compute covariance matrix:
   H = a.T @ b

2. Singular Value Decomposition:
   U, S, V^T = SVD(H)

3. Compute determinant to fix chirality:
   det = det(U @ V^T)
   if det < 0: flip last column of U

4. Return rotation matrix:
   R = U @ V^T
```

**Mathematical Basis**:
- Finds rotation that minimizes RMSD between point clouds
- Handles reflection by checking determinant
- Time complexity: O(n)

**Called By**: `best_view()`, `align_a_to_b()`

**Calls**: `np.linalg.svd()`, `np.linalg.det()`

---

#### Function: `best_view(a)`

**Signature**:
```python
def best_view(a):
    # a: Nx3 numpy array
    # Returns: Nx3 rotated array
```

**Purpose**: Rotate structure to most visually appealing orientation.

**Algorithm**:
```
1. Center coordinates around mean
2. Compute Kabsch rotation of centered coords to themselves
   (finds principal axes via SVD)
3. Apply rotation and re-center
```

**Used For**: Initial frame orientation in `add()`

**Called By**: `add()` (first frame only)

**Calls**: `kabsch()`

---

#### Function: `align_a_to_b(a, b)`

**Signature**:
```python
def align_a_to_b(a, b):
    # a: Nx3 coordinates to align
    # b: Nx3 target coordinates
    # Returns: Nx3 aligned coordinates
```

**Purpose**: Align structure `a` to structure `b` using Kabsch.

**Algorithm**:
```
1. Center both structures
2. Compute rotation from centered_a to centered_b
3. Apply rotation to centered_a
4. Translate to centered_b's center
```

**Used For**: Multi-frame alignment in `add()`

**Called By**: `add()` (subsequent frames)

**Calls**: `kabsch()`

---

### Visualization & Display

#### Function: `show()`

**Signature**:
```python
def show(self):
```

**Purpose**: Display the viewer in Jupyter or browser.

**Behavior**:
```
if self.objects is empty:
    → Live Mode (dynamic updates allowed)
else:
    → Static Mode (snapshot of current data)
```

**Process**:
1. Call `_display_viewer(static_data=...)`
   - If live: `static_data=None`
   - If static: `static_data=self.objects`
2. Call `_display_html()` to render
3. Set `self._is_live = True` (prevents duplicate calls)

**Called By**: User code, `from_pdb()`, `from_afdb()` (auto)

**Calls**: `_display_viewer()`, `_display_html()`

---

#### Function: `_display_viewer(static_data=None)` (Large, complex)

**Signature**:
```python
def _display_viewer(self, static_data=None):
    # static_data: list of objects (for static mode)
    # Returns: complete HTML string
```

**Purpose**: Generate complete HTML/JavaScript viewer UI.

**Process**:
1. Load `viewer.html` template
2. Inject configuration script (viewer settings)
3. Inject data script:
   - **Static mode**: Serialize objects to JSON, embed in window.staticObjectData
   - **Live mode**: Inject empty data skeleton
4. Load JavaScript modules:
   - viewer-mol.js (always)
   - viewer-pae.js (if PAE enabled)
5. Wrap in container div with initialization script

**Optimization**: Frame deduplication
- Only include fields that changed from previous frame
- Always include frame 0
- Reduces JSON size for multi-frame structures

**Called By**: `show()`, `_display_html()`

**Calls**: `importlib.resources.open_text()`, JSON serialization

---

#### Function: `_send_message(message_dict)` (Live mode communication)

**Signature**:
```python
def _send_message(self, message_dict):
    # message_dict: dict with "type" and other fields
```

**Purpose**: Send JavaScript messages to update live viewer.

**Message Types**:

| Type | Payload | Purpose |
|------|---------|---------|
| `py2DmolUpdate` | `{"payload": {...}, "name": ...}` | Add/update frame |
| `py2DmolNewObject` | `{"name": ...}` | Create new object |
| `py2DmolClearAll` | (none) | Clear all objects |
| `py2DmolSetColor` | `{"color": ..., "name": ...}` | Change colors |
| `py2DmolSetObjectColor` | `{"color": {...}, "name": ...}` | Object color |
| `py2DmolSetViewTransform` | `{"rotation": [...], "center": [...], "name": ...}` | Set rotation/center |

**Implementation**:
```javascript
// Generated JS code:
if (window.py2dmol_viewers && window.py2dmol_viewers[viewer_id]) {
    window.py2dmol_viewers[viewer_id].handlePython[MessageType](payload);
}
```

**Called By**: `add()`, `set_color()`, `clear()`, `new_obj()`

**Calls**: `display(Javascript(...))`

---

### Live Mode Metadata Synchronization

#### Problem: Metadata Updates in Live Mode

When using live mode (`.show()` followed by `.add_pdb(..., contacts=...)`), metadata like contacts, bonds, and colors need to be synchronized with the JavaScript renderer. The challenge is:

1. **Frame data** is added one at a time via messages
2. **Metadata** (contacts, bonds, colors) is object-level but may be provided during frame addition
3. **Segment generation** in the renderer depends on having metadata available when regenerating segments

#### Solution: Three-Pass Metadata Synchronization (Python → JavaScript)

The solution uses a **three-pass injection pattern** in `_send_message()` (viewer.py, lines 313-375):

**Pass 1: Create Objects**
```javascript
for (const objectName of Object.keys(allObjectsData)) {
    if (!viewer.renderer.objectsData[objectName]) {
        viewer.handlePythonNewObject(objectName);
    }
}
```
- Creates any missing object containers
- Doesn't load data yet

**Pass 2: Add Frames**
```javascript
for (const [objectName, frames] of Object.entries(allObjectsData)) {
    for (let i = currentFrameCount; i < frames.length; i++) {
        viewer.handlePythonUpdate(JSON.stringify(frames[i]), objectName);
    }
}
```
- Adds frames one at a time
- `handlePythonUpdate()` → `addFrame()` → `setFrame()` (loads frame data)
- Each frame is rendered as it's added

**Pass 3: Apply Metadata & Re-render**
```javascript
let metadataApplied = false;
for (const [objectName, metadata] of Object.entries(allObjectsMetadata)) {
    const obj = viewer.renderer.objectsData[objectName];
    if (obj) {
        if (metadata.color) { obj.color = metadata.color; metadataApplied = true; }
        if (metadata.contacts) { obj.contacts = metadata.contacts; metadataApplied = true; }
        if (metadata.bonds) { obj.bonds = metadata.bonds; metadataApplied = true; }
    }
}

if (metadataApplied) {
    viewer.renderer.cachedSegmentIndices = null;
    viewer.renderer.cachedSegmentIndicesFrame = -1;
    viewer.renderer.cachedSegmentIndicesObjectName = null;
    // CRITICAL: Call setFrame to regenerate segments with new metadata
    viewer.renderer.setFrame(viewer.renderer.currentFrame);
}
```

#### Key Insight: Cache Invalidation Pattern

Simply clearing cache flags isn't enough. The fix requires calling `setFrame()` to:

1. **Reload frame data** with the current frame index
2. **Call `setCoords()`** which regenerates segment indices
3. **Check cache flags** - finds them invalid
4. **Generate new segments** including contacts, bonds, and colors
5. **Render** with updated segment information

#### Example: Adding Contacts in Live Mode

```python
viewer = py2Dmol.view()
viewer.show()                                                    # Empty display
viewer.add_pdb("protein.cif", contacts=[[0, 10, 1.0, "yellow"]])
```

Flow:
1. Python: Store contacts on object and frame
2. Python `_send_message()`:
   - **Pass 1**: Create object "0"
   - **Pass 2**: Call `handlePythonUpdate()` → `addFrame()` → `setFrame()` → render frame
   - **Pass 3**: Apply metadata, call `setFrame()` → regenerate segments with contacts → render
3. JavaScript: Contacts appear as colored lines

#### Performance Notes

- **Three-pass approach** avoids duplicate renders
- **Batch loading flag** (`_batchLoading`) prevents intermediate renders
- **Cache invalidation** only happens when metadata is applied
- **Segment regeneration** is O(n) where n = number of atoms

---

### Color System

The color system uses a **5-level hierarchy** that allows precise control at different granularities:

#### Color Hierarchy (Priority Order - Low to High)

1. **Global/Session Level** - Viewer-wide default set in `view(color=...)`
2. **Object Level** - Per-object override via `set_color(name, color)`
3. **Frame Level** - Per-frame override via `add(..., color=...)`
4. **Chain Level** - Per-chain override within advanced format
5. **Position Level** - Per-atom override (highest priority)

The JavaScript renderer resolves colors through `resolveColorHierarchy()` which walks this hierarchy top-to-bottom and uses the first match found.

#### Function: `set_color(color, name=None)` (Improved API)

**Signature**:
```python
def set_color(self, color, name=None):
    # color: Color spec (mode string, literal color, or advanced dict)
    # name: Object name (optional, defaults to last added object)
```

**Purpose**: Set colors for a specific object or its last-added frame.

**API Improvements** (v2025-01-24):
- Changed signature from `set_color(name, color)` to `set_color(color, name=None)` for intuitive API
- Made `name` parameter optional (defaults to last added object)
- Consistent with `add_contacts()` parameter ordering
- Works in both static and live modes

**Implementation Details**:
1. **Find target object**:
   - If `name` is None: Use `self.objects[-1]` (last added)
   - If `name` is provided: Find by name via `_find_object_by_name()`

2. **Normalize color**: Call `_normalize_color(color)`

3. **Handle frame-level colors**: Check if advanced dict contains `"frames"` key

4. **Live mode**: Send `py2DmolSetObjectColor` message to update JavaScript

**Examples**:
```python
# Use last added object
viewer.set_color("chain")

# Specify target object
viewer.set_color("rainbow", name="obj1")

# Chain-level coloring
viewer.set_color({"chain": {"A": "red", "B": "blue"}})
```

**Called By**: User code

**Calls**: `_normalize_color()`, `_find_object_by_name()`, `_send_message()`

---

#### Function: `_normalize_color(color)`

**Signature**:
```python
def _normalize_color(color):
    # Returns: {"type": "mode"/"literal"/"advanced", "value": ...} or None
```

**Input Detection and Normalization**:

| Input Type | Detection | Output |
|-----------|-----------|--------|
| `None` | `is None` | `None` |
| Mode string | `in VALID_COLOR_MODES` | `{"type": "mode", "value": "plddt"}` |
| Other string | any string | `{"type": "literal", "value": "red"}` |
| Already normalized | has `type` + `value` keys | Returns as-is (no re-wrapping) |
| Advanced dict | has `chain`/`position`/`frame`/`object` key | `{"type": "advanced", "value": {...}}` |
| Other dict | no recognized keys | `{"type": "advanced", "value": {...}}` |

**Examples**:

```python
# Input → Output
_normalize_color("plddt")
# → {"type": "mode", "value": "plddt"}

_normalize_color("#ff0000")
# → {"type": "literal", "value": "#ff0000"}

_normalize_color({"chain": {"A": "red"}})
# → {"type": "advanced", "value": {"chain": {"A": "red"}}}

_normalize_color({"type": "advanced", "value": {"chain": {"A": "red"}}})
# → {"type": "advanced", "value": {"chain": {"A": "red"}}}  (already normalized, unchanged)
```

**Advanced Format Structure**:

Users can mix and match any of these keys within an advanced dict:

```python
{
    "frame": "plddt",                     # Frame-level default (overrides global)
    "chain": {"A": "red", "B": "blue"},   # Chain-level (overrides frame)
    "position": {0: "yellow", 5: "green"} # Position-level (overrides chain)
}
```

Only the keys needed should be provided. Keys are optional.

**Called By**: `add()`, `set_color()`, `add_pdb()`

**Calls**: None

---

### State Persistence

#### Function: `save_state(filepath)`

**Signature**:
```python
def save_state(self, filepath):
    # filepath: where to save JSON file
```

**Purpose**: Save viewer state (objects, frames, settings) to JSON. Coordinates are rounded to 2 decimal places to reduce file size.

**Output Format**:
```json
{
  "objects": [
    {
      "name": "1YNE",
      "frames": [
        {
          "coords": [[x, y, z], ...],
          "plddts": [50, 60, ...],
          "chains": ["A", "A", ...],
          "position_types": ["P", "P", ...],
          ...
        }
      ],
      "contacts": [[10, 50, 1.0, {r: 255, ...}], ...],
      "color": {...}
    }
  ],
  "viewer_state": {
    "current_object_name": "1YNE",
    "color_mode": "plddt",
    "line_width": 3.0,
    ...
  }
}
```

**Optimization**: Detects redundant fields
- If all frames have same value for `chains`, stores at object level
- Removes from individual frames to reduce size

**Called By**: User code, JavaScript save handler

**Calls**: `os.makedirs()`, `json.dump()`

---

#### Function: `load_state(filepath)`

**Signature**:
```python
def load_state(self, filepath):
```

**Purpose**: Restore viewer state from saved JSON.

**Process**:
1. Parse JSON file
2. Clear existing objects
3. For each object in file:
   - Call `new_obj(name)`
   - For each frame:
     - Call `add()` with frame data
4. Restore viewer config

**Called By**: User code

**Calls**: `json.load()`, `new_obj()`, `add()`

---

## Project Structure

The project is organized into several key directories:

### `py2dmol/` (Python Package)
- `__init__.py`: Package initialization.
- `viewer.py`: Main Python API for creating and manipulating the 3D viewer.
- `_widget.py`: Jupyter widget integration.
- `_frontend.py`: Frontend build system integration.
- `_version.py`: Package version information.

### `resources/` (Frontend Assets)
- `viewer-mol.js`: Core 3D rendering engine (shared by Python widget and web app).
- `viewer-pae.js`: PAE plot visualization module.
- `viewer-seq.js`: Sequence viewer module.
- `viewer-msa.js`: Multiple Sequence Alignment (MSA) viewer module.
- `py2dmol.css`: Core CSS styles for the viewer.

### `web/`
  - `app.js`: Main application logic for the standalone web interface.
  - `utils.js`: Pure utility functions (parsing, alignment, geometry) shared by the web app.
  - `index.html`: Entry point for the main 3D viewer application.
  - `msa.html`: Entry point for the standalone MSA viewer.
  - `style.css`: Global styles.

### Module Dependencies

- `viewer.py` depends on `resources/viewer-mol.js` (embedded).
- `web/app.js` depends on `resources/viewer-mol.js` and `web/utils.js`.
- `resources/viewer-mol.js` is the core dependency for both interfaces.

---

## Core Renderer - viewer-mol.js

The `viewer-mol.js` file contains the core rendering engine and is used by both the Python widget and the Web App.

### Initialization

#### Function: `initializePy2DmolViewer(container, viewerId)`

**Signature**:
```javascript
function initializePy2DmolViewer(container, viewerId)
```

**Purpose**: Initializes a self-contained viewer instance within the given DOM container.

**Key Responsibilities**:
1.  Creates a `canvas` element (if not present).
2.  Instantiates `Pseudo3DRenderer`.
3.  Sets up `ResizeObserver` for responsive canvas.
4.  Exposes API via `window.py2dmol_viewers[viewerId]`.

### Class: `Pseudo3DRenderer`

**Purpose**: Handles the 2D projection and rendering of 3D molecular data.

**Key Properties**:
- `this.coords`: Array of `Vec3` (atomic coordinates).
- `this.viewerState`: Stores rotation, zoom, and camera state.
- `this.objectsData`: Dictionary of all loaded objects and their frames.

**Key Methods**:
- `render()`: Main render loop. Clears canvas, projects points, draws segments/shadows.
- `setFrame(frameIndex)`: Updates internal state to a specific frame.
- `setRotationMatrix(matrix)`: Updates camera rotation.
- `addObject(name)`: Creates a new object container in `this.objectsData`.
- `addFrame(data, objectName)`: Parses raw JSON data and appends a frame to the specified object.
- `setUIControls(controlsContainer, ...)`: Binds DOM elements (sliders, buttons) to renderer actions.
- `extractSelection()`: Creates a new object from the currently selected atoms.

---

## Visualization Modules

### PAE Renderer - viewer-pae.js

Handles the visualization of Predicted Aligned Error (PAE) matrices.

**Class**: `PAERenderer`

**Key Methods**:
- `setData(paeData)`: Loads PAE matrix data.
- `render()`: Draws the PAE heatmap on the canvas.
- `setupInteraction()`: Handles mouse/touch events for cross-referencing with the structure.

### Sequence Viewer - viewer-seq.js

Manages the protein sequence display and interaction.

**Key Functions**:
- `buildSequenceView()`: Constructs the sequence visualization based on current object data.
- `renderSequenceCanvas()`: Renders the sequence and selection highlights.
- `setupCanvasSequenceEvents()`: Handles selection and navigation on the sequence track.

### MSA Viewer - viewer-msa.js

Handles Multiple Sequence Alignment (MSA) visualization.

**Key Features**:
- **Canvas Rendering**: Uses a custom `SimpleCanvas2SVG` for performance.
- **Modes**:
  - **MSA**: Direct visualization of alignment.
  - **PSSM**: Position-Specific Scoring Matrix.
  - **Logo**: Sequence logo visualization.
  - **Coverage**: Sequence coverage plot.
- **Filtering Pipeline**:
  - `sourceMSA` (Immutable) → `buildSelectionMask` → `filterByCoverage` → `filterByIdentity` → `sortByIdentity` → `displayedMSA`.
- **Update Triggers**: Re-runs pipeline on selection, coverage/identity slider changes, or sort toggle.

---

## Standalone Web App - web/app.js

### Global State & Initialization

#### Global Variables

```javascript
let viewerApi = null;                    // Reference to renderer API
let batchedObjects = [];                 // Temporary storage during loading

window.viewerConfig = {                  // Configuration (mirrored from Python)
    size: [600, 600],
    color: "auto",
    shadow: true,
    pae: true,
    // ... other settings
};

window.py2dmol_viewers = {};             // All viewer instances by ID
window.staticObjectData = [...];         // Data injected from Python
```

#### Constants

```javascript
const FIXED_WIDTH = 600;                 // Canvas width
const FIXED_HEIGHT = 600;                // Canvas height
const PAE_PLOT_SIZE = 300;               // PAE heatmap size
const DEFAULT_MSA_COVERAGE = 0.75;       // MSA filter default
const DEFAULT_MSA_IDENTITY = 0.15;       // MSA filter default
```

---

#### Function: `initializeApp()`

**Signature**:
```javascript
function initializeApp()
```

**Purpose**: Main initialization when DOM is ready.

**Call Order**:
```
1. initializeViewerConfig()         - Create window.viewerConfig, sync UI checkboxes
2. setupCanvasDimensions()          - Set canvas width/height to 600x600
3. initializePy2DmolViewer()        - Create Pseudo3DRenderer, initialize viewer
4. Get viewerApi reference          - Extract from window.py2dmol_viewers[viewer_id]
5. Setup MSA viewer callbacks        - If MSAViewer exists, wire up highlight/filter handlers
6. Initialize highlight overlay     - Call window.SequenceViewer.drawHighlights()
7. setupEventListeners()            - Wire up 60+ UI event handlers
8. initDragAndDrop()                - Enable file drag/drop on page
9. setStatus("Ready...")            - Display ready message
```

**Called By**: `DOMContentLoaded` event

**Calls**: All initialization functions listed above

---

### Event Handling System

#### Function: `setupEventListeners()`

**Signature**:
```javascript
function setupEventListeners()
```

**Purpose**: Wire up all DOM event listeners.

**Listeners Registered** (60+ listeners):

| Element | Event | Handler | Purpose |
|---------|-------|---------|---------|
| `fetch-btn` | click | `handleFetch()` | Fetch PDB/UniProt |
| `file-upload` | change | `handleFileUpload()` | File upload |
| `playButton` | click | Play animation |
| `frameSlider` | input | Frame selection |
| `objectSelect` | change | `handleObjectChange()` | Switch object |
| `colorSelect` | change | Color mode change |
| `lineWidthSlider` | input | Update line width |
| `rotateToggle` | change | Auto-rotation |
| `orientToggle` | click | `applyBestViewRotation()` | Reset view |
| `selectAllResidues` | click | `showAllResidues()` | Show sequence |
| `clearAllResidues` | click | `hideAllResidues()` | Hide sequence |
| `msaSortCheckbox` | change | Sort MSA |
| `saveSvgButton` | click | Save as SVG |
| `recordButton` | click | Record animation |

**Called By**: `initializeApp()`

**Calls**: Individual handler functions

---

### File Loading & Parsing

#### Function: `handleFileUpload(event)`

**Signature**:
```javascript
function handleFileUpload(event)
```

**Purpose**: Process files selected via file input or drag/drop with async handling.

**Supported File Types**:
- `.pdb`, `.cif` - Protein structures
- `.json` - PAE matrices, config, or state files
- `.cst` - Contact constraints
- `.a3m`, `.fasta`, `.sto` - Multiple sequence alignments
- `.zip` - Archive (multiple files)

**Process**:
1. Get files from `event.target.files` or `event.dataTransfer.files`
2. Check `loadAsFramesCheckbox` to determine frame/object mode
3. Separate ZIP files from loose files
4. **If ZIP files**:
   - Call `handleZipUpload()` with first ZIP
   - Display warning if multiple ZIPs
   - Return early
5. **If loose files**:
   - Start async processing via `processFiles()` with Promise
   - Detect if state file (`.py2dmol.json`) was loaded
   - Detect trajectory (multi-model structure)
   - Collect stats: objectsLoaded, framesAdded, paePairedCount
   - Display status message with statistics

**Key Features**:
- **Async handling**: Uses IIFE with async/await for non-blocking
- **Trajectory detection**: Single multi-model PDB as one object with multiple frames
- **State file detection**: Recognizes `.py2dmol.json` and loads viewer state
- **Statistics tracking**: Reports objects, frames, and PAE pairings
- **Error handling**: Try/catch block with user-friendly error messages

**Called By**: File input change event, drag/drop handler

**Calls**: `handleZipUpload()`, `processFiles()`, `setStatus()`, MSA loading functions

**Related Functions**:
- `processFiles()` - Async function that routes files to appropriate handlers and collects statistics
- `handleZipUpload()` - Handles ZIP archive extraction and processing
- File parsing happens in separate async workers/callbacks as per MSA and PDB loaders

---

#### Function: `processStructureToTempBatch(text, name, paeData, ...)`

**Signature**:
```javascript
function processStructureToTempBatch(text, name, paeData, targetObjectName, tempBatch)
```

**Purpose**: Parse PDB/CIF file content into frame data structure.

**Process**:
```
1. Parse text content using PDB/CIF parser
   (delegated to viewer-mol.js or gemmi.js)

2. Extract:
   - Coordinates (ATOM records)
   - B-factors (pLDDT)
   - Chain identifiers
   - Position types (P/D/R/L)
   - Residue names & numbers
   - Explicit bonds (CONECT records)

3. Build frame object:
   {
     coords: [[x, y, z], ...],
     plddts: [50, 60, ...],
     chains: ["A", "B", ...],
     position_types: ["P", "P", ...],
     position_names: ["ALA", "GLY", ...],
     residue_numbers: [1, 2, ...],
     name: "frame_name",
     pae: paeData || null
   }

4. Add to tempBatch (or create new object)
```

**Called By**: `handleFileUpload()`

**Calls**: PDB/CIF parser functions

---

#### Function: `updateViewerFromGlobalBatch()`

**Signature**:
```javascript
function updateViewerFromGlobalBatch()
```

**Purpose**: Transfer accumulated data from `batchedObjects` to renderer.

**Process**:
```
1. For each object in batchedObjects:
   - Call viewerApi.addObject(objectData)
   - Update UI (object selector, frame slider)

2. Refresh UI state:
   - updateObjectNavigationButtons()
   - updateSequenceViewSelectionState()
   - Recompute MSA filters if present

3. Trigger render:
   - viewerApi.render()
```

**Called By**: `handleFileUpload()`, import handlers

**Calls**: `viewerApi.addObject()`, UI update functions

---

### Rendering & Visualization

#### Function: `applyBestViewRotation(animate=true)`

**Signature**:
```javascript
function applyBestViewRotation(animate = true)
```

**Purpose**: Reset camera to optimal viewing angle (2D pseudo-3D projection).

**Process**:
```
1. Get current coordinates from renderer
2. Compute best-view rotation:
   - Center coordinates
   - Compute SVD to find principal axes
   - Create rotation matrix
3. If animate:
   - Setup animation state (start/target matrices, duration)
   - Call animateRotation() each frame
   Else:
   - Apply rotation immediately
4. Trigger re-render with updated projection matrix
```

**Duration**: 1000 ms (1 second)

**Called By**: Orient button click

**Calls**: `animateRotation()`, `renderer.setRotationMatrix()`, `renderer.render()`

---

#### Function: `animateRotation()`

**Signature**:
```javascript
function animateRotation()
```

**Purpose**: Animate rotation from current to target matrix.

**Process**:
```
1. Compute elapsed time
2. Interpolate between start and target matrices (SLERP)
3. Apply to renderer
4. If not finished:
   - Schedule next frame: requestAnimationFrame(animateRotation)
Else:
   - Stop animation
```

**Used For**: Smooth camera transitions

**Called By**: `applyBestViewRotation()` (recursive via requestAnimationFrame)

**Calls**: `viewerApi.setRotationMatrix()`, `renderer.render()`

---

### Sequence & Selection Management

#### Function: `applySelection(previewPositions=null)`

**Signature**:
```javascript
function applySelection(previewPositions = null)
```

**Purpose**: Apply selection state to renderer (highlight selected atoms).

**Process**:
```
1. Get selection state from UI:
   - Which chain residues are selected?
   - Convert to flat position indices

2. Pass to renderer:
   viewerApi.renderer.highlightedPositions = positionIndices

3. Trigger re-render with highlighting
```

**Used By**: Sequence viewer interaction

**Called By**: Sequence UI buttons, MSA callbacks

**Calls**: `viewerApi.renderer.render()`

---

#### Function: `highlightPosition(positionIndex)`

**Signature**:
```javascript
function highlightPosition(positionIndex)
```

**Purpose**: Highlight single atom in 3D view.

**Process**:
```
1. Call viewerApi.renderer.addHighlight(positionIndex)
2. Trigger render
3. Emit 'py2dmol-position-highlight' event
4. Update sequence viewer
```

**Used By**: MSA viewer callbacks, sequence hover

**Calls**: `viewerApi.renderer.render()`, `window.SequenceViewer.drawHighlights()`

---

#### Function: `highlightPositions(positionIndices)`

**Signature**:
```javascript
function highlightPositions(positionIndices)
```

**Purpose**: Highlight multiple atoms (bulk operation).

**Process**:
```
1. For each position:
   viewerApi.renderer.addHighlight(position)
2. Single re-render at end
```

**Optimization**: Batches renders (vs individual highlights)

**Called By**: Selection operations

**Calls**: `viewerApi.renderer.render()`

---

### MSA (Multiple Sequence Alignment) Integration

#### Function: `computeMSAProperties(msaData, selectionMask=null)`

**Signature**:
```javascript
function computeMSAProperties(msaData, selectionMask = null)
```

**Purpose**: Calculate frequency, entropy, and PSSM from alignment.

**Computed Properties**:

```javascript
msaData.frequencies = {
    0: {A: 0.8, G: 0.2, ...},  // Position 0 amino acid frequencies
    1: {V: 0.9, I: 0.1, ...},  // Position 1 frequencies
    ...
}

msaData.entropy = [
    0.5,    // Position 0 entropy (bits)
    1.2,    // Position 1 entropy
    ...
]

msaData.logOdds = [  // PSSM values
    {A: 2.1, G: -1.2, ...},
    ...
]
```

**Algorithm**:
```
For each position i in alignment:
  1. Count frequency of each amino acid
  2. Entropy[i] = -Σ (p * log2(p)) for each AA
  3. LogOdds[i] = log2(observed_freq / background_freq)
```

**Called By**: MSA file loading, MSA filter changes

**Calls**: None (pure computation)

---

#### Function: `matchMSAsToChains(msaDataList, chainSequences)`

**Signature**:
```javascript
function matchMSAsToChains(msaDataList, chainSequences)
```

**Purpose**: Match MSA alignments to PDB chains by sequence.

**Process**:
```
1. For each MSA:
   - Get query sequence (first row)

2. For each chain in PDB:
   - Compare chain sequence to all MSA queries
   - Find best match (lowest edit distance)
   - Store mapping: chain → MSA

3. Return: {chainId: msaIndex, ...}
```

**Used For**: Linking sequence alignment to 3D structure

**Called By**: MSA loading process

**Calls**: `sequencesMatch()` (edit distance)

---

#### Function: `loadMSADataIntoViewer(msaData, chainId, objectName, options={})`

**Signature**:
```javascript
function loadMSADataIntoViewer(msaData, chainId, objectName, options = {})
```

**Purpose**: Load MSA into viewer and setup visualization.

**Process**:
```
1. Attach MSA to renderer:
   viewerApi.renderer.objectsData[objectName].msa = msaData

2. Compute MSA properties:
   computeMSAProperties(msaData)

3. Setup MSA viewer UI:
   - Create canvas containers
   - Setup mode dropdown (MSA/PSSM/Logo)
   - Setup filter controls

4. Render MSA visualization
```

**Called By**: File loading, MSA viewer initialization

**Calls**: `computeMSAProperties()`, MSA renderer

---

### Utility & Math Functions (utils.js)

#### Function: `calculateMean(coords)`

**Signature**:
```javascript
function calculateMean(coords)
// coords: Array<[x, y, z]>
// Returns: [mean_x, mean_y, mean_z]
```

**Purpose**: Compute centroid of point cloud.

**Called By**: Kabsch algorithm, alignment functions

---

#### Function: `kabsch(A, B)`

**Signature**:
```javascript
function kabsch(A, B)
// A, B: both Nx3 arrays (centered)
// Returns: 3x3 rotation matrix
```

**Purpose**: Compute optimal rotation (JavaScript version).

**Algorithm** (same as Python):
```
1. H = A^T @ B
2. U, S, V^T = SVD(H)   [using numeric.js]
3. D = [[1,0,0], [0,1,0], [0,0,1]]
4. if det(U @ V^T) < 0: D[2][2] = -1
5. Return U @ D @ V^T
```

**Called By**: `align_a_to_b()`, viewer-mol.js

**Calls**: `numeric.dot()`, `numeric.svd()`, `numeric.det()`

---

#### Function: `align_a_to_b(fullCoordsA, alignCoordsA, alignCoordsB)`

**Signature**:
```javascript
function align_a_to_b(fullCoordsA, alignCoordsA, alignCoordsB)
```

**Purpose**: Align structure A to B using subset of coordinates.

**Used For**: Aligning ligand/complex structures using CA-only subset

**Called By**: Multi-frame animation playback

---

#### Function: `bestViewTargetRotation_relaxed_AUTO(coords, currentRotation, canvasWidth, canvasHeight)`

**Signature**:
```javascript
function bestViewTargetRotation_relaxed_AUTO(coords, currentRotation, canvasWidth, canvasHeight)
// coords: Array<[x, y, z]>
// currentRotation: 3x3 matrix
// Returns: 3x3 target rotation matrix
```

**Purpose**: Calculate optimal rotation to maximize visible variance (PCA-based).

**Algorithm**:
1. Compute covariance matrix of coordinates.
2. Perform SVD to find principal axes (eigenvectors).
3. Map largest variance axis to longest canvas dimension (X or Y).
4. Select sign combinations to minimize rotation from current state.

**Called By**: `viewer-mol.js` (auto-rotate/best-view)

---

#### Function: `parsePDB(text)`

**Signature**:
```javascript
function parsePDB(text)
// text: String (PDB file content)
// Returns: { models, modresMap, conectMap }
```

**Purpose**: Parse PDB format into internal structure.
- Extracts ATOM/HETATM records.
- Parses CONECT records for explicit bonds.
- Parses MODRES for modified residues.

**Called By**: `app.js` (file loading)

---

#### Function: `parseCIF(text)`

**Signature**:
```javascript
function parseCIF(text)
// text: String (mmCIF file content)
// Returns: Array of models
```

**Purpose**: Parse mmCIF format into internal structure.
- Handles `_atom_site` loop.
- Parses `_struct_conn` and `_chem_comp_bond` for explicit bonds.

**Called By**: `app.js` (file loading)

---

## Data Flow & Integration

### Static Mode Data Flow

```
Python:                          JavaScript:
────────────────────────────────────────────────

viewer.add()  ────────┐
                      │
viewer.add()  ────────┼─→ [Coords, pLDDT, PAE, ...]
                      │
viewer.show() ─→ _display_viewer()
                      │
                      ├─→ JSON.stringify(objects)
                      │
                      ├─→ Embed in window.staticObjectData
                      │
                      └─→ Inject into HTML template
                               │
                               └─→ Browser receives complete HTML
                                    │
                                    ├─→ Parse staticObjectData
                                    │
                                    └─→ initializePy2DmolViewer()
                                         │
                                         └─→ Render all frames
```

### Live Mode Data Flow

```
Python:                          JavaScript:
────────────────────────────────────────────────

viewer.show() ──→ _display_viewer(static_data=None)
   (empty)            │
                      ├─→ Inject empty data skeleton
                      │
                      └─→ Initialize viewer (no data yet)
                               │
                               └─→ Browser: ready to receive updates
                                    │
                                    └─→ window.py2dmol_viewers[id]
                                         stored


viewer.add() ──→ _send_message()
                      │
                      ├─→ Serialize frame to JSON
                      │
                      ├─→ Create JavaScript:
                      │   "window.py2dmol_viewers[id]
                      │    .handlePythonUpdate(payload)"
                      │
                      └─→ display(Javascript(...))
                               │
                               └─→ Browser executes JS
                                    │
                                    └─→ Renderer processes update
                                         │
                                         └─→ Immediate re-render
```

### Message Protocol

#### Message Type: `py2DmolUpdate`

**Sent By**: `add()` in live mode

**Payload**:
```python
{
    "type": "py2DmolUpdate",
    "name": "object_name",
    "payload": {
        "coords": [[x, y, z], ...],
        "plddts": [50, 60, ...],
        "chains": ["A", "B", ...],
        "position_types": ["P", "P", ...],
        "pae": [uint8, uint8, ...] or None,
        "position_names": ["ALA", ...],
        "residue_numbers": [1, 2, ...],
        "bonds": [[0, 1], [1, 2]],
        "contacts": [[10, 50, 1.0, {r, g, b}], ...],
        "color": {"type": "mode", "value": "plddt"}
    }
}
```

**JavaScript Handler**: `handlePythonUpdate(payload, objectName)`

---

#### Message Type: `py2DmolNewObject`

**Sent By**: `new_obj()` in live mode

**Payload**:
```python
{
    "type": "py2DmolNewObject",
    "name": "object_name"
}
```

**JavaScript Handler**: `handlePythonNewObject(objectName)`

---

#### Message Type: `py2DmolClearAll`

**Sent By**: `clear()`

**Payload**:
```python
{
    "type": "py2DmolClearAll"
}
```

**JavaScript Handler**: `handlePythonClearAll()`

---

## Key Algorithms

### Kabsch Algorithm (Optimal Rotation)

**Problem**: Given two sets of 3D points A and B, find rotation R that minimizes:
```
RMSD = sqrt(mean((A @ R - B)^2))
```

**Solution** (Kabsch, 1976):

```
Input: Centered point clouds A_c, B_c (both Nx3)

1. Compute covariance matrix:
   H = A_c.T @ B_c   (3x3 matrix)

2. Singular Value Decomposition:
   U, Σ, V^T = SVD(H)
   where U: 3x3, Σ: 3x1 (singular values), V^T: 3x3

3. Handle reflection (determinant check):
   if det(U @ V^T) < 0:
       U[:, 2] = -U[:, 2]  (flip last column)
   endif

4. Optimal rotation:
   R = U @ V^T

5. Apply to original:
   A_aligned = (A - mean_A) @ R + mean_B
```

**Time Complexity**: O(n) for dot product, O(1) for SVD of 3x3 matrix

**Uses**:
- Kabsch function (Python & JavaScript)
- Best view computation
- Frame-to-frame alignment in animations

---

### Best-View Rotation

**Goal**: Orient structure for maximum visual appeal.

**Algorithm**:
```
1. Center structure: A_centered = A - mean(A)

2. Find principal axes:
   H = A_centered.T @ A_centered
   U, Σ, V^T = SVD(H)
   # V contains principal component directions

3. Rotate to align with axes:
   A_rotated = (A_centered @ V) + mean(A)
```

**Effect**: Positions structure so longest axis (highest variance) is horizontal

**Used For**: Initial frame orientation before playback

---

### Color Mapping: pLDDT

**Purpose**: Color atoms by confidence score (pLDDT: predicted Local Distance Test).

**Mapping** (AlphaFold convention):
```
pLDDT Range    Color      Confidence
─────────────────────────────────────
> 90           Blue       Very high
70 - 90        Cyan       High
50 - 70        Yellow     Medium
< 50           Red        Low
```

**Implementation**:
```javascript
function plddt_to_rgb(plddt) {
    if (plddt > 90) return rgb(0, 135, 255);      // Blue
    if (plddt > 70) return rgb(0, 255, 255);      // Cyan
    if (plddt > 50) return rgb(255, 255, 0);      // Yellow
    return rgb(255, 0, 0);                        // Red
}
```

**Gradient**: Linear interpolation between boundaries

---

### Color Mapping: Entropy (MSA-based)

**Purpose**: Color atoms by sequence variability.

**Algorithm**:
```
1. Compute MSA entropy at each position:
   H[i] = -Σ(p[i,a] * log2(p[i,a]))
   where p[i,a] = frequency of amino acid a at position i

2. Normalize to 0-1 range:
   entropy_norm[i] = (H[i] - min_H) / (max_H - min_H)

3. Map to color:
   Low entropy (conserved) → Blue (low variation)
   High entropy (variable) → Red (high variation)
```

**Used For**: Identifying variable regions in MSA

---

### PAE Matrix Compression

**Problem**: PAE matrices can be large (500x500 = 250k floats)

**Solution** (in Python `_get_data_dict()`):
```python
# Original: each value 0.0-31.0 (float)
# Compressed: scale to 0-255 (uint8)

scaled_pae = np.clip(np.round(pae * 8), 0, 255).astype(np.uint8)
# Now: flatten to 1D and store as list
flat_pae = scaled_pae.flatten().tolist()

# In JavaScript, reconstruct:
# size = sqrt(flat_pae.length)
# Reshape flat array back to 2D
# Unscale: divide by 8 to get original values
```

**Size Reduction**: ~75% (4 bytes per float → 1 byte per value)

---

## Function Call Graphs

### Major Operation: Loading a PDB File

```
from_pdb("1YNE")
├─ _get_filepath_from_pdb_id("1YNE")
│  └─ urllib.request.urlretrieve() [download]
├─ add_pdb("1YNE.cif")
│  ├─ gemmi.read_structure()
│  ├─ [if use_biounit]
│  │  ├─ gemmi.make_assembly()
│  │  └─ [fallback to models]
│  └─ For each model:
│     ├─ _parse_model()
│     │  └─ Extract coords, pLDDT, chains, types
│     └─ add(coords, plddts, ...)
│        ├─ _update(coords, ...)
│        │  ├─ [first frame]
│        │  │  └─ best_view(coords)
│        │  │     └─ kabsch()
│        │  └─ [subsequent frames]
│        │     └─ align_a_to_b(coords, self._coords)
│        │        └─ kabsch()
│        ├─ _get_data_dict()
│        │  └─ Serialize to JSON-compatible dict
│        └─ [if live]
│           └─ _send_message({"type": "py2DmolUpdate", ...})
│              └─ display(Javascript(...))
└─ [if not live] show()
   └─ _display_viewer(static_data=self.objects)
      ├─ JSON.dumps(objects)
      ├─ Template injection
      └─ display(HTML(...))
```

### Major Operation: File Upload (JavaScript)

```
handleFileUpload()
├─ [Detect file types]
├─ For .pdb/.cif files:
│  └─ processStructureToTempBatch(text, ...)
│     └─ [Parse coordinates]
│     └─ batchedObjects.push(frameData)
├─ [For .json PAE files]
│  └─ parseJSON()
│  └─ Store as pae data
├─ [For MSA files .a3m/.fasta/.sto]
│  └─ window.MSAViewer.loadMSA(text)
│     ├─ parseAlignment(text)
│     └─ computeMSAProperties()
└─ updateViewerFromGlobalBatch()
   ├─ For each batched object:
   │  └─ viewerApi.addObject(objData)
   ├─ updateChainSelectionUI()
   ├─ loadMSADataIntoViewer() [if MSA present]
   │  └─ computeMSAProperties()
   │  └─ matchMSAsToChains()
   └─ viewerApi.render()
```

### Major Operation: Color Mode Change

```
(User selects color mode dropdown)
│
colorSelect.addEventListener('change', ...)
│
├─ viewerApi.renderer.setColorMode(mode)
│  ├─ this.colorMode = mode
│  ├─ this.colors = null  [invalidate cache]
│  ├─ this.colorsNeedUpdate = true
│  └─ [different logic per mode]
│     ├─ [mode === "plddt"]
│     │  └─ _mapPLDDTToStructure()
│     ├─ [mode === "entropy"]
│     │  └─ _mapEntropyToStructure()
│     └─ [mode === "chain"]
│        └─ _mapChainToStructure()
│
└─ viewerApi.renderer.render()
   └─ 2D Canvas redraw with new colors
```

### Major Operation: MSA Filter Change

```
(User adjusts coverage/identity sliders)
│
coverageSlider.addEventListener('input', ...)
│
├─ getCurrentMSAFilters()
│  └─ Extract coverage and identity thresholds
│
├─ applyFiltersToAllMSAs(objectName, {coverageCutoff, identityCutoff})
│  └─ For each chain's MSA:
│     ├─ window.MSAViewer.applyFiltersToMSA()
│     │  └─ Filter sequences by coverage & identity
│     ├─ computeMSAProperties()
│     │  └─ Recompute entropy from filtered seqs
│     └─ Update renderer's entropy values
│
├─ refreshEntropyColors()
│  ├─ viewerApi.renderer._mapEntropyToStructure()
│  ├─ viewerApi.renderer.colorsNeedUpdate = true
│  └─ viewerApi.renderer.render()
│
└─ updateSequenceViewColors()
   └─ Refresh sequence display colors
```

---

## Data Structures & Message Protocol

### Python Internal Data Structure

#### Object Hierarchy

```python
self.objects = [
    {
        "name": "1YNE",
        "frames": [
            {
                "coords": [[x, y, z], ...],           # Nx3
                "plddts": [50, 60, ...],              # N-length
                "chains": ["A", "A", "B", ...],       # N-length
                "position_types": ["P", "P", "L", ...], # N-length
                "position_names": ["ALA", "GLY", ...], # N-length
                "residue_numbers": [1, 2, 3, ...],    # N-length
                "pae": [uint8, uint8, ...] or None,   # Flattened LxL
                "bonds": [[0, 1], [1, 2]],            # Bond definitions
                "color": {"type": "mode", "value": "plddt"} or None,
                "name": "frame_1" or None
            },
            { ... }  # Frame 2
        ],
        "contacts": [                                  # Optional
            [10, 50, 1.0],                             # [idx1, idx2, weight]
            ["A", 10, "B", 50, 0.5, {r:255, g:0, b:0}] # [chain1, res1, chain2, res2, weight, color]
        ] or None,
        "bonds": [...] or None,                        # Object-level bonds
        "color": {...} or None                         # Object-level color
    }
]
```

### Configuration Object (Python & JavaScript)

**Python Config** (viewer.py):
```python
config = {
    "size": (600, 600),              # Canvas size (tuple)
    "controls": True,                # Show UI controls
    "box": True,                     # Show bounding box
    "color": "auto",                 # Default color mode
    "colorblind": False,             # Colorblind palette
    "pastel": 0.25,                  # Pastel saturation (0.0-1.0)
    "shadow": True,                  # Enable shadows
    "depth": False,                  # Depth-based coloring
    "outline": "full",               # "none", "partial", "full" (string)
    "width": 3.0,                    # Line width (2.0-4.7)
    "ortho": 1.0,                    # Orthographic (0.0-1.0)
    "rotate": False,                 # Auto-rotate
    "autoplay": False,               # Auto-play animation
    "pae": False,                    # Show PAE matrix
    "pae_size": 300,                 # PAE plot size
    "overlay_frames": False,         # Overlay all frames
    "viewer_id": "uuid-string"       # Unique ID
}
```

**JavaScript Config** (app.js, initialized with UI defaults):
```javascript
window.viewerConfig = {
    size: [600, 600],                // Canvas size (array)
    pae_size: [300, 300],            // PAE plot size (array)
    color: "auto",
    shadow: true,
    outline: true,                   // Note: boolean in JS (overridden by renderer)
    width: 3.0,
    ortho: 1.0,
    rotate: false,
    controls: true,
    autoplay: false,
    box: true,
    pastel: 0.25,
    pae: true,
    colorblind: false,
    depth: false,
    viewer_id: "standalone-viewer-1",
    biounit: true,                   // UI-specific default
    ignoreLigands: false             // UI-specific default
}
```

**Note**: Python config uses `outline` as string ("full"/"partial"/"none"), while JavaScript initializes it as boolean. The renderer (viewer-mol.js) handles the conversion/override appropriately.

### Serialized Frame Format (JSON)

```json
{
  "coords": [[x, y, z], ...],
  "plddts": [50, 60, ...],
  "chains": ["A", "A", "B"],
  "position_types": ["P", "P", "L"],
  "position_names": ["ALA", "GLY", "UNK"],
  "residue_numbers": [1, 2, 1],
  "pae": [0, 1, 2, ...],
  "bonds": [[0, 1], [1, 2]],
  "color": {"type": "mode", "value": "plddt"},
  "name": "frame_0"
}
```

**Size Optimization**:
- Fields only included if present in data
- Coordinates rounded to 2 decimals
- pLDDT converted to integers
- PAE scaled to 0-255 (75% size reduction)
- Redundant fields removed (frame deduplication)

---

## Rendering Architecture: Pseudo3D Canvas

### 2D Canvas Rendering with Pseudo-3D Projection

The `Pseudo3DRenderer` class (in viewer-mol.js) implements 3D-like visualization on 2D canvas:

**Projection Pipeline**:
```
3D Coordinates (Nx3)
       ↓
Apply Rotation Matrix (3x3)
       ↓
Apply Translation (3-component)
       ↓
Perspective/Orthographic Projection
       ↓
Screen Coordinates (Nx2)
       ↓
Depth Sort (painter's algorithm)
       ↓
2D Canvas Drawing (lines, circles)
```

**Key Features**:
- **Rotation**: User mouse/touch input → rotation matrix → re-projection
- **Zoom**: Scale projection coordinates
- **Depth Sorting**: Sort atoms by z-coordinate, draw back-to-front
- **Bonds**: Lines between projected atom positions
- **Atoms**: Circles with radius proportional to z-distance (depth cueing)

**Canvas2SVG Export**:
- Custom `SimpleCanvas2SVG` class captures canvas drawing commands
- Converts to SVG paths for vector export
- Preserves all visual properties (colors, line widths, etc.)

### Performance Characteristics

- **Rendering**: O(n) where n = number of atoms
- **Frame Rate**: 60 FPS (requestAnimationFrame)
- **Interaction**: Immediate (no GPU wait time)
- **Export**: Scales to high resolutions without rasterization artifacts

---

## Troubleshooting & Debugging

### Common Issues

#### Issue: Viewer not updating in live mode
- Check: Is `_is_live` True? (call `show()` first)
- Check: JavaScript console for message handler errors
- Verify: Window ID matches in message and global store

#### Issue: PAE matrix not displaying
- Check: PAE data shape is LxL (square)
- Check: Values in range 0-31 (before scaling)
- Check: `pae=True` in view() constructor

#### Issue: Colors not matching across frames
- Check: Frame deduplication removing important fields
- Solution: Store color at object level if consistent

#### Issue: MSA entropy coloring inconsistent
- Check: MSA filter thresholds (coverage, identity)
- Check: computeMSAProperties() ran after filtering
- Solution: Call `refreshEntropyColors()` manually

#### Issue: Bonds not rendering correctly
- Check: Bond indices are 0-based and within coordinate count
- Check: Bond list is properly formatted [[idx1, idx2], ...]
- Verify: Bonds stored at object or frame level correctly

#### Issue: Outline mode inconsistent or not working
- **Background**: Python config uses string ("full"/"partial"/"none"), JavaScript initializes as boolean
- Check: Outline button cycles through modes correctly
- Check: viewer-mol.js is converting/overriding outline field appropriately
- Note: This is handled by the renderer and doesn't affect functionality

---

## Performance Considerations

### Memory Usage

| Component | Scale | Memory |
|-----------|-------|--------|
| Coordinates | 1000 atoms | ~24 KB (3 floats × 4 bytes × 1000) |
| Projected 2D | 1000 atoms | ~8 KB (2 floats × 4 bytes × 1000) |
| Colors | 1000 atoms | ~3 KB (RGB, 3 bytes × 1000) |
| pLDDT | 1000 atoms | ~4 KB (1 byte × 1000) |
| PAE matrix | 500×500 | ~250 KB (1 byte × 250k after compression) |
| MSA | 1000 sequences × 500 length | ~500 KB |
| Total (typical) | Protein + MSA | ~1-2 MB |

### Optimization Strategies

1. **Frame Deduplication** (Python)
   - Only serialize fields that changed
   - Store constants at object level

2. **PAE Compression** (Python)
   - Scale 0-31 → 0-255 (uint8)
   - Flatten to 1D array

3. **MSA Filtering** (JavaScript)
   - Only compute entropy for displayed sequences
   - Cache entropy values

4. **Rendering** (viewer-mol.js)
   - Cache projected 2D coordinates
   - Batch color updates (avoid recomputing per frame)
   - Depth-sort atoms for painter's algorithm

---

## Extension Points

### Adding New Color Modes

1. **Python**: Update `VALID_COLOR_MODES` and `_normalize_color()`
2. **JavaScript**: Add handler in `renderer.setColorMode()` (viewer-mol.js)
3. **Implementation**: Create `_mapModeToStructure()` function
4. **Mapping Logic**: Define color gradient or assignment rule

### Adding New Data Types

1. **Python**: Add field to frame dict via `_get_data_dict()`
2. **Serialization**: Handle in JSON encoding
3. **JavaScript**: Parse in `processStructureToTempBatch()`
4. **Rendering**: Use in `Pseudo3DRenderer.render()` (viewer-mol.js)

### Custom File Formats

1. **Python**: Add method `from_custom(filepath, ...)`
2. **Parsing**: Extract coordinates and metadata
3. **Normalization**: Convert to standard frame format
4. **Call**: `add()` with normalized data

---

## References

- **Kabsch, W.** (1976). "A solution for the best rotation to relate two sets of vectors." Acta Crystallographica A32, 922-923.
- **AlphaFold**: https://alphafold.ebi.ac.uk/
- **RCSB PDB**: https://www.rcsb.org/
- **numeric.js**: http://www.numericjs.org/
- **gemmi**: https://github.com/project-gemmi/gemmi

---

**Document Version**: 1.0
**Last Updated**: 2025-01-01
**Applies To**: py2Dmol-gamma (current)
