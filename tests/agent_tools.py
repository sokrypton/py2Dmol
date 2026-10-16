"""THE py2dmol CLI AND MCP SERVER: ONE TOOL SET, DOCUMENTED EXIT CODES, AND PICTURES THAT DRAW.

    python3 tests/agent_tools.py

Needs Python 3.13, cisternal, Playwright and a Chromium. When the running
interpreter lacks cisternal it re-runs itself under
`uv run --python 3.13 --with cisternal ... --with playwright`, so the suite's own
python3 is enough to start it. tests/agent_spec.py is the dependency-free half.

What each check would catch:

1. THE GATE. On Python 3.12 with no cisternal the console script exits 2 and names
   the fix - measured, `pip install py2Dmol[agent]` there installs no cisternal.
2. EXIT CODES. invalid spec 3 (with every issue as JSON), valid 0, missing file 4,
   no Playwright 5. Each is asserted from a real subprocess, because a body that
   returns an error envelope exits 0 and only a process can show it.
3. ONE TOOL SET. The MCP server lists exactly the tools the CLI wires, under the
   same names, and a tool error over MCP carries the issue paths.
4. THE PICTURES DRAW. render writes a page holding the viewer; image writes a PNG
   whose bytes are a PNG and an SVG with real paths. Control: an SVG of a viewer
   with nothing coloured differently still has paths, so the path count is
   compared against a minimum taken from the fixture, not "more than zero".
5. plugin_check SEES A BROKEN PLUGIN. The shipped box.js checks ok; a plugin that
   throws in prims() reports ok=false with a draw error; a source containing
   </script is refused with exit 3. Without the broken-plugin control, an
   ok=true could mean the check never looked.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FLAG = "PY2DMOL_AGENT_TOOLS_REEXEC"
# 🔴 THIS SCRIPT'S DIRECTORY IS sys.path[0], AND tests/ HOLDS A packaging.py.
# fastmcp imports the real `packaging` library; with tests/ first on the path it
# got tests/packaging.py instead, which ran and sys.exit(0)'d this probe halfway
# through - silently green. Drop it before any third-party import.
_here = str(Path(__file__).resolve().parent)
sys.path[:] = [p for p in sys.path if p not in ("", _here) and Path(p or ".").resolve() != Path(_here)]

try:
    import cisternal  # noqa: F401
    import playwright  # noqa: F401
except ImportError:
    if os.environ.get(ENV_FLAG):
        print("FAIL could not get cisternal + playwright even under uv")
        sys.exit(1)
    if not shutil.which("uv"):
        print("FAIL this probe needs uv (or a Python 3.13 env with py2Dmol[screenshot])")
        sys.exit(1)
    os.environ[ENV_FLAG] = "1"
    os.execvp("uv", ["uv", "run", "--no-project", "--python", "3.13",
                     "--with", "cisternal>=0.1.2", "--with", "numpy", "--with", "ipython",
                     "--with", "gemmi", "--with", "playwright", "python", str(Path(__file__).resolve())])

sys.path.insert(0, str(ROOT))
FAILS = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def run_cli(args, python=None, env_extra=None, cwd=None):
    code = ("import sys; sys.path.insert(0, %r); sys.argv = ['py2dmol'] + %r; "
            "from py2Dmol.agent._entry import cli; cli()" % (str(ROOT), list(args)))
    env = dict(os.environ)
    env.pop(ENV_FLAG, None)
    env.update(env_extra or {})
    argv = [*(python or [sys.executable]), "-c", code]
    p = subprocess.run(argv, capture_output=True, text=True, timeout=300, env=env, cwd=cwd)
    return p.returncode, p.stdout, p.stderr


tmp = Path(tempfile.mkdtemp(prefix="agent-tools-"))
# Two ideal alpha-helical CA traces: radius 2.3 A, rise 1.5 A, 100 degrees a residue,
# which puts consecutive CAs 3.8 A apart - inside the 5 A protein bond cutoff, so
# the tube has segments. (A first version spaced them ~10 A apart and drew 55
# unbonded spheres; the SVG path count below is what caught it.)
import math  # noqa: E402
lines, serial = [], 1
for ch, n, x0 in (("A", 30, 0.0), ("B", 25, 14.0)):
    for i in range(n):
        a = math.radians(100 * i)
        lines.append("ATOM  %5d  CA  ALA %s%4d    %8.3f%8.3f%8.3f  1.00 80.00           C"
                     % (serial, ch, i + 1, x0 + 2.3 * math.cos(a), 1.5 * i, 2.3 * math.sin(a)))
        serial += 1
(tmp / "two.pdb").write_text("\n".join(lines) + "\nEND\n")
good = tmp / "good.json"
good.write_text(json.dumps({"spec": 1, "view": {"style": "tube", "color": "chain", "size": [300, 300]},
                            "structures": ["two.pdb"],
                            "steps": [{"set_color": {"color": "#ff8800", "position": {"from": 5, "to": 15}}},
                                      {"orient": {}}]}))
bad = tmp / "bad.json"
bad.write_text(json.dumps({"view": {"colour": "chain"}, "structures": ["nope.pdb"],
                           "steps": [{"set_colour": {}}]}))

# ---------------------------------------------------------------- 1 the gate
uv = shutil.which("uv")
if uv:
    rc, out, err = run_cli(["vocab"], python=[uv, "run", "--no-project", "--python", "3.12", "--with", "numpy",
                                              "--with", "ipython", "--with", "gemmi", "python"])
    check(rc == 2 and "Python >= 3.13" in err, f"on 3.12 the CLI exits 2 and names the fix (rc={rc}, {err.strip()[:90]!r})")
else:
    check(False, "uv is needed to check the 3.12 gate")

# ---------------------------------------------------------------- 2 exit codes
rc, out, err = run_cli(["validate", str(bad), "--json"])
d = json.loads(out) if rc == 3 else {}
check(rc == 3 and not d.get("valid") and len(d.get("issues", [])) == 3,
      f"validate on a bad spec exits 3 with every issue as JSON (rc={rc}, issues={len(d.get('issues', []))})")
rc, out, _ = run_cli(["validate", str(good), "--json"])
check(rc == 0 and json.loads(out).get("valid") is True, f"validate on a good spec exits 0 (rc={rc})")
rc, _, err = run_cli(["inspect", str(tmp / "missing.cif")])
check(rc == 4, f"inspect on a missing file exits 4 (rc={rc})")
rc, out, err = run_cli(["render", str(bad), str(tmp / "x.html"), "--json"])
check(rc == 3 and "$.steps[0].set_colour" in out, f"render on a bad spec exits 3 and names the path (rc={rc})")
rc, out, _ = run_cli(["inspect", str(tmp / "two.pdb"), "--json"])
ins = json.loads(out) if rc == 0 else {}
check([(c["chain"], c["positions"]) for c in ins.get("chains", [])]
      == [("A", {"from": 0, "to": 30}), ("B", {"from": 30, "to": 55})],
      "inspect reports each chain's drawn-position range")

# ---------------------------------------------------------------- 4 pictures
page = tmp / "out" / "view.html"
rc, out, _ = run_cli(["render", str(good), str(page), "--json"])
res = json.loads(out) if rc == 0 else {}
html = page.read_text() if page.is_file() else ""
check(rc == 0 and res.get("positions") == 55 and "py2dmol_staticData" in html,
      f"render writes a standalone page holding the viewer (rc={rc}, {len(html)} bytes)")
png = tmp / "out" / "view.png"
rc, out, err = run_cli(["image", str(good), str(png), "--json"])
data = png.read_bytes() if png.is_file() else b""
check(rc == 0 and data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) > 5000,
      f"image writes a PNG (rc={rc}, {len(data)} bytes, {err.strip()[-120:]!r})")
svg = tmp / "out" / "view.svg"
rc, out, _ = run_cli(["image", str(good), str(svg), "--format", "svg", "--json"])
text = svg.read_text() if svg.is_file() else ""
check(rc == 0 and text.count("<path") >= 54, f"an SVG export has a path per segment at least ({text.count('<path')} paths)")
# exit 5: a Python with no Playwright, built by blocking the import
block = ("import sys, builtins; _imp = builtins.__import__\n"
         "def imp(n, *a, **k):\n"
         "    if n.startswith('playwright'): raise ImportError(n)\n"
         "    return _imp(n, *a, **k)\n"
         "builtins.__import__ = imp\n")
code = block + ("sys.path.insert(0, %r); sys.argv = ['py2dmol', 'image', %r, %r]\n"
                "from py2Dmol.agent._entry import cli; cli()" % (str(ROOT), str(good), str(tmp / "y.png")))
p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=300)
check(p.returncode == 5 and "playwright install chromium" in p.stderr,
      f"image without Playwright exits 5 and names the install (rc={p.returncode})")

# ---------------------------------------------------------------- 5 plugin_check
box = ROOT / "agent_assets" / "skills" / "developing-py2Dmol-plugins" / "assets" / "box.js"
payload = json.dumps({"min": [0, 0, -8], "max": [12, 40, 8]})
rc, out, err = run_cli(["plugin-check", str(box), "box", "--payload", payload, "--structure", str(tmp / "two.pdb"), "--json"])
r = json.loads(out) if rc == 0 else {}
check(rc == 0 and r.get("ok") is True, f"the shipped box.js plugin checks ok (rc={rc}, {r or err.strip()[-150:]})")
broken = tmp / "broken.js"
broken.write_text(box.read_text().replace('name: "box"', 'name: "broken"').replace(
    "prims: function (ctx) {", "prims: function (ctx) { throw new Error('deliberately broken');"))
rc, out, err = run_cli(["plugin-check", str(broken), "broken", "--payload", payload, "--structure", str(tmp / "two.pdb"), "--json"])
r = json.loads(out) if rc == 0 else {}
check(rc == 0 and r.get("ok") is False and r.get("errors"),
      f"control: a plugin that throws in prims() reports ok=false with a draw error ({r.get('errors')})")
evil = tmp / "evil.js"
evil.write_text("var s = '</script>';")
rc, out, err = run_cli(["plugin-check", str(evil), "evil"])
check(rc == 3, f"a source containing </script is refused with exit 3 (rc={rc})")

# ---------------------------------------------------------------- 3 one tool set
from fastmcp import Client  # noqa: E402

from py2Dmol.agent.mcp import build_server  # noqa: E402


async def mcp_side():
    async with Client(build_server()) as c:
        names = sorted(t.name for t in await c.list_tools())
        try:
            await c.call_tool("render_html", {"spec": str(bad), "out": str(tmp / "z.html")})
            err = ""
        except Exception as e:  # noqa: BLE001
            err = str(e)
        # 🔴 render_image OVER MCP runs inside FastMCP's event loop, where
        # Playwright's sync API refuses to work; the CLI has no loop and passed.
        try:
            r = await c.call_tool("render_image", {"spec": str(good), "out": str(tmp / "out" / "mcp.png")})
            shot = (r.structured_content or {}).get("result", r.structured_content) or {}
        except Exception as e:  # noqa: BLE001
            shot = {"error": str(e).splitlines()[0]}
        return names, err, shot


names, err, shot = asyncio.run(mcp_side())
mcp_png = tmp / "out" / "mcp.png"
check(mcp_png.is_file() and mcp_png.read_bytes()[:4] == b"\x89PNG",
      f"render_image works over MCP, inside an event loop ({shot.get('error') or shot.get('path')})")
expected = sorted(["inspect_structure", "validate_spec", "render_html", "render_image", "save_state",
                   "vocabulary", "plugin_check"])
check(names == expected, f"the MCP server lists the seven tools ({names})")
rc, helptext, _ = run_cli(["--help"])
want_cli = ["inspect", "validate", "render", "image", "state", "vocab", "plugin-check"]
missing = [c for c in want_cli if f" {c} " not in helptext]
check(rc == 0 and not missing, f"the CLI wires the same seven (missing {missing})")
check("$.steps[0].set_colour" in err, "an MCP tool error carries the spec's issue paths")

print(("FAIL: %d" % len(FAILS)) if FAILS else "all agent_tools checks passed")
sys.exit(1 if FAILS else 0)
