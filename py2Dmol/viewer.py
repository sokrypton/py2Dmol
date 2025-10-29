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
    def __init__(self, size=(500,500), color="rainbow", show_controls=True):
        self.size = size
        self.color = color
        self.show_controls = show_controls
        self._initial_data_loaded = False
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._trajectory_counter = 0

    def _serialize_data(self):
        """Serializes the current coordinate state to JSON."""
        payload = {
            "coords": self._coords.tolist() if self._coords is not None else [],
            "plddts": list(self._plddts) if self._plddts is not None else [],
            "chains": list(self._chains) if self._chains is not None else [],
            "atom_types": list(self._atom_types) if self._atom_types is not None else []
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
      if self._plddts is None: self._plddts = np.full(self._coords.shape[0], 50.0) # Default to 50
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
        """Clears all trajectories and resets the viewer state."""
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._trajectory_counter = 0
        if self._initial_data_loaded:
            js_code = "window.handlePythonClear();"
            if IS_COLAB:
                try:
                    output.eval_js(js_code, ignore_result=True)
                except Exception as e:
                    pass
            else:
                display(Javascript(js_code))

    def show(self):
        """Displays the viewer with the current data."""
        try:
            with importlib.resources.open_text(py2dmol_resources, 'pseudo_3D_viewer.html') as f:
                html_template = f.read()
        except FileNotFoundError:
            print("Error: Could not find the HTML template file.")
            return

        viewer_config = {
            "size": self.size,
            "color": self.color,
            "show_controls": self.show_controls
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
        final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
        display(HTML(final_html))

    def add(self, coords, plddts=None, chains=None, atom_types=None, new_traj=False, show=True):
        """Adds a new frame of data to the viewer."""
        if new_traj and self._initial_data_loaded:
            trajectory_name = f"{self._trajectory_counter}"
            self._trajectory_counter += 1
            js_code = f"window.handlePythonNewTrajectory('{trajectory_name}');"
            if IS_COLAB:
                try:
                    output.eval_js(js_code, ignore_result=True)
                except Exception as e:
                    pass
            else:
                display(Javascript(js_code))
            self._coords = None

        self._update(coords, plddts, chains, atom_types)

        if self._initial_data_loaded:
            json_data = self._serialize_data()
            js_code = f"window.handlePythonUpdate(`{json_data}`);"
            if IS_COLAB:
                try:
                    output.eval_js(js_code, ignore_result=True)
                except Exception as e:
                    pass
            else:
                display(Javascript(js_code))
        elif show:
            self.show()

    update_data = add

    def add_pdb(self, filepath, chains=None, new_traj=False, show=True):
        """Loads a structure from a PDB or CIF file and updates the viewer."""
        structure = gemmi.read_structure(filepath)

        first_model = True
        num_models = len(structure)
        for i, model in enumerate(structure):
            coords = []
            plddts = []
            atom_chains = []
            atom_types = []

            for chain in model:
                if chains is None or chain.name in chains:
                    for residue in chain:
                        if residue.name == 'HOH':
                            continue

                        residue_info = gemmi.find_tabulated_residue(residue.name)
                        is_protein = residue_info.is_amino_acid()
                        is_nucleic = residue_info.is_nucleic_acid()

                        if is_protein:
                            if 'CA' in residue:
                                atom = residue['CA'][0]
                                coords.append(atom.pos.tolist())
                                plddts.append(atom.b_iso)
                                atom_chains.append(chain.name)
                                atom_types.append('P')
                                
                        elif is_nucleic:
                            c4_atom = None
                            if "C4'" in residue:
                                c4_atom = residue["C4'"][0]
                            elif "C4*" in residue:
                                c4_atom = residue["C4*"][0]
                            
                            if c4_atom:
                                coords.append(c4_atom.pos.tolist())
                                plddts.append(c4_atom.b_iso)
                                atom_chains.append(chain.name)
                                
                                rna_bases = ['A', 'C', 'G', 'U', 'RA', 'RC', 'RG', 'RU']
                                dna_bases = ['DA', 'DC', 'DG', 'DT', 'T']
                                
                                if residue.name in rna_bases or residue.name.startswith('R'):
                                    atom_types.append('R')
                                elif residue.name in dna_bases or residue.name.startswith('D'):
                                    atom_types.append('D')
                                else:
                                    atom_types.append('R')
                                    
                        else:
                            for atom in residue:
                                if atom.element.name != 'H':
                                    coords.append(atom.pos.tolist())
                                    plddts.append(atom.b_iso)
                                    atom_chains.append(chain.name)
                                    atom_types.append('L')

            if coords:
                coords = np.array(coords)
                plddts = np.array(plddts)

                should_start_new_traj = new_traj and first_model

                show_this_frame = show and (i == num_models - 1)

                self.add(coords, plddts, atom_chains, atom_types,
                         new_traj=should_start_new_traj,
                         show=show_this_frame)

                first_model = False

    def from_pdb(self, filepath, chains=None, new_traj=True):
        self.add_pdb(filepath, chains, new_traj)