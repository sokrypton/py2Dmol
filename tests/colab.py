"""COLAB PUTS EVERY CELL OUTPUT IN ITS OWN IFRAME, and that is the whole test.

    python3 tests/colab.py

The notebook's live path - show() first, then add() in later cells - works in
Jupyter for a reason that does not survive Colab: everything is one document,
so the script an add() writes finds `window.py2dmol_viewers[vid]` sitting there
and calls it directly. Colab renders each output in a separate iframe. The
direct call finds nothing, the mailbox <script> node is in another document
where no MutationObserver of ours can see it, and BroadcastChannel - same
origin, different document - is the ONLY bridge left standing.

None of that needs Colab to test. It needs one iframe per cell output, served
from one origin, which is what this builds: IPython's display() is stubbed to
collect what viewer.py emits, cell by cell, and each captured output becomes an
iframe of its own. The real viewer.py, the real bundle, the real channel.

WHAT IT CHECKS, and each of the three was a live fault before it existed:

  * the frames arrive at all - three add() calls, three frames, ink on the
    canvas - through a channel and nothing else. Neuter BroadcastChannel and
    this goes to zero, which is how the check was verified;
  * they arrive WHEN THE VIEWER IS LAST TO WAKE. BroadcastChannel does not
    retain, so a post made before the viewer opened its channel was lost for
    good, and on a notebook REOPEN that is the ordinary case rather than a
    corner: every output iframe loads at once and the viewer's is half a
    megabyte against an update cell's kilobyte. The viewer announces itself
    with `viewerReady` - which was sent and listened for by nobody for as long
    as it existed - and the update cells post again on hearing it;
  * they arrive IN ORDER when the replay is not. `seq` is a watermark and an
    early frame arriving after a later one is dropped as stale, so a reopen
    that happened to run the iframes backwards kept one frame out of three.
    The viewer holds what arrives inside its replay window and applies it
    sorted.

AND THAT A REOPENED NOTEBOOK NEEDS NO NETWORK, which is the other half of what
the reader was promised: the emitted HTML names no external script, stylesheet
or font, and fetches nothing.

WHAT THIS CANNOT COVER. Colab's frontend is not open source - googlecolab/
colabtools is the Python client library only - so its sandbox attributes, its
CSP and its output-size limits are not reproduced here. What is reproduced is
the shape that breaks us: separate documents, one origin, arbitrary order.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time, types

ROOT = '/Users/mini/Documents/GitHub/py2Dmol'
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
NADD = 3

# --- a notebook front end, in twenty lines -----------------------------------
# display() returns a handle whose update() overwrites the cell it made. That
# is the whole of the contract viewer.py uses, and reproducing it is what lets
# persistence=True (one cell per add) and persistence=False (one mailbox cell,
# overwritten) come out of the real code rather than a description of it.
CELLS = []


class _Handle:
    def __init__(self, idx):
        self.idx = idx

    def update(self, obj):
        CELLS[self.idx]['html'] = obj._html


class _HTML:
    def __init__(self, s):
        self._html = s


def _display(obj, display_id=None):
    CELLS.append({'id': display_id, 'html': getattr(obj, '_html', str(obj))})
    return _Handle(len(CELLS) - 1)


def _update_display(obj, display_id=None):
    for c in CELLS:
        if c['id'] == display_id:
            c['html'] = obj._html


_disp = types.ModuleType('IPython.display')
_disp.display = _display
_disp.HTML = _HTML
_disp.Javascript = lambda *a, **k: None
_disp.update_display = _update_display
_ip = types.ModuleType('IPython')
_ip.display = _disp
sys.modules['IPython'] = _ip
sys.modules['IPython.display'] = _disp
sys.path.insert(0, ROOT)
import numpy as np                                          # noqa: E402
import py2Dmol                                              # noqa: E402


def build_cells(persistence=True):
    """A live session: show() with nothing in it, then three add() calls.

    align=False on purpose - the browser superposes each frame on the one
    before it otherwise, and then the z of the first atom no longer says which
    frame this is, which is how the ORDER is checked below.
    """
    del CELLS[:]
    v = py2Dmol.view(persistence=persistence)
    v.show()
    for k in range(NADD):
        t = np.linspace(0, 4 * np.pi, 30)
        coords = np.stack([np.cos(t) * 5, np.sin(t) * 5, t * 1.5 + 100 * k], axis=1)
        v.add(coords, align=False)
    return [c['html'] for c in CELLS]


# --- the page ----------------------------------------------------------------
DOC = '<!doctype html><meta charset="utf-8"><body style="margin:0">%s'

HOST_JS = """
<script>
// FIND THE VIEWER, THEN WAIT - never the clock alone. A flat sleep long
// enough on an idle machine is not long enough when run.sh has six browsers
// going at once, and each of these iframes is half a megabyte of inlined
// bundle. This waits for a viewer to exist, and only then spends the fixed
// settle the replay window (800 ms inside parts/ui.js) actually needs.
const viewerIn = (fr) => {
  for (const f of fr) {
    try {
      const vs = f.contentWindow.py2dmol_viewers;
      if (vs && Object.keys(vs).length) return true;
    } catch (e) { /* not loaded yet */ }
  }
  return false;
};

window.addEventListener('load', async () => {
  const fr0 = [...document.querySelectorAll('iframe')];
  const t0 = performance.now();
  while (!viewerIn(fr0) && performance.now() - t0 < 25000) {
    await new Promise(r => setTimeout(r, 100));
  }
  // ...and then the replay window, plus room for the frames it drains
  await new Promise(r => setTimeout(r, 2000));
  const out = {frames: -1, ink: 0, zs: [], meta: null, objs: {}, err: null, where: -1,
               withApi: 0, waited: Math.round(performance.now() - t0)};
  try {
    const fr = [...document.querySelectorAll('iframe')];
    for (let i = 0; i < fr.length; i++) {
      const w = fr[i].contentWindow;
      const vs = w.py2dmol_viewers;
      if (!vs || !Object.keys(vs).length) continue;
      out.withApi++;
      if (out.where >= 0) continue;
      out.where = i;
      const r = vs[Object.keys(vs)[0]].renderer;
      const obj = Object.values(r.objectsData)[0];
      out.frames = obj ? obj.frames.length : 0;
      if (obj) {
        out.zs = obj.frames.map(f => (f.coords && f.coords[0]) ? f.coords[0][2] : null);
        const read = (o) => ({
          color: o.color ? (o.color.value || o.color.type) : null,
          contacts: o.contacts ? o.contacts.length : 0,
          bonds: o.bonds ? o.bonds.length : 0,
          sse: o.sse ? Object.keys(o.sse).length : 0,
          frameColors: o.frames.map(f => (f.color && f.color.value) || null),
        });
        out.meta = read(obj);
        for (const [n, o] of Object.entries(r.objectsData)) out.objs[n] = read(o);
      }
      // INK IS PIXELS UNLIKE THE CORNER, not pixels with alpha. The
      // background is opaque, so an alpha count returns the canvas area
      // whatever is drawn on it - 398 x 398 = 158404 every single time,
      // in a run with three frames and in a run with none.
      const cv = w.document.querySelector('canvas');
      if (cv) {
        const g = cv.getContext('2d');
        if (g && g.getImageData) {
          const d = g.getImageData(0, 0, cv.width, cv.height).data;
          const b = [d[0], d[1], d[2]];
          for (let p = 0; p < d.length; p += 4) {
            if (Math.abs(d[p] - b[0]) + Math.abs(d[p + 1] - b[1])
                + Math.abs(d[p + 2] - b[2]) > 24) out.ink++;
          }
        } else out.ink = -1;
      }
    }
  } catch (e) { out.err = String((e && e.stack) || e); }
  await fetch('/_result', {method: 'POST', body: JSON.stringify(out)});
});
</script>"""


def run(cells, label, kill_channel=False):
    """Serve one iframe per cell output and read back what the viewer holds."""
    doc = DOC
    if kill_channel:
        # The mutation this check was verified with: no bridge, no frames.
        doc = ('<!doctype html><meta charset="utf-8"><script>'
               'window.BroadcastChannel=function(){throw new Error("no BC")};'
               '</script><body style="margin:0">%s')
    host = ('<!doctype html><meta charset="utf-8"><body style="margin:0">\n'
            + '\n'.join(f'<iframe src="/cell{i}.html" style="width:520px;'
                        f'height:420px;border:0"></iframe>' for i in range(len(cells)))
            + HOST_JS)

    box = []

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get('Content-Length', 0))
            box.append(json.loads(self.rfile.read(n)))
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'ok')

        def do_GET(self):
            if self.path == '/':
                body = host
            elif self.path.startswith('/cell'):
                body = doc % cells[int(self.path[5:].split('.')[0])]
            else:
                self.send_error(404)
                return
            b = body.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.request_queue_size = 128
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H)
    srv.daemon_threads = True
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    prof = f'/tmp/py2dmol-colab-{label}'
    shutil.rmtree(prof, ignore_errors=True)
    p = subprocess.Popen([CHROME, '--headless=new', f'--user-data-dir={prof}',
                          '--no-first-run', '--window-size=1200,1000',
                          f'http://127.0.0.1:{port}/'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + 40
    while not box and time.time() < end:
        time.sleep(0.3)
    p.kill()
    srv.shutdown()
    shutil.rmtree(prof, ignore_errors=True)
    return box[0] if box else {'err': 'no result posted'}


bad = []

# --- 1. the payload is self-contained ----------------------------------------
# A reopened notebook has whatever is in the .ipynb and nothing else. This is
# cheap and static, so it runs before any browser starts.
cells = build_cells(persistence=True)
viewer_html = cells[0]
ext = sorted(set(m.group(0) for m in
                 re.finditer(r'(?:src|href)\s*=\s*["\'](?:https?:)?//[^"\']*', viewer_html)))
if ext:
    bad.append('the notebook payload reaches the network, so a reopened'
               f' notebook offline is a broken one: {ext[:3]}')
net = sorted(set(re.findall(r'\bfetch\s*\(|XMLHttpRequest|importScripts', viewer_html)))
if net:
    bad.append(f'the notebook payload can fetch: {net}')
print(f'payload: {len(viewer_html) // 1024} KB, {len(cells) - 1} update cells,'
      f' no external reference' if not ext else 'payload: EXTERNAL REFS')

# --- 2. the three orders ------------------------------------------------------
# Colab decides which output iframe finishes first, and nothing about a notebook
# says the viewer wins. All three must land the same trajectory.
ORDERS = {
    # the viewer's own iframe first, which is the lucky case
    'viewer-first': lambda c: c,
    # ...and the case a reopen actually produces: a half-megabyte viewer still
    # parsing while three one-kilobyte update cells have already posted
    'viewer-last': lambda c: c[1:] + c[:1],
    # ...and the same with the replay itself out of order, which the seq
    # watermark discards unless the viewer sorts what it holds
    'viewer-last-reversed': lambda c: c[1:][::-1] + c[:1],
}
want_z = [0.0, 100.0, 200.0]
for label, order in ORDERS.items():
    R = run(order(cells), label)
    if R.get('err'):
        bad.append(f'{label}: page error {R["err"]}')
        continue
    print(f'{label}: {R["frames"]} frames, {R["ink"]} px of ink,'
          f' viewer in iframe {R["where"]}, {R.get("waited")} ms, z {R["zs"]}')
    if R['withApi'] != 1:
        bad.append(f'{label}: {R["withApi"]} iframes expose py2dmol_viewers -'
                   ' the cell outputs are not isolated, so this proves nothing'
                   ' about Colab')
    if R['frames'] != NADD:
        bad.append(f'{label}: {R["frames"]} of {NADD} frames arrived - a cell'
                   ' output posted into a channel nobody was listening on yet,'
                   ' and BroadcastChannel does not retain')
    if R['ink'] <= 0:
        bad.append(f'{label}: nothing was drawn')
    if R['zs'] != want_z:
        bad.append(f'{label}: frames are in the order {R["zs"]}, wanted'
                   f' {want_z} - seq is a watermark, so a replay that arrives'
                   ' out of order drops everything before its high mark')

# --- 3. and the mutation, so none of the above passes by accident -------------
R = run(ORDERS['viewer-first'](cells), 'nobc', kill_channel=True)
print(f'without BroadcastChannel: {R.get("frames")} frames,'
      f' {R.get("ink")} px of ink')
if R.get('frames') not in (0, None) or R.get('ink'):
    bad.append('the frames still arrive with BroadcastChannel removed, so the'
               ' checks above are measuring some other path and would not'
               ' notice the channel breaking')

# --- 4. metadata set AFTER the frames it describes ----------------------------
# Everything above is frames. These are the calls a reader makes next, on a
# viewer that is already up, and each one travels as CHANGED METADATA rather
# than as a frame - which is a second path, with its own applier, and it had
# already drifted from the first.
def build_metadata_cells():
    del CELLS[:]
    v = py2Dmol.view(persistence=True)
    v.show()
    for k in range(NADD):
        t = np.linspace(0, 4 * np.pi, 30)
        v.add(np.stack([np.cos(t) * 5, np.sin(t) * 5, t * 1.5 + 100 * k], axis=1),
              align=False, name='m')
    v.set_color('red', name='m', position=3)      # object level
    v.set_color('blue', name='m', frame=1)        # a frame that is ALREADY SENT
    v.add_contacts([['A', 5, 'A', 20, 1.0]], name='m')
    for i in range(4, 12):
        v.set_sse('H', name='m', position=i)
    return [c['html'] for c in CELLS]


R = run(build_metadata_cells(), 'metadata')
m = R.get('meta') or {}
print(f"metadata after the frames: color={m.get('color')},"
      f" {m.get('contacts')} contacts, {m.get('sse')} sse,"
      f" frame colours {m.get('frameColors')}")
if R.get('err'):
    bad.append(f'metadata: page error {R["err"]}')
if not m.get('color'):
    bad.append('set_color on a live viewer did not reach it')
if m.get('contacts') != 1:
    bad.append(f'add_contacts on a live viewer delivered {m.get("contacts")}')
if m.get('sse') != 8:
    bad.append(f'set_sse on a live viewer delivered {m.get("sse")} of 8 - the'
               ' incremental path had its own copy of the metadata applier and'
               ' that copy never learnt about sse')
if (m.get('frameColors') or [None]) != [None, 'blue', None]:
    bad.append(f'set_color(frame=1) delivered {m.get("frameColors")} - a frame'
               ' is sent once and once only, so a colour set on a frame the'
               ' viewer already has has to travel as metadata or not at all')

# --- 5. and taking it all off again -------------------------------------------
# SETTING AND UNSETTING ARE NOT THE SAME PATH. Python packs only the fields that
# are not None, so a field that goes away stopped appearing rather than
# appearing as a removal - it was never unequal to anything and never travelled.
# Two objects in one run: one has everything set and then everything cleared,
# the other keeps what it was not asked to lose.
def build_clearing_cells():
    del CELLS[:]
    v = py2Dmol.view(persistence=True)
    v.show()
    t = np.linspace(0, 4 * np.pi, 30)
    ch = ['A'] * 15 + ['B'] * 15

    v.add(np.stack([np.cos(t) * 5, np.sin(t) * 5, t * 1.5], axis=1),
          align=False, name='whole', chains=ch)
    v.set_color('red', name='whole')
    v.add_contacts([['A', 5, 'A', 20, 1.0]], name='whole')
    v.add_bonds([[0, 1], [1, 2]], name='whole')
    for i in range(4, 12):
        v.set_sse('H', name='whole', position=i)
    v.set_color(None, name='whole')       # every one of them back off
    v.add_contacts([], name='whole')
    v.add_bonds([], name='whole')
    for i in range(4, 12):
        v.set_sse(None, name='whole', position=i)

    for k in range(2):
        v.add(np.stack([np.cos(t) * 5, np.sin(t) * 5, t * 1.5 + 100 * k], axis=1),
              align=False, name='part', chains=ch)
    v.set_color('red', name='part', chain='A')
    v.set_color('blue', name='part', chain='B')
    v.set_color('green', name='part', position=[1, 2, 3])
    v.set_color('teal', name='part', frame=1)
    v.set_color(None, name='part', chain='A')       # one chain of two
    v.set_color(None, name='part', position=[2])    # one position of three
    v.set_color(None, name='part', frame=1)         # and the frame's own
    return [c['html'] for c in CELLS]


R = run(build_clearing_cells(), 'clearing')
w = (R.get('objs') or {}).get('whole') or {}
q = (R.get('objs') or {}).get('part') or {}
print(f"cleared: whole={w.get('color')}/{w.get('contacts')}c/{w.get('bonds')}b/"
      f"{w.get('sse')}sse  part={w and q.get('color')} frames={q.get('frameColors')}")
if R.get('err'):
    bad.append(f'clearing: page error {R["err"]}')
for field, got in (('color', w.get('color')), ('contacts', w.get('contacts')),
                   ('bonds', w.get('bonds')), ('sse', w.get('sse'))):
    if got:
        bad.append(f'clearing {field} left {got!r} on the viewer - a field that'
                   ' goes away has to travel as an explicit removal, or it is'
                   ' simply absent from the update and never taken off')
want = {'chain': {'B': 'blue'}, 'position': {'1': 'green', '3': 'green'}}
if q.get('color') != want:
    bad.append(f'clearing one chain and one position left {q.get("color")},'
               f' wanted {want} - a selective clear must not take the rest')
if (q.get('frameColors') or [1]) != [None, None]:
    bad.append(f'clearing a frame colour left {q.get("frameColors")}')

# --- 6. persistence=False is a single slot, and says so -----------------------
# Not a fault - the mode is documented as ephemeral - but it is the difference
# between a notebook that reopens with its trajectory and one that reopens with
# the last frame, and nothing else in the suite states it.
eph = build_cells(persistence=False)
R = run(eph, 'ephemeral')
print(f'persistence=False: {len(eph) - 1} update cell,'
      f' {R.get("frames")} frame(s) on reopen')
if len(eph) - 1 != 1:
    bad.append(f'persistence=False emitted {len(eph) - 1} update cells - it is'
               ' a single overwritten mailbox and should emit exactly one')
if R.get('frames') != 1:
    bad.append(f'persistence=False replayed {R.get("frames")} frames from one'
               ' mailbox slot holding one delta')

for b in bad:
    print('FAIL: ' + b)
print('colab: ok' if not bad else f'{len(bad)} problems')
sys.exit(1 if bad else 0)
