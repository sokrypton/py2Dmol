# The agent surface: `py2dmol`, `py2dmol-mcp`, and the agent plugin

py2Dmol as a tool an agent can drive: a declarative **view spec**, seven tools built on
it and wired by [cisternal](https://pypi.org/project/cisternal/) into both a CLI and an
MCP server, an opt-in telemetry gate, and a Claude Code plugin carrying four skills and
three agents. This document is the design and the measurements behind it; the code is
`py2Dmol/agent/`, the plugin sources are `agent_assets/`, the generated bundle is
`plugin/`.

## 0. The constraint everything follows from

cisternal requires **Python >= 3.13** and hard-depends on fastmcp, cyclopts,
opentelemetry-api and pyyaml. py2Dmol is a notebook library whose audience is Colab
first. So **`import py2Dmol` never imports cisternal**, and the agent surface is an
extra:

```
pip install "py2Dmol[agent]"        # py2dmol (CLI) and py2dmol-mcp (MCP server)
pip install "py2Dmol[screenshot]"   # ...plus render_image, through Playwright
py2dmol screenshot-setup            # the one explicit Chromium download (~150 MB)
```

`tests/agent_spec.py` asserts the isolation in a fresh interpreter (no `py2Dmol.agent`,
cisternal, fastmcp, cyclopts or playwright after `import py2Dmol`), with a control that
proves the probe can see a leak.

🔴 **A MARKER-GATED EXTRA ON AN OLDER PYTHON INSTALLS NOTHING, AND SAYS NOTHING.**
Measured with uvx: `py2Dmol[agent]` with `cisternal; python_version >= "3.13"` on a
3.12 interpreter resolves the extra to no packages at all; without the marker it fails
to resolve. So the console scripts point at `py2Dmol/agent/_entry.py`, which checks
before anything imports cisternal and exits 2 with the fix, and the plugin launches the
server with `--python 3.13` so uv fetches a managed 3.13 instead.

## 1. The view spec

`view` is a stateful object whose output is a notebook display side effect; an agent
driving it method by method over MCP would hold hidden state across calls. A spec is the
whole picture as one JSON value - validated before anything renders, diffable, and
rebuilt into exactly the same viewer:

```json
{
  "spec": 1,
  "view": {"style": "cartoon", "color": "chain", "sidechains": true, "size": [600, 600]},
  "plugins": [{"name": "box", "source": "box.js", "version": "1"}],
  "structures": [{"source": "pdb:4HHB"}, {"source": "model.cif", "use_biounit": false}],
  "steps": [
    {"set_color": {"color": "#ff8800", "position": {"from": 141, "to": 184}}},
    {"show_sidechains": {"position": {"from": 55, "to": 65}}},
    {"orient": {"chain": "A"}}
  ]
}
```

- **One translation, not a second viewer.** `spec.build()` calls the public `view`
  methods and nothing else, so every rule they enforce is enforced once.
- **The vocabulary is read off the code.** `view` keys are checked against
  `inspect.signature(view.__init__)`, structure keys against `add_pdb`, each step's
  arguments against the named method. A keyword added to `view` is legal in a spec the
  same day. `STYLE_ALIASES` moved from inside `view.__init__` to module scope so the
  validator reads the same table (a no-op move).
- **`steps` is ordered**, because `show_sidechains` / `hide_sidechains` are relative.
- **Every issue at once, at its JSON path,** with the allowed values and a did-you-mean
  for near misses (`colour` -> `color`, `set_colour` -> `set_color`).

🔴 **A RANGE IS `{"from": a, "to": b}`, NEVER `[a, b]`.** In Python `position=(40, 60)`
is the range 40..59 and `[40, 60]` is two positions; JSON has no tuple, so a JSON
`[40, 60]` can only be the second. `tests/agent_spec.py` builds both and asserts
`[2, 3, 4]` against `[2, 5]`, and that they differ.

🔴 **`position` INDEXES WHAT THE OBJECT DRAWS** - one per polymer residue and one per
ligand ATOM, across chains. Ligand atoms sit between chains: on 4HHB chain A is 0-141,
its heme 141-184, chain B starts at 184. `inspect_structure` therefore reads
py2Dmol's own parse (it builds the object with `add_pdb`, biounit and all) and reports
ranges; a second parser would be a second answer to "which index is residue 45 of B".

A file's object is named for the file (`add_pdb` alone names it `"0"`, and steps address
objects by name). Structures fetched by id go to a resolved cache directory, never the
working directory: argument > `PY2DMOL_CACHE_DIR` (`none` disables) >
`[tool.py2dmol] cache_dir` in the nearest pyproject.toml >
`~/.config/py2dmol/config.toml` > a per-process temp dir. `vocabulary` reports which
layer decided.

## 2. The tools

One `@cisternal.tool` each (`py2Dmol/agent/tools.py`, registry `py2dmol`); `wire()`
builds the CLI command and the MCP tool from the same function.

| MCP tool | CLI | does |
|---|---|---|
| `inspect_structure` | `inspect` | chains, ligands, drawn-position ranges, sequences, pLDDT-likeness |
| `validate_spec` | `validate` | every issue with its path; CLI exits 3 when invalid |
| `render_html` | `render` | standalone interactive page (`save_html`) |
| `render_image` | `image` | PNG/SVG through headless Chromium (§3) |
| `save_state` | `state` | a state file a notebook or the website opens |
| `vocabulary` | `vocab` | every legal key, read off the installed code |
| `plugin_check` | `plugin-check` | registration rules, then a real render reading the registry's own state |

Plus `py2dmol plugin install|update|export|info|repo-bundle` (cisternal's `plugin_app`)
and `py2dmol screenshot-setup`.

- **Tool bodies never print.** Under MCP stdout is the protocol channel, and `view`
  reports problems with `print()`. Every body runs with stdout captured; what was
  printed comes back as `warnings`.
- **Exit codes:** 0 ok, 1 unexpected, 2 agent extra missing, 3 invalid spec or argument,
  4 file or id not found, 5 screenshot extra or browser missing, 6 the page drew nothing
  in time, 7 malformed config. `--json` on every command.
- 🔴 **`CisternalMiddleware()` WITH NO ADAPTER DEFAULTS TO `BathosAdapter`** - another
  tool's response shaping. The server passes `PassthroughAdapter()` and `reraise=True`,
  and installs the middleware only when telemetry is on.

## 3. `render_image`

A `view.save_image()` was built once and removed from the notebook API ("keep it simple,
provide user a html for bulk only"). The agent case is the reason the batch page cannot
meet: an agent cannot drop files on `render.html`, and a model that cannot see the
picture cannot critique it. It lives in `py2Dmol.agent`, behind the `screenshot` extra;
`view` is untouched.

- **One rendering path.** It loads the page `render_html` writes and exports through the
  renderer's own `toImage` - not a page screenshot - so dpi, export scale, transparency
  and the SVG-needs-the-2D-painter rule stay in `capture.js`. Opaque by default (an
  agent shown a transparent PNG may see black).
- 🔴 **THE BROWSER HAS A THREAD OF ITS OWN, because under MCP every tool body runs inside
  FastMCP's asyncio loop and Playwright's sync API refuses to run there.** The CLI has
  no loop, so the CLI and the first in-process tests passed; only driving the installed
  wheel's `py2dmol-mcp` over real stdio showed "It looks like you are using Playwright
  Sync API inside the asyncio loop". `ThreadedShooter` creates and calls the browser on
  one worker thread (sync Playwright objects are thread-bound anyway), and
  `tests/agent_tools.py` now calls `render_image` through an MCP client - mutated back
  to the plain shooter it fails with exactly that message.
- **The browser is found, never downloaded mid-call:** Playwright's own Chromium, then
  `PY2DMOL_CHROMIUM`, then the newest Chromium already in Playwright's cache from any
  version, else exit 5 with the install command.

Measured (2026-10-16, Playwright's headless shell, which has no WebGL2 - the 2D painter
draws): 1UBQ 0.46 s and 4HHB 0.55 s for the first image including page load, 0.06 s and
0.19 s for a second; browser launch 0.6 s. A Playwright that wants Chromium build 1248
drives a cached build 1243 correctly - which is why the cache fallback exists: a browser
installed once survives a uvx environment resolving a newer Playwright.

## 4. The plugin

`agent_assets/manifest.toml` (cisternal's default is `.praxia/manifest.toml`; py2Dmol
keeps no `.praxia` directory, and `PluginSpec(manifest=...)` points at this one):

- **Skills:** `using-py2Dmol` (the entry point: notebook vs agent, the spec workflow, the
  three selector rules), `augmenting-views` (confidence, heatmaps, contacts, side chains,
  focus, several objects), `embedding-py2Dmol` (the JS embed API: bundle choice,
  `show()` options, the selector grammar, panel markup, the traps), and
  `developing-py2Dmol-plugins` (the draw-plugin contract, with `assets/box.js` checked
  clean by `plugin_check`).
- **Agents:** `py2dmol-view-builder`, `py2dmol-plugin-developer`, `py2dmol-figure-critic`.
  🔴 **They inherit tools rather than listing them.** A plugin's MCP tools are named
  `mcp__plugin_py2dmol_py2dmol__<tool>`; an allowlist of bare names would match nothing
  and leave the agent with no tools at all.
- **MCP:** `launch = "uvx"`, `uvx_from = "py2Dmol[screenshot]=={version}"`,
  `command = ["--python", "3.13", "py2dmol-mcp"]`, which cisternal turns into
  `uvx --from py2Dmol[screenshot]==X --python 3.13 py2dmol-mcp`. A machine needs only
  uv: skills and agents need nothing at all.

Generated and committed: `plugin/` plus `.claude-plugin/marketplace.json`
(`py2dmol plugin repo-bundle`; CI form `--check`), so
`/plugin marketplace add sokrypton/py2Dmol` then `/plugin install py2dmol@py2dmol`
works with no Python. `py2Dmol/agent/agent_plugin.json` is the same bundle frozen for
the wheel (`cisternal assets snapshot`), which `py2dmol plugin install` uses when there
is no checkout. Both regenerate from the manifest:

```
py2dmol plugin repo-bundle --manifest agent_assets/manifest.toml
cisternal assets snapshot --manifest agent_assets/manifest.toml --out py2Dmol/agent/agent_plugin.json
```

**The MCP half works once a py2Dmol carrying the extra is on PyPI** (`uvx --from
py2Dmol[screenshot]==2.0.0`); PyPI has 1.6.5 today. The skills and agents work now.

## 5. Telemetry

Local JSONL through cisternal (`CISTERNAL_LOG_DIR` > ... > `~/.cisternal/logs`), and:

- never from `import py2Dmol` or `view.show()`;
- in the two entry points only when `CISTERNAL_TELEMETRY` is `all|1|true|yes|py2dmol`
  (cisternal's own `consumer_telemetry_enabled`, called rather than copied);
- tool calls recorded by cisternal (`timed_command` on the CLI, the middleware on MCP),
  plus `py2dmol.render` {kind, style, objects, frames, positions, ms} and
  `py2dmol.spec_invalid` {issues} - counts and enums only, no paths or ids.

## 6. Tests

| probe | lane | what |
|---|---|---|
| `tests/agent_spec.py` | node | import isolation, vocabulary parity, every issue at its path, the range translation, manifest version, no `.praxia` |
| `tests/agent_tools.py` | gpu | the 3.12 gate, exit codes from real subprocesses, CLI/MCP parity, render and image, `plugin_check` with a deliberately broken plugin as control |

`agent_tools.py` re-runs itself under `uv run --python 3.13 --with cisternal --with
playwright` when the suite's python lacks them. Mutations, each caught: the range
translation made a no-op, `py2Dmol.agent` imported from `__init__`, and the
`FileNotFoundError -> 4` exit mapping removed.

🔴 **A SCRIPT'S DIRECTORY IS `sys.path[0]`, AND `tests/` HOLDS A `packaging.py`.**
fastmcp imports the real `packaging` library; the first run of `agent_tools.py` got
`tests/packaging.py` instead, which ran and `sys.exit(0)`'d the probe halfway - green,
with its MCP checks never reached. It now drops its own directory from the path first.

## 7. Not done

- **Live viewers over MCP** (open a viewer and stream frames to it) have no host outside
  a notebook; v1 is file-out by design.
- **`render_image` camera presets** (several views in one call) were left out: the spec's
  own `orient`/`focus` steps are the one way to aim the camera.
- The co-maintainer decision on shipping an extra and a committed `plugin/` in this
  repo, versus a separate `py2Dmol-agent` package.
