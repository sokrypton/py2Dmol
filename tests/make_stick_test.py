"""Ligand stick test page: the shapes the box/junction code has to get right.

Every case is a ligand (position type 'L') with EXPLICIT bonds, so what is drawn
is the stick path - one box per bond, mitred where legs share a plane, swept
where a chain of two-bond atoms forms a linear run.

What to look for, case by case:

  * isolated bond      - a plain box; three faces at most, no holes
  * bend               - the two boxes share one face; no daylight at the corner
  * chain (linear run) - MERGED: one swept solid, no wringing along it
  * three-way, planar  - mitred, with the middle triangle filled above and below
  * tetrahedral        - an ideal sp3 centre. No plane holds its legs and no
                         axis they stand around, so the mitre's angular order
                         does not exist and forcing one puts the two corners
                         meant to be a single point 0.36 A apart - most of a
                         stick's width. But four sp3 directions SUM TO ZERO, so
                         the sum of any three is exactly minus the fourth: the
                         leg left out of a triple points back down that triple's
                         axis, through the middle of the bottom triangle. So
                         three legs mitre exactly and a seven-triangle COLLAR
                         carries the fourth. Derived in tests/junction_sp3.py.
  * benzene            - every atom has two bonds, so the whole ring is one run,
                         seam included
  * fused rings 2, 3   - the shared atoms have THREE bonds. Flat, so they mitre,
                         which already joins them exactly (each leg shares two
                         corners with its neighbours)
  * REAL HAEM          - all of the above at once, and the case to judge by.
                         Its substituted ring carbons are NOT flat enough to
                         mitre, and a run continues through them on the ring
                         path - chosen topologically, by smallest common cycle,
                         because at a trigonal centre the three angles come out
                         near 127/124/106 and no pair is geometrically "straight
                         on". Picking by angle instead pairs a ring bond with
                         the propionate arm at C2A, and with the IRON at NA.
  * GDP                - the sp3 case, and the one that bounds all this. Its
                         ribose and phosphates admit no plane their legs lie
                         near, and a mitre there rolls each section onto a plane
                         its bond stands ~35 deg out of - which the bond then
                         has to twist along its length to undo. Mitring them
                         regardless wrings a bond by 44 deg; letting those few
                         junctions overlap instead leaves 10 deg as the worst in
                         the whole ligand.

Open tests/out/stick_test.html and rotate. Bonds must stay CONNECTED at every
joint from every angle, and no face may go missing (that one only ever showed
up under perspective - the ortho slider is left at the default here on purpose).
"""
import os
import sys
import math

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)

import numpy as np  # noqa: E402

# py2Dmol imports IPython.display at module load for notebook output. This
# script only builds HTML, so stub it rather than make IPython a test
# dependency - nothing here ever displays anything.
if "IPython" not in sys.modules:
    import types
    _ip = types.ModuleType("IPython")
    _disp = types.ModuleType("IPython.display")
    for _name in ("display", "HTML", "Javascript", "update_display"):
        setattr(_disp, _name, lambda *a, **k: None)
    _ip.display = _disp
    sys.modules["IPython"] = _ip
    sys.modules["IPython.display"] = _disp

import py2Dmol  # noqa: E402

OUT = os.path.join(_OUTDIR, "stick_test.html")

D = 0.866


def ring(n, r=1.4, z=0.0):
    pts = [[r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z]
           for i in range(n)]
    bonds = [[i, (i + 1) % n] for i in range(n)]
    return pts, bonds


CASES = []

CASES.append(("isolated bond", [[-0.75, 0, 0], [0.75, 0, 0]], [[0, 1]]))

CASES.append(("bend (2 bonds, 1 shared seam)",
              [[-1.4, 0, 0], [0, 0, 0], [0.7, 1.2, 0]], [[0, 1], [1, 2]]))

# a zig-zag out of plane: consecutive bends in different planes, which is what
# made per-bend mitring wring the box
CASES.append(("chain of 4 - a LINEAR RUN, merged",
              [[-2.1, 0.0, 0.0], [-0.7, 0.5, 0.0],
               [0.7, 0.0, 0.6], [2.1, 0.6, 0.2]],
              [[0, 1], [1, 2], [2, 3]]))

CASES.append(("three-way, planar - mitred + triangle fill",
              [[0, 0, 0], [1.4, 0, 0], [-0.7, 1.21, 0], [-0.7, -1.21, 0]],
              [[0, 1], [0, 2], [0, 3]]))

CASES.append(("tetrahedral - three mitred, the fourth on a collar",
              [[0, 0, 0], [D, D, D], [D, -D, -D], [-D, D, -D], [-D, -D, D]],
              [[0, 1], [0, 2], [0, 3], [0, 4]]))

bz, bzb = ring(6)
CASES.append(("benzene - a ring of junctions", bz, bzb))

# FUSED RINGS, built on a hexagonal lattice so every bond is exactly 1.4 A.
# The atoms shared between rings have THREE bonds, so a run cannot simply pass
# through them on geometry - at a trigonal centre all three angles are near 120
# and none is "straight on". Which pair continues the ring is topological, and
# the renderer settles it by smallest common cycle. These are the cases that
# exercise it: 2 rings gives 2 shared atoms, 3 rings gives 4.
def acene(nrings, R=1.40):
    """n six-rings fused in a row (benzene, naphthalene, anthracene...)."""
    pts, bonds, idx = [], set(), {}
    for r in range(nrings):
        cx = r * R * math.sqrt(3)
        v = []
        for k in range(6):
            a = math.radians(30 + 60 * k)
            p = (cx + R * math.cos(a), R * math.sin(a))
            kk = (round(p[0], 4), round(p[1], 4))
            if kk not in idx:
                idx[kk] = len(pts)
                pts.append([p[0], p[1], 0.0])
            v.append(idx[kk])
        for k in range(6):
            i, j = v[k], v[(k + 1) % 6]
            bonds.add((min(i, j), max(i, j)))
    return pts, [list(b) for b in sorted(bonds)]


_p2, _b2 = acene(2)
CASES.append(("fused: 2 rings (naphthalene) - 2 shared atoms", _p2, _b2))
_p3, _b3 = acene(3)
CASES.append(("fused: 3 rings (anthracene) - 4 shared atoms", _p3, _b3))

# THE REAL THING: a haem lifted out of 1HHO (chain F), with the bonds the
# viewer derives for it. Rings fused to a macrocycle, two propionate arms and
# two vinyls - every case above at once, which is why it is the one to judge by.
HEME_XYZ = [
    [   1.786,   -0.739,    1.274],   # CHA
    [   0.054,    3.602,    0.099],   # CHB
    [  -3.328,    1.379,   -2.448],   # CHC
    [  -1.513,   -3.004,   -1.519],   # CHD
    [   1.552,    0.666,    1.234],   # C1A
    [   2.308,    1.653,    1.985],   # C2A
    [   1.792,    2.856,    1.629],   # C3A
    [   0.763,    2.602,    0.701],   # C4A
    [   2.067,    4.233,    2.145],   # CMA
    [   3.680,    1.390,    2.579],   # CAA
    [   4.827,    2.342,    2.303],   # CBA
    [   5.965,    1.895,    3.218],   # CGA
    [   6.397,    2.638,    4.109],   # O1A
    [   6.366,    0.750,    3.052],   # O2A
    [  -1.036,    3.355,   -0.699],   # C1B
    [  -1.953,    4.380,   -1.160],   # C2B
    [  -2.932,    3.760,   -1.894],   # C3B
    [  -2.570,    2.352,   -1.840],   # C4B
    [  -1.641,    5.840,   -1.003],   # CMB
    [  -3.920,    4.295,   -2.923],   # CAB
    [  -4.264,    5.644,   -3.067],   # CBB
    [  -3.107,    0.001,   -2.390],   # C1C
    [  -3.952,   -0.970,   -3.070],   # C2C
    [  -3.452,   -2.208,   -2.815],   # C3C
    [  -2.306,   -1.996,   -1.985],   # C4C
    [  -4.941,   -0.612,   -4.133],   # CMC
    [  -4.002,   -3.551,   -3.207],   # CAC
    [  -5.214,   -4.001,   -2.738],   # CBC
    [  -0.404,   -2.740,   -0.699],   # C1D
    [   0.440,   -3.747,   -0.146],   # C2D
    [   1.357,   -3.134,    0.597],   # C3D
    [   1.101,   -1.721,    0.527],   # C4D
    [   0.065,   -5.185,    0.030],   # CMD
    [   2.333,   -3.861,    1.476],   # CAD
    [   1.786,   -4.205,    2.855],   # CBD
    [   2.873,   -4.968,    3.579],   # CGD
    [   3.362,   -5.938,    3.005],   # O1D
    [   3.230,   -4.567,    4.689],   # O2D
    [   0.578,    1.268,    0.503],   # NA
    [  -1.420,    2.106,   -1.091],   # NB
    [  -2.094,   -0.630,   -1.702],   # NC
    [   0.021,   -1.504,   -0.317],   # ND
    [  -0.642,    0.257,   -0.743],   # FE
]
HEME_BONDS = [
    [0, 4], [0, 31], [1, 7], [1, 14], [2, 17], [2, 21],
    [3, 24], [3, 28], [4, 5], [4, 38], [5, 6], [5, 9],
    [6, 7], [6, 8], [7, 38], [9, 10], [10, 11], [11, 12],
    [11, 13], [14, 15], [14, 39], [15, 16], [15, 18], [16, 17],
    [16, 19], [17, 39], [19, 20], [21, 22], [21, 40], [22, 23],
    [22, 25], [23, 24], [23, 26], [24, 40], [26, 27], [28, 29],
    [28, 41], [29, 30], [29, 32], [30, 31], [30, 33], [31, 41],
    [33, 34], [34, 35], [35, 36], [35, 37], [38, 42], [39, 42],
    [40, 42], [41, 42],
]
CASES.append(("REAL HAEM (1HHO chain F)", HEME_XYZ, HEME_BONDS))

# GDP out of 12KZ - the sp3 case. A guanine (fused aromatic rings, flat), a
# RIBOSE (a five-ring of sp3 carbons) and a diphosphate (two tetrahedral
# phosphorus atoms). The rings mitre like a haem's; the sp3 centres are where a
# junction cannot be solved in any plane its legs lie near, and mitring one
# anyway wrings the bonds leaving it - 44 degrees along a single bond before the
# tilt bound, 10 after. Rotate it and watch the ribose and the phosphates: the
# sticks should read as straight, not as ribbons twisting along their length.
GDP_XYZ = [
    [  -0.985,   -4.405,   -3.571],   # PB
    [  -1.379,   -5.427,   -2.547],   # O1B
    [   0.331,   -4.668,   -4.234],   # O2B
    [  -2.073,   -4.087,   -4.555],   # O3B
    [  -0.769,   -3.055,   -2.736],   # O3A
    [   0.302,   -1.904,   -2.988],   # PA
    [   1.617,   -2.339,   -2.428],   # O1A
    [   0.200,   -1.449,   -4.416],   # O2A
    [  -0.232,   -0.747,   -2.022],   # "O5'"
    [  -1.510,   -0.186,   -2.253],   # "C5'"
    [  -1.562,    1.207,   -1.654],   # "C4'"
    [  -1.482,    1.123,   -0.235],   # "O4'"
    [  -0.392,    2.059,   -2.098],   # "C3'"
    [  -0.878,    3.392,   -2.232],   # "O3'"
    [   0.572,    1.996,   -0.935],   # "C2'"
    [   1.374,    3.170,   -0.802],   # "O2'"
    [  -0.366,    1.857,    0.243],   # "C1'"
    [   0.276,    1.102,    1.329],   # N9
    [   0.910,   -0.078,    1.234],   # C8
    [   1.384,   -0.514,    2.418],   # N7
    [   1.038,    0.439,    3.302],   # C5
    [   1.244,    0.587,    4.752],   # C6
    [   1.844,   -0.240,    5.429],   # O6
    [   0.721,    1.726,    5.313],   # N1
    [   0.063,    2.655,    4.597],   # C2
    [  -0.412,    3.742,    5.234],   # N2
    [  -0.146,    2.551,    3.271],   # N3
    [   0.315,    1.487,    2.589],   # C4
]
GDP_BONDS = [
    [0, 1], [0, 2], [0, 3], [0, 4], [4, 5], [5, 6],
    [5, 7], [5, 8], [8, 9], [9, 10], [10, 11], [10, 12],
    [11, 16], [12, 13], [12, 14], [14, 15], [14, 16], [16, 17],
    [17, 18], [17, 27], [18, 19], [19, 20], [20, 21], [20, 27],
    [21, 22], [21, 23], [23, 24], [24, 25], [24, 26], [26, 27],
]
CASES.append(("GDP (12KZ) - sp3 ribose and phosphates", GDP_XYZ, GDP_BONDS))

# THE TWENTY SIDE CHAINS, from CA outward - the backbone N, C and O are
# dropped, so what is drawn is the side chain alone. (GLY is not here: with
# the backbone gone it is a single atom and has no bond to draw.) Real
# coordinates out of real structures, centred, bonded by distance at 1.95 A
# the way the viewer bonds a ligand. Sixteen junctions between them - the
# branched carbons of VAL/LEU/ILE/THR, the rings of PHE/TYR/HIS/TRP, and
# ARG's guanidinium.
SIDECHAIN = {
    "ALA": ([[0.57, -0.41, -0.31], [-0.57, 0.41, 0.31]],
            [[0, 1]]),
    "SER": ([[-0.55, -0.72, -0.88], [0.53, -0.15, 0.03], [0.01, 0.87, 0.85]],
            [[0, 1], [1, 2]]),
    "CYS": ([[0.33, 0.86, -0.97], [0.32, 0.31, 0.44], [-0.65, -1.17, 0.53]],
            [[0, 1], [1, 2]]),
    "THR": ([[-0.80, -0.79, 0.92], [0.24, 0.13, 0.26], [-0.41, 1.27, -0.31], [0.97, -0.60, -0.86]],
            [[0, 1], [1, 2], [1, 3]]),
    "VAL": ([[-1.11, -0.21, -0.94], [-0.20, 0.16, 0.27], [0.45, -1.08, 0.86], [0.86, 1.13, -0.19]],
            [[0, 1], [1, 2], [1, 3]]),
    "PRO": ([[-0.08, -0.70, -1.19], [-0.16, -0.99, 0.31], [0.38, 0.29, 0.91], [-0.14, 1.41, -0.03]],
            [[0, 1], [1, 2], [2, 3]]),
    "LEU": ([[1.11, -1.23, 1.25], [1.02, -0.12, 0.19], [-0.30, 0.06, -0.58], [-1.47, -0.16, 0.34], [-0.36, 1.45, -1.20]],
            [[0, 1], [1, 2], [2, 3], [2, 4]]),
    "ILE": ([[1.57, -1.11, -0.01], [0.41, -0.15, -0.40], [-0.08, 0.57, 0.86], [-0.75, -0.88, -1.04], [-1.14, 1.56, 0.59]],
            [[0, 1], [1, 2], [1, 3], [2, 4]]),
    "ASN": ([[-1.60, -0.33, 1.11], [-0.59, -0.88, 0.11], [0.45, 0.14, -0.27], [0.78, 1.01, 0.54], [0.96, 0.06, -1.49]],
            [[0, 1], [1, 2], [2, 3], [2, 4]]),
    "ASP": ([[0.02, -1.95, 0.30], [-0.64, -0.75, -0.38], [0.04, 0.56, -0.06], [0.37, 0.77, 1.13], [0.21, 1.37, -0.99]],
            [[0, 1], [1, 2], [2, 3], [2, 4]]),
    "MET": ([[-1.72, 0.76, 1.62], [-0.88, -0.15, 0.74], [0.56, 0.28, 0.57], [1.34, -0.81, -0.65], [0.71, -0.09, -2.27]],
            [[0, 1], [1, 2], [2, 3], [3, 4]]),
    "GLN": ([[2.06, -1.79, 0.50], [1.19, -0.83, -0.31], [0.33, 0.03, 0.60], [-0.85, 0.69, -0.11], [-0.82, 0.88, -1.33], [-1.90, 1.01, 0.65]],
            [[0, 1], [1, 2], [2, 3], [3, 4], [3, 5]]),
    "GLU": ([[-0.58, -1.27, -2.40], [-0.73, -0.63, -1.03], [0.53, -0.04, -0.48], [0.32, 0.50, 0.93], [-0.17, -0.24, 1.82], [0.63, 1.68, 1.17]],
            [[0, 1], [1, 2], [2, 3], [3, 4], [3, 5]]),
    "LYS": ([[-1.34, -2.10, 2.04], [-0.17, -1.40, 1.33], [-0.59, -0.41, 0.26], [0.61, 0.34, -0.33], [0.18, 1.37, -1.39], [1.30, 2.21, -1.92]],
            [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]),
    "ARG": ([[1.42, -1.03, -3.34], [1.19, 0.13, -2.35], [0.49, -0.25, -1.08], [0.19, 0.97, -0.27], [-0.91, 0.75, 0.65], [-0.82, 0.04, 1.76], [0.32, -0.53, 2.10], [-1.88, -0.07, 2.55]],
            [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [5, 7]]),
    "HIS": ([[0.87, 2.00, 1.58], [1.40, 0.77, 0.87], [0.37, 0.06, 0.06], [-0.42, -0.94, 0.57], [-0.00, 0.21, -1.24], [-1.23, -1.39, -0.37], [-0.99, -0.71, -1.48]],
            [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 6], [5, 6]]),
    "PHE": ([[2.01, 0.99, 1.90], [1.93, 0.71, 0.40], [0.60, 0.20, -0.04], [-0.43, 1.08, -0.30], [0.36, -1.17, -0.13], [-1.68, 0.60, -0.64], [-0.89, -1.65, -0.47], [-1.92, -0.76, -0.72]],
            [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 6], [5, 7], [6, 7]]),
    "TYR": ([[-1.51, 2.54, 1.72], [-1.55, 1.00, 1.74], [-0.64, 0.32, 0.73], [-0.91, 0.38, -0.64], [0.50, -0.41, 1.14], [-0.09, -0.26, -1.58], [1.34, -1.05, 0.20], [1.03, -0.97, -1.17], [1.83, -1.55, -2.14]],
            [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 6], [5, 7], [6, 7], [7, 8]]),
    "TRP": ([[3.38, 0.58, -0.82], [2.64, -0.38, 0.13], [1.21, -0.61, -0.24], [0.74, -1.45, -1.22], [0.07, 0.06, 0.30], [-0.62, -1.32, -1.33], [-1.06, -0.41, -0.41], [-0.12, 1.02, 1.30], [-2.35, 0.05, -0.14], [-1.40, 1.47, 1.57], [-2.50, 0.99, 0.85]],
            [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 6], [4, 7], [5, 6], [6, 8], [7, 9], [8, 10], [9, 10]]),
}
for _aa, (_xyz, _bo) in SIDECHAIN.items():
    CASES.append((f"side chain {_aa}", _xyz, _bo))


parts = []
scripts = []
for idx, (title, coords, bonds) in enumerate(CASES):
    c = np.array(coords, dtype=float)
    c = c - c.mean(axis=0)
    v = py2Dmol.view(size=(360, 360), style="cartoon", color="chain")
    v.add(c, name=f"case{idx}", align=False,
          position_types=["L"] * len(c),
          position_names=["LIG"] * len(c))
    v.add_bonds([list(map(int, b)) for b in bonds])
    html = v._display_viewer(static_data=v.objects, include_libs=(idx == 0))
    parts.append((title, html, len(c), len(bonds)))

body = ["<!DOCTYPE html><html><head><meta charset='utf-8'>",
        "<title>ligand stick test</title>",
        "<style>",
        "body{font:13px/1.5 -apple-system,sans-serif;margin:24px;color:#222}",
        "h1{font-size:18px} .grid{display:flex;flex-wrap:wrap;gap:22px}",
        ".case{border:1px solid #ddd;border-radius:8px;padding:10px}",
        ".case h2{font-size:13px;margin:0 0 6px} .case p{margin:4px 0 0;color:#666}",
        "</style></head><body>",
        "<h1>Ligand sticks - joints and faces</h1>",
        "<p>Rotate each one. Bonds must stay <b>connected</b> at every joint from "
        "every angle, and no face may go missing.</p>",
        "<div class='grid'>"]
for title, html, na, nb in parts:
    body.append(f"<div class='case'><h2>{title}</h2>{html}"
                f"<p>{na} atoms, {nb} bonds</p></div>")
body.append("</div></body></html>")

with open(OUT, "w") as fh:
    fh.write("\n".join(body))
print(f"wrote {OUT}")
print(f"{len(CASES)} cases")
