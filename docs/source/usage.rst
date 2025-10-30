Usage Guide
===========

This guide covers the basic usage of py2Dmol for visualizing molecular structures.

Initializing the Viewer
-----------------------

The simplest way to create a viewer:

.. code-block:: python

   import py2dmol

   # Default viewer
   viewer = py2dmol.view()

Customizing the Viewer
~~~~~~~~~~~~~~~~~~~~~~

You can customize various aspects of the viewer during initialization:

.. code-block:: python

   viewer = py2dmol.view(
       size=(600, 600),   # Set canvas size (width, height)
       color='chain',     # Set initial color mode
       shadow=True,       # Enable shadows by default
       outline=True,      # Enable outlines by default
       width=3.0,         # Set initial line width
       rotate=False       # Disable auto-rotation by default
   )

Parameters
^^^^^^^^^^

- **size**: tuple[int, int]
    Width and height of the viewer in pixels. Default: (500, 500)

- **color**: "auto" | "rainbow" | "chain"
    Color mode for the visualization. Default: "auto"

    - ``auto``: Automatically chooses 'chain' if multiple chains are present, otherwise 'rainbow'
    - ``rainbow``: Colors atoms sequentially from N-terminus to C-terminus
    - ``chain``: Each chain receives a distinct color

- **shadow**: bool
    Whether to enable shadow effect for depth perception. Default: True

- **outline**: bool
    Whether to enable outline effect. Default: True

- **width**: float
    Line width for rendering bonds. Default: 3.0

- **rotate**: bool
    Whether to enable automatic rotation. Default: False

Loading Structures
------------------

From PDB Files
~~~~~~~~~~~~~~

Load a structure from a PDB file:

.. code-block:: python

   viewer = py2dmol.view()
   viewer.add_pdb('my_protein.pdb')

Loading Specific Chains
^^^^^^^^^^^^^^^^^^^^^^^^

You can specify which chains to display:

.. code-block:: python

   viewer.add_pdb('my_protein.pdb', chains=['A', 'B'])

From CIF Files
~~~~~~~~~~~~~~

Load a structure from an mmCIF file:

.. code-block:: python

   viewer = py2dmol.view()
   viewer.add_pdb('my_protein.cif')  # Works for both PDB and CIF formats

Multi-Model Files
~~~~~~~~~~~~~~~~~

If the file contains multiple models, they will be loaded as an animation:

.. code-block:: python

   viewer = py2dmol.view()
   viewer.add_pdb('trajectory.pdb')  # Multiple models = animation

Adding Data Manually
--------------------

You can add custom coordinate data directly:

.. code-block:: python

   import numpy as np

   coords = np.array([[0, 0, 0], [1, 1, 1], [2, 2, 2]])
   plddts = np.array([90, 85, 95])  # Confidence scores or B-factors
   chains = ['A', 'A', 'A']
   atom_types = ['P', 'P', 'P']  # P=protein, D=DNA, R=RNA, L=ligand

   viewer = py2dmol.view()
   viewer.add(coords, plddts, chains, atom_types)

Atom Types
~~~~~~~~~~

The viewer recognizes four atom types:

.. list-table::
   :header-rows: 1
   :widths: 15 20 30 35

   * - Code
     - Molecule Type
     - Representative Atom
     - Purpose
   * - P
     - Protein
     - CA (C-alpha)
     - Backbone trace
   * - D
     - DNA
     - C4' (sugar carbon)
     - Backbone trace
   * - R
     - RNA
     - C4' (sugar carbon)
     - Backbone trace
   * - L
     - Ligand
     - All heavy atoms
     - Full structure

Distance Thresholds
^^^^^^^^^^^^^^^^^^^

Different distance thresholds are used for creating bonds:

- Protein (CA-CA): 5.0 Å
- DNA/RNA (C4'-C4'): 7.5 Å
- Ligand bonds: 2.0 Å

Color Modes
-----------

Rainbow Coloring
~~~~~~~~~~~~~~~~

Colors atoms sequentially from N-terminus to C-terminus:

.. code-block:: python

   viewer = py2dmol.view(color='rainbow')
   viewer.add_pdb('protein.pdb')

pLDDT Coloring
~~~~~~~~~~~~~~

Colors based on B-factor or pLDDT scores (useful for AlphaFold predictions):

.. code-block:: python

   viewer = py2dmol.view(color='plddt')
   viewer.add_pdb('alphafold_prediction.pdb')

Chain Coloring
~~~~~~~~~~~~~~

Each chain receives a distinct color:

.. code-block:: python

   viewer = py2dmol.view(color='chain')
   viewer.add_pdb('multi_chain_complex.pdb')

Auto Mode
~~~~~~~~~

Automatically selects the best coloring scheme:

.. code-block:: python

   viewer = py2dmol.view(color='auto')
   viewer.add_pdb('structure.pdb')

Working with Trajectories
--------------------------

Comparing Multiple Trajectories
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

You can load and compare multiple trajectories:

.. code-block:: python

   # Load first trajectory
   viewer = py2dmol.view()
   viewer.add_pdb('simulation1.pdb')

   # Start a new trajectory
   viewer.add_pdb('simulation2.pdb', new_traj=True)

   # Use the dropdown menu to switch between trajectories

The viewer provides a dropdown menu to switch between different trajectories, making it easy to compare different simulations or experimental conditions.

Interactive Features
--------------------

The py2Dmol viewer includes several interactive features:

- **Rotation**: Click and drag to rotate the structure
- **Zoom**: Use mouse wheel to zoom in/out
- **Animation**: Use the play button to animate through frames
- **Auto-rotation**: Toggle automatic rotation on/off
- **Shadow**: Toggle shadow effects
- **Outline**: Toggle outline effects
- **Width adjustment**: Adjust line width with slider
- **Color mode**: Switch between color modes
- **Trajectory selection**: Switch between loaded trajectories
