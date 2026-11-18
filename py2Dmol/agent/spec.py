"""The view spec: one JSON document that says everything a picture is.

    {
      "spec": 1,
      "view": {"style": "cartoon", "color": "plddt", "size": [600, 600], "sidechains": true},
      "plugins": [{"name": "box", "source": "box.js", "version": "1"}],
      "structures": [
        {"source": "pdb:4HHB", "name": "hb"},
        {"source": "afdb:Q5VSL9"},
        {"source": "model.cif", "chains": ["A", "B"], "use_biounit": false}
      ],
      "steps": [
        {"set_color": {"color": "#ff8800", "position": {"from": 40, "to": 60}}},
        {"show_sidechains": {"position": {"from": 40, "to": 60}}},
        {"orient": {"chain": "A"}}
      ]
    }

🔴 A RANGE IS ``{"from": a, "to": b}``, NEVER ``[a, b]``. In Python
``position=(40, 60)`` is the range 40..59 and ``position=[40, 60]`` is exactly two
positions; JSON has no tuple, so a JSON ``[40, 60]`` can only be the second. The
object form is the range and ``build()`` turns it into the tuple. And ``position``
indexes what the object DRAWS - one per residue, one per ligand atom, across
chains - which ``inspect_structure`` reports as ranges.

WHY A SPEC AND NOT THE CLASS. ``view`` is a stateful object whose output is a
notebook display side effect; an agent driving it over MCP would be holding hidden
state across calls, which is what agents handle worst. A spec is the whole picture
in one value: it can be validated before anything renders, diffed, saved, and
rebuilt into exactly the same viewer.

ONE TRANSLATION, NOT A SECOND VIEWER. ``build()`` calls the public ``view`` methods
and nothing else, so every rule those methods already enforce (style names, colour
modes, plugin names, selectors) is enforced once, there.

THE VOCABULARY IS READ OFF THE CODE. Every key is checked against the live
signature of the method it lands on - ``view.__init__`` for ``view``, ``add_pdb``
for a structure, the named method for a step - so a keyword added to ``view``
tomorrow is legal in a spec tomorrow, with no second list to fall out of step.
``steps`` is ORDERED because two of its verbs are relative (``show_sidechains`` /
``hide_sidechains`` add to and take from what is there).
"""
from __future__ import annotations

import inspect
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import SPEC_VERSION

# The view methods a step may call. A whitelist rather than "any public method":
# show(), save_html() and friends are OUTPUTS, and the tools decide those.
STEP_VERBS = (
    "set_color", "set_opacity", "set_sse", "set_basepairs", "set_frame_policy",
    "show_sidechains", "hide_sidechains", "add_contacts", "add_bonds",
    "clip", "orient", "focus", "set_slots", "show_objects",
    "add_plugin", "set_plugin_option",
)
# Structure keys that are not add_pdb parameters.
STRUCTURE_EXTRA = ("source", "pae")
# add_pdb parameters a spec may not set: filepath is what `source` resolves to.
STRUCTURE_DENY = ("filepath",)
# view() parameters that mean nothing outside a notebook.
VIEW_DENY = ("persistence",)
TOP_KEYS = ("spec", "view", "plugins", "structures", "steps")
PLUGIN_KEYS = ("name", "source", "version")


@dataclass(frozen=True)
class Issue:
    """One problem, at a JSON path an agent can go and fix."""
    path: str
    message: str
    allowed: tuple[str, ...] = ()

    def as_dict(self) -> dict:
        d = {"path": self.path, "message": self.message}
        if self.allowed:
            d["allowed"] = list(self.allowed)
        return d


class SpecError(ValueError):
    """The spec cannot be built. ``issues`` names every problem found, not the first."""

    def __init__(self, issues: list[Issue]):
        self.issues = list(issues)
        lines = [f"{i.path}: {i.message}" for i in self.issues]
        super().__init__("invalid view spec:\n  " + "\n  ".join(lines))

    def as_dict(self) -> dict:
        return {"valid": False, "issues": [i.as_dict() for i in self.issues]}


@dataclass
class Plan:
    """A validated spec, with every relative path resolved."""
    view_kwargs: dict
    plugins: list[dict]
    structures: list[dict]
    steps: list[tuple[str, dict]]
    base_dir: Path
    warnings: list[str] = field(default_factory=list)


def _view_cls():
    from ..viewer import view
    return view


def _params(fn) -> dict[str, inspect.Parameter]:
    return {k: p for k, p in inspect.signature(fn).parameters.items() if k != "self"}


def view_parameters() -> dict[str, inspect.Parameter]:
    return {k: p for k, p in _params(_view_cls().__init__).items() if k not in VIEW_DENY}


def structure_parameters() -> dict[str, inspect.Parameter]:
    return {k: p for k, p in _params(_view_cls().add_pdb).items() if k not in STRUCTURE_DENY}


def step_parameters(verb: str) -> dict[str, inspect.Parameter]:
    return _params(getattr(_view_cls(), verb))


def load(spec: str | os.PathLike | dict) -> tuple[dict, Path]:
    """A spec from a dict, a JSON string, or a path to a .json file; and its base dir."""
    if isinstance(spec, dict):
        return spec, Path.cwd()
    text = str(spec)
    if text.lstrip().startswith("{"):
        return json.loads(text), Path.cwd()
    p = Path(text).expanduser()
    try:
        return json.loads(p.read_text()), p.resolve().parent
    except FileNotFoundError:
        raise SpecError([Issue("$", f"spec file not found: {p}")]) from None
    except json.JSONDecodeError as e:
        raise SpecError([Issue("$", f"{p} is not JSON: {e}")]) from None


def _unknown(what: str, k: str, names) -> str:
    import difflib
    close = difflib.get_close_matches(k, list(names), n=1)
    return f"unknown {what} {k!r}" + (f" - did you mean {close[0]!r}?" if close else "")


def _check_keys(path: str, given: dict, allowed: dict | tuple, issues: list[Issue]) -> None:
    names = tuple(allowed)
    for k in given:
        if k not in names:
            issues.append(Issue(f"{path}.{k}", _unknown("key", k, names), tuple(sorted(names))))


def _check_bind(path: str, verb: str, args: dict, issues: list[Issue]) -> None:
    params = step_parameters(verb)
    var_pos = [k for k, p in params.items() if p.kind is p.VAR_POSITIONAL]
    named = {k: p for k, p in params.items() if p.kind is not p.VAR_POSITIONAL}
    allowed = set(named) | set(var_pos)
    for k in args:
        if k not in allowed:
            issues.append(Issue(f"{path}.{k}", f"{verb}(): " + _unknown("parameter", k, allowed),
                                tuple(sorted(allowed))))
    for k, p in named.items():
        if p.default is p.empty and p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY) \
                and k not in args:
            issues.append(Issue(f"{path}.{k}", f"{verb}() needs {k!r}"))
    for k in var_pos:
        if k in args and not isinstance(args[k], list):
            issues.append(Issue(f"{path}.{k}", f"{k!r} is a list"))


def _check_position(path: str, value: Any, issues: list[Issue]) -> None:
    if value is None or value is True:
        return
    if isinstance(value, bool):
        issues.append(Issue(path, "position is an int, a list of ints, or {\"from\": a, \"to\": b}"))
    elif isinstance(value, int):
        return
    elif isinstance(value, list):
        if not all(isinstance(x, int) and not isinstance(x, bool) for x in value):
            issues.append(Issue(path, "a position list holds ints only"))
    elif isinstance(value, dict):
        if set(value) != {"from", "to"} or not all(isinstance(value[k], int) for k in ("from", "to")):
            issues.append(Issue(path, "a position range is {\"from\": int, \"to\": int} (to excluded)"))
        elif value["to"] <= value["from"]:
            issues.append(Issue(path, "a position range needs to > from"))
    else:
        issues.append(Issue(path, "position is an int, a list of ints, or {\"from\": a, \"to\": b}"))


def _to_python_position(value: Any) -> Any:
    if isinstance(value, dict) and set(value) == {"from", "to"}:
        return (value["from"], value["to"])
    return value


def _resolve_source(path: str, src: Any, base: Path, issues: list[Issue]) -> dict | None:
    if not isinstance(src, str) or not src.strip():
        issues.append(Issue(path, "source is a path, 'pdb:<code>' or 'afdb:<accession>'"))
        return None
    kind, _, ref = src.partition(":")
    if kind in ("pdb", "afdb") and ref:
        if kind == "pdb" and not (len(ref) == 4 and ref.isalnum()):
            issues.append(Issue(path, f"{ref!r} is not a four-character PDB code"))
            return None
        return {"kind": kind, "ref": ref}
    p = Path(src).expanduser()
    p = p if p.is_absolute() else base / p
    if not p.is_file():
        issues.append(Issue(path, f"no such file: {p}"))
        return None
    return {"kind": "file", "ref": str(p)}


def validate(spec: str | os.PathLike | dict, base_dir: Path | None = None) -> Plan:
    """Check everything that can be checked without building; raise SpecError listing it all."""
    data, base = load(spec)
    base = base_dir or base
    issues: list[Issue] = []
    if not isinstance(data, dict):
        raise SpecError([Issue("$", "a spec is a JSON object")])
    _check_keys("$", data, TOP_KEYS, issues)
    version = data.get("spec", SPEC_VERSION)
    if version != SPEC_VERSION:
        issues.append(Issue("$.spec", f"this py2Dmol reads spec {SPEC_VERSION}, not {version!r}"))

    view_kwargs = data.get("view", {}) or {}
    if not isinstance(view_kwargs, dict):
        issues.append(Issue("$.view", "view is an object of py2Dmol.view() keywords"))
        view_kwargs = {}
    _check_keys("$.view", view_kwargs, view_parameters(), issues)
    if "style" in view_kwargs:
        from ..viewer import STYLE_ALIASES
        if view_kwargs["style"] not in STYLE_ALIASES:
            issues.append(Issue("$.view.style", f"unknown style {view_kwargs['style']!r}",
                                tuple(STYLE_ALIASES)))

    plugins = []
    for i, pl in enumerate(data.get("plugins", []) or []):
        path = f"$.plugins[{i}]"
        if not isinstance(pl, dict):
            issues.append(Issue(path, "a plugin is {name, source, version?}"))
            continue
        _check_keys(path, pl, PLUGIN_KEYS, issues)
        for need in ("name", "source"):
            if need not in pl:
                issues.append(Issue(f"{path}.{need}", f"{need!r} is required"))
        if "source" in pl:
            p = Path(pl["source"]).expanduser()
            p = p if p.is_absolute() else base / p
            if not p.is_file():
                issues.append(Issue(f"{path}.source", f"no such file: {p}"))
            plugins.append(dict(pl, source=str(p)))

    structures = []
    s_allowed = (*structure_parameters(), *STRUCTURE_EXTRA)
    raw_structs = data.get("structures", []) or []
    if not raw_structs:
        issues.append(Issue("$.structures", "a spec needs at least one structure"))
    for i, st in enumerate(raw_structs):
        path = f"$.structures[{i}]"
        if isinstance(st, str):
            st = {"source": st}
        if not isinstance(st, dict):
            issues.append(Issue(path, "a structure is {source, ...add_pdb keywords} or a source string"))
            continue
        _check_keys(path, st, s_allowed, issues)
        src = _resolve_source(f"{path}.source", st.get("source"), base, issues)
        if src is not None:
            structures.append({"src": src, "kwargs": {k: v for k, v in st.items() if k not in STRUCTURE_EXTRA},
                               "pae": st.get("pae")})

    steps = []
    for i, step in enumerate(data.get("steps", []) or []):
        path = f"$.steps[{i}]"
        if not (isinstance(step, dict) and len(step) == 1):
            issues.append(Issue(path, "a step is {verb: {arguments}} with exactly one verb", STEP_VERBS))
            continue
        (verb, args), = step.items()
        if verb not in STEP_VERBS:
            issues.append(Issue(f"{path}.{verb}", _unknown("step", verb, STEP_VERBS), STEP_VERBS))
            continue
        args = args or {}
        if not isinstance(args, dict):
            issues.append(Issue(f"{path}.{verb}", "arguments are an object of keywords"))
            continue
        _check_bind(f"{path}.{verb}", verb, args, issues)
        if "position" in args:
            _check_position(f"{path}.{verb}.position", args["position"], issues)
        steps.append((verb, args))

    if issues:
        raise SpecError(issues)
    return Plan(view_kwargs=view_kwargs, plugins=plugins, structures=structures,
                steps=steps, base_dir=base)


def build(spec: str | os.PathLike | dict | Plan, base_dir: Path | None = None,
          cache: str | os.PathLike | None = None):
    """A py2Dmol.view holding everything the spec says, not yet shown anywhere."""
    from ..viewer import register_plugin
    from .cache import cache_dir, fetch_afdb, fetch_pdb

    plan = spec if isinstance(spec, Plan) else validate(spec, base_dir)
    v = _view_cls()(**plan.view_kwargs)
    issues: list[Issue] = []

    for i, pl in enumerate(plan.plugins):
        try:
            register_plugin(pl["name"], Path(pl["source"]).read_text(), pl.get("version"))
        except (ValueError, TypeError, OSError) as e:
            issues.append(Issue(f"$.plugins[{i}]", str(e)))

    fetch_dir = None
    for i, st in enumerate(plan.structures):
        path = f"$.structures[{i}]"
        kind, ref = st["src"]["kind"], st["src"]["ref"]
        kwargs = dict(st["kwargs"])
        try:
            if kind == "file":
                filepath = ref
                # add_pdb names an unnamed object "0"; steps address objects by
                # name, so a file's object is named for the file.
                kwargs.setdefault("name", Path(ref).stem)
            else:
                fetch_dir = fetch_dir or cache_dir(cache)
                if kind == "pdb":
                    filepath = str(fetch_pdb(ref, fetch_dir))
                    kwargs.setdefault("name", ref.upper())
                else:
                    want_pae = bool(st.get("pae", v.config["pae"]["enabled"]))
                    sp, pp = fetch_afdb(ref, fetch_dir, pae=want_pae)
                    filepath = str(sp)
                    kwargs.setdefault("name", ref.upper())
                    if pp is not None and "paes" not in kwargs:
                        m = v._parse_pae_json(str(pp))
                        if m is not None:
                            kwargs["paes"] = [m]
            if st.get("pae") and kind == "file" and "paes" not in kwargs:
                p = Path(st["pae"]).expanduser()
                p = p if p.is_absolute() else plan.base_dir / p
                kwargs["paes"] = [v._parse_pae_json(str(p))]
            n_before = len(v.objects)
            v.add_pdb(filepath, **kwargs)
            if len(v.objects) == n_before and not v.objects:
                issues.append(Issue(path, f"{ref} produced no structure"))
        except Exception as e:  # noqa: BLE001 - every failure is reported with its path
            issues.append(Issue(path, f"{type(e).__name__}: {e}"))

    if issues:
        raise SpecError(issues)

    for i, (verb, args) in enumerate(plan.steps):
        args = dict(args)
        if "position" in args:
            args["position"] = _to_python_position(args["position"])
        pos = []
        for k, p in step_parameters(verb).items():
            if p.kind is p.VAR_POSITIONAL and k in args:
                pos = list(args.pop(k))
        try:
            getattr(v, verb)(*pos, **args)
        except Exception as e:  # noqa: BLE001
            issues.append(Issue(f"$.steps[{i}].{verb}", f"{type(e).__name__}: {e}"))
    if issues:
        raise SpecError(issues)
    return v


def vocabulary() -> dict:
    """Every key a spec accepts, read off the methods it lands on."""
    from ..viewer import STYLE_ALIASES, VALID_COLOR_MODES

    def describe(params: dict) -> dict:
        out = {}
        for k, p in params.items():
            if p.kind is p.VAR_POSITIONAL:
                out[k] = {"list": True}
            elif p.default is p.empty:
                out[k] = {"required": True}
            else:
                d = p.default
                out[k] = {"default": d if isinstance(d, (str, int, float, bool, type(None), list, tuple)) else repr(d)}
        return out

    def first_line(fn) -> str:
        doc = inspect.getdoc(fn) or ""
        return doc.strip().splitlines()[0] if doc.strip() else ""

    cls = _view_cls()
    return {
        "spec": SPEC_VERSION,
        "top_level": list(TOP_KEYS),
        "styles": list(STYLE_ALIASES),
        "color_modes": sorted(VALID_COLOR_MODES),
        "sources": ["<path to .pdb/.cif>", "pdb:<4-char code>", "afdb:<UniProt accession>"],
        "view": describe(view_parameters()),
        "structure": {**describe(structure_parameters()),
                      "source": {"required": True}, "pae": {"default": None}},
        "steps": {verb: {"summary": first_line(getattr(cls, verb)),
                         "arguments": describe(step_parameters(verb))} for verb in STEP_VERBS},
        "plugin": {k: ({"required": True} if k != "version" else {"default": None}) for k in PLUGIN_KEYS},
    }
