.. py2Dmol documentation master file

py2Dmol Documentation
=====================

.. image:: https://github.com/maraxen/py2Dmol/actions/workflows/ci.yml/badge.svg
   :target: https://github.com/maraxen/py2Dmol/actions/workflows/ci.yml
   :alt: Build Status

.. image:: https://codecov.io/gh/maraxen/py2Dmol/branch/main/graph/badge.svg
   :target: https://codecov.io/gh/maraxen/py2Dmol
   :alt: Coverage

.. image:: https://colab.research.google.com/assets/colab-badge.svg
   :target: https://colab.research.google.com/github/maraxen/py2Dmol/blob/main/example/example.ipynb
   :alt: Open in Colab

A Python library for visualizing protein, DNA, and RNA structures in 2D, designed for use in Google Colab and Jupyter environments.

.. image:: https://github.com/user-attachments/assets/5f043fa8-99d6-4988-aaa1-68d1bc48660b
   :alt: Example visualization

Quick Start
-----------

Installation
~~~~~~~~~~~~

.. code-block:: bash

   uv pip install py2Dmol

or for cutting edge releases:

.. code-block:: bash

   uv pip install git+https://github.com/sokrypton/py2Dmol

Basic Usage
~~~~~~~~~~~

.. code-block:: python

   import py2dmol

   # Create a viewer
   viewer = py2dmol.view()

   # Load a structure
   viewer.add_pdb('my_protein.pdb')

Features
--------

- 🎨 Interactive 3D-style visualization with rotation and zoom
- 🎬 Animation support for trajectories and multiple models
- 🧬 Automatic structure detection for proteins, DNA, and RNA
- 🌈 Multiple color schemes (auto, rainbow, pLDDT, chain)
- 💊 Ligand visualization with automatic bond detection
- ✨ Toggleable effects for depth perception (shadow, outline)
- 📏 Adjustable line width
- 🔄 Real-time auto-rotation (toggleable)
- 📊 Trajectory management for comparing multiple simulations

Supported File Formats
-----------------------

- PDB (.pdb)
- mmCIF (.cif)

Both formats support multi-model files for animation playback.

Requirements
------------

- Python 3.9+
- NumPy
- gemmi (for PDB/CIF parsing)
- IPython (for display in notebooks)

.. toctree::
   :maxdepth: 2
   :caption: Contents:

   installation
   usage
   examples
   api
   contributing

Indices and tables
==================

* :ref:`genindex`
* :ref:`modindex`
* :ref:`search`
