"""Every resource viewer.py opens must be in the wheel.

    python3 tests/packaging.py            # static: source against source
    python3 tests/packaging.py --wheel    # ...and build a real wheel and look

THE ONE LIST NOTHING IN THIS REPO EXERCISED. viewer.py reads its JavaScript by
name through importlib.resources, and setup.py names the files that go into the
distribution. Those are two hand-maintained lists of the same set, and they
drifted: `viewer-cartoon-gpu.min.js` arrived in the GPU merge, viewer.py opens
it UNCONDITIONALLY on the include_libs path, and setup.py never learned about
it. Every test here passes anyway, because in a source checkout the package
resolves to the repo and the file is simply there. The failure needs a wheel,
and only a user has one: FileNotFoundError on the first show().

So this checks the two lists against each other rather than against a copy of
the answer - a third list would just be another thing to drift. The names are
READ OUT OF THE SOURCE:

  * what viewer.py opens - every open_text(py2dmol_resources, '...') literal,
    including the ones inside `if self.config[...]` branches, because a
    conditional read still needs the file present when the condition holds;
  * what setup.py ships - the package_data entries under 'py2Dmol'.

--wheel builds the distribution and looks inside. Read its answer carefully,
because A LOCAL WHEEL PROVES LESS THAN IT APPEARS TO. `include_package_data=True`
with no MANIFEST.in contributes nothing ON ITS OWN - but if `setuptools-scm` (or
another revision-control plugin) happens to be installed, it sweeps in every
git-tracked file under the package and the wheel comes out complete whatever
package_data says. That is what happens on this machine: the wheel contained all
seventeen resources, including the one setup.py had forgotten.

The release does not. `.github/workflows/publish-to-pypi.yml` installs `build`
and `twine` and nothing else, so `python -m build` gets an isolated environment
with no plugin, `include_package_data` contributes nothing, and package_data is
the whole of it. The missing file would have reached PyPI and nowhere else.

So the STATIC check is the one that means something, and --wheel warns when the
environment is lying to it.
"""
import ast
import glob
import os
import re
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def opened_by_viewer():
    """Resource names viewer.py hands to importlib.resources, and their lines.

    THE NAME, WHEREVER IT IS WRITTEN. This used to require the literal to sit
    inside the _resource_text(...) call, and viewer.py now picks between two
    bundles - so the argument became a variable and this found NOTHING, which
    it reported as success. Both names are still in the file, three lines up.
    """
    src = open(os.path.join(ROOT, "py2Dmol", "viewer.py")).read()
    out = {}
    for m in re.finditer(r"""["']((?:bundles/)?[\w./-]+\.(?:min\.js|html))["']""", src):
        name = m.group(1)
        if name.endswith((".min.js", ".html")):
            out.setdefault(name, src[:m.start()].count("\n") + 1)
    return out


# THE ENTRIES AS WRITTEN, before the globs are expanded. Expanding is what
# makes a dead entry invisible: it matches nothing, contributes nothing, and
# every check downstream sees a set that simply does not mention it.
RAW_PACKAGE_DATA = []


def shipped_by_setup():
    """The package_data entries for the py2Dmol package, as bare filenames."""
    tree = ast.parse(open(os.path.join(ROOT, "setup.py")).read())
    for node in ast.walk(tree):
        if not isinstance(node, ast.keyword) or node.arg != "package_data":
            continue
        for key, val in zip(node.value.keys, node.value.values):
            if getattr(key, "value", None) != "py2Dmol":
                continue
            # ...GLOBS EXPANDED, and as the path under resources/, which is how
            # viewer.py names them. setup.py lists directories rather than
            # eighteen literal paths, so comparing the strings would say the
            # wheel ships nothing.
            out = set()
            for e in val.elts:
                RAW_PACKAGE_DATA.append(e.value)
                for hit in glob.glob(os.path.join(ROOT, "py2Dmol", e.value)):
                    out.add(os.path.relpath(hit, os.path.join(ROOT, "py2Dmol",
                                                              "resources")))
            return out
    return set()


def wheel_contents():
    """Build a wheel into a temp dir and list what landed in it."""
    with tempfile.TemporaryDirectory() as d:
        r = subprocess.run([sys.executable, "-m", "build", "--wheel", "--outdir", d],
                           cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
            sys.exit("could not build a wheel: " + " / ".join(tail))
        whl = [f for f in os.listdir(d) if f.endswith(".whl")]
        if not whl:
            sys.exit("build produced no wheel")
        with zipfile.ZipFile(os.path.join(d, whl[0])) as z:
            return {os.path.basename(n) for n in z.namelist()}, whl[0]


opened = opened_by_viewer()
shipped = shipped_by_setup()
print(f"viewer.py opens {len(opened)} resources; setup.py ships {len(shipped)}")

bad = []
for name, line in sorted(opened.items()):
    mark = "ok " if name in shipped else "NOT SHIPPED"
    print(f"  {mark:11s} {name}  (viewer.py:{line})")
    if name not in shipped:
        bad.append(f"viewer.py:{line} opens {name}, which setup.py does not ship"
                   " - a wheel raises FileNotFoundError on the first show()")

# ...and the other direction, which is only untidy rather than broken: a file
# shipped and never opened is dead weight in every install.
for name in sorted(shipped - set(opened)):
    print(f"  unused      {name}  (shipped, never opened)")

if not opened:
    bad.append("no _resource_text(...) calls found at all - this"
               " check has stopped reading viewer.py and would pass forever")
if not shipped:
    bad.append("no package_data for 'py2Dmol' found in setup.py - this check has"
               " stopped reading it and would pass forever")

# --- AND EVERY FILE IT NAMES HAS TO EXIST -----------------------------------
# setuptools does not report a package_data entry that matches nothing; it
# ships nothing for it and says so nowhere. Two entries outlived the bundles
# they named when the three notebook builds became one, and the omission would
# only have surfaced in a release environment - here the setuptools-scm plugin
# sweeps every tracked file in and covers for it.
for entry in RAW_PACKAGE_DATA:
    if not glob.glob(os.path.join(ROOT, "py2Dmol", entry)):
        bad.append(f"setup.py's package_data names '{entry}', which matches no"
                   " file. setuptools reports nothing for that - it ships"
                   " nothing and says so nowhere - and here the setuptools-scm"
                   " plugin sweeps every tracked file in and hides it, so the"
                   " omission would first appear in a release wheel")
if not RAW_PACKAGE_DATA:
    bad.append("no package_data entries were read at all - the parse has"
               " stopped matching setup.py and this check proves nothing")

# --- ONE VERSION, and setup.py reads it rather than repeating it ------------
# It used to carry its own literal, which is a second number that has to agree
# with the package's and can only be found not to in a built wheel. setup.py
# greps py2Dmol/__init__.py for it now - so what this guards is that the grep
# still finds something, and that nothing has quietly put a literal back.
_init_src = open("py2Dmol/__init__.py").read()
_setup_src = open("setup.py").read()
_m = re.search(r'^__version__ = "([^"]+)"', _init_src, re.M)
if not _m:
    bad.append("py2Dmol/__init__.py has no __version__ line - setup.py reads it"
               " from there and will fail to build at all")
else:
    print(f"version {_m.group(1)}, from py2Dmol/__init__.py")
    if re.search(r"version\s*=\s*['\"][0-9]", _setup_src):
        bad.append("setup.py has a literal version= again - two numbers that"
                   " must agree are two that can disagree, and the wheel is"
                   " where you find out")

if "--wheel" in sys.argv:
    # ...and say so when the environment is answering a different question. A
    # revision-control plugin makes include_package_data sweep in every tracked
    # file, so the wheel is complete whatever package_data says - which is not
    # what the release machine will do. See the module docstring.
    import importlib.util
    if importlib.util.find_spec("setuptools_scm"):
        print("  note: setuptools-scm is installed here, so include_package_data"
              " pulls in every git-tracked file and this wheel cannot show a"
              " package_data omission. The release env has no plugin.")
    have, name = wheel_contents()
    print(f"built {name}")
    for res in sorted(opened):
        if res not in have:
            bad.append(f"{res} is declared in setup.py but did not reach the wheel")

for b in bad:
    print("FAIL: " + b)
sys.exit(1 if bad else 0)
