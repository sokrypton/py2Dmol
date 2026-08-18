"""Nucleic-acid cartoon test page: B-DNA duplex, tRNA, and a protein/DNA complex.

Only the C4' atom is kept per nucleotide (see viewer.py), so base plates have to
be derived from the backbone curve rather than from base-plane atoms - these
three cover the cases that matters: an ideal duplex, a folded single strand with
non-helical stretches, and DNA bent around protein.
"""
import sys, os
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)
import py2Dmol

OUT = os.path.join(_OUTDIR, "na_test.html")

CASES = [
    ("1BNA", "B-DNA dodecamer (ideal duplex)"),
    ("1EHZ", "tRNA-Phe (folded single strand)"),
    ("1AOI", "nucleosome (DNA bent around protein)"),
    ("5H0R", "poly(A).poly(U) duplex - homopolymer, pairing stress test"),
    ("9FOG", "protein-DNA complex, modified bases"),
]

parts = []
first = True
for pdb, label in CASES:
    for style in ("cartoon", "tube"):
        v = py2Dmol.view(size=(560, 560), style=style)
        try:
            v.from_pdb(pdb, show=False, name=f"{pdb}-{style}")
        except Exception as exc:            # network or parse failure
            print(f"  skip {pdb} ({style}): {exc}")
            continue
        parts.append((f"{label} - {style}",
                      v._display_viewer(static_data=v.objects, include_libs=first)))
        first = False

body = "\n".join(
    f'<div style="display:inline-block;vertical-align:top;margin:8px">'
    f'<h3 style="font:600 13px sans-serif">{title}</h3>{html}</div>'
    for title, html in parts
)
with open(OUT, "w") as f:
    f.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>nucleic test</title>"
            f"</head><body>{body}</body></html>")
print("wrote", OUT, f"({len(parts)} viewers)")
