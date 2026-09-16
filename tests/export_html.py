"""Four exported files, opened one at a time: do they draw?

    python3 tests/export_html.py

🔴 THREE OF FOUR CAME UP BLANK, and this is the gate for why. Library sharing
is decided per KERNEL: the first show() of a process writes the bundle and
records that it has lent one, and every later viewer writes a two-line request
for it instead - correct in a notebook, where all of them are on one page.
Export those viewers to four separate .html files and three of them ask a page
with no lender on it. The bootstrap waits for `initializePy2DmolViewer` to
appear, it never does, and the file opens blank with nothing in the console to
say why. Reported from a conference-talk build; the caller's repair was to
reach past the public API for `_share_library = False`.

WHAT IS MEASURED. FOUR viewers from ONE process - the shape that breaks, since
one export can never borrow - written with save_html(), then each opened in a
browser ON ITS OWN and asked whether there is ink on its canvas. Not whether
the file contains a bundle: a page can carry the library and still not draw.

  * `inline`, the default: every file draws, from a file:// URL with no server.
  * `external`: every file draws, the bundle is written ONCE beside them, and
    the four pages are each smaller than one inline page by roughly the size of
    the library.
  * A STALE external reference FAILS LOUDLY. The name carries the bundle's
    content hash, so a rebuilt library cannot be silently borrowed by a page
    written against the old one - it is a 404, and the page says so in words
    instead of coming up empty. Measured by renaming the bundle away and
    reading the text on the page.

🔴 AND THE CONTROL ARM IS THE BUG ITSELF. One leg exports with sharing left on,
the way it was before to_html() existed, and REQUIRES the later files to be
blank. A gate that only watches the fixed path passes just as well against a
build where nothing draws for another reason.
"""
import http.server, json, os, re, shutil, socketserver, sys, tempfile, threading, time, types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import launch, evaluate, wait_for  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DBG = 9669, 9232
NVIEWS = 4

CELLS = []
try:
    import IPython.display  # noqa: F401
except ImportError:
    _disp = types.ModuleType('IPython.display')

    class _H:
        def __init__(self, data): CELLS.append(data)

    for _n, _v in (('display', lambda *a, **k: None), ('HTML', _H),
                   ('Javascript', _H), ('update_display', lambda *a, **k: None)):
        setattr(_disp, _n, _v)
    _ip = types.ModuleType('IPython'); _ip.display = _disp
    sys.modules['IPython'] = _ip; sys.modules['IPython.display'] = _disp
sys.path.insert(0, ROOT)
import py2Dmol  # noqa: E402

OUT = tempfile.mkdtemp(prefix='py2dmol-export-')
FIXTURE = os.path.join(ROOT, '1UBQ.cif')


def export(subdir, bundle, share):
    """Four viewers, ONE process - which is the shape that breaks."""
    d = os.path.join(OUT, subdir)
    os.makedirs(d, exist_ok=True)
    names = []
    for i in range(NVIEWS):
        v = py2Dmol.view((320, 240), id=f'x{subdir}{i}')
        v.add_pdb(FIXTURE, name=f'obj{i}', use_biounit=False)
        path = os.path.join(d, f'v{i}.html')
        if share:
            # THE OLD WAY, kept as the control: capture what show() emits, with
            # sharing left exactly as a notebook has it.
            del CELLS[:]
            v.show()
            body = "\n".join(c for c in CELLS if isinstance(c, str))
            open(path, 'w').write('<!doctype html><meta charset="utf-8">'
                                  '<body style="margin:0">' + body + '</body>')
        else:
            v.save_html(path, bundle=bundle)
        names.append(path)
    return d, names


INK = """(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    // the viewer's canvas, and under it by default the GPU painter's layer
    // (cartoon/paintgl.js, direct presentation): read together
    const cv = document.querySelector('canvas:not([data-py2dmol-layer])');
    const layer = cv && cv.nextElementSibling && cv.nextElementSibling.tagName === 'CANVAS' ? cv.nextElementSibling : null;
    let c = cv;
    if (cv && layer) { c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const x = c.getContext('2d'); x.drawImage(layer, 0, 0); x.drawImage(cv, 0, 0); }
    if (c && c.width > 0) {
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      let ink = 0;
      if (gl) {
        const px = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < px.length; i += 4)
          if (px[i] !== px[0] || px[i+1] !== px[1] || px[i+2] !== px[2]) ink += 1;
      } else {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4)
          if (d[i+3] > 0 && (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250)) ink += 1;
      }
      if (ink > 0) return JSON.stringify({ink, lib: typeof initializePy2DmolViewer});
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return JSON.stringify({ink: 0, lib: typeof initializePy2DmolViewer,
                         text: (document.body.innerText || '').slice(0, 200)});
})()"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=OUT, **k)
    def log_message(self, *a): pass


bad = []
results = {}
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
chrome, ws = launch(DBG, "/tmp/py2dmol-export")
try:
    ws.call("Page.enable"); ws.call("Runtime.enable")

    def open_each(subdir, names):
        out = []
        for p in names:
            rel = os.path.relpath(p, OUT).replace(os.sep, '/')
            # ONE FILE AT A TIME, and a blank page between them: two exports
            # left open in one browser can lend to each other over
            # BroadcastChannel, which is the whole mechanism under test.
            ws.call("Page.navigate", url="about:blank")
            time.sleep(0.3)
            ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/{rel}")
            out.append(json.loads(evaluate(ws, INK)))
        return out

    for tag, bundle, share in (('inline', 'inline', False),
                               ('external', 'external', False),
                               ('shared', 'inline', True)):
        d, names = export(tag, bundle, share)
        res = open_each(tag, names)
        sizes = [os.path.getsize(p) for p in names]
        results[tag] = {'ink': [r['ink'] for r in res],
                        'lib': [r['lib'] for r in res],
                        'kb': [round(s / 1024) for s in sizes],
                        'dir': d,
                        'text': [r.get('text', '') for r in res]}

    # ...and the stale reference, which must say so rather than draw nothing
    d = results['external']['dir']
    js = [f for f in os.listdir(d) if f.endswith('.min.js')]
    results['externalFiles'] = js
    if js:
        os.rename(os.path.join(d, js[0]), os.path.join(d, 'moved-away.js'))
        ws.call("Page.navigate", url="about:blank"); time.sleep(0.3)
        ws.call("Page.navigate", url=f"http://127.0.0.1:{PORT}/external/v0.html")
        time.sleep(2.0)
        results['staleText'] = evaluate(
            ws, "(document.body.innerText || '').slice(0, 300)")
finally:
    chrome.kill(); httpd.shutdown()

for tag in ('inline', 'external', 'shared'):
    r = results[tag]
    print(f"  {tag:>8}: ink {r['ink']}  lib {r['lib']}  {r['kb']} KB")
print(f"  external bundle files: {results.get('externalFiles')}")
print(f"  stale reference says: {str(results.get('staleText'))[:120]!r}")

for tag in ('inline', 'external'):
    blank = [i for i, n in enumerate(results[tag]['ink']) if not n]
    if blank:
        bad.append(f"{tag}: exports {blank} of {NVIEWS} drew nothing"
                   f" - lib {results[tag]['lib']}, page said"
                   f" {results[tag]['text'][blank[0]]!r}")
# THE CONTROL. Sharing left on, one process, separate files: the first can
# draw and the rest cannot. If they all draw, this probe is not opening the
# files the way the report did and nothing below it means anything.
if all(results['shared']['ink']):
    bad.append("with library sharing left on, all four separate files still"
               " drew - the probe is not reproducing the fault it exists for")
if len(results.get('externalFiles') or []) != 1:
    bad.append(f"external mode wrote {results.get('externalFiles')} beside the"
               " pages - four exports of one bundle should share one file")
inline_kb, external_kb = results['inline']['kb'][0], results['external']['kb'][0]
if external_kb >= inline_kb / 2:
    bad.append(f"an external-bundle page is {external_kb} KB against"
               f" {inline_kb} KB inline - it is still carrying the library")
stale = str(results.get('staleText') or '')
if 'py2Dmol' not in stale or 'renderer' not in stale:
    bad.append("a page whose external bundle is missing said"
               f" {stale[:80]!r} - a stale reference must fail in words, not"
               " as an empty box")

shutil.rmtree(OUT, ignore_errors=True)
print()
for b in bad:
    print("FAIL: " + b)
print("export_html: " + ("FAILED" if bad else "ok"))
sys.exit(1 if bad else 0)
