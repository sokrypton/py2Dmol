"""A grid emits ONE output, and its viewers go live only once they are on it.

    python3 tests/grid.py

`Grid.view()` hands back an ordinary viewer and collects it, so `from_pdb`
must not display it on the spot. That was said by setting `_is_live` - and
that flag means two things:

  * don't show yourself, which is what the grid wanted; and
  * you are on the page, so every add() is an incremental update - which was
    false, because the grid has not been emitted yet.

So each `add()` during collection wrote an update into the notebook addressed
to a viewer that did not exist. Four viewers came to twenty-seven of them,
twenty from a single NMR ensemble; each is an empty output element, and the
band of white space under the cell is what they look like.

`_managed` says the first thing alone. `Grid.show()` calls `_mark_published()`
afterwards, which is when live begins - so an add() AFTER the grid still
reaches the viewer beside it, which is the one thing the old flag got right.

No browser: this counts outputs, and that is the whole of the fault.
"""
import json, re, sys, types

CALLS = []


def _stub_ipython():
    ip = types.ModuleType('IPython'); disp = types.ModuleType('IPython.display')

    class HTML:
        def __init__(self, s): self.data = s

    def display(*a, **k):
        for x in a:
            CALLS.append((type(x).__name__, len(getattr(x, 'data', '')),
                          getattr(x, 'data', '')))

    disp.HTML = HTML
    disp.Javascript = HTML
    disp.display = display
    disp.update_display = lambda *a, **k: CALLS.append(('update', 0, ''))
    # ...AND A SHELL, so the cell-identity read has something to read. The
    # library-bearing OUTPUT is replaced when its cell is re-run, and that is
    # the one thing Python can see without asking the browser: same cell, later
    # execution.
    class _Shell:
        def __init__(self):
            self.parent_header = {'metadata': {}}
            self.execution_count = 0

        def at(self, cell):
            self.execution_count += 1
            self.parent_header = {'metadata': {'cellId': cell}}

    ip.SHELL = _Shell()
    ip.get_ipython = lambda: ip.SHELL
    ip.display = disp
    sys.modules['IPython'] = ip
    sys.modules['IPython.display'] = disp


try:
    import IPython.display  # noqa: F401
except ImportError:
    _stub_ipython()
else:
    _stub_ipython()          # ...ours either way: the count is the measurement

sys.path.insert(0, '/Users/mini/Documents/GitHub/py2Dmol')
import numpy as np  # noqa: E402
import py2Dmol  # noqa: E402

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
bad = []


def helix(n=12):
    return np.array([[2.3 * np.cos(i), 2.3 * np.sin(i), 1.5 * i]
                     for i in range(n)], dtype=float)


# --- FOUR VIEWERS, ONE OUTPUT --------------------------------------------
# 1YNE is the fixture that made this visible: an NMR ensemble, so add_pdb
# adds a frame per model and each one used to be its own update.
CALLS.clear()
with py2Dmol.grid(2, 2, size=(300, 300), box=True) as g:
    g.view(color='chain').from_pdb(ROOT + '/6MRR.cif')
    g.view().from_pdb(ROOT + '/1UBQ.cif', color='red')
    g.view(rotate=True).from_pdb(ROOT + '/6MRR.cif',
                                 contacts=[[0, 10, 1.0, 'yellow']])
    g.view(autoplay=True).from_pdb(ROOT + '/1YNE.cif')
outs = list(CALLS)
print(f"  four viewers, one of them an NMR ensemble: {len(outs)} output(s)"
      f" of {[o[1] for o in outs]} bytes")
if len(outs) != 1:
    bad.append(f"a four-viewer grid produced {len(outs)} outputs - one is the"
               " grid and the rest are updates to viewers that are not on the"
               " page yet, each an empty element in the notebook")

# ...and all four are IN it, so nothing was dropped by not showing them.
page = outs[-1][1] if outs else 0
if page < 200_000:
    bad.append(f"the grid output is {page} bytes - too small to be carrying"
               " four viewers and the library, so this count is measuring"
               " the wrong thing")


# --- COLLECTED, NOT LIVE --------------------------------------------------
g2 = py2Dmol.Grid(cols=2, size=(200, 200))
v = g2.view()
if v._is_live:
    bad.append('a collected viewer is marked live before the grid exists -'
               ' that is the flag that emitted twenty-seven outputs')
if not v._managed:
    bad.append('a collected viewer is not marked managed, so from_pdb will'
               ' show it on the spot and the grid will show it again')

CALLS.clear()
v.add(helix())
if CALLS:
    bad.append(f'add() during collection emitted {CALLS} - there is no viewer'
               ' on the page for it to reach')

# --- ...AND LIVE AFTERWARDS ----------------------------------------------
CALLS.clear()
g2.show()
after_show = list(CALLS)
if len(after_show) != 1:
    bad.append(f'Grid.show() emitted {len(after_show)} outputs')
if not v._is_live or v._managed:
    bad.append(f'after Grid.show() the viewer is live={v._is_live}'
               f' managed={v._managed} - it IS on the page now')

CALLS.clear()
v.set_color('red')
if not CALLS:
    bad.append('a colour set after the grid was displayed reached nothing -'
               ' the viewer is on the page and an update is the only way to'
               ' change it')
# ...and it carries NO FRAMES. A size threshold would not see this: the
# fixture is a twelve-position helix, and resending it is still small. What
# _mark_published records is that those frames have already gone, so a colour
# change is a colour change.
def _payload(html):
    m = re.search(r'const p=(\{.*?\});', html, re.S)
    return json.loads(m.group(1)) if m else None

pay = _payload(CALLS[0][2]) if CALLS else None
if pay is None:
    bad.append('the update after Grid.show() carries no payload to read')
elif pay.get('frames'):
    bad.append(f"a colour change after Grid.show() resent"
               f" {[ (k, len(v)) for k, v in pay['frames'].items() ]} - the"
               ' frames went out with the grid, and _mark_published is what'
               ' records that')

# --- RE-RUNNING THE CELL THAT CARRIES THE LIBRARY -------------------------
# 🔴 Re-running a cell REPLACES ITS OUTPUT. If that output was the lender, the
# page no longer has the library - while _LENT_BUNDLE still says this kernel
# lent it, so the new viewer writes a request to borrow from something that is
# gone: a two-second poll and an error box telling the reader to re-run the
# cell that carries the library. It IS that cell, so the advice cannot work and
# nothing short of a kernel restart recovers.
#
# Python cannot see an output being cleared. It can see that it is running in
# the SAME CELL as the lend and in a LATER EXECUTION, which is exactly when the
# lend is about to be overwritten.
_S = sys.modules['IPython'].SHELL


def _size_of_new_viewer():
    v = py2Dmol.view()
    v.add(helix())
    return len(v._display_viewer(static_data=v.objects))


_V2 = sys.modules['py2Dmol.viewer'] if 'py2Dmol.viewer' in sys.modules else _V
_V2._LENT_BUNDLE = None
_V2._LENT_WHERE = None
_S.at('A'); _first = _size_of_new_viewer()
_S.at('A'); _again = _size_of_new_viewer()
_S.at('B'); _other = _size_of_new_viewer()
if _first < 300_000:
    bad.append(f'the first viewer of a kernel wrote {_first} bytes - it has to'
               ' carry the library, there is nothing to borrow from')
if _again < 300_000:
    bad.append(f're-running the lending cell wrote {_again} bytes: it borrowed'
               ' from the output it was replacing, so the page is left with no'
               ' library and the viewer polls for two seconds and gives up')
if _other > 60_000:
    bad.append(f'a DIFFERENT cell wrote {_other} bytes rather than borrowing -'
               ' the re-run rule has swallowed the sharing')

# ...and several viewers in ONE execution still share: a grid is one cell.
_V2._LENT_BUNDLE = None
_V2._LENT_WHERE = None
_S.at('C')
_same_cell = [_size_of_new_viewer() for _ in range(3)]
if _same_cell[0] < 300_000 or max(_same_cell[1:]) > 60_000:
    bad.append(f'three viewers in one execution wrote {_same_cell} - one cell'
               ' is one output, so only the first can carry the library')
_V2._LENT_BUNDLE = None
_V2._LENT_WHERE = None

# --- A GRID DEFAULT FOR THE PAPER, LIKE size/controls/box ----------------
# A gallery is usually one background, and bg was the one display setting the
# grid could not carry - it had to go on every g.view(). A per-view value still
# wins, because that is what "default" means for the other three.
def _bg_of(v):
    return v.config['display']['background']

_g = py2Dmol.Grid(cols=2, bg='black')
_a, _b = _g.view(), _g.view(bg='white')
if _bg_of(_a) != 'black':
    bad.append(f"grid(bg='black') left a viewer on {_bg_of(_a)!r}")
if _bg_of(_b) != 'white':
    bad.append(f"a per-view bg did not override the grid's: {_bg_of(_b)!r}")
if _bg_of(py2Dmol.Grid(cols=2).view()) != 'white':
    bad.append('a grid with no bg changed the viewer default')

# --- THE SHARED LIBRARY IS KEYED BY ITS CONTENT --------------------------
# A notebook is re-run cell by cell, so the cell holding the library can be
# older than the cell now asking for one - and a payload written by today's
# viewer.py handed to yesterday's renderer DRAWS, silently missing whatever the
# two versions disagree about. That is how the PAE went blank when it moved to
# base64: the plot was empty on a page where everything else looked right.
#
# Behavioural, not a text scan: tests/config.js checks the shape of the source
# and would pass against a _share_key that returned the path anyway.
from py2Dmol import viewer as _V  # noqa: E402

_BUNDLE = 'bundles/py2Dmol.notebook.min.js'
_key = _V._share_key(_BUNDLE)
if not _key.startswith(_BUNDLE + '@') or len(_key) <= len(_BUNDLE) + 1:
    bad.append(f'the share key is {_key!r} - it has to name the CONTENT, or a'
               ' cell can borrow a library that does not understand what it'
               ' is writing')
# ...and it follows the content. Same path, different bytes, different key.
_real = _V._resource_text
try:
    _V._BUNDLE_KEYS.clear()
    _V._resource_text = lambda name: 'pretend this is a different build'
    _other = _V._share_key(_BUNDLE)
finally:
    _V._resource_text = _real
    _V._BUNDLE_KEYS.clear()
if _other == _key:
    bad.append('two different bundles hash to the same share key, so a stale'
               ' lender is still borrowed from')

CALLS.clear()
_V._LENT_BUNDLE = None          # ...a fresh kernel: this one has to LEND
_fresh = py2Dmol.view()
_fresh.add(helix())
_first = _fresh._display_viewer(static_data=_fresh.objects)
_second_v = py2Dmol.view()
_second_v.add(helix())
_second = _second_v._display_viewer(static_data=_second_v.objects)
_V._LENT_BUNDLE = None          # ...and leave no mark, as above
if _key not in _first or _key not in _second:
    bad.append('the lender and the borrower do not name the same key, so no'
               ' cell can ever borrow')
if len(_second) > len(_first) / 4:
    bad.append(f'the second viewer wrote {len(_second)} bytes against the'
               f" first's {len(_first)} - it is not borrowing")

# --- THE ESCAPE HATCH STILL WORKS ----------------------------------------
# from_pdb(show=True) is documented as the way to display a collected viewer
# anyway; _managed must not override an explicit ask.
CALLS.clear()
g3 = py2Dmol.Grid(cols=1)
g3.view().from_pdb(ROOT + '/1UBQ.cif', show=True)
if not CALLS:
    bad.append('from_pdb(show=True) on a collected viewer showed nothing -'
               ' _managed is a default, not a veto')

if bad:
    print('FAIL')
    for b in bad:
        print('  - ' + b)
    sys.exit(1)
print('PASS')
