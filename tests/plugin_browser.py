"""A plugin's wireframe in a REAL browser: both painters, capture, rotation, the key.

    python3 tests/plugin_browser.py                 # the maintainer's Mac: tests/cdp.py's own launch
    PY2DMOL_CHROME=/path/to/chrome python3 tests/plugin_browser.py     # any other machine
    PLUGIN_STRUCTURE=/path/to/file.pdb python3 tests/plugin_browser.py # default: a synthetic helix

tests/plugin_seam.js is the same claim on the 2D painter with no browser; this is the half that
needs WebGL2 and a real canvas. It builds pages through the Python API (view.add_plugin,
py2Dmol.register_plugin, view.to_html) so the whole chain is measured: payload -> page ->
registry -> seam -> prims -> painter -> pixels.

WHICH BUNDLE. The tracked py2Dmol/resources/bundles/py2Dmol.notebook.min.js is used when it
carries the registry. When it does not - the source has moved and `python3 tools/bundle.py
build` has not been run, which needs `npx terser` - an UNMINIFIED stand-in is built into a
temporary file from the same manifest. So the probe is meaningful either way; it says which.

WHAT IS MEASURED, per painter (gpu=0 is the 2D painter, gpu=1 the WebGL2 one):
  * a wireframe cube in the plugin's colour appears (red pixels, against none without it);
  * ...in a PNG capture (renderer.toImage) too;
  * ...and in an SVG capture on the 2D painter;
  * rotating the view keeps it on the structure and - on the GPU - does NOT rebuild the mesh
    (window.__faceBuilds unchanged: the lines are model-space geometry, the camera a uniform);
  * changing a plugin option changes the key, and the wireframe goes (and comes back, with a
    rebuild on the GPU) - the control for "the key is what makes a rebuild happen";
  * a cube LARGER than the structure is not clipped on the GPU: its pixel count is within 12%
    of the 2D painter's, which has no depth range (the regression for folding the plugin's
    extent into the GPU depth range);
  * the plugin's ball carries no palette slot and does not cost the structure its cheap
    recolour (window.__gpuPaletteComplete stays true);
  * three registration orders: the plugin script before the library, after it, and registered
    from the console after the viewer is already drawing.
  * fading residue 0 out (set_opacity) leaves the plugin's ball drawn - it belongs to no residue;
  * a live update (the handler Python's incremental update calls) changes an option with no payload,
    and brings a plugin the page has never had, with its source;
  * and on dev.html, the website's session file: saved, replaced, cleared by a file with none, and
    appended with the object renamed.
Each of these fails when the guard behind it is removed.
"""
import base64
import importlib.util
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import cdp  # noqa: E402

try:
    import IPython.display  # noqa: F401
except ImportError:
    _d = types.ModuleType('IPython.display')
    for _n in ('display', 'HTML', 'Javascript', 'update_display'):
        setattr(_d, _n, lambda *a, **k: None)
    _i = types.ModuleType('IPython')
    _i.display = _d
    sys.modules['IPython'] = _i
    sys.modules['IPython.display'] = _d
sys.path.insert(0, ROOT)
import py2Dmol  # noqa: E402
assert py2Dmol.__file__.startswith(ROOT), py2Dmol.__file__

OUT = os.environ.get('PLUGIN_SHOTS', os.path.join(tempfile.gettempdir(), 'py2dmol_plugin_shots'))
os.makedirs(OUT, exist_ok=True)
SIZE = 600
bad = 0


def ok(c, msg):
    global bad
    print(('PASS ' if c else 'FAIL ') + msg, flush=True)
    if not c:
        bad += 1


# ------------------------------------------------------------------ the browser
def launch(port=9333):
    """THE ONE BROWSER-SPECIFIC STEP. On the maintainer's Mac it is tests/cdp.py's own launch;
    anywhere else, PY2DMOL_CHROME names a Chrome/Chromium binary (software GL is enough: the
    flags ask for SwiftShader, which is what makes WebGL2 available with no GPU)."""
    profile = os.path.join(tempfile.gettempdir(), 'py2dmol_plugin_profile_%d' % port)
    exe = os.environ.get('PY2DMOL_CHROME')
    if not exe:
        return cdp.launch(port, profile)
    subprocess.run(['pkill', '-9', '-f', 'user-data-dir=' + profile],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(profile, ignore_errors=True)
    p = subprocess.Popen([exe, '--headless=new', '--no-sandbox', '--user-data-dir=' + profile,
                          '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=%d' % port,
                          '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                          '--ignore-gpu-blocklist', '--enable-webgl', 'about:blank'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + 30
    while time.time() < end:
        try:
            import urllib.request
            for t in json.load(urllib.request.urlopen('http://127.0.0.1:%d/json/list' % port)):
                if t.get('type') == 'page':
                    return p, cdp.WS(t['webSocketDebuggerUrl'])
        except Exception:
            time.sleep(0.3)
    p.kill()
    raise RuntimeError('no CDP target')


# ------------------------------------------------------------------ pixels
def png_rgb(data):
    """PNG bytes -> (w, h, list of rows of (r, g, b) bytes). PIL if there is one; else a
    small decoder for what Chrome writes (8-bit, non-interlaced)."""
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(data)).convert('RGB')
        w, h = im.size
        raw = im.tobytes()
        return w, h, [raw[y * w * 3:(y + 1) * w * 3] for y in range(h)]
    except ImportError:
        pass
    pos, idat, w = 8, b'', 0
    while pos < len(data):
        n = int.from_bytes(data[pos:pos + 4], 'big')
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        if kind == b'IHDR':
            w, h, depth, ctype = int.from_bytes(body[:4], 'big'), int.from_bytes(body[4:8], 'big'), body[8], body[9]
            assert depth == 8 and ctype in (2, 6) and body[12] == 0, 'unsupported PNG'
            bpp = 3 if ctype == 2 else 4
        elif kind == b'IDAT':
            idat += body
        pos += 12 + n
    raw = zlib.decompress(idat)
    stride = w * bpp
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        cur = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = cur[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                cur[i] = (cur[i] + a) & 255
            elif f == 2:
                cur[i] = (cur[i] + b) & 255
            elif f == 3:
                cur[i] = (cur[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 255
        prev = cur
        rows.append(bytes(cur) if bpp == 3 else bytes(v for j in range(w) for v in cur[j * 4:j * 4 + 3]))
    return w, h, rows


def count(data, pred):
    w, h, rows = png_rgb(data)
    n = 0
    for row in rows:
        for x in range(w):
            if pred(row[3 * x], row[3 * x + 1], row[3 * x + 2]):
                n += 1
    return n


# MAGENTA, because a cartoon's own palette is full of reds and there is no magenta in it: the
# count without the plugin is exactly the count of pixels this predicate should never see.
RED = lambda r, g, b: r > 200 and b > 200 and g < 90
GREEN = lambda r, g, b: g > 150 and r < 90 and b < 90
INK = lambda r, g, b: r < 235 or g < 235 or b < 235


def edge_count(data, m=3):
    """Wire-coloured pixels within `m` px of the canvas border: a shell that is cropped has some."""
    w, h, rows = png_rgb(data)
    n = 0
    for y in range(h):
        for x in range(w):
            if (x < m or y < m or x >= w - m or y >= h - m) and RED(rows[y][3 * x], rows[y][3 * x + 1], rows[y][3 * x + 2]):
                n += 1
    return n


def differ(a, b, tol=30):
    """How many pixels of two PNGs differ by more than `tol` (summed over the channels)."""
    w, h, ra = png_rgb(a)
    w2, h2, rb = png_rgb(b)
    assert (w, h) == (w2, h2)
    n = 0
    for y in range(h):
        x, y_ = ra[y], rb[y]
        if x == y_:
            continue
        for i in range(w):
            if abs(x[3 * i] - y_[3 * i]) + abs(x[3 * i + 1] - y_[3 * i + 1]) + abs(x[3 * i + 2] - y_[3 * i + 2]) > tol:
                n += 1
    return n


# ------------------------------------------------------------------ the structure and the plugin
def structure_file(tmp):
    src = os.environ.get('PLUGIN_STRUCTURE')
    if src:
        return src
    path = os.path.join(tmp, 'helix.pdb')
    lines = []
    for i in range(60):
        th = i * 100 * math.pi / 180
        lines.append('ATOM  %5d  CA  ALA A%4d    %8.3f%8.3f%8.3f  1.00 50.00           C'
                     % (i + 1, i + 1, 2.3 * math.cos(th), 2.3 * math.sin(th), 1.5 * i))
    open(path, 'w').write('\n'.join(lines) + '\nEND\n')
    return path


def centre_of(path):
    xs = []
    for ln in open(path):
        if ln.startswith('ATOM') and ln[12:16].strip() == 'CA':
            xs.append((float(ln[30:38]), float(ln[38:46]), float(ln[46:54])))
    if not xs:
        for ln in open(path):
            if ln.startswith('ATOM'):
                xs.append((float(ln[30:38]), float(ln[38:46]), float(ln[46:54])))
    n = float(len(xs))
    return [sum(p[i] for p in xs) / n for i in range(3)]


PLUGIN_JS = r"""
(function () {
  // THE BOILERPLATE register_plugin documents: works before or after the library
  var P = window.py2dmolPlugins = window.py2dmolPlugins || {list: [], pending: []};
  var def = {
    name: 'wire', version: '1', apiVersion: 1, options: {shown: true, ink: false},
    key: function (c) { return JSON.stringify(c.options); },
    bounds: function (c) {
      var r = null;
      c.payloads.forEach(function (p) {
        var q = p.payload, h = q.half;
        var b = {min: [q.center[0] - h, q.center[1] - h, q.center[2] - h],
                 max: [q.center[0] + h, q.center[1] + h, q.center[2] + h]};
        r = r ? {min: r.min.map(function (v, i) { return Math.min(v, b.min[i]); }),
                 max: r.max.map(function (v, i) { return Math.max(v, b.max[i]); })} : b;
      });
      return r;
    },
    prims: function (c) {
      if (!c.options.shown) return;
      c.payloads.forEach(function (p) {
        var q = p.payload, h = q.half, o = q.center, n = 0;
        for (var i = 0; i < 8; i++) {
          for (var b = 1; b < 8; b <<= 1) {
            if (i & b) continue;
            var A = [o[0] + ((i & 1) ? h : -h), o[1] + ((i & 2) ? h : -h), o[2] + ((i & 4) ? h : -h)];
            var j = i | b;
            var B = [o[0] + ((j & 1) ? h : -h), o[1] + ((j & 2) ? h : -h), o[2] + ((j & 4) ? h : -h)];
            // `subdiv` cuts every edge into that many strokes: a cube of 12 edges of 834 is 10,008 lines
            var m = q.subdiv || 1;
            for (var t = 0; t < m; t++) {
              var f0 = t / m, f1 = (t + 1) / m;
              c.line([A[0] + (B[0] - A[0]) * f0, A[1] + (B[1] - A[1]) * f0, A[2] + (B[2] - A[2]) * f0],
                     [A[0] + (B[0] - A[0]) * f1, A[1] + (B[1] - A[1]) * f1, A[2] + (B[2] - A[2]) * f1],
                     {color: q.color, width: q.width, ink: c.options.ink});
              n++;
            }
          }
        }
        if (q.ball) c.dot(o, {color: [0, 200, 0], radius: q.ball});
        // a big flat triangle through the middle, only when asked: the GPU tube has
        // no shape for one and must hand the frame to the 2D tube
        // - one in each axis plane, so whichever way the opening orient turned the
        // model, one of them faces the camera
        if (c.options.tri) {
          var T = {color: [255, 140, 0]};
          c.tri([o[0] - h, o[1] - h, o[2]], [o[0] + h, o[1] - h, o[2]], [o[0], o[1] + h, o[2]], T);
          c.tri([o[0] - h, o[1], o[2] - h], [o[0] + h, o[1], o[2] - h], [o[0], o[1], o[2] + h], T);
          c.tri([o[0], o[1] - h, o[2] - h], [o[0], o[1] + h, o[2] - h], [o[0], o[1], o[2] + h], T);
        }
        window.__pluginEmitted = n;
      });
    }
  };
  if (P.register) P.register(def); else P.pending.push(def);
})();
"""

SETTLE = """new Promise(res => { const r = Object.values(window.py2dmol_viewers)[0].renderer;
  r.render('probe'); setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(res)), 400); })"""


def bundle_path(tmp):
    """The notebook bundle that carries the registry: the tracked one, else a stand-in."""
    tracked = os.path.join(ROOT, 'py2Dmol', 'resources', 'bundles', 'py2Dmol.notebook.min.js')
    if os.path.exists(tracked) and 'py2dmolPlugins' in open(tracked).read():
        return tracked, 'tracked minified notebook bundle'
    spec = importlib.util.spec_from_file_location('bundle', os.path.join(ROOT, 'tools', 'bundle.py'))
    b = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(b)
    b.ROOT = ROOT
    out = os.path.join(tmp, 'notebook.standin.js')
    open(out, 'w').write('\n'.join(b.source_for_bundle(p) for p in b.bundle_paths('notebook')))
    return out, 'UNMINIFIED STAND-IN (the tracked bundle predates the registry; run tools/bundle.py build)'


def make_page(tmp, bundle, gpu, order, half, ball=0, plugin=True, subdiv=1, style='cartoon'):
    path = structure_file(tmp)
    kw = {'preset': 'richardson'} if style == 'cartoon' else {}
    v = py2Dmol.view(size=(SIZE, SIZE), style=style, gpu=bool(gpu), controls=False,
                     id='probe%d%s%s' % (gpu, order, style), **kw)
    old, sys.stdout = sys.stdout, open(os.devnull, 'w')
    try:
        v.add_pdb(path, name='obj')
    finally:
        sys.stdout = old
    if plugin:
        py2Dmol.register_plugin('wire', PLUGIN_JS, '1')
        v.add_plugin('wire', {'center': centre_of(path), 'half': half, 'color': [255, 0, 255],
                              'width': 0.45, 'ball': ball, 'subdiv': subdiv}, object='obj')
    html = v.to_html(bundle='file://' + bundle)
    m = re.search(r'<script data-py2dmol-plugin="wire">.*?</script>\n', html, re.S)
    if plugin and order in ('before', 'late'):
        assert m, 'the page carries no plugin script'
        html = html.replace(m.group(0), '', 1)
        if order == 'before':
            head = html.index('<script src=')
            html = html[:head] + m.group(0) + html[head:]
    page = os.path.join(tmp, 'page_%d_%s_%s_%d_%s.html' % (gpu, order, half, subdiv, style))
    open(page, 'w').write(html)
    return page


def shot(ws, name):
    r = ws.call('Page.captureScreenshot', format='png', clip=dict(x=8, y=8, width=SIZE, height=SIZE, scale=1))
    data = base64.b64decode(r['data'])
    open(os.path.join(OUT, name + '.png'), 'wb').write(data)
    return data


def ev(ws, expr, aw=True):
    return cdp.evaluate(ws, expr, aw)


def open_page(ws, page):
    ws.call('Page.enable')
    ws.call('Runtime.enable')
    ws.call('Emulation.setDeviceMetricsOverride', width=1000, height=800, deviceScaleFactor=1, mobile=False)
    ws.call('Page.navigate', url='file://' + page)
    cdp.wait_for(ws, "window.py2dmol_viewers && Object.values(window.py2dmol_viewers)[0]"
                     " && Object.values(window.py2dmol_viewers)[0].renderer"
                     " && Object.values(window.py2dmol_viewers)[0].renderer.coords.length > 0", 45, 'renderer')
    ev(ws, "(window.py2dmolCartoonGPU && window.py2dmolCartoonGPU.setDirectPresent) ? window.py2dmolCartoonGPU.setDirectPresent(false) : 0", False)
    time.sleep(1.0)


def rotate(ws, angle):
    ev(ws, """(() => { const r = Object.values(window.py2dmol_viewers)[0].renderer;
      const a = %f, c = Math.cos(a), s = Math.sin(a); const Ry = [[c,0,s],[0,1,0],[-s,0,c]];
      const m = r.viewerState.rotation; const o = [[0,0,0],[0,0,0],[0,0,0]];
      for (let i=0;i<3;i++) for (let j=0;j<3;j++) for (let k=0;k<3;k++) o[i][j] += Ry[i][k]*m[k][j];
      r.viewerState.rotation = o; })()""" % angle, False)
    ev(ws, SETTLE)


SPAN2 = ("(() => { const r = Object.values(window.py2dmol_viewers)[0].renderer;"
         " const h = r._viewHalfSpan(r.objectsData[r.currentObjectName]); return [h.x, h.y]; })()")
# A wireframe that is really there covers thousands of pixels at 600 px; a view that is zoomed
# out far past what it needs covers a handful. The floor is stated once, so no check below can
# pass on a picture that is technically present and practically invisible.
MIN_WIRE_PX = 1000


def builds(ws):
    return ev(ws, 'window.__faceBuilds || 0', False)


def png_capture(ws):
    url = ev(ws, "Object.values(window.py2dmol_viewers)[0].renderer.toImage({format:'png',dataUrl:true,dpi:96,transparent:false}).then(o=>o.dataUrl)")
    return base64.b64decode(url.split(',', 1)[1])


WEB_SESSION = """(async () => {
  const until = async (f, ms) => { const t0 = performance.now();
    while (!f()) { if (performance.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); } };
  await window.processFiles([{name: 'h.pdb', readAsync: () => Promise.resolve(%(text)s)}], false);
  const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
  await until(() => r.coords && r.coords.length > 0, 30000);
  const P = window.py2dmolPlugins;
  const obj = r.currentObjectName;
  P.setPayload(r, 'wire', {options: {shown: true, level: 2},
    payloads: [{object: obj, frame: null, payload: {center: [0, 0, 0], half: 3}}]});
  const before = P.snapshot(r);
  const state = window.buildViewerState();
  const saved = JSON.parse(JSON.stringify(state.plugins || null));
  await window.loadViewerState(JSON.parse(JSON.stringify(state)));
  await until(() => r.coords && r.coords.length > 0, 30000);
  const replaced = P.snapshot(r);
  const bare = JSON.parse(JSON.stringify(state)); delete bare.plugins;
  await window.loadViewerState(bare);
  await until(() => r.coords && r.coords.length > 0, 30000);
  const cleared = P.snapshot(r);
  await window.loadViewerState(JSON.parse(JSON.stringify(state)));
  await until(() => r.coords && r.coords.length > 0, 30000);
  P.setOption(r, 'wire', 'mine', 7);
  await window.loadViewerState(JSON.parse(JSON.stringify(state)), {append: true});
  await until(() => Object.keys(r.objectsData).length > 1, 30000);
  const appended = P.snapshot(r);
  return JSON.stringify({obj, before, saved, replaced, cleared, appended,
                         objects: Object.keys(r.objectsData)});
})()"""


def web_session(ws, tmp):
    """THE WEBSITE'S SESSION FILE carries a viewer's plugin payloads, at the top level
    where Python's save_state writes them, and a load puts them back: replaced by a
    replacing load (a file with none leaves none), added beside by an append, with
    the object an append renamed followed."""
    text = open(structure_file(tmp)).read()
    ws.call('Page.navigate', url='file://' + os.path.join(ROOT, 'dev.html'))
    cdp.wait_for(ws, "typeof window.processFiles === 'function' && !!window.py2dmolPlugins"
                     " && !!(window.py2dmol_viewers || {})['standalone-viewer-1']", 60, 'dev.html')
    out = json.loads(ev(ws, WEB_SESSION % {'text': json.dumps(text)}))
    w = (out['saved'] or {}).get('wire') or {}
    ok(len(w.get('payloads') or []) == 1 and (w.get('options') or {}).get('level') == 2,
       '[web] the session file carries the viewer\'s plugin payload and options, under "plugins"')
    ok(out['replaced'] == out['before'], '[web] a replacing load puts the payloads back exactly')
    ok(out['cleared'] is None, '[web] ...and a file with no plugins leaves none (a replacing load replaces them)')
    ap = ((out['appended'] or {}).get('wire') or {}).get('payloads') or []
    names = [p.get('object') for p in ap]
    ok(len(ap) == 2 and names[0] == out['obj'] and names[1] != out['obj'] and names[1] in out['objects'],
       '[web] an append adds the file\'s payloads beside, bound to the object under its NEW name (%s)' % names)
    opts = ((out['appended'] or {}).get('wire') or {}).get('options') or {}
    ok(opts.get('mine') == 7 and opts.get('level') == 2,
       "[web] ...and layers the file's options over the viewer's rather than replacing them (%s)" % opts)


ORANGE = lambda r, g, b: r > 200 and 90 < g < 190 and b < 70
R0 = "Object.values(window.py2dmol_viewers)[0].renderer"


def tube_legs(ws, tmp, bundle, gpu, R):
    """THE TUBE DRAWS PLUGINS. The 2D tube lays each piece down between the segments by
    depth; the GPU tube carries lines and balls as capsule instances and hands a frame with a
    TRIANGLE to the 2D tube, which draws all three."""
    tag = ('gpu' if gpu else '2d') + ' tube'
    open_page(ws, make_page(tmp, bundle, gpu, 'after', 10, plugin=False, style='tube'))
    ev(ws, SETTLE)
    base = shot(ws, tag.replace(' ', '_') + '_baseline')
    ok(count(base, RED) == 0 and count(base, INK) > 2000, '[%s] baseline: no red, a structure is drawn' % tag)
    open_page(ws, make_page(tmp, bundle, gpu, 'after', 14, ball=1.0, style='tube'))
    ev(ws, SETTLE)
    ok(ev(ws, R0 + ".style", False) == 'tube', '[%s] the viewer is in the tube style' % tag)
    on = shot(ws, tag.replace(' ', '_') + '_wire')
    red = count(on, RED)
    ok(red >= MIN_WIRE_PX, '[%s] the plugin draws in the tube: %d red px' % (tag, red))
    ok(count(on, GREEN) > 40, '[%s] ...and its ball (%d green px)' % (tag, count(on, GREEN)))
    ok(ev(ws, 'window.py2dmolPlugins.errors(%s).length' % R0, False) == 0, '[%s] no plugin error' % tag)
    if gpu:
        ok(ev(ws, R0 + ".gpuDrewLastFrame", False) is True,
           '[%s] the GPU tube drew it, as capsules - it did not fall back to 2D' % tag)
        b0 = ev(ws, 'window.__tubeBuilds || 0', False)
        rotate(ws, 0.6)
        ok(count(shot(ws, tag.replace(' ', '_') + '_rot'), RED) >= MIN_WIRE_PX
           and ev(ws, 'window.__tubeBuilds || 0', False) == b0,
           '[%s] turning the model keeps the wireframe with NO instance rebuild' % tag)
        rotate(ws, -0.6)
    ev(ws, "window.py2dmolPlugins.setOption(%s, 'wire', 'shown', false)" % R0, False)
    ev(ws, SETTLE)
    ok(count(shot(ws, tag.replace(' ', '_') + '_off'), RED) == 0, '[%s] an option takes it off' % tag)
    ev(ws, "window.py2dmolPlugins.setOption(%s, 'wire', 'shown', true)" % R0, False)
    ev(ws, SETTLE)
    back = shot(ws, tag.replace(' ', '_') + '_back')
    ok(count(back, RED) >= MIN_WIRE_PX, '[%s] ...and back' % tag)
    ev(ws, "window.py2dmolPlugins.setOption(%s, 'wire', 'ink', true)" % R0, False)
    ev(ws, SETTLE)
    nd = differ(back, shot(ws, tag.replace(' ', '_') + '_ink'))
    ok(nd > 500, '[%s] ink:true gives the strokes a rim (%d px differ)' % (tag, nd))
    ev(ws, "window.py2dmolPlugins.setOption(%s, 'wire', 'ink', false)" % R0, False)
    ev(ws, SETTLE)
    nd0 = differ(back, shot(ws, tag.replace(' ', '_') + '_noink'))
    ok(nd0 < 50, '[%s] ...and ink:false takes it off again (%d px differ)' % (tag, nd0))
    # A TRIANGLE: the 2D tube fills it; the GPU tube has no shape for one and gives the
    # frame to the 2D tube, which then draws the lines and the ball too
    ev(ws, "window.py2dmolPlugins.setOption(%s, 'wire', 'tri', true)" % R0, False)
    ev(ws, SETTLE)
    tri = shot(ws, tag.replace(' ', '_') + '_tri')
    ok(count(tri, ORANGE) > 2000 and count(tri, RED) > 0.5 * MIN_WIRE_PX,
       '[%s] a plugin triangle is filled (%d orange px) and the lines stay (%d red px)'
       % (tag, count(tri, ORANGE), count(tri, RED)))
    if gpu:
        ok(ev(ws, R0 + ".gpuDrewLastFrame", False) is False,
           '[%s] ...because a triangle sends the frame to the 2D tube' % tag)
    ev(ws, "window.py2dmolPlugins.setOption(%s, 'wire', 'tri', false)" % R0, False)
    ev(ws, SETTLE)
    if gpu:
        ok(ev(ws, R0 + ".gpuDrewLastFrame", False) is True,
           '[%s] ...and the GPU takes the frame back when the triangle goes' % tag)
    # DEPTH: the structure runs through the cube, so its near segments cover the cube's
    # far edges. Painted over everything instead, the cube would show exactly as much red
    # with the structure there as without it.
    with_s = count(shot(ws, tag.replace(' ', '_') + '_depth_with'), RED)
    # ...taken away in the way that keeps each painter on its own path: the GPU tube FADES
    # it (hidden, it has no segments to build and hands the frame to 2D), and the 2D tube,
    # which does not ghost, HIDES it
    gone, back_ = ((".setOpacity(null, 0)", ".setOpacity(null, 1)") if gpu else
                   (".setVisibility({positions: [0], visibilityMode: 'explicit'})", ".resetVisibility()"))
    ev(ws, R0 + gone, False)
    ev(ws, SETTLE)
    without = count(shot(ws, tag.replace(' ', '_') + '_depth_without'), RED)
    if gpu:
        ok(ev(ws, R0 + ".gpuDrewLastFrame", False) is True, '[%s] (the faded frame is still the GPU\'s)' % tag)
    ev(ws, R0 + back_, False)
    ev(ws, SETTLE)
    ok(without - with_s > 30, '[%s] the structure hides the cube edges behind it (%d red px with it, %d without)'
       % (tag, with_s, without))
    # A CUBE LARGER THAN THE STRUCTURE is not clipped by the depth range
    open_page(ws, make_page(tmp, bundle, gpu, 'after', 45, style='tube'))
    ev(ws, SETTLE)
    big = count(shot(ws, tag.replace(' ', '_') + '_big'), RED)
    R[tag + '_big'] = big
    ok(big >= MIN_WIRE_PX, '[%s] a cube larger than the structure is drawn (%d red px)' % (tag, big))


def main():
    tmp = tempfile.mkdtemp()
    bundle, which = bundle_path(tmp)
    print('bundle:', which, '\nshots in', OUT, flush=True)
    R = {}
    proc, ws = launch()
    try:
        for gpu in (0, 1):
            tag = 'gpu' if gpu else '2d'
            # ---------------------------------------------- baseline: no plugin at all
            open_page(ws, make_page(tmp, bundle, gpu, 'after', 10, plugin=False))
            ev(ws, SETTLE)
            base = shot(ws, tag + '_baseline')
            ok(count(base, RED) == 0 and count(base, INK) > 2000, '[%s] baseline: no red, and a structure is drawn (%d ink px)'
               % (tag, count(base, INK)))
            bx, by = ev(ws, SPAN2, False)            # what the structure alone frames
            print('    [%s] the structure alone: half-span %.1f x %.1f A' % (tag, bx, by), flush=True)
            ok(ev(ws, 'window.py2dmolPlugins ? window.py2dmolPlugins.list.length : -1', False) == 0,
               '[%s] the registry is in the bundle and empty' % tag)
            useGPU = ev(ws, 'Object.values(window.py2dmol_viewers)[0].renderer.useGPU', False)
            ok(bool(useGPU) == bool(gpu), '[%s] the painter under test is the one asked for (useGPU=%s)' % (tag, useGPU))

            # ---------------------------------------------- the plugin, after the library
            open_page(ws, make_page(tmp, bundle, gpu, 'after', 14, ball=1.0))
            ev(ws, SETTLE)
            on = shot(ws, tag + '_wire')
            red = count(on, RED)
            ok(red >= MIN_WIRE_PX, '[%s] a wireframe cube in the plugin\'s colour appears and is visible: %d red px, at least %d at 600 px (none without it)' % (tag, red, MIN_WIRE_PX))
            wx, wy = ev(ws, SPAN2, False)
            shell = 14 * math.sqrt(3)
            cap_hi = 1.2 * max(shell, bx, by)
            ok(shell - 0.5 <= wx <= cap_hi and shell - 0.5 <= wy <= cap_hi,
               '[%s] the fit is TIGHT on both axes: half-span %.1f x %.1f A, between the shell radius %.1f and 1.2 x max(structure %.1f x %.1f, shell) = %.1f'
               % (tag, wx, wy, shell, bx, by, cap_hi))
            ok(count(on, GREEN) > 40, '[%s] ...and its ball (%d green px)' % (tag, count(on, GREEN)))
            ok(ev(ws, 'window.py2dmolPlugins.errors(Object.values(window.py2dmol_viewers)[0].renderer).length', False) == 0,
               '[%s] no plugin error' % tag)
            # ...AND NO RESIDUE'S OPACITY REACHES IT. A plugin's ball and triangle
            # belong to no residue; on the GPU they were filed under residue 0, and
            # the per-residue coverage texture the fill shader reads is set_opacity's
            # - so fading residue 0 out took the ball with it while the 2D painter
            # kept it. (Hiding is a rebuild that drops the residue's geometry and
            # never asks the texture, so it is opacity that reaches this.)
            g0 = count(on, GREEN)
            ev(ws, "Object.values(window.py2dmol_viewers)[0].renderer.setOpacity({positions: [0]}, 0)", False)
            ev(ws, SETTLE)
            hid = shot(ws, tag + '_res0_faded')
            ok(count(hid, GREEN) > 0.8 * g0, "[%s] fading residue 0 out leaves the plugin's ball drawn (%d green px, %d before)"
               % (tag, count(hid, GREEN), g0))
            ev(ws, "Object.values(window.py2dmol_viewers)[0].renderer.setOpacity({positions: [0]}, 1)", False)
            ev(ws, SETTLE)
            # ...AND A LIVE UPDATE REACHES IT. This is the handler Python's incremental
            # update calls, handed the viewer block _plugin_delta builds: an option
            # with no payloads (the mesh stays), then a plugin the page has never had,
            # which arrives with its source.
            LIVE = "Object.values(window.py2dmol_viewers)[0].handleIncrementalStateUpdate({}, {}, null, %s)"
            ev(ws, LIVE % json.dumps({'plugins': {'wire': {'options': {'shown': False}}}}), False)
            ev(ws, SETTLE)
            ok(count(shot(ws, tag + '_live_off'), RED) == 0, '[%s] live: an option sent after show() takes the wireframe off' % tag)
            ev(ws, LIVE % json.dumps({'plugins': {'wire': {'options': {'shown': True}}}}), False)
            ev(ws, SETTLE)
            back = shot(ws, tag + '_live_on')
            ok(count(back, RED) >= MIN_WIRE_PX,
               '[%s] live: ...and back, from the payload the page already held' % tag)
            ctr = centre_of(structure_file(tmp))
            dot_src = ("(function(){var P=window.py2dmolPlugins=window.py2dmolPlugins||{list:[],pending:[]};"
                       "var d={name:'livedot',version:'1',apiVersion:1,prims:function(c){c.payloads.forEach("
                       "function(p){c.dot(p.payload.at,{color:[0,0,255],radius:3});});}};"
                       "if(P.register)P.register(d);else P.pending.push(d);})();")
            ev(ws, LIVE % json.dumps({'plugins': {'livedot': {'source': dot_src, 'options': {}, 'apiVersion': 1,
                'payloads': [{'object': None, 'frame': None, 'payload': {'at': ctr}}]}}}), False)
            ev(ws, SETTLE)
            nd = differ(back, shot(ws, tag + '_live_new'))
            ok(nd > 200, '[%s] live: a plugin first added after show() arrives with its source and draws (%d px changed)'
               % (tag, nd))
            # ...and the next add_plugin arrives as a TAIL: the new payload alone, after
            # the one the page has (_plugin_delta's payloads_from)
            ev(ws, LIVE % json.dumps({'plugins': {'livedot': {'options': {}, 'payloads_from': 1,
                'payloads': [{'object': None, 'frame': None, 'payload': {'at': [ctr[0] + 4, ctr[1], ctr[2]]}}]}}}), False)
            ev(ws, SETTLE)
            npl = ev(ws, "window.py2dmolPlugins.snapshot(Object.values(window.py2dmol_viewers)[0].renderer)"
                         ".livedot.payloads.length")
            ok(npl == 2, '[%s] live: a payload tail is APPENDED to what the page holds (%s payloads)' % (tag, npl))
            api = ev(ws, "window.py2dmolPlugins.snapshot(Object.values(window.py2dmol_viewers)[0].renderer)"
                         ".livedot.apiVersion")
            ok(api == 1, '[%s] live: the payload\'s apiVersion arrives, as it does on the static path (%s)' % (tag, api))
            ev(ws, "window.py2dmolPlugins.restore(Object.values(window.py2dmol_viewers)[0].renderer,"
                   " {wire: window.py2dmolPlugins.snapshot(Object.values(window.py2dmol_viewers)[0].renderer).wire},"
                   " {replace: true})", False)
            ev(ws, SETTLE)
            cap = png_capture(ws)
            ok(count(cap, RED) >= MIN_WIRE_PX, '[%s] ...in a PNG capture too (%d red px)' % (tag, count(cap, RED)))
            if not gpu:
                svg = ev(ws, "Object.values(window.py2dmol_viewers)[0].renderer.toImage({format:'svg'}).then(o=>o.text)")
                open(os.path.join(OUT, tag + '_wire.svg'), 'w').write(svg)
                n_svg = len(re.findall(r'(?i)rgb\(\s*255\s*,\s*0\s*,\s*255\s*\)|#ff00ff', svg))
                ok(n_svg > 0, '[%s] ...and in an SVG capture (%d strokes in the plugin colour)' % (tag, n_svg))
            if gpu:
                ok(ev(ws, 'window.__gpuPaletteComplete', False) is True,
                   '[%s] the plugin\'s ball does not cost the structure its cheap recolour (__gpuPaletteComplete)' % tag)

            # ---------------------------------------------- rotation
            b0 = builds(ws)
            rotate(ws, 0.9)
            rot = shot(ws, tag + '_wire_rot')
            ok(count(rot, RED) >= MIN_WIRE_PX and rot != on, '[%s] after a rotation the wireframe is still there, and has moved (%d red px)'
               % (tag, count(rot, RED)))
            if gpu:
                ok(builds(ws) == b0, '[%s] ...with NO mesh rebuild (__faceBuilds %s -> %s)' % (tag, b0, builds(ws)))
            rotate(ws, -0.9)

            # ---------------------------------------------- the key
            b1 = builds(ws)
            ev(ws, "window.py2dmolPlugins.setOption(Object.values(window.py2dmol_viewers)[0].renderer, 'wire', 'shown', false)", False)
            ev(ws, SETTLE)
            gone = shot(ws, tag + '_wire_off')
            ok(count(gone, RED) == 0, '[%s] changing an option changes the key: the wireframe disappears (%d red px)'
               % (tag, count(gone, RED)))
            ev(ws, "window.py2dmolPlugins.setOption(Object.values(window.py2dmol_viewers)[0].renderer, 'wire', 'shown', true)", False)
            ev(ws, SETTLE)
            back = shot(ws, tag + '_wire_back')
            ok(count(back, RED) >= MIN_WIRE_PX, '[%s] ...and comes back (%d red px)' % (tag, count(back, RED)))
            if gpu:
                ok(builds(ws) >= b1 + 2, '[%s] ...each through a rebuild (__faceBuilds %s -> %s)' % (tag, b1, builds(ws)))

            # ---------------------------------------------- the ink toggle: the same geometry, a different part
            # A plugin stroke with and without its dark border is the SAME points; the GPU caches the
            # mesh part that holds it under a hash of the strokes, and that hash must know about ink.
            plain = back
            P_SET = "window.py2dmolPlugins.setOption(Object.values(window.py2dmol_viewers)[0].renderer, 'wire', 'ink', %s)"
            ev(ws, P_SET % 'true', False)
            ev(ws, SETTLE)
            inked = shot(ws, tag + '_wire_ink')
            d_on = differ(inked, plain)
            ok(d_on > 150, '[%s] ink:true draws the border: %d px differ from the same view without it' % (tag, d_on))
            ev(ws, P_SET % 'false', False)
            ev(ws, SETTLE)
            d_back = differ(shot(ws, tag + '_wire_ink_off'), plain)
            ok(d_back < 60, '[%s] ...and ink:false takes it off again (%d px differ from before)' % (tag, d_back))

            # ---------------------------------------------- a cube LARGER than the structure
            open_page(ws, make_page(tmp, bundle, gpu, 'after', 26))
            ev(ws, SETTLE)
            big = shot(ws, tag + '_bigcube')
            R[tag + '_big'] = count(big, RED)
            print('    [%s] big cube: %d red px' % (tag, R[tag + '_big']), flush=True)
            # ...FRAMED: the opening orient of the viewer wrote a view span, and it includes the shell
            ok(edge_count(big) == 0, '[%s] the fit frames a plugin larger than the structure - nothing is cropped at the canvas edge (%d px)'
               % (tag, edge_count(big)))
            SPAN = "(() => { const r = Object.values(window.py2dmol_viewers)[0].renderer; return r._viewHalfSpan(r.objectsData[r.currentObjectName]).x; })()"
            ORIENT = "window.py2dmolOrient.orientToBestView(Object.values(window.py2dmol_viewers)[0].renderer, %s)"
            full = ev(ws, SPAN, False)
            fx, fy = ev(ws, SPAN2, False)
            big_shell = 26 * math.sqrt(3)
            big_hi = 1.2 * max(big_shell, bx, by)
            ok(big_shell - 0.5 <= fx <= big_hi and big_shell - 0.5 <= fy <= big_hi,
               '[%s] the opening span holds the shell and is no looser than needed on EITHER axis: %.1f x %.1f A, shell radius %.1f, limit %.1f'
               % (tag, fx, fy, big_shell, big_hi))
            ok(R[tag + '_big'] >= MIN_WIRE_PX, '[%s] the big cube is visible: %d red px' % (tag, R[tag + '_big']))
            # ...and a FOCUS is not floored at the plugin's radius: one residue zooms in tight
            ev(ws, ORIENT % "{positions: [3, 4, 5], animate: false}", False)
            ev(ws, SETTLE)
            tight = ev(ws, SPAN, False)
            ok(0 < tight < 20, '[%s] focusing on a few residues zooms in tight, closer than the shell (half-span %.1f)' % (tag, tight))
            ev(ws, ORIENT % "{animate: false}", False)
            ev(ws, SETTLE)
            home = ev(ws, SPAN, False)
            ok(26 * math.sqrt(3) - 0.5 <= home <= big_hi, '[%s] orienting to everything after a tight orient frames the shell again, and no looser than the opening fit (half-span %.1f, limit %.1f)' % (tag, home, big_hi))
            # ...and a payload handed over AFTER the orient re-frames a whole-scene view: py2Dmol.show() orients
            # before a host's setPayload, and a live add_plugin() arrives after show(). Grows, then shrinks back.
            RESIZE = ("(() => { const P = window.py2dmolPlugins, r = Object.values(window.py2dmol_viewers)[0].renderer;"
                      " const d = P.snapshot(r).wire; d.payloads[0].payload.half = %s; P.setPayload(r, 'wire', d); })()")
            ev(ws, RESIZE % 80, False)
            ev(ws, SETTLE)
            grown = ev(ws, SPAN, False)
            ok(grown >= 80 * math.sqrt(3) - 0.5, '[%s] a bigger payload after the orient widens the whole-scene span (half-span %.1f, shell %.1f)'
               % (tag, grown, 80 * math.sqrt(3)))
            ev(ws, RESIZE % 26, False)
            ev(ws, SETTLE)
            shrunk = ev(ws, SPAN, False)
            ok(abs(shrunk - full) < 0.5, '[%s] ...and the original payload puts it back to the opening span (half-span %.1f against %.1f)' % (tag, shrunk, full))

            # ---------------------------------------------- one cap per painter: 10,008 strokes
            # The GPU draws what the 2D painter may not (caps 60,000 and 8,000), and an SVG export is
            # ALWAYS the 2D painter: it must say so in the file, and must not make the GPU rebuild.
            open_page(ws, make_page(tmp, bundle, gpu, 'after', 14, subdiv=834))
            ev(ws, SETTLE)
            many = count(shot(ws, tag + '_10k'), RED)
            if gpu:
                ok(many >= MIN_WIRE_PX, '[gpu] 10,008 strokes are inside the GPU cap and are drawn (%d red px)' % many)
                k0 = ev(ws, 'window.py2dmolPlugins.key(Object.values(window.py2dmol_viewers)[0].renderer)', False)
                b2 = builds(ws)
                svg = ev(ws, "Object.values(window.py2dmol_viewers)[0].renderer.toImage({format:'svg'}).then(o=>o.text)")
                open(os.path.join(OUT, tag + '_10k.svg'), 'w').write(svg)
                ok(re.search(r'<!-- py2dmol plugin wire not drawn: [^>]*maxPrims=8000[^>]*-->', svg) is not None,
                   '[gpu] the SVG export carries a comment saying the plugin was not drawn, and why')
                ev(ws, SETTLE)
                ok(ev(ws, 'window.py2dmolPlugins.key(Object.values(window.py2dmol_viewers)[0].renderer)', False) == k0,
                   '[gpu] the export did not move the registry key')
                ok(builds(ws) == b2, '[gpu] ...and did not make the GPU rebuild (__faceBuilds %s -> %s)' % (b2, builds(ws)))
                ok(count(shot(ws, tag + '_10k_after'), RED) >= MIN_WIRE_PX, '[gpu] ...and the viewer still draws all of it afterwards')
            else:
                ok(many == 0 and ev(ws, "window.py2dmolPlugins.errors(Object.values(window.py2dmol_viewers)[0].renderer).some(e => e.painter === '2d')", False),
                   '[2d] 10,008 strokes are over the 2D cap: nothing drawn, and an error state says why (%d red px)' % many)

            # ---------------------------------------------- registration orders
            for order in ('before', 'late'):
                open_page(ws, make_page(tmp, bundle, gpu, order, 14))
                if order == 'late':
                    ev(ws, SETTLE)
                    none = count(shot(ws, tag + '_late_before'), RED)
                    ok(none == 0, '[%s] late: before the plugin registers, nothing is drawn (%d red px)' % (tag, none))
                    n0 = ev(ws, 'window.py2dmolPlugins.list.length', False)
                    ev(ws, PLUGIN_JS, False)
                    ok(ev(ws, 'window.py2dmolPlugins.list.length', False) == n0 + 1,
                       '[%s] late: registering from the console after the viewer is drawing does not throw' % tag)
                ev(ws, SETTLE)
                got = count(shot(ws, tag + '_' + order), RED)
                ok(got >= MIN_WIRE_PX, '[%s] plugin registered %s the library: it draws (%d red px)' % (tag, order.upper(), got))
        for gpu in (0, 1):
            tube_legs(ws, tmp, bundle, gpu, R)
        web_session(ws, tmp)
    finally:
        proc.kill()
    # the GPU depth-range regression: the big cube is not clipped, measured against the
    # painter with no depth range at all
    if R.get('2d_big'):
        ratio = R['gpu_big'] / float(R['2d_big'])
        ok(ratio > 0.88, 'GPU depth range: a cube larger than the structure is NOT clipped (GPU %d px vs 2D %d px, ratio %.2f)'
           % (R['gpu_big'], R['2d_big'], ratio))
    if R.get('2d tube_big'):
        ratio = R['gpu tube_big'] / float(R['2d tube_big'])
        ok(ratio > 0.88, 'GPU tube depth range: a cube larger than the structure is NOT clipped'
           ' (GPU %d px vs 2D %d px, ratio %.2f)' % (R['gpu tube_big'], R['2d tube_big'], ratio))
    print('browser probe:', 'FAILED %d' % bad if bad else 'ok')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
