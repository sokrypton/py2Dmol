"""The py2Dmol agent tools: one ``@cisternal.tool`` each, wired to the CLI and to MCP.

``wire()`` builds both surfaces from these functions (registry "py2dmol"), so the
CLI command and the MCP tool cannot disagree about a name, a parameter or a
default. This module never imports cli.py (the contracts live there), and
``import py2Dmol`` never imports this module.

THE RULES A TOOL BODY KEEPS (cisternal's wire guide, section 2):
- Return data, raise domain exceptions; the CLI maps them to exit codes, MCP to tool errors.
- Never print. Under MCP, stdout IS the protocol channel - and ``view`` reports
  problems with ``print()``. Every body runs under ``_quiet()``, which takes stdout
  away for the call and hands what was printed back as ``warnings``.
- Stateless: every call takes a spec or a path and writes files. Nothing depends on
  an earlier call (the one exception, a reused browser in a long-lived MCP server,
  is a cost saving with no observable state).
"""
from __future__ import annotations

import atexit
import contextlib
import io
import json
import tempfile
import time
from pathlib import Path
from typing import Literal

import cisternal

from . import spec as _spec
from . import telemetry
from .cache import cache_dir, cache_dir_source, fetch_afdb, fetch_pdb

REGISTRY = "py2dmol"


@contextlib.contextmanager
def _quiet():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        yield buf


def _lines(buf: io.StringIO) -> list[str]:
    return [ln for ln in buf.getvalue().splitlines() if ln.strip()]


def _counts(v) -> dict:
    objs = v.objects
    return {
        "objects": len(objs),
        "frames": sum(len(o["frames"]) for o in objs),
        "positions": sum(len(o["frames"][0]["coords"]) for o in objs if o["frames"]),
    }


def _build(spec_text: str, cache: str | None):
    try:
        plan = _spec.validate(spec_text)
    except _spec.SpecError as e:
        telemetry.event("spec_invalid", issues=len(e.issues))
        raise
    return plan, _spec.build(plan, cache=cache)


@cisternal.tool(registry=REGISTRY, name="inspect_structure", cli_name="inspect")
def inspect_structure(source: str, use_biounit: bool = True, cache: str | None = None) -> dict:
    """What is in a structure, in the terms a spec's selectors use.

    `source` is a path to a .pdb/.cif, `pdb:<code>` or `afdb:<UniProt accession>`.
    Reports each chain's and ligand's range of drawn positions (what a selector's
    `position` indexes), residue numbers, sequence, and whether the B-factor
    column looks like a pLDDT. Read this before writing selectors.
    """
    from .structure import inspect_file

    with _quiet() as log:
        kind, _, ref = source.partition(":")
        if kind == "pdb" and ref:
            path = fetch_pdb(ref, cache_dir(cache))
        elif kind == "afdb" and ref:
            path, _ = fetch_afdb(ref, cache_dir(cache))
        else:
            path = Path(source).expanduser()
            if not path.is_file():
                raise FileNotFoundError(f"no such file: {path}")
        out = inspect_file(path, use_biounit=use_biounit)
    out["warnings"] = out.get("warnings", []) + _lines(log)
    return out


@cisternal.tool(registry=REGISTRY, name="validate_spec", cli_name="validate")
def validate_spec(spec: str) -> dict:
    """Check a view spec without building it: every unknown key, missing file and bad selector, with its JSON path.

    `spec` is a path to a .json file or the JSON text itself. Returns
    {"valid": true, ...} or {"valid": false, "issues": [{path, message, allowed?}]}.
    """
    try:
        plan = _spec.validate(spec)
    except _spec.SpecError as e:
        telemetry.event("spec_invalid", issues=len(e.issues))
        return e.as_dict()
    return {"valid": True, "structures": len(plan.structures), "steps": len(plan.steps),
            "plugins": len(plan.plugins)}


@cisternal.tool(registry=REGISTRY, name="render_html", cli_name="render")
def render_html(spec: str, out: str, title: str | None = None,
                bundle: Literal["inline", "external"] = "inline", cache: str | None = None) -> dict:
    """Build a view spec into a standalone interactive HTML page.

    `inline` (default) writes one file that opens from file:// with no server;
    `external` writes the ~1.8 MB library beside it once, for many pages.
    """
    t0 = time.perf_counter()
    with _quiet() as log:
        _, v = _build(spec, cache)
        path = v.save_html(out, title=title, bundle=bundle)
    res = {"path": str(path), "bytes": Path(path).stat().st_size, **_counts(v), "warnings": _lines(log)}
    telemetry.event("render", kind="html", style=v.config["rendering"].get("style"),
                    ms=round((time.perf_counter() - t0) * 1000), **_counts(v))
    return res


_SHOOTER = None


def _shooter():
    global _SHOOTER
    if _SHOOTER is None:
        # Threaded: under MCP this runs inside an asyncio loop, where Playwright's
        # sync API refuses to work (screenshot.ThreadedShooter says why).
        from .screenshot import ThreadedShooter
        _SHOOTER = ThreadedShooter()
        atexit.register(_SHOOTER.close)
    return _SHOOTER


@cisternal.tool(registry=REGISTRY, name="render_image", cli_name="image")
def render_image(spec: str, out: str, format: Literal["png", "svg"] = "png", dpi: int = 150,
                 transparent: bool = False, cache: str | None = None) -> dict:
    """Build a view spec and save its picture as PNG or SVG, so you can look at it.

    Needs `pip install "py2Dmol[screenshot]"` and a Chromium (`py2dmol screenshot-setup`).
    The camera is the spec's own (orient/focus steps). The background is opaque
    unless `transparent`. SVG comes from the 2D painter and is vector.
    """
    t0 = time.perf_counter()
    with _quiet() as log:
        _, v = _build(spec, cache)
        with tempfile.TemporaryDirectory(prefix="py2dmol-img-") as tmp:
            page = Path(tmp) / "view.html"
            v.save_html(str(page))
            res = _shooter().shoot(page, v.config["viewer_id"], out, fmt=format, dpi=dpi,
                                   transparent=transparent)
    res.update(_counts(v))
    res["warnings"] = _lines(log)
    telemetry.event("render", kind=format, style=v.config["rendering"].get("style"),
                    ms=round((time.perf_counter() - t0) * 1000), **_counts(v))
    return res


@cisternal.tool(registry=REGISTRY, name="save_state", cli_name="state")
def save_state(spec: str, out: str, cache: str | None = None) -> dict:
    """Build a view spec and save it as a py2Dmol state file.

    The same format `view.load_state()` reads in a notebook and the website's
    session loader opens, so a view an agent built can be picked up by a person.
    """
    with _quiet() as log:
        _, v = _build(spec, cache)
        v.save_state(out)
    return {"path": str(out), **_counts(v), "warnings": _lines(log)}


@cisternal.tool(registry=REGISTRY, name="vocabulary", cli_name="vocab")
def vocabulary() -> dict:
    """Every key a view spec accepts - view options, structure keys, step verbs and their arguments, styles, colour modes.

    Read off the code at call time, so it cannot disagree with the installed py2Dmol.
    """
    out = _spec.vocabulary()
    where, layer = cache_dir_source()
    out["cache_dir"] = {"path": str(where) if where else None, "decided_by": layer}
    return out


@cisternal.tool(registry=REGISTRY, name="plugin_check", cli_name="plugin-check")
def plugin_check(source: str, name: str, payload: str = "{}", version: str | None = None,
                 structure: str | None = None, out: str | None = None) -> dict:
    """Check a py2Dmol draw plugin: Python-side refusals, then (with `structure`) a real render.

    `source` is the plugin's .js file, `payload` a JSON payload for it. Without
    `structure` only the registration rules are checked. With one (a path or
    pdb:/afdb: id) the plugin is drawn into that structure in headless Chromium
    and the registry's own state is reported: registered, rejected, draw errors -
    and `out`, if given, gets a PNG of the result. Needs the screenshot extra for
    that half.
    """
    from ..viewer import register_plugin

    src = Path(source).expanduser()
    js = src.read_text()
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as e:
        raise ValueError(f"payload is not JSON: {e}") from None
    with _quiet() as log:
        register_plugin(name, js, version)
    result = {"name": name, "registered_in_python": True, "warnings": _lines(log)}
    if structure is None:
        return result
    spec_doc = {
        "spec": 1,
        "plugins": [{"name": name, "source": str(src), **({"version": version} if version else {})}],
        "structures": [structure if ":" in structure else str(Path(structure).expanduser().resolve())],
        "steps": [{"add_plugin": {"name": name, "payload": data}}],
    }
    with _quiet() as log2, tempfile.TemporaryDirectory(prefix="py2dmol-plg-") as tmp:
        _, v = _build(json.dumps(spec_doc), None)
        page = Path(tmp) / "plugin.html"
        v.save_html(str(page))
        target = out or str(Path(tmp) / "plugin.png")
        shot = _shooter().shoot(page, v.config["viewer_id"], target)
        state = _shooter().plugin_state(v.config["viewer_id"])
    result.update({
        "registered_in_page": name in (state.get("registered") or []),
        "rejected": [r for r in state.get("rejected", []) if r.get("name") == name],
        "errors": [e for e in state.get("errors", []) if e.get("name") == name],
        "image": shot["path"] if out else None,
    })
    result["ok"] = result["registered_in_page"] and not result["rejected"] and not result["errors"]
    result["warnings"] += _lines(log2)
    return result
