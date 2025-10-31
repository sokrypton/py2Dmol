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
    def __init__(self, size=(500,500), color="auto", shadow=True, outline=True, width=3.0, rotate=False,
                 hide_controls=False, autoplay=False, hide_box=False):
        self.size = size
        self._initial_color_mode = color # Store the user's requested mode
        self._resolved_color_mode = color # This will become 'rainbow' or 'chain' if 'auto'
        
        self._initial_shadow_enabled = shadow
        self._initial_outline_enabled = outline
        self._initial_width = width
        self._initial_rotate = rotate
        self._initial_hide_controls = hide_controls
        self._initial_autoplay = autoplay
        self._initial_hide_box = hide_box
        
        self._viewer_id = str(uuid.uuid4())  # Unique ID for this viewer instance
        
        # --- NEW STATE ---
        # The viewer's mode is determined by when .show() is called.
        self.trajectories = []               # Store all data
        self._current_trajectory_data = None # List to hold frames for current trajectory
        self._is_live = False                # True if .show() was called *before* .add()
        
        # --- Alignment/Dynamic State ---
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None

    def _get_data_dict(self):
        """Serializes the current coordinate state to a dict."""
        payload = {
            "coords": self._coords.tolist(),
            "plddts": self._plddts.tolist(),
            "chains": list(self._chains),
            "atom_types": list(self._atom_types)
        }
        return payload

    def _update(self, coords, plddts=None, chains=None, atom_types=None):
      """Updates the internal state with new data, aligning coords."""
      if self._coords is None:
        self._coords = coords
      else:
        if self._coords.shape == coords.shape:
            self._coords = align_a_to_b(coords, self._coords)
        else:
            # Atom counts differ, just use the new coords without aligning
            # This can happen in multi-model PDBs
            self._coords = coords
      
      n_atoms = self._coords.shape[0]

      # 1. Handle pLDDTs
      if plddts is not None:
          # New data is provided, use it
          self._plddts = plddts
      elif self._plddts is None or len(self._plddts) != n_atoms:
          # No new data, and old data is missing or wrong size, create default
          self._plddts = np.full(n_atoms, 50.0)
      # Else: plddts is None, but self._plddts is valid and correct size, so keep it.

      # 2. Handle Chains
      if chains is not None:
          self._chains = chains
      elif self._chains is None or len(self._chains) != n_atoms:
          self._chains = ["A"] * n_atoms
      
      # 3. Handle Atom Types
      if atom_types is not None:
          self._atom_types = atom_types
      elif self._atom_types is None or len(self._atom_types) != n_atoms:
          self._atom_types = ["P"] * n_atoms

      # Ensure all arrays have the same length as coords (final safety check)
      if len(self._plddts) != n_atoms:
          print(f"Warning: pLDDT length mismatch. Resetting to default.")
          self._plddts = np.full(n_atoms, 50.0)
      if len(self._chains) != n_atoms:
          print(f"Warning: Chains length mismatch. Resetting to default.")
          self._chains = ["A"] * n_atoms
      if len(self._atom_types) != n_atoms:
          print(f"Warning: Atom types length mismatch. Resetting to default.")
          self._atom_types = ["P"] * n_atoms

    def _send_message(self, message_dict):
        """Robustly send a message to the viewer, queuing if not ready."""
        viewer_id = self._viewer_id
        message_json = json.dumps(message_dict)

        if IS_COLAB:
            # Colab logic is simple: just execute the JS
            js_code = ""
            if message_dict['type'] == 'py2DmolUpdate':
                json_data = json.dumps(message_dict['payload'])
                json_data_escaped = json_data.replace('\\', '\\\\').replace('`', '\\`').replace('$', '\\$')
                # Escape trajectory name for JS string
                traj_name_escaped = message_dict['trajectoryName'].replace("'", "\\'")
                js_code = f"window.handlePythonUpdate(`{json_data_escaped}`, '{traj_name_escaped}');"
            elif message_dict['type'] == 'py2DmolNewTrajectory':
                js_code = f"window.handlePythonNewTrajectory('{message_dict['name']}');"
            elif message_dict['type'] == 'py2DmolClearAll':
                js_code = "window.handlePythonClearAll();"
            
            if js_code:
                try:
                    output.eval_js(js_code, ignore_result=True)
                except Exception as e:
                    print(f"Error sending message (Colab): {e}")

        else:
            # Jupyter logic: queue or send
            js_code = f"""
            (function() {{
                // 1. Ensure global queue and ready flags exist
                if (!window.py2dmol_queue) window.py2dmol_queue = {{}};
                if (!window.py2dmol_ready_flags) window.py2dmol_ready_flags = {{}};
                
                // 2. Ensure queue exists for this *specific* viewer
                if (!window.py2dmol_queue['{viewer_id}']) {{
                    window.py2dmol_queue['{viewer_id}'] = [];
                }}

                let msg = {message_json};
                
                // 3. Check if this iframe is ready
                if (window.py2dmol_ready_flags['{viewer_id}'] === true) {{
                    // Ready: find iframe and send immediately
                    let iframe = document.querySelector('iframe[data-viewer-id="{viewer_id}"]');
                    if (iframe && iframe.contentWindow) {{
                        iframe.contentWindow.postMessage(msg, '*');
                    }} else {{
                         console.error('py2Dmol: iframe {viewer_id} was ready but not found. Re-queuing.');
                         window.py2dmol_queue['{viewer_id}'].push(msg);
                    }}
                }} else {{
                    // Not ready: push to queue
                    window.py2dmol_queue['{viewer_id}'].push(msg);
                }}
            }})();
            """
            display(Javascript(js_code))

    def _display_viewer(self, static_data=None, pure_static=False):
        """
        Internal: Renders the iframe and handshake script.
        
        Args:
            static_data (list, optional):
                - A list of trajectories (for static 'show()' or hybrid modes).
            pure_static (bool, optional):
                - If True, this is a final static viewer (from .show())
                - If False, this is a dynamic viewer that needs listeners.
                
        Returns:
            str: The complete HTML string to be displayed.
        """
        try:
            with importlib.resources.open_text(py2dmol_resources, 'pseudo_3D_viewer.html') as f:
                html_template = f.read()
        except FileNotFoundError:
            print("Error: Could not find the HTML template file.")
            return "" # Return empty string on error

        # Use the resolved color mode for the config sent to HTML
        viewer_config = {
            "size": self.size,
            "color": self._resolved_color_mode, # Send 'rainbow' or 'chain'
            "viewer_id": self._viewer_id,
            "default_shadow": self._initial_shadow_enabled,
            "default_outline": self._initial_outline_enabled,
            "default_width": self._initial_width,
            "default_rotate": self._initial_rotate,
            "hide_controls": self._initial_hide_controls,
            "autoplay": self._initial_autoplay,
            "hide_box": self._initial_hide_box
        }
        config_script = f"""
        <script id="viewer-config">
          window.viewerConfig = {json.dumps(viewer_config)};
        </script>
        """
        
        data_script = ""
        # A "pure static" viewer (from .show(after_add)) doesn't need the handshake.
        # A "dynamic" viewer (from .show(before_add)) DOES.
        is_dynamic_viewer = not pure_static
        
        if static_data and isinstance(static_data, list):
            # Static 'show()' or 'Hybrid' mode: inject all trajectories
            data_json = json.dumps(static_data)
            data_script = f'<script id="static-data">window.staticTrajectoryData = {data_json};</script>'
        else:
            # Pure Dynamic mode: inject empty data, will be populated by messages
            data_script = '<script id="protein-data">window.proteinData = {{ "coords": [], "plddts": [], "chains": [], "atom_types": [] }};</script>'
        
        injection_scripts = config_script + "\n" + data_script
        
        final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
            
        iframe_width = self.size[0]
        if not self._initial_hide_controls:
            iframe_width += 180 # Width of side panel
        
        iframe_height = self.size[1]
        if not self._initial_hide_controls:
             iframe_height += 80 # Height for anim controls

        if not IS_COLAB:
            # For Jupyter: wrap in iframe with srcdoc
            # Escape for srcdoc attribute
            final_html_escaped = final_html.replace('"', '&quot;').replace("'", '&#39;')
            
            # --- Only add handshake script if it's a DYNAMIC viewer ---
            handshake_script = ""
            if is_dynamic_viewer:
                handshake_script = f"""
                <script>
                    // 1. Setup global queue and iframe readiness state
                    if (!window.py2dmol_queue) window.py2dmol_queue = {{}};
                    if (!window.py2dmol_ready_flags) window.py2dmol_ready_flags = {{}};
                    
                    // 2. Initialize queue and flag for this *specific* viewer
                    if (!window.py2dmol_queue['{self._viewer_id}']) {{
                        window.py2dmol_queue['{self._viewer_id}'] = [];
                    }}
                    window.py2dmol_ready_flags['{self._viewer_id}'] = false;
                
                    // 3. Define the 'message' listener (do this only once)
                    if (!window.py2dmol_message_listener_added) {{
                        window.addEventListener('message', (event) => {{
                            // Check for our specific "ready" message
                            if (event.data && event.data.type === 'py2dmol_ready' && event.data.viewer_id) {{
                                let viewerId = event.data.viewer_id;
                                
                                // 3a. Mark this viewer as ready
                                window.py2dmol_ready_flags[viewerId] = true;
                                
                                // 3b. Find the correct iframe
                                let iframe = document.querySelector(`iframe[data-viewer-id="${{viewerId}}"]`);
                                if (!iframe || !iframe.contentWindow) {{
                                    console.error(`py2Dmol: Received ready signal from ${{viewerId}} but cannot find iframe.`);
                                    return;
                                }}

                                // 3c. Process any pending messages for this viewer
                                let queue = window.py2dmol_queue[viewerId];
                                if (queue) {{
                                    while (queue.length > 0) {{
                                        let msg = queue.shift();
                                        iframe.contentWindow.postMessage(msg, '*');
                                    }}
                                }}
                            }}
                        }});
                        // Mark listener as added so we don't add it multiple times
                        window.py2dmol_message_listener_added = true;
                    }}
                </script>
                """
            
            iframe_html = f"""
            <iframe 
                data-viewer-id="{self._viewer_id}"
                srcdoc="{final_html_escaped}"
                style="width: {iframe_width}px; height: {iframe_height}px; border: none;"
                sandbox="allow-scripts allow-same-origin"
            ></iframe>
            {handshake_script}
            """
            return iframe_html
        else:
            # For Colab: use direct HTML
            # Wrap Colab output in a div for widget clearing
            colab_html = f"""
            <div data-viewer-id="{self._viewer_id}" style="width: {iframe_width}px; height: {iframe_height}px; position: relative;">
                {final_html}
            </div>
            """
            return colab_html

    def _display_html(self, html_string):
        """Displays the HTML simply, without widgets."""
        # We no longer use ipywidgets, just display directly.
        # The .show() method will now print a *new* cell.
        display(HTML(html_string))

    def clear(self):
        """Clears all trajectories and frames from the viewer."""
        # Clear python data
        self.trajectories = []
        self._current_trajectory_data = None
            
        # Dynamic mode: send clear message if viewer is active
        if self._is_live:
            self._send_message({
                "type": "py2DmolClearAll"
            })
            
        # Reset python state
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._is_live = False
        
        # We can't clear the output cell, so we just reset state
        # and the user can clear the cell manually if needed.
        print("py2dmol: Viewer state cleared. Re-run .add() or .show() to display again.")


    def new_traj(self, trajectory_name=None):
        """Starts a new trajectory for subsequent 'add' calls."""
        
        # This is a new trajectory, reset the alignment reference
        self._coords = None 
        self._plddts = None
        self._chains = None
        self._atom_types = None

        if trajectory_name is None:
            trajectory_name = f"{len(self.trajectories)}"
            
        # Always update the python-side data
        self._current_trajectory_data = [] # List to hold frames
        self.trajectories.append({
            "name": trajectory_name,
            "frames": self._current_trajectory_data
        })
        
        # Send message *only if* in dynamic/hybrid mode and already displayed
        if self._is_live:
            self._send_message({
                "type": "py2DmolNewTrajectory",
                "name": trajectory_name
            })
    
    def _resolve_auto_color(self, chains=None):
        """
        Internal: Resolves 'auto' color mode if this is the first
        time data is being added.
        """
        if not self._is_live and not self.trajectories and self._initial_color_mode == "auto":
            if chains is not None:
                unique_chains = set(c for c in chains if c and c.strip())
                if len(unique_chains) > 1:
                    self._resolved_color_mode = "chain"
                else:
                    self._resolved_color_mode = "rainbow"
            else:
                self._resolved_color_mode = "rainbow"
        elif not self._is_live and not self.trajectories:
             self._resolved_color_mode = self._initial_color_mode
                
    def add(self, coords, plddts=None, chains=None, atom_types=None, new_traj=False, trajectory_name=None):
        """
        Adds a new *frame* of data to the viewer.
        
        Behavior depends on when .show() is called.
        
        Args:
            coords (np.array): Nx3 array of coordinates.
            plddts (np.array, optional): N-length array of pLDDT scores.
            chains (list, optional): N-length list of chain identifiers.
            atom_types (list, optional): N-length list of atom types ('P', 'D', 'R', 'L').
            new_traj (bool, optional): If True, starts a new trajectory. Defaults to False.
        """
        
        # --- Step 1: Handle "Auto-Color" Resolution ---
        self._resolve_auto_color(chains)

        # --- Step 2: Update Python-side alignment state ---
        # The call to _update() will correctly align the new coords to the existing
        # self._coords reference and then update self._coords with the new, aligned data.
        # BUGFIX: Removed line: self._coords = coords
        self._update(coords, plddts, chains, atom_types) # This handles defaults
        data_dict = self._get_data_dict() # This reads the full, correct data

        # --- Step 3: Handle trajectory creation ---
        if new_traj or not self.trajectories:
            self.new_traj(trajectory_name)
        
        # Safeguard: ensure _current_trajectory_data exists
        if self._current_trajectory_data is None:
            self.new_traj(trajectory_name)
            
        # --- Step 4: Always save data to Python list ---
        self._current_trajectory_data.append(data_dict)

        # --- Step 5: Send message if in "live" mode ---
        if self._is_live:
            self._send_message({
                "type": "py2DmolUpdate",
                "trajectoryName": self.trajectories[-1]["name"],
                "payload": data_dict
            })

    def append(self, coords, plddts=None, chains=None, atom_types=None):
        """
        Appends coordinates to the *current frame*.
        This is for building a single frame from multiple components.
        
        NOTE: This only works reliably in "batch" mode (before .show() is called).
        """
        
        if self._is_live:
            print("Warning: .append() is not supported in 'live' mode. Use .add() to add new frames.")
            self.add(coords, plddts, chains, atom_types) # Fallback
            return

        # --- Batch Mode Logic ---
        
        # --- Step 1: Handle "Auto-Color" Resolution ---
        self._resolve_auto_color(chains)
        
        # --- Step 2: Ensure a trajectory exists ---
        if not self.trajectories: self.new_traj()
        if self._current_trajectory_data is None: self.new_traj()
            
        # --- Step 3: Prepare new data (defaults) ---
        n_new = coords.shape[0]
        new_coords = coords
        new_plddts = plddts if plddts is not None else np.full(n_new, 50.0)
        new_chains = chains if chains is not None else ["A"] * n_new
        new_atom_types = atom_types if atom_types is not None else ["P"] * n_new
        
        # --- Step 4: Align new coords ---
        # We align the *new* coords to the *last* coords added
        if self._coords is None:
            aligned_new_coords = new_coords
        else:
            # Only align if shapes are compatible for alignment
            if self._coords.shape == new_coords.shape:
                aligned_new_coords = align_a_to_b(new_coords, self._coords)
            else:
                # If not, try aligning to the mean
                try:
                    new_mean = new_coords.mean(-2, keepdims=True)
                    ref_mean = self._coords.mean(-2, keepdims=True)
                    aligned_new_coords = new_coords - new_mean + ref_mean
                except Exception:
                    aligned_new_coords = new_coords # Can't align, just use original
        
        # --- Step 5: Update the alignment reference for next time ---
        # The reference is *only* the last component.
        self._coords = aligned_new_coords 
        
        # --- Step 6: Get or create current frame ---
        if not self._current_trajectory_data:
            # This is the first component of the frame
            data_dict = {
                "coords": aligned_new_coords.tolist(),
                "plddts": new_plddts.tolist(),
                "chains": list(new_chains),
                "atom_types": list(new_atom_types)
            }
            self._current_trajectory_data.append(data_dict)
        else:
            # Pop the last frame to modify it
            last_frame_data = self._current_trajectory_data.pop()
            
            # Combine old and new (aligned) data
            combined_data = {
                "coords": last_frame_data['coords'] + aligned_new_coords.tolist(),
                "plddts": last_frame_data['plddts'] + new_plddts.tolist(),
                "chains": last_frame_data['chains'] + list(new_chains),
                "atom_types": last_frame_data['atom_types'] + list(new_atom_types)
            }
            
            # Push the modified frame back
            self._current_trajectory_data.append(combined_data)

    def add_pdb(self, filepath, chains=None, new_traj=False, trajectory_name=None):
        """
        Loads a structure from a PDB or CIF file and adds it to the viewer
        as a new frame (or trajectory).
        
        Multi-model files are added as a single trajectory.
        
        Args:
            filepath (str): Path to the PDB or CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            new_traj (bool, optional): If True, starts a new trajectory. Defaults to False.
            trajectory_name (str, optional): Name for the new trajectory.
        """
        
        # --- Now, process the file ---
        structure = gemmi.read_structure(filepath)
        
        # --- Handle new_traj logic ---
        if new_traj or not self.trajectories:
             # This call will set up the trajectory in python
             # AND send a message if in "live" mode
             self.new_traj(trajectory_name)
        
        current_traj_name = self.trajectories[-1]["name"]

        # --- Simplified Logic ---
        # Just call .add() for each model.
        # .add() will automatically handle batching vs. sending.
        for model in structure:
            model_to_process = model
            coords, plddts, atom_chains, atom_types = self._parse_model(model_to_process, chains)

            if coords:
                coords_np = np.array(coords)
                plddts_np = np.array(plddts) if plddts else np.full(len(coords), 50.0)
                if len(coords_np) > 0 and len(plddts_np) == 0:
                    plddts_np = np.full(len(coords_np), 50.0)

                # Call add() - this will handle batch vs. live
                self.add(coords_np, plddts_np, atom_chains, atom_types,
                    new_traj=False, trajectory_name=current_traj_name)

    def append_pdb(self, filepath, chains=None):
        """
        Loads a structure from a PDB or CIF file and *appends* it
        to the current frame.
        
        NOTE: This only works reliably in "batch" mode (before .show() is called).
        
        Args:
            filepath (str): Path to the PDB or CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
        """
        if self._is_live:
            print("Warning: .append_pdb() is not supported in 'live' mode. Use .add_pdb() to add new frames.")
            self.add_pdb(filepath, chains=chains) # Fallback
            return

        # --- Batch Mode Logic ---
        structure = gemmi.read_structure(filepath)
        
        # Append each model's data to the current frame
        for model in structure:
            model_to_process = model
            coords, plddts, atom_chains, atom_types = self._parse_model(model_to_process, chains)

            if coords:
                coords_np = np.array(coords)
                plddts_np = np.array(plddts) if plddts else np.full(len(coords), 50.0)
                if len(coords_np) > 0 and len(plddts_np) == 0:
                    plddts_np = np.full(len(coords_np), 50.0)

                # Call append() - this will handle batch vs. live
                self.append(coords_np, plddts_np, atom_chains, atom_types)

    def _parse_model(self, model, chains_filter):
        """Helper function to parse a gemmi.Model object."""
        coords = []
        plddts = []
        atom_chains = []
        atom_types = []

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
                            rna_bases = ['A', 'C','G', 'U', 'RA', 'RC', 'RG', 'RU']
                            dna_bases = ['DA', 'DC', 'DG', 'DT', 'T']
                            if residue.name in rna_bases or residue.name.startswith('R'):
                                atom_types.append('R')
                            elif residue.name in dna_bases or residue.name.startswith('D'):
                                atom_types.append('D')
                            else:
                                atom_types.append('R') # Default to RNA
                                
                    else:
                        # Ligand: use all heavy atoms
                        for atom in residue:
                            if atom.element.name != 'H':
                                coords.append(atom.pos.tolist())
                                plddts.append(atom.b_iso)
                                atom_chains.append(chain.name)
                                atom_types.append('L')
        return coords, plddts, atom_chains, atom_types

    def from_pdb(self, filepath, chains=None, new_traj=False, trajectory_name=None):
        """
        [DEPRECATED] Loads a PDB/CIF file and immediately displays it statically.
        
        This method is for backward compatibility.
        It is recommended to use:
            viewer.add_pdb(...)
            viewer.show()
        """
        self.add_pdb(filepath, chains=chains, new_traj=new_traj, trajectory_name=trajectory_name)
        self.show()

    def show(self):
        """
        Displays the viewer.
        
        - If called *before* adding data, it creates an empty "live" viewer
          that will be dynamically updated.
        
        - If called *after* adding data, it creates a final, 100% static
          viewer that is persistent in the notebook.
        """
        
        if not self.trajectories:
            # --- "Go Live" Mode ---
            # .show() was called *before* .add()
            html_to_display = self._display_viewer(static_data=None, pure_static=False)
            self._display_html(html_to_display)
            self._is_live = True
        else:
            # --- "Publish Static" Mode ---
            # .show() was called *after* .add()
            html_to_display = self._display_viewer(static_data=self.trajectories, pure_static=False)
            self._display_html(html_to_display)
            self._is_live = True