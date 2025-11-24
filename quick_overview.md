# py2Dmol Quick Overview (AI Context)

## 📂 Key Files & Structure
- `py2Dmol/`
  - `viewer.py`: **Python Interface**. Manages `view` class, serializes data, generates HTML.
  - `resources/`
    - `viewer-mol.js`: **CORE RENDERER**. Contains `Pseudo3DRenderer` class. Shared by both interfaces.
    - `viewer.html`: HTML template for Jupyter widget injection.
    - `viewer-pae.js`: PAE matrix visualization.
    - `viewer-seq.js`: Sequence viewer logic.
    - `viewer-msa.js`: MSA viewer logic.
- `web/`
  - `app.js`: **Web App Logic**. Handles UI events, file loading, and global state.
  - `utils.js`: **Utilities**. Parsing (PDB/CIF), alignment (Kabsch), and geometry functions.
  - `index.html`: Main 3D viewer entry point.
  - `msa.html`: Standalone MSA viewer entry point.

## 🔌 Interfaces

### 1. Python Package (Jupyter/Colab)
- **Entry Point**: `py2Dmol.view()`
- **Mechanism**: Generates HTML that embeds `viewer-mol.js`. Injects into notebook cell.
- **Data Flow**:
  - **Static**: Data embedded directly into HTML `window.py2dmol_staticData` at render time.
  - **Live**: Updates sent via `google.colab.output` or `Jupyter.notebook.kernel.execute` to `window.py2dmol_viewers`.
- **Key Class**: `view` (manages `self.objects` list, each containing `frames`).

### 2. Standalone Web App
- **Entry Point**: `web/index.html`
- **Mechanism**: Browser loads `index.html`, which initializes `app.js` and `viewer-mol.js`.
- **Data Flow**: Files (PDB/CIF/JSON) loaded via File API or fetched from URL. Parsed in `app.js` -> sent to `viewer-mol.js`.
- **State**: Managed via global `window.viewerConfig` and `window.py2dmol_viewers`.

## 🧠 Core Concepts

### Data Model
- **Object**: Represents a distinct molecular entity (e.g., "1YNE"). Contains a list of **Frames**.
- **Frame**: Represents a single state (coordinates, pLDDT, metadata) at a specific timepoint.
- **Renderer**: `Pseudo3DRenderer` (in `viewer-mol.js`). Handles 3D projection, depth sorting, shadows, and canvas drawing.

### Color Hierarchy (Priority: High -> Low)
1. **Position**: Per-atom override (e.g., specific residue color).
2. **Chain**: Per-chain override.
3. **Frame**: Defined in `add(..., color=...)`.
4. **Object**: Defined via `set_color(...)` or `py2DmolSetObjectColor`.
5. **Global**: Default set in `view(color=...)`.

### Message Protocol (Python -> JS)
- `py2DmolUpdate`: Add or update frame data (geometry, metadata).
- `py2DmolNewObject`: Create a new empty object container.
- `py2DmolSetColor`: Update global or object-level color settings.
- `py2DmolSetObjectColor`: Specific object color update.
- `py2DmolSetViewTransform`: Update camera rotation and center.
- `py2DmolClearAll`: Remove all objects.
