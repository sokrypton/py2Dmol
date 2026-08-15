"""Idealized single alpha-helix (C-alpha trace) in a large cartoon viewer."""
import sys, os
import numpy as np
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)
import py2Dmol

OUT = os.path.join(_OUTDIR, "helix_big.html")

# Ideal alpha-helix C-alpha parameters: radius 2.30 A, rise 1.50 A/res, 100 deg/res
n = 12
t = np.arange(n) * np.deg2rad(100.0)
coords = np.stack([2.30 * np.cos(t), 2.30 * np.sin(t), 1.50 * np.arange(n)], axis=1)
# center it
coords -= coords.mean(axis=0)

parts = []
v = py2Dmol.view(size=(560, 560), style="cartoon")
v.add(coords, name="ideal-helix", align=False)
parts.append(("Ideal helix, cartoon", v._display_viewer(static_data=v.objects, include_libs=True)))

body = "\n".join(
    f'<div style="display:inline-block;vertical-align:top;margin:8px"><h3>{title}</h3>{html}</div>'
    for title, html in parts
)
with open(OUT, "w") as f:
    f.write(f"<!DOCTYPE html><html><head><meta charset='utf-8'><title>helix test</title></head><body>{body}</body></html>")
print("wrote", OUT)
