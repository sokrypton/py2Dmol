"""py2Dmol for agents: a declarative view spec, and the CLI and MCP tools built on it.

Nothing here is imported by ``import py2Dmol``, and nothing at this package's top
level imports cisternal. The notebook package keeps its own dependencies
(numpy, ipython, gemmi) and its own Python floor; cisternal needs Python 3.13
and brings fastmcp and cyclopts, so it lives behind the ``agent`` extra:

    pip install "py2Dmol[agent]"        # the py2dmol CLI and the py2dmol-mcp server
    pip install "py2Dmol[screenshot]"   # ...and render_image, through Playwright

Layout, in dependency order:

    spec.py        the view spec: validate() and build() onto py2Dmol.view. No cisternal.
    structure.py   inspect_structure(): what is in a file, for writing selectors. No cisternal.
    cache.py       where fetched structures go. No cisternal.
    screenshot.py  render_image() through Playwright, imported lazily. No cisternal.
    tools.py       the @cisternal.tool functions over the four above.
    cli.py         `py2dmol`, wire(None, app) plus the plugin sub-app.
    mcp.py         `py2dmol-mcp`, wire(server) on stdio.
    telemetry.py   opt-in cisternal.init() for the two entry points.
"""

SPEC_VERSION = 1
