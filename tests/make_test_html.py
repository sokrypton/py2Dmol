"""Generate a static HTML page with two py2Dmol viewers (ribbon vs cartoon)."""
import sys, os
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)
import py2Dmol

OUT = os.path.join(_OUTDIR, "cartoon_test.html")

parts = []

# 1YNE: mixed alpha/beta protein with a ligand
v1 = py2Dmol.view(size=(450, 450), style="tube")
v1.from_pdb("1YNE", show=False, name="1YNE-ribbon")
parts.append(("Tube (default)", v1._display_viewer(static_data=v1.objects, include_libs=True)))

v2 = py2Dmol.view(size=(450, 450), style="cartoon")
v2.from_pdb("1YNE", show=False, name="1YNE-cartoon")
parts.append(("Cartoon", v2._display_viewer(static_data=v2.objects, include_libs=False)))

# 1UBQ: classic alpha/beta protein, rainbow
v4 = py2Dmol.view(size=(450, 450), style="cartoon")
v4.from_pdb("1UBQ", show=False, name="1UBQ-cartoon")
parts.append(("Cartoon 1UBQ rainbow", v4._display_viewer(static_data=v4.objects, include_libs=False)))

v5 = py2Dmol.view(size=(450, 450), style="tube")
v5.from_pdb("1UBQ", show=False, name="1UBQ-ribbon")
parts.append(("Tube 1UBQ rainbow", v5._display_viewer(static_data=v5.objects, include_libs=False)))

# 1BJP: small beta-rich multimer, chain coloring
v3 = py2Dmol.view(size=(450, 450), style="cartoon", color="chain")
v3.from_pdb("1BJP", show=False, name="1BJP-cartoon")
parts.append(("Cartoon, chain colors", v3._display_viewer(static_data=v3.objects, include_libs=False)))

body = "\n".join(
    f'<div style="display:inline-block;vertical-align:top;margin:8px"><h3>{title}</h3>{html}</div>'
    for title, html in parts
)
with open(OUT, "w") as f:
    f.write(f"<!DOCTYPE html><html><head><meta charset='utf-8'><title>cartoon test</title></head><body>{body}</body></html>")
print("wrote", OUT)
