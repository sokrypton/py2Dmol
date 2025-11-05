import json
import numpy as np
from IPython.display import display, HTML, Javascript
    
import importlib.resources
from . import resources as py2dmol_resources
import gemmi
import uuid
import os
import urllib.request

def kabsch(a, b, return_v=False):
  """Computes the optimal rotation matrix for aligning a to b."""
  ab = a.swapaxes(-1, -2) @ b
  u, s, vh = np.linalg.svd(ab, full_matrices=False)
  flip = np.linalg.det(u @ vh) < 0
  flip_b = flip[..., None]
  u_last_col_flipped = np.where(flip_b, -u[..., -1], u[..., -1])
  u[..., -1] = u_last_col_flipped
  if return_v:
    return u
  else:
    return u @ vh

def best_view(a):
  a_mean = a.mean(-2, keepdims=True)
  a_cent = a - a_mean
  v = kabsch(a_cent, a_cent, return_v=True)
  a_aligned = (a_cent @ v) + a_mean
  return a_aligned

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
    def __init__(self, size=(300,300), controls=True, box=True,
        color="auto", colorblind=False, pastel=0.25, shadow=True,
        outline=True, width=3.0, ortho=150.0, rotate=False, autoplay=False,
        pae=False, pae_size=(300,300), reuse_js=False,
    ):
        self.config = {
            "size": size,
            "controls": controls,
            "box": box,
            "color": color,
            "colorblind": colorblind,
            "pastel": pastel,
            "shadow": shadow,
            "outline": outline,
            "width": width,
            "ortho": ortho,
            "rotate": rotate,
            "autoplay": autoplay,
            "pae": pae,
            "pae_size": pae_size,
            "viewer_id": str(uuid.uuid4()),
        }
        
        # The viewer's mode is determined by when .show() is called.
        self.objects = []                 # Store all data
        self._current_object_data = None  # List to hold frames for current object
        self._is_live = False             # True if .show() was called *before* .add()
        self._reuse_js = reuse_js
        
        # --- Alignment/Dynamic State ---
        self._coords = None
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._pae = None

    def _get_data_dict(self):
        """Serializes the current coordinate state to a dict."""
        
        # Round arrays before converting to list
        # Coords to 3 decimal places (float)
        rounded_coords = np.round(self._coords, 2)
        
        # pLDDTs to 0 decimal places (integer)
        rounded_plddts = np.round(self._plddts, 0).astype(int)
        
        rounded_pae = None
        if self._pae is not None:
            # PAE to 0 decimal places (integer)
            rounded_pae = np.round(self._pae, 0).astype(int).tolist()

        payload = {
            "coords": rounded_coords.tolist(),
            "plddts": rounded_plddts.tolist(),
            "chains": list(self._chains),
            "atom_types": list(self._atom_types),
            "pae": rounded_pae
        }
        return payload

    def _update(self, coords, plddts=None, chains=None, atom_types=None, pae=None, align=True):
      """Updates the internal state with new data, aligning coords."""
      if self._coords is None:
        self._coords = best_view(coords) if align else coords
      else:
        if align and self._coords.shape == coords.shape:
            self._coords = align_a_to_b(coords, self._coords)
        else:
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
          
      # 4. Handle PAE
      self._pae = pae # Store PAE matrix (or None)

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
        """Generates JS to directly call the viewer's API."""
        viewer_id = self.config["viewer_id"]
        msg_type = message_dict.get("type")
        
        js_code_inner = "" # The specific call
        
        if msg_type == "py2DmolUpdate":
            payload = message_dict.get("payload")
            # Create a Python string containing JSON
            payload_json_string = json.dumps(payload) 
            # Create a JavaScript string literal *from* that JSON string
            payload_js_literal = json.dumps(payload_json_string) 
            
            object_name = message_dict.get("objectName", "")
            js_code_inner = f"window.py2dmol_viewers['{viewer_id}'].handlePythonUpdate({payload_js_literal}, '{object_name}');"
        
        elif msg_type == "py2DmolNewObject":
            name = message_dict.get("name", "")
            js_code_inner = f"window.py2dmol_viewers['{viewer_id}'].handlePythonNewObject('{name}');"
        
        elif msg_type == "py2DmolClearAll":
            js_code_inner = f"window.py2dmol_viewers['{viewer_id}'].handlePythonClearAll();"
            
        elif msg_type == "py2DmolSetColor":
            color = message_dict.get("color", "auto")
            js_code_inner = f"window.py2dmol_viewers['{viewer_id}'].handlePythonSetColor('{color}');"
            
        if js_code_inner:
            # Wrap in a check for safety
            js_code = f"""
            (function() {{
                if (window.py2dmol_viewers && window.py2dmol_viewers['{viewer_id}']) {{
                    {js_code_inner}
                }} else {{
                    console.error("py2dmol: Viewer '{viewer_id}' not found.");
                }}
            }})();
            """
            display(Javascript(js_code))

    def _display_viewer(self, static_data=None):
        """
        Internal: Renders the viewer's HTML directly into a div.
        
        Args:
            static_data (list, optional):
                - A list of objects (for static 'show()' or hybrid modes).
                
        Returns:
            str: The complete HTML string to be displayed.
        """
        with importlib.resources.open_text(py2dmol_resources, 'py2Dmol_viewer.html') as f:
            html_template = f.read()

        config_script = f"""
        <script id="viewer-config">
          window.viewerConfig = {json.dumps(self.config)};
        </script>
        """
        
        data_script = ""
        
        if static_data and isinstance(static_data, list):
            # --- START NEW LOGIC (Plan 2, Corrected) ---
            # Create a new, lighter list for serialization
            serialized_objects = []
            for py_obj in static_data: # static_data is self.objects
                if not py_obj.get("frames"):
                    continue
                    
                # Take static data from the *first* frame
                first_frame = py_obj["frames"][0]
                static_chains = first_frame.get("chains", [])
                static_atom_types = first_frame.get("atom_types", [])
                
                # Find the first non-None PAE matrix to store - NO, PAE is per-frame
                # static_pae = None ... (REMOVED)
                
                # Create a list of frames containing coords, plddts, AND pae
                light_frames = [
                    {
                        "coords": frame.get("coords"),
                        "plddts": frame.get("plddts"),
                        "pae": frame.get("pae") # PAE is per-frame
                    } for frame in py_obj["frames"]
                ]
                
                serialized_objects.append({
                    "name": py_obj.get("name"),
                    "chains": static_chains,
                    "atom_types": static_atom_types,
                    # "pae": None, # (REMOVED)
                    "frames": light_frames # This list is much smaller
                })

            data_json = json.dumps(serialized_objects)
            # --- END NEW LOGIC (Plan 2, Corrected) ---
            
            data_script = f'<script id="static-data">window.staticObjectData = {data_json};</script>'
        else:
            # Pure Dynamic mode: inject empty data, will be populated by messages
            data_script = '<script id="protein-data">window.proteinData = {{ "coords": [], "plddts": [], "chains": [], "atom_types": [], "pae": null }};</script>'
        
        injection_scripts = config_script + "\n" + data_script
        
        # Inject config and data into the raw HTML template
        final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)
            
        viewer_id = self.config["viewer_id"]
        
        # NEW: Create a container div and a script to initialize the viewer
        # We add style="position: relative;" to help with any potential
        # absolute positioning inside the component, and inline-block to fit content.
        container_html = f"""
        <div id="{viewer_id}" style="position: relative; display: inline-block; line-height: 0;">
            {final_html}
        </div>
        <script>
            (function() {{
                // Find the container we just rendered
                const container = document.getElementById("{viewer_id}");
                
                // Call the initialization function (which is defined *inside* final_html)
                if (container && typeof initializePy2DmolViewer === 'function') {{
                    initializePy2DmolViewer(container);
                }} else if (!container) {{
                    console.error("py2dmol: Failed to find container div #{viewer_id}.");
                }} else {{
                    console.error("py2dmol: Failed to find initializePy2DmolViewer function.");
                }}
            }})();
        </script>
        """
        if not self._reuse_js:
            with importlib.resources.open_text(py2dmol_resources, 'py2Dmol.js') as f:
                js_content = f.read() 
            container_html = f"<script>{js_content}</script>\n" + container_html

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
        self._pae = None
        self._is_live = False

    def new_obj(self, object_name=None):
        """Starts a new object for subsequent 'add' calls."""
        
        # This is a new object, reset the alignment reference
        self._coords = None 
        self._plddts = None
        self._chains = None
        self._atom_types = None
        self._pae = None

        if object_name is None:
            object_name = f"{len(self.objects)}"
            
        # Always update the python-side data
        self._current_object_data = [] # List to hold frames
        self.objects.append({
            "name": object_name,
            "frames": self._current_object_data
        })
        
        # Send message *only if* in dynamic/hybrid mode and already displayed
        if self._is_live:
            self._send_message({
                "type": "py2DmolNewObject",
                "name": object_name
            })
    
    def add(self, coords, plddts=None, chains=None, atom_types=None, pae=None,
            new_obj=False, object_name=None, align=True):
        """
        Adds a new *frame* of data to the viewer.
        
        Behavior depends on when .show() is called.
        
        Args:
            coords (np.array): Nx3 array of coordinates.
            plddts (np.array, optional): N-length array of pLDDT scores.
            chains (list, optional): N-length list of chain identifiers.
            atom_types (list, optional): N-length list of atom types ('P', 'D', 'R', 'L').
            pae (np.array, optional): LxL PAE matrix.
            new_obj (bool, optional): If True, starts a new object. Defaults to False.
            object_name (str, optional): Name for the new object.
        """
        
        # --- Step 1: Update Python-side alignment state ---
        self._update(coords, plddts, chains, atom_types, pae, align=align) # This handles defaults
        data_dict = self._get_data_dict() # This reads the full, correct data

        # --- Step 2: Handle object creation ---
        if new_obj or not self.objects:
            self.new_obj(object_name)
        
        # Safeguard: ensure _current_object_data exists
        if self._current_object_data is None:
            self.new_obj(object_name)
            
        # --- Step 3: Always save data to Python list ---
        self._current_object_data.append(data_dict)

        # --- Step 4: Send message if in "live" mode ---
        if self._is_live:
            self._send_message({
                "type": "py2DmolUpdate",
                "objectName": self.objects[-1]["name"],
                "payload": data_dict
            })


    def add_pdb(self, filepath, chains=None, new_obj=False, object_name=None, pae=None, align=True, use_biounit=False, biounit_name="1", ignore_ligands=False):
        """
        Loads a structure from a local PDB or CIF file and adds it to the viewer
        as a new frame (or object).
        
        This method does *not* call .show().
        
        Multi-model files are added as a single object.
        
        Args:
            filepath (str): Path to the PDB or CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            new_obj (bool, optional): If True, starts a new object. Defaults to False.
            object_name (str, optional): Name for the new object.
            pae (np.array, optional): PAE matrix to associate with the *first* model.
            use_biounit (bool): If True, attempts to generate the biological assembly.
            biounit_name (str): The name of the assembly to generate (default "1").
            ignore_ligands (bool): If True, skips loading ligand atoms.
        """
        
        # --- Handle new_obj logic FIRST ---
        if new_obj or not self.objects:
             self.new_obj(object_name)
        
        current_obj_name = self.objects[-1]["name"]

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
        is_first_model = True
        if not models_to_process and len(structure) > 0:
             print(f"Warning: No models selected or generated for {filepath}, but structure was loaded.")
             # This can happen if biounit fails but structure had no models
             
        for model in models_to_process:
            coords, plddts, atom_chains, atom_types = self._parse_model(model, chains, ignore_ligands=ignore_ligands)

            if coords:
                coords_np = np.array(coords)
                plddts_np = np.array(plddts) if plddts else np.full(len(coords), 50.0)
                
                # Handle case where plddts might be empty from parse
                if len(coords_np) > 0 and len(plddts_np) != len(coords_np):
                    plddts_np = np.full(len(coords_np), 50.0)
                
                # Only add PAE matrix to the first model
                pae_to_add = pae if is_first_model else None

                # Call add() - this will handle batch vs. live
                self.add(coords_np, plddts_np, atom_chains, atom_types,
                    pae=pae_to_add,
                    new_obj=False, # We already handled new_obj
                    object_name=current_obj_name, # Add to the same object
                    align=align)
                
                is_first_model = False

    def _parse_model(self, model, chains_filter, ignore_ligands=False):
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
                        if not ignore_ligands:
                            for atom in residue:
                                if atom.element.name != 'H':
                                    coords.append(atom.pos.tolist())
                                    plddts.append(atom.b_iso)
                                    atom_chains.append(chain.name)
                                    atom_types.append('L')
        return coords, plddts, atom_chains, atom_types

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


    def from_pdb(self, pdb_id, chains=None, new_obj=False, object_name=None, align=True, use_biounit=False, biounit_name="1", ignore_ligands=False):
        """
        Loads a structure from a PDB code (downloads from RCSB if not found locally)
        and displays the viewer.
        
        Args:
            pdb_id (str): 4-character PDB code or a path to a local PDB/CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            new_obj (bool, optional): If True, starts a new object. Defaults to False.
            object_name (str, optional): Name for the new object.
            use_biounit (bool): If True, attempts to generate the biological assembly.
            biounit_name (str): The name of the assembly to generate (default "1").
            ignore_ligands (bool): If True, skips loading ligand atoms.
        """
        filepath = self._get_filepath_from_pdb_id(pdb_id)
        
        if filepath:
            self.add_pdb(filepath, chains=chains, new_obj=new_obj, 
                         object_name=object_name, pae=None, align=align,
                         use_biounit=use_biounit, biounit_name=biounit_name,
                         ignore_ligands=ignore_ligands)
            if not self._is_live: # Only call show() if it hasn't been called
                self.show()
        else:
            print(f"Could not load structure for '{pdb_id}'.")

    def from_afdb(self, uniprot_id, chains=None, new_obj=False, object_name=None, align=True, use_biounit=False, biounit_name="1", ignore_ligands=False):
        """
        Loads a structure from an AlphaFold DB UniProt ID (downloads from EBI)
        and displays the viewer.
        
        If `show_pae=True` was set in the `view()` constructor, this will also
        download and display the PAE matrix.
        
        Args:
            uniprot_id (str): UniProt accession code (e.g., "P0A8I3").
            chains (list, optional): Specific chains to load. Defaults to all.
            new_obj (bool, optional): If True, starts a new object. Defaults to False.
            object_name (str, optional): Name for the new object.
            use_biounit (bool): If True, attempts to generate the biological assembly.
            biounit_name (str): The name of the assembly to generate (default "1").
            ignore_ligands (bool): If True, skips loading ligand atoms.
        """

        # --- Download structure and (maybe) PAE ---
        struct_filepath, pae_filepath = self._get_filepath_from_afdb_id(uniprot_id, download_pae=self.config["pae"])
        
        if not struct_filepath:
             print(f"Could not load structure for '{uniprot_id}'.")
             return

        # --- Parse PAE if downloaded ---
        pae_matrix = None
        if pae_filepath:
            try:
                with open(pae_filepath, 'r') as f:
                    pae_data = json.load(f)
                    # AFDB PAE JSON is a list containing one dict
                    if isinstance(pae_data, list) and len(pae_data) > 0 and 'predicted_aligned_error' in pae_data[0]:
                        pae_matrix = np.array(pae_data[0]['predicted_aligned_error'])
                    else:
                        print(f"Warning: PAE JSON file '{pae_filepath}' has an unexpected format. Expected list with dict containing 'predicted_aligned_error'.")
            except Exception as e:
                print(f"Error parsing PAE JSON '{pae_filepath}': {e}")
        
        # --- Add PDB (and PAE if loaded) ---
        if struct_filepath:
            self.add_pdb(struct_filepath, chains=chains, new_obj=new_obj,
                object_name=object_name, pae=pae_matrix, align=align,
                use_biounit=use_biounit, biounit_name=biounit_name,
                ignore_ligands=ignore_ligands)
            if not self._is_live: # Only call show() if it hasn't been called
                self.show()
        

    def show(self):
        """
        Displays the viewer.
        
        - If called *before* adding data, it creates an empty "live" viewer
          that will be dynamically updated.
        
        - If called *after* adding data, it creates a final, 100% static
          viewer that is persistent in the notebook.
        """
        
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