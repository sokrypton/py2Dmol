"""A Python library for visualizing protein structures in 2D."""

from __future__ import annotations

import importlib.resources
import json
import logging
import uuid

import gemmi
import numpy as np
from IPython.display import HTML, Javascript, display

try:
  from google.colab import output as colab_output  # pyright: ignore[reportMissingImports]

  IS_COLAB = True
except ImportError:
  colab_output = None
  IS_COLAB = False

from . import resources as py2dmol_resources

logger = logging.getLogger(__name__)


def kabsch(*, a: np.ndarray, b: np.ndarray, return_v: bool = False) -> np.ndarray:
  """Compute the optimal rotation matrix for aligning a to b.

  Args:
      a: The first set of coordinates.
      b: The second set of coordinates.
      return_v: Whether to return the v matrix.

  Returns:
      The optimal rotation matrix.

  """
  ab = a.swapaxes(-1, -2) @ b
  u, _, vh = np.linalg.svd(ab, full_matrices=False)
  flip = np.linalg.det(u @ vh) < 0
  flip_b = flip[..., None]
  u_last_col_flipped = np.where(flip_b, -u[..., -1], u[..., -1])
  u[..., -1] = u_last_col_flipped
  rotation_matrix = u @ vh
  return u if return_v else rotation_matrix


def align_a_to_b(a: np.ndarray, b: np.ndarray) -> np.ndarray:
  """Align coordinate set 'a' to 'b' using Kabsch algorithm.

  Args:
      a: The first set of coordinates.
      b: The second set of coordinates.

  Returns:
      The aligned coordinates.

  """
  a_mean = a.mean(-2, keepdims=True)
  a_cent = a - a_mean
  b_mean = b.mean(-2, keepdims=True)
  b_cent = b - b_mean
  rotation_matrix = kabsch(a=a_cent, b=b_cent)
  return (a_cent @ rotation_matrix) + b_mean


class View:
  """A class for visualizing protein structures in 2D."""

  def __init__(self, size: tuple[int, int] = (500, 500), color: str = "rainbow") -> None:
    """Initialize the viewer.

    Args:
        size: The size of the viewer.
        color: The color scheme to use.

    """
    self.size = size
    self.color = color
    self._initial_data_loaded = False
    self._coords: np.ndarray | None = None
    self._plddts: np.ndarray | None = None
    self._chains: list[str] | None = None
    self._atom_types: list[str] | None = None
    self._trajectory_counter = 0
    self._viewer_id = str(uuid.uuid4())  # Unique ID for this viewer instance

  def _get_data_dict(self) -> dict:
    """Serialize the current coordinate state to a dict.

    Returns:
        A dictionary containing the coordinate data.

    """
    if (
      self._coords is None
      or self._plddts is None
      or self._chains is None
      or self._atom_types is None
    ):
      return {"coords": [], "plddts": [], "chains": [], "atom_types": []}
    return {
      "coords": self._coords.tolist(),
      "plddts": self._plddts.tolist(),
      "chains": list(self._chains),
      "atom_types": list(self._atom_types),
    }

  def _update(
    self,
    coords: np.ndarray,
    plddts: np.ndarray | None = None,
    chains: list[str] | None = None,
    atom_types: list[str] | None = None,
  ) -> None:
    """Update the internal state with new data, aligning coords.

    Args:
        coords: The new coordinates.
        plddts: The new pLDDT scores.
        chains: The new chain identifiers.
        atom_types: The new atom types.

    """
    if self._coords is None:
      self._coords = coords
    else:
      self._coords = align_a_to_b(coords, self._coords)

    self._plddts = plddts if plddts is not None else np.full(self._coords.shape[0], 50.0)
    self._chains = chains if chains is not None else ["A"] * self._coords.shape[0]
    self._atom_types = atom_types if atom_types is not None else ["P"] * self._coords.shape[0]

    if len(self._plddts) != len(self._coords):
      logger.warning("pLDDT length mismatch. Resetting to default.")
      self._plddts = np.full(self._coords.shape[0], 50.0)
    if self._chains and len(self._chains) != len(self._coords):
      logger.warning("Chains length mismatch. Resetting to default.")
      self._chains = ["A"] * self._coords.shape[0]
    if self._atom_types and len(self._atom_types) != len(self._coords):
      logger.warning("Atom types length mismatch. Resetting to default.")
      self._atom_types = ["P"] * self._coords.shape[0]

  def _send_message(self, message_dict: dict) -> None:
    """Robustly send a message to the viewer, queuing if not ready.

    Args:
        message_dict: The message to send.

    """
    viewer_id = self._viewer_id
    message_json = json.dumps(message_dict)

    if IS_COLAB:
      self._send_colab_message(message_dict)
    else:
      self._send_jupyter_message(viewer_id, message_json)

  def _send_colab_message(self, message_dict: dict) -> None:
    """Send a message to the viewer in a Colab environment.

    Args:
        message_dict: The message to send.

    """
    js_code = ""
    if message_dict["type"] == "py2DmolUpdate":
      json_data = json.dumps(message_dict["payload"])
      json_data_escaped = json_data.replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$")
      js_code = f"window.handlePythonUpdate(`{json_data_escaped}`);"
    elif message_dict["type"] == "py2DmolNewTrajectory":
      js_code = f"window.handlePythonNewTrajectory('{message_dict['name']}');"
    elif message_dict["type"] == "py2DmolClearAll":
      js_code = "window.handlePythonClearAll();"

    if js_code and colab_output:
      try:
        colab_output.eval_js(js_code, ignore_result=True)
      except Exception:
        logger.exception("Error sending message to Colab")

  def _send_jupyter_message(self, viewer_id: str, message_json: str) -> None:
    """Send a message to the viewer in a Jupyter environment.

    Args:
        viewer_id: The ID of the viewer.
        message_json: The message to send, as a JSON string.

    """
    js_code = f"""
        (function() {{
            if (!window.py2dmol_queue) window.py2dmol_queue = {{}};
            if (!window.py2dmol_ready_flags) window.py2dmol_ready_flags = {{}};
            if (!window.py2dmol_queue['{viewer_id}']) {{
                window.py2dmol_queue['{viewer_id}'] = [];
            }}
            let msg = {message_json};
            if (window.py2dmol_ready_flags['{viewer_id}'] === true) {{
                let iframe = document.querySelector('iframe[data-viewer-id="{viewer_id}"]');
                if (iframe && iframe.contentWindow) {{
                    iframe.contentWindow.postMessage(msg, '*');
                }} else {{
                     console.error(
                        'py2Dmol: iframe {viewer_id} was ready but not found. Re-queuing.'
                     );
                     window.py2dmol_queue['{viewer_id}'].push(msg);
                }}
            }} else {{
                window.py2dmol_queue['{viewer_id}'].push(msg);
            }}
        }})();
        """
    display(Javascript(js_code))

  def _display_viewer(self) -> None:
    """Render the iframe and handshake script for the first time."""
    try:
      with importlib.resources.open_text(
        py2dmol_resources,
        "pseudo_3D_viewer.html",
      ) as f:
        html_template = f.read()
    except FileNotFoundError:
      logger.exception("Could not find the HTML template file.")
      return

    viewer_config = {
      "size": self.size,
      "color": self.color,
      "viewer_id": self._viewer_id,
    }
    config_script = f"""
        <script id="viewer-config">
          window.viewerConfig = {json.dumps(viewer_config)};
        </script>
        """
    data_script = """
        <script id="protein-data">
          window.proteinData = { "coords": [], "plddts": [], "chains": [], "atom_types": [] };
        </script>
        """
    injection_scripts = f"{config_script}\n{data_script}"

    if not IS_COLAB:
      self._display_jupyter_viewer(html_template, injection_scripts)
    else:
      self._display_colab_viewer(html_template, injection_scripts)

  def _display_jupyter_viewer(self, html_template: str, injection_scripts: str) -> None:
    """Display the viewer in a Jupyter environment.

    Args:
        html_template: The HTML template for the viewer.
        injection_scripts: The scripts to inject into the HTML.

    """
    final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
    final_html_escaped = final_html.replace('"', "&quot;").replace("'", "&#39;")
    handshake_script = f"""
        <script>
            if (!window.py2dmol_queue) window.py2dmol_queue = {{}};
            if (!window.py2dmol_ready_flags) window.py2dmol_ready_flags = {{}};
            if (!window.py2dmol_queue['{self._viewer_id}']) {{
                window.py2dmol_queue['{self._viewer_id}'] = [];
            }}
            window.py2dmol_ready_flags['{self._viewer_id}'] = false;
            if (!window.py2dmol_message_listener_added) {{
                window.addEventListener('message', (event) => {{
                    if (
                        event.data &&
                        event.data.type === 'py2dmol_ready' &&
                        event.data.viewer_id
                    ) {{
                        let viewerId = event.data.viewer_id;
                        window.py2dmol_ready_flags[viewerId] = true;
                        let iframe = document.querySelector(
                            `iframe[data-viewer-id="${{viewerId}}"]`
                        );
                        if (!iframe || !iframe.contentWindow) {{
                            console.error(
                                `py2Dmol: Received ready signal from ${{viewerId}} ` +
                                `but cannot find iframe.`
                            );
                            return;
                        }}
                        let queue = window.py2dmol_queue[viewerId];
                        if (queue) {{
                            while (queue.length > 0) {{
                                let msg = queue.shift();
                                iframe.contentWindow.postMessage(msg, '*');
                            }}
                        }}
                    }}
                }});
                window.py2dmol_message_listener_added = true;
            }}
        </script>
        """
    iframe_html = f"""
        <iframe
            data-viewer-id="{self._viewer_id}"
            srcdoc="{final_html_escaped}"
            style="width: {self.size[0] + 200}px; height: {self.size[1] + 80}px; border: none;"
            sandbox="allow-scripts allow-same-origin"
        ></iframe>
        {handshake_script}
        """
    display(HTML(iframe_html))

  def _display_colab_viewer(self, html_template: str, injection_scripts: str) -> None:
    """Display the viewer in a Colab environment.

    Args:
        html_template: The HTML template for the viewer.
        injection_scripts: The scripts to inject into the HTML.

    """
    final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
    display(HTML(final_html))

  def clear(self) -> None:
    """Clear all trajectories and frames from the viewer."""
    if self._initial_data_loaded:
      self._send_message(
        {
          "type": "py2DmolClearAll",
        },
      )
    self._initial_data_loaded = False
    self._coords = None
    self._plddts = None
    self._chains = None
    self._atom_types = None
    self._trajectory_counter = 0

  def add(
    self,
    coords: np.ndarray,
    plddts: np.ndarray | None = None,
    chains: list[str] | None = None,
    atom_types: list[str] | None = None,
    *,
    new_traj: bool = False,
  ) -> None:
    """Add a new frame of data to the viewer.

    If this is the first time 'add' is called, it will display the viewer.

    Args:
        coords: Nx3 array of coordinates.
        plddts: N-length array of pLDDT scores.
        chains: N-length list of chain identifiers.
        atom_types: N-length list of atom types ('P', 'D', 'R', 'L').
        new_traj: If True, starts a new trajectory. Defaults to False.

    """
    if not self._initial_data_loaded:
      self._display_viewer()
      self._initial_data_loaded = True
      new_traj = True

    if new_traj:
      self._coords = None
      trajectory_name = f"{self._trajectory_counter}"
      self._trajectory_counter += 1
      self._send_message(
        {
          "type": "py2DmolNewTrajectory",
          "name": trajectory_name,
        },
      )
    self._update(coords, plddts, chains, atom_types)
    self._send_message(
      {
        "type": "py2DmolUpdate",
        "payload": self._get_data_dict(),
      },
    )

  def _process_residue(
    self,
    residue: gemmi.Residue,
    chain_name: str,
  ) -> dict | list[dict] | None:
    """Process a single residue and extract its data.

    Args:
        residue: The residue to process.
        chain_name: The name of the chain the residue belongs to.

    Returns:
        A dictionary or list of dictionaries containing the residue's data,
        or None if the residue should be skipped.

    """
    if residue.name == "HOH":
      return None

    residue_info = gemmi.find_tabulated_residue(residue.name)
    if residue_info.is_amino_acid():
      return self._process_protein_residue(residue, chain_name)
    if residue_info.is_nucleic_acid():
      return self._process_nucleic_residue(residue, chain_name)
    return self._process_ligand_residue(residue, chain_name)

  def _process_protein_residue(
    self,
    residue: gemmi.Residue,
    chain_name: str,
  ) -> dict | None:
    """Process a protein residue.

    Args:
        residue: The residue to process.
        chain_name: The name of the chain the residue belongs to.

    Returns:
        A dictionary containing the residue's data, or None if the residue should be skipped.

    """
    if "CA" in residue:
      atom = residue["CA"][0]
      return {
        "coord": atom.pos.tolist(),
        "plddt": atom.b_iso,
        "chain": chain_name,
        "atom_type": "P",
      }
    return None

  def _process_nucleic_residue(
    self,
    residue: gemmi.Residue,
    chain_name: str,
  ) -> dict | None:
    """Process a nucleic acid residue.

    Args:
        residue: The residue to process.
        chain_name: The name of the chain the residue belongs to.

    Returns:
        A dictionary containing the residue's data, or None if the residue should be skipped.

    """
    c4_atom = None
    if "C4'" in residue:
      c4_atom = residue["C4'"][0]
    elif "C4*" in residue:
      c4_atom = residue["C4*"][0]

    if c4_atom:
      rna_bases = ["A", "C", "G", "U", "RA", "RC", "RG", "RU"]
      dna_bases = ["DA", "DC", "DG", "DT", "T"]

      atom_type = "R"
      if residue.name in rna_bases or residue.name.startswith("R"):
        atom_type = "R"
      elif residue.name in dna_bases or residue.name.startswith("D"):
        atom_type = "D"

      return {
        "coord": c4_atom.pos.tolist(),
        "plddt": c4_atom.b_iso,
        "chain": chain_name,
        "atom_type": atom_type,
      }
    return None

  def _process_ligand_residue(
    self,
    residue: gemmi.Residue,
    chain_name: str,
  ) -> list[dict]:
    """Process a ligand residue.

    Args:
        residue: The residue to process.
        chain_name: The name of the chain the residue belongs to.

    Returns:
        A list of dictionaries containing the residue's data.

    """
    return [
      {
        "coord": atom.pos.tolist(),
        "plddt": atom.b_iso,
        "chain": chain_name,
        "atom_type": "L",
      }
      for atom in residue
      if atom.element.name != "H"
    ]

  def add_pdb(
    self,
    filepath: str,
    chains: list[str] | None = None,
    *,
    new_traj: bool = False,
  ) -> None:
    """Load a structure from a PDB or CIF file and add it to the viewer.

    Multi-model files are added as a single trajectory.

    Args:
        filepath: Path to the PDB or CIF file.
        chains: Specific chains to load. Defaults to all.
        new_traj: If True, starts a new trajectory. Defaults to False.

    """
    structure = gemmi.read_structure(filepath)
    first_model_added = False
    for model in structure:
      coords, plddts, atom_chains, atom_types = [], [], [], []
      for chain in model:
        if chains is None or chain.name in chains:
          for residue in chain:
            residue_data = self._process_residue(residue, chain.name)
            if residue_data:
              if isinstance(residue_data, list):
                for atom_data in residue_data:
                  coords.append(atom_data["coord"])
                  plddts.append(atom_data["plddt"])
                  atom_chains.append(atom_data["chain"])
                  atom_types.append(atom_data["atom_type"])
              else:
                coords.append(residue_data["coord"])
                plddts.append(residue_data["plddt"])
                atom_chains.append(residue_data["chain"])
                atom_types.append(residue_data["atom_type"])

      if coords:
        coords_arr = np.array(coords)
        plddts_arr = np.array(plddts)
        current_model_new_traj = new_traj and not first_model_added
        self.add(
          coords_arr,
          plddts_arr,
          atom_chains,
          atom_types,
          new_traj=current_model_new_traj,
        )
        first_model_added = True

  def from_pdb(
    self,
    filepath: str,
    chains: list[str] | None = None,
    *,
    new_traj: bool = True,
  ) -> None:
    """Load a structure from a PDB or CIF file and start a new trajectory.

    This is a convenience wrapper for add_pdb(..., new_traj=True).

    Args:
        filepath: Path to the PDB or CIF file.
        chains: Specific chains to load. Defaults to all.
        new_traj: If True, starts a new trajectory. Defaults to True.

    """
    self.add_pdb(filepath, chains=chains, new_traj=new_traj)
