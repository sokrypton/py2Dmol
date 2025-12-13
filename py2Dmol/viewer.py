"""
py2Dmol/viewer.py
-----------------
AI Context: MAIN PYTHON INTERFACE
- Defines the `view` class, the primary entry point for Python users.
- Manages the internal list of objects and frames.
- Handles serialization of data to JSON for the frontend.
- Generates HTML/JS for embedding in Jupyter/Colab.
- Implements the "Live Mode" communication bridge (Python -> JS).
"""
import json
import copy
import numpy as np
import re
from IPython.display import display, HTML, Javascript, update_display
    
# ============================================================================
# CONFIG DEFAULTS - Single source of truth
# ============================================================================

DEFAULT_CONFIG = {
    "display": {
        "size": [400, 400],
        "rotate": False,
        "autoplay": False,
        "controls": True,
        "box": True
    },
    "rendering": {
        "shadow": True,
        "shadow_strength": 0.5,
        "outline": "full",
        "width": 3.0,
        "ortho": 1.0,
        "detect_cyclic": True
    },
    "color": {
        "mode": "auto",
        "colorblind": False
    },
    "pae": {
        "enabled": False,
        "size": 300
    },
    "scatter": {
        "enabled": False,
        "size": 300
    },
    "overlay": {
        "enabled": False
    }
}


def _nest_config(**flat):
    """Convert flat kwargs to nested config."""
    config = json.loads(json.dumps(DEFAULT_CONFIG))  # Deep copy
    
    # Display
    if "size" in flat: config["display"]["size"] = flat["size"]
    if "rotate" in flat: config["display"]["rotate"] = flat["rotate"]
    if "autoplay" in flat: config["display"]["autoplay"] = flat["autoplay"]
    if "controls" in flat: config["display"]["controls"] = flat["controls"]
    if "box" in flat: config["display"]["box"] = flat["box"]
    
    # Rendering
    if "shadow" in flat: config["rendering"]["shadow"] = flat["shadow"]
    if "shadow_strength" in flat: config["rendering"]["shadow_strength"] = flat["shadow_strength"]
    if "outline" in flat: config["rendering"]["outline"] = flat["outline"]
    if "width" in flat: config["rendering"]["width"] = flat["width"]
    if "ortho" in flat: config["rendering"]["ortho"] = flat["ortho"]
    if "detect_cyclic" in flat: config["rendering"]["detect_cyclic"] = flat["detect_cyclic"]

    # Color
    if "color" in flat: config["color"]["mode"] = flat["color"]
    if "colorblind" in flat: config["color"]["colorblind"] = flat["colorblind"]
    
    # PAE
    if "pae" in flat: config["pae"]["enabled"] = flat["pae"]
    if "pae_size" in flat: config["pae"]["size"] = flat["pae_size"]

    # Scatter
    if "scatter" in flat:
        if isinstance(flat["scatter"], dict):
            config["scatter"] = {
                "enabled": flat["scatter"].get("enabled", True),
                "size": flat["scatter"].get("size", 300)
            }
        elif flat["scatter"] is True:
            config["scatter"]["enabled"] = True
        elif flat["scatter"] is False:
            config["scatter"]["enabled"] = False
    if "scatter_size" in flat: config["scatter"]["size"] = flat["scatter_size"]

    # Overlay
    if "overlay" in flat: config["overlay"]["enabled"] = flat["overlay"]

    return config
    
import importlib.resources
from . import resources as py2dmol_resources
import gemmi
import uuid
import os
import urllib.request


def best_view(coords):
  """Compute optimal viewing rotation matrix and center.

  Matches web interface behavior: computes principal axes and tries different
  orientations to maximize screen usage (assumes square/landscape display).

  Returns:
      (rotation_matrix, center):
        - rotation_matrix: 3x3 numpy array
        - center: [x, y, z] mean of coordinates
  """
  center = coords.mean(axis=0)
  centered = coords - center

  # Compute covariance matrix
  H = centered.T @ centered

  # SVD to get eigenvectors
  U, S, Vh = np.linalg.svd(H)

  # Extract eigenvectors (columns of U)
  # U[:,0] = largest variance, U[:,1] = second, U[:,2] = smallest
  v1 = U[:, 0]  # Largest variance
  v2 = U[:, 1]  # Second largest
  v3 = U[:, 2]  # Smallest

  # Try different orientations and pick the best one
  # We try 8 sign combinations × 2 mappings = 16 candidates
  # Select based on projected variance in screen space

  best_variance_ratio = -1
  best_rotation = np.eye(3)

  # Try both mappings: (e1->x, e2->y) and (e2->x, e1->y)
  for mapping in ['e1_x', 'e2_x']:
    # Try all 8 sign combinations
    for s1 in [1, -1]:
      for s2 in [1, -1]:
        for s3 in [1, -1]:
          # Apply signs
          e1 = v1 * s1
          e2 = v2 * s2
          e3 = v3 * s3

          # Apply mapping
          if mapping == 'e1_x':
            r0 = e1  # X-axis
            r1 = e2  # Y-axis
          else:
            r0 = e2  # X-axis
            r1 = e1  # Y-axis

          # Normalize
          r0 = r0 / np.linalg.norm(r0)
          r1 = r1 / np.linalg.norm(r1)

          # Orthogonalize r1 with respect to r0
          r1 = r1 - np.dot(r1, r0) * r0
          r1_norm = np.linalg.norm(r1)
          if r1_norm < 1e-10:
            continue
          r1 = r1 / r1_norm

          # Z-axis from cross product (right-handed)
          r2 = np.cross(r0, r1)

          # Construct rotation matrix
          R = np.array([r0, r1, r2])

          # Calculate projected variance in screen space
          rotated = centered @ R.T
          var_x = np.var(rotated[:, 0])
          var_y = np.var(rotated[:, 1])
          var_ratio = max(var_x, var_y) / (min(var_x, var_y) + 1e-10)

          # Prefer orientations that use screen space well
          if var_ratio > best_variance_ratio:
            best_variance_ratio = var_ratio
            best_rotation = R

  return best_rotation, center

def kabsch(a, b):
    """Calculates the optimal rotation matrix for aligning a to b."""
    ab = a.T @ b
    u, s, vh = np.linalg.svd(ab, full_matrices=False)
    flip = np.linalg.det(u @ vh) < 0
    if flip.any():
        u[..., -1] = np.where(flip[..., None], -u[..., -1], u[..., -1])
    return u @ vh  # Return the full rotation matrix

def align_a_to_b(a, b):
    """Aligns coordinate set 'a' to 'b' using Kabsch algorithm."""
    a_mean = a.mean(axis=-2, keepdims=True)
    a_cent = a - a_mean
    b_mean = b.mean(axis=-2, keepdims=True)
    b_cent = b - b_mean
    R = kabsch(a_cent, b_cent)
    a_aligned = (a_cent @ R) + b_mean
    return a_aligned

# --- Color System Constants ---

VALID_COLOR_MODES = {"chain", "plddt", "rainbow", "auto", "entropy", "deepmind"}
"""Valid color modes for protein visualization."""

# --- Color Utilities ---

def _normalize_color(color):
    """
    Normalize a color input to standard format.

    Args:
        color: Can be:
            - None: No color specified
            - String (mode): "chain", "plddt", "rainbow", "auto", "entropy", "deepmind"
            - String (literal): "red", "#ff0000", etc.
            - Dict (advanced): {
                "chain": {"A": "red", "B": "#ff0000"},  # Chain-level (simplest)
                "position": {0: "blue", 5: "red"},     # Position-level
                "frame": "plddt",                      # Frame-level
                "object": "chain"                      # Object-level
              }

    Returns:
        Normalized color dict or None:
        - If string: {type: "mode"/"literal", value: string}
        - If dict: {type: "advanced", value: dict}
        - If None: None
    """
    if color is None:
        return None

    if isinstance(color, dict):
        # Check if already normalized (has "type" and "value" keys)
        if "type" in color and "value" in color:
            return color

        # Check if it's an advanced format dict (has chain/position/frame/object keys)
        advanced_keys = {"chain", "position", "frame", "object"}
        if any(key in color for key in advanced_keys):
            return {"type": "advanced", "value": color}

        # Otherwise, treat as advanced format anyway
        return {"type": "advanced", "value": color}

    # Handle string format
    color_str = str(color).lower()
    if color_str in VALID_COLOR_MODES:
        return {"type": "mode", "value": color_str}
    else:
        return {"type": "literal", "value": color}

# --- view Class ---

class view:
    def __init__(self, size=(400,400), controls=True, box=True,
        color="auto", colorblind=False, shadow=True, shadow_strength=0.5,
        outline="full", width=3.0, ortho=1.0, rotate=False, autoplay=False,
        pae=False, pae_size=300, scatter=None, scatter_size=300, overlay=False, detect_cyclic=True, id=None,
    ):
        # Normalize pae_size: if tuple/list, use first value; otherwise use as-is
        if isinstance(pae_size, (tuple, list)) and len(pae_size) > 0:
            pae_size = int(pae_size[0])
        else:
            pae_size = int(pae_size)

        # Normalize scatter_size: if tuple/list, use first value; otherwise use as-is
        if isinstance(scatter_size, (tuple, list)) and len(scatter_size) > 0:
            scatter_size = int(scatter_size[0])
        else:
            scatter_size = int(scatter_size)


        # Create nested config (accepts flat kwargs for backward compat)
        self.config = _nest_config(
            size=size,
            controls=controls,
            box=box,
            color=color,
            colorblind=colorblind,
            shadow=shadow,
            shadow_strength=shadow_strength,
            outline=outline,
            width=width,
            ortho=ortho,
            rotate=rotate,
            autoplay=autoplay,
            pae=pae,
            pae_size=pae_size,
            scatter=scatter,
            scatter_size=scatter_size,
            overlay=overlay,
            detect_cyclic=detect_cyclic
        )
        
        # Add viewer_id to root level
        import uuid
        if id is not None:
            self.config["viewer_id"] = str(id)
        else:
            self.config["viewer_id"] = str(uuid.uuid4())
        
        # The viewer's mode is determined by when .show() is called.
        self.objects = []                 # Store all data
        self._current_object_data = None  # List to hold frames for current object
        self._is_live = False             # True if .show() was called *before* .add()
        self._data_display_id = None      # For updating data cell only (not viewer)

        # Track sent frames and metadata to enable true incremental updates
        self._sent_frame_count = {}       # {"obj_name": num_frames_sent}
        self._sent_metadata = {}          # {"obj_name": {metadata_dict}}

        # --- Alignment/Dynamic State ---
        self._coords = None
        self._rotation_matrix = None
        self._center = None
        self._plddts = None
        self._chains = None
        self._position_types = None
        self._pae = None
        self._scatter = None
        self._position_names = None
        self._position_residue_numbers = None

    def _get_data_dict(self):
        """
        Serializes the current coordinate state to a dict, omitting
        any attributes that are None.
        """
        payload = {}
        
        # Coords are mandatory
        if self._coords is not None:
            payload["coords"] = np.round(self._coords, 2).tolist()
        else:
            # If there are no coordinates, return an empty dict
            return {}

        # Optional attributes
        if self._plddts is not None:
            payload["plddts"] = np.round(self._plddts, 0).astype(int).tolist()

        if self._chains is not None:
            payload["chains"] = list(self._chains)

        if self._position_types is not None:
            payload["position_types"] = list(self._position_types)

        if self._pae is not None:
            # Flatten and scale to 0-255 (x8) for Uint8Array compatibility in frontend
            # This reduces JSON size significantly compared to list of lists of floats
            scaled_pae = np.clip(np.round(self._pae * 8), 0, 255).astype(np.uint8)
            payload["pae"] = scaled_pae.flatten().tolist()

        if self._scatter is not None:
            payload["scatter"] = self._scatter  # Already in [x, y] format

        if self._position_names is not None:
            payload["position_names"] = list(self._position_names)

        if self._position_residue_numbers is not None:
            payload["residue_numbers"] = list(self._position_residue_numbers)

        return payload

    def _update(self, coords, plddts=None, chains=None, position_types=None, pae=None, scatter=None, align=True, position_names=None, residue_numbers=None, atom_types=None):
      """
      Updates the internal state with new data. Coordinates are kept in original space.
      Rotation matrix is ALWAYS computed for first frame (best_view).
      The 'align' parameter controls whether subsequent frames are aligned to the first frame.

      Args:
          residue_numbers: PDB residue sequence numbers (resSeq), one per position.
                           For ligands, multiple positions may share the same residue number.
          atom_types: Backward compatibility alias for position_types (deprecated).
          align: If True, subsequent frames are aligned to the first frame.
                 Best view is ALWAYS computed for first frame regardless of this parameter.

      """
      # Backward compatibility: support atom_types as alias for position_types
      if atom_types is not None and position_types is None:
          position_types = atom_types

      # --- Coordinate Alignment ---
      if self._coords is None:
          # First frame of an object - ALWAYS compute best_view for optimal viewing angle
          self._rotation_matrix, self._center = best_view(coords)
          self._coords = coords
      else:
          # Subsequent frames, align to the first frame if align=True
          if align and self._coords.shape == coords.shape:
              self._coords = align_a_to_b(coords, self._coords)
          else:
              self._coords = coords
      
      # --- Store Provided Data (or None) ---
      self._plddts = plddts
      self._chains = chains
      self._position_types = position_types
      self._pae = pae
      self._scatter = scatter
      self._position_names = position_names
      self._position_residue_numbers = residue_numbers

      # --- Final Safety Check (ensure arrays match coord length if provided) ---
      n_positions = self._coords.shape[0]
      
      if self._plddts is not None and len(self._plddts) != n_positions:
          print(f"Warning: pLDDT length mismatch. Ignoring pLDDTs for this frame.")
          self._plddts = None
      if self._chains is not None and len(self._chains) != n_positions:
          print(f"Warning: Chains length mismatch. Ignoring chains for this frame.")
          self._chains = None
      if self._position_types is not None and len(self._position_types) != n_positions:
          print(f"Warning: Position types length mismatch. Ignoring position types for this frame.")
          self._position_types = None
      if self._position_names is not None and len(self._position_names) != n_positions:
          print(f"Warning: Position names length mismatch. Ignoring position names for this frame.")
          self._position_names = None
      if self._position_residue_numbers is not None and len(self._position_residue_numbers) != n_positions:
          print(f"Warning: Residue numbers length mismatch. Ignoring residue numbers for this frame.")
          self._position_residue_numbers = None

    def _find_object_by_name(self, name):
        """Find and return object by name, or None if not found."""
        for obj in self.objects:
            if obj.get("name") == name:
                return obj
        return None

    def _send_incremental_update(self):
        """
        Sends incremental state update to viewer (frames and metadata).

        Only sends:
        - NEW frames that haven't been sent yet
        - CHANGED metadata (color, contacts, bonds, rotation, center)

        Uses display(Javascript()) to create ephemeral scripts that get garbage collected.
        Heavy processing is done in viewer-mol.js (handleIncrementalStateUpdate).
        """
        if not self._is_live:
            return

        viewer_id = self.config["viewer_id"]

        # Track new frames and changed metadata to send
        new_frames_by_object = {}
        changed_metadata_by_object = {}

        for obj in self.objects:
            obj_name = obj.get("name", "")
            if not obj_name:
                continue

            frames = obj.get("frames", [])
            total_frame_count = len(frames)

            # Determine which frames are new (not yet sent)
            frames_already_sent = self._sent_frame_count.get(obj_name, 0)

            if total_frame_count > frames_already_sent:
                # Extract only the new frames using slice
                new_frames = frames[frames_already_sent:]
                new_frames_by_object[obj_name] = new_frames

                # Update tracking: mark these frames as sent
                self._sent_frame_count[obj_name] = total_frame_count

            # Collect current metadata for this object
            current_metadata = {}
            if obj.get("color") is not None:
                current_metadata["color"] = obj["color"]
            if obj.get("contacts") is not None:
                current_metadata["contacts"] = obj["contacts"]
            if obj.get("bonds") is not None:
                current_metadata["bonds"] = obj["bonds"]
            if obj.get("rotation_matrix") is not None:
                current_metadata["rotation_matrix"] = obj["rotation_matrix"]
            if obj.get("center") is not None:
                current_metadata["center"] = obj["center"]

            # Determine which metadata fields have changed
            if current_metadata:
                previously_sent_metadata = self._sent_metadata.get(obj_name, {})
                changed_metadata_fields = {}

                for field_name, field_value in current_metadata.items():
                    # Include if new or changed
                    if field_name not in previously_sent_metadata or previously_sent_metadata[field_name] != field_value:
                        changed_metadata_fields[field_name] = field_value

                if changed_metadata_fields:
                    changed_metadata_by_object[obj_name] = changed_metadata_fields
                    # Update tracking: mark this metadata as sent (deep copy to avoid aliasing)
                    self._sent_metadata[obj_name] = copy.deepcopy(current_metadata)

        # Skip update if nothing new to send
        if not new_frames_by_object and not changed_metadata_by_object:
            return

        # Build minimal JavaScript to send update
        # Use short variable names in JS to minimize payload size
        incremental_update_js = f"""
(function() {{
    const newFrames = {json.dumps(new_frames_by_object)};
    const changedMetadata = {json.dumps(changed_metadata_by_object)};
    const viewerId = '{viewer_id}';
    const instanceId = 'py_' + Date.now();
    let deliveredViaChannel = false;

    // BroadcastChannel for cross-iframe communication (Google Colab)
    try {{
        const channel = new BroadcastChannel('py2dmol_' + viewerId);
        channel.postMessage({{
            operation: 'incrementalStateUpdate',
            args: [newFrames, changedMetadata],
            sourceInstanceId: instanceId
        }});
        deliveredViaChannel = true;
    }} catch(e) {{}}

    // Fallback direct call only if channel path failed (avoids double-delivery)
    if (!deliveredViaChannel && window.py2dmol_viewers && window.py2dmol_viewers[viewerId]) {{
        window.py2dmol_viewers[viewerId].handleIncrementalStateUpdate(newFrames, changedMetadata);
    }}
}})();
"""
        # Use HTML-wrapped script (display:none to avoid layout changes)
        html_wrapper = f'<script style="display:none">{incremental_update_js}</script>'
        display(HTML(html_wrapper))

    def _display_viewer(self, static_data=None, include_libs=True):
        """
        Internal: Renders the viewer's HTML directly into a div.

        Args:
            static_data (list, optional):
                - A list of objects (for static 'show()' or hybrid modes).
            include_libs (bool, optional):
                - If True, includes the viewer library scripts (default).
                - If False, skips library injection (for grid cells that reuse libraries).

        Returns:
            str: The complete HTML string to be displayed.
        """
        with importlib.resources.open_text(py2dmol_resources, 'viewer.html') as f:
            html_template = f.read()

        viewer_id = self.config["viewer_id"]

        # Setup viewer config - store per viewer to avoid global overwrites
        # Initialize the configs object if it doesn't exist
        config_script = f"""<script>
window.py2dmol_configs = window.py2dmol_configs || {{}};
window.py2dmol_configs['{viewer_id}'] = {json.dumps(self.config)};
</script>"""

        data_script = ""

        if static_data and isinstance(static_data, list):
            serialized_objects = []
            for py_obj in static_data:
                if not py_obj.get("frames"):
                    continue

                light_frames = []
                # Track previous frame data for change detection
                prev_plddts = None
                prev_chains = None
                prev_position_types = None
                prev_position_names = None
                prev_residue_numbers = None
                prev_bonds = None
                prev_scatter = None

                for frame_idx, frame in enumerate(py_obj["frames"]):
                    # Skip frames without coords (they're invalid)
                    if "coords" not in frame or not frame["coords"]:
                        continue

                    light_frame = {}
                    if "name" in frame and frame["name"] is not None:
                        light_frame["name"] = frame["name"]

                    # Coords are required - we already checked above
                    light_frame["coords"] = frame["coords"]

                    # Only include other fields if they differ from previous frame
                    # Always include for frame 0

                    # plddts
                    curr_plddts = frame.get("plddts")
                    if frame_idx == 0 or curr_plddts != prev_plddts:
                        # Send the value even if None to explicitly signal "no plddt" vs inheriting
                        light_frame["plddts"] = curr_plddts
                        prev_plddts = curr_plddts

                    # pae (always include if present, usually only in frame 0)
                    if "pae" in frame and frame["pae"] is not None:
                        light_frame["pae"] = frame["pae"]

                    # position_names
                    curr_position_names = frame.get("position_names")
                    if frame_idx == 0 or curr_position_names != prev_position_names:
                        if curr_position_names is not None:
                            light_frame["position_names"] = curr_position_names
                        prev_position_names = curr_position_names

                    # residue_numbers
                    curr_residue_numbers = frame.get("residue_numbers")
                    if frame_idx == 0 or curr_residue_numbers != prev_residue_numbers:
                        if curr_residue_numbers is not None:
                            light_frame["residue_numbers"] = curr_residue_numbers
                        prev_residue_numbers = curr_residue_numbers

                    # position_types
                    curr_position_types = frame.get("position_types")
                    if frame_idx == 0 or curr_position_types != prev_position_types:
                        if curr_position_types is not None:
                            light_frame["position_types"] = curr_position_types
                        prev_position_types = curr_position_types

                    # chains
                    curr_chains = frame.get("chains")
                    if frame_idx == 0 or curr_chains != prev_chains:
                        if curr_chains is not None:
                            light_frame["chains"] = curr_chains
                        prev_chains = curr_chains
                    
                    # bonds
                    curr_bonds = frame.get("bonds")
                    if frame_idx == 0 or curr_bonds != prev_bonds:
                        if curr_bonds is not None:
                            light_frame["bonds"] = curr_bonds
                        prev_bonds = curr_bonds

                    # scatter
                    curr_scatter = frame.get("scatter")
                    if frame_idx == 0 or curr_scatter != prev_scatter:
                        if curr_scatter is not None:
                            light_frame["scatter"] = curr_scatter
                        prev_scatter = curr_scatter

                    # color (always include if present)
                    if "color" in frame and frame["color"] is not None:
                        light_frame["color"] = frame["color"]

                    light_frames.append(light_frame)

                # Skip objects with no valid frames
                if not light_frames:
                    continue

                # For static data, we still need to provide chains and position_types
                # for the whole object, but only if they exist in the first valid frame.
                first_frame = light_frames[0]
                obj_to_serialize = {"name": py_obj.get("name"), "frames": light_frames}
                if "chains" in first_frame and first_frame["chains"] is not None:
                    obj_to_serialize["chains"] = first_frame["chains"]
                if "position_types" in first_frame and first_frame["position_types"] is not None:
                    obj_to_serialize["position_types"] = first_frame["position_types"]

                # Add rotation_matrix and center if they exist (for viewing orientation)
                if "rotation_matrix" in py_obj and py_obj["rotation_matrix"] is not None:
                    obj_to_serialize["rotation_matrix"] = py_obj["rotation_matrix"]
                if "center" in py_obj and py_obj["center"] is not None:
                    obj_to_serialize["center"] = py_obj["center"]

                # Add contacts if they exist
                if "contacts" in py_obj and py_obj["contacts"] is not None and len(py_obj["contacts"]) > 0:
                    obj_to_serialize["contacts"] = py_obj["contacts"]

                # Add bonds if they exist
                if "bonds" in py_obj and py_obj["bonds"] is not None and len(py_obj["bonds"]) > 0:
                    obj_to_serialize["bonds"] = py_obj["bonds"]

                # Add color overrides if they exist
                if "color" in py_obj and py_obj["color"] is not None:
                    obj_to_serialize["color"] = py_obj["color"]

                # Add scatter_config if it exists
                if "scatter_config" in py_obj and py_obj["scatter_config"] is not None:
                    obj_to_serialize["scatter_config"] = py_obj["scatter_config"]

                serialized_objects.append(obj_to_serialize)

            data_json = json.dumps(serialized_objects)

            # Use viewer_id-specific namespace to avoid conflicts
            data_script = f'''<script id="static-data-{viewer_id}">
          window.py2dmol_staticData = window.py2dmol_staticData || {{}};
          window.py2dmol_staticData['{viewer_id}'] = {data_json};
        </script>'''
        else:
            # Pure Dynamic mode: inject empty data, will be populated by messages
            data_script = f'''<script id="protein-data-{viewer_id}">
          window.py2dmol_proteinData = window.py2dmol_proteinData || {{}};
          window.py2dmol_proteinData['{viewer_id}'] = {{ "coords": [], "plddts": [], "chains": [], "position_types": [], "pae": null }};
        </script>'''

        # Build injection scripts for config and data
        injection_scripts = config_script + "\n" + data_script

        # Inject config and data into the raw HTML template
        final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)

        # Standard div approach
        container_html = f"""
        <div id="{viewer_id}" style="position: relative; display: inline-block; line-height: 0;">
            {final_html}
        </div>
        <script>
            (function() {{
                const container = document.getElementById("{viewer_id}");

                function init() {{
                    if (container && typeof initializePy2DmolViewer === 'function') {{
                        initializePy2DmolViewer(container, '{viewer_id}');
                    }} else {{
                        console.error("py2dmol: Failed to initialize viewer (container or function missing).");
                    }}
                }}

                if (typeof initializePy2DmolViewer === 'function') {{
                    init();
                }} else {{
                    window.addEventListener('py2dmol_lib_loaded', init, {{ once: true }});
                }}
            }})();
        </script>
        """ # Inject JS: always use inline package scripts (offline mode)
        # Only include library scripts if requested (grid optimization)
        if include_libs:
            with importlib.resources.open_text(py2dmol_resources, 'viewer-mol.min.js') as f:
                js_content_parent = f.read()
            container_html = f'<script>{js_content_parent}</script>\n' + container_html

            if self.config["pae"]["enabled"]:
                with importlib.resources.open_text(py2dmol_resources, 'viewer-pae.min.js') as f:
                    pae_js_content = f.read()
                container_html = f'<script>{pae_js_content}</script>\n' + container_html

            if self.config["scatter"]["enabled"]:
                with importlib.resources.open_text(py2dmol_resources, 'viewer-scatter.min.js') as f:
                    scatter_js_content = f.read()
                container_html = f'<script>{scatter_js_content}</script>\n' + container_html

        return container_html

    def _display_html(self, html_string):
        """Displays the HTML simply, without widgets."""
        # We no longer use ipywidgets, just display directly.
        # The .show() method will now print a *new* cell.
        display(HTML(html_string))

    def clear(self):
        """Clears all objects and frames from the viewer."""
        # Clear python data
        self.objects = []
        self._current_object_data = None

        # Reset python state
        # Note: We don't send a message to the viewer because:
        # 1. self.objects is already cleared above
        # 2. _is_live is set to False below
        # 3. The viewer will continue showing its current content until show() is called again
        self._coords = None
        self._rotation_matrix = None
        self._center = None
        self._plddts = None
        self._chains = None
        self._position_types = None
        self._pae = None
        self._scatter = None
        self._position_names = None
        self._position_residue_numbers = None
        self._is_live = False

        # Reset incremental update tracking
        self._sent_frame_count = {}
        self._sent_metadata = {}

    def _parse_contact_color(self, color_str):
        """
        Parse color string to RGB dict.
        Supports color names, hex codes, and rgba format.
        
        Args:
            color_str (str): Color string (name, hex, or rgba)
            
        Returns:
            dict or None: {"r": int, "g": int, "b": int} or None if invalid
        """
        if not color_str or not isinstance(color_str, str):
            return None
        
        color_lower = color_str.lower().strip()
        
        # Common color names
        color_names = {
            'red': {'r': 255, 'g': 0, 'b': 0},
            'green': {'r': 0, 'g': 255, 'b': 0},
            'blue': {'r': 0, 'g': 0, 'b': 255},
            'yellow': {'r': 255, 'g': 255, 'b': 0},
            'orange': {'r': 255, 'g': 165, 'b': 0},
            'purple': {'r': 128, 'g': 0, 'b': 128},
            'cyan': {'r': 0, 'g': 255, 'b': 255},
            'magenta': {'r': 255, 'g': 0, 'b': 255},
            'pink': {'r': 255, 'g': 192, 'b': 203},
            'brown': {'r': 165, 'g': 42, 'b': 42},
            'black': {'r': 0, 'g': 0, 'b': 0},
            'white': {'r': 255, 'g': 255, 'b': 255},
            'gray': {'r': 128, 'g': 128, 'b': 128},
            'grey': {'r': 128, 'g': 128, 'b': 128}
        }
        
        if color_lower in color_names:
            return color_names[color_lower]
        
        # Hex color (#ff0000 or ff0000)
        if color_str.startswith('#') or (len(color_str) == 6 and all(c in '0123456789abcdefABCDEF' for c in color_str)):
            hex_str = color_str[1:] if color_str.startswith('#') else color_str
            if len(hex_str) == 6:
                try:
                    r = int(hex_str[0:2], 16)
                    g = int(hex_str[2:4], 16)
                    b = int(hex_str[4:6], 16)
                    return {'r': r, 'g': g, 'b': b}
                except ValueError:
                    return None
        
        # RGBA format: rgba(255, 0, 0, 0.8) or rgb(255, 0, 0)
        rgba_match = re.match(r'rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)', color_str)
        if rgba_match:
            try:
                r = int(rgba_match.group(1))
                g = int(rgba_match.group(2))
                b = int(rgba_match.group(3))
                return {'r': r, 'g': g, 'b': b}
            except (ValueError, IndexError):
                return None
        
        return None

    def _parse_contacts_file(self, filepath):
        """
        Parse .cst contact file.
        
        Args:
            filepath (str): Path to .cst file
            
        Returns:
            list: List of contact arrays
        """
        contacts = []
        try:
            with open(filepath, 'r') as f:
                lines = f.readlines()
            
            for line in lines:
                trimmed = line.strip()
                # Skip empty lines and comment lines (starting with #)
                if not trimmed or trimmed.startswith('#'):
                    continue
                
                parts = trimmed.split()
                
                # Position indices format: "10 50 1.0" or "10 50 1.0 red" (weight is required)
                if len(parts) >= 3:
                    try:
                        idx1 = int(parts[0])
                        idx2 = int(parts[1])
                        weight = float(parts[2])
                        
                        if weight > 0:
                            contact = [idx1, idx2, weight]
                            # Optional color (4th part and beyond)
                            if len(parts) >= 4:
                                color_str = ' '.join(parts[3:])  # Join in case color has spaces
                                color = self._parse_contact_color(color_str)
                                if color:
                                    contact.append(color)
                            contacts.append(contact)
                            continue
                    except (ValueError, IndexError):
                        pass
                
                # Chain + residue format: "A 10 B 50 0.5" or "A 10 B 50 0.5 yellow" (weight is required)
                if len(parts) >= 5:
                    try:
                        chain1 = parts[0]
                        res1 = int(parts[1])
                        chain2 = parts[2]
                        res2 = int(parts[3])
                        weight = float(parts[4])
                        
                        if weight > 0:
                            contact = [chain1, res1, chain2, res2, weight]
                            # Optional color (6th part and beyond)
                            if len(parts) >= 6:
                                color_str = ' '.join(parts[5:])  # Join in case color has spaces
                                color = self._parse_contact_color(color_str)
                                if color:
                                    contact.append(color)
                            contacts.append(contact)
                    except (ValueError, IndexError):
                        pass
        except Exception as e:
            print(f"Error parsing contacts file '{filepath}': {e}")
            return []
        
        return contacts

    def _process_contacts(self, contacts):
        """
        Process contacts input (filepath string or list of lists).
        
        Args:
            contacts: Either a filepath (str) or list of contact arrays
            
        Returns:
            list: List of contact arrays, or None if invalid
        """
        if contacts is None:
            return None
        
        if isinstance(contacts, str):
            # Filepath - parse it
            return self._parse_contacts_file(contacts)
        elif isinstance(contacts, list):
            # List of contacts - validate and parse colors
            validated = []
            for contact in contacts:
                if isinstance(contact, list) and len(contact) >= 3:
                    # Parse color if it's a string (4th element)
                    if len(contact) >= 4:
                        color_elem = contact[3]
                        # If color is a string, parse it to RGB dict
                        if isinstance(color_elem, str):
                            parsed_color = self._parse_contact_color(color_elem)
                            if parsed_color:
                                # Replace string with parsed RGB dict
                                validated.append([contact[0], contact[1], contact[2], parsed_color])
                            else:
                                # Invalid color string, skip color
                                validated.append([contact[0], contact[1], contact[2]])
                        else:
                            # Color is already a dict or other format, keep as-is
                            validated.append(contact)
                    else:
                        # No color specified
                        validated.append(contact)
                else:
                    print(f"Warning: Skipping invalid contact: {contact}")
            return validated if validated else None
        else:
            print(f"Error: contacts must be a filepath (str) or list of lists, got {type(contacts)}")
            return None

    def _parse_scatter_csv(self, filepath):
        """
        Parse a CSV file containing scatter plot data.

        Expected format:
        - First row: header with 2 columns (xlabel, ylabel)
        - Subsequent rows: x,y numeric data pairs

        Args:
            filepath (str): Path to CSV file

        Returns:
            dict: {"data": [[x1, y1], [x2, y2], ...], "xlabel": str, "ylabel": str}
                  or None if parsing fails
        """
        try:
            with open(filepath, 'r') as f:
                lines = f.readlines()

            if len(lines) < 2:
                print(f"Error: CSV file '{filepath}' must have at least a header row and one data row")
                return None

            # Parse header (first row)
            header = [h.strip() for h in lines[0].strip().split(',')]
            if len(header) < 2:
                print(f"Error: CSV file '{filepath}' must have at least 2 columns")
                return None

            xlabel = header[0]
            ylabel = header[1]

            # Parse data rows
            scatter_data = []
            for i, line in enumerate(lines[1:], start=2):
                line = line.strip()
                if not line:  # Skip empty lines
                    continue

                values = [v.strip() for v in line.split(',')]
                if len(values) < 2:
                    print(f"Warning: Skipping row {i} in '{filepath}' (insufficient columns)")
                    continue

                try:
                    x = float(values[0])
                    y = float(values[1])
                    scatter_data.append([x, y])
                except (ValueError, TypeError):
                    print(f"Warning: Skipping row {i} in '{filepath}' (non-numeric values)")
                    continue

            if len(scatter_data) == 0:
                print(f"Error: No valid data points found in CSV file '{filepath}'")
                return None

            return {
                "data": scatter_data,
                "xlabel": xlabel,
                "ylabel": ylabel
            }

        except Exception as e:
            print(f"Error parsing scatter CSV file '{filepath}': {e}")
            return None

    def _process_scatter(self, scatter):
        """
        Process scatter input (filepath string or list/array of points).

        Args:
            scatter: Either:
                - String: filepath to CSV file (returns dict with data, xlabel, ylabel)
                - List/array: [[x1, y1], [x2, y2], ...] or [(x1, y1), (x2, y2), ...]
                  (returns list format)

        Returns:
            dict: {"data": [[x1, y1], ...], "xlabel": str, "ylabel": str} if CSV
            list: [[x1, y1], ...] if list input
            None if invalid
        """
        if scatter is None:
            return None

        if isinstance(scatter, str):
            # Filepath - parse CSV
            return self._parse_scatter_csv(scatter)
        elif isinstance(scatter, (list, tuple, np.ndarray)):
            # List/array of points - validate format
            validated = []
            for i, point in enumerate(scatter):
                if isinstance(point, (list, tuple)) and len(point) >= 2:
                    try:
                        x = float(point[0])
                        y = float(point[1])
                        validated.append([x, y])
                    except (ValueError, TypeError):
                        print(f"Warning: Skipping invalid scatter point at index {i}: {point}")
                elif isinstance(point, np.ndarray) and point.shape == (2,):
                    try:
                        x = float(point[0])
                        y = float(point[1])
                        validated.append([x, y])
                    except (ValueError, TypeError):
                        print(f"Warning: Skipping invalid scatter point at index {i}: {point}")
                else:
                    print(f"Warning: Skipping invalid scatter point at index {i}: {point} (must be [x, y] pair)")

            if len(validated) == 0:
                print(f"Error: No valid scatter points found in provided data")
                return None

            return validated
        else:
            print(f"Error: scatter must be a filepath (str) or list/array of [x, y] points, got {type(scatter)}")
            return None

    def _process_bonds(self, bonds):
        """
        Process bonds input (list of bond pairs).

        Args:
            bonds: List of bond arrays, where each bond is [idx1, idx2]

        Returns:
            list: List of validated bond pairs [[idx1, idx2], ...], or None if invalid
        """
        if bonds is None:
            return None

        if not isinstance(bonds, list):
            print(f"Error: bonds must be a list of [idx1, idx2] pairs, got {type(bonds)}")
            return None

        # Validate and process bonds
        validated_bonds = []
        for bond in bonds:
            if isinstance(bond, (list, tuple)) and len(bond) >= 2:
                try:
                    idx1, idx2 = int(bond[0]), int(bond[1])
                    # Validate indices
                    if idx1 >= 0 and idx2 >= 0 and idx1 != idx2:
                        validated_bonds.append([idx1, idx2])
                    else:
                        print(f"Warning: Skipping invalid bond {bond} (indices must be non-negative and distinct)")
                except (ValueError, TypeError):
                    print(f"Warning: Skipping invalid bond {bond} (indices must be integers)")
            else:
                print(f"Warning: Skipping invalid bond format {bond} (expected [idx1, idx2])")

        return validated_bonds if validated_bonds else None

    def new_obj(self, name=None, scatter_config=None):
        """Starts a new object for subsequent 'add' calls.

        Args:
            name (str, optional): Object name; defaults to incremental index.
            scatter_config (dict, optional): Per-object scatter settings (xlabel, ylabel, xlim, ylim).
        """

        # This is a new object, reset the alignment reference
        self._coords = None
        self._rotation_matrix = None
        self._center = None
        self._plddts = None
        self._chains = None
        self._position_types = None
        self._pae = None
        self._scatter = None
        self._position_names = None
        self._position_residue_numbers = None

        if name is None:
            name = f"{len(self.objects)}"
            
        # Always update the python-side data
        self._current_object_data = [] # List to hold frames
        self.objects.append({
            "name": name,
            "frames": self._current_object_data,
            "name": name,
            "frames": self._current_object_data,
            "contacts": None,  # Initialize contacts as None
            "bonds": None,     # Initialize bonds as None
            "color": None,     # Initialize color overrides as None
            "scatter_config": scatter_config  # Initialize per-object scatter configuration
        })
        
        # Send message *only if* in dynamic/hybrid mode and already displayed
        if self._is_live:
            self._send_incremental_update()
    
    def add(self, coords, plddts=None, chains=None, position_types=None, pae=None, scatter=None,
            name=None, align=True, position_names=None, residue_numbers=None, atom_types=None, contacts=None, bonds=None, color=None, scatter_config=None):
        """
        Adds a new *frame* of data to the viewer.

        Behavior depends on when .show() is called.

        Args:
            coords (np.array): Nx3 array of coordinates.
                               Also supports batched input with shape (batch, N, 3).
            plddts (np.array, optional): N-length array of pLDDT scores.
            chains (list, optional): N-length list of chain identifiers.
            position_types (list, optional): N-length list of position types ('P', 'D', 'R', 'L').
            pae (np.array, optional): LxL PAE matrix.
            scatter (list/tuple/dict, optional): Scatter plot data point for this frame.
                   Accepts: [x, y], (x, y), or {"x": x, "y": y}
            name (str, optional): Name for the object. If a different name is provided than the current object, a new object is created.
            align (bool, optional): If True, aligns subsequent frames to the first frame.
                                   Best-view rotation is ALWAYS computed for first frame. Defaults to True.
            position_names (list, optional): N-length list of position names.
            residue_numbers (list, optional): N-length list of PDB residue sequence numbers (resSeq).
                                              One per position. For ligands, multiple positions may share the same residue number.
            atom_types (list, optional): Backward compatibility alias for position_types (deprecated).
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
            bonds (list, optional): List of bonds. Each bond is [atom_idx1, atom_idx2].
            color: Frame-level color. Can be:
                   - String (mode): "chain", "plddt", "rainbow", "auto", "entropy", "deepmind"
                   - String (literal): "red", "#ff0000", etc.
                   - Dict (advanced): {"frame": mode/color, "chain": {...}, "position": {...}}
        """

        # --- Step 0: Handle batched coordinates (shape: batch x N x 3) ---
        batch_size = None
        coords_batch = None
        if isinstance(coords, np.ndarray) and coords.ndim == 3:
            batch_size = coords.shape[0]
            coords_batch = coords
        elif isinstance(coords, (list, tuple)) and len(coords) > 0:
            try:
                arr = np.asarray(coords)
                if arr.ndim == 3:
                    batch_size = arr.shape[0]
                    coords_batch = arr
            except Exception:
                pass  # Fall back to single-frame handling

        if batch_size is not None and batch_size > 0:
            def _slice(feature, idx):
                if feature is None:
                    return None
                if isinstance(feature, np.ndarray):
                    if feature.ndim >= 1 and feature.shape[0] == batch_size:
                        return feature[idx]
                    return feature
                if isinstance(feature, (list, tuple)):
                    if len(feature) == batch_size:
                        return feature[idx]
                    return feature
                return feature

            # Suppress per-frame live sends and emit one incremental update at the end
            live_before = self._is_live
            if live_before:
                self._is_live = False

            for i in range(batch_size):
                self.add(
                    coords_batch[i],
                    _slice(plddts, i),
                    _slice(chains, i),
                    _slice(position_types, i),
                    pae=_slice(pae, i),
                    scatter=_slice(scatter, i),
                    name=name,
                    align=align,
                    position_names=_slice(position_names, i),
                    residue_numbers=_slice(residue_numbers, i),
                    atom_types=_slice(atom_types, i),
                    contacts=contacts,  # contacts/bonds/color assumed shared across batch
                    bonds=bonds,
                    color=color,
                    scatter_config=scatter_config
                )

            # Restore live flag and send all new frames in one incremental message
            if live_before:
                self._is_live = True
                self._send_incremental_update()
            return
        
        # --- Step 1: Handle object creation BEFORE touching alignment state ---
        # Doing this first avoids wiping the freshly computed best_view rotation
        # when new_obj() resets internal alignment variables.
        # If a name is provided, treat it as an object name and check if we need a new object
        create_new_object = False
        if name is not None:
            target_obj = self._find_object_by_name(name)
            if target_obj is not None:
                # Object with this name already exists, add to it
                self._current_object_data = target_obj["frames"]
            elif self.objects and self.objects[-1]["name"] != name:
                # Different name and no matching object exists, create new object
                create_new_object = True
        elif not self.objects:
            # No name provided and no objects exist, create first object
            create_new_object = True

        if create_new_object or not self.objects:
            self.new_obj(name, scatter_config=scatter_config)
        
        is_first_frame = len(self._current_object_data) == 0 if self._current_object_data is not None else False

        # --- Step 1.5: Validate and normalize scatter data ---
        if scatter is not None:
            # Accept multiple formats: [x, y], (x, y), {"x": x, "y": y}
            if isinstance(scatter, dict) and "x" in scatter and "y" in scatter:
                scatter = [scatter["x"], scatter["y"]]
            elif isinstance(scatter, (list, tuple)) and len(scatter) == 2:
                scatter = list(scatter)  # Ensure it's a list
            else:
                raise ValueError(
                    "scatter must be [x, y], (x, y), or {'x': x, 'y': y} "
                    f"for a single point per frame, got: {type(scatter)}"
                )

            # Validate values are numeric
            try:
                x, y = float(scatter[0]), float(scatter[1])
            except (ValueError, TypeError) as e:
                raise ValueError(f"scatter values must be numeric: {e}")

            scatter = [x, y]  # Normalized format

        # --- Step 2: Update Python-side alignment state ---
        self._update(coords, plddts, chains, position_types, pae, scatter,
            align=align, position_names=position_names, residue_numbers=residue_numbers, atom_types=atom_types)
        data_dict = self._get_data_dict() # This reads the full, correct data

        data_dict["name"] = None  # Don't set frame-level name; use object name instead

        # --- Step 3: Store rotation matrix and center on first frame ---
        if is_first_frame:
            self.objects[-1]["rotation_matrix"] = self._rotation_matrix.tolist()
            self.objects[-1]["center"] = self._center.tolist()
        else:
            # In overlay mode, update center to encompass all frames
            if self.config["overlay"]["enabled"]:
                # Get all frames' coordinates and calculate combined center
                all_coords = []
                for frame in self._current_object_data:
                    all_coords.append(np.array(frame["coords"]))
                # Add current frame
                all_coords.append(self._coords)

                # Calculate center from all frames combined
                combined_coords = np.vstack(all_coords)
                updated_center = combined_coords.mean(axis=0)

                # Update stored center
                self._center = updated_center
                self.objects[-1]["center"] = updated_center.tolist()

        # --- Step 4: Save data to Python list ---
        self._current_object_data.append(data_dict)

        # --- Step 6: Process contacts if provided ---
        if contacts is not None:
            processed_contacts = self._process_contacts(contacts)
            if processed_contacts:
                self.objects[-1]["contacts"] = processed_contacts

        # --- Step 7: Process bonds if provided ---
        if bonds is not None:
            processed_bonds = self._process_bonds(bonds)
            if processed_bonds:
                self.objects[-1]["bonds"] = processed_bonds

        # --- Step 8: Process color if provided ---
        if color is not None:
            # Check if color is already normalized (has "type" and "value" keys)
            if isinstance(color, dict) and "type" in color and "value" in color:
                # Already normalized (e.g., from load_state)
                data_dict["color"] = color
            else:
                # Needs normalization (e.g., from user input)
                normalized_color = _normalize_color(color)
                if normalized_color:
                    data_dict["color"] = normalized_color

        # --- Step 8.5: Process scatter_config if provided ---
        if scatter_config is not None and isinstance(scatter_config, dict):
            validated_config = {}

            # Optional: xlabel, ylabel
            if "xlabel" in scatter_config:
                validated_config["xlabel"] = str(scatter_config["xlabel"])
            if "ylabel" in scatter_config:
                validated_config["ylabel"] = str(scatter_config["ylabel"])

            # Optional: xlim, ylim (must be [min, max] tuples)
            if "xlim" in scatter_config:
                xlim = scatter_config["xlim"]
                if isinstance(xlim, (list, tuple)) and len(xlim) == 2:
                    validated_config["xlim"] = [float(xlim[0]), float(xlim[1])]

            if "ylim" in scatter_config:
                ylim = scatter_config["ylim"]
                if isinstance(ylim, (list, tuple)) and len(ylim) == 2:
                    validated_config["ylim"] = [float(ylim[0]), float(ylim[1])]

            # Store in object (only set once per object, on first frame)
            if is_first_frame and self.objects[-1].get("scatter_config") is None:
                self.objects[-1]["scatter_config"] = validated_config

        # --- Step 9: Send message if in "live" mode ---
        if self._is_live:
            payload = data_dict.copy()
            if "contacts" in self.objects[-1]:
                payload["contacts"] = self.objects[-1]["contacts"]
            if "bonds" in self.objects[-1]:
                payload["bonds"] = self.objects[-1]["bonds"]

            self._send_incremental_update()

    def set_color(self, color, name=None, chain=None, position=None, frame=None):
        """
        Set or override color for an object, chain, position, or frame.

        Args:
            color: Color specification. Can be:
                   - String (mode): "chain", "plddt", "rainbow", "auto", "entropy", "deepmind"
                   - String (literal): "red", "#ff0000", etc.
                   - Dict: {"A": "red", "B": "blue"} when chain=True or position=True
                   - Dict (advanced): {"object": mode, "frames": {...}} (legacy format)
            name (str, optional): Name of the object to color.
                                 If None, colors the last (most recently added) object.
            chain (str or bool, optional):
                   - str: Single chain ID to color (e.g., "A")
                   - True: Color is a dict mapping chains to colors
                   - None: No chain-specific coloring
            position (int, list, tuple, range, or bool, optional):
                   - int: Single position index to color
                   - list: List of position indices [5, 10, 15, 20]
                   - tuple: Range of positions (start, end) - e.g., (5, 15) colors 5-14
                   - range: Range object - e.g., range(5, 15) colors 5-14
                   - True: Color is a dict mapping positions to colors
                   - None: No position-specific coloring
            frame (int, optional): Specific frame index to color (0-based)

        Examples:
            # Simple: Color entire object
            viewer.set_color("red")
            viewer.set_color("plddt")

            # Chain-specific (SIMPLE!)
            viewer.set_color("red", chain="B")                    # Color chain B red
            viewer.set_color({"A": "red", "B": "blue"}, chain=True)  # Multiple chains

            # Position-specific (SIMPLE!)
            viewer.set_color("yellow", position=5)                # Color position 5 yellow
            viewer.set_color("red", position=[5, 10, 15])         # Color multiple positions
            viewer.set_color("blue", position=(10, 20))           # Color range 10-19
            viewer.set_color("green", position=range(0, 10))      # Color range 0-9
            viewer.set_color({0: "red", 10: "blue"}, position=True)  # Dict mapping

            # Frame-specific
            viewer.set_color("green", frame=0)                    # Color frame 0 green

            # Combined - the powerful stuff!
            viewer.set_color("red", chain="A", frame=0)           # Color chain A in frame 0
            viewer.set_color("blue", chain="B", position=10)      # Color chain B AND position 10
            viewer.set_color("green", position=(5, 15), frame=1)  # Color positions 5-14 in frame 1
            viewer.set_color("yellow", chain="A", position=[0, 5, 10], name="protein1")  # Full control

            # Legacy format still works
            viewer.set_color({"frames": {0: "red"}})
        """
        # Find the object
        if name is None:
            # Use last object
            if not self.objects:
                print("Error: No objects exist to color.")
                return
            target_obj = self.objects[-1]
            name = target_obj.get("name", "")
        else:
            target_obj = self._find_object_by_name(name)
            if target_obj is None:
                print(f"Error: Object '{name}' not found.")
                return

        # Handle intuitive chain/position/frame parameters
        if chain is not None or position is not None:
            # Build advanced color dict from simple parameters
            advanced_color = {}

            # Handle chain coloring
            if chain is not None:
                if chain is True:
                    # Color is a dict: {"A": "red", "B": "blue"}
                    if isinstance(color, dict):
                        advanced_color["chain"] = color
                    else:
                        print("Error: When chain=True, color must be a dict like {'A': 'red', 'B': 'blue'}")
                        return
                else:
                    # chain is a string like "A"
                    advanced_color["chain"] = {str(chain): color}

            # Handle position coloring
            if position is not None:
                if position is True:
                    # Color is a dict: {0: "red", 5: "blue"}
                    if isinstance(color, dict):
                        advanced_color["position"] = color
                    else:
                        print("Error: When position=True, color must be a dict like {0: 'red', 5: 'blue'}")
                        return
                elif isinstance(position, int):
                    # Single position: position=5
                    advanced_color["position"] = {int(position): color}
                elif isinstance(position, (list, tuple, range)):
                    # Multiple positions or range
                    position_dict = {}

                    # Handle tuple as range (start, end)
                    if isinstance(position, tuple) and len(position) == 2:
                        position = range(position[0], position[1])

                    # Convert to list if range
                    if isinstance(position, range):
                        position = list(position)

                    # Build position dict
                    for pos in position:
                        position_dict[int(pos)] = color

                    advanced_color["position"] = position_dict
                else:
                    print(f"Error: position must be int, list, tuple, range, or True, got {type(position)}")
                    return

            # If frame is specified, apply to that frame only
            if frame is not None:
                frames = target_obj.get("frames", [])
                if isinstance(frame, int) and frame < len(frames):
                    # Get or create frame color dict
                    frame_color = frames[frame].get("color", {})
                    if isinstance(frame_color, dict) and frame_color.get("type") == "advanced":
                        # Merge with existing advanced color
                        existing = frame_color.get("value", {})
                        existing.update(advanced_color)
                        advanced_color = existing

                    # Normalize and store
                    normalized_color = _normalize_color(advanced_color)
                    if normalized_color:
                        frames[frame]["color"] = normalized_color
                else:
                    print(f"Error: Frame {frame} does not exist (object has {len(frames)} frames)")
                    return
            else:
                # Apply to object level - MERGE with existing advanced color
                normalized_color = _normalize_color(advanced_color)
                if normalized_color:
                    # Check if there's already an advanced color and merge
                    existing_color = target_obj.get("color")
                    if existing_color and existing_color.get("type") == "advanced":
                        # Merge the advanced dicts
                        existing_value = existing_color.get("value", {})
                        new_value = normalized_color.get("value", {})

                        # Merge chain dicts
                        if "chain" in new_value:
                            if "chain" not in existing_value:
                                existing_value["chain"] = {}
                            existing_value["chain"].update(new_value["chain"])

                        # Merge position dicts
                        if "position" in new_value:
                            if "position" not in existing_value:
                                existing_value["position"] = {}
                            existing_value["position"].update(new_value["position"])

                        # Update other keys
                        for key in ["object", "frame"]:
                            if key in new_value:
                                existing_value[key] = new_value[key]

                        target_obj["color"] = {"type": "advanced", "value": existing_value}
                    else:
                        target_obj["color"] = normalized_color
        else:
            # Standard color normalization (backward compatible)
            normalized_color = _normalize_color(color)
            if normalized_color is None:
                return

            # Handle frame-level colors if specified in legacy format
            if normalized_color.get("type") == "advanced" and normalized_color.get("value", {}).get("frames"):
                frames_spec = normalized_color["value"]["frames"]
                frames = target_obj.get("frames", [])

                # Apply frame-level colors to each frame
                for frame_idx, frame_color_spec in frames_spec.items():
                    if isinstance(frame_idx, int) and frame_idx < len(frames):
                        # Normalize the frame color
                        frame_color = _normalize_color(frame_color_spec)
                        if frame_color:
                            frames[frame_idx]["color"] = frame_color

            # Handle specific frame parameter
            if frame is not None:
                frames = target_obj.get("frames", [])
                if isinstance(frame, int) and frame < len(frames):
                    frames[frame]["color"] = normalized_color
                else:
                    print(f"Error: Frame {frame} does not exist (object has {len(frames)} frames)")
                    return
            else:
                # Store at object level
                target_obj["color"] = normalized_color

        # Send update if in live mode
        if self._is_live:
            # Get the final color to send
            if frame is not None and frame < len(target_obj.get("frames", [])):
                final_color = target_obj["frames"][frame].get("color")
            else:
                final_color = target_obj.get("color")

            if final_color and self._is_live:
                self._send_incremental_update()


    def add_pdb(self, filepath, chains=None, name=None, paes=None, align=True, use_biounit=False, biounit_name="1", load_ligands=True, contacts=None, scatter=None, color=None, scatter_config=None):
        """
        Loads a structure from a local PDB or CIF file and adds it to the viewer
        as a new frame (or object).

        This method does *not* call .show().

        Multi-model files are added as a single object.

        Args:
            filepath (str): Path to the PDB or CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            name (str, optional): Name for the object. If a different name is provided than the current object, a new object is created.
            paes (list, optional): List of PAE matrices to associate with each model.
            align (bool, optional): If True, aligns subsequent frames to the first frame.
                                   Best-view rotation is ALWAYS computed for first frame. Defaults to True.
            use_biounit (bool): If True, attempts to generate the biological assembly.
            biounit_name (str): The name of the assembly to generate (default "1").
            load_ligands (bool): If True, loads ligand atoms. Defaults to True.
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
            scatter: Optional scatter plot data for trajectory visualization. Can be:
                    - String: filepath to CSV file (first row = header with xlabel,ylabel; subsequent rows = x,y data)
                    - List/array: [[x1, y1], [x2, y2], ...] - one point per model/frame
                    When CSV is provided, xlabel/ylabel are extracted and scatter config is updated.
            color (str, optional): Color for this structure. Can be a color mode (e.g., "chain", "plddt",
                                  "rainbow", "auto", "entropy", "deepmind") or a literal color (e.g., "red", "#ff0000").
        """

        # Allow passing a 4-letter PDB code directly; fetch if local file is missing
        if isinstance(filepath, str) and len(filepath) == 4 and filepath.isalnum() and not os.path.exists(filepath):
            resolved = self._get_filepath_from_pdb_id(filepath)
            if resolved:
                filepath = resolved
        
        # --- Handle object naming logic FIRST ---
        # If name is provided, check if an object with that name already exists
        create_new_object = False
        if name is not None:
            target_obj = self._find_object_by_name(name)
            if target_obj is not None:
                # Add frames to existing object
                self._current_object_data = target_obj["frames"]
            elif self.objects and self.objects[-1]["name"] != name:
                # Different object name, create new
                create_new_object = True
        elif not self.objects:
            # No name provided and no objects exist, create first object
            create_new_object = True

        if create_new_object or not self.objects:
            self.new_obj(name, scatter_config=scatter_config)
        
        current_obj_name = self.objects[-1]["name"]
        
        # --- Process contacts if provided ---
        if contacts is not None:
            processed_contacts = self._process_contacts(contacts)
            if processed_contacts is not None:
                self.objects[-1]["contacts"] = processed_contacts

        # --- Process scatter if provided ---
        scatter_data = None
        scatter_xlabel = None
        scatter_ylabel = None
        if scatter is not None:
            processed_scatter = self._process_scatter(scatter)
            if processed_scatter is not None:
                if isinstance(processed_scatter, dict):
                    # CSV format - extract data and labels
                    scatter_data = processed_scatter["data"]
                    scatter_xlabel = processed_scatter["xlabel"]
                    scatter_ylabel = processed_scatter["ylabel"]

                    # Store labels in object-specific config instead of global config
                    if self.config["scatter"]["enabled"]:
                        if self.objects[-1]["scatter_config"] is None:
                            self.objects[-1]["scatter_config"] = {}
                        self.objects[-1]["scatter_config"]["xlabel"] = scatter_xlabel
                        self.objects[-1]["scatter_config"]["ylabel"] = scatter_ylabel
                else:
                    # List format - just data
                    scatter_data = processed_scatter

        # --- Load structure ---
        try:
            structure = gemmi.read_structure(filepath)
        except Exception as e:
            print(f"Error reading structure {filepath}: {e}")
            return
            
        models_to_process = []

        # --- BIO-UNIT LOGIC ---
        if use_biounit:
            if len(structure) == 0:
                print(f"Warning: Structure {filepath} has no models. Cannot generate biounit.")
                models_to_process = [] # Will be empty
            else:
                model_0 = structure[0] # Get first model
                assembly_obj = next((a for a in structure.assemblies if a.name == biounit_name), None)
                
                if assembly_obj:
                    try:
                        # Use the enum value we found (AddNumber)
                        how_to_name = gemmi.HowToNameCopiedChain.AddNumber
                        
                        # Call the function we found
                        biounit_model = gemmi.make_assembly(assembly_obj, model_0, how_to_name)                        
                        models_to_process.append(biounit_model) # Add the new model to our list
                    
                    except Exception as e:
                        print(f"Warning: Could not generate biounit '{biounit_name}' for {filepath}. Falling back to asymmetric unit. Error: {e}")
                        # Fallback: just process all models from the original structure
                        models_to_process = [model for model in structure]
                else:
                    print(f"Warning: Biounit '{biounit_name}' not found in {filepath}. Falling back to asymmetric unit.")
                    models_to_process = [model for model in structure]
        
        # --- ASYMMETRIC UNIT (DEFAULT) LOGIC ---
        else:
            models_to_process = [model for model in structure]
        
        # --- Process all selected models (either the biounit or all ASU models) ---
        if not models_to_process and len(structure) > 0:
             print(f"Warning: No models selected or generated for {filepath}, but structure was loaded.")
             # This can happen if biounit fails but structure had no models
             
        for i, model in enumerate(models_to_process):
            coords, plddts, position_chains, position_types, position_names, residue_numbers = self._parse_model(model, chains, load_ligands=load_ligands)

            if coords:
                coords_np = np.array(coords)
                plddts_np = np.array(plddts) if plddts else np.full(len(coords), 50.0)

                # Handle case where plddts might be empty from parse
                if len(coords_np) > 0 and len(plddts_np) != len(coords_np):
                    plddts_np = np.full(len(coords_np), 50.0)

                # Only add PAE matrix to the first model
                pae_to_add = paes[i] if paes and i < len(paes) else None

                # Extract scatter point for this model (if scatter data provided)
                scatter_to_add = scatter_data[i] if scatter_data and i < len(scatter_data) else None

                # Call add() - this will handle batch vs. live
                # Only pass name on first model to ensure all models go to same object
                model_name = name if i == 0 else None
                self.add(coords_np, plddts_np, position_chains, position_types,
                    pae=pae_to_add,
                    scatter=scatter_to_add,
                    name=model_name,
                    align=align,
                    position_names=position_names,
                    residue_numbers=residue_numbers,
                    color=color if i == 0 else None) # Only add color to first frame/model call


    def _parse_model(self, model, chains_filter, load_ligands=True):
        """
        Helper function to parse a gemmi.Model object.

        Returns:
            tuple: (coords, plddts, position_chains, position_types,
                    position_names, residue_numbers)
            - residue_numbers: List of PDB residue sequence numbers (one per position)
                              For ligands: multiple positions share the same residue number
        """
        coords = []
        plddts = []
        position_chains = []
        position_types = []
        position_names = []
        residue_numbers = []

        for chain in model:
            if chains_filter is None or chain.name in chains_filter:
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
                            position_chains.append(chain.name)
                            position_types.append('P')
                            position_names.append(residue.name)
                            residue_numbers.append(residue.seqid.num)
                            
                    elif is_nucleic:
                        c4_atom = None
                        if "C4'" in residue:
                            c4_atom = residue["C4'"][0]
                        elif "C4*" in residue:
                            c4_atom = residue["C4*"][0]
                        
                        if c4_atom:
                            coords.append(c4_atom.pos.tolist())
                            plddts.append(c4_atom.b_iso)
                            position_chains.append(chain.name)
                            rna_bases = ['A', 'C','G', 'U', 'RA', 'RC', 'RG', 'RU']
                            dna_bases = ['DA', 'DC', 'DG', 'DT', 'T']
                            if residue.name in rna_bases or residue.name.startswith('R'):
                                position_types.append('R')
                            elif residue.name in dna_bases or residue.name.startswith('D'):
                                position_types.append('D')
                            else:
                                position_types.append('R') # Default to RNA
                            position_names.append(residue.name)
                            residue_numbers.append(residue.seqid.num)
                                
                    else:
                        # Ligand: use all heavy atoms
                        if load_ligands:
                            for atom in residue:
                                if atom.element.name != 'H':
                                    coords.append(atom.pos.tolist())
                                    plddts.append(atom.b_iso)
                                    position_chains.append(chain.name)
                                    position_types.append('L')
                                    position_names.append(residue.name)
                                    residue_numbers.append(residue.seqid.num)

        return coords, plddts, position_chains, position_types, position_names, residue_numbers

    def add_contacts(self, contacts, name=None):
        """
        Add contact restraints to an object.
        
        Args:
            contacts: Either a filepath (str) to a .cst file, or a list of contact arrays.
                     Contact arrays can be:
                     - Position indices: [idx1, idx2, weight, color?]
                     - Chain+residue: [chain1, res1, chain2, res2, weight, color?]
            name (str, optional): Name of the object to add contacts to.
                                 If None, adds to the last (most recently added) object.
        
        Examples:
            # Load from file
            viewer.add_contacts("contacts.cst")
            viewer.add_contacts("contacts.cst", name="protein1")
            
            # Set programmatically
            contacts = [[10, 50, 1.0], ["A", 10, "B", 50, 0.5, {"r": 255, "g": 0, "b": 0}]]
            viewer.add_contacts(contacts)
        """
        processed_contacts = self._process_contacts(contacts)
        if processed_contacts is None:
            print("Warning: No valid contacts to add.")
            return
        
        # Find target object
        if name is None:
            # Add to last object
            if not self.objects:
                print("Error: No objects available. Add a structure first.")
                return
            target_obj = self.objects[-1]
        else:
            # Find object by name
            target_obj = None
            for obj in self.objects:
                if obj.get("name") == name:
                    target_obj = obj
                    break
            if target_obj is None:
                print(f"Error: Object '{name}' not found.")
                return
        
        # Store contacts (replace existing)
        target_obj["contacts"] = processed_contacts

        # Send update if in live mode
        if self._is_live:
            self._send_incremental_update()

    def add_bonds(self, bonds, name=None):
        """
        Define explicit bonds between atoms.

        If provided, these bonds replace the default distance-based bonding (2.0 Å cutoff).
        This is useful for ligands or other structures where the automatic bonding is inaccurate.

        Args:
            bonds: A list of bond definitions. Each bond is a list/tuple of:
                   [idx1, idx2]  - Position indices (0-based) of atoms to connect

                   Example: [[0, 1], [1, 2], [2, 3]]  # Connect atoms 0-1, 1-2, 2-3
            name (str, optional): Name of the object to add bonds to.
                                 If None, adds to the last (most recently added) object.

        Examples:
            # Define explicit bonds
            viewer.add_pdb('structure.pdb')
            bonds = [
                [0, 1],   # Connect atom 0 to atom 1
                [1, 2],   # Connect atom 1 to atom 2
                [2, 3],   # Connect atom 2 to atom 3
            ]
            viewer.add_bonds(bonds)
            viewer.show()
        """
        if bonds is None or not bonds:
            print("Warning: No valid bonds to add.")
            return

        # Validate bond format (expects list/array format [[idx1, idx2], ...])
        processed_bonds = []
        for bond in bonds:
            if isinstance(bond, (list, tuple)) and len(bond) >= 2:
                idx1, idx2 = bond[0], bond[1]
                if isinstance(idx1, int) and isinstance(idx2, int) and idx1 >= 0 and idx2 >= 0:
                    processed_bonds.append([idx1, idx2])

        if not processed_bonds:
            print("Warning: No valid bonds could be processed.")
            return

        # Find target object
        if name is None:
            # Add to last object
            if not self.objects:
                print("Error: No objects available. Add a structure first.")
                return
            target_obj = self.objects[-1]
        else:
            # Find object by name
            target_obj = None
            for obj in self.objects:
                if obj.get("name") == name:
                    target_obj = obj
                    break
            if target_obj is None:
                print(f"Error: Object '{name}' not found.")
                return

        # Store bonds (replace existing)
        target_obj["bonds"] = processed_bonds

        # Send update if in live mode
        if self._is_live:
            self._send_incremental_update()

    def _get_filepath_from_pdb_id(self, pdb_id):
        """
        Checks if a PDB ID is a file. If not, and it's a 4-char code, downloads it.
        Returns the filepath.
        """
        # Check if it's a filepath that already exists
        if os.path.exists(pdb_id):
            return pdb_id

        # Check if it's a 4-character PDB code
        if len(pdb_id) == 4 and pdb_id.isalnum():
            # Try to download the CIF file from RCSB
            pdb_code = pdb_id.upper()
            url = f"https://files.rcsb.org/download/{pdb_code}.cif"
            filepath = f"{pdb_code}.cif"
            
            # Download only if it doesn't already exist
            if not os.path.exists(filepath):
                try:
                    # print(f"Downloading {pdb_code} from RCSB...")
                    urllib.request.urlretrieve(url, filepath)
                    # print(f"Saved to {filepath}")
                    return filepath
                except urllib.error.HTTPError:
                    print(f"Error: Could not download PDB ID {pdb_code} from RCSB (URL: {url}).")
                    return None
                except Exception as e:
                    print(f"An error occurred during download: {e}")
                    return None
            else:
                # File already exists, just use it
                return filepath
        
        # If it's not an existing file and not a 4-char code, it's invalid
        print(f"Error: File or PDB ID '{pdb_id}' not found.")
        return None

    def _parse_pae_json(self, pae_filepath):
        """
        Parses PAE JSON file with support for multiple formats (matching JavaScript extractPaeFromJSON).
        
        Args:
            pae_filepath (str): Path to PAE JSON file
            
        Returns:
            np.array or None: PAE matrix as numpy array, or None if parsing fails
        """
        try:
            with open(pae_filepath, 'r') as f:
                pae_data = json.load(f)
            
            # Try different PAE JSON formats (matching JavaScript extractPaeFromJSON)
            pae_matrix = None
            
            # Format 1: Direct pae array
            if isinstance(pae_data, dict) and 'pae' in pae_data and isinstance(pae_data['pae'], list):
                pae_matrix = np.array(pae_data['pae'])
            
            # Format 2: Direct predicted_aligned_error array
            elif isinstance(pae_data, dict) and 'predicted_aligned_error' in pae_data:
                if isinstance(pae_data['predicted_aligned_error'], list):
                    pae_matrix = np.array(pae_data['predicted_aligned_error'])
                # Format 3: Nested structure (AlphaFold3)
                elif isinstance(pae_data['predicted_aligned_error'], dict):
                    nested = pae_data['predicted_aligned_error']
                    if 'pae' in nested and isinstance(nested['pae'], list):
                        pae_matrix = np.array(nested['pae'])
                    elif 'predicted_aligned_error' in nested and isinstance(nested['predicted_aligned_error'], list):
                        pae_matrix = np.array(nested['predicted_aligned_error'])
            
            # Format 4: List containing dict with predicted_aligned_error (AlphaFold DB format)
            elif isinstance(pae_data, list) and len(pae_data) > 0:
                if isinstance(pae_data[0], dict) and 'predicted_aligned_error' in pae_data[0]:
                    pae_matrix = np.array(pae_data[0]['predicted_aligned_error'])
            
            if pae_matrix is not None:
                return pae_matrix
            else:
                print(f"Warning: PAE JSON file '{pae_filepath}' has an unexpected format.")
                return None
                
        except Exception as e:
            print(f"Error parsing PAE JSON '{pae_filepath}': {e}")
            return None

    def _get_filepath_from_afdb_id(self, uniprot_id, download_pae=False):
        """
        Downloads a structure from AlphaFold DB given a UniProt ID.
        Returns the (structure_filepath, pae_filepath)
        """
        uniprot_code = uniprot_id.upper()
        
        # 1. Download Structure
        struct_url = f"https://alphafold.ebi.ac.uk/files/AF-{uniprot_code}-F1-model_v6.cif"
        struct_filepath = f"AF-{uniprot_code}.cif" 

        if not os.path.exists(struct_filepath):
            try:
                urllib.request.urlretrieve(struct_url, struct_filepath)
            except urllib.error.HTTPError:
                print(f"Error: Could not download UniProt ID {uniprot_code} from AlphaFold DB (URL: {struct_url}).")
                return None, None
            except Exception as e:
                print(f"An error occurred during structure download: {e}")
                return None, None
        
        # 2. Download PAE (if requested)
        pae_filepath = None
        if download_pae:
            pae_url = f"https://alphafold.ebi.ac.uk/files/AF-{uniprot_code}-F1-predicted_aligned_error_v6.json"
            pae_filepath = f"AF-{uniprot_code}-pae.json"
            
            if not os.path.exists(pae_filepath):
                try:
                    urllib.request.urlretrieve(pae_url, pae_filepath)
                except urllib.error.HTTPError:
                    print(f"Warning: Could not download PAE data for {uniprot_code}. (URL: {pae_url})")
                    pae_filepath = None
                except Exception as e:
                    print(f"An error occurred during PAE download: {e}")
                    pae_filepath = None
                    
        return struct_filepath, pae_filepath


    def from_pdb(self, pdb_id, chains=None, name=None, align=True, use_biounit=False, biounit_name="1", load_ligands=True, contacts=None, scatter=None, color=None, ignore_ligands=None, show=None, scatter_config=None):
        """
        Loads a structure from a PDB code (downloads from RCSB if not found locally)
        and adds it to the viewer.

        Each call creates a new object (separate structure), but all structures appear
        in the same viewer window. The viewer is displayed on the first call (unless show=False).

        Args:
            pdb_id (str): 4-character PDB code or a path to a local PDB/CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            name (str, optional): Name for the object. If not provided, uses the PDB ID.
                                  A different name will automatically create a new object.
            align (bool, optional): If True, aligns coordinates to best view. Defaults to True.
            use_biounit (bool): If True, attempts to generate the biological assembly.
            biounit_name (str): The name of the assembly to generate (default "1").
            load_ligands (bool): If True, loads ligand atoms. Defaults to True.
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
            scatter: Optional scatter plot data for trajectory visualization. Can be:
                    - String: filepath to CSV file (first row = header with xlabel,ylabel; subsequent rows = x,y data)
                    - List/array: [[x1, y1], [x2, y2], ...] - one point per model/frame
            color (str, optional): Color for this structure. Can be a color mode (e.g., "chain", "plddt",
                                  "rainbow", "auto", "entropy", "deepmind") or a literal color (e.g., "red", "#ff0000").
            ignore_ligands (bool, optional): Deprecated. If provided, overrides load_ligands.
                                            If True, skips loading ligand atoms (load_ligands=False).
            show (bool, optional): If True, automatically displays the viewer after loading (default behavior).
                                  If False, suppresses auto-display (useful when viewer is managed by Grid).
                                  If None (default), auto-shows unless viewer is in live mode.
        """
        filepath = self._get_filepath_from_pdb_id(pdb_id)

        # Auto-generate name from PDB ID if not provided
        if name is None and len(pdb_id) == 4 and pdb_id.isalnum():
            name = pdb_id.upper()

        # Backward compatibility for ignore_ligands
        if ignore_ligands is not None:
            load_ligands = not ignore_ligands

        if filepath:
            # Delegate to add_pdb for consistent handling
            self.add_pdb(
                filepath,
                chains=chains,
                name=name,
                paes=None,
                align=align,
                use_biounit=use_biounit,
                biounit_name=biounit_name,
                load_ligands=load_ligands,
                contacts=contacts,
                scatter=scatter,
                color=color,
                scatter_config=scatter_config,
            )

            # Determine whether to auto-show (mirror add_pdb + show sequence)
            if show is True or (show is None and not self._is_live):
                self.show()
        else:
            print(f"Could not load structure for '{pdb_id}'.")

    def from_afdb(self, uniprot_id, chains=None, name=None, align=True, use_biounit=False, biounit_name="1", load_ligands=True, scatter=None, color=None, show=None):
        """
        Loads a structure from an AlphaFold DB UniProt ID (downloads from EBI)
        and adds it to the viewer.

        Each call creates a new object (separate structure), but all structures appear
        in the same viewer window. The viewer is displayed on the first call (unless show=False).

        If `pae=True` was set in the `view()` constructor, this will also
        download and display the PAE matrix.

        Args:
            uniprot_id (str): UniProt accession code (e.g., "P0A8I3").
            chains (list, optional): Specific chains to load. Defaults to all.
            name (str, optional): Name for the object. If not provided, uses the UniProt ID.
                                  A different name will automatically create a new object.
            align (bool, optional): If True, aligns coordinates to best view. Defaults to True.
            use_biounit (bool): If True, attempts to generate the biological assembly.
            biounit_name (str): The name of the assembly to generate (default "1").
            load_ligands (bool): If True, loads ligand atoms. Defaults to True.
            scatter: Optional scatter plot data for trajectory visualization. Can be:
                    - String: filepath to CSV file (first row = header with xlabel,ylabel; subsequent rows = x,y data)
                    - List/array: [[x1, y1], [x2, y2], ...] - one point per model/frame
            color (str, optional): Color for this structure. Can be a literal color (e.g., "red", "#ff0000") or a color mode
                                  (e.g., "chain", "plddt", "rainbow", "auto", "entropy", "deepmind").
            show (bool, optional): If True, automatically displays the viewer after loading (default behavior).
                                  If False, suppresses auto-display (useful when viewer is managed by Grid).
                                  If None (default), auto-shows unless viewer is in live mode.
        """

        # Auto-generate name from UniProt ID if not provided
        if name is None:
            name = uniprot_id.upper()

        # --- Download structure and (maybe) PAE ---
        struct_filepath, pae_filepath = self._get_filepath_from_afdb_id(uniprot_id, download_pae=self.config["pae"]["enabled"])

        if not struct_filepath:
             print(f"Could not load structure for '{uniprot_id}'.")
             return

        # --- Parse PAE if downloaded ---
        pae_matrix = None
        if pae_filepath:
            pae_matrix = self._parse_pae_json(pae_filepath)

        # --- Add PDB (and PAE if loaded) ---
        if struct_filepath:
            self.add_pdb(struct_filepath, chains=chains,
                name=name, paes=[pae_matrix] if pae_matrix is not None else None, align=align,
                use_biounit=use_biounit, biounit_name=biounit_name,
                load_ligands=load_ligands, scatter=scatter, color=color)

            # Determine whether to auto-show
            # show=True: always show
            # show=False: never show
            # show=None (default): show if not in live mode
            if show is True:
                self.show()
            elif show is None and not self._is_live:
                self.show()
        

    def show(self):
        """
        Displays the viewer.

        - If called *before* adding data, it creates an empty "live" viewer
          that will be dynamically updated.

        - If called *after* adding data, it creates a final, 100% static
          viewer that is persistent in the notebook.

        - If already displayed (live), subsequent calls are ignored.
        """

        if self._is_live:
            return  # Already displayed, don't create a duplicate

        if not self.objects:
            # --- "Go Live" Mode ---
            # .show() was called *before* .add()
            html_to_display = self._display_viewer(static_data=None)
            self._display_html(html_to_display)
            self._is_live = True
        else:
            # --- "Publish Static" Mode ---
            # .show() was called *after* .add()
            # We set pure_static=False to enable hybrid mode (static + live)
            html_to_display = self._display_viewer(static_data=self.objects)
            self._display_html(html_to_display)
            self._is_live = True

            # Mark existing frames/metadata as already sent so later incremental
            # updates (e.g., add_contacts) don't resend full frames.
            self._sent_frame_count = {}
            self._sent_metadata = {}
            for obj in self.objects:
                obj_name = obj.get("name", "")
                if not obj_name:
                    continue
                self._sent_frame_count[obj_name] = len(obj.get("frames", []))
                current_metadata = {}
                if obj.get("color") is not None:
                    current_metadata["color"] = obj["color"]
                if obj.get("contacts") is not None:
                    current_metadata["contacts"] = obj["contacts"]
                if obj.get("bonds") is not None:
                    current_metadata["bonds"] = obj["bonds"]
                if obj.get("rotation_matrix") is not None:
                    current_metadata["rotation_matrix"] = obj["rotation_matrix"]
                if obj.get("center") is not None:
                    current_metadata["center"] = obj["center"]
                if current_metadata:
                    self._sent_metadata[obj_name] = copy.deepcopy(current_metadata)

        # Reset data display ID for new viewer
        self._data_display_id = None

    def _detect_redundant_fields(self, frames):
        """
        Detect fields that are identical across all frames.
        Returns dict of field_name: value for redundant fields.
        """
        if not frames or len(frames) == 0:
            return {}
        
        redundant = {}
        for field in ['chains', 'position_types', 'bonds']:
            # Skip if not present in any frame
            if not any(field in frame and frame[field] is not None for frame in frames):
                continue
            
            # Get first non-None value
            first_value = None
            for frame in frames:
                if field in frame and frame[field] is not None:
                    first_value = frame[field]
                    break
            
            if first_value is None:
                continue
            
            # Check if all frames have same value (or are missing/None)
            if all(
                (field in frame and frame[field] == first_value) or 
                (field not in frame or frame[field] is None)
                for frame in frames
            ):
                redundant[field] = first_value
        
        return redundant

    def save_state(self, filepath):
        """
        Saves the current viewer state (objects, frames, viewer settings, selection) to a JSON file.

        Args:
            filepath (str): Path to save the state file.
        """
        # Create directory if it doesn't exist
        try:
            dir_path = os.path.dirname(filepath) if os.path.dirname(filepath) else '.'
            os.makedirs(dir_path, exist_ok=True)
        except OSError as e:
            print(f"Error: Could not create directory for state file: {e}")
            return
        
        # Collect all objects
        objects = []
        for obj in self.objects:
            frames = []
            for frame in obj["frames"]:
                frame_data = {}

                # Round coordinates to 2 decimal places
                frame_data["coords"] = [[round(c, 2) for c in coord] for coord in frame["coords"]]

                # Round pLDDT to integers
                if "plddts" in frame:
                    frame_data["plddts"] = [round(p) for p in frame["plddts"]]

                # Copy other fields
                for key in ["chains", "position_types", "position_names", "residue_numbers", "bonds", "scatter", "color", "pae"]:
                    if key in frame:
                        frame_data[key] = frame[key]

                frames.append(frame_data)
            
            # Detect redundant fields (same across all frames)
            redundant_fields = self._detect_redundant_fields(frames)
            
            # Remove redundant fields from frames (only if identical)
            for frame in frames:
                for field in redundant_fields:
                    if field in frame and frame[field] == redundant_fields[field]:
                        del frame[field]
            
            # Create object with redundant fields at object level
            obj_to_serialize = {
                "name": obj["name"],
                "frames": frames
            }
            # Add redundant fields to object level (only if detected)
            obj_to_serialize.update(redundant_fields)

            # Add object-level data if present
            if "contacts" in obj and obj["contacts"]:
                obj_to_serialize["contacts"] = obj["contacts"]
            if "bonds" in obj and obj["bonds"]:
                obj_to_serialize["bonds"] = obj["bonds"]
            # Add scatter_config and scatter_metadata if present
            if "scatter_config" in obj and obj["scatter_config"] is not None:
                obj_to_serialize["scatter_config"] = obj["scatter_config"]
            if "scatter_metadata" in obj and obj["scatter_metadata"] is not None:
                obj_to_serialize["scatter_metadata"] = obj["scatter_metadata"]
            objects.append(obj_to_serialize)
        
        # Create state object with nested config
        state_data = {
            "version": "2.0",  # Version for nested config format
            "config": self.config,  # Save nested config directly
            "objects": objects,
            "current_object": self.objects[-1]["name"] if self.objects else None
        }
        
        # Write to file
        with open(filepath, 'w') as f:
            json.dump(state_data, f, indent=2)
        
        print(f"State saved to {filepath}")

    def load_state(self, filepath):
        """
        Loads a saved viewer state from a JSON file.

        Args:
            filepath (str): Path to the state file to load.
        """
        try:
            with open(filepath, 'r') as f:
                state_data = json.load(f)
        except FileNotFoundError:
            print(f"Error: State file '{filepath}' not found.")
            return
        except json.JSONDecodeError:
            print(f"Error: State file '{filepath}' is not valid JSON.")
            return
        
        # Clear existing objects
        self.objects = []
        self._current_object_data = None
        
        # Restore objects
        if "objects" in state_data and isinstance(state_data["objects"], list):
            for obj_data in state_data["objects"]:
                if not obj_data.get("name") or not obj_data.get("frames"):
                    print(f"Warning: Skipping invalid object in state file: {obj_data}")
                    continue
                
                # Get object-level defaults (may be None)
                obj_chains = obj_data.get("chains")
                obj_position_types = obj_data.get("position_types")
                
                self.new_obj(obj_data["name"], scatter_config=obj_data.get("scatter_config"))
                
                for frame_data in obj_data["frames"]:
                    # Convert frame data to numpy arrays
                    coords = np.array(frame_data.get("coords", []))

                    if len(coords) == 0:
                        print(f"Warning: Skipping frame with no coordinates")
                        continue

                    # Frame-level data takes precedence over object-level
                    chains = frame_data.get("chains") if "chains" in frame_data else obj_chains
                    position_types = frame_data.get("position_types") if "position_types" in frame_data else obj_position_types
                    plddts = np.array(frame_data["plddts"]) if "plddts" in frame_data else None
                    position_names = frame_data.get("position_names")
                    residue_numbers = frame_data.get("residue_numbers")
                    pae = np.array(frame_data["pae"]) if "pae" in frame_data else None
                    scatter = frame_data.get("scatter")  # Load scatter data [x, y]
                    bonds = frame_data.get("bonds")
                    color = frame_data.get("color")  # Extract frame-level color if present

                    # add() will apply defaults for None values
                    self.add(
                        coords,
                        plddts if plddts is not None and len(plddts) > 0 else None,
                        chains,
                        position_types,
                        pae=pae,
                        scatter=scatter,
                        name=None,
                        align=False,  # Don't re-align loaded data
                        position_names=position_names,
                        residue_numbers=residue_numbers,
                        bonds=bonds,
                        color=color  # Pass frame-level color to add()
                    )
                
                # Restore object-level data
                if "contacts" in obj_data:
                    self.objects[-1]["contacts"] = obj_data["contacts"]
                if "bonds" in obj_data:
                    self.objects[-1]["bonds"] = obj_data["bonds"]
                if "color" in obj_data:
                    self.objects[-1]["color"] = obj_data["color"]
                # Restore scatter config (prefer scatter_config, but accept legacy scatter_metadata)
                scatter_cfg = obj_data.get("scatter_config")
                if not scatter_cfg and obj_data.get("scatter_metadata"):
                    scatter_cfg = obj_data["scatter_metadata"]
                if scatter_cfg:
                    self.objects[-1]["scatter_config"] = scatter_cfg
        
        # Restore config (v2.0 nested format only)
        if "config" in state_data:
            self.config = state_data["config"]
        
        # State loaded - user must call show() to display
        if not self.objects:
            print("Warning: No objects loaded from state file.")
