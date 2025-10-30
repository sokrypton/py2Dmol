Installation
============

From PyPI
---------

The easiest way to install py2Dmol is via pip:

.. code-block:: bash

   pip install py2Dmol

Using uv (recommended)
~~~~~~~~~~~~~~~~~~~~~~

If you're using `uv <https://github.com/astral-sh/uv>`_, you can install with:

.. code-block:: bash

   uv pip install py2Dmol

Development Version
-------------------

To install the latest development version directly from GitHub:

.. code-block:: bash

   pip install git+https://github.com/sokrypton/py2Dmol

or with uv:

.. code-block:: bash

   uv pip install git+https://github.com/sokrypton/py2Dmol

From Source
-----------

To install from source for development:

.. code-block:: bash

   git clone https://github.com/sokrypton/py2Dmol.git
   cd py2Dmol
   pip install -e .

Development Dependencies
~~~~~~~~~~~~~~~~~~~~~~~~

To install development dependencies:

.. code-block:: bash

   pip install -e ".[dev,tests,docs]"

This will install:

- Development tools (basedpyright, pre-commit)
- Testing tools (pytest, pytest-cov)
- Documentation tools (sphinx, myst-nb, sphinx-book-theme, etc.)

Requirements
------------

py2Dmol requires:

- Python 3.9 or higher
- numpy
- gemmi (for PDB/CIF parsing)
- IPython (for display in notebooks)
- requests (for downloading files)

All dependencies will be installed automatically when you install py2Dmol.

Verifying Installation
----------------------

To verify that py2Dmol is installed correctly:

.. code-block:: python

   import py2dmol
   viewer = py2dmol.view()
   print("py2Dmol is installed correctly!")

In Google Colab
---------------

py2Dmol works seamlessly in Google Colab. Simply install it in a code cell:

.. code-block:: bash

   !pip install py2Dmol

Then use it normally in subsequent cells.
