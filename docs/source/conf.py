# Configuration file for the Sphinx documentation builder.
#
# For the full list of built-in configuration values, see the documentation:
# https://www.sphinx-doc.org/en/master/usage/configuration.html

import sys
from datetime import datetime
from pathlib import Path

# Add the project root to the path
sys.path.insert(0, str(Path("../..").resolve()))

# -- Project information -----------------------------------------------------
# https://www.sphinx-doc.org/en/master/usage/configuration.html#project-information

project = "py2Dmol"
copyright = f"{datetime.now().year}, sokrypton, maraxen"
author = "sokrypton, maraxen"
release = "1.1.4"

# -- General configuration ---------------------------------------------------
# https://www.sphinx-doc.org/en/master/usage/configuration.html#general-configuration

extensions = [
  "sphinx.ext.autodoc",
  "sphinx.ext.autosummary",
  "sphinx.ext.napoleon",
  "sphinx.ext.viewcode",
  "sphinx.ext.intersphinx",
  "sphinx_autodoc_typehints",
  "sphinx_copybutton",
  "sphinx_design",
  "myst_nb",
]

# MyST-NB configuration
nb_execution_mode = "off"  # Don't execute notebooks during build
myst_enable_extensions = [
  "colon_fence",
  "deflist",
  "substitution",
]

# Autodoc configuration
autodoc_default_options = {
  "members": True,
  "member-order": "bysource",
  "special-members": "__init__",
  "undoc-members": True,
  "exclude-members": "__weakref__",
}
autodoc_typehints = "description"
autodoc_typehints_description_target = "documented"

# Autosummary configuration
autosummary_generate = True

# Napoleon settings
napoleon_google_docstring = True
napoleon_numpy_docstring = True
napoleon_include_init_with_doc = True
napoleon_include_private_with_doc = False
napoleon_include_special_with_doc = True
napoleon_use_admonition_for_examples = False
napoleon_use_admonition_for_notes = False
napoleon_use_admonition_for_references = False
napoleon_use_ivar = False
napoleon_use_param = True
napoleon_use_rtype = True
napoleon_preprocess_types = False
napoleon_type_aliases = None
napoleon_attr_annotations = True

# Intersphinx mapping
intersphinx_mapping = {
  "python": ("https://docs.python.org/3", None),
  "numpy": ("https://numpy.org/doc/stable/", None),
  "gemmi": ("https://gemmi.readthedocs.io/en/latest/", None),
}

templates_path = ["_templates"]
exclude_patterns = []

# Source file suffix
source_suffix = {
  ".rst": "restructuredtext",
  ".md": "markdown",
}

# -- Options for HTML output -------------------------------------------------
# https://www.sphinx-doc.org/en/master/usage/configuration.html#options-for-html-output

html_theme = "sphinx_book_theme"
html_static_path = ["_static"]
html_title = "py2Dmol Documentation"

html_theme_options = {
  "repository_url": "https://github.com/sokrypton/py2Dmol",
  "use_repository_button": True,
  "use_issues_button": True,
  "use_edit_page_button": True,
  "repository_branch": "main",
  "path_to_docs": "docs/source",
  "home_page_in_toc": True,
  "show_toc_level": 2,
  "navigation_with_keys": True,
}

# Copy button configuration
copybutton_prompt_text = r">>> |\.\.\. |\$ |In \[\d*\]: | {2,5}\.\.\.: | {5,8}: "
copybutton_prompt_is_regexp = True

# -- Options for autodoc -----------------------------------------------------
# This value contains a list of modules to be mocked up.
autodoc_mock_imports = []
