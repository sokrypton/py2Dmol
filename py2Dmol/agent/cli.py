"""`py2dmol`: the agent tools as a CLI, plus the plugin installer.

Every tool command comes from ``wire(None, app)`` over tools.py, so the CLI and the
MCP server share names, parameters and defaults. What is CLI-only lives here: the
``--json`` flag, how a result is printed, and the exit codes.

Exit codes (documented, stable):

    0  ok                         4  a file or id could not be found or fetched
    1  anything unexpected        5  the screenshot extra or a browser is missing
    2  the agent extra is missing 6  the page drew nothing in time
    3  the spec or an argument is invalid (validate exits 3 when invalid)
    7  a py2dmol config file is malformed
"""
from __future__ import annotations

import json
import sys
from typing import Any

import cisternal
import cyclopts
from cisternal import CliContext, CliContract, json_option
from cisternal.plugin import PluginSpec, plugin_app

from . import telemetry
from . import tools  # noqa: F401 - registers the "py2dmol" tools
from .cache import CacheConfigError, FetchError
from .screenshot import RenderTimeout, ScreenshotUnavailable
from .spec import SpecError

app = cyclopts.App(name="py2dmol", help="py2Dmol for agents: inspect structures, validate view specs, render HTML and images.")


def _human(result: Any) -> str:
    if not isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    lines = []
    for k, v in result.items():
        if isinstance(v, (dict, list)):
            v = json.dumps(v, default=str) if len(json.dumps(v, default=str)) < 100 else json.dumps(v, indent=2, default=str)
        lines.append(f"{k}: {v}")
    return "\n".join(lines)


def _emit(result: Any, ctx: CliContext) -> None:
    print(json.dumps(result, indent=2, default=str) if ctx.options["json_out"] else _human(result))


def _validate_fmt(result: dict, ctx: CliContext) -> None:
    _emit(result, ctx)
    if not result.get("valid"):
        sys.exit(3)


def _spec_error(exc: SpecError, ctx: CliContext) -> int:
    if ctx.options.get("json_out"):
        print(json.dumps(exc.as_dict(), indent=2))
    else:
        print(str(exc), file=sys.stderr)
    return 3


EXIT_CODES = {
    SpecError: _spec_error,
    ValueError: 3,
    FileNotFoundError: 4,
    FetchError: 4,
    ScreenshotUnavailable: 5,
    RenderTimeout: 6,
    CacheConfigError: 7,
}

cisternal.wire(
    None, app, registry=tools.REGISTRY,
    cli_contract=CliContract(options=[json_option()], format_success=_emit, exit_codes=EXIT_CODES),
    cli_contracts={"validate_spec": CliContract(format_success=_validate_fmt)},
)

PLUGIN = PluginSpec(
    name="py2dmol",
    package="py2Dmol",
    registry=tools.REGISTRY,
    imports=("py2Dmol.agent.tools",),
    snapshot="agent/agent_plugin.json",
    # Not cisternal's default `.praxia/manifest.toml`: py2Dmol keeps no .praxia
    # directory. The manifest sits beside the assets it lists.
    manifest="agent_assets/manifest.toml",
    distribution="py2Dmol",
    cli="py2dmol",
)
app.command(plugin_app(PLUGIN), name="plugin")


@app.command(name="screenshot-setup")
def screenshot_setup() -> int:
    """Download the Chromium that render_image uses (`playwright install chromium`, ~150 MB)."""
    from .screenshot import install_browser
    return install_browser()


def main() -> None:
    telemetry.init()
    app()


if __name__ == "__main__":
    main()
