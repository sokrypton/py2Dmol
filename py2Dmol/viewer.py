import json
import numpy as np
try:
    from google.colab import output
    IS_COLAB = True
except ImportError:
    IS_COLAB = False
from IPython.display import display, HTML, Javascript
import importlib.resources
from . import resources as py2dmol_resources
import gemmi
import uuid

def kabsch(a, b, return_v=False):
  """Computes the optimal rotation matrix for aligning a to b."""
  ab = a.swapaxes(-1, -2) @ b
  u, s, vh = np.linalg.svd(ab, full_matrices=False)
  flip = np.linalg.det(u @ vh) < 0
  flip_b = flip[..., None]
  u_last_col_flipped = np.where(flip_b, -u[..., -1], u[..., -1])
  u[..., -1] = u_last_col_flipped
  R = u @ vh
  return u if return_v else R

def align_a_to_b(a, b):
  """Aligns coordinate set 'a' to 'b' using Kabsch algorithm."""
  a_mean = a.mean(-2, keepdims=True)
  a_cent = a - a_mean
  b_mean = b.mean(-2, keepdims=True)
  b_cent = b - b_mean
  R = kabsch(a_cent, b_cent)
  a_aligned = (a_cent @ R) + b_mean
  return a_aligned

# --- view Class ---

class view:
    def __init__(self, size=(500,500), color="rainbow"):
        self.size = size
        self.color = color
        self._initial_data_loaded = False
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._trajectory_counter = 0
        self._viewer_id = str(uuid.uuid4())  # Unique ID for this viewer instance

    def _serialize_data(self):
        """Serializes the current coordinate state to JSON."""
        payload = {
            "coords": self._coords.tolist(),
            "plddts": self._plddts.tolist(),
            "chains": list(self._chains),
            "atom_types": list(self._atom_types)
        }
        return json.dumps(payload)

    def _update(self, coords, plddts=None, chains=None, atom_types=None):
      """Updates the internal state with new data, aligning coords."""
      if self._coords is None:
        self._coords = coords
      else:
        # Align new coords to old coords
        # This prevents the structure from "jumping" if the center moves
        self._coords = align_a_to_b(coords, self._coords)

      # Set defaults if not provided
      if self._plddts is None: self._plddts = np.full(self._coords.shape[0], 50.0)
      if self._chains is None: self._chains = ["A"] * self._coords.shape[0]
      if self._atom_types is None: self._atom_types = ["P"] * self._coords.shape[0]

      # Update with new data if provided
      if plddts is not None: self._plddts = plddts
      if chains is not None: self._chains = chains
      if atom_types is not None: self._atom_types = atom_types

      # Ensure all arrays have the same length as coords
      if len(self._plddts) != len(self._coords):
          print(f"Warning: pLDDT length mismatch. Resetting to default.")
          self._plddts = np.full(self._coords.shape[0], 50.0)
      if len(self._chains) != len(self._coords):
          print(f"Warning: Chains length mismatch. Resetting to default.")
          self._chains = ["A"] * self._coords.shape[0]
      if len(self._atom_types) != len(self._coords):
          print(f"Warning: Atom types length mismatch. Resetting to default.")
          self._atom_types = ["P"] * self._coords.shape[0]

    def clear(self):
        """Clears the Python state and tells the JS viewer to start a new trajectory."""
        trajectory_name = f"{self._trajectory_counter}"
        self._trajectory_counter += 1

        # Clear Python-side coordinates
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None

        # Tell JS to create and switch to this new trajectory
        if self._initial_data_loaded:
            js_code = f"""
            (function() {{
                var iframe = document.querySelector('iframe[data-viewer-id="{self._viewer_id}"]');
                if (iframe && iframe.contentWindow && iframe.contentWindow.handlePythonNewTrajectory) {{
                    iframe.contentWindow.handlePythonNewTrajectory('{trajectory_name}');
                }}
            }})();
            """
            if IS_COLAB:
                try:
                    output.eval_js(js_code, ignore_result=True)
                except Exception as e:
                    print(f"Error clearing in Colab: {e}")
            else:
                display(Javascript(js_code))

    def display(self, initial_coords, initial_plddts=None, initial_chains=None, initial_atom_types=None):
        """Displays the viewer with initial data."""
        self._update(initial_coords, initial_plddts, initial_chains, initial_atom_types)

        try:
            with importlib.resources.open_text(py2dmol_resources, 'pseudo_3D_viewer.html') as f:
                html_template = f.read()
        except FileNotFoundError:
            print("Error: Could not find the HTML template file.")
            return

        viewer_config = {
            "size": self.size,
            "color": self.color,
            "viewer_id": self._viewer_id
        }
        config_script = f"""
        <script id="viewer-config">
          window.viewerConfig = {json.dumps(viewer_config)};
        </script>
        """
        data_script = f"""
        <script id="protein-data">
          window.proteinData = {self._serialize_data()};
        </script>
        """
        self._initial_data_loaded = True

        injection_scripts = config_script + "\n" + data_script
        
        # Wrap the HTML in an iframe with a unique ID for Jupyter compatibility
        if not IS_COLAB:
            # For Jupyter: wrap in iframe with srcdoc
            final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
            # Escape for srcdoc attribute
            final_html_escaped = final_html.replace('"', '&quot;').replace("'", '&#39;')
            iframe_html = f"""
            <iframe 
                data-viewer-id="{self._viewer_id}"
                srcdoc="{final_html_escaped}"
                style="width: {self.size[0] + 20}px; height: {self.size[1] + 80}px; border: none;"
                sandbox="allow-scripts allow-same-origin"
            ></iframe>
            """
            display(HTML(iframe_html))
        else:
            # For Colab: use direct HTML
            final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
            display(HTML(final_html))

    def add(self, coords, plddts=None, chains=None, atom_types=None):
        """Sends a new frame of data to the JavaScript viewer."""
        if self._initial_data_loaded:
            self._update(coords, plddts, chains, atom_types)
            json_data = self._serialize_data()
            
            # Escape the JSON data properly for JavaScript
            json_data_escaped = json_data.replace('\\', '\\\\').replace('`', '\\`').replace('$', '\\$')
            
            if IS_COLAB:
                js_code = f"window.handlePythonUpdate(`{json_data_escaped}`);"
                try:
                    output.eval_js(js_code, ignore_result=True)
                except Exception as e:
                    print(f"Error in add (Colab): {e}")
            else:
                # For Jupyter: target the specific iframe
                js_code = f"""
                (function() {{
                    var iframe = document.querySelector('iframe[data-viewer-id="{self._viewer_id}"]');
                    if (iframe && iframe.contentWindow) {{
                        if (iframe.contentWindow.handlePythonUpdate) {{
                            iframe.contentWindow.handlePythonUpdate(`{json_data_escaped}`);
                        }} else {{
                            console.error('handlePythonUpdate not found in iframe. Viewer may not be fully loaded.');
                        }}
                    }} else {{
                        console.error('Viewer iframe not found with ID: {self._viewer_id}');
                    }}
                }})();
                """
                display(Javascript(js_code))
        else:
            # If display() was never called, call it now
            self.display(coords, plddts, chains, atom_types)

    update_data = add

    def from_pdb(self, filepath, chains=None):
        """Loads a structure from a PDB or CIF file and updates the viewer.
        
        Now supports:
        - Proteins (CA atoms, type 'P')
        - DNA (C4' atoms, type 'D')
        - RNA (C4' atoms, type 'R')
        - Ligands (all heavy atoms, type 'L')
        """
        structure = gemmi.read_structure(filepath)
        self.clear()

        for model in structure:
            coords = []
            plddts = []
            atom_chains = []
            atom_types = []

            for chain in model:
                if chains is None or chain.name in chains:
                    for residue in chain:
                        # Skip water
                        if residue.name == 'HOH':
                            continue

                        # Check molecule type
                        residue_info = gemmi.find_tabulated_residue(residue.name)
                        is_protein = residue_info.is_amino_acid()
                        is_nucleic = residue_info.is_nucleic_acid()

                        if is_protein:
                            # Protein: use CA atom
                            if 'CA' in residue:
                                atom = residue['CA'][0]
                                coords.append(atom.pos.tolist())
                                plddts.append(atom.b_iso)
                                atom_chains.append(chain.name)
                                atom_types.append('P')
                                
                        elif is_nucleic:
                            # DNA/RNA: use C4' atom (sugar carbon)
                            c4_atom = None
                            
                            # Try C4' first (standard naming)
                            if "C4'" in residue:
                                c4_atom = residue["C4'"][0]
                            # Try C4* (alternative naming in some PDB files)
                            elif "C4*" in residue:
                                c4_atom = residue["C4*"][0]
                            
                            if c4_atom:
                                coords.append(c4_atom.pos.tolist())
                                plddts.append(c4_atom.b_iso)
                                atom_chains.append(chain.name)
                                
                                # Distinguish RNA from DNA
                                rna_bases = ['A', 'C', 'G', 'U', 'RA', 'RC', 'RG', 'RU']
                                dna_bases = ['DA', 'DC', 'DG', 'DT', 'T']
                                
                                if residue.name in rna_bases or residue.name.startswith('R'):
                                    atom_types.append('R')
                                elif residue.name in dna_bases or residue.name.startswith('D'):
                                    atom_types.append('D')
                                else:
                                    # Default to RNA if uncertain
                                    atom_types.append('R')
                                    
                        else:
                            # Ligand: use all heavy atoms
                            for atom in residue:
                                if atom.element.name != 'H':
                                    coords.append(atom.pos.tolist())
                                    plddts.append(atom.b_iso)
                                    atom_chains.append(chain.name)
                                    atom_types.append('L')

            if coords:
                coords = np.array(coords)
                plddts = np.array(plddts)
                if self._initial_data_loaded:
                    self.add(coords, plddts, atom_chains, atom_types)
                else:
                    self.display(coords, plddts, atom_chains, atom_types)