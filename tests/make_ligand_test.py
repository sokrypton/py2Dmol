"""Ligand occlusion test.

Generic segments (ligand bonds, explicit bonds, cyclic closures, contacts) are
painted as opaque strokes but are easy to leave out of the ink pass's occluder
set - and because ink is drawn LAST, on top of every fill, anything missing
from that set has the backbone outline drawn straight through it.

These all put a ligand directly in front of the protein backbone from some
angle, which is what makes the bug visible.
"""
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)
import py2Dmol  # noqa: E402

OUT = os.path.join(_OUTDIR, "ligand_test.html")

CASES = [
    ("4HHB", "haemoglobin - 4 hemes, large flat ligands against helices"),
    ("3PTB", "trypsin + benzamidine - small ligand in a pocket"),
    ("1HVR", "HIV protease + inhibitor - ligand across the backbone"),
]

parts = []
first = True
for pdb, label in CASES:
    v = py2Dmol.view(size=(560, 560), style="cartoon")
    try:
        v.from_pdb(pdb, show=False, name=f"{pdb}-cartoon")
    except Exception as exc:            # network or parse failure
        print(f"  skip {pdb}: {exc}")
        continue
    parts.append((label, v._display_viewer(static_data=v.objects,
                                           include_libs=first)))
    first = False

body = "\n".join(
    f'<div style="display:inline-block;vertical-align:top;margin:8px">'
    f'<h3 style="font:600 13px sans-serif">{title}</h3>{html}</div>'
    for title, html in parts
)
with open(OUT, "w") as f:
    f.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>ligand test</title>"
            f"</head><body>{body}</body></html>")
print("wrote", OUT, f"({len(parts)} viewers)")
