"""Richardson style: the hand-drawn convention.

Flat wide helices, thick arrowed strands, thin round loops. Each case is shown
next to the default cartoon so the profile differences are directly comparable.

Chosen for secondary-structure content: an alpha/beta protein with a clean
central sheet (the classic Richardson subject), an all-beta barrel to stress
arrowheads, and an all-alpha bundle to check that flat helices still read.
"""
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)
import py2Dmol  # noqa: E402

OUT = os.path.join(_OUTDIR, "richardson_test.html")

# 1TIM is the control: triosephosphate isomerase is the subject of the
# Richardson TIM-barrel drawing, so it is the one case where the output can be
# checked against the original rather than judged by eye.
CASES = [
    ("3CHY", "CheY - alpha/beta, central parallel sheet"),
    ("1TIM", "triosephosphate isomerase - TIM barrel"),
    ("2POR", "porin - all beta, many strands"),
    ("1BBH", "cytochrome b562 - all alpha"),
]

parts = []
first = True
for pdb, label in CASES:
    for style in ("richardson", "cartoon"):
        v = py2Dmol.view(size=(520, 520), style=style,
                         color="ss" if style == "richardson" else "auto")
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
    f.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>richardson</title>"
            f"</head><body>{body}</body></html>")
print("wrote", OUT, f"({len(parts)} viewers)")
