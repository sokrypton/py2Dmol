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
    def __init__(self, size=(500,500), color="auto", shadow=True, outline=True, width=3.0, rotate=False):
        self.size = size
        self._initial_color_mode = color # Store the user's requested mode
        self._resolved_color_mode = color # This will become 'rainbow' or 'chain' if 'auto'
        
        # --- NEW: Store default states ---
        self._initial_shadow_enabled = shadow
        self._initial_outline_enabled = outline
        self._initial_width = width
        self._initial_rotate = rotate
        
        self._initial_data_loaded = False
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._trajectory_counter = 0
        self._viewer_id = str(uuid.uuid4())  # Unique ID for this viewer instance

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
                js_code = f"window.handlePythonUpdate(`{json_data_escaped}`);"
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

    def _display_viewer(self):
        """Internal: Renders the iframe and handshake script for the first time."""
        try:
            with importlib.resources.open_text(py2dmol_resources, 'pseudo_3D_viewer.html') as f:
                html_template = f.read()
        except FileNotFoundError:
            print("Error: Could not find the HTML template file.")
            return

        # Use the resolved color mode for the config sent to HTML
        viewer_config = {
            "size": self.size,
            "color": self._resolved_color_mode, # Send 'rainbow' or 'chain'
            "viewer_id": self._viewer_id,
            "default_shadow": self._initial_shadow_enabled,
            "default_outline": self._initial_outline_enabled,
            "default_width": self._initial_width,
            "default_rotate": self._initial_rotate
        }
        config_script = f"""
        <script id="viewer-config">
          window.viewerConfig = {json.dumps(viewer_config)};
        </script>
        """
        
        # NOTE: Initial data is now sent via an 'add' message, so proteinData is empty.
        data_script = f"""
        <script id="protein-data">
          window.proteinData = {{ "coords": [], "plddts": [], "chains": [], "atom_types": [] }};
        </script>
        """
        
        injection_scripts = config_script + "\n" + data_script
        
        if not IS_COLAB:
            # For Jupyter: wrap in iframe with srcdoc
            final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
            # Escape for srcdoc attribute
            final_html_escaped = final_html.replace('"', '&quot;').replace("'", '&#39;')
            
            # Add the queueing and handshake listener script
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
            
            # MODIFIED: Width remains at 220px
            iframe_html = f"""
            <iframe 
                data-viewer-id="{self._viewer_id}"
                srcdoc="{final_html_escaped}"
                style="width: {self.size[0] + 220}px; height: {self.size[1] + 80}px; border: none;"
                sandbox="allow-scripts allow-same-origin"
            ></iframe>
            {handshake_script}
            """
            display(HTML(iframe_html))
        else:
            # For Colab: use direct HTML
            final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
            display(HTML(final_html))


    def clear(self):
        """Clears all trajectories and frames from the viewer."""
        if self._initial_data_loaded:
            self._send_message({
                "type": "py2DmolClearAll"
            })
        
        # Reset Python-side state
        self._initial_data_loaded = False # Next call to add() will need to re-display
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._trajectory_counter = 0

    def new_traj(self, trajectory_name=None):
        # This is a new trajectory, reset the alignment reference
        self._coords = None 
        if trajectory_name is None:
            trajectory_name = f"{self._trajectory_counter}"
        self._trajectory_counter += 1
        self._send_message({
            "type": "py2DmolNewTrajectory",
            "name": trajectory_name
        })

    def add(self, coords, plddts=None, chains=None, atom_types=None, new_traj=False, trajectory_name=None):
        """
        Adds a new frame of data to the viewer.
        If this is the first time 'add' is called, it will display the viewer.
        
        Args:
            coords (np.array): Nx3 array of coordinates.
            plddts (np.array, optional): N-length array of pLDDT scores.
            chains (list, optional): N-length list of chain identifiers.
            atom_types (list, optional): N-length list of atom types ('P', 'D', 'R', 'L').
            new_traj (bool, optional): If True, starts a new trajectory. Defaults to False.
        """
        
        # --- MODIFIED: Auto-color logic ---
        # If this is the first data being added AND color is 'auto', decide now.
        if not self._initial_data_loaded and self._initial_color_mode == "auto":
            if chains is not None:
                unique_chains = set(c for c in chains if c and c.strip())
                if len(unique_chains) > 1:
                    self._resolved_color_mode = "chain"
                else:
                    self._resolved_color_mode = "rainbow"
            else:
                 # If no chains provided for the first frame, default to rainbow
                self._resolved_color_mode = "rainbow"
        elif not self._initial_data_loaded:
             # If color was specified (not auto), use it directly
             self._resolved_color_mode = self._initial_color_mode
        # --- END MODIFIED BLOCK ---

        # 1. Display the iframe if this is the very first call
        # This now uses self._resolved_color_mode which is no longer "auto"
        if not self._initial_data_loaded:
            self._display_viewer()
            self._initial_data_loaded = True
            new_traj = True # First call always starts a new trajectory

        # 2. Handle new trajectory creation
        if new_traj:
            self.new_traj(trajectory_name)

        # 3. Update Python-side state (aligns to self._coords)
        # If new_traj was true, self._coords was None, so this just sets self._coords = coords
        # If new_traj was false, this aligns coords to the previous frame in this trajectory
        self._update(coords, plddts, chains, atom_types)

        # 4. Send the frame data
        self._send_message({
            "type": "py2DmolUpdate",
            "payload": self._get_data_dict() # _get_data_dict uses self._coords, which is now aligned
        })

    def add_pdb(self, filepath, chains=None, new_traj=False, trajectory_name=None):
        """
        Loads a structure from a PDB or CIF file and adds it to the viewer.
        Multi-model files are added as a single trajectory.
        
        Args:
            filepath (str): Path to the PDB or CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            new_traj (bool, optional): If True, starts a new trajectory. Defaults to False.
            trajectory_name (str, optional): Name for the new trajectory.
        """
        structure = gemmi.read_structure(filepath)
        
        first_model_added = False
        for model in structure:
            
            # Default behavior: process the model from the file directly
            model_to_process = model

            coords = []
            plddts = []
            atom_chains = []
            atom_types = []

            # Now, iterate over the chains in the *processed* model (either ASU or biounit)
            for chain in model_to_process:
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
                
                # Only honor new_traj for the *first* model
                current_model_new_traj = new_traj and not first_model_added
                
                # Call add() - this will handle auto-color on the first call
                self.add(coords, plddts, atom_chains, atom_types,
                    new_traj=current_model_new_traj, trajectory_name=trajectory_name)
                first_model_added = True

    from_pdb = add_pdb