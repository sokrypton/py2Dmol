"""THE AGENT SPEC TRANSLATES ONTO view, AND import py2Dmol NEVER PULLS IN cisternal.

    python3 tests/agent_spec.py

Node lane: no browser, no cisternal, any Python the notebook package runs on.
tests/agent_tools.py is the other half (the CLI, MCP, renders - Python 3.13).

What each check would catch, and the control that proves it can fail:

1. IMPORT ISOLATION. `import py2Dmol` in a fresh interpreter loads none of
   py2Dmol.agent, cisternal, fastmcp, cyclopts, playwright. Control: the same probe
   on `import py2Dmol.agent.tools`-equivalent (`py2Dmol.agent.spec`) must load
   py2Dmol.agent, or the probe cannot see a leak.
2. VOCABULARY PARITY. Every view() keyword is a legal `view` key and every step verb
   is a real view method whose parameters the vocabulary lists. Control: a keyword
   that view() does not have is refused.
3. EVERY ISSUE AT ONCE, AT ITS PATH. A spec with eight distinct faults reports eight
   issues, each at the right JSON path, with did-you-mean on near misses.
4. A JSON RANGE IS {"from", "to"}. {"from": 2, "to": 5} colours positions 2, 3, 4 and
   NOT 5; the list [2, 5] colours exactly 2 and 5. Control: the two specs must give
   different colour maps, or the translation is a no-op.
5. THE MANIFEST'S VERSION IS THE PACKAGE'S, and nothing tracked under agent_assets/
   or plugin/ names a .praxia path.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
FAILS = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


# ---------------------------------------------------------------- 1 isolation
PROBE = ("import sys; sys.path.insert(0, %r); import %s; "
         "bad=[m for m in ('py2Dmol.agent','cisternal','fastmcp','cyclopts','playwright') if m in sys.modules]; "
         "print(','.join(bad))")


def loaded_after(stmt):
    out = subprocess.run([sys.executable, "-c", PROBE % (str(ROOT), stmt)],
                         capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        return None, out.stderr.strip().splitlines()[-1:]
    return out.stdout.strip(), None


leaked, err = loaded_after("py2Dmol")
check(err is None and leaked == "", f"import py2Dmol loads no agent/cisternal module (got {leaked!r} {err or ''})")
ctrl, err = loaded_after("py2Dmol.agent.spec")
check(err is None and "py2Dmol.agent" in (ctrl or ""), "control: importing py2Dmol.agent.spec is seen by the probe")

# ---------------------------------------------------------------- 2 vocabulary
import inspect  # noqa: E402

import py2Dmol  # noqa: E402
from py2Dmol.agent import spec as S  # noqa: E402

voc = S.vocabulary()
view_params = [k for k in inspect.signature(py2Dmol.view.__init__).parameters if k != "self"]
missing = [k for k in view_params if k not in voc["view"] and k not in S.VIEW_DENY]
check(not missing, f"every view() keyword is in the vocabulary (missing {missing})")
for verb in S.STEP_VERBS:
    fn = getattr(py2Dmol.view, verb, None)
    check(callable(fn), f"step verb {verb} is a view method")
    if callable(fn):
        params = [k for k in inspect.signature(fn).parameters if k != "self"]
        check(sorted(params) == sorted(voc["steps"][verb]["arguments"]),
              f"vocabulary lists {verb}()'s own parameters")
from py2Dmol.viewer import STYLE_ALIASES, VALID_COLOR_MODES  # noqa: E402
check(voc["styles"] == list(STYLE_ALIASES), "styles come from viewer.STYLE_ALIASES")
check(set(voc["color_modes"]) == set(VALID_COLOR_MODES), "colour modes come from viewer.VALID_COLOR_MODES")

# ---------------------------------------------------------------- fixture
# A two-chain CA-only structure written here, so the test needs no download.
def pdb_text():
    lines = []
    serial = 1
    for ch, n, x0 in (("A", 8, 0.0), ("B", 6, 20.0)):
        for i in range(n):
            lines.append("ATOM  %5d  CA  ALA %s%4d    %8.3f%8.3f%8.3f  1.00 50.00           C"
                         % (serial, ch, i + 1, x0 + 3.8 * i, 0.0, 0.0))
            serial += 1
    lines.append("END")
    return "\n".join(lines) + "\n"


tmp = Path(tempfile.mkdtemp(prefix="agent-spec-"))
(tmp / "two.pdb").write_text(pdb_text())


def try_validate(doc):
    try:
        S.validate(doc, base_dir=tmp)
        return []
    except S.SpecError as e:
        return e.issues


# control for 2: an unknown view keyword is refused
iss = try_validate({"view": {"no_such_option": 1}, "structures": ["two.pdb"]})
check(any(i.path == "$.view.no_such_option" for i in iss), "control: an unknown view keyword is refused")

# ---------------------------------------------------------------- 3 all issues
bad = {
    "view": {"style": "cartoony", "colour": "chain"},
    "structures": [{"source": "missing.cif"}, {"source": "pdb:12"}],
    "steps": [
        {"set_colour": {"color": "red"}},
        {"set_color": {"position": [1, "x"]}},
        {"show_sidechains": {"position": {"from": 5}}},
    ],
}
iss = try_validate(bad)
paths = {i.path for i in iss}
want = {"$.view.style", "$.view.colour", "$.structures[0].source", "$.structures[1].source",
        "$.steps[0].set_colour", "$.steps[1].set_color.color", "$.steps[1].set_color.position",
        "$.steps[2].show_sidechains.position"}
check(paths == want, f"eight faults, eight issues at their paths (extra {paths - want}, missing {want - paths})")
msgs = {i.path: i.message for i in iss}
check("did you mean 'color'" in msgs.get("$.view.colour", ""), "a near-miss key suggests the right one")
check("did you mean 'set_color'" in msgs.get("$.steps[0].set_colour", ""), "a near-miss verb suggests the right one")
check(try_validate({"structures": ["two.pdb"]}) == [], "a minimal spec is valid")

# ---------------------------------------------------------------- 4 ranges
def colour_map(position):
    doc = {"view": {"color": "chain"}, "structures": ["two.pdb"],
           "steps": [{"set_color": {"color": "#ff0000", "position": position}}]}
    v = S.build(doc, base_dir=tmp)
    obj = v.objects[-1]
    return obj, v


obj_range, v1 = colour_map({"from": 2, "to": 5})
obj_list, v2 = colour_map([2, 5])
check(obj_range["name"] == "two", "a file's object is named for the file")


def coloured_positions(obj):
    # set_color stores {"type": "advanced", "value": {"position": {i: colour}}}
    c = (obj.get("color") or {}).get("value") or {}
    return sorted(int(k) for k in (c.get("position") or {}))


cr, cl = coloured_positions(obj_range), coloured_positions(obj_list)
check(cr == [2, 3, 4], f'{{"from": 2, "to": 5}} colours positions 2, 3, 4 (got {cr})')
check(cl == [2, 5], f"[2, 5] colours exactly 2 and 5 (got {cl})")
check(cr != cl, "control: the range and the list are different selections")

# build errors carry the step path
try:
    S.build({"structures": ["two.pdb"], "steps": [{"set_color": {"color": "red", "chain": "A", "position": 1}}]},
            base_dir=tmp)
    check(False, "set_color with chain AND position is refused at its step path")
except S.SpecError as e:
    check(any(i.path == "$.steps[0].set_color" for i in e.issues),
          "set_color with chain AND position is refused at its step path")

# ---------------------------------------------------------------- 5 manifest
import re  # noqa: E402
import tomllib  # noqa: E402

man = tomllib.loads((ROOT / "agent_assets" / "manifest.toml").read_text())
check(man["plugin"]["version"] == py2Dmol.__version__,
      f"agent_assets/manifest.toml version {man['plugin']['version']} == __version__ {py2Dmol.__version__}")
mcp_cmd = man["plugin"]["mcp"]["command"]
check(mcp_cmd[:2] == ["--python", "3.13"], "the plugin's MCP launch pins --python 3.13 (uvx drops the extra otherwise)")
tracked = subprocess.run(["git", "ls-files", "agent_assets", "plugin", ".claude-plugin"], cwd=ROOT,
                         capture_output=True, text=True).stdout.split()
praxia = [f for f in tracked if ".praxia" in f]
check(not praxia, f"no tracked agent asset lives under .praxia ({praxia})")
for f in tracked:
    if f.endswith("/SKILL.md") and f.startswith("plugin/skills/"):
        head = (ROOT / f).read_text().split("---")
        check(len(head) >= 3 and re.search(r"^name: ", head[1], re.M) and re.search(r"^description: ", head[1], re.M),
              f"{f} has name and description frontmatter")

snap = json.loads((ROOT / "py2Dmol" / "agent" / "agent_plugin.json").read_text())
check(snap.get("bundle", {}).get("metadata", {}).get("version", py2Dmol.__version__).split("+")[0] == py2Dmol.__version__,
      "the packaged plugin snapshot is this version's")

print(("FAIL: %d" % len(FAILS)) if FAILS else "all agent_spec checks passed")
sys.exit(1 if FAILS else 0)
