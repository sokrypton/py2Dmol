import json
import numpy as np
import re
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
        color="auto", colorblind=False, pastel=0.25, shadow=True, depth=False,
        outline="full", width=3.0, ortho=1.0, rotate=False, autoplay=False,
        pae=False, pae_size=300, reuse_js=False,
    ):
        # Normalize pae_size: if tuple/list, use first value; otherwise use as-is
        if isinstance(pae_size, (tuple, list)) and len(pae_size) > 0:
            pae_size = int(pae_size[0])
        else:
            pae_size = int(pae_size)
        
        self.config = {
            "size": size,
            "controls": controls,
            "box": box,
            "color": color,
            "colorblind": colorblind,
            "pastel": pastel,
            "shadow": shadow,
            "depth": depth,
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
        self._position_types = None
        self._pae = None
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
            payload["pae"] = np.round(self._pae, 0).astype(int).tolist()

        if self._position_names is not None:
            payload["position_names"] = list(self._position_names)

        if self._position_residue_numbers is not None:
            payload["residue_numbers"] = list(self._position_residue_numbers)

        return payload

    def _update(self, coords, plddts=None, chains=None, position_types=None, pae=None, align=True, position_names=None, residue_numbers=None, atom_types=None):
      """
      Updates the internal state with new data. It no longer creates
      default values, simply storing what is provided.
      
      Args:
          residue_numbers: PDB residue sequence numbers (resSeq), one per position.
                           For ligands, multiple positions may share the same residue number.
          atom_types: Backward compatibility alias for position_types (deprecated).
      """
      # Backward compatibility: support atom_types as alias for position_types
      if atom_types is not None and position_types is None:
          position_types = atom_types
      
      # --- Coordinate Alignment ---
      if self._coords is None:
          # First frame of an object, align to best view
          self._coords = best_view(coords) if align else coords
      else:
          # Subsequent frames, align to the first frame
          if align and self._coords.shape == coords.shape:
              self._coords = align_a_to_b(coords, self._coords)
          else:
              self._coords = coords
      
      # --- Store Provided Data (or None) ---
      self._plddts = plddts
      self._chains = chains
      self._position_types = position_types
      self._pae = pae
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
            
            name = message_dict.get("name", "")
            js_code_inner = f"window.py2dmol_viewers['{viewer_id}'].handlePythonUpdate({payload_js_literal}, '{name}');"
        
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
        with importlib.resources.open_text(py2dmol_resources, 'viewer.html') as f:
            html_template = f.read()

        config_script = f"""
        <script id="viewer-config">
          window.viewerConfig = {json.dumps(self.config)};
        </script>
        """
        
        data_script = ""
        
        if static_data and isinstance(static_data, list):
            serialized_objects = []
            for py_obj in static_data:
                if not py_obj.get("frames"):
                    continue

                light_frames = []
                for frame in py_obj["frames"]:
                    # Skip frames without coords (they're invalid)
                    if "coords" not in frame or not frame["coords"]:
                        continue
                    
                    light_frame = {}
                    if "name" in frame and frame["name"] is not None:
                        light_frame["name"] = frame["name"]
                    # Coords are required - we already checked above
                    light_frame["coords"] = frame["coords"]
                    if "plddts" in frame and frame["plddts"] is not None:
                        light_frame["plddts"] = frame["plddts"]
                    if "pae" in frame and frame["pae"] is not None:
                        light_frame["pae"] = frame["pae"]
                    if "position_names" in frame and frame["position_names"] is not None:
                        light_frame["position_names"] = frame["position_names"]
                    if "residue_numbers" in frame and frame["residue_numbers"] is not None:
                        light_frame["residue_numbers"] = frame["residue_numbers"]
                    # Include position_types and chains at frame level for proper inheritance
                    if "position_types" in frame and frame["position_types"] is not None:
                        light_frame["position_types"] = frame["position_types"]
                    if "chains" in frame and frame["chains"] is not None:
                        light_frame["chains"] = frame["chains"]
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
                
                # Add contacts if they exist
                if "contacts" in py_obj and py_obj["contacts"] is not None and len(py_obj["contacts"]) > 0:
                    obj_to_serialize["contacts"] = py_obj["contacts"]
                
                serialized_objects.append(obj_to_serialize)

            data_json = json.dumps(serialized_objects)
            
            data_script = f'<script id="static-data">window.staticObjectData = {data_json};</script>'
        else:
            # Pure Dynamic mode: inject empty data, will be populated by messages
            data_script = '<script id="protein-data">window.proteinData = {{ "coords": [], "plddts": [], "chains": [], "position_types": [], "pae": null }};</script>'
        
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
            with importlib.resources.open_text(py2dmol_resources, 'viewer-mol.js') as f:
                js_content = f.read() 
            container_html = f"<script>{js_content}</script>\n" + container_html
            
            # Conditionally load PAE module if enabled
            if self.config.get("pae", False):
                try:
                    with importlib.resources.open_text(py2dmol_resources, 'viewer-pae.js') as f:
                        pae_js_content = f.read()
                    container_html = f"<script>{pae_js_content}</script>\n" + container_html
                except FileNotFoundError:
                    print("Warning: viewer-pae.js not found. PAE functionality will not be available.")

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
        self._position_types = None
        self._pae = None
        self._is_live = False

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
            # List of contacts - validate and return
            # Basic validation: check that each contact is a list
            validated = []
            for contact in contacts:
                if isinstance(contact, list) and len(contact) >= 3:
                    validated.append(contact)
                else:
                    print(f"Warning: Skipping invalid contact: {contact}")
            return validated if validated else None
        else:
            print(f"Error: contacts must be a filepath (str) or list of lists, got {type(contacts)}")
            return None

    def new_obj(self, name=None):
        """Starts a new object for subsequent 'add' calls."""
        
        # This is a new object, reset the alignment reference
        self._coords = None 
        self._plddts = None
        self._chains = None
        self._position_types = None
        self._pae = None

        if name is None:
            name = f"{len(self.objects)}"
            
        # Always update the python-side data
        self._current_object_data = [] # List to hold frames
        self.objects.append({
            "name": name,
            "frames": self._current_object_data,
            "contacts": None  # Initialize contacts as None
        })
        
        # Send message *only if* in dynamic/hybrid mode and already displayed
        if self._is_live:
            self._send_message({
                "type": "py2DmolNewObject",
                "name": name
            })
    
    def add(self, coords, plddts=None, chains=None, position_types=None, pae=None,
            new_obj=False, name=None, align=True, position_names=None, residue_numbers=None, atom_types=None, contacts=None):
        """
        Adds a new *frame* of data to the viewer.
        
        Behavior depends on when .show() is called.
        
        Args:
            coords (np.array): Nx3 array of coordinates.
            plddts (np.array, optional): N-length array of pLDDT scores.
            chains (list, optional): N-length list of chain identifiers.
            position_types (list, optional): N-length list of position types ('P', 'D', 'R', 'L').
            pae (np.array, optional): LxL PAE matrix.
            new_obj (bool, optional): If True, starts a new object. Defaults to False.
            name (str, optional): Name for the new object or frame.
            position_names (list, optional): N-length list of position names.
            residue_numbers (list, optional): N-length list of PDB residue sequence numbers (resSeq).
                                              One per position. For ligands, multiple positions may share the same residue number.
            atom_types (list, optional): Backward compatibility alias for position_types (deprecated).
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
        """
        
        # --- Step 1: Update Python-side alignment state ---
        self._update(coords, plddts, chains, position_types, pae, align=align, position_names=position_names, residue_numbers=residue_numbers, atom_types=atom_types) # This handles defaults
        data_dict = self._get_data_dict() # This reads the full, correct data

        # --- Step 2: Handle object creation ---
        object_name = name if new_obj else None
        frame_name = name if not new_obj else None

        if new_obj or not self.objects:
            self.new_obj(object_name)
        
        # Safeguard: ensure _current_object_data exists
        if self._current_object_data is None:
            self.new_obj(object_name)

        data_dict["name"] = frame_name
            
        # --- Step 3: Always save data to Python list ---
        self._current_object_data.append(data_dict)

        # --- Step 4: Process contacts if provided ---
        if contacts is not None:
            processed_contacts = self._process_contacts(contacts)
            if processed_contacts is not None:
                self.objects[-1]["contacts"] = processed_contacts

        # --- Step 5: Send message if in "live" mode ---
        if self._is_live:
            # Include contacts in payload if they exist for this object and are not None/empty
            payload = data_dict.copy()
            obj_contacts = self.objects[-1].get("contacts")
            if obj_contacts is not None and len(obj_contacts) > 0:
                payload["contacts"] = obj_contacts
            
            self._send_message({
                "type": "py2DmolUpdate",
                "name": self.objects[-1]["name"],
                "payload": payload
            })


    def add_pdb(self, filepath, chains=None, new_obj=False, name=None, paes=None, align=True, use_biounit=False, biounit_name="1", ignore_ligands=False, contacts=None):
        """
        Loads a structure from a local PDB or CIF file and adds it to the viewer
        as a new frame (or object).
        
        This method does *not* call .show().
        
        Multi-model files are added as a single object.
        
        Args:
            filepath (str): Path to the PDB or CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            new_obj (bool, optional): If True, starts a new object. Defaults to False.
            name (str, optional): Name for the new object.
            paes (list, optional): List of PAE matrices to associate with each model.
            use_biounit (bool): If True, attempts to generate the biological assembly.
            biounit_name (str): The name of the assembly to generate (default "1").
            ignore_ligands (bool): If True, skips loading ligand atoms.
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
        """
        
        # --- Handle new_obj logic FIRST ---
        if new_obj or not self.objects:
             self.new_obj(name)
        
        current_obj_name = self.objects[-1]["name"]
        
        # --- Process contacts if provided ---
        if contacts is not None:
            processed_contacts = self._process_contacts(contacts)
            if processed_contacts is not None:
                self.objects[-1]["contacts"] = processed_contacts

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
            coords, plddts, position_chains, position_types, position_names, residue_numbers = self._parse_model(model, chains, ignore_ligands=ignore_ligands)

            if coords:
                coords_np = np.array(coords)
                plddts_np = np.array(plddts) if plddts else np.full(len(coords), 50.0)
                
                # Handle case where plddts might be empty from parse
                if len(coords_np) > 0 and len(plddts_np) != len(coords_np):
                    plddts_np = np.full(len(coords_np), 50.0)
                
                # Only add PAE matrix to the first model
                pae_to_add = paes[i] if paes and i < len(paes) else None

                # Call add() - this will handle batch vs. live
                self.add(coords_np, plddts_np, position_chains, position_types,
                    pae=pae_to_add,
                    new_obj=False, # We already handled new_obj
                    name=f"model_{i+1}", # Add to the same object
                    align=align,
                    position_names=position_names,
                    residue_numbers=residue_numbers)

    def _parse_model(self, model, chains_filter, ignore_ligands=False):
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
                        if not ignore_ligands:
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


    def from_pdb(self, pdb_id, chains=None, new_obj=False, name=None, align=True, use_biounit=False, biounit_name="1", ignore_ligands=False, contacts=None):
        """
        Loads a structure from a PDB code (downloads from RCSB if not found locally)
        and displays the viewer.
        
        Args:
            pdb_id (str): 4-character PDB code or a path to a local PDB/CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            new_obj (bool, optional): If True, starts a new object. Defaults to False.
            name (str, optional): Name for the new object.
            use_biounit (bool): If True, attempts to generate the biological assembly.
            biounit_name (str): The name of the assembly to generate (default "1").
            ignore_ligands (bool): If True, skips loading ligand atoms.
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
        """
        filepath = self._get_filepath_from_pdb_id(pdb_id)
        
        if filepath:
            self.add_pdb(filepath, chains=chains, new_obj=new_obj, 
                         name=name, paes=None, align=align,
                         use_biounit=use_biounit, biounit_name=biounit_name,
                         ignore_ligands=ignore_ligands, contacts=contacts)
            if not self._is_live: # Only call show() if it hasn't been called
                self.show()
        else:
            print(f"Could not load structure for '{pdb_id}'.")

    def from_afdb(self, uniprot_id, chains=None, new_obj=False, name=None, align=True, use_biounit=False, biounit_name="1", ignore_ligands=False):
        """
        Loads a structure from an AlphaFold DB UniProt ID (downloads from EBI)
        and displays the viewer.
        
        If `show_pae=True` was set in the `view()` constructor, this will also
        download and display the PAE matrix.
        
        Args:
            uniprot_id (str): UniProt accession code (e.g., "P0A8I3").
            chains (list, optional): Specific chains to load. Defaults to all.
            new_obj (bool, optional): If True, starts a new object. Defaults to False.
            name (str, optional): Name for the new object.
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
            pae_matrix = self._parse_pae_json(pae_filepath)
        
        # --- Add PDB (and PAE if loaded) ---
        if struct_filepath:
            self.add_pdb(struct_filepath, chains=chains, new_obj=new_obj,
                name=name, paes=[pae_matrix] if pae_matrix is not None else None, align=align,
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

    def _detect_redundant_fields(self, frames):
        """
        Detect fields that are identical across all frames.
        Returns dict of field_name: value for redundant fields.
        """
        if not frames or len(frames) == 0:
            return {}
        
        redundant = {}
        for field in ['chains', 'position_types']:
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
        import os
        
        # Create directory if it doesn't exist
        os.makedirs(os.path.dirname(filepath) if os.path.dirname(filepath) else '.', exist_ok=True)
        
        # Collect all objects
        objects = []
        for obj in self.objects:
            frames = []
            for frame in obj.get("frames", []):
                frame_data = {}
                
                # Round coordinates to 2 decimal places
                if "coords" in frame:
                    frame_data["coords"] = [[round(c, 2) for c in coord] for coord in frame["coords"]]
                
                # Round pLDDT to integers
                if "plddts" in frame:
                    frame_data["plddts"] = [round(p) for p in frame["plddts"]]
                
                # Copy other fields
                for key in ["chains", "position_types", "position_names", "residue_numbers"]:
                    if key in frame:
                        frame_data[key] = frame[key]
                
                # Round PAE to 1 decimal place
                if "pae" in frame and frame["pae"] is not None:
                    frame_data["pae"] = [[round(val, 1) for val in row] for row in frame["pae"]]
                
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
                "name": obj.get("name", "unknown"),
                "frames": frames,
                "hasPAE": any(f.get("pae") is not None for f in frames)
            }
            # Add redundant fields to object level (only if detected)
            obj_to_serialize.update(redundant_fields)
            
            # Add contacts if they exist
            if "contacts" in obj and obj["contacts"] is not None and len(obj["contacts"]) > 0:
                obj_to_serialize["contacts"] = obj["contacts"]
            
            objects.append(obj_to_serialize)
        
        # Get viewer state (limited - Python doesn't have access to all JS state)
        viewer_state = {
            "current_object_name": self.objects[-1]["name"] if self.objects else None,
            "current_frame": 0,  # Python doesn't track current frame
            "rotation_matrix": [[1,0,0],[0,1,0],[0,0,1]],  # Default, JS will override
            "zoom": 1.0,  # Default, JS will override
            "color_mode": self.config.get("color", "auto"),
            "line_width": self.config.get("width", 3.0),
            "shadow_enabled": self.config.get("shadow", True),
            "depth_enabled": self.config.get("depth", True),
            "outline_mode": self.config.get("outline", "full"),  # "none", "partial", or "full"
            "colorblind_mode": self.config.get("colorblind", False),
            "pastel_level": self.config.get("pastel", 0.25),
            "perspective_enabled": False,
            "ortho_slider_value": self.config.get("ortho", 1.0), # Normalized 0-1 range
            "animation_speed": 100
        }
        
        # Create state object
        state_data = {
            "objects": objects,
            "viewer_state": viewer_state
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
        with open(filepath, 'r') as f:
            state_data = json.load(f)
        
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
                # Backward compatibility: support atom_types as alias for position_types
                obj_position_types = obj_data.get("position_types") or obj_data.get("atom_types")
                
                self.new_obj(obj_data["name"])
                
                for frame_data in obj_data["frames"]:
                    # Convert frame data to numpy arrays
                    coords = np.array(frame_data.get("coords", []))
                    
                    if len(coords) == 0:
                        print(f"Warning: Skipping frame with no coordinates")
                        continue
                    
                    # Robust resolution: frame-level > object-level > None (will use defaults in add())
                    chains = frame_data.get("chains") or obj_chains
                    # Backward compatibility: support atom_types as alias for position_types
                    position_types = frame_data.get("position_types") or frame_data.get("atom_types") or obj_position_types
                    plddts = np.array(frame_data.get("plddts", [])) if frame_data.get("plddts") else None
                    position_names = frame_data.get("position_names")
                    residue_numbers = frame_data.get("residue_numbers")
                    pae = np.array(frame_data.get("pae")) if frame_data.get("pae") else None
                    
                    # add() will apply defaults for None values
                    self.add(
                        coords,
                        plddts if plddts is not None and len(plddts) > 0 else None,
                        chains,
                        position_types,
                        pae=pae,
                        new_obj=False,
                        name=None,
                        align=False,  # Don't re-align loaded data
                        position_names=position_names,
                        residue_numbers=residue_numbers
                    )
                
                # Restore contacts data if present
                if "contacts" in obj_data and obj_data["contacts"] is not None:
                    if isinstance(obj_data["contacts"], list) and len(obj_data["contacts"]) > 0:
                        self.objects[-1]["contacts"] = obj_data["contacts"]
        
        # Restore viewer config from state (if available)
        if "viewer_state" in state_data:
            vs = state_data["viewer_state"]
            if vs.get("color_mode"):
                self.config["color"] = vs["color_mode"]
            if vs.get("line_width"):
                self.config["width"] = vs["line_width"]
            if "shadow_enabled" in vs:
                self.config["shadow"] = vs["shadow_enabled"]
            if "depth_enabled" in vs:
                self.config["depth"] = vs["depth_enabled"]
            if "outline_mode" in vs:
                self.config["outline"] = vs["outline_mode"]
            elif "outline_enabled" in vs:
                # Legacy boolean support
                self.config["outline"] = "full" if vs["outline_enabled"] else "none"
            if "colorblind_mode" in vs:
                self.config["colorblind"] = vs["colorblind_mode"]
            if vs.get("pastel_level"):
                self.config["pastel"] = vs["pastel_level"]
            if vs.get("focal_length"):
                self.config["ortho"] = vs["focal_length"]
        
        # State loaded - user must call show() to display
        if not self.objects:
            print("Warning: No objects loaded from state file.")