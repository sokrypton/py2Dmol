"""
py2Dmol/viewer.py
-----------------
AI Context: MAIN PYTHON INTERFACE
- Defines the `view` class, the primary entry point for Python users.
- Manages the internal list of objects and frames.
- Handles serialization of data to JSON for the frontend.
- Generates HTML/JS for embedding in Jupyter/Colab.
- Implements the "Live Mode" communication bridge (Python -> JS).
"""
import base64
import json
import copy
import numpy as np
import re
from typing import Optional, Dict, Any
from IPython.display import display, HTML, Javascript, update_display
    
# ============================================================================
# BROADCAST OPERATION CONSTANTS
# ============================================================================

# Operation names for BroadcastChannel messages (Python -> JavaScript)
OP_INCREMENTAL_UPDATE = "incrementalStateUpdate"
OP_REPLACE_FRAME = "replaceFrame"

# ============================================================================
# CONFIG DEFAULTS - Single source of truth
# ============================================================================

DEFAULT_CONFIG = {
    "display": {
        "size": [400, 400],
        "rotate": False,
        "autoplay": False,
        "controls": True,
        "box": True,
        "background": "white"
    },
    "rendering": {
        "style": "tube",
        "thickness": 0,
        "sheet_flat": 0.0,
        "arrows": True,
        "pencil": 0.0,
        "detail": 4,
        "fade": 0,
        "smooth": True,
        "highlight": 1.8,
        "outline_tint": 0.0,
        "shadow": True,
        "shade": 1.0,
        "shadow_strength": 0.5,
        "outline": "full",
        "width": 3.0,
        "ortho": 0.5,
        "cyclic": True,
        # WHICH PAINTER, BY PICKING THE BUNDLE. A bundle carries exactly one,
        # and the renderer works out which from what is loaded - so this is not
        # a runtime switch, it chooses the file inlined into the cell. True
        # writes the WebGL2 one, False the 2D one, which is 46 KB smaller,
        # needs no WebGL2 and is the only one that can save an SVG.
        "gpu": True,
    },
    "color": {
        "mode": "auto",
        "colorblind": False
    },
    "pae": {
        "enabled": False,
        "size": 300
    },
    "scatter": {
        "enabled": False,
        "size": 300
    },
    "overlay": {
        "enabled": False
    },
    "cutoffs": {
        "protein_bond": 5.0,
        "nucleic_bond": 7.5,
        "ligand_bond": 2.0
    }
}


# config["rendering"] key  ->  viewer_state key, the web app's names for the
# same settings. ONE table, read in both directions: save_state writes
# viewer_state from it and load_state reads viewer_state back through it, and
# two copies would eventually disagree about a key and drop a setting in one
# direction only.
_RENDER_STATE_KEYS = (
    ("style", "style"),
    ("preset", "preset"),
    ("thickness", "thickness"),
    ("detail", "detail"),
    ("smooth", "smooth"),
    ("arrows", "arrows"),
    ("sheet_flat", "sheet_flat"),
    ("pencil", "pencil"),
    ("highlight", "highlight"),
    ("outline_tint", "outline_tint"),
    ("outline", "outline_mode"),
    ("width", "line_width"),
    ("shade", "shade"),
    ("shadow", "shadow_enabled"),
    ("ortho", "ortho_slider_value"),
)


def _nest_config(**flat):
    """Convert flat kwargs to nested config."""
    config = json.loads(json.dumps(DEFAULT_CONFIG))  # Deep copy
    
    # Display
    if "size" in flat: config["display"]["size"] = flat["size"]
    if "rotate" in flat: config["display"]["rotate"] = flat["rotate"]
    if "autoplay" in flat: config["display"]["autoplay"] = flat["autoplay"]
    if "controls" in flat: config["display"]["controls"] = flat["controls"]
    if "box" in flat: config["display"]["box"] = flat["box"]
    if "bg" in flat: config["display"]["background"] = flat["bg"]
    
    # Rendering
    if "style" in flat: config["rendering"]["style"] = flat["style"]
    if "thickness" in flat: config["rendering"]["thickness"] = flat["thickness"]
    if "sheet_flat" in flat: config["rendering"]["sheet_flat"] = flat["sheet_flat"]
    if "arrows" in flat: config["rendering"]["arrows"] = flat["arrows"]
    if "pencil" in flat: config["rendering"]["pencil"] = flat["pencil"]
    if "detail" in flat: config["rendering"]["detail"] = flat["detail"]
    if "fade" in flat: config["rendering"]["fade"] = flat["fade"]
    if flat.get("smooth") is not None: config["rendering"]["smooth"] = flat["smooth"]
    if "highlight" in flat: config["rendering"]["highlight"] = flat["highlight"]
    if "outline_tint" in flat: config["rendering"]["outline_tint"] = flat["outline_tint"]
    if "shadow" in flat: config["rendering"]["shadow"] = flat["shadow"]
    if flat.get("shade") is not None: config["rendering"]["shade"] = flat["shade"]
    if "shadow_strength" in flat: config["rendering"]["shadow_strength"] = flat["shadow_strength"]
    if "outline" in flat: config["rendering"]["outline"] = flat["outline"]
    if "width" in flat: config["rendering"]["width"] = flat["width"]
    if "ortho" in flat: config["rendering"]["ortho"] = flat["ortho"]
    if "gpu" in flat: config["rendering"]["gpu"] = flat["gpu"]
    if "cyclic" in flat: config["rendering"]["cyclic"] = flat["cyclic"]
    # None = leave the key out so the renderer's default (plates on) applies
    if flat.get("base_plates") is not None:
        config["rendering"]["base_plates"] = flat["base_plates"]
    # named cartoon preset (GUI dropdown label; the VALUES travel as the
    # concrete settings above)
    if flat.get("preset") is not None:
        config["rendering"]["preset"] = flat["preset"]

    # Color
    if "color" in flat: config["color"]["mode"] = flat["color"]
    if "colorblind" in flat: config["color"]["colorblind"] = flat["colorblind"]
    # None = leave the key out so the renderer's default palette applies
    if flat.get("ss_palette") is not None:
        config["color"]["ss_palette"] = flat["ss_palette"]
    
    # PAE
    if "pae" in flat: config["pae"]["enabled"] = flat["pae"]
    if "pae_size" in flat: config["pae"]["size"] = flat["pae_size"]

    # Scatter
    if "scatter" in flat:
        if isinstance(flat["scatter"], dict):
            config["scatter"] = {
                "enabled": flat["scatter"].get("enabled", True),
                "size": flat["scatter"].get("size", 300)
            }
        elif flat["scatter"] is True:
            config["scatter"]["enabled"] = True
        elif flat["scatter"] is False:
            config["scatter"]["enabled"] = False
    if "scatter_size" in flat: config["scatter"]["size"] = flat["scatter_size"]

    # Overlay
    if "overlay" in flat: config["overlay"]["enabled"] = flat["overlay"]

    # ...AND SEVERAL OBJECTS, which is a different question. Carried as a plain
    # top-level flag and resolved to a list of names in _display_viewer, where
    # the objects it would name actually exist.
    if flat.get("multi"): config["multi"] = True

    # Cutoffs
    if "cutoffs" in flat and isinstance(flat["cutoffs"], dict):
        for key in ("protein_bond", "nucleic_bond", "ligand_bond"):
            if key in flat["cutoffs"]:
                config["cutoffs"][key] = float(flat["cutoffs"][key])

    return config
    
import importlib.resources
from . import resources as py2dmol_resources

def _resource_text(relpath):
    """One shipped resource, by its path under py2Dmol/resources/.

    The flat, deprecated reader could only see the top of the package, and the
    resources live in core/, parts/, cartoon/ and panels/ now - so every read
    goes through files() and a relative path. tools/bundle.py and
    tests/packaging.py both scan for these calls to check that what the notebook
    inlines is what setup.py ships.
    """
    return importlib.resources.files(py2dmol_resources).joinpath(relpath).read_text()

import gemmi
import uuid
import os
import urllib.request


# NO best_view HERE ANY MORE. It ran an SVD with numpy on every first frame and
# shipped the resulting rotation in the payload, because the JavaScript side had
# no SVD of its own without numeric.js - a CDN script pulled into every page for
# that one routine. src/io/math.js grew svd3, numeric.js went, and the reason went
# with it.
#
# Orienting is now parts/orient.js, run once when the first frame lands, which
# is the same code the website's Orient button uses. One implementation instead
# of two that could drift - and they had already diverged: this one searched a
# fixed set of candidate orientations, and the JavaScript one relaxes toward the
# best.

# NO KABSCH HERE EITHER. It superposed each frame on the one before it before
# the payload was built, and src/io/math.js has had a Kabsch of its own since
# numeric.js was dropped - so this was a second implementation, in numpy, of an
# answer the browser could reach itself.
#
# src/core/mol.js's addFrame does it now, which is also the single funnel every
# frame arrives through: a static payload, a frame streamed into a live cell,
# and an embed calling addFrame directly. What travels from here is the REQUEST
# - align and allow_reflection - rather than the result.
#
# The last thing numpy did for the viewing geometry went with best_view a
# commit earlier. numpy is still needed for the coordinates themselves.

# --- Color System Constants ---

VALID_COLOR_MODES = {"chain", "plddt", "rainbow", "auto", "entropy", "deepmind", "ss"}
"""Valid color modes for protein visualization.

"ss" colours by secondary structure (strands green, helices blue, loops pale
blue) - the convention of the Richardson drawings. It is implemented in
cartoon/geom.js, which owns the SS assignment, and registered there as a
custom colour mode, so it is available to every style."""

# --- Color Utilities ---

def _normalize_color(color):
    """
    Normalize a color input to standard format.

    Args:
        color: Can be:
            - None: No color specified
            - String (mode): "chain", "plddt", "rainbow", "auto", "entropy", "deepmind"
            - String (literal): "red", "#ff0000", etc.
            - Dict (advanced): {
                "chain": {"A": "red", "B": "#ff0000"},  # Chain-level (simplest)
                "position": {0: "blue", 5: "red"},     # Position-level
                "frame": "plddt",                      # Frame-level
                "object": "chain"                      # Object-level
              }

    Returns:
        Normalized color dict or None:
        - If string: {type: "mode"/"literal", value: string}
        - If dict: {type: "advanced", value: dict}
        - If None: None
    """
    if color is None:
        return None

    if isinstance(color, dict):
        # Check if already normalized (has "type" and "value" keys)
        if "type" in color and "value" in color:
            return color

        # Check if it's an advanced format dict (has chain/position/frame/object keys)
        advanced_keys = {"chain", "position", "frame", "object"}
        if any(key in color for key in advanced_keys):
            return {"type": "advanced", "value": color}

        # Otherwise, treat as advanced format anyway
        return {"type": "advanced", "value": color}

    # Handle string format
    color_str = str(color).lower()
    if color_str in VALID_COLOR_MODES:
        return {"type": "mode", "value": color_str}
    else:
        return {"type": "literal", "value": color}

# --- view Class ---

"""
PERSISTENCE & LIVE UPDATE SYSTEM
=================================

The `persistence` parameter controls whether output cells are preserved after notebook reload.

**Quick Summary:**
- persistence=True: add() creates new cells, replace() updates last cell  
- persistence=False: Both update single "mailbox" cell (ephemeral)
- add/replace controls JavaScript frame behavior (append vs replace), independent of persistence

**Implementation:**
- Uses DisplayHandle.update() throughout for safety
- MUST use display_id when calling display() for update() to work

For complete documentation, see: docs/technical_readme.md → "Persistence Modes"
"""

# CRYSTALLISATION ADDITIVES - what a structure carries because of how it was
# GROWN rather than because of what it does: buffers, cryoprotectants,
# precipitants and the counter-ions that come with them.
#
# THE SAME LIST AS CRYSTAL_ADDITIVES IN src/io/parse.js, and it has to stay that
# way - a structure opened in the notebook and the same one dropped on the web
# page must not disagree about what is in it. tests/interaction.js compares the
# two and fails if they drift.
#
# Read the note beside the JS copy for what is deliberately NOT here: PO4, BCT,
# SPM, C8E and every transition metal stay visible, because hiding a real
# cofactor is a worse failure than showing a sulfate.
# ...AND A METAL IS FILTERED BY HOW MANY OF IT THERE ARE, not by what it is.
# One magnesium is an active site; 4UG0's 239 are the mortar a ribosome is
# built with. Counted per residue and only for single-atom ones, so a
# photosystem's 60 chlorophylls are untouched. Same number as CROWD_ION_COUNT
# in src/io/parse.js.
CROWD_ION_COUNT = 20

CRYSTAL_ADDITIVES = {
    # precipitants and cryoprotectants
    'SO4', 'GOL', 'EDO', 'PEG', 'PG4', 'PGE', 'P6G', '1PE', '2PE', 'PE4',
    'MPD', 'MRD', 'BU3', 'IPA', 'DIO', 'DOD', 'TRT', 'P33', 'XPE',
    # buffers
    'TRS', 'MES', 'EPE', 'BTB', 'CIT', 'FLC', 'TLA', 'MLA', 'MLI', 'SIN',
    'CAC', 'BIS', 'PIN', 'HEZ', 'IMD', 'TAR', 'MOH',
    # small anions and organics from the drop
    'ACT', 'ACY', 'FMT', 'OXL', 'NO3', 'AZI', 'CN', 'SCN', 'THJ',
    'DMS', 'DMF', 'ACN', 'EOH', 'MEO', 'URE', 'GAI',
    # reducing agents and thiols
    'BME', 'DTT', 'DTU', 'TCE', 'MTN',
    # counter-ions: the alkali metals and halides that come with the buffer.
    # The transition metals are NOT here.
    'NA', 'K', 'CS', 'RB', 'LI', 'CL', 'BR', 'IOD', 'F',
}






# LENDING, AS TWO SCRIPTS AND A QUESTION.
#
# Both carry the BUNDLE NAME as a key. gpu=False and a tube-only viewer are
# different libraries, and a borrower handed the wrong one would come up
# missing a painter with nothing to say about why - so a lender answers only
# for the key it holds.
def _lend_js(key):
    """Answer askers, and announce on arrival for anyone who asked too early."""
    k = json.dumps(key)
    return (
        "(function(){var K=" + k + ";window.__py2dmolLibKey=K;"
        "var c=new BroadcastChannel('py2dmol_lib');"
        "c.onmessage=function(e){var d=e.data||{};if(d.key!==K)return;"
        "if(d.op==='need')c.postMessage({op:'lib',key:K,src:window.__py2dmolLib});"
        "else if(d.op==='ping')c.postMessage({op:'have',key:K});};"
        "c.postMessage({op:'have',key:K});}());"
    )


def _borrow_js(key):
    """Ask, take a copy - and then answer for it too.

    A single lender is a single point of failure: clear that one cell's output
    and every other viewer goes dark. A borrower that keeps what it was given
    turns one lender into as many as there are live viewers. It cannot help
    when NO frame has the library; nothing can, which is why this is opt-in.
    """
    k = json.dumps(key)
    return (
        "<script>(function(){var K=" + k + ";"
        "if(typeof initializePy2DmolViewer==='function')return;"
        "var c=new BroadcastChannel('py2dmol_lib');"
        "var take=function(s){if(typeof initializePy2DmolViewer==='function')return;"
        "window.__py2dmolLib=s;window.__py2dmolLibKey=K;(0,eval)(s);};"
        "c.onmessage=function(e){var d=e.data||{};if(d.key!==K)return;"
        "if(d.op==='lib')take(d.src);"
        "else if(d.op==='have'&&!window.__py2dmolLib)c.postMessage({op:'need',key:K});"
        "else if((d.op==='need'||d.op==='ping')&&window.__py2dmolLib)"
        "c.postMessage({op:d.op==='ping'?'have':'lib',key:K,src:window.__py2dmolLib});};"
        "c.postMessage({op:'need',key:K});}());</script>\n"
    )


def _can_ask_the_page():
    """Is there a synchronous way to ask the browser what it has?

    This is the whole of what decides whether the library is shared. Where
    the answer is yes, a stale assumption is caught at the next show() and
    costs nothing; where it is no, the only thing available is what this kernel
    remembers writing, and being wrong about that costs a viewer.
    """
    try:
        from google.colab import output as _colab_output   # noqa: PLC0415
        return callable(getattr(_colab_output, 'eval_js', None))
    except Exception:
        return False


def _lender_on_page(key):
    """Is a live frame able to lend this bundle? None when we cannot ask.

    PYTHON CANNOT KNOW THIS BY ITSELF. _LENT_BUNDLE below records what this
    KERNEL has written, which is a guess at what the PAGE still has: clear the
    lending cell's output and the guess is wrong in the direction that breaks
    every later viewer.

    Colab can ask - eval_js runs in the output frame and returns a value to the
    kernel - so where it exists the guess becomes a question. Jupyter has no
    synchronous equivalent (its JS-to-Python channels are comms, and async), so
    there the flag is still the best available and this returns None.

    Any failure returns None rather than raising: a viewer that cannot ask must
    still display.
    """
    try:
        from google.colab import output as _colab_output   # noqa: PLC0415
    except Exception:
        return None
    js = (
        "(async () => { const K = " + json.dumps(key) + ";"
        " const c = new BroadcastChannel('py2dmol_lib');"
        " const seen = await new Promise((res) => {"
        "   const t = setTimeout(() => res(false), 300);"
        "   c.onmessage = (e) => { const d = e.data || {};"
        "     if (d.key === K && (d.op === 'have' || d.op === 'lib'))"
        "       { clearTimeout(t); res(true); } };"
        "   c.postMessage({op: 'ping', key: K}); });"
        " c.close(); return seen; })()"
    )
    try:
        return bool(_colab_output.eval_js(js, timeout_sec=5))
    except Exception:
        return None


# WHICH LIBRARY THIS KERNEL HAS ALREADY WRITTEN INTO A CELL.
#
# Colab gives every cell output its own iframe, so a script in one is invisible
# to the next and each show() writes the whole ~430 KB again - ten viewers is
# 4.3 MB of .ipynb. The frames are same-origin WITH EACH OTHER, which is what
# BroadcastChannel needs and why the live path works, and cross-origin with the
# notebook page: reading a sibling's DOM through `parent` raises SecurityError
# in Colab, measured. So the library travels over the channel instead, which
# carries all 440,215 bytes in 1 ms there.
#
# Keyed by BUNDLE name, because gpu=False and a tube-only viewer are different
# libraries and a borrower must not be handed the wrong one.
_LENT_BUNDLE = None
_BUNDLE_KEYS = {}


def _share_key(bundle):
    """The name the lender and the borrower agree on - PATH PLUS CONTENT.

    🔴 IT USED TO BE THE PATH ALONE, and a borrower took whatever the page had
    under that name. In a notebook that is re-run cell by cell - which is how a
    notebook is used - the lending cell can be holding an OLDER library than
    the cell now asking for one, and a payload written by today's viewer.py is
    then handed to yesterday's renderer. Nothing errors: the viewer draws, and
    whatever the two versions disagree about is silently missing. The PAE went
    base64 and an older renderer had no decoder for it, so the plot came up
    empty on a page where everything else looked right.

    Hashing the bundle costs one read, cached here for the process. A borrower
    whose key is not on the page simply inlines its own copy, which is the
    behaviour that was always there for "nobody is lending".
    """
    key = _BUNDLE_KEYS.get(bundle)
    if key is None:
        import hashlib
        digest = hashlib.sha1(_resource_text(bundle).encode('utf-8')).hexdigest()
        key = bundle + '@' + digest[:12]
        _BUNDLE_KEYS[bundle] = key
    return key


# THE PER-FRAME FIELDS, ONCE. Four places used to enumerate these - this
# module builds the payload and the light frame, parts/ui.js rebuilds it on
# arrival, and core/mol.js hands it to setCoords - and every one of them was a
# hand-written run of `if`s. They disagreed, silently and repeatedly: `align`,
# `allow_reflection`, `position_atoms` and `position_elements` were each lost
# by one side or the other, and each loss was a feature that simply did not
# happen rather than an error anyone could see.
#
# INHERITED: sent on frame 0, and after that only when the value changes. A
# trajectory writes chains once and 999 frames say nothing about them.
FRAME_INHERITED = (
    "plddts", "position_names", "residue_numbers", "position_atoms",
    "position_elements", "position_types", "chains", "bonds", "scatter",
)
# ...except this one, which is sent even when it is None, because "this frame
# has no confidence values" and "this frame says nothing, so keep the last
# ones" are different instructions.
FRAME_SEND_NONE = frozenset({"plddts"})
# ALWAYS: a property of the frame itself, sent whenever it is set. `align` is
# the REQUEST to superpose, which the browser acts on - see addFrame.
FRAME_ALWAYS = ("pae", "pae_n", "color", "align", "allow_reflection")


def _downsample_square(a, k):
    """An n x n uint8 matrix as k x k, by area average. k < n.

    Block boundaries are `arange(k+1) * n // k`, so the blocks differ in size
    by at most one and none is empty - which is what lets reduceat do it in
    two passes instead of a Python loop over a million cells.
    """
    n = a.shape[0]
    bounds = (np.arange(k + 1) * n) // k
    counts = np.diff(bounds).astype(np.float64)
    rows = np.add.reduceat(a.astype(np.uint32), bounds[:-1], axis=0) / counts[:, None]
    cells = np.add.reduceat(rows, bounds[:-1], axis=1) / counts[None, :]
    return np.clip(np.round(cells), 0, 255).astype(np.uint8)


def _strip_advanced_color(holder, advanced_color):
    """Remove the chains and positions named in `advanced_color` from `holder`.

    The caller has already parsed `chain=` / `position=` into the same shape a
    SET would have written, with None where the colour would be - so clearing
    reuses every bit of that parsing rather than growing a second copy of it
    that could disagree about what a 2-tuple means.

    An advanced colour that loses its last entry becomes no colour at all,
    rather than an empty map: `{"type": "advanced", "value": {}}` is a colour
    as far as everything downstream is concerned, and would keep the object out
    of whatever the default colouring is.
    """
    existing = holder.get("color")
    if not existing or existing.get("type") != "advanced":
        # Nothing selective to strip: a literal or a mode is all-or-nothing
        holder["color"] = None
        return
    value = existing.get("value", {})
    for key in ("chain", "position"):
        if key not in advanced_color:
            continue
        target = value.get(key)
        if not isinstance(target, dict):
            continue
        for k in advanced_color[key]:
            # ...both spellings of the key: JSON has already made ints strings
            # in anything that has been through save_state or a round trip.
            target.pop(k, None)
            target.pop(str(k), None)
            if isinstance(k, str) and k.isdigit():
                target.pop(int(k), None)
        if not target:
            value.pop(key, None)
    holder["color"] = {"type": "advanced", "value": value} if value else None


class view:
    def __init__(self, size=(400,400), controls=True, box=True,
        color="auto", colorblind=False, ss_palette=None, style="tube", preset=None, smooth=None, thickness=None, sheet_flat=None, pencil=None, arrows=True, base_plates=None, detail=4, fade=0, highlight=None, outline_tint=None,
        shadow=True, shade=None, shadow_strength=0.5,
        outline=None, width=None, ortho=0.5, gpu=True, bg=None, rotate=False, autoplay=False,
        pae=False, pae_size=300, scatter=None, scatter_size=300, overlay=False, multi=False, cyclic=True,
        persistence=True, id=None, cutoffs=None,
    ):
        """
        Initialize a py2Dmol viewer.

        Args:
            size (tuple): Canvas dimensions (width, height) in pixels. Default (400, 400).
            controls (bool): Show playback controls. Default True.
            box (bool): Show bounding box. Default True.
            color (str): Color mode - "auto", "chain", "rainbow", "plddt", "deepmind", "entropy", "ss" (secondary structure). Default "auto".
            colorblind (bool): Use colorblind-friendly palette. Default False.
            ss_palette (str): Named palette for the "ss" colour mode -
                "pymol" (red/yellow/green, the default) or "jmol"
                (magenta/yellow/white). The SSE dropdown in the Style panel
                while colouring by SSE.
            base_plates (bool): Draw DNA/RNA base plates (the rungs of a
                duplex). None (default) leaves the renderer's default (on).
                The Bases toggle in the Style panel.
            thickness (float): Cartoon slab thickness in Angstroms (default
                0, flat single-sheet ribbons). Raise it for solid slabs.
            detail (int): Cartoon subdivisions per residue, 2-8 (default 4).
                Higher is smoother and proportionally slower. 2 is the
                geometric floor - below it a helix cannot represent its own
                coil and the depth sort has nothing to cut on.
            fade (float): Depth fade, 0-1 (default 0 = off) - geometry
                further back pales toward the page. The Fade slider.
                Lower is deliberately faceted and proportionally faster. Values
                above 0.5 are clamped: past the tuned value the extra stations
                cost time without changing the drawn curves.
            smooth (bool): Smooth shading gradients; False draws one flat
                tone per cartoon face (cel shading) - the Smooth toggle.
                Defaults to False for style="cartoon", True otherwise.
            highlight (float): Brightness lift on faces pointing at the light,
                >= 0 (default 1.8). 0 restores the old behaviour where the base
                colour was the ceiling and lighting could only darken.
            outline_tint (float): Cartoon outline colour, 0-1 (default 0.0).
                0 inks pure black; 1 uses a 0.7 tint of the element's own
                colour, matching ribbon mode.
            preset (str): Named cartoon preset, the Preset dropdown in the
                Style panel - "richardson" (the default for style="cartoon":
                the hand-drawn convention of flat wide helices, thick arrowed
                strands, thin round loops), "ribbon" (plain cartoon) or "3d"
                (solid shaded geometry: thickness 1.0, no outline, smooth
                shading, flat sheets, on a black page). Implies
                style="cartoon". An explicit argument always wins over it.

                You can pass these to style= instead - style="ribbon" is the
                same as preset="ribbon" - and that is usually the clearer way
                to say it.
            style (str): Render style - "tube" (smooth backbone trace) or
                "cartoon" (secondary-structure cartoon: helix/strand ribbons,
                loop tubes). Default "tube". These are the only two, because
                they are the only two draw paths; richardson is a preset.
            shadow (bool): Ribbon cast-shadow effect. Default True.
            shade (float): Cartoon directional shading strength, 0-1
                (default 1). 0 is flat colour; 1 is full light, highlight and
                inner shadow, paired with `highlight` in the panel).
            shadow_strength (float): Shadow intensity 0-1. Default 0.5.
            outline (str): Outline mode - "none", "partial", "full". Default "full".
            bg (str): Page background - "white", or "black" (the default
                for preset="3d"). Black
                inks outlines in white and fades depth toward black. The Dark
                toggle.
            width (float): Line width. Default 3.0.
            ortho (float): Orthographic projection strength 0-1. Default 0.5.
            rotate (bool): Auto-rotate the structure. Default False.
            autoplay (bool): Auto-play animation on load. Default False.
            pae (bool): Enable PAE (Predicted Aligned Error) visualization. Default False.
            pae_size (int): PAE plot size in pixels. Default 300.
            scatter (bool/dict): Enable scatter plot. Default None.
            scatter_size (int): Scatter plot size in pixels. Default 300.
            overlay (bool): Enable overlay mode (show all frames simultaneously). Default False.
            multi (bool): Draw every object at once rather than one at a time.
                Default False. `overlay` is about FRAMES of one object; this is
                about OBJECTS - two structures added under different names,
                both on screen, the camera widened to take them both in. The
                same thing the website's Multi button does. See show_objects()
                for naming a subset.
            cyclic (bool): Close a chain end to end when its termini are within
                bonding range - a cyclic peptide drawn as the ring it is rather
                than as a line with two loose ends. Default True. The Cyclic
                toggle in the Style panel is the same setting.
                RENAMED in 2.0.0 from `detect_cyclic`, to match the toggle and
                the rest of view(), where every argument names a state rather
                than an action.
            persistence (bool): If True (default), each incremental update uses a fresh output
                                cell (classic behavior). If False, updates reuse a single hidden
                                cell (mailbox) to avoid output bloat.
            id (str): Custom viewer ID. If None, auto-generated. Default None.
            cutoffs (dict): Maximum distances (Å) for drawing bonds. Keys:
                            "protein_bond" (CA-CA, default 5.0),
                            "nucleic_bond" (C4'-C4', default 7.5),
                            "ligand_bond" (heavy-atom, default 2.0).
        """
        # Normalize pae_size: if tuple/list, use first value; otherwise use as-is
        if isinstance(pae_size, (tuple, list)) and len(pae_size) > 0:
            pae_size = int(pae_size[0])
        else:
            pae_size = int(pae_size)

        # Normalize scatter_size: if tuple/list, use first value; otherwise use as-is
        if isinstance(scatter_size, (tuple, list)) and len(scatter_size) > 0:
            scatter_size = int(scatter_size[0])
        else:
            scatter_size = int(scatter_size)


        # ONE FLAT LIST OF STYLES, and inside it is still a pair.
        #
        # There are two DRAW PATHS - "tube" (the backbone trace) and the cartoon
        # - and the cartoon has three PRESETS, which are per-SS profiles and
        # settings. That split is real inside the renderer and it stays there.
        #
        # It was never worth making a caller hold. "cartoon" on its own is not a
        # look: choosing it means richardson with extra steps, and two arguments
        # that have to agree are two arguments that can disagree. So style= takes
        # any of the four names, and "cartoon" remains as a synonym for the
        # default one.
        STYLE_ALIASES = {
            "tube": ("tube", None),
            "cartoon": ("cartoon", "richardson"),
            "richardson": ("cartoon", "richardson"),
            "ribbon": ("cartoon", "ribbon"),
            "3d": ("cartoon", "3d"),
        }
        if style not in STYLE_ALIASES:
            raise ValueError(
                f'Invalid style "{style}" - expected one of '
                + ", ".join(f'"{k}"' for k in STYLE_ALIASES) + ".")
        # preset= still works and still wins, which is what it has always done:
        # naming one implies the cartoon path.
        if preset is not None and preset not in ("richardson", "ribbon", "3d"):
            raise ValueError(
                f'Invalid preset "{preset}" - expected "richardson", "ribbon" or "3d".')
        if preset is not None:
            style = "cartoon"
        else:
            style, preset = STYLE_ALIASES[style]
        is3d = preset == "3d"
        # Richardson scales its per-SS thickness ratios by this value, so the
        # usual default of 0 (flat ribbons) would cancel the preset. An
        # explicit thickness - 0 included - is still honoured.
        if thickness is None:
            thickness = 0.7 if preset == "richardson" else (1.0 if is3d else 0)
        # Beta-strand flattening. Real strands pleat; the Richardson drawings
        # show them flat, so the preset defaults to mostly flat and every other
        # style leaves the backbone alone.
        # Richardson outlines are a dark tint of the element's own colour.
        if outline_tint is None:
            outline_tint = 0.8 if preset == "richardson" else 0.0
        # outline MODE ("full"/"partial"/"none"); the 3d preset draws no ink
        if outline is None:
            outline = "none" if is3d else "full"
        # The 3d preset is solid shaded geometry, meant to be seen on black -
        # the GUI preset sets the same thing. An explicit bg still wins, which
        # is why the parameter defaults to None rather than to "white".
        if bg is None:
            bg = "black" if is3d else "white"
        # Loop cross-section shading: 0 square, 1 tubular.
        # Detail is an integer 2-8 (2 = the geometric floor, see MIN_SUB in
        # cartoon/geom.js; 8 restores the old smooth sampling).
        detail = min(8, max(2, int(round(float(detail)))))
        fade = float(fade)
        if not 0.0 <= fade <= 1.0:
            raise ValueError("fade must be between 0.0 (off) and 1.0 (far side fully faded).")
        # Poster (flat tone banding) suits the plain cartoon; Richardson shades
        # smoothly and gets its texture from the pencil grain instead.
        # smooth = gradient shading (the Smooth toggle)
        if smooth is None:
            # richardson and 3d shade smoothly; the plain "ribbon" preset is the
            # flat-banded one. Tube ignores this. Written against the STYLE when
            # richardson WAS a style - now that every preset shares
            # style="cartoon", that test put richardson in the flat branch.
            smooth = (style != "cartoon") or preset in ("richardson", "3d")
        # WIDTH IS NOT PYTHON'S TO DECIDE. This substituted 2.0 for richardson
        # against LOOK_DEFAULTS' PRESET_WIDTH of 3.0, which geom.js states is
        # "the same in all three" - a fourth copy of the preset numbers, and a
        # stale one. A config value WINS over the look in the constructor, so
        # the stale 2.0 beat the table every time, and a viewer BUILT as
        # richardson drew a thinner ribbon than one SWITCHED to it. Left unset,
        # so the browser reads its own table - which is the same reason the
        # duplicate in core/mol.js was removed once already.
        if highlight is None:
            highlight = 3.0 if preset == "richardson" else (2.0 if is3d else 1.8)
        if shade is None:
            # mirrors LOOK_DEFAULTS: richardson models more lightly than a
            # rendered solid. Sending a flat 1.0 here made view(preset=...)
            # disagree with the identical preset chosen in the GUI.
            shade = 0.7 if preset == "richardson" else 1.0
        else:
            shade = float(shade)
            if not 0.0 <= shade <= 1.0:
                raise ValueError(
                    "shade must be between 0.0 (flat colour) and 1.0 (full shading)."
                )
        # Coloured-pencil paper grain. Reproduced in SVG export as an
        # feTurbulence filter, so raster and vector output match.
        if pencil is None:
            pencil = 1.0 if preset == "richardson" else 0.0
        pencil = max(0.0, min(1.0, float(pencil)))
        if sheet_flat is None:
            sheet_flat = 1.0 if (preset == "richardson" or is3d) else 0.0
        sheet_flat = max(0.0, min(1.0, float(sheet_flat)))
        thickness = float(thickness)
        if thickness < 0:
            raise ValueError("thickness must be >= 0 (0 draws flat single-sheet ribbons).")
        smooth = bool(smooth)
        highlight = float(highlight)
        if highlight < 0:
            raise ValueError("highlight must be >= 0 (0 = no brightening above the base color).")
        outline_tint = float(outline_tint)
        if not 0.0 <= outline_tint <= 1.0:
            raise ValueError("outline_tint must be between 0.0 (black) and 1.0 (element color).")
        if ss_palette is not None and ss_palette not in ("pymol", "jmol"):
            raise ValueError(
                f'Invalid ss_palette "{ss_palette}" - expected "pymol" or "jmol".')
        if base_plates is not None:
            base_plates = bool(base_plates)
        if bg not in ("white", "black"):
            raise ValueError(f'Invalid bg "{bg}" - expected "white" or "black".')

        # Create nested config (accepts flat kwargs for backward compat)
        self.config = _nest_config(
            size=size,
            controls=controls,
            box=box,
            color=color,
            colorblind=colorblind,
            style=style,
            thickness=thickness,
            sheet_flat=sheet_flat,
            arrows=bool(arrows),
            pencil=pencil,
            detail=detail,
            fade=fade,
            smooth=smooth,
            highlight=highlight,
            outline_tint=outline_tint,
            ss_palette=ss_palette,
            base_plates=base_plates,
            # the RESOLVED preset, not just 3d: the viewer derives the
            # richardson geometry profile (cartoonRichardson) from this, so
            # sending None for richardson gave its slider values without its
            # geometry - it used to ride in on style="richardson" instead.
            preset=preset,
            shadow=shadow,
            shade=shade,
            shadow_strength=shadow_strength,
            outline=outline,
            width=width,
            ortho=ortho,
            gpu=gpu,
            bg=bg,
            rotate=rotate,
            autoplay=autoplay,
            pae=pae,
            pae_size=pae_size,
            scatter=scatter,
            scatter_size=scatter_size,
            overlay=overlay,
            multi=multi,
            cyclic=cyclic,
            cutoffs=cutoffs,
        )
        
        # Add viewer_id to root level
        import uuid
        if id is not None:
            self.config["viewer_id"] = str(id)
        else:
            self.config["viewer_id"] = str(uuid.uuid4())
        
        # The viewer's mode is determined by when .show() is called.
        self.objects = []                 # Store all data
        self._current_object_data = None  # List to hold frames for current object
        self._is_live = False             # True if .show() was called *before* .add()
        # SOMEONE ELSE IS ARRANGING THE DISPLAY - a grid, collecting viewers to
        # lay out together. Two things follow, and they used to be spelled by
        # setting _is_live, which meant both of them wrongly: from_pdb must not
        # show the viewer on its own, AND add() must not emit a live update,
        # because there is no viewer on the page yet to receive one. Grid.show()
        # calls _mark_published() afterwards, which is when live begins.
        self._managed = False
        self._data_display_id = None      # For updating data cell only (not viewer)

        # Track sent frames and metadata to enable true incremental updates
        self._sent_frame_count = {}       # {"obj_name": num_frames_sent}
        self._sent_metadata = {}          # {"obj_name": {metadata_dict}}
        self._live_seq = 0                # Monotonic sequence for deduplication
        self._mailbox_handle = None       # DisplayHandle for mailbox (persistence=False)
        self._latest_output_handle = None   # DisplayHandle of last add() for replace() updates (persistence=True)
        self._persistence = bool(persistence)
        # SHARE THE LIBRARY, ALWAYS. This was a flag, then gated on being able
        # to ask the page, and both were ways of choosing the wrong answer:
        # _can_ask_the_page only checked that eval_js EXISTS, and the ping's
        # answer was then treated as a veto - so in Colab, where it exists and
        # the ping went unanswered, nothing ever shared.
        #
        # Sharing costs nothing where it cannot help. In Jupyter every cell
        # output lives in ONE document, so the borrower's first line - is
        # initializePy2DmolViewer already a function - is true and it does
        # nothing at all. In Colab the outputs are separate frames and the
        # channel carries it, which was measured there: 440,215 bytes, 1 ms.
        #
        # tests/colab.py patches this to reach the unshared path.
        self._share_library = True
        # THE SLAB IS THE VIEWER'S, not an object's - it is a property of the
        # camera, and it survives switching between objects. Held as a SELECTOR
        # rather than as two depths: the renderer refits it every frame from the
        # residues it names, so it stays over them as the structure turns.
        self._clip = None
        self._sent_clip = False          # not None: None is a value it can take
        # WHICH OBJECTS ARE ON SCREEN is the viewer's too, for the same reason,
        # and it is held as an explicit list: `show_objects()` resolves "all of
        # them" at the moment of the call, so nothing downstream has to know a
        # second spelling. None is the default - the current object, alone.
        self._shown_objects = None
        self._sent_shown_objects = False
        # AND THE ORIENTATION IS AN ACTION, NOT A STATE. The other two are
        # compared against what was last sent and skipped when unchanged; the
        # same orient() asked for twice means fly there twice, so it is queued
        # and cleared on send rather than diffed.
        self._orient_request = None


    def _emit_to_output(self, html_content: str, payload_json: Optional[str] = None, update_last_add: bool = False) -> None:
        """
        Emit HTML to output based on persistence mode.

        Uses DisplayHandle.update() throughout for safety and simplicity.

        Args:
            html_content (str): HTML content to emit (usually JavaScript)
            payload_json (str, optional): JSON payload for mailbox mode
            update_last_add (bool): If True, this is a replace() operation

        Behavior:
            persistence=True + add():
                - display() → creates NEW cell, stores handle
            
            persistence=True + replace():
                - handle.update() → updates last add() cell

            persistence=False (both add/replace):
                - First time: display() → creates mailbox, stores handle
                - Subsequent: handle.update() → updates mailbox

        Note: Using handles instead of display_id strings prevents accidentally
        updating the wrong cell.
        """
        viewer_id = self.config["viewer_id"]
        
        if self._persistence:
            if update_last_add and self._latest_output_handle:
                # Replace mode: Update existing add() output
                self._latest_output_handle.update(HTML(html_content))
            else:
                # Add mode: Create new output with display_id and store handle
                display_id = f"py2dmol_add_{viewer_id}_{self._live_seq}"
                self._latest_output_handle = display(HTML(html_content), display_id=display_id)
                self._live_seq += 1  # Increment for next unique display_id
        else:
            # Mailbox mode: Use handle.update() for all operations
            if not self._mailbox_handle:
                # First time: create mailbox with display_id and store handle
                display_id = f"py2dmol_mailbox_{viewer_id}"
                if payload_json:
                    mailbox_html = (
                        f'<script id="py2dmol_live_{viewer_id}" type="application/json" style="display:none">{payload_json}</script>'
                        f'{html_content}'
                    )
                else:
                    mailbox_html = html_content
                self._mailbox_handle = display(HTML(mailbox_html), display_id=display_id)
            else:
                # Update existing mailbox
                if payload_json:
                    mailbox_html = (
                        f'<script id="py2dmol_live_{viewer_id}" type="application/json" style="display:none">{payload_json}</script>'
                        f'{html_content}'
                    )
                else:
                    mailbox_html = html_content
                self._mailbox_handle.update(HTML(mailbox_html))

    def _get_data_dict(self):
        """
        Serializes the current coordinate state to a dict, omitting
        any attributes that are None.
        """
        payload = {}
        
        # Coords are mandatory
        if self._coords is not None:
            payload["coords"] = np.round(self._coords, 2).tolist()
        else:
            # If there are no coordinates, return an empty dict
            return {}

        # ...and how the browser should place it: superpose on the previous
        # frame, and whether a mirrored fit is acceptable. Only when asked, so a
        # single-frame object carries neither.
        if getattr(self, "_align", False):
            payload["align"] = True
            if getattr(self, "_allow_reflection", False):
                payload["allow_reflection"] = True

        # Optional attributes
        if self._plddts is not None:
            payload["plddts"] = np.round(self._plddts, 0).astype(int).tolist()

        if self._chains is not None:
            payload["chains"] = list(self._chains)

        if self._position_types is not None:
            payload["position_types"] = list(self._position_types)

        if self._pae is not None:
            # SCALED TO 0-255 (x8), then BASE64. The scaling is the panel's own
            # storage - panels/pae.js keeps a Uint8Array at 1/8 A and its colour
            # map divides by 8 - and it was chosen against a list of floats,
            # which it does beat. Against JSON TEXT it is the wrong way round:
            # multiplying by eight costs a DIGIT PER VALUE, and a PAE is N^2 of
            # them.
            #
            # Measured on AF-Q5VSL9 (837x837, 700,569 values), which is 72% of
            # the demo notebook on its own:
            #
            #   list of ints, ", " separators   3,048 KB   (what shipped)
            #   ...compact separators           2,364 KB
            #   ...as 0-31 instead of 0-248     1,732 KB
            #   base64 of the bytes               912 KB
            #
            # A base64 string is also exactly what the panel wants: one atob
            # and it has its Uint8Array, where a list of a million numbers has
            # to be walked. The three forms setData already took - a nested
            # list of floats, a flat list of scaled ints, a Uint8Array - all
            # still work, so an older payload still draws.
            scaled_pae = np.clip(np.round(self._pae * 8), 0, 255).astype(np.uint8)
            # ...AND NO MORE RESOLUTION THAN THE PANEL CAN SHOW. The matrix is
            # drawn by scaling an n x n image into a canvas of `pae.size` px
            # (300 by default) - so for anything bigger the browser is already
            # throwing the detail away on every frame, and a 837-row matrix in
            # a 300px panel gives each residue 0.36 of a pixel. Doing the
            # resample once, in Python, is the same picture for an eighth of
            # the bytes: 912 KB of base64 becomes 120.
            #
            # THE TRUE SIZE TRAVELS WITH IT. `n` was the matrix side AND the
            # residue count, and the panel used it for both - a box dragged on
            # the plot is a range of RESIDUES handed to setVisibility. Send
            # pae_n and the two stop being the same number.
            payload["pae_n"] = int(scaled_pae.shape[0])
            cap = max(int((self.config.get("pae") or {}).get("size") or 300), 256)
            if scaled_pae.shape[0] > cap:
                scaled_pae = _downsample_square(scaled_pae, cap)
            payload["pae"] = base64.b64encode(
                scaled_pae.flatten().tobytes()).decode('ascii')

        if self._scatter is not None:
            payload["scatter"] = self._scatter  # Already in [x, y] format

        if self._position_names is not None:
            payload["position_names"] = list(self._position_names)

        if self._position_residue_numbers is not None:
            payload["residue_numbers"] = list(self._position_residue_numbers)

        # A LIGAND ATOM'S OWN NAME AND ELEMENT. Every other position stands for
        # a whole residue - its alpha carbon, its C4' - and has neither; these
        # are what colour-by-element reads for a ligand.
        if self._position_atoms is not None:
            payload["position_atoms"] = list(self._position_atoms)
        if self._position_elements is not None:
            payload["position_elements"] = list(self._position_elements)

        return payload

    def _update(self, coords, plddts=None, chains=None, position_types=None, pae=None, scatter=None, align=True, position_names=None, residue_numbers=None, atom_types=None, allow_reflection=False, position_atoms=None, position_elements=None):
      """
      Updates the internal state with new data. Coordinates are kept in original space.
      The viewing angle is chosen in the browser, not here.
      The 'align' parameter controls whether subsequent frames are aligned to the first frame.

      Args:
          residue_numbers: PDB residue sequence numbers (resSeq), one per position.
                           For ligands, multiple positions may share the same residue number.
          atom_types: Backward compatibility alias for position_types (deprecated).
          align: If True, subsequent frames are aligned to the first frame.
                 Best view is ALWAYS computed for first frame regardless of this parameter.

      """
      # Backward compatibility: support atom_types as alias for position_types
      if atom_types is not None and position_types is None:
          position_types = atom_types

      # --- Coordinate Alignment ---
      #
      # NOT DONE HERE ANY MORE. Superposing each frame on the one before it is
      # Kabsch, and src/io/math.js has had a Kabsch since numeric.js was dropped -
      # so this ran a second implementation in numpy, on the way into a payload,
      # to produce coordinates the browser could have produced itself.
      #
      # addFrame in src/core/mol.js does it now, which is also the one funnel a
      # streamed frame arrives through. What travels is the REQUEST - align and
      # allow_reflection, per frame, exactly as they were passed to add().
      #
      # The viewing angle went the same way one commit earlier; see the note
      # where best_view used to be.
      self._coords = coords
      self._align = bool(align)
      self._allow_reflection = bool(allow_reflection)
      
      # --- Store Provided Data (or None) ---
      self._plddts = plddts
      self._chains = chains
      self._position_types = position_types

      # Normalize PAE to a 2D numpy float array so arithmetic in _get_data_dict
      # works correctly regardless of whether the caller passed a list-of-lists,
      # a plain list, or an ndarray.
      if pae is not None:
          pae_arr = np.asarray(pae, dtype=float)
          if pae_arr.ndim == 2:
              self._pae = pae_arr
          else:
              print(f"Warning: PAE must be a 2D matrix, got shape {pae_arr.shape}. "
                    "Did you pass `paes=data['pae']` instead of `paes=[data['pae']]`? Ignoring PAE.")
              self._pae = None
      else:
          self._pae = None

      self._scatter = scatter
      self._position_names = position_names
      self._position_residue_numbers = residue_numbers
      self._position_atoms = position_atoms
      self._position_elements = position_elements

      # --- Final Safety Check (ensure arrays match coord length if provided) ---
      n_positions = self._coords.shape[0]
      
      if self._plddts is not None and len(self._plddts) != n_positions:
          print(f"Warning: pLDDT length mismatch. Ignoring pLDDTs for this frame.")
          self._plddts = None
      if self._chains is not None and len(self._chains) != n_positions:
          print(f"Warning: Chains length mismatch. Ignoring chains for this frame.")
          self._chains = None
      if self._position_types is not None and len(self._position_types) != n_positions:
          print(f"Warning: Position types length mismatch. Ignoring position types for this frame.")
          self._position_types = None
      if self._position_names is not None and len(self._position_names) != n_positions:
          print(f"Warning: Position names length mismatch. Ignoring position names for this frame.")
          self._position_names = None
      if self._position_residue_numbers is not None and len(self._position_residue_numbers) != n_positions:
          print(f"Warning: Residue numbers length mismatch. Ignoring residue numbers for this frame.")
          self._position_residue_numbers = None
      for attr, label in (("_position_atoms", "Atom names"),
                          ("_position_elements", "Elements")):
          value = getattr(self, attr)
          if value is not None and len(value) != n_positions:
              print(f"Warning: {label} length mismatch. Ignoring {label.lower()} for this frame.")
              setattr(self, attr, None)

    def _find_object_by_name(self, name):
        """Find and return object by name, or None if not found."""
        for obj in self.objects:
            if obj.get("name") == name:
                return obj
        return None

    def _send_incremental_update(self) -> None:
        """
        Send incremental state update to viewer (for add() operations).

        Called by: add() method when in live mode (_is_live=True)

        Behavior:
            - persistence=True: Creates NEW output cell using display()
            - persistence=False: Updates SAME mailbox cell using update_display()

        Data Sent:
            - NEW frames that haven't been sent yet (tracked via _sent_frame_count)
            - CHANGED metadata only (color, contacts, bonds, rotation, center)

        Frame Accumulation: YES - frames always append to trajectory

        Output Management:
            persistence=True:
                - Calls display(HTML(...))
                - Stores returned DisplayHandle in _latest_output_handle
                - Creates visible output cell in notebook
                - Each call creates a new cell

            persistence=False:
                - Calls handle.update() on _mailbox_handle
                - Updates the single "mailbox" cell
                - Ephemeral output (doesn't bloat notebook)

        JavaScript Handler: handleIncrementalStateUpdate()

        Flow:
            add() → _send_incremental_update() 
                ↓
                persistence=True? → display() → NEW cell → store handle
                persistence=False? → update_display() → SAME mailbox cell
                ↓
                JavaScript receives → appends frames to trajectory

        See Also:
            _send_replace_update(): For replace() operations
            handleIncrementalStateUpdate (core/mol.js): JavaScript handler
        """
        if not self._is_live:
            return

        viewer_id = self.config["viewer_id"]

        # Track new frames and changed metadata to send
        new_frames_by_object = {}
        changed_metadata_by_object = {}

        for obj in self.objects:
            obj_name = obj.get("name", "")
            if not obj_name:
                continue

            frames = obj.get("frames", [])
            total_frame_count = len(frames)

            # Determine which frames are new (not yet sent)
            frames_already_sent = self._sent_frame_count.get(obj_name, 0)

            if total_frame_count > frames_already_sent:
                # Extract only the new frames using slice
                new_frames = frames[frames_already_sent:]
                new_frames_by_object[obj_name] = new_frames

                # Update tracking: mark these frames as sent
                self._sent_frame_count[obj_name] = total_frame_count

            # Collect current metadata for this object
            current_metadata = {}
            if obj.get("color") is not None:
                current_metadata["color"] = obj["color"]
            if obj.get("contacts") is not None:
                current_metadata["contacts"] = obj["contacts"]
            if obj.get("bonds") is not None:
                current_metadata["bonds"] = obj["bonds"]
            # set_sse() writes this and then asks for a broadcast, so it has to
            # travel with the other per-object metadata or the call did nothing
            # in live mode. Keys are stringified for JSON, as in the static path.
            if obj.get("sse"):
                current_metadata["sse"] = {
                    str(k): v for k, v in obj["sse"].items()
                }
            # ...and each FRAME's own colour, which set_color(frame=N) writes.
            # A frame is delivered once and once only - _sent_frame_count sees
            # to that - so a colour set on a frame the viewer already has could
            # not travel by any route, and the call was silently lost on a live
            # viewer while working perfectly through show(). Compared as a whole
            # map by the change detection below, like every other field here.
            frame_colors = {
                str(i): f["color"] for i, f in enumerate(frames)
                if isinstance(f, dict) and f.get("color") is not None
            }
            if frame_colors:
                current_metadata["frame_colors"] = frame_colors
            if obj.get("scatter_config") is not None:
                current_metadata["scatter_config"] = obj["scatter_config"]
            if obj.get("rotation_matrix") is not None:
                current_metadata["rotation_matrix"] = obj["rotation_matrix"]
            if obj.get("center") is not None:
                current_metadata["center"] = obj["center"]

            # Determine which metadata fields have changed.
            #
            # A FIELD THAT WENT AWAY IS A CHANGE TOO, and it was the one case
            # this could not express. current_metadata is built from the fields
            # that are NOT None, so a colour taken off, a contact list emptied
            # or an SSE override cleared simply stopped appearing - it was never
            # unequal to anything, never packed, and the viewer kept showing it
            # for the life of the session. The whole block was skipped outright
            # when the last field went, because `if current_metadata:` is false
            # for an empty dict, which is exactly the moment there is most to
            # say. Removals travel as an explicit None; the JS applier reads the
            # KEY rather than the value's truth, so null means clear and absent
            # means leave alone.
            previously_sent_metadata = self._sent_metadata.get(obj_name, {})
            changed_metadata_fields = {}

            for field_name, field_value in current_metadata.items():
                # Include if new or changed
                if field_name not in previously_sent_metadata or previously_sent_metadata[field_name] != field_value:
                    changed_metadata_fields[field_name] = field_value
            for field_name in previously_sent_metadata:
                if field_name not in current_metadata:
                    changed_metadata_fields[field_name] = None

            if changed_metadata_fields:
                changed_metadata_by_object[obj_name] = changed_metadata_fields
                # Update tracking: mark this metadata as sent (deep copy to avoid aliasing)
                self._sent_metadata[obj_name] = copy.deepcopy(current_metadata)

        # ...AND WHAT BELONGS TO THE VIEWER RATHER THAN TO AN OBJECT. The slab
        # is the camera's: it survives switching objects, so it cannot travel in
        # a map keyed by object name. `False` is the unsent marker because None
        # is a value clip can take - it is how the slab is turned off.
        viewer_block = None
        if self._clip != self._sent_clip:
            viewer_block = {"clip": self._clip}
            self._sent_clip = copy.deepcopy(self._clip)
        # `multi=True` IS A STANDING INSTRUCTION, not a list. It means every
        # object including the ones not added yet, so it is re-resolved here as
        # well as in _display_viewer - otherwise a viewer opened with the flag
        # showed the objects that existed at show() time and quietly stopped
        # accepting new ones. show_objects(names) clears the flag; the diff
        # below is what keeps this from emitting when nothing has changed.
        if self.config.get("multi"):
            self._shown_objects = [o["name"] for o in self.objects]
        if self._shown_objects != self._sent_shown_objects:
            viewer_block = viewer_block or {}
            viewer_block["shown_objects"] = self._shown_objects
            self._sent_shown_objects = copy.deepcopy(self._shown_objects)
        if self._orient_request is not None:
            viewer_block = viewer_block or {}
            viewer_block["orient"] = self._orient_request
            self._orient_request = None

        # Skip update if nothing new to send
        if (not new_frames_by_object and not changed_metadata_by_object
                and viewer_block is None):
            return

        # Increment sequence for delivery
        self._live_seq += 1
        payload = {
            "seq": self._live_seq,
            "frames": new_frames_by_object,
            "meta": changed_metadata_by_object,
            "viewer": viewer_block
        }

        payload_json = json.dumps(payload, separators=(',', ':'))

        update_js = (
            f'(function(){{'
            f'const p={payload_json};'
            f'const f=p.frames||p.new_frames||{{}};'
            f'const m=p.meta||p.changed_meta||{{}};'
            f'const vw=p.viewer||null;'
            f'const vid="{viewer_id}";'
            # ...AND ANSWER A LATER ANNOUNCEMENT. BroadcastChannel does not
            # retain, so a post made before the viewer's iframe opened its
            # channel is gone. On a notebook reopen every output iframe loads
            # at once and this one - a kilobyte - routinely beats the viewer's
            # half megabyte, which is how a reopened live session came back
            # empty. The viewer announces itself with viewerReady; this cell
            # holds its payload and posts it again on hearing that. The channel
            # is kept alive by the handler on it.
            f'try{{const ch=new BroadcastChannel("py2dmol_"+vid);'
            f'const send=()=>ch.postMessage({{operation:"{OP_INCREMENTAL_UPDATE}",args:[f,m,vw],seq:p.seq}});'
            f'ch.onmessage=(e)=>{{if(e.data&&e.data.operation==="viewerReady")send();}};'
            f'send();}}catch(e){{}}'
            f'if(window.py2dmol_viewers&&window.py2dmol_viewers[vid]){{window.py2dmol_viewers[vid].handleIncrementalStateUpdate(f,m,p.seq,vw);}}'
            f'}})();'
        )

        # Emit to output using helper
        html_script = f'<script style="display:none">{update_js}</script>'
        self._emit_to_output(html_script, payload_json=payload_json, update_last_add=False)

    def _send_replace_update(self, object_name: str, frame_data: Dict[str, Any], meta: Dict[str, Any]) -> None:
        """
        Send replace-frame message to viewer (for replace() operations).

        Called by: replace() method when in live mode (_is_live=True)

        Behavior:
            persistence=True:
                - Updates LAST add() output cell using handle.update()
                - JavaScript replaces LAST frame only → builds trajectory
            
            persistence=False:
                - Updates mailbox cell using update_display()
                - JavaScript replaces ALL frames → streaming mode

        Args:
            object_name: Name of object to update
            frame_data: Frame data (coords, plddts, etc.)
            meta: Metadata (color, contacts, bonds, scatter_config)

        Payload includes:
            - 'persistence' flag sent to JavaScript
            - Determines replace behavior in handleReplaceFrame()

        Flow:
            replace() → _send_replace_update()
                ↓
                persistence=True? → handle.update() → update last cell
                persistence=False? → update_display() → update mailbox
                ↓
                JavaScript adapts behavior based on persistence flag

        See Also:
            _send_incremental_update(): For add() operations
            handleReplaceFrame (core/mol.js): JavaScript handler
        """
        if not self._is_live:
            return

        viewer_id = self.config["viewer_id"]

        # Increment sequence for delivery
        self._live_seq += 1
        payload = {
            "seq": self._live_seq,
            "frame": frame_data,
            "meta": meta or {},
            "object": object_name
        }

        payload_json = json.dumps(payload, separators=(',', ':'))

        update_js = (
            f'(function(){{'
            f'const p={payload_json};'
            f'const obj=p.object||"{object_name}";'
            f'const f=p.frame||{{}};'
            f'const m=p.meta||{{}};'
            f'const vid="{viewer_id}";'
            # ...and answers viewerReady the same way - see the note in
            # _send_incremental_update above.
            f'try{{const ch=new BroadcastChannel("py2dmol_"+vid);'
            f'const send=()=>ch.postMessage({{operation:"{OP_REPLACE_FRAME}",args:[f,m,obj],seq:p.seq}});'
            f'ch.onmessage=(e)=>{{if(e.data&&e.data.operation==="viewerReady")send();}};'
            f'send();}}catch(e){{}}'
            f'if(window.py2dmol_viewers&&window.py2dmol_viewers[vid]){{window.py2dmol_viewers[vid].handleReplaceFrame(f,m,obj,p.seq);}}'
            f'}})();'
        )

        # Emit to output using helper
        html_script = f'<script style="display:none">{update_js}</script>'
        self._emit_to_output(html_script, payload_json=payload_json, update_last_add=True)


    def _display_viewer(self, static_data=None, include_libs=True):
        """
        Internal: Renders the viewer's HTML directly into a div.

        Args:
            static_data (list, optional):
                - A list of objects (for static 'show()' or hybrid modes).
            include_libs (bool, optional):
                - If True, includes the viewer library scripts (default).
                - If False, skips library injection (for grid cells that reuse libraries).

        Returns:
            str: The complete HTML string to be displayed.
        """
        html_template = _resource_text('viewer.html')

        viewer_id = self.config["viewer_id"]

        # ...AND THE SLAB, WHICH IS THE VIEWER'S. It rides in the config rather
        # than in the object payload because it belongs to the camera and
        # survives switching objects. normalizeConfig carries an unknown
        # top-level key through untouched, which is what makes this the cheap
        # route; the live path sends it separately, as `viewer` beside `frames`
        # and `meta`. Set here rather than in clip() so that clip() before
        # show() and clip() after both arrive.
        if self._clip is not None:
            self.config["clip"] = self._clip
        else:
            self.config.pop("clip", None)
        self._sent_clip = copy.deepcopy(self._clip)

        # ...AND THE SAME TWO KEYS BESIDE IT. `multi=True` is resolved here
        # rather than in __init__ because the objects it names do not exist
        # until something has been added.
        if self.config.get("multi") and self.objects:
            self._shown_objects = [o["name"] for o in self.objects]
        if self._shown_objects is not None:
            self.config["shown_objects"] = list(self._shown_objects)
        else:
            self.config.pop("shown_objects", None)
        self._sent_shown_objects = copy.deepcopy(self._shown_objects)
        if self._orient_request is not None:
            # ...AND A STATIC VIEWER ALWAYS JUMPS. It has only just appeared,
            # and a cell that opens mid-flight reads as a bug.
            self.config["orient"] = dict(self._orient_request, animate=False)
            self._orient_request = None
        else:
            self.config.pop("orient", None)

        # Setup viewer config - store per viewer to avoid global overwrites
        # Initialize the configs object if it doesn't exist
        config_script = f"""<script>
window.py2dmol_configs = window.py2dmol_configs || {{}};
window.py2dmol_configs['{viewer_id}'] = {json.dumps(self.config)};
</script>"""

        data_script = ""

        if static_data and isinstance(static_data, list):
            serialized_objects = []
            for py_obj in static_data:
                # Skip objects with no frames AND no metadata
                if not py_obj.get("frames") and not any(
                    py_obj.get(key) for key in ["scatter_config", "contacts", "bonds", "color", "sse", "rotation_matrix", "center"]
                ):
                    continue

                light_frames = []
                # WHAT THE PREVIOUS FRAME SENT, so an unchanged field can be
                # left out. One dict rather than ten prev_* locals.
                prev = {}

                for frame_idx, frame in enumerate(py_obj.get("frames", [])):
                    # Skip frames without coords (they're invalid)
                    if "coords" not in frame or not frame["coords"]:
                        continue

                    light_frame = {"coords": frame["coords"]}
                    if frame.get("name") is not None:
                        light_frame["name"] = frame["name"]

                    # ONE LIST, WALKED - see FRAME_INHERITED above. This was ten
                    # copies of the same six lines, one per field, and the cost
                    # of that shape was not the lines: a field simply left out
                    # of the run is a field that never reaches the browser, and
                    # three were. `align` and `allow_reflection` were missing
                    # for as long as the browser has done the fitting, so a
                    # trajectory loaded with add() then show() never superposed;
                    # and the JS side of this same rebuild had lost the two
                    # per-atom columns, which killed element colouring in every
                    # notebook. Adding a field is adding a name to the tuple now,
                    # and tests/config.js checks the two sides still agree.
                    for key in FRAME_INHERITED:
                        cur = frame.get(key)
                        if frame_idx == 0 or cur != prev.get(key):
                            # plddts travels even as None: that is the
                            # difference between "no confidence values" and
                            # "the same ones as the frame before".
                            if cur is not None or key in FRAME_SEND_NONE:
                                light_frame[key] = cur
                            prev[key] = cur

                    # ...and the ones that ride whenever they are set, because
                    # they belong to the frame rather than to the run of them.
                    for key in FRAME_ALWAYS:
                        val = frame.get(key)
                        if val is not None and val is not False:
                            light_frame[key] = val

                    light_frames.append(light_frame)

                # Create object serialization - even if no frames, we may have metadata
                obj_to_serialize = {"name": py_obj.get("name"), "frames": light_frames}
                
                # For objects with frames, get chains/position_types from first frame
                if light_frames:
                    first_frame = light_frames[0]
                    if "chains" in first_frame and first_frame["chains"] is not None:
                        obj_to_serialize["chains"] = first_frame["chains"]
                    if "position_types" in first_frame and first_frame["position_types"] is not None:
                        obj_to_serialize["position_types"] = first_frame["position_types"]

                # Add rotation_matrix and center if they exist (for viewing orientation)
                if "rotation_matrix" in py_obj and py_obj["rotation_matrix"] is not None:
                    obj_to_serialize["rotation_matrix"] = py_obj["rotation_matrix"]
                if "center" in py_obj and py_obj["center"] is not None:
                    obj_to_serialize["center"] = py_obj["center"]

                # Add contacts if they exist
                if "contacts" in py_obj and py_obj["contacts"] is not None and len(py_obj["contacts"]) > 0:
                    obj_to_serialize["contacts"] = py_obj["contacts"]

                # Add bonds if they exist
                if "bonds" in py_obj and py_obj["bonds"] is not None and len(py_obj["bonds"]) > 0:
                    obj_to_serialize["bonds"] = py_obj["bonds"]

                # Add color overrides if they exist
                if "color" in py_obj and py_obj["color"] is not None:
                    obj_to_serialize["color"] = py_obj["color"]

                # ... and secondary-structure overrides (set_ss), which travel
                # with the object for the same reason colour does: both are keyed
                # by position index and only mean anything against this object.
                if py_obj.get("sse"):
                    obj_to_serialize["sse"] = {
                        str(k): v for k, v in py_obj["sse"].items()
                    }

                # Add scatter_config if it exists
                if "scatter_config" in py_obj and py_obj["scatter_config"] is not None:
                    obj_to_serialize["scatter_config"] = py_obj["scatter_config"]

                serialized_objects.append(obj_to_serialize)

            # COMPACT SEPARATORS. json.dumps writes ", " and ": " by default,
            # and this is a megabyte of numbers written into an .ipynb - one
            # space per array element, paid again for every viewer in the
            # document. Nothing reads it, and 17% of the demo notebook was
            # those spaces.
            data_json = json.dumps(serialized_objects, separators=(',', ':'))

            # Use viewer_id-specific namespace to avoid conflicts
            data_script = f'''<script id="static-data-{viewer_id}">
          window.py2dmol_staticData = window.py2dmol_staticData || {{}};
          window.py2dmol_staticData['{viewer_id}'] = {data_json};
        </script>'''
        else:
            # Pure Dynamic mode: inject empty data, will be populated by messages
            data_script = f'''<script id="protein-data-{viewer_id}">
          window.py2dmol_proteinData = window.py2dmol_proteinData || {{}};
          window.py2dmol_proteinData['{viewer_id}'] = {{ "coords": [], "plddts": [], "chains": [], "position_types": [], "pae": null }};
        </script>'''

        # Build injection scripts for config and data
        injection_scripts = config_script + "\n" + data_script

        # Inject config and data into the raw HTML template
        final_html = html_template.replace("<!-- DATA_INJECTION_POINT -->", injection_scripts)

        # ...AND THE CANVAS BOX, IN THE MARKUP. The stylesheet says 600x600 and
        # parts/viewport.js corrects it - so the page is the wrong height until
        # a script runs. Colab inserts output HTML with innerHTML, which never
        # executes a script, and sizes the output iframe from what it measures
        # in that window: a 2x2 grid of 300px viewers is 1,220px of unsized
        # markup, and the frame kept ~1,000px around a 644px page. That is the
        # white space under a grid, and it is gone on reopen because the
        # measurement happens again after the scripts have run.
        #
        # An INLINE STYLE, not a per-viewer rule: ids repeat when a page holds
        # several viewers, so a `#canvasContainer {...}` block would apply to
        # all of them. This is also what viewport.js writes, so the two agree.
        size = self.config.get("display", {}).get("size") or [400, 400]
        token = "data-py2dmol-canvas-size"
        if token not in final_html:
            raise RuntimeError(
                "viewer.html has no " + token + " on #canvasContainer - without"
                " it the canvas box is the stylesheet's 600x600 until a script"
                " runs, which is what Colab measures when it sizes the output"
                " frame")
        final_html = final_html.replace(
            token, 'style="width:{}px;height:{}px"'.format(
                int(size[0]), int(size[1])))

        # Standard div approach
        container_html = f"""
        <div id="{viewer_id}" style="position: relative; display: inline-block; line-height: 0;">
            {final_html}
        </div>
        <script>
            (function() {{
                const container = document.getElementById("{viewer_id}");

                function init() {{
                    if (container && typeof initializePy2DmolViewer === 'function') {{
                        initializePy2DmolViewer(container, '{viewer_id}');
                    }} else {{
                        console.error("py2dmol: Failed to initialize viewer (container or function missing).");
                    }}
                }}

                if (typeof initializePy2DmolViewer === 'function') {{
                    init();
                }} else {{
                    // NOTHING DISPATCHES py2dmol_lib_loaded - not one line in
                    // the tree - so this branch was a blank cell and silence.
                    // It has never been reached, because the bundle above is
                    // prepended synchronously and the branch above always
                    // wins; a fallback that only runs when something has
                    // already gone wrong is exactly the one that must not fail
                    // quietly. Poll, briefly, and then SAY SO.
                    var tries = 0;
                    var t = setInterval(function () {{
                        if (typeof initializePy2DmolViewer === 'function') {{
                            clearInterval(t); init();
                        }} else if (++tries > 100) {{
                            clearInterval(t);
                            // SAY IT WHERE IT CAN BE SEEN. An empty box is
                            // indistinguishable from a structure that failed to
                            // parse, and the likely cause is specific and
                            // fixable: the cell that carries the library was
                            // cleared or removed, so nothing on the page has
                            // it to lend. Naming a flag here would be worse
                            // than saying nothing - there is not one.
                            var msg = "py2Dmol: the viewer library never"
                                + " loaded. Re-run the first cell in this"
                                + " notebook that created a viewer - it is the"
                                + " one carrying the library, and the others"
                                + " borrow it from there.";
                            console.error(msg);
                            if (container) {{
                                var p = document.createElement('div');
                                p.style.cssText = 'padding:8px;font:12px/1.5'
                                    + ' ui-monospace,Menlo,monospace;color:#a11;'
                                    + 'border:1px solid #e0b4b4;border-radius:6px;'
                                    + 'background:#fdf4f4';
                                p.textContent = msg;
                                container.appendChild(p);
                            }}
                        }}
                    }}, 20);
                }}
            }})();
        </script>
        """ # Inject JS: always use inline package scripts (offline mode)
        # Only include library scripts if requested (grid optimization)
        if include_libs:
            # ONE BUNDLE, NOT FIFTEEN SCRIPTS.
            #
            # The renderer is split across a dozen source files so it can be
            # read; a notebook cell should not pay for that. tools/bundle.py
            # concatenates the 'notebook' target in load order and minifies it
            # once, which also retires the whole prepend-order hazard - inside a
            # bundle the order is fixed at build time and cannot be got wrong by
            # adding a read in the wrong place.
            #
            # What is in it: the renderer core and its parts, the cartoon
            # geometry, BOTH painters, and the PAE and scatter panels.
            #
            # There were three notebook builds - GPU, 2D, and a tube-only one
            # without the cartoon geometry - because this library is inlined
            # into the .ipynb once per show() cell, so every kilobyte was paid
            # again for every viewer. Sharing pays it once for the document
            # instead, which removes the reason for all three.
            #
            # The second painter costs 26 KB and gives back everything that was
            # traded for it: `gpu` is a runtime setting again rather than a
            # choice of file (see useGPU in core/mol.js, which takes
            # config.rendering.gpu when BOTH painters are present), a machine
            # with no WebGL2 has something to fall back on, and the cartoon can
            # export a vector - which needs the 2D painter, because a raster
            # has none to give.
            bundle = "bundles/py2Dmol.notebook.min.js"
            # SHARE IT, IF ASKED, AND IF SOMEONE ELSE ALREADY CARRIES IT.
            #
            # The first viewer of a session writes the library and offers it on
            # a channel; every later one writes a two-line request instead. The
            # bootstrap below already waits for initializePy2DmolViewer to
            # appear before it starts, so a borrower needs nothing more than to
            # make it appear.
            global _LENT_BUNDLE
            # THE ASK IS A CONFIRMATION, NEVER A VETO. A True lets a FRESH
            # KERNEL borrow from a page that still has a lender, which this
            # process cannot know on its own; anything else falls back to what
            # this kernel wrote, which involves no browser and cannot fail
            # quietly. A False is indistinguishable from a question that never
            # arrived, and believing one is how this shipped writing the
            # library into every cell - see CLAUDE.md, which tells the story,
            # and tests/config.js, which fails if the shape comes back.
            #
            # ...UNDER A KEY THAT INCLUDES THE BUNDLE'S CONTENT, so a cell can
            # only borrow a library that matches the payload it is writing -
            # see _share_key.
            share_key = _share_key(bundle)
            seen = _lender_on_page(share_key) if self._share_library else None
            can_borrow = (seen is True) or (_LENT_BUNDLE == share_key)
            if self._share_library and can_borrow:
                container_html = _borrow_js(share_key) + container_html
            elif self._share_library:
                _LENT_BUNDLE = share_key
                # AS A JSON STRING, NOT AS SCRIPT TEXT. The lender has to hand
                # the source on, and reading it back out of its own <script>
                # element does not work: the bundle contains the text "<script"
                # once, which puts the HTML parser into script data double
                # escaped, and the element then reads back as 196 KB of 429 -
                # an eval that fails with a SyntaxError saying nothing about
                # why. Escaping that one sequence inside the JSON literal
                # removes the hazard for a handful of bytes.
                src = json.dumps(_resource_text(bundle))
                for bad in ('<script', '</script', '<!--'):
                    src = src.replace(bad, bad.replace('<', '\\u003c'))
                container_html = (
                    '<script>window.__py2dmolLib=' + src + ';'
                    '(0,eval)(window.__py2dmolLib);' + _lend_js(share_key)
                    + '</script>\n' + container_html)
            else:
                container_html = (f'<script>{_resource_text(bundle)}</script>\n'
                                  + container_html)

        return container_html

    def _display_html(self, html_string):
        """Displays the HTML simply, without widgets."""
        # We no longer use ipywidgets, just display directly.
        # The .show() method will now print a *new* cell.
        display(HTML(html_string))

    def clear(self):
        """Clears all objects and frames from the viewer."""
        # Clear python data
        self.objects = []
        self._current_object_data = None

        # Reset python state
        # Note: We don't send a message to the viewer because:
        # 1. self.objects is already cleared above
        # 2. _is_live is set to False below
        # 3. The viewer will continue showing its current content until show() is called again
        self._coords = None
        self._center = None
        self._align = True
        self._allow_reflection = False
        self._plddts = None
        self._chains = None
        self._position_types = None
        self._pae = None
        self._scatter = None
        self._position_names = None
        self._position_residue_numbers = None
        self._position_atoms = None
        self._position_elements = None
        self._is_live = False

        # Reset incremental update tracking
        self._sent_frame_count = {}
        self._sent_metadata = {}

    def _parse_contact_color(self, color_str):
        """
        Parse color string to RGB dict.
        Supports color names, hex codes, and rgba format.
        
        Args:
            color_str (str): Color string (name, hex, or rgba)
            
        Returns:
            dict or None: {"r": int, "g": int, "b": int} or None if invalid
        """
        if not color_str or not isinstance(color_str, str):
            return None
        
        color_lower = color_str.lower().strip()
        
        # Common color names
        color_names = {
            'red': {'r': 255, 'g': 0, 'b': 0},
            'green': {'r': 0, 'g': 255, 'b': 0},
            'blue': {'r': 0, 'g': 0, 'b': 255},
            'yellow': {'r': 255, 'g': 255, 'b': 0},
            'orange': {'r': 255, 'g': 165, 'b': 0},
            'purple': {'r': 128, 'g': 0, 'b': 128},
            'cyan': {'r': 0, 'g': 255, 'b': 255},
            'magenta': {'r': 255, 'g': 0, 'b': 255},
            'pink': {'r': 255, 'g': 192, 'b': 203},
            'brown': {'r': 165, 'g': 42, 'b': 42},
            'black': {'r': 0, 'g': 0, 'b': 0},
            'white': {'r': 255, 'g': 255, 'b': 255},
            'gray': {'r': 128, 'g': 128, 'b': 128},
            'grey': {'r': 128, 'g': 128, 'b': 128}
        }
        
        if color_lower in color_names:
            return color_names[color_lower]
        
        # Hex color (#ff0000 or ff0000)
        if color_str.startswith('#') or (len(color_str) == 6 and all(c in '0123456789abcdefABCDEF' for c in color_str)):
            hex_str = color_str[1:] if color_str.startswith('#') else color_str
            if len(hex_str) == 6:
                try:
                    r = int(hex_str[0:2], 16)
                    g = int(hex_str[2:4], 16)
                    b = int(hex_str[4:6], 16)
                    return {'r': r, 'g': g, 'b': b}
                except ValueError:
                    return None
        
        # RGBA format: rgba(255, 0, 0, 0.8) or rgb(255, 0, 0)
        rgba_match = re.match(r'rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)', color_str)
        if rgba_match:
            try:
                r = int(rgba_match.group(1))
                g = int(rgba_match.group(2))
                b = int(rgba_match.group(3))
                return {'r': r, 'g': g, 'b': b}
            except (ValueError, IndexError):
                return None
        
        return None

    def _parse_contacts_file(self, filepath):
        """
        Parse .cst contact file.
        
        Args:
            filepath (str): Path to .cst file
            
        Returns:
            list: List of contact arrays
        """
        contacts = []
        try:
            with open(filepath, 'r') as f:
                lines = f.readlines()
            
            for line in lines:
                trimmed = line.strip()
                # Skip empty lines and comment lines (starting with #)
                if not trimmed or trimmed.startswith('#'):
                    continue
                
                parts = trimmed.split()
                
                # Position indices format: "10 50 1.0" or "10 50 1.0 red" (weight is required)
                if len(parts) >= 3:
                    try:
                        idx1 = int(parts[0])
                        idx2 = int(parts[1])
                        weight = float(parts[2])
                        
                        if weight > 0:
                            contact = [idx1, idx2, weight]
                            # Optional color (4th part and beyond)
                            if len(parts) >= 4:
                                color_str = ' '.join(parts[3:])  # Join in case color has spaces
                                color = self._parse_contact_color(color_str)
                                if color:
                                    contact.append(color)
                            contacts.append(contact)
                            continue
                    except (ValueError, IndexError):
                        pass
                
                # Chain + residue format: "A 10 B 50 0.5" or "A 10 B 50 0.5 yellow" (weight is required)
                if len(parts) >= 5:
                    try:
                        chain1 = parts[0]
                        res1 = int(parts[1])
                        chain2 = parts[2]
                        res2 = int(parts[3])
                        weight = float(parts[4])
                        
                        if weight > 0:
                            contact = [chain1, res1, chain2, res2, weight]
                            # Optional color (6th part and beyond)
                            if len(parts) >= 6:
                                color_str = ' '.join(parts[5:])  # Join in case color has spaces
                                color = self._parse_contact_color(color_str)
                                if color:
                                    contact.append(color)
                            contacts.append(contact)
                    except (ValueError, IndexError):
                        pass
        except Exception as e:
            print(f"Error parsing contacts file '{filepath}': {e}")
            return []
        
        return contacts

    def _process_contacts(self, contacts):
        """
        Process contacts input (filepath string or list of lists).
        
        Args:
            contacts: Either a filepath (str) or list of contact arrays
            
        Returns:
            list: List of contact arrays, or None if invalid
        """
        if contacts is None:
            return None
        
        if isinstance(contacts, str):
            # Filepath - parse it
            return self._parse_contacts_file(contacts)
        elif isinstance(contacts, list):
            # List of contacts - validate and parse colors
            validated = []
            for contact in contacts:
                if isinstance(contact, list) and len(contact) >= 3:
                    # Parse color if it's a string (4th element)
                    if len(contact) >= 4:
                        color_elem = contact[3]
                        # If color is a string, parse it to RGB dict
                        if isinstance(color_elem, str):
                            parsed_color = self._parse_contact_color(color_elem)
                            if parsed_color:
                                # Replace string with parsed RGB dict
                                validated.append([contact[0], contact[1], contact[2], parsed_color])
                            else:
                                # Invalid color string, skip color
                                validated.append([contact[0], contact[1], contact[2]])
                        else:
                            # Color is already a dict or other format, keep as-is
                            validated.append(contact)
                    else:
                        # No color specified
                        validated.append(contact)
                else:
                    print(f"Warning: Skipping invalid contact: {contact}")
            return validated if validated else None
        else:
            print(f"Error: contacts must be a filepath (str) or list of lists, got {type(contacts)}")
            return None

    def _parse_scatter_csv(self, filepath):
        """
        Parse a CSV file containing scatter plot data.

        Expected format:
        - First row: header with 2 columns (xlabel, ylabel)
        - Subsequent rows: x,y numeric data pairs

        Args:
            filepath (str): Path to CSV file

        Returns:
            dict: {"data": [[x1, y1], [x2, y2], ...], "xlabel": str, "ylabel": str}
                  or None if parsing fails
        """
        try:
            with open(filepath, 'r') as f:
                lines = f.readlines()

            if len(lines) < 2:
                print(f"Error: CSV file '{filepath}' must have at least a header row and one data row")
                return None

            # Parse header (first row)
            header = [h.strip() for h in lines[0].strip().split(',')]
            if len(header) < 2:
                print(f"Error: CSV file '{filepath}' must have at least 2 columns")
                return None

            xlabel = header[0]
            ylabel = header[1]

            # Parse data rows
            scatter_data = []
            for i, line in enumerate(lines[1:], start=2):
                line = line.strip()
                if not line:  # Skip empty lines
                    continue

                values = [v.strip() for v in line.split(',')]
                if len(values) < 2:
                    print(f"Warning: Skipping row {i} in '{filepath}' (insufficient columns)")
                    continue

                try:
                    x = float(values[0])
                    y = float(values[1])
                    scatter_data.append([x, y])
                except (ValueError, TypeError):
                    print(f"Warning: Skipping row {i} in '{filepath}' (non-numeric values)")
                    continue

            if len(scatter_data) == 0:
                print(f"Error: No valid data points found in CSV file '{filepath}'")
                return None

            return {
                "data": scatter_data,
                "xlabel": xlabel,
                "ylabel": ylabel
            }

        except Exception as e:
            print(f"Error parsing scatter CSV file '{filepath}': {e}")
            return None

    def _process_scatter(self, scatter):
        """
        Process scatter input (filepath string or list/array of points).

        Args:
            scatter: Either:
                - String: filepath to CSV file (returns dict with data, xlabel, ylabel)
                - List/array: [[x1, y1], [x2, y2], ...] or [(x1, y1), (x2, y2), ...]
                  (returns list format)

        Returns:
            dict: {"data": [[x1, y1], ...], "xlabel": str, "ylabel": str} if CSV
            list: [[x1, y1], ...] if list input
            None if invalid
        """
        if scatter is None:
            return None

        if isinstance(scatter, str):
            # Filepath - parse CSV
            return self._parse_scatter_csv(scatter)
        elif isinstance(scatter, (list, tuple, np.ndarray)):
            # List/array of points - validate format
            validated = []
            for i, point in enumerate(scatter):
                if isinstance(point, (list, tuple)) and len(point) >= 2:
                    try:
                        x = float(point[0])
                        y = float(point[1])
                        validated.append([x, y])
                    except (ValueError, TypeError):
                        print(f"Warning: Skipping invalid scatter point at index {i}: {point}")
                elif isinstance(point, np.ndarray) and point.shape == (2,):
                    try:
                        x = float(point[0])
                        y = float(point[1])
                        validated.append([x, y])
                    except (ValueError, TypeError):
                        print(f"Warning: Skipping invalid scatter point at index {i}: {point}")
                else:
                    print(f"Warning: Skipping invalid scatter point at index {i}: {point} (must be [x, y] pair)")

            if len(validated) == 0:
                print(f"Error: No valid scatter points found in provided data")
                return None

            return validated
        else:
            print(f"Error: scatter must be a filepath (str) or list/array of [x, y] points, got {type(scatter)}")
            return None

    def _process_bonds(self, bonds):
        """
        Process bonds input (list of bond pairs).

        Args:
            bonds: List of bond arrays, where each bond is [idx1, idx2]

        Returns:
            list: List of validated bond pairs [[idx1, idx2], ...], or None if invalid
        """
        if bonds is None:
            return None

        if not isinstance(bonds, list):
            print(f"Error: bonds must be a list of [idx1, idx2] pairs, got {type(bonds)}")
            return None

        # Validate and process bonds
        validated_bonds = []
        for bond in bonds:
            if isinstance(bond, (list, tuple)) and len(bond) >= 2:
                try:
                    idx1, idx2 = int(bond[0]), int(bond[1])
                    # Validate indices
                    if idx1 >= 0 and idx2 >= 0 and idx1 != idx2:
                        validated_bonds.append([idx1, idx2])
                    else:
                        print(f"Warning: Skipping invalid bond {bond} (indices must be non-negative and distinct)")
                except (ValueError, TypeError):
                    print(f"Warning: Skipping invalid bond {bond} (indices must be integers)")
            else:
                print(f"Warning: Skipping invalid bond format {bond} (expected [idx1, idx2])")

        return validated_bonds if validated_bonds else None

    def new_obj(self, name=None, scatter_config=None):
        """Starts a new object for subsequent 'add' calls.

        Args:
            name (str, optional): Object name; defaults to incremental index.
            scatter_config (dict, optional): Per-object scatter settings (xlabel, ylabel, xlim, ylim).
        """

        # This is a new object, reset the alignment reference
        self._coords = None
        self._center = None
        self._align = True
        self._allow_reflection = False
        self._plddts = None
        self._chains = None
        self._position_types = None
        self._pae = None
        self._scatter = None
        self._position_names = None
        self._position_residue_numbers = None
        self._position_atoms = None
        self._position_elements = None

        if name is None:
            name = f"{len(self.objects)}"
            
        # Always update the python-side data
        self._current_object_data = [] # List to hold frames
        self.objects.append({
            "name": name,
            "frames": self._current_object_data,
            "name": name,
            "frames": self._current_object_data,
            "contacts": None,  # Initialize contacts as None
            "bonds": None,     # Initialize bonds as None
            "color": None,     # Initialize color overrides as None
            "scatter_config": scatter_config  # Initialize per-object scatter configuration
        })
        
        # Send message *only if* in dynamic/hybrid mode and already displayed
        if self._is_live:
            self._send_incremental_update()
    
    def add(self, coords, plddts=None, chains=None, position_types=None, pae=None, scatter=None,
            name=None, align=True, position_names=None, residue_numbers=None, atom_types=None, contacts=None, bonds=None, color=None, scatter_config=None, allow_reflection=False, position_atoms=None, position_elements=None):
        """
        Adds a new *frame* of data to the viewer.

        Behavior depends on when .show() is called.

        Args:
            coords (np.array): Nx3 array of coordinates.
                               Also supports batched input with shape (batch, N, 3).
            plddts (np.array, optional): N-length array of pLDDT scores.
            chains (list, optional): N-length list of chain identifiers.
            position_types (list, optional): N-length list of position types ('P', 'D', 'R', 'L').
            pae (np.array, optional): LxL PAE matrix.
            scatter (list/tuple/dict, optional): Scatter plot data point for this frame.
                   Accepts: [x, y], (x, y), or {"x": x, "y": y}
            name (str, optional): Name for the object. If a different name is provided than the current object, a new object is created.
            align (bool, optional): If True, aligns subsequent frames to the first frame.
                                   Best-view rotation is ALWAYS computed for first frame. Defaults to True.
            allow_reflection (bool, optional): If True, allows mirroring during alignment (may flip chirality). Defaults to False.
            position_names (list, optional): N-length list of position names.
            residue_numbers (list, optional): N-length list of PDB residue sequence numbers (resSeq).
                                              One per position. For ligands, multiple positions may share the same residue number.
            atom_types (list, optional): Backward compatibility alias for position_types (deprecated).
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
            bonds (list, optional): List of bonds. Each bond is [atom_idx1, atom_idx2].
            color: Frame-level color. Can be:
                   - String (mode): "chain", "plddt", "rainbow", "auto", "entropy", "deepmind"
                   - String (literal): "red", "#ff0000", etc.
                   - Dict (advanced): {"frame": mode/color, "chain": {...}, "position": {...}}
        """

        # --- Step 0: Handle batched coordinates (shape: batch x N x 3) ---
        batch_size = None
        coords_batch = None
        if isinstance(coords, np.ndarray) and coords.ndim == 3:
            batch_size = coords.shape[0]
            coords_batch = coords
        elif isinstance(coords, (list, tuple)) and len(coords) > 0:
            try:
                arr = np.asarray(coords)
                if arr.ndim == 3:
                    batch_size = arr.shape[0]
                    coords_batch = arr
            except Exception:
                pass  # Fall back to single-frame handling

        if batch_size is not None and batch_size > 0:
            def _slice(feature, idx):
                if feature is None:
                    return None
                if isinstance(feature, np.ndarray):
                    if feature.ndim >= 1 and feature.shape[0] == batch_size:
                        return feature[idx]
                    return feature
                if isinstance(feature, (list, tuple)):
                    if len(feature) == batch_size:
                        return feature[idx]
                    return feature
                return feature

            # Suppress per-frame live sends and emit one incremental update at the end
            live_before = self._is_live
            if live_before:
                self._is_live = False

            for i in range(batch_size):
                self.add(
                    coords_batch[i],
                    _slice(plddts, i),
                    _slice(chains, i),
                    _slice(position_types, i),
                    pae=_slice(pae, i),
                    scatter=_slice(scatter, i),
                    name=name,
                    align=align,
                    position_names=_slice(position_names, i),
                    residue_numbers=_slice(residue_numbers, i),
                    atom_types=_slice(atom_types, i),
                    position_atoms=_slice(position_atoms, i),
                    position_elements=_slice(position_elements, i),
                    contacts=contacts,  # contacts/bonds/color assumed shared across batch
                    bonds=bonds,
                    color=color,
                    scatter_config=scatter_config,
                    allow_reflection=allow_reflection,
                )

            # Restore live flag and send all new frames in one incremental message
            if live_before:
                self._is_live = True
                self._send_incremental_update()
            return
        
        # --- Step 1: Handle object creation BEFORE touching alignment state ---
        # Doing this first avoids wiping a rotation that was just set
        # when new_obj() resets internal alignment variables.
        # If a name is provided, treat it as an object name and check if we need a new object
        create_new_object = False
        if name is not None:
            target_obj = self._find_object_by_name(name)
            if target_obj is not None:
                # Object with this name already exists, add to it
                self._current_object_data = target_obj["frames"]
            elif self.objects and self.objects[-1]["name"] != name:
                # Different name and no matching object exists, create new object
                create_new_object = True
        elif not self.objects:
            # No name provided and no objects exist, create first object
            create_new_object = True

        if create_new_object or not self.objects:
            self.new_obj(name, scatter_config=scatter_config)
        
        is_first_frame = len(self._current_object_data) == 0 if self._current_object_data is not None else False

        # --- Step 1.5: Validate and normalize scatter data ---
        if scatter is not None:
            # Accept multiple formats: [x, y], (x, y), {"x": x, "y": y}
            if isinstance(scatter, dict) and "x" in scatter and "y" in scatter:
                scatter = [scatter["x"], scatter["y"]]
            elif isinstance(scatter, (list, tuple)) and len(scatter) == 2:
                scatter = list(scatter)  # Ensure it's a list
            else:
                raise ValueError(
                    "scatter must be [x, y], (x, y), or {'x': x, 'y': y} "
                    f"for a single point per frame, got: {type(scatter)}"
                )

            # Validate values are numeric
            try:
                x, y = float(scatter[0]), float(scatter[1])
            except (ValueError, TypeError) as e:
                raise ValueError(f"scatter values must be numeric: {e}")

            scatter = [x, y]  # Normalized format

        # --- Step 2: Update Python-side alignment state ---
        self._update(coords, plddts, chains, position_types, pae, scatter,
            align=align, position_names=position_names, residue_numbers=residue_numbers, atom_types=atom_types,
            allow_reflection=allow_reflection, position_atoms=position_atoms,
            position_elements=position_elements)
        data_dict = self._get_data_dict() # This reads the full, correct data

        data_dict["name"] = None  # Don't set frame-level name; use object name instead

        # --- Step 3: Store rotation matrix and center on first frame ---
        if is_first_frame:
            # NO rotation_matrix. Nothing in Python sets one now that best_view
            # is gone - the browser chooses the angle - so writing the key would
            # only ever write None. The renderer still HAS the field, because a
            # TM-align transform lives there, but that is set in the browser and
            # never travels in this direction.
            if self._center is not None:
                self.objects[-1]["center"] = self._center.tolist()
        else:
            # In overlay mode, update center to encompass all frames
            if self.config["overlay"]["enabled"]:
                # Get all frames' coordinates and calculate combined center
                all_coords = []
                for frame in self._current_object_data:
                    all_coords.append(np.array(frame["coords"]))
                # Add current frame
                all_coords.append(self._coords)

                # Calculate center from all frames combined
                combined_coords = np.vstack(all_coords)
                updated_center = combined_coords.mean(axis=0)

                # Update stored center
                self._center = updated_center
                self.objects[-1]["center"] = updated_center.tolist()

        # --- Step 4: Save data to Python list ---
        self._current_object_data.append(data_dict)

        # --- Step 6: Process contacts if provided ---
        if contacts is not None:
            processed_contacts = self._process_contacts(contacts)
            if processed_contacts:
                self.objects[-1]["contacts"] = processed_contacts

        # --- Step 7: Process bonds if provided ---
        if bonds is not None:
            processed_bonds = self._process_bonds(bonds)
            if processed_bonds:
                self.objects[-1]["bonds"] = processed_bonds

        # --- Step 8: Process color if provided ---
        if color is not None:
            # Check if color is already normalized (has "type" and "value" keys)
            if isinstance(color, dict) and "type" in color and "value" in color:
                # Already normalized (e.g., from load_state)
                data_dict["color"] = color
            else:
                # Needs normalization (e.g., from user input)
                normalized_color = _normalize_color(color)
                if normalized_color:
                    data_dict["color"] = normalized_color

        # --- Step 8.5: Process scatter_config if provided ---
        if scatter_config is not None and isinstance(scatter_config, dict):
            validated_config = {}

            # Optional: xlabel, ylabel
            if "xlabel" in scatter_config:
                validated_config["xlabel"] = str(scatter_config["xlabel"])
            if "ylabel" in scatter_config:
                validated_config["ylabel"] = str(scatter_config["ylabel"])

            # Optional: xlim, ylim (must be [min, max] tuples)
            if "xlim" in scatter_config:
                xlim = scatter_config["xlim"]
                if isinstance(xlim, (list, tuple)) and len(xlim) == 2:
                    validated_config["xlim"] = [float(xlim[0]), float(xlim[1])]

            if "ylim" in scatter_config:
                ylim = scatter_config["ylim"]
                if isinstance(ylim, (list, tuple)) and len(ylim) == 2:
                    validated_config["ylim"] = [float(ylim[0]), float(ylim[1])]

            # Store in object (merge with existing config if present, only on first frame)
            if is_first_frame:
                existing_config = self.objects[-1].get("scatter_config") or {}
                # Merge: validated_config takes precedence over existing
                merged_config = {**existing_config, **validated_config}
                self.objects[-1]["scatter_config"] = merged_config

        # --- Step 9: Send message if in "live" mode ---
        if self._is_live:
            payload = data_dict.copy()
            if "contacts" in self.objects[-1]:
                payload["contacts"] = self.objects[-1]["contacts"]
            if "bonds" in self.objects[-1]:
                payload["bonds"] = self.objects[-1]["bonds"]

            self._send_incremental_update()

    def replace(self, coords, plddts=None, chains=None, position_types=None, pae=None, scatter=None,
                name=None, align=True, position_names=None, residue_numbers=None, atom_types=None, contacts=None, bonds=None, color=None, scatter_config=None, allow_reflection=False, position_atoms=None, position_elements=None):
        """
        Replace frame(s) for an object (streaming mode).

        Behavior depends on persistence setting:
        - persistence=False: Replaces ALL frames → always 1 frame (no history)
        - persistence=True: Replaces LAST frame only → builds up trajectory over time
        
        Optimized for real-time visualization where you want to update incrementally.
        """
        # Ensure live viewer exists
        if not self._is_live:
            self.show()

        # Default object name
        if name is None:
            name = self.objects[-1]["name"] if self.objects else "0"

        # Create/ensure object
        target_obj = self._find_object_by_name(name)
        if target_obj is None:
            self.new_obj(name, scatter_config=scatter_config)
            target_obj = self.objects[-1]
        elif scatter_config is not None and isinstance(scatter_config, dict):
            existing_cfg = target_obj.get("scatter_config") or {}
            target_obj["scatter_config"] = {**existing_cfg, **scatter_config}

        # Update internal state and build frame
        self._update(coords, plddts=plddts, chains=chains, position_types=position_types, pae=pae,
                     scatter=scatter, align=align, position_names=position_names,
                     residue_numbers=residue_numbers, atom_types=atom_types,
                     allow_reflection=allow_reflection, position_atoms=position_atoms,
                     position_elements=position_elements)

        frame_data = self._get_data_dict()
        if color is not None:
            if isinstance(color, dict) and "type" in color and "value" in color:
                frame_data["color"] = color
            else:
                normalized_color = _normalize_color(color)
                if normalized_color:
                    frame_data["color"] = normalized_color

        # Merge per-object metadata
        if contacts is not None:
            target_obj["contacts"] = self._process_contacts(contacts) or target_obj.get("contacts")
        if bonds is not None:
            target_obj["bonds"] = self._process_bonds(bonds) or target_obj.get("bonds")
        if color is not None and "color" in frame_data:
            target_obj["color"] = frame_data["color"]

        meta = {}
        if target_obj.get("contacts") is not None:
            meta["contacts"] = target_obj["contacts"]
        if target_obj.get("bonds") is not None:
            meta["bonds"] = target_obj["bonds"]
        if target_obj.get("scatter_config") is not None:
            meta["scatter_config"] = target_obj["scatter_config"]
        if target_obj.get("color") is not None:
            meta["color"] = target_obj["color"]

        # Emit replace update
        self._send_replace_update(name, frame_data, meta)

        # Update local frame storage based on persistence mode
        if self._persistence:
            # persistence=True: Replace only the last frame (build trajectory)
            if len(target_obj["frames"]) > 0:
                target_obj["frames"][-1] = frame_data
            else:
                target_obj["frames"] = [frame_data]
        else:
            # persistence=False: Replace all frames (streaming mode, no history)
            target_obj["frames"] = [frame_data]

    @staticmethod
    def _selector(name=None, chain=None, position=None):
        """
        Python's three selector arguments as ONE selector dict, in the JS
        selector's own words, so nothing has to translate it on arrival.
        `positions` is the renderer's index into what it draws, which is what
        Python's `position` has always meant.

        Returns None when nothing was named - which every caller reads as "all
        of it" or "off", and neither needs a second spelling.
        """
        if name is None and chain is None and position is None:
            return None
        sel = {}
        if name is not None:
            sel["object"] = str(name)
        if chain is not None:
            sel["chain"] = str(chain)
        if position is not None:
            if isinstance(position, int):
                sel["positions"] = [int(position)]
            elif isinstance(position, tuple) and len(position) == 2:
                sel["positions"] = list(range(int(position[0]), int(position[1])))
            elif isinstance(position, (list, range)):
                sel["positions"] = [int(p) for p in position]
            else:
                raise ValueError(
                    "position must be an int, list, range or (start, end)"
                    " tuple.")
        return sel

    def clip(self, name=None, chain=None, position=None):
        """
        Cut a slab as deep as a selection, and keep it over that selection.

        The depth is the selection's own depth along the view - there is no
        thickness to set. To cut deeper, clip to less. The renderer refits it
        every frame, so it follows the residues as the structure turns rather
        than staying at a fixed depth.

        Args:
            name (str, optional): Object to clip to. Defaults to the last added.
            chain (str, optional): Clip to a whole chain.
            position (int, list, tuple, range, optional): Position index or
                indices. A 2-tuple is a half-open range, matching set_color.

        Examples:
            view.clip(position=(40, 60))   # a slab over residues 40-59
            view.clip(chain="B")           # ...as deep as chain B
            view.clip()                    # off

        Note:
            The same slab the website's Clip panel sets and the embed's
            `v.clip(sel)` asks for - one implementation, in parts/clip.js,
            which every build already carried and none but the website could
            reach.
        """
        self._clip = self._selector(name=name, chain=chain, position=position)
        if self._is_live:
            self._send_incremental_update()

    def show_objects(self, names=None):
        """
        Draw several objects at once, or go back to one at a time.

            view.show_objects()                # every object loaded
            view.show_objects(["apo", "holo"]) # those two
            view.show_objects("apo")           # just that one
            view.show_objects([])              # nothing

        `overlay=True` shows every FRAME of one object; this shows every
        OBJECT. The camera widens once to take in whatever is newly on screen.

        The renderer has drawn several objects at once since the website grew
        its Multi button, and the embed has exposed it as `v.showObjects()`;
        Python had no way to ask for it. `py2Dmol.view(multi=True)` is the same
        thing as a flag, resolved at show() time.

        Args:
            names (str, list, optional): Object names to draw. None (the
                default) means every object that has been added.

        Note:
            "All of them" is resolved here, at the moment of the call, so what
            travels to the browser is always an explicit list.

            NAMING A SET TURNS `multi=True` OFF. The flag means "every object,
            including the ones not added yet", which is a standing instruction
            rather than a list; a caller who names a set has replaced it, and
            leaving the flag on would put the next add() back on screen behind
            their back.
        """
        if names is None:
            self._shown_objects = [o["name"] for o in self.objects]
        else:
            self.config.pop("multi", None)
            if isinstance(names, str):
                self._shown_objects = [names]
            else:
                self._shown_objects = [str(n) for n in names]
        if self._is_live:
            self._send_incremental_update()

    def orient(self, name=None, chain=None, position=None, animate=True):
        """
        Turn the structure to face the reader.

            view.orient()                   # best view of what is on screen
            view.orient(chain="B")          # ...of chain B
            view.orient(position=(40, 60))  # ...of a loop, close up

        A viewer already does this once, unprompted, when the first frame
        lands. This is for afterwards - after show_objects(), after a colour or
        a clip has made some other part of the structure the point.

        Args:
            name (str, optional): Object to frame. Defaults to the current one.
            chain (str, optional): Frame a whole chain.
            position (int, list, tuple, range, optional): Position index or
                indices. A 2-tuple is a half-open range, matching set_color.
            animate (bool): Fly there (default) or jump. A static viewer always
                jumps - it has only just appeared, and a cell that opens
                mid-flight reads as a bug rather than a flourish.

        Note:
            The search is parts/orient.js's, the one the website's Orient
            button, the notebook's Orient button and the first frame all use.
            It orients on WHAT YOU CAN SEE: a hidden residue cannot pull the
            view towards itself.
        """
        # ONE OBJECT, SELECTOR AND OPTIONS TOGETHER, because that is the shape
        # parts/orient.js's orientTo already takes - the same call the embed's
        # v.orient() makes. Nothing on either side has to unpack it.
        #
        # AN ACTION, NOT A STATE. Queued rather than stored: the same request
        # asked for twice means fly there twice, and a state that is diffed
        # against what was last sent would drop the second.
        req = dict(self._selector(name=name, chain=chain, position=position) or {})
        req["animate"] = bool(animate)
        self._orient_request = req
        if self._is_live:
            self._send_incremental_update()

    def set_sse(self, sse, name=None, chain=None, position=None):
        """
        Override the secondary structure of specific residues.

        The automatic assignment is good but not infallible, and a figure
        sometimes wants a region drawn as a helix or strand regardless. This is
        the same override the web interface's SSE control writes, so a structure
        looks the same however it was set up.

        Args:
            sse (str or None): "H" helix, "E" strand/sheet, "C" coil/loop, or
                None to clear the override and return those residues to the
                automatic assignment.
            name (str, optional): Object to apply to. Defaults to the last one added.
            chain (str, optional): Apply to every residue of this chain.
            position (int, list, tuple, range, optional): Position index/indices.
                A 2-tuple is a half-open range, matching set_color.

        Examples:
            view.set_sse("H", position=(20, 35))     # force 20-34 to helix
            view.set_sse("E", chain="B")             # all of chain B as strand
            view.set_sse(None, position=(20, 35))    # back to automatic

        Note:
            Overrides are stored by POSITION INDEX, so they belong to one
            object's numbering - the same limitation the GUI has.
        """
        if sse is not None:
            sse = str(sse).upper()
            if sse not in ("H", "E", "C"):
                raise ValueError(
                    f'Invalid sse "{sse}" - expected "H", "E", "C" or None.')

        if not self.objects:
            print("Error: No objects loaded. Cannot set secondary structure.")
            return
        target_obj = self.objects[-1] if name is None else next(
            (o for o in self.objects if o.get("name") == name), None)
        if target_obj is None:
            print(f'Error: Object "{name}" not found.')
            return

        indices = []
        if position is not None:
            if isinstance(position, int):
                indices = [int(position)]
            elif isinstance(position, tuple) and len(position) == 2:
                indices = list(range(int(position[0]), int(position[1])))
            elif isinstance(position, (list, range)):
                indices = [int(p) for p in position]
            else:
                raise ValueError(
                    "position must be an int, list, range or (start, end) tuple.")
        if chain is not None:
            frames = target_obj.get("frames") or []
            chains = frames[0].get("chains") if frames else None
            if not chains:
                print("Error: object has no chain information.")
                return
            indices += [i for i, c in enumerate(chains) if c == chain]
        if not indices:
            raise ValueError("set_sse needs position= and/or chain=.")

        # Stored on the object so it travels with it, exactly like `color`.
        current = dict(target_obj.get("sse") or {})
        for i in indices:
            if sse is None:
                current.pop(i, None)
                current.pop(str(i), None)
            else:
                current[i] = sse
        target_obj["sse"] = current or None
        # Same live-update path set_color uses, so a change lands immediately in
        # an already-displayed viewer and is simply picked up by show() otherwise.
        if self._is_live:
            self._send_incremental_update()

    def set_color(self, color, name=None, chain=None, position=None, frame=None):
        """
        Set or override color for an object, chain, position, or frame.

        Args:
            color: Color specification. Can be:
                   - String (mode): "chain", "plddt", "rainbow", "auto", "entropy", "deepmind"
                   - String (literal): "red", "#ff0000", etc.
                   - Dict: {"A": "red", "B": "blue"} when chain=True or position=True
                   - Dict (advanced): {"object": mode, "frames": {...}} (legacy format)
                   - None: CLEAR, as far as the same selector reaches - the
                     whole object, or just the chain / positions / frame named.
                     This is how set_color undoes itself, and it works on a
                     live viewer as well as before show().
            name (str, optional): Name of the object to color.
                                 If None, colors the last (most recently added) object.
            chain (str or bool, optional):
                   - str: Single chain ID to color (e.g., "A")
                   - True: Color is a dict mapping chains to colors
                   - None: No chain-specific coloring
            position (int, list, tuple, range, or bool, optional):
                   - int: Single position index to color
                   - list: List of position indices [5, 10, 15, 20]
                   - tuple: Range of positions (start, end) - e.g., (5, 15) colors 5-14
                   - range: Range object - e.g., range(5, 15) colors 5-14
                   - True: Color is a dict mapping positions to colors
                   - None: No position-specific coloring
            frame (int, optional): Specific frame index to color (0-based)

        Examples:
            # Simple: Color entire object
            viewer.set_color("red")
            viewer.set_color("plddt")

            # ...and off again
            viewer.set_color(None)                  # the whole object
            viewer.set_color(None, chain="A")       # chain A only, B untouched
            viewer.set_color(None, position=[2])    # one residue back to default

            # Chain-specific (SIMPLE!)
            viewer.set_color("red", chain="B")                    # Color chain B red
            viewer.set_color({"A": "red", "B": "blue"}, chain=True)  # Multiple chains

            # Position-specific (SIMPLE!)
            viewer.set_color("yellow", position=5)                # Color position 5 yellow
            viewer.set_color("red", position=[5, 10, 15])         # Color multiple positions
            viewer.set_color("blue", position=(10, 20))           # Color range 10-19
            viewer.set_color("green", position=range(0, 10))      # Color range 0-9
            viewer.set_color({0: "red", 10: "blue"}, position=True)  # Dict mapping

            # Frame-specific
            viewer.set_color("green", frame=0)                    # Color frame 0 green

            # Combined with a frame or an object
            viewer.set_color("red", chain="A", frame=0)           # Chain A, in frame 0 only
            viewer.set_color("green", position=(5, 15), frame=1)  # Positions 5-14 in frame 1
            viewer.set_color("yellow", position=[0, 5, 10], name="protein1")

            # chain= and position= TOGETHER are refused - they used to mean
            # the union and a selector elsewhere reads the pair as the
            # intersection. Write the two calls; they merge.

            # Legacy format still works
            viewer.set_color({"frames": {0: "red"}})
        """
        # Find the object
        if name is None:
            # Use last object
            if not self.objects:
                print("Error: No objects exist to color.")
                return
            target_obj = self.objects[-1]
            name = target_obj.get("name", "")
        else:
            target_obj = self._find_object_by_name(name)
            if target_obj is None:
                print(f"Error: Object '{name}' not found.")
                return

        # CHAIN AND POSITION TOGETHER MEANT UNION, AND EVERY OTHER SURFACE
        # NOW READS IT AS INTERSECTION.
        #
        # These are written as two independent maps and the renderer resolves
        # them by hierarchy, so set_color("red", chain="A", position=10) has
        # always coloured the WHOLE of chain A red and position 10 red - a
        # union. The docstring called that "chain B AND position 10", which
        # reads as the opposite, and py2Dmol.show's selector really does mean
        # the opposite: {chain: 'A', residues: [10]} is one residue.
        #
        # Rather than change what this does under callers who may be relying
        # on it, or leave one word meaning two things across two languages,
        # the combination is refused and the two-call spelling named. Either
        # key alone is unchanged.
        if chain is not None and position is not None:
            raise ValueError(
                "set_color(chain=..., position=...) is ambiguous and no longer"
                " accepted: it used to colour ALL of the chain and ALSO those"
                " positions, while a selector elsewhere in py2Dmol reads the"
                " same pair as an intersection. Say which you meant:\n"
                "    set_color(color, chain=...)   # then\n"
                "    set_color(color, position=...)\n"
                " for the union - the two writes merge - or pass only"
                " position=... for the residues themselves.")

        # Handle intuitive chain/position/frame parameters
        if chain is not None or position is not None:
            # Build advanced color dict from simple parameters
            advanced_color = {}

            # Handle chain coloring
            if chain is not None:
                if chain is True:
                    # Color is a dict: {"A": "red", "B": "blue"}
                    if isinstance(color, dict):
                        advanced_color["chain"] = color
                    else:
                        print("Error: When chain=True, color must be a dict like {'A': 'red', 'B': 'blue'}")
                        return
                else:
                    # chain is a string like "A"
                    advanced_color["chain"] = {str(chain): color}

            # Handle position coloring
            if position is not None:
                if position is True:
                    # Color is a dict: {0: "red", 5: "blue"}
                    if isinstance(color, dict):
                        advanced_color["position"] = color
                    else:
                        print("Error: When position=True, color must be a dict like {0: 'red', 5: 'blue'}")
                        return
                elif isinstance(position, int):
                    # Single position: position=5
                    advanced_color["position"] = {int(position): color}
                elif isinstance(position, (list, tuple, range)):
                    # Multiple positions or range
                    position_dict = {}

                    # Handle tuple as range (start, end)
                    if isinstance(position, tuple) and len(position) == 2:
                        position = range(position[0], position[1])

                    # Convert to list if range
                    if isinstance(position, range):
                        position = list(position)

                    # Build position dict
                    for pos in position:
                        position_dict[int(pos)] = color

                    advanced_color["position"] = position_dict
                else:
                    print(f"Error: position must be int, list, tuple, range, or True, got {type(position)}")
                    return

            # If frame is specified, apply to that frame only
            if frame is not None:
                frames = target_obj.get("frames", [])
                if isinstance(frame, int) and frame < len(frames):
                    if color is None:
                        _strip_advanced_color(frames[frame], advanced_color)
                        if self._is_live:
                            self._send_incremental_update()
                        return
                    # Get or create frame color dict
                    frame_color = frames[frame].get("color", {})
                    if isinstance(frame_color, dict) and frame_color.get("type") == "advanced":
                        # Merge with existing advanced color
                        existing = frame_color.get("value", {})
                        existing.update(advanced_color)
                        advanced_color = existing

                    # Normalize and store
                    normalized_color = _normalize_color(advanced_color)
                    if normalized_color:
                        frames[frame]["color"] = normalized_color
                else:
                    print(f"Error: Frame {frame} does not exist (object has {len(frames)} frames)")
                    return
            else:
                if color is None:
                    _strip_advanced_color(target_obj, advanced_color)
                    if self._is_live:
                        self._send_incremental_update()
                    return
                # Apply to object level - MERGE with existing advanced color
                normalized_color = _normalize_color(advanced_color)
                if normalized_color:
                    # Check if there's already an advanced color and merge
                    existing_color = target_obj.get("color")
                    if existing_color and existing_color.get("type") == "advanced":
                        # Merge the advanced dicts
                        existing_value = existing_color.get("value", {})
                        new_value = normalized_color.get("value", {})

                        # Merge chain dicts
                        if "chain" in new_value:
                            if "chain" not in existing_value:
                                existing_value["chain"] = {}
                            existing_value["chain"].update(new_value["chain"])

                        # Merge position dicts
                        if "position" in new_value:
                            if "position" not in existing_value:
                                existing_value["position"] = {}
                            existing_value["position"].update(new_value["position"])

                        # Update other keys
                        for key in ["object", "frame"]:
                            if key in new_value:
                                existing_value[key] = new_value[key]

                        target_obj["color"] = {"type": "advanced", "value": existing_value}
                    else:
                        target_obj["color"] = normalized_color
        else:
            # NO SELECTOR AND NO COLOUR IS "TAKE IT ALL OFF". _normalize_color
            # returns None for None, and this returned on that - so a colour
            # could be set and never unset, which also left set_color unable to
            # undo itself.
            if color is None:
                if frame is not None:
                    frames = target_obj.get("frames", [])
                    if isinstance(frame, int) and frame < len(frames):
                        frames[frame].pop("color", None)
                    else:
                        print(f"Error: Frame {frame} does not exist"
                              f" (object has {len(frames)} frames)")
                        return
                else:
                    target_obj["color"] = None
                if self._is_live:
                    self._send_incremental_update()
                return
            # Standard color normalization (backward compatible)
            normalized_color = _normalize_color(color)
            if normalized_color is None:
                return

            # Handle frame-level colors if specified in legacy format
            if normalized_color.get("type") == "advanced" and normalized_color.get("value", {}).get("frames"):
                frames_spec = normalized_color["value"]["frames"]
                frames = target_obj.get("frames", [])

                # Apply frame-level colors to each frame
                for frame_idx, frame_color_spec in frames_spec.items():
                    if isinstance(frame_idx, int) and frame_idx < len(frames):
                        # Normalize the frame color
                        frame_color = _normalize_color(frame_color_spec)
                        if frame_color:
                            frames[frame_idx]["color"] = frame_color

            # Handle specific frame parameter
            if frame is not None:
                frames = target_obj.get("frames", [])
                if isinstance(frame, int) and frame < len(frames):
                    frames[frame]["color"] = normalized_color
                else:
                    print(f"Error: Frame {frame} does not exist (object has {len(frames)} frames)")
                    return
            else:
                # Store at object level
                target_obj["color"] = normalized_color

        # Send update if in live mode.
        #
        # UNCONDITIONALLY. This used to read the resulting colour back and send
        # only if there was one, so taking a colour OFF a live viewer changed
        # Python and nothing else. _send_incremental_update decides for itself
        # whether there is anything to say, and now knows a removal is
        # something to say.
        if self._is_live:
            self._send_incremental_update()


    def add_pdb(self, filepath, chains=None, name=None, paes=None, align=True, use_biounit=True, biounit_name="1", load_ligands=True, filter_additives=True, contacts=None, scatter=None, color=None, scatter_config=None):
        """
        Loads a structure from a local PDB or CIF file and adds it to the viewer
        as a new frame (or object).

        This method does *not* call .show().

        Multi-model files are added as a single object.

        Args:
            filepath (str): Path to the PDB or CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            name (str, optional): Name for the object. If a different name is provided than the current object, a new object is created.
            paes (list, optional): List of PAE matrices to associate with each model.
            align (bool, optional): If True, aligns subsequent frames to the first frame.
                                   Best-view rotation is ALWAYS computed for first frame. Defaults to True.
            use_biounit (bool): Build the biological assembly, which is what
                                the molecule actually is - a trimer rather than
                                one protomer. On by default, as on the website.
                                A file with no assembly records is loaded as it
                                is. False for the asymmetric unit.
            biounit_name (str): The name of the assembly to generate (default "1").
            load_ligands (bool): If True, loads ligand atoms. Defaults to True.
            filter_additives (bool): If True, leaves out buffers, cryoprotectants
                and counter-ions - what the crystal was grown in rather than what
                the molecule is. See CRYSTAL_ADDITIVES. Defaults to True.
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
            scatter: Optional scatter plot data for trajectory visualization. Can be:
                    - String: filepath to CSV file (first row = header with xlabel,ylabel; subsequent rows = x,y data)
                    - List/array: [[x1, y1], [x2, y2], ...] - one point per model/frame
                    When CSV is provided, xlabel/ylabel are extracted and scatter config is updated.
            color (str, optional): Color for this structure. Can be a color mode (e.g., "chain", "plddt",
                                  "rainbow", "auto", "entropy", "deepmind") or a literal color (e.g., "red", "#ff0000").
        """

        # Normalize paes: accept a single 2D matrix in addition to a list of matrices.
        # Distinguishes by checking the depth of nesting:
        #   paes=matrix        (ndarray/list-of-lists, ndim==2) → wrap as [matrix]
        #   paes=[m1, m2, ...] (list of 2D matrices, ndim==3)   → keep as-is
        if paes is not None:
            try:
                paes_arr = np.asarray(paes, dtype=float)
                if paes_arr.ndim == 2:
                    paes = [paes_arr]
                elif paes_arr.ndim == 3:
                    paes = [paes_arr[i] for i in range(paes_arr.shape[0])]
                # ndim 1 or other: leave as-is; _update will warn when it gets there
            except (ValueError, TypeError):
                # Jagged / mixed-size matrices (different chain counts per model).
                # Try element-wise conversion so each entry becomes a 2D numpy array.
                paes = [np.asarray(m, dtype=float) for m in paes]

        # Allow passing a 4-letter PDB code directly; fetch if local file is missing
        if isinstance(filepath, str) and len(filepath) == 4 and filepath.isalnum() and not os.path.exists(filepath):
            resolved = self._get_filepath_from_pdb_id(filepath)
            if resolved:
                filepath = resolved
        
        # --- Handle object naming logic FIRST ---
        # If name is provided, check if an object with that name already exists
        create_new_object = False
        if name is not None:
            target_obj = self._find_object_by_name(name)
            if target_obj is not None:
                # Add frames to existing object
                self._current_object_data = target_obj["frames"]
            elif self.objects and self.objects[-1]["name"] != name:
                # Different object name, create new
                create_new_object = True
        elif not self.objects:
            # No name provided and no objects exist, create first object
            create_new_object = True

        if create_new_object or not self.objects:
            self.new_obj(name, scatter_config=scatter_config)
        
        current_obj_name = self.objects[-1]["name"]
        
        # --- Process contacts if provided ---
        if contacts is not None:
            processed_contacts = self._process_contacts(contacts)
            if processed_contacts is not None:
                self.objects[-1]["contacts"] = processed_contacts

        # --- Process scatter if provided ---
        scatter_data = None
        scatter_xlabel = None
        scatter_ylabel = None
        if scatter is not None:
            processed_scatter = self._process_scatter(scatter)
            if processed_scatter is not None:
                if isinstance(processed_scatter, dict):
                    # CSV format - extract data and labels
                    scatter_data = processed_scatter["data"]
                    scatter_xlabel = processed_scatter["xlabel"]
                    scatter_ylabel = processed_scatter["ylabel"]

                    # Store labels in object-specific config instead of global config
                    if self.config["scatter"]["enabled"]:
                        if self.objects[-1]["scatter_config"] is None:
                            self.objects[-1]["scatter_config"] = {}
                        self.objects[-1]["scatter_config"]["xlabel"] = scatter_xlabel
                        self.objects[-1]["scatter_config"]["ylabel"] = scatter_ylabel
                else:
                    # List format - just data
                    scatter_data = processed_scatter

        # --- Load structure ---
        try:
            structure = gemmi.read_structure(filepath)
        except Exception as e:
            print(f"Error reading structure {filepath}: {e}")
            return
            
        models_to_process = []

        # --- BIO-UNIT LOGIC ---
        if use_biounit:
            if len(structure) == 0:
                print(f"Warning: Structure {filepath} has no models. Cannot generate biounit.")
                models_to_process = [] # Will be empty
            else:
                assembly_obj = next((a for a in structure.assemblies if a.name == biounit_name), None)

                if assembly_obj:
                    try:
                        how_to_name = gemmi.HowToNameCopiedChain.AddNumber
                        # EVERY MODEL, NOT THE FIRST. This built the assembly
                        # from structure[0] alone and kept only that, so asking
                        # for a biounit on an NMR ensemble threw away every
                        # model but one - which was survivable while this was
                        # off by default and is not now that it is on.
                        built = [gemmi.make_assembly(assembly_obj, model, how_to_name)
                                 for model in structure]
                        # ...AND ONLY IF IT ACTUALLY BUILDS SOMETHING. An
                        # assembly of one copy is the asymmetric unit, which is
                        # most structures - but make_assembly still renames the
                        # chains it copies, so A becomes A1 and every contact,
                        # colour or selection naming a chain stops resolving.
                        # Nothing gained, names lost. Compared by atom count,
                        # which is what expansion changes.
                        def _atoms(m):
                            return sum(len(res) for ch in m for res in ch)
                        if built and _atoms(built[0]) > _atoms(structure[0]):
                            models_to_process = built
                        else:
                            models_to_process = [model for model in structure]
                    except Exception as e:
                        print(f"Warning: Could not generate biounit '{biounit_name}' for {filepath}. Falling back to asymmetric unit. Error: {e}")
                        models_to_process = [model for model in structure]
                elif structure.assemblies:
                    # ...named one it does not have. Worth saying; a file with
                    # NO assemblies at all is not, since that is most files and
                    # this is now the default.
                    print(f"Warning: Biounit '{biounit_name}' not found in {filepath}."
                          f" Falling back to asymmetric unit.")
                    models_to_process = [model for model in structure]
                else:
                    models_to_process = [model for model in structure]

        # --- ASYMMETRIC UNIT, when asked for with use_biounit=False ---
        else:
            models_to_process = [model for model in structure]
        
        # --- Process all selected models (either the biounit or all ASU models) ---
        if not models_to_process and len(structure) > 0:
             print(f"Warning: No models selected or generated for {filepath}, but structure was loaded.")
             # This can happen if biounit fails but structure had no models
             
        for i, model in enumerate(models_to_process):
            (coords, plddts, position_chains, position_types, position_names,
             residue_numbers, position_atoms,
             position_elements) = self._parse_model(model, chains, load_ligands=load_ligands,
                                                    filter_additives=filter_additives)

            if coords:
                coords_np = np.array(coords)
                plddts_np = np.array(plddts) if plddts else np.full(len(coords), 50.0)

                # Handle case where plddts might be empty from parse
                if len(coords_np) > 0 and len(plddts_np) != len(coords_np):
                    plddts_np = np.full(len(coords_np), 50.0)

                # Only add PAE matrix to the first model
                pae_to_add = paes[i] if paes and i < len(paes) else None

                # Extract scatter point for this model (if scatter data provided)
                scatter_to_add = scatter_data[i] if scatter_data and i < len(scatter_data) else None

                # Call add() - this will handle batch vs. live
                # Only pass name on first model to ensure all models go to same object
                model_name = name if i == 0 else None
                self.add(coords_np, plddts_np, position_chains, position_types,
                    pae=pae_to_add,
                    scatter=scatter_to_add,
                    name=model_name,
                    align=align,
                    position_names=position_names,
                    residue_numbers=residue_numbers,
                    # ...and only where a ligand was loaded: an all-blank pair
                    # of arrays is a per-frame cost for nothing
                    position_atoms=position_atoms if any(position_atoms) else None,
                    position_elements=position_elements if any(position_atoms) else None,
                    color=color if i == 0 else None) # Only add color to first frame/model call


    @staticmethod
    def _crowded_ions(model):
        """Single-atom het residues this model has more than CROWD_ION_COUNT of.

        A ribosome's magnesiums, and nothing that is the subject of a picture:
        see CROWD_ION_COUNT.
        """
        counts = {}
        for chain in model:
            for residue in chain:
                if len(residue) != 1:
                    counts[residue.name] = -1        # not monoatomic, never crowd
                elif counts.get(residue.name, 0) >= 0:
                    counts[residue.name] = counts.get(residue.name, 0) + 1
        return {k for k, v in counts.items() if v > CROWD_ION_COUNT}

    def _parse_model(self, model, chains_filter, load_ligands=True, filter_additives=True):
        """
        Helper function to parse a gemmi.Model object.

        Returns:
            tuple: (coords, plddts, position_chains, position_types,
                    position_names, residue_numbers, position_atoms,
                    position_elements)
            - residue_numbers: List of PDB residue sequence numbers (one per position)
            - position_atoms/position_elements: a ligand atom's own name and
              element; blank at every position that stands for a whole residue
                              For ligands: multiple positions share the same residue number
        """
        coords = []
        plddts = []
        # THE IONS THIS MODEL HAS HUNDREDS OF, worked out once before the walk
        # below rather than per residue - see _crowded_ions.
        crowded = self._crowded_ions(model) if filter_additives else set()
        position_chains = []
        position_types = []
        position_names = []
        residue_numbers = []
        # ONE ENTRY PER POSITION, blank for everything that is not a ligand
        # atom: a backbone position stands for a whole residue, so "the atom"
        # there is a fact about the model rather than about the file.
        position_atoms = []
        position_elements = []
        for chain in model:
            if chains_filter is None or chain.name in chains_filter:
                for residue in chain:
                    if residue.name == 'HOH':
                        continue

                    residue_info = gemmi.find_tabulated_residue(residue.name)
                    is_protein = residue_info.is_amino_acid()
                    is_nucleic = residue_info.is_nucleic_acid()
                    # Modified nucleotides (YYG, 5MC, OMG, ...) are tabulated but
                    # NOT flagged nucleic by gemmi, so they were dropped from the
                    # chain entirely - 1EHZ lost 3 residues and the backbone broke
                    # at each one (the gap then read as an over-length bond rather
                    # than as the missing residue it was). Detect the ribose
                    # structurally instead: C4' plus O4' plus C1' is a nucleotide
                    # whatever the residue is called.
                    if not is_nucleic and not is_protein:
                        has = lambda *names: any(nm in residue for nm in names)
                        if has("C4'", "C4*") and has("O4'", "O4*") and has("C1'", "C1*"):
                            is_nucleic = True

                    if is_protein:
                        if 'CA' in residue:
                            atom = residue['CA'][0]
                            coords.append(atom.pos.tolist())
                            plddts.append(atom.b_iso)
                            position_chains.append(chain.name)
                            position_types.append('P')
                            position_names.append(residue.name)
                            residue_numbers.append(residue.seqid.num)
                            position_atoms.append('')
                            position_elements.append('')

                    elif is_nucleic:
                        c4_atom = None
                        if "C4'" in residue:
                            c4_atom = residue["C4'"][0]
                        elif "C4*" in residue:
                            c4_atom = residue["C4*"][0]
                        
                        if c4_atom:
                            coords.append(c4_atom.pos.tolist())
                            plddts.append(c4_atom.b_iso)
                            position_chains.append(chain.name)
                            rna_bases = ['A', 'C','G', 'U', 'RA', 'RC', 'RG', 'RU']
                            dna_bases = ['DA', 'DC', 'DG', 'DT', 'T']
                            if residue.name in rna_bases or residue.name.startswith('R'):
                                position_types.append('R')
                            elif residue.name in dna_bases or residue.name.startswith('D'):
                                position_types.append('D')
                            elif "O2'" in residue or "O2*" in residue:
                                # modified residue: the 2'-OH is what separates
                                # ribose from deoxyribose, and it is present
                                # regardless of how the base was modified
                                position_types.append('R')
                            elif "C2'" in residue or "C2*" in residue:
                                position_types.append('D')
                            else:
                                position_types.append('R') # Default to RNA
                            position_names.append(residue.name)
                            residue_numbers.append(residue.seqid.num)
                            position_atoms.append('')
                            position_elements.append('')

                    else:
                        # Ligand: use all heavy atoms - unless it is something the
                        # crystal was grown in rather than part of the molecule.
                        # See CRYSTAL_ADDITIVES.
                        if filter_additives and (residue.name in CRYSTAL_ADDITIVES
                                                 or residue.name in crowded):
                            continue
                        if load_ligands:
                            for atom in residue:
                                if atom.element.name != 'H':
                                    coords.append(atom.pos.tolist())
                                    plddts.append(atom.b_iso)
                                    position_chains.append(chain.name)
                                    position_types.append('L')
                                    position_names.append(residue.name)
                                    residue_numbers.append(residue.seqid.num)
                                    # gemmi reads the element from the file's
                                    # own column, which is the only place a
                                    # two-letter element can be read at all -
                                    # a ligand atom called CL is chlorine in
                                    # one file and a carbon in another.
                                    position_atoms.append(atom.name)
                                    position_elements.append(atom.element.name.upper())
                
        return (coords, plddts, position_chains, position_types,
                position_names, residue_numbers, position_atoms, position_elements)

    def add_contacts(self, contacts, name=None):
        """
        Add contact restraints to an object.
        
        Args:
            contacts: Either a filepath (str) to a .cst file, or a list of contact arrays.
                     Contact arrays can be:
                     - Position indices: [idx1, idx2, weight, color?]
                     - Chain+residue: [chain1, res1, chain2, res2, weight, color?]
            name (str, optional): Name of the object to add contacts to.
                                 If None, adds to the last (most recently added) object.
        
        Examples:
            # Load from file
            viewer.add_contacts("contacts.cst")
            viewer.add_contacts("contacts.cst", name="protein1")
            
            # Set programmatically
            contacts = [[10, 50, 1.0], ["A", 10, "B", 50, 0.5, {"r": 255, "g": 0, "b": 0}]]
            viewer.add_contacts(contacts)

            # Take them all off again - this REPLACES rather than appends, so
            # passing nothing is how you say "none"
            viewer.add_contacts([])
        """
        # AN EMPTY LIST CLEARS. add_contacts has always REPLACED rather than
        # appended, so passing nothing is the natural way to say "none" - and
        # without it a contact could be drawn and never undrawn, from Python,
        # by any spelling. It was refused with a warning instead.
        if contacts is None or (isinstance(contacts, (list, tuple)) and not contacts):
            processed_contacts = None
        else:
            processed_contacts = self._process_contacts(contacts)
            if processed_contacts is None:
                print("Warning: No valid contacts to add.")
                return
        
        # Find target object
        if name is None:
            # Add to last object
            if not self.objects:
                print("Error: No objects available. Add a structure first.")
                return
            target_obj = self.objects[-1]
        else:
            # Find object by name
            target_obj = None
            for obj in self.objects:
                if obj.get("name") == name:
                    target_obj = obj
                    break
            if target_obj is None:
                print(f"Error: Object '{name}' not found.")
                return
        
        # Store contacts (replace existing)
        target_obj["contacts"] = processed_contacts

        # Send update if in live mode
        if self._is_live:
            self._send_incremental_update()

    def add_bonds(self, bonds, name=None):
        """
        Define explicit bonds between atoms.

        If provided, these bonds replace the default distance-based bonding (2.0 Å cutoff).
        This is useful for ligands or other structures where the automatic bonding is inaccurate.

        Args:
            bonds: A list of bond definitions. Each bond is a list/tuple of:
                   [idx1, idx2]  - Position indices (0-based) of atoms to connect

                   Example: [[0, 1], [1, 2], [2, 3]]  # Connect atoms 0-1, 1-2, 2-3
            name (str, optional): Name of the object to add bonds to.
                                 If None, adds to the last (most recently added) object.

        Examples:
            # Define explicit bonds
            viewer.add_pdb('structure.pdb')
            bonds = [
                [0, 1],   # Connect atom 0 to atom 1
                [1, 2],   # Connect atom 1 to atom 2
                [2, 3],   # Connect atom 2 to atom 3
            ]
            viewer.add_bonds(bonds)
            viewer.show()

            # ...and back to the automatic 2.0 A distance bonding these replace
            viewer.add_bonds([])
        """
        # AN EMPTY LIST CLEARS, and here it restores the automatic distance
        # bonding these replace - see add_contacts for why nothing meant
        # nothing before.
        clearing = bonds is None or (isinstance(bonds, (list, tuple)) and not bonds)

        # Validate bond format (expects list/array format [[idx1, idx2], ...])
        processed_bonds = []
        if not clearing:
            for bond in bonds:
                if isinstance(bond, (list, tuple)) and len(bond) >= 2:
                    idx1, idx2 = bond[0], bond[1]
                    if isinstance(idx1, int) and isinstance(idx2, int) and idx1 >= 0 and idx2 >= 0:
                        processed_bonds.append([idx1, idx2])

            if not processed_bonds:
                print("Warning: No valid bonds could be processed.")
                return

        # Find target object
        if name is None:
            # Add to last object
            if not self.objects:
                print("Error: No objects available. Add a structure first.")
                return
            target_obj = self.objects[-1]
        else:
            # Find object by name
            target_obj = None
            for obj in self.objects:
                if obj.get("name") == name:
                    target_obj = obj
                    break
            if target_obj is None:
                print(f"Error: Object '{name}' not found.")
                return

        # Store bonds (replace existing); None rather than [] when clearing,
        # so it reads as "unset" everywhere downstream like every other field.
        target_obj["bonds"] = processed_bonds or None

        # Send update if in live mode
        if self._is_live:
            self._send_incremental_update()

    def _get_filepath_from_pdb_id(self, pdb_id):
        """
        Checks if a PDB ID is a file. If not, and it's a 4-char code, downloads it.
        Returns the filepath.
        """
        # Check if it's a filepath that already exists
        if os.path.exists(pdb_id):
            return pdb_id

        # Check if it's a 4-character PDB code
        if len(pdb_id) == 4 and pdb_id.isalnum():
            # Try to download the CIF file from RCSB
            pdb_code = pdb_id.upper()
            url = f"https://files.rcsb.org/download/{pdb_code}.cif"
            filepath = f"{pdb_code}.cif"
            
            # Download only if it doesn't already exist
            if not os.path.exists(filepath):
                try:
                    # print(f"Downloading {pdb_code} from RCSB...")
                    urllib.request.urlretrieve(url, filepath)
                    # print(f"Saved to {filepath}")
                    return filepath
                except urllib.error.HTTPError:
                    print(f"Error: Could not download PDB ID {pdb_code} from RCSB (URL: {url}).")
                    return None
                except Exception as e:
                    print(f"An error occurred during download: {e}")
                    return None
            else:
                # File already exists, just use it
                return filepath
        
        # If it's not an existing file and not a 4-char code, it's invalid
        print(f"Error: File or PDB ID '{pdb_id}' not found.")
        return None

    def _parse_pae_json(self, pae_filepath):
        """
        Parses PAE JSON file with support for multiple formats (matching JavaScript extractPaeFromJSON).
        
        Args:
            pae_filepath (str): Path to PAE JSON file
            
        Returns:
            np.array or None: PAE matrix as numpy array, or None if parsing fails
        """
        try:
            with open(pae_filepath, 'r') as f:
                pae_data = json.load(f)
            
            # Try different PAE JSON formats (matching JavaScript extractPaeFromJSON)
            pae_matrix = None
            
            # Format 1: Direct pae array
            if isinstance(pae_data, dict) and 'pae' in pae_data and isinstance(pae_data['pae'], list):
                pae_matrix = np.array(pae_data['pae'])
            
            # Format 2: Direct predicted_aligned_error array
            elif isinstance(pae_data, dict) and 'predicted_aligned_error' in pae_data:
                if isinstance(pae_data['predicted_aligned_error'], list):
                    pae_matrix = np.array(pae_data['predicted_aligned_error'])
                # Format 3: Nested structure (AlphaFold3)
                elif isinstance(pae_data['predicted_aligned_error'], dict):
                    nested = pae_data['predicted_aligned_error']
                    if 'pae' in nested and isinstance(nested['pae'], list):
                        pae_matrix = np.array(nested['pae'])
                    elif 'predicted_aligned_error' in nested and isinstance(nested['predicted_aligned_error'], list):
                        pae_matrix = np.array(nested['predicted_aligned_error'])
            
            # Format 4: List containing dict with predicted_aligned_error (AlphaFold DB format)
            elif isinstance(pae_data, list) and len(pae_data) > 0:
                if isinstance(pae_data[0], dict) and 'predicted_aligned_error' in pae_data[0]:
                    pae_matrix = np.array(pae_data[0]['predicted_aligned_error'])
            
            if pae_matrix is not None:
                return pae_matrix
            else:
                print(f"Warning: PAE JSON file '{pae_filepath}' has an unexpected format.")
                return None
                
        except Exception as e:
            print(f"Error parsing PAE JSON '{pae_filepath}': {e}")
            return None

    def _get_filepath_from_afdb_id(self, uniprot_id, download_pae=False):
        """
        Downloads a structure from AlphaFold DB given a UniProt ID.
        Returns the (structure_filepath, pae_filepath)
        """
        uniprot_code = uniprot_id.upper()
        
        # 1. Download Structure
        struct_url = f"https://alphafold.ebi.ac.uk/files/AF-{uniprot_code}-F1-model_v6.cif"
        struct_filepath = f"AF-{uniprot_code}.cif" 

        if not os.path.exists(struct_filepath):
            try:
                urllib.request.urlretrieve(struct_url, struct_filepath)
            except urllib.error.HTTPError:
                print(f"Error: Could not download UniProt ID {uniprot_code} from AlphaFold DB (URL: {struct_url}).")
                return None, None
            except Exception as e:
                print(f"An error occurred during structure download: {e}")
                return None, None
        
        # 2. Download PAE (if requested)
        pae_filepath = None
        if download_pae:
            pae_url = f"https://alphafold.ebi.ac.uk/files/AF-{uniprot_code}-F1-predicted_aligned_error_v6.json"
            pae_filepath = f"AF-{uniprot_code}-pae.json"
            
            if not os.path.exists(pae_filepath):
                try:
                    urllib.request.urlretrieve(pae_url, pae_filepath)
                except urllib.error.HTTPError:
                    print(f"Warning: Could not download PAE data for {uniprot_code}. (URL: {pae_url})")
                    pae_filepath = None
                except Exception as e:
                    print(f"An error occurred during PAE download: {e}")
                    pae_filepath = None
                    
        return struct_filepath, pae_filepath


    def from_pdb(self, pdb_id, chains=None, name=None, align=True, use_biounit=True, biounit_name="1", load_ligands=True, filter_additives=True, contacts=None, scatter=None, color=None, ignore_ligands=None, show=None, scatter_config=None):
        """
        Loads a structure from a PDB code (downloads from RCSB if not found locally)
        and adds it to the viewer.

        Each call creates a new object (separate structure), but all structures appear
        in the same viewer window. The viewer is displayed on the first call (unless show=False).

        Args:
            pdb_id (str): 4-character PDB code or a path to a local PDB/CIF file.
            chains (list, optional): Specific chains to load. Defaults to all.
            name (str, optional): Name for the object. If not provided, uses the PDB ID.
                                  A different name will automatically create a new object.
            align (bool, optional): If True, aligns coordinates to best view. Defaults to True.
            use_biounit (bool): Build the biological assembly, which is what
                                the molecule actually is - a trimer rather than
                                one protomer. On by default, as on the website.
                                A file with no assembly records is loaded as it
                                is. False for the asymmetric unit.
            biounit_name (str): The name of the assembly to generate (default "1").
            load_ligands (bool): If True, loads ligand atoms. Defaults to True.
            filter_additives (bool): If True, leaves out buffers, cryoprotectants
                and counter-ions - what the crystal was grown in rather than what
                the molecule is. See CRYSTAL_ADDITIVES. Defaults to True.
            contacts: Optional contact restraints. Can be a filepath (str) or list of contact arrays.
            scatter: Optional scatter plot data for trajectory visualization. Can be:
                    - String: filepath to CSV file (first row = header with xlabel,ylabel; subsequent rows = x,y data)
                    - List/array: [[x1, y1], [x2, y2], ...] - one point per model/frame
            color (str, optional): Color for this structure. Can be a color mode (e.g., "chain", "plddt",
                                  "rainbow", "auto", "entropy", "deepmind") or a literal color (e.g., "red", "#ff0000").
            ignore_ligands (bool, optional): Deprecated. If provided, overrides load_ligands.
                                            If True, skips loading ligand atoms (load_ligands=False).
            show (bool, optional): If True, automatically displays the viewer after loading (default behavior).
                                  If False, suppresses auto-display (useful when viewer is managed by Grid).
                                  If None (default), auto-shows unless viewer is in live mode.
        """
        filepath = self._get_filepath_from_pdb_id(pdb_id)

        # Auto-generate name from PDB ID if not provided
        if name is None and len(pdb_id) == 4 and pdb_id.isalnum():
            name = pdb_id.upper()

        # Backward compatibility for ignore_ligands
        if ignore_ligands is not None:
            load_ligands = not ignore_ligands

        if filepath:
            # Delegate to add_pdb for consistent handling
            self.add_pdb(
                filepath,
                chains=chains,
                name=name,
                paes=None,
                align=align,
                use_biounit=use_biounit,
                biounit_name=biounit_name,
                load_ligands=load_ligands,
                filter_additives=filter_additives,
                contacts=contacts,
                scatter=scatter,
                color=color,
                scatter_config=scatter_config,
            )

            # Determine whether to auto-show (mirror add_pdb + show sequence)
            if show is True or (show is None and not self._is_live
                                and not self._managed):
                self.show()
        else:
            print(f"Could not load structure for '{pdb_id}'.")

    def from_afdb(self, uniprot_id, chains=None, name=None, align=True, use_biounit=True, biounit_name="1", load_ligands=True, scatter=None, color=None, show=None):
        """
        Loads a structure from an AlphaFold DB UniProt ID (downloads from EBI)
        and adds it to the viewer.

        Each call creates a new object (separate structure), but all structures appear
        in the same viewer window. The viewer is displayed on the first call (unless show=False).

        If `pae=True` was set in the `view()` constructor, this will also
        download and display the PAE matrix.

        Args:
            uniprot_id (str): UniProt accession code (e.g., "P0A8I3").
            chains (list, optional): Specific chains to load. Defaults to all.
            name (str, optional): Name for the object. If not provided, uses the UniProt ID.
                                  A different name will automatically create a new object.
            align (bool, optional): If True, aligns coordinates to best view. Defaults to True.
            use_biounit (bool): Build the biological assembly, which is what
                                the molecule actually is - a trimer rather than
                                one protomer. On by default, as on the website.
                                A file with no assembly records is loaded as it
                                is. False for the asymmetric unit.
            biounit_name (str): The name of the assembly to generate (default "1").
            load_ligands (bool): If True, loads ligand atoms. Defaults to True.
            filter_additives (bool): If True, leaves out buffers, cryoprotectants
                and counter-ions - what the crystal was grown in rather than what
                the molecule is. See CRYSTAL_ADDITIVES. Defaults to True.
            scatter: Optional scatter plot data for trajectory visualization. Can be:
                    - String: filepath to CSV file (first row = header with xlabel,ylabel; subsequent rows = x,y data)
                    - List/array: [[x1, y1], [x2, y2], ...] - one point per model/frame
            color (str, optional): Color for this structure. Can be a literal color (e.g., "red", "#ff0000") or a color mode
                                  (e.g., "chain", "plddt", "rainbow", "auto", "entropy", "deepmind").
            show (bool, optional): If True, automatically displays the viewer after loading (default behavior).
                                  If False, suppresses auto-display (useful when viewer is managed by Grid).
                                  If None (default), auto-shows unless viewer is in live mode.
        """

        # Auto-generate name from UniProt ID if not provided
        if name is None:
            name = uniprot_id.upper()

        # --- Download structure and (maybe) PAE ---
        struct_filepath, pae_filepath = self._get_filepath_from_afdb_id(uniprot_id, download_pae=self.config["pae"]["enabled"])

        if not struct_filepath:
             print(f"Could not load structure for '{uniprot_id}'.")
             return

        # --- Parse PAE if downloaded ---
        pae_matrix = None
        if pae_filepath:
            pae_matrix = self._parse_pae_json(pae_filepath)

        # --- Add PDB (and PAE if loaded) ---
        if struct_filepath:
            self.add_pdb(struct_filepath, chains=chains,
                name=name, paes=[pae_matrix] if pae_matrix is not None else None, align=align,
                use_biounit=use_biounit, biounit_name=biounit_name,
                load_ligands=load_ligands, scatter=scatter, color=color)

            # Determine whether to auto-show
            # show=True: always show
            # show=False: never show
            # show=None (default): show if not in live mode
            if show is True:
                self.show()
            elif show is None and not self._is_live and not self._managed:
                self.show()
        

    def _mark_published(self):
        """
        THE VIEWER IS NOW ON THE PAGE: everything it already holds has been
        delivered, and anything added from here is an incremental update.

        Two callers, and they are the two ways a viewer reaches a notebook:
        show()'s static branch, and Grid.show(), which lays several out
        together and emits their HTML itself. The grid used to say this by
        setting _is_live BEFORE collecting - which also made every add()
        during collection emit an update to a page that did not exist yet.
        Four viewers came to twenty-seven of them, twenty from one NMR
        ensemble, each an empty output element in the notebook.
        """
        self._managed = False
        self._is_live = True
        # Mark existing frames/metadata as already sent so later incremental
        # updates (e.g., add_contacts) don't resend full frames.
        self._sent_frame_count = {}
        self._sent_metadata = {}
        for obj in self.objects:
            obj_name = obj.get("name", "")
            if not obj_name:
                continue
            self._sent_frame_count[obj_name] = len(obj.get("frames", []))
            current_metadata = {}
            if obj.get("color") is not None:
                current_metadata["color"] = obj["color"]
            if obj.get("contacts") is not None:
                current_metadata["contacts"] = obj["contacts"]
            if obj.get("bonds") is not None:
                current_metadata["bonds"] = obj["bonds"]
            if obj.get("rotation_matrix") is not None:
                current_metadata["rotation_matrix"] = obj["rotation_matrix"]
            if obj.get("center") is not None:
                current_metadata["center"] = obj["center"]
            if current_metadata:
                self._sent_metadata[obj_name] = copy.deepcopy(current_metadata)

    def show(self):
        """
        Displays the viewer.

        - If called *before* adding data, it creates an empty "live" viewer
          that will be dynamically updated.

        - If called *after* adding data, it creates a final, 100% static
          viewer that is persistent in the notebook.

        - If already displayed (live), subsequent calls are ignored.
        """

        if self._is_live:
            return  # Already displayed, don't create a duplicate

        # Check if we have any objects with actual frames
        has_frames = any(obj.get("frames") for obj in self.objects)
        
        if not has_frames:
            # --- "Go Live" Mode ---
            # .show() was called *before* .add() (or objects exist but are empty)
            # Pass objects to populate initial config (like scatter_config) even without frames
            html_to_display = self._display_viewer(static_data=self.objects if self.objects else None)
            self._display_html(html_to_display)
            self._is_live = True
        else:
            # --- "Publish Static" Mode ---
            # .show() was called *after* .add()
            # We set pure_static=False to enable hybrid mode (static + live)
            html_to_display = self._display_viewer(static_data=self.objects)
            self._display_html(html_to_display)
            self._mark_published()

        # Reset data display ID for new viewer
        self._data_display_id = None

        # Note: Mailbox handle (for persistence=False) is created lazily on first add/replace

    def _detect_redundant_fields(self, frames):
        """
        Detect fields that are identical across all frames.
        Returns dict of field_name: value for redundant fields.
        """
        if not frames or len(frames) == 0:
            return {}
        
        redundant = {}
        for field in ['chains', 'position_types', 'bonds']:
            # Skip if not present in any frame
            if not any(field in frame and frame[field] is not None for frame in frames):
                continue
            
            # Get first non-None value
            first_value = None
            for frame in frames:
                if field in frame and frame[field] is not None:
                    first_value = frame[field]
                    break
            
            if first_value is None:
                continue
            
            # Check if all frames have same value (or are missing/None)
            if all(
                (field in frame and frame[field] == first_value) or 
                (field not in frame or frame[field] is None)
                for frame in frames
            ):
                redundant[field] = first_value
        
        return redundant

    def save_state(self, filepath):
        """
        Saves the current viewer state (objects, frames, viewer settings, selection) to a JSON file.

        Args:
            filepath (str): Path to save the state file.
        """
        # Create directory if it doesn't exist
        try:
            dir_path = os.path.dirname(filepath) if os.path.dirname(filepath) else '.'
            os.makedirs(dir_path, exist_ok=True)
        except OSError as e:
            print(f"Error: Could not create directory for state file: {e}")
            return
        
        # Collect all objects
        objects = []
        for obj in self.objects:
            frames = []
            for frame in obj["frames"]:
                frame_data = {}

                # Round coordinates to 2 decimal places
                frame_data["coords"] = [[round(c, 2) for c in coord] for coord in frame["coords"]]

                # Round pLDDT to integers
                if "plddts" in frame:
                    frame_data["plddts"] = [round(p) for p in frame["plddts"]]

                # Copy other fields
                for key in ["chains", "position_types", "position_names", "residue_numbers",
                            "position_atoms", "position_elements", "bonds", "scatter", "color", "pae"]:
                    if key in frame:
                        frame_data[key] = frame[key]

                frames.append(frame_data)
            
            # Detect redundant fields (same across all frames)
            redundant_fields = self._detect_redundant_fields(frames)
            
            # Remove redundant fields from frames (only if identical)
            for frame in frames:
                for field in redundant_fields:
                    if field in frame and frame[field] == redundant_fields[field]:
                        del frame[field]
            
            # Create object with redundant fields at object level
            obj_to_serialize = {
                "name": obj["name"],
                "frames": frames
            }
            # Add redundant fields to object level (only if detected)
            obj_to_serialize.update(redundant_fields)

            # Add object-level data if present
            if "contacts" in obj and obj["contacts"]:
                obj_to_serialize["contacts"] = obj["contacts"]
            if "bonds" in obj and obj["bonds"]:
                obj_to_serialize["bonds"] = obj["bonds"]
            # Object-level colour overrides (set_color with chain=/position=).
            # load_state has always read this back; the save side simply never
            # wrote it, so a manually coloured structure came back plain.
            if obj.get("color") is not None:
                obj_to_serialize["color"] = obj["color"]
            # ... and secondary-structure overrides (set_ss), same reasoning.
            if obj.get("sse"):
                obj_to_serialize["sse"] = {
                    str(k): v for k, v in obj["sse"].items()
                }
            # Add scatter_config and scatter_metadata if present
            if "scatter_config" in obj and obj["scatter_config"] is not None:
                obj_to_serialize["scatter_config"] = obj["scatter_config"]
            if "scatter_metadata" in obj and obj["scatter_metadata"] is not None:
                obj_to_serialize["scatter_metadata"] = obj["scatter_metadata"]
            objects.append(obj_to_serialize)
        
        # Create state object with nested config.
        #
        # THE ENVELOPE MATCHES THE WEB APP'S. Both sides wrote "version": "2.0"
        # while disagreeing about what was in it - this side wrote
        # `current_object`, the web wrote `viewer_state` and
        # `selections_by_object`, and neither read the other's - so a file saved
        # in one opened in the other with its settings quietly reset. The keys
        # are the union now, and each side reads what it understands.
        #
        # `viewer_state` is derived from the config rather than held separately:
        # this side has no camera of its own to record (no rotation or zoom in
        # DEFAULT_CONFIG), so what it can supply is the render settings, and
        # that is what stops a Python-saved session opening as a grey tube.
        rendering = self.config.get("rendering", {})
        color_cfg = self.config.get("color", {})
        viewer_state = {
            "current_object_name": self.objects[-1]["name"] if self.objects else None,
            "color_mode": color_cfg.get("mode"),
            "colorblind_mode": color_cfg.get("colorblind"),
        }
        for cfg_key, state_key in _RENDER_STATE_KEYS:
            viewer_state[state_key] = rendering.get(cfg_key)
        state_data = {
            "version": "2.0",  # Version for nested config format
            "config": self.config,  # Save nested config directly
            "objects": objects,
            "current_object": self.objects[-1]["name"] if self.objects else None,
            "viewer_state": viewer_state,
        }
        
        # Write to file
        with open(filepath, 'w') as f:
            json.dump(state_data, f, indent=2)
        
        print(f"State saved to {filepath}")

    def load_state(self, filepath):
        """
        Loads a saved viewer state from a JSON file.

        Args:
            filepath (str): Path to the state file to load.
        """
        try:
            with open(filepath, 'r') as f:
                state_data = json.load(f)
        except FileNotFoundError:
            print(f"Error: State file '{filepath}' not found.")
            return
        except json.JSONDecodeError:
            print(f"Error: State file '{filepath}' is not valid JSON.")
            return
        
        # Clear existing objects
        self.objects = []
        self._current_object_data = None
        
        # Restore objects
        if "objects" in state_data and isinstance(state_data["objects"], list):
            for obj_data in state_data["objects"]:
                if not obj_data.get("name") or not obj_data.get("frames"):
                    print(f"Warning: Skipping invalid object in state file: {obj_data}")
                    continue
                
                # Get object-level defaults (may be None)
                obj_chains = obj_data.get("chains")
                obj_position_types = obj_data.get("position_types")
                
                self.new_obj(obj_data["name"], scatter_config=obj_data.get("scatter_config"))
                
                for frame_data in obj_data["frames"]:
                    # Convert frame data to numpy arrays
                    coords = np.array(frame_data.get("coords", []))

                    if len(coords) == 0:
                        print(f"Warning: Skipping frame with no coordinates")
                        continue

                    # Frame-level data takes precedence over object-level
                    chains = frame_data.get("chains") if "chains" in frame_data else obj_chains
                    position_types = frame_data.get("position_types") if "position_types" in frame_data else obj_position_types
                    plddts = np.array(frame_data["plddts"]) if "plddts" in frame_data else None
                    position_names = frame_data.get("position_names")
                    residue_numbers = frame_data.get("residue_numbers")
                    position_atoms = frame_data.get("position_atoms")
                    position_elements = frame_data.get("position_elements")
                    pae = np.array(frame_data["pae"]) if "pae" in frame_data else None
                    scatter = frame_data.get("scatter")  # Load scatter data [x, y]
                    bonds = frame_data.get("bonds")
                    color = frame_data.get("color")  # Extract frame-level color if present

                    # add() will apply defaults for None values
                    self.add(
                        coords,
                        plddts if plddts is not None and len(plddts) > 0 else None,
                        chains,
                        position_types,
                        pae=pae,
                        scatter=scatter,
                        name=None,
                        align=False,  # Don't re-align loaded data
                        position_names=position_names,
                        residue_numbers=residue_numbers,
                        position_atoms=position_atoms,
                        position_elements=position_elements,
                        bonds=bonds,
                        color=color  # Pass frame-level color to add()
                    )
                
                # Restore object-level data
                if "contacts" in obj_data:
                    self.objects[-1]["contacts"] = obj_data["contacts"]
                if "bonds" in obj_data:
                    self.objects[-1]["bonds"] = obj_data["bonds"]
                if "color" in obj_data:
                    self.objects[-1]["color"] = obj_data["color"]
                if obj_data.get("sse"):
                    # keys come back from JSON as strings; set_ss works in ints
                    self.objects[-1]["sse"] = {
                        int(k): v for k, v in obj_data["sse"].items()
                    }
                # Restore scatter config (prefer scatter_config, but accept legacy scatter_metadata)
                scatter_cfg = obj_data.get("scatter_config")
                if not scatter_cfg and obj_data.get("scatter_metadata"):
                    scatter_cfg = obj_data["scatter_metadata"]
                if scatter_cfg:
                    self.objects[-1]["scatter_config"] = scatter_cfg
        
        # Restore config (v2.0 nested format only)
        if "config" in state_data:
            self.config = state_data["config"]
            # ...AND WHAT BELONGS TO THE VIEWER, back into the fields the
            # config is WRITTEN FROM. _display_viewer rebuilds `clip` and
            # `shown_objects` out of _clip and _shown_objects on the way out
            # and pops whatever it does not find there - so a saved slab or a
            # saved set of objects was restored into the config here and
            # thrown away again at the next show(). `multi` needs nothing: it
            # is read from the config and re-resolved against the objects that
            # exist, which is what a standing instruction should do.
            self._clip = self.config.get("clip")
            self._shown_objects = self.config.get("shown_objects")
            # Normalise the style, which used to name three things. A state
            # written when "richardson" was a style would otherwise be read as
            # "tube" (the only non-cartoon value) and render as the wrong thing
            # silently. Not a compatibility layer - just three lines so a stale
            # file fails visibly or correctly rather than quietly.
            rend = self.config.setdefault("rendering", {})
            if rend.get("style") == "richardson":
                rend["style"] = "cartoon"
                rend.setdefault("preset", "richardson")
            elif rend.get("style") == "ribbon":
                rend["style"] = "tube"

        # A file written by the WEB APP carries its live settings in
        # `viewer_state`. It also syncs them into `config` before saving, so
        # these normally agree - but a file written by an older build, or by
        # anything that fills one and not the other, would come back on the
        # values the session STARTED with rather than the ones it was showing.
        # viewer_state is the live record, so it wins where it says anything.
        vs = state_data.get("viewer_state")
        if isinstance(vs, dict):
            rend = self.config.setdefault("rendering", {})
            color_cfg = self.config.setdefault("color", {})
            for cfg_key, state_key in _RENDER_STATE_KEYS:
                if vs.get(state_key) is not None:
                    rend[cfg_key] = vs[state_key]
            if vs.get("color_mode") is not None:
                color_cfg["mode"] = vs["color_mode"]
            if vs.get("colorblind_mode") is not None:
                color_cfg["colorblind"] = vs["colorblind_mode"]
        
        # State loaded - user must call show() to display
        if not self.objects:
            print("Warning: No objects loaded from state file.")
