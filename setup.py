import re
from pathlib import Path

from setuptools import setup, find_packages

# ...read out of the package rather than retyped here. Importing it would pull
# in numpy and IPython before they are installed, so this reads the line.
_init = Path(__file__).parent.joinpath('py2Dmol', '__init__.py').read_text()
VERSION = re.search(r'^__version__ = "([^"]+)"', _init, re.M).group(1)

setup(
    name='py2Dmol',
    version=VERSION,
    author='sokrypton',
    author_email='so3@mit.edu',
    description='A Python library for visualizing protein structures in 2D.',
    long_description='A Python library for visualizing protein structures in 2D.',
    long_description_content_type='text/markdown',
    url='https://github.com/sokrypton/py2Dmol',
    packages=find_packages(),
    include_package_data=True,
    # EVERY RESOURCE viewer.py OPENS. It reads these by name through
    # importlib.resources, so a file missing here is not a degraded viewer - it
    # is a FileNotFoundError on the first show(), in the wheel only, where no
    # test in this repo runs. viewer-cartoon-gpu.min.js was missing and
    # viewer.py:1329 opens it unconditionally.
    #
    # There is no MANIFEST.in and no pyproject.toml, so include_package_data
    # above contributes nothing and this list is the whole of it.
    # tests/packaging.py builds a wheel and imports it, which is the only way
    # this list can be checked at all.
    # PER-DIRECTORY GLOBS, not eighteen literal paths. The resources moved into
    # core/, parts/, cartoon/, panels/ and align/, and a list that long is a list
    # that goes stale - which it did once already, shipping a wheel without the
    # GPU renderer. tests/packaging.py checks these against what viewer.py reads.
    # WHAT SHIPS IS THE BUNDLES, not the two dozen source files they are built
    # from. tools/bundle.py concatenates and minifies each target; the panels
    # stay loose because viewer.py adds them only when the config asks.
    # tests/packaging.py checks this against what viewer.py actually reads.
    package_data={
        'py2Dmol': [
            'resources/viewer.html',
            # ...the NOTEBOOK bundle only. The glob that was here also shipped
            # py2Dmol.embed.min.js, a web artefact in
            # every pip install, which viewer.py never opens. tests/packaging.py
            # fails if it ever opens one that is not listed here.
            # ONE, since the three narrow notebook builds became one complete
            # bundle - see tools/bundle.py. Naming files that no longer exist
            # is not an error setuptools reports; it just ships nothing for
            # them, and the omission only shows up in a release environment
            # where the setuptools-scm plugin is not there to cover for it.
            'resources/bundles/py2Dmol.notebook.min.js',
            # The agent plugin bundle (skills, agents, MCP launch) that
            # `py2dmol plugin install` installs from; written by
            # `cisternal assets snapshot` from agent_assets/manifest.toml.
            'agent/agent_plugin.json',
        ],
    },
    # THE AGENT SURFACE IS AN EXTRA, never a dependency of `import py2Dmol`.
    # cisternal needs Python 3.13 and brings fastmcp and cyclopts; the notebook
    # package keeps its own floor. The marker keeps `pip install py2Dmol[agent]`
    # from failing on an older Python - measured, it then installs NO
    # cisternal, which is why the console scripts check and print the fix
    # (py2Dmol/agent/_need.py) and why the plugin launches with --python 3.13.
    extras_require={
        'agent': ['cisternal>=0.1.2; python_version>="3.13"'],
        'screenshot': [
            'cisternal>=0.1.2; python_version>="3.13"',
            'playwright>=1.48',
        ],
    },
    entry_points={
        'console_scripts': [
            'py2dmol=py2Dmol.agent._entry:cli',
            'py2dmol-mcp=py2Dmol.agent._entry:mcp',
        ],
    },
    license='BEER-WARE',
    classifiers=[
        'Programming Language :: Python :: 3',
        'Operating System :: OS Independent',
    ],
    python_requires='>=3.6',
    install_requires=[
        'numpy',
        'ipython',
        'gemmi',
    ],
)
