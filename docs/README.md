# Documentation

This directory contains the Sphinx documentation for py2Dmol.

## Building the Documentation

### Prerequisites

Install the documentation dependencies:

```bash
pip install -e ".[docs]"
```

### Building HTML Documentation

From the `docs` directory:

```bash
make html
```

The built documentation will be in `build/html/`. Open `build/html/index.html` in a browser to view.

### Live Rebuild (Development)

For automatic rebuilding during development:

```bash
sphinx-autobuild source build/html
```

Then open http://127.0.0.1:8000 in your browser. The page will automatically reload when you make changes.

### Cleaning Build Files

To clean the build directory:

```bash
make clean
```

## Documentation Structure

- `source/conf.py` - Sphinx configuration
- `source/index.rst` - Main documentation page
- `source/installation.rst` - Installation instructions
- `source/usage.rst` - Usage guide
- `source/examples.rst` - Example code
- `source/api.rst` - API reference (auto-generated from docstrings)
- `source/contributing.rst` - Contributing guidelines
- `source/_static/` - Static files (CSS, images, etc.)
- `source/_templates/` - Custom templates

## Documentation Tools

This documentation uses:

- **Sphinx** - Documentation generator
- **sphinx-book-theme** - Clean, modern theme
- **myst-nb** - Markdown and Jupyter notebook support
- **sphinx-autodoc** - Auto-generate API docs from docstrings
- **sphinx-copybutton** - Add copy button to code blocks
- **sphinx-design** - Additional design elements
