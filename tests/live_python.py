"""A LIVE add() IN PYTHON COSTS THE SAME AT FRAME 12,000 AS AT 2,000.

    python3 tests/live_python.py

The browser half of the ProteinEBM report is tests/live_stream.py; this is the
kernel half. Every live add() packs the object's metadata to see what changed,
and that walked EVERY frame for the colours set_color(frame=N) writes - so
add() n cost n: on Colab, seconds per thousand adds by 18,000 frames. The scan
is resumed per object now (viewer.py, _object_metadata), and set_color resets
it, being the one thing that rewrites a frame already counted.

Two halves: the frame colours the live path packs are exactly what a full
rescan finds, through adds, set_color(frame=), a colour cleared, replace() of
a plain and of a coloured last frame, and a second object; and 1,000 add()s at
~12,000 frames cost under twice what 1,000 at ~2,000 do (before: about 3x).
No browser; IPython is stubbed.
"""
import sys, types
ip = types.ModuleType("IPython"); disp = types.ModuleType("IPython.display")
class _H:
    def __init__(s, *a, **k): pass
class _Handle:
    def update(s, *a, **k): pass
for n in ("HTML", "Javascript"): setattr(disp, n, _H)
disp.display = lambda *a, **k: _Handle(); disp.update_display = lambda *a, **k: None
ip.display = disp; ip.get_ipython = lambda: None
sys.modules["IPython"] = ip; sys.modules["IPython.display"] = disp
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np, py2Dmol
v = py2Dmol.view(persistence=False); v.show()
def brute(obj):
    return {str(i): f["color"] for i, f in enumerate(obj["frames"]) if isinstance(f, dict) and f.get("color") is not None}
def check(tag):
    for obj in v.objects:
        got = v._object_metadata(obj).get("frame_colors", {})
        want = brute(obj)
        if got != want:
            print("FAIL frame_colors after %s on %s: packed %s, a rescan finds %s" % (tag, obj.get("name"), got, want)); sys.exit(1)
x = np.random.rand(6, 3) * 10
for i in range(10):
    v.add(x + i); check(f"add {i}")
v.set_color("red", frame=3); check("set frame 3")
for i in range(5): v.add(x); check("add after")
v.set_color(None, frame=3); check("cleared frame 3")
v.set_color("blue", frame=12); check("frame 12")
v.replace(x * 2); check("replace")
v.set_color("green", frame=v.objects[-1]["frames"].__len__() - 1); check("last frame")
v.replace(x * 3); check("replace a coloured last frame")
v.new_obj(); 
for i in range(4): v.add(x); check("second object")
v.set_color("orange", frame=1); check("second obj frame 1")
print("frame_colors match a full rescan through every step")

import time
w = py2Dmol.view(scatter=True, persistence=False); w.new_obj(scatter_config={"xlabel": "Step", "ylabel": "E"}); w.show()
y = np.random.rand(34, 3) * 10
def burst(n):
    t0 = time.perf_counter()
    for i in range(n):
        w.add(y, scatter=[i, 0.0], align=False)
    return (time.perf_counter() - t0) / n
burst(1000); early = burst(1000)
burst(9000); late = burst(1000)
print("ms per add(): %.3f at ~2,000 frames, %.3f at ~12,000" % (early * 1e3, late * 1e3))
if late > 2 * early:
    print("FAIL a live add() at ~12,000 frames costs %.1fx one at ~2,000 - it walks the frames already there" % (late / early))
    sys.exit(1)
print("ok")
