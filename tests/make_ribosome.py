"""4UG0 (human 80S ribosome) - the large-structure performance case.

17,789 rendered positions, ~5,900 of them nucleic, so it exercises the cartoon
path where it hurts: base pairing, plates, and a depth complexity high enough
that the occlusion work dominates. Both styles are emitted so cartoon can be
compared against ribbon on identical data.
"""
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)
import py2Dmol  # noqa: E402

OUT = os.path.join(_OUTDIR, "ribosome.html")
PDB = "4UG0"

parts = []
first = True
for style in ("cartoon", "ribbon"):
    v = py2Dmol.view(size=(900, 900), style=style)
    v.from_pdb(PDB, show=False, name=f"{PDB}-{style}")
    parts.append((f"{PDB} - {style}",
                  v._display_viewer(static_data=v.objects, include_libs=first)))
    first = False

body = "\n".join(
    f'<div style="display:inline-block;vertical-align:top;margin:8px">'
    f'<h3 style="font:600 13px sans-serif">{title}</h3>{html}</div>'
    for title, html in parts
)
with open(OUT, "w") as f:
    f.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>ribosome</title>"
            f"</head><body>{body}</body></html>")
print("wrote", OUT, f"({len(parts)} viewers)")
