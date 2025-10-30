# Documentation Quick Start

## Building the Documentation

1. **Install documentation dependencies** (one-time setup):

   ```bash
   pip install -e ".[docs]"
   ```

2. **Build the HTML documentation**:

   ```bash
   cd docs
   make html
   ```

3. **View the documentation**:

   ```bash
   # macOS
   open build/html/index.html

   # Linux
   xdg-open build/html/index.html

   # Windows
   start build/html/index.html
   ```

## Live Development Mode

For automatic rebuilding during documentation development:

```bash
cd docs
sphinx-autobuild source build/html
```

Then open <http://127.0.0.1:8000> in your browser. The page will automatically reload when you save changes.

## Cleaning Build Files

To remove all build artifacts:

```bash
cd docs
make clean
```

## Common Tasks

### Adding a New Documentation Page

1. Create a new `.rst` file in `docs/source/`
2. Add the filename (without extension) to the `toctree` in `docs/source/index.rst`
3. Rebuild the docs: `make html`

### Updating API Documentation

The API documentation is auto-generated from docstrings. To update:

1. Edit the docstrings in the source code
2. Rebuild the docs: `make html`

### Testing Documentation Build

Before committing, verify the documentation builds without errors:

```bash
cd docs
make clean
make html
```

Check for any warnings or errors in the output.

## Documentation Structure

```text
docs/
├── source/              # Documentation source files
│   ├── conf.py         # Sphinx configuration
│   ├── index.rst       # Main page
│   ├── installation.rst
│   ├── usage.rst
│   ├── examples.rst
│   ├── api.rst         # API reference (auto-generated)
│   ├── contributing.rst
│   ├── _static/        # Static files (CSS, images, etc.)
│   └── _templates/     # Custom templates
├── build/              # Built documentation (ignored by git)
├── Makefile            # Build commands for Unix/macOS
├── make.bat            # Build commands for Windows
└── README.md           # This file
```

## Publishing Documentation

The documentation is automatically built and deployed to GitHub Pages when code is pushed to the `main` branch via the `.github/workflows/docs.yml` workflow.

### Enabling GitHub Pages

If this is the first time setting up the documentation:

1. Go to your repository on GitHub
2. Navigate to Settings → Pages
3. Under "Build and deployment", select "GitHub Actions" as the source

The documentation will be available at: `https://maraxen.github.io/py2Dmol/`

## Troubleshooting

### Import Errors

If you get import errors when building:

```bash
pip install -e ".[docs]"
```

### Missing Dependencies

If a Sphinx extension is missing:

```bash
pip install <extension-name>
```

### Stale Cache

If changes aren't showing up:

```bash
make clean
make html
```

## Documentation Guidelines

- Write clear, concise docstrings for all public APIs
- Include examples in docstrings where helpful
- Use proper Sphinx directives (`:param:`, `:returns:`, etc.)
- Test all code examples to ensure they work
- Keep the documentation up-to-date with code changes
