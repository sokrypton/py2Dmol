"""Render-time benchmark page: one viewer per chain length.

Emits tests/out/bench.html holding a viewer for each length in LENGTHS, each
carrying a synthetic helix-and-loop C-alpha trace. The page itself only builds
the viewers - timing is driven externally (see tests/bench.js), which reaches
each renderer through window.py2dmol_viewers[<id>].renderer.

Structures are synthetic on purpose: a real 10000-residue PDB would drag file
IO and parsing into a measurement that is meant to be about rendering.
"""
import sys, os
import numpy as np
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(_OUTDIR, exist_ok=True)
import py2Dmol

OUT = os.path.join(_OUTDIR, "bench.html")
LENGTHS = [50, 100, 250, 500, 1000, 2500, 5000, 10000]


def make_chain(n, seed=0):
    """Alternating helical runs and loops, so secondary-structure assignment
    produces a realistic mix rather than one uniform element."""
    rng = np.random.default_rng(seed)
    pts = []
    pos = np.zeros(3)
    i = 0
    while i < n:
        if (len(pts) // 1) % 2 == 0 and rng.random() < 0.65:
            # helical run: ideal alpha params, random orientation
            run = min(int(rng.integers(8, 25)), n - i)
            t = np.arange(run) * np.deg2rad(100.0)
            local = np.stack([2.30 * np.cos(t), 2.30 * np.sin(t),
                              1.50 * np.arange(run)], axis=1)
        else:
            # loop: correlated random walk at C-alpha spacing
            run = min(int(rng.integers(4, 12)), n - i)
            step = rng.normal(size=(run, 3))
            step /= np.linalg.norm(step, axis=1, keepdims=True)
            local = np.cumsum(step * 3.8, axis=0)
        # random rotation so runs do not all point the same way
        q = rng.normal(size=(3, 3))
        qq, _ = np.linalg.qr(q)
        local = local @ qq
        local = local - local[0] + pos
        pts.append(local)
        pos = local[-1] + rng.normal(size=3) * 0.5
        i += run
    coords = np.concatenate(pts, axis=0)[:n]
    return coords - coords.mean(axis=0)


parts = []
for n in LENGTHS:
    v = py2Dmol.view(size=(600, 600), style="cartoon")
    v.add(make_chain(n, seed=n), name=f"chain{n}", align=False)
    parts.append((n, v._display_viewer(static_data=v.objects, include_libs=(n == LENGTHS[0]))))

body = "\n".join(
    f'<div class="bench" data-n="{n}" style="display:inline-block;vertical-align:top;margin:8px">'
    f'<h3>n = {n}</h3>{html}</div>'
    for n, html in parts
)
with open(OUT, "w") as f:
    f.write(
        "<!DOCTYPE html><html><head><meta charset='utf-8'><title>bench</title></head>"
        f"<body>{body}</body></html>"
    )
print("wrote", OUT, "lengths:", LENGTHS)
