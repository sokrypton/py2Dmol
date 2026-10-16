"""The one place that says what the agent surface needs, and says it as a sentence.

``pip install "py2Dmol[agent]"`` on Python 3.12 succeeds and installs NO cisternal:
the extra is marker-gated so the install does not fail, and measured, uv resolves a
marker-gated extra to nothing on an interpreter below the marker. So the entry
points cannot assume the extra means cisternal is there; they ask, and exit 2 with
the fix rather than a ModuleNotFoundError from three imports down.
"""
from __future__ import annotations

import sys

MIN_PYTHON = (3, 13)
EXIT_MISSING = 2


def missing_agent_deps() -> str | None:
    """A one-line reason the agent surface cannot run here, or None if it can."""
    if sys.version_info < MIN_PYTHON:
        return (
            "py2dmol: the agent surface needs Python >= 3.13 (this is %d.%d); "
            "run it with `uvx --python 3.13 --from \"py2Dmol[agent]\" py2dmol ...`"
            % sys.version_info[:2]
        )
    for mod in ("cisternal", "cyclopts", "fastmcp"):
        try:
            __import__(mod)
        except ImportError:
            return ('py2dmol: the agent surface needs `pip install "py2Dmol[agent]"` '
                    "(%s is not installed)" % mod)
    return None


def require_agent_deps() -> None:
    """Exit 2 with the fix when the agent extra is not usable here."""
    why = missing_agent_deps()
    if why:
        print(why, file=sys.stderr)
        raise SystemExit(EXIT_MISSING)
