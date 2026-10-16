"""Console-script targets. The gate runs BEFORE anything imports cisternal.

cli.py and mcp.py import cisternal at module top, so a console script pointed at
them directly would greet a Python 3.12 user with a ModuleNotFoundError three
imports deep. These two functions ask first and print the fix.
"""
from __future__ import annotations


def cli() -> None:
    from ._need import require_agent_deps
    require_agent_deps()
    from .cli import main
    main()


def mcp() -> None:
    from ._need import require_agent_deps
    require_agent_deps()
    from .mcp import main
    main()
