import json
import numpy as np
try:
    from google.colab import output
    IS_COLAB = True
except ImportError:
    IS_COLAB = False
from IPython.display import display, HTML, Javascript
import importlib.resources

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

# --- py2Dmol Class ---

class py2Dmol:
    def __init__(self, size=(500,500), color="plddt"):
        self.size = size
        self.color = color
        self._initial_data_loaded = False
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._trajectory_counter = 0 # NEW: Counter for trials

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
        """MODIFIED: Clears the Python state and tells the JS viewer to start a new trajectory."""
        # Generate a name for the new trajectory
        trajectory_name = f"{self._trajectory_counter}"
        self._trajectory_counter += 1

        # Clear Python-side coordinates
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None

        # NEW: Tell JS to create and switch to this new trajectory
        if self._initial_data_loaded:
            js_code = f"window.handlePythonNewTrajectory('{trajectory_name}');"
            if IS_COLAB:
                try:
                    output.eval_js(js_code, ignore_result=True)
                except Exception as e:
                    pass
            else:
                display(Javascript(js_code))

    def display(self, initial_coords, initial_plddts=None, initial_chains=None, initial_atom_types=None):
        """Displays the viewer with initial data."""
        self._update(initial_coords, initial_plddts, initial_chains, initial_atom_types)

        try:
            with importlib.resources.open_text('py2Dmol.resources', 'pseudo_3D_viewer.html') as f:
                html_template = f.read()
        except FileNotFoundError:
            print("Error: Could not find the HTML template file.")
            return

        viewer_config = {
            "size": self.size,
            "color": self.color
        }
        config_script = f"""
        <script id="viewer-config">
          window.viewerConfig = {json.dumps(viewer_config)};
        </script>
        """
        # The data script now provides the *first frame* for the "Initial" trajectory
        data_script = f"""
        <script id="protein-data">
          window.proteinData = {self._serialize_data()};
        </script>
        """
        self._initial_data_loaded = True

        injection_scripts = config_script + "\n" + data_script
        final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
        display(HTML(final_html))

    def update_data(self, coords, plddts=None, chains=None, atom_types=None):
      """Sends a new frame of data to the JavaScript viewer."""
      if self._initial_data_loaded:
        self._update(coords, plddts, chains, atom_types)
        json_data = self._serialize_data()
        js_code = f"window.handlePythonUpdate(`{json_data}`);"
        if IS_COLAB:
            output.eval_js(js_code, ignore_result=True)
        else:
            display(Javascript(js_code))
      else:
        # If display() was never called, call it now
        self.display(coords, plddts, chains, atom_types)
