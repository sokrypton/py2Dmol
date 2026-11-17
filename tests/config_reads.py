"""Every config path viewer.py reads exists on a default viewer.

`view(pae=True).from_afdb(...)` raised KeyError: 'pae' in 2.0.0: the config
key became `heatmap`, `pae=` is folded into it at the top of view(), and one
read was left asking for the old name. A subscript on a dict that no longer
has the key fails only when that line runs - here, only on the AlphaFold DB
path, which needs the network and no test reached.

So this reads every literal `self.config["a"]["b"]...` chain out of the
source and resolves it against real viewers, built with the new spelling and
with the old one. No network, no browser.
"""
import os, re, sys, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# The suite runs without IPython; nothing here displays anything.
if "IPython" not in sys.modules:
    try:
        import IPython.display  # noqa: F401
    except ImportError:
        ip = types.ModuleType("IPython"); disp = types.ModuleType("IPython.display")
        for n in ("HTML", "Javascript"):
            setattr(disp, n, type(n, (), {"__init__": lambda self, s=None: None}))
        disp.display = lambda *a, **k: None
        disp.update_display = lambda *a, **k: None
        ip.display = disp; ip.get_ipython = lambda: None
        sys.modules["IPython"] = ip; sys.modules["IPython.display"] = disp

import py2Dmol  # noqa: E402

src = open(os.path.join(ROOT, "py2Dmol", "viewer.py")).read()
chains = set()
for m in re.finditer(r'self\.config((?:\[\s*["\'][A-Za-z_]+["\']\s*\])+)(\s*=(?!=))?', src):
    path = tuple(re.findall(r'["\']([A-Za-z_]+)["\']', m.group(1)))
    # An assignment creates its last key; only the dicts above it must exist.
    if m.group(2):
        path = path[:-1]
    if path:
        chains.add(path)

bad = []
if len(chains) < 1:
    bad.append("found only %d config reads - the scan is not reading viewer.py" % len(chains))

for label, kw in (("default", {}), ("pae=True", {"pae": True}),
                  ("heatmap=True", {"heatmap": True})):
    cfg = py2Dmol.view(**kw).config
    for path in sorted(chains):
        node = cfg
        for key in path:
            if not isinstance(node, dict) or key not in node:
                bad.append("%s: self.config%s - no %r" % (
                    label, "".join('["%s"]' % k for k in path), key))
                break
            node = node[key]

# The old spelling must still switch the panel on.
if not py2Dmol.view(pae=True).config["heatmap"]["enabled"]:
    bad.append("view(pae=True) did not enable config['heatmap']")

# The call that was reported, as far as it goes without the network.
v = py2Dmol.view(pae=True)
asked = {}
def fake(uid, download_pae=False):
    asked["pae"] = download_pae
    return None, None
v._get_filepath_from_afdb_id = fake
try:
    v.from_afdb("Q5VSL9")
except Exception as e:
    bad.append("view(pae=True).from_afdb raised %s: %s" % (type(e).__name__, e))
else:
    if asked.get("pae") is not True:
        bad.append("from_afdb did not ask for the PAE under pae=True: %r" % asked)

print("%d config reads checked" % len(chains))
if bad:
    for b in bad:
        print("FAIL " + b)
    sys.exit(1)
print("ok")
