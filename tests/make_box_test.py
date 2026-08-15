"""Slab test ladder: box (2 res) -> straight beam (4 res) -> curved helix piece (6 res)."""
import sys, os
import numpy as np
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)
import py2Dmol

OUT = os.path.join(_OUTDIR, "box_test.html")

cases = []

# 1. Box: one interval
c1 = np.array([[0.0, 0.0, 0.0], [3.8, 0.0, 0.0]])
cases.append(("Box (2 res, one interval)", c1, "HH"))

# 2. Straight beam: three collinear intervals (tests joints, no curvature)
c2 = np.array([[i * 3.8, 0.0, 0.0] for i in range(4)])
cases.append(("Straight beam (4 res, 3 joints)", c2, "HHHH"))

# 2b. Minimal curved piece: 3 residues of ideal helix (2 curved intervals)
t3b = np.arange(3) * np.deg2rad(100.0)
c2b = np.stack([2.30 * np.cos(t3b), 2.30 * np.sin(t3b), 1.50 * np.arange(3)], axis=1)
c2b -= c2b.mean(axis=0)
cases.append(("Helical curve (3 res)", c2b, "HHH"))

# 3. Curved piece: 6 residues of ideal helix (tests curvature + twist)
t = np.arange(6) * np.deg2rad(100.0)
c3 = np.stack([2.30 * np.cos(t), 2.30 * np.sin(t), 1.50 * np.arange(6)], axis=1)
c3 -= c3.mean(axis=0)
cases.append(("Helix piece (6 res)", c3, "HHHHHH"))

parts = []
scripts = []
for idx, (title, coords, force) in enumerate(cases):
    v = py2Dmol.view(size=(420, 420), style="cartoon", color="chain")
    v.add(coords, name=f"case{idx}", align=False)
    vid = v.config["viewer_id"]
    html = v._display_viewer(static_data=v.objects, include_libs=(idx == 0))
    parts.append(f'<div style="display:inline-block;vertical-align:top;margin:6px"><h4>{title}</h4>{html}</div>')
    scripts.append(f"""
(function poll() {{
    const reg = window.py2dmol_viewers && window.py2dmol_viewers['{vid}'];
    if (reg && reg.renderer && reg.renderer.coords && reg.renderer.coords.length === {len(coords)}) {{
        reg.renderer._forceSec = '{force}';
        reg.renderer.render('forceSec');
    }} else {{
        setTimeout(poll, 100);
    }}
}})();""")

with open(OUT, "w") as f:
    f.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>slab ladder</title></head><body>"
            + "".join(parts)
            + "<script>" + "".join(scripts) + "</script>"
            + "</body></html>")
print("wrote", OUT)
