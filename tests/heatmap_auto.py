"""The panel is decided by the DATA, not by a flag the caller must remember.

    python3 tests/heatmap_auto.py

`view(heatmap=True)` asks the caller to declare something their frames
already say: they passed `maps=` or `paes=`, so of course they want to see
the matrix. viewer.py settles it at show() time instead, when every add()
has happened and the config has not been written yet - and it arrives as a
TAB, which is what makes deciding for the caller safe: a tab shares the box
they asked for, where a second box doubles a width they chose, and in Colab
the output frame is measured before any script runs so a viewer that grows
afterwards cannot get the room.

No browser: this is the payload viewer.py writes, which is where the rule
lives. The mutation to try is deleting the `_any_frame_has_map()` branch in
_display_viewer - every `auto` row below then reports panel=false.
"""
import os, re, sys, types

# The same stub tests/minimal_input.py uses: viewer.py imports IPython at
# module scope and the suite's python does not have it.
try:
    import IPython.display  # noqa: F401
except ImportError:
    _ip = types.ModuleType('IPython'); _disp = types.ModuleType('IPython.display')

    class _Payload:                 # ...with a .data, which is the whole point:
        def __init__(self, data='', *a, **k):   # a stub returning None makes
            self.data = data                    # every assertion below read '?'
    for _n in ('display', 'update_display'):
        setattr(_disp, _n, lambda *a, **k: None)
    _disp.HTML = _Payload
    _disp.Javascript = _Payload
    _ip.display = _disp
    sys.modules['IPython'] = _ip; sys.modules['IPython.display'] = _disp

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np                                            # noqa: E402
import py2Dmol                                                # noqa: E402
import py2Dmol.viewer as V                                    # noqa: E402

# What the viewer would have displayed, captured instead of shown.
CAUGHT = []
V.display = lambda *a, **k: CAUGHT.append(a)


def payload(add_map, **kw):
    CAUGHT.clear()
    view = py2Dmol.view(size=(400, 400), **kw)
    coords = np.zeros((12, 3), dtype=np.float32)
    coords[:, 0] = np.arange(12) * 3.8
    view.add(coords, **({"maps": {"contact": np.eye(12, dtype=np.float32)}}
                        if add_map else {}))
    view.show()
    return "".join(getattr(o, "data", "") for arg in CAUGHT for o in arg)


def read(html):
    on = re.search(r'"heatmap":\s*\{[^}]*"enabled":\s*(\w+)', html)
    return (on.group(1) if on else "?",
            "one" if re.search(r'"small":\s*"none"', html) else "two")


# label, has a map, kwargs, expected panel, expected boxes
CASES = [
    ("auto: a map in the data",      True,  {},                   "true",  "one"),
    ("auto: no map anywhere",        False, {},                   "false", "two"),
    ("heatmap=True beats auto",      True,  {"heatmap": True},    "true",  "two"),
    ("heatmap=False beats auto",     True,  {"heatmap": False},   "false", "two"),
    ("pae=True still works",         True,  {"pae": True},        "true",  "two"),
    ("slots=2 beats auto's one box", True,  {"slots": 2},         "true",  "two"),
    ("heatmap='tab', no data yet",   False, {"heatmap": "tab"},   "true",  "one"),
]

bad = []
for label, has_map, kw, want_panel, want_boxes in CASES:
    panel, boxes = read(payload(has_map, **kw))
    print(f"  {label:32} panel={panel:5} {boxes} box(es)")
    if (panel, boxes) != (want_panel, want_boxes):
        bad.append(f"{label}: got panel={panel} {boxes}, expected"
                   f" panel={want_panel} {want_boxes}")

# ...and the old name for the matrix, which a frame may still carry.
CAUGHT.clear()
v = py2Dmol.view(size=(400, 400))
c = np.zeros((8, 3), dtype=np.float32); c[:, 0] = np.arange(8) * 3.8
v.add(c, pae=np.random.rand(8, 8).astype(np.float32) * 30)
v.show()
panel, boxes = read("".join(getattr(o, "data", "") for a in CAUGHT for o in a))
print(f"  {'auto: a legacy pae= matrix':32} panel={panel:5} {boxes} box(es)")
if panel != "true":
    bad.append(f"a frame carrying the old `pae` field did not turn the panel"
               f" on: panel={panel} - _any_frame_has_map reads both spellings")

if bad:
    for b in bad:
        print("FAIL:", b)
    sys.exit(1)
print("heatmap_auto: ok")
