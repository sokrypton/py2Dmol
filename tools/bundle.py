"""The one list of what JavaScript this project has, and who needs it.

    python3 tools/bundle.py check     # every consumer agrees with MODULES
    python3 tools/bundle.py build     # build every bundle (and the loose panels)
    python3 tools/bundle.py build embed   # ...or just one
    python3 tools/bundle.py show      # print the manifest

WHY THIS EXISTS. The same set of files was written out by hand in five places -
index.html's script tags, viewer.py's inline reads, tests/run.sh's
terser loop, and setup.py's package_data - and they had already drifted apart:

  * setup.py did not ship viewer-cartoon-gpu.min.js, which viewer.py opens
    unconditionally. A wheel built by CI raised FileNotFoundError on the first
    show(); a wheel built here did not, because setuptools-scm covered for it.
  * tests/run.sh built viewer-seq.min.js on every run and nothing consumed it,
    while viewer-align.js had no .min.js at all.
  * viewer-msa.min.js, 63 KB, is committed and consumed by nothing.

Five lists that must agree, and nothing checking them, is one list plus four
copies waiting to rot - and the file split about to happen turns nine files into
twenty. So the manifest below is the list, `check` derives every consumer from
it, and tests/run.sh runs `check` in the node lane.

This is deliberately NOT a bundler. The files are classic scripts sharing one
global scope; they concatenate with no ceremony (verified - the whole set passes
`node --check` when cat'd together) and load with plain <script> tags. What is
needed is a manifest, not a module system.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Mod:
    """One JavaScript file, and everything that decides who gets it.

    `targets` is which HTML entry points load it. `inlined` is whether
    viewer.py reads it into the notebook's HTML - which is a different question,
    because the notebook has no <script src> at all. `minified` follows from
    `inlined`: a .min.js exists to be inlined and for no other reason.

    `standalone` marks a file that must NEVER be concatenated or inlined.
    align/align.js is the only one: it starts its Worker by having the worker
    importScripts *itself*, found through document.currentScript.src. With no
    URL of its own that lookup returns '' and it silently runs TM-align on the
    main thread instead - seconds of frozen page, no error.
    """

    def __init__(self, name, path, targets, inlined=False, standalone=False):
        self.name = name
        self.path = path
        self.targets = set(targets)
        self.inlined = inlined
        self.standalone = standalone

    @property
    def minified(self):
        # NOTHING is minified on its own any more - see BUNDLES. Kept so
        # check() can say so when a stray .min.js turns up beside a source.
        return False

    @property
    def min_path(self):
        return self.path[:-3] + '.min.js'


# IN LOAD ORDER. The order of this list is the order the tags are written and
# the order a bundle concatenates in - parts before core/mol, which installs
# them; cartoon/geom before cartoon/paint2d, which reads its vocabulary.
MODULES = [
    # FIRST, and it is the only tag index.html carries beside the bundle: it
    # cannot be concatenated (see Mod.standalone), and everything that uses it
    # - the renderer's align methods - only reaches for window.Align at click
    # time, so being early costs nothing and keeps one order for both pages.
    Mod('align',      'src/align/align.js',     ['web'], standalone=True),
    Mod('math',       'src/io/math.js',                          ['web']),
    # ...the chemistry of a side chain, cut out of parse.js so the NOTEBOOK can
    # have it without the other 36 KB of parser. Must precede parse.js, which
    # calls buildSidechainTable.
    Mod('sidechains', 'src/io/sidechains.js',                    ['web']),
    # ...and what counts as a bond, by element. Read by parse.js AND by
    # core/mol.js's distance fallback, which is the notebook's only route -
    # so it precedes both.
    Mod('bonds',      'src/io/bonds.js',                         ['web']),
    Mod('parse',      'src/io/parse.js',                         ['web']),
    Mod('gif',        'src/io/gif.js',                           ['web']),
    Mod('svg',        'src/core/svg.js',        ['web']),
    Mod('objstate',   'src/core/objstate.js',   ['web']),
    Mod('viewport',   'src/parts/viewport.js',  ['web']),
    Mod('shadow',     'src/parts/shadow.js',    ['web']),
    Mod('clip',       'src/parts/clip.js',      ['web']),
    # ...one click, one neighbourhood. Composes clip, the side-chain set and
    # residuesWithin, so it loads after clip and before ui.js, which wires it.
    Mod('focus',      'src/parts/focus.js',     ['web']),
    # ...and which residues show their side chains. After focus.js, which is
    # the other thing that writes that set. Named for the part rather than the
    # file so it does not collide with src/io/sidechains.js, which builds the
    # TABLE this one decides what to draw from - same split as mol-align.
    Mod('mol-sidechains', 'src/parts/sidechains.js', ['web']),
    Mod('capture',    'src/parts/capture.js',   ['web']),
    Mod('savepanel',  'src/parts/savepanel.js', ['web']),
    Mod('mol-align',  'src/parts/align.js',     ['web']),
    Mod('multi',      'src/parts/multi.js',     ['web']),
    # ...the style panel's rows, as data. Before ui.js, which mounts it.
    Mod('panel',      'src/parts/panel.js',     ['web']),
    # ...the selection panel's verbs. They were under src/app/, so only the
    # website could reach them; the DOM ids it looks up are panel.js's, so it
    # works in whichever shell mounted the panel.
    Mod('selpanel',   'src/parts/selectpanel.js', ['web']),
    # ...turning a structure to face the reader. Needs src/io/math.js, which is
    # why that file is no longer web-only.
    Mod('orient',     'src/parts/orient.js',    ['web']),
    Mod('ui',         'src/parts/ui.js',        ['web']),
    # ...the other wirer. Not on the website, which has the panel; core/mol.js
    # picks between the two on config.embed.
    Mod('embed',      'src/parts/embed.js',     []),
    Mod('mol',        'src/core/mol.js',        ['web']),
    Mod('geom',       'src/cartoon/geom.js',    ['web']),
    Mod('paint2d',    'src/cartoon/paint2d.js', ['web']),
    Mod('paintgl',    'src/cartoon/paintgl.js', ['web']),
    Mod('heatmap',    'src/panels/heatmap.js',  ['web']),
    Mod('scatter',    'src/panels/scatter.js',  ['web']),
    Mod('seq',        'src/panels/seq.js',      ['web']),
    Mod('msa',        'src/panels/msa.js',      ['web']),
    # the browser UI, split by what each part is for. Load order is loose -
    # everything here is a top-level function called after the page is up - but
    # main.js declares the shared state, so it goes first.
    Mod('app',        'src/app/main.js',                      ['web']),
    Mod('app-objects','src/app/objects.js',                   ['web']),
    Mod('app-fetch',  'src/app/fetch.js',                     ['web']),
    Mod('app-scatter','src/app/scatter.js',                   ['web']),
    Mod('app-session','src/app/session.js',                   ['web']),
]

# WHAT EACH APPLICATION ACTUALLY SHIPS.
#
# Many small source files are for reading; nobody should download twenty-two of
# them. A bundle is a named subset, concatenated in MODULES order and minified
# once - so the notebook fetches one script instead of fifteen, and an embed
# carries neither the panels nor the capture machinery it will never open.
#
# `standalone` modules are never in a bundle: align/align.js starts its Worker
# by importing its own URL, which a concatenation does not have.
BUNDLES = {
    # The notebook: everything a Jupyter cell can reach, panels included.
    #
    # PAE and scatter used to be added only when the config asked, as two
    # conditional reads and then as two one-file bundles. They are 15 KB and
    # 8 KB against 466 KB - five per cent - and both register a global and do
    # nothing at all until something asks for them. Two branches in viewer.py,
    # two artefacts and two entries in every list, to save five per cent of one
    # download, was not a trade worth keeping.
    # NO 'mol-align'. parts/align.js is the renderer's side of TM-align, and in
    # a notebook it is dead twice over: its only caller is the Align row of
    # parts/selectpanel.js, which hides itself when the aligner is absent, and the engine it needs - align/align.js - cannot be
    # concatenated into any bundle at all (see Mod.standalone). Every method it
    # adds throws "the aligner is not loaded" the moment it is reached.
    #
    # Worth removing even though it is small, because the notebook bundle is
    # INLINED INTO THE .ipynb, uncompressed, once per show() cell. Bytes here
    # are paid again for every viewer in the document.
    'notebook': ['math', 'sidechains', 'bonds', 'svg', 'objstate', 'viewport', 'shadow', 'clip', 'focus',
                 'mol-sidechains', 'capture', 'savepanel', 'multi', 'panel', 'selpanel',
                 'orient', 'ui', 'mol', 'geom', 'paintgl', 'paint2d', 'heatmap', 'scatter'],
    # ONE NOTEBOOK BUNDLE, WITH BOTH PAINTERS. There were three - GPU, 2D, and
    # a tube-only one without the cartoon geometry - and they existed for one
    # reason: this file is inlined into the .ipynb, uncompressed, ONCE PER
    # show() CELL, so a notebook with five viewers carried five copies and
    # every kilobyte was paid five times.
    #
    # SHARING ends that. The first viewer of a session writes the library
    # and lends it over a BroadcastChannel; every later one asks. The bytes are
    # paid once for the document, so the reason to ship three narrow builds
    # instead of one complete one is gone.
    #
    # WHAT THE SECOND PAINTER COSTS: 26 KB. paint2d.js is 81% comment and
    # minifies to 25 against paintgl's 71. What it buys is everything that was
    # given up to save it - `gpu` is a runtime choice again rather than a
    # choice of FILE, a machine without WebGL2 has a painter to fall back on,
    # and the cartoon can export an SVG, which needs the 2D painter because a
    # raster has no vector to hand back.
    #
    # And a notebook that mixes the two stops paying twice: one gpu=True viewer
    # and one gpu=False used to carry 429 + 384 KB of two different libraries,
    # neither of which could serve the other.
    'web': ['math', 'sidechains', 'bonds', 'parse', 'gif', 'svg', 'objstate', 'viewport', 'shadow', 'clip', 'focus',
            'mol-sidechains', 'capture', 'savepanel', 'mol-align', 'multi', 'panel', 'selpanel', 'orient', 'ui', 'mol',
            'geom', 'paint2d', 'paintgl', 'heatmap', 'scatter', 'seq', 'msa',
            'app', 'app-objects', 'app-fetch', 'app-scatter',
            'app-session'],
    # ONE PAINTER PER BUNDLE, AND OUTSIDE THE WEBSITE IT IS THE GPU.
    #
    # The website keeps both and a toggle; everything else picks one and has no
    # fallback behind it. What that does to a download depends entirely on what
    # the bundle carried before, so the three numbers go in three directions and
    # only one of them is a saving:
    #
    #   notebook    478 -> 453 KB   had BOTH; dropped paint2d          -25
    #   embed       321 -> 414 KB   had paint2d; swapped for paintgl   +93
    #
    # THERE WAS A THIRD, AND GOING GPU-ONLY IS WHAT ENDED IT. embed-tube was the
    # small one: tube only, no cartoon geometry, no painter at all - the tube is
    # drawn by _drawFrame in core/mol.js - and it came to 195 KB against embed's
    # 321. Needing paintgl took it to 313 against 415. A quarter smaller, for a
    # build that cannot draw a cartoon, is not a choice worth offering or a
    # second artefact worth keeping in step.
    #
    # MEASURE THIS MINIFIED, NOT IN LINES. paint2d.js is 2,487 lines and 25 KB
    # minified; paintgl.js is 5,834 lines and 118 KB. Twice the source, nearly
    # five times the download - paint2d is 81% comment and whitespace against
    # paintgl's 62%, so line counts understate the swap by half.
    #
    # What it buys is what the sizes were never the point of: 26 ms a frame on a
    # capsid against 840, and 455 ms to first paint against 1,813.
    #
    # TWO THINGS FOLLOW AND ARE NOT OPTIONAL. Without WebGL2 these builds draw
    # nothing, loudly - cartoon/geom.js says so on the console rather than
    # leaving a blank canvas. And SVG export is gone from them: the GPU refuses
    # an export context by design (paintgl.js checks ctx.getSerializedSvg), so
    # vector output only ever came from the 2D painter. The Save panel hides the
    # option when that painter is absent.

    # A structure on someone's web page: parse, render, and a JS API. No panels,
    # no save UI, no session, no alignment.
    # panel + ui are what `controls: true` and `play` need: the embed mounts
    # the notebook's own Style panel and is wired by wireViewerUI, rather than
    # growing a third set of controls to keep in step. 25 KB for exact parity.
    'embed': ['math', 'sidechains', 'bonds', 'parse', 'objstate', 'viewport', 'shadow', 'clip', 'focus',
              'mol-sidechains', 'capture', 'savepanel', 'multi', 'panel', 'selpanel',
              'orient', 'ui', 'embed', 'mol', 'geom', 'paintgl'],
    # ...and the same embed drawn on the CPU. THE SECOND ARTEFACT THAT EARNS ITS
    # KEEP, where embed-tube did not: it draws the same picture from the same
    # geometry - one geometry, two painters - so nothing is given up but speed on
    # a large structure, and paint2d.js is 25 KB against paintgl.js's 118, which
    # is 93 KB off the download. It can also export SVG, which the GPU cannot:
    # vector output is the primitives replayed into an SVG context, and the GPU
    # holds a raster. So capture and svg come with it.
    #
    # NOT A FALLBACK. Neither bundle has anything behind it; parts/embed.js asks
    # which painter is present and refuses a request for the other one.
    'embed.cpu': ['math', 'sidechains', 'bonds', 'parse', 'objstate', 'svg', 'viewport', 'shadow',
                  'clip', 'focus', 'mol-sidechains', 'capture', 'savepanel', 'multi',
                  'panel', 'selpanel', 'orient', 'ui', 'embed', 'mol', 'geom', 'paint2d'],
    # THE WEBSITE, PLUS THE EMBED API. Set-for-set this is exactly `web` plus
    # ONE module - parts/embed.js - so a page gets the whole app (the panels,
    # the sessions, the ingestion) AND can call py2Dmol.show / frameFromText /
    # framesFromText / superpose directly. 755 KB against web's 737: the embed
    # half costs 18 KB, because everything it needs was already there for the
    # app. LocalFold wants both halves - the app to ingest a prediction as
    # files, the embed helpers to morph one conformation into another
    # (framesFromText parses the fourteen-model walk once, then replaceFrame
    # steps it, which is the rule on animations against trajectories).
    #
    # 🔴 THE BUNDLE IS THE EASY HALF, AND HERE IT IS THE WHOLE APP'S MARKUP,
    # NOT JUST A PANEL'S. Every panel finds its own DOM and does nothing until
    # it exists - `#paeContainer` + `#paeCanvas`, `#scatterContainer` +
    # `#scatterCanvas`, `#sequence-viewer-container` + `#sequenceView`, eight
    # controls for the MSA - and src/app/ looks up the website's controls the
    # same way. Loading this over a bare canvas buys a bigger download and the
    # same picture; a host page is hosting index.html's markup, or the parts of
    # it whose features it wants. The shell in parts/embed.js builds none of it.
    #
    # AND THE STRIP AND THE MSA LOOK THEIR ELEMENTS UP ON `document`, not
    # inside the viewer's own container - so two of these on one page would
    # find each other's. The PAE panel scopes to the container and falls back
    # to document, which is the pattern the other two need before an embed can
    # honestly have more than one.
    #
    # THE HOST'S TWO DOORS INTO THE APP, both in src/app/main.js:
    # `py2dmolLoadFiles(files, loadAsFrames, groupName)` is processFiles, which
    # already took VIRTUAL files - `{name, readAsync}` - so a page hands over a
    # structure it computed in memory rather than faking a File and replaying a
    # change event; and `py2dmolReadyMessage` replaces "Upload a file or fetch
    # an ID", which names two controls a host page may not have.
    #
    # 🔴 AND IT CARRIES 'mol-align', SO THE PAGE MUST LOAD align/align.js
    # ITSELF - exactly as index.html does, and for the reason no bundle may
    # contain it: it starts its Worker by having the worker importScripts
    # ITSELF, found through document.currentScript.src, so concatenated it has
    # no URL of its own and TM-align silently runs on the main thread. Every
    # method mol-align adds throws until that second script is loaded. This is
    # the one bundle whose page needs two <script> tags, and it is the same two
    # index.html has.
    'full': ['math', 'sidechains', 'bonds', 'parse', 'gif', 'svg', 'objstate', 'viewport', 'shadow', 'clip', 'focus',
             'mol-sidechains', 'capture', 'savepanel', 'mol-align', 'multi', 'panel', 'selpanel', 'orient', 'ui', 'embed', 'mol',
             'geom', 'paint2d', 'paintgl', 'heatmap', 'scatter', 'seq', 'msa',
             'app', 'app-objects', 'app-fetch', 'app-scatter',
             'app-session'],
}

BUNDLE_DIR = 'py2Dmol/resources/bundles'

# THE FILENAME SAYS WHICH LIBRARY IT IS. A bundle is copied into someone else's
# project and sits beside their own scripts; `py2Dmol.embed.min.js` there is anonymous,
# and the directory that would have explained it is left behind. The target name
# stays as the suffix, so the set reads as one family.
BUNDLE_PREFIX = 'py2Dmol.'


def bundle_file(target):
    return f'{BUNDLE_DIR}/{BUNDLE_PREFIX}{target}.min.js'

BY_PATH = {m.path: m for m in MODULES}

# TWO PAGES, ONE MARKUP. index.html is what py2dmol.solab.org serves, so it
# loads the bundle: one 729 KB request instead of twenty-seven totalling 2.9 MB.
# dev.html is the same page with the twenty-six bundled files as loose tags, for
# edit-and-reload with real line numbers, and it is GENERATED - `build` writes
# it and `check` fails if it is not what regeneration would produce. Keeping it
# by hand is how aoe's two near-identical pages drifted.
SITE_HTML = 'index.html'
DEV_HTML = 'dev.html'
ENTRY_HTML = {'web': DEV_HTML}

DEV_BANNER = ("    <!-- GENERATED by tools/bundle.py from index.html. Do not edit:\n"
              "         change index.html and run `python3 tools/bundle.py build`.\n"
              "         This is index.html with the bundle expanded into the loose\n"
              "         sources it was built from - the page to develop against. -->\n")


def render_dev():
    """index.html with the bundle tag expanded into the manifest's loose tags."""
    src = open(os.path.join(ROOT, SITE_HTML)).read()
    tag = f'<script src="{bundle_file("web")}"></script>'
    if src.count(tag) != 1:
        sys.exit(f'{SITE_HTML} must carry exactly one {tag}')
    loose = ''.join(f'    <script src="{m.path}"></script>\n'
                    for m in for_target('web') if not m.standalone)
    return src.replace('    ' + tag + '\n', DEV_BANNER + loose, 1)


def for_target(t):
    return [m for m in MODULES if t in m.targets]


# --- reading what each consumer currently believes -------------------------

def tags_in(html):
    """The local <script src> paths in an HTML entry point, in document order."""
    src = open(os.path.join(ROOT, html)).read()
    return re.findall(r'<script src="((?:py2Dmol|src)/[^"?]+)', src)


def inlined_by_viewer():
    """The .min.js files viewer.py reads.

    BY THE NAME, NOT BY THE CALL. This matched `_resource_text("...")` with a
    literal inside, and viewer.py chooses between two bundles now - so the
    argument is a variable and the scan came back EMPTY while both names sat
    three lines above it. A check that reads nothing passes everything.

    What matters is that every bundle the file names is one that gets built and
    shipped; how the string reaches the call does not change that.
    """
    src = open(os.path.join(ROOT, 'py2Dmol', 'viewer.py')).read()
    return sorted(set(re.findall(r"""["'](bundles/[^"']+\.min\.js)["']""", src)))


def minified_by_runsh():
    """What tests/run.sh minifies: a list of its own, or None if it delegates.

    None is the right answer and the one this repo gives - run.sh calls
    `tools/bundle.py minify`, so there is no second list to disagree with. The
    literal-list branch stays because that is what it used to do, and a revert
    to it should be caught rather than silently accepted.
    """
    src = open(os.path.join(ROOT, 'tests', 'run.sh')).read()
    if re.search(r'bundle\.py\s+minify', src):
        return None
    m = re.search(r'for f in ((?:py2Dmol|src)/[\s\S]*?); do\n\s*npx terser', src)
    return re.findall(r'(?:py2Dmol|src)/\S+\.js', m.group(1)) if m else []


# --- building -----------------------------------------------------------

BY_NAME = {m.name: m for m in MODULES}


def bundle_paths(target):
    """The files in a bundle, in MODULES order, with the names checked."""
    want = set(BUNDLES[target])
    unknown = want - set(BY_NAME)
    if unknown:
        sys.exit(f"bundle {target!r} names modules that do not exist: {sorted(unknown)}")
    standalone = [n for n in want if BY_NAME[n].standalone]
    if standalone:
        sys.exit(f"bundle {target!r} includes {standalone}, which cannot be"
                 " concatenated - see Mod.standalone")
    return [m.path for m in MODULES if m.name in want]


# GLSL IS A STRING, AND TERSER DOES NOT LOOK INSIDE STRINGS.
#
# cartoon/paintgl.js carries its shaders as template literals, and they are
# commented the way the rest of the project is - which is right in the source
# and dead weight in the download: 65 KB of the 118 KB that file minifies to is
# shader text that terser copies through byte for byte, comments, indentation
# and all. Stripping it at BUILD time is the whole of the saving and costs the
# reader nothing, because the file on disk keeps every word.
#
# 118.3 KB -> 70.8 KB for that file; 41.4 -> 22.9 gzipped.
#
# NEWLINES ARE KEPT. GLSL is whitespace-insensitive except for the
# preprocessor: `#version 300 es` and every `#define` must end at a line break,
# so runs of spaces collapse and indentation goes, but line structure stays.
#
# Only literals that ANNOUNCE THEMSELVES as GLSL are touched, and only in that
# one file. parts/embed.js also carries big template literals - its HTML shell
# and the scoped stylesheet - and collapsing whitespace inside markup changes
# what the text nodes say.
# 🔴 A TEMPLATE LITERAL CAN CONTAIN AN ESCAPED BACKTICK, and `[^`]*` ends at
# it. The panel's stylesheet is generated text and its comments quoted class
# names in backticks; the naive pattern cut the literal in half there, so the
# strip ran over the first fragment, left the rest, and the boundary it thought
# it had was inside a string. Nothing throws - the bundle is still valid JS -
# and the check that caught it was the shader one, counting indented lines.
TEMPLATE_LITERAL = r'`(?:\\.|[^`\\])*`'

GLSL_MARKS = ('#version', 'void main', 'gl_Position', 'gl_FragColor',
              'uniform ', 'varying ', 'attribute ', 'precision ')


def strip_glsl(src):
    """Comments and indentation out of the shader literals in one file."""
    def one(m):
        t = m.group(0)
        if len(t) < 400 or not any(k in t for k in GLSL_MARKS):
            return t
        t = re.sub(r'//[^\n]*', '', t)
        t = re.sub(r'/\*.*?\*/', '', t, flags=re.S)
        t = re.sub(r'[ \t]+', ' ', t)
        t = re.sub(r' *\n *', '\n', t)
        t = re.sub(r'\n{2,}', '\n', t)
        return t
    return re.sub(TEMPLATE_LITERAL, one, src, flags=re.S)


# ...AND THE SELECTION PANEL'S STYLESHEET IS THE SAME PROBLEM, ONE FILE ALONG.
#
# parts/panel.js carries the panel's forty-six rules as a template literal -
# they used to be src/app/style.css and could not travel from there - and they
# are commented and indented like everything else here. 13.0 KB of text that
# terser copies through byte for byte, and the NOTEBOOK bundle is inlined into
# the .ipynb once per document, so those bytes are paid for real.
#
# Only a literal that announces itself as this stylesheet is touched: `SCOPE`
# is the scoping token selectionPanelCSS() substitutes and appears nowhere
# else in the tree. CSS is whitespace-insensitive throughout - there is no
# preprocessor line rule as there is in GLSL - so the newlines go too.
CSS_MARK = 'SCOPE .selection-panel'


def strip_css(src):
    """Comments and layout out of the panel stylesheet literal."""
    def one(m):
        t = m.group(0)
        if len(t) < 400 or CSS_MARK not in t:
            return t
        t = re.sub(r'/\*.*?\*/', '', t, flags=re.S)
        t = re.sub(r'\s+', ' ', t)
        # 🔴 NOT AROUND `:`. `:where(.selection-panel) :where(.btn)` is a
        # DESCENDANT selector, and closing the space before that second colon
        # makes it a compound one - a different rule, silently, in the bundle
        # only. The saving from a colon is a byte a rule; the cost is the whole
        # panel's skin. Braces and semicolons have no such reading.
        t = re.sub(r'\s*([{};,])\s*', r'\1', t)
        return t
    return re.sub(TEMPLATE_LITERAL, one, src, flags=re.S)


def source_for_bundle(path):
    text = open(os.path.join(ROOT, path)).read()
    if path.endswith('cartoon/paintgl.js'):
        return strip_glsl(text)
    if path.endswith('parts/panel.js'):
        return strip_css(text)
    return text


def build(targets=None):
    os.makedirs(os.path.join(ROOT, BUNDLE_DIR), exist_ok=True)
    for target in (targets or list(BUNDLES)):
        srcs = bundle_paths(target)
        joined = '\n'.join(source_for_bundle(p) for p in srcs)
        raw = os.path.join(ROOT, BUNDLE_DIR, target + '.js')
        out = os.path.join(ROOT, bundle_file(target))
        open(raw, 'w').write(joined)
        r = subprocess.run(['npx', 'terser', raw, '-c', '-m', '-o', out],
                           cwd=ROOT, capture_output=True, text=True)
        os.remove(raw)
        if r.returncode != 0:
            sys.exit(f'terser failed on bundle {target}:\n' + r.stderr.strip()[:400])
        print(f'  {os.path.getsize(out):>9} {bundle_file(target)}'
              f'  ({len(srcs)} files)')
    # ...and the development page, which is index.html with the web bundle
    # expanded. Written every build so it cannot lag the manifest.
    dev = render_dev()
    open(os.path.join(ROOT, DEV_HTML), 'w').write(dev)
    print(f'  {len(dev):>9} {DEV_HTML}  ({dev.count("<script src=") } tags)')
    return 0


# --- the check --------------------------------------------------------------

def check():
    bad = []
    print(f"{len(MODULES)} modules, {len(BUNDLES)} bundles")

    for target, html in ENTRY_HTML.items():
        want = [m.path for m in for_target(target)]
        have = tags_in(html)
        print(f"  {html}: {len(have)} tags")
        if have != want:
            bad.append(f"{html} loads\n      {have}\n    but the manifest says\n      {want}")

    # ...and the DEPLOYED page loads the bundle and the one file that cannot be
    # in it, and nothing else. A loose tag surviving here is a source file
    # served to the public beside a bundle that already contains it.
    site_want = [m.path for m in for_target('web') if m.standalone] + \
                [bundle_file('web')]
    site_have = tags_in(SITE_HTML)
    if site_have != site_want:
        bad.append(f"{SITE_HTML} loads\n      {site_have}\n    but should load\n"
                   f"      {site_want}")

    # ...and dev.html IS index.html with the bundle expanded. Generated, so the
    # two pages cannot drift in markup - only in the tag block, which is derived.
    dev_path = os.path.join(ROOT, DEV_HTML)
    if not os.path.exists(dev_path):
        bad.append(f"{DEV_HTML} is missing - run: python3 tools/bundle.py build")
    elif open(dev_path).read() != render_dev():
        bad.append(f"{DEV_HTML} is not what index.html regenerates to - it was"
                   " edited by hand, or index.html changed without a rebuild."
                   " Run: python3 tools/bundle.py build")

    # ...and the web bundle IS index.html's tag list, minus what cannot be
    # concatenated. A deployed page serving a bundle that omits a file the dev
    # page loads is a page that works locally and not in production.
    if 'web' in BUNDLES:
        want_web = [m.name for m in for_target('web') if not m.standalone]
        if sorted(BUNDLES['web']) != sorted(want_web):
            miss = sorted(set(want_web) - set(BUNDLES['web']))
            extra = sorted(set(BUNDLES['web']) - set(want_web))
            if miss:
                bad.append(f"the web bundle is missing {miss}, which index.html loads")
            if extra:
                bad.append(f"the web bundle has {extra}, which index.html does not load")

    # 🔴 ...AND tests/lift.js's UTILS IS EVERY src/io FILE. That list is what a
    # node test evaluates as "the utilities", and a file left out of it is a
    # declaration missing from that blob while its callers are in it - green
    # until a test reaches the line. It happened when the bond table moved out
    # of parse.js into src/io/bonds.js: `bondMaxFor` was undefined there and
    # the parser called it. The io directory IS the utilities, so the two
    # lists are derivable from each other and this says so.
    lift_path = os.path.join(ROOT, 'tests', 'lift.js')
    if os.path.exists(lift_path):
        lift = open(lift_path).read()
        m = re.search(r'const UTILS = \[(.*?)\];', lift, re.S)
        listed = set(re.findall(r"'(src/io/[\w./-]+\.js)'", m.group(1) if m else ''))
        want_io = {mod.path for mod in MODULES if mod.path.startswith('src/io/')}
        if not m:
            bad.append("tests/lift.js has no UTILS list where this expects one")
        else:
            miss = sorted(want_io - listed)
            extra = sorted(listed - want_io)
            if miss:
                bad.append(f"tests/lift.js's UTILS is missing {miss} - a node test"
                           " evaluating it gets the callers without the declaration")
            if extra:
                bad.append(f"tests/lift.js's UTILS names {extra}, which the manifest"
                           " does not have")

    # ...every module is in at least one bundle, or is loose, or is standalone,
    # or is web-app-only. A file nobody ships is a file nobody notices rotting.
    bundled = {n for names in BUNDLES.values() for n in names}
    WEB_ONLY = {'gif', 'seq', 'msa', 'app', 'app-objects',
                'app-fetch', 'app-scatter', 'app-session'}
    for m in MODULES:
        if m.name in bundled or m.standalone or m.name in WEB_ONLY:
            continue
        bad.append(f"{m.path} is in no bundle and is not loose - nothing ships it")

    # THE ONE THE NOTEBOOK INLINES. There were three - the WebGL2 cartoon, the
    # 2D one for gpu=False, and a cartoon-less tube - because this file goes
    # into the .ipynb once per show() cell. Sharing pays it once for the
    # document, so one complete bundle costs less than three narrow ones and
    # `gpu` chooses a painter inside it rather than choosing a file.
    want_inline = sorted(f'bundles/{BUNDLE_PREFIX}{t}.min.js'
                         for t in ('notebook',))
    have_inline = sorted(set(inlined_by_viewer()))
    print(f"  viewer.py inlines: {len(have_inline)}")
    if have_inline != want_inline:
        bad.append(f"viewer.py inlines {have_inline}, manifest says {want_inline}")

    for target in BUNDLES:
        f = os.path.join(ROOT, bundle_file(target))
        if not os.path.exists(f):
            bad.append(f"{bundle_file(target)} has not been built"
                       " - run: python3 tools/bundle.py build")
    # ...AND NOTHING MINIFIED OUTSIDE bundles/. Everything that ships is a
    # bundle, so a .min.js beside a source file is a leftover - it will not be
    # rebuilt, nothing loads it, and it is indistinguishable from something that
    # matters.
    for dirpath, _, names in os.walk(os.path.join(ROOT, 'py2Dmol', 'resources')):
        if os.path.basename(dirpath) == 'bundles':
            continue
        for n in names:
            if n.endswith('.min.js'):
                rel = os.path.relpath(os.path.join(dirpath, n), ROOT)
                bad.append(f"{rel} is minified but not in bundles/ - nothing"
                           " builds or loads it")

    if not MODULES or not BUNDLES:
        bad.append("the manifest is empty - this check would pass forever")

    for b in bad:
        print("FAIL: " + b)
    return 1 if bad else 0


def minify():
    """Kept as a name people type; building the bundles is the same job now."""
    return build()


def show():
    for m in MODULES:
        flags = ' '.join(filter(None, [
            'inlined' if m.inlined else '', 'standalone' if m.standalone else '']))
        print(f"  {m.name:<12} {m.path:<42} {','.join(sorted(m.targets)):<9} {flags}")
    return 0


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'check'
    args = sys.argv[2:]
    if cmd == 'build':
        sys.exit(build(args or None))
    sys.exit({'check': check, 'minify': minify, 'show': show}[cmd]())
