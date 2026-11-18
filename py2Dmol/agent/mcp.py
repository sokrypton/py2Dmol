"""`py2dmol-mcp`: the agent tools as an MCP server on stdio.

The tools are tools.py's ``@cisternal.tool`` functions; ``wire(server)`` registers
them here exactly as ``wire(None, app)`` registers them on the CLI. Telemetry for
the MCP path is ``CisternalMiddleware``'s, installed only when the user opted in.

🔴 ``CisternalMiddleware()`` with no adapter DEFAULTS TO ``BathosAdapter`` - another
tool's response shaping. It gets ``PassthroughAdapter`` and ``reraise=True`` so a
result reaches the client unmodified and an exception surfaces as FastMCP's own
tool error.
"""
from __future__ import annotations

import cisternal
from fastmcp import FastMCP

from . import telemetry
from . import tools  # noqa: F401 - registers the "py2dmol" tools

INSTRUCTIONS = (
    "py2Dmol renders protein/nucleic-acid structures. Work in this order: "
    "inspect_structure (what chains, ligands and position ranges exist) -> write a view "
    "spec (call vocabulary for every legal key) -> validate_spec -> render_html for an "
    "interactive page and/or render_image to look at the picture. A position range in a "
    'spec is {"from": a, "to": b}; a JSON list means exactly those positions.'
)


def build_server() -> FastMCP:
    server = FastMCP("py2dmol", instructions=INSTRUCTIONS)
    if telemetry.init():
        from cisternal.adapters.base import PassthroughAdapter
        from cisternal.adapters.v3_middleware import CisternalMiddleware
        server.add_middleware(CisternalMiddleware(adapter=PassthroughAdapter(), reraise=True))
    cisternal.wire(server, registry=tools.REGISTRY, cli_telemetry=False)
    return server


def main() -> None:
    build_server().run()


if __name__ == "__main__":
    main()
