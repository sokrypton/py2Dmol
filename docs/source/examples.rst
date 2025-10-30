Examples
========

This page contains various examples demonstrating the capabilities of py2Dmol.

Basic Protein Visualization
----------------------------

Simple protein structure visualization:

.. code-block:: python

   import py2dmol

   viewer = py2dmol.view()
   viewer.add_pdb('1ubq.pdb')  # Ubiquitin

Alpha Helix Animation
---------------------

Generate and animate an alpha helix being twisted into a superhelix:

.. code-block:: python

   import numpy as np
   import py2dmol

   def generate_alpha_helix_on_superhelix(n_residues=50, super_radius=0, super_turns=0):
       """
       Generate alpha helix wrapped around a cylinder (superhelix).

       Parameters:
       - n_residues: number of residues
       - super_radius: radius of the superhelix (0 = straight helix)
       - super_turns: number of superhelical turns
       """
       coords = []
       helix_radius = 2.3  # Å from helix axis to CA
       rise_per_residue = 1.5  # Å along helix axis
       rotation_per_residue = 100 * np.pi / 180  # 100 degrees

       helix_length = (n_residues - 1) * rise_per_residue

       for i in range(n_residues):
           # Alpha helix coordinates
           helix_angle = i * rotation_per_residue
           local_x = helix_radius * np.cos(helix_angle)
           local_y = helix_radius * np.sin(helix_angle)
           z = i * rise_per_residue

           if super_radius == 0:
               # Straight helix
               x, y = local_x, local_y
           else:
               # Wrap around superhelix
               super_angle = (z / helix_length) * 2 * np.pi * super_turns

               # Transform: local helix coordinates → superhelix
               x = (super_radius + local_x) * np.cos(super_angle) - local_y * np.sin(super_angle)
               y = (super_radius + local_x) * np.sin(super_angle) + local_y * np.cos(super_angle)

           coords.append([x, y, z])

       return np.array(coords)

   # Create initial straight helix
   coords = generate_alpha_helix_on_superhelix(100, super_radius=0, super_turns=0)
   plddts = np.linspace(50, 95, 100)
   chains = ['A'] * 100
   atom_types = ['P'] * 100

   # Display
   viewer = py2dmol.view()

   # Animate: gradually add superhelical twist
   for frame in range(1, 21):
       super_radius = 10.0  # Radius of the "pole"
       super_turns = frame * 0.075  # Gradually increase from 0 to 1.5 turns
       twisted_coords = generate_alpha_helix_on_superhelix(
           100, super_radius=super_radius, super_turns=super_turns
       )
       viewer.add(twisted_coords, plddts, chains, atom_types)

Mixed Protein-DNA-Ligand Complex
---------------------------------

Create a complex visualization with multiple molecule types:

.. code-block:: python

   import numpy as np
   import py2dmol

   def generate_alpha_helix(n_residues, offset=np.array([0, 0, 0])):
       """Generate ideal alpha helix (CA-CA ~3.8 Å)."""
       coords = []
       radius = 2.3
       rise_per_residue = 1.5
       rotation_per_residue = 100 * np.pi / 180

       for i in range(n_residues):
           angle = i * rotation_per_residue
           x = radius * np.cos(angle) + offset[0]
           y = radius * np.sin(angle) + offset[1]
           z = i * rise_per_residue + offset[2]
           coords.append([x, y, z])
       return np.array(coords)

   def generate_dna_strand(n_bases, offset=np.array([0, 0, 0])):
       """Generate B-DNA backbone (C4'-C4' ~7.0 Å)."""
       coords = []
       radius = 10.0  # Distance from helix axis to C4'
       rise_per_base = 3.4  # B-DNA rise
       rotation_per_base = 36 * np.pi / 180  # 10 bases per turn

       for i in range(n_bases):
           angle = i * rotation_per_base
           x = radius * np.cos(angle) + offset[0]
           y = radius * np.sin(angle) + offset[1]
           z = i * rise_per_base + offset[2]
           coords.append([x, y, z])
       return np.array(coords)

   def generate_benzene_ring(center):
       """Generate benzene-like small molecule (C-C 1.4 Å)."""
       coords = []
       bond_length = 1.4
       for i in range(6):
           angle = i * np.pi / 3  # 60 degrees between carbons
           x = center[0] + bond_length * np.cos(angle)
           y = center[1] + bond_length * np.sin(angle)
           z = center[2]
           coords.append([x, y, z])
       return np.array(coords)

   # Create protein helix
   protein_coords = generate_alpha_helix(50, offset=np.array([15, 0, 0]))
   protein_plddts = np.full(50, 90.0)
   protein_chains = ['A'] * 50
   protein_types = ['P'] * 50

   # Create DNA strand
   dna_coords = generate_dna_strand(30, offset=np.array([-15, 0, 0]))
   dna_plddts = np.full(30, 85.0)
   dna_chains = ['B'] * 30
   dna_types = ['D'] * 30

   # Add a small molecule ligand
   ligand_coords = generate_benzene_ring(center=np.array([0, 0, 40]))
   ligand_plddts = np.full(6, 70.0)
   ligand_chains = ['L'] * 6
   ligand_types = ['L'] * 6

   # Combine all components
   all_coords = np.vstack([protein_coords, dna_coords, ligand_coords])
   all_plddts = np.concatenate([protein_plddts, dna_plddts, ligand_plddts])
   all_chains = protein_chains + dna_chains + ligand_chains
   all_types = protein_types + dna_types + ligand_types

   viewer = py2dmol.view(
       color='chain',
       size=(600, 600),
       width=2.5,
       outline=False
   )
   viewer.add(all_coords, all_plddts, all_chains, all_types)

AlphaFold Prediction with pLDDT Coloring
-----------------------------------------

Visualize an AlphaFold prediction with confidence scores:

.. code-block:: python

   import py2dmol

   # Use pLDDT coloring to show prediction confidence
   viewer = py2dmol.view(color='plddt', size=(600, 600))
   viewer.add_pdb('alphafold_prediction.pdb')

Multi-Chain Complex
-------------------

Visualize a multi-chain protein complex with distinct chain colors:

.. code-block:: python

   import py2dmol

   viewer = py2dmol.view(color='chain', size=(600, 600))
   viewer.add_pdb('protein_complex.pdb')

Comparing Different Simulations
--------------------------------

Load and compare multiple molecular dynamics trajectories:

.. code-block:: python

   import py2dmol

   # Load first trajectory
   viewer = py2dmol.view(size=(600, 600))
   viewer.add_pdb('md_simulation_1.pdb')

   # Load second trajectory as a new trajectory
   viewer.add_pdb('md_simulation_2.pdb', new_traj=True)

   # Load third trajectory
   viewer.add_pdb('md_simulation_3.pdb', new_traj=True)

   # Use the dropdown to switch between trajectories

Custom Styling
--------------

Customize the appearance for publication-quality figures:

.. code-block:: python

   import py2dmol

   viewer = py2dmol.view(
       size=(800, 800),        # Larger size
       color='rainbow',        # Rainbow coloring
       shadow=False,           # Disable shadows
       outline=True,           # Enable outlines
       width=2.0,              # Thinner lines
       rotate=True             # Enable auto-rotation
   )
   viewer.add_pdb('structure.pdb')

Loading Specific Chains
------------------------

Visualize only specific chains from a multi-chain structure:

.. code-block:: python

   import py2dmol

   viewer = py2dmol.view(color='chain')

   # Load only chains A and B
   viewer.add_pdb('complex.pdb', chains=['A', 'B'])

Interactive Notebook Example
-----------------------------

For a complete interactive example in Jupyter/Colab, check out our example notebook:

.. raw:: html

   <a href="https://colab.research.google.com/github/maraxen/py2Dmol/blob/main/example/example.ipynb" target="_blank">
   <img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"/>
   </a>
